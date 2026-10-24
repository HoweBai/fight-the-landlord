# 记牌器「收费 + 服务端闸」实现计划 v1.1（计划审查后修订）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地「单局卡 + 包时卡」双商品收费、开局自动消费、服务端权威状态与客户端闸。**权威契约 = 规格 v1.1**（`docs/superpowers/specs/2026-10-18-card-counter-charge-gate-spec.md`）；设计 v0.5 的 §0.0 已明确覆盖 v0.4 的旧购买/错误码/财务文本。

**Architecture:** 购买在 currency-service（`applyWithEffect` 同一事务扣金币 + 发权益，扣款额 = 玩家确认价 `expectedPrice`）；开局在 room-service 状态块调 `currency.cardCounterConsume`（包时优先/单局卡/none），结果经 `match:events` 推 `game.card_counter`；客户端只按 `active` 渲染。免费场/好友房不消费；两价皆 0 = 金币场免费。

**计划审查处置（v1.0 → v1.1）：**
- A1：RPC pattern 移到 T8（接收侧同笔，J21）。
- A2：客户端 `messageTypeList` + `docs/client-protocol.md` + `docs/design.md` §6.3/§11.2 随 T2 同笔。
- A3/D1：设计升 v0.5 §0.0 覆盖清单。
- B1：`assertBool` 不存在 ⇒ 用 `typeof !== 'boolean'`。
- B2：T11 补 `ClientConfigState` 的 `Omit` + 13 处 `setClientConfig` 夹具。
- B3：T8 补 `rpc.test.ts` 4 处构造。
- B4：T7 加 `http/errors.ts` + `http-errors.test.ts`（三码 409）。
- B5/C1/C2：T7/T8 点名 `test/helpers/fake-currency-db.ts` 扩展。
- B6：T10 补 `announced()` 过滤 + 6 处 currency 桩。
- B7：resync 钉死「传 socket」。
- C3：未知态只落单测；slice-28 不构造停服。
- C4：slice-28 加「改价/关开关 + 同 requestId 重试」。
- C5：网关 401/200 正反例。
- C6：T12 加 14003 预检。
- C7/C8/C9/D5/D6：财务 DTO/符号/none、baselines full、build 命令、`isDuplicateEntryError` 措辞。

## Global Constraints

- **只在 `dev` 开发**；⛔ 不碰 `master`、不打 `v*` tag；部署只在用户说「部署」后走 `scripts/deploy/deploy-dev.sh`。
- 每个任务 TDD：先写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。
- 每个提交尾注：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 新配置键：`CONFIG_KEYS` 50→52；`CLIENT_CONFIG_KEYS` 18→20；管理面 52；`CONFIG_CONTROLS` 45→47；分类 17+1+29=47；下拉 13→14。
- 迁移时间戳：`1795800000000`（config）/ `1795900000000`（currency）；全仓唯一。
- 新 S→C 消息同批：`messages.ts` / `SERVER_MESSAGE_TYPES` / `ROOM_MESSAGES` / `validate.ts` / 客户端 `messageTypeList()` / `messages.test.ts` / `docs/client-protocol.md` / `docs/design.md` §6.3。
- 新错误码 **14008/14009/14010**；HTTP 409；`http/errors.ts` + `http-errors.test.ts` + `errors.test.ts` + `docs/design.md` §11.2 同批。
- J21：`RPC_PATTERNS` 键 ↔ `@MessagePattern` 接收侧 ↔ `*.module.ts` 注册 ↔ `messages.test.ts` 精确对象，**同一任务**（T8）。
- 钱路径：actionId 幂等、同事务、锁序 account→entitlements；假 DB 只钉控制流，真库判据落 slice-28。
- 真栈：`bash scripts/deploy/conformance-stack.sh up`；`pnpm --filter @fight-the-landlord/conformance build` 后 `node dist/run.js <case>`；不静默留下收费/临时配置态。
- 所有「跑了/绿了」的表述必须指向本次命令日志。

---

## 任务总览

