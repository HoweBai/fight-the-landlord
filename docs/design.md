# 斗地主平台设计规格 v4

> 版本: v4.3
> 日期: 2026-09-17
> 状态: 待评审
> 权威性: **本文是本项目 MVP 范围内的唯一设计依据。**
> 上游参考: `docs/2026-08-31-game-platform-architecture-design.md`（v3.2，平台架构参考，保留为历史资料）
> 前身: 本文件在 v4.0 之前的版本（v1.0，见 git 历史）已被取代
>
> **修订记录**
>
> - v4.0：合并两份旧设计文档，补齐玩法规则、五个零规定契约与接口边界；附录 A.1 记录 18 项冲突裁决
> - v4.1：按三份独立审查修正——补 `PlayerView` / 推送链路 / `baseVersion` 适用范围，修正 `game.deal` 与 `game.settlement` 载荷、M02 与重连的版本判定、限流存储类型、环境变量使用者列、`Seat`/`RoomInfo`/`RoomPlayer` 定义、身份映射（`userId` → `GamePlayer.id`）、机器人入座与归池闭环、匹配成功通知通路（`room.matched`）、`13010`；A.2 由 49 条增至 52 条
> - v4.2：**只做澄清，不改语义**。补 §6.6 的「重连窗口起点与记录刷新时机」——原 v4.1 只说「窗口 30 秒 + 记录 TTL 35 秒」，未规定 30 秒从哪一刻起算，导致 `room.join` 后超过 35 秒的一次断线**必然**拿不到重连记录（实测 `13010`）。同时补 §6.6 的判定顺序（`match:pending` 回退、`13005`/`13009`/`13010` 的分工）与「重连成功必须恢复投递链路」。由协调者在切片 5 开工前裁决并落盘
> - v4.3：**只做澄清，不改语义**。§6.2 的丢弃规则表补一句「比较集限于**同一局**」（§12.3 M08 同步）：`version` 是每局版本号（§0.3），跨局的 `50 → v1` **不是回退**而是换命名空间 ⇒ 客户端必须在**换房间**时复位 `currentVersion`，否则新局的 `v1` 会被判成回退并丢弃（真浏览器实测：`game.reconnect` 连发 → `13010` → 被踢回大厅，**第二局永远进不去**）。由协调者在切片 P9 裁决（R417）并落盘

---

## 0. 文档说明

### 0.1 权威性

本文与本项目两份旧文档的关系：

| 文档                                        | 地位                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **本文（v4）**                              | MVP 范围内的**唯一依据**。实现、测试、评审均以本文为准                                              |
| `2026-08-31-...-design.md`（v3.2，4419 行） | **平台架构参考**。其功能范围远大于 MVP；超出 MVP 的部分整体移入 `docs/appendix/platform-roadmap.md` |
| `docs/design.md` v1.0                       | **已被本文取代**，仅作历史留存                                                                      |

两份旧文档之间存在 18 处互相冲突的规定（其中 13 处旧文档未声明）。冲突的逐条裁决见 **附录 A.1**，实现与本文的偏差见 **附录 A.2**。

### 0.2 标记约定

本文条款使用以下行内标记说明与**当前代码**的关系：

| 标记         | 含义                                       |
| ------------ | ------------------------------------------ |
| `[已实现]`   | 当前代码与本文一致                         |
| `[部分实现]` | 部分一致，缺口见附录 A.2                   |
| `[待实现]`   | 当前代码尚未实现                           |
| `[偏差]`     | 当前实现与本文**规定不一致**，须按本文修正 |

**未标记的条款默认为 `[待实现]`。**

### 0.3 术语表

| 术语                | 含义                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| 座位（seat）        | 玩家在房间中的位置，取值 `0 / 1 / 2`。**与数组下标恒等**，但语义上以座位号为准    |
| 底牌                | 发牌后剩余的 3 张牌，归地主所有                                                   |
| 倍数                | 结算乘数，由叫抢倍数、炸弹数、春天合成（见 `docs/games/doudizhu.md` §8.2）        |
| baseScore           | 底分。2026-10-21 起**无代码缺省**：建房省略时取档位表**数值最小档**；救助门槛同源 |
| 对局版本（version） | 每局状态版本号，每次状态转移 +1，用于状态新鲜度判定与乐观锁                       |
| 裁剪视图            | 按接收者座位生成的状态视图，隐藏他人手牌（见 §6.4）                               |
| 谓词                | 匹配阶段判定一组玩家能否开局的纯函数（见 §8.3）                                   |

---

## 1. 目标与范围

### 1.1 产品目标

做一个**服务端权威**的在线多人斗地主：3 人一局，支持匹配、断线重连、AI 机器人补位。

### 1.2 MVP 范围（做）

| #   | 能力                                           |
| --- | ---------------------------------------------- |
| 1   | 注册 / 登录 / JWT 鉴权                         |
| 2   | 房间创建与加入                                 |
| 3   | 随机匹配成局（3 人）                           |
| 4   | 完整对局：发牌 → 叫抢地主 → 出牌 → 胜负 → 结算 |
| 5   | 断线重连（全量裁剪快照）                       |
| 6   | AI 机器人补位（服务端驱动）                    |
| 7   | 回合超时与自动行为                             |

### 1.3 明确不做（YAGNI）

以下**不在 MVP 范围**，但本文在相应位置保留了扩展点；功能细节见 `docs/appendix/platform-roadmap.md`：

- 货币系统、充值、提现、对账（原 Currency / Payment / Audit Service）
  - 📌 **注记（2026-10-04）**：**货币核心**已落地（`currency-service`：钱包 / 账本 / 幂等 apply / 管理发放 / 对账自检；P2-① 第一步 —— 本行「货币系统」已反转）—— 依据 = `docs/superpowers/specs/2026-10-03-currency-design.md`/`-spec.md` + J1 三步裁决；**充值 / 提现 / 对账报表与稽核（Audit）/ RBAC 不在其内**（P2 后续与 J1 第 ③ 步，另立项）。
- 风控系统、申诉流程
- 管理后台、RBAC、Admin JWT
- 数据看板、Prometheus / Grafana / Elasticsearch
  - ⚠️ **注记（2026-10-03）**：监控片**已落地**（Prometheus/Grafana 全栈；本行的「不做」**已反转**）—— 依据 = 路线图「监控片」节 + 用户裁决；**Elasticsearch 不在其内**（监控片明确不做日志聚合/检索，那一半照旧）。
- 多玩法（麻将、扑克）——**MVP 不做，也不提前抽象**；是否引入策略模式应在**第二个玩法开工前**决定，见 `docs/appendix/platform-roadmap.md` §2.2
- 好友系统、观战、聊天
- 地理匹配（500m 谓词）、ELO 匹配算法
- K8s、Redis Cluster、MongoDB 归档、RabbitMQ

### 1.4 前端形态说明

- **目标态**：uni-app（两份旧文档均选 uni-app，`design.md §十` 称参考文档选 Cocos3D 系**转述错误**）。
- **现状（切片 P10 迁移后，2026-09-17）**：`apps/client` 是**唯一**前端，且**已经是 uni-app 工程**（Vue 3 线，
  `@dcloudio/*@3.0.0-alpha-5020620260914001`，编译器 5.26；Vite 被钉在 **5.2.8** —— 该插件的 peer 是精确版本）。
  工程形态：`src/pages.json`（页面栈：`pages/login/login` · `pages/lobby/lobby` · `pages/game/game` · `pages/table/table` · `pages/history/history` · `pages/wallet/wallet`〔支付片=第 6 页，§7.7〕）
  - `src/manifest.json`（各端配置）+ `src/main.ts` 的 uni-app 入口约定（`createSSRApp` + `createApp()`）
  - `src/App.vue` 作为**应用外壳**（uni-app 里它的模板不渲染）。
    端能力：页面栈走 `uni.reLaunch`（`src/router.ts` 的 `pageUrl()` 是唯一映射，**`auth.page` 仍是唯一状态源**）、
    本地会话走 `uni.getStorageSync`/`setStorageSync`、传输层 H5/App 走原 socket.io 路径、
    **微信小程序走 `src/net/mp-transport.ts`（`wx.connectSocket` 上的 engine.io v4 适配层）**。
    UI 侧：design token 单一真源 `src/uni.scss`（`$ftl-*`）+ `rpx` 单位体系 + `wot-design-uni`（**easycom 零 import**，
    只用于展示型组件；`button`/`input` 保持 uni-app core 组件）。
    **哑终端原则不变**：`src/**` 的裸依赖仍恰好是 `['pinia','socket.io-client','vue']`，§12 的 8 条机械闸一条未放宽。
- **各端的验证状态（R440：未验证的端不得写成「已支持」）**：
  **H5 = 已验证**（真浏览器探针：dev `gate` 16/16 · `full` 20/20；**发行产物** `minimal` 8/8 · `gate` 16/16）。
  **微信小程序 = ✅ 已验证（2026-09-17，用户实测）**：用户在 Windows + 微信开发者工具 3.17.2 上跑通
  **注册 → 大厅 → 随机匹配 → 牌桌 17 张牌 → 完成对局**（连续三局，无阻塞）；协同旁证取自语网本机日志
  （`[ProxyGateway] Client connected (user: …)` ＋ 三处 `[WsGateway] Released 2/2 bot(s)`，
  机器人释放只发生在对局收束时）。⇒ **`socket.io` 经 `mp-transport` 在小程序端确实连得上**（硬约束 (e) 有答案）。
  **结构面**（下面是当时的部分验证记录）：三端构建产物存在且结构判据通过（`app.json#pages`、`usingComponents` 15/15 解析、
  `wd-*` 组件四件套齐全）+ **两条适配层**（socket 走 `src/net/mp-transport.ts`；**REST 走 `src/net/http.ts`**，
  自 P17 起 —— 在此之前 REST 是裸 `fetch`，小程序端**注册第一步就挂**）的结构单测；
  小程序端**没有「同源」概念** ⇒ 端点必须绝对地址，构建入口是
  `node scripts/build-mp-weixin.mjs <host:port> [--dev]`（配错会**响亮报错**，不静默）；
  小程序端**回填实测的第一轮**已抓到一个**阻断级缺陷**（P19 修掉）：产物里因 `typeof import.meta` 守卫
  生成了 `require("url")` 分支，而小程序 service 上下文没有 `document` ⇒ 必抛
  `module 'url.js' is not defined` ⇒ `app.js` 模块图中断（连带 `Page "…" has not been registered yet`）；
  现改为**直接属性访问** `import.meta.env.*`，并加了**源码级闸**与**产物级断言**（构建入口自动扫 `require("url")`）。
  **过程中修掉四处阻断级缺陷**（都由这次回填抓出）：**P17** REST 用裸 `fetch`（小程序无 `fetch`）·
  **P19** `typeof import.meta` ⇒ 产物 `require("url")` 求值期崩 · **P20** 传输缺 engine.io 契约面（`query`）·
  **P21** 同步 `drain` 栈溢出 + pong 归属。⚠️ **App 端仍未验证**（HBuilderX/云打包未做；真实 APK/IPA 需 DCloud 凭据），
  清单见 `docs/superpowers/plans/2026-09-17-n39-miniprogram-app-backfill.md` 的 B1–B4。
  **App = 部分验证**：`uni build -p app` 产物存在（`dist/build/app`）；**运行调试与云打包未验证**
  （需 HBuilderX + DCloud 凭据，iOS 还需 macOS）。
  ⇒ 详细登记见 `deviation-ledger.md` 的 **N33（已关闭）** 与 **N39（仍开放：两端运行期待回填）**。
  背景：原阻塞「脚手架依赖离线不可用」**经实测已不成立**（npm registry 可达），迁移已按用户裁决 R428 完成。
  `web/index.html` 那个单文件临时验证页**已于 `5be7522`（A6/S4/S5）整条删除**，`web/` 目录不存在，其违反 §12 的部分随之消失（§12.5 见「已清除」）。

---

## 2. 架构总览

### 2.1 服务清单与端口

| 服务 | 对外 HTTP 端口 | 内部 RPC 端口 | 技术栈 | 数据层 |
|------|----------------|---------------|--------|--------|
| edge（门口） | **80 / 443**（**唯一对外入口**；宿主侧由 `EDGE_HTTP_PORT` / `EDGE_HTTPS_PORT` 参数化，容器内监听 = `SITE_ADDRESS` 的端口 + 固定的 `:80` 跳转） | — | Caddy 2（TLS 终止 + H5 静态站 + 反代） | — |
| api-gateway | **3000**（**网内**：不发布到宿主机，`expose: 3000`） | — | NestJS + Express | **Redis（限流计数）** |
| user-service | **3001** | **3101**（记录片重挂，§4.2/§7.6） | NestJS + TypeORM + bcrypt | MySQL + **Redis（令牌白名单）** |
| config-service | **3006** | **3106** | NestJS + TypeORM | MySQL（`platform_config` = 五十一键配置的**持久真源**）+ Redis（失效广播 `config:changed`） |
| room-service | **3002** | — | NestJS + ioredis | Redis |
| game-service | **3003** | **3103** | NestJS + ioredis | Redis |
| robot-service | **3005** | **3105** | NestJS | **Redis（机器人池）** |
| currency-service | **3004** | **3104** | NestJS + TypeORM + ioredis | MySQL（三表 `currency_accounts/currency_ops/currency_flows`，迁移表 `migrations_currency`）+ Redis（余额只读缓存） |
| payment-service | **3007** | —（**零被调 RPC 面**，⚙️2；出站 = 渠道 HTTPS + currency/config 的 TCP 客户端） | NestJS + TypeORM + ioredis | MySQL（支付五表，迁移表 `migrations_payment`）+ Redis（回调限流桶；配置推送订阅） |
| douzero | **2021** | — | Python + onnxruntime | 本地 ONNX 模型（**9 个**：3 档 × 3 位置，`models/<model>/<position>.onnx`） |
| redis | **6379** | — | redis:7 | — |
| mysql | **3306** | — | mysql:8.0 | — |

约定：

- **对外 = 门口（`edge`）**：生产形态**只有**它把端口发布到宿主机（`80` / `443`）；表内其余端口（含 `api-gateway:3000`）一律**网内**（`expose`），仅供网关/服务间使用 —— 开发形态由 `docker-compose.override.yml` 把宿主映射放回来（§2.2）。
- **内部 RPC 端口**仅供服务间 `Transport.TCP` 使用，不对外暴露。
  `[裁决]` 参考文档 §3.2.1 把 `game-service:3001` 当作 RPC 端口，与 user-service 的 HTTP 端口号撞车；本文用 3000 段做 HTTP、3100 段做 RPC 彻底分离。
- `[已实现]` HTTP 端口段与当前 `docker-compose.yml` 一致。
- `[已实现]` 八个服务**全部**从 `process.env.PORT ?? <自身端口>` 读端口（E2 于独立小片 P3 收口；货币片 +1；支付片 +1），不再有硬编码 `listen(...)`。

### 2.2 部署拓扑

本地开发与 MVP 部署均使用 `docker-compose.yml`（R1203/R1209：容器数按形态分写 —— **开发形态**不显式给 `-f` 时 Compose 自动合并 `docker-compose.override.yml`，默认 **11 个容器**（片⑦ 配置中心起；货币片 +1；**支付片 +1**），按需加门口 `docker compose --profile edge up -d edge` ⇒ **12 个**、`--profile monitoring` ⇒ **17 个**、两者都加 ⇒ **18 个**；**生产形态**（`-f docker-compose.yml`）**18 个** = 11 + 门口 `edge` + 监控六容器，§7.1）。服务间通过 bridge 网络 `ftl-platform` 按服务名互相寻址。

**镜像来源**：14 个自建镜像（`douzero` + 8 个 Node 服务 + 门口 `edge` + 监控四件）由 CI 构建、推到私有 GHCR，命名规则唯一 —— `image: ${IMAGE_PREFIX:-pokergame}-<svc>:${IMAGE_TAG:-latest}`（R1303）。服务器**只拉取、不构建**。

**服务器形态**：`/srv/pokergame/` 下**只有** `docker-compose.yml`（由流水线 `scp` 送）与 `.env`（手工写一次、部署永不覆盖）—— **不放仓库、不放部署密钥、不放长期镜像库凭据**（R1306）。

- **不使用服务发现**（参考文档 §3.6 提到的 Consul 仅 3 行注释、无实现）。地址一律由环境变量注入。
- K8s 见 `docs/appendix/platform-roadmap.md` §5。

### 2.3 环境变量表

| 变量 | 使用者 | 默认值 | 说明 |
|------|--------|--------|------|
| `PORT` | 全部服务 | 各服务自身端口 | **禁止硬编码端口** |
| `JWT_SECRET` | gateway / user-service / **config-service**（管理令牌的**回落钥**，§7.5） | `dev-secret-change-in-production` | HS256 密钥，生产必须覆盖 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | user-service / config-service / currency-service / payment-service | `localhost` / `3306` / `root` / `root` / `fight_the_landlord` | —（四服务共库 `fight_the_landlord`，各持独立迁移表） |
| `REDIS_URL` | **全部服务**（含 gateway / user-service / robot-service） | `redis://localhost:6379` | 限流计数、令牌白名单、机器人池都需要 |
| `INTERNAL_SERVICE_TOKEN` | 全部服务 | （无默认值，必须注入） | 服务间调用的内部密钥；网关拒绝任何携带该头的外部请求（§5.2） |
| `RPC_PORT` | game-service / robot-service / config-service / **currency-service** / **user-service** | `3103` / `3105` / `3106` / **`3104`** / **`3101`** | **RPC 监听端口**（`connectMicroservice` 用，§4.2）。⚠️ **3101 的两次叙事（别读混）**：片⑦ 退役的是「room→user 读**底分档位表**」那条**边**、**不是端口**；**2026-10-03 记录片以新边 `record.write`（room → user，写对局记录，§7.6）重挂 3101** —— **不设**应用层 token（**R223**：TCP 面不做应用层鉴权，安全边界 = compose `expose` 内网 + 宿主映射仅 override）。⚠️ **货币片**：currency-service 的 3104 是本表的新空位（`currency.apply`/`currency.get` 两条 RPC 边的接收侧，2026-10-03） |
| `USER_SERVICE_URL` | gateway | `http://localhost:3001` | — |
| `ROOM_SERVICE_URL` | gateway | `http://localhost:3002` | — |
| `ROOM_SERVICE_WS_URL` | gateway | `http://localhost:3002` | WS 代理目标 |
| `GAME_SERVICE_URL` | **仅 gateway** | `http://localhost:3003` | 仅网关使用（§4.1 的「gateway → game-service HTTP」那条边）；room-service → game-service 走 TCP RPC（N20/P4 已落地，`GAME_SERVICE_RPC_*`） |
| ~~`ROBOT_SERVICE_URL`~~ | ~~无~~ | ~~`http://localhost:3005`~~ | **已废弃**（N20/P4 收口）：§4.1 的调用表里没有任何一条「HTTP → robot-service」的边 —— gateway 从不代理它（R136），room/game 两条边已迁到 `ROBOT_SERVICE_RPC_*`（TCP 3105）。全仓代码与 compose **0 命中** |
| `GAME_SERVICE_RPC_HOST` / `GAME_SERVICE_RPC_PORT` | room-service | `game-service` / `3103` | TCP RPC（开局、查询对局） |
| `ROBOT_SERVICE_RPC_HOST` / `ROBOT_SERVICE_RPC_PORT` | **room-service / game-service** | `robot-service` / `3105` | TCP RPC（room→robot 补位、game→robot 决策） |
| `CONFIG_SERVICE_RPC_HOST` / `CONFIG_SERVICE_RPC_PORT` | **room-service / robot-service / user-service / currency-service / payment-service / api-gateway**（依次各片新增消费方：user 记录片 §7.6 · currency 金币场 · payment 支付片 §7.7 · api-gateway 客户端接入片 §7.5——两键闸值经网关自己的快照缓存读取） | `config-service` / `3106` | TCP RPC（读配置快照 `config.snapshot`，§4.2/§7.5）—— 片⑦ 起取代原 room→user 的 `config.baseScoreLevels` 边（**那条边**已退役；⚠️ 别把它读成「`USER_SERVICE_RPC_*` 这个名字退役了」—— 见下一行） |
| `USER_SERVICE_RPC_HOST` / `USER_SERVICE_RPC_PORT` | **room-service** | `user-service` / `3101` | TCP RPC（**记录片重挂 3101** 后的唯一一条边：`record.write`，§4.2/§7.6；超时 3s、不重试，§4.3 表同族已登记窗口） |
| `CURRENCY_SERVICE_RPC_HOST` / `CURRENCY_SERVICE_RPC_PORT` | **user-service**（货币片新增消费方，§4.4）+ **payment-service**（支付片新增消费方，§7.7） | `currency-service` / `3104` | TCP RPC —— user 侧 = **唯一写边** `currency.apply`（注册赠送；超时 3s、**不重试**，失败语义见 §4.3 表 · 规格 §2.7/⚙️8）；payment 侧 = **只读**边 `currency.withdrawable.get`（cap 取数，锁内实时、fail-closed，§7.7） |
| `DOUZERO_URL` | robot-service | `http://localhost:2021` | — |
| `DOUZERO_MODELS` | douzero | `/app/models` | ONNX 模型目录（布局 `models/<model>/<position>.onnx`，9 个） |
| `ADMIN_PASSWORD` | **config-service**（管理面） | （无默认值；**空串 = 未设**） | 管理面的**首启引导口令**（§7.5，③ 起）：只在 `admin_accounts` **空表**的首次启动用它 `INSERT` 引导账号 `admin`（`super_admin`/`active`，scrypt 哈希）；账号一建好本键**不再参与任何判定**（管理面启用谓词 = **表非空**）⇒ **零账号才 ⇒ 管理面整体关闭**（登录回 404）。日常口令改在管理页/hatch（§7.5）；不是服务启动密钥 ⇒ 漏配不影响玩家 |
| `ADMIN_JWT_SECRET` | **config-service（签发）+ api-gateway（验签）** | （空串 = 未设 ⇒ 回落 `JWT_SECRET`） | 管理令牌（JWT，`aud:'ftl-admin'`、TTL 2h）的**独立**签名密钥；⚠️ **两侧同链**：`ADMIN_JWT_SECRET \|\| JWT_SECRET \|\| dev 兜底`（**`\|\|` 非 `??`**：compose 空默认渲染出空串，`??` 不回落） |
| `CONFIG_SERVICE_URL` | **仅 gateway** | `http://localhost:3006` | gateway → config-service 的 HTTP 基址（`/api/config` 与 `/api/admin/*` 反代，§4.1/§7.5） |
| `CURRENCY_SERVICE_URL` | **仅 gateway** | `http://localhost:3004` | gateway → currency-service 的 HTTP 基址（`/api/wallet/balance` 与 `/api/admin/wallet/*` 反代；货币片 T7，2026-10-03；compose 显式 `http://currency-service:3004`） |
| `PAYMENT_SERVICE_URL` | **仅 gateway** | `http://localhost:3007` | gateway → payment-service 的 HTTP 基址（`/api/pay/*` 玩家面与 `/api/admin/pay/*` 管理面反代；支付片 T2 登记面，2026-10-05；compose 显式 `http://payment-service:3007`。⚠️ `/pay/notify/*` **不经**网关 —— edge 直连，规格 §2.7.1） |
| `PAY_CONFIG_ENC_KEY` | **仅 config-service** | （空串 = 未设 ⇒ **三个凭据键空间（第二 / 第三 / 第四）的存储均不可用**：管理三端点各 503（支付渠道 / 通知通道 / 广告回调）/ RPC `config.payChannel.get`、`config.notifyChannel.get` 与 `config.adChannel.get` 均拒拉；**其余面不受影响**——懒校验） | **渠道六项 + 通知九键 + 广告回调密钥（恰 1 键）三个凭据键空间的 AES-256-GCM 加密主钥**（base64，解码后**恰 32B**；支付配置管理化片 2026-10-06 建，**通知通道管理化片 2026-10-07 复用**，**广告片 2026-10-12 复用**——名字债在案，空间中性名留待 rename）：三键空间各见 → §7.5「渠道凭据第二键空间」「通知通道键空间」；第四键空间（广告回调密钥）的设计面登记见台账·广告片条款。**空默认透传**（`${VAR:-}`，⚙️13：非空默认会让「unset 主钥」构造不出来）；dev 值由栈脚本/开发者 shell 供给；生产必填（服务器 `.env`；备份打包前剥本行，主钥副本用户自持——⚠️ **恢复必须用原钥匙的副本**：换新钥后旧值全部解不开，非密键连改/清都会被门住，见手册「数据没了怎么办」恢复节） |
| `PAY_CHANNEL_PULL_TOKEN` | **config-service + payment-service**（双持有、同值） | （空串 = 未设 ⇒ config-service 端**拒一切拉取**；payment 端拉取被拒 ⇒ 渠道未配置语义（15001）；**不阻塞启动**——fail-closed） | 渠道凭据专用拉取通道 `config.payChannel.get` 的**令牌**（支付配置管理化片 2026-10-06；服务端常数时间比对；**值不入日志**——`redact.ts` 键名规则兜底）。渠道六项已管理化 → §7.5（T17 建节）；**空默认透传**（`${VAR:-}`，⚙️13）；生产两端必填（服务器 `.env`，两端同值） |
| `NOTIFY_CHANNEL_PULL_TOKEN` | **config-service + alert-relay + am-renderer**（三端同值） | （空串 = 未设 ⇒ config-service 端**拒一切拉取**；消费端拉取被拒 ⇒ last-good/从未拉到语义；**不阻塞启动**——fail-closed） | 通知配置专用拉取通道 `config.notifyChannel.get` 的**令牌**（通知通道管理化片 2026-10-07；服务端常数时间比对；**值不入日志**——`redact.ts` 键名规则兜底）。通知九键已管理化 → §7.5「通知通道键空间」（小节 T17 建）；**空默认透传**（`${VAR:-}`，⚙️13）；生产三端必填（服务器 `.env`，三端同值） |
| `AD_CHANNEL_PULL_TOKEN` | **config-service + currency-service**（双持有、同值） | （空串 = 未设 ⇒ config-service 端**拒一切拉取**；currency 端拉取被拒 ⇒ 无 last-good ⇒ 回调 5xx（瞬态、可重投）；**不阻塞启动**——fail-closed） | 广告回调密钥专用拉取通道 `config.adChannel.get` 的**令牌**（广告片 2026-10-12；服务端常数时间比对；**值不入日志**——`redact.ts` 键名规则兜底）。第四键空间（广告回调密钥，恰 1 键）已管理化；**主钥复用 `PAY_CONFIG_ENC_KEY`（无新主钥键）**；**空默认透传**（`${VAR:-}`，⚙️13）；生产两端必填（服务器 `.env`，两端同值） |
| `SITE_ADDRESS` | **edge（门口）** | （无默认值，必须注入） | 站点地址（域名，不带端口）；同时决定证书对象与容器内监听端口。漏配 ⇒ 门口**启动即失败**（fail-closed，R1202） |
| `TLS_MODE` | **edge（门口）** | （无默认值，必须注入） | `邮箱` = ACME 真证书；`internal` = 自签（**只开发用**）。漏配 ⇒ 门口**启动即失败** |
| `EDGE_HTTP_PORT` | edge（门口） | `80` | 宿主侧 HTTP 发布端口（容器内的跳转监听**固定** `:80`；ACME HTTP-01 也走它） |
| `EDGE_HTTPS_PORT` | edge（门口） | `443` | 宿主侧 HTTPS 发布端口（**生产保持默认**；自定义端口只属开发形态） |
| `TRUST_PROXY` | **仅 api-gateway** | 基文件 = 门口固定地址（**字面**）；开发形态 = 空 | 可信代理范围 = **门口一跳**（R1205）；⚠️ 限流在**网关** ⇒ 放门口完全无效 |
| `IMAGE_PREFIX` | **全部自建镜像**（compose 的 `image:`） | `pokergame` | 镜像库前缀。CI 里传 `ghcr.io/howebai/fight-the-landlord`；默认值下镜像名与旧形态逐字相同（门口除外） |
| `IMAGE_TAG` | **全部自建镜像**（compose 的 `image:`） | `latest` | 镜像标签。部署/回滚时传要上的那个 tag |

### 2.4 健康检查

每个服务暴露 `GET /api/health`：

```json
{
  "status": "ok",
  "service": "game-service",
  "checks": { "redis": "up", "mysql": "up" }
}
```

- `status`：`ok` | `degraded`
- HTTP 状态码：`ok` → 200，`degraded` → 503
- `docker-compose.yml` 的 healthcheck 依赖此端点
- `[已实现]`（P5，裁决 R267/R284–R296）**就绪/存活分离**，两个端点：

  | 端点                   | 语义                       | 依赖                                      | 状态码                            | 响应体                                                |
  | ---------------------- | -------------------------- | ----------------------------------------- | --------------------------------- | ----------------------------------------------------- |
  | `GET /api/health`      | **就绪**（可服务吗）       | **真查**本服务已有的 Redis / `DataSource` | `ok`→**200**，任一 `down`→**503** | `{ status, service, checks }`                         |
  | `GET /api/health/live` | **存活**（进程还在响应吗） | **不查任何依赖**                          | 恒 **200**                        | `{ status:'ok', service }`（**不含 `checks`**，R285） |
  - **为什么分两个**：只有就绪面时，Redis 一抖容器就 `unhealthy`；而**存活探针不该因为下游抖动而失败** —— 那会让编排层去杀一个完全健康的进程。分开之后 `unhealthy` 才真正表示「不该接流量」。
  - **`checks` 只报自己真的依赖的**（不得为了「看起来齐全」报假信息）：`user-service` 与 `config-service` = `{redis, mysql}`，`api-gateway`/`room-service`/`game-service`/`robot-service` = `{redis}`。
  - **不新建连接**：每个服务复用它**已有的** Redis provider（`api-gateway` 的 `REDIS` 字符串 token、`user-service` 的 `RedisModule` + TypeORM `DataSource`、`room`/`game`/`robot-service` 的 `RedisProviderModule`）。`game-service` 的 Redis 原先藏在 `GameService` 构造函数里 `new Redis()`，P5 起提成 `src/redis.provider.module.ts` 的 provider，业务与健康检查共用**同一个实例**（R284）。
  - **检查实现逐服务各一份**（沿用 R23：不把 Nest 代码塞进 `shared`/`protocol`，也不新建 workspace 包），但形状与文案逐字一致；**机械闸** `packages/api-gateway/test/container-assembly.gate.test.ts` 钉住三条装配不变式（R295，8 条用例）：健康路由 ⊆ 免鉴权清单、一个控制器只被一个模块注册、同一服务内无同路径重复路由。
  - ⚠️ `GET /api/health/live` 是 **§7.1 公开路径白名单的第 5 条**（**精确**条目，不是前缀 —— `/api/healthz`·`/api/health/livex` 仍 401）。

---

## 3. 数据模型

### 3.1 Room `[已实现]`

> `[已实现]`（P8 复审：五条（`Seat`/`Room`/`RoomInfo`/`RoomPlayer`/内部 Seat 与下发 RoomPlayer 分离）全落地：`protocol/src/views.ts:9-30`、`room-service/src/rooms/rooms.service.ts:13-29` + `rooms.timeout.ts`；测试 `rooms.timeout.test.ts`、`rooms.service.test.ts:192`、`message.router.test.ts:317-327`）

```ts
/** 房间内的座位占用（服务端内部结构，含 isRobot） */
interface Seat {
  userId: string; // 人类为 userId；机器人为 displayId（§9.2）
  seat: number; // 0 / 1 / 2
  isRobot: boolean; // 仅服务端存储，永不下发（§6.4）
}

interface Room {
  code: string; // 6 位大写 base36，服务端生成
  mode: "random" | "practice";
  baseScore: number; // 省略时由服务端取档位表数值最小档（2026-10-21：无代码缺省）
  players: Seat[];
  maxPlayers: 3;
  status: "waiting" | "playing" | "finished" | "cancelled";
  createdAt: number;
  timeoutAt: number; // waiting 状态的超时时刻
}

/** GET /api/rooms 的列表项与 POST /api/rooms 的创建响应 */
interface RoomInfo {
  code: string;
  mode: "random" | "practice";
  status: "waiting" | "playing" | "finished" | "cancelled";
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
}

/** 下发给客户端的房间成员（已裁剪，绝不含 isRobot） */
interface RoomPlayer {
  id: string; // = Seat.userId（机器人为 displayId）
  seat: number;
  cardCount?: number; // 仅对局中下发（§6.4 规则 3）
}
```

- **字段名以本节为准**：服务端内部用 `Seat`（`userId`），下发给客户端一律用 `RoomPlayer`（`id`）。`room.state_update` 的 `players` 元素即 `RoomPlayer`。
  > `[已实现]`（E6/C6 等逐条关闭）`status` 四态齐全（含 `cancelled`）· `Room.baseScore` 与 `Room.timeoutAt` 均已落地（E6：`timeoutAt` = `waiting` 状态的超时时刻，离开 `waiting` 即归零）· `room.state_update` 的 `players` 为 `RoomPlayer[]`（`RoomInfo` 见 §7.3）。

### 3.2 GameSession `[已实现]`

> ✅ **P12 收口（R472）：三条缺口全部关闭** —— ① 第 ⑤ 条「删除 `deck` 字段」（`2b228c0`，N27 收口：字段已删，`game.test.ts` 改为断言 `'deck' in dealt === false`）；② `turnDeadlineAt` 改为**必填**并上移到 `packages/shared/src/ddz/types.ts`（原为 game-service 的**可选** module 增强）；③ `createdAt`/`finishedAt` 改为 `number`（毫秒时间戳，规格逐字）。承载它们的模块增强文件 `packages/game-service/src/game/game.types.ts` **整体删除**（其 `winner`/`botIds`/`botSkillLevels` 三个内部字段一并上移）。
>
> **依据（可机械复核）**：`packages/shared/src/ddz/types.ts:62-67,98-112`（`turnDeadlineAt: number` 必填 / `winner?` / `botIds?` / `botSkillLevels?` / `createdAt: number` / `finishedAt: number | null`）· `game.ts:50-55`（`createSession` 写 `turnDeadlineAt: 0` + `createdAt: Date.now()`）· `game.service.ts:353`（`finishedAt = Date.now()`）· `view.builder.ts:94`（必填后**原样透传**，删掉 `?? 0`）· `ls packages/game-service/src/game/game.types.ts` ⇒ **No such file** · `grep -rn "declare module '@fight-the-landlord/shared'" packages/*/src` = **0 命中**。
> ⚠️ **执行期发现**：`packages/game-service/tsconfig.json` 的 `include` 只有 `src/**` ⇒ **`test/**`从不过`tsc`**，夹具的形状漂移长期不可见（实测 `view.builder.test.ts`的`makeSession()`缺`baseScore`/`turnDeadlineAt`、多一个已删的 `deck`）—— 本片已按本节补齐。

