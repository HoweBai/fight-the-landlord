# 川麻红金 v16：铜钱信息井 + 摸牌位/选中态区分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把中央信息井改成「铜钱」：中央方孔显示牌墙数量 + 操作提示，四扇形轮换显示倒计时/胡听缺托；把摸牌位从「抬升 + 金边」改为「不抬升 + 右上金点」，让抬升/金框只表示选中。

**Architecture:** 纯客户端展示层。`MahjongHub.vue` 重写为纯 props 的铜钱结构（160×160 设计 px，不再接收 `hub`/`compact`）；`MahjongBoard.vue` 负责把信息井定位/缩放到 `hub.cx/cy`，并把摸牌位包一层（`mj__hand-drawn`）承载金点。协议/服务端/布局几何不动。

**Tech Stack:** uni-app / Vue 3 + TypeScript / Vitest / SCSS（`$ftl-*` 令牌）。

## Global Constraints

- 只改客户端展示层；不改协议/服务端/数据库/admin；不改 `mahjong-layout-v3.ts` 与牌面/牌背素材。
- 信息井按 **160×160 设计 px** 渲染；Board `hubStyle` 必须含 `position:absolute`、`left = hub.cx - 80`、`top = hub.cy - 80`、`width/height: 160px`、`transform: scale(u)`、`transform-origin: center`。
- 方孔 66×66（**`box-sizing: border-box`**）；内容宽 62px；牌墙 30px；提示 10px、最多 5 字 + 省略号、`max-width: 100%`。
- 扇形：4 块 90°，`conic-gradient`（**单色标写法；实际最低内核 Chrome 87+——`inset` 是仓库既有基线**），待机 `opacity:.4`、亮 `opacity:1`；两条对角线用独立发丝层（`$ftl-hairline`）。
- 倒计时 18px；徽标胶囊 11px / `padding: 0 5px`；发丝线一律 `$ftl-hairline`（禁止裸 `1px`）。
- 亮灭：`play/claim/rob → currentPlayer`；`exchange/lack → activeSeats`；其他不亮。lit 显示倒计时，否则显示该家徽标。
- 保留 `anim-mj-urgent`（自家末 5 秒）；上/下槽无 transform，左/右槽才用 translate。
- 删除 `compact` 与 `hub` props、`.mj-hub--compact`、dots、四角徽标、`.mj-hub__status`、`.mj-hub__wall-label`。
- 摸牌位：不抬升、不金边；包裹层 `mj__hand-drawn` + 8u 金点（`pointer-events:none`）；金点靠兄弟选择器跟随选中抬升。
- Board 文案：`已胡${n}家`、`选同花3张`。
- 每个 Task 先写失败测试，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 本片不推送/不部署/不重打 APK；版本保持 0.1.12/112（v15 尚未打包，v16 并入同版本；如需另起版本由用户裁决）。

---

## Task 1: MahjongHub 铜钱化 + Board 信息井接线/文案

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongHub.vue`（整文件重写）
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`（`statusText` 两行 + `hubStyle` + 模板 Hub 标签）
- Test: `apps/client/test/mahjong-hub.test.ts`（整文件重写）
- Test: `apps/client/test/mahjong-board.test.ts`（4 处选择器/文案 + 新增信息井定位用例）

**Interfaces:**
- Consumes: `wallCount`, `seconds`, `phase`, `currentPlayer`, `activeSeats`, `seats`, `statusText?`, `endedText?`, `flashKey?`（**删除 `hub` 与 `compact`**）。
- Produces: DOM 类 `.mj-hub`、`.mj-hub__sector--{top,left,right,self}`（+ `.mj-hub__sector--lit`）、`.mj-hub__diag--a/b`（各 1 个节点）、`.mj-hub__hole`、`.mj-hub__wall-count`、`.mj-hub__hint`、`.mj-hub__slot--{dir}`（+ `--badge` / `--urgent`）、`.mj-hub__flash`；emit `flash-done` 不变。

- [ ] **Step 1: 写失败测试（整文件替换 `apps/client/test/mahjong-hub.test.ts`）**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongPhase } from '@fight-the-landlord/protocol';
import MahjongHub from '../src/components/table/mahjong/MahjongHub.vue';

/**
 * 铜钱信息井：中央方孔（牌墙 + 操作提示）+ 四扇形（倒计时/胡听缺托）+ 胡牌金光。
 * 视觉恒为紧凑档（160×160 设计 px，由 Board 定位/缩放）。
 */

const DIRS = ['top', 'left', 'right', 'self'] as const;

type TestSeat = {
  seat: number;
  dir: 'top' | 'left' | 'right' | 'self';
  badge?: 'hu' | 'ting' | 'lack' | 'trustee';
  badgeText?: string;
};
const seats: TestSeat[] = [
  { seat: 0, dir: 'self' },
  { seat: 1, dir: 'right' },
  { seat: 2, dir: 'top' },
  { seat: 3, dir: 'left' },
];

const base = {
  wallCount: 42,
  seconds: 12,
  phase: 'play' as MahjongPhase,
  currentPlayer: 2,
  activeSeats: [0, 2],
  seats,
  statusText: '等待出牌',
  endedText: '',
};

type Props = typeof base;

const src = readFileSync('src/components/table/mahjong/MahjongHub.vue', 'utf8');
const style = src.slice(src.indexOf('<style'));
const styleCode = style.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

function mountHub(over: Partial<Props> = {}) {
  return mount(MahjongHub, { props: { ...base, ...over } });
}

function litDirs(over: Partial<Props> = {}): string[] {
  const w = mountHub(over);
  return DIRS.filter((dir) =>
    w.find(`.mj-hub__sector--${dir}`).classes().includes('mj-hub__sector--lit'),
  );
}

