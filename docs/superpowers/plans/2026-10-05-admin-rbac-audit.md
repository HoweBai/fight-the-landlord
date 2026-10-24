# ③ 财务后台 + RBAC + 审计（P2-③）实施计划 v1.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 把管理面从「单口令」升级为「多账号 + 四角色 RBAC」，并交付财务后台（看钱：流水/汇总/对账/池水位/冲正/CSV）与审计（看人：配置变更/资金操作/登录事件/账号变更）——P2 三步走的最后一步。

**架构：** 账号/登录/审计落 **config-service**（四张新表 + scrypt + claims 令牌）；钱的读写落 **currency-service**（只读聚合 + `admin_reverse` 冲正经 `currency.apply` 唯一写边）；**授权单点 = 网关**（`admin-policy.ts` 显式枚举 + 非 GET 未登记 fail-closed + 身份头剥/注入）；管理页加三视图。**无新服务、无新容器、无新 env。**

**技术栈：** NestJS 11 · TypeORM 0.3 + mysql2 · node:crypto scrypt · jsonwebtoken（既有）· vitest · pnpm + turbo · conformance（`slice-19`）。

## Global Constraints（每条任务隐含，逐字遵守）

- **上游唯一**：设计 `docs/superpowers/specs/2026-10-05-admin-rbac-audit-design.md`（v1.1.1）+ 规格 `…-admin-rbac-audit-spec.md`（**v1.1.2，已冻结**，⚙️1–⚙️18）。任务的规格点以「任务总表『判据』列 + 任务→规格节对照表」为入口，落 C/⚙️ 与规格节级；**不认领的行不得顺手实现**。
- **判据只增不减**；任何「恰 N」断言改数字必须**同提交**改断言本体；改了会被某闸扫描的文件 ⇒ 改完必须跑那条闸（`docs/design.md` 行会被 J18 闸按原文扫描——重写 :192 必须保全 `ADMIN_PASSWORD` 字面）。
- 每次改动**一个提交**（结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）。
- **任何「跑了」的表述必须指向本次产生的日志**；证据入 `.superpowers/sdd/2026-10-05-admin-rbac-audit/progress.md` 核销表。
- 迭代期**只跑受影响包**测试；六阶段（`pnpm run ci`）只在 push 前跑一次；全序 conformance 只在验收跑一次。
- **不新增 npm 依赖**；**禁新增跨服务 workspace 依赖**（用户名正则/CSV 算法一律走 `protocol`——新增私有包 import 会撞 `dockerfile-workspace-copy` 闸）。
- DI 要注入的类型**值导入**（`import type` 容器启动即崩）；控制器/服务**必须在某 `*.module.ts` 注册**（否则单测绿、真容器 404）。
- **wire 一律 epoch ms**（`toEpochMs` 先例）；**服务进程 TZ 必须 UTC**（容器默认；⚙️1 环境依赖，不改 compose TZ）。
- 迁移号 `1789900000000`（既有 …200/…500/…700/…800 之外的下一个空号，不得再选）；**裸 SQL**（不用 TypeORM entity；锁定读 `FOR UPDATE` 全文被单测钉）。
- admin 面错误信封 = `{code, message, data:null}`；**403 一律配 `10003`**（`CodedForbidden` 注释：10003 必须配 403 不能配 401）；参数/冲突/不存在**借 `10001` + 精确文案**；`400`（形状/格式）与 `401`（凭据）边界照规格 §2.3/§8。
- **admin 页零 `innerHTML`**（一切数据渲染 `textContent`）；只按 HTTP status 分流、不读 body.code；时间展示北京时间。
- ⚠️ **归一射程纪律（⚙️17/N1）**：policy 匹配用剥尾斜杠后的 `normPath`；**豁免判定与 `isAdminPath` 用原值**——`POST /api/admin/login/` 必须 401 fail-closed，且登录失败桶判定保持原值精确匹配。
- 已知假红先单跑确认（`ci-flake-known` ②⑤ 族），**别「重跑直到绿」**。
- push/上线由协调者与用户动作决定；本片完成态 = 三 workflow 三绿 + 终审 + 交接文档。

**开工必读（每任务开始时先读）：** 规格 §0.3（⚙️1–18）+ 任务→规格节对照表点名节；设计 §2 D1–D7 与本片 §0 用户四裁。

## 任务 → 规格节对照（任务卡引用入口）

