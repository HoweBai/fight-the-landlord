# 麻将牌桌「川麻红金」重做设计 spec v2

日期：2026-11-05
状态：v2，待对抗审查
取代：`2026-11-05-mahjong-table-redgold-design.md`（v1，已审查，Critical 9 / Important 12 / Minor 1）
范围：纯客户端展示层（麻将牌桌）

## 0. v2 修订记录

| 审查问题 | v2 处理 |
|---|---|
| C1 动作轨/自己座位牌在 s>1 压手牌；锚点自相矛盾 | 动作区改为**手牌右上方 2×2 网格**（84×84，176×176），不再占左右侧边；自己座位牌恢复 56×76；动作区底边 = 手牌顶 − 6 |
| C2 竖向预算漏算副露；自己副露 36 与 44.8 不符 | 竖向栈显式计入 top/self 副露 44.8；血战盘改为**动态 160–200**，按剩余高度取；给出正常/满副露两份预算 |
| C3 牌河容量 8×3=24 装不下 36；侧河 2×8=16 装不下 17 | 牌河**按列扩展**，不按行：上/下 8→12→18 列 ×2 行；侧 2→3→4 列 ×动态行数；`fit` 只缩不增行 |
| C4 听牌行放不进 192 盘 | 听牌行移出盘外，放在**手牌左上方**（与动作区同一竖向带），盘内只留「听 N 张」徽标 |
| C5 844×390 是视口不是画布 | 布局矩阵改为设计画布尺寸；844×390 只作为 1623×750 缩 0.52 的视觉视口 |
| C6 座位牌 128×56 装不下内容 | 对手牌 140×56：头像 56 + 名字 18/分数 22 两行；庄/缺/听/胡/托管/张数全部做**头像角标**；自己牌 56×76（头像+分数） |
| C7 发牌无触发谓词，claim/重连重放整手 | 增加 `dealEpoch` 一次性谓词；手牌 key 不再用 phase；claim/重连不触发；音效对齐同一触发 |
| C8 出牌本地先飞，拒绝后手牌永久隐形 | 改**确认后飞**：真实手牌不隐藏；确认后用槽位→牌河幽灵播 0.24s；未确认不飞；拒绝走现有 notice |
| C9 动作轨容量不足、两个“过”、按钮太小 | 动作区 2×2 固定 4 槽；`pass` 去重只留一个；多胡合并为「胡 N」；按钮 84（0.52 缩放下约 44 CSS px）；换三张/定缺用同一 2×2 区 |
| I: 倒计时环无 play 总时长 | play 阶段固定金环 + 数字；claim/exchange/lack 用 `mahjongRules.*WindowMs` 算比例；不用 CSS keyframe 做收缩 |
| I: rob 无弃牌可高亮、claim 删牌导致旧牌脉冲 | `claimSource` 支持 `discard`/`meld` 两种；最后弃牌按**每座弃牌数增长**判定，claim 缩短不触发 |
| I: 重连胡 banner 重播 / reduced-motion 永久停留 | 首版 view seed `seenHuSeats`；banner 增加非 animationend 清理路径；新 `anim-*` 全部登记 reduced-motion |
| I: V2 接口缺字段、accent 需要 mySeat | 补全 backs/meld/claim/action rect 字段；布局函数加 `mySeat` 输入；列出测试删改清单 |
| I: 左右牌素材 49×40 与 56×37 不符 | 侧河牌盒改为 **56×45.7**（保持 49:40），不换素材 |
| I: ClaimTile/HuBanner/牌背/托管遮罩仍是绿色 | 这些组件纳入红金 token 改造；牌面/牌背图片不改 |
| I: 四家色对比度、小屏字号/触控 | 家色只做亮色点/线；徽标深底 cream 字；名字 22、分数 24、徽标 20；按钮 84 |
| I: mockup/分步验收门不足 | mockup 加最坏态帧；第 1 步保留旧函数；第 2/3 步各加截图确认门 |

## 1. 背景与目标

当前牌桌是 10-30 四家围桌布局（天月风回退后的基线）。两次重做都被整片回退：

