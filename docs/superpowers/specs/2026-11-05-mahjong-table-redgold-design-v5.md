# 麻将牌桌「川麻红金」重做设计 spec v5

日期：2026-11-05
状态：v5，待对抗审查
取代：`2026-11-05-mahjong-table-redgold-design-v4.md`
继承：**未在本文件列出的内容按 v4 执行**（构图、色板、动效原则、数据来源等）。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v5 原型；七档 × 10 个可达态 **ALL GREEN**）。

## 0. v5 修订（相对 v4）

| v4 审查问题 | v5 处理 |
|---|---|
| 侧副露按单张 36.4 宽建模，实际碰组 101 / 杠组 134 | 左右副露**竖排**：`MahjongMeld` 新增 `vertical`；组高 3/4 张 × 36.4s − 叠压 4s，组距 8s；4 组超高时动态缩 scale（最低 0.4，实测 4 杠 0.51） |
| 自己/对家副露忽略 4 张杠、叠压、8px 组距 | 按真实 3/4 张组宽 + 4s 叠压 + 8s 组距算 contentW；自己副露与动作区冲突时整体左移，右缘贴动作区左缘 |
| 侧背按 49:40 建模，素材实为 83×125 | 侧背 tile = 45.714s × 30.35s（75/113），lane 宽 30.35s |
| Hub compact 内容放不下；6px 金环外扩压河 | 金环**内缩 3px**；compact 32/18/12（状态行最多 8 字 + …）、normal 40/22/14（最多 10 字 + …）；徽标 compact 14/normal 16；加内容 fit 断言 |
| 24 上限没说显示哪 24 张 | 明确**尾部窗口**：上/下 `overflow>0` 时显示最新 23 + 第 24 格「+N」；侧河 24 + 徽标；`latestIndex` 映射到窗口末张；claimed 过滤后计数 |
| 座位牌分数+delta 超宽；16px 角标最多放 2 个 | 对手名字 18 / 分数 18 / delta 14（flex，分数省略、delta 固定）；自己 64 宽分数 16 / delta 12；角标最多 2、14px、总宽 ≤48；无张数 |
| `actions×ownRiver` 同时在允许/失败列表 | 从失败 pairs 删除，只记录覆盖量；`overlay` 态纳入矩阵（1334×750 覆盖 38.7×125.6） |
| 对家副露绑定 8 列河宽放不下 4 组 | `topMeld.width = max(topRiver.width, contentW)`，上限 topBacks/centerW；4 杠 451.6 ≤ topBacks 453.4 |
| `anim-lack-pulse` 仍是 infinite | 定缺推荐改静态金边；删除该 infinite 用法 |
| 侧副露“外侧/内侧”文案矛盾 | 上/下副露在河外侧；左/右副露在河内侧 lane |
| 已胡标签 top:-13 压座位牌 | 标签移到河内/底部；sideTop 只在 revealed 时额外 +16s |
| `actions×selfMeld`、topBacks×plates 等漏检 | 原型补齐 pair；七档 × 10 态全绿 |
| 29 张→3×10=30 在 16:9 不成立 | 16:9 是 3×9=27（24+3）；1000/1334 才是 3×10=30 |
| Hub 内容/颜色环未验证 | `hubContentOk()` 断言；compact 162.4 内容 width/height/徽标 fit |
| 发牌“首个观察 v1”触发不到 | **挂载时已有 v1 exchange/lack ⇒ 播**；v>1 seed；`useTableSound` 按 version===1 判局首 |
| 24 张显示窗口/最新弃牌 | 见上：尾部 23+badge；`latestIndex` 窗口内映射 |
| 顶栏漏返回大厅 | 顶栏左保留返回按钮 + 房间/底分；`emit('leave')` 测试 |
| 手牌 key 带 phase 反复重播发牌 | 手牌 key 去 phase；发牌类绑定 `dealNonce`；摸牌/牌背尾部不带发牌类 |
| MjDeal 双响 | **首次 play 只播 MjDeal**；出牌改 MjSort 轻；不双响 |
| meld key 不带座位，跨家同型漏音/错音 | useTableSound key 改 `seat:kind:type`，与 Board 共用 helper |
| rob 点旧牌过滤空 / 强制胡空按钮 | 只有 `windowId` 前缀 `claim:` 且 claimSource 单张可点；rob 不提供弃牌点击；强制胡无 pass |
| claimedDiscard 未定义、peng→gang 重复隐藏 | 状态派生：每个带 `fromSeat` 的 meld 隐藏来源座**最早**一张同 type 弃牌；peng→gang 同一 meld 不重复；claimed 后计数/latest/overflow 重算 |
| seatActiveLevel 高亮错人 | claim：我（可响应）强、弃牌者金线、其他 muted；exchange/lack：只看我；play currentPlayer；全部静态 |
| 胡 banner 结算出队截断 / reduced-motion 卡 | 正常 animationend；reduced-motion 下一版或 `settlementRevealed` 出队；不用 `settlementArrived` 截断 |
| 新局换房重挂，ended→exchange 死路径 | **新局=新房间+重挂**；`setRoom` reset；取消 ended→exchange 承诺；SBR 第二局同重挂 |
| 一炮多响删多张同型弃牌 | 客户端只从新 view 重算，不假设 −1；claimed/latest/overflow 全量重算 |
| Hub claim 牌删除未说明 | 明确删除中央 claim 牌；只保留 claimSource 高亮 + 动作区按钮 |
| rob 高亮指向的 meld 仍是 peng | 明确高亮杠家的 **peng** 副露（同 type），不是 gang |
| revealed 替换牌河后 24+N 失去意义 | revealed 座位只显示亮牌，不显示 +N/overflow；布局 visible=revealed |
| ting/actionCount/backwards 闸缺口 | ting ≤9，>9 截断测试；删除 actionCount；backwards 闸只扫发牌/手牌类并豁免 meld-pop/banner/settlement |
| play 等待文案写错 | play 等待写「等待其他玩家出牌…」；claim 才是「等待其他玩家响应…」 |

