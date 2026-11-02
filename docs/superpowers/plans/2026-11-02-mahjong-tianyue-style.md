# 实现计划：麻将牌桌「天月麻雀」风格重制

Spec：`docs/superpowers/specs/2026-11-02-mahjong-tianyue-style-design.md`（v2，已对抗审查）
日期：2026-11-02
分支：`dev`
范围：纯客户端展示层（麻将牌桌）

## Global Constraints

- **纯客户端**：不改 `packages/protocol`、`packages/game-service`、配置中心、数据库、admin。
- **TDD**：每个任务先写/改失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。
- **token 纪律**：组件样式只用 `$ftl-*` / 新增 `$ftl-color-mj-*`；不写裸 hex；描边一律
  `$ftl-hairline`（2px），不写 `1px`；不新增 `@keyframes`（复用 `anim-urgent-pulse`）。
- **素材**：FluffyStuff CC0（pin `26e127ba2117f45cdce5ea0225748cc0cfad3169`）；生成结果入库；
  Pillow/numpy 仅开发期。
- **提交**：每任务一个 commit，信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **验证命令**：
  - `pnpm -C apps/client test`
  - `pnpm -C apps/client run lint`
  - 定向：`pnpm -C apps/client test -- mahjong` / `asset-budget` / `ui-tokens`
- **不夹带**：不重构无关页面；不改旧 `$ftl-color-mahjong-table*` token 定义（只停止引用）。

---

## Task 0：基线转绿（prep）

### Files
- `apps/client/src/components/table/mahjong/MahjongTile.vue`
- `apps/client/src/components/table/mahjong/MahjongMeld.vue`
- `apps/client/test/mahjong-board.test.ts`

### 现状（已实测）
- `pnpm -C apps/client run lint` 6 错：
  - `MahjongTile.vue` 17/45/69：未声明 `rotate` + 未使用 `Rotate`。
  - `MahjongMeld.vue` 20/36/83：未声明 `vertical` + 未使用 `Rotate`。
- `pnpm -C apps/client test -- mahjong` 2 红：
  - `mahjong-board.test.ts:195` 期望 `.mj__hand` 隐藏、`.mj__my-revealed` 存在（模板已改为
    在 `.mj__hand` 内 `v-if="myRevealed"` 渲染）。
  - `mahjong-board.test.ts:219` 找 `.mj__phase`（模板里是 `.mj-center__phase`）。

### Steps
1. `MahjongTile.vue`：
   - 删除 `type Rotate = ...`。
   - `src` computed 改为 `const dir = `${props.direction ?? 'my'}/`;`。
   - 模板 class 删除 `rotate ? \`mj-tile--rotate-${rotate}\` : null`。
   - 删除 CSS `.mj-tile--rotate-left/right` 整块与相关注释。
2. `MahjongMeld.vue`：
   - 删除 `type Rotate = ...`。
   - `withDefaults` 删除 `vertical: false`。
   - 模板 class 删除 `{ 'mj-meld--vertical': vertical }`。
3. `mahjong-board.test.ts`：
   - 第一个失败用例改为：
     - `expect(wrapper.find('.mj__hand').exists()).toBe(true)`；
     - `expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(revealedTiles.length)`；
     - `expect(wrapper.findAll('.mj__hand .anim-deal-in')).toHaveLength(0)`。
   - 第二个失败用例改为：
     - `expect(wrapper.find('.mj-center__phase').text()).toContain('等待其他玩家响应')`；
     - `expect(wrapper.find('.mj__actions').text()).not.toContain('等待其他玩家响应')`。
4. 跑：
   - `pnpm -C apps/client run lint` → 0 错误。
   - `pnpm -C apps/client test -- mahjong` → 全绿。
5. Commit：`fix(client): 麻将基线修复（删死 prop、修陈旧断言）`。

### 判别力
- 删除前两条测试必红；修复后绿。lint 的 6 个错误逐条消失。

