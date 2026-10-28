# 四川麻将 UI 升级 · Batch 1 实现计划 v0.2

> **依据**：`docs/superpowers/specs/2026-10-28-mahjong-ui-batch1-design.md` v0.2（2 阻断 / 4 高 / 5 低已处置）。
> **分支**：`majiang`。**接触面**：纯客户端 `apps/client/src/` + `scripts/`。
> **v0.2 修订**：计划审查 4 阻断（B1 筒子命名 dot / B2 牌背独立 Atlas / B3 无图像处理库 / B4 无 XML 库）+ 5 高（H1 suitName 不存在 / H2 四方向尺寸不一致 / H3 rotated 处理 / H4 bottom 全 rotated=false / H5 cap tile 防御性）+ 3 低全部处置。

## Global Constraints

- 资源路径：`/pages/table/static/mahjong/{my,top,left,right}/` + `/pages/table/static/ui/mahjong-table/`。
- 筒子 babykylin 前缀是 `dot`（不是 circle）。
- 牌背从独立 `MJ/mjEmpty.{png,plist}` 切，key = `e_mj_v_1.png`。
- `@napi-rs/canvas` 做图像处理；XML 用纯 regex 提取 plist `<key>/<string>` 对。
- `MahjongMeldKind` 是 protocol 3 值联合：`'peng' | 'gang' | 'angang'`。
- MahjongTile.vue 用内联 `SUIT_FILES = ['wan', 'tong', 'tiao']`，没有 suitName 函数。
- seatDirection 用 Board.vue 显式传 direction prop 给 SeatPanel，避免 seat 数字和视觉方向的映射混乱。
- left/right Atlas 牌面尺寸 49×40（横置），CSS width/height 需按方向区分。

---

## T1-pre · 依赖安装

```bash
pnpm add -Dw @napi-rs/canvas
```

验证：`node -e "const { Canvas } = require('@napi-rs/canvas'); console.log('ok', Canvas)"`

## T1 · 切图脚本 + 4 方向资源落盘

**Files**
- 新建 `scripts/extract-mahjong-tiles.mjs`
- 输出：`apps/client/src/pages/table/static/mahjong/{my,top,left,right}/` × 28 文件
- 输出：`apps/client/src/pages/table/static/ui/mahjong-table/` × 5 文件

**Atlas 来源**（D:\Code\babykylin_scmj\client\assets\resources\textures\）

| 目录名 | babykylin Atlas | 前缀 | 牌面尺寸 |
|---|---|---|---|
| `my` | `MJ/my/Z_my.{png,plist}` | `M_` | 75×113 |
| `top` | `MJ/bottom/Z_bottom.{png,plist}` | `B_` | 55×84（全部 rotated=false） |
| `left` | `MJ/left/Z_left.{png,plist}` | `L_` | 49×40（横置） |
| `right` | `MJ/right/Z_right.{png,plist}` | `R_` | 49×40（横置） |
| 牌背 | `MJ/mjEmpty.{png,plist}` | — | 83×125，key=`e_mj_v_1.png` |

**Plist XML regex 提取**：
```js
function parsePlist(text) {
  const frames = {};
  const frameRe = /<key>([M/B/L/R]_[A-Za-z]+_\d+\.png)<\/key>/g;
  // 每个 key 后面紧跟 <dict>...</dict>，包含 frame/sourceSize/rotated
  const blockRe = /<key>([\w\.]+\.png)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let m;
  while ((m = blockRe.exec(text))) {
    const key = m[1];
    const block = m[2];
    const frameMatch = block.match(/<key>frame<\/key>\s*<string>\{\{(\d+),(\d+)\},\{(\d+),(\d+)\}\}<\/string>/);
    const ssMatch = block.match(/<key>sourceSize<\/key>\s*<string>\{(\d+),(\d+)\}<\/string>/);
    const rotatedMatch = block.match(/<key>rotated<\/key>\s*<(true|false)\/>/);
    if (frameMatch && ssMatch) {
      frames[key] = {
        frame: { x: +frameMatch[1], y: +frameMatch[2], w: +frameMatch[3], h: +frameMatch[4] },
        sourceSize: { w: +ssMatch[1], h: +ssMatch[2] },
        rotated: rotatedMatch ? rotatedMatch[1] === 'true' : false,
      };
    }
  }
  return frames;
}
```

**过滤规则**（27 正脸，跳过字牌花牌）：
```js
const KEEP_RE = /^[MBLR]_(character|dot|bamboo)_([1-9])\.png$/;
// character → wan, dot → tong, bamboo → tiao
```

**牌背独立切**：
```js
const backFrame = frames['e_mj_v_1.png']; // 来自 mjEmpty.plist
// 切一份写 4 个方向目录
```

