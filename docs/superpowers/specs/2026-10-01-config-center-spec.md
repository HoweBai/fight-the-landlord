# 配置中心 + 好友房开关（**规格层 v2**）

> **状态**：v2（**定稿本**）—— 两轮独立审查闭环：r1（1 Critical / 8 Important / 10 Minor；事实面 ~120 处行号断言仅 1 处文件名笔误）→ **r2 修复验证（0 Critical；3 Important + 7 Minor 的行级修正已落叶——「落实后可进计划层，无需再一轮复审」）**。逐条处置见 **§0 修订对账**。
> **输入**：设计层 `2026-10-01-config-center-design.md`（**v3 定稿本**，三轮独立审查闭环，commit `b83c5d4`；两轮处置表见其附录 A/B）。
> **分工**：设计层管**方案与取舍**；本文管**改什么、改到哪、怎么验**。
> ⚠️ 本文每条改动都**必须能回指设计层的某条 D**；设计层每条「写死」都**必须**在本文 §3 有判据。
> **本片不做**：RBAC / 多管理员 / 配置版本历史 / 灰度重启（设计 §7）。

## 0. 修订对账

### v2 相对 v1（r1 审查处置）

| # | r1 的问题 | 级别 | v2 的处置 |
|---|---|---|---|
| S-C1 | slice-14 状态编排缺失（C1①/C16③/C17a 在「追加末尾 + 老切片只开不还原」下恒红） | **Critical** | §3 新增「**slice-14 的状态编排（写死）**」小节（逐步前置 + `setFriendRooms()` helper + 统一收尾）；C1/C16 行自带前置，C17 改为**正证变异** |
| S-I1 | slice-13 J22-OFF / J4 将红零处置 | Important | K11 行（J22 重做 = admin PUT + 容器接网 + 还原；J4 = 删改 + **显式登记判据减少**，语义继受 = C5）+ §4.1 两行 |
| S-I2 | J18 闸（`design-md-ai-rollout.gate.test.ts:95-100`）将红 | Important | C2 行：**极性翻转**（退役的守卫也机械化）+ §4.1 行 |
| S-I3 | J29 闸白名单 + E4 消费者归属错 + robot 单测面 | Important | E4 重写（`ruleFallback` 真消费者 = `douzero.health.ts:25` 探测门禁，J29 禁 `robot.service.ts` 读开关）+ E6 白名单同步 + §4.1 三单测行 |
| S-I4 | C13「缓存收敛」观测空洞 | Important | C13 行重写：键写死 `friendRoomEnabled` + admin 读定终值 + **建房行为探针**收口；删「GET /api/config 证缓存」半句 |
| S-I5 | F3 401-immediate + F8 顺序使「其余保留 IP 维」不可达、无令牌类无任何维度 | Important | F5 行限定为准确口径（持令牌非写路径保留 IP 维；无令牌/坏令牌立即 401、**显式登记接受**）+ §2.5 注记 |
| S-I6 | `CONFIG_SYNC_*` 与 `ADMIN_PASSWORD` 缺 compose 透传行；「未设」不可构造 | Important | I2 空默认透传（`${ADMIN_PASSWORD:-}`）+ I1 测试 env 两行透传 + **解析纪律（空串 = 未设）** + C6 三件齐备 |
| S-I7 | user-service TCP 退役面 7 缺 | Important | D10（`rpc.options.ts` 换 env）+ I1（room `:206-207`）+ I2（override 整块）+ L2（`:157-158`）+ K7（RPC_PORTS 换键 + 同提交纪律） |
| S-I8 | `skillDistribution` 校验收紧 vs 设计 D3「非负、归一化」 | Important | §2.2 行改**回归设计口径**（各 ≥0、合计 >0、**写入时归一化落库**；`'15,35,50'` 合法） |
| S-M1–M10 | 十个 Minor | Minor | K1（+C7 / exec 先例）、C2（命令形态）、§4.2（exec 先例 = slice-07.5/restore.sh）、H3（handle 自带 `root * /srv`）、E5（文件名 `robot.reclaim.task.ts`）、§4.1（gateway.controller.test 行）、J1（散文面 `:558/:1150/:1186`）、I6（设计 §5.1-C 尾注作废）、K7（`:912/:914/:1232` 文案）、K2（`--fresh` 照 `--list` 早期返回） |

> **r2 修复验证（已回）**：19 条 r1 处置 = 14 完全成立 / 5 部分成立；残留 3 Important（C5 口径矛盾 / C8 ON 窗 / C13 轮询窗）+ 7 Minor 已在本版逐处落字（`review-spec-r2.md`）。r2 另核实：§0 对账与正文无虚报、「78 行」计数吻合、K7/K11 行号零笔误。

---

## 1. 改动面一览（表内 **78 行**：config-service 新包 14 · protocol/shared 7 · room 10 · robot 6 · gateway 9 · client 5 · admin/edge 3 · 编排 6 · 文档 4 · conformance 11 · 删除与台账 3）

> 标注含义：**新** = 新文件；**改** = 修改；**删** = 删除；**新包** = 整个新服务。

