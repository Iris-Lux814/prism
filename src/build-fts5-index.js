#!/usr/bin/env node
/**
 * 从 source JSONL + derived JSON 全量重建 FTS5 检索索引。
 * 可单独运行，也在索引损坏时由 memory-service 自动调用。
 *
 * SQLite 只做只读检索索引，source JSONL 是唯一事实来源。
 * 索引损坏时随时可重建；重建过程不修改任何 source 文件。
 */

"use strict";

const fs = require("fs");
const path = require("path");

let Database;
try { Database = require("better-sqlite3"); } catch {
  console.error("[fts5] better-sqlite3 not found, install it first");
  process.exit(1);
}

const VAULT = process.env.TELEGRAM_MEMORY_VAULT || process.env.VAULT_PATH || "./memory-vault";
const DB_PATH = path.join(VAULT, "derived", "lifecycle.db");

// ── 读 source JSONL ────────────────────────────────────────────────────────────

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, f.name);
    if (f.isDirectory()) result.push(...walkFiles(fp));
    else if (f.isFile()) result.push(fp);
  }
  return result;
}

function readSourceEpisodes() {
  const srcDir = path.join(VAULT, "source", "conversations");
  const files = walkFiles(srcDir).filter(f => f.endsWith(".jsonl")).sort();
  const episodes = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ep = JSON.parse(line);
        if (ep.id && ep.thread_id && ep.sequence > 0 && ep.content) {
          episodes.push(ep);
        }
      } catch {}
    }
  }
  return episodes;
}

// ── 读 derived JSON tier ──────────────────────────────────────────────────────

function readDerivedTiers() {
  // file → { thread_id, seq_end, tier }
  // 文件名：thread-{tid}-seq-{seq}.json
  const tierMap = new Map(); // "tid:seq" → tier
  for (const sub of ["episodes", "facts"]) {
    const dir = path.join(VAULT, "derived", sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".bak.json")) continue;
      const m = f.match(/thread-(.+)-seq-(\d+)\.json$/);
      if (!m) continue;
      const [, tid, seqStr] = m;
      const seqEnd = parseInt(seqStr, 10);
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const tier = d.tier || "hot";
        const seqStart = d.source_range?.start || 0;
        // 所有在 [seqStart, seqEnd] 范围内的 source episode 都用这个 tier
        for (let s = seqStart; s <= seqEnd; s++) {
          const key = `${tid}:${s}`;
          // 优先用更低温度的 tier（cold < warm < hot < archive）
          const existing = tierMap.get(key) || "hot";
          if (tierRank(tier) < tierRank(existing)) tierMap.set(key, tier);
          else if (!tierMap.has(key)) tierMap.set(key, tier);
        }
      } catch {}
    }
  }
  return tierMap;
}

const TIER_RANK = { hot: 3, warm: 2, cold: 1, archive: 0 };
function tierRank(t) { return TIER_RANK[t] ?? 2; }

// ── 建库 ──────────────────────────────────────────────────────────────────────

function setupDb(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
      thread_id UNINDEXED,
      seq       UNINDEXED,
      role      UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 1'
    );
    CREATE TABLE IF NOT EXISTS episode_tier (
      thread_id TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      tier      TEXT NOT NULL DEFAULT 'hot',
      PRIMARY KEY (thread_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_tier_tier ON episode_tier(thread_id, tier);
  `);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

function build() {
  console.log("[fts5-build] reading source episodes...");
  const episodes = readSourceEpisodes();
  console.log(`[fts5-build] ${episodes.length} episodes found`);

  console.log("[fts5-build] reading derived tiers...");
  const tierMap = readDerivedTiers();
  console.log(`[fts5-build] ${tierMap.size} tier mappings found`);

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Rebuild only keyword data; preserve semantic vectors stored in the same DB.
  db.exec("DROP TABLE IF EXISTS source_fts; DELETE FROM episode_tier;");
  setupDb(db);

  const insertFts = db.prepare("INSERT INTO source_fts(thread_id, seq, role, content) VALUES (?, ?, ?, ?)");
  const insertTier = db.prepare("INSERT OR REPLACE INTO episode_tier(thread_id, seq, tier) VALUES (?, ?, ?)");

  const insertAll = db.transaction(() => {
    for (const ep of episodes) {
      const tid = String(ep.thread_id);
      const seq = ep.sequence;
      const content = String(ep.content || "").trim();
      if (!content) continue;
      insertFts.run(tid, seq, ep.role || "", content);
      const tier = tierMap.get(`${tid}:${seq}`) || "hot";
      insertTier.run(tid, seq, tier);
    }
  });

  insertAll();
  db.close();

  console.log(`[fts5-build] done → ${DB_PATH}`);
  console.log(`[fts5-build] indexed ${episodes.length} episodes`);
}

build();
