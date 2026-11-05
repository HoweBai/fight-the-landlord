# 麻将牌桌「川麻红金」重做设计 spec v4

日期：2026-11-05
状态：已被 v5 取代（`2026-11-05-mahjong-table-redgold-design-v5.md`）；本文件保留 v4 审查前版本。
取代：`2026-11-05-mahjong-table-redgold-design-v3.md`
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（路线 A 原型；七档 × 7 个可达态 **ALL GREEN**）。

## 0. 路线 A 与 v4 关键决策

用户选择 **A 务实路线**：动作区用行动时浮层；牌河显示上限 24，超出「+N」；hub 160–200。v4 在此前提下修完 v3 审查的 5 个几何 Critical + 2 个交互 Critical：

| v3 问题 | v4 处理 |
|---|---|
| 单家弃牌可达 ~29，24 容量溢出 | 四条河**显示上限 24**，超出显示「+N」；上/下 12 列×2、侧河 rows 3–10 × cols 2–6；可达 29 态原型全绿 |
| 原型用不可达态、漏相交对 | 原型改 7 个可达态（含两家幸存 29/25、top29）；补齐 topBacks×座位牌、actions×selfMeld、hub×侧副露/牌背等 pair；七档 × 7 态全绿 |
| topBacks 锚在 handLeft，压座位牌 | topBacks/topMeld 按 centerCx 居中；补 pair，normal 不再相交 |
| actions×selfMeld 相交 | 自己副露收窄到内容宽并居中；动作区右缘 = 右侧区左缘 − gap；原型无相交 |
| hub 未按 center 区居中/夹取 | hub.cx = centerCx；`hubD ≤ centerW − 2gap`；compact = hubD/s < 180 |
| sideTop 公式漂移 | 统一 `sideTop = max(topRiver.top, plateBottom + gap)`；侧区底 = handTop − 16（不再受动作区影响） |
| 座位牌 22px 名字放不下 | 名字 18（3 字 + 省略）、分数 20；自己牌 64×76、分数 18；角标 16、最多 3；delta 拼在分数行 |
| 发牌触发矛盾 | 挂载已有 view 且 version>1 ⇒ seed 不播；首个观察到 version===1 的 exchange/lack ⇒ 播；`null→view` v1 播、v>1 seed；`ended→exchange\|lack` 播 |
| MjShuffle + MjDeal 同 tick | 发牌时刻只播 **MjShuffle**；MjDeal 移到**首次 `state==='play'`**，两者不同 tick |
| play 动作误挂 infinite | 呼吸条件限定 `phase==='claim'`；play 只做 0.16s 滑入 + 静态金边 |
| 强制胡仍渲染“过” | `showPass = myClaims.some(o=>o.claim==='pass')`；options 过滤 pass；强制胡用例 |
| 多杠选择器放错组件 | 多杠选择器在 **play 动作区**（Board 内联/新 ActionBar）；ClaimTile 只负责 claim |
| `dealing` 按版本清理掐断错峰 | 只在**下一局重置点**清（version===1 / ended→exchange\|lack / 重挂载）；不按任意版本变化清 |
| `both` 压选中抬升 | 发牌/手牌类必须 `backwards`；只有退场用 `forwards`；新增闸 |
| 手牌重排 0.2s 需要 FLIP | 接受**瞬间重排**；删掉“合拢/重排 0.2s”的承诺；只保留牌河落点 |
| 胡 banner reduced-motion 卡队列 | 下一版 huInfos 增长或 settlement 到达时确定性出队；组件测试 |
| urgent 脉冲是共享类 | 新建麻将专用 `anim-mj-urgent`（有限 3 次），不动 `.anim-urgent-pulse` |
| 音效映射/跨局重置 | useTableSound 与 dealEpoch 同一谓词；SBR 纳入；删 lack→play MjDeal；补 MjGang/选牌提示；新增 audio 测试 |
| claim 只有胡删牌，碰/杠不删 | 客户端**隐藏被副露吃掉的末张弃牌**；hu 由服务端删；最后弃牌按每座增长 + claimed 过滤 |
| River/HandBacks 契约缺失 | 补 `riverDirection`/`meldLane`/HandBacks `dealing`；列入测试 |
| 布局输入缺 ting / bySeat 矛盾 | 输入改 `bySlot` + `tingCount`；`riverDirection` 与 `tileDirection` 分开 |
| rob/draw 死规则 | 不删协议类型；`rob:` 是 claim 窗口 kind；客户端只分支现有 phase |
| isOut 死徽标 | 徽标优先级删“出局”（isOut 只在胡时置 true） |
| 9 听 +N 死分支 | ting 上限 9，2×5 恰好；>9 截断并加测试 |
| 现有 1500×750 矩阵丢失 | 画布矩阵加 1500×750（共 7 档） |

