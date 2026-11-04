# 四川麻将 UI 升级 · Batch 2 设计

> **状态**：设计 v0.2（修完第 1 轮对抗审查 5 阻断 + 9 高）
> **定位**：Batch 1 已做完"看起来像个麻将桌"（4 方向牌面 + 牌桌背景 + 双击出牌 + 副露堆叠），Batch 2 升级为"动起来的牌桌"。
> **范围**：动作 CSS keyframe 动画 + 胡牌标记 + 定缺推荐高亮 + 出牌飞入弃牌河 + 当前玩家指示。
> **不做**：音效接线（**已接好** `useTableSound.ts`）、弃牌河重构（Batch 3）、结算美化（Batch 3）、聊天/表情/回放（后续）、新增时钟。
> **接触面**：纯客户端 `apps/client/src/`，**不动** protocol / shared / game-service / room-service。

---

## §0 用户裁决

| # | 裁决 | 影响 |
|---|---|---|
| K1 | Batch 2 先做"动起来"的视觉反馈 | 动作动画 / 胡牌标记 / 定缺推荐 / 当前玩家指示 |
| K2 | 参考 babykylin 的 `play_hu/play_peng/play_gang/play_zimo` 动画 + `HuPai` 标记 | CSS keyframe 实现，不用 Cocos Animation Clip |
| K3 | 继续纯客户端 | 不动后端/协议/服务端 |

---

## §1 背景与现状

### Batch 2 音效已接好（好消息！之前误判）

搜索发现 `apps/client/src/composables/useTableSound.ts:L123-L172` 里麻将音效**已经全部接好**：

| 触发 | 音效 cue | 代码位置 |
|---|---|---|
| 碰新增 | `MjPeng` | L157 |
| 暗杠新增 | `MjRain` | L158 |
| 直杠新增（刮风） | `MjGuafeng` | L161 |
| 补杠（碰→杠） | `MjGang` | L161 |
| 胡牌人数↑ | `MjHu` | L164 |
| 换三张→定缺 | `MjSort` | L166 |
| 定缺→play | `MjDeal` | L167 |
| 开局洗牌 | `MjShuffle` | L147 |

**Batch 2 不做音效接线**——零改动。

### Batch 2 真正缺的

| # | 现状 | 要做 |
|---|---|---|
| 1 | 胡牌后只有座位徽标文字"胡 N 番"，没有视觉爆点 | 胡牌飞出 banner 动画 + 座位头顶胡牌标记 |
| 2 | 碰/杠/自摸发生时无声无息（只有声音），没有视觉"爆开" | 副露新增时播放 `ftl-peng-pop` / `ftl-gang-pop` CSS keyframe |
| 3 | 定缺阶段三个按钮都平扁，用户不知道推荐哪个 | 自动计算手牌最少花色，给对应按钮加 `ftl-urgent-pulse` 呼吸高亮 |
| 4 | 当前轮到谁出牌只有倒计时，没有"箭头/光效"指示 | `activeSeats` 里的座位加 `mj-seat--active-glow` 发光边框动画 |
| 5 | 出牌后那张牌只是"消失"，没有"飞出"到弃牌河的视觉流 | 出牌瞬间手牌 fly-out + 弃牌 fly-in CSS keyframe |

---

## §2 范围

### 2.1 本片做

1. **副露新增 pop 动画**：`MahjongMeld.vue` 的根元素加 `ftl-peng-pop` / `ftl-gang-pop` / `ftl-angang-pop` 类，进场播一次。
2. **胡牌 banner 飞出**：`MahjongBoard.vue` 内部加 `.mj__hu-banner` 浮动 view，收到 `huInfos` 增量时从胡牌座位头顶飞出 1.2s 后消失（`animation-fill-mode: forwards` 自动退场，零 JS 定时器）。
3. **定缺推荐高亮**：`phase='lack' && amActive` 时，计算手牌里三种花色数量最少的那种，给对应按钮加 `.anim-urgent-pulse`（已在 animations.scss 里）。
4. **当前玩家发光**：`MahjongSeatPanel.vue` 里 `active=true` 时加 `.mj-seat--active-glow` 类（`box-shadow` 循环动画已在 animations.scss 里）。
5. **出牌飞入弃牌河**：双击出牌瞬间，被双击的那张手牌先 `ftl-fly-out`（向上飞出），同时弃牌河末尾新增的牌 `ftl-played-in`（已有 keyframe）入场。