| # | 任务 | 关键文件 |
|---|---|---|
| T1 | protocol：两个价格键（52/20） | `config.ts` + test |
| T2 | protocol：S→C / 错误码 / source / consume 契约 + 客户端清单 + 文档（**不含 RPC pattern**） | `messages.ts`/`validate.ts`/`errors.ts`/`currency.ts` + `socket.ts` 清单 + `docs/client-protocol.md` + `docs/design.md` + tests |
| T3 | config-service：组装 + 迁移 + 六夹具 | controller + 迁移 + tests |
| T4 | currency-service：配置读边 | `config/config-cache.service.ts` + test |
| T5 | currency-service：三表迁移 | 迁移 + test |
| T6 | currency-service：`applyWithEffect` + effect 拒绝类型 | `apply/apply.service.ts` + tests |
| T7 | currency-service：购买/状态端点 + 网关路由 + http 映射 + fake DB | `card-counter/*`、`http/errors.ts`、`gateway.controller.ts`、`app.module.ts`、`test/helpers/fake-currency-db.ts` + tests |
| T8 | currency-service：consume RPC + **RPC pattern 同笔** | `consume.service.ts`、`currency.rpc.controller.ts`、`rpc.module.ts`、`rpc.ts`、`messages.test.ts`、`rpc.test.ts`、fake DB + tests |
| T9 | room-service：配置读边 + stub | config cache + stub + test |
| T10 | room-service：状态块 + ccstate + match:events + 三条补发 | rooms.start/seats/service、ws.gateway、message.router、currency.client、metrics + tests |
| T11 | 客户端：共享配置 + store 两价 + **Omit/13 夹具** | `useClientConfig.ts`、store、lobby + tests |
| T12 | 客户端：开始页购买面板 + 购买流 + pending + 14003 | `game.vue`、rest、storage + tests |
| T13 | 客户端：牌桌判定表 + 状态消息处理 | table、session、useGameSession、store + tests |
| T14 | currency-service：财务五段 | `finance-query.service.ts` + tests |
| T15 | admin：两键 + 静态闸 + 财务块 + 下拉 | app.js、index.html、verify |
| T16 | conformance：存量片 + slice-28 + baselines | slices、run.ts、baselines |
| T17 | 代码审查 + 全量验证 + 收口 | — |

---

## T1 protocol 配置键

**Files:** `packages/protocol/src/config.ts`、`config.test.ts`.

- [ ] **Step 1: 写失败测试**：`CONFIG_KEYS` 末尾两键；`CLIENT_CONFIG_KEYS` 在 `cardCounterEnabled` 后两裸名；`parseConfigValue` 正反例（0/10/1e6 ✓；-1/1e6+1/1.5/'10' ✗）；键数 52/20。
- [ ] **Step 2: 跑红** `pnpm -C packages/protocol exec vitest run src/config.test.ts`
- [ ] **Step 3: 实现**：两键 + `parseCardCounterPrice(key, value)`（整数 0..1e6，消息含键名/值）+ `ClientConfig` 两字段。
- [ ] **Step 4: 跑绿** 同 Step 2。
- [ ] **Step 5: 提交** `feat(protocol): 新增记牌器两价格键（第 51/52 键）`

---

## T2 protocol 消息 / 错误码 / source / consume 契约 + 客户端清单 + 文档

**Files:** `messages.ts`、`validate.ts`、`errors.ts`、`currency.ts` + tests；`apps/client/src/net/socket.ts`（清单导出+新项）；`docs/client-protocol.md`；`docs/design.md`（§6.3 消息表、§11.2 错误码表）。

- [ ] **Step 1: 写失败测试**
  - `messages.test.ts`：S→C 11→12；`ROOM_MESSAGES` 含 `game.card_counter`。
  - `validate.test.ts`（或 messages.test）：`validateOutbound` 正反例——roomCode 非字符串、active 非布尔、source 非法值各抛；合法通过（**运行期 default 是唯一穷尽兜底**）。
  - `errors.test.ts`：SPEC_CODES 含 14008/14009/14010；CLIENT_ACTION 均 TOAST。
  - `currency.test.ts`：source 13；`validateCurrencyCardCounterConsume` 正反例。
  - 客户端清单：`messageTypeList()` 导出且与 `SERVER_MESSAGE_TYPES` 按集合相等（**该断言在 T13 加，但 T2 先导出并加项**）。