| 片 | 做了什么 | 结果 |
|---|---|---|
| 10-30 中央牌板 | 四道全高 + 信息格占满中间列 + 副露移出竖向预算 | 整片回退 `7c7e2424` |
| 11-02 天月风 v1+v2 | 蓝青桌面/炭黑中央盘/冷白牌/亮蓝背 + 中央四家信息 | 整片回退 `7a235324` |

本次目标是重做**信息骨架 + 动线**，不是换皮。用户已确认：川麻红中血流气质、布局 A（经典围桌 + 紧凑血战盘）、座位牌上家左上/下家右上/对家上中/自己左下、布局与信息层次 + 交互与动效全选。

## 2. 两次回退的教训

1. 不用大面板解决信息问题：血战盘只放牌墙/倒计时/行动方位/状态徽标。
2. 不一次性整片重做再验收：mockup 先行，四档确认后才改代码。
3. 不为氛围牺牲可读性：牌河不能缩到看不清，信息不在边缘重复。
4. 动效不是常驻装饰：同一时刻最多一个 `infinite` 动画。
5. 保留已合入的非视觉修复（`wallEmptyWithHu`、结算面板增强等）。

## 3. 范围

### 做

- 重写布局纯函数 v2：动态血战盘、四条围成十字的牌河、靠角座位牌、手牌、2×2 动作区、听牌行。
- 新增 `MahjongHub.vue`；`MahjongSeatChip` 加靠角变体；`MahjongRiver` 四方向 + 动态列；`MahjongBoard` 重装配。
- 红金 token；ClaimTile/HuBanner/MahjongTile（边框/阴影）/MahjongMeld/托管遮罩/结算主按钮纳入配色改造。
- 动效、音效、震动按第 6 节落地；全部复用现有素材。
- 布局/组件/动效/主题/视觉测试与六档截图。

### 不做

- 不换牌面/牌背图片素材；不新增图片或音效。
- 不改协议/服务端/数据库/admin。
- 不做二次元角色立绘。
- 不做拖拽出牌；保留单击选中、同张 400ms 内双击出牌、再点取消（>400ms）、出牌按钮。
- 不重做结算页布局；只给结算面板主按钮换 token、四行加 35ms 错峰。
- 不新增东南西北/局数数据；方位用屏幕四向未标注点。

## 4. 构图与布局账

### 4.1 分区

| 区域 | 位置 | 内容 |
|---|---|---|
| 顶部栏 | 0–64 | 左：房间/底分；中：对家座位牌；右：托管/更多 |
| 上家/下家座位牌 | 左上/右上角 | 头像 + 名字 + 分数 + 头像角标 |
| 自己座位牌 | 左下角，手牌左侧 | 头像 + 分数（56×76） |
| 血战盘 | 画布正中 | 牌墙数、倒计时、当前行动方位点、四家状态徽标 |
| 四条牌河 | 血战盘上/下/左/右 | 围成十字；副露贴各自河外侧 |
| 手牌 | 底部居中 | 14 张，摸牌独立 12 |
| 动作区 | 手牌右上方 | 2×2 网格，最多 4 个 84×84 按钮 |
| 听牌行 | 手牌左上方 | 最多 8 张 20×30 + 「听 N 张」 |

### 4.2 关键尺寸（s=1，允许 ±4 微调）

| 元素 | 基线 |
|---|---|
| 顶部栏 | 64 |
| 血战盘 | 动态 160–200，正常 200、满副露约 166 |
| 上/下牌河牌高 | 56，2 行 |
| 左/右牌河牌盒 | 56×45.7（保持素材 49:40） |
| 手牌高 | 108 |
| 摸牌间隔 | 12 |
| 副露牌高 | 44.8（56×0.8） |
| 对家牌背 | 高 46，14 张水平 |
| 左右牌背 | 高 45.7，pitch 动态 8–22 |
| 对手座位牌 | 140×56 |
| 对家座位牌 | 144×56（顶部栏中央） |
| 自己座位牌 | 56×76 |
| 动作按钮 | 84×84；2 列 × 2 行；动作区 176×176 |
| 听牌小牌 | 20×30 |
| 桌面外框 | 12（用 `::before`/阴影画，不用 CSS border） |

