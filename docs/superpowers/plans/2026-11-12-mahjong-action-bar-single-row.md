# 川麻红金 v17：动作区单行化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把麻将动作区从 176×176 的 2×2 网格改成贴右下、高 64 的单行动作带（play/claim/exchange/lack 四模式），保持红金皮肤与全部交互。

**Architecture:** 纯客户端展示层。`MahjongActionBar.vue` 去掉中间 grid，根即单行 flex；按钮宽度按模式+数量；Board 用 `layout.actions` 的右/底锚点定位。协议/服务端/布局代码不动（仅加一条布局守护测试与注释）。

**Tech Stack:** uni-app / Vue 3 + TypeScript / Vitest / SCSS（`$ftl-*` 令牌）。

## Global Constraints

- 只改客户端展示层；不改协议/服务端/数据库/admin；不改 `mahjong-layout-v3.ts` 的几何代码（仅注释）。
- 条：右缘 = `actions.right`、底边 = `actions.bottom`、高 64；gap 6；最大宽 **218**（claim-4）。
- 宽度：play 1→176/2→102/3→66（4 防御 50）；claim 1→102/2→102/3→66/≥4→50；lack 66；exchange 140。
- 主字 **24px**（皮肤测试钉死）；副字 `$ftl-font-xs`（22px）；按钮 `line-height: 1`。
- 布局尺寸（条宽/高/gap）一律 `calc(Npx * var(--mj-u, 1))`；内容细节（按钮内 gap 2、border-radius、发丝边）保持 px（生产 u≡1）；根宽由组件显式给出（`rowW = n×w + (n−1)×6`）。
- claim 胡带 tile：**20×30 牌面在上 + 「胡」**；play 胡不渲染牌面。
- 多杠：「杠」+ 下方小数字；面板绝对定位在条上方（宽 218、显式 2 列、项高 48）。
- exchange：单按钮「换三张」+ 副字「已选 x/3」。
- 保留皮肤/动画/禁用/emit；不动 reduced-motion 清单（无新动画）。
- 每个 Task 先写失败测试，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 本片不推送/不部署/不重打 APK；版本保持 0.1.12/112（如需另起由用户裁决）。

---

## Task 1: 单行动作带（组件 + Board 接线 + 测试 + 布局守护）

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongActionBar.vue`（整文件重写）
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`（`actionBarStyle` + 模板）
- Modify: `apps/client/test/mahjong-action-bar.test.ts`（整文件重写）
- Modify: `apps/client/test/mahjong-board.test.ts`（动作区断言迁移）
- Modify: `apps/client/test/mahjong-layout-v3.test.ts`（新增 218 守护用例）
- Modify: `apps/client/src/game/mahjong-layout-v3.ts`（仅 token 区注释）

**Interfaces:**
- Consumes: `ActionBarMode` / `ActionBarAction` / props 不变。
- Produces: 单行根 DOM（`.mj-action-bar`，直接子按钮）、`.mj-action-bar__sub` 副字、`.mj-action-bar__gang-selector` 绝对面板；Board `actionBarStyle`（right/bottom/z-index 3）。

- [x] **Step 1: 重写 `apps/client/test/mahjong-action-bar.test.ts`（失败测试）**

完整文件：

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongClaimOption } from '@fight-the-landlord/protocol';
import MahjongActionBar from '../src/components/table/mahjong/MahjongActionBar.vue';

const tile = (s: 0 | 1 | 2, r: number) => ({ s, r });
const peng = { claim: 'peng', tile: tile(0, 5) } as MahjongClaimOption;
const gang3 = { claim: 'gang', tile: tile(0, 3) } as MahjongClaimOption;
const gang7 = { claim: 'gang', tile: tile(0, 7) } as MahjongClaimOption;
const hu5 = { claim: 'hu', tile: tile(0, 5) } as MahjongClaimOption;
const pass = { claim: 'pass' } as MahjongClaimOption;

const baseProps = {
  mode: 'claim' as 'play' | 'claim' | 'exchange' | 'lack',
  options: [] as MahjongClaimOption[],
  showPass: false,
  busy: false,
  selectedCount: 0,
  recommendedSuit: null as 0 | 1 | 2 | null,
};

function mountBar(over: Partial<typeof baseProps> = {}) {
  return mount(MahjongActionBar, { props: { ...baseProps, ...over } });
}

function btnStyle(b: { attributes(name: string): string | undefined }): string {
  return b.attributes('style') ?? '';
}

const barSrc = readFileSync('src/components/table/mahjong/MahjongActionBar.vue', 'utf8');
const barStyle = [...barSrc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1] ?? '')
  .join('\n');

/** 取一条选择器规则的声明体（本文件的这些规则没有嵌套块）。 */
function barRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(barStyle);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

