/**
 * 多副本回归入口（预演环境显式运行；不进 `run.ts --list`，避免单实例 CI 误跑）。
 *
 * 用法：
 *   MULTI_REPLICA_BASE_URL=https://<site> GW=https://<site> MULTI_REPLICA_REQUIRED=1 \
 *     pnpm --filter @fight-the-landlord/conformance build && node dist/multi-replica-main.js
 *
 * 判据（spec 2026-10-27 §6.2）：
 *  1. 同一用户第二次连接 ⇒ 第一次连接被服务端断开（跨 Pod 顶替）；
 *  2. 第二次连接仍可用（能收到 ack）。
 *
 * 跨 Pod 房间广播与局终唯一执行由单测（ConnectionRegistry / FinalizationGuard / leader
 * lease）与预演环境人工对局覆盖；本脚本至少钉住「顶替」这条最容易回归的链。
 */
import { ConformanceError, info } from './lib/assert';
import { GATEWAY_URL, registerUser } from './lib/http';
import { HarnessClient } from './lib/client';

async function main(): Promise<void> {
  const base = process.env.MULTI_REPLICA_BASE_URL;
  if (!base) {
    if (process.env.MULTI_REPLICA_REQUIRED === '1') {
      throw new ConformanceError('缺 MULTI_REPLICA_BASE_URL（REQUIRED=1）');
    }
    console.log('⚠️ 未设置 MULTI_REPLICA_BASE_URL ⇒ 跳过多副本回归');
    return;
  }
  if (!GATEWAY_URL.startsWith(base.replace(/\/$/, ''))) {
    throw new ConformanceError(`GW（${GATEWAY_URL}）必须与 MULTI_REPLICA_BASE_URL（${base}）一致`);
  }

  info(`多副本顶替回归：${base}`);
  const user = await registerUser(99);
  const first = await HarnessClient.connect('replica-old', user);
  info('旧连接已建立');
  const second = await HarnessClient.connect('replica-new', user);
  info('新连接已建立');

  const reason = await first.waitForDisconnect(8000);
  if (!/io server disconnect|transport close/.test(reason)) {
    throw new ConformanceError(`旧连接断开原因异常：${reason}`);
  }
  info(`旧连接被顶替（reason=${reason}）`);

  // 新连接仍然可用：发一个必然被服务端回 ack 的消息（room.match 非法载荷也会回错误码，
  // 但 ack 本身证明连接未被连带断开）。
  const ack = await second.send('room.match', {});
  if (typeof ack.code !== 'number') {
    throw new ConformanceError(`新连接 ack 形态异常：${JSON.stringify(ack)}`);
  }
  info(`新连接可用（ack.code=${ack.code}）`);
  second.close();
  console.log('✅ 多副本顶替回归通过');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