| # | 仓/包 | 文件 | 改动 | 来源 |
|---|---|---|---|---|
| A1 | config-service | `package.json` / `tsconfig.json`（**新**） | 包骨架，照 `user-service`（name=`@fight-the-landlord/config-service`、`build`/`test` 脚本） | D1 |
| A2 | config-service | `src/main.ts`（**新**） | fail-closed `INTERNAL_SERVICE_TOKEN` + 脱敏 logger（`{service:'config-service'}`）+ trace + internal-token 中间件 + `setGlobalPrefix('api')` + TCP **3106**（`RPC_PORT`）+ HTTP **3006**（`PORT`）；TCP 监听顺序照 `game-service/src/main.ts`（微服务在 `listen()` 之前注册并启动——user-service 的同段随 L1 退役，别再引用将删代码） | D1 |
| A3 | config-service | `src/database.config.ts` / `src/data-source.ts`（**新**） | 克隆 user-service 的；🔴 **`migrationsTableName: 'migrations_config'`**（防与 user-service 共写同名 `migrations` 表） | D1 |
| A4 | config-service | `src/app.module.ts`（**新**） | TypeOrm + RedisProviderModule + Health + 控制器 + RPC 装配 | D1 |
| A5 | config-service | `src/config/platform-config.entity.ts`（**新**） | `key` PK varchar(64) · `value` JSON · `version` bigint · `updated_at` · `updated_by` | D1/I-4 |
| A6 | config-service | `src/config/platform-config.service.ts`（**新**） | `list()` 每次查库不缓存；`set()`：事务内 `version=version+1`（行锁；不存在 ⇒ INSERT 自 1）→ `PUBLISH config:changed {keys}`；**publish 失败 ⇒ `announced:false` + WARN，不拦写** | D1/D2 |
| A7 | config-service | `src/config/client-config.controller.ts`（**新**） | `GET /api/config` 子集三键（§2.4） | D5 |
| A8 | config-service | `src/config/admin.controller.ts`（**新**） | `POST /api/admin/login`（未设口令 ⇒ **404**；错口令 ⇒ 401 不签）· `GET /api/admin/config`（全量含每键 version）· `PUT /api/admin/config/:key`（非法 ⇒ **400 不落库**；成功 ⇒ `{saved, announced, version}`）；业务路由校验 `X-Admin: 1`（fail-closed） | D6 |
| A9 | config-service | `src/config/admin-auth.service.ts`（**新**） | `crypto.timingSafeEqual` 常数时间比较；JWT 签发（`ADMIN_JWT_SECRET` **`||`** `JWT_SECRET`——⚠️ `||` 非 `??`，见 §2.6；`aud:'ftl-admin'`，**2h**） | D6 |
| A10 | config-service | `src/rpc/config.rpc.controller.ts`（**新**） | `@MessagePattern(RPC_PATTERNS.configSnapshot)` | D1 |
| A11 | config-service | `src/health/*` · `src/http/*` · `src/redis/*`（**新**） | 就绪 `checks={redis,mysql}`；internal-token 中间件与错误信封照 user-service | D1 |
| A12 | config-service | `src/migrations/1789200000000-PlatformConfig.ts`（**新**） | 建 `platform_config` + **种子九键**（值与代码默认逐字同，含 `friendRoomEnabled=false`）；形状照 `1789100000000-BaseScoreLevels.ts` | D8-2 |
| A13 | config-service | `Dockerfile.config-service`（**新**） | 照 `Dockerfile.user-service` | D8-1 |
| A14 | config-service | `test/` ×5（**新**） | `platform-config.service.test.ts`（C13 并发/version 单调）· `config.validation.test.ts`（C5/C18）· `admin-auth.test.ts`（C6/C12）· `migration.test.ts`（列形状）· `client-config.test.ts`（C7 半边） | D7 |
| B1 | protocol | `src/config.ts`（**新**） | 🔴 `DEFAULT_BASE_SCORE = 15`（**唯一真源**——从 room/shared 两处字面量**收敛**而来：C18 的「15∈表」校验需要它，绝不能出现第三处 15）；`CONFIG_KEYS` 九键；`parseConfigValue(key, value)`（抛 `ProtocolError`，中文原因）；`CLIENT_CONFIG_KEYS`（恰好三键）；`BaseScoreLevel` / `ConfigSnapshot` / `ClientConfig` 类型 | D3/D5 |
| B2 | protocol | `src/rpc.ts` | `RPC_PATTERNS.baseScoreLevels` → **`configSnapshot: 'config.snapshot'`**；删 `BaseScoreLevels*` 类型；+ `ConfigSnapshotRequest/Response`（§2.3） | D1 |
| B3 | protocol | `src/index.ts` | 导出面同步 | — |
| B4 | protocol | `src/messages.test.ts:52-64` | 逐字九 pattern 名单：换 `config.baseScoreLevels` → `config.snapshot` | §5.1-F |
| B5 | protocol | `src/robot-availability-wiring.gate.test.ts` | 标题/头部注释「接收侧地图」更新（`config.snapshot → packages/config-service/src/rpc/`）；实现时确认 `scanTree` 无包白名单（机制为全包扫描 ⇒ 应自动覆盖） | §5.1-F |
| C1 | shared | `src/ddz/game.ts:15` | 该文件的 `DEFAULT_BASE_SCORE`（**对外名就是它**；测试里的 `SHARED_…` 是局部别名——r1 计划审查订正）改为 re-export protocol 的 `DEFAULT_BASE_SCORE`，**建本地绑定**（同文件 `:44` 自身要用） | D3/I-1 |
| C2 | shared | `test/design-md-ai-rollout.gate.test.ts:95-100`（J18 闸） | **极性翻转**：断言 §2.3 **不得**再列三个退役 env、应列 `ADMIN_PASSWORD` 等新行（退役的守卫也机械化——r1-S-I2） | §5.1-A（设计 §5.1-A :283-284 的删行） |
| D1 | room-service | `src/gateway/config.client.ts` | `levels()` → `snapshot()`（RPC 名换；3s 超时 / 不重试 / 传输失败 10007 **逐字保持**） | D2 |
| D2 | room-service | `src/config/config-cache.service.ts` + `config-cache.module.ts`（**新**） | 缓存 + 启动拉取（1s 退避重试）+ 订阅 `config:changed`（🔴 **专用 Redis 连接**）+ 60s 安全网自重排 + 测试 env 两枚；getters：`friendRoomEnabled()`（默认 false）· `baseScoreLevels()`（**空 ⇒ 抛**）· `cycleMs(key)`（默认值兜底） | D2 |
| D3 | room-service | `src/rooms/rooms.controller.ts` | `create()`/`join()` 入口拒 `12006`（开关关）；`findAll()` 返 `[]` | D4/I-2 |
| D4 | room-service | `src/rooms/rooms.service.ts` | 底分校验改走缓存（fail-closed `10007` 保持）；`DEFAULT_BASE_SCORE` 改 re-export protocol | D2/D3 |
| D5 | room-service | `src/match/match.service.ts` | 入队底分校验走缓存；扫描循环 `setInterval` → **`setTimeout` 自重排**（每轮读缓存） | D3/M-6 |
| D6 | room-service | `src/rooms/rooms.autostart.ts` | 自重排 | D3 |
| D7 | room-service | `src/rooms/rooms.reaper.ts` | 自重排 | D3 |
| D8 | room-service | `src/app.module.ts` | 装配缓存模块 | D2 |
| D9 | room-service | `test/` | `config.client.test.ts` 改；`rooms.base-score.test.ts` 注释订正（re-export 后判别力改述）；**新** `config-cache.test.ts`（C3/C4/C9）；rooms.controller 拒/返空测试 | §4 |
| D10 | room-service | `src/gateway/rpc.options.ts:32-41` | `USER_SERVICE_RPC_HOST/PORT` → **`CONFIG_SERVICE_RPC_HOST/PORT`**（默认 `config-service` / `3106`）——新 env 的**唯一代码读取点**（r1-S-I7） | D1/D2 |
| E1 | robot-service | `src/robot/config.ts` | env 解析**退役**；保留代码默认值（=种子）并导出 | D3 |
| E2 | robot-service | `src/config/config-cache.service.ts` + module（**新**） | 同构克隆；getters：`skillDistribution()` / `ruleFallback()` / `modelBySkill()` / `reclaimIntervalMs()` | D2 |
| E3 | robot-service | `src/robot/robot.pool.ts` | 抽档比例读缓存（下一次抽档生效） | D3 |
| E4 | robot-service | `src/robot/douzero.health.ts:25` + `src/robot/bot.player.ts:140`（+ `robot.service.ts:55` 日志行） | `ruleFallback` 读缓存（**真消费者 = 探测门禁，不是决策路径**——r1-S-I3；J29 逐字禁 `robot.service.ts` 读开关）；`modelBySkill` 在**决策路径**模型装配点 `bot.player.ts:140` 读缓存（r1 计划审查 X-3 订正：`robot.service.ts:55` 只是日志行） | D3 |
| E5 | robot-service | `src/robot/robot.reclaim.task.ts`（r1-S-M5 文件名订正） | `setInterval`（`:8` 读 env）→ 自重排 + 读缓存 | D3 |
| E6 | robot-service | 模块装配 + `test/` | 装配缓存模块；C3 半边（缺省兜底）；**J29 闸白名单同步**（`no-switch-in-decision.gate.test.ts:105-108/:128-131`——开关文本只许出现在**新定义点**）；`robot.config.test.ts`（含 `:11 '15,35,50'` 语义）/ `douzero.health.test.ts` / `robot.pool.test.ts` 随改造登记 | D2 |
| F1 | api-gateway | `src/auth/public-paths.ts` | + `ADMIN_PREFIX='/api/admin'` 与 `isAdminPath()`（**前缀**语义；与五条精确白名单**分列**；注释写明为何前缀安全 + R462 单一真源延伸） | D6 |
| F2 | api-gateway | `src/auth/jwt.middleware.ts:104` | `isPublicPath(path) \|\| isAdminPath(path)` ⇒ 整段跳过玩家验签（`X-User-Id`/`X-Token-Jti` 剥离仍在其前） | D6 |
| F3 | api-gateway | `src/auth/admin.middleware.ts`（**新**） | **先剥** `X-Admin` → login 豁免（**恰好一条**）→ 验管理令牌（`aud='ftl-admin'`）→ 注入 `X-Admin: 1`；失败 ⇒ 401 且**不注入**；验过后把**令牌指纹**（sha256 前 16 位）挂 `req` 供限流维度取用 | D6 |
| F4 | api-gateway | `src/http/rate-limit.ts` | + admin 桶与阈值常量：`ADMIN_LOGIN_FAIL={max:5,windowMs:300_000}`（**失败计次、成功清零**）· `ADMIN_WRITE={max:30,windowMs:300_000}`；键 `ratelimit:admin-login-fail:{ip}` / `ratelimit:admin-write:{tokenFp}`（`tokenFp`=令牌 sha256 前 16 位） | D6 |
| F5 | api-gateway | `src/http/http-rate-limit.middleware.ts` | admin 分支：**登录**与**持令牌写**（有 `X-Admin` 的 PUT）跳过既有 IP 120/60s 维；**持令牌但非写路径**（GET admin/config）保留 IP 维；**无令牌/坏令牌**在 AdminAuth 处**立即 401、不进任何维度**（显式登记接受——成本低、无放大面；r1-S-I5：F3 401-immediate + F8 顺序使「其余全保留」不可达，此限定为准确口径）；失败计次用 **响应 finish 钩子**（401 ⇒ 计、200 ⇒ 清）；**桶达界 ⇒ 正确口令也 429**（检查在比较之前） | D6/I-5 |
| F6 | api-gateway | `src/gateway/gateway.controller.ts` | + `@Get('config')` · `@Post('admin/login')` · `@Get('admin/config')` · `@Put('admin/config/:key')`；**删** `@Get('base-score-levels')`（`:96-99`）；`headersOf()` + `X-Admin` 转发 | D5/D6 |
| F7 | api-gateway | `src/gateway/proxy.gateway.ts` | + `forwardToConfigSvc`（基址 `CONFIG_SERVICE_URL`）+ `PUT` 方法支持 | D6 |
| F8 | api-gateway | `src/app.module.ts` | 顺序：`JwtMiddleware → AdminAuthMiddleware → HttpRateLimitMiddleware` | D6/I-5 |
| F9 | api-gateway | `test/` | **新** `admin.middleware.test.ts`（豁免恰好一条 / 剥离伪造 / 401 不注入）；rate-limit admin 桶；`gateway.controller.test.ts:122-140` 旧端点转发测试处置 | §4 |
| G1 | client | `src/net/rest.ts:241-259` | 删本地 `BaseScoreLevel`（改 protocol 引）；`baseScoreLevels()` → **`fetchClientConfig()`**（`GET /api/config`；⚠️ **不能**叫 `clientConfig`——与 `rest.ts:12` 既有 import 重名 = TS2440，r2 计划审查 X-2） | D5 |
| G2 | client | `src/stores/game.ts` | + `friendRoomEnabled: false`（**初值 false 写死**）+ `setClientConfig(...)`（一次写两字段；失败 ⇒ `[]` + 保持 false） | D4/D5 |
| G3 | client | `src/pages/lobby/lobby.vue:86-133` | `loadLevels` → `loadClientConfig`（时机不变：挂载一次、不缓存） | D5 |
| G4 | client | `src/pages/game/game.vue:369-378` | 好友房入口 `v-if="store.friendRoomEnabled"` | D4 |
| G5 | client | `test/` | `auth-ui-wiring` / `base-score-selection` / `table-center` 改造；**新** fail-safe 测试（C19） | §4 |
| H1 | admin | `admin/index.html` / `admin/app.js` / `admin/style.css`（**新**） | 无构建静态页；登录 → `sessionStorage` 令牌 → `Authorization: Bearer`；保存后「**已保存（版本 N）；各服务 ≤60s 内生效**」/ `announced:false` ⇒「推送失败，将在 ≤60s 内经安全网生效」 | D6 |
| H2 | edge | `Dockerfile.edge` | stage 二 + `COPY admin /srv/admin` | D6 |
| H3 | edge | `deploy/Caddyfile` | + `handle /admin/*`（**自带 `root * /srv`** + file_server——root 不跨 handle 继承，r1-S-M4）与 `handle /admin { redir /admin/ 301 }`（**两条 `handle` 都插在 catch-all（`:35`）之前**——用 handle 块包住重定向，规避 Caddy 指令排序问题） | D6/M-4 |
| I1 | 编排 | `docker-compose.yml` | config-service 块（§2.7 形态；`expose ['3006','3106']`——①b 要求 base 含 3106）；room-service `:206-207` 的 `USER_SERVICE_RPC_*` → `CONFIG_SERVICE_RPC_HOST/PORT`；**room/robot + 测试 env 两行透传**（`CONFIG_SYNC_SAFETY_NET_MS=${CONFIG_SYNC_SAFETY_NET_MS:-}` / `CONFIG_SYNC_DISABLE_PUSH=${CONFIG_SYNC_DISABLE_PUSH:-}`——空默认，先例 override:88-90；🔴 消费侧解析纪律：**空串 = 未设**，用 `\|\|` 不用 `??`）；**robot 删 `:301-302` 两行 env**；gateway + `CONFIG_SERVICE_URL`；**头注释计数**（8→9、9→10）；**软依赖理由注释** | D1/D8-3 |
| I2 | 编排 | `docker-compose.override.yml` **整块** | config-service：`3106:3106` 映射（RPC 直连面；**不**发布 3006——经网关即可）+ `ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}`（**空默认透传**，口令由运行侧 export——conformance-stack.sh I4 / 开发者 shell）+ **`INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}`**（dev 形态先例，照既有服务块——缺则 CI 栈起不来，main.ts 的 fail-closed）；user-service 块 `:43-49`：**删 `3101:3101`** + 注释重写（原引用 slice-07.2-deploy ②b 与 slice-07.2-rpc 第 7 组——两处断言将换 3106）+ `:46` 的 `config.baseScoreLevels` 注释更新 | D6/§5.1-E |
| I3 | 脚本 | `scripts/deploy/build-images.sh:2/:32` | 7 → 8 | D8-1 |
| I4 | 脚本 | `scripts/deploy/conformance-stack.sh:18` | `SERVICES` + `config-service`（保持字典序）；+ `export ADMIN_PASSWORD="${ADMIN_PASSWORD:-conformance-admin-pass}"`（**与 `lib/http.ts` 的常量两处同源**，写注释互指） | D8-1/I-4 |
| I5 | 脚本 | `scripts/deploy/deploy.sh` | **按 tag 取 compose**（`git fetch --tags --force && git show "refs/tags/$IMAGE_TAG:docker-compose.yml"`，取不到 ⇒ 明确报错 + exit 1；scp 该文件为远端 `docker-compose.yml`）；🔴 位置在 `--assert-clean` 早退块（`:36-81`）**之后** | D8-5/裁决 9 |
| I6 | 工作流 | `images.yml:1/:31` · `release.yml:43/:82` · `ci.yml:39` · `conformance.yml:49` | 计数 7→8 / 5→6；**+ conformance.yml**：切片循环步 env `ADMIN_PASSWORD` + **fresh 前置步**（C11）；⚠️ **设计 §5.1-C 尾注「+ release.yml：按 tag 取 compose 步」作废**（正确落点在 deploy.sh——release.yml 无 compose 步、`:100-115` 只有 checkout/fetch；防实现层照 C 加一个无落点的步——r1-S-M8） | D8-1/§5.1-C |
| J1 | 文档 | `docs/design.md` | §5.1-A 全表逐行（含 `:157/:159/:188/:539/:543/:999/:1012/:1587/:1718/:1727` **+ 散文面 `:558/:1150/:1186`**——env→配置中心的语义句，r1-S-M7） | 设计 §5.1-A |
| J2 | 文档 | `docs/ops/first-deploy.md` | §5.1-B 全表（含 🔴 `:249` 预期输出重算；+「怎么改配置」节 + 回滚注意） | 设计 §5.1-B |
| J3 | 文档 | `docs/client-protocol.md` | 替换 `:52` + **改写** `:54-60`（保留活契约、缓存语义反转）+ 修 `:62-63` 悬空引用 | §5.1-M |
| J4 | 文档 | `README.md:35-44`（+ 顺手补 robot:3005）· `docs/games/doudizhu.md:341` | 端口表 + 过期文本 | §5.1-D/P |
| K1 | conformance | `src/slices/slice-14-config-center.ts`（**新**） | C1/C2/C5半/C6半/**C7**/C8/C13/C14/C15/C16/C17/C20；`compose()` helper 照 `slice-07.3-edge.ts:141-159`；`exec()` 先例 = `slice-07.5-backup` 的 `docker exec ftl-mysql …`（r1-S-M3）；含**状态编排**（§3 末小节）与 `setFriendRooms()` helper | D7 |
| K2 | conformance | `src/run.ts` | 注册 slice-14（**末尾追加**，`:56-57` 纪律）+ **`--fresh` 模式**（C11 载体；照 `--list` 的**早期返回**模式写在 case 查找之前，`:90-96` 先例；未实现时 = usage + exit 2，响亮——r1-S-M10） | D7/C11 |
| K3 | conformance | `src/lib/http.ts` | `request()` 加 **PUT**（`:73` 现仅 GET/POST）；+ `ADMIN_PASSWORD` 常量与 `adminLogin()/adminGetConfig()/adminPutConfig()` | D7/I-4 |
| K4 | conformance | `slices/slice-06-auth-rooms.ts` | 开头经 admin 开启（共存表）；`:109-121` 旧端点 → `GET /api/config`（`levels` → **`baseScoreLevels`**） | D4/共存 |
| K5 | conformance | `slice-07.1-room-atomic-seating.ts:144` · `slice-07.2-hardening.ts:1142-1145` · `slice-12-manual-join.ts:91,:419` | 开头开启（**不改断言语义**） | D4/共存 |
| K6 | conformance | `slices/slice-07.4-pipeline.ts` | + C21① 静态判据（deploy.sh 含按 tag 取 compose + fail-closed） | D8-5 |
| K7 | conformance | `slices/slice-07.2-deploy.ts` | `:552` BUILD_SERVICES 7→8 · `:918-922` LOG_LIMIT_TARGETS 容器名 · `:123` TOKEN_SERVICES 5→6 · `:131` DIRECT_PORT_SERVICES **不动** · `:71` 与文案 `:912/:914/:1232` 计数 · 🔴 **`:141-146` RPC_PORTS 换键**：`'user-service':'3101'` → `'config-service':'3106'`（使用点 `:759-773`/`:862-871` 随动；换映射与换断言**必须同一提交**，防中间态红——r1-S-I7） | 清单 |
| K11 | conformance | `slices/slice-13-ai-rollout.ts` | `:698-709`（**J22-OFF 重做**）：关闭态经 admin PUT `robot.ruleFallback=false`（一次性容器需接入 compose 网络以拉快照——机制同既有 J22 容器形态；r2 核实：`compose run` 自动入网，实现时**勿加** `--network`）+ 用后还原 true；`:751-776`（**J4**）：删改 + **显式登记判据减少**（语义继受 = C5） | r1-S-I1 |
| K8 | conformance | `slices/slice-07.2-rpc.ts` | **3101 断言面迁 3106**（逐条**改而不删**——「RPC 监听方 = config-service」） | 收编 |
| K9 | conformance | `scripts/browser-e2e.mjs:474/:609-697` | 新端点 + setup 经 admin 开启 | D4 |
| K10 | conformance | `tools/conformance/baselines.json` | slice-14 条目（`full` 列**由 CI 回填**）；不进 `render` 列 | D7 |
| L1 | user-service | 删：`src/config/`×4 · `src/rpc/base-score-levels.rpc.controller.ts` · `test/base-score-levels.test.ts` · `test/base-score-levels.rpc.test.ts`；`src/main.ts` 去微服务块（`:56-60`）；`src/app.module.ts` 去装配；**保留** migration + `test/migration.test.ts`；`health/health.service.ts:34` 注释改 | 删 *（§D8-4） |
| L2 | user-service | `docker-compose.yml` 的 user-service 块 | `expose: 3101` 删（`:146-148` 内）+ `:142-144` 注释删 + **`:157-158` 的 `RPC_PORT=3101` 删**（r1-A-3：原样保留会成为死配置） | 同上 |
| L3 | 台账 | `docs/superpowers/plans/deviation-ledger.md` | + 两条登记：①`base_score_levels` **遗留表+迁移** ②`room:{code}:fillat` 被 WS join/leave 路径写入（**先于本片**的现状，M-2） | 设计 §5.2 |