| 任务 | 规格节 |
|---|---|
| T1 | §1.1 protocol 行 · §2.8 协议段 · §2.11（csvCell 算法）· ⚙️7/⚙️8 |
| T2 | §2.1（scrypt）· §2.2（DDL）· §2.4（含闸 1/2/3 逐字）· ⚙️1/⚙️8/⚙️10/⚙️11/⚙️15 |
| T3 | §2.3（处理序逐字）· §2.13（bootstrap/hatch）· §2.14（失败矩阵）· ⚙️3/⚙️4/⚙️13/⚙️14/⚙️16 |
| T4 | §2.5（三读口 + CSV 变体）· §2.6（留痕）· §2.10（query 白名单）· ⚙️9/⚙️18 |
| T5 | §2.10（处理序 0–7 + P 表 + 白名单 + clientIp）· §2.3（限流扩边）· §2.14 · ⚙️2/⚙️4/⚙️17 |
| T6 | §2.7（三 SQL 逐字 + 型别钉）· §2.11（CSV 两面）· ⚙️1/⚙️18 |
| T7 | §2.8（端点契约 + ⚙️6 重复语义）· §2.14（映射） |
| T8 | §2.7（reconcile 两端点）· §5.7=设计臂 · ⚙️5 |
| T9 | §2.9 |
| T10 | §2.12（视图/导航/文案/编码纪律）· ⚙️12 |
| T11 | §3（C 表 E2E 面）· §4.1（#1–#6）· §6.2（G1–G12）· §7（基线口径）· ⚙️16 |
| T12 | §4.2（含 J18/G11）· §8 |
| T13 | §3（C26/C27/C29）· §5（A1–A8）· §6.3 · §8 |

---

## 文件结构总览

```
新增
  packages/protocol/src/admin.ts                             # isAdminUsername()（单一真源）
  packages/protocol/src/csv.ts                               # csvCell() + CSV_BOM（五面共用）
  packages/config-service/src/migrations/1789900000000-AdminRbac.ts
  packages/config-service/src/admin/admin.module.ts          # 装配（bootstrap/accounts/audit/login-events/CLI 例外）
  packages/config-service/src/admin/admin-password.ts        # scrypt（hash/verify/参数/格式）
  packages/config-service/src/admin/accounts.controller.ts   # 账号 4 端点（⚠️ 与 src/config/admin.controller.ts 同名异径，动手前看清路径）
  packages/config-service/src/admin/admin-accounts.service.ts# CRUD + 自锁三闸 + 变更留痕
  packages/config-service/src/admin/admin-bootstrap.service.ts
  packages/config-service/src/admin/admin-changes.service.ts # 配置留痕读写
  packages/config-service/src/admin/audit.controller.ts      # config/changes + login-events 读口
  packages/config-service/src/admin/login-events.service.ts
  packages/config-service/src/admin-reset.ts                 # hatch CLI（编译产出 dist/admin-reset.js）
  packages/config-service/test/admin-{password,bootstrap,accounts,auth,reset,audit-read}.test.ts
  packages/api-gateway/src/auth/admin-policy.ts
  packages/api-gateway/test/admin-policy.test.ts
  packages/currency-service/src/admin/admin-finance.controller.ts   # ops/detail/summary/reverse/reconcile
  packages/currency-service/src/admin/finance-query.service.ts      # SQL 逐字收口
  packages/currency-service/test/admin-{finance,reverse,reconcile-admin}.test.ts
  packages/user-service 侧无新文件（扩 admin-users.controller.ts）
  admin 页无新文件（index.html/app.js/style.css 原地扩）
  tools/conformance/src/slices/slice-19-admin-rbac-audit.ts
修改
  packages/protocol/src/{currency.ts, index.ts} + 对应测试
  packages/config-service/src/config/{admin-auth.service.ts, admin.controller.ts, platform-config.service.ts} · app.module.ts + 测试
  packages/api-gateway/src/auth/{identity-headers.ts, admin.middleware.ts} · http/{http-rate-limit.middleware.ts, trusted-client-ip.ts} · gateway/{gateway.controller.ts, proxy.gateway.ts} + 测试
  packages/currency-service/src/{admin/admin-wallet.controller.ts, http/x-admin.guard.ts, reconcile/reconcile.service.ts, app.module.ts} + 测试
  packages/user-service/src/users/admin-users.controller.ts + 测试
  admin/{index.html, app.js, style.css}
  tools/conformance/src/{run.ts, lib/http.ts, slices/slice-14-config-center.ts, slices/slice-17-currency.ts} · baselines.json
  scripts/browser-e2e.mjs:629 · scripts/ledger-counts.mjs
  docs/design.md（四处）· docs/ops/first-deploy.md（三处）· docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md（M0.4）· docs/superpowers/specs/2026-10-03-currency-design.md（§12 回填 + G11）
  docker-compose.yml（仅 :245-247 注释行）
  .superpowers/sdd/2026-10-05-admin-rbac-audit/progress.md（核销表与证据）
```

## 任务总表（依赖 → 判据映射）

