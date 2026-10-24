# 重新发牌可感知化（叫地主全员不叫）设计

> 日期：2026-10-22 · 分支：`dev` · 类型：纯客户端小片
> 流程：`docs/dev-process.md` §1–§8

## 1. 背景与问题

叫抢阶段三家全不叫时，服务端 `resetBidding()` 重洗重发
（`packages/shared/src/ddz/bid.ts:188-206`）：`redealCount + 1`、`decisions` 清空、
`currentBidder` 重新摇号、手牌与底牌全部换新。

客户端当前的表现（已核实）：

1. **手牌几乎不动画**：`Hand` 的牌 key 是 `(点数, 花色)`（`hand-keys.ts:20-32`），
   重发时与旧手牌重复的牌**复用 DOM 节点**，只有少数新 key 的牌播 `.anim-deal-in`
   ⇒ “换牌”被拆成几张牌的零散跳动。
2. **回显瞬间消失**：三家「不叫」回显来自 `bidPhase.decisions`，重发时清空
   （`table.vue:446-451`）⇒ 桌面突然变空，没有任何解释。
3. **无横幅、无音效、无震动**；中央仍显示「叫抢中」（`table.vue:1112`）。
4. 结果是玩家不知道“已经重新发牌”，以为界面卡了或自己没看清。

服务端视图**已经**下发 `bidPhase.redealCount`（`packages/protocol/src/views.ts:136`、
`packages/game-service/src/game/view.builder.ts:104`）⇒ 本片是**纯客户端**改动，
不动协议 / 服务端 / 配置 / admin / 数据库。

## 2. 范围

### 做

- 检测到**真重发**时：
  - 整手牌强制重新入场，使用比首发更强的 `.anim-redeal-in`（幅度更大、错峰一致）；
  - 中央弹出横幅「**都不叫，重新发牌**」，约 2 秒后淡出；
  - `haptic('medium')` 一次（受用户震动开关约束）。
- 全链路测试 + Windows 先行验证。

### 不做（YAGNI / 用户裁决）

- **不加语音**（用户裁决 2026-10-22：暂不加语音；现有音频素材里也没有「重新发牌」）。
- **不做“收牌 → 暂停 → 重发”的两段式本地时间线**（用户在 3 个方案中选了“强提示”档）。
- **不对对手张数牌做弹跳**（未纳入本片；若走查觉得不够可另立微调）。
- 不改服务端、协议、配置中心、admin、数据库。
- 不新增音效 cue（因此 `cues.ts` / `PREHEAT_CUES` 不动）。

