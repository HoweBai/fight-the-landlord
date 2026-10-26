/**
 * slice-34：C1 记录 outbox（真栈：sweeper 五态）。
 *
 * 不依赖停服：直接向 `record:outbox` HSET 条目，验证运行中的 room-service sweeper：
 *  ok / replayed / corrupt / abandoned / rejected 五态 + CAS 删除 + DB 落库。
 *
 * 前置：以本分支源码构建的 room-service 在跑（CI 的 `conformance-stack.sh up` 默认即本机构建）。
 * ⚠️ 本机无 Docker 时只做 tsc；真栈执行登记「待权威轮」。
 */
import {
  encodeCards,
  encodeHand,
  type Card,
  type DdzSettlementResult,
  type RecordWriteRequest,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { INTERNAL_TOKEN, registerUser } from '../lib/http';
import { mysqlNum } from '../lib/mysql';
import { redisCli } from '../lib/redis';
import { execCurl, seriesValueExact } from '../lib/prom-text';

const OUTBOX_KEY = 'record:outbox';
const OUTBOX_TTL_MS = 86_400_000;
const BASE_SCORE = 15;
const ROOM_SERVICE = { container: 'ftl-room-service', port: 9002 } as const;
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-5);

function sampleCards(offset: number, count: number): Card[] {
  const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];
  const pool: Card[] = [];
  for (const r of ranks) for (let s = 0; s < 5; s += 1) pool.push({ r, s });
  const out: Card[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[(offset + i) % pool.length]!);
  return out;
}

/** 与 slice-33 的 `craftDdzWinningRecord` 同形（复制并注明来源；勿跨切片 import 私有夹具）。 */
function craftDdzWinningRecord(
  roomCode: string,
  userId: string,
  endedAt: number,
): RecordWriteRequest {
  const multiplier = 2;
  const result: DdzSettlementResult = {
    roomCode,
    baseScore: BASE_SCORE,
    winner: 'landlord',
    landlordSeat: 0,
    farmerSeats: [1, 2],
    multiplier,
    spring: 'none',
    landlordScoreChange: BASE_SCORE * multiplier * 2,
    farmerScoreChange: -BASE_SCORE * multiplier,
  };
  return {
    roomCode,
    gameVersion: 1,
    mode: 'random',
    baseScore: BASE_SCORE,
    result,
    seats: [
      { seat: 0, userId, isRobot: false, robotId: null, hand: encodeHand(sampleCards(0, 17), 17) },
      {
        seat: 1,
        userId: null,
        isRobot: true,
        robotId: 'bot-s34-ddz-1',
        hand: encodeHand(sampleCards(17, 17), 17),
      },
      {
        seat: 2,
        userId: null,
        isRobot: true,
        robotId: 'bot-s34-ddz-2',
        hand: encodeHand(sampleCards(34, 17), 17),
      },
    ],
    bottomCards: encodeCards(sampleCards(51, 3)),
    startedAt: endedAt - 60_000,
    endedAt,
  };
}

function entryRaw(request: RecordWriteRequest, createdAt: number): string {
  return JSON.stringify({ request, createdAt, gameType: 'doudizhu' });
}

function recordsCount(roomCode: string): number {
  return mysqlNum(`SELECT COUNT(*) FROM game_records WHERE room_code='${roomCode}'`);
}

function playersCount(roomCode: string): number {
  return mysqlNum(
    `SELECT COUNT(*) FROM game_record_players p JOIN game_records r ON p.record_id=r.id WHERE r.room_code='${roomCode}'`,
  );
}

function fieldExists(field: string): boolean {
  return redisCli(['HEXISTS', OUTBOX_KEY, field]).trim() === '1';
}

function resendCount(result: string): number {
  const res = execCurl(ROOM_SERVICE.container, ROOM_SERVICE.port, INTERNAL_TOKEN);
  if (res.status !== 200) {
    throw new ConformanceError(`room-service /metrics HTTP ${res.status}`);
  }
  return (
    seriesValueExact(res.body, 'record_outbox_resend_total', {
      game_type: 'doudizhu',
      result,
    }) ?? 0
  );
}

