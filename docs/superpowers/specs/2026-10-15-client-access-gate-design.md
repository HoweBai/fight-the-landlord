# 设计：客户端接入开关（App / H5 整端准入闸）v1.5

- 日期：2026-10-15 · 分支：`feature/minor-optimizations` · 状态：**可以定稿（终审 r5 确认，零新发现）—— 待用户审阅**
- 修订史：v1.0 → 评审 r1（sonnet）「修后再评」→ v1.1 逐条处置（8 重要 + 7 次要）→ 差量复评 r2「可以定稿」
  （4 标题/行号级小疵随版订正）→ **终审 r3（opus 独立新眼）「修后再评」（2 重要 + 6 次要，均经抽查复现）
  → v1.2 逐条处置** → **收口复评 r4「修后再评」（1 重要 + 1 次要，已抽查复现）→ v1.3 处置** →
  **收口确认 r5「可以定稿」（零新发现）** → **v1.4（规格评审 r1 联动订正）**：文案**显示链**订正——
  登录面服务端 message 优先（`stores/auth.ts:161`），短串会与 socket/组件两面不一致 ⇒ 照 11003 先例在
  `stores/auth.ts` 加 10008 分支**以客户端文案为准**（服务端 message 不作显示承诺）；§六 改动面补
  `stores/auth.ts`。**设计自此冻结**（后续改动只随实现期评审回改并记版本）→ **v1.5（规格收口复评联动）**：
  登录面覆盖的**落点订正 = `toast` 处理路径**（10008=TOAST 经 `net/errors.ts:147-148` 走 `handlers.toast`；
  11003 的 `auth.ts:170-176` 位置是 BACK_TO_LOBBY 专用——**照其原则（以客户端文案为准），⛔ 不照其位置**）；
  评审回执的「已核实无问题」清单见 §八.5
- 用户裁决（本设计前提，勿再动摇）：① 语义 = **整端封禁**（不是只挡登录）· ② **拦新不踢旧**（已在线不主动断）·
  ③ 识别方案 = **A2 显式标识头**（服务端 UA 嗅探 A1 已评估并放弃：用户选精度）

## 一、背景与实证（2026-10-15 实跑，真日志）

- 登录链路：客户端 `POST /api/auth/login` → 网关（公开路径）→ user-service。**请求目前不带任何端标识**。
- 真日志（服务器 edge 访问日志，`docker logs ftl-edge`）：
  - App（Android，uni.request）UA = `…Chrome/92…Mobile Safari/537.36 uni-app (Immersed/36.0) Html5Plus/1.0`
  - H5（桌面/手机浏览器）= 普通浏览器 UA
  - App 的 socket 握手 UA = `okhttp/3.12.11`；H5 的 socket 握手 = 浏览器 UA
- 结论：两端在服务端**可区分**，但 UA 差异「按请求路径分档」（HTTP 与 socket 不同指纹）且可伪造 ——
  用户裁决改用**显式标识头**（A2），UA 嗅探（A1）留作将来「A3 混合」升级素材。

## 二、方案总览

三层改动，边界清晰：

```
客户端（玩家端，唯一改动方）          服务端
┌────────────────────────┐   ┌───────────────────────────────────────┐
│ 统一网络层注入          │   │ ① 配置：client.appEnabled/h5Enabled    │
│  X-Client-Platform: h5 │──▶│    （第 43/44 键，boolean，种子 true）  │
│  socket auth.clientPlat│   │ ② 执法：api-gateway（唯一执法点）       │
│  错误文案 copy.ts       │   │    HTTP 中间件（最前）+ socket 握手闸   │
└────────────────────────┘   │ ③ 错误：CLIENT_DISABLED=10008 + 文案   │
                             └───────────────────────────────────────┘
```

- **默认全开（种子 true）= 现状**，零行为变化 → 暗上线友好。
- **管理端（admin 控制台）不改、不带头** → 天然落在「无标识 = 放行」桶；且执法面再显式豁免 `/api/admin/*` 双保险。

## 三、端识别设计（A2）

