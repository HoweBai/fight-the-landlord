#!/usr/bin/env node
/**
 * 支付片 T16：**stub 支付宝**（conformance 专用容器 `ftl-alipay-stub`；规格 ⚙️14 逐字）。
 *
 * ─── 它是什么 / 为什么存在 ─────────────────────────────────────────────────────
 * 真支付宝沙箱需要真商户号与外网（打 tag 前置，规格 §6.4）；conformance 的 `slice-21` 在
 * 每次 CI 都要跑 ⇒ 用一个**行为等价的最小渠道**：同 RSA2 两口径签名、同 OpenAPI 同步
 * 响应形态（`<api>_response` 原文子串 + `sign`）、同四方法（wap.pay / query / refund /
 * close）。**双向金标**（⚙️14）：stub 用应用公钥验我们的出站请求签名；我们（payment-service）
 * 用渠道公钥验 stub 的同步响应与通知签名。
 *
 * ─── 密钥材料（零入仓新私钥）─────────────────────────────────────────────────
 * 四 PEM 由 `conformance-stack.sh` 以**第二只读挂载**送进来（`/keys:ro`），源 =
 * `tools/conformance/fixtures/alipay-test/`（= T6 金标同一对测试密钥，T6 生成脚本产出）：
 *  - `/keys/app-public.pem`    —— 验我们的请求签名（方向 ①）；文件 = **启动默认值**，
 *                                可经 `/_control/set-app-public` **运行时整替**（切片-22 ② 轮换）
 *  - `/keys/alipay-private.pem`—— 签响应/通知（方向 ②）
 * 缺任一 ⇒ 保持进程存活但**响亮拒绝**（不静默降级：验证路径必红）。
 *
 * ─── 控制面（test-only；`/_control/*`）───────────────────────────────────────
 * stub **不发布宿主端口**（唯一常口 = 8801，只对 compose 网内如 payment-service 可见）。
 * 切片驱动的控制面走 `docker exec ftl-alipay-stub wget -qO- http://127.0.0.1:8801/_control/…`
 * ——「控制面只对 docker 控制者开放」，与「宿主绑挂仅限测试容器」同一条纪律。
 * 全部为 **GET + query**（busybox wget 一行可达）：
 *  - `GET /_control/state`                                    —— 全量内存态（断言用；`keys.appPublicFingerprint`
 *                                                               = sha256(appPublicPem)[:12]，无 PEM ⇒ null）
 *  - `GET /_control/set-app-public?pem=<urlencoded PEM 原文>` —— 运行时整替验签用应用公钥（切片-22 ②：
 *                                                               换 B ⇒ 现私钥 A 下单必败）；成功回
 *                                                               `{ok:true, fingerprint}`（**不含**整稿）
 *  - `GET /_control/mark-paid?out_trade_no=X`                 —— 渠道侧标记已付（⑩ close 已付分支）
 *  - `GET /_control/fail-refund?out_request_no=X&on=1|0`      —— 令某退款幂等键失败（⑭ 渠道失败停 approved）
 *  - `GET /_control/sign-notify?out_trade_no=X&total_amount=Y[&trade_status=Z]`
 *                                                             —— 以渠道私钥签一条通知，返回
 *                                                               `{params, form}`（切片经门口投递）
 *
 * ─── APP_ID / SELLER_ID 与种子值的同源纪律（支付配置管理化片 §5.4 起）──────────
 * `APP_ID` / `SELLER_ID` 必须与 `scripts/deploy/conformance-stack.sh` **种子块** PUT 进管理面的
 * `pay.channel.appId` / `pay.channel.sellerId` 值**逐字一致** —— 渠道六值已整体改为**值由栈脚本
 * 种子供给**（不再经 `ALIPAY_*` env export）。不一致 ⇒ 回调四项校验不过 ⇒ slice-21 组④ 响亮红，
 * 正是要它当场暴露。
 *
 * ─── 规范化口径的第三份独立复写 ──────────────────────────────────────────────
 * 签名规范化（⚙️6）在本仓有三处实现：产品侧 `packages/payment-service/src/channel/alipay/params.ts`、
 * T6 金标生成脚本、以及本文件——**故意各自独立**（自证循环的反面；哪两处漂移，金标/真栈当场红）。
 */
