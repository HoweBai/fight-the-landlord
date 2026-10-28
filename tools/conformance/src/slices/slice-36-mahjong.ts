/**
 * slice-36：四川麻将全链路（T12 / spec §7）。
 *
 * 覆盖：管理面开启 → 4 人匹配/开局视图（13 张/牌墙/activeSeats/无泄漏）→ 换三张/定缺/
 * 出牌/claim 主路径（独立 oracle）→ 断线重连 → 终局（finished mahjong）→ 结算
 * （4 座零和/事件账）→ 记录（`gameType=mahjong` 双表、只给本人初始手牌）。
 *
 * ⚠️ 前置：本切片经管理面开启 `game.mahjong.enabled` + `freeRoomEnabled`（种子 false），
 *    收尾 finally 还原；残留会污染后续手工复跑。
 * ⚠️ 独立 oracle：`mahjong-driver` 不 import shared 规则，只读视图字段。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { adminGetConfig, adminLogin, adminPutConfig, getJson, registerUser } from '../lib/http';
import { HarnessClient } from '../lib/client';
import {
  currentMahjongView,
  playMahjongToEnd,
  reconnectMahjongSeat,
  startMahjongRoom,
} from '../lib/mahjong-driver';

const MAHJONG_ENABLED_KEY = 'game.mahjong.enabled';
const MAHJONG_FREE_KEY = 'game.mahjong.freeRoomEnabled';

async function putOrThrow(admin: string, key: string, value: unknown): Promise<void> {
  const res = await adminPutConfig(key, value, admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`管理面 PUT ${key}=${JSON.stringify(value)} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/**
 * 开启麻将（总开关 + 免费场），用一次 `room.match` 探测配置缓存生效；
 * 返回收尾还原函数。
 */
async function enableMahjong(): Promise<{ disable: () => Promise<void> }> {
  const admin = await adminLogin();
  /**
   * 风险谓词：种子默认 false，但测试服可能被其他片/人工改开（sameIp/sameDevice 开时
   * 同机 4 个 conformance 账号无法成桌）。本片显式保存原值、临时关闭，收尾还原。
   */
  const cfg = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(admin);
  const prevPredicates = {
    sameIp: cfg.body?.data?.config?.['risk.predicate.sameIp']?.value === true,
    sameDevice: cfg.body?.data?.config?.['risk.predicate.sameDevice']?.value === true,
  };
  await putOrThrow(admin, 'risk.predicate.sameIp', false);
  await putOrThrow(admin, 'risk.predicate.sameDevice', false);
  await putOrThrow(admin, MAHJONG_FREE_KEY, true);
  await putOrThrow(admin, MAHJONG_ENABLED_KEY, true);

  const probeUser = await registerUser(130);
  const probe = await HarnessClient.connect('S36-probe', probeUser);
  const deadline = Date.now() + 60_000;
  try {
    for (;;) {
      const ack = await probe.send('room.match', {
        mode: 'random',
        baseScore: 15,
        gameType: 'mahjong',
        playerCount: 4,
      });
      if (ack.code === ErrCode.OK) break;
      if (Date.now() >= deadline) {
        throw new ConformanceError(
          `麻将开关 60s 内未生效（最后一次 room.match code=${ack.code} ${JSON.stringify(ack.message)}）`,
        );
      }
      await sleep(1000);
    }
    const off = await probe.send('room.unmatch', {});
    if (off.code !== ErrCode.OK) {
      throw new ConformanceError(`探针 room.unmatch 失败：code=${off.code}`);
    }
    info('麻将开关已开启（enabled + freeRoomEnabled）');
  } finally {
    probe.close();
  }

  return {
    disable: async () => {
      // 先还原风险谓词（与本片开关互不依赖；即使下面失败也要还原）。
      await adminPutConfig('risk.predicate.sameIp', prevPredicates.sameIp, admin);
      await adminPutConfig('risk.predicate.sameDevice', prevPredicates.sameDevice, admin);
      const freeOff = await adminPutConfig(MAHJONG_FREE_KEY, false, admin);
      if (freeOff.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`还原麻将免费场失败：${JSON.stringify(freeOff.body)}`);
      }
      const off = await adminPutConfig(MAHJONG_ENABLED_KEY, false, admin);
      if (off.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`还原麻将总开关失败：${JSON.stringify(off.body)}`);
      }
      info('麻将开关已还原为 false');
    },
  };
}

interface RecordSeatWire {
  seat: number;
  nickname?: string;
  isRobot?: boolean;
  melds: unknown[];
  discards: unknown[];
  lackSuit: number | null;
  isOut: boolean;
  fan?: number;
  delta: number;
}

interface MahjongRecordWire {
  roomCode: string;
  endedAt: number;
  gameType: string;
  mode: string;
  playerCount: number;
  dealerSeat: number;
  ownSeat: number;
  ownHand?: string;
  seats: RecordSeatWire[];
}