| 载体 | 字段 | 值 | 覆盖 |
|---|---|---|---|
| HTTP（全部 REST） | 头 `X-Client-Platform` | `app` / `h5` | H5 的 fetch 与 App 的 uni.request 都能带 |
| socket 握手 | `auth.clientPlatform`（与既有 `auth.token` 同族同对象） | `app` / `h5` | 浏览器 WebSocket 设不了自定义头 ⇒ 用 auth 载荷绕开；网关唯一验签点本就读 `auth` |

**服务端判定表（三桶）**：

| 输入 | 归属 | 过闸 |
|---|---|---|
| 头/字段 = `app` | app 桶 | 查 `client.appEnabled` |
| 头/字段 = `h5` | h5 桶 | 查 `client.h5Enabled` |
| 缺字段 / 其他值 | **未识别桶** | **永远放行**（fail-open）——管理端、监控探针、脚本、小程序（冻结）、未升级老 App 都在此桶 |

- 头名避开既有身份头族（**完整枚举** `identity-headers.ts:14-58`：`X-User-Id` / `X-Trace-Id` /
  `X-Token-Jti` / `X-Admin` / `X-Admin-Actor` / `X-Admin-Roles` / `X-Client-Ip` / `X-Internal-Token`），
  无功能冲突（评审 r1 核实）。
- ⚠️ 与身份头**性质不同**：其余头是「验真产物」（伪造会被剥），本头**天然是客户自报**，不做验真——
  这在「软开关」定位下是设计选择（见 §七 边界），文档与注释必须写明，防未来误当安全机制依赖。

## 四、配置设计

- **第 43/44 键**：`client.appEnabled` / `client.h5Enabled`——严格 boolean、种子 `true`、
  `客户端不可见`（不进 `CLIENT_CONFIG_KEYS`；v1 只做服务端执法，不驱动客户端 UI）。
- **管理端 IA**：新域「客户端接入」（组 = 通用设置），1 页签「端开关」两行（App 端 / H5 端）；
  新增导航叶按钮 + META 两条——全套照 IA 既有模式（`admin/app.js` CONFIG_IA + `admin/index.html` 导航叶）。
- **网关的配置读取（评审 r1 核实后落定）**：照 `payment-service/config-cache.service.ts` 模式新建加载器
  （拉取 + 订阅 `config:changed` 广播 + ≤60s 安全网 + 代码默认值 `true`），三点勘定：
  1. **通道 = 新建出站边**：`client.*` 不在 CLIENT_CONFIG_KEYS ⇒ `/api/config` 取不到；`/api/admin/config`
     要管理令牌 ⇒ 唯一通道 = **`config.snapshot` TCP RPC**。网关当前**零** RPC 边（无
     ClientsModule/ClientProxy），需新增（deps 已有 `@nestjs/microservices`）；⚠️ 新 `.send(` 必须带
     `...metaFromTrace()`——`room-service/test/meta-on-every-rpc-send.gate.test.ts:67-76` 的扫描面含
     api-gateway（有闸在扫，漏带会红）。**env 登记（终审 r3 次要 6）**：`docker-compose.yml` 网关块补
     `CONFIG_SERVICE_RPC_HOST/PORT`（其余消费者全显式写：currency `:322-323` / payment `:366-367`），
     并进 `docs/design.md` §2.3 env 表（r1-S-I7 纪律）——**不靠代码默认值静默回落**（回落形态 =
     宿主直跑/服务改名时冷启 fail-open 且无痕）。
  2. **订阅必须用专用连接**（`config-cache.service.ts:451-461` 的逐字纪律）：ioredis 进 subscribe 模式后
     不能复用共享连接；网关 `REDIS` provider 是 SessionGuard/限流/WS 名额**共用实例** ⇒ 向它
     `.subscribe()` = 登录验签/限流/名额**同时失效**（全网关 Redis 面挂）⇒ 专用连接，禁动共享实例。
  3. **失败语义（订正 v1.0 的自相矛盾——评审 r1 重要 8）**：**拉过快照后**刷新失败 ⇒ **保留 last-good
     继续执法**（关闸期间一次拉取失败**不**开门）；**从未拉到过**（含 config-service 不可达时冷启）⇒
     回落代码默认 `true` = 放行。两个实态如实登记：① 关闸期间读取失败 = 维持关闸；② 冷启且不可达 =
     闸自开（fail-open 的固有起点，可接受——防的是「开关机制把全网关拖瘫」，不是防冷启窗口）。