## 3. 决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | 触发判据 = `bidPhase.redealCount` **递增** 且 `view.state === 'bidding'` | 服务端唯一事实；不用手牌内容（重连/换局都会变）、不用 `decisions` 清空（那只是结果，不是判据） |
| D2 | **第 3 次流局不触发** | 服务端在 `redealCount >= 3` 时**不再重发**，同版视图直接 `state='playing'` 并随机指定地主（`bid.ts:124-129`）⇒ D1 的第二条件天然排除，避免误报“重新发牌” |
| D3 | **首版视图**（页面挂载 / `reset()` 后 `view===null` 的首个视图）只做**基线**，不触发；`view === null` 或 `redealCount` 回落时重置基线/状态。**同一页面存活期间的重连**（`view` 未被 `reset()` 清空、resync 视图 count 更高）**照常触发** —— 那是真实发生过的重发 | 进房/重进页面时 `redealCount` 可能已 > 0，不能补播历史；但同页面重连拿到的 count 增量对应的是**真正发生过**的重发，应当解释手牌为何变了。两者必须分开写（审查 H1） |
| D4 | 表现三件套：整手重发动画 + 中央横幅 + `haptic('medium')` | 用户裁决的“强提示”档；视觉为主，触感为辅助，无语音 |
| D5 | 计时器放在 `src/composables/useRedealNotice.ts` | 与 `useCountdown` / `useSettlementReveal` 同族先例；牌桌区源码闸只扫 `src/components/**` 与 `src/pages/table/**`（`animations.test.ts:39-52`、`table-bid-ui.test.ts:97-126`） |
| D6 | 横幅视觉由 CSS keyframes 负责（入 → 停 → 末段淡出），JS 计时器只做**兜底卸载** | `prefers-reduced-motion` 下动画被关掉时，计时器仍能移除横幅；不让“动画没跑”变成“横幅永久挂着” |
| D7 | 动画纪律照 §8：起始态可见（不用 `opacity: 0` 起手）、`backwards` 填充、错峰走 `--ftl-delay`、进 reduced-motion 清单 | 与既有 `.anim-deal-in` 同族；`both`/`forwards` 的填充值会永久压住 `.card--selected` 的抬升（`animations.scss:121-137` 的走查结论） |
| D8 | 文案 = 「都不叫，重新发牌」 | 全不叫时 `kind` 恒为 `'call'`（`bidKindOf`：`landlordCandidate === -1`），文案恒准确；与参考实现一致 |
| D9 | 重发档动画用 `enter='redeal'`；本局内 `enter` **单调**（epoch>0 后不回退） | 若把 `enter` 绑到“横幅是否可见”，2 秒后类切换会**重放**一次动画（CSS 类变化即重启动画）⇒ 绑定到 epoch，类在整个本局内稳定 |
| D10 | 选牌/FLIP/结算/音效游标全部不改 | 既有机制已覆盖：手牌指纹 watch 清空选中（`table.vue:204-218`）、`useTableSound` 已处理 decisions 清空（`useTableSound.ts:119-133`） |
| D11 | 横幅**只在叫抢期存在**：视图 `state` 离开 `'bidding'` 时立即隐藏并清计时器 | 机器人在 2 秒内可再走到第 3 次流局（不再重发、直接定地主）⇒ 若只靠计时器，横幅会滞留到出牌期，文案变成假话 |
| D12 | `enter='redeal'` **只作用于重挂载那一批牌**；之后在同一 Hand 实例里新出现的牌（地主摸的 3 张底牌、断线补齐）走普通 `.anim-deal-in` | 审查 H3：`enter` 同时是“后续挂载”的档位；若整局单调，地主摸底牌会用重发动画，与底牌的翻牌语汇撞车。Hand 在挂载时记录首批 key，后续新 key 降回发牌档 |

## 4. 实现设计

### 4.1 `apps/client/src/composables/useRedealNotice.ts`（新增）

```ts
export const REDEAL_BANNER_MS = 2000;

export function useRedealNotice(): {
  /** 横幅是否可见 */
  visible: Ref<boolean>;
  /** 真重发次数（本地表现用）；同时作为 Hand 的 key */
  epoch: Ref<number>;
};
```

逻辑：

1. `watch(() => store.view?.bidPhase?.redealCount ?? null, cb, { immediate: true })`。
2. `count === null`（无视图 / 换局销毁）⇒ 清计时器、`visible=false`、`epoch=0`、基线置空。
3. 首次拿到非空 count ⇒ 只记基线，不触发（D3 的**首版视图**分支）。
4. `count < 基线`（新局）⇒ 清计时器、`visible=false`、`epoch=0`、更新基线（D3）。
5. `count > 基线` ⇒ 更新基线；若 `!store.isBidding` 直接返回（D2）；
   否则 `epoch += 1`、`visible = true`、重置计时器，`REDEAL_BANNER_MS` 后 `visible = false`。
   ⚠️ 这一支**同时覆盖**“同一页面存活期间的重连”：`view` 未被 `reset()` 清空 ⇒ 基线还在，
   resync 视图 count 升高 ⇒ 触发（D3；不是首版，不适用第 3 步）。
6. 第二个 watch（D11）：`store.view?.state` 离开 `'bidding'`（`playing` / `ended` / 视图消失）
   ⇒ 立即 `visible = false` 并清计时器（**不清 epoch** —— 手牌类的稳定性不依赖状态）。
7. `onScopeDispose` 清计时器（页面卸载不留悬挂回调）。

**纪律说明**：本文件不读牌面、不推断规则，只做“服务端数字变了 → 开/关一个展示位”。

### 4.2 `apps/client/src/components/Hand.vue`

- `enter` prop 增加 `'redeal'` 档：`redeal` → `anim-redeal-in`。
- **D12 的首批 key 记录**：挂载时 `const mountKeys = new Set(keyedOrder.value.map((e) => e.key))`；
  模板里每张牌的入场类只在 `enter === 'redeal' && !mountKeys.has(entry.key)` 时降回
  `anim-deal-in`，其余情况仍用 `enterClass`。⇒ 重发动画只属于重挂载那一批牌，
  之后新出现的牌（地主摸底牌 / 断线补齐）不再套用重发档。
