# 财务后台 + RBAC + 审计（P2 第三步）：规格层 v1.1.8

> **唯一依据**：设计 v1.1.1（`docs/superpowers/specs/2026-10-05-admin-rbac-audit-design.md`，r1/r2 双轮评审通过后冻结）+ 侦察笔记（`.superpowers/sdd/2026-10-05-admin-rbac-audit/recon-notes.md`）。本规格把设计落成**可实施的逐字契约**；⭐ 处为本规格级裁定（⚙️），就地定死、无 TBD。
> **作者**：协调者（opus）；**状态**：v1.1.8 —— r1 零阻断 → 全数处置 → r2 核销「可通过」→ 实现期就地订正六处（v1.1.3 波2 ⚙️19；v1.1.4 波3 网关 CSV 透传；v1.1.5 波4 写方法 actor 统一；v1.1.6+v1.1.7 波5 CONFIG_LOCK_SQL 反引号〔含③ INSERT 列名〕）。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-*.md`。

---

## 0. 承接与订正

### 0.1 上游与版本

| 层 | 文件 | 版本 |
|---|---|---|
| 设计（冻结） | `docs/superpowers/specs/2026-10-05-admin-rbac-audit-design.md` | v1.1.1（r2 可通过） |
| 上游契约 | 货币设计 §1.3/§12（`2026-10-03-currency-design.md:46,347`）· 路线图 P2′/M0.4（`2026-10-02-post-mvp-roadmap.md:30,70`）· design.md 四处（`:192` §2.3 环境变量表 · `:404` §4.1 通信方式总表 · `:1055` §7.1 路由 · `:1135-1138` §7.5 管理面段——N5 订正：`design.md` 无「§2.13」节，行区间取管理面段本体） | 现行 |
| 侦察 | `.superpowers/sdd/2026-10-05-admin-rbac-audit/recon-notes.md`（带 file:line 的现况真源） | 2026-10-05 |

### 0.2 K1–K5 承接（设计 §0 用户裁决，逐条对位）

| 裁决 | 规格落点 |
|---|---|
| K1 管理页全量管账号 | §2.4（REST）+ §2.12（账号视图）+ §2.13（bootstrap/hatch） |
| K2 冲正做 | §2.8（协议 + 端点 + 语义） |
| K3 财务后台全套 | §2.7（读口）+ §2.12（财务视图） |
| K4 登录事件审计 | §2.3（落行）+ §2.5（读口）+ §2.12（审计页签） |
| K5 CSV 导出 | §2.11（契约，五个列表面） |

### 0.3 ⚙️ 规格级裁定（起草期就地定死）

| # | 裁定 | 依据/理由 |
|---|---|---|
| ⚙️1 | **时区链实测钉死**：MySQL 容器与 Node 容器**均为 UTC**（本机真栈探针：`@@global.time_zone=SYSTEM` 且 `NOW(3)` 与 `UTC_TIMESTAMP(3)` 逐字相同；`docker exec` 两侧 `date` 均为 UTC）；`created_at` 存 UTC。⇒ ① wire 一律 **epoch ms**（`toEpochMs` 先例 `records.service.ts:116-119`）；② 页面展示北京时间（§2.12）；③ 「按日」切天用 `CONVERT_TZ(created_at,'+00:00','+08:00')` **偏移写法**（不依赖 tz 表）；④ **服务进程 TZ 必须为 UTC**（容器默认即 UTC；若未来动 TZ，mysql2 本地时区解读会整体偏移 8h——登记为环境依赖） | 设计 §11 R8「规格期实测钉死」的答案 |
| ⚙️2 | **403 统一 = HTTP 403 + `10003 FORBIDDEN`**（登录停用与网关角色不足同码）：`CodedForbidden` 既有类（`jwt.middleware.ts:34-39`，注释原文「`10003` 必须配 403，不能配 401」） | 复用既有语义，不新增码 |
| ⚙️3 | **登录事件只落「形状合法」的尝试**（§2.3 处理序 ④–⑦ 分支）；形状 400 与启用 404 不落行 | 形状错不是凭据尝试；防灌行 |
| ⚙️4 | 令牌 **claims 非法**（缺 `sub`/`username` 空/`role` 不在四值）⇒ 401 + `10005`（与伪造同类——「令牌不可信」）；**旧令牌（无身份字段）即此路径 ⇒ 升级后全员重新登录一次** | 设计 §4.4-2 |
| ⚙️5 | 对账面板状态四字段 `lastAttemptAt/lastSuccessAt/lastResult/lastError`：**每一轮尝试（成败）都刷 `lastAttemptAt`**；成功另刷后两项、失败刷 `lastError`（截断 500 字）。互斥 = `inFlight` 旗：定时轮遇旗**跳过本轮并记日志**；手动遇旗 ⇒ 409 | 设计 §5.7 + G7 |
| ⚙️6 | **冲正重复语义（对设计 §5.5 的就地订正）**：同 `opId` 二次冲正——**同操作者且原因相同 ⇒ 载荷指纹相同 ⇒ 走 apply 重放（200, `replayed:true`）**；**其余（原因不同，或**不同操作者**同原因——指纹含 `actor` 维，`currency.ts:201-219`）⇒ 同 actionId 不同指纹 ⇒ `14002` 冲突 409**「该操作已冲正」。为让 UI 不撞这条缝：ops 列表/详情行**附 `reversed` 旗**（判定 = `EXISTS(… action_id = CONCAT('admin:reverse:', o.id))`），已冲正的按钮遮蔽 | 设计原句「重复⇒14002」只在异指纹时成立——指纹机制使然，就地订正（S9） |
| ⚙️7 | **CSV 消毒判别式逐字**（§2.11）；行尾 `\r\n`（RFC4180）+ 首字节 BOM | 设计 §4.6 的判别式落字 |
| ⚙️8 | 用户名**不做 trim**：归一 = `toLowerCase()`；空白字符由正则拒绝（`^[a-z0-9][a-z0-9._-]{2,31}$`）。**正则单一真源 = `packages/protocol/src/admin.ts`**（config 与 currency 两服务均已依赖 protocol；放 config-service 私有包会让 currency 侧跨服务 import 撞 `dockerfile-workspace-copy` 闸——S2）。**校验三处**共用 `isAdminUsername()`：建号 / CLI / currency 侧 `X-Admin-Actor` 校验；**登录不跑正则**（只归一 + 查无此人 ⇒ 401——与 §2.3 处理序一致，无第二读法） | 设计 G12 钉死（载体按 S2 修订） |
| ⚙️9 | **列表/过滤类新端点**（ops、三读口、summary、accounts 列表）未知 query 键 ⇒ **400**（文案「未知查询参数：<key>」）；**非列表新端点**（ops/:opId、reconcile、users/:userId）与**既有端点**（lookup/records）维持静默丢弃。理由：财务/审计面静默丢 `source` 会把「筛过的」与「全量」混同，属误导性读数。**`.csv` 变体白名单 = JSON 版去掉 `cursor/limit`（带上即视作未知键 ⇒ 400）**（S16a） | G5 风险的处置（边界按 S16 补全） |
| ⚙️10 | 账号列表**不分页**（管理面量级 O(10)）；服务端防御上限 200 行 | YAGNI + 防爆 |
| ⚙️11 | admin 面的错误信封一律「HTTP 状态 + `{code, message, data:null}`」；码优先复用：参数/冲突/不存在**借 `10001` + 精确文案**（`notEnabled404` 已有借码先例），业务冲突用 409（§2.14 总表） | 片⑦先例 |
| ⚙️12 | admin/app.js 存储：`TOKEN_KEY='ftl-admin-token'` 沿用（`app.js:34`）；新增 `ftl-admin-username` / `ftl-admin-role`（sessionStorage） | 现状 |
| ⚙️13 | bootstrap 幂等形态：`INSERT` 前 `SELECT COUNT(*)`（空 ⇒ 建）+ 唯一键兜底捕获；日志逐字见 §2.13 | 设计 §5.1 |
| ⚙️14 | hatch CLI 命令/输出逐字 §2.13；随机口令 = `crypto.randomBytes(18).toString('base64url')`（24 字符） | 设计 §5.2 |
| ⚙️15 | scrypt 契约逐字 §2.1（生产 `N=2^17,r=8,p=1,keylen=32,maxmem=160MiB`；单测注入小参数 + 一条默认参数端到端）。⚠️ `crypto.scrypt` 走 **libuv 线程池（默认 4）**：并发尝试最坏 ≈4×160MiB 瞬态块 + 池排队（波及其它 crypto/IO）——登记与运维排障注记（S12） | 设计 D5 + G9 |
| ⚙️16 | **C6 重写后的精确形态**（§4.1 #2）：compose 以 `ADMIN_PASSWORD=`（空串）重建 config-service ⇒ 用**运行侧口令** `{username:'admin', password:ADMIN_PASSWORD}` 登录**回 200**（新语义钉子：账号在，env 不再是开关）；「零账号 ⇒ 404」由单测钉（conformance 不造空表） | 设计 §9.1 #2 |
| ⚙️17 | **policy 路径归一（射程 = 仅 policy 匹配；豁免判定用原值；`isAdminPath` 的尾斜杠/原值语义不变、识别大小写不敏感——⚙️20；射程定义以 §2.10 第 0 步为权威）**：匹配前 `path` **剥全部尾斜杠**得 `normPath`。真栈实证（express 非严格路由）：`GET /api/admin/config/` 与无斜杠同处理器（200）；policy 不归一则 `GET /api/admin/accounts/` 落 P8「任意角色放行」= 本片唯一越权路径（S1）。`POST /api/admin/login/` 不落豁免 ⇒ 401 fail-closed（N1）。C10 必补尾斜杠负例 | 真栈实测 + 本仓「近邻路径不得被顺手豁免」既有纪律（`admin.middleware.test.ts:175-182` 先例） |
| ⚙️18 | **分页统一（四个分页面：ops + 三读口〔config/changes、login-events、accounts/changes〕；summary 无 cursor、accounts 列表 ⚙️10 不分页——N3 订正）**：`limit` 缺省 **50**、上限 **100**（设计臂 ops ≤100，全面统一）；响应 `{rows:[…], nextCursor:number\|null}`；`nextCursor = rows.length===limit ? 末行 id : null`（**不做存在性预查**——至多多一次空页）。CSV 无分页 | S4/S13 缺真源的答案 |
| ⚙️19 | **登录形状上界 = 32（覆盖本规格 v1.1.2 前的 64）**：33–64 字符未知用户名会走 miss 落事件、撞 `admin_login_events.username varchar(32)` 溢出 ⇒ **未认证可打 500 且限流桶不计数**（波2评审 Critical#1；根因 = 本规格 §2.3 旧稿与 §2.2 内部矛盾）。>32 ⇒ 400（形状级，不落事件）；**且归一（`toLowerCase`）后长度 >32 同款 400**（`toLowerCase` 可扩长，如 `İ`×24 ⇒ 48 字符——修复期发现的同族第二路径）；配套 C5 边界用例（33 ⇒ 400 无事件行；32 字符未知 ⇒ 401 且有事件行；`İ` 扩长例 ⇒ 400） | 波2任务评审 C#1（plan-mandated 规格订正；实现 = T3 修复 `3dc6538`） |
| ⚙️20 | **admin 路径识别 = 大小写不敏感（终审 F1）**：Express/Nest 路由匹配**大小写不敏感**（终审真栈实证：`/API/admin/*` 命中同一路由），而网关侧 `isAdminPath`/`isAdminLoginPath`/限流登录桶/clientIp 产出原为**大小写敏感**比较 ⇒ `POST /API/admin/login`（持任意玩家令牌）**直通 config-service 豁免路由**、登录失败桶不计数 ⇒ **唯一防爆破/scrypt 内存面控制被旁路**（修复前实证：变体全 401、桶值仅 1、无 429）。**订正**：`isAdminPath` 判定**大小写不敏感**（归一上收于此层）+ **豁免判定与尾斜杠语义不变（原值精确）** ⇒ 大小写变体落「admin 路径但非豁免」⇒ 无管理令牌一律 401 fail-closed（与 N1 同语义）。配套：C10/C11 补变体负例（同步修复提交） | 整支终审 F1（真栈实证；`review-final-opus.md`） |

---

## 1. 改动面一览

### 1.1 新增文件（分组；精确路径以计划为准，组内不遗漏）

- **config-service**：`src/admin/admin.module.ts` · `src/admin/accounts.controller.ts`（账号 4 端点——⚠️ **与既有 `src/config/admin.controller.ts` 同名异径**，本片新增件一律带 `src/admin/` 前缀，防改错文件）· `admin-accounts.service.ts`（CRUD + 自锁三闸 + 变更留痕）· `admin-password.ts`（scrypt）· `admin-bootstrap.service.ts` · `src/admin/audit.controller.ts`（config/changes + login-events 读口）· `admin-changes.service.ts`（配置留痕读写）· `login-events.service.ts` · `src/admin-reset.ts`（hatch CLI 入口）· `migrations/1789900000000-AdminRbac.ts` · 测试 6 件。
- **protocol**：`src/admin.ts`（`isAdminUsername()` 单一真源）· `src/csv.ts`（CSV 单元格算法单一真源，五面共用——放 protocol 的理由：双服务已依赖、跨服务不可复制私有文件，同 ⚙️8/S3）· **`src/index.ts` 桶导出补两行 `export *`**（`index.ts:8-17` 现有导出列表；N4）。
- **api-gateway**：`src/auth/admin-policy.ts` · 测试 `admin-policy.test.ts`。
- **currency-service**：`src/admin/admin-finance.controller.ts`（ops/detail/summary/reverse/reconcile 读写）· `src/admin/finance-query.service.ts`（SQL 逐字收口）· 测试 4 件。
- **user-service**：`admin-users.controller.ts` 扩 `:userId`（不新增文件）。
- **conformance**：`tools/conformance/src/slices/slice-19-admin-rbac-audit.ts`。
- **admin 页**：无新文件（`index.html`/`style.css`/`app.js` 原地扩展）。

### 1.2 修改文件（按包）

- **protocol**：`src/currency.ts`（allowlist +1、校验分支 +1）；`src/admin.ts`/`src/csv.ts` 见 §1.1。
- **config-service**：`admin-auth.service.ts`（口令比较 → 库；签发带 claims）· **`src/config/admin.controller.ts`**（登录改版 + PUT 留痕接线）· `platform-config.service.ts`（锁定读 + 同事务留痕）· `app.module.ts`（挂新模块/中间件）· `main.ts`（无新增中间件；hatch 不进 HTTP）。
- **api-gateway**：`identity-headers.ts`（3 常量 + DownstreamHeaders +3）· `admin.middleware.ts`（剥 4 / claims / policy / 注入 3）· `http-rate-limit.middleware.ts`（登录计 401+403、写桶非 GET）· `http/trusted-client-ip.ts`（peer 派生 helper 从限流中间件平移）· `gateway.controller.ts`（新路由 ≈14 条 + query 白名单 + clientIp 注入）· `proxy.gateway.ts`（forward 映射新头）。
- **currency-service**：`admin-wallet.controller.ts`（actor 取头 + adjust 语义不变）· `reconcile.service.ts`（状态四字段 + inFlight）· `http/x-admin.guard.ts`（读 actor 头，仅写端点强制）。
- **user-service**：`admin-users.controller.ts`。
- **admin 页**：`index.html`（登录用户名框 + 三视图壳）· `app.js`（登录/导航/财务/审计/账号/文案）· `style.css`（表格等）。
- **scripts**：`browser-e2e.mjs:629` 登录体。
- **文档**：§4.2 清单逐条（design.md ×4 · first-deploy ×3 · roadmap M0.4 · currency-design §12 回填 · ledger 计数）。

### 1.3 明确不在改动面（有意）

玩家协议/消息/客户端 5 页/`client-protocol.md`/17 键机制/监控规则与面板/edge Caddyfile/compose 拓扑（无新 env、无新容器）/`slice-07.2-security`（预期不动）/`game·room·robot` 三服务。

---

## 2. 新契约（写死）

### 2.1 口令哈希（scrypt；`packages/config-service/src/admin/admin-password.ts`）

- 接口：`hashPassword(plain: string, params?: ScryptParams): Promise<string>` · `verifyPassword(plain: string, stored: string): Promise<boolean>`。
- `ScryptParams = { N, r, p, maxmem, keylen }`；**生产默认逐字**：`{ N: 131072 /* 2^17 */, r: 8, p: 1, maxmem: 160*1024*1024, keylen: 32 }`（OWASP 最低推荐档；maxmem > 128·N·r=128MiB + 开销余量——不传 maxmem 必然抛错）。
- 存储格式逐字：`s1$<N>$<r>$<p>$<saltB64>$<hashB64>`（salt = `randomBytes(16)`；B64 = 标准 base64）。
- 校验：解析失败/前缀非 `s1`/段数不符 ⇒ `false`（不抛）；比较用 `crypto.timingSafeEqual`（**长度先守卫**——不等长直接 false，不比）。
- 单测注入小参数（如 `N=4096, maxmem=16MiB`）保持快；另 1 条默认参数端到端（hash→verify→错口令 false）。
- ⚠️ **线程池注记（S12）**：`crypto.scrypt` 走 libuv 线程池（默认 4）⇒ 并发登录尝试最坏 ≈4×160MiB 瞬态块 + 池占用（波及其它 crypto/IO 的排队）——由登录失败桶罩住数量，登记为运维排障注记（「登录变慢/请求卡」的第一怀疑对象）。

### 2.2 四表最终 DDL（迁移 `1789900000000-AdminRbac.ts`，config-service；共库 `fight_the_landlord`）

DDL 逐字 = 设计 §3 四表（`admin_accounts` / `admin_login_events` / `config_changes` / `admin_account_changes`），**零改动照抄**；补充语义：

- `down`：逆序 DROP 四表。
- **访问形态 = 裸 SQL**（照 currency-service 先例，不用 TypeORM entity）：锁定读要显式 `FOR UPDATE` 字样可被测试**全文钉**（`reconcile.service.ts:36-37` 同款纪律）。
- 时间列一律 `datetime(3)`（UTC，⚙️1）；wire 出站一律 `toEpochMs`（⚙️1）。
- 无种子（空表 = 管理面关闭态，唯一入口是 bootstrap/hatch）。

### 2.3 登录与令牌

**`POST /api/admin/login`** body `{username?: unknown, password?: unknown}`；处理序**逐字**（顺序即契约）：

1. **启用检查**：`SELECT 1 FROM admin_accounts LIMIT 1` 无行 ⇒ **404 + 借码 10001**「管理面未启用」（沿用 `notEnabled404()` 形态；**`ADMIN_EXEMPT_ROUTES` 豁免表在 `packages/config-service/src/config/admin.controller.ts:34-41`**，不动——S15a 锚点订正）。
2. **形状校验**：`username`/`password` 非 string、`username.length===0 || >32`（⚙️19：**与 §2.2 列宽、用户名正则上界对齐**）、`password.length===0 || >1024` ⇒ **400 + 借码 10001**（不落事件，⚙️3）。
3. `username = body.username.toLowerCase()`（⚙️8）；**归一后 `length>32` ⇒ 400**（不落事件；同 ⚙️19 的第二路径——`toLowerCase` 可扩长）。
4. 查行（miss ⇒ 事件 `success=0` + **401 + 10002**「用户名或口令错误」）。
5. `verifyPassword`（fail ⇒ 事件 + **同一句 401 + 10002**——防枚举）。
6. `status='disabled'` ⇒ 事件 `success=0` + **403 + 10003**「账号已停用」。
7. 成功：`UPDATE admin_accounts SET last_login_at=NOW(3) WHERE id=?` ⇒ 事件 `success=1` ⇒ 签发。

**响应**：`{code:0, data:{token, expiresIn:7200, username, role}}`（username 为归一后值）。

**令牌 claims**（`admin-auth.service.ts` 扩展）：`{sub: String(account.id), username, role, aud:'ftl-admin', iat, exp}`；TTL 7200 不变；密钥链不变。

**登录事件落行**：案 ④⑤⑥⑦；`ip` = 请求头 `x-client-ip`（网关注入，§2.10；缺失/超 64 字符 ⇒ NULL，不伪造）；`account_id` 仅案 ④ 命中后/⑥⑦回填。

**限流（`http-rate-limit.middleware.ts`，既有两桶扩边）**：登录失败桶阈值不变（5 次/5 分钟/IP）；**失败判据从「仅 401」扩为「401 或 403」**、200 清零、429 本身不计数；**写桶从「仅 PUT」扩为「`X-Admin==='1'` 且 method ∉ {GET, HEAD, OPTIONS}」**（阈值 30 次/5 分钟/令牌指纹不变）。

### 2.4 账号管理 REST（config-service；全部 super_admin——授权在网关 §2.10，服务侧只认 `X-Admin`）

**`GET /api/admin/accounts`** → `{code:0, data:{accounts:[{id, username, role, status, createdAt, lastLoginAt}]}}`；`createdAt/lastLoginAt` = epoch ms（后者可 null）；`password_hash` 永不出现；行序 `id ASC`（⚙️10 不分页、防御上限 200 行——超出照出前 200 并日志）。

**`POST /api/admin/accounts`** body `{username, password, role}`：

- `username`：string → `toLowerCase()` → 正则 `^[a-z0-9][a-z0-9._-]{2,31}$`（fail ⇒ 400 借 10001「用户名格式不符：3–32 位小写字母/数字/._-」）。
- `password`：string 10..72（fail ⇒ 400 借 10001）。
- `role`：∈ `{super_admin, finance, operator, viewer}`（fail ⇒ 400 借 10001）。
- 唯一键冲突 ⇒ **409 借 10001**「用户名已存在」。
- 成功 ⇒ **`@HttpCode(200)`**（管理面统一 200，与登录先例对齐；POST 的 Nest 缺省 201 不用）→ `{code:0, data:{id, username, role, status:'active'}}`；同事务 `admin_account_changes(action:'create', detail:{role})`。

**`PATCH /api/admin/accounts/:id`** body 任意子集 `{role?, status?, password?}`：

- `:id` 非十进制整数 ⇒ 400 借 10001「账号 ID 非法」；行不存在 ⇒ 404 借 10001「账号不存在」。
- 子集校验：`role` 同上；`status ∈ {active, disabled}`；`password` 10..72。
- **自锁三闸（顺序执行）**：
  1. **不能停用/变更自己的角色（任何方向）**：目标行 `username === X-Admin-Actor` 且（`status→disabled` **或** `role` 字段出现且 ≠ 现值）⇒ 409 借 10001「不能停用或变更自己的角色」。（改自己口令允许。**无角色高低序**——`operator→finance` 这类横向变更同样拒；消除「更低」两解，S5。）
  2. **最后一名 active 超管**：目标将被停用或降级出 `super_admin` 时，**事务内锁定读**：
     ```sql
     SELECT id, role, status FROM admin_accounts WHERE role='super_admin' AND status='active' FOR UPDATE
     ```
     结果集 size==1 且目标 ∈ 集合 ⇒ 409「不能停用或降级最后一名超级管理员」。（**锁定读不可回退为普通 SELECT**——RR 快照读看不见并发已提交行，两名超管互降会双双通过；同族纪律 = 货币 ⚙️14。**SQL 全文被单测钉**（照 `reconcile.service.ts:36-37` 先例）；**并发互降负例由 slice-19 两并发 PATCH 钉**（恰一成功 + 一 409、超管 ≥1）——现单测假库把同键写串行化、对锁定读无判别力（S7），**不**给它挂「双会话单测」承诺。）
  3. **停用不偷渡**：`status='disabled'` 的行「仅改 password」合法（成功），但**不得**顺带 `status→active` 以外的隐形启用——即 `password` 变更**不**隐式改 status（显式才动）。语义 = 只有显式 `status` 字段才改状态。
- 变更动作逐条留痕（同事务）：`role` 变 ⇒ `action:'role', detail:{from,to}`；`active→disabled` ⇒ `disable`；`disabled→active` ⇒ `enable`；`password` 变 ⇒ `password_reset, detail:null`；一次请求多字段 ⇒ **多行**。
- 成功 ⇒ `{code:0, data:{id, username, role, status}}`。

### 2.5 审计读口（config-service；读面全角色）

三读口统一形态：keyset 分页、时间过滤 `from/to` = epoch ms、未知 query 键 400（⚙️9）、行时间 epoch ms。**分页与响应形状（⚙️18 统一）**：`limit` 缺省 **50**、上限 **100**；响应 `{code:0, data:{rows:[…], nextCursor}}`；`nextCursor = rows.length===limit ? 末行 id : null`。

| 端点 | 过滤键 | 行形状 |
|---|---|---|
| `GET /api/admin/config/changes` | `key, actor, from, to, cursor, limit` | `{id, key, oldValue, newValue, actor, createdAt}`（`oldValue` 可 null） |
| `GET /api/admin/login-events` | `username, success('0'\|'1'), from, to, cursor, limit` | `{id, username, accountId, ip, success(boolean), createdAt}` |
| `GET /api/admin/accounts/changes` | `targetId, actor, action, from, to, cursor, limit` | `{id, targetId, username, action, detail, actor, createdAt}` |

各加 `.csv` 变体（§2.11）。

### 2.6 config PUT 的变更留痕（`platform-config.service.ts` `set()` 改造）

事务内**逐字**序：① `SELECT value, version FROM platform_config WHERE \`key\`=? FOR UPDATE`（**锁定读**；无行 ⇒ `old=NULL` + 走既有无行插入分支。⚠️ **`key` 必须反引号**——MySQL 保留字，v1.1.6/v1.1.7 订正：旧稿未加引号 ⇒ 真栈 ER_PARSE_ERROR 1064，配置 PUT 全 500〔假库单测遮蔽〕）② 更新/插入与 `version+1` 逻辑**照旧** ③ `INSERT config_changes(\`key\`, old_value, new_value, actor)`（**列名 `key` 同款反引号**——v1.1.7；本片 SQL 裸保留字恰此两处，均在 `admin-changes.service.ts`）。`updated_by = actor`。`actor` 来源 = `X-Admin-Actor`（写端点：**缺失/非法 ⇒ 401 fail-closed**，不回退）。现有 400 校验与 `{saved, announced, version}` 响应形状不动；校验失败**不落任何行**。**本 SQL 全文被单测钉**（照 §2.2/`reconcile.service.ts:36-37` 纪律）；**并发同键链式断言由 slice-19 钉**（两并发 PUT 不同值 ⇒ `changes` 两条链 `old→new` 自洽，无错位行——现假库测不出，S7）。