- 写入面/校验/种子走既有 config 机制（protocol `CONFIG_KEYS` + config-service + 管理端写面），无新通道。
- **42→44 的全仓引用面（评审 r1 核实后的精确清单；规格/计划逐项覆盖）**：
  1. `scripts/verify-admin-static.mjs`：`:187-188`（`42` ×2）、`:252`（`37`）、`:256-260`（BOOL `10` /
     数字 `26`，「42 键 = 37 简单 ∪ 5 结构化」注释同改）、**`:277-280`（合计断言
     `BOOL_KEYS.length + TEXT_KEYS.length + numberKeys.length === 37`）**、**`BOOL_KEYS` 清单本体
     `:200-211`（+2 枚）**——两枚布尔键 ⇒ **42→44、37→39、10→12**（数字键 26 不动）。
  2. conformance 真栈「42 键」断言共 **5 片 7 处**：`slice-18:1012` · `slice-20:142/721` ·
     `slice-22:950/1193` · `slice-23:735/1283` · `slice-24:795`。⚠️ **不是** slice-14/19——slice-14 的
     16 是**客户端子集**（不受影响）、slice-19 无此类断言（v1.0 指错位置，已订正）。
  3. `packages/protocol/src/config.ts:187-220` `parseConfigValue` 加两分支（否则管理写面 400
     「未知配置键」）；`config.test.ts:12-51` 是**逐字 42 键字面量**（测试标题「四十二键…」同改）——
     全仓**无任何 `CONFIG_KEYS.length` 派生断言**（评审 r1 核实：全是字面量，逐处手改）。
  4. config-service：新种子迁移（照 `1795200000000-EntryFeePercentsSeed.ts` 形态）+
     `test/migration.test.ts` 新块 + 种子**双副本**（`test/helpers/config-probe.ts:145`、
     `platform-config.service.test.ts:200-260`）+ `:316 toHaveLength(42)` +
     **两处逐字键集断言（终审 r3 重要 1 补）**：`test/admin.controller.test.ts:175`
     （题 :169「全量四十二键」，`Object.keys(config).sort()` ↔ 42 键字面量）与
     `test/config.rpc.test.ts:141`（config.snapshot 响应同型字面量块至 `:189`）——两份数据源同为
     `seedDb()`（此前指针面只列了它的种子副本、漏了这两处断言本体）。
  5. **活代码/活判据内注释与判据标签**同步 44（`gateway.controller.ts:127`「四十一键」、
     `platform-config.service.ts:45/57`、`platform-config.entity.ts:10`、`admin.controller.ts:101`、
     `admin/app.js:120/134/909` 与 CONFIG_NOTES、`admin/index.html:72`「配置域 5 叶」→6 叶、
     `client-config.controller.ts:22`、「41 键面」族（`notify-channel.service.ts:38` /
     `pay-channel.service.ts:36` / `ad-channel.service.ts:37`）、判据 step 标签
     （`slice-18:8`、`slice-20:5/717`、`slice-24:781`）、`app.module.ts:29-36`「顺序即契约」注释随
     第 0 步同步）——**⛔ 历史计划文档不改**（历史记载）；**实施时以全仓 grep「41/42/44」三数字收口，
     本清单只是抽样下限**（终审 r3 次要 7：41/42/44 三数字混杂会被后续读者据旧数字判断）。
  - ⚠️ 「客户端 ifc 类型面」**不存在**（客户端只持 16 键子集类型；新键客户端不可见）——评审 r1
    核实的幻影面，不作行动项（v1.0 曾误列）。

## 五、执法设计（api-gateway，唯一执法点）

### 5.1 HTTP

- 新中间件 `ClientGateMiddleware`：注册在现有三件套**之前**（先于 `JwtMiddleware`——公开路径也过闸，
  登录正是要拦的对象；Nest 中间件对 `/api` 全量覆盖，评审 r1 已核实）。
  ⚠️ 「顺序即契约」是注释里的**纪律**、**没有任何机械闸**（评审 r1 核实：全仓唯一 `consumer.apply` 在
  `app.module.ts:50`；各测试手搭自家 `configure()` 如 `gateway.controller.test.ts:2456`，不 import
  AppModule）⇒ 插第 0 步**不碰任何测试**，也别期待有闸变红——顺序漂移今天只有线上限流桶投毒形态看得见
  ⇒ 因此本轮**实测一次**中间件相对序不变量（限流桶键仍只取验真产物）。
