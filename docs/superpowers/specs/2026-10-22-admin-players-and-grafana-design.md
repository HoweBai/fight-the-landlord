# 玩家管理页 + Grafana 玩家与营收看板 — 设计

- 日期：2026-10-22
- 状态：对抗审查已修订并裁决（1 阻断 + 12 高 + 11 低，见 §9）；PII 范围已定；待实现计划
- 范围：管理后台玩家页（列表 / 详情 / 封禁）+ Grafana 聚合看板
- 用户裁决：
  1. 管理页与 Grafana 分工：行级/可操作/PII 放管理页，聚合趋势/告警放 Grafana；
  2. 玩家列表做「完整版」：列表 + 详情抽屉 + 在线/流失筛选 + 每日新增/活跃/流失汇总；
  3. 在线状态用**真实在线**（WS presence）；
  4. 玩家页角色仅 `super_admin` / `operator`。

## 1. 背景与目标

后台目前没有玩家列表：只能按手机号/ID 单人查询，无法回答「有多少真实玩家、谁在线、谁流失、谁充值多少、封禁谁」。Grafana 只有聚合指标，且没有注册/DAU/留存/充值等玩家维度趋势。

本设计新增：

- **管理页「玩家」**：分页列表 + 筛选 + 汇总卡片 + 玩家详情 + 封禁/解封。
- **Grafana「玩家与营收」看板**：在线、每日新增、活跃、流失、充值趋势。

## 2. 范围

### 做

- room-service 写 Redis 在线 presence；user-service 读。
- user-service 新增玩家列表 + 最近对局接口；注册计数指标。
- currency-service 新增批量余额接口；payment-service 新增批量充值汇总接口。
- gateway 新增四条路由与角色 policy。
- admin 新增「玩家」页（列表 / 详情 / 封禁 / 解封）。
- Grafana 新增 `08-players.json` 看板 + 玩家/充值指标 + 每日/定时统计。
- 静态闸、单测、真栈验收与文档。

### 不做（YAGNI）

- 不做玩家 CSV 导出（后续需要再加）。
- 不做玩家密码重置、设备解绑等管理动作（设备解绑已在风控详情里，页面提供跳转）。
- 不做跨服务直接 SQL（currency/payment 表不进入 user-service 查询）。
- 不给 Grafana 加 MySQL 数据源（凭据 + PII + 行级权限风险）。
- 不做玩家级数据进 Prometheus 标签（基数爆炸）。
- 不改协议、配置键、支付/货币业务流程。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 管理页负责行级/操作/PII；Grafana 只放聚合趋势与告警 | 两者能力边界不同；避免重复造图与 PII 外泄 |
| D2 | 在线 presence = Redis ZSET `presence:online`（member=userId，score=最后心跳 epoch ms），room-service 写、user-service 读 | 真实在线；ZSET 支持按时间窗口过滤与在线总数 |
| D3 | 在线判定 = score ≥ now − 60s；连接时与 Engine.IO `heartbeat` 事件刷新；断线时 ZREM（仅当前活跃 socket） | 无需新增定时器；崩溃残留按时间自然过期 |
| D4 | 玩家列表放 user-service（只查 users/user_devices/game_record_players/risk_reviews） | 表归属不变；用户与对局数据本来就在 user-service |
| D5 | 余额、充值按当前页 userIds 走批量端点（currency/payment），前端并行取数合并 | 避免 N+1；不跨服务读表 |
| D6 | 详情复用现有端点：用户资料、风控详情（设备/对局统计/风控记录）、钱包账户、支付订单、设备解绑（DELETE）；仅新增「最近对局」端点 | 风控详情已聚合大半字段，避免重复实现 |
| D7 | 封禁/解封复用 `POST /api/admin/risk/actions`（`ban`/`unban` + reason），不新写状态机 | 复用既有审计与旗标逻辑（`risk:banned`） |
| D8 | 新路由角色 = `super_admin` / `operator`；policy 显式规则置于 P8 之前 | 防止落 P8「任意 GET」导致越权 |
| D9 | 列表用 offset 分页（page/pageSize ≤ 100），默认按最后活跃降序；筛选 q/status/online/activity | 运营场景需要页码；数据量可控 |
| D10 | 流失定义：`lastActiveAt = max(user_devices.last_seen_at, 最近一局 ended_at)`；超过 N 天无活动即流失；新增 = `users.createdAt` | 没有玩家登录时间表；设备上报 + 对局是现有最可靠活跃信号 |
| D11 | Grafana 新看板 `08-players.json`，指标经 Prometheus；统计任务放 user-service | 与现有监控体系一致；不引入 DB 数据源 |
| D12 | 指标：`user_registrations_total`、`players_active_1d/7d/30d`、`players_inactive_14d/30d`、`payment_recharge_credited_total`、`payment_recharge_fen_total`；在线沿用 `ws_connections` | 覆盖新增/活跃/流失/充值；在线已有指标 |
| D13 | 玩家统计任务固定 5 分钟一轮（常量，不新增配置键）；多实例重复写 gauge 幂等 | 避免配置面扩散；gauge 覆盖写无副作用 |
| D14 | 看板随 `deploy/monitoring/grafana/dashboards/` 自动加载；新增 `verify:monitoring` 静态校验脚本 | Grafana provider 已按目录加载；JSON 错误要在本地拦截 |
| D15 | **PII 范围（已裁决）**：玩家页手机号仅 super_admin/operator；既有财务/审计/用户详情读面的手机号展示**保持不变**，作为已知例外登记 | 用户选择「仅玩家页限制」；不扩大改动面，但 spec 不再声称全局收紧 |
| D16 | 列表查询**先分页取 userIds，再只对当页聚合**；稳定排序 `lastActive DESC, id DESC`；新增 `users(createdAt)` 索引迁移 | 避免全量聚合；分页稳定；补索引缺口 |
| D17 | summary 复用 5 分钟统计任务的 Redis/内存快照或 60s 缓存；明确 summary 是**全局**口径（不随筛选变化） | 避免每次列表请求做 4 组全量聚合 |
| D18 | 统一 canonical 活跃口径：`lastActiveAt = max(user_devices.last_seen_at, 最近一局 ended_at)`；列表与 Grafana 统计都用它；对局/胜场统一 `mode IN ('random','gold')`；设备数统一 `risk.deviceWindowDays` 窗口 | 消除列表/详情/Grafana 三处数字不一致 |
| D19 | 批量端点统一 `@HttpCode(200)` + `{code:0,data:{...}}` + 合法 actor；1–100 去重；空数组/非数组/超限/非法 userId 一律 400；金额 `toSafeInt`；充值口径 = **毛充值（未扣退款）**，列头注明 | 与现有管理面契约一致；避免类型/口径歧义 |
| D20 | 实施计划拆为 A1（presence + 列表/详情 API + 网关）、A2（admin 玩家 UI + 封禁）、B（Grafana 指标/看板）三个可独立交付的切片 | 单个计划过大；先交付操作工具，再交付看板 |

