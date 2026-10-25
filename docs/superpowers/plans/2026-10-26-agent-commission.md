# 代理分润（台费佣金）—— 实现计划

- 日期：2026-10-26
- Spec：`docs/superpowers/specs/2026-10-26-agent-commission-design.md`（v1.1，r1 审查已处置）
- 分支：`dev`（日常开发；不推 master、不打 tag、不部署，除非用户明确发话）
- 提交纪律：每个任务一个 commit；消息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## 全局约束

1. **写边唯一**：所有佣金/额度只经 `ApplyService.applyWithEffect` 的内置钩子写入；不得新增第二条写边。
2. **故障隔离**：钩子只吞语句级错误；1213/1205/连接错误/保存点回滚失败一律重抛。
3. **幂等**：`currency_ops.uk_action_id` + `agent_revenue_events(source_op_id, owner_id)` + `agent_commission_entries(source_op_id, agent_id)` 三层唯一键。
4. **归属只从 token 取**：代理门户所有查询 `WHERE agent_id = token.sub`；不得接受 query/body 的 agentId。
5. **计数闸**：protocol 94 / active 78 / client 22 / verify:admin IA 78 / CONTROLS 73 / BOOL 36 / NOTES 66；`errors.test.ts` SPEC_CODES 与 `CLIENT_ACTION` 全量。
6. **不新增容器/端口**；edge 只加 `/agent` 静态路由；currency→user 新增内部 RPC 边。
7. **真栈边界**：假 DB 只钉控制流；并发/死锁/水位必须用真 MySQL（slice-30）。Docker 未跑时交付报告明说。

---

## 任务 1：protocol 契约（错误码/配置键/RPC）

**Files**
- `packages/protocol/src/errors.ts`、`errors.test.ts`
- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/protocol/src/rpc.ts`、`packages/protocol/src/index.ts`

**Interfaces**
- `ErrCode.AGENT_INVITE_INVALID=11006`、`AGENT_FROZEN=11007`、`AGENT_SETTLEMENT_MIN=14011`、`AGENT_SETTLEMENT_PENDING=14012`、`AGENT_SETTLEMENT_STATE=14013`、`AGENT_RATE_INVALID=14014`；`CLIENT_ACTION` 全部 TOAST（11007 可 TOAST）。
- `CONFIG_KEYS` 尾部追加 `agent.inviteEnabled`；`CLIENT_CONFIG_KEYS` 追加 `agentInviteEnabled`；`parseConfigValue` 增加 `key === 'agent.inviteEnabled' → parseStrictBoolean`。
- `RPC_PATTERNS.agentBind='agent.bind'`、`userAgentProfileGet='user.agentProfile.get'`；导出类型 `AgentBindRequest/Response`、`UserAgentProfileGetRequest/Response`。

**TDD**
1. 写 `errors.test.ts`：SPEC_CODES 追加 6 码；`CLIENT_ACTION` 全量断言（既有检查会自动覆盖）。
2. 写 `config.test.ts`：`CONFIG_KEYS` 含新键、`CLIENT_CONFIG_KEYS` 含裸名、`parseConfigValue('agent.inviteEnabled', true/false/'x')` 的接受/拒绝。
3. 跑红。
4. 实现。
5. 跑绿：`pnpm -C packages/protocol test`、`pnpm -C packages/protocol run lint`。
6. 提交。

**回归**：protocol 全量（预计 293+新增）。

---

## 任务 2：config-service 客户端键 + 种子 + 管理端 IA

**Files**
- `packages/protocol/src/config.ts`（任务 1 已改）
- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/migrations/<新时间戳>-AgentInviteKey.ts`（不得与 currency 的 `1797000000000` 撞号）
- `packages/config-service/test/client-config.test.ts`、`test/migration.test.ts`
- `admin/app.js`（CONFIG_IA/CONFIG_CONTROLS/CONFIG_NOTES）
- `scripts/verify-admin-static.mjs`（93→94、77→78、77→78、72→73、35→36、65→66）

