# 注册邀请码必填 + 一次性邀请码设计（2026-11-03）

> 状态：设计草案 r2（已过 3 份独立对抗审查，待用户确认）
> 关联：[代理分润设计（2026-10-26）](2026-10-26-agent-commission-design.md)
> 分支：`dev`

## 0. 背景与问题

代理分润当前是暗上线：`agent.inviteEnabled`（严格 boolean、种子 `false`）控制注册页是否渲染邀请码输入框；`RegisterDto.inviteCode` 可选；`AuthService.register` 只在非空时调 `agent.bind`。每个代理同时只有一枚长期有效的 active 码，可被无限次注册绑定。

用户裁决（2026-11-03）：

1. 注册时**强制代理归属**：新用户必须填写有效代理邀请码；
2. **一枚邀请码只能使用一次**；
3. 代理**自助批量生成**一次性邀请码；
4. 当前**没有存量邀请码**，一次性语义可以从第一天生效；
5. 后台需要一个**必填开关**，采用「新增独立键」方案（方案 A）。

现状锚点：

- 客户端注册页：[login.vue](../../../apps/client/src/pages/login/login.vue) `showInviteCode` / `ensureInviteConfig` / `submit`
- 公开启动面：`GET /api/config/boot` → `{version, agentInviteEnabled}`，[client-config.controller.ts](../../../packages/config-service/src/config/client-config.controller.ts)
- 注册 DTO：[users.dto.ts](../../../packages/user-service/src/users/users.dto.ts) `inviteCode?: string`
- 注册链路：[auth.service.ts](../../../packages/user-service/src/auth/auth.service.ts) `register()`
- 绑定消费：[agent-bindings.service.ts](../../../packages/currency-service/src/agent/agent-bindings.service.ts) `bindFromSignup()`
- 码表：[1798000000000-AgentDomain.ts](../../../packages/currency-service/src/migrations/1798000000000-AgentDomain.ts)

## 1. 范围

### 做

- 新增配置键 `agent.inviteRequired`（严格 boolean、种子 `false`、仅 super_admin 可写、客户端可见裸名 `agentInviteRequired`）
- user-service 注册时按「入口开 + 必填开」强制要求邀请码；同手机号并发注册加 Redis 短锁
- `agent_invite_codes` 扩展为一次性码（`active/used/revoked` + `used_by/used_at`）
- 消费时按 `agent → code` 锁序原子抢占，与绑定写同一事务
- 代理端批量生成 / 列表 / 状态提示接口与页面
- 管理后台：配置中心行、代理设置三态控件、super_admin 专属码列表、单码撤销、`rotate` 语义调整
- 客户端：boot 返回必填标志、注册页必填文案与空值校验、boot 竞态与失败兜底
- 观测指标、日志脱敏、迁移测试、conformance 重写
- 网关显式路由与 query 白名单、admin 策略精确分支

### 不做（YAGNI）

- 非代理通用邀请码 / 邀请制注册（本期只做代理归属）
- 邀请码有效期、按手机号预绑定
- 代理自助撤销单枚码（管理员单码撤销 + `rotate` 兜底）
- 客户端版本闸（不做 `X-Client-Version` / 最低版本判断；旧版占比用外部应用分发数据判断）
- 存量码迁移（当前无存量码）
- 代理分佣/结算逻辑调整
- 跨 RPC 超时的注册幂等键（登记为残余，见 §7；本期只做同手机号锁 + 单码撤销补偿）

## 2. 决策表

| 编号 | 决策 | 内容与理由 |
|---|---|---|
| D1 | 开关模型 | 新增 `agent.inviteRequired`，与 `agent.inviteEnabled` 并存。`enabled` 控入口，`required` 控必填。默认 `false`，回滚只需关 `required` |
| D2 | 生效条件 | 服务端与客户端都按 `enabled && required` 判定。入口关时必填自动失效（fail-open），避免「入口隐藏 + 服务端强制」把注册全部堵死 |
| D3 | 强制点 | user-service `AuthService.register`。空码 → `400 / 11006`，message `请填写邀请码`。前端校验只做体验，不作为安全边界 |
| D4 | 一次性码模型 | `agent_invite_codes` 增加 `used_by varchar(36) NULL`、`used_at datetime(3) NULL`；`status` 取值扩展为 `active/used/revoked`。去掉「一代理仅一枚 active」的应用层约束 |
| D5 | 消费时序与锁序 | 事务内先锁代理行（`FOR UPDATE`，复核 active），再锁码行（`FOR UPDATE`，复核 `active`），再条件 UPDATE 抢占；与 `agent_bindings`/history 同事务。锁序统一 `agent → code → binding`，与 `rotate`/冻结/管理改绑一致，无死锁环 |
| D6 | 码状态分类 | `resolve` 改为同时返回 `codeStatus` 与 `agentStatus`（不再预先过滤 `c.status`）。`used` → `邀请码已被使用`；`revoked`/不存在/代理非 active → `邀请码无效`；`active` 才进入抢占 |
| D7 | 发放方式 | 代理端自助批量生成：`POST /api/agent/invite-codes {count}`，单次 `1..50`，单代理每日上限 `200`。生成要求：代理 active + `agent_settings.enabled` + `agent.inviteEnabled`；事务第一条语句锁代理行 |
| D8 | 代理端 API | 新增生成/列表；`GET /api/agent/me` 保留 `inviteCode`（最新 active、可为 null），新增 `inviteCodesActive`、`inviteEnabled`、`settingsEnabled`、`required` |
| D9 | 管理后台 | 配置中心「代理 → 开关」增加行；代理设置页三态控件 `关闭 / 选填 / 必填`；码列表**仅 super_admin**；新增单码撤销（super_admin）；`rotate` = 作废全部未使用 + 发 1 枚新码，响应保持 `{code}` |
| D10 | 客户端 | `GET /api/config/boot` 增加 `agentInviteRequired`；注册页必填文案 + 提交前空值校验；提交前 await boot 刷新；boot 失败时兜底展示输入框 |
| D11 | 错误语义 | `11006`（message-first）三档 message：`请填写邀请码` / `邀请码无效` / `邀请码已被使用`；冻结代理生成码 → `11007`；生成数量/上限 → `10001`；同手机号并发 → `10006` |
| D12 | 老客户端 | 不做版本闸。服务端权威；开关打开后老客户端不填码会被拒。上线前用外部应用分发数据确认旧版占比 |
| D13 | 回滚 | 关 `agent.inviteRequired` 即回选填；一次性语义不回退。码已发放后**禁止回滚 currency-service 镜像**（旧逻辑不消费码），只允许前滚修复 |
| D14 | 配置不可用 | user-service 快照缺失/坏值 ⇒ `required=false`（不阻断注册）。currency-service 快照缺失 ⇒ `bind` 返回 `ignored: config_unavailable`，注册成功但打点告警 |
| D15 | 并发注册 | user-service 注册全程持有手机号级 Redis 短锁（key 为手机号 SHA-256，`SET NX PX 10000` + token/Lua 释放），防止同手机号并发烧两枚码 / 重复发赠币 |
| D16 | `already_bound` | 保留 protocol 状态。`bindFromSignup` 在抢占前先查 `owner_id` 是否已有绑定：有 ⇒ 直接返回 `already_bound`，不消费新码；user-service 继续视为成功（滚动兼容） |
| D17 | 可观测 | 新增注册失败、邀请码生成/拒绝/消费、bind ignored 指标；日志禁止打印完整码；Grafana 代理看板加面板与告警 |
| D18 | 日志脱敏 | shared redactor 增加 `inviteCode` / `invite_code` 键规则；新日志只打印 `agentId + 码后 2 位` |

