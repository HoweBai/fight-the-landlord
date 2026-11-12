# 川麻红金 v18：缺门出牌引导（设计）

状态：已确认（2026-11-13，用户选方案 A：服务端下发提示 + 客户端引导）；已过一轮对抗审查（见 §8）。
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

同族：缺门牌不能碰/杠、手里有缺门牌不能胡、定缺选择不合法——都落成同一句「换一手再试」。**本片只做缺门出牌引导**；同族错误文案另立片（登记见 D13）。

## 0.3 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 协议 `MahjongPlayerView` 增加可选字段 `mustDiscardSuit?: MahjongSuit \| null` | 用户方案 A |
| D2 | 服务端 `buildMahjongView` 用**查看者自己**的 `player` 计算：`lackSuit !== null && hasLackTiles(player.hand, lackSuit) ? lackSuit : null`；所有阶段都带，客户端自行按阶段使用 | 开发方 + 审查修正 |
| D3 | 客户端只在 `phase === 'play' && amActive`（我的出牌回合）使用该字段；其他阶段忽略 | 开发方 |
| D4 | 信息井方孔提示：我的出牌回合且有缺门牌时，状态文案改为 `先打缺门X`（5 字），替代「请出牌」 | 开发方 |
| D5 | 手牌视觉：缺门牌金色发丝描边；非缺门牌 `opacity: .45`（仍可点，点了只提示不发请求）；摸牌位的金点也随被拦状态压暗 | 开发方 + 审查修正 |
| D6 | 非缺门牌点击：不选中、不发 discard、**重置 `lastClickIndex`**；手牌上方就地提示「先打完X，才能出其它花色」；提示分支**优先于**「再点一次出牌」并且自带 `phase==='play' && handSelectable` 门控 | 开发方 + 审查修正 |
| D7 | 客户端零规则逻辑：只消费服务端字段；服务端仍是最终裁判（`canDiscard` 不变） | 哑终端纪律 |
| D8 | 提示状态**不建计时器**：清零路径 = 点缺门牌成功 / `watch(phase)` / `watch(handSelectable)` / 手牌内容签名变化 / `mustDiscardSuit` 变 null | 开发方 + 审查修正 |
| D9 | 兼容双向：旧服务端不发字段 ⇒ 无提示无置灰；旧客户端忽略可选字段（validator 逐字段、无白名单） | 兼容 |
| D10 | 不动 claim/lack/exchange UI、动作区、长按弹层、听牌行、音效/动画 | 范围 |
| D11 | 进入「必须打缺门」时，若当前选中含非缺门牌 ⇒ 清空选择（**版本错配防御**；单实例一致视图下不可达） | 开发方 + 审查修正 |
| D12 | 协议 validator 增加**语义不变式**：`mustDiscardSuit != null` 时必须等于 `lackSuits[seat]` 且 `hand` 含该花色（防「合法但错误的花色」造成回合内软锁） | 审查修正（高） |
| D13 | 同族被吞原因（缺门牌不能碰/杠、缺门牌不能胡、定缺选择不合法）**登记为另立片**，本片不改 13001 文案 | 审查登记 |
| D14 | 交付：H5 随部署立即生效；APK 必须重打才带客户端引导；版本是否 bump（0.1.13/113）由用户裁决 | 审查修正 |

## 1. 协议

- `packages/protocol/src/mahjong/types.ts` `MahjongPlayerView` 增加：
  ```ts
  /** 仅当自己手里仍有缺门牌时 = 缺门花色；否则 null/省略。仅作展示提示，服务端仍权威。 */
  mustDiscardSuit?: MahjongSuit | null;
  ```
- `packages/protocol/src/validate.ts` `assertMahjongPlayerView`（在 `lackSuits`/`hand` 校验之后）：
  ```ts
  if (v.mustDiscardSuit !== undefined) {
    const m = v.mustDiscardSuit;
    if (m !== null && m !== 0 && m !== 1 && m !== 2) {
      throw new ProtocolError(`${path}.mustDiscardSuit must be null|0|1|2`);
    }
    if (m !== null) {
      if ((v.lackSuits as Array<number | null>)[v.seat as number] !== m) {
        throw new ProtocolError(`${path}.mustDiscardSuit must equal lackSuits[seat]`);
      }
      if (!(v.hand as Tile[]).some((t) => t.s === m)) {
        throw new ProtocolError(`${path}.mustDiscardSuit must be present in hand`);
      }
    }
  }
  ```
- 协议测试 `packages/protocol/src/mahjong/mahjong.test.ts`：
  - `baseView()` 增加正向用例：`lackSuits:[0,null,null,null]` + hand 含 0 花色 + `mustDiscardSuit: 0` ⇒ 通过；`mustDiscardSuit: null` ⇒ 通过；省略 ⇒ 通过。
  - 负向：`mustDiscardSuit: 3` / 字符串 / 负数 / 与 `lackSuits[seat]` 不一致 / hand 不含该花色 ⇒ 抛 `ProtocolError`。

## 2. 服务端视图

