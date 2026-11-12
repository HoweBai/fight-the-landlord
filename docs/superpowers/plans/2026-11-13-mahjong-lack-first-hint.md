# 川麻红金 v18：缺门出牌引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当玩家手里仍有缺门牌时，服务端在视图里下发 `mustDiscardSuit`；客户端据此显示「先打缺门X」、高亮缺门牌、置灰非缺门牌，并在点击非缺门牌时就地提示、不发请求。

**Architecture:** 协议加可选字段 + 语义 validator；game-service 视图按**查看者**计算；客户端只消费字段（哑终端），不实现规则。conformance driver 增加独立 oracle。

**Tech Stack:** TypeScript / Vitest / NestJS（game-service）/ Vue 3（client）/ conformance。

## Global Constraints

- 规则实现（`canDiscard` 等）不改；服务端仍权威；客户端零规则逻辑。
- 协议字段 `mustDiscardSuit?: MahjongSuit | null`；validator 语义不变式：非 null ⇒ `=== lackSuits[seat]` 且 `hand` 含该花色。
- 服务端用**查看者自己的** `player`（`session.players[seat]`）计算，所有阶段都带；用 `hasLackTiles`，不重写公式。
- 客户端只在 `phase === 'play' && amActive` 使用；信息井文案 `先打缺门X`（5 字）；缺门牌金边、非缺门牌 opacity .45；点击守卫用 `displayTiles[index]`。
- 提示分支缺门优先且自带 `phase==='play' && handSelectable` 门控；无计时器；被拦点击重置 `lastClickIndex`。
- 不清洗同族错误文案（13001）；登记另立片。
- 每个 Task 先写失败测试，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 本片不推送/不部署/不重打 APK；版本 bump 与交付方式由用户裁决（H5 随部署生效，APK 需重打）。

---

## Task 1: 协议字段 + 语义 validator

**Files:**
- Modify: `packages/protocol/src/mahjong/types.ts`
- Modify: `packages/protocol/src/validate.ts`
- Test: `packages/protocol/src/mahjong/mahjong.test.ts`

**Interfaces:**
- Produces: `MahjongPlayerView.mustDiscardSuit?: MahjongSuit | null`；validator 语义不变式。

- [x] **Step 1: 写失败测试**

在 `packages/protocol/src/mahjong/mahjong.test.ts` 增加（`MahjongSuit` 必须从 `./tile` 导入；`baseView()` hand 含 0 花色）：

```ts
it('mustDiscardSuit：可选、值域 0|1|2|null、语义=lackSuits[seat] 且在手牌', () => {
  const ok = {
    ...baseView(),
    lackSuits: [0, null, null, null] as Array<MahjongSuit | null>,
    mustDiscardSuit: 0 as MahjongSuit,
  };
  expect(() =>
    validateOutbound({ type: 'game.state_update', version: 1, payload: ok }),
  ).not.toThrow();
  expect(() =>
    validateOutbound({
      type: 'game.state_update',
      version: 1,
      payload: { ...baseView(), mustDiscardSuit: null },
    }),
  ).not.toThrow();
  for (const bad of [3, -1, '0'] as unknown[]) {
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: 1, payload: { ...ok, mustDiscardSuit: bad } }),
    ).toThrow(ProtocolError);
  }
  // 与 lackSuits[seat] 不一致
  expect(() =>
    validateOutbound({
      type: 'game.state_update',
      version: 1,
      payload: { ...ok, lackSuits: [1, null, null, null] },
    }),
  ).toThrow(ProtocolError);
  // 手牌不含该花色
  expect(() =>
    validateOutbound({
      type: 'game.state_update',
      version: 1,
      payload: { ...baseView(), lackSuits: [1, null, null, null], mustDiscardSuit: 1 },
    }),
  ).toThrow(ProtocolError);
});
```

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/mahjong.test.ts`
Expected: FAIL（字段未声明/validator 未实现）。

- [x] **Step 2: 实现**

`types.ts` `MahjongPlayerView`（`claimsForMe`/`tingTiles` 附近）加：
```ts
/** 仅当自己手里仍有缺门牌时 = 缺门花色；否则 null/省略。仅作展示提示，服务端仍权威。 */
mustDiscardSuit?: MahjongSuit | null;
```

`validate.ts` `assertMahjongPlayerView`（`lackSuits` 校验之后）加：
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

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/mahjong.test.ts` → PASS；`pnpm -C packages/protocol lint` → exit 0；`pnpm -C packages/protocol build` → exit 0。