### 2.2 明确不做

- 音效接线（已接好）
- 弃牌河重构（仍在 SeatPanel 里，Batch 3 再移到中央独立区域）
- 出牌"河"扇形排列
- 结算界面美化（Batch 3）
- 聊天 / 表情 / 语音（后续）
- 拖拽/上滑出牌（Batch 2 结束后观察双击使用率再决定）
- 新增时钟（沿用 animations.scss 闸：零 JS 定时器，错峰靠 `--ftl-delay`）
- 动效时长/缓动值照 animations.scss 现有纪律：`cubic-bezier(.22,1,.36,1)` + `animation-fill-mode: both`

---

## §3 设计

### D1 · 动画关键值（从 animations.scss 纪律出发）

现有 keyframe 可复用，缺的新建：

| keyframe | 时长 | 缓动 | 用途 | 新建/复用 |
|---|---|---|---|---|
| `ftl-peng-pop` | 0.36s | 标准 | 碰新增时副露入场：`scale(0.6) translateY(12px) → 1` | **新建** |
| `ftl-gang-pop` | 0.42s | 标准 | 杠新增时（4 张叠弹一下） | **新建**（比 peng 长一点体现"更重"） |
| `ftl-angang-pop` | 0.48s | 标准 | 暗杠（牌背叠一起，弹出更隐蔽） | **新建** |
| `ftl-hu-banner` | 0.8s | 标准 | 胡牌 banner：**起始态可见**（opacity:1），只动 transform。`0%: scale(1.3) translateY(-8px) → 某帧: none 停留 → 100%: scale(0.9) translateY(-20px) opacity:0`（opacity 只在结束态淡出，起始态全可见） | **新建**（闸纪律 v0.2 修正：B1 起始态 opacity:0 阻断） |
| `ftl-fly-out` | 0.24s | 标准-ease-out | 手牌双击后**向右上**飞出弃牌河位置（translateY -20px + translateX 12px） | **新建**（v0.2 修正：L2 方向从"向上"改"向右上"对齐弃牌河） |
| `ftl-played-in` | 0.24s | 标准 | 弃牌河新增牌入场（已有，复用） | ✅ 复用 |
| `ftl-deal-in` | 0.36s | 标准 | 发牌入场（已有，换三张完/定缺完后手牌整体入场） | ✅ 复用 |
| `ftl-urgent-pulse` | **0.8s 循环** | ease-in-out | 末 5 秒倒计时紧迫态（已有，**不复用**给定缺——时长不同、视觉目的不同） | ✅ 已存在 |
| `ftl-lack-pulse` | 1.6s 循环 | ease-in-out | **新建**：定缺推荐按钮呼吸（和 urgent-pulse 同 keyframe 但时长不同，不污染已用组件） | **新建**（v0.2 修正：H1 时长 1.6s vs 实际 0.8s 硬冲突，拆为独立 keyframe） |

**闸纪律（animations.scss §§）重申**：
- `@import` 进组件，不能 `@use`
- 起始态必须**可见**（不 opacity: 0）——动画里 opacity 只允许出现在结束态淡出
- 零 JS 定时器（动画自动退场靠 `animation-fill-mode: forwards` + 固定时长，错峰靠内联 `--ftl-delay`）
- 新类名统一 `anim-` 前缀（如 `anim-meld-pop` / `anim-hu-banner` / `anim-fly-out`）
- **`@media (prefers-reduced-motion: reduce)` 里必须手动追加所有新 `anim-` 类**（animations.scss L222-236 逗号列表）
- 循环动画（glow/pulse）缓动用 `ease-in-out`（和现有 ftl-urgent-pulse 一致）；一次性动画用 `$ftl-ease`（cubic-bezier(.22,1,.36,1)）
- `$ftl-ease` 变量只在 import animations.scss 后才可用来——**MahjongMeld.vue / MahjongSeatPanel.vue 当前缺 import，Batch 2 必须先加**

---

### D2 · MahjongMeld.vue pop 动画触发

**v0.2 核心修正（B3 阻断）**：放弃"所有 mount 都播"方案——玩家中途重连/进入房时已有 5 个副露会同时 mount 同时 pop，视觉爆炸。改用 **增量判定**：Board.vue 维护一个 `Set<string>`（`meldBootstrapped`），mount 时先记录已有副露的 key（`kind + tiles.map(tileType).join('_')`），`onMounted` 后置 `initialBootDone = true`；只有 boot 之后 watch 到的新增 meld 才给 `.mj-meld--new` 类触发 pop。

