# 代理分润 —— 交接（2026-10-26）

> 用途：当前会话上下文接近上限，**新开会话**从这里继续。
> 分支 `dev`，工作区干净（仅有一个未跟踪的 `grep.exe.stackdump` 垃圾文件，**不要提交**）。
> 最近提交：`e6e70950 feat(agent): 客户端注册邀请码（任务 12）`。

## 0. 新会话提示词（直接复制）

```text
继续实现代理分润功能（仓库 d:\Code\pokergame，分支 dev；不要推 master、不要打 tag、不要部署）。

先读：
- docs/superpowers/plans/2026-10-26-agent-commission-handoff.md（本文件，先读）
- docs/superpowers/specs/2026-10-26-agent-commission-design.md（v1.1）
- docs/superpowers/plans/2026-10-26-agent-commission.md（15 任务计划）

已完成任务 0–12（见下）。请从任务 13 继续：
13) 管理后台「代理」UI；
14) 代理门户静态站 + edge 路由；
15) tools/conformance slice-32 真库 + 全量验证 + 独立代码审查 + 交付报告。

按 docs/dev-process.md 执行：每个任务 TDD/红绿、独立提交、提交信息末尾带
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>。
先跑一遍本文件 §2 的基线命令确认起点绿；任务 15 的代码审查派独立子代理做，
Critical/Important 必须修。没有用户明确发话前不要推送/部署。
```

## 1. 已完成（任务 0–12，均已提交）

| 任务 | 提交 | 内容 |
|---|---|---|
| 0 | `faf65bd3` | currency-service 依赖 `@nestjs/jwt`/`rxjs`；compose env（`AGENT_JWT_SECRET`/`AGENT_PHONE_HMAC_KEY`/`USER_SERVICE_RPC_HOST/PORT`）；lockfile |
| 1/2 | `569154dc` | protocol 6 错误码 + `agent.inviteEnabled`/`agentInviteEnabled` + `ClientConfig` 字段；config-service 种子迁移 `1796900000000-AgentInviteKey`；管理端配置 IA/CFG_NAV/CONTROLS/NOTES + `verify:admin` 94/78/78/73/36/66 |
| 3 | `531a7c83` | currency 迁移 `1798000000000-AgentDomain`（17 表）+ 纯函数 `commission.math.ts`（级差/冻结/自玩/负级差/额度/取整）+ 2000 轮随机性质测试 |
| 4 | `21bbc213` | `AgentModule` 骨架；settings/quota/maturity 服务；`ApplyService` 可见面装配；`ConfigCacheService.agentInviteEnabled()` |
| 5 | `25de5ba6` | `ApplyService` 内置代理钩子（caller effect 之后 SAVEPOINT；语句级回滚/事务级重抛）；revenue/commission 写入；gap 独立连接；11 条 ledger + 5 条 Apply 钩子测试 |
| 6 | `d181e39f` | 账号/邀请码/绑定服务；`agent.bind` 接收侧；`user.agentProfile.get` 接收侧；currency→user 客户端；`main.ts` 生产密钥 fail-closed；password scrypt |
| 7 | `ad0c8503` | 结算（ID 水位、client_request_id 幂等、SUM/hash 复核、打款/驳回/撤回）+ 人工调账（双人复核/日限） |
| 8 | `ab70489b` | 代理登录/JWT（aud/typ/ver）、AgentGuard、门户 profile/overview/players/commissions/subtree/settlements；绑定表加 `phone_masked` |
| 9 | `d09995da` | 管理端代理全量 REST（CRUD/树/设置/状态/密码/邀请码/收款/绑定/批量/结算/调账/审计/对账）；6 码 HTTP 映射（currency/user） |
| 10 | `bc283108` | 网关 `AgentAuthMiddleware`、Jwt/ClientGate 跳过/豁免、`X-Agent-Id`/`X-Agent-Ver` 转发、全量路由、policy P-ag0..P-ag4（含 `%2E` 变体）、登录 IP 桶 |
| 11 | `b617bf27` | `RegisterDto.inviteCode`；`AuthService` 先 `agent.bind` 再 signup grant/落库；`CurrencyClient.agentBind` |
| 12 | `e6e70950` | 登录页注册态懒拉配置 + 邀请码字段（开关开才渲染）；`signUp`/`register` 透传；docs 错误码/22 键同步 |
| 13 | `876be015` | 管理后台「代理」UI（列表/新建/详情/设置/结算/调账/对账/审计；`verify:admin` 465 + jsdom 冒烟） |
| 14 | `dc5e6aaf` | 代理门户静态站 + `Dockerfile.edge`/`Caddyfile` `/agent` 路由；`verify:agent` 104 + jsdom 冒烟 |
| 15 | `56f84133` / `324d6442` / `71be4070` | slice-32 真库 + design.md env 表；r3 独立审查 Critical/Important 收口（公开 boot 配置、管理页竞态、对账区间、手机号归一、分页等） |