---

## 2. 新契约（写死）

### 2.1 `platform_config` 表（config-service 自己的迁移）

```sql
CREATE TABLE IF NOT EXISTS `platform_config` (
  `key`        varchar(64)  NOT NULL,
  `value`      json         NOT NULL,
  `version`    bigint       NOT NULL DEFAULT 1,
  `updated_at` datetime(3)  NOT NULL,
  `updated_by` varchar(64)  NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
```

- 种子 `INSERT` 九键（§2.2），`version=1`、`updated_by='seed'`。
- **version 语义**：每键单调计数器，写入事务内 `version=version+1`（InnoDB 行锁串行化并发写；key 不存在 ⇒ INSERT 自 1，并发首建用 `ON DUPLICATE KEY` 或唯一键冲突重试）；**持久化 ⇒ 重启不倒退**。快照/管理读里携带**每键 version**；全局 = `MAX(每键)`。

### 2.2 九键（类型 · 校验 · 默认 = 种子 = 现值）

| 键 | 类型 | 校验（`parseConfigValue`，非法 ⇒ `ProtocolError` 中文原因） | 默认 | 消费者 |
|---|---|---|---|---|
| `robot.skillDistribution` | `{beginner,intermediate,advanced}` 数值 | 三键齐全 · 各 ≥ 0 · 合计 > 0；**写入时按合计归一化后落库**（口径与既有 `parseSkillDistribution` 一致：`'15,35,50'` 合法 ⇒ 存 `0.15/0.35/0.5`——r1-S-I8：回归设计 D3「非负、归一化」口径，不收紧） | `0.15/0.35/0.5` | robot-service |
| `robot.ruleFallback` | boolean | 严格 `true`/`false` | `true` | robot-service |
| `robot.modelBySkill` | 三键 → 模型名 | 三键齐全 · 值 ∈ `{'sl','douzero_WP','douzero_ADP'}` | `sl/douzero_WP/douzero_ADP` | robot-service |
| `robot.reclaimIntervalMs` | number | 整数 · `0 < n ≤ 600000` | `60000` | robot-service |
| `room.matchScanIntervalMs` | number | 同上 | `5000` | room-service |
| `room.autostartIntervalMs` | number | 同上 | `5000` | room-service |
| `room.reapIntervalMs` | number | 同上 | `60000` | room-service |
| `room.friendRoomEnabled` | boolean | 严格 boolean | **`false`**（裁决 8） | room-service + client |
| `game.baseScoreLevels` | `{name, baseScore}[]` | 非空 · `name` 非空字符串 · `baseScore` 正整数 · **唯一** · 🔴 **必须含 `DEFAULT_BASE_SCORE`(15)** | 四档 `15/80/480/1200` | room-service + client |