describe('MahjongActionBar（v17 单行）', () => {
  it('claim 4 键：一行 50×64，gap 6，根宽 218；无 grid', () => {
    const w = mountBar({ mode: 'claim', options: [peng, gang3, hu5, pass], showPass: true });
    const buttons = w.findAll('.mj-action-bar__btn');
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      const s = btnStyle(b);
      expect(s).toContain('width: calc(50px * var(--mj-u, 1))');
      expect(s).toContain('height: calc(64px * var(--mj-u, 1))');
      expect(s).not.toContain('grid-column');
      expect(s).not.toContain('grid-row');
    }
    const root = w.find('.mj-action-bar');
    expect(root.attributes('style')).toContain('width: calc(218px * var(--mj-u, 1))');
    expect(barStyle).toContain('gap: calc(6px * var(--mj-u, 1))');
    expect(barSrc).not.toMatch(/grid-template|gridTemplate/);
    expect(barStyle).not.toMatch(/display:\s*grid/);
  });

  it('play：1/2/3 键宽度 176/102/66，根宽 176/210/210，出牌最右', () => {
    const one = mountBar({ mode: 'play', selectedCount: 1 });
    expect(one.findAll('.mj-action-bar__btn')).toHaveLength(1);
    expect(btnStyle(one.find('.mj-action-bar__btn'))).toContain('width: calc(176px * var(--mj-u, 1))');
    expect(one.find('.mj-action-bar__btn').text()).toBe('出牌');
    expect(one.find('.mj-action-bar').attributes('style')).toContain('width: calc(176px * var(--mj-u, 1))');

    const two = mountBar({ mode: 'play', options: [hu5], selectedCount: 1 });
    const twoBtns = two.findAll('.mj-action-bar__btn');
    expect(twoBtns).toHaveLength(2);
    for (const b of twoBtns) expect(btnStyle(b)).toContain('width: calc(102px * var(--mj-u, 1))');
    expect(twoBtns.map((b) => b.text())).toEqual(['胡', '出牌']);
    expect(two.find('.mj-action-bar').attributes('style')).toContain('width: calc(210px * var(--mj-u, 1))');

    const three = mountBar({ mode: 'play', options: [hu5, gang3], selectedCount: 1 });
    const threeBtns = three.findAll('.mj-action-bar__btn');
    expect(threeBtns).toHaveLength(3);
    for (const b of threeBtns) expect(btnStyle(b)).toContain('width: calc(66px * var(--mj-u, 1))');
    expect(threeBtns.map((b) => b.text())).toEqual(['胡', '杠', '出牌']);
    expect(three.find('.mj-action-bar').attributes('style')).toContain('width: calc(210px * var(--mj-u, 1))');
  });

  it('claim：1/2/3/4 键宽度 102/102/66/50；过固定在最后', () => {
    const cases: Array<[number, number, MahjongClaimOption[], boolean]> = [
      [1, 102, [hu5], false],
      [2, 102, [hu5], true],
      [3, 66, [peng, hu5], true],
      [4, 50, [peng, gang3, hu5], true],
    ];
    for (const [count, width, options, showPass] of cases) {
      const w = mountBar({ mode: 'claim', options, showPass });
      const buttons = w.findAll('.mj-action-bar__btn');
      expect(buttons, `count ${count}`).toHaveLength(count);
      for (const b of buttons) {
        expect(btnStyle(b), `count ${count}`).toContain(`width: calc(${width}px * var(--mj-u, 1))`);
      }
      if (showPass) expect(buttons.at(-1)!.text()).toBe('过');
      const rootW = count === 1 ? 102 : count === 2 || count === 3 ? 210 : 218;
      expect(w.find('.mj-action-bar').attributes('style'), `count ${count} root`)
        .toContain(`width: calc(${rootW}px * var(--mj-u, 1))`);
    }
  });

  it('claim 胡带 20×30 牌面 + 文本「胡」（不是「胡 5万」）；play 胡不带牌面', () => {
    const claim = mountBar({ mode: 'claim', options: [hu5], showPass: false });
    const huBtn = claim.find('.mj-action-bar__btn');
    expect(huBtn.text()).toBe('胡');
    expect(huBtn.text()).not.toContain('5万');
    const img = huBtn.find('image');
    expect(img.exists()).toBe(true);
    expect(img.attributes('style')).toContain('width: 20px');
    expect(img.attributes('style')).toContain('height: 30px');
    expect(img.attributes('aria-label')).toBe('万5');

    const noTile = mountBar({ mode: 'claim', options: [{ claim: 'hu' } as MahjongClaimOption] });
    expect(noTile.find('.mj-action-bar__btn').text()).toBe('胡');
    expect(noTile.find('.mj-action-bar__btn').find('image').exists()).toBe(false);

    const play = mountBar({ mode: 'play', options: [hu5], selectedCount: 1 });
    expect(play.findAll('.mj-action-bar__btn').find((b) => b.text() === '胡')!.find('image').exists()).toBe(false);
  });

  it('多杠：单杠纯「杠」；多杠「杠」+ 数字；面板在条上方、2 列、不占行', async () => {
    const sole = mountBar({ mode: 'play', options: [gang3], selectedCount: 1 });
    expect(sole.findAll('.mj-action-bar__btn').find((b) => b.text() === '杠')).toBeDefined();

    const multi = mountBar({ mode: 'play', options: [gang3, gang7], selectedCount: 1 });
    const gangBtn = multi.findAll('.mj-action-bar__btn').find((b) => b.text().includes('杠'))!;
    expect(gangBtn.text()).toContain('杠');
    expect(gangBtn.text()).toContain('2');
    expect(gangBtn.find('.mj-action-bar__sub').exists()).toBe(true);

    await gangBtn.trigger('click');
    const panel = multi.find('.mj-action-bar__gang-selector');
    expect(panel.exists()).toBe(true);
    const ps = panel.attributes('style') ?? '';
    expect(ps).toContain('position: absolute');
    expect(ps).toContain('bottom: calc(100% + 8px * var(--mj-u, 1))');
    expect(ps).toContain('width: calc(218px * var(--mj-u, 1))');
    expect(ps).toContain('flex-wrap: wrap');
    // 面板是根的直接子元素（不占行）
    expect(panel.element.parentElement?.classList.contains('mj-action-bar')).toBe(true);
    const items = panel.findAll('.mj-action-bar__gang-item');
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.attributes('style')).toContain('flex: 0 0 calc(50% - 3px * var(--mj-u, 1))');
    }
  });

  it('exchange：单按钮「换三张」+ 副字「已选 x/3」，宽 140', () => {
    const w = mountBar({ mode: 'exchange', selectedCount: 2 });
    const btn = w.find('.mj-action-bar__btn');
    expect(btn.text()).toContain('换三张');
    expect(btn.text()).toContain('已选 2/3');
    expect(btn.find('.mj-action-bar__sub').exists()).toBe(true);
    expect(btnStyle(btn)).toContain('width: calc(140px * var(--mj-u, 1))');
    expect(w.find('.mj-action-bar').attributes('style')).toContain('width: calc(140px * var(--mj-u, 1))');
  });

  it('lack：3×66 + 推荐副字 + 根宽 210；点击 emit；busy 禁用', async () => {
    const w = mountBar({ mode: 'lack', recommendedSuit: 1 });
    const buttons = w.findAll('.mj-action-bar__btn');
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(btnStyle(b)).toContain('width: calc(66px * var(--mj-u, 1))');
    expect(w.find('.mj-action-bar').attributes('style')).toContain('width: calc(210px * var(--mj-u, 1))');
    expect(buttons[1]!.find('.mj-action-bar__rec').text()).toBe('推荐');
    await buttons[0]!.trigger('click');
    expect(w.emitted('action')?.[0]?.[0]).toEqual({ kind: 'lack', suit: 0 });

    const busy = mountBar({ mode: 'lack', busy: true });
    for (const b of busy.findAll('.mj-action-bar__btn')) expect(b.attributes('disabled')).toBeDefined();
  });

  it('claim 呼吸只在 claim；禁用态/emit 不变', async () => {
    const claim = mountBar({ mode: 'claim', options: [peng], showPass: true });
    expect(claim.findAll('.anim-claim-pulse')).toHaveLength(2);
    const play = mountBar({ mode: 'play', selectedCount: 1 });
    expect(play.findAll('.anim-claim-pulse')).toHaveLength(0);

    const busy = mountBar({ mode: 'claim', options: [peng], showPass: true, busy: true });
    for (const b of busy.findAll('.mj-action-bar__btn')) expect(b.attributes('disabled')).toBeDefined();

    const w = mountBar({ mode: 'claim', options: [peng], showPass: true });
    await w.findAll('.mj-action-bar__btn')[0]!.trigger('click');
    await w.findAll('.mj-action-bar__btn')[1]!.trigger('click');
    expect(w.emitted('action')).toEqual([[{ kind: 'claim', option: peng }], [{ kind: 'pass' }]]);
  });

  it('源码闸：按钮 line-height 1；无裸 1px / em / rem / vw / vh / pt；动画 import 保留', () => {
    expect(barRule('.mj-action-bar__btn')).toMatch(/line-height:\s*1\s*;/);
    expect(barSrc).not.toMatch(/(?:^|[^\d])1px\b/);
    expect(barStyle).not.toMatch(/\b(?:em|rem|vw|vh|pt)\b/);
    expect(barStyle).toMatch(/@import\s+['"][^'"]*styles\/animations\.scss['"]/);
    expect(barSrc).toContain('anim-action-slide-in');
    expect(barSrc).toContain('anim-claim-pulse');
  });
});

