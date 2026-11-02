# 注册邀请码必填 + 一次性邀请码设计（2026-11-03）

> 状态：设计草案（待对抗审查）
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
- user-service 注册时按「入口开 + 必填开」强制要求邀请码
- `agent_invite_codes` 扩展为一次性码（`active/used/revoked` + `used_by/used_at`）
- 消费时原子抢占，与绑定写同一事务
- 代理端批量生成 / 列表接口与页面
- 管理后台：配置中心行、代理设置三态控件、代理详情码列表（只读）、`rotate` 语义调整
- 客户端：boot 返回必填标志、注册页必填文案与空值校验
- 测试与 conformance 扩展

### 不做（YAGNI）

- 非代理通用邀请码 / 邀请制注册（本期只做代理归属）
- 邀请码有效期、按手机号预绑定
- 代理自助撤销单枚码（泄漏用管理员 `rotate` 兜底）
- 老客户端版本闸（不做 `X-Client-Version` / 最低版本判断）
- 存量码迁移（当前无存量码）
- 代理分佣/结算逻辑调整

## 2. 决策表

| 编号 | 决策 | 内容与理由 |
|---|---|---|
| D1 | 开关模型 | 新增 `agent.inviteRequired`，与 `agent.inviteEnabled` 并存。`enabled` 控入口，`required` 控必填。默认 `false`，回滚只需关 `required` |
| D2 | 生效条件 | 服务端与客户端都按 `enabled && required` 判定。入口关时必填自动失效（fail-open），避免「入口隐藏 + 服务端强制」把注册全部堵死 |
| D3 | 强制点 | user-service `AuthService.register`。空码 → `400 / 11006`，message `请填写邀请码`。前端校验只做体验，不作为安全边界 |
| D4 | 一次性码模型 | `agent_invite_codes` 增加 `used_by varchar(36) NULL`、`used_at datetime(3) NULL`；`status` 取值扩展为 `active/used/revoked`。去掉「一代理仅一枚 active」的应用层约束 |
| D5 | 消费原子性 | `UPDATE ... SET status='used', used_by=?, used_at=NOW(3) WHERE code=? AND status='active'`；`affectedRows=1` 才继续绑定；与 `agent_bindings` 写入同一事务，异常整体回滚（码恢复 active） |
| D6 | 发放方式 | 代理端自助批量生成：`POST /api/agent/invite-codes {count}`，单次 `1..50`，单代理每日上限 `200`（`agent.constants.ts` 常量，后续可按需配置化） |
| D7 | 代理端 API | 新增生成/列表；`GET /api/agent/me` 保留 `inviteCode`（最新 active）做兼容，新增未使用数量 |
| D8 | 管理后台 | 配置中心「代理 → 开关」增加行；代理设置页用三态控件 `关闭 / 选填 / 必填` 写两个键；代理详情只读码列表；`rotate` = 作废全部未使用码 + 发 1 枚新码 |
| D9 | 客户端 | `GET /api/config/boot` 增加 `agentInviteRequired`；注册页必填文案 + 提交前空值校验；每次进入注册态刷新 boot，避免旧快照把必填显示成选填 |
| D10 | 错误语义 | 复用 `11006`（message-first）。三类 message：`请填写邀请码` / `邀请码无效` / `邀请码已被使用`。能显示邀请码框的老客户端必然认识 11006，服务端文案可直接生效 |
| D11 | 老客户端 | 不做版本闸。服务端权威；开关打开后老客户端不填码会被拒。运维前提：确认旧版本占比可接受再开必填 |
| D12 | 回滚 | 关 `agent.inviteRequired` 即回选填；一次性语义不回退（当前无存量码，成本为零） |
| D13 | 配置不可用 | user-service 快照缺失/坏值 ⇒ `required=false`（不阻断注册）。可用性优先于归属完整性，风险登记见 §6 |

## 3. 实现设计

### 3.1 数据模型与迁移

currency-service 新迁移 `1798200000000-AgentInviteSingleUse.ts`（类名不得以 `Currency` 开头）：