- [ ] **Step 2: 跑红** `pnpm -C packages/protocol exec vitest run src/messages.test.ts src/errors.test.ts src/currency.test.ts`
- [ ] **Step 3: 实现**
  - `messages.ts`：S→C 类型 + 两清单。
  - `validate.ts`：
    ```ts
    case 'game.card_counter': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertStr(p.roomCode, '$.payload.roomCode');
      if (typeof p.active !== 'boolean') throw new ProtocolError('$.payload.active must be a boolean');
      if (p.source !== undefined && !['pass','credit','none','unknown'].includes(p.source as string)) {
        throw new ProtocolError("$.payload.source must be 'pass'|'credit'|'none'|'unknown'");
      }
      break;
    }
    ```
  - `errors.ts`：14008/14009/14010 + CLIENT_ACTION。
  - `currency.ts`：source + consume request/response 类型 + `validateCurrencyCardCounterConsume`（roomCode 1..16、ownerId 1..36、seat 0..2、meta 可选）。
  - 客户端 `socket.ts`：导出 `messageTypeList`，加入 `game.card_counter`。
  - `docs/client-protocol.md`：消息表 + 错误码表；`docs/design.md` §6.3 + §11.2（14xxx 段补三码，注明 14006/14007 既有记录行态语义不变）。
- [ ] **Step 4: 跑绿** 同 Step 2 + `pnpm -C apps/client exec vitest run test/protocol-doc-sync.test.ts`。
- [ ] **Step 5: 提交** `feat(protocol+client): 记牌器 S→C/错误码/consume 契约与文档`

---

## T3 config-service 组装 + 迁移

**Files:** `client-config.controller.ts`、`migrations/CardCounterPrices1795800000000.ts`、六夹具测试。

- [ ] **Step 1: 写失败测试**：20 键/值 10/100/缺行默认；迁移一条 `INSERT IGNORE` + 两元组、down 两删、时间戳唯一。
- [ ] **Step 2: 跑红** `pnpm -C packages/config-service exec vitest run test/client-config.test.ts test/migration.test.ts`
- [ ] **Step 3: 实现**：controller 两字段（默认 10/100）；迁移两键。
- [ ] **Step 4: 跑绿** 同包六测试。
- [ ] **Step 5: 提交** `feat(config-service): 下发记牌器两价格键（种子 10/100）`

---

## T4 currency-service 配置读边

**Files:** `config/config-cache.service.ts` + `test/config-cache.test.ts`.

- [ ] **Step 1: 写失败测试**：enabled 缺/坏 false；prices 缺/坏/越界 10/100；正常透传；hasSnapshot 不变。
- [ ] **Step 2: 跑红** `pnpm -C packages/currency-service exec vitest run test/config-cache.test.ts`
- [ ] **Step 3: 实现**：`cardCounterEnabled()` / `cardCounterPrices()`（范围哨兵 0..1e6）。
- [ ] **Step 4: 跑绿** 同 Step 2。
- [ ] **Step 5: 提交** `feat(currency-service): 配置读边 cardCounterEnabled/Prices`

---

## T5 currency-service 三表迁移

**Files:** `migrations/CardCounterEntitlements1795900000000.ts`、`test/migration.test.ts`.

- [ ] **Step 1: 写失败测试**：三表 DDL 逐字（列/索引/唯一/ENGINE/CHARSET）；down 三 DROP；类名不匹配 `/^Currency\d+$/`；时间戳唯一。
- [ ] **Step 2: 跑红** `pnpm -C packages/currency-service exec vitest run test/migration.test.ts`
- [ ] **Step 3: 实现**：照设计 §3.3.1/规格 §2.4a。
- [ ] **Step 4: 跑绿** 同 Step 2。
- [ ] **Step 5: 提交** `feat(currency-service): 记牌器权益/购买/消费三表`

---

## T6 applyWithEffect 因子化

**Files:** `apply/apply.service.ts`、`test/apply.test.ts`.

- [ ] **Step 1: 写失败测试**
  - `apply ≡ applyWithEffect(noop)`；
  - effect 在 flows 后、commit 前；
  - `ApplyEffectRejectError(14008)` ⇒ `{ok:false,code:14008}` + 账户/ops/flows 回滚；
  - 重放 ⇒ effect 不执行；
  - 合成非 `uk_action_id` 的 1062 ⇒ 不进 replay（抛系统错）。