```ts
interface GameSession {
  roomCode: string;
  state: "init" | "bidding" | "playing" | "ended";
  version: number; // 状态版本号，每次状态转移 +1
  baseScore: number; // 底分，开局时由 room-service 从档位表推导、经 game.start 显式写入（无代码缺省）
  players: GamePlayer[]; // 按座位顺序
  bottomCards: Card[]; // 底牌（`{r, s}`，§3.6）**恒有 3 张**；地主确定后保留不清空，供裁剪视图使用
  currentPlayer: number; // 当前操作玩家座位
  lastPlayedHand: {
    cards: Card[];
    type: HandType;
    keyRank: number;
    length: number;
  } | null;
  lastPlayerIdx: number; // 最后出牌者座位，-1 表示尚无
  turnDeadlineAt: number; // 本回合截止时刻（毫秒时间戳 = 本回合开始时刻 + 行动者档位时长：托管 2000 / 连续超时>0 10000 / 正常 30000；机器人座位恒按正常档；**非行动者的**治理态变更不算回合转移、不重算 —— 行动者自身的例外见 §9.3：manual-on 收缩到 min(剩余, 2000)、reconnect-off 按 count 基线重排、manual-off（手动开启的托管）不重排、manual-off（自动托管，count ≥ after）重排到 accel（R8①–④/R6/C4′））
  bidPhase: {
    currentBidder: number;
    landlordCandidate: number; // -1 表示尚无
    bidPasses: number;
    grabActions: number;
    bidMultiplier: number; // 初始 1，每次「抢」×2，**上限 8**（一轮最多 4 次声称 = 3 + 1 次反抢；反抢同样 ×2、任何路径不越过 8 —— ⚠️ 修复轮订正（2026-09-30）：原「第 4 次因上限不再加分」表述有误、结论不变）
    redealCount: number; // 流局次数，上限 3（第 3 次不再重新发牌）
    /** 协议 ⑦：本轮已发生的叫抢决策，按发生顺序（一轮最多 4 条 = 3 次声称 + 1 次反抢）。流局重发时清空；
     *  它**就是**出站 `PlayerView.bidPhase.decisions` 的形状（R157：内部形状 = 契约形状）。 */
    decisions: { seat: number; kind: "call" | "rob"; grab: boolean }[];
    firstCaller: number; // 本轮**第一条**「抢」的座位，-1 表示尚无（片① R2）；**内部字段、永不出站**（反抢权的判据）
    antiRobGranted: boolean; // 反抢权是否已派发（一次性，只置真；收口阈值据此取 3 或 4）；**内部字段、永不出站**
  };
  playPhase: {
    bombCount: number;
    landlordPlays: number;
    farmerPlays: number;
    consecutivePasses: number;
  };
  /** 出牌历史：状态转移序列，用于 DouZero 特征与将来的事件重放 */
  actionLog: {
    version: number;
    seat: number;
    cards: Card[];
    kind: "play" | "pass";
  }[];
  createdAt: number;
  finishedAt: number | null;
}
```

> ⚠️ **`lastPlayedHand` / `lastPlayerIdx` 不再出站**（协议 ④ 起）：出站的是由 `actionLog` 投影出的
> `recentActions`（窗口 2，§4.2 的 `PlayerView`）。它们仍是**规则态**（跟牌目标 / 过牌合法性 /
> 不变式 1、3），**永不下发** —— 别看到 `PlayerView` 上不再有同名段就以为它们被删了。

关键变更（相对当前实现）：

- **新增 `baseScore`** `[已实现]`：底分必须由 game-service 在开局时写入本字段（来源见 §4.2 的 `game.start`），`settleGame()` 读它而**不得硬编码 100**。（依据：`game.service.ts:178` 写入、`settle.ts` 读 `session.baseScore`；C26 / 切片 10）
- **新增 `turnDeadlineAt`** `[已实现]`：本回合截止时刻，每次**回合**转移后重算（**非行动者**的治理态变更不算回合转移，挂机治理片 R8③；行动者自身的 manual-on/reconnect-off/manual-off(auto) 例外见 §9.3）。客户端倒计时与断线重连都依赖它。（依据：回合转移写点 `game.service.ts:295,602,1023,1135`；R8 例外的重排写点 `rescheduleTurn` `:809`；**本体必填**字段 —— `types.ts:62-67`，R472 后不再用 module 增强；挂机治理片起 `deadlineFor()` 按**下一行动者**档位取时长 —— `game.service.ts:746`，治理态变更分支 `applyTrusteeLocked` `:362-418`）
- **新增 `actionLog`** `[已实现]`。这是 §9.5 与将来事件重放的前提：没有它，DouZero 的 `played_cards_*` 与 `card_play_action_seq` 只能靠「总牌堆 − 当前手牌」反推再**硬分配给三家**。（依据：`shared/src/ddz/types.ts:45-50,73`、写入 `play.ts:118-121`；C8 / R205）
  **⚠️ `actionLog` 记录三家全部牌面，属于最高敏感数据：它永不出站**（§6.4 已列明）。
- **删除 `deck` 字段**：发牌后牌堆为空，保留它只会误导。

### 3.3 GamePlayer `[已实现]`

```ts
interface GamePlayer {
  id: string; // 对外 ID：人类为 userId，机器人为 displayId（见 §9.2）
  seat: number; // 0 / 1 / 2
  hand: Card[]; // `{r, s}`（§3.6）
  isLandlord: boolean;
  isOffline: boolean;
  // 注意：isRobot 存在服务端 Room 存储中，【不进入任何下发结构】
}
```

### 3.4 BotInstance `[已实现]`

> `[已实现]`（P8 复审，**片② 同步行号与 `personality` 形状**：七字段逐字：`protocol/src/robot.ts:29-38`；内部 ID 不出站源码闸 `robot-service/test/no-internal-id-outbound.test.ts`（含正负对照））

```ts
interface BotInstance {
  botId: string; // 内部 ID（uuid），永不下发
  displayId: string; // 对外 ID，与人类玩家同构：p_<8位>
  skillLevel: "beginner" | "intermediate" | "advanced";
  personality: { thinkingSpeed: number };
  roomCode: string | null;
  seat: number | null;
  gamesPlayed: number;
}
```

- `[已实现]`（**S5/A6/R136**，`5be7522` 删除 `web/`）：机器人 ID **只有一套** —— 内部 `botId = bot-<uuid8>`（**永不下发**）与对外 `displayId = p_<8位>`（与人类同构），见 `protocol/src/robot.ts:29-32`；源码闸 `packages/robot-service/test/no-internal-id-outbound.test.ts` 钉住「内部 ID 不得出站」。

### 3.5 MatchTicket `[已实现]`

> `[已实现]`（P8 复审：五字段齐：`room-service/src/match/match.service.ts:74-82`；`region` 维度已实现（`matchQueueKey` 三段键）；`enteredAt` 保留有结构性保证 + 测试 `match.service.test.ts:366`）

```ts
interface MatchTicket {
  playerId: string;
  mode: "random" | "practice";
  region: string; // MVP 恒为 'global'，为地理谓词预留
  enteredAt: number; // 入队时刻，重试时【必须保留原值】
  attempts: number; // 本轮尝试次数
}
```

### 3.6 牌值编码

**全系统只有一套编码：DouZero**（`docs/games/doudizhu.md` §1.3）。`2` 在所有层都是 `17`。

一张牌的形状是 **`{ r, s }`**（`r` = DouZero 编码，`s` = 花色 `0`♠ `1`♥ `2`♣ `3`♦ `4`王），
唯一真源是 `packages/protocol/src/views.ts` 的 `Card`。

> ⚠️ **2026-09-20 变更（R695/R696）**：本节此前指向 `codec.ts` 的
> `toInternalRank()` / `toDouZero()` 两个转换函数。**它们已删除** ——
> 没有第二套编码，也就没有映射。C19 那一类缺陷（同点数的 2 互相压过）
> **结构上不再可能**：没有「还原」这一步可以忘。

---

## 4. 服务间通信

### 4.1 通信方式总表

| 方向 | 方式 | 场景 |
|------|------|------|
| 客户端 ↔ **edge**（门口）→ api-gateway | **HTTPS / WSS**（终止于门口）→ **网内明文** HTTP | 全部对外流量（§2.1：对外 = 门口） |
| gateway → user-service | HTTP/REST | 登录、注册、用户信息 |
| gateway → room-service | HTTP/REST | 房间列表、创建 |
| gateway → game-service | HTTP/REST | **对局裁剪视图查询**（`GET /api/games/:roomCode`，仅返回调用者可见的部分，§6.4） |
| gateway → room-service | **socket.io 代理** | 对局实时消息 |
| room-service → game-service | **TCP RPC** | 开局、查询对局 |
| room-service → robot-service | **TCP RPC** | 申请机器人补位 |
| **room-service → user-service** | **TCP RPC** | **对局记录写入**（`record.write`，§4.2/§7.6）—— 记录片重挂 3101 后的**唯一一条边** |
| **user-service → currency-service** | **TCP RPC** | **注册赠送入账**（`currency.apply` —— 货币片的**唯一写边**，§4.2/§4.4；金额为 0 时**完全绕开**，J5 快照语义） |
| **room-service / robot-service / user-service / currency-service / payment-service / api-gateway → config-service** | **TCP RPC** | **读配置快照**（`config.snapshot`，§4.2/§7.5）—— 五十一键（底分档位 / 好友房开关 / 免费与金币场开关 / 免费与金币场机器人补位开关 / 无机器人匹配总等待上限 / 比例 / 周期 / 模型映射 / 保留期 / 注册赠送 / 门槛倍率 / 抽水 / 救助 / 风控〔两谓词开关 · 胜率阈值与最少局数 · 设备阈值与窗口 · 自动限流 · 设备保留期〕/ 支付〔充值提现两开关 · 比率 · 档位表 · 三项限额 · 两周期〕/ 广告〔救助广告位 adpid〕/ 客户端接入〔App/H5 两开关〕/ 记牌器〔总开关 + 两价格〕）的读路径；原 room→user 的 `config.baseScoreLevels` 已随收编退役（user-service 为记录片新增消费方，§7.6；currency-service 为金币场救助与门槛新增消费方；user-service 为风控片新增 `risk.*` 六键消费方；payment-service 为支付片新增 `pay.*` 九键消费方；api-gateway 为客户端接入片新增消费方——两端闸值）；room-service/currency-service 自记牌器收费片起再消费记牌器三键（状态块/购买端点） |
| gateway → config-service | HTTP/REST | `/api/config`（玩家可见子集）· `/api/admin/*` 的 **config-service 分片**（管理面：登录 + 账号 CRUD + 三审计读口〔`config/changes` · `login-events` · `accounts/changes`〕+ 配置读/写；其余管理路由分派见 §7.1/§7.5）—— 经网关反代（§7.1/§7.5） |
| **config-service → Redis** | **Redis pub/sub** | **写后广播失效通知**（频道 `config:changed`，§10.1）—— 消费侧收到即重拉快照（这就是「推送失效」） |
| **game-service → robot-service** | **TCP RPC** | **机器人回合决策（§9.4）** |
| robot-service → douzero | HTTP/REST | `POST /decide_play`（5s 超时，见 §4.3）；`GET /health`（**可用性探测**：1s 超时 / 缓存 5s，失败视为不可用 —— §8.5 的门禁） |
| game-service → room-service | **Redis pub/sub** | 对局状态变更与结束通知（§4.4） |
| **room-service → 客户端** | **socket.io 推送** | **全部 S→C 对局消息（§6.3）** |

**对局消息的推送通路（此前缺失，必须按此实现）**：

```
game-service  ──Redis pub/sub 频道 game:events──▶  room-service  ──socket.io──▶  客户端
   （状态机所有者，      （载荷见 §4.4）              （唯一持有 socket.io 实例、
     不持有任何 socket 连接）                          唯一允许 emit 到 /ws/ddz 的服务）
```

**规定**：

1. **只有 room-service 可以 `emit` 到 `/ws/ddz`**。game-service 不持有任何 socket 连接；
2. game-service 每次状态转移后，把**按座位裁剪**的视图（§6.4）发布到 `game:events`；
3. room-service 订阅该频道，按 `roomCode` 投递到对应的 socket.io room；
4. 客户端 → 服务端的方向走 §7.1 的 socket.io 代理（`ProxyGateway` 已有 `@WebSocketGateway`，并在下游未连通时排队缓冲 —— 见 §6.1.2）。

### 4.2 TCP RPC 契约 `[已实现]`

参考文档只给了方法签名、**未定义任何 pattern 名与 DTO**。本文补齐：

```ts
// room-service → game-service
@MessagePattern('game.start')      startGame(dto: StartGameRequest): GameStartedResponse
/** 内部用：返回完整 GameSession。**仅限服务间调用，绝不可用于对外路由**（§7.1）。 */
@MessagePattern('game.snapshot')   getSnapshot(dto: { roomCode }): GameSession | null
/** 对外用：按**调用者**裁剪。
 *  ⚠️ **seat 由服务端从 userId 解析，不由调用方提供** —— 否则调用方可指定他人座位，
 *  等于绕过裁剪。gateway 的 GET /api/games/:roomCode 必须走这一个。 */
@MessagePattern('game.view')       getView(dto: { roomCode: string; userId: string }): PlayerView | null
/** 挂机治理片：**托管开关**（room → game）。**无 CAS、无版本前置**、不进 `game.action` 联合。
 *  守卫**先于** no-op（非法态照实态报 `13009`/`13005`；机器人座位 ⇒ `10001`）；
 *  目标值 = 现值 ⇒ 完全 no-op（不落盘 / 不 bump / 不推送）；实际变更 ⇒ 轻量转移（save + version+1 + 推送）。
 *  `via` 是判别位——同一个 `{on:false}` 在 manual 与 reconnect 下的 timer 语义不同（玩法 §9.3 的例外语义）。
 *  响应走 R220 信封；ack 载荷 = `{ code, data: { version } }`（快照仍走 `game.state_update` 推送，不在 ack 带全量视图）。 */
@MessagePattern('game.trustee')    trustee(dto: GameTrusteeRequest): RpcResult<{ version: number }>

interface StartGameRequest {
  roomCode: string;
  baseScore: number;
  players: {
    id: string;            // 对外 ID（机器人为 displayId）
    seat: number;
    /** 服务间内部字段：game-service 据此判断机器人回合（§9.4）。永不下发客户端。 */
    isRobot: boolean;
    /** 服务间内部字段：机器人内部 ID，用于调 robot.decide。人类玩家为 undefined。永不下发客户端。 */
    botId?: string;
    /** 服务间内部字段：机器人难度，不暴露给客户端。 */
    skillLevel?: 'beginner' | 'intermediate' | 'advanced';
  }[];
}
interface GameStartedResponse { roomCode: string; state: string; version: number }

/** 挂机治理片：`game.trustee` 入参。仅**三个**合法 `via × on` 组合：
 *  `manual×{on,off}`（客户端按钮）/ `reconnect×off`（重连、在局 `room.join`）/ `abandon×on`（在局 `room.leave`）；
 *  其余组合 ⇒ `10001` 且不落盘。语义（C4′ 起）：
 *  - `manual` 且 `on:false` 且 **`timeoutCount >= after`（已达自动托管阈值）** ⇒ count 清零；
 *    若本人是行动者，本轮 timer **重排到 accel 档**（给回来的玩家一个可操作窗口）；
 *  - `manual` 且 `on:false` 且阈值未到（手动开启的托管）⇒ 只清 trustee、count 不动；本轮 timer **不重排**（防续命）；
 *  - `reconnect` 且 `on:false` 且 trustee 实际 `true→false` 且本人是行动者 ⇒ 只清 trustee、count 保留，
 *    按 `timeoutCount` 基线重排。 */
interface GameTrusteeRequest {
  roomCode: string;
  userId: string;
  on: boolean;
  via: 'manual' | 'reconnect' | 'abandon';
  meta?: RpcMeta;
}

// room-service → robot-service
@MessagePattern('robot.acquire')   acquire(dto: { roomCode: string; seats: number[] }): { bots: BotInstance[] }

// game-service → robot-service
@MessagePattern('robot.decide')    decide(dto: RobotDecideRequest): RobotDecideResponse

interface RobotDecideRequest {
  roomCode: string;
  botId: string;
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  view: PlayerView;          // 【裁剪视图】，绝不含他人手牌（§9.5）
  /** 【公开信息特征】由 game-service 从 actionLog 派生（例外说明见下）。
   *  只含**已经打出过的牌**——那是公开信息，不含任何未出的手牌。
   *  这样机器人才拿得到 DouZero 的 played_cards_* / card_play_action_seq（§9.5）。 */
  features: RobotFeatures;
}
interface RobotFeatures {
  position: 'landlord' | 'landlord_down' | 'landlord_up';
  lastMove: number[];                                     // 上一手牌（公开）
  lastMovePosition: string;
  /** 上一手牌的**规则字段**（跟牌判定用；协议 ④′）。`null` = 尚无上一手牌（首出）。
   *  ⚠️ 协议 ④ 退役 `PlayerView.lastPlayedHand` 之后，机器人失去的规则输入由它补回：
   *  来自 `GameSession.lastPlayedHand` 的投影。**不得**重新解析 `lastMove` 反推（玩法 §5 要点）。 */
  lastMoveMeta: { type: number; keyRank: number; length: number } | null;
  numCardsLeft: Record<string, number>;                   // 三家剩余张数（公开）
  playedCards: { landlord: number[]; landlord_down: number[]; landlord_up: number[] };
  actionSeq: number[][];                                  // 按出牌顺序的全部动作（公开）
}
interface RobotDecideResponse { kind: 'play' | 'pass'; cards?: number[]; source: 'rule' | 'douzero' }

// room-service / robot-service / user-service / currency-service / payment-service / api-gateway → config-service（片⑦ 收编：取代原 room→user 的 config.baseScoreLevels；user 为记录片新增消费方；currency 为金币场救助/门槛新增消费方；payment 为支付片新增消费方；api-gateway 为客户端接入片新增消费方）
/** 读**全部五十一键**的配置快照（§7.5）。失败语义**分层**（§4.3 表）：热项用缓存或代码默认值；
 *  **底分档位保持 fail-closed**（缓存为空且拿不到 ⇒ `10007`、建房/入队失败）——
 *  **绝不**把「读不到」当成「没有档位」（那会让非法 `baseScore` 绕过校验）。 */
@MessagePattern('config.snapshot')  getSnapshot(dto: ConfigSnapshotRequest): ConfigSnapshotResponse

interface ConfigSnapshotRequest { meta?: RpcMeta }
interface ConfigSnapshotResponse {
  /** 全部五十一键：`key → { value, version }`（version = 每键单调计数器，§7.5）。 */
  config: Record<string, { value: unknown; version: number }>;
  version: number;                     // MAX(每键)
}

// user-service（本片：注册赠送 `signup:<userId>`；② 对局结算 `settle:<gameId>` 续接）→ currency-service
// （货币片 P2-①：`currency.apply` 唯一写边 + `currency.get` 读）。请求/响应类型定义在
// packages/protocol/src/currency.ts（本块不重复）；信封 / `meta` / 超时纪律照 record.write（§4.3）。
@MessagePattern('currency.apply')   apply(dto: CurrencyApplyRequest): CurrencyApplyResponse
@MessagePattern('currency.get')     get(dto: CurrencyGetRequest): CurrencyGetResponse
// 记牌器收费片（2026-10-18）：room-service → currency-service 的**开局权益消费**（写边、按 room+owner 幂等；
// 包时优先 → 单局卡 −1 → none）。类型 = `CurrencyCardCounterConsumeRequest/Response`（`./currency.ts`）；
// 超时 3s；仅 10007/传输失败重试 ≤1（同 room+owner 幂等 ⇒ 重试安全）。
@MessagePattern('currency.cardCounterConsume')  cardCounterConsume(dto: CurrencyCardCounterConsumeRequest): CurrencyCardCounterConsumeResponse

// payment-service（支付片）→ currency-service：cap（可离场额度）**只读** RPC——分池唯一实现点（§7.7）。
// 消费纪律（硬）：提现/退款链**资金动作时刻（锁内）**调用——禁缓存、禁只查一次；失败 ⇒ fail-closed 拒申请。
// 超时 3s（⚙️2）同值先例；请求/响应类型 = `CurrencyWithdrawableGetRequest/Response`（`./currency.ts`）。
@MessagePattern('currency.withdrawable.get')  withdrawable(dto: CurrencyWithdrawableGetRequest): CurrencyWithdrawableGetResponse

// payment-service → config-service（**支付配置管理化片**，2026-10-06）：渠道凭据**专用拉取通道**（§7.5「渠道凭据第二键空间」）。
// 载荷携专用令牌 `PAY_CHANNEL_PULL_TOKEN`（常数时间比对；未设 ⇒ 拒一切拉取）；**每渠道调用现拉**；
// 失败**不抛**（`RpcResult` 信封——R220：Nest `RpcException` 会丢 5 位码）⇒ 走回落/未配置语义（§4.3 新边）。
// 与 `config.snapshot` **结构性隔离**：渠道六键住独立表，不可能被广播快照带出。类型 = `ConfigPayChannelGetRequest/Response`（`./pay-channel.ts` 定义，本块不重复）。
@MessagePattern('config.payChannel.get')  payChannelGet(dto: ConfigPayChannelGetRequest): RpcResult<ConfigPayChannelGetResponse>

// alert-relay / am-renderer → config-service（**通知通道管理化片**，2026-10-07）：通知九键**专用拉取通道**（§7.5「通知通道键空间」）。
// 载荷携专用令牌 `NOTIFY_CHANNEL_PULL_TOKEN`（常数时间比对；未设 ⇒ 拒一切拉取）；消费端 **30s 轮询**（常量钉死、不做 env 旋钮）+ 启动先拉一次；
// 失败**不抛**（`RpcResult` 信封——R220）⇒「这次拉不到」⇒ 保持 last-good（relay = 内存 + `/data` 持久化图；renderer = 共享卷 yml 即 last-good，§4.3 新边）。
// 与 `config.snapshot` **结构性隔离**：通知九键住独立表，不可能被广播快照带出。类型 = `ConfigNotifyChannelGetRequest/Response`（`./notify-channel.ts` 定义，本块不重复）。
@MessagePattern('config.notifyChannel.get')  notifyChannelGet(dto: ConfigNotifyChannelGetRequest): RpcResult<ConfigNotifyChannelGetResponse>
```

**`PlayerView` 定义（裁剪视图的唯一类型来源，§6.4 与本契约共用）**：

```ts
interface PlayerView {
  roomCode: string;
  version: number; // 状态版本号
  state: "init" | "bidding" | "playing" | "ended";
  baseScore: number; // 本局底分（协议⑥）
  seat: number; // 接收者自己的座位
  hand: Card[]; // 【仅自己的手牌】`{r, s}`（§3.6）；他人的牌面永不下发
  cardCounts: [number, number, number]; // 三家手牌张数，按座位索引（他人的牌面永不下发）
  /** 按座位的托管态（挂机治理片；与 `cardCounts` 同族的三元组）。托管中座位的回合按短延时计时（玩法 §9.3）。
   *  **公开信息**：三家皆可见（对手的「托管中」徽标据此渲染）。 */
  trustees: [boolean, boolean, boolean];
  bottomCards: Card[] | null; // 叫抢阶段恒为 null；state === 'playing' 后三家皆可见
  /** 地主座位；未确定时为 null。**这是「谁是地主」的唯一来源**（玩法 §3.4 第 3 条：
   *  随机指定地主的路径也必须写入 landlordCandidate）。 */
  landlordSeat: number | null;
  currentPlayer: number;
  /** 桌面历史牌（协议 ④）：窗口 2、旧 → 新、「不出」占一手（`cards: null` 是**显式事实**）。
   *  ⚠️ 它**取代**了旧的 `lastPlayedHand` + `lastPlayerIdx`（**替换，不并存**）；**只用于展示** ——
   *  规则态（跟牌目标 `type`/`keyRank`/`length`）仍留在服务端 `GameSession.lastPlayedHand`（§3.2），永不出站。 */
  recentActions: { seat: number; cards: Card[] | null }[];
  turnDeadlineAt: number;
  bidPhase: {
    currentBidder: number; // 叫抢阶段【行动者】在这里，不在 currentPlayer（§9.4）
    bidMultiplier: number;
    landlordCandidate: number; // -1 表示尚无
    grabActions: number; // 本轮已完成的决策次数（0..4），用于进度展示
    redealCount: number;
    kind: "call" | "rob"; // 协议③：本行动者该用哪套措辞（依据是「本轮是否已有人声称」，不是 grabActions）
    decisions: { seat: number; kind: "call" | "rob"; grab: boolean }[]; // 协议⑦：本轮已发生的决策（按发生顺序，最多 4 条 = 3 次声称 + 1 次反抢）
  };
  playPhase: { bombCount: number };
  winner?: "landlord" | "farmer";
}
```

**永不出站字段**（任何 S→C 消息、任何 REST 响应、任何日志中都不得出现）：

`actionLog`（含三家全部牌面）、`players[].hand`（仅自己的 `hand` 可出站）、`isRobot`、`botId`、`skillLevel`。

**例外说明（重要，避免把机制设计死）**：`actionLog` **本身**永不出站，但由它派生的**公开信息**——即「已经打出过的牌」——**可以**出站，因为那本就是所有玩家都看得见的信息。该路径现已有**两个**实例：`RobotFeatures`（本节上面的 `RobotDecideRequest.features`）与 `PlayerView.recentActions`（协议 ④，窗口 2）；将来的观战/复盘同样走这条路径。**未打出的手牌一律不可派生。**

**RPC 监听方配置**：`game-service`、`robot-service`、**`config-service`** 与 **`user-service`**（记录片 T4 重挂）必须启动 TCP 微服务监听（`app.connectMicroservice({ transport: Transport.TCP, options: { port: RPC_PORT } })`），端口取 §2.3 的 `RPC_PORT`。

> `[已实现]`（独立小片 **P4 / N20** 收口）：`game-service` / `robot-service` 的 `main.ts` 均已
> `connectMicroservice({ transport: Transport.TCP, options: { host: '0.0.0.0', port: RPC_PORT } })`
>
> - `startAllMicroservices()`（3103 / 3105）；七个 pattern 取自 `packages/protocol/src/rpc.ts` 的
>   `RPC_PATTERNS`（逐字常量化）；**全部**调用点走 `ClientProxy`，超时/重试逐字照 §4.3；
>   内部 HTTP 路由已整条删除，`docker-compose.yml` 只 `expose` 3103/3105（宿主映射仅在
>   `docker-compose.override.yml` 的开发形态）—— 与 §2.1「内部 RPC 端口……不对外暴露」一致。
>
> `[已实现]`（**片规格 §2.1 / §2.3**，2026-09-27）：同一形态**第三次**落地 ——
> `user-service` 加 TCP 监听（**3101**，`RPC_PORT` 缺省值）与第八个 pattern
> `config.baseScoreLevels`（room → user，读底分档位表）；
> `docker-compose.yml` 的 user-service 也 `expose` 3101（**不** `ports`）。
>
> `[已实现]`（**片②**，2026-10-01）：**第九个** pattern `robot.availability`（room → robot，可用性门禁，§8.5；
> 超时 / 不重试 / fail-open 见 §4.3 表）落地 —— `RPC_PATTERNS` 现在是**九个**。
>
> `[已实现]`（**片⑦ 配置中心**，2026-10-02）：**上上条的第三次形态已换方退役** —— `user-service` 的 TCP 监听
> （**3101**）与第八个 pattern `config.baseScoreLevels` 随底分档位收编**一并退出**（compose 的 3101 `expose` 同删）；
> TCP 监听方第三处改为 **`config-service`（3106）**，pattern 名单**换一条**为 `config.snapshot`（room/robot → config，
> 读全量快照，§7.5）⇒ `RPC_PATTERNS` **总数仍九个**（逐字常量化在 `packages/protocol/src/rpc.ts`，`messages.test.ts` 钉住名单）。
>
> `[已实现]`（**记录片 T4**，2026-10-03）：**上条的退役已订正** —— 片⑦ 退役的是「room→user 读**底分档位表**」
> 那**一条边**（随收编进 `config.snapshot`），**不是端口**；`user-service` 以**新边** `record.write`
> （room → user，写对局记录，§7.6）**重挂 TCP 3101**，**不设**应用层 token（**R223**：TCP 面不做应用层鉴权，
> 安全边界 = compose `expose` 内网，宿主映射仅 override）；`main.ts` 顺序 = `connectMicroservice → startAllMicroservices
→ listen`（删前形态 `0da4448^` 为范本）。pattern 名单 **+1**（`record.write`）⇒ `RPC_PATTERNS` **总数十个**
> （`messages.test.ts` 同提交钉住）。来源：`docs/superpowers/specs/2026-10-03-records-spec.md` §2.2 ·
> `…-records-design.md` D2。
>
> `[已实现]`（**货币核心片 P2-①**，2026-10-03）：pattern 名单 **+2**（`currency.apply` —— **唯一写边**、
> `currency.get` —— 读；§4.2 签名表已补两条）⇒ `RPC_PATTERNS` **总数十二个**（`messages.test.ts` 同提交
> 钉住 10→12）。接收侧 = 新服务 **`currency-service`**（TCP **3104**，§2.3 `RPC_PORT` 行已登记；
> J21 两半同提交：「键 + `@MessagePattern` 接收侧 + `rpc.module.ts` 注册」）。来源：
> `docs/superpowers/specs/2026-10-03-currency-spec.md` §2.2/§2.4 · `…-currency-design.md` §4.3。
>
> `[已实现]`（**支付片**，2026-10-06）：pattern 名单 **+1**（`currency.withdrawable.get` ——
> payment → currency 的 **cap 只读**边；§4.2 签名表已补该行）⇒ `RPC_PATTERNS` **总数十五个**
> （`messages.test.ts` 同提交钉住 14→15；⚠️ 13/14 = 金币场 `record.moneyDelta` 与风控
> `risk.deviceReport` —— 两片收口当时**未续本注记链**，既有文档债随本行如实登记，逐字条数以
> `messages.test.ts` 判据为准）。接收侧 = `currency-service`（J21 两半同提交）。来源：
> `docs/superpowers/specs/2026-10-05-payment-spec.md` §2.2/§2.2.1 · `…-payment-design.md` §5.1。
>
> `[已实现]`（**支付配置管理化片**，2026-10-06）：pattern 名单 **+1**（`config.payChannel.get` ——
> payment → config 的**渠道凭据专用拉取边**；§4.2 签名表已补该行）⇒ `RPC_PATTERNS` **总数十六个**
> （`messages.test.ts` 同提交钉住 15→16）。接收侧 = **config-service**（`config.rpc.controller.ts`
> 第二 `@MessagePattern`；⚠️ J21 已知窗口：T1 加键、T6 落接收侧，期间承载闸恰 2 例红 —— 台账 N75）。
> 来源：`docs/superpowers/specs/2026-10-06-pay-channel-admin-spec.md` §2.5 ·
> `…-pay-channel-admin-design.md` D3。
>
> `[已实现]`（**挂机治理片**，2026-10-17）：pattern 名单 **+1**（`game.trustee` —— room → game 的**托管开关**边；
> §4.2 签名表已补该行）⇒ `RPC_PATTERNS` **总数二十个**（`messages.test.ts` 同提交钉住 19→20）。接收侧 =
> **game-service**（`GameRpcController` 的第五个 `@MessagePattern`；J21 三同提交：键 + 接收侧 + 模块注册）。
> ⚠️ **计数债订正（本片实测）**：上一条链停在「十六个」，而 `config.notifyChannel.get`（通知通道管理化片 2026-10-07）、
> `config.adChannel.get`（广告片 2026-10-12）与 `currency.entryFeeSkip`（台费片 2026-10-14）**三条边**收口时
> **未续本注记链**（同 `record.moneyDelta` / `risk.deviceReport` 的既有债）——**本片前实测 = 19**、本片后 = **20**；逐字条数以 `packages/protocol/src/rpc.ts`
> 与 `messages.test.ts` 的判据为准。来源：`docs/superpowers/specs/2026-10-17-idle-trustee-spec.md` §0/§1 C19 ·
> `…-idle-trustee-design.md` §三。
> `[已实现]`（**昵称片**，2026-10-17）：pattern 名单 **+1**（`user.nicknames.get` —— room → user 的**批量昵称读边**，
> TCP 3101 只读；§4.2 签名表另行补齐）。上一条链（挂机治理片）收口时本边尚未合并，**本注记续链** ⇒ `RPC_PATTERNS`
> **总数二十一个**（`messages.test.ts` 同提交钉住 20→21）。接收侧 = **user-service**
> （`user-nicknames.rpc.controller.ts`）。来源：`packages/protocol/src/rpc.ts` 的 `userNicknamesGet` 注记 · 昵称片规格/计划。
> `[已实现]`（**记牌器收费片**，2026-10-18）：pattern 名单 **+1**（`currency.cardCounterConsume` —— room → currency 的
> **开局权益消费**边；TCP 3104 写边、按 room+owner 幂等）⇒ `RPC_PATTERNS` **总数二十二个**（`messages.test.ts`
> 同提交钉住 21→22）。接收侧 = **currency-service**（`CurrencyRpcController` 的第四个 `@MessagePattern`；
> J21 三同提交：键 + 接收侧 + `rpc.module.ts` 注册）。来源：`packages/protocol/src/rpc.ts` 的
> `currencyCardCounterConsume` 注记 · `docs/superpowers/specs/2026-10-18-card-counter-charge-gate-spec.md` §2.4e。

### 4.3 超时、重试与降级