---

## Task 1：素材管线 + 主题 token + 预算闸

### Files
- New `scripts/assets/mahjong/fluffystuff/`（29 张 PNG + `LICENSE.md` + `README.md`）
- New `scripts/build-mahjong-tile-set.py`
- Replace `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/*.png`
- New `apps/client/src/pages/table/static/mahjong/manifest.json`
- `apps/client/src/uni.scss`
- `THIRD-PARTY-NOTICES.md`
- `apps/client/src/static/ASSETS.md`
- `scripts/extract-mahjong-tiles.mjs`（文件头加退役说明）
- `apps/client/test/asset-budget.test.ts`
- New `apps/client/test/mahjong-assets.test.ts`

### Step 1.1：先写失败测试（预算 + 素材完整性）
`asset-budget.test.ts`：
- `BUDGET_KIB` 增加 `'table/mahjong': 768`。
- `BUDGET_DIRS` 增加 `'table/mahjong': join(TABLE_STATIC, 'mahjong')`。
- 判别力自证 `Object.keys(BUDGET_KIB)).toHaveLength(6)` 改 `7`。
- 增加 `expect(dirSizeKiB(join(TABLE_STATIC,'mahjong'))).toBeGreaterThan(300)`。
- 跑 `pnpm -C apps/client test -- asset-budget` → **红**（当前 980KiB > 768）。

新建 `mahjong-assets.test.ts`（此时新文件不存在 → 红）：
```ts
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT } from './helpers/source-scan';

const ROOT = join(SRC_ROOT, 'pages/table/static/mahjong');
const DIRS = ['my', 'top', 'left', 'right'] as const;
const SUITS = ['wan', 'tong', 'tiao'] as const;

function sha(buf: Buffer) { return createHash('sha256').update(buf).digest('hex'); }

async function redCentroid(path: string) {
  const img = await loadImage(readFileSync(path));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
      if (a > 128 && r > 120 && r > g * 1.5 && r > b * 1.5) { sx += x; sy += y; n += 1; }
    }
  }
  return { x: sx / n / width, y: sy / n / height, n };
}

describe('麻将素材完整性', () => {
  it('四方向 27 面 + 背牌', () => {
    for (const dir of DIRS) {
      const files = readdirSync(join(ROOT, dir));
      expect(files).toContain('back.png');
      for (const s of SUITS) for (let r = 1; r <= 9; r += 1) {
        expect(files).toContain(`${s}-${r}.png`);
      }
      expect(files.filter((f) => f.endsWith('z.png'))).toEqual([]);
    }
  });

  it('manifest 哈希/尺寸一致', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(manifest.source).toContain('FluffyStuff/riichi-mahjong-tiles');
    expect(manifest.license).toBe('CC0-1.0');
    for (const e of manifest.files) {
      const buf = readFileSync(join(ROOT, e.file));
      expect(sha(buf)).toBe(e.sha256);
      expect(e.width).toBe(e.file.startsWith('my/') || e.file.startsWith('top/') ? 180 : 240);
      expect(e.height).toBe(e.file.startsWith('my/') || e.file.startsWith('top/') ? 240 : 180);
    }
  });

  it('同方向 27 面互不相同', () => {
    for (const dir of DIRS) {
      const hashes = SUITS.flatMap((s) =>
        Array.from({ length: 9 }, (_, i) =>
          sha(readFileSync(join(ROOT, dir, `${s}-${i + 1}.png`)))));
      expect(new Set(hashes).size).toBe(27);
    }
  });

  it('方向抽检：1 万红字重心', async () => {
    const my = await redCentroid(join(ROOT, 'my/wan-1.png'));
    const left = await redCentroid(join(ROOT, 'left/wan-1.png'));
    const right = await redCentroid(join(ROOT, 'right/wan-1.png'));
    expect(my.y).toBeGreaterThan(0.55);
    expect(left.x).toBeLessThan(0.45);
    expect(right.x).toBeGreaterThan(0.55);
  });
});
```
- 跑 `pnpm -C apps/client test -- mahjong-assets` → **红**（文件缺失）。