- [x] **Step 3: 提交**

```bash
git add packages/protocol/src/mahjong/types.ts packages/protocol/src/validate.ts packages/protocol/src/mahjong/mahjong.test.ts
git commit -m "feat(protocol): 麻将视图下发 mustDiscardSuit（缺门引导）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 服务端视图 + 独立 oracle（game-service + conformance）

**Files:**
- Modify: `packages/game-service/src/games/mahjong/view.ts`
- Test: `packages/game-service/test/mahjong-runtime.test.ts`
- Modify: `tools/conformance/src/lib/mahjong-driver.ts`
- Modify: `tools/conformance/src/slices/slice-36-mahjong.ts`

**Interfaces:**
- Consumes: Task 1 的字段/validator。
- Produces: `buildMahjongView` 返回 `mustDiscardSuit`；driver `assertMustDiscard`。

- [x] **Step 1: 写失败测试（跨座位 + oracle）**

`packages/game-service/test/mahjong-runtime.test.ts`：
- import 加 `hasLackTiles, canDiscard`（from `@fight-the-landlord/shared`）与 `type MahjongPlayerView`、`validateOutbound`（from `@fight-the-landlord/protocol`）。
- 加 helper：
```ts
function advanceToPlay() {
  let s = create();
  for (const seat of [0, 1, 2, 3]) {
    s = runtime.applyAction(s, runtime.autoAction(s, seat), ctx(seat)).session;
  }
  for (const seat of [0, 1, 2, 3]) {
    s = runtime.applyAction(s, runtime.autoAction(s, seat), ctx(seat)).session;
  }
  return s;
}
```
- 加用例：
```ts
it('mustDiscardSuit 按查看者投影（不跟 currentPlayer 走）', () => {
  const s = advanceToPlay();
  const t = (suit: 0 | 1 | 2, rank: number) => ({ s: suit, r: rank });
  s.players[0]!.lackSuit = 0;
  s.players[0]!.hand = [t(0, 1), ...Array.from({ length: 12 }, (_, i) => t(1, (i % 9) + 1))];
  s.players[1]!.lackSuit = 1;
  s.players[1]!.hand = Array.from({ length: 13 }, (_, i) => t(0, (i % 9) + 1));
  s.currentPlayer = 0;
  const view0 = runtime.buildView(s, 0) as MahjongPlayerView;
  const view1 = runtime.buildView(s, 1) as MahjongPlayerView;
  expect(view0.mustDiscardSuit).toBe(0);
  expect(view1.mustDiscardSuit).toBe(null);
  s.currentPlayer = 1;
  expect((runtime.buildView(s, 0) as MahjongPlayerView).mustDiscardSuit).toBe(0);
  expect((runtime.buildView(s, 1) as MahjongPlayerView).mustDiscardSuit).toBe(null);
  for (const v of [view0, view1]) {
    const lack = v.lackSuits[v.seat]!;
    const expected = lack !== null && hasLackTiles(v.hand, lack) ? lack : null;
    expect(v.mustDiscardSuit ?? null, `seat ${v.seat}`).toBe(expected);
  }
  expect(canDiscard(view0.hand, 0, { s: 1, r: 1 })).toBe(false);
  expect(canDiscard(view0.hand, 0, { s: 0, r: 1 })).toBe(true);
  expect(canDiscard(view1.hand, 1, { s: 0, r: 1 })).toBe(true);
  s.players[0]!.hand = Array.from({ length: 13 }, (_, i) => t(1, (i % 9) + 1));
  expect((runtime.buildView(s, 0) as MahjongPlayerView).mustDiscardSuit).toBe(null);
  // 未定缺 ⇒ null
  s.players[2]!.lackSuit = null;
  expect((runtime.buildView(s, 2) as MahjongPlayerView).mustDiscardSuit).toBe(null);
  // 与生产同源的出站校验（gateway 会整帧丢弃不一致视图）
  expect(() =>
    validateOutbound({ type: 'game.state_update', version: 1, payload: view0 }),
  ).not.toThrow();
  // 非 play 阶段也带（客户端自行按阶段使用）
  s.state = 'lack';
  s.players[0]!.hand = [t(0, 1), ...Array.from({ length: 12 }, (_, i) => t(1, (i % 9) + 1))];
  expect((runtime.buildView(s, 0) as MahjongPlayerView).mustDiscardSuit).toBe(0);
});
```

`tools/conformance/src/lib/mahjong-driver.ts` 加独立 oracle（**导出**，供单测；在 `playMahjongToEnd` 循环里、`pickMahjongAction` 之前调用）：
```ts
/** 缺门引导契约：mustDiscardSuit 必须与「手里仍有缺门牌」一致（独立 oracle）。 */
export function assertMustDiscard(view: MahjongPlayerView): void {
  const lack = view.lackSuits[view.seat];
  const expected = lack !== null && view.hand.some((t) => t.s === lack) ? lack : null;
  if ((view.mustDiscardSuit ?? null) !== expected) {
    throw new ConformanceError(
      `${view.seat} 座 mustDiscardSuit=${String(view.mustDiscardSuit)}，期望 ${String(expected)}`,
    );
  }
}
```
`MahjongOutcome` 增加 `mustDiscardSeen: number`；`playMahjongToEnd` 里 `let mustDiscardSeen = 0;`，在 `assertMustDiscard(view);` 之后 `if (view.mustDiscardSuit != null) mustDiscardSeen += 1;`，返回值加 `mustDiscardSeen`。

`tools/conformance/test/mahjong-driver.test.ts` 增加（import `assertMustDiscard`）：
```ts
it('assertMustDiscard：与手牌一致才通过', () => {
  expect(() =>
    assertMustDiscard(view({ hand: [t(0, 1)], lackSuits: [0, null, null, null], mustDiscardSuit: 0 })),
  ).not.toThrow();
  expect(() =>
    assertMustDiscard(view({ hand: [t(1, 1)], lackSuits: [0, null, null, null], mustDiscardSuit: null })),
  ).not.toThrow();
  expect(() =>
    assertMustDiscard(view({ hand: [t(0, 1)], lackSuits: [0, null, null, null], mustDiscardSuit: 1 })),
  ).toThrow();
  expect(() =>
    assertMustDiscard(view({ hand: [t(1, 1)], lackSuits: [0, null, null, null], mustDiscardSuit: 0 })),
  ).toThrow();
});
```

`tools/conformance/src/slices/slice-36-mahjong.ts` 末尾（`out` 可得处）加：
```ts
checks.atLeast(out.mustDiscardSeen, 1, '整局至少观察到一次非 null mustDiscardSuit');
```
（`finalViews` 在 ended 态判别力弱，不再用它做该断言；逐步 oracle 已覆盖。）

Run: `pnpm -C packages/protocol build && pnpm -C packages/game-service exec vitest run test/mahjong-runtime.test.ts`
Expected: FAIL（视图未下发字段）。

- [x] **Step 2: 实现服务端视图**

`packages/game-service/src/games/mahjong/view.ts`：
- import `mustClearLack`（from `@fight-the-landlord/shared`；现成 helper：`lackSuit !== null && hasLackTiles(hand, lackSuit)`）。
- `buildMahjongView` 里（`const player = ...` 之后）：
```ts
const mustDiscardSuit = mustClearLack(player) ? player.lackSuit : null;
```
- 返回对象加 `mustDiscardSuit`（`claimsForMe`/`tingTiles` 附近）。

Run: `pnpm -C packages/protocol build && pnpm -C packages/game-service exec vitest run test/mahjong-runtime.test.ts` → PASS；`pnpm -C packages/game-service lint` → exit 0；`pnpm -C tools/conformance test` + `pnpm -C tools/conformance build` + `pnpm -C tools/conformance lint` → 绿。

- [x] **Step 3: 提交**

```bash
git add packages/game-service/src/games/mahjong/view.ts packages/game-service/test/mahjong-runtime.test.ts tools/conformance/src/lib/mahjong-driver.ts tools/conformance/src/slices/slice-36-mahjong.ts
git commit -m "feat(mahjong): 视图下发 mustDiscardSuit + conformance 独立 oracle" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 客户端缺门引导（MahjongBoard）

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Test: `apps/client/test/mahjong-board.test.ts`

