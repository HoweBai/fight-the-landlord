# 川麻红金 v19：听牌贴手牌 + App 全屏（设计）

状态：已确认（2026-11-13，用户选听牌方案 A：贴手牌左端；APK 未全屏需修）。
范围：客户端布局（`mahjong-layout-v3.ts` 听牌 x）+ App 打包配置（`manifest.json` `app-plus.fullscreen`）+ 测试 + APK 0.1.14/114。
不动：听牌尺寸/2×5/标签文案、协议/服务端、其他布局元素。

## 0. 背景

1. **听牌位置不友好**：v15 起听牌行在 `x≈50.34`（最左边距），手牌从 `x≈146.23` 开始；听牌块离手牌/动作区都远，容易被忽略。用户选方案 A：贴手牌左端。
2. **安卓 APK 未全屏**：`manifest.json` 的 `app-plus` 只有 `screenOrientation`，没有 `fullscreen` ⇒ 系统状态栏（电量/时间）占一条。需 App 全屏配置并重打 APK。

## 0.1 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 听牌 `tingX = hand.rect.left`（base 146.23），y 不变（`ownRiverTop + (ownRiverH − tingH)/2`）；标签沿用 `ting.rect.left/top` 自动跟随 | 用户方案 A |
| D2 | 听牌尺寸/2×5/「听 N 张」文案与样式不变 | 范围 |
| D3 | 更新 v3 布局测试的全部 ting x 断言（50.34/90.74 → 146.23）；7 档 × 15 态 `checks` 仍必须为空；最坏态（上/下河 ≥17）听牌右缘 304.23 vs 左侧河 314.99 ⇒ 10.76px 间隙 | 开发方 |
| D4 | `manifest.json` `app-plus` 增加 `"fullscreen": true`（隐藏系统状态栏）；不加运行时 `plus.navigator` 兜底（先以 manifest 为准，真机无效再补） | 开发方 |
| D5 | 新增 manifest 源码闸（`landscape-canvas.test.ts` 的 JSONC 解析）：`app-plus.fullscreen === true` | 开发方 |
| D6 | APK 版本 **0.1.14/114**（versionCode 必须递增）；H5 只受听牌位置影响，fullscreen 仅 App | 用户要求合入 |
| D7 | 不改变听牌与手牌的层级/z-index；不新增动画/计时器 | 范围 |

## 1. 听牌位置

- `mahjong-layout-v3.ts`：`const tingX = hand.rect.left;`（原 `outer + leftZ.backW + gap + leftZ.meld.w + gap`）。
- base 1334×750：`tingX = 146.23`；`ting:9` → `(146.23, 511, 158, 92)`；`ting:5` → `(146.23, 534.5, 158, 45)`；`ting:1` → `(146.23, 534.5, 30, 45)`；heavy/mid 的 x 也恒为 146.23（y 仍随自家副露变：511/462.2）。
- 与自家河间隙：ownRiver.left 511.33 − (146.23+158)=**207.1**（≥180，I8 仍成立）。
- 与左侧河最坏间隙：leftRiver.left 314.99 − 304.23=**10.76**（17+ 张时；7×15 checks 必须仍为空）。
- 与手牌：ting bottom 603 vs hand top 630 ⇒ 27px；与自家座位牌（x12–76, y646–722）无交集；与左侧背/副露（x≤86.74）无交集。
- 听牌标签位置由 `layout.ting.rect.left/top − 18u` 计算，自动跟随，无需改 Board 模板。

## 2. App 全屏

- `apps/client/src/manifest.json` `app-plus` 增加：
  ```json
  "fullscreen" : true,
  ```
  （JSONC 风格与现有键一致。）
- 语义：App 启动即全屏、隐藏系统状态栏；H5 构建不受该键影响。
- 验证：
  - 源码闸：`landscape-canvas.test.ts` 的 manifest 用例断言 `app-plus.fullscreen === true`。
  - APK 产物：重打后解包检查 `assets/apps/__UNI__CE6765E/www/manifest.json` 的 `plus.fullscreen`（或 `app-plus.fullscreen`）为 true。
  - 真机：用户安卓安装 0.1.14/114 后确认顶部状态栏消失。
- 先不加 `plus.navigator.setFullscreen(true)` 运行时兜底（避免条件编译/类型面变动）；若个别 ROM 仍显示状态栏，再补。

## 3. 测试

- `apps/client/test/mahjong-layout-v3.test.ts`：
  - `ting 1/5/6/9` 的 x 全部改 146.23；heavy/mid 的 x 改 146.23（top 不变）；「x 不随上家弃牌变化」用例的 50.34 → 146.23。
  - 间隙用例：`ting.right < leftRiver.left` 仍断言；可补 `左右间隙 ≈10.76`（最坏态）。
  - 7 档 × 15 态 `checks === []` 原样。
- `apps/client/test/landscape-canvas.test.ts`：manifest 用例增 `fullscreen === true`。
- Board 测试：`tingLabelStyle` 用 layout 计算，无需改；如出现 50.34 字面量一并更新。
- 全量：`pnpm -C apps/client test/lint/build`。

## 4. 风险

- 听牌块右缘 304.23 与左侧河 314.99 仅 10.76px；若后续加宽听牌块/改左侧河，需重算并跑 `checks`。
- `fullscreen: true` 在个别 Android ROM 可能被系统栏策略覆盖；真机为准，必要时补运行时兜底。
- manifest 是 JSONC，改动需保持 HBuilderX 风格；用 `stripComments` 的源码闸解析。
- APK versionCode 必须从 113 升到 114；H5 与 APK 同版本号 0.1.14。
- 听牌对齐的是**手牌行左缘**而非首张牌左缘（13 张时首张距行左缘约 42.7px）；这是稳定且在视觉上仍属「手牌左端」的选择。

## 5. 涉及文件

- `apps/client/src/game/mahjong-layout-v3.ts`（tingX 一行）
- `apps/client/test/mahjong-layout-v3.test.ts`
- `apps/client/src/manifest.json`
- `apps/client/test/landscape-canvas.test.ts`
- `apps/client/test/mahjong-board.test.ts`（如含 50.34 字面量）
- 版本：`apps/client/src/manifest.json` 0.1.14/114

## 6. 审查记录

（待设计对抗审查后填写）
