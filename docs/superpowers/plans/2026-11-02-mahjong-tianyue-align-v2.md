# 实现计划：麻将牌桌「天月对齐 v2」

Spec：`docs/superpowers/specs/2026-11-02-mahjong-tianyue-align-v2-design.md`（v2.1，已对抗审查 + 计划审查修订）
日期：2026-11-02
分支：`dev`
基线：`dev-d867cbd`（v1 已部署）

## Global Constraints

- **纯客户端**：不改协议/服务端/数据库/admin。
- **TDD**：每任务先写/改失败测试 → 红 → 实现 → 绿 → 提交。
- **token 纪律**：组件样式只用 `$ftl-*`；不写裸 hex；描边 `$ftl-hairline`；新增 `$ftl-font-mj-badge: 18px` / `$ftl-font-mj-mini: 14px` 作为登记例外。
- **川麻语义**：中央四家数字是**杠分/临时分投影**（`pendingScoreChanges`），不是完整局分/钱包余额；spec/handoff 必须标注。
- **不做角色立绘**：头像仍 `default.png`。
- **素材**：灰度 colorize（冷白/宝蓝），64 色量化；生成结果入库；实测约 529KiB。
- **命令**：用显式文件路径 `pnpm -C apps/client exec vitest run test/<file>.test.ts`，不用 `test -- <filter>`。
- **提交**：每任务一个 commit，attribution 行照旧。

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
it('牌面色温：冷白（低饱和亮像素 B≥G≥R、228–250、unique≥6）', async () => {
  // 10px 网格采样；sat<18、bright>225
  // avg >=228 && avg <=250; avgB>=avgG>=avgR; avgB-avgR>=3; unique>=6
});
it('牌背色：亮宝蓝（R>=70, G>=100, |B-181|<=15）', async () => { ... });
it('牌面四角 alpha=0（my/top）', async () => { ... });
```
- 旧牌面 `[244.7,239.9,235]`（R>G>B）、旧背 `[44,49,187]`（R/G 过低）→ 新测试必红。
- `mahjong-theme.test.ts` 的 uni.scss 必含列表加 `panel` / `panel-light`；字体例外 token `font-mj-badge`/`font-mj-mini`。
- 跑 `pnpm -C apps/client exec vitest run test/mahjong-assets.test.ts test/mahjong-theme.test.ts` → **红**。

### Step 1.2：色板
`uni.scss`：
- 桌面 `#7fa8c0/#5c93ac/#436c87`；panel `#3a3d42/#4a4d54`；navy `#1e3352/#2c4270`；木框 `#6b5a4a/#5a4d42/#4a3f36`。
- 新增 `$ftl-font-mj-badge: 18px; $ftl-font-mj-mini: 14px;`。

### Step 1.3：脚本
- `from PIL import Image, ImageOps`。
- `composed()`：`grayscale(Front)` → `colorize(black=(190,195,205), mid=(232,236,241), white=(240,244,250))` → `putalpha(front.alpha)` → 叠字形。
- `royal_back()`（替换 `navy_back()`）：`grayscale(Back)` → `colorize(black=(35,55,100), mid=(91,126,192), white=(160,178,214))` → `putalpha(back.alpha)`。
- 运行脚本；manifest 更新；实测约 529KiB。
- NOTICE 修改描述加“灰度着色、冷白/宝蓝”。

### Step 1.4：跑绿
- `pnpm -C apps/client exec vitest run test/mahjong-assets.test.ts test/mahjong-theme.test.ts test/ui-tokens.test.ts test/asset-budget.test.ts` → 绿。
- Commit：`feat(mahjong): 天月对齐色板与冷白牌面/亮宝蓝牌背`。

---

## Task 2：布局重算（手牌 116 / 0.95W / 自家人像 / 中央卡）

### Files
- `apps/client/src/game/mahjong-layout.ts`
- `apps/client/test/mahjong-layout.test.ts`

### Step 2.1：改测试（红）
1. `expectedS` 手牌行宽 `1256`，宽度兜底 `0.95`。
2. `hand.rect.top = v.h - (12 + 116) * s`。
3. 中央井高（WORST）：`v.h - (64 + 229.8 + 302.8) * s`。
4. 1334×750 精确块：