## 1. 背景与目标

当前牌桌是 10-30 四家围桌布局（天月风回退后的基线）。两次重做被整片回退：10-30 中央牌板 `7c7e2424`、11-02 天月风 v1+v2 `7a235324`。本次重做**信息骨架 + 动线**，目标气质川麻红中血流（红金、大字、血战感），布局 A：经典围桌 + 紧凑血战盘；座位牌上家左上、下家右上、对家上中、自己左下。

## 2. 两次回退的教训

1. 不用大面板解决信息问题。
2. mockup 先行。
3. 不为氛围牺牲可读性。
4. 同一时刻最多一个 `infinite`。
5. 保留已合入的非视觉修复。

## 3. 范围

### 做

- 布局纯函数 v2：动态血战盘、四向牌河（显示 24+N）、靠角座位牌、手牌、2×2 动作浮层、听牌行。
- `MahjongHub` 新增；`MahjongSeatChip` 靠角变体；`MahjongRiver` 四方向 + 显示上限 + claimed 过滤；`MahjongHandBacks` dealing；`MahjongBoard` 重装配 + 新 ActionBar。
- 红金 token；ClaimTile/HuBanner/Tile（边框/阴影）/Meld/托管遮罩/结算主按钮纳入改造。
- 动效/音效/震动按第 6 节；全部复用现有素材。
- 七档 × 可达最坏态测试与截图。

### 不做

- 不换牌面/牌背图片；不新增图片/音效。
- 不改协议/服务端/数据库/admin。
- 不做角色立绘、拖拽出牌。
- 不重做结算页布局；只换主按钮 token + 四行 35ms 错峰。
- 不新增东南西北/局数。
- 不做 136 张玩法；36 张/家不测。

## 4. 构图与布局

### 4.1 分区

| 区域 | 位置 |
|---|---|
| 顶部栏 | 左：房间/底分；中：对家座位牌；右：托管/更多 |
| 上家/下家座位牌 | 左上/右上角 |
| 自己座位牌 | 左下角，手牌左侧 |
| 血战盘 | center 区正中 |
| 四条牌河 | 盘上/下/左/右，围成十字；副露贴各自河外侧 |
| 手牌 | 底部居中 |
| 动作区 | 手牌右上方 2×2；行动时浮层，非行动时隐藏 |
| 听牌行 | 自家牌河左侧（2 行 × 5） |

### 4.2 关键尺寸（s=1）

| 元素 | 基线 |
|---|---|
| 顶部栏 | 64 |
| 血战盘 | 动态 160–200；`compact = hubD/s < 180` |
| 上/下河牌 | 56 高 ×2 行；8/12 列；显示上限 24 |
| 左/右河牌 | 56×45.714（49:40）；rows 3–10、cols 2–6；显示上限 24 |
| 手牌 | 108；选中抬 10；净空 16 |
| 对家牌背 | 高 46，按 centerCx 居中 |
| 左右牌背 | 56 宽 × 45.714；pitch 8–22 |
| 副露 | 44.8 高；侧副露 36.4×29.714；自己副露宽 = 内容宽（≤ 3 张×组数）并居中 |
| 对手座位牌 | 140×56 |
| 对家座位牌 | 144×56（顶栏内） |
| 自己座位牌 | 64×76（头像 48 + 分数 18） |
| 动作按钮 | 84×84；动作区 176×176 |
| 听牌小牌 | 20×30；2×5，最多 9 |
| 外框 | 12（`::before`/阴影） |

### 4.3 布局算法（原型已验证）

**s** = `max(1, min(H/750, 0.86W / 手牌行宽))`；手牌行宽 = `14*108*(75/113)+13*2+12`。

