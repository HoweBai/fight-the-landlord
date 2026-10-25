# 跑得快 4 人场 · 设计 spec

> 日期：2026-10-25。分支：`dev`。范围：**客户端 4 人牌桌 + 动作窗口/余额投影修正 + 验证**。
> 取代 2 人场 spec 的 D6「4 人片只改能力表」与 D10「4 人仍提示并回大厅」。
> 依赖：2 人场片已把闸拆成 2/4 两键、客户端能力表与服务端 `supportedPlayerCounts` 取交集。

## 1. 背景与现状

引擎/房间/结算/记录/机器人已按 4 人参数化并有单测（48 张分 4 份×12、春天=三名输家都未出牌、
关牌/保本沿用）；4 人闸 = `game.paodekuai.nonThreePlayerEnabled`（上一片已收窄为只关 4 人）。

但**协议/视图还有两处 3 人假设**（设计审查阻断项）：

1. `projectRecentActions` 固定取最后 **2** 条；`validateOutbound` 对 pdk 也硬编码 `≤2`。
   4 人局「A 出牌、B/C 过牌、轮到 D」时窗口只剩两条过牌，跟牌目标丢失 ⇒ 客户端
   hint/target/passOnly、conformance 驱动、e2e 判据全部误判为首出。
2. 牌桌壳的 `balances` 投影写死 seat 0/1/2 ⇒ 4 人局 seat 3 的余额显示为底分占位。

客户端另有：能力表 `[2,3]`、`PdkBoard` 只画两个对手座。

## 2. 范围

**做**：pdk 动作窗口按人数参数化（2/3 人仍 2，4 人 3）；余额投影按人数；客户端 4 人布局
与能力表；4 人结算/历史回归；slice-29 4 人组；`pdk4` e2e；文档/后台备注。

**不做**：新配置键、新协议消息、服务端匹配/结算判定逻辑；4 人金币场真栈（登记缺口）；
4 人专属档位/风控归一化；4 人专属动画/音效。

## 3. 决策表

| # | 决策 | 依据/后果 |
|---|---|---|
| D1 | 客户端能力表改为 `[2, 3, 4]`；人数切换自动出现 2/3/4 | 能力表是客户端 UI 实现的唯一真源；服务端闸仍是最终权威 |
| D2 | 4 人布局 = **顶部对家一行** + 现有左/中/右一行；顶部行是 `.pdk` 列的直接子项 | 复用 Seat/PlayArea/TurnTimer；不塞进 `.pdk__mid`（那是 row flex） |
| D3 | 座位映射：左=(me+3)%4（上家）、右=(me+1)%4（下家）、上=(me+2)%4（对家）；`me=null` 时 4 人取左 3/右 1/上 2 | 与 3 人「左=上家、右=下家」同向；无名片视角也覆盖 1/2/3 |
| D4 | 不新增配置键；4 人闸复用 `nonThreePlayerEnabled` | 上一片已把语义收窄为「只关 4 人」 |
| D5 | 结算/历史/记录/机器人/好友房/金币场零逻辑改动 | 全部按 `playerCount` 数据驱动 |
| **D6** | **pdk 动作窗口 = `max(2, playerCount - 1)`**：2/3 人 2、4 人 3；斗地主不变 | 4 人「出牌 + 他人全过」后仍能看到目标；单一真源放 protocol，shared/game-service 共用 |
| **D7** | 牌桌 `balances` 按 `view.playerCount` 生成（缺省 3） | 修 4 人 seat 3 余额显示；斗地主零变化 |
| D8 | 牌桌壳「不支持人数」分支保留，用**合成 5 人视图直注 store** 做防御测试 | 协议只可能发 2/3/4；5 人不可达，测试层级 = store 级防御（需 cast） |
| D9 | conformance/e2e 覆盖 4 人；Docker 不可用则按源码级判据交付并登记 | 与 2 人场同一纪律 |
| D10 | 4 人金币场真栈、game-service 4 人整局记录单测登记为已知缺口 | 4 座结算/outbox/记录信封在 shared/room-service 已有单测；余额显示由 D7 修复 |