- `packages/game-service/src/games/mahjong/view.ts` `buildMahjongView`（用 `hasLackTiles`，不重写公式；补 import）：
  ```ts
  const lackSuit = player.lackSuit;
  const mustDiscardSuit = lackSuit !== null && hasLackTiles(player.hand, lackSuit) ? lackSuit : null;
  ```
  返回对象加 `mustDiscardSuit`。
- 语义：所有阶段都计算（客户端只在自己出牌回合用）；`player` 是**查看者**（`session.players[seat]`），不是 `currentPlayer`。
- 测试 `packages/game-service/test/mahjong-runtime.test.ts`（`buildView` 返回联合类型，按仓内写法 `as MahjongPlayerView` 收窄）：
  - **跨座位定点**：`players[0]` 缺 0、手牌含 0；`players[1]` 缺 1、手牌不含 1；`currentPlayer=0` ⇒ `view(0).mustDiscardSuit===0`、`view(1)===null`；`currentPlayer=1` 复断言两视图**不变**。
  - **独立 oracle**：对每个 view 断言 `mustDiscardSuit === (lackSuits[seat] !== null && hasLackTiles(view.hand, lackSuits[seat]) ? lackSuits[seat] : null)`；并用 `canDiscard(view.hand, lack, 非缺门牌) === false`、`canDiscard(..., 缺门牌) === true` 交叉验证。
  - 打完最后一张缺门牌 ⇒ `null`；未定缺 ⇒ `null`。

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
- **点击守卫**（`onTileClick` 开头，`handSelectable` 早退之后、`emit('select')` 之前；**必须用 `displayTiles` 下标**）：
  ```ts
  const guard = mustDiscardSuit.value;
  const entry = displayTiles.value[index];
  if (guard !== null && entry && entry.tile.s !== guard) {
    lackBlockedHint.value = true;
    lastClickIndex.value = -1;
    return;
  }
  lackBlockedHint.value = false;
  ```
- 模板提示分支（**缺门提示在前**，两条都带完整门控）：
  ```html
  <view v-if="phase === 'play' && handSelectable && lackBlockedHint" class="mj__hand-hint">
    <text>先打完{{ mustDiscardName }}，才能出其它花色</text>
  </view>
  <view v-else-if="phase === 'play' && handSelectable && selected.length === 1" class="mj__hand-hint">
    <text>再点一次出牌（或点"出牌"按钮）</text>
  </view>
  ```
- 清零：点缺门牌成功时 `lackBlockedHint=false`；`watch(phase)`、`watch(handSelectable)`、手牌内容签名 watch、`watch(mustDiscardSuit)` 变 null 都清零。
- D11：`watch(mustDiscardSuit, (suit) => { if (suit !== null && selected 中含非该花色) { selected.value = []; lastClickIndex.value = -1; } lackBlockedHint.value = false; })`。
- 摸牌位金点压暗：包裹层在 `mustDiscardSuit !== null && entry.tile.s !== mustDiscardSuit` 时加 `mj__hand-drawn--blocked`；CSS `.mj__hand-drawn--blocked .mj__hand-drawn-dot { opacity: .45; }`。
- 样式：
  ```scss
  .mj__hand :deep(.mj__hand-tile--lack-first) {
    outline: $ftl-hairline solid $ftl-color-mj-gold;
    outline-offset: 0;
  }
  .mj__hand :deep(.mj__hand-tile--lack-blocked) {
    opacity: .45;
  }
  ```
  （`.mj-tile` 自带 3px 圆角，不重复声明。）
- 交互边界：非缺门牌仍可点（用于提示），但不选中/不出牌；出牌按钮仍按 `selectedCount === 1` 禁用；双击非缺门牌在第一次点击即被拦下。

## 4. 测试

- 协议：§1 列出的正向（0/null/省略）与负向（3/字符串/负数/与 lackSuits 不一致/hand 不含）。
- game-service：§2 的跨座位定点 + oracle + canDiscard 交叉 + 边界。
- 客户端 `mahjong-board.test.ts`：
  - `view({ mustDiscardSuit: 0 })` + play + 我的回合：`.mj-hub__hint` 文本「先打缺门万」。
  - 手牌：花色 0 的牌有 `mj__hand-tile--lack-first`；其它有 `mj__hand-tile--lack-blocked`。
  - **先选一张缺门牌，再点非缺门牌** ⇒ `.mj__hand-hint` 显示「先打完万，才能出其它花色」（优先于「再点一次出牌」）。
  - 点非缺门牌：无 `.mj-tile--selected`、无 `mahjong` emit；点缺门牌：正常选中、提示消失。
  - 双击非缺门牌：不 emit；双击缺门牌：emit discard。
  - **摸牌位恰为缺门牌** ⇒ 可选中/可双击出牌；**摸牌位为非缺门牌** ⇒ 被拦（用带 14 张 hand 的夹具）。
  - 清零用例：点缺门牌 / phase 变化 / `handSelectable` 翻转 / 手牌内容变化 / 字段变 null。
  - D11（版本错配形态）：先以**无字段**视图选中非缺门牌，再 `setProps` 同手牌 + `mustDiscardSuit: 0` ⇒ 选择被清、提示清、出牌按钮禁用。
  - 非我的回合 / `mustDiscardSuit: null`：无提示、无置灰。
  - 源码闸：无新增定时器（animations 闸）；发丝线走 `$ftl-hairline`。
