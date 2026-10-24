# 规格：客户端接入开关（App / H5 整端准入闸）v1.2

- 日期：2026-10-15 · 分支：`feature/minor-optimizations` · 状态：**定稿**（收口复评 r2「可以定稿」，3 处随版小疵已订正）
- 修订史：v1.0 → 规格评审 r1「修后再评」（5 重要 + 5 次要，关键条经抽查复现）→ **v1.1 逐条处置**（处置 = 文内 ⚠️ 标记）
  → **收口复评 r2「可以定稿」**（3 处随版小疵：C8 词界与桶界、C34b 落点、两处行号 ⇒ **v1.2 已订正**）
- 依据：设计 `docs/superpowers/specs/2026-10-15-client-access-gate-design.md` **v1.5（v1.3 四轮评审闭环 + v1.4/r5 规格联动订正）**。
  本规格把设计落成**逐条可验证判据**；设计与规格冲突时以设计为准并回改本文件。

## §0 命名钉子（实现与判据共用，⛔ 不许就地变体）

| 项 | 精确形态 |
|---|---|
| HTTP 头名 | `X-Client-Platform`，值恰 `app` / `h5`（小写；其余一律未识别） |
| socket 字段 | 握手 `auth.clientPlatform`（与既有 `auth.token` 同对象） |
| 配置键 | 第 43/44 键：`client.appEnabled` / `client.h5Enabled`（严格 boolean、种子 `true`、客户端不可见） |
| 错误码 | `CLIENT_DISABLED = 10008`；`CLIENT_ACTION` = **`TOAST`**（备选 `BACK_TO_LOBBY` 未采纳） |
| 文案（单一真源） | `net/copy.ts`：`当前客户端已暂停服务，请稍后再试或更换客户端`。**显示链（⚠️ r1 重要 2 订正）**：登录面照 **11003 先例**在 `stores/auth.ts` 加 10008 分支**以客户端文案为准**（服务端 message 不作显示承诺——`auth.ts:161` 服务端 message 优先，short 串会与其余三面不一致）；socket 兜底与两死态组件同串复用 |
| 计数器 | `client_gate_blocked_total{platform}` / `client_gate_unidentified_total`（经 `shared createCounter`，单例注册表纪律） |
| 网关 RPC env | `CONFIG_SERVICE_RPC_HOST=config-service` / `CONFIG_SERVICE_RPC_PORT=3106`（照五消费者先例显式写） |
| 安全网 | 广播即刷 + **≤60s 兜底**（照 `config-cache.service.ts` 模板值） |

## §1 判据表

验证方式图例：【单测】vitest ·【静态闸】`verify-admin-static.mjs`/相关扫描闸 ·【conformance】真栈片 `slice-26`（+登记） ·【全序】相关既有片 ·【人工】用户侧 ·【实读】服务器/容器实证。

### A. 配置面

| # | 判据 | 验证方式 |
|---|---|---|
| C1 | `CONFIG_KEYS` 恰 44 键，第 43/44 为 §0 名；`config.test.ts` 逐字字面量表与标题（「四十二」同改为「四十四」）同步 | 【单测】 |
| C2 | `parseConfigValue` 两分支：`true`/`false` 通过；非 boolean（`'true'`/`1`/`[]`/`''`）判非法（同既有「严格 boolean」族）——正负样本各喂一次 | 【单测】 |
| C3 | 种子迁移（照 `EntryFeePercentsSeed` 形态）：全新库迁移后两键在 `platform_config`、值 `true`、迁移记录在位；`migration.test.ts` 新块 | 【单测】 |
| C4 | 管理写面可写两键（true↔false 双向）；快照 version 递增；非 bool ⇒ 400（同族语义）；**翻转 ⇒ `config_changes` 同事务留痕（key/old/new/actor，⚠️ r1 重要 5：审计**已存在**：`platform-config.service.ts:163-170` + 读面 `audit.controller.ts` `GET /api/admin/config/changes`）** | 【单测】+【conformance】 |
| C5 | 管理端 IA：新域「客户端接入」（导航叶在场——**新叶 id `nav-cfg-client-btn` 须加进 `scripts/verify-admin-static.mjs:119-124` 必需 id 清单**，⚠️ r1 次要 7）+「端开关」页签两行、META `type: 'bool'`；不落未分组桶 | 【静态闸】 |
| C6 | 静态闸计数面全部同步且实报绿：`42→44`、`37→39`、BOOL `10→12`、合计断言（`:277-280`）`37→39`、数字键 26 不动、「配置域 5 叶→6 叶」（+「5+1 配置叶」注释族 `admin/app.js:952/1798/4454`，⚠️ r1 次要 7） | 【静态闸】 |
| C7 | `CLIENT_CONFIG_KEYS` 仍恰 16 键（新键**不进**；客户端子集断言不被扰动） | 【单测】 |
| C8 | 42→44 全仓收口（⚠️ r1 重要 1 重定义；⚠️ r2 次要 1 补词界与桶界）：**双面 grep** = 阿拉伯 `\b41\b/\b42\b/\b44\b`（**必须带词界**，否则端口/时间戳爆量）**∪ 中文「四十一/四十二键」族**（≥12 活面如 `gateway.controller.ts:127`、`client-config.controller.ts:22`、实体/服务注释族）。命中分三桶：① **键计数面**（「N 键 / N 键面 / N 条对 N 键」语义的活面注释与判据标签）⇒ 改；② **合法命中白名单**（序数注释 `config.ts:86/88`「第 41/42 键」追加后仍正确；测试造数 `slice-20:760/803/829` `registerUser(41…)`、`slice-16` 样本值 42；**其它无关数字类**：行号引用（「`main.ts:44`」）、布局常量（「left 44」）、时间估算（「≈41 分钟」）、断言计数（「41 条断言」）、依赖版本）⇒ **禁改**、逐条登记；③ 历史计划文档 ⇒ 不改。收口判据 = 三桶之外零命中 | 【全序】+【静态闸】 |

