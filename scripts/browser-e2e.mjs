#!/usr/bin/env node
/**
 * 真浏览器端到端探针（`docs/superpowers/plans/agent-briefs.md` 的「真浏览器验证」一节的机械化形态）。
 *
 * ## 它守的是哪条接缝
 *
 * 本仓的 13 条 conformance 全是**协议级**（自己拼 WS 帧），客户端单测跑在 **mock** 上
 * ⇒「**前端 ↔ 真后端**」这条接缝长期无人覆盖。B1/B2（N28/N29）就是这样活下来的：
 * mock 发 `socket.emit(type, checked)`（body 带 `type`）、真网关发 `client.emit(type, message)`
 * （body 不带 `type`）⇒ **对着 mock 能过、对着真网关必挂**，而 CI 里没有浏览器。
 *
 * ⇒ 本脚本跑在**真 chromium + 真 Vite 页面 + 真网关 + 真 socket.io** 上，判据取「**用户能看见的那一步**」：
 * **`game.deal` 被客户端 store 接受**（`store.view.roomCode === 新房间` 且 `hand.length === 17`、牌桌真的渲染出 17 张牌）。
 * 这一步同时守住 N28（推送线格式）与 N29/B2（默认端点指向真网关）——
 * 二者任一复发，hand 恒为 0，断言当场红。
 *
 * ## 为什么零依赖
 *
 * Node v24 有内置 `WebSocket`，Playwright 缓存的 chromium 支持 `--remote-debugging-port`
 * ⇒ 直连 **CDP**，用 `Runtime.evaluate` 驱动 DOM、`Runtime.exceptionThrown` 抓异常、
 * `Network.webSocketFrameSent` 数帧。**不装任何 npm 依赖**（`pnpm-lock.yaml` 归协调者，且本机镜像源脆弱）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/browser-e2e.mjs                       # 门禁判据：最小路径 + N32 受控复现（~90s）
 * node scripts/browser-e2e.mjs --scenario full       # 外加「真打完一局 → 第二局」的完整路径（~4min）
 * node scripts/browser-e2e.mjs --scenario minimal    # 只跑最小路径（一条匹配，~40s）
 * node scripts/browser-e2e.mjs --trace               # 实时打印帧/状态时间线（诊断用）
 * node scripts/browser-e2e.mjs --no-server           # 不自动拉起 dev server（复用已在跑的）
 * node scripts/browser-e2e.mjs --keep-open           # 保留浏览器与截图，便于人工看
 * node scripts/browser-e2e.mjs --cdp-port 9444 --base-url http://localhost:5174/
 * ```
 *
 * 前置：9 个容器在跑（`DOCKER_BUILDKIT=0 docker compose build && docker compose up -d`）。
 * dev server（默认 `http://localhost:5173/`）不在跑时本脚本会**自己拉起来**并在退出时关掉
 * （按**进程组** SIGTERM→SIGKILL，退出后 5173/9333 必须是空的）。
 *
 * ⚠️ **与 conformance 同属独占纪律**：它经 5173 → 3000 打真网关，而网关按 IP 计并发 WS 连接
 * （上限 5，§5.4）⇒ 同一时刻只跑一个；跑它时不要重建镜像/重启容器。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ─── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const BASE_URL = opt('base-url', 'http://localhost:5173/');
const SCENARIO = opt('scenario', 'gate'); // gate | minimal | second-game | full | pdk | pdk2
const NO_SERVER = flag('no-server');
const KEEP_OPEN = flag('keep-open');
const MATCH_TIMEOUT_MS = Number(opt('match-timeout-ms', '120000'));
const GAME_TIMEOUT_MS = Number(opt('game-timeout-ms', '420000'));
const CDP_PORT = Number(opt('cdp-port', '9333'));

// ─── 断言与输出 ──────────────────────────────────────────────────────────
const TRACE = flag('trace');
/**
 * 运行期计数器（跨步骤累计，断言用**增量**）。
 *  - `reconnectFrames`：C→S 的 `game.reconnect` 帧数（M08 回退若无复位就会连发 ⇒ N32 的重连风暴）；
 *  - `rollbackEvents`：store 的 `rollback` 由 null 变非 null 的次数（= 「新局快照被误判为 M08 回退」的次数）。
 */
const run = { reconnectFrames: 0, rollbackEvents: 0 };
const results = [];
const traceLog = [];
let traceT0 = Date.now();
function trace(line) {
  const entry = `+${((Date.now() - traceT0) / 1000).toFixed(2)}s ${line}`;
  traceLog.push(entry);
  if (traceLog.length > 200) traceLog.shift();
  if (TRACE) console.log(`   ~ ${entry}`);
}
function dumpTrace(n = 40) {
  if (TRACE) return;
  console.log(`   （加 --trace 可看帧时间线；以下为最后 ${n} 条）`);
  for (const l of traceLog.slice(-n)) console.log(`   ~ ${l}`);
}
let stepNo = 0;
function check(label, ok, detail = '') {
  stepNo += 1;
  results.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${String(stepNo).padStart(2, '0')}] ${label}${detail ? `\n      ${detail}` : ''}`);
  return !!ok;
}
function info(msg) {
  console.log(`   · ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 子进程（chrome / dev server）────────────────────────────────────────
/**
 * 本脚本拉起的子进程（chromium / vite）。**必须在任何退出路径上回收**，否则会在 5173/9333
 * 留下脏进程，下一次运行会读到上一次的 dev server 或撞端口（本仓已有「残留进程占端口」的前科）。
 *
 * ⚠️ 实测两个坑（都已按此实现）：
 *  1. 子进程都用 `detached: true` 起，因此**必须按进程组**杀（`kill(-pid)`）——
 *     `pnpm dev` 的 `sh -c vite` 与 chromium 的 zygote/renderer 都在同一组里；
 *     只杀直接子进程会留下一串孤儿。
 *  2. **只有 SIGTERM 不够**：chromium 在 headless 下实测会活过 SIGTERM
 *     ⇒ SIGTERM 之后**必须**补一次 SIGKILL，并在退出前**验证**端口已释放。
 */
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
  sleepSync(400); // 给优雅退出一个窗口
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

/**
 * dev server：**已在跑就直接复用**（本仓的常态是一个常驻 5173），否则自己拉起来。
 *
 * ⚠️ 必须用 `detached: true` 建进程组，退出时按**组**杀 —— 只杀 `pnpm` 会留下 `vite` 子进程占着 5173。
 */
