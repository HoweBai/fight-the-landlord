# 川麻红金 v19：听牌贴手牌 + App 全屏（设计）

状态：已确认（2026-11-13，用户选听牌方案 A：贴手牌左端；APK 未全屏需修）；已过一轮对抗审查（见 §6）。
范围：客户端布局（`mahjong-layout-v3.ts` 听牌 x）+ App 全屏（`App.vue` 运行时 + `manifest.json` 声明 + `pack-apk.sh` 产物闸）+ 测试 + APK 0.1.14/114。
不动：听牌尺寸/2×5/标签样式、协议/服务端、其他布局元素。

## 0. 背景

1. **听牌位置不友好**：v15 起听牌行在 `x≈50.34`（最左边距），手牌行从 `x≈146.23` 开始；听牌块离手牌/动作区都远。用户选方案 A：贴手牌左端。
2. **安卓 APK 未全屏**：系统状态栏（电量/时间）占一条。`app-plus.fullscreen` **不是 uni-app 官方 manifest 键**（官方文档/5+ 运行时 manifest 均无；APK 产物证明 `app-plus.screenOrientation` 被提到根级、`app-plus.distribute` 被消费、并注入 `plus.statusbar`）⇒ 以**运行时全屏**为主，manifest 声明为辅。

## 0.1 决策表

| # | 决策 | 来源 |
|---|---|---|
| D1 | 听牌 `tingX = hand.left`（layoutBase 里的 Rect；base 146.23），y 不变；标签沿用 `ting.rect.left/top` 自动跟随 | 用户方案 A + 审查修正 |
| D2 | 听牌尺寸/2×5/「听 N 张」文案与样式不变 | 范围 |
| D3 | **I8 基线改写（v19 supersede v15）**：自家河 12 列时听牌右缘 304.23 vs ownRiver.left 432.99 ⇒ 间隙 **128.76**（旧值 184.25）。新基线 =「与自家河 **≥120px** 且不相交；与左侧河不相交（最坏 10.76px）」；补 12 列 fixture 与 10.76 必测；v15 spec §1.3/plan I8 行标注被 v19 supersede | 审查阻断 |
| D4 | `manifest.json` `app-plus` 增加 `"fullscreen": true`（声明式尝试；HBuilderX 可能忽略） | 开发方 |
| D5 | **运行时全屏为主**：`App.vue` `onLaunch`/`onShow` 调 `plus.navigator.setFullscreen(true)`（`#ifdef APP-PLUS` + `typeof plus` 守卫；`onShow` 覆盖广告/后台返回） | 审查高 |
| D6 | `pack-apk.sh` 产物闸：解包 APK 后断言 `assets/apps/__UNI__CE6765E/www/app-service.js` 含 `setFullscreen`（运行时全屏真的进包）；同时打印 `www/manifest.json` 的根级 `fullscreen`（若存在） | 审查高 |
| D7 | APK 版本 **0.1.14/114**（`versionCode` 是字符串 `"114"`）；H5 只受听牌位置影响，全屏仅 App | 用户要求合入 |
| D8 | 不新增动画/计时器；不改听牌层级/z-index；不改导航条（本次只承诺系统状态栏） | 范围 |

## 1. 听牌位置

- `mahjong-layout-v3.ts`：
  - `const tingX = hand.left;`（**不是** `hand.rect.left`；`hand` 在 layoutBase 是 Rect）。
  - 注释同步：原「侧副露 lane 右侧」删掉，改为「贴手牌行左缘」。
- base 1334×750：`tingX = 146.23`；`ting:1` → `(146.23, 534.5, 30, 45)`；`ting:5` → `(146.23, 534.5, 158, 45)`；`ting:9` → `(146.23, 511, 158, 92)`；heavy/mid 的 x 恒 146.23（y 仍 511/462.2）。
- 与自家河：8 列 ownRiver.left 511.33 ⇒ 间隙 **207.1**；12 列（self ≥17）432.99 ⇒ **128.76**（新基线 ≥120）。
- 与左侧河最坏：leftRiver.left 314.99 − 304.23 = **10.76**（必测；7×15 `checks` 仍为空）。
- 与手牌：ting bottom 603 vs hand top 630 ⇒ 27px；与座位牌（x12–76, y646–722）、左侧背（12–42）、左侧副露（46–86）无交集。
- 对齐语义：对齐手牌**行**左缘；13 张时首张牌距行左缘 **42.84px**（行宽 1041.54，内容 955.86），14 张时 ≈1px；稳定且视觉属「手牌左端」。
- 标签：`tingLabelStyle` 已用 `ting.rect`，自动跟随；样式（金边胶囊）不变。