| 调用（方向）                                                                           | 超时                                          | 重试                                | 失败降级                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game.start`（room → game）                                                            | 3s                                            | 1 次                                | 房间置 `cancelled`，通知玩家                                                                                                                                                                                                                                                                                                                                                                        |
| `game.snapshot`（room → game）                                                         | 2s                                            | 1 次                                | 返回 `10007`                                                                                                                                                                                                                                                                                                                                                                                        |
| `game.trustee`（room → game，挂机治理片）                                              | **2s**（`GAME_CLIENT_TIMEOUT_MS.trustee`）    | **不重试**                          | **fail-open**：转发失败只记 warn，**不阻断**客户端动作流（对局推进不依赖本边）；重连/回桌的 trustee-off 清除失败时 ack 快照可能带旧态（已登记的接受格——恢复后下一次转移纠正）                                                                                                                                                                                                                       |
| `currency.cardCounterConsume`（room → currency，记牌器收费片）                         | **3s**（`CURRENCY_CLIENT_TIMEOUT_MS`）        | **≤1 次**（仅 10007/传输失败）      | **fail-open**：未知态 ⇒ 本局仍开通（`active=true/source=unknown`）+ `card_counter_consume_error_total`；同 room+owner 幂等 ⇒ 重试安全；不阻断开局                                                                                                                                                                                                                                                   |
| `robot.acquire`（room → robot）                                                        | 3s                                            | 1 次                                | 以较少人数开局（不补机器人）                                                                                                                                                                                                                                                                                                                                                                        |
| `robot.availability`（room → robot）                                                   | **2s**                                        | **不重试**                          | **当作「能给」**（fail-open）—— 只有明确的 `canProvide:false` 才触发 §8.5 的「不能给」路径。⚠️ 2s 必须 **>** 探测用的 1s（否则探测真超时那一刻调用方也放弃 ⇒ fail-open 恒先触发）                                                                                                                                                                                                                   |
| `robot.decide`（game → robot）                                                         | **5s**                                        | **不重试**                          | **回退规则引擎**（§9.3）                                                                                                                                                                                                                                                                                                                                                                            |
| `config.snapshot`（**room / robot → config**）                                         | **3s**                                        | 不重试                              | **分层降级**（§7.5）：热项用缓存（哪怕旧值）或**代码默认值**；**底分档位保持 fail-closed** —— 缓存为空且拉不到 ⇒ 建房/入队 `10007`，**绝不**静默放行                                                                                                                                                                                                                                                |
| `config.payChannel.get`（**payment → config**，支付配置管理化片）                      | **1000ms**（`PAY_CHANNEL_CLIENT_TIMEOUT_MS`） | **不重试**                          | **整图回落 / 未配置语义**（§7.5「渠道凭据第二键空间」）：拉取失败 ⇒ 用进程内**上次成功值** + 每次一条 WARN（文案不含值）；**从未成功** ⇒ 视同「未配置」⇒ 逐键回 §7.7 的逐键等价语义（多数 ⇒ `15001`）。⚠️ 成功 = **整图替换**缓存（缺席键即「未配置」——防 merge 让清空在进程存活期内不生效）                                                                                                        |
| `config.notifyChannel.get`（**alert-relay / am-renderer → config**，通知通道管理化片） | **3000ms**（消费端常量钉死；⚙️8）             | **不重试**（下一轮 30s 天然即重试） | **last-good 保持**（§7.5「通知通道键空间」）：relay = 上次成功拉取的**裁剪图**（内存 + `/data/notify-config.json` 持久化，重启不丢）；renderer = 共享卷 yml 不动即 last-good；**从未成功拉到**（relay `lastGood===null`）⇒ `/webhook` **500**（未知 ≠ 成功；回 200 会被 AM 记成投递成功 ⇒ 静默丢告警）；`{}` 成功空图 ⇒ 200 no-op（= 今天「明确未配」）。生效时效：保存 ⇒ ≤30s（轮询）+ reload 往返 |
| `record.write`（**room → user**，记录片）                                              | **3s**                                        | **不重试**                          | **丢该局记录**（error 级日志，**已接受窗口** —— 与 pub/sub at-most-once 同族，台账 N49）；**绝不阻断结算广播**（写入与广播解耦，§7.6）                                                                                                                                                                                                                                                              |
| `currency.apply`（**user → currency**，货币片 T6）                                     | **3s**                                        | **不重试**                          | 传输失败 ⇒ 固定文案 + `10007`；**任何失败（业务码/传输）⇒ 注册整体失败**：HTTP **503 + 10007 信封**、本地零行、重试干净（规格 §2.7/⚙️8；注册链路 = 先货币后落库，§4.4）                                                                                                                                                                                                                             |
| `POST /decide_play`（**robot → douzero**）                                             | **5s**                                        | 不重试                              | 请求带 `model`（`skillLevel` 逐档映射：`sl`/`douzero_WP`/`douzero_ADP`，§9.3）；失败 ⇒ 回退规则引擎（§9.3）                                                                                                                                                                                                                                                                                         |

> 🔴 **规则引擎开关的约束面（片② 引入；片⑦ 起由配置键 `robot.ruleFallback` 承载**，§7.5，默认 `true`）**：只约束**补位**这一环（§8.5）—— OFF 且 DouZero 不可用 ⇒ 匹配不补机器人（第 30s 判 `12007`）；**决策侧恒回退规则引擎**（`robot.decide` / `decide_play` 两行**不受开关影响\*\*；已入座对局照旧兜底）。

> ⚠️ **`game.start` 的「失败降级」在本仓**未实现**（N36 / R522，2026-09-17 用户裁决）**：
> `room-service/src/match/match.service.ts` 的 `startGame()` 的 `catch` **只记 `logger.error` 不重抛**
> ⇒ 两次都失败时 `playing` **照样**被写入（房间进 `playing` 而服务端**没有对应会话**），
> **不会**置 `cancelled`、也**不会**通知玩家。上表该行的「失败降级」列因此**只描述规格意图**。
>
> **裁决为「本仓不实现」而不是「待修」**：落地它必须让 `startGame()` **返回成败**（改内部签名与语义），
> 而当前用一条**诚实**的用例把现状**钉住** —— `packages/room-service/test/match.service.test.ts` 的
> `N36: game.start 两次都失败 ⇒ playing 照样被写入、且从不置 cancelled`（断言**两半**：
> 进了 `playing` **且**从未 `cancelled`；只写后者是空测）。台账见 `deviation-ledger.md` §1.5 的 **N36**。
> ⚠️ 上表**其它各行**的降级都有实现与判据（`game.snapshot` → `10007`；`robot.acquire` → 减员开局；
> `record.write` → 丢该局 + error 日志（台账 N49，§7.6）；`robot.decide`/`decide_play` → 回退规则引擎；
> `robot.availability` → 当作「能给」（fail-open，§8.5）；
> `config.snapshot` → **底分档位那一半**仍是「建房失败 + `10007`」（热项那一半 = 缓存 / 代码默认值），
> 判据 `packages/room-service/test/rooms.base-score.test.ts`）—— **本注只覆盖 `game.start` 一行**。

**幂等前提**：所有 RPC 均为**幂等**设计（同一 `roomCode` 重复调用不产生副作用）。非幂等操作（将来的扣费类）必须带 `actionId`，见 `docs/appendix/platform-roadmap.md` §3。

### 4.4 异步事件

MVP 只使用一个 Redis pub/sub 频道，**它是对局 S→C 推送的唯一通路**（§4.1）：

| 频道          | 发布者       | 订阅者       | 事件载荷                                                                                                                                                                                                                         |
| ------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game:events` | game-service | room-service | `{ event: 'game.started', roomCode, version, seatViews: PlayerView[] }`                                                                                                                                                          |
| `game:events` | game-service | room-service | `{ event: 'game.state_updated', roomCode, version, seatViews: PlayerView[] }`                                                                                                                                                    |
| `game:events` | game-service | room-service | `{ event: 'game.ended', roomCode, version, result: SettlementResult }`（**记录片**：可附 `record` 信封 = 发牌快照 `{startedAt, seats[{seat, playerId, hand}], bottomCards}`，§7.6；旧会话窗口 / `notifyRoomEnded` 路径**不附**） |

- **`version` 是信封的必填字段**（同一次状态转移内的所有消息共享同一 `version`）。room-service 与客户端的新旧判定都依赖它（§6.2、M08）。
- `seatViews` 是**按座位预先裁剪好的视图数组**（§6.4），room-service 只需按 `seat → socket` 投递，**不做任何业务判断**；
- room-service 的翻译规则（**这是开局推送的唯一生产者，不可省略**）：

| 收到的事件           | room-service 发出的 S→C 消息              |
| -------------------- | ----------------------------------------- |
| `game.started`       | `game.deal` + `game.current_turn`         |
| `game.state_updated` | `game.state_update` + `game.current_turn` |
| `game.ended`         | `game.finished` + `game.settlement`       |

- **MVP 不使用 RabbitMQ、不引入 Redis Stream**（参考文档 §2.2 的 RabbitMQ 与 §7.5 的事件溯源整体移入演进附录）。
- pub/sub 无持久化：room-service 离线期间的事件丢失。MVP 接受，因为对局状态以 Redis 中的 `GameSession` 为准（§10.1），重连一律回全量裁剪快照（§6.6）。

---

## 5. 身份与安全

### 5.1 认证 `[已实现]`

> `[已实现]`（P8 复审：四端点（`users.controller.ts:16,25,36,52`）、2h/7d（`auth/token.service.ts`）、refresh 轮换（`:108` 原子 `DEL`）、双 jti 白名单（`:58-59`）、登出双删（`auth.service.ts:54-59`）；`expiresIn: '7d'` 已显式移除（`auth.module.ts:12-16`））

- **认证走 REST**：`POST /api/auth/register`、`POST /api/auth/login`、**`POST /api/auth/refresh`**、**`POST /api/auth/logout`**。**WebSocket 不承载登录**。
  （参考文档同时定义了 REST `/api/user/login` 与 WS `login` 两条路径，本文取 REST，理由是 WS 握手时已有 token 可用。）
- 令牌：**access token 有效期 2 小时**，**refresh token 有效期 7 天**。
  - `POST /api/auth/refresh` 入参 `{ refreshToken }`，出参 `{ accessToken, refreshToken }`（**轮换**：旧 refresh token 立即失效）；
  - refresh token 与 access token **一样写入 `session:{jti}` 白名单**，因此可被吊销；
  - 登出删除两个 jti。
- 签名：HS256，密钥来自 `JWT_SECRET`。
- 载荷：`{ sub: userId, phone, jti, exp, iat }`。
- **吊销**：Redis `session:{jti}` 白名单，TTL = token 剩余有效期；登出即删除。
  **依赖**：这一条要求 user-service 连接 Redis（§2.1 已登记）。

### 5.2 身份透传（新增契约）

**这是当前最严重的安全缺口，必须按本节实现。**

1. **api-gateway 是唯一验签点**。验签通过后，网关注入内部头：
   ```
   X-User-Id: <userId>
   X-Trace-Id: <traceId>
   ```
2. **下游服务一律从 `X-User-Id` 取身份，禁止读取请求体或查询参数中的 `userId` / `playerId` 作为身份来源。**
3. **服务间调用必须携带内部密钥**（`INTERNAL_SERVICE_TOKEN`），网关拒绝任何携带该头的外部请求；下游校验该头以区分「用户请求」与「服务间调用」。
4. **WebSocket 路径的身份载体**：客户端连到 gateway 并在 socket.io `auth` 中携带 access token；gateway 验签后，**为每个客户端建立一条到 room-service 的下游 socket.io 连接，并在该下游连接的 `auth` 中携带**：

   ```ts
   // gateway → room-service 的下游握手
   auth: { userId: '<userId>', internalToken: process.env.INTERNAL_SERVICE_TOKEN }
   ```

   room-service 校验 `internalToken` 后，把 `userId` 写入 `socket.data.userId`。**room-service 绝不从消息载荷中取身份。**

   `[说明]` `handleInternalConnect(socket, userId)` 是**测试专用的兼容入口**（生产路径 0 次调用，测试调用 **1** 次）—— 生产身份走的是握手 `auth`，由 `ws.gateway.ts` 的 `handleConnection` 写入 `socket.data.userId`（且入口 fail-closed：`internalToken` 不匹配或缺 `userId` 一律 `disconnect`）。⇒ 本方法**不得**被当作身份来源。

### 5.3 权限与越权防护 `[已实现]`

> ✅ **P12 收口（R471）：第 ⑦ 条已落地** —— `routeClientMessage` 在身份解析之后、handler 派发之前做一致性校验：`playerId` **不传则放行**、与 `socket.data.userId` 不符 ⇒ ack `12003`（`message.router.ts:112-116`）。①-⑥ 原本全绿。
>
> **依据（可机械复核）**：`packages/room-service/src/gateway/message.router.ts:113-114`（`claimed !== undefined && claimed !== userId` ⇒ `fail(ErrCode.NOT_YOUR_TURN)`）· 判据 3 条（`packages/room-service/test/message.router.test.ts`：不符 ⇒ **12003 且不得转发下游** / 相符 ⇒ 放行 / 不传 ⇒ 放行）· **修前 RED 原文** `expected +0 to be 12003`（旧实现静默忽略）· room-service 单测 204 → **207**。
> ⚠️ **触发面比计划估的宽**：两个既有用例原先靠「传不符的 `playerId`」表达「载荷身份不被采信」，本片把载体换成仍被完全忽略的 `userId`（`message.router.test.ts` 的身份用例、`ws.gateway.test.ts` 的 §5.2 用例），**断言语义逐字保留**。

- 所有动作类请求必须校验「操作者 == 该动作的合法主体」：
  - 出牌/过牌：`调用者座位 === session.currentPlayer` → 否则 `12003`
  - 叫抢：`调用者座位 === session.bidPhase.currentBidder` → 否则 `12003`
    （**叫抢阶段的行动者是 `bidPhase.currentBidder`，不是 `currentPlayer`**，见玩法 §9.1）
  - 房间操作：调用者必须是房间成员 → 否则 `12004`
- 越权返回 `12003`（不在你的回合）或 `12004`（你不在该房间中）。

**身份映射（必须按本节实现，否则 P0 的安全契约不唯一）**

`X-User-Id` 是**入口身份**，`GamePlayer.id` 是**对局内身份**，两者的对应关系是：

| 规则                     | 内容                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| 人类的 `GamePlayer.id`   | **等于其 `userId`**                                                             |
| 机器人的 `GamePlayer.id` | 等于其 `displayId`（`p_<8位>`，§9.2），**机器人没有 `userId`**                  |
| 定位方式                 | 在 `GameSession.players` 中查找 `id === X-User-Id` 的项，其 `seat` 即调用者座位 |
| 找不到                   | 说明该用户不在此局 → `12004`                                                    |
| 机器人                   | **不可能通过身份透传产生任何动作**；机器人动作只能由 §9.4 的服务端驱动路径产生  |

服务端**禁止**从请求体或查询参数读取 `playerId` 作为身份。若客户端仍传了 `playerId`，只能作为**一致性校验**：与身份不符时拒绝（`12003`）。

### 5.4 限流（新增契约）`[已实现]`

> `[已实现]`（P8 复审：四维度全落地；**P11 追加第五维**（N13/R453）：`api-gateway/src/http/rate-limit.ts` 的
> `HTTP_IP_RATE_LIMIT` + `isIpRateLimited`，接线在 `http-rate-limit.middleware.ts` 的**未认证早退之前**
> ⇒ 覆盖登录/注册/刷新。conformance `slice-07.2-hardening` 第 7/8 步）

参考文档只给了维度、没有阈值；且其唯一的具体数值（风控 `setLimit(userId, 3, 1000)`，即 3 次/秒）**因 `getRiskLevel()` 永不返回 `throttle` 而不可达**（⚠️ 此判断只对**参考文档**成立：本仓已由风控片的**风险限流档**使该数值**可达** —— `risk:limit` 旗在 ⇒ HTTP 用户维与 WS 用户维换档 **3 次/秒**、旗无 ⇒ 原档不变，旗为检测位读 fail-open；见风控片规格 §2.6）。本文取参考文档 §10.7 的 `checkFastAction` 作为基线：

| 维度                            | 阈值               | 超限响应                      |
| ------------------------------- | ------------------ | ----------------------------- |
| 单 IP 并发 WebSocket 连接       | **5**              | 拒绝握手                      |
| 单用户 HTTP 请求                | **20 次 / 5 秒**   | `10006`（HTTP 429）           |
| **单 IP HTTP 请求**（N13/R453） | **120 次 / 60 秒** | `10006`（HTTP 429）           |
| 单连接 WS 业务消息              | **20 条 / 5 秒**   | `10006`（WS ack 的 `code`）   |
| 单用户同时入队匹配              | 1                  | **`12009`**（已在匹配队列中） |

> **为什么单 IP 的阈值（120/60s）比单用户（20/5s）宽得多**（R453）：这一维的目标是**挡住暴力破解的规模**，
> 不是防单个用户的误用。它覆盖**未认证**请求（登录/注册/刷新 —— 那正是 N13 登记的缺口），
> 因此阈值必须容得下 conformance 的造数步骤（`slice-07.1` 一次连发 20 个注册，占 1/6 额度）。
> ⚠️ **这个数字是规格值**：实现里不得另起一套（`HTTP_IP_RATE_LIMIT` 是唯一出处）。

- 计数存 **Redis ZSET**，键 `ratelimit:{dimension}:{key}`，member = 请求时刻（毫秒），score = 同一时刻；每次判定 `ZREMRANGEBYSCORE` 清理窗口外成员后 `ZCARD`。窗口长度即 key 的 TTL。
  （**不能用 String**：String 无法承载滑动窗口的请求时刻序列。）
- **WS 连接计数的增减时机**：客户端握手成功时 `ZADD`，`disconnect` 事件中 `ZREM`；并对每个 IP 的连接 key 设 TTL 兜底，防止进程崩溃导致计数泄漏。
- WS 消息计数在 **room-service** 的 socket 消息处理入口做（gateway 只做协议转发，不解业务消息）。
- **依赖**：api-gateway 必须连接 Redis（§2.1 已登记）。

### 5.5 脱敏 `[已实现]`

日志中必须脱敏：

| 字段                     | 处理                       |
| ------------------------ | -------------------------- |
| 手机号                   | `138****1234`              |
| 密码 / passwordHash      | **不记录**                 |
| JWT 全文                 | **不记录**（可记录 `jti`） |
| `X-User-Id` 之外的内部头 | 不记录                     |

参考文档写作「使用 **Logback** 自定义转换器实现」——**Logback 是 Java 生态组件，本项目为 TypeScript/NestJS**，该句为笔误，实现应使用 Nest 的日志拦截器。

---

## 6. WebSocket 协议

### 6.1 传输层

- **socket.io 4.x**，namespace `/ws/ddz`，path `/socket.io/`
- 握手鉴权：客户端在 `auth: { token }` 携带 access token；网关验签失败以 `connect_error` 拒绝
- 心跳：**只使用 socket.io 内置机制**：`pingInterval: 30000`、`pingTimeout: 90000`
  - **不使用任何应用层 `ping` / `pong` 消息**
  - `[已实现]`（**S7/R142**）：`pingInterval: 30000` / `pingTimeout: 90000`（`room-service/src/gateway/ws.gateway.ts:110-111`、网关侧同值 `proxy.gateway.ts:86-87`），**应用层 `ping`/`pong` 已删除**（`protocol/src/messages.ts` 的 `CLIENT_MESSAGE_TYPES` **十一条**里没有 `'ping'`；挂机治理片 `+1 = game.trustee`）。
- `[已实现]`：`WsGateway` 现有 **11** 个 `@SubscribeMessage('…')` 处理器（挂机治理片 `+1 = game.trustee`；与 `CLIENT_MESSAGE_TYPES` 逐条对齐），且用 `@WebSocketServer()` 注入 server（`ws.gateway.ts:117-118`）—— 早先那个 `new Server()` 独立实例已不存在（`grep -rn "new Server(" packages/*/src` 只剩注释）。

#### 6.1.1 ack 如何穿过网关代理（**必须两端一致，实测踩坑**）

§7.1 规定「gateway 反向代理到 room-service，每客户端一条下游连接」。但**ack 不是普通事件，它穿不过转发**：

- Nest 的 `@SubscribeMessage` 处理函数**返回值**会走 socket.io 的 **ack 包**发给直连方；
- 在代理拓扑下，这个 ack 包被**网关侧的 `socket.io-client` 消费掉**，网关收不到任何可转发的事件；
- 结果是「客户端永远等不到 ack」，而服务端日志显示处理成功 —— 极难定位。

**规定的做法（网关内部约定，不改变对外契约）**：

1. 网关为每条转发的请求生成 `__ackId`（UUID），随请求体注入；
2. room-service 处理完后，**以该 `__ackId` 作为事件名**把响应回发；
3. 网关按 correlation id 取回原回调并交还客户端。

`__ackId` 属于**网关与 room-service 之间的内部字段**，不得出现在对外契约、日志正文或任何客户端可见的位置。

#### 6.1.2 握手期间的请求必须缓冲（**对前端是致命的**）

socket.io 在**握手完成前**发出的 `emit` 会被**静默丢弃** —— 不报错、不响应。

实测：三个客户端几乎同时连接时，第三个的 `room.match` 直接消失。

**规定**：网关的 WS 代理**必须把下游连接建立之前的请求排队，待下游 `connect` 之后再按序冲刷**。
前端的「连上就发 match」是自然写法，不能靠它自觉。

### 6.2 消息信封

**不使用 `seq` 字段。** 原参考文档的 `seq` 同时承担了「请求关联」「幂等去重」「流游标」三种互不兼容的语义，最终退化为「服务端推送为 0」的占位值；本文将其职责拆分给三个更合适的机制（详见附录 A.1 第 2 项）。

```ts
// ① C→S 请求：socket.io ack 回调直接承载响应
socket
  .timeout(5000)
  .emit(
    type,
    { reqId, baseVersion, timestamp, payload },
    (err, res: { code: number; message?: string; data?: unknown }) => {
      /* ... */
    },
  );

// ② S→C 主动推送
socket.emit(type, { version: number, payload: unknown });
```

**⚠️ socket.io 4 的 ack 回调约定（实测踩坑，务必照此实现）**

回调的**参数形状取决于是否用了 `.timeout()`**，两者不兼容：

| 写法                                      | 回调签名                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `socket.emit(type, body, cb)`             | `cb(res)` —— **只有一个参数，就是回执本身**，不是 node 风格 `(err, res)` |
| `socket.timeout(ms).emit(type, body, cb)` | `cb(err, res)` —— 超时错误在第一个参数                                   |

上面的伪代码用了 `.timeout()`，因此是 `(err, res)`。**若省略 `.timeout()` 却按 `(err, res)` 解包**，
`err` 会拿到回执对象、`res` 恒为 `undefined` —— 表现为「每个正常回执都被判为失败」，
**从日志上看却像「ack 永不到达」**，是联调里最难查的一类问题。实现时必须显式处理两种形态，或一律用 `.timeout()`。

**⚠️ 端点必须显式注入**：客户端**不得**依赖「回退到 `window.location.origin`」。
在 jsdom 等测试环境下它是 `http://localhost:3000`，请求会发给不存在的服务，同样表现为「ack 永不到达」。
端点必须来自显式配置或环境变量（如 `VITE_WS_ENDPOINT`）。

| 字段          | 方向      | 语义                                                                                         |
| ------------- | --------- | -------------------------------------------------------------------------------------------- |
| `type`        | 双向      | socket.io **事件名**。**请求体里不重复它**                                                   |
| `reqId`       | C→S       | UUID，**仅用于日志追踪**（接 §15.3 的 traceId），**不参与任何判定**。**平铺在请求体顶层**    |
| `baseVersion` | C→S       | 客户端所依据的状态版本；服务端据此做 CAS（§6.5）。**平铺在请求体顶层**                       |
| `timestamp`   | C→S       | 客户端毫秒时间戳；服务端校验 `\|clientTs − serverTs\| < 5000ms`（M01）。**平铺在请求体顶层** |
| `payload`     | C→S       | 请求载荷。**平铺在请求体顶层**（与上面三个同级，不嵌套在 `meta` 里）                         |
| `__ackId`     | 网关内部  | 见 §6.1.1。**不属于对外契约**                                                                |
| `code`        | S→C(ack)  | 数字错误码，`0` = 成功（§11）                                                                |
| `message`     | S→C(ack)  | 人类可读说明，**仅供调试**，客户端不得据此分支                                               |
| `data`        | S→C(ack)  | 请求结果                                                                                     |
| `version`     | S→C(推送) | 状态版本号，单调递增。丢弃规则见下方「同一版本的多条推送」                                   |
| `payload`     | S→C(推送) | **按接收者裁剪**的状态视图（§6.4）                                                           |

**C→S 请求体的形状（扁平，不嵌套 `meta`）**：

```ts
{ reqId: string, baseVersion: number, timestamp: number, payload: unknown }
```

校验器 `validateClientMessage(type, body)` 接受**事件名 + 上述扁平体**，内部组装成逻辑格式 `{type, meta, payload}` 返回。
**不要写成语义上等价的 `{type, meta:{...}, payload}`** —— 那与线格式不符，会让服务端直接拒绝所有请求。

- **不设 `signature`**：MVP 无支付类关键操作；签名机制见 `docs/appendix/platform-roadmap.md` §3。

**同一版本的多条推送（重要）**

§6.7 规定一次状态转移会发出**多条**推送（`game.state_update` → `game.current_turn`），它们在**同一次状态转移**内共享同一个 `version`。因此 M02 的「`version <= currentVersion` 即丢弃」**不得无条件应用**，否则第二条 `game.current_turn` 必然被丢弃，玩家永远收不到自己的回合（F07/M06 随之失效）。

规定的丢弃规则：

| 消息类别                                                                          | 丢弃判定                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **快照类**（`game.deal`、`game.state_update`、`game.reconnect` 的 ack）           | `version === currentVersion` → **丢弃**（重复）；`version < currentVersion` → **回退**，按 M08 主动重连；`version > currentVersion` → 应用 |
| **事件类**（`game.current_turn`、`game.finished`、`game.settlement`、`system.*`） | **不按 version 丢弃**；重复到达时按事件类型幂等处理（如同一 `version` 的 `current_turn` 只渲染一次）                                       |
| **不参与**（`room.state_update`、`room.matched`）                                 | 房间级消息，不携带对局 `version`，**不适用上述规则**                                                                                       |

客户端必须**先按 version 应用快照，再处理同版本的事件类消息**。

**⚠️ 上表的比较集是「同一局」内的 version 序列（v4.3 澄清，切片 P9 / R417）。**

`version` 是**每局**的版本号（§0.3 术语表），一局的序列**自本局的 `game.deal` 开始**（§6.5）。
因此：**跨局**的 version 比较**不是回退** —— 「上一局的终值（如 50）」与「新局的 `v1`」不在
同一个比较集里，客户端**必须在进入新局（房间号变化）时复位已应用的 `currentVersion`**，
否则新局的 `v1` 快照会被本表判成回退并丢弃，玩家**永远进不去新的一局**（实测：
连发 `game.reconnect` → `13010` → 被踢回大厅）。
⚠️ 复位**只发生在换局边界**：**同一局内** `version < currentVersion` 仍是回退、仍按 M08 处置。

### 6.3 消息清单

| 方向 | type                | 载荷                                                            | 说明                                                                                                                                                         |
| ---- | ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C→S  | `room.match`        | `{ mode: 'random' \| 'practice' \| 'gold', baseScore: number }` | **入队匹配**（MVP 主路径入口）。⚠️ `baseScore` **必填**（片规格 §2.4 协议②）：它进撮合键 ⇒ 不同底分**不会同房**。ack `code 0` = 已入队；`12009` = 已在队列中 |
| C→S  | `room.unmatch`      | `{}`                                                            | 取消匹配，从队列移除。ack                                                                                                                                    |
| C→S  | `room.match.extend` | `{}`                                                            | **「继续等待」动作：平移提示窗口**（机器人补位开关片；既有缺行本片补齐）：收到 `match.wait_prompt` 后由玩家点「继续等待」发出；票**留在原队列**（排队位置/入队时刻不变），只平移后续提示窗口；**总等待上限不重置**；不在队列中调用 = no-op（仍 `code 0`） |
| C→S  | `room.join`         | `{ roomCode }`                                                  | ack `data: { roomCode, seat, players: RoomPlayer[] }`                                                                                                        |
| C→S  | `room.leave`        | `{ roomCode }`                                                  | ack                                                                                                                                                          |
| C→S  | `game.bid`          | `{ grab: boolean }`                                             | ack                                                                                                                                                          |
| C→S  | `game.play`         | `{ cards: Card[] }`                                             | ack                                                                                                                                                          |
| C→S  | `game.pass`         | `{}`                                                            | ack                                                                                                                                                          |
| C→S  | `game.reconnect`    | `{ lastVersion? }`                                              | ack `data: 裁剪快照`；已结束则 `code: 13005`；尚未开始则 `code: 13009`；无任何可恢复凭据（含房间已回收）则 `code: 13010`                                     |
| C→S  | `game.resync`       | `{}`                                                            | **重新拉取当前裁剪快照**，ack `data: PlayerView`。**这是 §6.5 中 `13004` 的唯一恢复通道**，与 `game.reconnect`（断线恢复、含记录查找）语义不同               |
| C→S  | `game.trustee`      | `{ on: boolean }`                                               | **托管开关**（挂机治理片）：`on:true` = 开启托管（服务端按规则引擎代打，与超时链同一决策函数）；`false` = 解除。**幂等**（目标值 = 现值 ⇒ no-op、仍 `code 0`）；`on` 必须**严格 boolean**（否则 `10001` 且零 RPC）。ack `data: { version }`；三家托管态从 `PlayerView.trustees` 读 |
| S→C  | `room.matched`      | `{ roomCode, seat }`                                            | **匹配成功后服务端主动下发**（§8.2）                                                                                                                         |
| S→C  | `room.state_update` | `{ status, players: RoomPlayer[] }`                             | 房间内广播；**必须裁剪**（§6.4 规则 3）                                                                                                                      |
| S→C  | `match.wait_prompt` | `{ message: string }`                                           | **缺人友好提示**（机器人补位开关片；既有缺行本片补齐）：`version` 恒 `0`；仅当补位开关**关闭**且真人凑不齐 3 人时，入队约 30s 后收到、之后每 30s 一条，直到凑齐或总等待上限 `12007`；底部悬浮卡片给「重新匹配」（`room.unmatch` + `room.match`）与「继续等待」（`room.match.extend`）两操作 |
| S→C  | `game.deal`         | **`PlayerView`**（§4.2；`bottomCards` 恒为 `null`）             | 开局下发，由 `game.started` 翻译而来（§4.4）                                                                                                                 |
| S→C  | `game.current_turn` | `{ seat, timeoutMs, version }`                                  | 回合开始；`timeoutMs` 由服务端按 `turnDeadlineAt` 计算                                                                                                       |
| S→C  | `game.state_update` | **`PlayerView`**（§4.2 定义，按接收者裁剪）                     | 每次状态转移后                                                                                                                                               |
| S→C  | `game.finished`     | `{ winner, version }`                                           | —                                                                                                                                                            |
| S→C  | `game.settlement`   | **`SettlementResult`**（定义见玩法 §8.5）                       | 与 `game.finished` 同版本                                                                                                                                    |
| S→C  | `game.balances`     | `{ balances: { seat, balance }[] }`                             | **金币场**结算后三座余额（恰 3 条、座位升序；与 `game.settlement` 同 version）；免费场 / 好友房**不出现**。结算页金币列以它为准；5s 未达 ⇒ 定格「—」         |
| S→C  | `game.card_counter` | `{ roomCode, active, source? }`                                 | **记牌器收费片**：本局记牌器是否开通（按玩家定向；`version` 恒 `0`，房间级）。`active` 由服务端按总开关/场次/权益消费结果计算；`source ∈ pass/credit/none/unknown` |
| S→C  | `system.error`      | `{ code, message }`                                             | 非请求触发的系统错误                                                                                                                                         |
| S→C  | `system.warning`    | `{ code, message }`                                             | 维护通知等                                                                                                                                                   |

**明确不存在**：

- 任何机器人消息（`bot.move` / `robot.join` / `robot.leave` 全部废除，见 §9.1）
- 任何响应型事件（`room.joined` / `game.reconnected` / `game.timeout` 全部并入 ack）
- 应用层 `ping` / `pong`

**旧消息名 → 新消息名（迁移映射表）**

这张表是「旧名 → 新名」的**唯一**映射真源（与 §11.4 的错误码别名表同等重要 —— 错误码有别名表，消息名同样需要），共 **24** 个旧消息名。
实现必须按此表迁移，**不得继续下发旧名**。

> ⚠️ **历史注记**（P7 / 裁决 R361）：这些旧名原先定义在一份**与本文 §6.1/§6.2/§6.3 逐字冲突的「第二契约」**源码文件里（含 `'ping'`、`seq?: number`，且与真契约的 `ClientPacket` 不同形）。该文件**已整条删除**（连同它的测试、`shared/src/index.ts` 的 re-export 与 `shared/vitest.config.ts` 的覆盖率排除项），并新增源码闸 `packages/shared/test/no-legacy-message-names.gate.test.ts` 防止它在 `shared` 里**复活**。
> **本表保留为历史映射**：它记录的是「哪些旧名被废除了、各自换成什么」，而不是「有一个文件还定义着它们」。⇒ **不要**因为源文件已删就删掉这张表。

| 旧名（原第二契约）                             | 新名（本文 §6.3）                                           |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `game.match.quick`（C→S）                      | `room.match { mode: 'random' }`                             |
| `game.match.practice`（C→S）                   | `room.match { mode: 'practice' }`                           |
| `game.match_found`（S→C）                      | `room.matched`                                              |
| `game.ready`（C→S）                            | **废除**（MVP 匹配即成局，无准备阶段）                      |
| `reconnect`（C→S）                             | `game.reconnect`                                            |
| `ping`（C→S）                                  | **废除**（改用 socket.io 内置心跳，§6.1）                   |
| `room.join` / `room.leave`（C→S）              | 保留原名                                                    |
| `room.joined`（S→C）                           | 并入 `room.join` 的 ack                                     |
| `room.players_updated`（S→C）                  | `room.state_update`                                         |
| `room.chat_message` / `game.chat`              | **废除**（MVP 无聊天）                                      |
| `game.deal_cards`（S→C）                       | `game.deal`                                                 |
| `game.bid_turn`（S→C）                         | `game.current_turn`                                         |
| `game.bid_result` / `game.landlord`（S→C）     | `game.state_update`（地主身份见 `PlayerView.landlordSeat`） |
| `game.play_turn`（S→C）                        | `game.current_turn`                                         |
| `game.card_played` / `game.player_pass`（S→C） | `game.state_update`                                         |
| `game.game_over`（S→C）                        | `game.finished` + `game.settlement`                         |
| `game.bid` / `game.pass`（C→S）                | 保留原名                                                    |
| `game.play_cards`（C→S）                       | `game.play`                                                 |
| `error`（S→C）                                 | `system.error`                                              |

