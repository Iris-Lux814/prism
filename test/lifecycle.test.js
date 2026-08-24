"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "prism-lifecycle-test-"));
const sourceDir = path.join(vault, "source", "conversations");
const episodeDir = path.join(vault, "derived", "episodes");
fs.mkdirSync(sourceDir, { recursive: true });
fs.mkdirSync(episodeDir, { recursive: true });

const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const source = [
  { id: "ep_hot", thread_id: "t", sequence: 1, timestamp: ago(1), role: "user", content: "recent" },
  { id: "ep_warm", thread_id: "t", sequence: 2, timestamp: ago(4), role: "user", content: "four days" },
  { id: "ep_cold", thread_id: "t", sequence: 3, timestamp: ago(6), role: "user", content: "six days" },
  { id: "ep_archive", thread_id: "t", sequence: 4, timestamp: ago(11), role: "user", content: "eleven days" },
  { id: "ep_pinned", thread_id: "t", sequence: 5, timestamp: ago(20), role: "user", content: "pinned" },
];
const sourceFile = path.join(sourceDir, "thread-t.jsonl");
const sourceText = source.map(item => JSON.stringify(item)).join("\n") + "\n";
fs.writeFileSync(sourceFile, sourceText, "utf8");
fs.writeFileSync(path.join(sourceDir, "thread-other.jsonl"), JSON.stringify({
  id: "foreign_ep", thread_id: "other", sequence: 1, timestamp: ago(1), role: "user", content: "foreign thread",
}) + "\n", "utf8");

for (const item of source) {
  fs.writeFileSync(path.join(episodeDir, `${item.id}.json`), JSON.stringify({
    at: item.timestamp,
    thread_id: "t",
    source_range: { start: item.sequence, end: item.sequence },
    episodes: [{ summary: item.content, source_ids: item.id === "ep_hot" ? [item.id, "foreign_ep"] : [item.id] }],
    tier: "hot",
    pinned: item.id === "ep_pinned",
  }), "utf8");
}

try {
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "lifecycle-maintenance.js")], {
    env: { ...process.env, PRISM_VAULT: vault, PRISM_WARM_AFTER_DAYS: "3", PRISM_COLD_AFTER_DAYS: "5", PRISM_ARCHIVE_AFTER_DAYS: "10" }, encoding: "utf8", windowsHide: true,
  });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const tier = id => JSON.parse(fs.readFileSync(path.join(episodeDir, `${id}.json`), "utf8")).tier;
  assert.strictEqual(tier("ep_hot"), "hot");
  assert.strictEqual(tier("ep_warm"), "warm");
  assert.strictEqual(tier("ep_cold"), "cold");
  assert.strictEqual(tier("ep_archive"), "archive");
  assert.strictEqual(tier("ep_pinned"), "hot");
  const normalizedHot = JSON.parse(fs.readFileSync(path.join(episodeDir, "ep_hot.json"), "utf8"));
  assert.deepStrictEqual(normalizedHot.episodes[0].source_ids, ["ep_hot"], "cross-thread source refs must be removed");
  assert.deepStrictEqual(normalizedHot.source_episode_ids, ["ep_hot"]);
  assert.strictEqual(fs.readFileSync(sourceFile, "utf8"), sourceText, "maintenance must not modify source evidence");

  try {
    const Database = require("better-sqlite3");
    const db = new Database(path.join(vault, "derived", "lifecycle.db"), { readonly: true });
    assert.deepStrictEqual(db.prepare("SELECT seq,tier FROM episode_tier WHERE thread_id='t' ORDER BY seq").all(), [
      { seq: 1, tier: "hot" }, { seq: 2, tier: "warm" }, { seq: 3, tier: "cold" },
      { seq: 4, tier: "archive" }, { seq: 5, tier: "hot" },
    ]);
    db.close();
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  console.log("lifecycle cooling, pinned protection and source immutability passed");
} finally {
  try { fs.rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (error.code !== "EPERM") throw error; }
}