- 其余逻辑零改动（排序、FLIP、滑动选牌、选中下标语义都不动）。

### 4.3 `apps/client/src/styles/animations.scss`

新增：

```scss
/// 重发整手入场：比首发位移更大、带旋转；仍从可见态起手（只动 transform）。
@keyframes ftl-redeal-in {
  from { transform: translateY(-48px) rotate(-8deg) scale(.86); }
  to { transform: none; }
}
.anim-redeal-in {
  animation: ftl-redeal-in .46s $ftl-ease backwards;
  animation-delay: var(--ftl-delay, 0ms);
}

/// 重新发牌横幅：入场（缩放可见）→ 停留 → 末段淡出。时长由内联变量给（与 JS 常量同源）。
@keyframes ftl-redeal-banner-life {
  0% { transform: scale(1.18); opacity: 1; }
  12% { transform: scale(1); opacity: 1; }
  82% { opacity: 1; }
  100% { opacity: 0; }
}
.anim-redeal-banner {
  animation: ftl-redeal-banner-life var(--ftl-redeal-ms, 2000ms) $ftl-ease both;
}
```

- 两个新类加入 `prefers-reduced-motion` 的 `animation: none !important` 清单。
- `.anim-redeal-in` 必须 `backwards`（同 D7；测试会把这条钉住）。

### 4.4 `apps/client/src/pages/table/table.vue`

1. 引入并解构（**必须解构成顶层 ref**，模板才会自动解包）：

```ts
const { visible: redealVisible, epoch: redealEpoch } = useRedealNotice();
const dealEnterMode = computed<'deal' | 'redeal'>(() => (redealEpoch.value > 0 ? 'redeal' : 'deal'));
```

2. 手牌：

```html
<Hand :key="redealEpoch" :enter="dealEnterMode" ... />
```

3. 横幅（放进既有 `.table__phase-overlay`，横幅可见时让出阶段文字，避免叠字）：

```html
<view v-if="!settlementRevealed" class="table__phase-overlay">
  <view
    v-if="redealVisible"
    :key="redealEpoch"
    class="table__redeal-banner anim-redeal-banner"
    :style="{ '--ftl-redeal-ms': `${REDEAL_BANNER_MS}ms` }"
  >
    <text class="table__redeal-text">都不叫，重新发牌</text>
  </view>
  <text v-else-if="store.isBidding" class="table__phase">叫抢中</text>
  <text v-else-if="store.isPlaying" class="table__phase">出牌中</text>
  ...
</view>
```

> `:key="redealEpoch"`：连续两次重发时元素重建 ⇒ CSS 动画重播；`:style` 里只有
> 一个 CSS 变量，不新增颜色/尺寸字面量以外的动画参数。

4. 震动：

```ts
watch(redealEpoch, (n, o) => {
  if (n > o) haptic('medium');
});
```

> 监听 `epoch` 而不是 `visible`：两次重发间隔 < 2s 时 `visible` 一直为 true，
> 监听 visible 会漏掉第二次震动；epoch 单调递增，每次都能命中。重置到 0（n < o）不震。

5. 样式（`table.vue` 的 scoped 样式，已在文件顶部 `@import` animations.scss）：

```scss
.table__redeal-banner {
  display: flex;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-7;
  border: $ftl-hairline solid $ftl-color-gold;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night-deep, 0.86);
  box-shadow: 0 6px 24px rgba($ftl-color-night-deep, 0.5),
    0 0 16px rgba($ftl-color-gold, 0.35);
  pointer-events: none;
  white-space: nowrap;
}
.table__redeal-text {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-lg;
  font-weight: 700;
  letter-spacing: 2px;
  text-shadow: 0 2px 6px rgba($ftl-color-night-deep, 0.7);
}
```

> 横幅在 `.table__phase-overlay` 的 flex 列里，**自身不写居中 transform**
> —— 否则会和 `ftl-redeal-banner-life` 的 `transform: scale()` 互相覆盖。

### 4.5 不改的东西