// 红金皮肤（2026-11-08 Task 3）：v17 只改布局，皮肤与动画断言原样保留。
describe('MahjongActionBar：红金皮肤（Task 3）', () => {
  it('按钮：漆底 / 金棕发丝边 / 12px 圆角 / 24px cream / 3D 阴影', () => {
    const body = barRule('.mj-action-bar__btn');
    expect(body).toContain('background: rgba($ftl-color-mj-lacquer, .92)');
    expect(body).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(body).toContain('border-radius: 12px');
    expect(body).toContain('color: $ftl-color-mj-cream');
    expect(body).toContain('font-size: 24px');
    expect(body).toContain('font-weight: 700');
    expect(body).toContain('box-shadow: 0 4px 0 $ftl-color-mj-border');
    expect(body).not.toMatch(/rgba\(40, 76, 51|rgba\(23, 50, 33/);
  });

  it('主按钮：status→gold 渐变 + ink 字 + edge 描边', () => {
    const body = barRule('.mj-action-bar__btn--primary');
    expect(body).toContain('background: linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold)');
    expect(body).toContain('color: $ftl-color-mj-ink');
    expect(body).toContain('border-color: $ftl-color-mj-edge');
  });

  it('过 / 幽灵：muted 字 + 半透明漆底', () => {
    const body = barRule('.mj-action-bar__btn--pass');
    expect(body).toContain('$ftl-color-mj-muted');
    expect(body).toContain('rgba($ftl-color-mj-lacquer');
  });

  it('多杠选择器项：漆底金边（绿色渐变已删）', () => {
    const body = barRule('.mj-action-bar__gang-item');
    expect(body).toContain('rgba($ftl-color-mj-lacquer');
    expect(body).toContain('$ftl-color-mj-gold');
    expect(body).not.toMatch(/rgba\(60, 110, 75|rgba\(35, 75, 50/);
  });

  it('推荐缺：金色描边（recommended 保留）', () => {
    const body = barRule('.mj-action-bar__btn--recommended');
    expect(body).toContain('$ftl-color-mj-gold');
  });

  it('推荐缺：金环与 3D 底边合并（不丢 `0 4px 0` 的立体感）', () => {
    const body = barRule('.mj-action-bar__btn--recommended');
    expect(body).toContain('rgba($ftl-color-mj-gold, .5)');
    expect(body).toContain('0 4px 0 $ftl-color-mj-border');
  });

  it('根挂 anim-action-slide-in（入场滑入）', () => {
    const w = mountBar();
    expect(w.find('.mj-action-bar').classes()).toContain('anim-action-slide-in');
  });
});
```

Run: `pnpm -C apps/client exec vitest run test/mahjong-action-bar.test.ts`
Expected: FAIL（旧 2×2/84/176 结构）。

- [x] **Step 2: 整文件替换 `apps/client/src/components/table/mahjong/MahjongActionBar.vue`**

```vue
<script lang="ts">
/**
 * 动作区对外契约（Task 7）。类型放普通 `<script>` 里才能 `export`。
 */
import type { MahjongClaimOption, MahjongSuit } from '@fight-the-landlord/protocol';

export type ActionBarMode = 'play' | 'claim' | 'exchange' | 'lack';

export type ActionBarAction =
  | { kind: 'claim'; option: MahjongClaimOption }
  | { kind: 'pass' }
  | { kind: 'discard' }
  | { kind: 'exchange' }
  | { kind: 'lack'; suit: MahjongSuit };
</script>

<script setup lang="ts">
/**
 * 麻将动作区（哑组件）：v17 单行动作带。
 *
 * - play：胡 / 杠 / 过 / 出牌（出牌最右）；多杠合并为「杠」+ 副字数字 + 上方选择面板。
 * - claim：选项顺序（碰/杠/胡）+ 过最右；胡按钮把 20×30 待响应牌放在「胡」上方（仅 claim）。
 * - exchange：单按钮「换三张」+ 副字「已选 x/3」。
 * - lack：万/筒/条。
 * - 尺寸：高 64、gap 6；宽度按模式+数量（最大根宽 218）；全部 calc(px * var(--mj-u, 1))。
 * - 主字 24px（皮肤固定），副字 $ftl-font-xs；按钮 line-height: 1（牌面 + 文本的 64 高预算）。
 * - 只渲染 props、只 emit action；不判规则/不取数/不造计时器。
 */
import { computed, ref, watch } from 'vue';
import { MAHJONG_SUIT_NAMES } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

const props = withDefaults(defineProps<{
  mode: ActionBarMode;
  options?: MahjongClaimOption[];
  showPass?: boolean;
  busy?: boolean;
  selectedCount?: number;
  recommendedSuit?: MahjongSuit | null;
}>(), {
  options: () => [],
  showPass: false,
  busy: false,
  selectedCount: 0,
  recommendedSuit: null,
});

const emit = defineEmits<{
  (e: 'action', action: ActionBarAction): void;
}>();

const claimOptions = computed(() => props.options.filter((o) => o.claim !== 'pass'));
const huOption = computed(() => claimOptions.value.find((o) => o.claim === 'hu') ?? null);
const gangOptions = computed(() => claimOptions.value.filter((o) => o.claim === 'gang'));
const SUITS: readonly MahjongSuit[] = [0, 1, 2];

const gangOpen = ref(false);
watch(() => props.options, () => {
  gangOpen.value = false;
});

/** 当前行渲染的按钮数（决定宽度）。 */
const buttonCount = computed(() => {
  if (props.mode === 'claim') return claimOptions.value.length + (props.showPass ? 1 : 0);
  if (props.mode === 'play') {
    return (
      1 +
      (huOption.value ? 1 : 0) +
      (gangOptions.value.length > 0 ? 1 : 0) +
      (props.showPass ? 1 : 0)
    );
  }
  if (props.mode === 'lack') return 3;
  return 1;
});

/** D3：按模式+数量给单键宽度（px，未乘 u）。 */
function widthFor(mode: ActionBarMode, count: number): number {
  if (mode === 'exchange') return 140;
  if (mode === 'lack') return 66;
  if (mode === 'claim') {
    if (count <= 2) return 102;
    if (count === 3) return 66;
    return 50;
  }
  if (count <= 1) return 176;
  if (count === 2) return 102;
  if (count === 3) return 66;
  return 50;
}

const n = computed(() => Math.max(1, Math.min(4, buttonCount.value)));
// n>4 只保护宽度表（钳到 4），不防按钮溢出；服务端可达上限 4（play 3）。
const btnW = computed(() => widthFor(props.mode, n.value));
const rowW = computed(() => n.value * btnW.value + (n.value - 1) * 6);

const px = (v: number) => `calc(${v}px * var(--mj-u, 1))`;
const btnStyle = computed(() => ({ width: px(btnW.value), height: px(64) }));
const barStyle = computed(() => ({ width: px(rowW.value) }));
const selectorStyle = {
  position: 'absolute',
  right: '0',
  bottom: 'calc(100% + 8px * var(--mj-u, 1))',
  width: 'calc(218px * var(--mj-u, 1))',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'calc(6px * var(--mj-u, 1))',
} as const;
const selectorItemStyle = {
  flex: '0 0 calc(50% - 3px * var(--mj-u, 1))',
  height: 'calc(48px * var(--mj-u, 1))',
} as const;

function emitAction(action: ActionBarAction): void {
  emit('action', action);
}

function emitClaim(option: MahjongClaimOption): void {
  emit('action', { kind: 'claim', option });
}

/** claim 文案：胡/杠/碰；胡的牌面由 20×30 图片表达，不再写「胡 5万」。 */
function claimLabel(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return '胡';
  if (opt.claim === 'gang') return '杠';
  return '碰';
}

/** 多杠选择器行文案：牌型（如 `5万`）。 */
function gangLabel(opt: MahjongClaimOption): string {
  return opt.tile ? `${opt.tile.r}${MAHJONG_SUIT_NAMES[opt.tile.s]}` : '杠';
}

function pickHu(): void {
  if (huOption.value) emitClaim(huOption.value);
}

function pickSoleGang(): void {
  const only = gangOptions.value[0];
  if (only) emitClaim(only);
}

function toggleGang(): void {
  gangOpen.value = !gangOpen.value;
}

function pickGang(opt: MahjongClaimOption): void {
  gangOpen.value = false;
  emitClaim(opt);
}
</script>

<template>
  <view class="mj-action-bar anim-action-slide-in" :style="barStyle">
    <template v-if="mode === 'play'">
      <button
        v-if="huOption"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--hu"
        :style="btnStyle"
        :disabled="busy"
        @click="pickHu"
      >胡</button>
      <button
        v-if="gangOptions.length === 1"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--gang"
        :style="btnStyle"
        :disabled="busy"
        @click="pickSoleGang"
      >杠</button>
      <button
        v-else-if="gangOptions.length > 1"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--gang"
        :style="btnStyle"
        :disabled="busy"
        @click="toggleGang"
      >
        杠
        <text class="mj-action-bar__sub">{{ gangOptions.length }}</text>
      </button>
      <button
        v-if="showPass"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--pass"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'pass' })"
      >过</button>
      <button
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--discard"
        :style="btnStyle"
        :disabled="busy || selectedCount !== 1"
        @click="emitAction({ kind: 'discard' })"
      >出牌</button>
    </template>

    <template v-else-if="mode === 'claim'">
      <button
        v-for="(opt, i) in claimOptions"
        :key="i"
        type="button"
        class="mj-action-bar__btn anim-claim-pulse"
        :class="{
          'mj-action-bar__btn--primary': opt.claim === 'hu',
          'mj-action-bar__btn--gang': opt.claim === 'gang',
        }"
        :style="btnStyle"
        :disabled="busy"
        @click="emitClaim(opt)"
      >
        <MahjongTile
          v-if="opt.claim === 'hu' && opt.tile"
          :tile="opt.tile"
          direction="my"
          :w="20"
          :h="30"
        />
        {{ claimLabel(opt) }}
      </button>
      <button
        v-if="showPass"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--pass anim-claim-pulse"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'pass' })"
      >过</button>
    </template>

    <template v-else-if="mode === 'exchange'">
      <button
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--exchange"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'exchange' })"
      >
        换三张
        <text class="mj-action-bar__sub">已选 {{ selectedCount }}/3</text>
      </button>
    </template>

    <template v-else>
      <button
        v-for="suit in SUITS"
        :key="suit"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--lack"
        :class="{ 'mj-action-bar__btn--recommended': recommendedSuit === suit }"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'lack', suit })"
      >
        {{ MAHJONG_SUIT_NAMES[suit] }}
        <text v-if="recommendedSuit === suit" class="mj-action-bar__rec">推荐</text>
      </button>
    </template>

    <view
      v-if="mode === 'play' && gangOpen && gangOptions.length > 1"
      class="mj-action-bar__gang-selector"
      :style="selectorStyle"
    >
      <button
        v-for="(opt, i) in gangOptions"
        :key="i"
        type="button"
        class="mj-action-bar__gang-item"
        :style="selectorItemStyle"
        :disabled="busy"
        @click="pickGang(opt)"
      >
        {{ gangLabel(opt) }}
      </button>
    </view>
  </view>
</template>

<style scoped lang="scss">
// claim 呼吸 / 滑入动画的类与 keyframes 都在 animations.scss（scoped 会重命名 @keyframes ⇒ 必须导入）。
@import '../../../styles/animations.scss';

.mj-action-bar {
  display: flex;
  align-items: stretch;
  gap: calc(6px * var(--mj-u, 1));
  height: calc(64px * var(--mj-u, 1));
}

// 红金皮肤（v4 §4.6）：漆底 / 金棕发丝边 / 12px 圆角 / 24px cream / 3D 阴影。
.mj-action-bar__btn {
  @include ftl-btn;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 0;
  padding: 0;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 12px;
  background: rgba($ftl-color-mj-lacquer, .92);
  color: $ftl-color-mj-cream;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 4px 0 $ftl-color-mj-border;
}

.mj-action-bar__btn--primary {
  border-color: $ftl-color-mj-edge;
  background: linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold);
  color: $ftl-color-mj-ink;
}