```sql
ALTER TABLE `agent_invite_codes`
  ADD COLUMN `used_by` varchar(36) NULL DEFAULT NULL,
  ADD COLUMN `used_at` datetime(3) NULL DEFAULT NULL;
```

- `code varchar(16) PK` 不变；`agent_id`、`created_at` 不变
- `status` 仍为 `varchar(10)`，新值 `used` 合法
- 索引沿用 `(agent_id, status)`；列表按 `created_at DESC, code DESC` 排序（量小，暂不加复合索引）
- `down()`：删除两列（仅回滚开发库用；生产不逆向已消费数据）

状态机：

```text
active --注册消费--> used（终态）
active --rotate/管理员作废--> revoked（终态）
used / revoked 不再变化
```

### 3.2 一次性消费时序

`AgentBindingsService.bindFromSignup`（同一事务）：

1. `settings = getOrDefault()`；`!settings.enabled || !config.agentInviteEnabled()` ⇒ `{status:'ignored'}`（码不消费）
2. `resolve(code)`：不存在 / `status !== 'active'` / 代理非 active ⇒ `AGENT_INVITE_INVALID`（message `邀请码无效`）
3. 条件更新抢占：

   ```sql
   UPDATE `agent_invite_codes`
      SET `status` = 'used', `used_by` = ?, `used_at` = NOW(3)
    WHERE `code` = ? AND `status` = 'active'
   ```

   `affectedRows !== 1` ⇒ 并发失败方 ⇒ `AGENT_INVITE_INVALID`（message `邀请码已被使用`）
4. `INSERT IGNORE agent_bindings` + `agent_binding_history`
   - `affectedRows=1` ⇒ `{status:'bound'}`
   - `affectedRows=0`：注册场景 `ownerId` 恒为新 uuid，理论不可达；按内部不一致处理，抛错让事务回滚（不烧码）
5. 任一步异常 ⇒ 整事务回滚，码恢复 `active`

并发正确性：条件更新是唯一闸门，不需要 `SELECT ... FOR UPDATE`。两个注册同时用同一码，只有一个能把 `active` 改成 `used`。

### 3.3 生成与列表

`AgentInviteService`：

- `createMany(manager, agentId, count)`：循环 `createFor`，同一事务；撞码重试沿用现有 `CREATE_ATTEMPTS`
- `activeCode(agentId)`：保留，返回最新 active（`ORDER BY created_at DESC LIMIT 1`）
- `rotate(manager, agentId)`：`UPDATE ... SET status='revoked' WHERE agent_id=? AND status='active'`，再 `createFor` 一枚新码

`AgentPortalController`：

- `POST /api/agent/invite-codes`：body `{count}`；`1..50`，非法 → `10001`；每日生成上限 200（按 `created_at >= CURDATE()` 统计，超限 → `10001` + message `今日生成数量已达上限`）。生成前 `SELECT ... FOR UPDATE` 锁 agent 行，避免并发略超
- `GET /api/agent/invite-codes?status=active|used&cursor=&limit=`：只返回本人码；`limit` 默认 50、上限 100；cursor 为上一页最后一条 `code`，按 `(created_at, code)` 倒序
- 返回字段：`code`、`status`、`createdAt`、`usedAt`；不返回 `used_by`（避免把玩家 UUID 暴露给代理端）
- `GET /api/agent/me` 新增 `inviteCodesActive: number`，保留 `inviteCode`

`AgentAdminController`（沿用 P-ag1 读权限）：

- `GET /api/admin/agents/:id/invite-codes?status=&cursor=&limit=`：只读列表
- `POST /api/admin/agents/:id/invite-code/rotate`：语义改为「作废全部未使用 + 发 1 枚新码」，响应保持 `{inviteCode}`

### 3.4 配置链

protocol（`packages/protocol/src/config.ts`）：

- `CONFIG_KEYS` 增加 `'agent.inviteRequired'`
- `parseConfigValue` 增加严格 boolean 分支（照 `agent.inviteEnabled`）
- `CLIENT_CONFIG_KEYS` 增加裸名 `'agentInviteRequired'`
- `ClientConfig` 接口增加 `agentInviteRequired: boolean`

config-service：