**实现方式**：

Board.vue 新增逻辑：
```ts
// 防中途进入 mount 爆炸（B3）
const initialBootDone = ref(false);
const seenMeldKeys = new Set<string>();

onMounted(() => {
  // 记录所有现有副露的 key
  for (const meld of view.value?.melds.flat() ?? []) {
    seenMeldKeys.add(meldKey(meld));
  }
  initialBootDone.value = true;
});

function meldKey(m: MahjongMeldView): string {
  return `${m.kind}:${m.tiles.map(tileType).join('_')}`;
}

// watch 所有玩家的 meld 变化，标记新增
const newMeldKeySet = ref<Set<string>>(new Set());
watch(
  () => view.value?.melds.flat() ?? [],
  (melds) => {
    if (!initialBootDone.value) return;
    for (const m of melds) {
      const k = meldKey(m);
      if (!seenMeldKeys.has(k)) {
        seenMeldKeys.add(k);
        newMeldKeySet.value.add(k);
        // 360ms 后清掉（动画播完即去类）
        setTimeout(() => newMeldKeySet.value.delete(k), 500); // ⚠️ 这里用了 setTimeout 但不在 Board.vue 组件里——是 mahjong 专用，算小范围例外？需要审查
      }
    }
  },
  { deep: true },
);
```

**等等——上面 setTimeout 违反零 JS 定时器闸**（B2 reviewer 也指出）。用更干净的方案：

**最终方案**：
1. MahjongMeld.vue 新增 prop `pop?: boolean`（默认 false）
2. Board.vue 给每个 MahjongMeld 传 `:pop="newMeldKeySet.has(meldKey(meld))"`
3. MahjongMeld.vue 内部 watch `pop` 从 false→true 时给根元素加 `.mj-meld--pop` 类，加一个 CSS `animation-duration + 50ms` 的 `animationend` 事件监听自动移除 `.mj-meld--pop`
4. watch 变化时 MahjongMeld 的 `:key` 改成 `meldKey(meld)`（稳定标识，服务端增量追加不会中间插入）

**不触发 pop 的场景**：中途进入房、view 重连、phase 切换重渲染——因为 initialBootDone 在 onMounted 后才设 true，之前已有 meld 一律不标记 new。

**时长统一（H6 修正）**：peng=0.36s / gang=0.42s / angang=0.42s（angang 不再更长，统一和 gang 同——因为暗杠牌背视觉上已经够区分，时长差异化反而自相矛盾）。

**闸纪律**：animations.scss 追加 `ftl-peng-pop / ftl-gang-pop / ftl-angang-pop` 三个 keyframe，对应类名 `anim-meld-pop`（peng 默认 0.36s）+ modifier 类 `anim-meld-pop--gang` / `anim-meld-pop--angang`。MahjongMeld.vue 必须先加 `@import '../../styles/animations.scss'`（B5 阻断：当前无 import）。

---

### D3 · 胡牌 banner 飞出

**v0.2 核心修正（H3 高）**：watch `huInfos.length` 不能识别血战到底多点胡（服务端可能一次推送包含多家）。改用 **diff Set** 模式：维护 `seenHuSeats = new Set<number>()`，每次 watch huInfos 时找 `seenHuSeats` 里没有的 seat → 加入 bannerQueue。

**组件**：新建 `MahjongHuBanner.vue`（轻量），内部：
```html
<view class="mj-hu-banner" :style="bannerStyle">
  <text class="mj-hu-banner__text">{{ type === 'zimo' ? '自摸' : '胡牌' }}</text>
  <text v-if="fan > 0" class="mj-hu-banner__fan">{{ fan }} 番</text>
</view>
```