### 2.7 currency-service 新增管理面（读口 + 冲正 + 对账）

**`GET /api/admin/wallet/ops`**（SQL 逐字，全文被单测钉）：

```sql
SELECT f.id AS flowId, f.op_id AS opId, o.action_id AS actionId, o.source, o.actor, o.reason,
       o.ref_id AS refId, o.trace_id AS traceId, f.owner_id AS ownerId, f.owner_type AS ownerType,
       f.delta, f.balance_after AS balanceAfter, f.created_at AS createdAt,
       u.phone, u.nickname,
       EXISTS(SELECT 1 FROM currency_ops r WHERE r.action_id = CONCAT('admin:reverse:', o.id)) AS reversed
FROM currency_flows f
JOIN currency_ops o ON o.id = f.op_id
LEFT JOIN users u ON u.id = f.owner_id
WHERE <动态过滤>
ORDER BY f.id DESC LIMIT ?
```

动态过滤（全部 AND）：`o.source=?` / `o.actor=?` / `f.owner_id=?` / `f.created_at >= ?` / `f.created_at < ?`（由 epoch ms `new Date(ms)` 绑定——mysql2 本地时区 = 容器 UTC = 库内 UTC，⚙️1）/ `f.id < ?`（cursor）。行为：`reversed` 以 MySQL 布尔（0/1）出，DTO 转 boolean；`phone/nickname` 缺行 ⇒ null。响应 `{code:0, data:{rows:[…], nextCursor:number|null}}`（**limit 缺省 50、上限 100**；`nextCursor = rows.length===limit ? 末行 flowId : null`——不做存在性预查，⚙️18）。

