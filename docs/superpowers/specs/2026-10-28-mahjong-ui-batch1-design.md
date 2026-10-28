# 四川麻将 UI 升级 · Batch 1 设计

> **状态**：设计 v0.2（已过第 1 轮对抗审查：2 阻断 / 4 高 / 5 低，全部处置）
> **定位**：在麻将规则/协议/服务端已完整的基础上，做客户端 UI 第一阶段升级。
> **范围**：4 方向牌面 + 牌桌背景 + 双击出牌 + 副露独立组件。
> **不做**：动作特效动画、音效接线、弃牌河重构、聊天/表情、回放、听牌提示强化、结算界面美化——这些留给 Batch 2/3。
> **接触面**：纯客户端 `apps/client/src/`，**不动** protocol / shared / game-service / room-service / currency-service / config-service / admin。

---

## §0 用户裁决

| # | 裁决 | 影响 |
|---|---|---|
| K1 | Batch 1 先做最直观的"看起来像个麻将桌"升级 | 4 方向牌面 + 牌桌背景 + 双击出牌 + 副露独立组件 |
| K2 | 参考 `D:\Code\babykylin_scmj`（幼麟棋牌）的视觉与交互 | 素材提取 + 布局模仿 |
| K3 | 纯客户端改动 | 不动后端/协议/服务端 |

---

## §1 背景与现状

当前 ftl-branch 的麻将 UI 能跑但粗糙：

| # | 现状 | 证据 |
|---|---|---|
| 1 | 所有人看到的牌一样——平铺 27 张独立 PNG，无方位感知 | `static/mahjong/` 目录只有 `tiao-*.png`/`tong-*.png`/`wan-*.png`/`back.png` 平铺图，无方向子目录 |
| 2 | 牌桌就是一个半透明暗色 flexbox 容器，一张 `bg_table.png` 凑数 | `.mj` 容器无绿色桌面、无角落装饰、无边框 |
| 3 | 出牌必须两步：单击选牌（上移 10px + 金框）→ 点底部"出牌"按钮 | `MahjongBoard.vue` 第 94-105 行单击选牌，第 381-388 行单独出牌按钮 |
| 4 | 副露（碰/杠）就是 MahjongTile 一行挤在一起，无形状区分 | 第 311-322 行，`.mj__my-meld` 只是 flex 一行 |

参考项目 babykylin_scmj（Cocos Creator）：

| # | 做法 | 我们能借 |
|---|---|---|
| 1 | 4 方向 Atlas（`M_`=自己、`B_`=对家、`L_`=左家、`R_`=右家），75×113px 正脸 | ✅ 从 Atlas 切出独立 PNG |
| 2 | 完整麻将桌 `mahjong_table.jpg` + 4 个角落装饰 `Z_corner_ltop/rtop/lbottom/rbottom` + 4 边边框 | ✅ 直接拷过来 |
| 3 | 双击出牌；或上滑超过阈值出牌；或拖拽出牌 | ✅ Web 版先做双击 |
| 4 | 碰 = 3 张堆叠（碰源朝上）、明杠 = 4 张 3+1 堆叠、暗杠 = 3 张牌背 + 1 张放大牌背 | ✅ CSS 堆叠实现 |

---

## §2 范围

### 2.1 本片做

1. **4 方向牌面**：从 babykylin_scmj 的 Cocos Atlas + plist 切出 4 方向 × 27 张正脸 + 4 张牌背 = 112 张独立 PNG，按方向分子目录放到 `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/`。`MahjongTile.vue` 新增 `direction` prop，按方向从对应目录加载。
2. **牌桌背景**：把 babykylin_scmj 的麻将桌底图 + 4 角落装饰 + 边框拷到 `static/ui/mahjong-table/`，替换 `MahjongBoard.vue` 容器背景。
3. **双击出牌**：手牌区域改成双击触发出牌（跳过"选牌→点按钮"两步）；单击仍然高亮选中，兼容换三张场景。
4. **副露独立组件**：新建 `MahjongMeld.vue`，按 `kind`（peng/addedGang/concealedGang/meldedGang）渲染不同堆叠样式。

### 2.2 明确不做