- `useTableSound`（decisions 游标已处理清空）、`BottomCards`、`Seat`、`BidPanel`。
- `cues.ts` / `PREHEAT_CUES`（本片不加语音/音效）。
- 服务端、协议、配置、admin。

## 5. 测试判据

### 5.1 新增 `apps/client/test/redeal-notice.test.ts`

组合两层：composable 单测（`effectScope` + store）与页面集成（`FakeSocket` + `mount(TablePage)`）。

| # | 用例 | 断言（判别力） |
|---|---|---|
| T1 | 挂载时视图已有 `redealCount: 1` | `visible=false`、`epoch=0`（基线，不补播） |
| T2 | 基线 0 → 推 `redealCount: 1` 且 bidding | `visible=true`、`epoch=1`；1999ms 仍可见，2000ms 后 `visible=false` |
| T3 | 2s 内连续两次重发 | `epoch=2`；第二次从触发时刻重新计时（2000ms 后消失） |
| T4 | `redealCount` 递增但 `state='playing'`（第 3 次流局） | 不触发（`visible=false`、`epoch` 不变） |
| T5 | `count` 回落（新局） | `visible=false`、`epoch=0` |
| T6 | `view` 变 null | `visible=false`、`epoch=0`，计时器被清理 |
| T7 | 页面集成：推重发视图 | `.table__redeal-banner` 存在且文本 = 「都不叫，重新发牌」；`.table__phase` 此时不渲染 |
| T8 | 页面集成：重发后整手重挂载 | 第一张牌 DOM 元素身份改变；`.table__me .hand .card` **全部**带 `.anim-redeal-in`（首发时是 `.anim-deal-in`）。⚠️ 范围必须限定手牌区：底牌位在叫抢期也渲染 3 张 `.card`（`enter="none"`） |
| T9 | 页面集成：2s 后 | 横幅消失、「叫抢中」回来 |
| T10 | 页面集成：首版视图 `redealCount:1` | 无横幅、牌是 `.anim-deal-in`（不误播） |
| T11a | 页面集成：首版 count=2 → 推 count=3 `playing` | 无横幅；手牌照旧是 `.anim-deal-in`（该玩家从未观测到重发） |
| T11b | 页面集成：已观测一次重发（epoch=1）→ 推 count=3 `playing` | 无横幅；第一张牌元素身份**不变**（未重挂载，D2）；epoch 不变 |
| T12 | 震动 | 真重发时 `uni.vibrateShort` 计数 +1；第 3 次流局不增加 |
| T13 | 横幅可见时 `state` 离开 bidding | 横幅**立即**消失（不等 2s），且不改变 epoch |
| T14 | 同页面重连语义（D3）：首版基线 1 → resync 推 count 2 | 触发：`visible=true`、`epoch=1`（“view 保留 + count 升高”就是真实重发，不是首版基线） |
| T15 | 横幅消失后**不得**重放整手动画（D9） | 2s 后第一张牌元素身份不变、类仍为 `anim-redeal-in`（若把 `enter` 绑到 `visible`，类会切回 `anim-deal-in` ⇒ 红） |
| T16 | 2s 内第二次重发（D9 的横幅 `:key`） | 横幅元素身份改变（`:key=redealEpoch` 重建重播）；若删掉 `:key`，元素复用 ⇒ 红 |

> T2/T3/T6/T9/T13/T15/T16 用 `vi.useFakeTimers()`；挂载前安装，`afterEach` 恢复并卸载页面
> （`useCountdown` 有 250ms interval，必须卸载）。

### 5.2 扩展 `apps/client/test/animations.test.ts`

- `.anim-redeal-in` 必须存在且 `animation: ... backwards`，不得含 `both`/`forwards`
  （与 `.anim-deal-in` 同一条理由：选中抬升不得被填充值压住）。
- `prefers-reduced-motion` 的媒体查询块必须同时包含 `.anim-redeal-in` 与 `.anim-redeal-banner`
  （花括号配对截块，不用裸 `toContain`）。
- **单一真源闸（审查 L4）**：`.anim-redeal-banner` 的 `var(--ftl-redeal-ms, …)` 兜底值
  必须等于 `useRedealNotice` 导出的 `REDEAL_BANNER_MS`（跨文件文字比对；改一处漏改另一处会红）。
