# 货币核心（P2 第一步）：钱包 / 账本 / 幂等 / 管理发放（**规格层 v1.0**）

> **状态**：v1.1 —— r1 合并评审（规格+计划同轮）全数处置（🔴1+🟡5+🟢5，见文末修订记录）。
> **分层**：本文 = 形式化层（把设计**判据化、契约化**）；上层依据 = `docs/superpowers/specs/2026-10-03-currency-design.md`（**设计层 v1.1**）。
> **来源**：设计全文 + 本会话仓内锚点核对（端口空位 / compose 形态先例 / 迁移表名先例 / conformance 现状读数）。
> **口径**：判据只增不减；一切数字写死（端口 / 键数 / 条数 / 时间）；全文无 TBD；§0.3 的 ⚙️ 条 = 起草期就地裁决（不是留白）。不新增设计没有的范围、不弱化任何设计判据。

---

## 0. 承接与订正

### 0.1 上游与版本（唯一依据）

| 项 | 出处 |
|---|---|
| 设计层 | `docs/superpowers/specs/2026-10-03-currency-design.md` **v1.1.1**；v1.0 初稿 = 提交 `8d4a8c2`；v1.1（r1 评审 7🟡+6🟢+漏闸 8 处全数处置）= `7afb399`；v1.1.1（CLIENT_ACTION 订正）= `1ebde26` |
| 修订记录 | 设计文末「修订记录」节；r1 评审报告 = `.superpowers/sdd/2026-10-03-currency/review-design-r1.md`（工作区工件，不入库） |
| 路线图 | `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P2′ 节 + 附录 §6 #21/#29/#34（`docs/appendix/platform-roadmap.md:319,327,332`） |

本文不重开设计取向；全部判据回指设计条款编号。

### 0.2 J1–J6 承接（设计 §0 用户裁决，逐条对位）

| # | 裁决要点 | 本片落点 |
|---|---|---|
| J1 | 三步依次做：①货币核心 → ②金币场 → ③财务后台+RBAC | 本片 = **①**；②③ 各自独立立项（本片只预埋设计 §1.3 扩展点） |
| J2 | 场开关归 ② | **不涉**（本片不加第 12/13 键） |
| J3 | 机器人虚拟币池归 ② | **不涉**（本片只预埋 `owner_type='robot'`，§2.10） |
| J4 | 支付范围（充值/退款/提现）归支付片 | **不涉** |
| J5 | 注册赠送 = 配置键、默认 0、注册那一刻快照 | **本片落**：§2.8（第 11 键）+ §2.7（快照语义） |
| J6 | 支付前管理员手动发放是真实运营路径 ⇒ ① 必须自带最小操作面 | **本片落**：§2.6（管理 REST 三端点）+ §2.14（管理页表单）+ C11/C12 |

### 0.3 ⚙️ 订正与回填（起草期发现的设计歧义/缺口 —— 就地裁决，无 TBD）

| # | 类型 | 内容与裁决 | 依据 |
|---|---|---|---|
| ⚙️1 | 订正 | 设计 §5.3 步骤 2 的 `INSERT IGNORE INTO currency_accounts(owner_id, balance)` **列清单补 `owner_type`**（取归一化后的传入值）；且 §5.4 的「ownerType 与既有行不一致 ⇒ 10001」的**读点钉死**为每个 entry 在批事务内的**第一步**（§2.3 算法步骤 a）。不补不钉则：② 机器人账户首建会被列默认 `'user'` 覆盖、且「何时查 ownerType」有两种读法 | §3「写入者自动建账户」+ §5.4「账户不存在时按传入值建 / 首写不可变」 |
| ⚙️2 | 回填 | `request_hash` 的**规范化形态逐字节钉死**（§2.3）：`sha256(JSON.stringify({source, entries(按 ownerId 升序，每条 {ownerId, ownerType 归一化值, delta}), actor:…??null, reason:…??null, refId:…??null}))`，小写 hex 定长 64 | §5.2 给了组成未给形态；该函数两端共用，形态必须唯一 |
| ⚙️3 | 回填 | apply 响应与重放重建的 `entries` 顺序 = **ownerId 升序**（= 执行序 = `ORDER BY owner_id` 重建序） | §4.3/§5.2 未定序；不定则「重放返回原结果」不可逐字节核销 |
| ⚙️4 | 回填 | Redis 缓存契约钉名（§2.11）：键 `currency:balance:<ownerId>`、值 = 十进制余额字符串、**无 TTL** | D2/§7 未给键形；不定则写穿/读穿/对账自愈不可判 |
| ⚙️5 | 回填 | reconcile 三检查的**判定形态与指标语义**写死（§2.12 两张表）；`CURRENCY_RECONCILE_INTERVAL_MS` 的 **compose 空默认透传行**（注入链的一环，设计 §9 清单未列） | §7 给了检查语义未给 SQL/扫描口径；注入先例 = 记录片 `RECORDS_CLEANUP_INTERVAL_MS` |
| ⚙️6 | 回填 | wire 细节：两条 RPC 请求均带 `meta?`、响应均包 `RpcResult`；`opId: number`（bigint 列读出转 number——本片量级远低于 2^53） | §4.3 信封/类型未逐字段写全；仓内 wire 惯例 |
| ⚙️7 | 回填 | 管理面错误语义写死（§2.6）：`lookup` 未找到 ⇒ 404+11004、phone 缺失/非法 ⇒ 400+10001；`accounts/:userId` 未开户 ⇒ 200+`{balance:0,recentFlows:[]}`（「未开户」是合法态，非 404） | §4.2 只给成功形状；管理页可用性依赖错误面可判 |
| ⚙️8 | 订正 | 注册链路 apply 失败的状态码：设计 §4.4 写「（500）」；本表形式化为 **HTTP 503 + 10007 信封**（依据：§11.1 统一响应形态不可破 + user-service 既有 `HTTP_STATUS[10007] = 503`、语义恰为「上游不可用」）。不变量（整体失败、零本地行、重试干净）逐字保留 | §11.1 + §4.4；对照体 = user-service `http/errors.ts:15` |
| ⚙️9 | 回填 | currency-service 迁移表名 = **`migrations_currency`**（同库三服务迁移表各一：user 默认 `migrations`、config `migrations_config`）。不钉则 currency 迁移与 user-service 的 `migrations` 表**相撞**（TypeORM 只认表名） | config-service 先例 `database.config.ts:36` |
| ⚙️10 | 回填 | 设计 §10 把「孤儿指标查询」列在 user-service 测试清单下 —— **归位 currency-service** reconcile 用例（该检查在 §7#3 的 currency 自调度循环内，user-service 无此逻辑） | §7 第 3 条职责位置 |
| ⚙️11 | 订正 | 设计 §8 的 CLIENT_ACTION 列「新增 `insufficient_funds`/`request_conflict`」**作废**：`ClientAction` 枚举（`packages/protocol/src/errors.ts:56-67`，TOAST 在 :64）是**行为值**（IGNORE/TOAST/BACK_TO_LOBBY…），非错误语义 —— 14001/14002 **映射既有 `ClientAction.TOAST`**（文案走 `message`），**不新增枚举值**；`CLIENT_ACTION` 完整性测试（`errors.test.ts:30-36`）会强制两码有条目 | 起草期对照 `errors.ts` 实名枚举核对；设计同步订正为 v1.1.1 |
| ⚙️12 | 回填 | §2.3.b 的 `INSERT IGNORE` 加**受影响行数判读**：行数 = 0（行已存在——**可能是并发他人首建的**）⇒ **先重查 `owner_type` 一致性**（异型 ⇒ 10001）再重试本步——闭合「并发首写异型溜过类型闸」的窄洞（本片 ownerType 恒 'user' 不可达；② 机器人接入前必须已是此形态）。**⚠️ 本条闭合声明被 ⚙️14 勘误** | 合并评审 🟢1；对照 §5.4 首写固化语义；勘误见 ⚙️14 |
| ⚙️14 | 勘误+订正 | **⚙️12 的「重查」在真库不成立**（T3 审查真库双会话实证：REPEATABLE READ 下普通 SELECT 读不到并发已提交行；且**正 delta 时条件 UPDATE 按当前读直接命中并发首写行、成功收尾，根本到不了重查点**）。**订正形态（本片就地修）**：① 快照步 c 改为**锁定读** `SELECT balance, owner_type … FOR UPDATE` 并**断言 owner_type 一致**（异型 ⇒ 10001、整批回滚——锁定读读到最新已提交版本，覆盖「UPDATE 成功但行是并发他人异型首写」的 POS 路径）；② INSERT IGNORE 0 行分支的重查同改锁定读；③ UPDATE 成功判据收紧为 `affectedRows === 1`（其余 ⇒ 内部错，响亮）。本片 ownerType 恒 'user' 不可达；**② 准入前置（阻碍项）**：机器人接入前必须保持此形态 + 真库双会话负向用例过 | T3 审查 🟡-1（dev MySQL 8.0.46 两会话交错实测 + 假 DB 遮蔽点 `test/helpers/fake-currency-db.ts:216-218`）；修复批见提交记录 |
| ⚙️15 | 回填 | §2.4 补钉：`exists=false` ⇒ **不写缓存**（写 0 会让对账检查 2「账户不存在也算漂移」把读穿自造键判成漂移；与 §2.4「不产垃圾行」同旨） | T4 裁决 3；与 §2.12 检查 2 自洽 |
| ⚙️13 | 订正 | **回放重建排序口径**：hash 规范化与执行序用 JS code-unit 升序（⚙️2/⚙️3）；`currency_flows` 回放重建**不得裸用 `ORDER BY owner_id`**（列 collation `utf8mb4_0900_ai_ci` 大小写不敏感，与 JS 序在混合大小写下不一致）——读后在应用层用**与 hash 同一比较器**排序（或 SQL 显式 `COLLATE utf8mb4_bin`）；T3 落地并加混合大小写用例（'B'/'a'） | T2 审查 🟢2；本片 ownerId 全小写不可达，② 机器人 id 前必须已是此形态 |

---

## 1. 改动面一览

### 1.1 新增文件（分组清单；精确路径以计划为准，组内不遗漏）

| 组 | 文件 |
|---|---|
| 镜像配方 | `Dockerfile.currency-service`（照抄 config-service 模板；**patches/ 拷贝面逐行核对**——双 Dockerfile 闸盯） |
| 新服务包 | `packages/currency-service/`：`package.json`（name `@fight-the-landlord/currency-service`；scripts build/test/lint/dev/migration:*）、`tsconfig.json`、`vitest.config.ts`、`src/{main.ts,app.module.ts,database.config.ts,data-source.ts}`、`src/http/{errors.ts,internal-token.middleware.ts,x-admin.guard.ts}`、`src/rpc/`（接收控制器 + 服务 + 模块）、`src/apply/`（写路径）、`src/reconcile/`（自调度循环）、`src/wallet/`（REST 控制器）、`src/redis/`（照 user-service 模板）、`src/migrations/1789600000000-Currency.ts`、`test/*` |
| protocol 契约面 | `packages/protocol/src/currency.ts`（新，§2.2）+ `src/currency.test.ts`（新） |
| user-service | `src/currency/{currency.module.ts,currency.client.ts}`（新；§2.7/§2.13）；`src/users/admin-users.controller.ts`（新；`XAdminGuard` 复制件放 `src/http/x-admin.guard.ts`） |
| config-service | `src/migrations/1789700000000-SignupGrant.ts`（新，§2.8） |
| 管理页 | `admin/` 新 section「钱包调整」（`index.html` + `app.js`；样式随既有静态页，无构建，§2.14） |
| conformance | `tools/conformance/src/slices/slice-17-currency.ts`（新） |

### 1.2 修改文件（按包）

| 包/文件 | 动作 |
|---|---|
| `packages/protocol/src/rpc.ts` | `RPC_PATTERNS` +`currencyApply:'currency.apply'`、`currencyGet:'currency.get'`（+类型导出，照 `record.write` 先例） |
| `packages/protocol/src/config.ts` | 第 11 键 `currency.signupGrant`（CONFIG_KEYS + parse 分支，§2.8） |
| `packages/protocol/src/errors.ts` | `ErrCode` +14001/14002；`ClientAction` +2 值 + `CLIENT_ACTION` 映射（§2.9） |
| `packages/user-service/src/auth/auth.service.ts` | `register()` 接入 §2.7（先货币后落库）；依赖注入货币客户端 |
| `packages/user-service/src/{config/config-cache.module.ts,config/config-cache.service.ts}` | 再增一条出站 RPC 边：ClientsModule 第二条 proxy + `signupGrant()` getter（缺省/坏值 ⇒ 0）；模块注释「只有这一条出站 RPC 边」同改（§9.3） |
| `packages/user-service/src/app.module.ts`、`users/users.module.ts` | 注册 currency 模块 + `admin-users.controller`（**T6 教训：未注册 = 单测全绿而真容器 404**） |
| `packages/api-gateway/src/gateway/proxy.gateway.ts` | +`forwardToCurrencySvc`（照 `forwardToUserSvc` 形状）；env `CURRENCY_SERVICE_URL` |
| `packages/api-gateway/src/gateway/gateway.controller.ts` | +4 条显式路由（§2.13） |
| `docker-compose.yml` / `docker-compose.override.yml` | +currency-service 块（§2.1）/ dev 端口 `3104:3104`（§4 #22）；gateway 块 +`CURRENCY_SERVICE_URL=http://currency-service:3004`；user-service 块 +`CURRENCY_SERVICE_RPC_HOST/PORT` 两行 |
| `deploy/monitoring/prometheus/prometheus.yml` | 头注释 13→14 + 第 14 个 job（§4 #6） |
| `scripts/deploy/conformance-stack.sh` | `SERVICES` 12→13（§4 #5） |
| `admin/{index.html,app.js}` | 新 section（§2.14） |
| `tools/conformance/src/run.ts` / `baselines.json` | §7 登记 |
| 文档/台账 | `docs/design.md`、`docs/ops/first-deploy.md`、roadmap、监控片两文注记、workflows 计数 —— 逐条见 §4 文案行 |

### 1.3 明确不在改动面（有意）

`scripts/ci.sh` 与四个 workflow 的**结构**（仅计数/步骤名文案，§4）；游戏侧一切（room/game/robot/douzero 零改动）；`shared`（无新指标代码——用既有构造器）；客户端 `client/`（**玩家可见面为零，本片暗上线**）。

---

## 2. 新契约（写死）

### 2.1 服务、端口与骨架

**端口（三处均为既有序列空位，设计已核查）**：HTTP **3004** / RPC(TCP) **3104** / metrics **9004**。容器 `ftl-currency-service`，镜像 `${IMAGE_PREFIX:-pokergame}-currency-service:${IMAGE_TAG:-latest}`。

**main.ts 骨架核销**（照 config-service 模板，§9.3）：① `INTERNAL_SERVICE_TOKEN` 未配 ⇒ 拒起（fail-closed，`process.exit(1)`）；② `createRedactingLogger` 服务短名 = package name 末段（`currency-service`，机械闸盯）；③ 中间件顺序 **trace → metrics → internal-token**；④ `internal-token.middleware.ts` 新拷贝，豁免面 = `['/api/health','/api/health/live']`（精确匹配，负对照：`/api/healthz` 仍 401）；⑤ `startMetricsListener({ port: 9004 })` 在 `listen()` 前；⑥ RPC 监听 `RPC_PORT ?? '3104'`；HTTP `PORT ?? '3004'`。**DI 纪律**：要注入的类型必须**值导入**（`di-type-import-trap`：`import type` 让容器启动即崩，单测与 tsc 都看不见）。

**compose 块（骨架逐字；注释密度照既有块）**：

```yaml
  currency-service:
    build: { context: ., dockerfile: Dockerfile.currency-service }
    image: ${IMAGE_PREFIX:-pokergame}-currency-service:${IMAGE_TAG:-latest}
    container_name: ftl-currency-service
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    expose: ["3004", "3104"]        # 指标 9004 不进 expose（照 9000–9006 既形：同网自可达，探针走 exec）
    environment:
      - DB_HOST=mysql
      - DB_PORT=3306
      - DB_USER=root
      - DB_PASSWORD=${DB_PASSWORD:-root}
      - DB_NAME=${DB_NAME:-fight_the_landlord}
      - REDIS_URL=redis://redis:6379
      - RPC_PORT=3104
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}        # 无默认值——fail-closed（照 config）
      - CURRENCY_RECONCILE_INTERVAL_MS=${CURRENCY_RECONCILE_INTERVAL_MS:-}   # 空=未设（测试注入面；生产不设——⚙️5）
    depends_on: { mysql: { condition: service_healthy }, redis: { condition: service_healthy } }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3004/api/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 10s
    networks: [ftl-platform]
```

**dev 形态（override）**：只发布 `"3104:3104"`（conformance TCP 直投依赖；HTTP 3004 不发布——一律经网关，照 config-service 同规）+ `INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}`。

### 2.2 协议层 `packages/protocol/src/currency.ts`（唯一真源，写死导出面）

```ts
export const CURRENCY_SOURCES = ['signup_grant', 'admin_adjust'] as const;  // ②/支付片在此扩容（allowlist 单点）
export type CurrencySource = (typeof CURRENCY_SOURCES)[number];
export const CURRENCY_OWNER_TYPES = ['user', 'robot'] as const;
export type CurrencyOwnerType = (typeof CURRENCY_OWNER_TYPES)[number];

export interface CurrencyEntryIn { ownerId: string; ownerType?: CurrencyOwnerType; delta: number }
export interface CurrencyApplyRequest {
  actionId: string; source: string; entries: CurrencyEntryIn[];
  actor?: string; reason?: string; refId?: string; meta?: RpcMeta;
}
export interface CurrencyApplyData {
  opId: number; actionId: string;
  entries: Array<{ ownerId: string; balanceAfter: number }>;   // 按 ownerId 升序（⚙️3）
  replayed: boolean;
}
export type CurrencyApplyResponse = RpcResult<CurrencyApplyData>;
export interface CurrencyGetRequest { ownerIds: string[]; meta?: RpcMeta }
export interface CurrencyGetData { balances: Array<{ ownerId: string; balance: number; exists: boolean }> }
export type CurrencyGetResponse = RpcResult<CurrencyGetData>;

export function normalizeOwnerType(v: unknown): CurrencyOwnerType;   // 缺省（undefined）⇒ 'user'；其余非法 ⇒ 抛
export function validateCurrencyApply(req: unknown): void;           // 唯一校验点（抛 ProtocolError · 中文原因）
export function validateCurrencyGet(req: unknown): void;
export function currencyApplyHash(input: {                          // 规范化形态 = ⚙️2（actionId 不参与）
  source: string; entries: CurrencyEntryIn[]; actor?: string; reason?: string; refId?: string;
}): string;                                                          // sha256 小写 hex、定长 64
```

**禁双份实现**：服务端与调用方共用本文件；`RPC_PATTERNS` 追加 `currencyApply`/`currencyGet`（pattern 名逐字：`'currency.apply'` / `'currency.get'`）。

### 2.3 RPC `currency.apply`（唯一写边）

**请求字段表**（+ `meta?: RpcMeta`，发送侧 `...metaFromTrace()`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `actionId` | string | ✓ | 非空、≤128；**服务端不做格式白名单** | 幂等锚；唯一性由 `uk_action_id` 兜底。调用方约定形状（设计 §5.1）：`signup:<userId>` / `admin:<uuid>` / ② `settle:<gameId>` / 支付片 `pay:/refund:<orderId>` |
| `source` | string | ✓ | ∈ `CURRENCY_SOURCES`（本片 = `signup_grant` \| `admin_adjust`） | allowlist 单点扩容 |
| `entries` | array | ✓ | **1..20** 条；同批 `ownerId` 不得重复 | 服务端按 ownerId 升序执行 |
| `entries[].ownerId` | string | ✓ | 1..36 字符；字符集 `[A-Za-z0-9_-]` | user.id(uuid) / 未来 robotId |
| `entries[].ownerType` | `'user'\|'robot'` | ✗ | 缺省归一 `'user'`；**参与指纹** | 首写固化，不可变（⚙️1） |
| `entries[].delta` | int | ✓ | ≠0；\|delta\| ≤ **1,000,000** | 正=入 负=出 |
| `actor` | string | ✗ | `admin_adjust` 必填；≤64 | 本片固定 `'admin'` |
| `reason` | string | ✗ | `admin_adjust` 必填；≤255（列宽） | 管理面词条 |
| `refId` | string | ✗ | ≤128 | 业务关联（② 对局 ID） |

**响应**：`RpcResult<CurrencyApplyData>`；`data.opId: number`（bigint 列读出转 number——⚙️6）、`data.entries` 按 **ownerId 升序**、`data.replayed: boolean`。业务错误**不抛**、走信封 `{ok:false, code, message}`（`record.rpc.controller` 先例）；传输故障才抛 + 调用方映射 **10007**。

**判定算法（写死；单事务，条目按 ownerId 升序）**：

1. 事务**首步**：`INSERT INTO currency_ops (action_id, request_hash, source, actor, reason, ref_id, trace_id) VALUES (…)`（request_hash = `currencyApplyHash()` 产物）。
   - **命中 `uk_action_id`**（重放/并发撞键）⇒ **事务整体回滚** ⇒ 转「重放判定」。
2. 逐 entry（本事务内）：
   - **a. 类型闸（⚙️1）**：`SELECT owner_type FROM currency_accounts WHERE owner_id = :id` —— 行在且 ≠ 归一化 ownerType ⇒ **10001**（整批回滚 + 响亮 error 日志）。
   - **b. 余额步（设计 §5.3 三步逐字）**：`UPDATE currency_accounts SET balance = balance + :delta WHERE owner_id = :id AND balance + :delta >= 0`；`affectedRows = 1` ⇒ 成功。
     `affectedRows = 0` ⇒ `INSERT IGNORE INTO currency_accounts (owner_id, owner_type, balance) VALUES (:id, :归一化OwnerType, 0)`（消化「行不存在」与「并发首建」二义；**不改写既有行** ⇒ 首写类型固化）——**判读其受影响行数（⚙️12）**：0 ⇒ 行已存在（可能是并发他人首建的）⇒ **先重查 `owner_type` 一致性**（异型 ⇒ 10001）⇒ **重试本步一次**；仍 0 ⇒ **14001**（整批回滚）。
   - **c. 快照**：`SELECT balance FROM currency_accounts WHERE owner_id = :id`（同事务读自身未提交写值）⇒ 该条 `balanceAfter`。
3. `INSERT INTO currency_flows` 逐条（`op_id, owner_id, owner_type, delta, balance_after`）⇒ 提交。
4. **提交后**写穿缓存（§2.11）：失败**不回滚**（权威值在 MySQL 与响应里）。

**重放判定（新事务）**：读 `currency_ops WHERE action_id = :actionId` 比对 `request_hash` —— 相同 ⇒ 按 `SELECT owner_id, balance_after FROM currency_flows WHERE op_id = :opId ORDER BY owner_id` 重建响应（`replayed:true`）；不同 ⇒ **14002**（`{ok:false}` + 响亮 error 日志——「同 id 不同内容」永远是人祸，不静默）。**不复用原事务连接/快照**（REPEATABLE READ 下原事务可能读不到并发已提交行）；并发撞键的锁等待窗口由调用方 **3s 超时**纪律兜底。

**request_hash 规范化（⚙️2，逐字节）**：`sha256` 的输入 = `JSON.stringify` 下列对象（键序固定）：
`{ source, entries: [{ownerId, ownerType, delta}, …]（按 ownerId 升序；ownerType 为归一化值、永不省略）, actor: actor ?? null, reason: reason ?? null, refId: refId ?? null }`；输出**小写 hex、定长 64**。actionId 不参与。

**校验失败** ⇒ `{ok:false, code:10001, message:中文原因}`（与 `parseConfigValue` 同口径）。

### 2.4 RPC `currency.get`（读）

请求 `{ ownerIds: string[1..50] }`（逐条同 §2.3 的 ownerId 约束；**允许重复**——响应与请求**同序一一对应**）。响应 `RpcResult<{ balances: [{ownerId, balance, exists}] }>`：缓存优先（`currency:balance:<id>` 命中即回）、miss 回源 MySQL 并**写缓存**（读穿）；`exists=false` ⇒ `balance:0` 且**不写缓存**（⚙️15：写 0 会让对账检查 2 把读穿自造键判成漂移；本片代码注释 + 断言在 `test/get.test.ts`）；**读路径不建行**（不产垃圾行）。读**永不裁决钱**（裁决只在 §2.3 算法）。

### 2.5 玩家 REST（经网关，JWT 身份头 `X-User-Id` 由网关注入——照 `/api/records/mine` 模式）

| 方法路径 | 入参 | 响应（`{code:0,data:…}`） | 错误 |
|---|---|---|---|
| `GET /api/wallet/balance` | 无（**userId 只取 `X-User-Id`，禁止任何「查谁」参数**） | `{ balance: number }` | 缺 `X-User-Id` ⇒ 10002/401 |
| `GET /api/health`、`GET /api/health/live` | 无 | 健康面（内部 token 豁免面既有形状） | — |

### 2.6 管理 REST（经网关 admin 中间件，`X-Admin: 1` 由网关注入；currency 侧 = `XAdminGuard` 照抄 config-service 的 fail-closed 小守卫）

| 端点 | 入参 | 成功 data | 错误映射 |
|---|---|---|---|
| `POST /api/admin/wallet/adjust` | body `{ userId: string(1..36, 字符集同 §2.3), delta: int(≠0, \|d\|≤1,000,000), reason: string(1..200) 必填, actionId?: string(非空≤128) }` | `{ balanceBefore, balanceAfter, opId }` | 10001→**400**；**14001→409**；**14002→409**；同 id 同载荷重放 ⇒ **200** + 原值重建（opId 自 ops、balanceBefore = balanceAfter − delta 自 flows）；**不允许扣成负数**（管理员也不行，14001） |
| `GET /api/admin/wallet/accounts/:userId` | path userId | `{ balance: number, recentFlows: Array<{ delta, balanceAfter, source, reason, createdAt }> }`（**≤20 条、`id DESC`（新→旧）**；`createdAt` = epoch ms；`reason` 可 null；**JOIN ops** 取 source/reason——两字段在 op 级） | 未开户 ⇒ **200** `{balance:0, recentFlows:[]}`（⚙️7） |
| `GET /api/admin/users/lookup?phone=`（**在 user-service**） | query `phone` | `{ userId }` | 未找到 ⇒ 404+11004；缺失/非法 ⇒ 400+10001（⚙️7） |

**读源纪律**：`accounts/:userId` **读源 = MySQL 直读**（绕过 Redis，避开写穿窗口旧值；「发放后当场核对」的可用性前提）。**adjust 的 apply 映射**：source=`admin_adjust`、actor=`'admin'`、refId=null、entries=[{ownerId:userId, delta}]、actionId = body.actionId ?? `admin:${randomUUID()}`。

### 2.7 注册赠送链路（J5/D4；**金额为 0 时一步都不进货币服务**）

```
register(phone, pwd):
  1. 校验/重复预检（既有逻辑）；userId = uuid（既有生成点）
  2. grant = configCache.signupGrant()        # user-service 配置缓存新 getter；缺失/坏值 → 0
  3. if grant > 0:
       currency.apply{ actionId:'signup:<userId>', source:'signup_grant',
                       entries:[{ownerId:userId, delta:grant}], refId:userId }   # 3s 超时
       — 任何失败（业务码/传输）⇒ 注册整体失败：HTTP 503 + 10007 信封（⚙️8），本地零行，重试干净
  4. tx: 写入 users 行（既有事务）
```

- **顺序 = 先货币后落库**；半程失败只遗留「孤儿钱包」（R1 登记的已知残余，有指标可观测，不做自动回收）。
- **重试幂等**：`signup:<userId>` 恒定 ⇒ 任何重发不重复发币（`uk_action_id` 兜底）。
- **快照语义**：金额在步骤 2 读取一次并随调用固化；此后改配置**只影响新注册用户**（J5 原文）。
- 客户端文件 = `src/currency/currency.client.ts`：`timeout(3000)`、`...metaFromTrace()`、**不重试**、传输失败 ⇒ 固定文案 + `CurrencyServiceError(10007)`（照 `config.client.ts` 逐条形态）。

### 2.8 配置第 11 键

| 键 | 类型/范围 | 默认 | 客户端可见 | 消费方 |
|---|---|---|---|---|
| `currency.signupGrant` | int、`0 ≤ n ≤ 1,000,000`（协议层 `parseConfigValue` 校验，抛中文原因） | **0** | **否**（服务端专用，不经 `/api/config`；`CLIENT_CONFIG_KEYS` 三键不变） | user-service 配置缓存新 getter（缺失/坏值回落 0） |

**同步面（全列）**：`protocol/src/config.ts`（CONFIG_KEYS + parse 分支）+ config-service 种子迁移 `1789700000000-SignupGrant.ts`（照 `1789500000000-RecordRetention.ts` 形状：`INSERT ('currency.signupGrant','0',1,NOW(3),'seed')`；down = DELETE 该键）+ `config.test.ts` 十键→十一键 + **config-service 测试族五处**（既有三处：`test/platform-config.service.test.ts:224-225`、`test/helpers/config-probe.ts:95`、`test/admin.controller.test.ts:172-186`——不随改必红；第四处 `test/client-config.test.ts:65-77` 的「不泄漏内部键」名单加 `currency.`——不加不红 = 静默失明；**第五处 `test/config.rpc.test.ts:54-67`**——T2 实施期发现，不加必红）+ `admin/app.js` CONFIG_NOTES + `docs/ops/first-deploy.md` 十键表→十一键表 + `docs/design.md` §7.5。（② 的场开关 = 第 12/13 键，留 ②。）

### 2.9 错误码（14xxx 启用两条）

| 码 | 名 | 含义 | HTTP | CLIENT_ACTION |
|---|---|---|---|---|
| 14001 | `E_INSUFFICIENT_FUNDS` | 余额不足（整批回滚） | 409 | **映射既有 `ClientAction.TOAST`**（文案走 `message`；② 消费） |
| 14002 | `E_ACTION_CONFLICT` | actionId 冲突（同 id 不同载荷） | 409 | **映射既有 `ClientAction.TOAST`** |

**同步面（全列）**：`errors.ts` 枚举 + `ClientAction` 枚举 + `CLIENT_ACTION` 映射 + `errors.test.ts` SPEC_CODES + `docs/design.md` §11.2 表（注释明写「两侧必须同改」）+ **currency-service `http/errors.ts` 的 HTTP_STATUS 表补 14001/14002→409**（每服务各一份、`?? 500` 兜底——不补则 409 静默变 500）+ 一条盯映射表的单测 + **`docs/client-protocol.md` §7 表 +2 行与计数表头**（**`apps/client/test/protocol-doc-sync.test.ts` 双向闸**：文档码集 == `ErrCode` 码集，CI stage 4/6 覆盖 apps/client——不随改 **push 必红**；T2 审查实证，§4.1 #26）。

### 2.10 三表最终 DDL（迁移语义）

**迁移文件**：`packages/currency-service/src/migrations/1789600000000-Currency.ts`，类名 `Currency1789600000000`、`name` 属性同名；up 依序建三表、down 逆序 DROP；全部 `CREATE TABLE IF NOT EXISTS`；**迁移表 = `migrations_currency`**（⚙️9）；`migrationsRun: true`（照 config/user 先例）。表头注释写明：编号口径、currency_ 前缀防撞名、写入者建行/读不建行。

```sql
CREATE TABLE IF NOT EXISTS `currency_accounts` (              -- 账户（余额物化行）
  `owner_id`   varchar(36) NOT NULL,                          -- user.id(uuid) / 未来 robotId
  `owner_type` varchar(8)  NOT NULL DEFAULT 'user',           -- 'user' | 'robot'；首写固化不可变
  `balance`    int         NOT NULL DEFAULT 0,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `currency_ops` (                   -- 操作（幂等锚）：一次 apply = 一行
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `action_id`    varchar(128) NOT NULL,
  `request_hash` char(64)     NOT NULL,                       -- sha256 小写 hex（⚙️2）
  `source`       varchar(32)  NOT NULL,                       -- allowlist
  `actor`        varchar(64)  NULL,                           -- admin_adjust 必填（本片='admin'）
  `reason`       varchar(255) NULL,                           -- admin_adjust 必填
  `ref_id`       varchar(128) NULL,
  `trace_id`     varchar(64)  NULL,
  `created_at`   datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_action_id` (`action_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `currency_flows` (                 -- 流水（永不清洗；只增不改）
  `id`            bigint      NOT NULL AUTO_INCREMENT,
  `op_id`         bigint      NOT NULL,
  `owner_id`      varchar(36) NOT NULL,
  `owner_type`    varchar(8)  NOT NULL DEFAULT 'user',
  `delta`         int         NOT NULL,                       -- 正=入 负=出
  `balance_after` int         NOT NULL,
  `created_at`    datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_flow_owner` (`owner_id`, `id`),
  KEY `idx_flow_op` (`op_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

约定（设计 §3 逐条承接）：金额 `int`（本片金额不做 bigint；单笔上限由 §2.3 校验约束）；时间 `datetime(3)`；wire 一律 epoch ms；现有用户**无迁移、不补发**；**流水永久保留**（与对局记录 365 天保留期相反，明确区分）；`COLLATE=utf8mb4_0900_ai_ci` 随既有表模板（设计 DDL 草案未写——排版面非语义面，进 JOIN 的 owner_id 与 users.id 同口径）。

### 2.11 Redis 契约（只做读加速，永不参与写决策）

| 项 | 写死 |
|---|---|
| 键 | `currency:balance:<ownerId>`（⚙️4） |
| 值 | 余额的十进制整数字符串（如 `"250"`） |
| TTL | **无**（失效只由写穿覆盖与对账自愈负责） |
| 写穿 | apply **提交后**逐条 SET；失败 ⇒ 不回滚 + level=warn 日志 + `currency_reconcile_cache_drift_total` inc（best-effort；权威值在 MySQL 与调整响应里） |
| 读穿 | `currency.get` / REST 未命中 ⇒ 回源 MySQL 并 SET |
| 自愈 | 对账检查 2 发现漂移 ⇒ DEL 键（下读回源） |
| 裁决 | **读永远不裁决钱**；扣款够不够只由 §2.3 的 SQL 条件更新裁决 |

### 2.12 对账自调度循环 / 指标 / 日志

**循环**：照 `records-cleanup.service.ts` 的 setTimeout 自重排 + 关停闸（串行无重入）；间隔 env `CURRENCY_RECONCILE_INTERVAL_MS`，未设/空串 ⇒ **3600000**（1h）；**启动后 10s 首跑**；注入链 = compose 空默认透传行（§2.1，⚙️5）。

**三检查（⚙️5，判定写死）**：

| # | 检查 | 判定（写死） | 动作 |
|---|---|---|---|
| 1 | 账实相符 | **单条 SQL**：`SELECT a.owner_id, a.balance, COALESCE(f.total,0) FROM currency_accounts a LEFT JOIN (SELECT owner_id, SUM(delta) total FROM currency_flows GROUP BY owner_id) f ON f.owner_id = a.owner_id WHERE a.balance <> COALESCE(f.total,0)`（单语句自有 InnoDB 一致快照——分读会与并发 apply 交错造成**假漂移**） | 每行 level=error 日志（含 ownerId / 两值 / 差）+ `currency_reconcile_drift_accounts` set = 行数；**不自修**（钱的事只报不改，人工裁决） |
| 2 | 缓存一致性 | `SCAN currency:balance:*`（游标循环）逐键：GET 值 vs MySQL 余额（**账户不存在也算漂移**）；「MySQL 有而缓存缺」**不算** | 不等 ⇒ DEL 键 + `currency_reconcile_cache_drift_total` inc（自愈，下读回源） |
| 3 | 孤儿赠送（诊断、只读） | `SELECT COUNT(DISTINCT f.owner_id) FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id LEFT JOIN users u ON u.id = f.owner_id WHERE o.source = 'signup_grant' AND u.id IS NULL` | `currency_orphan_signup_grants` set = 计数；>0 记日志 |

**指标（7 条；shared `metricsRegistry()` 系构造器）**：

| 指标 | 类型 | 标签 | 语义 |
|---|---|---|---|
| `currency_apply_total` | counter | `source`（allowlist 值域）· `result∈{ok,replay,reject}` | 每次 `currency.apply` 调用 +1（含重放与拒绝） |
| `currency_apply_entries_total` | counter | — | 仅**写成功**（replayed:false）批按 entries 条数累加 |
| `currency_reconcile_runs_total` | counter | — | 每轮**开始** +1 |
| `currency_reconcile_last_success_timestamp_seconds` | gauge | — | **启动置 0**；一轮三检查**无异常执行完** set = epoch 秒（漂移是「检查结果」不算失败；查询抛错 ⇒ 不 set） |
| `currency_reconcile_drift_accounts` | gauge | — | 每轮 set = 账实不符账户数（0 = 健康） |
| `currency_reconcile_cache_drift_total` | counter | — | 缓存漂移删除 + 写穿失败（两处同一计数器） |
| `currency_orphan_signup_grants` | gauge | — | 每轮 set = 孤儿赠送账户数（COUNT DISTINCT） |

HTTP 中间件 `createHttpMetricsMiddleware()` 照挂；告警规则本片**不加**（指标就位；规则待 ② 资金流动真实发生前同批加——届时注意监控片资产计数）。

**日志（九字段 NDJSON 既有形状；traceId 随 meta）**：apply 成功/重放/拒绝（拒绝行含 actionId 与错误码——`owner_type_mismatch` 与 14002 均响亮 level=error）；reconcile 漂移逐行（level=error，含 ownerId/两值）；孤儿计数>0；写穿失败（level=warn，`cache_write_failed`）。

### 2.13 网关与 env 清单

**网关新路由（显式逐条；`admin/*` 既有各条都指 config ⇒ 新增显式分支，无通配遮蔽）**：

| 方法路径 | 转发 | 守卫 |
|---|---|---|
| `@Get('wallet/balance')` | `forwardToCurrencySvc('GET','/api/wallet/balance',null,res,headersOf(req))` | 默认验签（**不进公开白名单**）；网关注入 `X-User-Id`/`X-Internal-Token` |
| `@Post('admin/wallet/adjust')` | currency（body 透传） | admin 中间件（`x-admin` 注入） |
| `@Get('admin/wallet/accounts/:userId')` | currency | 同上 |
| `@Get('admin/users/lookup')` | `forwardToUserSvc(… '/api/admin/users/lookup' …)`（query 透传照 R75 纪律） | 同上 |

`ProxyGateway` 新方法 = `forwardToCurrencySvc`（照 `forwardToUserSvc` 形状，URL = `process.env.CURRENCY_SERVICE_URL ?? 'http://localhost:3004'`）。

**env 清单**：

| env | 归属 | 代码默认 | compose 显式值 | 同步面 |
|---|---|---|---|---|
| `CURRENCY_SERVICE_URL` | api-gateway | `http://localhost:3004` | `http://currency-service:3004` | `docs/design.md` §2.3 env 表 + `design-md-ai-rollout.gate.test.ts` NEW_ENVS（§4 #16） |
| `CURRENCY_SERVICE_RPC_HOST` / `CURRENCY_SERVICE_RPC_PORT` | user-service | `currency-service` / `3104` | 显式同值两行 | 命名照 `config.client.ts:58-59` 先例（§4 #23） |
| `CURRENCY_RECONCILE_INTERVAL_MS` | currency-service | 未设 ⇒ 3600000 | `${…:-}` 空透传 | 测试注入面；生产不设 |

### 2.14 管理页表单（`admin/app.js` 新 section「钱包调整」；样式随既有页面）

契约要点：① 手机号 → `GET /api/admin/users/lookup?phone=` ⇒ 显示 userId（未找到 ⇒ 回显「未找到」）；② 查 `GET /api/admin/wallet/accounts/:userId` ⇒ 显示当前余额；③ 填 ±金额（≠0、\|±\|≤1,000,000）+ 原因（1..200）→ `POST /api/admin/wallet/adjust`；④ **actionId 每次填一个表生成一次**（`admin:<uuid>`）并在**重试时原样复用**（双击保护），成功或明确失败后换新；⑤ 只按 HTTP status 分流（M1 纪律照抄——**绝不读 body.code**）；409 回显服务端 message（14001/14002）；⑥ 成功 ⇒ 显示「调整后余额」并刷新 ②。**③ 在此升级为财务后台，不推倒**（设计 §4.6）。

---

## 3. 判据（C1–C21；载体 = conformance `slice-17-currency` / 既有闸 / 单测 / 手工核销，全部同提交）

| # | 判据（一句话） | 载体（验证方式） | 源 |
|---|---|---|---|
| C1 | 服务骨架与三端口：容器起得来、`/api/health` 与 `/api/health/live` 200、9004 无 Bearer 401 / 带 Bearer 200 且含 `http_requests_total`、3104 RPC 宿主直投可通、未配 INTERNAL_SERVICE_TOKEN ⇒ 拒起 | conformance 断言（exec 探针 + rpcCall）+ 单测（骨架/守卫）+ 既有闸（§4 #13/#2） | §1.1.1/§2/§9.3 |
| C2 | 三表与迁移：首启后 `currency_accounts/ops/flows` 存在，**逐列/逐索引/唯一键**与 §2.10 一致（`uk_action_id`、`idx_flow_owner`、`idx_flow_op`）；`migrations_currency` 有 1 行（`1789600000000-Currency`） | conformance 断言（exec mysql 逐项）+ 单测（迁移形状，照 `migration.test` 先例） | §3 |
| C3 | 建行/不建行：首写自动建账户行（balance 0 → 改）；`currency.get` 与玩家 REST 查询**不建行**（前后行数不变） | 单测 + conformance 断言 | §3 |
| C4 | apply 幂等重放：同 actionId 同载荷重发 ⇒ `replayed:true`、`opId`/`balanceAfter` 与首发一致、ops/flows 行数不变、不重复入账 | conformance 断言（RPC 直连 ×2 + 库行计数）+ 单测 | §4.3/§5.2 |
| C5 | apply 冲突 14002：同 actionId 异载荷（改 delta 或 ownerType）⇒ `ok:false, code=14002`；库行数与余额不变；error 日志含 actionId | conformance 断言 + 单测 | §5.2 |
| C6 | apply 批量原子 + 防负 14001：多账户批成功 ⇒ 同一 op_id 多行 flows；任一 entry 不足 ⇒ **整批回滚**（批内其他账户零变化）+ 14001 | conformance 断言 + 单测 | §4.3/§5.3 |
| C7 | 并发无负：**真栈**并行 N 扣减（RPC 直投 burst）⇒ 终止余额 = 初值 − 成功笔数×单额、全程无负 | **slice-17 并发 burst 组（主载体）** + 单测（覆盖逻辑路径；**假 DB 不证原子性**——仓内先例教训「假 Redis 证不了原子性」） | §5.3 |
| C8 | 入参校验矩阵 + ownerType 不可变：source allowlist / delta≠0 与上限 / entries 1..20 / 重复 ownerId / ownerId 字符集与长度 / actionId 非空≤128 / admin_adjust 必填 actor·reason —— 全部 10001；ownerType 与既有行不一致 ⇒ 10001 + 响亮日志；校验函数唯一实现 = `protocol/src/currency.ts` | 单测（protocol + currency-service 矩阵）+ conformance 断言（负例抽样） | §5.4/⚙️1 |
| C9 | get 语义：1..50、与请求同序、缓存优先、miss 回源并写缓存、`exists=false` ⇒ 0、不建行 | 单测 + conformance 断言（RPC 直连） | §4.3 |
| C10 | 玩家 REST：经网关新用户 `GET /api/wallet/balance` ⇒ `{balance:0}`；调整后 ⇒ 新值；缺/伪造身份头打不进 | conformance 断言（经网关） | §4.1 |
| C11 | 管理 REST 三端点：adjust 成功（balanceBefore/After/opId、actor=`admin`+reason 落 ops 留痕）、同 actionId 重发 ⇒ 同 opId 不重复；14001 ⇒ **409**；`accounts/:userId` MySQL 直读（写穿窗口内取真值）含 `recentFlows` ≤20 条倒序（JOIN ops 带 source/reason）；`users/lookup` 命中/404+11004 | conformance 断言 + 单测（控制器层 + HTTP_STATUS 映射） | §4.2 |
| C12 | 管理页表单：section 存在且调用三端点；真浏览器一次「查询→显示余额→发放→余额变化→同 actionId 重试不变→扣减」 | 手工核销 + 静态断言（页面含 section 与端点调用） | J6/§4.6 |
| C13 | 注册赠送两态：`signupGrant=0`（默认）⇒ 注册**零货币痕迹**（无 ops/flows 行）；注入 >0 ⇒ 注册后余额 = grant、ops 1 行 `source='signup_grant'`；改回 0 后**已注册用户不受影响**（快照）；`signup:<userId>` 重放不重复发。**两处读法钉死**：①「零痕迹」按**该 userId** 判（不按全局计数——同片前组已造行）；②等待缓存刷新以 `config snapshot applied (version=…)` 行为观测量 | conformance 断言（管理面改键注入）+ user-service 单测 | J5/§4.4 |
| C14 | 第 11 键全同步面：CONFIG_KEYS 十一键 + parse 校验（`0..1,000,000` int）+ 种子迁移 + 三处测试族字面量 + CONFIG_NOTES + 手册键表 + design §7.5；**客户端不可见**（`/api/config` 键集不变） | 单测 + 既有闸（config.test 等）+ conformance 断言（`/api/config` 负对照） | §6 |
| C15 | 错误码两侧：ErrCode/ClientAction/CLIENT_ACTION/SPEC_CODES/design §11.2/currency `HTTP_STATUS`（14001/14002→409 + `?? 500` 兜底）+ 映射表单测 | 单测 + 既有闸（errors.test） | §8 |
| C16 | reconcile 三检查双向：注入短间隔 ⇒ runs ≥2 轮、last_success 前进；构造账实漂移 ⇒ error 日志 + gauge=1、**不自修**（修回后归零）；构造缓存漂移 ⇒ 键被删 + counter；孤儿 ⇒ gauge；7 条指标名齐 + prometheus **14/14 up** | conformance 断言（注入两向 + prometheus API）+ 单测 | §7/§10 |
| C17 | 编排/监控/端口闸群（§4 #1–#6、#20–#22）：build 服务 12→13、TOKEN_SERVICES +1、EXPECTED_JOBS 13→14、NEST_TARGETS +`currency-service:9004`、conformance-stack SERVICES 12→13、prometheus.yml 注释与 job、RPC_PORTS +3104、`:908-915`/rpc 端口清单、hardening 出站扫描面 +currency、override `3104:3104` | 既有闸（逐条见 §4） | §9.1 |
| C18 | 契约/结构闸群（§4 #7–#16、#18、#19、#23）：config 十一键、messages pattern 10→12、SPEC_CODES、robot-availability-wiring 接收侧（控制器+模块注册同提交）、meta-on-every-rpc-send 新发送边、no-internal-http 扩面（正负探针）、no-raw-console 两处、Dockerfile 双闸、service-name 闸（+名单订正）、脚手架、NEW_ENVS、container-assembly（+补 config-service）、outbound-timeout（PKGS +currency）、env 命名先例 | 既有闸（逐条见 §4） | §9.1/§9.3 |
| C19 | 计数/文案/注记（§4 文案行 a–k 全部）：镜像/容器/切片计数、design.md 注记翻转、roadmap 回填、metrics-listener「七份」、design.md:1439 订正——**逐条 grep 核销** | 手工核销（同提交清单） | §9.2 |
| C20 | slice-17 登记与基线：`run.ts` CASES 末尾追加、`baselines.json` full 新行（本机确定性读数先填）、`--list` 全序含新片 | 台账 + CI | §9.1 #17 |
| C21 | 全序 conformance **22 片**全绿 + CI 三 workflow 三绿（含 render gate） | CI / 本机全序 | §10 A11 |

---

## 4. 既有判据同步清单（设计 §9 逐条核销；**同提交**；实现期先全仓 grep 再动）

> 编号照设计 §9 原号（便于与设计对照）。凡「恰好 N」的断言，改数字必须同提交改断言本体。

### 4.1 硬闸（§9.1）

| # | 资产（锚点） | 动作 |
|---|---|---|
| 1 | `slice-07.2-deploy.ts:564,571`（`BUILD_SERVICES` 恰 12） | →13（+`currency-service`；注释同改） |
| 2 | 同上 `:131` `TOKEN_SERVICES`（现 9 项） | +`currency-service`（每服务含 `INTERNAL_SERVICE_TOKEN` 渲染断言） |
| 3 | `slice-16-monitoring.ts:81` `EXPECTED_JOBS`（恰 13 逐名） | →14（+`currency-service`） |
| 4 | 同上 `:96-102` `NEST_TARGETS`（六 Nest） | +`{ name:'currency-service', container:'ftl-currency-service', port:9004 }`（**七端口**） |
| 5 | 同上 `:113`、`:1175-1178` `EXPECTED_SERVICES`（恰 12） | →13；`scripts/deploy/conformance-stack.sh:22` `SERVICES` 数组同改（否则 retag 环漏镜像） |
| 6 | `deploy/monitoring/prometheus/prometheus.yml:4,16-41` | 头注释「13 个 job」→14 + +1 job（Bearer `credentials_file` 同形） |
| 7 | `protocol/src/config.test.ts:10-18`（十键硬编码 + 三键子集） | →十一键（子集不变） |
| 8 | `protocol/src/errors.test.ts:8-14` `SPEC_CODES` | +14001/14002 |
| 9 | `protocol/src/messages.test.ts:45-60`（10 条 pattern 名逐字钉） | →12（+`currency.apply`/`currency.get`） |
| 10 | `robot-availability-wiring.gate.test.ts:205-223`（`RPC_PATTERNS` 键集 = 全仓 `@MessagePattern` 键集） | currency 接收控制器 + 模块注册（**同提交**） |
| 11 | `meta-on-every-rpc-send.gate.test.ts`（`PACKAGES:58-66`） | user→currency 新发送边；核销新客户端文件在扫描面内（不在 ⇒ 扩 PACKAGES） |
| 12 | `no-internal-http.gate.test.ts:89,100-119`（扫描面 = room/game 客户端） | 把 user-service 货币客户端文件**扩入扫描面**并登记探针**正负两行**；**勿**往 room 清单塞 user 文件 |
| 13 | `no-raw-console.test.ts:22-30,70-71` | +currency `main.ts`；**ALLOWED 白名单与扫描包清单两处都加**（只加一处 = 静默失明） |
| 14 | `dockerfile-workspace-copy.gate.test.ts:153-187` + `dockerfile-patches-copy.gate.test.ts` | 新 `Dockerfile.currency-service` 逐行对账（照 config-service 模板；**patches 拷贝面逐行核对**） |
| 15 | `service-name.gate.test.ts` | `@fight-the-landlord/currency-service` 逐字；**顺带钉正陈旧 5 服务名单**（config-service 缺席 = 闸失明） |
| 15b | 新包脚手架 | 照 `packages/config-service` 模板：package.json（短名/scripts build·test·lint·dev·migration:*）、tsconfig extends 根、vitest.config；`turbo.json` 任务面随 workspace glob 自动覆盖（免改） |
| 16 | `design-md-ai-rollout.gate.test.ts:84-90` NEW_ENVS | +`CURRENCY_SERVICE_URL`（`docs/design.md` §2.3 同改） |
| 17 | conformance 登记 | `run.ts:41-66` CASES + `baselines.json`（§7） |
| 18 | `api-gateway/test/container-assembly.gate.test.ts:36-72`（5 服务清单） | +currency-service；**顺带补 config-service**（补闸失明） |
| 19 | `api-gateway/test/outbound-timeout.gate.test.ts`（PKGS:9） | +`currency-service` 入包清单；user-service 新货币客户端带 `timeout(3000)` |
| 20 | `slice-07.2-hardening.ts:966`（出站扫描 `pkgs` 清单 + RPC/端口硬化面） | +`currency-service`；新端口 3104/9004 入列看齐 |
| 21 | `slice-07.2-deploy.ts:151-155`（`RPC_PORTS` 表）+ `:908-915`（开发形态按表发布端口）+ `slice-07.2-rpc.ts:952-959`（三条 RPC 端口清单） | +`'currency-service':'3104'`（三处同改） |
| 22 | `docker-compose.override.yml` | +`"3104:3104"`（先例 :45,49,97；slice-17 的 RPC 直投判据依赖它） |
| 23 | `packages/user-service/src/config/config.client.ts:58-59`（命名先例） | 新客户端 env = `CURRENCY_SERVICE_RPC_HOST/PORT`（默认 `currency-service`/`3104`；连同 §2.13 的 HTTP URL） |
| 24 | `slice-07.4-pipeline.ts:954-961`（`buildServices()` 派生自 compose 带 `build:` 服务，**恰 12**） | **→13**（T1 加 compose 块即红；合并评审 🔴1 补入） |
| 25 | `slice-07.2-deploy.ts:967-975` `LOG_LIMIT_TARGETS`（日志上限判据的容器清单） | +`ftl-currency-service`（不加不红 = 静默失明；监控片 +6 先例） |
| 26 | `apps/client/test/protocol-doc-sync.test.ts:74-119`（双向：文档码集 == `Object.values(ErrCode)`；CI stage 4/6 覆盖 apps/client） | 错误码增删必须同提交同步 `docs/client-protocol.md` §7 表 + 计数表头（不随改 **push 必红**；T2 审查发现，原清单外第 7 处错误码同步点——修复见提交记录） |

### 4.2 计数/文案（§9.2；人工同步，防文档谎报）

| # | 资产 | 动作 |
|---|---|---|
| a | `scripts/deploy/build-images.sh:2,32` 「12 个自建镜像」；`.github/workflows/conformance.yml:4` 注释 | →13 |
| b | `docker-compose.yml:8-15` 头注释容器数（9/10/15/16） | 全 **+1** |
| c | `docs/ops/first-deploy.md:123`（16 容器/12 镜像）、`:380`、`:857` | →**17 容器 / 13 镜像** |
| d | `docs/design.md:159-161`（「9/10 个容器」「8 个自建镜像」已陈旧）→ 订正为真实值；`:1077`、`:1702`、`:1835`、`:1844` 涉及服务数的行同核 | 借本片订正 |
| e | `docs/design.md:81`（「货币系统、充值、提现、对账」在「明确不做」清单） | **翻转**：加 📌 注记（照 `:85` 监控片注记形状：「货币核心已落地（2026-10-0X）……充值/提现见 P2 后续」；日期 = 实施提交日） |
| f | 监控片规格/设计的「六 Nest / 13 job」历史文本 | 以 **⚙️ 回填注记**方式订正（不重写历史） |
| g | release 预算：`images` workflow 首建 **13 镜像**（时间 +1 镜像量级无虞）；`release.yml` job 预算注释同核 | 同提交 |
| h | 切片计数：「21 个切片」→**22**：`docs/ops/first-deploy.md:744,754,790`、`conformance.yml:32`、`scripts/deploy/conformance-stack.sh:60`、`images.yml:31`、`release.yml:43,82` 步骤名内嵌数同核 | 同提交 |
| i | `docs/design.md:1439`（「14xxx 货币（MVP 不用，保留）」） | 订正为「本片启用 14001/14002」 |
| j | `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md:77`（「RBAC+财务后台+审计 actor 与本片同做」与 J1 三步拆分冲突） | 加回填注记（照 design.md 订正先例） |
| k | `packages/shared/src/metrics/metrics-listener.ts:10` 注释「`internal-token.middleware.ts`（五份）」已过时（现确为 5 份，+currency 拷贝后=**六份**） | 随 currency 接入钉正为**六份** |
| l | `docs/design.md:562`「RPC_PATTERNS 总数十个」+ §4.2 签名表（`:421` 起） | 随 T4 改 10→12 + 两条签名行 |
| m | `docs/design.md:177`（RPC_PORT 行）+ `:185/:186/:398`（新边/消费方记账口径）+ **`:580-589` §4.3 超时/重试/降级表 +`currency.apply` 行（T4 审查 🟢-2 补，归 T6）** | +3104；user→currency 边按记录片先例记账 |
| n | 「12 个自建镜像」文字残留：`images.yml:1`、`conformance-stack.sh:67`、`docs/ops/first-deploy.md:773`、**`:806/:810/:855`（T1 审查补：`:855` 与本片刚改的 `:857` 直接打架）** | →13（并入 a/c/h 同批） |
| o | 显示文本/注释清扫（不红但与改后代码矛盾）：`slice-16-monitoring.ts` 的 `:17/:76/:95/:375/:532/:642/:1159`（六 Nest/七目标/13 等）、`protocol/src/config.ts:2`「十键」、`user-service/test/config-cache.test.ts:71`、`tools/conformance/src/lib/http.ts:225` 与 `slice-14:64`「九键」、**`first-deploy.md:616`「六个 Nest」、`slice-07.2-deploy.ts:10/:19` 与 `container-assembly.gate.test.ts:419` 的陈旧「六个服务」注释（T1 审查补）**、**`robot-availability-wiring.gate.test.ts:205` 用例标题与 `no-internal-http.gate.test.ts:36` 注释的「十键」（T2 审查补，归 T4 同改）** | 归 T1（slice-16）、T2（config.ts:2）、**T4（闸内两处）**、T6（config-cache.test）、T10（lib/http、slice-14）、**T11（其余）** |
| p | `docs/design.md` 其余 7 处「十键」陈旧表述（`:141/:398/:482/:489/:1261/:1410/:1869`）→ 十一键；`admin/app.js` CONFIG_NOTES 补 `record.retentionDays` 缺条目（记录片遗留，与 signupGrant 合成 11 条对 11 键）；**陈旧「九键」族全扫（T2 审查补）**：config-service src（`admin.controller.ts:86`、`client-config.controller.ts:17`、`platform-config.entity.ts:10`、`platform-config.service.ts:44,56`）、`admin/app.js:18/153/174`、`admin/style.css:270` 等 | 归 T11（design.md 与九键族）/ T9（CONFIG_NOTES） |

### 4.3 user-service 侧（§9.3）

| # | 项 | 动作 |
|---|---|---|
| US1 | `config-cache.module.ts:12` 注释「本服务只有这一条出站 RPC 边」 | 本片后变**两条**：注释 + `rpc-clients` 装配同改（ClientsModule 第二条 proxy + 包装类，照 room 侧模式） |
| US2 | 注册链路改造点：`users.controller.ts:16` → `AuthService.register` 接入 §2.7；`app.module.ts` 注册面照注（**T6 教训：未注册 = 单测全绿而真容器 404**） | 同提交 |
| US3 | 管理员手机号查询**三件**（无既有闸拦，逐件核销）：user-service 控制器（`GET /api/admin/users/lookup` + `XAdminGuard` 复制件）+ 网关路由（**现 `admin/*` 各条都指 config，需加显式分支**）+ 管理页调用 | 同提交 |
| US4 | currency-service `main.ts` 骨架核销：fail-closed `INTERNAL_SERVICE_TOKEN`、`createRedactingLogger`（短名 = package name 末段）、中间件顺序 trace→metrics→internal-token、`internal-token.middleware.ts` 新拷贝；**`di-type-import-trap` 点名**——要注入的类型必须值导入 | 同提交 |

---

## 5. 验收条目（A1–A11：设计 §10 设计级验收 → 规格级落点）

| # | 验收条目（设计 §10 原文要义） | 规格判据 | 怎么验（谁 / 产物） |
|---|---|---|---|
| A1 | 服务与指标（14/14 up） | C1/C16/C17 | slice-17 + slice-16（EXPECTED_JOBS=14）；prometheus `/api/v1/targets` |
| A2 | 玩家 REST 余额 | C10 | slice-17（经网关） |
| A3 | 管理调整端到端（**含管理页表单**） | C11/C12 | slice-17 + 手工核销（真浏览器一次发放/扣减） |
| A4 | 幂等重放 | C4 | slice-17（RPC 直连 ×2）+ 单测 |
| A5 | 冲突拒绝 | C5 | slice-17 + 单测 |
| A6 | 防负（含并发） | C6/C7 | 单测（并发）+ slice-17 |
| A7 | 批量原子 | C6 | slice-17 + 单测 |
| A8 | 对账自检双向（制造漂移 → 报 / 自愈） | C16 | slice-17（注入两向）+ 单测 |
| A9 | 注册赠送两态（0 绕开 / 非 0 入账 + 幂等） | C13 | slice-17 + 单测 |
| A10 | §9 清单逐条核销 | C17–C19 | §4 表逐行（既有闸 + 手工核销） |
| A11 | 全序 conformance（**22 片**）+ CI 三绿 | C21 | 本机全序 + CI（ci / conformance / images 三 workflow） |

---

## 6. 测试矩阵

### 6.1 单测（用例名级）

**currency-service**（`test/`）：
- `apply.service`：入账（建行）/ 扣账；**重放**（同 id 同 hash ⇒ replayed:true、balanceAfter 与首发一致、不重复入账）；**14002**（同 id 异 hash）；**不足整批回滚**（含批内其他账户零变化）；ownerType 首写固化 + 异型 ⇒ 10001；批量多账户原子（同一 op_id 多行 flows）；balance_after 快照正确；**校验矩阵**（source 非 allowlist / delta=0 / |delta|>1e6 / entries 0 与 21 / 重复 ownerId / ownerId 超长或非法字符 / actionId 空与 129 / admin_adjust 缺 actor·reason）。
- `apply.concurrency`：**假 DB 上只证控制流**（5 条并发分支：条件更新 0 行⇒INSERT IGNORE⇒⚙️12 重查⇒重试恰一次⇒14001 等）；「并行 N 扣减 ⇒ 终止余额 = 初值 − 成功笔数×单额」的**原子性语义由 slice-17 并发 burst 承载**（C7 主载体；⚙️14 后补：异型首写的锁定读防护另加一条假层用例）。
- `get.service`：批量 1..50 / 与请求同序 / 缓存命中 / miss 回源写缓存 / exists=false 且**不建行**。
- `reconcile.service`：构造账实漂移 ⇒ error 日志 + gauge；缓存漂移 ⇒ 删键 + counter；**写穿失败**（注入 SET 抛）⇒ warn + counter；孤儿计数（⚙️10 归位来源）；last_success 启动置 0 与 set；间隔注入与关停闸。
- `main`：fail-closed token；中间件顺序；健康豁免正负（`/api/healthz` ⇒ 401）。
- `http.controller`：`/api/wallet/balance`（缺 X-User-Id ⇒ 10002）；admin adjust（成功/重放 200/**14001→409**/14002→409/校验 400）；accounts 读数与 ≤20 上限；**HTTP_STATUS 映射表单测**（14001/14002→409）。