**Interfaces:**
- Consumes: `view.mustDiscardSuit`。
- Produces: 信息井 `先打缺门X`、手牌类 `mj__hand-tile--lack-first` / `--lack-blocked`、包裹层 `mj__hand-drawn--blocked`、`lackBlockedHint`。

- [x] **Step 1: 写失败测试**

`apps/client/test/mahjong-board.test.ts` 新增（`view()` fixture 加字段；手牌花色分布：万 7 张、筒/条若干）：

```ts
describe('MahjongBoard：v18 缺门出牌引导', () => {
  // ⚠️ 不要给基础 view() 加非 null 默认值（会打红既有摸牌位用例）；非 null 一律走 mustView()。
  const mustView = (over: Partial<Parameters<typeof view>[0]> = {}) =>
    view({ mustDiscardSuit: 0, ...over });
  const tileByLabel = (w: Wrapper, label: string) =>
    w.findAll('.mj__hand .mj-tile').find((t) => t.attributes('aria-label') === label)!;

  it('我的回合 + 缺万：信息井「先打缺门万」，万金边、其它置灰', () => {
    const w = mount(MahjongBoard, { props: props({ view: mustView() }) });
    expect(w.find('.mj-hub__hint').text()).toBe('先打缺门万');
    expect(w.findAll('.mj__hand-tile--lack-first').length).toBeGreaterThan(0);
    expect(w.findAll('.mj__hand-tile--lack-blocked').length).toBeGreaterThan(0);
    for (const t of w.findAll('.mj__hand-tile--lack-first')) {
      expect(t.attributes('aria-label')).toMatch(/^万/);
    }
  });

  it('点非缺门牌：不选中、不发请求、显示缺门提示；点缺门牌正常选中', async () => {
    const w = mount(MahjongBoard, { props: props({ view: mustView() }) });
    await tileByLabel(w, '筒6').trigger('click');
    expect(w.findAll('.mj-tile--selected')).toHaveLength(0);
    expect(w.emitted('mahjong')).toBeUndefined();
    expect(w.find('.mj__hand-hint').text()).toBe('先打完万，才能出其它花色');
    await tileByLabel(w, '万1').trigger('click');
    expect(w.findAll('.mj-tile--selected')).toHaveLength(1);
    expect(w.find('.mj__hand-hint').text()).toBe('再点一次出牌（或点"出牌"按钮）');
  });

  it('先选缺门牌再点非缺门牌：缺门提示优先于「再点一次」', async () => {
    const w = mount(MahjongBoard, { props: props({ view: mustView() }) });
    await tileByLabel(w, '万1').trigger('click');
    await tileByLabel(w, '筒6').trigger('click');
    expect(w.find('.mj__hand-hint').text()).toBe('先打完万，才能出其它花色');
  });

  it('双击非缺门牌不出牌；双击缺门牌出牌', async () => {
    const w = mount(MahjongBoard, { props: props({ view: mustView() }) });
    const blocked = tileByLabel(w, '筒6');
    await blocked.trigger('click');
    await blocked.trigger('click');
    expect(w.emitted('mahjong')).toBeUndefined();
    const lack = tileByLabel(w, '万1');
    await lack.trigger('click');
    await lack.trigger('click');
    expect(w.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'discard', tile: { s: 0, r: 1 } });
  });

  it('摸牌位：缺门牌可选中/可双击；非缺门牌被拦', async () => {
    const w = mount(MahjongBoard, { props: props({ view: mustView() }) });
    const hand14 = [...view().hand, tile(0, 9)];
    await w.setProps({ view: mustView({ hand: hand14 }) });
    await nextTick();
    const drawn = w.findAll('.mj__hand .mj-tile').at(-1)!;
    expect(drawn.classes()).toContain('mj__hand-tile--lack-first');
    await drawn.trigger('click');
    expect(w.findAll('.mj-tile--selected')).toHaveLength(1);

    const w2 = mount(MahjongBoard, { props: props({ view: mustView() }) });
    const hand14b = [...view().hand, tile(2, 1)];
    await w2.setProps({ view: mustView({ hand: hand14b }) });
    await nextTick();
    const drawn2 = w2.findAll('.mj__hand .mj-tile').at(-1)!;
    expect(drawn2.classes()).toContain('mj__hand-tile--lack-blocked');
    expect(w2.find('.mj__hand-drawn').classes()).toContain('mj__hand-drawn--blocked');
    await drawn2.trigger('click');
    expect(w2.findAll('.mj-tile--selected')).toHaveLength(0);
    expect(w2.find('.mj__hand-hint').text()).toBe('先打完万，才能出其它花色');
  });

  it('清零：点缺门牌 / handSelectable 翻转 / 手牌内容变化 / 阶段变化 / 字段消失', async () => {
    const w = mount(MahjongBoard, { props: props({ view: mustView() }) });
    await tileByLabel(w, '筒6').trigger('click');
    expect(w.find('.mj__hand-hint').exists()).toBe(true);
    await w.setProps({ interactive: false });
    await nextTick();
    expect(w.find('.mj__hand-hint').exists()).toBe(false);
    await w.setProps({
      interactive: true,
      view: mustView({ hand: [...view().hand.slice(1), tile(0, 1)] }),
    });
    await nextTick();
    expect(w.find('.mj__hand-hint').exists()).toBe(false);
    await tileByLabel(w, '筒6').trigger('click');
    expect(w.find('.mj__hand-hint').exists()).toBe(true);
    await w.setProps({ view: mustView({ state: 'ended' }) });
    await nextTick();
    expect(w.find('.mj__hand-hint').exists()).toBe(false);
    await w.setProps({ view: view() });
    await nextTick();
    expect(w.find('.mj__hand-tile--lack-blocked').exists()).toBe(false);
  });

  it('D11 版本错配：先选非缺门牌，再收到 mustDiscardSuit ⇒ 清选择、出牌禁用', async () => {
    const w = mount(MahjongBoard, { props: props({ view: view() }) });
    await tileByLabel(w, '筒6').trigger('click');
    expect(w.findAll('.mj-tile--selected')).toHaveLength(1);
    await w.setProps({ view: mustView({ hand: view().hand }) });
    await nextTick();
    expect(w.findAll('.mj-tile--selected')).toHaveLength(0);
    expect(w.find('.mj-action-bar__btn--discard').attributes('disabled')).toBeDefined();
  });

  it('非我的回合 / 字段 null：无提示、无置灰', () => {
    const w = mount(MahjongBoard, {
      props: props({ view: mustView({ currentPlayer: 1, activeSeats: [1] }) }),
    });
    expect(w.find('.mj-hub__hint').text()).toBe('等待出牌');
    expect(w.find('.mj__hand-tile--lack-blocked').exists()).toBe(false);
    const w2 = mount(MahjongBoard, { props: props({ view: view() }) });
    expect(w2.find('.mj__hand-tile--lack-blocked').exists()).toBe(false);
  });
});
```

