#!/usr/bin/env node
/**
 * 零 token 定期维护任务
 * 逻辑：
 *   1. 遍历所有 derived/episodes/ 和 derived/facts/ JSON
 *   2. pinned=true → 跳过，不做任何修改
 *   3. 超过 expires_at → tier = "cold"，生成 event_shadow（如无）
 *   4. 默认未召回 7/30/90 天 → warm/cold/archive（阈值可配置）
 *   5. superseded_by 有值 → tier 最高降为 "cold"
 *   6. 同步 source 检索层级与召回活动，不修改 source 原文
 *   7. 写回 JSON；不调用任何外部 API
 *   8. 输出维护报告（供 Dashboard 展示）
 */

const fs = require("fs");
const path = require("path");

const VAULT = process.env.PRISM_VAULT || process.env.TELEGRAM_MEMORY_VAULT || process.env.VAULT_PATH || "./memory-vault";
const DIRS = [
  path.join(VAULT, "derived", "episodes"),
  path.join(VAULT, "derived", "facts"),
  path.join(VAULT, "derived", "perspectives"),
];
const WARM_AFTER_DAYS = Math.max(0, Number(process.env.PRISM_WARM_AFTER_DAYS || 7));
const COLD_AFTER_DAYS = Math.max(WARM_AFTER_DAYS, Number(process.env.PRISM_COLD_AFTER_DAYS || 30));
const ARCHIVE_AFTER_DAYS = Math.max(COLD_AFTER_DAYS, Number(process.env.PRISM_ARCHIVE_AFTER_DAYS || 90));
const TIER_RANK = { hot: 3, warm: 2, cold: 1, archive: 0 };
const now = new Date();

function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, output); else output.push(full);
  }
  return output;
}

const VALID_SOURCE_IDS = new Set();
const SOURCE_BY_ID = new Map();
const SOURCE_TIMESTAMPS = new Map();
const SOURCE_EPISODES = [];
for (const file of walkFiles(path.join(VAULT, "source", "conversations")).filter(f => f.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
    try { const item = JSON.parse(line); if (item.id) { VALID_SOURCE_IDS.add(item.id); SOURCE_BY_ID.set(item.id, item); SOURCE_TIMESTAMPS.set(item.id, item.timestamp || null); SOURCE_EPISODES.push(item); } } catch {}
  }
}

function nowIso() { return now.toISOString(); }

function daysDiff(isoStr) {
  if (!isoStr) return Infinity;
  return (now - new Date(isoStr)) / (1000 * 60 * 60 * 24);
}

function makeEventShadow(data, filePath) {
  // 从 episodes[0] 或 facts[0] 取第一句摘要，截为 ≤30字
  const date = (data.at || "").slice(0, 10);
  const items = data.episodes || data.facts || [];
  const first = items[0];
  let desc = "";
  if (first) {
    desc = (first.content || first.summary || first.description || "").replace(/\s+/g, " ").trim();
    if (!desc && typeof first === "string") desc = first;
  }
  if (!desc) desc = path.basename(filePath, ".json");
  // 截 30 字
  if (desc.length > 30) desc = desc.slice(0, 29) + "…";
  return `${date} ${desc}`;
}

function walkJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json") && !f.endsWith(".bak.json"))
    .map(f => path.join(dir, f));
}

const report = {
  at: nowIso(),
  processed: 0,
  lifecycle_fields_initialized: 0,
  invalid_source_refs_removed: 0,
  pinned_skipped: 0,
  expired_to_cold: 0,
  superseded_to_cold: 0,
  auto_to_warm: 0,
  auto_to_cold: 0,
  auto_to_archive: 0,
  source_to_warm: 0,
  source_to_cold: 0,
  source_to_archive: 0,
  suggestions: [],   // 人工审阅：建议升温或降温的记录
  errors: [],
};
const lifecycleAuditFile = path.join(VAULT, "ledger", "lifecycle-audit.jsonl");
function audit(record) {
  fs.mkdirSync(path.dirname(lifecycleAuditFile), { recursive: true });
  fs.appendFileSync(lifecycleAuditFile, JSON.stringify(record) + "\n", "utf8");
}

function sourceEpisodeIds(data) {
  const ids = new Set((Array.isArray(data.source_episode_ids) ? data.source_episode_ids : []).filter(id => isValidSourceRef(data, id)));
  for (const key of ["episodes", "facts", "perspectives"]) {
    for (const item of Array.isArray(data[key]) ? data[key] : []) {
      for (const id of Array.isArray(item?.source_ids) ? item.source_ids : []) if (isValidSourceRef(data, id)) ids.add(id);
    }
  }
  return [...ids];
}

function isValidSourceRef(data, id) {
  const source = SOURCE_BY_ID.get(id);
  return Boolean(source) && String(source.thread_id) === String(data.thread_id);
}