| 任务 | 一句话 | 依赖 | 判据 |
|---|---|---|---|
| T1 | 协议与共享件（`admin.ts`/`csv.ts`/allowlist `admin_reverse`/桶导出） | — | C20(协议面)·C22(csvCell) |
| T2 | 迁移四表 + scrypt + 账号 CRUD + 变更留痕 | T1 | C1·C2·C12·C13(闸1/2+SQL钉)·C14 |
| T3 | 登录改版 + claims + 登录事件 + bootstrap + hatch | T2 | C3·C4(单测侧)·C5·C6·C7(签发侧) |
| T4 | 配置留痕（锁定读）+ 审计三读口 | T2·T3 | C15·C16 |
| T5 | 网关面（归一/剥四/claims/policy/限流/白名单/clientIp） | T1·T3 | C7(网关侧)·C8·C9·C10·C11 |
| T6 | 财务读口（ops/detail/summary/CSV）+ adjust actor 接线 | T1·T5 | C17·C18·C19·C22·C24 |
| T7 | 冲正 | T6 | C20 |
| T8 | 对账面板（状态四字段 + 互斥 + 读写端点） | T6 | C21 |
| T9 | user-service `users/:userId` | T5 | C23 |
| T10 | 管理页（登录用户名/三角色导航/财务/审计/账号） | T2·T3·T4·T6·T7·T8·T9 | C25 |
| T11 | conformance `slice-19` + 既有片/脚本同步 + 基线登记 | T2–T10 | C4(slice-14 侧)·C5·C6·C8–C24(E2E 面)·C29 |
| T12 | 文档同步（design/first-deploy/roadmap/currency-design/台账） | T11 | C28 |
| T13 | 收口（六阶段/全序/终审/交接） | 全部 | C26·C27·C29·全表核销 |

---

### Task 1: 协议与共享件

**Files:**
- Create: `packages/protocol/src/admin.ts` · `packages/protocol/src/csv.ts` · 测试（`packages/protocol/test/admin.test.ts`、`csv.test.ts`，照 protocol 测试族惯例）
- Modify: `packages/protocol/src/currency.ts`（allowlist + 校验）· `packages/protocol/src/index.ts`（桶导出 :8-17 补两行）
- Test: protocol 既有测试族（`errors.test.ts` 等）+ 新两件

**Interfaces:**
- Produces: `ADMIN_USERNAME_PATTERN: string`（逐字 `^[a-z0-9][a-z0-9._-]{2,31}$`）· `isAdminUsername(s: unknown): boolean`；`CSV_BOM: string`（`'﻿'`）· `csvCell(v: unknown): string`（消毒判别式逐字 = 规格 §2.11）——**两服务经 `@fight-the-landlord/protocol` 使用，禁复制**。
- Produces（currency.ts）：`CURRENCY_SOURCES` allowlist 追加 `'admin_reverse'`；`validateCurrencyApply` 中 `admin_reverse` 与 `admin_adjust` **内核同规**（`actor` 非空 ≤64、`reason` 非空 ≤255——与 `currency.ts:152-167` 实况逐字对齐；**不得加 ≤200**）。

- [ ] **Step 0: 实施首日核销（规格 §4.1 #9）**——读 `tools/conformance/src/slices/slice-07.4-pipeline.ts`（或规格点名的文件集闸）确认本片新文件（protocol 两件等）不触被钉死集合；`container-assembly.gate.test.ts` 复核结论（规格 §4.1 #9 已给「动词不同无冲突」的预判）——读数入 progress。
- [ ] **Step 1: 单测先行**——`admin.test.ts`：合法/非法用户名（大写、全角、空白、len 2/32/33、前导 `.`）；`csv.test.ts`：表驱动（`=cmd` ⇒ 前置 `'`；`-12.5`/`-abc` 分支；含逗号/引号/换行转义；null/undefined ⇒ 空串）+ `CSV_BOM === '﻿'` + currency 校验：`admin_reverse` 缺 actor/reason 拒、reason 256 拒、delta 默认上限。
- [ ] **Step 2: 跑新测试确认红**（`pnpm --filter @fight-the-landlord/protocol test`）。
- [ ] **Step 3: 实现**（两新文件 + currency.ts 两处 + index.ts 两行 export；全部照规格逐字）。
- [ ] **Step 4: 跑 protocol 全测试确认绿**。
- [ ] **Step 5: 提交**——`feat(protocol): admin 用户名/CSV 共享件 + admin_reverse 协议面（③ T1）`。

### Task 2: 迁移四表 + scrypt + 账号 CRUD + 变更留痕（config-service）

**Files:**
- Create: `migrations/1789900000000-AdminRbac.ts`（四表 DDL 逐字 = 设计 §3；down 逆序 DROP）· `src/admin/admin-password.ts` · `src/admin/admin-accounts.service.ts` · `src/admin/accounts.controller.ts` · `src/admin/admin.module.ts` · `test/admin-password.test.ts` · `test/admin-accounts.test.ts`
- Modify: `src/app.module.ts`（注册 AdminModule + 迁移登记）

**Interfaces:**
- Produces: `ScryptParams`/`DEFAULT_SCRYPT_PARAMS`（`N:131072, r:8, p:1, keylen:32, maxmem:160*1024*1024`）· `hashPassword(plain, params?)` · `verifyPassword(plain, stored)`（格式 `s1$N$r$p$saltB64$hashB64`）；四端点形状逐字 = 规格 §2.4；**锁定读 SQL 常量全文**（闸 2）与**每动作留痕**。
- 账号表访问 = 裸 SQL（`dataSource.query`）；`accounts.controller.ts` 挂既有 `XAdminGuard` 复制形态（config 侧已有：`src/config/admin.controller.ts:59-74` 同款——本目录新守卫或复用，**授权矩阵不在服务侧**）。

