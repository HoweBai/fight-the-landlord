# 牌型播报语音全量接入（含叫地主）设计

- 日期：2026-10-22
- 状态：已实现（2026-10-22）
- 分支：`dev`
- 范围：纯客户端 + 素材转码（不动协议 / 服务端）

## 1. 背景与问题

现有音效只接了 15 条：抢地主 ×3、不叫、过牌 ×3、报单/报双、大小王单张、胜负、两条 BGM。

素材侧实际有 **50 条出牌播报**（`Sound/Fight/Woman_*`），当前只用了大小王单张 2 条，
其余 48 条（单张 13、对子 13、三张 13、具名牌型 9）全部未接。另有两个现存缺口：

1. **叫地主播错音**：协议⑦（2026-09-28）起 `bidPhase.decisions` 带 `kind: 'call' | 'rob'`，
   UI 文案区分「叫地主 / 抢地主」，但 `cueForBid` 只按 `grab` 选音 ⇒ 叫地主时播的是「抢地主」。
   `Woman_Order.mp3` 已在 2026-10-12 被当作零引用删除。
2. **对手过牌无声**：过牌音效只在**自己**的 ack 回调里播；别人的 `recentActions[].cards === null`
   只用于展示。

## 2. 用户裁决（2026-10-22，记为 U5）

| 编号 | 裁决 |
|---|---|
| U5-1 | 播给谁：**所有座位**（自己 / 对手 / 机器人）的出牌与过牌都播 |
| U5-2 | 是否全量：**是**，50 条牌型播报全接 |
| U5-3 | 连续出牌：**新播报打断上一条**（单通道、最新优先） |
| U5-4 | 牌型识别放客户端（用 `@fight-the-landlord/protocol` 的 `parseHand`），不改协议 |

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 新增 `src/audio/play-cues.ts`：`cueForPlay(cards): CueName \| null` | 与 `audio/index.ts` 的播放/持久化职责分开，可独立单测 |
| D2 | 客户端 `parseHand` 选音，只用于「选哪条音效」 | 2026-10-12 出牌提示裁决已允许前端 import `parseHand` / `HandType`；不做合法性 / 胜负 / 倍数判定 |
| D3 | 叫地主按 `kind`：`call`+抢 → `Order`，`rob`+抢 → `Rob{seat+1}`，不抢/不叫 → `NoOrder` | 与 UI 文案同源（`BidDecision.kind`），修掉现存错配 |
| D4 | 过牌统一走 `recentActions` 视图 diff；删除 `table.vue` 的 ack 本地回声 | 所有座位一致；避免自己的过牌响两次 |
| D5 | 单通道打断：`playCue` 起播前**安全处置**当前 cue（§5.2）；BGM 不受影响 | U5-3；BGM 有独立生命周期；不得重演 pending-play AbortError |
| D6 | 同一视图更新内的优先级：出牌/过牌 → 报单/报双 → 胜负（后者压前者） | 通过 watcher 注册顺序实现；警示与胜负比牌型播报重要 |
| D7 | 新增 49 条素材（48 播报 + `Woman_Order`），**64k mono**；牌桌音频预算 640 → 1024 KiB | 源 ogg 仅 65–72kbps，64k 近似透明；预计实测约 927 KiB |
| D8 | 不预热新增 48 条 | 50 个音频上下文同时创建过重；文件随牌桌分包下载 |
| D9 | 不修「胜负音乐与牌桌 BGM 叠加」 | 与本片无关，另立小片 |

## 4. 范围

### 做

- 50 条牌型播报（含已做的王单张）全量映射与接线。
- `Woman_Order` 恢复 + `cueForBid(kind, grab, seat)`。
- 所有座位出牌/过牌播报。
- cue 单通道打断。
- 转码脚本与资产预算同步。

### 不做

- 协议 / 服务端改动。
- BGM 变体（`Normal2` / `Exciting` / `openinganimation`）恢复。
- 加倍 / 分享 / 聊天音效（玩法没有）。
- 发牌 / 翻底牌 / 结算 / 倒计时 / UI 点击音（素材没有）。
- 胜负音乐与 BGM 混音修复（D9）。

## 5. 实现设计

### 5.1 牌型 → cue 映射

`cueForPlay(cards)` 用 `parseHand(cards)` 得到 `{ type, keyRank }`：

