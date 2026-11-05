# 麻将牌桌「川麻红金」重做设计 spec v3

日期：2026-11-05
状态：v3，待对抗审查
取代：`2026-11-05-mahjong-table-redgold-design-v2.md`（v2 审查：7 Critical / 11 Important / 2 Minor）
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（设计期原型，随 spec 入库；六档 × 8 个可达最坏态 **ALL GREEN**）。

## 0. v3 相对 v2 的关键修正

| v2 问题 | v3 处理 |
|---|---|
| 发牌谓词放在 play，实际建局即 exchange/lack | 改为**每局首个非 null view**（`version===1` 或 `ended→exchange\|lack`）触发一次；挂载 seed；删除 `phase==='play'` 的 `anim-deal-in` 门 |
| play 动作可 5+（多杠），2×2 不够；多胡不存在 | 动作区固定 4 槽：出牌、胡、**杠（多杠合并为选择器）**、过；claim 的 pass 去重 |
| 侧区预算漏座位牌/侧副露；副露后 36 容量只有 30 | 侧区显式扣座位牌；侧副露改**内侧独立 lane**；容量按 108 张川麻的**24 张上限**重算（36 不可达） |
| `fixed` 重复减 gaps | 原型用“上下栈 + 中间自由区”算 hub，不再有重复减 |
| 座位牌内容装不下、字号矛盾 | 统一名字 22（3 字 + 省略）/分数 22；角标最多 3 个、有优先级；自己牌头像 48 + 分数 22；不显示张数 |
| 听牌行压自家牌河；9 面听放不下 | 听牌行改**盘外 2 行 × 5 列**（最多 9），放在自家牌河左侧；原型已验证不相交 |
| “一个 infinite”未落地 | SeatChip strong/weak 改静态金边；ClaimTile 根 pulse 删除；claim 窗口不播 urgent；新增源码闸 |
| reduced-motion 下幽灵/发牌标记残留 | **不做幽灵**：出牌只做牌河落点 + 手牌合拢；`dealing` 用版本变化清理，不依赖 animationend |
| 出牌预提交飞仍会隐形 | 删除 `flyingOutIndex`/`anim-fly-out` 预提交路径；确认前手牌不变、不清选中 |
| 首版 seed / SBR 跨局 reset 不成立 | `ended→(exchange\|lack)` 都 reset；首个非 null view seed；`version===1` 也 reset |
| claimSource 无法派生 | 用 `windowId` 前缀 `rob:`/`claim:` + `currentPlayer` + discards/melds 派生；Board 持有最后弃牌索引 |
| Hub 删了 phase/ended 文案 | Hub 底部加**状态行**（等待换三张/等待出牌/请响应/本局结束/已胡 N 家） |
| revealedHands 不进布局输入 | loads 增加 `revealed`，`visible=max(discards, revealed.length)` |
| currentPlayer 在 exchange/lack 恒 0 | 方位点改 `activeSeats` 驱动；play 用 currentPlayer |
| 选中抬 10 压动作区/河/听牌行 | 手牌净空改 16（抬 10 + 6）；原型断言选中矩形不相交 |
| 中心宽漏外框、fit 优先级矛盾 | 原型显式 `centerLeft/Right` 含 outer；上/下河宽超中心区时 fit；侧河先占宽 |
| s 公式/72px 分配未定义 | 明确 `s=max(1,min(H/750,0.86W/手牌行宽))`；自由区全部给 hub 上下均分 |
| 36 张容量目标本身错误 | 108 张川麻四家手牌 52 + 牌墙 56 ⇒ 单家弃牌上限约 24；测试改 24/17/14 等可达态 |

## 1. 背景与目标

当前牌桌是 10-30 四家围桌布局（天月风回退后的基线）。两次重做都被整片回退：10-30 中央牌板 `7c7e2424`、11-02 天月风 v1+v2 `7a235324`。本次重做**信息骨架 + 动线**，目标气质为川麻红中血流（红金、大字、血战感），布局 A：经典围桌 + 紧凑血战盘；座位牌上家左上、下家右上、对家上中、自己左下。

## 2. 两次回退的教训

