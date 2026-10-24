# 平台演进附录

> 版本: v1.0（随《斗地主平台设计规格 v4》一同发布）
> 状态: 参考
> 归属: 本文是 `docs/design.md`（v4 主规格）的**附属文档**。主规格 §1.3 明确列出的「MVP 不做」项，其功能范围与设计要点集中于此。
> 上游: `docs/2026-08-31-game-platform-architecture-design.md`（v3.2，4419 行）

---

## 0. 本文的性质与使用方式

**本文不是实现依据。** MVP 阶段不得据本文写代码——其中的功能未经过裁决、部分设计互相矛盾、多数接口停在类型名级别。

本文的用途有三个：

1. **保留范围**：记录参考文档中超出 MVP 的功能，避免将来重新调研；
2. **保留扩展点**：说明主规格在哪些位置为这些功能预留了结构（如 `region` 队列维度、`actionId` 幂等、`actionLog`）；
3. **标记已知缺陷**：参考文档在这些章节中存在**无法直接实施**的问题，逐条列在 §6，供将来启动该功能时先解决。

---

## 1. 参考文档的 7 阶段长期路线

参考文档 §13 规划了 7 个阶段。**每个阶段原样保留了无验收标准的复选框形式**——这正是 MVP 重划 4 阶段并补 DoD 的原因（主规格 §14）。

| Phase | 内容 | 与原 MVP 的关系 |
|-------|------|-----------------|
| 1 基础框架（2-3 周） | 脚手架、Gateway、User Service（含 RBAC）、WS 基础与心跳、Redis+MySQL、Prometheus+Grafana、单测框架 | MVP 的 P0 覆盖其骨架，**不含 RBAC 与监控** |
| 2 核心游戏框架（3-4 周） | Room Service（含多维匹配）、Game Service（策略模式+版本控制）、斗地主玩法、WS 协议与断线重连、监控指标、集成+压力测试 | 对应 MVP 的 P1/P2 |
| 3 货币与支付（2-3 周） | Currency、Payment（充值/退款/超时处理）、一个支付渠道、流水日志、每日对账 | **范围外**，见 §3 |
| 4 机器人系统（2-3 周） | Robot Pool、AI 引擎（斗地主规则引擎）、自动填充、思考延迟、AI 对战模拟测试 | MVP 的 P2 覆盖其中一部分（见 §2.3） |
| 5 配置管理与风控（2 周） | GameConfig 热更新、风控系统、管理员 RBAC | **范围外**，见 §3 |
| 6 更多玩法（持续） | 麻将（血流成河）、麻将（成都麻将）、其他扑克、AI 算法升级（MCTS → 深度学习） | **范围外**，见 §2 |
| 7 管理后台与运维（2-3 周） | Dashboard、Admin Service（含审计日志）、对战记录查询、告警规则、监控面板、运维手册、备份策略 | **范围外**，见 §3 |

### 1.1 Phase 7.5 上线检查清单（值得现在就采纳的部分）

参考文档的 Phase 7.5 是全文**唯一有量化门槛**的部分，其中与 MVP 相关的条目建议提前到 P3 执行：

**灰度发布**
- 部署前全量 `mysqldump` 备份、Redis RDB+AOF 校验
- 蓝绿/金丝雀：先部署 1 个实例，观察 10 分钟
- 判据：**错误率 < 0.1% 且 P99 延迟 < 目标值**
- 逐步增加实例，每步观察 5 分钟；全部完成后冒烟测试

**回滚条件**
- 错误率 > 1% 持续 5 分钟
- P99 延迟超过目标值 2 倍持续 3 分钟
- 数据库连接池耗尽
- 回滚命令：`kubectl rollout undo deployment/<service> --to-revision=N`

**紧急止血**
- WebSocket 连接数超过 **8000** 时暂停新用户登录
- MySQL 主库异常时切换只读模式
- RPC 调用失败率 > 10% 时熔断下游

**安全扫描**
- 依赖漏洞：`npm audit`
- 镜像扫描：Trivy / Clair
- 渗透测试：OWASP ZAP
- 密钥泄露：`git-secrets` / `truffleHog`

---

## 2. 多玩法与策略模式

### 2.1 参考文档的设计

参考文档 §5.4 给出策略模式骨架：