- [ ] **Step 2: 跑红** `pnpm -C packages/currency-service exec vitest run test/apply.test.ts`
- [ ] **Step 3: 实现**
  - 导出 `ApplyEffect`/`ApplyEffectRejectError`；`apply` 委托 `applyWithEffect(req, noop)`；事务内 flows 后 `await effect(manager)`；catch 两类拒绝同姿态。
  - `isDuplicateEntryError`：**只有 1062/ER_DUP_ENTRY 且 message 含 `uk_action_id`** 才算撞键；其余 1062 抛系统错。
- [ ] **Step 4: 跑绿** 同 Step 2 + `test/apply.concurrency.test.ts`。
- [ ] **Step 5: 提交** `refactor(currency): applyWithEffect 同事务钩子 + effect 拒绝类型`

---

## T7 购买/状态端点 + 网关路由 + HTTP 映射 + fake DB

**Files:** 新增 `card-counter/card-counter.service.ts`、`card-counter.controller.ts`；改 `app.module.ts`、`http/errors.ts`、`packages/api-gateway/src/gateway/gateway.controller.ts`、`test/helpers/fake-currency-db.ts`；测试 `test/card-counter.test.ts`、`test/http-errors.test.ts`。

- [ ] **Step 1: 写失败测试**
  - **fake DB 扩展**：purchases/entitlements 行表 + 精确 SQL 形状（INSERT purchases、entitlement upsert、SELECT purchase by action_id、SELECT entitlement、余额读）；未识别 SQL 仍 reject。
  - 鉴权：两端点缺/空 `X-User-Id` ⇒ 10002/401。
  - 形状校验（kind/hours/requestId `[A-Za-z0-9_-]{1,64}`/expectedPrice **正整数 1..1e6**）。
  - 新单：`applyWithEffect` 参数逐字段（`delta:-expectedPrice`、reason `cardcounter:game|cardcounter:hour:<n>`、meta.traceId）；effect 内 master/服务端价 0 ⇒ 14008、expectedPrice≠服务端价 ⇒ 14009、hasSnapshot false ⇒ 10007；**失败零扣款/零权益/零 purchases**。
  - 重放：同 kind/hours ⇒ 行内历史价 + 当前余额；异 ⇒ 14010；行缺失 ⇒ 10007。
  - purchases 行逐字段（game: hours NULL/credits 1；hour: hours n/credits NULL）。
  - HTTP 映射：14008/14009/14010 ⇒ 409；14001 ⇒ 409；10001 ⇒ 400；10007 ⇒ 503（`http-errors.test.ts`）。
  - 状态端点无行 ⇒ 0/null、零 INSERT。
- [ ] **Step 2: 跑红** `pnpm -C packages/currency-service exec vitest run test/card-counter.test.ts test/http-errors.test.ts`
- [ ] **Step 3: 实现**
  - `CardCounterService`（注入 `ApplyService`、`DataSource`、`ConfigCacheService`）：
    - `buy`：形状校验 → `applyWithEffect({ actionId, source:'card_counter', entries:[{ownerId, delta:-expectedPrice}], refId:userId, reason, meta:{traceId} }, effect)` → 结果分支/响应。
    - effect（同一 manager）：hasSnapshot → master/serverPrice（14008）→ expectedPrice===serverPrice（14009）→ INSERT purchases → upsert entitlements（game credits+1；hour `DATE_ADD(GREATEST(COALESCE(pass_expires_at,NOW(3)),NOW(3)),INTERVAL ? HOUR)`）。
    - 重放/14002：读 purchase by action_id，kind/hours 校验；响应 `balanceAfter` 读当前账户；`passExpiresAt` 转 epoch ms。
    - 日志 `card_counter.purchase`（成功/14001/10007）。
  - 控制器 + AppModule 注册；网关两路由（默认验签）。
  - `http/errors.ts` 三码 409 + 测试。
- [ ] **Step 4: 跑绿** 同 Step 2 + `pnpm -C packages/api-gateway test`（路由/白名单）。
- [ ] **Step 5: 提交** `feat(currency+gateway): 记牌器购买/状态端点`

---

## T8 consume RPC + RPC pattern 同笔

**Files:** 新增 `card-counter/consume.service.ts`；改 `rpc/currency.rpc.controller.ts`、`rpc/rpc.module.ts`、`packages/protocol/src/rpc.ts`、`messages.test.ts`、`test/rpc.test.ts`、`test/helpers/fake-currency-db.ts`；测试 `test/card-counter-consume.test.ts`。