function slot(w: ReturnType<typeof mountHub>, dir: string) {
  return w.find(`.mj-hub__slot--${dir}`);
}

describe('MahjongHub（铜钱信息井）', () => {
  it('结构：方孔 42 + 等待出牌；4 扇形 + 2 对角发丝；旧点/徽标/状态行/牌墙标签全部移除', () => {
    const w = mountHub();
    expect(w.find('.mj-hub').exists()).toBe(true);
    expect(w.findAll('.mj-hub__sector')).toHaveLength(4);
    expect(w.findAll('.mj-hub__diag')).toHaveLength(2);
    expect(w.find('.mj-hub__hole .mj-hub__wall-count').text()).toBe('42');
    expect(w.find('.mj-hub__hole .mj-hub__hint').text()).toBe('等待出牌');
    expect(w.find('.mj-hub__wall-label').exists()).toBe(false);
    expect(w.find('.mj-hub__status').exists()).toBe(false);
    expect(w.find('.mj-hub__dot').exists()).toBe(false);
    expect(w.find('.mj-hub__badge').exists()).toBe(false);
    expect(w.find('.mj-hub__clock').exists()).toBe(false);
    expect(w.find('.mj-hub__ring').exists()).toBe(false);
  });

  it('扇形亮灭：play/claim/rob 亮 currentPlayer', () => {
    expect(litDirs({ phase: 'play', currentPlayer: 2 })).toEqual(['top']);
    expect(litDirs({ phase: 'claim', currentPlayer: 1 })).toEqual(['right']);
    expect(litDirs({ phase: 'rob', currentPlayer: 1 })).toEqual(['right']);
  });

  it('扇形亮灭：exchange/lack 亮 activeSeats；ended/draw 全灭；无映射座位不亮', () => {
    expect(litDirs({ phase: 'exchange', activeSeats: [0, 3] })).toEqual(['left', 'self']);
    expect(litDirs({ phase: 'lack', activeSeats: [1] })).toEqual(['right']);
    expect(litDirs({ phase: 'ended', activeSeats: [0, 1, 2, 3] })).toEqual([]);
    expect(litDirs({ phase: 'draw', activeSeats: [0, 1, 2, 3] })).toEqual([]);
    expect(
      litDirs({ phase: 'play', currentPlayer: 2, seats: seats.filter((s) => s.dir !== 'top') }),
    ).toEqual([]);
  });

  it('槽轮换：lit 显示倒计时，未 lit 显示徽标，无徽标为空', () => {
    const w = mountHub({
      seats: [
        { seat: 0, dir: 'self', badge: 'ting', badgeText: '听' },
        { seat: 1, dir: 'right' },
        { seat: 2, dir: 'top', badge: 'hu', badgeText: '胡' },
        { seat: 3, dir: 'left', badge: 'lack', badgeText: '缺' },
      ],
      currentPlayer: 2,
    });
    expect(slot(w, 'top').text()).toBe('12s'); // lit 覆盖徽标
    expect(slot(w, 'self').text()).toBe('听');
    expect(slot(w, 'left').text()).toBe('缺');
    expect(slot(w, 'right').exists()).toBe(false);
    expect(slot(w, 'top').classes()).not.toContain('mj-hub__slot--badge');
    expect(slot(w, 'self').classes()).toContain('mj-hub__slot--badge');
  });

  it('多块同时亮（exchange）：每块显示同一 seconds，徽标被覆盖', () => {
    const w = mountHub({
      phase: 'exchange',
      activeSeats: [0, 3],
      seats: [
        { seat: 0, dir: 'self', badge: 'hu', badgeText: '胡' },
        { seat: 1, dir: 'right' },
        { seat: 2, dir: 'top' },
        { seat: 3, dir: 'left', badge: 'ting', badgeText: '听' },
      ],
    });
    expect(slot(w, 'self').text()).toBe('12s');
    expect(slot(w, 'left').text()).toBe('12s');
    expect(slot(w, 'self').classes()).not.toContain('mj-hub__slot--badge');
  });

  it('无人行动（ended）：四块徽标各自显示，无倒计时', () => {
    const w = mountHub({
      phase: 'ended',
      seats: [
        { seat: 0, dir: 'self', badge: 'hu', badgeText: '胡' },
        { seat: 1, dir: 'right', badge: 'trustee', badgeText: '托' },
        { seat: 2, dir: 'top', badge: 'ting', badgeText: '听' },
        { seat: 3, dir: 'left', badge: 'lack', badgeText: '缺' },
      ],
    });
    expect(slot(w, 'self').text()).toBe('胡');
    expect(slot(w, 'right').text()).toBe('托');
    expect(slot(w, 'top').text()).toBe('听');
    expect(slot(w, 'left').text()).toBe('缺');
    expect(w.findAll('.mj-hub__slot')[0]!.text()).not.toMatch(/s$/);
  });

  it('0 秒显示 0s 且不 urgent', () => {
    const w = mountHub({ currentPlayer: 0, seconds: 0 });
    expect(slot(w, 'self').text()).toBe('0s');
    expect(slot(w, 'self').classes()).not.toContain('mj-hub__slot--urgent');
  });

  it('urgent：仅自家 play 末 5 秒，且只挂自家槽', () => {
    const selfTurn = (over: Partial<Props> = {}) =>
      mountHub({ currentPlayer: 0, seconds: 4, ...over });
    const urgent = selfTurn();
    expect(slot(urgent, 'self').classes()).toContain('mj-hub__slot--urgent');
    expect(slot(urgent, 'self').classes()).toContain('anim-mj-urgent');
    for (const phase of ['claim', 'exchange', 'lack'] as MahjongPhase[]) {
      const w = selfTurn({ phase });
      expect(slot(w, 'self').classes(), `${phase} 不得 urgent`).not.toContain(
        'mj-hub__slot--urgent',
      );
      expect(slot(w, 'self').classes()).not.toContain('anim-mj-urgent');
    }
    expect(selfTurn({ seconds: 6 }).find('.mj-hub__slot--urgent').exists()).toBe(false);
    expect(selfTurn({ seconds: 0 }).find('.mj-hub__slot--urgent').exists()).toBe(false);
  });

  it('提示截断 5 字 + …；endedText 优先', () => {
    const long = '一二三四五六七八九十';
    const w = mountHub({ statusText: long });
    expect(w.find('.mj-hub__hint').text()).toBe('一二三四五…');
    const ended = mountHub({ endedText: '已胡2家' });
    expect(ended.find('.mj-hub__hint').text()).toBe('已胡2家');
  });

  it('无 seats：四槽全空、方孔仍显示', () => {
    const w = mountHub({ seats: [] });
    expect(w.findAll('.mj-hub__slot')).toHaveLength(0);
    expect(w.find('.mj-hub__wall-count').text()).toBe('42');
  });

  it('源码闸：根 6px 金环 + 径向漆底 + 不剪裁', () => {
    const root = ruleBody(styleCode, '.mj-hub');
    expect(root).toContain('box-sizing: border-box');
    expect(root).toContain('border: 6px solid $ftl-color-mj-gold');
    expect(root).toContain('border-radius: 50%');
    expect(root).toContain(
      'radial-gradient(circle at 50% 42%, $ftl-color-mj-hub-core 0%, $ftl-color-mj-lacquer 70%)',
    );
    expect(root).toContain('0 0 0 $ftl-hairline $ftl-color-mj-border');
    expect(root).not.toContain('overflow: hidden');
  });

  it('源码闸：4 扇形 conic-gradient（单色标）+ 亮块 opacity 1 + 待机 .4 + 过渡', () => {
    const sector = ruleBody(styleCode, '.mj-hub__sector');
    expect(sector).toContain('position: absolute');
    expect(sector).toContain('inset: 0');
    expect(sector).toContain('border-radius: 50%');
    expect(sector).toContain('opacity: .4');
    expect(sector).toContain('transition: opacity .3s');
    expect(ruleBody(styleCode, '.mj-hub__sector--lit')).toContain('opacity: 1');
    for (const [sel, from] of [
      ['.mj-hub__sector--top', '-45deg'],
      ['.mj-hub__sector--right', '45deg'],
      ['.mj-hub__sector--self', '135deg'],
      ['.mj-hub__sector--left', '225deg'],
    ] as const) {
      const body = ruleBody(styleCode, sel);
      expect(body).toContain(`conic-gradient(from ${from}`);
      expect(body).toContain('90deg, transparent 90deg, transparent 360deg');
    }
  });

  it('源码闸：对角线发丝层 $ftl-hairline + ±45°', () => {
    const diag = ruleBody(styleCode, '.mj-hub__diag');
    expect(diag).toContain('height: $ftl-hairline');
    expect(diag).toContain('rgba($ftl-color-mj-gold, .16)');
    expect(ruleBody(styleCode, '.mj-hub__diag--a')).toContain('rotate(45deg)');
    expect(ruleBody(styleCode, '.mj-hub__diag--b')).toContain('rotate(-45deg)');
  });

  it('源码闸：方孔 66 border-box / $ftl-hairline / 漆底；牌墙 30；提示 10 + 5 字省略', () => {
    const hole = ruleBody(styleCode, '.mj-hub__hole');
    expect(hole).toContain('box-sizing: border-box');
    expect(hole).toContain('width: 66px');
    expect(hole).toContain('height: 66px');
    expect(hole).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(hole).toContain('background: rgba($ftl-color-mj-lacquer, .84)');
    const wall = ruleBody(styleCode, '.mj-hub__wall-count');
    expect(wall).toContain('color: $ftl-color-mj-sheen');
    expect(wall).toContain('font-size: 30px');
    expect(wall).toContain('font-weight: 700');
    expect(wall).toContain('tabular-nums');
    const hint = ruleBody(styleCode, '.mj-hub__hint');
    expect(hint).toContain('font-size: 10px');
    expect(hint).toContain('max-width: 100%');
    expect(hint).toContain('text-overflow: ellipsis');
    expect(hint).toContain('white-space: nowrap');
    expect(hint).toContain('color: $ftl-color-mj-status');
  });

  it('源码闸：槽 18px + 四向位置 + 上/下无 transform + 左右 translate + 徽标 11px', () => {
    const slotRule = ruleBody(styleCode, '.mj-hub__slot');
    expect(slotRule).toContain('font-size: 18px');
    expect(slotRule).toContain('font-weight: 700');
    expect(slotRule).toContain('tabular-nums');
    const top = ruleBody(styleCode, '.mj-hub__slot--top');
    expect(top).toContain('top: 12%');
    expect(top).toContain('text-align: center');
    expect(top).not.toContain('transform');
    const self = ruleBody(styleCode, '.mj-hub__slot--self');
    expect(self).toContain('bottom: 6%');
    expect(self).toContain('text-align: center');
    expect(self).not.toContain('transform');
    expect(ruleBody(styleCode, '.mj-hub__slot--left')).toContain('translate(-50%, -50%)');
    expect(ruleBody(styleCode, '.mj-hub__slot--right')).toContain('translate(50%, -50%)');
    expect(ruleBody(styleCode, '.mj-hub__slot--urgent')).toContain('$ftl-color-mj-urgent');
    const badge = ruleBody(styleCode, '.mj-hub__slot--badge');
    expect(badge).toContain('font-size: 11px');
    expect(badge).toContain('padding: 0 5px');
    expect(badge).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(badge).toContain('background: rgba($ftl-color-mj-lacquer, .85)');
  });

  it('源码闸：无裸 1px；旧选择器/旧 props 删除；保留 anim-mj-urgent 与动画 import', () => {
    expect(styleCode).not.toMatch(/(?:^|[^\d])1px\b/);
    expect(src).not.toContain('mj-hub__dot');
    expect(src).not.toContain('mj-hub__badge');
    expect(src).not.toContain('mj-hub__status');
    expect(src).not.toContain('mj-hub__wall-label');
    expect(src).not.toContain('mj-hub--compact');
    expect(src).not.toContain('compact');
    expect(src).not.toMatch(/hub\s*:\s*HubRect/);
    expect(src).not.toMatch(/props\.hub/);
    expect(src).toContain('anim-mj-urgent');
    expect(styleCode).toMatch(/@import\s+['"][^'"]*styles\/animations\.scss['"]/);
  });

  it('盘金光：flashKey>0 渲染覆盖层，key 变化重挂载，animationend 才 emit flash-done', async () => {
    const w = mountHub();
    expect(w.find('.mj-hub__flash').exists()).toBe(false);
    await w.setProps({ flashKey: 1 });
    const flash = w.find('.mj-hub__flash');
    expect(flash.exists()).toBe(true);
    expect(flash.classes()).toContain('anim-mj-hub-flash');
    const firstEl = flash.element;
    await w.setProps({ flashKey: 2 });
    expect(w.find('.mj-hub__flash').element).not.toBe(firstEl);
    await w.find('.mj-hub__flash').trigger('animationend', { animationName: 'other-anim' });
    expect(w.emitted('flash-done')).toBeUndefined();
    await w.find('.mj-hub__flash').trigger('animationend', {
      animationName: 'ftl-mj-hub-flash-7ba3f1',
    });
    expect(w.emitted('flash-done')).toHaveLength(1);
  });

  it('源码闸：金光覆盖层 inset 0 / 圆角 / pointer-events none / 径向金色', () => {
    const flash = ruleBody(styleCode, '.mj-hub__flash');
    expect(flash).toContain('position: absolute');
    expect(flash).toContain('inset: 0');
    expect(flash).toContain('border-radius: 50%');
    expect(flash).toContain('pointer-events: none');
    expect(flash).toContain('radial-gradient');
    expect(flash).toContain('rgba($ftl-color-mj-gold');
    expect(src).toContain('anim-mj-hub-flash');
    expect(src).toContain('@animationend="onFlashEnd"');
    expect(src).toContain("startsWith('ftl-mj-hub-flash')");
  });

  it('无分数、无中央 claim 牌、无图片、不定义 animation/infinite', () => {
    const w = mountHub();
    expect(w.find('.mj-hub__score').exists()).toBe(false);
    expect(w.find('.mj-hub__claim').exists()).toBe(false);
    expect(w.find('image').exists()).toBe(false);
    expect(w.text()).not.toMatch(/分数|底分|积分/);
    expect(styleCode).not.toMatch(/animation\s*:/);
    expect(src).not.toMatch(/infinite/);
  });
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `pnpm -C apps/client exec vitest run test/mahjong-hub.test.ts`
Expected: FAIL（旧组件无 `.mj-hub__sector` / `.mj-hub__hole` 等）。

- [ ] **Step 3: 整文件替换 `apps/client/src/components/table/mahjong/MahjongHub.vue`**

```vue
<script setup lang="ts">
/**
 * 血战盘（哑组件）：铜钱信息井 —— 中央方孔（牌墙 + 操作提示）+ 四扇形（倒计时/徽标）。
 *
 * 只渲染 props，不判规则、不取数、不造计时器：
 *  - 不含分数；没有中央 claim 牌（rob 的待响应牌由 ActionBar 显示）。
 *  - 扇形亮规则：play/claim/rob 亮 currentPlayer；exchange/lack 亮 activeSeats；
 *    其余（draw/ended）不亮；没有映射座位的方向永不点亮。
 *  - 亮块显示倒计时；未亮块显示该家的单字徽标（胡/听/缺/托，由 Board 按 胡>听>缺>托 求好）。
 *  - 紧迫动效：仅在我方出牌末 5 秒给「自家」槽挂 `anim-mj-urgent`（下槽无静态 transform）。
 *  - 胡牌金光：`flashKey > 0` 时挂一次性覆盖层；animationend 后 emit `flash-done`。
 *  - 视觉恒为紧凑档（160×160 设计 px，由 Board 定位/缩放）。
 */
import { computed } from 'vue';
import type { MahjongPhase } from '@fight-the-landlord/protocol';

type HubDir = 'top' | 'left' | 'right' | 'self';
type HubBadge = 'hu' | 'ting' | 'lack' | 'trustee';

interface HubSeat {
  seat: number;
  dir: HubDir;
  badge?: HubBadge | null;
  badgeText?: string;
}

const props = withDefaults(
  defineProps<{
    wallCount: number;
    seconds: number;
    phase: MahjongPhase;
    currentPlayer: number;
    activeSeats: number[];
    seats: HubSeat[];
    statusText?: string;
    endedText?: string;
    flashKey?: number;
  }>(),
  {
    statusText: '',
    endedText: '',
    flashKey: 0,
  },
);

const emit = defineEmits<{
  (e: 'flash-done'): void;
}>();

const DIRS: readonly HubDir[] = ['top', 'left', 'right', 'self'];

function seatOf(dir: HubDir): number | undefined {
  return props.seats.find((s) => s.dir === dir)?.seat;
}

/** 方孔提示：最多 5 字 + 省略号（62px 内容宽）；endedText 优先。 */
const statusShown = computed(() => {
  const chars = Array.from(props.endedText || props.statusText || '');
  return chars.length > 5 ? `${chars.slice(0, 5).join('')}…` : chars.join('');
});

const wallShown = computed(() => Math.max(0, Math.floor(Number(props.wallCount) || 0)));

interface HubSector {
  dir: HubDir;
  lit: boolean;
  urgent: boolean;
  text: string;
  kind: 'clock' | 'badge' | 'none';
}

const sectors = computed<HubSector[]>(() =>
  DIRS.map((dir) => {
    const seat = seatOf(dir);
    let lit = false;
    if (seat !== undefined) {
      if (props.phase === 'play' || props.phase === 'claim' || props.phase === 'rob') {
        lit = seat === props.currentPlayer;
      } else if (props.phase === 'exchange' || props.phase === 'lack') {
        lit = props.activeSeats.includes(seat);
      }
    }
    if (lit) {
      const urgent =
        dir === 'self' && props.phase === 'play' && props.seconds > 0 && props.seconds <= 5;
      const seconds = Math.max(0, Math.floor(Number(props.seconds) || 0));
      return { dir, lit, urgent, text: `${seconds}s`, kind: 'clock' };
    }
    const seatInfo = props.seats.find((s) => s.dir === dir);
    const badgeText = seatInfo?.badge && seatInfo.badgeText ? seatInfo.badgeText : '';
    return { dir, lit, urgent: false, text: badgeText, kind: badgeText ? 'badge' : 'none' };
  }),
);

/**
 * 金光播完才清键。scoped 构建会把 @keyframes 重命名（`ftl-mj-hub-flash-<hash>`）
 * ⇒ 只判前缀，不判全等。
 */
function onFlashEnd(e: AnimationEvent): void {
  if (e.animationName.startsWith('ftl-mj-hub-flash')) emit('flash-done');
}
</script>

<template>
  <view class="mj-hub">
    <view
      v-for="s in sectors"
      :key="`sector-${s.dir}`"
      class="mj-hub__sector"
      :class="[`mj-hub__sector--${s.dir}`, { 'mj-hub__sector--lit': s.lit }]"
    />
    <view class="mj-hub__diag mj-hub__diag--a" />
    <view class="mj-hub__diag mj-hub__diag--b" />
    <view class="mj-hub__hole">
      <text class="mj-hub__wall-count">{{ wallShown }}</text>
      <text v-if="statusShown" class="mj-hub__hint">{{ statusShown }}</text>
    </view>
    <template v-for="s in sectors" :key="`slot-${s.dir}`">
      <text
        v-if="s.text"
        class="mj-hub__slot"
        :class="[
          `mj-hub__slot--${s.dir}`,
          { 'mj-hub__slot--badge': s.kind === 'badge' },
          { 'mj-hub__slot--urgent': s.urgent, 'anim-mj-urgent': s.urgent },
        ]"
      >{{ s.text }}</text>
    </template>
    <view
      v-if="flashKey > 0"
      :key="flashKey"
      class="mj-hub__flash anim-mj-hub-flash"
      @animationend="onFlashEnd"
    />
  </view>
</template>

<style scoped lang="scss">
// `anim-mj-urgent` / `anim-mj-hub-flash` 的类与 keyframes 都在 animations.scss（scoped 会重命名 @keyframes ⇒ 必须导入）。
@import '../../../styles/animations.scss';

/* 川麻红金调色（设计 v4 §8）：token 定义在 src/uni.scss 的 $ftl-color-mj-* 一档。 */
.mj-hub {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 6px solid $ftl-color-mj-gold;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 42%, $ftl-color-mj-hub-core 0%, $ftl-color-mj-lacquer 70%);
  box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-border, 0 0 28px rgba($ftl-color-mj-gold, .25), inset 0 0 24px rgba(0, 0, 0, .6);
  color: $ftl-color-mj-cream;
  text-align: center;
}
/* 四扇形：45°/135° 对角线切分（上/右/下/左）。待机 .4，亮块 1。 */
.mj-hub__sector {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  opacity: .4;
  transition: opacity .3s;
}
.mj-hub__sector--top {
  background: conic-gradient(from -45deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--right {
  background: conic-gradient(from 45deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--self {
  background: conic-gradient(from 135deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--left {
  background: conic-gradient(from 225deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--lit {
  opacity: 1;
}
/* 对角线发丝层：不随扇形 dim；45°/135°。 */
.mj-hub__diag {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 148px;
  height: $ftl-hairline;
  background: rgba($ftl-color-mj-gold, .16);
  transform-origin: center;
  pointer-events: none;
}
.mj-hub__diag--a {
  transform: translate(-50%, -50%) rotate(45deg);
}
.mj-hub__diag--b {
  transform: translate(-50%, -50%) rotate(-45deg);
}
/* 中央方孔：66×66 border-box（内容宽 62）。 */
.mj-hub__hole {
  position: absolute;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  width: 66px;
  height: 66px;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 4px;
  background: rgba($ftl-color-mj-lacquer, .84);
  z-index: 2;
}
.mj-hub__wall-count {
  color: $ftl-color-mj-sheen;
  font-size: 30px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.mj-hub__hint {
  max-width: 100%;
  overflow: hidden;
  color: $ftl-color-mj-status;
  font-size: 10px;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 扇形文本槽：lit=倒计时，未 lit=徽标胶囊。 */
.mj-hub__slot {
  position: absolute;
  z-index: 2;
  color: $ftl-color-mj-cream;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.mj-hub__slot--top {
  top: 12%;
  left: 0;
  right: 0;
  text-align: center;
}
.mj-hub__slot--self {
  bottom: 6%;
  left: 0;
  right: 0;
  text-align: center;
}
.mj-hub__slot--left {
  top: 50%;
  left: 11%;
  transform: translate(-50%, -50%);
}
.mj-hub__slot--right {
  top: 50%;
  right: 11%;
  transform: translate(50%, -50%);
}
.mj-hub__slot--urgent {
  color: $ftl-color-mj-urgent;
}
.mj-hub__slot--badge {
  padding: 0 5px;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 8px;
  background: rgba($ftl-color-mj-lacquer, .85);
  color: $ftl-color-mj-cream;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.25;
}
/* 胡牌金光覆盖层：只画金色内晕，pointer-events 穿透。 */
.mj-hub__flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, rgba($ftl-color-mj-gold, .35) 0%, rgba($ftl-color-mj-gold, 0) 70%);
}
</style>
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `pnpm -C apps/client exec vitest run test/mahjong-hub.test.ts`
Expected: PASS。

- [ ] **Step 5: Board 信息井/文案同步（同一提交，避免 board 测试中途红灯）**

5.1 `statusText` 两处：
```ts
return endReason.value > 0 ? `已胡${endReason.value}家` : '本局结束';
...
return amActive.value ? '选同花3张' : '等待换三张';
```

5.2 新增 `hubStyle`（放在 `actionsStyle` 附近）：
```ts
/** v16：信息井视觉恒为紧凑档（160×160 设计 px），居中于 hub.cx/cy；scale(u) 防御。 */
const hubStyle = computed(() => ({
  position: 'absolute' as const,
  left: `${layout.value.hub.cx - 80}px`,
  top: `${layout.value.hub.cy - 80}px`,
  width: '160px',
  height: '160px',
  transform: `scale(${layout.value.u})`,
  transformOrigin: 'center',
}));
```

5.3 模板 Hub 标签：删除 `:hub`、`:compact`，`:style="hubStyle"`。

5.4 `mahjong-board.test.ts`：
- 三处 `.mj-hub__status` → `.mj-hub__hint`（:257/:265/:278）。
- `已胡 2 家` → `已胡2家`（:278）。
- 在「只靠 props 渲染」或邻近 describe 加：
```ts
it('信息井 160×160 居中 + scale(u)（v16）', () => {
  const wrapper = mount(MahjongBoard, { props: props() });
  const layout = mahjongTableLayoutV3(1334, 750);
  const style = wrapper.findComponent(MahjongHub).attributes('style')!;
  expect(style).toContain('position: absolute');
  expect(style).toContain('width: 160px');
  expect(style).toContain('height: 160px');
  expect(style).toContain(`left: ${layout.hub.cx - 80}px`);
  expect(style).toContain(`top: ${layout.hub.cy - 80}px`);
  expect(style).toContain(`transform: scale(${layout.u})`);
  expect(style).toContain('transform-origin: center');
});
```
- 源码闸：
```ts
it('源码闸：v16 删除 :hub/:compact 绑定', () => {
  expect(boardSfc).not.toContain(':hub="layout.hub"');
  expect(boardSfc).not.toContain(':compact');
});
```

Run: `pnpm -C apps/client exec vitest run test/mahjong-hub.test.ts test/mahjong-board.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongHub.vue apps/client/src/components/table/mahjong/MahjongBoard.vue apps/client/test/mahjong-hub.test.ts apps/client/test/mahjong-board.test.ts
git commit -m "feat(mahjong): 铜钱信息井（方孔 + 四扇形 + 倒计时/徽标轮换）"
```

---

## Task 2: 摸牌位包裹层 + 金点

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Test: `apps/client/test/mahjong-board.test.ts`

**Interfaces:**
- Consumes: Task 1 的信息井接线（不动）。
- Produces: `.mj__hand-drawn` 包裹层、`.mj__hand-drawn-dot` 金点、`.mj__hand-drawn--selected`；`handTileBind(entry, i)` / `drawnWrapStyle`。

- [ ] **Step 1: 写/改失败测试**

1. `13→14：新增牌移到行尾并标 drawn`（约 :860-873）的 margin-left 断言改为父元素，并补 DOM 断言：
```ts
const wrap = last.element.parentElement as HTMLElement;
expect(wrap.className).toContain('mj__hand-drawn');
expect(wrap.getAttribute('style')).toContain(
  `margin-left: ${layout.hand.drawnGap - layout.hand.gap}px`,
);
expect(wrap.querySelector('.mj__hand-drawn-dot')).not.toBeNull();
expect(wrapper.findAll('.mj__hand-drawn')).toHaveLength(1);
```
2. 删除旧「红金皮肤（Task 4：摸牌位抬 8 + 金边）」describe（两条源码闸，约 :1512-1534），替换为：
```ts
describe('MahjongBoard：v16 摸牌位金点', () => {
  it('源码闸：旧摸牌位抬升/金边规则整体删除；金点 8u + pointer-events none', () => {
    expect(boardStyle).not.toContain('.mj__hand-tile--drawn)');
    const dot = /\.mj__hand-drawn-dot\s*\{([^}]*)\}/.exec(boardStyle);
    expect(dot, '.mj__hand-drawn-dot 规则必须存在').not.toBeNull();
    const body = dot![1]!;
    expect(body).toContain('width: calc(8px * var(--mj-u))');
    expect(body).toContain('height: calc(8px * var(--mj-u))');
    expect(body).toContain('pointer-events: none');
    expect(body).toContain('$ftl-color-mj-gold');
  });

  it('源码闸：金点跟随选中抬升（兄弟选择器）+ 包裹层 z-index', () => {
    const follow =
      /\.mj__hand\s+:deep\(\.mj-tile--selected\)\s*\+\s*\.mj__hand-drawn-dot\s*\{([^}]*)\}/.exec(
        boardStyle,
      );
    expect(follow, '金点跟随选中抬升规则必须存在').not.toBeNull();
    expect(follow![1]).toContain('translateY(calc(-1 * var(--mj-tile-lift, 10px)))');
    const z = /\.mj__hand-drawn--selected\s*\{([^}]*)\}/.exec(boardStyle);
    expect(z, '包裹层选中 z-index 规则必须存在').not.toBeNull();
    expect(z![1]).toContain('z-index: 10');
  });

  it('摸牌位可选中（包裹层挂 selected 类）并双击出牌', async () => {
    const baseHand = view().hand;
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({ view: view({ hand: [...baseHand, tile(1, 9)] }) });
    await nextTick();
    const drawn = wrapper.findAll('.mj__hand .mj-tile').at(-1)!;
    await drawn.trigger('click');
    expect(wrapper.findAll('.mj-tile--selected')).toHaveLength(1);
    expect(wrapper.find('.mj__hand-drawn').classes()).toContain('mj__hand-drawn--selected');
    await drawn.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'discard',
      tile: { s: 1, r: 9 },
    });
  });
});
```
3. 保留所有 drawn 计数/类断言（类仍挂在 image 上）。

Run: `pnpm -C apps/client exec vitest run test/mahjong-board.test.ts`
Expected: FAIL（旧 margin 在 image 上、无包裹层/金点）。

- [ ] **Step 2: 实现 Board 手牌改动**

2.1 新增 `HandEntry` 类型并把 `displayTiles` 泛型改用它：
```ts
interface HandEntry {
  tile: Tile;
  drawn: boolean;
  dealNonce: number | null;
}
const displayTiles = computed<HandEntry[]>(() => { /* 现有实现不变 */ });
```
2.2 绑定助手 + 包裹层样式：
```ts
function handTileBind(entry: HandEntry, i: number) {
  return {
    tile: entry.tile,
    direction: 'my' as const,
    w: layout.value.hand.tile.w,
    h: layout.value.hand.tile.h,
    selected: selected.value.includes(i),
    disabled: !handSelectable.value,
    class: {
      'anim-deal-in-radial':
        entry.dealNonce != null && entry.dealNonce === dealEpoch.value && !entry.drawn,
      'mj__hand-tile--drawn': entry.drawn,
    },
    style: {
      '--ftl-delay': `${i * 30}ms`,
      '--mj-deal-x': dealOffsetX(i),
    },
  };
}
const drawnWrapStyle = computed(() => ({
  width: `${layout.value.hand.tile.w}px`,
  height: `${layout.value.hand.tile.h}px`,
  marginLeft: `${layout.value.hand.drawnGap - layout.value.hand.gap}px`,
}));
```
2.3 模板手牌段整段替换：
```html
<template v-for="(entry, i) in displayTiles" :key="`hand-${entry.dealNonce ?? 'seed'}-${i}`">
  <view
    v-if="entry.drawn"
    class="mj__hand-drawn"
    :class="{ 'mj__hand-drawn--selected': selected.includes(i) }"
    :style="drawnWrapStyle"
  >
    <MahjongTile v-bind="handTileBind(entry, i)" @click="onTileClick(i)" @longpress="onTileLongPress(i)" />
    <view class="mj__hand-drawn-dot" />
  </view>
  <MahjongTile
    v-else
    v-bind="handTileBind(entry, i)"
    @click="onTileClick(i)"
    @longpress="onTileLongPress(i)"
  />
