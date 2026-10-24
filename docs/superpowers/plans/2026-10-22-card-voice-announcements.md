# 牌型播报语音全量接入 — 实现计划

- 依据：`docs/superpowers/specs/2026-10-22-card-voice-announcements-design.md`（含审查记录）
- 分支：`dev`；每个任务一个 commit
- 回归：`pnpm -C apps/client test`、`pnpm -C apps/client run lint`

## Global Constraints

- 不动协议 / 服务端；`parseHand` / `HandType` 只从 `@fight-the-landlord/protocol` 导入。
- 音频层绝不抛、绝不 `console.error`；`play()` 的拒绝吞掉。
- cue 必须 `onCanplay` 后再 `play()`；打断遵守 `started` / `playCalled` / `abandoned` 三态。
- `source-boundary` 禁词：不得在客户端**定义** `parseHand` / `canBeat` / `HandType`，不得出现
  `isPair` / `isTriple` / `isBomb` / `isRocket` / `isStraight` 等标识符。
- 提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个任务先红后绿；不夹带无关重构。

---

## Task 1：cue 表 + 牌型映射（纯逻辑）

**Files**
- `apps/client/src/audio/cues.ts`（+48 条；`Order` 留到 Task 3）
- 新增 `apps/client/src/audio/play-cues.ts`
- 新增 `apps/client/test/play-cues.test.ts`

**Interfaces**
```ts
// play-cues.ts
import { HandType, parseHand, type Card } from '@fight-the-landlord/protocol';
import type { CueName } from './cues';
export function cueForPlay(cards: Card[]): CueName | null;
```
映射：单张 3..14 → `Single{r}`；17 → `Single15`；20/30 → `SingleLittleJoker/SingleBigJoker`；
对子 3..14/17 → `Pair{r}/Pair15`；三张同理 → `Trio*`；9 种具名 → `Straight/PairStraight/
Plane/TrioWithSingle/TrioWithPair/FourWithTwo/FourWithTwoPairs/Bomb/Rocket`。
`Invalid` / 空牌 / 未映射 keyRank / 任何异常 → `null`。外层 `try/catch`。
点数映射用 `Record<number, CueName>` 查表（不要用模板字符串，它的类型是 `string`）。

**TDD**
1. 写 `play-cues.test.ts`：表驱动覆盖 50 条 + 空牌 + `Invalid` + 未映射 rank + `parseHand` 抛错；
   另加一条「映射覆盖全部 50 个播报 cue 名」的集合断言。
2. `pnpm -C apps/client exec vitest run test/play-cues.test.ts` ⇒ 红（模块不存在）。
3. 在 `cues.ts` 增加 48 条静态条目（命名 `Single3..15`、`Pair3..15`、`Trio3..15`、9 个具名）。
   注意 `cues.ts` 顶部「50 条不做」的注释同步改写。**`Order` 不进表**（Task 3 加）。
4. 实现 `play-cues.ts`（`switch (parsed.type)` + rank 映射；不得用禁词命名）。
5. 同命令 ⇒ 绿；`pnpm -C apps/client test` 确认既有用例仍绿。
6. 提交：`feat(client): 牌型播报 cue 表与 parseHand 映射`。

**说明**：Task 1–3 期间这 48 条 cue 尚无生产调用点（中间态），由 Task 4 接线；
Task 1 的「覆盖 50 个 cue 名」断言保证最终无死条目。`Order` 不在此列。

**注意**：`HandType.Plane*` 三种共用一个 cue；`FourWithTwo*` 两种各一个；
直接返回 cue 名，不在这里调 `playCue`（便于单测）。

---

## Task 2：素材转码（48 条播报）+ 资产判据

**Files**
- `scripts/transcode-audio.mjs`
- `apps/client/test/asset-budget.test.ts`
- `apps/client/test/audio.test.ts`（资产存在性判据，若放这里）
- 新增 48 个 mp3（`src/pages/table/static/audio/`）

**步骤**
1. 先写资产判据（红）：
   - `asset-budget.test.ts`：`table/audio` 640 → 1024；注释写实测。
   - 新增双向判据：`CUES` 每条 URL（剥 `?v=`）→ 文件存在且 `size > 0`；牌桌音频目录
     每个 `.mp3` 都在 `CUES`；主包音频目录仍只有 `MusicEx_Welcome.mp3`。
     实现用 `readdirSync` 的 **精确字符串 Set**（不得用 `existsSync` 判大小写）。
   - 运行：`pnpm -C apps/client exec vitest run test/asset-budget.test.ts test/audio.test.ts` ⇒ 红。