**`GET /api/admin/wallet/ops/:opId`** → op 行 + 全 flows（同 join 无过滤，`WHERE f.op_id=? ORDER BY f.id`）+ `reversed`；op 不存在 ⇒ 404 借 10001「操作不存在」。

**`GET /api/admin/wallet/summary`**（SQL 逐字，两分支）：

```sql
-- groupBy=source
SELECT o.source AS k, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount
FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id
WHERE f.created_at >= ? AND f.created_at < ? GROUP BY o.source ORDER BY k
-- groupBy=day（北京时间切天；不依赖 tz 表）
SELECT DATE(CONVERT_TZ(f.created_at,'+00:00','+08:00')) AS k, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount
FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id
WHERE f.created_at >= ? AND f.created_at < ? GROUP BY k ORDER BY k
```

`groupBy` 缺省 `source`、∈ {source, day} 否则 400；**缺省窗口逐字**：`to = now + 1ms`、`from = to - 30d`；空窗 ⇒ `rows:[], totals:{delta:0, flowCount:0}`。**驱动回值型别（钉，S13）**：`delta/flowCount` 经 `Number()` 转数字（SUM→DECIMAL 回 string，照 `admin-wallet.controller.ts` 的 toSafeInt 先例）；`k`：source 分支即字符串，day 分支 `DATE()` 回 `Date` 对象 ⇒ 服务端格式化为 `'YYYY-MM-DD'` 字符串（⚙️1 下往返恒等；不依赖 `dateStrings` 驱动开关）。

