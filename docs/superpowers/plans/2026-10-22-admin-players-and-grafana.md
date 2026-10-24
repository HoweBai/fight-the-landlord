# 玩家管理页 + Grafana 玩家与营收看板 — 实现计划

> 对应 spec：`docs/superpowers/specs/2026-10-22-admin-players-and-grafana-design.md`（已过对抗审查与 PII 裁决）
> 三个可独立交付的切片：A1（presence + API + 网关）、A2（admin 页面）、B（Grafana）。

**Goal:** 后台可查看/筛选/封禁玩家；Grafana 可看在线、新增、活跃、流失、充值趋势。

**Architecture:** 服务边界内聚合：room-service 写 Redis presence；user-service 出列表/最近对局；currency/payment 出批量汇总；gateway 加路由与 policy；admin 新增「玩家」页；Grafana 加指标与 08 看板。

## Global Constraints

1. 不改协议、配置键、数据库业务表（仅加 `users(createdAt)` 索引迁移）。
2. 新路由角色仅 `super_admin|operator`；policy 显式规则在 P8/P9 之前。
3. presence 写点 best-effort，不得影响连接/断线主流程。
4. 所有管理响应 `{code:0,data:...}`；POST 管理端点 `@HttpCode(200)`。
5. 手机号仅玩家页限制；既有财务/审计读面不动（D15）。
6. 每个任务先测后实现，绿后提交；commit 带 attribution。
7. 回归：受影响包 test+lint、`npm run verify:admin`、`npm run verify:monitoring`。

---

## A1 — presence + 后端 API + 网关

### A1.1 shared presence 常量

**Files:** `packages/shared/src/presence/online.ts`（新）、`packages/shared/src/index.ts`

```ts
export const ONLINE_USERS_KEY = 'presence:online';
export const ONLINE_TTL_MS = 60_000;
export const ONLINE_PRUNE_MS = 5 * 60_000;
```

- 导出经 barrel；先 `pnpm --filter @fight-the-landlord/shared build`，再跑依赖包。
- 测试：常量值/导出可用（shared test）。

### A1.2 room-service presence 写入

**Files:** `packages/room-service/src/gateway/ws.gateway.ts`、`test/ws.gateway.test.ts`、`test/helpers/fake-redis.ts`

- `handleConnection`：`activeConnections.set` 后 `void this.touchPresence(userId).catch(warn)`；
  `touchPresence = (id) => this.redis.zadd(ONLINE_USERS_KEY, Date.now(), id)`。
- `socket.conn?.on('heartbeat', () => { void this.touchPresence(userId).catch(warn); })`。
- `handleDisconnectInner`：陈旧断线早返之后、`activeConnections.delete` 之后
  `void this.redis.zrem(ONLINE_USERS_KEY, userId).catch(warn)`。
- 测试夹具 `makeSocket` 补 `conn: { on: vi.fn() }`；fake Redis 补 `zadd/zrem/zcount/zrangebyscore/zremrangebyscore`。
- 测试：连接 zadd、heartbeat 回调 zadd、断线 zrem、陈旧断线不 zrem、Redis reject 不影响连接/断线。

**Commit:** `feat(room): 在线 presence 写入 Redis`

### A1.3 user-service 玩家列表 / 最近对局 / online

**Files:**
- `packages/user-service/src/players/admin-players.controller.ts`（新）
- `packages/user-service/src/players/admin-players.service.ts`（新）
- `packages/user-service/src/players/players.module.ts`（新；**显式 imports ConfigCacheModule/UsersModule**，非 @Global 依赖不随 AppModule 传递）
- `packages/user-service/src/app.module.ts`（import PlayersModule）
- `packages/user-service/src/users/admin-users.controller.ts`（+online）
- `packages/user-service/src/migrations/<new>-UsersCreatedAtIndex.ts`
- 测试：`test/admin-players.controller.test.ts`、`test/admin-players.service.test.ts`、users controller 测试