- 既有「牌桌区不新造时钟」扫描保持绿（`useRedealNotice` 在 composables，不在扫描面）。

### 5.3 回归

- `pnpm -C apps/client test`（全量）
- `pnpm -C apps/client run lint`（vue-tsc）
- `pnpm -C apps/client build`（uni build，真构建；组件样式 @import 纪律只有真构建会红）

## 6. 错误处理与边界

| 边界 | 行为 |
|---|---|
| 进房 / 重进页面（挂载时 `view` 已存在，或 `reset()` 后首个视图 `redealCount` 已 > 0） | 首版只做基线，不弹横幅、不重放动画（D3 首版分支） |
| 同一页面存活期间的断线重连（`view` 未被 `reset()` 清空，resync 视图 count 更高） | 照常触发（D3 重连分支）：这是**真实发生过**的重发，横幅解释手牌为何变了 |
| 第 3 次流局（不再重发） | 同版视图 `state=playing` ⇒ 不触发（D2）；若此时横幅仍在，状态 watch 立即收掉（D11） |
| 换局（`view` 置 null / `redealCount` 回落） | 清计时器、横幅消失、epoch 归零（下一局首发走 `.anim-deal-in`） |
| 机器人在 2s 内再次造成重发 | `epoch+1`、横幅元素以 `:key` 重建重播、计时器重置、震动再响一次 |
| 重发后地主摸底牌（同一 Hand 实例新增 3 张） | 新牌走普通 `.anim-deal-in`（D12），不与底牌翻牌语汇撞车 |
| 跨局且 `redealCount` 恰好相等（局 1 重发过、断线跨局、新局首见视图 count 等于旧基线） | **已知局限（代码审查 Minor 4）**：`PlayerView` 无对局标识（无 matchId），客户端无法区分“同一局”与“新局” ⇒ 基线沿用，新手中与旧手牌重叠 key 的牌会复用旧 DOM 节点（约 5/17 张不播入场动画）。不弹横幅（这点正确）。将来视图加局标识，或在可观测到 `ended → bidding` 转换时重置基线，可修 |
| `prefers-reduced-motion: reduce` | 动画被 `animation: none !important` 关掉；横幅仍由计时器在 2s 后移除（静态可见 2s） |
| 页面卸载时横幅还在 | `onScopeDispose` 清计时器；不产生悬挂回调 |
| 视图缺字段（探针残缺视图） | `?.` + `?? null`，永不抛错；reduced-motion/降级路径不依赖动画 |
| 选牌与手牌下标 | 既有手牌指纹 watch 清空选中；本片不改该链路 |
| 横幅遮挡 | `pointer-events: none`；位于中央上方 28%，不挡手牌与动作按钮；显示期间让出「叫抢中」文字 |

## 7. 风险

1. **`Hand` 重挂载成本**：17 张牌重建一次，量级与首次进桌相同；仅在重发时发生。
2. **类切换重放**：`enter` 若与横幅可见性绑定会二次播放动画 ⇒ D9 用 epoch 单调值规避，
   并由 **T15** 钉住（横幅消失后元素身份与类都不变）。
3. **横幅重建重播**：两次重发间隔 < 2s 时必须重建横幅元素 ⇒ **T16** 钉住 `:key`。
4. **重发档语义泄漏**：`enter='redeal'` 是 Hand 的全局档，后续新牌会被误套 ⇒ D12 的
   mountKeys 规避，并由 Hand 组件用例（新 key 降回 `anim-deal-in`）钉住。
5. **计时器落点**：放在 composables 是对既有纪律的**合规使用**（同 `useSettlementReveal`），
   不是绕闸；源码扫描面保持不变。
6. **文案准确性**：全不叫时 `kind` 必为 `'call'`（D8）；若将来出现“抢阶段流局也能重发”
   的规则变更，需要重新审视文案。
7. **观感**：动画幅度与横幅样式只有真浏览器/真机走查能证明；单测只钉机械事实
   （类、时序、元素身份、文本），不造假判据。

## 8. 涉及文件