- 拒绝形态：`throw new CodedForbidden(ErrCode.CLIENT_DISABLED, '当前客户端已暂停服务')` ——
  复用 `jwt.middleware.ts` 现成信封工具（403 + `{code,message,data}`，§11.2 语义与 10003 同族）。
- **留痕（终审 r3 重要 2 补设计决策）**：网关无 access-log、`http_requests_total` 对中间件拒绝只能取
  `route='unmatched'`（`http-metrics.ts:74`）、Nest 对 HttpException 默认不记日志（`main.ts` 仅
  `NotFoundEnvelopeFilter`）⇒ 10008 会与其它 403 混桶。**本闸自带留痕**（否则「关闸后闸有没有生效 /
  流量是否全落未识别桶」无可观测判据——本设计唯一卖点「可控」的闭环）：
  1. 拒绝时**结构化 warn 日志**（platform / path / trigger=switch-off / traceId）——必须项
     （对照 socket 侧 `rejectHandshake` 的 warn 先例）。
  2. **计数器 `client_gate_blocked_total{platform}`** 接入既有 metrics 面——必须项。
  3. **`client_gate_unidentified_total` 升为必须项（收口复评 r4 次要 2 订正）**：计数面 = **非豁免
     `/api/*` 请求中未带（或非法）平台头者**（豁免三路排除，防被管理端流量淹没）；语义 = **只读
     「存在性」信号**（老包 App / 脚本 / 小程序混在一个数里，**不归属任何端**）。与 #2 互补：
     `blocked` 证明「闸咬到了」，`unidentified` 证明「还有识别不了的流量在打」——**两条都要读**；
     ⛔ 不把二者相加/相减去推「某端实际流量」（推不出的，文档明写）。
- **豁免清单**（判定**必须复用单一真源**，⛔ 就地另抄字面量 = R462 同族的漂移面）：
  1. `/api/admin/*`（复用 `isAdminPath()`）——**双保险**：A2 下管理端本就不带此头
     （`admin/app.js:854-858` 实读只有 content-type/auth）⇒ 天然落未识别桶；豁免防的是**未来形态漂移**
     （admin 前端复用玩家网络层、或有人用带头的脚本打 admin 面）导致自锁。
     ⚠️ 判据要真正测到豁免：探针必须**显式带 `X-Client-Platform` 打 admin 路径**（不带头的放行走的是
     未识别桶那条路，测不出豁免本体——评审 r1 次要 10）。
  2. **健康面**（复用 `isHealthPath()`）——`public-paths.ts:39` `HEALTH_PATHS` 恰两条：
     `/api/health` 与 `/api/health/live`（v1.0 只列了前者，订正）；监控与 deploy 冒烟的生死线。
  3. `/api/config` —— H5 被禁时页面须照常初始化，登录尝试时才给清晰文案。**落点（终审 r3 次要 5）**：
     `public-paths.ts` 现无该路径谓词（路由在 `gateway.controller.ts:107` `@Get('config')`）⇒ 于
     `public-paths.ts` **新增单一真源谓词**（与 `isAdminPath()`/`isHealthPath()` 同族）供闸复用，
     ⛔ 不在中间件就地写字面量（那正是本段自己标为漂移面并禁掉的形态）。

### 5.2 socket 握手

- 位置：`handleConnectionInner` 在 `const userId = await this.verifyClient(...)` **之前**加一道闸
  （端闸优先于令牌校验：端关了不必验签）。