## 4. Part A：管理页玩家

### 4.1 在线 presence（room-service 写，user-service 读）

**Redis 契约**（放 `packages/shared/src/presence/online.ts`，经 barrel 导出，避免两处拼字符串）：

```ts
export const ONLINE_USERS_KEY = 'presence:online';
/** 在线判定窗口：最后心跳距今 ≤ 60s。 */
export const ONLINE_TTL_MS = 60_000;
/** 过期成员清理阈值：超过 5 分钟未心跳的成员可删除。 */
export const ONLINE_PRUNE_MS = 5 * 60_000;
```

**写点**（`room-service/src/gateway/ws.gateway.ts`）：

- **一律 best-effort**：presence 的 Redis 调用不得 await 在鉴权/断线关键路径上阻塞，
  统一 `void touchPresence(...).catch(warn)`；失败只 warn，不影响连接建立/断开。
- `handleConnection` 鉴权通过、`activeConnections.set` 之后：`ZADD presence:online now userId`。
- 同一连接上注册 `socket.conn?.on('heartbeat', () => { void ZADD...catch(warn); })`
  （Engine.IO 心跳，`pingInterval=30000`；不新增定时器）。测试夹具需补 `conn` 字段。
- `handleDisconnectInner` 在「陈旧断线早返」之后、确认 `activeConnections.get(userId) === socket`
  时：`ZREM presence:online userId`（同样 catch）。
- 多实例/迟到断线：旧实例的迟到断线可能短暂移除已在新实例重连的用户；下一次心跳（≤30s）
  自动恢复。接受该短暂误差，文档登记。
- 过期成员清理：由 user-service 的 5 分钟统计任务执行
  `ZREMRANGEBYSCORE presence:online -inf (now-5min)`；列表请求不再承担清理职责。

**读点**（user-service）：

- 单行在线：`ZSCORE` > now − 60s。
- 在线筛选：`ZRANGEBYSCORE presence:online (now-60s) +inf` → userId 集合。
- 在线总数：`ZCOUNT presence:online (now-60s) +inf`。
- Redis 失败：列表 `online` 全部 false、在线筛选降级为不筛选并在状态条提示；
  用户详情 `online:false`；两者都不得 500。