## 3. 实现设计

### 3.1 数据模型与迁移

currency-service 新迁移 `1798600000000-AgentInviteSingleUse.ts`（类名不得以 `Currency` 开头；**不得**再用已占用的 179820/179830）：

```sql
ALTER TABLE `agent_invite_codes`
  ADD COLUMN `used_by` varchar(36) NULL DEFAULT NULL,
  ADD COLUMN `used_at` datetime(3) NULL DEFAULT NULL;
```

- `code varchar(16) PK` 不变；`agent_id`、`created_at` 不变
- `status` 仍为 `varchar(10)`，新值 `used` 合法
- 索引沿用 `(agent_id, status)`；列表按 `(created_at, code)` 倒序（量小，暂不加复合索引）
- `down()`：先 `UPDATE agent_invite_codes SET status='active' WHERE status='used'`，再删除两列（仅开发库回滚；生产不逆向已消费数据）
- 新增迁移测试 `packages/currency-service/test/agent-invite-single-use.migration.test.ts`：ALTER 列、down、类名、跨包时间戳唯一

config-service 种子迁移 `1798700000000-AgentInviteRequiredSeed.ts`：version 取全表 MAX（至少 1）、`INSERT IGNORE ('agent.inviteRequired','false',version,NOW(3),'seed')`、`down()` 删除。补 `packages/config-service/test/migration.test.ts` 用例与 `config-probe.ts` SEED 键。

状态机：

```text
active --注册消费--> used（终态）
active --rotate/管理员单码撤销--> revoked（终态）
used / revoked 不再变化
```

### 3.2 一次性消费时序

`AgentInviteService.resolve` 新契约：

```sql
SELECT c.`agent_id`, a.`name`, a.`status` AS `agent_status`, c.`status` AS `code_status`
  FROM `agent_invite_codes` c
  JOIN `agent_accounts` a ON a.`id` = c.`agent_id`
 WHERE c.`code` = ?
```

不再带 `AND c.status='active'`。返回 `{ agentId, agentName, agentStatus, codeStatus }`；无行 ⇒ null。

`AgentBindingsService.bindFromSignup`（同一事务，锁序 `agent → code → binding`）：

0. `settings = getOrDefault()`；`!settings.enabled` ⇒ `{status:'ignored', reason:'settings_disabled'}`
1. `!config.hasSnapshot()` ⇒ `{status:'ignored', reason:'config_unavailable'}`；`!config.agentInviteEnabled()` ⇒ `{status:'ignored', reason:'invite_disabled'}`（码不消费）
2. `resolve(code)`；无行 ⇒ `11006 邀请码无效`
3. 幂等预检：`SELECT agent_id FROM agent_bindings WHERE owner_id=?`；已有同代理绑定 ⇒ `{status:'already_bound'}`（不消费新码）；已有异代理绑定 ⇒ `11006 邀请码无效`
4. 锁代理行：`SELECT status FROM agent_accounts WHERE id=? FOR UPDATE`；无行或非 `active` ⇒ `11006 邀请码无效`（消灭冻结 TOCTOU）
5. 锁码行（当前读）：`SELECT status FROM agent_invite_codes WHERE code=? AND agent_id=? FOR UPDATE`
   - 无行 ⇒ `11006 邀请码无效`
   - `used` ⇒ `11006 邀请码已被使用`
   - `revoked` ⇒ `11006 邀请码无效`
   - `active` ⇒ 继续