.mj-action-bar__btn--gang {
  border-color: rgba($ftl-color-mj-gold, .75);
  color: $ftl-color-mj-gold-light;
}

.mj-action-bar__btn--pass {
  border-color: rgba($ftl-color-mj-muted, .5);
  background: rgba($ftl-color-mj-lacquer, .6);
  color: $ftl-color-mj-muted;
}

.mj-action-bar__btn--recommended {
  border-color: $ftl-color-mj-gold;
  box-shadow: 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, .5), 0 4px 0 $ftl-color-mj-border;
}

.mj-action-bar__rec {
  display: block;
  font-size: $ftl-font-xs;
  font-weight: 400;
  line-height: 1;
  color: $ftl-color-mj-gold-light;
}

.mj-action-bar__sub {
  display: block;
  font-size: $ftl-font-xs;
  font-weight: 400;
  line-height: 1;
  color: inherit;
  opacity: .85;
}

.mj-action-bar__gang-selector {
  z-index: 1;
}

// 多杠选择器项（红金皮肤）：漆底金边。
.mj-action-bar__gang-item {
  @include ftl-btn;
  min-height: 0;
  height: 48px;
  padding: 0 $ftl-space-4;
  border: $ftl-hairline solid rgba($ftl-color-mj-gold, .7);
  border-radius: 12px;
  background: rgba($ftl-color-mj-lacquer, .92);
  color: $ftl-color-mj-cream;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1;
}

