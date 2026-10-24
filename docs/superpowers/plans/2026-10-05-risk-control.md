# 风控片 实施计划 v1.1.1（冻结）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 交付风控四条链——谓词链（匹配期防串通：IP 透传 + deviceId 采集 + 随机凑/判定/扔回 + `match:rejected`）· 检测链（胜率/设备扫描 → 审核队列）· 处置链（限流档/封禁 + 管理页「风控」视图 + 审计第五源）· 可观测（7 指标 + 2 告警 + 06-risk 面板）。

**架构：** 谓词与选择改造落 **room-service**（`match/predicates.ts` + `match.service.ts`）；数据链 = 网关握手 auth 注入 `clientIp` + 客户端 `deviceId` 随 `room.match` 上行 → `match:meta`；检测/处置落 **user-service**（三新表 + 定时扫描 + 4 管理端点）；授权落 **api-gateway**（policy +4 条 + 握手封禁读旗 + 限流档 peek）。**无新服务、无新容器、无新 env（仅两测试注入面）**。**谓词默认关**（配置种子 `false`；生产开启按手顺）。

**技术栈：** NestJS 11 · TypeORM 0.3 + mysql2（裸 SQL）· Redis ZSET/Hash · prom-client（shared 注册表）· vitest · conformance（`slice-20`）· uni-app（客户端）· Admin 静态页（无构建）。

## Global Constraints（每条任务隐含，逐字遵守）

- **上游唯一**：设计 `docs/superpowers/specs/2026-10-05-risk-control-design.md`（**v1.1.3**）+ 规格 `…-risk-control-spec.md`（**v1.1.3，已冻结**，⚙️1–⚙️24）。任务卡「判据」列 + 任务→规格节对照表为入口；**不认领的行不得顺手实现**。
- **判据只增不减**；任何「恰 N」断言改数字必须**同提交**改断言本体；改了被闸扫描的文件 ⇒ 改完必须跑那条闸。
- 每次改动**一个提交**（结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）；提交信息形如 `feat(room): …（风控 T2）`。
- **任何「跑了」的表述必须指向本次产生的日志**；证据入 `.superpowers/sdd/2026-10-05-risk-control/progress.md` 核销表。
- 迭代期**只跑受影响包**测试；六阶段（`pnpm run ci`）只在 push 前跑一次；全序 conformance 只在验收（CI 权威轮）。
- **不新增 npm 依赖**；**禁新增跨服务 workspace 依赖**。
- DI 要注入的类型**值导入**（`import type` 容器启动即崩）；控制器/服务**必须在某 `*.module.ts` 注册**。
- **wire 一律 epoch ms**；时间列 `datetime(3)`；裸 SQL（不用 TypeORM entity）；**风险相关 SQL 常量被单测全文钉**（锁定读、upsert、批删）。
- 迁移号 **`1790000000000`**（user-service 三表）与 **`1790000001000`**（config-service 种子）；不得另选。
- 错误面：参数/形状 ⇒ 400 借 `10001`；封禁 ⇒ `11003`；限流档超限 ⇒ `10006`；非法源态 ⇒ 409；404 借 `11004`；**16xxx 段不启用**。
- **旗读纪律（R11/F8）**：`risk:limit` / `risk:banned` 读取一律**单独 try/catch ⇒ 按无旗 + error 日志**（**例外：管理动作的校验位读 fail-closed**——波 2 F5 裁决，规格 v1.1.5 §2.6-5；校验位 ≠ 检测位）；正常限流链自身故障语义**不变**（503/10007）。
- **限流档常量** `THROTTLED_RATE_LIMIT = {max:3, windowMs:1000}`（规格值）；WS 档**按 userId** 计数（键 `ratelimit:ws-risk:{userId}`）。
- **谓词默认关**：`risk.predicate.*` 种子 `false`；缺数据 **fail-open**；机器人**不参与**谓词判定。
- admin 页零 `innerHTML`（一切 `textContent`）；只按 HTTP status 分流。
- **真栈回归（③ 教训）**：SQL 类与路径判定类改动（T4/T5/T6/T7）**默认要求一条真栈演练**（读数入 progress）；假执行类测试（假库）不得作为 SQL 正确性证据。
- 已知假红先单跑确认（`ci-flake-known` ②⑤⑧ 族），**别「重跑直到绿」**。
- push/上线由协调者与用户动作决定；完成态 = 三 workflow 三绿 + opus 整支终审 + 交接文档。

**开工必读（每任务开始时先读）：** 规格 §0.3（⚙️1–24）+ 本任务「判据」列点名节 + 设计相应 D 节。

## 任务 → 规格节对照（行级）

| 任务 | 规格节/条 |
|---|---|
| T1 | §2.1-1/2/3/4 · §2.2 种子段 · §2.13 首行 · C13·C14·C15(protocol+config 侧) |
| T2 | §2.4-1..7 · §2.3 前两行 · §2.12 room 三指标 · ⚙️8/14/22/23 · C1–C6 |
| T3 | §2.3 match:meta 行 · §2.7-2(③④) · §2.6-3/4 · §2.8 deviceReport（发送侧）· ⚙️21 · C7·C8(发送)·C9(room)·C12(room)·C23 |
| T4 | §2.2 三表 · §2.8 deviceReport（接收侧）+ 设备清理行 · ⚙️1/11/16(存储侧) · C8(接收)·C15(getter)·C20·C23(接收侧) |
| T5 | §2.5-1..6 · §2.12 user 四指标 · ⚙️3/5/10/15/19(自动)/20/24 · C16·C17·C18 |
| T6 | §2.8 四端点 · §2.7-1/3 · ⚙️19 · §2.13 映射行 · C19 |
| T7 | §2.9-1..5 · §2.6-2 · §2.7-2(②) · §2.13 行 · C9(网关)·C10·C11·C12(网关) |
| T8 | §2.11 · ⚙️16 · C24(文案侧) |
| T9 | §2.10 · C24(页内串/页签) |
| T10 | §2.12 · C22(素材侧) |
| T11 | §6.2 九组 · §7 · 规格 §4.1 **7/9/10/12**（被改文件侧；#11 已核不动）· C21·C22·C15(conformance) |
| T12 | §4.2 全部 + §4.3 登记 · C24 |
| T13 | §5 A1–A8 · §8 · C 全表核销 |

## 文件结构总览