**竖向**：

1. bar 64 → gap 4 → 对家背 46 → gap 4 → 对家副露 44.8（有则）→ gap 4 → 对家河 114 → gap 4。
2. 底部：自己河 114 → gap 4 → 自己副露 44.8（有则）→ 净空 16 → 手牌 108 → 外框 12。
3. 中间自由区 = 对家河底 .. 自己河顶；`hubD = min(clamp(自由区−2gap, 160s, 200s), centerW−2gap)`；hub 在 center 区居中（`cx=centerCx`）。
4. 七档实测：1334×750 normal hub 200；mid 162.4（compact）；1334×833/1000/1334 s=1.101，hub 220.3/185.8。

**侧区**：

- `sideTop = max(topRiver.top, plateBottom + gap)`。
- `sideBottom = handTop − 16s`（不受动作区影响）。
- `rows = clamp(floor((available+2s)/(45.714s+2s)), 3, 10)`。
- `visible = min(max(discards, revealed), 24)`；`overflow = raw − visible`。
- `cols = clamp(ceil(visible/rows), 2, 6)`；容量 rows×cols；29 张可达态 → 3 列×9/10 行 = 27/30，显示 24 + 5。
- `pitch = clamp((available − 45.714s)/13, 8s, 22s)`。
- 侧副露内侧 lane；侧区宽 = 背 56s + gap + 河 + (副露 ? gap+36.4s : 0)。
- 原型 top29/twoSurvivors 全绿。

**横向**：

- `centerLeft = outer + leftZoneW + gap`；`centerRight = W − outer − rightZoneW − gap`；`centerCx` 为中点。
- 上/下河：`visible ≤16 → 8 列`，否则 12 列；宽超 centerW 时 fit。
- topBacks/topMeld 按 centerCx 居中；补 `topBacks×plates`、`topMeld×plates` 断言。
- 听牌行：2 行 × 5，`x = max(hand.left+8s, ownRiver.left − gap − tingW)`，`y` 在自家河带内；原型无相交。

**动作区（路线 A）**：

- `actions = { x: W − outer − rightZoneW − gap − 176s, y: handTop − 16s − 176s, 176s, 176s }`；右缘贴右侧区左缘。
- 2×2 84s 槽；行动时显示，非行动时隐藏。
- 允许覆盖自家河右缘（`actions×ownRiver` 记录为允许）；原型在 7 个可达态均未触发该覆盖。
- 自己副露收窄到内容宽并居中，动作区不压自己副露（原型断言）。
- 选中抬 10 与动作区/河/副露/听牌行不相交（净空 16）。

### 4.4 牌河显示与容量

- 108 张川麻：两家早胡后两家交替，单家弃牌可达 ~29；**显示上限 24**，超出显示「+N」。
- 上/下：8/12 列 ×2 = 16/24；超出显示 24 + N。
- 侧：rows 3–10、cols 2–6；容量 6–60；29 张 → 3 列 ×10 行 =30，显示 24 +5。
- 最后弃牌：Board 持有 `prevDiscardCounts[4]` + `lastDiscardIndex[4]`；只在该座增长时更新；hu 缩短清空；碰/杠不缩短，但客户端隐藏被副露吃掉的末张（`claimedDiscard` 过滤）。
- 音效 diff 只看增长；claimed 隐藏不触发出牌音。

### 4.5 血战盘

- 牌墙：normal 48 / compact 40；标签 normal 16 / compact 隐藏。
- 倒计时：play 固定金环 + 秒数（normal 28 / compact 22）；claim/exchange/lack 用 rules 窗口比例；最后 5s 红色；**claim 窗口不播 urgent**；urgent 用麻将专用 `anim-mj-urgent`（有限 3 次）。
- 方位点：屏幕四向 12px 点；play 亮 currentPlayer；claim 亮来源座；exchange/lack 亮 activeSeats。
- 徽标：缺/听/胡/托管（删“出局”，isOut 恒伴随胡），normal 20 / compact 16，盘缘每座一个最紧急（胡 > 听 > 缺 > 托管）。
- 状态行（盘底，normal 16 / compact 14）：完整文案表：
  - exchange：我未选“换三张：选 3 张同花色”；我已选/等待“等待其他玩家换三张…”；非我“等待其他玩家换三张…”。
  - lack：我未选“请定缺”；等待“等待其他玩家定缺…”。
  - play/claim：我“请出牌”/“请响应”；等待“等待其他玩家响应…”；ended“本局结束”/“已胡 N 家”。
  - 昵称/文案超宽省略，最大 12 字 + …；不换行。