```ts
interface IGameStrategy {
  readonly gameType: string;
  init(playerCount: number): GameState;
  handleAction(state: GameState, action: GameAction): Result;
  calculateWinner(state: GameState): WinnerResult;
  calculateSettlement(winner: WinnerResult, baseScore: number): Settlement[];
}
// 实现：DoudizhuStrategy、MahjongXueliuStrategy
```

### 2.2 与 MVP 的关系

主规格 §3.2 的 `GameSession` 是**斗地主专用**结构，未做泛化。将来引入多玩法时有两种路径：

- **路径 A（推荐）**：把斗地主的 `GameSession` 泛化为 `GameState`，斗地主专有字段（`bidPhase`/`playPhase`/`bottomCards`）下移到策略内；
- **路径 B**：保留独立结构，按 `gameType` 分表存储。

选择 A 还是 B，应在**第二个玩法开工前**决定，而不是现在——现在泛化会为不存在的需求付出抽象成本。

> **2026-10-23 裁决（已落地）**：采用 **A′**——玩法无关内核（`GameRuntime` + `GameRegistry`）+
> 每玩法 runtime 插件；斗地主行为零变化，跑得快作为第二个玩法完成端到端接入。
> 设计：`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md`（v1.3）；
> 实现计划与执行状态：`docs/superpowers/plans/2026-10-23-multi-game-platform-paodekuai.md`。
> 队列键：斗地主保持旧 3 段键，跑得快用 5 段键（含 gameType/playerCount）；记录按玩法分表。

### 2.3 麻将相关（仅登记，不设计）

参考文档 §6.6 给出的麻将函数：`calculateShanten`（向听数）、`calculateSafetyScore`（安全度）、`inferOpponentHand`（读牌）、`chooseAction(state)`（用 `state.myHand`）。

AI 路线：向听数计算+牌效评估 → 安全度计算+防守策略 → 读牌能力+对手建模。

**这些函数签名引用的 `state.myHand` 等字段在参考文档的 `GameState` 定义中并不存在**（见 §6）。

---

## 3. 货币、支付、风控、后台

### 3.1 货币服务（原 Currency Service）

- 职责：余额增减、余额查询、扣费校验、防超扣
- 数据：MySQL（在线账本）+ Redis（余额缓存）
- 关键要求：**Redis 原子 Lua**，键 `currency:{userId}`

**与 MVP 的衔接点**：主规格 §6.5 说明，一旦出现副作用型操作，`baseVersion` CAS 不再足够（请求已应用但响应丢失时，重试会被拒，客户端无法确认是否成功）。此时必须引入**幂等键**：

```ts
// 请求携带客户端生成的 actionId（UUID）
interface SideEffectRequest { actionId: string; /* ... */ }
// 服务端：已见过该 actionId → 直接返回上次结果，不重复执行
// 存储：SET idem:{actionId} <result> EX 300 NX
```

**两条硬约束**：
- `actionId` 是 **UUID，不单调**——它只做「是否见过」的判定，**顺序仍由 `baseVersion` 负责**；
- **不得把 `actionId` 改成单调递增序号**——那会退化成参考文档 `seq` 的老问题（一个字段承担三种互不兼容的语义，详见主规格 §6.2 与附录 A.1 第 2 项）。

### 3.2 支付服务（原 Payment Service）

- 职责：充值、提现、退款、超时处理
- 提现超时自动回滚：`timeout_at` + 定时任务扫描 pending 申请
- 支付渠道抽象层（§5.6.1）：
  - 回调幂等：按订单状态判定（§5.6.2）
  - 验签：**HMAC-SHA256**，`signature = HMAC-SHA256(secretKey, ${timestamp}${body})`（附录 D 决策记录）
- 防重放：时间窗口 **±5 分钟** + 唯一 Nonce，Redis 记录已用 Nonce

> ⚠️ **参考文档的 Nonce 未规定 TTL**（§10.3 原文只说「Redis 记录已使用的 Nonce」）。不设 TTL 会无限增长。实现时**必须补 TTL = 2 × 时间窗口**（即 10 分钟）。

- 错误码段：`14xxx`（货币）、`15xxx`（支付）

### 3.3 对账审计（原 Audit Service）

- Redis 余额与 MySQL 流水**每日对账**，差异自动告警
- 错误码 `14xxx` 中的提现超时相关：`14006` 提现申请已超时、`14007` 额度已超时自动退回

### 3.4 风控（原 §10.7）

参考文档给出的规则与阈值：