### Step 1.2：vendor 源图
```bash
mkdir -p scripts/assets/mahjong/fluffystuff
BASE="https://raw.githubusercontent.com/FluffyStuff/riichi-mahjong-tiles/26e127ba2117f45cdce5ea0225748cc0cfad3169/Export/Regular"
for f in Front Back Man1 Man2 Man3 Man4 Man5 Man6 Man7 Man8 Man9 \
         Pin1 Pin2 Pin3 Pin4 Pin5 Pin6 Pin7 Pin8 Pin9 \
         Sou1 Sou2 Sou3 Sou4 Sou5 Sou6 Sou7 Sou8 Sou9; do
  curl -fsSL "$BASE/$f.png" -o "scripts/assets/mahjong/fluffystuff/$f.png"
done
curl -fsSL "https://raw.githubusercontent.com/FluffyStuff/riichi-mahjong-tiles/26e127ba2117f45cdce5ea0225748cc0cfad3169/LICENSE.md" \
  -o scripts/assets/mahjong/fluffystuff/LICENSE.md
```
- 校验：`file` 每张为 600×800 PNG；`LICENSE.md` 含 CC0。

### Step 1.3：生成脚本
`scripts/build-mahjong-tile-set.py`：
```python
#!/usr/bin/env python3
"""从 FluffyStuff CC0 源图生成四方向麻将牌面（180x240 / 240x180，64 色量化）。"""
from PIL import Image
import numpy as np, hashlib, json, os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scripts/assets/mahjong/fluffystuff')
OUT = os.path.join(ROOT, 'apps/client/src/pages/table/static/mahjong')
SUITS = {'Man': 'wan', 'Pin': 'tong', 'Sou': 'tiao'}
DIRS = {'my': 0, 'top': 180, 'left': -90, 'right': 90}  # PIL 正角度=逆时针

def composed(name: str) -> Image.Image:
    front = Image.open(os.path.join(SRC, 'Front.png')).convert('RGBA')
    glyph = Image.open(os.path.join(SRC, name)).convert('RGBA')
    return Image.alpha_composite(front, glyph)

def navy_back() -> Image.Image:
    back = Image.open(os.path.join(SRC, 'Back.png')).convert('RGBA')
    hsv = back.convert('HSV'); h, s, v = hsv.split()
    h = ((np.array(h, dtype=np.int16) + 170) % 256).astype('uint8')
    hue = Image.merge('HSV', (Image.fromarray(h), s, v)).convert('RGBA')
    navy = Image.new('RGBA', hue.size, (27, 41, 80, 255))
    rgb = Image.blend(hue.convert('RGB'), navy.convert('RGB'), 0.38)
    out = rgb.convert('RGBA'); out.putalpha(hue.split()[3])
    return out

def emit(im: Image.Image, path: str, portrait: bool) -> dict:
    im = im.resize((180, 240) if portrait else (240, 180), Image.LANCZOS)
    q = im.quantize(colors=64, method=Image.FASTOCTREE, dither=Image.NONE)
    q.save(path, optimize=True)
    buf = open(path, 'rb').read()
    return {'file': path, 'sha256': hashlib.sha256(buf).hexdigest(),
            'width': q.width, 'height': q.height}

def main() -> None:
    files = []
    faces = {f'{suit}-{r}': composed(f'{name}{r}') for name, suit in SUITS.items() for r in range(1, 10)}
    back = navy_back()
    for d, angle in DIRS.items():
        out_dir = os.path.join(OUT, d)
        os.makedirs(out_dir, exist_ok=True)
        for f in os.listdir(out_dir):
            if f.endswith('.png'):
                os.remove(os.path.join(out_dir, f))
        portrait = d in ('my', 'top')
        for key, im in faces.items():
            files.append(emit(im.rotate(angle, expand=True), os.path.join(out_dir, f'{key}.png'), portrait))
        files.append(emit(back.rotate(angle, expand=True), os.path.join(out_dir, 'back.png'), portrait))
    manifest = {
        'source': 'FluffyStuff/riichi-mahjong-tiles',
        'commit': '26e127ba2117f45cdce5ea0225748cc0cfad3169',
        'license': 'CC0-1.0',
        'files': [dict(e, file=os.path.relpath(e['file'], OUT)) for e in files],
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

if __name__ == '__main__':
    main()
```
- 运行：`python scripts/build-mahjong-tile-set.py`。
- 预期：四方向各 28 张；`manifest.json` 112 条；目录约 450–500KB。

