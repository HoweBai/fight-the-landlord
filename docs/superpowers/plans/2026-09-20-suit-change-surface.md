# 花色改动面清单（`tsc` 反推，R706）

> **本文件由 `tsc` 产出，不是人工列举。**
> 依据：`docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md` §3.4（R706）。
> 每一条都必须能追到一次真实的 `tsc` 报错；追不到的须说明它属于 spec §3.5 的三类之一
> （类型断言绕过 / 运行期静默退化 / 注释与文档过期）。

**基线 commit**：`7a97f28`（Task 1 的改动尚未提交时）
**生成时刻**：2026-09-20 19:35:49
**测量命令**：`pnpm --filter @fight-the-landlord/protocol build && pnpm -r --no-bail lint`
**唯一报错点**：**84**（原始 171 行，去重后 84 处）

---

## ⚠️ 两条必须知道的前提

### 1. 必须先构建 `protocol`，否则清单是假的

`packages/protocol/package.json` 的 `"types": "./dist/index.d.ts"` —— 下游包解析的是 **`dist/` 里的声明文件**，不是 `src/`。

**第一次跑 `pnpm -r lint` 时全部报 `Done`（零报错）** —— 因为 `dist/` 是 9-18 的旧构建（那时还是 `number[]`）。是 Step 11 的自证判据（三个包的报错计数必须 > 0）抓到了这一点。

⇒ **任何一次重跑清单，都必须先 `pnpm --filter @fight-the-landlord/protocol build`。**

### 2. 改动面是**逐层增长**的，不是一次出全

修好一层，下一层才浮出来。两个已证实的例子：

- `packages/game-service/src/game/game.controller.ts:102`（**人类出牌的唯一 HTTP 入口**，DTO 写着 `cards: number[]`）**不在本次清单里** —— 因为 `shared` 的 `handlePlayCards` 此刻还吃 `number[]`，两边一致所以不报错。**Task 2 改完 shared 之后它才会报。**
- `apps/client/src/components/{PlayArea,BottomCards,Seat,Hand}.vue` 也不在 —— 因为 `stores/game.ts` 先断了，组件链还没轮到。

⇒ **每个 task 收尾时必须重跑一次 `pnpm -r --no-bail lint`，把新增的报错追加到本文件。** 清单的闭环在 Task 8 Step 3。

---

## 判据自证（Task 1 Step 11）

`tsc` 输出里三个包的报错计数 —— **任一为 0 都说明该包没被覆盖，清单是假的**：

| 包 | 报错计数 | 判定 |
|---|---|---|
| `packages/shared` | **16** | ✅ > 0 |
| `packages/game-service` | **3** | ✅ > 0 |
| `apps/client` | **48** | ✅ > 0 |

---

## 后端（37 处）

### `packages/shared`（16 处）

> ⚠️ **本清单不含 `src/card/card.ts`** —— `Rank.Rank2` 此刻还是 15，`createDeck()` 也还没改。那些改动是 Task 2 主动做的（spec §2.5 的地雷），**不是 `tsc` 报出来的**。它的可抓性由 `card.test.ts:37-40` 的单测保证（见计划 Task 2 Step 2）。
>
> 🔴 **执行期发现（2026-09-20，Task 2 Step 1–2 实测）：spec §2.5 规定的解法是错的。**
>
> v1–v4 一直写着「硬要求：循环上界改成 `Rank.RankA`」。实测**两次红**才逼出正确形态：
>
> | 上界 | 产出 | 结果 |
> |---|---|---|
> | `<= Rank.Rank2`（原样） | 3..17 = 15 点 × 4 + 2 王 = **62 张** | 红（含非法值 15/16） |
> | `<= Rank.RankA`（**spec 原文的规定**） | 3..14 = 12 点 × 4 + 2 王 = **50 张** | **仍然红**（**四张 2 全丢**） |
> | **3..`RankA` 循环 + 2 与王各自单 push** | **54 张** | ✅ 绿 |
>
> 根因：`Rank2 = 17` 与 `RankA(14)` **不再连续**，单一上界覆盖不了全部点数。
>
> **四路独立复核都没抓到这一条** —— 因为它不是引用错误或计数错误，是**规定的解法本身不对**。抓住它的是 `card.test.ts` 的 `creates 54 cards`。
>
> spec §2.5 与 §11-2 已据此订正。

