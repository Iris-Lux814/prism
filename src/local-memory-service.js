// Prism — LocalMemoryService
// Source-first, append-only local memory vault for AI companions.
//
// Default actor names ("晶晶" / "沐沐") appear in the legacy-audit and governance
// subsystems. They are runtime labels, not credentials — replace them by passing
// your own actor strings to the relevant method calls (actor: "alice" / "bob").
//
// Requires: Node.js >= 18. Optional: better-sqlite3 (for FTS5 search acceleration).
"use strict";

// Local, source-first memory runtime. Uses only Node built-ins + DeepSeek API.
// `source/` is append-only evidence; `derived/` is safe to rebuild.

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");

// better-sqlite3 is optional: if missing/broken, FTS5 is disabled and bigram fallback is used.
let BetterSqlite3;
try { BetterSqlite3 = require("better-sqlite3"); } catch {}

// ─── FTS5 helpers (module-level, shared) ──────────────────────────────────────

const FTS5_TIER_RANK = { hot: 3, warm: 2, cold: 1, archive: 0 };

function fts5TierRank(t) { return FTS5_TIER_RANK[t] ?? 2; }

// Build a safe FTS5 MATCH query from raw user text.
// Returns null for empty/unsearchable input.
function buildFts5Query(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  // Extract words (space-split, len≥1) and Chinese bigrams
  const words = text.split(/\s+/).filter(k => k.length >= 1);
  const hanzi = text.match(/[一-鿿]/g) || [];
  const bigrams = hanzi.length >= 2
    ? hanzi.map((_, i) => hanzi.slice(i, i + 2).join("")).filter(s => s.length === 2)
    : hanzi;
  const tokens = [...new Set([...words, ...bigrams])].filter(k => k.length >= 1);
  if (!tokens.length) return null;
  // Strip FTS5 special chars, keep CJK and alphanumeric
  const safe = tokens
    .map(t => t.replace(/[^\w一-鿿぀-ヿ]/g, "").trim())
    .filter(Boolean);
  if (!safe.length) return null;
  return safe.join(" OR ");
}

// ─── DeepSeek ─────────────────────────────────────────────────────────────────

async function callDeepSeek(messages, { max_tokens = 900 } = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to run the memory compiler");
  }
  const body = JSON.stringify({
    model, messages, max_tokens,
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
  });
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    const req = https.request({
      hostname: "api.deepseek.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`DeepSeek JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("DeepSeek request timed out after 60s")));
    req.write(body);
    req.end();
  });
  if (raw.error) throw new Error(`DeepSeek API error: ${raw.error.message || JSON.stringify(raw.error)}`);
  const msg = raw.choices?.[0]?.message;
  const content = msg?.content;
  if (!content) throw new Error(`DeepSeek empty response: ${JSON.stringify(raw).slice(0, 200)}`);
  return content;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "default";
}

function nowIso() { return new Date().toISOString(); }

function ollamaConfig() {
  const configuredThreshold = Number(process.env.OLLAMA_EMBED_MIN_SIMILARITY);
  return {
    url: (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
    timeoutMs: Math.max(500, Number(process.env.OLLAMA_EMBED_TIMEOUT_MS) || 5000),
    minSimilarity: Math.max(0, Math.min(1,
      Number.isFinite(configuredThreshold) ? configuredThreshold : 0.72)),
  };
}

function embedWithOllamaSync(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  const config = ollamaConfig();
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const response = spawnSync(curl, [
    "--silent", "--show-error", "--fail",
    "--max-time", String(Math.ceil(config.timeoutMs / 1000)),
    "-H", "Content-Type: application/json", "--data-binary", "@-",
    `${config.url}/api/embed`,
  ], {
    input: JSON.stringify({ model: config.model, input }),
    encoding: "utf8", windowsHide: true,
    timeout: config.timeoutMs + 1000, maxBuffer: 16 * 1024 * 1024,
  });
  if (response.status !== 0) throw new Error(String(response.stderr || `curl exit ${response.status}`).trim());
  const payload = JSON.parse(response.stdout);
  const vector = payload.embeddings?.[0] || payload.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("Ollama returned no embedding");
  return Float32Array.from(vector);
}

function vectorNorm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function limit(text, max) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, output);
    else output.push(full);
  }
  return output;
}

function textList(items, prefix, perItem, maxItems) {
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => `${prefix}${limit(typeof item === "string" ? item : item.text, perItem)}`);
}

