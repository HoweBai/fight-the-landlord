# 麻将牌桌「川麻红金」重做设计 spec v7

日期：2026-11-05
状态：已被 v8 取代（`2026-11-06-mahjong-table-redgold-design-v8.md`）；本文件保留 v7 复审前版本。
取代：`2026-11-05-mahjong-table-redgold-design-v6.md`
继承：v6 + v5 + v4；**未列部分按 v6/v5/v4 执行**。
几何证据：`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs`（v7 原型；七档 × 12 态 **ALL GREEN**）。

## 0. v7 修订（v6 复审 3 Critical + 关键 Important）

| v6 问题 | v7 处理 |
|---|---|
| C1 `marginTop:-4s` 与旋转后 DOM 宽高交换互斥，组高不是 101.2/133.6 | **恢复旧实现 `53b5da01`**：`MahjongTile.rotate` 强制 `my/` 正立素材、DOM 宽高交换；`MahjongMeld.vertical` 用 `margin-top: 1px` 补偿；侧副露视觉 34×51@0.65（22.1×33.15），组高 78.6/101.4，4 组 429.6，不再自造 29.7×36.4 盒 |
| C2 统一 +90° 会让右家牌面倒 180° | 旧实现 left=−90 / right=+90，且强制 `my/` 素材；不按边用 left/right 素材 |
| C3 `animationend` 比较未哈希 `'ftl-hu-banner'`，scoped CSS 实际是 `ftl-hu-banner-<hash>`，handler 恒假 | 守卫改 `startsWith('ftl-hu-banner')`（meld 的 peng/gang/angang 同理）；测试用带哈希名的真实 `animationend`，禁止 `$emit('done')`；补编译后名称前缀断言 |
| 手牌 dealEpoch seed 哨兵未定义 | `dealEpoch` 初始 `null`；v>1 seed 时 entry.dealNonce 取永不匹配哨兵；测试 v1 exchange/lack、v5 mount、remount |
| 头像尺寸来源未定义；selfChip 64 会带偏左右家 | 对手/对家 56、自己 44；Board 不得复用 selfChip.width/barChip.w；160=56+10+94；self 三行 gap 0/line-height ≤1.15 |
| claimSourceIndex 绝对索引与窗口不兼容 | claim 直接用 `latestIndex` 高亮；rob 用 `claimSourceMeldKey`；不再传绝对 index |
| meld key 共用 helper 无落点；sound 解析器会错 | 新增 `src/game/mahjong-keys.ts` 导出 `meldKey(seat,m)` 与结构化解析；Board/useTableSound 共用 |
| infinite 闸漏 SeatChip 的 CSS `animation: ... infinite` | 闸同时扫模板 `anim-*` 与 `<style>` 的 `animation:` 行；白名单只放 `anim-claim-pulse`；合成违例测试 |
| v2 改 token 会打红旧测试 | v2 使用独立 `tokensV2`/参数；旧 `mahjongTableLayout` 与旧测试冻结，加“旧锚点不改”断言 |
| revealed 只按边生效未测；右侧复用左 pitch | 原型加 `oneSideRevealed`/`threeRevealed`；Board 右侧用 `rightBacks.pitch`；补左独亮测试 |
| SeatChip 4 相位表/徽标行丢 | §4 复述 v6/v5 4 相位表；fan/张数徽标行删除（角标化）；补每相位 chip 测试 |
| River 缺 badgeCount/meld.width | River props 增 `badgeCount`、`meld.width`；DOM style 断言 |
| MjDeal lack→play 跃迁会漏 | 改“本局首次观察到 play” latch；三测 |
| jsdom 不能验可见牌面高度 | 组件测试改机械断言（rotate 时元素 w/h=36.4×29.7 + rotate class）；可见面放真浏览器截图 |
| reduced-motion 队列推进无测试 | 补“一条非 hu view 更新后第二条文本出现”+“settleRevealed 清队”两条独立断言 |
| 侧副露组距/sideMeldGap 4 vs 8 | 明确侧副露组距 8s；更新 tokens/test |
| 数字/注释陈旧 | 原型头改 v7；侧副露数字按旧视觉尺寸；§5 表更新 |

## 1. 侧副露：恢复旧 rotate/vertical 实现

- 从 `53b5da01` 恢复：
  - `MahjongTile.rotate?: 'left' | 'right'`；rotate 模式**强制 `my/` 正立素材**；DOM 宽高交换（竖→横），`transform: rotate(±90deg)`；left=−90、right=+90。
  - `MahjongMeld.vertical?: boolean`；vertical 时清水平 overlap，`margin-top: 1px`（rotate 后视觉比 DOM 多 17px 的补偿）；cap 定位跟随 vertical。