**user-service**（`test/`）：
- `config-cache`：`signupGrant()` 缺省 0 / 坏值 0 / 正常值。
- `register`：grant=0 ⇒ **货币客户端未被调用** + 用户落库；grant>0 ⇒ apply 成功 ⇒ 落库；apply 失败 ⇒ **503+10007** + 零本地行（重试干净）；actionId 形状 `signup:<userId>`。
- `currency.client`：`timeout(3000)` / `metaFromTrace` 随带 / 传输失败 ⇒ 10007 固定文案。
- `admin-users.controller`：`X-Admin` fail-closed / 命中 `{userId}` / 未找到 404+11004。

**protocol**：`currency.test`：allowlist 内容逐字；归一化；**hash 排序不变性**（乱序 entries 同 hash）；ownerType 缺省与显式 `'user'` 同 hash；**actionId 不入指纹**（同载荷不同 actionId ⇒ 同 hash）；delta 变化 ⇒ hash 变；校验抛中文原因；get 边界 1/50/51。（`config.test` 十一键、`messages.test` 12 pattern、`errors.test` SPEC_CODES 随 §4 闸行同提交。）

### 6.2 conformance `slice-17-currency`（断言组）

① 前置与收尾：网关健康、探针残留、**状态复原**（配置键改回 0、注入重启回净、测试行清理——照 slice-15 纪律）；② C1 组（exec 探针 + 3104 直投）；③ C2 组（exec mysql 三表逐列/逐索引 + `migrations_currency` 行）；④ apply 四组（正常入账 / 重放同 id / 冲突 14002 / 不足 14001 + 多账户原子）；**④b 并发 burst 组（C7 主载体：并行 N 扣减 ⇒ 终值不变量 + 全程无负）**；⑤ get 组（含 exists=false 与不建行）；⑥ 玩家 REST 组（新用户 0 ⇒ 调整后 N）；⑦ 管理 REST 组（adjust + 重放同 opId + accounts recentFlows 倒序 + lookup 命中/404）；⑧ 注册赠送两态组（注入 >0 ⇒ 余额=值 + ops `signup_grant`；改回 0 ⇒ 新注册零痕迹、旧户不变；读法照 C13 两条）；⑨ reconcile 组（注入短值 ⇒ runs≥2、账实漂移两向、缓存漂移自愈、孤儿 gauge）；⑩ prometheus 14/14；**⑪ 静态/负例组**（C8 负例抽样：非法 source/delta≠0 违例/重复 ownerId 直投 ⇒ 10001；C12 静态断言：经门口拉 `/admin/app.js` 断言含「钱包调整」section 与三端点串；C14 负对照：`/api/config` 键集不含 `currency.signupGrant`）。