**Interfaces**
- `/api/config` 响应增加 `agentInviteEnabled: boolean`（缺行/false）。
- 迁移种子：`('agent.inviteEnabled','false',1,NOW(3),'seed')`；down 删除该行。
- IA：新「代理」域 + `switches` 页签；`CONFIG_CONTROLS` 条目 `type:'bool'`；`CONFIG_NOTES` 一条。

**TDD**
1. `client-config.test.ts` 精确键集 21→22 + 新键默认 false。
2. `migration.test.ts` 种子存在/回滚。
3. 跑红。
4. 实现（迁移/控制器/app.js/verifier）。
5. 跑绿：`pnpm -C packages/config-service test`、`pnpm verify:admin`。
6. 提交。

---

## 任务 3：currency-service 迁移 + 纯函数（math）

**Files**
- `packages/currency-service/src/migrations/1797000000000-AgentDomain.ts`（14 张表 + 种子 settings 行）
- `packages/currency-service/src/agent/agent.constants.ts`（source×用途矩阵、限额默认、错误文案）
- `packages/currency-service/src/agent/commission.math.ts`
- `packages/currency-service/test/agent-domain.migration.test.ts`、`agent-commission-math.test.ts`

**Interfaces**
- `classifySource(source): 'quota_in'|'quota_out'|'entry_fee'|'none'`（13 源全覆盖；未知/新增断言）。
- `computeChainPayouts({base, chain, playerPhoneHash}): Array<{agentId,level,rateBp,paidBp,micro}>`；冻结/自玩/负级差按 spec §2.3；返回 `topRateBp/expectedMaxMicro`。
- `applyQuotaDelta({inflow, consumed, delta, direction})` 纯函数：正入全额/受日限；负出 `min(abs, max(0, inflow−consumed))`。

**TDD**
1. math 测试：随机 fee/非增比例/冻结/自玩集合；逐行 `micro=base×paid_bp`、`0≤Σ≤base×top`；小额累计；负级差；顶层自玩；冻结+自玩优先级；重复 agent/环/深度。
2. 迁移测试：14 表、索引、种子行、`ENGINE/CHARSET` 逐字、类名不以 `Currency` 开头。
3. 跑红 → 实现 → 绿。
4. 提交。

**命令**：`pnpm -C packages/currency-service test`、`run lint`。

---

## 任务 4：AgentModule 装配 + settings + 额度服务

**Files**
- `packages/currency-service/src/agent/agent.module.ts`
- `.../agent/agent-settings.service.ts`（单行读写、super_admin 更新、audit）
- `.../agent/agent-quota.service.ts`（原子 upsert、FOR UPDATE、正/负入账、admin 日限、hold）
- `.../agent/agent-quota-maturity.service.ts`（`setInterval` + `SKIP LOCKED`，默认 0 时空转）
- `packages/currency-service/src/rpc/rpc.module.ts`（imports AgentModule）
- `packages/currency-service/src/app.module.ts`（imports AgentModule/controllers）
- 测试：`agent-settings.test.ts`、`agent-quota.test.ts`、`agent-wiring.test.ts`（容器注册面）

**Interfaces**
- `AgentSettingsService.get(manager?)`：同事务读；`enabled/effective_from/coin_per_yuan/...`。
- `AgentQuotaService.applyDelta(manager, {ownerId, source, delta, at})`：原子 upsert + 锁；返回 `{inflow, consumed, available}`。
- `AgentModule` exports `AgentLedgerService`（任务 5）与 settings/quota；`RpcModule` imports `AgentModule`（保证 `ApplyService` 可注入）。

**TDD**
1. 假 DB：原子 upsert SQL、正/负入账上限、admin 日限、hold 分支、幂等。
2. 装配测试：`Reflect.getMetadata('providers'/'imports', ...)` 钉 AgentLedger 在 RpcModule 可见面。
3. 跑红 → 实现 → 绿 → 提交。

---

## 任务 5：ApplyService 内置钩子 + revenue/commission 写入

