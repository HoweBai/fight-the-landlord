# 代理分润（台费佣金）—— 实现计划 v1.1

- 日期：2026-10-26；同日 r1 计划审查后修订
- Spec：`docs/superpowers/specs/2026-10-26-agent-commission-design.md`（v1.1，设计 r1 + 计划 r2 已处置）
- 分支：`dev`（不推 master、不打 tag、不部署，除非用户明确发话）
- 提交纪律：每个任务一个 commit；消息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 全局：任何 `package.json` 改动必须同笔更新 `pnpm-lock.yaml`；假 DB 只钉控制流，并发/死锁用 slice-32 真 MySQL。

## 进度（2026-10-26，新会话从这里继续）

**交接文档：`docs/superpowers/plans/2026-10-26-agent-commission-handoff.md`（先读它）**

- ✅ 任务 0–12 已实现并提交（`faf65bd3` … `e6e70950`）；测试基线见交接文档 §2。
- ✅ 任务 13：管理后台「代理」UI（`876be015`；`verify:admin` 476 条 + jsdom 冒烟）。
- ✅ 任务 14：代理门户静态站 + edge（`dc5e6aaf`；`verify:agent` 104 条 + jsdom 冒烟）。
- ✅ 任务 15（代码）：slice-32 真库 + design.md env 表（`56f84133`）；r3 独立审查 Critical/Important
  修复（`324d6442` / `71be4070`）；本机全量绿（`pnpm test` 29/29、`pnpm lint` 18/18）。
- ✅ 任务 15（真库）：slice-32 由 GitHub CI 全序跑通（`40232890418`，45 片全绿；
  `slice-32-agent=137`）；`baselines.json` 已按 CI 实测回填 137。
- dev 已推送（CI 绿、真库绿）；master / tag / 部署未动（等用户发话）。

## 全局约束

1. **写边唯一**：佣金/额度只经 `ApplyService.applyWithEffect` 的内置钩子；不新增第二条写边。
2. **故障隔离**：钩子只吞语句级错误；1213/1205/连接错误/保存点回滚失败一律重抛；SAVEPOINT 在 **caller effect 之后**创建。
3. **幂等**：`uk_action_id` + `revenue_events(source_op_id, owner_id)` + `commission_entries(source_op_id, agent_id)`。
4. **归属只从 token 取**：代理门户查询强制 `WHERE agent_id = token.sub`。
5. **计数闸**：protocol 94 / active 78 / client 22 / verify:admin IA 78 / CONTROLS 73 / BOOL 36 / NOTES **78**（A1/A2 合并后）；`errors.test.ts` SPEC_CODES + `CLIENT_ACTION`；`messages.test.ts` 24 pattern。
6. **不新增容器/端口**；edge 只加 `/agent` 静态路由；currency→user 新增内部 RPC 边。
7. **bigint**：所有读回经 `toSafeInt`；假 DB 要有字符串回执用例。
8. **JWT**：用 `@nestjs/jwt`（仓内先例），密钥链逐字 `process.env.AGENT_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production'`，网关/currency 各一份 + 跨服务源码闸。

---

## 任务 0：依赖 / env / lockfile / compose

**Files**
- `packages/currency-service/package.json`（`@nestjs/jwt`）
- `pnpm-lock.yaml`（`pnpm install` 更新）
- `docker-compose.yml`：currency 块加 `AGENT_JWT_SECRET`、`AGENT_PHONE_HMAC_KEY`、`USER_SERVICE_RPC_HOST/PORT`；gateway 块加 `AGENT_JWT_SECRET`

**TDD**
1. 先跑 `pnpm -C packages/currency-service test` 基线绿。
2. 加依赖 + compose env；`pnpm install`；再跑基线绿。
3. 提交。

**验收**：`pnpm install --frozen-lockfile` 在当前工作区可通过（或记录 pnpm 版本差异）。

---

## 任务 1：protocol 错误码 / 配置键 / ClientConfig / 客户端文案

> **不含 RPC pattern**（J21 门禁要求 pattern 与接收侧同笔；见任务 6/11）。

**Files**
- `packages/protocol/src/errors.ts`、`errors.test.ts`
- `packages/protocol/src/config.ts`（`CONFIG_KEYS`、`CLIENT_CONFIG_KEYS`、`parseConfigValue`、`ClientConfig` 接口）、`config.test.ts`
- `apps/client/src/net/copy.ts`、`apps/client/src/stores/game.ts`、`apps/client/src/composables/useClientConfig.ts`、`apps/client/test/copy-coverage.test.ts`

