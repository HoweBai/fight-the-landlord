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
  重复的半透明底色抽成 `$ftl-color-mj-glass*` token；组件里允许 `rgba($ftl-color-mj-navy, .x)`。
- **素材**：FluffyStuff CC0（pin `26e127ba2117f45cdce5ea0225748cc0cfad3169`）；生成结果入库；
  Pillow/numpy 仅开发期，依赖写入 `scripts/assets/mahjong/requirements.txt`。
- **提交**：每任务一个 commit，信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **只 add 本任务文件**：不 `git add -A`；起始工作区已有 6 个 `*z.png` 删除，统一留到 Task 1 提交。
- **验证命令**：
  - `pnpm -C apps/client test`
  - `pnpm -C apps/client run lint`
  - 定向：`pnpm -C apps/client test -- mahjong` / `asset-budget` / `ui-tokens`
- **不夹带**：不重构无关页面；不改旧 `$ftl-color-mahjong-table*` token 定义（只停止引用）。

---

## Task 0：基线转绿（prep）

### Files（只 add 这三个）
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
  - `mahjong-board.test.ts:219` 找 `.mj__phase`（模板里是 `.mj-center__phase`），且在
    `activeSeats=[1,2]` 时 `.mj__actions` 不渲染（`hasActions=false`），`.text()` 会抛错。

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
   - 第一个失败用例整段替换：
     - `expect(wrapper.find('.mj__hand').exists()).toBe(true)`；
     - `expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(revealedTiles.length)`；
     - `expect(wrapper.findAll('.mj__hand .anim-deal-in')).toHaveLength(0)`。
   - 第二个失败用例整段替换：
     - `expect(wrapper.find('.mj-center__phase').text()).toContain('等待其他玩家响应')`；
     - `expect(wrapper.find('.mj__actions').exists()).toBe(false)`（该窗口自己不在 active，
       动作栏本来就不渲染；不要对空 wrapper 调 `.text()`）。
4. 跑：
   - `pnpm -C apps/client run lint` → 0 错误。
   - `pnpm -C apps/client test -- mahjong` → 全绿。
5. Commit（只 add 上述 3 个文件）：`fix(client): 麻将基线修复（删死 prop、修陈旧断言）`。

---

## Task 1：素材管线 + 主题 token + 预算闸

### Files
- New `scripts/assets/mahjong/fluffystuff/`（29 张 PNG + `LICENSE.md`）
- New `scripts/assets/mahjong/requirements.txt`
- New `scripts/build-mahjong-tile-set.py`
- Replace `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/*.png`
- New `apps/client/src/pages/table/static/mahjong/manifest.json`
- `apps/client/src/uni.scss`
- `THIRD-PARTY-NOTICES.md`
- `apps/client/src/static/ASSETS.md`
- `scripts/extract-mahjong-tiles.mjs`（顶部退出）
- `apps/client/test/asset-budget.test.ts`
- New `apps/client/test/mahjong-assets.test.ts`

### Step 1.1：先写失败测试
`asset-budget.test.ts`：
- `BUDGET_KIB` 增加 `'table/mahjong': 768`。
- `BUDGET_DIRS` 增加 `'table/mahjong': join(TABLE_STATIC, 'mahjong')`。
- 自证 `toHaveLength(6)` 改 `7`。
- 增加 `expect(dirSizeKiB(join(TABLE_STATIC,'mahjong'))).toBeGreaterThan(300)`。
- 跑 `pnpm -C apps/client test -- asset-budget` → **红**（当前实测约 836KiB > 768）。

新建 `mahjong-assets.test.ts`：
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
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function redCentroid(path: string) {
  const img = await loadImage(readFileSync(path));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
    if (a > 128 && r > 120 && r > g * 1.5 && r > b * 1.5) { sx += x; sy += y; n += 1; }
  }
  return { x: sx / n / width, y: sy / n / height, n };
}

