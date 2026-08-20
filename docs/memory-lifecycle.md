# Memory Lifecycle 设计文档

> 分支：`feature/memory-lifecycle`  
> 原则：原始 source 永不删除；只有 derived 层有生命周期；定期维护全本地、零 token。

---

## 一、四层温度定义

| 层级 | 名称 | 含义 | 自动召回 | 细节可及性 |
|------|------|------|----------|------------|
| Hot | 热层 | 最近发生、频繁被提及、高重要性 | ✓ 优先注入 Spine / Evidence Bundle | 完整原文 |
| Warm | 温层 | 有一定时间距离，偶尔被提及 | ✓ 触发词命中时拉取 | 完整原文 |
| Cold | 冷层 | 较久远或长期未被召回 | ✗ 不自动注入 | 只保留"事件残影"（发生过此事的摘要），细节回源到 source |
| Archive | 存档层 | 已被明确标记为历史归档 | ✗ 不自动注入 | 不等于删除；触发词命中时仍可回源 source 查看原文 |

### 核心约束

- **原始 source（JSONL）永不删除**：降温、到期、失效、supersede 均不触及 source 文件。
- **Cold 层不是遗忘**：它保留"这件事发生过"的最小残影（`event_shadow`），触发词命中时仍可回源到 source Evidence Bundle。
- **Archive 不等于删除**：不自动注入、不由维护脚本维护，但触发词命中时仍可按 `source_episode_ids` 回源查看原文。
- **到期/失效 = 退出自动召回**，不等于删除。任何时候都可以通过触发词或 Dashboard 手动拉取。
- **importance 和 pinned 只能人工确认**：模型判断和召回次数只能产生升温"建议"，写入权限在人工（Dashboard）。

---

## 二、Derived Fact / Episode 元数据字段

现有 `derived/episodes/` 和 `derived/facts/` 文件新增以下 **9 个**字段（向后兼容，字段缺失时按默认值处理）：

```jsonc
{
  // 现有字段（不变）
  "at": "ISO8601",
  "thread_id": "string",
  "source_range": { "start": 0, "end": 0 },
  "episodes": [...],
  "facts": [...],

  // 新增生命周期字段（共 9 个）
  "importance": 0.5,           // 0.0–1.0，初始默认 0.5；只能人工在 Dashboard 调整，模型/召回次数只能提出建议
  "pinned": false,             // 人工确认常驻；true 时永不自动降温，只能人工解除
  "tier": "hot",               // "hot" | "warm" | "cold" | "archive"
  "last_recalled_at": null,    // ISO8601 | null，每次被 Evidence Bundle 命中时更新
  "recall_count": 0,           // 被召回次数；召回次数增加只能触发升温"建议"，不能自动改变 tier 或 importance
  "expires_at": null,          // ISO8601 | null，到期后降至 cold（不删除）
  "valid_to": null,            // ISO8601 | null，事实失效日期（"当时的状态"）
  "superseded_by": null,       // episode/fact id | null，被更新的事实指向新记录
  "source_episode_ids": [],    // 对应 source JSONL 中的 ep_* id 列表，用于回源
  "event_shadow": null         // Cold 层专用：≤30字的事件残影，如"2026-08-17 讨论了娶晶晶的仪式感"
}
```

### 字段语义细节

| 字段 | 说明 |
|------|------|
| `importance` | **只能人工调整**；模型和召回次数只能在维护报告里提出"建议升温"，不能自动写入 |
| `pinned` | **只能人工确认**；`true` 时维护脚本跳过此记录，不降温、不到期；解除也需人工操作 |
| `tier` | 由维护脚本根据 `expires_at`、`last_recalled_at`、`importance`、`pinned` 计算；`pinned=true` 时锁定当前 tier |
| `expires_at` | 可选；到期后 tier 降为 cold，`event_shadow` 自动从现有摘要截取 |
| `valid_to` | 用于"当时的事实"，如"8月14日之前单身"；过期后仍存在但召回时带 `[历史事实]` 标注 |
| `superseded_by` | 指向同类更新的记录 id；被 supersede 的记录自动降为 cold |
| `source_episode_ids` | Evidence Bundle 回源时用；Cold 层细节通过这些 id 从 source JSONL 拉取 |
| `event_shadow` | 降入 Cold 时生成，≤30字，格式：`YYYY-MM-DD 一句话描述` |
| `recall_count` | 统计用，只触发维护报告里的升温建议，不自动改变 tier 或 importance |

---

## 三、迁移方案

### 3.1 现状