### 4.3 布局算法（纯函数，按顺序算）

**竖向栈**（从上到下）：

1. `bar = 64`。
2. `gap = 4`。
3. 对家牌背 `46`；gap 4。
4. 对家副露 `44.8`（有副露才占位）；gap 4。
5. 对家牌河 `2×56 + gap = 114`；gap 4。
6. **血战盘**：先算固定部分
   `fixed = bar + topBacks + topMeld + topRiver + ownRiver + selfMeld + hand + outer + gaps`
   `hub = clamp(H - fixed - gaps, 160*s, 200*s)`；若 `H - fixed - gaps < 160*s`，取实际值并在测试里标记降级。
7. 自己牌河 `114`；gap 4。
8. 自己副露 `44.8`（有副露才占位）；gap 12（保证选中抬起 10 不压副露）。
9. 手牌 `108`；外框 12。

**正常态 1334×750（无副露）**：固定 458 + 20 gaps = 478；`hub = 200`；总 678，余 72 作为弹性间距。
**满副露 1334×750**：固定 547.6 + 36 gaps = 583.6；`hub = 166.4`；总 750，正好贴底。

**动作区**：

- `actions.rect = { left: W - outer - 176*s - 12*s, top: handTop - 6*s - 176*s, width: 176*s, height: 176*s }`；右对齐。
- 4 个槽位 84×84 + gap 8，2×2；按 phase 决定槽位内容（见 6.2）。
- 动作区与手牌/牌河/侧区不相交：横向在自家牌河右侧，纵向在右侧区下方。

**侧区**：

- `sideTop = topRiver.top`；`sideBottom = actions.rect.top - 4*s`。
- `sideRows = clamp(floor((sideBottom - sideTop + gap) / (sideTileH + gap)), 3, 8)`。
- `sideCols = max(2, ceil(discards / sideRows))`，上限 6；超出按 `fit` 缩牌。
- 侧牌背 `pitch = clamp((sideBottom - sideTop - 45.7*s) / 13, 8*s, 22*s)`；14 张。
- 侧副露竖向贴河外侧，高 `melds*sideMeldH + gaps`；与河取较高者。

**横向**：

- 侧区宽 = 牌背宽 + gap + 侧河宽（cols×56 + gaps）。
- 中心宽 = W − 2×侧区宽 − 2×gap。
- 上/下河列数 = 8（≤16 张）→ 12（≤24）→ 18（≤36）；宽度超出中心宽时 `fit` 缩牌。
- 血战盘在中心区水平/垂直居中。

### 4.4 牌河规则

- 上/下河：8 列×2 行（16）→ 12 列×2（24）→ 18 列×2（36）；不增行。
- 左/右河：行列由 4.3 动态算；容量 = cols×rows，至少 6、最多 36；超出 `fit`。
- 36 张上/下河与 36 张侧河组合时，优先保上/下河列数，侧河 `fit` 缩牌；测试覆盖该组合。
- 每条河靠桌心一侧有 `$ftl-hairline` 家色细线；最后一张弃牌金边 + 0.6s 脉冲。
- 最后弃牌判定：每座 `discards.length` **增长**时记录 `{seat, tile, count}`；claim 导致缩短时清空，不把旧牌当最新。

### 4.5 血战盘内容

- 牌墙数 48px 等宽数字 + 「牌墙」16px 标签。
- 倒计时：play 阶段固定金环 + 秒数；claim/exchange/lack 用 `mahjongRules.*WindowMs` 算环比例；最后 5s 变红 + 脉冲。
- 当前行动方位：屏幕四向四个小点（上/右/下/左），点亮 `currentPlayer`；不写东南西北。
- 四家状态徽标：缺/听/胡/出局/托管，20px，挂盘缘四个对角位。
- 听牌时盘内只显示「听 N 张」徽标；小牌行在 4.6。

### 4.6 手牌、动作区、听牌行