### 4.2 玩家列表 API（user-service 新增）

`GET /api/admin/players`（policy：super_admin | operator）

查询参数：

| 参数 | 规则 |
|---|---|
| `q` | 可选，1–64 字符；手机号/昵称模糊匹配，或 userId 精确匹配 |
| `status` | 可选：`active` / `banned` |
| `online` | 可选：`online` / `offline` |
| `activity` | 可选：`active7` / `active30` / `inactive14` / `inactive30` |
| `page` | 正整数，默认 1 |
| `pageSize` | 10/20/50/100，默认 20 |
| `sort` | `lastActive`（默认）/ `created` |

响应：

```json
{
  "code": 0,
  "data": {
    "items": [{
      "userId": "…", "phone": "138…", "nickname": "…", "status": "active",
      "createdAt": 1760000000000, "lastActiveAt": 1760000000000, "online": true,
      "deviceCount": 3, "games": 120, "wins": 61, "lastGameAt": 1760000000000,
      "riskStatus": "open"
    }],
    "page": 1, "pageSize": 20, "total": 123,
    "summary": {
      "totalPlayers": 123, "onlineNow": 5, "newToday": 2, "new7d": 10,
      "active7d": 40, "active30d": 80, "inactive14d": 20, "inactive30d": 10
    }
  }
}
```

SQL 口径（**page-first**：先按筛选/排序在 users 上取当前页 userIds，再只对这些 id 聚合）：

- 第一步：`SELECT u.id, u.phone, u.nickname, u.status, u.createdAt,
  GREATEST(COALESCE(d.last_seen,'1970-01-01'), COALESCE(g.last_game,'1970-01-01')) AS last_active
  FROM users u LEFT JOIN (设备按 user_id 聚合) d ... LEFT JOIN (对局按 user_id 聚合) g ...
  WHERE <filters> ORDER BY last_active DESC, u.id DESC LIMIT ? OFFSET ?`
- 第二步：只对当页 userIds 聚合 `deviceCount` / `games` / `wins` / `lastGameAt` / 最新 `risk_reviews.status`。
- `games` / `wins` 统一 `mode IN ('random','gold')` 且 `is_robot=0`、`user_id IS NOT NULL`
  （与风控详情 `RISK_STATS_SQL` 同口径）。
- `deviceCount` 统一按 `risk.deviceWindowDays` 窗口统计（与风控详情同口径），列头标「窗口设备数」。
- `lastActiveAt = MAX(devices.last_seen, games.last_game)`（两者都无 ⇒ null）。
- `q`：手机号/昵称 `LIKE ?` 前先转义 `%`/`_`；36 字符时额外 `u.id = ?` 精确匹配。
- `online`：`online` ⇒ `id IN (在线集合)`，集合为空直接返回空页；`offline` ⇒ 仅当在线集合非空时
  加 `id NOT IN (...)`，集合为空不加条件。在线集合上限 10,000；超出时筛选退化为不筛选并提示。
- 排序：默认 `lastActive DESC, id DESC`；`sort=created` ⇒ `createdAt DESC, id DESC`（稳定 tie-breaker）。
- 汇总：**全局口径，不随筛选变化**；由 `PlayerStatsService` 每 5 分钟写 Redis 快照
  （`players:summary`，TTL 10 分钟），列表请求直接读快照；快照缺失时回退实时 SQL 并限流。
  - `totalPlayers` / `newToday` / `new7d` / `active7d` / `active30d` / `inactive14d` / `inactive30d`
  - `newToday` 用 `CONVERT_TZ(createdAt,'+00:00','+08:00')` 的北京时间自然日（照货币财务先例）
  - `inactive14d/30d` **排除从未活跃且注册不足窗口天数的用户**；另给 `neverActive` 计数
  - `onlineNow` = Redis `ZCOUNT`

性能：先分页后聚合，避免全量聚合；新增迁移 `users(createdAt)`（列表按注册时间筛选/排序）；
`user_devices(user_id)`、`game_record_players(user_id, ended_at)` 已有索引；`pageSize` 上限 100；
实现时对典型筛选跑 `EXPLAIN` 并存档。

### 4.3 最近对局 API（user-service 新增）

`GET /api/admin/players/:userId/games?limit=20`（super_admin | operator）

