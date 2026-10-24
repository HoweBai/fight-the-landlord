# 台费（入场费）片 —— 交接文档（2026-10-14）

> **新会话从这里开始**：用户已批准以下设计草案的前提下，第一件事 = 写正式设计文档
> `docs/superpowers/specs/2026-10-14-entry-fee-design.md`，然后照 burn-on-op 先例走
> 「设计评审 r1 → 规格 → 计划评审 → 子代理逐任务实现」。

## 0. 缘起与已定裁决（用户，2026-10-14）

线上运营要有收入 → 讨论「抽水 vs 入场费」→ 用户裁决**做入场费** → 头脑风暴完成，产出如下草案（**待用户点头后转正式设计文档**；文中 6 个「默认」用户未反对，视为暂定）：

| # | 裁决 | 内容 |
|---|---|---|
| 1 | **形态 A · 台费直收（销毁）** | 每人每局扣台费，钱直接收走 = 平台收入；**不做**奖池形态（B，比赛模式，留将来独立立项） |
| 2 | **按底分百分比定价** | 非固定金额 |
| 3 | **每档一个费率** | 配置粒度 = 每个底分档位（休闲 15/标准 80/竞技 480/豪侠 1200 各一个百分比） |
| 默认 | 只收金币场；机器人免收；门槛不变；种子全 0 暗上线；公告前收费；换人优先于取消房；开局后不退 | 可翻案 |

## 1. 设计草案（2026-10-14 会话已呈现给用户，待点头）

**总览**：金币场匹配成功、发牌之前，每位真人按所在档位费率扣台费 ⇒ 销毁（平台收入）。免费场/好友房/机器人不收。

```
休闲场（费率 10%，底分 15 → 台费 1），1 真人 + 2 机器人：
  开局瞬间（一条原子 op）：真人 −1；机器人免收；差额 +1 ⇒ 销毁
```

**配置**（第 42 键，结构化）：`currency.entryFeePercents = [{ baseScore, percent }]`
- 与档位表按 `baseScore` 精确匹配；**未命中 ⇒ 0（fail-safe 不收）**；运营备注：改档位表要同步费率表；
- `percent ∈ 0..50`（与抽水同族）；**种子 = 全档 0（暗上线）**；
- 金额公式（服务端权威=客户端显示同一式）：`percent > 0 ⇒ 台费 = max(1, ⌊底分 × percent ÷ 100⌋)`（保底 1 枚）；
- **客户端可见**（卡面显示金额）：`/api/config` 下发 → 客户端键集 15→16（conformance C14 断言与 fail-safe 面同步）；
- 管理端：入「货币经济」域，结构化编辑器（照 `game.baseScoreLevels` 控件先例）。

**收费链路（核心风险区）**：插在 `rooms.start.ts` 的 `startRoom`（:140）**公告（room.matched）之前**；顺序 = **收费 → 公告 → 发牌**。

| 环节 | 设计 |
|---|---|
| 原子性 | 三人一条 op（真人 seats 各 −fee，机器人跳过），全扣或全不扣 |
| 幂等 | `actionId = entryfee:<房号>`（一房一局恒定锚） |
| 网络失败 | 短退避重试 ≤2（照结算先例）；仍失败 ⇒ 本局不开（零扣） |
| 余额不足（14001） | **换人兜底**：踢不足者 → 复用机器人补位 → 对新阵容重新收费；补位失败/循环超限 ⇒ 取消房全员回大厅（零扣） |
| 收费成功但发牌失败 | **退款补偿** op（`entryfee-refund:<房号>` 幂等） |
| 开局后 | **不退**（服务已发生；与「输光截断不欠账」同族） |

**客户端**：金币场档位卡显示「门票 N」；**门槛不变**（仍 `底分 × entryMultiplier`，台费不并入）；fail-safe：费率取不到 ⇒ 不显示、不阻塞。

**报表**：新来源 `entry_fee` 自动进财务汇总/来源下拉（12→13）/CSV；被收走的钱不可提现（不在可离场 6 源集合，自动成立）；**burn 块只算 game_settle（不动）**，台费看 summary 的 `entry_fee` 行。

**明确不做**：奖池；免费场/好友房收费；机器人收费；开局后退费；玩家流水页；不动结算算法与 burn 块。

## 2. 已核实落点（上一会话实读，可直接引用）

- 开局路径：`packages/room-service/src/rooms/rooms.start.ts:140`（`startRoom`；匹配路径先 announce 再 startGame，:118/:327；返回 false ⇒ 匹配侧 cancel）；
- 模式：`RoomMode = 'random' | 'practice' | 'gold'`（rooms.service.ts:17）；好友房 = `practice` 模式（message.router.ts:538）；
- 金币服务 `currency.apply` 一次可原子扣多人（多 entries 一条 op）；source 尾追先例 = 支付片 +5 源与广告片 +relief_grant；
- source 机制零特判：进 `CURRENCY_SOURCES` allowlist 即通（apply 无不分支）；`withdrawable` cap 只看 6 源集合 ⇒ 新 source 自动不可提现；
- 机器人补位/池机制既有（`rooms.bots.ts`、`currency/robot-funding.ts`，gold-room 片建）；
- burn 块 SQL：`packages/currency-service/src/admin/finance-query.service.ts` `SUMMARY_BURN_SQL`（`source='game_settle'` 字面量——不动）；
- 客户端键集断言点：conformance `slice-17` C14（「恰 15 键」）；管理端来源下拉「恰 12 项」在 `scripts/verify-admin-static.mjs`；结构化键先例 = `game.baseScoreLevels`（protocol 校验 + admin 控件 + conformance）。

## 3. 流程要求（照 burn-on-op 先例，用户既定口径）

1. 用户点头草案 → 写设计文档 → **设计评审 r1**（子代理，报告入 `.superpowers/sdd/2026-10-14-entry-fee/`）→ 处置 → 用户过目；
2. 规格（判据 C 表）→ 评审 → 计划（六~八任务、TDD 步）→ 计划评审 → **子代理逐任务实现**（每任务独立评审）→ opus 终审 → 收口门禁（全仓 lint + 受影响包 vitest + 静态闸 + conformance 相关片）；
3. 记录惯例：账本 `.superpowers/sdd/2026-10-14-entry-fee/progress.md`；提交尾注 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；master 直接实施需用户同意（上次已同意，本片再确认）。

## 4. 关联状态（勿丢）

- **销毁上账片（burn-on-op）已完成**（2026-10-14，本地 master，终审 Yes）——见记忆 `burn-on-op-slice`；**未推 origin / 未 tag / 未部署**（用户裁决面）；CI 权威轮与全序 conformance 待 Actions 额度。
- 依赖键数：本片把 CONFIG_KEYS 41→42、客户端键 15→16——若 burn-on-op 之后又落了别的键，以当时现值为准。
