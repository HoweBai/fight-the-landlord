# 参考项目 UI 拆解（`reference/` 下两个开源斗地主）—— 供后续「素材接入片」直接取用

> **日期**：2026-09-18 · **用途**：`reference/` 是**只读参考**（未跟踪、**必须**加入 `.gitignore`，见下）。
> 本文是两份只读调研的**耐久版**（原始报告只存在于当时的会话上下文里）。**含许可结论与可搬清单**，动手前先读本文。

## 0. 素材许可与入库纪律（先读）

| 来源 | 许可 | 结论 |
|---|---|---|
| `reference/dsh-doudizhu` | **MIT**（`LICENSE:1-3`，Copyright 2025 AwesomeHou） | 代码/CSS/数值/结构**可搬**（保留版权声明）；其 `assets/deepseek-{blue,black}.svg` 是**品牌图**（自身文档写「用户提供」）⇒ **商标不在 MIT 内**，别当默认头像/牌背 |
| `reference/CardGame` | **仓库无 LICENSE/COPYING/NOTICE**（`find` 空）；`README.md` 的「许可证」段正文只有 `*待定*` | 原始状态 = 保留所有权利。**用户 2026-09-18 声明已另行取得全套素材授权** ⇒ 本仓可用（见裁决 R688）；仍须在 `static/ASSETS.md` 留溯源与授权范围 |

⚠️ 两条要点（记录事实，不重复劝阻）：① `Assets/Resources/Fonts/ice.ttf` 上游是**字魂（ZiHun）商业字体**，字体 name 表逐字含 `Commercial use requires purchase authorization`，其 TMP SDF 资产（9MB）不可用；② `UI/hlddz.*.png`/`huanledou.png`/`dou.png`/prefab 文案「欢迎来到欢乐斗地主」等**指向某线上斗地主**。两者都在用户声明的授权范围内。

**入库纪律**：`reference/` 现在是 `?? reference/`（**未跟踪也未忽略**）⇒ 必须加进 `.gitignore`；只把**需要的素材按清单**拷进 `apps/client/src/static/`。

## 1. `dsh-doudizhu`：零位图、纯 DOM+CSS+Unicode 的「工程师纸牌」

**素材实况**：`assets/{cards,ui,avatars,sound}` **只有 0 字节 `.gitkeep`**；全仓唯一矢量是两份 DeepSeek 品牌 SVG（`brandAssets.ts` 内联为 Data URI，只用于默认头像与未揭示牌背）。**54 张牌面没有任何图片。**

### 一张牌的结构（`App.tsx:366-413`）
- `div.ddz-card[.red][.sel][.ddz-card-big|.ddz-card-mini]`
  - `span.ddz-card-corner.top` → `span.ddz-card-rank[.long]` + `span.ddz-card-suit`
  - `span.ddz-card-corner.bottom` → `span.ddz-card-suit`（`.mini` 档不渲染）
- **普通牌没有中央元素**（`.ddz-card{font-size:20px}` 落在空元素上是死声明）；**王**走另一分支：`ddz-joker-main` 内 `'JOKER'.split('')` 5 个 `ddz-joker-letter` 竖排。

### 尺寸/几何/叠放（px，直接可换成 rpx）
| 档 | 宽×高 | 圆角 | 角标点数 | 角标花色 | 偏移 | `.long` |
|---|---|---|---|---|---|---|
| normal | 44×64 | 7 | 18 | 13 | 5px | 15px |
| big（自己手牌） | 56×80 | 9 | 22 | 16 | 6px | 17px |
| mini（明牌小牌） | 26×38 | 5 | 10 | 8 | 3px | 8px |
| ≤720px | 38×56 / 46×66 / 22×32 | — | — | — | 5px | — |

- 牌体：白底 + `border:1px solid #d9dde5` + `box-shadow:0 1px 3px rgba(26,32,47,.12)` + `font-weight:700` + `letter-spacing:-.04em` + `line-height:.88`（角标）。
- 叠放 = `gap:0` + `第二张起 margin-left`：手牌 **−32px**（`:165`，**死规则**）、折叠牌区 **−24px**（`:269`，**实际生效**，因两条特异度相同且源码顺序靠后）、迷你 **−13px**；配套 `flex:0 0 auto` + `position:relative` + `flex-wrap:nowrap`。
- 选中 = `translateY(-14px)`（big `-18px`）+ `box-shadow:0 0 0 2px blue, 0 5px 10px glow` + `z-index`；reduced-motion 降到 `-8px`。
- 牌桌：中段 `grid-template-columns: minmax(280px,1fr) minmax(140px,.6fr) minmax(280px,1fr)`；角落安全区 `.ddz-table-reserved-bar{height:44px;visibility:hidden}`；自己区 `order` 定序（出牌区 1 / 按钮栏 2 / 手牌 3）。
- **座位方向**（`App.tsx:683-689`）：`nextSeat=(mySeat+1)%3 → 右`、`prevSeat=(mySeat+2)%3 → 左`，DOM 序 左→中→右 = 上家→中央→下家。

