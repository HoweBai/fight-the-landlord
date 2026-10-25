# 跑得快 4 人场 · 设计 spec

> 日期：2026-10-25。分支：`dev`。范围：**客户端 4 人牌桌 + 验证**。
> 依赖：2 人场片（`2026-10-25-pdk-two-player-design.md`）已把闸拆成 2/4 两键、客户端能力表
> 与服务端 `supportedPlayerCounts` 取交集。

## 1. 背景与现状

服务端/引擎/协议/房间/结算/记录/机器人**已按 4 人参数化并有单测**：
48 张分 4 份×12、春天 = 三名输家都未出牌、关牌/保本沿用；
4 人闸 = `game.paodekuai.nonThreePlayerEnabled`（2 人片已收窄为只关 4 人）。

客户端只差两处：

- 能力表 `CLIENT_TABLE_PLAYER_COUNTS.paodekuai = [2, 3]` ⇒ 服务端开了 4 也不展示；
- `PdkBoard` 只画左/右两个对手座 ⇒ 4 人视图会被当前壳放行（能力表若加 4），但没有第三个座位。

## 2. 范围

**做**：客户端 4 人布局与能力表；4 人结算/历史回归；slice-29 4 人组；`pdk4` e2e；文档/后台备注。

**不做**：新配置键、协议改动、服务端判定逻辑；4 人金币场真栈（与 2 人场同口径登记）；
4 人专属档位/风控归一化；4 人专属动画/音效。

## 3. 决策表

| # | 决策 | 依据/后果 |
|---|---|---|
| D1 | 客户端能力表改为 `[2, 3, 4]`；人数切换自动出现 2/3/4 | 能力表是客户端 UI 实现的唯一真源；服务端闸仍是最终权威 |
| D2 | 4 人布局 = **顶部对家一行** + 现有左/中/右一行 | 复用 Seat/PlayArea/TurnTimer；左/右语义不变；顶部放对家最易读 |
| D3 | 座位映射：左=(me+3)%4（上家）、右=(me+1)%4（下家）、上=(me+2)%4（对家） | 与 3 人「左=上家、右=下家」同向 |
| D4 | 不新增配置键；4 人闸复用 `nonThreePlayerEnabled` | 上一片已把语义收窄为「只关 4 人」，后台标签已是「开放 4 人」 |
| D5 | 结算/历史/记录/机器人/好友房/金币场零逻辑改动 | 全部按 `playerCount` 数据驱动 |
| D6 | 牌桌壳的「不支持人数」分支保留，判据改为能力表；用合成 5 人视图做防御测试 | 服务端协议只可能发 2/3/4，5 人不可达但保留 fail-closed |
| D7 | conformance/e2e 覆盖 4 人；Docker 不可用则按源码级判据交付并登记 | 与 2 人场同一纪律 |
| D8 | 4 人金币场真栈、game-service 4 人整局记录单测登记为已知缺口 | 4 座结算/记录在 shared/room-service 已有单测；真栈由后续观察期补 |

## 4. 实现设计

### 4.1 客户端能力表

`apps/client/src/gameModes.ts`：

```ts
export const CLIENT_TABLE_PLAYER_COUNTS = {
  doudizhu: [3],
  paodekuai: [2, 3, 4],
} as const; // 现有实现已是 Readonly<Record<GameType, readonly number[]>>
```

注释从「4 人片落地前」改为「已实现 2/3/4」。
`table.vue` 的注释同步（不再写「只实现 3+2」）。

### 4.2 PdkBoard 4 人布局

- `seats`（左/右）按人数：
  - 2 人：`[(me+1)%2]`；
  - 3 人：`[(me+2)%3, (me+1)%3]`；
  - 4 人：`[(me+3)%4, (me+1)%4]`。
- 新增 `topSeat`：仅 4 人 = `(me+2)%4`（`me=null` 时取 2）。
- 新增 `topAction = actionOf(topSeat)`；模板顶部一行：
  `Seat` + `TurnTimer` + `PlayArea`/「不出」，仅 `topSeat !== null` 时渲染。
- 中段加 `pdk__mid--four` 修饰类（缩小间距/内边距，给顶部行让高）。
- CSS：`.pdk__top` 水平居中、`flex: 0 0 auto`；`.pdk__play-col--top` 不反序。
- 手牌/动作栏/托管/计时/结算逻辑不变；2/3 人布局零变化（回归断言钉住）。

### 4.3 结算/历史/壳