| 文件:行 | 报错 |
|---|---|
| `src/ddz/game.ts:2` | `has no exported member 'toDouZero'` |
| `src/ddz/game.ts:2` | `has no exported member 'toInternalRank'` |
| `src/ddz/play.ts:7` | `has no exported member 'RANK_2'` |
| `src/ddz/play.ts:7` | `has no exported member 'toInternalRank'` |
| `src/ddz/play.ts:106` | `Type 'number[]' is not assignable to type 'Card[]'` |
| `src/ddz/features.ts:75` | `Type 'Card[]' is not assignable to type 'number[]'` ← **AI 契约的投影边界**（spec §11-6） |
| `src/ddz/features.test.ts:31` | `Type 'number' is not assignable to type 'Card'` |
| `src/ddz/play.test.ts:69 / 86 / 87 / 187 / 330 / 377 / 392 / 402 / 416` | 夹具 `GameSession` 形状不符（9 处） |

### `packages/game-service`（3 处）

| 文件:行 | 报错 |
|---|---|
| `src/game/view.builder.ts:82` | `Type 'number[]' is not assignable to type 'Card[]'` |
| `src/game/view.builder.ts:84` | `Type 'number[] \| null' is not assignable to type 'Card[] \| null'` |
| `src/game/game.service.ts:613` | `Argument of type 'Card' is not assignable to parameter of type 'number'` |

### `packages/robot-service`（8 处）

| 文件:行 | 报错 |
|---|---|
| `src/robot/bot.player.ts:4` | `has no exported member 'toDouZero'` |
| `src/robot/bot.player.ts:92` | `Argument of type 'Card[]' is not assignable to parameter of type 'number[]'` |
| `src/robot/bot.player.ts:110` | 同上 |
| `src/robot/bot.player.ts:122` | `Card[]` → `number[]`；**且左右两侧都是算术运算非法**（`Card` 相减 = `NaN`，见 spec §3.5-B） |
| `src/robot/bot.player.ts:123` | `Card[]` → `number[]` |
| `src/robot/bot.player.ts:141` | `Argument of type 'number' is not assignable to parameter of type 'Card'` |

> ⚠️ **与 spec §3.5-E 的订正不完全一致**：spec 说受影响区间是 `:139-148` 与 `:150-151`，实测是 `:92 / :110 / :122 / :123 / :141`。**以 `tsc` 为准**（spec 的行号来自另一版读取）。

### `packages/room-service`（2 处）

| 文件:行 | 报错 |
|---|---|
| `test/ws.gateway.test.ts:600` | `Type 'number' is not assignable to type 'Card'` |

> ✅ **源码侧确实零改动**（spec §3.4 的判断成立）：`src/gateway/game.client.ts`、`src/gateway/message.router.ts` 都没报错，是纯透传。**但 v3 的清单里 `room-service` 连一行都没有** —— 漏的正是这个夹具。

### `tools`（8 处）

| 文件:行 | 报错 |
|---|---|
| `tools/mock-server/src/index.ts:179` | `Argument of type 'Card[]' is not assignable to parameter of type 'number[]'` ← **v3 漏** |
| `tools/mock-server/src/scripted-game.ts:105` | `Type 'number[]' is not assignable to type 'Card[]'` |
| `tools/mock-server/src/scripted-game.ts:177` | 同上 |
| `tools/mock-server/src/scripted-game.ts:180` | `number[] \| null` → `Card[] \| null` |
| `tools/conformance/src/lib/ddz-driver.ts:24` | `has no exported member 'toInternalRank'` |
| `tools/conformance/src/slices/slice-09-play-rotation.ts:64` | 同上 |
| `tools/conformance/src/slices/slice-10-settlement.ts:54` | 同上 |
| `tools/conformance/src/slices/slice-11-robot-system.ts:69` | 同上 |

