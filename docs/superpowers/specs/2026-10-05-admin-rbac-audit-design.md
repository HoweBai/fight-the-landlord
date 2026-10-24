# 财务后台 + RBAC + 审计（P2 第三步）设计 v1.1.1

> **定位**：P2′ 变现链三步走的第③步（J1：① 货币核心 → ② 金币场 → ③ **财务后台 + RBAC + 审计**；①② 已于 2026-10-04 上线 `v1.5.0`）。本片 = **管理面升级**：多账号 + 四角色 RBAC · **财务后台**（看钱）· **审计**（看人）· 并入路线图 M0.4「配置变更历史」一次做掉。**玩家可见面为零**。
> **作者**：协调者（opus）；**状态**：v1.1.1（r1 零阻断全处置 → r2 **可通过**；N1–N4 文字订正已落）。**设计冻结，供规格消费**。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-design-r{1,2}.md`。开工前必读：货币设计 §1.3/§12（`docs/superpowers/specs/2026-10-03-currency-design.md:46,347`）· 路线图 P2′ 节与 M0.4（`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md:30,70`）· 附录 §3.5（`docs/appendix/platform-roadmap.md:163`）· 现况侦察笔记（`.superpowers/sdd/2026-10-05-admin-rbac-audit/recon-notes.md`）。
> **用户裁决（2026-10-05，本设计不得与之冲突）**：
>
> | # | 裁决 | 推导 |
> |---|---|---|
> | K1 | 管理员账号在**管理页上全量管理**（建号 / 改角色 / 停用 / 重置密码） | 问题 1 选「管理页上直接管」 |
> | K2 | **冲正做** —— 一键反向修正（R6 的答案） | 问题 2 选「做」 |
> | K3 | 财务后台**全套**：流水浏览 · 用户查询 · 收支汇总 · 池水位 · 对账面板 | 问题 3 选「全套」 |
> | K4 | **登录事件审计做**（成功 + 失败都记、可查） | 问题 4 勾选 |
> | K5 | **CSV 导出做** | 问题 4 勾选（设计顺势统一到各列表面） |

---

## §1 范围

### 1.1 本片做

1. **RBAC**：新表 `admin_accounts`（用户名 + scrypt 口令 + 四角色 + 启用/停用）；登录从「单口令」改版为「用户名 + 口令」；管理令牌首次携带**身份与角色**；授权在网关**单点**执行（§2 D2）。
2. **账号管理**：管理页新「账号」视图（仅超管）——建号 / 改角色 / 停用 / 重置密码；服务端锁死自锁与并发退化（§5.4）。
3. **财务后台**：管理页新「财务」视图 + `currency-service` 新只读端点 —— 流水浏览（筛选/翻页/操作详情）· 用户余额与流水查询 · 收支汇总（按来源 / 按日）· 机器人池水位 · 对账面板（最近结果 + 手动跑一次）。
4. **冲正**：`POST /api/admin/wallet/reverse` —— 对一笔 `admin_adjust` 一键反向记账（`source='admin_reverse'`，唯一锚防重复，审计留痕）。
5. **审计（四源，直读不建第二账）**：`currency_ops`（钱）· 新表 `config_changes`（旧值→新值+改动人，M0.4）· 新表 `admin_login_events`（成功/失败+IP）· 新表 `admin_account_changes`（账号写面：建号/改角色/停用启用/重置口令——**恰是管理面里最需要事后回溯的写面**）；管理页新「审计」视图四页签。
6. **CSV 导出**：流水 / 汇总 / 配置变更 / 登录事件 / 账号变更五个列表面可导出（§4.6 契约）。
7. **上线迁移**：`ADMIN_PASSWORD` 语义从「唯一口令」改为「**首启引导**」；提供忘记口令的服务器复位命令（§5.2）。
8. **conformance 新切片 `slice-19-admin-rbac-audit`** + 对既有闸的同步更新（§9 清单，一个不能漏）；管理页 UI（登录加用户名、新三视图、角色导航可见性）。

### 1.2 明确不做（留待各自立项）

- **充值 / 退款 / 提现**（支付片，J4；本片不为它预铺 UI）。
- **风控 / 封禁 / 申诉 / 按 userId 的管理动作**（风控片）。
- **对局记录的查询面**（记录不设管理端点；财务侧靠 `ref_id` 关联足够）。
- **细粒度自定义权限**：只有四角色固定矩阵，无逐端点授权编排。
- **Refresh 令牌 / 令牌吊销名单 / 会话管理页**（停用与改角色的生效窗口 ≤2h，登记 §11 R1）。
- **审批流 / 双人复核**（四源审计使一切写面可回溯；现规模单人，不做流程约束）。
- **管理面新指标 / 告警**（沿用日志与既有规则；不加 Prometheus 规则）。
- **对账历史存储**（面板只显示最近一次 + 手动触发；趋势看 Grafana 既有指标）。
- **玩家面一切改动**；**17 键机制**与客户端协议不动；**mp 代码**不动。

### 1.3 与既有资产的接触面（本片只扩展，不搬家）

| 既有资产 | 本片动作 |
|---|---|
| `currency_ops`（`actor`/`reason` 列已就位） | `actor` 从固定 `'admin'` 改由网关注入的操作者名写入；**表结构零改动**。⚠️ 口径与货币设计 §12 冻结文本（「扩为**角色名**」）**有意偏离**：改为**用户名**（信息量更大，角色随行显示）——§9.2 回填注记里显式写明（G11） |
| `currency_flows`（永久保留、只增不改） | 财务视图**只读**消费（货币设计 §12 口径） |
| `runReconcileOnce()`（`reconcile.service.ts:187`，注释已写「测试/运维手动触发用」） | 对账面板接上它 + 新增最近结果内存态 + 互斥（§5.7） |
| `XAdminGuard` 三份复制件（config/currency/user） | **矩阵不动**（仍只认 `X-Admin: 1` + 授权收口在网关 D2）；**currency 复制件仅扩一处**：写端点从 `X-Admin-Actor` 取 actor（§4.2；N2 措辞订正——不是「三份全不动」） |
| `adminLogin()` 等（`tools/conformance/src/lib/http.ts:209-232`） | 改登录体形状一处，消费切片**自动跟随**（06/07.1/07.2-hardening/12/13/14/15/17/18；§9.1 #1） |
| 管理页 `admin/app.js`（596 行，两视图） | 加登录用户名框 + 三视图 + 角色导航；延续「只按 HTTP status 分流」纪律（`app.js:19-27`） |
| `scripts/browser-e2e.mjs`（玩家 H5 验收探针，用管理登录开好友房） | 登录体同步改版（:629；§9.1 #9） |

---

## §2 架构决策（D1–D7）

**D1｜扩展既有服务，不新起 admin-service。** 账号/登录/审计读口落 **config-service**（它已拥有管理登录、令牌签发、配置写三大管理面职责，事实上就是 admin-service）；钱的读口落 **currency-service**（钱的屋）。**已否方案**：新第 8 个服务——新服务的登记成本极重（端口/容器/监控/CI/Dockerfile/conformance 全清单），而管理面端点总数约 24 条（含 CSV 变体），且多为对既有表的读写（本片新增的只是 config-service 侧四张管理小表，§3），不值当。**登记命名债**：config-service 之名从此不完全贴切（含账号与审计）——改名不做（迁移成本 >> 收益），留档即可。

**D2｜授权单点 = 网关；身份头只可能来自验证结果。** 角色矩阵只在网关一个新模块 `admin-policy.ts` 执行（§4.4），**按显式枚举**（不做 `/accounts*` 类通配——`GET …/accounts/changes` 归审计读、全角色；`GET …/accounts` 与账号写面归超管；N1）；下游守卫**不加第二份矩阵**——本仓已有教训：同一契约在两处各写一份（`ADMIN_JWT_SECRET` 密钥链「两侧逐字同链」，`admin.middleware.ts:23-25` 注释原文）迟早漂移，而漂移无闸可见。**失败闭口**：非 GET 的 admin 路径**未在矩阵登记 ⇒ 403**（新增写端点必须同步登记 + 单测枚举覆盖，§10）。下游照旧只信 `X-Admin: 1`（信任边界 = 网关已执行完鉴权+授权；服务不对外暴露 + `X-Internal-Token` 为第二层）。

**D3｜四角色固定矩阵**（无自定义权限）：

| 动作 | super_admin | finance | operator | viewer |
|---|---|---|---|---|
| 配置写（`PUT /api/admin/config/:key`） | ✓ | | ✓ | |
| 发币/扣币/冲正（wallet adjust·reverse） | ✓ | ✓ | | |
| 对账手动触发（reconcile/run） | ✓ | ✓ | | |
| 账号管理（列表 `GET /api/admin/accounts`、建号 `POST /api/admin/accounts`、`PATCH /api/admin/accounts/:id`） | ✓ | | | |
| 变更历史查看（`GET …/config/changes` · `…/accounts/changes` · `…/login-events`） | ✓ | ✓ | ✓ | ✓ |
| 财务全部查看（流水/汇总/CSV/用户查询） | ✓ | ✓ | ✓ | ✓ |
| 其余 admin **GET** | ✓ | ✓ | ✓ | ✓ |

**D4｜审计四源直读，不建第二账。** 资金操作 = `currency_ops`（权威记录，本来就有 actor/reason）；配置变更 = 新表 `config_changes`（此前只有 NDJSON 日志，「旧值→新值」**在任何表里都不存在**——这是 M0.4 的真缺口）；登录事件 = 新表 `admin_login_events`；账号写面 = 新表 `admin_account_changes`（F5：三源不覆盖建号/提权/停用——恰是最需回溯的写面）。**不造统一 audit 表**（复制即第二账，且与货币设计 §12 口径冲突）。审计视图 = 管理页四页签分别读四源。

**D5｜管理员口令哈希 = `node:crypto` scrypt，不引 bcrypt。** 事实依据：`Dockerfile.config-service:31-34` 注释明写「config-service **没有**原生依赖（mysql2/ioredis 均纯 JS）⇒ 没有 user-service『再重建 bcrypt』那一步」；user-service 为 bcrypt 付了 python3/make/g++ + node-pre-gyp 重建的完整代价（`Dockerfile.user-service:7-9,32-39`）。scrypt 是 OWASP 认可的口令 KDF，零新依赖、零原生编译链。**参数照 OWASP 最低推荐：`N=2^17, r=8, p=1`**（128 MiB 内存硬度）、keylen=32、16 字节随机盐；存储格式 `s1$N$r$p$saltB64$hashB64`；比较走 `timingSafeEqual`。⚠️ **`maxmem` 必须显式传**（128·N·r = 128 MiB > node 默认 32 MB —— 不传就是必然抛错的经典坑；设 160 MiB 留余量）。⚠️ 内存 DoS 面（每次尝试瞬态 128 MiB）由登录失败桶（5 次/5 分钟/IP）罩住，登记 §11 R9。**单测以注入的小参数运行**（避免测试变慢），另留一条「生产默认参数端到端」测试钉默认值。

**D6｜冲正 = 新 source `admin_reverse` + 唯一锚 `admin:reverse:<opId>`。** 复用 `currency.apply` 唯一写边（D3 纪律不破）；`actionId` 的**唯一键本身**就是「同一笔只能冲一次」的机制（无需新表/新锁）；`refId` = 原 `action_id` 建立双向关联。协议 allowlist 单点扩容（`packages/protocol/src/currency.ts`），`admin_reverse` 与 `admin_adjust` 同规：`actor`/`reason` 必填。**不冲冲正**（source 必须恰为 `admin_adjust`）。

**D7｜对账面板 = 复用 `runReconcileOnce` + 新增内存态 + 互斥。** 现服务已有公开方法（注释即写明为手动触发准备）与 `last_success` 指标；补：最近一轮结果内存态（GET 可读，重启后为「未知」）、`inFlight` 互斥（手动与定时链共用一把旗：定时轮遇手动在跑 ⇒ 跳过本轮并记录；手动遇定时在跑 ⇒ 409）。**不加历史表**（1.2）。

---

## §3 数据模型（config-service 四新表；共库 `fight_the_landlord`）

```sql
-- 1) 管理员账号（唯一的身份来源；删除不提供，只有停用——审计完整性）
CREATE TABLE IF NOT EXISTS `admin_accounts` (
  `id`            bigint       NOT NULL AUTO_INCREMENT,
  `username`      varchar(32)  NOT NULL,      -- 入库即小写；规则见 §5.4（^[a-z0-9][a-z0-9._-]{2,31}$）
  `password_hash` varchar(255) NOT NULL,      -- scrypt 格式串（D5）
  `role`          varchar(16)  NOT NULL,      -- super_admin | finance | operator | viewer
  `status`        varchar(10)  NOT NULL DEFAULT 'active',  -- active | disabled
  `created_at`    datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `last_login_at` datetime(3)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_admin_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) 登录事件（成功 + 失败；量级受网关限流约束 —— 5 次/5 分钟/IP 封顶）