**手段先例**：`rpcCall` 直投 + 片内自带 `CURRENCY_RPC` 端点（照 slice-15 自带端点先例，不碰 `lib/rpc.ts`）；`compose exec mysql`（SQL 只用单引号字面量）；`adminLogin/adminPutConfig`（lib/http 既有）；`docker exec` 抓 9004；注入 = 宿主 env + `up -d --no-deps currency-service` 重启（照 slice-15 C8）。**不 import `@fight-the-landlord/shared`**（R168）；判定对象 = 真后端回答。

### 6.3 门禁

`pnpm -r build/test/lint`（新包随 turbo 自动纳入）；render gate（`slice-07.2-deploy`/`slice-07.4-pipeline` 的 `--render`——每次 push 跑）；全序 22 片（本机 + CI）；`conformance-stack.sh` 起栈覆盖 currency（SERVICES=13 之后镜像齐）。

---

## 7. conformance 登记与基线口径

- **`run.ts` CASES 追加形状**（末尾，纪律照既有注释）：

```ts
// 货币核心片（P2-①）：追加在末尾（同前——顺序即 CI 切片循环与 full 回填的顺序）。
'slice-17-currency': { title: '货币核心（服务/三表/幂等重放/管理面/注册赠送/对账）', run: runSlice17 },
```