**Interfaces**
- 6 个新 ErrCode + `CLIENT_ACTION` 全量 TOAST。
- `agent.inviteEnabled` 严格 boolean；`CLIENT_CONFIG_KEYS` 加 `agentInviteEnabled`；`ClientConfig.agentInviteEnabled: boolean`。
- 客户端 `FALLBACK_COPY` 补 6 码；`ClientConfigState`/`FAILSAFE_CLIENT_CONFIG`/`normalizeClientConfig` 补字段（缺省 false）。

**TDD**
1. 改 `errors.test.ts` SPEC_CODES 6 码；`config.test.ts` 键集/解析/ClientConfig 字段；`copy-coverage.test.ts` 通过。
2. 跑红（protocol + client copy）。
3. 实现。
4. 跑绿：`pnpm -C packages/protocol test`、`pnpm -C apps/client test test/copy-coverage.test.ts`。
5. 提交。

---

## 任务 2：config-service 客户端键 + 种子 + 管理端 IA/CFG_NAV

**Files**
- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/migrations/<新时间戳>-AgentInviteKey.ts`
- `packages/config-service/test/client-config.test.ts`、`test/migration.test.ts`、`test/platform-config.service.test.ts`
- `admin/app.js`（CONFIG_IA/CONFIG_CONTROLS/CONFIG_NOTES/CFG_NAV）、`admin/index.html`（新叶锚点）
- `scripts/verify-admin-static.mjs`（93→94、77→78、77→78、72→73、35→36、65→66；新增「IA domain 都有 CFG_NAV 叶」断言）

**Interfaces**
- `/api/config` 增加 `agentInviteEnabled`（缺行 false）。
- 迁移种子 `('agent.inviteEnabled','false',1,NOW(3),'seed')`；down 删除。
- 新「代理」域 `switches` 页签；`CFG_NAV` 追加叶 + `index.html` 的 nav id/count span + 点击监听。

**TDD**
1. client-config 22 键；migration 种子；platform-config 94 键 + SEED 键集。
2. 跑红。
3. 实现。
4. 跑绿：`pnpm -C packages/config-service test`、`pnpm verify:admin`。
5. 提交。

---

## 任务 3：currency 迁移（17 表）+ 纯函数

**Files**
- `packages/currency-service/src/migrations/1798000000000-AgentDomain.ts`
- `.../agent/agent.constants.ts`（source×用途矩阵、默认值、错误文案）
- `.../agent/commission.math.ts`
- `test/agent-domain.migration.test.ts`、`test/agent-commission-math.test.ts`

**表（17，逐名断言）**：`agent_settings`、`agent_accounts`、`agent_invite_codes`、`agent_bindings`、`agent_binding_history`、`agent_rates`、`agent_status_history`、`agent_player_quota`、`agent_quota_inflows`、`agent_admin_quota_credits`、`agent_revenue_events`、`agent_commission_entries`、`agent_settlements`、`agent_adjustments`、`agent_admin_audit`、`agent_ledger_gaps`、`agent_settings_history`。

**默认值**：`micro_carry/settled_watermark/token_version NOT NULL DEFAULT 0`；`must_change_password NOT NULL DEFAULT 1`；`pending_settlement_id NULL DEFAULT NULL`；`agent_settings` 种子 id=1。

**纯函数**
- `classifySource`：13 源全分类。
- `computeChainPayouts`：逐行 `micro=base×paid_bp`、冻结推进、自玩不推进、负级差 0 且 `lastPaid=max`、visited+深度。
- `applyQuotaDelta`：正入全额（admin 日限另算）/负出 `min(abs, max(0, inflow−consumed))`。

**TDD**
1. 迁移测试逐名 17 表 + 索引 + 默认值 + 类名不以 `Currency` 开头。
2. math 性质测试（随机 fee/非增比例/冻结/自玩、小额、负级差、顶层自玩、重复/环/深度）。
3. 跑红 → 实现 → 绿 → 提交。

---

## 任务 4：AgentModule 骨架 + settings/quota/maturity

**Files**
- `.../agent/agent.module.ts`（imports `ConfigModule`；providers/exports；`AgentLedgerService` **no-op 骨架**）
- `.../agent/agent-ledger.service.ts`（任务 4 只放 ctor + 空 `onApply`）
- `.../agent/agent-settings.service.ts`（同事务读；super_admin 更新；settings history）
- `.../agent/agent-quota.service.ts`（原子 upsert、FOR UPDATE、正/负、admin 日限、hold）
- `.../agent/agent-quota-maturity.service.ts`（`setInterval` + `unref` + `onModuleDestroy` + `SKIP LOCKED`；注册进 providers）
- `packages/currency-service/src/rpc/rpc.module.ts`（imports AgentModule）
- `packages/currency-service/src/app.module.ts`（imports AgentModule）
- `.../config/config-cache.service.ts`（`agentInviteEnabled()` getter）
- 测试：`agent-settings.test.ts`、`agent-quota.test.ts`、`agent-wiring.test.ts`

**TDD**
1. 装配测试：`AgentModule` 存在、exports `AgentLedgerService`、`RpcModule` imports 它（`Reflect.getMetadata`）。
2. settings/quota 假 DB：原子 upsert、正/负上限、admin 日限、hold、幂等。
3. 跑红 → 实现 → 绿 → 提交。

---

## 任务 5：ApplyService 内置钩子 + revenue/commission

**Files**
- `packages/currency-service/src/apply/apply.service.ts`（构造注入 `AgentLedgerService`，**必填**）
- `.../agent/agent-ledger.service.ts`（实现 onApply）
- `.../agent/agent-gap.service.ts`（独立 DataSource）
- `.../agent/agent.metrics.ts`
- `test/helpers/fake-currency-db.ts`（识别 settings/op created_at/quota upsert/SAVEPOINT/unknown）
- 既有测试：11 处 `new ApplyService(db, redis)` 加 stub；精确序列断言按需补一条 settings 读
- 新测试：`agent-ledger.test.ts`、`apply-agent-hook.test.ts`、`agent-gap.test.ts`

**Interfaces**
- `ApplyService` 构造 `(dataSource, redis, agentLedger)`；`applyWithEffect` 在 caller effect 之后、commit 之前：
  - 仅当 `source` ∈ agent 相关集合（entry_fee/recharge/admin_adjust/admin_reverse/refund_*/withdraw_*）才调用；其余源零额外查询。
  - `SAVEPOINT agent_ledger` → `onApply` → `RELEASE`；catch 分类（语句级回滚+gap+metric；事务级重抛）。
- `onApply`：读 settings（同事务）+ `currency_ops.created_at`；按 spec §4.2 写额度/revenue/佣金。
- FakeCurrencyDb：settings 读默认 `enabled=0`；保存点语句接受；无关源测试序列不变。

**TDD**
1. 先加 stub + 让既有测试编译/跑绿（红→绿一次）。
2. 新用例：首次台费→1 revenue+N 佣金；重放不跑；unbound/quota_exhausted/no_payee；语句级失败→主事务继续+gap；1213→重抛；caller effect 写入保留；`enabled=0` 只多一条 settings 读。
3. 跑红 → 实现 → 绿：`pnpm -C packages/currency-service test` + lint。
4. 提交。

---

## 任务 6：代理账号/邀请码/绑定 + user client + agent.bind

**Files**
- `.../agent/agent-accounts.service.ts`（CRUD/树/比例/状态/密码/收款/settings/audit）
- `.../agent/agent-invite.service.ts`（生成/轮换/校验；`ConfigCacheService.agentInviteEnabled()`）
- `.../agent/agent-bindings.service.ts`（bind/rebind/bulk/history/phone hash）
- `.../agent/agent-bind.rpc.controller.ts`（`agent.bind`；J21 三同：pattern + 接收侧 + module 注册）
- `.../agent/agent-user.client.ts` + `ClientsModule.register`（`USER_SERVICE_RPC_HOST/PORT`；昵称/profile 两条）
- `.../agent/agent-password.ts`（scrypt）、`.../agent/phone.ts`（`normalizePhone` 唯一实现）
- `packages/protocol/src/rpc.ts`（**本任务加** `agentBind`）、`packages/protocol/src/messages.test.ts`（22→23）
- `packages/currency-service/src/main.ts`（production 缺 `AGENT_PHONE_HMAC_KEY` → exit 1）
- 测试：`agent-accounts.test.ts`、`agent-invite.test.ts`、`agent-bindings.test.ts`、`agent-bind.rpc.test.ts`、`agent-user.client.test.ts`、`main-env.gate.test.ts`

**TDD**
1. bind：bound/already_bound/ignored/invalid、2×2 开关、TOCTOU 重校验、HMAC 三处同值。
2. 树：比例链/深度/环/轮换锁/批量 500 分块。
3. 装配：RPC 接收侧注册；J21 绿。
4. 跑红 → 实现 → 绿 → 提交。

---

## 任务 7：结算 + 人工调账

**Files**
- `.../agent/agent-settlement.service.ts`
- `.../agent/agent-adjustment.service.ts`
- 测试：`agent-settlement.test.ts`、`agent-adjustment.test.ts`

**Interfaces**
- 申请：锁 agent → `client_request_id` 返回原单 → pending 校验 → 水位/to/SUM/carry/min/hash → 插入（占位单号→UPDATE）→ pending。
- 打款：锁双行 → 水位/carry → 重算 SUM/hash（不一致 409 + 撤回恢复）→ 推进水位/carry → paid。
- 驳回/撤回：清 pending。
- 调账：pending → 另一 super_admin 复核 → manual 佣金行；日限事务锁。
- 所有 bigint `toSafeInt`。

**TDD**
1. 假 DB：幂等/pending/最低额/负余额/hash/低 id 晚提交/跨代理 request id/调账双人/限额/单号。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 8：代理认证 + 门户 API

**Files**
- `.../agent/agent-auth.service.ts`（login/密码/`JwtService`/失败计数/`token_version`）
- `.../agent/agent.guard.ts`（`x-agent-id`/ver/must_change/冻结）
- `.../agent/agent-portal.controller.ts`、`.../agent/agent-portal.service.ts`
- `.../agent/agent-user.client.ts`（任务 6 已建；本任务用昵称批量）
- `packages/currency-service/src/http/errors.ts` + `test/http-errors.test.ts`（6 码映射）
- 测试：`agent-auth.test.ts`、`agent-guard.test.ts`、`agent-portal.test.ts`

**TDD**
1. 登录成功/失败/手机号锁定、JWT 密钥链、must_change 放行面、冻结、IDOR、分页、昵称降级。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 9：管理端代理 API（审计/对账/设置）

**Files**
- `.../agent/agent-admin.controller.ts`、`.../agent/agent-admin.service.ts`
- `.../agent/agent-reconcile.service.ts`（启用区间、entry/manual、已结/已付、gap）
- 测试：`agent-admin.test.ts`、`agent-reconcile.test.ts`

**Interfaces**
- 端点按 spec §9.1；`XAdminGuard` + actor；audit；settings/payout/reset/rotate/freeze/bulk；字面路由先于 `:id`。
- 对账只统计 `agent_settings_history` 启用区间；gauge。

**TDD**
1. 每端点权限/参数/审计/对账恒等式/关闭期不报缺口。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 10：网关（agent 中间件/转发/路由/policy/限流）

**Files**
- `packages/api-gateway/src/auth/agent.middleware.ts`（新；`JwtService` + 逐字密钥链）
- `.../auth/jwt.middleware.ts`（`isAgentPath` 跳过玩家验签，仍剥身份头）
- `.../auth/public-paths.ts`（`AGENT_PREFIX`/`isAgentPath`；**不加 PUBLIC_PATHS**）
- `.../auth/identity-headers.ts`（`agentId` 产出/转发）
- `.../auth/admin-policy.ts`（显式 P 条目 + P4 `%` 变体规则）
- `.../http/http-rate-limit.middleware.ts`、`.../http/rate-limit.ts`（agent login IP 桶）
- `.../gateway/gateway.controller.ts`（agent + admin agent 路由；字面路由在前）
- `.../gateway/proxy.gateway.ts`（`X-Agent-Id` 映射）
- `.../app.module.ts`（ClientGate → Jwt → Admin → Agent → RateLimit）
- 测试：`agent.middleware.test.ts`、`agent-routes.test.ts`、`admin-policy.test.ts`、`identity-headers.test.ts`、`rate-limit.test.ts`、`container-assembly.gate.test.ts`

**TDD**
1. 交叉鉴权/伪造头剥离/转发断言；policy viewer/operator 403、finance/super_admin 矩阵、`%2E` 变体。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 11：user-service（注册 bind + profile RPC）

**Files**
- `packages/user-service/src/users/users.dto.ts`（inviteCode；phone trim）
- `.../auth/auth.service.ts`（生成 userId → bind → grant → 落库）
- `.../currency/currency.client.ts`（agentBind）
- `.../rpc/user-agent-profile.rpc.controller.ts`（新；`user.agentProfile.get`）
- `packages/protocol/src/rpc.ts`（**本任务加** `userAgentProfileGet`）、`messages.test.ts`（23→24）
- `.../app.module.ts`、`.../http/errors.ts`、测试

**TDD**
1. 注册带码成功/无效/功能关/传输失败/未带码；profile 单条/不存在/非法；11006/11007 映射。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 12：客户端注册邀请码

**Files**
- `apps/client/src/pages/login/login.vue`（注册态懒拉 `/api/config`；失败不渲染）
- `src/net/rest.ts`、`src/stores/auth.ts`（`signUp` 对象参数或第 5 位；重试保留 inviteCode）
- 测试：`test/login-screen.test.ts`（flag=true 独立 wrapper）、`test/auth*.test.ts`、`test/config*.test.ts`

**TDD**
1. 字段渲染/不渲染、提交带值/不带值、11006 文案、配置拉取失败不阻塞、重试保留码。
2. 跑红 → 实现 → 绿 → 提交。

---

## 任务 13：管理后台代理 UI

**Files**
- `admin/app.js`（代理区；VIEW_ORDER 末尾；零 innerHTML）
- `admin/index.html`（成套 view id + nav）
- `admin/style.css`
- `scripts/verify-admin-static.mjs`（新视图 id/roles/关键函数）

**TDD**
1. verifier 新断言。
2. 跑红 → 实现 → 绿（`pnpm verify:admin`）→ 提交。

---

## 任务 14：代理门户静态站 + edge

**Files**
- `agent/index.html`、`agent/app.js`、`agent/style.css`
- `scripts/verify-agent-static.mjs`（新）+ 根 `package.json` `verify:agent`
- `Dockerfile.edge`（`COPY agent /srv/agent`）
- `deploy/Caddyfile`（`handle /agent { redir * /agent/ 301 }` + `handle /agent/*`）

**TDD**
1. 静态断言（必需 id/API 路径/无危险注入）。
2. 跑红 → 实现 → 绿（`pnpm verify:agent`）→ 提交。

---

## 任务 15：conformance slice-30 + 全量验证 + 代码审查

**Files**
- `tools/conformance/src/slices/slice-32-agent.ts`
- `tools/conformance/src/run.ts`（追加 `'slice-32-agent'`）
- `tools/conformance/baselines.json`（首次由 CI 回填；本机不填）
- `docs/design.md` §11.2（6 码）
- 交付报告/计划勾选

**内容**
- 真 MySQL：额度首建并发/死锁、savepoint 回滚后主事务、水位结算双会话/低 id 晚提交、驳回/打款/复核、关闭期对账、配置计数、鉴权交叉。
- 全量：各包 test/lint、client test/lint、`pnpm verify:admin`、`pnpm verify:agent`、`pnpm test`（尽力）。
- 独立代码审查 `BASE..HEAD`；Critical/Important 修完补测。
- 交付报告：变更/验证证据/SHA/是否推送部署/已知边界（Docker 未跑要明说）。

---

## 执行顺序与依赖

```
0 deps/env → 1 protocol → 2 config
1 → 3 migration/math → 4 AgentModule/settings/quota
4 → 5 hook
4 → 6 accounts/invite/bindings + user client + agent.bind RPC
6 → 7 settlement/adjust → 8 portal/auth → 9 admin API
6 → 10 gateway（需 agent 路由契约）
6+1 → 11 user-service（profile RPC）
2+11 → 12 client
9 → 13 admin UI
8 → 14 portal UI
全部 → 15 conformance/全量/审查
```

## 风险与回退

- 每任务独立 commit；出问题可单任务回退。
- 钩子/结算/鉴权关键任务先过 slice-32 真库用例再合 master。
- 暗上线默认关；任何阶段 `enabled=false` 停新增。
- 不推送/不部署，直到用户明确发话。