import { createServer } from 'node:http';
import { createHash, createSign, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

/* ────────────────────────────── 常量与密钥装载 ────────────────────────────── */

const PORT = Number(process.env.STUB_PORT || 8801);
const KEYS_DIR = process.env.STUB_KEYS_DIR || '/keys';

/** ⚠️ 与 `conformance-stack.sh` **种子块** PUT 的值 **逐字一致**（值由栈脚本种子供给；见文件头）。 */
const APP_ID = '9021000000000000';
const SELLER_ID = '2088721087500000';

function loadPem(file) {
  try {
    return readFileSync(`${KEYS_DIR}/${file}`, 'utf8');
  } catch (err) {
    console.error(`[stub] ⚠️ 读不到 ${KEYS_DIR}/${file}（${err.message}）—— 该方向将被响亮拒绝`);
    return null;
  }
}
/** ⚠️ `let`（非常量）：`/_control/set-app-public` 可运行时整替（切片-22 ② 轮换演练）。 */
let appPublicPem = loadPem('app-public.pem');
const alipayPrivatePem = loadPem('alipay-private.pem');

/** sha256 hex 前 12 位 —— 断言面：切片-22 ② 用它证「确实换成了 B」。无 PEM ⇒ `null`。 */
const fingerprintOf = (pem) => (pem ? createHash('sha256').update(pem, 'utf8').digest('hex').slice(0, 12) : null);

/* ────────────────────────────── 签名口径（⚙️6）────────────────────────────── */

const asciiAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** ⚙️6 共性：按参数名 ASCII 升序 ⇒ `k=v` 以 `&` 连接（值取原文，不二次编码）。 */
const canonical = (entries) =>
  [...entries].sort((x, y) => asciiAsc(x[0], y[0])).map(([k, v]) => `${k}=${v}`).join('&');
/** 出站请求口径：全参数 + `sign_type=RSA2` 同序（`sign_type` **参与**）。 */
const requestSource = (params) =>
  canonical([...Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'), ['sign_type', 'RSA2']]);
/** 通知口径：除 `sign`/`sign_type` 外全部参数（`sign_type` **不参与**）。 */
const notifySource = (params) =>
  canonical(Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'));

/** 方向 ①：用应用公钥验我们（payment-service）的出站请求签名。 */
function verifyRequestSignature(params) {
  if (!appPublicPem) return { ok: false, why: 'app-public.pem 未装载' };
  const sign = params.sign;
  if (typeof sign !== 'string' || sign.length === 0) return { ok: false, why: '缺 sign' };
  try {
    return {
      ok: createVerify('RSA-SHA256').update(requestSource(params), 'utf8').verify(appPublicPem, Buffer.from(sign, 'base64')),
    };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

/** 方向 ②：渠道私钥对 `<api>_response` 节点的**原文子串**字节签名（⚙️6②）。 */
function respond(apiName, node) {
  const key = `${apiName.replace(/\./g, '_')}_response`;
  const nodeJson = JSON.stringify(node);
  if (!alipayPrivatePem) {
    // 无键 ⇒ 不带 sign 出站（下游 verifyResponse 必败 ⇒ 15001；不静默成功）。
    console.error('[stub] ⚠️ alipay-private.pem 未装载 —— 响应无法签名（下游按验签失败处置）');
    return `{"${key}":${nodeJson}}`;
  }
  const sign = createSign('RSA-SHA256').update(nodeJson, 'utf8').sign(alipayPrivatePem, 'base64');
  return `{"${key}":${nodeJson},"sign":"${sign}"}`;
}

/* ────────────────────────────── 内存态 ────────────────────────────── */

const counters = { gatewayRequests: 0, badSignature: 0, wapPay: 0, query: 0, refund: 0, close: 0, notifySigned: 0, markPaid: 0, failRefundToggle: 0, setAppPublic: 0 };
/** out_trade_no ⇒ 订单（wap.pay 首次见到即建行；与真实渠道的「订单在渠道侧也有分身」同形）。 */
const orders = new Map();
/** 配置为失败的退款幂等键（out_request_no）——⑭「渠道失败停 approved」的驱动面。 */
const failRefunds = new Set();
let notifySeq = 0;
let tradeSeq = 0;

function orderOf(no, totalAmount) {
  if (!no) return null;
  let o = orders.get(no);
  if (!o) {
    o = {
      out_trade_no: no,
      status: 'created', // created | paid | closed
      total_amount: totalAmount ?? null,
      trade_no: `T21STUB${(tradeSeq += 1).toString(36).padStart(6, '0')}`,
      wapPayVerified: false,
      wapPayRequests: 0,
      queryRequests: 0,
      closeRequests: 0,
      refundCalls: {}, // out_request_no ⇒ 次数（幂等记忆）
      refunds: [], // {out_request_no, amount}
    };
    orders.set(no, o);
  }
  if (totalAmount !== undefined && totalAmount !== null) o.total_amount = totalAmount;
  return o;
}

/* ────────────────────────────── 网关（/gateway.do）────────────────────────────── */

function handleGateway(params) {
  counters.gatewayRequests += 1;
  const method = typeof params.method === 'string' ? params.method : '(无 method)';
  const v = verifyRequestSignature(params);
  if (!v.ok) {
    // 双向金标方向 ① 的**负断言面**：签名不过就绝不能拿到成功响应（响亮）。
    counters.badSignature += 1;
    console.error(`[stub] ✋ 请求验签失败（method=${method}；${v.why ?? 'signature mismatch'}）—— 拒绝为该请求提供成功面`);
    return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.INVALID_SIGN', sub_msg: 'stub: request signature verify failed' });
  }

  let biz = {};
  try {
    biz = JSON.parse(params.biz_content || '{}');
  } catch {
    return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.INVALID_PARAMETER', sub_msg: 'stub: biz_content is not JSON' });
  }

  if (method === 'alipay.trade.wap.pay') {
    counters.wapPay += 1;
    const o = orderOf(biz.out_trade_no, biz.total_amount);
    if (o) {
      o.wapPayRequests += 1;
      o.wapPayVerified = true; // 走到这里 = 方向 ① 已验过（验签失败在上面就 return 了）
      o.subject = biz.subject;
      o.notify_url = params.notify_url;
      o.return_url = params.return_url;
      o.timeout_express = biz.timeout_express;
    }
    return respond(method, { code: '10000', msg: 'Success', out_trade_no: biz.out_trade_no });
  }

  if (method === 'alipay.trade.query') {
    counters.query += 1;
    const o = orderOf(biz.out_trade_no);
    if (!o) {
      return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: 'stub: trade not exist', out_trade_no: biz.out_trade_no });
    }
    o.queryRequests += 1;
    const tradeStatus = o.status === 'paid' ? 'TRADE_SUCCESS' : o.status === 'closed' ? 'TRADE_CLOSED' : 'WAIT_BUYER_PAY';
    return respond(method, {
      code: '10000', msg: 'Success', out_trade_no: o.out_trade_no, trade_no: o.trade_no, total_amount: o.total_amount, trade_status: tradeStatus,
    });
  }

  if (method === 'alipay.trade.refund') {
    counters.refund += 1;
    const orn = biz.out_request_no;
    if (failRefunds.has(orn)) {
      // ⑭ 的驱动面：**业务拒绝**（明确失败 ⇒ 产品侧不标 unknown、停自动转人工）。
      return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.REFUND_AMT_NOT_EQUAL', sub_msg: 'stub: refund failure configured for out_request_no' });
    }
    const o = orderOf(biz.out_trade_no);
    if (!o) {
      return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: 'stub: trade not exist' });
    }
    o.refundCalls[orn] = (o.refundCalls[orn] ?? 0) + 1;
    const first = o.refundCalls[orn] === 1;
    if (first) o.refunds.push({ out_request_no: orn, amount: biz.refund_amount });
    // 幂等记忆：同一 out_request_no 重放 ⇒ 同单同额成功、`fund_change=N`（没有新的资金变动）。
    return respond(method, {
      code: '10000', msg: 'Success', out_trade_no: o.out_trade_no, trade_no: o.trade_no,
      refund_fee: biz.refund_amount, fund_change: first ? 'Y' : 'N',
    });
  }

  if (method === 'alipay.trade.close') {
    counters.close += 1;
    const o = orderOf(biz.out_trade_no);
    if (o) o.closeRequests += 1;
    if (o && o.status === 'paid') {
      // ⑩ 的驱动面：close 报「已支付」⇒ 产品侧 closed→paid 重开（防「已付被关」）。
      return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_HAS_SUCCESS', sub_msg: 'stub: trade has been paid', trade_no: o.trade_no });
    }
    if (o) o.status = 'closed';
    return respond(method, { code: '10000', msg: 'Success', out_trade_no: biz.out_trade_no });
  }

  return respond(method, { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.SYSTEM_ERROR', sub_msg: `stub: unsupported method ${method}` });
}

/* ────────────────────────────── 通知签发（方向 ②）────────────────────────────── */

/** 北京时间 `yyyy-MM-dd HH:mm:ss`（与产品侧 `formatAlipayTimestamp` 同形；非签名面）。 */
function beijingNow() {
  const t = new Date(Date.now() + 8 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

function buildNotify(outTradeNo, totalAmount, tradeStatus) {
  const o = orders.get(outTradeNo);
  const params = {
    notify_type: 'trade_status_sync',
    notify_id: `stub-notify-${(notifySeq += 1)}`,
    notify_time: beijingNow(),
    gmt_payment: beijingNow(),
    charset: 'utf-8',
    version: '1.0',
    sign_type: 'RSA2',
    app_id: APP_ID,
    seller_id: SELLER_ID,
    out_trade_no: outTradeNo,
    total_amount: totalAmount,
    receipt_amount: totalAmount,
    trade_status: tradeStatus || 'TRADE_SUCCESS',
    trade_no: o?.trade_no ?? `T21STUBADHOC${outTradeNo.slice(-6)}`,
  };
  if (!alipayPrivatePem) {
    console.error('[stub] ⚠️ 通知无法签名（alipay-private.pem 未装载）—— 按未签名返回（投递必被拒）');
    return { params, form: new URLSearchParams(params).toString() };
  }
  params.sign = createSign('RSA-SHA256').update(notifySource(params), 'utf8').sign(alipayPrivatePem, 'base64');
  return { params, form: new URLSearchParams(params).toString() };
}

/* ────────────────────────────── HTTP 服务器 ────────────────────────────── */

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('alipay-stub ok');
    return;
  }

  // ── 控制面（test-only；见文件头）──────────────────────────────────────────
  if (req.method === 'GET' && path.startsWith('/_control/')) {
    if (path === '/_control/state') {
      json(res, {
        keys: {
          appPublic: Boolean(appPublicPem),
          appPublicFingerprint: fingerprintOf(appPublicPem),
          alipayPrivate: Boolean(alipayPrivatePem),
        },
        constants: { appId: APP_ID, sellerId: SELLER_ID },
        counters,
        failRefunds: [...failRefunds],
        orders: Object.fromEntries(
          [...orders.entries()].map(([no, o]) => [
            no,
            {
              status: o.status, total_amount: o.total_amount, trade_no: o.trade_no,
              wapPayVerified: o.wapPayVerified, wapPayRequests: o.wapPayRequests,
              queryRequests: o.queryRequests, closeRequests: o.closeRequests,
              subject: o.subject ?? null, notify_url: o.notify_url ?? null, return_url: o.return_url ?? null,
              timeout_express: o.timeout_express ?? null,
              refundCalls: o.refundCalls, refunds: o.refunds,
            },
          ]),
        ),
      });
      return;
    }
    if (path === '/_control/set-app-public') {
      const pem = url.searchParams.get('pem');
      if (!pem) {
        json(res, { ok: false, error: 'pem 必填（urlencoded PEM 原文）' }, 400);
        return;
      }
      appPublicPem = pem;
      counters.setAppPublic += 1;
      // ⚠️ 只回指纹（sha256[:12]）**不回整稿**：控制面响应可能进日志；切片据指纹断言「换成了 B」。
      json(res, { ok: true, fingerprint: fingerprintOf(pem) });
      return;
    }
    if (path === '/_control/mark-paid') {
      const no = url.searchParams.get('out_trade_no');
      const o = orderOf(no);
      if (!o) {
        json(res, { ok: false, error: 'out_trade_no 必填' }, 400);
        return;
      }
      o.status = 'paid';
      counters.markPaid += 1;
      json(res, { ok: true, out_trade_no: no, status: o.status });
      return;
    }
    if (path === '/_control/fail-refund') {
      const orn = url.searchParams.get('out_request_no');
      const on = url.searchParams.get('on') !== '0';
      if (!orn) {
        json(res, { ok: false, error: 'out_request_no 必填' }, 400);
        return;
      }
      if (on) failRefunds.add(orn);
      else failRefunds.delete(orn);
      counters.failRefundToggle += 1;
      json(res, { ok: true, failRefunds: [...failRefunds] });
      return;
    }
    if (path === '/_control/sign-notify') {
      const no = url.searchParams.get('out_trade_no');
      const amount = url.searchParams.get('total_amount');
      if (!no || !amount) {
        json(res, { ok: false, error: 'out_trade_no / total_amount 必填' }, 400);
        return;
      }
      counters.notifySigned += 1;
      json(res, { ok: true, ...buildNotify(no, amount, url.searchParams.get('trade_status') || 'TRADE_SUCCESS') });
      return;
    }
    json(res, { ok: false, error: `unknown control path ${path}` }, 404);
    return;
  }

  // ── 渠道网关（form POST；与真实 openapi 网关同形）──────────────────────────
  if (req.method === 'POST' && (path === '/gateway.do' || path === '/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const params = Object.fromEntries(new URLSearchParams(bodyText));
      let reply;
      try {
        reply = handleGateway(params);
      } catch (err) {
        console.error(`[stub] 网关处理异常：${err.message}`);
        reply = respond(params.method || '(未知)', { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.SYSTEM_ERROR', sub_msg: err.message });
      }
      if (process.env.STUB_LOG !== '0') {
        console.log(`[stub] ${params.method ?? '(无 method)'} ⇒ ${reply.slice(0, 160)}`);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(reply);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[stub] listening on :${PORT}（keys: appPublic=${Boolean(appPublicPem)} alipayPrivate=${Boolean(alipayPrivatePem)}；appId=${APP_ID}）`);
});
