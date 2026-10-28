# 四川麻将 UI 升级 · Batch 3 设计 v0.2

> **状态**：设计 v0.2（修完第 1 轮对抗审查 4 阻断 + 9 高）
> **定位**：Batch 1 "像麻将桌" → Batch 2 "动起来" → **Batch 3 "玩起来顺畅"**。claim 响应 + 听牌/胡牌提示 + 弃牌河 + 结算。
> **硬约束**：纯客户端 `apps/client/src/`，不动 protocol / shared / game-service / room-service / config-service / admin。**零聊天功能**（用户显式裁决）。
> **闸纪律**：延续 Batch 2 的 animations.scss 顶部纪律（`@import` / **只从位移缩放起手** 零 opacity 起始 / 零 JS 定时器 / `anim-` 前缀 / reduced-motion 手动追列 / 一次性 $ftl-ease / 循环 ease-in-out）。

---

## §0 用户裁决

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 不做聊天功能 | 零 chat/emoji/voice/回放相关文件改动 |
| K2 | 继续纯客户端 | 不动后端/协议/服务端/数据库 |
| K3 | 优先 claim 响应 + 听牌提示（protocol 已有数据但 UI 没喂满） | 把现有 data 用起来，零新增 protocol 字段 |

---

## §1 范围总览

### Batch 3 做的 5 组工作

| 组 | 主题 | 关键文件 | 说明 |
|---|---|---|---|
| **A** | ClaimTile 组件 + claim 窗口强化 | 新建 ClaimTile.vue + Board.vue | 胡候选番数展示 + 显式"过"按钮 + 呼吸动效（**阻断 B4 修正：不造独立倒计时**，复用 TurnTimer） |
| **B** | 听牌手牌整体高亮 + 胡候选番数展示 | Board.vue | 手牌整体 ting 高亮 + claimLabel 修订 |
| **C** | 弃牌河重构 | Board.vue + SeatPanel.vue | 最新弃牌静态发光标记 + 渐隐遮罩 + 类名统一 |
| **D** | 结算面板视觉丰富化 | MahjongSettlement.vue | **新建麻将专用入场 keyframe**（不影响斗地主/跑得快）+ 番型 emoji + 金币冻结视觉 |
| **E** | 出牌交互微调 | Board.vue | 双击等待提示 + exchange 多选计数 |

### Batch 3 不做（含审查后砍掉）

| # | 排除项 | 原因 |
|---|---|---|
| ✅ | **聊天/表情/语音/回放** | 用户显式裁决 |
| ✅ | **SeatPanel 对手听牌徽标**（原 D-B3） | **阻断 B2 砍掉**：game-service view.ts L131 tingTiles 只给接收者自己算，对手收不到；客户端无法推算 |
| ✅ | claim 窗口独立倒计时 | **阻断 B4 砍掉**：Board.vue 没有 turnDeadline 字段（只有 seconds prop）；claimTimeoutSec 用 computed 不会自动重算，setInterval 违反零 JS 定时器闸 |
| ✅ | 出牌拖拽/上滑 | 纯客户端 touch 事件复杂，Batch 4 |
| ✅ | 服务端 protocol 字段新增 | 纯客户端改造，用现有 tingTiles/claimsForMe/huInfos |
| ✅ | 金币冻结逻辑变更 | 不动 useGoldColumnFreeze |
| ✅ | 血战 claim 窗口多家 active 差异化发光 | Batch 2 H5 登记，继续观察 |

---

## §2 现状总结（只读调研结果）

### A · Claim 响应现状

- claim 窗口**没有 ClaimTile 组件**
- `claimsForMe` 里的胡候选（多番型）`claimLabel()` **只显示"胡"**，忽略 `fan` 字段（Board.vue L190-200）
- claim 响应**没有独立倒计时**（和 play 窗口共享 TurnTimer）
- **没有"过"的显式按钮**（想主动过只能等超时）
- **阻断 B1 发现**：`MahjongClaimOption`（types.ts L37-42）**没有 `kind` 字段**——只有 `claim: MahjongClaim; tile?: Tile; fan?: number`。`MahjongClaim`（actions.ts L9）只有 `'hu'|'gang'|'peng'|'pass'` 四值。现有 Board.vue L190-200 claimLabel 用的也是 `opt.claim`（正确）。

