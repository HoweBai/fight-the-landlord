# 玩法大厅页 + 开始游戏页 · 设计规格

> **日期**：2026-09-27 · **状态**：待用户复核
> **上位依据**：`docs/superpowers/specs/2026-09-26-app-ui-rework-design.md` —— §3.2（片② 交付物）·
> §4.1/4.2/4.5（协议①②⑤）· §5.2.1（**视觉语言定稿**，两页照抄）· §6.2/6.3（两页形态）· §7.1（判据记账）
> ⚠️ **本文件只补上位规格没定的、以及订正它与本片冲突的** —— 不重复它，避免第二真源。
> **为什么这两页合成一片**：它们是**同一条流程的两步**（大厅选完就进开始游戏页），
> 而且协议②⑤（选底分真正生效）**只有开始游戏页用得上** —— 切开会留下「选了没用」的中间态
> （登录页样板那一课）。做完这一片，**前厅三页齐了，只剩牌桌**。

---

## 1. 范围与交付物

| 层 | 交付 | 不做 |
|---|---|---|
| DB | `base_score_levels` 表 + 缺省数据（**TypeORM 迁移**） | —— |
| 服务端 | 读接口 · `room.match` 带 `baseScore` · `POST /api/rooms` 校验 · 一条 TCP RPC | 后台写接口 |
| App | **大厅页**重做（顶栏 + 左玩法竖滚 + 右底分横滚）· **开始游戏页**重做（中央开始 + 好友房弹层） | 牌桌 · 后台页面 |

**另立一片**：后台设置页面（写接口 + 权限）—— 它是**独立子系统**，不属于「App 界面重做」这条线。

---

## 2. 服务端设计

### 2.1 架构：表存 `user-service`，`room-service` 通过 **TCP RPC** 读

三条路都核过实测代价：

| | 表存哪 | room-service 怎么读 | 代价 |
|---|---|---|---|
| A | room-service 自己的库 | 直连 | TypeORM + `data-source` + `migrations/` + 启动跑迁移 + compose `DB_HOST` + health 探测。🔴 **且两个服务对同一个库跑迁移会争同一张 `migrations` 表**（`migrationsRun: true`）⇒ 静默互相跳过 |
| **B ✅** | **user-service 的库**（**已有全套**迁移基础设施） | **TCP RPC**（`Transport.TCP`） | user-service 加一个微服务监听 + 一个 `@MessagePattern` 控制器；room-service 加一个 client。**形态在 `game.client.ts` / `robot.rpc.controller.ts` 有现成样本** |
| C | user-service 的库 | **不读**，只做范围校验 | 🔴 **不可接受** —— `unitScore = baseScore × multiplier` ⇒ **底分是结算数值的输入**；让客户端自选任意值 = 让客户端影响结算（现在无货币，将来有） |

⇒ **B**。它保住规格要求的严格性，且 **`room-service` 的依赖格局不动**（继续纯 Redis）。

⚠️ **B 也不是零成本 —— 它要新增一个依赖**（我第一版没写）：
`user-service/package.json` **只有 `@nestjs/core`，没有 `@nestjs/microservices`**（`game-service` 有，因为它是 RPC 服务端）。
⇒ 给 user-service 加 TCP RPC = **新增 `@nestjs/microservices`** + **`pnpm-lock.yaml` 要变**
（⚠️ `scripts/ci.sh` 第 1 阶段是 `pnpm install --frozen-lockfile` ⇒ lockfile 必须同 PR 更新）。

⚠️ **已知语义债（如实记）**：配置数据**寄居在「用户服务」里**。这是为「不新造一套 DB 基础设施」付的代价。
真正的解是独立的 config 服务 —— 等**后台那一片**再评估。

### 2.2 表结构

```
base_score_levels
  id          INT PK AUTO_INCREMENT
  name        VARCHAR(32) NOT NULL          -- 场次名（中文）
  base_score  INT         NOT NULL
  sort_order  INT         NOT NULL          -- 横滑顺序
  enabled     TINYINT(1)  NOT NULL DEFAULT 1
  UNIQUE KEY (base_score)                   -- 底分不重复
```