**Board.vue 逻辑**：
```ts
const seenHuSeats = new Set<number>();
const bannerQueue = ref<Array<{ seat: number; fan: number; type: string }>>([]);
const currentBanner = ref<typeof bannerQueue.value[0] | null>(null);

watch(
  () => view.value?.huInfos ?? [],
  (infos) => {
    // Diff：找出本轮新增的胡家
    const newlyAdded: typeof bannerQueue.value = [];
    for (const info of infos) {
      if (!seenHuSeats.has(info.seat)) {
        seenHuSeats.add(info.seat);
        newlyAdded.push({ seat: info.seat, fan: info.fan, type: info.isZimo ? 'zimo' : 'hu' });
      }
    }
    // 入队；如果没有正在展示的 banner，立即展示第一个
    if (newlyAdded.length > 0) {
      bannerQueue.value.push(...newlyAdded);
      if (!currentBanner.value) showNextBanner();
    }
  },
  { deep: true },
);

function showNextBanner() {
  currentBanner.value = bannerQueue.value.shift() ?? null;
}
// banner 动画结束后（CSS animationend 事件 → MahjongHuBanner emit 'done'）调用 showNextBanner()
```

**定位方案（H9 补充）**：Board.vue 根元素 `.mj` 有 `position: relative`，banner 用 `position: absolute; z-index: 10` 相对于 Board 定位。用 SeatPanel 的 `ref` 或 `directionOf(seat)` 算出座位的 approximate 位置（百分比），banner 飞出自座位上方。

**零 JS 退场**：`animation: ftl-hu-banner 0.8s $ftl-ease forwards`（v0.2 修正：起始态 opacity:1，只 transform；100% 才 opacity:0），MahjongHuBanner.vue 内部在 `animationend` 时 emit('done') → Board.vue 收 showNextBanner()。

---

### D4 · 定缺推荐高亮

**计算**（Board.vue 里）：
```ts
const lackRecommendation = computed<MahjongSuit | null>(() => {
  if (phase.value !== 'lack' || !amActive.value) return null;
  // 手牌必须加载完（至少 13 张）
  if (hand.value.length < 10) return null;
  // 统计手牌里三种花色数量
  const counts = [0, 0, 0];
  for (const t of hand.value) counts[t.s]++;
  // 找最少的那种
  let minIdx = 0, minCount = counts[0];
  let hasUniqueMin = true;
  for (let i = 1; i < 3; i++) {
    if (counts[i] < minCount) { minCount = counts[i]; minIdx = i; hasUniqueMin = true; }
    else if (counts[i] === minCount) { hasUniqueMin = false; }
  }
  // H7 edge case: 全相等不推荐；最小为 0（绝张/自动定缺）不推荐
  if (!hasUniqueMin) return null;
  if (minCount === 0) return null;
  return minIdx as MahjongSuit;
});
```

**模板改动**（Board.vue 的 lack 按钮块）：
```html
<button
  v-for="suit in ([0, 1, 2] as const)"
  :key="`lack-${suit}`"
  type="button"
  class="btn mj__lack"
  :class="{
    'anim-lack-pulse': lackRecommendation === suit,
    'mj__lack--recommend': lackRecommendation === suit,
  }"
  ...
>
  缺{{ MAHJONG_SUIT_NAMES[suit] }}
  <text v-if="lackRecommendation === suit" class="mj__lack--hint">推荐</text>
</button>
```

**CSS 补充**：`.mj__lack--recommend` 加金色边框 + 浅金背景。**闸纪律**：animations.scss 追加 `ftl-lack-pulse`（同 ftl-urgent-pulse keyframe 但 1.6s 循环），对应类名 `anim-lack-pulse`（v0.2 H1 修正：不复用已有的 anim-urgent-pulse 0.8s）。

---

### D5 · 当前玩家发光 + 出牌 fly-out

**D5-1 发光**（简单）：SeatPanel.vue 里 `.mj-seat--active` 已有 box-shadow `0 0 12px rgba($ftl-color-gold, 0.25)`（L142），把它改成循环动画 keyframe（H8 修正：keyframe 起始值对接现有 box-shadow，取消 active 时光效从循环瞬停回普通规则，可接受）：

```scss
// animations.scss 追加 keyframe
@keyframes ftl-active-glow {
  0%, 100% { box-shadow: 0 0 8px rgba($ftl-color-gold, 0.25); }
  50% { box-shadow: 0 0 22px rgba($ftl-color-gold, 0.55); }
}
.anim-active-glow {
  animation: ftl-active-glow 1.8s ease-in-out infinite;
}
```

SeatPanel.vue 里 `.mj-seat--active` 加 `anim-active-glow` 类（**闸纪律：SeatPanel.vue 必须先加 `@import '../../styles/animations.scss'`**，B5 阻断）。

**血战 claim 窗口多家 active（H5 登记）**：activeSeats 多家同时发光是业务常态，不做差异化。视觉上 2-4 个金色框同时闪动——用户能看但可能困惑。Batch 2 登记风险，Batch 3 观察使用率再决定是否弱化。