1. 不用大面板解决信息问题。
2. mockup 先行，不整片重做后才发现方向不对。
3. 不为氛围牺牲可读性。
4. 同一时刻最多一个 `infinite` 动画。
5. 保留已合入的非视觉修复（`wallEmptyWithHu`、结算面板增强等）。

## 3. 范围

### 做

- 布局纯函数 v2：动态血战盘、四向牌河、靠角座位牌、手牌、2×2 动作区、听牌行。
- `MahjongHub` 新增；`MahjongSeatChip` 靠角变体；`MahjongRiver` 四方向 + 动态行列；`MahjongBoard` 重装配。
- 红金 token；ClaimTile/HuBanner/MahjongTile（边框/阴影）/MahjongMeld/托管遮罩/结算主按钮纳入配色改造。
- 动效/音效/震动按第 6 节；全部复用现有素材。
- 六档 × 可达最坏态测试与截图。

### 不做

- 不换牌面/牌背图片；不新增图片/音效。
- 不改协议/服务端/数据库/admin。
- 不做角色立绘。
- 不做拖拽出牌；保留单击选中、同张 400ms 内双击出牌、>400ms 再点取消、出牌按钮、长按看听牌。
- 不重做结算页布局；只给结算主按钮换 token、四行 35ms 错峰。
- 不新增东南西北/局数；方位用屏幕四向未标注点。
- **不把 36 张/家弃牌列为容量目标**（108 张川麻不可达）。

## 4. 构图与布局

### 4.1 分区

| 区域 | 位置 |
|---|---|
| 顶部栏 | 左：房间/底分；中：对家座位牌；右：托管/更多 |
| 上家/下家座位牌 | 左上/右上角（顶栏下、侧区上方） |
| 自己座位牌 | 左下角，手牌左侧 |
| 血战盘 | 画布正中自由区 |
| 四条牌河 | 盘上/下/左/右，围成十字；副露贴各自河外侧 |
| 手牌 | 底部居中 |
| 动作区 | 手牌右上方 2×2 |
| 听牌行 | 自家牌河左侧、手牌左上方（2 行 × 5） |

### 4.2 关键尺寸（s=1）

| 元素 | 基线 |
|---|---|
| 顶部栏 | 64 |
| 血战盘 | 动态 160–200（`compact` = 直径 <180） |
| 上/下河牌 | 56 高，2 行；8/12 列 |
| 左/右河牌 | 56×45.714（49:40） |
| 手牌 | 108 高；选中抬 10；手牌净空 16 |
| 对家牌背 | 高 46 |
| 左右牌背 | 56 宽 × 45.714 高，pitch 8–22 动态 |
| 副露 | 44.8 高（56×0.8）；侧副露 36.4×29.714（0.65） |
| 对手座位牌 | 140×56 |
| 对家座位牌 | 144×56（顶栏内） |
| 自己座位牌 | 56×76（头像 48 + 分数 22） |
| 动作按钮 | 84×84；动作区 176×176 |
| 听牌小牌 | 20×30；2 行 × 5 列，最多 9 |
| 外框 | 12（`::before`/阴影，不用 CSS border） |

### 4.3 布局算法（原型已验证）

**s**：`s = max(1, min(H/750, 0.86*W/手牌行宽))`，`手牌行宽 = 14*108*(75/113) + 13*2 + 12`。`0.86W`（v2 是 0.88W）给左下自己牌留出净空。

**竖向栈**：

1. `bar` 64 → gap 4 → 对家牌背 46 → gap 4 → 对家副露 44.8（有则占）→ gap 4 → 对家河 114 → gap 4。
2. 底部栈：自己河 114 → gap 4 → 自己副露 44.8（有则占）→ **手牌净空 16** → 手牌 108 → 外框 12。
3. 中间自由区 = 对家河底 .. 自己河顶；`hub = clamp(自由区高 − 2*gap, 160s, 200s)`；hub 在自由区内垂直居中；剩余空白上下均分。
4. 正常 1334×750：自由区高 382 → hub 200；1 副露各：自由区约 178 → hub 162.4（compact）；满副露约 166。
5. 六档实测（原型）：1334×750 s=1；1334×833/1000/1334 s=1.101；1623/1778×750 s=1。

