# 四川麻将 UI 升级 · Batch 5 设计 v0.1

> **状态**：设计 v0.1（待对抗审查）
> **定位**：Batch 4 "交互完整" → **Batch 5 "信息密集"**。对手听牌徽标（改服务端） + 手牌精确听牌关联高亮（客户端纯计算）。
> **硬约束解除**：用户裁决"可以改服务器"。

---

## §0 用户裁决

| # | 裁决 | 影响 |
|---|---|---|
| K1 | **可以改服务器** | protocol + game-service 可动 |
| K2 | **可以改 shared** | 客户端可以 import @fight-the-landlord/shared 调 tingTiles |
| K3 | 继续纯客户端渲染 | 客户端只展示服务端下发的数据 + 本地纯函数计算 |

---

## §1 范围总览

| 组 | 主题 | 主要文件 | 复杂度 |
|---|---|---|---|
| **A** | 服务端 tingSeats 广播 | protocol/types.ts + game-service/mahjong/view.ts | 低 |
| **B** | SeatPanel 对手听牌徽标 | 客户端 SeatPanel.vue | 低 |
| **C** | 手牌精确听牌关联高亮 | 客户端 Board.vue + import shared tingTiles | 低（性能已实测） |

---

## §2 功能 A·服务端 tingSeats 广播

### 现状

- `MahjongPlayerView` L98-125 字段里没有 "哪些座位在听" 的字段
- `buildMahjongView()` L95-137 只对当前 `seat === me` 算 `tingResult()`（L98-101），其他座位**完全跳过**
- `session.players` 里服务端**知道所有玩家的 hand/melds/lackSuit**，只是没下发给客户端

### 协议改（protocol/types.ts）

在 `MahjongPlayerView` L112 `activeSeats` 后面加一个字段：

```ts
export interface MahjongPlayerView extends GameViewBase<Tile> {
  // ... 现有字段不变 ...
  /** 当前窗口待决策座位。 */
  activeSeats: number[];
  /** Batch 5 A：当前听牌的座位（含自己）。零作弊风险——只广播座位号。 */
  tingSeats: number[];
  // ... 现有字段不变 ...
}
```

### 服务端改（game-service/mahjong/view.ts）

**新增辅助函数**（放在 `pendingSeats` 旁边，L19-33 区域）：
```ts
/** Batch 5 A：收集所有听牌座位。服务端对所有 seat 跑 isTing()。 */
function tingSeatsOf(session: MahjongSession): number[] {
  const out: number[] = [];
  for (const p of session.players) {
    if (!p || p.isOut) continue;
    if (p.lackSuit === null) continue; // 未定缺不可能听
    if (isTing(p.hand, p.melds, p.lackSuit, session.rules)) {
      out.push(p.seat);
    }
  }
  return out;
}
```

**buildMahjongView L108-136 return 里加一行**：
```ts
tingSeats: tingSeatsOf(session),
```

### 闸纪律验证
- [ ] isTing 函数已从 @fight-the-landlord/shared import（view.ts L10-17 现有 tingResult import 已经在同一个包）
- [ ] 只跑 4 次 isTing（每个 seat 一次）——服务端极微成本（isTing 内部就是 tingTiles().length > 0）
- [ ] 零作弊风险：只广播座位号数组，**不下发具体 tingTiles**
- [ ] optional 字段 → required？**required**：血战到底核心局势信息，所有 view 都有意义

---

## §3 功能 B·SeatPanel 对手听牌徽标

### 现状

- SeatPanel.vue 没有 `ting` prop
- 客户端 Board.vue MahjongBoard 里没有从 view.tingSeats 推导

### 客户端改

**Board.vue** `seatPanelProps` 函数加一个字段（Batch 4 已有 activeLevel 改法在 L323-342）：
```ts
ting: (props.view?.tingSeats ?? []).includes(seat),
```

**SeatPanel.vue**：
- prop 加 `ting: boolean`
- template 里 `.mj-seat__meta` 区域加一个徽标（和 lack/badge/hu/out 同层）
- CSS 一个新 badge 类

```vue
<!-- template -->
<text v-if="ting && !isOut" class="mj-seat__badge mj-seat__badge--ting">听</text>

<!-- CSS -->
.mj-seat__badge--ting {
  background: rgba(74, 222, 128, 0.25); // 绿色表示安全（我还没听，对手听了我要小心）
  color: #4ade80;
}
```

**闸纪律**：零新动画，零定时器，纯展示。

---

## §4 功能 C·手牌精确听牌关联高亮

### 现状

- Board.vue 已有 `tingTiles = computed<readonly Tile[]>(() => props.view?.tingTiles ?? [])`
- 手牌 MahjongTile 渲染在 L709-723
- 客户端可以 import `tingTiles` from `@fight-the-landlord/shared`（已从 shared barrel export）

### 性能验证（已实测）

| 指标 | 数据 |
|---|---|
| 单次 tingTiles() | **21-81 μs** |
| 13 张手牌全算一遍 | **< 1 ms** |
| import 可用 | ✅ |

### 客户端改（Board.vue）

**1. client package.json 加 shared 依赖**（当前没有）：
```json
"@fight-the-landlord/shared": "workspace:*"
```

**2. import**：
```ts
import { tingTiles as computeTingTiles } from '@fight-the-landlord/shared';
```