**D5-2 出牌 fly-out**（中等）：

v0.2 核心修正（B2 + H4）：
1. **flyingOutIndex reset 时机**：submit 后立即 `flyingOutIndex.value = -1`（不能等 phase 变化——phase 在 play 阶段出牌不变）
2. **submit 立即 emit，接受动画可能被截断**（H4 修正）：服务端延迟 <16ms 时动画可能还没渲染就被 DOM 替换——**不影响功能**。延迟 >100ms（网络常态）时动画完整播放。设计文档如实写这个行为边界，不引入 animationend 等待方案（避免事件驱动异步与零定时器闸的 gray area）

```ts
const flyingOutIndex = ref(-1);

if (isDoubleClick && tile) {
  // 触发 fly-out（CSS 立即生效，Vue 同步更新 DOM）
  flyingOutIndex.value = index;
  // 立即 emit——动画和服务端重绘并行，谁先到都 OK
  submit({ type: 'discard', tile });
  selected.value = [];
  lastClickIndex.value = -1;
  // ⚠️ 立即 reset，不等 phase 变化（B2 阻断修法）
  // 但 reset 太早 → CSS class 还没被浏览器应用到 DOM？
  // Vue 同步更新 DOM + CSS transition 下一帧才触发
  // flyingOutIndex = index → Vue 更新 DOM → CSS 下一帧渲染动画 → 我们 reset 为 -1
  // 这会导致 CSS class 瞬间移除，动画还没跑！
  // —— 所以实际上我们需要让 flyingOutIndex 保留到 hand 内容变化后再 reset
}
```

**等等——上面代码有新 bug！** 立即 reset 会让 CSS class 瞬间移除动画播不出。那正确修法是：**watch hand 内容变化（类似 L91-97 已有逻辑）时 reset flyingOutIndex**。因为出牌后服务端推新 view，hand 变短，L91-97 的 watch 已经触发 selected/lastClickIndex reset——在那里顺便 `flyingOutIndex.value = -1`。这样：
- T=0: flyingOutIndex = 5 → DOM 更新有 fly-out class → CSS 动画下一帧开始
- T=??ms: 服务端推新 hand → L91-97 watch 触发 → flyingOutIndex = -1 → fly-out class 移除
- 如果服务端极快（<16ms），动画没播出来就被移除——OK（功能没坏）
- 如果服务端 >16ms，动画完整播（至少几帧），播完后 class 才被移除——完美

**最终修法（B2 + H4 联合）**：
```ts
watch(
  () => hand.value.map(tileType).join(','),
  () => {
    selected.value = [];
    lastClickIndex.value = -1;
    flyingOutIndex.value = -1; // ← 加在这里
  },
);
```

**模板改动**（Board.vue 的手牌 v-for）：
```html
<MahjongTile
  v-for="(tile, i) in hand"
  :key="`hand-${i}`"
  ...
  :class="{ 'anim-fly-out': flyingOutIndex === i }"
/>
```

**闸纪律**：animations.scss 追加 `ftl-fly-out` keyframe（向右上飞出），对应类名 `anim-fly-out`。

---

### D6 · 发牌入场（小 bonus）

**v0.2 修正（H2 阻断）**：hand key 加 `phase+version` 导致每轮摸牌 version bump → 手牌整体重挂载播 deal-in → 每轮摸牌手牌"抽搐"一次。

**最终方案**：
1. **只用 phase 变化触发重挂载**——key 改成 `hand-${phase}-${i}`（不纳入 version）
2. 但这还会导致 `phase: play → claim → play`（一轮结束后下一轮开始时 phase 回到 play）时重播——Ok，这是合理的"新一轮发牌入场"
3. **phase: exchange → lack → play** 时 phase 两次变化，play 触发入场——Ok，这是"正式打牌"入场
4. **phase: play → claim → play** 时再次入场——**可以接受**，因为一轮开始时手牌"重新落定"的反馈不吵

所以 key 用 `hand-${phase}-${i}`，不纳入 version。**Phase 在同一轮 play 内不变**，所以不会每摸一张牌就重挂载。

Board.vue 手牌渲染：
```html
<MahjongTile
  v-for="(tile, i) in hand"
  :key="`hand-${phase}-${i}`"
  :tile="tile"
  ...
  :style="{ '--ftl-delay': `${i * 30}ms` }"
  :class="{ 'anim-deal-in': phase === 'play' }"
/>
```