## 4. 实现设计

### 4.1 protocol / shared：动作窗口

- 新叶子模块 `packages/protocol/src/pdk/window.ts`（**无 import**，避免
  views↔validate 运行时环）新增：
  ```ts
  /** pdk 出站 recentActions 窗口：要容纳「一次出牌 + 其余所有玩家过牌」。 */
  export function pdkRecentActionsWindow(playerCount: number): number {
    return Math.max(2, playerCount - 1);
  }
  ```
  由 `packages/protocol/src/index.ts` 导出；validate 与 game-service 都从本包引用。
- `validateOutbound` 的 pdk 分支：`recentActions.length > pdkRecentActionsWindow(playerCount)` ⇒ 抛；
  错误文案带 `playerCount` 与窗口值。斗地主分支仍 `≤ RECENT_ACTIONS_WINDOW`。
- `packages/shared/src/ddz/recent.ts`：`projectRecentActions(session, windowSize = RECENT_ACTIONS_WINDOW)`；
  pdk 视图构建（`games/pdk/view.ts`）传 `pdkRecentActionsWindow(session.playerCount)`；
  斗地主视图构建不传（默认 2）。
- **窗口 3 对 4 人足够**：A 出 + B/C 过、轮到 D ⇒ 窗口含 A 的目标；A/B/C 全过后轮回到 A ⇒
  窗口只剩三次过牌，此时 A 本就该首出（无需目标）。斗地主的
  「窗口有非 null ⟺ lastPlayedHand 非空」不变式**不扩展到 pdk 4 人**；pdk 的首出/跟牌
  以服务端 `canPass` 与「窗口无非 null ⇒ 首出」为准。
- `views.ts` 注释改为「斗地主窗口 2；pdk 按人数（2/3→2、4→3）」；
  `docs/design.md` 的窗口说明同步。
- 测试：
  - protocol：窗口函数 2/3/4 → 2/2/3；4 人视图 3 条通过、4 条拒绝；
    **3 人视图 3 条拒绝**（窗口 2）、2 人视图 3 条拒绝；
  - shared：4 人「A 出、B/C 过」投影含 A 的非 null 目标、窗口 3；
  - game-service：4 人 pdk view 的 recentActions 长度 3、3 人最多 2；
  - client：4 人 PdkBoard 在「出牌 + 两次过牌」后仍按目标跟牌（见 §6）。

### 4.2 客户端能力表与余额投影

- `gameModes.ts`：`paodekuai: [2, 3, 4]`；注释改为「已实现 2/3/4」。
- `table.vue`：
  ```ts
  const balances = computed<Array<number | null>>(() => {
    const count = store.view?.playerCount ?? 3;
    return Array.from({ length: count }, (_, i) => store.seatBalance(i));
  });
  ```
  同步注释（不再写「三座」）。
  余额显示测试锚 `.seat__coin-value` 文本，金额取 < 10 万（避免「x.x万」缩写）。
- 头注释同步：`PdkBoard`、`table.vue`、`gameModes.ts` 不再写「首版只做 3 人」。

### 4.3 PdkBoard 4 人布局

- `seats`（左/右）：
  - 2 人 `[1]`（me=null）/ `[(me+1)%2]`；
  - 3 人 `[2,1]` / `[(me+2)%3,(me+1)%3]`；
  - 4 人 `[3,1]` / `[(me+3)%4,(me+1)%4]`。
- `topSeat`：4 人 `me===null ? 2 : (me+2)%4`，其余 `null`。
- 顶部行（`.pdk__top`，**`.pdk` 的直接子项**，在 `.pdk__mid` 之前）：
  `Seat class="pdk__seat pdk__seat--top"` + `TurnTimer` + `PlayArea`/「不出」；
  根加 `pdk--four` 修饰类，供 `.pdk__phase-overlay { top: 40% }` 避让顶部座位。