6. 条件更新抢占：

   ```sql
   UPDATE `agent_invite_codes`
      SET `status` = 'used', `used_by` = ?, `used_at` = NOW(3)
    WHERE `code` = ? AND `status` = 'active'
   ```

   `affectedRows !== 1` ⇒ 在已持有码行锁的前提下属内部不一致 ⇒ 抛错回滚（不烧码）
7. `INSERT IGNORE agent_bindings` + `agent_binding_history`；`affectedRows=1` ⇒ `{status:'bound'}`
8. 任一步异常 ⇒ 整事务回滚，码恢复 `active`

锁序与现有写路径一致：`rotate` / 冻结 / 管理改绑都是 `agent → code/binding`，不存在反向锁序。

### 3.3 生成、列表与撤销

**生成**（`AgentPortalService.generateInviteCodes`）：

事务**第一条语句**：`SELECT status FROM agent_accounts WHERE id=? FOR UPDATE`

- 无行 ⇒ `10001 代理不存在`
- 非 `active` ⇒ `403/11007 代理已被冻结`
- `settings.enabled=false` ⇒ `403/10003 代理模块未开放`
- `!config.hasSnapshot() || !config.agentInviteEnabled()` ⇒ `403/10003 邀请码功能未开放`
- 当日已生成数（`created_at >= CURDATE()`）+ count > 200 ⇒ `10001 今日生成数量已达上限`
- `count` 非整数或不在 `1..50` ⇒ `10001 生成数量须为 1–50`
- 通过后在**同一事务**内 `createMany`；撞码重试沿用 `CREATE_ATTEMPTS`

**列表**（`GET /api/agent/invite-codes?status=&cursor=&limit=`）：

- `status` 允许 `active|used|revoked`（缺省全部）；非法 ⇒ `10001`
- `limit` 默认 50、上限 100
- keyset 分页：cursor = 上一页最后一条 `code`；服务端按 code 反查 `(created_at, code)`，查询 `created_at < ? OR (created_at = ? AND code < ?)`，排序 `created_at DESC, code DESC`
- 返回 `{ rows: [{code,status,createdAt,usedAt}], nextCursor }`；代理端**不返回** `used_by`
- `activeCode(agentId)` 改为 `ORDER BY created_at DESC, code DESC LIMIT 1`

**管理端列表**（super_admin 专属）：

- `GET /api/admin/agents/:id/invite-codes?status=&cursor=&limit=`：返回同形状 + `counts:{active,used,revoked}` + `usedByMaskedPhone`（join `agent_bindings.phone_masked`；不给原始 ownerId）
- `POST /api/admin/agents/:id/invite-codes/:code/revoke`：仅 `active` 且属于该代理；`active→revoked`，写 `agent_admin_audit`（action `agent.invite.revoke`）
- `POST /api/admin/agents/:id/invite-code/rotate`：作废全部 active + 生成 1 枚新码；**响应保持现状 `{code}`**；audit 只记录 `{ revoked, codeTail }`（**不写完整新码**，避免 finance 经 `/api/admin/agent-audit` 读到 active bearer credential）；新码计入当日生成数（实现简单，管理员轮换频率低）

### 3.4 配置链

protocol（`packages/protocol/src/config.ts`）：

- `CONFIG_KEYS` 增加 `'agent.inviteRequired'`（总数 112 → 113）
- `parseConfigValue` 增加严格 boolean 分支（照 `agent.inviteEnabled`）
- `CLIENT_CONFIG_KEYS` 增加裸名 `'agentInviteRequired'`（总数 22 → 23）
- `ClientConfig` 接口增加 `agentInviteRequired: boolean`

config-service：

- 新种子迁移 `1798700000000-AgentInviteRequiredSeed.ts`
- `ClientConfigController.get()` 读 `readBoolean(byKey, 'agent.inviteRequired', undefined, false)`；`boot()` 返回 `{version, agentInviteEnabled, agentInviteRequired}`（2 → 3 字段）
- 更新 `client-config.controller.ts` 里「二十一键」「只回两个字段」等陈旧注释；测试逐字名单、`toHaveLength(22→23)`、boot 精确键集同步

网关：`agent.*` 前缀已由 P-ag0 保证仅 `super_admin` 可写，无需新增策略；但**必须**新增显式路由（见 §3.10）。

user-service `ConfigCacheService`：

- `agentInviteEnabled(): boolean`、`agentInviteRequired(): boolean`：`snapshot?.[key]?.value === true`
- 缺失/类型漂移/快照不可用一律 `false`（D14）

### 3.5 user-service 注册判定

`RegisterDto.inviteCode` 的 `@Transform` 改为：

```ts
@Transform(({ value }) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : undefined,
)
```

避免空白串先撞 `@Length(1,16)` 的泛化 `10001`。

`AuthService.register`：

1. **手机号锁**（D15）：`register:phone:<sha256(phone)>`，`SET NX PX 10000`，token = `randomUUID()`；拿不到 ⇒ `DomainError(RATE_LIMITED, '操作太频繁，请稍后再试')`；`finally` 用 Lua compare-and-delete 释放。Redis 出错 ⇒ WARN 后继续（不阻断注册）
2. `findByPhone` 预检
3. 必填校验（在 `agent.bind` 之前）：

   ```ts
   const inviteCode = typeof dto.inviteCode === 'string' ? dto.inviteCode.trim().toUpperCase() : '';
   const inviteRequired = this.configCache.agentInviteEnabled() && this.configCache.agentInviteRequired();
   if (inviteRequired && inviteCode.length === 0) {
     throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '请填写邀请码');
   }
   ```