| HandType | 条件 | cue 名 | 文件 |
|---|---|---|---|
| Single | `r ∈ 3..14` | `Single{r}` | `Woman_{r}.mp3` |
| Single | `r = 17`（2） | `Single15` | `Woman_15.mp3` |
| Single | `r = 20` / `30` | `SingleLittleJoker` / `SingleBigJoker` | `Woman_100/200.mp3` |
| Pair | `r ∈ 3..14` / `r = 17` | `Pair{r}` / `Pair15` | `Woman_dui{r}.mp3` |
| Trio | `r ∈ 3..14` / `r = 17` | `Trio{r}` / `Trio15` | `Woman_tuple{r}.mp3` |
| Straight | — | `Straight` | `Woman_shunzi.mp3` |
| PairStraight | — | `PairStraight` | `Woman_liandui.mp3` |
| Plane / PlaneWithSingles / PlaneWithPairs | — | `Plane` | `Woman_feiji.mp3` |
| TrioWithSingle / TrioWithPair | — | `TrioWithSingle` / `TrioWithPair` | `Woman_sandaiyi / sandaiyidui.mp3` |
| FourWithTwo / FourWithTwoPairs | — | `FourWithTwo` / `FourWithTwoPairs` | `Woman_sidaier / sidailiangdui.mp3` |
| Bomb / Rocket | — | `Bomb` / `Rocket` | `Woman_zhadan / wangzha.mp3` |
| Invalid / 空牌 / 解析异常 | — | `null`（静默） | — |

`keyRank` 的 17 = 2、20 = 小王、30 = 大王（DouZero 编码）。对子/三张不可能出现王，故只需 3..15 档。

### 5.2 播放层（`audio/index.ts`）

**核心约束（阻断项 1）**：cue 也必须在 `onCanplay` 之后才调 `play()`。否则同一 flush 内
「A 起播 → B 打断 A」时，A 的 `play()` 必然尚未 settle，`stop()` 内部的 `pause()` 会以
`AbortError` 拒掉被 uni 丢弃的 promise ⇒ 真浏览器探针的零容忍断言变红。

数据结构：

```ts
interface LiveCue { ctx: AudioCtx; playCalled: boolean; started: boolean; abandoned: boolean }
const cues = new Set<LiveCue>();      // 所有 cue（不含 BGM）
let currentCue: LiveCue | null = null;
```

- `playCue(name)`：静音 / 音效关闭 / 未知 cue 时直接返回（**不**打断当前 cue）；
  否则先 `disposeCue(currentCue)`，再建新上下文。
- 新 cue：设 `src` / `volume`；
  - `onCanplay`：`abandoned` ⇒ 清理；否则 `playCalled = true` 后 `playSafely(ctx)`；
  - `onPlay`：`started = true`；若 `abandoned` ⇒ 立即清理；
  - `onEnded` / `onError` ⇒ 清理。
- `disposeCue(c)` 的安全规则：
  - `started`（onPlay 已触发）⇒ `stop + destroy` 安全；
  - `!playCalled`（play 从未调用）⇒ 直接 `destroy` 安全；
  - `playCalled && !started`（play 已调用、尚未 onPlay）⇒ **只置 `abandoned = true`**，
    不 `stop` / 不 `destroy`（由 onPlay 或 onError 收尾）。
  - 以上均从 `cues` / `live` / `currentCue` 中移除；abandoned 的 ctx 只保留在宿主的
    回调闭包里，**不留在 `cues`**（否则宿主永不回调时会永久强引用）。
- 残余窗口（如实登记）：`playCalled && !started` 的毫秒级窗口内无法安全打断，已用
  `abandoned` 保证「一旦 onPlay 立即停」，但不声称已消除。
- 新增 `stopCues()`：停掉册子上所有 cue（跳过 `currentBgm?.ctx`）；供页面 `onUnmounted` 调用。
  abandoned 的 cue 已不在册子上（见上），由迟到的 onPlay / onError 自行收尾。
- `stopAll()`（总静音）改用同一套安全处置；`stopBgm` 语义不变。
- `setSfxOn(false)` 不强行打断已在播的 cue（沿用现状）。
- `cueForBid(kind: 'call' | 'rob', grab: boolean, seat: number)`。
- `cueForPass(seat)` 不变。
- 新增 `__resetAudioForTest()`：清 `cues` / `currentCue` / `preheated`（测试隔离）。

### 5.3 视图 diff（`useTableSound.ts`）

- **bootstrap 游标**（高优先级 2）：挂载后**第一版快照只登记、不播**。以 `store.view`
  是否已存在初始化 `bootstrapped`；注册在**所有动作 watcher 之前**的 watcher 在首版视图到达时
  把 `lastActionsKey` 与 `playedDecisions` 对齐到当前值。这样「挂载时 `view=null`，随后
  `game.deal` / 重连快照带来历史窗口」不会补播；正常进房路径（首版为空）行为不变。