```
新增
  packages/room-service/src/match/predicates.ts          # 类型+两谓词+canFormTable+注册表
  packages/room-service/src/gateway/risk.client.ts       # room→user risk.deviceReport（fire-and-forget）
  packages/room-service/test/predicates.test.ts
  packages/user-service/src/migrations/1790000000000-RiskControl.ts   # 三表 DDL 逐字
  packages/user-service/src/risk/devices.service.ts      # upsert（⚙️11 SQL 常量）
  packages/user-service/src/risk/device-report.rpc.controller.ts
  packages/user-service/src/risk/reviews.service.ts      # 队列 upsert 状态机（scan/admin 共用；RISK_UPSERT_LOCK_SQL 常量）
  packages/user-service/src/risk/scan.service.ts         # 调度+SQL1/2/3+判定+自动限流+自愈
  packages/user-service/src/risk/admin-risk.controller.ts# 四端点（含 CSV 变体）
  packages/user-service/src/risk/devices-cleanup.service.ts
  packages/user-service/src/risk/risk.metrics.ts         # user 四指标（scan 三 + actions 一）
  packages/user-service/test/risk-{devices,devices-cleanup,scan,admin}.test.ts
  packages/config-service/src/migrations/1790000001000-RiskConfigSeed.ts   # 8 键种子
  tools/conformance/src/slices/slice-20-risk-control.ts
  deploy/monitoring/grafana/dashboards/06-risk.json      # uid ftl-risk
  .superpowers/sdd/2026-10-05-risk-control/progress.md   # 核销表（本片台账，已存在则续写）
修改
  packages/protocol/src/{config.ts, validate.ts, messages.ts} + 测试族（**rpc.ts 归 T4 随接收侧**）
  packages/config-service/src/migrations/1790000001000-RiskConfigSeed.ts（新增，T1）
  packages/config-service/test/{platform-config.service.test.ts, helpers/config-probe.ts}（修改，T1）
  packages/room-service/src/{match/match.service.ts, gateway/{ws.gateway.ts, message.router.ts}, config/config-cache.service.ts, metrics/room.metrics.ts} + 测试族
  packages/user-service/src/{app.module.ts, config/config-cache.service.ts} + 测试族
  packages/api-gateway/src/{auth/admin-policy.ts, gateway/{proxy.gateway.ts, gateway.controller.ts}, http/{rate-limit.ts, http-rate-limit.middleware.ts}} + 测试族
  apps/client/src/{net/storage.ts, net/copy.ts, pages/game/game.vue}
  admin/{index.html, app.js, style.css?}
  deploy/monitoring/prometheus/rules/ftl-alerts.yml
  tools/conformance/src/run.ts（CASES :44——**非 index.ts**）· slices/{slice-16-monitoring.ts, slice-18-gold-room.ts, slice-19-admin-rbac-audit.ts} · baselines.json
  docker-compose.yml（user-service 两行 env passthrough）
  scripts/ledger-counts.mjs
  docs/design.md（四处）· docs/client-protocol.md · docs/ops/first-deploy.md（两处）· docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md · docs/superpowers/plans/deviation-ledger.md
```

## 任务总表（依赖 → 判据映射）

| 任务 | 一句话 | 依赖 | 判据 |
|---|---|---|---|
| T1 | 协议与种子（protocol 八键/校验/禁键 + config 种子迁移与键数同步） | — | C13·C14·C15(protocol+config) |
| T2 | 谓词框架与选择形态（room；含指标 3） | T1 | C1–C6 |
| T3 | room 数据链与读点（clientIp/meta/封禁读点/WS 档/risk.client） | T1·T2·**T4**（`RPC_PATTERNS.riskDeviceReport` 在 T4——**执行序：T4 先于 T3**，A1） | C7·C8(发送)·C9(room)·C12(room)·C23 |
| T4 | user 三表迁移 + devices（接收侧+upsert+清理+pattern；含真库迁移演练） | T1 | C8(接收)·C15(getter)·C20·C23(接收) |
| T5 | user 扫描（SQL1/2/3+状态机+自动限流+自愈；真栈一轮演练） | T4 | C16·C17·C18 |
| T6 | user 管理端点（四件+actions 事务+CSV） | T5 | C19 |
| T7 | 网关（policy+握手读旗+档 peek+路由+clientIp 注入） | T1·T6 | C9(网关)·C10·C11·C12(网关) |
| T8 | 客户端（deviceId 生成持久/带发/11003 文案） | T1 | C24(文案) |
| T9 | 管理页（风控视图+审计第五页签+CONFIG_NOTES+字面量） | T6·T7 | C24 |
| T10 | 监控素材（告警 2 条+06-risk 面板） | T2·T5 | C22(素材) |
| T11 | conformance slice-20 + 既有片同步 + 基线 | T2–T10 | C21·C22·C15(conf) |
| T12 | 文档同步（防文档谎报） | T11 | C24 |
| T13 | 收口（六阶段/全栈回归/终审/交接） | 全部 | A1–A8·全表核销 |

---

### Task 1: 协议与种子（protocol + config-service）

**Files:**
- Modify: `packages/protocol/src/config.ts`（`CONFIG_KEYS` +8 键，第 18–25；`parseConfigValue` +8 分支；`CLIENT_CONFIG_KEYS` **不动**）· `packages/protocol/src/validate.ts`（room.match deviceId 校验；`FORBIDDEN_OUTBOUND_KEYS` +`'deviceId'`）· `packages/protocol/src/messages.ts`（`room.match` payload +`deviceId?: string`）
- Create: `packages/config-service/src/migrations/1790000001000-RiskConfigSeed.ts`（8 键种子，照 `1789500000000-RecordRetention.ts` 形态）
- Modify（同提交）：`packages/config-service/test/platform-config.service.test.ts`（`toHaveLength(17)` ⇒ 25 + 键清单全等）· `packages/config-service/test/helpers/config-probe.ts`（SEED 17 行 ⇒ 25）
- Test: `packages/protocol/src/config.test.ts`（计数 17→25）· validate 族测试（deviceId 正反例；禁键负例）· config-service 两处

**Interfaces:**
- Produces: 8 键（名/解析/种子逐字 = 规格 §2.1-3 表）：`risk.predicate.sameDevice:false` · `risk.predicate.sameIp:false` · `risk.winRateThreshold:0.8`（number 0.5–1.0、≤2 位小数）· `risk.minGames:100`（int 1–100000）· `risk.deviceLimit:3`（int 2–100）· `risk.deviceWindowDays:30`（int 1–365）· `risk.autoThrottle:true`（严格 boolean）· `risk.deviceRetentionDays:365`（int 1–3650）。
- Produces: room.match 逻辑类型 `payload: { mode: …; baseScore: number; deviceId?: string }`。
- ⚠️ **`RPC_PATTERNS.riskDeviceReport` 与 `RiskDeviceReportRequest/Response` 不在本任务**：J21 接收侧闸（`packages/protocol/src/robot-availability-wiring.gate.test.ts:205-227`，键集合**动态相等**）要求 pattern 与真接收侧**同提交**（F2）⇒ pattern + 类型并入 **T4**（其提交含接收侧；T3 的发送侧随后，闸对「有 pattern 无发送」不设限）。

