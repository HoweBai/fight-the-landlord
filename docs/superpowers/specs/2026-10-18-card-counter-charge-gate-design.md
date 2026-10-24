# 记牌器「收费 + 服务端闸」—— 设计 v0.5（规格审查后订正）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-18 |
| 状态 | **v0.5**：v0.4 的购买/错误码/财务段在规格审查后订正（**以规格 v1.1 为准**）：扣款额 = 玩家确认价 `expectedPrice`（effect 校验服务端当前价）、错误码 **14008/14009/14010**、删除 apply 前置当前态校验（幂等 TOCTOU 修复）、财务五段、`ok=false` 零消费、单键 0 语义、status 只展示 |
| 上游真源 | 开局链 `packages/room-service/src/rooms/rooms.start.ts` · 唯一写钱边 `packages/currency-service/src/apply/apply.service.ts` · 配置链 `packages/protocol/src/config.ts` → `GET /api/config` → 客户端 store · 出站契约闸 `packages/protocol/src/validate.ts` · WS 消息 `packages/protocol/src/messages.ts` · 错误码 `packages/protocol/src/errors.ts` |
| 关联 | 记牌器开关片 `specs/2026-10-17-card-counter-switch-topleft-design.md` · 台费先例 `specs/2026-10-14-entry-fee-design.md` |

## 0.0 v0.5 权威订正（**覆盖 v0.4 以下旧文本；实现以规格 v1.1 为准**）

1. **扣款额**：`entries=[{ownerId, delta:-expectedPrice}]`（玩家确认价）；**不是**服务端读到的价。effect 内校验 `expectedPrice === 服务端当前价`，不等 ⇒ 14009。理由：`currency.apply` 拒绝 `delta=0`；扣款额取服务端价会在价格切 0 时让同号重试无法靠 op 撞键重放，复活二次购买窗口。
2. **购买流程**：**删除** v0.4 §3.3.2 的「先查 actionId / apply 外做当前态校验」；形状校验后**直接** `applyWithEffect`，幂等由 `uk_action_id` 首插裁决；重放/14002 才读 purchases 行校验 kind/hours。effect 次序：hasSnapshot(10007) → master/服务端价 0(14008) → expectedPrice≠服务端价(14009) → 写 purchases/entitlements。
3. **错误码**：14008 未开放 / 14009 价格已更新 / 14010 请求号冲突（v0.4 的 14005/14006/14007 作废；14006/14007 已被 design.md 收编为记录行态提示）。
4. **财务**：**五段**查询（group → burn → entry-fee skips → purchases → consumptions），v0.4 的「第四段一条 SQL」作废；consumptions 含 none（UI 标注「未开通局次」）。
5. **状态块**：`startAndAnnounce` 返回 `false` ⇒ 零消费/零写 ccstate/零发布；非金币场且 `ok=true` 仍下发（active=总开关）；单键 0 = 该商品隐藏、已有权益仍消费；两价皆 0 = 免费。
6. **客户端**：待确认 requestId 按 userId 持久化 + 24h 过期 + 登出清除；status 端点只作展示/人工对账，**不作购买成败判定**；14003 门槛预检（`walletBalance - price < baseScore × entryMultiplier` 时警示/禁用）。
7. **协议/文档**：`match:events` 判别键是 `event`（不是 `type`）；`game.card_counter` 必须同批进 `validate.ts`/`ROOM_MESSAGES`/`SERVER_MESSAGE_TYPES`/客户端 `messageTypeList()`/`docs/client-protocol.md`；`docs/design.md` §6.3/§4.2/§7.5/§11.2 同批更新。
8. **真库载体**：`applyWithEffect`/consume 的原子/重放/并发由 conformance slice-28 真栈组承载；假 DB 只钉控制流。

---



## 0. 背景、边界与用户裁决

### 0.1 现状

- 记牌器已上线：总开关 `game.cardCounterEnabled`（第 50 键，种子 `true`，客户端 fail-safe `false`）；入口在牌桌顶栏左侧；数据源 `PlayerView.recentActions`（窗口 2）。
- 仓内**只有一种货币：金币**；**无背包/库存系统**（「背包」是 disabled 占位）。
- 台费先例：开局成功后按人扣费、actionId 幂等、失败不阻断开局、跳过记账。

### 0.2 可强制 / 不可强制（边界钉死）

**不可强制**：

1. 记牌所需数据是公开的：出牌经 `game.state_update` 广播；`recentActions` 窗口 2（`shared/src/ddz/recent.ts:9`）；全量 `actionLog` 被出站闸禁止外发（`protocol/src/validate.ts:37-41`）。拒绝下发 `recentActions` 会坏掉出牌展示/不出回显/提示/要不起/音效/记牌器六处。
2. `/api/config` 全局、无 per-user（`client-config.controller.ts:42-48`、`platform-config.entity.ts:8-37`）；老客户端只认 `cardCounterEnabled`。
3. ⇒ **硬闸只对新客户端生效**；老客户端/改包客户端仍免费。

