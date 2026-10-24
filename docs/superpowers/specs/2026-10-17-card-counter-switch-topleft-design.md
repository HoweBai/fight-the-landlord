# 记牌器：后台开关 + 左上角浮层 + 累积器生命周期修复

- 日期：2026-10-17
- 状态：设计已确认（用户裁决：左上角浮层，参考欢乐斗地主；收费另立片）
- 范围：纯客户端 + 配置中心；不动 `PlayerView` / 服务端对局逻辑

## 1. 背景与目标

当前记牌器（`apps/client/src/components/CardCounter.vue` + `composables/usePlayedCards.ts`）已能
按点数显示「外面剩余张数」，但存在三个问题：

1. **生命周期 bug**：累积器的 `watchEffect` 在牌桌页 `setup` 内创建，绑定组件 effect scope；
   本仓路由一律 `uni.reLaunch`（销毁旧页），离开牌桌后监听停止，而模块单例仍被复用 ⇒
   **第二局起记牌器数字冻结/残留上一局**（已用临时测试复现）。
2. **没有后台开关**：运营无法按玩法关闭该功能。
3. **展示位置不符参考产品**：当前入口收在「更多」菜单、面板为居中弹窗；目标是参考
   欢乐斗地主——牌桌左上角常驻一个小按钮，点开后显示顶部横向记牌条。

本期交付：修复 1、新增 2、重做 3。**收费（按局扣货币、购买后完整展示）不在本期**，
但开关与组件边界需为下一片留出扩展点。

## 2. 范围

### 本期做

- 修复累积器跨页面生命周期。
- 平台配置新增 `game.cardCounterEnabled`（严格 boolean，种子 `true`）。
- 管理后台「玩法 → 斗地主 → 对局辅助」页签内的开关。
- 客户端：`GET /api/config` 下发裸名 `cardCounterEnabled`；store 门控。
- 牌桌左上角按钮 + 锚定横条；从「更多」菜单移除记牌器入口。
- 相应测试迁移与新增（见 §7）。

### 本期不做

- 收费/购买/道具持有/按局扣费（另立片）。
- 服务端强制门控（旧客户端不认识新键，仍会显示记牌器——软门控，与既有配置键同口径）。
- 协议 `recentActions` 窗口扩展（重连后历史缺失仍是已知限制）。

## 3. 决策

| 编号 | 裁决 | 理由 |
|---|---|---|
| D1 | 配置键名 `game.cardCounterEnabled`，第 50 键，严格 boolean，迁移种子 `true` | 归属斗地主玩法；默认开保持现状，部署即等价 |
| D2 | 客户端子集裸名 `cardCounterEnabled`，第 18 键；客户端 fail-safe = `false` | 未知 = 不开放（C19 同族）；与 `friendRoomEnabled` 一致 |
| D3 | 后台 IA 放入斗地主域**新页签「对局辅助」**，不进「玩法规则」 | 玩法规则当前只有底分档位表（结构化编辑器）；辅助能力单独成页更清晰 |
| D4 | 入口 = 顶栏左侧「记牌器」小按钮；横条绝对定位在顶栏下方、左对齐 | 参考欢乐斗地主；不挤压顶栏中段底牌/倍数 |
| D5 | 横条只显示 15 列「点数 + 外面剩余张数」，倒序（大王→3） | 照参考图；旧弹窗的三家张数/手牌×N/说明退役 |
| D6 | 累积器 watchEffect 移入 detached `effectScope(true)` | 单例跨 `reLaunch` 存活；测试复位时 `scope.stop()` |
| D7 | 累积器内读 `store.cardCounterEnabled`：关 ⇒ 清空并跳过累积 | 开关关闭后不白跑；旧页面留下的单例也不会继续累积 |
| D8 | 结算到达时横条自动隐藏；再次点按钮可开合 | 与旧面板一致，避免盖住结算 |
| D9 | 「更多」菜单移除记牌器按钮，只留背包/托管/设置 | 单一入口，避免重复 |

## 4. 后台配置链路

### 4.1 protocol（`packages/protocol/src/config.ts`）

- `CONFIG_KEYS` 追加 `'game.cardCounterEnabled'`（第 50 键，数组末尾，附注释）。
- `parseConfigValue`：走 `parseStrictBoolean`（字符串 `'true'` / 数字均拒）。
- `CLIENT_CONFIG_KEYS` 追加裸名 `'cardCounterEnabled'`（放在 `version` 之前）。
- `ClientConfig` 增 `cardCounterEnabled: boolean`。
- `config.test.ts`：精确键清单 49→50、客户端子集 17→18；新增严格 boolean 用例。