**动作区**：`actions = { x: W − outer − 176s, y: handTop − 16s − 176s, 176s, 176s }`。2×2 84px 槽，右对齐。侧区底缘 = `actions.top − 4s`。

**侧区**：

- `sideTop = max(topRiver.top, plateBottom + 4s)`（座位牌不压侧区）。
- `sideBottom = actions.top − 4s`；`available = sideBottom − sideTop`。
- `rows = clamp(floor((available+2s)/(45.714s+2s)), 3, 8)`。
- `cols = clamp(ceil(visible/rows), 2, 8)`；`visible = max(discards, revealed)`。
- 侧副露在**河内侧**独立 lane（36.4s 宽），不与河/动作区相交；侧区宽 = 背 56s + gap + 河 + (副露 ? gap+36.4s : 0)。
- `pitch = clamp((available − 45.714s)/13, 8s, 22s)`。
- 原型六档全部无碰撞；侧区容量：750 高、3 行时 3×8=24，恰好覆盖 108 张川麻的单家上限。

**横向**：

- `centerLeft = outer + leftZoneW + gap`；`centerRight = W − outer − rightZoneW − gap`；`centerW = centerRight − centerLeft`。
- 上/下河列数：`visible ≤16 → 8`，否则 `12`；宽超出 `centerW` 时 `fit` 缩牌。
- 自家河/对家河在 center 区水平居中；血战盘在 center 区水平居中。
- 听牌行：`tingW = cols*20s + gaps`，`x = max(hand.left + 8s, ownRiver.left − gap − tingW)`，`y = ownRiver.top + (ownRiver.height − tingH)/2`；2 行 × 5，最多 9；原型断言不压河/手牌/动作区/副露。

### 4.4 牌河容量（按 108 张川麻）

- 四家手牌 52 张 + 牌墙 56 张 = 108；**单家弃牌上限约 24**，36 张不可达，不再作为目标/测试。
- 上/下河：8 列×2=16；>16 扩 12 列×2=24；不再扩 18 列。
- 左/右河：rows 3–8 动态；cols 2–8；容量 rows×cols；可达态 24 以内（原型 side17=20、revealed14=16、maxDiscards 左 14=16）。
- 若未来换 136 张玩法，容量目标另立 spec；本片不做。
- 最后弃牌按**每座 discards 增长**判定；claim 缩短时清空；上一张旧牌不重新脉冲。

### 4.5 血战盘

- 牌墙数：正常 48 / compact 40；「牌墙」标签 normal 16 / compact 隐藏。
- 倒计时：play 固定金环 + 秒数（normal 28 / compact 22）；claim/exchange/lack 用 `mahjongRules.*WindowMs` 算环比例；最后 5s 变红（claim 窗口不播 urgent）。
- 方位点：屏幕四向四个 12px 点；`play` 亮 `currentPlayer`；`claim` 亮来源座（`currentPlayer`）；`exchange/lack` 亮 `activeSeats`（可多亮）。
- 状态徽标：缺/听/胡/出局/托管，normal 20 / compact 16，挂盘缘四对角，每座只显示**最紧急一个**（优先级：胡 > 出局 > 听 > 缺 > 托管）。
- 状态行（盘底，normal 16 / compact 14）：等待换三张 / 等待 X 出牌 / 请响应 / 本局结束 / 已胡 N 家。恢复现有 phaseText/endedText 语义。
- 听牌：盘内只显示「听 N 张」徽标；小牌行在 4.6。

### 4.6 手牌、动作区、听牌行

- 手牌 14 张居中；摸牌独立 12；选中抬 10；不可出降饱和。
- 动作区固定 4 槽（2×2 84）：
  - `play`：出牌（宽 176 主按钮）、胡、杠（**多杠合并为「杠 N」选择器**）；不再假设多胡。
  - `claim`：碰/杠/胡/过；`claimsForMe` 的 pass 过滤，只留一个「过」。
  - `exchange`：换三张（宽 176）+ 已选 x/3。
  - `lack`：万/筒/条三个 84 按钮 + 推荐提示。