- [ ] **Step 1: 单测先行（protocol 面）**——config.test.ts：计数 25 + `CONFIG_KEYS` 全等 + 8 新键解析边界（`0.8` 过 / `0.79` 过（两位小数域内）/ `0.785` 拒（三位小数）/ `0.49` 与 `1.01` 拒（域外）〔**v1.1.2 订正**：v1.0 原文「0.79 拒」与规格 §2.1-3 矛盾，属笔误〕；`minGames` 1 与 100000 过、0 拒；`deviceLimit` 2 过、1 拒；`deviceWindowDays` 1/365 过、366 拒；`deviceRetentionDays` 1/3650 过；严格 boolean 拒 `'true'`）；validate：deviceId 缺省过 / 36 位 UUID 过 / 7 位与 65 位拒 / 含空格与中文拒 / 非 string 拒；出站：含 `deviceId` 的 S→C 载荷抛泄漏错。
- [ ] **Step 2: 跑测试确认红**（`pnpm --filter @fight-the-landlord/protocol test`）。
- [ ] **Step 3: 实现（protocol 三文件）**（逐字；`FORBIDDEN_OUTBOUND_KEYS` 追加处带一行注释「K3：服务器可见；玩家面永不出站」；每键 JSDoc 照既有风格标第 18–25 键与「客户端不可见」）。
- [ ] **Step 4: 跑 protocol 全测试确认绿**（pattern 未加，J21 闸不受影响）。
- [ ] **Step 5: config-service（种子面）**——单测先行：两处计数/SEED 改 25 → 实现：种子迁移（8 行 `INSERT … 'seed'`）+ 两处测试同步 → `pnpm --filter @fight-the-landlord/config-service test` 绿。
- [ ] **Step 6: 真库迁移演练（config 侧）**——`docker compose build config-service && docker compose up -d --no-deps config-service` ⇒ 照 slice-15 头注先例 `docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "…"'` 查 `platform_config` 行数（期望 25）与 `risk.%` 八行种子值；revert 复跑演练照 ③ T2 口径；读数入 progress。
- [ ] **Step 7: 提交**——`feat(protocol,config): 风控八键/deviceId 校验/出站禁键 + 种子迁移与键数同步（风控 T1）`。

### Task 2: 谓词框架与选择形态（room-service）

**Files:**
- Create: `packages/room-service/src/match/predicates.ts` · `packages/room-service/test/predicates.test.ts`
- Modify: `packages/room-service/src/match/match.service.ts`（选择/子集/失败记账/到点出口/attempts 双增点）· `packages/room-service/src/config/config-cache.service.ts`（+2 getter）· `packages/room-service/src/metrics/room.metrics.ts`（+3）· `packages/room-service/test/match.service.test.ts`（重写受影响用例）

**Interfaces:**
- Produces: `interface MatchPredicate { name: 'sameIp'|'sameDevice'; allows(a: MatchTicket, b: MatchTicket): boolean }`（**规格 v1.1.2 §2.4-1 实现形**——函数类型无法承载指标标签）· `sameDevice`/`sameIp`（相等即排除；任一缺字段 ⇒ 允许）· `canFormTable(players: MatchTicket[], enabled: readonly MatchPredicate[]): boolean`（全两两）· `PICK_FAILURE_MARK_TTL_MS = 5000` · `BOT_FILL_WAIT_MS=30000`/`MATCH_MAX_WAIT_MS=60000`/`MATCH_MAX_ATTEMPTS=10`（既有常量复用）。
- Produces: `MatchTicket` +`ip?: string` / `deviceId?: string`（`readMeta` 解析 `raw.ip`/`raw.deviceId`，缺 ⇒ 不上字段）。
- Produces: config getter `riskPredicateSameDevice(): boolean` / `riskPredicateSameIp(): boolean`（缺省 false，照本文件既有 getter 形态）。
- Produces: 指标 `match_predicate_rejections_total{predicate}` · `match_selection_rounds_total` · `match_no_legal_group_total`（写点 = `match.service.ts`）。
- Consumes: `MatchTicket.attempts`（新义）；`match:rejected:{a}:{b}`（字典序、值=失败时刻 ms、TTL 5s）；`risk:hit:{userId}:{predicate}` INCR + EXPIRE 7d。
- 注入面：**照 `setClock()` 成例新增 `setRng(fn)`**（字段 + setter；缺省 `Math.random`）——**不新增构造器形参**（裸可选参在 Nest 会以 `Function` token 解析崩，单测直接 new 看不见；F5）。

- [ ] **Step 0: 扩 Redis 替身（先于一切）**——`match.service.test.ts` 手写替身现缺 `incr`/`get`/`set`（:46-122 一带），本任务断言需要；文件头已有两次「替身缺方法 ⇒ 假绿」教训（F11）。
- [ ] **Step 1: 单测先行（C1–C6）**——
  - predicates.test.ts：全真值表（同 ip 对/同 device 对/双同/全异 × 启用子集）；缺 `ip` 或 `deviceId` ⇒ fail-open；`canFormTable` 三人三对（第 3 对否 ⇒ false）；机器人不传入（调用方保证，断言文档化）。
  - match.service.test.ts（改）：RNG 注入钉序列（构造「[A,B 互斥; C 通融]」：洗牌序 [A,C,B] ⇒ 组 {A,C}）；凑满 3 成组；子集 |S|=3 直接成组（三人团 + 洗牌先落到团外者的序列）；|S|=2 且 ≥30s ⇒ 2+机器人；|S|=1 且 ≥30s ⇒ 1+2 机器人；窗口未到不动；**<3 越窗拆组（C6）**：互斥二人 + 门禁过 ⇒ 各自 ≥30s 后「本人 + 2 机器人」、门禁 false ⇒ 12007；**到点者先参与正常抽取**（60s 到点者被选入合法组 ⇒ 成局不兜底）；未成组到点者 ⇒ 兜底（mock 门禁 true/false 两态 ⇒ 成局/12007）；失败记账：谓词拒绝 ⇒ 记忆键（字典序/TTL 参数）+ 两端 attempts+1 + 两端 INCR；记忆拒绝 ⇒ 仅 attempts+1（记忆值不变、无 INCR）；「洗牌未轮到」零记账；回队 enteredAt 不变；洗牌副本（原序数组未被 sort 破坏——断言 oldest 判定仍取原首）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（**替换 `match.service.ts:591` 起的 <3 门禁段与 `:602` 取人点及全部选择路径（含拆组）**；`incrementAttempts` 复用；到点出口改写点 = 现 `:546-566`/`failMatch` 调用处；`setRng` 照 `setClock` 成例；指标三写在选择函数内）。