- **`baselines.json`**：`full` 列新增 `"slice-17-currency": <N>`；`render` 列**不加**（本片非 `--render` 形态）。
- **回填纪律（静态回填免首跑红）**：本片断言序列**零分支、零跳过**（实现不写 `skip()`）⇒ 本机真栈读数与 CI 同构（slice-16 先例）——**本机确定性读数先填 + CI 首跑即验**；CI 读数与下限不一致时按 CI 实测回填（只抬不降纪律照旧）。实现期预估 **70–110 条**（定值由本机实跑读数回填）。
- `--list` 顺序 = CI 循环顺序 = `full` 列顺序（追加在末尾即三处同序）；`slice-17` 在 CASES 末尾 ⇒ 是全序最后一片。

---

## 8. 部署、回滚与明确不做

- **发布**：tag `v*` 触发（照常）。本片**无用户必填动作**——无新增 `.env` 必填项（DB/Redis/`INTERNAL_SERVICE_TOKEN` 全沿既有）；上线后 conformance 在发布镜像上跑全序 22 片。
- **回滚**：旧 tag 的 compose 无 currency-service ⇒ 新容器成孤儿**继续运行**（无流量职责；先例 = 片⑦ config-service 孤儿口径）；再次前进自动复用。**数据保留**：三表与迁移行跨版本留存；货币流水**永久保留**（业务性质，不是残留）。
- **兼容面**：玩家可见面**零变化**（暗上线）；唯一新面 = 管理页一块 + `/api/wallet/balance`（挂网关验签后，不可匿名）。
- **明确不做**（设计 §1.2 逐条）：玩家可见面全部（余额展示/金币场入口/占位转正/战绩页金币列）；对局结算接线（`money_delta` 仍恒 NULL）；机器人虚拟账户池（只预埋 `owner_type='robot'`）；支付/退款/提现；RBAC/财务后台/审计 actor；玩家流水页与对账报表页；**流水不清洗**（永久保留）。
- **下一步**：规格+计划合并评审 r1 已办、全数处置（见文末修订记录）→ 实现（逐任务子代理 + 分档审查）→ 终审 → 收口。

---

## 修订记录

- **v1.0**（2026-10-03，`bbf5d75`）：初稿（含起草期 ⚙️1–⚙️10）。
- **v1.1**（2026-10-03）：合并评审（规格+计划同轮；🔴1 + 🟡5 + 🟢5）全数处置——补入 **§4.1 #24（slice-07.4 `svcNames===12`，T1 即红的清单外硬闸）/ #25（LOG_LIMIT_TARGETS 静默失明）**；C7 载体改真栈并发 burst（假 DB 不证原子性）；§6.2 增 ④b 并发组与 ⑪ 静态/负例组（C8/C12/C14 载体落位）；§2.8 测试族三处→四处（client-config 泄漏名单）；⚙️12（并发首写窄洞闭合）；§4.2 增 l/m/n/o 文案与显示文本行；锚点订正（errors.ts:56-67、override :49/:97）；版本引用统一 v1.1.1；⚙️11 落位。