- 拒绝：复用现成 `rejectHandshake(client, ErrCode.CLIENT_DISABLED, …)` ——
  与无效令牌同一路径（`system.error{code,message}` + `disconnect(true)`）。
  ⚠️ **订正（评审 r1 重要 5）**：v1.0 写「客户端拿到码走既有错误映射」是错的——`system.error` 是
  best-effort，协议类断线走**断线兜底**，而兜底对非 11003/10006 的码**直出裸码**：
  `apps/client/src/net/socket.ts:1176-1181` ⇒ 现形态会显示「服务端拒绝该连接（code=10008）：已停止
  自动重连」（13010 同族先例）。⇒ 客户端**必须补一条 10008 映射**；§六 客户端改动面**包含**
  `net/socket.ts`。**形态钉死（终审 r3 次要 3；收口复评 r4 重要 1 订正落点）**：10008 = 专属文案 +
  **保留手动恢复入口**（照 10006 一族），⛔ 不得 terminal（照 11003 的停死）。⚠️ **落点不在 socket.ts**
  ——socket.ts 的两分支只差文案（`:1168-1182`），**重连入口的有无由两枚组件的 `canRetry` 谓词决定**：
  `apps/client/src/components/ConnectionOverlay.vue:37-41`（`give_up || deadCode === RATE_LIMITED`，
  :52-64 文案按码分支）与 `apps/client/src/components/ConnectionDeadBar.vue:48-53`（注释明写与 Overlay
  「逐字同口径、**改一处必须同步另一处**」）；挂载面 = table/game/lobby 三页。且既有测试只钉
  10006/11003 ⇒ 加 10008 后**照旧全绿、无任何红提示**（必须主动补测试，见 §八.2）。§六 改动面据此扩。
- 已建立的连接：**不动**（用户裁决「拦新不踢旧」）；自然断开后重连即被拒。
- ⚠️ **`allowRequest` 结构上做不了端闸**（评审 r1 次要 12）：端标识在 socket.io CONNECT 包里，
  engine.io 传输层请求读不到 ⇒ 闸位只能在 `handleConnectionInner`。登记防将来把它当遗漏去「补」。

### 5.3 错误码与客户端行为

- 新码：`CLIENT_DISABLED = 10008`（1xxxx 通用段空位，10001–10007 已占）。
- **登记面（评审 r1 核实后补全）**：
  1. `protocol/errors.ts`：枚举 + `CLIENT_ACTION` 全表加项；**建议 `TOAST`**（弹文案、不销毁会话——
     开关开回去用户无感，符合「拦新不踢旧」的温和度）；备选 `BACK_TO_LOBBY`（清会话回登录页）。
  2. `protocol/src/errors.test.ts:8-17` 的 **SPEC_CODES 字面量表**（不加必红）。
  3. **`docs/design.md:1603` §11.2 表**——该测试注释明言「必须与 §11.2 完全一致，改任一侧同 PR 改另一侧」
     ⇒ 权威文档同步是硬要求。
  4. 客户端 `net/copy.ts` 文案（暂定）：`当前客户端已暂停服务，请稍后再试或更换客户端`；
     另加 `net/socket.ts` 的 10008 断线兜底分支（见 §5.2 订正）+ **`stores/auth.ts` 10008 登录显示
     覆盖（v1.4 订正 / v1.5 落点订正）**：落点 = **toast 处理路径**（`net/errors.ts:147-148` 分派后走
     `handlers.toast`，覆盖在 `auth.ts:156-162` 的 toast handler 内）——照 11003 的**原则**（以客户端
     文案为准）而**非其位置**（11003 在 BACK_TO_LOBBY 分支，因该分支只 signOutLocally；照位置直搬 =
     复刻「分支不可达」教训）；服务端 message **不作显示承诺**。
- **无需**动的面：各服务 `src/http/errors.ts` 的 HTTP_STATUS Partial 表（只服务自服务产码；
  10008 唯一产码点 = 网关 `CodedForbidden` 硬编码 403）——评审 r1 核实，防计划多改。

## 六、客户端设计（改动面，全部玩家端）

| 点 | 文件（预期） | 改动 |
|---|---|---|
| HTTP 注入 | `apps/client/src/net/rest.ts`（统一请求封装一处） | 所有请求带 `X-Client-Platform`；值 = `detectPlatform()` 映射（browser→`h5`，app→`app`，其余（小程序，冻结）**不带**） |
| socket 注入 | `apps/client/src/net/socket.ts`（io 选项处） | `auth: { token, clientPlatform }` |
| socket 拒绝文案 | `apps/client/src/net/socket.ts:1176-1181`（断线兜底现对未知码直出裸码） | 加 10008 分支 ⇒ 友好文案（照 11003/10006 既有专项化手法） |
| socket 死态入口+文案 | `components/ConnectionOverlay.vue`（:37-41 谓词 / :52-64 文案）与 `components/ConnectionDeadBar.vue`（:48-53，**同口径纪律**） | `canRetry` 加 10008 ⇒ 保留「重新连接」（⛔ 不改则静默 terminal）；文案加专属串（挂载面三页无需改） |
| 文案/行为 | `net/copy.ts` + 错误映射 | 10008 文案 + TOAST |
| 登录面显示 | `apps/client/src/stores/auth.ts:156-162`（toast handler） | 10008 覆盖：以客户端文案为准（⛔ 落 toast 路径，**非** 11003 的 `:170-176` BACK_TO_LOBBY 位置——照原则不照位置）；负对照：TOAST 兄弟码行为不动 |