**可强制**：服务端记录权益与消费；扣费幂等/守恒/审计；官方新客户端按服务端状态渲染；运营面可查。

**结论：商业门控，不是 DRM。**

### 0.3 目标与成功判据

- 金币场：**开局前购买**「单局卡」（每局消耗 1 张）或「包时卡」（按小时，顺延）；**购买后进入对局自动生效**，无需每局勾选。
- 免费场/好友房：免费、不消费权益、行为与今天一致（除状态消息到达前的短暂 fail-closed，见 §3.5.3）。
- 购买原子：扣金币与发权益同一事务；失败即无权益，不动钱。
- 未开通时官方新客户端不渲染入口/横条；老客户端不受控。
- 购买/消费/权益可查、可统计。
- **上线即付费态**（首发 10/100）；**杀开关 = 两个价格都设 0**（金币场免费，行为回到今天）。

### 0.4 明确不做

- ❌ 道具/库存/次数包（单局卡即「次数」）
- ❌ 退款；包时卡不因中途退出/异常结束退时
- ❌ 旧客户端强制；服务端隐藏公开对局数据
- ❌ 局内购买（只在开局前；开局后不可买本局）
- ❌ 机器人收费；免费场/好友房收费；自动续费
- ❌ 本片不新增 skip 表/免单三态（结构上无「服务已发生、钱未收」状态；既有台费 skip 表**不动**）

### 0.5 用户裁决（2026-10-18）

| # | 裁决 |
|---|---|
| ① | **按局、包时都要** |
| ② | **首发价：10 金币/局、100 金币/小时；做成可配置的** |
| ③ | **货币不足不开通（除非免费）** |
| ④ | **仅开局前购买；购买后进入对局自动生效** |

---

## 1. 总览

```
开始游戏页（金币场）
   ├─ [单局卡] 10 金币/局   ── 确认 ⇒ POST /api/card-counter/purchase {kind:'game', requestId, expectedPrice}
   └─ [包时卡] 100 金币/小时 ── 确认 ⇒ POST /api/card-counter/purchase {kind:'hour', hours:1, requestId, expectedPrice}
        └─ currency-service 购买端点（幂等优先）：
             1) 先查 actionId 是否已存在（op + purchase 行）⇒ 命中 = 重放/冲突判定
             2) 新单：校验总开关/价格/expectedPrice ⇒ applyWithEffect
                  （同一事务：扣金币 + credits+1 或 pass_expires_at 顺延）
                  │
匹配成功 ── game.start 成功 ──→ startRoom 尾部（与台费并发）：
   ├─ 台费块（既有，不动）
   └─ 记牌器状态块（所有模式；消费 RPC 不碰余额）：
        ├─ 总开关关 / 非金币场 / 两价皆 0 ⇒ active = 总开关
        ├─ 金币场且至少一价 >0 ⇒ 逐位真人调
        │    currency.cardCounterConsume {roomCode, ownerId, seat}
        │    （包时优先 ⇒ 单局卡 −1 ⇒ none）
        └─ 结果写 room:{code}:ccstate + 发布 match:events
             └─ WsGateway 定向推送 game.card_counter {roomCode, active, source?}
                  └─ 客户端只按 active 渲染；三条重连路径补发
```

---

## 2. 决策表