⚠️ 默认值已在 r1 逐键对代码现值核验一致（审查报告 §3.2）；**实现时仍须逐键再比一次种子与现值**（`robot/config.ts:6`、`robot/models.ts:8-12`、`robot.reclaim.task.ts:8`、`match.service.ts:127`、`rooms.autostart.ts:9`、`rooms.reaper.ts:9`、迁移种子 `:29-30`）。

### 2.3 TCP RPC `config.snapshot`（protocol `src/rpc.ts`）

```ts
configSnapshot: 'config.snapshot'          // 取代 baseScoreLevels（第九个 pattern，名单换、总数仍九）

interface ConfigSnapshotRequest { meta?: RpcMeta }
interface ConfigSnapshotResponse {
  config: Record<ConfigKey, { value: unknown; version: number }>;   // 全部九键
  version: number;                                                   // MAX(每键)
}
```
- 失败语义：读快照失败 ⇒ 消费方按 D2 分层（热项默认值 / 底分 `10007`）；RPC 传输故障由消费方映射 `10007`（现 `config.client.ts:72-84` 逐字保持）。

### 2.4 REST `GET /api/config`（玩家客户端子集）

```json
{ "code": 0, "data": { "baseScoreLevels": [{"name":"休闲场","baseScore":15}],
                        "friendRoomEnabled": false, "version": 42 } }
```
- 经网关**验签**（不在白名单）；字段集**恰好** `CLIENT_CONFIG_KEYS = ['baseScoreLevels','friendRoomEnabled','version']`（protocol 单测 + slice-14 两边共源）；不含任何内部键名。

