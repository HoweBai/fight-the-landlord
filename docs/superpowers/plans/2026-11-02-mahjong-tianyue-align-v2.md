# 实现计划：麻将牌桌「天月对齐 v2」

Spec：`docs/superpowers/specs/2026-11-02-mahjong-tianyue-align-v2-design.md`（v2.1，已对抗审查）
日期：2026-11-02
分支：`dev`
范围：纯客户端展示层（麻将牌桌打磨）
基线：`dev-d867cbd`（v1 已部署）

## Global Constraints

- **纯客户端**：不改协议/服务端/数据库/admin。
- **TDD**：每任务先写/改失败测试 → 红 → 实现 → 绿 → 提交。
- **token 纪律**：组件样式只用 `$ftl-*`；不写裸 hex；描边 `$ftl-hairline`；不新增 `@keyframes`。
- **川麻语义**：无东南西北/局数；中央四家用**局分 delta**（`pendingScoreChanges`），不是钱包余额。
- **不做角色立绘**：头像仍 `default.png`。
- **素材**：灰度着色（冷白/宝蓝），64 色量化；生成结果入库。
- **提交**：每任务一个 commit，attribution 行照旧。
- **验证**：`pnpm -C apps/client test`、`run lint`、`packages/protocol test`、`packages/shared test`、`build:h5`。

---

## Task 1：色板 + 牌面重生成 + 素材/主题测试

### Files
- `apps/client/src/uni.scss`
- `scripts/build-mahjong-tile-set.py`
- 重新生成 `apps/client/src/pages/table/static/mahjong/{my,top,left,right}/*.png` + `manifest.json`
- `apps/client/test/mahjong-assets.test.ts`
- `apps/client/test/mahjong-theme.test.ts`
- `THIRD-PARTY-NOTICES.md`

### Step 1.1：先加失败测试
`mahjong-assets.test.ts` 新增：
```ts
it('牌面色温：冷白（低饱和亮像素 B≥G≥R）', async () => {
  const img = await loadImage(readFileSync(join(ROOT, 'my/wan-1.png')));
  // 10px 网格采样；排除字形/红绿（max-min>=18）与透明
  // 断言 avg(B) >= avg(G)-2、avg(G) >= avg(R)-2、avg > 225
});
it('牌背色：亮宝蓝（中心 B>R+50, B>G+30, |B-192|<=30）', async () => { ... });
it('牌面四角 alpha=0（my/top）', async () => { ... });
```
`mahjong-theme.test.ts` 的 uni.scss 必含列表加 `panel` / `panel-light`；ClaimTile 源码闸改 `$ftl-color-mj-panel`（同时保留 navy 可用于按钮）。
- 跑定向 → **红**（旧牌面暖白/旧牌背深蓝/无 panel token）。

### Step 1.2：色板
`uni.scss` 改为 spec §5.1 的值；保留其余 token。

### Step 1.3：脚本
`build-mahjong-tile-set.py`：
- `composed()`：`ImageOps.grayscale(Front)` → `colorize(black=(205,210,218), mid=(238,241,244), white=(255,255,255))` → `putalpha(front.alpha)` → 叠字形。
- `royal_back()`：`grayscale(Back)` → `colorize(black=(35,55,100), mid=(91,126,192), white=(160,178,214))` → `putalpha(back.alpha)`。
- 运行脚本；manifest 更新；目录约 588KiB。
- NOTICE 修改描述加“灰度着色、冷白/宝蓝”。

### Step 1.4：跑绿
- `pnpm -C apps/client test -- mahjong-assets mahjong-theme ui-tokens asset-budget` → 绿。
- Commit：`feat(mahjong): 天月对齐色板与冷白牌面/亮宝蓝牌背`。

---

## Task 2：布局重算（手牌 116 / 0.95W / 自家人像 / 中央卡）