**rotated 处理（Atlas 上横着存的图要旋转 90° 取出立正）**：
```js
if (info.rotated) {
  // atlas 上存的矩形是交换后的：宽=srcH, 高=srcW
  const srcW = info.sourceSize.w, srcH = info.sourceSize.h;
  const tmp = new Canvas(srcH, srcW);  // 先横着裁
  const tctx = tmp.getContext('2d');
  tctx.drawImage(atlas, info.frame.x, info.frame.y, srcH, srcW, 0, 0, srcH, srcW);
  // 旋转写入目标画布
  const out = new Canvas(srcW, srcH);
  const octx = out.getContext('2d');
  octx.save();
  octx.translate(srcW / 2, srcH / 2);
  octx.rotate(Math.PI / 2);
  octx.translate(-srcH / 2, -srcW / 2);
  octx.drawImage(tmp, 0, 0);
  octx.restore();
  fs.writeFileSync(outPath, out.toBuffer('image/png'));
} else {
  const { Canvas } = require('@napi-rs/canvas');
  const out = new Canvas(info.sourceSize.w, info.sourceSize.h);
  const ctx = out.getContext('2d');
  ctx.drawImage(atlas, info.frame.x, info.frame.y, info.frame.w, info.frame.h, 0, 0, info.sourceSize.w, info.sourceSize.h);
  fs.writeFileSync(outPath, out.toBuffer('image/png'));
}
```

**资源拷入**（MJRoom → ui/mahjong-table/）：
```bash
Copy-Item "D:\Code\babykylin_scmj\client\assets\resources\textures\MJRoom\Z_corner_ltop.png" ...
Copy-Item "D:\Code\babykylin_scmj\client\assets\resources\textures\MJRoom\Z_corner_rtop.png" ...
Copy-Item "D:\Code\babykylin_scmj\client\assets\resources\textures\MJRoom\Z_corner_lbottom.png" ...
Copy-Item "D:\Code\babykylin_scmj\client\assets\resources\textures\MJRoom\Z_corner_rbottom.png" ...
Copy-Item "D:\Code\babykylin_scmj\client\assets\resources\textures\MJRoom\Z_bg_bottom.png" ...
```

**运行**：
```bash
node scripts/extract-mahjong-tiles.mjs
# 验证
Get-ChildItem apps/client/src/pages/table/static/mahjong/my/ -File | Measure-Object  # 28
Get-ChildItem apps/client/src/pages/table/static/mahjong/ -Recurse -File | Measure-Object  # 112
Get-ChildItem apps/client/src/pages/table/static/ui/mahjong-table/ -File | Measure-Object  # 5
```

**提交**。

---

## T2 · MahjongTile.vue：新增 direction prop

**Files**：修改 `apps/client/src/components/table/mahjong/MahjongTile.vue`

**Step**：
1. 读现有 src computed（`SUIT_FILES = ['wan', 'tong', 'tiao']` 内联）。
2. 新增 prop：`direction?: 'my' | 'top' | 'left' | 'right'`。
3. 改 src computed：
   ```ts
   const src = computed(() => {
     const base = '/pages/table/static/mahjong/';
     const dir = props.direction ? `${props.direction}/` : '';
     if (props.back || !props.tile) return `${base}${dir}back.png`;
     const suit = SUIT_FILES[props.tile.s];
     return `${base}${dir}${suit}-${props.tile.r}.png`;
   });
   ```
4. 新增 CSS class（按 direction 调整宽高比）：
   ```scss
   .mj-tile { width: 34px; height: 51px; ... }          // my/top 默认
   .mj-tile--side { width: 40px; height: 33px; ... }    // left/right 横置
   ```
5. `pnpm -C apps/client run lint` —— 零错误。提交。

---

## T3 · MahjongBoard.vue：牌桌背景 + 角落装饰

**Files**：修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

**Step**：
1. `.mj` 容器 background 改 CSS 渐变绿色桌面：
   ```scss
   .mj {
     background: linear-gradient(180deg, #0e4f28 0%, #1a7a3a 50%, #0e4f28 100%);
     box-shadow: inset 0 0 120px rgba(0, 30, 15, 0.5);
     border-radius: 16px;
     position: relative;
   }
   ```
2. `.mj` 内部加 4 个角落装饰子 view（pointer-events:none, z-index:0）。
3. 层级保持：corner=0, bar=1, content=2, action=3, trustee-mask=4。
4. lint。提交。

---

## T4 · 双击出牌交互