### 设计增量（相对 spec v1.1，需在 spec 的偏差台账/审查记录补一句）

1. `agent_bindings` 增列 `phone_masked varchar(20) NOT NULL`（门户玩家列表脱敏用，避免逐玩家拉 PII）。
2. `ApplyService` 的 `AgentLedgerService` 构造参数为**可选**（仅服务单测 `new ApplyService(db, redis)`；真容器 `@Inject` 必注入；`AgentModule` exports + `RpcModule` imports 已由装配测试钉住）。
3. `agent_settings` 放 currency DB（不走通用 config），`agent.inviteEnabled` 仍在 config-service（客户端子集）；网关 policy P-ag0 对 `agent.*` 与含 `%` 的键要求 super_admin。
4. 代理登录允许 `frozen`（只读+结算）；`must_change_password=1` 时只放行 `GET /agent/me`、`POST /agent/password`。
5. 门户玩家列表的「局数」= revenue event 数（台费局数）；v1 无搜索框。

## 2. 测试基线（2026-10-26 本机全绿）

```bash
pnpm -C packages/protocol test                 # 300
pnpm -C packages/currency-service test         # 538（含 r3/合并新增）
pnpm -C packages/currency-service run lint
pnpm -C packages/user-service test             # 377
pnpm -C packages/user-service run lint
pnpm -C packages/config-service test           # 484（含 /api/config/boot）
pnpm -C packages/api-gateway test              # 500（含公开面六条）
pnpm -C packages/api-gateway run lint
pnpm -C apps/client test                       # 1524 passed / 2 skipped
pnpm -C apps/client run lint
pnpm verify:admin                              # 476 checks
pnpm verify:agent                              # 104 checks
pnpm -C packages/shared test                   # 399
pnpm test                                      # turbo 29/29
pnpm lint                                      # turbo 18/18
```

> 注意：跑 config-service / user-service 前如果 protocol 改了源码，先 `pnpm -C packages/protocol build`（它们读 `dist`）。

## 3. 任务 13（已完成，`876be015`）：管理后台「代理」UI

**API 已全部就绪**（网关 + currency-service）：

- `GET/POST /api/admin/agents`；`GET /api/admin/agents/tree`；`GET/PATCH /api/admin/agents/settings`
- `GET /api/admin/agents/:id`；`PATCH /api/admin/agents/:id`；`POST .../status|reset-password|invite-code/rotate`；`PATCH .../payout`
- `GET /api/admin/agents/:id/bindings`；`POST /api/admin/agents/bind|unbind`；`POST .../bindings/bulk`
- `POST /api/admin/agents/:id/adjustments`；`GET /api/admin/agent-adjustments`；`POST /api/admin/agent-adjustments/:id/approve|reject`
- `GET /api/admin/agent-settlements`；`GET /api/admin/agent-settlements/:id`；`POST .../pay|reject`
- `GET /api/admin/agent-audit`；`GET /api/admin/agent-reconciliation?from&to`

**角色**：读面 super_admin|finance；写面 super_admin；结算打款/驳回 finance|super_admin；调账复核 super_admin。UI 只做门面（真闸在网关）。

**落点**：
- `admin/index.html`：nav 按钮（`nav-agents-btn`）+ `<main id="agents-view" class="page-view" hidden>`（含代理列表/新建/设置/结算/调账/对账/审计区域）。`switchView` 会对 `VIEWS[name].el` 直接取元素 ⇒ id 必须成套。
- `admin/app.js`：`VIEWS.agents = { el:'agents-view', nav:'nav-agents-btn', roles:['super_admin','finance'] }`；`VIEW_ORDER` **追加在末尾**；`switchView` 加懒加载；用现成 `api()`/`el()`/`btn()`/`roleOf()`；**零 innerHTML**（`verify:admin` 第 81 行会红）。
- 建议最小功能集：列表 + 新建（显示一次性初始密码/邀请码）+ 冻结/解冻 + 重置密码 + 轮换码 + 改比例/上级 + 设置（enabled/coin_per_yuan/min/限额）+ 结算队列（打款/驳回）+ 调账（发起/复核）+ 对账 + 审计。
- `scripts/verify-admin-static.mjs` 追加新 view/nav/roles 断言（可选但建议）。
- 验收：`pnpm verify:admin`（现有 378 条全绿 + 新断言）。

## 4. 任务 14（已完成，`dc5e6aaf`）：代理门户静态站 + edge