4. 非空码 ⇒ `agent.bind`；`ignored` 且必填开启 ⇒ `logger.warn` 带 `reason`，**不**失败注册
5. signup grant → 落库 → 设备绑定 → 签发 token（既有顺序不变）

必填未满足：不建用户、不发 signup grant、不调货币服务。

### 3.6 客户端

- `apps/client/src/stores/game.ts`：
  - `ClientConfigState` 的 `Omit` 列表增加 `'agentInviteRequired'`
  - 可选属性 `agentInviteRequired?: boolean`
  - state 初值 `agentInviteRequired: false`
  - `setClientConfig` 显式复制 `this.agentInviteRequired = cfg.agentInviteRequired === true`
  - 新增 `setAgentInviteRequired(value: boolean)`
- `apps/client/src/composables/useClientConfig.ts`：
  - `FAILSAFE_CLIENT_CONFIG` 增加 `agentInviteRequired: false`
  - `normalizeClientConfig` 增加 `agentInviteRequired: raw?.agentInviteRequired === true`
  - `refreshInviteBootConfig` 同时落两个标志，仍**不写** `clientConfigVersion`
- `apps/client/src/net/rest.ts`：boot 返回类型增加 `agentInviteRequired`
- `apps/client/src/pages/login/login.vue`：
  - `showInviteCode = isRegister && (game.agentInviteEnabled || inviteBootFailed)`
  - `inviteRequired = showInviteCode && game.agentInviteRequired`
  - 标签：必填 `邀请码（必填）`；正常选填 `邀请码（选填）`；boot 失败且未知 `邀请码`
  - `ensureInviteConfig()` 返回 Promise，维护 `inviteConfigLoading` / `inviteBootFailed` / in-flight 去重
  - `submit()`：注册态先 `await ensureInviteConfig()`，再 `validate()`；必填且空 ⇒ `请填写邀请码`，不发请求
  - boot 失败时 `inviteBootFailed=true`，输入框仍展示（服务端权威：不需要码时填了也不会绑；需要码时用户能填）
  - 提交仍走 `auth.signUp(..., code)`

### 3.7 管理后台

实际符号（不是 `CONFIG_LABELS`）：

- `CONFIG_IA` 的 `agent` → `switches` 增加 `agent.inviteRequired`
- `CONFIG_CONTROLS` 增加 `'agent.inviteRequired': { label: '注册邀请码必填', type: 'bool' }`
- `CONFIG_NOTES` 增加条目
- `BOOL_KEYS` 增加 `'agent.inviteRequired'`
- 代理设置页 `#ag-invite-row` 三态控件：
  - 显示优先级：`enabled=false` ⇒ `关闭`；`enabled=true && required=true` ⇒ `必填`；否则 `选填`
  - 切必填：先写 `required=true`，再写 `enabled=true`
  - 切关闭：先写 `enabled=false`，再写 `required=false`
  - 切选填：写 `required=false`，再写 `enabled=true`
  - 任一步失败 ⇒ 重新拉配置并回显；固定提示「必填仅在代理模块启用时生效」
  - 非 super_admin 用 `canWriteConfigKey('agent.inviteRequired')` 禁用
- 码列表/撤销仅 super_admin 可见；rotate 确认文案显示「将作废 N 枚未使用码」
- `scripts/verify-admin-static.mjs` 计数同步：protocol 113、active 97、`CONFIG_IA` 97、`CONFIG_NOTES` 97、`CONFIG_CONTROLS` entries 90、`BOOL_KEYS` 44、`NUMBER_SUFFIX` 44、`AGENT_TABS` 6

### 3.8 代理端静态页（`agent/`）

- `GET /api/agent/me` 新字段：`inviteCode`（可空）、`inviteCodesActive`、`inviteEnabled`、`settingsEnabled`、`required`
- 「我的」页：状态 banner（功能未开/已冻结/必填中）；列表 + 状态筛选（未使用/已使用/已失效）；「生成」按钮（1/5/10/20/50）+ 今日剩余额度；「复制全部未使用」
- 空态：`inviteCode` 为 null 时显示「暂无可用邀请码，请生成或联系管理员」
- 旧缓存页面：`inviteCode` 仍返回最新 active；码用尽后显示 null，页面按空态降级
- `scripts/verify-agent-static.mjs` 增加 `/api/agent/invite-codes` 白名单与结构 id

### 3.9 错误文案

| 场景 | 码 | HTTP | message |
|---|---|---|---|
| 必填未填 | `11006` | 400 | `请填写邀请码` |
| 码不存在 / 已撤销 / 代理冻结 | `11006` | 400 | `邀请码无效` |
| 码已被使用 | `11006` | 400 | `邀请码已被使用` |
| 冻结代理生成码 | `11007` | 403 | `代理已被冻结` |
| 功能未开生成码 | `10003` | 403 | `邀请码功能未开放` |
| 生成数量非法 / 超日限 | `10001` | 400 | `生成数量须为 1–50` / `今日生成数量已达上限` |
| 同手机号并发注册 | `10006` | 429 | `操作太频繁，请稍后再试` |

`11006` 在客户端文案表是 message-first，服务端 message 直接展示；能渲染邀请码框的老客户端版本必然认识该码。

### 3.10 网关显式路由

`packages/api-gateway/src/gateway/gateway.controller.ts` 新增：

- `POST /api/agent/invite-codes` → currency `POST /api/agent/invite-codes`
- `GET /api/agent/invite-codes` → `strictQueryOf(req, ['status','cursor','limit'])`
- `GET /api/admin/agents/:id/invite-codes` → `strictQueryOf(req, ['status','cursor','limit'])`
- `POST /api/admin/agents/:id/invite-codes/:code/revoke`