### 动效清单（统一 `cubic-bezier(.22,1,.36,1)`、`animation-fill-mode:both` + 内联 `--ddz-delay` 错峰）
| 动效 | 值 |
|---|---|
| 发牌落入 | `ddz-deal-in .36s`（`translateY(-18px) rotate(-3deg) scale(.92)`→none）；错峰 `min(i,12)*35ms` |
| 出牌入场 | `ddz-played-in .24s`；错峰 `i*35ms` |
| 发牌后整理 | `ddz-arrange-in .4s`（挂 class，700ms 后摘） |
| 底牌揭示 | 每张 `.46s rotateY(90deg)`（`perspective:600px`）+ 容器 `.42s` |
| 气泡 | `ddz-toast-in .22s`；**自动消失用分段 keyframes** `ddz-toast-life 2.6s`（0%→8% 入、82% 停留、100% 淡出）——**零 JS 定时器** |
| 持久行动文本 | `.ddz-play-area-action`（绝对居中 22px 主色；「过/不抢」次级灰 18px）+ `.3s` 入场 |
| 倒计时 | `.ddz-countdown` 金色胶囊 `tabular-nums`；`≤3s` 红底 + `pulse .8s infinite` |
| 行动中座位 | `.is-turn{border-color:glow; animation:ddz-turn-pulse 1.8s infinite}` |
| 结算弹窗 | 遮罩 `.2s` + 卡片 `.24s`（`translateY(10px) scale(.985)`） |
| reduced-motion | `:361` 整段：`transition:none` + 一长串 `animation:none!important` |

### 行动叙事的状态机（`App.tsx:555-625`）
四条清空规则：①业务阶段切换清全部；②出牌期轮到某座位清该座位；③首次落牌清叫牌遗留；④新局清全部。同座同文案 **800ms** 去重。「过」清空该座位已出牌使其独占出牌框。
⚠️ 它的**推断逻辑**（`action-feedback.ts:52-93`）依赖 `callActor/robActor/doublingActor/callMultiplier/callerSeat` —— **我方协议无这些字段**，只能借「输出侧（持久文本 + 清空时机）」。

### 测试判据形态（可直接照搬）
纯函数测试、零 DOM 断言：**阶段不变式**（发牌/抢地主期必不出现地主标与底牌）· **阶段跃迁后才出现**（进 playing 才 `bottom.length===3`）· **偏序不变式**（`for(i>0) expect(hand[i-1].r >= hand[i].r)` —— 断言排序但不断言具体排列）· **反例断言**（刚重新领出不算过）。

### 不可搬
`--dsw-alias-*` 宿主变量映射与 `body[data-ds-dark-theme]`；侧栏入口/独立工作区/画中画 + `ResizeObserver`；`z-index:2147483000+`；以及它后端字段驱动的整套（明牌、加倍/超级加倍、抽水、Token/段位、桌别、签到、机器人垫桌、延迟探测）。

## 2. `CardGame`：Unity 2022.3 + NGO，22MB 素材

**素材清单（实测）**：`Assets/Resources` = **17M / 184 文件**（Fonts 11M·UI 2.2M·Sound 1.3M·MusicEx 1.3M·Poker 796K·Prefab 684K·Identity 116K·Config 52K·Anim 36K）；全仓 PNG **80 张 2.78MB**、OGG **78 个 2.14MB**、TTF 2 个。
- **扑克牌面**：`Poker/` = **55 个独立 PNG**（54 面 + `CardBack.png`），**非图集**；54 张面全部 **80×104 px**（比例 1.30），牌背 **66×88**（1.33，**与面不一致**）；命名 `{Spade,Heart,Club,Square}{One..Ten,Jack,Queen,King}` + `BigJoker/LittleJoker`。
- 头像：`Identity/Farmer.png` 206×256、`Identity/Landlord.png` 198×272（**prefab 零引用**）。
- 背景/皮肤：`UI/bg.png` 960×640、`UI/new_BJ.png` 1224×720、按钮 `btn1/2/3.png`（≈245×82）、面板 9-slice 小图 `panel-{orange,blue}.png` 126×126。
- 音频：`Sound/Fight/` 66 条中文女声牌型播报 `Woman_*.ogg`（1.1M）+ `Sound/Chat/` 7 条（**代码零引用=死资源**）+ `MusicEx/` 5 条（BGM/胜负/开场）。
- 字体：`ice.ttf` 2.0MB（字魂商业字体）+ `ice SDF.asset` 9.0MB（Unity 专用静态图集）。
- 唯一策划表 `Assets/Resources/GameConfig.xlsx`（AudioConfig/DeckConfig/CardGameRule 三 sheet）——对 UI 布局零信息量。
- `demo.mp4` 是 **133 字节 LFS 指针**（真文件 86MB）；本机**未装 git-lfs** ⇒ 想看观感需 `git lfs install && git lfs pull`（**不需要 Unity**）。