**`POST /api/admin/wallet/reverse`**：见 §2.8。

**`GET /api/admin/wallet/reconcile`** → `{code:0, data:{lastAttemptAt, lastSuccessAt, lastResult, lastError, running}}`（前四项 epoch ms / 对象 / string / null；`running`=布尔）。`lastResult` 形状 = `CurrencyReconcileRoundResult`。

**`POST /api/admin/wallet/reconcile/run`**：`inFlight` ⇒ 409 借 10001「对账正在运行」；否则执行 `runReconcileOnce()`（其自带 runWithTrace 包裹不动）⇒ 200 `data` = 一轮读数。`reconcile.service.ts` 改造：新增私有 `inFlight` 旗（`runReconcileInner` 入口 set、finally 清）；**定时链 `runRound` 遇旗 ⇒ 跳过本轮 + `logger.warn` 一行 + 照常自重排**（跳过不写 `lastAttemptAt`——本轮未尝试）。

**actor（fail-closed）**：`adjust`/`reverse` 读 `x-admin-actor`；缺失或**不匹配** `^[a-z0-9][a-z0-9._-]{2,31}$` ⇒ 401 + 10002「管理身份缺失」（金额写面绝不回退 `'admin'`）。读端点不强求该头。⚠️ **裁定（v1.1.5，T6 落地形态）**：守卫按**写方法端点**统一强制 actor——**`reconcile/run`（POST）同样要求该头**（网关对所有已认证管理请求恒注入，零破坏面；该诊断动作**不落**审计行）；将来新增写方法端点自动继承此要求。

### 2.8 冲正契约

**协议**（`packages/protocol/src/currency.ts`）：allowlist **+ `'admin_reverse'`**；`validateCurrencyApply`：`admin_reverse` 与 `admin_adjust` **内核**同规（`actor` 非空 ≤64、`reason` 非空 ≤255——**与 `currency.ts:152-167` 实况逐字对齐**；「1..200」是 **admin 端点 body 预闸**，本片 reverse 端点沿用同款预闸。S6 订正：不得给内核加「≤200」，那会造出与 `admin_adjust` 不对称的内核）；delta 上限走默认 1e6（反向值来自既有 `admin_adjust`，天然 ≤1e6）。

**端点**：`POST /api/admin/wallet/reverse` body `{opId: number, reason: string}`（`opId` 正整数、`reason` 1..200；否则 400 借 10001）→

1. 查 `currency_ops`：不存在 ⇒ 404「操作不存在」；`source !== 'admin_adjust'` ⇒ **409 借 10001**「该操作不可冲正」。
2. `entries = 原 op 全部 flows 取负`（`ownerId/ownerType` 从 flow 取，`delta = -delta`）。
3. 经 `currency.apply`：`actionId = 'admin:reverse:<opId>'`、`source='admin_reverse'`、`actor` = 头、`reason`、`refId = 原 action_id`。
4. 映射（§2.14）：`14001` ⇒ 409「余额不足，无法整笔冲正（可能已部分花费）——可改用手工扣减」；`14002` ⇒ 409「该操作已冲正」；同原因重放 ⇒ 200 + `replayed:true`（⚙️6）。
5. 成功 ⇒ `{code:0, data:{opId: 新opId, actionId, replayed, entries:[{ownerId, balanceAfter}]}}`。

### 2.9 user-service：`GET /api/admin/users/:userId`

`userId` 长度 1..36 之外 ⇒ 400 借 10001；窗口外字符集不预检（照 `admin-wallet.controller.ts:46-48` 注释先例）；miss ⇒ 404 + `11004`（既有 USER_NOT_FOUND）。响应 `{code:0, data:{userId, phone, nickname, status, createdAt}}`（`createdAt` epoch ms；`nickname` 可 null）。