- [ ] **Step 1: 单测先行（注入小参）**——`admin-password.test.ts`（格式/验证/损坏串 false/长度守卫/小参默认走参 + 一条默认参端到端）；`admin-accounts.test.ts`（CRUD 正反、冲突 409、校验 400 全档、**闸 1**「任何自身角色变更一律拒」+停自己、**闸 2** SQL 常量**全文相等**断言 + size==1 拒绝、**闸 3** 停用行仅改密码合法且 status 不变、四动作留痕行 + 多字段多行、列表无 `password_hash`）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 迁移 + 实现**（DDL 逐字；`accounts.controller.ts` 四端点 `@HttpCode(200)`；服务层事务：闸 2 锁定读在前、留痕同事务）。
- [ ] **Step 4: 真库迁移演练（G8 命令补全）**——① `docker compose build config-service && docker compose up -d --no-deps config-service`（**启动即跑迁移**：`migrationsRun: true` 先例，`app.module.ts:19`）→ ② 验四表：`docker compose exec mysql mysql -u$DB_USER -p$DB_PASSWORD fight_the_landlord -e "SHOW TABLES LIKE 'admin_%'; SHOW TABLES LIKE 'config_changes';"`（凭据取 `.env`）→ ③ down/复跑：`docker compose exec config-service pnpm --filter @fight-the-landlord/config-service migration:revert` 后再 up 一次（r2 注记②：root `.bin` 下无 typeorm，用包内脚本；若容器内路径仍有出入以 `ls` 实况修正并把最终命令记入 progress——**不得省略 revert 演练**）。读数入 progress。
- [ ] **Step 5: 跑 config-service 全测试确认绿**。
- [ ] **Step 6: 提交**——`feat(admin): 管理员账号四表/ scrypt /CRUD/留痕（③ T2）`。

### Task 3: 登录改版 + claims + 事件 + bootstrap + hatch（config-service）

**Files:**
- Modify: `src/config/admin-auth.service.ts`（口令比较 → 库；`signToken(claims)`）· `src/config/admin.controller.ts`（登录处理序逐字 = 规格 §2.3；`ADMIN_EXEMPT_ROUTES` 不动）· `src/app.module.ts`
- Create: `src/admin/login-events.service.ts` · `src/admin/admin-bootstrap.service.ts` · `src/admin-reset.ts`
- Test: `test/admin-auth.test.ts`（改版）· `test/admin-bootstrap.test.ts` · `test/admin-reset.test.ts`

**Interfaces:**
- Produces: 登录响应 `{code:0, data:{token, expiresIn:7200, username, role}}`；claims `{sub:String(id), username, role, aud:'ftl-admin', iat, exp}`；`AdminTokenClaims` 类型扩展（网关 T5 消费）；事件落行（仅形状合法后分支；`ip` 取 `x-client-ip` 头，缺 ⇒ NULL）；bootstrap 三态 + 日志逐字；`--role/--password/ADMIN_RESET_PASSWORD` 三档 stdout 逐字（规格 §2.13）。

- [ ] **Step 1: 单测先行**——登录矩阵（形状 400 / 未知 401 / 错口令 401 同文案 / 停用 403 / 成功 200 带 username+role；**空表 404**）；事件落行（成败/未知用户名/IP 列/形状 400 不落行）；bootstrap 三态 + **短口令照建仅 warn** + 幂等；CLI 建/复位/随机口令/stdout 两行/exit。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（处理序逐字；`isEnabled()` 改「表非空」查询）。
- [ ] **Step 4: 跑 config-service 全测试**（含既有 `admin.controller.test.ts` 的适配修改——**同提交**）。
- [ ] **Step 5: 提交**——`feat(admin): 账号登录/claims/事件/bootstrap/hatch（③ T3）`。

### Task 4: 配置留痕（锁定读）+ 审计三读口（config-service）

**Files:**
- Modify: `src/config/platform-config.service.ts`（`set()` 事务内 ①`SELECT … FOR UPDATE` ②更新/插入照旧 ③`INSERT config_changes`）· `src/config/admin.controller.ts`（PUT actor = `x-admin-actor`，缺失/非法 ⇒ 401 fail-closed）
- Create: `src/admin/admin-changes.service.ts` · `src/admin/audit.controller.ts`
- Test: `test/admin-audit-read.test.ts` + `platform-config.test.ts` 扩