| 编号 | 裁决 | 状态 |
|---|---|---|
| D1 | **双商品**：单局卡（每局消耗 1 张）+ 包时卡（按小时，顺延叠加） | ✅ 用户① |
| D2 | **仅金币场收费/消费**；免费场/好友房免费、不消费 | ✅ 沿台费口径 |
| D3 | **价格可配置**：`game.cardCounterPricePerGameCoins`（种子 **10**）、`game.cardCounterPricePerHourCoins`（种子 **100**）；客户端可见（18→20） | ✅ 用户② |
| D4 | **仅开局前购买**；开局自动生效 | ✅ 用户④ |
| D5 | **购买原子 + 幂等优先**：先查 actionId；命中则按 purchase 行校验 kind/hours 后重放；新单才做当前态校验；扣金币与权益同一事务 | 设计（v0.4 修 A1/A2） |
| D6 | **货币不足 ⇒ 不开通**；**免费 = 两价皆 0**（不消费、不显示购买）；单键 0 = 该商品隐藏 | ✅ 用户③ |
| D7 | **不退款**；单局卡不过期；包时自购买时刻起算、`max(now, expiry)+hours` 顺延 | 设计（§10 确认） |
| D8 | **闸 = 服务端权威状态**：所有模式下发 `game.card_counter {roomCode, active, source?}`；客户端只按 active；三条重连补发 | 沿用 v0.2 |
| D9 | **老客户端软闸** | 边界事实 |
| D10 | **客户端 fail-closed**：有本房状态 ⇒ 只认 active；无状态 + 价格键缺省 ⇒ 回退总开关；无状态 + 价格已知 ⇒ 不渲染 | 沿用 v0.2 |
| D11 | **观测**：购买/消费日志+指标+财务块；**本片不新增 skip 表**；既有台费 skip 表不动 | 设计（v0.4 修 H1） |
| D12 | **管理面**：两键归「斗地主 → 对局辅助」；权限沿用；审计 `config_changes`；本期不加专用权益查询端点 | 设计 |
| D13 | **键面/迁移**：`CONFIG_KEYS` 50→52、`CLIENT_CONFIG_KEYS` 18→20、管理面 52、`CONFIG_CONTROLS` 45→47（17 布尔+1 文本+29 数字）；config 迁移 `CardCounterPrices1795800000000`；currency 迁移 `CardCounterEntitlements1795900000000` | 机械项 |
| D14 | **协议**：不改 `room.match`；新增 S→C `game.card_counter`；`validate.ts`/`ROOM_MESSAGES`/`SERVER_MESSAGE_TYPES`/客户端清单同批；新增两条 REST + 一条 RPC | 机械项 |
| D15 | **价格同意**：客户端带 `expectedPrice`，服务端与当前价不等 ⇒ **14006**；客户端刷新配置后重试 | 设计（v0.4 修 E3） |
| D16 | **消费 RPC 未知态**：重试耗尽 ⇒ **active=true（玩家优先）** + 日志/指标；登记权益可能未扣减 | 设计 |
| D17 | **免费状态**：两价皆 0 ⇒ 金币场免费；单键 0 ⇒ 该商品隐藏 | 设计 |
| D18 | **新错误码**：14005 未开放 / 14006 价格已更新 / 14007 请求号冲突（同号异 kind/hours） | 设计（v0.4 修 E3） |
| D19 | **上线顺序**：config → currency → room → gateway → client；杀开关 = 两价设 0 | 设计（v0.4 修 I4） |
| D20 | **时间格式**：`passExpiresAt` 一律 **epoch ms 整数**；所有到期判定只用 DB 时间 | 设计（v0.4 修 D2） |

---

## 3. 逐层设计

### 3.1 protocol

**配置键（两个，客户端可见）**

- 第 51 键 `'game.cardCounterPricePerGameCoins'`：整数 `0..1,000,000`，种子 **10**。
- 第 52 键 `'game.cardCounterPricePerHourCoins'`：整数 `0..1,000,000`，种子 **100**。
- `CLIENT_CONFIG_KEYS` 追加裸名（**18→20**）：排序 `cardCounterEnabled` → `cardCounterPricePerGameCoins` → `cardCounterPricePerHourCoins` → `version`。
- `ClientConfig` 增两个 number 字段。

**消息/契约**

- 不改 `room.match`。
- 新增 S→C（房间级，version 0）：
  ```ts
  | { type: 'game.card_counter'; version: 0; payload: {
      roomCode: string;
      active: boolean;
      source?: 'pass' | 'credit' | 'none' | 'unknown';
    } }
  ```
- 三处清单同批：`SERVER_MESSAGE_TYPES`（11→12）、`ROOM_MESSAGES`、**`validate.ts` 的 `validateOutbound` case**（编译期穷尽 + 运行期 default 双保险）、客户端 `messageTypeList()`、`messages.test.ts` 长度。
- **客户端清单机械同步断言**：`messageTypeList()` 与 `SERVER_MESSAGE_TYPES` **按集合**相等（两表顺序不同，需导出或源码扫描；不要按字面顺序 `toEqual`）。
- `CURRENCY_SOURCES` 追加 `'card_counter'`（12→13，尾部）。
- `RPC_PATTERNS` 增 `currency.cardCounterConsume`；新增 `validateCardCounterConsume`（roomCode 1..16、ownerId 正则、seat 0..2 可选）。
- **错误码**（`errors.ts` + `CLIENT_ACTION` TOAST + `errors.test.ts` SPEC_CODES + `docs/client-protocol.md` 同批）：
  - `E_CARD_COUNTER_UNAVAILABLE = 14005`（总开关关/商品价 0/未开放）
  - `E_CARD_COUNTER_PRICE_CHANGED = 14006`
  - `E_CARD_COUNTER_REQUEST_CONFLICT = 14007`（同 requestId 异 kind/hours）

### 3.2 config-service

- `client-config.controller.ts` 增两个字段；缺行默认 = 种子（10/100）。
- 新迁移 `CardCounterPrices1795800000000`：**一条 `INSERT IGNORE` + 两个 VALUES 元组**（10/100，version 1，updated_by seed）；`down()` 精确删除两键；测试断言两个元组、时间戳 > 1795700000000 且全仓唯一。
- 六处测试夹具/精确清单同步。
- 上线顺序见 D19；**杀开关/分批部署**：部署前可把两价设为 0（种子即 10/100；如需先免费上线，管理页改 0）。

### 3.3 currency-service（核心）

**3.3.1 表（迁移 `CardCounterEntitlements1795900000000`；类名不匹配 `/^Currency\d+$/`）**