> ⚠️ **`tools/conformance` 只报了 4 处**，而 spec §11-7 说「碰卡牌形状的切片恰好 9 个」。差别的来源：那 9 个是**按 grep 命中**算的，`tsc` 只报**类型真断**的。**两者都要处理**——grep 命中的（如 `sameHand` 的 `Number(c)`）属于 §3.5-B 的运行期静默，`tsc` 抓不到。

---

## 客户端（48 处）

### ⚠️ 预存在、与本片无关（1 处）

| 文件:行 | 报错 |
|---|---|
| `src/main.ts:46` | `TS7016: Could not find a declaration file for module './App.vue'` |

**判定为预存在**，依据：全仓**没有** `declare module '*.vue'` shim（实测 `grep` 零命中），`main.ts:46` 是 `src/*.ts` 里**唯一** import `.vue` 的地方，而 `main.ts` / `App.vue` / `env.d.ts` / tsconfig 在本片都**未被触碰**。`.vue` 的模块解析与 `Card` 类型无关。

⇒ **不在本片修**。但它会让 `pnpm --filter @fight-the-landlord/client lint` **永远非零退出**，Task 7 的验收必须**扣除这一条**后再判定。

### 源码（3 处）

| 文件:行 | 报错 |
|---|---|
| `src/stores/game.ts:98` | `Type '{r,s}[]' is not assignable to type 'number[]'` |
| `src/stores/game.ts:103` | `Type '{r,s}[] \| null' is not assignable to type 'number[] \| null'` |
| `src/pages/table/table.vue:119` | `No overload matches this call` |

### 测试（44 处）

| 文件 | 处数 | 行 |
|---|---|---|
| `test/reconnect-flow.test.ts` | 18 | 88, 138, 192, 230, 242, 303, 345, 391, 399, 438, 445, 609, 624, 644, 807, 887, 892, 893 |
| `test/snapshot-version.test.ts` | 7 | 24, 28, 35, 37, 47, 49, 196 |
| `test/table-play-ui.test.ts` | 4 | 57, 58, 59, 192 |
| `test/action-feedback.test.ts` | 4 | 92, 93, 94, 183 |
| `test/card-hand-interaction.test.ts` | 3 | 60, 61, 77 |
| `test/table-ended-ui.test.ts` | 2 | 70, 71 |
| `test/table-bid-bottom.test.ts` | 2 | 206, 373 |
| `test/table-settlement-ui.test.ts` | 1 | 65 |
| `test/table-bid-ui.test.ts` | 1 | 244 |
| `test/settlement-rematch.test.ts` | 1 | 117 |
| `test/helpers/fake-socket.ts` | 1 | 102 |

> ⚠️ **`test/helpers/fake-socket.ts:102` 是源头夹具**（`playerViewFixture`），它一改，下游多处会连带变化。**先改它。**
>
> ⚠️ 这与 spec §5 说的「18 个测试文件命中手牌断言」不同 —— 那 18 个是**按 grep 命中**算的（含只读 `.length` 的、形状无关的），`tsc` 只报**类型真断**的 11 个。**两者都要看**：grep 命中的里面还藏着 §3.5-B 的运行期静默（如 `.join(',')` 与 `-` 相减，`tsc` **不报**）。

---

## `tsc` 看不见的清单（spec §3.5，本片必须单独处理）

以下是**已确认存在、但 `tsc` 不报**的改动点。列在此处以防「清单全绿 = 改完了」的误判。