🔴 **刻意不加 `mode` 列**（我一度加过，审掉了）—— 理由见 §7「已知未来项」。

- 建表靠 **TypeORM 迁移**（`user-service` 已有 `migration:run` + `synchronize:false` + `migrationsRun:true` 全套）
- **缺省数据写在迁移脚本里**：休闲场 15 / 标准场 80 / 竞技场 480 / 豪侠场 1200

### 2.3 读接口

| 项 | 定 |
|---|---|
| 路由 | **`GET /api/base-score-levels`** ⚠️ **订正**：上位规格 §4.1 写的是 `GET /api/rooms/options` —— 改名，因为它**打到 user-service**，叫 `rooms/options` 会让人找错服务 |
| 响应 | `{ code: 0, data: { levels: [{ name, baseScore }] } }`，**只返 `enabled=1`、按 `sort_order`** |
| 鉴权 | **要**（不在网关公开白名单的五条里） |
| 🔴 **不缓存** | **每次查库**（表小、进大厅才调一次）。**进程内缓存会把「后台改了要生效」变成「改了要重启」** |
| 网关路由顺序 | ⚠️ 静态路由必须**先于**同前缀的根路由（`health.controller.ts:7` 记着同类坑） |
| `docs/design.md` §7.1 | 🔴 路由表加这一条，且加在 **user-service** 那组（不是 rooms 那组） |
| RPC 端口 | ⚠️ user-service 的 RPC 端口**只能在 compose 内网可达** —— **`expose`，不是 `ports`**（照 game/robot 的处理） |

### 2.4 协议 ② ⑤ + 一个规则常量

| 改动 | 定 |
|---|---|
| **②** `room.match` 加 `baseScore` | 🔴 **必填**。可选的话撮合 key 那一维可能是 `undefined`、产生两种 key；**必填让「不同底分的人不会同房」在类型上就成立**。`matchQueueKey(mode, baseScore, region)` 多一维，`MatchTicket` 带上它并穿到 `addToQueue` / `cancelQueue` / `processQueue` / `failMatch`；机器人补位也拿房间的底分 |
| **⑤** `POST /api/rooms` 校验 `baseScore` | 必须属于档位表；否则 `10001 BAD_PARAM`（**既有码，不新造**） |
| 🔴 **RPC 失败不得静默放行** | 拿不到档位表 ⇒ **`10007 UPSTREAM_UNAVAILABLE`，请求失败**。**绝不能**「拿不到就跳过校验」—— 那是非法值绕过校验的后门 |
| 🔴 **`DEFAULT_BASE_SCORE` 100 → 15** | 它现在**不属于**档位表（15/80/480/1200），而上位规格 §4.1 自己写的判据是「`DEFAULT_BASE_SCORE` 属于档位表」—— **不改它那条判据当场红**。改在 `packages/shared/src/ddz/game.ts:12`。⚠️ **影响面必须逐个核，不许说「小」**（我第一版就是那么说的，被自己审掉）：<br>· `rooms.service.test.ts:77,80` —— 读常量 ⇒ **自动跟随** ✅<br>· `rooms.start.test.ts:215` `expect(start.baseScore).toBe(100); // DEFAULT_BASE_SCORE` —— **注释逐字说它就是缺省** ⇒ **会红，必须改**<br>· `game.service.test.ts:49,226` ✅ **复核订正（2026-09-27）**：**不受影响** —— 夹具在 `:33`/`:56`
  **显式传** `baseScore: 100`，而 `game.service.ts:174` 是
  `dto.baseScore > 0 ? dto.baseScore : DEFAULT_BASE_SCORE` ⇒ 走不到缺省支。
  （原文留的「要逐个核」已回填结论，不留悬空项。）<br>· `match.service.test.ts:863` 的 `// 旧实现恒为 100` 是**注释**，不受影响 |