| 字段 | EMPTY | WORST |
|---|---|---|
| hand | 39,622,1256,116；tile 87×116 | 同左 |
| selfChip | 224.333,526,56,76 | 同左 |
| centerZone | 224.333,241,885.333,259 | 224.333,293.8,885.333,153.4 |
| centerCard | 497,285.5,340,170 | 497,297.8,340,145.4 |
| ownRiver | 404,500,526,114 | 404,447.2,526,114 |
| ownRiver.meld.rect.top | — | 569.2 |
| leftZone.top | 116 | 101.9 |
| leftChip.top | 116 | 101.9 |
| leftRiver | 65.333,180,151,310 | 65.333,165.9,151,310 |
| leftMeld | 零矩形 | 65.333,483.9,151,108.2 |
| leftBacks | 12,180,45.333,398 | 12,165.9,45.333,398 |
| actions | rightX 1109.667, bottomY 614, bottomOffset 136, maxWidth 171.667 | 同左 |
| centerTiles | claim 34×45, ting 20×27 | 同左 |

5. 8 档独立期望表（同 spec §5.3）：
```
1334×750    s=1           hand 39/1256/116    self 224.33/526       empty 259/340/170    worst 153.4/340/145.4  actions 171.67
1623×750    s=1           hand 183.5/1256/116 self 224.33/526       empty 259/340/170    worst 153.4/340/145.4  actions 316.17
1778×750    s=1           hand 261/1256/116   self 224.33/526       empty 259/340/170    worst 153.4/340/145.4  actions 393.67
1334×833    s=1.008997    hand 33.35/1267.3/117.04 self 226.35/606.98 empty 337.58/343.06/171.53 worst 231.03/343.06/171.53 actions 167.21
1334×1000   s=1.008997    hand 33.35/1267.3/117.04 self 226.35/773.98 empty 504.58/343.06/171.53 worst 398.03/343.06/171.53 actions 167.21
1334×1334   s=1.008997    hand 33.35/1267.3/117.04 self 226.35/1107.98 empty 838.58/343.06/171.53 worst 732.03/343.06/171.53 actions 167.21
1500×750    s=1           hand 122/1256/116   self 224.33/526       empty 259/340/170    worst 153.4/340/145.4  actions 254.67
1343×1000   s=1.015804    hand 33.58/1275.85/117.83 self 227.88/772.46 empty 501.24/345.37/172.69 worst 393.97/345.37/172.69 actions 168.34
```
6. 断言：
   - **删除** `hand.left > selfChip.right`（精确块）与矩阵里 `selfChip.right <= hand.left`。
   - 改：
     - `selfChip.bottom = hand.top - 20*s`；
     - `selfChip.left ≥ leftRiver.meld.rect.right + 8*s - 0.1`；
     - `selfChip` 与 `leftRiver.rect` / `leftRiver.meld.rect` / `ownRiver.rect` / `hand.rect` 无重叠（x/y 双轴）。
   - `centerCompact === (centerCard.height < 143*s)`；8 档 false；`centerCard.height ≥ 143*s`。
   - 1334×750：`s === 1`、`hand.rect.width === 1256`；0.95W 只作上限。
   - 顶牌背 14 张 ≤ 河宽；动作区不压自家牌河；牌河网格放得下；token `handH=116`。
7. 跑 `pnpm -C apps/client exec vitest run test/mahjong-layout.test.ts` → **红**。

### Step 2.2：改布局
- `handH: 116`。
- `s = Math.max(1, Math.min(h/750, (0.95*w)/handRowW))`。
- `selfChip = rect(centerZone.left, handTop - T.selfChipH*s - 20*s, ...)`。
- 中央卡高 `min(170*s, centerZone.height - 8*s)`。
- `compactZone = centerZone.height < 151*s`；`centerCompact = centerCardH < 143*s`。
- 文件头注释：0.88W → 0.95W；“左侧留卡” → “中央井左缘、手牌上方”。

### Step 2.3：跑绿
- `pnpm -C apps/client exec vitest run test/mahjong-layout.test.ts test/mahjong-board.test.ts` → 绿。
- lint 绿。
- Commit：`feat(mahjong): 手牌 116/0.95W、自家人像上移、中央卡 145.4`。

---