**API**：`POST /api/agent/login`（公开）；`GET /api/agent/me|overview|players|commissions|subtree|settlements|settlements/:id`；`POST /api/agent/settlements`（`{clientRequestId}`）、`POST .../:id/cancel`、`POST /api/agent/password`。除 login 外全部 `Authorization: Bearer <agent token>`；网关注入 `X-Agent-Id`/`X-Agent-Ver`；`agentId` **只从 token**（不要 query/body）。

**落点**：
- 新建 `agent/index.html`、`agent/app.js`、`agent/style.css`（手机优先；纯静态、无构建）。
- 登录/改密/概览/玩家/佣金/结算/我的；401 清 token 回登录；403 + `must_change_password` 显示改密页；`11006/14011/14012/14013` 文案见 `apps/client/src/net/copy.ts`。
- `Dockerfile.edge`：在 `COPY admin /srv/admin` 附近加 `COPY agent /srv/agent`（之后已有 `chown -R caddy:caddy /srv`）。
- `deploy/Caddyfile`：在 catch-all `handle {` **之前**加
  `handle /agent { redir * /agent/ 301 }` + `handle /agent/* { root * /srv; file_server }`（照 `/admin` 写法；`redir` 必须显式给 matcher）。
- 新建 `scripts/verify-agent-static.mjs` + 根 `package.json` 的 `verify:agent`；至少断言登录表单/必需 id/无危险注入/API 路径。

## 5. 任务 15（代码完成，CI 真库轮待跑）：conformance + 全量验证 + 代码审查

### 5.1 r3 独立审查结论（2026-10-26，`71be4070` 已修）

- **Critical C1**：注册页懒拉 `/api/config` 需玩家令牌 ⇒ 新用户永远看不到邀请码。已新增公开
  `GET /api/config/boot`（只回 version+agentInviteEnabled；网关 PUBLIC_PATHS 第 6 条）。
- **Critical C2**：管理页详情响应乱序会把 A 的资料/收款写进 B。已加 `detailId` 复核 + 按
  当前渲染面板取 id。
- **Important**：对账启用区间用全局 `effective_from` 回卷关闭窗口（改为每段 changed_at）；
  `+86`/分隔符/全角手机号绕过自玩特判（normalizePhone 数字归一）；结算/调账列表无翻页
  （补分页 + 结算默认 pending）。
- **Minor**：设置逐键 bounds、rateBp 拒绝 null/空串/数组、昵称 50 分批、负 carry 显示 0、
  批量改绑每批复核 active、门户改密 6–64、verify:agent 函数体断言并接入 ci.sh、详情上级
  下拉过滤冻结、比例 step 0.01、树旧快照不误摘上级、slice-32 低 id 行同额。
- **登记未修**：详情绑定玩家只取前 50（批量改绑兜底）；门户 token localStorage（本页零
  HTML 注入，后续可改 sessionStorage）。
- 详细表见 spec §17.2。

### 5.2 本机验证（2026-10-26）

- `pnpm test` 29/29；`pnpm lint` 18/18；room-service 895（含 `meta-on-every-rpc-send` 闸）。
- currency 538 / config 484 / gateway 500 / client 1525（2 skipped）/ shared 399 /
  protocol 300 / user 377 / room 917；`verify:admin` 476；`verify:agent` 104；conformance tsc 通过。
- jsdom 冒烟：管理页 super_admin/finance 各 14+ 项；门户 26 项（首登改密/五页签/结算/401）。
- **真库 slice-30 未在本机跑**（Docker daemon 不可用）⇒ 由 GitHub CI 跑；`baselines.json`
  已按源码静态计数回填 `slice-32-agent = 136`（CI 实测复核）。

### 5.3 GitHub CI 运行方式

- 推 `dev` 不触发 CI；手动：`gh workflow run ci.yml --ref dev`。
- `conformance.yml` 现行只认 push→master / release 复用，**没有 dispatch**；临时在 dev 上跑需
  一次性提交把 `push.branches` 扩为 `[master, dev]` 并同步 `slice-07.4-pipeline` 的期望集合，
  跑完 **revert**（用户已授权 dev 跑 CI；master/tag 不动）。

### 5.4 合并 `origin/dev`（2026-10-26，A1/A2 PDK 并行片）

- origin/dev 领先 52 个提交（PDK 指标/金币场账本/管理统计）。合并冲突 3 处（run.ts /
  baselines.json / verify-admin-static.mjs），已按两侧语义合并。
- **编号冲突**：`slice-30`/`slice-31` 已被 PDK 片占用 ⇒ 本片由 `slice-30-agent` 顺延为
  **`slice-32-agent`**（文件/导出/run.ts/baselines 全改）。