### 2.5 REST `/api/admin/*`（管理面）

| 方法·路径 | 鉴权 | 请求 | 成功响应 | 失败 |
|---|---|---|---|---|
| `POST /api/admin/login` | 口令（唯一豁免） | `{password}` | `{code:0, data:{token, expiresIn:7200}}` | 未设口令 ⇒ **404**「管理面未启用」；错口令 ⇒ **401** 且不签；限流 ⇒ 429 |
| `GET /api/admin/config` | 管理令牌 | — | `{code:0, data:{config:{<key>:{value,version}}, version}}` | 401 |
| `PUT /api/admin/config/:key` | 管理令牌 | `{value}` | `{code:0, data:{saved:true, announced:bool, version}}` | 非法 ⇒ **400 + 原因**（不落库）；401；429 |

- 令牌传递：`Authorization: Bearer <admin token>`（**非 cookie** ⇒ CSRF 不适用）；网关 `AdminAuthMiddleware` 验后注入 `X-Admin: 1`（并**先剥**客户端伪造的同名头）；config-service 路由层校验 `X-Admin`（fail-closed）。⚠️ **无令牌/坏令牌的 `/api/admin/*` = 在 AdminAuth 处立即 401、不进任何限流维度**（显式登记接受——成本低、无放大面，r1-S-I5）。
- 限流（网关侧，§F4/F5）：登录按 IP **5 次/5 分钟**（失败计次、成功清零；**桶达界 ⇒ 正确口令也 429**）；写操作按令牌 30 次/5 分钟。

### 2.6 管理令牌

JWT（`ADMIN_JWT_SECRET` **`||`** `JWT_SECRET` ⇒ dev 兜底——⚠️ 用 `||` 不用 `??`：compose 空默认透传渲染出**空串**（非未设），`??` 不回落 + jsonwebtoken 拒空密钥 ⇒ 管理登录 500（T9 实拍；「空串=未设」纪律的又一实例）；`aud:'ftl-admin'`）；**TTL 2h**；浏览器存 `sessionStorage`；载荷只需 `aud/exp/iat`（**单一管理员**，无身份字段）。

### 2.7 env 与退役

| 动作 | 变量 | 消费方 |
|---|---|---|
| **新增** | `ADMIN_PASSWORD`（未设 ⇒ 管理面整体关闭）· `ADMIN_JWT_SECRET`（可选） | config-service（compose 透传）；⚠️ **`ADMIN_JWT_SECRET` 还必须透传给 api-gateway**（验签侧与签发侧必须同钥——T4 实测补登：漏透传 ⇒ 生产设了它时管理令牌全 401、dev 双空回退会掩盖；落点 T9 同提交） |
| **新增** | `CONFIG_SERVICE_RPC_HOST=config-service` / `CONFIG_SERVICE_RPC_PORT=3106` | room-service · robot-service |
| **新增** | `CONFIG_SERVICE_URL=http://config-service:3006` | api-gateway |
| **退役** | `ROBOT_RULE_FALLBACK` · `ROBOT_SKILL_DISTRIBUTION`（compose `:301-302` 删） | robot-service |
| **退役** | `ROBOT_RECLAIM_INTERVAL_MS` · `MATCH_SCAN_INTERVAL_MS` · `ROOM_AUTOSTART_INTERVAL_MS` · `ROOM_REAP_INTERVAL_MS`（**四个都不在 compose**，r1 订正；文档侧只 `design.md:188` 一行待删） | robot / room |

⚠️ 兼容：**老镜像 + 新库**滚动期老 robot 仍读 env（其默认值与种子同值）⇒ 行为不变（设计 D3）。

### 2.8 客户端 fail-safe（写死）

`stores/game.ts` 的 `friendRoomEnabled` **初值 = `false`**；`GET /api/config` 失败 ⇒ 保持 `false` + `baseScoreLevels=[]`（既有空表语义）；到 game 页必经大厅挂载（路由对齐，r2-B6 读码证明）⇒ 无「首屏直入漏取配置」场景；会话中途关闭由服务端 `12006` TOAST 兜底（§5.2-5 同族窗口）。

---

## 3. 判据（C1–C21 形式化）

> 编号沿用设计层 §D7；「替代错实现」= 该判据拦住的、最像正确答案的错实现（本仓第一号纪律）。