function normalizeSourceRefs(data) {
  let changed = false, removed = 0;
  for (const key of ["episodes", "facts", "perspectives"]) {
    for (const item of Array.isArray(data[key]) ? data[key] : []) {
      if (!Array.isArray(item?.source_ids)) continue;
      const next = [...new Set(item.source_ids.filter(id => isValidSourceRef(data, id)))];
      removed += item.source_ids.length - next.length;
      if (next.length !== item.source_ids.length) { item.source_ids = next; changed = true; }
    }
  }
  const previous = Array.isArray(data.source_episode_ids) ? data.source_episode_ids : [];
  const next = sourceEpisodeIds(data);
  removed += previous.filter(id => !isValidSourceRef(data, id)).length;
  if (JSON.stringify(previous) !== JSON.stringify(next)) { data.source_episode_ids = next; changed = true; }
  return { changed, removed };
}

function lastActivityAt(data) {
  if (data.last_recalled_at) return data.last_recalled_at;
  let latest = "";
  for (const id of Array.isArray(data.source_episode_ids) ? data.source_episode_ids : []) {
    const timestamp = SOURCE_TIMESTAMPS.get(id);
    if (timestamp && timestamp > latest) latest = timestamp;
  }
  return latest || data.at;
}

function initializeLifecycle(data) {
  const defaults = {
    importance: 0.5, pinned: false, tier: "hot", last_recalled_at: null,
    recall_count: 0, expires_at: null, valid_to: null, superseded_by: null,
    source_episode_ids: sourceEpisodeIds(data), event_shadow: null,
  };
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(data, key)) { data[key] = value; changed = true; }
  }
  return changed;
}

for (const dir of DIRS) {
  for (const file of walkJson(dir)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      report.processed++;
      let changed = initializeLifecycle(data);
      if (changed) report.lifecycle_fields_initialized++;
      const refs = normalizeSourceRefs(data);
      changed = changed || refs.changed;
      report.invalid_source_refs_removed += refs.removed;

      // pinned → 跳过
      if (data.pinned) {
        report.pinned_skipped++;
        if (changed) {
          data.lifecycle_maintained_at = nowIso();
          fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
        }
        continue;
      }

      // superseded_by 有值 → 最高降为 cold
      if (data.superseded_by && data.tier && data.tier !== "cold" && data.tier !== "archive") {
        data.tier = "cold";
        if (!data.event_shadow) data.event_shadow = makeEventShadow(data, file);
        changed = true;
        report.superseded_to_cold++;
      }

      // expires_at 到期 → cold
      if (data.expires_at && new Date(data.expires_at) <= now) {
        if (data.tier !== "cold" && data.tier !== "archive") {
          data.tier = "cold";
          if (!data.event_shadow) data.event_shadow = makeEventShadow(data, file);
          changed = true;
          report.expired_to_cold++;
        }
      }

      // Cool cumulatively from the latest successful recall (or creation time).
      const inactiveDays = daysDiff(lastActivityAt(data));
      const targetTier = inactiveDays > ARCHIVE_AFTER_DAYS ? "archive"
        : inactiveDays > COLD_AFTER_DAYS ? "cold"
        : inactiveDays > WARM_AFTER_DAYS ? "warm" : "hot";
      const currentTier = data.tier || "hot";
      if (TIER_RANK[targetTier] < TIER_RANK[currentTier]) {
        data.tier = targetTier;
        if ((targetTier === "cold" || targetTier === "archive") && !data.event_shadow) data.event_shadow = makeEventShadow(data, file);
        changed = true;
        if (targetTier === "warm") report.auto_to_warm++;
        else if (targetTier === "cold") report.auto_to_cold++;
        else report.auto_to_archive++;
        audit({ at: nowIso(), action: "auto_cool", actor: "prism", file: path.relative(VAULT, file), old_tier: currentTier, new_tier: targetTier, inactive_days: Math.floor(inactiveDays) });
      }

      // Recall frequency may still produce a manual importance suggestion.
      const daysSince = daysDiff(lastActivityAt(data));
      if (daysSince > ARCHIVE_AFTER_DAYS && (data.importance || 0) < 0.3 && data.tier !== "archive") {
        report.suggestions.push({
          file: path.relative(VAULT, file),
          reason: `${Math.round(daysSince)}天未召回，importance=${data.importance}，建议降为 warm 或 cold`,
          current_tier: data.tier,
        });
      }

      // recall_count 高 → 建议升温（不自动改 importance）
      if ((data.recall_count || 0) >= 5 && (data.importance || 0) < 0.6 && data.tier !== "hot") {
        report.suggestions.push({
          file: path.relative(VAULT, file),
          reason: `recall_count=${data.recall_count}，建议人工提升 importance 或升温为 warm/hot`,
          current_tier: data.tier,
        });
      }

      if (changed) {
        data.lifecycle_maintained_at = nowIso();
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
      }
    } catch (e) {
      report.errors.push({ file: path.relative(VAULT, file), error: e.message });
    }
  }
}