- **动作 watcher**（一个，替代旧「大小王单张」特判）：观察 `recentActions` 的字符串指纹
  （seat + 牌面，窗口 = 2）：
  - `store.settlement` 已存在 ⇒ 直接返回（**结算锁**，高优先级 3）；
  - 指纹与 `lastActionsKey` 相同 ⇒ 返回（幂等）；否则更新 `lastActionsKey`；
  - 最新一条 `cards === null` ⇒ `cueForPass(seat)`；
  - 否则 `cueForPlay(cards)`，非 null 则 `playCue`。
- watcher 刻意**不** `immediate`：挂载 / 重连不补播历史。
- watcher 注册顺序：**bootstrap → 出牌/过牌 → 报单/报双 → 胜负 → 叫抢**。同一 flush 内
  后注册者最后执行，从而「报单/报双」压过牌型播报、「胜负」压过两者（D6）。
  ⚠️ 该顺序只在**同一 setup、默认 pre flush** 下成立；不得跨消息依赖。
- 叫抢 watcher：`playedDecisions` 初值在 bootstrap 时对齐；改传 `d.kind`；结算锁同样适用。

### 5.4 页面（`table.vue`）

- `send()` 删除 `cue` 参数与其注释；`pass()` 不再传回调。
- `PREHEAT_CUES` 增加 `Order`；其余不变（D8）。
- `onUnmounted` 同时调用 `stopBgm()` 与 `stopCues()`（低优先级 13：离桌后 1–2 秒的
  牌型播报不得响进大厅）。

### 5.5 素材与预算

- `scripts/transcode-audio.mjs`：
  - `AUDIO_SRC` 环境变量指定源根（**必填**；本仓 `resources/` 被 gitignore，通常用
    `AUDIO_SRC='D:/Code/pokergame/resources'`）；
  - 产物按归属直接写入 `<client>/src/pages/table/static/audio`（牌桌 63 条）与
    `<client>/src/static/audio`（大厅 Welcome 1 条）；
  - 清单只保留实际发货的 64 条（不再生成已删除的 5 条储备）；
  - 新增播报与 `Woman_Order` 用 64k，其余沿用既有码率（既有文件 skip）；
  - **孤儿检查**：转码后对每个输出目录做 `readdirSync` 精确比对，目录里出现清单外的
    `.mp3` 即报错（防止旧脚本/旧文件残留）；
  - 按目录分别校验预算（1024 / 320 KiB）。
- **实测口径**（2026-10-22，`ffprobe`）：49 条新语音总时长 **38.40 s**，64k mono
  ≈ **307 KiB**；牌桌音频预计 **≈ 814 KiB**（预算 1024）。牌桌分包合计约 **1.72 MB**
  （cards 437 + av 136 + ui 329 + audio 814），低于微信 2 MB，余量约 330 KB。
- `test/asset-budget.test.ts`：`table/audio` 640 → 1024，注释按实测更新。
- **资产存在性判据**（高优先级 7）：
  - 用 `readdirSync` 得到的**精确字符串 Set** 比对（Windows 下 `existsSync` 大小写不敏感，
    不得使用）；
  - 双向：`CUES` 每条 URL（先剥 `?v=`）→ 文件存在；牌桌音频目录 → 每个 `.mp3` 都在 `CUES`；
    主包音频目录仍只有 `MusicEx_Welcome.mp3`；
  - 文件必须 `size > 0`。

## 6. 测试判据