**Files**
- `packages/currency-service/src/apply/apply.service.ts`
- `packages/currency-service/src/agent/agent-ledger.service.ts`
- `.../agent/agent-gap.service.ts`（独立连接 best-effort）
- `.../agent/agent.metrics.ts`
- 测试：`agent-ledger.test.ts`、`apply-agent-hook.test.ts`、`agent-gap.test.ts`

**Interfaces**
- `ApplyService` 构造注入 `AgentLedgerService`；`applyWithEffect` 在调用方 effect 后调用 `agentLedger.onApply(manager, {opId, actionId, source, entries, refId})`，保存点协议按 spec §4.1。
- `AgentLedgerService.onApply`：settings 判定 → 每 entry 额度/台费分支 → revenue event（bound/unbound/skipped）→ 佣金行 → gap/metric。
- 钩子失败：语句级 savepoint 回滚 + gap + metric；1213/1205/连接错误重抛。

**TDD**
1. 假 manager：首次台费 → 1 revenue + N 佣金；重放不跑钩子；未绑定 → unbound event；额度耗尽 → skipped；钩子抛语句级错 → 主事务继续 + gap；抛 1213 → 重抛。
2. `apply.test.ts` 回归：既有 effect（记牌器）不受影响；`agent.enabled=false` 零查询。
3. 跑红 → 实现 → 绿。
4. 提交。

---

## 任务 6：代理账号/邀请码/绑定 + bind RPC

**Files**
- `.../agent/agent-accounts.service.ts`（CRUD/树/比例/状态/密码/收款/settings 更新/审计）
- `.../agent/agent-invite.service.ts`（生成/轮换/校验）
- `.../agent/agent-bindings.service.ts`（bind/rebind/bulk/history/phone hash）
- `.../agent/agent-bind.rpc.controller.ts`（`agent.bind`）
- `.../agent/agent-password.ts`（scrypt）
- 测试：`agent-accounts.test.ts`、`agent-invite.test.ts`、`agent-bindings.test.ts`、`agent-bind.rpc.test.ts`

**Interfaces**
- `agent.bind`：同事务校验两个开关/码/代理状态；`INSERT IGNORE` 首绑；history；`{status:'bound'|'ignored'}`；无效码 `AGENT_INVITE_INVALID`。
- 树/比例：`parent.rate ≥ self.rate ≥ max(children.rate)`、深度 ≤5、无环；锁相关行；`AGENT_RATE_INVALID`。
- 轮换：锁 agent 行；旧 revoked + 新 active。
- 批量改绑：500/批、keyset、独立事务、目标 active。
- `phone_hash = HMAC-SHA256(normalize(phone), AGENT_PHONE_HMAC_KEY)`；生产缺失启动 fail-closed（main.ts 或 module init）。

**TDD**
1. 假 DB + 双会话不可用时用控制流测试：绑定幂等、invalid/ignored、2×2 开关、树不变量、轮换并发（锁 SQL 断言）、批量分块。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 7：结算 + 人工调账

**Files**
- `.../agent/agent-settlement.service.ts`
- `.../agent/agent-adjustment.service.ts`
- 测试：`agent-settlement.test.ts`、`agent-adjustment.test.ts`

**Interfaces**
- 申请：agent 行锁、pending 唯一、`client_request_id` 作用域、水位 `(from,to]`、sum/carry/min/hash、payout 快照。
- 打款：锁双行、水位/carry 校验、重算 sum+hash、paid。
- 驳回/撤回：清 pending。
- 调账：pending→approved（另一 super_admin）→ 插 manual 佣金行；日限锁；audit。
- `items_hash` 规范串（spec §6.2）。

**TDD**
1. 假 DB：申请/打款/驳回/撤回、最低额、负余额、hash 不一致、跨代理 client_request_id、pending 期间新行不进本单、调账双人/限额。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 8：代理认证 + 门户 API