```sql
CREATE TABLE IF NOT EXISTS `card_counter_entitlements` (
  `owner_id` varchar(36) NOT NULL,
  `credits` int NOT NULL DEFAULT 0,
  `pass_expires_at` datetime(3) NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `card_counter_purchases` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `action_id` varchar(128) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `kind` varchar(16) NOT NULL,          -- 'game' | 'hour'
  `hours` int NULL,
  `credits` int NULL,
  `price` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cc_purchase_action` (`action_id`),
  KEY `idx_cc_purchase_owner` (`owner_id`, `id`),
  KEY `idx_cc_purchase_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `card_counter_consumptions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `room_code` varchar(16) NOT NULL,
  `owner_id` varchar(36) NOT NULL,
  `seat` int NULL,
  `kind` varchar(16) NOT NULL,          -- 'pass' | 'credit' | 'none'
  `expires_at` datetime(3) NULL,
  `trace_id` varchar(64) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cc_consume_room_owner` (`room_code`, `owner_id`),
  KEY `idx_cc_consume_owner` (`owner_id`, `id`),
  KEY `idx_cc_consume_created` (`created_at`, `kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**3.3.2 购买端点（幂等优先；v0.4 修 A1/A2/A3/A4）**

`POST /api/card-counter/purchase`（网关 → currency-service；玩家鉴权，`X-User-Id`）

**流程（次序钉死）**：

1. 校验请求形状：`kind`、`hours`（仅 hour，1..8）、`requestId`（1..64、安全字符）、`expectedPrice`（非负整数）；`kind='hour'` 时 `hours` 必填，`kind='game'` 时缺省/拒绝。
2. `actionId = 'cardcounter:<userId>:<requestId>'`；**先查 `currency_ops.action_id`**：
   - **命中** ⇒ 查 `card_counter_purchases`（action_id）：
     - 行存在且 `kind/hours` 与本次一致 ⇒ **重放成功**：返回 `{credits, passExpiresAt(epoch ms), priceCharged=行内 price, balanceAfter=当前余额}`；**不再做** 总开关/当前价/expectedPrice 校验（A1）。
     - 行存在但 kind/hours 不一致 ⇒ **14007**（不静默成功，A2）。
     - 行缺失（理论不可达）⇒ 10007 + 响亮日志，不得假装成功。
   - **未命中** ⇒ 进入新单：
     - 总开关 `game.cardCounterEnabled` 为 false ⇒ **14005**。
     - `price = kind==='game' ? perGame : perHour * hours`；`price === 0` ⇒ **14005**；`price > 1,000,000`（MAX_ABS_DELTA）⇒ 10001（配置/请求越界，见 D1）。
     - `expectedPrice !== price` ⇒ **14006**。
3. 新单调用 `ApplyService.applyWithEffect(request, effect)`：
   - `request`：`actionId`、`source='card_counter'`、`entries=[{ownerId:userId, delta:-price}]`、`refId=userId`、`reason = kind==='game' ? 'cardcounter:game' : 'cardcounter:hour:<hours>'`（**hours 进指纹**，A3）。
   - `effect(manager)`（同一 `EntityManager`）：
     - INSERT `card_counter_purchases`（action_id 唯一；kind/hours/credits=1/price）；
     - upsert `card_counter_entitlements`：game ⇒ `credits = credits + 1`；hour ⇒ `pass_expires_at = DATE_ADD(GREATEST(COALESCE(pass_expires_at, NOW(3)), NOW(3)), INTERVAL ? HOUR)`。
   - **锁序**：`apply` 先条件 UPDATE `currency_accounts`（同一 owner 行），effect 再 upsert entitlements；effect 只使用传入的 `manager`，不得访问其它连接；消费 RPC 只锁 entitlements（不反向等 account）⇒ 无环、无死锁（A6）。
4. apply 结果：
   - 成功 ⇒ 事务内 effect 已提交；返回 `{credits, passExpiresAt, priceCharged, balanceAfter}`（事务内/提交后读回）。
   - `replayed` ⇒ 与第 2 步命中同口径（但本路径正常不会发生；并发同 actionId 时按 purchase 行校验）。
   - `14002`（并发同锚异载荷）⇒ 按第 2 步的 purchase 行校验：kind/hours 一致 ⇒ 重放成功；不一致 ⇒ **14007**。
   - `14001` ⇒ 原样「金币不足」（无权益）。
   - effect 抛业务拒绝/系统错 ⇒ 事务整体回滚（op/flows/purchase/权益全无）；端点映射为确定性错误（可重试），不得落成模糊 10007。

**`ApplyService` 扩展（最高风险改动）**：