describe('麻将素材完整性', () => {
  it('四方向恰好 27 面 + back', () => {
    for (const dir of DIRS) {
      const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.png')).sort();
      const expected = [...SUITS.flatMap((s) => Array.from({ length: 9 }, (_, i) => `${s}-${i + 1}.png`)), 'back.png'].sort();
      expect(files).toEqual(expected);
    }
  });

  it('manifest 哈希/尺寸/方向一致', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(manifest.source).toContain('FluffyStuff/riichi-mahjong-tiles');
    expect(manifest.license).toBe('CC0-1.0');
    expect(manifest.commit).toBe('26e127ba2117f45cdce5ea0225748cc0cfad3169');
    expect(manifest.files).toHaveLength(112);
    for (const e of manifest.files) {
      const file = String(e.file).replace(/\\/g, '/');
      expect(file.startsWith(`${e.direction}/`)).toBe(true);
      expect(sha(readFileSync(join(ROOT, file)))).toBe(e.sha256);
      const portrait = e.direction === 'my' || e.direction === 'top';
      expect(e.width).toBe(portrait ? 180 : 240);
      expect(e.height).toBe(portrait ? 240 : 180);
    }
  });

  it('同方向 27 面互不相同', () => {
    for (const dir of DIRS) {
      const hashes = SUITS.flatMap((s) => Array.from({ length: 9 }, (_, i) =>
        sha(readFileSync(join(ROOT, dir, `${s}-${i + 1}.png`)))));
      expect(new Set(hashes).size).toBe(27);
    }
  });

  it('方向抽检：1 万/9 条红字重心', async () => {
    for (const name of ['wan-1', 'tiao-9']) {
      const my = await redCentroid(join(ROOT, 'my', `${name}.png`));
      const left = await redCentroid(join(ROOT, 'left', `${name}.png`));
      const right = await redCentroid(join(ROOT, 'right', `${name}.png`));
      expect(my.y).toBeGreaterThan(0.55);
      expect(left.x).toBeLessThan(0.45);
      expect(right.x).toBeGreaterThan(0.55);
    }
  });

  it('back.png 四角保留透明', async () => {
    const img = await loadImage(readFileSync(join(ROOT, 'my', 'back.png')));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width } = ctx.getImageData(0, 0, img.width, img.height);
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, img.height - 1], [width - 1, img.height - 1]]) {
      expect(data[(y * width + x) * 4 + 3]).toBe(0);
    }
  });
});
```
- 跑 `pnpm -C apps/client test -- mahjong-assets` → **红**（文件缺失）。
- 说明：`tiao-9` 的 9 条是否含红色？Fluffy 的 Sou9 含红色竹节；实测源图 `Sou9` 有红点。
  若抽检失败，改用 `wan-9`（红萬）作为第二张。

### Step 1.2：vendor 源图 + 依赖
```bash
cat > scripts/assets/mahjong/requirements.txt <<'TXT'
Pillow>=10
numpy>=1.26
TXT
python -m pip install -r scripts/assets/mahjong/requirements.txt
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
- 校验：每张 600×800；`LICENSE.md` 含 CC0；总大小约 1.6MB。

### Step 1.3：生成脚本
`scripts/build-mahjong-tile-set.py`：
```python
#!/usr/bin/env python3
"""从 FluffyStuff CC0 源图生成四方向麻将牌面（180x240 / 240x180，64 色量化）。"""
from PIL import Image
import numpy as np, hashlib, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scripts/assets/mahjong/fluffystuff')
OUT = os.path.join(ROOT, 'apps/client/src/pages/table/static/mahjong')
SUITS = {'Man': 'wan', 'Pin': 'tong', 'Sou': 'tiao'}
ANGLES = {'my': 0, 'top': 180, 'left': -90, 'right': 90}  # PIL 正角度=逆时针

def composed(stem: str) -> Image.Image:
    front = Image.open(os.path.join(SRC, 'Front.png')).convert('RGBA')
    glyph = Image.open(os.path.join(SRC, f'{stem}.png')).convert('RGBA')
    return Image.alpha_composite(front, glyph)

def navy_back() -> Image.Image:
    back = Image.open(os.path.join(SRC, 'Back.png')).convert('RGBA')
    hsv = back.convert('HSV'); h, s, v = hsv.split()
    h = ((np.array(h, dtype=np.int16) + 170) % 256).astype('uint8')
    hue = Image.merge('HSV', (Image.fromarray(h), s, v)).convert('RGBA')
    navy = Image.new('RGBA', hue.size, (27, 41, 80, 255))
    rgb = Image.blend(hue.convert('RGB'), navy.convert('RGB'), 0.38)
    out = rgb.convert('RGBA')
    out.putalpha(back.split()[3])  # 保留源牌背的透明圆角
    return out

def emit(im: Image.Image, direction: str, name: str) -> dict:
    portrait = direction in ('my', 'top')
    im = im.resize((180, 240) if portrait else (240, 180), Image.LANCZOS)
    q = im.quantize(colors=64, method=Image.FASTOCTREE, dither=Image.NONE)
    path = os.path.join(OUT, direction, f'{name}.png')
    q.save(path, optimize=True)
    buf = open(path, 'rb').read()
    return {'file': f'{direction}/{name}.png', 'direction': direction,
            'sha256': hashlib.sha256(buf).hexdigest(),
            'width': q.width, 'height': q.height}

def main() -> None:
    faces = {f'{suit}-{r}': composed(f'{src}{r}') for src, suit in SUITS.items() for r in range(1, 10)}
    back = navy_back()
    files = []
    for direction, angle in ANGLES.items():
        out_dir = os.path.join(OUT, direction)
        os.makedirs(out_dir, exist_ok=True)
        for f in os.listdir(out_dir):
            if f.endswith('.png'):
                os.remove(os.path.join(out_dir, f))
        for name, im in faces.items():
            files.append(emit(im.rotate(angle, expand=True), direction, name))
        files.append(emit(back.rotate(angle, expand=True), direction, 'back'))
    manifest = {'source': 'FluffyStuff/riichi-mahjong-tiles',
                'commit': '26e127ba2117f45cdce5ea0225748cc0cfad3169',
                'license': 'CC0-1.0', 'files': files}
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2); fh.write('\n')

if __name__ == '__main__':
    main()
```
- 运行：`python scripts/build-mahjong-tile-set.py`。
- 预期：四方向各 28 张；manifest 112 条；目录约 585KiB（实测）。
- 注意：`file` 已是正斜杠相对路径，测试端仍做 `replace(/\\/g,'/')` 兜底。
- 6 张旧 `left/*z.png` 的删除随本任务提交。