**Files**
- `.../agent/agent-auth.service.ts`（login/密码/JWT 签发/失败计数/token_version）
- `.../agent/agent.guard.ts`（`x-agent-id`/ver/must_change/冻结）
- `.../agent/agent-portal.controller.ts`、`.../agent/agent-portal.service.ts`
- `.../agent/agent-user.client.ts`（currency→user 昵称/profile）
- 测试：`agent-auth.test.ts`、`agent-guard.test.ts`、`agent-portal.test.ts`、`agent-user.client.test.ts`

**Interfaces**
- `POST /api/agent/login`、`POST /api/agent/password`、`GET /api/agent/me|overview|players|commissions|settlements`、`POST /api/agent/settlements`、`POST /api/agent/settlements/:id/cancel`。
- 所有查询强制 agent 作用域；昵称 RPC 失败降级；脱敏手机号；v1 无搜索。
- `must_change_password` 服务端强制；冻结只读+结算；`token_version` 校验。

**TDD**
1. 假 DB：登录成功/失败/锁定、must_change 放行面、冻结、IDOR、分页、昵称降级。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 9：管理端代理 API（含审计/对账/设置）

**Files**
- `.../agent/agent-admin.controller.ts`、`.../agent/agent-admin.service.ts`
- `.../agent/agent-reconcile.service.ts`
- 测试：`agent-admin.test.ts`、`agent-reconcile.test.ts`

**Interfaces**
- 端点按 spec §9.1；`XAdminGuard` + actor；audit before/after；settings 更新 super_admin；收款更新 super_admin；重置密码/轮换码/冻结/批量改绑。
- 对账：台费流水 vs revenue event；entry manual；已结/已付；gap 列表；gauge。
- 路由声明序：字面路由先于 `:id`。

**TDD**
1. 假 DB：每个端点权限/参数/审计；对账恒等式；gap 列表。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 10：网关（agent 中间件/转发/路由/policy/限流）

**Files**
- `packages/api-gateway/src/auth/agent.middleware.ts`（新）
- `.../auth/jwt.middleware.ts`（跳过 agent）
- `.../auth/public-paths.ts`（AGENT_PREFIX/isAgentPath）
- `.../auth/identity-headers.ts`（agentId 产出/转发）
- `.../auth/admin-policy.ts`（显式 P 条目 + config 字面键）
- `.../http/http-rate-limit.middleware.ts`、`.../http/rate-limit.ts`（agent login IP 桶）
- `.../gateway/gateway.controller.ts`（agent + admin agent 路由）
- `.../gateway/proxy.gateway.ts`（`X-Agent-Id` 映射）
- `.../app.module.ts`（中间件顺序）
- 测试：`agent.middleware.test.ts`、`agent-routes.test.ts`、`admin-policy.test.ts`、`identity-headers.test.ts`、`rate-limit.test.ts`

**Interfaces**
- 中间件顺序：ClientGate → Jwt（跳过 agent/admin）→ Admin → **Agent** → RateLimit。
- 所有路径剥 `x-agent-id`；`/api/agent/login` 豁免 Agent 验签；其余 `aud/typ/sub` 校验后注入。
- 转发：`DownstreamHeaders.agentId`，仅 `/api/agent/*` 产出；`forward()` → `X-Agent-Id`。
- policy：agent admin 显式条目在 P8/P4 之前；config 字面键 super_admin。
- 限流：`/api/agent/login` IP 5/5min（失败计次、成功清零）。

**TDD**
1. 交叉鉴权：玩家/代理/管理 token 互调 401/403；伪造 `x-agent-id` 被剥；转发断言。
2. policy 矩阵：viewer/operator 403、finance 结算可/代理管理不可、super_admin 全。
3. 跑红 → 实现 → 绿 → 提交。

---

## 任务 11：user-service（注册 bind + profile RPC）

**Files**
- `packages/user-service/src/users/users.dto.ts`（inviteCode）
- `.../auth/auth.service.ts`（生成 userId → bind → grant → 落库）
- `.../currency/currency.client.ts`（agentBind/profile 发送）
- `.../rpc/user-agent-profile.rpc.controller.ts`（新）
- `.../app.module.ts`
- `.../http/errors.ts`
- 测试：`auth.register-agent.test.ts`、`agent-profile.rpc.test.ts`、`currency-client.test.ts`