## 1. 几何修订

### 1.1 左右副露竖排

- `MahjongMeld` 新增 `vertical?: boolean`（回退后已丢失，需补）。
- 左右副露：每组 tile 竖排，`sideMeldScale=0.65`；单张屏幕高 = 56s×0.65 = 36.4s，宽 = 45.714s×0.65 = 29.7s；组内叠压 4s；组距 8s。
- 组高：碰 3 张 = 101.2s；杠/暗杠 4 张 = 133.6s。
- 4 组：4 碰 428.8s；4 杠 558.4s > 可用高度（750 mid 约 447s）⇒ **动态缩 scale**，实测 gangHeavy 缩到 0.51、总高 443.3s，放得下；最低 0.4，低于 0.4 视为降级（记录）。
- 侧 lane 宽 = 29.7s + 4s；位于侧河**内侧**（x 在河与 center 之间）。
- 侧区宽 = 背 30.35s + gap + 河 + (副露 ? gap+laneW : 0)。

### 1.2 自己/对家副露

- 组宽 = n×meldTileW − (n−1)×4s；`meldTileW=56s×0.8×75/113≈29.73s`；组距 8s。
- 4 碰 contentW=348.8s；4 杠 contentW=451.6s。
- 自己副露：默认以 centerCx 居中；若与动作区相交，整体左移，右缘 = actions.left − 4s；左缘 ≥ outer。
- 对家副露：`width=max(topRiver.width, contentW)`，居中；上限 topBacks 宽（s=1 时 453.4s）；超出则缩 scale。
- 原型断言：selfMeld×actions、topMeld×plates/topBacks、topMeld 宽度 ≤ centerW。

### 1.3 侧背

- `back.png` 83×125（75/113）；侧背 tile = 45.714s 高 × 30.35s 宽；lane 宽 30.35s。
- `backs.left/right.tile` 输出该尺寸；不再用 56 宽。

### 1.4 血战盘内容

- 金环**内缩 3px**（在 hub rect 内），不外扩；与上/下河的 4s 间隙不碰。
- normal（200）：牌墙 40、秒 22、状态行 14（最多 10 字 + …）；「牌墙」标签 14；听 N 14；徽标 16；方位点 10。
- compact（162.4）：牌墙 32、秒 18、状态行 12（最多 8 字 + …）、隐藏标签；听 N 12；徽标 14；方位点 8。
- 状态行在盘内下部，单行不换行；宽度 ≤ 该高度弦长 − 8。
- 徽标：每座只显示最紧急一个（胡 > 听 > 缺 > 托管）；挂四对角，距圆心 r−badge。
- 方位点：四正向，距圆心 r−5；play/claim 单亮，exchange/lack 多亮。
- 状态行文案：exchange「换三张：选 3 张同花色 / 等待其他玩家换三张…」；lack「请定缺 / 等待其他玩家定缺…」；play「请出牌 / 等待其他玩家出牌…」；claim「请响应 / 等待其他玩家响应…」；ended「本局结束 / 已胡 N 家」。
- 删除中央 claim 牌；claimSource 只高亮河里/副露那张。

