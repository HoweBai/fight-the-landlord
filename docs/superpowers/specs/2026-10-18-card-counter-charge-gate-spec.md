# 记牌器「收费 + 服务端闸」—— 规格 v1.1（规格审查后修订）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-18 |
| 设计层 | `docs/superpowers/specs/2026-10-18-card-counter-charge-gate-design.md` **v0.4**（两轮设计审查后） |
| 用户裁决 | ①按局、包时都要 ②首发 10 金币/局、100 金币/小时，可配置 ③货币不足不开通（除非免费）④仅开局前购买，购买后进入对局自动生效 |
| 规格审查 | v1.0 独立对抗审查（sonnet）：3 阻断（B1 幂等 TOCTOU / B2 currency 配置读边缺失 / B3 真库载体缺失）+ 25 高项；本稿逐条处置 |
| §10 口径 | 设计 §10 四条按默认执行（包时自购买起算、两价皆 0 免费、面板在开始游戏页、上线顺序 config→currency→room→gateway→client） |
| 上游真源 | `startRoom`/`startAndAnnounce` · `currency.apply` 唯一写边 · `currencyApplyHash` · `validateOutbound` · `/api/config` 键表 · `match:events` |

---

## 0. 承接（设计决定 → 判据）

| 设计决定 | 落点 | 判据 |
|---|---|---|
| D1 双商品 | §2.4/§2.5 | C16、C20 |
| D2 仅金币场消费 | §2.4 | C24、C28 |
| D3 两价格键（10/100） | §2.1/§2.2 | C1–C5、C32 |
| D4 仅开局前购买/自动生效 | §2.4/§2.7 | C24、C34 |
| D5 购买原子 + 幂等优先 | §2.4 | C10–C17 |
| D6 不足不开通 / 免费 | §2.4 | C13、C15、C24 |
| D7 不退款/包时起算 | §2.4 | C16 |
| D8 服务端权威状态 | §2.4/§2.7 | C26、C30、C35 |
| D9 老客户端软闸 | 边界 | C35 回退行 |
| D10 客户端 fail-closed | §2.7 | C35 |
| D11 观测（无新增 skip 表） | §2.5/§2.9 | C17、C22、C37–C39 |
| D12 管理面两键 | §2.2/§2.9 | C4、C39 |
| D13 键面/迁移 | §2.1–§2.4 | C1–C7、C40 |
| D14 协议/网关 | §2.1/§2.4/§2.5 | C18、C30、C31 |
| D15 expectedPrice | §2.4 | C13 |
| D16 消费未知态 | §2.5 | C21 |
| D17 免费态/单键 0 | §2.4/§2.7 | C24、C33 |
| D18 新错误码 14008–14010 | §2.1 | C31 |
| D19 上线顺序/杀开关 | §3 | C40 |
| D20 epoch ms / DB 时间 | §2.4/§2.5 | C16、C22、C27 |

---

## 1. 改动面一览

**新增文件**

| 文件 | 内容 |
|---|---|
| `packages/config-service/src/migrations/CardCounterPrices1795800000000.ts` | 两键种子（10/100） |
| `packages/currency-service/src/migrations/CardCounterEntitlements1795900000000.ts` | 三表 |
| `packages/currency-service/src/card-counter/{card-counter.service,card-counter.controller,consume.service}.ts` | 购买/状态/消费 |
| `apps/client/src/composables/useClientConfig.ts` | 共享配置加载/归一化 |
| `tools/conformance/src/slices/slice-28-card-counter.ts` | 真栈组（编号已核：slice-27 为现有最大） |

**修改文件**：protocol（config/messages/validate/currency/errors/rpc + 测试）、config-service（组装 + 六夹具）、currency-service（apply 因子化 + **config cache 两 reader** + finance + http/errors + 模块 + 测试）、room-service（rooms.start/rooms.service/rooms.seats/ws.gateway/message.router/config-cache/currency.client/metrics + 测试）、api-gateway（两路由）、admin（app.js/index.html/verify-admin-static）、客户端（store/lobby/game/table/net + 测试）、conformance 存量片 + `run.ts` + `baselines.json`、`docs/design.md`（§6.3/§4.2/§7.5/§11.2）、`docs/client-protocol.md`。

---