.mj-action-bar__btn[disabled],
.mj-action-bar__gang-item[disabled] {
  opacity: 0.5;
}
</style>
```

- [x] **Step 3: 跑 action-bar 测试确认 GREEN**

Run: `pnpm -C apps/client exec vitest run test/mahjong-action-bar.test.ts`
Expected: PASS。

- [x] **Step 4: Board 接线 + 迁移 board 测试**

4.1 `MahjongBoard.vue`：替换 `actionsStyle`（**必须 round2 + 用 sanitize 后的画布尺寸**，否则 `right` 会渲染成长浮点串）：
```ts
const round2 = (v: number) => Math.round(v * 100) / 100;
const canvasW = computed(() =>
  Number.isFinite(canvas.value.width) && canvas.value.width > 0 ? canvas.value.width : 1334,
);
/** v17：动作带贴旧动作区右下角；高度/宽度由组件 calc(* u) 给出。 */
const actionBarStyle = computed(() => {
  const a = layout.value.actions;
  return {
    position: 'absolute' as const,
    right: `${round2(canvasW.value - (a.left + a.width))}px`,
    bottom: `${round2(canvasH.value - (a.top + a.height))}px`,
    zIndex: 3,
  };
});
```
模板 `:style="actionBarStyle"`（原 `actionsStyle` 删除）。`canvasH` 已存在（`:92`）。

4.2 `mahjong-board.test.ts`：
- `buttonTexts(wrapper)` 两处 `['胡 5万']` → `['胡']`（约 :421、:437）。
- `buttonByText(wrapper, '换三张')` 两处（约 :157、:952）：D7 把「已选 x/3」并入按钮后文本是 `换三张已选 3/3`，精确匹配会红 ⇒ 改前缀查找：
```ts
const confirm = wrapper
  .findAll('.mj-action-bar button')
  .find((b) => b.text().startsWith('换三张'))!;