| 判据 | 形式 |
|---|---|
| 50 条映射逐条正确 | `play-cues.test.ts` 表驱动：每个 HandType/点数 → 期望 cue 名与文件 |
| 王单张并入通用映射 | 单张 20/30 → `Woman_100/200` |
| 空牌 / `Invalid` / 未映射 keyRank（15/16/18/19）/ `parseHand` 抛错 ⇒ `null` 且不抛 | 单元测试 |
| 叫地主 | `cueForBid('call', true, 1)` → `Woman_Order`；`cueForBid('rob', …)` → `Rob{seat+1}`；不抢/不叫 → `NoOrder` |
| 打断（已 started） | A 起播（派发 canplay + onPlay）后播 B：A `stop+destroy ≥ 1`，B 在播 |
| 打断（A 仅 playCalled 未 started） | A 标 abandoned、不 stop；派发 A.onPlay ⇒ A 停；B 不受影响 |
| 旧 cue 迟到回调不清新 cue | A/B 连播后派发 A.ended / A.error，再播 C ⇒ 停的是 B（需 uni-stub 增加 `endedHandler`） |
| 自然结束 | 派发 ended 后再 `playCue` 不 stop 已完成的 ctx |
| 静音/音效关不打断 | `setSfxOn(false)` 后 `playCue` 不停止已在播的 cue；`setMuted(true)` 安全停全部 |
| BGM 不受打断影响 | `playBgm` + 连续两次 `playCue` ⇒ BGM ctx `stop === 0` |
| 所有座位出牌/过牌 | 视图 diff：seat 0/1/2 的出牌与过牌都触发正确 src |
| 自己的过牌只响一次 | 点过牌按钮 → ack 0 → 推入自己的 pass 视图 ⇒ 恰好一次 `Woman_buyao{seat}`（防 ack 回声残留） |
| 挂载/重连不补播 | 挂载时无视图，随后应用带历史 `recentActions` / `decisions` 的快照 ⇒ 0 次 play；首版为空再出牌仍正常播 |
| 同 update 优先级 | 出牌导致剩 1/2 张 ⇒ 最后在播的是 `Baojing1/2`，且牌型 cue 的 ctx `stop ≥ 1`；结算同 update ⇒ `Win/Lose` |
| 结算锁 | `store.settlement` 已存在时，后续 `recentActions` 变化不再播牌型/过牌 |
| 资产存在性与预算 | `table/audio ≤ 1024 KiB`；`CUES` ↔ 目录**双向**精确比对（大小写敏感）；主包只有 Welcome |

## 7. 错误处理与边界

- 音频层继续遵守「绝不抛、绝不 `console.error`」；`play()` 的拒绝必须吞掉。
- `parseHand` 只读 `recentActions` 的公开牌面；空数组 / `Invalid` / 未映射 keyRank / 异常
  一律返回 `null`（外层 `try/catch`），绝不抛。
- **bootstrap**：挂载后第一版快照只登记不播；正常进房路径行为不变。
- **结算锁**：`store.settlement` 存在时不再播牌型 / 过牌 / 叫抢。
- 一次视图更新跳过多手动作（版本跳跃）时只播最新一手；登记为已知边界。
- **打断残余窗口**：`playCalled && !started` 的毫秒级窗口内只能标 `abandoned`；若宿主
  既不触发 `onPlay` 也不触发 `onError`，宿主侧上下文无法回收（模块已不再强引用它）。
  另：`onPlay` 事件与 `play()` promise 结算之间仍有极短窗口，需真浏览器探针复核。
  登记，不声称消除。
- 「不抢」无专用素材，沿用 `Woman_NoOrder`（说的是「不叫」）；登记。
- 飞机带单/带对共用 `Woman_feiji`；四带二 / 四带两对各有素材。
- 文件名大小写以磁盘为准（`Woman_feiji` 全小写），资产判据必须大小写敏感。
- cue 起播等待 `onCanplay` 会带来首播延迟；预热名单覆盖高频短音，新增 48 条不预热（D8）。

## 8. 风险

| 风险 | 处置 |
|---|---|
| `parseHand` 用于选音被指违反「哑终端」 | 只在客户端做「牌面 → 音效」纯选择；不判合法/胜负；不新增本地规则实现；记录为 U5-4 新裁决，并同步 `design.md` §12.4 与 `source-boundary.test.ts` 头注释 |
| 同 flush 多条 cue 的优先级依赖 watcher 顺序 | Vue 3.5 同 setup 的 pre watcher 按入队顺序稳定执行；用测试锁死；顺序写在代码注释；不跨消息依赖 |
| 打断时 pending-play AbortError（阻断项） | cue 一律 `onCanplay` 后再 `play`；只对 `started` 或从未 `play` 的 cue 做 stop/destroy；真浏览器探针加「连续两条播报」场景 |
| cue 首播延迟 | 高频短音预热；新增 48 条不预热；真机走查确认可接受 |
| abandoned cue 残留 | 离桌 `stopCues()` / 静音 `stopAll()` 兜底；登记为残余窗口 |
| 微信 2 MB 分包上限 | 已实测：49 条 38.4s / 64k ≈ 307 KiB，牌桌分包合计约 1.72 MB；实施后跑一次 mp-weixin 构建复核 |
| 预算超限 | 实测 ≈ 814 KiB < 1024；若超标，先降现有 12 条语音到 64k，仍超再降 BGM |
| 打断导致长语音被截断 | U5-3 已裁决；播报均为 1–2 秒短句 |
| 机器人连续动作造成语音密集 | 打断策略保证不叠音；只播最新一手 |
| 资产大小写 / 孤儿文件 | 资产判据用 `readdirSync` 精确 Set；转码脚本做孤儿检查 |

## 9. 涉及文件