async function ensureDevServer() {
  if (await httpOk(BASE_URL)) {
    info(`dev server 已在跑，复用：${BASE_URL}`);
    return { started: false };
  }
  if (NO_SERVER) {
    check(`dev server 可用（${BASE_URL}）`, false, '--no-server 指定了复用，但该地址不可达');
    return { started: false, failed: true };
  }
  info(`dev server 不在跑，自行拉起（apps/client 的 pnpm dev）…`);
  const child = spawn('pnpm', ['dev'], {
    cwd: join(ROOT, 'apps', 'client'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await httpOk(BASE_URL)) {
      info('dev server 就绪');
      return { started: true };
    }
    await sleep(500);
  }
  check('dev server 可拉起', false, `60s 内未就绪；子进程输出：\n${log.slice(-800)}`);
  return { started: true, failed: true };
}

async function launchChrome() {
  const bin = findChrome();
  if (!bin) return { error: '找不到 chromium（设 CHROME_BIN，或让 ~/.cache/ms-playwright 里有一份）' };
  // ⚠️ 沙箱下 `$HOME` 与 `/dev/shm` 都不可写：crashpad 写配置失败会直接 abort（实测 core dumped）。
  //    必须把 HOME 指向临时目录 + `--disable-dev-shm-usage` + `--disable-crash-reporter`。
  const profile = mkdtempSync(join(tmpdir(), 'ftl-browser-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-crash-reporter',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', env: { ...process.env, HOME: profile } },
  );
  children.push(child);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`, 1500)) return { bin, profile };
    await sleep(300);
  }
  return { error: 'chromium 30s 内没有暴露 CDP 端口' };
}

// ─── CDP 客户端 ─────────────────────────────────────────────────────────
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
        msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`)) : resolve(msg.result);
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
  /** 求值一个表达式；异常**不吞**（探针自己出错必须红，不能被当成「页面出错」）。 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面求值抛错：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result.value;
  }
}

// ─── 页面侧小工具（作为表达式注入）─────────────────────────────────────
/**
 * 读 pinia store 的关键状态。
 *
 * ⚠️ 走的是 `#app.__vue_app__.config.globalProperties.$pinia._s`（**内部**结构，仅供探针）。
 * 它比「数 DOM 节点」更早、更精确地反映「`game.deal` 有没有被 store 接受」——
 * 而这正是 N28 的判据（推送被拒 ⇒ `view` 恒 `null`）。DOM 计数仍然**同时**断言（用户能看见的那一步）。
 */
const READ_STATE = `(() => {
  const app = document.querySelector('#app')?.__vue_app__;
  const pinia = app?.config?.globalProperties?.$pinia;
  const store = pinia?._s?.get('game');
  const auth = pinia?._s?.get('auth');
  if (!store || !auth) return { ready: false };
  return {
    ready: true,
    page: auth.page,
    authenticated: auth.loggedIn,
    loginError: auth.error,
    roomCode: store.roomCode,
    version: store.currentVersion,
    viewRoom: store.view?.roomCode ?? null,
    viewState: store.view?.state ?? null,
    hand: store.hand.length,
    matching: store.matching,
    rollback: store.rollback,
    lastSnapshotOutcome: store.lastSnapshotOutcome,
    renderedCards:
      document.querySelectorAll('.table__me .card').length ||
      document.querySelectorAll('.pdk__me .card').length,
    isMyTurn: store.isMyTurn,
    gameType: store.view?.gameType ?? 'doudizhu',
    pdkPlayerCount: store.view?.playerCount ?? null,
    pdkCanPass: store.view?.canPass ?? null,
    // 协议 ④：读窗口（旧 store.lastPlayedHand 已退役）。窗口里有非 null ⇒ 有人出过牌 ⇒ 可以过牌。
    // 等价性（「窗口里有非 null」⟺「lastPlayedHand !== null」）由 shared/ddz/recent.test.ts 的
    // 不变式② 钉住；不成立时这里会**静默走错分支**（表现为 30 秒超时，而不是红）—— 所以那条判据是前提。
    // ⚠️ 本注释在**模板字面量内**：不得出现反引号（会截断 READ_STATE 的字符串）。
    canPass: (store.recentActions ?? []).some((a) => a.cards !== null),
    ended: store.view?.state === 'ended',
    settlementSeen: store.settlement !== null,
    notice: document.querySelector('.notice__text')?.innerText ?? null,
    bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220),
  };
})()`;

/**
 * 按文本点击。**选择器锚在 class 上，不锚在标签名上。**
 *
 * ⚠️ 切片 P10 Task 0 实测（该片的 **R449 + R449 补**）：迁到 uni-app 后 `<button class="btn">`
 * 在 H5 的真实 DOM 是 **`<uni-button class="btn">`**（页面里 `querySelectorAll('button')` = 0），
 * 因此旧的 `.login__actions button` 这类**标签选择器恒 0 命中**（表现为 `not-found`）。
 * 而 Task 2 还可能把按钮换成组件库组件（`<u-button>` 之类）⇒ 写死 `uni-button` 会再断一次。
 * ⇒ 统一改成 **class 锚点**（`.btn` 是这些按钮的既有 class，R432 保证 class 名不改）。
 * 其余 9 个选择器本就是 class 锚点，实测不受影响。
 */
const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
  if (!el) return 'not-found';
  el.click();
  return 'clicked';
})()`;

// ─── 场景步骤 ───────────────────────────────────────────────────────────
async function waitFor(cdp, predicateLabel, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let prevKey = '';
  while (Date.now() < deadline) {
    last = await cdp.eval(READ_STATE);
    // 状态变化的**时间线**是诊断 N32 那一类缺陷的主要线索（页面/版本/手牌/匹配态/回退态）
    const key = `${last.page}|${last.roomCode}|v${last.version}|hand${last.hand}|match${last.matching}|rb${!!last.rollback}`;
    if (key !== prevKey) {
      trace(`state ${key} notice=${last.notice ?? '(无)'}`);
      if (last.rollback && !prevKey.includes('rbtrue')) run.rollbackEvents += 1;
      prevKey = key;
    }
    if (last.ready && predicate(last)) return last;
    await sleep(400);
  }
  return { ...last, __timeout: true, __label: predicateLabel };
}

async function gotoApp(cdp) {
  await cdp.send('Page.navigate', { url: BASE_URL });
  const st = await waitFor(cdp, '应用挂载', (s) => s.ready, 30000);
  return st;
}

/**
 * 等某个选择器**真的有元素**再动手（切片 P10 Task 2 门禁期实测的**假红**根因）。
 *
 * ⚠️ 为什么必须有：`waitFor(... s.ready ...)` 只保证 **pinia store 已就绪**（`main.ts` 里建好即可），
 * 而**页面 DOM** 是随后才渲染的；冷启动（dev server 刚拉起、要现编译 wot-design-uni 与 scss）时，
 * 「填表 → 点注册」可能整段落在 DOM 之前：`registerFresh` 里 `inputs.length < 2` 会**静默返回**
 * `'no-inputs'`，而 `clickByText` 的 `'not-found'` 此前**没有被断言** ⇒ 表现为
 * 「注册成功并进入大厅」这一条红、后面几条跟着红，但**看不出是没点着还是真缺陷**。
 * ⇒ 动手前先等元素；并把点击结果**带进判据的 detail**（判据本身不变，只是不再沉默）。
 */
async function waitForSelector(cdp, selector, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (n > 0) return n;
    await sleep(200);
  }
  return n;
}

/**
 * 等某个选择器**达到 N 个元素**（切片 P10 Task 3 门禁期实测的**第二类假红**根因）。
 *
 * ⚠️ 为什么还要它：Task 3 把「页壳 + `<component :is>`」换成**真实 uni 页面栈**后，
 * `auth.page` 是 `navigate()` **先写**进 store、再 `uni.reLaunch` 的 ⇒
 * `READ_STATE` 读到 `page=table / hand=17` 时，**牌桌页面可能还没挂载渲染**（冷启动要现编译页面 chunk）。
 * 于是「恰好那一刻数 DOM 牌数」会数到 0 张 —— 但这不是产品缺陷（后续轮询能看到 17 张），
 * 而是「判据取在了渲染之前」。⇒ 给渲染一个有界窗口（判据本身不变：仍然要求 ≥ 17 张）。
 */
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

async function registerFresh(cdp) {
  const phone = `1${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 10)}`;
  /**
   * 🔴 T5-O1 修复（2026-10-12，测试基建维护）：2026-10-10 登录分段去重（`2a965e4` 落地）后，
   * `.login__actions` 只剩**一颗**主按钮（文案随 `.login__seg` 形态变「登录/注册」，旧版那颗
   * 「直接提交注册」的次按钮已删）⇒ 注册 = **两步**：先点分段「注册」、再点主按钮。
   * 本函数自 2026-10-02 后无人跑、未随迁 ⇒ 探针红在注册步（`click=not-found`；T5-O1 登记）。
   * ⚠️ 类名/文本/形态切换已按**真浏览器 CDP 实读**核定（`.superpowers/sdd/t5o1-domprobe.mjs`）：
   * 默认态 seg=[登录,注册]（`.login__seg-item`）、主按钮=「登录」、输入框 2；点分段「注册」后
   * seg 选中态 = `login__seg-item--active`、主按钮=「注册」、输入框 **4**：手机号 / 密码 /
   * 确认密码（`login.vue` 的本地校验要求与密码一致）/ **昵称**（昵称片后新增，必填，≤20 字）。
   * ⚠️ 2026-10-21（提示收敛 Task 11 门禁）：昵称字段加入后本函数仍按 3 框填写 ⇒ 校验
   * 恒报「请输入昵称」、注册永远停在登录页。按实读改为 4 框（顺序即模板顺序）。
   */
  const inputs = await waitForSelector(cdp, '.login__field input', 20000);

  /**
   * **提示浮层在 H5 上的真实挂载判据**（提示收敛片 Task 11）：登录页就绪、填字段**之前**，
   * 直接点主按钮提交空表单 ⇒ 本地校验必须落进 `NoticeStack` 的 `.notice__text`
   *（`.stage__overlay .notice-stack` 的真实浏览器证据，jsdom 源码级判据之外的观感门禁）。
   * 文案含「请输入」= `validate()` 的第一条（手机号为空）。失败即早停：页面提示通道坏掉时，
   * 后面的注册/匹配失败诊断都会失真。
   */
  const clickedEmptySubmit = await cdp.eval(`(() => {
    const el = document.querySelector('.login__actions .btn--primary');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clickedEmptySubmit) throw new Error('登录页主按钮不存在');
  const noticeReady = await waitForSelector(cdp, '.notice__text', 5000);
  if (!noticeReady) throw new Error('空表单提交后未出现浮动提示');
  const noticeText = await cdp.eval(`document.querySelector('.notice__text')?.innerText ?? ''`);
  if (!noticeText.includes('请输入')) throw new Error(`浮动提示文案异常: ${noticeText}`);

  const segClicked = await cdp.eval(clickByText('.login__seg-item', '注册'));
  const registerInputs = await waitForSelectorCount(cdp, '.login__field input', 4, 10000);
  const filled = await cdp.eval(`(() => {
    const inputs = document.querySelectorAll('.login__field input');
    if (inputs.length < 4) return 'no-inputs';
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(inputs[0], ${JSON.stringify(phone)});
    set(inputs[1], 'browser-e2e-pass');
    set(inputs[2], 'browser-e2e-pass');
    set(inputs[3], ${JSON.stringify(`e2e${phone.slice(-6)}`)});
    return 'filled';
  })()`);
  const clicked = await cdp.eval(clickByText('.login__actions .btn', '注册'));
  const st = await waitFor(cdp, '注册后进入大厅', (s) => s.authenticated && s.page === 'lobby', 30000);
  check(
    '注册成功并进入大厅',
    !st.__timeout,
    `page=${st.page} authenticated=${st.authenticated} error=${st.loginError || '(无)'} formInputs=${inputs} 分段=${segClicked}(${registerInputs}) fill=${filled} click=${clicked}`,
  );
  return phone;
}