| # | 落点 | 断言要点 | 替代错实现 |
|---|---|---|---|
| **C1** | slice-14 | **前置（S-C1：不假设起态）**：经 admin PUT `false` + 轮询至 `POST /api/rooms ⇒ 12006`。① `POST /api/rooms` ⇒ `12006`。② PUT `true` ⇒ **轮询 `GET /api/config` ≤30s 变 true** ⇒ `POST /api/rooms` ⇒ `code 0`/201。③ PUT `false` ⇒ 轮询 ≤30s ⇒ `12006`。⚠️ 30s < 安全网 60s **刻意**：C1 只证**推送路径**（注释进判据） | 「改了要重启」「改了 60s 后才生效也算过」；不发 publish 只靠安全网 |
| **C2** | slice-14 | 直接改库（**先例形态**：`docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "UPDATE platform_config SET value=…, version=version+1, updated_at=NOW(3), updated_by=\"drill\" WHERE \`key\`=\"room.friendRoomEnabled\""'`——容器内两变量由 compose 提供、反引号转义、CI 必带 `-T`），**无 publish** ⇒ 轮询**≤70s** 观察建房行为翻转；**收尾经 admin API 写回并轮询至生效**。变异见 C17b | 没有安全网的实现（改库后永不生效）；有安全网但不重拉缓存的实现 |
| **C3** | 单测（room+robot） | 快照拉取失败 + 空缓存 ⇒ 服务**照常就绪**、热项 getter 返回代码默认值（不得抛/不得 exit） | 「配置中心挂了就启动失败/停摆」 |
| **C4** | 单测（room） | **缓存空 + 拉取失败** ⇒ `baseScoreLevels()` 抛 ⇒ `create(显式 baseScore)` ⇒ `10007`、**不落库**；缓存有值（哪怕旧）⇒ 用缓存不报错 | 返回空数组（把「读不到」伪装成「没有档位」——既有红线） |
| **C5** | 单测（config-service）+ slice-14 | `parseConfigValue` 全覆盖（比例缺档/为负/**合计 = 0**；levels 空/重值/非正/不含 15（→C18）；未知模型名；周期 ≤0 或 >600000）⇒ 400；**归一化落库断言**：`'15,35,50'` ⇒ 200 且存 `0.15/0.35/0.5`；slice-14 抽 2 例真栈 PUT ⇒ 400 且 `GET /api/admin/config` 里**值未变** | 校验只写在管理页（可绕过）；400 了却先落库 |
| **C6** | 单测 + slice-14 | 未设口令 ⇒ login **404**；错口令 ⇒ **401 且不签令牌**（响应无 token 字段）；过期令牌 ⇒ 401。slice-14 的「未设」半边 = **三件齐备**（r1-S-I6）：① override 的 config-service 块 `ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}`（**空默认透传**）② 步骤级**显式注入空串**（覆盖循环步可能注入的值）+ `up -d --no-deps config-service`（先例 `slice-07.3-edge.ts:141-159`）③ 服务端语义：**未设 = unset 或空串**（实现写死）；完成即还原 | 未设口令 ⇒ 放行；错口令也签；404 用 10007 伪装故障；「空串」被当有效口令 |
| **C7** | protocol 单测 + slice-14 | `CLIENT_CONFIG_KEYS` 恰好三键；真栈 `GET /api/config` 的 `data` 键集（排序后）**恰好**三键 + 值类型正确 | 顺手把内部键暴露进子集 |
| **C8** | slice-14（缺省态）+ 单测（正对照） | **ON 窗写死（r2-②）**：② `setFriendRooms(true)` **轮询至建房 `code 0`** ⇒ 建房（在途房）⇒ `setFriendRooms(false)` 轮询至 `12006` ⇒ `POST /:code/join` ⇒ `12006`。置 `false`：① `POST /api/rooms` ⇒ `12006` ③ `GET /api/rooms` ⇒ `[]` 且 `code 0`。单测正对照：开关关时 `match.service` 的 `createGameRoom` 路径**不**被拦（匹配照常成局） | 只在建房拦（占座/列表漏）；把拦截落进共用 `create()` ⇒ 连坐匹配；复用 C1② 残留房（404 假红）；开闸即建房（推送未达假红） |
| **C9** | 单测（假时钟） | 自重排口径：**当前一轮按旧值跑完 ⇒ 其后按新值排下一轮**（改小后第 N+1 轮触发点 = 第 N 轮结束 + 新值；精确断言点写进用例名） | `setInterval` 未退役（改完永远不生效）；「立即生效」误述（在途一轮被中断） |
| **C10** | 既有判据 | `slice-06:109-121`（改新端点/字段名）· `rooms.base-score.test.ts`（re-export 后仍绿+注释订正）· client 三测试改造 · **全部语义不变、只换数据源/夹具** | 「换数据源顺手把断言调松」 |
| **C11** | **workflow 前置步**（不是切片） | `conformance-stack.sh up` 之后、切片循环之前：`node tools/conformance/dist/run.js --fresh` ⇒ 注册用户 → `GET /api/config` ⇒ **`friendRoomEnabled === false`**（种子=生产默认的铁律；fresh 态是唯一可观测时点） | 「偷偷把栈种成 true」（C8 默认态覆盖被静默丢掉）；做成切片（恒红/空洞二选一——r2-C2） |
| **C12** | 单测（config-service） | mock publish 失败 ⇒ 响应 `{saved:true, announced:false}` + WARN 日志（注入 mock logger 断言） | 写成功但发布失败**不可见**（「改了没生效、日志里查不出来」） |
| **C13** | slice-14 + 单测 | `Promise.all` 两并发 PUT 同键——**键写死 `room.friendRoomEnabled`**（值相反）⇒ 都 200；`GET /api/admin/config` 里该键 `version = v0+2`；终值=其一（**经 admin 读定**）⇒ **建房行为探针轮询 ≤30s 至与终值一致**（< 安全网 60s——不然缓存错序会被安全网 tick 救活而漏判、正确实现也可能假红；收尾置回 false）。单测：同键并发事务 version 严格 +2 无撕裂（含**并发首建**路径）。⚠️ r1-S-I4：不用 `GET /api/config` 证明「消费侧缓存收敛」（它每次查库、证明不了；缓存收敛语义由 C1 的推送行为断言承载） | 读-改-写竞态（version 被覆盖）；缓存错序（最后写入者≠最后通知者） |
| **C14** | slice-14 | 匿名 `GET /api/config` ⇒ **401**（10002）；匿名 `GET /api/admin/config` ⇒ 401 | 只测字段集、不测鉴权强度 |
| **C15** | slice-14 | 5 次错口令（≤5 次内均 401）⇒ **第 6 次 ⇒ 429**；**清理前**先用正确口令试 ⇒ 也 429（桶达界语义）；收尾 `docker compose exec -T redis redis-cli --scan --pattern 'ratelimit:admin-login-fail:*'` + `DEL` 清桶，**再断言正确口令可登录**（自证清干净）。⚠️ CI 串行同 runner IP，桶残留会污染后续切片与浏览器探针——收尾**必须**清键、不能只等窗口 | 不防爆破（界不生效）；429 判定在口令比较之后（达界仍验口令）；不清桶（后续全红） |
| **C16** | slice-14 | **前置（S-C1）**：`setFriendRooms(true)` + 轮询建房 `code 0`。`docker compose stop config-service` ⇒ **强制重启 room-service**（`docker compose up -d --no-deps --force-recreate room-service`，或 `docker restart ftl-room-service`——`up -d` 对未变容器是 no-op，**必须**强制才能复现冷启动；**无硬门** ⇒ 不碰 config-service）⇒ ① room `/api/health` 就绪（不得停摆）② 建房 ⇒ `12006`（**热项取默认 false 的证据**）③ `docker compose start config-service` ⇒ **≤ 安全网周期**（70s 轮询）建房恢复 `code 0`（自愈、无需再重启 room；⚠️ 此构造下恢复可能远快于 60s——启动退避重试还在跑，70s 是保守上界）。**收尾**：`setFriendRooms(false)`。⚠️ 规格订正：设计原文「期间底分面 10007」在本构造下被默认关先拦（`12006`），底分 `10007` 的等价场景由 **C4 单测**覆盖 | 启动硬门（配置中心不健康 ⇒ 消费服务起不来/被停）；启动失败即退出；不重拉缓存 |
| **C17** | slice-14（步骤级，env 注入） | **a（关推送）**：注入 `CONFIG_SYNC_DISABLE_PUSH=1`（room-service）⇒ 置 false（轮询至 `12006`）⇒ PUT true ⇒ **30s 时点建房仍 `12006`**（⇒ C1 依存推送路径得证）⇒ **≤70s 内变 201**（安全网兜底正证）⇒ 还原注入 + 置回 false。**b（拉长安全网）**：注入 `CONFIG_SYNC_SAFETY_NET_MS=600000` ⇒ 改库翻转（C2 手法）⇒ **70s 时点仍未翻转**（⇒ C2 依存安全网得证）⇒ 还原注入（`up -d --no-deps` 重建回正常 env；重建即拉最新快照）。注入/还原照 `slice-07.3-edge.ts:141-159` | 变异承诺落空（「关安全网 ⇒ 仍绿」= 判据空洞） |
| **C18** | 单测（config-service）+ 既有判据 | PUT `game.baseScoreLevels` **不含 15** ⇒ 400 且不落库；含 15 ⇒ 200。⚠️ 两处常量一致性**引用既有判据**（`rooms.base-score.test.ts:154-163`，勿重造）——收敛到 protocol 后该测试**仍须绿** | 管理员删掉 15 档 ⇒ 缺省建房产出「不属于表」的底分（C10 静默破） |
| **C19** | 单测（client） | `GET /api/config` 失败 ⇒ `friendRoomEnabled` 保持 `false` ⇒ 入口**不渲染**；成功且 `true` ⇒ 渲染 | 配置未知时**显示**入口（fail-open）；用 `undefined` 初值导致闪现 |
| **C20** | slice-14 | 经门口（`EDGE_HTTP_PORT`，8080）：`GET /admin/` 与 `GET /admin`（允许一次 301）⇒ **200 且响应含管理页标志串**（title/元素 class——「非 404」太松） | 路由顺序错（被 catch-all/H5 接走）；谓词太松（500/空页也算过） |
| **C21** | ① slice-07.4-pipeline（静态）+ ② 验收（演练） | ① 源扫描 `deploy.sh` 含 `refs/tags/$IMAGE_TAG:docker-compose.yml` 与 fail-closed 分支（判别力自证写注释）。② 发布后演练 v1.3.0 → v1.2.0 → v1.3.0 | 回滚送 master compose（拉不存在的 config-service:旧tag）；取不到 tag 时静默回退到本检出 |

**判据分层（r2-M3）**：C1–C20 + C21① = 本片判据；**C21② 演练** = 验收项（发布后执行，单列——先例片③-B）。

**slice-14 的状态编排（写死；S-C1）**：铁律 = **任何判据不得假设前序切片留下的状态**（新片追加末尾；slice-06/07.1/07.2-hardening/12 对开关**只开不还原**）。slice-14 头部定义 `setFriendRooms(bool)` helper（admin PUT + 轮询 `GET /api/config` 与建房行为至目标态，≤30s），并按序执行：
1. C1（**自带前置 false**）→ C17a → 还原注入
2. C2（改库翻转；收尾经 admin 写回）→ **C17b**（注入超大安全网重复 C2 形态：70s 仍未翻转 ⇒ 还原注入）
3. C8（**先开 ON 窗**（轮询至建房 201）造在途房 ⇒ 置 false ⇒ 三面断言 ⇒ 还原 false）
4. C13（键写死 `friendRoomEnabled`；收尾 false）
5. C16（**自带前置 true** → 停/重启/自愈三段 → 收尾 false）
6. C5半 / C6半 / C14 / C15 / C20（与开关态无关）
7. **统一收尾**：`setFriendRooms(false)`（复原生产默认；C11 只管 fresh——此收尾是卫生，不承担判据）

---

## 4. 测试与夹具迁移

### 4.1 会红的既有判据（逐条处置；实现时**先全仓 grep 一遍**「3101 / baseScoreLevels / base-score-levels / ROBOT_* / 四个周期 env」）

| 位置 | 为何红 | 处置 |
|---|---|---|
| `slice-06-auth-rooms.ts:68/:80/:91` | 种子关 ⇒ 建房 `12006` | 开头经 admin 开启（K4）；**不改断言语义** |
| `slice-06-auth-rooms.ts:109-121` | 旧端点 404 | 改 `GET /api/config`；字段 `levels` → `baseScoreLevels` |
| `slice-07.1:144` · `slice-07.2-hardening:1142-1145` · `slice-12:91/:419` | 同上（建房夹具） | 开头开启（K5） |
| `slice-07.2-rpc.ts`（3101 断言） | user-service 的 TCP 退场 | **逐条改而不删**：断言面迁 `config-service:3106` + `config.snapshot`（K8） |
| `slice-07.2-deploy.ts:552/:918-922/:123/:131/:71` | 镜像/容器/清单数变化 | K7 逐处 |
| `slice-07.4-pipeline.ts` | 触发集合断言**不受影响**（不删 on.push） | 仅 + C21① |
| `protocol/messages.test.ts:52-64` | 九 pattern 名单 | 换一条（B4） |
| `protocol/robot-availability-wiring.gate.test.ts` | 接收侧地图注释/标题 | B5；机制全包扫描应自动覆盖新包——**实现时确认** |
| `room-service/no-internal-http.gate.test.ts:76` | 源码级门禁正则列了 `baseScoreLevels` | 换 `configSnapshot` |
| `room-service/config.client.test.ts` · `rooms.base-score.test.ts` | RPC 名/常量来源 | D9（夹具改造 + 注释订正） |
| `user-service/base-score-levels{,.rpc}.test.ts` | 源删 | **随源删（判据减少，显式登记）**：语义由 C10 继受——表语义/10007/缺省∈表 在新测试与既有判据中各有对应；`migration.test.ts` **保留** |
| client 三测试（`auth-ui-wiring` / `base-score-selection` / `table-center`） | rest 改名/类型搬家 | G5 改造 |
| `mock-server/src/rest.ts:117` · `src/index.ts:16,:59` · `test/rest.test.ts` | 旧端点 | 换 `GET /api/config`（字段/鉴权说明同步） |
| `browser-e2e.mjs:474/:609-697` | 旧端点 + 关闭态不渲染入口 | K9 |
| `slice-13-ai-rollout.ts:698-709`（J22-OFF） | `-e ROBOT_RULE_FALLBACK=false` 退役 ⇒ 关闭态构造失效（热项默认 true ⇒ `canProvide:false` 断言红） | K11 重做（admin PUT false + 容器接网 + 还原） |
| `slice-13-ai-rollout.ts:751-776`（J4） | junk env 不再 fail-closed ⇒ 「照常启动」断言红 | **删改 + 显式登记判据减少**（语义继受 = C5） |
| `shared/test/design-md-ai-rollout.gate.test.ts:95-100`（J18②） | `§2.3` 三行删 ⇒ `toContain` 红 | C2 极性翻转 |
| `robot-service/test/no-switch-in-decision.gate.test.ts:105-108/:128-131`（J29②） | 白名单恰两文件；E1 后文本消失 ⇒ 集合不等红 | E6：白名单同步为**新定义点** |
| `robot.config.test.ts:11` · `douzero.health.test.ts` · `robot.pool.test.ts` | env 解析/默认值来源变化 | E6 随改造登记 |
| `gateway.controller.test.ts:122-140` | 删旧端点转发 ⇒ 红 | F9：改 `GET /api/config` 转发断言（r1-S-M6 补行） |
| compose `:142-144`/`:157-158`/`:301-302` · `design.md:188` 等 | env/注释退役 | I1/I2/L2/J1 |

### 4.2 新夹具/道具

- `lib/http.ts`：`PUT` 支持 + `ADMIN_PASSWORD`（默认值 = conformance-stack 注入值，**两处同源**：`conformance-stack.sh` 的 export 与 helper 常量——写注释互指）+ `adminLogin/adminGetConfig/adminPutConfig` + **`setFriendRooms(bool)`**（置位 + 轮询至生效，≤30s；与 §3 编排小节同名）。
- `compose()` helper（照 `slice-07.3-edge.ts:141-159`：`spawnSync` + `--no-deps` + env 注入 + 复原）与 `exec()` helper（先例 = `slice-07.5-backup` 的 `docker exec ftl-mysql …` / `scripts/ops/restore.sh:234-235` 的 `sh -c` 凭据形态——r1-S-M3；CI 必带 `-T`）。
- config-cache 单测替身：假 RPC 客户端（可控成功/失败）+ 假定时器（vitest fake timers）+ 假 Redis 订阅（复用既有 Redis mock 形态）。

---

## 5. conformance

- **slice-14-config-center.ts（新）**：C1/C2/C5半/C6半/**C7**/C8/C13/C14/C15/C16/C17/C20 的载体；**追加在 `run.ts` 末尾**（`:56-57` 纪律：CI 顺序 = CASES 顺序 = baselines `full` 列顺序）。
- **`--fresh` 模式（C11）**：`run.ts` 新增；conformance.yml 在「起真栈」与「跑全部切片」之间加一步 `node tools/conformance/dist/run.js --fresh`。**不进 baselines**（不是切片）。
- **C21①** 放 `slice-07.4-pipeline`（它已是「发布管道静态面」的切片）。
- `baselines.json`：slice-14 条目由 **CI 运行回填**（本机跳过项纪律不变——`flock` 等 14 条在 Windows 显式跳过）；slice-14 **不进** `render` 列（`ci.yml:47-53` 的键集机制强制显式）。
- 旧切片改造全部**只增/改、不弱化**（禁「改宽断言」）。

