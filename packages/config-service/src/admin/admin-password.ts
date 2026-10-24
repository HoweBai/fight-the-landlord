import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * 管理面口令哈希 = `node:crypto` scrypt（规格 §2.1；设计 D5）——**零新依赖、零原生编译链**
 * （`Dockerfile.config-service` 里没有 bcrypt 那一套 python3/make/g++/node-pre-gyp）。
 *
 * 存储格式逐字：`s1$<N>$<r>$<p>$<saltB64>$<hashB64>`（salt = `randomBytes(16)`；标准 base64）。
 *
 * ⚠️ **`maxmem` 必须显式传**：生产档 `128·N·r = 128MiB` > node 默认 32MB —— 不传就是必然
 * 抛错的经典坑。生产默认逐字 `{N: 2^17, r: 8, p: 1, maxmem: 160MiB, keylen: 32}`（OWASP
 * 最低推荐档；maxmem 留了开销余量）。
 *
 * ⚠️ **线程池注记（S12，运维排障用）**：`crypto.scrypt` 走 libuv 线程池（默认 4）⇒ 并发
 * 登录尝试最坏 ≈4×160MiB 瞬态块 + 池占用（波及其它 crypto/IO 的排队）。数量由登录失败桶
 * （5 次/5 分钟/IP）罩住——「登录变慢/请求卡」的第一怀疑对象。（异步 `scrypt` 而非
 * `scryptSync`：同步版会**阻塞事件循环**，把单次尝试的成本广播给全服务。）
 */

/** scrypt 参数（`keylen` 只用于哈希侧；验证侧从存储串的哈希段长度推导）。 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem: number;
  keylen: number;
}

/**
 * 生产默认参数（规格 §2.1 逐字；`AdminModule` 经 `ADMIN_SCRYPT_PARAMS` 令牌注入，
 * 单测注入小参数保持快——参数被改动时 `admin-password.test.ts` 的默认参端到端必红）。
 */
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 131072 /* 2^17 */,
  r: 8,
  p: 1,
  maxmem: 160 * 1024 * 1024,
  keylen: 32,
});

const SALT_BYTES = 16;
const FORMAT_PREFIX = 's1';
const FORMAT_SEGMENTS = 6;

/** 异步 scrypt → Promise（promisify 手写：`scrypt` 有重载，promisify 的类型会打架）。 */
function derive(
  plain: string,
  salt: Buffer,
  keylen: number,
  params: Pick<ScryptParams, 'N' | 'r' | 'p' | 'maxmem'>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)),
    );
  });
}

/** 哈希（默认 = 生产参数）。返回格式串；`plain` 永不出现在返回值里。 */
export async function hashPassword(
  plain: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(plain, salt, params.keylen, params);
  return [
    FORMAT_PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * 校验（格式串 → 从**存储串**解析 N/r/p；`keylen` = 哈希段解出的字节数——
 * 格式里没有 keylen 段，这是唯一自洽的推导）。
 *
 * 纪律（规格 §2.1）：解析失败/前缀非 `s1`/段数不符/参数非法 ⇒ **false 不抛**；
 * 比较用 `timingSafeEqual`（**长度先守卫**——不等长直接 false，不比；`timingSafeEqual`
 * 对不等长入参会 throw）。派生按默认 maxmem 预算封顶：128·N·r 超预算的存储串按损坏
 * 处理（防「库里的畸形串把运维内存打爆」——我们自己的哈希永远在预算内）。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== FORMAT_SEGMENTS || parts[0] !== FORMAT_PREFIX) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || N <= 1 || Math.log2(N) % 1 !== 0) return false; // N 须为 >1 的 2 的幂
  if (!Number.isSafeInteger(r) || r <= 0) return false;
  if (!Number.isSafeInteger(p) || p <= 0) return false;
  if (128 * N * r > DEFAULT_SCRYPT_PARAMS.maxmem) return false; // 超生产资源预算 = 损坏串

  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || expected.length === 0) return false; // 长度守卫：空段不比

  let derived: Buffer;
  try {
    derived = await derive(plain, salt, expected.length, {
      N,
      r,
      p,
      maxmem: DEFAULT_SCRYPT_PARAMS.maxmem,
    });
  } catch {
    // 驱动/参数层的任何异常都归为「校验不通过」（本函数对外承诺不抛）
    return false;
  }
  // 长度守卫先于比较（此处按构造恒等长——保留为纪律，与登录比较既有形态一致）
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