- conformance `slice-36-mahjong.ts`（**必选**，不只可选）：driver 逐步 oracle（`assertMustDiscard`）+ `mustDiscardSeen > 0`（终局 finalViews 判别力弱，不再使用）。
- 全量：`pnpm -C packages/protocol test`、`pnpm -C packages/game-service test`、`pnpm -C apps/client test`、`pnpm -C apps/client lint`、`pnpm -C apps/client build`；conformance slice-36（真栈，部署阶段）。

## 5. 错误处理与边界

- 字段缺失（旧服务端）：`?? null` ⇒ 无提示无置灰，退回现状。
- 字段非法/语义不一致：protocol validator 拦截（**出站实际拦截点在 api-gateway：整帧丢弃**；麻将 `buildView` 自身不过 `validateOutbound`，本片不改该接线，仅在 spec 登记）。
- 手牌长度变化（出牌/摸牌/补杠 14→14）：用**手牌内容签名**而不是仅 `hand.length` 清提示；`handSelectable` 翻转也清。
- 被拦点击重置 `lastClickIndex`，避免 A→B(被拦)→A 在 400ms 内触发意外双击出牌。
- 我的回合但手里已无缺门牌：字段 null ⇒ 正常出牌。
- 非我的回合/claim/lack/exchange：字段忽略。
- 缺门牌同时是摸牌位/选中：金边、金点、选中框叠加；被拦摸牌位的金点也压暗。
- D11 只在版本错配（视图字段与手牌不一致）时可达；单实例一致视图下由手牌内容 watch 清选择。
- 旧客户端 + 新服务端：旧客户端忽略可选字段（validator 逐字段、无白名单）。

## 6. 风险

- 字段算错会误拦合法出牌：D12 的 validator 语义不变式 + 服务端与 `canDiscard` 共用 `hasLackTiles` + 跨座位测试 + conformance oracle 四重防线；若仍发生，协议层会先抛（网关丢帧），不会形成「全部手牌被拦、出牌禁用」的回合内软锁。
- 置灰 `.45` 可能影响可读性：缺门牌仍高亮金边，非缺门牌点击给出文字提示。
- 信息井 5 字上限：「先打缺门万」正好 5 字；v16 方孔 62px 内容宽已实测 5 字可放。
- 协议字段新增：旧客户端忽略；镜像需重建；APK 需重打（D14）。版本 bump 由用户裁决。
- 同族错误文案仍会显示「服务端判定这手牌不合法」：本片范围外，D13 登记另立片。

## 7. 涉及文件

- `packages/protocol/src/mahjong/types.ts`
- `packages/protocol/src/validate.ts`
- `packages/protocol/src/mahjong/mahjong.test.ts`
- `packages/game-service/src/games/mahjong/view.ts`
- `packages/game-service/test/mahjong-runtime.test.ts`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- `apps/client/test/mahjong-board.test.ts`
- `tools/conformance/src/slices/slice-36-mahjong.ts`（必选断言）

## 8. 审查记录

2026-11-13 按 `docs/dev-process.md` §3 做独立对抗审查（sonnet，只读）：核对了 protocol validator 的逐字段/无白名单、可选字段双向兼容、服务端按查看者投影、`amActive`/`handSelectable` 在 play/exchange 的行为、`displayTiles` 与 `hand` 下标差异、提示分支优先级、D8/D11 清理路径、信息井 5 字宽度、发丝线令牌、animations 无时钟闸、conformance driver 的独立缺门推导。

结论：**无阻断；5 高 + 9 低**，均已修订：
- 高：① 缺门提示必须是**第一条分支**且自带 `phase/handSelectable` 门控（否则「已选缺门牌后点被拦牌」时被选中提示吞掉）⇒ D6/§3；② 服务端测试必须**跨座位**区分查看者与 currentPlayer（原夹具 `dealerSeat=0` 会让错误实现全绿）⇒ D2/§2；③ 点击守卫必须用 `displayTiles[index]` 并补摸牌位缺门/非缺门用例（13 张夹具下 `hand[index]` 等价）⇒ D6/§3；④ D8/D11 的清零/清选必须有客户端用例，D11 按版本错配形态构造 ⇒ §4；⑤ validator 增加语义不变式（花色=lackSuits[seat] 且 hand 含之），防「合法但错误花色」导致软锁 ⇒ D12/§1。
- 低：改用 `hasLackTiles`；麻将 buildView 不过 `validateOutbound`（拦截在网关、整帧丢弃）已如实登记；conformance 断言改必选；协议补 null/负向用例与类型收窄；清零用内容签名 + `handSelectable`；兼容双向与 APK/H5 交付（D14）；同族错误文案另立片（D13）；去掉重复圆角并压暗被拦摸牌位金点；被拦点击重置 `lastClickIndex`。