- 「一处即全覆盖」经评审 r1 核实：网关面全部经 `rest.ts`（`pay.ts` 走 `authedRequest`；两处裸
  `uni.request` 分别为 `/version.json` 静态与外部收集端，**均不经网关**）；socket.io-client@4.8.4
  每次（重）连都重发静态 `auth`（`socket.js:405-414`）⇒ 注入点两处即完整。

**版本矩阵（如实登记，进验收表）**：

| 客户端 | 是否带标识 | 开关是否咬得住 |
|---|---|---|
| H5（随服务端部署生效，**新开/刷新页**） | ✅ 部署即带 | ✅ 立即可控 |
| H5 已打开/未刷新的旧页会话（旧 bundle 无头） | ❌ | ❌ 落未识别桶放行——**验收须知（终审 r3 次要 4）**：判「关 h5 生效」必须硬刷新/新开页（`useVersionCheck.ts:44-68` 只提示更新、不自动重载） |
| App 新包（重新打包后） | ✅ | ✅ |
| App 存量包（v1.13.7 及更早） | ❌ | ❌（未识别桶放行）——**已知缺口**，靠用户升级收敛 |
| 小程序（冻结）/ 脚本 / 管理端 | ❌/不发 | ➖ 不受控（设计如此） |

## 七、边界与已知缺口（如实登记）

1. **存量 App 过渡期不受控**（上表）——用户已知情选 A2；A1/A3（UA 兜底）留作将来升级。
2. **标识可伪造**（删头即放行）——**软开关**定位：ops 控制手段，**不是**安全边界。安全面归
   鉴权/风控既有机制。文案与注释不得暗示其安全语义。
3. **主动踢线不做**（用户裁决）——已在线纯 WS 对局打到自然结束；实践中多数用户会在下一个
   HTTP 动作（页面切换/钱包/战绩）撞上 10008。
4. `X-Client-Platform` 不做服务端剥除/验真（性质如此，见 §三）。
5. 管理端自身若未来需要控（如关 web 管理入口）= 另一议题，本设计**不做**（豁免是硬要求）。
6. **钱面链路不受闸（评审 r1 次要 12 + 终审 r3 次要 8 订正表述）**——分两类，别混：
   ① **服务器间入口**（支付回调 `/pay/notify/*` 等，渠道/平台→本服务器）：不受闸（设计如此；
   防被当「钱面封锁」引用）；② **`/pay/cashier/*` 是玩家浏览器直连面**（`deploy/Caddyfile:76-80` 自注
   「玩家浏览器直连的收银台跳转面」）：**H5 关闸期间，持链接的玩家仍可打开并完成支付**——这是钱面
   豁免的**真实玩家可达边界**，如实登记（v1.1 曾把它误并进「服务器间入口」）。
7. **`allowRequest` 做不了端闸**（结构约束，见 §5.2 末条）——登记防误补。

## 八、验证策略

1. **单测（gateway）**：中间件矩阵——无头放行 / app 开 / app 关⇒403+10008 / h5 同上 / 三豁免
   （admin 探针**显式带头**，见 §5.1）/ 非法值放行；**拒绝留痕**（warn 日志 + `client_gate_blocked_total`，
   §5.1）；socket 闸在 `verifyClient` 前生效且拒绝码正确；配置读取失败语义两态（拉过⇒last-good 维持
   执法；从未拉过⇒默认 true 放行）；RPC 新 send 带 `...metaFromTrace()`（扫描闸会红）。