- 手牌 14 张居中，高 108；摸牌独立 12；选中抬起 10（保持现有 `--mj-tile-lift`）。
- 动作区 2×2 84px 槽，右对齐于手牌右上方；内容按 phase：
  - `play`：出牌（宽 176 主按钮）、自摸胡、杠；最多 3 个。
  - `claim`：碰/杠/胡/过；多胡合并为「胡 N」按钮（点击弹 ClaimTile 列表）；`claimsForMe` 里的 pass 过滤掉，只留一个「过」。
  - `exchange`：换三张（宽 176）+ 已选 x/3 文本。
  - `lack`：万/筒/条三个 84 按钮 + 推荐提示。
- 听牌行在手牌左上方：`x = hand.left + 8`，`y = handTop - 36`，最多 8 张 20×30 + 「听 N 张」；不压副露（副露居中，听牌行靠左）。

### 4.7 座位牌内容

- 对手牌 140×56：头像 56；文本列 74 = 名字 18 一行（超长省略）+ 分数 22 一行。
- 自己牌 56×76：头像 + 分数，名字省略。
- 庄/缺/听/胡/托管/张数全部做**头像角标**（20px）；不做第三行文字。
- 余额 ≥100k 用「万」紧凑格式（沿用 v2 天月的 6 位分数规则），避免 6 位数字溢出。

## 5. 信息层级与视觉权重

**动线**：血战盘 → 手牌/动作区 → 自家牌河 → 座位牌 → 对手牌河/副露。

| 层级 | 内容 | 权重 |
|---|---|---|
| L1 | 血战盘 | 牌墙 48；倒计时环 6；方位点 12；徽标 20 |
| L2 | 手牌 | 108；摸牌独立；选中抬 10 + 金边；不可出降饱和 |
| L3 | 动作区 | 主按钮金实心 84；次按钮描金 84；只显示可用动作 |
| L4 | 自家牌河/副露 | 牌 56；最后弃牌金边；副露组距 8 |
| L5 | 对手 | 头像 56、名字 18、分数 22、徽标 20；牌背/副露降对比 |

**去重**：牌墙只在盘；分数只在座位牌；缺/听/胡只在本人座位牌角标 + 盘缘徽标；房间/底分只在顶栏；听牌小牌只在手牌上方。

**同一时刻最多一个 `infinite` 动画**：
- `play`：当前座位静态金边 + 血战盘环（数据驱动，非动画）；
- `claim`：动作按钮呼吸（唯一 infinite）；
- `exchange/lack`：轮到我时动作区亮，其余静态；
- 胡牌/结算：胡字横幅压过一切；
- 最后弃牌脉冲只对 `claimSource` 对应的那一张生效。

## 6. 动效与交互

### 6.1 总原则

- 一个主运动，其余 ≤0.2s；时长沿用现有 `ftl-*`（发牌 0.36、出牌 0.24、碰 0.36、杠 0.42、胡 0.8、结算 0.36）。
- 全部从可见态起手，只动 transform/box-shadow；错峰用 CSS 变量，不新增 JS 定时器。
- 每个新 `anim-*` 必须登记 `prefers-reduced-motion`；一次性动画用 `backwards`/`both`，退场用 `forwards` + `animationend`。
- 输入：单击选中；同张 400ms 内二次点击 = 出牌；400ms 后再点 = 取消；长按看听牌保留；出牌按钮保留。

### 6.2 事件表（触发 → 动画 → 清理 → 音效）