- 侧副露尺寸：旧 `sm` rotate 档 DOM 51×34，视觉 34×51；`sideMeldScale=0.65` → 视觉 22.1×33.15；组内叠压 16×0.65=10.4；组高：碰 3 张 = 78.6；杠 4 张 = 101.4；4 组 + 3×8 = 429.6。
- 侧 lane 宽 = 34×0.65 + 4 = 26.1；位于侧河内侧。
- 4 组 429.6 < 750 mid 可用 447.2，**不需动态缩 scale**；保留 0.4 下限仅作极端防御。
- 暗杠牌背：back.png 83×125，与面图比例不同；暗杠背用 `scaleToFill`/cover 填满视觉盒，或专用侧背盒；测试断言 4 张暗杠可见尺寸。
- 组件测试：vertical 时 margin-top 1px、组高 78.6/101.4、4 组 429.6；left/right class 分别为 −90/+90；rotate 时元素 w/h=36.4×29.7 + rotate class（jsdom 机械断言）；可见面放真浏览器截图。

## 2. 胡 banner / 副露 pop 的 animationend

- 根因：Vue scoped CSS 把 `@keyframes` 重命名为 `ftl-hu-banner-<scope>`；`e.animationName === 'ftl-hu-banner'` 恒假。
- 修法：`MahjongHuBanner` 守卫改 `String(e.animationName).startsWith('ftl-hu-banner')`；`MahjongMeld` 的 peng/gang/angang 同理 `startsWith('ftl-peng-pop')` 等。
- `bannerSeq` key 保留（强制新节点）。
- reduced-motion：`prefersReducedMotion()` 公共 helper；无动画时下一版 view 展示下一条；`settlementRevealed` 清空整队。
- 测试：用 `animationName: 'ftl-hu-banner-abc123'` 的真实 `animationend` 驱动 handler，禁止 `$emit('done')`；双胡正常/reduced；meld pop 真实动画名；补一条“编译 CSS keyframes 前缀”断言。

## 3. 几何收口（v6 基础上）

- topMeldW = min(max(河宽,内容宽), topBacksW)；top29 468→453.4；4 杠 451.75。
- revealed：只左右河区；`raw=revealed`；sideTop+16s；top 走 HandBacks、self 走手牌；oneSideRevealed/threeRevealed 进矩阵。
- 24+N：上/下 23+badgeCount（29→6）；侧 24+badgeCount（29→5）；输出 badgeRect/windowStart/latestIndex；`visible+(badge?1:0) ≤ rows×cols`；24 格侧河退化 23+徽标。
- 座位牌：对手/对家头像 56、自己 44；对手 160×56（文本 94）、对家 164×56（98）、自己 64×76；名字 18/分数 18/delta 14；自己 16/10 第三行，gap 0/line-height ≤1.15；角标右上 1 字/左下 2 字，最多 2；无 fan/张数徽标行。
- Hub：compact 32/18/12（≤8 字）、normal 40/22/14（≤10 字）；状态行 y +50/+55；fit 纳入标签/听 N/徽标/方位点；方位点锚点明确（盘缘内 r−6，不穿金环）。
- 动作浮层：overlayWorst 1334×1000 覆盖 70.7×125.6（旧视觉尺寸后为 **62.3×125.6**）；路线 A 接受；浮层 0.86 + 金边；非行动隐藏。
- 侧副露组距 8s；lane 26.1；侧区宽更新；原型七档×12态 ALL GREEN。

## 4. 交互/组件收口

- 手牌 `dealEpoch` 初始 null；v>1 seed 时 entry.dealNonce 取永不匹配哨兵；发牌类只认匹配且 `!drawn`；摸牌/牌背尾部 null；测试 v1 exchange/lack、v5 mount、remount。
- 头像尺寸：对手/对家 56、自己 44；Board 从 layout 输出的 `avatar` 取，不复用 selfChip.width/barChip.w；160=56+10+94；self 三行 fit。
- claimSource：claim 用 `latestIndex`（窗口相对）；rob 用 `claimSourceMeldKey`；River 增 `claimSourceMeldKey`、Meld `highlight`；Board 只接受同 type 点击；rob 无弃牌点击。
- meld key：新增 `src/game/mahjong-keys.ts`；`meldKey(seat,m)=${seat}:${kind}:${首张type}`；结构化解析；Board/useTableSound 共用；音频测试同座碰→补杠 MjGang、直杠 MjGuafeng。
- SeatChip：`activeLevel: 'strong'|'line'|null` + `winner?`；4 相位：play currentPlayer strong/others null；claim 我 strong/弃牌者 line/其他 null；exchange/lack 我（未提交）strong/其他 null；ended winner；静态；无张数/fan 徽标行。
- MjDeal：本局首次观察到 play 的 latch（重挂重置）；lack→play、mount-at-play、exchange→play 三测。
- 无限闸：扫模板 `anim-*` + `<style>` 的 `animation:` 行；白名单 `anim-claim-pulse`；合成违例测试；删 `anim-lack-pulse` 使用与死类 `anim-active-glow`。
- River：props 增 `badgeCount`、`meld.width`；DOM style 断言。
- 房间：顶栏左返回 + `roomCode` + 场次/底分；测试。
- ActionBar：claim 由 MahjongActionBar 渲染；ClaimTile 删除或只留 tile 预览；测试改 action-bar。
- v2 独立 tokens：`tokensV2`/参数；旧函数/旧测试冻结；旧锚点不改断言；v2 七档锚点另写。
- backwards 闸只扫发牌/手牌类；豁免 meld-pop/banner/settlement。
- 组件清单补：MahjongSeatChip（states/头像）、MahjongMeld（vertical）、MahjongTile（rotate）、MahjongHandBacks（dealNonce/pitch）、MahjongRiver（badgeCount/meld.width/claimSourceMeldKey）、MahjongActionBar、mahjong-layout.ts（v2）、mahjong-keys.ts、useTableSound、table.vue。