CREATE TABLE IF NOT EXISTS `admin_login_events` (
  `id`         bigint      NOT NULL AUTO_INCREMENT,
  `username`   varchar(32) NOT NULL,     -- 尝试的用户名（小写归一；未知账号也记）
  `account_id` bigint      NULL,         -- 账号存在时回填；未知账号 NULL
  `ip`         varchar(64) NULL,         -- 网关注入的可信客户端 IP（§4.4；缺头 ⇒ NULL，不伪造）
  `success`    tinyint(1)  NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_login_events_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) 配置变更历史（M0.4：时刻 + 旧值→新值 + 改动人）
CREATE TABLE IF NOT EXISTS `config_changes` (
  `id`         bigint      NOT NULL AUTO_INCREMENT,
  `key`        varchar(64) NOT NULL,
  `old_value`  json        NULL,         -- 首建（该键此前不存在）⇒ NULL
  `new_value`  json        NOT NULL,
  `actor`      varchar(32) NOT NULL,     -- 操作者用户名
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_config_changes_key` (`key`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4) 账号变更历史（建号/改角色/停用启用/重置口令 —— 与账号写**同事务**落行）
CREATE TABLE IF NOT EXISTS `admin_account_changes` (
  `id`           bigint      NOT NULL AUTO_INCREMENT,
  `target_id`    bigint      NOT NULL,     -- 被操作账号
  `username`     varchar(32) NOT NULL,     -- 冗余快照（账号不可删，无需防悬空，仅为查询展示）
  `action`       varchar(16) NOT NULL,     -- create | role | disable | enable | password_reset
  `detail`       json        NULL,         -- 如 {"from":"viewer","to":"finance"}；password_reset 只记发生不记值
  `actor`        varchar(32) NOT NULL,     -- 操作者用户名
  `created_at`   datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_account_changes_target` (`target_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

约定：

- **迁移**：单文件 `packages/config-service/src/migrations/1789900000000-AdminRbac.ts`（**顺延既有序列**：1789200000000/1789500000000/1789700000000/1789800000000 已占用——1789900000000 为下一个空号；规格定稿时复核）。
- **种子不走变更历史**：`config_changes` 只在**管理 API 写**时落行（与迁移种子/演练写 `updated_by='seed'/'drill'` 的既有事实对齐）；`platform_config.updated_by` 从此写真实操作者（此前写死 `'admin'`，`admin.controller.ts:121-122`）。
- **`currency_*` 三表零改动**；口令散列**永不出站**（任何端点/日志/CSV）。
- 时间列沿用 `datetime(3)` 惯例；金额面不涉。

---

## §4 接口

### 4.1 config-service 管理 REST（变化与新增）

| 方法/路径 | 变化 | 说明 |
|---|---|---|
| `POST /api/admin/login` | **改版** | body `{username, password}`（原 `{password}`）；成功 → `{token, expiresIn: 7200, username, role}`；失败矩阵 §8。**管理面未启用（零账号）仍回 404**（沿用「没开不得伪装成故障」口径，`admin-auth.service.ts:41-45`） |
| `GET /api/admin/accounts` | 新增 | 列表：`{id, username, role, status, createdAt, lastLoginAt}`（**永不出** `password_hash`；super_admin） |
| `POST /api/admin/accounts` | 新增 | `{username, password, role}`；用户名小写归一；冲突 409；super_admin；同事务落 `admin_account_changes`(create) |
| `PATCH /api/admin/accounts/:id` | 新增 | `{role?, status?, password?}` 任意子集；自锁三闸 §5.4；super_admin；同事务落对应 action 行（role/disable/enable/password_reset；多字段一次变更 ⇒ 逐动作各一行） |
| `GET /api/admin/accounts/changes` | 新增 | 过滤 `targetId&actor&action&from&to` + keyset 分页；行 `{id,targetId,username,action,detail,actor,createdAt}`。⚠️ 静态段路由先于任何参数段（本表无 `:id` GET，无歧义；注册顺序纪律仍写死） |
| `GET /api/admin/config/changes` | 新增 | 过滤 `key&actor&from&to` + keyset 分页；行 `{id,key,oldValue,newValue,actor,createdAt}` |
| `GET /api/admin/login-events` | 新增 | 过滤 `username&success&from&to` + 分页；行 `{id,username,accountId,ip,success,createdAt}` |
| `PUT /api/admin/config/:key` | **语义扩展** | 同事务追加 `config_changes` 行 + `updated_by` = 操作者。**旧值取数 = 锁定读**（`SELECT … FOR UPDATE` 先行——普通快照读在 REPEATABLE READ 下可能取到更早版本，审计链错位；同族教训 = 货币 ⚙️14。先锁读还是并入现有 UPDATE 路径由规格对照 `platform-config.service.ts:100-159` 定稿，**纪律不放宽**） |
| CSV 变体 | 新增 | `…/changes.csv`（accounts 与 config 各一）、`…/login-events.csv`（§4.6） |

**对账无关**：config-service 不新增其它端点；`GET /api/admin/config` 现有形状不动（登录响应加字段是纯增量）。

### 4.2 currency-service 管理 REST（新增只读 + 冲正）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/admin/wallet/ops` | **流水列表**（`currency_flows f JOIN currency_ops o ON o.id=f.op_id`，LEFT JOIN `users` 取 phone/nickname 展示值）：每行 = 一笔「账户×操作」`{flowId, opId, actionId, source, actor, reason, refId, ownerId, ownerType, delta, balanceAfter, createdAt, phone?, nickname?}`；过滤 `source&actor&ownerId&from&to`（epoch ms）；**keyset**（`cursor`=上页末 flowId，`limit≤100`，`f.id DESC`） |
| `GET /api/admin/wallet/ops/:opId` | 操作详情：op 行 + 全部 flows（一次批量操作多账户时全部可见；含 `traceId`） |
| `GET /api/admin/wallet/summary` | 汇总：`?from&to&groupBy=source\|day` → `{rows:[{key, delta, flowCount}], totals:{delta, flowCount}}`；**day 按北京时间（+08:00）切天**（SQL 用 `CONVERT_TZ(...,'+00:00','+08:00')` 偏移量写法——**不依赖 MySQL tz 表**；库实际时区在规格期实测钉死，§11 R8） |
| `POST /api/admin/wallet/reverse` | 冲正：`{opId, reason}`（reason 1..200 必填）；语义 §5.5 |
| `GET /api/admin/wallet/reconcile` | 对账面板读口：`{lastAttemptAt\|null, lastSuccessAt\|null, lastResult\|null, lastError\|null, running}`（内存态；重启后为 null = 「未知」，页面如实显示） |
| `POST /api/admin/wallet/reconcile/run` | 手动触发一轮（D7 互斥）；返回该轮读数（与 `CurrencyReconcileRoundResult` 同形） |
| CSV 变体 | `…/ops.csv`、`…/summary.csv`（§4.6） |

**actor 来源（fail-closed）**：`adjust`/`reverse` 从网关注入的 `X-Admin-Actor` 读取（合法性 = 用户名正则 §5.4；**缺失或非法 ⇒ 4xx 拒绝**，不回退 `'admin'`——回退就是身份伪造面）。`x-admin.guard.ts` 复制件按既有惯例扩展到读该头（仅写端点强制）。

### 4.3 user-service（一个新增）

`GET /api/admin/users/:userId` → `{userId, phone, nickname, status, createdAt}`（财务/审计视图展示用户身份用；404 借 `11004`）。`GET /api/admin/users/lookup?phone=` 原样保留。

### 4.4 api-gateway（改造点）

1. **`identity-headers.ts`**：新增 `ADMIN_ACTOR_HEADER='x-admin-actor'`、`ADMIN_ROLE_HEADER='x-admin-roles'`、`CLIENT_IP_HEADER='x-client-ip'`；`DownstreamHeaders` 增 `adminActor?/adminRole?/clientIp?`。
2. **`admin.middleware.ts`**：**剥四枚**（`X-Admin`/`X-Admin-Actor`/`X-Admin-Roles`/`X-Client-Ip`，位置不变：所有路径、任何判断之前）；验签后**校验载荷**（`sub`/`username`/`role` 齐备且 `role∈` 四值，否则 401 —— 旧令牌无身份字段 ⇒ 升级后**全员重新登录一次**，登记）；**注入三枚**（`X-Admin:1` + actor + role，验真后）；`req.adminTokenFp` 不变。
3. **新模块 `admin-policy.ts`**：方法+路径 → 允许角色矩阵（D3）；非 GET 未登记 ⇒ 403；**403 在 AdminAuth 内抛**（不注入任何下游头）。
4. **`POST /api/admin/login` 转发**：`headersOf()` 注入可信客户端 IP（`clientIpFrom`，`trusted-client-ip.ts:34` 唯一实现）——**只此一条路径注入**（照 R31 的 `X-Token-Jti` 纪律，`identity-headers.ts:17-24`）；config-service 登录事件落库用。
5. **路由登记**：新端点逐条登记（gateway.controller 显式声明惯例）：login 改版 · accounts 4 条 · config/changes · login-events · wallet ops 2 条 · summary · reverse · reconcile 2 条 · users/:userId（§4.3）· **五条 CSV**。**query 白名单**：新列表端点的过滤参数照 `recordsQueryOf`/`lookupQueryOf` 先例（`gateway.controller.ts:445-452`）逐条白名单（漏白名单 = 静默丢参数仍 200）；**路径参数编码**照 `:key`/`:userId` 先例（R75）。

### 4.5 管理页（admin/）

- **登录卡**：加「用户名」输入框；登录响应存 `{token, username, role}` 于 `sessionStorage`；**404 文案改版**：`app.js:210` 「管理面未启用（服务端未设置口令）」→ 「管理面未启用（未创建任何管理员账号）」（§9.2 同步 + slice-19 静态断言）。
- **导航按角色显示**：配置 = super_admin/operator；财务 = 全角色；审计 = 全角色；账号 = super_admin。**仅 UI 门面**——服务端才是闸（§4.4）。
- **财务视图**：筛选条（来源下拉=allowlist、操作者、用户手机号/ID、时间范围预设）+ 流水表 + keyset 翻页 + 「操作详情」展开 + 汇总卡（按来源/按日切换）+ 机器人池水位卡（**池余额** `accounts/robot-pool` + 一键跳转流水预筛 `source=robot_pool`——三档水位为 per-bot sha256 派生**不在配置里**，不展示；F3）+ 对账面板（读数 + 时间 + 「立即对账」按钮）+ 各处「导出 CSV」。
- **审计视图**：**四页签**（配置变更 / 资金操作＝流水列表预筛 `source∈{admin_adjust,admin_reverse}` / 登录事件 / 账号变更），各自筛选 + CSV。
- **账号视图**：表格（用户名/角色/状态/最近登录）+ 建号表单 + 行内「改角色/停用启用/重置密码」。
- 延续既有纪律：**只按 HTTP status 分流、不读 body.code**（`app.js:19-27`）；401 ⇒ 回登录并清 DOM。**🔴 输出编码纪律（G10）**：玩家可控数据（nickname/phone）与自由文本（reason/username/detail）渲染**一律 `textContent`，禁 `innerHTML`**（现 `app.js` 无 innerHTML 先例，:172/:467/:490）；管理页持有全权限令牌，存储型 XSS 影响面最大——纪律写死 + slice-19 静态断言候选。

### 4.6 CSV 契约（统一）

- `text/csv; charset=utf-8`；**首字节 BOM `﻿`**（中文 Excel 直开）；`Content-Disposition: attachment`，文件名 `flows-<yyyymmdd-HHMMss>.csv` 形。
- **公式注入消毒**：单元格首字符 ∈ `= + - @ tab CR` ⇒ 前置 `'`（规则：**整格为合法数字则不动**（负数场景），否则前置——规格钉判别式）。
- 行数上限：`ops.csv` 单次 ≤ 50,000 行（超 ⇒ 400 + 提示收窄范围）；其余列表面量级天然小。
- 列名中文表头（受众 = 运营本人）。

---

## §5 语义细节

### 5.1 首启引导（bootstrap）与管理面启用谓词

- config-service 启动时（`OnApplicationBootstrap`）：`admin_accounts` **空**且 `ADMIN_PASSWORD` 非空 ⇒ 建 `super_admin` 用户名 `admin`、口令 = scrypt(`ADMIN_PASSWORD`)（D5），响亮日志（一行：已创建引导账号 admin）。空表且 env 空 ⇒ 不建、warn 一行。
- **管理面启用谓词改为「`admin_accounts` 表非空」**（原：env 非空）。`ADMIN_PASSWORD` 从此**只是首启引导与复位的原料**，日常不动。
- 🔴 **存量口令与长度策略的交互（F10a，防升级自锁）**：bootstrap **不套用**口令长度策略（存量 `ADMIN_PASSWORD` 可能 <10 字符 ⇒ 照建，仅 warn 一行）；长度策略只在**设置口令**的路径（建号/重置）强制；**登录不校验口令长度/字符集**（只做形状级：字符串、非空、≤1024）——任何长度都能通过比较。
- 守卫：并发启动/重启幂等（空表检查 + 唯一键双保险）；**老备份恢复**情形（账号表空 + env 里有值）⇒ 自动重建 `admin` 引导号 = **预期行为**（这就是拿回管理面的路），日志响亮（§11 R6）。

### 5.2 忘记口令的服务器复位（hatch）

- 新增命令：`docker compose exec config-service node packages/config-service/dist/admin-reset.js <username>`——按用户名为准：不存在则建（`--role` 可指定，默认 super_admin），存在则**重置口令**并强制 `status='active'`；新口令取 `--password` 参数或环境变量 `ADMIN_RESET_PASSWORD`，都没有则**生成随机口令打印一次**。同事务落 `admin_account_changes`（actor=`cli`）。
- 安全姿态：`docker exec` = 拥有服务器控制权者，与「改 .env」同级；手册写明。**无 HTTP 通道的复位**（不加远程重置端点——那才是洞）。
- **本机 dev 栈的连带（F10b）**：conformance `http.ts:206-207` 记录的「口令不同即用 `ADMIN_PASSWORD=…` 覆盖启动」机制在新语义下**失效**（口令真源已移库；存量卷对不上 ⇒ 401，改 env/重部署都救不了）——CI 全新卷无碍；本机存量卷的处置 = hatch 复位或清卷，写入手册。

### 5.3 登录、停用与令牌窗口

- 登录失败矩阵见 §8；**限流沿用两桶并两处扩边（F8）**：登录失败桶（5 次/5 分钟/IP，**401 与 403 都计失败**——现钩子只计 401，补 403，否则「停用账号」可无限试不触限流；200 清零）+ **持令牌写桶从「仅 PUT」扩为「全部非 GET」**（30 次/5 分钟/令牌，`http-rate-limit.middleware.ts:103` 现条件 `X-Admin==='1' && method==='PUT'` ⇒ 扩方法集；`http-rate-limit.middleware.ts` 及其单测进 §9.1）。
- **停用 / 改角色 / 重置口令的已发令牌窗口 ≤2h**（令牌 TTL 内旧 claims 继续有效；不做吊销名单，1.2 已列）。登录立即拒绝被停用账号（403）。

### 5.4 账号管理约束（服务端硬校验，UI 只是提示）

- **用户名规则（G12，四处共用同一定义：建号 / 登录归一 / `X-Admin-Actor` 校验 / CLI）**：`^[a-z0-9][a-z0-9._-]{2,31}$`（3..32 字符；**入库与比较一律小写**；全角/Unicode/大写输入先归一为小写、再按正则校验）。
- **口令策略**（仅设置路径）：10..72 字符；`password_hash` 永不出站；日志/响应/CSV 任何位置不出现明文。
- **自锁三闸**：
  1. 不能**停用/降级自己**（按令牌 `sub` 判）。
  2. **最后一名 active 的 super_admin** 不能被停用或降级——计数走**锁定读**（`SELECT COUNT(*) … FOR UPDATE`，锁 active 超管行，事务内改前执行；F7：普通快照读在 RR 下看不见并发已提交行，两名超管互降会双双通过 ⇒ 0 名超管永久自锁；同族教训 = 货币 ⚙️14，不得回退普通 SELECT）。
  3. 重置口令**不**校验旧口令（超管权限），但**不得**对 `status='disabled'` 账号「仅改口令」偷渡启用——启用必须显式 `status` 变更。
- 每次变更**同事务**落 `admin_account_changes` 行。

### 5.5 冲正语义

- 对象：`source='admin_adjust'` 的 op；`admin_reverse` 自身与系统来源一律拒（400/409）。
- 组包：`entries = 原 op 全部 flows 取负`（`ownerId/ownerType` 取自 flow）⇒ 经 `currency.apply` **整笔原子**（任一账户余额不足 ⇒ 全拒，`14001` 映射 409 + 提示「已部分花费，可改用手工扣减」）。
- 唯一锚：`actionId = admin:reverse:<opId>` ⇒ 重放安全（同 body ⇒ replayed），**重复冲正** ⇒ `14002` 冲突映射 409 + 文案「该操作已冲正」。
- 留痕：`source='admin_reverse'`、`actor`=操作者、`reason` 必填、`refId`=原 `action_id`；协议校验表同步扩（`validateCurrencyApply` 的 `admin_adjust` 分支复制一份给 `admin_reverse`）。

### 5.6 流水/汇总查询口径

- 列表单位 = **flow 行**（按人记账视角）；「一次操作多账户」靠 op 详情页聚合展示（列表不做 op 折叠——YAGNI）。
- 时间过滤按 `created_at`（epoch ms → `datetime(3)`）；排序恒 `f.id DESC`（与 `idx_flow_owner` 的 `(owner_id,id)` 左侧列自适应；无 ownerId 过滤时走主键倒序，现量级无虞，§11 R5）。
- 汇总 `groupBy=source` 键 = allowlist 五值 + `admin_reverse`；`groupBy=day` 键 = `YYYY-MM-DD`（+08:00）。**不含**余额快照维度（那是 `accounts` 的面）。

### 5.7 对账面板

- 状态：`lastAttemptAt / lastSuccessAt / lastResult / lastError`（内存；重启 ⇒ null ⇒ 页面显示「本进程尚未跑过」）。**每一轮开始（成败都）刷 `lastAttemptAt`**（G7——失败轮只刷 lastError 会让 lastAttemptAt 与 lastSuccessAt 恒等，面板无法表达「最近一次**尝试**失败于何时」）；成功轮刷 `lastSuccessAt` + `lastResult`，失败轮刷 `lastError`。
- 互斥：`inFlight` 旗（手动与定时链共用）；手动遇在跑 ⇒ 409；定时轮遇在跑 ⇒ 跳过本轮并记日志（照自重排链串行既有纪律）。

---

## §6 配置与 env

- **无新配置键**（17 键不动）；**无新服务、无新容器**。
- `ADMIN_PASSWORD`：语义变更（§5.1）——**值不改、仍在 .env**；文档口径全面重写（§9.2）。
- `ADMIN_JWT_SECRET`：不动（两侧同一密钥链纪律不变）。
- `docker-compose.yml`：config-service 无新增 env；**其余零改动**。

---

## §7 安全与限流

- 伪造头剥除四枚（§4.4-2）；**身份头只可能来自验证结果**（既有纪律原文不动，只扩列表）。
- 403 路径不注入任何下游头、不进令牌写桶（在 AdminAuth 即拒）——但**登录失败桶计 403**（§5.3）。
- 口令：设置路径 10..72；登录只做形状级校验（§5.1）；日志与响应**任何位置不出现口令明文**（单测钉死）；`password_hash` 永不出站。
- scrypt 参数与 `maxmem` 显式（D5）；`timingSafeEqual` 比较（长度先守卫——沿用登录比较既有纪律）；内存 DoS 面登记（R9）。
- CSV 公式注入消毒（§4.6）；**管理页渲染输出编码纪律**（§4.5 textContent，G10）。
- 账号枚举：登录对「未知用户名」与「口令错误」回**同一个** 401 文案；403 仅在用户名存在且停用时出现（可枚举性代价=便利性收益，管理面 + 限流下接受，登记）。

---

## §8 错误码与 HTTP 映射

| 场景 | HTTP | code 口径 |
|---|---|---|
| 管理面未启用（零账号） | 404 | 借 `10001`（沿用片⑦先例） |
| 登录：**形状级**非法（缺 `username`/字段类型错/超长） | **400** | 借 `10001` + 原因串（G6：与 401 的边界 = 「请求根本不成形」vs「形状对但凭据无效」） |
| 登录：未知用户名 / 口令错 | 401 | 同一文案（防枚举） |
| 登录：账号已停用 | 403 | 同上信封 |
| 令牌缺失 | 401 | `10002`（`ErrCode.UNAUTHENTICATED`，`admin.middleware.ts:64-66`——**现状语义，不改**；F4 订正） |
| 令牌过期 / 伪造 / **无身份字段（旧令牌）** | 401 | `10005`（`ErrCode.TOKEN_INVALID`，:71-75——现状语义，不改） |
| 角色不足 | 403 | 新语义：管理员信封 + 文案 |
| 参数非法（用户名/角色/口令/过滤器） | 400 | 借 `10001` + 原因串（config PUT 先例形态） |
| 用户名冲突 / 冲正重复 / 余额不足 / 对账在跑 | 409 | 冲正余额不足借 `14001`、重复借 `14002`、账号冲突新文案「用户名已存在」 |
| 未登记的非 GET admin 路径 | 403 | fail-closed（D2） |

---

## §9 冲击清单（实施时**逐条**核销；漏一条 = push 必红或静默失明）

### 9.1 硬闸（不改必红）

| # | 资产 | 现状 → 本片 |
|---|---|---|
| 1 | `tools/conformance/src/lib/http.ts:209-232` | `adminLogin()` body 改 `{username:'admin', password:ADMIN_PASSWORD}`；`adminGetConfig/adminPutConfig` 不变 ⇒ **消费切片自动跟随**：06/07.1/07.2-hardening/12/13/14/**15**/17/18（F2/G2 订正：`slice-07.2-deploy` 无 `adminLogin` 消费，不在名单） |
| 2 | `slice-14-config-center` C6（:472-488） | 「空 env ⇒ 404」语义**已变**（账号存在则仍可用）⇒ 重写为：空 env + 账号在 ⇒ 登录**成功**（新语义钉子）；「零账号 ⇒ 404」由单测钉（conformance 不造空表） |
| 3 | `slice-14` C15（:517-538） | 五次错误口令体形状改 `{username,password}`；429 断言保持 |
| 4 | `slice-17-currency` C11（:857） | `ops.actor` 断言：默认引导账号名 `admin` ⇒ 旧断言**字面仍绿**；**新增**「第二账号发调整 ⇒ actor=其用户名」进 slice-19（防「读了个固定值」的假绿） |
| 5 | **单测 `packages/api-gateway/test/admin.middleware.test.ts`（伪造 X-Admin 族先例 :79-124）** | 扩：三枚新头伪造剥除 · claims 校验（缺 sub/坏 role ⇒ 401）· 验真后三枚注入 · policy 矩阵逐端点正反 + 未登记写路径 403（F2 订正：`tools/` 目录**零** X-Admin 引用——旧稿错指 slice-07.2-security，该片是座位归属、**大概率不动**） |
| 6 | `packages/api-gateway/src/http/http-rate-limit.middleware.ts`（:94-101 计失败、:103 PUT 判定） **+ 其单测** | 登录钩子从「仅 401」扩「401+403」；写桶从「仅 PUT」扩「全部非 GET」（F8 补遗——新写端点否则只剩 IP 维） |
| 7 | `tools/conformance/baselines.json` | 新增 `slice-19-admin-rbac-audit` 下限（CI 实测回填）；被改切片（14/17，如读数变则只抬不降；07.2-security 预期不列入） |
| 8 | 各服务单测 | `admin-auth.test.ts`（signToken 签名与 scrypt）/`admin.controller.test.ts`/`config.validation` 族/新三服务单测矩阵（§10） |
| 9 | `scripts/browser-e2e.mjs:629`（**非推送闸但本片直接破坏**，F9） | 登录体 `{password}` → `{username:'admin', password}`；它是验收轮浏览器走查的现成工具（`npm run e2e:browser`），改版后**先跑它**再进验收 |
| 10 | `slice-07.4-pipeline` 文件集闸 | 新文件（迁移/policy/CLI/页面）是否触及被钉死集合 ⇒ 实施首日核销（规格定）；`container-assembly.gate.test.ts` 已核验不受新路由影响（动词不同无冲突） |

### 9.2 计数/文案（人工同步，防文档谎报）

- `admin/app.js` 静态断言佐例（slice-17 ⑪C12 先例）→ slice-19 加「财务/审计/账号端点串在页内」+ **「页内无 innerHTML」**（G10）类断言；`app.js:210` 登录 404 文案同步改版（G8）。
- `scripts/ledger-counts.mjs` 台账计数；`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` M0.4 标完成；`docs/design.md` §7.5 管理面段（`:1135-1138`）+ 环境变量表 `ADMIN_PASSWORD` 行（`:192`）+ **接口表 `:404` 与 §7.1 路由 bullet `:1055`**（G14，两张表都写「登录 + 配置读/写」，早已部分陈旧）改写；`docs/superpowers/specs/2026-10-03-currency-design.md` §12 回填完成注记 + **G11 口径偏离登记**（「角色名」→「用户名（角色随行）」）；`docs/ops/first-deploy.md` 管理面章节（`911-954`）**全面重写** + **env 表 `:234` 行**（「不写 ⇒ 管理面整体关闭」旧语义，F10c）+ 虚拟池种子节（`1206-1267`）登录示例同步。
- 台账 `.superpowers/sdd/2026-10-05-admin-rbac-audit/`（progress.md 核销表 + 审批/登记）。

### 9.3 明确不动的面（防误伤）

玩家协议/客户端/`client-protocol.md`/17 键机制/监控规则/edge Caddyfile/compose 拓扑/`slice-07.2-security`（预期不动）。

---

## §10 测试与验收

**单测矩阵（每服务）**：

- config-service：scrypt（**注入小参数** + 一条生产默认参数端到端 + `maxmem` 边界 + 错口令 + 格式损坏）；bootstrap 三态（空表+env / 空表无 env / 非空表跳过 + **短口令照建仅 warn**）；登录失败矩阵（未知/错口令/停用/未启用/形状级 400）；账号 CRUD 自锁三闸（各正反 + **并发互降负例——双会话锁定读串行化**）；`PUT config` 同事务落 `config_changes`（旧值/首建 NULL/**并发同键写旧值不错位（锁定读）**/回滚原子性）；登录事件成功+失败落行；账号变更四动作落行；三审计列表的过滤/分页；`admin-reset` CLI（建号/复位/随机口令）。
- api-gateway：policy 矩阵**逐端点正反**（四角色 × 每写端点）+ **未登记写路径 ⇒ 403**；claims 校验（缺 sub/坏 role ⇒ 401）；剥头四枚（伪造值**不**达下游）+ 验真后注入三枚；login 路径 clientIp 注入（恰一条路径）；403 不注入头；**限流桶扩边**（非 GET 进写桶、403 计失败、200 清零）。
- currency-service：ops 列表（过滤四维/keyset/边界 limit）；op 详情（多账户 op）；summary（source/day、+08:00 切天、空窗）；reverse（正例/已花费 14001 原子拒/重复 14002/非 admin_adjust 拒/重放幂等）；reconcile 状态与互斥（手动遇在跑 409、定时遇在跑跳过、**失败轮刷 lastAttemptAt**）；CSV（BOM/消毒/50k 上限）；actor 头缺失 ⇒ 拒。
- user-service：`users/:userId`（在/不在/越权角色 403）。
- 静态：admin/app.js 端点串 + 无 innerHTML 断言（§9.2）。

**conformance `slice-19-admin-rbac-audit`**（E2E，真栈）：登录矩阵（引导号/新账号/停用 403/错口令 401/**旧形状 body 400**）· 角色矩阵逐写端点 403 负例 + 合法 200 · 伪造头剥除 · 建号→发调整（actor=新账号名）→审计列表查得到 · 账号变更页签四动作可查 · 冲正全链（含重放与二次冲正 409）· 配置写→changes 行（旧值→新值）+ CSV 头/消毒样本 · 登录事件（成败双行、IP 列非空）· 汇总与流水过滤 · 对账面板读写 · 未登记写路径 403（如可造）。

**验收轮**：本机全序 + CI 三绿（push 前六阶段）；浏览器级：**先跑 `scripts/browser-e2e.mjs`（改版后）**，再对 admin 页三视图实拍走查（登录/角色导航/建号/发币/冲正/导出 CSV 实开）+ 玩家面无回归。

---

## §11 残余风险与待审低置信项（评审重点）

| # | 风险 | 处置/口径 |
|---|---|---|
| R1 | 停用/改角色后旧令牌 ≤2h 窗口 | 显式登记；规模小接受；将来人多了再上吊销（预埋：claims 已有 `sub`） |
| R2 | 授权单点=网关：policy 表错一行即越权 | 单测逐端点正反 + 未登记 fail-closed + slice-19 负例三重钉；**评审专项审 D3 矩阵** |
| R3 | 登录事件 IP：`x-client-ip` 全链新头 | 只在 login 一条路径注入；`clientIpFrom` 已是唯一实现；缺头 ⇒ 落 NULL 并在 UI 显示「-」（不伪造） |
| R4 | 对账互斥实现（inFlight 旗 vs 队列） | 选旗 + 409/跳过；评审可推翻 |
| R5 | 流水/汇总在大表上的过滤无独立索引（`o.source/o.actor`） | 现量级（呼应货币设计 R5）无虞；>百万行再谈增量/索引 |
| R6 | 老备份恢复：账号表空 + env 有值 ⇒ 自动重建 `admin` | 预期行为 + 响亮日志 + 手册写明；评审请复核「是否接受自动重建」 |
| R7 | CSV 中文 Excel 兼容与公式注入 | BOM + 消毒判别式（负数 vs 公式）规格钉死 |
| R8 | 时区：「按日」与显示口径 | 切天 = +08:00（`CONVERT_TZ` 偏移写法）；**库实际时区与页面时间显示口径在规格期实测钉死**（低置信项） |
| R9 | scrypt N=2^17：每次尝试瞬态 128 MiB 内存 | 登录失败桶（5/5min/IP）+ 管理面私密性罩住；并发多 IP 攻击的内存压力登记接受；评审可推翻参数（往上一档 OWASP 加倍亦然） |
| R10 | 管理面启用谓词变化（env 不再是开关） | 文档同步（design.md 四处 :192/:404/:1055/:1135-1138；first-deploy 两处 :234 与 911-954——总清单见 §9.2）；§5.1 存量口令自锁面已闭环（F10a） |
| R11 | admin/app.js 无自动化 UI 测试 | 沿用现状（静态串断言 + 终验浏览器走查 + browser-e2e 先跑）；登记 |

---

## §12 交接须知（给支付片与风控片）

- **支付片**：actor 体系已泛化（网关注入 → 任意管理写端点可用）；`source` allowlist 单点扩容（`recharge/refund/withdraw`）；财务视图的流水/汇总**天然覆盖**新 source（无需改查询）；角色矩阵中「财务写面」直接扩条目即可。
- **风控片**：与 `admin_accounts` 无交集（封禁是**玩家**动作，走 user-service 新管理端点，届时复用本片角色矩阵与审计四源模式）。
- **③ 已交付的货币设计预埋消费**：§1.3 表中 `actor/reason`（已泛化，**口径偏离已登记**）、管理页块（已升级）、`ops/flows` 读源（已接）——回填注记见 §9.2。

---

## 修订记录

- **v1.0**（2026-10-05，`8ce919f`）：初稿（含用户四裁 K1–K5）。
- **v1.1**（2026-10-05）：r1 设计评审（零阻断；**10🟡 + 14🟢、锚点核验 31 处其中 8 处误引**）**全数处置**——F1 迁移改 `1789900000000`（避撞 SignupGrant）/ F2 §9.1 #5/#6 锚点订正（伪造头族真实家在网关单测；slice-07.2-security 移出名单）/ F3 池水位卡改「余额+流水跳转」（三档为 per-bot 派生非配置）/ F4 §8 令牌码订正（缺失 10002、无效 10005）/ **F5 新增 `admin_account_changes` 表与审计第四页签**（账号写面留痕）/ F6 config 旧值锁定读钉死 / **F7 最后超管保护改锁定读计数**（防并发互降自锁）/ F8 写限流桶扩「全部非 GET」+ 403 计失败 + 该中间件进清单 / F9 `browser-e2e.mjs:629` 进清单 / F10 引导不套口令策略（防升级自锁）+ dev 卷覆盖机制失效登记 + `first-deploy.md:234` 进同步范围；G1 R31 行号订正 / G2 消费切片名单订正 / G3 注入/剥除枚数措辞 / G4 端点数订正 / G5 路由登记+query 白名单+参数编码 / G6 登录 400/401 边界 / G7 `lastAttemptAt` 语义 / G8 登录 404 文案改版入同步 / G9 **scrypt 抬到 OWASP 最低推荐 N=2^17**（+maxmem 128→160MiB、内存 DoS 登记 R9、单测注入小参数）/ G10 textContent 输出编码纪律 / G11 actor 口径偏离显式登记 / G12 用户名正则定义 / G13 登录事件索引名实订正 / G14 design.md :404/:1055 入同步。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-design-r1.md`。
- **v1.1.1**（2026-10-05）：r2 复审**可通过**（24/24 全数核销），4 条不阻塞文字订正照办——N1 D3 矩阵拆显式枚举（`/accounts*` 通配与审计读的交面消除，policy 明确「按显式枚举」）/ N2 §1.3 守卫行措辞（currency 复制件扩 actor 读取，非「三份全不动」）/ N3 D1 论据订正（新增 config 侧四张管理小表）/ N4 §10 缺字（「伪造值**不**达下游」）与 R10 同步处计数。**设计到此冻结**。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-design-r2.md`。
