# 牌桌与结算精修（片②）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把牌桌按参考图一精修（三档牌面 / 四区布局 / 数字徽章 / 素材槽）、把结算按参考图二重排成四列表格 —— 纯客户端，不动协议。

**Architecture:** 沿用**甲方案 · 就地精修 + 素材槽**（spec §1 路线，承 2026-09-17 spec §7 裁决 1「用已授权素材 + 保留全部机械闸」）。保留全部组件的 props 契约与 class 锚点，重写的是**几何与样式层**；每个装饰件留一个「CSS 兜底 + 可选贴图」的素材槽（令牌连 `url()` 一起存、缺省 `none`）。手牌重叠从固定值改成**按张数的纯函数**。

**Tech Stack:** TypeScript 5.7 · Vue 3 + uni-app（H5 + App）· vitest + jsdom · pnpm + turbo · 无 npm 依赖（测量工具走 CDP）

**Spec:** `docs/superpowers/specs/2026-09-21-table-settlement-refine-design.md`（v1，R724–R743，已过三轮审查）

**参考图（只读，gitignored）：** `.tmp_ref/fig1-table.png` · `.tmp_ref/fig2-settlement.png`（均 1936×1087）

---

## Global Constraints

> 逐字取自 spec §1.1（R743）。适用于**每一个** task。

1. **范围 = H5 + App**（R701）。小程序端排除在**一切设计/开发/测试**之外。
2. **锚点零改动**：9 个探针 class 一个不改；**`scripts/browser-e2e.mjs` 本片零改动**（首次改动在片③）。
3. **判据只增不减**：下面 8 个文件的字面 `it(`/`it.each(` 计数基线 **65**（63 + 2），逐文件核对：

   | 文件 | `it(` | `it.each(` | 小计 |
   |---|---|---|---|
   | `auth-flow` | 10 | 0 | 10 |
   | `auth-ui-wiring` | 13 | 0 | 13 |
   | `lobby-ux` | 18 | 0 | 18 |
   | `ui-flow` | 1 | 0 | 1 |
   | `table-bid-ui` | 6 | 1 | 7 |
   | `table-play-ui` | 8 | 0 | 8 |
   | `table-ended-ui` | 3 | 0 | 3 |
   | `table-settlement-ui` | 4 | 1 | 5 |
   | **合计** | **63** | **2** | **65** |

   ⚠️ `table-hud` / `table-seat-geometry` / `card-hand-interaction` / `settlement-rematch` **不在**这 8 个之内
   —— 它们有自己的判据，但**不计入 65**。**这 8 个文件名不许用「N 个契约测试」指代**（spec §1.3 的教训）。

4. **样式只用令牌**（`src/uni.scss` 的 `$ftl-*`）；单位是 `px`（R711）；发丝线一律 `$ftl-hairline`（R714），**全仓不得出现裸 `1px`**。
5. **`uni.xxx()` 必须是直接成员调用**；**不得用 `document` / `window` / `fetch`**；不得 `typeof import.meta`。
6. **scoped 样式只到子组件根节点**：抽进子组件的元素**必须自持样式**（闸：`table-bid-bottom` 的「渲染 `class="btn"` 的组件必须自己 `@include ftl-btn`」）。⚠️ **Task 4 新增顶栏三个占位按钮时是高发点**。
7. **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 静默返回 `[]`）。
8. **`mount()` 看不见样式** ⇒ 观感类改动只能用**产物 CSS / 真浏览器走查**证明，**不要造假判据**。
9. **门禁口径**：`turbo run build --force` 对 client **只出 h5** ⇒ App 必须单独跑 `build:app`（R669）；探针**独占**跑（`kill -TERM -<pgid>`，**禁止** `pkill -f vite`）。
10. **证据卫生（R682）**：门禁日志的 mtime 必须**晚于**最后一次改动/commit。
11. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

### 不许破坏的锚点（每条都实测过）

**探针 9 个（`scripts/browser-e2e.mjs`，实测恰 9 个）**：
`.login__actions .btn` · `.login__field input` · `.lobby__match .btn` · `.table__bar .btn`（**按文本 `返回大厅` 匹配**）·
`.table__bid-grab` · `.table__pass` · `.table__play` · `.table__me .card` · `.table__notice`

**测试锚点（不在探针里，但被断言钉着）**：
`.table__me-head .seat__timer`（4 处）· `.table__me .card`（必须只数得到手牌，R660）· `.seat--active` ·
`.seat__badge` · `.seat__count` / `.seat__count--warn` · `.seat__avatar-img` · `.seat__countdown-fill` ·
`.card--back` / `.card--wide` / `.card--selected` · `.hud__item--room`（文本 `房间 R1`）·
`.table__ended` · 15 个 `.settlement__*` · `.table__bid-pass`

⚠️ **顶栏三条（Task 4 的高发点）**：`.table__bar` 必须仍含**「返回大厅」「已结束」**（`table-ended-ui:103-105` 读 `.table__bar` 的文本）。

### 共享验证命令

```bash
# 客户端类型检查（含 .vue）
pnpm --filter @fight-the-landlord/client lint
# 客户端单测
pnpm --filter @fight-the-landlord/client test
# 单文件
pnpm --filter @fight-the-landlord/client test -- table-seat-geometry
# 逐端构建（turbo build 只出 h5）
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
# 真浏览器探针（独占）
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
# 全仓收口
pnpm run ci
```

> ⚠️ **本机探针的三条绕法**（缺一条就跑不起来）：自己起 `pnpm dev:h5` + `--no-server`；
> 设 `CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'`；
> **`--cdp-port 18800`**（默认的 9333 与文档建议的 9444 都落在 Windows 保留区间，会 `WSAEACCES`）。
> ⚠️ **收尾按 PID 杀整棵树**（`taskkill //F //PID <5173 的 PID> //T`），**不要**杀 pnpm 包装（片① F5）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `scripts/measure-table.mjs` | **新增**。借 `--keep-open` 留下的 chromium 量真牌桌几何（不改探针） | Task 1 |
| `apps/client/src/composables/handLayout.ts` | **新增**。手牌重叠的**纯函数**（`handOverlap`） | Task 2 |
| `apps/client/test/hand-layout.test.ts` | **新增**。纯函数单测（n=1..20） | Task 2 |
| `apps/client/src/uni.scss` | **改**。三档牌面令牌 + 六个素材槽令牌 + 分区尺寸 | Task 2 |
| `apps/client/src/components/Card.vue` | **改**。`size` 两档 → 三档 | Task 2 |
| `apps/client/test/card-hand-interaction.test.ts` | **改**。U1 算账按新值重算 | Task 2 |
| `apps/client/src/components/Seat.vue` | **改**。数字徽章 / 头像环 / 货币位 / 倒计时 | Task 3 |
| `apps/client/test/table-seat-geometry.test.ts` | **改**。牌背扇判据**成对迁移** | Task 3 |
| `apps/client/src/components/Hand.vue` | **改**。接 `fitWidth`，把重叠算成 CSS 变量 | Task 4 |
| `apps/client/src/pages/table/table.vue` | **改**。四区重排 + 顶栏 + 动作条叠放 | Task 4 |
| `apps/client/src/components/TableHud.vue` | **改**。迁进底部信息条 | Task 5 |
| `apps/client/src/components/PlayArea.vue` | **改**。摆到出牌者一侧 | Task 5 |
| `apps/client/src/components/BottomCards.vue` | **改**。降档 + 搬到顶栏 | Task 5 |
| `apps/client/src/components/Settlement.vue` | **改**。四列表格 | Task 6 |
| `apps/client/test/table-settlement-ui.test.ts` | **改**。精确文本断言**成对迁移** | Task 6 |

---

## Task 1: 测量工具（F9 前置 —— 先证明量得到）

**Files:**
- Create: `scripts/measure-table.mjs`
- Test: 无（它自己就是工具；它的「判据」是**跑通并报出真 rect**）

**Interfaces:**
- Produces: 一个可复用命令 `node scripts/measure-table.mjs --cdp-port 18800 --selector .table__mid`，
  输出 JSON `{selector, x, y, w, h}`

**背景（为什么这么做）：** 片① 的一次性测量脚本走不通撮合（spec §8 F9，**差异未查明**，本片不销案）。
本 Task **不解释那次失败**，只**构造出一个能用的**：借探针自己的 `--keep-open` 留活 chromium 与 dev server，
再挂第二个 CDP 客户端上去量。[`finish():695`](scripts/browser-e2e.mjs#L695) 与
[`process.on('exit'):701`](scripts/browser-e2e.mjs#L701) 都在 `KEEP_OPEN` 时跳过 `shutdownSync()`。

---

- [ ] **Step 1: 确认基线是绿的**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿（约 482 passed + 2 skipped）。**若这里就是红的，先停下来修基线。**

- [ ] **Step 2: 起 dev server（后台）**

```bash
cd /d/Code/pokergame/apps/client && pnpm dev:h5 > /tmp/ftl-dev.log 2>&1 &
sleep 12
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/
```

Expected: `200`。若为 `000`，看 `/tmp/ftl-dev.log`。

- [ ] **Step 3: 后台跑探针并留活（`--keep-open`）**

```bash
cd /d/Code/pokergame
export CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
node scripts/browser-e2e.mjs --no-server --keep-open --cdp-port 18800 --scenario gate \
  > /tmp/ftl-probe.log 2>&1 &
sleep 150
grep -E "判据 [0-9]+/[0-9]+ 通过" /tmp/ftl-probe.log || tail -5 /tmp/ftl-probe.log
```

Expected: `判据 16/16 通过`。**探针进程此时不退出**（`--keep-open`）—— 这是**要的**，不是故障。

- [ ] **Step 4: 确认 chromium 还活着、且停在牌桌上**

```bash
node -e "
fetch('http://127.0.0.1:18800/json/list').then(r=>r.json()).then(l=>{
  const p=l.find(t=>t.type==='page');
  console.log('page url:', p?.url);
});"
```

Expected: 打印一个 `http://localhost:5173/...` 的 URL（**不是** `about:blank`）。

- [ ] **Step 5: 写测量脚本**

创建 `scripts/measure-table.mjs`：

```js
#!/usr/bin/env node
/**
 * 牌桌几何测量（片② spec §5.1 / R741 / R742）。
 *
 * ## 为什么不是「探针的一个新 scenario」
 *
 * 片② 的全局约束 2 是「`scripts/browser-e2e.mjs` **本片零改动**」（它的首次改动留给片③）。
 * 所以本工具**独立于探针**，只**借**探针留下的东西：
 *   · `--keep-open` 让 chromium 与 dev server 不被回收（见探针 finish() / process.on('exit')）；
 *   · gate / minimal 两个 scenario 的**末态恰停在真牌桌**上（17 张真手牌）。
 *
 * ## 用法
 *
 *   # 1) 另开一个终端，后台跑探针并留活：
 *   node scripts/browser-e2e.mjs --no-server --keep-open --cdp-port 18800 --scenario gate
 *   # 2) 再跑本工具量：
 *   node scripts/measure-table.mjs --cdp-port 18800 --selector .table__mid
 *   node scripts/measure-table.mjs --cdp-port 18800 --dump      # 一次量一整套
 *
 * ## 它**不是**判据
 *
 * 它只**报数**。观感是否像参考图仍然只能人眼判定（spec §1.1-8：不造假判据）。
 * 它的价值是让「改完到底变成多少」有一个**可复现**的读数 —— 片① F9 缺的正是这个。
 */
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CDP_PORT = Number(opt('cdp-port', '18800'));
const SELECTOR = opt('selector', '');
const DUMP = argv.includes('--dump');

/** 一次量一整套（片② 关心的全部区域）。缺的元素返回 null，**不算错**（阶段不同元素不同）。 */
const DUMP_SELECTORS = [
  '.canvas',
  '.table__bar',
  '.table__mid',
  '.table__me',
  '.table__me .hand',
  '.table__me .card',
  '.table__actions',
  '.table__hud',
  '.seat--opponent',
  '.seat__avatar',
  '.seat__count',
  '.table__bottom-slot',
  '.table__play-area',
];

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('about:'));
  if (!page) throw new Error('没有可用的 page target（探针是否带着 --keep-open 还在跑？）');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP websocket 连不上')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      pending.set(id, { resolve, reject });
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} 超时`))), 15000);
    });
  return { send, close: () => ws.close() };
}