- `limit` 可选，默认 20、范围 1–50；非法值 400；userId 不存在 404（11004）。
- 返回最近 N 局：`recordId, mode, baseScore, role, won, scoreChange, moneyDelta, endedAt`。
- 数据源 `game_record_players JOIN game_records`，过滤 `is_robot=0`、`user_id IS NOT NULL`，
  按 `ended_at DESC, record_id DESC` 排序（稳定 tie-breaker）。

### 4.4 批量余额 / 充值汇总

**currency-service**：`POST /api/admin/wallet/accounts/batch`（`@HttpCode(200)`）

```json
{ "userIds": ["id1", "id2"] }
```

- 响应统一信封：`{ code: 0, data: { accounts: [{ userId, balance, exists }] } }`。
- `userIds` 必须为数组、1–100 个、去重、每个 1–36 字符；空数组/非数组/超限/非法 userId
  ⇒ **400（10001）**。
- `XAdminGuard`：非 GET 写面，必须带合法 `x-admin-actor`（经网关自动注入；直连测试显式带）。
- 未开户 ⇒ `balance:0, exists:false`；`balance` 用 `toSafeInt` 归一。
- 只读，不改账户。

**payment-service**：`POST /api/admin/pay/players/summary`（`@HttpCode(200)`）

- 同样 1–100 个 userId；响应 `{ code:0, data:{ players:[{ userId, rechargeCount, rechargeFen, lastRechargeAt }] } }`。
- 口径：`payment_orders` 中 `credited_at IS NOT NULL`；`COUNT(*)`、`SUM(amount_fen)`、`MAX(credited_at)`；
  无记录 ⇒ `0/0/null`。**毛充值（未扣退款）**；列头/提示注明。
- `rechargeFen` 用 `toSafeInt`（MySQL `SUM()` 可能回字符串）。
- 只读。

### 4.5 网关路由与角色

| 路由 | 下游 | policy 谓词 |
|---|---|---|
| `GET /api/admin/players` | user-service | 新增 P10：**精确**路径，super_admin \| operator |
| `GET /api/admin/players/:userId/games` | user-service | 新增 P11：**前缀** `/api/admin/players/` + 后缀 `/games` + 非空 userId 段，super_admin \| operator |
| `POST /api/admin/wallet/accounts/batch` | currency-service | 新增 P12：**精确** POST 路径，super_admin \| operator |
| `POST /api/admin/pay/players/summary` | payment-service | 新增 P13：**精确** POST 路径，super_admin \| operator |

- 新规则必须显式、P10/P11 置于 P8 之前，P12/P13 置于 P9（`return false`）之前；
  首个命中即终局，避免落 P8「任意 GET」。
- **query 白名单**：
  - `GET /admin/players`：恰好 `q,status,online,activity,page,pageSize,sort`；未知键 400；
    下游再做一次参数校验（网关放行 ≠ 下游接受任意值）。
  - `GET /admin/players/:userId/games`：恰好 `limit`；未知键 400。
- 路径参数 `:userId` 拼下游 URL 前 `encodeURIComponent`（R75 先例）。
- 详情复用现有端点（`admin/users/:userId`、`admin/risk/users/:userId`、`admin/wallet/accounts/:userId`、
  `admin/pay/orders?userId=`），它们已有 P8 读权限；本次不收紧（PII 范围见 D15）。
- 封禁复用 `POST /api/admin/risk/actions`（已有 P-r4 权限）。

### 4.6 用户详情增加 `online` 字段

`GET /api/admin/users/:userId` 响应新增 `online: boolean`（user-service 读 presence）。
**向后兼容**（只加字段）；财务/审计视图不使用该字段，无影响。

### 4.7 后台 UI

- 左树「运营」组新增叶：`nav-players-btn`「玩家」，置于「钱包调整」之前。
- 新整页视图 `players-view`（`VIEWS.players`，roles `['super_admin','operator']`）。
- **接线必须成套**：
  - `VIEW_ORDER` 在 `wallet` 之前加入 `players`；
  - `wire()` 增加 `nav-players-btn` click → `switchView('players')`；
  - `switchView` 增加 `if (view === 'players') loadPlayers()` 首次加载分支；
  - `applyRoleNav` / `showLoginView` 由 `VIEW_ORDER` 自动覆盖（无需单独分支）；
  - `showLoginView` 清零玩家页状态与 DOM（列表、筛选、详情、分页）；
  - 新增 `resetPlayers()` 并在登出路径调用。