Run: `pnpm -C apps/client exec vitest run test/mahjong-board.test.ts`
Expected: FAIL（无字段/无提示）。

- [x] **Step 2: 实现 Board**

2.1 computed：
```ts
const mustDiscardSuit = computed(() =>
  phase.value === 'play' && amActive.value ? props.view?.mustDiscardSuit ?? null : null,
);
const mustDiscardName = computed(() =>
  mustDiscardSuit.value === null ? '' : MAHJONG_SUIT_NAMES[mustDiscardSuit.value],
);
```
**声明位置（防 TDZ）**：这两条 computed 必须紧跟现有的 `amActive`（Board:110-114）声明；所有 `watch(mustDiscardSuit, ...)` / `watch(handSelectable, ...)` 必须声明在它们之后（`watch` 注册时会立即求值 source，早于 computed 声明会 `ReferenceError` 崩组件）。

2.2 `statusText` play 分支：
```ts
return amActive.value
  ? mustDiscardSuit.value !== null
    ? `先打缺门${mustDiscardName.value}`
    : '请出牌'
  : '等待出牌';
```

2.3 手牌 helper：
```ts
function isLackFirst(entry: HandEntry): boolean {
  return mustDiscardSuit.value !== null && entry.tile.s === mustDiscardSuit.value;
}
function isLackBlocked(entry: HandEntry): boolean {
  return mustDiscardSuit.value !== null && entry.tile.s !== mustDiscardSuit.value;
}
```
`handTileBind` 的 class 加：
```ts
'mj__hand-tile--lack-first': isLackFirst(entry),
'mj__hand-tile--lack-blocked': isLackBlocked(entry),
```
摸牌位包裹层 `:class` 加 `'mj__hand-drawn--blocked': isLackBlocked(entry)`。