- 新种子迁移 `1798300000000-AgentInviteRequiredSeed.ts`：version 取全表 MAX（至少 1）、`INSERT IGNORE ('agent.inviteRequired', 'false', version, NOW(3), 'seed')`
- `ClientConfigController.get()` 读 `readBoolean(byKey, 'agent.inviteRequired', undefined, false)`；`boot()` 返回 `{version, agentInviteEnabled, agentInviteRequired}`
- 键集计数从 21 → 22，同步更新注释与所有精确键集断言

网关：`agent.*` 前缀已由 P-ag0 保证仅 `super_admin` 可写，无需新增策略。

user-service `ConfigCacheService`：

- `agentInviteEnabled(): boolean`：`this.snapshot?.['agent.inviteEnabled']?.value === true`
- `agentInviteRequired(): boolean`：`this.snapshot?.['agent.inviteRequired']?.value === true`
- 缺失/类型漂移/快照不可用一律 `false`（D13）

### 3.5 user-service 注册判定

`RegisterDto.inviteCode` 的 `@Transform` 改为：

```ts
@Transform(({ value }) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : undefined,
)
```

避免空白串先撞 `@Length(1,16)` 的泛化 `10001`，让服务层能给出精确文案。

`AuthService.register` 顺序（在手机号预检之后、`agent.bind` 之前）：

```ts
const inviteCode = typeof dto.inviteCode === 'string' ? dto.inviteCode.trim().toUpperCase() : '';
const inviteRequired = this.configCache.agentInviteEnabled() && this.configCache.agentInviteRequired();
if (inviteRequired && inviteCode.length === 0) {
  throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '请填写邀请码');
}
```

- 必填未满足：不建用户、不发 signup grant、不调货币服务
- `agent.bind` 返回 `ignored` 且必填开启 ⇒ `logger.warn` 留痕（说明 `agent_settings.enabled=false`，必填实际没牙），**不**失败注册

### 3.6 客户端

- `apps/client/src/stores/game.ts`：`ClientConfigState`、`FAILSAFE_CLIENT_CONFIG`、`applyClientConfig`、新增 `setAgentInviteRequired`
- `apps/client/src/composables/useClientConfig.ts`：`normalizeClientConfig` 增加 `agentInviteRequired: raw?.agentInviteRequired === true`；`refreshInviteBootConfig` 同时落两个标志，仍**不写** `clientConfigVersion`
- `apps/client/src/net/rest.ts`：boot 返回类型增加 `agentInviteRequired`
- `apps/client/src/pages/login/login.vue`：
  - `showInviteCode = isRegister && agentInviteEnabled`
  - `inviteRequired = showInviteCode && agentInviteRequired`
  - 标签：`邀请码（必填）` / `邀请码（选填）`
  - `validate()`：`inviteRequired && !inviteCode.trim()` ⇒ `请填写邀请码`，不发请求
  - `ensureInviteConfig`：每次切到注册态都拉一次 boot（公开、极小），去掉「全量配置已加载且 enabled=true 就跳过」的旧短路
  - 提交仍走 `auth.signUp(..., code)`

### 3.7 管理后台

- `admin/app.js` 配置域：`agent` → `switches` 增加 `agent.inviteRequired`；`CONFIG_LABELS` 增加 `注册邀请码必填`
- 代理设置页：`#ag-invite-row` 由单行 boolean 改为三态控件：
  - `关闭`：写 `enabled=false`、`required=false`
  - `选填`：写 `enabled=true`、`required=false`
  - `必填`：写 `required=true`、`enabled=true`
  - 写入顺序保证中途失败落在「非必填」安全侧：切必填先写 required 再写 enabled；切关闭先写 enabled 再写 required
  - 固定提示：「必填仅在代理模块启用时生效」；非 super_admin 禁用控件
- 代理详情：未使用/已使用数量 + 码列表（只读）
- `scripts/verify-admin-static.mjs` 的精确键清单与 `#ag-invite-row` 断言同步更新

### 3.8 代理端静态页（`agent/`）

