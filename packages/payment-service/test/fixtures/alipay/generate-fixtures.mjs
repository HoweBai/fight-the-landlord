#!/usr/bin/env node
/**
 * 支付片 T6：支付宝金标向量**生成脚本**（本地一次性跑；产物 = 同目录 `*.json` 入仓）。
 *
 * 用法（仓根或任意 cwd 均可）：
 *   node packages/payment-service/test/fixtures/alipay/generate-fixtures.mjs
 *
 * 幂等性：
 *  - `keys.json` 已存在 ⇒ **复用**密钥对（PKCS#1 v1.5 签名确定性 ⇒ 重跑产物逐字节相同）；
 *  - 删掉 `keys.json` 再跑 = 换一套新测试密钥，全部 fixture 随之重签 ——
 *    `sign.test.ts` 只认 fixture 内的材料，不硬编码任何 PEM。
 *
 * ⚠️ 测试密钥对入仓是规格口径（⚙️14 / §12：「仅测试密钥对入仓、生产密钥永不入仓」）。
 *
 * 规范化口径的两个来源（**故意独立复写**，避免「自证循环」）：
 *  ① 本脚本体按规格 ⚙️6 原文实现（通知：除 sign/sign_type 外按参数名 ASCII 升序、
 *     `k=v` 以 `&` 连接、值取原文不二次编码；出站：全参数 + sign_type=RSA2 同序；
 *     响应：`<api>_response` 值的**原文子串**字节）；
 *  ② 运行期真源 = `packages/payment-service/src/channel/alipay/params.ts`（T6 实现）。
 *  两侧口径若漂移，`sign.test.ts` 的金标回放会红 —— 这正是"生成与消费互为对照"。
 *
 * 沙箱采集（T16/联调批）后：真件按同构追加至本目录（来源字段区分 自造/沙箱）。
 */
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ASC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** ⚙️6 共性：按参数名 ASCII 升序 ⇒ `k=v` 以 `&` 连接（值=原文，不二次编码）。 */
const canonical = (entries) =>
  [...entries].sort((x, y) => ASC(x[0], y[0])).map(([k, v]) => `${k}=${v}`).join('&');