**Interfaces:**
- Produces: `GET /api/admin/config/changes` · `GET /api/admin/login-events` · `GET /api/admin/accounts/changes`（过滤/keyset/`{rows,nextCursor}`/limit 50/100/未知 query 键 400「未知查询参数：<key>」——规格 §2.5/§2.10）+ **三者的 `.csv` 变体**（`changes.csv`/`login-events.csv`/`accounts/changes.csv`——`csvCell/CSV_BOM` 消费自 T1、BOM/CRLF/文件名/消毒逐字 = 规格 §2.11；白名单 = JSON 版去 `cursor/limit`，带上即 400）；PUT 留痕行 `{key, oldValue(可 null), newValue, actor}`。

- [ ] **Step 1: 单测先行**——留痕三态（旧值/首建 null/400 不落）+ `updated_by`=actor + **FOR UPDATE SQL 常量全文相等**断言；三读口过滤/分页/400；三 CSV（BOM 首字节/**行尾 CRLF**/消毒样本/文件名 `config-changes-<ts>.csv` 等三档）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（`set()` 唯一调用者是 admin PUT——改前全仓 grep 复核）。
- [ ] **Step 4: 跑 config-service 全测试**。
- [ ] **Step 5: 提交**——`feat(admin): 配置变更留痕 + 审计读口（③ T4）`。

### Task 5: 网关面（本片安全承重）

**Files:**
- Create: `packages/api-gateway/src/auth/admin-policy.ts` · `test/admin-policy.test.ts`
- Modify: `src/auth/identity-headers.ts`（3 常量 + `DownstreamHeaders` +3）· `src/auth/admin.middleware.ts`（归一射程/剥四/claims 校验/policy/注入三）· `src/http/trusted-client-ip.ts`（peer 派生 helper 平移）· `src/http/http-rate-limit.middleware.ts`（登录桶计 401+403、写桶非 GET）· `src/gateway/gateway.controller.ts`（新路由 ≈14 条 + query 白名单 + login 路径 clientIp）· `src/gateway/proxy.gateway.ts`（新头映射）
- Test: `admin.middleware.test.ts` 扩 · `http-rate-limit.test.ts` 扩 · `gateway.controller.test.ts` 扩

**Interfaces:**
- Produces: `admin-policy.ts` 的 `authorizeAdmin(opts: {method, normPath, role}): boolean`（规则 P1–P9 显式枚举、按序首中；**输入为归一后路径**）；归一函数 `normalizeAdminPath(path): string`（剥全部尾斜杠）；头名常量；限流键不变。
- Consumes: claims 型（T3 产出）——⚠️ **网关侧本地声明同形 interface（不跨服务 import config-service 类型）**；两侧同形由「登录响应端到端 + 网关验收」判据钉（G3；同 `aud` 字符串两侧各写一份的既有先例，`admin.middleware.ts:23-25` 与 `admin-auth.service.ts:17-29`）。

- [ ] **Step 1: 单测先行**——policy P1–P9 逐条正反（四角色 × 每写端点；`GET /accounts` 超管限定；**尾斜杠负例** `GET /api/admin/accounts/` 归一后中 P1 ⇒ 非超管 403 不落 P8；未登记非 GET 403）；middleware（**`POST /api/admin/login/` ⇒ 401 且不达处理器**（豁免用原值）；剥四枚伪造；claims 缺/坏 ⇒ 401 10005；验真后注入三枚）；限流（401+403 计失败、200 清；**非 GET 全部进写桶**）；gateway.controller（新路由登记/未知 query 键 400/clientIp 仅 login 路径有值）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（处理序 0→7 逐字 = 规格 §2.10；P 表逐条转代码）。
- [ ] **Step 4: 跑 api-gateway 全测试**。
- [ ] **Step 5: 提交**——`feat(gateway): admin RBAC 单点授权 + 身份头三枚（③ T5）`。

### Task 6: 财务读口（currency-service）

**Files:**
- Create: `src/admin/finance-query.service.ts`（ops 列表/详情/summary 三 SQL 逐字 = 规格 §2.7，全文被单测钉）· `src/admin/admin-finance.controller.ts`（本任务先落 ops/detail/summary + 两 CSV）· `test/admin-finance.test.ts`
- Modify: `src/http/x-admin.guard.ts`（写端点从 `x-admin-actor` 取 actor；**缺失/非法 ⇒ 401「管理身份缺失」**）· `src/admin/admin-wallet.controller.ts`（adjust 的 `actor:'admin'` 字面量 → 取头）· `src/app.module.ts`
- Test: `admin-wallet.controller` 既有测试适配（actor 头注入 mock）

**Interfaces:**
- Consumes: `csvCell/CSV_BOM`（T1）、`x-admin-actor` 头（T5）。
- Produces: 三端点 + `ops.csv`/`summary.csv`（BOM/CRLF/文件名/50k 上限/消毒——规格 §2.11）；`reversed` 旗；`{rows,nextCursor}`；summary `k`=字符串、`delta/flowCount`=数字（驱动回值转换）。