2. **单测（protocol/client）**：10008 在枚举、`CLIENT_ACTION` 表、**`errors.test.ts` SPEC_CODES**；
   `copy.ts` 文案在场；`net/socket.ts` 10008 断线兜底映射；**两死态组件 10008 断言（r4 重要 1——既有
   测试只钉 10006/11003，不补则照旧全绿无提示）**；客户端注入点钉字面量（含小程序不带头的负例）。
3. **conformance 新片**（真栈，建议 `slice-26`）：管理端写面翻转开关 → 探针：curl 带/不带头 +
   真端样本值 → 断言 10008 与放行对照；**翻转后留痕判据**：网关日志出现拒绝行 +
   `client_gate_blocked_total{platform}` 增量（证明闸生效）+ **`client_gate_unidentified_total`
   对照读数**（r4 订正：单计数器区分不了「无该端流量」与「流量全落未识别桶」⇒ **两个都要读**，
   本判据在受控探针下成立）；真 socket.io
   客户端带 `auth.clientPlatform` 探针；`/api/admin/login` 与 `/api/health` 全程不受影响；
   **收尾复原种子**。
   ⚠️ 新片登记两处（评审 r1 次要 14）：`tools/conformance/src/run.ts` 切片注册表 +
   `tools/conformance/baselines.json`（`check-baselines.mjs` 按基线表遍历；新增片按纪律回填并写明依据）。
4. **人工验收（用户侧）**：H5 真浏览器关闸（看文案）；App 新包关闸；管理端照常登录。
5. **评审 r1 回执「已核实无问题」（供复评对照，无需行动）**：Nest 中间件对 `/api` 全量覆盖（含公开路径）；
   socket.io 路径不过 Express 中间件、端闸放 `handleConnectionInner` 是**唯一可行且完备**位置；
   「顺序即契约」无闸钉住、插第 0 步安全；`enableCors` 先于 Nest 中间件 ⇒ OPTIONS 预检被 cors 短路、
   403 带 ACAO；Caddy 透传自定义头；socket.io-client 重连重发 auth；已连接 socket 消息转发路径无闸
   （拦新不踢旧成立）；存量包/管理端落未识别桶与设计一致。

## 九、上线顺序与回滚

1. 服务端全量（种子全开零影响）→ `deploy-dev.sh` 部署测试服（tag `dev-<sha>`）。
2. H5 即刻受控（不需要任何客户端动作）。
3. App 重新打包（含标识头）→ 换 `/download` → 用户升级后 App 受控。
4. 回滚：配置面单键开回 true 即恢复（无重启）；服务端镜像回滚 = `rollback.sh <上一 tag>`。

## 附：命中的既有机制（评审核对用，file:line 以当前树为准）

- 中间件链：`packages/api-gateway/src/app.module.ts` `configure()`（顺序 = 契约的注释就地；唯一 `apply` :50）
- 信封工具：`packages/api-gateway/src/auth/jwt.middleware.ts` `CodedForbidden`
- 公开路径单一真源：`packages/api-gateway/src/auth/public-paths.ts`（`isAdminPath()` / `isHealthPath()`；
  `HEALTH_PATHS:39` 恰两条）
- socket 闸位：`packages/api-gateway/src/gateway/proxy.gateway.ts` `handleConnectionInner` /
  `verifyClient` / `rejectHandshake`；客户端断线兜底 `apps/client/src/net/socket.ts:1176-1181`
- 配置契约：`packages/protocol/src/config.ts`（43/44 键）/ `packages/protocol/src/errors.ts`（10008）
- 错误码同步对：`packages/protocol/src/errors.test.ts` SPEC_CODES ↔ `docs/design.md:1603` §11.2
- 配置缓存模式：`packages/payment-service/src/config/config-cache.service.ts`（`config:changed` 广播 +
  ≤60s 安全网 + 代码默认值 + :451-461 订阅专用连接纪律）
- RPC meta 扫描闸：`packages/room-service/test/meta-on-every-rpc-send.gate.test.ts:67-76`（面含网关）
- 客户端网络层：`apps/client/src/net/rest.ts` / `socket.ts` / `copy.ts` / `mp-transport.ts`（`detectPlatform`）
- admin 前端请求面实读：`admin/app.js:854-858`（不带平台头）
- 管理端 IA：`admin/app.js` CONFIG_IA / `admin/index.html` 导航叶
- conformance 注册两处：`tools/conformance/src/run.ts` + `tools/conformance/baselines.json`