### 2.10 api-gateway（逐字契约）

**身份头**（`identity-headers.ts`）：`ADMIN_ACTOR_HEADER='x-admin-actor'` · `ADMIN_ROLE_HEADER='x-admin-roles'` · `CLIENT_IP_HEADER='x-client-ip'`；`DownstreamHeaders` + `adminActor?: string; adminRole?: string; clientIp?: string`（映射回同名头；`clientIp` 仅 login 路径产出——R31 的 `X-Token-Jti` 纪律复刻）。

**`admin.middleware.ts` 处理序（顺序即契约）**：

0. **路径归一（⚙️17，射程 = 仅 policy 匹配）**：`path = requestPath(req)` 后剥全部尾斜杠得 `normPath`；**只有第 6 步 policy 匹配使用 `normPath`**；**豁免判定（第 3 步）用原值；`isAdminPath`（第 2 步）的尾斜杠/原值语义不变、识别大小写不敏感（⚙️20）**——`POST /api/admin/login/`（尾斜杠）不落豁免 ⇒ 走 Bearer 要求 ⇒ **401 fail-closed**；且限流登录桶判定（`http-rate-limit.middleware.ts:84`）本就是原值精确匹配 ⇒ **不产生任何旁路**（N1：若归一射程含豁免，尾斜杠登录变体将直达登录处理器而失败桶不计数——scrypt 的唯一防爆破控制被旁路）。（真栈实证：express 非严格路由下 `/api/admin/config/` 与无斜杠同处理器；policy 不归一则 `GET /api/admin/accounts/` 绕过 P1 落 P8 = 越权路径。）
1. **剥四枚**（所有路径、任何判断之前）：`x-admin`/`x-admin-actor`/`x-admin-roles`/`x-client-ip` 客户端值一律删除。
2. 非 admin 路径 ⇒ next。（**admin 路径判定 = 大小写不敏感**——⚙️20 终审 F1 订正；第 0 步归一与第 3 步豁免判定**保持原值**语义不变。）
3. `POST /api/admin/login` **恰一条**豁免 ⇒ next。
4. 缺 Bearer ⇒ 401 `10002`；验签（`aud:'ftl-admin'`）失败 ⇒ 401 `10005`。
5. **claims 校验**（⚙️4）：`sub`/`username` 非空 string、`role ∈ {super_admin, finance, operator, viewer}`；否则 401 `10005`。
6. **policy**（`admin-policy.ts`，**显式枚举，规则按序首个命中**）：

   | # | 规则（method + 路径） | 允许角色 |
   |---|---|---|
   | P1 | `GET /api/admin/accounts`（**精确**） | super_admin |
   | P2 | `POST /api/admin/accounts`（精确） | super_admin |
   | P3 | `PATCH /api/admin/accounts/:id`（前缀 `/api/admin/accounts/`，排除 `.csv`） | super_admin |
   | P4 | `PUT /api/admin/config/:key`（前缀 `/api/admin/config/` 且非 `…/changes`） | super_admin, operator |
   | P5 | `POST /api/admin/wallet/adjust`（精确） | super_admin, finance |
   | P6 | `POST /api/admin/wallet/reverse`（精确） | super_admin, finance |
   | P7 | `POST /api/admin/wallet/reconcile/run`（精确） | super_admin, finance |
   | P8 | 其余 **GET**（含 `.csv`、`/api/admin/accounts/changes`） | 已认证即放行（任意角色） |
   | P9 | 其余**非 GET**（未登记写路径） | **403 fail-closed** |

   命中凭据不足 ⇒ 403 + `10003`（`CodedForbidden`）；**不注入任何下游头**。
7. 注入 `X-Admin:'1'` + `X-Admin-Actor:<username>` + `X-Admin-Roles:<role>`；`req.adminTokenFp` 照旧。

**登录路径 clientIp 注入**：`headersOf()` 在 `isAdminLoginPath(path)` 为真时加 `clientIp` —— 解析调用形态 = **`clientIpFrom(headers, socketAddress, TRUST_TABLE)`（三参）**（`trusted-client-ip.ts:34` 唯一解析实现；S8 订正：不存在 `clientIpFrom(req)` 形态）；peer 派生（`socket.remoteAddress → req.ip → 'unknown'`）**从 `http-rate-limit.middleware.ts:168-173` 私有实现平移为 `trusted-client-ip.ts` 导出 helper**，限流与登录事件两处共用（防「限流 IP」与「登录事件 IP」两口径漂移）。

**路由登记（约 14 条）**：`POST admin/login`（body 透传不变）· `GET/POST admin/accounts` · `PATCH admin/accounts/:id` · `GET admin/accounts/changes(.csv)` · `GET admin/config/changes(.csv)` · `GET admin/login-events(.csv)` · `GET admin/wallet/ops(.csv)` · `GET admin/wallet/ops/:opId` · `GET admin/wallet/summary(.csv)` · `POST admin/wallet/reverse` · `GET/POST admin/wallet/reconcile[/run]` · `GET admin/users/:userId`。

**query 白名单（⚙️9 修订版）**：**列表/过滤类端点**（ops、config/changes、login-events、accounts/changes、summary、accounts 列表）未知键 ⇒ **400 借 10001**「未知查询参数：<key>」——白名单 = §2.5/§2.7 过滤键（summary 为 `from/to/groupBy`；accounts 列表无键）；**`.csv` 变体白名单 = JSON 版去掉 `cursor/limit`（带上即 400）**；**非列表新端点**（ops/:opId、reconcile、users/:userId）与既有端点维持静默丢弃。**路径参数编码**照 `:key`/`:userId` 先例（`encodeURIComponent`，R75）。

### 2.11 CSV 契约（五个列表面统一）

- 响应头：`Content-Type: text/csv; charset=utf-8`；`Content-Disposition: attachment; filename="<名>-<yyyyMMdd-HHmmss>.csv"`（名：`flows` / `summary` / `config-changes` / `login-events` / `account-changes`）。
- 内容：首字节 BOM `﻿`；行尾 `\r\n`；表头**中文逐字**（列 = 各 JSON 行字段语义，逐端点在实现时照 §2.5/§2.7 行形状定列，**规格钉：列集合 = JSON 行字段去 `traceId`**）。
- 单元格逐字算法（⚙️7）：

  ```ts
  const NUMERIC = /^-?\d+(\.\d+)?$/;
  function csvCell(v: unknown): string {
    let s = v === null || v === undefined ? '' : String(v);
    if (!NUMERIC.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 公式注入消毒（合法数字豁免）
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  ```

- 上限：`flows.csv` 单次 ≤ 50,000 行（超 ⇒ 400 借 10001「范围过大，请收窄时间区间」）；其余面无分页、天然小。
- **网关透传（v1.1.4 补，波3发现）**：CSV 响应经网关**原样透传**——转发层（`proxy.gateway.ts` 的 `forward()`）按**上游 `Content-Type`** 分支：`text/csv` ⇒ 透传 status + `Content-Type` + `Content-Disposition` + 文本体；**JSON 路径语义逐字不变**（既有全部代理路由零行为变化）。理由：共享 `forward()` 现固定 `resp.json()`，不分支则 CSV 经网关变 `application/json null`（A3/切片断言全挂）；实现修复 = T5 修复提交。

### 2.12 管理页（admin/）

- **登录卡**：加「用户名」输入框（`#login-username`，placeholder「用户名」）；登录成功存 `token/username/role`（⚙️12）；**404 文案改版逐字**：「管理面未启用（未创建任何管理员账号）」；**403 文案**：「账号已停用，请联系超级管理员」（新增分支——`app.js:210-213` 附近与 status 分流处）。
- **导航**：配置（super_admin/operator）· 钱包（super_admin/finance——既有「钱包调整」视图保留原样，作为快捷操作；新增只读面全在「财务」）· 财务（全角色）· 审计（全角色）· 账号（super_admin）。**仅 UI 门面**（服务端才是闸）。
- **财务视图**：筛选条（source 下拉 = allowlist 六值 + 空；actor；ownerId/手机号；时间范围预设「今日/近 7 天/近 30 天/自定义」）+ 流水表（列 = flowId/时间(北京)/source/actor/ownerId/昵称/手机/delta/balanceAfter/reason/操作详情按钮；`reversed` 行加「已冲正」标记）+ keyset「加载更多」+ 行内「冲正」（admin_adjust 且未冲正才显示；弹窗必填原因）+ 详情展开（op 行 + 全 flows + traceId）+ 汇总卡（按来源/按日切换 + totals）+ 机器人池卡（余额 + 「查看池流水」跳转 source=robot_pool）+ 对账面板（四字段 + 「立即对账」）+ 导出按钮。
- **审计视图**：四页签（配置变更 / 资金操作＝流水预筛 `source∈{admin_adjust,admin_reverse}` / 登录事件 / 账号变更），各带筛选 + 导出。
- **账号视图**：表格（用户名/角色/状态/最近登录/创建时间）+ 建号表单（用户名/口令/角色）+ 行内操作（改角色下拉、停用/启用、重置口令弹窗）。
- 🔴 **输出编码纪律**：昵称/手机号/reason/username/detail 等一切数据渲染**只用 `textContent`**（禁 `innerHTML`；现页无此先例，保持为零）。时间展示 = 北京时间（`toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})`，⚙️1）。