- [ ] **Step 1: 单测先行**——ops 六过滤/keyset/reversed(EXISTS)/limit 边界/未知 query 400；SQL **全文相等**断言；详情多账户 op/404；summary 两态/+08:00 切天（跨日样本）/空窗/型别；两 CSV（BOM 首字节/**行尾 CRLF**/消毒样本/文件名 `flows-<ts>.csv`、`summary-<ts>.csv`/50k 400）；**actor 缺头 ⇒ 401**（adjust 与读面区分）。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑 currency-service 全测试**。
- [ ] **Step 5: 提交**——`feat(admin): 财务读口 ops/summary/CSV + actor 接线（③ T6）`。

### Task 7: 冲正

**Files:**
- Modify: `src/admin/admin-finance.controller.ts`（`POST /api/admin/wallet/reverse`）
- Test: `test/admin-reverse.test.ts`

**Interfaces:**
- Consumes: `admin_reverse` 协议面（T1）、`ApplyService`、ops 行形状。
- Produces: 冲正全链（`actionId='admin:reverse:<opId>'`、`refId`=原 action_id、entries=原 flows 取负、`replayed` 语义按 ⚙️6、映射 14001/14002/404/409）。

- [ ] **Step 1: 单测先行**——正例（actor/refId/entries）；已花费 14001 原子拒；**同操作者同原因重放 200**；**异原因/异操作者 ⇒ 14002 409「该操作已冲正」**；非 `admin_adjust` 409「该操作不可冲正」；不存在 404；reversed 旗翻转。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑 currency-service 全测试**。
- [ ] **Step 5: 提交**——`feat(admin): 冲正 admin_reverse 全链（③ T7）`。

### Task 8: 对账面板（currency-service）

**Files:**
- Modify: `src/reconcile/reconcile.service.ts`（`lastAttemptAt/lastSuccessAt/lastResult/lastError` 四字段 + `inFlight` 旗；定时轮遇旗跳过 + warn；失败轮刷 `lastAttemptAt`+`lastError`）· `src/admin/admin-finance.controller.ts`（`GET/POST …/reconcile[/run]`）
- Test: `test/reconcile-admin.test.ts` + `reconcile.test.ts` 兼容确认

**Interfaces:**
- Produces: `GET` 四字段 + `running`；`POST run` 在跑 ⇒ 409「对账正在运行」、否则返回一轮读数；`runReconcileOnce()` 签名不变（现测试兼容）。

- [ ] **Step 1: 单测先行**——四字段初值 null/成功后刷新/失败轮只刷 attempt+error；互斥（手动遇旗 409；定时遇旗跳过不写 attempt）；`runWithTrace` 包裹次数不叠。
- [ ] **Step 2: 跑测试确认红**。
- [ ] **Step 3: 实现**（旗的 set/finally 位置照规格 §2.7；现 `reconcile.test.ts` 全过为兼容判据）。
- [ ] **Step 4: 跑 currency-service 全测试**。
- [ ] **Step 5: 提交**——`feat(admin): 对账面板状态与手动触发（③ T8）`。

### Task 9: user-service `users/:userId`

**Files:**
- Modify: `packages/user-service/src/users/admin-users.controller.ts` + 测试扩
- Test: `test/admin-users.test.ts` 扩

**Interfaces:**
- Produces: `GET /api/admin/users/:userId` → `{userId, phone, nickname, status, createdAt(ms)}`；length 1..36 外 400 借 10001；miss 404 `11004`。

- [ ] **Step 1: 单测先行**（在/不在/参数三态）。
- [ ] **Step 2: 红 → 实现 → 绿**（`findById` 既有）。
- [ ] **Step 3: 提交**——`feat(admin): users/:userId 查询（③ T9）`。

### Task 10: 管理页（admin/）

**Files:**
- Modify: `admin/index.html`（登录用户名框 + 三视图壳）· `admin/app.js`（登录/导航角色/财务/审计/账号/文案）· `admin/style.css`（表格）
- Test: 无自动化 UI 测试（现有形态）；静态串断言由 T11 的 slice-19 承载

**Interfaces:**
- Consumes: 全部端点（账号 CRUD=T2 · 登录/事件=T3 · 审计三口=T4 · 财务读口=T6 · 冲正=T7 · 对账=T8 · users/:userId=T9）；`{token, username, role}` 登录响应；`sessionStorage` 键 `ftl-admin-token`（沿用）/`ftl-admin-username`/`ftl-admin-role`。
- Produces: 视图/导航/文案逐字 = 规格 §2.12；**零 innerHTML**；时间北京；404/403 新文案。