</template>
```
2.4 样式：删除旧两条摸牌位规则：
```scss
/* 删除：
.mj__hand :deep(.mj__hand-tile--drawn) { ... }
.mj__hand :deep(.mj-tile--selected.mj__hand-tile--drawn) { ... }
*/
```
新增：
```scss
/* v16：摸牌位 = 包裹层 + 右上金点；抬升只属于选中（金点用兄弟选择器跟随）。 */
.mj__hand-drawn {
  position: relative;
  flex: 0 0 auto;
}
.mj__hand-drawn--selected {
  z-index: 10;
}
.mj__hand-drawn-dot {
  position: absolute;
  top: calc(-2px * var(--mj-u));
  right: calc(-2px * var(--mj-u));
  width: calc(8px * var(--mj-u));
  height: calc(8px * var(--mj-u));
  border-radius: 50%;
  background: $ftl-color-mj-gold;
  box-shadow: 0 0 calc(6px * var(--mj-u)) $ftl-color-mj-gold;
  pointer-events: none;
}
.mj__hand :deep(.mj-tile--selected) + .mj__hand-drawn-dot {
  transform: translateY(calc(-1 * var(--mj-tile-lift, 10px)));
}
```
（保留现有 `.mj__hand :deep(.mj-tile--selected) { z-index: 10; }`。）

- [ ] **Step 3: 跑测试确认 GREEN + 相邻回归**

Run:
`pnpm -C apps/client exec vitest run test/mahjong-board.test.ts test/mahjong-hub.test.ts test/mahjong-river.test.ts test/ui-tokens.test.ts test/animations.test.ts test/mahjong-skin.test.ts test/mahjong-layout-v3.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongBoard.vue apps/client/test/mahjong-board.test.ts
git commit -m "feat(mahjong): 摸牌位改包裹层 + 右上金点（抬升只归选中）"
```

---

## Task 3: 全量验证 + 真浏览器对照 + 交接

**Files:**
- Create: `docs/superpowers/plans/2026-11-08-mahjong-hub-coin-hand-drawn-handoff.md`

- [ ] **Step 1: 全量验证**

Run（逐条，记录输出尾部与计数）：
```bash
pnpm -C apps/client test
pnpm -C apps/client lint
pnpm -C apps/client build
```
Expected: test 全绿；lint exit 0；build `DONE Build complete.`。

- [ ] **Step 2: 真浏览器对照（条件执行；不得用单测替代）**

- 若本机栈可用（9 容器 + dev server + 可进一局麻将）：
  - 起 H5（`pnpm -C apps/client dev:h5` 或构建后起 `dist/build/h5`），进入一局麻将；
  - 截 3 态（上家回合 / 自家末 5 秒 / 无人行动）+ 手牌（摸牌位与选中同屏）；
  - 对照 `.superpowers/mahjong-redgold/mockup/hub-coin-hand-preview.png`，重点：扇形可读性、**5 字提示（`选同花3张`）不溢出**、金点随选中抬升、摸牌位与选中一眼可分；
  - 截图存 `.superpowers/mahjong-redgold/v16-shots/`（gitignored）。
- 若栈不可用或无法进房：**不得声称已验**；在交接中登记「真浏览器/真机走查未执行（待部署后）」，并列出待查项。

- [ ] **Step 3: 写交接**

交接必须包含：
- 状态：v16 已实现（Task 1/2 提交 SHA + 本 Task 提交）；全量结果数字；**未推送/未部署/未重打 APK**；版本保持 0.1.12/112（v15+v16 同版本）。
- 改动：`MahjongHub.vue` 铜钱结构（方孔/扇形/槽、删除 `hub`/`compact`/dots/corner badges）、`MahjongBoard.vue`（hubStyle/手牌包裹层/文案）。
- 设计/审查：spec 路径 + §10 审查记录；计划 §计划审查记录；预览路径；真浏览器截图路径或「未执行」登记。
- 回滚：本片只动两个组件与测试；回滚 = `git revert` 对应提交；部署回滚点仍 `dev-362b9f9`（v16 未部署）。
- 下一步（需用户裁决）：推送 dev → 部署测试服 → 重打 APK → 真机走查（扇形可读性、5 字提示不溢出、金点随选中抬升、摸牌位与选中一眼可分）。
- 已知取舍：claim/rob 沿用 `currentPlayer` 语义；160 视觉小于布局矩形；conic-gradient 最低内核 Chrome 87+（单色标写法；`inset` / flex `gap` 已是仓库既有基线）。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-11-08-mahjong-hub-coin-hand-drawn-handoff.md
git commit -m "docs(mahjong): v16 铜钱信息井实现交接"
```