- 动作特效动画（胡/碰/杠/自摸 banner）—— Batch 2
- 音效接线（音频文件已有但未触发）—— Batch 2
- 弃牌河重构（当前塞在 SeatPanel 里）—— Batch 2
- 听牌提示强化 / 定缺推荐动画—— Batch 3
- 结算界面美化—— Batch 3
- 聊天 / 表情 / 语音——后续独立片
- 回放 / 重连 UI——后续独立片
- 拖拽/上滑出牌交互——Batch 2（如果双击反馈好就跳过）
- 新增时钟/动画引擎——沿用现有 animations 闸

---

## §3 设计

### D1 · 牌面资源：从 Cocos Atlas 切出独立 PNG

**决策**：写一个 Node.js 脚本 `scripts/extract-mahjong-tiles.mjs`，解析 babykylin_scmj 的 `.plist` + 对应 Atlas PNG，按 `frames` 字典里的 `frame`（矩形）和 `rotated` 切出独立 PNG。

**理由**：
- 不手写 PNG，不依赖外部工具链（ImageMagick/GIMP）。
- Cocos plist 是标准 XML PropertyList，可用 `fast-xml-parser` 解析。
- Canvas `ctx.getImageData` / `ctx.putImageData` 就能切。
- 切完后 Atlas 和 plist 原始文件不入库，只把切好的独立 PNG 入库。

**输出目录结构**：

```
apps/client/src/pages/table/static/mahjong/
├── my/                 # 自己方向的正脸（27 张）+ 牌背（1 张）
│   ├── wan-1.png ... wan-9.png
│   ├── tong-1.png ... tong-9.png
│   ├── tiao-1.png ... tiao-9.png
│   └── back.png
├── top/                # 对家方向的倒置正脸（27 张）+ 牌背
│   └── （同上）
├── left/               # 左家方向的横置正脸（27 张）+ 牌背
│   └── （同上）
└── right/              # 右家方向的横置正脸（27 张）+ 牌背
    └── （同上）
```

**方向映射**（参考 MJGame.js `getFoldPre`）：

| 本地座位 | 方向 | 目录名 | 牌面朝向 |
|---|---|---|---|
| me (0) | my | `my/` | 正 |
| top (2) | bottom（上家/对家） | `top/` | 倒置（CSS `transform: rotate(180deg)`） |
| left (3) | left | `left/` | 牌面朝右（CSS `transform: rotate(90deg)`） |
| right (1) | right | `right/` | 牌面朝左（CSS `transform: rotate(-90deg)`） |

> **简化方案**：其实 babykylin_scmj 的 Atlas 里各方向的牌面**已经是预旋转好的**——left 方向的牌面图本身就是面朝右的，不需要再 CSS 旋转。我们直接用不同目录的图片即可，CSS 只做正常堆叠。

**牌面命名映射**（babykylin → ftl）：

| babykylin | 含义 | ftl |
|---|---|---|
| M/B/L/R_character_{1..9}.png | 万 1-9 | wan-{1..9}.png |
| M/B/L/R_bamboo_{1..9}.png | 条 1-9 | tiao-{1..9}.png |
| M/B/L/R_circle_{1..9}.png | 筒 1-9 | tong-{1..9}.png |
| M/B/L/R_character.png | 万 1（备用） | 跳过 |
| M/B/L/R_bamboo.png | 条 1（备用） | 跳过 |
| M/B/L/R_circle.png | 筒 1（备用） | 跳过 |
| mjEmpty.png | 牌背 | back.png |
| M/B/L/R_paiban.png | （可能不存在）| back.png 的别名 |

> **川麻不需要字牌**，`M_autumn/spring/summer/winter.png` 跳过。

**测试**：切出后每方向 × 27 张正脸 + 1 张牌背 = 112 个文件；全部非空；文件名可被 MahjongTile.vue 正确解析。

---

### D2 · MahjongTile.vue：新增 direction prop

**决策**：MahjongTile.vue 新增可选 `direction: 'my' | 'top' | 'left' | 'right'` prop。有 direction 时从对应目录加载；无 direction 时降级用原来的平铺资源（保持向后兼容）。

