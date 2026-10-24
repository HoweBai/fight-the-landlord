import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * E2（§2.3「禁止硬编码端口」）：**每个**服务都必须从 `process.env.PORT` 读端口，
 * 并以自己的端口为默认值。
 *
 * ⚠️ 判据是**两条并列**：
 *  - 反向：源码里**不得**再有 `listen(3001)` 这种字面量（那是「改了个字面量」之外
 *    还必须证明的东西 —— 只有正向读 env 才能让 compose 的 `PORT` 真正生效）；
 *  - 正向：**必须**读 `process.env.PORT`，且默认值逐字是 3001；
 *  - 外加**探针判别力自证**（R115/R150）：把硬编码写回去，反向正则必须能抓住它。
 */
const SRC = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'src/main.ts'),
  'utf-8',
);

describe('E2：user-service 必须从 PORT 读端口（§2.3「禁止硬编码端口」）', () => {
  it('反向：源码里不得再出现 `listen(3001)` 这种字面量调用', () => {
    expect(/listen\(\s*3001\s*\)/.test(SRC), 'main.ts 仍在硬编码 listen(3001)').toBe(false);
  });

  it('正向：必须读 process.env.PORT，并以 3001 为默认值', () => {
    expect(SRC).toMatch(/process\.env\.PORT/);
    expect(SRC, 'PORT 的默认值必须是本服务的端口 3001').toMatch(/PORT\s*\?\?\s*'3001'/);
  });

  it('探针判别力：把硬编码写回去，第一条必须红（否则反向断言是空测）', () => {
    expect(/listen\(\s*3001\s*\)/.test('  await app.listen(3001);')).toBe(true);
    // 负对照：读 env 的形态**不得**被反向正则命中
    expect(/listen\(\s*3001\s*\)/.test('  await app.listen(port);')).toBe(false);
  });
});