- `apply(request)` **必须**实现为 `applyWithEffect(request, noopEffect)`：共用 `validateCurrencyApply`、事务体、重放、指标（`currency_apply_total`/`currency_apply_entries_total`）、日志、`writeThrough`。**禁止复制第二份事务体**（A4）。
- effect 在 flows 写完之后、commit 之前执行；抛错即回滚。
- 重放分支不执行 effect（原事务已原子提交；不存在「未入账却已购」的窗口）。
- 内部业务拒绝用可区分类型（端点映射 4xx），不落 10007。
- 收紧撞键判定到 actionId 唯一索引（`uk_action_id` / 索引名），不要「任何 1062 都算撞键」（A5）。
- 专项测试：effect 抛错四者全无；重放 effect 只跑一次；并发两笔不同 requestId（credits+2 / 包时顺延两次）；purchase 与 consume 并发无死锁；**真 MySQL 双会话**（I3）。

**`GET /api/card-counter/status`**：返回 `{credits, passExpiresAt: number|null}`（epoch ms）。

**3.3.3 开局消费 RPC**

`currency.cardCounterConsume { roomCode, ownerId, seat? }`（room-service → currency-service；`CurrencyClient` 新方法，经 `call()` 带 meta；3s 超时，仅对 10007/传输失败**重试 ≤1**，同 room+owner 幂等）。

事务流程：

1. `SELECT credits, pass_expires_at FROM card_counter_entitlements WHERE owner_id=? FOR UPDATE`（无行 = 0/空；**无行时锁的是间隙，唯一键才是并发防线**）。
2. 查 `card_counter_consumptions(room_code, owner_id)`；已存在 ⇒ 按行返回（幂等）。
3. `pass_expires_at > NOW(3)` ⇒ INSERT consumption(kind='pass', expires_at) ⇒ `{active:true, source:'pass', expiresAt(epoch ms)}`。
4. 否则 `credits > 0` ⇒ `credits = credits - 1` + INSERT consumption(kind='credit') ⇒ active/source=credit。
5. 否则 INSERT consumption(kind='none') ⇒ active=false/source='none'（保留 none 行，保证同房二次开局幂等）。
6. **INSERT 撞 1062**（并发同房）⇒ 回滚后**新事务**读 consumption 行 ⇒ 返回首笔结果（C1）；不得把 1062 冒成未知态。
7. 返回 `{active, source, expiresAt?}`（epoch ms）。

**3.3.4 财务/管理面**

- 新 source `card_counter`：summary 自动成行（钱包变动为负）；ops/CSV 自动含；不可提现自动成立。
- 财务第四段（次序：group → burn → entry_fee skips → card_counter）：
  - 购买块：按 kind 的 `count / COUNT(DISTINCT owner_id) / SUM(price)`；
  - 使用块：按 kind 的 `count / COUNT(DISTINCT owner_id)`。
  - **符号约定写死**：source 行 = 钱包变动（购买为负）；购买块 = 收入（正）；管理页文案说明，避免双算（H2）。
  - CSV：summary.csv 仍只导 source/day 行；两个块本期 UI-only（照台费块先例），登记。
- 购买控制器逐笔日志：`event='card_counter.purchase'`（kind/hours/price/result/traceId）；14001/10007 也记（H4）。
- **本片不新增 skip 表**；既有台费 skip 全不动（H1）。

### 3.4 room-service

**3.4.1 配置读边**

- `cardCounterEnabled(): boolean`（缺行/坏 ⇒ false）。
- `cardCounterPrices(): { perGame: number; perHour: number }`（缺行/坏 ⇒ 10/100 种子）。
- 测试桩 `config-cache.stub.ts` 加两个 getter。

**3.4.2 状态块**

- 位置：`startRoom` 尾部、`startAndAnnounce` true 之后；**与台费块并发**（消费 RPC 不碰余额、只锁 entitlements；台费 apply 锁 account；锁序不交叉）。
- 计算：
  - `master=false` ⇒ 全部真人 active=false，不消费。
  - 非 gold ⇒ active=master，不消费。
  - gold && perGame===0 && perHour===0 ⇒ active=master，不消费。
  - gold && 至少一价 >0 ⇒ 逐位真人 `cardCounterConsume`：
    - 成功 ⇒ active=result.active && master，source=result.source；
    - 重试耗尽/未知 ⇒ active=true（D16），source='unknown'，日志+`card_counter_consume_error_total`。
- 写 `room:{code}:ccstate`（Hash，field=seat → `{active, source?}`；**刻意不用 `cardcount` 近名**，C6）；每次 `EXPIRE ROOM_TTL_SECONDS`；进 `deleteRoom`。
- 发布 `match:events`（复用频道）新事件 `{type:'card_counter', userId, roomCode, active, source?}`；WsGateway 定向推送。

**3.4.3 重连补发（三条）**

1. 新连接 `replayActiveGame`（`ws.gateway.ts:409-455`）`game.deal` 后；
2. `game.reconnect` ack（`message.router.ts:774-816`）后；
3. `game.resync`。

按 `roomCode` 存储、顺序不敏感；缺失不补发，客户端 fail-closed；不新增 `WsGateway` 构造参数。

**3.4.4 指标/日志**

- `card_counter_consumed_total{source}`（pass/credit/none/unknown 有界）、`card_counter_consume_error_total`；
- 逐笔日志 `event='card_counter.consumed'` + room/owner/seat/source/traceId。

