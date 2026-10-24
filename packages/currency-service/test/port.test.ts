import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * E2（§2.3「禁止硬编码端口」）+ 货币片规格 §2.1 的**三端口写死**：
 * HTTP **3004** / RPC(TCP) **3104** / metrics **9004**。
 *
 * ⚠️ 判据（与 `user-service/test/port.test.ts` 同形，扩到三端口）：
 *  - 反向：源码里**不得**出现 `listen(3004)` 这类硬编码字面量调用；
 *  - 正向①：**必须**读 `process.env.PORT`，且默认值逐字是 `'3004'`；
 *  - 正向②：**必须**读 `process.env.RPC_PORT`，且默认值逐字是 `'3104'`
 *    （RPC 端口仅在 compose 内网 `expose`，宿主映射只允许在 override —— 见 slice-07.2-deploy）；
 *  - 正向③：`startMetricsListener({ port: 9004 })` 逐字在场（独立 `node:http` 监听面，
 *    走 `docker exec` 探针；不在 3004/3104 的序列上）；
 *  - 外加**探针判别力自证**（R115/R150）：把硬编码写回去，反向正则必须能抓住它。
 */
const SRC = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'src/main.ts'),
  'utf-8',
);

describe('E2：currency-service 必须从 PORT/RPC_PORT 读端口（§2.3「禁止硬编码端口」）', () => {
  it('反向：源码里不得出现 `listen(3004)` 这种字面量调用', () => {
    expect(/listen\(\s*3004\s*\)/.test(SRC), 'main.ts 仍在硬编码 listen(3004)').toBe(false);
  });

  it('正向①：必须读 process.env.PORT，并以 3004 为默认值', () => {
    expect(SRC).toMatch(/process\.env\.PORT/);
    expect(SRC, 'PORT 的默认值必须是本服务的端口 3004').toMatch(/PORT\s*\?\?\s*'3004'/);
  });

  it('正向②：必须读 process.env.RPC_PORT，并以 3104 为默认值（规格 §2.1 写死）', () => {
    expect(SRC).toMatch(/process\.env\.RPC_PORT/);
    expect(SRC, 'RPC_PORT 的默认值必须逐字是 3104').toMatch(/RPC_PORT\s*\?\?\s*'3104'/);
  });

  it('正向③：metrics 监听逐字 `startMetricsListener({ port: 9004 })`（规格 §2.1⑤）', () => {
    expect(SRC).toMatch(/startMetricsListener\(\s*\{\s*port:\s*9004\s*\}\s*\)/);
  });

  it('探针判别力：把硬编码写回去，第一条必须红（否则反向断言是空测）', () => {
    expect(/listen\(\s*3004\s*\)/.test('  await app.listen(3004);')).toBe(true);
    // 负对照：读 env 的形态**不得**被反向正则命中
    expect(/listen\(\s*3004\s*\)/.test('  await app.listen(port);')).toBe(false);
    // 正对照判别力：三端口的正向正则对**错值**必须红（防「正则写成 `PORT` 就够」那种空转）
    expect(/RPC_PORT\s*\?\?\s*'3104'/.test("process.env.RPC_PORT ?? '3105'")).toBe(false);
    expect(/startMetricsListener\(\s*\{\s*port:\s*9004\s*\}\s*\)/.test('startMetricsListener({ port: 9005 })')).toBe(false);
  });
});