### Step 1.4：主题 token
`apps/client/src/uni.scss` 追加 §5.4 的 `$ftl-color-mj-*` token，并追加：
```scss
$ftl-color-mj-glass-soft: rgba(27, 41, 80, 0.35);
$ftl-color-mj-shadow: rgba(10, 25, 50, 0.35);
$ftl-color-mj-highlight: rgba(255, 255, 255, 0.28);
```

### Step 1.5：文档
- `THIRD-PARTY-NOTICES.md`：删除旧 babykylin **牌面** bullet，替换为 FluffyStuff CC0
  （commit、脚本、vendored 路径）；保留音频 bullet 与“条款待核实”。
- `scripts/extract-mahjong-tiles.mjs` 顶部加：
  ```js
  console.error('已退役：2026-11-02 起由 scripts/build-mahjong-tile-set.py 取代；拒绝运行以免覆盖新素材。');
  process.exit(1);
  ```
- `ASSETS.md` 增加：源图约 1.6MB（vendored）、输出约 585KiB/112 张 + manifest、预算 768KiB。

### Step 1.6：跑绿
- `pnpm -C apps/client test -- asset-budget mahjong-assets` → 绿。
- `pnpm -C apps/client test -- ui-tokens` → 绿。
- Commit：`feat(client): 麻将牌面换 FluffyStuff CC0 素材 + 64 色量化 + 素材预算闸`。

---

## Task 2：布局 token 与几何