**Files**：修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`

**Step**：
1. 读现有 `onTileClick`（L94-105），替换为：
   ```ts
   const lastClickIndex = ref<number>(-1);
   const lastClickTime = ref<number>(0);

   function onTileClick(index: number): void {
     if (!handSelectable.value) return;
     haptic('light');
     if (phase.value === 'exchange') {
       // 换三张：保持原多选逻辑
       const at = selected.value.indexOf(index);
       if (at >= 0) selected.value.splice(at, 1);
       else if (selected.value.length < 3) selected.value.push(index);
       lastClickIndex.value = -1;
       return;
     }
     // 出牌窗口：单击=高亮；双击(400ms)=直接出牌
     const now = Date.now();
     const isDoubleClick =
       lastClickIndex.value === index && now - lastClickTime.value < 400;
     if (isDoubleClick) {
       const tile = hand.value[index];
       if (tile && !props.busy) {
         submit({ type: 'discard', tile });
         selected.value = [];
         lastClickIndex.value = -1;
       }
       return;
     }
     selected.value = selected.value.length === 1 && selected.value[0] === index
       ? []
       : [index];
     lastClickIndex.value = index;
     lastClickTime.value = now;
   }
   ```
2. 保留底部"出牌"按钮作为辅助。
3. lint。提交。

---

## T5 · MahjongMeld.vue + SeatPanel/Board 接线

**Files**
- 新建 `apps/client/src/components/table/mahjong/MahjongMeld.vue`
- 修改 `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue`（新增 direction prop + 副露/弃牌渲染改用 MahjongMeld + 透传 direction）
- 修改 `apps/client/src/components/table/mahjong/MahjongBoard.vue`（替换 `.mj__my-meld` + 给 SeatPanel 显式传 direction）

**Step 1**：新建 MahjongMeld.vue：
```vue
<script setup lang="ts">
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

const props = defineProps<{
  meld: MahjongMeldView;
  direction?: 'my' | 'top' | 'left' | 'right';
}>();

const styleClass = computed(() => {
  if (props.meld.kind === 'peng') return 'mj-meld--peng';
  if (props.meld.kind === 'angang') return 'mj-meld--angang';
  return 'mj-meld--gang';
});
const capTile = computed<Tile | undefined>(() => props.meld.tiles[3]);
</script>

<template>
  <view class="mj-meld" :class="styleClass">
    <MahjongTile
      v-for="(tile, i) in meld.tiles.slice(0, 3)"
      :key="`t-${i}`"
      :tile="tile"
      :direction="direction"
      size="sm"
    />
    <MahjongTile
      v-if="capTile"
      class="mj-meld__cap"
      :tile="capTile"
      :back="meld.kind === 'angang'"
      :direction="direction"
      size="sm"
    />
  </view>
</template>
```

**Step 2**：Board.vue 给 SeatPanel 显式传 direction：
```html
<MahjongSeatPanel v-bind="seatPanelProps(topSeat)" compact direction="top" />
<MahjongSeatPanel v-bind="seatPanelProps(leftSeat)" compact direction="left" />
<MahjongSeatPanel v-bind="seatPanelProps(rightSeat)" compact direction="right" />
```
自己的 SeatPanel（如果有）传 direction="my"。

**Step 3**：SeatPanel.vue：
- 新增 `direction?: 'my' | 'top' | 'left' | 'right'` prop（默认 'my'）。
- 副露渲染替换 `v-for="(meld, i) in melds"` + MahjongTile 为 MahjongMeld，透传 :direction。
- 弃牌 discards 渲染 MahjongTile 时加 `:direction="direction"`。

**Step 4**：Board.vue `.mj__my-meld` 替换为 MahjongMeld（direction="my"）。

**Step 5**：CSS：
```scss
.mj-meld {
  display: inline-flex;
  align-items: flex-end;
  position: relative;
  :deep(.mj-tile) { margin-left: -14px; }
  :deep(.mj-tile:first-child) { margin-left: 0; }
}
.mj-meld__cap {
  position: absolute;
  left: calc(50% - 14px);
  bottom: 100%;
  z-index: 3;
}
```

**Step 6**：lint。提交。

---

## T6 · 全量验证

```bash
pnpm -C apps/client run lint   # vue-tsc 零错误
pnpm -C apps/client test       # 全部通过
pnpm -C packages/protocol test # 回归不受影响
pnpm -C packages/shared test   # 回归不受影响
```

---

## Verification Commands

```bash
# 切图脚本 + 资源目录验证
Get-ChildItem apps/client/src/pages/table/static/mahjong/my/ -File | Measure-Object
Get-ChildItem apps/client/src/pages/table/static/mahjong/ -Recurse -File | Measure-Object
Get-ChildItem apps/client/src/pages/table/static/ui/mahjong-table/ -File | Measure-Object

# 代码验证
pnpm -C apps/client run lint
pnpm -C apps/client test

# 回归
pnpm -C packages/protocol test
pnpm -C packages/shared test
```

## Plan Review Checklist (v0.2)

- [x] T1-pre 加依赖安装（@napi-rs/canvas）
- [x] T1 筒子命名 circle→dot、牌背独立 Atlas、plist regex 提取、rotated 精确实现
- [x] T2 suitName→内联 SUIT_FILES、CSS 按方向分档
- [x] T3 背景降级为 CSS 渐变 + corner
- [x] T4 双击 400ms 间隔 + exchange 阶段不触发 + doubleclick 后清 selected
- [x] T5 显式 direction prop 传递链（Board→SeatPanel→MahjongMeld/MahjongTile）、capTile 防御性 computed
- [x] 不动 protocol / shared / backend
- [x] 跑得快/斗地主不受影响
