# 跑得快语音播报复用 · 实现计划

> 依据：`docs/superpowers/specs/2026-10-25-pdk-voice-announcements-design.md`。
> 分支：`dev`。每任务一 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 纯客户端 + `GAME_META` 能力位；不加素材、不加配置键、不动服务端/协议消息。
- 语音沿用现有音效开关/静音（`playCue` 门控）；不新增独立语音开关。
- 牌型选择只用于选音；合法性/胜负/倍数仍由服务端判定。
- **测试 fixture 约束（可执行）**：跑得快牌堆只有 48 张（去掉大小王、黑桃 2/梅花 2/方块 2、
  黑桃 A）。`parsePdkHand` 只校验形状、不校验牌堆，因此测试须自律：
  - 重复点数只用 3–13；A 用 `s ∈ {1,2,3}`；2 只用 `{r:17,s:1}`；
  - 炸弹固定用 7；`Pair15/Trio15` 标注「合成牌（牌堆不可达）」并显式豁免。
- 精确断言 cue 文件（不用模糊 `includes('buyao')`）；区分 cue 时按 `audioContexts` 的 `src`。
- 每任务只改本任务文件；提交前跑受影响包 test + lint。
- 不 push master、不部署；推 `dev` 前 fetch/merge `origin/dev` 并重跑全量。

## T1 音频映射：pdk-play-cues

**Files**：`apps/client/src/audio/play-cues.ts`（导出 rank helper）；
新增 `apps/client/src/audio/pdk-play-cues.ts`；新增 `apps/client/test/pdk-play-cues.test.ts`。

1. 测试先行（fixture 守 Global Constraints）：
   - 单/对/三张 3..13 / A（`s=1`）→ `Single/Pair/Trio{r}`；2（`{17,1}`）→ `*15`（合成牌豁免）；
   - 三带一/三带二、顺子、**2 对连对**、裸飞机/带翅膀、四带二、炸弹（7）；
   - **规则开关分支**：`bareTrioEnabled=false`（3 同点 ⇒ null）、`trioWithPairEnabled=false`、
     `bareAirplaneEnabled=false`、`fourWithTwoEnabled=false`、
     `fourWithTwoPairKickerAllowed=true`（对子带牌 ⇒ `FourWithTwo`）、
     `airplaneWings='singles'/'both'`（带单翅 ⇒ `Plane`）；
   - 空牌/非法/`rules=null`/`undefined` ⇒ `null`；解析抛错不抛；
   - **无王映射**：`r=20/30`（大小王）⇒ `null`（12 是 Q，合法单张，不得当王）。
2. 红。
3. 实现：
   - `play-cues.ts` 导出 `cueForSingleRank/cueForPairRank/cueForTrioRank`，
     **签名 `CueName | null`**，返回处 `?? null`；`cueForPlay` 改调它们（行为不变）；
   - `pdk-play-cues.ts`：`cueForPdkPlay(cards, rules: PdkRulesConfig | null | undefined)`，
     `if (!rules) return null`，`try { parsePdkHand(cards, rules) } catch { return null }`，
     按 §4 映射；绝不抛。
4. 绿：`pnpm -C apps/client test pdk-play-cues play-cues` + `pnpm -C apps/client run lint`。
5. Commit：`feat(client): 跑得快牌型语音映射`。

## T2 接线：useTableSound

**Files**：`apps/client/src/composables/useTableSound.ts`；
`apps/client/test/pdk-sound.test.ts`。

1. 测试先行（改写现有用例；文件头注释与用例名同步）：
   - 单张 6 ⇒ 精确 `Woman_6.mp3`（原 `:86` 的 `toEqual([])` 翻红）；
     `:97`/`:112` 的 `toContain` 一并改精确；
   - 对子/连对/炸弹 ⇒ 精确对应文件；
   - 过牌 ⇒ 精确 `Woman_buyao{1,2,3}.mp3`；**4 人 seat 3**：断言
     `store.view.playerCount===4`、最新 action seat===3、文件精确 `Woman_buyao1.mp3`
     （不能与 seat 0 混淆）；同用例加 seat 1 ⇒ `Woman_buyao2.mp3` 对照；
   - 报单（2→1）/报双（3→2）在跑得快也播，并断言震动
     `uniStub.calls.vibrateLong===1` / `vibrateShort===1`；
   - **bootstrap 不补播**：`store.view===null` 时 mount，记 `before=audioContexts.length`，
     再投第一版快照（`cardCounts` 含 1/2 张 + 一条 recentActions）⇒
     `srcs().slice(before)` 为空，且断言快照真进了 store；随后另一座位 3→2/2→1 ⇒
     精确 `Woman_baojing2/1.mp3`；
   - 同一 flush 同时改 `recentActions` 与 `cardCounts` 时按序两条 cue（actions 先、counts 后打断）；
     若只想测报单，保持 recentActions 不变只动计数；
   - 结算后不再播牌型/过牌。