| 事件 | 触发谓词 | 动画/类 | 清理 | 音效/震动 |
|---|---|---|---|---|
| 发牌 | `dealEpoch` 首次 `state==='play'`；`ended` 重置；claim/重连不触发 | 手牌 `anim-deal-in-radial`（CSS 变量从盘心到槽位）；对手背 `anim-deal-in-side` 错峰 | `animationend` 清 `dealing` | MjShuffle（exchange 首版）+ MjDeal（同一触发） |
| 摸牌 | `hand.length` 增长且非发牌 | 摸牌位抬 8 + 金边 0.18s；手牌重排 0.2s | 下一手覆盖 | MjSort 轻 |
| 选牌 | 点击 | 抬 10 + 金边 0.08s | 取消即复位 | MjSort 轻；轻震 |
| 出牌 | **确认后**：手牌减少且自家弃牌增长 | 槽位→牌河幽灵 0.24s；牌河新牌 2px 回弹；手牌合拢 0.2s | 幽灵 `animationend` 移除 | MjDeal 轻；轻震 |
| 碰/杠/胡提示 | `claimsForMe` 非空 | 动作按钮自底滑入 0.16s；可响应牌金圈；按钮呼吸（唯一 infinite） | claim 结束移除 | 提示音复用 MjSort 轻 |
| 碰/杠确认 | 副露增长 | 牌飞向副露条 0.24s；复用 `ftl-peng-pop`/`ftl-gang-pop` | `animationend` | MjPeng / 明杠 MjGuafeng / 暗杠 MjRain；轻震 |
| 过 | 点击 | 按钮 0.16s 收起 | 结束 | 无 |
| 回合切换 | `currentPlayer` 变化 | 座位牌静态金边；方位点 0.3s 点亮 | 下一回合覆盖 | 轮到我：轻震 |
| 倒计时 | `seconds` 变化 | 环比例（claim/exchange/lack）；play 固定环 + 数字；最后 5s 红 + 脉冲 | 每秒覆盖 | 最后 5s MjTimeup 一次 |
| 胡牌 | 新 `huInfos`（首版 seed 不算新） | 胡字横幅 + 盘金光 + 亮牌翻转 0.8s | `animationend` **或**结算到达/版本变化 | MjHu；重震 |
| 托管/超时 | `trustees`/`seconds===0` | 座位牌角标 + 降对比；自己动作区显示「托管中」+ 取消按钮 | 状态覆盖 | MjTimeup |
| 结算 | `settlement` 到达 + 2s 揭示 | 现有 `anim-mj-settlement-in` 0.36s；四行 35ms 错峰 | 面板关闭 | Win/Lose cue |

### 6.3 状态 → 发光优先级

| phase | 强（静态金边） | 弱/静态 | infinite |
|---|---|---|---|
| play | `currentPlayer` | 其余 muted | 无（环是数据驱动） |
| claim | 我（若可响应） | 弃牌者金线；其他响应者 muted | 动作按钮呼吸 |
| exchange/lack | 我（未提交） | 已提交 muted | 无 |
| ended | 无 | 赢家金边 | 无 |

### 6.4 数据来源与特殊态

- **play 总时长不可得**：view 只有 `turnDeadlineAt`；play 用固定环 + 数字；claim/exchange/lack 用 `mahjongRules.claimWindowMs/exchangeWindowMs/lackWindowMs`。
- **抢杠胡**：`claimSource` 为 `{kind:'meld', seat, tile}`，高亮杠家副露牌并在胡按钮上显示该牌；不点亮牌河。
- **普通 claim**：`claimSource = {kind:'discard', seat, tile}`；高亮来源座最后一张匹配牌。
- **claim 删牌**：`lastDiscard` 只看每座弃牌数增长；缩短时清空；音效 diff 同样只看增长。
- **重连**：首版 view seed `seenHuSeats`、`seenMeldKeys`、`prevDiscardCounts`，不播已有胡/副露/最后弃牌。
- **reduced-motion**：所有新 `anim-*` 登记；胡 banner/副露 pop 在无动画时用版本变化/结算到达清理，不依赖 `animationend`。
- **多 activeSeats**：按 6.3 表；exchange/lack 的多人同时行动用静态高亮，不用多个 infinite。
- `rob`/`draw` phase：动作区显示「等待响应/摸牌中」，Hub 方位点按 `currentPlayer`。

### 6.5 音效映射

- 复用现有：MjShuffle、MjDeal、MjSort、MjPeng、MjGang、MjGuafeng、MjRain、MjHu、MjTimeup、Win/Lose。
- 明杠 = MjGuafeng，暗杠 = MjRain（沿用现有 `useTableSound`）。
- 「可响应」提示用 MjSort 轻点；不新增 cue。
- 震动只有 `light`/`heavy` 两档（现有 `medium` 与 `light` 同义）；文案统一写轻震/重震。

## 7. 样式 token 与素材

