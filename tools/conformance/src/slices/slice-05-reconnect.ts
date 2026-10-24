/**
 * conformance 用例：切片 5 —— 断线重连（本片：**存活语义**改写）。
 *
 * 判据（`docs/superpowers/specs/2026-10-12-reconnect-until-game-end-spec.md` §3）：
 *   C1  同页断网 >40s（跨过旧窗口）重连 ⇒ `code 0`、快照 version=服务端当前、牌桌恢复；
 *   C2  入局后二次冷启动连接（不发 `game.reconnect`）⇒ 仍被连接补推拉回（记录源）；
 *   C3  从未 `room.join` + 票失效（直删）⇒ 建连被拉回（开局写入的哈希源；断点④）；
 *   C4  waiting 房（好友房）冷启动 ⇒ 补推 `room.matched` 回房；
 *   C5  负对照：显式 `room.leave` ⇒ 不推、不拉回（`game.reconnect` ⇒ `13010`）；
 *   C9  恢复后快照 version=服务端当前；C10 恢复后一次玩家动作触发的推送到达。
 *   C16 （下片 2026-10-12「返回大厅」弃局出口 + 匹配守卫 规格 §2.10）：真栈匹配守卫 ——
 *       在局 `room.match` ⇒ `12011`；显式 `room.leave`（确认弃局）后 ⇒ 匹配恢复可入队（code 0）。
 *
 * 关键设计（为什么这样测才有意义）：
 *  1. 断线前**刻意在线 40 秒**（旧窗口时代的回归段 —— 旧记录 TTL 35s 且只在
 *     `room.join`/断线时续期，此刻早已判过期）；断网段同样 **40 秒**，真跨过旧的
 *     30 秒窗口：旧实现在这里必然 `13010`/丢局，新语义（记录存在即候选 + 存活谓词
 *     决定是否可回）下照样 `code 0`；
 *  2. 断线后取 `game.resync` 的服务端 version 做「一致性」的对照真值；
 *  3. 重连后**再推进一步状态转移**，断言重连的客户端收得到这条推送
 *     —— 只比对快照是测不出「投递链路恢复」的。
 */
import { ErrCode, type PlayerView , type Card } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, info, sleep, step } from '../lib/assert';
import { HarnessClient } from '../lib/client';
import { getJson, postJson, registerUser, setFriendRooms } from '../lib/http';
import { redisCli } from '../lib/redis';

/** 在线段：旧窗口时代的回归段（旧记录 TTL 35s ⇒ 在线 40s 后必然判过期）。 */
const WINDOW_CROSSING_MS = 40_000;
/** 规格 §3 C1：断网 40 秒 —— 真跨过旧的 30 秒重连窗口（10s 只覆盖旧判据「断网 ≥10 秒」）。 */
const OFFLINE_MS = 40_000;
/**
 * C5 负对照的静默观测窗：规格要求「等待片刻并**记录实测**静默时长」，不写死硬判据。
 *
 * 为什么这段窗够用：连接补推发生在连接建立路径上（`replayActiveGame`，服务端在
 * `handleConnection` 内同步完成）——若会推，消息紧随 connect 到达；3s 只是容差，
 * 断言文案里写的是**实测**时长。
 */
const C5_SILENCE_OBSERVATION_MS = 3_000;

interface MoveOutcome {
  moved: boolean;
  version: number;
}

/**
 * 推进一次状态转移（叫抢阶段叫一次 / 出牌阶段出一张单牌）。
 *
 * 不猜规则：行动者取自**快照里的** `bidPhase.currentBidder` / `currentPlayer`
 * （叫抢阶段用 `currentPlayer` 恒为 0，是玩法 §9.1 的经典错误）。
 */