| 类别 | 位置 | 状态 |
|---|---|---|
| A 类型断言绕过 | `game-service/src/rpc/game.rpc.controller.ts:84` 的 `as {...}` | 待 Task 3 处理 |
| A 类型断言绕过 | `game-service/src/game/game.service.ts:138` 的 `JSON.parse(data) as GameSession` | 待 Task 3 评估 |
| B 运行期静默 | `apps/client/src/pages/table/table.vue:81-86` 的 `join(',')` 指纹 | 待 Task 7，须加判据 |
| B 运行期静默 | `apps/client/src/components/Hand.vue:49` 的 `a - b` 排序 | 待 Task 7，须加判据 |
| B 运行期静默 | `tools/conformance` **4 个**切片的 `sameHand`/`sorted` 用 `Number(c)` | 待 Task 6（spec §1.2 #6：**4 个**，不是 1 个） |
| B 运行期静默 | `apps/client/test/helpers/comment-stripping.test.ts:88-89` 死条目拷贝 | 待 Task 7 |
| B 运行期静默 | `apps/client/test/card-hand-interaction.test.ts:298,305` 死条目 | 待 Task 7 |
| B 运行期静默 | `apps/client/test/source-boundary.test.ts:96` **与 `:281`** 两处 | 待 Task 7 |
| C 注释过期 | `tools/conformance/src/slices/slice-09-play-rotation.ts:26` 描述 `createDeck` 的注释 | 待 Task 6 |
| C 文档 | `docs/games/doudizhu.md` 的「内部 Rank」5 处 + `:46`/`:436` | 待 Task 8 |
| C 文档 | `docs/design.md` §3.6(`:343`) 与 `:1762` | 待 Task 8 |

---

## 测试计数基线（Task 6 Step 3 / Task 7 Step 3 冻结）

> ⚠️ **必须实测，不得照抄任何文档或台账。** 台账里的计数来自不同日期。

| 范围 | 测量时刻 | commit | 实测值 |
|---|---|---|---|
| conformance 13 切片（逐条计数） | | | |
| `apps/client`（passed / skipped） | | | |

---

## 收口复核（Task 8 Step 3）

- [ ] 清单每一条都已处理
- [ ] 实改的文件都在清单里（不在的须说明它从哪条 `tsc` 报错追出，或属于 spec §3.5 的哪一类）
- [ ] 三个判据自证计数均 > 0
- [ ] 每个 task 收尾时重跑的 `tsc` 新增项都已追加

---

## 增量记录

> 每完成一个 task，先 build protocol + shared，再 `pnpm -r --no-bail lint`，把新增项追加到这里。
> 这是 Global Constraint 里那条「清单逐层增长」的落点。

### 各 task 收尾时的重跑

#### Task 2 收尾（`shared` 改完后重跑）

**唯一报错点 84 → 73**。分布变化（这正是「逐层增长」的实证）：

| 包 | 前 | 后 | 新增了什么 |
|---|---|---|---|
| `packages/game-service` | 3 | **5** | `cardToInt`/`intToCard`/`Card` 不再由 `shared` 导出（3 条）；`game.service.ts:288` 与 `:679` 把 `number[]` 传给 `Card[]` |
| `packages/robot-service` | 8 | **11** | `Card`/`cardToInt`/`intToCard` 不再由 `shared` 导出 |
| `packages/room-service` | 2 | 1 | （原两条合并为一条夹具报错） |
| `packages/shared` | 16 | **0** | ✅ 已收敛 |
| `apps/client` / `tools/*` | 48 / 8 | 48 / 8 | 未变（尚未轮到） |

**新暴露的一条传导链**（Task 3 必须知道）：

```
game.controller.ts:102 的 DTO (number[])  →  game.service.ts 的方法参数 (number[])  →  handlePlayCards(Card[]) ✗
                                                    ↑ 报错现在停在 :288 / :679
```

⇒ **修好 `:288`/`:679` 会强制 `game.service` 的签名改变，控制器那处（v3 的清单完全没列、v4 的清单也只在「高发区提醒」里提过）才会浮出来。** 这就是「清单由 `tsc` 反推」而不是一次列全的原因。

#### Task 3 收尾（`game-service` 改完后重跑）

**唯一报错点 73 → 68**。`packages/game-service` **归零**（5 → 0）。

| 包 | Task 2 后 | Task 3 后 | 说明 |
|---|---|---|---|
| `packages/game-service` | 5 | **0** | ✅ 已收敛（含两个入口的 DTO） |
| `packages/robot-service` | 11 | 11 | 未动（下一个就是它） |
| `apps/client` / `tools/*` / `room-service` | 48 / 8 / 1 | 48 / 8 / 1 | 未动 |

**这一轮验证了传导链的预测**：修 `game.service.ts:288/:679` → 强制 `actAndView` 载荷类型变 → **两个入口同时浮出**（`game.controller.ts:102` 的 DTO、`game.rpc.controller.ts:84` 的 `as`）。v3 的清单里前者**一行都没有**。

