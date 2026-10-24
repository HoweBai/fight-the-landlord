# 手牌出牌后刷新优化 · 设计 v1.1

> **定位**：消除「出牌后整手牌重新发牌」的视觉刷新，并让剩余牌在 H5 上平滑滑到新位置。
> **状态**：v1.1（已吸收独立对抗审查的 1 BLOCKER / 5 MAJOR / 8 MINOR）。供实施计划消费。
> **接触面**：`apps/client/src/components/Hand.vue` · `apps/client/src/components/hand-keys.ts`（新增纯函数）· `apps/client/src/pages/table/table.vue`（一个 prop）· 测试。**不碰布局、规则、协议、服务端。**

---

## §0 用户裁决

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 采用 **稳定 key + 平滑重排** | 见 §2、§3 |
| K2 | 平滑重排只在 **H5** 生效；小程序 / App 降级为瞬时重排 | 见 §4 |
| K3 | 不做被出牌的“飞出”动画 | 见 §6 |

---

## §1 根因

`Hand.vue` 的 `v-for` key 是 `${r}-${s}-${index}`，其中 `index` 是牌在 `store.hand` 里的原始下标。

出牌后服务端下发的新手牌变短，**被删位置之后的牌下标前移** ⇒ 这些牌的 key 改变 ⇒ Vue 卸载并重建它们的 DOM 节点。手牌默认 `enter="deal"`，重建的牌会重播 `.anim-deal-in`（0.36s，最多 12×35ms 错峰）——这是「整手牌刷新」的主要观感来源（被删位置之前的牌本来就不会重建）。

---

## §2 稳定 key

### 2.1 唯一性

单副牌中 `(r, s)` 唯一（含大小王），因此 key 可直接用 `${r}-${s}`。

测试夹具 / 探针可能构造重复 `(r,s)`（例如 `s` 全传 0），因此追加**同面出现序号**：

- 第 1 张：`${r}-${s}`
- 第 2 张：`${r}-${s}#1`
- 以此类推

重复牌面删除其中一张时，另一张的序号可能变化（允许重建；视觉不可区分）。

### 2.2 序号分配顺序

按 `cards` 的**原始顺序**分配出现序号，再按 `order`（展示顺序）返回。这样排序变化不会让重复牌的序号互换。

### 2.3 纯函数

新增 `apps/client/src/components/hand-keys.ts`：

```ts
export interface KeyedHandCard {
  /** cards 里的原始下标（选中/toggle 语义不变）。 */
  index: number;
  /** 稳定 key。 */
  key: string;
}

/**
 * 为展示顺序的每张牌生成稳定 key。
 * - 正常单副牌：(r,s) 唯一 ⇒ key = `${r}-${s}`
 * - 重复牌面（仅测试/探针）：追加按**原始顺序**分配的出现序号 `#1`、`#2`…
 */