### 7.1 色板

| token | 值 | 用途 |
|---|---|---|
| `$ftl-color-mj-wood-deep` | `#2B0C0C` | 外框/暗角 |
| `$ftl-color-mj-felt` | `#4A1515` | 主桌面 |
| `$ftl-color-mj-felt-light` | `#6A2420` | 桌心高光 |
| `$ftl-color-mj-lacquer` | `#1C0808` | 盘/座位牌底 |
| `$ftl-color-mj-gold` | `#D4A24C` | 金线/主按钮/当前行动 |
| `$ftl-color-mj-gold-deep` | `#8C6224` | 金边阴影/按下 |
| `$ftl-color-mj-cream` | `#F5E6C8` | 主文字 |
| `$ftl-color-mj-ink` | `#2B1608` | 金底深色字 |
| `$ftl-color-mj-urgent` | `#FF6B5A` | 最后 5s |
| `$ftl-color-mj-muted` | `#C9A9A0` | 次要文字 |

家色（只做亮点/细线，不写文字）：东 `#E8C56A`、南 `#E06B5A`、西 `#A9B7C6`、北 `#6C8BB0`。徽标用深漆底 + cream 字；家色只做 3px 点/2px 线，对比度 ≥3:1。

天月风的 `$ftl-color-mj-*` 已随 `7a235324` 删除；本表是全新红金值，不复用旧值。

### 7.2 字体与形状

- 牌墙 48（`$ftl-font-mj-wall`）；分数 24（`$ftl-font-mj-score`）；名字 18（`$ftl-font-mj-name`）；徽标/角标 20（`$ftl-font-mj-badge`）；按钮 28（2 字）/24（3 字）。
- 0.52 缩放下：名字 9.4→保持 18 设计 px 会偏小 ⇒ 名字改 22（11.4 CSS px），分数 24（12.5），徽标 20（10.4）；座位牌文本列仅放两行。
- 数字 `tabular-nums`。
- 血战盘正圆 + 6px 金环 + 2px 暗金内圈；座位牌 `$ftl-radius-md` + `$ftl-hairline`；主按钮金实心 + 4px 深金投影；次按钮透明底 + 金线。
- 外框 12 用 `::before`/`box-shadow` 画，`.mj` 的 `border` 保持 0，避免绝对定位整体偏移。

### 7.3 素材与改造范围

- 牌面/牌背图片不改；侧河按 49:40 比例出盒。
- 纳入红金 token 改造：`MahjongBoard`、`MahjongHub`、`MahjongSeatChip`、`MahjongRiver`、`MahjongTile`（边框/阴影）、`MahjongMeld`、`ClaimTile`、`MahjongHuBanner`、托管遮罩、`MahjongSettlement` 主按钮。
- 桌面/盘/座位牌用 CSS 渐变 + 阴影；素材预算不变。
- 不新增全局字号闸；新 `$ftl-font-mj-*` 只在麻将组件使用；沿用现有 `ui-tokens` 裸 hex 闸。

## 8. 技术落点

### 8.1 布局函数 v2

`apps/client/src/game/mahjong-layout.ts` 新增 `mahjongTableLayoutV2(width, height, input)`；输入为 `{ mySeat, top/left/right/self: {discards, melds} }`。输出：

```ts
interface MahjongTableLayoutV2 {
  s: number;
  bar: Rect;
  hub: { cx: number; cy: number; r: number; rect: Rect; compact: boolean };
  rivers: {
    top: RiverLayout; self: RiverLayout; left: RiverLayout; right: RiverLayout;
  };
  backs: {
    top: { rect: Rect; tile: TileSize; gap: number };
    left: { rect: Rect; tile: TileSize; pitch: number };
    right: { rect: Rect; tile: TileSize; pitch: number };
  };
  seatPlates: { top: Rect; left: Rect; right: Rect; self: Rect };
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number };
  actions: { rect: Rect; slot: TileSize; mode: 'play' | 'claim' | 'exchange' | 'lack' };
  tingStrip: Rect | null;
}
```