- **迁移时间戳冲突**：A2/A3 的 `1797000000000-GameTypeOnOpsDdl` 与本片
  `1797000000000-AgentDomain` 同号 ⇒ 本片迁移改为 **`1798000000000-AgentDomain`**
  （类名 `AgentDomain1798000000000`；尚未部署，改名安全）。
- 合并后计数：CONFIG_NOTES 78（PDK +11 + 代理 1）；currency 538；其余见 §5.2。



1. **`tools/conformance/src/slices/slice-32-agent.ts`**（真 MySQL；Docker）：
   - 额度首建并发/死锁；SAVEPOINT 回滚后主事务；水位结算双会话；低 id 晚提交 409；驳回/打款/复核；关闭期对账；配置计数；鉴权交叉。
   - 注册到 `tools/conformance/src/run.ts`；`baselines.json` **首次由 CI 回填，本机不要手填**。
2. **文档**：`docs/design.md §2.3` env 表补 `AGENT_JWT_SECRET`、`AGENT_PHONE_HMAC_KEY`、`USER_SERVICE_RPC_HOST/PORT`；如需强闸，把四条加进 `packages/shared/test/design-md-ai-rollout.gate.test.ts` 的 `NEW_ENVS`。
3. **全量验证**：§2 全部命令 + 能跑则 `pnpm test`；Docker 不可用要如实写「未跑真库」。
4. **独立代码审查**（子代理；建议 `git diff 12f29c9d..HEAD`，即本功能全部提交），按 Critical/Important 修完补测。
5. **交付报告**：变更/验证证据/SHA/是否推送部署/已知边界（尤其：真库并发未跑、UI 未做浏览器实测）。

## 6. 已知风险 / 注意点

- **r3 已修**：公开启动配置 `/api/config/boot`（第 6 条公开路径；只两键）；管理页详情竞态；
  对账启用区间从 changed_at 起；手机号数字归一（自玩特判）；结算/调账分页。
- **仍需 CI 真库证明**：slice-32 的并发/SAVEPOINT/水位/低 id 晚提交（本机无 Docker）。
- **真库并发未证明**：假 DB 只钉控制流；SAVEPOINT/死锁/水位/额度首建必须 slice-32 真 MySQL。
- **`ApplyService` 钩子失败的生产行为**：语句级错误 → 保存点回滚 + `agent_ledger_gaps` + 指标，主事务继续；1213/1205/连接错误 → 重抛让 apply 失败（room-service 幂等重试）。
- **结算水位**：申请后低 id 晚提交会让打款 SUM/hash 不一致 → 409；恢复 = 撤回/驳回后重新申请。
- **`updatePayout`**：管理端 PATCH 省略字段会置 NULL —— UI 必须三个字段一起提交。
- **代理门户 `AgentGuard`** 依赖网关注入 `x-agent-ver`；直连 currency-service（绕过网关）会 401（预期）。
- **`agent_settings.enabled` 打开时 `effective_from` 为空** ⇒ 钩子视为未启用并 error 日志（settings.update 首次 enable 会写 DB 时间）。
- **手机号归一**：v1 用数字归一（`+86`/分隔符/全角）；轮换 HMAC key 需全量重算，仍不支持。
- **未跟踪的 `grep.exe.stackdump`** 是垃圾文件，不要提交。
- **dev 已推送/CI 由用户授权**；master/tag/部署未动。

## 7. 关键文件索引

- spec：`docs/superpowers/specs/2026-10-26-agent-commission-design.md`
- plan：`docs/superpowers/plans/2026-10-26-agent-commission.md`
- 迁移：`packages/currency-service/src/migrations/1798000000000-AgentDomain.ts`
- 纯函数：`packages/currency-service/src/agent/commission.math.ts`
- 写边：`packages/currency-service/src/apply/apply.service.ts`、`src/agent/agent-ledger.service.ts`
- 结算：`packages/currency-service/src/agent/agent-settlement.service.ts`
- 门户：`packages/currency-service/src/agent/agent-portal.controller.ts`、`agent-auth.service.ts`、`agent.guard.ts`
- 管理 API：`packages/currency-service/src/agent/agent-admin.controller.ts`
- 网关：`packages/api-gateway/src/auth/agent.middleware.ts`、`auth/admin-policy.ts`、`gateway/gateway.controller.ts`
- 注册：`packages/user-service/src/auth/auth.service.ts`、`src/currency/currency.client.ts`
- 客户端：`apps/client/src/pages/login/login.vue`、`src/net/rest.ts`、`src/stores/auth.ts`、`src/stores/game.ts`