2.4 `onTileClick`（`handSelectable` 早退之后、`emit('select')` 之前）：
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
（`lackBlockedHint` 用 `ref(false)`。）

2.5 清零：
- 现有 `watch(phase, () => { handHintIndex.value = null; })` 加 `lackBlockedHint.value = false;`
- 新增 `watch(handSelectable, () => { lackBlockedHint.value = false; });`
- 现有手牌内容 watch（`hand.value.map(tileType).join(',')`）里加 `lackBlockedHint.value = false;`
- 新增：
```ts
watch(mustDiscardSuit, (suit) => {
  if (suit !== null && selected.value.some((i) => displayTiles.value[i]?.tile.s !== suit)) {
    selected.value = [];
    lastClickIndex.value = -1;
  }
  lackBlockedHint.value = false;
});
```

2.6 模板提示分支（替换现有「再点一次」块）：
```html
<view v-if="phase === 'play' && handSelectable && lackBlockedHint" class="mj__hand-hint">
  <text>先打完{{ mustDiscardName }}，才能出其它花色</text>
</view>
<view v-else-if="phase === 'play' && handSelectable && selected.length === 1" class="mj__hand-hint">
  <text>再点一次出牌（或点"出牌"按钮）</text>
</view>
```

2.7 样式：
```scss
.mj__hand :deep(.mj__hand-tile--lack-first) {
  outline: $ftl-hairline solid $ftl-color-mj-gold;
  outline-offset: 0;
}
.mj__hand :deep(.mj__hand-tile--lack-blocked) {
  opacity: .45;
}
.mj__hand-drawn--blocked .mj__hand-drawn-dot {
  opacity: .45;
}
```

