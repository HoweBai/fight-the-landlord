#!/usr/bin/env node
/**
 * 加载瀑布测量探针（`docs/superpowers/plans/2026-10-10-client-loading-slow-kickoff.md` §4 的机械化形态）。
 *
 * ## 它回答什么问题
 *
 * 「进桌/发牌为什么慢」的**先测后改**件：走一遍 登录/注册 → 大厅 → 玩法页 → 开始游戏 → 发牌，
 * 用 CDP `Network.*` 记录**每个请求**的时刻/大小/耗时，按**阶段**（导航 → 大厅 → 发牌）聚合。
 * 与 `browser-e2e.mjs` 的分工：那个脚本守**功能判据**（红/绿），本脚本只**出数**（不判产品对错）。
 *
 * ## 用法
 *
 * ```bash
 * # 本机 edge（自签证书）跑完整链路；CHROME_BIN 见下
 * CHROME_BIN="/c/Program Files/Google/Chrome/Application/chrome.exe" \
 *   node scripts/perf-waterfall.mjs --base-url https://localhost:8443/
 * # 生产（真域名）：--proxy system 让 chromium 走系统代理（复现玩家侧代理在路）；缺省 --proxy none 直连
 * node scripts/perf-waterfall.mjs --base-url https://api.example.com/ --proxy system
 * # 用已有账号（生产用；缺省注册随机新账号——只在 dev 栈用）
 * node scripts/perf-waterfall.mjs --base-url https://api.example.com/ --login 13800138000:pass
 * # 只测首页（不登录）
 * node scripts/perf-waterfall.mjs --base-url https://api.example.com/ --scenario home
 * ```
 *
 * 产物 = stdout 表格 + 一份 JSON（`--json <path>`，缺省写临时目录并打印路径）。
 *
 * ## 纪律
 *
 * - **零依赖**（与 `browser-e2e.mjs` 同口径）：Node 内置 WebSocket + chromium 的 `--remote-debugging-port`。
 * - **独占**：与 `browser-e2e.mjs`/conformance 同属「打真栈」的重探针，同一时刻只跑一个；
 *   跑本脚本时**不要**重建镜像/重启容器。
 * - `--proxy none` 显式加 `--no-proxy-server`（Windows 上 chromium 默认吃 **WinINET 系统代理**——
 *   本机常驻 qv2ray/trojan，不显式关会把「代理在路」误记成产品慢）。
 * - `--ignore-certificate-errors` 是**刻意**的：本机 edge 是 `tls internal` 自签；生产证书有效，
 *   带上无害。它是测量工具，不是安全闸。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const BASE_URL = opt('base-url', 'http://localhost:5173/');
const SCENARIO = opt('scenario', 'full'); // full | home
const PROXY = opt('proxy', 'none'); // none | system
const LOGIN = opt('login', null); // "phone:password" ⇒ 登录已有账号；缺省注册新账号（仅 dev 栈）
const CDP_PORT = Number(opt('cdp-port', '18800'));
const KEEP_OPEN = flag('keep-open');
const MATCH_TIMEOUT_MS = Number(opt('match-timeout-ms', '120000'));
const JSON_OUT = opt('json', join(tmpdir(), `ftl-perf-waterfall-${Date.now()}.json`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`   · ${msg}`);

// ─── 子进程回收（与 browser-e2e.mjs 同款：detached + 按组杀 + SIGKILL 补刀）──
const children = [];
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}
function shutdownSync() {
  const list = children.splice(0, children.length);
  for (const c of list) killGroup(c, 'SIGTERM');
  if (list.length === 0) return;
  sleepSync(400);
  for (const c of list) killGroup(c, 'SIGKILL');
  sleepSync(150);
}

function findChrome() {
  const explicit = process.env.CHROME_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const cands = readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse()
      .map((d) => join(cache, d, 'chrome-linux64', 'chrome'))
      .filter((p) => existsSync(p));
    if (cands.length > 0) return cands[0];
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const found = process.env.PATH?.split(':').map((d) => join(d, name)).find((p) => existsSync(p));
    if (found) return found;
  }
  return null;
}

async function httpOk(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function launchChrome() {
  const bin = findChrome();
  if (!bin) return { error: '找不到 chromium（设 CHROME_BIN 指向 chrome.exe/msedge.exe）' };
  const profile = mkdtempSync(join(tmpdir(), 'ftl-perf-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--no-first-run',
    '--disable-extensions',
    '--ignore-certificate-errors',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  // 直连 = 显式关掉系统代理（Windows chromium 默认吃 WinINET 系统代理 —— 见文件头纪律）。
  if (PROXY === 'none') args.splice(1, 0, '--no-proxy-server');
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: { ...process.env, HOME: profile } });
  children.push(child);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`, 1500)) return { bin, profile };
    await sleep(300);
  }
  return { error: 'chromium 30s 内没有暴露 CDP 端口' };
}

// ─── CDP 客户端（与 browser-e2e.mjs 同款）───────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket error')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, timeoutMs);
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`页面求值抛错：${r.exceptionDetails.text}`);
    return r.result.value;
  }
}

// ─── 页面侧小工具 ───────────────────────────────────────────────────────
const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
  if (!el) return 'not-found';
  el.click();
  return 'clicked';
})()`;

async function waitForSelector(cdp, selector, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (n > 0) return n;
    await sleep(150);
  }
  return n;
}

async function waitForSelectorCount(cdp, selector, min, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (n >= min) return n;
    await sleep(150);
  }
  return n;
}

// ─── 采集 ───────────────────────────────────────────────────────────────
/** id → { url, type, wallTimeMs, startMono, status, protocol, fromCache, bytes, endMono, failed } */
const net = new Map();
let clockOffsetMs = null; // monotonic→epoch 的偏移（取首条事件的 wallTime-timestamp）

