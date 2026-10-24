#!/usr/bin/env node
/**
 * 牌桌几何测量（片② spec §5.1 / R741 / R742）。
 *
 * ## 为什么不是「探针的一个新 scenario」
 *
 * 片② 的全局约束 2 是「`scripts/browser-e2e.mjs` **本片零改动**」（它的首次改动留给片③）。
 * 所以本工具**独立于探针**，只**借**探针留下的东西：
 *   · `--keep-open` 让 chromium 与 dev server 不被回收（见探针 `finish()` 与 `process.on('exit')`
 *     都在 `KEEP_OPEN` 时跳过 `shutdownSync()`）；
 *   · gate / minimal 两个 scenario 的**末态恰停在真牌桌**上（实测 URL =
 *     `http://localhost:5173/#/pages/table/table`，17 张真手牌）。
 *
 * ## 用法
 *
 *   # 1) 另开一个终端，后台跑探针并留活：
 *   node scripts/browser-e2e.mjs --no-server --keep-open --cdp-port 18800 --scenario gate
 *   # 2) 再跑本工具量：
 *   node scripts/measure-table.mjs --cdp-port 18800 --dump
 *   node scripts/measure-table.mjs --cdp-port 18800 --selector .table__mid
 *
 * ## 它**不是**判据
 *
 * 它只**报数**。观感是否像参考图仍然只能人眼判定（spec §1.1-8：不造假判据）。
 * 它的价值是让「改完到底变成多少」有一个**可复现**的读数 —— 片① F9 缺的正是这个。
 *
 * ⚠️ **片① F9 的「脚本走不通撮合」本工具不解释、只绕开**：本工具**不自己走撮合**，
 * 它量的是一局**已经打完**（探针跑完 gate）之后停在牌桌上的那个页面。
 * 差异原因仍登记为**未查明**（spec §7-7）。
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
  // ⚠️ 协议④ 起「窗口 2」⇒ 页面上**最多两个** `.table__play-area` 实例（两侧对手各一格，
  //    中央/我的那格另有宿主类名）。本清单是**人工量尺**（非门禁、不参与 ci），取的是
  //    **首个匹配** ⇒ 读数落在哪一格取决于当时的 DOM 顺序、含义可能随机。
  //    要量某一格时加槽位限定（`.table__played-slot` 的第 i 项 / `.table__my-play`）。
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
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 15000);
    });
  return { send, close: () => ws.close() };
}

/** 页面侧：量一个元素的 rect（屏幕坐标 + **画布坐标**都给，后者可直接与参考图换算对照）。 */
const rectExpr = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const canvas = document.querySelector('.canvas');
  const k = canvas ? canvas.getBoundingClientRect().width / 1334 : 1;
  if (!el) return { selector: ${JSON.stringify(selector)}, missing: true, k: +k.toFixed(4) };
  const r = el.getBoundingClientRect();
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
    const r = await cdp.send('Runtime.evaluate', {
      expression: rectExpr(sel),
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`页面求值抛错：${r.exceptionDetails.text}`);
    out.push(r.result.value);
  }
  return out;
}

if (!DUMP && !SELECTOR) {
  console.error('用法：node scripts/measure-table.mjs --cdp-port 18800 (--selector .table__mid | --dump)');
  process.exit(2);
}

const cdp = await connect(CDP_PORT);
const selectors = DUMP ? DUMP_SELECTORS : [SELECTOR];
const rows = await measure(cdp, selectors);
console.log(`k = ${rows.find((r) => r?.k)?.k ?? '?'}（画布缩放比）\n`);
for (const r of rows) {
  if (!r || r.missing) {
    console.log(`   (缺) ${r?.selector ?? '?'}`);
    continue;
  }
  console.log(
    `${r.selector.padEnd(22)} count=${String(r.count).padStart(3)}  ` +
      `screen ${String(r.screen.x).padStart(5)},${String(r.screen.y).padStart(4)} ` +
      `${String(r.screen.w).padStart(5)}x${String(r.screen.h).padStart(4)}   ` +
      `canvas ${String(r.canvas.x).padStart(6)},${String(r.canvas.y).padStart(5)} ` +
      `${String(r.canvas.w).padStart(6)}x${String(r.canvas.h).padStart(5)}`,
  );
}
cdp.close();
process.exit(0);
