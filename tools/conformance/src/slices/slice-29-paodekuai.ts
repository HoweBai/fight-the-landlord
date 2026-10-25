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
import { spawnSync } from 'node:child_process';
import {
  ErrCode,
  RPC_PATTERNS,
  encodeHand,
  type Card,
  type PdkSettlementResult,
  type RecordWriteRequest,
} from '@fight-the-landlord/protocol';
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
import { rpcCall, type RpcEndpoint } from '../lib/rpc';

const PDK_ENABLED_KEY = 'game.paodekuai.enabled';

/* ── 风控真栈（2026-10-25）：复用本片已打完的 random 模式 PDK 对局 ───────────── */
const USER_SERVICE_CONTAINER = 'ftl-user-service';
const PDK_RISK_MIN_GAMES = 'game.paodekuai.risk.minGames';
const PDK_RISK_WIN_RATE = 'game.paodekuai.risk.winRateThreshold';
const RISK_SCAN_INTERVAL = 'risk.scanIntervalMs';
/** `record.write` 的 TCP 监听（宿主直投 = compose override 的 3101；照 slice-20）。 */
const USER_RPC: RpcEndpoint = {
  host: process.env.USER_RPC_HOST ?? 'localhost',
  port: Number(process.env.USER_RPC_PORT ?? 3101),
};

/** 从 codec 合法集取牌（固定遍历序 ⇒ 可复读；只用于造记录，不模拟牌堆）。 */
function sampleCards(offset: number, count: number): Card[] {
  const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];
  const pool: Card[] = [];
  for (const r of ranks) for (let s = 0; s < 5; s += 1) pool.push({ r, s });
  const out: Card[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[(offset + i) % pool.length]!);
  return out;
}

/**
 * 造一条合法的 PDK 胜局记录（`record.write` 直投；校验面同 `record.rpc.controller`）。
 * 真实对局只有 1 局，而风控命中是严格 `games > minGames` ⇒ 用第二条胜局把 winner
 * 抬到 2 局 2 胜（minGames=1 才可命中）。
 */
function craftPdkWinningRecord(
  roomCode: string,
  winnerUserId: string,
  endedAt: number,
): RecordWriteRequest {
  const baseScore = 15;
  const remaining = [0, 4, 7];
  const result: PdkSettlementResult = {
    roomCode,
    gameType: 'paodekuai',
    playerCount: 3,
    baseScore,
    winnerSeats: [0],
    scoreChanges: [
      { seat: 0, delta: 30 },
      { seat: 1, delta: -15 },
      { seat: 2, delta: -15 },
    ],
    remaining,
    multiplier: 1,
    bombCount: 0,
    guan: false,
    spring: false,
    baobenSeats: [],
  };
  return {
    roomCode,
    gameVersion: 1,
    mode: 'random',
    baseScore,
    gameType: 'paodekuai',
    playerCount: 3,
    result,
    seats: [
      {
        seat: 0,
        userId: winnerUserId,
        isRobot: false,
        robotId: null,
        hand: encodeHand(sampleCards(0, 16), 16),
        playedCount: 16,
      },
      {
        seat: 1,
        userId: null,
        isRobot: true,
        robotId: 'bot-s29-pdk-1',
        hand: encodeHand(sampleCards(16, 16), 16),
        playedCount: 12,
      },
      {
        seat: 2,
        userId: null,
        isRobot: true,
        robotId: 'bot-s29-pdk-2',
        hand: encodeHand(sampleCards(32, 16), 16),
        playedCount: 9,
      },
    ],
    startedAt: endedAt - 60_000,
    endedAt,
  };
}

