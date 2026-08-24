"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LocalMemoryService } = require("../src/local-memory-service");

const port = 19000 + Math.floor(Math.random() * 1000);
// Hosts may load Prism before dotenv. Configuration must be read when an
// embedding is requested, not frozen at module import time.
process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
process.env.OLLAMA_EMBED_TIMEOUT_MS = "2000";
const serverCode = `
  const http = require("http");
  http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const input = String(JSON.parse(body || "{}").input || "");
      const v = /cat|kitty/i.test(input) ? [1,0,0] : /beach|sand/i.test(input) ? [0,1,0] : [0,0,1];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ embeddings: [v] }));
    });
  }).listen(${port}, "127.0.0.1");
`;
const child = spawn(process.execPath, ["-e", serverCode], { windowsHide: true, stdio: "ignore" });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "prism-embedding-test-"));
  let mem;
  try {
    await wait(300);
    mem = new LocalMemoryService({ vaultPath: vault, logger: { log() {}, error() {} } });
    const cat = mem.appendEpisode({ threadId: "t", role: "assistant", text: "Kitty ate fish today" });
    mem.appendEpisode({ threadId: "t", role: "assistant", text: "We walked on the beach" });
    const results = mem.searchEpisodes("t", "How is the cat?", 1, { beforeSeq: 999 });
    assert.strictEqual(results[0]?.sequence, cat.sequence);
    for (let i = 0; i < 21; i++) {
      mem.appendEpisode({ threadId: "t", role: "user", text: `unrelated filler ${i}` });
    }
    const packet = mem.buildContinuityPacket("t", 2000, { userText: "How is kitty doing?" });
    assert.match(packet, /SEMANTIC RECALL/);
    assert.match(packet, /Kitty ate fish today/);
    const earlierGame = mem.appendEpisode({ threadId: "temporal", role: "user", text: "上周我们一起玩过桌游。" });
    const latestGame = mem.appendEpisode({ threadId: "temporal", role: "assistant", text: "昨天最后一次一起玩桌游，晚上八点结束。" });
    for (let i = 0; i < 21; i++) mem.appendEpisode({ threadId: "temporal", role: "user", text: `无关近况 ${i}` });
    const temporal = mem.searchEpisodes("temporal", "我们最后一次玩桌游是什么时候？", 1, { includeArchive: true });
    assert.strictEqual(temporal[0]?.sequence, latestGame.sequence);
    assert.notStrictEqual(temporal[0]?.sequence, earlierGame.sequence);
    const temporalPacket = mem.buildContinuityPacket("temporal", 2000, { userText: "我们最后一次玩桌游是什么时候？" });
    assert.match(temporalPacket, /昨天最后一次一起玩桌游/);
    const Database = require("better-sqlite3");
    const derivedDir = path.join(vault, "derived", "episodes");
    fs.writeFileSync(path.join(derivedDir, "thread-t-seq-2.json"), JSON.stringify({
      thread_id: "t", source_range: { start: 1, end: 2 }, tier: "cold", episodes: [],
    }));
    assert.strictEqual(mem.syncAllFts5Tiers(), 2);
    const db = new Database(path.join(vault, "derived", "lifecycle.db"));
    assert.strictEqual(db.prepare("SELECT count(*) n FROM embeddings").get().n, 46);
    assert.deepStrictEqual(db.prepare("SELECT seq,tier FROM episode_tier WHERE thread_id='t' AND seq <= 3 ORDER BY seq").all(), [
      { seq: 1, tier: "cold" }, { seq: 2, tier: "cold" }, { seq: 3, tier: "hot" },
    ]);
    const archivedFile = JSON.parse(fs.readFileSync(path.join(derivedDir, "thread-t-seq-2.json"), "utf8"));
    archivedFile.tier = "archive";
    fs.writeFileSync(path.join(derivedDir, "thread-t-seq-2.json"), JSON.stringify(archivedFile));
    mem.syncAllFts5Tiers();
    assert.notStrictEqual(mem.searchEpisodes("t", "How is the cat?", 1, { beforeSeq: 999 })[0]?.sequence, cat.sequence);
    assert.strictEqual(mem.searchEpisodes("t", "How is the cat?", 1, { beforeSeq: 999, includeArchive: true })[0]?.sequence, cat.sequence);
    assert.strictEqual(mem.recordRecall("t", [1]), 1);
    const reheated = JSON.parse(fs.readFileSync(path.join(derivedDir, "thread-t-seq-2.json"), "utf8"));
    assert.strictEqual(reheated.tier, "hot");
    assert.strictEqual(reheated.recall_count, 1);
    assert.ok(reheated.last_recalled_at);
    assert.deepStrictEqual(db.prepare("SELECT DISTINCT tier FROM episode_tier WHERE thread_id='t'").all(), [{ tier: "hot" }]);
    db.close();
    console.log("embedding semantic ranking, schema and incremental writes passed");
  } finally {
    if (mem?._fts5DbInst) mem._fts5DbInst.close();
    child.kill();
    try { fs.rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { if (error.code !== "EPERM") throw error; }
  }
})().catch(error => { child.kill(); console.error(error); process.exit(1); });