**Interfaces**
- `agent.bind` 调用（3s、不重试、信封）；invalid ⇒ `AGENT_INVITE_INVALID` 400；transport ⇒ 10007。
- `user.agentProfile.get {userId}` → `{nickname, phone}`（不存在 ⇒ null）。
- `AGENT_FROZEN`/new codes HTTP mapping.

**TDD**
1. 注册带码成功/无效码/功能关/传输失败/未带码；profile RPC 单条/不存在/非法。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 12：客户端注册邀请码

**Files**
- `apps/client/src/pages/login/login.vue`
- `apps/client/src/net/rest.ts`
- `apps/client/src/stores/auth.ts`
- 客户端配置类型/存储
- 测试：`test/login*.test.ts`、`test/auth*.test.ts`、`test/config*.test.ts`

**Interfaces**
- `agentInviteEnabled` 控制字段渲染；注册态可选输入；trim/uppercase；空不发送。
- `register(phone,password,nickname,inviteCode?)`；`signUp` 透传。
- 11006 文案「邀请码无效，请确认后重试」。

**TDD**
1. 字段不渲染/渲染、提交带值/不带值、11006 文案。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 13：管理后台代理 UI

**Files**
- `admin/app.js`、`admin/index.html`、`admin/style.css`
- `scripts/verify-admin-static.mjs`（如有新 id/视图锚点）

**Interfaces**
- 「代理」导航区；代理树/玩家归属/结算队列/调账/对账/审计/设置；只读角色隐藏写按钮。
- 零 innerHTML 门禁；`VIEWS` roles/`VIEW_ORDER`/锚点按 verifier 要求。
- 结算打款/驳回、调账双人、批量改绑 dry-run、审计列表。

**TDD**
1. 扩展 `verify:admin` 断言（新视图 id/roles/关键函数）。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 14：代理门户静态站 + edge

**Files**
- `agent/index.html`、`agent/app.js`、`agent/style.css`
- `Dockerfile.edge`（`COPY agent /srv/agent`）
- `deploy/Caddyfile`（`/agent` + `/agent/*`）
- `scripts/verify-agent-static.mjs`（新，基础断言）

**Interfaces**
- 登录/概览/玩家/佣金/结算/我的；fetch 带 Bearer；11006/14011/14012/14013 文案；手机优先。

**TDD**
1. 静态断言（必需 id/API 路径/无内联脚本注入）。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 15：conformance slice-30 + 全量验证 + 代码审查

**Files**
- `tools/conformance/src/slices/slice-30-agent.ts`
- 交付报告/计划勾选

**内容**
- 真 MySQL：额度首建并发/死锁、savepoint 回滚后主事务、水位结算双会话、驳回/打款/复核、配置计数、鉴权交叉。
- 全量命令：各包 test/lint、client test/lint、`pnpm verify:admin`、`pnpm test`（尽力）。
- 代码审查：独立 reviewer 审 `BASE..HEAD`；Critical/Important 修完补测。
- 交付报告：变更/验证证据/SHA/是否推送部署/已知边界。

---

## 执行顺序与依赖

```
1 protocol → 2 config
1 → 3 migration/math → 4 module/settings/quota → 5 hook
4 → 6 accounts/bind → 7 settlement/adjust → 8 portal/auth → 9 admin API
1 → 10 gateway；1 → 11 user-service；2+11 → 12 client
9 → 13 admin UI；8 → 14 portal UI
全部 → 15 conformance/全量/审查
```

## 风险与回退

- 每个任务独立 commit；出问题可单任务回退。
- 钩子/结算/鉴权关键任务先写真库用例（slice-30）再合 master。
- 暗上线默认关；任何阶段可 `enabled=false` 停新增。
- 不推送/不部署，直到用户明确发话。