**阻断项 1 修法（资源路径前缀错）**：现有 MahjongTile.vue 实际路径是 `/pages/table/static/mahjong/`（不是 `/static/mahjong/`）—— 这是 uni-app vite 的别名。全部新资源路径沿用此前缀。

**接口变化**：

```vue
<script setup lang="ts">
// 现有 props 不变，新增：
const props = defineProps<{
  // ... 原有 props ...
  direction?: 'my' | 'top' | 'left' | 'right';
}>();

// 资源路径计算：
const src = computed(() => {
  const base = '/pages/table/static/mahjong/';
  const dir = props.direction ?? '';
  const name = props.back ? 'back' : suitToName(props.tile);
  return dir ? `${base}${dir}/${name}.png` : `${base}${name}.png`;
});
</script>
```

**向后兼容**：不传 direction → 用平铺资源（`/pages/table/static/mahjong/wan-1.png`），现有跑得快/斗地主不受影响（它们不引用 MahjongTile）。

**默认 direction 映射**：

| 渲染位置 | direction | 说明 |
|---|---|---|
| 我的手牌 / 我的副露 / 我的弃牌 | `my` | 牌面朝我 |
| 对家（top）的副露 / 弃牌 | `top` | 牌面预倒置（Atlas 已处理） |
| 左家（left）的副露 / 弃牌 | `left` | 牌面预横置（Atlas 已处理） |
| 右家（right）的副露 / 弃牌 | `right` | 牌面预横置（Atlas 已处理） |
| 胡牌亮出的手牌（revealedHands）| 按座位 direction | 已胡者亮出的牌也按座位方向 |
| 中央 claimTile / tingTiles | `my` | 中央展示用正脸 |

> 高优问题（弃牌 direction 一致性）修法：MahjongSeatPanel.vue 里 discards 渲染 MahjongTile 时也传对应座位的 direction，确保四个方向的弃牌都"对自己好读"。

---

### D3 · 牌桌背景：替换容器背景

**决策**：把 babykylin_scmj 的 MJRoom 目录下的牌桌底图拷过来（如果只有独立小图 `Z_bg_bottom/Z_corner_*`，就用 CSS grid 拼出一个完整桌面）。

**新目录**：

```
apps/client/src/pages/table/static/ui/mahjong-table/
├── table.png              # 完整绿色桌面（如 babykylin 提供）
├── corner-lt.png          # 左上角装饰
├── corner-rt.png          # 右上角装饰
├── corner-lb.png          # 左下角装饰
└── corner-rb.png          # 右下角装饰
```

**CSS 替换**：

```scss
.mj {
  // 原 background 删掉
  background: url('/pages/table/static/ui/mahjong-table/table.png') center/cover no-repeat;
  box-shadow: inset 0 0 120px rgba(0, 40, 20, 0.4);
  border-radius: 12px;
  position: relative;
}

// 角落装饰：用 4 个 corner 子 view（因为伪元素难以放多张背景图 + 独立点击热区）
.mj__corner { position: absolute; width: 64px; height: 64px; pointer-events: none; }
.mj__corner--tl { top: 0; left: 0; background: url('/pages/table/static/ui/mahjong-table/corner-lt.png') no-repeat; }
.mj__corner--tr { top: 0; right: 0; transform: scaleX(-1); ... }
.mj__corner--bl { bottom: 0; left: 0; transform: scaleY(-1); ... }
.mj__corner--br { bottom: 0; right: 0; transform: scale(-1, -1); ... }
```

**降级**：已确认 babykylin MJRoom **没有完整 table.png**（只有独立的 Z_corner_* + Z_bg_bottom + Z_bg_lAr），所以用 CSS 拼桌面：
```scss
.mj {
  background: linear-gradient(180deg, #0f5a2e 0%, #1a7a3a 50%, #0f5a2e 100%);
  background-image:
    url('/pages/table/static/ui/mahjong-table/Z_bg_bottom.png'),
    /* 四角角落装饰 */;
}
```
先写纯 CSS 绿色桌面 + 角落装饰，视觉够用；如果效果不好 Batch 2 再合成完整 table.png。

---

### D4 · 双击出牌交互

**决策**：手牌从"单击选牌 + 点按钮出牌"改成**双击直接出牌**。

**行为表**：