async function matchAndWaitDeal(cdp, label) {
  const rollbackBefore = run.rollbackEvents;
  /**
   * ⚠️ **片③（首次改动）**：大厅拆成了「大厅（选玩法）」+「玩法页（房间列表+开局按钮）」。
   * 本函数的**三种调用时机**都可能落在**大厅**上：
   *   ① 刚注册完（`registerFresh` 之后）② 受控复现注入之后（`seedFinishedGame` 之后，
   * 此时人还在大厅）③ `backToLobby` 之后（真打完一局再开第二局）。
   * ⇒ **必须在这里**保证「先到玩法页」，放在 `registerFresh` 里会漏掉后两次。
   *
   * ⚠️ **一次等「任一页面就绪」**（`'.lobby__mode, .game__match .btn'`，20s），再按**落在哪个页面**分支：
   * 不用「先探大厅 2.5s、再等玩法页 20s」那种两段式 —— 它把「冷启动编译大厅 chunk 的耗时」
   * 夹在两段之间（探成 0 ⇒ 跳过点卡 ⇒ 后面等玩法页也在等一个还没到的页面 ⇒ 红得与本次改动无关）。
   * 现在只等**一次**：等到哪个页面就是哪个页面，时序假设清零。
   */
  /**
   * ⚠️ **片② 客户端（第二次改动）**：大厅的流转变了 ——
   * **点玩法卡 = 只切换选中**、**点底分卡 = 进开始游戏页**（片规格 §3 裁决一）。
   * ⇒ 原来「点 `.lobby__mode` 然后等 `.game__match .btn`」这一步**当场断**（干等 20s 超时）。
   * 现在按**两步**走，并各留一条判据：这正是本片要守的那条行为变更。
   */
  await waitForSelector(cdp, '.lobby__mode, .game__match .btn', 20000);
  const onLobby = await cdp.eval(`document.querySelectorAll('.lobby__mode').length`);
  if (onLobby > 0) {
    // ① 点玩法卡：**只切换选中、不得跳页**
    const clickedMode = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__mode');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    const afterModeClick = await cdp.eval(READ_STATE);
    check(
      `${label}：点玩法卡**只切换选中、不跳页**（片规格 §3 裁决一 · 行为变更）`,
      clickedMode === 'clicked' && afterModeClick.page === 'lobby',
      `click=${clickedMode} page=${afterModeClick.page}（期望仍是 lobby）`,
    );

    // ② 点底分卡：**这才进开始游戏页**。底分卡要等 REST（片⑦ 起 `GET /api/config`
    // 的 baseScoreLevels —— 旧端点 `GET /api/base-score-levels` 已退役）回来
    const levelsReady = await waitForSelector(cdp, '.lobby__level', 20000);
    const levelName = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__level-name');
      return el ? el.textContent.trim() : null;
    })()`);
    const clickedLevel = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__level');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    const intoGame = await waitForSelector(cdp, '.game__match .btn', 20000);
    check(
      `${label}：点底分卡进入开始游戏页（片规格 §3 裁决一）`,
      intoGame > 0,
      `click=${clickedLevel} .lobby__level=${levelsReady} 档位名=${levelName ?? '(无)'} .game__match .btn=${intoGame}`,
    );

    /**
     * ③ **两页之间的接口**（片规格 §3 的第二个接口）：开始游戏页的场次名**复用**大厅取到的
     * 档位表（不是重调接口、更不是编一个名字）⇒ 它必须**逐字等于**刚才那张卡上的名字。
     * 这是「store 当跨页载体」这条设计在**真栈上**的唯一证据。
     */
    const sceneText = await cdp.eval(`(() => {
      const el = document.querySelector('.game__scene');
      return el ? el.textContent.trim() : null;
    })()`);
    check(
      `${label}：开始游戏页的场次名来自档位表（两页接口的端到端证据）`,
      !!levelName && (sceneText ?? '').includes(levelName),
      `档位表名=${levelName ?? '(无)'} 开始游戏页="${sceneText ?? '(无)'}"`,
    );
  }
  await waitForSelector(cdp, '.game__match .btn', 20000);
  // ⚠️ 文案按片规格 §4 改成「开始游戏」（原「随机匹配」）—— 它是 `.game__match` 里唯一的主按钮
  const clickedMatch = await cdp.eval(clickByText('.game__match .btn', '开始游戏'));
  const st = await waitFor(
    cdp,
    '收到并应用 game.deal',
    (s) => s.page === 'table' && s.hand >= 17 && s.viewRoom === s.roomCode,
    MATCH_TIMEOUT_MS,
  );
  const ok = !st.__timeout;
  // ⚠️ 页面栈（Task 3）之后，store 的 `page=table` 早于**牌桌页面渲染** ⇒ 数 DOM 前要有界地等一次。
  const renderedCards = ok ? await waitForSelectorCount(cdp, '.table__me .card', 17, 12000) : st.renderedCards;
  check(
    `${label}：开始游戏 → game.deal 被客户端接受（进入牌桌）`,
    ok,
    ok
      ? `房间 ${st.roomCode} v${st.version} state=${st.viewState} hand=${st.hand} DOM 渲染牌数=${renderedCards}`
      : `超时：page=${st.page} roomCode=${st.roomCode} version=${st.version} viewRoom=${st.viewRoom} hand=${st.hand} matching=${st.matching} notice=${st.notice ?? '(无)'} click=${clickedMatch} body="${st.bodyText}"`,
  );
  check(
    `${label}：牌桌真的渲染出 17 张手牌（用户能看见的那一步）`,
    renderedCards >= 17,
    `DOM .table__me .card = ${renderedCards}（页面栈后 DOM 渲染晚于 store，这里最多等 12s；阈值不变）`,
  );
  check(
    `${label}：新局的快照**没有**被误判成 M08 回退`,
    run.rollbackEvents === rollbackBefore,
    `本窗口内 store 回退事件 = ${run.rollbackEvents - rollbackBefore}（未修实现实测 1 次，告警条逐字「reconnect_ack 快照 version 1 回退于已应用的 50」）`,
  );
  return st;
}

/**
 * N32 的**受控复现**：把 store 造成「上一局打到 v50 已结束、且 `roomCode` 停在上一局」的形态。
 *
 * 为什么不真打完一局：本仓一局（叫抢 + 逐手出牌 + 机器人思考）要几分钟，而 N32 的**触发前提**
 * 只有一条 ——「`room.matched` 到达时，store 里留着一个比新局大的 `currentVersion`」。
 * 受控复现把这个前提**原样**造出来，其余（新房间、真网关、真 socket、真 `game.deal`）全是真的。
 * ⚠️ 与 N32 的原始现场对齐的两点：① `roomCode` **非 null**（「返回大厅」在**等待/结算**相位
 * 只 `navigate`、不清 store——受控复现对齐的就是这一形态；**进行中**相位自本片（2026-10-12
 * 「返回大厅」弃局出口）起 = 确认退出，确认即 `room.leave` 真弃局，不再只导航）；②
 * `view.state === 'ended'`（上一局的外观）。真打完一局的完整路径由 `--scenario full` 覆盖，
 * 两者共用同一条断言。
 *
 * ⚠️ **这份假视图刻意是残缺的**（协议 ④ 起：退役了 `lastPlayedHand`/`lastPlayerIdx`，且
 * **不补** `recentActions` / `baseScore` / `playPhase`）—— 它正是 R661 容忍判据的载体：
 * 客户端必须用 `?.` + 缺值兜底（`store.recentActions` 缺字段 ⇒ `[]`，**不抛错**）。
 * 补全它 = 把那条判据的载体拆掉（`table-bid-bottom.test.ts` 的同形夹具与本处对齐）。
 */
async function seedFinishedGame(cdp, markVersion = 50) {
  const body = await cdp.eval(`(() => {
    const app = document.querySelector('#app').__vue_app__;
    const store = app.config.globalProperties.$pinia._s.get('game');
    const staleRoom = 'ZZZZZZ';
    store.$patch({
      currentVersion: ${markVersion},
      roomCode: staleRoom,
      mySeat: 0,
      view: {
        roomCode: staleRoom, seat: 0, version: ${markVersion}, state: 'ended',
        hand: [], cardCounts: [0, 0, 0], landlordSeat: 0, bottomCards: null,
        currentPlayer: 0, turnDeadlineAt: null,
        bidPhase: { currentBidder: 0, bidMultiplier: 1, landlordCandidate: 0 },
      },
      rollback: null,
      finished: { winner: 'landlord' },
    });
    return { version: store.currentVersion, room: store.roomCode, state: store.view?.state, hand: store.hand.length };
  })()`);
  info(`受控注入「上一局已结束」形态：room=${body.room} v=${body.version} state=${body.state} hand=${body.hand}`);
  return body;
}

async function backToLobby(cdp) {
  await waitForSelector(cdp, '.table__lobby-back', 20000); // 同 registerFresh：动手前先等 DOM
  const clicked = await cdp.eval(`(() => {
    const el = document.querySelector('.table__lobby-back');
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
  /**
   * 本片（2026-10-12）起：**进行中**相位点「返回大厅」= `uni.showModal` 确认（确认 = 真
   * `room.leave` 弃局；只导航的形态只剩等待/结算/`view===null`，K3）。本函数唯一调用点
   * （判据 2′ 的 `waitFilledGame` 之后）**正是进行中相位** ⇒ 必须点掉确认钮，只等
   * 落 lobby 会停在牌桌上「等」到超时。
   * ⚠️ 类名 `.uni-modal__btn_primary`（confirm 钮，文本=confirmText；cancel 为
   * `.uni-modal__btn_default`）系**实读** `@dcloudio/uni-h5/dist/uni-h5.es.js` 产物核定
   * （规格 §0.3-10），不是按「预期 DOM」写的。
   */
  const modalBtn = await waitForSelector(cdp, '.uni-modal__btn_primary', 15000);
  const confirmed = await cdp.eval(`(() => {
    const el = document.querySelector('.uni-modal__btn_primary');
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
  const st = await waitFor(cdp, '确认退出后回到大厅', (s) => s.page === 'lobby', 15000);
  check(
    '进行中「返回大厅」：确认弹窗出现、点确认后确实落在大厅',
    modalBtn > 0 && confirmed === 'clicked' && !st.__timeout && st.page === 'lobby',
    `返回大厅 click=${clicked}；确认钮=${modalBtn} 确认 click=${confirmed}；` +
      `page=${st.page}${st.__timeout ? '（15s 超时）' : ''} room=${st.roomCode ?? '(无)'}`,
  );
  return st;
}

/**
 * 🟥 片⑦ setup：经**管理面**开启好友房，并**轮询至建房生效**（≤30s）。
 *
 * 为什么需要它：T11 起 `game.vue` 的好友房入口按 `store.friendRoomEnabled` 门控
 * （初值 false = fail-safe，配置来自 `GET /api/config`）；服务端侧 `POST /api/rooms`
 * 与 `:code/join` 也按同一开关拦（关 ⇒ 12006）。⇒ `--scenario full` 的
 * 「创建房间」那一段之前，必须把 `game.doudizhu.friendRoomEnabled` 置 true。
 *
 * ⚠️ 生效观测点 = **建房行为**（`POST /api/rooms` 得 code 0）—— 不是「库里的值」
 * （`GET /api/config` 每次查库、证不了消费侧缓存），而是 room-service 缓存的真实出口；
 * 与 conformance 的 `setFriendRooms` 同一判据（`tools/conformance/src/lib/http.ts`）。
 * ⚠️ 本脚本是**零依赖独立脚本**（见文件头）：这里自带 fetch 助手，不 import conformance 的 TS 库。
 * ⚠️ `ADMIN_PASSWORD` 默认值与 `scripts/deploy/conformance-stack.sh` 的 export、
 *    conformance 的 `lib/http.ts` 常量**三处同源**；本机 dev 栈引导口令对不上时
 *    （③ 起 `ADMIN_PASSWORD` 只在空表首启喂 bootstrap、不再是开关）用 hatch CLI 复位，
 *    或 `ADMIN_PASSWORD=... node scripts/browser-e2e.mjs` 覆盖。
 * ⚠️ 轮询产生的探针房是**副产品**（enable 路径必然建出一间，留在栈里随回收窗口消亡），无害。
 * ⚠️ 刻意**不还原**：开关的复原是 conformance slice-14 收尾的职责（片规格 §3 编排）。
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'conformance-admin-pass';
const GW_BASE = process.env.GW ?? 'http://localhost:3000';

/** 最小 REST 助手（走真网关；信封 `{code,...}` 原样交回，调用方判 code）。 */
async function gwJson(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${GW_BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { code: res.status, message: text };
  }
  return { status: res.status, body: parsed };
}

async function setupFriendRooms() {
  // ③ 起管理面按账号登录（引导账号名恒 `admin`）；与 `lib/http.ts` 的 `adminLogin()` 同形。
  const login = await gwJson('POST', '/api/admin/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  const admin = login.body?.data?.token;
  if (login.body?.code !== 0 || !admin) {
    throw new Error(`管理登录失败：HTTP ${login.status} ${JSON.stringify(login.body)}（口令与 conformance-stack.sh 同源？）`);
  }
  const put = await gwJson('PUT', '/api/admin/config/game.doudizhu.friendRoomEnabled', { body: { value: true }, token: admin });
  if (put.body?.code !== 0) {
    throw new Error(`置 friendRoomEnabled=true 失败：HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  // 探针账号（随开随弃）：轮询「建房行为」需要一个带真令牌的玩家
  const phone = `139${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
  const reg = await gwJson('POST', '/api/auth/register', {
    body: { phone, password: 'browser-e2e-pass', nickname: `setup-${phone.slice(-4)}` },
  });
  const player = reg.body?.data?.accessToken;
  if (reg.body?.code !== 0 || !player) {
    throw new Error(`探针账号注册失败：HTTP ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const deadline = Date.now() + 30000;
  for (;;) {
    const probe = await gwJson('POST', '/api/rooms', { body: { mode: 'random' }, token: player });
    if (probe.body?.code === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`friendRoomEnabled=true 30s 内未生效（最后一次 ${probe.body?.code}）`);
    }
    await sleep(1000);
  }
}

/**
 * 保证人**站在玩法页**上（并等建房按钮就位）。
 *
 * ⚠️ 两次实测才定下来的写法：**不能假设从哪来、也不能假设点一下走到哪** ——
 * `.table__bar` 的「返回大厅」实测有两条落点（玩法页 / 直接落大厅）。
 * ⇒ 按当前页面**逐段**走，每段都等落定；判据不依赖路径。
 */
async function ensureGamePage(cdp, label) {
  let st = await cdp.eval(READ_STATE);
  if (st.page === 'table') {
    await waitForSelector(cdp, '.table__lobby-back', 20000);
    await cdp.eval(`(() => {
      const el = document.querySelector('.table__lobby-back');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    st = await waitFor(cdp, `${label}：离开牌桌`, (s) => s.page !== 'table', 15000);
  }
  if (st.page === 'lobby') {
    // ⚠️ 片② 客户端：点玩法卡**只切换选中**，进页要点**底分卡**（片规格 §3 裁决一）。
    await waitForSelector(cdp, '.lobby__mode', 20000);
    await cdp.eval(`(() => { const el = document.querySelector('.lobby__mode'); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`);
    await waitForSelector(cdp, '.lobby__level', 20000);
    await cdp.eval(`(() => { const el = document.querySelector('.lobby__level'); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`);
    st = await waitFor(cdp, `${label}：进入开始游戏页`, (s) => s.page === 'game', 15000);
  }
  /**
   * 🔴 **建房 / 房号加入 / 房间列表三个锚点现在在「好友房」弹层里**（片规格 §4 裁决二）
   * ⇒ 关着的时候它们**不在 DOM 里**（这正是「收进弹层」的语义），动手前必须先打开它。
   * ⚠️ 这一步是**幂等**的：入口按钮把 `friendsOpen` 置 `true`（不是 toggle），
   * 所以「已经是开的」时再点一次不会把它关掉（`createRoomAndJoin` 的回程会再调本函数）。
   */
  await cdp.eval(clickByText('.game__friends-open', '好友房'));
  const ready = await waitForSelector(cdp, '.game__create-room', 20000);
  return { page: st.page, ready };
}

/**
 * 手动进房：**建房 → 进牌桌**（本片新增的那一步 · spec §5.3 / R811）。
 *
 * `previousRoom`：上一局的房号 —— 用来断言「进的是**新**房间」，否则「上一局的牌桌」
 * 会让整步**假绿**（第一次跑实测踩过，见下面第 ① 步的注释）。
 *
 * ⚠️ **为什么插在这里**（判据 2′ 的 `autoPlayUntilEnded` 之后、`backToLobby` 之前）：
 *  - **不能放 `matchAndWaitDeal` 内部**（初稿的写法）：那个函数**先等
 *    `.lobby__mode, .game__match .btn` 任一出现** —— 本步骤跑完人停在**牌桌**
 *    （两个锚点都没有）⇒ 那次 `waitForSelector` 会白等 20s，判据 1/2/2′ 全红，
 *    而且红在与本片无关的时序上。
 *  - **这一刻是干净的**：上一局已 `ended` ⇒ 放弃它无副作用（`waiting` 房间放弃则会留一个
 *    `1/3` 挂在列表里，要等 30–90s 的回收窗口）。
 *  - **回程原语**：`.table__bar .btn`（返回大厅）→ `.lobby__mode`（选玩法）→ `.lobby__level`
 *    （选底分并进入）→ `.game__friends-open`（开好友房）四段就回得来 —— 见 `ensureGamePage`。
 *
 * 🔴 **判据取「用户能看见的那一步」**：点「创建房间」之后**页面必须停在牌桌**
 *（且那个房间是**新的**）。旧实现（REST 建房不入座 + WS `room.join` 被 12004 拒）
 * 会因为 `BACK_TO_LOBBY` 被踢回**玩法页**。
 */
async function createRoomAndJoin(cdp, label, previousRoom) {
  const onStage = await ensureGamePage(cdp, label);
  check(
    `${label}：动手前人在玩法页、建房按钮在`,
    onStage.page === 'game' && onStage.ready > 0,
    `page=${onStage.page} .game__create-room=${onStage.ready}`,
  );

  /**
   * **空态文案（片③ F7 的生产端证据）**：房间列表为空时应显示「暂无房间」。
   * ⚠️ 这条**只记录、不断言**：列表是否为空取决于此刻服务端有几个房间（别的用例/上一次跑
   * 留下的都算），断言它会是**环境相关**的假红。它要证的那件事由 `auth-ui-wiring` 的
   * 源码级断言钉住（文案必须走 `finished-text`），这里只是**把生产里的实际文案打出来**。
   * 实测：F7 修之前这里打的是「已加载完毕」，修之后是「暂无房间」。
   */
  const emptyProbe = await cdp.eval(`(() => {
    const empty = document.querySelector('.game__empty');
    return { items: document.querySelectorAll('.game__item').length, text: empty ? empty.textContent.trim() : null };
  })()`);
  info(
    `${label}：空态记录 —— .game__item=${emptyProbe.items}，空态文案=` +
      (emptyProbe.text === null ? '(列表非空，未渲染空态)' : JSON.stringify(emptyProbe.text)),
  );

  const clicked = await cdp.eval(clickByText('.game__create-room', '创建房间'));
  check(`${label}：点上「创建房间」`, clicked === 'clicked', `click=${clicked}`);

  // ① 两步都成功才会进牌桌（REST 占座 + WS 挂载）
  const at = await waitFor(cdp, `${label}：进入牌桌`, (s) => s.page === 'table', 15000);
  check(
    `${label}：建房后**真的进了牌桌**`,
    !at.__timeout,
    `page=${at.page} roomCode=${at.roomCode} viewState=${at.viewState}`,
  );
  /**
   * ② **这个房间是新的**（不是上一局残留）—— 三条一起才排得掉假绿：
   *    · `roomCode` 非空、且**不等于上一局的房号**；
   *    · `view === null`：手动房间**没有开局链路**（spec §1.2 H3′）⇒ 服务端不会推 `game.deal`，
   *      因此「牌桌 + view 为 null」正是「刚进了一个新房间、对局还没起来」的形状。
   *      上一局的残留形态恰好相反（`view.state === 'ended'`）。
   */
  check(
    `${label}：进的是**新房间**（不是上一局残留）`,
    typeof at.roomCode === 'string' && at.roomCode.length > 0 && at.roomCode !== previousRoom &&
      at.viewState === null,
    `上一局 room=${previousRoom} → 现在 room=${at.roomCode} viewState=${at.viewState}（null = 新房间尚未开局）`,
  );

  // ③ 反向断言（本缺陷的判据）：旧实现在 12004 之后会被 `CLIENT_ACTION` 判 BACK_TO_LOBBY
  await new Promise((r) => setTimeout(r, 1200));
  const after = await cdp.eval(READ_STATE);
  check(
    `${label}：**没有被踢回玩法页**（旧实现会在 12004 后 BACK_TO_LOBBY）`,
    after.page === 'table',
    `page=${after.page}（table = 两步都成功；game = 被 12004 踢回）`,
  );

  /**
   * ④ **回玩法页后，列表里能看到真实的房间**（`loadRooms()` 的 REST → DOM 这一段）。
   * ⚠️ 判据取「至少有一行」，**不**比房号文本（房号在 `wd-cell` 的 `#title` 插槽里，
   * 比它就是比实现）。列表是**挂载时**拉的 ⇒ 先点「刷新」（既有锚点、也是用户的那一步）。
   */
  const back = await ensureGamePage(cdp, `${label}（回程）`);
  await cdp.eval(clickByText('.game__rooms-head .btn', '刷新'));
  const rows = await waitForSelector(cdp, '.game__item', 10000);
  check(
    `${label}：回玩法页后列表渲染出真实房间`,
    rows > 0,
    `page=${back.page} .game__item=${rows}`,
  );
  return after;
}

/**
 * **单人房 → 机器人补位 → 真的开局**（本片 · spec §6.3 / R903）。
 *
 * 接在 `createRoomAndJoin` 之后：那时用户刚建好一个**只有他自己**的练习房
 *（`createRoomAndJoin` 只验证「进得去」，不等人）。
 *
 * 判据取「用户能看见的那一步」：
 *  ① **不会提前补位**（负对照：建房后立刻看，手牌仍是空的 —— 证明「先等 20 秒」不是摆设）；
 *  ② 最终**真的发牌**（`.table__me .card` = 17）；
 *  ③ 期间**没有** `game.reconnect` 风暴；
 *  ④ 不打印精确等待秒数当作判据 —— 死线是 **20–30 秒的随机值**，
 *     精确断言必然 flaky。区间内的随机性由单测（注入随机源）钉住。
 *     ⚠️ `--scenario gate` 不跑这一步（它挂在判据 2′ 里）。
 */
async function waitFilledGame(cdp, label) {
  const startedAt = Date.now();
  const before = { ...(await cdp.eval(READ_STATE)), reconnects: run.reconnectFrames };

  // ① 负对照：刚建好的房里**还没有牌**
  check(
    `${label}：补位发生前手牌是空的（不得提前发牌）`,
    before.hand === 0 && before.roomCode !== null,
    `roomCode=${before.roomCode} hand=${before.hand}`,
  );

  // ② 等「真的发牌」：等死线（≤30s）+ 扫描周期（5s）+ 补位 + 开局
  const dealt = await waitFor(cdp, `${label}：机器人补位并开局`, (s) => s.hand >= 17, 70_000);
  const waited = Math.round((Date.now() - startedAt) / 1000);
  check(
    `${label}：单人房等来了机器人补位并真的发牌`,
    !dealt.__timeout,
    `room=${dealt.roomCode} viewState=${dealt.viewState} hand=${dealt.hand}（等了 ${waited}s）`,
  );
  const cards = await waitForSelector(cdp, '.table__me .card', 12000);
  check(
    `${label}：牌桌真的渲染出 17 张手牌（用户能看见的那一步）`,
    cards === 17,
    `DOM .table__me .card = ${cards}`,
  );

  // ③ 负对照：补位/开局期间不得出现重连风暴（N32 同族的判据）
  const storm = run.reconnectFrames - before.reconnects;
  check(`${label}：补位期间不出现 game.reconnect 重连风暴`, storm === 0, `本次窗口内帧数 = ${storm}`);
  return dealt;
}

/**
 * 一个「页面会话」= 一次 `Page.navigate` 到**未登录**状态。
 *
 * ⚠️ 必须清 `localStorage` 再加载：`auth.hydrate()` 会把上一次会话的令牌恢复回大厅
 * ⇒ 不清的话「注册」这一步会被**静默跳过**（页面本来就在大厅、连 `.login__field input` 都不存在），
 * 而断言仍然通过 —— 那正是本仓反复付代价的「假绿」形态（判据在空测上恒真）。
 * 两处硬断言：① 加载后必须停在**登录页**；② `localStorage` 必须是空的。
 */
async function newPageSession(cdp, label) {
  info(`--- ${label}：新页面会话（清本地会话后重新加载）---`);
  await gotoApp(cdp); // 先到应用源，否则 about:blank 上没有可清的 localStorage
  const cleared = await cdp.eval(`(() => { try { localStorage.clear(); return localStorage.length === 0; } catch (e) { return 'err:' + e.message; } })()`);
  const st = await gotoApp(cdp);
  check(`${label}：真页面加载并挂载 Vue 应用（真 Vite dev server）`, st.ready, `page=${st.page}`);
  check(`${label}：本地会话已清空、停在登录页（保证「注册」是真的走了一遍）`, cleared === true && st.page === 'login', `localStorage cleared=${cleared} page=${st.page}`);
  return st;
}

/**
 * 真人式自动出牌（**只做合法动作**，让一局真的走完）：
 *  - 叫抢期轮到我 → 「抢」；
 *  - 出牌期轮到我：窗口里没有出牌项（= 首出，§6.2-2 不得过牌）→ 选第一张牌打单张；
 *    否则 → 「过牌」（§6.2-3 最后出牌者不得过牌，而那一步窗口里恰好有出牌项且不是我的回合）。
 * 这条策略对任何牌型都合法，且必然终止（我每轮至少丢一张牌，或两家机器人先走完）。
 */
async function autoPlayUntilEnded(cdp, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let acts = 0;
  while (Date.now() < deadline) {
    const st = await cdp.eval(READ_STATE);
    if (st.ended || st.settlementSeen) {
      check(`${label}：一局真的走到终局（state=ended / settlement 到达）`, true, `v${st.version} 自动动作 ${acts} 次`);
      return st;
    }
    if (st.page !== 'table') {
      check(`${label}：对局期间不应离开牌桌`, false, `page=${st.page} body="${st.bodyText}"`);
      return st;
    }
    if (st.isMyTurn) {
      const act = await cdp.eval(`(() => {
        const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('game');
        const click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; };
        if (store.isBidding) return click('.table__bid-grab') ? 'bid' : 'no-bid-button';
        if (store.isPlaying) {
          // 协议 ④：窗口里没有出牌项 ⇒ 首出（打一张）；否则过牌。
          // ⚠️ 与 canPass 同一判据（等价性见 shared/ddz/recent.test.ts 的不变式②）。
          // ⚠️ 本注释同样在**模板字面量内**：不得出现反引号。
          if (!(store.recentActions ?? []).some((a) => a.cards !== null)) {
            const card = document.querySelector('.table__me .card');
            if (!card) return 'no-card';
            card.click();
            return click('.table__play') ? 'play' : 'no-play-button';
          }
          return click('.table__pass') ? 'pass' : 'no-pass-button';
        }
        return 'no-action-' + store.view?.state;
      })()`);
      acts += 1;
      if (String(act).startsWith('no-')) {
        check(`${label}：自动出牌找不到可用动作`, false, `动作=${act} body="${st.bodyText}"`);
        return st;
      }
    }
    await sleep(500);
  }
  const st = await cdp.eval(READ_STATE);
  check(`${label}：一局真的走到终局`, false, `${Math.round(timeoutMs / 1000)}s 超时；v${st.version} state=${st.viewState} 自动动作 ${acts} 次 body="${st.bodyText}"`);
  return st;
}

/**
 * 第二局判据（N32）：在**同一个页面会话**里收到新房间的 `room.matched`+`game.deal`
 * ⇒ 必须被客户端接受（且不被误判成 M08 回退、不产生重连风暴）。
 *
 * 本片（2026-10-12）起两条路径的形态按实况各自成立：
 * - 受控路径（`--scenario second-game`/`gate`，判据 2）：`seedFinishedGame` 在 `room.matched`
 *   **之前**注入「上一局 v50 已结束、`roomCode` 停在上一局」形态 ⇒ 由它承载 N32 的客户端
 *   状态边界（store 的 `currentVersion` 大于新局 `v1`）；旧注所记「在局重复匹配」（进行中
 *   点匹配 ⇒ 同一 `roomCode` 再发一次）已被服务端匹配守卫（`room.match` 在局 ⇒ 12011）
 *   **结构性堵死**，不可从任一路径再触发。
 * - 完整路径（`--scenario full`，判据 2′）：第一局打完先 `backToLobby` —— 本片起那是确认
 *   弹窗 ⇒ `room.leave` 真弃局 + `store.reset()` ⇒ `before` 读到的是**干净空 store**
 *   （`roomCode=null`/`version=-1`；`t5-probe-full3.log:82` 实证）—— 即**确认弃局后的干净
 *   跨局**，不再以「store 留着上一局 v<N> 已结束形态」为前提。
 */
async function secondGameJudgment(cdp, label) {
  const before = { ...(await cdp.eval(READ_STATE)), reconnects: run.reconnectFrames };
  const second = await matchAndWaitDeal(cdp, label);
  check(
    `${label}：进入的是**新房间**（不是上一局残留的 roomCode）`,
    !second.__timeout && second.roomCode !== before.roomCode && second.viewRoom === second.roomCode,
    `上一局 room=${before.roomCode} v=${before.version} → 第二局 room=${second.roomCode} v=${second.version}`,
  );
  const storm = run.reconnectFrames - before.reconnects;
  check(
    `${label}：不出现 game.reconnect 重连风暴（未修实现实测连发）`,
    storm === 0,
    `本次窗口内 game.reconnect 帧数 = ${storm}`,
  );
  return second;
}

/**
 * S6.4 setup：经**管理面**开启跑得快（`game.paodekuai.enabled=true`）并轮询至生效。
 *
 * 生效观测点 = **建房行为**（`POST /api/rooms` 带 `gameType=paodekuai` 得 code 0）——
 * room-service 的配置缓存有刷新窗口，只看库里的值证不了消费侧已生效。
 * 刻意**不还原**：真栈测试的收尾复原归 conformance 编排。
 */
async function setupPdkEnabled(playerCount = 3) {
  const login = await gwJson('POST', '/api/admin/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  const admin = login.body?.data?.token;
  if (login.body?.code !== 0 || !admin) {
    throw new Error(`管理登录失败：HTTP ${login.status} ${JSON.stringify(login.body)}`);
  }
  const put = await gwJson('PUT', '/api/admin/config/game.paodekuai.enabled', {
    body: { value: true },
    token: admin,
  });
  if (put.body?.code !== 0) {
    throw new Error(`置 game.paodekuai.enabled=true 失败：HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  if (playerCount === 2) {
    const twoPut = await gwJson('PUT', '/api/admin/config/game.paodekuai.twoPlayerEnabled', {
      body: { value: true },
      token: admin,
    });
    if (twoPut.body?.code !== 0) {
      throw new Error(
        `置 game.paodekuai.twoPlayerEnabled=true 失败：HTTP ${twoPut.status} ${JSON.stringify(twoPut.body)}`,
      );
    }
  }
  // 建房探测需要好友房开关（POST /api/rooms 的门）；探测完立即还原。
  const friendPut = await gwJson('PUT', '/api/admin/config/game.paodekuai.friendRoomEnabled', {
    body: { value: true },
    token: admin,
  });
  if (friendPut.body?.code !== 0) {
    throw new Error(`开启跑得快好友房（建房探测用）失败：${JSON.stringify(friendPut.body)}`);
  }
  const phone = `138${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
  const reg = await gwJson('POST', '/api/auth/register', {
    body: { phone, password: 'browser-e2e-pass', nickname: `pdk-${phone.slice(-4)}` },
  });
  const player = reg.body?.data?.accessToken;
  if (reg.body?.code !== 0 || !player) {
    throw new Error(`探针账号注册失败：HTTP ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const deadline = Date.now() + 60000;
  for (;;) {
    const probe = await gwJson('POST', '/api/rooms', {
      body: { mode: 'random', gameType: 'paodekuai', playerCount },
      token: player,
    });
    if (probe.body?.code === 0) {
      await gwJson('PUT', '/api/admin/config/game.paodekuai.friendRoomEnabled', {
        body: { value: false },
        token: admin,
      });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`game.paodekuai.enabled=true 60s 内未生效（最后一次 ${probe.body?.code}）`);
    }
    await sleep(1000);
  }
}

/** S6.4：跑得快场景 —— 大厅切玩法 → 匹配 → 出牌/过牌 → 结算 → 重进。 */
async function runPdkScenario(cdp, playerCount = 3) {
  await newPageSession(cdp, 'S6.4（跑得快）');
  await registerFresh(cdp);

  // ① 大厅：跑得快卡片可见（enabled=true 生效）并点选
  const modeReady = await waitForSelectorCount(cdp, '.lobby__mode', 2, 20000);
  // 卡片文本 = 图标兜底首字 + 名称 + tagline ⇒ 不能按整卡 textContent 精确匹配，按 `.lobby__mode-name` 找。
  const clickedMode = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('.lobby__mode')];
    const el = cards.find((c) => c.querySelector('.lobby__mode-name')?.textContent.trim() === '跑得快');
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
  check('S6.4：大厅渲染出「跑得快」玩法卡（配置开关已生效）', modeReady >= 2 && clickedMode === 'clicked', `mode=${clickedMode} cards=${modeReady}`);
  await waitForSelector(cdp, '.lobby__level', 20000);
  await cdp.eval(`(() => { const el = document.querySelector('.lobby__level'); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`);
  const gamePage = await waitFor(cdp, 'S6.4：进入玩法页', (s) => s.page === 'game', 15000);
  check('S6.4：点跑得快档位卡进入玩法页', !gamePage.__timeout, `page=${gamePage.page}`);
  const matchReady = await waitForSelector(cdp, '.game__match .btn', 20000);
  if (playerCount === 2) {
    const picked = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('.game__player-option')].find((b) => b.textContent.trim() === '2 人');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    check('S6.4(2p)：开始游戏页选中「2 人」', picked === 'clicked', `pick=${picked}`);
  }
  // 注册后客户端会用新令牌重建 WS 会话；等它落定再匹配（否则可能把请求发到匿名连接上 ⇒ 10005）。
  await sleep(2500);
  const clickedMatch = await cdp.eval(`(() => {
    const el = document.querySelector('.game__match .btn');
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
  check('S6.4：点「开始游戏」发起匹配', matchReady && clickedMatch === 'clicked', `btn=${matchReady} click=${clickedMatch}`);

  // ② 匹配 + 发牌（pdk 视图：16 张）
  const dealt = await waitFor(
    cdp,
    'S6.4：匹配并收到跑得快发牌',
    (s) =>
      s.page === 'table' &&
      s.gameType === 'paodekuai' &&
      s.viewState === 'playing' &&
      s.hand === 16 &&
      s.pdkPlayerCount === playerCount,
    60000,
  );
  check(
    'S6.4：进入跑得快牌桌并收到 16 张手牌',
    !dealt.__timeout,
    `gameType=${dealt.gameType} playerCount=${dealt.pdkPlayerCount} state=${dealt.viewState} hand=${dealt.hand} room=${dealt.roomCode ?? '(无)'} matching=${dealt.matching} notice=${dealt.notice ?? '(无)'}`,
  );
  const opponentSeats = await cdp.eval(`document.querySelectorAll('.pdk__seat').length`);
  check(
    `S6.4(${playerCount}p)：对手座位数 = playerCount - 1`,
    opponentSeats === playerCount - 1,
    `.pdk__seat = ${opponentSeats}`,
  );
  const cards = await waitForSelectorCount(cdp, '.pdk__me .card', 16, 12000);
  check('S6.4：DOM 渲染 16 张手牌（.pdk__me .card）', cards === 16, `.pdk__me .card = ${cards}`);

  // ③ 驱动到终局：轮到我时优先提示+出牌；无解（canPass）则不出。
  const deadline = Date.now() + GAME_TIMEOUT_MS;
  let last = dealt;
  while (Date.now() < deadline) {
    last = await cdp.eval(READ_STATE);
    if (last.settlementSeen || last.ended) break;
    if (last.ready && last.page === 'table' && last.isMyTurn) {
      const acted = await cdp.eval(`(() => {
        const hint = document.querySelector('.pdk__hint');
        if (hint) { hint.click(); return 'hint'; }
        const pass = document.querySelector('.pdk__pass');
        if (pass) { pass.click(); return 'pass'; }
        const card = document.querySelector('.pdk__me .card');
        if (card) { card.click(); const play = document.querySelector('.pdk__play'); if (play && !play.disabled) { play.click(); return 'play'; } }
        return 'none';
      })()`);
      if (acted === 'hint' || acted === 'play') {
        await sleep(300);
        const played = await cdp.eval(`(() => { const play = document.querySelector('.pdk__play'); if (!play || play.disabled) return 'disabled'; play.click(); return 'clicked'; })()`);
        if (played === 'disabled' && acted === 'hint') {
          // 提示无候选（按钮不存在时 hint 分支不会命中）⇒ 走不出/过牌
          await cdp.eval(`(() => { const pass = document.querySelector('.pdk__pass'); if (pass) pass.click(); return 'pass'; })()`);
        }
      }
      trace(`S6.4 action=${acted}`);
    }
    await sleep(600);
  }
  const settled = await waitFor(
    cdp,
    'S6.4：跑得快终局结算出现',
    (s) => s.settlementSeen,
    30000,
  );
  const panel = await waitForSelector(cdp, '.pdk-settlement', 15000);
  const rows = await cdp.eval(`document.querySelectorAll('.pdk-settlement__row').length`);
  check(
    `S6.4(${playerCount}p)：跑得快结算面板出现（${playerCount} 行，含倍数文案）`,
    panel && rows === playerCount && /倍数/.test(await cdp.eval(`document.querySelector('.pdk-settlement')?.innerText ?? ''`)),
    `panel=${panel} rows=${rows} settlementSeen=${settled.settlementSeen}`,
  );

  // ④ 返回大厅（结算面板的次按钮）
  await cdp.eval(`(() => { const el = document.querySelector('.pdk-settlement__lobby'); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`);
  const lobby = await waitFor(cdp, 'S6.4：结算后返回大厅', (s) => s.page === 'lobby', 15000);
  check('S6.4：结算「返回大厅」落在大厅', !lobby.__timeout, `page=${lobby.page}`);
}

// ─── 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== [browser-e2e] 真浏览器端到端探针（scenario=${SCENARIO}，base=${BASE_URL}）===`);

  const server = await ensureDevServer();
  if (server.failed) return finish(server);
  const chrome = await launchChrome();
  if (chrome.error) {
    check('chromium 可启动并暴露 CDP', false, chrome.error);
    return finish(server);
  }
  info(`chromium = ${chrome.bin}`);

  /**
   * CDP 的 `/json/version` 可达 **不等于** 页面 target 已在 `/json/list` 里登记：
   * Chrome 153（Windows headless=new）实测存在一个窄启动窗 —— version 已应答、list 还是空。
   * ⇒ 有界重试（≤10s）；仍无 page target 才判红（探针自身错误，不当成页面缺陷）。
   */
  let page = null;
  const pageDeadline = Date.now() + 10000;
  while (Date.now() < pageDeadline) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
    await sleep(300);
  }
  if (!page) {
    check('CDP 页面 target 可连接', false, `10s 内 /json/list 没有 type=page 的 target`);
    return finish(server);
  }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  const exceptions = [];
  const consoleErrors = [];
  run.reconnectFrames = 0;
  run.rollbackEvents = 0;
  traceT0 = Date.now();
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(`${d.text} ${d.exception?.description ?? ''}`.slice(0, 300));
      trace(`exception ${exceptions.at(-1)}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      trace(`console.error ${consoleErrors.at(-1)}`);
    }
    if (msg.method === 'Network.webSocketFrameSent' || msg.method === 'Network.webSocketFrameReceived') {
      const dir = msg.method.endsWith('Sent') ? 'C→S' : 'S→C';
      const data = (msg.params.response?.payloadData ?? '').replace(/\s+/g, ' ');
      if (/room\.matched|room\.match|game\.deal|game\.reconnect|game\.resync|system\.error|13005|13010|13004|12012|room\.join/.test(data)) {
        trace(`${dir} ${data.slice(0, 200)}`);
      }
      if (dir === 'C→S' && data.includes('game.reconnect')) run.reconnectFrames += 1;
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const wantMinimal = SCENARIO === 'gate' || SCENARIO === 'minimal' || SCENARIO === 'full';
  const wantControlled = SCENARIO === 'gate' || SCENARIO === 'second-game';

  /**
   * ── 片⑦ setup：`--scenario full` 的「创建房间」创建流需要好友房**开着** ─────
   * 只有 full 会点 `.game__friends-open`（入口按 `store.friendRoomEnabled` 门控）；其余
   * 场景不碰好友房，**刻意不为此改动栈配置**（不动用的东西就别动）。setup 失败 ⇒ 早停：
   * 后面的创建流必然点不到入口，晚失败只会把原因埋在 20s 超时里。
   */
  if (SCENARIO === 'full') {
    try {
      await setupFriendRooms();
      check('setup：经管理面开启好友房并轮询至建房生效（POST /api/rooms ⇒ code 0）', true, `PUT game.doudizhu.friendRoomEnabled=true（网关 ${GW_BASE}）`);
    } catch (err) {
      check('setup：经管理面开启好友房', false, err?.message ?? String(err));
      return finish(server);
    }
  }

  if (SCENARIO === 'pdk' || SCENARIO === 'pdk2') {
    const pdkCount = SCENARIO === 'pdk2' ? 2 : 3;
    try {
      await setupPdkEnabled(pdkCount);
      check(
        'setup：经管理面开启跑得快并轮询至建房生效',
        true,
        `PUT game.paodekuai.enabled=true${pdkCount === 2 ? ' + twoPlayerEnabled=true' : ''}（网关 ${GW_BASE}）`,
      );
    } catch (err) {
      check('setup：经管理面开启跑得快', false, err?.message ?? String(err));
      return finish(server);
    }
    await runPdkScenario(cdp, pdkCount);
    try {
      const admin = await (async () => {
        const login = await gwJson('POST', '/api/admin/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
        return login.body?.data?.token;
      })();
      if (admin) {
        await gwJson('PUT', '/api/admin/config/game.paodekuai.enabled', { body: { value: false }, token: admin });
        if (pdkCount === 2) {
          await gwJson('PUT', '/api/admin/config/game.paodekuai.twoPlayerEnabled', { body: { value: false }, token: admin });
        }
        info('跑得快开关已还原为 false');
      }
    } catch (err) {
      info(`⚠️ 还原跑得快开关失败（不影响本次判据）：${err?.message ?? String(err)}`);
    }
  }

  // ── 判据 1：最小真浏览器路径（守 N28 / B1 / B2）──────────────────────
  if (wantMinimal) {
    await newPageSession(cdp, '判据 1（最小路径）');
    await registerFresh(cdp);
    await matchAndWaitDeal(cdp, '第一局');
  }

  // ── 判据 2：N32 跨局边界（**受控复现**）──────────────────────────────
  if (wantControlled) {
    await newPageSession(cdp, '判据 2（N32 受控复现）');
    await registerFresh(cdp);
    await seedFinishedGame(cdp, 50);
    await secondGameJudgment(cdp, '第二局');
  }

  // ── 判据 2′：N32 跨局边界（**真打完一局**，慢；`--scenario full`）────
  if (SCENARIO === 'full') {
    await newPageSession(cdp, '判据 2′（真打完一局再开第二局）');
    await registerFresh(cdp);
    await matchAndWaitDeal(cdp, '第一局');
    const finished = await autoPlayUntilEnded(cdp, GAME_TIMEOUT_MS, '第一局');
    // 本片新增（R811）：**手动进房**也走一遍 —— 探针此前只覆盖随机匹配，
    // 这正是 F6（创建房间在真后端上 12004）能溜过去的原因。
    await createRoomAndJoin(cdp, '判据 2′（创建房间 → 进房）', finished.roomCode);
    // 本片新增（spec §6.3 / R903）：留在那个单人房里等机器人补位 ⇒ 真的开局
    await waitFilledGame(cdp, '判据 2′（单人房 → 机器人补位）');
    await backToLobby(cdp);
    await secondGameJudgment(cdp, '第二局（真跨局）');
  }

  // ── 判据 3：全程零页面异常 ─────────────────────────────────────────
  check('全程 Runtime.exceptionThrown 为 0', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  check('全程 error 级 console 为 0', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  if (KEEP_OPEN) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(tmpdir(), 'browser-e2e-last.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    info(`截图：${out}`);
  }

  return finish(server);
}

function finish(extra) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== [browser-e2e] 判据 ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ❌ ${f.label}`);
    dumpTrace(40);
  }
  if (!KEEP_OPEN) shutdownSync();
  if (extra?.started) info('（本脚本拉起的 dev server 已关闭）');
  process.exitCode = failed.length > 0 ? 1 : 0;
}

// 退出兜底：任何路径（含异常）都必须回收子进程，否则会在 5173/9222 留下脏进程。
process.on('exit', () => {
  if (!KEEP_OPEN) shutdownSync();
});
process.on('SIGINT', () => {
  shutdownSync();
  process.exit(130);
});

main().catch((err) => {
  check('探针自身未抛异常', false, err?.stack ?? String(err));
  finish({});
});