### 6.4 可见性裁剪（新增契约）`[已实现]`

> `[已实现]`（P8 复审：裁剪表 4 项 + 规则 8 条全落地；`protocol/src/validate.ts:37-44` 的 `FORBIDDEN_OUTBOUND_KEYS` 由 `proxy.gateway.ts:304` 对**每条** S→C 执行）

`game.deal`、`game.state_update`、`game.reconnect` 的 ack 载荷**按接收者座位分别生成**，服务端为三家各生成一份：

| 内容                                        | 自己                                                    | 其他玩家                                |
| ------------------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| 手牌 `hand`                                 | **完整明文**                                            | **仅张数 `cardCounts[seat]`，不含牌面** |
| 底牌 `bottomCards`                          | 叫抢阶段恒为 `null`；`state === 'playing'` 后三家皆可见 | 同左                                    |
| 身份标记                                    | **无 `isRobot`、无 `botId`**                            | 同左                                    |
| 桌面历史牌 `recentActions`（协议④，窗口 2） | 明文（**只含已经打出过的牌**；不含任何未出的手牌）      | 明文                                    |
| 托管态 `trustees`（挂机治理片）             | 明文（`[boolean, boolean, boolean]` 按座位，三家态都给出） | 明文（「托管中」徽标据此渲染；**公开信息**） |

规则：

1. 服务端**出站前统一裁剪**，禁止在业务层直接下发 `GameSession`；
2. 裁剪结果的类型是 **`PlayerView`**（定义见 §4.2），它是裁剪视图的**唯一类型来源**；
3. **`room.state_update` 同样必须裁剪** —— 它的 `players` 元素只允许含 `{ id, seat, cardCount?, balance?, nickname? }`，**不得含 `isRobot`**（否则 §9.1 的不可区分性硬约束被绕过）；
4. **永不出站字段**：`actionLog`（含三家全部牌面）、`players[].hand`（除自己外）、`isRobot`、`botId`、`skillLevel`；
5. **动作响应同样只返回 `PlayerView`** —— `POST /api/games/:roomCode/{bid,play,pass}` 的响应**不得**返回 `GameSession`。这些入口与 `GET` 是**同一个泄漏面**，只是换了条路径。判据：任何对局相关的出站响应，其形状都必须是 `PlayerView`；
6. 观战：**MVP 不提供**；
7. 重连：下发**当前版本的裁剪快照**；
8. 裁剪由 **game-service** 完成（它是状态机所有者），room-service 只按 seat 投递（§4.4）。

### 6.5 幂等与并发控制（新增契约）`[已实现]`

**三层防护，按重要性排序：**

1. **CAS（主）**：请求携带 `baseVersion`；服务端 `baseVersion !== session.version` → 返回 `13004`，拒绝。
2. **状态机天然幂等（辅）**：回合归属（`playerIdx !== currentPlayer`）+ 手牌归属（牌已移出）+ 规则校验。两层叠加可拦住绝大多数重放。
3. **`actionId`（演进）**：仅当出现副作用型操作（货币/结算）时才需要，MVP 不做。

**`baseVersion` 的适用范围**（哪些请求参与 CAS）：

| 消息                                   | 是否携带 `baseVersion`       | 说明                                                       |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `game.bid` / `game.play` / `game.pass` | **必须**                     | 参与 CAS，冲突返回 `13004`                                 |
| `game.reconnect`                       | **否**，改携带 `lastVersion` | 语义不同：只用于判断快照新旧，不做 CAS                     |
| `game.resync`                          | **否**（传 `0`）             | 只读地重拉当前裁剪快照，没有任何要保护的状态，故不参与 CAS |
| `room.join` / `room.leave`             | **否**                       | 房间操作没有对局版本概念                                   |
| `room.match` / `room.unmatch`          | **否**                       | 匹配队列操作没有对局版本概念                               |

**首个动作的 `baseVersion` 初值**：客户端从 `game.deal` 推送的 `version` 取得（发牌本身即一次状态转移）。

规定：

- 动作请求的 `baseVersion` = 客户端**最近一次应用的** `version`；
- **请求串行**：一次只有一个在途请求；收到 ack 或 `state_update` 后才允许下一次（与 M06 一致）；
- **`13004` 的统一处置（只有一种）**：客户端**丢弃本地未确认的乐观状态 → 调用 `game.resync` 重新拉取当前裁剪快照 → 由用户重新发起操作**。不区分触发原因（重复送达 / 基于旧状态 / 服务端超时自动动作），三种情况处置完全一致。
  - **例外（自激守卫）**：快照类请求**自身**的 `13004`/`13007`/`13009` 不触发 resync——见切片设计 `docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md` §5 与 `docs/client-protocol.md` 处置例外行。
  - **不得**用 `game.reconnect` 充当这一路径：`game.reconnect` 是断线恢复（含连接与记录查找），语义不同，故本文为冲突恢复单独定义了 `game.resync`（§6.3）。
  - **既不要求也不允许为 `13004` 触发「主动断开重连」**：它是可恢复的状态冲突；重连是更重的手段，只用于快照类消息 `version` **回退**的场景（见 §12.3 M08 的收窄）。
- **不提供消息级游标**；重连一律回全量裁剪快照（§6.6）。

### 6.6 重连 `[已实现]`

> `[已实现]`（断线恢复「对局存活即可回」（2026-10-12）：恢复门槛 = **记录在 + 对局存活**（无窗口/TTL）；含 §6.6.1 **四步判定顺序、五写入时机**、`restoreDelivery`；测试 `reconnect.service.test.ts` 17 条 + conformance `slice-05` 64 项、`slice-12` 90 项）

```
客户端 socket 重连（socket.io 自动）
  → emit('game.reconnect', { lastVersion }, ack)
      ├─ code 0     → data = 当前裁剪快照（PlayerView）
      ├─ code 13005 → 对局已结束，无法恢复
      ├─ code 13009 → 对局尚未开始（可重试）
      └─ code 13010 → 没有任何可恢复凭据（含房间已回收）
```

- 判定由单一实现 `resolveRecoverableRoom`（存活谓词；候选 `[match:pending:{playerId} → reconnect:active 哈希]` 择优）驱动 —— **不依赖任何时间窗口/TTL**。
- **MVP 不做增量事件重放**。参考文档 F08/M03 要求「返回从 `lastSeq` 之后的增量事件」，但该要求依赖的 `lastSeq` 游标已被其自身的「推送 seq 为 0」废掉，且增量重放需要事件 reduce 规则（参考文档未定义）。MVP 以全量快照替代，事件重放见演进附录 §5。
- **`13010` 专用于「没有任何可恢复凭据（含房间已回收）」**，不得复用 `12001`（房间不存在）——否则客户端无法区分「重连失败」与「房间真的没了」。

#### 6.6.1 记录写入时机（在线观测点）

恢复门槛 = **记录在 + 对局存活**（不再有 30 秒窗口；`reconnect:active` 无 TTL，仅 `room.leave` 清除）。记录必须在下列时机写入或刷新为 `connectedAt = now`：

| 时机                                                 | 理由                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `startRoom` 开局（人类座位；`socketId` 写空串）      | 匹配/占座后**从未 `room.join`** 的玩家也有凭据 —— `match:pending` 票过期后仍可回桌                                     |
| `room.join` 成功                                     | 建立可恢复点                                                                                                           |
| `game.reconnect` 成功                                | 恢复在线后刷新在线观测点                                                                                               |
| 服务端观测到 `disconnect`                            | 在线观测点刷新（该时刻仅诊断，不参与判定）                                                                             |
| 新连接建立，且该玩家的**上一个连接从未被观测到断开** | 硬网络中断：服务端还没收到 `disconnect` 新连接就到了 —— 同一在线会话换链路；凭据在 join/开局时即存在，较旧窗口方案更稳 |

**`game.reconnect` 的判定顺序（强制）**：

1. `resolveRecoverableRoom` 返回 `null`（无任何可恢复凭据）→ `13010`；
   ⚠️ **来源泛化（片⑦ 修复）**：`match:pending` 的写入已从「匹配成功」泛化为**一切 `RoomStartService.startRoom` 开局**（§8.2）——本步「补回」的语义不变，但凭据在手动房 / 好友房同样存在（此前好友房没有，迟到者无从补回）。
   ⚠️ **`room.leave` 必须同时清除 `match:pending:{playerId}`**：玩家主动离开后，「补回错过的 `room.matched`」这个用途就消失了。不清除的话，「`room.leave` → 断线 → `game.reconnect`」会命中这一步、把玩家送回**他刚刚主动离开的房间**（实测复现，code 0 + 那个房间的快照）。
   **任何「找不到可恢复的对局」的结果都必须落到 `13010`，不得复用 `12001`**（§6.6 正文）；
2. 拿到 `roomCode` 后取 `PlayerView`：view 存在且 `state === 'ended'` → `13005`；
3. view 拿不到（`ROOM_NOT_FOUND` / `NOT_IN_ROOM` 翻译为 `null`）但**房间键存在** → `13009`（可重试）；房间键不存在（房被回收）→ `13010`；
4. 其余 → ack `code 0`，`data` = **当前版本**的裁剪快照 `PlayerView`。

**重连成功后必须恢复投递链路**：`socket.join(roomCode)`，并重新登记该玩家的 `seatOwners` 映射。只回快照而不恢复投递，玩家在重连后**收不到任何后续推送**——「状态与服务端一致」只在 ack 那一刻成立，紧接着就失真。这条不是优化，是「重连成功」的定义的一部分。

**`lastVersion` 不参与 CAS**（§6.5 适用范围表）：服务端可忽略其值，一律返回当前版本的全量裁剪快照（§6.4 规则 7）。

### 6.7 消息时序

```
开局：     game.deal → game.current_turn
每次操作：game.state_update → game.current_turn
结束：     game.finished → game.settlement
```

**同一次状态转移发出的多条消息共享同一个 `version`。** 客户端的丢弃规则因此必须区分消息类别，见 §6.2 的「同一版本的多条推送」。

**⚠️ 顺序是强制的，不是约定**：同一次状态转移内，**`game.state_update` 必须先于 `game.current_turn` 到达并由客户端应用**。

理由：`game.current_turn` 的载荷只有 `{ seat, timeoutMs, version }`，**不含 `cardCounts`**；他人张数的唯一来源是快照类消息（§6.4）。若客户端先渲染了回合而快照还没应用，UI 会短暂显示**陈旧的他人手牌张数**。

服务端必须按此顺序发布；room-service 的翻译规则（§4.4）已经体现了这一点（先 `state_update` 后 `current_turn`）。

---

## 7. 核心服务规格

### 7.1 api-gateway `[部分实现]`

> ⚠️ **P12 裁决（R473）· R1210 更新：标记保留 `[部分实现]`** —— TLS 终止已**产物化**进本仓：门口 `edge`（`Dockerfile.edge` + `deploy/Caddyfile`，生产形态编排第 18 个服务〔支付片后总数；原「第 10 个」为上线运营层片时计数〕）**就是**本仓的 TLS 终结者（编排里**有**终结者了；`.worktrees/**` 的旧快照不计）。⚠️ 这不推翻 R473 的「TLS 终止由部署层承担」—— 本仓只是把部署层的那段**产物化**。保留 `[部分实现]` 的理由改为：**真证书（ACME）签发路径未验证**（本机无域名，只验过自签 `tls internal` 那条路）。②-⑥ 全绿（含白名单恰好五条精确匹配、`GET /api/games/:roomCode` 走裁剪视图）。
>
> **对外语义（R1210）**：门口 `edge` = **唯一对外入口**（宿主只发布 `80` / `443`）；`api-gateway` 退为**内部服务**（不发布，`expose: 3000` —— 即 §2.1 的「对外 = 门口」）。明文 HTTP 只在 compose 网络 `ftl-platform` 内。⚠️ **不得为凑 0 而改标题** —— 真证书路径未验证前，仍算**部分实现**（R473）。

**职责**：唯一对外入口（**由门口 `edge` 承担**，见上；本服务是它的网内上游）、TLS 终止（**由门口 `edge` 承担**，见上）、JWT 验签、限流、身份注入、HTTP 反向代理、WS 代理。

- HTTP 路由：`/api/auth/*` 代理到下游；**网关不暴露 `/api/users/*`**（⚠️ **复核订正 2026-09-27 · 用户裁决**：
  这里先后写过通配 `/api/users/*`、又写过「实际暴露 `GET /api/users/me` 一条」—— **两句都不成立**。
  后者是片② 客户端临时补的网关路由，随后**撤销**：网关的 `forward()` 只注入四个内部头、**从不转发
  `Authorization`**，而 user-service 的 `users.controller` 挂 passport-jwt 守卫（**必须** Bearer）
  ⇒ 该路由经网关**恒 401**。⚠️ 但这**不是**「user-service 没有这条路由」—— 它有 `@Get('me')`
  （直连可达，conformance `slice-07.2-boundary` 覆盖的正是直连面），只是**网关不代理它**。
  客户端顶栏昵称因此改走**登录响应**里的 `user.nickname`（本地持久化））；`/api/health` 本地
- `GET /api/config` → 转发 **config-service**（玩家可见子集，**恰好**十五键：`baseScoreLevels` / `friendRoomEnabled` / `freeRoomEnabled` / `goldRoomEnabled` / `reliefEnabled` / `entryMultiplier` / `rechargeEnabled` / `withdrawEnabled` / `coinPerYuan` / `rechargePackages` / `withdrawMinCoins` / `withdrawMaxCoinsPerOrder` / `withdrawDailyMaxCoins` / `reliefAdpid` / `version`，§7.5/§7.7；经网关**验签**、不在白名单）。
- `/api/admin/*` → **管理面路由族**（③ 起：**多账号 + 四角色**，§7.5），按路由分派三个下游 —— 登录 / 账号 CRUD / 三审计读口 / 配置读/写 → **config-service**；钱包读口、冲正、对账 → **currency-service**（`CURRENCY_SERVICE_URL`，§2.3）；用户详情 `GET /api/admin/users/:id` → **user-service**。**独立鉴权**（管理令牌，与玩家令牌两套）；⚠️ 它**不进**下面的五条公开白名单 —— 走的是 `public-paths.ts` 的另一条**前缀**条目 `isAdminPath()`（语义是「**不适用**玩家凭据」，不是「**无需**凭据」，与五条**精确**条目**分列**）。
- **旧端点已退役**（片⑦）：`GET /api/base-score-levels`（网关路由 + user-service 控制器 + 客户端调用）随底分档位收编**一并删除**；原先关于「`@Get('rooms')` 声明顺序」的那条复核订正**随之作废**（该路径已不存在）。
- `GET /api/rooms` → 返回 `RoomInfo[]`（§3.1）；`POST /api/rooms` → 返回 `RoomInfo`
- `GET /api/records/mine` → 转发 **user-service**（「我的历史战绩」，**只本人**：JWT 验签（**不在白名单**）；`cursor`/`limit` query 按 R75 白名单透传 —— 网关**首次** GET query 透传，§7.6）。
- **对外保留** `GET /api/games/:roomCode`，但语义与内部 RPC 严格区分：它**必须鉴权**，且**只返回调用者的裁剪视图**（§6.4）。
  **实现上必须调用 §4.2 的 `game.view`（按 seat 裁剪）；严禁复用 `game.snapshot` 的返回值**——后者返回完整 `GameSession`（含三家手牌与底牌），复用会直接复现 S2/S8 的泄漏。对局的推进也不经过此路由：推进走 WS，服务间查询才用 `game.snapshot`。
  `[已实现]`（**S2/S8/R74**）：该路由**必须鉴权**（不在白名单里，匿名 401），且只返回调用者的裁剪视图 —— `game-service/src/game/game.controller.ts:55,62-68` 的座位**只**由 `X-User-Id` 定位（**不接受** `?seat=` 覆盖），`game.service.ts:214-222` 的 `getViewForUser` → `findSeatByUserId` + `buildPlayerView`。
- 公开路径白名单：**仅** `/api/auth/login`、`/api/auth/register`、`/api/auth/refresh`、`/api/health`、`/api/health/live`
  （第 5 条为 P5 新增，R267/R293。⚠️ 必须是**精确**条目，**不得**把 `/api/health` 改成前缀 ——
  那会让 `/api/healthz` 一类路径静默变公开；`container-assembly.gate.test.ts` 与 conformance 的近邻负对照都钉住这一点。）
  `[已实现]`（**A6/S6/R138/R141**）：白名单是上表**恰好五条**的**精确**匹配（`jwt.middleware.ts:72-78`、`:175-178` 的 `publicPaths.includes(path)`）；`'/'` 早已剔除 —— 源码注释逐字写着「The public-path whitelist must **never** contain `'/'`」。
- ⚠️ **另有**一条**不是白名单**的「整段跳过玩家验签」：`/api/admin/*`（**片⑦**，管理面走**独立鉴权**，§7.5）—— 挂点同样在 `public-paths.ts`（R462 单一真源），但**分列**：它是 `isAdminPath()` 的**前缀**语义，与上面五条**精确**条目不是一类（语义 = 「**不适用**玩家凭据」，不是「**无需**凭据」——理由见上一条）。
- WS 代理：客户端连接 api-gateway，由 gateway 反向代理到 room-service（每客户端一条下游连接）
  `[已实现]`：`api-gateway/src/gateway/proxy.gateway.ts:82` 有 `@WebSocketGateway({…})`（含 R293 的 `allowRequest` 委派），不再死代码。
- `[已实现]`（**S6/R30/R141**）：§5.4 的两个维度都已落地 —— `http/rate-limit.ts:4` 的 `HTTP_RATE_LIMIT = { max: 20, windowMs: 5000 }` 与 `:15` 的 `WS_CONN_LIMIT = { max: 5, ttlSeconds: 60 }`，由 `app.module.ts:31` 的 `consumer.apply(JwtMiddleware, HttpRateLimitMiddleware).forRoutes('*')` 挂载；`docker-compose.yml:226` 已给网关 `REDIS_URL=redis://redis:6379`。

### 7.2 user-service `[已实现]`

**职责**：注册、登录、用户资料、令牌签发与吊销。

- 表 `users`：`id(varchar36, PK)`、`phone(varchar20, unique)`、`password_hash(varchar255)`、`nickname`、`avatar`、`status`、`created_at`
- 密码：bcrypt，`saltRounds = 10`
- 令牌：见 §5.1
- 端口从 `PORT` 读取

### 7.3 room-service `[已实现]`

> `[已实现]`（P8 复审：三条偏差全关：`rooms/rooms.seats.ts:56` `HSETNX`、`rooms.service.ts:74` `SCAN`、`match.service.ts:110-113` 与 `ws.gateway.ts:150-152` 的 `onModuleInit` 接线）

**职责**：房间生命周期、匹配队列、WS 消息路由、重连记录、机器人补位申请。

### 7.4 game-service `[已实现]`

> `[已实现]`（P8 复审：Redis 已是真源（`game.service.ts:131` `loadSession`、`:149` 调用点、`:120-128` 写入）；`createGame` 假注释 0 命中）

**职责**：对局状态机所有者。发牌、叫抢、出牌校验、胜负判定、结算、回合定时、机器人回合调度。

- 规则实现见 `docs/games/doudizhu.md`

### 7.5 config-service（配置中心）`[已实现]`

> `[已实现]`（**片⑦「配置中心 + 好友房开关」**，2026-10-02）：把散在各处的「可调参数」收进一个**独立服务** ——
> **一处改（后台网页）→ 写库 → 推送失效 → 各服务内存缓存重载**；底分档位那条既有的热配置路**收编成配置键**。
> 计数：**第 8 个自建镜像**（支付片后共 14 个）；容器 = 开发形态 **11** / 生产形态 **18**（§2.2；支付片订正）。

**存储与版本**：MySQL 表 `platform_config`（`key` 主键 / `value` JSON / `version` BIGINT / `updated_at` / `updated_by`）；
`version` = **每键单调计数器**（写事务内 +1；重启不倒退），快照与两种读都携带**每键 version**，全局 `version = MAX(每键)`
（客户端 `GET /api/config` 的 `version` 即它）。`migrationsTableName` **独立**（`migrations_config` —— 防与 user-service 共写同名 `migrations` 表）。

**五十一键**（默认 = 种子 = 代码默认值；写入侧校验：非法 ⇒ **400 不落库**）：

| 键 | 形状 / 校验 | 默认 | 消费者 |
|---|---|---|---|
| `robot.skillDistribution` | 三档权重齐 · 各 ≥ 0 · 合计 > 0（**写入时按合计归一化落库**，`'15,35,50'` 合法） | `0.15 / 0.35 / 0.5` | robot-service |
| `robot.ruleFallback` | 严格 `true`/`false` | `true` | robot-service（**补位探测门禁**，§8.5） |
| `robot.modelBySkill` | 三键齐 · 值 ∈ 三个 DouZero 模型名 | `sl` / `douzero_WP` / `douzero_ADP` | robot-service |
| `robot.reclaimIntervalMs` | 整数 · `0 < n ≤ 600000` | `60000` | robot-service（§9.6 回收任务） |
| `room.matchScanIntervalMs` | 同上 | `5000` | room-service（匹配扫描） |
| `room.autostartIntervalMs` | 同上 | `5000` | room-service（自动开局） |
| `room.reapIntervalMs` | 同上 | `60000` | room-service（房间回收） |
| `room.friendRoomEnabled` | 严格 boolean | **`false`**（**默认关**，要显式开） | room-service + 客户端 |
| `game.baseScoreLevels` | `{name, baseScore, entryFeePercent?}[]`：非空 · 正整数且 `≤ 8191`（金币金额列 int 的容量上界，金币场 C24）· 唯一（2026-10-21 起**不再要求含某个缺省档**：省略底分时取表内最低档）；`entryFeePercent` 可选整数 0–100（缺省 0，100 = 入场费等于底分）= **台费唯一来源** | 四档 `15/80/480/1200`（台费全 0） | room-service + 客户端 |
| `record.retentionDays`（**记录片第 10 键**） | 整数 · `1 ≤ n ≤ 3650` | `365` | user-service（对局记录清理任务，§7.6 —— 该服务的**首条配置消费链**） |
| `currency.signupGrant`（**货币核心第 11 键**） | 整数 · `0 ≤ n ≤ 1,000,000` | `0`（**默认不赠送**） | user-service（注册赠送链路读取——注册那一刻快照；缺失/坏值回落 0；**客户端不可见**，§2.8 货币核心规格） |
| `room.freeRoomEnabled`（**金币场第 12 键**） | 严格 boolean | **`true`**（保持现状） | room-service + 客户端 |
| `room.goldRoomEnabled`（**金币场第 13 键**） | 严格 boolean | **`true`**（**默认开** —— 2026-10-04 用户裁决，原默认关/暗上线） | room-service + 客户端 |
| `currency.entryMultiplier`（**金币场第 14 键**） | 整数 · `1 ≤ n ≤ 100` | `10` | room-service（入场门槛 = 底分 × 本值）+ currency-service（救助判定倍率）+ 客户端（门槛提示） |
| `currency.rakePercent`（**金币场第 15 键**） | 整数 · `0 ≤ n ≤ 50` | `0`（**默认不抽水**） | room-service（结算抽水；**客户端不可见**） |
| `currency.reliefEnabled`（**金币场第 16 键**） | 严格 boolean | **`false`**（**默认关**） | currency-service（救助端点裁决）+ 客户端 |
| `currency.reliefAmount`（**金币场第 17 键**） | 整数 · `1 ≤ n ≤ 1,000,000` | `200` | currency-service（救助发放；**客户端不可见**） |
| `risk.predicate.sameDevice`（**风控第 18 键**） | 严格 `true`/`false` | **`false`**（**默认关**，D4 暗上线） | room-service（§8.3 同设备谓词；开启手顺见 `first-deploy.md`） |
| `risk.predicate.sameIp`（**风控第 19 键**） | 严格 `true`/`false` | **`false`**（**默认关**） | room-service（§8.3 同 IP 谓词；CGNAT 误伤面大 ⇒ 评估后再开） |
| `risk.winRateThreshold`（**风控第 20 键**） | number · `0.5 ≤ n ≤ 1.0` · ≤2 位小数 | `0.8` | user-service（扫描胜率阈值；命中 = `winRate >` 本值） |
| `risk.minGames`（**风控第 21 键**） | 整数 · `1 ≤ n ≤ 100000` | `100` | user-service（扫描最少局数；命中 = `games >` 本值） |
| `risk.deviceLimit`（**风控第 22 键**） | 整数 · `2 ≤ n ≤ 100` | `3` | user-service（设备数阈值；命中 = 窗口内 `devices >` 本值） |
| `risk.deviceWindowDays`（**风控第 23 键**） | 整数 · `1 ≤ n ≤ 365` | `30` | user-service（设备统计窗口，天） |
| `risk.autoThrottle`（**风控第 24 键**） | 严格 `true`/`false` | `true` | user-service（scan 状态机：评分 ≥50 且开 ⇒ 自动上限流档；封禁恒人工） |
| `risk.deviceRetentionDays`（**风控第 25 键**） | 整数 · `1 ≤ n ≤ 3650` | `365` | user-service（设备记录清理保留期） |
| `pay.rechargeEnabled`（**支付第 26 键**） | 严格 `true`/`false` | **`false`**（**默认关**，暗上线；只挡**新建单**） | payment-service + 客户端（充值区显隐） |
| `pay.withdrawEnabled`（**支付第 27 键**） | 严格 `true`/`false` | **`false`**（**默认关**） | payment-service + 客户端（提现区显隐） |
| `pay.coinPerYuan`（**支付第 28 键**） | 整数 · `1 ≤ n ≤ 1,000,000` | `100` | payment-service（**下单时快照**）+ 客户端（档位换算展示） |
| `pay.rechargePackages`（**支付第 29 键**） | 非空唯一正整数数组 · 每项 `1 ≤ n ≤ 9,999,999` | `[6,30,68,128,328]`（元） | payment-service（档位表；非法档位 ⇒ 10001）+ 客户端 |
| `pay.withdrawMinCoins`（**支付第 30 键**） | 整数 · `1 ≤ n ≤ 1,000,000` | `1000` | payment-service（提现门槛 ⇒ 15003）+ 客户端 |
| `pay.withdrawMaxCoinsPerOrder`（**支付第 31 键**） | 整数 · `1 ≤ n ≤ 1,000,000` | `50000` | payment-service（单笔上限 ⇒ 15004）+ 客户端 |
| `pay.withdrawDailyMaxCoins`（**支付第 32 键**） | 整数 · `1 ≤ n ≤ 1,000,000` | `100000` | payment-service（单日/人上限 ⇒ 15004）+ 客户端 |
| `pay.orderExpireMinutes`（**支付第 33 键**） | 整数 · `1 ≤ n ≤ 10080` | `30` | payment-service（订单有效期；过期关闭 §7.7） |
| `pay.withdrawTimeoutMinutes`（**支付第 34 键**） | 整数 · `1 ≤ n ≤ 10080` | `4320`（=72h） | payment-service（提现超时回滚；测试注入 1） |
| `pay.scanIntervalMs`（**节奏/清理第 35 键**） | 整数 · `1 ≤ n ≤ 600000` | `60000`（=60s） | payment-service（扫描链八条补偿循环的统一节奏） |
| `pay.reconcileIntervalMs`（**节奏/清理第 36 键**） | 整数 · `1 ≤ n ≤ 864000000` | `86400000`（=24h） | payment-service（日自检：入账勾稽 + 锚勾稽） |
| `currency.reconcileIntervalMs`（**节奏/清理第 37 键**） | 整数 · `1 ≤ n ≤ 36000000` | `3600000`（=1h） | currency-service（对账周期） |
| `risk.scanIntervalMs`（**节奏/清理第 38 键**） | 整数 · `1 ≤ n ≤ 36000000` | `3600000`（=1h） | user-service（风控扫描周期） |
| `risk.devicesCleanupIntervalMs`（**节奏/清理第 39 键**） | 整数 · `1 ≤ n ≤ 36000000` | `3600000`（=1h） | user-service（设备记录清理周期；保留期见 `risk.deviceRetentionDays`） |
| `record.cleanupIntervalMs`（**节奏/清理第 40 键**） | 整数 · `1 ≤ n ≤ 36000000` | `3600000`（=1h） | user-service（对局记录清理周期，§7.6） |
| `ad.reliefAdpid`（**广告片第 41 键**） | string · trim 后 `''`（合法=未配置）或 `^[0-9A-Za-z]{1,32}$`（base62） | `''`（**空串 = 未配置**，暗上线；迁移种子里以 JSON 字面量 `'""'` 表示——string 种子首例） | 客户端（救助入口的广告位 adpid；**客户端可见**——下发裸名 `reliefAdpid`，第 15 键；**服务端不消费本键**） |
| `client.appEnabled`（**客户端接入第 43 键**） | 严格 boolean | **`true`**（**暗上线 = 全开**：种子即现状，闸行为零变化） | api-gateway（App 端准入闸：关 ⇒ app 端 HTTP 403/10008 + socket 握手拒；**客户端不可见**——不进 `CLIENT_CONFIG_KEYS`） |
| `client.h5Enabled`（**客户端接入第 44 键**） | 严格 boolean | **`true`**（暗上线 = 全开） | api-gateway（H5 端准入闸；语义同第 43 键、两键独立；**客户端不可见**） |
| `room.freeBotFillEnabled`（**机器人补位开关第 45 键**） | 严格 boolean | **`true`**（**保持现状**：匹配缺人仍补机器人） | room-service（免费场 `random` 缺人补机器人开关；**关** ⇒ 绝不补机器人，缺人改走 `match.wait_prompt` 提示 + 总上限；好友房不受本键影响；**客户端不可见**） |
| `room.goldBotFillEnabled`（**机器人补位开关第 46 键**） | 严格 boolean | **`true`**（保持现状） | room-service（金币场 `gold` 缺人补机器人开关；语义同第 45 键、两键独立；**客户端不可见**） |
| `room.matchNoBotMaxWaitMs`（**机器人补位开关第 47 键**） | 整数毫秒 · `30000 ≤ n ≤ 1800000`（30s～30min） | `300000`（=5min） | room-service（**仅上面两个补位开关关闭时有效**：真人间匹配的**总等待上限**，自原始入队时刻起算、玩家延长**不重置**；到点 ⇒ 12007；期间每 30s 可经 `match.wait_prompt` 由玩家延长；**客户端不可见**） |
| `risk.withdrawReAuthEnabled`（**提现再认证第 48 键**） | 严格 boolean | **`false`**（暗上线） | payment-service（提现票据闸：开 ⇒ apply 必须带 `X-Reauth-Ticket`；**客户端可见**——裸名 `withdrawReAuthEnabled`，第 16 个可见键） |
| `risk.deviceBindingEnabled`（**设备绑定第 49 键**） | 严格 boolean | **`false`**（暗上线） | user-service + api-gateway（登录/注册/refresh 与 WS 握手闸；**客户端不可见**） |
| `game.cardCounterEnabled`（**记牌器第 50 键**） | 严格 boolean | **`true`**（保持现状） | room-service（开局状态块读总开关）+ 客户端（左上角入口/横条门控；**客户端可见**——裸名 `cardCounterEnabled`，第 17 个可见键） |
| `game.cardCounterPricePerGameCoins`（**记牌器收费第 51 键**） | 整数金币 · `0 ≤ n ≤ 1,000,000`（0 = 该商品隐藏） | **`10`** | currency-service（购买端点 effect 内校验当前价）+ room-service（状态块判断收费态）+ 客户端（购买面板；**客户端可见**——裸名 `cardCounterPricePerGameCoins`，第 18 个可见键） |
| `game.cardCounterPricePerHourCoins`（**记牌器收费第 52 键**） | 整数金币 · `0 ≤ n ≤ 1,000,000`（0 = 该商品隐藏） | **`100`** | 同第 51 键（**客户端可见**——裸名 `cardCounterPricePerHourCoins`，第 19 个可见键） |

⚠️ **game-service 不消费任何键**（不装配缓存、不加任何 env）；消费者面恰好 = room-service / robot-service / **user-service**（记录片起：`record.retentionDays`，§7.6；货币核心起再消费 `currency.signupGrant`；**风控片起**再消费 `risk.*` 六键——扫描阈值/设备窗口/保留期/自动限流；**节奏/清理旋钮管理化片起**再消费节奏三键——`risk.scanIntervalMs`/`risk.devicesCleanupIntervalMs`/`record.cleanupIntervalMs`）/ **currency-service**（金币场起：救助与门槛三键，本服务首接配置；节奏/清理旋钮管理化片起再消费 `currency.reconcileIntervalMs`——对账周期；**广告片起另走专用拉取边 `config.adChannel.get`** 取广告回调密钥（恰 1 键）——**不进本快照面**，见 §2.3 行）/ **payment-service**（支付片起：`pay.*` 九键——两开关/比率/档位/三限额/两周期，本服务首接配置；节奏/清理旋钮管理化片起再消费 `pay.scanIntervalMs`/`pay.reconcileIntervalMs`——扫描/日自检周期；**支付配置管理化片起另走专用拉取边 `config.payChannel.get`** 取渠道六项凭据——**不进本快照面**，见下文「渠道凭据第二键空间」）/ **api-gateway**（客户端接入片起：`client.appEnabled`/`client.h5Enabled` 两端闸两键——**不进客户端面**，专供网关自己执法，§7.5）/ 客户端（金币场起可见子集扩到 7 键；**支付片起扩到 14 键**——+7 支付裸名；**广告片起扩到 15 键**——+`reliefAdpid` 裸名；**提现再认证片起扩到 16 键**——+`withdrawReAuthEnabled` 裸名；**记牌器片起扩到 17 键**——+`cardCounterEnabled` 裸名；**记牌器收费片起扩到 19 键**——+`cardCounterPricePerGameCoins`/`cardCounterPricePerHourCoins` 两裸名；**风控键全部不可见**，`CLIENT_CONFIG_KEYS` = 单一真源在 `protocol/src/config.ts`）。room-service 另自风控片起消费两谓词开关（§8.3），自台费并入片起收费块改为消费 `game.baseScoreLevels` 的 `entryFeePercent`（阶段 2 起旧费率键 `currency.entryFeePercents` 已删除，§6），自记牌器收费片起再消费 `game.cardCounterEnabled` + 两价格（开局状态块）；currency-service 自记牌器收费片起再消费 `game.cardCounterEnabled` + 两价格（购买端点）。
十个周期键的「热」口径 = 定时循环改 `setTimeout` **自重排**：**当前一轮按旧值跑完，其后按新值排下一轮**。