### B. HTTP 执法面（网关）

| # | 判据 | 验证方式 |
|---|---|---|
| C9 | 无头 ⇒ 放行（⚠️ r1 次要 6 订正：**开关全开态**下带头/不带头 login 行为一致——即闸对无头流量零影响；闸关态带头必 403 属 C10，非"一致"） | 【单测】+【conformance】 |
| C10 | `X-Client-Platform: app`：闸关 ⇒ 403+10008；闸开 ⇒ 正常（**双向**同一探针） | 【单测】+【conformance】 |
| C11 | `h5` 同上双向 | 【单测】+【conformance】 |
| C12 | 非法值（`App` / `APP` / `android` / 空串 / 超长 / 含换行与空白包裹）⇒ 一律未识别放行；头值**不进**未转义日志（九字段纪律不受扰）。⚠️ r1 次要 8：**「空白包裹」「含换行」两样本仅单测层可达**（真栈里 Node/llhttp 按 RFC 9110 剥首尾 OWS；含换行被解析器 400）——判据不得被读成线上行为承诺 | 【单测】（含注入样本负对照） |
| C13 | 三豁免**显式带头**仍通：`/api/admin/*`（以带头请求实测豁免本体）、`/api/health`、`/api/health/live`、`/api/config` | 【单测】+【conformance】 |
| C14 | 闸先于 jwt（单测层）：探针模块内无令牌 / 坏令牌 + 关闸端 ⇒ **10008**（不是 10002/10005）。⚠️ r1 重要 3：单测手搭 configure() 测不到**真链序** ⇒ 真链性质由 C14b + C37 补 | 【单测】 |
| C14b | **真链序的机械判据（新，⚠️ r1 重要 3）**：`app.module.ts` 的注册序列文本断言——`ClientGateMiddleware` 先于 `JwtMiddleware` 出现于同一 `apply` 链（读取源码文本 + 断言次序）；另 C37 真栈增真链探针 | 【静态】 |
| C15 | 拒绝信封 = 403 + `{code:10008, message, data:null}`（§11.2 形态，`CodedForbidden` 直出）。⚠️ r1 重要 2：**message 内容不作显示承诺**（显示由客户端分支覆盖，照 11003 先例；§0 显示链） | 【单测】+【conformance】 |
| C16 | 未识别流量行为逐字不变：GET/POST/OPTIONS 常规路径不受闸影响；OPTIONS 预检仍被 cors 短路且带 ACAO | 【单测】 |

### C. socket 执法面