#### Task 4 收尾（`robot-service` 改完后重跑）

**唯一报错点 68 → 57**。`packages/robot-service` **归零**（11 → 0）。

| 包 | Task 3 后 | Task 4 后 |
|---|---|---|
| `packages/robot-service` | 11 | **0** ✅ |
| `apps/client` | 48 | 48 |
| `tools/mock-server` / `tools/conformance` | 4 / 4 | 4 / 4 |
| `packages/room-service` | 1 | 1 |

**这一轮的关键区分：AI 契约保持 rank-only。** `bot.player.ts` 里有**两类**牌形状，改法相反：

| 位置 | 形状 | 处理 |
|---|---|---|
| `PlayerView.hand` / `bottomCards` / `lastPlayedHand.cards` | `Card[]`（R696） | 直接用；展示/规则侧吃 `Card` |
| `DouZeroContext.hand` / `bottomCards` | **`number[]`**（AI 契约） | 投影 `.r` |
| `RobotDecideResponse.cards` | **`number[]`**（AI 契约） | 投影 `.r` |
| `handStrength(hand: number[])` | **`number[]`**（数的是点数构成） | 调用处投影 `.r` |
| `isPlausible(cards: number[], view)` | `cards` 是点数、`view.hand` 是 `Card[]` | 把 `view.hand` 投影成点数**多重集**再比 |

⇒ **判据是「谁的数据契约」而不是「谁在传牌」**。`toCards()`（把点数**编造**成牌的那层）与 `shared` 的 `douzeroIntToCard` 是双胞胎，一并删除。

另外清掉一处 R695 残留：`handStrength` 里的 `toDouZero(15)`（旧的双编码换算）+ 两个恒等的 `toDouZero(20)/(30)`，改成直接用 `DOUZERO_2`。

#### Task 5 收尾（`room-service` + `api-gateway` 改完后重跑）

**唯一报错点 57 → 56**。`packages/room-service` **归零**（1 → 0）；`api-gateway` **全程零报错**（源码与测试都是纯透传，spec §3.4 的判断成立）。

**这一轮订正了清单里的一处判断，并补了一处清单没有的项。**

① **清单说那几处透传用例「不再覆盖任何合法载荷形状」—— 实际比这更严重。**
`room-service` 的 `routeClientMessage` 会先用 `validateClientMessage` 校验入站消息，夹具写裸数字（`cards: [3, 4]`）会**直接返回 `10001`**，**根本走不到转发那一步**。所以它们不是「覆盖力弱」，而是**已经失效且会红**（实测 2 处）。修法给夹具加 `asCards()`。

② **清单没有的项：`GameClient.action` 的载荷参数是 `Record<string, unknown>`。**
这与 `as` 断言**同族** —— 编译器不校验形状（spec §3.5-A 那一类）。`tsc` 不报它，因为它本身是合法的宽类型。
已收紧为 `{ grab?: boolean; cards?: Card[]; baseVersion?: number }`，**当场逼出两处陈旧夹具**（`game.client.test.ts:106` / `:234`）—— 正是清单里点名却「编译不报」的那两个位置。

⇒ **教训**：`Record<string, unknown>` / `any` / `as` 是同一类「形状逃逸口」，`tsc` 对它们**一律沉默**。清单的 §3.5-A 只收了 `as`，应收全这三种。

#### Task 6 收尾（`tools`：mock-server + conformance）

**mock-server 归零**（4 → 0，lint 干净、2 passed、build 通过）。
**conformance 类型层归零**（4 → 0，但实际改动面是 **32 处**，见下）。

**计划低估了这一块：清单说 8 处，实际 32 处。**

清单（和 `tsc` 初次输出）只看到 `toInternalRank` 那 4 个 import。但驱动函数的签名是
`number[]`，改成 `Card[]` 之后**级联进所有切片** —— 每个切片都从 `view.hand` 取牌、
再把牌传给 `game.play`。改对了吗？我认为是：只改 import 而把驱动保持 `number[]`，
则**每个调用点**都要写一次 `.map(c => c.r)` 再写回去，反而更糟。

