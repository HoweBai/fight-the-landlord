# 川麻红金 v19：听牌贴手牌 + App 全屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 听牌块从最左边距移到手牌行左缘（`hand.left`）；安卓 App 运行时全屏（隐藏系统状态栏），并重打 APK 0.1.14/114。

**Architecture:** 客户端布局一行改动 + App 启动/回前台调用 `plus.navigator.setFullscreen(true)` + manifest 声明 + 打包产物闸。协议/服务端不动。

**Tech Stack:** uni-app（Vue 3/JS App 壳）/ Vitest / HBuilderX 云打包 / Bash。

## Global Constraints

- 听牌 `tingX = hand.left`（layoutBase 内 `hand` 是 Rect；**不要**写 `hand.rect.left`）；y/尺寸/标签样式不变。
- I8 新基线（v19 supersede v15）：12 列自家河间隙 **128.76 ≥120**；与左侧河最坏 **10.76** 必须不相交；7 档×15 态 `checks` 仍为空。
- 全屏以**运行时**为主：`App.vue` `onLaunch`/`onShow` 调 `plus.navigator.setFullscreen(true)`（`#ifdef APP-PLUS` + `typeof plus` 守卫）；manifest `app-plus.fullscreen: true` 仅声明式；`pack-apk.sh` 产物闸断言 `app-service.js` 含 `setFullscreen`。
- 版本 **0.1.14/114**（`versionName`/`versionCode` 都是字符串）。
- 不改听牌尺寸/2×5/标签样式；不改 v17 动作带右锚点（Board 测试里的 `right: 50.34/90.74` 不能动）。
- 每个 Task 先写失败测试，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 本片不推送/不部署；APK 重打与发布等用户裁决。

---

## Task 1: 听牌 x + App 全屏 + 测试 + 版本

**Files:**
- Modify: `apps/client/src/game/mahjong-layout-v3.ts`（tingX 一行 + 注释）
- Modify: `apps/client/test/mahjong-layout-v3.test.ts`
- Modify: `apps/client/src/App.vue`（onLaunch/onShow + enterFullscreen）
- Modify: `apps/client/src/manifest.json`（fullscreen + 0.1.14/114）
- Modify: `apps/client/test/landscape-canvas.test.ts`（manifest fullscreen 断言）
- Create: `apps/client/test/app-fullscreen.test.ts`（App.vue 静态闸）
- Modify: `apps/client/test/mahjong-board.test.ts`（仅 `.mj__ting` 的 50.34）
- Modify: `scripts/deploy/pack-apk.sh`（产物闸）
- Modify: `docs/superpowers/specs/2026-11-08-mahjong-table-v15-design.md` / `docs/superpowers/plans/2026-11-08-mahjong-table-v15.md`（I8 supersede 注）

**Interfaces:**
- Produces: `ting.rect.left === rects.hand.left`；App 全屏运行时；APK 版本 0.1.14/114；打包闸。

- [x] **Step 1: 先改测试（RED）**

1.1 `mahjong-layout-v3.test.ts`：
- `50.34` → `146.23`（按字面量替换 6 处：:362/:367/:372/:377/:384/:415）。
- `90.74` → `146.23`（:387/:391/:404）。
- `181.48` → `292.46`（:464，2668×1500）。
- 标题（:382/:397）改为新语义：:382「normal + ting:9 → (146.23, 511, 158, 92)；heavy/mid x=146.23」；:397「左侧副露不再影响听牌 x；与自家河/左侧河间隙」。
- 原间隙用例（:397-409）保留 8 列 fixture，并追加：
```ts
it('听牌贴手牌行左缘；12 列自家河间隙 ≥120；左侧河最坏 10.76', () => {
  const normal = mahjongTableLayoutV3(1334, 750, input({ ting: 9 }));
  expect(normal.ting.rect.left).toBe(normal.rects.hand.left);

  const wide = mahjongTableLayoutV3(
    1334,
    750,
    input({ top: seat(8), left: seat(8), self: seat(17), ting: 9 }),
  );
  const gap12 = wide.rects.ownRiver.left - (wide.ting.rect.left + wide.ting.rect.width);
  expect(gap12).toBeCloseTo(128.76, 1);
  expect(gap12).toBeGreaterThanOrEqual(120);
  expect(wide.ting.rect.left + wide.ting.rect.width).toBeLessThan(wide.rects.leftRiver.left);

  const worst = mahjongTableLayoutV3(1334, 750, STATES.overlayWorst);
  const gapLeft = worst.rects.leftRiver.left - (worst.ting.rect.left + worst.ting.rect.width);
  expect(gapLeft).toBeCloseTo(10.76, 1);

  const mid = mahjongTableLayoutV3(1334, 750, STATES.mid);
  expect(mid.ting.rect.left).toBe(mid.rects.hand.left);

  const heavy = mahjongTableLayoutV3(1334, 750, STATES.heavy);
  expect(heavy.ting.rect.left).toBe(heavy.rects.hand.left);
});
```
1.2 `mahjong-board.test.ts`：`.mj__ting` 的注释（:808 `// v3 ting.rect = (50.34, ...)`）与断言（:809 `left: 50.34px`）一起改为 146.23；**不要动** `right: 50.34px`/`right: 90.74px`（动作带）。
1.3 `landscape-canvas.test.ts` manifest 用例：解析类型加 `fullscreen?: boolean`，断言 `expect(m['app-plus']?.fullscreen, 'App 全屏').toBe(true)`。
1.4 新建 `apps/client/test/app-fullscreen.test.ts`：
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('src/App.vue', 'utf8');