### B · 听牌现状

- protocol 已有 `tingTiles?: Tile[]` / `maxFanForMe?: number`（types.ts L115-116）
- Board.vue 渲染了 `.mj__ting` 区域（L461-472），但**手牌里没有任何听牌高亮**
- **阻断 B2 发现**：对手收不到其他座位的 tingTiles（game-service view.ts L131 只给接收者自己算）——SeatPanel ting 徽标**无法实现**

### C · 弃牌河现状

- 自己的弃牌走 Board.vue `.mj__my-river`（L510-518），三方向弃牌走 SeatPanel `.mj-seat__row--river`（L102-110）
- **没有最新弃牌标记**（看不出谁刚打了什么）
- `overflow:hidden + flex-wrap + max-height:84px`（SeatPanel L209-211）——**满了静默截断**
- 类名不统一（`mj__my-river` vs `mj-seat__row--river`）
- **高项 H1 发现**：现有 `ftl-reveal-in` 是翻牌 keyframe（rotateY），**不是**位移入场 keyframe——设计 v0.1 说"复用 anim-reveal-in"是错的

### D · 结算现状

- `MahjongSettlement.vue`（420 行）独立面板，table.vue 通过 slot overlays 叠加
- 入场只有 `anim-settlement-in`（0.24s transition）
- **阻断 B3 发现**：现有 `anim-settlement-in` **被三个玩法共用**——全仓 grep 确认斗地主 Settlement.vue L172、跑得快 PdkSettlement.vue L92、麻将 MahjongSettlement.vue 三处使用。改一个影响三个。
- **阻断 B3 发现**：闸纪律原文"全部动画**只从**位移/缩放起手，**不**用 opacity: 0"（animations.scss L18-21）——设计 v0.1 起始态 opacity:0.3 违反"只从位移缩放起手"

### E · 出牌交互现状

- 单击选中 + 双击 400ms 出牌两套路径
- **双击等待期间**用户看到的是"第一次点击的选中态高亮"，不知道在等第二次
- **高项 H4 发现**：exchange 最多选 3 张（Board.vue L124 `selected.value.length < 3`）**已有限制**，但没有视觉提示
- exchange 的 `< 3` 限制**不强制同花色**——选了不同花色也能继续加，最后 exchangeReady 才检查

---

## §3 设计细节

### D-A · ClaimTile 组件 + claim 窗口强化

#### D-A1 · 新建 ClaimTile.vue

轻量组件，展示"当前可响应的 claimsForMe 选项"。

```vue
<template>
  <view class="mj-claim-tile anim-claim-pulse">
    <text class="mj-claim-tile__prompt">可响应</text>
    <view class="mj-claim-tile__opts">
      <button
        v-for="(opt, i) in sortedOptions"
        :key="claimKey(opt, i)"
        class="btn mj-claim-tile__opt"
        :class="optClass(opt)"
        :disabled="busy"
        @click="$emit('claim', opt)"
      >
        {{ claimLabelRich(opt) }}
      </button>
      <button
        v-if="showPass"
        class="btn mj-claim-tile__pass"
        :disabled="busy"
        @click="$emit('pass')"
      >过</button>
    </view>
  </view>
</template>
```