- [ ] **Step 1: 结构**——登录卡加用户名；导航五视图按角色显隐；404 文案改「管理面未启用（未创建任何管理员账号）」+ 403 分支「账号已停用，请联系超级管理员」。
- [ ] **Step 2: 财务视图**（筛选条/流水表/加载更多/详情展开/冲正弹窗（admin_adjust 且未冲正）/汇总卡/池卡/对账面板/导出按钮——下载走 fetch+blob 带 Bearer）。
- [ ] **Step 3: 审计视图**（四页签）+ **账号视图**（表格/建号/改角色/停用启用/重置口令）。
- [ ] **Step 4: 真栈联测 + 自检（P5/G9）**——起栈用**唯一配方** `bash scripts/conformance-stack.sh up`（管理面口令 `ADMIN_PASSWORD=conformance-admin-pass` 由该脚本供给；**首启 bootstrap 自动建号 `admin`**；若存量卷口令对不上 ⇒ 用 hatch 复位（规格 §2.13）并记录处置）。浏览器实测：登录/三角色导航切换/财务三块/冲正弹窗/CSV 下载实开；自检清单：console 零报错、昵称等文本按 `textContent` 渲染（DevTools 抽查）、时间显示北京时间。证据（截图/日志）入 progress。
- [ ] **Step 5: 提交**——`feat(admin-ui): 财务/审计/账号三视图 + 账号登录（③ T10）`。

### Task 11: conformance `slice-19` + 既有片与脚本同步

**Files:**
- Create: `tools/conformance/src/slices/slice-19-admin-rbac-audit.ts`（G1–G12 组 + 收尾，断言零 skip 零分支）
- Modify: `src/run.ts`（末尾追加）· `lib/http.ts`（`adminLogin()` body `{username:'admin', password:ADMIN_PASSWORD}` + :203-207 注释改失效说明）· `slices/slice-14-config-center.ts`（C6 重写 = ⚙️16 逐字；C15 body 改形，429 断言保持）· `slices/slice-17-currency.ts`（如需——C11 actor 断言字面仍绿，复核为准）· `scripts/browser-e2e.mjs:629`（登录体）· `baselines.json`（登记条目；读数 **CI 首轮回填**）
- Test: 本机声明切片 + 受影响切片

**Interfaces:**
- Consumes: 全部端点与 `adminLogin` 改版形态；**slice-19 只读不动引导号 `admin` 的口令**（改密/停用类用一次性账号；收尾停用留档）。

- [ ] **Step 1: `lib/http.ts` + `browser-e2e.mjs` 改版**（一处改、全部消费切片跟随）。
- [ ] **Step 2: slice-14 C6/C15 重写**（⚙️16 形态）。
- [ ] **Step 3: 写 slice-19**（G1 起手…G12 静态串；**G6 内含「第二账号发 adjust ⇒ `ops.actor`=其用户名」**——防「读了固定值」的假绿，规格 §4.1 #4；并发负例：互降 PATCH ×2、PUT ×2 链式断言）。
- [ ] **Step 4: 本机真栈跑**——`node dist/run.js slice-19-admin-rbac-audit` **连续两跑** + 受影响切片（06/07.1/07.2-hardening/12/13/14/15/17/18）逐片单跑（记录读数入 progress；**假红先单跑确认**）。
- [ ] **Step 5: baselines/run.ts 登记 + 提交**——`test(conformance): slice-19 + 既有片同步（③ T11）`。

### Task 12: 文档同步（防文档谎报）

**Files:**
- Modify: `docs/design.md`（:192/:404/:1055/:1135-1138 四处重写；**:192 保全 `ADMIN_PASSWORD` 字面（J18 闸）**——改完跑 `packages/shared` 的 `design-md-ai-rollout.gate.test.ts`）· `docs/ops/first-deploy.md`（:234 + 911-954 全面重写 + 1206-1267 登录示例）· `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`（M0.4 标完成）· `docs/superpowers/specs/2026-10-03-currency-design.md`（§12 回填 + G11 口径偏离登记）· **`docs/superpowers/plans/deviation-ledger.md`**（台账条目：本片新增判据/偏离登记——G7 订正：`scripts/ledger-counts.mjs` 是**只读校验器**，改它是错的；改完后跑它以自证）· `docker-compose.yml`（**:245-247 注释行**）

- [ ] **Step 1**：逐文件改（每处 diff 自读复核）。
- [ ] **Step 2**：跑 J18 闸 + ledger 计数脚本自证。
- [ ] **Step 3: 提交**——`docs(admin-rbac-audit): 管理面文档全域同步（③ T12）`。

### Task 13: 收口

- [ ] **Step 1**：全清单核销（规格 §3 C1–C29 逐条 → 载体证据入 progress.md 核销表；规格 §4 同步清单逐条；**验收条目 A1–A8 对位**：A1/A5=浏览器走查（T10 证据 + 增补）、A2=T7 单测 + slice-19、A3=T4/T6 + 手工、A4=Step 3 演练、A6=Step 2 + 全序、A7=Step 4+CI、A8=T12 diff 自读）。
- [ ] **Step 2：玩家面无回归（C27）**——跑改版后 `npm run e2e:browser`（`scripts/browser-e2e.mjs`，其管理登录体已在 T11 改版）；读数入 progress。
- [ ] **Step 3：真栈演练（C26/A4，P2 补）**——按**升级口径**在真栈演练：① 首启 bootstrap（以存量 `ADMIN_PASSWORD` 建 `admin`；**先造首启态：清空 `admin_accounts` 或另起新卷**——r2 注记①）② hatch 建号一次 + 复位一次（stdout 两行核销）③ 登录 + 建议改口令链路走通；证据（终端输出）入 progress。**存量卷口令对不上时先 hatch 复位再演。**
- [ ] **Step 4**：六阶段 `pnpm run ci`（push 前一次；绿）。
- [ ] **Step 5**：全序 conformance（验收一次；本机或 CI——按当期口径）。
- [ ] **Step 6**：**opus 整支终审**（对准设计 v1.1.1 + 规格 v1.1.2；零 Critical 为通过线）。
- [ ] **Step 7**：交接文档 `docs/superpowers/plans/2026-10-05-post-admin-rbac-audit-handoff.md`（状态/上线方/下一片候选）+ 提交。