### Step 1.4：主题 token
`apps/client/src/uni.scss` 追加 §5.4 的 15 个 `$ftl-color-mj-*` token。

### Step 1.5：文档
- `THIRD-PARTY-NOTICES.md`：删除旧 babykylin **牌面** bullet，替换为：
  - `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/*.png` 由
    FluffyStuff/riichi-mahjong-tiles（CC0 1.0，commit `26e127ba…`）合成/旋转/缩放/改色/量化生成；
    脚本 `scripts/build-mahjong-tile-set.py`；源图 vendored 在 `scripts/assets/mahjong/fluffystuff/`。
  - 保留音频 bullet（仍来自 babykylin，条款待核实）。
- `scripts/extract-mahjong-tiles.mjs` 文件头加：
  `/** @deprecated 2026-11-02 起由 scripts/build-mahjong-tile-set.py 取代；保留仅作历史追溯。 */`
- `apps/client/src/static/ASSETS.md` 增加麻将目录行：源图约 1.2MB（vendored）、输出约
  450KB/112 张、预算 768KiB。

### Step 1.6：跑绿
- `pnpm -C apps/client test -- asset-budget mahjong-assets` → 绿。
- `pnpm -C apps/client test -- ui-tokens` → 绿（新 token 在 uni.scss，组件未改）。
- Commit：`feat(client): 麻将牌面换 FluffyStuff CC0 素材 + 64 色量化 + 素材预算闸`。

### 判别力
- 预算测试在旧素材上红、新素材上绿；素材测试在生成前红、生成后绿；方向抽检能抓到 left/right 对调。

---

## Task 2：布局 token 与几何

### Files
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/test/mahjong-layout.test.ts`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`（仅消费字段，无视觉改动）

### Step 2.1：先改测试（红）
`mahjong-layout.test.ts`：
1. `VIEWPORTS` 保留 7 档，追加 `{ name: '1343x1000', w: 1343, h: 1000 }`。
2. 手牌行宽常量 `1041.5398230088495` → `1130`。
3. `hand.rect.top = v.h - (12 + 104) * s`。
4. 中央井高（WORST：top 1 副露、self 1 副露）：
   `expect(l.centerZone.height).toBeCloseTo(v.h - (64 + 229.8 + 290.8) * l.s, 3)`。
5. 紧凑判据：`expect(l.centerCompact).toBe(l.centerCard.height < 144 * l.s)`；
   矩阵内断言 `false`；`centerZone.height >= 40`。
6. 比例：
   - hand/own/top = `3/4`；
   - left/right river = `49/37`；
   - topBacks = `3/4`；
   - leftBacks = `4/3`。
7. token 钉死：`handH=104`、`riverH=56`、`topBackH=47`、`sideBackH=34`、`sidePitch=26`、
   `sideRiverH=37`、`centerClaimH=45`、`centerTingH=27`。
