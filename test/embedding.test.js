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
    const Database = require("better-sqlite3");
    const db = new Database(path.join(vault, "derived", "lifecycle.db"));
    assert.strictEqual(db.prepare("SELECT count(*) n FROM embeddings").get().n, 23);
    db.close();
    console.log("embedding semantic ranking, schema and incremental writes passed");
  } finally {
    if (mem?._fts5DbInst) mem._fts5DbInst.close();
    child.kill();
    fs.rmSync(vault, { recursive: true, force: true });
  }
})().catch(error => { child.kill(); console.error(error); process.exit(1); });
