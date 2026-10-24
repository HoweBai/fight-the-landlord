#!/usr/bin/env node
/**
 * 广告片 T20 / T0 回填（规格 v1.4 §8 T0-2）：conformance 侧**广告回调测试密钥夹具**
 * 的生成脚本（本地一次性跑；产物 = 同目录单枚共享密钥文件 `callback-secret.txt` 入仓）。
 *
 * 用法（仓根或任意 cwd 均可）：
 *   node tools/conformance/fixtures/ad-callback/generate-fixtures.mjs
 *   node tools/conformance/fixtures/ad-callback/generate-fixtures.mjs --regenerate   # 强制作废重生成
 *
 * 口径（规格 v1.4 §2.4/§8：`sign = sha256(secret:trans_id)`，对称共享密钥）：
 *  - **测试专用**共享密钥：自造随机值（32 字节 hex），仅供 conformance 签名样本
 *    （`tools/conformance/src/lib/ad-callback.ts`）与 conformance 栈种子
 *    （`scripts/deploy/conformance-stack.sh` 经管理面 PUT 入 `ad_channel_config`，
 *    产品侧验签器现拉消费）**同源**使用——签名与验签必须读到同一枚值；真凭据永不入仓、
 *    只存平台后台与生产管理面（沿支付片 ⚙️14/§12 同一口径）。**不建 stub 容器**
 *    （ads 无出站调用）。
 *  - 形态：**单文件** `callback-secret.txt`，内容 = 纯文本密钥（hex；**无尾换行**——
 *    shell `$(cat)` 与 TS 装载器两侧都按无结束符对铆，防 byte-exact 签名错配）。
 *  - 幂等：文件在场 ⇒ 原样不动（重跑无副作用）；`--regenerate` ⇒ 强制作废重生成。
 *  - 本目录触发 gitleaks 全历史扫描 ⇒ `.gitleaks.toml` **允许项 #8**（目录锚定，
 *    PEM 时代与共享密钥时代同一路径）+ M0.1 安全扫描规格。
 *  - 【T0-2 已回填】旧占位形态（RSA-2048 PEM 对 `callback-private/public.pem`）已随
 *    真实算法（对称密钥）退役，两 PEM 在同笔改动中删除（防半替）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = join(DIR, 'callback-secret.txt');
const FORCE = process.argv.includes('--regenerate');

if (existsSync(SECRET_FILE) && !FORCE) {
  console.log('[skip] callback-secret.txt 已在场（幂等——重跑无副作用；强制作废重生成用 --regenerate）');
  process.exit(0);
}
// 强制作废重生成：旧形态两 PEM 若残留一并清（PEM→共享密钥换代的半替防护）。
for (const f of [join(DIR, 'callback-private.pem'), join(DIR, 'callback-public.pem'), SECRET_FILE]) {
  if (existsSync(f)) rmSync(f);
}

// 真形态 = 32 字节随机值的 hex 编码（64 字符；只含 [0-9a-f]，跨 JSON/shell/URL 三面无转义面）。
const secret = randomBytes(32).toString('hex');

// ⚠️ 显式不写尾换行：签名 = sha256(secret:trans_id) 是 byte-exact 面，多余的 '\n'
// 会让 conformance 签名与栈种子入库值差一个字节 ⇒ 全量 bad_sign 假红。
writeFileSync(SECRET_FILE, secret, { encoding: 'utf8' });
console.log('[write] callback-secret.txt');
console.log('[done] 广告回调测试共享密钥就位（32B hex；conformance 签名/栈种子同源消费）');
