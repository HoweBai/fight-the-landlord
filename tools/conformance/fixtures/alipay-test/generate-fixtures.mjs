#!/usr/bin/env node
/**
 * 支付片 T16：conformance 侧**支付宝测试密钥夹具**的生成脚本（本地一次性跑；产物 = 同目录四 PEM 入仓）。
 *
 * 用法（仓根或任意 cwd 均可）：
 *   node tools/conformance/fixtures/alipay-test/generate-fixtures.mjs
 *
 * 口径（规格 ⚙️14 / §12「仅测试密钥对入仓；生产密钥永不入仓、只存服务器 .env」）：
 *  - **复用** T6 金标夹具的同一对测试密钥（`packages/payment-service/test/fixtures/alipay/keys.json`
 *    —— 由 `generate-fixtures.mjs`（T6 侧）生成/复用）。同一对 = 一份密钥材料、两处消费面
 *    （payment-service 单测金标 + conformance 双向金标），不给仓库再添第二对私钥；
 *  - 四 PEM 的角色（与 stub / conformance-stack.sh 的消费口径对铆）：
 *      `app-private.pem`   —— 应用侧私钥（我们出站签名；conformance-stack.sh base64 后注入
 *                              payment-service 的 `ALIPAY_PRIVATE_KEY`）
 *      `app-public.pem`    —— 应用侧公钥（**stub 用它验我们请求签名**——⚙️14 双向金标方向 ①）
 *      `alipay-private.pem`—— 渠道侧私钥（**stub 用它签响应/通知**——双向金标方向 ② 的签发侧）
 *      `alipay-public.pem` —— 渠道侧公钥（payment-service `ALIPAY_PUBLIC_KEY` 验 stub 响应/通知）
 *  - 幂等：keys.json 在哪四份就在哪，重跑产物逐字节相同（文件内容即 keys.json 内嵌的 PEM 原文）；
 *  - 本目录触发 gitleaks 全历史扫描 ⇒ `.gitleaks.toml` **允许项 #5**（目录锚定）+ 同提交改闸
 *    （`slice-07.4-pipeline.ts` C6③ 计数 4→5）+ M0.1 安全扫描规格同步——照 `190a6cc`（#4）机制。
 *
 * 沙箱联调（打 tag 前置，规格 §6.4）若采集到真件：真件只进服务器 `.env`，**不进**本目录。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = join(DIR, '..', '..', '..', '..', 'packages', 'payment-service', 'test', 'fixtures', 'alipay', 'keys.json');

if (!existsSync(KEYS_FILE)) {
  console.error(`❌ 缺 T6 金标夹具 ${KEYS_FILE} —— 先跑 packages/payment-service/test/fixtures/alipay/generate-fixtures.mjs`);
  process.exit(1);
}
const keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));

const WRITE = [
  ['app-private.pem', keys.appPrivatePem],
  ['app-public.pem', keys.appPublicPem],
  ['alipay-private.pem', keys.alipayPrivatePem],
  ['alipay-public.pem', keys.alipayPublicPem],
];

for (const [name, pem] of WRITE) {
  if (typeof pem !== 'string' || !pem.includes('BEGIN')) {
    console.error(`❌ keys.json 缺 ${name} 对应的 PEM 字段（夹具形态变了？）`);
    process.exit(1);
  }
  writeFileSync(join(DIR, name), pem.endsWith('\n') ? pem : `${pem}\n`);
  console.log(`[write] ${name}`);
}
console.log('[done] 四 PEM 就位（源 = T6 keys.json 的同一对测试密钥）');