- 「我的」页：单码展示改为列表 + 「生成」按钮（数量选择 1/5/10/20/50）+ 复制；状态筛选「未使用 / 已使用」
- `scripts/verify-agent-static.mjs` 同步更新
- 旧页面兼容：`/me` 仍返回最新 `inviteCode`，旧缓存页面不至于空白

### 3.9 错误文案

| 场景 | 码 | HTTP | message |
|---|---|---|---|
| 必填未填 | `11006` | 400 | `请填写邀请码` |
| 码不存在 / 已撤销 / 代理冻结 | `11006` | 400 | `邀请码无效` |
| 并发抢码失败 / 已使用 | `11006` | 400 | `邀请码已被使用` |
| 生成数量非法 / 超日限 | `10001` | 400 | `生成数量须为 1–50` / `今日生成数量已达上限` |

`11006` 在客户端文案表是 message-first，服务端 message 会直接展示；能渲染邀请码框的老客户端版本必然认识该码。

## 4. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 必填开、代理模块 `agent_settings.enabled=false` | `agent.bind` 返回 `ignored`，注册成功但无归属；后台提示 + 服务端 warn |
| 绑定成功后 signup grant 失败 | 码已烧 + 孤儿绑定（沿既有残余 R1）；日志留痕，管理员可补发码 |
| 同一码并发注册 | 条件更新只放行一人，另一人 `11006 邀请码已被使用` |
| 配置传播窗口 | user-service 走 pub/sub + 60s 安全网；boot 每次查库。客户端可能短暂超前/滞后，服务端权威 |
| 配置快照不可用 | `required=false`，注册不被阻断（D13），可能产生未归属用户 |
| 老客户端 boot 拉取失败 | 字段隐藏 + 必填开启 ⇒ 无法注册；重进注册态会重试，属可恢复边缘 |
| 后台两键写入非原子 | 按 §3.7 顺序写，任何中途失败都落在「非必填」安全侧 |
| 注册重试 / 重复手机号 | 手机号预检在消费之前，不会重复烧码 |
| 代理冻结 | `resolve` 返回非 active ⇒ `11006 邀请码无效`，不消费码 |
| 日生成上限并发 | 生成前锁 agent 行，串行化计数 |
| 码被使用后用户被删除 | `used` 终态不回滚；归属历史保留 |

## 5. 测试判据

### protocol

- `agent.inviteRequired` 解析：`true/false` 合法，非 boolean 拒绝
- `CONFIG_KEYS` / `CLIENT_CONFIG_KEYS` 精确键集与计数

### config-service

- `/api/config` 与 `/api/config/boot` 都返回 `agentInviteRequired`
- 缺键/坏值 ⇒ `false`
- 种子迁移：version = 全表 MAX、`INSERT IGNORE`、`down()` 删除
- 键集精确断言从 21 更新为 22

### user-service

- 必填开 + 缺码 ⇒ `400/11006`、message `请填写邀请码`、不建用户、不调 `currency.apply`
- 必填开 + 空白串 ⇒ 同上（Transform 转 undefined）
- 必填关 / 快照缺失 ⇒ 缺码照常注册
- 必填开 + `inviteEnabled=false` ⇒ 缺码照常注册（AND 语义）
- 必填开 + 无效码 ⇒ `11006`、不建用户
- 必填开 + `agent.bind` 返回 `ignored` ⇒ 注册成功 + warn 日志

### currency-service

- `createMany`：数量、长度 8、字符域、唯一性
- 消费：`status=used`、`used_by`、`used_at` 正确
- 重复使用 ⇒ `11006 邀请码已被使用`
- 并发两注册同码 ⇒ 恰一人 `bound`，另一人 `11006`
- 绑定写失败 ⇒ 事务回滚，码仍 `active`
- 功能关闭（`settings.enabled=false` 或 `inviteEnabled=false`）⇒ `ignored` 且码不消费
- 冻结代理 ⇒ `11006` 且码不消费
- `rotate` ⇒ 全部 active 变 revoked + 新码 1 枚
- 日生成上限与非法 count

### 客户端

- boot 归一化两个标志；缺字段 ⇒ false
- 必填开：标签「邀请码（必填）」、空值拦截、不发请求
- 必填关：行为与今天一致（选填）
- 每次进入注册态都刷新 boot