describe('App 全屏（运行时兜底）', () => {
  it('APP-PLUS 下 onLaunch/onShow 调 plus.navigator.setFullscreen(true)', () => {
    expect(app).toContain('#ifdef APP-PLUS');
    expect(app).toContain('setFullscreen?.(true)');
    expect(app).toContain("typeof plus !== 'undefined'");
    // 接线闸（防「定义了 enterFullscreen 但没接」死代码）
    expect(app).toMatch(/onLaunch\(\)\s*\{\s*enterFullscreen\(\)/);
    expect(app).toMatch(/onShow\(\)\s*\{\s*enterFullscreen\(\)/);
  });
});
```

Run: `pnpm -C apps/client exec vitest run test/mahjong-layout-v3.test.ts test/mahjong-board.test.ts test/landscape-canvas.test.ts test/app-fullscreen.test.ts`
Expected: FAIL（布局/清单/App 未改）。

- [x] **Step 2: 实现**

2.1 `mahjong-layout-v3.ts`：
```ts
const tingX = hand.left;
```
注释（:10/:664）改为「贴手牌行左缘（v19）」。
2.2 `App.vue` 增加：
```js
/** 全屏兜底：manifest 的 fullscreen 非 uni-app 官方键（HBuilderX 可能丢弃）⇒ 运行时设置。 */
function enterFullscreen() {
  // #ifdef APP-PLUS
  try {
    const api = typeof plus !== 'undefined' ? plus : globalThis.plus;
    api?.navigator?.setFullscreen?.(true);
  } catch (err) {
    // 全屏失败不得阻断启动
  }
  // #endif
}
```
并在 `export default` 加：
```js
  onLaunch() {
    enterFullscreen();
  },
  onShow() {
    enterFullscreen();
  },
```
2.3 `manifest.json`：`app-plus` 加 `"fullscreen" : true,`；`versionName` 0.1.14、`versionCode` `"114"`。
2.4 `pack-apk.sh`：在端点校验之后加：
```bash
HITS="$(unzip -p "deploy/download/$APK_NAME" "assets/apps/__UNI__CE6765E/www/app-service.js" | grep -c "setFullscreen" || true)"
if [ "${HITS:-0}" -lt 1 ]; then
  printf '❌ [pack-apk] 产物 app-service.js 未包含 setFullscreen —— 全屏兜底没进包，拒绝继续\n' >&2
  exit 1
fi
printf '✅ [pack-apk] 运行时全屏已在包内\n'
unzip -p "deploy/download/$APK_NAME" "assets/apps/__UNI__CE6765E/www/manifest.json" | grep -o '"fullscreen"[^,}]*' || true
```
2.5 v15 spec §1.3（位置公式 bullet + ≥180 bullet 两处）/ plan I8 行加注：
`（v19 2026-11-13 起听牌贴手牌行左缘：12 列自家河间隙 128.76 ≥120；与左侧河最坏 10.76px 不相交；本行/本 bullet 基线以 v19 spec 为准。）`

Run: `pnpm -C apps/client exec vitest run test/mahjong-layout-v3.test.ts test/mahjong-board.test.ts test/landscape-canvas.test.ts test/app-fullscreen.test.ts` → PASS；`pnpm -C apps/client lint` → exit 0。

- [x] **Step 3: 提交**

```bash
git add apps/client/src/game/mahjong-layout-v3.ts apps/client/test/mahjong-layout-v3.test.ts apps/client/src/App.vue apps/client/src/manifest.json apps/client/test/landscape-canvas.test.ts apps/client/test/app-fullscreen.test.ts apps/client/test/mahjong-board.test.ts scripts/deploy/pack-apk.sh docs/superpowers/specs/2026-11-08-mahjong-table-v15-design.md docs/superpowers/plans/2026-11-08-mahjong-table-v15.md
git commit -m "feat(mahjong): 听牌贴手牌左缘 + App 运行时全屏（0.1.14/114）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 全量验证 + APK 0.1.14/114 + 交接

**Files:**
- Create: `docs/superpowers/plans/2026-11-13-mahjong-ting-position-fullscreen-handoff.md`

- [x] **Step 1: 全量验证**

```bash
pnpm -C apps/client test
pnpm -C apps/client lint
pnpm -C apps/client build
pnpm verify:apk
```
Expected: 全绿（记录计数）。

- [x] **Step 2: APK 打包 + 产物闸**

```bash
bash scripts/deploy/pack-apk.sh ssh.yobeeo.com
```
Expected: 版本 `0.1.14/114`（产物断言 `"code":"114"`）；`app-service.js` 含 `setFullscreen`；产物闸通过；记录 size/sha256（`sha256sum deploy/download/ubigame.apk`）。
（发布 Release/preview 待用户裁决；本 Task 只打包并报告。）

- [x] **Step 3: 交接**

`docs/superpowers/plans/2026-11-13-mahjong-ting-position-fullscreen-handoff.md`：
- 状态：v19 已实现（Task 1 提交 + 本 Task）；全量结果；APK 0.1.14/114 产物路径/sha256；**未推送/未部署/未发布 APK**。
- 改动：听牌 x=hand.left（I8 新基线 128.76）；App 运行时全屏（onLaunch/onShow）+ manifest 声明 + pack-apk 产物闸。
- 审查：spec §7（1 阻断 + 3 高 + 低）；计划审查记录。
- 风险/真机验收：状态栏消失、广告后仍隐藏、顶部无空白条（safeArea 残留）、导航条不隐藏（不承诺）。
- 回滚：代码 revert；APK 旧版 0.1.13/113。
- 收尾：`git status`（HBuilderX 可能回写 manifest）、`pnpm verify:apk` 结果、sha256、v15 记忆/文档同步。
- 下一步（用户裁决）：推送 dev → 部署测试服（H5 听牌变更）→ 发布 APK 0.1.14/114（Release+edge）→ 真机验收。

- [x] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-11-13-mahjong-ting-position-fullscreen-handoff.md
git commit -m "docs(mahjong): v19 听牌贴手牌 + App 全屏实现交接" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- Spec coverage：D1–D8 全部有落点（x、I8 新基线、运行时全屏、manifest、产物闸、版本、测试、交付）。
- Type consistency：`hand.left`（Rect）与输出 `hand.rect` 区分；`plus` 仅 App；`ting.rect.left === rects.hand.left` 语义断言。
- Placeholder scan：无 TBD/TODO；关键代码/测试给全。
- 已知风险：全屏 safeArea 空白条/导航条/广告；APK 真机验收待用户。

## 计划审查记录

2026-11-13 独立对抗审查（sonnet，只读）：核对 `hand`/`tr()` 语义、全部 50.34/90.74/181.48 出现点、7×15 `checks`、Board `.mj__ting` 与 v17 右锚点区别、App.vue Options API/`#ifdef`/`typeof plus`、manifest 构建产物形态、`pack-apk.sh` 端点校验与 unzip/minify、v15 spec/plan 插入点。结论：**可开工**，无阻断/高；10 条低风险已修订：
- 50.34 行号 :416 → :415，并写明按字面量替换 6 处；
- 语义等值补 heavy 态（normal/heavy/mid）；
- 12 列 fixture 补 `left: seat(8)`；
- pack-apk 闸改 `grep -c`（避 SIGPIPE 误红）+ 产物 manifest 根级 fullscreen 诊断打印；
- 全量验证加 `pnpm verify:apk`，产物版本断言 `"code":"114"`、记录 sha256；
- 静态闸补 `onLaunch/onShow` 接线正则（防死代码）；
- v15 supersede 注覆盖 §1.3 两个 bullet 并写 10.76；
- 交接补 git status/verify:apk/sha256/记忆同步；
- Board 注释 :808 显式同步。
修订后可开工。