| 阶段 | 单击 | 双击 |
|---|---|---|
| 换三张 (phase=exchange, amActive) | 选/取消选中（最多 3 张同花色） | 同单击（换三张本来就是多选场景，双击语义不清晰） |
| 出牌 (phase=play, amActive) | 高亮选中（视觉反馈） | **直接出牌** |
| claim/rob | 手牌不可选 | 同上 |
| 非我的回合 | 手牌禁用（灰） | 无 |

**实现**：

```vue
// MahjongBoard.vue 里：
const lastClickIndex = ref<number>(-1);
const lastClickTime = ref<number>(0);

function onTileClick(index: number): void {
  if (!handSelectable.value) return;
  if (phase.value === 'exchange') {
    // 换三张保持原多选逻辑
    ...
  } else {
    // 出牌阶段：单击 = 选中；双击 = 出牌
    const now = Date.now();
    if (lastClickIndex.value === index && now - lastClickTime.value < 400) {
      // 双击
      const tile = hand.value[index];
      if (tile) {
        submit({ type: 'discard', tile });
      }
      lastClickIndex.value = -1;
    } else {
      // 单击
      selected.value = [index];
      lastClickIndex.value = index;
      lastClickTime.value = now;
    }
  }
  haptic('light');
}
```

**动效反馈**：双击出牌瞬间，那张牌播放 `@keyframes tile-fly-out { ... }` 飞出效果（CSS animation，200ms）。—— 这个属于 Batch 2，Batch 1 先不加动画。

**出牌按钮保留**：底部"出牌"按钮保留，作为**辅助方式**（新手/不喜欢双击的用户可以继续按钮出牌）。如果将来观察到 95% 用户都用双击，再考虑移除。

---

### D5 · MahjongMeld.vue 独立组件

**阻断项 2 修法（类型契约冲突）**：protocol 实际枚举值是 `MahjongMeldKind = 'peng' | 'gang' | 'angang'`（三值），**gang 统一涵盖直杠和补杠**，区分方式是 `fromSeat !== undefined`（直杠 fromSeat=点杠者，补杠 fromSeat=undefined）。设计里错误写 4 值——修订为：

| kind | 含义 | tiles 长度 | 额外字段 |
|---|---|---|---|
| `'peng'` | 碰 | 3 | fromSeat（点碰者） |
| `'gang'` | 杠（直杠/补杠） | 4 | fromSeat !== undefined = 直杠（点杠者）；undefined = 补杠 |
| `'angang'` | 暗杠 | 4 | fromSeat 始终 undefined |

**Props**：

```ts
import type { MahjongMeldView } from '@fight-the-landlord/protocol';

defineProps<{
  meld: MahjongMeldView;
  direction?: 'my' | 'top' | 'left' | 'right';
}>();
```

**堆叠样式**（Batch 1 先做 2 级区分：peng / gang-or-angang；补杠 vs 直杠 Batch 2 再细化标记）：

| kind | tiles 长度 | 视觉 |
|---|---|---|
| `'peng'` | 3 | 3 张横排，后两张负 margin 叠加；碰源（fromSeat）那张**视觉上叠在上面**（z-index） |
| `'gang'` | 4 | 3 张横排 + 第 4 张在**中间那张正上方**（堆叠），不分直杠/补杠 |
| `'angang'` | 4 | 4 张牌背堆叠；或 3 张牌背横排 + 第 4 张放大牌背 |

**样式分类逻辑**（组件内部计算）：

```ts
const isGang = computed(() => props.meld.kind === 'gang' || props.meld.kind === 'angang');
const isAnGang = computed(() => props.meld.kind === 'angang');
const styleClass = computed(() => {
  if (props.meld.kind === 'peng') return 'mj-meld--peng';
  if (isAnGang.value) return 'mj-meld--angang';
  return 'mj-meld--gang';
});
```

**CSS 核心**：

```scss
.mj-meld { display: inline-flex; align-items: flex-end; position: relative; }
.mj-meld :deep(.mj-tile) { margin-left: -14px; }
.mj-meld :deep(.mj-tile:first-child) { margin-left: 0; }

// 明杠：第 4 张用绝对定位叠在中间那张（index 2）正上方
.mj-meld--gang .mj-meld__cap {
  position: absolute;
  left: calc(50% - 14px);
  bottom: 100%;
  z-index: 3;
}

// 暗杠：4 张牌背堆叠成 2×2
.mj-meld--angang {
  // 类似 gang，但 4 张全是 back=true
}
```