### Files
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/test/mahjong-layout.test.ts`
- `apps/client/src/components/table/mahjong/MahjongBoard.vue`（仅消费字段）

### Step 2.1：先改测试（红）
1. `VIEWPORTS` 保留 7 档，追加 `{ name: '1343x1000', w: 1343, h: 1000 }`。
2. `expectedS` 的手牌行宽常量 `1041.5398230088495` → `1130`。
3. **整段替换** 1334×750 精确值块（`:219-297`）为下表（全部 `toBeCloseTo(…, 3)`）：

| 字段 | EMPTY |
|---|---|
| s | 1 |
| topZone | left 404, top 64, width 526, height 177 |
| topBacks.rect | top 72, height 47 |
| topRiver.rect | top 127, height 114 |
| centerZone | left 224.3333, top 241, width 885.3333, height 271 |
| centerCompact | false |
| centerCard | left 497, top 291.5, width 340, height 170 |
| hand.rect | left 102, top 634, width 1130, height 104 |
| hand.tile | 78×104 |
| ownRiver.rect | left 404, top 512, width 526, height 114 |
| leftZone | left 0, top 122, width 216.3333, height 462 |
| leftChip | 12,122,180,56 |
| leftBacks.rect | 12,186,45.3333,398 |
| leftBacks.tile | 45.3333×34 |
| leftBacks.pitch | 26 |
| leftRiver.rect | 65.3333,186,151,310 |
| rightZone.left | 1117.6667 |
| rightChip.left | 1142 |
| rightBacks.rect.left | 1276.6667 |
| rightRiver.rect.left | 1117.6667 |
| selfChip | 12,648,56,76 |
| actions | rightX 1109.6667, bottomY 626, rightOffset 224.3333, bottomOffset 124, maxWidth 171.6667, minHeight 80 |
| centerTiles | claim 34×45, ting 20×27 |

4. **整段替换** 全副露块（`:299-328`）为：

| 字段 | WORST |
|---|---|
| topZone.height | 229.8 |
| topRiver.rect.top | 179.8 |
| ownRiver.rect.top | 459.2 |
| centerZone.top | 293.8 |
| centerZone.height | 165.4 |
| centerCompact | false |
| centerCard | left 497, top 299.8, width 340, height 153.4 |
| leftZone | top 107.9, height 490.2 |
| leftRiver.rect.top | 171.9 |
| leftRiver.meld.height | 108.2 |
| leftRiver.meld.groupGap | 4 |
| topRiver.meld.groupGap | 8 |
| leftRiver.meld.rect.top | 489.9 |
| leftRiver.meld.rect.height | 108.2 |
| topRiver.meld.height | 44.8 |
| topRiver.meld.rect.top | 127 |
| ownRiver.meld.rect.top | 581.2 |
| actions.maxWidth | 171.6667 |

5. 矩阵内的公式断言改为独立期望表（至少 3 档，防实现/测试同错）：

| 视口 | s | hand left/width/height | centerEmpty: zoneH/cardW/cardH | centerWorst: zoneH/cardW/cardH | actions.maxWidth | leftZone.width | hand.left-selfChip.right |
|---|---|---|---|---|---|---|---|
| 1334×750 | 1 | 102/1130/104 | 271/340/170 | 165.4/340/153.4 | 171.667 | 216.333 | 34 |
| 1334×1000 | 1.038867 | 80.04/1173.92/108.042 | 502.383/353.215/176.607 | 392.678/353.215/176.607 | 152.414 | 224.742 | 9.397 |
| 1623×750 | 1 | 246.5/1130/104 | 271/340/170 | 165.4/340/153.4 | 316.167 | 216.333 | 178.5 |
| 1343×1000 | 1.045876 | 80.58/1181.84/108.771 | 499.025/355.598/177.799 | 388.581/355.598/177.799 | 153.443 | 226.258 | 9.46 |

6. 保留/更新：
   - `centerCompact === (centerCard.height < 148*s)`；矩阵内断言 false。
   - 比例：hand/own/top = `3/4`；left/right river = `49/37`；topBacks = `3/4`；leftBacks = `4/3`。
   - token 钉死：`handH=104`、`riverH=56`、`topBackH=47`、`sideBackH=34`、`sidePitch=26`、
     `sideRiverH=37`、`centerClaimH=45`、`centerTingH=27`。
   - 顶牌背 14 张：`topBacks.tile.w*14 + gap*13 ≤ topBacks.rect.width`（1334×750: 519.5≤526；
     4:3: 539.692≤546.444）。
   - `hand.rect.left > selfChip.left + selfChip.width`。
   - `actions.maxWidth ≤ rightX - ownRiver.right - 8*s + 0.01`；构造 actionsRect 与 ownRiver 无重叠。
   - `centerCard.height ≥ 148*s`（非紧凑）。
7. 跑 `pnpm -C apps/client test -- mahjong-layout` → **红**。

### Step 2.2：改布局
`mahjong-layout.ts`：
- `const TILE_RATIO = 3 / 4;`；新增 `const SIDE_TILE_RATIO = 4 / 3;`
- token：`handH: 104`、`riverH: 56`、`topBackH: 47`、`sideBackH: 34`、`sidePitch: 26`、
  `sideRiverH: 37`、`centerClaimH: 45`、`centerTingH: 27`。
- `sideBackW = T.sideBackH * SIDE_TILE_RATIO * s`。
- 中央卡（在 `centerZone` 之后）：
```ts
const compactZone = centerZone.height < 160 * s;
const centerCardW = Math.max(0, Math.min((compactZone ? 260 : 340) * s, centerZone.width - 16 * s));
const centerCardH = Math.max(0, Math.min((compactZone ? 120 : 170) * s, centerZone.height - 12 * s));
const centerCompact = centerCardH < 148 * s;
```
- `actions.maxWidth = Math.max(120 * s, Math.min(T.actionsMaxW * s, rightX - (ownRiverLeft + riverW) - inner))`。
- 其余公式不动。

### Step 2.3：跑绿
- `pnpm -C apps/client test -- mahjong-layout mahjong-board` → 绿。
- `pnpm -C apps/client run lint` → 绿。
- Commit：`feat(mahjong): 牌桌比例/中央卡/动作区布局重算（3:4 牌面）`。

---

## Task 3：牌面/牌背/牌河/副露视觉

### Files
- `MahjongTile.vue` / `MahjongHandBacks.vue` / `MahjongRiver.vue` / `MahjongMeld.vue`
- `apps/client/test/mahjong-tile-meld.test.ts`
- `apps/client/test/mahjong-river.test.ts`
- `apps/client/test/mahjong-hand-backs.test.ts`

### Step 3.1：先改测试（红）
- `mahjong-tile-meld.test.ts`：
  - `src` 映射：`direction='left'` + `wan1` → `/pages/table/static/mahjong/left/wan-1.png`；
    `back` → `/back.png`。
  - `direction + size` 尺寸：`top/sm` → style `width:34px;height:45px`；`left/sm` → `45px×34px`。
  - `MahjongMeld` 根 class 含 `mj-meld--tray`。
- `mahjong-river.test.ts`：
  - 最新牌 `.mj-river__tile--latest` 存在；可响应 `.mj-river__tile--filtered` 存在。
  - 源码闸：River 的 `<style>` 含 `$ftl-color-mj-gold` 与 `$ftl-color-mj-cyan`，不含旧绿色。
- `mahjong-hand-backs.test.ts`：背牌 `mj-tile--back` 仍存在；侧家 13 张渲染。
- 跑定向测试 → **红**（新尺寸/类/源码闸未实现）。

### Step 3.2：改组件
- `MahjongTile.vue`：
  - 基础档位：`sm 34×45`、`md 46×61`、`lg 60×80`。
  - **删除/同步** `.mj-tile--dir-top`、`.mj-tile--dir-left/right` 旧尺寸覆盖（新素材同比例，
    不再需要方向特例）；方向仅影响素材目录。
  - `border-radius: 12%`；`filter: drop-shadow(0 $ftl-space-1 $ftl-space-2 $ftl-color-mj-shadow)`。
  - 选中态 `box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-gold`。
- `MahjongHandBacks.vue`：背牌 `box-shadow: inset 0 $ftl-hairline 0 $ftl-color-mj-highlight`。
- `MahjongRiver.vue`：
  - 最新牌 `box-shadow: 0 0 $ftl-space-2 $ftl-color-mj-gold` + `transform: translateY(-$ftl-space-1)`。
  - 可响应 `outline: $ftl-hairline solid $ftl-color-mj-cyan`。
  - 副露标签背景 `rgba($ftl-color-mj-navy, .8)` + `$ftl-hairline solid $ftl-color-mj-gold`。
- `MahjongMeld.vue`：根类加 `mj-meld--tray`；CSS `background: $ftl-color-mj-glass-soft;
  border-radius: $ftl-radius-md; padding: $ftl-space-1`。

### Step 3.3：跑绿
- 定向测试绿；lint 绿。
- Commit：`feat(mahjong): 牌面/牌背/牌河/副露天月风视觉`。

---

## Task 4：中央圆盘重做

### Files
- `MahjongCenter.vue`
- `MahjongBoard.vue`（`centerProps` 加 `ended`）
- `apps/client/test/mahjong-center.test.ts`
- `apps/client/test/mahjong-board.test.ts`

### Step 4.1：重写测试（红）
`mahjong-center.test.ts`：
```ts
const base = { wallCount: 42, phaseText: '请出牌', seconds: 12, active: true,
  claimW: 34, claimH: 45, tingW: 20, tingH: 27 };