**3. 核心 computed**（放在 `tingTiles` computed 后面）：
```ts
/** Batch 5 C：每张手牌打出后的听牌影响。 */
const handTileTingImpact = computed<Array<{
  index: number;
  lostCount: number;     // 丢失几个 ting 牌
  stillTing: boolean;    // 打出后还在听吗
  lostTiles: Tile[];     // 具体丢失哪些（调试用）
}> | null>(() => {
  if (tingTiles.value.length === 0 || hand.value.length === 0) return null;
  if (myLack.value === null) return null; // 未定缺不算
  // 用 view.mahjongRules.minFanToHu 还是 DEFAULT_CHENGDU_RULES？
  const rules = props.view?.mahjongRules ?? DEFAULT_CHENGDU_RULES;
  return hand.value.map((tile, i) => {
    const handWithout = hand.value.filter((_, j) => j !== i);
    const afterTing = computeTingTiles(handWithout, [], myMelds.value, myLack.value, rules);
    const afterSet = new Set(afterTing.map(tileType));
    const lost = tingTiles.value.filter(t => !afterSet.has(tileType(t)));
    return {
      index: i,
      lostCount: lost.length,
      stillTing: afterTing.length > 0,
      lostTiles: lost,
    };
  });
});
```

**注意**：`myMelds` 是 `readonly MahjongMeldView[]`（Board.vue L62 定义）——但 computeTingTiles 内部需要完整 MahjongMeldView 类型，确认 shared 接受 readonly。

**4. 手牌 MahjongTile 加 class**：
```vue
<MahjongTile
  ...
  :class="{
    'anim-fly-out': flyingOutIndex === i,
    'anim-deal-in': phase === 'play',
    'mj-tile--ting-safe': handTileTingImpact?.[i]?.lostCount === 0 && handTileTingImpact[i].stillTing,
    'mj-tile--ting-warn': handTileTingImpact?.[i]?.lostCount > 0 && handTileTingImpact[i].stillTing,
    'mj-tile--ting-danger': handTileTingImpact?.[i] && !handTileTingImpact[i].stillTing,
  }"
/>
```

**5. CSS**（闸纪律：纯 outline 叠加，不用 box-shadow）：
```scss
.mj-tile--ting-safe {
  outline: 1px solid rgba(74, 222, 128, 0.5); // 绿色：打出后听牌不变
  outline-offset: -1px;
}
.mj-tile--ting-warn {
  outline: 1px solid rgba(251, 191, 36, 0.7); // 黄色：丢听牌
  outline-offset: -1px;
}
.mj-tile--ting-danger {
  outline: 2px solid rgba(248, 113, 113, 0.9); // 红色：打出后不听
  outline-offset: -2px;
}
```

### 闸纪律验证
- [ ] 零 JS 定时器（纯 computed 响应式）
- [ ] 性能 < 1ms/重算（手牌每次变化触发）
- [ ] outline 叠加（不影响 MahjongTile 现有视觉）
- [ ] shared tingTiles 参数签名匹配（hand: readonly Tile[], melds: readonly MahjongMeldView[], lackSuit: MahjongSuit, rules: MahjongRulesConfig）

### 边界
- `handTileTingImpact` 只在 `tingTiles.length > 0 && myLack !== null` 时才计算
- 未定缺 / 胡了 / 换三张窗口 → 返回 null，不加任何 outline
- 服务端 minFanToHu 如果 > 0：客户端 computeTingTiles 也用 rules.minFanToHu，一致
- 手牌每次变化重算（发牌/碰杠/出牌/碰成功后 hand 更新）——computed 自动响应

---

## §5 任务拆解

| 任务 | 内容 | commit 粒度 |
|---|---|---|
| T1 | protocol/types.ts 加 tingSeats 字段 | 1 commit |
| T2 | game-service/view.ts 加 tingSeatsOf + buildMahjongView 注入 | 1 commit |
| T3 | Board.vue: import shared tingTiles + handTileTingImpact computed + tile class + CSS; seatPanelProps 加 ting | 1 commit |
| T4 | SeatPanel.vue 加 ting prop + 徽标渲染 + CSS | 1 commit |
| T5 | client package.json 加 @fight-the-landlord/shared workspace 依赖 | T3 前置 |
| T6 | 全量验证（protocol tests + shared tests + client tests + GetDiagnostics） | 验证 |

---

## §6 闸纪律验证清单

- [ ] 服务端 isTing 跑零作弊风险（只广播座位号，不下发 tingTiles）
- [ ] tingSeats 在 MahjongPlayerView 里是 required（血战到底核心信息）
- [ ] 客户端 import shared tingTiles 的参数签名匹配
- [ ] Board.vue handTileTingImpact 性能 < 1ms（已实测）
- [ ] outline 叠加，不用 box-shadow
- [ ] 零新增 JS 定时器
- [ ] 零聊天功能改动
- [ ] protocol 字段变更跑 protocol tests
- [ ] game-service 变更跑 integration tests
- [ ] 客户端 shared 依赖加 `workspace:*`

---

## §7 审查记录

### 第 1 轮（本设计写完即过）

待 reviewer 审查重点：
1. MahjongPlayerView.tingSeats 应该 required 还是 optional？——血战到底核心信息，所有 phase 除 ended 外都有意义，推荐 required
2. 服务端 tingSeatsOf 循环 4 次 isTing —— 空循环（lackSuit===null 的玩家跳过）+ isTing 内部就是 tingTiles().length，极微成本
3. 客户端 import @fight-the-landlord/shared —— workspace monorepo 里共享包的路径，确认 client package.json 能解析
4. handTileTingImpact 用 view.mahjongRules 还是 DEFAULT_CHENGDU_RULES？——用 view.mahjongRules（服务端给的规则快照），保持一致
5. MahjongMeldView 类型：Board.vue 的 myMelds 是 readonly 数组，computeTingTiles 第二个参数是 readonly MahjongMeldView[] —— 类型兼容，确认
6. CSS outline 和 MahjongTile 现有视觉会不会冲突？——outline 在最外层，不影响 box-shadow/transform