| # | 判据 | 验证方式 |
|---|---|---|
| C17 | 握手 `auth.clientPlatform` 对应端关 ⇒ 断开且 settle 后**不** connected；开 ⇒ 正常建连。⚠️ r1 重要 4：**锚断连不锚帧**（`rejectHandshake` 的 `system.error` 自述 best-effort，权威信号 = 断开本身；照 `slice-07.2-hardening:940-949` 先例「不钉形态」）；帧级断言（收到 `system.error{10008}`）留【单测】mock 面。附：`tools/conformance/src/lib/client.ts:52` HarnessClient 的 auth 写死 `{token}` ⇒ 探针需扩该方法或片内直用 `io()` | 【单测】+【conformance（settle 不 connected）】 |
| C18 | 闸在 `verifyClient` **之前**：无 token + 关闸端 ⇒ 10008（不是 10002） | 【单测】 |
| C19 | **拦新不踢旧**：翻关后已连接 socket 的事件流照常收发；`allowRequest` 保持现状（不做端闸，注释登记结构约束） | 【conformance】 |

### D. 配置读取面（网关）

| # | 判据 | 验证方式 |
|---|---|---|
| C20 | 新 RPC `send` 带 `...metaFromTrace()`（既有扫描闸实报绿） | 【单测（既有闸）】 |
| C21 | 订阅走**专用连接**：共享 `REDIS` provider 无任何 `subscribe` 行为（结构钉子） | 【单测】 |
| C22 | 失败两态：已拉过快照后刷新失败 ⇒ **维持 last-good 执法**（关态不放门）；从未拉到（冷启不可达）⇒ 默认 `true` 放行 | 【单测（两态各一）】 |
| C23 | 生效延迟：写面翻转后广播即刷（真栈**有界轮询**断言 ≤5s）；安全网 ≤60s（丢广播形态：单测注入覆盖） | 【conformance】+【单测】 |
| C24 | env 登记：`docker-compose.yml` 网关块两 env 在场；`docs/design.md` §2.3 env 表含 api-gateway 持有行 | 【静态】 |

### E. 留痕/观测面

| # | 判据 | 验证方式 |
|---|---|---|
| C25 | 拒绝 ⇒ 结构化 warn 日志（platform / path / trigger=switch-off / traceId 四要素在场） | 【单测】+【conformance（日志实读）】 |
| C26 | 两计数器在 `/metrics` 可见且各自增量正确（slice-16 `curl :9000/metrics` 读数先例） | 【conformance】 |
| C27 | `unidentified` **排除三豁免路径**（带头/不带头打 admin/health/config 不增量）；⛔ 判据不得把它写成「某端流量」推断 | 【单测】 |

### F. 协议/错误码面

| # | 判据 | 验证方式 |
|---|---|---|
| C28 | 四处登记齐：`errors.ts` 枚举 / `CLIENT_ACTION` 表 / `errors.test.ts` SPEC_CODES / `docs/design.md` §11.2 表（两侧一致） | 【单测】 |
| C29 | 各服务 `http/errors.ts` 的 HTTP_STATUS 面**不**含 10008（无冗余登记） | 【静态】 |

### G. 客户端面

| # | 判据 | 验证方式 |
|---|---|---|
| C30 | `rest.ts` 全量请求带头：browser→`h5`、app→`app`、mp/未知**不带**；两处裸 `uni.request`（/version.json、外部收集端）**不注入** | 【单测】 |
| C31 | socket `auth.clientPlatform` 在场且（重）连重发（socket.io-client v4 行为断言） | 【单测】 |
| C32 | `socket.ts` 断线兜底：10008 ⇒ §0 文案（⛔ 不再直出裸码） | 【单测】 |
| C33 | 两死态组件 `canRetry` 均含 10008 ⇒ 保留「重新连接」；文案 = §0 串；**两组件同步**（同口径纪律） | 【单测】（既有测试只钉 10006/11003 ⇒ 本判据必须主动新增，防「照旧全绿无提示」） |
| C34 | `copy.ts` 10008 文案在场（单一真源；组件/兜底复用同串） | 【单测】 |
| C34b | **登录面显示覆盖（新，⚠️ r1 重要 2；⚠️ r2 次要 2 订正落点）**：**落点 = toast 处理路径**——10008=TOAST 经 `net/errors.ts:147-148` 分派后走 `handlers.toast`，覆盖发生在 `auth.ts:156-162` 的 toast handler（改掉 `report.message ||` 的优先序/该 handler 内对 10008 分支）。⛔ **不照 11003 的「位置」直搬**——11003 的 K1 分支在 `auth.ts:170-176` 是因为 BACK_TO_LOBBY 分支**只**调 signOutLocally（`auth.ts:167-170` 注释即该「分支不可达」教训原话）；照位置直搬会复刻同一教训。负对照：TOAST 兄弟码行为不动（`auth-ui-wiring.test.ts:186-190` 已有部分覆盖） | 【单测】 |
| C35 | 客户端构建面：`vue-tsc` + client 单测全绿（注入点类型面） | 【单测】 |