- 听牌：盘内「听 N 张」；小牌行在 4.6。

### 4.6 手牌、动作区、听牌行

- 手牌 14 张；摸牌独立 12；选中抬 10；不可出降饱和。
- 动作区 2×2：
  - play：出牌（宽 176）、胡、杠（**多杠合并为「杠 N」选择器**）。
  - claim：碰/杠/胡/过；`showPass = myClaims.some(o=>o.claim==='pass')`，options 过滤 pass，只留一个过。
  - exchange：换三张（宽 176）+ 已选 x/3。
  - lack：万/筒/条三个 84 + 推荐。
- 听牌行 2×5（最多 9）在自己的河左侧；>9 截断（测试 9）。

### 4.7 座位牌

- 对手 140×56：头像 56；名字 18（3 字 + 省略）+ 分数 20 两行；角标 16、最多 3（庄 > 缺 > 胡/听 > 托管）；不显示张数；`pendingScoreChanges` 的 delta 以 `+8`/`-4` 拼在分数行。
- 自己 64×76：头像 48 + 分数 18；名字省略。
- 余额 ≥10000 用 `(n/10000).toFixed(1)` 去 `.0` + 万（`4200` 原样、`10000→1万`、`1234567→123.5万`）；测试三例。

## 5. 信息层级

动线：血战盘 → 手牌/动作区 → 自家牌河 → 座位牌 → 对手牌河/副露。

| 层级 | 权重 |
|---|---|
| L1 血战盘 | 牌墙 48/40；环 6；方位点 12；徽标 20/16；状态行 16/14 |
| L2 手牌 | 108；选中抬 10；不可出降饱和 |
| L3 动作区 | 主按钮金实心 84；次按钮描金 84 |
| L4 自家河/副露 | 牌 56；最后弃牌金边；副露组距 8 |
| L5 对手 | 头像 56；名字 18；分数 20；角标 16；牌背/副露降对比 |

去重：牌墙只在盘；分数只在座位牌；缺/听/胡只在座位牌角标 + 盘缘；房间/底分只在顶栏；听牌小牌只在自家河左侧。

**同一时刻最多一个 `infinite`**：claim 动作按钮呼吸是唯一；play/exchange/lack/ended 均无 infinite；最后弃牌脉冲只对增长的那张；claim 可响应金圈只对 claimSource。

## 6. 动效与交互

### 6.1 原则

- 一个主运动；其余 ≤0.2s；时长沿用现有 `ftl-*`（发牌 0.36、出牌落点 0.24、碰 0.36、杠 0.42、胡 0.8、结算 0.36）。
- 从可见态起手，只动 transform/box-shadow；错峰 CSS 变量；不新增 JS 定时器。
- 发牌/手牌类必须 `backwards`；退场用 `forwards` + `animationend`；新 `anim-*` 全部登记 reduced-motion。
- **接受手牌瞬间重排**，不承诺“合拢/重排 0.2s”；只做牌河落点。
- 输入：单击选中；同张 400ms 内双击出牌；>400ms 再点取消；长按看听牌；出牌按钮。

### 6.2 事件表