⚠️ **词义提醒**：本仓的 **`mode` 已经指「房间模式」**（`room.match.payload.mode` = `random`/`practice`、`RoomInfo.mode` 同）。
**不要再引入第二个叫 `mode` 的东西**（我一度把「玩法」也叫 mode，审掉了）。

### 2.5 判据要点

- **RPC**：每处出站调用必须**带超时**（`outbound-timeout.gate` 是既有闸）· handler 返回 `RpcResult<T>` 信封（**不抛**业务错误，照 R220）
- **路由**：`/api/base-score-levels` 可达 + **静态先于根**的顺序
- **档位表**：非空 · 底分唯一 · `DEFAULT_BASE_SCORE` 属于它
- **撮合**：**不同底分不会被撮进同一个房** —— ⚠️ 用例必须有判别力（不能只测「同底分能撮上」）
- **非法 `baseScore` 被拒**：`room.match` 与 `POST /api/rooms` **两条路都要测**
- 🔴 **「改了即生效」用真栈判据**（不是源码级断言 —— 那是测形态）：
  > 改 DB 里一行 → **不重启** → 再调 `GET /api/base-score-levels` → 拿到新值。
  ⚠️ **这条可能要新增一条 conformance 切片**（`tools/conformance/src/run.ts` 的 `CASES` + `baselines.json`）。
  若新增，必须**一起**做：加切片 + 改 `baselines.json` **两列**（`render` 与 `full`）+
  **首次 CI 绿跑之后回填条数** + **切片总数 17 → 18**。计划里要显式列这几步。

---

## 3. 大厅页

对照参考图 1（上位 §6.2 已定）+ 三处本片裁决：

| 参考图 | 我们 |
|---|---|
| 顶部 头像+昵称+金币+钻石 | 顶栏左：头像 + 昵称 + **货币占位 `—`**（不可点，D12） |
| 左 玩法列表（7 项竖滚） | 左：玩法列表（**1 项**竖滚）—— 列表容器，加第二个只加数据 |
| 右 底分卡（4 档） | 右：**底分档位横滚**（§2.3 的接口） |
| 右上 道具/设置 | 🔴 **订正**：顶栏右**只放「退出」**（登出是真功能，不能丢）。**设置齿轮等有功能再加** —— 本仓明文忌讳「点了没反应的活按钮」 |
| 「热门」「最近」角标 | ❌ 不做（没有第二个玩法） |

### 🔧 裁决一：**流转**

> **点玩法 → 只切换选中**（右侧底分跟着换）；**点底分卡 → 进开始游戏页**。

⚠️ **这是行为变更**：现在点玩法卡是 `enterMode(id)` → **直接跳页** ⇒ `.lobby__mode` 的语义从「进入」变成「选中」。
**`lobby-ux` / `page-stack` 的判据要改** —— 这是本片**最大的一处判据改动**，计划里要逐个列。

### 🔧 两页之间的接口：选中的玩法与底分都存在 `game` store

| 状态 | 现状 | 本片 |
|---|---|---|
| `activeMode` | **已有**（`lobby.vue` 的 `enterMode` 写它，`game.vue` 读它） | 保留，但**写它时不再跳页** |
| `selectedBaseScore` | **不存在** | **新增**（与 `activeMode` 同族：跨页状态归 store，不归页面局部 ref —— 这是本仓既有纪律） |
| `baseScoreLevels` | **不存在** | **新增**：大厅取一次（§2.3 的接口），**开始游戏页复用它查场次名**（不重复调接口）。⚠️ 这是两页的**第二个接口**，我第一版漏了 |

⇒ 「大厅→开始游戏页」不通过路由参数传值（`auth.navigate` 只切页），**通过 store** —— 与 `activeMode` 完全同形。

### 🔧 裁决三（复核订正 2026-09-27）：顶栏「头像 + 昵称」的**数据来源**