- 分页每页条数统一 `10/20/50/100`（与后端一致），非法值后端 400。
- 顶部汇总卡片 8 个：总玩家 / 当前在线 / 今日新增 / 7 日新增 / 7 日活跃 / 30 日活跃 / 14 日流失 / 30 日流失。
- 筛选栏：搜索（手机号/昵称/ID）、状态、在线、活跃区间、刷新。
- 表格列：手机号、昵称、状态、在线、注册时间、最后活跃、设备数、对局/胜场、余额、累计充值、操作。
- 分页：上一页/下一页 + 页码信息 + 每页条数（20/50/100）。
- 余额与充值列：列表返回后按当前页 userIds 并行调用两个批量端点，合并渲染；
  失败时该列显示「—」，不阻塞列表。
- 行点击 → 详情面板（同页切换，带返回）：
  - 基本资料（userId/手机号/昵称/状态/注册时间/在线）
  - 余额 + 充值汇总 + 最近 20 笔订单（复用 `admin/pay/orders?userId=`；该端点固定返回最多 50 条，
    前端切片 20 条并注明）
  - 对局统计（复用风控详情 stats）+ 最近 20 局（新端点）
  - 设备列表（复用风控详情 devices）；「解绑设备」直接复用 `DELETE /api/admin/risk/users/:userId/device-binding`（二次确认，成功后就地重拉详情；写风控审计）
  - 风控记录（复用风控详情 entries / binding / hits）
  - 操作：封禁 / 解封（确认弹窗 + reason 输入，调用 risk actions；**独立动作条**，不复用风控队列的
    五动作条/刷新回调；成功后刷新玩家详情与列表，并透传 `bannedFlagPresent` 处理孤儿旗解封）
- 全部使用 `createElement` + `textContent`，零 innerHTML；沿用现有表格/面板/弹窗样式。

### 4.8 错误与边界

- 列表/汇总查询失败 ⇒ 页面顶部错误条，保留筛选条件。
- 在线 Redis 不可用 ⇒ `online` 全部 false、在线筛选降级为不筛选，并在状态条提示；
  不得让整个列表 500。
- 批量端点失败/超时 ⇒ 余额/充值列显示「—」，不阻塞其余列。
- `userId` 不存在 ⇒ 详情返回 404，页面提示并返回列表。
- 封禁/解封失败（409/403/网络）⇒ 弹窗内错误提示，不关闭弹窗。
- 手机号属于 PII：**玩家页**仅 super_admin/operator 可见；既有财务/审计/用户详情读面保持现状，
  作为已知例外（D15 用户裁决）。不做 CSV 导出；不写日志明文手机号。
- Redis 失败：列表与详情均降级（online=false / 不筛选），状态条提示；不得 500。
- 分页越界 ⇒ 返回空 items + total；前端回到第 1 页。

## 5. Part B：Grafana「玩家与营收」看板

### 5.1 新增指标

| 指标 | 类型 | 服务 | 写入点 |
|---|---|---|---|
| `user_registrations_total` | Counter | user-service | 注册流程**成功返回点** +1（用户已创建；失败路径不计；语义写入 spec/测试） |
| `players_total` | Gauge | user-service | 统计任务 `COUNT(*) users` |
| `players_active_1d/7d/30d` | Gauge | user-service | 统计任务按 **canonical lastActiveAt**（设备+对局）统计 |
| `players_inactive_14d/30d` | Gauge | user-service | 统计任务按 canonical lastActiveAt，排除从未活跃且注册不足窗口的用户 |
| `players_online_presence` | Gauge | user-service | 统计任务 `ZCOUNT presence:online (now-60s) +inf` |
| `payment_recharge_credited_total` | Counter | payment-service | **仅 `creditOrder` 返回 `credited`** 时 +1（already/stalled/skipped 不计） |
| `payment_recharge_fen_total` | Counter | payment-service | 同上，累加 `amount_fen` |
| `ws_connections` | Gauge | room-service | 已存在，直接复用（进程级） |

- 所有指标无 userId 标签（基数控制）。
- **Prometheus 多实例聚合**：counter 查询一律 `sum(increase(...))`；gauge 用 `max(...)`；
  面板不得直接写裸指标名。
- 在线口径拆两个面板：「WS 连接数（进程级求和）」与「在线玩家（presence ZCOUNT）」，
  不把两个数字混为同一个。
- 统计任务：`PlayerStatsService`，固定 5 分钟自重排（照现有扫描环形态），启动 30s 首轮；
  同时执行 presence 过期清理 + 写 `players:summary` Redis 快照（TTL 10 分钟）；
  多实例覆盖写 gauge 幂等；失败只 warn、不拖垮进程。