**读路径：缓存 + 推送 + 安全网**：每个消费服务启动拉全量快照进**进程内缓存**（失败 ⇒ 1s 退避重试直到首次成功，
**不阻塞服务就绪**）；订阅 `config:changed`（**专用 Redis 连接**）收到即重拉；另加**每 60s 安全网**无条件重拉 ——
🔴 **Redis pub/sub 无投递保证**（at-most-once，断线期消息永久丢失），安全网把最坏情况从「永久陈旧」压到「≤60s 陈旧」；
管理页文案据此写死「已保存（版本 N）；各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效）」。**写路径**：`PUT /api/admin/config/:key` → 校验 → 写库（version+1）→
`PUBLISH config:changed {keys}` → 返回 `{saved, announced, version}`；**publish 失败不拦写入**，但 `announced:false` + WARN 日志（「改了没生效」必须可见）。
⚠️ 两个**仅测试注入**的 env（`CONFIG_SYNC_SAFETY_NET_MS` / `CONFIG_SYNC_DISABLE_PUSH`，conformance 的变异开关）**生产不设**（compose 以 `${…:-}` 空默认透传 —— 不注入 ⇒ 空串，经消费侧 `||` 语义 = 未设 ⇒ 走代码默认），**不进 §2.3 表**。
**失败语义（分层）**：「拿不到」= **缓存为空且即时拉取也失败**；缓存非空（哪怕旧）一律用缓存 —— 热项 ⇒ **代码默认值** + WARN（**不得**因配置中心挂了停摆）；**底分档位保持 fail-closed**（⇒ `10007`，§4.3）。

**管理面（多账号 + 四角色 + 审计，③ 起）**：门口托管的静态页 `/admin`（账号登录）+ REST `/api/admin/*`（§7.1）。**启用谓词 = `admin_accounts` 表非空**（零账号 ⇒ 登录回 **404**「管理面未启用」—— **不用** `10007` 把「没开」伪装成「故障」）；账号来源 = **首启引导**（空表 + `ADMIN_PASSWORD` 非空 ⇒ `INSERT` 引导号 `admin`/`super_admin`）或 **hatch 复位 CLI**（容器内 `node packages/config-service/dist/admin-reset.js <username>`）；`ADMIN_PASSWORD` **只作首启引导**，账号建好后不再参与任何判定。口令哈希 = **scrypt**（存储 `s1$N$r$p$salt$hash`，默认 `N=2^17, r=8, p=1`，零新依赖；比较走 `crypto.timingSafeEqual`，常数时间）；登录成败（含 IP）落 `admin_login_events`。
四角色 **`super_admin` / `finance` / `operator` / `viewer`**：矩阵 = 网关 `admin-policy.ts` **显式枚举 P1–P9、按序首个命中** —— 账号写面 + `GET accounts` 超管 · 配置写 super_admin/operator · 钱包写（adjust/reverse/reconcile）super_admin/finance · 其余 GET 任意角色 · **未登记非 GET ⇒ 403 fail-closed**；⚠️ 管理页按角色显隐导航只是 **UI 门面**，服务端 policy 才是闸。
管理令牌 = JWT（独立密钥 `ADMIN_JWT_SECRET`，空串回落 `JWT_SECRET`；`aud:'ftl-admin'`、TTL **2h**；claims = `sub`/`username`/`role`，网关验签后按此校验），`Authorization: Bearer`（**非 cookie** ⇒ CSRF 不适用），浏览器存 `sessionStorage`。
网关两条缝：① 玩家验签对 `/api/admin/*` **整段跳过**（`isAdminPath()`，§7.1）；② **AdminAuth 中间件** —— **先剥**客户端伪造的**四枚**头（`X-Admin`/`X-Admin-Actor`/`X-Admin-Roles`/`X-Client-Ip`）→ `POST /api/admin/login` **恰好一条**豁免 → 验令牌（含 claims 校验）→ policy → 注入 `X-Admin: 1` + `X-Admin-Actor: <username>` + `X-Admin-Roles: <role>`（失败 401/403 **不注入**）；顺序在限流**之前**。
限流（网关，§5.4 同族）：登录按 IP **5 次/5 分钟**（**失败计次：401 与 403 都算、200 清零**；**桶达界 ⇒ 正确口令也 429**）+ 持令牌写（GET/HEAD/OPTIONS 之外全部计入）按令牌 **30 次/5 分钟**；无令牌/坏令牌在 AdminAuth 处立即 401、**不进任何限流维度**（显式登记接受）。
审计四源（管理面只读 + CSV 导出，BOM + 公式注入消毒）：`config_changes`（配置 old→new）· `admin_login_events`（登录成败 + IP）· `admin_account_changes`（建号/角色/停用启用/口令复位；actor = 操作者或 `cli`）· 钱包 `currency_ops`+`currency_flows`（流水/汇总/冲正，冲正 = 反向整笔 `admin_reverse`）。

**软依赖（与 mysql/redis 的硬依赖相对）**：消费服务对 config-service **刻意不加 `depends_on` 硬门** ——
其不健康**不得**拦消费服务的启动/重建（r2 实测：`service_healthy` 硬门会让 no-op `up -d` 都 exit 1）；启动错序由
「1s 退避重试 + 安全网」兜住（代价 = 已登记的短暂窗口）。**此条写进 compose 注释**；配置中心**自身**对 mysql/redis 照旧 `service_healthy`。

**多实例与持久性**：配置中心自身**单实例**；**消费侧读路径多实例安全**（每实例独立快照 + 广播 + 安全网 ⇒ 自洽）。
配置的**持久真源必须是 MySQL**（备份范围只含 MySQL；Redis 只做失效广播，不做存储）。

**渠道凭据第二键空间（支付配置管理化片，2026-10-06）**：支付渠道**六项凭据**（`pay.channel.gatewayUrl` · `appId` ·
`privateKey` · `publicKey` · `sellerId` · `publicBaseUrl`）从服务器 `.env` 搬进 config-service 的**独立表** ——
**结构性理由**：快照 = `platform_config` 全表（`config.snapshot` 原样返回）⇒ **独立表在代码路径上不可能**被任何
广播/快照带出（六键**不入** `CONFIG_KEYS`、不入 `platform_config`；业务键面（本片起 41 键；经客户端接入/机器人补位开关两片后共 **46**）零改动），下发只走专用拉取通道。

- **表**：`pay_channel_config`（迁移 `1792000000000-PayChannelConfig.ts`；`key` varchar(64) 主键 / **`value_enc` text = AES-256-GCM 密文** / `fingerprint` char(12) / `updated_at` datetime(3) / `updated_by`）。无种子（出厂 = 未配置 ⇒ 逐键回未配置语义）。
- **加密 / 指纹口径（at-rest）**：AES-256-GCM；每值 12B 随机 IV、**AAD = 键名**（防跨行互换）、tag 16B，`value_enc = 'v1:' + base64(iv|ct|tag)`；指纹 = `sha256(规范化值)[:12]`（hex）。**六项统一加密**（不区分机密与否——写/读单一代码路径，消灭「哪些列是明文」的判断面；机密标记只决定 UI/审计/日志语义）。密钥两键入库统一 **base64(PEM) 单行**（= 旧 env 格式，读侧零改）；管理面输入接受 **PEM 原文或 base64 两态**（服务端归一）。主钥 = env `PAY_CONFIG_ENC_KEY`（base64·解码后**恰 32B**；**只配 config-service**；未设/非法 ⇒ 渠道块 fail-closed：管理三端点 503 / RPC `{ok:false,10007}`，**其它面不受影响**——懒校验、不阻塞启动）。解密失败**响亮抛**（不静默丢行）。
- **专用拉取通道（RPC）**：`config.payChannel.get`（3106；§4.2 签名块 + §4.3 新边）—— 载荷携专用令牌 `PAY_CHANNEL_PULL_TOKEN`（**仅 config-service + payment-service 双持有**、常数时间比对；未设 ⇒ 拒一切拉取）；解密后**仅回已配置键**；**不进任何广播**。payment 侧**每渠道调用现拉** + 失败**整图回落**（§7.7）。
- **管理三端点**（网关转发 + policy 两处登记；缺一 404/403）：`GET /api/admin/pay-channel`（六项状态：非密键明文回显；**`privateKey` 的 `value` 恒 `null`、任何角色都读不回原文、只回指纹**）· `PUT /api/admin/pay-channel/:key`（写入 = 覆盖；空串 400、清空走 DELETE；六键白名单 + 服务端校验，坏值 400 不落库）· `DELETE /api/admin/pay-channel/:key`（清空 = 删行 ⇒ 回「未配置」语义；幂等）。管理页 = 顶栏「支付渠道」视图（`VIEW_ORDER` 第 2 位；**保存/清空控件仅 `super_admin` 渲染**）。
- **权限（E′，已裁）**：**写面（PUT/DELETE）仅 `super_admin`** —— 支付宝公钥 = 回调验签唯一信任锚，operator 可写 ⇒ 可自签伪造回调入账（评审 r1 实测，原「半公开」分类系误判）；读面（GET）任意已认证角色（页面读面扩 `finance`）。写面**单角色** ⇒ 「按键分权的 %-编码变体绕过」前提结构性不存在；**设计注记**：将来若对渠道写面再引入角色分权，必须同时引入按**键字面路由** + 变体负例。
- **审计（管理页第一页签）**：写/清空落 `config_changes`（**不是新源**）；**密键** old/new = `{"redacted":true,"fingerprint":"<12hex>"}`（**永不落**原文/base64/密文），非密键照现状落原文；无 schema 变更（CSV/JSON 读口不变）。**渠道写路径不得复用** `PlatformConfigService.set()`（防「顺手复用」把渠道值写进 `platform_config`/进广播）。
- **失败语义 / 回滚窗**：未配置（行缺失）⇒ 逐键回 §7.7 的逐键等价语义（`gatewayUrl` 缺 ⇒ 生产默认网关；其余多数 ⇒ `15001`；`sellerId` 缺 ⇒ 回调 `failure`）。上线顺序见手册「支付怎么上线（五步）」；**回滚窗** = 服务器 `.env` 六行**保留至首轮验收通过后**再删（回滚到旧 tag 仍可读 env）。

**通知通道键空间（通知通道管理化片，2026-10-07）**：邮件告警（SMTP 五项）与三个 IM 告警通道（webhook 四项）**九项凭据**从服务器 `.env` 搬进 config-service 的**第三个独立表** ——
与渠道键空间同构：**结构性不进广播**（九键**不入** `CONFIG_KEYS`/`platform_config`；业务键面（本片起 41 键；经客户端接入/机器人补位开关两片后共 **46**）零改动），下发只走专用拉取通道。

- **表**：`notify_channel_config`（迁移 `1793000000000-NotifyChannelConfig.ts`；`key` varchar(64) 主键 / **`value_enc` text = AES-256-GCM 密文** / `fingerprint` char(12) / `updated_at` datetime(3) / `updated_by`）。无种子（出厂 = 全未配置 = 与今天「通道全关」等价）。
- **九键（⚙️1 序）+ 密类**：`notify.smtp.host` / `notify.smtp.port` / `notify.smtp.user`（非密）· `notify.smtp.pass`（**密**：授权码）· `notify.email.to`（非密）· `notify.webhook.feishuUrl` / `wecomUrl` / `dingtalkUrl` / `dingtalkSecret`（**密** —— webhook URL 本身即凭据：token 在 query/路径里）。密键 `value` 恒 `null`（只写不可读、只回**指纹**）；三 URL 键另回 **`hint`**（读路径解密后现算，**全等**匹配三平台 allowlist `qyapi.weixin.qq.com` / `open.feishu.cn` / `oapi.dingtalk.com` ⇒ `origin`，否则「外部地址」——防仿冒变体与凭据片段回显；非存储列）。规范化**唯一变换 = trim**（URL 逐字保真、不改写）。
- **加密 / 指纹口径（at-rest）**：逐字复用（AES-256-GCM · 12B IV · AAD = 键名 · `v1:` 前缀 · `sha256[:12]` 指纹）；**主钥 = 复用 `PAY_CONFIG_ENC_KEY`**（已裁 Q2-A：同一 config-service/同一 `.env`/同一备份伞，域分离收益 ≈ 0 而用户少保管一枚密钥——名字债在案，空间中性名留待 rename）。主钥未设/解密失败 ⇒ 通知块 fail-closed：管理三端点 503 / RPC `{ok:false,10007}`；**与渠道块各自独立 fail-closed、互不牵连**（同钥下同时开、同时关）。解密失败**响亮抛**（不静默丢行）。
- **专用拉取通道（RPC）**：`config.notifyChannel.get`（3106；§4.2 签名块 + §4.3 新边）—— 载荷携专用令牌 `NOTIFY_CHANNEL_PULL_TOKEN`（**三持有**：config-service + alert-relay + am-renderer；常数时间比对；未设 ⇒ 拒一切拉取）；解密后**仅回已配置键**；**不进任何广播**。消费端（relay/renderer 非 Nest 服务）**30s 轮询**（常量钉死、不做 env 旋钮）+ 启动先拉一次、3000ms 超时、不重试、**不带 meta**（无 trace 基建；登记）；**为什么不是「每投递现拉」**：告警投递恰恰发生在事故时，链路对 config-service 的依赖必须无感 ⇒ 拉取只影响配置更新延迟（≤30s），绝不影响投递本身。
- **消费面（两处不相交）**：**alert-relay** = 拉后即裁（只保留 IM 四键，SMTP 五键进程内即弃、不落盘——收窄凭据持有面）→ 原子写 `/data/notify-config.json`（600，命名卷 `relay-data`；重启先读文件 ⇒ config-service 故障期间重启不丢通道）；钉钉 URL/加签密钥**须成对**（半配 ⇒ 该槽停用 + WARN）；**从未成功拉到 ⇒ `/webhook` 500**。**am-renderer**（alert-relay 同镜像第二入口，极小侧车）= 邮件五键**全在场** ⇒ 渲染完整 `alertmanager.yml`（值 = JSON 双引号标量，引号/反斜杠/换行全量安全）→ amtool 预检 → 原子写共享命名卷 `alertmanager-live`（AM 侧 `:ro`；renderer 65534 与 AM 同 UID）→ 内容变化时 `POST /-/reload`（原地重载；失败保住旧文件、下轮重试）；半配/全空 ⇒ 邮件段整段省略（= 今天全空形态）+ WARN。邮件仍由 AM **原生发出**（模板/路由/心跳零变化；邮件腿不依赖 relay 存活）。
- **管理三端点**（网关转发 + policy：PUT/DELETE 前缀 ⇒ `super_admin`，GET 落 P8）：`GET /api/admin/notify-channel`（九项状态：非密键明文回显；五密键 `value` 恒 `null` + 指纹 + URL `hint`）· `PUT .../:key`（写入 = 覆盖；空串 400、清空走 DELETE；九键白名单 + 服务端校验矩阵，坏值 400 不落库）· `DELETE .../:key`（清空 = 删行；幂等）。管理页 = 顶栏「通知通道」视图（`VIEW_ORDER` 第 3 位；分「邮件（SMTP）」5 行 +「IM 通道」4 行；**保存/清空控件仅 `super_admin` 渲染**；组尾完整性提示按缺项数**现算**）。平台取址/轮换/验收 = `docs/ops/notify-onboarding.md`。
- **审计（管理页第一页签）**：写/清空落 `config_changes`（**不是新源**；复用 `CONFIG_CHANGES_INSERT_SQL`）；**五密键** old/new = `{"redacted":true,"fingerprint":"<12hex>"}`（**永不落**原文/密文），四非密键照现状落原文；**渠道/通知写路径不得复用** `PlatformConfigService.set()`。
- **完整性 gauge / 规则**：`notify_config_keys_configured{group}` / `notify_config_group_complete{group}`（`group ∈ {email(5), dingtalk(2)}`；**写路径现算**——`set()/clear()` 事务成功后 + 启动各一次，`SELECT \`key\``只数行不解密；读失败 ⇒ 保持旧值 + WARN、不打穿`/metrics`）；规则 `NotifyEmailIncomplete`/`NotifyDingtalkIncomplete`（`group_complete==0 且 keys_configured>0`持续 10m ⇒ warning；路由照默认`all` ⇒ **IM 腿照达**——邮件腿挂了 IM 腿来报信）。
- **失败语义（等价表 + 两处显式偏离）**：邮件五键全空 ⇒ 邮件段省略（= 今天）；**邮件/钉钉半配 ⇒ 该段省略 / 槽停用 + WARN + gauge 0 + 规则**（🔴 取代旧「拒起」——AM 邮件半配拒起与 relay 钉钉半配拒起**双向退役**：拒起与「运行期动态配置」不相容，响亮性由 gauge/规则承接）；全空（**成功拉到的**空图）⇒ relay 200 no-op；**从未拉到 ⇒ 500**（未知 ≠ 成功）；生效时效：改 `.env` + 重建（分钟级）⇒ **管理页保存 ≤30s + reload**；at-rest：九键全加密落库、`.env` 不再承载（备份剥离主钥沿用支付片）；**新增两处容器内明文落点**（共享卷 yml 含口令（600、AM 侧只读）· relay `/data` 仅 IM 四键（600、按消费方裁剪）——命名卷、非宿主挂载，残余登记）。
- **生命周期**：**一次性导入**（服务器 `.env` 现役真值 ⇒ 管理页手工填，或服务器侧一行式脚本；值不离开服务器）；⚠️ **导入窗口** = 新镜像上线至导入完成的**数分钟**内通道「未配置」= 无投递（手顺钉死「**部署后立即导入**」，窗口内真出告警 = 丢一条，已登记）；**回滚窗** = 服务器 `.env` 九行**保留至验收通过后**再删；回滚**必须经 `deploy.sh`/`rollback.sh`** 全量换 tag（送机 compose 取自目标 tag ⇒ 九行 env 随旧 compose 回位；手工 `IMAGE_TAG=… docker compose up -d` 会拿新 compose（九行已删）**静默裸奔**）。**轮换** = 平台后台重发 webhook / 重开授权码 ⇒ 管理页覆盖 ⇒ ≤30s 生效、全程不重启容器（指纹变化可见）。上线顺序见手册「通知怎么上线（三步）」。

### 7.6 对局记录（我的历史战绩）`[已实现]`

> `[已实现]`（**记录片**，2026-10-03，分支 `feat/records`）：结算（`game.ended`）时把整局快照写入 user-service 的 MySQL；
> 「我的历史战绩」= **本人可见**的对局记录（REST 经网关；客户端零消息面变化 —— `game.settlement` 一字未动）。
> **权威**：规格 `docs/superpowers/specs/2026-10-03-records-spec.md`（v1.1）· 设计 `docs/superpowers/specs/2026-10-03-records-design.md`（v1.2）。

**数据（两表，user-service，迁移 `1789400000000-GameRecords.ts`，§10.3）**：
`game_records`（1 行/局；`UNIQUE uk_room_version (room_code, game_version)` = 幂等**硬闸**）+
`game_record_players`（3 行/局、按座位；`is_robot` 定死（P3 榜过滤复用）、`nickname` = 写入时**快照**（人类按 `user_id` 查 `users`；机器人取 room-service 分配的展示昵称，缺省 `NULL`；
**绝不写 displayId**）、`hand` CHAR(34) / `bottom_cards` CHAR(6) = **定长 hex**（54 张牌 1 字节/张；codec = `protocol/src/records.ts`））；
索引 `idx_user_ended (user_id, ended_at)` / `idx_ended_at` / `idx_record`。迁移 `migrationsRun: true` 容器启动即执行。

**写入链（RPC `record.write`，room → user，3101）**：`game.ended` 附 `record` 信封（§4.4；发牌快照 17×3 + 底牌 =
game-service 自 `initialHands` **冻结副本**编码；旧会话无快照 ⇒ **不附、绝不抛**）→ room-service 组装（`isRobot`/`userId`
真源 = 房间座位；`robotId` 真源 = `room:{code}:bots` **按座位号对齐**；昵称：人类由 user 侧按 `user_id` IN 查表快照，
机器人由 room 侧带 `seats[].nickname`（room-service 分配的展示昵称））→
**TCP 3101**（记录片重挂，§2.3/§4.2；超时 3s、**不重试** ⇒ 失败即丢该局 + error 日志 —— **已接受窗口**，§4.3 表 + 台账 **N49**）。
user 侧**事务**写 1+3 行（防「有记录无 players」孤儿）；重复投递命中 `(room_code, game_version)` ⇒ 比对 `ended_at`
（|差| > 60s ⇒ **error 日志**）并回 `written:false`（台账 **N51**）；写入与结算广播**解耦**（各自独立 try —— 记录失败
**绝不**阻断 `game.settlement`）。房键 TTL 窗口 / 形状不符 ⇒ **跳过 + WARN**（台账 **N50**）。

**读取面（`GET /api/records/mine`，经网关，JWT **只本人**）**：`WHERE user_id = X-User-Id` 等值写死；keyset
（`ended_at DESC, id DESC`；`nextCursor` = 服务端内部编码的**不透明字符串**，客户端原样回传）；`limit` 缺省 20 / 上限 100（clamp）；
**白名单 DTO**（递归恰好键集 = **唯一**机械防线 —— `isRobot`/`robotId`/`deviceId`/`userId` **永不出站**；机器人昵称
由 room-service 分配（缺省 `NULL` ⇒ 客户端回落「玩家{seat}」），与人类同列展示，**不暴露 `isRobot`**，§5.5 同族口径）。

**保留期与清理**：配置中心**第 10 键** `record.retentionDays`（§7.5；`1 ≤ n ≤ 3650`、默认 365）—— user-service
**自调度清理任务**（默认 1h 一轮 + 启动后 30s 首轮；每轮现读缓存；`LIMIT 1000` 批删两表 `ended_at` 越界行）。
**多实例登记：DELETE 幂等、per-实例读缓存、无需锁**（台账 **N52**）。记录在 MySQL ⇒ **在备份伞内**（§10.4）。

**客户端**：第 5 页「历史战绩」（`pages/history/history`；入口 = 大厅头像 → 页内弹层「历史战绩」）；列表倒序 +
`onReachBottom` 翻页 + 展开（三家明细 + 底牌，牌面**复用** `components/` 现成件）；模式标签写死 `random→「匹配」`、
`practice→「好友房」`（**禁**「练习」字样）。

---

### 7.7 payment-service（充值 / 退款 / 提现）`[已实现]`

> `[已实现]`（**支付片**，2026-10-06）：第 8 个 Nest 服务 —— HTTP **3007** / metrics **9007** / **零被调 RPC 面**
> （入口 = 网关 HTTP 与 edge 直连回调；出站 = 渠道 HTTPS + currency/config 的 TCP 客户端）。
> **权威**：计划 `docs/superpowers/plans/2026-10-05-payment.md` · 规格 `…/2026-10-05-payment-spec.md`（v1.1.6）·
> 设计 `…/2026-10-05-payment-design.md`（v1.1.2）；台账 **N65–N70**；上线手顺 = 手册「支付怎么上线（五步）」「提现打款手顺」。

**数据（五表，`migrations_payment`，迁移 `1791000000000-Payment.ts`）**：`payment_orders`（充值单；幂等复用 = 同用户同档未过期 `created` 单）·
`payment_refunds`（退款；`channel_out_request_no=refund_no`；`refunded` **保留槽** = 已退结构标记）·
`payment_withdrawals`（提现；`active_slot` 在途 UK 防并发双申）· `payment_notify_log`（**仅记验签通过**件）·
`payment_user_locks`（每用户行锁，资金动作串行化 —— 真库实测稳态 S→X 升级确定性死锁 1213 ⇒ **获取阶段有界重试**，规格 §3.6）。

**三条链路（资金动作统一模型：停留原位 / 同锚重试扫描 / claim 先行 / 回滚例外绝不误置终态）**：

- **充值**：下单（`trade.wap.pay`，金额快照）→ 收银台外链 → 回调（**唯一信任入口**：验签 + 四项校验（app_id/seller_id/trade_status/金额）；
  应答纯文本 `success`/`failure`）→ 入账 `currency.apply{actionId:'pay:<orderNo>', source:'recharge'}` ⇒ `credited`；
  补单（created 超 5 分钟 ⇒ `trade.query`）/ 过期关闭（含 close「已支付」分支 ⇒ 迟到重开 `late_reopen_at`）。
- **提现**：申请即冻结（锁内 cap 实时取数、`withdraw:<no>` 锚）→ `pending` → 审通过 `approved` → **人工打款 + 台账登记**（`voucher`；**未登记=未打款**）⇒ `paid`（确认不动钱）；
  驳回/超时 ⇒ `rolling_back` ⇒ `withdraw_rb:<no>` 回滚 ⇒ `rejected`/`timeout_rolled_back`。
- **退款**：申请即冻结（单已 `credited` + cap + 槽/占位全检）→ `refund:<no>` 锚 → 审 = **纯渠道动作**（`trade.refund`，`out_request_no` 幂等；退避 6 发；
  穷尽后未知 ⇒ `unknown:` 标记转扫描低频重放、72h 转人工）⇒ `refunded`（保留槽）；驳回 ⇒ `refund_rb:<no>` 回滚。

**分池（P3 落地）= 可离场额度 cap**：`cap = max(0, min(cap_raw, balance))`，cap_raw 按 6 源集合（`recharge`/`game_settle`/`refund_hold`/`refund_rollback`/`withdraw_hold`/`withdraw_rollback`）求和；
唯一实现点 = `currency.withdrawable.get`（§4.2 签名块）；**资金动作时刻锁内取数，禁缓存、禁只查一次**；RPC 失败 ⇒ fail-closed 拒申请。

**渠道凭据消费面（支付配置管理化片，2026-10-06）**：渠道六项凭据（网关地址 / APPID / 应用私钥 / 支付宝公钥 / 商户 PID / 站点基址）改由 config-service 的**专用拉取边** `config.payChannel.get` 下发（§7.5「渠道凭据第二键空间」）——**每渠道调用现拉**（1000ms 超时 / 不重试 / 带 `metaFromTrace`；§4.3 新边）、成功 = **整图替换**进程内缓存、失败 = **回落上次成功值** + WARN（从未成功 ⇒ 视同未配置）。六键「未配置 / 被清空」⇒ 与旧 env「空串」**逐字等价**：`gatewayUrl` 缺 ⇒ 生产默认网关；APPID / 两钥缺失 ⇒ `readConfig()` null ⇒ 下单 `15001`；`sellerId` 缺 ⇒ 回调 `failure`（**非** 15001）；站点基址缺 ⇒ 下单 `15001`。服务器 `.env` **不再承载**渠道六项（只剩两枚根信任锚 `PAY_CONFIG_ENC_KEY` / `PAY_CHANNEL_PULL_TOKEN`，§2.3；备份剥离与回滚窗见 §7.5 与手册）。

**管理面**：三读视图（订单/退款/提现，列表 + 详情 + CSV）+ 处置流水 `actions`（第四读口）+ 三写端点（退款审 / 提现审 / 提现确认打款）
—— policy **P-p1..p7**（读面显式枚举；写面 `super_admin|finance`）；审计**第六页签「支付处置」**。⚠️ **退款审批长挂**：渠道退避链在途最长 ~12.6 分钟，
网关 5s 上游超时 ⇒ 管理页收到 **503/10007**（服务端继续退避；刷新看重审由 15009 兜底）。

**客户端**：**第 6 页「钱包页」**（`pages/wallet/wallet`；入口 = 大厅钱包区；回跳识别 `?pay=<orderNo>`）；余额/可离场额度 + 充值（档位 → 收银台）+ 提现（预检 + 申请）+ 三 tab 记录；
两开关默认关 = **暗上线**（页面区块按开关显隐；入口保留）。App 形态 = `plus.runtime.openURL` 尽力唤起 / H5 直跳 / 唤起失败降级文案（设计 §11.4）。

**观测**：prometheus **恰 15 job**（14→15 = +`payment-service:9007`）+ 10 指标 + 5 告警 + `07-payment` 面板（六 → 七）+ **日自检**（`pay.reconcileIntervalMs` 配置键；
入账勾稽 + 锚勾稽 —— 钱的事故面第一道铃）。

---

## 8. 匹配系统

### 8.1 队列 `[已实现]`

> `[已实现]`（P8 复审：键 `match:queue:{mode}:{region}`（`match.service.ts:60-62`）、meta 五字段（`:140-148`）、5s 周期（`:95`）；O(n) 全量扫描是**规格自述的演进项**（§8.1 原文 + roadmap §4））
> ⚠️ **片规格 §2.4 订正**：键多一维 → `match:queue:{mode}:{baseScore}:{region}`；meta 多一字段 `baseScore`（6 字段）；
> 每轮扫描改为 `SCAN match:queue:*` 穷举（底分不是 room-service 知道的东西 ⇒ 不能按档位枚举）。

- 队列：Redis Sorted Set，键 `match:queue:{mode}:{baseScore}:{region}`（`region` 在 MVP 恒为 `global`；`baseScore` 来自 `room.match`）
- `member = playerId`，`score = enteredAt`（**入队时刻，用于保证先到先服务**）
- 元数据：Hash `match:meta:{playerId}`，字段 `mode` / `baseScore` / `region` / `enteredAt` / `latency` / `attempts`
- 扫描周期：**5 秒**
- `[演进项]` 当前扫描用 `ZRANGE 0 -1` 拉取**全队列**再切前 3 个，复杂度 O(n)。MVP 可接受（队列小），但队列规模上万时须改为分区或分批取出；性能优化见演进附录 §4。（§8.1 原文自述「MVP 可接受」，不是缺口 —— P8 复审确认实现与规格一致：`match.service.ts:218` 仍为 `ZRANGE 0 -1`、`:266` 仍是全量取出后切前 3。）

### 8.2 匹配流程

```
每 5 秒：
  1. 读取队列候选（按 enteredAt 升序）
  2. 随机选取 3 名候选   ← MVP 不引入 ELO
  3. 谓词判定 canFormTable(3人)（§8.3）
       ├─ 通过 → 不足 3 人时先过**可用性门禁**（§8.5；人已够 3 个则门禁不参与）：
       │           ├─ 能给（含问不到的 fail-open）⇒ 建房 → 申请机器人补位 → 调 game.start
       │           └─ 不能给 ⇒ 对「自己 30s 窗口已到点」的等待者判失败 ⇒ 12007（**不建房**；其余人留队）
       │         → 向每名玩家 emit room.matched { roomCode, seat } → 转 5
       └─ 不通过 → 记录【成对】失败标记 → 回队 → attempts+1 → 转 4
  4. attempts 超限 → 回退（§8.4）
  5. 写入 match:pending:{playerId} = { roomCode, seat }（供重连与补发查询；**片⑦ 起为一切开局写入**，见下）
     同座位同时写 reconnect:active 重连记录（服务端连接补推与 game.reconnect 的凭据；§6.6）
```

**匹配成功后的通知通路（此前缺失，必须按此实现）**

- 服务端向每名**人类**玩家 emit **`room.matched`**，载荷 `{ roomCode, seat }`（§6.3）；
- 同时写入 Redis `match:pending:{playerId}`（§10.1），以便客户端未收到推送时可通过 `game.reconnect` 或重连后的快照补回；**开局同时为该座位写 `reconnect:active` 重连记录**（服务端连接补推与 `game.reconnect` 的凭据；§6.6）。
  ⚠️ **片⑦ 订正（语义泛化）**：该写入已从「匹配成功」泛化为 **「一切 `RoomStartService.startRoom` 开局」**
  （手动房 / 好友房同样写；对每个人类座位写，R47 机器人不写）——否则好友房在
  「第三人 REST 占座 → WS 连接」的窗口里自动开局时，迟到者**无凭据可补回**（实测竞态）。
  同时连接建立时网关会**主动**读该键补推 `room.matched`（房态 `playing` 时另补 `game.deal` 视图，§6.6.1）；
- 玩家收到 `room.matched` 后即可 `room.join` 进入该房间，并开始接收 `game.*` 推送；
- **客户端在此之前不知道 `roomCode`**，因此不能用 `room.join` 的 ack 作为匹配结果的通知手段。

**MVP 不使用 ELO**：参考文档的 ELO 算法（K=32、窗口 `100+min(wait/10s,150)`、延迟差 <200ms）移入演进附录 §4。ELO 若将来引入，**只用于排序与扩窗，不承担排除职责**。

### 8.3 开局条件谓词（新增契约）`[已实现]`

> ✅ **风控片回填（2026-10-05）**：R53/R474 的「刻意不做」已被取代 —— `MatchPredicate` 类型 + `canFormTable` 纯函数**已落地**（`packages/room-service/src/match/predicates.ts`；风控片 T2 —— **本片即 R53 缺的那个「首个调用方」**）。原「未实现（0 命中）」与「空谓词集」的表述均随本片作废。
>
> ⚠️ **实现形（契约钉死，规格 §2.4-1）**：接口 `{ name: 'sameIp' | 'sameDevice'; allows: (a, b) => boolean }` —— 语义不变（`allows` 即下文 `boolean`；`true` = 允许同局），`name` 供指标标签（函数类型无法承载标签）。

谓词是**纯函数**，只做排除、不做打分，语义签名统一：

```ts
type MatchPredicate = (a: MatchTicket, b: MatchTicket) => boolean; // true = 允许同局
```

- `canFormTable(players, enabled)` = **所有两两组合**均通过**启用**的谓词（缺 `ip`/`deviceId` 数据 ⇒ fail-open 放行；机器人不参与判定）
- 谓词集（风控片起）：`sameDevice` / `sameIp` 两条 —— **逐条配置键控制、默认关**（第 18/19 键，§7.5；D4 暗上线，开启手顺见 `first-deploy.md`）。仅需 `maxPlayers === 3` 与模式一致；**仅作用于匹配路径**（好友房/手动房为「自选同局」，不做谓词判定）
- 扩展谓词（见演进附录 §4）：地理 500m、近期交手过（同 IP / 同设备指纹**已落地**，见上）