```ts
checkFastAction(userId, actions)     // 5 秒窗口内 > 20 次操作
checkProbabilityAnomaly(stats)       // winRate > 0.8 && gamesPlayed > 100
checkDeviceFraud(userId)             // 同一账号 > 3 个设备

score = 通过项数 × 25
score >= 75 → blocked / ban
score >= 50 → suspicious / review
否则        → normal / none
```

处置：`throttle` = `setLimit(userId, 3, 1000)`、`review` 入审核队列、`ban` 调 `userService.banUser` + 通知 + `evidenceId`。

申诉：`POST /api/appeal/create`，24 小时内响应。证据留存 `{userId, deviceId, ipAddress, recentActions, deviceFingerprint, collectedAt}`。

> ⚠️ **参考文档此处有缺陷**：`getRiskLevel()` 只返回 `none | review | ban`，**永不返回 `throttle`**，因此「每秒最多 3 次」这条唯一的限流数值**不可达**。主规格 §5.4 已改为直接取 `checkFastAction` 的 20 次/5 秒作为基线；将来实现风控时须同时修复此缺陷。
>
> 顺带说明：主规格 §5.4 已指出，参考文档 §10.7 的 `checkFastAction` 是**全文唯一的具体频率阈值**。

### 3.5 管理后台（原 Admin Service）

- **独立的管理员认证体系**：独立 Admin JWT、**独立 secret**（不与用户 JWT 混用）、Access 2h / Refresh 7d、`jti` 吊销
- RBAC：`super_admin` / `finance` / `operator` / `viewer`
- 接口（附录 A）：`/api/admin/recharge`、`/api/admin/withdraw/confirm`、`/api/admin/config/update`、`/api/admin/users/*`、`/api/admin/reconciliation/*`、`/api/admin/dashboard/*`
- 审计日志：管理员操作全记录

### 3.6 看板与记录

- **Dashboard Service**：`/api/dashboard/stats`、`/api/dashboard/logs`；Prometheus 指标采集
- **Record Service**：对战记录查询 `/api/record/list`；存 **MongoDB**，**30 天 TTL**
  - ⚠️ 参考文档把 `ttl` 当普通字段 insert，**未说明是否建 TTL 索引**——MongoDB 的 TTL 必须建索引才生效
- 日志检索：Elasticsearch
- 约束：**MongoDB 仅为归档副本，不得回写 Redis**（参考文档 §7.5 明确）

### 3.7 机器人与虚拟经济

参考文档 §6.7 的虚拟经济隔离（MVP 的机器人不计分，故未实现）：

- 独立前缀 `virtual_account_{robotId}`，不与真实 `currency_flows` 混用
- 不可提现、不可转账
- 初始 **10000** 分；< **1000** 分自动补至 **5000** 分；> **50000** 分停止参与
- 补充来源：定时任务从虚拟资金池划拨
- 对战记录 `isRobot: true`；统计排除、不参与真人排行榜；保留 30 天用于 AI 训练

> ⚠️ **前缀不一致**：§6.7 用 `virtual_account_{robotId}`，而 §5.5 的 Currency Service 用 `currency:{userId}`。机器人结算走哪条路径、是否复用 Currency Service，参考文档**未规定**。

---

## 4. 匹配系统的扩展

### 4.1 谓词族（主规格 §8.3 的扩展点）

主规格已定义谓词接口 `MatchPredicate = (a, b) => boolean`，MVP 谓词集为空。后续可加入的**成对排除谓词**：

| 谓词 | 说明 | 失败处置 |
|------|------|----------|
| 地理 500m | 两人距离 < 500m 时不允许同局 | 回退链（主规格 §8.4） |
| 同 IP | 相同公网 IP 不允许同局 | 同上 |
| 同设备指纹 | 相同 deviceId 不允许同局 | 同上 |
| 近期交手 | 最近 N 局内交手过不允许同局 | 同上 |

**共同特征：它们都是「成对排除」，不是「我对一个区间」。** 这是主规格 §8.3 强调「谓词只做排除、不做打分」的原因。

> ⚠️ **地理规则可被 GPS 伪造绕过**，因此它只能是谓词族中**的一条**，与同 IP、同设备指纹共同作用，**不构成强反作弊控制**。

### 4.2 地理谓词的两个实现要点