### 管理后台 / 代理端

- `pnpm verify:admin`：新键在精确清单、三态控件存在
- `verify-agent-static`：列表/生成按钮锚点存在

### conformance slice-32

- 扩展 `enabled × required` 矩阵：必填开 + 缺码 ⇒ `400/11006` 且不建用户
- 一次性消费：同码第二次注册 ⇒ `400/11006`
- 并发同码（两请求）⇒ 恰一人成功
- 代理端批量生成 → 注册消费 → 列表状态变 `used`

## 6. 风险与残余

| 风险 | 等级 | 处置 |
|---|---|---|
| `agent_settings.enabled=false` 时必填无牙（任意非空码通过） | 高 | 后台固定提示；服务端 warn；上线清单要求两个开关同开 |
| signup grant 失败烧码 + 孤儿绑定 | 低 | 沿既有残余；日志/metric；管理员补发 |
| 配置快照不可用时允许无码注册 | 中 | D13 刻意 fail-open（可用性优先）；登记并接受 |
| 老客户端 boot 失败时无法注册 | 中 | 运营确认旧版占比后再开必填；重进注册态自动重试 |
| 日生成上限并发略超 | 低 | 生成前锁 agent 行；仍以常量兜底 |
| 码表增长（已使用码长期保留） | 低 | 单代理 200/日上限；后续可按需加归档 |
| 后台三态两次 PUT 非原子 | 低 | 写入顺序保证失败落在非必填侧 |
| 一次性码被前端重复点击生成 | 低 | 按钮 loading + 请求幂等性不做（重复生成只是多码） |

## 7. 涉及文件（预估）

**protocol**

- `packages/protocol/src/config.ts`
- `packages/protocol/src/config.test.ts`

**config-service**

- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/migrations/1798300000000-AgentInviteRequiredSeed.ts`
- `packages/config-service/test/client-config.test.ts`
- `packages/config-service/test/platform-config.service.test.ts`

**user-service**

- `packages/user-service/src/config/config-cache.service.ts`
- `packages/user-service/src/auth/auth.service.ts`
- `packages/user-service/src/users/users.dto.ts`
- `packages/user-service/test/auth.service.test.ts`
- `packages/user-service/test/config-cache.test.ts`（如存在）

**currency-service**

- `packages/currency-service/src/migrations/1798200000000-AgentInviteSingleUse.ts`
- `packages/currency-service/src/agent/agent-invite.service.ts`
- `packages/currency-service/src/agent/agent-bindings.service.ts`
- `packages/currency-service/src/agent/agent-portal.controller.ts`
- `packages/currency-service/src/agent/agent-portal.service.ts`
- `packages/currency-service/src/agent/agent-admin.controller.ts`
- `packages/currency-service/src/agent/agent-accounts.service.ts`
- `packages/currency-service/src/agent/agent.constants.ts`
- 对应 `test/agent-invite.test.ts`、`test/agent-bindings.test.ts`、`test/agent-bind.rpc.test.ts`、`test/agent-portal.test.ts`、`test/agent-admin.test.ts`、`test/agent-domain.migration.test.ts`

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
- `agent/app.js`
- `agent/index.html`
- `scripts/verify-agent-static.mjs`

**conformance**

- `tools/conformance/src/slices/slice-32-agent.ts`

## 8. 上线与回滚

上线顺序：

1. currency-service 迁移 + 一次性消费（当前无码，零行为变化）→ 验证绑定链路
2. config-service / user-service / 客户端 / 后台 / 代理端一起发（`required` 默认 `false`）
3. 开代理模块 `agent_settings.enabled` + `agent.inviteEnabled`，代理开始批量生成码
4. super_admin 打开 `agent.inviteRequired`
5. 观察注册成功率、`11006` 分类日志、未归属注册数

回滚：

- 关 `agent.inviteRequired` ⇒ 回到选填（入口保持原状）
- 关 `agent.inviteEnabled` ⇒ 隐藏入口，注册不再消费码
- 一次性语义不回退；已使用码不可恢复

## 9. 审查记录

（待设计对抗审查后填写：审查人、日期、阻断/高/低清单与处置）