⚠️ **原文的漏洞**：§3 与上位 §6.2 都写了顶栏有「头像 + 昵称 + 货币占位 `—`」，但**只有货币有出处**
（D12）—— 头像和昵称**一个字没写**从哪来。而当时的 `auth` store 只留了 `userId`
（登录响应里的 `phone`/`nickname` 到手就被丢掉了）⇒ 下一个人读到这里**无从判断该不该打接口**。

**用户裁决（2026-09-27）**：

| 件 | 定 |
|---|---|
| **昵称** | 🔴 **最终形态（执行期裁决 2026-09-27）**：走**登录响应**里的 `user.nickname` / `user.phone`，**持久化**进本地会话（`StoredSession` 加 `phone`/`nickname` 两个键）。显示是**三级回落** `nickname → phone → userId`，落在 `auth.displayName` 这个 getter 上。<br>⚠️ **原方案（走 `GET /api/users/me`）已被实测否决**：那条路由在网关上**恒 401** —— `proxy.gateway.ts` 的 `forward()` 逐字只组装四个内部头、**从不转发 `Authorization`**，而 user-service 的 `users.controller` 挂的是 passport-jwt 守卫（**必须** Bearer）。⇒ **客户端不发这条请求**（`docs/client-protocol.md` §2 因此**仍是八条**）。详见交接文档 §4 与计划 Task 2R |
| **头像** | **静态兜底图** `src/static/ui/default.png`（片① 已入库、D13 授权范围内）。服务端**今天不下发**头像 URL ⇒ 没有「按用户取头像」这回事（**不造数据源**） |
| **货币** | 恒为 `—`（D12），**不打接口、不编数字**（M10：前端不含任何货币逻辑） |

⚠️ **两页都要显示这一组**（大厅顶栏 / 开始游戏页左下）⇒ 抽**共用件** `PlayerChip.vue`，
**不写两遍**（与 `SessionNotice.vue` 同一条理由：写两遍会各自过期）。

---

## 4. 开始游戏页

对照参考图 2（上位 §6.3 已定）：

- 左上「返回大厅」—— ⚠️ **文案逐字保留**（探针按文本匹配）
- 左下 头像 + 昵称 + 货币占位
- 中央 场次名 + 「底分 N」（场次名**从档位表按 `baseScore` 查**）
- 中央「**开始游戏**」大按钮 = **随机匹配**，带上选中的底分（协议②）
- **「好友房」二级入口**

### 🔧 裁决二：「好友房」= **弹层**（不是子页）

里面是「创建房间 / 输房号 / 房间列表」三件（现在平铺在页面上）。

**为什么弹层**：不新增路由 —— 页面栈的唯一真源是 `auth.page`，加一页要动 `pages.json` + `auth.page` 联合类型 + `page-stack` 判据，而那套东西片③ 刚重构过。且它本来就只是次要入口。

⚠️ **判据影响面**：`auth-ui-wiring`（房间列表渲染，现在要断言「在弹层里」）· `settlement-rematch`
（**数着 `game.vue` 里 `send('room.match'` 的调用点 —— 必须仍是一处**）。

---

## 5. 判据改动记账（🔴 上位 §7.1 要求的纪律）