export function keyedHandOrder(
  cards: readonly { r: number; s: number }[],
  order: readonly number[],
): KeyedHandCard[];
```

`Hand.vue` 的 `v-for` 改用 `keyedHandOrder(cards, order)`；`selected` / `toggle` 仍使用 `entry.index`，`i` 仍只用于发牌错峰延迟。

---

## §3 平滑重排（FLIP，仅 H5）

### 3.1 启用条件（必须最先判断）

```ts
const isH5Runtime = typeof window !== 'undefined' && typeof document !== 'undefined';
if (!props.reflow || !isH5Runtime) return; // onBeforeUpdate / onUpdated 两处都要在最前面
```

- `reflow` 默认 `false`，只有 `table.vue` 的手牌传 `true`；`PlayArea` / `BottomCards` 不传。
- 稳定 key 对所有 `Hand` 消费方生效；FLIP 只由 `reflow` + H5 运行时门控。
- **守卫必须在碰任何 ref / DOM API 之前执行**（App service 侧不一定有浏览器全局）。

### 3.2 生命周期（顺序是硬要求）

1. **`onBeforeUpdate`**（DOM 仍是旧的一帧，props 已是新值）：
   - 先执行 §3.1 守卫
   - 从**根 ref** 取真实 DOM：`const raw = rootRef.value as any; const root = raw?.$el ?? raw;`
     再检查 `typeof root?.querySelectorAll === 'function'`（H5 的 `<view>` ref 是组件实例，必须先取 `$el`）
   - `querySelectorAll('[data-hand-key]')`，按 `data-hand-key` 记录旧 `getBoundingClientRect()` 与**旧展示 key 顺序**
   - ⚠️ **旧顺序必须从 DOM 读**：`onBeforeUpdate` 时 `props.cards` 已是新手牌，不能从 props 反推
2. **`onUpdated`**（DOM 已更新）：
   - 先执行 §3.1 守卫
   - **先取消**该元素上一轮由本组件启动的 FLIP（`WeakMap<Element, Animation>`，只取消自己的，不得取消 `.anim-deal-in` 等 CSS 动画）
   - 再查询新 `data-hand-key` 顺序与 rect
   - 若新旧 key 顺序相同（例如只是 `selected` 变化）⇒ 直接返回
   - 计算画布缩放：`scale = root.getBoundingClientRect().width / root.offsetWidth`
     （优先用**手牌根元素**，不用单张牌：牌自身的选中抬升/发牌动画可能污染 rect 宽度）
   - `dx = (oldRect.left − newRect.left) / scale`，`dy = (oldRect.top − newRect.top) / scale`
   - `|dx| < 0.5 && |dy| < 0.5` ⇒ 跳过（不制造无意义动画）
   - 启动：
     ```ts
     el.animate(
       [
         { translate: `${dx}px ${dy}px` },
         { translate: '0px 0px' },
       ],
       { duration: 200, easing: 'ease-out' },
     );
     ```
   - **使用独立 `translate` 属性，不用 `transform`**：
     - 与 `.anim-deal-in`（CSS animation）和 `.card--selected`（`transform: translateY(-24px)`）互不覆盖
     - 终帧恒为 `0px 0px`，不需要 `getComputedStyle`（避免过渡起始值污染）
     - 不受 Card 自带 `transition: transform 0.08s` 干扰

### 3.3 属性

仅在 `reflow` 为真时给 `<Card>` 传 `:data-hand-key="entry.key"`；Card 根节点是单个按钮元素，attr 会正常落到根元素（H5 上是 `<uni-button>`；class/data 透传已被现有浏览器探针证明）。

### 3.4 守卫（缺一不可）

- `props.reflow === true`
- `typeof window !== 'undefined' && typeof document !== 'undefined'`
- `typeof window.matchMedia === 'function'`
- `window.matchMedia('(prefers-reduced-motion: reduce)').matches === false`
- `typeof CSS !== 'undefined' && CSS.supports('translate', '0px')`
- `typeof Element !== 'undefined'` 且 `typeof el.animate === 'function'`

任一不满足 ⇒ 跳过 FLIP（稳定 key 仍然生效）。

---

## §4 跨端行为

| 平台 | 行为 |
|---|---|
| H5 | 稳定 key + 剩余牌 200ms 平滑滑动（局部坐标，已除以画布 scale） |
| 小程序 / App | `isH5Runtime` 为假 ⇒ 不碰 DOM；稳定 key 仍生效（不再重播发牌动画），瞬时重排 |

如果未来要求三端都滑动，需要改用 `uni.createSelectorQuery` 异步测量方案，不在本次范围。

---

## §5 边界与风险

| 项 | 处理 |
|---|---|
| 画布 `scale(k)` | rect 是视口坐标、卡片 transform 是局部坐标 ⇒ **必须除以 `scale`**；真机验收覆盖 k≈0.52 |
| 快速连续出牌 / resync | 同一元素的新 FLIP **先 cancel 旧动画、再测新 rect**，从最后看到的视觉位置起动画 |
| 发牌动画未播完就出牌 | FLIP 用独立 `translate`，与 `transform` 的 CSS 动画互不覆盖 |
| 选中抬升 | 同上，`translate` 与 `.card--selected` 的 `transform` 组合渲染，不需要读基值 |
| 点击命中 | 200ms 滑动期间卡片在移动，快速点击可能点到相邻牌；验收时专门确认手感，不做“动画期间禁点击” |
| `selected` 变化但手牌不变 | key 顺序相同 ⇒ 跳过 FLIP |
| 手牌清空 / 首次发牌 | 无旧 rect 或无新 rect ⇒ 不跑 FLIP |
| 零位移 | `|dx| < 0.5 && |dy| < 0.5` ⇒ 跳过 |
| 重复牌面（仅测试） | 出现序号保证 key 唯一；删除其中一张时同面牌可能重建，允许 |
| 居中布局 | 手牌组缩小时整体重新居中：被删位置之前的牌可能右移、之后的牌左移；FLIP 两个方向都处理 |

---

## §6 明确不做

- 被出牌的“飞出”/退场动画。
- 小程序 / App 的平滑重排。
- 修改 flex 布局、负 margin 重叠、牌宽/牌高几何。
- 修改出牌区 `PlayArea`、底牌 `BottomCards` 的入场动画。
- 修改规则、协议、服务端、数据库。

---

## §7 测试与验收

### 7.1 单测

- `hand-keys.test.ts`（**只用唯一牌面**验证稳定性）
  - key = `${r}-${s}`
  - 按 `order` 返回，`index` 仍是原始下标
  - **删掉第一张后，剩余牌的 key 逐一不变**
  - 重复牌面：key 唯一且带 `#n`；删除其中一张时允许另一张序号变化（单独用例写明）