## 2. 逐层契约

### 2.1 protocol

**a) 配置键（第 51/52）**

- `CONFIG_KEYS` 尾追 `'game.cardCounterPricePerGameCoins'`、`'game.cardCounterPricePerHourCoins'`（50→52）。
- 校验：整数 `0..1,000,000`；拒字符串/小数/负数/越界（消息含键名与收到值，测试断言）。
- `CLIENT_CONFIG_KEYS` 追加裸名（18→20）：`cardCounterEnabled` → `cardCounterPricePerGameCoins` → `cardCounterPricePerHourCoins` → `version`。
- `ClientConfig` 两个 number 字段。

**b) 消息**

- 不改 `room.match`。
- 新增 S→C（version 0）：
  ```ts
  | { type: 'game.card_counter'; version: 0; payload: {
      roomCode: string;
      active: boolean;
      source?: 'pass' | 'credit' | 'none' | 'unknown';
    } }
  ```
- `SERVER_MESSAGE_TYPES` 11→12；`ROOM_MESSAGES` 加入；`validateOutbound` case（roomCode string、active boolean、source 可选枚举）；**运行期 default 是唯一穷尽兜底**（`type as never` 不会让编译失败——审查低项 8）。
- 客户端 `messageTypeList()` 加入并**导出**；测试按**集合**相等（不按数组顺序）。

**c) 货币与错误码**

- `CURRENCY_SOURCES` 尾追 `'card_counter'`（12→13）。
- 新错误码（**避开 design.md 已占用的 14006/14007**）：
  - `E_CARD_COUNTER_UNAVAILABLE = 14008`（总开关关/商品价 0/未开放）
  - `E_CARD_COUNTER_PRICE_CHANGED = 14009`
  - `E_CARD_COUNTER_REQUEST_CONFLICT = 14010`（同 requestId 异 kind/hours）
- `errors.test.ts` SPEC_CODES、`CLIENT_ACTION`（均 TOAST）、`docs/client-protocol.md`、**`docs/design.md` §11.2 表 + 14xxx 段**同批。
- HTTP 映射（currency-service `http/errors.ts`）：三码 → **409**；`http-errors.test.ts` 逐条。

**d) RPC**

- `RPC_PATTERNS.currencyCardCounterConsume`；`validateCurrencyCardCounterConsume`（roomCode 1..16、ownerId 1..36、seat 可选 0..2、`meta?`）。
- `messages.test.ts` pattern 精确对象同批。

### 2.2 config-service 与 admin

- `client-config.controller.ts` 增两字段；缺行默认 **10/100**；响应恒 20 键。
- 迁移 `CardCounterPrices1795800000000`：一条 `INSERT IGNORE` + 两个 VALUES 元组（10/100、version 1、seed）；`down()` 精确删两键；时间戳 > 1795700000000 且全仓唯一。
- 六夹具/精确清单同步。
- admin：两键入「斗地主 → 对局辅助」；两个数字控件（label：记牌器单局价/包时价；suffix：金币/局、金币/小时）；notes 含 0 语义/改价范围/旧客户端/总开关/上线手顺；`verify-admin-static` **50→52**、45→47、17+1+29=47、下拉 14；app.js 注释同步。
- 财务下拉 `admin/index.html` + `verify-admin-static:105-111` + slice-19:1484 + slice-14/17 的 18→20 字面。

### 2.3 currency-service 配置读边（B2 阻断修复）

- `packages/currency-service/src/config/config-cache.service.ts` 新增：
  - `cardCounterEnabled(): boolean` —— 缺行/坏 ⇒ **false**；
  - `cardCounterPrices(): { perGame: number; perHour: number }` —— 缺行/坏/越界 ⇒ **10/100**（`0..1e6` 整数范围哨兵）；
  - `hasSnapshot()` 沿用。
- **购买新单**（effect 内）：`hasSnapshot() === false` ⇒ `ApplyEffectRejectError(UPSTREAM_UNAVAILABLE)`（10007/503，**不收费**）。
- room 与 currency 两侧默认值同表对照（测试钉住）：enabled=false、perGame=10、perHour=100。

### 2.4 currency-service 购买（B1/B1b 阻断修复）

**a) 表（`CardCounterEntitlements1795900000000`）**