Run: `pnpm -C apps/client exec vitest run test/mahjong-board.test.ts test/mahjong-hub.test.ts test/mahjong-action-bar.test.ts test/animations.test.ts test/ui-tokens.test.ts`
Expected: PASS。

- [x] **Step 3: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongBoard.vue apps/client/test/mahjong-board.test.ts
git commit -m "feat(mahjong): 缺门出牌引导（先打缺门提示 + 手牌置灰拦截）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 全量验证 + 交接

**Files:**
- Create: `docs/superpowers/plans/2026-11-13-mahjong-lack-first-hint-handoff.md`

- [ ] **Step 1: 全量验证**

```bash
pnpm -C packages/protocol test
pnpm -C packages/protocol lint
pnpm -C packages/protocol build
pnpm -C packages/game-service test
pnpm -C packages/game-service lint
pnpm -C tools/conformance test
pnpm -C tools/conformance build
pnpm -C tools/conformance lint
pnpm -C packages/api-gateway test
pnpm -C apps/client test
pnpm -C apps/client lint
pnpm -C apps/client build
```
Expected: 全绿。

- [ ] **Step 2: 真机/真栈（条件执行）**

- conformance slice-36（需重建 game-service 镜像 + 真栈）：部署阶段或本机栈可用时跑 `pnpm -C tools/conformance conformance:slice-36-mahjong`（脚本全名；需先 build）；断言 `mustDiscardSuit` oracle + `mustDiscardSeen > 0`。
- 真浏览器/真机：进入一局，定缺后确认「先打缺门X」、缺门牌金边、非缺门牌置灰、点击被拦提示；无法执行则交接登记「未验证（原因）」。