**关键设计点**：
- **阻断 B1 修正**：`claimLabelRich(opt)` 用 `opt.claim`（MahjongClaim 四值：hu/gang/peng/pass），**不是**设计 v0.1 误写的 `opt.kind`。Board.vue L190-200 已用 `opt.claim`，Batch 3 只加 fan 字段展示。
- **胡候选番数展示**：`opt.claim === 'hu' && opt.fan` 时显示 `{{ opt.fan }} 番胡`
- **多番型按番数降序**：`sortedOptions = [...props.options].sort((a, b) => (b.fan ?? 0) - (a.fan ?? 0))`（防御式拷贝，不 mutate service 推下来的原数组——高项 H5 处置）
- **显式"过"按钮**：`showPass` prop（只在 claim 窗口传 true）
- **作用域明确**（高项 H6 处置）：ClaimTile **只替换 Board.vue claim 窗口**（L590-602），**不改** play 窗口（L568-588 自摸胡/杠不需要"过"按钮）
- **闸纪律**：animations.scss 新增 `ftl-claim-pulse`（1.6s 循环，ease-in-out，transform scale）

#### D-A2 · claim 倒计时**不新建**（阻断 B4 修正）

**Blocked B4**：Board.vue L34 只有 `seconds: number` prop（由 table.vue 的唯一 useCountdown 驱动），**没有独立的 turnDeadline ref**。如果 claimTimeoutSec 用 `computed(() => Math.max(0, Math.floor((turnDeadlineAt - Date.now()) / 1000)))`——Vue computed 不订阅 Date.now()，不会自动重算；要每秒刷新必须 setInterval——**违反零 JS 定时器闸**（animations.scss L26 "牌桌区不新造时钟" + TurnTimer.vue L14-15 "本组件不得新造时钟"）。

**Batch 3 决策**：claim 窗口和 play 窗口**共享现有 TurnTimer 组件**，不单独造倒计时。TurnTimer 会在 claim 阶段自动显示正确的剩余秒数（service 推的 seconds 在 claim 和 play 阶段复用同一 deadlineAt）。**不加独立 "Xs 内响应" 文字**（避免视觉冗余）。

#### D-A3 · Board.vue claim 窗口改

Board.vue L590-602 的 claim 按钮块**替换**成 ClaimTile 组件。Play 窗口自摸胡/杠按钮块（L568-588）**不改**。

---

### D-B · 听牌手牌高亮 + 胡候选番数展示

#### D-B1 · 手牌整体 ting 高亮（Board.vue）

protocol **没有**"我手里哪些牌和 tingTiles 关联"的字段——只有 `tingTiles`（我能赢哪些牌），没有"我手里哪些牌打出后保持听牌"。

**Batch 3 简化方案**：只给**听牌窗口**（`tingTiles.length > 0`）的手牌整体加一个"听牌中"视觉层，不精确到某张牌。

```vue
<view :class="{ 'mj__hand': true, 'mj__hand--ting': tingTiles.length > 0 }">
  <!-- 现有手牌渲染 -->
</view>
```

CSS：`.mj__hand--ting::after` 加右上角小标记"听牌中" + 手牌区背景轻微金色叠加。

**不做**：精确到某张手牌的听牌关联高亮（需服务端新增字段，复杂度超 Batch 3）。

#### D-B2 · claimsForMe 胡候选番数展示（Board.vue claimLabel 修订）

Board.vue L190-200 的 `claimLabel(opt)` 当前只返回 "胡"。Batch 3 按 `opt.claim` 四值修订（**阻断 B1 修正**：不用 `opt.kind`）：

```ts
function claimLabel(opt: MahjongClaimOption): string {
  switch (opt.claim) {
    case 'peng': return '碰';
    case 'gang': return phase.value === 'play' ? '杠' : '杠'; // play 自摸暗杠 vs claim 直杠/补杠
    case 'hu': return (opt.fan ? `${opt.fan} 番胡` : '胡') + (phase.value === 'play' ? '（自摸）' : '');
    case 'pass': return '过';
  }
}
```

#### D-B3 · SeatPanel ting 徽标**砍掉**（阻断 B2 修正）

**Blocked B2**：game-service view.ts L131 tingTiles 只给接收者自己算——对手收不到任何其他座位的听牌信息。客户端无法用公共信息推算（需算牌库）。