- 注册计数语义：账号记录创建且注册流程最终成功返回时 +1（若 device binding/签发失败，
  账号可能已存在但不计数——在 spec 里登记为已知偏差，测试覆盖）。
- 支付计数语义：只在条件 UPDATE 真正把 `paid→credited` 的那一次计数；补 notify/sync/scan
  重放测试，断言不重复。
- 统计 SQL 使用现有索引；若后续数据量大，改为每日 rollup 表（本片不做）。

### 5.2 看板 `08-players.json`

面板（查询一律带多实例聚合）：

1. 当前 WS 连接数（`sum(ws_connections)`，进程级口径）
2. 在线玩家（`max(players_online_presence)`，presence 口径）
3. 近 24 小时新增玩家（`sum(increase(user_registrations_total[1d]))`；标题明确「近 24h」）
4. 活跃玩家 1d / 7d / 30d（三个 gauge，`max(...)`）
5. 流失玩家 14d / 30d（两个 gauge，`max(...)`）
6. 近 24 小时充值金额（`sum(increase(payment_recharge_fen_total[1d])) / 100`，单位元）
7. 近 24 小时充值笔数（`sum(increase(payment_recharge_credited_total[1d]))`）
8. 注册/活跃/流失趋势（时间序列，同上聚合）
9. 总玩家数（`max(players_total)`）

- 面板标题明确「近 24 小时」vs 管理页「北京时间自然日」的差异；如需自然日趋势，后续加
  recording rule，本片不做。
- 看板放到 `deploy/monitoring/grafana/dashboards/08-players.json`，provider 自动加载。
- 面板阈值/告警：本片不新增告警规则；后续按运营需要加。
- 不用 MySQL 数据源；不用玩家级标签。

### 5.3 静态校验

新增 `scripts/verify-monitoring.mjs`（零依赖）：

- 所有 `deploy/monitoring/grafana/dashboards/*.json` 可解析、uid/title 唯一。
- `08-players.json` 的每个 target 引用的指标名在允许清单内（含新指标）。
- `08-players.json` 的 counter 查询必须含 `sum(`、gauge 必须含 `max(`/`avg(`（防多实例多序列）。
- `deploy/monitoring/prometheus/prometheus.yml` 仍覆盖 8 个 Nest + 上游 + 元监控。
- package.json 增加 `verify:monitoring`；**并入 `scripts/ci.sh` 与部署前检查清单**（防本地漏跑）。

## 6. 测试与验证

### Part A

- user-service：
  - 列表：分页、q/status/online/activity 筛选、排序、汇总计数、空结果、越界页。
  - 最近对局：limit 边界、无记录、userId 不存在。
  - `online` 字段：ZSCORE 命中/过期/Redis 失败降级。
  - 注册计数：成功 +1，失败不计数。
- room-service：
  - 连接写入、heartbeat 刷新、断线 ZREM、陈旧断线不误删、硬换手不重复。
- currency-service：批量余额 1–100、去重、非法 userId、空结果、越权。
- payment-service：批量充值汇总口径（credited_at）、无记录、越权。
- gateway：policy 矩阵（super_admin/operator 200；finance/viewer 403）；路由注册顺序。
- admin：`verify:admin` 增加新 id/路由/角色断言；jsdom 探针验证筛选、分页、详情、封禁确认、
  批量列合并、在线降级。
- 真栈：本地/测试服登录验证列表、封禁、解封、在线状态；批量端点缺 actor/超 100/去重；
  Redis 故障降级；空在线集。

### 测试夹具与构建顺序

- `packages/room-service/test/ws.gateway.test.ts` 的 `makeSocket` 补 `conn` 字段（heartbeat）。
- `packages/room-service/test/helpers/fake-redis.ts` 补 `zcount` / `zrangebyscore` / `zremrangebyscore`。
- `packages/shared` 新增 presence 常量后先 `pnpm --filter @fight-the-landlord/shared build`
  再跑依赖包测试（shared 的 main 指向 dist）。

### Conformance

- `slice-16-monitoring` C6：看板数量 7 → 8，`expectedTitles` 加入 `FTL 玩家与营收`（实际标题）；
  同步 `tools/conformance/baselines.json`。
- `slice-19-admin-rbac-audit` G5：P10–P13 四角色正反矩阵（super_admin/operator 200，
  finance/viewer 403），含尾斜杠/大小写/未知 query 变体；G12 增加 `players-view`、
  `nav-players-btn`、两个批量端点针脚；baseline 更新。
- 新增真栈探针：真实 WS 连接/断开验证在线；空在线集；Redis 故障降级；批量端点边界；
  PII 脱敏（按 D15 裁决）。