**① 距离校验成本是常数级。** 斗地主 3 人，`canFormTable` 只需 3 次两两距离计算（Haversine）。**不需要 geohash、不需要图算法、不需要回溯。** 主规格 §8.4 的「随机凑人 → 判定 → 不合格扔回重试」是正确形态。

**② 但候选检索成本需要分区（性能优化，非正确性）。** 当前扫描用 `ZRANGE 0 -1` 拉全队列再切前 3 个，复杂度 O(n)。当队列规模上万时需按地理分区：

```
match:queue:{mode}:{region}
```

- `region` 是**分区维度**（主规格 §8.1 已将其放进键形状，MVP 恒为 `global`）；
- 引入地理谓词时，`region` 的**取值**变为 geohash 格子（即 `geoCell`），键形状不变——这正是主规格 §8.1 提前加入该维度的目的；
- 精度需按规则半径反推（精度 6 约为 1.2km × 0.6km，随纬度变化），**具体取值在实现时确定**；
- **主规格 §8.1 已把 `region` 维度放进队列键形状**，因此这是**加性变更**，不需要迁移已有键。

**重试的失败出口是必需的，不是可选的。** 这条规则的目的正是隔离串通玩家，而串通玩家**恰好地理聚集**；极端情形（100 人同在一个 500m 半径内）下任何三人组合都违规、成功率为 0，无上限重试即永久卡住。主规格 §8.4 已规定重试上限、失败成对记忆、原始时间戳保留与三级回退。

### 4.3 ELO 匹配（参考文档 §9）

参考文档 §9.3 的完整算法：

```ts
eloUpdateScore = round(K * (actual - expected)),  K = 32
expectedScore  = 1 / (1 + 10^((opponentRating - playerRating) / 400))

getEloRange: baseRange = 100 + min(floor(waitTime / 10000), 150)   // 最多 +150

findMatch = ZRANGEBYSCORE(elo ± range)
          → filter(enteredAt >= timeWindow && |latency_a - latency_b| < 200)
          → createRoom(player, validCandidates[0])
```

队列与元数据（§9.2）：

```
match_queue:{gameType}:{roomType}   Sorted Set, member=userId, score=ELO
match_meta:{userId}                 Hash: gameType, roomType, elo, enteredAt, latency
```

房间类型差异化（§9.5）：好友房直接加入不匹配；随机房 ELO ±100-250 / 延迟 ±200ms；积分房 ELO+积分 ±50-150 / 延迟 ±100ms。

**引入 ELO 时的约束**：ELO **只用于排序与扩窗，不承担排除职责**（主规格 §8.2）。

---

## 5. 基础设施演进

### 5.1 存储与消息

| 项 | 参考文档设计 | 引入前提 |
|----|--------------|----------|
| Redis | **Cluster** | 单实例容量或吞吐成为瓶颈时。注意：主规格 §7.3 已指出 `KEYS` 在 Cluster 上不可用 |
| MongoDB | 对战记录归档，30 天 TTL | 需要历史查询时；**不得回写 Redis** |
| Elasticsearch | 日志检索 | 日志量超出现有方案时 |
| RabbitMQ | 异步事件，`exchange: game-events` | MVP 仅用 Redis pub/sub 一个频道（主规格 §4.4）；pub/sub 无持久化，事件不可丢失时才需要 |
| Redis Stream | 对局事件日志（`game_events:{roomId}`） | 需要事件重放时（见 §5.3） |

### 5.2 事件重放（主规格 §6.6 的扩展）

MVP 的重连策略是**全量裁剪快照**。若将来需要增量重放：

- **游标用 `version`，不用消息序号**：服务端按 `version` 记录状态转移，重连时重放 `version > lastVersion` 的转移；
- `version` 是**状态游标**而非消息游标——一次状态转移可能发出多条消息（`state_update` + `current_turn`），这正是想要的：客户端要重建的是**状态**；
- 主规格 §3.2 已要求 `GameSession` 维护 **`actionLog`**，它同时服务于 DouZero 特征与将来的重放。

> ⚠️ **参考文档的事件重放无法直接实施**：`GameEvent.data` 是 `any`，`type` 只有 `'action' | 'start' | 'finish'` 三种，**把事件序列 reduce 回 `GameState` 的规则完全未定义**（§7.5）。此外 `XADD` 未设 `MAXLEN`，也无保留期，长局会无限增长。

### 5.3 Kubernetes 与多实例

参考文档 §14/§15 的要点：