2. 改 `transcode-audio.mjs`：
   - `const SRC = process.env.AUDIO_SRC`，**必填**（缺省报错并给 Windows 写法示例）；
   - `TRACKS` 条目带目标目录：牌桌 62 条 / 主包 1 条（`Order` 留到 Task 3，避免与 CUES 脱节）；
   - 新增 48 条播报用 `64k`，其余沿用（96k / 64k）；
   - 转码后对每个输出目录做**孤儿检查**（清单外 `.mp3` 报错退出）；
   - 分目录预算：table 1024 KiB、main 320 KiB；更新头注释（双目录，不再手工搬）。
3. 运行：
   `AUDIO_SRC='D:/Code/pokergame/resources' node scripts/transcode-audio.mjs`
   确认输出：`转码 48 条 / 跳过 15 条`，table ≈ 814 KiB。
4. 再跑第 1 步命令 ⇒ 绿；`ls` 确认 62 个牌桌 mp3 + 1 个主包 mp3。
5. 提交：`feat(client): 补齐 48 条牌型播报素材并收紧转码脚本`。

**注意**：脚本幂等（skip-if-exists）；不改已有 15 条音频的码率。

---

## Task 3：播放层（canplay 起播 / 安全打断 / 叫地主）

**Files**
- `apps/client/src/audio/index.ts`
- `apps/client/src/audio/cues.ts`（+`Order`）
- `apps/client/src/composables/useTableSound.ts`（**只改调用点签名**，watcher 重写在 Task 4）
- `apps/client/test/helpers/uni-stub.ts`（`endedHandler` / `playHandler`）
- `apps/client/test/audio.test.ts`（迁移 + 新增）
- `scripts/transcode-audio.mjs`（TRACKS + `Order`）+ 新增 `Woman_Order.mp3`

**Interfaces**
```ts
interface LiveCue { ctx: AudioCtx; playCalled: boolean; started: boolean; abandoned: boolean }
export function playCue(name: CueName): void;
export function stopCues(): void;
export function cueForBid(kind: 'call' | 'rob', grab: boolean, seat: number): void;
export function __resetAudioForTest(): void;
```
规则：
- `playCue` 的静音 / 音效关闭 / 未知 cue 早退**不打断**当前 cue。
- 起播：`onCanplay` →（`abandoned` ? 清理 : `playCalled = true; playSafely`）；
  `onPlay` → `started = true`，若 `abandoned` 立即清理；`onEnded/onError` → 清理。
- `disposeCue`：`started` 或 `!playCalled` → `stop+destroy`；`playCalled && !started` → 只标
  `abandoned`。**abandoned 的 ctx 从 `cues` / `live` / `currentCue` 全部摘除**，
  只由迟到的 `onPlay` / `onError` 收尾（不留在 `cues`，避免永久强引用）。
- `stopAll()` 用同一安全处置。
- `cueForBid`：`kind='call' && grab` → `Order`；`kind='rob' && grab` → `Rob{seat+1}`；
  `!grab` → `NoOrder`；seat 越界回落第一条。
- `__resetAudioForTest()`：清 `cues` / `currentCue` / `preheated`（不清开关与音量），
  **加入 `audio.test.ts` 的 `beforeEach`**（替换 `__resetPreheatedForTest` 的单独调用）。

**TDD（先写/改测试，再实现）**
1. `uni-stub.ts`：替身记录 `endedHandler`、`errorHandler`、`playHandler`（默认不触发）。
2. `audio.test.ts`：
   - 迁移所有「playCue 后立即断言 play 次数」的用例：手动派发 `canplayHandler`（再派发
     `playHandler` 模拟 onPlay）。`beforeEach` 调 `__resetAudioForTest()`。
   - 删除「`Woman_Order` 不得进表」旧断言，改为「Order 进表且 `cueForBid('call', true, 1)`
     播 `Woman_Order`」；保留一条 `kind:'rob'` → `Rob{seat+1}` 用例。
   - **接线期望迁移**：`audio.test.ts:483-507、532-547、600-633` 的 decisions 是
     `kind:'call', grab:true` ⇒ 期望从 `Rob1/Rob2` 改为 `Woman_Order`；另留 `kind:'rob'` 正例。
   - 新增：打断已 started；打断 playCalled 未 started（abandoned）；迟到 ended/error 不清新
     cue；自然结束；BGM 不受打断；`stopCues`；`__resetAudioForTest`。