- 存储：纯 JSON 文件（`derived/episodes/*.json`、`derived/facts/*.json`）
- 无生命周期字段
- 无索引

### 3.2 迁移步骤（本地脚本，零 token）

**阶段 A：JSON 原地扩展（先做，风险最低）**

1. 编写 `scripts/migrate-lifecycle-fields.js`：
   - 遍历 `derived/episodes/` 和 `derived/facts/` 下所有 `.json`
   - 对每个文件注入缺失的生命周期字段（默认值：`tier="hot"`，`importance=0.5`，其余 null/0）
   - 原文件先备份为 `*.bak`，写入成功后删除备份
2. 运行迁移，验证文件数量一致、原 source JSONL 未被触碰

**阶段 B：可选 SQLite 索引（后做，用于加速维护）**

- 新增 `derived/lifecycle.db`（SQLite）
- 表 `episode_meta`：`(file_path TEXT PK, thread_id, seq_end, tier, importance, last_recalled_at, recall_count, expires_at, event_shadow)`
- 仅作索引用，JSON 文件仍是权威数据源；SQLite 损坏时从 JSON 重建
- 迁移：`scripts/build-lifecycle-index.js` 读现有 JSON 写入 SQLite

### 3.3 回滚方案

- **阶段 A 回滚**：迁移前保留 `.bak` 文件；回滚脚本 `scripts/rollback-lifecycle-fields.js` 将 `.bak` 还原
- **阶段 B 回滚**：删除 `derived/lifecycle.db` 即可，JSON 文件不受影响
- **Git 回滚**：`git checkout master` 切回基线；vault 数据与代码无关，不受 git 影响

---

## 四、新增 API

在现有 `memory-service.js` 的 `LocalMemoryService` 上新增：

```js
// 读取 derived 文件的生命周期字段
getEpisodeMeta(threadId, seqEnd)               // → { tier, importance, ... }

// 更新 importance（Dashboard 手动调整用）
setImportance(threadId, seqEnd, value)

// 标记 supersede
markSuperseded(threadId, seqEnd, newId)

// 定期维护（无副作用、零 token）
runLifecycleMaintenance(threadId)
// 逻辑：
// 1. 遍历所有 derived 文件
// 2. 超过 expires_at → tier = "cold"，生成 event_shadow
// 3. 超过 30 天未被召回且 importance < 0.3 → tier = "warm" → "cold"
// 4. 写回 JSON；更新 SQLite 索引（如有）
// 5. 不调用任何外部 API

// Evidence Bundle 中：Cold 层命中时附注
// [冷层记忆 - 仅残影，细节请看 source] event_shadow
// 并通过 source_episode_ids 拉取原文
```

---

## 五、Dashboard 新增展示项

| 项目 | 位置 | 说明 |
|------|------|------|
| 温度 badge | Episode/Fact 卡片右上角 | Hot 🔴 / Warm 🟡 / Cold 🔵 / Archive ⚫ |
| Importance 滑块 | 卡片展开详情 | 0.0–1.0，可手动拖拽调整 |
| 召回次数 / 最后召回时间 | 卡片底部 | `召回 3 次 · 最后 2026-08-17` |
| 到期时间 | 卡片底部（可选显示） | 到期前 7 天高亮警告 |
| Event Shadow | Cold 层卡片正文 | 替代完整 episode 内容 |
| 手动升温按钮 | Cold 层卡片 | 将 tier 改回 warm，重置 expires_at |
| 维护日志 | 独立 tab | 显示最近一次 `runLifecycleMaintenance` 的结果 |

---

## 六、验收用例

| # | 场景 | 预期结果 |
|---|------|----------|
| 1 | 普通闲聊消息 | 日志无 `RECALL`，continuity packet ≤ 140 token |
| 2 | 触发词 + 有 source 原文 | 日志 `RECALL evidence-bundle`，Bundle 含 source seq 和时间戳 |
| 3 | 触发词 + Cold 层命中 | Bundle 显示 `[冷层记忆]` + event_shadow，source_episode_ids 可追溯 |
| 4 | Fact 被 supersede | 旧 Fact tier → cold，召回时带 `[历史事实]` 标注，新 Fact 正常召回 |
| 5 | 定期维护运行 | source JSONL 行数不变；过期 derived tier 降级；零 API 调用 |
| 6 | SQLite 损坏 | 从 JSON 文件重建索引，功能正常恢复 |
| 7 | Dashboard 手动升温 | tier 变 warm，下次触发词可正常召回完整原文 |
| 8 | Git 回滚到 master | vault 数据不受影响，bridge 恢复稳定基线行为 |