**闸纪律**：复用 animations.scss 已有 `.anim-deal-in` 类（L134-137）——已在 reduced-motion media query 里覆盖。不需要新 keyframe。deal-in 类只在 phase === 'play' 时生效，phase 变了后类移除，但因为 deal-in keyframe 用 `backwards` 填充（L126-130 注释解释过），播完即归还 transform 给普通规则，不会压住选中态抬升。

**另：handAnimDone ref 完全删除（L3 reviewer 指出）**——deal-in 类只在 key 变化（phase 变 → 重 mount）时播一次，mount 后 anim-deal-in 类还在但 CSS 动画只跑一遍（非 infinite），之后 transform 回到 none。Phase 不 key 变 = 不重 mount = 不重播 = 自然完成。

---

## §4 涉及文件

| 操作 | 文件 | 说明 |
|---|---|---|
| **修改** | `apps/client/src/styles/animations.scss` | 追加 6 个 keyframe：`ftl-peng-pop` / `ftl-gang-pop` / `ftl-angang-pop` / `ftl-hu-banner` / `ftl-fly-out` / `ftl-active-glow` / `ftl-lack-pulse`；追加 6 个 `anim-` 类；**`@media (prefers-reduced-motion: reduce)` 里手动追加所有新 `anim-` 类到逗号列表** |
| **新建** | `apps/client/src/components/table/mahjong/MahjongHuBanner.vue` | 胡牌 banner 浮动 view（position: absolute, z-index: 10, 内部 animationend emit 'done'） |
| **修改** | `apps/client/src/components/table/mahjong/MahjongMeld.vue` | **先加 `@import '../../styles/animations.scss'`**（B5 阻断：当前无 import）；新增 `pop?` prop；内部 watch pop 播 `anim-meld-pop` 动画；key 改 `meldKey(meld)`（稳定标识） |
| **修改** | `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue` | **先加 `@import '../../styles/animations.scss'`**（B5 阻断：当前无 import）；`.mj-seat--active` 加 `anim-active-glow` 类；现有 box-shadow 保留（H8） |
| **修改** | `apps/client/src/components/table/mahjong/MahjongBoard.vue` | 定缺推荐高亮（lackRecommendation computed + anim-lack-pulse） / 胡牌 banner（seenHuSeats diff + bannerQueue FIFO） / 出牌 fly-out（flyingOutIndex + hand watch reset） / 发牌入场（hand key 改 `hand-${phase}-${i}` + anim-deal-in） / **mahjongMeld initialBootDone 防中途爆炸**（B3 阻断） |

**不动**：
- protocol / shared / game-service / room-service / config-service / admin —— 全零改动
- `useTableSound.ts` —— 音效已接好，不动
- MahjongTile.vue —— 不动（fly-out 的 anim-fly-out 类由 Board.vue 模板加）

---

## §5 测试判据

| # | 判据 | 类型 |
|---|---|---|
| T1 | animations.scss 新增 7 个 keyframe 都走 `@keyframes ftl-xxx` 命名；一次性动画缓动 `$ftl-ease`；循环动画（glow/pulse）缓动 `ease-in-out`；**所有新类名 `anim-` 前缀** | 规范 |
| T1a | animations.scss 的 `@media (prefers-reduced-motion: reduce)` 里手动追加了 7 个新 `anim-` 类 | 闸 |
| T1b | 新增 keyframe 全部**起始态可见**（opacity 只在结束态出现）；peng-pop/gang-pop/angang-pop/fly-out 起始态只有 transform；hu-banner 起始 opacity:1 | 闸 |
| T2 | MahjongMeld **增量**播 pop：初始 mount（Board onMounted 前的已有副露）**不**播；新增副露（碰/杠/暗杠）mount 或 pop prop 变 true 时播（peng=0.36s / gang=0.42s / angang=0.42s） | 视觉 |
| T2a | 中途进入房时所有已有副露**不**同时 pop（initialBootDone=false 期间 Set 记录、不标记 new） | 闸 |
| T3 | 胡牌 banner diff Set 找新增 seat；多座位胡牌一次推送全部入队串行播放；动画 0.8s 自动退场 + banner 自己 animationend emit 'done' → Board showNextBanner() | 视觉 |
| T4 | 定缺阶段手牌**唯一最少花色**（counts 全相等或某花色=0 时不推荐）的按钮自动高亮 + "推荐"文字 + `anim-lack-pulse` 呼吸 | 视觉 |
| T5 | `activeSeats` 里的座位面板 `.mj-seat--active` 加 `anim-active-glow` 循环发光；血战 claim 窗口多家同时发光可接受（登记风险 Batch 3 再处理） | 视觉 |
| T6 | 双击出牌瞬间手牌 `anim-fly-out`（向右上飞出）；**submit 立即 emit**；flyingOutIndex 在 hand watch 里 reset（B2 阻断修法）；弃牌河新牌 `ftl-played-in` 入场是服务端重绘自然发生 | 视觉 |
| T6a | 出牌后 phase 不变（play 还是 play），但 hand 短了——fly-out class 不残留（watch hand 变化 reset） | 闸 |
| T7 | `pnpm -C apps/client run lint`（vue-tsc）零错误 | 类型 |
| T8 | shared 439 tests 继续全绿 | 回归 |
| T9 | 动画零 JS 定时器（**Batch 2 新增代码 grep setTimeout/setInterval 必须零命中**——除了 D3 的 `animationend` CSS 事件不是 JS 定时器） | 闸 |
| T10 | MahjongMeld.vue 和 MahjongSeatPanel.vue 的 scoped style 里都有 `@import '../../styles/animations.scss'`（Sass 编译才不报错） | 编译 |