## 2. App 全屏（运行时为主）

- `apps/client/src/App.vue`（Options API，JS）：
  ```js
  function enterFullscreen() {
    // #ifdef APP-PLUS
    try {
      const api = typeof plus !== 'undefined' ? plus : globalThis.plus;
      api?.navigator?.setFullscreen?.(true);
    } catch (err) {
      // 全屏失败不得阻断启动；真机仍可按系统行为显示状态栏
    }
    // #endif
  }

  export default {
    onLaunch() { enterFullscreen(); },
    onShow() { enterFullscreen(); },
    onError(err) { ... },
    onUnhandledRejection(res) { ... },
  };
  ```
  - `#ifdef APP-PLUS` 由 uni 编译器处理；`typeof plus` 守卫保证 H5/vitest 下不 ReferenceError。
  - `onShow` 覆盖：激励视频（Sigmob）播放结束/从后台回桌后重新全屏。
- `manifest.json` `app-plus` 增加 `"fullscreen" : true,`（声明式；JSONC 风格）。若 HBuilderX 忽略，不影响运行时兜底。
- **不做**：`plus.navigator.hideSystemNavigation()`（本次只承诺隐藏顶部系统状态栏；手势/三键导航条另议）。

## 3. 产物闸 / 验证

- `scripts/deploy/pack-apk.sh`：下载 APK 后（现有端点校验之后）加：
  ```bash
  if ! unzip -p "deploy/download/$APK_NAME" "assets/apps/__UNI__CE6765E/www/app-service.js" | grep -q "setFullscreen"; then
    echo "❌ [pack-apk] 产物 app-service.js 未包含 setFullscreen —— 全屏兜底没进包，拒绝继续" >&2
    exit 1
  fi
  echo "✅ [pack-apk] 运行时全屏已在包内"
  unzip -p "deploy/download/$APK_NAME" "assets/apps/__UNI__CE6765E/www/manifest.json" | grep -o '"fullscreen"[^,}]*' || true
  ```
- 真机（用户）：安装 0.1.14/114 → 顶部系统状态栏消失；看一次激励视频后仍隐藏；顶部无空白条（若 `safeArea.top/statusBarHeight` 残留导致空白，登记并按需在全屏态把 top inset 置 0）。
- H5：听牌位置变更随部署可见；fullscreen 不影响 H5。

## 4. 测试

### 4.1 布局 v3（精确清单）

- `apps/client/test/mahjong-layout-v3.test.ts`：
  - `ting 1/5/6/9` x：50.34 → **146.23**（:362/:367/:372/:377/:384）。
  - heavy/mid x：90.74 → **146.23**（:387/:391/:404）；y 不变（511/462.2）。
  - 「x 不随上家弃牌变化」：50.34 → **146.23**（:416）。
  - 2668×1500（u=2）：`ting.rect.left` **181.48 → 292.46**（:464）。
  - 用例标题（:382/:397）改成新语义；:397 标题改为「左侧副露不再影响听牌 x；与自家河/左侧河间隙」。
  - **新增必测**：`self: seat(17)`（12 列自家河）⇒ `ownRiver.left − ting.right ≈ 128.76`（≥120）且 `ting.right < leftRiver.left`；`overlayWorst` ⇒ `leftRiver.left − ting.right ≈ 10.76`。
  - **语义断言**：至少 3 个态断言 `l.ting.rect.left === l.rects.hand.left`（normal/heavy/mid）。
  - 7 档 × 15 态 `checks === []` 原样。