3. 更新 `useTableSound.ts` 的调用点为 `cueForBid(d.kind, d.grab, d.seat)`（否则 vue-tsc 红）。
4. 在 `transcode-audio.mjs` 的 TRACKS 增加 `Woman_Order`（64k），运行脚本补转 1 条。
5. 运行 `pnpm -C apps/client exec vitest run test/audio.test.ts` ⇒ 红；实现 `index.ts` / `cues.ts`；绿。
6. 提交：`feat(client): 播报音效按 canplay 起播并安全打断，补叫地主`。

**迁移清单**（既有断言）：`audio.test.ts` 的 play 次数、`cueForBid(true, seat)` 签名、
「死条目」断言、decisions 的 call 期望、preheat 相关若受 `currentCue` 影响。

---

## Task 4：视图 diff（所有座位 / bootstrap / 结算锁 / 优先级）

**Files**
- `apps/client/src/composables/useTableSound.ts`
- `apps/client/test/audio.test.ts`（接线用例）

**实现**
- setup 顶部初始化：`lastActionsKey = 当前指纹`、`playedDecisions = 当前长度`、
  `lastCounts = 当前 cardCounts`、`bootstrapped = store.view !== null`。
- 第一个 watcher（bootstrap）：`watch(() => store.view, v => { if (v && !bootstrapped) {
  bootstrapped = true; lastActionsKey = 当前指纹; playedDecisions = 当前 decisions 长度;
  lastCounts = [...store.cardCounts]; } })`。**必须同时对齐 `lastCounts`**，否则重连快照
  带 `cardCounts` 1/2 张时会误播报单/报双。
- 动作 watcher（替换旧王单张 watcher）：指纹比较 → 结算锁 → 最新动作：
  `cards === null ? cueForPass(seat) : cueForPlay(cards)` 后 `playCue`。
- 报单/报双 watcher 移到动作 watcher **之后**，并加结算锁；胜负 watcher 之后；叫抢 watcher 最后。
- 叫抢 watcher：带结算锁、传 `d.kind`。
- 删除常量 `DOUZERO_LITTLE_JOKER/BIG_JOKER`（已并入 `play-cues`）。

**TDD**
1. 新增/迁移用例：
   - **迁移** `audio.test.ts:406-447`「单张王后过牌不再响」：新行为是「pass 替换上一条王单张
     播报」，断言 `Woman_buyao3`（旧断言会红，是预期）。
   - seat 0/1/2 出牌与过牌都触发正确 src（出牌夹具用王单张，旧实现也会播 ⇒ 有判别力）。
   - 挂载时 `view=null`，随后 push 带历史窗口（含王单张 + `cardCounts=[17,1,2]`）的快照
     ⇒ 0 次 play；再 push 新动作 ⇒ 播。
   - `store.settlement` 存在时 `recentActions` 变化 ⇒ 0 次；**新局 `settlement` 清空后恢复播报**。
   - 出牌使某座位剩 1/2 张 ⇒ 最后在播 `Baojing1/2`，且牌型 cue 的 ctx 已创建、`stop ≥ 1`。
   - 结算与出牌同 update ⇒ `Win/Lose` 最后，且牌型 cue 的 ctx `stop ≥ 1`。
2. 运行 `pnpm -C apps/client exec vitest run test/audio.test.ts` ⇒ 红（旧实现只播王单张，
   且无 bootstrap / 结算锁）。
3. 实现；绿。
4. 提交：`feat(client): 所有座位出牌/过牌播报，重连不补播、结算不再播牌型`。

---

## Task 5：页面接线

**Files**
- `apps/client/src/pages/table/table.vue`
- `apps/client/test/audio.test.ts`（自己的过牌只响一次）

**步骤**
1. 写用例（红）：点过牌按钮 → ack 0 → 推入自己的 pass 视图 ⇒ 恰好一次 `Woman_buyao{seat}`。
2. `send()` 删除 `cue` 参数与注释；`pass()` 改为 `void send("game.pass", {})`。
3. **删除 `table.vue:85` 的 `cueForPass` import 与 :266-267 的旧注释**（`noUnusedLocals`
   会让 vue-tsc 红）。