## Task 3：中央盘四家临时分 + Board 接线

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
  { label: '对', score: -800, dealer: false, badge: '缺万' },
  { label: '左', score: 1200, dealer: false, badge: '听' },
  { label: '右', score: 0, dealer: true, badge: '胡' },
  { label: '我', score: 0, dealer: false, badge: '缺筒' },
];
const base = { wallCount: 42, phaseText: '请出牌', seconds: 12, active: true, seats, tingW: 20, tingH: 27 };
```
**删除/替换旧 claim 用例**（`mahjong-center.test.ts` 当前 18-137 行）：
- 删除：`无 claim/ting/endedText 时右列不渲染`、`claim+ting`、`claim 单行`、`compact claim`、`默认 claimH/tingH`。
- 新增：
  - 四家 label/score/badge 渲染；`+1200`/`-800`/`0`；四格顺序；dealer 金色“庄”独立。
  - `1230000` → `123.0万`；无 seats → 不渲染列；`score: null` 不允许（类型 number）。
  - badge `庄·缺万`/`听`/`胡`/`出局`；dealer+badge 两段类名。
  - dial/urgent/ended/seconds 语义不变；ended 隐藏听牌、显示 endedText。
  - 听牌 13 张 → 8 张 + `听 13 张`；fan 14px；20×27。
  - compact：单行 `牌墙 42 · 请出牌 · 12s`，无牌面。
  - 源码闸：`$ftl-color-mj-panel`；无 `claimTile`；根 `.mj-center` 块无 `border:`/`gap:`；`.mj-center__dial` 80×80 + box-sizing；`.mj-center__strip` 28；`.mj-center__body` 80；`.mj-center__col` 100；cell 40 + line-height 1；字体只用 token（14/18 例外 token）。
- 跑 `pnpm -C apps/client exec vitest run test/mahjong-center.test.ts` → **红**。

### Step 3.2：实现 Center
- props：`seats?: Array<{label:string;score:number;dealer:boolean;badge:string}>`（默认 []）；`tingTiles/tingW/tingH/maxFan`；移除 `claimTile/claimW/claimH`。
- **删除**：`MAHJONG_SUIT_NAMES` 导入（claimLabel 用）、`MAX_TING_TILES_WITH_CLAIM`、`claimLabel`、`extraTing`、`hasSide`。
- 模板：strip 28 / body 80（左列 100 + 圆盘 80 + 右列 100）/ ting 27。
- 四家格：cell 40、line-height 1、gap 0、padding 0；prefix 14、score 22、dealer 金色 + badge 18。
- 分数：`abs>=1_000_000` → `(n/10000).toFixed(1)万`；否则原样。
- 听牌：最多 8；`听 {{tingTiles.length}} 张`；fan 14。
- ended：隐藏 ting，显示 endedText（Board 必须传真实文案）。
- CSS：炭黑 `panel/panel-light`；无布局 border；金边 `box-shadow: inset 0 0 0 $ftl-hairline $ftl-color-mj-gold`；无 gap；padding 4 8；dial 80×80 + `box-sizing:border-box`；strip 28。
- 紧凑：`牌墙 · 阶段 · 秒`。
- 跑 `pnpm -C apps/client exec vitest run test/mahjong-center.test.ts` → 绿。

### Step 3.3：Board 接线
- `const v = props.view`；`pending` 从 `v?.pendingScoreChanges` 求和；全部 `?.` 守卫。
- `centerSeats` 用 `topSeat.value/leftSeat.value/rightSeat.value/me.value`；`dealer` 布尔；`badgeFor` 胡>出局>听>缺。
- 移除 `claimTile/claimW/claimH` 从 centerProps；删除只被它使用的 `claimTile` computed（若无人用）。
- `endedText`：ended 时传 `已胡 N 家` / `牌墙摸空` / `本局结束`，不传空串。
- Board 测试：
  - 删除 `.mj-center__claim` 假绿断言；
  - 新增：无 pending → 四家 0；`pendingScoreChanges` 对位；庄/缺/听/胡/出局组合；ended 文案；四家分数文本。
- 跑 `pnpm -C apps/client exec vitest run test/mahjong-center.test.ts test/mahjong-board.test.ts test/mahjong-theme.test.ts` → 绿；lint 绿。
- Commit：`feat(mahjong): 中央盘四家临时分/状态 + 听牌行`。

---

## Task 4：ClaimTile 2 列 + 牌面预览

### Files
- `ClaimTile.vue`
- `MahjongBoard.vue`（传 preview 尺寸）
- `apps/client/test/mahjong-claim-tile.test.ts`
- `apps/client/test/mahjong-board.test.ts`

### Step 4.1：测试（红）
- options 含 tile → 顶部 `MahjongTile`，尺寸 34×45，`src` 等于第一张 tile；预览在 `.mj-claim-tile__opts` 之前。
- 只有 pass/无 tile → 不出现预览。
- `filteredOptions` 非空 → 预览取 filtered 的第一张；filtered 为空 → 回退 options。
- 按钮文案 `胡/碰/杠/过`；番数 `3番` 14px 徽标；2 列（源码闸 `grid-template-columns: repeat(2` 或 flex-basis 50%）。
- 根类 `mj-claim-tile--panel`；源码闸 `$ftl-color-mj-panel`。
- Board claim 窗口渲染 ClaimTile + 预览；传 preview 尺寸。
- 跑 `pnpm -C apps/client exec vitest run test/mahjong-claim-tile.test.ts test/mahjong-board.test.ts` → 红。

### Step 4.2：实现
- props `previewW=34`/`previewH=45`；`source = filteredOptions?.length ? filteredOptions : options`；`previewTile = source.find(o=>o.tile)?.tile ?? null`。
- 顶部 `可响应` + tile；无 tile 只出文字。
- 按钮文案 `胡/碰/杠/过`；番数 14px 徽标；2 列网格；min-width 68、gap 6、padding 10。
- 根类 `mj-claim-tile--panel`；背景 `$ftl-color-mj-panel`。
- Board 传 preview 尺寸。
- 跑绿；lint 绿。
- Commit：`feat(mahjong): ClaimTile 2 列 + 顶部牌面预览 + 炭黑面板`。

---

## Task 5：独立代码审查（必须）

- 派独立 reviewer 审 `BASE..HEAD`（BASE = `e3e0e563`，含 spec/plan；或本片开始前的 `e3e0e563`）对照 spec/plan。
- 重点：布局 8 档、中央 143 内容、四家 100/22/18、牌面/牌背色、ClaimTile 2 列/预览、Board 接线、测试假绿、回归面。
- Critical/Important 必须修；Minor 登记或顺手修。
- 审查结论写进本计划「代码审查记录」；修完再进 Task 6。

---

## Task 6：全量验证 + 视觉 + 版本 + 部署 + APK

### Step 6.1：全量
- `pnpm -C apps/client test` → 全绿。
- `pnpm -C apps/client run lint` → 0。
- `pnpm -C packages/protocol test` / `packages/shared test` → 绿。
- `pnpm -C apps/client run build:h5` → DONE。

### Step 6.2：视觉
- 临时 visual harness（真实 `MahjongBoard` + Chrome headless）：
  - 1334×750 EMPTY / WORST（4 副露）；
  - 1334×1000、1623×750、1778×750；
  - 844×390（scale 0.52）；
  - claim（2 列 + 预览）。
- **浏览器量高**：用 CDP `getBoundingClientRect` 断言中央卡内容 ≤ 卡高、四家列 100、dial 80、claim 面板不越顶栏。
- 截图存 `.superpowers/mahjong-visual/v2-*.png`（gitignored）。

### Step 6.3：版本 + 出包 + 部署
0. **工作区必须干净**：`git status --porcelain` 为空（APK 从工作树构建，镜像从 tag 构建）。
1. `apps/client/src/manifest.json` → `0.1.8 / versionCode 108`；commit；push。
2. `bash scripts/deploy/pack-apk.sh ssh.yobeeo.com` → `unzip -p ... manifest.json | grep` 断言 `0.1.8/108`。
3. `bash scripts/deploy/publish-apk.sh deploy/download/ubigame.apk`（Release `apk-latest`）。
4. `bash scripts/deploy/deploy-dev.sh`（images 构建拉新 APK；部署 + 冒烟）。
5. 验证：`/api/health` 200；H5 200；`/download/ubigame.apk` sha256 与本地一致、版本 `0.1.8/108`。
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
| 浏览器 | 6 张截图 + CDP 量高 | 通过 |
| 部署 | health/H5/APK | 200/200/sha 一致 |

## 风险与回滚

- 中央卡 145.4 余 2.4：浏览器量高；若裁切退 114 手牌/圆盘 76。
- APK 0.1.8/108 覆盖安装；Release `apk-latest` 更新。
- 回滚：`git revert <task commits>`；测试服 `rollback.sh <上一个 dev-tag>`；APK 重新发旧资产。

---

## 计划审查记录

独立 reviewer（sonnet，2026-11-02）结论：阻断 3 / 高 13 / 低 15。逐条处置：

| 编号 | 等级 | 结论 | 处置 |
|---|---|---|---|
| B1 牌背测试对旧背仍绿 | 阻断 | 成立 | 断言改 `R>=70/G>=100/|B-181|<=15`；`navy_back`→`royal_back` |
| B2 pendingScoreChanges 只有杠分 | 阻断 | 成立 | spec/plan 改称“杠分/临时分投影”；不称完整局分；测试用真实 delta |
| B3 牌面 colorize 过白 | 阻断 | 成立 | 改 `black(190,195,205)/mid(232,236,241)/white(240,244,250)`；实测 `[239,243,249]`、11 级 |
| H1 缺 ImageOps 导入 | 高 | 成立 | `from PIL import Image, ImageOps` |
| H2 dial CSS 仍 110 | 高 | 成立 | 显式 80×80 + box-sizing；源闸 |
| H3 四家 line-height/gap/padding | 高 | 成立 | cell 40、line-height 1、gap 0、padding 0；源闸 |
| H4 Board 伪代码标识符/ComputedRef | 高 | 成立 | 用 topSeat/leftSeat/rightSeat/me、props.view、null 守卫 |
| H5 移除 claim 后未用变量 | 高 | 成立 | 列出删除 `claimTile`/`MAHJONG_SUIT_NAMES`/`MAX_TING_TILES_WITH_CLAIM`/`claimLabel`/`extraTing`/`hasSide` |
| H6 精确块漏 leftZone/leftChip/ownMeld | 高 | 成立 | 补 116/101.9/569.2 |
| H7 矩阵 selfChip.right<=hand.left 未删 | 高 | 成立 | 删除，改 x/y 分离 |
| H8 ClaimTile 高度低估 | 高 | 成立 | 2 列网格（68/gap6/padding10）；面板约 275；浏览器量高 |
| H9 endedText 恒空 | 高 | 成立 | Board ended 传真实文案；Board 测试 |
| H10 四家测试只查文本 | 高 | 成立 | 源闸尺寸 + CDP 量高 |
| H11 缺代码审查关卡 | 高 | 成立 | 新增 Task 5 |
| H12 预览与过滤不一致 | 高 | 成立 | 优先 filteredOptions 非空 |
| H13 APK 工作树 vs tag | 高 | 成立 | 打包前工作区干净 + 版本断言 |
| L1 ClaimTile 闸位置 | 低 | 成立 | 移到 Task 4；文件列入 |
| L2 Center 旧 claim 用例清单 | 低 | 成立 | 逐条删除/新增 |
| L3 18/14px token | 低 | 成立 | 新增 `$ftl-font-mj-badge/mini` |
| L4 源闸误报 dial border | 低 | 成立 | 只查根 `.mj-center` 块；dial 单独断言 |
| L5 0.95W 只是上限 | 低 | 成立 | 加 1334×750 width=1256/s=1 |
| L6 公式自证 | 低 | 成立 | 源闸 + CDP 量高 |
| L7 layout 头注释 | 低 | 成立 | 同步 0.95W/新位置 |
| L8 体积数字 | 低 | 成立 | 改约 529KiB（实测） |
| L9 定向命令不生效 | 低 | 成立 | 改显式文件路径 |
| L10 缺计划审查记录/v1 状态/版本断言 | 低 | 成立 | 本节 + v1 状态已加注 + pack 后 grep |
| L11 Center strip 30→28 | 低 | 成立 | 显式 28 + 源闸 |
| L12 badge 单字符串双色 | 低 | 成立 | 拆 `dealer:boolean` + `badge:string` |
| L13 null seats/阈值 | 低 | 成立 | 删 null；`>=1_000_000` 走万 |
| L14 compact 文案 | 低 | 成立 | `牌墙 · 阶段 · 秒`；测试 |
| L15 预览测试只查出现 | 低 | 成立 | 断言 src 与 DOM 顺序 |