**三处值得记：**

**① `slice-11` 的 `Number(c)` 与 spec 预测的**方向相反**。**
spec §3.5-B 说 `Number({r,s})` 的后果是「`!sameHand` 变红、`sameHand` 假绿」。
但 `slice-11` 那处不是 `sameHand` —— 它是 `keyRank` 校验：
`internalRanks = cards.map(c => toInternalRank(Number(c)))` ⇒ `[NaN, …]` ⇒
`internalRanks.includes(keyRank)` **恒 false** ⇒ **每一次检查都误报违反**（假红）。

⇒ 同一根因（形状变了、断言没跟着变）可以有**两个相反的**表现。清单只写了假绿那半边。

**② `slice-11` 有一条检查在 R695 之后**本身已过时**。**
`if (lph.keyRank === DOUZERO_2_CODE) violations.push('keyRank=17 是 DouZero 编码…')`
—— 它针对的是「内部 Rank 的 2 = 15」那套口径。R695 之后 `keyRank = 17` **正是正确的**，
这条留着会误报每一次合法出牌。已连同 `DOUZERO_2_CODE` 常量一起删除。

**③ `sorted()` 的替换必须**幂等**。**
四处副本里，`sorted()` 的产物**会被存起来再传回 `sameHand()`**
（`const aHand = sorted(dealA.hand)`），还有地方读它的 `.length`。
所以新实现既要处理原始 `Card[]`，也要处理已经是键的 `string[]` —— 否则第二遍会
产出 `"undefined-undefined"`。这条是 `tsc` 逼出来的（`hardening.ts:537` 的类型错）。

#### Task 3：`game-service` 的执行期发现（三处，含一个 `tsc` 看不见的真缺陷）

**1. 一个 `tsc` 看不见的真缺陷 —— `handlePlayCards` 的第二个摘除循环。**

`play.ts` 里原本有**两个**循环：一个校验、一个真正摘牌。Task 2 只改了前者，后者仍是

```ts
const newHand = [...session.players[playerIdx].hand];
for (const card of cards) {
  const idx = newHand.indexOf(card);   // Card 对象 ⇒ 引用相等 ⇒ 恒 -1
```

⇒ **牌从来没被摘掉**：手牌不减、胜负不判、终局视图不发。
`indexOf` 用在 `Card[]` 上是**合法 TypeScript**，`tsc` 不报、既有闸不报 —— 抓住它的是 `game.service.test.ts` 的 N17（终局必须发一版 `state === 'ended'` 的裁剪视图）。

修法是**把两个循环合成一个**（校验那次摘除的结果直接写回），这个形态就结构上不可能再出现。

**2. R697 的判据自证做了「变异实验」，并因此改掉一条没有判别力的用例。**

spec §9.3 的三条正负对照此前**缺失**，Task 3 补上了。补完做变异（把精确匹配退回「按点数摘」）验证判别力，结果：

- ①（送同点数不同花色的牌）→ **变红** ✓
- ②（送两张完全相同的牌）→ **没红** ✗

② 的初版夹具是「手里只有一张 5」，而按点数摘在**第二次也会耗尽** ⇒ 两种语义都拒 ⇒ **它不具判别力**。改成「手里有 5 的两张**不同花色**」之后，按点数摘会**错误接受**，② 才变红。

⇒ **这条记在这里的意义**：`R377` 说的「死条目让零命中变假绿」有一个近亲形态 —— **用例存在但两种语义下都通过**。不跑变异实验是发现不了的。

**3. `game.controller.test.ts` 的用例名承诺了「disjoint」却从未断言。** R696 之前断言不了（DouZero 不带花色，三家手牌数值上必然重叠）；现在可以了，已补「三家 51 张 `(r,s)` 互不相交」。

#### Task 2：`join(',')` 指纹退化的活标本

`bid.test.ts` 的流局用例原本用 `p.hand.join(',')` 做「重发后手牌变了」的指纹。改成 `Card[]` 后它产出 `"[object Object],[object Object],…"` —— **对所有同长度手牌恒等**，于是断言「变了」**永远不可能通过**，判据彻底失去判别力。