**Batch 3 决策**：SeatPanel **不新增 ting prop**（整个 D-B3 节砍掉）。听牌状态只在自己的 Board.vue 上显示（D-B1）。对手是否听牌——**登记为未来 slice**（需服务端 view 给其他座位推 tingTiles 才能做）。

---

### D-C · 弃牌河重构

#### D-C1 · 最新弃牌标记

Board.vue 和 SeatPanel 渲染弃牌时，给**最后一张**（v-for index = length - 1）加 `mj__discard--latest` 类，**静态发光效果**（不是循环动画）：

```scss
.mj__discard--latest {
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.5);
  // 高项 H1 修正：不用 ftl-reveal-in（翻牌 keyframe rotateY）
}
```

**高项 H1 修正**：设计 v0.1 说"复用 ftl-reveal-in"——但 ftl-reveal-in 是翻牌 keyframe（rotateY + translateY），**不是**位移入场 keyframe，用错了。Batch 3 改用**静态 box-shadow 发光**（不是入场动画）。

#### D-C2 · overflow 渐隐遮罩（高项 H2 修正）

纯 CSS 无法检测 flex-wrap 的 overflow（没有 `overflow-visible` 检测 API）。Batch 3 **简化方案**：SeatPanel `.mj-seat__row--river` 容器底部**无条件渲染**一个 `.mj-river__mask` 渐隐遮罩（`linear-gradient(to bottom, transparent, rgba(0,0,0,0.5))`）——不管有没有 overflow 都显示，视觉上是"弃牌河底部阴影"，不是专门的 overflow 提示。

**不做**："更多"点击展开、滚动弃牌河。

#### D-C3 · 类名统一

Board.vue 的 `.mj__my-river` 和 SeatPanel 的 `.mj-seat__row--river` 不统一。Batch 3 给 SeatPanel 的 river row 也加 `.mj-river` 类名（不改名现有类，加额外 class）。

---

### D-D · 结算面板视觉丰富化

#### D-D1 · 入场动效升级（阻断 B3 修正 + 高项 H3 修正）

**阻断 B3 修正 1**：闸纪律原文"全部动画**只从**位移/缩放起手，**不**用 opacity: 0"（animations.scss L18-21）。设计 v0.1 起始态 opacity:0.3 违反"只从位移缩放起手"。**修法**：起始态**只用 transform**（scale(0.8) translateY(20px)），结束态才 opacity:1。

**阻断 B3 修正 2 / 高项 H3 修正**：现有 `anim-settlement-in` **被三个玩法共用**——全仓 grep 确认 3 处使用（斗地主 Settlement.vue L172、跑得快 PdkSettlement.vue L92、麻将 MahjongSettlement.vue）。改一个影响三个。**Batch 3 新建麻将专用 keyframe**，不动现有：

```scss
// animations.scss 新增麻将专用（不影响斗地主/跑得快）
@keyframes ftl-mj-settlement-in {
  from { transform: scale(0.8) translateY(20px); }  // 只 transform，起始态可见
  to { transform: none; opacity: 1; }
}
.anim-mj-settlement-in {
  animation: ftl-mj-settlement-in 0.36s $ftl-ease both;
}
```

Settlement.vue 把现有 `anim-settlement-in` 类换成 `anim-mj-settlement-in`。斗地主/跑得快继续用 `anim-settlement-in`，**不受影响**。

**闸纪律验证**：起始态只用 transform（只从位移缩放起手）；一次性动画用 $ftl-ease；新建 anim- 类 reduced-motion 追列。

#### D-D2 · 番型可视化

现有结算面板只显示文字 "清一色 3 番"。Batch 3 给每种番型加一个 emoji 图标前缀（纯 CSS，无新增资源）：

| 番型 | emoji |
|---|---|
| 清一色 | 🎴 |
| 七对 | 👯 |
| 大对 | 🔶 |
| 根（四张） | 🌳 |
| 杠上开花 | 💥 |
| 海底捞月 | 🌙 |
| 十三幺 | 👻 |
| 对对胡 | 🃏 |
| 平胡 | ✨ |

