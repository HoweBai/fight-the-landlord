# 货币核心（P2 第一步）设计 v1.0

> **定位**：P2′ 变现链三步走的第一步（2026-10-03 用户裁决：「钱包 + 金币场 + 财务后台与角色权限」**三步依次做**）。
> 本片 = **货币核心**（钱包/账本/幂等/接口/对账自检），**玩家可见面为零（暗上线）**；②金币场、③财务后台+RBAC 各自独立立项，本片为其预埋接口与数据形状（见 §1.3）。
> **作者**：协调者（opus）；**状态**：v1.1（r1 评审零阻断；7🟡+6🟢+漏闸 8 处已全数处置——见文末修订记录）。开工前必读的路线图条目：`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P2′ 节 + 附录 §6 #21/#29/#34（`docs/appendix/platform-roadmap.md:319,327,332`）。

---

## §0 用户裁决记录（本设计不得与之冲突）

| # | 裁决 | 日期 |
|---|---|---|
| J1 | 范围 = 钱包 + 金币场 + 财务后台与角色权限，**拆三步依次做**：①货币核心 → ②金币场 → ③财务后台+RBAC+审计 | 2026-10-03 |
| J2 | 免费场保留、新增金币场；**两种场都可开关**（配置控制是否开放）——归 ② 落地 | 2026-10-03 |
| J3 | 金币场补机器人，**用虚拟币池**（附录 §3.7 规则）——归 ② 落地 | 2026-10-03 |
| J4 | 支付范围（未来支付片用）= **充值/退款/提现全含**；提现为资金出站、合规最重，办商户号时可按渠道能力收窄 | 2026-10-03 |
| J5 | 注册赠送 = **配置键，默认 0**；**注册那一刻取值，之后改只影响新注册用户**；支付上线前金币实际来源 = 充值（未上线）/ 管理员手动发放 | 2026-10-03 |
| J6 | 支付前「管理员手动发放」是真实运营路径 ⇒ **① 必须自带管理员发放/扣减的最小操作面**（现有管理页上加一块） | 2026-10-03（J5 的推论，已向用户确认） |

---

## §1 范围

### 1.1 本片做

1. **新服务 `currency-service`**（第 7 个 Nest 服务）：HTTP 3004 / RPC(TCP) 3104 / metrics 9004。
2. **数据模型**：`currency_accounts`（余额）+ `currency_ops`（幂等操作）+ `currency_flows`（流水）三表，落既有共享库 `fight_the_landlord`（user/config 同库先例）。
3. **幂等机制（附录 #29 的答案所在）**：所有余额变更必经 `currency.apply`，actionId 唯一 + 载荷指纹防「同 id 不同内容」；重试只允许**原样重发**（§5）。
4. **接口**：玩家查余额（REST）· 服务间变更/查询（RPC）· 管理员发放/扣减（REST + 管理页最小表单）· 手机号→userId 查询（管理员手动发放的可用性前置）。
5. **注册赠送**：配置中心第 11 键 `currency.signupGrant`（默认 0，注册时快照），注册链路见 §4.4。
6. **对账自检**：自调度循环（账实相符 + 余额缓存一致性），指标入监控；漂移响亮告警（日志 + 指标），自愈缓存。
7. **错误码**：14xxx 段启用两条（§8）。
8. **监控接入**：prometheus 第 14 个 job + 指标端口 9004（§7、§9）。
9. **conformance 新切片 `slice-17-currency`** + 对既有闸的同步更新（§9 清单，**一个不能漏**）。

### 1.2 明确不做（留下一片）

- **玩家可见面全部不做**：余额展示（大厅/牌桌/结算页）、金币场入口、`PlayerChip.vue`/`Seat.vue` 的「货币恒为 —」占位转正、战绩页金币列 —— 归 ②。
- **对局结算接线不做**：`game_record_players.money_delta` 仍恒 NULL（该列注释即写着「P2 货币账本落地后才写」）——归 ②。
- **机器人虚拟账户池不做**（规则在 ② 落地）；本片只预埋 `owner_type='robot'`（§3）。
- **支付/退款/提现不做**（需商户号，另立项）。
- **RBAC、财务后台全套、审计 actor 体系不做** —— 归 ③；本片只保留 `actor`/`reason` 字段与最小管理表单。
- **玩家流水明细页、对账报表页面不做** —— 归 ②/③。
- **流水表不清洗**：货币流水是财务记录，**永久保留**（与对局记录 365 天保留期相反，明确区分）。

### 1.3 为 ②/③ 预埋的扩展点（本片验证，②③ 直接消费）

| 预埋 | 形状 | ②/③ 用法 |
|---|---|---|
| `owner_type` 列 | `'user' \| 'robot'`，默认 `'user'` | ② 机器人虚拟账户 = `owner_type='robot'` 的普通账户 |
| `source` 取值表 | 协议层 allowlist：本片 `signup_grant` / `admin_adjust` | ② 扩 `game_settle` / `robot_pool`；支付片扩 `recharge` / `refund` / `withdraw` |
| `currency.apply` 批量原子语义 | 一次调用多账户同事务 | ② 结算 = 一局一条 actionId（`settle:<gameId>`）+ 三名玩家 entries |
| `currency.get` 批量读 | 1..50 个 ownerId | ② 匹配前查余额/结算后展示 |
| `actor` / `reason` 字段 | 记账在 op 级，本片固定 `actor='admin'` | ③ 扩角色名（finance/operator…）+ 审计视图。📌 **实交付（2026-10-05）= 用户名**（角色随行）——口径偏离与理由见 §12（G11） |
| 管理页「钱包调整」块 | `admin/app.js` 新 section | ③ 财务后台在此升级 |

---

## §2 形状与拓扑（D1–D4）

**D1｜新服务而非模块。** `packages/currency-service`（Nest），理由：钱的边界独立一屋；未来支付/退款/提现/对账/审计全落这里；参考架构（`docs/design.md:81` 所列 Currency/Payment/Audit）本就规划为独立服务；监控片已把「多一个服务」的成本收敛为清单式登记（§9）。**已否方案**：塞进 user-service —— 它已吞记录表，再吞钱包+支付=巨型服务，且与「资金数据单独一面」的审计直觉相悖。

**端口**：HTTP **3004** / RPC **3104** / metrics **9004**（三处均为既有序列空位，全仓无占用，已核查）。容器 `ftl-currency-service`，镜像 `${IMAGE_PREFIX:-pokergame}-currency-service`。

**D2｜存储 = MySQL 为准 + Redis 余额缓存。** 同库 `fight_the_landlord`（既有事实：user/config 共库；currency 表加 `currency_` 前缀避免撞名）。**Redis 只做读加速，永不参与写决策**：扣款够不够只由 MySQL 条件更新裁决（§5.3）。缓存写穿 + 读穿 + 对账修复（§7）。不做方案曾考虑「本片先不上 Redis」（YAGNI），**否决**：路线图明写「账本 MySQL + 余额 Redis」，且 ② 匹配快路径会立即用上，缓存一致性由对账自检闭环，成本可控。

**D3｜写路径唯一入口。** 一切余额变更（含注册赠送、管理调整、未来的结算/充值）都只经 `currency.apply`——**没有第二条写边**。这条纪律是幂等与对账可成立的前提（参考文档的 `deduct` 直连写法不复用）。

**D4｜注册赠送 = RPC 先行、金额为 0 时完全绕开货币服务。** 见 §4.4 时序；失败语义见 §11 残余风险。

---

## §3 数据模型（三表，DDL 草案）

字段类型遵循本仓惯例：金额 `int`、时间 `datetime(3)`、id `bigint AUTO_INCREMENT`（wire 一律 epoch ms；**本片金额不做 bigint**——单笔上限受 §5.4 校验约束，int 足够，回避 `platform-config.entity.ts` 那个 bigint-transformer 坑）。

```sql
-- 1) 账户：余额的物化行
CREATE TABLE IF NOT EXISTS `currency_accounts` (
  `owner_id`   varchar(36) NOT NULL,            -- user.id (uuid) / 未来 robotId
  `owner_type` varchar(8)  NOT NULL DEFAULT 'user',   -- 'user' | 'robot'
  `balance`    int         NOT NULL DEFAULT 0,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) 操作（幂等锚）：一次 apply = 一行
