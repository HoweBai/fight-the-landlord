/**
 * slice-29：跑得快全链路（S7.3 / spec §6.5）。
 *
 * 覆盖：开关（管理面）→ 匹配（gameType/playerCount）→ 开局视图（16 张/规则快照/无泄漏）→
 * 出牌/过牌（独立 oracle，单张策略）→ 终局（winnerSeats）→ 结算（零和向量）→
 * 记录（单独两表；旧查询不含 pdk）→ 房间列表按 gameType 过滤。
 *
 * ⚠️ **独立 oracle**：`pdk-driver` 只打单张，且不 import 服务端跑得快规则（见其文件头）。
 * ⚠️ 前置：`game.paodekuai.enabled=true`（本切片经管理面开启并轮询至建房生效，收尾还原）。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  setFriendRooms,
  type HarnessUser,
} from '../lib/http';
import { playPdkToEnd, startPdkRoom } from '../lib/pdk-driver';

const PDK_ENABLED_KEY = 'game.paodekuai.enabled';

/** 等待开关在 room-service 的配置缓存里生效（观测点 = 建房行为）。 */
async function enablePdk(): Promise<{ disable: () => Promise<void> }> {
  const admin = await adminLogin();
  // ⚠️ REST 建房有**两道闸**，顺序固定：controller 入口先查 `room.friendRoomEnabled`
  //    （关 ⇒ 12006），之后 service 才看玩法开关。只开 paodekuai 不开好友房 ⇒
  //    探针永远读 12006（2026-10-24 CI 实测：slice-14 收尾把好友房还原 false）。
  //    `setFriendRooms` 自带建房轮询（≤30s），且它的探针会占掉 opener 的等待房 ⇒
  //    下面的 paodekuai 探针必须用**另一个**账号（复用会先撞 12011）。
  const opener = await registerUser(88);
  await setFriendRooms(true, opener.accessToken);
  const put = await adminPutConfig(PDK_ENABLED_KEY, true, admin);
  if (put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(
      `管理面开启跑得快失败：HTTP ${put.status} ${JSON.stringify(put.body)}`,
    );
  }
  const probeUser = await registerUser(90);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = await postJson('/api/rooms', {
      mode: 'random',
      gameType: 'paodekuai',
      playerCount: 3,
    }, probeUser.accessToken);
    if (probe.body?.code === ErrCode.OK) break;
    if (Date.now() >= deadline) {
      throw new ConformanceError(
        `game.paodekuai.enabled=true 60s 内未生效（最后一次 ${JSON.stringify(probe.body)}）`,
      );
    }
    await sleep(1000);
  }
  return {
    disable: async () => {
      const off = await adminPutConfig(PDK_ENABLED_KEY, false, admin);
      if (off.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`还原跑得快开关失败：${JSON.stringify(off.body)}`);
      }
      // 好友房开关一并还原（本片是当前最后一片；残留会污染手工复跑/后续增片）。
      // ⚠️ 关闭探针必须用**全新账号**：opener/probeUser 都已有等待房，复用会先撞 12011。
      // ⚠️ 先留 2s 让广播失效落地：`setFriendRooms(false)` 的首探若撞上**陈旧缓存**
      //    会真的建出一间房，此后同账号只能读到 12011、永远等不到 12006。
      await sleep(2000);
      const closer = await registerUser(91);
      await setFriendRooms(false, closer.accessToken);
      info('跑得快开关与好友房开关已还原为 false');
    },
  };
}

interface RoomInfoWire {
  code: string;
  gameType?: string;
  maxPlayers?: number;
}