### 2.13 bootstrap 与 hatch

**bootstrap**（config-service `OnApplicationBootstrap`）：`SELECT COUNT(*) FROM admin_accounts` == 0 时——`ADMIN_PASSWORD`（`(env ?? '') || null` 纪律）非空 ⇒ `INSERT` 引导行（`username:'admin'`、`role:'super_admin'`、`status:'active'`、scrypt 哈希）并日志**逐字**：`admin bootstrap: created super_admin 'admin' from ADMIN_PASSWORD`；**不套口令策略**（设计 §5.1；`password.length<10` 另加 `logger.warn('admin bootstrap: bootstrap password is shorter than the policy minimum (10)')`）。空表且 env 空 ⇒ `logger.warn('admin bootstrap: no accounts and no ADMIN_PASSWORD — admin surface disabled')`。非空表 ⇒ 无动作。唯一键冲突（并发）⇒ 捕获忽略。

**hatch**（`dist/admin-reset.js`，容器内运行）：

```
docker compose exec config-service node packages/config-service/dist/admin-reset.js <username> [--role <role>] [--password <pw>]
```

行为：`username` 归一 + 正则校验（fail ⇒ 打印用法 + exit 1）；不存在 ⇒ 按 `--role`（缺省 super_admin）建；存在 ⇒ 重置口令 + 强制 `active`；口令取 `--password` > `ADMIN_RESET_PASSWORD` > 随机（`randomBytes(18).toString('base64url')`，24 字符）；**stdout 恰好两行**：`reset <username>: ok` + 第 2 行按口令来源三档——`--password` 档 `password: (from argument)`、`ADMIN_RESET_PASSWORD` 档 `password: (from ADMIN_RESET_PASSWORD)`（**不回显值**）、随机档 `new password: <pw>`（S11 补全）；同事务落 `admin_account_changes(action:'password_reset', actor:'cli')`（新建则 `create, actor:'cli'`）；exit 0/1。

### 2.14 错误码与 HTTP 映射总表

| 场景 | HTTP | code | 文案（逐字为准） |
|---|---|---|---|
| 未启用（零账号） | 404 | 10001（借） | 管理面未启用 |
| 登录形状非法 | 400 | 10001（借） | 参数非法 |
| 未知用户名 / 口令错 | 401 | 10002 | 用户名或口令错误 |
| 账号已停用（登录） | 403 | 10003 | 账号已停用 |
| 令牌缺失 | 401 | 10002 | Missing admin token（既有） |
| 令牌过期/伪造/claims 非法 | 401 | 10005 | Invalid or expired admin token（既有扩 claims） |
| 角色不足 / 未登记写路径 | 403 | 10003 | Insufficient role / endpoint not registered |
| admin 写面 actor 头缺失/非法 | 401 | 10002 | 管理身份缺失 |
| 参数非法（账号/过滤/反冲入参/未知 query 键） | 400 | 10001（借） | 「账号 ID 非法」·「未知查询参数：<key>」· 其余逐端点精确文案见各节 |
| 用户名冲突 | 409 | 10001（借） | 用户名已存在 |
| 自锁闸 1/2 | 409 | 10001（借） | 不能…（§2.4 逐字；**闸 3 = 语义约束，从不产生错误路径**——S14 订正） |
| 冲正：非 admin_adjust | 409 | 10001（借） | 该操作不可冲正 |
| 冲正：已冲正（异原因） | 409 | 14002 | 该操作已冲正 |
| 冲正：余额不足 | 409 | 14001 | 余额不足，无法整笔冲正… |
| 账号/操作/用户不存在 | 404 | 10001（借）/ 11004 | 逐端点 |
| 对账在跑 | 409 | 10001（借） | 对账正在运行 |
| 登录限流 | 429 | 10006 | 既有信封 |

---

## 3. 判据总表（C1–C29；载体 = 单测 / conformance `slice-19` / 既有闸 / 手工核销，全部同提交）

| # | 判据 | 载体 |
|---|---|---|
| C1 | 四表 DDL 与 down 逆序；迁移号 `1789900000000` 全仓唯一 | 单测（迁移）+ 手工核销 |
| C2 | scrypt：格式逐字/错口令 false/损坏串 false/长度守卫/（小参注入 + 默认参数端到端各一） | 单测 |
| C3 | bootstrap 三态（空表+env 建/空表无 env warn/非空跳过）+ 短口令照建仅 warn | 单测 |
| C4 | 启用谓词：零账号 ⇒ 404（单测钉）；有账号 + 空 env ⇒ 登录 200（**slice-14 C6 重写承载，非 slice-19**——N2） | 单测 + slice-14 |
| C5 | 登录矩阵：形状 400 / 未知 401 / 错口令 401（同文案）/ 停用 403 / 成功 200 带 username+role；**边界（⚙️19）：33 字符用户名 ⇒ 400 且无事件行（防 500 回归）；32 字符未知 ⇒ 401 且有事件行；归一扩长例（`İ`）⇒ 400** | 单测 + slice-19 |
| C6 | 登录事件：成败双行、IP 列、未知用户名也落行、形状 400 不落行 | 单测 + slice-19 |
| C7 | 令牌 claims 四要素；网关缺/坏 ⇒ 401 10005；**旧令牌（无身份）⇒ 401** | 单测 + slice-19 |
| C8 | 剥头四枚：伪造 `x-admin`/`x-admin-actor`/`x-admin-roles`/`x-client-ip` 永不达下游 | 单测（admin.middleware.test 扩）+ slice-19 |
| C9 | 注入三枚（验真后）+ login 路径 clientIp 有值、其余路径无 | 单测 + slice-19 |
| C10 | policy P1–P9 逐条正反（4 角色 × 每写端点 + `GET /accounts` 超管限定 + 未登记非 GET 403 + **尾斜杠负例**：`GET /api/admin/accounts/` 归一中 P1 ⇒ 非超管 403，**不得落 P8** + **大小写变体负例（⚙️20）：`GET /API/admin/accounts`/`/Api/admin/config` 等混大小写 ⇒ 按 admin 路径走管理鉴权（无有效管理令牌 401），不得作为玩家路径直通**） | 单测 + slice-19 |
| C11 | 限流：登录失败桶计 401/403、200 清；写桶覆盖全部非 GET；**`POST /api/admin/login/`（尾斜杠）⇒ 401 且不达登录处理器（豁免不扩散，N1 钉子）**；**`POST /API/admin/login`（大小写变体，⚙️20）⇒ 401 且不达处理器、不进失败桶之外的任何旁路（桶判定与原值路径同口径）** | 单测 + slice-19 |
| C12 | 账号 CRUD 全链（建/列/改角色/停用/启用/重置）；列表无 password_hash | 单测 + slice-19 |
| C13 | 自锁闸 1/2/3：正反各例；闸 2 锁定读 **SQL 全文被单测钉**；**并发互降负例 = slice-19 两并发 PATCH**（恰一成功一 409、超管 ≥1——假库对锁定读无判别力，单测不作此承诺，S7） | 单测 + slice-19 |
| C14 | 账号变更留痕：四动作行 + detail + actor + 多字段多行 | 单测 + slice-19 |
| C15 | config PUT：old→new 行、首建 null、事务原子（400 不落）、updated_by、FOR UPDATE **SQL 全文被单测钉**；**并发同键链式断言**（slice-19 两并发 PUT 不同值 ⇒ `changes` 链自洽，无错位行） | 单测 + slice-19 |
| C16 | 三审计读口：过滤/分页/行形状/未知 query 400/CSV 变体 | 单测 + slice-19 |
| C17 | ops 列表：六过滤/reversed 旗/limit 边界/nextCursor/未知 query 400 | 单测 + slice-19 |
| C18 | op 详情：多账户 op 全 flows / 404 | 单测 + slice-19 |
| C19 | summary：source/day 两态、+08:00 切天（跨日样本）、空窗 0、groupBy 非法 400、**`k`=字符串 ∧ `delta/flowCount`=数字（型别钉，S13）** | 单测 + slice-19 |
| C20 | reverse 全链：正例（actor=操作者/refId/entries）/14001 原子拒/同原因重放 200/异原因 14002 409/非 admin_adjust 409/reversed 旗翻转 | 单测 + slice-19 |
| C21 | reconcile：GET 四字段/手动 409 互斥/定时遇旗跳过/失败轮刷 lastAttemptAt/成功刷新 | 单测 + slice-19 |
| C22 | CSV：BOM/消毒（`=cmd` 前置 `'`、负数不动）/50k 上限/文件名 | 单测 + slice-19 |
| C23 | users/:userId 在/不在/参数 | 单测 + slice-19 |
| C24 | actor fail-closed：adjust/reverse 缺头 ⇒ 401 | 单测 + slice-19 |
| C25 | 管理页：端点串/无 innerHTML/404+403 文案/角色导航 | 单测（静态串）+ 手工 |
| C26 | bootstrap 与 hatch 真栈演练（hatch 建号+复位各一次） | 手工核销（验收） |
| C27 | 玩家面无回归（browser-e2e 改版后绿 + 全序） | 手工/CI |
| C28 | §4.2 文档同步清单逐条核销 | 手工核销 |
| C29 | slice-19 入 `run.ts`/`baselines.json`；`slice-14` 重写后读数回填 | CI 回填 |