接口：

```ts
GET /api/admin/players?q&status&online&activity&page&pageSize&sort
GET /api/admin/players/:userId/games?limit
```

- 控制器：`@Controller('admin/players') @UseGuards(XAdminGuard)`；
  `@Get()` 严格 query 白名单，未知键 400；`@Get(':userId/games')`，`:userId` 编码前先做 1..36 校验。
- 服务：`list(filter)` page-first（第一步取页 userIds + last_active，第二步只聚合当页）；
  统一口径见 spec D18；`online` 读 Redis；Redis 失败降级。
- **lastActive 用 CASE 返回 NULL**（两者都无 ⇒ null，不用 1970 哨兵）；`inactive` 单独排除 never-active。
- **summary 在 A1 实时计算 + 60s 内存缓存**（B 阶段再复用统计任务快照）；避免 A1 依赖 B1。
- `AdminUsersController.detail` 增加 `online`（Redis ZSCORE > now-60s；失败 false）。
- 迁移：`CREATE INDEX idx_users_created_at ON users (createdAt)` / down drop。
- 测试：分页/筛选/排序/tie-breaker、空在线集、q 转义、summary 60s 缓存、
  games limit/404、online 降级。
- **真容器解析测试**：TestingModule 实例化 PlayersModule，证明 controller/service/provider 已注册
  （防「单测全绿、真容器 404」）。
- 迁移单测：`UsersCreatedAtIndex` 的列名与 down。

**Commit:** `feat(user): 玩家列表与最近对局 API`

### A1.4 currency 批量余额

**Files:** `packages/currency-service/src/admin/admin-wallet.controller.ts`、测试

```ts
@Post('accounts/batch') @HttpCode(200)
async batch(@Body() body, @Req() req): Promise<{code:0,data:{accounts:...}}>
```

- body `{userIds}`：数组、1–100、去重、每个 1–36；否则 400 10001。
- 查询 `currency_accounts WHERE owner_id IN (...)`；未开户 0/false；`toSafeInt`。
- 测试：正常/去重/空数组/101/非法/未开户/缺 actor 401。

**Commit:** `feat(currency): 管理面批量余额查询`

### A1.5 payment 批量充值汇总

**Files:** `packages/payment-service/src/admin/admin-pay.controller.ts`、测试

```ts
@Post('players/summary') @HttpCode(200)
async playersSummary(@Body() body): {code:0,data:{players:[...]}}
```

- 同校验；`payment_orders WHERE user_id IN (...) AND credited_at IS NOT NULL`
  `COUNT(*) / SUM(amount_fen) / MAX(credited_at)`；`toSafeInt`。
- 测试：口径、无记录、去重、边界、缺 actor。

**Commit:** `feat(payment): 管理面玩家充值汇总`

### A1.6 gateway 路由 + policy

**Files:** `packages/api-gateway/src/gateway/gateway.controller.ts`、`src/auth/admin-policy.ts`、测试

- 路由：`GET admin/players`、`GET admin/players/:userId/games`、
  `POST admin/wallet/accounts/batch`、`POST admin/pay/players/summary`。
- query 白名单：players 7 键、games 仅 `limit`；未知键 400；`:userId` encodeURIComponent。
- policy：P10 精确 players、P11 `players/`+`/games` 前缀、P12/P13 精确 POST；
  super_admin|operator；置于 P8/P9 之前。
- 测试：四角色正反、尾斜杠、大小写、未知 query、超长 limit。

**Commit:** `feat(gateway): 玩家管理路由与角色策略`

---

## A2 — admin 玩家页

### A2.1 静态骨架 + 静态闸（先红）

**Files:** `admin/index.html`、`scripts/verify-admin-static.mjs`

- 运营组新增 `<button id="nav-players-btn">玩家</button>`；
  `<section id="players-view" class="page-view" hidden>`，含汇总卡片容器、筛选栏、表格、分页、
  详情面板（同页切换）、封禁弹窗复用现有 modal。
