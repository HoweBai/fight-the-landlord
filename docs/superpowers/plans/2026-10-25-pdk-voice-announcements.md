# 跑得快语音播报复用 · 实现计划

> 依据：`docs/superpowers/specs/2026-10-25-pdk-voice-announcements-design.md`。
> 分支：`dev`。每任务一 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 纯客户端 + `GAME_META` 能力位；不加素材、不加配置键、不动服务端/协议消息。
- 语音沿用现有音效开关/静音（`playCue` 门控）；不新增独立语音开关。
- 牌型选择只用于选音；合法性/胜负/倍数仍由服务端判定。
- 测试 fixture 遵守跑得快 48 张牌：只有一张 2、无四张 A；`Pair15/Trio15` 只做防御性断言。
- 精确断言 cue 文件（不用模糊 `includes('buyao')`）。
- 每任务只改本任务文件；提交前跑受影响包 test + lint。
- 不 push master、不部署；推 `dev` 前 fetch/merge `origin/dev` 并重跑全量。

## T1 音频映射：pdk-play-cues

**Files**：`apps/client/src/audio/play-cues.ts`（导出 rank helper）；
新增 `apps/client/src/audio/pdk-play-cues.ts`；新增 `apps/client/test/pdk-play-cues.test.ts`。

1. 测试先行：
   - 单/对/三张 3..14 → `Single/Pair/Trio{r}`；2（r=17）→ `*15`（防御性）；
   - 三带一/三带二、顺子、**2 对连对**（`ConsecutivePairs`）、裸飞机/带翅膀、四带二、
     炸弹；
   - 关闭的牌型（`trioWithPairEnabled=false`、`bareAirplaneEnabled=false`、
     `fourWithTwoPairKickerAllowed=false` 的对子带牌）⇒ `null`；
   - 空牌/非法/`rules=null` ⇒ `null`；解析抛错不抛；
   - 无王映射（12/20/30 不进 PDK 牌型）。
2. 红。
3. 实现：
   - `play-cues.ts` 导出 `cueForSingleRank/cueForPairRank/cueForTrioRank`，
     **签名 `CueName | null`**，`cueForPlay` 改调它们（行为不变）；
   - `pdk-play-cues.ts`：`cueForPdkPlay(cards, rules: PdkRulesConfig | null)`，
     `parsePdkHand` + §4 映射，`rules=null`/异常 ⇒ `null`。
4. 绿：`pnpm -C apps/client test pdk-play-cues play-cues` + `pnpm -C apps/client run lint`。
5. Commit：`feat(client): 跑得快牌型语音映射`。

## T2 接线：useTableSound

**Files**：`apps/client/src/composables/useTableSound.ts`；
`apps/client/test/pdk-sound.test.ts`。

1. 测试先行（改写现有用例）：
   - 单张 6 ⇒ 精确 `Woman_6.mp3`（原 `toEqual([])` 翻红）；
   - 对子/连对/炸弹 ⇒ 精确对应文件；
   - 过牌 ⇒ `Woman_buyao*`；4 人 seat 3 ⇒ 精确 `Woman_buyao1.mp3`；
   - 报单（2→1）/报双（3→2）在跑得快也播；
   - 首版快照已含 1/2 张 ⇒ 零 cue；随后真实跃迁 ⇒ 播；
   - 结算后不再播牌型/过牌。
2. 红。
3. 实现：
   - 跑得快出牌分支改 `cueForPdkPlay(newest.cards, rules)`（rules null 静默）；
   - `cardCounts` watcher 删除跑得快豁免，只保留 `store.settlement` 锁；
   - 头注释同步（`cueForPlay`/`cueForPdkPlay` 分别服务两种玩法）。
4. 绿：`pnpm -C apps/client test pdk-sound audio` + lint。
5. Commit：`feat(client): 跑得快接通牌型/报单语音`。

## T3 能力位与文档

**Files**：`packages/protocol/src/game.ts`、`game.test.ts`；
`docs/games/paodekuai.md`；
`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md`、
`docs/superpowers/plans/2026-10-23-multi-game-platform-paodekuai.md`（取代指针）；
`apps/client/src/audio/index.ts`（`cueForPass` 注释）。

1. 测试先行：`game.test.ts` 断言 pdk `voiceAnnouncements === true`。红。
2. 实现：能力位改 true；文档补「语音播报复用斗地主牌型语音（不含王/叫抢）」；
   旧多玩法 spec/plan 各加一行「已被 2026-10-25 语音 spec 取代」；
   `cueForPass` 注释补 4 人 seat 3 回退。
3. 绿：`pnpm -C packages/protocol test && lint`；`pnpm -C apps/client run lint`。
4. Commit：`docs: 跑得快语音能力位与文档`。

## T4 全量与收口

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
pnpm exec turbo run test lint --force
pnpm verify:admin
```

## 计划审查记录

（待独立 reviewer 审查后填写）