---

## 6. 部署与回滚

0. **前置**：本机重建 8 镜像（`docker compose build`）；conformance 栈在 CI 上全绿。
1. **清单与编排**：§1 的 I1–I6 全部落地（compose/override/脚本/工作流）。
2. **服务器 `.env`（手工、一次性）**：追加 `ADMIN_PASSWORD` 与 `ADMIN_JWT_SECRET`（手册新节给命令；`.env` 部署永不覆盖）。
3. **发布**：master 推 origin ⇒ CI/conformance 全绿 ⇒ 打 tag **`v1.3.0`** ⇒ release（images → conformance → deploy）。
4. **上线后运营**：好友房处于**关闭态**（默认关）；要开：登录 `https://<域名>/admin` 打开（手册「怎么改配置」节；口令 = 第 2 步设的那个）。
5. **回滚**：一键（工具链修复后）：dispatch + 填旧 tag（**全量换 tag**）；旧 compose 不含 config-service ⇒ 该容器**留作孤儿运行**（无害、下次前进自动复用）；⚠️ ops 脚本仍从**本检出**送机（**刻意偏离**：早于片③-B 的旧 tag v1.0.0/v1.0.1 无 `scripts/ops/` 文件）；**禁止按服务手工混部**。
6. **跨边界回滚演练（验收，C21②）**：`v1.3.0 → v1.2.0 → v1.3.0` 各一次（发布后执行；证据 = 两次 deploy 日志 + 线上 `/api/health`）。
7. **`baselines.json` 回填**：slice-14 的 `full` 列取 CI 运行日志的 `[baseline]` 行（**不得**用本机读数）。
8. **手册同步**：§1-J2 全表（含 `:249` 预期输出重算——**手册预期输出是判据的一部分**）。

