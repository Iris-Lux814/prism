#!/usr/bin/env node
/**
 * 零 token 定期维护任务
 * 逻辑：
 *   1. 遍历所有 derived/episodes/ 和 derived/facts/ JSON
 *   2. pinned=true → 跳过，不做任何修改
 *   3. 超过 expires_at → tier = "cold"，生成 event_shadow（如无）
 *   4. 超过 30 天未被召回 且 importance < 0.3 → 建议升温（写入 suggestions 字段，不自动改 importance/tier）
 *   5. superseded_by 有值 → tier 最高降为 "cold"
 *   6. 写回 JSON；不调用任何外部 API
 *   7. 输出维护报告（供 Dashboard 展示）
 */

const fs = require("fs");
const path = require("path");

const VAULT = process.env.TELEGRAM_MEMORY_VAULT || process.env.VAULT_PATH || "./memory-vault";
const DIRS = [
  path.join(VAULT, "derived", "episodes"),
  path.join(VAULT, "derived", "facts"),
];
const COLD_DAYS = 30;   // 超过此天数未召回且 importance < 0.3 → 建议降温
const now = new Date();

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
  pinned_skipped: 0,
  expired_to_cold: 0,
  superseded_to_cold: 0,
  suggestions: [],   // 人工审阅：建议升温或降温的记录
  errors: [],
};

for (const dir of DIRS) {
  for (const file of walkJson(dir)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      report.processed++;
      let changed = false;

      // pinned → 跳过
      if (data.pinned) { report.pinned_skipped++; continue; }

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

      // 召回统计：超过 COLD_DAYS 未被召回 且 importance < 0.3 → 建议（不自动改）
      const daysSince = daysDiff(data.last_recalled_at || data.at);
      if (daysSince > COLD_DAYS && (data.importance || 0) < 0.3 && data.tier === "hot") {
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

// 写报告
const reportFile = path.join(VAULT, "ledger", "lifecycle-maintenance.json");
try {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
} catch {}

console.log("=== lifecycle-maintenance 完成 ===");
console.log(`processed: ${report.processed}  pinned_skipped: ${report.pinned_skipped}`);
console.log(`expired_to_cold: ${report.expired_to_cold}  superseded_to_cold: ${report.superseded_to_cold}`);
if (report.suggestions.length) {
  console.log(`\n建议（需人工审阅，不自动执行）：`);
  for (const s of report.suggestions) console.log(`  [${s.current_tier}] ${s.file}\n    → ${s.reason}`);
}
if (report.errors.length) {
  console.log(`\nERRORS:`);
  for (const e of report.errors) console.log(`  ${e.file}: ${e.error}`);
  process.exit(1);
}