**这与 spec §3.5-B 给 `table.vue` 记的是同一个形态**（后者是「同长度换牌不清空选中」）。修法一致：换成 `` cards.map(c => `${c.r}-${c.s}`).join(',') ``，并在测试里抽成具名 `fingerprint()` 助手。

> ⚠️ 提醒 Task 7：`table.vue:81-86` 与 `bid.test.ts` 是**同一类**，改法照抄即可。而且 `bid.test.ts` 这条是**实测红过的**（不是推演），可以直接引为「该形态确实会失效」的证据。

#### Task 6 的 conformance 实测（2026-09-21，13/13 全绿）

**先重建镜像再跑**（旧镜像里是变更前的代码，不重建等于测了个寂寞）：
`docker compose build` 带 proxy build-arg → 8 容器 healthy → 逐个 `node dist/run.js <slice>`。

| 切片 | 本次 | P9 基线 | 判定 |
|---|---|---|---|
| `slice-05` | 29 | 29 | ✅ |
| `slice-06` | **114** | 「通过」（无计数） | ⚠️ 计数不稳定，见下 |
| `slice-07` | 39 | 39 | ✅ |
| `slice-07.1` | 28 | 28 | ✅ |
| `slice-08` | 55 | 55 | ✅（修好后与基线一致） |
| `slice-09` | 160 | 160 | ✅（修好后与基线一致） |
| `slice-10` | 185 | 185 | ✅ |
| `slice-11` | 50 | 50 | ✅ |
| `07.2-security` | 43 | 40 | ⚠️ +3，见下 |
| `07.2-boundary` | 82 | 82 | ✅ |
| `07.2-hardening` | 103 | 103 | ✅ |
| `07.2-deploy` | 104 | 104 | ✅ |
| `07.2-rpc` | 65 | 65 | ✅ |

**两处差异的解释（都不是缺陷）：**

- **`slice-06` 的计数不稳定**：同一份代码，跑在**第一个**时 44 项、跑在 `slice-05` 之后时 **114** 项。
  它的断言随**房间列表里有多少房间**增长（前面的切片留下一批房间）。
  ⇒ **不得拿它做「计数不得下降」的比对** —— 那是拿一个会随环境变动的量当基线。
  台账 P9 把它记成「通过」而非数字，现在看是**对的**。
- **`07.2-security` 43 vs 基线 40（+3）**：台账停在 09-17，之后有 32 个代码提交（P10–P26）
  可能加了断言。**增加**不违反「不得下降」。

**基线口径的诚实说明**：P9 的记录是「能拿到的最新最完整记录」，**不是**「变更前的实测」——
后者物理上不可得（镜像必须先重建才能跑新代码，一重建旧镜像即消失）。

### 执行期发现（Task 6）

**「对牌做引用相等」是本片最容易踩的一类坑，而 `tsc` 对它完全沉默。**

这一轮抓到 5 处，其中 3 处是同一类：

| 位置 | 形态 | 被什么掩护 |
|---|---|---|
| `shared/ddz/play.ts` | `newHand.indexOf(card)` | — （Task 3 抓到） |
| `mock-server/scripted-game.ts` | `hand.indexOf(c)` | — （Task 6 抓到） |
| `conformance/slice-08-bidding.ts:250` | `latest.hand.includes(c)` | 两副牌来自**不同 JSON 负载** |
| `conformance/slice-08-bidding.ts:233` | `as number[]` | **一个 `as` 同时遮住排序 `NaN` 与上面的 `includes`** |
| `conformance/slice-05:55` | `const hand: number[]` 标注 | ack 载荷是 `any` |

⇒ **`as` / `any` / 宽类型标注不只是「关掉一处检查」——它们会连带掩护下游一大片。**
`slice-08:233` 的 `as number[]` 就是活标本：它让 `bottom` 变成 `number[]`，
于是下游 `hand.includes(c)` **类型检查通过**，而两者在运行期都是错的。

**与本片 §3.5-A 清单的关系**：清单只收了 `as`（类型断言）。实际逃逸口有三种
—— **`as` 断言 / `any` 与 `Record<string, unknown>` / 与运行期不符的类型标注**。
三者 `tsc` 一律沉默，都该进那份清单。