- [ ] **Step 4: 跑 room-service 全测试确认绿**（含既有 match 用例全量适配；`pnpm --filter @fight-the-landlord/room-service test`）。
- [ ] **Step 5: 提交**——`feat(room): 谓词框架 + 随机凑/判定/扔回 + match:rejected 真写入（风控 T2）`。

### Task 3: room 数据链与读点（room-service）

**Files:**
- Create: `packages/room-service/src/gateway/risk.client.ts`
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`（握手读 `auth.clientIp` → `socket.data.clientIp`）· `packages/room-service/src/gateway/message.router.ts`（`handleMatch`：meta 写 ip/deviceId + 入队成功后 `risk.report()`；封禁读点 ③入队/④join；WS 限流档按 userId）· `packages/room-service/src/match/match.service.ts`（`addToQueue` 形参扩展）· `packages/room-service/test/no-internal-http.gate.test.ts`（三清单 + 探针两行）· 相关测试（`message.router.test.ts` 等）

**Interfaces:**
- Produces: `RiskClient.report(userId: string, deviceId: string): void`（fire-and-forget：`client.send(RPC_PATTERNS.riskDeviceReport, {userId, deviceId, ...metaFromTrace()}).timeout(3000)` + `.catch(warn 日志)`；**恰在 `addToQueue` 成功后调用一次**，`deviceId` 缺省不调）。
- Consumes: `addToQueue` 现签名 = `addToQueue(userId, mode, baseScore, region)`（`latency` **无形参**、内部硬编码 `'0'`，`match.service.ts:247`）⇒ 本任务扩为末位可选参 `extras?: { ip?: string; deviceId?: string }`（extras 存在才写对应 Hash 字段；调用方 = `handleMatch`，F10）。
- Produces: 握手 `socket.data.clientIp?: string`（`typeof string && len ≤64 && !== 'unknown'` 才存）；`message.router` 封禁/档位读：`isBanned=EXISTS risk:banned:{userId}`（catch ⇒ false）· 档位 `EXISTS risk:limit:{userId}`（catch ⇒ false）⇒ 用 `{max:3,windowMs:1000}` 对 `ratelimit:ws-risk:{userId}` 判定。

- [ ] **Step 1: 单测先行**——握手：合法 clientIp 入 `socket.data`、`'unknown'`/超长/非 string 丢弃；`handleMatch`：enqueue 成功 + deviceId 在 ⇒ `report` 恰一次（mock risk client）、无 deviceId ⇒ 不调、enqueue 失败 ⇒ 不调；meta Hash 新字段断言（有则写、缺则无键）；封禁：旗在 ⇒ 入队 ack `11003`、join ack `11003`（catch 语义：Redis 错 ⇒ 放行 + 无抛出）；限流档：旗在 ⇒ 第 4 条消息/秒 ack `10006`（同一 userId 两条连接合计——多连接聚合断言）、旗无 ⇒ 20/5s 原样。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（`risk.client.ts` 照 `record.client.ts` 形态；三件套闸同提交：`no-internal-http` 三清单一处新增 + 手写探针正/负两行；`meta-on-every-rpc-send` 自动覆盖新 `.send(`）。
- [ ] **Step 4: 跑 room-service 全测试 + 三条闸测试确认绿**。
- [ ] **Step 5: 提交**——`feat(room): clientIp/deviceId 入 meta + 封禁读点 + WS 限流档 + risk.deviceReport（风控 T3）`。

### Task 4: user 三表迁移 + devices 链（user-service）

**Files:**
- Create: `packages/user-service/src/migrations/1790000000000-RiskControl.ts` · `src/risk/devices.service.ts` · `src/risk/device-report.rpc.controller.ts` · `src/risk/devices-cleanup.service.ts` · `src/risk/risk.metrics.ts`
- Modify: `packages/user-service/src/app.module.ts`（controller 注册）· `src/config/config-cache.service.ts`（+6 getter：`riskWinRateThreshold/riskMinGames/riskDeviceLimit/riskDeviceWindowDays/riskAutoThrottle/riskDeviceRetentionDays`，缺省=种子值，坏值回落缺省）· `docker-compose.yml`（user-service env：`RISK_SCAN_INTERVAL_MS=${RISK_SCAN_INTERVAL_MS:-}` 与 `RISK_DEVICES_CLEANUP_INTERVAL_MS=${RISK_DEVICES_CLEANUP_INTERVAL_MS:-}`，照 `:177` 行先例；**偏离登记**：规格 §1.2/§8 v1.1.2 已记——设计 §6「compose 零改动」的唯一例外）
- Modify（**同提交，F2**）：`packages/protocol/src/rpc.ts`（`RPC_PATTERNS.riskDeviceReport='risk.deviceReport'` + `RiskDeviceReportRequest/Response`）· `packages/protocol/src/messages.test.ts`（pattern 清单 +1）· `packages/protocol/src/robot-availability-wiring.gate.test.ts`（若文件文案含「十三键」类计数则同步）
- Test: `test/risk-devices.test.ts` · `test/risk-devices-cleanup.test.ts`

**Interfaces:**
- Produces: 三表 DDL 逐字 = 规格 §2.2（`user_devices`/`risk_reviews`/`risk_actions`；`risk_actions.action` 注释含 `reopen`）。
- Produces: `RiskDeviceReportRequest { userId: string; deviceId: string; meta?: RpcMeta }` · `RiskDeviceReportResponse = { ok: true } | { ok: false; code: string }`（**随接收侧同提交**——J21 键集合动态相等闸）。
- Produces: `DEVICE_UPSERT_SQL`（⚙️11 逐字，**单测全文相等断言**）：`INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at) VALUES (?,?,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE last_seen_at = IF(last_seen_at < NOW(3) - INTERVAL 1 HOUR, NOW(3), last_seen_at)`；`DevicesService.report(userId, deviceId): Promise<{ok:boolean; code?:string}>`（`user_id` 不存在 ⇒ `{ok:false, code:'BAD_PARAM'}` 不抛）。
- Produces: `DevicesCleanupService`（`RISK_DEVICES_CLEANUP_INTERVAL_MS` 默认 3600_000、启动 30s 首轮、自重排 + 关停闸、批删 `DELETE FROM user_devices WHERE last_seen_at < ? LIMIT 1000` 循环至 0 行、cutoff 每轮现读 `riskDeviceRetentionDays()`、`runCleanupOnce(now?)` 注入面——**照 `records-cleanup.service.ts` 骨架**）。
- Produces: `risk.metrics.ts`：`risk_scan_runs_total{result}` · `risk_scan_last_success_timestamp_seconds` · `risk_reviews_open` · `risk_actions_total{action}`（T5/T6 写点 import；写法照 `room.metrics.ts:36-39`）。

- [ ] **Step 1: 单测先行**——devices：upsert 幂等（两报同 device ⇒ 一行、last_seen 节流：<1h 不刷/≥1h 刷）、坏参回 `{ok:false}`、SQL 常量全文断言；cleanup：间隔注入面、批删循环、cutoff 现读配置（改 getter 值 ⇒ 下轮生效）、关停闸。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现 + 注册**（`RiskControl` 迁移按既有迁移文件形态：`up` 建三表 / `down` 逆序 DROP；controller 注册进 `app.module.ts`；**protocol 的 pattern + 接收侧同一提交**——提交前 protocol 与 user-service 测试双绿，J21 闸此时应绿）。
- [ ] **Step 4: 真库迁移演练**——① `docker compose build user-service && docker compose up -d --no-deps user-service`（启动即跑迁移）→ ② 验表（**照 slice-15 头注先例**）：`docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SHOW TABLES LIKE \"user_devices\"; SHOW TABLES LIKE \"risk_%\";"'` → ③ down/复跑：包内 `migration:revert` 后再 up 一次（③ T2 同款；**不得省略 revert 演练**）→ ④ `risk.deviceReport` 接收侧真栈回归（直发 RPC 或经真 room 入队触发，T13 全链）——本步至少完成表级 + 迁移演练读数入 progress。
- [ ] **Step 5: 跑 user-service 全测试确认绿**（含 `meta-on-every-rpc-send` 扫描面经 T3 新增后仍绿）。
- [ ] **Step 6: 提交**——`feat(user): 风控三表迁移 + 设备链（upsert/接收/清理）（风控 T4）`。

### Task 5: user 扫描（检测链核心）

**Files:**
- Create: `src/risk/reviews.service.ts`（队列 upsert 状态机 + 自动限流 + 自愈写旗；scan/admin 共用）· `src/risk/scan.service.ts`（调度 + SQL1/2/3 + 判定 + 指标）
- Modify: `src/app.module.ts`
- Test: `test/risk-scan.test.ts`

**Interfaces:**
- Produces: `RISK_UPSERT_LOCK_SQL`（⚙️10 逐字，**单测全文相等断言**）：`SELECT id,status,score,handled_by,handled_at FROM risk_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`。
- Produces: `ReviewsService.applyScanResult(userId, score, reasons, now)`（事务内：锁定读 → 状态机分流 = 规格 §2.5-3 全行；`risk_actions` 行同事务；`auto_throttle`/`unthrottle`/`reopen` 皆 actor='system'）；`ReviewsService.reopenAudit` 细节 = reasons 附 `{check:'revived', detail:{prevReviewId, prevScore, handledBy, handledAt}}`。
- Produces: `ScanService`（`RISK_SCAN_INTERVAL_MS` 默认 3600_000、30s 首轮、`risk:scan:lock` `SET NX EX 600` + 轮末 compare-and-delete（GET==我 才 DEL）、SQL1/2/3 逐字 = 规格 §2.5-2/4、合并并集、`hit1/hit2/score`、每轮指标、自愈）。
- Consumes: `risk:limit:{userId}`（auto 置/续/删，值 JSON `{source:'auto', at}`；7d TTL）；`risk:banned:{userId}`（自愈补写，写前复核 status）。

- [ ] **Step 1: 单测先行（C16–C18）**——命中矩阵（`games > minGames` 边界：=100 不算、=101 且 winRate>0.8 算）；score ∈{25,50}；upsert 全行：无行 ⇒ INSERT；open ⇒ 更新 + （≥50 && autoThrottle）⇒ 置旗 + throttled + 审计行；throttled(auto) ≥50 续期不刷审计、<50 删旗 + unthrottle 审计 + 回迁（open/dismissed 两档）；throttled(manual) 不动旗；dismissed 同分不动 / 涨分 ⇒ 新 open + `revived` + reopen 审计；banned 跳过；**锁定读「最新一行」语义**（最新为 dismissed 时不得走 INSERT 分支）；自愈：名单 → 复核读 → 仍 banned 才写旗（解封竞态负例：复核时已 active ⇒ 不写）；锁：抢不到跳过 + CAD 释放（值不符不删）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（SQL 逐字；`runScanOnce(now?)` 注入面；指标挂点：轮次开始 `runs_total{result}`（成败分记）、成功设时间戳、轮末 gauge `risk_reviews_open`）。
- [ ] **Step 4: 真栈演练（降阈组合须域内合法）**——`docker compose up -d --no-deps user-service`（注入 `RISK_SCAN_INTERVAL_MS=5000`）→ 管理面改 **`risk.minGames=1` + `risk.winRateThreshold=0.5`（域内最小值；F4：0.01/0.0 类值写入必 400）** → 造 3 局 2 胜（winRate≈0.667 > 0.5、games=3 > 1）⇒ 观察：`risk_reviews` 出现 open 行 / 日志一轮读数 / `risk:scan:lock` 轮末消失 → **并发双会话用例（F13，照 ②金币场 ⚙️14 先例）**：两连接各起事务对同一「无行」用户执行锁定读+INSERT（scan 与 admin 动作并发模拟），断言不出现死锁 1213（若复现 ⇒ 按退化路径明确处置并登记）→ 恢复配置与 env。读数入 progress。
- [ ] **Step 5: 跑 user-service 全测试确认绿**。
- [ ] **Step 6: 提交**——`feat(user): 风险扫描（SQL1/2/3+状态机+自动限流+自愈）（风控 T5）`。

### Task 6: user 管理端点

**Files:**
- Create: `src/risk/admin-risk.controller.ts`
- Modify: `src/app.module.ts`
- Test: `test/risk-admin.test.ts`

**Interfaces:**
- Produces: 四端点逐字 = 规格 §2.8（含 `accountStatus/limitSource`、`revived` 条目、CSV 契约）；写动作 = 五值合法集（`auto_throttle|reopen` 提交 ⇒ 400）；**actor fail-closed 落点**：形态先例 = **config-service** `admin-accounts.service.ts:89-94`（`requireActor`）；⚠️ user-service 侧 `http/x-admin.guard.ts:27-37` 是**只读版**（单挂得不到 actor 校验）⇒ 照 **currency-service 写面扩展版**（`currency-service/src/http/x-admin.guard.ts:42-73`）复制/扩展，或控制器内 `requireActor`——**择一写死并在卡内注明**（F8）；状态迁移 = ⚙️19（`unthrottle` **按旗校验**）；同事务：状态变更 + `risk_actions` 行；CSV 照 config-service `audit.controller.ts` 先例（BOM/消毒/文件名 `risk-actions-<ts>.csv`）。

- [ ] **Step 1: 单测先行（C19）**——reviews 列表过滤/keyset；详情形状（stats/devices 原文+others≤20/entries≤10/hits 两键/accountStatus/limitSource）；actions：五动作正例 × 状态迁移 × 审计行同事务、reason 缺/超长 ⇒ 400、非法源态 ⇒ 409、非法 action ⇒ 400、actor 缺 ⇒ 401 fail-closed、`unthrottle` 孤儿旗清理（条目 dismissed + 旗在 ⇒ 删旗）；CSV 头/消毒/附件名。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（挂 **currency-service 写面扩展版** guard（`currency-service/src/http/x-admin.guard.ts:42-73`）或控制器内 `requireActor`——**择一写死并注明**；⚠️ `user-service/src/http/x-admin.guard.ts:27-37` 是只读版，**单独挂得不到 actor 校验**，F8）。
- [ ] **Step 4: 真栈回归**——`curl` 经网关或直连 user-service（`X-Internal-Token` + `X-Admin:1` + `X-Admin-Actor: tester`）：建条目（复用 T5 演练数据）→ dismiss → ban → unban → 查 `risk_actions` 四行与 `users.status` 往返；读数入 progress。
- [ ] **Step 5: 跑 user-service 全测试确认绿**。
- [ ] **Step 6: 提交**——`feat(user): 风控管理端点（队列/详情/动作/审计读口）（风控 T6）`。

### Task 7: api-gateway

**Files:**
- Modify: `src/auth/admin-policy.ts`（P-r1..r4 插在 P7 与 P8 之间）· `src/gateway/proxy.gateway.ts`（下游握手 auth +`clientIp`；`verifyClient` session 校验**通过后**读封禁旗 ⇒ `rejectHandshake` + 尽力 `system.error 11003`）· `src/http/rate-limit.ts`（`THROTTLED_RATE_LIMIT` + 阈值参数化 + `isThrottled`（catch ⇒ false））· `src/http/http-rate-limit.middleware.ts`（用户维 peek）· `src/gateway/gateway.controller.ts`（四路由 + query 白名单）
- Test: `test/admin-policy.test.ts` · `test/http-rate-limit.test.ts` · proxy 相关测试 · gateway.controller 路由面测试

**Interfaces:**
- Produces: policy 4 条（逐字 = 规格 §2.9-3）；`isThrottled(redis, userId): Promise<boolean>`（旗读单独 try/catch ⇒ false + error 日志）；`auth: {userId, internalToken, traceId, clientIp?}`（`'unknown'`/缺 ⇒ 不注入）；flags 判定顺序 = 先 session 后封禁旗。
- Consumes: `clientIp` 取连接槽位对象（`wsConnSlotOf(client.request)?.ip`，rate-limit.ts:214-229 既有）。

- [ ] **Step 1: 单测先行**——policy：四条正反逐角色（operator/超管过；**viewer/finance 读被 403**——证未落 P8）；未登记写路径仍 403（P9 不变）；握手封禁：旗在 ⇒ reject + `11003`、旗无 ⇒ 放行、Redis 错 ⇒ 放行（catch）；`clientIp` 注入：槽位有 ip 则注、`'unknown'` 不注；限流档：旗在 ⇒ HTTP 3/1s（第 4 请求 429）、旗无 ⇒ 20/5s 原样、旗读错 ⇒ 走正常阈值（**不 503**）；既有 fail-closed 语义回归（模拟 Redis 错于正常判定 ⇒ 503/10007 不变量）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（policy 插入位置注释「读三条必须在 P8 之前——顺序敏感（F9）」；路由四端点 + 白名单 `status/limit/cursor/userId/action/actor/from/to`）。
- [ ] **Step 4: 真栈回归**——`docker compose build api-gateway && docker compose up -d --no-deps api-gateway`：真握手带旗/无旗两态（用 Redis 直写旗）；真 HTTP 档 3/1s 429；读数入 progress。
- [ ] **Step 5: 跑 api-gateway 全测试确认绿**。
- [ ] **Step 6: 提交**——`feat(gateway): 风控四条 policy + 握手封禁读旗 + 限流档 peek + clientIp 注入（风控 T7）`。

### Task 8: 客户端

**Files:**
- Modify: `apps/client/src/net/storage.ts`（KEYS +`DEVICE_ID: 'ftl.deviceId'` + `getDeviceId()`（读空即 `crypto.randomUUID()`（回落 `dev-<base36>`）并持久化；**不入 `clearSession`**））· `apps/client/src/pages/game/game.vue:142`（send 带 `deviceId: getDeviceId()`）· `apps/client/src/net/copy.ts`（`USER_BANNED` 文案 +「如有异议请联系客服」）
- Test: `apps/client/test/` 既有族（storage 用例）

**Interfaces:**
- Produces: `getDeviceId(): string`（跨登出/换号持久）。
- Consumes: 无（纯客户端）。

- [ ] **Step 1: 单测先行**——storage：首读生成并写入、二读同值；`clearSession` 后 deviceId **仍在**（关键负对照）；copy：11003 文案包含联系指引串。
- [ ] **Step 2: 跑测试确认红 → 实现 → 绿**（`pnpm --filter @fight-the-landlord/client test`）。
- [ ] **Step 3: 提交**——`feat(client): deviceId 持久化与随行 + 封禁文案（风控 T8）`。

### Task 9: 管理页（admin/）

**Files:**
- Modify: `admin/index.html`（顶栏 + 风控按钮 + 视图壳 + 审计第五页签按钮/面板）· `admin/app.js`（VIEWS +`risk`（roles super_admin/operator）；视图逻辑（队列表/详情/五动作+reason/刷新）；审计第五页签逻辑；`CONFIG_NOTES` +8 条；**字面量全族**：五视图→六视图（`index.html:17`、`app.js:193/:480/:531/:1680`）与页签（`app.js:30/:225/:1193/:1753`〔`:225` 写作「四个页签」——F6〕、`index.html:253`））· `admin/style.css`（如需）

**Interfaces:**
- Consumes: 四端点（T6）+ policy 角色（T7）；`accountStatus/limitSource` 驱动动作按钮可用性。
- 纪律：`textContent` 禁 innerHTML；只按 status 分流；401 回登录并清 DOM。

- [ ] **Step 1: 实现**（照既有视图形态；详情面板：stats/设备原文（含关联账号）/命中计数/条目历史；动作条：dismiss/throttle/unthrottle/ban/unban + reason 必填——前端校验为提示，服务端为准）。
- [ ] **Step 2: 静态核销**——`node --check admin/app.js`；手起静态页对照（本机 dev 栈）：五动作各走一遍真栈（读数入 progress）。
- [ ] **Step 3: 提交**——`feat(admin): 风控视图 + 审计第五页签 + CONFIG_NOTES 八条（风控 T9）`。

### Task 10: 监控素材

**Files:**
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（+`RiskScanStalled`/`MatchPredicateRejectionHigh` 逐字 = 规格 §2.12）
- Create: `deploy/monitoring/grafana/dashboards/06-risk.json`（uid `ftl-risk`、title `风控 / Risk`、五块：谓词拒绝（by predicate）/ 抽选轮与不成组 / 扫描（runs+last_success）/ 队列水位（risk_reviews_open）/ 处置计数（risk_actions_total））

**Interfaces:**
- Consumes: T2/T5/T6 指标名（逐字）。
- 注：面板真源=仓库 JSON（整目录 COPY 进镜像 ⇒ 改面板=发版）；slice-16 的 16→18 / 5→6 断言同步在 T11。

- [ ] **Step 1: 写规则与面板**（规则注解 `summary`/`runbook` 照既有条目形态；`expr` 逐字 = 规格 §2.12）。
- [ ] **Step 2: 语法闸**——`docker run --rm --entrypoint /bin/promtool -v "$PWD/deploy/monitoring/prometheus/rules:/r" prom/prometheus:v3.15.0 check rules /r/ftl-alerts.yml`（期望 `SUCCESS: 18 rules found`；⚠️ **v1.1.4 订正**：官方镜像 ENTRYPOINT=`/bin/prometheus`，须显式 `--entrypoint /bin/promtool`）+ `PYTHONUTF8=1 python -c "import json;json.load(open('deploy/monitoring/grafana/dashboards/06-risk.json'))"`（⚠️ Windows GBK 坑）；读数入 progress。
- [ ] **Step 3: 提交**——`feat(monitoring): 风控两条告警 + 06-risk 面板（风控 T10）`。

### Task 11: conformance `slice-20` + 既有片同步 + 基线

**Files:**
- Create: `tools/conformance/src/slices/slice-20-risk-control.ts`
- Modify: `tools/conformance/src/run.ts`（**CASES 真源 `:44`——F7：非 `src/index.ts`**）· `slices/slice-16-monitoring.ts`（`EXPECTED_RULES` 16→18 · `promtool … 16 rules found` ⇒ 18 · `/api/v1/rules` 恰 16+名集 ⇒ 18 · 面板五块名集 ⇒ 六块（含 `风控 / Risk`））· `slices/slice-18-gold-room.ts`（`:855-856` `adminKeys.length===17` ⇒ 25 + 注释 `:8/:818`）· `slices/slice-19-admin-rbac-audit.ts`（G12 针脚追加三串 `/api/admin/risk/reviews`、`/api/admin/risk/actions`、`/api/admin/risk/users/`）· `baselines.json`（新行 + slice-16 读数）

**Interfaces:**
- Consumes: 全部前序任务；slice-15 的 `compose({ENV}, 'up', '-d', '--no-deps', 'user-service')` 注入先例（用于 `RISK_SCAN_INTERVAL_MS`）。
- Produces: slice-20 九组断言（逐字 = 规格 §6.2）：①配置面 25 键+8 种子+非法写入 400 ②谓词组（开关对照：同 deviceId 二人永不同房 / 子集路径 30s / 落单兜底；关 ⇒ 正常成局；sameIp 同构）③数据链（入队 ⇒ 设备原文可见）④检测面（降阈 + 缩间隔重起 ⇒ 条目 ⇒ dismiss ⇒ 审计；重扫不复活）⑤限流档（手动 ⇒ 429 ⇒ 解除恢复）⑥封禁面（ban ⇒ 登录 403/11003 + 握手断开 ⇒ unban 恢复）⑦权限面（viewer/finance 403 vs operator 200）⑧审计面（列表 + CSV）⑨回归（records/mine 键集不含 deviceId）。

- [ ] **Step 1: 写 slice-20**（照 slice-19 形态：`step()` 分段、`checks.that`、清理/还原动作幂等；配置开关用例结束时**必须还原默认关**）。
- [ ] **Step 2: 同步既有片四处**（数字与名集）。
- [ ] **Step 3: 本机跑新片 + 被改片**——`pnpm --filter conformance …` 先单跑 `slice-20`、`slice-16`、`slice-18`（本机 dev 栈）；读数入 progress；baselines 暂不填，等 CI 权威轮回填（**CI 实测回填**口径）。
- [ ] **Step 4: 提交**——`test(conformance): slice-20 风控 + 既有片同步（风控 T11）`。

### Task 12: 文档同步（防文档谎报）

**Files:**
- Modify: `docs/design.md`（§8.3/§8.4 `[部分实现]` 标记与 R53/R475 注记回填 · §10.1 `match:rejected` 行「MVP 不写入」→ 已写入 · §7.5 键表 17→25 + `:142`「十七键」字样 · `:1492` 11003 行如涉文案）· `docs/client-protocol.md`（room.match payload +deviceId；11003 文案）· `docs/ops/first-deploy.md`（`:963` 键表 ⇒ 25；新增「风控谓词开启手顺」节）· `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`（P1′ 风控节标完成）· `docs/superpowers/plans/deviation-ledger.md`（**N58–N64 七条**：IP 不留存 / 申诉不做 / practice 排除 / 自动封禁不做 / `games > minGames` 边界 / **compose 两行测试注入 env**〔F12〕/ **N64 自动解除回迁 `open` 档置 `handled_by=system`**〔T5 裁决「准」新增〕）· `scripts/ledger-counts.mjs`

- [ ] **Step 1: 逐处改写**（凡被闸按原文扫描的文件——design.md 行——改完跑对应闸）。
- [ ] **Step 2: 联合残字扫描**——`grep -rn "十七键\|必填十七\|17 键\|五视图\|四个页签\|四页签" docs/ admin/ packages/ tools/ scripts/ | grep -v node_modules` 应只剩有意保留处（如历史修订记录）；读数入 progress（F6：五视图全族与「四个页签」变体一并覆盖）。
- [ ] **Step 3: 提交**——`docs(risk-control): 文档回填（design/协议/手册/路线图/偏离台账）（风控 T12）`。

### Task 13: 收口

- [ ] **Step 1: 真栈全链回归（A8）**——① deviceReport 全链：真客户端 H5（或 raw WS 带 deviceId）入队 ⇒ 设备落库 ⇒ `GET risk/users/:id` 可见；② 封禁四读点：ban ⇒ 新登录 403、真 WS 握手断开、入队 ack 11003、join ack 11003 ⇒ unban 全恢复；读数入 progress。
- [ ] **Step 2: 浏览器走查**——先跑 `npm run e2e:browser`（谓词默认关，预期 22/22 零影响）→ admin 风控视图实拍（队列/详情/五动作/审计第五页签/CSV 实开）+ 玩家 11003 文案观感。
- [ ] **Step 3: 六阶段整轮**——`pnpm run ci`（push 前**一次**）；红则按 `ci-flake-known` 先单跑判别，不「重跑直到绿」；读数入 progress。
- [ ] **Step 4: opus 整支终审**——派 opus 审查包（设计+规格+diff+台账）：找「最像正确但实际错」的点；findings 修复 → 复核。
- [ ] **Step 5: push + CI 权威轮**——协调者 push master；conformance 全序三 workflow 三绿；baselines 按 CI 实测回填（只抬不降）并再推一次（纯数据提交）。
- [ ] **Step 6: 交接文档**——`docs/superpowers/plans/2026-10-05-post-risk-control-handoff.md`（含：谓词开启手顺 = 先 `sameDevice` 观察一周再评估 `sameIp`；上线 = 用户打 tag；申诉复盘挂后续；Minor 池分诊）。
- [ ] **Step 7: 提交**——`docs(risk-control): 收口交接（风控 T13）`。

---

## 自审记录（writing-plans 自检）

1. **规格覆盖**：C1–C24 逐条有落点（C1–C6→T2 · C7–C8→T3/T4 · C9–C12→T3/T7 · C13–C15→T1/T4/T11 · C16–C18→T5 · C19→T6 · C20→T4 · C21–C22→T11 · C23→T3/T4/T11 · C24→T8/T9/T12）；A1–A8→T13；**§4.1 硬闸（规格 1–12）逐条有归属**：1–2→T1 · 3→T4 · 4→T3 · 5→T7 · 6→T2 · 7/9/10/12→T11 · 8→T9 · 11→已核不动；设计 §9.1 追加两项（#16 slice-16→T11 · #17 握手读旗→T7）；§4.2 文案面→T9/T12。**计划 r1（F1）曾指出 config 种子无落点——已修（并入 T1）；#3 三件套由 T4 承载（pattern 随接收侧同提交，F2；执行序 T4 先于 T3，A1）。**
2. **占位符扫描**：无 TBD/「适当处理」类表述；SQL 常量、键名、指标名、错误码全逐字；唯一「按实况修正」句 = T4 Step 4 的容器内命令（照 ③ T2 先例的实况修正纪律，非占位符）。
3. **类型一致性**：`MatchTicket.ip/deviceId`（T2）→ T3 meta 写点字段名 `ip`/`deviceId` 一致；`RiskClient.report`（T3）→ T4 接收侧 `RiskDeviceReportRequest` 一致；`DEVICE_UPSERT_SQL`/`RISK_UPSERT_LOCK_SQL` 常量名 T4/T5 定义 ↔ T5/T6 引用一致；`accountStatus/limitSource`（T6）↔ T9 消费一致；指标七名 T2/T4 定义 ↔ T10/T11 消费一致。

## 修订记录

- **v1.0**（2026-10-05）：首版（依据设计 v1.1.3 + 规格 v1.1.1 冻结本）。
- **v1.1**（2026-10-05）：**计划 r1 评审 14 条全数处置**（2🔴/4🟠/8🟡；报告 `.superpowers/sdd/2026-10-05-risk-control/review-plan-r1.md`）——**F1** config 种子迁移+两处测试同步并入 T1（含真库迁移演练步）· **F2** RPC pattern 移出 T1、随接收侧并入 T4 同提交（J21 键集合闸）· **F3** T2 补 C6 用例与 `:591` 起实现范围 · **F4** T5 降阈改域内合法组合（minGames=1 + 0.5 + 3 局 2 胜）· **F5** rng 改 `setRng()` 成例（不新增构造器形参）· **F6** 五视图/「四个页签」变体联扫 · **F7** conformance 入口改 `src/run.ts`（规格 v1.1.2 已订正）· **F8** T6 actor 先例带包名 + 写面扩展版指引 · **F9** 验表命令照 slice-15 先例 · **F10** 两处签名照实（MatchTicket / addToQueue 无 latency）· **F11** T2 Step 0 扩替身 · **F12** compose 两行注入面登记（规格 + 偏离台账六条）· **F13** T5 增真库双会话并发用例 · **F14** 谓词实现形对齐（规格 v1.1.2 已回填）。
- **v1.1.1**（2026-10-05）：**计划核验 8 条收口 → 计划冻结**——**A1** 依赖序订正（T3 依赖 +T4、T4 依赖改 T1——`risk.client` 需 T4 的 pattern，执行序 T4 先于 T3）· **A4** 对照表 T1 行补 config 种子 + 文件总览去重 · **A5** 总览 conformance 改 `run.ts` · **A6** T6 Step 3 写面 guard「择一写死」· **A7** 版本指针（本计划 v1.1.1；规格 v1.1.3）· **A8** 自审/对照表改指规格 §4.1 1–12（设计 §9.1 追加项单列）；A2/A3 随规格 v1.1.3（§8 env 口径 + 偏离六条）。
- **v1.1.2**（2026-10-05）：**T1 实施期订正一处**——T1 Step 1「`0.79` 与 `1.01` 拒」笔误（0.79 两位小数域内必须过）⇒ 照规格 §2.1-3 改「`0.79` 过 / `0.785` 拒 / `0.49`·`1.01` 拒」（实现 `5788f71` 已按规格落，测试同口径）。另登记 T1 实施发现：17 键硬名单断言全仓实为 **4 处**（+`admin.controller.test.ts:175`、`config.rpc.test.ts:54`）+ `robot.ts:7` 注释——均已随 T1 同提交同步（超计划清单范围，判据只增不减）。

## 执行方式

- 实现者 = 每任务一个 sonnet 子代理（任务卡 + Global Constraints + 规格点名节为全部输入）；**一任务一提交**；每 2–3 任务一波评审（审查者 sonnet、报告只写发现）；终审 opus。
- 迭代期只跑受影响包；六阶段只在 push 前跑一次；全序 conformance = CI 权威轮。
- 台账 `.superpowers/sdd/2026-10-05-risk-control/progress.md` 逐任务核销（读数 + 命令 + 提交哈希）。