| 事件 | 触发 | 动画 | 清理 | 音效/震动 |
|---|---|---|---|---|
| 发牌 | 挂载已有 view 且 version>1 ⇒ seed；首个 version===1 的 exchange/lack ⇒ 播；null→view v1 播、v>1 seed；ended→exchange\|lack 播 | 手牌 `anim-deal-in-radial`（逐牌 CSS 变量由 layout 槽位算）；对手背 `anim-deal-in-side` | **只在下一局重置点清 `dealing`**，不按任意版本 | MjShuffle；震动轻 |
| 首次 play | `state==='play'` 首次进入 | 无额外动画 | — | MjDeal（与发牌不同 tick） |
| 摸牌 | hand.length 增长且非发牌 | 摸牌位抬 8 + 金边 0.18s | 下一手覆盖 | MjSort 轻 |
| 选牌 | 点击 | 抬 10 + 金边 0.08s | 取消复位 | MjSort 轻；轻震 |
| 出牌 | 确认后：手牌减少 + 弃牌增长 | 牌河新牌 `anim-discard-land` 0.24s 2px 回弹；手牌瞬间重排 | 牌河元素自然存在 | MjDeal 轻；轻震 |
| 碰/杠/胡提示 | **phase==='claim' 且 claimsForMe 非空** | 动作按钮滑入 0.16s + 呼吸（唯一 infinite）；可响应牌金圈 | claim 结束移除 | MjSort 轻 |
| 碰/杠确认 | 副露键集合变化（含 peng→gang 替换） | 副露 pop（复用 `ftl-peng-pop`/`ftl-gang-pop`） | animationend + 版本兜底 | MjPeng / 补杠 MjGang / 明杠 MjGuafeng / 暗杠 MjRain；轻震 |
| 过 | 点击 | 0.16s 收起 | 结束 | 无 |
| 回合切换 | currentPlayer/activeSeats | 座位静态金边；方位点 0.3s | 下一回合 | 轮到我轻震 |
| 倒计时 | seconds | play 固定环 + 数字；claim/exchange/lack 比例；最后 5s 红 + `anim-mj-urgent` 3 次 | 每秒覆盖 | 0s MjTimeup 一次 |
| 胡牌 | 新 huInfos（首版 seed 不算） | 胡字横幅 + 盘金光 + 亮牌翻转 0.8s | animationend **或** 下一版 hu 增长/结算到达（reduced-motion 兜底） | MjHu；重震 |
| 托管/超时 | trustees/seconds===0 | 角标 + 降对比；自己动作区「托管中」+ 取消按钮 | 状态覆盖 | MjTimeup |
| 结算 | settlement 到达 + 2s 揭示 | `anim-mj-settlement-in` 0.36s；四行 35ms 错峰 | 面板关闭 | Win/Lose cue（到达时播） |

### 6.3 状态 → 发光

| phase | 强 | 弱/静态 | infinite |
|---|---|---|---|
| play | currentPlayer | 其余 muted | 无 |
| claim | 我（若可响应） | 弃牌者金线；其他响应者 muted | 动作按钮呼吸 |
| exchange/lack | 我（未提交） | 已提交 muted；方位点亮 activeSeats | 无 |
| ended | 无 | 赢家金边 | 无 |

座位卡 active-strong/weak 改**静态金边**（删 `ftl-active-glow` infinite）；ClaimTile 根 pulse 删除；`anim-mj-urgent` 新建，不动共享 `.anim-urgent-pulse`。

### 6.4 数据与特殊态

- **发牌语义**：见 6.2；`dealEpoch` 在“播发牌”时置位；挂载 seed 不播；`ended→exchange|lack` / version===1 重置。
- **claimSource 派生**：`windowId` 前缀 `rob:`/`claim:`；来源座 = currentPlayer；tile = claimsForMe 第一个带 tile 的 option；`rob:` → meld（高亮杠家副露，不点亮牌河）；`claim:` → discard（先匹配 discards 末张同 type，否则 melds 同 type peng）。`rob:` 是 claim 窗口的 kind，不删协议类型。
- **最后弃牌**：Board 持有 prevDiscardCounts/lastDiscardIndex；增长更新；hu 缩短清空；碰/杠不缩短，但客户端隐藏被副露吃掉的末张（`claimedDiscard` 过滤）；River 接收 latestIndex/pulseEpoch；音效只看增长。
- **重连 seed**：首个非 null view seed seenHuSeats/seenMeldKeys/prevDiscardCounts；`null→view` v>1 不播发牌/胡/副露；v1 播发牌。
- **跨局 reset**：`ended→(exchange|lack)` 与 version===1 都 reset；覆盖 SBR。
- **currentPlayer 在 exchange/lack 恒 0**：方位点用 activeSeats；claim 用 currentPlayer；play 用 currentPlayer。
- **方位映射**：以 mySeat 为底，top=(me+2)%4、right=(me+1)%4、left=(me+3)%4。
- **revealedHands**：loads 含 revealed；visible=min(max(discards,revealed),24)；侧家 14 张亮牌显示 14。
- **reduced-motion**：无幽灵；`dealing` 只在重置点清；胡 banner 下一版/结算出队；所有新 anim 登记。
- **rob/draw**：服务端 phase 只有 exchange/lack/play/claim/ended；rob 是 claim 的 windowId kind；客户端不分支 rob/draw。
- **多杠**：play 动作区的「杠 N」选择器；ClaimTile 只 claim。
- **强制胡**：showPass 只认 claimsForMe 里的 pass；强制胡无过。
- **isOut**：不单列徽标（恒伴随胡）。
- **ting**：最多 9；>9 截断。

