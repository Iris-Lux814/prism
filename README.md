# Prism

本地优先、source-first 的长期对话记忆框架，适用于 AI 伴侣场景。

---

## 这是什么

Prism 不是把整段聊天塞回模型上下文的"聊天记录总结器"。它把原始消息保存为本地、可核对的 source；把可重建的连续性状态、摘要和检索索引放到 derived。模型只收到当轮真正需要的极小连续包或带来源的证据包。

它解决四件事：

1. 对话压缩、桥接重启和新会话后，仍能接住近期主线；
2. 询问"还记得那次吗"时，回到原始消息核对细节，而不是只依赖摘要；
3. 记忆分冷热与重要度：重要内容可常驻，普通内容会淡出自动召回，但原文不丢；
4. 涉及双方的派生记忆变更必须共同确认，单方提议不生效。

---

## Vault 目录结构

```
memory-vault/
├── source/
│   └── conversations/
│       └── thread-{id}-seq-{n}.jsonl   # 追加写入、永不修改的原始消息
├── derived/
│   ├── episodes/
│   │   └── thread-{id}-seq-{n}.json    # 编译摘要 + 生命周期元数据
│   ├── facts/                          # （可选）长期 Fact 卡片
│   └── lifecycle.db                    # SQLite FTS5 索引（可随时重建）
└── ledger/
    ├── lifecycle-audit.jsonl            # 所有生命周期操作的追加审计日志
    ├── lifecycle-proposals.json         # 待双签确认的提议队列
    └── lifecycle-maintenance.json       # 最近一次维护报告
```

---

## 快速开始

```bash
npm install imprint-memory
# 可选，安装后启用 FTS5 加速：
npm install better-sqlite3
```

```js
const { LocalMemoryService } = require("imprint-memory");

const memory = new LocalMemoryService({
  vaultPath: "./memory-vault",   // 不存在会自动创建
  logger: console,
});

// 追加一条消息
const ep = memory.appendEpisode({
  threadId: "room-1",
  role: "user",
  text: "你还记得我们上次聊的事情吗？",
  timestamp: new Date().toISOString(),
});

// 搜索（FTS5 优先，未安装时自动回退到 bigram）
const results = memory.searchEpisodes("room-1", "上次聊", 3);

// 生成连续包注入到下一轮 prompt
const packet = memory.buildContinuityPacket("room-1", 280, {
  userText: "你还记得我们上次聊的事情吗？",
});
```

---

## 生命周期

每个编译后的 Episode 文件带生命周期元数据：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tier` | `hot \| warm \| cold \| archive` | 召回温度。搜索只返回 hot/warm/cold；archive 永不自动召回。 |
| `importance` | `0.0 – 1.0` | 人工分配的权重。模型可建议，不可自行设置。 |
| `pinned` | `boolean` | 被钉住的记忆抵抗自动降温。 |
| `expires_at` | ISO 日期或 null | 到期后维护任务将其降至 cold。 |
| `superseded_by` | 字符串或 null | 标记为被更新的记忆替代。 |

### 双签规则

任何生命周期变更（温度、重要度、钉住、到期、替代）都需要两个人：

1. 任意一方**提议**变更 → 写入 `ledger/lifecycle-proposals.json`，状态为 `pending`
2. **另一方确认** → 变更写入派生文件生效
3. 自己确认自己的提议无效。拒绝则 source 完全不受影响。

所有提议、确认、拒绝都追加写入 `ledger/lifecycle-audit.jsonl`。

---

## FTS5 搜索

安装 `better-sqlite3` 后，全文搜索使用 SQLite FTS5 配合 `unicode61` 分词。中文通过 bigram 处理。

召回顺序固定为：**Hot → Warm → Cold**。Archive 在代码层面排除，永不进入结果。

索引缺失或损坏时自动在进程内重建（无子进程）。重建失败则透明回退到 bigram 搜索。

---

## 零-token 日常维护

```bash
npm run maintenance
# 或
node src/lifecycle-maintenance.js
```

- 将已过 `expires_at` 的记忆降至 cold
- 将带 `superseded_by` 的记忆降至 cold
- 生成维护报告写入 `ledger/lifecycle-maintenance.json`

**不调用模型，不消耗 API token。** 适合配置为每日定时任务。

---

## 关于角色名

legacy-audit 和治理子系统使用字符串角色标签（源代码中默认为 `"晶晶"` / `"沐沐"`，来自原始部署的两位参与者）。凡是接受 `actor` 参数的方法，都可以传入你自己的角色名。这些标签对库本身没有特殊含义。

---

## 不包含的内容

本库不含：

- Telegram / 微信等聊天平台适配器
- 语音合成（ElevenLabs 等）
- 任何平台通知桥
- 真实 Vault 数据或聊天记录

---

## 参考与感谢

以下项目在设计阶段提供了思路参考（未直接复制代码）：

- [Memory Trigger](https://github.com/riisovo/memory-trigger) — 核心/非核心记忆、到期、遗忘与主动回忆的产品思路
- [Ombre-Brain](https://github.com/P0luz/Ombre-Brain) — 陪伴型记忆与情绪遗忘的研究方向
- [Aelios](https://github.com/wusaki0723/Aelios) — 分层长期记忆与周期整理的架构思路
- [Graphiti](https://github.com/getzep/graphiti) — 事实随时间变化、保留历史有效期的时间知识图谱思路
- [MemGPT 论文](https://arxiv.org/abs/2310.08560) — 有限上下文与外部存储分层处理的基本思想

依赖项目许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 许可证

GPL-3.0 — 见 [LICENSE](LICENSE)。

修改本项目代码后再分发或发布，必须以同等许可证开源。
