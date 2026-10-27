/**
 * WS 压测脚本（k3s 扩缩容 spec 2026-10-27 C3）。
 *
 * 用法（预演环境）：
 *   GW=https://<site> pnpm --filter @fight-the-landlord/conformance build
 *   GW=https://<site> pnpm --filter @fight-the-landlord/conformance ws-load -- --users 500 --hold 300
 *
 * 注册 --users 个真实账号并建立 WS 连接，保持 --hold 秒，输出连接耗时分布。
 * 只用于容量校准，不写业务数据（不建房、不对局）。
 */
import { performance } from 'node:perf_hooks';
import { GATEWAY_URL, registerUser } from './lib/http';
import { HarnessClient } from './lib/client';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

async function main(): Promise<void> {
  const users = arg('users', 100);
  const hold = arg('hold', 120);
  const batch = arg('batch', 50);
  const allowSingleIp = process.argv.includes('--allow-single-ip');
  if (!Number.isFinite(users) || users <= 0) throw new Error('--users 必须是正整数');
  if (users > 5 && !allowSingleIp) {
    throw new Error(
      '单源 IP 受 gateway 的 WS 5 连接上限（且注册受 HTTP IP 限流）—— ' +
        '容量压测必须从多个源 Pod/机器分别运行，或仅做冒烟时加 --allow-single-ip。',
    );
  }

  console.log(`目标 ${GATEWAY_URL}：${users} 个连接，保持 ${hold}s`);
  const clients: HarnessClient[] = [];
  const latencies: number[] = [];
  let failed = 0;

  for (let start = 0; start < users; start += batch) {
    const end = Math.min(users, start + batch);
    await Promise.all(
      Array.from({ length: end - start }, async (_, k) => {
        const index = start + k;
        try {
          const user = await registerUser(index);
          const t0 = performance.now();
          const client = await HarnessClient.connect(`load-${index}`, user);
          latencies.push(performance.now() - t0);
          clients.push(client);
        } catch (err) {
          failed += 1;
          console.error(`连接 ${index} 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    console.log(`已建立 ${clients.length}/${users}（失败 ${failed}）`);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  console.log(
    JSON.stringify({
      users,
      connected: clients.length,
      failed,
      connectMsP50: Math.round(pct(0.5)),
      connectMsP95: Math.round(pct(0.95)),
      connectMsMax: Math.round(sorted.at(-1) ?? 0),
    }),
  );

  if (hold > 0) {
    console.log(`保持连接 ${hold}s…`);
    await new Promise((r) => setTimeout(r, hold * 1000));
  }
  for (const c of clients) c.close();
  console.log('完成');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