### H. conformance 新片（slice-26-client-gate）

| # | 判据 | 验证方式 |
|---|---|---|
| C36 | 片注册两处：`tools/conformance/src/run.ts` + `baselines.json`（⚠️ r1 次要 9：**真栈片只回填 `full` 列**——render 列每片须在 `ci.yml:50-54` 有纯渲染步骤且键集恰好相等，slice-25 先例只填 full；填 render ⇒ render-gate 响亮红） | 【conformance】 |
| C37 | 片内探针矩阵：{无头, app, h5, 非法值} × {开关开/关} + 三豁免（显式带头）+ 真 socket.io 探针 + 两计数器读数 + **真链序探针（新，⚠️ r1 重要 3：关闸端 + 无令牌 + 非豁免路径 ⇒ 10008≠10002）** + **收尾复原种子** | 【conformance】 |
| C38 | 判别力自证：片内正负对照（防探针空转）——「闸生效」与「全落未识别桶」可分辨（仿设计 §八.3：两计数器都要读） | 【conformance】 |

### I. 上线/验收面

| # | 判据 | 验证方式 |
|---|---|---|
| C39 | 暗上线零变化：种子 `true` 下存量探针（带头/不带头 login、socket）行为与现状逐字一致 | 【conformance】 |
| C40 | 部署：`deploy-dev.sh` 部署测试服 + 钉 IP 复核 + 目标容器内新代码实读（quirk 9 防空测） | 【实读】 |
| C41 | 人工验收（用户侧）：H5 **新开页**关闸文案；App 新包关闸；管理端照常；翻转后两计数器读数 | 【人工】 |

### J. 文档同步面

| # | 判据 | 验证方式 |
|---|---|---|
| C42 | 活面注释/判据标签收口（同 C8 双面 grep + 三桶法）：阿拉伯 41/42/44 ∪ 中文「四十一/四十二键」族 ∪ 「5+1 配置叶」族（`admin/app.js:952/1798/4454`）∪ `admin/index.html:72`「5 叶」；`app.module.ts:29-36` 「顺序即契约」注释随第 0 步同步 | 【静态】 |

## §2 实施纪律（写测试面的钉法）

1. **矩阵用表驱动**：B/C 组单测以 `[header值 × 开关态 × 路径]` 表驱动展开，每格一条断言；表内含负样本列。
2. **判别力自证**：凡新增「闸」类断言，必须带正/负对照（至少：闸关必拒、闸开必通、无头必放）——防「恒真/恒假」。
3. **conformance 片纪律**：探针含真端样本值；有界轮询（≤5s×N）代替 sleep 断言；收尾把两键复原 `true` 并复验；片内不得依赖本机特有面（Windows/域名 DNS 等）。
4. **文案/键名/头名以 §0 为准**，任何就地变体在评审时按缺陷处理。
5. **不可测项登记**（写进片注释）：存量 App 旧包的真实行为（无头）只能人工观测；`allowRequest` 结构约束不做断言、只登记。
6. **假红先单跑确认，别「重跑直到绿」**（⚠️ r1 次要 10；`ci-flake-known` 七类）：B/C 矩阵单测与真栈片首红先按形态判别（同一次 run 内同一文件跨阶段绿红 ⇒ 环境性）；一次未复现如实记「未复现」，不许隐去首红。
7. **任何「跑了/绿了」的表述必须指向本次产生的日志**（⚠️ r1 次要 10；2026-10-15 slice-21 恒假断言先例——「把没跑的写成跑了」在修复动作里会反复再生）；实现期每任务的交付物含本次日志/输出路径。

## §3 开放项（实现前定夺，登记不阻塞）

1. ~~config 写链无审计面~~ —— **⚠️ r1 重要 5 纠正：假事实。审计已存在、零工作**：写面 `platform-config.service.ts:163-170` 同事务写 `config_changes`（key / old_value / new_value / **actor**）；读面 `audit.controller.ts` `GET /api/admin/config/changes`（网关反代 + 管理端审计页签）。⇒ 翻转开关的追溯**天然覆盖**（含操作者）；C4 已把「留痕行」写成断言。原「本片不扩面」口径**撤销**（触发原因 = 我此前 grep 太浅、漏了 `src/admin/` 目录——该教训入实现期纪律：**「本树核实」类结论必须给出命中路径，空结果也要给扫过的面**）。
2. §0 文案措辞若用户要改，只动 `copy.ts` 单点（组件/兜底复用，不动结构）。