番型到 emoji 的映射表放在 Settlement.vue 里（一个 `const FAN_EMOJI: Record<string, string>` 映射）。**不做**：复杂的番型逐个进场动画。

#### D-D3 · 金币冻结状态视觉反馈

现有 `useGoldColumnFreeze` 有"延迟解锁"逻辑（Settlement.vue L32-36），但 UI 上看不出来。Batch 3 给冻结的金币数字加一个**淡灰色 + 小锁 emoji** 前缀。**不改** useGoldColumnFreeze 的逻辑，只改展示层。

---

### D-E · 出牌交互微调

#### D-E1 · 双击等待提示

现有双击 400ms 延迟期间，用户看到第一次点击的选中态（抬 10px + 金色描边），不知道在等第二次。Batch 3 给选中态加一个**次级文案提示**：

```vue
<view v-if="phase === 'play' && handSelectable && selected.length === 1" class="mj__hand-hint">
  <text>再点一次出牌（或点"出牌"按钮）</text>
</view>
```

#### D-E2 · exchange 多选计数（高项 H4 修正：已有限制）

Board.vue L124 已有 `selected.value.length < 3` 限制（exchange 阶段最多选 3 张），**但没有视觉提示"已选 X/3"**。Batch 3 简单加一行计数 `已选 {{ selected.length }}/3 张`。

**高项 H4 额外说明**：exchange 的 `< 3` 限制**不强制同花色**——用户可以选了不同花色继续加，最后 exchangeReady 按钮才检查同花色。"已选 X/3" 提示在选了不同花色时可能有误导。Batch 3 简单处理：只显示计数，不提示"不同花色无效"——让 exchangeReady 按钮 disabled 自然表达。

---

## §4 关键约束与边界（v0.2 修正后）

| 约束 | 处置 |
|---|---|
| **协议字段零新增** | tingTiles / claimsForMe / huInfos 全部现有字段足够；对手 ting 信息登记未来 slice |
| **动画零 JS 定时器** | 所有新增 keyframe 靠 CSS forwards / both；**不造独立倒计时**（阻断 B4 修法） |
| **不碰聊天** | 零 chat/emoji/voice/回放相关文件 |
| **animations.scss 闸纪律** | `@import` 进组件；**只从位移缩放起手**；`anim-` 前缀；reduced-motion 手动追列；一次性 $ftl-ease / 循环 ease-in-out |
| **MahjongClaimOption 正确字段** | 用 `opt.claim`（四值 hu/gang/peng/pass），不是 `opt.kind`（阻断 B1 修法） |
| **anim-settlement-in 三处共用** | 新建麻将专用 `anim-mj-settlement-in`，不动现有（阻断 B3 修法） |
| **弃牌 overflow 纯 CSS 无法检测** | 无条件渐隐遮罩，不做"更多"点击展开（高项 H2 修法） |
| **claim 窗口 vs play 窗口** | ClaimTile **只替换 claim 窗口**，play 窗口自摸不改（高项 H6 修法） |
| **sealPanel 不传 ting prop** | 对手收不到 tingTiles，无法实现（阻断 B2 砍掉） |

---

## §5 涉及文件（v0.2 修正后）

| 操作 | 文件 | 说明 |
|---|---|---|
| **新建** | `apps/client/src/components/table/mahjong/ClaimTile.vue` | Claim 窗口独立组件（胡候选番数展示 + 过按钮 + 呼吸动效） |
| **修改** | `apps/client/src/styles/animations.scss` | 新增 `ftl-claim-pulse` + `ftl-mj-settlement-in` 两个 keyframe + 对应 anim- 类；reduced-motion 追列；**不动**现有的 `ftl-settlement-in`（斗地主/跑得快共用） |
| **修改** | `apps/client/src/components/table/mahjong/MahjongBoard.vue` | ClaimTile 接线 + claimLabel 按 opt.claim 四值修订（加 fan 展示） + 手牌整体 ting 高亮 + hand hint + exchange 计数 + 弃牌最新标记 + 弃牌 river 类名 |
| **修改** | `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue` | 弃牌最新标记（`.mj__discard--latest` 类） + 弃牌渐隐遮罩 + river 类名追加 `.mj-river` |
| **修改** | `apps/client/src/components/MahjongSettlement.vue` | 入场动效换成 `anim-mj-settlement-in`（麻将专用）+ 番型 emoji 前缀 + 金币冻结视觉 |