### CI / 部署前

- `scripts/ci.sh` 增加 `npm run verify:admin` 与 `npm run verify:monitoring`（若已有则确认）；
- 部署前检查清单加入这两条，防本地漏跑。

### Part B

- 指标单测：注册计数、充值计数/金额、统计任务 SQL 口径、gauge 覆盖写。
- `npm run verify:monitoring` 全绿。
- 真栈：Grafana 打开 08 看板，面板有数据；在线人数随 WS 连接变化。

### 回归

| 改动面 | 命令 |
|---|---|
| user/room/currency/payment | 各自 `pnpm -C packages/<pkg> test` + lint |
| gateway | `pnpm -C packages/api-gateway test` + lint |
| admin | `npm run verify:admin` + jsdom 探针 |
| 监控 | `npm run verify:monitoring` |
| 部署前 | 上述全绿 + `node --check admin/app.js` |

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 列表 SQL 在数据量大时变慢 | 派生表 + 索引；pageSize ≤100；后续每日 rollup |
| presence 多实例迟到断线误删 | 下一次心跳 ≤25s 自愈；文档登记；不引入连接代次表 |
| PII 泄露 | 仅 super_admin/operator；不导出 CSV；日志脱敏；Grafana 无手机号 |
| 批量端点增加跨服务延迟 | 并行调用；超时降级为「—」；单页最多 100 个 ID |
| Grafana 指标基数 | 无 userId 标签；只用固定枚举/无标签 |
| 统计任务拖慢库 | 5 分钟一轮、只读、索引覆盖；失败只 warn |
| 新路由落 P8 越权 | policy 显式规则 + 矩阵单测（finance/viewer 403） |
| PII 范围与既有财务/审计读面冲突 | 待 D15 裁决；不能同时承诺「全局仅超管/运营」与「不收紧既有读面」 |
| 列表/详情/Grafana 活跃口径不一致 | D18 canonical `lastActiveAt`；跨面一致性测试 |
| Prometheus 多实例多序列 | 查询统一 `sum(increase)` / `max`；verify-monitoring 断言 |
| 静态闸假绿/漏跑 | verify 脚本进 CI 与部署前检查；真栈探针补行为判据 |
| 现有风控/用户详情被误改 | 只加 `online` 字段；不改既有字段语义；回归现有测试 |

## 8. 涉及文件

**Part A**

- `packages/shared/src/presence/online.ts`（新）+ `index.ts` 导出
- `packages/room-service/src/gateway/ws.gateway.ts` + 测试
- `packages/user-service/src/players/admin-players.controller.ts`（新）
- `packages/user-service/src/players/admin-players.service.ts`（新）+ 测试
- `packages/user-service/src/players/players.module.ts`（新，或注册进 `app.module.ts`）
- `packages/user-service/src/app.module.ts`（modules/controllers/providers 注册）
- `packages/user-service/src/migrations/<ts>-UsersCreatedAtIndex.ts`（新）
- `packages/user-service/src/users/admin-users.controller.ts`（+online）+ 测试
- `packages/room-service/test/ws.gateway.test.ts` + `test/helpers/fake-redis.ts`（夹具）
- `packages/currency-service/src/admin/admin-wallet.controller.ts`（+batch）+ 测试
- `packages/payment-service/src/admin/admin-pay.controller.ts`（+players summary）+ 测试
- `packages/api-gateway/src/gateway/gateway.controller.ts`（+4 routes）
- `packages/api-gateway/src/auth/admin-policy.ts`（+P10–P13）+ 测试
- `admin/index.html` / `admin/app.js` / `admin/style.css`
- `scripts/verify-admin-static.mjs`
- `tools/conformance/src/slices/slice-16-monitoring.ts` / `slice-19-admin-rbac-audit.ts` +
  `tools/conformance/baselines.json`

**Part B**

- `packages/user-service/src/metrics/player.metrics.ts`（新）
- `packages/user-service/src/players/player-stats.service.ts`（新）+ 测试
- `packages/user-service/src/auth/auth.service.ts`（注册成功计数写点）+ 测试
- `packages/payment-service/src/metrics/payment.metrics.ts`（+2 counters）
- `packages/payment-service/src/scan/scan.service.ts`（`creditOrder` 返回 `credited` 时计数）+ 测试
- `deploy/monitoring/grafana/dashboards/08-players.json`（新）
- `scripts/verify-monitoring.mjs`（新）+ `package.json`
- `scripts/ci.sh`（verify 脚本接入）
- `docs/ops/first-deploy.md`（看板入口说明）