`RiverLayout` 增 `direction: 'top'|'bottom'|'left'|'right'` 与 `cols/rows/tile/fit`；不再用 `accent`，归属色由 Board 按座位映射。

### 8.2 组件与测试改动

| 文件 | 改动 |
|---|---|
| `MahjongHub.vue` | 新增；盘内牌墙/倒计时/方位点/徽标 |
| `MahjongCenter.vue` | 删除 |
| `MahjongSeatChip.vue` | `variant: 'corner-tl'|'corner-tr'|'corner-top'|'self'`；角标；cardCount 角标 |
| `MahjongRiver.vue` | 四方向；动态 cols/rows；最后弃牌按增长判定 |
| `MahjongBoard.vue` | 装配 v2；动作区 2×2；`dealEpoch`；`claimSource`；首版 seed；保留 claim 过滤/长按 |
| `ClaimTile.vue` | 红金 token；多胡列表弹层 |
| `MahjongHuBanner.vue` | 红金 token；按新座位算位置；非动画清理 |
| `MahjongTile.vue` / `MahjongMeld.vue` | 边框/阴影 token（图片不改） |
| `MahjongSettlement.vue` | 主按钮 token；四行 35ms 错峰 |
| `animations.scss` | 新增 `ftl-deal-in-radial`、`ftl-deal-in-side`、`ftl-discard-land`、`ftl-claim-in`；全部登记 reduced-motion |
| `uni.scss` | 红金 token 与字体 token |
| `useTableSound.ts` | 发牌/摸牌/出牌触发对齐；明杠/暗杠映射保留 |
| `table.vue` | 传 `mySeat`；动作区 phase；失败 notice 不触发幽灵 |

**测试删改**：

- 删除 `mahjong-center.test.ts`；新增 `mahjong-hub.test.ts`。
- `mahjong-board.test.ts`：`.mj-center` → `.mj-hub`；补发牌 epoch、claim 两个“过”、抢杠胡、重连 seed。
- `mahjong-seat-chip.test.ts`：四变体 + 角标。
- `mahjong-layout.test.ts`：重写矩阵/锚点/不相交/容量。
- 新增 `mahjong-action-bar.test.ts`、`mahjong-river.test.ts` 扩展。
- `animations.test.ts`：reduced-motion 清单闸。

### 8.3 数据来源

| UI | 字段 |
|---|---|
| 牌墙/阶段 | `wallCount`、`state` |
| 倒计时 | `turnDeadlineAt` + `seconds`；claim/exchange/lack 用 rules 窗口 |
| 方位/发光 | `currentPlayer`、`activeSeats` |
| 徽标 | `lackSuits`、`tingSeats`、`isOut`、`huInfos`、`trustees` |
| 听牌行 | `tingTiles`、`maxFanForMe` |
| 牌河/副露 | `discards`、`melds`、`revealedHands` |
| 座位牌分数 | `balances`、`pendingScoreChanges`（只在座位牌） |

## 9. 实施顺序

0. **高保真 mockup**：1334×750、1623×750、1778×750、1334×833、1334×1000、1334×1334 六档；每档含正常态 + 最坏态（17/24/36 弃、4 副露、8 听、长名字、6 位余额、0s、4 动作）。844×390 只作为 1623×750 缩 0.52 的视口审阅。用户确认后才改代码。
1. 新增 `mahjongTableLayoutV2` + 测试；旧 `mahjongTableLayout` 保留，Board 暂不切。
2. Hub + 座位牌 + 四向牌河接 v2；**截图对照 mockup，用户确认**。
3. 手牌 + 2×2 动作区 + 听牌行；**截图确认**。
4. 动效/音效/震动按 6.2 落地。
5. 六档截图/录屏 + 真机走查 → 部署测试服。

每步一个提交；测试随步更新；任一步截图不过不进入下一步。

## 10. 测试与验收

### 10.1 布局矩阵

设计画布：1334×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
物理视口：844×390 单独在 `landscape-canvas.test.ts` 断言 → 1623×750、scale 0.52。

状态组合（最坏组合各一档）：
- 上家 36 弃 + 0 副露；上家 17 弃 + 4 副露；
- 侧家 36 弃 + 4 副露；自己 36 弃 + 4 副露；
- 8 面听；长名字；6 位余额；0s；4 动作；换三张；定缺。