### 3.5 客户端

**3.5.1 配置与共享加载器**

- `ClientConfig` 两价格字段；store `number | null`，初值/失败兜底 `null`；`FAILSAFE_CLIENT_CONFIG`/`normalizeClientConfig`/`setClientConfig` 同规则（`null` 只代表旧服务端）。
- **抽出共享配置加载/归一化**（v0.4 修 E2）：新 `composables/useClientConfig.ts`（或 store action），大厅与开始游戏页共用；禁止在 `game.vue` 复制第二份 `normalizeClientConfig`。

**3.5.2 开始游戏页购买面板**

- `v-if="store.cardCounterEnabled && store.roomMode === 'gold' && 两价格键均为数值"`（旧服务端/缺键 ⇒ 整块不渲染，E5）。
- 显示：
  - 单局卡：剩余 credits；「购买 · {perGame} 金币/局」（`perGame>0`）；
  - 包时卡：到期（epoch ms 转本地）与剩余分钟；「购买 1 小时 · {perHour} 金币」（`perHour>0`）；
  - 两价皆 0 ⇒「金币场免费」，无按钮。
- 挂载时 `GET /api/card-counter/status`；失败显示「—」，不阻塞购买。
- **匹配中/在局时禁用购买**（`store.matching` 等；与用户裁决④一致，B1）。
- 购买交互（v0.4 修 E1/E4）：
  - 确认用 `uni.showModal`；确认按钮在途禁用（防双击）；
  - 确认时生成 `requestId`（UUID），**先写入 `net/storage.ts` 的待确认记录** `{userId, kind, hours, expectedPrice, requestId}`，再发请求；
  - 结果未知（网络错误/10007/超时）：**不得换新 requestId**；面板显示「结果确认中」并提供重试；重试复用同一 requestId（端点幂等优先）；同时可调 `GET /api/card-counter/status` 对账；
  - 确定性失败（14001/14005/14006/14007/10001）：清除待确认记录；14006 调共享配置加载器刷新价格后由用户重新确认（**新 requestId**，因为旧请求已确定性失败）；14007 提示「请求号冲突」并换新 requestId；
  - 成功：用响应 `{credits, passExpiresAt, priceCharged, balanceAfter}` 更新面板与 `walletBalance`，清除待确认记录；
  - 页面重挂载（匹配成功跳牌桌/返回）时若存在待确认记录 ⇒ 先重试同一 requestId 对账，再决定展示；
  - 错误只在一个通道呈现（面板行内），不叠加全局 toast。
- 不改 `room.match`；单发送点纪律不变。

**3.5.3 牌桌门控（统一判定表）**

| 情形 | 入口/横条 |
|---|---|
| `store.cardCounterEnabled === false` | **不渲染** |
| 有本房状态（`status.roomCode === store.roomCode`） | `status.active` |
| 无本房状态 且 任一价格键为 `null`（旧服务端） | 渲染（回退，仅受总开关） |
| 无本房状态 且 两价格键均为数值（新服务端） | **不渲染**（fail-closed） |

- 入口与横条共用 effective gate；active 变 false ⇒ 关闭横条。
- 免费场/好友房：服务端状态 active=总开关，走同一判定表；**状态到达前短暂 fail-closed**（新服务端 + 数值价格 + 无状态）登记（E8）。
- `usePlayedCards` 不改门控（仍只认 `cardCounterEnabled`）。

**3.5.4 状态消费/重连**

- `game.card_counter` 入 `SERVER_MESSAGE_TYPES`/`ROOM_MESSAGES`/`messageTypeList()`/session；按 roomCode 存；不走 `type@version` 幂等；`reset()`/换房清；三条补发路径恢复。
- 客户端清单同步断言按集合比较（F2）。

### 3.6 管理后台

- 两价格键进「斗地主 → 对局辅助」；两个数字控件 + `NUMBER_SUFFIX`。
- `CONFIG_NOTES`：0 语义（两价皆 0 = 金币场免费；单键 0 = 商品隐藏）；改价只影响之后的购买；已在包时中不受改价影响；旧客户端仍免费；总开关仍是 `cardCounterEnabled`；**上线手顺：先设 0（可选免费）→ 全栈就绪 → 设 10/100**。
- `verify-admin-static.mjs`：50→52、45→47、17+1+29=47、proto/IA 52、下拉 13→14。
- 财务块「记牌器购买/使用」；符号/文案见 §3.3.4；静态针脚。
- `admin/index.html` 来源下拉 14；`admin/app.js` 注释同步。

### 3.7 监控

- 面板：购买 `currency_apply_total{source='card_counter'}`；消费 `card_counter_consumed_total{source}`；错误 `card_counter_consume_error_total`。

---

## 4. 失败矩阵

### 4.1 购买