- [ ] **Step 1: 写失败测试**
  - **RPC pattern 同笔**：`RPC_PATTERNS.currencyCardCounterConsume` + `messages.test.ts` 精确对象 +1；J21 门禁。
  - `rpc.test.ts` 4 处 `new CurrencyRpcController(...)` 补第 4 参 + 新 pattern 元数据断言。
  - fake DB：consumptions/entitlements 行表、`uk_cc_consume_room_owner` 1062 注入、`FOR UPDATE` 形状、第二会话注入。
  - consume：pass 优先/credit−1/none；同房幂等；1062 回读首笔；无 entitlement 行并发；meta.traceId 落行。
- [ ] **Step 2: 跑红** `pnpm -C packages/currency-service exec vitest run test/card-counter-consume.test.ts test/rpc.test.ts`
- [ ] **Step 3: 实现**
  - `ConsumeService.consume(dto)`：validate → 事务（锁 entitlement → 查 consumption → pass/credit/none → INSERT）→ 1062 回滚后新事务读首笔。
  - RPC controller 第 4 个 `@MessagePattern`；rpc.module provider。
  - `rpc.ts` pattern + `messages.test.ts` 精确对象（**同一提交**）。
- [ ] **Step 4: 跑绿** 同 Step 2 + `pnpm -C packages/protocol test`。
- [ ] **Step 5: 提交** `feat(currency+protocol): currency.cardCounterConsume`

---

## T9 room-service 配置读边 + stub

**Files:** `config/config-cache.service.ts`、`test/helpers/config-cache.stub.ts`、`test/config-cache.test.ts`.

- [ ] **Step 1-4**：enabled 缺/坏 false；prices 缺/坏/越界 10/100；stub 两 getter；跑 `pnpm -C packages/room-service exec vitest run test/config-cache.test.ts`。
- [ ] **Step 5: 提交** `feat(room): 记牌器配置读边`

---

## T10 room-service 状态块 + 推送 + 重连

**Files:** `rooms/rooms.start.ts`、`rooms/rooms.seats.ts`、`rooms/rooms.service.ts`、`gateway/ws.gateway.ts`、`gateway/message.router.ts`、`currency/currency.client.ts`、`metrics/room.metrics.ts`；测试 `test/rooms.card-counter.test.ts`（新）、`test/rooms.start.test.ts`、`test/ws.gateway.test.ts`、`test/message.router.test.ts`、`test/currency.client.test.ts`。

- [ ] **Step 1: 写失败测试**
  - **既有夹具**：`rooms.start.test.ts:147` 的 `announced()` 改为只过滤 `event==='room.matched'`（保留机器人不发 matched 的精确判据）；`rooms.start.test.ts:89`、`rooms.entry-fee.test.ts:82`、`match.service.test.ts` 6 处 currency 桩补 `cardCounterConsume`。
  - `ok=false` ⇒ 零 consume/零写/零发布；非 gold 且 ok ⇒ 状态块执行；master 关/两价 0/收费态；单键 0（商品隐藏、已有权益仍消费）；机器人零调用。
  - consume 逐位 `Promise.all`；ccstate 形状/TTL/deleteRoom/(room,seat,userId) 复核。
  - `match:events` 判别键 `event` + 分支在 seats 循环前。
  - **resync 钉死**：`handleResync(socket, deps, userId)`（把 socket 传入）；三条补发。
  - `currency.client`：10007/传输重试 ≤1；业务码不重试；成功一次。
- [ ] **Step 2: 跑红** `pnpm -C packages/room-service exec vitest run test/rooms.card-counter.test.ts`
- [ ] **Step 3: 实现**
  - `rooms.start.ts`：`ok` 后 `Promise.all([gold?chargeEntryFees:noop, updateCardCounterStatuses(...)])`；状态块 catch 边界覆盖整个 `Promise.all`。
  - `rooms.seats.ts` `ccstateKey`；`rooms.service.ts` deleteRoom 加入。
  - `ws.gateway.ts` `MatchEvent` 加 `{event:'card_counter',...}` + 分支。
  - `message.router.ts` resync 传 socket；三条补发。
  - `currency.client.ts` consume + 重试；metrics/日志。
