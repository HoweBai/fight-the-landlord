# 川麻红金 v18：缺门出牌引导（设计）

状态：已确认（2026-11-13，用户选方案 A：服务端下发提示 + 客户端引导）。
范围：协议（`MahjongPlayerView` 可选字段）+ game-service 视图投影 + 客户端展示/交互 + 对应测试。
不动：麻将规则实现（`canDiscard` 等）、发牌/RNG、结算、admin/配置、数据库。

## 0. 背景

### 0.1 当前麻将提示清单（盘点）

- **轮次/状态（信息井方孔）**：请出牌 / 等待出牌 / 请响应 / 等待响应 / 请定缺 / 等待定缺 / 选同花3张 / 等待换三张 / 已胡N家 / 本局结束；倒计时；自家末 5 秒红色脉动。
- **能力/身份**：座位牌角标（缺X/听/胡/托/庄）、信息井四扇形徽标（胡/听/缺/托）、当前行动者金边、分数与增减。
- **牌河**：最新弃牌高亮、`+N` 徽标、claimed 来源描边、「已胡」标签。
- **听牌**：行标签「听 N 张」+ 小牌；长按手牌弹层「打出 5万 / ✓ 仍能听牌 / ⚠ 可能影响听牌」。
- **操作**：选 1 张后「再点一次出牌（或点"出牌"按钮）」；动作区胡/杠/碰/过/出牌/换三张/已选 x/3/万筒条+推荐；托管遮罩。
- **局面/错误**：等待发牌、重新发牌横幅、胡牌 banner、结算面板、断线重连；错误 toast（现在还没轮到你/操作太频繁/牌局状态有更新/本局已经结束…）。

### 0.2 问题：缺门出牌的原因被吞

- 规则：手里仍有缺门牌时**只能打缺门**（`shared/mahjong/lack.ts` `canDiscard`）；否则 `actions.ts` 抛 `ProtocolError('必须先打完缺门牌')`。
- 服务端把该错误归到 `ILLEGAL_ACTION (13001)`；客户端对 13001 是**固定文案**「服务端判定这手牌不合法，换一手再试」，**不读服务端 message** ⇒ 玩家看不到「缺门」这个真实原因。
- 客户端也没有任何缺门引导：可以选中非缺门牌、点出牌，直到服务端拒绝才知道。

同族：缺门牌不能碰/杠、手里有缺门牌不能胡、定缺选择不合法——都落成同一句「换一手再试」。

## 0.3 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 协议 `MahjongPlayerView` 增加可选字段 `mustDiscardSuit?: MahjongSuit \| null` | 用户方案 A |
| D2 | 服务端 `buildMahjongView` 计算：`lackSuit !== null && hand.some(t => t.s === lackSuit) ? lackSuit : null`；所有阶段都带，客户端自行按阶段使用 | 开发方 |
| D3 | 客户端只在 `phase === 'play' && amActive`（我的出牌回合）使用该字段；其他阶段忽略 | 开发方 |
| D4 | 信息井方孔提示：我的出牌回合且有缺门牌时，状态文案改为 `先打缺门X`（5 字，X=万/筒/条），替代「请出牌」 | 开发方 |
| D5 | 手牌视觉：缺门牌金色发丝描边；非缺门牌 `opacity: .45`（仍可点，点了只提示不发请求） | 开发方 |
| D6 | 非缺门牌点击：不再选中、不发 discard；手牌上方就地提示「先打完X，才能出其它花色」（复用 `.mj__hand-hint` 位置与样式） | 开发方 |
| D7 | 客户端零规则逻辑：只消费服务端字段；服务端仍是最终裁判（`canDiscard` 不变） | 哑终端纪律 |
| D8 | 提示状态**不建计时器**：`lackBlockedHint` 只在点非缺门牌时置真，点缺门牌/阶段变化/手牌长度变化/`mustDiscardSuit` 变 null 时清零 | 牌桌区不新造时钟 |
| D9 | 旧服务端/字段缺失 ⇒ 无提示、无置灰（优雅降级）；新客户端 + 旧服务端不报错 | 兼容 |
| D10 | 不动 claim/lack/exchange UI、动作区、长按弹层、听牌行、音效/动画 | 范围 |

## 1. 协议

- `packages/protocol/src/mahjong/types.ts` `MahjongPlayerView` 增加：
  ```ts
  /** 仅当自己手里仍有缺门牌时 = 缺门花色；否则 null/省略。仅作展示提示，服务端仍权威。 */
  mustDiscardSuit?: MahjongSuit | null;
  ```
- `packages/protocol/src/validate.ts` `assertMahjongPlayerView`：若 `mustDiscardSuit` 存在，必须是 `null | 0 | 1 | 2`。
- 协议测试 `packages/protocol/src/mahjong/mahjong.test.ts`：`baseView()` 可带 `mustDiscardSuit: 0` 通过 `validateOutbound`；`mustDiscardSuit: 3` 抛 `ProtocolError`；省略也通过。

## 2. 服务端视图

- `packages/game-service/src/games/mahjong/view.ts` `buildMahjongView`：
  ```ts
  const lackSuit = player.lackSuit;
  const mustDiscardSuit =
    lackSuit !== null && player.hand.some((t) => t.s === lackSuit) ? lackSuit : null;
  ```
  返回对象加 `mustDiscardSuit`。
- 语义：所有阶段都计算（客户端只在自己出牌回合用）；手里缺门牌打完 ⇒ null；未定缺 ⇒ null。
- 测试 `packages/game-service/test/mahjong-runtime.test.ts`：
  - 定缺后自洽：`view.mustDiscardSuit === (hand 含缺门 ? lackSuit : null)`。
  - 定点：手工把 `s.players[0].lackSuit = 0`、hand 含 `0` 花色 ⇒ view 为 `0`；移除该花色 ⇒ `null`。