expect(confirm, '动作区按钮「换三张」').toBeDefined();
```
（:952 的点击同理：`await wrapper.findAll('.mj-action-bar button').find((b) => b.text().startsWith('换三张'))!.trigger('click');`）
- v3-only 锚点用例（约 :842-855）改：
```ts
const style = bar.attributes('style') ?? '';
expect(style).toContain('position: absolute');
expect(style).toContain('right: 50.34px');
expect(style).toContain('bottom: 136px');
expect(style).toContain('z-index: 3');
expect(style).not.toContain('left:');
expect(style).not.toContain('top:');
expect(style).not.toContain('width: 176px');
expect(style).not.toContain('height: 176px');
```
- 新增有副露态：
```ts
it('v17 动作带：有副露时右锚点 90.74px', () => {
  const wrapper = mount(MahjongBoard, {
    props: props({ view: view({ melds: [[], [], [], [PENG_5]] }) }),
  });
  const style = wrapper.findComponent(MahjongActionBar).attributes('style') ?? '';
  expect(style).toContain('right: 90.74px');
  expect(style).toContain('bottom: 136px');
});
```
（`PENG_5` 已在文件顶部定义。）

Run: `pnpm -C apps/client exec vitest run test/mahjong-action-bar.test.ts test/mahjong-board.test.ts`
Expected: PASS。

- [x] **Step 5: 布局 218 守护测试 + token 注释**

5.1 `mahjong-layout-v3.test.ts` 新增：
```ts
describe('v17 动作带几何守护（218 宽）', () => {
  it('最坏态：动作带左缘比右侧河右缘至少多 6px', () => {
    const l = mahjongTableLayoutV3(1334, 750, {
      bySlot: {
        top: { discards: 17, melds: [] },
        left: { discards: 0, melds: [] },
        right: { discards: 29, melds: [3, 3, 3, 3] },
        self: { discards: 17, melds: [] },
      },
      tingCount: 0,
    });
    const actionRight = l.actions.left + l.actions.width;
    const barLeft = actionRight - 218;
    const sideRiverRight = l.rivers.right.rect.left + l.rivers.right.rect.width;
    // fixture 自证是最坏态：动作区左缘、右河 2 列宽、19+N 窗口
    expect(l.actions.left).toBeCloseTo(1067.26, 2);
    expect(l.rivers.right.rect.width).toBe(114);
    expect(l.rivers.right.windowCount).toBe(19);
    expect(barLeft - sideRiverRight).toBeCloseTo(6.25, 1);
    expect(barLeft - sideRiverRight).toBeGreaterThanOrEqual(6);
    expect(l.actions.width).toBe(176);
  });
});
```
5.2 `mahjong-layout-v3.ts` token 区注释（不改代码）：
```ts
// v17：动作区可视条最大宽 218（4×50 + 3×6），由 MahjongActionBar 使用；
// 该条向左超出 actions 矩形（176）42px，布局 checks 不覆盖 ⇒ 改几何时必须重算
// mahjong-layout-v3.test.ts 的「v17 动作带几何守护」。
```

Run: `pnpm -C apps/client exec vitest run test/mahjong-action-bar.test.ts test/mahjong-board.test.ts test/mahjong-layout-v3.test.ts`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongActionBar.vue apps/client/src/components/table/mahjong/MahjongBoard.vue apps/client/test/mahjong-action-bar.test.ts apps/client/test/mahjong-board.test.ts apps/client/test/mahjong-layout-v3.test.ts apps/client/src/game/mahjong-layout-v3.ts
git commit -m "feat(mahjong): 动作区单行化（按模式自适应宽度）"
```