async function advanceState(
  seatToClient: Map<number, HarnessClient>,
  view: PlayerView,
  version: number,
): Promise<MoveOutcome> {
  if (view.state === 'bidding') {
    const actor = seatToClient.get(view.bidPhase.currentBidder);
    if (!actor) return { moved: false, version };
    const ack = await actor.send('game.bid', { grab: false }, version);
    if (ack.code !== ErrCode.OK) return { moved: false, version };
    assertNoLeak(ack.data, 'game.bid ack.data');
    return { moved: true, version: Number(ack.data?.version ?? version) };
  }

  if (view.state === 'playing') {
    const actor = seatToClient.get(view.currentPlayer);
    if (!actor) return { moved: false, version };
    // 手牌与 version 都以服务端刚回的裁剪快照为准
    const fresh = await actor.send('game.resync', {}, 0);
    assertNoLeak(fresh.data, 'game.resync ack.data');
    // ⚠️ 这是 `Card[]`（R696），不是点数数组 —— 旧标注 `number[]` 是**假的**，
    // 只因 ack 载荷是 `any` 而 `tsc` 看不见。
    const hand: Card[] = fresh.data?.hand ?? [];
    if (fresh.code !== ErrCode.OK || hand.length === 0) return { moved: false, version };
    const ack = await actor.send('game.play', { cards: [hand[0]!] }, Number(fresh.data.version));
    if (ack.code !== ErrCode.OK) return { moved: false, version };
    assertNoLeak(ack.data, 'game.play ack.data');
    return { moved: true, version: Number(ack.data?.version ?? version) };
  }

  return { moved: false, version };
}

/** §7.1 的 `RoomInfo` 只取本文件用到的三字段（全字段集的判据在 slice-12）。 */
interface RoomInfo {
  code: string;
  status: string;
  playerCount: number;
}

/**
 * 建房（§7.1 `POST /api/rooms`）—— **不入座**是这条路径的既定契约。
 *
 * ⚠️ 片⑦ 起 REST 建房在 `room.friendRoomEnabled` 缓存值闸后（关 ⇒ 12006）⇒
 * C3-C5 前置里先 `setFriendRooms(true)`（沿 slice-12 的 T14 手法；只开不还原，
 * 开关的复原是 slice-14 收尾的职责）。
 */
async function createRoom(token: string): Promise<{ status: number; room: RoomInfo | null }> {
  const created = await postJson<RoomInfo>('/api/rooms', { mode: 'practice' }, token);
  return {
    status: created.status,
    room: (created.body?.code === ErrCode.OK ? created.body.data : null) ?? null,
  };
}

/** 占座（§7.1 `POST /api/rooms/:code/join`）—— 真服务端里**唯一**的入座方式。 */
async function claimSeat(token: string, roomCode: string) {
  return postJson<RoomInfo>(`/api/rooms/${roomCode}/join`, {}, token);
}

/** 从房列表读回该房状态（`GET /api/rooms`；与 slice-12 的 `roomFromList` 同形）。 */
async function roomStatus(token: string, roomCode: string): Promise<string | undefined> {
  const list = await getJson<RoomInfo[]>('/api/rooms', token);
  return (list.body?.data ?? []).find((r) => r.code === roomCode)?.status;
}