---

## 7. 兼容面（可测的部分）

| 组合 | 行为 | 能否测 |
|---|---|---|
| 新 config-service + 旧 room-service（读老 RPC） | 老 RPC 已删 ⇒ **失败**（10007）⇒ 建房/入队不可用 ⚠️ **工具链全量换 tag ⇒ 不存在稳态混合**（重建期瞬态以秒计，由 D2 重试自愈） | 只能推理（并禁止手工制造） |
| 新 room-service + 旧 config-service | RPC 不存在 ⇒ 热项默认值；底分 fail-closed ⇒ 建房失败（吵闹） | conformance（可造） |
| 老 robot-service（读 env）+ 配置中心在跑 | 老代码用 env 默认值；与种子同值 ⇒ **行为不变** | 只能推理 |
| 老客户端（部署瞬间已打开的旧 H5 页面） | 旧端点 404 ⇒ 空档位 + 一次错误提示；**刷新即恢复**（裁决 10） | 只能推理（§5.2-3） |
| 在途好友房（切换前建的） | 建/占座已拒，在途房间可正常打完（WS 路径不拦） | conformance（可造） |
| 回滚跨配置中心边界（v1.3.0 ⇄ v1.2.x） | 一键回滚可用；孤儿容器无害 | **演练（C21②）** |

⚠️ **规格订正（对设计 D8-3 的保守并列）**：九键的消费者是 **room-service / robot-service / 客户端**；**game-service 不消费任何键**（不装配 config-cache、不加任何 env）。

---

## 8. 明确不做（YAGNI）

1. RBAC / 多管理员 / 权限表；2. 配置变更历史表 / 一键回滚到上一版；3. 灰度重启机制；4. 配置放 Redis（持久真源必须 MySQL）；5. 客户端可视化配置；6. 基础设施类 env 进配置中心；7. 配置中心自身多实例（读路径多实例安全性已推演：独立快照 + 广播 + 安全网 ⇒ 安全）。

## 9. 风险

沿用设计 §8 的 R1–R6；**新增 R7**：本片改发布管道本身（deploy.sh 按 tag 取 compose）——改动局部、两路共用、`git show` 失败 fail-closed；下次发布即真实检验（C21①）+ 演练（C21②）护住。

## 10. 下一步

1. 本文**过规格审查**（独立子 agent：事实核验 + 完整性与可执行性，逐轮修订到满意）；
2. 规格定稿 ⇒ **写计划**（task-brief 拆分 + 子 agent 实现）；
3. 计划过审 ⇒ 实现（子 agent）→ 自测 → 门禁 → 上线（发布 + 演练 + 验收）。