async function poll<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (ok(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

export async function runSlice34(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const human = await registerUser(145);
  const room = `C1${RUN_TAG}`;
  const field = `${room}:1`;
  const request = craftDdzWinningRecord(room, human.id, Date.now());
  const oldRoom = `C1O${RUN_TAG}`;
  const rejRoom = `C1R${RUN_TAG}`;
  const badField = `BAD${RUN_TAG}`;

  try {
    step('⓪ 起手：per-run room code + 库里 0 行 + 清本片 field');
    redisCli(['HDEL', OUTBOX_KEY, field, badField, `${oldRoom}:1`, `${rejRoom}:1`]);
    checks.eq(recordsCount(room), 0, `⓪ ${room} 起手 0 行`);

    step('① 有效条目 ⇒ sweeper 投递 ⇒ ok + DB 1 行/3 玩家 + 出箱');
    const okBefore = resendCount('ok');
    redisCli(['HSET', OUTBOX_KEY, field, entryRaw(request, Date.now() - 1_000)]);
    const okPoll = await poll(
      () => ({
        gone: !fieldExists(field),
        records: recordsCount(room),
        players: playersCount(room),
      }),
      (v) => v.gone && v.records === 1 && v.players === 3,
      60_000,
    );
    checks.that(okPoll.ok, `① 60s 内出箱 + 记录 1 行/玩家 3 行（实际 ${JSON.stringify(okPoll.last)}）`);
    checks.eq(fieldExists(field), false, '① field 已 CAS 删除');
    checks.eq(recordsCount(room), 1, '① game_records 恰 1 行');
    checks.eq(playersCount(room), 3, '① game_record_players 恰 3 行');
    checks.that(resendCount('ok') >= okBefore + 1, '① record_outbox_resend_total{result="ok"} 增量');

    step('② 同 field 重投 ⇒ 幂等命中 ⇒ replayed + 记录仍 1 行');
    const replayedBefore = resendCount('replayed');
    redisCli(['HSET', OUTBOX_KEY, field, entryRaw(request, Date.now() - 1_000)]);
    const replayedPoll = await poll(
      () => ({ gone: !fieldExists(field), records: recordsCount(room), players: playersCount(room) }),
      (v) => v.gone && v.records === 1 && v.players === 3,
      60_000,
    );
    checks.that(replayedPoll.ok, `② 重投后出箱且记录仍 1/3（实际 ${JSON.stringify(replayedPoll.last)}）`);
    checks.eq(recordsCount(room), 1, '② 幂等：记录仍恰 1 行');
    checks.eq(playersCount(room), 3, '② 幂等：玩家仍恰 3 行');
    checks.that(
      resendCount('replayed') >= replayedBefore + 1,
      '② record_outbox_resend_total{result="replayed"} 增量',
    );

    step('③ 坏 JSON ⇒ corrupt + 删除');
    const corruptBefore = resendCount('corrupt');
    redisCli(['HSET', OUTBOX_KEY, badField, 'not-json']);
    const corruptPoll = await poll(() => !fieldExists(badField), (gone) => gone, 60_000);
    checks.that(corruptPoll.ok, '③ 坏 JSON field 在 60s 内被删除');
    checks.that(
      resendCount('corrupt') >= corruptBefore + 1,
      '③ record_outbox_resend_total{result="corrupt"} 增量',
    );

    step('④ TTL 超龄 ⇒ abandoned + 删除 + 无记录');
    const oldReq = { ...request, roomCode: oldRoom };
    const abandonedBefore = resendCount('abandoned');
    redisCli([
      'HSET',
      OUTBOX_KEY,
      `${oldRoom}:1`,
      entryRaw(oldReq, Date.now() - OUTBOX_TTL_MS - 1_000),
    ]);
    const abandonedPoll = await poll(
      () => ({ gone: !fieldExists(`${oldRoom}:1`), records: recordsCount(oldRoom) }),
      (v) => v.gone && v.records === 0,
      60_000,
    );
    checks.that(abandonedPoll.ok, `④ 超龄条目出箱且无记录（实际 ${JSON.stringify(abandonedPoll.last)}）`);
    checks.eq(recordsCount(oldRoom), 0, '④ 超龄条目未写库');
    checks.that(
      resendCount('abandoned') >= abandonedBefore + 1,
      '④ record_outbox_resend_total{result="abandoned"} 增量',
    );

    step('⑤ 确定性拒收（result 形状非法）⇒ rejected + 删除 + 无记录');
    const rejReq = { ...request, roomCode: rejRoom, result: {} as never };
    const rejectedBefore = resendCount('rejected');
    redisCli(['HSET', OUTBOX_KEY, `${rejRoom}:1`, entryRaw(rejReq, Date.now() - 1_000)]);
    const rejectedPoll = await poll(
      () => ({ gone: !fieldExists(`${rejRoom}:1`), records: recordsCount(rejRoom) }),
      (v) => v.gone && v.records === 0,
      60_000,
    );
    checks.that(rejectedPoll.ok, `⑤ 拒收条目出箱且无记录（实际 ${JSON.stringify(rejectedPoll.last)}）`);
    checks.eq(recordsCount(rejRoom), 0, '⑤ 拒收条目未写库');
    checks.that(
      resendCount('rejected') >= rejectedBefore + 1,
      '⑤ record_outbox_resend_total{result="rejected"} 增量',
    );

    step('收尾：清本片 field（记录行保留，per-run room code 不影响任何判据）');
    redisCli(['HDEL', OUTBOX_KEY, field, badField, `${oldRoom}:1`, `${rejRoom}:1`]);
    checks.ok('收尾：本片 outbox field 已清理');
    info(`slice-34 room=${room}（记录行保留在测试库）`);
  } finally {
    redisCli(['HDEL', OUTBOX_KEY, field, badField, `${oldRoom}:1`, `${rejRoom}:1`]);
  }
  return { passed: checks.passed };
}