- [ ] **Step 3: 交接**

`docs/superpowers/plans/2026-11-13-mahjong-lack-first-hint-handoff.md`：
- 状态：v18 已实现（Task 1–3 提交 + 本 Task）；全量结果数字；**未推送/未部署/未重打 APK**；版本 0.1.12/112（是否 bump 由用户裁决）。
- 改动：协议字段/validator、服务端视图、客户端提示/置灰/拦截、conformance oracle。
- 审查：spec §8（5 高 + 9 低已修）；计划审查记录；真栈/真机结果或未验证说明。
- 回滚：按 Task 提交 revert；部署回滚点仍 `dev-e10ed4b`。
- 下一步（用户裁决）：推送 dev → 部署测试服（镜像重建，game-service 变更）→ 重打 APK（客户端引导）→ 真机走查。
- 已知取舍：只做缺门出牌引导；同族 13001 文案另立片（D13）；H5 随部署生效、APK 需重打。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-11-13-mahjong-lack-first-hint-handoff.md
git commit -m "docs(mahjong): v18 缺门出牌引导实现交接" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- Spec coverage：D1–D14 全部有落点（协议/validator、服务端按查看者、客户端提示/置灰/拦截/清零/D11、conformance、交付）。
- Type consistency：`mustDiscardSuit` 在协议/服务端/客户端/测试同名；`HandEntry`/`isLackFirst`/`isLackBlocked` 与 v17 的 `handTileBind` 一致。
- Placeholder scan：无 TBD/TODO；关键代码/断言给全。
- 已知风险：客户端提示依赖服务端字段；validator 语义不变式 + conformance oracle 兜底。

## 计划审查记录

2026-11-13 按 `docs/dev-process.md` §5 做独立对抗计划审查（sonnet，只读）：核对了 Task 1 的协议类型/validator 插入点与测试类型（`validateOutbound(msg: unknown)` 无上下文类型；`MahjongSuit` 仅由 `tile.ts` 导出）、Task 2 的 `advanceToPlay` 与既有用例同形、`buildView` 返回 `GameView` 需 `as MahjongPlayerView`、`hasLackTiles/canDiscard` 由 shared barrel 导出、跨座位断言能区分查看者/currentPlayer、driver oracle 与 slice-36、Task 3 的 `statusText`/`handTileBind`/`onTileClick`/模板分支/清零 watch 与 Board 现有行为及既有用例。

结论：**3 阻断 + 2 高 + 9 低**，均已修订：
- 阻断：① 新测试引用的 `筒8` 不在 `view()` 夹具（改为 `筒6`，保持 13 张）；② 摸牌位用例必须以 13→14 `setProps` 构造（挂载即 14 张不会产生 `drawnType`/`.mj__hand-drawn`）；③「非我的回合」必须同时把 `activeSeats` 设为 `[1]`（`amActive` 只认 `activeSeats`）。
- 高：① 基础 `view()` 不得加非 null 默认值（会打红 3 个既有摸牌位用例）⇒ 明写「非 null 一律走 mustView()」；② `mustDiscardSuit` computed 与 watch 的声明顺序钉死（防 setup 期 TDZ）。
- 低：`MahjongSuit` 从 `./tile` 导入；conformance 脚本全名 `conformance:slice-36-mahjong`；四条 commit 命令补 attribution 尾行；清零用例补 `handSelectable` 翻转与手牌内容变化；finalViews 断言改为 `mustDiscardSeen > 0` 计数；driver `assertMustDiscard` 导出 + 单测；服务端补未定缺/all-phases/validateOutbound；view 复用 `mustClearLack`；Task 4 加 api-gateway test。