it('active + seconds>0：圆盘显示秒数', ...);        // value 12；text 牌墙 42/请出牌
it('active=false：圆盘显示牌墙数', ...);           // value 42；不含 12
it('active + seconds=0：显示牌墙数，无 urgent', ...);
it('active + seconds=6：非 urgent', ...);
it('active + seconds=5：urgent + anim-urgent-pulse', ...);
it('ended：圆盘显示终，endedText 次要行', ...);
it('未结束的 endedText 不抢圆盘', ...);            // value 12；text 已胡 1 家
it('claim + ting + maxFan', ...);                  // 3 张 image；34px/20px
it('13 张听牌：最多两行、12 张 + “+1”', ...);      // .mj-tile ≤12；text +1
it('紧凑：单行、无牌面', ...);
it('默认尺寸 claimH=45/tingH=27', ...);            // 不传 claimH/tingH
it('源码闸：@import animations + compact 11px', ...);
```
- 跑 `pnpm -C apps/client test -- mahjong-center` → **红**。

### Step 4.2：实现
- `<style scoped lang="scss">` 顶部加 `@import '../../../styles/animations.scss';`（否则
  `anim-urgent-pulse` 在浏览器不生效）。
- 模板：
  - `.mj-center__strip`：`牌墙 {{ wallCount }}` + `{{ phaseText }}`。
  - `.mj-center__body`：`.mj-center__dial`（110）+ `.mj-center__side`（210）。
  - `.mj-center__dial`：环 + `.mj-center__value` + `.mj-center__unit`；`--urgent` +
    `anim-urgent-pulse`。
  - `.mj-center__side`：claim（34×45）、ting（20×27，最多两行，`MAX_TING_TILES=12`，超出 `+N`）、
    `endedText`。
- props 增加 `ended?: boolean`（默认 false）；`claimH`/`tingH` 默认值改 45/27。
- `dialValue` / `dialUnit` / `urgent` 见 spec 5.3。
- CSS 用 `$ftl-color-mj-*`；圆盘 50%；海军蓝玻璃 + 双金边；12 刻度用
  `repeating-conic-gradient`（不要 1px）。
- 紧凑：圆盘 90，单行文字；隐藏牌面；保留 11px 字号源码闸。
- `MahjongBoard.vue` 的 `centerProps` 增加 `ended: phase.value === 'ended'`。

### Step 4.3：跑绿
- `pnpm -C apps/client test -- mahjong-center mahjong-board` 绿；lint 绿。
- Commit：`feat(mahjong): 中央蓝金圆盘（倒计时/牌墙/阶段/响应/听牌）`。

---

## Task 5：座位卡 + ClaimTile + HuBanner + 结算主按钮

### Files
- `MahjongSeatChip.vue` / `ClaimTile.vue` / `MahjongHuBanner.vue`
- `apps/client/src/components/MahjongSettlement.vue`（仅 `.btn--primary` 文字色）
- `apps/client/test/mahjong-seat-chip.test.ts`
- New `apps/client/test/mahjong-claim-tile.test.ts`

### Step 5.1：先改测试（红）
- SeatChip：保留 `.mj-chip__avatar-box` 尺寸断言；新增 `image.mj-chip__avatar--gold`；
  self 余额 `mj-chip__self-pill`；角标仍在 `.mj-chip__avatar-box` 内（不被裁切）。
  说明：现有 `<image>` 自身已 `border-radius: pill`，不需要 frame/clip 两层；spec 的
  “frame/clip” 按“外层不被裁切、image 自身圆形”实现，测试锁“角标存在且 image 有金边类”。
- ClaimTile：根类 `mj-claim-tile--navy`；主/次/过类；点击 emit；源码闸无旧绿色
  （`rgba(30, 60, 40` / `rgba(60, 110, 75` / `rgba(35, 75, 50`）。
- HuBanner：根类 `mj-hu-banner--navy`；源码闸无橙色（`rgba(255, 180, 60` / `rgba(220, 100, 30`）。
- 跑定向测试 → **红**。

### Step 5.2：实现
- SeatChip：
  - `.mj-chip__avatar` 加 `mj-chip__avatar--gold`；`border: $ftl-hairline solid $ftl-color-mj-gold`；
    `box-shadow: 0 0 $ftl-space-2 rgba($ftl-color-mj-gold, .35)`；保留 `border-radius: pill`。
  - `.mj-chip--side` 海军蓝玻璃底（`$ftl-color-mj-glass`）+ 金边 + 圆角。
  - `.mj-chip__self-info` 加 `mj-chip__self-pill`：`background: $ftl-color-mj-glass` +
    金边 + 圆角 + padding。
  - badges 用 `$ftl-color-mj-*`。
  - `.mj-chip__corner--hu`：金底 + 海军蓝文字（`$ftl-color-mj-on-gold`）。
- ClaimTile：根类 `mj-claim-tile--navy`；弹层/次按钮海军蓝；主按钮金底 + 海军蓝文字。
- HuBanner：根类 `mj-hu-banner--navy`；海军蓝底 + 金边 + 金字。
- MahjongSettlement：`.btn--primary { color: $ftl-color-mj-on-gold; }`（最小对比度修）。

### Step 5.3：跑绿
- 定向测试绿；lint 绿。
- Commit：`feat(mahjong): 座位卡/ClaimTile/HuBanner/结算主按钮天月风`。

---

## Task 6：牌桌背景 + 顶栏 + 按钮 + 裸文字对比度 + 主题源码闸

### Files
- `MahjongBoard.vue`
- New `apps/client/test/mahjong-theme.test.ts`
- `apps/client/test/mahjong-board.test.ts`

### Step 6.1：先写主题闸（红）
`mahjong-theme.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './helpers/source-scan';

const files = collectSourceFiles();
const vue = (p: string) => files.find((f) => f.path === `src/${p}`)!;
function style(content: string): string {
  return [...content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '))
    .join('\n');
}
const BOARD = 'components/table/mahjong/MahjongBoard.vue';

describe('麻将主题源码闸', () => {
  it('Board 用新 token，且旧绿色 token/字面量消失', () => {
    const s = style(vue(BOARD).content);
    for (const t of ['$ftl-color-mj-table-light', '$ftl-color-mj-table-mid', '$ftl-color-mj-table-deep', '$ftl-color-mj-navy']) {
      expect(s).toContain(t);
    }
    expect(s).not.toMatch(/\$ftl-color-mahjong-table/);
    expect(s).not.toMatch(/rgba\(\s*20\s*,\s*50\s*,\s*30/);
    expect(s).not.toMatch(/rgba\(\s*0\s*,\s*25\s*,\s*12/);
  });

  it('各麻将组件样式含 mj token，旧绿/橙字面量消失', () => {
    const comps = ['MahjongTile.vue', 'MahjongRiver.vue', 'MahjongMeld.vue', 'MahjongSeatChip.vue',
      'ClaimTile.vue', 'MahjongHuBanner.vue', 'MahjongCenter.vue'];
    for (const c of comps) expect(style(vue(`components/table/mahjong/${c}`).content)).toContain('$ftl-color-mj-');
    for (const c of ['ClaimTile.vue', 'MahjongHuBanner.vue', 'MahjongRiver.vue']) {
      const s = style(vue(`components/table/mahjong/${c}`).content);
      expect(s).not.toMatch(/rgba\(\s*30\s*,\s*60\s*,\s*40/);
      expect(s).not.toMatch(/rgba\(\s*60\s*,\s*110\s*,\s*75/);
      expect(s).not.toMatch(/rgba\(\s*255\s*,\s*180\s*,\s*60/);
      expect(s).not.toMatch(/rgba\(\s*220\s*,\s*100\s*,\s*30/);
    }
  });

  it('死 prop 不残留', () => {
    for (const c of ['MahjongTile.vue', 'MahjongMeld.vue']) {
      const s = style(vue(`components/table/mahjong/${c}`).content);
      expect(s).not.toContain('mj-tile--rotate');
      expect(s).not.toContain('mj-meld--vertical');
    }
  });

  it('uni.scss 定义全部 mj token', () => {
    const s = files.find((f) => f.path === 'src/uni.scss')!.content;
    for (const t of ['table-light', 'table-mid', 'table-deep', 'navy', 'glass', 'gold', 'cyan', 'urgent', 'muted', 'on-gold']) {
      expect(s).toContain(`$ftl-color-mj-${t}:`);
    }
  });
});
```
- 跑 `pnpm -C apps/client test -- mahjong-theme` → **红**。

### Step 6.2：实现 Board
- `.mj` 背景三层（最上层写最前）：
  ```scss
  background:
    repeating-radial-gradient(circle at 50% 45%, transparent 0 58px, $ftl-color-mj-highlight 58px 59px),
    radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.18), transparent 62%),
    linear-gradient(180deg, $ftl-color-mj-table-light 0%, $ftl-color-mj-table-mid 45%, $ftl-color-mj-table-deep 100%);
  ```
- 删除旧 `border` 和全部旧绿色 `box-shadow`。
- `.mj::before` 木框（`border-image` + token；`pointer-events:none`；`z-index:0`）。
- 顶栏：海军蓝玻璃 + 金 hairline；文字白。
- `.btn` / `.btn--small` / `.btn--primary`：海军蓝/金；主按钮金底 + 海军蓝文字。
- 托管遮罩、长按提示弹层：海军蓝玻璃 + 金边。
- `mj__lack--recommend`：金底 + 海军蓝文字。
- **裸文字对比度**：`.mj__waiting`、`.mj__hint`、`.mj__warn` 加海军蓝玻璃底 + 浅色文字；
  `.mj__warn` 用 `$ftl-color-mj-urgent`。
- 不写 `1px`；不写裸 hex。

### Step 6.3：跑绿
- `pnpm -C apps/client test -- mahjong-theme mahjong-board ui-tokens` 绿；lint 绿。
- Commit：`feat(mahjong): 亮青桌面/木框/蓝金顶栏与按钮/裸文字对比度`。

---

## Task 7：全量验证 + 文档 + 交付

### Steps
1. `pnpm -C apps/client test` → 全绿。
2. `pnpm -C apps/client run lint` → 0 错。
3. `pnpm -C apps/client test -- asset-budget mahjong-assets mahjong-theme` → 绿。
4. 真浏览器：
   - 若 Docker 栈可用：`node scripts/browser-e2e.mjs --keep-open` 进入麻将局后截图；
   - 若不可用：用 `.superpowers/mahjong-layout-research/v2-mockups/mockup.html`（实际路径）
     更新为新主题，用本机 Chromium headless 截图：
     ```bash
     CHROME=$(ls ~/.cache/ms-playwright/chromium-*/chrome-win/chrome.exe | head -1)
     "$CHROME" --headless=new --disable-gpu --window-size=1334,750 \
       --screenshot=.superpowers/mahjong-layout-research/v2-mockups/tianyue-1334x750.png \
       "file:///D:/Code/pokergame/.superpowers/mahjong-layout-research/v2-mockups/mockup.html"
     ```
     同样出 1334×1000、1623×750、1778×750；检查项见 spec 6.6。
   - 交付报告必须写明实际用了哪条路径；不可用真栈时明确“真栈截图待补”。
5. 更新 spec 状态/交接文档。
6. 最终 commit；`git status` 干净。
7. 推 `dev`（零 CI）。不合并 master、不打 tag、不部署。
8. 交付报告：变更、测试证据、提交 SHA、未闭合项。

### 验证矩阵
| 改动面 | 命令 | 预期 |
|---|---|---|
| 客户端 | `pnpm -C apps/client test` | 全绿 |
| 类型 | `pnpm -C apps/client run lint` | 0 错 |
| 素材 | `pnpm -C apps/client test -- asset-budget mahjong-assets` | 绿 |
| token | `pnpm -C apps/client test -- ui-tokens` | 绿 |
| 主题 | `pnpm -C apps/client test -- mahjong-theme` | 绿 |
| 视觉 | 真浏览器/静态 mockup 截图 | 对照 spec 6.6 |

## 风险与回滚

- 全部改动在客户端；回滚 `git revert <task commits>` 即可。
- 素材整批替换：回滚需同时恢复旧 PNG（commit 历史保留）。
- 基线修复（Task 0）独立提交，便于单独回滚。
- 若真浏览器验证不可用，交付报告必须写明，不把「单测绿」当视觉验收。

---

## 计划审查记录

独立 reviewer（sonnet，2026-11-02）结论：阻断 3 / 高 6 / 低 14。逐条处置：

| 编号 | 等级 | 结论 | 处置 |
|---|---|---|---|
| B1 Task 0 `.mj__actions` 空 wrapper `.text()` 抛错 | 阻断 | 成立 | Task 0 改为整段替换：断言 `.mj__actions` 不存在；删除旧 `.mj__my-revealed` 两行 |
| B2 `composed()` 漏 `.png` | 阻断 | 成立 | 脚本改为 `composed(f'{src}{r}')` 内部补 `.png` |
| B3 manifest 反斜杠 | 阻断 | 成立 | 脚本直接写 `f'{direction}/{name}.png'`；测试再 `replace(/\\/g,'/')` 兜底 |
| H1 布局旧精确锚点未更新 | 高 | 成立 | Task 2 列出 1334×750 EMPTY/WORST 全量新值 + 4 档独立期望表 |
| H2 视觉变化假红/无判别力 | 高 | 成立 | 加 `mj-meld--tray`、`mj-chip__avatar--gold`、`mj-chip__self-pill`、`mj-hu-banner--navy`、`mj-claim-tile--navy`；主题闸扫旧绿/橙字面量 |
| H3 `anim-urgent-pulse` 未 import | 高 | 成立 | Task 4 在 Center 样式顶部 `@import animations.scss`；源码闸锁 |
| H4 `navy_back` 丢 alpha | 高 | 成立 | `out.putalpha(back.split()[3])`；素材测试加 back 四角 alpha=0 |
| H5 主题闸范围/写法 | 高 | 成立 | 按文件 + `stripComments` + 只扫 `<style>`；容错正则；覆盖 ClaimTile/HuBanner/River |
| H6 Center 9/13 张预算无测试 | 高 | 成立 | 加 13 张用例：最多 12 张 + `+1`；`MAX_TING_TILES=12` |
| L1 数字/许可证/字段不一致 | 低 | 成立 | 旧 836KiB、新 585KiB、源 1.6MB；`LICENSE.md`；manifest 加 `direction` |
| L2 Python 依赖未声明 | 低 | 成立 | 新增 `scripts/assets/mahjong/requirements.txt` + pip 安装步骤 |
| L3 旧脚本仍可运行 | 低 | 成立 | 顶部 `console.error` + `process.exit(1)` |
| L4 公式自证 | 低 | 成立 | 加 4 档独立期望表（含 hand/center/actions/side/selfGap） |
| L5 Center 默认 claimH/tingH 旧值 | 低 | 成立 | 默认改 45/27；加默认尺寸测试 |
| L6 SeatChip spec frame/clip 与 plan 不一致 | 低 | 成立 | 采用“外层不裁切 + image 自身 pill + 金边类”；spec 描述按此实现 |
| L7 丢 seconds=6/紧凑字号闸 | 低 | 成立 | 加 seconds=6 非 urgent；保留紧凑 11px 源码闸 |
| L8 裸文字/白字金底对比度 | 低 | 成立 | Task 6 给 waiting/hint/warn 加海军蓝底；Task 5 改 Hu 角标/结算主按钮文字色 |
| L9 缺计划审查记录 | 低 | 成立 | 本节 |
| L10 mockup 路径/截图命令 | 低 | 成立 | 改为 `v2-mockups/mockup.html`；给出 Chromium headless 命令 |
| L11 起始 z 删除混入 Task 0 | 低 | 成立 | Global Constraints + Task 0 明确只 add 3 个文件；Task 1 提交素材删除 |
| L12 dir-* 旧尺寸覆盖残留 | 低 | 成立 | Task 3 删除/同步 `.mj-tile--dir-*` 尺寸覆盖；加 direction+size 断言 |
| L13 素材测试只 toContain | 低 | 成立 | 改为精确集合/长度 28；manifest 112 条；1/9 两张方向抽检 |
| L14 CSS 示例裸 rgba/2px | 低 | 成立 | 新增 `$ftl-color-mj-glass-soft/shadow/highlight`；描边走 `$ftl-hairline` |

## 执行期发现（Task 7 视觉走查）

1. **`$ftl-space-1` 不存在**：间距阶从 `$ftl-space-2: 4px` 开始。`MahjongMeld`
   底托 `padding: $ftl-space-1` 在单元测试里没被编译到（组件的 scoped SCSS 变量
   解析由视觉 harness 才真正触发），改成 `$ftl-space-2`。
2. **`dirSizeKiB` 旧 bug**：递归返回 KiB 又被父层当字节累加，麻将 4 个子目录
   实际 836KiB 被算成 0.8KiB。修成 `dirSizeBytes` 递归 + 顶层除 1024；否则
   `table/mahjong` 预算闸是假绿。
3. **中央卡无 claim/ting 时右列留空**：新增 `hasSide`，无内容时隐藏右列，圆盘在卡内居中。
4. **claim 阶段手牌被洗白**：`.mj-tile--disabled` 0.45 在亮青桌面上太淡，改 0.85；
   仍不可点击，但牌面可读。
5. **视觉 harness**：本机临时 Vite harness（真实 `MahjongBoard` 组件 + 本机 Chrome
   headless）截图，未入库；截图在 `.superpowers/mahjong-visual/`：
   `tianyue-1334x750.png`、`tianyue-1334x1000.png`、`tianyue-1623x750.png`、
   `tianyue-claim-1334x750.png`。本机无 Docker，真栈截图待补。

## 执行结果（2026-11-02）

- `pnpm -C apps/client test`：**1762 passed / 2 skipped**（131 files）。
- `pnpm -C apps/client run lint`：**0 错**。
- `asset-budget` / `mahjong-assets` / `ui-tokens` / `mahjong-theme`：全绿。
- 视觉：见上；本机无 Docker，未跑真栈 e2e。


## 代码审查记录（终审，2026-11-02）

独立终审（opus）结论：Critical 0 / Important 4 / Minor 9。

| 编号 | 等级 | 结论 | 处置 |
|---|---|---|---|
| I1 主按钮 hover 被 `.btn:hover` 覆盖成白字 | Important | 成立 | Board/Settlement 的 `.btn--primary:hover/active` 补 `color: $ftl-color-mj-on-gold`；主题闸加源码断言 |
| I2 中央盘 10–12px 字号在 k≈0.52 真机只有 5–6 CSS px | Important | 成立 | 正文/标签升到 `$ftl-font-xs`（22px）；顶条 30、padding 4、圆盘 110 = 148；最差卡 153.4；claim 时听牌限 9 张一行 |
| I3 `game.finished` 的 `wallEmptyWithHu` 被客户端校验拒绝 | Important | 成立 | `messages.ts`/`validate.ts`/`stores/game.ts` 补第三值；protocol 用例覆盖 |
| I4 音频条目「同出该仓库」指向 FluffyStuff | Important | 成立 | 改为独立描述幼麟音频来源；修正音频路径 |
| M1 删除 left/right 横置尺寸类 | Minor | 成立 | 补回 45×34 / 61×46 / 80×60；测试改断言横置 |
| M2 tray padding 未进布局预算 | Minor | 成立 | `margin: -$ftl-space-2` 抵消 padding；源码闸锁 |
| M3 杠按钮金底金字对比度低 | Minor | 成立 | 改海军蓝字 |
| M4 Claim 按钮 52px 低于触控下限 | Minor | 成立 | 改 `$ftl-control-h`（88） |
| M5 play 阶段自摸/杠候选显示「可响应」 | Minor | 成立 | centerProps 仅 claim/rob 传 claimTile；Board 用例 |
| M6 compact 分支不可达/阈值不符 | Minor | 部分 | 阈值改 148/160，compact 作为小画布防御保留；登记 |
| M7 SeatChip 角标/徽标对比度 | Minor | 成立 | 庄金底海军蓝字、缺/番型海军蓝底青字、活跃态 token |
| M8 测试缺口 | Minor | 部分 | 补 Board ended/claim 过滤/托管取消、整 SFC 死 prop 闸、top 方向像素；1778 截图已补；App 真机待补 |
| M9 文档/数字漂移 | Minor | 成立 | 同步 tile 注释、Board 注释、asset 注释、spec/plan 字号/体积数字 |

最终验证：client 1767 passed / 2 skipped；protocol 325；shared 446；vue-tsc 0；H5 build DONE。