---

## 4. 既有判据同步清单（设计 §9 逐条核销；同提交；实现先全仓 grep 再动）

### 4.1 硬闸

1. `tools/conformance/src/lib/http.ts`：`adminLogin()` body 改 `{username:'admin', password:ADMIN_PASSWORD}`（`adminGetConfig/adminPutConfig` 不动）——消费切片 06/07.1/07.2-hardening/12/13/14/15/17/18 自动跟随。
2. `slice-14` C6（:472-488）**重写**（⚙️16 逐字形态）；C15（:517-538）body 改 `{username,password}`、429 断言保持。
3. `slice-17` C11：字面仍绿（引导账号名 `admin`）；「第二账号 ⇒ actor=其用户名」由 slice-19 补（防假绿）。
4. `packages/api-gateway/test/admin.middleware.test.ts`（:79-124 伪造头族）：扩四枚剥除/claims 校验/三枚注入/policy 正反/未登记 403。
5. `packages/api-gateway/src/http/http-rate-limit.middleware.ts`（:94-101、:103）+ 其单测：401+403 计失败；写桶非 GET。
6. `scripts/browser-e2e.mjs:629`：登录体改版（非 push 闸但本片直接破坏；验收轮先跑它）。
7. `tools/conformance/baselines.json`：新增 `slice-19-admin-rbac-audit`（**CI 首轮实测回填**，非本机）；`slice-14`/`slice-17` 读数如变**只抬不降**。
8. 服务单测族：`admin-auth.test.ts`（signToken 改 claims + scrypt）/`admin.controller.test.ts`（登录矩阵）/`platform-config`/`config.validation` 族随改。
9. `slice-07.4-pipeline` 文件集闸：实施首日核销新文件是否触集合（预期不触；`container-assembly.gate.test.ts` 已核验无同路径同动词冲突）。

### 4.2 计数/文案（人工同步，防文档谎报）

- `admin/app.js` 登录 404 文案改版 + 403 分支（§2.12）→ 同提交；slice-19 静态断言（端点串 + 无 innerHTML）。
- `docs/design.md`：`:192`（env 表 `ADMIN_PASSWORD` 行）/`:404`（**§4.1 通信方式总表**——N5 订正）/`:1055`（§7.1 路由 bullet）/`:1135-1138`（§7.5 管理面段）四处重写。
- `docs/ops/first-deploy.md`：`:234`（env 表行）+ `911-954`（管理面章节全面重写：账号登录/角色表/建号/hatch/ADMIN_PASSWORD 新语义/dev 卷注记）+ `1206-1267`（种子节 curl 登录示例改 `{username,password}`）。
- `docker-compose.yml:245-247` **注释行**：旧句「未设或空串 ⇒ 管理面整体关闭 ⇒ 登录 404（C6）」在新语义下失准（值/拓扑不动，**只改注释**——S10a）；`tools/conformance/src/lib/http.ts:203-207` **注释**：「dev 栈用 `ADMIN_PASSWORD=` 覆盖」机制失效说明（S10b）。
- ⚠️ `docs/design.md` §2.3 行（`:192`）在 **J18 机械闸**扫描面内（`packages/shared/test/design-md-ai-rollout.gate.test.ts:87-121` 要求 `ADMIN_PASSWORD` 等字面出现）——重写该行**必须保全被扫字面**（S10c；本仓「注释改动也会命中按原文扫描的闸」有前科）。
- `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`：M0.4 标完成。
- `docs/superpowers/specs/2026-10-03-currency-design.md` §12：回填完成注记 + **G11 口径偏离**（「角色名」→「用户名（角色随行）」）。
- `scripts/ledger-counts.mjs` 台账计数。

### 4.3 预期不动（复核后登记）

`slice-07.2-security` · 监控规则/面板 · `client-protocol.md` · 17 键 · edge Caddyfile · `docker-compose.yml`（**仅 :245-247 注释行修订，见 §4.2**——值/拓扑不动）。

---

## 5. 验收条目（A1–A8）

- **A1** 角色矩阵实拍：四账号各登一次，逐端点正反（403/200）浏览器走查。
- **A2** 冲正全链实拍：发➝冲➝重放➝异原因 409➝已花费 14001 各一例。
- **A3** 审计四页签：数据可见、过滤可用、CSV 五个面各导一次并用 Excel 打开（中文不乱码、公式已消毒）。
- **A4** bootstrap 升级演练：以现网口径（存量 `ADMIN_PASSWORD`）在真栈验证首启建号 + 登录 + hatch 复位各一次。
- **A5** 管理页三角色走查（超管/财务/只读）导航可见性与 403 面。
- **A6** 玩家面无回归：`browser-e2e.mjs`（改版后）+ 本机全序。
- **A7** CI 三绿（六阶段仅 push 前跑一次）。
- **A8** 文档三件（design/first-deploy/roadmap）diff 实读核销。

---

## 6. 测试矩阵

### 6.1 单测（用例名级；新增/修改）

- config-service：`admin-password.test.ts`（格式/验证/损坏/长度守卫/默认参端到端）· `admin-bootstrap.test.ts`（三态 + 短口令 warn + 幂等）· `admin-accounts.test.ts`（CRUD/校验/冲突 409/自锁闸 1/2 正反 + 闸 2 锁定读 SQL 全文/变更留痕四动作——**并发互降不在本件**，载体 = slice-19）· `admin-auth.test.ts`（改版：claims 签发/登录矩阵/事件落行）· `audit-read.test.ts`（三读口过滤/分页/400）· `admin-reset.test.ts`（CLI 建/复位/随机口令/exit）· `platform-config.test.ts` 扩（FOR UPDATE SQL 全文 + changes 同事务 + 首建 null + updated_by；并发链在 slice-19）。
- api-gateway：`admin-policy.test.ts`（P1–P9 逐条）· `admin.middleware.test.ts` 扩（剥四/claims/注入三/policy 接线/未登记 403）· `http-rate-limit.test.ts` 扩（401+403 计失败/写桶非 GET）· `gateway.controller.test.ts` 扩（新路由/白名单 400/clientIp 仅 login）。
- currency-service：`admin-finance.test.ts`（ops 列表六过滤/reversed/nextCursor/summary 两态+切天/op 详情/未知 query 400）· `admin-reverse.test.ts`（全链+映射）· `reconcile-admin.test.ts`（四字段/互斥/跳过/失败轮）· `csv.test.ts`（消毒表驱动/BOM/CRLF/50k）。
- user-service：`admin-users.test.ts` 扩（:userId 三态）。

### 6.2 conformance `slice-19-admin-rbac-audit`（断言组）