---

## Self-Review

- Spec coverage：D1–D13 全部有落点——D1/§1.1 → Task 1 `hubStyle`；D2/D6 → Task 1 方孔 + Board 文案；D3/D7 → Task 1 sectors；D4/D12/D13 → Task 1 CSS；D5/D8 → Task 2 包裹层/金点；D9/D11 → Task 1 删除 `hub`/`compact`；D10 → 全片不动协议。
- Type consistency：`HubSector` 的 `dir/lit/urgent/text/kind` 在模板与测试同名；`HandEntry` 用于 `displayTiles`/`handTileBind`；`.mj-hub__hint` 在 Task 1 产出并被 Board 测试消费。
- Placeholder scan：无 TBD/TODO；所有代码块给全。
- 已知风险：`v-bind`/`v-on` 两分支共享绑定需在实现时确认 uni-app 编译通过；Hub 组件源码不得出现 `compact` 字样（测试有 `not.toContain('compact')` 闸）；`hub` prop 已删除。

## 计划审查记录

2026-11-08 按 `docs/dev-process.md` §5 做独立对抗审查（只读，未跑测试套件）。核对面：计划代码可编译性（`HubRect`/`hub` 删除后的类型兼容、`mountHub(Partial<Props>)` 与 `TestSeat`、`<template v-for>` + 内层 `v-if/v-else` + `:key`、`v-bind` 对象含 `class/style` 的合并）；Board 接线（`hubStyle` 与 jsdom 序列化逐字一致、`margin-left` 迁到包裹层、`findAll('.mj__hand .mj-tile')` 计数/发牌类/`:key`/选中 z-index 不变）；Hub 逻辑与测试逐条对照（lit 规则、0s、多块同秒、urgent 仅 self+play+1..5s、5 字截断、endedText 优先、flash 前缀）；CSS 可行性（conic 四层、`$ftl-hairline` 当 height、badge padding on `<text>`、`anim-mj-urgent` 只含 scale 且只挂无静态 transform 的自槽、`:deep()` 兄弟选择器 scoped 后可命中）；既有闸冲突（`mahjong-board.test.ts` 仅 :257/:265/:278 与 :278 文案、:860-873 margin、:1514-1533 旧摸牌位两条源码闸；`animations.test.ts` 仍满足；`mahjong-skin`/`ui-tokens`/`mahjong-layout-v3` 不受影响）。

结论：**无阻断；3 高 + 5 低**，均已修订：
- 高：① `.mj-hub__hole` 缺 `box-sizing: border-box` ⇒ 实际 70×70/内容 66；已在 Global Constraints/CSS/源码闸补上；② Board/Hub 新增 DOM 覆盖缺口（金点、包裹层 selected 类、对角发丝层只有 CSS 闸）⇒ 已补真实 DOM 断言；③ Task 3 缺真浏览器对照 ⇒ 已加条件执行的截图步骤与「未执行」登记规则。
- 低：Task 1 会打红 board 测试 ⇒ 把 board 文案/选择器/信息井定位并入 Task 1；旧摸牌位源码闸只禁 transform ⇒ 改为禁止整个 `:deep(.mj__hand-tile--drawn)` 选择器，并断言删除 `:hub`/`:compact`；conic 双色标需 Chrome 71+ ⇒ 改单色标（Chrome 69）；定向回归补 `mahjong-skin`/`mahjong-layout-v3`；`compact` 子串闸与死 `hub` prop ⇒ 补 `hub` 删除断言并彻底移除 `hub` prop。

修订后计划可开工。