4. `PREHEAT_CUES` 增加 `Order`；`onUnmounted` 增加 `stopCues()`。
5. 运行用例 ⇒ 绿；提交：`feat(client): 过牌音效统一走视图 diff，离桌停播报`。

---

## Task 6：文档同步

**Files**
- `apps/client/src/static/ASSETS.md`：§3 预算表（14→63、640→1024）、§5 清单与
  「明确不做 → 牌型播报」行、R698 计数段。
- `docs/design.md` §12.4：放行措辞改为「出牌提示 / 音效选择（U5-4）」。
- `apps/client/test/source-boundary.test.ts` 头注释同步。
- spec 状态改为「已实现」。

**验证**：`pnpm -C apps/client run lint`；提交 `docs: 同步牌型播报的资产与边界说明`。

---

## 最终验证

```bash
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm -C apps/client run build        # vue-tsc + H5 产物（确认 63 条音效进 dist）
git status --short
```

- 真浏览器：环境可用时跑 `node scripts/browser-e2e.mjs`，重点看「连续两条播报」无
  `Runtime.exceptionThrown` / error 级 console（阻断项 1 的残余窗口）。
- 小程序端按 R701 **排除**在一切门禁之外，不跑 `build:mp-weixin`；资产预算由
  `asset-budget.test.ts` 兜底。
- **开工前已存在的未提交改动**（`apps/client/src/net/rest.ts`、`pages/history/history.vue`）
  不属于本片：逐文件 `git add` 本片文件，不纳入提交；最终 `git status` 仍会显示它们，
  在交付报告里说明。
- 记录测试数量与结果；确认 49 个新文件已入库。
- 不推送远端（用户未要求）；报告提交 SHA 与验证证据。

## 计划审查记录

独立 reviewer（2026-10-22）结论：**2 阻断 / 8 高 / 5 低**。处置：

| # | 级别 | 结论 | 处置 |
|---|---|---|---|
| 1 | 阻断 | Task 2 转 `Order` 但 Task 3 才入 CUES，资产反向判据恒红 | Task 2 只转 48 条；`Order` 随 Task 3 入表并补转 |
| 2 | 阻断 | Task 3 改 `cueForBid` 签名但调用点 Task 4 才改，vue-tsc 红 | Task 3 同步改 `useTableSound` 调用点传 `d.kind` |
| 3 | 高 | 迁移清单漏 decisions 的 call 期望 | 已列入 Task 3 迁移清单（call → Order，留 rob 正例） |
| 4 | 高 | 漏迁移「单张王后过牌不再响」 | 已列入 Task 4：改为 pass 替换，断言 buyao3 |
| 5 | 高 | `readonly Card[]` 与 `parseHand(Card[])` 不兼容、模板字符串非 CueName | 已改为 `Card[]` + `Record<number, CueName>` + 补 import |
| 6 | 高 | Task 4 用例可能假绿 | 夹具改用王单张 / 历史窗口；优先级断言 ctx 已创建且 stop≥1 |
| 7 | 高 | bootstrap 未对齐 `lastCounts`，重连会误报报单 | 已加入 bootstrap 对齐 + `[17,1,2]` 用例；报单 watcher 加结算锁 |
| 8 | 高 | 删 `send` cue 参数后 `cueForPass` import 未使用 | 已加入 Task 5 步骤 3 |
| 9 | 高 | 缺真浏览器 / 构建复核；小程序口径 | 最终验证加 H5 build + 真浏览器；小程序按 R701 排除 |
| 10 | 高 | Task 1–3 期间 48 条 cue 是死条目 | 已登记中间态；Task 1 增「覆盖 50 个 cue 名」集合断言 |
| 11 | 低 | `AUDIO_SRC` 默认值在本 checkout 不存在、Windows 路径 | 改为必填 + Windows 写法示例；更新头注释 |
| 12 | 低 | 工作区已有未提交改动 | 已加入最终验证说明：逐文件 add、不纳入 |
| 13 | 低 | `__resetAudioForTest` 未进 beforeEach | 已加入 Task 3 |
| 14 | 低 | abandoned 的 ctx 是否留在 `cues` 与 spec 冲突 | 代码审查后改为：从 `cues`/`live`/`currentCue` 全部摘除，回调收尾 |
| 15 | 低 | 结算锁无「新局解除」用例 | 已加入 Task 4 |

