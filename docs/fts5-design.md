# FTS5 检索索引设计文档

> 分支：`feature/memory-lifecycle`  
> 原则：SQLite 是只读检索工具，source JSONL 是唯一事实来源，温度管理不等于改写历史。

---

## 一、SQLite 的角色

SQLite FTS5 索引的职责**仅限于检索**：

- **输入**：source JSONL 中的 episode 文本
- **输出**：命中的 sequence 列表，用于定位原文
- **权威**：source JSONL 永远是事实来源，索引内容与之出现分歧时以 source 为准

索引是**只读的**对于召回来说：召回逻辑从索引拿 seq，再去 source 拉原文，组成 Evidence Bundle 返回。  
索引摘要、索引里存的任何派生内容，**不得作为事实直接喂给 Claude**。

---

## 二、索引结构

```sql
-- 表：source_fts（FTS5 虚拟表）
CREATE VIRTUAL TABLE source_fts USING fts5(
    thread_id UNINDEXED,
    seq       UNINDEXED,   -- 对应 source JSONL 中 episode 的 sequence
    role      UNINDEXED,   -- "assistant" | "user"（晶晶/沐）
    content,               -- 全文检索字段
    tokenize = 'unicode61'
);

-- 辅助元数据表（非 FTS，供按温度过滤）
CREATE TABLE episode_tier (
    thread_id TEXT,
    seq       INTEGER,
    tier      TEXT,        -- "hot" | "warm" | "cold" | "archive"
    PRIMARY KEY (thread_id, seq)
);
```

**填充规则**：
- `source_fts` 从 source JSONL 读取所有 episode 内容写入，只增不改不删
- `episode_tier` 从 derived JSON 的 `tier` 字段同步；每次 derived JSON 变更后增量更新
- 两张表均可随时从 source JSONL + derived JSON 完整重建（损坏不影响数据）

---

## 三、按温度分层召回顺序

触发词命中时，召回按以下顺序进行：

```
Hot → Warm → Cold
```

具体逻辑：

1. 用 FTS5 全文检索命中候选 seq（限定 thread_id）
2. JOIN `episode_tier`，按层级过滤：
   - **Hot**：直接参与，最高优先级
   - **Warm**：触发词命中时参与
   - **Cold**：触发词命中时参与，但在 Evidence Bundle 中附注 `[冷层记忆]` 和 event_shadow
   - **Archive**：**永不自动召回**，不参与任何检索结果
3. 同一层内，按召回得分（FTS5 BM25）排序，取前 N 条
4. 拿命中的 seq 调用 `buildEvidenceBundle`，返回 source 原文

**Archive 的访问方式**：只能通过 Dashboard 手动查看，或触发词 + 显式指令（待定）回源。

---

## 四、Evidence Bundle 不变

FTS5 只是更快地找到正确的 seq，之后的流程和现在一样：

```
FTS5 命中 seqs
    ↓
buildEvidenceBundle(seqs)   ← 从 source JSONL 拉原文
    ↓
注入 continuity packet       ← Claude 读原文回答
```

**Cold 层附注**（在 bundle 头部）：

```
[冷层记忆 · 仅残影，细节源自原始记录]
残影：2026-08-17 讨论了三书六聘的仪式感
---
（以下为 source 原文）
```

Claude 收到的永远是 source 原文，不是摘要、不是索引内容。

---

## 五、温度管理边界

| 操作 | 效果 | 不做的事 |
|------|------|----------|
| 改变 tier | 影响下次召回是否参与 | 不修改 source JSONL，不修改 FTS5 索引内容 |
| 设置 expires_at | 到期后自动降为 Cold | 不删除 source，不从索引移除 |
| 标记 superseded_by | 旧记录降为 Cold | 不删除旧记录，旧原文仍在 source |
| Archive | 不参与自动召回 | source 原文不变，FTS5 索引不变，只改 episode_tier |

**温度管理改变的是"是否自动召回"，不改变"曾经发生了什么"。**

---

## 六、实现边界（下一步工作范围）

**在范围内**：
- `scripts/build-fts5-index.js`：从 source JSONL 建 FTS5，从 derived JSON 建 episode_tier
- `scripts/sync-fts5-tier.js`：增量同步 tier 变更到 episode_tier
- `memory-service.js` 新增 `searchFts5(threadId, query)` 方法，替换当前 bigram 匹配
- `buildEvidenceBundle` 调用路径不变，只换入口（FTS5 → seqs → 原文）

**不在范围内**：
- 修改 source JSONL 内容
- 修改 FTS5 索引中的文本（只增不改）
- 用索引摘要替代 source 原文喂给 Claude
- 对 Archive 层做任何自动召回