- `apps/client/test/mahjong-board.test.ts`：
  - `.mj__ting` 的 `left: 50.34px`（:808-809）→ **146.23px**；注释同步。
  - ⚠️ **不要改** `right: 50.34px` / `right: 90.74px`（:845-851/:865-870）——那是 v17 动作带右锚点，数值巧合。
- `apps/client/test/landscape-canvas.test.ts`：manifest 用例增 `app-plus.fullscreen === true`。
- App.vue 全屏：H5/vitest 下 `typeof plus === 'undefined'` 不报错；可加一个静态闸（App.vue 源码含 `setFullscreen` 与 `#ifdef APP-PLUS`）。

### 4.2 全量

`pnpm -C apps/client test/lint/build`；APK 重打后 `pack-apk.sh` 产物闸通过；真机验收。

## 5. 风险/边界

- I8 从 184–224px 变为 128.76px（产品取舍：用户选 A；v15 plan/spec 标注 supersede）。
- 听牌右缘 304.23 与左侧河 314.99 仅 10.76px；后续加宽听牌/改左侧河需重算 + `checks`。
- 全屏隐藏状态栏会改 `windowHeight`：`LandscapeStage` 按 `u=min(W/1334,H/750)` 重算，App 上整桌略放大；真机看顶栏/座位牌不裁。
- Android 的 `safeArea.top = statusBarHeight`：全屏后若运行时仍报旧值，`LandscapeStage` 的 top inset 可能留空白条；真机验收「顶部无空白条」，必要时全屏态把 top inset 置 0（另立小修）。
- `fullscreen` 只隐藏**状态栏**，不隐藏 Android 手势/三键导航条；本次不承诺。
- 激励视频（Sigmob）播放会切系统全屏状态；`onShow` 重设兜底，真机验收「看完广告后状态栏仍隐藏」。
- manifest 声明键可能被 HBuilderX 忽略；运行时兜底 + 产物闸是主判据。
- `versionCode` 字符串形态：`"114"`；pack-apk 打印 version，可选断言 `"code":"114"`。
- H5 听牌变更需部署测试服后真浏览器/真机确认；APK 必须重打才带听牌 + 全屏。

## 6. 涉及文件

- `apps/client/src/game/mahjong-layout-v3.ts`（tingX 一行 + 两处注释）
- `apps/client/test/mahjong-layout-v3.test.ts`
- `apps/client/src/App.vue`（onLaunch/onShow + enterFullscreen）
- `apps/client/src/manifest.json`（`fullscreen` + 版本 0.1.14/114）
- `apps/client/test/landscape-canvas.test.ts`
- `apps/client/test/mahjong-board.test.ts`（仅 `.mj__ting` 的 50.34）
- `scripts/deploy/pack-apk.sh`（产物闸）
- `docs/superpowers/specs/2026-11-08-mahjong-table-v15-design.md` / `docs/superpowers/plans/2026-11-08-mahjong-table-v15.md`（I8 标注 supersede）

## 7. 审查记录

2026-11-13 按 dev-process §3 做独立对抗审查（sonnet，含 uni-app/5+ manifest 文档与 APK 产物实测）：
- 阻断：新 x 使自家河 12 列时听牌间隙从 184.25 降到 128.76，违反 v15 I8「≥180」；旧 I8 用例 fixture 是 8 列（207.1）会假绿 ⇒ 已改基线 ≥120 + 加 12 列 fixture + 标注 v15 supersede。
- 高：① layoutBase 内 `hand` 是 Rect，`hand.rect.left` 不存在 ⇒ 改 `hand.left`；② `app-plus.fullscreen` 不是官方键、产物落点是根级/可能被丢弃 ⇒ 以运行时 `plus.navigator.setFullscreen(true)`（onLaunch/onShow）为主 + manifest 声明为辅 + pack-apk 产物闸；③ 测试迁移漏 2668×1500 的 181.48→292.46，且 Board 测试的 `50.34/90.74` 同时出现在 `.mj__ting` 与 v17 动作带右锚点 ⇒ 精确点名。
- 低：改用例标题/布局注释；10.76 升为必测；42.7→42.84；全屏 safeArea 空白条/导航条/广告后复现；versionCode 字符串；H5 部署验收；交接/记忆/v15 文档同步。