/** ⚙️6 ①通知口径：除 sign/sign_type 外全部参数。 */
const notifySource = (params) =>
  canonical(Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'));
/** ⚙️6 出站口径：全参数（除 sign）+ sign_type=RSA2 同序。 */
const requestSource = (params) =>
  canonical([
    ...Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'),
    ['sign_type', 'RSA2'],
  ]);

const signWith = (source, privatePem) =>
  createSign('RSA-SHA256').update(source, 'utf8').sign(privatePem, 'base64');
const verifyWith = (source, signB64, publicPem) =>
  createVerify('RSA-SHA256').update(source, 'utf8').verify(publicPem, Buffer.from(signB64, 'base64'));

/* ---------------------------------- 密钥对 ---------------------------------- */

const KEYS_FILE = join(DIR, 'keys.json');
let keys;
if (existsSync(KEYS_FILE)) {
  keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  console.log('[keys] reuse existing keys.json');
} else {
  const gen = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  const app = gen(); // 我们（应用侧）：出站签名用私钥、stub/测试侧用公钥验我们
  const alipay = gen(); // 渠道侧：通知/响应签名用私钥、我们验通用公钥
  keys = {
    note:
      '支付片 T6 测试专用密钥对（仅测试密钥对入仓 —— 规格 ⚙️14/§12；生产密钥永不入仓、只存服务器 .env）。' +
      'app = 应用侧（我们出站签名的私钥 / stub 与测试验签的公钥）；alipay = 渠道侧（通知与响应签名的私钥 / 我们验签的公钥）。' +
      '重生成 = 删除本文件后重跑 generate-fixtures.mjs。',
    appPrivatePem: app.privateKey,
    appPublicPem: app.publicKey,
    alipayPrivatePem: alipay.privateKey,
    alipayPublicPem: alipay.publicKey,
  };
  writeFileSync(KEYS_FILE, `${JSON.stringify(keys, null, 2)}\n`);
  console.log('[keys] generated new keys.json');
}

const write = (name, obj) => {
  writeFileSync(join(DIR, name), `${JSON.stringify(obj, null, 2)}\n`);
  console.log(`[write] ${name}`);
};
/** 生成侧自验签（写盘前先证明这份金标在生成口径下真的成立）。 */
const mustVerify = (label, source, signB64, publicPem) => {
  if (!verifyWith(source, signB64, publicPem)) {
    throw new Error(`self-check failed: ${label}`);
  }
};

const OUT_TRADE_NO = 'pay_m3xq8t9u7v2k1p'; // ⚙️4 形状样例（长度 19 ≤ 32，字符集 [0-9a-z_]）
const TRADE_NO = '2026100622001448060000000001';

/* ------------------------------- ① 成功回调 ------------------------------- */

const notifyBase = {
  gmt_create: '2026-10-06 10:00:00',
  charset: 'utf-8',
  seller_email: 'merchant@example.test',
  subject: '金币充值 6 元',
  buyer_id: '2088102147948060',
  invoice_amount: '6.00',
  notify_id: 'ac05099524730693a8b330c5ecf72da9786',
  // 含 JSON 引号/花括号的值 —— 规范化「值取原文」的活样本
  fund_bill_list: '[{"amount":"6.00","fundChannel":"ALIPAYACCOUNT"}]',
  notify_type: 'trade_status_sync',
  trade_status: 'TRADE_SUCCESS',
  receipt_amount: '6.00',
  app_id: '9021000000000000',
  buyer_pay_amount: '6.00',
  sign_type: 'RSA2',
  seller_id: '2088721087500000',
  gmt_payment: '2026-10-06 10:00:05',
  notify_time: '2026-10-06 10:00:05',
  version: '1.0',
  out_trade_no: OUT_TRADE_NO,
  total_amount: '6.00',
  trade_no: TRADE_NO,
  auth_app_id: '9021000000000000',
  buyer_logon_id: '159****5678',
  point_amount: '0.00',
};

const notifySuccess = { ...notifyBase, sign: signWith(notifySource(notifyBase), keys.alipayPrivatePem) };
mustVerify('notify-success', notifySource(notifySuccess), notifySuccess.sign, keys.alipayPublicPem);
write('notify-success.json', {
  name: 'notify-success',
  source: 'self-made（T6 自造；沙箱采集后按同构追加）',
  purpose: '成功回调（TRADE_SUCCESS）—— 口径①：通知验签通过；四项业务校验归 T8 消费',
  params: notifySuccess,
  expect: { verifyNotify: true },
});

/* ----------------------------- ② 金额不符回调 ----------------------------- */

const notifyMismatchBase = { ...notifyBase, total_amount: '7.00' };
const notifyMismatch = {
  ...notifyMismatchBase,
  sign: signWith(notifySource(notifyMismatchBase), keys.alipayPrivatePem),
};
mustVerify('notify-amount-mismatch', notifySource(notifyMismatch), notifyMismatch.sign, keys.alipayPublicPem);
write('notify-amount-mismatch.json', {
  name: 'notify-amount-mismatch',
  source: 'self-made（T6 自造；沙箱采集后按同构追加）',
  purpose:
    '签名有效、金额与订单不符 —— 钉住**分层**：签名层照常通过（verifyNotify=true），' +
    'amount_mismatch 属业务四校验（T8），不在本 fixture 的断言面',
  params: notifyMismatch,
  expect: { verifyNotify: true },
});

/* ------------------------------ ③ 查询响应 ------------------------------ */

const queryNode = {
  code: '10000',
  msg: 'Success',
  buyer_logon_id: '159****5678',
  out_trade_no: OUT_TRADE_NO,
  trade_no: TRADE_NO,
  total_amount: '6.00',
  trade_status: 'TRADE_SUCCESS',
};
const querySource = JSON.stringify(queryNode);
const querySign = signWith(querySource, keys.alipayPrivatePem);
mustVerify('query-response', querySource, querySign, keys.alipayPublicPem);
write('query-response.json', {
  name: 'query-response',
  source: 'self-made（T6 自造；沙箱采集后按同构追加）',
  api: 'alipay.trade.query',
  purpose: '口径②：`<api>_response` 键对应值的**原文子串**字节对 sign 验签（不是重排序）',
  rawBody: `{"alipay_trade_query_response":${querySource},"sign":"${querySign}"}`,
  expect: { verifyResponse: true, extractedNode: querySource, tradeStatus: 'TRADE_SUCCESS', totalAmount: '6.00' },
});

/* ------------------------------ ④ 退款响应 ------------------------------ */

const refundNode = {
  code: '10000',
  msg: 'Success',
  buyer_logon_id: '159****5678',
  fund_change: 'Y',
  gmt_refund_pay: '2026-10-06 11:00:00',
  out_trade_no: OUT_TRADE_NO,
  refund_fee: '6.00',
  trade_no: TRADE_NO,
};
const refundSource = JSON.stringify(refundNode);
const refundSign = signWith(refundSource, keys.alipayPrivatePem);
mustVerify('refund-response', refundSource, refundSign, keys.alipayPublicPem);
write('refund-response.json', {
  name: 'refund-response',
  source: 'self-made（T6 自造；沙箱采集后按同构追加）',
  api: 'alipay.trade.refund',
  purpose: '口径②（退款）：原文子串验签；响应面**无独立退款单号**，渠道引用取 trade_no（T11 消费）',
  rawBody: `{"alipay_trade_refund_response":${refundSource},"sign":"${refundSign}"}`,
  expect: { verifyResponse: true, extractedNode: refundSource, fundChange: 'Y' },
});

/* --------------------------- ⑤ 出站签名稳定向量 --------------------------- */

const requestParams = {
  app_id: '9021000000000000',
  method: 'alipay.trade.query',
  charset: 'utf-8',
  sign_type: 'RSA2',
  timestamp: '2026-10-06 12:00:00',
  version: '1.0',
  biz_content: JSON.stringify({ out_trade_no: OUT_TRADE_NO }),
};
const requestCanonical = requestSource(requestParams);
const requestSign = signWith(requestCanonical, keys.appPrivatePem);
mustVerify('request-sign', requestCanonical, requestSign, keys.appPublicPem);
write('request-sign.json', {
  name: 'request-sign',
  source: 'self-made（T6 自造）',
  purpose:
    '出站签名稳定向量（RSA PKCS#1 v1.5 确定性 ⇒ 金标可回放）：params 的插入序**故意乱序**，' +
    '钉住「按名 ASCII 升序 + sign_type=RSA2 同序」',
  api: 'alipay.trade.query',
  params: requestParams,
  expect: { signSource: requestCanonical, sign: requestSign },
});

console.log('[done] all fixtures generated & self-verified');