function parseCompilerJson(raw) {
  const text = String(raw || "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("compiler did not return a JSON object");
  const data = JSON.parse(text.slice(start, end + 1));
  if (!data || typeof data !== "object") throw new Error("compiler result is not an object");
  return data;
}

// ─── Trigger word detection ───────────────────────────────────────────────────

const RECALL_TRIGGERS = [
  /之前/, /那次/, /还记得/, /我们说过/, /你说过/, /你提到/, /上次/, /曾经/, /以前/,
  /remember/, /recall/, /last time/, /you said/, /we talked/,
];

function hasRecallTrigger(text) {
  return RECALL_TRIGGERS.some(re => re.test(String(text || "")));
}

// ─── Main class ───────────────────────────────────────────────────────────────

class LocalMemoryService {
  constructor({ vaultPath, logger = console } = {}) {
    this.root = vaultPath || path.join(process.cwd(), "memory-vault");
    this.logger = logger;
    this.ensureLayout();
  }

  ensureLayout() {
    for (const part of [
      "source/conversations",
      "derived/thread-state",
      "derived/episodes",
      "derived/facts",
      "derived/perspectives",
      "ledger",
      "exports",
    ]) {
      ensureDir(path.join(this.root, part));
    }
    const readme = path.join(this.root, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        "# Shared Memory Vault",
        "",
        "- `source/` is append-only source evidence.",
        "- `derived/` contains rebuildable continuity state and must never be treated as evidence.",
        "",
      ].join("\n"), "utf8");
    }
  }

  stateFile(threadId) {
    return path.join(this.root, "derived", "thread-state", `${safePart(threadId)}.json`);
  }

  sourceFile(threadId, date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    return path.join(this.root, "source", "conversations", String(yyyy), mm, `thread-${safePart(threadId)}.jsonl`);
  }

  getState(threadId) {
    const fallback = {
      schema: "shared-memory-thread-state.v1",
      thread_id: String(threadId),
      episode_counter: 0,
      last_compiled_counter: 0,
      thread_spine: "",
      episode_delta: "",
      memory_atoms: [],
      open_loops: [],
      friction_markers: [],
      compression_history: [],
      updated_at: null,
    };
    return readJson(this.stateFile(threadId), fallback);
  }

  saveState(threadId, state) { writeJson(this.stateFile(threadId), state); }

  listThreads() {
    const dir = path.join(this.root, "derived", "thread-state");
    return walkFiles(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson(file, null))
      .filter(Boolean)
      .map((state) => ({
        thread_id: state.thread_id,
        updated_at: state.updated_at,
        episode_counter: state.episode_counter || 0,
        thread_spine: state.thread_spine || "",
      }))
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  }

  getTimeline(threadId, limit = 160) {
    const marker = `thread-${safePart(threadId)}.jsonl`;
    const files = walkFiles(path.join(this.root, "source", "conversations"))
      .filter((file) => path.basename(file) === marker).sort();
    const records = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try { records.push(JSON.parse(line)); } catch {}
      }
    }
    return records
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .slice(-Math.max(1, Math.min(Number(limit) || 160, 10000)));
  }

  appendEpisode({ threadId, role, text, telegramMessageId = null, kind = "chat_message", timestamp = nowIso() }) {
    const state = this.getState(threadId);
    state.episode_counter += 1;
    const id = `ep_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const episode = {
      schema: "shared-memory-episode.v1",
      id,
      thread_id: String(threadId),
      sequence: state.episode_counter,
      timestamp,
      role,
      kind,
      source: {
        type: kind === "chat_message" ? "source_message" : kind,
        telegram_message_id: telegramMessageId,
      },
      content: String(text || ""),
    };
    appendJsonl(this.sourceFile(threadId, new Date(timestamp)), episode);
    state.last_episode_id = id;
    state.updated_at = nowIso();
    this.saveState(threadId, state);
    // Search indexes are best-effort and never block the append-only source write.
    try { this._fts5IndexEpisode(episode); } catch {}
    try { this._embeddingIndexEpisode(episode); } catch (e) {
      this.logger && this.logger.log(`[embedding] incremental index skipped: ${e.message}`);
    }
    return episode;
  }

  // ─── Compiler input builder (A) ─────────────────────────────────────────────

  // Read episodes in sequence range [start, end] from source JSONL
  readSourceRange(threadId, start, end) {
    const marker = `thread-${safePart(threadId)}.jsonl`;
    const files = walkFiles(path.join(this.root, "source", "conversations"))
      .filter((file) => path.basename(file) === marker).sort();
    const records = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ep = JSON.parse(line);
          if (ep.sequence >= start && ep.sequence <= end && !ep.deleted) {
            records.push({
              id: ep.id,
              sequence: ep.sequence,
              timestamp: ep.timestamp,
              role: ep.role,
              content: String(ep.content || ""),
            });
          }
        } catch {}
      }
    }
    return records.sort((a, b) => a.sequence - b.sequence);
  }

  // ─── DeepSeek compiler (A + D) ──────────────────────────────────────────────

  async runCompiler(threadId, throughCounter = null) {
    const state = this.getState(threadId);
    const start = (state.last_compiled_counter || 0) + 1;
    const end = throughCounter === null ? state.episode_counter : Math.min(throughCounter, state.episode_counter);
    if (start > end) {
      this.logger.log(`[compiler] nothing to compile thread=${threadId} start=${start} end=${end}`);
      return null;
    }

    const episodes = this.readSourceRange(threadId, start, end);
    if (!episodes.length) {
      this.logger.log(`[compiler] no source episodes in range ${start}-${end}`);
      return null;
    }

    const systemPrompt = [
      "你是私人关系对话的连续性编译器。根据原始对话细致保留事实、关系语气、情绪因果、当前话题、指代对象、双方刚刚说过什么以及尚未完成的事项；不能只留下抽象主题。",
      "你必须仅输出一个 JSON 对象，不要有任何 markdown、代码块或解释文字。",
      "memory_atoms 规则：最多10条。优先继承 prev_atoms 中仍然有效的日期、重大事件、约定、关系节点和持续状态，再补充本轮新事实；已经被当前对话纠正或结束的旧状态必须更新，不能复活。",
      "数量限制：episodes 最多5条，facts 最多10条，perspectives 最多6条；每个 source_ids 最多8个，只保留直接证据。必须单独保留最后正在进行的话题、最后一个问题/邀请、说话者真实意图以及代词具体指向。",
      "要求字段（均为中文内容）：",
      '{"thread_spine":"<=220字，细致描述当前关系、正在发生的事和最近对话落点","episode_delta":"<=180字，本段发生的变化及最后如何落下","memory_atoms":["<=100字，最多10条；保留具体人物、对象、日期、事件、约定与持续状态"],"open_loops":["<=100字，最多5条；包括最后尚待回应的问题、邀请、承诺和未完成操作"],"friction_markers":["<=100字，最多5条；记录误解、纠正、争议与不能确定的地方，无则省略"],"compression_note":"必填，2-4句中文：明确保留了哪些具体连续性、哪些细节未纳入及原因","episodes":[{"summary":"<=120字，按发生顺序概括一个具体事件，保留谁说了什么及结果","source_ids":["episode id列表"],"role_balance":"user_led|assistant_led|balanced"}],"facts":[{"content":"<=100字，可复用且有明确证据的具体事实","source_ids":["episode id列表"],"confidence":"high|medium|low"}],"perspectives":[{"content":"<=100字，某一方的具体观点、情绪、意图及其触发原因","holder":"user|assistant","source_ids":["episode id列表"]}]}',
    ].join("\n");

    const userPrompt = [
      `对话片段（sequence ${start} 到 ${end}，共 ${episodes.length} 条）：`,
      "",
      JSON.stringify(episodes, null, 2),
      "",
      state.thread_spine ? `上一次压缩的状态摘要：${state.thread_spine}` : "无历史压缩摘要。",
      (state.memory_atoms && state.memory_atoms.length > 0)
        ? `prev_atoms（上一轮保留的关键事实，包含日期/事件类的必须继承）：${state.memory_atoms.filter(Boolean).join("；")}`
        : "",
    ].filter(Boolean).join("\n");

    const receiptBase = {
      at: nowIso(),
      thread_id: String(threadId),
      source_range: { start, end },
      episode_count: episodes.length,
    };

    let raw;
    try {
      raw = await callDeepSeek([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ], { max_tokens: 3200 });
    } catch (e) {
      this.logger.error(`[compiler] DeepSeek call failed: ${e.message}`);
      appendJsonl(path.join(this.root, "ledger", "compiler-receipts.jsonl"), {
        ...receiptBase, result: "failed", error: e.message,
      });
      throw e;
    }

    return { raw, start, end, receiptBase };
  }

  // ─── Apply compiler result (F) ───────────────────────────────────────────────

  applyCompilerResult(threadId, compilerOutput, throughCounter = null) {
    if (!compilerOutput) throw new Error("applyCompilerResult: compilerOutput is null");
    const { raw, start, end, receiptBase } = typeof compilerOutput === "object" && compilerOutput.raw !== undefined
      ? compilerOutput
      : { raw: compilerOutput, start: null, end: null, receiptBase: { at: nowIso(), thread_id: String(threadId) } };

    let data;
    try {
      data = parseCompilerJson(raw);
    } catch (e) {
      this.logger.error(`[compiler] parse failed: ${e.message}`);
      appendJsonl(path.join(this.root, "ledger", "compiler-receipts.jsonl"), {
        ...receiptBase, result: "parse_failed", error: e.message,
      });
      // 失败不推进 last_compiled_counter（F 点核心要求）
      throw e;
    }

    const previous = this.getState(threadId);
    const sourceEnd = end !== null ? end : (throughCounter === null ? previous.episode_counter : Math.min(throughCounter, previous.episode_counter));

    // 写 derived/episodes（B 点）
    if (Array.isArray(data.episodes) && data.episodes.length > 0) {
      const epsFile = path.join(this.root, "derived", "episodes", `thread-${safePart(threadId)}-seq-${sourceEnd}.json`);
      writeJson(epsFile, {
        at: nowIso(), thread_id: String(threadId), source_range: { start: (start || (previous.last_compiled_counter + 1)), end: sourceEnd },
        episodes: data.episodes,
      });
    }

    // 写 derived/facts（B 点）
    if (Array.isArray(data.facts) && data.facts.length > 0) {
      const factsFile = path.join(this.root, "derived", "facts", `thread-${safePart(threadId)}-seq-${sourceEnd}.json`);
      writeJson(factsFile, {
        at: nowIso(), thread_id: String(threadId), source_range: { start: (start || (previous.last_compiled_counter + 1)), end: sourceEnd },
        facts: data.facts,
      });
    }

    // 写 derived/perspectives（B 点）
    if (Array.isArray(data.perspectives) && data.perspectives.length > 0) {
      const perspFile = path.join(this.root, "derived", "perspectives", `thread-${safePart(threadId)}-seq-${sourceEnd}.json`);
      writeJson(perspFile, {
        at: nowIso(), thread_id: String(threadId), source_range: { start: (start || (previous.last_compiled_counter + 1)), end: sourceEnd },
        perspectives: data.perspectives,
      });
    }

    const compressionNote = limit(data.compression_note || "（无说明）", 400);
    const prevHistory = Array.isArray(previous.compression_history) ? previous.compression_history : [];
    const compressionHistory = [...prevHistory, { at: nowIso(), note: compressionNote }].slice(-6);

    const state = {
      ...previous,
      thread_spine: limit(data.thread_spine, 440),
      episode_delta: limit(data.episode_delta, 360),
      memory_atoms: (Array.isArray(data.memory_atoms) ? data.memory_atoms : [])
        .map((item) => limit(item, 200)).filter(Boolean).slice(0, 10),
      open_loops: (Array.isArray(data.open_loops) ? data.open_loops : [])
        .map((item) => limit(item, 200)).filter(Boolean).slice(0, 5),
      friction_markers: (Array.isArray(data.friction_markers) ? data.friction_markers : [])
        .map((item) => limit(item, 200)).filter(Boolean).slice(0, 5),
      compression_history: compressionHistory,
      last_compiled_counter: Math.max(previous.last_compiled_counter, sourceEnd),
      updated_at: nowIso(),
      derived_from: { source_start: (start || previous.last_compiled_counter + 1), source_end: sourceEnd },
    };
    this.saveState(threadId, state);

    appendJsonl(path.join(this.root, "ledger", "compiler-receipts.jsonl"), {
      ...receiptBase,
      result: "applied",
      source_range: { start: state.derived_from.source_start, end: sourceEnd },
      spine_length: state.thread_spine.length,
    });

    // 成功后删掉 pending 文件
    try { fs.unlinkSync(this._pendingCompileFile(threadId)); } catch {}
    return state;
  }

  // ─── Continuity packet (C — 固定注入轻 Spine + 触发词召回) ──────────────────

  buildContinuityPacket(threadId, budget = 140, { userText = "" } = {}) {
    const state = this.getState(threadId);
    const maxChars = Math.max(160, Math.floor(Number(budget || 140) * 2.1));

    const lines = ["[CONTINUITY]"];
    // 固定注入 spine，没有则标注（C 点：新会话固定注入）
    if (state.thread_spine) {
      lines.push(`Now: ${limit(state.thread_spine, 80)}`);
    } else {
      lines.push("Now: （暂无压缩记录，这是第一次或刚恢复的对话）");
    }
    if (state.episode_delta) lines.push(`Change: ${limit(state.episode_delta, 55)}`);
    const atoms = textList(state.memory_atoms, "• ", 60, 4);
    if (atoms.length) lines.push(...atoms);
    const loops = textList(state.open_loops, "◦ ", 40, 2);
    if (loops.length) lines.push(...loops);
    const friction = (state.friction_markers || []).filter(Boolean);
    if (friction.length) lines.push(`! ${limit(friction[friction.length - 1], 35)}`);
    lines.push("不得补造未包含的细节。");

    const output = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxChars && output.length > 1) break;
      output.push(line);
      used += line.length + 1;
    }

    // 触发词检测：命中时注入 EVIDENCE BUNDLE（明确追忆模式）
    const explicitRecall = userText && (hasRecallTrigger(userText) || /(?:最后一次|上一次|上次|最近一次|什么时候|哪天|哪一次)/.test(String(userText)));
    if (explicitRecall) {
      const cards = this.searchEpisodes(threadId, userText, 2, { includeArchive: true });
      if (cards.length > 0) {
        const centerSeqs = cards.map(c => c.sequence);
        const bundle = this.buildEvidenceBundle(threadId, centerSeqs);
        if (bundle) {
          output.push(bundle);
          this.recordRecall(threadId, centerSeqs);
          this.logger.log(`[memory] RECALL evidence-bundle centerSeqs=${centerSeqs.join(",")}`);
        }
      } else {
        this.logger.log("[memory] RECALL trigger hit but no cards found");
      }
    }

    // High-confidence associative recall on every substantive turn.
    if (userText && !explicitRecall && String(userText).trim().length >= 4 && BetterSqlite3) {
      try {
        const state = this.getState(threadId);
        const rows = this._searchWithEmbeddings(
          threadId, userText, Math.max(0, (state.episode_counter || 0) - 20), 2
        );
        if (rows.length > 0) {
          const bundle = this.buildEvidenceBundle(threadId, rows.map(row => row.seq), {
            window: 1, maxChars: 500, maxEpisodes: 4,
          });
          if (bundle) {
            output.push("[SEMANTIC RECALL - relevant past evidence; use only when naturally related]");
            output.push(bundle);
            this.recordRecall(threadId, rows.map(row => row.seq));
            this.logger.log(`[memory] SEMANTIC-RECALL seqs=${rows.map(row => row.seq).join(",")} scores=${rows.map(row => row.similarity.toFixed(3)).join(",")}`);
          }
        }
      } catch (e) {
        this.logger && this.logger.log(`[memory] semantic recall skipped: ${e.message}`);
      }
    }

    // 已双签启用的 legacy 记忆
    const legacyBudget = Math.floor(maxChars * 0.25);
    try {
      const legacyItems = this.getEnabledLegacyItems();
      if (legacyItems.length > 0) {
        const legacyLines = ["[LEGACY MEMORY - 双签启用，无原文可核对，置信度：存疑]"];
        let lb = legacyLines[0].length + 1;
        for (const item of legacyItems) {
          const typeLabel = item.type === "episode" ? "事件" : item.type === "fact" ? "事实" : "视角";
          const line = `• [${typeLabel}][${limit(item.source_title, 20)}] ${limit(item.content, 100)}`;
          if (lb + line.length + 1 > legacyBudget) break;
          legacyLines.push(line);
          lb += line.length + 1;
        }
        if (legacyLines.length > 1) output.push(...legacyLines);
      }
    } catch (_) {}

    return output.join("\n");
  }

  // ─── Evidence bundle for explicit recall queries ──────────────────────────

  buildEvidenceBundle(threadId, centerSeqs, {
    window = 3, maxChars = 1200, maxEpisodes = 8,
  } = {}) {
    const WINDOW = Math.max(0, Math.min(Number(window) || 0, 5));
    const MAX_CHARS = Math.max(200, Math.min(Number(maxChars) || 1200, 2400));

    const timeline = this.getTimeline(threadId, 10000).filter(ep => !ep.deleted && ep.content);
    const seqToIdx = new Map(timeline.map((ep, i) => [ep.sequence, i]));

    const seqSet = new Set();
    for (const cs of centerSeqs) {
      const idx = seqToIdx.get(cs);
      if (idx == null) continue;
      for (let i = Math.max(0, idx - WINDOW); i <= Math.min(timeline.length - 1, idx + WINDOW); i++) {
        seqSet.add(timeline[i].sequence);
      }
    }

    const selected = timeline
      .filter(ep => seqSet.has(ep.sequence))
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, Math.max(1, Math.min(Number(maxEpisodes) || 8, 12)));

    if (selected.length === 0) return null;

    // 找对应 derived episode 文件（seq 范围覆盖命中区）
    const minSeq = selected[0].sequence;
    let derivedText = null;
    try {
      const epsDir = path.join(this.root, "derived", "episodes");
      const files = fs.readdirSync(epsDir)
        .map(f => { const m = f.match(new RegExp(`thread-${safePart(threadId)}-seq-(\\d+)\\.json$`)); return m ? { f, seq: Number(m[1]) } : null; })
        .filter(Boolean)
        .filter(e => e.seq >= minSeq)
        .sort((a, b) => a.seq - b.seq);
      if (files.length > 0) {
        const data = JSON.parse(fs.readFileSync(path.join(epsDir, files[0].f), "utf8"));
        if (Array.isArray(data.episodes) && data.episodes.length > 0) {
          derivedText = data.episodes.slice(0, 2).map(e => e.content || e.summary || "").filter(Boolean).join("；");
        }
      }
    } catch (_) {}

    const lines = [
      "[EVIDENCE BUNDLE]",
      "以下是原始对话片段。只依据这些证据回答；细节不确定说'不确定'，不得补造：",
    ];
    let used = lines.join("\n").length + 1;

    for (const ep of selected) {
      const role = ep.role === "user" ? "晶晶" : "沐";
      const line = `[seq:${ep.sequence}][${ep.timestamp.slice(0, 10)}][${role}] ${limit(ep.content, 150)}`;
      if (used + line.length + 1 > MAX_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }

    if (derivedText) {
      const dline = `[片段摘要] ${limit(derivedText, 120)}`;
      if (used + dline.length + 1 <= MAX_CHARS) lines.push(dline);
    }

    return lines.join("\n");
  }

  // ─── FTS5 检索（Hot→Warm→Cold；Archive 永不自动召回）─────────────────────────

  _fts5DbPath() { return path.join(this.root, "derived", "lifecycle.db"); }

  _fts5Db() {
    if (this._fts5Disabled) throw new Error("fts5 disabled");
    if (!BetterSqlite3) { this._fts5Disabled = true; throw new Error("better-sqlite3 not available"); }
    if (this._fts5DbInst) {
      // Quick integrity check (cached to avoid per-query overhead)
      return this._fts5DbInst;
    }
    try {
      const dbPath = this._fts5DbPath();
      // If DB missing, try to build it first
      if (!fs.existsSync(dbPath)) this._fts5Rebuild();
      const db = new BetterSqlite3(dbPath, { readonly: false, fileMustExist: false });
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      // Quick integrity check
      const check = db.pragma("integrity_check");
      if (!check || check[0]?.integrity_check !== "ok") {
        db.close();
        this.logger && this.logger.log("[fts5] integrity check failed, rebuilding...");
        this._fts5Rebuild();
        const db2 = new BetterSqlite3(dbPath, { readonly: false });
        db2.pragma("journal_mode = WAL");
        this._fts5DbInst = db2;
        return db2;
      }
      this._fts5DbInst = db;
      return db;
    } catch (e) {
      this._fts5Disabled = true;
      throw e;
    }
  }

  _fts5Rebuild() {
    // Inline rebuild: read source JSONL + derived JSON, write fresh DB.
    // No subprocess — avoids env/permission issues on Windows.
    this.logger && this.logger.log("[fts5] rebuilding index...");
    if (this._fts5DbInst) { try { this._fts5DbInst.close(); } catch {} this._fts5DbInst = null; }
    const dbPath = this._fts5DbPath();
    if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch {} }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Read source episodes
    const srcBase = path.join(this.root, "source", "conversations");
    const episodes = [];
    const walkSrc = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        if (f.isDirectory()) walkSrc(fp);
        else if (f.isFile() && fp.endsWith(".jsonl")) {
          for (const line of fs.readFileSync(fp, "utf8").split("\n").filter(Boolean)) {
            try {
              const ep = JSON.parse(line);
              if (ep.id && ep.thread_id && ep.sequence > 0 && ep.content)
                episodes.push(ep);
            } catch {}
          }
        }
      }
    };
    walkSrc(srcBase);

    // Read derived tiers
    const tierMap = new Map();
    for (const sub of ["episodes", "facts"]) {
      const dir = path.join(this.root, "derived", sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || f.endsWith(".bak.json")) continue;
        const m = f.match(/thread-(.+)-seq-(\d+)\.json$/);
        if (!m) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          const tier = d.tier || "hot";
          const seqEnd = parseInt(m[2], 10);
          const seqStart = d.source_range?.start || 0;
          for (let s = seqStart; s <= seqEnd; s++) {
            const key = `${m[1]}:${s}`;
            if (!tierMap.has(key)) tierMap.set(key, tier);
          }
        } catch {}
      }
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    this._fts5EnsureSchema(db);
    const insFts = db.prepare("INSERT INTO source_fts(thread_id, seq, role, content) VALUES (?, ?, ?, ?)");
    const insTier = db.prepare("INSERT OR REPLACE INTO episode_tier(thread_id, seq, tier) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (const ep of episodes) {
        const content = String(ep.content || "").trim();
        if (!content) continue;
        insFts.run(String(ep.thread_id), ep.sequence, ep.role || "", content);
        const tier = tierMap.get(`${ep.thread_id}:${ep.sequence}`) || "hot";
        insTier.run(String(ep.thread_id), ep.sequence, tier);
      }
    })();
    db.close();
    this.logger && this.logger.log(`[fts5] rebuilt: ${episodes.length} episodes`);
  }

  _fts5EnsureSchema(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
        thread_id UNINDEXED, seq UNINDEXED, role UNINDEXED, content,
        tokenize = 'unicode61 remove_diacritics 1'
      );
      CREATE TABLE IF NOT EXISTS episode_tier (
        thread_id TEXT NOT NULL, seq INTEGER NOT NULL, tier TEXT NOT NULL DEFAULT 'hot',
        PRIMARY KEY (thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_episode_tier_tier ON episode_tier(thread_id, tier);
      CREATE TABLE IF NOT EXISTS embeddings (
        thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL, norm REAL NOT NULL, content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_thread_seq ON embeddings(thread_id, seq);
      CREATE TABLE IF NOT EXISTS episode_activity (
        thread_id TEXT NOT NULL, seq INTEGER NOT NULL, last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, seq)
      );
    `);
  }

  _embeddingIndexEpisode(ep) {
    if (!BetterSqlite3) return;
    const content = String(ep.content || "").trim();
    if (!content || ep.deleted) return;
    const config = ollamaConfig();
    const vector = embedWithOllamaSync(content);
    const norm = vectorNorm(vector);
    if (!norm) throw new Error("Ollama returned a zero vector");
    const db = this._fts5Db();
    this._fts5EnsureSchema(db);
    db.prepare(`
      INSERT INTO embeddings(thread_id, seq, role, content, model, dimensions, vector, norm, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, seq) DO UPDATE SET role=excluded.role, content=excluded.content,
        model=excluded.model, dimensions=excluded.dimensions, vector=excluded.vector,
        norm=excluded.norm, content_hash=excluded.content_hash, created_at=excluded.created_at
    `).run(String(ep.thread_id), Number(ep.sequence), ep.role || "", content,
      config.model, vector.length, Buffer.from(vector.buffer), norm,
      crypto.createHash("sha256").update(content).digest("hex"), nowIso());
  }

  _searchWithEmbeddings(threadId, query, cutSeq, maxResults, { includeArchive = false } = {}) {
    const config = ollamaConfig();
    const queryVector = embedWithOllamaSync(query);
    const queryNorm = vectorNorm(queryVector);
    if (!queryNorm) return [];
    const db = this._fts5Db();
    this._fts5EnsureSchema(db);
    const rows = db.prepare(`
      SELECT e.seq, e.content, e.role, e.dimensions, e.vector, e.norm, et.tier
      FROM embeddings e JOIN episode_tier et
        ON et.thread_id = e.thread_id AND et.seq = e.seq
      WHERE e.thread_id = ? AND e.seq <= ? AND et.tier IN ('hot', 'warm', 'cold', 'archive')
    `).all(String(threadId), cutSeq);
    return rows.filter(row => (includeArchive || row.tier !== "archive") && row.dimensions === queryVector.length && row.norm > 0).map(row => {
      const stored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions);
      let dot = 0;
      for (let i = 0; i < queryVector.length; i++) dot += queryVector[i] * stored[i];
      return { ...row, similarity: dot / (queryNorm * row.norm) };
    }).filter(row => row.similarity >= config.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity ||
      fts5TierRank(b.tier) - fts5TierRank(a.tier) || b.seq - a.seq).slice(0, maxResults);
  }

  _fts5IndexEpisode(ep) {
    if (this._fts5Disabled || !BetterSqlite3) return;
    const content = String(ep.content || "").trim();
    if (!content) return;
    const db = this._fts5Db();
    this._fts5EnsureSchema(db);
    // Upsert: delete old entry first (FTS5 doesn't support upsert)
    db.prepare("DELETE FROM source_fts WHERE thread_id = ? AND seq = ?").run(String(ep.thread_id), ep.sequence);
    db.prepare("INSERT INTO source_fts(thread_id, seq, role, content) VALUES (?, ?, ?, ?)").run(
      String(ep.thread_id), ep.sequence, ep.role || "", content
    );
    db.prepare("INSERT OR REPLACE INTO episode_tier(thread_id, seq, tier) VALUES (?, ?, ?)").run(
      String(ep.thread_id), ep.sequence, "hot"
    );
  }

  // Called by Dashboard lifecycle set-tier after writing derived JSON
  syncFts5Tier(threadId, seq, tier) {
    if (this._fts5Disabled || !BetterSqlite3) return;
    try {
      const db = this._fts5Db();
      db.prepare("INSERT OR REPLACE INTO episode_tier(thread_id, seq, tier) VALUES (?, ?, ?)").run(
        String(threadId), Number(seq), String(tier)
      );
    } catch {}
  }

  // Recompute the effective source tier from all derived episode/fact ranges.
  // The coldest overlapping tier wins; uncompiled source remains hot.
  syncAllFts5Tiers({ preserveExisting = false } = {}) {
    if (this._fts5Disabled || !BetterSqlite3) return 0;
    const effective = new Map();
    for (const sub of ["episodes", "facts"]) {
      const dir = path.join(this.root, "derived", sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json") || name.endsWith(".bak.json")) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
          const threadId = String(data.thread_id || "");
          const start = Number(data.source_range?.start || 0);
          const end = Number(data.source_range?.end || 0);
          const tier = Object.hasOwn(FTS5_TIER_RANK, data.tier) ? data.tier : "hot";
          if (!threadId || start <= 0 || end < start) continue;
          for (let seq = start; seq <= end; seq++) {
            const key = `${threadId}:${seq}`, previous = effective.get(key);
            if (!previous || fts5TierRank(tier) < fts5TierRank(previous)) effective.set(key, tier);
          }
        } catch {}
      }
    }
    const db = this._fts5Db();
    this._fts5EnsureSchema(db);
    const reset = db.prepare("UPDATE episode_tier SET tier = 'hot'");
    const current = db.prepare("SELECT tier FROM episode_tier WHERE thread_id = ? AND seq = ?");
    const update = db.prepare(`INSERT INTO episode_tier(thread_id,seq,tier) VALUES (?,?,?)
      ON CONFLICT(thread_id,seq) DO UPDATE SET tier=excluded.tier`);
    db.transaction(() => {
      if (!preserveExisting) reset.run();
      for (const [key, tier] of effective) {
        const split = key.lastIndexOf(":");
        const threadId = key.slice(0, split), seq = Number(key.slice(split + 1));
        const existing = preserveExisting ? current.get(threadId, seq)?.tier : null;
        update.run(threadId, seq, existing && fts5TierRank(existing) < fts5TierRank(tier) ? existing : tier);
      }
    })();
    return effective.size;
  }

  // Successful evidence recall reheats covering derived memories and restarts
  // their cooling clock. The append-only source evidence is never modified.
  recordRecall(threadId, sequences) {
    const wanted = new Set((Array.isArray(sequences) ? sequences : [sequences]).map(Number).filter(Number.isFinite));
    if (!wanted.size) return 0;
    const heated = new Set(wanted);
    const at = nowIso(), auditFile = path.join(this.root, "ledger", "lifecycle-audit.jsonl");
    let updated = 0, tierChanged = false;
    for (const sub of ["episodes", "facts", "perspectives"]) {
      const dir = path.join(this.root, "derived", sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json") || name.endsWith(".bak.json")) continue;
        const file = path.join(dir, name);
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf8"));
          if (String(data.thread_id) !== String(threadId) || data.pinned) continue;
          const start = Number(data.source_range?.start || 0), end = Number(data.source_range?.end || 0);
          if (![...wanted].some(seq => seq >= start && seq <= end)) continue;
          for (let seq = start; seq <= end; seq++) heated.add(seq);
          const oldTier = data.tier || "hot";
          data.last_recalled_at = at;
          data.recall_count = Math.max(0, Number(data.recall_count) || 0) + 1;
          data.tier = "hot";
          data.lifecycle_maintained_at = at;
          fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
          appendJsonl(auditFile, { at, action: oldTier === "hot" ? "recall_touch" : "auto_reheat", actor: "prism", file: path.relative(this.root, file), old_tier: oldTier, new_tier: "hot", sequences: [...wanted] });
          updated++;
          if (oldTier !== "hot") tierChanged = true;
        } catch (e) {
          this.logger && this.logger.log(`[lifecycle] recall tracking skipped for ${name}: ${e.message}`);
        }
      }
    }
    if (tierChanged) this.syncAllFts5Tiers({ preserveExisting: true });
    try {
      const db = this._fts5Db();
      this._fts5EnsureSchema(db);
      const touch = db.prepare(`INSERT INTO episode_activity(thread_id,seq,last_recalled_at,recall_count)
        VALUES (?,?,?,1) ON CONFLICT(thread_id,seq) DO UPDATE SET
        last_recalled_at=excluded.last_recalled_at, recall_count=episode_activity.recall_count+1`);
      const heat = db.prepare("UPDATE episode_tier SET tier='hot' WHERE thread_id=? AND seq=?");
      db.transaction(() => { for (const seq of heated) { touch.run(String(threadId), seq, at); heat.run(String(threadId), seq); } })();
    } catch (e) {
      this.logger && this.logger.log(`[lifecycle] source recall tracking skipped: ${e.message}`);
    }
    return updated;
  }

  // FTS5 layered search: Hot → Warm → Cold; Archive never returned
  _searchWithFts5(threadId, ftsQuery, cutSeq, maxResults, { includeArchive = false } = {}) {
    const db = this._fts5Db();
    this._fts5EnsureSchema(db);
    const results = [];
    const seen = new Set();

    for (const tier of includeArchive ? ["hot", "warm", "cold", "archive"] : ["hot", "warm", "cold"]) {
      if (results.length >= maxResults) break;
      const needed = maxResults - results.length;
      let rows;
      try {
        rows = db.prepare(`
          SELECT sf.seq, sf.content, sf.role
          FROM source_fts sf
          JOIN episode_tier et ON et.thread_id = sf.thread_id AND et.seq = sf.seq
          WHERE sf.thread_id = ?
            AND sf.seq <= ?
            AND et.tier = ?
            AND source_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(String(threadId), cutSeq, tier, ftsQuery, needed + 5);
      } catch {
        // If FTS query itself is malformed, skip this tier
        rows = [];
      }
      for (const r of rows) {
        if (seen.has(r.seq)) continue;
        seen.add(r.seq);
        results.push(r);
        if (results.length >= maxResults) break;
      }
    }
    return results; // [{ seq, content, role }]
  }

  // ─── searchEpisodes: embedding 优先，失败时回退 FTS5 / bigram ─────────────

  searchEpisodes(threadId, query, maxResults = 2, { beforeSeq = null, includeArchive = false } = {}) {
    const timeline = this.getTimeline(threadId, 500);
    const lastSeq = timeline.length > 0 ? timeline[timeline.length - 1].sequence : 0;
    // cutSeq for bigram fallback (timeline-window)
    const corpusCutSeq = beforeSeq !== null ? beforeSeq : Math.max(0, lastSeq - 20);
    let allowedSeqs = null;
    if (BetterSqlite3 && !includeArchive) {
      try {
        allowedSeqs = new Set(this._fts5Db().prepare("SELECT seq FROM episode_tier WHERE thread_id = ? AND tier != 'archive'").all(String(threadId)).map(row => Number(row.seq)));
      } catch {}
    }
    const corpus = timeline.filter(ep => !ep.deleted && ep.content && ep.sequence <= corpusCutSeq && (!allowedSeqs || allowedSeqs.has(Number(ep.sequence))));

    // Questions such as “最后一次玩玩具是什么时候” need chronological lexical
    // precision. Pure semantic similarity can confuse the concrete noun with
    // related concepts (for example 4399 or a shared-body doll), while Chinese
    // FTS tokenization does not reliably match a word embedded in a sentence.
    // Search the complete embedding corpus for salient CJK bigrams first and
    // prefer the newest matching source episode.
    if (BetterSqlite3 && /(?:最后一次|上一次|上次|最近一次|什么时候|哪天|哪一次)/.test(String(query || ""))) {
      try {
        const stop = new Set(["我们","你们","他们","最后","一次","上次","最近","什么","时候","哪天","哪一","一次","是什","么时","具是","后一"]);
        const hanzi = String(query || "").match(/[一-鿿]/g) || [];
        const terms = [...new Set(hanzi.map((_, i) => hanzi.slice(i, i + 2).join("")).filter(term => term.length === 2 && !stop.has(term)))];
        if (terms.length) {
          const state = this.getState(threadId);
          const cutSeq = beforeSeq !== null ? beforeSeq : Math.max(0, (state.episode_counter || lastSeq) - 20);
          const rows = this._fts5Db().prepare(`
            SELECT e.seq, e.content, e.role, et.tier
            FROM embeddings e JOIN episode_tier et
              ON et.thread_id=e.thread_id AND et.seq=e.seq
            WHERE e.thread_id=? AND e.seq<=?
          `).all(String(threadId), cutSeq).filter(row => includeArchive || row.tier !== "archive");
          const scored = rows.map(row => ({ ...row, lexicalScore: terms.reduce((sum, term) => sum + (String(row.content).includes(term) ? 1 : 0), 0) }))
            .filter(row => row.lexicalScore > 0)
            .sort((a, b) => b.lexicalScore - a.lexicalScore || b.seq - a.seq)
            .slice(0, maxResults);
          if (scored.length) {
            const timelineBySeq = new Map(timeline.map(ep => [ep.sequence, ep]));
            return scored.map(row => timelineBySeq.get(row.seq) || { sequence: row.seq, content: row.content, role: row.role, id: null });
          }
        }
      } catch (e) {
        this.logger && this.logger.log(`[lexical-recall] temporal search skipped: ${e.message}`);
      }
    }

    if (BetterSqlite3 && String(query || "").trim()) {
      try {
        const state = this.getState(threadId);
        const cutSeq = beforeSeq !== null ? beforeSeq : Math.max(0, (state.episode_counter || lastSeq) - 20);
        const rows = this._searchWithEmbeddings(threadId, query, cutSeq, maxResults, { includeArchive });
        if (rows.length > 0) {
          const timelineBySeq = new Map(timeline.map(ep => [ep.sequence, ep]));
          return rows.map(row => timelineBySeq.get(row.seq) || {
            sequence: row.seq, content: row.content, role: row.role, id: null,
          });
        }
      } catch (e) {
        this.logger && this.logger.log(`[embedding] search unavailable, falling back to FTS5: ${e.message}`);
      }
    }

    // ── FTS5 path ──────────────────────────────────────────────────────────────
    if (!this._fts5Disabled && BetterSqlite3) {
      const ftsQuery = buildFts5Query(query);
      if (ftsQuery) {
        try {
          // FTS5 cutSeq uses state.episode_counter (covers full history, not just recent 500)
          const state = this.getState(threadId);
          const fts5CutSeq = beforeSeq !== null ? beforeSeq : Math.max(0, (state.episode_counter || lastSeq) - 20);
          const rows = this._searchWithFts5(threadId, ftsQuery, fts5CutSeq, maxResults, { includeArchive });
          if (rows.length > 0) {
            // FTS5 seqs may be outside the 500-episode window — use FTS5 data directly
            // then enrich with timeline data where available (for deleted flag etc.)
            const timelineBySeq = new Map(timeline.map(ep => [ep.sequence, ep]));
            const result = rows
              .filter(r => {
                const tl = timelineBySeq.get(r.seq);
                return !tl || !tl.deleted; // exclude deleted episodes
              })
              .map(r => {
                const tl = timelineBySeq.get(r.seq);
                // Return full timeline object if available, else synthetic from FTS5 data
                return tl || { sequence: r.seq, content: r.content, role: r.role, id: null };
              });
            if (result.length > 0) return result.slice(0, maxResults);
          }
        } catch (e) {
          // FTS5 failed; disable for this session and fall through to bigram
          this._fts5Disabled = true;
          this.logger && this.logger.log(`[fts5] search failed, falling back to bigram: ${e.message}`);
        }
      }
    }

    // ── bigram fallback ────────────────────────────────────────────────────────
    const raw = String(query || "");
    const words = raw.split(/\s+/).filter(k => k.length >= 2);
    const hanzi = raw.match(/[一-鿿]/g) || [];
    const bigrams = hanzi.length >= 2
      ? hanzi.map((_, i) => hanzi.slice(i, i + 2).join("")).filter(s => s.length === 2)
      : [];
    const keywords = [...new Set([...words, ...bigrams])].filter(k => k.length >= 2);

    if (keywords.length > 0) {
      const scored = corpus
        .map(ep => {
          const text = String(ep.content).toLowerCase();
          const score = keywords.reduce((s, k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
          return { ...ep, _score: score };
        })
        .filter(ep => ep._score > 0)
        .sort((a, b) => b._score - a._score || b.sequence - a.sequence);
      if (scored.length > 0) return scored.slice(0, maxResults);
    }

    // 最终 fallback：返回更早的 assistant 消息
    return corpus
      .filter(ep => ep.role === "assistant")
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, maxResults);
  }

  // ─── buildCompilerPrompt (kept for legacy callers if any) ──────────────────

  buildCompilerPrompt(threadId, throughCounter = null) {
    const state = this.getState(threadId);
    const start = state.last_compiled_counter + 1;
    const end = throughCounter === null ? state.episode_counter : Math.min(throughCounter, state.episode_counter);
    return [
      "[INTERNAL MEMORY COMPILER - never show this to the user]",
      "The conversation source has already been saved outside this model.",
      "Update the small continuity state for the just-finished span. Preserve uncertainty.",
      "Do not claim an interpretation is a user fact. Do not include private chain-of-thought.",
      "Reply with exactly one JSON object and no markdown:",
      '{"thread_spine":"<=90 Chinese chars","episode_delta":"<=70 Chinese chars","memory_atoms":["<=45 chars each, max 3; facts only or explicitly labelled interpretation"],"open_loops":["<=35 chars each, max 2"],"friction_markers":["<=60 chars each, max 3; note uncertain/contested/ambiguous moments, or omit array if none"],"compression_note":"required; 1-3 sentences in Chinese: what was preserved, what was not injected into continuity, and why; never imply source was deleted"}',
      `The new source range is episode sequence ${start} through ${end}.`,
      state.thread_spine ? `Previous spine: ${state.thread_spine}` : "Previous spine: none.",
    ].join("\n");
  }

  // ─── Governance ──────────────────────────────────────────────────────────────

  governanceLedgerFile() {
    return path.join(this.root, "ledger", "governance.jsonl");
  }

  _newGovId() {
    return `gov_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  getGovernanceMap() {
    const file = this.governanceLedgerFile();
    const map = new Map();
    if (!fs.existsSync(file)) return map;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const ep = rec.target_episode_id;
        if (!ep) continue;
        if (!map.has(ep)) map.set(ep, {
          frozen: false, frozen_by: null,
          disputed_by: [],
          delete_plan: null,
          delete_confirm: null,
          delete_ready: false,
          deleted: false, tombstone_hash: null,
        });
        const st = map.get(ep);
        if (rec.action === "freeze" && !st.frozen) { st.frozen = true; st.frozen_by = rec.actor; }
        if (rec.action === "dispute" && !st.disputed_by.includes(rec.actor)) st.disputed_by.push(rec.actor);
        if (rec.action === "delete_plan" && !st.delete_plan)
          st.delete_plan = { action_id: rec.action_id, actor: rec.actor, at: rec.at, reason: rec.reason };
        if (rec.action === "delete_confirm" && !st.delete_confirm && st.delete_plan && rec.actor !== st.delete_plan.actor) {
          st.delete_confirm = { action_id: rec.action_id, actor: rec.actor, at: rec.at, reason: rec.reason };
          st.delete_ready = true;
        }
        if (rec.action === "tombstone") { st.deleted = true; st.tombstone_hash = rec.content_hash; }
      } catch {}
    }
    return map;
  }

  getGovernanceLedger(limitN = 30) {
    const file = this.governanceLedgerFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limitN).reverse()
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  getLegacySummaries() {
    const file = path.join(this.root, "legacy", "ombre-brain-import.json");
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  _legacyAuditFile() { return path.join(this.root, "legacy", "audit-state.json"); }
  _legacySplitsFile() { return path.join(this.root, "legacy", "splits.json"); }

  getLegacyAuditState() {
    try { return JSON.parse(fs.readFileSync(this._legacyAuditFile(), "utf8")); } catch { return {}; }
  }

  setLegacyAudit({ memoryKey, actor, verdict }) {
    const validActors = ["晶晶", "沐沐"];
    const validVerdicts = ["保留原样", "待拆分", "存疑", "拒绝"];
    if (!validActors.includes(actor)) throw new Error(`invalid actor: ${actor}`);
    if (!validVerdicts.includes(verdict)) throw new Error(`invalid verdict: ${verdict}`);
    if (!memoryKey) throw new Error("memoryKey required");

    const state = this.getLegacyAuditState();
    if (!state[memoryKey]) state[memoryKey] = {};
    state[memoryKey][actor] = { verdict, at: nowIso() };

    const jj = state[memoryKey]["晶晶"];
    const mu = state[memoryKey]["沐沐"];
    if (jj && mu && jj.verdict === mu.verdict) {
      state[memoryKey].agreed = true;
      state[memoryKey].final_verdict = jj.verdict;
      state[memoryKey].agreed_at = nowIso();
    } else {
      state[memoryKey].agreed = false;
      delete state[memoryKey].final_verdict;
      delete state[memoryKey].agreed_at;
    }

    fs.mkdirSync(path.dirname(this._legacyAuditFile()), { recursive: true });
    fs.writeFileSync(this._legacyAuditFile(), JSON.stringify(state, null, 2), "utf8");
    return state[memoryKey];
  }

  getLegacySplits() {
    try { return JSON.parse(fs.readFileSync(this._legacySplitsFile(), "utf8")); } catch { return {}; }
  }

  saveLegacySplit({ memoryKey, episode, facts, perspectives, splitBy }) {
    if (!memoryKey) throw new Error("memoryKey required");
    const auditState = this.getLegacyAuditState();
    const a = auditState[memoryKey] || {};
    if (!a.agreed || a.final_verdict !== "待拆分") {
      throw new Error('该记忆尚未达成"待拆分"共识，无法保存拆分');
    }
    const leg = this.getLegacySummaries();
    const source = leg ? (leg.memories || []).find(m => (m.id || m.source_file) === memoryKey) : null;
    const split = {
      memory_key: memoryKey,
      source_title: source ? source.title : memoryKey,
      source_bucket: source ? source.bucket : null,
      audit_status: "无逐字原文可核对、待共同审计",
      auto_recall: false,
      split_by: splitBy || "手动拆分",
      split_at: nowIso(),
      audited_by: { 晶晶: a["晶晶"] || null, 沐沐: a["沐沐"] || null },
      episode: (episode || "").trim(),
      facts: Array.isArray(facts) ? facts.filter(Boolean) : (facts || "").split("\n").map(s => s.trim()).filter(Boolean),
      perspectives: Array.isArray(perspectives) ? perspectives.filter(Boolean) : (perspectives || "").split("\n").map(s => s.trim()).filter(Boolean),
    };
    const splits = this.getLegacySplits();
    splits[memoryKey] = split;
    fs.mkdirSync(path.dirname(this._legacySplitsFile()), { recursive: true });
    fs.writeFileSync(this._legacySplitsFile(), JSON.stringify(splits, null, 2), "utf8");
    return split;
  }

  _legacyEnableFile() { return path.join(this.root, "legacy", "enable-state.json"); }

  getLegacyEnableState() {
    try { return JSON.parse(fs.readFileSync(this._legacyEnableFile(), "utf8")); } catch { return {}; }
  }

  setLegacyEnable({ memoryKey, itemKey, actor, enabled }) {
    const validActors = ["晶晶", "沐沐"];
    if (!validActors.includes(actor)) throw new Error(`invalid actor: ${actor}`);
    if (!memoryKey || !itemKey) throw new Error("memoryKey and itemKey required");
    const splits = this.getLegacySplits();
    if (!splits[memoryKey]) throw new Error("该记忆尚未完成拆分，无法启用");
    const state = this.getLegacyEnableState();
    if (!state[memoryKey]) state[memoryKey] = {};
    if (!state[memoryKey][itemKey]) state[memoryKey][itemKey] = {};
    state[memoryKey][itemKey][actor] = { enabled: !!enabled, at: nowIso() };
    const jj = state[memoryKey][itemKey]["晶晶"];
    const mu = state[memoryKey][itemKey]["沐沐"];
    state[memoryKey][itemKey].agreed = !!(jj && mu && jj.enabled && mu.enabled);
    fs.mkdirSync(path.dirname(this._legacyEnableFile()), { recursive: true });
    fs.writeFileSync(this._legacyEnableFile(), JSON.stringify(state, null, 2), "utf8");
    return state[memoryKey][itemKey];
  }

  getEnabledLegacyItems() {
    const splits = this.getLegacySplits();
    const enableState = this.getLegacyEnableState();
    const leg = this.getLegacySummaries();
    const auditState = this.getLegacyAuditState();
    const memoryMeta = {};
    if (leg && leg.memories) {
      for (const m of leg.memories) memoryMeta[m.id || m.source_file] = m;
    }
    const items = [];
    for (const [memoryKey, split] of Object.entries(splits)) {
      const en = enableState[memoryKey] || {};
      const meta = memoryMeta[memoryKey] || {};
      const base = {
        memory_key: memoryKey,
        source_title: split.source_title || meta.title || memoryKey,
        source_bucket: split.source_bucket || meta.bucket,
        audited_by: split.audited_by || {},
        audit_status: split.audit_status,
      };
      if (en.episode && en.episode.agreed && split.episode) {
        items.push({ ...base, type: "episode", content: split.episode, item_key: "episode" });
      }
      if (Array.isArray(split.facts)) {
        split.facts.forEach((f, i) => {
          const ek = `fact_${i}`;
          if (en[ek] && en[ek].agreed) items.push({ ...base, type: "fact", content: f, item_key: ek });
        });
      }
      if (Array.isArray(split.perspectives)) {
        split.perspectives.forEach((p, i) => {
          const ek = `perspective_${i}`;
          if (en[ek] && en[ek].agreed) items.push({ ...base, type: "perspective", content: p, item_key: ek });
        });
      }
    }
    return items;
  }

  getLegacyStats() {
    const leg = this.getLegacySummaries();
    const auditState = this.getLegacyAuditState();
    const splits = this.getLegacySplits();
    const enableState = this.getLegacyEnableState();
    const memories = leg ? (leg.memories || []) : [];
    const total = memories.length;
    const verdictCounts = { 保留原样: 0, 待拆分: 0, 存疑: 0, 拒绝: 0, 未共识: 0 };
    const noConsensus = [];
    for (const m of memories) {
      const key = m.id || m.source_file;
      const a = auditState[key] || {};
      if (a.agreed) verdictCounts[a.final_verdict] = (verdictCounts[a.final_verdict] || 0) + 1;
      else { verdictCounts.未共识++; noConsensus.push({ key, title: m.title, jj: a["晶晶"]?.verdict, mu: a["沐沐"]?.verdict }); }
    }
    let enabledItemCount = 0;
    for (const [, items] of Object.entries(enableState)) {
      for (const [, st] of Object.entries(items)) { if (st.agreed) enabledItemCount++; }
    }
    return { total, verdictCounts, splitCount: Object.keys(splits).length, enabledItemCount, noConsensus };
  }

  // ─── findEpisode — uses ep.sequence (E) ─────────────────────────────────────

  findEpisode(episodeId, threadId) {
    const marker = `thread-${safePart(threadId)}.jsonl`;
    const files = walkFiles(path.join(this.root, "source", "conversations"))
      .filter(f => path.basename(f) === marker).sort();
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ep = JSON.parse(line);
          if (ep.id === episodeId) return { episode: ep, file };
        } catch {}
      }
    }
    return null;
  }

  applyGovernance({ actor, action, episodeId, reason, threadId, refActionId }) {
    const validActors = ["晶晶", "沐沐"];
    if (!validActors.includes(actor)) throw new Error("invalid actor");
    const validActions = ["freeze", "dispute", "delete_plan", "delete_confirm"];
    if (!validActions.includes(action)) throw new Error("invalid action");
    const govMap = this.getGovernanceMap();
    const st = govMap.get(episodeId) || {};
    if (st.deleted) throw new Error("episode already deleted");
    if (action === "freeze") {
      if (st.frozen) throw new Error("已冻结");
      const found = this.findEpisode(episodeId, threadId);
      if (found) {
        const authorActor = found.episode.role === "assistant" ? "沐沐" : "晶晶";
        if (actor !== authorActor) throw new Error(`只有 ${authorActor} 可以冻结此条消息`);
      }
    }
    if (action === "delete_plan" && st.delete_plan) throw new Error("删除申请已存在");
    if (action === "delete_confirm") {
      if (!st.delete_plan) throw new Error("尚无删除申请");
      if (st.delete_confirm) throw new Error("已确认");
      if (actor === st.delete_plan.actor) throw new Error("不能自己确认自己的申请");
    }
    const record = {
      action_id: this._newGovId(),
      thread_id: String(threadId || ""),
      target_episode_id: String(episodeId),
      actor, action,
      reason: String(reason || "").slice(0, 200),
      at: nowIso(),
      ref_action_id: refActionId || null,
    };
    appendJsonl(this.governanceLedgerFile(), record);
    return record;
  }

  // ─── deleteImpact / executeDelete — ep.sequence (E) ─────────────────────────

  deleteImpact(episodeId, threadId) {
    const found = this.findEpisode(episodeId, threadId);
    if (!found) return { found: false };
    const ep = found.episode;
    const state = this.getState(String(threadId || ""));
    const lastCompiled = state.last_compiled_counter || 0;
    const epSequence = ep.sequence || 0;  // E: was ep.counter
    const inCompiled = epSequence > 0 && epSequence <= lastCompiled;
    return {
      found: true,
      sequence: epSequence,
      role: ep.role,
      timestamp: ep.timestamp,
      contentPreview: String(ep.content || "").slice(0, 120),
      inCompiled,
      lastCompiled,
      warning: inCompiled ? "此 episode 已被编入压缩摘要，删除后建议重新压缩以保持一致性" : null,
    };
  }

  executeDelete({ episodeId, threadId, actor }) {
    const govMap = this.getGovernanceMap();
    const st = govMap.get(episodeId);
    if (!st || !st.delete_ready) throw new Error("尚未双签确认，不可执行");
    if (st.deleted) throw new Error("已删除");

    const found = this.findEpisode(episodeId, threadId);
    let contentHash = null;
    if (found) {
      const backupFile = `${found.file}.${Date.now()}.pre-delete.bak`;
      fs.copyFileSync(found.file, backupFile);
      contentHash = crypto.createHash("sha256").update(String(found.episode.content || "")).digest("hex");
      const fileContent = fs.readFileSync(found.file, "utf8");
      const newLines = fileContent.split("\n").map(line => {
        if (!line.trim()) return line;
        try {
          const ep = JSON.parse(line);
          if (ep.id === episodeId) {
            return JSON.stringify({ ...ep, content: "[deleted]", deleted: true, deleted_at: nowIso() });
          }
        } catch {}
        return line;
      });
      fs.writeFileSync(found.file, newLines.join("\n"), "utf8");
      if (BetterSqlite3 && !this._fts5Disabled) {
        try {
          const db = this._fts5Db();
          db.prepare("DELETE FROM source_fts WHERE thread_id = ? AND seq = ?").run(String(threadId), found.episode.sequence);
          db.prepare("DELETE FROM embeddings WHERE thread_id = ? AND seq = ?").run(String(threadId), found.episode.sequence);
          db.prepare("DELETE FROM episode_tier WHERE thread_id = ? AND seq = ?").run(String(threadId), found.episode.sequence);
        } catch (e) {
          this.logger && this.logger.log(`[memory] deleted episode index cleanup failed: ${e.message}`);
        }
      }
    }

    const tombstone = {
      action_id: this._newGovId(),
      thread_id: String(threadId || ""),
      target_episode_id: String(episodeId),
      actor, action: "tombstone",
      reason: "双签执行删除",
      at: nowIso(),
      content_hash: contentHash,
      ref_action_id: st.delete_confirm?.action_id || null,
    };
    appendJsonl(this.governanceLedgerFile(), tombstone);

    if (found) {
      const tid = String(threadId || "");
      const state = this.getState(tid);
      const epSequence = found.episode.sequence || 0;  // E: was ep.counter
      const lastCompiled = state.last_compiled_counter || 0;
      if (epSequence > 0 && epSequence <= lastCompiled) {
        this.saveState(tid, { ...state, needs_recompile: true, needs_recompile_reason: `episode ${episodeId} deleted` });
      }
    }

    return tombstone;
  }

  // ─── consistencyCheck — ep.sequence (E) ─────────────────────────────────────

  consistencyCheck({ fix = false } = {}) {
    const threads = this.listThreads();
    const issues = [];
    for (const t of threads) {
      const tid = t.thread_id;
      const state = this.getState(tid);
      const lastCompiled = state.last_compiled_counter || 0;
      if (lastCompiled === 0) continue;
      const timeline = this.getTimeline(tid, 9999);
      const deletedInCompiled = timeline.filter(ep =>
        ep.deleted === true && (ep.sequence || 0) > 0 && (ep.sequence || 0) <= lastCompiled  // E: was ep.counter
      );
      if (deletedInCompiled.length > 0 && !state.needs_recompile) {
        issues.push({
          thread_id: tid,
          issue: "needs_recompile_not_set",
          deleted_in_compiled: deletedInCompiled.map(ep => ep.id),
          last_compiled_counter: lastCompiled,
        });
        if (fix) {
          this.saveState(tid, {
            ...state, needs_recompile: true,
            needs_recompile_reason: `consistency check: ${deletedInCompiled.length} deleted episodes in compiled range`,
          });
        }
      }
    }
    return { checked: threads.length, issues, fixed: fix ? issues.length : 0 };
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  exportVault() {
    const threads = this.listThreads();
    const threadData = threads.map(t => {
      const state = this.getState(t.thread_id);
      const timeline = this.getTimeline(t.thread_id, 9999);
      return { thread_id: t.thread_id, state, episodes: timeline };
    });
    return {
      exported_at: nowIso(),
      schema: "shared-memory-vault-export.v1",
      threads: threadData,
      legacy: {
        summaries: this.getLegacySummaries(),
        audit_state: this.getLegacyAuditState(),
        splits: this.getLegacySplits(),
        enable_state: this.getLegacyEnableState(),
      },
      governance_ledger: this.getGovernanceLedger(9999),
    };
  }

  // ─── Pending compile ─────────────────────────────────────────────────────────

  _pendingCompileFile(threadId) {
    return path.join(this.root, "derived", "thread-state", `${safePart(threadId)}.pending-compile.json`);
  }

  savePendingCompile(threadId, compilerOutput, throughCounter) {
    writeJson(this._pendingCompileFile(threadId), { compilerOutput, throughCounter, saved_at: nowIso() });
  }

  applyPendingCompileIfExists(threadId) {
    const file = this._pendingCompileFile(threadId);
    if (!fs.existsSync(file)) return false;
    try {
      const pending = JSON.parse(fs.readFileSync(file, "utf8"));
      this.logger.log(`[memory] applying pending compile for thread=${threadId} through=${pending.throughCounter}`);
      this.applyCompilerResult(threadId, pending.compilerOutput, pending.throughCounter);
      return true;
    } catch (e) {
      this.logger.error("[memory] failed to apply pending compile", e.message);
      try { fs.unlinkSync(file); } catch {}
      return false;
    }
  }
}

module.exports = { LocalMemoryService, parseCompilerJson, hasRecallTrigger };