/** 页面侧：量一个元素的 rect（画布坐标 + 屏幕坐标都给，便于和参考图换算）。 */
const rectExpr = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const canvas = document.querySelector('.canvas');
  const k = canvas ? canvas.getBoundingClientRect().width / 1334 : 1;
  return {
    selector: ${JSON.stringify(selector)},
    screen: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    canvas: { x: +(r.x / k).toFixed(1), y: +(r.y / k).toFixed(1),
              w: +(r.width / k).toFixed(1), h: +(r.height / k).toFixed(1) },
    k: +k.toFixed(4),
    count: document.querySelectorAll(${JSON.stringify(selector)}).length,
  };
})()`;

async function measure(cdp, selectors) {
  const out = [];
  for (const sel of selectors) {
    const r = await cdp.send('Runtime.evaluate', { expression: rectExpr(sel), returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面求值抛错：${r.exceptionDetails.text}`);
    out.push(r.result.value);
  }
  return out;
}

const cdp = await connect(CDP_PORT);
const selectors = DUMP ? DUMP_SELECTORS : [SELECTOR];
if (!DUMP && !SELECTOR) {
  console.error('用法：node scripts/measure-table.mjs --cdp-port 18800 (--selector .table__mid | --dump)');
  process.exit(2);
}
const rows = await measure(cdp, selectors);
console.log(`k = ${rows.find((r) => r?.k)?.k ?? '?'}（画布缩放比）\n`);
for (const r of rows) {
  if (!r) {
    console.log(`   (缺) ${selectors[rows.indexOf(r)]}`);
    continue;
  }
  console.log(
    `${r.selector.padEnd(24)} count=${String(r.count).padStart(3)}  ` +
      `screen ${String(r.screen.x).padStart(5)},${String(r.screen.y).padStart(4)} ` +
      `${String(r.screen.w).padStart(5)}x${String(r.screen.h).padStart(4)}   ` +
      `canvas ${String(r.canvas.x).padStart(6)},${String(r.canvas.y).padStart(5)} ` +
      `${String(r.canvas.w).padStart(6)}x${String(r.canvas.h).padStart(5)}`,
  );
}
cdp.close();
process.exit(0);
```

- [ ] **Step 6: 跑它 —— 这是本 Task 唯一的判据**

```bash
cd /d/Code/pokergame
node scripts/measure-table.mjs --cdp-port 18800 --dump
```

Expected: **报出至少 10 行 rect**，其中 `.table__me .card` 的 `count` ≥ 17，且 `k` 打印出一个 0<k<3 的数。

⚠️ **若报 0 行 / 报 `(缺)` / 连不上** ⇒ **停下来修**，不要往下走。
**这一条就是片① F9 缺的东西**：一个能拿到真牌桌几何的读数。修不好就**停下来问**，**不要**给它编解释。

- [ ] **Step 7: 记下基线几何（写进本计划的 Task 7 收口）**

把 Step 6 的输出**原样贴进 Task 7 的收口记录**（改之前的值）。这是「改完有没有变、变了多少」的唯一对照物。

- [ ] **Step 8: 收尾（按 PID 杀整棵树）**

```bash
cd /d/Code/pokergame
# 注意：--keep-open 让探针与 chromium 留活；本 Task 结束后要清掉
PID=$(netstat -ano | grep ':5173 ' | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill //F //PID "$PID" //T
PID2=$(netstat -ano | grep ':18800 ' | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID2" ] && taskkill //F //PID "$PID2" //T
```

Expected: 5173 与 18800 都不再 LISTENING。

- [ ] **Step 9: Commit**

```bash
git add scripts/measure-table.mjs
git commit -F - <<'MSG'
feat(tools): 牌桌几何测量工具（片② Task 1 / R742）

借探针 --keep-open 留下的 chromium + dev server 量真牌桌几何，探针零改动。
片① F9 留下的「脚本走不通撮合、差异未查明」本工具不解释、只绕开：
探针的 gate/minimal 末态恰停在真牌桌 17 张手牌上，而 finish() 与 process.on('exit')
都在 KEEP_OPEN 时跳过 shutdownSync() ⇒ chromium 与 dev server 留活。

实测已量到（本 Task Step 6 的输出为准），这是后续 Task 改布局的对照基线。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 2: 令牌 + 三档牌面 + 手牌重叠纯函数 + 重算既有判据

> ⚠️ **本 Task 刻意把三件事压在**同一次**改动里**（spec §8.1）：令牌 / `Card.vue` 第三档 / 既有判据重算。
> 拆开做会让判据在中间态变红，且红的原因指向错误的地方。

**Files:**
- Create: `apps/client/src/composables/handLayout.ts`
- Create: `apps/client/test/hand-layout.test.ts`
- Modify: `apps/client/src/uni.scss`
- Modify: `apps/client/src/components/Card.vue`
- Modify: `apps/client/test/card-hand-interaction.test.ts:535-579`

**Interfaces:**
- Produces:
  - `handOverlap(count: number, rowWidth: number, cardW: number, baseOverlap: number): number`
  - 令牌：`$ftl-card-w: 155px` · `$ftl-card-h: 202px` · `$ftl-card-overlap: 89px`
    · `$ftl-card-mid-w: 90px` · `$ftl-card-mid-h: 117px`
    · `$ftl-card-w-small: 40px` · `$ftl-card-h-small: 52px`
  - `Card.vue` 的 `size`: `'normal' | 'mid' | 'small'`

---

- [ ] **Step 1: 先按特征搜全「用正则解析令牌真值」的判据（spec §5.4 / 片① F2 的教训）**

```bash
cd /d/Code/pokergame
grep -rn "ftl-card" apps/client/test/*.ts apps/client/src/ | grep -v node_modules
grep -rn "rpx" apps/client/test/*.ts | grep -v "^\s*\*" | grep -v "//"
```

**把输出抄进本 Task 的提交信息**。Expected: 至少命中
`card-hand-interaction.test.ts`（U1 算账的 `token()`）、`table-seat-geometry.test.ts`（`fontPx()`，只读 font 档，本 Task 不动）。

- [ ] **Step 2: 写失败的纯函数测试**

创建 `apps/client/test/hand-layout.test.ts`：

```ts
/**
 * 手牌重叠的**纯函数**（spec §3.3 / R732）。
 *
 * ⚠️ **判据射程（诚实版）**：这里证明的是「给定张数与行宽，算出的重叠是对的」，
 * **不证明**「按这个重叠排出来好看」。后者只能由真浏览器走查（spec §1.1-8）。
 *
 * ⚠️ **为什么是纯函数**：片② 没有设备实验室，「20 张也永远单行」这件事唯一的机械验证手段。
 */
import { describe, expect, it } from 'vitest';
import { handOverlap } from '../src/composables/handLayout';

/** 与 `/d/Code` 实测一致的一组真值（spec §3.2 / §3.3）。 */
const W = 155; // $ftl-card-w
const BASE = 89; // $ftl-card-overlap（参考形态：净露 42.6%，pitch 66）
const ROW = 1294; // 画布 1334 − .table 两侧 12 − .table__me 两侧 8

/** 一行牌的实际宽度。 */
const rowWidthOf = (count: number, overlap: number): number => W + (count - 1) * (W - overlap);

describe('§3.3 手牌重叠：按张数算，恒单行', () => {
  it('17 张走**参考形态**（不压缩）', () => {
    expect(handOverlap(17, ROW, W, BASE)).toBe(BASE);
    expect(rowWidthOf(17, BASE)).toBeLessThanOrEqual(ROW);
  });

  it('20 张（地主）**必须压缩**才能单行', () => {
    const ov = handOverlap(20, ROW, W, BASE);
    expect(ov, '20 张按参考重叠放不下 ⇒ 必须压').toBeGreaterThan(BASE);
    expect(rowWidthOf(20, ov), '压缩后必须 ≤ 行宽').toBeLessThanOrEqual(ROW);
  });

  it('n=1..20 恒单行、且重叠不倒退（单调）', () => {
    let prev = 0;
    for (let n = 1; n <= 20; n += 1) {
      const ov = handOverlap(n, ROW, W, BASE);
      expect(rowWidthOf(n, ov), `n=${n} 必须单行`).toBeLessThanOrEqual(ROW);
      expect(ov, `n=${n} 重叠不得为负`).toBeGreaterThanOrEqual(0);
      expect(ov, `n=${n} 重叠不得小于参考值`).toBeGreaterThanOrEqual(BASE);
      expect(ov, `n=${n} 重叠不得倒退`).toBeGreaterThanOrEqual(prev);
      prev = ov;
    }
  });

  it('n≤1 不参与计算（不产生 NaN / 负值）', () => {
    expect(handOverlap(0, ROW, W, BASE)).toBe(BASE);
    expect(handOverlap(1, ROW, W, BASE)).toBe(BASE);
  });

  it('判别力自证：把参考重叠调小 ⇒ 17 张也该开始压（证明上面不是「怎么填都过」）', () => {
    const tiny = 10;
    expect(handOverlap(17, ROW, W, tiny)).toBeGreaterThan(tiny);
  });
});
```

- [ ] **Step 3: 跑测试，确认它红**

```bash
pnpm --filter @fight-the-landlord/client test -- hand-layout
```

Expected: FAIL —— `Failed to resolve import "../src/composables/handLayout"`。

- [ ] **Step 4: 写实现**

创建 `apps/client/src/composables/handLayout.ts`：

```ts
/**
 * 手牌排布（spec §3.3 / R732）。
 *
 * 参考图实测：手牌行 1748 原图 px（画布 1204）、每张可见宽 95.5（画布 65.8）、
 * 牌全宽 225（画布 155）、净露率 42.4%。换算到画布：pitch 65.8 ⇒ 重叠 155 − 65.8 = 89.2。
 *
 * ⚠️ **为什么不能是固定值**：地主拿满 20 张时，按参考 pitch 要
 * `155 + 19 × 66 = 1409 > 1294`（可用宽）⇒ **放不下**。片① 的后果是 `flex-wrap` 换行，
 * 而换行会让整行高度翻倍、把顶部顶出去。
 * ⇒ 重叠**随张数涨**，永远单行。
 *
 * ⚠️ **不引入时钟、不读 DOM**：纯函数，输入确定 ⇒ 输出确定（这是它可被单测的前提）。
 */

/**
 * 相邻两张牌的重叠量（px）。
 *
 * @param count       手牌张数
 * @param rowWidth    可用行宽（画布 px）
 * @param cardW       牌全宽（画布 px）
 * @param baseOverlap **参考形态**的重叠（画布 px）；张数少时用它，不无谓压牌
 * @returns 实际重叠；`count <= 1` 时恒为 `baseOverlap`
 *
 * 推导：pitch = min(basePitch, (rowWidth − cardW) / (count − 1))，而 overlap = cardW − pitch
 * ⇒ overlap = max(baseOverlap, cardW − (rowWidth − cardW) / (count − 1))
 */
export function handOverlap(count: number, rowWidth: number, cardW: number, baseOverlap: number): number {
  if (count <= 1) return baseOverlap;
  const needed = cardW - (rowWidth - cardW) / (count - 1);
  return Math.max(baseOverlap, needed);
}
```

- [ ] **Step 5: 跑测试，确认它绿**

```bash
pnpm --filter @fight-the-landlord/client test -- hand-layout
```

Expected: PASS（5 passed）。

- [ ] **Step 6: 改令牌（三档牌面 + 六个素材槽 + 分区尺寸）**

改 `apps/client/src/uni.scss`。把「牌面尺寸」那一段整体替换为：

```scss
/// 牌面尺寸。**三档**（spec §3.2 / R731）。
///
/// ⚠️ **比例以我方画稿为准（80×104 = 0.769），不照抄参考图的 0.743**：
/// `card-hand-interaction` 的 U1 算账第 ① 条要求牌框**贴住源图**比例（容差 1.5%），
/// 照抄参考图的 225/303 会差 3.6% ⇒ 该判据当场红。高度比参考图矮 3%，肉眼不可辨。
///
/// 参考图实测（画布坐标）：手牌行 208.8 高 / pitch 65.8（净露 42.4%）；
/// 出牌组 117 高；底牌簇 51.7 高。
$ftl-card-h: 202px;   // normal = **手牌档**（参考 208.8，按画稿比例取 202）
$ftl-card-w: 155px;   // 155 / 202 = 0.767 ≈ 0.769 ✅
$ftl-card-mid-h: 117px; // mid = 出牌档（参考出牌组 117）
$ftl-card-mid-w: 90px;  // 90 / 117 = 0.769 ✅
$ftl-card-h-small: 52px; // small = 底牌档（参考底牌簇 51.7）
$ftl-card-w-small: 40px; // 40 / 52 = 0.769 ✅

/// 手牌**相邻两张**的重叠量（`.card + .card` 的负 `margin-left`）——**参考形态**的值。
///
/// ⚠️ 张数多时**由 `handLayout.handOverlap()` 抬高**（20 张要压到 95.1 才单行）。
/// 本令牌是「牌少时不无谓压牌」的那一档，**不是**恒等值。
///
/// 账目（画布 1334，可用宽 1294 = 1334 − 2×$ftl-space-5(12) − 2×$ftl-space-4(8)）：
///   17 张 = 155 + 16 × (155 − 89) = **1211** ≤ 1294 ✅ 单行
///   20 张 = 155 + 19 × (155 − 89) = **1409** > 1294 ⇒ 必须压到 95.1（净露 38.6%）
///   净露率 (155 − 89) / 155 = **42.6%** —— 参考图实测 42.4% ✅
$ftl-card-overlap: 89px;
```

**紧接着新增**素材槽那一段（放在 `$ftl-hairline` 之后）：

```scss
// ---------------------------------------------------------------------------
// 素材槽（spec §3.5 / R733）—— 每个装饰件 = 「CSS 兜底 + 可选贴图」
// ---------------------------------------------------------------------------
//
// ⚠️ **本段的约定与上面 `$ftl-btn-plate` 那一批**不同**，不是笔误：
//    · `$ftl-btn-plate: '/static/ui/btn2.png'` 存的是**路径**，配 `url($ftl-btn-plate)` 使用；
//    · 本段的令牌**连 `url()` 一起存**，因为缺省要能表示「还没有素材」= `none`。
//      `url(none)` 是**非法值**，整条声明会被**静默丢弃**（不报错、单测也看不见）。
//
// ⇒ 用法恒为 `background-image: $ftl-art-x;`（**不要**再包一层 `url()`）。
// 素材到位时只改这里的一行，**布局一行不改**。
//
// 判据（§5.2）：解析本文件取全部 `$ftl-art-*` 真值 ⇒ ①缺省全为 `none`；
//                ②不得有组件硬编码素材路径。

/// 地主徽章（参考图：头像左上角的橙色竖牌）
$ftl-art-landlord-badge: none;
/// 张数徽章底（参考图：卡片形状的蓝底白字牌）
$ftl-art-count-tile: none;
/// 货币图标（参考图：金色圆币）
$ftl-art-coin: none;
/// 头像环（参考图：头像外的白色圆环）
$ftl-art-avatar-ring: none;
/// 倍数徽章（参考图：白底橙边、略微倾斜的「N倍」牌）
$ftl-art-bid-badge: none;
/// 倒计时钟（参考图：金色闹钟）
$ftl-art-countdown: none;
```

**再新增**分区尺寸那一段：

```scss
// ---------------------------------------------------------------------------
// 横屏分区尺寸（spec §2.2 / §2.3）—— 参考图实测值换算到画布
// ---------------------------------------------------------------------------

/// 顶栏高（参考图内容 y 4..93 → 64）
$ftl-bar-h: 64px;
/// 底部信息条高（参考图 y 998..1087 → 61）
$ftl-bottombar-h: 61px;
/// 座位头像直径（参考图圆盘 φ141..148 → 97..102，取 98）
$ftl-size-avatar: 98px;
/// 对手座位卡宽（参考图左座位卡 x 0..330 → 227）
$ftl-seat-w: 227px;
/// 结算面板宽（参考图 x 224..1698 → 1016）
$ftl-settlement-w: 1016px;
```

⚠️ `$ftl-size-avatar` **已存在**（现值 72px）—— 改它的值，**不要**新增同名令牌。

- [ ] **Step 7: 改 `Card.vue` 的第三档**

改 `apps/client/src/components/Card.vue`：

把 `size?: 'normal' | 'small';` 改为 `size?: 'normal' | 'mid' | 'small';`
（`withDefaults` 里的默认值保持 `'normal'` 不变）

把样式里的档位规则改为：

```scss
.card--mid {
  flex-basis: $ftl-card-mid-w;
  width: $ftl-card-mid-w;
  height: $ftl-card-mid-h;
  font-size: $ftl-font-card-small;
}
.card--small {
  flex-basis: $ftl-card-w-small;
  width: $ftl-card-w-small;
  height: $ftl-card-h-small;
  font-size: $ftl-font-card-small;
}
```

（`.card--mid` 是**新增**块；`.card--small` 只需确认它的三条值跟着令牌走，**块本身不用改**。）

- [ ] **Step 8: 重算 U1 算账（**同一次改动里做完**）**

改 `apps/client/test/card-hand-interaction.test.ts` 的 `it('源码级：牌框比例 …')`（约 535-579 行）为：

```ts
  it('源码级：三档牌框各自贴住真牌 0.769，且 20 张手牌按张数压缩后单行放得下（U1 算账；片② 起三档）', () => {
    /** 从 `uni.scss` 现读一个 **px** 令牌的数值。 */
    const token = (name: string): number => {
      const m = new RegExp(`^\\$${name}:\\s*(\\d+)px;`, 'm').exec(UNI_SCSS);
      expect(m, `未找到令牌 $${name}`).not.toBeNull();
      return Number(m![1]);
    };

    const sourceRatio = 80 / 104; // 源图 54 张面全部 80×104

    // ① **三档**牌框各自贴住源图比例（差 < 1.5%）
    const tiers: ReadonlyArray<readonly [string, string, string]> = [
      ['手牌', 'ftl-card-w', 'ftl-card-h'],
      ['出牌', 'ftl-card-mid-w', 'ftl-card-mid-h'],
      ['底牌', 'ftl-card-w-small', 'ftl-card-h-small'],
    ];
    for (const [label, wTok, hTok] of tiers) {
      const w = token(wTok);
      const h = token(hTok);
      expect(
        Math.abs(w / h - sourceRatio) / sourceRatio,
        `${label}档 ${w}×${h}（比例 ${(w / h).toFixed(3)}）必须贴住源图 ${sourceRatio.toFixed(3)}`,
      ).toBeLessThan(0.015);
    }

    // ② 手牌：**参考形态**下 17 张单行；20 张（地主）按张数压缩后**仍**单行。
    //    可用宽 = 1334 − .table 两侧 $ftl-space-5(12) − .table__me 两侧 $ftl-space-4(8) = 1294。
    //    ⚠️ 这两个内边距必须与 `table.vue` 的实际写法一致 —— 改内边距就要重算这里。
    const AVAILABLE = 1294;
    const w = token('ftl-card-w');
    const baseOverlap = token('ftl-card-overlap');

    expect(
      w + 16 * (w - baseOverlap),
      '17 张必须按参考形态（不压缩）单行放得下',
    ).toBeLessThanOrEqual(AVAILABLE);
    expect(
      w + 19 * (w - handOverlap(20, AVAILABLE, w, baseOverlap)),
      '20 张压缩后必须单行放得下',
    ).toBeLessThanOrEqual(AVAILABLE);

    // ③ 参考形态的净露率落在档位区间（dsh：手牌 57% / 出牌区 45%；参考图实测 42.4%）
    const exposure = (w - baseOverlap) / w;
    expect(exposure, `净露率 ${(exposure * 100).toFixed(0)}% 过低 ⇒ 看不清角标`).toBeGreaterThanOrEqual(0.4);
    expect(exposure, `净露率 ${(exposure * 100).toFixed(0)}% 过高 ⇒ 角标被下一张盖住`).toBeLessThanOrEqual(0.6);

    // ④ 判别力自证：参考重叠**不再**能让 20 张单行（证明 ② 的压缩分支不是摆设）
    expect(
      w + 19 * (w - baseOverlap),
      '20 张按参考重叠应当放不下 ⇒ 必须有压缩分支',
    ).toBeGreaterThan(AVAILABLE);
  });
```

并在该文件顶部补 import：

```ts
import { handOverlap } from '../src/composables/handLayout';
```

- [ ] **Step 9: 跑该文件，确认绿**

```bash
pnpm --filter @fight-the-landlord/client test -- card-hand-interaction
```

Expected: PASS。若 ① 红 ⇒ 令牌比例不对；若 ② 红 ⇒ 可用宽或 `table.vue` 的内边距与实际不符（**先去看 `table.vue` 的真实 padding，改这里**）。

- [ ] **Step 10: 跑全量 + lint + 构建**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
```

Expected: 全绿；两个 build 都 DONE。
⚠️ `table-seat-geometry` 的牌背扇用例此时**可能仍是绿的**（牌背扇在 Task 3 才删）—— 这是对的。

- [ ] **Step 11: Commit**

```bash
git add apps/client/src/uni.scss apps/client/src/components/Card.vue \
        apps/client/src/composables/handLayout.ts apps/client/test/hand-layout.test.ts \
        apps/client/test/card-hand-interaction.test.ts
git commit -F - <<'MSG'
feat(client): 三档牌面 + 手牌重叠纯函数 + 素材槽令牌（片② Task 2 / R731-R734）

三档牌面（比例以**我方画稿 80×104 = 0.769** 为准，不照抄参考图的 0.743 ——
照抄会让 U1 算账第 ① 条差 3.6% 当场红）：
  手牌 155×202（参考 208.8）· 出牌 90×117（参考 117）· 底牌 40×52（参考 51.7）

手牌重叠从固定 40px 改成按张数的纯函数 handOverlap()：
参考 pitch 66（净露 42.6%）在 20 张时需 1409 > 可用 1294 ⇒ 必须压到 95.1。
判据是纯函数单测（n=1..20 恒单行、不倒退）。

六个素材槽令牌（spec R733）：**连 url() 一起存、缺省 none** —— 与既有
$ftl-btn-plate（存路径）是不同约定，因为 url(none) 非法、整条声明会被静默丢弃。
逐槽登记见 spec §3.5，六个当前**全无图**，只画 CSS 兜底。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 3: 座位卡（数字徽章 / 头像环 / 货币位 / 倒计时）+ 判据成对迁移

**Files:**
- Modify: `apps/client/src/components/Seat.vue`
- Modify: `apps/client/test/table-seat-geometry.test.ts:65-78`

**Interfaces:**
- Consumes: `$ftl-size-avatar`(98) · `$ftl-art-*` 六个槽 · `$ftl-card-w-small/h-small`
- Produces: `.seat__count-tile`（新稳定 class，徽章容器）· `.seat__coin`（货币位）· 删除 `.seat__backs`

---

- [ ] **Step 1: 改写判据（**先改成红**）**

改 `apps/client/test/table-seat-geometry.test.ts` 的 `it('两个对手座位各画 N 张牌背；自己座位不画（R660）')` 为：

```ts
  it('两个对手座位各挂一张**数字徽章**（张数 = 服务端 cardCounts）；自己座位不挂（R727 成对迁移 / R660）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, cardCounts: [17, 5, 3] }), 1),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.seat')).toHaveLength(3); // 2 对手 + 1 我

    // ① 徽章只挂在两个对手身上，且数字**就是服务端给的 cardCounts**
    const tiles = [...wrapper.findAll('.seat__count-tile')];
    expect(tiles.map((t) => t.text()).sort()).toEqual(['3', '5']);

    // ② 反面对照：牌背扇**必须已经不存在**（R727：数字取代了它）
    expect(wrapper.findAll('.card--back'), '对手座位不再画牌背扇').toHaveLength(0);

    // ③ R660 的语义**未变**：`.table__me .card` 仍然只数得到手牌
    expect(wrapper.find('.table__me').findAll('.card')).toHaveLength(17);
  });
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client test -- table-seat-geometry
```

Expected: FAIL —— `.seat__count-tile` 找不到（`expect([])` 与 `['3','5']` 不等），且 `.card--back` 仍是 3+5 张。

- [ ] **Step 3: 改 `Seat.vue` 的模板**

把 `.seat__backs` 那一段换成数字徽章，并在头像外加上环、昵称下加货币位。
`apps/client/src/components/Seat.vue` 的 `<template>` 改为：

```vue
<template>
  <view class="seat" :class="[`seat--${size}`, { 'seat--active': isActive }]">
    <view class="seat__avatar">
      <text class="seat__avatar-initial">{{ initial }}</text>
      <image class="seat__avatar-img" :src="avatarSrc" mode="aspectFit" />
    </view>
    <view class="seat__name">
      <text>{{ name }}</text>
      <!-- `isLandlord` 只来自服务端 `PlayerView.landlordSeat`（§6.4）：这里不推断、不补默认 -->
      <view v-if="isLandlord" class="seat__badge">地主</view>
    </view>
    <!--
      货币位（R717）：**服务端没有这个字段** ⇒ 三个座位统一填 `—`，不编造各不相同的假数字。
      ⚠️ 不写 `modelValue` 之类的 prop —— 它现在就是一个字面占位，接入时把 `—` 换成真值。
    -->
    <view class="seat__coin"><text class="seat__coin-value">—</text></view>
    <!--
      张数数字徽章（R727）：取代牌背扇。数字 = 服务端 `cardCounts[seat]`，组件不做推断。
      ⚠️ 旧判据断言的 `.seat__backs`（`cardCount` 张 `.card--back`）已按 R727 **成对迁移**。
    -->
    <view class="seat__count-tile"><text class="seat__count-tile-num">{{ cardCount }}</text></view>
    <text class="seat__count" :class="{ 'seat__count--warn': cardCount > 0 && cardCount <= 2 }">
      剩 {{ cardCount }} 张
    </text>
    <!-- ⚠️ `v-if` 而不是 `v-show`：终局必须**一个 `.seat__timer` 都没有**（既有判据） -->
    <text v-if="isActive" class="seat__timer">{{ seconds }}s</text>
    <view v-if="isActive && hasCountdown" class="seat__countdown">
      <view class="seat__countdown-fill" :style="fillStyle" />
    </view>
  </view>
</template>
```

⚠️ **`Card` 的 import 与 `showBacks` prop 一并删除**（删干净，不留死代码 —— R715 的口径）。
`showBacks` 从 `defineProps` 与 `withDefaults` 里删掉；`table.vue` 传的 `:show-backs="false"` 也要删（Task 4 处理，本 Task 先删组件侧）。

- [ ] **Step 4: 改 `Seat.vue` 的样式**

在 `<style scoped>` 里：

**删除** `.seat__backs` 与 `.seat__backs :deep(...)` 两条规则。
在 `.seat__avatar` 规则里**新增**头像环（用素材槽）：

```scss
/** 头像环（spec §3.5 素材槽）：贴图优先，无图时走下面的 `$ftl-hairline` 描边兜底。 */
.seat__avatar-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-image: $ftl-art-avatar-ring;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
```

⚠️ 若 `$ftl-art-avatar-ring` 为 `none`，这条规则的 `background-image: none` 是**合法**的
（这正是「连 `url()` 一起存」的原因），环由 `.seat__avatar` 的既有描边承担。

**新增**货币位与张数徽章：

```scss
/** 货币位（R717）：统一 `—`。金色是**素材槽**，无图时用文字色兜底。 */
.seat__coin {
  display: flex;
  align-items: center;
  gap: $ftl-space-2;
  color: $ftl-color-accent;
  font-size: $ftl-font-xs;
}
.seat__coin-value {
  font-weight: 600;
}
/**
 * 张数数字徽章（R727）：参考图的形态 —— 一张**卡片形状**的底，上面是白色粗体大数字。
 * ⚠️ 字号必须**大于** `.seat__name`（§6.5-1 的档位关系，`table-seat-geometry` 钉着）。
 */
.seat__count-tile {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  min-width: $ftl-card-w-small;
  height: $ftl-card-h-small;
  padding: 0 $ftl-space-3;
  border: $ftl-hairline solid $ftl-color-primary;
  border-radius: $ftl-radius-sm;
  /* 素材槽：有图走图，无图走下面的实色底兜底（`background-image: none` 是合法值） */
  background-color: $ftl-color-primary-soft;
  background-image: $ftl-art-count-tile;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  color: $ftl-color-primary;
}
.seat__count-tile-num {
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1;
}
```

⚠️ **地主徽章**从 `wd-tag` 换成 `<view class="seat__badge">` ⇒ 必须自持样式（全局约束 6）：

```scss
/**
 * 地主徽章（R727 / spec §3.5）。原来是 `wd-tag`，换成自持样式的 `view`
 * —— 因为要作为**素材槽**（参考图是橙色竖牌），且组件库的 tag 吃不到我们的槽位令牌。
 */
.seat__badge {
  box-sizing: border-box;
  flex: 0 0 auto;
  padding: 0 $ftl-space-3;
  border-radius: $ftl-radius-sm;
  background-color: $ftl-color-accent;
  background-image: $ftl-art-landlord-badge;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-xs;
  line-height: 1.6;
}
```

- [ ] **Step 5: 跑该文件，确认绿**

```bash
pnpm --filter @fight-the-landlord/client test -- table-seat-geometry
```

Expected: PASS（8 passed）。⚠️ 若 §6.5-1 那条红了 ⇒ 徽章/张数的字号档位没压过昵称，回去看 `.seat__count` 的 `$ftl-font-md`。

- [ ] **Step 6: 跑全量（看有没有别处依赖牌背扇 / `wd-tag`）**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿。⚠️ 若 `table-hud` 或其它文件红，**读那条断言再决定**：依赖 `.seat__backs` 的要成对迁移，
依赖 `.seat__badge` 的应该仍然绿（class 名没变）。

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/components/Seat.vue apps/client/test/table-seat-geometry.test.ts
git commit -F - <<'MSG'
feat(client): 座位卡 —— 数字徽章取代牌背扇 + 头像环/货币位/地主徽章（片② Task 3 / R727）

R727：对手剩余手牌改成参考图的**数字徽章**（卡片形状的底 + 白色粗体大数字），
不再画 cardCount 张牌背扇。判据**成对迁移**（不是删除）：
  「两个对手座位各画 N 张牌背」→「徽章数字 = 服务端 cardCounts」+ 反面对照「.card--back 必须为 0」。
R660 的语义未变（.table__me .card 仍只数得到手牌）。

新增素材槽：头像环 / 货币位 / 地主徽章 / 张数徽章底（四个当前都无图，走 CSS 兜底）。
地主徽章从 wd-tag 换成自持样式的 view —— 组件库的 tag 吃不到我们的槽位令牌。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 4: 四区重排 + 顶栏 + 动作条叠放 + 手牌接线

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`
- Modify: `apps/client/src/components/Hand.vue`
- Test: 复用既有 `table-hud` / `table-play-ui` / `table-ended-ui` / `table-bid-ui`（**一条都不减**）

**Interfaces:**
- Consumes: `handOverlap()`（Task 2）· `$ftl-bar-h` / `$ftl-bottombar-h` / `$ftl-seat-w`（Task 2）· `.seat__*`（Task 3）
- Produces: `.table__bar-*` 三个分区 · `.table__art-btn`（三个占位按钮）· `.table__actions` 浮层

---

- [ ] **Step 1: 改 `Hand.vue`：接 `fitWidth`，把重叠算成 CSS 变量**

在 `apps/client/src/components/Hand.vue` 的 props 里新增：

```ts
    /**
     * 可用行宽（画布 px）。给了它 ⇒ 重叠**按张数自适应**（R732），恒单行。
     * ⚠️ 只在**手牌**接它；出牌区/底牌张数少且形态固定，不接（传 `undefined` 走参考重叠）。
     */
    fitWidth?: number;
```

⚠️ **同时改默认档位**（自查发现的类型不一致）：

```ts
/**
 * apps/client/src/components/Hand.vue —— `withDefaults` 的默认值
 *   size: 'small'  →  'mid'
 *
 * 理由：出牌区（`PlayArea.vue`）**不传** `size`，走的就是这个默认值；
 * 而它的档位是 `mid`（参考图出牌组 117 高）。
 * 改完三个消费方各就各位：
 *   · 手牌 —— `table.vue` 显式传 `normal`（Task 4 Step 3）
 *   · 出牌区 —— 走默认 ⇒ **mid** ✅
 *   · 底牌 —— `BottomCards.vue` 显式传 `small`（Task 5 Step 3）
 */
{ interactive: false, selected: () => [], size: 'mid', emptyText: '', enter: 'deal', sort: 'none' }
```

在 `const emit = ...` 之后新增：

```ts
/**
 * 相邻两张的重叠量（R732）。`fitWidth` 缺省时就是**参考形态**的固定值。
 *
 * ⚠️ 令牌的真值不能直接 import（`uni.scss` 是样式层）⇒ 这里复刻它的**意图**并把
 * 「令牌值是多少」这件事留给 `card-hand-interaction` 的 U1 算账去钉（那里从 uni.scss 现读）。
 * 本组件只负责「张数多时要压得更狠」这条规则本身。
 */
const CARD_W = 155; // 与 $ftl-card-w 一致（U1 算账会把两者钉在一起）
const BASE_OVERLAP = 89; // 与 $ftl-card-overlap 一致
const overlap = computed(() =>
  props.fitWidth === undefined ? BASE_OVERLAP : handOverlap(props.cards.length, props.fitWidth, CARD_W, BASE_OVERLAP),
);
const handStyle = computed(() => ({ '--ftl-hand-overlap': `${overlap.value}px` }));
```

模板上，`<view class="hand">` 改为 `<view class="hand" :style="handStyle">`。

⚠️ **不要在 `Hand.vue` 里加 `margin-left` 规则**（执行期订正）：`Hand.vue` 被**三个**地方用
（手牌 / 出牌区 / 底牌），而**出牌区是不重叠的** —— 参考图左组「10 10 10 10」实测 x 250..621 = 372，
4 张 87 宽的牌并排（`4×87 + 3×小间隙 ≈ 372`）正是**不重叠**的形态 ✓。
`Hand.vue` 只负责**算出并暴露**这个变量，用它的是宿主（`table.vue` 的 `:deep` 规则）。
⇒ 本步**只加 `handStyle`**，样式块不动。

并在顶部补 import：`import { handOverlap } from '../composables/handLayout';`

- [ ] **Step 2: 跑既有手牌判据，确认没被撞坏**

```bash
pnpm --filter @fight-the-landlord/client test -- card-hand-interaction table-play-ui
```

Expected: 全绿。⚠️ 若 `card-hand-interaction` 的「重叠必须是 `.card + .card` 的负 `margin-left`」那条红了
⇒ 它扫的是**源码文本**，认的是 `margin-left: -$ftl-card-overlap` 的字面形态。**读那条闸的实现**再决定
（若它要求字面量，就在 `table.vue` 里保留那条覆盖规则、把变量放在 `Hand.vue` 内层，**不要**改闸）。

- [ ] **Step 3: 改 `table.vue` 的模板：四区重排**

把 `<template>` 里 `<view class="table">` 的内容整体替换为下面结构（**锚点逐字保留**）：

```vue
    <view class="table">
      <!--
        ① 顶栏（R729 / R730）。三个分区：左（返回大厅 + 记牌器 + 阶段状态）/ 中（底牌 + 倍数徽章）/ 右（占位按钮）。
        ⚠️ **锚点**：`.table__bar` 必须仍含「返回大厅」与「已结束」（table-ended-ui:103-105 读的是它的文本；
        探针按文本 `返回大厅` 匹配 ⇒ 四个字必须逐字在）。
        ⚠️ **模板注释必须在根元素内部**（R681）：放根前会让整页变多根、`classes()` 静默返回 `[]`。
      -->
      <view class="table__bar">
        <view class="table__bar-left">
          <button type="button" class="btn btn--small" @click="auth.navigate('lobby')">返回大厅</button>
          <!-- 记牌器位（R728 同族）：**按钮位在片②、功能另立片**（需商城/支付/道具持有） -->
          <button type="button" class="btn btn--small table__art-btn" disabled>记牌器</button>
          <text class="table__phase" v-if="store.isBidding">叫抢中</text>
          <text class="table__phase" v-else-if="store.isPlaying">出牌中</text>
          <text class="table__phase" v-else-if="store.isEnded">已结束</text>
          <text class="table__phase" v-else>{{ store.view?.state ?? '等待发牌' }}</text>
        </view>

        <!-- 中：底牌（牌背 → 翻开，语义未变）+ 倍数徽章（R719：只显示服务端原值） -->
        <view class="table__bar-center">
          <BottomCards :cards="store.bottomCards ?? null" />
          <view class="table__multiplier-badge">
            <text class="table__multiplier-value">{{ bidMultiplier ?? '—' }}</text>
            <text class="table__multiplier-unit">倍</text>
          </view>
        </view>

        <!-- 右：背包 / 托管 / 设置（R728：**按钮位在位、功能不做**，一个 disabled 属性可翻） -->
        <view class="table__bar-right">
          <button type="button" class="btn btn--small table__art-btn" disabled>背包</button>
          <button type="button" class="btn btn--small table__art-btn" disabled>托管</button>
          <button type="button" class="btn btn--small table__art-btn" disabled>设置</button>
        </view>
      </view>

      <!--
        就地提示（被拒的那次动作）排在**最前**：它是玩家刚做的那一步最具体的反馈；
        会话级 notice（连接/系统）跟在它下面 —— 两条同时成立时互不覆盖。
      -->
      <text v-if="localError" class="table__notice table__notice--error">{{ localError }}</text>
      <text v-if="notice" class="table__notice" :class="`table__notice--${notice.level}`">
        {{ notice.text }}
      </text>

      <view v-if="store.waitingForDeal" class="table__waiting">已进房，等待服务端发牌…</view>

      <template v-else>
        <!--
          ② 中段（R726）：两家对手分列左右；**最近一手摆到出牌者那一侧**；
          中央留给水印与气泡。⚠️ `.table__center` / `.table__row` / `.table__label` **零断言**（回核实测）⇒ 结构可自由改。
        -->
        <view class="table__mid">
          <Seat v-bind="seatProps(seats[0]!)" class="table__seat" />
          <view class="table__center">
            <!-- 最近一手：座位 0/1 摆左，2 摆右（R726）；归属仍指向 lastPlayerIdx（R656，一个字不改） -->
            <PlayArea
              v-if="playedCards !== null && lastPlayerIdx !== seats[1]"
              :cards="playedCards"
              :owner-seat="lastPlayerIdx"
              :owner-label="playOwnerLabel"
              :bubble="bubble"
            />
            <text v-else class="table__muted"> </text>
          </view>
          <Seat v-bind="seatProps(seats[1]!)" class="table__seat" />
        </view>

        <!--
          ③ 我的区域（R736）：**手牌在前、座位行与 HUD 在后**（参考图的形态）。
          ⚠️ 三者都**留在 `.table__me` 内** —— `.table__me .card` 必须只数得到手牌（探针数它 ≥17），
          且 `.table__me-head .seat__timer` 被 4 处断言钉着（后代选择器，顺序无关但**不能挪出**）。
        -->
        <view class="table__me">
          <Hand
            :cards="store.hand"
            interactive
            :selected="selected"
            :sort="handSort"
            size="normal"
            :fit-width="HAND_ROW_W"
            empty-text="手牌为空"
            @toggle="toggleCard"
          />
          <view class="table__me-head">
            <Seat
              :seat="store.mySeat ?? 0"
              :name="nameOf(store.mySeat ?? 0)"
              :card-count="store.hand.length"
              :is-landlord="store.landlordSeat === store.mySeat"
              :is-active="store.actorSeat === store.mySeat"
              :seconds="seconds"
              :remaining-ms="remainingMs"
              :total-ms="turnTotalMs"
              size="me"
            />
            <!-- 理牌（R655：只按点数；默认顺序不动 —— 那是「下标 12」判据与探针第一张的语义基础） -->
            <button type="button" class="btn btn--small table__sort-asc" @click="handSort = 'asc'">
              点数升序
            </button>
            <button type="button" class="btn btn--small table__sort-desc" @click="handSort = 'desc'">
              点数降序
            </button>
          </view>
          <TableHud :multiplier="hudMultiplier" :bomb-count="hudBombCount" :room-code="store.roomCode" />
        </view>

        <!--
          ④ 动作条（R735）：**绝对定位浮在中段下缘与手牌上缘之间**，不再占一行。
          ⚠️ 四个锚点位置变、**可点性不变**（探针走 DOM `.click()`，不受视觉遮挡影响）。
          ⚠️ 三个是**探针**锚点（`.table__play` / `.table__pass` / `.table__bid-grab`），
             `.table__bid-pass` 是 table-bid-ui / table-bid-bottom 的**测试**锚点 —— 两类都要保，不得混称。
        -->
        <view class="table__actions">
          <template v-if="store.isBidding">
            <BidPanel
              :disabled="busy || !store.isMyTurn"
              :multiplier="bidMultiplier"
              @grab="bid(true)"
              @pass="bid(false)"
            />
          </template>
          <template v-else-if="store.isPlaying">
            <button
              type="button"
              class="btn btn--primary table__play"
              :disabled="busy || !store.isMyTurn || selected.length === 0"
              @click="play"
            >
              出牌（{{ selected.length }}）
            </button>
            <button type="button" class="btn table__pass" :disabled="busy || !store.isMyTurn" @click="pass">
              过牌
            </button>
          </template>
          <text v-else-if="store.isEnded" class="table__ended">本局结束</text>
          <text v-else-if="!store.isMyTurn" class="table__muted">等待其他玩家…</text>
        </view>

        <Settlement
          v-if="store.settlement"
          :settlement="store.settlement"
          @again="onAgain"
          @back="auth.navigate('lobby')"
        />
      </template>
    </view>
```

在 `<script setup>` 里新增常量：

```ts
/**
 * 手牌可用行宽（画布 px）—— 与 `card-hand-interaction` 的 U1 算账**同一个数**。
 * 账目：1334 − `.table` 两侧 `$ftl-space-5`(12) − `.table__me` 两侧 `$ftl-space-4`(8) = 1294。
 */
const HAND_ROW_W = 1294;
```

⚠️ `TableHud` 的 import 保留（它现在在 `.table__me` 里，Task 5 精修样式）。

- [ ] **Step 4: 改 `table.vue` 的样式：四区 + 顶栏 + 动作条叠放**

把 `.table` 相关样式改为（保留既有规则名，只改值/新增）：

```scss
.table {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /* 参考图的分区是**全出血**的（间隙极小）⇒ 用最小阶，把省下的高度给中段（spec §2.2） */
  gap: $ftl-space-2;
  width: 100%;
  height: 100%;
  padding: $ftl-space-2 $ftl-space-5;
  position: relative; /* 动作条浮层的定位上下文 */
}
/** 顶栏（R729）：三段。高度按参考图实测 64（内容贴合，不是硬性容器高）。 */
.table__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-height: $ftl-bar-h;
}
.table__bar-left,
.table__bar-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-3;
}
/** 阶段状态（R730：必须留在 `.table__bar` 内，`table-ended-ui` 读的是它的文本）。 */
.table__phase {
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-xs;
}
/** 中段：吃掉顶栏与我的区域之间的剩余高度。 */
.table__mid {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  flex-direction: row;
  gap: $ftl-space-5;
  align-items: stretch;
}
.table__seat {
  flex: 0 0 $ftl-seat-w;
  min-width: 0;
}
.table__center {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
}
/** 底牌 + 倍数徽章（R729 / R719）：徽章只显示 `bidMultiplier` 原值。 */
.table__bar-center {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-3;
}
.table__multiplier-badge {
  display: flex;
  align-items: baseline;
  gap: $ftl-space-2;
  padding: $ftl-space-2 $ftl-space-4;
  border: $ftl-hairline solid $ftl-color-accent;
  border-radius: $ftl-radius-sm;
  background-color: $ftl-color-surface;
  background-image: $ftl-art-bid-badge;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  transform: rotate(-8deg); /* 参考图里那个徽章是斜的 */
}
.table__multiplier-value {
  color: $ftl-color-accent;
  font-size: $ftl-font-md;
  font-weight: 700;
}
.table__multiplier-unit {
  color: $ftl-color-accent;
  font-size: $ftl-font-xs;
}
/** 我的区域（R736）：手牌在前、座位行与 HUD 在后。 */
.table__me {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: $ftl-space-3;
}
/** 手牌：重叠由 `--ftl-hand-overlap`（`Hand.vue` 按张数算）提供，**恒单行**。 */
.table__me :deep(.hand) {
  display: flex;
  flex-wrap: nowrap; /* R732：永不换行 —— 张数多时靠重叠压，不靠换行 */
  column-gap: 0;
  align-items: flex-end;
  justify-content: center;
}
.table__me :deep(.hand .card + .card) {
  /**
   * ⚠️ **两条都在，是有意的**（执行期订正）：
   *  ① 字面令牌 —— 既是**真兜底**（`fitWidth` 缺省时 `--ftl-hand-overlap` 未设），
   *     也是既有源码闸 `card-hand-interaction.test.ts:499` 认的形态 ⇒ **零判据迁移**；
   *  ② 按张数算的实际值（R732），后一条覆盖前一条。
   * 那个闸的真实目的是「重叠必须落在负 `margin-left` 上（负 `gap` 非法）」，管的是**机制**；
   * 本写法两条都满足，所以**不需要**动闸。
   */
  margin-left: -$ftl-card-overlap;
  margin-left: calc(-1 * var(--ftl-hand-overlap, #{$ftl-card-overlap}));
}
/** 动作条（R735）：**绝对定位浮层**，不再占一行。 */
.table__actions {
  position: absolute;
  left: 50%;
  /* 浮在中段下缘、手牌上缘之间：手牌高 $ftl-card-h(202) + 底栏 $ftl-bottombar-h(61) + 内边距 */
  bottom: calc(#{$ftl-card-h} + #{$ftl-bottombar-h} + #{$ftl-space-5});
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
  transform: translateX(-50%);
}
.table__actions .btn {
  min-width: 160px;
}
/** 占位按钮（R728）：在位、禁用。功能落地时只翻这一个属性。 */
.table__art-btn {
  opacity: 0.5;
}
```

**删除**已退役的规则：`.table__row` · `.table__label` · `.table__waiting` 保留（仍在用）·
`.table__bar .btn { margin-left: auto }`（三段布局不再需要它）。

- [ ] **Step 5: 跑牌桌四张测试**

```bash
pnpm --filter @fight-the-landlord/client test -- table-hud table-play-ui table-ended-ui table-bid-ui table-seat-geometry
```

Expected: 全绿。**若红，逐条读断言再决定**：
- 依赖 `.table__mid` / `.table__center` 的 ⇒ 结构改对了（这两个 class 名保留）
- 依赖 `.table__me-head .seat__timer` 的 ⇒ 必须绿（路径未动）
- 依赖 `.table__bar` 文本含「已结束」的 ⇒ 必须绿（阶段状态仍在栏内）

- [ ] **Step 6: 单根闸 + 全量 + lint**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿。⚠️ `table-hud.test.ts` 的单根闸会检查**每个组件**是否多根 —— 顶栏里新增的 `<view>` 都是根元素的子节点，**不是**根前注释，应该绿。

- [ ] **Step 7: 构建 + 探针**

```bash
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
cd /d/Code/pokergame/apps/client && pnpm dev:h5 > /tmp/ftl-dev.log 2>&1 &
sleep 12
cd /d/Code/pokergame
export CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

Expected: `判据 16/16 通过`，`browser-e2e.mjs` 的 `git diff` 为**空**。

- [ ] **Step 8: 量一遍（本 Task 的观感基线）**

```bash
node scripts/browser-e2e.mjs --no-server --keep-open --cdp-port 18800 --scenario gate > /tmp/ftl-probe.log 2>&1 &
sleep 150
node scripts/measure-table.mjs --cdp-port 18800 --dump
```

Expected: `.table__me .card` 的 `canvas h ≈ 202`、`.table__mid` 的 `canvas h ≈ 356..406`。
**把输出留档**，Task 7 要它。

- [ ] **Step 9: Commit**

```bash
git add apps/client/src/pages/table/table.vue apps/client/src/components/Hand.vue
git commit -F - <<'MSG'
feat(client): 牌桌四区重排 + 顶栏三段 + 动作条叠放（片② Task 4 / R729 R730 R735 R736）

- 顶栏三段（R729）：左 返回大厅+记牌器位+阶段状态 / 中 底牌+倍数徽章 / 右 背包/托管/设置占位
  ⚠️ 「返回大厅」四字逐字保留（探针按文本匹配）；阶段状态留在 .table__bar 内（R730，
     table-ended-ui:103-105 读它的文本）⇒ 零判据迁移
- 我的手牌 + 座位行 + HUD 全部留在 .table__me 内（R736）：
  .table__me .card 仍只数得到手牌、.table__me-head .seat__timer 路径未动（4 处断言）
- 手牌改 flex-wrap: nowrap + --ftl-hand-overlap（Hand.vue 按张数算，R732）⇒ 恒单行
- 动作条绝对定位浮层（R735），不再占一行；四个锚点位置变、可点性不变

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 5: HUD 进底栏 + 最近一手跟座位 + 底牌降档

**Files:**
- Modify: `apps/client/src/components/TableHud.vue`
- Modify: `apps/client/src/components/PlayArea.vue`
- Modify: `apps/client/src/components/BottomCards.vue`

**Interfaces:**
- Consumes: `$ftl-bottombar-h` · `$ftl-art-countdown`（Task 2）
- Produces: 无新公开接口（纯样式与位置）

---

- [ ] **Step 1: `TableHud.vue` 变成底部信息条的形态**

**只改 `<style scoped>`**，模板一个字不改（`.hud__item--*` / `.hud__label` / `.hud__value` 与
「标签 **空格** 数值」的形态是判据的一部分 —— `table-hud.test.ts:211` 断言 `.hud__item--room` 的文本是 `房间 R1`）。

```scss
/**
 * 底部信息条（spec §2.3：参考图高 61；R729：房间码从顶栏移到这里）。
 *
 * ⚠️ 模板**一个字不改** —— `.hud__item--room` 的文本被 `table-hud.test.ts:211` 断言为 `房间 R1`，
 * 且 `.hud__label` 与 `.hud__value` **之间的那个空格是判据的一部分**（见组件头注释）。
 */
.table__hud {
  display: flex;
  flex-wrap: nowrap;
  gap: $ftl-space-6;
  align-items: center;
  min-height: $ftl-bottombar-h;
  padding: 0 $ftl-space-5;
  border-radius: $ftl-radius-md;
  background-color: $ftl-color-surface-muted;
  background-image: $ftl-art-count-tile;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
.hud__item {
  display: flex;
  gap: $ftl-space-2;
  align-items: baseline;
}
.hud__item--room {
  margin-right: auto; /* 房间弱化项推到最左，倍数/炸弹留在右 */
}
```

- [ ] **Step 2: `PlayArea.vue` 跟座位（R726）**

**只加两条样式**（模板与 props 一个字不改 —— `.table__played` / `.table__played-owner--seat-N` /
`.table__bubble--seat-N` 都是既有锚点）：

```scss
/**
 * 最近一手（R726）：由宿主`.table__center`摆在出牌者那一侧。
 * ⚠️ 本组件**仍然不知道**自己在左边还是右边 —— 那是宿主的排版决定（§12 哑终端：组件不做位置推断）。
 */
.table__play-area {
  display: flex;
  flex-wrap: nowrap;
  gap: $ftl-space-4;
  align-items: center;
  min-width: 0;
}
.table__played {
  display: flex;
  flex-wrap: wrap;
  gap: $ftl-space-4;
  align-items: center;
  order: 2;
}
```

（把 `.table__play-area` 的 `flex-wrap: wrap` 改成 `nowrap`，其余保持。）

- [ ] **Step 3: `BottomCards.vue` 降档**

把「已翻开」那一行改为 `size="small"`，未翻开的 3 张牌背也改为 `size="small"`：

```vue
    <view v-if="cards === null" class="table__bottom table__bottom--hidden">
      <Card v-for="back in hiddenBacks" :key="`bottom-back-${back}`" :value="0" face-down size="small" />
      <text class="table__muted">叫抢阶段不可见</text>
    </view>
    <view v-else class="table__bottom anim-reveal-in">
      <Hand :cards="cards" size="small" enter="none" />
    </view>
```

⚠️ **`table-bid-bottom` 的牌背判据断言的是 `.card--back` 的**数量**（3 张 / 翻开后 0 张），不是尺寸** ⇒ 降档不影响它。

- [ ] **Step 4: 跑既有判据**

```bash
pnpm --filter @fight-the-landlord/client test -- table-hud table-bid-bottom table-play-ui
```

Expected: 全绿。

- [ ] **Step 5: 全量 + lint + 双构建**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
```

Expected: 全绿 + 两个 DONE。

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/components/TableHud.vue apps/client/src/components/PlayArea.vue \
        apps/client/src/components/BottomCards.vue
git commit -F - <<'MSG'
feat(client): HUD 进底部信息条 + 底牌降到 small 档（片② Task 5 / R729 R731）

TableHud 只改样式层，模板一字未动 —— .hud__item--room 的文本被断言为 `房间 R1`，
且「标签 空格 数值」的形态是判据的一部分。房间码从顶栏移到这里（R729）。
BottomCards 从 normal（94）降到 small（52）：参考图的底牌簇只有 51.7 高，我们原来比它大 1.8 倍。
判据断言的是 .card--back 的**数量**，与尺寸无关 ⇒ 不受影响。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 6: 结算四列表格 + 精确文本断言成对迁移

**Files:**
- Modify: `apps/client/src/components/Settlement.vue`
- Modify: `apps/client/test/table-settlement-ui.test.ts:109-150`

**Interfaces:**
- Consumes: `$ftl-settlement-w`（Task 2）
- Produces: `.settlement__table` · `.settlement__th` · `.settlement__td` · `.settlement__row--me`（高亮行）

---

- [ ] **Step 1: 改写判据（**先改成红**）**

改 `apps/client/test/table-settlement-ui.test.ts` 中依赖精确文本的断言（约 109-150 行）。
**保留全部 15 个 `.settlement__*` 锚点**，只把「标签：值」的读法改成「表格单元格的裸值」：

```ts
    // 表头（参考图二：昵称 / 底分 / 倍数 / 分差）
    expect(w.findAll('.settlement__th').map((h) => h.text())).toEqual(['昵称', '底分', '倍数', '分差']);

    // 载荷里的数字：**格子里的裸值**（R737 表格化后不再带「倍数：」前缀）
    expect(w.get('.settlement__multiplier').text()).toBe('4');
    expect(w.get('.settlement__base-score').text()).toBe('100');
    expect(w.get('.settlement__landlord-delta').text()).toBe('777');
    expect(w.get('.settlement__farmer-delta').text()).toBe('-388.5');

    // 胜负标题用**服务端枚举**（R737：不推导「我是否赢」）
    expect(w.get('.settlement__headline').text()).toBe('地主胜');

    // 三家各一行；**当前玩家那一行被高亮**（身份映射：mySeat vs 行的座位号）
    const rows = w.findAll('.settlement__row');
    expect(rows).toHaveLength(3);
    expect(w.findAll('.settlement__row--me'), '必须恰好高亮一行').toHaveLength(1);

    // 角色徽章仍在（原先靠 `.settlement__row-role` 的文本）
    expect(w.findAll('.settlement__row-role').map((r) => r.text()).sort()).toEqual(['地主', '农民', '农民']);

    // 构成明细（R658：只列载荷字段，不给乘积）
    expect(w.get('.settlement__formula').text()).toContain('底分 100');
    expect(w.get('.settlement__formula').text()).toContain('倍数 4');

    expect(w.find('.settlement__again').exists()).toBe(true);
    expect(w.find('.settlement__lobby').exists()).toBe(true);
```

⚠️ `mount` 的夹具必须让**当前玩家**可判定：本文件原本没传 `mySeat`，若 `store.mySeat` 为
`null`，高亮行无法判定 ⇒ **先在该用例开头加 `store.setRoom('ROOM1', 0)`**（与本文件既有的 store 用法一致）。

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client test -- table-settlement-ui
```

Expected: FAIL —— `.settlement__th` 找不到、`.settlement__multiplier` 的文本仍是 `倍数：4`。

- [ ] **Step 3: 改 `Settlement.vue` 的模板为四列表格**

把 `<view class="settlement__grid">` 起的整段替换为：

```vue
    <!--
      四列表格（spec §4.2 / R737）。列 = 昵称（含角色徽章）/ 底分 / 倍数 / 分差。
      ⚠️ 三行的**倍数与底分同值**：`SettlementResult` 只有一个 `multiplier` 与一个 `baseScore`
      （参考图三行不同是因为它每家有独立的「加倍」）⇒ **这是载荷的如实反映，不是缺陷**（R739）。
      ⚠️ 当前玩家整行高亮 = **身份映射**（`mySeat` vs 行的座位号），**不是**结果推导（R737）。
    -->
    <view class="settlement__table">
      <view class="settlement__tr settlement__tr--head">
        <text class="settlement__th">昵称</text>
        <text class="settlement__th">底分</text>
        <text class="settlement__th">倍数</text>
        <text class="settlement__th">分差</text>
      </view>

      <view
        class="settlement__row settlement__row--landlord"
        :class="{ 'settlement__row--me': isMyRow(settlement.landlordSeat) }"
      >
        <text class="settlement__row-name">座位 {{ settlement.landlordSeat }}</text>
        <text class="settlement__base-score">{{ settlement.baseScore }}</text>
        <text class="settlement__multiplier">{{ settlement.multiplier }}</text>
        <text class="settlement__landlord-delta">{{ settlement.landlordScoreChange }}</text>
        <text class="settlement__row-role">地主</text>
      </view>

      <view
        v-for="seat in settlement.farmerSeats"
        :key="seat"
        class="settlement__row settlement__row--farmer"
        :class="{ 'settlement__row--me': isMyRow(seat) }"
      >
        <text class="settlement__row-name">座位 {{ seat }}</text>
        <text class="settlement__base-score">{{ settlement.baseScore }}</text>
        <text class="settlement__multiplier">{{ settlement.multiplier }}</text>
        <text class="settlement__farmer-delta">{{ settlement.farmerScoreChange }}</text>
        <text class="settlement__row-role">农民</text>
      </view>
    </view>
```

**保留** `.settlement__head` / `__tags` / `__title` / `__winner` / `__spring` / `__headline` 与
`.settlement__formula` / `.settlement__actions` / `__again` / `__lobby` / `__landlord-seat` / `__farmer-seats`
**原封不动**（它们各自的锚点被用着 —— 后者被 `settlement-rematch.test.ts` 用）。

在 `<script setup>` 里新增：

```ts
/**
 * 「这一行是不是我」—— **身份映射，不是结果推导**（R737）。
 *
 * `mySeat` 与行的座位号**都是服务端下发的**，本函数只把它们对上，
 * 与 `table.vue` 的 `store.landlordSeat === store.mySeat`（`isLandlord`）同一类。
 * ⚠️ **本组件仍然不推导胜负** —— 标题用服务端的 `winner` 枚举，一个字都不算。
 */
function isMyRow(seat: number): boolean {
  const mine = useGameStore().mySeat;
  return mine !== null && mine === seat;
}
```

并在顶部补 import：`import { useGameStore } from '../stores/game';`

⚠️ **`store.mySeat` 为 `null` 时恒 false**（不确定就不高亮 —— 宁可不高亮，也不要高亮错行）。

- [ ] **Step 4: 改样式**

```scss
/** 四列表格（参考图二：面板 x 154..1170 画布宽，横贯）。 */
.settlement__table {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: $ftl-settlement-w;
  margin: $ftl-space-5 auto;
}
.settlement__tr--head {
  display: flex;
  align-items: center;
  padding: $ftl-space-3 $ftl-space-5;
}
.settlement__th {
  flex: 1 1 0;
  color: $ftl-color-text-muted;
  font-size: $ftl-font-sm;
}
.settlement__row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-5;
  border-radius: $ftl-radius-sm;
}
/** 角色识别底色（与胜负无关，规则全在服务端）。 */
.settlement__row--landlord {
  background: $ftl-color-success-bg;
}
.settlement__row--farmer {
  background: $ftl-color-danger-bg;
}
/** 当前玩家整行高亮（R737：身份映射）。参考图是橙黄渐变。 */
.settlement__row--me {
  background: $ftl-color-warn-bg;
  box-shadow: inset 0 0 0 $ftl-hairline $ftl-color-accent;
}
.settlement__row-name,
.settlement__base-score,
.settlement__multiplier,
.settlement__row-role,
.settlement__landlord-delta,
.settlement__farmer-delta {
  flex: 1 1 0;
  font-size: $ftl-font-md;
}
.settlement__row-name {
  color: $ftl-color-text;
}
.settlement__base-score,
.settlement__multiplier,
.settlement__landlord-delta,
.settlement__farmer-delta {
  color: $ftl-color-primary;
  font-weight: 600;
}
.settlement__row-role {
  flex: 0 0 auto;
  color: $ftl-color-text-muted;
  font-size: $ftl-font-xs;
}
```

**删除**已退役的 `.settlement__grid` / `.settlement__rows` / `.settlement__row-seat` /
`.settlement__row-delta` 规则（它们的 class 不再出现在模板里）。

- [ ] **Step 5: 跑该文件 + `settlement-rematch`**

```bash
pnpm --filter @fight-the-landlord/client test -- table-settlement-ui settlement-rematch table-ended-ui
```

Expected: 全绿。⚠️ `settlement-rematch` 用 `.settlement__landlord-delta` / `.settlement__farmer-seats`
—— 前者现在读的是「裸值」，若它断言的是旧文本形态，**同样成对迁移**（它不在 65 之内，但仍要保持判别力）。

- [ ] **Step 6: 全量 + lint + 双构建 + 探针**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

Expected: 全绿；探针 `16/16`。

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/components/Settlement.vue apps/client/test/table-settlement-ui.test.ts
git commit -F - <<'MSG'
feat(client): 结算重排成四列表格（片② Task 6 / R737-R739）

列 = 昵称（含角色徽章）/ 底分 / 倍数 / 分差；当前玩家整行高亮。
- 高亮是**身份映射**（mySeat vs 行的座位号），**不是**结果推导：标题仍用服务端 winner 枚举
  「地主胜/农民胜」，本组件一个字都不算（R737，用户裁决「所有数据由服务器下发」）
- 三行的底分与倍数**同值** —— SettlementResult 只有一个 multiplier/baseScore，
  参考图三行不同是因为它每家有独立的加倍 ⇒ 如实反映，不是缺陷（R739，不得「修」）
- table-settlement-ui 的精确文本断言（`倍数：4` → `4`）**成对迁移**，条数不减（计入 65）
- 15 个 .settlement__* 锚点全留（settlement-rematch 仍在用其中的 delta/seats）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 7: 素材槽判据 + 走查 + 收口

**Files:**
- Create: `apps/client/test/art-slots.test.ts`
- Test: 全仓

**Interfaces:**
- Consumes: Task 1 的测量工具 · Task 2 的 `$ftl-art-*`

---

- [ ] **Step 1: 写素材槽判据**

创建 `apps/client/test/art-slots.test.ts`：

```ts
/**
 * 素材槽（spec §3.5 / R733；判据形态见 §5.2「素材槽」行，H4 订正后）。
 *
 * ⚠️ **判据射程**：这里**不**证明「有图时贴得对不对」（那是观感，只能走查）。
 * 它证明两件**可以机械判定**的事：
 *  ① 六个槽的**缺省值全是 `none`**（即「素材还没到位」这件事是显式的，不是忘了）；
 *  ② **没有任何组件硬编码素材路径** —— 这是真正的判别力所在：
 *     绕过槽位直接写 `url('/static/ui/xxx.png')` 会让「换素材只改一行」的承诺**静默失效**。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
const uniScss = stripComments(sources.find((f) => f.path === 'src/uni.scss')!.content);

/** spec §3.5 逐槽登记的那六个（缺一个就说明槽被悄悄删了）。 */
const SLOTS = [
  'ftl-art-landlord-badge',
  'ftl-art-count-tile',
  'ftl-art-coin',
  'ftl-art-avatar-ring',
  'ftl-art-multiplier-badge',
  'ftl-art-countdown',
] as const;

describe('§3.5 素材槽', () => {
  it('六个槽都在 uni.scss 里，且缺省值全是 none（素材未到位是**显式**的）', () => {
    for (const slot of SLOTS) {
      const m = new RegExp(`^\\$${slot}:\\s*([^;]+);`, 'm').exec(uniScss);
      expect(m, `未找到素材槽令牌 $${slot}`).not.toBeNull();
      expect(m![1]!.trim(), `$${slot} 的缺省值必须是 none`).toBe('none');
    }
  });

  it('令牌**连 url() 一起存**（缺省 none 合法；写成 url(none) 会被整条丢弃）', () => {
    // 正对照：给成 URL 时必须是完整的 url(...) 值
    expect(/^\$ftl-art-coin:\s*url\(/.test('$ftl-art-coin: url("/static/ui/coin.png");')).toBe(true);
    // 反面对照：路径式（既有 $ftl-btn-plate 的约定）在本段**不合法**
    expect(/^\$ftl-art-coin:\s*'/.test("$ftl-art-coin: '/static/ui/coin.png';")).toBe(false);
    for (const slot of SLOTS) {
      const m = new RegExp(`^\\$${slot}:\\s*([^;]+);`, 'm').exec(uniScss)!;
      const v = m[1]!.trim();
      expect(v === 'none' || v.startsWith('url('), `$${slot} 只能取 none 或 url(...)`).toBe(true);
    }
  });

  it('判别力：没有任何组件硬编码素材路径绕过槽位', () => {
    const uiFiles = sources.filter((f) => f.path.endsWith('.vue'));
    const offenders = uiFiles.filter((f) => {
      const code = stripComments(f.content);
      // 允许：既有那批走 url($ftl-btn-plate) 的（令牌本身存路径）
      return /url\(\s*['"]\/static\/ui\//.test(code);
    });
    expect(
      offenders.map((f) => f.path),
      '不得硬编码 /static/ui/ 路径 —— 素材一律走 $ftl-art-* 槽位',
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它**

```bash
pnpm --filter @fight-the-landlord/client test -- art-slots
```

Expected: PASS（3 passed）。⚠️ 第 3 条可能命中**既有**的 `url($ftl-btn-plate)` 写法 ——
若命中，**先去看那处到底是不是硬编码路径**：若是 `url($ftl-btn-plate)`（令牌引用），正则**不会**命中；
若是字面 `url('/static/ui/btn1.png')`，那是**既有的违规**，**在本 Task 里就地改成令牌引用**（属同族改进）。

- [ ] **Step 3: 逐文件核对 65 基线**

```bash
cd /d/Code/pokergame/apps/client/test
total=0
for f in auth-flow auth-ui-wiring lobby-ux ui-flow table-bid-ui table-play-ui table-ended-ui table-settlement-ui; do
  p=$(grep -oE "\bit\(" "$f.test.ts" | wc -l); e=$(grep -oE "\bit\.each\(" "$f.test.ts" | wc -l)
  echo "$f : it(=$p it.each(=$e = $((p+e))"; total=$((total+p+e))
done
echo "---- 合计 $total（基线 65，只增不减）----"
```

Expected: **≥ 65**，且逐文件不低于基线表里的数。

- [ ] **Step 4: 探针零改动核对**

```bash
cd /d/Code/pokergame && git diff master --stat -- scripts/browser-e2e.mjs
```

Expected: **空输出**（零改动）。

- [ ] **Step 5: 真浏览器走查（与两张参考图并排）**

```bash
cd /d/Code/pokergame/apps/client && pnpm dev:h5 > /tmp/ftl-dev.log 2>&1 &
sleep 12
cd /d/Code/pokergame
export CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
node scripts/browser-e2e.mjs --no-server --keep-open --cdp-port 18800 --scenario gate > /tmp/ftl-probe.log 2>&1 &
sleep 150
node scripts/measure-table.mjs --cdp-port 18800 --dump
```

然后**人眼并排看**（这一步没有机械判据，**不得**伪造）：

| 看什么 | 对照物 |
|---|---|
| 牌桌整体 | `.tmp_ref/fig1-table.png` |
| 结算表格 | `.tmp_ref/fig2-settlement.png` |

**逐条走查清单**（任一不通过 ⇒ 记进「已知未覆盖」，**不要**写进判据）：
1. 手牌是否**单行**、看得清角标、不与动作条重叠
2. **动作条浮层是否遮住手牌的可见区**（spec §3.6：这是**人**的判据，探针走 DOM 点击不会红）
3. 顶栏三段是否挤在一起 / 换行
4. 底牌在顶栏中央是否放得下、翻牌时机对不对（叫抢期 3 张牌背 → 地主确定后翻开）
5. 最近一手是否出现在**出牌者那一侧**
6. 六个素材槽的 CSS 兜底是否「像某个东西」（而非空白/错位）
7. 结算四列是否对齐、高亮行是否恰好一行
8. `k≈0.52` 下文字是否发虚到不可读

- [ ] **Step 6: `pnpm run ci` 六阶段 + 双构建**

```bash
cd /d/Code/pokergame
pnpm run ci
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
```

Expected: 六阶段全绿；两个 build DONE。

- [ ] **Step 7: 把测量结果与走查结论写进 spec 的新 §8（交接）**

在 `docs/superpowers/specs/2026-09-21-table-settlement-refine-design.md` 末尾**新增**：

```markdown
## 9. 执行期发现（片②）

> 格式：**现象 → 根因 → 被什么抓住 → 修法**。

（按实际执行结果填写。至少包含：Task 1 的测量输出、Task 7 的逐条走查结论、
以及任何偏离本设计的地方与理由。）

## 10. 片② 完成状态

| 项 | 结果 |
|---|---|
| `pnpm run ci` 六阶段 | |
| client 单测 | |
| 8 个文件的字面 `it(`/`it.each(` | |
| `build:h5` / `build:app` | |
| 真浏览器探针 `--scenario gate` | |
| `scripts/browser-e2e.mjs` | |
| 动作条是否遮住手牌（走查） | |
| 观感（像不像参考图） | |
```

- [ ] **Step 8: 收尾杀进程**

```bash
cd /d/Code/pokergame
for PORT in 5173 18800; do
  PID=$(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "$PID" ] && taskkill //F //PID "$PID" //T
done
```

- [ ] **Step 9: Commit**

```bash
cd /d/Code/pokergame
git add apps/client/test/art-slots.test.ts docs/superpowers/specs/2026-09-21-table-settlement-refine-design.md
git commit -F - <<'MSG'
test(client): 素材槽判据 + 片② 走查收口（片② Task 7 / R733）

art-slots.test.ts 三条：
  ① 六个槽的缺省值全是 none（「素材未到位」是显式的，不是忘了）
  ② 令牌只能取 none 或 url(...)（url(none) 非法、整条声明会被静默丢弃）
  ③ **没有任何组件硬编码 /static/ui/ 路径** —— 真正的判别力所在：
     绕过槽位直接贴图会让「换素材只改一行」的承诺静默失效

spec 新增 §9 执行期发现与 §10 完成状态（含走查的逐条结论 —— 观感类没有机械判据，
如实登记为「已知未覆盖」，不造假判据）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Self-Review（写计划后自查，已修）

**1. Spec 覆盖**：R724–R743 逐条落点 ——
R725/R717/R719（不加底分/货币位 `—`/倍数原值）→ Task 3+4；R726 → Task 4+5；
R727 → Task 3；R728/R729/R730 → Task 4；R731 → Task 2；R732 → Task 2+4；
R733/R734 → Task 2+7；R735/R736 → Task 4；R737/R738/R739 → Task 6；
R740（面板 variant 不锁）→ 不涉及代码，走查时定；R741/R742 → Task 1；R743 → 全局约束。**无缺口。**

**2. 占位符扫描**：无 TBD / TODO / 「类似 Task N」。每个改代码的 Step 都带了实际代码。

**3. 类型一致性**：`handOverlap(count, rowWidth, cardW, baseOverlap)` 在 Task 2 定义，
Task 2（U1 算账）与 Task 4（`Hand.vue`）**同签名**调用。
`Card.vue` 的 `size: 'normal' | 'mid' | 'small'` 在 Task 2 定义，
Task 5 的 `BottomCards` 用 `small`、`PlayArea` 走 `Hand` 的默认（Task 4 保持默认 `normal`？）

⚠️ **自查发现一处不一致，已修**：`Hand.vue` 的默认 `size` 是 `'small'`，而出牌区（`PlayArea`）
走的正是这个默认值 ⇒ 它应该是 **`mid`** 档。修法已**写进 Task 4 Step 1 的正文**（不是只写在这里）。
三个消费方改完各就各位：手牌 = `normal`（显式传）· 出牌区 = `mid`（走默认）· 底牌 = `small`（显式传）。