export async function runSlice36(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const setup = await enableMahjong();
  let room: Awaited<ReturnType<typeof startMahjongRoom>> | null = null;
  try {
    step('① 匹配/开局：4 人、13 张、牌墙 56、activeSeats 四人、无内部字段');
    room = await startMahjongRoom('S36');
    checks.eq(room.matched[0]?.gameType, 'mahjong', 'room.matched 带 gameType=mahjong');
    checks.eq(room.matched[0]?.playerCount, 4, 'room.matched 带 playerCount=4');
    for (const [i, view] of room.deals.entries()) {
      checks.eq(view.gameType, 'mahjong', `deal[${i}] gameType=mahjong`);
      checks.eq(view.playerCount, 4, `deal[${i}] playerCount=4`);
      checks.eq(view.hand.length, 13, `deal[${i}] 手牌 13 张`);
      checks.eq(view.wallCount, 56, `deal[${i}] 牌墙 56 张`);
      checks.eq(view.cardCounts.length, 4, `deal[${i}] cardCounts 长度=4`);
      checks.eq(view.activeSeats.length, 4, `deal[${i}] 换三张窗口 4 人同时待决策`);
      checks.eq(view.state, 'exchange', `deal[${i}] 默认成都规则进入换三张`);
      checks.that(view.lackSuits.every((s) => s === null), `deal[${i}] 尚未定缺`);
      checks.that(view.melds.length === 4 && view.discards.length === 4, `deal[${i}] 副露/弃牌按 4 座`);
      checks.that(!('wall' in (view as unknown as Record<string, unknown>)), `deal[${i}] 不下发牌墙本体`);
      assertNoLeak(view, `deal[${i}]`);
    }

    step('② 断线重连：换三张阶段同一账号回桌，ack 快照可用');
    const reconnected = await reconnectMahjongSeat(room, 1);
    const reView = currentMahjongView(reconnected);
    checks.that(reView !== undefined, '重连后拿到麻将视图');
    checks.eq(reView?.gameType, 'mahjong', '重连视图 gameType=mahjong');
    checks.eq(reView?.seat, 1, '重连视图 seat=1');
    checks.eq(reView?.hand.length, 13, '重连后手牌仍 13 张');
    checks.that(reView !== undefined && !('wall' in (reView as unknown as Record<string, unknown>)), '重连视图不下发牌墙');

    step('③ 驱动整局：换三张 → 定缺 → 出牌/claim → 终局');
    const out = await playMahjongToEnd(room);
    checks.atLeast(out.actions, 20, '整局动作数');
    const finished = out.finished;
    checks.eq(finished.payload?.gameType, 'mahjong', 'game.finished.gameType=mahjong');
    checks.that(Array.isArray(finished.payload?.winnerSeats), 'game.finished.winnerSeats 是数组');
    checks.that(
      finished.payload?.endReason === 'threeWinners' || finished.payload?.endReason === 'wallEmpty',
      'game.finished.endReason ∈ {threeWinners,wallEmpty}',
    );
    checks.that(Array.isArray(finished.payload?.huazhuSeats), 'game.finished.huazhuSeats 是数组');

    step('④ 结算：4 座零和 + 事件账 + burn/rake 形状');
    const settlement = out.settlement;
    checks.eq(settlement.gameType, 'mahjong', 'settlement.gameType=mahjong');
    checks.eq(settlement.playerCount, 4, 'settlement.playerCount=4');
    checks.that(Array.isArray(settlement.scoreChanges) && settlement.scoreChanges.length === 4, 'scoreChanges 恰 4 座');
    const sum = (settlement.scoreChanges as Array<{ delta: number }>).reduce((a, c) => a + c.delta, 0);
    checks.eq(sum, 0, 'scoreChanges 零和');
    checks.that(Array.isArray(settlement.events) && settlement.events.length > 0, 'settlement.events 非空事件账');
    checks.that(Array.isArray(settlement.burn), 'settlement.burn 是数组');
    checks.that(typeof settlement.rakeTotal === 'number' && settlement.rakeTotal >= 0, 'rakeTotal 非负数字');
    checks.that(Array.isArray(settlement.writtenOff), 'settlement.writtenOff 是数组');

    step('⑤ 记录：GET /api/records/mine?gameType=mahjong 双表可读、不泄漏他人手牌');
    const token = room.clients[0]!.user.accessToken;
    let record: MahjongRecordWire | undefined;
    const recordDeadline = Date.now() + 15_000;
    while (record === undefined && Date.now() < recordDeadline) {
      const res = await getJson<{ items: MahjongRecordWire[] }>(
        '/api/records/mine?gameType=mahjong',
        token,
      );
      if (res.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`麻将记录查询失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      record = res.body.data?.items.find((item) => item.roomCode === room!.roomCode);
      if (record === undefined) await sleep(500);
    }
    checks.that(record !== undefined, '本局麻将记录可在 15s 内查到');
    if (record !== undefined) {
      checks.eq(record.gameType, 'mahjong', '记录 gameType=mahjong');
      checks.eq(record.playerCount, 4, '记录 playerCount=4');
      checks.eq(record.seats.length, 4, '记录 seats 恰 4 条');
      checks.eq(record.ownHand?.length, 27, '记录只给自己的 27 位初始手牌');
      checks.that(!('rngSeed' in (record as unknown as Record<string, unknown>)), '记录不含 rngSeed');
      checks.that(
        record.seats.every((s) => !('hand' in (s as unknown as Record<string, unknown>))),
        '记录 seats 不含他人手牌',
      );
      checks.that(
        record.seats.every((s) => !('finalHand' in (s as unknown as Record<string, unknown>))),
        '记录 seats 不含他人终局手牌',
      );
      assertNoLeak(record, '麻将记录');
    }

    return { passed: checks.passed };
  } finally {
    for (const client of room?.clients ?? []) client.close();
    await setup.disable();
  }
}