8. 1334×750 中央卡：EMPTY → `340×170`；WORST → `340×153.4`（`toBeCloseTo(...,1)`）。
9. 新增：
   - `expect(l.hand.rect.left).toBeGreaterThan(l.selfChip.left + l.selfChip.width)`；
   - `expect(l.topBacks.tile.w * 14 + l.topBacks.gap * 13).toBeLessThanOrEqual(l.topBacks.rect.width + 0.01)`；
   - `const actionsRect = { left: l.actions.rightX - l.actions.maxWidth, top: l.actions.bottomY - l.actions.minHeight, width: l.actions.maxWidth, height: l.actions.minHeight };` 与 `l.ownRiver.rect` 无重叠；
   - `expect(l.actions.maxWidth).toBeLessThanOrEqual(l.actions.rightX - (l.ownRiver.rect.left + l.ownRiver.rect.width) - 8 * l.s + 0.01)`；
   - `expect(l.centerCard.height).toBeGreaterThanOrEqual(144 * l.s)`（非紧凑时）。
10. 跑 `pnpm -C apps/client test -- mahjong-layout` → **红**。

### Step 2.2：改布局
`mahjong-layout.ts`：
- `const TILE_RATIO = 3 / 4;`
- 新增 `const SIDE_TILE_RATIO = 4 / 3;`
- token：`handH: 104`、`riverH: 56`、`topBackH: 47`、`sideBackH: 34`、`sidePitch: 26`、
  `sideRiverH: 37`、`centerClaimH: 45`、`centerTingH: 27`。
- `sideBackW = T.sideBackH * SIDE_TILE_RATIO * s`。
- 中央卡：
```ts
const compactZone = centerZone.height < 156 * s;
const centerCardW = Math.max(0, Math.min((compactZone ? 260 : 340) * s, centerZone.width - 16 * s));
const centerCardH = Math.max(0, Math.min((compactZone ? 120 : 170) * s, centerZone.height - 12 * s));
const centerCompact = centerCardH < 144 * s;
```
- `actions.maxWidth = Math.max(120 * s, Math.min(T.actionsMaxW * s, rightX - (ownRiverLeft + riverW) - inner))`。
- 其余公式不动。

### Step 2.3：跑绿
- `pnpm -C apps/client test -- mahjong-layout mahjong-board` → 绿。
- `pnpm -C apps/client run lint` → 绿。
- Commit：`feat(mahjong): 牌桌比例/中央卡/动作区布局重算（3:4 牌面）`。

### 判别力
- 旧 token 下新断言必红；新 token 下绿；7+1 矩阵覆盖 21:9/方屏/4:3。

---

## Task 3：牌面/牌背/牌河/副露视觉

### Files
- `apps/client/src/components/table/mahjong/MahjongTile.vue`
- `MahjongHandBacks.vue`
- `MahjongRiver.vue`
- `MahjongMeld.vue`
- `apps/client/test/mahjong-tile-meld.test.ts`
- `apps/client/test/mahjong-river.test.ts`
- `apps/client/test/mahjong-hand-backs.test.ts`

### Step 3.1：先改测试（红）
- `mahjong-tile-meld.test.ts` 新增：
  - `src` 映射：`direction='left'` + `wan1` → `/pages/table/static/mahjong/left/wan-1.png`；
    `back` → `/back.png`。
  - `MahjongTile` 不再接受/渲染 `rotate`：`mount(...,{props:{tile:wan1, rotate:'left'}} as any)`
    的根 class 不含 `mj-tile--rotate`（或源码闸覆盖）。
  - `MahjongMeld` 根 class 含 `mj-meld--tray`（新底托类）。
- `mahjong-river.test.ts`：最新牌 class `.mj-river__tile--latest` 仍存在；可响应描边 class
  `.mj-river__tile--filtered` 仍存在；副露标签 class 仍存在。
- `mahjong-hand-backs.test.ts`：背牌 class `mj-tile--back` 仍存在；侧家 13 张渲染。
- 跑 `pnpm -C apps/client test -- mahjong-tile-meld mahjong-river mahjong-hand-backs` → **红**
  （新类/映射未实现）。