- [ ] **Step 4: 跑绿** 同 Step 2 + 相关既有测试。
- [ ] **Step 5: 提交** `feat(room): 开局记牌器状态块/推送/重连补发`

---

## T11 客户端共享配置 + store + lobby + Omit/夹具

**Files:** `apps/client/src/composables/useClientConfig.ts`（新）、`stores/game.ts`、`pages/lobby/lobby.vue`；测试 `test/client-config-shared.test.ts`（新）+ 13 处 `setClientConfig` 夹具。

- [ ] **Step 1: 写失败测试**：两价 `number|null`；缺键/失败兜底 null；共享归一化；`ClientConfigState` 的 `Omit` 含两键。
- [ ] **Step 2: 跑红** `pnpm -C apps/client exec vitest run test/client-config-shared.test.ts`
- [ ] **Step 3: 实现**：抽 `useClientConfig`；store `Omit` + 两字段；lobby 引用；**更新 13 处 `setClientConfig({...})` 字面量**（`auth-ui-wiring`/`base-score-selection`/`lobby-ux`/`table-center`/`wallet-entry`/`wallet-page`）。
- [ ] **Step 4: 跑绿** 同 Step 2 + 既有 lobby 测试。
- [ ] **Step 5: 提交** `refactor(client): 共享客户端配置加载/归一化`

---

## T12 客户端开始页购买面板 + 购买流 + 14003

**Files:** `pages/game/game.vue`、`net/rest.ts`、`net/storage.ts`；测试 `test/card-counter-purchase.test.ts`.

- [ ] **Step 1: 写失败测试**：面板条件/旧服务端/单键 0/两价 0；挂载 status；确认/pending/同号重试/14009 刷新/14010 新号/14001/14008；成功回写；`clearSession` 清除；跨用户不复用；`matching` 禁用；**14003 预检**（`walletBalance - price < selectedBaseScore × entryMultiplier` ⇒ 警示/禁用）。
- [ ] **Step 2: 跑红** `pnpm -C apps/client exec vitest run test/card-counter-purchase.test.ts`
- [ ] **Step 3: 实现**：rest 两方法；storage pending（userId/24h）；game.vue 面板（`.game__match` 外）；确认 modal；错误通道。
- [ ] **Step 4: 跑绿** 同 Step 2 + 既有 game 测试。
- [ ] **Step 5: 提交** `feat(client): 开始页记牌器购买面板与购买流`

---

## T13 客户端牌桌判定表 + 状态消息

**Files:** `pages/table/table.vue`、`net/session.ts`、`composables/useGameSession.ts`、`stores/game.ts`；测试 `test/card-counter-charge-gate.test.ts`（新）、`test/protocol-doc-sync.test.ts`.

- [ ] **Step 1: 写失败测试**：判定表四行（显式覆盖新服务端+无状态 ⇒ 不渲染）；入口+横条 gate；active=false 关横条；按 roomCode、不走 version 幂等；reset/换房清；消息处理器；`messageTypeList` 按集合相等（T2 已导出/加项）。
- [ ] **Step 2: 跑红** `pnpm -C apps/client exec vitest run test/card-counter-charge-gate.test.ts`
- [ ] **Step 3: 实现**：store 状态 + `applyCardCounterStatus`；session `client.on('game.card_counter')` + options 回调（**不改 classify**，显式处理）；table gate；横条关闭。
- [ ] **Step 4: 跑绿** 同 Step 2 + `test/protocol-doc-sync.test.ts` + `test/card-counter*.test.ts`。
- [ ] **Step 5: 提交** `feat(client): 记牌器服务端状态门控`

---

## T14 currency-service 财务五段

**Files:** `admin/finance-query.service.ts`、`admin/admin-finance.controller.ts`（如需）、`test/admin-finance.test.ts`.

- [ ] **Step 1: 写失败测试**：两条新 SQL 逐字；次序 group→burn→skips→purchases→consumptions；零窗 0；DTO 形状（purchases: game/hour 两行固定；consumptions: pass/credit/none 固定三行）；**符号**（source 行=钱包变动负；购买块=收入正）；**none 口径**；`db.queries` 精确列表 5 条；响应全等。
- [ ] **Step 2: 跑红** `pnpm -C packages/currency-service exec vitest run test/admin-finance.test.ts`
- [ ] **Step 3: 实现**：两 SQL + `SummaryResult` 两字段 + controller 直通。
- [ ] **Step 4: 跑绿** 同 Step 2 + 全部 admin-finance 测试。
- [ ] **Step 5: 提交** `feat(currency): 财务汇总记牌器购买/使用块`