- Deployment + HPA（Robot System 副本 1-5、CPU 70%）
- **WebSocket 一致性哈希路由**（§15.5）：`hash(roomId) % activeGameServiceCount`
- Ingress 配置：`proxy-read-timeout: 3600`、`proxy-send-timeout: 3600`、`proxy-http-version: 1.1`
- ConfigMap + Secret 管理配置
- 滚动更新与回滚（`kubectl rollout undo`）
- ServiceMonitor + AlertManager

**引入多实例前必须解决**（主规格 §10.2 已提出要求，此处给出背景）：

> ⚠️ 参考文档 §7.3 的 `loadActiveGames()` 在多实例下会**各自加载全部房间**（`redis.keys('room:*')` 无过滤），**无分布式锁、无分片归属** → 同一局被两个实例同时推进，状态必然分裂。该函数本身也不可运行：`redis.get()` 返回的是 string，代码却直接访问 `roomData.status`（缺 `JSON.parse`）。

---

## 6. 参考文档中无法直接实施的章节清单

将来启动对应功能前，**必须先解决**这些问题。逐条列出，避免重复踩坑。

| # | 位置 | 问题 |
|---|------|------|
| 1 | 修订历史 v3.2 | 声称「补充 WebSocket 直连路由架构（**第三章附录**）」——**该附录不存在**；相关内容实际在 §15.5 |
| 2 | 修订历史 ×2 + 附录 B | 声称「错误码扩展至 **38** 条」，**实际 40 条** |
| 3 | §5.4 | 示例返回 `{code: 40002}`，**不在附录 B**（对应项为 13002） |
| 4 | §5.4 vs §11.2 | 同一份文档两套消息命名：§5.4 用 `join_room`/`start_game`/`state_update`，§11.2 用 `room.join`/`game.state_update` |
| 5 | §2.2 vs §5.1 | §2.2 说网关是 **Kong/Traefik**，§5.1 给的是 **Nginx** 配置 |
| 6 | §3.3.2 | `enum ServiceEvent` 与 `interface ServiceEvent<T>` **同名**，字面照抄无法编译 |
| 7 | §7.3 | `loadActiveGames()` 代码不可运行（`redis.keys` 在 Cluster 上不可路由 + 缺 `JSON.parse`） |
| 8 | §7.3 / §7.4 | 多实例并发接管无锁、无分片归属 |
| 9 | §7.3 | 快照文件 `fs.writeFileSync` 单文件覆盖写，无临时文件+rename、无多副本、无校验和 |
| 10 | §7.4 | **快照合并算法只有一句话**（「以 Redis 中较新的数据为准」）——如何判「较新」、冲突字段如何取舍、seq/version 如何对齐，全未给 |
| 11 | §7.4 vs §15.5 | 场景 1 承诺 Pod 重启后「玩家无感知」，§15.5 却说 HPA 扩缩「受影响的用户连接断开」——**同一故障两种体验描述** |
| 12 | §7.3 | 快照目录 `/data/snapshots/` 在 K8s 段**无对应 PVC**，容器重建后快照可能直接失效 |
| 13 | §5.3 vs §9.2 | 同一队列，§5.3 写成数组 `[{userId, elo, enteredAt}]`，§9.2 写成 Sorted Set |
| 14 | §9.1 vs §五 | §9.1 画了独立的 **Match Service**，但 §五 服务拆分中**不存在**该服务（§5.3 把 MatchMaker 放在 Room Service） |
| 15 | §9.3 | `getEloRange(player.elo, request.difficulty)` 把 `difficulty` 当 `waitTime` 传；`getMatchMeta` 在**非 async 的 `filter` 回调**里被 `await`——代码不可运行 |
| 16 | §9.3 / §5.3 | 只取 `validCandidates[0]`（**1 个**对手），但斗地主是 3 人（`maxPlayers: 3`）——**三人如何凑局未规定** |
| 17 | §9.4 | `MatchTimeoutConfig` 的三个字段（`maxWaitTime`/`robotFillThreshold`/`expandRangeInterval`）**无默认值** |
| 18 | §3.4 vs §5.3 vs §6.4 | 机器人填充的触发方向三处矛盾：§3.4 写 Room→Robot，§5.3 注释写「返回 null（由 Robot System 填充）」，§6.4 是 Robot 每 5 秒主动轮询 Room |
| 19 | §6.3 | `DoudizhuAI.chooseCard()` 引用的 `state.opponents[].cardCount`、`state.lastPlay`、`state.needsBeat` 在 §5.4 的 `GameState` 定义中**不存在**，照抄无法编译；返回类型 `PlayAction` 全文未定义 |
| 20 | §6.6 | 麻将的 `chooseAction(state)` 使用 `state.myHand`，该字段同样不在 `GameState` 中 |
| 21 | §10.3 | 防重放 Nonce **无 TTL**、无 key 格式 |
| 22 | §10.4 | 「操作频率限制：每秒操作次数限制」——**无数值、无算法、无维度** |
| 23 | §10.6 | 脱敏「使用 **Logback** 自定义转换器实现」——**Java 生态组件**，本项目为 TypeScript/NestJS |
| 24 | §10.7 | `getRiskLevel()` 永不返回 `throttle` → `setLimit(userId,3,1000)` **不可达** |
| 25 | §11.2 | 37 个消息名，**0 个 payload 结构** |
| 26 | §11.1 | `version` 字段在 `WSResponse` 中**不存在**，但 §4.3/§4.8 要求校验 version |
| 27 | §5.1.1 vs §11.2 | 心跳两套机制并存：原生 `ws.ping()/pong` 帧（30s/90s）与应用层 `ping`/`pong` 消息 |
| 28 | §3.2.2 | 11 个 RPC DTO **全部未定义**；**无任何 `@MessagePattern` 名字** |
| 29 | §3.2.3 | 给了 `callWithRetry` 但**无具体数值**、未说明哪些调用可重试（`deduct` 重试是否会重复扣费？） |
| 30 | §3.3.2 | 18 个事件中 **17 个的 payload 未定义** |
| 31 | §3.5 | `TraceInterceptor` 只实现 `switchToHttp()`，**RPC/Event/WS 的追踪上下文传播未给** |
| 32 | §3.6 vs §3.2.1 | §3.6 说「服务发现（Consul/K8s）」，§3.2.1 却是**硬编码 host** |
| 33 | §3.2.1 | `game-service:3001`、`currency-service:3002` 与 HTTP 端口语义混用 |
| 34 | §2.1 vs §3.4 | §3.4 出现 Record/Audit/Reconciliation/Admin/Payment/Dashboard/GameConfig 七个 Service，§2.1 架构图只画了 5 个 + Robot + Dashboard——**哪些是独立进程、哪些是模块未定义** |
| 35 | §2.4 vs §2.2 | 测试工具 Jest/supertest/k6 **均不在技术栈表** |
| 36 | §2.4 | 无任何可执行命令、无覆盖率门槛落地、无 CI 阶段定义 |
| 37 | §十三 | 7 个 Phase **全部是复选框，无 DoD**（唯一例外是 Phase 7.5） |
| 38 | §7.5 | `GameEvent.data` 为 `any`，`type` 仅三种，**事件 reduce 回 `GameState` 的规则未定义**；`XADD` 无 `MAXLEN` |
| 39 | §5.7.1 + §7.5 | MongoDB 归档的写入时机与 Record Service 的归属不清（是否写两次未澄清）；`ttl` 未说明是否建 TTL 索引 |
| 40 | §7.5 vs §5.4 | `GameEvent.seq`、`GameState.lastActionSeq`、WS 的 `seq` **三者是否同一序号空间**——未规定。（该问题在 MVP 中通过删除 `seq` 解决，见主规格 §6.2） |

---

## 7. 与主规格的扩展点对照

| 主规格条款 | 为哪个演进功能预留 |
|------------|--------------------|
| §3.2 `GameSession.actionLog` | 事件重放（§5.2）、DouZero 特征真实性 |
| §3.5 `MatchTicket.region` | 地理谓词（§4.2） |
| §8.1 队列键含 `region` | geohash 分区（§4.2），使地理扩展成为**加性变更** |
| §8.3 `MatchPredicate` 接口 | 谓词族（§4.1） |
| §6.5 三层幂等与 `actionId` | 货币/支付等副作用操作（§3.1） |
| §2.1 RPC 端口段 3100 | 新增服务（Record/Audit/Dashboard 等） |
| §11.1 `14xxx`–`17xxx` 错误码段 | 货币/支付/风控/版本控制 |
| §10.2 单房间单写者 + 分片要求 | 多实例与 K8s（§5.3） |
| §4.4 单一 pub/sub 频道 | RabbitMQ / Redis Stream（§5.1） |