| 受影响的判据 | 为什么 | 改完还测不测得到原性质 |
|---|---|---|
| 🔴 **真浏览器探针 `scripts/browser-e2e.mjs`（**复核订正 2026-09-27：**4 处，不是 2 处**）** | 本片最重的一处。**两处是 `.lobby__mode` 的点击**（`:451` 与 `:550`，点完不再跳页 ⇒ 干等 20 秒超时）；⚠️ **另两处是同一份规格的另外两条裁决咬到的**：`:464` 的 `clickByText('.game__match .btn', '随机匹配')`（§4 要求按钮文案改成「开始游戏」，而 `clickByText` 是 `textContent.trim() ===` **精确**匹配 ⇒ `not-found`）、`:554` 等 `.game__create-room`（§4 要求建房收进弹层 ⇒ 关着时**不在 DOM 里** ⇒ 20 秒超时）。🔴 **「两处」是我写漏了，实测 grep 才补全** | 计划的**第一步就该改它**：改完必须**真跑**一遍（它是真浏览器判据，不是单测）。⚠️ 本仓历来对探针的改动很慎重（片② 的全局约束曾写「探针本片零改动」）⇒ 要**逐个调用点**说明改法与理由。**新加的那条「点玩法卡不跳页」要写清射程**：它守的是**旧行为**（谁改回去谁红），**不**证明「选中真的生效了」（`activeMode` 的默认值恰好是唯一那张卡的 id ⇒ 「卡上有选中态」恒真） |
| `lobby-ux` 的**建房/房号/列表三组** | 🔴 复核订正：`.lobby__mode` 语义从「进入」变「选中」（§3）**只打到 `lobby-modes`**；`lobby-ux` 受影响的是**另一件事** —— 三个入口移进弹层（§4） | 计划里**逐条**写明 |
| 🔴 **`lobby-ux` 的 R658/R760 组（`:596-661`，两条）** | **复核订正**：`match()` 改成用**用户选中的底分**之后，那两条「挂载即兑现再来一局」的用例不预置 `selectedBaseScore` 就会早退 ⇒ 以「0 条 `room.match`」变红。**规格与计划初稿都漏了它** | ✅ 判据一条没少（无意向 ⇒ 不发、有意向 ⇒ 恰好一条、读后即清、幂等）。预置值取 **80** 而非 15 —— 15 区分不出「取第一档」与「用选中的」 |
| **`page-stack`** | ⚠️ **复核订正：实为「不受影响」，不列入本片影响面**。`page-stack.test.ts` 全文**零** `.lobby__mode` 引用 —— 它只查 `usePageAlignment` / `auth.page` / `pages.json` / 单根，而本片四页与 `auth.page` 都不动 | ✅ 不动。原文把它列为受影响是**多算了一条**（保守方向、无害，但记账表要准） |
| `auth-ui-wiring` | 房间列表移进弹层（§4）⇒ 6 条挂 `GamePage` 的用例读 DOM 前要先开弹层；4 条档位表失败用例**搬家**（fetch 归大厅了） | 同上 |
| `settlement-rematch` | 数 `send('room.match'` 的调用点 | **仍须恰好一处** |
| 受 `DEFAULT_BASE_SCORE` 影响的判据 | 值 100→15 | ✅ **复核订正：已在计划 A 逐个核完**（原文留的「待核」已回填）—— `rooms.start.test.ts:215` 顺手改成**读常量**；`game.service.test.ts:49,226` 的 `toBe(100)` **不受影响**，因为夹具在 `:33`/`:56` **显式传** `baseScore: 100`（`game.service.ts:174` 是 `dto.baseScore > 0 ? dto.baseScore : DEFAULT_BASE_SCORE` ⇒ 走不到缺省支）；`match.service.test.ts:863` 的「旧实现恒为 100」是注释 |
| `docs/design.md` §7.1 路由表 | 新增一条（且在 **user-service** 组） | —— |
| `tools/conformance`（**若**新增切片） | 「改了即生效」是真栈判据 | 加切片 + `baselines.json` **两列** + 条数回填 + 总数 17→18（§2.5）。⚠️ **计划 B 的结论：不新增**（那是服务端性质、属计划 A 的遗留）⇒ **这条性质目前只有一次性人工验证、没有永久闸**，如实记为已知缺口 |

⚠️ **反例纪律**：不接受「把断言改绿」。每条改动都要写清「**为什么改 + 改完还测不测得到那个性质**」。

### 复核订正（2026-09-27 pre-flight）：判据影响面**多出来的两条**

