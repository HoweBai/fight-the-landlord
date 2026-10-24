import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
  type ScryptParams,
} from '../src/admin/admin-password';

/**
 * scrypt 口令哈希（规格 §2.1；判据 C2）。
 *
 *  - 格式逐字 `s1$N$r$p$saltB64$hashB64`（salt = `randomBytes(16)`、标准 base64）；
 *  - 生产默认参数逐字 `{N: 131072(=2^17), r: 8, p: 1, maxmem: 160*1024*1024, keylen: 32}`；
 *  - 单测注入小参数（`N=4096, maxmem=16MiB`）保持快；**另留一条默认参数端到端**
 *    （hash→verify→错口令 false）钉默认值不许漂移（⚙️15）；
 *  - 校验：解析失败/前缀非 `s1`/段数不符 ⇒ **false 不抛**；比较 `timingSafeEqual`
 *    （长度先守卫——不等长直接 false，不比）。
 */

/** 单测注入的小参数（规格 §2.1 逐字示例：N=4096, maxmem=16MiB）。 */
const SMALL: ScryptParams = { N: 4096, r: 8, p: 1, maxmem: 16 * 1024 * 1024, keylen: 32 };

describe('scrypt 口令哈希（规格 §2.1）', () => {
  it('生产默认参数逐字 = 规格（N=2^17, r=8, p=1, keylen=32, maxmem=160MiB）', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 160 * 1024 * 1024,
      keylen: 32,
    });
    expect(2 ** 17).toBe(DEFAULT_SCRYPT_PARAMS.N);
  });

  it('格式逐字 `s1$N$r$p$saltB64$hashB64`：盐 16 字节且逐次随机、哈希 keylen 字节', async () => {
    const a = await hashPassword('correct horse battery staple', SMALL);
    const b = await hashPassword('correct horse battery staple', SMALL);

    const parts = a.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('s1');
    expect(parts.slice(1, 4)).toEqual(['4096', '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16); // randomBytes(16)
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(32); // keylen
    // 盐随机 ⇒ 同口令两次哈希不同（防「固定盐」这类结构性缺陷）
    expect(b).not.toBe(a);
  });

  it('round-trip（小参注入）：同口令 true、错口令 false、大小写敏感、verify 从存储串取参', async () => {
    const stored = await hashPassword('S3cret-Pass', SMALL);

    // verifyPassword 不接收参数：N/r/p 从存储串解析 —— 小参哈希必须可验（「小参默认走参」）
    await expect(verifyPassword('S3cret-Pass', stored)).resolves.toBe(true);
    await expect(verifyPassword('s3cret-pass', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  it('损坏串一律 false 且不抛：段数/前缀/参数非法/空段（长度守卫）', async () => {
    const stored = await hashPassword('corruption-base-pw', SMALL);
    const [prefix, N, r, p, salt, hash] = stored.split('$') as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    const corrupt: Array<[string, string]> = [
      ['空串', ''],
      ['随手垃圾', 'not-a-stored-string'],
      ['前缀非 s1', `s2$${[N, r, p, salt, hash].join('$')}`],
      ['段数 5', [prefix, N, r, p, salt].join('$')],
      ['段数 7', [prefix, N, r, p, salt, hash, 'extra'].join('$')],
      ['N 非数字', [prefix, 'abc', r, p, salt, hash].join('$')],
      ['N=0', [prefix, '0', r, p, salt, hash].join('$')],
      ['N 非 2 的幂', [prefix, '3', r, p, salt, hash].join('$')],
      ['r 负数', [prefix, N, '-8', p, salt, hash].join('$')],
      ['p=0', [prefix, N, r, '0', salt, hash].join('$')],
      // 长度守卫：盐/哈希解出 0 字节 ⇒ 不等长直接 false（不进 timingSafeEqual——它会 throw）
      ['空盐段', [prefix, N, r, p, '', hash].join('$')],
      ['空哈希段', [prefix, N, r, p, salt, ''].join('$')],
      ['盐非 base64（解出空）', [prefix, N, r, p, '!!!!', hash].join('$')],
      // 内容被改（⚠️ 不能拿「截断」当损坏面：scrypt 末步 PBKDF2 对 dkLen **前缀一致**，
      // 截短后的哈希仍能验出正确口令——那是算法性质，不是可判别的损坏）
      ['哈希段被改', [prefix, N, r, p, salt, (hash[0] === 'A' ? 'B' : 'A') + hash.slice(1)].join('$')],
    ];
    for (const [label, s] of corrupt) {
      await expect(verifyPassword('corruption-base-pw', s), label).resolves.toBe(false);
    }
    // 非字符串（防御性守卫；正常路径上游已保证 string）
    await expect(verifyPassword('x', undefined as unknown as string)).resolves.toBe(false);
  });

  it('默认参数端到端（生产档 N=2^17）：hash → verify true → 错口令 false', async () => {
    const stored = await hashPassword('prod-params-end-to-end-pw');

    expect(stored.startsWith('s1$131072$8$1$')).toBe(true);
    expect(await verifyPassword('prod-params-end-to-end-pw', stored)).toBe(true);
    expect(await verifyPassword('prod-params-end-to-end-pX', stored)).toBe(false);
  }, 120_000);
});