### 6.5 音效

- 复用：MjShuffle、MjDeal、MjSort、MjPeng、MjGang（补杠）、MjGuafeng（明杠）、MjRain（暗杠）、MjHu、MjTimeup、Win/Lose。
- 发牌 MjShuffle；首次 play MjDeal；选牌/可响应提示 MjSort（Board 直接调 audio 或统一 emit）；不新增 cue。
- useTableSound 的 lastMj* 游标与 Board 的 dealEpoch/跨局 reset 同一谓词；SBR 首版也判“局首”；删 lack→play MjDeal。
- 震动 light/heavy；medium 映射 light。
- audio.test.ts 补：deal/draw/discard/claim/hu/win-lose、首版不补播、SBR 两局。

## 7. 样式 token 与素材

### 7.1 色板

同 v3：wood-deep `#2B0C0C`、felt `#4A1515`、felt-light `#6A2420`、lacquer `#1C0808`、gold `#D4A24C`、gold-deep `#8C6224`、cream `#F5E6C8`、ink `#2B1608`、urgent `#FF6B5A`、muted `#C9A9A0`。家色：东 `#E8C56A`、南 `#E06B5A`、西 `#A9B7C6`、北 `#6C8BB0`；只做亮点/细线，徽标深漆底 cream 字。

### 7.2 字体与形状

- 牌墙 48/40；名字 18；分数 20；自己分数 18；角标 16；状态行 16/14；按钮 28（2 字）/24（3 字）；听 N 16。
- `tabular-nums`；盘正圆 + 6px 金环 + 2px 内圈；座位牌 `$ftl-radius-md` + `$ftl-hairline`；主按钮金实心 + 4px 深金投影；外框 `::before`/阴影。
- 动作浮层：漆面 `rgba(28,8,8,.86)` + 金边；行动时出现，非行动时 `v-if` 不渲染。

### 7.3 素材与改造范围

- 牌面/牌背图片不改；侧河 56×45.714（49:40）。
- 纳入红金：Board、Hub、SeatChip、River、HandBacks、Tile（边框/阴影）、Meld、ClaimTile、HuBanner、托管遮罩、Settlement 主按钮。
- CSS 渐变 + 阴影；素材预算不变。
- 沿用现有 ui-tokens 裸 hex 闸；不新增全局字号闸。

## 8. 技术落点

### 8.1 布局函数 v2