- `verify-admin-static` 新增：id 针脚、`VIEWS.players` roles、`VIEW_ORDER` 含 players、
  API 路径针脚、零 innerHTML 持续断言。
- 先跑红。

### A2.2 app.js 接线 + 渲染

**Files:** `admin/app.js`

- `VIEWS.players = {el:'players-view', nav:'nav-players-btn', roles:['super_admin','operator']}`；
  `VIEW_ORDER` 在 wallet 前插 `players`；`wire()` 加 click；`switchView` 加 `loadPlayers`；
  `showLoginView` 调 `resetPlayers()`。
- 状态：`playersState = {filter, page, pageSize, rows, total, summary, detail, loading}`。
- `loadPlayers()`：`GET /api/admin/players` + 并行 `POST wallet/batch` + `POST pay/players/summary`；
  失败列降级「—」；渲染汇总/表格/分页。
- 详情：点击行 → 并行 `GET admin/users/:id`、`GET admin/risk/users/:id`、
  `GET admin/wallet/accounts/:id`、`GET admin/pay/orders?userId=`、
  `GET admin/players/:id/games`；渲染资料/余额/充值/对局/设备/风控。
- 封禁/解封：确认 + reason 输入；`POST /api/admin/risk/actions`；成功刷新列表/详情。
- 解绑设备：已绑定时显示按钮；确认后 `DELETE /api/admin/risk/users/:userId/device-binding`；成功后就地重拉详情。
- 全部 createElement/textContent。
- 测试：`verify:admin` 绿；新增 **`scripts/admin-players-probe.mjs`（jsdom，经 apps/client 解析）** 覆盖
  筛选/分页/详情/封禁确认/批量列/在线降级；接入 `verify:admin` 或 CI。

### A2.3 样式

**Files:** `admin/style.css`

- 汇总卡片、筛选栏、表格、分页、详情面板；复用现有 `.panel`/`.data-table`/`.btn` 令牌。

**Commit:** `feat(admin): 玩家管理页`

---

## B — Grafana 玩家与营收

### B1 user-service 指标 + 统计任务

**Files:** `src/metrics/player.metrics.ts`（新）、`src/players/player-stats.service.ts`（新）、
`src/auth/auth.service.ts`、`src/app.module.ts`、测试

- 指标：`user_registrations_total`、`players_total`、`players_active_1d/7d/30d`、
  `players_inactive_14d/30d`、`players_online_presence`。
  **必须用 shared `createCounter/createGauge` + `ReturnType<typeof ...>` 注解**，并断言 `/metrics` 输出面。
- 注册成功返回点 `inc()`（失败路径不计）。
- `PlayerStatsService`：5 分钟自重排，启动 30s 首轮；SQL 用 canonical lastActiveAt；
  写 gauge + `players:summary` Redis 快照（TTL 10 分钟）+ presence 过期清理；失败 warn。
- 测试：计数、SQL 口径、gauge 覆盖、清理、生命周期。

### B2 payment 充值指标

**Files:** `src/metrics/payment.metrics.ts`、`src/scan/scan.service.ts`、测试

- `payment_recharge_credited_total` / `payment_recharge_fen_total`；
  仅 `creditOrder` 返回 `credited` 时计数；重放/`already`/`stalled` 不计。
- **`SELECT_CREDIT_TARGET_SQL` 增加 `amount_fen`** 与行类型（否则金额累加 undefined）。

### B3 看板 + 校验

**Files:** `deploy/monitoring/grafana/dashboards/08-players.json`（新）、
`scripts/verify-monitoring.mjs`（新）、`package.json`、`scripts/ci.sh`

- 9 个面板（见 spec §5.2），counter `sum(increase())`、gauge `max()`。
- `verify:monitoring`：JSON 可解析、uid/title 唯一、指标白名单、聚合函数、scrape 面；
  如环境有 `promtool` 则跑 `promtool check rules`（无则跳过）。