---

## 自审记录（writing-plans 自检）

- **规格覆盖**：C1–C29 全有任务落点（C1/C2→T1·T2；C3–C7→T3·T5；C8–C11→T5；C12–C16→T2·T4；C17–C19·C22·C24→T6；C20→T1(协议)+T7；C21→T8；C23→T9；C25→T10(+T11 静态断言)；C26→T13 Step 3；C27→T13 Step 2；C28→T12；C29→T11·T13）；§4.1 硬闸清单 → T11（#1–#7）+ T2–T9（#8 服务单测族）+ T1 Step 0（#9 管线闸）+ T12（§4.2 文案/文档）；§5 A1–A8 → T13 Step 1 对位。
- **占位符扫描**：无 TBD；「如需」「复核为准」均给了判据指向（非占位）。
- **接口一致性**：`isAdminUsername`（T1 产 → **T2/T3(CLI)/T6(守卫)** 消费——G4 订正，网关不消费）；`csvCell/CSV_BOM`（T1 产 → T4/T6）；`AdminTokenClaims`（T3 产 → T5 **本地同形声明**不跨服务 import——G3）；头名三常量（T5 产 → T6 消费）；`{rows,nextCursor}`（T4/T6 统一）；SQL 常量命名（T2 闸 2 / T4 FOR UPDATE / T6 三 SQL）各任务自钉全文。
- **边界**：T10 浏览器联测（人工证据）与 T11 conformance（断言）不重叠；`lib/http.ts` 注释修改归 T11（该文件主改动者）；T13 Step 2/3 的演练证据独立入 progress。
- **任务右尺寸（G9 裁定）**：T5 保持单任务（Step 1 测试含三组〔policy/middleware/限流+路由〕，可分次跑）；T6–T8 三分合理（读/写/服务状态各自可独立回滚与评审）；T10 已在 Step 4 加自检清单。

## 修订记录

- **v1.0**（2026-10-05，`30fa510`）：初稿（T1–T13 + 判据映射）。
- **v1.1**（2026-10-05，`2274a5c`）：计划 r1 评审（**零阻断；5🟡 + 10🟢**）全数处置——P1 T10 依赖表订正（+T2/T4/T9，Consumes 补全）/ P2 C26 补 T13 Step 3 真栈演练（bootstrap+hatch 证据产出）/ P3 C27 补 T13 Step 2 `e2e:browser` / P4 slice-19 G6 点名「第二账号 actor」断言 / P5 T10 起栈配方改 `conformance-stack.sh up` + 口令供给与存量卷处置；G1 规格版本改 v1.1.2 / G2 新增「任务→规格节对照」表（Global 措辞对齐）/ G3 claims 本地声明注记 / G4 isAdminUsername 消费者订正 / G5 CRLF 与文件名断言补 T4/T6 / G6 §4.1#9 改入 T1 Step 0（首日）/ G7 台账改 `deviation-ledger.md`（ledger-counts 只读）/ G8 T2 Step 4 命令补全（build/up/验表/revert）/ G9 右尺寸裁定记录 / G10 A1–A8 对位入 T13。评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-plan-r1.md`。
- **v1.1.1**（2026-10-05）：r2 **核销确认「可通过」**（15/15 正确处置，零新矛盾）+ 登记级注记 3 条照办——① T13 Step 3 首启态前置（清表或新卷）② T2 Step 4 revert 改包内脚本 `pnpm --filter … migration:revert`（root `.bin` 无 typeorm）③ 自审两处措辞订正（#8=服务单测族、T5 Step 1 三组可分次跑）。**计划到此冻结，进入实现期。** 评审报告：`.superpowers/sdd/2026-10-05-admin-rbac-audit/review-plan-r2.md`。

## 执行方式

- 逐任务派 **sonnet 实现者**（任务卡 + 规格点名节为准），每任务完成即提交；**每波（2–3 任务）一次 review**（sonnet，发现式），修复轮聚焦测试。
- 迭代期只跑受影响包；**六阶段只在 push 前跑一次**；全序只在验收跑一次（发现整序级问题先批处理修复再复跑）。
- 实验证据纪律：任何「跑了」必须指向本次日志；progress.md 核销表随任务更新。