`packages/api-gateway/src/auth/admin-policy.ts`：在 P-ag1 **之前**加精确分支，`GET /api/admin/agents/:id/invite-codes` ⇒ 仅 `super_admin`（active 码是 bearer credential，finance 不得读取）。单码撤销走 P-ag2（super_admin）。

`scripts/verify-agent-static.mjs` 白名单增加 `/api/agent/invite-codes`。

### 3.11 观测与日志

新增指标：

- user-service：`user_registration_failures_total{reason}`（`invite_missing|invite_invalid|phone_taken|rate_limited|upstream|db`）
- currency-service：`agent_invite_generated_total`、`agent_invite_rejected_total{reason}`、`agent_invite_consumed_total{result}`、`agent_bind_ignored_total{reason}`
- 告警：`agent_bind_ignored_total{reason="config_unavailable"}` > 0；必填开启后 `user_registration_failures_total{reason="invite_missing"}` 突增；`agent_invite_generated_total` 异常
- 看板/告警文件：`deploy/monitoring/grafana/dashboards/05-currency.json`（代理邀请码面板）、`deploy/monitoring/prometheus/rules/ftl-alerts.yml`（上述三条告警）

日志纪律：

- 不打印完整邀请码；新日志用 `agentId + 码后 2 位 + status`
- `packages/shared/src/logging/redact.ts` 增加 `inviteCode` / `invite_code` 键规则（不误伤通用 `code`）
- admin audit 只保存 `{ revoked, codeTail }`（rotate）或 `{ codeTail }`（revoke），不保存完整 active 码；仅 super_admin 可读 audit 面仍保持既有策略

## 4. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 必填开、代理模块 `agent_settings.enabled=false` | `bind` 返回 `ignored: settings_disabled`，注册成功但无归属；后台提示 + 指标 |
| 必填开、currency 快照不可用 | `ignored: config_unavailable`，注册成功但无归属；指标/告警 |
| 绑定成功后 signup grant 失败 / 落库失败 / RPC 响应丢失 | 码已烧 + 孤儿绑定；日志/metric；管理员用单码撤销/补发处理（残余 R1，见 §7） |
| 同一码并发注册 | 代理行锁 + 码行锁 + 条件更新只放行一人，另一人 `11006 邀请码已被使用` |
| 同一手机号并发注册 | Redis 手机号锁：后到者 `429/10006`，不会烧两枚码 |
| 配置传播窗口 | user-service/currency-service 各自快照；bind 返回结构化 `reason`，指标可见；客户端 boot 每次查库 |
| 配置快照不可用 | user-service `required=false` 不阻断注册；currency `ignored` 打点（D14） |
| 老客户端 boot 拉取失败 | 新客户端兜底展示输入框；老客户端仍隐藏，运营确认旧版占比后再开必填 |
| 后台两键写入非原子 | 按 §3.7 顺序写，任何中途失败落在「非必填」安全侧 |
| 注册重试 / 重复手机号 | 手机号锁 + `already_bound` 幂等预检；串行重试不重复烧码 |
| 代理冻结 | 绑定/生成都锁代理行复核 active；冻结后生成 `11007`，注册 `11006` |
| 码被 rotate 后注册 | 码行锁读到 `revoked` ⇒ `邀请码无效`，不误报「已被使用」 |
| 码被使用后用户被删除 | `used` 终态不回滚；归属历史保留 |
| 日生成上限并发 | 事务第一条语句锁代理行，串行化计数；rotate 生成的新码也计入 |
| 滚动发布 / 回滚 | 码已发放后禁止回滚 currency 镜像；先停发码、关 required/enabled，再回滚其它服务 |

## 5. 测试判据

### protocol

- `agent.inviteRequired` 解析：`true/false` 合法，非 boolean 拒绝
- `AgentBindData.reason` 可选字段类型
- `CONFIG_KEYS` / `CLIENT_CONFIG_KEYS` 精确键集与计数（113 / 23）

### config-service

- `/api/config` 与 `/api/config/boot` 都返回 `agentInviteRequired`；boot 恰三字段
- 缺键/坏值 ⇒ `false`
- 种子迁移：version = 全表 MAX、`INSERT IGNORE`、`down()` 删除
- 逐字键集断言、`toHaveLength(23)`、boot 精确键集同步

### user-service

- 必填开 + 缺码 ⇒ `400/11006`、message `请填写邀请码`、不建用户、不调 `currency.apply`
- 必填开 + 空白串 ⇒ 同上（Transform 转 undefined）
- 必填关 / 快照缺失 ⇒ 缺码照常注册
- 必填开 + `inviteEnabled=false` ⇒ 缺码照常注册（AND 语义）
- 必填开 + 无效码 ⇒ `11006`、不建用户
- 必填开 + `agent.bind` 返回 `ignored` ⇒ 注册成功 + 带 reason 的 warn
- 手机号锁：并发两次同手机号 ⇒ 一个成功、一个 `429/10006`；失败路径 finally 释放锁；Redis 异常时 fail-open
- `already_bound` 仍视为成功（滚动兼容）

### currency-service