三表逐字照设计 v0.4 §3.3.1（entitlements/purchases/consumptions），含 `created_at` 索引；consumptions 含 `seat/trace_id`。类名不匹配 `/^Currency\d+$/`。

**b) `applyWithEffect` 因子化（钱核心）**

- 导出公开类型：
  ```ts
  export type ApplyEffect = (manager: EntityManager) => Promise<void>;
  export class ApplyEffectRejectError extends Error {
    constructor(readonly code: ErrCode, message: string) { super(message); this.name = 'ApplyEffectRejectError'; }
  }
  async apply(req: unknown): Promise<CurrencyApplyResponse>;                 // ≡ applyWithEffect(req, noop)
  async applyWithEffect(req: unknown, effect: ApplyEffect): Promise<CurrencyApplyResponse>;
  ```
- `apply` 与 `applyWithEffect` 共用校验/事务体/重放/指标/日志/写穿；**禁止第二份事务体**。
- effect 在 flows 写完之后、commit 之前，用**同一 `EntityManager`**；`ApplyEffectRejectError` 被捕获 ⇒ 整批回滚 + `{ok:false, code, message}`（与 `ApplyRejectError` 同姿态）；其它异常抛穿（系统级）。
- 重放分支不执行 effect；**撞键判定收紧到 `uk_action_id`**（`isDuplicateEntryError` 只认 actionId 索引/message；其它 1062 ⇒ 系统错，不得进 replay）。
- 锁序：account（apply 余额步）→ entitlements（effect）；effect 只使用传入 manager；consume 只锁 entitlements。

**c) `POST /api/card-counter/purchase`（次序钉死）**

1. **只做形状校验**：`kind`、`hours`（仅 hour，1..8）、`requestId [A-Za-z0-9_-]{1,64}`、`expectedPrice`（**正整数 1..1,000,000**）；game 拒 hours；hour 必填 hours。失败 ⇒ 10001。
2. `actionId='cardcounter:<userId>:<requestId>'`；直接调 `applyWithEffect`（**不在外部做任何当前态校验**——B1 的 TOCTOU 修复）。
   - **扣款额 = 玩家确认价 `expectedPrice`**（`entries=[{ownerId, delta:-expectedPrice}]`）；服务端**绝不**按自己读到的价去扣一个玩家没确认过的金额。
3. effect（同一事务内，次序钉死）：
   a. `hasSnapshot() === false` ⇒ `ApplyEffectRejectError(10007)`；
   b. `master = cardCounterEnabled()`；`serverPrice = kind==='game' ? perGame : perHour * hours`；
   c. `master === false || serverPrice === 0` ⇒ `ApplyEffectRejectError(14008)`；
   d. `expectedPrice !== serverPrice` ⇒ `ApplyEffectRejectError(14009)`（玩家看到价与服务端当前价不符；整批回滚，不改钱）；
   e. INSERT `card_counter_purchases`（action_id/owner_id/kind/hours/credits/price=expectedPrice）；
   f. upsert `card_counter_entitlements`：game ⇒ `credits = credits + 1`；hour ⇒ `pass_expires_at = DATE_ADD(GREATEST(COALESCE(pass_expires_at, NOW(3)), NOW(3)), INTERVAL ? HOUR)`。
   - **为什么扣款额取 expectedPrice**：`currency.apply` 拒绝 `delta=0`；若扣款额取「服务端当前价」，价格切到 0 时新单连事务都进不去，而重试又无法靠 op 撞键重放 ⇒ B1 的二次购买窗口复活。取 expectedPrice 后，同号重试的请求载荷稳定（同 delta ⇒ 同 hash ⇒ 必走重放），价格校验只在**首次提交**的 effect 内发生。
4. apply 结果：
   - 成功（`replayed:false`）⇒ 提交后读 entitlements + 当前账户余额 ⇒ `{credits, passExpiresAt(epoch ms|null), priceCharged, balanceAfter}`。
   - `replayed:true`（同 hash）或 `14002`（异 hash）⇒ **查 `card_counter_purchases`（action_id）**：
     - 行存在且 kind/hours 与本次一致 ⇒ 重放成功（`priceCharged=行内 price`；credits/expiry/passExpiresAt=当前；`balanceAfter=当前账户余额`，**不得**用 apply replay 的历史 entries）；
     - 行存在但 kind/hours 不一致 ⇒ **14010**；
     - 行缺失 ⇒ 10007 + error 日志（不假装成功）。
   - `14001` ⇒ 金币不足（无权益）；effect 拒绝 ⇒ 对应 4xx；系统错 ⇒ 10007。