**谓词是成对的，不是「我对一个区间」。** 这一点决定了它无法用单一 score 表达：`canFormTable` 必须对 3 人做 3 次两两判定。斗地主只有 3 人，因此校验成本是常数级的 3 次比较，不需要图算法。

### 8.4 重试与回退（新增契约）`[部分实现]`

> ⚠️ **P8 复审（P12 裁决，R475）的余量**：标记保留 `[部分实现]` —— 缺**回退顺序①「扩大候选范围」（放宽 region / 等待窗口）未实现**（无放宽逻辑）。`match:rejected` 已由**风控片**转为**真写入**（TTL 5s、字典序、抽取时排除；§10.1）—— 原「MVP 不写入 ⇒ 不计缺口」的豁免随之失效，本片起由用例钉住；到点出口顺位同步订正（到点者**先并入正常抽取**，本轮未成组才走回退 ⇒ 实际链 = ②补机器人 → ③`12007`）。
>
> **为什么①「无实现」在此刻不是可修的缺陷（R475）**：候选范围由 `MATCH_REGIONS` 决定，而它的**当前值逐字是** `export const MATCH_REGIONS: readonly string[] = [DEFAULT_REGION] as const;`、`export const DEFAULT_REGION = 'global';`（`packages/room-service/src/match/match.service.ts:21,28`）⇒ **只有一个 region**，「放宽 region」**没有第二个 region 可放宽**（放宽等待窗口则与 §8.4 的 30s 补机器人出口冲突）。
> ⇒ **引入第二个 region 时，必须先补这一条**，否则 §8.4 的三级回退链在**第一跳**就是空的（②补机器人仍会兜住，但那让①形同虚设）。

**「随机凑人 → 判定 → 不合格扔回重试」是 MVP 的正确形态**，但必须带确定性出口，否则在密集场景下会死循环。

**为什么会死循环**：这条规则的**目的**是隔离串通玩家，而串通玩家**恰好地理聚集**（同宿舍、同网吧）。极端情形下（100 人同在一个 500m 半径内）**任何三人组合都违规，成功率为 0**，无上限重试即永久卡住。

规定：

| 项               | 规定                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 重试上限         | `attempts >= 10` 或等待超过 **60 秒**                                                                                   |
| 失败记忆         | 失败的**成对**组合写入 `match:rejected:{a}:{b}`，TTL **5 秒**，抽取时排除                                               |
| 回队时间戳       | **必须保留原始 `enteredAt`**，否则等待最久的玩家被反复降级到队尾而饥饿                                                  |
| 回退顺序（固定） | ① 扩大候选范围（放宽 region / 等待窗口）<br>② **补机器人**（机器人无地理位置，天然满足规则）<br>③ 返回 `12007` 告知玩家 |

**②是自然出口**：机器人无位置属性，因此「无合法三人局 → 补机器人」无需特殊设计即可成立。

**谓词集两条默认关，因此下表两条有各自的适用范围，必须区分**（谓词开启后：拒绝即成对写入失败记忆并回队重试）：

| 情形                                      | 规定                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **谓词失败**（`canFormTable` 返回 false） | 记**成对**失败标记 `match:rejected:{a}:{b}`（按字典序拼键，值 = 失败时刻，**TTL 5 秒**，抽取时排除）；回队；`attempts+1`；两端各记命中计数与指标。**风控片起此路径真实触发**——谓词默认关；开启后拒绝即走本行（写入方 = 匹配扫描器）；「记忆拒绝」（5s 内重复对）只 `attempts+1`、不重写记忆 |
| **人数不足**（谓词通过但候选 < 3）        | **等待窗口 30 秒**：自**最早入队者**的 `enteredAt` 起算，超过 30 秒仍未凑满 3 人 → **补机器人**开局。这是 MVP 的真实主路径                                                                                                                                                                  |
| 重试上限                                  | `attempts >= 10` 或等待超过 **60 秒** → 按下方三级回退                                                                                                                                                                                                                                      |

**回退顺序（固定）**：

① 扩大候选范围（放宽 region / 等待窗口）
② **补机器人**（机器人无地理位置，天然满足规则）
③ 返回 `12007` 告知玩家

🔴 **开关 OFF 且 DouZero 不可用（门禁答「不能给」，§8.5）⇒ 第 30s 直接走 ③**（`12007`「当前无匹配的玩家」）—— 不进入 ②。⚠️ 只管**匹配路径**：好友房 / 自动开局与已入座对局不受开关约束（用户裁决 14）。

实现上**不必在单次扫描内循环**：不合格者回队、等下一个 5s 周期再抽即可，逻辑更简单且天然限流。

### 8.5 与机器人的衔接

人数不足时由 room-service 通过 `robot.acquire`（§4.2）申请，**走正常入座路径**，补至 3 人。机器人**不计入谓词判定**（无位置属性）。

**可用性门禁（片②）**：补位**之前**先问一次 `robot.availability`（room → robot；超时 / 不重试 / fail-open 见 §4.3 表）。只在需要机器人的那一支生效（不足 3 人且 30s 窗口到点；人已够 3 个时**不参与**）：

- 开关 `robot.ruleFallback`（配置中心五十一键之一，§7.5；默认 `true`）**ON** ⇒ 恒「能给」（**不探测** DouZero）；
- 开关 **OFF** ⇒ robot-service 探 DouZero 的 `GET /health`（**1s 超时 / 缓存 5s**）并读模型清单：三档模型齐备才算「能给」；非 200 / 连接被拒 / **超时** / 缺任一档 ⇒ 「不能给」；
- 「不能给」⇒ 对「自己 30s 窗口已到点」的等待者判失败 ⇒ `12007`「当前无匹配的玩家」（§8.4 的 ③）；
- 🔴 **fail-open**：问不到（RPC 错 / 超时 / 缺字段 / 旧版不认识这个 pattern）**一律按「能给」**—— 只有明确的 `canProvide:false` 才触发失败路径；
- **范围 = 匹配路径**（用户裁决 14）：好友房 / 自动开局与已入座对局的补位**不装门禁**，保持现状。

---

## 9. 机器人系统

### 9.1 两条不可协商约束

1. **不可区分性**：机器人必须与人类玩家在**所有下发消息中**不可区分——不出现 `isRobot`、`botId`、`bot` 前缀。
2. **服务端驱动**：机器人的回合由服务端推进，**客户端不参与**。

> **2026-10-22（机器人拟人昵称片）**：机器人展示昵称由 room-service 分配并写入
> `room:{code}:nicknames`，`players[].nickname` 对机器人同样下发。此前「机器人恒无昵称 ⇒ 玩家N」
> 在人类昵称必填后反而成了机器人识别器；本片起机器人与人类同样显示名字。

`[已实现]`（**C8/C9 + §9.4 + A6/R136，切片 11 收口**）：两条约束都已满足 ——

- 机器人 ID **只有一套**（内部 `botId` 永不下发、对外 `displayId` 与人类同构；源码闸 `no-internal-id-outbound.test.ts`）；
- 机器人回合由 **game-service 服务端驱动**（`game.service.ts:477` 的 `driveRobotTurn`，调用点 `:185`/`:367`，决策走 TCP RPC `robot.client.ts:50`），**没有**任何浏览器驱动路径（`web/` 已随 `5be7522` 删除；`grep -rn "autoBidBots\|autoPlayBots\|bot\.move" apps/client/src packages/*/src` = 0 命中）。

### 9.2 机器人实例

见 §3.4。要点：`botId`（内部，永不下发）与 `displayId`（对外，与人类同构 `p_<8位>`）**分离**。

### 9.3 AI 策略 `[已实现]`

> `[已实现]`（**片② 全量化，2026-10-01**）：三档 = **三个 DouZero 模型**（`robot-service/src/robot/models.ts:8-12` 的 `MODEL_BY_SKILL`）；三档**一律**先问 DouZero、失败/非法才回退规则引擎（`bot.player.ts:74-94`）；比例与开关**片⑦ 起住配置中心**（键 `robot.skillDistribution` / `robot.ruleFallback` / `robot.modelBySkill`，§7.5）—— `robot-service/src/robot/config.ts` 与 `models.ts` 的默认表保留为**代码默认值（= 种子）**；可用性探测（1s 超时 / 缓存 5s）在 `douzero.health.ts:7-8`

| skillLevel   | 决策源（模型）                   | thinkingSpeed（基础手速） |
| ------------ | -------------------------------- | ------------------------- |
| beginner     | DouZero **`sl`**（监督学习基线） | 1000–3000 ms              |
| intermediate | DouZero **`douzero_WP`**         | 1000–3000 ms              |
| advanced     | DouZero **`douzero_ADP`**        | 1000–3000 ms              |

> 2026-10-17：思考速度与难度**解耦** —— 三档都从 1000–3000 ms 抽「基础手速」，每回合实际延迟 = 基础值 ± 300 ms（夹到 `[1000, 3000]`）。

- 规则引擎：`packages/shared/src/rule/autoplay.ts` 的 `findSmallestBeatingCards()`（14 种牌型全覆盖，已接上 `handlePlayTimeout` 与 robot-service 的规则回退链 —— E4 已在切片 11 关闭）
- DouZero：`robot-service` → `POST /decide_play` → `douzero:2021`，5s 超时（`douzero.client.ts:10`）`[已实现]`；请求带 `model`（`skillLevel` 逐档映射，见上表）。
- **降级链（三档同一形态）**：先问 DouZero —— ① 超时/HTTP 错/返回**不在手里的牌** ⇒ **回退规则引擎**（规则引擎也无解才 pass）；② 返回**空数组 ⇒ 明确 pass，不降级**（协议约定：「不出」是意图、**不是**失败）。
- 难度分布：默认 **`beginner 0.15` / `intermediate 0.35` / `advanced 0.5`**（⚠️ 相对旧默认 beginner 与 advanced **对调**），片⑦ 起由配置键 `robot.skillDistribution` 配置（§7.5）：**写入侧校验**（三档齐、各 ≥0、合计 >0，按总和归一化落库；非法 ⇒ 400 不落库）—— env 时代「非法即**启动**失败」的口径随之变为「**写入**失败」（默认值不变 ⇒ 既有行为不变）。

### 9.4 回合驱动（新增契约）`[已实现]`

> `[已实现]`（P8 复审：①-⑦ 全落地：`game.service.ts:477` `driveRobotTurn`、`:478-479` 重入闸、`:486-487` 行动者判定、`:528-553` 失败回退链、`:513-514` 延迟不顺延；测试 `game.robot.test.ts` 6 条 + conformance `slice-11` 三组）

**所有者：`game-service`**（状态机所有者，避免双向依赖）。

```
状态推进 → 当前行动者是机器人？
  ├─ 否 → 广播 game.current_turn
  └─ 是 → RPC robot.decide（携带 §9.5 的裁剪视图 + 公开特征 features）
            ├─ 成功且动作合法 → 应用动作（走与人类【完全相同】的校验链）
            ├─ 超时/失败      → 用规则引擎结果应用
            └─ 动作被规则拒绝 → 【必须回退规则引擎重决策】，不得直接 pass
          思考延迟：game-service 侧等待，不阻塞其他房间
```

**「当前行动者」的判定**：叫抢阶段是 `bidPhase.currentBidder`，出牌阶段是 `currentPlayer`（与玩法 §9.1 一致）。

- 机器人动作**同样计入状态转移与 `version`**，与人类玩家无差别。
- 机器人出牌的**合法性由 game-service 校验**，机器人服务不得绕过规则。
  ⚠️ 这不是理论问题：仓库内的 DouZero 引擎会产出玩法判为非法的动作（玩法 §11 末行），因此**拒绝后回退规则引擎**是必需路径。
- **思考延迟计入回合时限**：`turnDeadlineAt` 自回合开始时刻起算，**不因机器人思考而顺延**。⚠️ **机器人座位不参与挂机治理**（挂机治理片：机器人不计数、不托管）⇒ 机器人回合**恒按 normal 档（30 000 ms）**计时。`thinkingSpeed`（1000–3000 ms）与 `robot.decide` 的 5s 超时都发生在这 30s 之内，实现时必须保证三者之和（思考延迟 + RPC 超时 + 规则引擎兜底）显著小于 30000 ms——当前取值下最坏约 8s，安全。
- 三名机器人同桌时**串行处理**，各自的思考延迟依次等待；单回合总延迟上限仍受**机器人恒 normal 档**（30 000 ms）约束（人类座位的治理三档见玩法 §9.3：托管 2000 / 连续超时 10000 / 正常 30000）。
- 参考文档**完全未规定**这一环：其 §3.4 跨服务矩阵里没有 Game↔Robot 的动作边，§6.3 只有 `chooseCard()` 签名（返回类型 `PlayAction` 全文未定义），§6.5 只说「延迟模拟」却没说宿主是谁。

### 9.5 可见信息边界（新增契约）`[已实现]`

- 机器人只接收**与人类玩家完全相同的裁剪视图**：自己手牌 + 他人张数 + 上一手牌 + 已公开底牌。
- **禁止**把完整 `GameSession` 交给机器人服务。
  `[已实现]`（**S4/N20/R218**）：`acquire`/`release`/`decide` 三条收 `session` 的 HTTP 路由已**整条删除**（`robot-service/src/robot/robot.controller.ts:8-10` 的 docblock 逐字记着），`RobotDecideRequest` 只带 `{ roomCode, botId, skillLevel, view: PlayerView, features, meta? }`（`protocol/src/robot.ts:104-115` 的 `RobotDecideRequest`，无 `session`；行号随 A3 的 `RobotFeatures.lastMoveMeta` 插入而漂移过，定位请 grep 符号名）；机械闸 `packages/robot-service/test/no-session-boundary.test.ts:51-55` 断言源码里**不得出现** `session`。
- 为了让 DouZero 的 `played_cards_*` 与 `card_play_action_seq` 特征**真实**，`GameSession` 必须维护 `actionLog`（§3.2），并由 **game-service** 从 `actionLog` 派生出**仅含「已经打出过的牌」**的公开特征，随 `RobotDecideRequest.features` 下发（§4.2）。
  **`actionLog` 本身永不出站**；出站的是它的公开投影——已出的牌本就是全体可见信息，未出的手牌一律不可派生（§4.2 的「例外说明」）。
  `[已实现]`（**C8/R205**）：`computePlayedCards()` / `computeActionSeq()` / `getAllCards()` 三个伪造特征函数已**删除**（`bot.player.ts` 里 0 命中），特征改由 `shared/src/ddz/features.ts` 从 `actionLog` 派生；机械闸 `no-session-boundary.test.ts:44-49` 钉住「这三个函数不得复活」。

### 9.6 填充

**入座与绑定（此前缺失，必须按此实现）**

1. `room-service` 在开局前调 `robot.acquire({ roomCode, seats })`，`seats` 为**空缺座位号**；
2. `robot-service` 为每个空缺座位分配一个机器人，**在其返回的 `BotInstance` 中填好 `roomCode` 与 `seat`**（二者由 robot-service 写入，不是由调用方补）；难度（`skillLevel`）与基础手速（`personality.thinkingSpeed`）各自独立抽取，**只在「新绑定」上当场抽取**并随实例写回（`bot:{botId}`）—— 同一 `{roomCode, seat}` 的**幂等命中原样返回、不重抽**（`acquire` 失败重试 1 次的前提）；
3. `room-service` 按 `BotInstance.seat` 把机器人写入 `room:{code}:seats`（`Seat{ userId: displayId, seat, isRobot: true }`）与 `Room.players`；
4. `room-service` 调 `game.start`，在 `StartGameRequest.players[]` 中为该座位带上 `isRobot: true` 与 `botId`（§4.2）；
5. `game-service` 依据 `isRobot`/`botId` 判断机器人回合并调 `robot.decide`（§9.4）。

**归池（对局结束时）**

- 对局结束（收到 `game.ended`）后，`room-service` 调 `robot.release({ botIds })`，`robot-service` 把 `botId` 放回 `bot:pool:{gameType}` 并清空其 `roomCode`/`seat`；
- **兜底**：`bot:pool` 中的空闲机器人在 Redis 中带 `idleSince` 时间戳；若 `release` 丢失（room-service 崩溃），`robot-service` 的定期任务回收 `idleSince` 超过 **10 分钟**且 `roomCode` 指向的房间已不存在的机器人；
- 对局中机器人**不得**被回收。

### 9.7 经济（MVP 范围外）

MVP 不实现货币；机器人不计分，仅记录对局。虚拟经济隔离（`virtual_account_{robotId}`、初始 10000 分、补充阈值）见演进附录 §3。

### 9.8 不可区分性的验证手段 `[已实现]`

> ✅ **P12 收口（R476，沿用 P8 的 R399#6）：两条都已落地** —— ① `validateOutbound` 的 `FORBIDDEN_OUTBOUND_KEYS` 在**每一次** S→C 出站上运行期拦住 `isRobot`/`botId`/`skillLevel`/`thinkingSpeed`（+ 四层单测）；② R268 把「ESLint 规则」改判为**vitest 源码级闸**后，该性质由 `packages/robot-service/test/no-internal-id-outbound.test.ts` 机械钉住（自带正负对照，且断言 `displayId` 生成式必须是 `p_` 前缀）。
>
> **闸接在哪一阶段是裁决过的，不是遗漏**：该闸随 `turbo run test`（§13.4 的**阶段 4**）每次门禁都跑；**刻意不**再补一条 §12.4/阶段 6 的同性质闸（R399#6 / R476）—— 补它要同步改 conformance 的 `EXPECTED_GATES`（P7/R394 的教训），而**判据价值为零**（阶段 4 已覆盖同一性质）。交叉引用见 §12.4。

- 单测断言：**任何下发给客户端的消息中不得出现 `isRobot`、`botId`，或以 `bot` 为前缀的 ID**。
- ESLint 规则（与 §12.4 同一插件）：禁止在出站序列化路径中引用机器人标识字段。

---

## 10. 存储设计

### 10.1 Redis 键表

| 键                                        | 类型                                       | 所有者                                        | TTL                            | 内容                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `room:{code}`                             | **Hash**                                   | room-service                                  | 3600s                          | 房间元数据（`code`/`mode`/`gameType`/`baseScore`/`status`/`maxPlayers`/`createdAt`/`timeoutAt`；`gameType` 为多玩法新增，旧房缺省读 `doudizhu`）                                                                                                                                                                                                                                                                  |
| `room:{code}:seats`                       | **Hash**                                   | room-service                                  | 3600s                          | `field = seat` → `{ userId, isRobot }`                                                                                                                                                                                                                                                                                                                 |
| `game:session:{roomCode}`                 | **String(JSON)**                           | game-service                                  | 3600s                          | `GameSession` 全量（**真源**）                                                                                                                                                                                                                                                                                                                         |
| `match:queue:{mode}:{baseScore}:{region}` | Sorted Set                                 | room-service                                  | —                              | `member = playerId`，`score = enteredAt`（片规格 §2.4：底分那一维让**不同底分不同房**）                                                                                                                                                                                                                                                                |
| `match:meta:{playerId}`                   | Hash                                       | room-service                                  | 300s                           | `mode`/`baseScore`/`region`/`enteredAt`/`latency`/`attempts`                                                                                                                                                                                                                                                                                           |
| `match:rejected:{a}:{b}`                  | String                                     | room-service                                  | **5s**                         | 失败成对标记（`a`/`b` 按字典序排序后拼键；值 = 失败时刻 ms）。**风控片起真实写入**：谓词拒绝该对时由匹配扫描器写入、抽取时排除（记忆拒绝不重写；TTL 自然过期即恢复可配）                                                                                                                                                                               |
| `match:pending:{playerId}`                | Hash                                       | room-service                                  | 300s                           | `roomCode` / `seat` —— **一切开局**（`RoomStartService.startRoom`，为人类座位）写入；供客户端未收到 `room.matched` 时通过 `game.reconnect` **或连接建立时的网关补推**（`room.matched`；房态 `playing` 另补 `game.deal` 视图）补回（§8.2/§6.6.1）；**开局同时为该座位写 `reconnect:active` 重连记录**（服务端连接补推与 `game.reconnect` 的凭据；§6.6） |
| `reconnect:active`                        | Hash                                       | room-service                                  | —（**无 TTL**）                | `field = playerId` → `{ socketId, roomCode, connectedAt }`；写入者 = join / 开局 / `game.reconnect` / 断线观测 / 硬换手（§6.6.1）；仅 `room.leave` 清除                                                                                                                                                                                                |
| `ratelimit:{dimension}:{key}`             | **ZSET**                                   | gateway                                       | 窗口长度（**每次判定后重设**） | member = 请求时刻(ms)，score = 同一时刻；滑动窗口（§5.4）                                                                                                                                                                                                                                                                                              |
| `session:{jti}`                           | String                                     | user-service                                  | token 剩余有效期               | 令牌白名单                                                                                                                                                                                                                                                                                                                                             |
| `bot:pool:{gameType}`                     | **ZSET**                                   | robot-service                                 | —                              | member = `botId`，score = `idleSince`（空闲起始时刻），用于 §9.6 的兜底回收。**池 = 空闲集合**：绑定中的机器人 `ZREM` 出池                                                                                                                                                                                                                             |
| `bot:{botId}`                             | String(JSON) `BotInstance`                 | robot-service                                 | —                              | §3.4 的机器人实例（含 `roomCode`/`seat`/`skillLevel`/`displayName`…）。**机器人绑定状态的权威**；下面两个 `bot:*` 派生键都是它的**视图**                                                                                                                                                                                                               |
| `bot:room:{roomCode}`                     | **Hash**                                   | robot-service                                 | 3600s                          | `field = seat` → `botId`；`robot.acquire` 的**幂等索引**（同一 `{roomCode,seat}` 重复调用必须返回同一个 bot，A7⑤ 的重试以它为前提）。`bot:{botId}` 的视图                                                                                                                                                                                              |
| `bot:bound:{botId}`                       | String(JSON) `{ roomCode, seat, boundAt }` | robot-service                                 | 3600s                          | **绑定中**机器人的**反向索引**（N21）。存在的意义：池是**空闲**集合 ⇒ 绑定中的机器人**不在池里**，`ZRANGEBYSCORE` 扫不到，因此「`release` 丢失、机器人一直绑定」在**结构上**无法被发现。`bot:{botId}` 的视图                                                                                                                                           |
| `room:{code}:bots`                        | **Hash**                                   | room-service                                  | 3600s                          | `field = seat` → **内部** `botId`；局终 `robot.release({ botIds })` 需要内部 id，而 `room:{code}:seats` 存的是**对外** `displayId`（§9.2 不可区分性）⇒ 绑定关系必须另存一张                                                                                                                                                                            |
| `room:{code}:nicknames`                   | **Hash**                                   | room-service                                  | 3600s                          | `field = userId`（人类）/ `displayId`（机器人）→ 昵称；空串 = **已知无昵称**哨兵。机器人展示昵称由 `RoomStartService` 写入（2026-10-22 拟人昵称片），读侧 `buildRoomPlayers` 不区分人机                                                                                                                                                                     |
| `room:{code}:botnames:lock`               | **String**                                 | room-service                                  | **3s**                         | 机器人昵称分配短锁（`SET … EX 3 NX`）；只包住「读昵称 Hash → 分配 → HSETNX」；`deleteRoom` 不删它，靠 TTL 过期                                                                                                                                                                                                                                          |
| `game:events`                             | pub/sub 频道                               | game-service → room-service                   | —                              | 对局结束事件                                                                                                                                                                                                                                                                                                                                           |
| `config:changed`                          | pub/sub 频道                               | config-service → room-service / robot-service | —                              | **配置失效通知**（载荷 `{ keys }`）；消费侧收到即**重拉全量快照**（不做增量）；**丢消息由 60s 安全网兜底**（§7.5）                                                                                                                                                                                                                                     |

> `[已实现]` 上表的键**全部落地**（逐条关闭记录见 `deviation-ledger.md`）：
> `room:{code}` 已是 **Hash**（N9，独立小片 P3）· `room:{code}:seats` 是座位**唯一真源**（C11）·
> `ratelimit:*` / `session:*`（S6/S7）· `bot:pool:*` + 三个 `bot:*` 派生键（E9/N21）。
>
> **派生键的从属关系（读这一节时最要紧的一条）**：`bot:{botId}` 是绑定状态的**权威**；
> `bot:room:{roomCode}`（按房间看）与 `bot:bound:{botId}`（按机器人看）都是它的**视图**，
> 是**同一事实在两个维度上的投影**。任何「机器人是否绑定 / 绑在哪个座位」的判定
> **必须**读 `bot:{botId}`；视图与权威不一致时**以权威为准**并清掉坏视图
> （`reclaimIdle` 的交叉核对即此，见 N21）。**不要把任一派生键当成第二个真源。**

### 10.2 原子性与并发（新增契约）

| 操作          | 要求                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 玩家入座      | **必须原子**：`HSETNX room:{code}:seats {seat}` + 校验 `HLEN <= 3`；或用 Lua 脚本一次完成「检查人数 + 占座」。**禁止 `GET` → 改 → `SET`**                 |
| 对局状态推进  | `game:session:{roomCode}` 为整体状态机，**用 `version` 做乐观锁**：写入前校验 Redis 中的 `version === 期望值`，不符则重读重算（Lua CAS 或 `WATCH/MULTI`） |
| 房间/对局归属 | 单个 `roomCode` 在任一时刻**只由一个 game-service 实例推进**。MVP 为单实例部署，天然满足；多实例时按 `roomCode` 哈希分片并加分布式锁（演进附录 §5）       |
| 队列出队      | 从 ZSet 取出后立即 `ZREM`，避免两个扫描周期重复匹配同一玩家                                                                                               |

### 10.3 MySQL

- `users` 表（user-service，§7.2）。
- `platform_config` 表（config-service，§7.5）：**五十一键**配置的**持久真源**（含每键 `version` 单调列）；迁移表名独立（`migrations_config`，防与 user-service 共写同名 `migrations`）。
- `pay_channel_config` 表（config-service，§7.5「渠道凭据第二键空间」）：支付渠道**六项凭据**的**加密存储**（`key` 主键 / **`value_enc` = AES-256-GCM 密文**（`v1:` 前缀）/ `fingerprint` = 明文规范化值的 `sha256[:12]` / `updated_at` / `updated_by`；迁移 `1792000000000-PayChannelConfig.ts`）。**独立于** `platform_config` —— 结构上不进广播快照；密文列只有 config-service 的主钥能解（§7.5）。
- `notify_channel_config` 表（config-service，§7.5「通知通道键空间」）：通知**九键**（邮件五 + IM 四）的**加密存储**（形状逐字同 `pay_channel_config`：`key` 主键 / **`value_enc` = AES-256-GCM 密文**（`v1:` 前缀）/ `fingerprint` = 明文规范化值的 `sha256[:12]` / `updated_at` / `updated_by`；迁移 `1793000000000-NotifyChannelConfig.ts`）。**独立于** `platform_config` —— 结构上不进广播快照；密文列由 config-service 的主钥（复用 `PAY_CONFIG_ENC_KEY`）解密（§7.5）。
- `game_records` / `game_record_players` 表（user-service，§7.6）：对局记录（迁移 `1789400000000-GameRecords.ts`；唯一键 `(room_code, game_version)`；保留期 = `record.retentionDays`，清理任务见 §7.6）。
- `base_score_levels` 表：**已在迁移 `1789300000000-DropBaseScoreLevels.ts` 中删除**（片⑦ 收编 + 债务清理批；台账 N47 已关闭）—— 底分档位已收编进 `platform_config` 的 `game.baseScoreLevels` 键，旧表自 T13（`0da4448`）起**零读者**；建表迁移 `1789100000000-BaseScoreLevels.ts` 与其测试**保留**（历史可重放：新库 = 建表 → 删表 → 终态无表；`down()` 即逆，重建空表结构）。部署即执行（`migrationsRun: true`）。
- ~~`synchronize: true` **仅限开发环境**~~ ⇒ **已按本条收口（E7，独立小片 P3）**：`synchronize: false`，改由 `src/migrations/` 的**显式迁移**建表，并以 `migrationsRun: true` **在服务启动时自动执行**（用户裁决 R248）。连接选项集中在 `database.config.ts`，运行期与 TypeORM CLI 共用同一份 ⇒ 不存在两处漂移。

### 10.4 数据生命周期

| 数据                                                     | 保留                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 房间与对局状态                                           | TTL 3600s（对局结束后可提前删除）                                                              |
| 重连记录                                                 | 无 TTL（显式离开清理）                                                                         |
| 失败成对标记                                             | 5s                                                                                             |
| 匹配元数据                                               | 300s                                                                                           |
| 访问令牌白名单                                           | token 剩余有效期                                                                               |
| 对局记录（`game_records` / `game_record_players`，§7.6） | `record.retentionDays` 天（默认 365）—— MySQL 无 TTL ⇒ **自建清理任务**（`ended_at` 越界批删） |

---

## 11. 错误码

### 11.1 编码规则

**5 位数字，按服务分段**：