- 听牌行 2 行 × 5 列（最多 9），牌 20×30，位于自家牌河左侧；超过 9 张只显示前 9 + 「+N」。

### 4.7 座位牌

- 对手 140×56：头像 56；文本列 74 = 名字 22 一行（超过 3 字省略）+ 分数 22 一行。
- 自己 56×76：头像 48 + 分数 22。
- 角标最多 3 个，优先级：庄 > 缺 > 胡 > 听 > 托管；18px；不显示张数（牌背本身表达）。
- 余额 ≥100000 用 `(n/10000).toFixed(1)` 去掉 `.0` + 「万」；`99999` 原样；`1234567→123.5万`。测试三例。

## 5. 信息层级

动线：血战盘 → 手牌/动作区 → 自家牌河 → 座位牌 → 对手牌河/副露。

| 层级 | 权重 |
|---|---|
| L1 血战盘 | 牌墙 48/40；环 6；方位点 12；徽标 20/16；状态行 16/14 |
| L2 手牌 | 108；选中抬 10；不可出降饱和 |
| L3 动作区 | 主按钮金实心 84；次按钮描金 84 |
| L4 自家河/副露 | 牌 56；最后弃牌金边；副露组距 8 |
| L5 对手 | 头像 56；名字/分数 22；角标 18；牌背/副露降对比 |

去重：牌墙只在盘；分数只在座位牌；缺/听/胡只在座位牌角标 + 盘缘；房间/底分只在顶栏；听牌小牌只在自家河左侧。

**同一时刻最多一个 `infinite`**：
- `play`：当前座位**静态金边**，无 infinite；
- `claim`：动作按钮呼吸（唯一 infinite）；
- `exchange/lack`：轮到我时动作区静态亮，无 infinite；
- 胡/结算：横幅压过一切；
- 最后弃牌脉冲只对“该座 discards 增长”的那张，和 claimSource 无关；claim 可响应金圈只对 claimSource 那张。

## 6. 动效与交互

### 6.1 原则

- 一个主运动；其余 ≤0.2s；时长沿用现有 `ftl-*`（发牌 0.36、出牌落点 0.24、碰 0.36、杠 0.42、胡 0.8、结算 0.36）。
- 从可见态起手，只动 transform/box-shadow；错峰 CSS 变量；不新增 JS 定时器。
- 每个新 `anim-*` 登记 reduced-motion；一次性动画用 `backwards`/`both`。
- 输入：单击选中；同张 400ms 内双击出牌；>400ms 再点取消；长按看听牌；出牌按钮。

### 6.2 事件表

| 事件 | 触发 | 动画 | 清理 | 音效/震动 |
|---|---|---|---|---|
| 发牌 | **每局首个非 null view**（`version===1` 或 `ended→exchange\|lack`）；挂载 seed 不播；claim/重连不播 | 手牌 `anim-deal-in-radial`；对手背 `anim-deal-in-side` 错峰 | 版本变化清 `dealing`（不依赖 animationend） | MjShuffle（局首）+ MjDeal（同触发） |
| 摸牌 | `hand.length` 增长且非发牌 | 摸牌位抬 8 + 金边 0.18s；手牌重排 0.2s | 下一手覆盖 | MjSort 轻 |
| 选牌 | 点击 | 抬 10 + 金边 0.08s | 取消复位 | MjSort 轻；轻震 |
| 出牌 | **确认后**：手牌减少 + 自家弃牌增长 | 不动真实手牌；牌河新牌 `anim-discard-land` 0.24s 2px 回弹；手牌合拢 0.2s | 牌河元素自然存在 | MjDeal 轻；轻震 |
| 碰/杠/胡提示 | `claimsForMe` 非空 | 动作按钮滑入 0.16s + 呼吸（唯一 infinite）；可响应牌金圈（只对 claimSource） | claim 结束移除 | MjSort 轻 |
| 碰/杠确认 | 副露增长 | 副露 pop（复用 `ftl-peng-pop`/`ftl-gang-pop`） | `animationend` + 版本兜底 | MjPeng / 补杠 MjGang / 明杠 MjGuafeng / 暗杠 MjRain；轻震 |
| 过 | 点击 | 0.16s 收起 | 结束 | 无 |
| 回合切换 | `currentPlayer`/`activeSeats` 变化 | 座位静态金边；方位点点亮 0.3s | 下一回合覆盖 | 轮到我轻震 |
| 倒计时 | `seconds` | play 固定环 + 数字；claim/exchange/lack 比例环；最后 5s 红 + **有限 0.6s×3** 脉冲（claim 不播） | 每秒覆盖 | 0s MjTimeup 一次（保留 table.vue） |
| 胡牌 | 新 `huInfos`（首版 seed 不算） | 胡字横幅 + 盘金光 + 亮牌翻转 0.8s | animationend **或** 版本/结算到达 | MjHu；重震 |
| 托管/超时 | `trustees`/`seconds===0` | 角标 + 降对比；自己动作区「托管中」+ **取消按钮** | 状态覆盖 | MjTimeup |
| 结算 | `settlement` 到达 + 2s 揭示 | `anim-mj-settlement-in` 0.36s；四行 35ms 错峰 | 面板关闭 | Win/Lose cue（到达时播，沿用现有） |