### Files
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/test/mahjong-layout.test.ts`

### Step 2.1：改测试（红）
1. `expectedS` 手牌行宽 `1256`，宽度兜底 `0.95`。
2. `hand.rect.top = v.h - (12 + 116) * s`。
3. 中央井高（WORST：top 1 副露、self 1 副露）：
   `v.h - (64 + 229.8 + 302.8) * s`。
4. 1334×750 精确块替换为：

| 字段 | EMPTY | WORST |
|---|---|---|
| hand | 39,622,1256,116；tile 87×116 | 同左 |
| selfChip | 224.333,526,56,76 | 同左 |
| centerZone | 224.333,241,885.333,259 | 224.333,293.8,885.333,153.4 |
| centerCard | 497,285.5,340,170 | 497,297.8,340,145.4 |
| ownRiver | 404,500,526,114 | 404,447.2,526,114 |
| leftRiver | 65.333,180,151,310 | 65.333,165.9,151,310 |
| leftMeld | 零矩形 | 65.333,483.9,151,108.2 |
| leftBacks | 12,180,45.333,398 | 12,165.9,45.333,398 |
| actions | rightX 1109.667, bottomY 614, bottomOffset 136, maxWidth 171.667 | 同左 |
| centerTiles | claim 34×45, ting 20×27 | 同左 |

5. 8 档独立期望表：

| 视口 | s | hand l/w/h | self x/y | centerEmpty zone/W/H | centerWorst zone/W/H | actions maxW |
|---|---|---|---|---|---|---|
| 1334×750 | 1 | 39/1256/116 | 224.33/526 | 259/340/170 | 153.4/340/145.4 | 171.67 |
| 1623×750 | 1 | 183.5/1256/116 | 224.33/526 | 259/340/170 | 153.4/340/145.4 | 316.17 |
| 1778×750 | 1 | 261/1256/116 | 224.33/526 | 259/340/170 | 153.4/340/145.4 | 393.67 |
| 1334×833 | 1.008997 | 33.35/1267.3/117.04 | 226.35/606.98 | 337.58/343.06/171.53 | 231.03/343.06/171.53 | 167.21 |
| 1334×1000 | 1.008997 | 33.35/1267.3/117.04 | 226.35/773.98 | 504.58/343.06/171.53 | 398.03/343.06/171.53 | 167.21 |
| 1334×1334 | 1.008997 | 33.35/1267.3/117.04 | 226.35/1107.98 | 838.58/343.06/171.53 | 732.03/343.06/171.53 | 167.21 |
| 1500×750 | 1 | 122/1256/116 | 224.33/526 | 259/340/170 | 153.4/340/145.4 | 254.67 |
| 1343×1000 | 1.015804 | 33.58/1275.85/117.83 | 227.88/772.46 | 501.24/345.37/172.69 | 393.97/345.37/172.69 | 168.34 |

6. 断言：
   - `hand.left > selfChip.right` **删除**；改：
     - `selfChip.bottom = hand.top - 20*s`；
     - `selfChip.left ≥ leftRiver.meld.rect.right + 8*s - 0.1`；
     - `selfChip` 与 `leftRiver.rect` / `leftRiver.meld.rect` / `ownRiver.rect` / `hand.rect` 无重叠（矩形相交判定）。
   - `centerCompact === (centerCard.height < 143*s)`；8 档 false。
   - `centerCard.height ≥ 143*s`；`centerCard.height` 最差 145.4。
   - 0.95W 兜底：`hand.rect.width ≤ 0.95*v.w + 0.01`。
   - 顶牌背 14 张 ≤ 河宽；动作区不压自家牌河；牌河网格放得下。
   - token：`handH=116`。
7. 跑 `pnpm -C apps/client test -- mahjong-layout` → **红**。

### Step 2.2：改布局
- `handH: 116`。
- `s = Math.max(1, Math.min(h/750, (0.95*w)/handRowW))`。
- `selfChip = rect(centerZone.left, handTop - T.selfChipH*s - 20*s, T.selfChipW*s, T.selfChipH*s)`。
- 中央卡高 `min(170*s, centerZone.height - 8*s)`。
- `compactZone = centerZone.height < 151*s`；`centerCompact = centerCardH < 143*s`。
- 其余不变。

### Step 2.3：跑绿
- `pnpm -C apps/client test -- mahjong-layout mahjong-board` → 绿。
- lint 绿。
- Commit：`feat(mahjong): 手牌 116/0.95W、自家人像上移、中央卡 145.4`。

---

## Task 3：中央盘四家局分 + Board 接线

### Files
- `MahjongCenter.vue`
- `MahjongBoard.vue`
- `apps/client/test/mahjong-center.test.ts`
- `apps/client/test/mahjong-board.test.ts`
- `apps/client/test/mahjong-theme.test.ts`

### Step 3.1：重写 Center 测试（红）
新 `base`：
```ts
const seats = [
  { label: '对', score: -800, badge: '缺万' },
  { label: '左', score: 1200, badge: '听' },
  { label: '右', score: 0, badge: '胡' },
  { label: '我', score: 0, badge: '庄·缺筒' },
];
const base = { wallCount: 42, phaseText: '请出牌', seconds: 12, active: true,
  seats, tingW: 20, tingH: 27 };