- 新增：`apps/client/src/audio/play-cues.ts`、`apps/client/test/play-cues.test.ts`、本 spec
- 修改：`apps/client/src/audio/cues.ts`、`apps/client/src/audio/index.ts`、
  `apps/client/src/composables/useTableSound.ts`、`apps/client/src/pages/table/table.vue`、
  `apps/client/src/static/ASSETS.md`（§3 预算表、§5 清单与「不做」段）、
  `apps/client/test/audio.test.ts`、`apps/client/test/asset-budget.test.ts`、
  `apps/client/test/helpers/uni-stub.ts`（增加 `endedHandler` / `playHandler`）、
  `apps/client/test/source-boundary.test.ts`（头注释补 U5-4）、
  `docs/design.md`（§12.4 放行措辞）、`scripts/transcode-audio.mjs`
- 新增素材：`apps/client/src/pages/table/static/audio/` 下 49 个 mp3
- 命名纪律：`play-cues.ts` 内不得出现 `isPair` / `isTriple` / `isBomb` / `isRocket` /
  `isStraight` 等 `source-boundary` 禁词（用 `HandType` 分支 + `cueFor*` 命名）。

## 10. 审查记录

独立 reviewer（2026-10-22）结论：**1 阻断 / 8 高 / 7 低**。处置：

| # | 级别 | 结论 | 处置 |
|---|---|---|---|
| 1 | 阻断 | 打断会在 `play()` 未 settle 时 `stop()`，触发 AbortError | 已修订 §5.2：cue 也等 `onCanplay`；`started`/`playCalled`/`abandoned` 三态；§6 增判据 |
| 2 | 高 | 「重连不补播」不成立（挂载后快照带历史） | 已修订 §5.3：bootstrap 游标；§6 增判据 |
| 3 | 高 | 优先级只覆盖同一 flush，结算可能被后续牌型打断 | 已修订 §5.3：结算锁；§6 增判据 |
| 4 | 高 | 既有 `audio.test.ts` 断言与 D3 冲突 | 列入计划任务：逐条迁移（Order 进表、kind 用例、签名） |
| 5 | 高 | `uni-stub` 不记录 `onEnded`，迟到回调竞态不可测 | 列入 §9：扩展 `endedHandler`；§6 增判据 |
| 6 | 高 | 删除 ack 回声后缺「自己的过牌只响一次」判据 | 已加入 §6 |
| 7 | 高 | 资产判据大小写 / 孤儿文件 | 已修订 §5.5：`readdirSync` 精确 Set、双向、脚本孤儿检查 |
| 8 | 高 | `design.md` §12.4 仍限定「出牌提示」 | 已加入 §9；计划任务同步 |
| 9 | 高 | 未评估微信 2 MB / 预算估算偏差 | 已实测（38.4s / 307 KiB / 分包 ≈1.72MB）并写入 §5.5 / §8 |
| 10 | 低 | 模块级状态跨用例泄漏 | §5.2 增 `__resetAudioForTest()`；计划调用 |
| 11 | 低 | 优先级判据未证明前一条被 stop | §6 已补断言 |
| 12 | 低 | 「BGM 不受影响」无判据 | §6 已补 |
| 13 | 低 | 离桌后 cue 可能继续响 | §5.4 增 `stopCues()` |
| 14 | 低 | 未映射 keyRank 的默认分支 | §6/§7 已补 |
| 15 | 低 | `ASSETS.md` 具体改动点未列 | §9 已列 |
| 16 | 低 | 新文件命名可能撞禁词 | §9 已列命名纪律 |

### 代码审查（2026-10-22）

独立 reviewer 审 `4c599fcf..HEAD`：**无 Critical / 2 Important / 8 Minor**。处置：

1. **Important**：abandoned cue 再次 `onCanplay` 会 `destroy()`（内部 pause pending play）
   ⇒ 改为直接 `return`，只等 `onPlay` / `onError`；补「abandoned 后再 canplay 不得 stop」用例。
2. **Important**：`stopCues` 对 abandoned cue 只重复置标记，永久持有 ctx ⇒ `disposeCue`
   将其从 `cues` 摘除，由回调收尾；补「stopCues 不 stop abandoned；迟到 onPlay 仍收尾」用例。
3. Minor 已处置：50 条 cue 名 → 具体文件映射判据、`parseHand` 抛错 / 未映射 rank 用例、
   总静音与离桌 `stopCues` 接线用例；`PREHEAT_CUES` 注释、实测体积注释、`AUDIO_SRC` 必填、
   转码脚本分段注释同步。
4. 残余风险：`onPlay` 与 `play()` promise 结算之间仍有极短窗口，需真浏览器探针复核
   （本片未跑真栈，已在 §7/§8 登记）。
