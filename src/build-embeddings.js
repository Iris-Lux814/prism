#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const VAULT = process.env.TELEGRAM_MEMORY_VAULT || process.env.VAULT_PATH || "./memory-vault";
const DB_PATH = path.join(VAULT, "derived", "lifecycle.db");
const OLLAMA_URL = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function readEpisodes() {
  const result = [];
  for (const file of walk(path.join(VAULT, "source", "conversations")).filter(f => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      try {
        const ep = JSON.parse(line);
        if (ep.thread_id && ep.sequence > 0 && ep.content && !ep.deleted) result.push(ep);
      } catch {}
    }
  }
  return result;
}

async function embed(input) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  const vector = body.embeddings?.[0] || body.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error("Ollama returned no embedding");
  return Float32Array.from(vector);
}

async function main() {
  try {
    const version = await fetch(`${OLLAMA_URL}/api/version`);
    if (!version.ok) throw new Error(`HTTP ${version.status}`);
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${OLLAMA_URL}: ${e.message}`);
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
    thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
    model TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, norm REAL NOT NULL,
    content_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, seq)
  ); CREATE INDEX IF NOT EXISTS idx_embeddings_thread_seq ON embeddings(thread_id, seq);`);
  const existing = db.prepare("SELECT content_hash, model FROM embeddings WHERE thread_id=? AND seq=?");
  const upsert = db.prepare(`INSERT INTO embeddings
    (thread_id,seq,role,content,model,dimensions,vector,norm,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,seq) DO UPDATE SET
    role=excluded.role,content=excluded.content,model=excluded.model,dimensions=excluded.dimensions,
    vector=excluded.vector,norm=excluded.norm,content_hash=excluded.content_hash,created_at=excluded.created_at`);
  const all = readEpisodes();
  let written = 0, skipped = 0;
  console.log(`[embedding-build] ${all.length} source episodes; model=${MODEL}`);
  for (let i = 0; i < all.length; i++) {
    const ep = all[i], content = String(ep.content).trim();
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const old = existing.get(String(ep.thread_id), Number(ep.sequence));
    if (old?.content_hash === hash && old?.model === MODEL) { skipped++; continue; }
    const vector = await embed(content);
    let squares = 0; for (const x of vector) squares += x * x;
    upsert.run(String(ep.thread_id), Number(ep.sequence), ep.role || "", content, MODEL,
      vector.length, Buffer.from(vector.buffer), Math.sqrt(squares), hash, new Date().toISOString());
    written++;
    if (written % 25 === 0) console.log(`[embedding-build] ${i + 1}/${all.length} processed`);
  }
  db.close();
  console.log(`[embedding-build] done: ${written} written, ${skipped} unchanged -> ${DB_PATH}`);
}

main().catch(error => { console.error(`[embedding-build] ${error.message}`); process.exit(1); });