/** 管理面 PUT 并对 code 断言（失败即抛，带键名与响应）。 */
async function putConfigOrThrow(
  admin: string,
  key: string,
  value: unknown,
  label: string,
): Promise<void> {
  const res = await adminPutConfig(key, value, admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`${label}失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** 重起 user-service 并等 healthy（缩间隔后让扫描循环按 5s 重排；首轮仍 30s）。 */
async function restartUserService(): Promise<void> {
  const r = spawnSync('docker', ['restart', USER_SERVICE_CONTAINER], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) {
    throw new ConformanceError(
      `重启 ${USER_SERVICE_CONTAINER} 失败：${(r.stdout ?? '') + (r.stderr ?? '')}`,
    );
  }
  const deadline = Date.now() + 90_000;
  for (;;) {
    const h = spawnSync(
      'docker',
      ['inspect', USER_SERVICE_CONTAINER, '--format', '{{.State.Health.Status}}'],
      { encoding: 'utf8', timeout: 20_000 },
    );
    const status = `${h.stdout ?? ''}${h.stderr ?? ''}`.trim();
    if (status === 'healthy') return;
    if (Date.now() >= deadline) {
      throw new ConformanceError(`${USER_SERVICE_CONTAINER} 90s 内未 healthy：${status}`);
    }
    await sleep(1000);
  }
}

/** 等待开关在 room-service 的配置缓存里生效（观测点 = 建房行为）。 */
async function enablePdk(): Promise<{ disable: () => Promise<void> }> {
  const admin = await adminLogin();
  // ⚠️ REST 建房有**两道闸**，顺序固定：controller 入口先查 `game.doudizhu.friendRoomEnabled`
  //    （关 ⇒ 12006），之后 service 才看玩法开关。只开 paodekuai 不开好友房 ⇒
  //    探针永远读 12006（2026-10-24 CI 实测：slice-14 收尾把好友房还原 false）。
  //    `setFriendRooms` 自带建房轮询（≤30s），且它的探针会占掉 opener 的等待房 ⇒
  //    下面的 paodekuai 探针必须用**另一个**账号（复用会先撞 12011）。
  const opener = await registerUser(88);
  await setFriendRooms(true, opener.accessToken);
  // 平行化：跑得快好友房有自己的玩法级开关（种子 false）；只开斗地主不够。
  const pdkFriendOn = await adminPutConfig('game.paodekuai.friendRoomEnabled', true, admin);
  if (pdkFriendOn.body?.code !== ErrCode.OK) {
    throw new ConformanceError(
      `管理面开启跑得快好友房失败：HTTP ${pdkFriendOn.status} ${JSON.stringify(pdkFriendOn.body)}`,
    );
  }
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
      const pdkFriendOff = await adminPutConfig('game.paodekuai.friendRoomEnabled', false, admin);
      if (pdkFriendOff.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`还原跑得快好友房失败：${JSON.stringify(pdkFriendOff.body)}`);
      }
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
        checks.eq(record.mode, 'random', '记录 mode=random（进入风控扫描的 mode 过滤面）');
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

      step('⑥ 风控真栈：PDK 记录进入胜率扫描（降阈 + 缩间隔 + 重起 user-service）');
      const admin = await adminLogin();
      const winnerSeat = outcome.finishedPayload?.winnerSeats?.[0] as number | undefined;
      const winnerClient =
        typeof winnerSeat === 'number' ? room.bySeat.get(winnerSeat) : undefined;
      const winnerUser = winnerClient?.user;
      checks.that(
        winnerUser !== undefined,
        `⑥ winnerSeats[0]=${String(winnerSeat)} 能映射到玩家（userId=${winnerUser?.id ?? '—'}）`,
      );
      if (winnerUser === undefined) {
        throw new ConformanceError('⑥ 无法从 winnerSeats 映射到玩家，后续风控断言无从谈起');
      }
      // 真实对局只有 1 局；命中是严格 `games > minGames` ⇒ 直投第二条胜局到 2 局 2 胜。
      const craftedRoom = `P2${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const crafted = craftPdkWinningRecord(craftedRoom, winnerUser.id, Date.now());
      const writeRes = await rpcCall<{ written: boolean }>(
        USER_RPC,
        RPC_PATTERNS.recordWrite,
        crafted,
        5_000,
      );
      const written = writeRes.ok ? writeRes.data.written : false;
      checks.eq(written, true, '⑥ 直投第二条 PDK 胜局 written=true（满足严格 games > minGames）');
      if (!writeRes.ok || !writeRes.data.written) {
        throw new ConformanceError(`⑥ 造数失败：${JSON.stringify(writeRes)}`);
      }
      const restoreConfig = async (): Promise<void> => {
        await putConfigOrThrow(admin, PDK_RISK_MIN_GAMES, 100, '⑥ 还原 pdk minGames ');
        await putConfigOrThrow(admin, PDK_RISK_WIN_RATE, 0.8, '⑥ 还原 pdk winRate ');
        await putConfigOrThrow(admin, RISK_SCAN_INTERVAL, 3_600_000, '⑥ 还原扫描间隔 ');
      };
      let primaryError: unknown = null;
      try {
        await putConfigOrThrow(admin, PDK_RISK_MIN_GAMES, 1, '⑥ 降 pdk minGames ');
        await putConfigOrThrow(admin, PDK_RISK_WIN_RATE, 0.5, '⑥ 降 pdk winRate ');
        await putConfigOrThrow(admin, RISK_SCAN_INTERVAL, 5_000, '⑥ 缩扫描间隔 ');
        await restartUserService();

        const riskDeadline = Date.now() + 90_000;
        let detail: any = null;
        let reason: any = null;
        while (Date.now() < riskDeadline) {
          const res = await getJson<any>(
            `/api/admin/risk/users/${encodeURIComponent(winnerUser.id)}`,
            admin,
          );
          const entries = Array.isArray(res.body?.data?.entries) ? res.body.data.entries : [];
          reason =
            (entries[0]?.reasons ?? []).find(
              (r: any) => r?.check === 'winRate' && r?.detail?.gameType === 'paodekuai',
            ) ?? null;
          if (reason !== null) {
            detail = res.body?.data ?? null;
            break;
          }
          await sleep(1000);
        }
        checks.that(
          reason !== null,
          `⑥ ≤90s 内 winner 详情出现 paodekuai winRate reason —— 实际 entries[0]=${JSON.stringify(detail?.entries?.[0] ?? null)}`,
        );
        checks.eq(reason?.detail?.gameType, 'paodekuai', '⑥ reason.detail.gameType=paodekuai');
        checks.eq(reason?.detail?.games, 2, '⑥ reason.detail.games=2（真实 1 + 直投 1）');
        checks.eq(reason?.detail?.wins, 2, '⑥ reason.detail.wins=2');
        checks.eq(reason?.detail?.winRate, 1, '⑥ reason.detail.winRate=1');
        checks.eq(detail?.stats?.byGame?.paodekuai?.games, 2, '⑥ stats.byGame.paodekuai.games=2');
        checks.eq(detail?.stats?.byGame?.paodekuai?.wins, 2, '⑥ stats.byGame.paodekuai.wins=2');
        checks.eq(detail?.stats?.byGame?.doudizhu?.games, 0, '⑥ stats.byGame.doudizhu.games=0');
        checks.eq(detail?.stats?.games, 2, '⑥ stats.games=2（两玩法合计）');
        checks.eq(detail?.entries?.[0]?.score, 25, '⑥ 条目 score=25（胜率一项）');
        const reviewId = detail?.entries?.[0]?.id;
        const dismiss = await postJson(
          '/api/admin/risk/actions',
          {
            userId: winnerUser.id,
            action: 'dismiss',
            reviewId,
            reason: 'slice-29 风控真栈清理',
          },
          admin,
        );
        checks.eq(dismiss.body?.code, ErrCode.OK, '⑥ dismiss 清理条目（HTTP 200/code 0）');
      } catch (err) {
        primaryError = err;
        throw err;
      } finally {
        try {
          await restoreConfig();
        } catch (restoreErr) {
          if (primaryError === null) throw restoreErr;
          info(`⑥ 配置还原失败（保留原始错误）：${String(restoreErr)}`);
        }
      }
    } finally {
      for (const c of room.clients) c.close();
    }
  } finally {
    await setup.disable();
  }
  return { passed: checks.passed };
}