**Batch 1 简化**：补杠 vs 直杠在 UI 上**暂不区分**（都用明杠堆叠样式）。原因：区分需要服务端额外下发 `gangType`，当前 protocol 没这个字段；Batch 2 提协议字段或从规则推断再补。

---

## §4 涉及文件

| 操作 | 文件 | 说明 |
|---|---|---|
| **新建** | `scripts/extract-mahjong-tiles.mjs` | 从 Cocos Atlas 切独立 PNG 的 Node 脚本 |
| **新建** | `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/` × 28 文件 | 4 方向牌面资源 |
| **新建** | `apps/client/src/pages/table/static/ui/mahjong-table/` × 5 文件 | 牌桌背景 + 角落装饰（来自 babykylin MJRoom） |
| **新建** | `apps/client/src/components/table/mahjong/MahjongMeld.vue` | 副露独立组件 |
| **修改** | `apps/client/src/components/table/mahjong/MahjongTile.vue` | 新增 `direction?` prop |
| **修改** | `apps/client/src/components/table/mahjong/MahjongBoard.vue` | 背景替换、双击出牌、MahjongMeld 替换 `.mj__my-meld` |
| **修改** | `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue` | 副露渲染改用 MahjongMeld + direction prop |
| **新建** | `THIRD-PARTY-NOTICES.md`（如果没有） | 登记素材来源 babykylin/babykylin_scmj |

**不动**：
- `packages/protocol/src/mahjong/*` — 协议层零改动
- `packages/shared/src/mahjong/*` — 规则层零改动
- `packages/game-service/*` — 服务端零改动
- `packages/room-service/*` — 零改动
- 后端任何代码

---

## §5 测试判据

| # | 判据 | 类型 |
|---|---|---|
| T1 | 切出脚本运行后 4 × (27 + 1) = 112 个 PNG 文件存在且非零字节 | 资源脚本 |
| T2 | 每个牌面文件名可被 `suitToName(tile)` 正确解析（万1-9/tong1-9/tiao1-9/back） | 单元 |
| T3 | MahjongTile.vue 不传 direction 时仍加载平铺资源（向后兼容） | 单元/Vue |
| T4 | MahjongBoard.vue 出牌阶段双击手牌触发 `submit({type:'discard', tile})`；单击只高亮 | 交互 |
| T5 | 换三张阶段单击选中逻辑保持不变（双击不单独出牌） | 交互 |
| T6 | MahjongMeld.vue 对 peng / gang / angang 3 种 kind 渲染不同结构；gang 和 angang 都渲染 4 张堆叠 | 单元/Vue |
| T7 | `pnpm -C apps/client test` 全部通过 | 全量 |
| T8 | `pnpm -C apps/client run lint`（vue-tsc）无新增错误 | 类型 |
| T9 | 旧跑得快/斗地主页面不受影响（它们的 table 壳不引用 MahjongBoard/MahjongTile） | 回归 |

---

## §6 风险与缓解

| 风险 | 概率 | 影响 | 处置 |
|---|---|---|---|
| babykylin Atlas 切出的牌面与川麻规则不符（字牌/花牌混入） | 低 | 中 | 川麻只 27 种，切出后人工核对；跳过 autumn/spring/summer/winter |
| Plist XML 解析边界（rotated=true 时 frame 尺寸互换） | 中 | 中 | 脚本里显式处理 rotated：互换 w/h 并旋转 |
| 双击与长按手机端冲突 | 中 | 中 | 400ms 间隔内算双击；touch 设备不额外处理（双指手势） |
| 副露堆叠在小屏上溢出 | 低 | 低 | 用 flex-shrink + overflow hidden；极端情况允许副露超出面板 |
| MahjongTile.vue 改动影响其他玩法 | 低 | 低 | 不传 direction = 旧行为；斗地主跑得快目前不共用该组件 |

---

## §7 不做清单（重申，防蔓延）