- `createMany`：数量、长度 8、字符域、唯一性；冻结/功能关闭/超日限/非法 count 拒绝
- 消费：`status=used`、`used_by`、`used_at` 正确
- 重复使用 ⇒ `11006 邀请码已被使用`；revoked/冻结/不存在 ⇒ `邀请码无效`
- 并发两注册同码 ⇒ 恰一人 `bound`，另一人 `11006`；DB 恰一行 used、一行 binding
- 绑定写失败 ⇒ 事务回滚，码仍 `active`（单测用假 DB 的 transaction 快照/回滚模拟事务契约；真实 InnoDB 并发原子性由 conformance slice-32 在真栈覆盖，禁止只 mock `affectedRows`）
- 功能关闭（`settings.enabled=false` 或 `inviteEnabled=false`）⇒ `ignored` + reason 且码不消费
- currency 快照缺失 ⇒ `ignored: config_unavailable`
- `already_bound` 预检：同 ownerId 重试不消费新码
- `rotate` ⇒ 全部 active 变 revoked + 新码 1 枚；响应 `{code}`
- 单码撤销：active→revoked；used/已撤销/不属于该代理 ⇒ 拒绝
- 日上限并发（barrier）：当日 150 + 两请求各 50 ⇒ 至多一个成功或总数不超过 200

### 客户端

- boot 归一化两个标志；缺字段 ⇒ false
- boot 未返回时点击提交会 await，不会抢跑
- boot 失败 ⇒ 输入框仍展示；必填开时标签/空值拦截正确
- 必填开：标签「邀请码（必填）」、空值拦截、不发请求
- 必填关：行为与今天一致（选填）
- `setClientConfig` 复制两个标志，不被全量配置静默重置

### 管理后台 / 代理端

- `pnpm verify:admin`：新键在 `CONFIG_IA`/`CONFIG_CONTROLS`/`CONFIG_NOTES`/`BOOL_KEYS`，计数 113/97/97/90/44；三态控件与 `#ag-invite-row` 锚点
- finance/operator：码列表 403；super_admin 可读
- `verify-agent-static`：列表/生成按钮/API 路径锚点存在

### conformance

- **重写 slice-32**：每个成功注册前用 `POST /api/agent/invite-codes {count:1}` 取新码；`enabled=false` 的重复 bind 仍 `ignored` 且码不消费
- 同码第二次注册 ⇒ `400/11006 邀请码已被使用`
- 并发同码（barrier）⇒ 恰一人成功
- rotate 后旧码注册 ⇒ `邀请码无效`
- 冻结代理生成 ⇒ `11007`；冻结代理的码注册 ⇒ `11006`
- boot 精确三键 `agentInviteEnabled,agentInviteRequired,version`
- `/me` 断言 active 码集合而非固定码
- `putConfigAndWait` 扩展为同时等待 currency-service 与 user-service 的 `config snapshot applied version=…`
- preflight 断言 `agent.inviteRequired=false`；finally 同时恢复 `agent.inviteEnabled` / `agent.inviteRequired` / `agent_settings.enabled`
- operator `PUT agent.inviteRequired` ⇒ 403（P-ag0）
- 其余 slice 键表更新：slice-14 / 17 / 18 / 21 / 23 / 24 增加 `agentInviteRequired`（排序在 `agentInviteEnabled` 后）

### 迁移

- 新 currency 迁移：ALTER 列、down 重置 used、类名、跨包时间戳唯一
- config 种子迁移：全仓唯一扫描、version MAX、down

## 6. 风险与残余

| 风险 | 等级 | 处置 |
|---|---|---|
| bind RPC 超时/响应丢失后码已烧，用户重试撞「已被使用」 | 高 | 本期登记为残余：指标 `agent_invite_consumed_total` + 管理员单码撤销/补发；后续用注册请求幂等键或 reserve/confirm 两阶段彻底解决 |
| `agent_settings.enabled=false` 时必填无牙 | 高 | 后台固定提示；bind 返回 `settings_disabled` 指标；上线清单要求两个开关同开 |
| currency 快照不可用导致 `ignored` | 中 | `config_unavailable` 指标 + 告警；D14 刻意 fail-open |
| 老客户端 boot 失败时无法注册 | 中 | 新客户端兜底展示输入框；运营确认旧版占比后再开必填 |
| 码状态 oracle（无效/已使用可区分） | 低 | 接受：8 位码空间约 2^40，注册 IP 120/min 限流；记录为可接受风险 |
| 日生成上限并发略超 | 低 | 事务第一条语句锁代理行；常量兜底 |
| 码表增长（已使用码长期保留） | 低 | 单代理 200/日上限；后续可按需归档 |
| 后台三态两次 PUT 非原子 | 低 | 写入顺序保证失败落在非必填侧；失败后重新拉配置回显 |
| 代理用 usedAt + 玩家列表反查归属 | 低 | 代理本就能看自己的玩家列表；不新增原始 ownerId |
| 全量配置晚于 boot 覆盖 required | 低 | 注册页每次 await boot；`setClientConfig` 也复制新字段；服务端权威 |

## 7. 涉及文件（预估）

**protocol**

- `packages/protocol/src/config.ts`
- `packages/protocol/src/config.test.ts`
- `packages/protocol/src/rpc.ts`

**config-service**

- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/migrations/1798700000000-AgentInviteRequiredSeed.ts`
- `packages/config-service/test/client-config.test.ts`
- `packages/config-service/test/platform-config.service.test.ts`
- `packages/config-service/test/migration.test.ts`
- `packages/config-service/test/helpers/config-probe.ts`

**user-service**

- `packages/user-service/src/config/config-cache.service.ts`
- `packages/user-service/src/auth/auth.service.ts`
- `packages/user-service/src/users/users.dto.ts`
- `packages/user-service/src/metrics/player.metrics.ts`
- `packages/user-service/test/auth.service.test.ts`

**currency-service**

- `packages/currency-service/src/migrations/1798600000000-AgentInviteSingleUse.ts`
- `packages/currency-service/src/agent/agent-invite.service.ts`
- `packages/currency-service/src/agent/agent-bindings.service.ts`
- `packages/currency-service/src/agent/agent-portal.controller.ts`
- `packages/currency-service/src/agent/agent-portal.service.ts`
- `packages/currency-service/src/agent/agent-admin.controller.ts`
- `packages/currency-service/src/agent/agent-accounts.service.ts`
- `packages/currency-service/src/agent/agent.constants.ts`
- `packages/currency-service/src/agent/agent-sql.util.ts`（共享 `affectedRowsOf`）
- `packages/currency-service/src/agent/agent.metrics.ts`
- 对应测试：`agent-invite.test.ts`、`agent-bindings.test.ts`、`agent-bind.rpc.test.ts`、`agent-portal.test.ts`、`agent-admin.test.ts`、`agent-domain.migration.test.ts`、新增 `agent-invite-single-use.migration.test.ts`、`agent-sql.util.test.ts`

**网关**

- `packages/api-gateway/src/gateway/gateway.controller.ts`
- `packages/api-gateway/src/auth/admin-policy.ts`
- `packages/api-gateway/src/auth/public-paths.ts`（注释）
- `packages/api-gateway/test/admin-policy.test.ts`
- `packages/api-gateway/test/gateway.controller.test.ts`
- 网关路由/query 白名单测试

**客户端**

- `apps/client/src/stores/game.ts`
- `apps/client/src/composables/useClientConfig.ts`
- `apps/client/src/net/rest.ts`
- `apps/client/src/pages/login/login.vue`
- `apps/client/test/login-screen.test.ts`
- `apps/client/test/client-config-shared.test.ts`

**管理后台 / 代理端**

- `admin/app.js`
- `admin/index.html`
- `scripts/verify-admin-static.mjs`
- `scripts/admin-agents-probe.mjs`
- `scripts/verify-monitoring.mjs`
- `agent/app.js`
- `agent/index.html`
- `scripts/verify-agent-static.mjs`

**shared**

- `packages/shared/src/logging/redact.ts`（邀请码脱敏）
- `packages/shared/test/redact.test.ts`

**监控**

- `deploy/monitoring/grafana/dashboards/05-currency.json`（代理邀请码面板）
- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（告警规则）

**conformance**

- `tools/conformance/src/slices/slice-32-agent.ts`（重写注册码获取与矩阵）
- `tools/conformance/src/slices/slice-14-config-center.ts`
- `tools/conformance/src/slices/slice-17-currency.ts`
- `tools/conformance/src/slices/slice-18-gold-room.ts`
- `tools/conformance/src/slices/slice-21-payment.ts`
- `tools/conformance/src/slices/slice-23-notify-channel.ts`（文案）
- `tools/conformance/src/slices/slice-24-ads-relief.ts`

**文档**

- `docs/client-protocol.md`（客户端 23 键、boot 三字段、11006 文案）
- `docs/design.md`（协议 113 键、boot）
- `docs/ops/first-deploy.md`（键数）
- `packages/protocol/src/config.ts` / `config.test.ts` / `admin/app.js` 注释里的「101 / 96 / 21」等陈旧计数

## 8. 上线与回滚

上线顺序：

1. currency-service 迁移 + 一次性消费（当前无码，零行为变化）→ 验证绑定链路
2. config-service / user-service / 客户端 / 网关 / 后台 / 代理端一起发（`required` 默认 `false`）
3. 开代理模块 `agent_settings.enabled` + `agent.inviteEnabled`；代理开始批量生成码
4. super_admin 打开 `agent.inviteRequired`
5. 观察注册成功率、`user_registration_failures_total{reason}`、`agent_invite_consumed_total`、`agent_bind_ignored_total{reason}`、生成量
6. **灰度口径**：`required=true` 后未升级客户端可能不显示邀请码字段（boot 失败时）或不做前端校验；开启前用外部应用分发数据确认旧版占比，必要时先推强制更新

回滚：

- 先停发码（关 `agent.inviteEnabled` 或让代理停止分发）
- 关 `agent.inviteRequired` ⇒ 回到选填
- 服务版本：
  - config-service / user-service / 客户端 / 网关可回滚（旧代码忽略新键）
  - **currency-service 在码已发放后禁止回滚**（旧逻辑不消费码，会变回可重复使用）；只能前滚修复
- 回滚后校验：`agent_invite_codes.status='used'` 与 `agent_bindings` 行数一致；不一致走人工审计

## 9. 审查记录

审查日期：2026-11-03。三份独立只读审查（并发/事务/数据模型；配置链/客户端/后台/兼容；测试/安全/运维/产品边界）。结论：核心机制（条件抢占 + 同事务回滚）成立；r1 的阻断项已在 r2 修复。

### 阻断（全部已修）

| # | 发现 | 处置 |
|---|---|---|
| B1 | 新迁移时间戳 `1798200000000` / `1798300000000` 与 `MahjongRecords` / `BurnPenalty` 撞号，且低于全仓 MAX `1798500000000` | 改用 `1798600000000`（currency）/ `1798700000000`（config），补跨包唯一测试 |
| B2 | 「邀请码已被使用」按现有 `resolve`（`AND c.status='active'`）不可达，与 §3.9/§5 矛盾 | `resolve` 改为返回 `codeStatus + agentStatus`，按 D6 三档分类 |
| B3 | 网关是显式路由 + `strictQueryOf` 白名单，r1 文件清单漏 `api-gateway`，新端点会 404/丢参 | §3.10 增加 4 条路由、query 白名单、admin 策略与测试 |
| B4 | conformance slice-32 大量复用同一码，一次性语义下全线红 | §5 改为「重写」：每次成功注册前生成新码；boot 三键；双服务等待；finally 恢复两个开关 |
| B5 | slice-14/17/18/21/24 写死 22 键逐字名单 | §5/§7 纳入，统一加 `agentInviteRequired` |
| B6 | 键集计数基线错误（实际 22→23、协议 112→113、boot 2→3、admin 97/90/97/44） | §3.4/§3.7/§5 全面改正 |

### 高（已修或已登记）

| # | 发现 | 处置 |
|---|---|---|
| H1 | REPEATABLE READ 下 `affectedRows=0` 后用普通 SELECT 判状态会读旧快照 | 改为锁代理行 + 锁码行（当前读）后再分类（§3.2） |
| H2 | 同手机号并发不同码会烧两枚码 / 重复发赠币 | 新增手机号 Redis 短锁（D15/§3.5） |
| H3 | bind RPC 超时/响应丢失 = 码已烧 + 幽灵绑定 | 登记残余（§6）；加指标与管理员单码撤销/补发；不做跨 RPC 幂等键 |
| H4 | 日上限锁序未写死，可能先读后锁导致超发 | 事务第一条语句锁代理行（§3.3） |
| H5 | 列表 cursor 只传 code、排序却是 `(created_at, code)` | 服务端按 code 反查复合位置；`activeCode` 加 `code DESC` 兜底 |
| H6 | 冻结代理 TOCTOU：resolve 后、抢占前被冻结仍可绑定 | 绑定事务锁代理行复核 active（§3.2） |
| H7 | `rotate` 响应现状是 `{code}`，r1 写反 | §3.3 改为保持 `{code}` |
| H8 | 后台实际符号是 `CONFIG_IA/CONFIG_CONTROLS/CONFIG_NOTES/BOOL_KEYS`，无 `CONFIG_LABELS` | §3.7 改用真实符号并列全计数 |
| H9 | currency 快照不可用静默 `ignored`，warn 归因错误 | `ignored` 增加结构化 `reason`（`settings_disabled/invite_disabled/config_unavailable`）+ 指标 |
| H10 | 客户端 boot 异步不阻塞提交，旧快照可显示选填而服务端拒绝 | `submit()` await boot；加载态；失败兜底展示输入框（§3.6） |
| H11 | 冻结代理仍可登录并批量生成码 | 生成事务锁代理行复核 active，非 active ⇒ `11007`（§3.3） |
| H12 | P-ag1 允许 finance 读取完整 active 码（bearer credential） | 码列表改为 super_admin 专属精确分支（§3.10） |
| H13 | 功能关闭时仍可生成码，形成「发出去但没用」的空白承诺 | 生成要求两个开关同开 + 代理 active（§3.3） |
| H14 | 没有失败/原因/生成/消费指标，上线观测不可执行 | §3.11 指标 + 告警清单 |
| H15 | rotate 语义变化缺运营流程：单码泄漏只能全撤 | 新增管理员单码撤销；rotate 确认显示作废数量；代理端复制全部/筛选/剩余额度 |
| H16 | 回滚只列开关，没有服务版本矩阵 | §8 增加回滚矩阵；码已发放后禁止回滚 currency |

### 低（已修或登记）

| # | 发现 | 处置 |
|---|---|---|
| L1 | 迁移 `down()` 只删列，`used` 状态残留 | down 先重置 used→active（§3.1） |
| L2 | 管理端列表不返回 usedBy，客服无法排查 | super_admin 列表返回 `usedByMaskedPhone`（不含原始 UUID） |
| L3 | `/me.inviteCode` 用尽后为 null，旧页面空白 | 明确 nullable；代理端空态提示（§3.8） |
| L4 | 配置传播窗口的具体后果未写 | §4 写明「必填开但 currency 仍 ignored」形态 + 指标 |
| L5 | 11006 三档文案构成码状态 oracle | 登记为可接受风险（§6） |
| L6 | §7 缺迁移专项测试文件 | 补 currency/config 迁移测试与 fixture（§3.1/§7） |
| L7 | `verify-admin-static` 多个精确计数未列全 | §3.7 列全 113/97/97/90/44/44/6 |
| L8 | 测试矩阵缺 rotate/冻结/日上限并发/真实 DB 回滚/客户端 boot 失败 | §5 增加；禁止只 mock `affectedRows` |
| L9 | 文档/注释大面积过期（101/96/21/22 键） | §7 文档清单 + 实现时同步 |
| L10 | 日志无邀请码脱敏规则 | shared redactor 增加 `inviteCode` 键规则；日志只打码后 2 位（D18） |
| L11 | `already_bound` 契约被静默退休，滚动兼容风险 | 保留状态并前置幂等预检（D16） |
| L12 | 三态控件对 `enabled=false + required=true` 无回声；角色未禁用 | §3.7 定义显示优先级与 `canWriteConfigKey` 禁用 |
| L13 | `activeCode` 同毫秒结果不确定 | 加 `code DESC` tiebreaker（§3.3） |
| L14 | 旧代理页码用尽后无提示 | 代理端空态 + `/me` nullable（§3.8） |
| L15 | agent 静态校验白名单未列新路径 | §3.10/§7 纳入 `verify-agent-static` |

### 未采纳/登记

- 跨 RPC 注册幂等键 / reserve-confirm 两阶段：本期不做，登记为残余（H3）。
- 客户端版本头 / 最低版本闸：本期不做；旧版占比用外部应用分发数据判断（D12）。
- 代理自助撤销单枚码：不做；管理员单码撤销 + rotate 兜底。
- 码有效期、按手机号预绑定、导出 CSV：不做。