function phaseOf(epochMs, markers) {
  if (!markers.t_lobby || epochMs < markers.t_lobby) return '① 导航→大厅';
  if (!markers.t_deal || epochMs < markers.t_deal) return '② 大厅→发牌';
  return '③ 发牌后';
}

function wireNetwork(cdp, markers) {
  cdp.on((msg) => {
    const p = msg.params;
    if (msg.method === 'Network.requestWillBeSent') {
      if (clockOffsetMs === null) clockOffsetMs = p.wallTime * 1000 - p.timestamp * 1000;
      net.set(p.requestId, {
        url: p.request.url,
        type: p.type,
        epochMs: p.timestamp * 1000 + clockOffsetMs,
        startMono: p.timestamp,
        status: null, protocol: null, fromCache: false, bytes: 0, endMono: null, failed: null,
      });
    } else if (msg.method === 'Network.responseReceived') {
      const e = net.get(p.requestId);
      if (e) {
        e.status = p.response.status;
        e.protocol = p.response.protocol;
        e.fromCache = !!(p.response.fromDiskCache || p.response.fromPrefetchCache || p.response.fromServiceWorker);
        e.mimeType = p.response.mimeType;
        e.responseMono = p.timestamp;
      }
    } else if (msg.method === 'Network.loadingFinished') {
      const e = net.get(p.requestId);
      if (e) {
        e.bytes = p.encodedDataLength;
        e.endMono = p.timestamp;
      }
    } else if (msg.method === 'Network.loadingFailed') {
      const e = net.get(p.requestId);
      if (e) e.failed = p.errorText;
    }
  });
}