### 6.3 状态 → 发光

| phase | 强 | 弱/静态 | infinite |
|---|---|---|---|
| play | `currentPlayer` | 其余 muted | 无 |
| claim | 我（若可响应） | 弃牌者金线；其他响应者 muted | 动作按钮呼吸 |
| exchange/lack | 我（未提交） | 已提交 muted；方位点亮所有 activeSeats | 无 |
| ended | 无 | 赢家金边 | 无 |

座位卡 `active-strong/weak` 改**静态金边**（删除 `ftl-active-glow` infinite）；ClaimTile 根 `anim-claim-pulse` 删除，只保留动作区呼吸；`anim-urgent-pulse` 改有限次数。

### 6.4 数据与特殊态

- **发牌 epoch**：`dealEpoch` 在每局首个非 null view 置位；`ended→exchange|lack` 与 `version===1` 重置；挂载/重连 seed 为已发牌。
- **claimSource 派生**：`windowId` 前缀 `rob:`/`claim:`；来源座 = `currentPlayer`；tile = `claimsForMe` 第一个带 tile 的 option；`rob:` → `{kind:'meld', seat, tile}`，高亮杠家副露，不点亮牌河；`claim:` → `{kind:'discard', seat, tile}`，先匹配 `discards[seat]` 末张同 type，否则找 `melds[seat]` 同 type peng。
- **最后弃牌**：Board 持有 `prevDiscardCounts[4]` 与 `lastDiscardIndex[4]`；只在增长时更新；缩短（claim 删牌）清空；River 接收 `latestIndex`/`pulseEpoch`；音效 diff 同样只看增长。
- **重连 seed**：首个非 null view seed `seenHuSeats/seenMeldKeys/prevDiscardCounts/dealEpoch`；`null→view` 不视为新局。
- **跨局 reset**：`ended→(exchange|lack)` 都 reset；`version===1` 也 reset；覆盖 SBR（exchange 关闭）。
- **currentPlayer 在 exchange/lack 恒 0**：方位点用 `activeSeats`；claim 用 `currentPlayer` 作来源座；play 用 `currentPlayer`。
- **方位映射**：以 `mySeat` 为底，`top=(me+2)%4`、`right=(me+1)%4`、`left=(me+3)%4`。
- **revealedHands**：loads 增加 `revealed`；`visible=max(discards, revealed.length)`；侧家 13–14 张亮牌不溢出。
- **reduced-motion**：无幽灵；`dealing` 由版本变化清理；所有新 `anim-*` 登记；胡 banner/副露 pop 无动画时由版本/结算清理。
- **rob/draw**：服务端只产生 exchange/lack/play/claim/ended，删除 rob/draw 死规则；状态行显示「请响应」/「本局结束」。

### 6.5 音效