5. 逐笔日志 `event='card_counter.purchase'`（kind/hours/price/result/traceId）；失败（14001/10007）也记（审查 C-6/H4）。
6. 请求携带 `meta: {traceId}`（HTTP trace）⇒ `currency_ops.trace_id` 落值。

**d) `GET /api/card-counter/status`**：`{credits, passExpiresAt(epoch ms|null)}`；`X-User-Id` 缺/空 ⇒ 10002/401；**只读不建行**（无行 ⇒ 0/null，零 INSERT）。

**e) `currency.cardCounterConsume`**

请求 `{roomCode, ownerId, seat?, meta?}`；服务端事务：
1. 锁 entitlement 行（无行 = 0/空；唯一键为并发防线）；
2. 查 consumption（存在 ⇒ 返回首笔结果）；
3. pass 有效 ⇒ INSERT kind=pass（expires_at）；
4. 否则 credits>0 ⇒ credits−1 + INSERT kind=credit；
5. 否则 INSERT kind=none；
6. INSERT 撞 1062 ⇒ 回滚后**新事务**读 consumption 行返回首笔（不得冒未知态）；
7. `trace_id = meta.traceId ?? null`。
返回 `{active, source, expiresAt(epoch ms|null)}`。

### 2.5 room-service

- **配置读边**：`cardCounterEnabled()`（缺/坏 false）、`cardCounterPrices()`（缺/坏 10/100；**坏值正反例**）；stub 加两 getter。
- **状态块**：`startRoom` 尾部；`ok !== true` ⇒ **零消费、零写 ccstate、零发布**；`ok && 非 gold` ⇒ 状态块仍执行（active=master），台费块不执行；`ok && gold` 与台费块**并发**（`Promise.all`；consume 不碰余额）。
  - master=false ⇒ 全真人 inactive、不消费；
  - 非 gold / 两价皆 0 ⇒ active=master、不消费；
  - gold 且至少一价 >0 ⇒ 逐位真人 consume（**逐位并发 Promise.all**；整块最坏 ≈ 单人上界 3s×2 尝试）；
  - 成功 ⇒ active=result.active && master；未知 ⇒ active=true/source=unknown + 指标。
- 写 `room:{code}:ccstate`（field=seat → `{active, source?}`；EXPIRE 房间 TTL；进 deleteRoom；写前用当前 seats 复核 userId）。
- 发布 `match:events`：**判别键 `event`**，`{event:'card_counter', userId, roomCode, active, source?}`；`WsGateway.onMatchEvent` 在 `match.timeout`/`match.wait_prompt` 之后、`seats` 循环**之前**加分支（否则落入 seats 循环 ⇒ TypeError）。
- 三条补发：`replayActiveGame`、`game.reconnect`、**`game.resync`（把 socket 传进 handleResync，或 dispatcher ack 后补发——实现二选一并在计划钉）**。
- 指标 `card_counter_consumed_total{source}`、`card_counter_consume_error_total`；逐笔日志 `card_counter.consumed`（room/owner/seat/source/traceId），**成功消费也记**。
- 不新增 `RoomStartService`/`WsGateway` 构造参数。

### 2.6 api-gateway

- `GET /api/card-counter/status`、`POST /api/card-counter/purchase` → `forwardToCurrencySvc`；默认验签（不进公开白名单）；`X-User-Id`/`X-Internal-Token` 注入；网关同批重建。
- 购买限流沿用既有用户桶（不新增专用桶）。

### 2.7 客户端