// Keep the runtime search tier table consistent with the derived JSON files.
try {
  const { LocalMemoryService } = require("./local-memory-service");
  const memory = new LocalMemoryService({ vaultPath: VAULT, logger: null });
  const db = memory._fts5Db();
  memory._fts5EnsureSchema(db);
  const ensureTier = db.prepare("INSERT OR IGNORE INTO episode_tier(thread_id,seq,tier) VALUES (?,?,'hot')");
  db.transaction(() => { for (const episode of SOURCE_EPISODES) ensureTier.run(String(episode.thread_id), Number(episode.sequence)); })();
  const originalTiers = new Map(db.prepare("SELECT thread_id,seq,tier FROM episode_tier").all().map(row => [`${row.thread_id}:${row.seq}`, row.tier]));
  report.tier_rows_synced = memory.syncAllFts5Tiers();
  const activity = new Map(db.prepare("SELECT thread_id,seq,last_recalled_at FROM episode_activity").all().map(row => [`${row.thread_id}:${row.seq}`, row.last_recalled_at]));
  const protectedSeqs = new Set();
  for (const sub of ["episodes", "facts"]) {
    for (const file of walkJson(path.join(VAULT, "derived", sub))) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!data.pinned) continue;
        for (let seq = Number(data.source_range?.start || 0); seq <= Number(data.source_range?.end || -1); seq++) protectedSeqs.add(`${data.thread_id}:${seq}`);
      } catch {}
    }
  }
  const currentTier = db.prepare("SELECT tier FROM episode_tier WHERE thread_id=? AND seq=?");
  const updateTier = db.prepare(`INSERT INTO episode_tier(thread_id,seq,tier) VALUES (?,?,?)
    ON CONFLICT(thread_id,seq) DO UPDATE SET tier=excluded.tier`);
  db.transaction(() => {
    for (const episode of SOURCE_EPISODES) {
      const key = `${episode.thread_id}:${episode.sequence}`;
      if (protectedSeqs.has(key)) continue;
      const inactiveDays = daysDiff(activity.get(key) || episode.timestamp);
      const target = inactiveDays > ARCHIVE_AFTER_DAYS ? "archive" : inactiveDays > COLD_AFTER_DAYS ? "cold" : inactiveDays > WARM_AFTER_DAYS ? "warm" : "hot";
      const old = currentTier.get(String(episode.thread_id), Number(episode.sequence))?.tier || "hot";
      if (TIER_RANK[target] < TIER_RANK[old]) {
        updateTier.run(String(episode.thread_id), Number(episode.sequence), target);
        const original = originalTiers.get(key) || "hot";
        if (original !== target) {
          if (target === "warm") report.source_to_warm++; else if (target === "cold") report.source_to_cold++; else report.source_to_archive++;
          audit({ at: nowIso(), action: "auto_cool_source", actor: "prism", thread_id: String(episode.thread_id), seq: Number(episode.sequence), old_tier: original, new_tier: target, inactive_days: Math.floor(inactiveDays) });
        }
      }
    }
  })();
  if (memory._fts5DbInst) memory._fts5DbInst.close();
} catch (e) {
  if (/better-sqlite3/i.test(String(e.message))) report.tier_sync_skipped = "better-sqlite3 is not installed";
  else report.errors.push({ file: "derived/lifecycle.db", error: `tier sync failed: ${e.message}` });
}

// 写报告
const reportFile = path.join(VAULT, "ledger", "lifecycle-maintenance.json");
try {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
} catch {}

console.log("=== lifecycle-maintenance 完成 ===");
console.log(`processed: ${report.processed}  pinned_skipped: ${report.pinned_skipped}`);
console.log(`lifecycle_fields_initialized: ${report.lifecycle_fields_initialized}  tier_rows_synced: ${report.tier_rows_synced || 0}`);
console.log(`invalid_source_refs_removed: ${report.invalid_source_refs_removed}`);
console.log(`expired_to_cold: ${report.expired_to_cold}  superseded_to_cold: ${report.superseded_to_cold}`);
console.log(`auto_to_warm: ${report.auto_to_warm}  auto_to_cold: ${report.auto_to_cold}  auto_to_archive: ${report.auto_to_archive}`);
console.log(`source_to_warm: ${report.source_to_warm}  source_to_cold: ${report.source_to_cold}  source_to_archive: ${report.source_to_archive}`);
if (report.suggestions.length) {
  console.log(`\n建议（需人工审阅，不自动执行）：`);
  for (const s of report.suggestions) console.log(`  [${s.current_tier}] ${s.file}\n    → ${s.reason}`);
}
if (report.errors.length) {
  console.log(`\nERRORS:`);
  for (const e of report.errors) console.log(`  ${e.file}: ${e.error}`);
  process.exit(1);
}