| 段      | 域                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1xxxx` | 通用                                                                                                                                                                  |
| `11xxx` | 用户                                                                                                                                                                  |
| `12xxx` | 房间 / 匹配                                                                                                                                                           |
| `13xxx` | 游戏                                                                                                                                                                  |
| `14xxx` | 货币（**货币核心片起启用 14001/14002；金币场片起加 14003/14004；记牌器收费片起加 14008–14010**；**14006/14007 收编为提现超时回滚的「记录行态提示」——非错误码路径**〔支付片，规格 §2.8〕；其余预留） |
| `15xxx` | 支付（**支付片起启用 15001–15009**）                                                                                                                                  |
| `16xxx` | 风控（MVP 不用，保留）                                                                                                                                                |
| `17xxx` | 版本控制（**MVP 未使用**，为客户端强制更新与协议版本兼容保留，见 `docs/appendix/platform-roadmap.md` §5）                                                             |

统一响应形态：

- **HTTP**：`{ "code": 13004, "message": "...", "data": null }` + 对应 HTTP 状态码
- **WS ack**：`{ "code": 13004, "message": "..." }`
- `code: 0` 表示成功

### 11.2 MVP 错误码表

| code | 含义 | HTTP | 引入 |
|------|------|------|------|
| `0` | 成功 | 200 | 既有 |
| `10001` | 参数错误 | 400 | 既有 |
| `10002` | 未登录 | 401 | 既有 |
| `10003` | 权限不足 | 403 | 既有 |
| `10004` | Token 已过期 | 401 | 既有 |
| `10005` | Token 签名无效 | 401 | 既有 |
| `10006` | 请求频率超限 | 429 | 既有 |
| **`10007`** | **下游服务不可用** | 503 | **MVP 新增** |
| **`10008`** | **客户端接入已暂停**（该端被管理端暂停服务；网关端闸在验签前拒绝——**拦新不踢旧**：挡新请求/新连接，不主动断开已建立的连接） | 403 | **客户端接入片新增**（`CLIENT_DISABLED`；客户端处置 = 提示（既有 `TOAST`），文案真源 = `net/copy.ts`（10008 条目）；服务端 `message`「当前客户端已暂停服务」仅供调试/兜底） |
| `11001` | 手机号已注册 | 409 | 既有 |
| `11002` | 密码错误 | 401 | 既有 |
| `11003` | 账号已被封禁 | 403 | 既有 |
| `11004` | 用户不存在 | 404 | 既有 |
| `11005` | 账号已绑定其他设备 | 403 | 设备绑定 |
| `12001` | 房间不存在 | 404 | 既有 |
| `12002` | 房间已满 | 409 | 既有 |
| `12003` | 不在你的回合 | 403 | 既有 |
| `12004` | 你不在该房间中 | 403 | 既有 |
| `12005` | 踢人权限不足 | 403 | 既有 |
| `12006` | **好友房暂未开放**（好友房开关关闭时拒绝**创建与加入**；§7.5） | 400 | 既有 |
| **`12007`** | **匹配超时（无法凑齐合法对局）** | 408 | **MVP 新增** |
| **`12008`** | **房间已开局** | 409 | **MVP 新增** |
| **`12009`** | **已在匹配队列中** | 409 | **MVP 新增**（与 `12007`「匹配超时」区分） |
| **`12010`** | **该场次暂未开放**（场次开关关闭时 `room.match` 拒绝；好友房仍走 `12006`） | 400 | **金币场新增**（`ROOM_MODE_DISABLED`；客户端处置 = 提示（既有 `TOAST`），文案走 `message`） |
| **`12011`** | **在局或房间中**（在局/在房者请求 `room.match` 被守卫拒绝；等待房/对局中共用；message = `You are still in an active game`） | 409 | **匹配守卫新增**（`ALREADY_IN_GAME`；客户端处置 = 提示（既有 `TOAST`），文案真源 = action-copy（12011 条目）；`message` 供旧客户端兜底） |
| **`12012`** | **玩法未开放/人数不支持/客户端与房间玩法不符**（多玩法片新增；由 room-service 在 match/建房/join 产出） | 400 | **`GAME_UNAVAILABLE`**；客户端处置 = 提示（`TOAST`），文案区分三种原因 |
| `13001` | 操作非法 | 400 | 既有 |
| `13004` | 状态冲突（版本不一致） | 409 | 既有 |
| `13005` | 游戏已结束无法操作 | 409 | 既有 |
| `13006` | 出牌不合法 | 400 | 既有 |
| `13007` | 超出操作时间限制 | 408 | 既有。**保留不用** —— 玩法 §9 规定超时是服务端**内部自动行为**，不向客户端返回错误码。仅当将来实现「客户端主动提交超时」时才启用 |
| **`13008`** | **机器人决策超时** | — | **MVP 新增。内部事件码**：由 game-service 记录日志与指标，**不作为任何响应码返回客户端** |
| **`13009`** | **对局尚未开始** | 409 | **MVP 新增。**触发点：`state === 'init'` 时收到 `game.play`/`game.pass` |
| **`13010`** | **没有任何可恢复凭据**（无记录、无匹配票、或房间已回收） | 404 | **MVP 新增。**触发点：§6.6 的 `game.reconnect` |
| **`14001`** | **余额不足**（`currency.apply` 整批回滚——管理员调整也不允许扣成负数） | 409 | **货币核心新增**（`E_INSUFFICIENT_FUNDS`；客户端处置 = 提示（既有 `TOAST`，不新增行为值），文案走 `message`） |
| **`14002`** | **操作冲突**（同 actionId 不同载荷——「同 id 不同内容」永远是人祸，拒绝并响亮报错） | 409 | **货币核心新增**（`E_ACTION_CONFLICT`；客户端处置 = 同上 `TOAST`） |
| **`14003`** | **金币不足（入场门槛）**（金币场匹配要求 `balance ≥ baseScore × entryMultiplier`） | 409 | **金币场新增**（`E_ENTRY_THRESHOLD`；`TOAST`；文案含所需金额） |
| **`14004`** | **救助不可用**（开关关闭 / 余额充足 / 判定不过） | 409 | **金币场新增**（`E_RELIEF_UNAVAILABLE`；`TOAST`；两文案见规格 ⚙️9） |
| **`14008`** | **记牌器未开放**（总开关关 / 商品价 0；无配置快照走 10007） | 409 | **记牌器收费片新增**（`E_CARD_COUNTER_UNAVAILABLE`；`TOAST`；文案走 `message`） |
| **`14009`** | **记牌器价格已更新**（玩家确认价 ≠ 服务端当前价） | 409 | **记牌器收费片新增**（`E_CARD_COUNTER_PRICE_CHANGED`；`TOAST`；客户端刷新后重新确认） |
| **`14010`** | **记牌器请求号冲突**（同一 requestId 异 kind/hours） | 409 | **记牌器收费片新增**（`E_CARD_COUNTER_REQUEST_CONFLICT`；`TOAST`；换新请求号重试） |
| **`15001`** | **支付渠道暂时不可用**（渠道调用失败：下单 / 查询 / 密钥或基址缺失等；可重试提示） | 502 | **支付片新增**（`PAY_CHANNEL_ERROR`；`TOAST`，文案走 `message`） |
| **`15002`** | **订单不存在或已失效**（含**非本人**——同为不可见语义） | 404 | **支付片新增**（`PAY_ORDER_NOT_FOUND`；`TOAST`） |
| **`15003`** | **提现暂不可用**（开关关 / 已有在途 / 低于门槛 / 有处理中申请 / 服务暂时不可用——**message 区分**） | 409 | **支付片新增**（`PAY_WITHDRAW_UNAVAILABLE`；`TOAST`；文案五变体规格 §2.8） |
| **`15004`** | **超出限额**（单笔 / 单日——message 区分；归日按 **+08:00** 自然日） | 409 | **支付片新增**（`PAY_WITHDRAW_LIMIT`；`TOAST`） |
| **`15005`** | **可提余额不足**（**可离场额度 cap** 分池面，§7.7） | 409 | **支付片新增**（`PAY_WITHDRAWABLE_INSUFFICIENT`；`TOAST`） |
| **`15006`** | **该笔充值暂不可退**（未入账 / 处理中 / 已退过 / 超出可退额度 / 变体——message 区分） | 409 | **支付片新增**（`PAY_REFUND_UNAVAILABLE`；`TOAST`） |
| **`15007`** | **回调验签失败** | — | **支付片新增。内部事件码**（`PAY_NOTIFY_VERIFY_FAILED`）：只日志 + 指标，**不作任何响应码**；入 `RESERVED_CODES`、`CLIENT_ACTION` 穷尽表补 `IGNORE`（照 `13008` 先例） |
| **`15008`** | **充值暂未开放**（充值开关关——只挡**新建单**） | 409 | **支付片新增**（`PAY_DISABLED`；`TOAST`） |
| **`15009`** | **状态已变更**（管理写面源态冲突；message 含**当前态与合法动作**） | 409 | **支付片新增**（`PAY_STATE_CONFLICT`；`TOAST`；管理面专用） |

> `12007`（匹配超时）的**玩家可见文案**（「当前无匹配的玩家」）真源在**客户端文案表** `apps/client/src/net/action-copy.ts`（`MATCH_TIMEOUT`）—— 本表「含义」列是服务端语义；`message` 字段按 §6.2 **仅供调试**，客户端不得据此分支。
>
> `11003`（封禁）的**玩家可见文案**（风控片 K1：`'该账号已被封禁，如有异议请联系客服'`）真源在**客户端文案表** `apps/client/src/net/copy.ts`（`USER_BANNED`）—— 口径同 `12007`；**申诉流程不做**（封禁解除 = 管理端人工 `unban`），「联系客服」是玩家侧唯一指引。

### 11.3 废弃说明

| code    | 原含义                   | 处置                                                                                        |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `13002` | 消息重复（seq 号冲突）   | **废弃**。由 `13004` 吸收：无法区分「重复送达」与「基于旧状态的新动作」，两者均返回 `13004` |
| `13003` | 消息过期（seq 号不连续） | **删除**。只保留状态游标后该语义不存在                                                      |

### 11.4 与旧字符串码的别名映射

`docs/design.md` v1.0 定义的字符串错误码统一映射为数字码，代码中不得再新增字符串码：

| 旧字符串码                       | 新数字码                                          |
| -------------------------------- | ------------------------------------------------- |
| `AUTH_REQUIRED`                  | `10002`                                           |
| `AUTH_INVALID`                   | `10005`                                           |
| `USER_NOT_FOUND`                 | `11004`                                           |
| `USER_BANNED`                    | `11003`                                           |
| `ROOM_NOT_FOUND`                 | `12001`                                           |
| `ROOM_FULL`                      | `12002`                                           |
| `RATE_LIMITED` / `RATE_LIMIT_WS` | `10006`                                           |
| `SERVICE_UNAVAILABLE`            | `10007`                                           |
| `GAME_ALREADY_STARTING`          | `12008`                                           |
| `GAME_NOT_STARTED`               | `13009`（~~原映射到 `13005`，语义相反，已修正~~） |
| `INVALID_ACTION`                 | `13001`                                           |
| `ACTION_NOT_YOUR_TURN`           | `12003`                                           |
| `INVALID_CARDS`                  | `13006`                                           |
| `DUPLICATE_SEQ`                  | `13004`（原 `13002`）                             |
| `GAME_STATE_MISMATCH`            | `13004`                                           |
| `BOT_DECISION_TIMEOUT`           | `13008`（内部）                                   |
| `PLAYER_DISCONNECTED`            | **不是错误码**，是 WebSocket 关闭码 `440`，保留   |

`[已实现]`（**切片 2 + R31**）：§11.2 的码全部落在 `packages/protocol/src/errors.ts:12-50` 的 `ErrCode` 枚举里，生产代码用 `ErrCode.*` 引用（179 处 / 27 文件），**没有**字符串错误码。⚠️ 唯一残留的字面量是 `api-gateway/src/gateway/proxy.gateway.ts:282` 的 `{ code: 10007, … }`（数值、值正确，只是没写常量名）。

---

## 12. 前端约束

### 12.1 哑终端原则（强制）

> **前端是游戏的哑终端（Dumb Terminal）—— 所有游戏规则、合法性校验、胜负判定、货币结算均在服务端完成。**
> 该原则是反作弊、合规审查（赌博法规要求服务端权威）和跨平台一致性的基础。**违反以下约束的代码禁止合入主干。**

原文出处：参考文档 §4.8.1。本文完全采纳，并把「违反者禁止合入主干」作为硬性要求。

### 12.2 FORBIDDEN 清单

| #   | 禁止行为                               | 替代                                            |
| --- | -------------------------------------- | ----------------------------------------------- |
| F01 | 客户端验证出牌合法性（牌型、能否压过） | 发送原始操作，由服务端校验                      |
| F02 | 客户端计算输赢或分数变化               | 接收 `game.finished` / `game.settlement`        |
| F03 | 客户端本地缓存状态用于决策             | 以服务端 `state_update` 为准，仅用于渲染        |
| F04 | 客户端存储或展示未经服务端确认的余额   | 仅展示服务端推送值（MVP 无余额）                |
| F05 | 客户端执行匹配逻辑                     | 匹配完全在服务端                                |
| F06 | 客户端用本地时间判断游戏规则           | 使用服务端时间戳与超时                          |
| F07 | 客户端预判或提前提交操作               | 收到 `game.current_turn` 且轮到本座后才允许交互 |
| F08 | 客户端缓存 WS 消息历史并回放           | 重连由服务端返回裁剪快照                        |
| F09 | 客户端构造支付参数                     | 不适用（MVP 无支付）                            |
| F10 | 客户端比较两家手牌/牌型强度            | 服务端推送已计算的公开信息                      |

### 12.3 MANDATORY 清单

| #   | 强制行为                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | 每次请求携带 `timestamp`；服务端校验 `\|clientTs − serverTs\| < 5000ms`                                                                                                                                                                                                                                                             |
| M02 | 以服务端状态为准；**快照类**消息（`game.deal`/`game.state_update`/`game.reconnect` 的 ack）`version === currentVersion` 时丢弃、`version < currentVersion` 时按 M08 重连。**事件类消息不适用本条**（见 §6.2「同一版本的多条推送」）                                                                                                 |
| M03 | 重连携带 `lastVersion`：`emit('game.reconnect', { lastVersion })`                                                                                                                                                                                                                                                                   |
| M04 | 余额仅在服务端确认后更新（MVP 无余额）                                                                                                                                                                                                                                                                                              |
| M05 | 用户操作记录本地日志（`reqId` / `version` / 动作），用于审计                                                                                                                                                                                                                                                                        |
| M06 | 操作后进入 loading 态，收到 ack 或 `state_update` 后才允许下一次操作                                                                                                                                                                                                                                                                |
| M07 | 收到 `game.finished` 后才结束本局 UI，禁止提前显示结果                                                                                                                                                                                                                                                                              |
| M08 | **快照类消息**（`game.deal`/`game.state_update`/`game.reconnect`）出现 `version` **回退**（小于已应用的版本）→ 主动重连，不尝试本地修复。注意：动作请求被拒返回 `13004` **不属于**此类，按 §6.5 就地刷新快照即可。**⚠️ 比较集限于同一局**（§6.2 的 v4.3 澄清）：换房间即换局，客户端必须复位 `currentVersion`，跨局比较**不是**回退 |
| M09 | 前端**禁止包含任何游戏规则常量**（如底分、倍数），配置由服务端下发                                                                                                                                                                                                                                                                  |
| M10 | 前端不包含任何货币计算逻辑（MVP 无货币）                                                                                                                                                                                                                                                                                            |

> M03 由参考文档的 `{ lastSeq, lastVersion }` 改为 `{ lastVersion }`：`seq` 已删除（§6.2）。

### 12.4 违规检测 `[已实现·形态已裁决]`

**规格面（必须被机械拦住的性质）**：

- 至少覆盖三类 FORBIDDEN：
  - `no-client-game-rules`：禁止调用名含 `isValid` / `checkRule` / `calculateWin` / `findBeating` / `parseHand` 的函数
  - `no-client-game-constants`：禁止声明含底分、倍数、牌型的字面量
  - `no-robot-identity-in-outbound`：禁止在任何出站序列化路径中引用 `isRobot` / `botId` / `skillLevel`（§9.8）
- **CI 流水线扫到 FORBIDDEN 调用即阻断合并。**

**实际落地形态（P5 裁决 R268 / R150 / R225）—— 以既有的 vitest 源码级闸为准，不照搬 ESLint 插件。**
本文原先写的是「ESLint 自定义插件 `eslint-plugin-zero-business-logic`」；那个插件名来自**参考文档**，
而本仓既有的落地形态是**源码静态扫描测试**。裁决：**以既有闸为准**，理由与 R150/R225 同族 ——
**判据要钉「违规被拦住」这个性质，不是钉 `ESLint` 这个形态**；再写一个插件等于为同一性质造
**第二个真源**（本仓为「第二真源」付过多次代价）。两者不冲突：ESLint 插件若将来要做，是加固而非替换。

CI 第 6 阶段（`eslint-forbidden`，名字逐字保留规格的）实际跑的**六条**源码级闸：

| 闸                             | 位置                                                          | 覆盖的 FORBIDDEN                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-boundary`              | `apps/client/test/source-boundary.test.ts`                    | F01/F02/F10 + M09（**规则判断只允许从 `@fight-the-landlord/protocol` 导入**——2026-10-12 项 ⑤ 起 `parseHand`/`canBeat`/`HandType` 用于出牌提示属**放行形态**；2026-10-22 U5-4 起同一组函数也可用于**音效选择**（牌型播报），仍只做选择、不做合法性/胜负判断；一切**本地实现**规则仍禁；无牌型/倍数/底分常量、无自制点数映射、无应用层 `ping`/`pong`） |
| `no-internal-http.gate`        | `packages/room-service/test/no-internal-http.gate.test.ts`    | §4.2：内部调用不得再走 HTTP（架构不变式）                                                                                                                                                                                                             |
| `outbound-timeout.gate`        | `packages/api-gateway/test/outbound-timeout.gate.test.ts`     | §4.3：每处出站调用必须带超时                                                                                                                                                                                                                          |
| `no-route-outside-api.gate`    | `packages/api-gateway/test/no-route-outside-api.gate.test.ts` | §7.1：`/api` 之外不得注册处理器（绕过验签）                                                                                                                                                                                                           |
| `rule-error-mapping`           | `packages/game-service/test/rule-error-mapping.test.ts`       | §11.2/玩法 §11.1：规则错误逐因映射可枚举且与规格逐行对账                                                                                                                                                                                              |
| `no-legacy-message-names.gate` | `packages/shared/test/no-legacy-message-names.gate.test.ts`   | §6.1/§6.2/§6.3（P7/R361）：`packages/shared/src` 不得出现应用层 `'ping'`、`seq` 或已废除的旧消息名 —— 防「遗留第二契约」在 `shared` 里复活                                                                                                            |

⚠️ 第 6 阶段**不是**裸调用：`scripts/ci.sh` 每条闸都断言 `Tests N passed` 且 **N ≥ 1**
（R291）—— 过滤名与文件名脱节时 vitest 会「0 用例而退出码 0」，那正是本仓两次「判据恒绿」的形态
（`allFilesStillHttp`、`NOT_YET_MIGRATED`）。每条闸自身都带**探针判别力自证**（R115/R150）；
`no-legacy-message-names.gate` 的自证是**逐个**禁止名各注入一次（R377：清单里的死条目会让「零命中」变成假绿）。

**⚠️ 三类 FORBIDDEN 与上表的对应（R476 交叉引用，2026-09-17 P12）**：上表**六条**覆盖 `no-client-game-rules` /
`no-client-game-constants`（`source-boundary`）与各架构不变式；**第三类 `no-robot-identity-in-outbound`（§9.8）不在阶段 6** ——
它由**阶段 4** 的 `packages/robot-service/test/no-internal-id-outbound.test.ts`（**源码形态**：出站标识不得以 `bot` 为前缀）
与 `packages/protocol` 的 `validateOutbound` / `FORBIDDEN_OUTBOUND_KEYS`（**运行期形态**：每条 S→C 都拦 `isRobot`/`botId`/`skillLevel`/`thinkingSpeed`）覆盖。
⇒ **该性质确实被机械拦住，只是不重复接线**：补第 7 条闸要同步改 conformance 的 `EXPECTED_GATES`（P7/R394 的教训），
而判据价值为零（**R399#6 / R476**；理由见 §9.8）。

### 12.5 当前违规（**已清除**）

> 与 §13.5 的「P0 修复」**不是同一批**：本节是**前端越权**（§14.2 的 P1 交付）；§13.5 是**测试红灯**（§14.1 的 P0 交付）。
>
> `[已清除]`（**A6/S4/S5，`5be7522`**）：下表三处违规全部位于 `web/index.html`，而该文件（连同 `web/` 目录）已**整条删除** ⇒ 三处违规随之消失。复核：`grep -rn "findBeatingHand\|autoBidBots\|autoPlayBots" apps packages tools` = **0 命中**；前端现由 `apps/client`（哑终端，只依赖 `@fight-the-landlord/protocol`）承担，`source-boundary` 源码闸（§12.4）钉住 F01/F02/F10 + M09。

| 位置（**均已随 `web/` 删除**）                                      | 违规                        | 状态      |
| ------------------------------------------------------------------- | --------------------------- | --------- |
| `web/index.html:517` `findBeatingHand()`（约 115 行的牌型比较实现） | **F01**                     | ✅ 已清除 |
| `web/index.html:243` `autoBidBots()`                                | 12.1 原则 + **F05/F07**     | ✅ 已清除 |
| `web/index.html:419` `autoPlayBots()`                               | 12.1 原则 + **F01/F05/F07** | ✅ 已清除 |

---

## 13. 测试策略

### 13.1 分层与工具

| 层级           | 工具                    | 范围                                                      |
| -------------- | ----------------------- | --------------------------------------------------------- |
| 单元测试       | **Vitest**              | `shared/*` 纯逻辑、规则引擎、谓词、结算公式、裁剪视图生成 |
| 服务测试       | Vitest + NestJS Testing | 各服务的 service 层，Redis/HTTP 以轻量替身注入            |
| 集成测试       | Vitest + docker-compose | 房间创建/加入、匹配成局、完整对局、断线重连               |
| 契约测试       | Vitest                  | WS 消息信封、错误码、RPC DTO 结构                         |
| 不可区分性断言 | Vitest                  | 出站消息不得含机器人标识（§9.8）                          |

- **测试框架为 Vitest**（参考文档 §2.4.1 写的是 Jest，以本文为准）。
- 不使用 testcontainers：集成测试直接复用 `docker-compose.yml` 的基础设施。

### 13.2 可执行命令

```bash
pnpm install
pnpm --filter @fight-the-landlord/shared build   # shared 必须先构建
pnpm test                                        # turbo run test，全包
pnpm --filter @fight-the-landlord/game-service test
pnpm lint                                        # tsc --noEmit
```

### 13.3 覆盖率门槛

- **`packages/shared` 行覆盖率 ≥ 80%**（规则、结算、状态机是正确性核心）
- 其余包不设硬门槛，但**新增业务逻辑必须带测试**
- 覆盖率命令：
  ```bash
  pnpm --filter @fight-the-landlord/shared test -- --coverage
  ```
- **参考文档的「> 80%」只写在文字里、没有命令与阈值落地**；本文要求写入 CI 配置。
- `[已实现]`（P5，裁决 R270/R289/R290）**门槛已写进配置且低于门槛会失败**：
  - `packages/shared/vitest.config.ts`：`test.coverage = { provider:'v8', include:['src/**'], exclude:[...coverageConfigDefaults.exclude, 'src/index.ts'], reporter:['text'], thresholds:{ lines: 80 } }`；
  - `packages/shared/package.json` 的 `test:coverage` = `vitest run --coverage`（CI 第 5 阶段与 §14.4 的 DoD 都走它）。
  - **实测读数**：默认口径（把测试文件与两个不可执行文件也算进分母）曾报 93.94%；本片落地后的**真实口径**为删掉 `rule/beat.ts` 死代码（N23）后 **97.58%**（配置门槛、未删死代码时为 95.38%）。
  - **「会失败」已自证**：临时把 `thresholds.lines` 抬到 `99` ⇒ 产品脚本**非零退出**（`ERROR: Coverage for lines (95.38%) does not meet global threshold (99%)`），改回 80 ⇒ 零退出。
  - ⚠️ **`coverage.exclude` 在 vitest 里是整体覆盖、不是增量**（R289）：自己写数组会**静默取消** vitest 默认的 `**/*.test.ts` 排除 ⇒ 测试代码进分母、读数不再是「`src` 行覆盖率」。必须 `...coverageConfigDefaults.exclude` 打头。
  - ⚠️ **不得靠调阈值掩盖未测文件**：要排除就写进 `exclude` 并在注释里写明理由。现只剩一项：`src/index.ts` = 纯 re-export（无可执行逻辑）。
    > **P7 更新（R361）**：原先还有第二项 `src/protocol/message.ts`（理由是「纯类型声明，编译产物只剩 `"use strict"`」），该文件**已整条删除**（见 §6.3 的历史注记）⇒ 排除项与它的注释**一并删掉**，不留指空的死配置。

### 13.4 CI 阶段

```
1. install
2. lint        (tsc --noEmit，全包)
3. build       (turbo run build)
4. test        (turbo run test)
5. coverage    (shared ≥ 80%，低于门槛失败)
6. eslint-forbidden (§12.4，发现 FORBIDDEN 即阻断)
```

`[已实现]`（P5，裁决 R269/R268/R291）**实际落地形态**：

- **门面是可本地执行的脚本**：`scripts/ci.sh` 六阶段**逐字**照上表的阶段名与顺序；`.github/workflows/ci.yml` **只做薄调用**（checkout + pnpm/action-setup + setup-node(cache:pnpm) + `bash scripts/ci.sh`）—— **不在 YAML 里重抄六阶段**（那是第二个真源）。
- **理由**：Actions 的**运行**仍然不可本地验证。把六阶段写成**脚本**，它就能在门禁里**真的跑一遍**（可验证）；Actions 只承担「在远端把它跑起来」，是不可本地验证的最小面。（2026-09-24/25 订正：仓库**已**有远端 CI 与真栈 conformance，但那条**运行**仍只能在 GitHub 上观测 ⇒ 六阶段以脚本为真源的结论不变。）
- **失败即非零退出**（`set -euo pipefail` + `ERR` trap 点名失败阶段），且**每个阶段都要能被单独观测**（打印阶段名与耗时）—— 否则「六阶段都跑过了」无法从输出判读。
- **第 6 阶段**（`eslint-forbidden`，名字逐字保留规格的）的实际内容见 §12.4：跑**六条** vitest 源码级闸，**且每条都断言 `Tests N passed ≥ 1`**（R291 —— 过滤名与文件名脱节时 vitest 会「0 用例而退出码 0」，那正是恒绿形态）。
- **第 1 阶段**的 `pnpm install --frozen-lockfile` **始终保留**（那是判据的语义）；仅在仓库内已存在 `.pnpm-store` 时附加 `--store-dir`（本机沙箱禁写 `~/.pnpm-store`，见 R292）——真正的 CI 上该目录不存在（`.gitignore` 已忽略），命令与规格逐字一致。
- 本地执行入口：根 `package.json` 的 `"ci": "bash scripts/ci.sh"`（即 `pnpm run ci`）。
- **第 2 阶段自 P16 起同时覆盖 `test/**`**（R541/R542）：每个含 `test/`的包多了一份`tsconfig.test.json`
（`module: ESNext`+`moduleResolution: Bundler`—— **vitest 的真实解析语义**），
各包`lint`变成`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`：
**src 仍由 NodeNext 那把尺子量，test 由 bundler 那把尺子量**，两把尺子各量各的。
⚠️ 背景：在 P16 之前，9 个包的 `tsconfig.json`**全部**只`include: ["src/**/*"]`、全仓没有任何 `tsconfig.test.json`⇒`test/**` 不受任何类型闸管辖（vitest 走 esbuild，不做类型检查）⇒ 夹具的形状漂移长期不可见
  （P12 的 R481 就是这么被记下来的：夹具缺字段/多字段/字段类型错，全都不报错）。
  P16 开闸后一次性暴露 **69 处**（改夹具 12 · 替身 cast 4 · 其它 42 · 补依赖 11），**已全部修掉\*\*；
  判别力用「种错必红」自证（夹具字段类型写错 ⇒ `error TS2322`，改完后再复证一次）。
- **测试环境自 P18 起会发出 DI 元数据**（R561/R562，台账 N41）：Vitest 用的 esbuild **不支持**
  `emitDecoratorMetadata`（其 `.d.ts` 里没有该选项）⇒ 此前 5 个测试文件用 **7 处
  `Reflect.defineMetadata('design:paramtypes', …)` 手工补回**，而**垫片把「期望的依赖清单」写死**：
  产品侧漏 `@Inject`/改参数顺序，测试照样绿。
  现由 `scripts/vitest-plugins/emit-decorator-metadata.ts`（**全仓唯一一份**，`typescript` 的 `transpileModule`，
  **零新依赖**）+ 5 个包的 `vitest.config.ts`（`setupFiles: ['reflect-metadata']`，**必须先于被装饰的类求值**）
  让测试链路具备与产品**同样的产生机制**，7 处垫片全部删除；正对照在
  `packages/game-service/test/di-metadata.positive-control.test.ts`，防复活闸在
  `packages/api-gateway/test/no-di-metadata-shim.gate.test.ts`。
  ⚠️ 拆垫片当场抓到一处**被垫片掩盖的真问题**：`api-gateway/test/gateway.controller.test.ts` 把替身挂在
  **自造的 `ProxyGatewayToken`** 上，而产品构造签名用的是 `ProxyGateway`（判据未改、17/17 绿）。

`[已实现]`（上线运营层（二），2026-09-24/25）**另有三个工作流**（⚠️ 它们**不在**本节开头那张**六阶段表**里 —— 六阶段表是 `scripts/ci.sh` 的真源，补进去就是第二真源）：

| 工作流                              | 触发                                                                                                | 做什么                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/images.yml`      | push→**master**                                                                                     | 构建 14 个自建镜像 → 推私有 GHCR 包 `ghcr.io/howebai/fight-the-landlord-<svc>:{sha-<短7>, latest}`           |
| `.github/workflows/conformance.yml` | push→**master** · `workflow_call`（被 `release.yml` 复用时**拉**刚推好的 tag 镜像，省一次全量构建） | 起真栈跑**全部 conformance 切片**（Linux 侧验证的自动化答案），条数下限在 `tools/conformance/baselines.json` |
| `.github/workflows/release.yml`     | tag `v*` · `workflow_dispatch`（回滚入口）                                                          | `images → conformance → deploy` **三个 job 用 `needs` 串行**（并行会让部署抢在镜像推送之前 ⇒ 竞态型假红）    |

`ci.yml` 另有第二个 job **`render-gate`**（每次 push 跑纯渲染判据 —— 不需要 docker daemon、≈2.8s）：它关掉的是片① 登记的 **R2**（「新增的生产形态保证没有任何自动闸」）。

`ci.yml` 另有第三个 job **`security-scan`**（M0.1，每次 push 与 PR 跑）：三路全阻断——依赖漏洞（`scripts/security/check-audit.mjs`，`pnpm audit --prod` 的 critical/high 必须清零，唯一条机器可读豁免 = `scripts/security/audit-exceptions.json` 的 vite/1123525）· 密钥泄露（gitleaks v8.30.1 钉版全历史）· 配置误配（trivy v0.75.0 钉版 config）。它与 `render-gate` 同理由**不进六阶段**（六阶段真源在 `scripts/ci.sh`）。判据 = `slice-07.4-pipeline` 的 C1–C25。

**成本控制**（R1314，与具体额度数字无关）：① 构建走 buildx + GHA 缓存 ② 触发分级（**三个工作流表**）③ **额度吃紧时的降级路径**：把 `conformance.yml` 的 `on.push.branches` 删掉 ⇒ 真栈 conformance 只在 tag 上跑（`render-gate` 不受影响，仍在每次 push 跑）；⚠️ **但已不是「一行改动」**（2026-09-25 订正）：`slice-07.4-pipeline` 把触发集合钉成恰好 {push, workflow_call} ⇒ 删 `on.push` 会让它红 —— **得分两处一起改** ④ CI runner 侧允许 `docker image prune -af`，**服务器侧只许 `-f`** ⑤ tag 路径的构建次数 = **2**（`images` + `conformance` 复用拉取）。

### 13.5 当前达标状况 `[已修复]`

> **本节的偏差已于 P0 关闭**（以下为审计基准 `fafb36a` 的历史快照，留档以防复发）。
> P5 收口实测：`pnpm test` = **29/29 turbo 任务全绿、0 cached**；`pnpm run ci` 六阶段全绿。

- `pnpm test` 结果（**历史**）：**turbo 任务 11/12 通过**（唯一失败任务 `@fight-the-landlord/api-gateway#test`，其内部为 **vitest 用例 8 失败 / 5 通过 / 共 13**）
  - ⚠️ 两个数字单位不同：**11/12 是 turbo 任务数**，**8/13 是 vitest 用例数**，不可混读。
- 失败原因：`test/jwt.middleware.test.ts` 按**旧契约**编写（用 `req.path`、路径不含 `/api` 前缀），实现改为读 `req.originalUrl ?? req.url` 后抛 `TypeError`；`test/gateway.e2e.test.ts` 调用 `GatewayController.health()`，而该方法不存在
- `test-results/.last-run.json` 记录 `status: "failed"`
- **网关鉴权从未被任何测试覆盖**——这正是 §7.1 的鉴权失效能长期存在的原因

**按 `CLAUDE.md`「交付前确保测试通过」，当前状态为未达标，须在 P0 修复。**

---

## 14. 阶段规划与 DoD

参考文档的 7 个 Phase 全部是复选框、**无验收标准**，这是「引擎做完了、鉴权却是空的」能够发生的根本原因。本文为 MVP 重划 4 个阶段，**每个阶段都有可执行的验收判据**。

### 14.1 P0 — 地基与鉴权（阻塞性）

**交付**

- 修复网关鉴权白名单（§7.1）
- 身份透传与内部密钥（§5.2）
- 错误码体系落地（§11）
- 限流（§5.4）
- 健康检查补 `checks`（§2.4）
- 修复 `api-gateway` 测试（§13.5）

**DoD**

```bash
# 1) S1：匿名写操作被拒
#    ⚠️ 必须带合法 body —— 不带 body 时，修好前是 400（DTO 校验失败）、
#    修好后是 401，两者极易被误读为「修了但看起来没修」。只有带 body 才会
#    在未修的栈上复现「匿名 201」这个真正的漏洞信号。
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/rooms \
     -H 'Content-Type: application/json' -d '{"mode":"random"}'   # 期望 401（未修则为 201）

# 2) S2/S8：真正的泄漏面在 GET，务必覆盖
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/games/ABC   # 期望 401
# 带 token 时：只应看到自己的 hand，他人只有 cardCounts，且无 isRobot/actionLog/botId
curl -s localhost:3000/api/games/<code> -H "Authorization: Bearer $TOKEN"

# 3) 公开路径仍可达
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/health      # 期望 200
```

### 14.2 P1 — 服务端权威对局

**交付**

- WS 链路接线（§6.1）：`@SubscribeMessage`、正确的 server 实例、gateway WS 代理
- 消息信封与 ack（§6.2）、消息清单（§6.3）
- **可见性裁剪**（§6.4）—— 阻塞项，未完成则不得联调
- 幂等与并发控制（§6.5）
- 对局状态外置到 Redis（§10.2）
- 删除前端三处违规（§12.5）
- 玩法规则偏差修正（`docs/games/doudizhu.md` §11 的 **18 条 `[偏差]` + 1 条 `[部分实现]` + 2 条 `[待实现]`**；其中「农民胜条件」「过牌前置」「底牌并入」「`ended` 状态」「编码边界」是会**必然导致对局卡死或规则错误**的项，优先级最高）
  - ✅ **已完成**（P24/R612 复核：这一条是 **P13 清 `doudizhu.md` 时漏掉的跨文档引用** —— 那 21 条标记**已全部处置完**）。当前形态计数（可机械复核）：`grep -c '\[偏差\]' docs/games/doudizhu.md` = **0** · `[待实现]` = **0** · `[部分实现]` = **0** · `[已实现]` = **15**；规则侧的实现判定见台账 §1.1（`C1–C28` 27/27 已关闭）。⚠️ 上面那三个数字是**本清单写下时的积压量**，**不是现状**。

**DoD**

```bash
# 看不到他人手牌
curl -s localhost:3000/api/games/<code> -H "Authorization: Bearer $TOKEN" | jq '.players[].hand'   # 期望仅自己的手牌有牌面
# 重放同一动作被拒
#  同一 baseVersion 提交两次 game.play → 第二次返回 13004
# 13004 恢复通道可用
#  game.resync 的 ack.data 是当前裁剪快照（PlayerView），其 version 为服务端当前版本
# 叫抢阶段的回合行动者正确（客户端无法自检，由服务端断言）
#  state === 'bidding' 时，game.current_turn.payload.seat === bidPhase.currentBidder
#  （若用 currentPlayer 填则会错 —— 叫抢期它恒为 0，见玩法 §9.1）
# 对局状态外置
docker restart ftl-game-service && curl -s localhost:3000/api/games/<code> -H "..."   # 期望对局仍在
pnpm test    # 期望全绿，且含裁剪与幂等用例
```

### 14.3 P2 — 匹配与机器人

**交付**

- 匹配队列键带 `region`、谓词接口、重试与回退（§8）
- 机器人 AI 全量化：三档 = 三个 DouZero 模型（`sl` / `douzero_WP` / `douzero_ADP`）+ 降级链（§9.3）
- 服务端回合驱动（§9.4）
- 机器人可见信息边界与 `actionLog`（§9.5）
- 机器人 ID 统一与不可区分性断言（§9.8）

**DoD**

```bash
# 1) 三人匹配自动成局（含机器人补位）—— 集成测试
pnpm --filter @fight-the-landlord/room-service test -- match.e2e

# 2) 机器人回合由服务端驱动：断开全部客户端后对局仍推进（version 持续增长）
pnpm --filter @fight-the-landlord/game-service test -- robot-turn.e2e

# 3) 不可区分性：全部出站消息不含 isRobot / botId / bot: 前缀
pnpm --filter @fight-the-landlord/game-service test -- visibility.e2e

# 4) DouZero 不可用时回退规则引擎（不直接 pass）
pnpm --filter @fight-the-landlord/robot-service test -- fallback.test

pnpm test
```

### 14.4 P3 — 上线准备

**交付**

- 重连（§6.6）、`cancelled` 房间状态、`timeoutAt` 清理
- 覆盖率门槛入 CI（§13.3）
- 日志脱敏（§5.5）
- MySQL `synchronize` 关闭，改显式迁移（§10.3）
- 环境变量表核对（§2.3）
- **健康检查的 `checks` + 存活/就绪分离（§2.4）**

**DoD**

```bash
pnpm test && pnpm lint
pnpm --filter @fight-the-landlord/shared test -- --coverage   # ≥ 80%
docker compose up -d && docker compose ps                     # 开发形态 11 个容器全部 healthy（生产形态 18 个，§2.2/§7.1；支付片订正）
```

`[已实现]`（P5 收口）**逐条落地形态**：