### Step 3.2：改组件
- `MahjongTile.vue` CSS：
  - size 档位：`my/top` 34×45 / 46×61 / 60×80；`left/right` 45×34 / 61×46 / 80×60。
  - `border-radius: 12%`；`filter: drop-shadow(0 2px 3px rgba(10,25,50,.35))`。
  - 选中态 `box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-gold`。
- `MahjongHandBacks.vue`：背牌加 `inset 0 $ftl-hairline 0 rgba(255,255,255,.18)` 亮边。
- `MahjongRiver.vue`：最新牌金色外环 + `translateY(-2px)`；可响应描边改
  `$ftl-color-mj-cyan`；副露标签海军蓝底 + 金边。
- `MahjongMeld.vue`：根类加 `mj-meld--tray`；CSS 底托 `rgba(27,41,80,.35)` + 圆角。

### Step 3.3：跑绿
- 定向测试绿；`pnpm -C apps/client run lint` 绿。
- Commit：`feat(mahjong): 牌面/牌背/牌河/副露天月风视觉`。

---

## Task 4：中央圆盘重做

### Files
- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`（`centerProps` 加 `ended`）
- `apps/client/test/mahjong-center.test.ts`
- `apps/client/test/mahjong-board.test.ts`（中心文案锚点）

### Step 4.1：重写测试（红）
`mahjong-center.test.ts` 全量改写：
```ts
const base = { wallCount: 42, phaseText: '请出牌', seconds: 12, active: true,
  claimW: 34, claimH: 45, tingW: 20, tingH: 27 };

it('active + seconds>0：圆盘显示秒数', () => {
  const w = mount(Center, { props: base });
  expect(w.find('.mj-center__value').text()).toContain('12');
  expect(w.text()).toContain('牌墙 42');
  expect(w.text()).toContain('请出牌');
});

it('active=false：圆盘显示牌墙数，不显示 12', () => {
  const w = mount(Center, { props: { ...base, active: false } });
  expect(w.find('.mj-center__value').text()).toContain('42');
  expect(w.find('.mj-center__value').text()).not.toContain('12');
});

it('active + seconds=0：显示牌墙数，无 urgent', () => {
  const w = mount(Center, { props: { ...base, seconds: 0 } });
  expect(w.find('.mj-center__value').text()).toContain('42');
  expect(w.find('.mj-center__dial').classes()).not.toContain('mj-center__dial--urgent');
});

it('active + seconds=5：urgent + anim-urgent-pulse', () => {
  const w = mount(Center, { props: { ...base, seconds: 5 } });
  expect(w.find('.mj-center__dial').classes()).toContain('mj-center__dial--urgent');
  expect(w.find('.mj-center__dial').classes()).toContain('anim-urgent-pulse');
});

it('ended：圆盘显示终，endedText 仍是次要行', () => {
  const w = mount(Center, { props: { ...base, ended: true, endedText: '已胡 2 家' } });
  expect(w.find('.mj-center__value').text()).toContain('终');
  expect(w.text()).toContain('已胡 2 家');
});

it('未结束的 endedText 不抢圆盘', () => {
  const w = mount(Center, { props: { ...base, endedText: '已胡 1 家' } });
  expect(w.find('.mj-center__value').text()).toContain('12');
  expect(w.text()).toContain('已胡 1 家');
});

it('claim + ting + maxFan', () => {
  const w = mount(Center, { props: { ...base, claimTile: { s: 0, r: 5 },
    tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }], maxFan: 5 } });
  expect(w.findAll('image')).toHaveLength(3);
  expect(w.text()).toContain('可响应');
  expect(w.text()).toContain('5 番');
  expect(w.findAll('.mj-tile')[0]!.attributes('style')).toContain('width: 34px');
  expect(w.findAll('.mj-tile')[1]!.attributes('style')).toContain('width: 20px');
});