CREATE TABLE IF NOT EXISTS `currency_ops` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `action_id`    varchar(128) NOT NULL,         -- 调用方提供，幂等锚
  `request_hash` char(64)     NOT NULL,         -- 规范化载荷 sha256（§5.2）
  `source`       varchar(32)  NOT NULL,         -- allowlist（§1.3）
  `actor`        varchar(64)  NULL,             -- admin_adjust 必填（本片固定 'admin'）
  `reason`       varchar(255) NULL,             -- admin_adjust 必填
  `ref_id`       varchar(128) NULL,             -- 业务关联（对局 ID 等）
  `trace_id`     varchar(64)  NULL,
  `created_at`   datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_action_id` (`action_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) 流水（永不清洗；只增不改）
CREATE TABLE IF NOT EXISTS `currency_flows` (
  `id`            bigint      NOT NULL AUTO_INCREMENT,
  `op_id`         bigint      NOT NULL,
  `owner_id`      varchar(36) NOT NULL,
  `owner_type`    varchar(8)  NOT NULL DEFAULT 'user',
  `delta`         int         NOT NULL,          -- 正=入 负=出
  `balance_after` int         NOT NULL,          -- 该笔之后的余额快照
  `created_at`    datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_flow_owner` (`owner_id`, `id`),
  KEY `idx_flow_op` (`op_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

约定与说明：

- **两表拆开（ops/flows）而非一张流水表**：一次批量 apply（② 结算=3 条 entries）= 一个 actionId、多行流水，需同事务原子；重放时按 `op_id` 重建响应（`flow.balance_after` 即结果，无需 result JSON 列）。
- **写入者自动建账户**：首次写入某 ownerId 时 INSERT（balance 0）再改；**读路径不建行**（未开户用户查余额 = 0，不产垃圾行）。
- **现有用户无迁移、不补发**：升级不建任何钱包行；注册赠送只对「配置生效后注册的人」（J5）。
- **流水永久保留**；容量估算：单行 <150B，按日活千局 ×3 人 ×N 笔 ≈ 每天十万行级上限，十年亦在 MySQL 舒适区（设计期实估见 ② 前复核项，§11）。
- `owner_id` 校验：长度 ≤36、字符集 `[A-Za-z0-9_-]`（② 机器人 id 需满足，立项时对表）。

---

## §4 接口

### 4.1 玩家 REST（经网关，JWT 身份头 `X-User-Id` 由网关注入——照抄 `GET /api/records/mine` 模式）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/wallet/balance` | → `{ code:0, data:{ balance:int } }`。userId 只取 `X-User-Id`（禁止任何「查谁」参数）。 |
| GET | `/api/health`、`/api/health/live` | 服务健康（内部 token 豁免面既有形状）。 |

### 4.2 管理 REST（经网关 admin 中间件，`X-Admin: 1` 由网关注入；下游照抄 config-service 的 `XAdminGuard` 小守卫）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/wallet/adjust` | body `{ userId, delta, reason, actionId? }`：delta≠0 且 \|delta\|≤1,000,000；reason 1..200 必填；`actionId` 缺省时服务端生成 `admin:<uuid>`（管理页每次填表生成一个、重试复用——双击保护）。→ `{ balanceBefore, balanceAfter, opId }`。**不允许扣成负数**（管理员也不行；强扣需求 ③ 再裁）。 |
| GET | `/api/admin/wallet/accounts/:userId` | → `{ balance, recentFlows:[{delta,balanceAfter,source,reason,createdAt}×20] }`（发放后当场核对用——**读源=MySQL 直读**，绕过缓存避免写穿窗口旧值；完整财务视图归 ③）。 |
| GET | `/api/admin/users/lookup?phone=` | **在 user-service**（非 currency）：手机号→`{ userId }`；手动发放的可用性前置（运营按手机号操作，不背 uuid）。 |

### 4.3 服务间 RPC（`packages/protocol/src/rpc.ts` 新增两条；信封/`metaFromTrace`/超时纪律照抄 `record.write` 先例）

**`currency.apply`**（唯一写边）：

```
请求: { actionId, source, entries: [{ ownerId, ownerType?, delta }], actor?, reason?, refId? }  + RpcMeta
响应: RpcResult<{ opId, actionId, entries: [{ ownerId, balanceAfter }], replayed: boolean }>
```

- `entries` 1..20 条；**同一 ownerId 不得重复**（结算每人一条）；服务端按 ownerId 排序执行（防死锁）。
- 业务错误走信封 `{ ok:false, code, message }`（不抛；传输故障才抛 + 调用方映射 10007）——`record.rpc.controller.ts` 先例。
- **整批原子**：任一 entry 余额不足 ⇒ 全批回滚（14001），不做部分成功。
- 重放：同 actionId + 同 hash ⇒ 返回原结果（`replayed:true`，从 flows 重建）；同 actionId + 异 hash ⇒ 14002。

**`currency.get`**（读）：`{ ownerIds: string[1..50] }` → `{ balances: [{ ownerId, balance, exists }] }`（缓存优先、miss 回源；不建行）。

### 4.4 注册赠送链路（J5 的落地；**金额为 0 时一步都不进货币服务**）

```
register(phone, pwd):
  1. userId = uuid（既有生成点）; 校验/重复预检（既有逻辑）
  2. grant = configCache.signupGrant()        # user-service 已有配置缓存（记录片先例）；缺失/坏值 → 0
  3. if grant > 0:
       currency.apply{ actionId:'signup:<userId>', source:'signup_grant',
                       entries:[{ownerId:userId, delta:grant}], refId:userId }
       — 3s 超时；任何失败 ⇒ 注册整体失败（500），本地未落任何行，重试干净
  4. tx: 写入 users 行（既有事务）
```

- **顺序 = 先货币后落库**：注册失败可从客户端重试；半程失败只会遗留「孤儿钱包」（§11 登记的已知残余，有指标可观测）。
- 重试幂等：`signup:<userId>` 恒定 ⇒ 同一次注册的任何重发不重复发币。
- **快照语义**：金额在步骤 2 读取一次并随调用固化；此后改配置不影响已注册用户（J5 原文）。

### 4.5 网关登记

- 路由：`wallet/*` → `forwardToCurrencySvc`；`admin/wallet/*` → currency；`admin/users/*` → user（既有 `/api/admin/*` 走 admin 中间件，`admin.middleware.ts` 注入 `x-admin`）。
- 新 env `CURRENCY_SERVICE_URL` → 同步 `docs/design.md` §2.3 env 表 + `design-md-ai-rollout.gate.test.ts` 的 NEW_ENVS。

### 4.6 管理页最小表单（`admin/app.js` 新 section「钱包调整」）

手机号 → 查 userId（4.2 第三行）→ 显示当前余额 → 填 ±金额 + 原因 → 提交（actionId 每次填表生成并复用至成功）→ 显示调整后余额。样式随既有页面（无构建静态页，门口镜像 `COPY admin`）。**③ 在此升级为财务后台，不推倒。**

---

## §5 幂等与并发（#29 的答案）

### 5.1 actionId 规范（调用方纪律，写入协议注释）

| 调用方 | actionId 形状 | 语义 |
|---|---|---|
| 注册赠送 | `signup:<userId>` | 每用户至多一次赠送 |
| 管理调整 | `admin:<uuid>`（页面生成，重试复用） | 一次点击一次调整 |
| ② 对局结算 | `settle:<gameId>` | 每局至多结算一次（重试安全） |
| 未来支付/退款 | `pay:<orderId>` / `refund:<orderId>` | 每单一次 |

**长度 ≤128、全局唯一由 `uk_action_id` 兜底**；服务端不做格式白名单（调用方多样），但要求非空、≤128。

### 5.2 重放判定

`request_hash = sha256(规范化 JSON{source, entries(按 ownerId 排序，每条含 ownerId/ownerType 归一化值/delta), actor, reason, refId})`——ownerType 缺省归一为 `'user'` 后**参与指纹**（防「同 id 悄悄换 ownerType」不被发现）。命中 `uk_action_id` 时：hash 相同 ⇒ 返回原结果；不同 ⇒ **14002**（拒绝并响亮报错——「同 id 不同内容」永远是人祸，不能静默）。

**重放读取口径**：撞唯一键的写事务**整体回滚**，然后在**新事务**里读 `ops`（比对 hash）并按 `op_id` 重建 flows 响应——不复用原事务的连接/快照（REPEATABLE READ 下原事务可能读不到并发已提交的那行）。并发撞键的锁等待窗口由调用方 3s 超时纪律兜底。

### 5.3 并发与防负（条件更新裁决，不用应用层读改写）

单账户写序（每 entry 在批量事务内执行）：

1. `UPDATE currency_accounts SET balance = balance + :delta WHERE owner_id = :id AND balance + :delta >= 0` → `affectedRows=1` ⇒ 成功；
2. `affectedRows=0` ⇒ `INSERT IGNORE INTO currency_accounts(owner_id, balance) VALUES(:id, 0)`（**消化「行不存在」与「并发首建」二义**：行已存在则天然无操作）→ 重试步骤 1 **一次**；
3. 步骤 1 二次仍 0 ⇒ 行必已存在且余额不足 ⇒ **14001**（整批回滚）。

- `balance_after` 取值：UPDATE 成功后**同事务内** `SELECT balance WHERE owner_id=:id`（读自身未提交写值，无并发窗口）。
- **任何并发交错都不可能扣成负数**（SQL 条件保证）；批量按 ownerId 排序 + 单事务 ⇒ 死锁面收敛。
- 读路径（REST/RPC get）：Redis 命中直接回；miss 回源 MySQL 并写缓存。**读永远不裁决钱**（裁决只在上面三步）。

### 5.4 入参校验（写入口一处收口）

source ∈ allowlist；delta ≠ 0 且 |delta| ≤ 1,000,000；entries 1..20 且 ownerId 不重复；`admin_adjust` ⇒ actor/reason 必填；**ownerType 与既有账户行不一致 ⇒ BAD_PARAM(10001) 拒绝 + 响亮日志**（owner_type 首次写入即**不可变**；账户不存在时按传入值建、缺省 `'user'`）；校验失败 = BAD_PARAM(10001) 既有面。**校验函数唯一真源在 `packages/protocol`**（货币契约面新文件 `currency.ts`：source allowlist、字段上限、hash 规范化算法——服务端与调用方共用，禁双份实现）。

### 5.5 重试纪律（响应附录 #29 与 §4.3 重试表）

- **仓库现状：无自动重试机制**（`record.write` 3s 超时、不重试）。货币边同样**不引入自动重试**；未来任何重试（调用方侧）**只允许原样重发同一 actionId**；「换新 id 重试」= 重复扣费，列为评审红线。

---

## §6 配置（第 11 键）

| 键 | 类型/范围 | 默认 | 客户端可见 | 消费方 |
|---|---|---|---|---|
| `currency.signupGrant` | int 0..1,000,000 | 0 | **否**（服务端专用） | user-service 配置缓存（新 getter，缺失/坏值回落 0） |

同步面（清单见 §9）：`protocol/src/config.ts`（CONFIG_KEYS + parse 校验）+ config-service 种子迁移（照抄 `1789500000000-RecordRetention.ts`）+ `config.test.ts` 十键→十一键 + **config-service 测试族三处十键字面量**（`test/platform-config.service.test.ts:224-225`、`test/helpers/config-probe.ts:95`、`test/admin.controller.test.ts:172-186`——不随改必红）+ `admin/app.js` CONFIG_NOTES + `docs/ops/first-deploy.md` 十键表→十一键表 + `docs/design.md` §7.5。**② 的场开关（免费场/金币场）是第 12/13 键，留 ② 立项**。

---

## §7 对账自检与可观测

**自调度循环**（照抄 `records-cleanup.service.ts` 的 setTimeout 链 + 关停闸形状；间隔 env 覆盖 `CURRENCY_RECONCILE_INTERVAL_MS`，默认 3600000；启动后 10s 先跑一轮）：

1. **账实相符**：**单条 SQL** 同时取 `balance` 与 `SUM(delta)`（LEFT JOIN 子查询）比对——不拆两条查询（分读会与并发 apply 交错造成**假漂移**；单语句在 InnoDB 下自有一致快照）。不等 → 日志 `level=error`（含 ownerId/两值/差）+ 指标 `currency_reconcile_drift_accounts`（gauge）。**不自修**（钱的事只报不改，人工裁决）。
2. **缓存一致性**：Redis 与 MySQL 余额不一致 → **自愈**（删缓存键，下读回源）+ 指标 `currency_reconcile_cache_drift_total`（counter）。**写穿失败**（apply 已提交但 SET 缓存失败）⇒ 仅 `level=warn` 日志 + 同 counter 计次（best-effort；权威值永远在 MySQL 与调整响应里，窗口由本轮自愈收口）。
3. **孤儿赠送（诊断项，只读）**：`source='signup_grant'` 的 flows 中 owner 不在 `users` 表的计数 → 指标 `currency_orphan_signup_grants`。同库只读、仅诊断；若评审认为越界可裁掉（§11）。

**指标面**（用 shared `metricsRegistry()` 构造函数，命名随既有风格）：`currency_apply_total{source,result}`、`currency_apply_entries_total`、`currency_reconcile_runs_total`、`currency_reconcile_last_success_timestamp_seconds` + 上述 3 条。HTTP 中间件 `createHttpMetricsMiddleware()` 照挂。

**告警规则本片不加**（metrics 就位；规则待 ② 真实资金流动时同批加——届时注意监控片资产计数，§9）。日志事件：apply 成功/重放/拒绝、reconcile 漂移、孤儿计数>0 —— 九字段 NDJSON 既有形状，traceId 随 meta。

---

## §8 错误码（14xxx 启用两条）

| 码 | 名 | 含义 | HTTP | CLIENT_ACTION |
|---|---|---|---|---|
| 14001 | E_INSUFFICIENT_FUNDS | 余额不足（整批回滚） | 409 | **映射既有 `TOAST`**（提示「金币不足」，文案走 `message`；② 消费） |
| 14002 | E_ACTION_CONFLICT | actionId 冲突（同 id 不同载荷） | 409 | **映射既有 `TOAST`**（提示操作冲突/重试） |

同步面（§9）：`errors.ts` 枚举 + CLIENT_ACTION 映射 + `errors.test.ts` SPEC_CODES + `docs/design.md` §11.2 表（注释明写「两侧必须同改」）+ **currency-service 的 `http/errors.ts` HTTP_STATUS 表补 14001/14002→409**（每服务各一份、`?? 500` 兜底——不补则 409 静默变 500）+ 一条盯映射表的单测。

---

## §9 对既有判据与资产的冲击清单（实施时**逐条**核销；漏一条 = push 必红或静默失明）

> 来源：2026-10-03 子代理全仓调查（各条已给锚点）。**凡「恰好 N」的断言，改数字必须同提交改断言本体**——本仓已有「注释改动命中按原文扫描的闸」的前科（监控片 B1）。

### 9.1 硬闸（不改必红）

| # | 资产 | 现状 | 变更 |
|---|---|---|---|
| 1 | `tools/conformance/src/slices/slice-07.2-deploy.ts:564,571` | compose 带 `build:` 的服务**恰好 12** | → 13（+currency-service 块） |
| 2 | 同上 `:131` `TOKEN_SERVICES`（9 个） | 每个含 `INTERNAL_SERVICE_TOKEN` 渲染断言 | +currency-service |
| 3 | `slice-16-monitoring.ts:81` `EXPECTED_JOBS` | prometheus job **恰 13**（逐名） | → 14（+currency job） |
| 4 | 同上 `:96-102` `NEST_TARGETS` | 六个 Nest 指标端口逐名 | +`currency:9004` |
| 5 | 同上 `:113`、`:1175-1178` `EXPECTED_SERVICES` | `conformance-stack.sh` SERVICES **恰 12** | → 13（脚本 `:22` 数组同改；否则 retag 环漏镜像） |
| 6 | `deploy/monitoring/prometheus/prometheus.yml:4,16-41` | 头注释「13 个 job」+ 列表 | 注释→14 + +1 job（Bearer `INTERNAL_SERVICE_TOKEN` 同形） |
| 7 | `packages/protocol/src/config.test.ts:10-18` | 十键硬编码 + 三键子集 | → 十一键（子集不变） |
| 8 | `packages/protocol/src/errors.test.ts:8-14` `SPEC_CODES` | 与 design.md §11.2 逐码对账 | +14001/14002 |
| 9 | `packages/protocol/src/messages.test.ts:45-60` | 10 条 RPC pattern 名逐字钉 | +`currency.apply`/`currency.get` |
| 10 | `robot-availability-wiring.gate.test.ts:205-223` | `RPC_PATTERNS` 键集 = 全仓 `@MessagePattern` 键集；接收类必须模块注册 | currency 接收控制器 + 模块注册（**同提交**） |
| 11 | `meta-on-every-rpc-send.gate.test.ts`（`PACKAGES:58-66`） | 每处 `.send(` 带 `metaFromTrace()`（按包扫） | user→currency 新发送边；核销新客户端文件在扫描面内（不在 ⇒ 扩 PACKAGES） |
| 12 | `no-internal-http.gate.test.ts:89,100-119` | 扫描面 = **room/game 客户端文件**（user-service 不在其中；清单字面名叫 ROOM_CALL_SITES） | 把 user-service 货币客户端文件**扩入扫描面**并登记探针正负两行；**勿**往 room 清单塞 user 文件（零判别力） |
| 13 | `no-raw-console.test.ts:22-30,70-71` | ALLOWED 白名单 + 扫描包清单 | +currency `main.ts`；**两处都加**（只加一处 = 静默失明） |
| 14 | `dockerfile-workspace-copy.gate.test.ts:153-187` + `dockerfile-patches-copy.gate.test.ts` | Dockerfile COPY 与 workspace 依赖/补丁面逐行对账 | 新 `Dockerfile.currency-service`（照抄 config-service 模板；**patches 拷贝面逐行核对**） |
| 15 | `service-name.gate.test.ts` | 服务名短名 vs package.json 逐字 | `@fight-the-landlord/currency-service`；**顺带钉正陈旧 5 服务名单**（config-service 缺席，闸失明） |
| 15b | 新包脚手架 | 无（新目录） | 照抄 `packages/config-service` 模板：package.json（`name` 短名/scripts build·test·lint·dev·migration:*）、`tsconfig.json` extends 根、`vitest.config.ts`、`turbo.json` 任务面自动覆盖（workspace glob 免改） |
| 16 | `design-md-ai-rollout.gate.test.ts:84-90` NEW_ENVS | design.md §2.3 env 表对账 | +`CURRENCY_SERVICE_URL`（design.md 同改） |
| 17 | conformance 登记 | `tools/conformance/src/run.ts:41-66` CASES + `baselines.json` | +`slice-17-currency`（基线 CI 首跑后回填） |
| 18 | `api-gateway/test/container-assembly.gate.test.ts:36-72` | 5 服务清单守「健康路由 ⊆ 免鉴权清单」等不变式（config-service 已缺席=闸失明） | +currency-service；**顺带补 config-service** |
| 19 | `api-gateway/test/outbound-timeout.gate.test.ts`（PKGS:9） | 出站客户端必须带超时的扫描面 | user-service 新货币客户端（`timeout(3000)`）；currency-service 入 PKGS 清单 |
| 20 | `tools/conformance/src/slices/slice-07.2-hardening.ts:966` | RPC/端口硬化断言面 | 核销时看齐（新端口 3104/9004 入列） |
| 21 | `slice-07.2-deploy.ts:151-155,908-915` + `slice-07.2-rpc.ts:952-959` | RPC_PORTS 表 + 开发形态按表发布端口 | +currency（3104）；override 同改 |
| 22 | `docker-compose.override.yml:45,49,97`（先例） | 开发形态 RPC 宿主直连端口 | 加 `"3104:3104"`（§10 的 RPC 直连判据依赖它） |
| 23 | `packages/user-service/src/config/config.client.ts:58-59`（命名先例） | RPC host/port env 命名 | `CURRENCY_SERVICE_RPC_HOST/PORT`（连同 §4.5 的 HTTP URL） |

### 9.2 计数/文案（人工同步，防文档谎报）

- `scripts/deploy/build-images.sh:2,32` 注释「12 个自建镜像」→13；`conformance.yml:4` 注释同。
- `docker-compose.yml:8-15` 头注释容器数（9/10/15/16）→ 全 +1。
- `docs/ops/first-deploy.md:123`（16 容器/12 镜像）、`:380`、`:857` → 17 容器/13 镜像。
- `docs/design.md:159-161`（「9/10 个容器」「8 个自建镜像」已陈旧）→ 借本片订正为真实值；`:1077`、`:1702`、`:1835`、`:1844` 涉及服务数的行同核。
- `docs/design.md:81`「货币系统、充值、提现、对账（原 Currency/Payment/Audit Service）」在 §1.3「明确不做」清单里——本片起**翻转**：对该行加 📌 注记（照抄 `:85` 监控片注记的形状：「货币核心已落地（2026-10-0X）……充值/提现见 P2 后续」），实施时随该片提交。
- 监控片规格/设计的「六 Nest / 13 job」历史文本 → 以 **⚙️ 回填注记**方式订正（不重写历史）。
- release 预算：`images` workflow 首建 13 镜像（时间 +1 镜像，量级无虞；release job 预算注释同核）。
- **切片计数与步骤名**：`docs/ops/first-deploy.md:744,754,790`「21 个切片」→22；`conformance.yml:32`、`scripts/deploy/conformance-stack.sh:60`、`images.yml:31`、`release.yml:43,82` 步骤名内嵌的镜像/切片数同核。
- `docs/design.md:1439`「14xxx 货币（MVP 不用，保留）」→ 订正为「本片启用 14001/14002」。
- `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md:77`「RBAC+财务后台+审计 actor 与本片同做」与 J1 三步拆分冲突 → 加回填注记（照 design.md 订正先例）。
- `packages/shared/src/metrics/metrics-listener.ts:10` 注释「五份」已过时 → 随 currency 接入钉正为七份。

### 9.3 user-service 侧（新出站 RPC 边 = 结构变化）

- `config-cache.module.ts:12` 注释明写「本服务**只有这一条出站 RPC 边**（config.snapshot）」——本片后变**两条**，注释与 `rpc-clients` 装配同改（ClientsModule 第二条 proxy + 包装类，照抄 room 侧模式）。
- 注册链路改造点：`users.controller.ts:16` → AuthService.register 内接入 §4.4；`app.module.ts` 注册面照注（**T6 教训：未注册 = 单测全绿而真容器 404**）。
- **管理员手机号查询三件**（无既有闸拦，逐件核销）：user-service 控制器（`GET /api/admin/users/lookup` + `XAdminGuard` 复制）+ 网关路由（**注意现 `admin/*` 整段转 config-service，需加显式分支**）+ 管理页调用。
- **currency-service main.ts 骨架核销**：fail-closed `INTERNAL_SERVICE_TOKEN` 检查、`createRedactingLogger`（service 短名=package name 末段，机械闸盯）、中间件顺序 trace→metrics→internal-token、`internal-token.middleware.ts` 新拷贝；**`di-type-import-trap` 点名**——要注入的类型必须值导入（`import type` 让容器启动即崩，单测与 tsc 都看不见）。

---

## §10 测试与验收

**单元（currency-service）**：apply 正常入账/扣账；同 actionId 重放返回原结果且不重复入账；同 id 异 hash ⇒14002；余额不足整批回滚；**并发扣减压力下无负余额**（并行 N 扣减，终止余额 = 初值−成功笔数）；批量多账户原子性；入参校验矩阵（source/delta/重复 ownerId/上限）；reconcile 三项（构造漂移）；main 骨架/守卫。**user-service**：signupGrant getter（缺省/坏值回 0）；注册链路（grant=0 不触发 RPC；grant>0 成功/失败两径）；孤儿指标查询。**protocol**：currency 契约函数（hash 规范化排序不变性——乱序 entries 同 hash）。

**conformance `slice-17-currency`（轮廓，规格/计划细化）**：服务/指标目标 up（prometheus 14/14）；管理调整→余额与流水落库（actor/reason 留痕）；同 actionId 重发（RPC 直连）只落一行；余额不足 14001 且余额不变；经网关玩家查余额（新用户=0）；对账指标绿。**baselines 静态回填 + CI 首跑即验**（静态切片免首跑红仪式）。

**验收条目（设计级）**：A1 服务与指标（14/14 up）；A2 玩家 REST 余额；A3 管理调整端到端（含管理页表单）；A4 幂等重放；A5 冲突拒绝；A6 防负（含并发）；A7 批量原子；A8 对账自检双向（制造漂移→报/自愈）；A9 注册赠送两态（0 绕开 / 非 0 入账 + 幂等）；A10 §9 清单逐条核销；A11 全序 conformance（22 片）+ CI 三绿。

**复核三问（每任务交付时自问）**：跑得起来吗 / 有可能失败吗 / 拦得住最像正确答案的那个错吗。

---

## §11 残余风险与待审低置信项（评审重点）

| # | 项 | 现状判断 |
|---|---|---|
| R1 | **孤儿钱包**：注册「先货币后落库」+ grant>0 时，落库失败（手机号竞态）残留带币孤儿账户 | 概率低、金额=赠额、有 `currency_orphan_signup_grants` 指标可观测；不做自动回收（① 收益不抵复杂度）。**留 ③ 财务后台做清理工具** |
| R2 | 注册链路可用性耦合：grant>0 时货币服务不可用 ⇒ 注册失败 | **有意为之**（钱的事宁可响亮失败；且默认 grant=0 时该耦合不存在）。评审若认为须解耦，方案 = outbox（成本：新表+投递循环），请显式裁决 |
| R3 | 孤儿诊断的跨表读（currency 读 users） | 同库只读、仅诊断；若判越界 → 裁掉该项（不换方案） |
| R4 | `owner_type='robot'` 预埋未经 ② 需求验证 | ② 立项时复核（机器人 id 形态是否 ≤36、是否需独立池账户语义） |
| R5 | reconcile 全表 GROUP BY 规模上限 | 现量级无虞；>百万行时改增量对账（登记，不预做） |
| R6 | 管理调整的「重放保护」依赖页面 actionId 复用 | 服务端兜底生成 uuid 时，同一次请求的传输重试会生成新 id（无自动重试机制 ⇒ 实际不可达）；录入错误靠流水可查、③ 可做冲正 |
| R7 | 提现所需的「可提/赠币」余额分类 | **本片不做**（J4 支付片时再裁）；流水按 source 分类已保留回溯能力 |
| R8 | 监控告警规则未加（仅指标） | ② 资金流动真实发生前补；届时注意 §9 计数 |

---

## §12 ②/③ 接手须知（接口契约面，已冻结）

- ② 结算写账：`currency.apply{ actionId:'settle:<gameId>', source:'game_settle', refId:gameId, entries:[三人各一条] }`——**一次调用整局原子**；`money_delta` 回写记录表在本片之后做（② 内）。
- ② 机器人池：`owner_type:'robot'` 账户 + `source:'robot_pool'`（allowlist 扩容 = 协议单点改）。**⚠️ 准入阻碍项（T3 审查 ⚙️14，2026-10-03 增）**：机器人与真人**异型** ownerType 共存前，类型闸必须保持**锁定读**形态（规格 ⚙️14 订正形态：快照步锁定读 + owner_type 断言 + `affectedRows===1`）并**过真库双会话负向用例**；不得回退为普通 SELECT 重查（REPEATABLE READ 下读不到并发已提交行，T3 审查已用 dev MySQL 双会话实证）。
- ② 场开关：配置第 12/13 键；**本片不加**。
- ③ 角色/审计：`ops.actor` 从固定 `'admin'` 扩为角色名；财务视图读 `currency_ops/flows`（只读，不做第二账）。
  - 📌 **回填注记（2026-10-05，第 ③ 步「财务后台 + RBAC + 审计」片）**：**已交付**——`ops.actor` 不再是固定 `'admin'`，由网关注入的**登录管理员**写入；财务视图在管理页落地（流水 / 汇总 / 详情 / 对账 + CSV 五个面，读源就是 `currency_ops`/`currency_flows`，**未建第二账**）；同片交付四角色 RBAC（`super_admin`/`finance`/`operator`/`viewer`）+ 审计四源（配置变更 / 登录事件 / 账号变更 / 钱包流水），冲正 = 反向整笔（`admin_reverse`，`14001`/`14002` 启用）。
  - ⚠️ **口径偏离（G11，显式登记）**：本条冻结文本写「扩为**角色名**（finance/operator…）」——**实为用户名**（如 `admin` / `zhang.san`，角色随手可查：登录事件与账号表都有）。理由：审计回答的是「**谁**改的」而不是「哪类人改的」——同角色多人时用户名才分得清责任；`actor` 列 `varchar(64)` 对两者都放得下（用户名按规则 ≤32）⇒ 零迁移代价。
- **支付片前置**（J4 记录）：商户号（用户侧，实名主体）+ 附录 #21（支付 Nonce 的 TTL/key 格式）在支付设计里给答案；本片不涉。

---

## 附录 A 与参考文档的差异（防误读）

- 参考文档 Currency Service 用 Redis 前缀 `currency:{userId}`、`deduct` 直改余额——**本仓不复用**：写路径唯一入口 `currency.apply` + MySQL 条件更新裁决（§5.3）。Redis 只是缓存（D2）。
- 虚拟经济 `virtual_account_{robotId}` 前缀规则（附录 §3.7）在 ② 落地为 `owner_type='robot'` 账户（语义等价、实现同仓）；初始 10000/补币/封顶数值 ② 设计时复核。
- 单边记账 + source 分类（非复式）：对账自检的「账实相符」按账户级 SUM(delta) 闭合；总量视图（按 source 汇总）由 ③ 报表消费，不建系统账户实体。

---

## 修订记录

- **v1.0**（2026-10-03，`8d4a8c2`）：初稿。
- **v1.1**（2026-10-03）：r1 设计评审（零阻断；7🟡 + 6🟢 + 锚点核验 32/32、漏闸 8 处）**全数处置**——§5.2 重放读口径（新事务）/§5.3 判定算法（UPDATE→INSERT IGNORE→一次重试）/ownerType 规则与指纹、§7 单语句对账 + 写穿失败语义、§4.2 管理核对读源、§8 HTTP_STATUS 表、§9.1 新增 #18–#23 并订正 #11/#12/#14，§9.2/§9.3 补列全部漏项。评审报告：`.superpowers/sdd/2026-10-03-currency/review-design-r1.md`。
- **v1.1.1**（2026-10-03）：§8 CLIENT_ACTION 列订正——`ClientAction` 枚举（`errors.ts:56-67`，TOAST 在 :64）是**行为值**（ignore/toast/back_to_lobby…）而非错误语义，14001/14002 应**映射既有 `TOAST`**、不新增枚举值；依据 = 规格起草期对照源码核对。
- **v1.1.2**（2026-10-03）：§12 增 **② 准入阻碍项**（⚙️14：类型闸锁定读形态 + 真库双会话负向用例；不得回退普通 SELECT 重查）——来源 = T3 审查 🟡-1（dev MySQL 双会话实证 + 假 DB 遮蔽点登记）。