export async function runSlice29(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const setup = await enablePdk();
  try {
    step('① 匹配/开局：gameType/playerCount 贯穿 + 16 张 + 规则快照 + 无内部字段');
    const room = await startPdkRoom('S29');
    try {
      checks.eq(room.matched[0]?.gameType, 'paodekuai', 'room.matched 带 gameType=paodekuai');
      checks.eq(room.matched[0]?.playerCount, 3, 'room.matched 带 playerCount=3');
      for (const [i, view] of room.deals.entries()) {
        checks.eq(view.gameType, 'paodekuai', `deal[${i}] gameType=paodekuai`);
        checks.eq(view.playerCount, 3, `deal[${i}] playerCount=3`);
        checks.eq(view.hand.length, 16, `deal[${i}] 手牌 16 张`);
        checks.eq(view.cardCounts.length, 3, `deal[${i}] cardCounts 长度=3`);
        checks.eq(view.trustees.length, 3, `deal[${i}] trustees 长度=3`);
        checks.that(typeof view.canPass === 'boolean', `deal[${i}] canPass 是布尔（服务端算好）`);
        checks.that(view.pdkRules != null, `deal[${i}] 携带 pdkRules 规则快照`);
        checks.that(!('bottomCards' in (view as unknown as Record<string, unknown>)), `deal[${i}] 无底牌字段`);
        assertNoLeak(view, `deal[${i}]`);
      }
      checks.ok('① 出站视图无 unusedCards/rules/lastPlayedHand 等内部字段（assertNoLeak）');

      step('② 房间列表按 gameType 过滤：pdk 房只在 ?gameType=paodekuai 下可见');
      const pdkList = await getJson<RoomInfoWire[]>(
        '/api/rooms?gameType=paodekuai',
        room.clients[0]!.user.accessToken,
      );
      checks.that(
        Array.isArray(pdkList.body?.data) && pdkList.body!.data!.some((r) => r.code === room.roomCode),
        `GET /api/rooms?gameType=paodekuai 含本房（${room.roomCode}）`,
      );
      const ddzList = await getJson<RoomInfoWire[]>('/api/rooms', room.clients[0]!.user.accessToken);
      checks.that(
        Array.isArray(ddzList.body?.data) && !ddzList.body!.data!.some((r) => r.code === room.roomCode),
        'GET /api/rooms（缺省）不得包含跑得快房（旧客户端语义）',
      );

      step('③ 出牌/过牌到终局：独立 oracle（只打单张）+ winnerSeats');
      const outcome = await playPdkToEnd(room, 'slice-29');
      checks.that(outcome.actions > 0, `至少一次动作（实测 ${outcome.actions}）`);
      checks.that(outcome.passes >= 0, `过牌计数可读（实测 ${outcome.passes}）`);
      checks.eq(
        Object.keys(outcome.finishedPayload ?? {}).sort().join(','),
        'gameType,winnerSeats',
        'game.finished 是 pdk 形状（无旧 winner 键）',
      );
      checks.eq(outcome.finishedPayload?.gameType, 'paodekuai', 'finished.gameType=paodekuai');
      checks.that(
        Array.isArray(outcome.finishedPayload?.winnerSeats) &&
          outcome.finishedPayload.winnerSeats.length === 1,
        'finished.winnerSeats 恰 1 个座位',
      );
      checks.eq(outcome.finalView.state, 'ended', '终局视图 state=ended');
      checks.that(
        Array.isArray(outcome.finalView.winnerSeats) && outcome.finalView.winnerSeats.length === 1,
        '终局视图带 winnerSeats（N17 最后一手视图）',
      );

      step('④ 结算向量：零和 + remaining/倍数/标记');
      const s = outcome.settlement;
      checks.eq(s?.gameType, 'paodekuai', 'settlement.gameType=paodekuai');
      checks.eq(s?.playerCount, 3, 'settlement.playerCount=3');
      checks.that(
        Array.isArray(s?.scoreChanges) && s.scoreChanges.length === 3,
        'settlement.scoreChanges 恰 3 条',
      );
      checks.eq(
        (s?.scoreChanges ?? []).reduce((sum: number, c: { delta: number }) => sum + c.delta, 0),
        0,
        'settlement 零和（赢家所得 = 输家支付之和）',
      );
      checks.that(
        Array.isArray(s?.remaining) && s.remaining.length === 3,
        'settlement.remaining 恰 3 条（按座位）',
      );
      checks.eq(
        (s?.remaining ?? []).filter((n: number) => n === 0).length,
        1,
        '恰一名玩家剩余 0 张（赢家）',
      );
      checks.that(
        typeof s?.multiplier === 'number' && Number.isInteger(s.multiplier) && s.multiplier >= 1,
        `multiplier 是正整数（实测 ${s?.multiplier}）`,
      );
      checks.that(Array.isArray(s?.baobenSeats), 'baobenSeats 是数组');
      checks.that(!('bottomCards' in (s as Record<string, unknown>)), 'settlement 无底牌字段（pdk 没有底牌）');
      checks.ok('④ 结算形状 = SettlementVector（无 landlord/farmer/bottomCards）');

      step('⑤ 记录：单独两表 + 旧查询不含 pdk');
      const user = room.clients[0]!.user as HarnessUser;
      const deadline = Date.now() + 30_000;
      let record: any = null;
      while (Date.now() < deadline && record === null) {
        const page = await getJson<any>('/api/records/mine?gameType=paodekuai', user.accessToken);
        if (page.body?.code !== ErrCode.OK) {
          throw new ConformanceError(`pdk 战绩查询失败：${JSON.stringify(page.body)}`);
        }
        record = (page.body?.data?.items ?? []).find((r: any) => r.roomCode === room.roomCode) ?? null;
        if (record === null) await sleep(500);
      }
      checks.that(record !== null, `GET /api/records/mine?gameType=paodekuai 命中本房（${room.roomCode}）`);
      if (record !== null) {
        checks.eq(record.gameType, 'paodekuai', '记录 gameType=paodekuai');
        checks.eq(record.playerCount, 3, '记录 playerCount=3');
        checks.eq(record.players?.length, 3, '记录 players 恰 3 条');
        checks.that(
          (record.players ?? []).every(
            (p: any) => typeof p.hand === 'string' || (Array.isArray(p.hand) && p.hand.length === 16),
          ),
          '记录每家 16 张初始手牌（hex 或 16 张牌）',
        );
        checks.that(
          (record.players ?? []).every((p: any) => Number.isInteger(p.playedCount)),
          '记录 playedCount 为整数（关牌依据）',
        );
        checks.that(!('bottomCards' in record), '记录无 bottomCards');
        checks.eq(
          (record.scoreChanges ?? []).reduce((sum: number, c: { delta: number }) => sum + c.delta, 0),
          0,
          '记录分差零和',
        );
      }
      const legacy = await getJson<any>('/api/records/mine', user.accessToken);
      checks.that(
        !(legacy.body?.data?.items ?? []).some((r: any) => r.roomCode === room.roomCode),
        '旧查询（无 gameType）只查斗地主表 ⇒ 不含 pdk 记录（D11 零破坏）',
      );
    } finally {
      for (const c of room.clients) c.close();
    }
  } finally {
    await setup.disable();
  }
  return { passed: checks.passed };
}