| 文件 | 动作 |
|---|---|
| `apps/client/src/composables/useRedealNotice.ts` | 新增 |
| `apps/client/src/components/Hand.vue` | `enter` 增加 `'redeal'` 档 + D12 的首批 key 记录 |
| `apps/client/src/styles/animations.scss` | 新增两个动画 + 降级清单 |
| `apps/client/src/pages/table/table.vue` | 接线、横幅模板/样式、震动 |
| `apps/client/test/redeal-notice.test.ts` | 新增（T1–T16） |
| `apps/client/test/card-hand-interaction.test.ts` | Hand `enter='redeal'` + D12 新牌降档用例 |
| `apps/client/test/animations.test.ts` | 扩展机械闸（backwards / 降级清单 / 时长单一真源） |

## 9. 审查记录

### 第一轮：独立对抗审查（子代理，2026-10-22）

结论：**无阻断**；3 高、4 低。判据等价性、计时器/生命周期、层叠、源码闸面均核实无问题。

| 编号 | 级别 | 结论 | 处置 |
|---|---|---|---|
| H1 | 高 | §6 边界表自相矛盾：既承诺“重连不弹横幅”又承诺“断线重连照常触发”；D3 措辞只覆盖首版 | D3 重写为「首版视图只做基线；同一页面存活期间的重连（view 保留 + count 升高）照常触发」；§6 拆成两行；新增 **T14** 钉住重连语义 |
| H2 | 高 | D9 的两条行为零判据：把 `enter` 绑到 `visible`、或删掉横幅 `:key`，T1–T13 全绿而真机会重放/漏播 | 新增 **T15**（横幅消失后元素身份与类不变）与 **T16**（2s 内第二次重发横幅元素重建）；§7 风险同步改指向 |
| H3 | 高 | `enter='redeal'` 整局单调会把地主摸的 3 张底牌也套上重发动画；且 T11 的「无 `.anim-redeal-in`」在忠实建模下必假红 | 新增 **D12**：Hand 挂载时记录首批 key，后续新 key 降回 `anim-deal-in`；T11 拆为 T11a（首版 count=2 后第 3 次流局）与 T11b（已观测重发后第 3 次流局，断言元素身份不变） |
| L1 | 低 | T8 的「所有 `.card`」范围过宽（底牌位也渲染 `.card`） | T8 限定 `.table__me .hand .card`，并注明底牌位 |
| L2 | 低 | §8 文件表仍写 T1–T12；fake-timers 注漏列 T13 | 已改为 T1–T16，并更新 fake-timers 注 |
| L3 | 低 | “保留视图的重连照常触发”无判据 | 新增 **T14**（与 H1 同一处置） |
| L4 | 低 | `--ftl-redeal-ms` 兜底 2000ms 是 `REDEAL_BANNER_MS` 的第二份字面量，会静默漂移 | §5.2 新增跨文件单一真源闸：CSS 兜底值必须等于导出常量 |

处置后状态：**H1/H2/H3 已落成设计决策与可证伪判据；L1–L4 已全部处置**。可进入实现计划阶段。

### 第二轮：代码审查（独立 reviewer，2026-10-22）

结论：**0 Critical / 0 Important / 5 Minor，可交付**。审查方自行复跑全量 1317 tests、vue-tsc、uni build，
并用变异测试验证了 D2 / D9 / D11 的判据有效（去闸/改绑后对应用例变红）。

| 编号 | 级别 | 结论 | 处置 |
|---|---|---|---|
| M1 | Minor | “震动绑 epoch 而非 visible”的设计理由零判据：改成绑 visible 后 17 个新用例全绿 | 新增 **T12b**：2 秒内两次重发必须震两次 |
| M2 | Minor | `onScopeDispose(clearHide)` 零判据：删掉后 17/17 仍绿 | 新增 **T6b**：触发后 `scope.stop()`，断言 `vi.getTimerCount()===0` |
| M3 | Minor | T10/T11a 的牌类循环可能空转（选择器失效时循环 0 次即绿） | 循环前补 `expect(cards).toHaveLength(17)` |
| M4 | Minor | 跨局且 `redealCount` 恰好相等时基线不重置（视图无 matchId，无法区分） | **登记为已知局限**（§6 边界表 + §7）；不做本地推断式修补 |
| M5 | Minor | `'anim-deal-in'` 字面量在 `Hand.vue` 有两份 | 提取 `DEAL_CLASS` 常量，映射与 D12 降档共用 |

处置后状态：**M1–M3、M5 已修并补测试；M4 已登记**。进入全量验证。