### 10.2 断言

- 所有矩形在画布内。
- 不相交：hub × 河/背/座位牌/手牌/动作区；动作区 × 手牌/河/侧区；座位牌 × 手牌；副露 × 手牌（选中抬 10 后）。
- 牌河：实际 discards 数 ≤ cols×rows；36/17 极端组合不溢出；侧河牌盒比例 = 49/40。
- 听牌行：每张小牌在盘外、不压副露；8 张可放。
- Hub：牌墙/倒计时/方位点/徽标存在；无分数；听牌时只显示「听 N 张」。
- 动作区：≤4 槽；pass 只有一个；多胡合并；换三张/定缺可放。
- 动效：发牌只在 epoch 首帧；claim/重连不重放；出牌未确认不隐藏；reduced-motion 全部登记。
- 回归：client 全量测试、`vue-tsc`、`uni build`。

### 10.3 视觉验收

- 六档截图并排当前版本；最坏态帧逐档确认。
- 每类事件一条录屏/连拍。
- 真机走查摸牌/出牌/碰杠/胡牌/结算/托管/重连。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 满副露/36 弃时竖向或横向不够 | 动态 hub 160–200、动态侧河行列/pitch、上/下河列扩展；最坏组合进测试 |
| 动作区与侧区/手牌碰撞 | 2×2 固定槽 + 不相交断言；侧区底缘 = 动作区顶 − 4 |
| 小屏字号/触控 | 按钮 84（0.52 下约 44 CSS px）；名字 22/分数 24/徽标 20；六档截图验证 |
| 动效掉帧 | 只动 transform/box-shadow；一个 infinite；新类登记 reduced-motion |
| 重连/claim 重放 | dealEpoch + 首版 seed + 按增长判定最后弃牌 |
| 影响其它玩法 | token/类名 `mj-` 前缀；全量 client 测试 |

## 12. 回退

- 分步提交；任一步可整步 revert。
- 测试服部署后如需回滚：`bash scripts/deploy/rollback.sh <上一个 dev-tag>`。
- 不触碰协议/服务端。

## 13. 决策表

| 编号 | 决策 |
|---|---|
| D1 | 目标气质：川麻红中血流（红金、大字、血战感） |
| D2 | 布局 A：经典围桌 + 紧凑血战盘 |
| D3 | 座位牌：上家左上、下家右上、对家上中、自己左下 |
| D4 | 血战盘动态 160–200；只放牌墙/倒计时/方位/徽标，不放分数 |
| D5 | 四条牌河围成十字；上/下按列扩展，侧河动态行列 |
| D6 | 手牌 108；动作区 2×2 84 在右上方 |
| D7 | 听牌行移出手牌左上方；盘内只留「听 N 张」 |
| D8 | 座位牌 140×56（对手）/144×56（对家）/56×76（自己）；角标 |
| D9 | 发牌用 `dealEpoch` 一次性触发；claim/重连不重放 |
| D10 | 出牌确认后飞；未确认不隐藏真实手牌 |
| D11 | 输入保持单击/双击/按钮；长按看听牌保留 |
| D12 | 动效复用现有 `ftl-*`；新增 4 个类全部登记 reduced-motion |
| D13 | 音效复用现有；明杠 MjGuafeng、暗杠 MjRain；不新增素材 |
| D14 | 红金 token 新值；天月旧 token 不恢复 |
| D15 | 外框用 `::before`/阴影，不用 CSS border |
| D16 | 只在座位牌显示分数；Hub 不显示 |
| D17 | 左右牌盒 56×45.7（49:40），不换素材 |
| D18 | play 倒计时固定环；claim/exchange/lack 用 rules 窗口 |
| D19 | claim 多胡合并；pass 去重；抢杠胡高亮副露牌 |
| D20 | mockup 六档 + 最坏态 + 每步截图门 |

## 14. 开放问题

无。review 中的布局/数据/触发问题已在本文件收口；若 mockup 超出 ±4 的尺寸微调，需回到本文件修订。