```
用例：
- 四家 label/score/badge 全部渲染；`+1200`/`-800`/`0`；四格顺序。
- `123000` → `12.3万`；`null`/无 seats → 不渲染列。
- badge `庄·缺万` / `听` / `胡` / `出局`。
- dial/urgent/ended/seconds 语义不变；ended 隐藏听牌、显示 endedText。
- 听牌 13 张 → 8 张 + `听 13 张`；fan 14px；20×27。
- 紧凑：隐藏四家/听牌，只出圆盘 + 单行。
- 源码闸：`$ftl-color-mj-panel`；无 `claimTile`；`.mj-center` 无 `border:`/`gap:`；`box-shadow: inset 0 0 0 $ftl-hairline`；14px 只出现在 prefix/fan 例外。
- 跑 `pnpm -C apps/client test -- mahjong-center` → **红**。

### Step 3.2：实现 Center
- props：`seats?: Array<{label:string;score:number;badge:string}>`（默认 []）；`tingTiles/tingW/tingH/maxFan`；移除 `claimTile/claimW/claimH`。
- 模板：strip 28 / body 80（左列 100 + 圆盘 80 + 右列 100）/ ting 27。
- 四家格：prefix 14px、score 22px、badge 18px；两行 40 高；badge 颜色按前缀/关键字。
- 余额格式：`abs>=100000` → `(n/10000).toFixed(1)万`；否则原样。
- 听牌：最多 8 张；标签 `听 {{tingTiles.length}} 张`；fan `{{maxFan}}番` 14px。
- ended：隐藏 ting，显示 endedText。
- CSS：炭黑渐变 `panel/panel-light`；无布局 border；金边 `inset 0 0 0 $ftl-hairline $ftl-color-mj-gold`；无 gap；padding 4 8。
- 紧凑：保留。

### Step 3.3：Board 接线
- `pendingScoreChanges` 按 seat 求和 → `centerSeats`。
- `badgeFor`：庄前缀 + 胡>出局>听>缺。
- `centerProps` 传 `seats`；移除 claim 三参。
- 删除 Board 测试 `.mj-center__claim` 假绿断言；新增：
  - 自由场无 pending → 四家 0；
  - `pendingScoreChanges` 对位（right +1200、top -800）；
  - 庄/缺/听/胡/出局徽标组合。
- 跑 `pnpm -C apps/client test -- mahjong-center mahjong-board mahjong-theme` → 绿；lint 绿。
- Commit：`feat(mahjong): 中央盘四家局分/状态 + 听牌行`。

---

## Task 4：ClaimTile 牌面预览

### Files
- `ClaimTile.vue`
- `MahjongBoard.vue`（传 preview 尺寸）
- `apps/client/test/mahjong-claim-tile.test.ts`
- `apps/client/test/mahjong-board.test.ts`

### Step 4.1：测试（红）
- ClaimTile：
  - `options` 含 tile → 顶部出现 `MahjongTile`，尺寸 34×45；
  - 只有 `pass`/无 tile → 不出现；
  - `filteredOptions=[]` 但 `options` 有 tile → 仍出现；
  - 根类 `mj-claim-tile--panel`；源码闸 `$ftl-color-mj-panel`。
- Board：claim 窗口渲染 ClaimTile 且预览 tile 出现；传 preview 尺寸 34×45。
- 跑定向 → 红。

### Step 4.2：实现
- ClaimTile props `previewW=34` / `previewH=45`；`previewTile = options.find(o=>o.tile)?.tile ?? null`。
- 顶部 `可响应` + tile（有则出）；无 tile 只出文字。
- 根类 `mj-claim-tile--panel`；背景 `$ftl-color-mj-panel`；按钮不变。
- Board 传 `:preview-w="layout.centerTiles.claim.w"`、`:preview-h="...h"`。
- 跑绿；lint 绿。
- Commit：`feat(mahjong): ClaimTile 顶部牌面预览 + 炭黑面板`。

---

## Task 5：全量验证 + 视觉 + 版本 + 部署 + APK

### Step 5.1：全量
- `pnpm -C apps/client test` → 全绿。
- `pnpm -C apps/client run lint` → 0。
- `pnpm -C packages/protocol test` / `packages/shared test` → 绿。
- `pnpm -C apps/client run build:h5` → DONE。

### Step 5.2：视觉
- 临时 visual harness（真实 `MahjongBoard` + Chrome headless）：
  - 1334×750 EMPTY / WORST（4 副露）；
  - 1334×1000、1623×750、1778×750；
  - 844×390（scale 0.52）；
  - claim 窗口。
- 检查：中央卡 145.4 不裁切；四家 100px 列不挤；自家人像/左副露；ClaimTile 预览；冷白牌/亮蓝背/炭黑中央。
- 截图存 `.superpowers/mahjong-visual/v2-*.png`（gitignored）。

### Step 5.3：版本 + 出包 + 部署
1. `apps/client/src/manifest.json` → `0.1.8 / versionCode 108`；commit。
2. 构建 APK：`bash scripts/deploy/pack-apk.sh ssh.yobeeo.com` → 校验 0.1.8/108。
3. 发布 APK：`bash scripts/deploy/publish-apk.sh deploy/download/ubigame.apk`。
4. 部署：`bash scripts/deploy/deploy-dev.sh`（images 构建会拉新 APK）。
5. 验证：`/api/health` 200；H5 200；`/download/ubigame.apk` sha256 与本地一致、版本 0.1.8/108。
6. 更新 handoff/spec 状态；commit；push `dev`。

### 验证矩阵
| 面 | 命令 | 预期 |
|---|---|---|
| 客户端 | `pnpm -C apps/client test` | 全绿 |
| 类型 | `pnpm -C apps/client run lint` | 0 |
| protocol/shared | `pnpm -C packages/protocol test` / `packages/shared test` | 绿 |
| H5 构建 | `pnpm -C apps/client run build:h5` | DONE |
| 素材 | `asset-budget mahjong-assets` | 绿 |
| 主题 | `mahjong-theme ui-tokens` | 绿 |
| 部署 | health/H5/APK | 200/200/sha 一致 |
| 视觉 | 6 张截图 | 对照用户图 |

## 风险与回滚

- 中央卡 145.4 余量 2.4：若真浏览器裁切，退 114 手牌/圆盘 76（spec §8）。
- APK 0.1.8/108 覆盖安装；Release `apk-latest` 更新。
- 回滚：`git revert <task commits>`；测试服 `rollback.sh <上一个 dev-tag>`；APK 重新发旧资产。