- [ ] 动作特效动画（Batch 2）
- [ ] 音效接线（Batch 2，音频文件已有）
- [ ] 弃牌河重构（Batch 2）
- [ ] 拖拽/上滑出牌（Batch 2 视双击反馈决定）
- [ ] 定缺推荐动画 / 听牌强化（Batch 3）
- [ ] 结算界面美化（Batch 3）
- [ ] 聊天 / 表情 / 语音（后续独立片）
- [ ] 新增时钟/动画引擎（闸内已有）
- [ ] 后端/协议/服务端任何改动

---

## §8 审查记录

### 第 1 轮对抗审查（独立 reviewer agent，2026-10-28）

**分级：2 阻断 / 4 高 / 5 低，全部在 v0.2 修订中处置**

| # | 级 | 问题 | 处置 |
|---|---|---|---|
| R1 | 阻断 | **类型契约冲突**：D5 里 MahjongMeldKind 误写 4 值（peng/addedGang/meldedGang/angang），protocol 实际是 3 值（peng/gang/angang）。gang 统一涵盖直杠+补杠，区分靠 fromSeat | 修订 D5 为 3 值 + gang 内部用 fromSeat 区分直杠/补杠（Batch 1 UI 暂不区分） |
| R2 | 阻断 | **资源路径前缀错**：D2/D3 用 `/static/mahjong/`，实际项目是 `/pages/table/static/mahjong/`（uni-app vite 别名） | 全部路径统一改为 `/pages/table/static/` |
| R3 | 高 | Plist rotated=true 时 frame 尺寸是否互换——已确认 my 方向的 plist 里 rotated=true 的条目 frame {w,h} 仍是原始尺寸 {75,113} 未互换，但脚本仍要处理 canvas rotation | D1 补充脚本须显式处理 ctx.translate + ctx.rotate(Math.PI/2) |
| R4 | 高 | 副露 direction 语义：SeatPanel compact 模式下副露是横排小面板，direction='top' 时牌面其实还是正着展示（用户看副露而不是看座位方向）—— 但 Atlas 预旋转过，direction='top' 加载的是倒置图 | 已确认 babykylin 的 bottom Atlas 图本身就是倒置的，direction='top' 加载该图刚好是"对我好读"的方向。保留原设计 |
| R5 | 高 | selected 残留：出牌后或 phase 变化时 selected 值会不会没清 | 已有现有代码 watch 手牌变化清空 selected（Board.vue L87-92），双击出牌后手牌内容不变但 selected 没清——双击路径加 `selected.value = []` |
| R6 | 高 | 换三张 phase 边界：phase='exchange' 且非 amActive 时 selected 状态 | 保留原 watch 清空逻辑；换三张阶段 amActive=false 时 handSelectable=false，onTileClick 直接 return |
| R7 | 低 | MJRoom 没有完整 table.png，只有独立小图 | D3 降级为 CSS 渐变 + corner 拼 |
| R8 | 低 | 弃牌河 direction 一致性 | MahjongSeatPanel.vue discards 也传对应座位 direction，已加进 D2 默认映射表 |
| R9 | 低 | 切图脚本路径常量（baseDir/plistDir 硬编码） | 实现时从 argv 读，允许 `npm run extract-mahjong-tiles -- --src=D:/Code/babykylin_scmj/...` |
| R10 | 低 | z-index 层级：副露堆叠盖过相邻副露；角落装饰不挡住按钮 | 角落装饰 pointer-events:none、最底层 z-index；按钮 z-index 最高 |
| R11 | 低 | MahjongMeld 的 MELD_LABEL（"碰/杠/暗杠"文字）归谁 | Batch 1 仍由 Board.vue/SeatPanel.vue 渲染 label，MahjongMeld 只管堆叠；Batch 2 可让组件自带 label |

**确认无误的维度**（reviewer 明确通过）：
- Tile suit/r → 文件名映射（wan/tong/tiao + 1-9）正确
- Atlas 尺寸合理（512×1024 < 2048，Canvas 能处理）
- 动画闸：Batch 1 不造新时钟，沿用 scoped CSS transition
- MahjongTile.vue 向后兼容（不传 direction = 旧行为）
- 跑得快/斗地主不引用 MahjongBoard/MahjongTile，不受影响