## 5. 原型结果（七档 × 12 态 ALL GREEN）

| 画布/态 | hub | 侧河 | top | actions | centerW | 备注 |
|---|---|---|---|---|---|---|
| 1334×750 normal | 200 | 10r/2c | 8c | 993.7,438 | 1005.3 | — |
| 1334×750 mid | 162.4c | 9r/2c | 8c | 963.6,438 | 945.1 | 侧副露 78.6 |
| 1334×750 top29 | 200 | 9r/3c cap27 | 12c+5/6 | 993.7,438 | 947.3 | 徽标 6 |
| 1334×750 twoSurvivors | 200 | 9r/3c cap27 | 8c | 935.7,438 | 851.6 | 24+5/1 |
| 1334×750 fourMelds | 200 | 9r/2c | 8c | 993.7,438 | 975.2 | 4 碰 338.6 |
| 1334×750 gangHeavy | 162.4c | 9r/2c | 8c | 963.6,438 | 945.1 | 4 杠 429.6 |
| 1334×750 revealed29 | 200 | 9r/2c | 8c | 993.7,438 | 1005.3 | 14 亮无 +N |
| 1334×750 overlayWorst | 200 | 10r/3c | 8c | 905.6,438 | 829.1 | — |
| 1334×1000 overlayWorst | 220.3 | 10r/3c | 8c | 862.5,656.3 | 778.7 | 覆盖 62.3×125.6 |

七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334。
十二态：normal、mid、top29、twoSurvivors、revealed、heavy、fourMelds、selfFourGang、gangHeavy、overlay、overlayWorst、revealed29。

## 6. 测试矩阵

- 画布七档；状态十二态 + oneSideRevealed/threeRevealed；组件态：长名字、6 位余额+delta、2 角标、4 动作、claim 单过、强制胡、多杠、0s、托管取消、换三张、定缺、29→23+6、侧 24+5、revealed 无 +N、双胡（正常/reduced）。
- animationend：真实哈希名驱动 hu/meld；禁止 `$emit('done')`。
- 发牌：v1 exchange/lack 播、v5 mount 不播、remount 摸牌只新牌动；MjDeal latch 三测。
- 无限闸：模板 + style 双扫；合成违例。
- 旧 v1 layout 测试锚点不改；v2 七档锚点另写。
- 回归：client 全量、vue-tsc、uni build。

## 7. 决策表追加

| 编号 | 决策 |
|---|---|
| D59 | 恢复 `53b5da01` 的 rotate/vertical；my/ 素材、left −90/right +90、margin-top 1px |
| D60 | 侧副露视觉 34×51@0.65；组高 78.6/101.4；4 组 429.6；lane 26.1 |
| D61 | 暗杠背 cover 填满视觉盒 |
| D62 | animationend 用 startsWith；测试真实哈希名 |
| D63 | dealEpoch 初始 null；seed 哨兵 |
| D64 | 头像：对手/对家 56、自己 44；Board 从 layout 取 |
| D65 | claim 用 latestIndex；rob 用 claimSourceMeldKey |
| D66 | 共享 mahjong-keys.ts |
| D67 | 无限闸扫 style animation |
| D68 | v2 独立 tokens；旧函数/测试冻结 |
| D69 | revealed 按边；oneSideRevealed/threeRevealed |
| D70 | SeatChip 4 相位；无 fan/张数行 |
| D71 | River badgeCount/meld.width |
| D72 | MjDeal latch |
| D73 | jsdom 只做机械断言；可见面真浏览器 |

## 8. 开放问题与已知边界

无开放设计问题。已知边界：

1. 服务端一炮多响删多张同型弃牌；客户端全量重算。
2. 动作浮层最坏覆盖 62.3×125.6（1334×1000），必然含最新弃牌；路线 A 接受。
3. Hub compact 162.4 状态行 ≤8 字；超长昵称省略。
4. 108 张单家弃牌 ~29；显示 24（上/下 23+徽标）。
5. 136 张玩法不在本片。
6. 侧副露旧 sm 尺寸在小屏 0.52 缩放下约 17.8×26.5 物理 px；mockup 需展示。