- 复用：MjShuffle、MjDeal、MjSort、MjPeng、MjGang（补杠）、MjGuafeng（明杠）、MjRain（暗杠）、MjHu、MjTimeup、Win/Lose。
- 「可响应」提示用 MjSort；不新增 cue。
- 选牌提示由 Board 直接调用 audio（或 emit 统一出口），在 §8.2 写明。
- 震动只有 light/heavy；`medium` 映射为 light（或保留但文案不区分）。
- 补 `audio.test.ts` 麻将用例：deal/draw/discard/claim/hu/win-lose、首版不补播。

## 7. 样式 token 与素材

### 7.1 色板

| token | 值 | 用途 |
|---|---|---|
| `$ftl-color-mj-wood-deep` | `#2B0C0C` | 外框/暗角 |
| `$ftl-color-mj-felt` | `#4A1515` | 主桌面 |
| `$ftl-color-mj-felt-light` | `#6A2420` | 桌心高光 |
| `$ftl-color-mj-lacquer` | `#1C0808` | 盘/座位牌底 |
| `$ftl-color-mj-gold` | `#D4A24C` | 金线/主按钮 |
| `$ftl-color-mj-gold-deep` | `#8C6224` | 金边阴影 |
| `$ftl-color-mj-cream` | `#F5E6C8` | 主文字 |
| `$ftl-color-mj-ink` | `#2B1608` | 金底深色字 |
| `$ftl-color-mj-urgent` | `#FF6B5A` | 最后 5s |
| `$ftl-color-mj-muted` | `#C9A9A0` | 次要文字 |

家色（只做亮点/细线）：东 `#E8C56A`、南 `#E06B5A`、西 `#A9B7C6`、北 `#6C8BB0`；徽标深漆底 + cream 字；家色点/线对比 ≥3:1。天月旧 token 不恢复。

### 7.2 字体与形状

- 牌墙 48（compact 40）；名字/分数 22；角标 18；状态行 16（compact 14）；按钮 28（2 字）/24（3 字）。
- 数字 `tabular-nums`。
- 盘正圆 + 6px 金环 + 2px 暗金内圈；座位牌 `$ftl-radius-md` + `$ftl-hairline`；主按钮金实心 + 4px 深金投影；次按钮透明底 + 金线。
- 外框 12 用 `::before`/`box-shadow`，`.mj` border 0。

### 7.3 素材与改造范围

- 牌面/牌背图片不改；侧河 56×45.714（49:40）。
- 纳入红金：Board、Hub、SeatChip、River、Tile（边框/阴影）、Meld、ClaimTile、HuBanner、托管遮罩、Settlement 主按钮。
- 桌面/盘/座位牌 CSS 渐变 + 阴影；素材预算不变。
- 不新增全局字号闸；沿用现有 `ui-tokens` 裸 hex 闸。

## 8. 技术落点

### 8.1 布局函数 v2

`mahjongTableLayoutV2(width, height, input)`，输入 `{ bySeat: [{discards, melds, revealed}], phase, actionCount }`（座位索引，不用 mySeat；方位由 Board 映射）。输出：

```ts
interface MahjongTableLayoutV2 {
  s: number;
  bar: Rect;
  hub: { rect: Rect; cx: number; cy: number; r: number; compact: boolean };
  rivers: { top: RiverLayout; self: RiverLayout; left: RiverLayout; right: RiverLayout };
  backs: {
    top: { rect: Rect; tile: TileSize; gap: number };
    left: { rect: Rect; tile: TileSize; pitch: number };
    right: { rect: Rect; tile: TileSize; pitch: number };
  };
  seatPlates: { top: Rect; left: Rect; right: Rect; self: Rect };
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number };
  actions: { rect: Rect; slot: TileSize; mode: 'play' | 'claim' | 'exchange' | 'lack' };
  ting: { rect: Rect | null; tile: TileSize; gap: number; max: number };
}
```

`RiverLayout` 增 `riverDirection: 'top'|'bottom'|'left'|'right'`（与 `MahjongTile.direction: 'my'|'top'|'left'|'right'` 分开，不透传 `bottom`）。不再用 `accent`。

### 8.2 组件与测试