| 受影响的判据 | 为什么 | 改完还测不测得到原性质 |
|---|---|---|
| ⚪ **`packages/api-gateway/**`（曾加又撤）** | 原表把「昵称来源」当成了**零服务端改动** —— 实测网关**没有** `GET /api/users/me`（404）。用户裁决先补路由，随后又因**鉴权链走不通**（网关不转发 `Authorization`、user-service 要 Bearer ⇒ 恒 401）**整段撤销** ⇒ 终态是**逐字节还原**（`packages/` 净 diff 为空），改回登录响应持久化 | ✅ 网关的**终态**与基线完全一致，不需要新判据；`docs/design.md` §7.1 那句「`/api/users/*` 代理到下游」是**假话**，已按实况改成「网关不暴露 `/api/users/*`」 |
| 🔴 **`tools/mock-server/test/rest.test.ts`（新增）+ `apps/client/.env.mock`** | 原表完全没有 mock 这条线。补 mock 的 REST 面**不足以**让「对着 mock 跑通」成立：`.env.mock` 的 `VITE_API_BASE` 指 `/api`，而 vite 代理写死到真网关 ⇒ 浏览器里一条都到不了 | ✅ 新增 6 条（两条 GET 的形状 / 404 / CORS / 预检）+ Task 7 Step 7 的**真浏览器**验证（curl 通 ≠ 浏览器通） |

---

## 6. 验收

| 层 | 判据 |
|---|---|
| 机械 | `pnpm run ci` 六阶段全绿 |
| 🔴 **真浏览器探针** | `scripts/browser-e2e.mjs` 改完后**真跑一遍**（它在大厅→玩法页那两处必然要改，见 §5） |
| **真栈** | 「改了即生效」（§2.5）· 撮合按底分分组 · 两条路的非法 `baseScore` 被拒 |
| **人眼** | 真浏览器截图：大厅（含横滑底分）· 开始游戏页 · 好友房弹层 —— **与参考图 1/2 并排** |
| 视觉 | 照抄上位 §5.2.1 的语言（半透明面板 / 金主按钮 / 分段选中控件…） |

---

## 7. 已知未来项（写下来，免得下一个人踩）

- 🔴 **加第二个玩法时，要连「玩法 id 从哪来」一起定**。现在 `GAME_MODES` 是**前端单一真源**（片③ 裁决），
  而服务端**没有「玩法 id」这个概念**（`RoomInfo.mode` 是**房间模式**，不是玩法）。
  ⇒ 我一度给档位表加了 `mode` 列 + 接口加了 `mode` 参数，**审掉了** —— 那会凭空造一个
  **跨前后端的约定**，两边不一致就是**静默空列表**，且没有任何闸能保证一致。
  **1 个玩法时「该玩法的底分」= 全局，全局即等价**；等真有第二个玩法，那个片要一起解决 id 的来源。
- **配置表寄居在 user-service**（§2.1 的语义债）—— 后台那一片再评估是否独立成服务。
- **后台设置页面**（写接口 + 权限）另立一片。
- 🔴 **「改了即生效」没有永久闸**（复核订正 2026-09-27）：§2.5 那条只有**一次性**的真栈人工验证
  （§6.1 ②），**没有 conformance 切片**。⇒ 它是**已知缺口**，不是「已覆盖」。
  要闭合得加一条切片（`run.ts` 的 `CASES` + `baselines.json` **两列** + 条数回填 + 总数 17→18）。
- **mock 的 REST 面只覆盖只读**（复核订正 2026-09-27）：片② 客户端给 `tools/mock-server`
  补了两条 GET（档位表 / 房间列表，**含 CORS/预检，并把 `.env.mock` 的 `VITE_API_BASE` 指到 mock 自己**
  —— 少了后两样，浏览器里一条都到不了）。但 **`POST /api/rooms`（建房）与
  `POST /api/rooms/:code/join`（占座）仍然不存在** ⇒ 对着**纯 mock** 时「好友房」的两条动作
  跑不通（列表能出来、点进去 404）。要闭合得再加两条写接口 + 一张内存房间表。