it('紧凑：单行、无牌面', () => {
  const w = mount(Center, { props: { ...base, compact: true, claimTile: { s: 0, r: 5 } } });
  expect(w.classes()).toContain('mj-center--compact');
  expect(w.findAll('image')).toHaveLength(0);
  expect(w.text()).toContain('可响应');
});
```
- 跑 `pnpm -C apps/client test -- mahjong-center` → **红**。

### Step 4.2：实现
- `MahjongCenter.vue` 重写模板：
  - `.mj-center__strip`：`牌墙 {{ wallCount }}` + `{{ phaseText }}`。
  - `.mj-center__body`：`.mj-center__dial`（110）+ `.mj-center__side`（210）。
  - `.mj-center__dial`：环 + `.mj-center__value` + `.mj-center__unit`；`--urgent` +
    `anim-urgent-pulse`。
  - `.mj-center__side`：claim（34×45）、ting（20×27，最多两行，`+N`）、`endedText`。
- props 增加 `ended?: boolean`（默认 false）。
- `dialValue` / `dialUnit` / `urgent` 计算见 spec 5.3。
- CSS 用 `$ftl-color-mj-*`；圆盘 `border-radius: 50%`；海军蓝玻璃 + 双金边；12 刻度用
  `repeating-conic-gradient`（不要 1px）。
- 紧凑：圆盘 90，单行文字；隐藏牌面。
- `MahjongBoard.vue` 的 `centerProps` 增加 `ended: phase.value === 'ended'`。
- `mahjong-board.test.ts` 的 `.mj-center__phase` 保留（新模板保留该类名）。

### Step 4.3：跑绿
- `pnpm -C apps/client test -- mahjong-center mahjong-board` 绿；lint 绿。
- Commit：`feat(mahjong): 中央蓝金圆盘（倒计时/牌墙/阶段/响应/听牌）`。

---

## Task 5：座位卡 + ClaimTile + HuBanner

### Files
- `MahjongSeatChip.vue`
- `ClaimTile.vue`
- `MahjongHuBanner.vue`
- `apps/client/test/mahjong-seat-chip.test.ts`
- New `apps/client/test/mahjong-claim-tile.test.ts`（若 ClaimTile 无独立测试）

### Step 5.1：先改测试（红）
- SeatChip：保留 `.mj-chip__avatar-box` 尺寸断言；新增 `.mj-chip__avatar` 的圆角/金边类
  `mj-chip__avatar--gold`；self 余额有 `mj-chip__self-pill`；角标仍在 `.mj-chip__avatar-box` 内。
- ClaimTile：主按钮 `.mj-claim-tile__opt--hu`、次按钮、过按钮类；点击 emit 不变；文本不变。
- HuBanner：根类含 `mj-hu-banner--navy`；文本「自摸/胡牌」「N 番」不变。
- 跑定向测试 → **红**。

### Step 5.2：实现
- SeatChip：
  - `.mj-chip__avatar` 加 `mj-chip__avatar--gold` 类；CSS `border: $ftl-hairline solid $ftl-color-mj-gold`、
    `box-shadow: 0 0 $ftl-space-2 rgba(...)`；`border-radius: $ftl-radius-pill` 保留。
  - `.mj-chip--side` 加海军蓝玻璃底 + 金边 + 圆角；名字白、meta `$ftl-color-mj-muted`。
  - `.mj-chip__self-info` 加 `mj-chip__self-pill` 类：海军蓝底 + 金边 + 圆角 + padding。
  - badges 用海军蓝/金色系。
- ClaimTile：弹层海军蓝玻璃 + 金边；次按钮海军蓝；主按钮金底 + 海军蓝文字。
- HuBanner：根类 `mj-hu-banner--navy`；海军蓝底 + 金边 + 金字。

### Step 5.3：跑绿
- 定向测试绿；lint 绿。
- Commit：`feat(mahjong): 座位卡圆形金框/ClaimTile/HuBanner 天月风`。

---

## Task 6：牌桌背景 + 顶栏 + 按钮 + 主题源码闸

### Files
- `MahjongBoard.vue`
- New `apps/client/test/mahjong-theme.test.ts`
- `apps/client/test/mahjong-board.test.ts`

### Step 6.1：先写主题闸（红）
`mahjong-theme.test.ts`（用 `collectSourceFiles` / `SRC_ROOT`）：
- `MahjongBoard.vue` 样式含 `$ftl-color-mj-table-light` / `-mid` / `-deep` / `$ftl-color-mj-navy`。
- 不含 `$ftl-color-mahjong-table`、`rgba(20, 50, 30`、`rgba(0, 25, 12`。
- `MahjongTile.vue` / `MahjongMeld.vue` 不含 `rotate` / `vertical` 死 prop 文本。
- `uni.scss` 含全部 `$ftl-color-mj-*` token。
- 跑 → **红**（Board 仍是旧背景）。

### Step 6.2：实现 Board 视觉
- `.mj` 替换背景为 spec 5.3 的三层（最上层写最前）。
- 删除旧 `border` 和全部旧绿色 `box-shadow`。
- 加 `.mj::before` 木框（border-image + token；`pointer-events:none`）。
- 顶栏：海军蓝玻璃 + 金 hairline；文字白。
- `.btn` / `.btn--small` / `.btn--primary`：海军蓝/金；主按钮金底 + 海军蓝文字。
- 托管遮罩、长按提示弹层：海军蓝玻璃 + 金边。
- `mj__lack--recommend`：金底 + 海军蓝文字。
- 不写 `1px`；不写裸 hex。

### Step 6.3：跑绿
- `pnpm -C apps/client test -- mahjong-theme mahjong-board ui-tokens` 绿；lint 绿。
- Commit：`feat(mahjong): 亮青桌面/木框/蓝金顶栏与按钮`。

---

## Task 7：全量验证 + 文档 + 交付

### Steps
1. `pnpm -C apps/client test` → 全绿。
2. `pnpm -C apps/client run lint` → 0 错。
3. 素材预算：`pnpm -C apps/client test -- asset-budget` → 绿。
4. 真浏览器：
   - 启动 H5 dev server；用 CDP/截图脚本在 1334×750、1334×1000、1623×750、1778×750 各截一张。
   - 若 Docker 栈不可用：用 `.superpowers/mahjong-layout-research/mockup.html` 更新为新主题做
     静态视觉对照，并在交付报告里明确「真栈截图待补」。
   - 检查项见 spec 6.6。
5. 更新 spec 状态、`docs/superpowers/plans/*-handoff.md`（如有）。
6. 最终 commit；`git status` 干净。
7. 推 `dev`（零 CI）。不合并 master、不打 tag、不部署（用户未要求）。
8. 交付报告：变更、测试证据、提交 SHA、未闭合项。

### 验证矩阵
| 改动面 | 命令 | 预期 |
|---|---|---|
| 客户端 | `pnpm -C apps/client test` | 全绿 |
| 类型 | `pnpm -C apps/client run lint` | 0 错 |
| 素材 | `pnpm -C apps/client test -- asset-budget mahjong-assets` | 绿 |
| token | `pnpm -C apps/client test -- ui-tokens` | 绿 |
| 主题 | `pnpm -C apps/client test -- mahjong-theme` | 绿 |
| 视觉 | 真浏览器截图 | 对照 spec 6.6 |

## 风险与回滚

- 全部改动在客户端；回滚 `git revert <task commits>` 即可。
- 素材整批替换：回滚需同时恢复旧 PNG（commit 历史保留）。
- 基线修复（Task 0）独立提交，便于单独回滚。
- 若真浏览器验证不可用，交付报告必须写明，不把「单测绿」当视觉验收。