### 1.5 24+N 窗口

- `raw = 过滤 claimed 后的 discards/revealed`；`visible = min(raw, 24)`；`overflow = raw − visible`。
- 上/下：`overflow>0` 时显示**最新 23 张 + 第 24 格「+N」**；`overflow=0` 显示全部 ≤24。
- 侧：容量 rows×cols；`overflow>0` 且容量≥25 时显示 24 张 + 第 25 格徽标；容量=24 时 23+徽标。
- 窗口语义：`discards.slice(-windowCount)`；`latestIndex = windowCount − 1`。
- 徽标占网格最后一格，不额外占位；`badgeRect` 输出。
- 测试：29 张 → 上/下 23+6、侧 24+5；第 29 张可见、最早 6 张不可见。

### 1.6 座位牌

- 对手 140×56：头像 56；文本列 74；名字 18（3 字 + 省略）；分数 18 + delta 14 同一 flex 行，分数 `flex:0 1 auto` 省略、delta `flex:0 0 auto` 不截断；最多 2 个 14px 角标（左上/右上），总宽 ≤48，优先级 庄 > 缺 > 胡 > 听 > 托管；无张数。
- 对家 144×56：文本列 78，同上。
- 自己 64×76：头像 48；分数 16 + delta 12；名字省略。
- 余额 ≥10000 用 `(n/10000).toFixed(1)` 去 `.0` + 万；测试 4200/10000/1234567。
- `pendingScoreChanges` delta 只在分数行；不占角标。

### 1.7 动作浮层

- `actions = W − outer − rightZoneW − gap − 176s, y = handTop − 16s − 176s, 176s × 176s`；2×2 84s。
- `actions×ownRiver` **允许**，只记录覆盖量；`overlay` 态（self 17、left 16+碰、right 25+碰）实测覆盖 38.7×125.6。
- 覆盖可能含最新弃牌，属行动时临时遮挡；非行动时 `v-if` 完全不渲染。
- 自己副露左移避开动作区（见 1.2）；选中抬 10 与动作区/河/副露/听牌行净空 ≥6。

### 1.8 其他

- 上/下副露在河外侧；左/右副露在河内侧 lane。
- 已胡标签移到河内/底部；revealed 座位 sideTop 额外 +16s，避免压座位牌。
- 16:9 的 29 张侧河是 3×9=27（24+3），不是 30；1000/1334 才是 3×10=30。
- 1334×833 mid hub=185.8（compact）；1334×1000/1334 mid hub=220.3（非 compact）。

## 2. 交互/数据修订

### 2.1 发牌（挂载即 v1）

`table.vue` 在 view 为 null 时渲染 DdzBoard，`MahjongBoard` 只会在已有 view 上挂载。因此：

- `onMounted`：
  - 已有 view 且 `version===1` 且 `state∈{exchange,lack}` ⇒ **播发牌一次**（dealNonce++）。
  - 已有 view 且 `version>1` ⇒ seed，不播。
  - view 为 null（独立/test）⇒ 等首个非 null view：v1 exchange/lack 播，v>1 seed。
- 新局=新房间+重挂；`setRoom` 已 reset；不再依赖 `ended→exchange|lack`。
- `useTableSound` bootstrap：view 存在且 version===1 exchange/lack ⇒ 播 MjShuffle；v>1 seed；SBR（首态 lack）同样播。
- 测试：v1 exchange mount、v1 lack mount、v5 play mount（不播）、第二局 remount（播）。

### 2.2 手牌 key / dealNonce

- 手牌 key 去掉 phase：`tileKey(tile)+occurrence` 或 `dealNonce-index`；稳定。
- 发牌类只绑定 `dealNonce` 的初始节点；`dealing` 只在下一局重置点清。
- 摸牌新节点只带摸牌类；对手牌背尾部只带摸牌类；不重播发牌。
- 测试：lack→play 无发牌类；摸牌后新牌带摸牌类；牌背尾部不带发牌类。

### 2.3 音效

- 发牌时刻：MjShuffle。
- 首次 `state==='play'`：MjDeal **一次**；出牌改 MjSort 轻，不播 MjDeal。
- 选牌/可响应提示：MjSort（Board 直接调 audio 或统一 emit）。
- useTableSound 游标与 Board 的 dealNonce/首版 seed 同一谓词；跨局 reset 随重挂。
- audio.test：deal/draw/discard/claim/hu/win-lose、首版不补播、SBR 首版、双响计数。

### 2.4 meld key 带座位