- 🔴 **`docs/design.md` §7.1 那句话曾经是假的**（复核订正 2026-09-27）：原文写着
  「HTTP 路由：`/api/auth/*`、`/api/users/*` 代理到下游」，而网关**从来没有** `/api/users/*`
  这条前缀路由（实跑 `GET /api/users/me` ⇒ `404 {"code":10001}`）。
  ⇒ 本片**先补了** `GET /api/users/me`、**随后又整段撤销**（鉴权链走不通，见 §3 裁决三），
  终态是**逐字节还原**「网关不暴露 `/api/users/*`」。**记下来的理由**：那句假话在一个 pre-flight 里
  把我自己骗过一次（我据此写了「零服务端改动」），下一个读的人也会被骗。

---

## 6.1 验收记录（2026-09-27 真栈实测）

**环境**：本机 Docker Desktop · `docker compose up -d --build`（**必须 rebuild** —— 本片改了 compose 与 `package.json`）
· **8 容器全 healthy**。

| # | 判据 | 结果 |
|---|---|---|
| ① | `GET /api/base-score-levels` 返回四档 | ✅ `[休闲场15, 标准场80, 竞技场480, 豪侠场1200]`（**同时自证容器是本次构建的** —— 旧镜像没有这条路由） |
| ② | 🔴 **改了即生效**：改 DB 一行 → **不重启** → 再调 | ✅ 改 `休闲场`→`休闲场✻` 后接口**立刻**返回新值；还原亦然。`HEX(name)` 确认四档都是正确的 UTF-8 |
| ③ | 非法底分被拒 —— **REST 路径** | ✅ `POST /api/rooms {baseScore:999}` ⇒ `10001 「底分不属于档位表」` |
| ③′ | 非法底分被拒 —— **WS 路径** | ✅ `room.match {baseScore:999}` ⇒ **`10001`**（不是 `13001` —— Task 3c 的 WS 映射修复**在真栈上端到端生效**）；缺字段 ⇒ `10001` |
| ③″ | 正/负对照 | ✅ `baseScore:15` ⇒ `code 0` 且房底分 15；**不传** ⇒ `code 0` 且**底分为 15**（证明 `DEFAULT_BASE_SCORE` 现在属于档位表） |
| ④ | 🔴 **全套 conformance（17 片）** | ✅ **全部通过**。首轮 13 过 4 红（`-boundary`/`-hardening`/`-deploy`/`-rpc`），**四片全是 `fetch failed`** ⇒ 查得 `robot-service:3005` 的**宿主映射在运行容器上丢了**（override 文件里明明有）⇒ `docker compose up -d --force-recreate` 后**四片各 82/103/143/67 全过** ⇒ **栈状态、不是代码缺陷** |
| ⑤ | `check-baselines full` | ✅ 17 片全 ≥ 基线；唯一例外 `slice-07.5-backup` 实测 **182 < 196** —— **182 正是本机预期值**（196−14：本机无 `flock`(11) 与伪 TTY `script(1)`(3)，那 14 条**显式跳过**；跳过不算通过，只有 CI 是 196） |
| ⑥ | 真浏览器探针 | ✅ **18/18**。其中 [12]「随机匹配 → `game.deal` 被客户端接受」正是 **Task 3f 客户端改动的端到端证据**（⚠️ 它走的是**旧** UI 路径「点玩法卡跳页」—— 那一步是**计划 B** 才改的，本片没动它） |

### ⚠️ 验收方法本身的两条坑（记下来，别再踩）

- **本机跑全套 conformance 会把栈改坏**：17 片里有切片按**生产形态**重建过栈 ⇒ **后续依赖宿主端口的切片会 `fetch failed`**。
  ⇒ **处置**：跑完全套后若见 `fetch failed`，先 `docker compose up -d --force-recreate` 再单跑那几片，**别急着往代码上归因**。
- **`docker compose exec mysql` 改中文必须带 `--default-character-set=utf8mb4`** —— 否则写进去就是乱码
  （我第一次就踩了，接口回的是 `ä¼‘é—²åœº`）。