- `.pdk__mid--four` 缩小间距/内边距；`.pdk__play-col--top` 不反序、居中。
- 手牌/动作栏/托管/计时/结算逻辑不变；2/3 人布局零变化。
- 结构断言：4 人 `.pdk__seat` 恰 3、`.pdk__seat--top` 存在且**座位身份**正确
  （用 seatNames 断言 左=丁/右=甲/上=乙，me=0）；2 人 1 座无 top/`--four`；
  3 人 2 座无 top/`--four`。

### 4.4 结算/历史/壳

- `PdkSettlement` 数据驱动：4 行、名次 1–4；补 4 行单测。
- 历史页补 4 人夹具（「4 人局」）。
- 牌桌壳：4 人正常渲染（TablePage 级用例）；5 人合成视图（cast）⇒ 提示 + 带 roomCode
  尽力退房 + 回大厅（store 级防御）。

### 4.5 conformance / e2e

- `slice-29-paodekuai` 新增 4 人组（在 2 人组之后）：
  - `nonThreePlayerEnabled=false`，WS 匹配 `playerCount=4` 有界轮询 ⇒ 12012 + message 含「人数」；
  - PUT true，全新账号轮询 `POST /api/rooms` + `playerCount=4` 得 0；
  - 四个全新账号 `startPdkRoom({playerCount:4})`：各 12 张、`cardCounts/trustees` 长度 4、
    无扣牌字段；打到终局：赢家 1、结算 4 条零和、remaining 4 条、记录 `playerCount=4`、
    旧查询不含本房；
  - `setup.disable()` 一并复位 `nonThreePlayerEnabled=false`（与 2 人闸同纪律）。
- `browser-e2e.mjs`：新增 `--scenario pdk4`（一人 + 三机器人）：
  - `setupPdkEnabled(4)` 开 `enabled` + `nonThreePlayerEnabled`，`POST /api/rooms` 4 人轮询；
    此时 `/api/config` 的 `supportedPlayerCounts=[3,4]`，脚本按文本定位「4 人」，**不**断言三选项；
  - 选「4 人」→ 匹配（30s 补位窗口）→ 手牌 **12**（不再写死 16）、`.pdk__seat` 恰 3、
    `.pdk__seat--top` 存在且 bounding-box 在左右座上方 → 出牌/过牌（`canPass` 读
    `pdkCanPass`，不用窗口非空推断）→ 结算 4 行 → 返回大厅；
  - 收尾还原两键；现有 pdk 场景的 handSize/人数选择/清理全部参数化（2/3/4 共用）。

### 4.6 文档与后台

- `docs/games/paodekuai.md`：客户端已开放 2/3/4；配置表 `nonThreePlayerEnabled` 保持「4 人」。
- `admin/app.js` 的 `nonThreePlayerEnabled` 备注补「客户端已支持 4 人牌桌」。
- `docs/design.md`：窗口说明（ddz 2 / pdk 按人数）、2 人闸行补「客户端已支持 2/3/4」；
  键计数不变。
- `applyBalances`、e2e `READ_STATE`、`views.ts`、`shared/index.ts` 中「恰 3 条/窗口 2」注释同步。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 服务端 4 人闸关 | 不展示 4 人选项；直连 API/旧客户端 4 人 ⇒ 12012 |
| 关闸时在队 4 人票 | `processQueue` 整桶失败（已有，按人数通用） |
| 断线重进 4 人局 | 按 `view.playerCount` 渲染，顶部对家自动出现；窗口 3 恢复目标 |
| 旧服务端无 `games` | 只有 3 人（已有） |
| 合成 5 人视图 | store 级防御：提示 + 回大厅（协议入站先拒，不可达） |
| 小屏高度 | 顶部行占用纵向空间；12 张手牌更小；真浏览器实测，只调 CSS |
| 4 人金币场 | 余额显示由 D7 修复；真栈仍登记为缺口 |

## 6. 测试判据

- protocol：窗口函数 2/2/3；4 人视图 3 条通过、4 条拒绝。
- shared/game-service：4 人投影含目标；4 人 view 长度 3。
- client：能力表含 4；选择器 2/3/4；选 4 上行载荷 4；4 人座位身份/顶部行/12 张；
  4 人 hint/target/passOnly；2/3 人布局与座位身份回归；结算 4 行；历史 4 人；
  合成 5 人拒绝；4 人 seat 3 余额显示。