---

## T15 admin 两键 + 静态闸 + 财务块 + 下拉

**Files:** `admin/app.js`、`admin/index.html`、`scripts/verify-admin-static.mjs`.

- [ ] **Step 1: 静态闸改目标（红）**：52/52/47/17+1+29/下拉 14；`NUMBER_SUFFIX` 两键；G12 针脚加购买/使用块（与 slice-19 G12 同笔）。
- [ ] **Step 2: 跑红** `pnpm verify:admin`
- [ ] **Step 3: 实现**：CONFIG_IA assist +2；CONFIG_CONTROLS 两 number/suffix；CONFIG_NOTES 两条；财务块渲染（容忍 T14 字段缺失）；index.html 下拉 +1；注释计数同步。
- [ ] **Step 4: 跑绿** `pnpm verify:admin`
- [ ] **Step 5: 提交** `feat(admin): 记牌器价格配置与财务块`

---

## T16 conformance 存量片 + slice-28

**Files:** `tools/conformance/src/slices/{slice-14,17,18,19,21,22,23,24,25}*.ts`、新增 `slice-28-card-counter.ts`、`run.ts`、`baselines.json`、`tools/conformance/src/slices/slice-19-admin-rbac-audit.ts`（G12）。

- [ ] **Step 1: 存量片按终态改字面（改后即绿；红只可能来自实现未同步）**：18→20（slice-14/17/18/21/23/24）；50→52（slice-18/22/23/24）；下拉 14（slice-19）；slice-17 迁移 4 行/名；G12 针脚同笔。
- [ ] **Step 2: 新片**：购买成功/重放/**改价或关开关后同 requestId 重试 ⇒ 重放成功、行内价/余额不变**/不足/并发同号/并发异号/包时/单局/无权益/消费幂等；**未知态只落 room-service 单测，不在真栈构造停服**；管理调账供金币；RUN_TAG；清理（价格还原）。
- [ ] **Step 3: 注册/基线**：`run.ts` 注册；`baselines.json` **只回填 full 列**；`pnpm --filter @fight-the-landlord/conformance build` 后 `node dist/run.js <case>`。
- [ ] **Step 4: 跑相关片**：`bash scripts/deploy/conformance-stack.sh up` 后 slice-14/17/18/19/21/22/23/24/25/28。
- [ ] **Step 5: 提交** `test(conformance): 记牌器收费真栈片 + 键面同步`

---

## T17 代码审查 + 全量验证 + 收口

- [ ] 独立 code review（sonnet）审 `BASE..HEAD`，对照 spec/plan；Critical/Important 必修。
- [ ] 七包：`pnpm -C packages/protocol test`、`packages/config-service test`、`packages/currency-service test`、`packages/room-service test`、`packages/api-gateway test`、`apps/client test`、`apps/client run lint`、`pnpm verify:admin`；另 `packages/shared test`（若动）。
- [ ] `pnpm exec turbo run test lint --force`（Cached 不算真跑）。
- [ ] `bash scripts/deploy/conformance-stack.sh up`；相关片 + **全序一次**（保存日志）。
- [ ] **文档对账**：`docs/design.md` §6.3/§4.2/§7.5/§11.2 与契约逐字；`docs/client-protocol.md`。
- [ ] `git status --short` 干净；偏差/窗口回填规格；交付报告（提交 SHA、证据、边界）。
- [ ] 提交收尾（如有修复）。

---

## 回归命令与预期

| 命令 | 预期 |
|---|---|
| `pnpm -C packages/protocol test` | 全绿 |
| `pnpm -C packages/config-service test` | 全绿 |
| `pnpm -C packages/currency-service test` | 全绿 |
| `pnpm -C packages/room-service test` | 全绿 |
| `pnpm -C packages/api-gateway test` | 全绿 |
| `pnpm -C apps/client test` + `run lint` | 全绿 |
| `pnpm verify:admin` | 52/47/17+1+29/14 全绿 |
| conformance slice-28 + 相关片 + 全序 | 全绿（真实证据入报告） |