| # | 路径 | 钱 | 权益 | 响应 |
|---|---|---|---|---|
| 1 | 新单成功 | 已扣 | 入账 | 新权益 |
| 2 | 同 requestId 重放（kind/hours 一致） | 不重复扣 | 不重复发 | 成功（行内历史 price） |
| 3 | 同 requestId 异 kind/hours | 不重复扣 | 以原单为准 | **14007** |
| 4 | 14001 | 未扣 | 无 | 金币不足 |
| 5 | 总开关关 / 价 0 | 未扣 | 无 | 14005 |
| 6 | expectedPrice 不符 | 未扣 | 无 | 14006 |
| 7 | effect 抛错 | 全回滚 | 无 | 确定性错误（可重试同 requestId） |
| 8 | 并发同 actionId | 一笔成功 | 一笔入账 | 另一笔按 purchase 行重放/14007 |
| 9 | price > 1,000,000 | 未扣 | 无 | 10001（配置越界） |

### 4.2 开局消费

| # | 路径 | 权益 | 记牌器 | 处置 |
|---|---|---|---|---|
| 10 | 包时有效 | 不扣 | 开通 | source=pass |
| 11 | 无包时、credits>0 | −1 | 开通 | source=credit |
| 12 | 无权益 | 无 | 不开通 | source=none（none 行幂等） |
| 13 | 总开关关 | 不消费 | 不开通 | 所有模式 |
| 14 | 非金币场 / 两价皆 0 | 不消费 | active=总开关 | 免费态 |
| 15 | 消费 RPC 未知 | 可能未扣 | 开通（D16） | source=unknown + 指标 |
| 16 | 同房二次开局 | 不重复消费 | 首笔结果 | 唯一键 + 1062 回读 |
| 17 | 局没开成 | 不消费 | 无 | 消费在 `game.start` 后 |
| 18 | 收费后玩家未进场 | 已消费 | 状态在房间键 | 重连补发；不退 |

### 4.3 客户端购买

| # | 路径 | 处置 |
|---|---|---|
| 19 | 双击确认 | 在途禁用 |
| 20 | 响应丢失/10007 | 待确认记录 + 同 requestId 重试 + status 对账 |
| 21 | 页面卸载/重挂载 | 待确认记录恢复，先对账 |
| 22 | 价格变化 | 14006 → 共享加载器刷新 → 重新确认（新 requestId） |
| 23 | 匹配中/在局 | 购买面板禁用 |

---

## 5. 可观测性与账

- 购买：apply 流水（source `card_counter`）+ `card_counter_purchases` + 逐笔购买日志（kind/hours/price/result）。
- 消费：`card_counter_consumptions`（room/owner/seat/kind/trace）+ 逐笔日志 + 指标。
- 指标：`card_counter_consumed_total{source}`、`card_counter_consume_error_total`；收款 `currency_apply_total{source}`。
- 财务：source 行（钱包变动，负）+ 购买块（收入，正）+ 使用块（kind 计数）；文案区分。
- 管理端查询：ops 按 source + 手机号查流水；本期不加专用权益端点。

---

## 6. 测试判据（粗 C；细则进规格）

1. **配置**：两键整数 0..1e6、种子 10/100；`/api/config` 恰 20 键；缺行默认；管理面 52；客户端 20。
2. **applyWithEffect 因子化**：`apply ≡ applyWithEffect(noop)`；两条入口的校验/指标/写穿一致；effect 抛错四者全无；重放 effect 只跑一次；**真 MySQL 双会话**。
3. **购买幂等**：首次成功 + 响应丢失 + 期间改价/关开关 ⇒ 同 requestId 重试仍重放成功（A1）；异 kind/hours ⇒ 14007（A2）；hours 进指纹（A3）；并发两笔 credits+2/包时顺延两次。
4. **购买校验**：14005/14006/14001/10001；`price ≤ 1e6`（D1）；kind/hours/requestId。
5. **消费**：包时优先/credit/none；同房幂等；并发同房 1062 回读；无 entitlement 行并发；未知态 fail-open + 指标；重试仅 10007。
6. **状态**：四分支（总开关/非 gold/两价 0/收费态）；所有模式下发；房间键 TTL/deleteRoom；三条补发。
7. **协议/网关**：validateOutbound 新 case（编译+运行）；ROOM_MESSAGES；客户端清单按集合相等；end-to-end 消息；新错误码 + errors.test + doc-sync。
8. **客户端**：购买面板（价格/权益/免费态/旧服务端不渲染）；确认/在途/待确认记录/对账/价格变化；匹配中禁用；判定表四行；横条关闭；免费场状态到达前的短暂 fail-closed。
9. **财务**：source 行、下拉 14、购买/使用块、符号文案、CSV 口径、可提现排除。
10. **零回归**：台费逐分支；免费场/好友房零资金/零消费；结算/burn；`room.match` 逐字不变。
11. **conformance**：slice-17（`migrations_currency` 恰 N 行/名）；slice-18/19/21/22/23/24 的键面/下拉锚点；新端点/消息。

---

## 7. 影响面清单