---

## §6 风险与缓解

| 风险 | 概率 | 影响 | 处置 |
|---|---|---|---|
| 动画不执行（老端/降级） | 低 | 低 | 起始态全可见（opacity 只在结束态淡出），动画不执行只是"没效果"，不影响功能 |
| 多个胡牌同时发生 banner 叠一起 | 中 | 中 | FIFO queue 串行播放，叠一起靠 translateY 层差也能看出层数 |
| 出牌 fly-out 时机与服务端重绘竞态（服务端极快 <16ms） | 中 | 低 | 动画可能没播出来就被 DOM 替换——**不影响功能**。接受边界（H4 登记） |
| 中途进入房已有副露同时 pop | 已消除 | — | initialBootDone + seenMeldKeys Set 增量判定（B3 阻断修法） |
| `flyingOutIndex` 残留导致下一次双击指错牌 | 已消除 | — | watch hand 内容变化时 reset（B2 阻断修法） |
| `reduced-motion` 降级后新动画还会跑 | 已消除 | — | media query 手动追加新 anim- 类（B4 阻断修法） |
| 发牌入场每轮 play→claim→play 都重播 | 低 | 低 | 接受（phase 变 = 新一轮发牌入场反馈可接受，不吵） |
| 血战 claim 窗口多家 active 同时发光 | 中 | 低 | 登记风险，Batch 3 观察使用率再决定是否弱化 |
| 定缺推荐 counts 全相等时 | 低 | 低 | lackRecommendation 返回 null，不推荐（H7 修法） |
| keyframe 起始态 opacity:0 导致老端元素永久隐形 | 已消除 | — | 所有 keyframe 起始态只有 transform（B1 阻断修法） |

---

## §7 不做清单

- [x] 音效接线（已完成 useTableSound）
- [ ] 弃牌河重构（Batch 3）
- [ ] 出牌拖拽/上滑（Batch 2 结束后观察）
- [ ] 结算界面美化（Batch 3）
- [ ] 聊天/表情/语音（后续）
- [ ] 新增时钟/动画引擎（零 JS 定时器闸）
- [ ] 后端/协议/服务端/配置/管理后台任何改动
- [ ] 血战 claim 窗口多家 active 差异化发光（登记，Batch 3 观察）

---

## §8 审查记录

### 第 1 轮 · 独立对抗 reviewer（v0.1 → v0.2）

**2026-10-28 下午**，独立 reviewer（general_purpose_task subagent）从反方向攻击设计 v0.1，读了所有 5 个关键文件（design spec、animations.scss、Board.vue、Meld.vue、SeatPanel.vue）+ 两个类型确认文件（useTableSound.ts L123-172、protocol types.ts）。

#### 阻断（5 个，全部已修）