## 9. 审查记录

2026-10-22 独立 reviewer 对抗审查（基线：`dev` 工作树，未改代码）。

| 级别 | 发现 | 处置 |
|---|---|---|
| **阻断 B1** | spec 承诺「手机号仅 super_admin/operator」，但既有 `GET admin/users/:userId` 等读面落在 P8（任意已登录角色），财务/审计页面也展示 phone；同一份 spec 自相矛盾 | **已裁决（用户）**：仅玩家页限制；既有读面保持现状，登记为已知例外，spec 不再声称全局收紧（D15） |
| 高 H1 | presence 写点未定义失败方向，Redis reject 可能破坏连接生命周期 | 已修订 §4.1：一律 best-effort catch+warn；`socket.conn?.on`；详情 Redis 失败 online:false |
| 高 H2 | 新控制器/service/stats 未列模块注册，路由会 404、统计任务不运行 | 已修订 §8：加 `players.module.ts` / `app.module.ts` 注册；真栈必须实际请求 |
| 高 H3 | 只加 `VIEWS.players`，缺 `VIEW_ORDER`/监听/切换/登出接线 | 已修订 §4.7：成套接线 + resetPlayers + verify 针脚 |
| 高 H4 | policy 谓词/query 白名单/路径编码未定义 | 已修订 §4.5：P10 精确、P11 前缀+后缀、P12/P13 精确；严格白名单；encodeURIComponent |
| 高 H5 | conformance slice-16 恰 7 看板会红；slice-19 未覆盖新 policy/针脚；静态闸行为判别力不足 | 已修订 §6：C6 7→8、G5/G12 扩展、baseline、真栈探针、verify 进 CI |
| 高 H6 | 全量聚合、无稳定排序、空在线集、缺 createdAt 索引、q 未转义 | 已修订 §4.2/D16/D17：page-first、tie-breaker、空集处理、迁移、转义、summary 快照 |
| 高 H7 | 列表/风控详情/Grafana 的活跃、对局、设备口径互相矛盾 | 已修订 D18：canonical lastActive、mode 过滤、设备窗口统一；补跨面一致性测试 |
| 高 H8 | Prometheus 多实例多序列；ws_connections 与 presence 在线口径不同 | 已修订 §5.1/§5.2：sum(increase)/max；拆两个在线面板；新增 presence gauge |
| 高 H9 | 北京时间自然日与 rolling 24h 混用 | 已修订 §4.2/§5.2：`CONVERT_TZ` 自然日；看板标题「近 24 小时」 |
| 高 H10 | 直接复用风控动作条会带出五动作并刷新错列表 | 已修订 §4.7：玩家页独立 ban/unban 动作条；刷新玩家列表/详情；透传 bannedFlagPresent |
| 高 H11 | 批量端点缺 200/信封/actor/上限/空集/金额类型/退款口径 | 已修订 §4.4/D19：200 + `{code,data}` + actor + 1–100 + toSafeInt + 毛充值口径 |
| 高 H12 | 注册/充值指标写点语义不精确，失败/重放会数错 | 已修订 §5.1：注册成功返回点计数；仅 `creditOrder==='credited'` 计数；补重放测试 |
| 低 L1 | 心跳自愈写 25s，实际 pingInterval=30s | 已改 30s |
| 低 L2 | room 测试夹具缺 `conn`，fake Redis 缺 zcount/zrangebyscore | 已列 §6 夹具清单 |
| 低 L3 | pageSize 枚举不一致 | 已统一 10/20/50/100 |
| 低 L4 | 支付订单端点固定 50 条，不能取 20 | 已注明前端切片 |
| 低 L5 | 最近对局端点边界未定义 | 已补 limit/404/tie-breaker/过滤 |
| 低 L6 | verify 脚本未进 CI | 已列 §6 CI |
| 低 L7 | shared 新导出依赖 dist 构建 | 已列构建顺序 |
| 低 L8 | presence 清理/时钟偏差 | 已改由 5 分钟统计任务清理；时钟偏差登记 |
| 低 L9 | 用户详情 online Redis 降级未写 | 已补 |
| 低 L10 | q 通配符 / SUM 字符串类型 | 已补转义与 toSafeInt |
| 低 L11 | 设备解绑跳转未落 UI | 已补风控视图入口 |

结论：阻断 B1 已由用户裁决（仅玩家页限制，既有读面登记为例外）；其余高/低项已修订。可进入实现计划（A1/A2/B 三个切片）。