- **protocol**：`config.ts`/`config.test.ts`（52/20）、`messages.ts`/`messages.test.ts`（S→C、清单、RPC pattern）、**`validate.ts`**、`currency.ts`（source、consume 校验/类型）、`currency.test.ts`、`errors.ts`/`errors.test.ts`、`rpc.ts`。
- **config-service**：`client-config.controller.ts`、`CardCounterPrices1795800000000`、六处夹具。
- **currency-service**：`CardCounterEntitlements1795900000000`、`apply.service.ts`（`applyWithEffect` 因子化）、purchase/status HTTP 控制器、`card-counter` service、consume RPC controller/service、`rpc.module.ts`、`admin/finance-query.service.ts` + controller/DTO、`test/{apply,apply.concurrency,admin-finance,rpc,migration}`。
- **room-service**：`rooms.start.ts`（状态块）、`rooms.service.ts`（deleteRoom）、`rooms.seats.ts`（`ccstate` 键）、`ws.gateway.ts`（match:events 分支/补发）、`message.router.ts`（补发）、`config-cache.service.ts`（两 reader）、`test/helpers/config-cache.stub.ts`、`currency.client.ts`（consume）、`metrics/room.metrics.ts`、测试。
- **api-gateway**：两条玩家路由（status/purchase）+ 网关重建。
- **admin**：`app.js`、`index.html`、`verify-admin-static.mjs`。
- **客户端**：`stores/game.ts`、`composables/useClientConfig.ts`（新，E2）、`pages/lobby/lobby.vue`、`pages/game/game.vue`（面板）、`pages/table/table.vue`（判定表）、`net/{session,socket,rest,storage}.ts`、`docs/client-protocol.md`、`test/protocol-doc-sync.test.ts`。
- **conformance（逐文件）**：`slice-17-currency.ts:682-686`（迁移行/名）、`slice-18-gold-room.ts:134-135,994,1025`、`slice-19-admin-rbac-audit.ts:1484`、`slice-21-payment.ts:731`、`slice-22-pay-channel.ts:949,1193`、`slice-23-notify-channel.ts:735,741,1283`、`slice-24-ads-relief.ts:165,799,808`；排序字面插入位 `cardCounterEnabled` → `cardCounterPricePerGameCoins` → `cardCounterPricePerHourCoins` → `coinPerYuan`。
- **文档**：`docs/design.md`（五十键→五十二键、18→20 可见键、room-service 消费 `cardCounterEnabled`、§7.5 键表）、`docs/client-protocol.md`（消息/错误码/端点）。

---

## 8. 风险与边界（登记）

1. 老客户端免费骑乘（边界事实）。
2. **`applyWithEffect` 是钱核心改动**：因子化、锁序、重放、真库判据是首要风险。
3. **排队/已匹配窗口购买**：可能不作用于本局，且可能把余额压到台费门槛下（台费 14001 免单）；客户端在匹配中禁用购买，服务端不跨查；登记为已接受边界（§10 确认）。
4. 消费 RPC 未知态 fail-open ⇒ 权益可能未扣减；登记。
5. 包时快照：局中到期不回收。
6. 状态消息丢失 ⇒ 在线 fail-closed，重连补发。
7. 两价皆 0 = 免费；单键 0 = 商品隐藏；管理页备注写清。
8. 计数闸多处联动。
9. 消费/购买审计表永久增长；`created_at` 索引已加；保留策略登记（将来按 `record.retentionDays` 族另片）。
10. 免费场/好友房不消费；状态到达前短暂 fail-closed。

---

## 9. 审查记录

- **v0.1 审查（sonnet）**：5 阻断（validateOutbound、客户端无场次信号、总开关绕过、与台费并发抢余额、暗上线判据）→ v0.2 处置。
- **v0.3 增量审查（sonnet）**：3 阻断（A1 幂等前置、A2 14002 校验、E1 客户端未知结果防线）+ 高项（A3 hours 入指纹、A4 applyWithEffect 因子化、G1 created_at 索引、D1 价格×小时 vs delta 上限、D2 时区/epoch、E2 配置刷新路径、E3 错误码、C1 消费撞键、I3 真库判据、I4 上线顺序）。**v0.4 已逐条处置**（见 §3.3/§3.5/§6/§7）。
- v0.4 沿用 v0.2 的阻断修复；v0.2 的 opt-in/价格同意/skip 表已退役。

---

## 10. 请确认的四条口径（其余按本设计执行）

1. **包时卡从购买时刻起算**（不是首次使用），可连续购买顺延。
2. **两价皆 0 = 金币场免费**（不消费、不显示购买）；单键 0 = 该商品隐藏。
3. **购买面板放在「开始游戏页」的金币场模式下**（不在钱包页）；局内不可购买。
4. **上线顺序**：config → currency → room → gateway → client；若需先免费上线，部署前/后把两价设 0，全栈就绪再设 10/100（杀开关 = 两价 0）。

若四条无异议，我按此落规格（C 判据）→ 计划 → 计划对抗审查 → TDD 实现。