- `PdkSettlement` 数据驱动：4 行、名次 1–4 自动成立；补 4 行单测。
- 历史页已显示「N 人局」，4 人记录自动成立；补一条 4 人夹具断言。
- 牌桌壳：能力表包含 4 后不再拒绝 4 人；「不支持人数」分支用 5 人合成视图验证
  （仍带 `roomCode` 尽力退房 + 回大厅）。

### 4.4 conformance / e2e

- `slice-29-paodekuai` 新增 4 人组（在 2 人组之后）：
  - 显式 PUT `nonThreePlayerEnabled=false`，WS 匹配 `playerCount=4` 有界轮询 ⇒ 12012 + message 含「人数」；
  - PUT true，用**全新账号**轮询 `POST /api/rooms` + `playerCount=4` 得 0；
  - 四个全新账号经 `startPdkRoom({playerCount:4})`：各 12 张、`cardCounts/trustees` 长度 4、
    无扣牌字段；打到终局：赢家 1、结算 4 条零和、remaining 4 条、记录 `playerCount=4`、
    旧查询（无 gameType）不含本房；
  - 收尾：`setup.disable()` 一并复位 `nonThreePlayerEnabled=false`（与 2 人闸同纪律）。
- `browser-e2e.mjs`：新增 `--scenario pdk4`（一人 + 三机器人）：
  - 开 `enabled` + `nonThreePlayerEnabled`，`POST /api/rooms` 4 人轮询生效；
  - 选「4 人」→ 匹配（30s 补位窗口）→ 12 张、`.pdk__seat` 恰 3、顶部行存在 →
    出牌/过牌 → 结算 4 行 → 返回大厅；收尾还原两键。
- 基线：按实跑回填；Docker 不可用则按源码静态计数（零 skip、固定 4 客户端循环）。

### 4.5 文档与后台

- `docs/games/paodekuai.md`：客户端已开放 2/3/4；配置表 `nonThreePlayerEnabled` 说明保持「4 人」。
- `admin/app.js` 的 `nonThreePlayerEnabled` 备注补一句「客户端已支持 4 人牌桌」。
- `docs/design.md` 的 2 人闸行补「客户端已支持 2/3/4」；键计数不变（无新键）。
- `packages/shared/src/pdk/doc-sync.test.ts` 无需改（键未变）。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 服务端 4 人闸关 | 不展示 4 人选项；直连 API/旧客户端 4 人 ⇒ 12012（已有） |
| 关闸时在队 4 人票 | `processQueue` 整桶失败（已有，按人数通用） |
| 断线重进 4 人局 | 按 `view.playerCount` 渲染，顶部对家自动出现 |
| 旧服务端无 `games` | 只有 3 人（已有） |
| 合成 5 人视图 | 壳提示并回大厅（防御，不可达） |
| 小屏高度 | 顶部行占用纵向空间；12 张手牌更小，e2e 真浏览器实测；必要时只调 CSS |
| 4 人金币场 | 本期无真栈；单测覆盖 4 座结算/outbox |

## 6. 测试判据

- client：能力表含 4；选择器 2/3/4；选 4 上行 `playerCount=4`；4 人牌桌 3 个对手座 +
  顶部行 + 12 张；2/3 人布局回归；结算 4 行；历史 4 人标签；合成 5 人拒绝。
- conformance：4 人组负对照/成局/12 张/4 座零和/记录/旧查询全绿（真栈或登记）。
- e2e：`pdk4` 判据全绿（真栈或登记）。
- 全量：`turbo run test lint --force`（0 cached）+ `verify:admin` + client lint。

## 7. 风险

| 风险 | 处置 |
|---|---|
| 顶部行挤压小屏 | 12 张手牌更小；真浏览器实测；只调 CSS，不改结构 |
| 4 人布局影响 2/3 人 | 2/3 人分支零改动 + 回归断言 |
| 基线按静态计数偏差 | Docker 恢复后按实测校正 |
| 4 人金币场未真栈 | 已登记缺口 |
| 运营误开 | 4 人闸默认 false；后台备注写明客户端已支持 |

## 8. 涉及文件

- `apps/client/src/gameModes.ts`
- `apps/client/src/components/table/pdk/PdkBoard.vue`
- `apps/client/src/pages/table/table.vue`（注释/能力表消费）
- `apps/client/src/components/PdkSettlement.vue`（仅测试）
- `apps/client/src/pages/history/history.vue`（仅测试）
- `apps/client/test/{player-count,lobby-ux,pdk-board,pdk-settlement,history-pdk}.test.ts`
- `tools/conformance/src/slices/slice-29-paodekuai.ts`、`tools/conformance/baselines.json`
- `scripts/browser-e2e.mjs`
- `admin/app.js`（备注）
- `docs/games/paodekuai.md`、`docs/design.md`