2. 红。
3. 实现：
   - 跑得快出牌分支改 `cueForPdkPlay(newest.cards, rules)`（rules 假值静默）；
   - `cardCounts` watcher 删除跑得快豁免，只保留 `store.settlement` 锁；
   - **删除未用导入** `PdkHandType`、`parsePdkHand`（`noUnusedLocals`），保留
     `isPdkSettlementResult`；
   - 头注释同步（`cueForPlay`/`cueForPdkPlay` 分别服务两种玩法）。
4. 绿：`pnpm -C apps/client test pdk-sound audio` + lint。
5. Commit：`feat(client): 跑得快接通牌型/报单语音`。

## T3 能力位（独立 commit）

**Files**：`packages/protocol/src/game.ts`、`game.test.ts`。

1. 测试先行：`game.test.ts` 断言 pdk `voiceAnnouncements === true`。红。
2. 实现：能力位改 true。
3. 绿：`pnpm -C packages/protocol test && pnpm -C packages/protocol run lint`。
4. Commit：`feat(protocol): 跑得快语音能力位`。

## T4 文档与注释

**Files**：`docs/games/paodekuai.md`；
`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md`
（`:96`/`:276`/`:1046` 就地取代注记）；
`docs/superpowers/plans/2026-10-23-multi-game-platform-paodekuai.md`（`:696`）；
`apps/client/src/audio/index.ts`（`cueForPass` 注释）、`apps/client/src/audio/cues.ts`
（头注释改成两个选择器：ddz `cueForPlay` / pdk `cueForPdkPlay`）。

1. `docs/games/paodekuai.md` 补「语音播报复用斗地主牌型语音（不含王/叫抢）」。
2. 旧多玩法 spec/plan 的冲突处**就地**加「已被 2026-10-25 语音 spec 取代」。
3. `cueForPass` 注释补 4 人 seat 3 回退；`cues.ts` 头注释同步。
4. 验证：`pnpm -C apps/client run lint`；`pnpm verify:admin`（无键变化）。
5. Commit：`docs: 跑得快语音文档与注释`。

## T5 全量与收口

1. `pnpm exec turbo run test lint --force`（0 cached）、`pnpm verify:admin`、
   `pnpm -C apps/client run lint`。
2. 独立代码审查（sonnet，`BASE..HEAD`），Critical/Important 修复后重跑。
3. fetch/merge `origin/dev` → 重跑 → push `dev`。
4. 交付报告：变更、证据、提交范围、已知边界（4 人 seat 3 复用 Buyao1、首次出牌按需下载、
   报单/报双带震动、Docker 真栈仍缺）。

## 回归命令

```bash
pnpm -C apps/client test pdk-play-cues play-cues pdk-sound audio
pnpm -C apps/client run lint
pnpm -C packages/protocol test
pnpm -C packages/protocol run lint
pnpm exec turbo run test lint --force
pnpm verify:admin
```

## 计划审查记录（2026-10-25，独立 reviewer）

结论：**阻断 0 / 高 2 / 低 10**，全部处置。

| 级别 | 发现 | 处置 |
|---|---|---|
| 高 | 「无王映射 12/20/30」把 Q 当王 | T1：改为 20/30；12 是合法单张 |
| 高 | bootstrap 零 cue 用例按现有写法恒绿 | T2：`view===null` 时 mount + `before` 切片 + 首版含 1/2 张 |
| 低 | 切换后 `PdkHandType/parsePdkHand` 未用导入 | T2 明确删除 |
| 低 | 48 张 fixture 约束不可执行 | Global Constraints：3–13/A 花色/2 唯一/炸弹 7/合成牌豁免 |
| 低 | seat 3 断言与 seat 0 不可区分 | T2：断言 playerCount/最新 seat + seat 1 对照 |
| 低 | 只有 `:86` 翻红，`:97/:112` 仍模糊 | T2 点名改精确；注释/用例名同步 |
| 低 | rules null 只按 null 判不稳 | T1：假值 + try/catch |
| 低 | 旧文档冲突点未逐处标注 | T4：`:96/:276/:1046` 与 plan `:696` 就地注记 |
| 低 | `pnpm ... test && lint` 命令不合法 | 回归命令已写全 |
| 低 | 震动未断言 | T2 加 `vibrateLong/Short` |
| 低 | T1 漏规则开关分支 | T1 补裸三/四带二/对子带牌/翅膀形态 |
| 低 | `cues.ts` 头注释半真 | T4 补 |

## 执行记录（2026-10-25）

- T1–T4 完成：`0a63de8c`(映射) → `eec583af`(接线) → `809fa7c7`(能力位) →
  `24a8b47b`(文档)。
- 全量：`pnpm exec turbo run test lint --force` ⇒ **44/44 tasks，0 cached**；
  `pnpm verify:admin` ⇒ **377 checks passed**。
- 代码审查结论待补。