G1 起手（登录 + 引导号在）· G2 登录矩阵（5 态 + **⚙️19 长名边界两例**）· G3 令牌/claims（旧令牌 401 不可造？——以伪造缺 claims 令牌代）· G4 伪造头三枚 + 直连面 · G5 policy 矩阵（四角色 × 写端点正反 + GET /accounts 超管限定 + **尾斜杠负例**）· G6 账号 CRUD + 留痕页签 + **并发互降负例（两并发 PATCH）** · G7 冲正全链（含 reversed 旗）· G8 配置写 → changes 行（旧值→新值）+ **两并发 PUT 链式断言** + CSV 样本 · G9 登录事件（成败 + IP 非空）· G10 财务读口（ops 过滤/summary/详情/limit 边界）· G11 对账读写 · G12 静态串 + 无 innerHTML · 收尾（造数清理：新建账号停用/留档——不删；台账登记）。

### 6.3 门禁

`pnpm -r lint/test` 全绿 → 六阶段（push 前一次）→ CI 三 workflow。

---

## 7. conformance 登记与基线口径

- `run.ts` 末尾追加 `slice-19-admin-rbac-audit`；`baselines.json` 的 `full` 行**按 CI 首轮实测回填**（本机读数不回填；若实现后证实「零分支零跳过」可按静态计数回填并写明依据——照 slice-18 先例二选一，**实施时在提交信息里写明选了哪种**）。
- slice-19 对环境的要求：管理面可用（`ADMIN_PASSWORD=conformance-admin-pass` 起栈 → 首启自动建 `admin`）；**互不污染**：对引导号 `admin` 只读不动口令（改密/停用类用例全部用一次性账号）。

---

## 8. 部署、回滚与明确不做

- **无 compose/env/端口变更**；`.env` 的 `ADMIN_PASSWORD` **值不动**（语义变）。
- 发布后：管理面**全员重新登录**（旧令牌无 claims ⇒ 401）；首启自动建 `admin`（= 现有 `ADMIN_PASSWORD`）→ 手册指引「登录后立刻改口令 + 建号」。
- **回滚安全**：旧二进制忽略四新表，`ADMIN_PASSWORD` 老语义照常可用——回滚无需数据处理。
- 明确不做：见设计 §1.2（支付/风控/记录管理面/自定义权限/令牌吊销/审批流/新指标/对账历史）。

---

## 修订记录

- **v1.0**（2026-10-05，`048d9ea`）：初稿（承接设计 v1.1.1；⚙️1–16 起草地就定）。
- **v1.1**（2026-10-05，`c6eaeef`）：规格 r1 评审（**零阻断；7🟡 + 9🟢；锚点/事实核验 35+ 处全命中 + 真栈实证 2 项**）**全数处置**——**S1 尾斜杠越权（真栈实测）⇒ 新增 ⚙️17 路径归一（剥全部尾斜杠）+ C10 尾斜杠负例** / S2 用户名正则改 `protocol/src/admin.ts` 单一真源（三校验处；登录不跑正则——清除两读法） / S3 CSV 算法改 `protocol/src/csv.ts` 五面共用（不再挂 currency 私有件） / S4 新增 ⚙️18 分页统一（缺省 50 上限 100、`{rows,nextCursor}`、无存在性预查） / S5 自锁闸 1 改「任何自身角色变更一律拒」（消除「更低」两解） / S6 协议引用对齐实况（内核 reason ≤255；1..200 是端点预闸） / S7 锁定读判据落地（SQL 全文单测钉 + 并发负例全部改挂 slice-19；删「双会话单测」不实载体） / S8 clientIpFrom 三参形态 + peer 派生 helper 平移 / S9 ⚙️6 补 actor 维 / S10 compose/`lib/http.ts` 注释与 design.md J18 闸扫描面进同步清单 / S11 hatch env 档 stdout 形态 / S12 scrypt 线程池注记 / S13 summary 驱动回值型别钉 / S14 §2.14 闸 3 行订正 / S15 三处锚点与同名文件消歧（新增件 `src/admin/accounts.controller.ts`）/ S16 白名单边界补全 + 两处 400 文案落字。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-spec-r1.md`。
- **v1.1.1**（2026-10-05，`7fa7730`）：规格 r2 复核（14/16 ✓；S1 不完整 ⇒ **N1**、S15c ⇒ N5）**全数处置**——**N1（🟡）归一射程收窄**：⚙️17 明确「仅 policy 匹配用归一值；豁免判定与 `isAdminPath` 用原值」⇒ `POST /api/admin/login/` 401 fail-closed、失败桶无旁路（选评审 B 解；C11 补钉子）；N2 C4 载体改「单测 + slice-14 C6」（空 env 场景归属订正）/ N3 ⚙️18 计数改「四个分页面」（summary 无 cursor、accounts 列表不分页）/ N4 protocol `src/index.ts` 桶导出补两行入清单 / N5 design.md `:404` 标 §4.1 通信方式总表、`:1135-1138` 区间订正。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-spec-r2.md`。
- **v1.1.2**（2026-10-05）：**核销确认「可通过」**（N1–N5 = 5/5 正确处置；`POST /api/admin/login/` 行为链经逐环源码重走**无第二种读法**——无令牌 ⇒ 401/10002、带令牌 ⇒ P9 403，两态 fail-closed）+ 登记级微瑕 1 处照办（⚙️17 摘要行括注改「射程 = 仅 policy 匹配」，与 §2.10 第 0 步同义）。**规格到此冻结**。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-spec-r2-verify.md`。
- **v1.1.3**（2026-10-05）：**实现期波2评审 Critical#1 规格订正**（plan-mandated：旧稿 §2.3 形状上界 64 与 §2.2 列宽 32 内部矛盾 ⇒ 33–64 字符未知用户名走 miss 落事件时撞 `varchar(32)` 溢出、**未认证可打 500 且限流桶不计数**）——新增 **⚙️19**（形状上界 64→32，与列宽/正则上界对齐；>32 ⇒ 400 不落事件；**并补归一后长度守卫**——修复期发现 `toLowerCase` 扩长同族第二路径，如 `İ`）· §2.3 第 2/3 步逐字改 · C5 补边界回归（33 ⇒ 400 无事件行；32 未知 ⇒ 401 有事件行；`İ` ⇒ 400）· §6.2 G2 补「长名边界两例」。实现修复 = T3 修复提交 `3dc6538`。评审发现：`.superpowers/sdd/2026-10-05-admin-rbac-audit/`（波2任务评审报告）。
- **v1.1.4**（2026-10-05）：**实现期波3发现补契约**——§2.11 新增「**网关透传**」条（CSV 响应经 gateway `forward()` 按上游 `Content-Type: text/csv` 原样透传；JSON 路径语义不变）。源：T5 报告 §5.1（共享 `resp.json()` 会把 CSV 变 `application/json null`；计划无任务拥有——本片就地补契约 + T5 修复提交闭合 `d5f954e`）。
- **v1.1.5**（2026-10-05）：**实现期波4补契约**——§2.7 actor 段新增裁定：守卫按**写方法端点**统一强制 `x-admin-actor`（含 `reconcile/run`；网关恒注入、不落审计行；新增写方法端点自动继承）。源：T6 报告疑虑①（行为已落地、规格未点名）。
- **v1.1.6**（2026-10-05）：**实现期波5真栈订正**——§2.6 锁定读 SQL 字面补 **`key` 反引号**（MySQL 保留字；旧稿裸写 ⇒ 真栈 ER_PARSE_ERROR 1064、配置 PUT 全 500；T10 真栈联测发现、T4 修复提交 `67939b3` 闭合）。同族：v1.1.5 无涉；本订正只改字面、语义（锁定读写序）不变。
- **v1.1.7**（2026-10-05）：**波5评审 Important#1 订正**——§2.6 第③句 INSERT 的列名 `key` 补同款反引号（v1.1.6 漏改③；实现与测试自 FixB 起即反引号版，规格与其对齐——「规格=唯一依据」层不得留同机制裸字面）。
- **v1.1.8**（2026-10-05）：**整支终审 F1（Critical）订正**——新增 **⚙️20**（admin 路径识别大小写不敏感）+ §2.10 处理序第 2 步括注 + C10/C11 补大小写变体负例。源：`review-final-opus.md` F1（真栈实证大小写变体直通登录处理器、失败桶被旁路）；实现 = T5 修复提交（同步补网关单测与 slice-19 负例）。