---

## Task 2: 全量验证 + 真浏览器对照 + 交接

**Files:**
- Create: `docs/superpowers/plans/2026-11-12-mahjong-action-bar-single-row-handoff.md`

- [ ] **Step 1: 全量验证**

Run（逐条，记录尾部与计数）：
```bash
pnpm -C apps/client test
pnpm -C apps/client lint
pnpm -C apps/client build
```
Expected: test 全绿；lint exit 0；build `DONE Build complete.`。

- [ ] **Step 2: 真浏览器对照（临时 Vite 挂真实 MahjongBoard）**

- 临时入口 `apps/client/v17-preview.html` + `apps/client/src/v17-preview.ts`（完成后删除，`git status` clean）。
- fixture 抄 `test/mahjong-board.test.ts` 的 `view()/props()`；`createApp({ render: () => h(MahjongBoard, boardProps) }).mount('#app')`。
- 场景（`?mode=`）：
  - `play3`：play、胡+杠+出牌（3 键）、选中 1 张；
  - `claim4`：claim、碰/杠/胡（带 20×30 牌面）/过（4 键）；
  - `claim4meld`：claim-4 + 左侧副露 + top/self ≥17（最坏几何态，条左缘距右河 ~6px）；
  - `exchange`：exchange、已选 2/3；
  - `lack`：lack、推荐筒；
  - `gang`：play 多杠；截图前在 preview 脚本里 `document.querySelector('.mj-action-bar__btn--gang')?.click()` 打开面板，再截「面板在条上方」。