| 文件 | 改动 |
|---|---|
| `MahjongHub.vue` | 新增；牌墙/倒计时/方位/徽标/状态行/听 N |
| `MahjongCenter.vue` | 删除；`mahjong-center.test.ts` 删除，新增 `mahjong-hub.test.ts` |
| `MahjongSeatChip.vue` | 四变体；静态金边（删 active-glow infinite）；角标优先级；名字/分数 22；无张数 |
| `MahjongRiver.vue` | 四方向（tileDirection 映射）；动态 cols/rows；latestIndex/pulseEpoch；不持有上一版状态 |
| `MahjongBoard.vue` | 装配 v2；动作区 2×2；dealEpoch；claimSource；prevDiscardCounts/lastDiscardIndex；首版 seed；跨局 reset `ended→exchange\|lack`；删 `flyingOutIndex` 预提交；长按/claim 过滤保留 |
| `ClaimTile.vue` | 红金；删根 pulse；多杠选择器 |
| `MahjongHuBanner.vue` | 红金；新座位位置；非动画清理 |
| `MahjongTile.vue` / `MahjongMeld.vue` | 边框/阴影 token（图片不改） |
| `MahjongSettlement.vue` | 主按钮 token；四行 35ms 错峰 |
| `animations.scss` | `ftl-deal-in-radial`、`ftl-deal-in-side`、`ftl-discard-land`；全部登记 reduced-motion；infinite 只留动作呼吸 |
| `uni.scss` | 红金/字体 token |
| `useTableSound.ts` | 发牌/摸牌/出牌触发对齐；补杠 MjGang；明/暗杠保留 |
| `table.vue` | 传 `bySeat/phase`；失败 notice 不触发牌河落点；动作/托管取消 |
| `useReducedMotion.ts`（如无） | 新增 matchMedia 组合式，用于 v-if 动画/发牌 |

测试删改：`mahjong-layout.test.ts` 重写矩阵/锚点/不相交/容量；`mahjong-board.test.ts` `.mj-center→.mj-hub`、发牌 epoch、claim 单“过”、多杠、抢杠胡、SBR 两局、重连；`mahjong-seat-chip.test.ts` 四变体/角标/余额；新增 `mahjong-hub.test.ts`、`mahjong-action-bar.test.ts`；`animations.test.ts` reduced-motion + infinite 计数闸；`audio.test.ts` 麻将用例。

### 8.3 数据来源

| UI | 字段 |
|---|---|
| 牌墙/状态 | `wallCount`、`state` |
| 倒计时 | `turnDeadlineAt` + `seconds`；claim/exchange/lack 用 rules 窗口 |
| 方位/发光 | `activeSeats`（exchange/lack）、`currentPlayer`（play/claim） |
| 徽标 | `lackSuits`、`tingSeats`、`isOut`、`huInfos`、`trustees` |
| 听牌 | `tingTiles`（最多 9）、`maxFanForMe` |
| 牌河/副露/亮牌 | `discards`、`melds`、`revealedHands` |
| claimSource | `windowId` 前缀 + `currentPlayer` + discards/melds（客户端派生） |
| 座位分数 | `balances`、`pendingScoreChanges`（只在座位牌） |

## 9. 实施顺序

0. **mockup**：六档（1334×750、1623×750、1778×750、1334×833、1334×1000、1334×1334）× 正常态 + 可达最坏态（mid/top24/side17/revealed/heavy/maxDiscards/fourMelds、9 听、长名字、6 位余额、0s、4 动作）。844×390 只作为 1623×750 缩 0.52 的视口。用户确认后改代码。
1. 新增 `mahjongTableLayoutV2` + 测试（复用原型算法）；旧函数保留。
2. Hub + 座位牌 + 四向牌河接 v2；截图对照 mockup，用户确认。
3. 手牌 + 2×2 动作区 + 听牌行；截图确认。
4. 动效/音效/震动按 6.2。
5. 六档截图/录屏 + 真机走查 → 部署测试服。

每步一个提交；截图不过不进下一步。

## 10. 测试与验收

### 10.1 矩阵