- useTableSound 的 key 改 `seat:kind:type`；与 Board 的 `meldKey` 共用 helper。
- 补杠判断按**同一座位**上一版 `peng:type` 是否存在。
- 测试：甲先碰 5 筒、乙再碰 5 筒都播 MjPeng；甲碰 5 后乙直杠 5 播 MjGuafeng；甲碰→补杠播 MjGang。

### 2.5 claim 点击过滤 / rob / 强制胡

- `interactive` 只在 `windowId` 以 `claim:` 开头、`phase==='claim'`、`amActive` 且点击的是 claimSource 那一张/index 时为 true。
- `rob:` 窗口不提供弃牌点击；胡按钮上显示待响应牌。
- `showPass = myClaims.some(o=>o.claim==='pass')`；options 过滤 pass；强制胡无 pass、不会空按钮。
- 测试：普通 claim 点旧牌不影响；rob+强制胡有胡按钮；rob 无弃牌点击。

### 2.6 claimedDiscard（状态派生）

- 对每个 `meld.fromSeat === source`，在 source 的 discards 里隐藏**最早**一张同 type 的弃牌；隐藏数量 = 该来源座被副露吃掉的组数（peng/gang 都算 1；peng→gang 同一 meld 不重复）。
- 过滤后的 discards 用于：布局计数、24+N 窗口、latestIndex、音效 diff。
- 不按“新 meld key 出现”增量隐藏；每版从完整 view 重算，重连一致。
- 测试：peng→addedGang 只隐藏 1 张；同 type 多张/两组；一炮多响 shrink>1 后重算。

### 2.7 发光

- claim：我（可响应）静态强金边；弃牌者金线；其他 active muted；无 infinite。
- exchange/lack：只看我是否 pending；其余 muted。
- play：currentPlayer 静态金边；其余 muted。
- ended：无；赢家金边。
- 所有座位卡静态，删除 `ftl-active-glow` infinite；唯一 infinite = claim 动作按钮呼吸；定缺推荐静态金边。

### 2.8 胡 banner 出队

- 正常：`animationend` 出队。
- reduced-motion：下一版 view 或 `settlementRevealed`（2s 后）出队当前并继续队列；不用 `settlementArrived` 截断正常动画。
- 测试：单胡、双胡、reduced-motion 双胡（不残留）。

### 2.9 新局边界

- 生产：新局=新房间+重挂；`setRoom` reset；SBR 第二局同。
- 不再承诺 `ended→exchange|lack` 的 reset；如果将来同实例复用，另立 spec。
- 测试：remount 第二局发牌/洗牌/胡 banner 正常；store.settlement 已在 setRoom reset。

### 2.10 一炮多响

- 服务端每个赢家 `markHu` 删一张同 type 弃牌，可能 shrink>1；客户端不假设 −1，全部从新 view 重算（claimed/latest/overflow/音效）。
- 已知服务端行为，不在本片修改。

### 2.11 中央 claim 牌

- 删除中央 claim 牌/centerTiles；claimSource 只高亮河里/副露那张；动作区按钮显示待响应牌面（20×30 小图）。

### 2.12 revealed

- 已胡座位在河区显示 13–14 张亮牌，替换 discards；该座位不显示 24+N/overflow；布局 `visible=revealed`。
- 标签移到河内/底部；sideTop 额外 +16s，避免压座位牌。
- 测试：侧家 5 弃 +14 亮牌显示 14，无 +N。

### 2.13 ting / actionCount / backwards 闸

- ting ≤9；>9 截断并测试；删除 `ting.overflow`（或固定 0）。
- 删除布局输入 `actionCount`；动作区 rect 固定 176，内容由 mode 决定。
- backwards 闸只扫 `anim-deal-in-radial`/`anim-deal-in-side`/手牌类；豁免 `anim-meld-pop`、`anim-hu-banner`、`anim-mj-settlement-in`。

### 2.14 返回大厅

- 顶栏左：返回按钮 + 房间/底分；保留 `emit('leave')`；board 测试断言可点击。

## 3. 组件/接口修订

- `MahjongMeld`：新增 `vertical`；左右副露竖排。
- `MahjongHandBacks`：`dealing` prop；牌背尾部不重播。
- `MahjongRiver`：`riverDirection`、`tileDirection`、`windowCount/overflow/badgeRect/latestIndex`、`claimed` 过滤、`revealed` 模式、已胡标签位置。
- `MahjongHub`：内容 fit；状态行；徽标/方位点；无 claim 牌。
- `MahjongActionBar`：2×2；多杠选择器；pass 唯一；强制胡无过；四种 mode。
- `MahjongBoard`：挂载 v1 播发牌；stable key/dealNonce；claimSource；claimed 派生；prevDiscardCounts/lastDiscardIndex；seatActiveLevel；banner 出队；返回按钮。
- `table.vue`：bySlot/phase/tingCount；失败 notice；托管取消。
- `useTableSound`：seat key；首版 v1；MjDeal 首次 play；MjSort 出牌/选牌。
- `animations.scss`：新增 4 类；删除 lack pulse infinite；唯一 infinite = claim 呼吸。