- conformance：4 人组负对照/成局/12 张/4 座零和/记录/旧查询全绿（真栈或登记）。
- e2e：`pdk4` 全绿（真栈或登记）。
- 全量：`turbo run test lint --force`（0 cached）+ `verify:admin` + client lint。

## 7. 风险

| 风险 | 处置 |
|---|---|
| 窗口参数化影响 3 人/斗地主 | 3 人/斗地主仍 2，回归断言；单一公式 |
| 顶部行挤压小屏 | 真浏览器实测；只调 CSS |
| 余额投影影响斗地主 | 缺省 3，斗地主零变化 + 回归 |
| 基线按静态计数偏差 | Docker 恢复后按实测校正 |
| 4 人金币场未真栈 | 已登记缺口 |

## 8. 涉及文件

- `packages/protocol/src/{views.ts,validate.ts,config.test.ts?}` + 视图/校验测试
- `packages/shared/src/ddz/recent.ts`、`recent.test.ts`、`index.ts`
- `packages/game-service/src/games/pdk/view.ts` + pdk view 测试
- `apps/client/src/{gameModes.ts,pages/table/table.vue,components/table/pdk/PdkBoard.vue}`
- `apps/client/test/{player-count,lobby-ux,pdk-board,pdk-hint,pdk-settlement,history-pdk}.test.ts`
- `tools/conformance/src/slices/slice-29-paodekuai.ts`、`baselines.json`
- `scripts/browser-e2e.mjs`
- `admin/app.js`、`docs/games/paodekuai.md`、`docs/design.md`

## 9. 设计对抗审查记录（2026-10-25）

独立 reviewer：**阻断 1 / 高 2 / 低 10**，全部处置。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 | recentActions 窗口 2 + 校验 ≤2 是 3 人假设 | D6/§4.1：按人数参数化（4→3），protocol 单一真源 |
| 高 | `balances` 写死 seat 0/1/2 | D7/§4.2：按 `view.playerCount` 生成 |
| 高 | 4 人判据缺座位身份/hint/target/TablePage 接受 | §4.3/§6：补身份与 4 人跟牌用例、TablePage 4 人接受 |
| 低 | e2e 写死 16 张/未参数化两键 | §4.5：handSize/人数/两键/清理参数化 |
| 低 | 5 人夹具需 cast、入站先拒 | D8：登记为 store 级防御 |
| 低 | 2/3 回归未钉座位身份/名缺席 | §4.3：seatNames + `--top`/`--four` 缺席断言 |
| 低 | me=null 的 4 人 seats 未定义 | D3：左 3/右 1/上 2 |
| 低 | 顶部行 DOM 归属/遮罩几何 | §4.3：`.pdk` 直接子项 + `pdk--four` 遮罩避让 + e2e bounding-box |
| 低 | 能力表翻转的既有测试未登记 | §8/计划逐文件列出 |
| 低 | `applyBalances`/e2e/views 注释仍写 3 条/窗口 2 | §4.6 同步 |
| 低 | 新 spec 未标注取代旧 D6/D10 | 文首已写 |
| 低 | 4 人金币场可达 + 余额缺陷 | D7 修余额；真栈仍登记 |
| 低 | PdkBoard 头注释未列 | §4.2 同步 |

**计划审查补充**（2026-10-25）：窗口函数放**叶子模块** `protocol/src/pdk/window.ts`
（views↔validate 运行时环）；T2/T3 顺序调整为先 PdkBoard 4 人布局、再能力表/余额；
protocol 增加 2/3 人负向回归（3 条必须拒）；4 人 hint/target 用例落 `pdk-board.test.ts`
（`pdk-hint` 不吃 recentActions）且用「含 ≤目标的牌」防假绿；余额断言锚 `.seat__coin-value`；
e2e 按文本选「4 人」且 `canPass` 读 `pdkCanPass`。