- `pnpm -C apps/client exec vite --port 5179 --host 127.0.0.1` 后台；Chromium 1243 headless `--window-size=1334,750 --virtual-time-budget=4000`；截图存 `.superpowers/mahjong-redgold/v17-shots/`。
- 用 Read 对照：单行、宽度、出牌最右、claim-4 牌面+「胡」、exchange 副字、lack 推荐、面板在条上方且不遮侧河。
- 无法渲染则登记「真浏览器未验证（原因）」，不得声称通过。

- [ ] **Step 3: 写交接**

`docs/superpowers/plans/2026-11-12-mahjong-action-bar-single-row-handoff.md`：
- 状态：v17 已实现（Task 1 提交 + 本 Task；全量数字；未推送/未部署/未打 APK；版本 0.1.12/112）。
- 改动：ActionBar 单行（宽度表、24/22 字号、line-height 1、多杠面板）、Board `actionBarStyle`、布局守护测试与 token 注释。
- 审查：spec §9（1 阻断 + 4 高 + 10 低已修）；计划审查记录；真浏览器截图路径或未验证说明。
- 回滚：仅两组件 + 测试；`git revert`；部署回滚点仍 `dev-2ded548`。
- 下一步（需用户裁决）：推送 dev → 部署测试服 → 重打 APK → 真机走查（50px 键手感、claim-4 牌面、面板位置）。
- 已知取舍：6.25px 最坏态余量；主字 24 保持；claim 胡不再写牌名。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-11-12-mahjong-action-bar-single-row-handoff.md
git commit -m "docs(mahjong): v17 动作区单行化实现交接"
```

---

## Self-Review

- Spec coverage：D1–D12 全部有落点（宽度表/几何/面板/副字/line-height/布局守护/Bord 锚点/测试迁移）。
- Type consistency：`widthFor(mode,count)`、`btnW`、`rowW`、`actionBarStyle` 在组件/Board/测试同名；`mj-action-bar__sub` 在组件产出、测试消费。
- Placeholder scan：无 TBD/TODO；组件与测试代码完整。
- 已知风险：宽度/面板为字符串+算术断言，观感需 Task 2 真浏览器截图兜底。

## 计划审查记录

2026-11-12 按 `docs/dev-process.md` §5 做独立对抗审查（sonnet，只读）：核对了计划代码可编译性（`as MahjongClaimOption`、`Partial<typeof baseProps>`、`btnStyle` 对 VTU `DOMWrapper` 重载、`.at(-1)`、strict/noUnusedLocals，仓内 tsc 实测通过）、D3 宽度表与各模式 `buttonCount/widthFor/rowW`（claim-4=218、play 1/2/3=176/102/66、lack 210、exchange 140、claim 仅过 102）、jsdom 对 `calc(*var(--mj-u,1))` 内联样式的序列化、既有 mahjong-board/action-bar/skin/animations/ui-tokens 闸的冲突面、Board 右/底锚点与最坏态几何（复算 6.25px 余量、15.84px 纵向重叠带）、布局守护 fixture 与 Task 2 场景。

结论：**需修订计划**，已全部修订：
- 阻断：① `actionBarStyle` 对已四舍五入的 layout 值做减法会得到 `50.33999999999992` / `90.74000000000001` ⇒ 改为 Board 内 `round2` + sanitize 后的 `canvasW/canvasH`；② 迁移清单漏了 board 测试 `:157/:952` 的 `buttonByText('换三张')`（D7 后文本为「换三张已选 3/3」）⇒ 改为前缀查找。
- 高：整文件重写会删掉现有「红金皮肤（Task 3）」8 条断言与根滑入测试 ⇒ 新测试文件末尾原样保留该 describe（含 `barRule` 帮助函数）。
- 低：布局守护补 fixture 自证（actions.left 1067.26/右河宽 114/windowCount 19/余量 6.25）；grid 闸改 `grid-template|gridTemplate` + `display: grid`；line-height 断言改用规则体正则；根宽补 play/lack/exchange/claim 各数量断言；多杠面板加 `mode === 'play'` 守卫；画布尺寸 sanitize；Global Constraints 改为「布局尺寸 calc、内容细节 px（u≡1）」；n>4 钳位注释；Task 2 补 `claim4meld` 最坏态与面板点击方式；保留无 tile 胡、aria-label、lack busy 覆盖。

修订后可开工。