- 接入 CI 与部署前检查。

### B4 conformance

**Files:** `tools/conformance/src/slices/slice-16-monitoring.ts`、
`slice-19-admin-rbac-audit.ts`、`tools/conformance/baselines.json`

- C6：7 → 8 看板 + 标题。
- G5：P10–P13 四角色矩阵；G12：players 针脚。
- baseline 更新；`pnpm exec turbo run lint build --filter=./tools/conformance --force`。

### B5 文档

- `docs/ops/first-deploy.md`：Grafana 看板入口与口径说明。

**Commit:** `feat(monitoring): 玩家与营收看板`

---

## 验证与交付

```bash
pnpm --filter @fight-the-landlord/shared build
pnpm -C packages/user-service test && pnpm -C packages/user-service lint
pnpm -C packages/room-service test && pnpm -C packages/room-service lint
pnpm -C packages/currency-service test && pnpm -C packages/currency-service lint
pnpm -C packages/payment-service test && pnpm -C packages/payment-service lint
pnpm -C packages/api-gateway test && pnpm -C packages/api-gateway lint
npm run verify:admin
npm run verify:monitoring
node --check admin/app.js
pnpm exec turbo run lint build --filter=./tools/conformance --force
```

- 真栈：本地/测试服验证列表、在线、封禁/解封、Grafana 08 看板；
  slice-19 增加玩家路由四角色与批量边界探针（做不到则登记降级清单）。
- 代码审查：一个独立 reviewer 审 `BASE..HEAD`；Critical/Important 必修。


## 计划审查记录

2026-10-22 独立 reviewer（简短模式）：1 阻断 + 6 高 + 6 低，均已处置：

- 阻断：PlayersModule 显式 imports ConfigCacheModule/UsersModule，并加真容器解析测试。
- 高：admin 探针落点改为 `scripts/admin-players-probe.mjs` 并接入 verify；summary 前置到 A1（60s 缓存）；
  lastActive 用 CASE 返回 NULL；指标走 shared 构造器 + `/metrics` 断言；creditOrder SQL 补 amount_fen；
  两 GET/两 POST 补真容器/HTTP 探针。
- 低：真栈探针、RISK_STATS 口径措辞、summary 8 字段、onlineNow 实时 ZCOUNT（快照仅降级）、
  promtool 可选、迁移 up/down 测试。

结论：可开工。

## 执行结果（2026-10-22）

**提交**：`fa92c5d8`（shared presence）→ `62c47392`（room presence）→ `0e962540`（user 列表/对局/online）
→ `a42923be`（currency/payment 批量）→ `15b4f44b`（gateway P10–P13）→ `3c3357f3`（admin 玩家页）
→ `33ede639`（指标/统计/08 看板）→ `bb1f7171`（C6/文档）→ `103bb70b`（审查修复）。

**验证**

- shared presence 1；room-service 749；user-service 310；currency-service 386；payment-service 456；
  api-gateway 473（各包 test + lint 全绿）。
- `npm run verify:admin` 304 checks；`npm run verify:admin-players` 15 项；
  `npm run verify:monitoring` 87 checks；`node --check admin/app.js`。
- conformance lint/build 4/4；slice-16 C6 已改为 8 看板。

**代码审查**：0 Critical / 6 Important / 6 Minor；Important 已修（快照读取、在线降级/上限、
封禁确认弹窗与 orphan 旗、presence 测试判别力、注册计数点、分页 clamp、监控严格校验）。

**已知未做（登记为后续）**

- slice-19 G5 的 P10–P13 **真栈**四角色矩阵与 baseline 回填（本次由 policy 单测矩阵覆盖；
  真栈矩阵需部署后跑 conformance）。
- PlayersModule 的真容器/HTTP 探针、列表 SQL 的专项分页/筛选/q 转义测试、
  payment 指标写路径单测（本次以 service 映射/口径测试覆盖）。
- 真栈部署与 Grafana 08 看板实机验收。