### 可借的 5 条（信息结构层，与素材无关）
1. **座位卡字段优先级 = 头像 + 名字 + 剩余张数，且张数字号（62.95）> 名字（50.65）** —— 张数是牌桌第一信息（**我方现在是反的**：名字 `$ftl-font-md` 28rpx > 张数 `$ftl-font-sm` 26rpx）。
2. **报单/报双预警**：剩 1 张播 `Woman_baojing1`、剩 2 张播 `Woman_baojing2`（`SoundService.PlayHandCountReport`）—— 我方 `cardCounts` 现成，**零协议改动可做**。
3. **底牌「先背后翻」的时序**（`LoadCards.cs:59-63` 收到确认才 `ShowLordCards()`）—— 时序本身就是信息设计。
4. **牌型→反馈的映射表维度**（单/对/三按点数分档 + 炸弹/王炸/顺子/连对/飞机/三带一/三带对/四带二/四带两对 + 报单报双 + 叫/不叫 + 过牌）—— 照搬「哪些时刻值得给反馈」的清单。⚠️ 它靠**客户端判牌型**，我方要做得先要服务端下发**展示文案**。
5. **数值可借**：选中上抬 **80px / 0.25s**（收回 0.1667s）；**对手手牌 = `scale 0.47` + `±45°` 斜置牌背长条**（Enemy1/2.prefab）；出牌区高 157、手牌中线在中线下 330、按钮条在中线下 130、底部信息条高 85.6（1920×1080 逻辑像素）。

### 它的坑（别抄）
主/次按钮**无视觉区分**（全靠 `SetActive`）· disabled 配色定义了从不使用 · **完全没有倒计时** · 没有 hint / 没有错误气泡 / **出牌无飞牌动效**（原地消失出现）· 倍数与欢乐豆是**纯静态摆设**（脚本零引用）· 没有地主标（`isLandlord` 字段从未读写）。

## 3. 我方已实测的对照（2026-09-18，动手前先看这几条）

| 项 | 我方现状 | 参考 |
|---|---|---|
| 牌宽高比 | `$ftl-card-w:56rpx × $ftl-card-h:96rpx` = **0.583**（small 48×76 = 0.632） | 真牌 0.71；dsh 0.69–0.70；CardGame 1.30（=0.77 高宽比） |
| 座位卡权重 | 名字 28rpx **>** 张数 26rpx（反了） | 张数 **>** 名字 |
| 手牌叠放 | `margin-left:-$ftl-space-6`（净露 32rpx / 48rpx = 67%） | dsh 手牌净露 57%、出牌区 45% |
| 倒计时 | 有（`useCountdown` + 进度条） | dsh 有（胶囊 + 紧迫态）；CardGame 完全没有 |
| 动效 | 几乎为零（唯一 `transition` 是 Card 0.08s） | dsh 一整套 150–400ms |
| 行动叙事 | 只有 ack 后存活≈一个往返的本地气泡 | dsh 出牌区**持久文本** + 4 条清空规则 |
| 花色 | **协议 rank-only，无花色**（`codec.ts:53-57` 值域只有 3–14/17/20/30） | 两者都有花色；**用户已裁决改协议下发花色**（见后续计划） |

## 4. 体积与端策略（实测）
- `dist/build/mp-weixin` = **660K**、`h5` = 464K、`app` = 1.2M（素材接入前）。
- `Poker` 796K + `Identity` 116K 可进小程序主包（660K→≈1.46MB，上限 2MB）；**Sound+MusicEx 2.6MB 进不了**主包（需分包/CDN）。
- **用户 2026-09-18 裁决**：**只做 H5 与 App**（H5 = 迭代与门禁面，App = 主要目标）；**小程序保留代码、撤出门禁**，后续开发/测试不涉及；OGG→mp3、`@font-face` 等 mp 议题**不再处理**。