### 4.2 config-service

- `client-config.controller.ts` 显式组装：
  `cardCounterEnabled: (byKey.get('game.cardCounterEnabled') ?? true) as boolean`
  （缺行默认与种子一致；玩家面形状恒为 18 键）。
- 新增迁移 `1795700000000-CardCounterSeed.ts`：INSERT 单键、`true`、version 1、updated_by seed；
  `down()` 精确删除。
- 测试夹具/精确清单同步：
  - `test/helpers/config-probe.ts`（seedDb 键值表）
  - `test/client-config.test.ts`（恰好 18 键 + 值断言 + 缺行默认）
  - `test/platform-config.service.test.ts`（`rows` 键集 = CONFIG_KEYS）
  - `test/admin.controller.test.ts`、`test/config.rpc.test.ts`（精确键清单）
  - `test/migration.test.ts`（导入新迁移；`up/down` SQL 正反向；时间戳 > 1795600000000 且全仓唯一）

### 4.3 admin（`admin/app.js` + `scripts/verify-admin-static.mjs`）

- `CONFIG_IA`：斗地主域新增页签
  `{ id: 'assist', name: '对局辅助', keys: ['game.cardCounterEnabled'] }`。
- `CONFIG_CONTROLS`：`'game.cardCounterEnabled': { label: '记牌器', type: 'bool' }`。
- `CONFIG_NOTES`：作用/取值/生效/注意四条；明确「客户端软门控、旧客户端仍显示、收费不在本键」。
- `scripts/verify-admin-static.mjs` 计数闸同步：
  - `protoSet.size` 49→50
  - `iaKeySet.size` 49→50
  - `CONFIG_CONTROLS` 44→45
  - `BOOL_KEYS` 16→17（加入新键）
  - 分类合计 16+1+27=44 → 17+1+27=45
- 后台注释中的「49 键 / 44 简单键 / 16 布尔键」表述同步。

### 4.4 客户端配置消费

- `stores/game.ts`：
  - 新增 state `cardCounterEnabled: false`（初值 fail-safe，文档注明）。
  - `setClientConfig()` 写入 `this.cardCounterEnabled = cfg.cardCounterEnabled === true`。
  - `reset()` **不清**该字段（与其它服务端下发配置同族）。
- `pages/lobby/lobby.vue`：
  - `FAILSAFE_CLIENT_CONFIG.cardCounterEnabled = false`。
  - `normalizeClientConfig()`：`raw?.cardCounterEnabled === true`。
  - 配置拉取失败路径保持 false（沿用现有 fail-safe 写入）。
- 生效时机：玩家下次进大厅拉取配置；已打开的牌桌不热更新（既有约定）。

## 5. 客户端 UI

### 5.1 入口按钮

- 位置：`table.vue` 的 `.table__bar-left`，紧跟「返回大厅」。
- 渲染条件：`store.cardCounterEnabled === true`。
- 形态：`<button type="button" class="btn btn--small table__counter">记牌器</button>`，
  带 `:aria-expanded="counterOpen"`。
- 行为：点击切换 `counterOpen`；与「更多」弹层互不自动关闭（可并存，但横条层级更低）。

### 5.2 横条（重写 `CardCounter.vue`）

- 挂载：`v-if="counterOpen && !store.settlement"`（与旧面板同让位条件）。
- 定位：`position: absolute`，以 `.table` 为基准；`top` = 顶栏高 `$ftl-bar-h` + 间距，
  `left` = 页面水平内边距 `$ftl-space-5`；`z-index: 5`（低于 MoreMenu/结算遮罩的 10、连接浮层的 20）。
- 结构：单行 15 列，倒序 `大王、小王、2、A、K、Q、J、10、9、8、7、6、5、4、3`。
  每列两行：点数（小字）+ 剩余张数（大字）。
- 数据：`computeRemaining(store.hand, tracker.played)`，语义不变
  （总数 − 我手牌 − 已打出；底牌不减）。
- 绝牌：`remain === 0 && inHand === 0` ⇒ 列/数字红色高亮（沿用旧判定）。
- 视觉：浅色（米白/浅灰）底、圆角、细描边；文字深色；与参考图同族的紧凑两行。
- 移除：标题、关闭按钮、三家张数头部、我手牌 ×N、底部说明。
- 无障碍：容器 `role="region"` / `aria-label="记牌器"`；数字用文本节点（可被测试读取）。

### 5.3 更多菜单