## 4. 测试矩阵

- 画布：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
- 可达态：normal、mid、top29、twoSurvivors(29/25)、revealed(14)、heavy、fourMelds、selfFourGang(4 杠)、gangHeavy(四家 4 杠)、overlay（动作覆盖）。
- 组件态：长名字、6 位余额+delta、2 角标、4 动作、claim 单过、强制胡、多杠、0s、托管取消、换三张、定缺、29→23+6、侧 24+5、revealed 无 +N。
- 不测 36 张/家；108 张可达 ~29。

## 5. 原型证据

`node docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs` → 7 档 × 10 态 ALL GREEN：

- 1334×750 normal：hub 200、side 10r/2c、action x=993.7、centerW=1005.3。
- mid：hub 162.4（compact）、side 9r/2c、侧副露 101.2、action x=955.9。
- top29：top 12c +5；side 3c×9r=27 +3；action x=993.7。
- twoSurvivors：左 24+5、右 24+1；side 3×9=27；action x=935.7。
- fourMelds：侧 4 组总高 428.8；gangHeavy：动态 scale 0.51、总高 443.3。
- selfFourGang：动作区与 4 杠副露左移后无相交。
- overlay：actions×ownRiver 覆盖 38.7×125.6（允许记录）。
- 1334×833/1000/1334 s=1.101；mid 833 185.8 compact，1000/1334 220.3 非 compact。

## 6. 决策表追加

| 编号 | 决策 |
|---|---|
| D21 | 左右副露竖排；4 杠动态缩 scale（最低 0.4） |
| D22 | 自己副露与动作区冲突时左移贴边；对家副露宽 = max(河宽, 内容宽) |
| D23 | 侧背 30.35×45.714（83×125）；侧 lane 宽 30.35 |
| D24 | Hub 金环内缩 3px；compact 32/18/12（8 字），normal 40/22/14（10 字） |
| D25 | 上/下 23+徽标（溢出时）；侧 24+徽标；尾部窗口 |
| D26 | 座位牌名字 18/分数 18/delta 14/角标 14×2；自己 64 宽 16/12 |
| D27 | actions×ownRiver 允许并记录；overlay 态进矩阵 |
| D28 | 挂载 v1 播发牌；v>1 seed；新局=新房间+重挂 |
| D29 | 手牌 stable key + dealNonce；摸牌/牌背尾部不重播 |
| D30 | MjDeal 只首次 play；出牌 MjSort；meld key 带 seat |
| D31 | claim 只 claimSource 可点；rob 无弃牌点击；强制胡无过 |
| D32 | claimedDiscard 状态派生（最早一张，peng→gang 不重复） |
| D33 | seatActiveLevel 按 §2.7；唯一 infinite = claim 呼吸 |
| D34 | banner 正常 animationend；reduced-motion 下一版/揭示出队 |
| D35 | 一炮多响 shrink>1 全量重算；不改服务端 |
| D36 | 中央 claim 牌删除；rob 高亮 peng |
| D37 | revealed 座位只显示亮牌，无 +N |
| D38 | ting ≤9；删 actionCount/ting.overflow；backwards 闸限定 |
| D39 | 顶栏保留返回大厅 |

## 7. 已知边界

1. **服务端一炮多响会删多张同型弃牌**（每个赢家各删一张）；客户端全量重算，服务端不在本片修改。
2. **4 杠一侧**时侧副露 scale 可降到 0.51（750），牌面变小；属极窄场景，mockup 需展示。
3. **动作浮层覆盖**：仅 12 列自家河 + 宽侧区时覆盖 38.7×125.6，可能含最新弃牌；行动时临时遮挡，非行动隐藏。
4. **Hub compact 162.4**：状态行最多 8 字；超长昵称会省略。
5. **108 张**：单家弃牌可达 ~29；显示 24（上/下 23+徽标）。
6. **136 张玩法**不在本片；容量目标另立 spec。

## 8. 开放问题

无。v4 审查的 4 Critical 与关键 Important 已在本文件/原型收口；剩余为已知边界（§7），实施时按 TDD 锁。