- `Hand` 组件测试（jsdom 下必须显式补齐能力，否则会假绿）
  - `window.matchMedia = () => ({ matches: false, ... })`
  - `Object.defineProperty(Element.prototype, 'animate', ...)` 装 spy，返回 `{ cancel() {} }`
  - `CSS.supports` stub 为 `true`
  - 按元素 mock `getBoundingClientRect`（新旧不同），断言 keyframes 的 `translate` 数值（含除以 root scale）
  - 手牌变短 ⇒ **每张幸存牌各调用一次** animate；`selected` 只变 ⇒ 0 次（新旧 rect 必须不同，否则是假绿）
  - 连续两次手牌更新：先 cancel 再测新 rect（rect 返回值依赖 cancel 是否发生）
  - reduced-motion / `CSS.supports` 为假 / 无 `Element.animate` ⇒ 各自 0 次且不抛错
  - 零位移（新旧 rect 相同）⇒ 0 次
  - `reflow=false` 即使有位移也不 animate
- 源码级闸（新增）
  - `Hand.vue` 的根 ref 解析必须出现 `$el` 兜底
  - FLIP 位移必须出现按 `offsetWidth` 计算的 scale 换算（防 B1 回归）

### 7.2 回归

- `apps/client` 全量测试 + `vue-tsc`
- 现有 `card-hand-interaction` 的 flex / 负 margin 源码闸保持不变

### 7.3 真浏览器验收

- 发牌 → 选牌 → 出牌：剩余牌**滑到新位置**（左右的牌可能反向移动），没有整手牌重播发牌动画
- 手机横屏（k≈0.52）与桌面（k≈1.4）各一次，确认没有起点跳变
- 出牌后立刻点牌：确认点击命中手感
- 出牌区、底牌不被误加动画
- `prefers-reduced-motion` 开启时无滑动

---

## §8 文件清单

```
新增
  apps/client/src/components/hand-keys.ts
  apps/client/test/hand-keys.test.ts

修改
  apps/client/src/components/Hand.vue
  apps/client/src/pages/table/table.vue     # 只加一个 :reflow="true"
  apps/client/test/card-hand-interaction.test.ts  # 源码级闸（$el / scale / reflow 接线）
新增测试
  apps/client/test/hand-reflow.test.ts       # 组件级 FLIP 用例
```

---

## §9 对抗审查处置（2026-10-17）

| ID | 结论 | 处置 |
|---|---|---|
| B1 | **BLOCKER**：rect 是画布 scale 后的视口坐标，直接当 translate 会二次缩放 | 已改为 `dx/dy = rect 差 / (rect.width / offsetWidth)`；真机验收覆盖 k≠1 |
| M1 | **MAJOR**：H5 `<view>` ref 是组件实例；`ref → $el` 顺序必须明确 | 已写死 `raw?.$el ?? raw` + `querySelectorAll` 检查 |
| M2 | **MAJOR**：FLIP `transform` 与选中抬升/`transition: transform` 冲突 | 已改为独立 `translate` 属性；终帧恒 `0px 0px` |
| M3 | **MAJOR**：快速更新必须**先 cancel 再测新 rect** | 已写入 §3.2 步骤顺序 |
| M4 | **MAJOR**：jsdom 缺 matchMedia/animate，测试会假绿 | 已写死 stub 清单 + 源码级闸 |
| M5 | **MAJOR**：仅 H5 需要显式运行时门控，守卫必须先于 ref | 已写 `isH5Runtime` 且两处 hook 首行判断 |
| m1 | 根因措辞不精确 | 已改 §1 |
| m2 | 重复牌面测试与稳定性冲突 | 已拆成两组用例 |
| m3 | 发牌动画期间终帧污染 | `translate` 方案消除 |
| m4 | 零位移仍动画 | 已加 `0.5px` 阈值 |
| m5 | `data-hand-key` 无条件挂载 | 仅在 `reflow` 时挂 |
| m6 | “左移”措辞与居中不符 | 已改“滑到新位置” |
| m7 | 旧顺序不能从 props 推 | 已写死从 DOM 读 |
| m8 | translate 单位/符号 | 已写 `${dx}px ${dy}px`、`dx = 旧 − 新` |