- 共享配置加载/归一化（`useClientConfig`）；store 两价格 `number|null`；lobby/game 共用；lobby 的 FAILSAFE/normalize 同规则。
- 开始游戏页面板：`cardCounterEnabled && roomMode==='gold' && 两价格均为数值`；挂载 `GET /api/card-counter/status`（失败显「—」、不阻塞购买）；显示 credits/到期/两价；单键 0 隐藏该商品；两价皆 0 显示「金币场免费」无按钮；旧服务端不渲染。
- 购买：`uni.showModal` 确认 → 在途禁用 → 生成 requestId 并**先写待确认记录**（`storage`：按 userId、含 createdAt、24h 过期、`clearSession`/换号清除）→ 请求；未知结果（网络/10007）**复用同 requestId 重试**，不换号；**status 只作展示与人工对账，不作成败判定**（唯一权威 = 同 requestId 的重试响应）；确定性失败清除记录；14009 刷新配置后重新确认；14010 换新号；成功用响应更新面板与 `walletBalance`；单一错误通道；`store.matching` 时禁用。
- 预购与 14003：若 `walletBalance - price < selectedBaseScore × entryMultiplier`，面板显示警示并禁用该商品购买（审查 C-12）。
- 牌桌判定表四行（总开关/有状态/旧服务端/新服务端无状态）；入口与横条共用 gate；active=false 关横条；免费场 active=master；状态到达前短暂 fail-closed 登记。
- `game.card_counter` 入 `SERVER_MESSAGE_TYPES`/`ROOM_MESSAGES`/`messageTypeList()`/session；按 roomCode 存；不走 version 幂等；reset/换房清；三条补发恢复。
- 客户端清单**导出 + 按集合相等**的机械断言。

### 2.8 财务/管理（currency-service）

- source `card_counter`：summary 行（钱包变动负）、ops/CSV、不可提现。
- 财务汇总**新增两条查询**（总次序：group → burn → entry-fee skips → **purchases** → **consumptions**，共 5 条）：
  - purchases：按 kind 的 `count / COUNT(DISTINCT owner_id) / COALESCE(SUM(price),0)`；
  - consumptions：按 kind 的 `count / COUNT(DISTINCT owner_id)`（**含 none**，UI 标注「未开通局次」；「使用」只指 pass/credit）。
  - 零窗 0；DTO `cardCounterPurchases` / `cardCounterConsumptions`；`db.queries` 精确列表同步。
- 管理页「记牌器购买/使用」块 + 静态针脚；符号文案：source 行=钱包变动（负）；购买块=收入（正）。
- summary.csv 仍只导 source/day 行；两块 UI-only（登记）。

### 2.9 部署与回滚

- 顺序 config → currency → room → gateway → client；迁移随容器启动自动执行。
- 杀开关 = 两价设 0（金币场免费、不消费、不显示购买）。
- 本片无新增 `.env`；监控面板本期不加（登记）。

---

## 3. 判据表