| # | 问题 | 根因 | 修法（v0.2） |
|---|---|---|---|
| **B1** | `ftl-hu-banner` 起始态 opacity:0 违反闸纪律 | 设计 D1 写 `scale(1.4) translateY(-10px) opacity(0)` 作起始态 | keyframe 起始态只动 transform，opacity 只在 100% 结束态淡出 |
| **B2** | `flyingOutIndex` reset 时机遗漏——submit 后 phase 不变，watch phase 不会触发 reset | 出牌发生在 `phase === 'play'`，submit 后 phase 仍是 play | watch hand 内容变化（L91-97 已有逻辑）时 reset flyingOutIndex |
| **B3** | 中途进入房时所有副露 mount 同时播 pop 视觉爆炸 | 设计 D2 简单方案"所有 mount 都播" | 放弃简单方案，改 Set 增量判定：Board.vue onMounted 记录已有 meld key，initialBootDone=true 后 watch 新增才标记 pop |
| **B4** | `reduced-motion` media query 新 anim- 类漏列，降级后动画还会跑 | animations.scss L222-236 手动枚举了 10 个 anim- 类，Batch 2 新建的 7 个漏列 | 设计 spec 闸纪律补充：新类名统一 anim- 前缀 + 实现时必须手动追加到 media query 逗号列表 |
| **B5** | MahjongMeld.vue / MahjongSeatPanel.vue scoped style 缺 `@import animations.scss`，$ftl-ease 变量和 keyframe 不在作用域 | 两个组件当前只有 Board.vue 有 import | 设计 §4 涉及文件显式标注两个组件**先加 import 再加动画** |

#### 高（9 个，全部处置或登记）

| # | 问题 | 处置 |
|---|---|---|
| **H1** | `ftl-urgent-pulse` 设计值 1.6s vs 实际值 0.8s 硬冲突 | 不复用已有 keyframe，新建独立 `ftl-lack-pulse`（1.6s）+ `anim-lack-pulse` 类 |
| **H2** | hand key 加 phase+version 导致每轮摸牌 version bump 手牌全重挂载播 deal-in（"抽搐"） | key 改成 `hand-${phase}-${i}`，只在 phase 变化时重挂载 |
| **H3** | watch huInfos.length 无法识别血战到底多点胡（服务端可能一次推多家） | 改用 diff Set 模式：维护 seenHuSeats，找本轮新增 seat 入队 |
| **H4** | submit 立即 emit，fly-out CSS class 还没触发就被 DOM 替换 | 接受"动画可能被截断"的边界（服务端延迟 >100ms 时动画完整播，<16ms 时不播也不影响功能） |
| **H5** | 血战 claim 窗口 activeSeats 多家同时发光 | 登记风险，Batch 3 观察使用率再决定是否弱化 |
| **H6** | angang 动画时长 0.48s > gang 0.42s 自相矛盾（暗杠要"隐蔽"但动画更长） | angang 统一 0.42s，和 gang 同（暗杠牌背视觉已够区分） |
| **H7** | 定缺推荐 counts 全相等/某花色=0 edge case | lackRecommendation 加 hasUniqueMin + minCount>0 检查 |
| **H8** | `.mj-seat--active` 现有 box-shadow 和 ftl-active-glow keyframe 冲突 | keyframe 起始值对接现有 box-shadow 0 0 8px → 取消 active 时光效从循环瞬停回普通规则，可接受 |
| **H9** | Hu banner z-index/定位方案未指定 | 补充 position: absolute + z-index: 10，相对于 Board.vue 根元素，directionOf(seat) 算座位位置 |

#### 低（3 个，登记即可）

- L1: MahjongMeld key 用 index → 建议改为 `meldKey(meld)` 稳定标识（v0.2 D2 已采纳）
- L2: fly-out 方向从"向上"改"向右上"对齐弃牌河（v0.2 D1 已采纳）
- L3: handAnimDone ref 完全删除（deal-in key 变化触发即可，不需要 done 标记）

#### 确认正确的设计决策

- ✅ 不动 protocol / shared / game-service / room-service（零 M07 反作弊红线）
- ✅ 音效已接好（useTableSound.ts L123-172），Batch 2 不重复做
- ✅ 零 JS 定时器（动画自动退场 + 错峰靠内联 --ftl-delay）
- ✅ @import 而非 @use 进 components
- ✅ prefers-reduced-motion 闸纪律存在但实现时要手动追列新 anim- 类

#### 审查结论

v0.2 阻断项 5 个**全部修完**；高项 9 个**全部处置或登记**；低项 3 个**全部采纳**。设计现在可以进入 Step 4：实现计划落盘 + 计划审查。
