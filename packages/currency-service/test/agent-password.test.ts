import { describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, verifyPassword } from '../src/agent/agent-password';

describe('agent password：scrypt 哈希/校验', () => {
  it('hash → verify true；错口令 false；格式 s1$N$r$p$salt$hash', async () => {
    const hash = await hashPassword('secret-123');
    expect(hash).toMatch(/^s1\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('secret-123', hash)).toBe(true);
    expect(await verifyPassword('secret-124', hash)).toBe(false);
    expect(await verifyPassword('secret-123', 'bad')).toBe(false);
    expect(await verifyPassword('secret-123', 's2$1$1$1$a$b')).toBe(false);
  });

  it('同一口令两次 hash 盐不同 ⇒ 串不同，但都能校验', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('generatePassword：12 字符 base64url；空口令 hash 抛错', async () => {
    const p = generatePassword();
    expect(p).toMatch(/^[A-Za-z0-9_-]{12}$/);
    await expect(hashPassword('')).rejects.toThrow(/不能为空/);
  });
});