- `MoreMenu.vue`：删除「记牌器」按钮与 `counter` emit；网格保留 3 项（背包/托管/设置）。
- `table.vue`：删除 `onOpenCounter()`（入口直接在顶栏）；`counterOpen` 状态保留。
- 更新 `more-menu.test.ts`：按钮数 4→3、文本清单、无 `counter` emit。

## 6. 累积器修复（`usePlayedCards.ts`）

- 用 `effectScope(true)` 创建 detached scope，在其中创建 `watchEffect`：
  ```ts
  const scope = effectScope(true);
  scope.run(() => {
    watchEffect(() => { ... }, { flush: "sync" });
  });
  ```
- 监听逻辑新增开关闸：读 `store.cardCounterEnabled`；为 `false` 时清空 `played` 并直接返回。
- `lastRoomCode` 逻辑保留：`roomCode` 变化 ⇒ 清空。
- `__resetPlayedCardsForTest()`：`scope.stop()` 后置空单例；防止跨用例泄漏。
- 回归判据：
  1. 进桌 → 出牌 → 卸载牌桌 → 换房重进 → 新局出牌仍被记录；
  2. 换房清空仍生效；
  3. 开关 `false` 时累积器不记录，且从 `true` 切到 `false` 会清空。

## 7. 测试判据

### protocol

- `CONFIG_KEYS` 精确 50 键（新键在末尾）。
- `CLIENT_CONFIG_KEYS` 精确 18 键（`cardCounterEnabled` 在 `version` 前）。
- `parseConfigValue('game.cardCounterEnabled', true/false)` 通过；字符串/数字抛 `/boolean/`。

### config-service

- `GET /api/config` 键集恰好 `CLIENT_CONFIG_KEYS`；`cardCounterEnabled === true`（种子）。
- 缺行 ⇒ 默认 `true`。
- 迁移 `up()`：恰一条 INSERT、单 VALUE、json true、version 1、seed；
  `down()`：单条 DELETE；时间戳单调且全仓唯一。

### admin

- `verify-admin-static.mjs` 全绿（50/50、45 简单键、17 布尔键、44→45 分类合计）。
- 新键有非空 label、在斗地主域、有 CONFIG_NOTES。

### client

- **门控**：初始 `false`；配置到达 true 才渲染入口；拉取失败保持 false。
- **UI**：开关 on ⇒ `.table__counter` 存在；点击 ⇒ 横条出现；15 列倒序；
  剩余值正确；绝牌高亮；再次点击/结算 ⇒ 消失；开关 off ⇒ 入口与横条都不在 DOM。
- **更多菜单**：`.table__art-btn` 恰 3 个且文本为 `['背包','托管','设置']`。
- **生命周期回归**：卸载/重进后仍累积；换房清空。
- 现有 `card-counter.test.ts` 按新形态重写；`more-menu.test.ts` 与 `MoreMenu.vue`/`table.vue` 的注释同步。

## 8. 风险与边界

1. **精确计数闸多处联动**：protocol / config-service / admin 的键清单和计数断言必须同一次改齐，
   否则单测会以「差一」形式红。
2. **单例跨页 + 配置闸**：累积器读 store 的配置；测试夹具必须显式置 `cardCounterEnabled: true`
   才能看到累积，避免把「门控正确」误判成「累积坏了」。
3. **层叠**：横条 `z-index: 5`，低于 MoreMenu(10) 与连接浮层(20)；结算到达时由
   `v-if` 直接隐藏（不依赖层级让位），避免遮挡结算按钮。
4. **重连限制不变**：`recentActions` 窗口 2 ⇒ 剩余数只高估；本期不碰协议。
5. **收费扩展点**：未来在 `cardCounterEnabled` 之外增加「已购/本局有效」门控即可；
   横条组件不依赖购买态，本期不预埋假字段。

## 9. 涉及文件（预估）

- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/migrations/1795700000000-CardCounterSeed.ts`（新增）
- `packages/config-service/test/{client-config,platform-config.service,admin.controller,config.rpc,migration}.test.ts`
- `packages/config-service/test/helpers/config-probe.ts`
- `admin/app.js`、`scripts/verify-admin-static.mjs`
- `apps/client/src/stores/game.ts`、`apps/client/src/pages/lobby/lobby.vue`
- `apps/client/src/composables/usePlayedCards.ts`
- `apps/client/src/components/CardCounter.vue`（重写）、`MoreMenu.vue`
- `apps/client/src/pages/table/table.vue`
- `apps/client/test/{card-counter,more-menu}.test.ts`、新增门控/生命周期用例