**不动**：
- protocol / shared / game-service / room-service / config-service / admin
- useTableSound.ts（音效已接好）
- MahjongMeld.vue / MahjongHuBanner.vue / MahjongTile.vue（Batch 1/2 产物不动）
- **现有 `ftl-settlement-in` keyframe**（斗地主/跑得快继续用）
- **任何聊天/表情/语音/回放相关文件**（零改动）

---

## §6 闸纪律验证清单

- [ ] 新增 keyframe 只从位移/缩放起手（零 opacity 起始）
- [ ] 零 JS setTimeout/setInterval
- [ ] 新 anim- 类 reduced-motion media query 手动追列
- [ ] 所有组件 `@import '../../../styles/animations.scss'`（三层 ..）
- [ ] 一次性动画用 $ftl-ease，循环用 ease-in-out
- [ ] protocol 零新增字段
- [ ] 零聊天功能相关改动
- [ ] 不造独立倒计时（claim 共享 TurnTimer）
- [ ] 新建麻将专用 `ftl-mj-settlement-in`，不动共用的 `ftl-settlement-in`

---

## §7 不做清单（Batch 3）

| # | 排除项 | 原因 |
|---|---|---|
| ✅ | **聊天/表情/语音/回放** | 用户显式裁决 |
| ✅ | **SeatPanel 对手听牌徽标** | game-service 只给自己算 tingTiles（阻断 B2 砍掉，登记未来 slice） |
| ✅ | **claim 独立倒计时** | Board.vue 无 turnDeadline ref；setInterval 违反闸（阻断 B4 砍掉） |
| ✅ | 出牌拖拽/上滑 | 复杂，Batch 4 |
| ✅ | 服务端新增 protocol 字段 | 现有 tingTiles/claimsForMe 够用 |
| ✅ | 金币冻结逻辑变更 | 不动 useGoldColumnFreeze |
| ✅ | 血战 claim 多家 active 差异化 | Batch 2 H5 登记 |
| ✅ | 弃牌滚动 | 只做渐隐遮罩 |
| ✅ | 精确到某张手牌的听牌关联高亮 | 需服务端加字段 |
| ✅ | 结算入场多番型逐个动画 | 只加 emoji 前缀 |
| ✅ | **动斗地主/跑得快结算入场 keyframe** | 三玩法共用，不动 |

---

## §8 审查记录

### 第 1 轮 · 独立对抗 reviewer（v0.1 → v0.2）

**2026-10-28**，独立 reviewer 读了设计 v0.1 + 全部 7 个关键源码文件（types.ts L37-42/L98-125、actions.ts L9、animations.scss L18-21/L299-320、Board.vue L34/L70/L190-200/L568-602、SeatPanel.vue L21-44/L81-83/L203-210、Settlement.vue L32-36/L122、TurnTimer.vue L14-15）。

#### 阻断（4 个，全部已修）