function summarize() {
  const all = [...net.values()].filter((e) => e.type !== 'Preflight');
  const done = all.filter((e) => e.endMono !== null);
  const totalBytes = done.reduce((s, e) => s + e.bytes, 0);
  const byType = {};
  for (const e of done) {
    byType[e.type] ??= { n: 0, bytes: 0 };
    byType[e.type].n += 1;
    byType[e.type].bytes += e.bytes;
  }
  const dur = (e) => (e.endMono !== null && e.startMono !== null ? (e.endMono - e.startMono) * 1000 : null);
  const ttfb = (e) => (e.responseMono && e.startMono ? (e.responseMono - e.startMono) * 1000 : null);
  const shape = (e) => ({
    url: e.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 90),
    type: e.type,
    status: e.status ?? (e.failed ? `FAIL:${e.failed}` : '?'),
    kb: +(e.bytes / 1024).toFixed(1),
    ms: dur(e) === null ? null : +dur(e).toFixed(0),
    ttfbMs: ttfb(e) === null ? null : +ttfb(e).toFixed(0),
    cache: e.fromCache,
    proto: e.protocol,
  });
  return { all: all.length, done: done.length, totalBytes, byType, shape };
}

function printReport(markers) {
  const { all, done, totalBytes, byType, shape } = summarize();
  console.log('\n========== 汇总 ==========');
  console.log(`请求数 ${all}（完成 ${done}）· 传输总计 ${(totalBytes / 1024).toFixed(1)} KB`);
  for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${t.padEnd(10)} ${String(v.n).padStart(3)} 件  ${(v.bytes / 1024).toFixed(1).padStart(9)} KB`);
  }
  const phases = {};
  for (const e of net.values()) {
    if (e.endMono === null) continue;
    const ph = phaseOf(e.epochMs, markers);
    phases[ph] ??= { n: 0, bytes: 0 };
    phases[ph].n += 1;
    phases[ph].bytes += e.bytes;
  }
  console.log('— 按阶段 —');
  for (const [ph, v] of Object.entries(phases)) console.log(`  ${ph}: ${v.n} 件 / ${(v.bytes / 1024).toFixed(1)} KB`);
  console.log('— 最慢 12 条 —');
  const slow = [...net.values()].filter((e) => e.endMono !== null).sort((a, b) => (b.endMono - b.startMono) - (a.endMono - a.startMono)).slice(0, 12);
  for (const e of slow.map(shape)) console.log(`  ${String(e.ms).padStart(6)}ms  TTFB ${String(e.ttfbMs).padStart(5)}ms  ${String(e.kb).padStart(8)}KB  ${e.type.padEnd(9)} ${e.status}  ${e.url}`);
  console.log('— 最大 12 条 —');
  const big = [...net.values()].filter((e) => e.endMono !== null).sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  for (const e of big.map(shape)) console.log(`  ${String(e.kb).padStart(8)}KB  ${String(e.ms).padStart(6)}ms  ${e.type.padEnd(9)} ${e.status}  ${e.url}`);
  const chars = [...net.values()].filter((e) => /static\/(cards|av|ui)\//.test(e.url) && e.type === 'Image');
  if (chars.length > 0) {
    console.log(`— 素材图片（cards/av/ui）共 ${chars.length} 件 / ${(chars.reduce((s, e) => s + e.bytes, 0) / 1024).toFixed(1)} KB —`);
    for (const e of chars.sort((a, b) => (a.epochMs ?? 0) - (b.epochMs ?? 0)).map(shape)) {
      console.log(`  ${e.ms === null ? '   --' : String(e.ms).padStart(5)}ms  ${String(e.kb).padStart(8)}KB  ${e.status}  ${e.url}`);
    }
  }
  const first = [...net.values()].find((e) => e.type === 'Document');
  console.log('— 阶段时刻（相对导航）—');
  for (const [k, v] of Object.entries(markers)) {
    if (!v || k === 't0') continue;
    console.log(`  ${k}: +${((v - markers.t0) / 1000).toFixed(2)}s`);
  }
  if (first) console.log(`  导航首字节请求: ${first.url}`);
}

// ─── 场景 ───────────────────────────────────────────────────────────────
async function runFull(cdp, markers) {
  await cdp.send('Page.navigate', { url: BASE_URL });
  const inputs = await waitForSelector(cdp, '.login__field input', 40000);
  if (inputs < 2) throw new Error(`登录表单未出现（inputs=${inputs}）`);

  let phone, password, action;
  if (LOGIN) {
    [phone, password] = LOGIN.split(':');
    action = '登录';
  } else {
    phone = `1${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 10)}`;
    password = 'perf-waterfall-pass';
    action = '注册';
  }
  const filled = await cdp.eval(`(() => {
    const inputs = document.querySelectorAll('.login__field input');
    if (inputs.length < 2) return 'no-inputs';
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(inputs[0], ${JSON.stringify(phone)});
    set(inputs[1], ${JSON.stringify(password)});
    return 'filled';
  })()`);
  log(`${action}账号 ${phone}（fill=${filled}）`);
  const clicked = await cdp.eval(clickByText('.login__actions .btn', action));
  log(`点击「${action}」= ${clicked}`);

  const lobby = await waitForSelector(cdp, '.lobby__mode', 30000);
  if (lobby === 0) throw new Error('注册/登录后 30s 未进大厅');
  markers.t_lobby = Date.now();

  await cdp.eval(`(() => { const el = document.querySelector('.lobby__mode'); if (el) el.click(); return el ? 'ok' : 'none'; })()`);
  const level = await waitForSelector(cdp, '.lobby__level', 20000);
  await cdp.eval(`(() => { const el = document.querySelector('.lobby__level'); if (el) el.click(); return el ? 'ok' : 'none'; })()`);
  const match = await waitForSelector(cdp, '.game__match .btn', 20000);
  if (match === 0) throw new Error(`玩法页未出现（level=${level}）`);
  const clickedMatch = await cdp.eval(clickByText('.game__match .btn', '开始游戏'));
  markers.t_matchClick = Date.now();
  log(`点击「开始游戏」= ${clickedMatch}`);

  const cards = await waitForSelectorCount(cdp, '.table__me .card', 17, MATCH_TIMEOUT_MS);
  if (cards < 17) throw new Error(`发牌超时：${cards}/17 张`);
  markers.t_deal = Date.now();
  log(`发牌完成：${cards} 张手牌`);
  // 再歇一会儿，把尾部的懒加载（音效/余图）收进记录
  await sleep(2500);
  markers.t_end = Date.now();
  return { cards };
}

async function runHome(cdp, markers) {
  await cdp.send('Page.navigate', { url: BASE_URL });
  await waitForSelector(cdp, '#app', 40000);
  await sleep(8000); // 等首屏的懒加载都落地
  markers.t_end = Date.now();
  return {};
}

// ─── 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== [perf-waterfall] scenario=${SCENARIO} proxy=${PROXY} base=${BASE_URL} ===`);
  const markers = { t0: Date.now() };
  const chrome = await launchChrome();
  if (chrome.error) {
    console.error(`❌ ${chrome.error}`);
    process.exit(2);
  }
  log(`chromium = ${chrome.bin}`);

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  wireNetwork(cdp, markers);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  let result = null;
  let error = null;
  try {
    result = SCENARIO === 'home' ? await runHome(cdp, markers) : await runFull(cdp, markers);
  } catch (err) {
    error = err?.message ?? String(err);
    markers.t_end = Date.now();
  }

  const { all, done, totalBytes, byType, shape } = summarize();
  printReport(markers);
  const out = {
    meta: { baseUrl: BASE_URL, proxy: PROXY, scenario: SCENARIO, login: LOGIN ? '(provided)' : '(fresh)', startedAt: new Date(markers.t0).toISOString(), error },
    markers,
    totals: { all, done, totalBytes, byType },
    requests: [...net.values()].map((e) => ({ ...shape(e), url: e.url, epochMs: e.epochMs === null ? null : Math.round(e.epochMs), phase: phaseOf(e.epochMs, markers) })),
    result,
  };
  writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`\nJSON 证据：${JSON_OUT}`);

  if (KEEP_OPEN) {
    console.log(`（--keep-open：浏览器保留在 CDP ${CDP_PORT}，手动收尾：taskkill /F /IM chrome.exe）`);
  } else {
    shutdownSync();
  }
  if (error) {
    console.error(`❌ ${error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  shutdownSync();
  process.exit(1);
});