`mahjongTableLayoutV2(width, height, input)`，输入 `{ bySlot: { self, top, left, right: {discards, melds, revealed} }, phase, actionCount, tingCount }`（bySlot，不是 bySeat；方位由 Board 映射）。输出：

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
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number; slots: Rect[] };
  actions: { rect: Rect; slot: TileSize; mode: 'play' | 'claim' | 'exchange' | 'lack' };
  ting: { rect: Rect | null; tile: TileSize; gap: number; max: number; overflow: number };
}
```

`RiverLayout` 增 `riverDirection: 'top'|'bottom'|'left'|'right'`（与 `MahjongTile.direction: 'my'|'top'|'left'|'right'` 分开）、`visible/overflow/meldLane: 'above'|'below'|'inboard'`。`hand.slots` 供发牌 radial 逐牌坐标。

### 8.2 组件与测试

| 文件 | 改动 |
|---|---|
| `MahjongHub.vue` | 新增；牌墙/倒计时/方位/徽标/状态行/听 N |
| `MahjongCenter.vue` | 删除；`mahjong-center.test.ts` 删除，新增 `mahjong-hub.test.ts` |
| `MahjongActionBar.vue` | 新增；2×2 动作槽 + 多杠选择器 + 换三张/定缺 |
| `MahjongSeatChip.vue` | 四变体；静态金边；名字 18/分数 20/角标 16；delta 拼分数行；无张数 |
| `MahjongRiver.vue` | 四方向 tileDirection 映射；显示上限 24 + +N；claimed 过滤；latestIndex/pulseEpoch；meldLane |
| `MahjongHandBacks.vue` | dealing 动画 |
| `MahjongBoard.vue` | 装配 v2；dealEpoch；claimSource；prevDiscardCounts/lastDiscardIndex；首版 seed；跨局 reset；删 flyingOutIndex 预提交；长按/claim 过滤保留 |
| `ClaimTile.vue` | 红金；删根 pulse；只负责 claim |
| `MahjongHuBanner.vue` | 红金；新座位位置；非动画出队 |
| `MahjongTile.vue` / `MahjongMeld.vue` | 边框/阴影 token（图片不改） |
| `MahjongSettlement.vue` | 主按钮 token；四行 35ms 错峰 |
| `animations.scss` | `ftl-deal-in-radial`、`ftl-deal-in-side`、`ftl-discard-land`、`anim-mj-urgent`；全部 reduced-motion；infinite 只留 claim 呼吸 |
| `uni.scss` | 红金/字体 token |
| `useTableSound.ts` | 发牌/首次 play/摸牌/出牌对齐；补杠 MjGang；跨局 reset |
| `table.vue` | 传 bySlot/phase/actionCount/tingCount；失败 notice 不触发牌河落点；托管取消 |

测试删改：`mahjong-layout.test.ts` 重写七档/锚点/不相交/容量；`mahjong-board.test.ts` `.mj-center→.mj-hub`、发牌语义、claim 单过、多杠、抢杠胡、SBR 两局、重连；`mahjong-seat-chip.test.ts` 四变体/角标/余额；新增 `mahjong-hub.test.ts`、`mahjong-action-bar.test.ts`；`mahjong-river.test.ts` 四方向/上限/claimed；`mahjong-hand-backs.test.ts` dealing；`animations.test.ts` reduced-motion + infinite 计数 + backwards 闸；`audio.test.ts` 麻将用例。

### 8.3 数据来源

| UI | 字段 |
|---|---|
| 牌墙/状态 | wallCount、state |
| 倒计时 | turnDeadlineAt + seconds；claim/exchange/lack 用 rules 窗口 |
| 方位/发光 | activeSeats（exchange/lack）、currentPlayer（play/claim） |
| 徽标 | lackSuits、tingSeats、isOut（不单列）、huInfos、trustees |
| 听牌 | tingTiles（≤9）、maxFanForMe |
| 牌河/副露/亮牌 | discards、melds、revealedHands |
| claimSource | windowId 前缀 + currentPlayer + discards/melds（客户端派生） |
| 座位分数 | balances、pendingScoreChanges（delta 拼分数行） |

## 9. 实施顺序

0. **mockup**：七档（1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334）× 正常态 + 可达最坏态（mid/top29/twoSurvivors/revealed/heavy/fourMelds、9 听、长名字、6 位余额、0s、4 动作）。844×390 只作为 1623×750 缩 0.52 视口。用户确认后改代码。
1. 新增 `mahjongTableLayoutV2` + 测试（复用原型算法）；旧函数保留。
2. Hub + 座位牌 + 四向牌河接 v2；截图确认。
3. 手牌 + ActionBar + 听牌行；截图确认。
4. 动效/音效/震动按 6.2。
5. 七档截图/录屏 + 真机走查 → 部署测试服。

每步一个提交；截图不过不进下一步。

## 10. 测试与验收

### 10.1 矩阵

- 画布：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
- 可达态：normal、mid、top29、twoSurvivors(29/25)、revealed(14)、heavy、fourMelds；9 听；24+N。
- 组件态：长名字、6 位余额、3 角标、4 动作、claim 单过、强制胡无过、多杠、0s、托管取消、换三张、定缺。
- 不测 36 张/家；注释说明 108 张可达 ~29，显示上限 24。

### 10.2 断言

- 所有矩形在画布内；hub×河/背/侧副露/座位牌/手牌/动作区；动作区×手牌/河/自己副露/侧区；座位牌×手牌/顶背/顶副露；选中抬 10×动作区/河/副露/听牌；听牌×河/手牌/动作区/副露；河×侧河/背。
- 动作区×ownRiver 只允许（记录，不报错）；其余相交报错。
- 容量：visible ≤ rows×cols（侧）、≤ cols×2（上/下）；overflow 正确；29→24+5。
- 比例：侧河 56×45.714 与 49/40 误差 ≤1e-9（用 56*40/49）。
- Hub：compact = hubD/s<180；状态行文案表；无分数；听 N。
- 动作区：≤4 槽；pass 唯一且强制胡无过；多杠合并；4 种 mode。
- 动效：发牌仅局首；claim/重连不重放；出牌确认前手牌/选中不变；reduced-motion 无残留；infinite 计数=1（claim）；发牌类 backwards。
- 回归：client 全量、vue-tsc、uni build。

### 10.3 视觉验收

七档截图并排；最坏态逐档；每类事件录屏；真机走查摸牌/出牌/碰杠/胡/结算/托管/重连。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 29 张可达、显示 24+N | 24+N 明确；原型 top29/twoSurvivors 全绿；+N 有位置 |
| 动作浮层覆盖自家河 | 路线 A 允许；原型 7 态未触发；浮层漆面+金边，非行动时隐藏 |
| 满副露 hub compact | 162.4 可用；compact 内容定义；七档截图 |
| 小屏字号/触控 | 按钮 84（0.52 下约 44）；名字 18/分数 20；角标 16；实拍 |
| 动效掉帧/多个 infinite | 一个 infinite；源码闸；reduced-motion |
| 重连/claim 重放 | dealEpoch + 首版 seed + 增长/claimed 判定 |
| 108/136 张差异 | 本片 108；136 另立 spec |

## 12. 回退

分步提交；任一步可整步 revert；测试服 rollback.sh；不触碰协议/服务端。

## 13. 决策表

| 编号 | 决策 |
|---|---|
| D1 | 川麻红金；布局 A；座位牌左上/右上/上中/左下 |
| D2 | 路线 A：动作浮层 + 牌河 24+N |
| D3 | 血战盘动态 160–200；compact <180；盘只放牌墙/倒计时/方位/徽标/状态行 |
| D4 | 上/下 8/12 列×2；侧 rows 3–10、cols 2–6；显示 24 |
| D5 | 手牌 108；动作 2×2 84；净空 16；瞬间重排 |
| D6 | 听牌 2×5（≤9），自家河左侧 |
| D7 | 座位牌 140/144/64；名字 18/分数 20/自己 18；角标 ≤3；无张数；delta 拼分数行 |
| D8 | 发牌：挂载 v>1 seed；首个 v1 exchange/lack 播；MjShuffle 发牌、MjDeal 首次 play |
| D9 | 出牌确认后牌河落点；无幽灵；删预提交飞 |
| D10 | 动效复用；新增 4 类；全部 reduced-motion；发牌 backwards |
| D11 | 音效复用；补杠 MjGang；选牌 MjSort；跨局 reset |
| D12 | 红金 token 新值；天月旧 token 不恢复 |
| D13 | 外框 `::before`/阴影 |
| D14 | 分数只在座位牌；Hub 不显示 |
| D15 | 侧河 56×45.714（49:40） |
| D16 | play 固定环；claim/exchange/lack 比例；urgent 麻将专用有限 |
| D17 | claim 多杠合并；pass 唯一；强制胡无过；抢杠胡高亮副露 |
| D18 | 座位卡静态金边；唯一 infinite = claim 呼吸 |
| D19 | 跨局 reset ended→exchange\|lack；SBR 覆盖 |
| D20 | 108 张容量；显示 24+N；36 不测 |

## 14. 开放问题

无。v3 审查中的几何问题已由路线 A 原型七档 × 7 可达态全绿收口；交互/数据问题已在第 6/8 节定义。若 mockup 超出 ±4 尺寸微调，需回到本文件修订。