| # | 问题 | 根因 | 修法（v0.2） |
|---|---|---|---|
| **B1** | `claimLabelRich` 用了不存在的 `opt.kind` + 错误枚举值 | MahjongClaimOption 只有 `claim` 字段（MahjongClaim 四值 hu/gang/peng/pass），没有 kind；设计 v0.1 写的 addedGang/angang/zimoHu 全是 MahjongAction.type 不是 claim 值 | 改成 `opt.claim` 四值 switch，只加 fan 字段展示 |
| **B2** | SeatPanel ting 徽标（D-B3）没有数据来源 | game-service view.ts L131 tingTiles 只给接收者自己算，对手收不到；客户端无法算牌库 | **整个 D-B3 砍掉**，登记未来 slice |
| **B3** | ftl-settlement-in 起始态加 opacity:0.3 违反闸纪律原文 | animations.scss L18-21 "只从位移/缩放起手"；且 anim-settlement-in 被三玩法共用（全仓 grep 3 处使用） | 新建麻将专用 `ftl-mj-settlement-in`（起始态零 opacity），不动共用的 keyframe |
| **B4** | claim 倒计时独立显示会违反"牌桌区不新造时钟"纪律 | Board.vue 只有 seconds prop 无 turnDeadline；claimTimeoutSec 用 computed + Date.now() 不会自动重算；setInterval 违反闸 | **独立倒计时砍掉**，claim 窗口共享现有 TurnTimer |

#### 高（9 个，全部处置或登记）

| # | 问题 | 处置 |
|---|---|---|
| **H1** | 设计"复用 ftl-reveal-in"做最新弃牌标记——ftl-reveal-in 是翻牌 keyframe（rotateY）不是位移 keyframe | 改用**静态 box-shadow 发光**（不是入场动画），不新增 keyframe |
| **H2** | overflow 渐隐遮罩无法用纯 CSS 检测 flex-wrap overflow | 无条件渲染 `.mj-river__mask` 渐隐遮罩（视觉底部阴影），不做"更多"提示 |
| **H3** | anim-settlement-in 被斗地主/麻将/跑得快三结算面板共用（全仓 grep 3 处使用） | 新建麻将专用 `ftl-mj-settlement-in` + `anim-mj-settlement-in`，不动现有 |
| **H4** | exchange 多选计数——已有限制（Board.vue L124 `< 3`），但不强制同花色 | 显示 `已选 X/3`，不提示"不同花色无效"，让 exchangeReady disabled 自然表达 |
| **H5** | claimsForMe 多胡候选按番数降序 sort 需要防御式拷贝（不 mutate 原数组） | `[...props.options].sort(...)` 先展开再 sort |
| **H6** | ClaimTile 作用域——只替换 claim 窗口还是 play 窗口也换 | 明确只替换 Board.vue claim 窗口（L590-602），play 窗口自摸不改（不需要"过"按钮） |
| **H7** | SeatPanel ting/hu 徽标防御冲突（已出局玩家不需要 ting） | 因 D-B3 已砍掉 ting prop，此问题消失 |
| **H8** | reduced-motion 追列清单设计里没写具体操作 | §6 闸纪律验证清单里显式列出 |
| **H9** | 手牌整体 ting 高亮与现有 `.mj__ting` 区可能冗余 | `.mj__ting` 显示"我能赢哪些牌"（tingTiles），`.mj__hand--ting` 显示"手牌听牌整体状态"——两个不同语义区，不冗余 |

#### 低（3 个，登记即可）

- L1: 弃牌发光 box-shadow 可能被 SeatPanel `overflow:hidden` 裁掉——box-shadow 不占布局空间，`overflow:hidden` 会裁掉（**实现时注意**：`.mj__discard--latest` 的 box-shadow 可能被 SeatPanel 容器 overflow:hidden 裁，需要检查）
- L2: ClaimTile 类名前缀 `.mj-claim-tile`——其他 Batch 3 新增类用 `anim-claim-pulse` / `.mj-river__mask`，BEM 风格不完全统一——可接受
- L3: 番型 emoji 映射表 `FAN_EMOJI` 需要先确认 Settlement.vue 里番型字段的字符串格式（是中文"清一色"还是英文 enum）——**实现前必须读** Settlement.vue 的 fanDetails 渲染逻辑

#### 审查结论

v0.1 阻断 4 个全修、高 9 个全处置/登记、低 3 个登记。设计现在可以进入 Step 4+5：实现计划落盘 + 计划审查。