- 一致性：`mustDiscardSuit` 非空 ⇔ `hasLackTiles(hand, lackSuit)`；与 `canDiscard` 同一判定源（`hasLackTiles`），避免两套算法。

## 3. 客户端（MahjongBoard）

- computed：
  ```ts
  const mustDiscardSuit = computed(() =>
    phase.value === 'play' && amActive.value ? props.view?.mustDiscardSuit ?? null : null,
  );
  const mustDiscardName = computed(() =>
    mustDiscardSuit.value === null ? '' : MAHJONG_SUIT_NAMES[mustDiscardSuit.value],
  );
  ```
- `statusText`（play 分支）：`amActive` 且有 `mustDiscardSuit` ⇒ `先打缺门${mustDiscardName}`；否则沿用「请出牌/等待出牌」。
- 手牌类（`handTileBind` 的 `class`）：
  - `mj__hand-tile--lack-first`：`mustDiscardSuit !== null && entry.tile.s === mustDiscardSuit`
  - `mj__hand-tile--lack-blocked`：`mustDiscardSuit !== null && entry.tile.s !== mustDiscardSuit`
- `onTileClick(index)` 开头：若 `mustDiscardSuit !== null` 且该牌花色不同 ⇒ `lackBlockedHint.value = true; return;`（不 emit select、不选中、不触发双击出牌）。
- `lackBlockedHint` 清零：点缺门牌成功进入选中逻辑时；`watch(phase)`；`watch(() => hand.length)`；`watch(mustDiscardSuit)` 变 null。
- 模板：`.mj__hand-hint` 增加 `v-else-if="lackBlockedHint"` 分支，文案「先打完{{mustDiscardName}}，才能出其它花色」；不新增计时器。
- 样式：
  ```scss
  .mj__hand :deep(.mj__hand-tile--lack-first) {
    outline: $ftl-hairline solid $ftl-color-mj-gold;
    outline-offset: 0;
    border-radius: 3px;
  }
  .mj__hand :deep(.mj__hand-tile--lack-blocked) {
    opacity: .45;
  }
  ```
  （选中/摸牌金点规则不变；缺门牌同时是摸牌位时两种标记叠加。）
- 交互边界：非缺门牌仍可点（用于提示），但不会选中/出牌；出牌按钮仍按 `selectedCount === 1` 禁用；双击非缺门牌在第一次点击即被拦下。

## 4. 测试

- 协议：上述三例（有效 0、非法 3、省略）。
- game-service：上述自洽 + 定点两例。
- 客户端 `mahjong-board.test.ts`：
  - `view({ mustDiscardSuit: 0 })` + play + 我的回合：`.mj-hub__hint` 文本「先打缺门万」。
  - 手牌：花色 0 的牌有 `mj__hand-tile--lack-first`；其它有 `mj__hand-tile--lack-blocked`；数量与手牌一致。
  - 点非缺门牌：无 `.mj-tile--selected`、无 `mahjong` emit、`.mj__hand-hint` 显示「先打完万，才能出其它花色」。
  - 点缺门牌：正常选中、提示消失。
  - 双击非缺门牌：不 emit discard；双击缺门牌：emit discard。
  - `mustDiscardSuit: null` 或非我的回合：无提示/无置灰。
  - 源码闸：无新增 `setTimeout/setInterval`（animations 闸）；颜色/发丝线走 `$ftl-*`。
- conformance `slice-36-mahjong.ts`：定缺后断言 `view.mustDiscardSuit` 与手牌一致（可选：real-stack 验证）。
- 全量：`pnpm -C packages/protocol test`、`pnpm -C packages/game-service test`、`pnpm -C apps/client test`、`pnpm -C apps/client lint`、`pnpm -C apps/client build`。

## 5. 错误处理与边界

- `mustDiscardSuit` 字段缺失（旧服务端）：`?? null` ⇒ 无提示、无置灰，退回现状。
- 字段值非法：协议 validator 在出站拦截（服务端 bug 尽早暴露）。
- 手牌长度变化（出牌/摸牌）：提示状态清零；服务端下一帧重算字段。
- 我的回合但手里已无缺门牌：字段 null ⇒ 正常出牌。
- 非我的回合/claim/lack：字段忽略。
- 缺门牌同时是摸牌位/选中：金边、金点、选中框叠加，不冲突。
- 长按非缺门牌：现有听牌弹层不变（信息性，不发出牌）。

## 6. 风险

- 字段算错会误拦合法出牌：服务端与 `canDiscard` 共用 `hasLackTiles` 语义，测试钉住；客户端只消费字段，不自行推导。
- 置灰 `.45` 可能影响可读性：缺门牌仍高亮金边，非缺门牌点击会给出文字提示。
- 信息井 5 字上限：「先打缺门万」正好 5 字；实测 v16 方孔 62px 内容宽可放 5 字。
- 协议字段新增：`validateOutbound` 逐字段校验、非严格白名单，旧消费方忽略可选字段；镜像需重建（部署阶段处理）。
- 版本：APK 当前 0.1.12/112；本片部署时是否 bump 由用户裁决。

## 7. 涉及文件

- `packages/protocol/src/mahjong/types.ts`
- `packages/protocol/src/validate.ts`
- `packages/protocol/src/mahjong/mahjong.test.ts`
- `packages/game-service/src/games/mahjong/view.ts`
- `packages/game-service/test/mahjong-runtime.test.ts`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- `apps/client/test/mahjong-board.test.ts`
- `tools/conformance/src/slices/slice-36-mahjong.ts`（可选断言）

## 8. 审查记录

（待设计对抗审查后填写）