#### Task 7 收尾（`apps/client` 改完后重跑）

**客户端归零**（48 → 0，实际改动面 **133 处**）。全仓 tsc 至此只剩 1 处 ——
预先存在的 `apps/client/src/main.ts:46`（`TS7016`，与本片无关，Task 1 已认定）。

两处**运行期静默退化**已修，且都做了变异自证：

| 处 | 形态 | 后果 | 变异自证 |
|---|---|---|---|
| `table.vue:81` | `store.hand.join(',')` | 对所有**同长度手牌**恒等 ⇒ 指纹只剩张数 ⇒ 同长度换牌不清空选中 ⇒ **会把没选的牌发出去** | ✅ 改回旧写法立刻红 |
| `Hand.vue:49` | `props.cards[a] - props.cards[b]` | 两个 `Card` 相减是 `NaN` ⇒ `Array.sort` 静默退化成「不排序」⇒ 点「理牌」无反应 | ✅ 由 `card-hand-interaction` 的排序用例覆盖 |

> **`table.vue` 那条的意义**：判据**早就存在**（`table-play-ui.test.ts:174`，且用的正是
> 「同长度换牌」这个形态），只是被 `join(',')` 的退化废掉了。修好指纹后它**立刻恢复判别力**
> —— 「**判据存在 ≠ 判据有效**」。

**死条目清理（R377）**：`source-boundary` 与 `comment-stripping` 的禁词表删
`toInternalRank` / `toDouZero`（全仓已不存在、无法命中），**21 → 19 条**，两处拷贝仍逐字一致；
`card-hand-interaction` 的正则换成**仍然存在**的规则面标识符（意图不变，断言重新可触发）。

#### Task 8：清单复核（R706 判据的闭环）

**① 实改的文件是否都在清单里？**

清单记录了 84 处初始报错，实改覆盖 7 个包 / 约 40 个文件。**清单外、由逐层增长浮出**的项：

| 项 | 从哪条 `tsc` 报错追出 |
|---|---|
| `game.controller.ts:102` 的 DTO | Task 3 修 `game.service` 签名后浮出（清单**没有**） |
| `GameActionRequest.payload` 的宽类型 | 同上；收紧后逼出两处陈旧夹具 |
| `game.rpc.controller.ts:84` 的 `as` | 同上 |
| `hardening.ts:311` 的自制 wire 类型 | `sorted` 返回值类型变了之后浮出 |
| `slice-08:233` 的 `as number[]` | 改 `hand.includes` 时浮出 |
| `slice-05:55` 的假类型标注 | 同上 |

**② 判据自证三项均 > 0** ✅（Task 1 Step 11 记录的 16 / 3 / 48）

**③ 每个 task 收尾重跑的新增项都已追加** ✅（见上面各 task 的「收尾」小节）

**④ `tsc` 看不见的清单 —— 本片的最终结论**

清单的 §3.5-A 只收了 **`as` 断言**。实测下来，**形状逃逸口有三种**，
三者 `tsc` **一律沉默**，而且**会连带掩护下游一大片**：

| 类别 | 本片实例 |
|---|---|
| `as` 断言 | `slice-08:233` 的 `as number[]` —— **一个断言同时遮住**排序 `NaN` 与下游 `includes` 的引用相等 |
| `any` / `Record<string, unknown>` | `GameActionRequest.payload`、`GameClient.action` 的载荷参数 |
| **与运行期不符的类型标注** | `slice-05:55` 的 `const hand: number[]`（运行期是 `Card[]`）、`hardening` 的自制 wire 类型 |

⇒ **将来做同类改动时，这三类应当一并列入「`tsc` 看不见」的清单**，
而不是只列 `as`。

**⑤ 另一条方法论结论：「对牌做引用相等」是本片最高频的坑。**

五处：`shared/ddz/play.ts` 的 `indexOf`、`mock-server` 的 `indexOf`、
`slice-08:250` 的 `includes`、以及被 `as` 掩护的两处。
**`tsc` 对它完全沉默**，`Card` 从「值」变成「对象」之后它无处不在。