| DoD 项                                                            | 实际落地                                                                                      | 实测                                                                                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test && pnpm lint`                                          | `turbo run test lint --force`                                                                 | **29/29**，0 cached                                                                                                                                                                |
| 覆盖率 ≥ 80%                                                      | 门槛入 `packages/shared/vitest.config.ts`（§13.3）；`test:coverage` 脚本                      | **97.58%**；抬到 99 ⇒ 红（自证）                                                                                                                                                   |
| 11 容器 healthy（**开发形态**；生产形态 18 个，§2.2；支付片订正） | `docker compose up -d && docker compose ps`                                                   | **11/11 healthy**（P5 收口时为 8/8；片⑦ 后 **2026-10-02** 本机复测 9/9 —— 货币片后未复测；**支付片 2026-10-06** 本机复测：全量形态（基础 11 + 门口 + 监控六件）**18/18 healthy**） |
| **CI 六阶段（§13.4）**                                            | `scripts/ci.sh` + `pnpm run ci`（Actions 薄调用）                                             | 六阶段全绿                                                                                                                                                                         |
| **§2.4 两个端点**                                                 | `/api/health`（就绪，200/503）+ `/api/health/live`（存活，恒 200）                            | 五服务 `checks` 字段集恰好；`live` 不含 `checks`                                                                                                                                   |
| **部署 = 打 tag**（上线运营层（二））                             | `git tag v1.0.0 && git push origin v1.0.0` ⇒ `release.yml` 的 `images → conformance → deploy` | **待首次真部署核**：真域名上线（真证书，`curl` **不带 `-k`** 通）；**手工路径已废止**（⑦ 整节替换）                                                                                |
| **回滚 = `rollback.sh`**                                          | `bash scripts/deploy/rollback.sh <旧 tag>`（或 `workflow_dispatch` 填 `image_tag`）           | **待首次真部署核**：回滚耗时「秒级」（只 `pull` 已存在的 tag，不构建）；⚠️ 前提：**tag 只打在 `master` 上**                                                                        |

> ⚠️ 末两行的「实测」列写的是**待首次真部署核**的**判据**（真部署尚未发生 ⇒ 无读数），**不是**已测值；**首次真部署之后**按那次的实际读数回填 —— 口径同 `tools/conformance/baselines.json` 的 `full` 列（基线是实测值，不是预测值）。

### 14.5 长期路线

见 `docs/appendix/platform-roadmap.md`。

---

## 15. 运维

### 15.1 健康检查

见 §2.4。

### 15.2 配置

- **部署形态**配置全部来自环境变量（§2.3），**禁止硬编码端口与地址**；**运行期可调**参数（五十一键：开关 / 比例 / 周期 / 模型映射 / 底分档位 / 好友房开关 / 免费与金币场开关 / 免费与金币场机器人补位开关 / 无机器人匹配总等待上限 / 保留期 / 注册赠送 / 门槛倍率 / 抽水 / 救助 / 风控〔谓词开关 · 检测阈值 · 设备窗口与保留 · 自动限流〕/ 支付〔充值提现两开关 · 比率 · 档位表 · 三项限额 · 两周期〕/ 广告〔救助广告位 adpid〕/ 客户端接入〔App/H5 两开关〕/ 记牌器〔总开关 + 两价格〕）来自**配置中心**（§7.5）—— 改它走 `/admin` 管理页，**不走 env**（基础设施类 env 不进配置中心，§7 同族裁决）。
- 密钥不写入仓库；`JWT_SECRET` 在 `docker-compose.yml` 中仅有开发默认值。

### 15.3 日志与追踪

- 结构化日志，每条至少含 `traceId` / `service` / `userId`（若有）/ `reqId`（若有）。
  **`[已实现]`（可观测性（一）收口，2026-09-23）**：一行一条 NDJSON，字段**恰好九个**
  （`ts/level/service/context/traceId/reqId/userId/source/msg`），其中 `source` 是**加项**
  （如实说明"为什么没有 traceId"，R1107）。设计与判据见
  `docs/superpowers/specs/2026-09-23-observability-logging-design.md`（R1101–R1110 · 12 条判据）；
  日志体积上限见该 spec §4（R1108，轮转即丢弃）。
- **`traceId` 贯穿**：网关注入 `X-Trace-Id`，下游透传。
  **WS 路径的载体**：网关与 room-service 之间的下游 socket.io 握手 `auth` 中携带 `traceId`（与 `userId`/`internalToken` 并列，§5.2 第 4 条）；room-service 写入 `socket.data.traceId` 并用于该连接产生的全部日志与对局事件。
  参考文档 §3.5 的 `TraceInterceptor` 只实现了 HTTP（`switchToHttp`），**RPC 与 WS 的上下文传播需自行实现**。
- 脱敏规则见 §5.5。

### 15.4 部署与回滚

- **发布** = 打 tag（`v*`）→ `release.yml`（`images → conformance → deploy`，`needs` 串行）。
- **回滚** = `bash scripts/deploy/rollback.sh <旧 tag>` 或 `workflow_dispatch` 填 `image_tag`。
- 操作手册：`docs/ops/first-deploy.md`（①–⑨，每条命令带预期输出；「〇 服务器预备」是手工一次的）。
- **服务器磁盘纪律**（🔴）：只许 `docker image prune -f`（只删悬空）。`-af` 会删掉上一个 tag 的镜像，把秒级回滚变成一次几 GB 的网络拉取（R1307/R1314）。
- **凭据面**：镜像由同仓工作流推送 ⇒ 服务器用同一个内置 token 拉取 ⇒ **长期密钥数 = 0**；部署私钥是专用的（不复用登录私钥）。登出是三层（脚本 `trap` · 工作流 `if: always()` · 部署后 `--assert-clean` 断言），见 R1306。

---

## 附录 A. 冲突裁决与现状偏差

### A.1 两份旧文档冲突的裁决记录

| #   | 事项                 | 参考文档 v3.2                                                                    | `design.md` v1.0                                        | 裁决                                                                                                                                                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 服务端口             | `game-service:3001`、`currency-service:3002`（RPC 语义混用）                     | game 3003 / user 3001 / room 3002                       | **追认实现**（HTTP 3000 段、RPC 3100 段分离）                                                                                                                                                                                |
| 2   | WS 信封              | `{type, seq, timestamp, payload, signature?}` + `{type, seq, code:number, data}` | `{type, seq?, version?, payload, error?:{code:string}}` | **两者皆不采纳**：ack 做关联、`baseVersion` 做去重、`reqId` 仅追踪，**删除 `seq`**                                                                                                                                           |
| 3   | 错误码               | 5 位数字、8 域、40 条                                                            | 字符串 18 条                                            | **数字码 + HTTP 映射 + 旧字符串码作别名**（§11.4）                                                                                                                                                                           |
| 4   | 测试框架             | Jest                                                                             | Vitest                                                  | **Vitest**（追认实现）                                                                                                                                                                                                       |
| 5   | 服务间通信           | `Transport.TCP`（无 pattern 名、无 DTO）                                         | 计划 TCP、实际 HTTP                                     | **TCP RPC**，由本文补齐契约（§4.2）                                                                                                                                                                                          |
| 6   | Redis 结构           | 单 key `room:{roomId}` JSON                                                      | 3 个 Hash                                               | **混合**：房间元数据 Hash（原子入座）、对局状态单 key JSON + `version` 乐观锁                                                                                                                                                |
| 7   | 匹配系统             | 独立 Match Service + ELO                                                         | room-service + 「复用 Go matcher」                      | **room-service + 简单随机成局 + 谓词接口**；ELO 入演进附录                                                                                                                                                                   |
| 8a  | 机器人 AI            | 自研规则引擎 → MCTS → 深度学习                                                   | DouZero                                                 | **双轨**：规则引擎（beginner/intermediate）、DouZero（advanced）——⚠️ **2026-10-01 片② 订正**：出牌 **100% DouZero**（三档 = 三个模型 `sl`/`douzero_WP`/`douzero_ADP`），规则引擎只在 DouZero 不可用 / 返回非法时兜底（§9.3） |
| 8b  | 机器人回合驱动者     | **未规定**                                                                       | **未规定**（实现为浏览器驱动）                          | **game-service 驱动**（§9.4）                                                                                                                                                                                                |
| 8c  | 机器人身份可见性     | 「前端无感知」                                                                   | `bot.move` 广播                                         | **采纳「前端无感知」**，废除 `bot.move`                                                                                                                                                                                      |
| 9   | 阶段划分             | 7 个 Phase（无 DoD）                                                             | 3 个 Phase                                              | **重划 MVP 4 阶段 + 每阶段 DoD**（§14）；7 Phase 入演进附录                                                                                                                                                                  |
| 10  | 认证与会话           | JWT 2h + Refresh；用户侧无吊销；心跳两套                                         | 7d 无 refresh；定义 `session:{token}`                   | **access 2h + refresh 7d + `session:{jti}` 白名单**；心跳统一 socket.io 30s/90s                                                                                                                                              |
| 11  | 前端选型             | uni-app（Cocos3D 仅备选）                                                        | 「参考文档选 Cocos3D」——**转述错误**                    | **uni-app**；`web/index.html` 标注为临时工具                                                                                                                                                                                 |
| 12  | 匹配算法名           | **ELO**                                                                          | 「Eloquent」——**转述错误**                              | **ELO**（入演进附录）                                                                                                                                                                                                        |
| 13  | Gateway→User 调用    | §3.4 矩阵无此行                                                                  | HTTP/REST                                               | **HTTP/REST**（鉴权与用户信息）                                                                                                                                                                                              |
| 14  | Room→Robot           | §3.4 矩阵：RPC                                                                   | HTTP/REST                                               | **TCP RPC**（与 #5 一致）                                                                                                                                                                                                    |
| 15  | 会话吊销             | 用户侧无                                                                         | `session:{token}`                                       | **`session:{jti}`**（jti 比 token 更适合做键）                                                                                                                                                                               |
| 16  | Phase 1 是否含 RBAC  | 含                                                                               | 明确排除                                                | **排除**（MVP 不做管理后台）                                                                                                                                                                                                 |
| 17  | Payment / Admin 形态 | 独立服务                                                                         | 归入 currency-service / gateway                         | **MVP 不做**，入演进附录                                                                                                                                                                                                     |
| 18  | 异步基础设施         | RabbitMQ + Redis Stream                                                          | Phase 1-2 不引入                                        | **不引入**；仅用 Redis pub/sub 一个频道（§4.4）                                                                                                                                                                              |

**范围外冲突**（#16、#17 及货币/支付/风控/看板/管理后台/多玩法相关）不逐条裁决，整体移入 `docs/appendix/platform-roadmap.md`。

### A.2 现状偏差汇总

按严重度排序。**安全类必须在 P0/P1 解决。**

> ## ⚠️ 本表是**历史快照**，其「偏差」/「位置」两列描述的是**写作时**的代码 —— **不是**当前代码
>
> ⚠️ **三个 commit 必须分开看（P24/R614 实测，这是本表最容易读错的地方）**：
>
> | 角色             | commit    | 日期             | 含义                                                                                                         |
> | ---------------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
> | **表格快照基准** | `3da457f` | 2026-09-13 10:07 | 本表的**主体 37 行**（`S1–S7` · `C1–C14` · `A1–A8` · `E1–E8`）在这一版写成，「位置」列的行号按**它**的代码写 |
> | **审计基准**     | `fafb36a` | 2026-09-13 19:26 | 4 个只读审计在**这一版代码**上逐条判定（判定**执行**于 2026-09-14）；两者相隔 **99 个 commit**               |
> | 当前状态         | `HEAD`    | —                | **一律查台账 §1.x**（不读本表散文）                                                                          |
>
> ⇒ **「审计当时」≠「本表写作时」**。二者混读会产生一类**假结论**：「这条在审计基准上就已经修好了」——
> 其实只是**表写得更早**（例：`A1`/`A3`/`A4`/`A5`/`A8`/`E3`/`E8`/`E6` 的散文与行号在 `3da457f` 上**逐条精确命中**，
> 抽样复核：`A1` `game.service.ts:22` = `private readonly sessions = new Map<…>` · `A4` `match.service.ts:53` = `startMatchingLoop(): void {` ·
> `A5` `ws.gateway.ts:293` = `async subscribeToGameEvents()` · `A8` `rooms.service.ts:25` = `await this.redis.keys('room:*')` ·
> `E3` `ws.gateway.ts:10` = `pingInterval: 10000, pingTimeout: 20000` · `E8` `game.service.ts:51-52` = 「Check if session already exists in Redis」+ `this.sessions.get(…)` ·
> `E6` 三个字段当时全缺 · `S1` `jwt.middleware.ts:13` = `publicPaths = […, '/']` · `S2`/`S8` `game.controller.ts:25`/`:34`）。
> ⚠️ 且本表的**行集合本身也长过**：`3da457f` **37** 行 → `a4bf89a` 50 → `73c6c9a` 49 → `6d737d5` 52 → `8f15ba8` **53**（v4.1 修订记录里的「A.2 由 49 条增至 52 条」即指其中一步）；
> 后追加的那些行（`S8` · `C15–C28` · `E9` · `E10`）**沿用了更早审计稿的行号**（例：`C13` 的 `:75`、`C25` 的 `:66` 对应 `895f5d8`，比这里任何一个基准都早约 25 小时）。
> ⇒ **「位置」列的 `文件:行` 没有任何单一可信基准，一律只能当历史散文读**（见下条）。
>
> **A.2 的 53 条偏差全部已按 A.3 的约定处置完毕**（`S1–S8` 8/8 · `C1–C28` 去 `C21` 27/27 · `A1–A8` 8/8 · `E1–E10` 10/10）。
> ⚠️ **本节不再复述台账的统计数字** —— 当前条数 / 判定 / 仍开放项**一律以 `deviation-ledger.md` §0 为准**。
> 原句在这里写过「§0：**80 条 / 79 已关闭 / 0 部分关闭 / 1 仍开放**；唯一仍开放的是 **N13**」：它写下时
> （P8 `a2e16f4`）**是准确的**，但**每关掉一条就过期一次** —— P24 实测 `ledger-counts` 已是 **98：97/1/0**，
> `N13` 早在 P11 关闭，而唯一「部分关闭」的是 **`N39`**（且 `N39` **不是** A.2 条目）。⇒ 按 **R604** 撤掉复述，只留单向指针。
>
> - 本表的 **`#` 列（`S1`…`E10`）仍是对账表的编号锚点**，请**保留**；但**「偏差」列是过期散文**，**不要**据此判断现状。
> - ⚠️ **「位置」列也按快照读**（P24/R610）：那一列里的 `文件:行` 指向的是**写作当时**的位置 ——
>   ① **路径普遍省略 `packages/` 前缀**（如 `robot-service/src/…` 的真实路径是 `packages/robot-service/src/…`），这是全表统一的写法，不是笔误；
>   ② **符号可能已改名**（如 `checkAndSettle()` 已由 `finishTransition()` 取代）；
>   ③ **文件可能已删除或搬迁**（如 `shared/src/protocol/message.ts` 已整条删除、机器人 ID 生成已从 `robot.service.ts` 搬到 `robot.pool.ts`）；
>   ④ **行号可能已落在无关代码上**（如 `ws.gateway.ts:176,180` 现为鉴权判定的注释）。
>   ⇒ **要定位当前实现请 `grep` 符号名，不要照抄行号。**
> - **当前状态的唯一真源 = `docs/superpowers/plans/deviation-ledger.md`**：§1.1–§1.5 逐条给出**判定 + 证据（`文件:行` / 测试 / 在线判据）+ 关闭者 commit**；§3 记录文档侧余量。
> - ⚠️ **为什么加这段**（P8 复审 / R402）：这张表的散文此前已被逐行更新过三次（P4 关 A2、P8 关 C17 与 E4、订正 A3），而**每次都会在下一次代码改动后重新过期** —— 因为它是**同一事实的第二份叙述**。⇒ 与其逐行追着改，不如**把它明确钉成历史快照**、让状态判断**单向指向台账**（本仓为「同一事实两个真源」付过多次代价）。
> - **本表的构成（P24/R609 机械复核）**：**53** 条数据行 —— `S1–S8`(8) · `C1–C28` 去 `C21`(27) · `A1–A8`(8) · `E1–E10`(10)
>   （两种口径：数据行 **53** · 含表头/分隔行 **61**）。**自审计基准 `fafb36a` 起行集合未变**
>   （`git show fafb36a:docs/design.md` / `a2e16f4` / `HEAD` 三处的编号集合逐一相同，md5 一致）。
>   ⚠️ 本行原先写「本表**不完整**：它是审计当时的 **39 行**，缺 `C15–C28` / `E10` / `C16` / `C17` 等后续切片才登记的条目」——
>   **实测整句不成立**：① 实际是 **53** 行；② 那 14 行**从审计基准起就在表里**（`fafb36a` 同样是 53 行），
>   并非「只在台账里」；③ `39` 这个数与历史上任何一个计数都不符（实际序列是 **37 → 50 → 49 → 52 → 53**）。
>   ⇒ 已按 P24/R604 更正（误导性在于：读者会以为 `C15–C28`/`E10` 只在台账里有，从而**漏查 A.2**）。

#### 安全类

| #   | 位置                                             | 偏差                                                                                             | 依据 |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---- |
| S1  | `api-gateway/src/auth/jwt.middleware.ts:13`      | 白名单含 `'/'` → `isPublicPath()` 恒真 → **鉴权完全失效**（实测匿名 `POST /api/rooms` 返回 201） | §7.1 |
| S2  | `game-service/src/game/game.controller.ts:25`    | `GET /api/games/:roomCode` 返回**三家手牌 + 底牌**，且无需 token                                 | §6.4 |
| S3  | 全链路                                           | **无身份透传**；下游信任 body 的 `playerId` → 可代他人出牌                                       | §5.2 |
| S4  | `robot-service/src/robot/robot.controller.ts:15` | 接收**客户端传来的整个 `session`** → 把三家手牌交给 AI                                           | §9.5 |
| S5  | `web/index.html:199`                             | 机器人 ID 明文下发（`bot-1`/`bot-2`）                                                            | §9.1 |
| S6  | `packages/*`                                     | **无任何限流**                                                                                   | §5.4 |
| S7  | `packages/*`                                     | **无日志脱敏**                                                                                   | §5.5 |
| S8  | `game-service/src/game/game.controller.ts:34`    | `GET /api/games/:roomCode/state` 与 S2 同一泄漏：返回含三家手牌与底牌的完整对局                  | §6.4 |

#### 正确性类

| #       | 位置                                                 | 偏差                                                                                                                                                                                                                                                                                                                                                                                                                                             | 依据           |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| C1      | `shared/src/ddz/settle.ts:15`                        | 倍数用**加法** `bombCount + bidMultiplier`，应为乘法                                                                                                                                                                                                                                                                                                                                                                                             | 玩法 §8.2      |
| C2      | `shared/src/ddz/settle.ts:12`                        | `landlordSeats` 用数组下标、`farmerSeats` 用座位号                                                                                                                                                                                                                                                                                                                                                                                               | 玩法 §8.5      |
| C3      | `shared/src/ddz/settle.ts`                           | **春天规则零实现**（计数已统计未使用）                                                                                                                                                                                                                                                                                                                                                                                                           | 玩法 §8.3      |
| C4      | `shared/src/ddz/bid.ts:68`                           | 流局**未重新发牌**，仅重置叫抢状态                                                                                                                                                                                                                                                                                                                                                                                                               | 玩法 §3.3      |
| C5      | `game-service/.../game.service.ts:172`               | 最后出牌者超时调用 `handlePass()` 抛错被吞 → **对局卡死**                                                                                                                                                                                                                                                                                                                                                                                        | 玩法 §9        |
| C6      | `shared/src/rule/rule.ts:140`                        | `parseHand()` 抛异常而非返回 `HandType.Invalid`（该枚举为死代码）                                                                                                                                                                                                                                                                                                                                                                                | 玩法 §4.2      |
| C7      | `ddz/game.ts` / `ddz/play.ts` / `bot.player.ts`      | 牌值映射**三处重复**（两次「修复卡牌值映射bug」即其代价）                                                                                                                                                                                                                                                                                                                                                                                        | 玩法 §10       |
| C8      | `robot-service/src/robot/bot.player.ts:90-132`       | `computePlayedCards()` 用启发式**伪造** DouZero 特征                                                                                                                                                                                                                                                                                                                                                                                             | §9.5           |
| C9      | `robot-service/src/robot/bot.player.ts:54-58`        | DouZero 失败**直接 pass**，应为回退规则引擎                                                                                                                                                                                                                                                                                                                                                                                                      | §9.3           |
| C10     | `game-service/.../game.service.ts`                   | **幂等零实现**（无 `lastActionSeq`、无 `baseVersion`）                                                                                                                                                                                                                                                                                                                                                                                           | §6.5           |
| C11     | `room-service/src/rooms/rooms.service.ts:52`         | `join()` 为 `GET→push→SET` **非原子**，并发丢玩家                                                                                                                                                                                                                                                                                                                                                                                                | §10.2          |
| C12     | `room-service/src/gateway/ws.gateway.ts:136`         | `expire('reconnect:active:{id}')` 作用于**不存在的键**（该键从未被 `set`）→ TTL 空操作。**同一缺陷复制在** `reconnect/reconnect.service.ts:27`（且 `recordConnection()` 本身是死代码，生产路径不调用）                                                                                                                                                                                                                                           | §6.6           |
| C13     | `room-service/src/match/match.service.ts:75`         | 把入队超 **30 秒**的玩家当 **stale 移除**；而 §8.4 规定的是 **60 秒 / attempts ≥ 10** 才回退，且应触发**补机器人**而非移除。**修阈值时两处都要改，不能只照 A.2 的字面**                                                                                                                                                                                                                                                                          | §8.4           |
| C14     | `room-service/src/match/match.service.ts:109`        | 用 `id.startsWith('bot-')` 反推座位归属                                                                                                                                                                                                                                                                                                                                                                                                          | §9.6           |
| **C15** | `shared/src/ddz/bid.ts:50-66`                        | **底牌从未并入地主手牌**：`finalizeBidding()` 只设 `isLandlord`；全仓生产代码无一处置入 `players[].hand`。地主终身 **17 张**，而机器人视角被补成 20 张 → 人机不对等，对局无法正常结束。⚠️ **修本条时必须同时删除两处补偿**：`robot-service/src/robot/bot.player.ts:28-30` 的 +3，以及 `game-service/src/game/view.builder.ts` 里为满足 `cardCounts[seat] === hand.length` 不变式而临时并入底牌的补偿。**漏删任何一处，地主会拿到 23 或 21 张。** | 玩法 §2.3/§3.4 |
| **C16** | `shared/src/ddz/play.ts:142`、`settle.ts:40`         | **农民胜利条件写错**：`farmers.every(p => p.hand.length === 0)` 要求两名农民都出完，应为 `some(...)`（任一农民出完即农民方胜）。正常对局路径**必现死锁**                                                                                                                                                                                                                                                                                         | 玩法 §7        |
| **C17** | `game-service/.../game.service.ts:345`               | ✅ **已关闭**（P8 复审）：`finishTransition` 置 `GameState.Ended` 并写 `finishedAt`（`:349-350`）；`checkAndSettle` 全仓 **0 命中**                                                                                                                                                                                                                                                                                                              | 玩法 §7        |
| **C18** | `shared/src/ddz/play.ts:110`                         | 过牌只校验「不是最后出牌者」，**缺「`lastPlayedHand !== null`」前置** → 开局 `lastPlayerIdx === -1` 使约束失效，首出可过牌 → 两家过牌后 `currentPlayer = -1`，**对局永久卡死**                                                                                                                                                                                                                                                                   | 玩法 §6.2      |
| **C19** | `shared/src/ddz/play.ts:50` vs `:54-55`              | **牌值双口径**：待出牌直接把 DouZero 编码当 `Rank`（`2` → 17），待跟牌却经 `douzeroIntToCard` 还原为 `Rank2` = 15 → **同点数的 2 可以互相压过**（实测单张 2 压单张 2、对 2 压对 2 均被接受）                                                                                                                                                                                                                                                     | 玩法 §1.4      |
| **C19** | —                                                    | ✅ **已由 R695 结构性消除**（2026-09-20）：全系统只剩 DouZero 一套编码，`toInternalRank()` / `toDouZero()` 与 `douzeroIntToCard()` 均已删除 ⇒ 不存在「待出牌用一套、待跟牌还原成另一套」的可能。**本条不再需要判据守护**（原来的守护判据见台账 N16/C19）。                                                                                                                                                                                       | 玩法 §1.3      |
| **C20** | `shared/src/ddz/types.ts:24`                         | `lastPlayedHand` 为 `{ cards, type, rank }`：**无 `length`**（顺子类长度比较无处取值），`type` 存 `playedHand.type.toString()`（数字字符串如 `'1'`）；字段名为 `rank` 而规格为 `keyRank`                                                                                                                                                                                                                                                         | 玩法 §6.1      |
| **C22** | `game-service/.../game.service.ts:50-63`、`:172-193` | **计时器两处缺陷**：① `createGame()` 从不调用 `startTurnTimer` → 首位叫牌人无时限；② `onTurnTimeout()` 执行后既不 `clearTimer` 也不重挂 → **超时一次后后续玩家再无计时器**，「各阶段 30s」实际不成立                                                                                                                                                                                                                                             | 玩法 §9.2      |
| **C23** | `shared/src/ddz/bid.ts:22`                           | `bidMultiplier` 上限写死 **24**，一轮制最多抢 3 次（上限应为 8）→ 该上限永不可达，且误导实现者以为可多轮抢<br>⚠️ **片① 订正（2026-09-30）**：一轮现最多 **4** 次声称（3 次 + 1 次反抢）；`BID_MULTIPLIER_CAP = 8` **不变**（反抢那一抢**同样 ×2**、每次声称无条件 `min(m×2, 8)` ⇒ **任何路径都不越过 8** —— ⚠️ 2026-09-30 修复轮订正：原括注「第 4 次因上限不再加分」机制表述有误，结论不变）—— **不要**因「上界 4」把 cap 改成 16。             | 玩法 §3.1      |
| **C24** | `shared/src/ddz/bid.ts:28` + `:72`                   | `resetBidding` **双重推进 `currentBidder`**（`bid.ts:28` 推进一次，`:72` 再推一次）→ 流局后不回到座位 0，实测三轮流局起始座位为 `0 → 1 → 2`<br>**片① 订正（2026-09-30）**：R104「流局后一律回到座位 0」已被片① R1 作废（起始座位随机）。⚠️ 随机座位是**规格要求**（`docs/games/doudizhu.md` §3.1 v1.3），**不是 bug** —— 不要「修」回去。                                                                                                        | 玩法 §3.1      |
| **C25** | `room-service/src/match/match.service.ts:66`         | `zrange(... 'WITHSCORES')` 的返回每成员占 **2 个元素**，而判据是 `members.length < 3` → 实际只要求 **≥ 2 名玩家**即继续匹配（斗地主需 3 人），会提前用机器人填位                                                                                                                                                                                                                                                                                 | §8.1           |

> **已撤销的偏差：C21**（v1.1）
> 原记录为「飞机翅膀完全未校验」。玩法规格 `docs/games/doudizhu.md` §4.2 已由**严格派**改为**宽松派**（带牌一律允许 `2` 与王），并进一步对齐 DouZero 生成器（飞机带单允许对子/混合翅膀 + 4 三张特判），`rule.ts` 的行为与规格一致，**不再是偏差**。
> 保留此记录是为了防止后续有人按旧版把「翅膀禁止 2 与王」重新加回规格——那会与实现冲突。

| **C26** | `shared/src/ddz/settle.ts:18`、`GameSession`/`SettlementResult` | `baseScore` **硬编码 100**，且两个结构都**没有该字段** → 房间底分（§3.1 `Room.baseScore`）无法生效 | 玩法 §8.1 |
| **C27** | `game-service/.../game.service.ts`、`GameSession` | **无 `turnDeadlineAt` 字段** → 客户端无法显示倒计时，断线重连无法恢复本轮剩余时间 | 玩法 §9.2 |
| **C28** | `game-service/.../game.service.ts:177`、`room-service/src/gateway/ws.gateway.ts:176,180` | **叫抢阶段用 `currentPlayer` 定位超时行动者**，而叫抢期 `currentPlayer` 恒为 0（`bid.ts` 只动 `bidPhase.currentBidder`）→ `currentBidder ∈ {1,2}` 时超时 → `handleBid` 抛错被 `catch` 吞掉。**后果是严重的：错误被吞后既不 `clearTimer` 也不重挂（叠加 C22），该房间从此再无计时器、对局永久停摆**——不是「超时行为不对」，是「这一局再也走不动」。<br>⚠️ **位置列订正（P24/R610）**：原写 `ws.gateway.ts:176,180`（**漏了模块前缀**，且行号已过期 —— 那两行现在是**鉴权 fail-closed 判定**的注释）。R610 实测当前落点：`room-service/src/gateway/ws.gateway.ts:88-90` 的 `currentTurnPayload()`（`seat: view.state === 'bidding' ? view.bidPhase.currentBidder : view.currentPlayer`）。 | 玩法 §9.1 |

#### 架构类

| #   | 位置                                          | 偏差                                                                                                                                                                                           | 依据  |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A1  | `game-service/.../game.service.ts:22`         | 对局状态在**进程内 Map**，Redis 仅 fire-and-forget；`loadSession()` 是死代码                                                                                                                   | §10.2 |
| A2  | `api-gateway/src/gateway/proxy.gateway.ts:82` | ✅ **已关闭**（P8 复审）：`ProxyGateway` 已有 `@WebSocketGateway` 装饰器（`:82`），排队逻辑已实现（`:108` / `:204-210` / `:319`）→ **WS 代理不再是死代码**（用例 `proxy.gateway.test.ts:516`） | §6.1  |
| A3  | `room-service/src/gateway/ws.gateway.ts`      | `io = new Server()` **脱离 HTTP server**；无 `@SubscribeMessage`；`handleInternalConnect` 在**生产代码中 0 次调用**（仅 `ws.gateway.test.ts` 调用 1 次）                                       | §6.1  |
| A4  | `room-service/src/match/match.service.ts:53`  | `startMatchingLoop()` **从未被调用** → 匹配循环不启动                                                                                                                                          | §8.1  |
| A5  | `room-service/src/gateway/ws.gateway.ts:293`  | `subscribeToGameEvents()` **从未被调用**                                                                                                                                                       | §4.4  |
| A6  | `web/index.html:243,419,517`                  | 前端含规则引擎与回合驱动，**违反哑终端原则 F01/F05/F07**                                                                                                                                       | §12.5 |
| A7  | 全链路                                        | 服务间调用为裸 `fetch`，**无超时/重试/错误码传递**。**唯一例外**：`robot-service → douzero` 有 5s `AbortSignal`（`douzero.client.ts:55`）——注意方向是 robot→douzero，不是 game→douzero         | §4.3  |
| A8  | `room-service/src/rooms/rooms.service.ts:25`  | `findAll()` 使用 `KEYS`（生产环境阻塞命令）                                                                                                                                                    | §7.3  |

#### 工程类

| #       | 位置                                          | 偏差                                                                                                                                                                                                                                                                                                                                                                       | 依据             |
| ------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| E1      | `api-gateway/test/*`                          | **8/13 测试失败**；E2E 调用不存在的方法                                                                                                                                                                                                                                                                                                                                    | §13.5            |
| E2      | `user-service/src/main.ts:10`                 | 硬编码 `listen(3001)`，忽略 `PORT`                                                                                                                                                                                                                                                                                                                                         | §2.3             |
| E3      | `room-service/src/gateway/ws.gateway.ts:10`   | 心跳 10s/20s 且**另有应用层 `ping`/`pong`**（两套）                                                                                                                                                                                                                                                                                                                        | §6.1             |
| E4      | `shared/src/rule/autoplay.ts`                 | ✅ **已关闭**（切片 11，`11c42b6`/`32b1347`；P8 复审确认）：14 种牌型全覆盖；`Invalid` 分支返回**最小**单张；面对**王炸**返回 `null`（不再返回炸弹）；炸弹不得被拆；并已接上调用方（`handlePlayTimeout` 与 robot-service 的规则回退链）。判据：`autoplay.test.ts` 的 14 型用例表 + 通用自洽性断言（逐行断言 `parseHand(结果)` 合法**且** `canBeat(结果, 目标)`）+ 三条边界 | §9.3 / 玩法 §9.1 |
| E5      | `packages/*`                                  | 错误码**零落地**（硬编码字符串）                                                                                                                                                                                                                                                                                                                                           | §11              |
| E6      | `packages/*/src`                              | `Room` 缺 `cancelled` 状态与 `baseScore`/`timeoutAt`                                                                                                                                                                                                                                                                                                                       | §3.1             |
| E7      | `user-service`                                | `TypeOrmModule` 开启 `synchronize: true`                                                                                                                                                                                                                                                                                                                                   | §10.3            |
| E8      | `game-service/.../game.service.ts:51-52`      | `:51` 的注释称「检查 Redis 中的已有 session」，`:52` 实际**只查内存 Map**                                                                                                                                                                                                                                                                                                  | §7.4             |
| E9      | `robot-service/src/robot/robot.service.ts:25` | 机器人 ID 生成在此处（`bot-{uuid8}`），**不在** `match.service.ts`；`match.service.ts` 只做补位编排                                                                                                                                                                                                                                                                        | §9.2             |
| **E10** | `room-service/test/match.service.test.ts`     | **单测里有未 mock 的真实网络调用**：`MatchService.startGame()` 用的是**裸 `fetch`**（不是注入的 `HttpService`），而测试只 mock 了 `HttpService` → 该用例依赖 `localhost:3003` 可达。实测：容器运行时 30/30 通过；容器停止时 2 个用例各挂死 5 秒超时。**单测必须能在无外部依赖时通过**                                                                                      | §13.1            |

### A.3 处置约定

- 标记为 `[偏差]` 的条款，**以本文为准修实现**，不得反向修改本文。
- 若认为本文有误，走文档变更流程（修订本文 + 更新附录 A.1 裁决记录），**不得在代码中静默偏离**。
- S1–S7 安全类偏差未清零前，MVP 不得对外部署。
  - ✅ **该闸门已解除**（切片 7.2 收口，`0617152`）：S1–S8 **8/8 已关闭**，逐条证据见 `deviation-ledger.md` §1.3。⚠️ 「已关闭」≠「已验证」的项在台账里有明确标注（§4「无法确认的项」），不要把它们读成端到端覆盖。
- **状态判断的单向规则（P8 复审 / R402 立）**：**附录 A.2 是审计基准的历史快照**（见其头部说明），**当前状态的唯一真源是 `deviation-ledger.md`**。任何「某条现在关了没有」的问题，**一律查台账 §1.x**，不要读 A.2 的散文 —— 那张表的散文会随代码改动重新过期，而它**不是**真源。