export async function runSlice05(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  /** C2-C5 的连接（创建即登记 ⇒ 中途抛错时 `finally` 也关得掉；泄漏扫描一并覆盖）。 */
  const extras: HarnessClient[] = [];
  let revived: HarnessClient | undefined;
  let stranger: HarnessClient | undefined;

  try {
    step('准备 4 个真实账号并建立 WS 连接（经 api-gateway 代理）');
    const users = await Promise.all([0, 1, 2, 3].map((i) => registerUser(i)));

    for (let i = 0; i < 3; i += 1) {
      clients.push(await HarnessClient.connect(`P${i}`, users[i]!));
    }
    checks.ok('3 个客户端完成握手');

    // ── 1) 匹配 → 发牌 ────────────────────────────────────────────
    step('room.match ×3 → room.matched → game.deal');
    for (const client of clients) {
      // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
      const ack = await client.send('room.match', { mode: 'random', baseScore: 15 });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.match code`);
    }

    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', 25_000)));
    const roomCode: string = matched[0].payload.roomCode;
    checks.eq(matched[1].payload.roomCode, roomCode, 'P1 的 roomCode 与 P0 一致');
    checks.eq(matched[2].payload.roomCode, roomCode, 'P2 的 roomCode 与 P0 一致');

    const seatToClient = new Map<number, HarnessClient>();
    clients.forEach((client, i) => seatToClient.set(matched[i]!.payload.seat as number, client));
    checks.eq(seatToClient.size, 3, '三个座位号互不相同');

    const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
    deals.forEach((deal, i) => assertNoLeak(deal, `game.deal(P${i})`));
    checks.ok('game.deal 无 actionLog/isRobot/botId/skillLevel/players 泄漏（`deck` 已随 N27 从契约删除）');

    let version = Math.max(...deals.map((d) => Number(d.version)));
    checks.atLeast(version, 0, 'game.deal version');

    // ── 2) room.join：§6.6.1 的刷新时机之一（建立重连记录） ─────────
    step('room.join ×3（写入 reconnect:active）');
    for (const client of clients) {
      const ack = await client.send('room.join', { roomCode });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.join code`);
    }

    // ── 3) 至少推进一次 version，让 lastVersion 有真实含义 ──────────
    step('推进一次状态转移');
    const anyView = deals[0].payload as PlayerView;
    const first = await advanceState(seatToClient, anyView, version);
    if (first.moved) {
      version = first.version;
      checks.ok(`状态已推进，version = ${version}`);
    } else {
      info('首次推进未成功（可能已进入出牌且无合法单牌），继续');
    }

    // ── 4) 在线段：旧窗口时代的回归段（「局打久了不丢」） ──────────
    step('在线 40 秒（旧窗口时代的回归段，仍覆盖『局打久了不丢』）');
    await sleep(WINDOW_CROSSING_MS);

    // ── 5) 断线前取服务端权威 version（后面做一致性对照） ──────────
    const before = await clients[0]!.send('game.resync', {}, 0);
    checks.eq(before.code, ErrCode.OK, '断线前 game.resync code');
    assertNoLeak(before.data, '断线前 game.resync ack.data');
    const lastVersion = Number(before.data?.version);
    checks.atLeast(lastVersion, version, 'game.resync 的 version（≥ 已见 version）');

    // ── 6) 断线 40 秒（跨过旧 30 秒窗口） ─────────────────────────
    step(`P0 断线，等待 ${OFFLINE_MS / 1000} 秒`);
    clients[0]!.disconnect();
    await sleep(OFFLINE_MS);

    // ── 7) 重连：携 lastVersion ───────────────────────────────────
    step('P0 用新连接重连 → game.reconnect { lastVersion }');
    revived = await HarnessClient.connect('P0-revived', users[0]!);
    const ack = await revived.send('game.reconnect', { lastVersion });
    checks.eq(ack.code, ErrCode.OK, 'game.reconnect ack code（记录在且对局存活即成功，不是 13010）');
    // ack 是 §6.4 规则 5 的泄漏面之一，但 ack 没有 `type`、套不进 `ServerMessage`，
    // 因此 `validateOutbound()` 覆盖不到它 —— 这里由 conformance 机械补上。
    assertNoLeak(ack.data, 'game.reconnect ack.data');

    const snapshot = ack.data as PlayerView | undefined;
    checks.that(snapshot && typeof snapshot.version === 'number', 'ack.data 是 PlayerView');
    const snap = snapshot as PlayerView;
    checks.eq(snap.roomCode, roomCode, '重连快照 roomCode');
    checks.eq(snap.seat, before.data?.seat, '重连快照 seat');
    checks.atLeast(snap.version, lastVersion, '重连快照 version（≥ 断线前）');

    // 「客户端状态与服务端一致」的机械判据：
    // 同一时刻另一路 game.resync 拿到的版本必须与重连快照一致。
    const serverNow = await clients[1]!.send('game.resync', {}, 0);
    checks.eq(serverNow.code, ErrCode.OK, '对照 game.resync code');
    assertNoLeak(serverNow.data, '对照 game.resync ack.data');
    checks.eq(snap.version, Number(serverNow.data?.version), '重连快照 version 与服务端当前一致');
    checks.eq(snap.currentPlayer, serverNow.data?.currentPlayer, '重连快照 currentPlayer 与服务端一致');
    checks.eq(
      JSON.stringify(snap.cardCounts),
      JSON.stringify(serverNow.data?.cardCounts),
      '重连快照 cardCounts 与服务端一致',
    );

    // ── 8) 投递链路恢复：重连后必须收得到推送（B-d 的核心） ────────
    step('重连后再推进一次，断言新连接收得到 game.state_update');
    seatToClient.set(snap.seat, revived);
    const after = await advanceState(seatToClient, snap, snap.version);
    checks.that(after.moved, '重连后状态仍可推进（用 fresh 快照定位行动者）');

    const push = await revived.waitFor(
      'game.state_update',
      15_000,
      (m) => Number(m.version) > snap.version,
    );
    checks.atLeast(Number(push.version), snap.version + 1, '重连后收到的 game.state_update version');
    assertNoLeak(push, 'game.state_update(重连后)');
    checks.ok('重连后推送无泄漏');

    // ── C16（本片规格 §2.10）：真栈匹配守卫 —— 在局 ⇒ 12011；leave 后 ⇒ 0 ──
    //
    // 四断言（前提自证 1 + 断言 3；baselines 按 +4 回填 64→68）：
    //   ① 前提自证：`HGET room:{code} status` = playing（不满足 ⇒ 显式失败，绝不静默降级）；
    //   ② P1 `room.match` ⇒ 12011；③ P1 `room.leave` ⇒ 0；④ P1 再 `room.match` ⇒ 0。
    // 行动者用 **P1**、**不得用 P0**：P0 的凭据面是紧接着 C2「二次冷启动补推」的被测对象
    // （C2 起手要 `EXISTS match:pending` 自证），对他做 leave 会把 C2 的前提改掉。
    // 窗口口径（规格 §2.10-4）：断言后即 `room.unmatch` 清理、**不做匹配等待** ——
    // unmatch 的 ack 只记录不判（本块恰 4 条 checks，基线口径）。
    step('C16：P1 在局 room.match ⇒ 12011 ⇒ room.leave ⇒ 0 ⇒ 再 match ⇒ 0（随即 unmatch 收尾）');
    checks.eq(
      redisCli(['HGET', `room:${roomCode}`, 'status']).trim(),
      'playing',
      'C16 前提自证：HGET room:{code} status = playing（不满足 ⇒ 环境前提被破坏，显式失败）',
    );
    const c16Blocked = await clients[1]!.send('room.match', { mode: 'random', baseScore: 15 });
    checks.eq(c16Blocked.code, ErrCode.ALREADY_IN_GAME, 'C16-1 在局 room.match ⇒ 12011（守卫拦截）');
    const c16Leave = await clients[1]!.send('room.leave', { roomCode });
    checks.eq(c16Leave.code, ErrCode.OK, 'C16-2 确认弃局 room.leave ⇒ 0（在局 leave 成功，不抛）');
    const c16Recovered = await clients[1]!.send('room.match', { mode: 'random', baseScore: 15 });
    checks.eq(
      c16Recovered.code,
      ErrCode.OK,
      'C16-3 leave 后 room.match ⇒ 0（凭据已清 ⇒ 守卫不再拦，入队成功）',
    );
    const c16Cleanup = await clients[1]!.send('room.unmatch', {});
    info(`C16 收尾 room.unmatch ack.code = ${c16Cleanup.code}（记录用；窗口口径=断言后即清理，不做匹配等待）`);

    // ── C2（规格 §3）：二次冷启动 —— 不发明文 game.reconnect，靠连接补推拉回 ──
    //
    // 「二次」= 步骤 7 已放过一轮显式 game.reconnect；本步模拟「刷新/杀进程」的
    // 冷启动形态：新连接什么都不发，只等连接补推。
    // 凭据来源 = **记录**（票在首轮 `room.join` 成功时被兜底清掉 —— N34/R524）；
    // 下面的 EXISTS 前提自证把「票已清」钉出来，否则本条可能被 pending 代答。
    step('C2：P0 再次断开当前 socket ⇒ 另开新连接（不发 game.reconnect）⇒ 等连接补推');
    checks.eq(
      redisCli(['EXISTS', `match:pending:${users[0]!.id}`]).trim(),
      '0',
      'C2 前提：票已在首轮 room.join 时清掉（活候选只剩记录）',
    );
    revived.disconnect();
    const cold2 = await HarnessClient.connect('P0-cold2', users[0]!);
    extras.push(cold2);
    const cold2Matched = await cold2.waitFor('room.matched', 15_000);
    checks.eq(cold2Matched.payload.roomCode, roomCode, 'C2 冷启动补推的 room.matched 房号');
    const cold2Deal = await cold2.waitFor('game.deal', 15_000);
    checks.eq(cold2Deal.payload.roomCode, roomCode, 'C2 冷启动补推的 game.deal 房号');
    info('断言只认补推消息（连接上未发任何显式请求）—— 同一连接另收到别的消息不冲突（幂等）。');
    // ⚠️ 单 IP 并发 WS 名额（§5.4/R246：网关限 **5** 条，用满即 10006）——本片后面还要连
    // C3/C4/C5 的账号 ⇒ 每个场景断言完**立即**关（slice-12 的 `lateClient.close()` 同款纪律），
    // 峰值保持在限内。主线的 P1/P2 保持在线（它们是后续对照的活体）。
    cold2.close();

    // ── C3-C5 前置：好友房开关必须**开**（REST 建房经 `room.friendRoomEnabled` 闸）──
    // 沿 slice-12 的 T14 手法：admin PUT + 建房行为轮询至生效。
    // ⚠️ 只开**不还原**（与 slice-06/07.1/07.2-hardening/12 同纪律：开关的复原是
    // slice-14 收尾的职责）。
    step('C3-C5 前置：置好友房开关开（沿 slice-12 手法；只开不还原，收尾归 slice-14）');
    await setFriendRooms(true, users[0]!.accessToken);
    checks.ok('room.friendRoomEnabled = true（建房探针已生效）');

    // ── C3（规格 §3）：从未 room.join + 票失效（直删）⇒ 建连被拉回（哈希源） ──
    //
    // 这是断点④（「匹配/占座后从未 room.join 的玩家，票过期后无任何凭据」）的
    // conformance 版：构造照 slice-12 的「全员 REST 占座」竞态房 —— 三人都只占座、
    // 谁都不连 WS，扫描器自动开局（startRoom 写票 + **写哈希**）；随后把主角的票
    // **直删** —— 活候选只剩哈希 ⇒ 此刻建连还能被拉回，只能是「凭开局写入的哈希」。
    step('C3：三人只 REST 占座建新房（照 slice-12 竞态构造）⇒ 等自动开局 ⇒ 直删主角的 match:pending');
    const c3Users = [await registerUser(4), await registerUser(5), await registerUser(6)];
    const c3Created = await createRoom(c3Users[0]!.accessToken);
    checks.eq(c3Created.status, 201, 'C3 建房 HTTP 状态');
    const c3Room = c3Created.room?.code ?? '';
    checks.that(/^[0-9A-Z]{6}$/.test(c3Room), `C3 房号形状合法（${c3Room}）`);
    for (let i = 0; i < 3; i += 1) {
      const claim = await claimSeat(c3Users[i]!.accessToken, c3Room);
      checks.eq(claim.body?.data?.playerCount, i + 1, `C3 第 ${i + 1} 人 REST 占座后 playerCount`);
    }
    step('C3：轮询 GET /api/rooms 到该房 playing（上限 30s）—— REST 占座不触发同步开局，靠扫描器');
    let c3Playing = false;
    const c3Deadline = Date.now() + 30_000;
    while (Date.now() < c3Deadline) {
      if ((await roomStatus(c3Users[0]!.accessToken, c3Room)) === 'playing') {
        c3Playing = true;
        break;
      }
      await sleep(500);
    }
    checks.that(c3Playing, 'C3 满员房在 30s 内被自动开局（扫描器「满座 ⇒ 立刻开」）');
    const c3Protagonist = c3Users[2]!;
    checks.that(
      redisCli(['HGET', 'reconnect:active', c3Protagonist.id]).includes(c3Room),
      `C3 开局已为人类座位写入哈希（断点④写点实况；指向 ${c3Room}）`,
    );
    redisCli(['DEL', `match:pending:${c3Protagonist.id}`]);
    checks.eq(
      redisCli(['EXISTS', `match:pending:${c3Protagonist.id}`]).trim(),
      '0',
      'C3 主角的票已被直删（EXISTS=0 ⇒ 活候选只剩哈希）',
    );
    const c3Client = await HarnessClient.connect('C3从未入房', c3Protagonist);
    extras.push(c3Client);
    const c3Matched = await c3Client.waitFor('room.matched', 20_000);
    checks.eq(c3Matched.payload.roomCode, c3Room, 'C3 补推 room.matched 的房号（票已删 ⇒ 只能来自哈希）');
    checks.eq(c3Matched.payload.seat, 2, 'C3 补推的座位（第三个 REST 占座者 ⇒ 2 号位）');
    const c3Deal = await c3Client.waitFor('game.deal', 20_000);
    checks.eq(c3Deal.payload.roomCode, c3Room, 'C3 补推 game.deal 的房号');
    checks.eq(c3Deal.payload.hand?.length, 17, 'C3 补推的手牌张数（同一裁剪视图）');
    // 「version 对」：补推的 deal 用**连接时抓取**的视图版本 ⇒ 与紧随其后的
    // `game.resync`（重新拉取当前快照）必须一致。⚠️ 三人都不发动作；回合超时 30s
    // 起算 ⇒ 两步之间版本不会推进（与 slice-12 竞态块同一口径）。
    const c3Resync = await c3Client.send('game.resync', {});
    checks.eq(c3Resync.code, ErrCode.OK, 'C3 game.resync code（同一 resolver 面）');
    checks.eq(c3Resync.data?.version, c3Deal.version, 'C3 补推 deal 的 version 与房内当前一致');
    c3Client.close(); // R246：断言已取完 ⇒ 立即释放名额（见 C2 尾注）

    // ── C4（规格 §3）：waiting 房冷启动 ⇒ 补推回房（新增能力：等人时刷新也回得去） ──
    step('C4：好友房 waiting 态 —— REST 建房 + 占座 ⇒ WS room.join ⇒ 断开 ⇒ 新连接 ⇒ 等补推');
    const c4User = await registerUser(7);
    const c4Created = await createRoom(c4User.accessToken);
    checks.eq(c4Created.status, 201, 'C4 建房 HTTP 状态');
    const c4Room = c4Created.room?.code ?? '';
    checks.that(/^[0-9A-Z]{6}$/.test(c4Room), `C4 房号形状合法（${c4Room}）`);
    const c4Claim = await claimSeat(c4User.accessToken, c4Room);
    checks.eq(c4Claim.body?.data?.playerCount, 1, 'C4 占座后 playerCount');
    const c4Client = await HarnessClient.connect('C4等待房', c4User);
    extras.push(c4Client);
    const c4Join = await c4Client.send('room.join', { roomCode: c4Room });
    checks.eq(c4Join.code, ErrCode.OK, 'C4 waiting 房 room.join code');
    checks.eq(c4Join.data?.seat, 0, 'C4 房主座位');
    checks.eq(
      await roomStatus(c4User.accessToken, c4Room),
      'waiting',
      'C4 断开前房态（单人房等补位死线 20-30s ⇒ 此刻必为 waiting；否则是环境太慢，判据前提被破坏）',
    );
    c4Client.disconnect();
    const c4Cold = await HarnessClient.connect('C4等待房-冷启', c4User);
    extras.push(c4Cold);
    const c4Matched = await c4Cold.waitFor('room.matched', 15_000);
    checks.eq(c4Matched.payload.roomCode, c4Room, 'C4 补推 room.matched 的房号 = 该等待中的房');
    checks.eq(c4Matched.payload.seat, 0, 'C4 补推的座位');
    c4Cold.close(); // R246：断言已取完 ⇒ 立即释放名额（见 C2 尾注）

    // ── C5（规格 §3）负对照：显式 room.leave ⇒ 断开后不推、显式 game.reconnect ⇒ 13010 ──
    step('C5 负对照：新房 —— WS room.join ⇒ room.leave ⇒ 断开 ⇒ 新连接（观察静默）⇒ 显式 game.reconnect');
    const c5User = await registerUser(8);
    const c5Created = await createRoom(c5User.accessToken);
    checks.eq(c5Created.status, 201, 'C5 建房 HTTP 状态');
    const c5Room = c5Created.room?.code ?? '';
    checks.that(/^[0-9A-Z]{6}$/.test(c5Room), `C5 房号形状合法（${c5Room}）`);
    const c5Claim = await claimSeat(c5User.accessToken, c5Room);
    checks.eq(c5Claim.body?.data?.playerCount, 1, 'C5 占座后 playerCount');
    const c5Client = await HarnessClient.connect('C5离开前', c5User);
    extras.push(c5Client);
    const c5Join = await c5Client.send('room.join', { roomCode: c5Room });
    checks.eq(c5Join.code, ErrCode.OK, 'C5 room.join code');
    checks.eq(
      redisCli(['HEXISTS', 'reconnect:active', c5User.id]).trim(),
      '1',
      'C5 前提：join 成功已建立记录（HEXISTS=1）',
    );
    const c5Leave = await c5Client.send('room.leave', { roomCode: c5Room });
    checks.eq(c5Leave.code, ErrCode.OK, 'C5 room.leave code');
    checks.eq(
      redisCli(['HEXISTS', 'reconnect:active', c5User.id]).trim(),
      '0',
      'C5 显式离开已删记录（唯一删除点 ⇒ 断开后无凭据可推）',
    );
    c5Client.disconnect();
    const c5Cold = await HarnessClient.connect('C5离开后-冷启', c5User);
    extras.push(c5Cold);
    const silenceSince = Date.now();
    await sleep(C5_SILENCE_OBSERVATION_MS);
    const silenceMeasuredMs = Date.now() - silenceSince;
    checks.that(
      c5Cold.last('room.matched') === undefined,
      `C5 负对照：离开后新连接静默（实测观测窗 ${silenceMeasuredMs}ms）内未收到 room.matched —— 不拉回`,
    );
    const c5Reconnect = await c5Cold.send('game.reconnect', { lastVersion: 0 });
    checks.eq(
      c5Reconnect.code,
      ErrCode.RECONNECT_RECORD_MISSING,
      'C5 显式 game.reconnect ⇒ 13010（无任何可恢复凭据，且不是 12001）',
    );
    c5Cold.close(); // R246：断言已取完 ⇒ 立即释放名额（见 C2 尾注）

    // ── 9) 反例：从未入房者必须得到 13010，而不是 12001 ────────────
    step('反例：从未入房的新账号 game.reconnect');
    stranger = await HarnessClient.connect('stranger', users[3]!);
    const negative = await stranger.send('game.reconnect', { lastVersion: 0 });
    checks.eq(
      negative.code,
      ErrCode.RECONNECT_RECORD_MISSING,
      '无重连记录 → 13010（§6.6 明令不得复用 12001）',
    );

    // ── 10) 全量泄漏扫描 ──────────────────────────────────────────
    step('扫描全部入站消息的 §6.4 泄漏');
    const observers = [...clients, revived, stranger, ...extras];
    let total = 0;
    for (const client of observers) {
      for (const received of client.received) {
        // §6.4 规则 3：`room.state_update` 的 `players`（RoomPlayer[]）是**合法**字段
        // （昵称片起入座/离座会补发本消息）⇒ 不能走整串扫 `players` 的 assertNoLeak；
        // 按 assert.ts 的纪律手写字段集断言（id/seat 必在，另允许 cardCount?/nickname?）。
        if (received.type === 'room.state_update') {
          const players = (received.message?.payload?.players ?? []) as Array<Record<string, unknown>>;
          if (!Array.isArray(players)) {
            throw new Error(`${client.label} room.state_update players 形态非法`);
          }
          for (const p of players) {
            const fields = Object.keys(p);
            const allowed = new Set(['id', 'seat', 'cardCount', 'nickname']);
            const illegal = fields.filter((f) => !allowed.has(f)).sort();
            if (!fields.includes('id') || !fields.includes('seat') || illegal.length > 0) {
              throw new Error(
                `${client.label} room.state_update players 元素字段非法：${fields.sort().join(',')}`,
              );
            }
          }
          total += 1;
          continue;
        }
        total += 1;
        assertNoLeak(received.message, `${client.label} ${received.type}`);
      }
    }
    checks.ok(`全部 ${total} 条入站消息无 §6.4 规则 4 泄漏`);
  } finally {
    for (const client of [...clients, revived, stranger, ...extras]) client?.close();
  }

  return checks;
}
