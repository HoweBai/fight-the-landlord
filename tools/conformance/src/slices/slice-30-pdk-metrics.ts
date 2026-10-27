/**
 * slice-30：跑得快指标真栈（A1）。
 *
 * 目标：PDK 真局后 `games_started_total` / `games_ended_total` 带
 * `game_type="paodekuai"` 增量 —— 单测之外的端到端标签证据。
 *
 * 前置：`game.paodekuai.enabled` 与 `game.paodekuai.friendRoomEnabled` 由本片开启
 * （探针建房要过好友房闸），finally 两键还原。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { INTERNAL_TOKEN, adminLogin, adminPutConfig, postJson, registerUser } from '../lib/http';
import { playPdkToEnd, startPdkRoom } from '../lib/pdk-driver';
import { execCurl, seriesValueExact } from '../lib/prom-text';

const PDK_ENABLED_KEY = 'game.paodekuai.enabled';
const PDK_FRIEND_KEY = 'game.paodekuai.friendRoomEnabled';
const ROOM_SERVICE = { container: 'ftl-room-service', port: 9002 } as const;

async function enablePdk(): Promise<() => Promise<void>> {
  const admin = await adminLogin();
  const disable = async () => {
    for (const key of [PDK_FRIEND_KEY, PDK_ENABLED_KEY]) {
      const off = await adminPutConfig(key, false, admin);
      if (off.body?.code !== ErrCode.OK) throw new ConformanceError(`还原 ${key} 失败`);
    }
  };
  try {
    for (const [key, value] of [
      [PDK_ENABLED_KEY, true],
      [PDK_FRIEND_KEY, true],
    ] as const) {
      const put = await adminPutConfig(key, value, admin);
      if (put.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`开启 ${key} 失败：${JSON.stringify(put.body)}`);
      }
    }
    // 与 slice-29 不同的账号序号（90 已被其探针占用，复用会撞 12011 等待房）
    const probeUser = await registerUser(95);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const probe = await postJson(
        '/api/rooms',
        { mode: 'random', gameType: 'paodekuai', playerCount: 3 },
        probeUser.accessToken,
      );
      if (probe.body?.code === ErrCode.OK) break;
      if (Date.now() >= deadline) throw new ConformanceError('game.paodekuai.enabled=true 60s 内未生效');
      await sleep(1_000);
    }
  } catch (err) {
    await disable().catch(() => undefined);
    throw err;
  }
  return disable;
}

export async function runSlice30(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const disable = await enablePdk();
  try {
    const readMetrics = () => {
      const res = execCurl(ROOM_SERVICE.container, ROOM_SERVICE.port, INTERNAL_TOKEN);
      if (res.status !== 200) throw new ConformanceError(`room-service /metrics HTTP ${res.status}`);
      return res;
    };
    const startedBefore =
      seriesValueExact(readMetrics().body, 'games_started_total', { game_type: 'paodekuai' }) ?? 0;
    const endedBefore =
      seriesValueExact(readMetrics().body, 'games_ended_total', { game_type: 'paodekuai' }) ?? 0;

    step('① 开 PDK ⇒ 匹配开局 ⇒ games_started_total{game_type="paodekuai"} 增量');
    const room = await startPdkRoom('S30');
    let started: number | null = null;
    const startedDeadline = Date.now() + 30_000;
    for (;;) {
      started = seriesValueExact(readMetrics().body, 'games_started_total', { game_type: 'paodekuai' });
      if (started !== null && started >= startedBefore + 1) break;
      if (Date.now() >= startedDeadline) break;
      await sleep(1_000);
    }
    checks.that(
      started !== null && started >= startedBefore + 1,
      `started = ${started}（基线 ${startedBefore}）`,
    );

    step('② 打到终局 ⇒ games_ended_total{game_type="paodekuai"} 增量');
    await playPdkToEnd(room, 'S30 一局');
    let ended: number | null = null;
    const endedDeadline = Date.now() + 30_000;
    for (;;) {
      ended = seriesValueExact(readMetrics().body, 'games_ended_total', { game_type: 'paodekuai' });
      if (ended !== null && ended >= endedBefore + 1) break;
      if (Date.now() >= endedDeadline) break;
      await sleep(1_000);
    }
    checks.that(ended !== null && ended >= endedBefore + 1, `ended = ${ended}（基线 ${endedBefore}）`);
    info(`slice-30：started ${startedBefore}→${started} · ended ${endedBefore}→${ended}`);
  } finally {
    await disable();
  }
  return { passed: checks.passed };
}