- 画布：1334×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
- 可达状态：normal、mid、top24、side17、revealed（14 亮牌）、heavy（对家 4 副露）、maxDiscards（24/14/9/9）、fourMelds（上/左各 4 副露）、9 听。
- 组件态：长名字、6 位余额、3 角标、4 动作、claim 单“过”、0s、托管取消、换三张、定缺。
- 不测 36 张/家；注释说明 108 张川麻不可达。

### 10.2 断言

- 所有矩形在画布内；hub×河/背/座位牌/手牌/动作区；动作区×手牌/河/侧区/侧副露；座位牌×手牌；选中抬 10×动作区/河/副露/听牌；听牌×河/手牌/动作区/副露；河×侧河/背。
- 容量：`visible ≤ rows×cols`（侧）、`≤ cols×2`（上/下）；revealed 14 可放。
- 比例：侧河 56×45.714 与 49/40 的误差 ≤1e-9（用精确值 `56*40/49`）。
- Hub：compact 阈值/内容；状态行；无分数；听 N。
- 动作区：≤4 槽；pass 唯一；多杠合并；4 种 mode。
- 动效：发牌仅局首；claim/重连不重放；出牌确认前手牌/选中不变；reduced-motion 无残留；infinite 计数 = 1（claim）。
- 回归：client 全量、`vue-tsc`、`uni build`。

### 10.3 视觉验收

六档截图并排；最坏态逐档；每类事件录屏；真机走查摸牌/出牌/碰杠/胡/结算/托管/重连。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 满副露/多弃牌时 hub 缩到 compact | 原型已验证 162.4 可用；compact 定义明确；六档截图 |
| 侧区/动作区/听牌行碰撞 | 原型断言 + Board 只信布局输出 |
| 小屏字号/触控 | 按钮 84（0.52 下约 44 CSS px）；名字/分数 22；角标 18；六档实拍 |
| 动效掉帧/多个 infinite | 一个 infinite；源码闸；reduced-motion 登记 |
| 重连/claim 重放 | dealEpoch + 首版 seed + 增长判定 |
| 108/136 张玩法差异 | 本片按 108 张；136 张另立 spec |

## 12. 回退

分步提交；任一步可整步 revert；测试服 `rollback.sh <上一个 dev-tag>`；不触碰协议/服务端。

## 13. 决策表

| 编号 | 决策 |
|---|---|
| D1 | 川麻红金气质；布局 A；座位牌上家左上/下家右上/对家上中/自己左下 |
| D2 | 血战盘动态 160–200；compact <180；只放牌墙/倒计时/方位/徽标/状态行 |
| D3 | 上/下河 8/12 列 ×2；侧河 rows 3–8、cols 2–8；单家上限约 24 |
| D4 | 手牌 108；动作区 2×2 84；净空 16 |
| D5 | 听牌行 2×5（最多 9），自家河左侧 |
| D6 | 座位牌 140/144/56；名字/分数 22；角标 ≤3；无张数 |
| D7 | 发牌每局首个 view；删除 phase==='play' 门 |
| D8 | 出牌确认后牌河落点；不做幽灵；删预提交飞 |
| D9 | 动效复用现有；新增 3 类；全部 reduced-motion |
| D10 | 音效复用；补杠 MjGang；选牌提示 MjSort |
| D11 | 红金 token 新值；天月旧 token 不恢复 |
| D12 | 外框 `::before`/阴影 |
| D13 | 分数只在座位牌；Hub 不显示 |
| D14 | 侧河 56×45.714（49:40） |
| D15 | play 固定环；claim/exchange/lack 比例环 |
| D16 | claim 多杠合并；pass 去重；抢杠胡高亮副露 |
| D17 | 座位卡静态金边；唯一 infinite = claim 动作呼吸 |
| D18 | 跨局 reset `ended→exchange\|lack`；SBR 覆盖 |
| D19 | 108 张容量；36 张不测 |
| D20 | mockup 六档 + 可达最坏态 + 每步截图门 |

## 14. 开放问题

无。v2 审查中的几何问题已由原型六档 ALL GREEN 收口；状态/动效问题已在本文件定义。若 mockup 超出 ±4 尺寸微调，需回到本文件修订。