| # | 判据 | 载体 |
|---|---|---|
| C1 | 两键：`CONFIG_KEYS` 恰 52（尾追）；整数 0..1e6 正反例（字符串/小数/负/超界，**消息含键名与值**）；种子 10/100 | protocol 单测 |
| C2 | `CLIENT_CONFIG_KEYS` 恰 20（插入位）；`ClientConfig` 两字段 | protocol 单测 |
| C3 | config 迁移：一条 INSERT IGNORE + 两元组 10/100；down 删两键；时间戳唯一且 > 1795700000000 | config-service 单测 |
| C4 | `/api/config` 恰 20 键、值 10/100、缺行默认；六夹具同步 | config-service 单测 |
| C5 | 客户端 store：两价 `number|null`；缺键/旧服务端 null；FAILSAFE/normalize/set 同规则 | client 单测 |
| C6 | currency 迁移：三表 DDL 逐字（列/索引/唯一/ENGINE/CHARSET）；类名不匹配 `/^Currency\d+$/`；时间戳唯一 | currency-service 单测 |
| C7 | 索引：两表 created_at 索引；consumptions 的 seat/trace_id | currency-service 单测 |
| C8 | 两条端点：缺/空 X-User-Id ⇒ 10002/401；网关默认验签（不进公开白名单）；真栈 200/401 正反例 | 单测 + 网关静态 + 真栈 |
| C9 | 请求校验：kind/hours/requestId `[A-Za-z0-9_-]{1,64}`/expectedPrice 非负整数；game 拒 hours；hour 必填 1..8；越界 10001 | currency-service 单测 |
| C10 | **幂等 TOCTOU**：在途同号 + 改价/关开关 ⇒ 第二发走重放/14002，**绝不二次扣费**；端点响应按 purchases 行；同号异 kind/hours ⇒ 14010 | 真栈并发 + 单测 |
| C11 | effect 内校验次序：hasSnapshot(10007) → master/服务端价 0(14008) → expectedPrice≠服务端价(14009)；**扣款额=expectedPrice**；失败**零扣款/零权益/零 purchases** | 真栈 + 单测 |
| C12 | 原子/因子化：`apply≡applyWithEffect(noop)`；effect 拒绝 ⇒ 全回滚；重放 effect 只跑一次；非 uk_action_id 1062 **不得进 replay**；锁序/无死锁 | 单测（控制流）+ 真栈（回滚/重放） |
| C13 | 14001 ⇒ 无权益、钱不动；effect 拒绝 4xx；系统错 10007；HTTP 409/400/503 映射 | 单测 + 真栈 |
| C14 | 权益：game credits+1；hour `max(now,expiry)+hours`（SQL `NOW(3)`/`DATE_ADD` 文本断言）；并发两笔 credits+2/顺延两次；单局卡不过期 | 真栈 + 单测 |
| C15 | 响应：credits/passExpiresAt(epoch ms|null)/priceCharged/balanceAfter；**重放 balanceAfter=当前余额**（先再发生一笔流水再重放） | 真栈 |
| C16 | purchases 行逐字段：game（hours NULL/credits 1）；hour（hours n/credits NULL）；action_id/owner_id/price | 真栈 + 单测 |
| C17 | 购买日志（成功+14001+10007）与指标 `currency_apply_total{source}`；无新增 skip 表 | 单测/真栈 |
| C18 | consume 契约：validate（roomCode/ownerId/seat/meta）；RPC pattern 三同提交；messages.test 精确对象 | protocol 单测 |
| C19 | consume 事务：pass 优先/credit−1/none 行；同房幂等；1062 回读首笔；无 entitlement 行并发；DB 时间判定 | 真栈 + 单测 |
| C20 | consume 行：seat/trace_id/expires_at；响应 epoch ms；meta 有/无两态 | 真栈 + 单测 |
| C21 | 消费未知态：重试耗尽 ⇒ active=true/source=unknown + 指标；仅 10007/传输失败重试 ≤1 | room-service 单测 |
| C22 | 消费成功日志/指标：pass/credit/none 三 source 的逐笔字段与有界标签 | 单测 |
| C23 | room 配置读边：enabled 缺/坏 false；prices 缺/坏/越界 10/100；stub 两 getter | room-service 单测 |
| C24 | 状态块：`ok!==true` 零消费/零写/零发布；非 gold 且 ok 仍下发；master 关/两价 0/收费态；机器人零调用；**单键 0 语义**（该商品隐藏、消费仍按已有权益） | room-service 单测 |
| C25 | `room:{code}:ccstate`：形状/TTL/deleteRoom/(room,seat,userId) 复核 | room-service 单测 |
| C26 | 推送：`match:events` 判别键 `event` + 分支位置（seats 循环前）；WsGateway 定向；构造参数不变；客户端收得到 | room-service + client 单测 |
| C27 | 三条补发：replayActiveGame/game.reconnect/**game.resync（socket 传递或 ack 后补发，二选一）**；缺失不补发；按 roomCode | room-service + client 单测 |
| C28 | 零回归：台费逐分支；免费场/好友房零资金/零消费；`room.match` 逐字；既有 skip 表不动 | 单测 + 静态 |
| C29 | 并发：状态块与台费 `Promise.all`；consume 逐位并发；startRoom 返回值/排期不变；最坏 ≈ 单人上界 | room-service 单测 |
| C30 | 协议消息：类型/清单/ROOM_MESSAGES/validateOutbound 运行期 default（非编译期）；客户端清单导出+按集合相等；doc-sync | protocol + client 单测 |
| C31 | 错误码 14008/14009/14010：errors/CLIENT_ACTION/SPEC_CODES/http-errors/doc-sync/design.md §11.2 | protocol + currency + client 单测 |
| C32 | 共享配置加载器：lobby/game 共用；无第二份 normalize；源码闸/测试 | client 单测 |
| C33 | 面板：条件/状态失败「—」/单键 0/两价 0/旧服务端；14003 预检警示 | client 单测 |
| C34 | 购买交互：确认/在途禁用/待确认按 userId+24h+登出清除/同号重试/status 只展示/14009 刷新/14010 新号/成功回写/单一错误通道/匹配禁用 | client 单测 |
| C35 | 牌桌判定表四行；入口+横条共用 gate；active=false 关横条；免费场 active=master；状态前 fail-closed 登记 | client 单测 |
| C36 | 状态消息处理：按 roomCode、不走 version 幂等、reset/换房清、重连恢复 | client 单测 |
| C37 | 财务五段查询：group→burn→skips→purchases→consumptions；DTO/零窗/符号/none 口径；`db.queries` 精确列表 | currency-service 单测 |
| C38 | 管理端：两键控件/suffix/notes；50→52、47、17+1+29、下拉 14；购买/使用块 + 静态针脚 | 静态闸 + conformance |
| C39 | conformance 存量片：**slice-14/17/18/21/23/24** 的 20 键字面；slice-22/23/24/18 的 52；slice-19 下拉 14；slice-17 迁移行数；baselines | conformance |
| C40 | 真栈 slice-28：购买/重放/不足/并发同号/并发异号/包时/单局/无权益/消费幂等/未知态；清理与 RUN_TAG；`run.ts` 注册；baselines full 列 | conformance |
| C41 | 全量：七包（protocol/config-service/currency-service/room-service/api-gateway/client/admin）lint+test + 静态闸 + 相关 conformance + 全序一次；工作区干净 | 命令证据 |

---

## 4. conformance 登记

- 存量片：**slice-14:502-506**、**slice-17:1398-1407**、slice-18:134-135/994、slice-21:731、slice-23:735/741、slice-24:165/799（20 键字面）；slice-18:1025、slice-22:949/1193、slice-23:1283、slice-24:808（52 键）；slice-19:1484（下拉 14）；slice-17:682-686（`migrations_currency` 3→4 行/名）；`verify-admin-static` 三处计数。
- 新片 `slice-28-card-counter.ts`（已核编号）：真栈组 C40；`run.ts` 注册；`baselines.json` 只回填 full 列；费率/开关「临时改→还原」纪律；actionId/ownerId 运行期唯一（RUN_TAG/harnessOwners）；购买所需金币 = 管理调账/`currency.apply`。
- 客户端渲染归 C32–C36，真栈只断言 HTTP/WS/DB（审查 C-7）。

---

## 5. 明确不做 与窗口登记

- 不做：道具/库存、退款、旧客户端强制、隐藏公开数据、局内购买、机器人/免费场/好友房收费、自动续费、专用管理权益查询页、新增 skip 表、监控面板。
- 窗口登记：排队/已匹配窗口购买（可能不作用于本局、可能压到 14003 门槛）；消费未知态 fail-open；包时局中到期不回收；状态消息丢失 fail-closed；免费场状态到达前短暂 fail-closed；审计表保留策略；房间号碰撞；预购后余额低于 14003 门槛（客户端警示）。
- 既有台费 skip 表与结算/burn 零改动。

---

## 6. 修订记录

- v1.0（2026-10-18）：由设计 v0.4 展开；C1–C40。
- v1.1（2026-10-18）：规格审查处置——B1 幂等 TOCTOU（校验移入 effect）、B1b 公开 `ApplyEffectRejectError`、B2 currency 配置读边/hasSnapshot fail-closed、B3 真库载体点名；高项：错误码改 14008–14010 + HTTP 409 + design.md §11.2、match:events 判别键 `event`、meta/trace、pending request 作用域/清理、status 只展示、总价/上限/requestId 字符集、重放 balanceAfter 当前值、14003 交互、消费成功日志、非 uk_action_id 1062、status 鉴权、purchases 行字段、财务五段、14002 措辞、ok=false 分支、resync socket、consume 并发、单键 0 语义、DB 时间断言、slice-28/注册/baselines、坏值测试；低项：50→52、slice-14/17、监控登记、NUMBER_SUFFIX、status 不建行、失败日志、CSV、C28 措辞、文档 §6.3/§4.2、限流、构造参数、ROOM_MESSAGES 说明。
