/**
 * conformance 用例：手动进房（片③ §9 F6 的修复链路 / 本片 spec §5.2）。
 *
 * 判据：**建房 → REST 占座 → WS 挂载 → 第三人补齐 → 自动开局 → 三家拿到牌**，
 * 每一步都用真后端的回答作数。
 *
 * 为什么必须单列一个用例（而不是塞进 slice-06 / slice-07）：
 *  - slice-06（13 组）验认证与房间列表、slice-07（6 组）验**匹配**路径；
 *  - 本用例验的是**手动路径的完整链路**，它跨 room-service 的两条入口
 *    （REST 占座 + WS 挂载），既不属于认证也不属于匹配；
 *  - ⚠️ slice-07 第 6 组那条「非成员 `room.join` ⇒ 12004」的**反例必须继续存在**
 *    —— 它钉住的是「挂载 ≠ 占座」这条语义，与本用例是**互补**的：
 *    本用例证明「占座 → 挂载」这条链成立，它证明「不占座就挂不上」。
 *
 * ⚠️ **本用例不跑客户端代码**：它手工走「REST 然后 WS」两步，验的是**服务端契约允许这条链**。
 * 「客户端有没有按这个顺序调」由 `apps/client/test/lobby-ux.test.ts` 的**忠实替身**一组验
 * （那里 WS 的放行取决于 REST 是否真的发生过）。两层各管一半，缺一半就发现不了 F6。
 *
 * ⚠️ **第 8/9 步是本片（自动开局）改判的**：片④ 时它们判的是「坐满仍在 `waiting`」
 *（当时手动房**没有开局链路** ⇒ 判 `PlayerView` 是判一个不存在的契约，spec §1.2 H3′）。
 * 片④ 把那条写成**交接判据**并注明「接上开局链路时它该红」—— 本片接上了，
 * 它**确实红了**（实测：第 4 人占座从 `12002` 变成 **`12008`**，因为房间已经在 `playing`），
 * 于是这里改判成**开局链路本身**：`room.matched` → `room.join` → `game.deal`。
 *
 * ⚠️ **本用例为什么不是「必然绿的顺风判据」**：happy path（占座→挂载）两边都绿，
 * 它的**判别力在上游的负对照**上 —— 三个「不满足条件就必须被拒」：
 *   ① 未占座 `room.join` ⇒ **12004**（第 3 步，占座是挂载的前提）
 *   ② 第 4 人占座 ⇒ **12008**（第 9 步：开局之后占座入口自己关上了）
 *   ③ 未开局时占座仍受 `12002` 保护（**片④ 已验证过**，本片不再重复）
 * 「顺手放宽 `handleJoin`」或「建房即入座」这类改法会让 ① 先红 —— 这正是本片
 * 否决另外两个修法（spec §2 的方案 1 / 方案 3）时用的同一套判据。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Checks, info, step, sleep } from '../lib/assert';
import { GATEWAY_URL, getJson, postJson, registerUser, setFriendRooms, type HarnessUser } from '../lib/http';
import { HarnessClient } from '../lib/client';
import { redisCli, redisLines } from '../lib/redis';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度 ⇒ 与 `lib/redis.ts` 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * 某个服务最近的容器日志（片⑥ · spec §6.1 的判据③：「服务端日志里没有 Lua 报错」）。
 *
 * ⚠️ `--no-color` 必须有：带 ANSI 的日志会让「找那一行」变成一条**恒假**的判据
 *（`ci.sh` 的 `run_gate` 正是为同一类问题剥颜色的，见那里的注释）。
 */
function composeLogs(service: string, sinceSeconds: number): string {
  const res = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 20_000 },
  );
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

/**
 * 从 `docker compose logs` 的一行里抽出我们的 **NDJSON 记录**。
 *
 * ⚠️ 两个都要处理：`ftl-x  | ` 前缀，以及**非 JSON 行**（`room-service`/`user-service`
 * 的 `main.ts` 仍有启动横幅走裸 `console.log` —— `no-raw-console` 白名单允许它）。
 * 找不到 `{` 或解析失败一律返回 `null`（调用方负责过滤）。
 */
function safeJson(line: string): Record<string, any> | null {
  const at = line.indexOf('{');
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** §3.1：`RoomInfo` 的字段集恰好七个（多一个就是泄漏；S2 起含 `gameType`）。 */
const ROOM_INFO_KEYS = ['baseScore', 'code', 'gameType', 'maxPlayers', 'mode', 'playerCount', 'status'];

interface RoomInfo {
  code: string;
  mode: string;
  status: string;
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
  /** 多玩法（Task 2.2）：缺省语义 doudizhu；旧客户端忽略。 */
  gameType?: string;
}

/** 建房（§7.1 的 `POST /api/rooms`）—— **不入座**是这条路径的既定契约（`players: []`）。 */
async function createRoom(token: string): Promise<{ status: number; room: RoomInfo | null }> {
  const created = await postJson<RoomInfo>('/api/rooms', { mode: 'practice' }, token);
  return {
    status: created.status,
    room: (created.body?.code === ErrCode.OK ? created.body.data : null) ?? null,
  };
}

/** 占座（§7.1 的 `POST /api/rooms/:code/join`）—— 真服务端里**唯一**的入座方式。 */
async function claimSeat(token: string, roomCode: string) {
  return postJson<RoomInfo>(`/api/rooms/${roomCode}/join`, {}, token);
}

/** 从列表里读回该房间的对外形态（`playerCount` 是「座位上的人」的权威口径）。 */
async function roomFromList(token: string, roomCode: string): Promise<RoomInfo | undefined> {
  const list = await getJson<RoomInfo[]>('/api/rooms', token);
  return (list.body?.data ?? []).find((r) => r.code === roomCode);
}

/** 一个已连上真实网关 + 真实 WS 的账号。 */
async function seatPlayer(
  label: string,
  user: HarnessUser,
  roomCode: string,
): Promise<{ client: HarnessClient; ack: Awaited<ReturnType<HarnessClient['send']>> }> {
  const client = await HarnessClient.connect(label, user);
  const ack = await client.send('room.join', { roomCode });
  return { client, ack };
}

export async function runSlice12(): Promise<Checks> {
  const checks = new Checks();

  // ── 1) 三个账号 ────────────────────────────────────────────────
  step('注册三个账号（每个都要真令牌：REST 与 WS 各一条链路都要鉴权）');
  const users = [await registerUser(0), await registerUser(1), await registerUser(2)];
  users.forEach((u, i) => checks.that(u.id.length > 0, `账号 ${i} 有 id`));

  // ── 片⑦ 前置（T14）：好友房开关必须**开** ────────────────────────
  // 本片的手动路径全程在闸后：建房（`POST /api/rooms`）与占座（`POST /api/rooms/:code/join`）
  // 片⑦ 起都按 `room.friendRoomEnabled` 缓存值拦（关 ⇒ 12006）。
  // ⚠️ 只开**不还原**（规格 §3 编排：开关的复原是 slice-14 收尾的职责）。
  await setFriendRooms(true, users[0]!.accessToken);

  // ── 2) 建房：不入座 ─────────────────────────────────────────────
  step('房主建房：POST /api/rooms ⇒ playerCount 0（建房**不入座**是既定契约，不是缺陷）');
  const created = await createRoom(users[0]!.accessToken);
  checks.eq(created.status, 201, '建房 HTTP 状态');
  const roomCode = created.room?.code ?? '';
  checks.that(/^[0-9A-Z]{6}$/.test(roomCode), `房号形状合法（${roomCode}）`);
  checks.eq(created.room?.playerCount, 0, '刚建好的房间 playerCount（`create()` 落 `players: []`）');

  // ── 2b) 竞态回放（片⑦ 修复 · slice12-race-fix-design §2a）：确定性判据 ──────
  //
  // 为什么必须补这条**确定**步骤（判据只增不减）：主流程的步骤 5–8c 里第三人先挂 WS、
  // 自动开局后开火 ⇒ 恰好**躲开**了竞态窗口，缺陷实现（好友房不写 `match:pending`、
  // 网关无补推）下原判据照样绿。这里把竞态**确定地**构造出来：三人**全部只走 REST 占座**
  // （谁都不连 WS），等房间被扫描器自动开起来（`status=playing`）**之后**，迟到者才连 WS。
  // 修复前：迟到者收不到 `room.matched`（无凭据可补回），也收不到 `game.deal`
  //（`game.started` 由 game-service 在 RPC 返回前发布、`seatOwners` 无登记）⇒ 两条
  // waitFor 必红；修复后：① `startRoom` 写凭据 + ② 连接补推 ⇒ 两条都在 ≤20s 内到。
  step('竞态回放（片⑦ 修复）：三人**只 REST 占座**（谁都不连 WS）⇒ 等自动开局 ⇒ 迟到者此刻才连 WS');
  const raceUsers = [await registerUser(8), await registerUser(9), await registerUser(10)];
  const raceCreated = await createRoom(raceUsers[0]!.accessToken);
  const raceRoom = raceCreated.room?.code ?? '';
  checks.that(/^[0-9A-Z]{6}$/.test(raceRoom), `竞态房号形状合法（${raceRoom}）`);
  const raceFirst = await claimSeat(raceUsers[0]!.accessToken, raceRoom);
  checks.eq(raceFirst.body?.data?.playerCount, 1, '第一人 REST 占座后 playerCount');
  const raceSecond = await claimSeat(raceUsers[1]!.accessToken, raceRoom);
  checks.eq(raceSecond.body?.data?.playerCount, 2, '第二人 REST 占座后 playerCount');
  const raceThird = await claimSeat(raceUsers[2]!.accessToken, raceRoom);
  checks.eq(raceThird.body?.data?.playerCount, 3, '第三人 REST 占座后 playerCount（满员 —— 谁都还没连 WS）');

  step('轮询 GET /api/rooms 到该房 playing（上限 30s）—— 此刻 room.matched 与 game.deal 都已错过');
  let racePlaying = false;
  const raceDeadline = Date.now() + 30_000;
  while (Date.now() < raceDeadline) {
    const listed = await roomFromList(raceUsers[0]!.accessToken, raceRoom);
    if (listed?.status === 'playing') {
      racePlaying = true;
      break;
    }
    await sleep(500);
  }
  checks.that(
    racePlaying,
    '满员房在 30s 内被自动开局（扫描器「满座 ⇒ 立刻开」；REST 占座**不**触发同步开局）',
  );

  // ── 2c) C6 陈旧哈希负对照（本片 · 规格 §3）：迟到者建立 WS **之前**注入 ──────
  //
  // 仲裁规则（本片设计：resolver 双候选择优 = **pending 优先**）：startRoom 已为迟到者
  // 写下指向竞态房的 **pending**；这里再注入一条**陈旧**的记录（指向不存在的
  // DEADROOM，形状与开局写点一致但 socketId 空、connectedAt=0）。
  // 哈希优先的仲裁（哈希命中即不回落 pending）会被 DEADROOM 遮蔽 ⇒ 静默丢局；
  // 新仲裁下 pending 胜 ⇒ 仍拉回竞态房 —— 下面两条既有断言（matched/deal 的
  // roomCode = 竞态房）就是「未被 DEADROOM 遮蔽」的机械判据。
  step('C6：迟到者建 WS 前注入陈旧哈希（DEADROOM）—— 负对照：不得遮蔽凭 pending 的补回');
  const staleRecord = '{"socketId":"","roomCode":"DEADROOM","connectedAt":0}';
  redisCli(['HSET', 'reconnect:active', raceUsers[2]!.id, staleRecord]);
  checks.eq(
    redisCli(['HGET', 'reconnect:active', raceUsers[2]!.id]).trim(),
    staleRecord,
    'C6 注入落地：陈旧哈希（DEADROOM）已在 reconnect:active（负对照的前提自证）',
  );
  checks.eq(
    redisCli(['HGET', `match:pending:${raceUsers[2]!.id}`, 'roomCode']).trim(),
    raceRoom,
    'C6 对照前提：活票（pending）指向竞态房（仲裁 = pending 优先的那一半）',
  );

  const lateClient = await HarnessClient.connect('竞态迟到者', raceUsers[2]!);
  const lateMatched = await lateClient.waitFor('room.matched', 20_000);
  checks.eq(lateMatched.payload.roomCode, raceRoom, '迟到者的 matched 房号（miss 后由连接补推补回）');
  checks.eq(lateMatched.payload.seat, 2, '迟到者的 matched 座位（REST 占座顺序 ⇒ 2 号位）');
  const lateDeal = await lateClient.waitFor('game.deal', 20_000);
  checks.eq(lateDeal.payload.roomCode, raceRoom, '迟到者的 deal 房号');
  checks.eq(lateDeal.payload.hand?.length, 17, '迟到者的手牌张数（补推的是同一裁剪视图）');
  // 「version 对」：补推的 deal 用的是**连接时抓取**的视图版本 ⇒ 与紧随其后的
  // `game.resync`（重新拉取当前快照）必须一致 —— 不一致 = 推的是陈旧/伪造版本。
  // ⚠️ 三人都不发动作、无机器人 ⇒ 对局版本在两步之间不会推进（回合超时 30s 起算）。
  const lateResync = await lateClient.send('game.resync', {});
  checks.eq(lateResync.code, ErrCode.OK, '迟到者 game.resync code（凭 match:pending 定位房间）');
  checks.eq(lateResync.data?.version, lateDeal.version, '补推 deal 的 version 与当前对局版本一致');
  info(
    '⚠️ 线上到达顺序是**先 deal 后 matched**（v2.1 的顺序不可反：反了会让 fetch 窗口内的' +
      '实时更新先到、旧视图后到 ⇒ 客户端假回退 M08）；waitFor 会回看已收消息 ⇒ 这里的等待顺序与线上顺序无关。',
  );
  lateClient.close();

  // ── 3) 负对照：没占座就挂载 ⇒ 12004 ────────────────────────────
  step('房主**先不占座**直接 WS room.join ⇒ 12004（钉住「挂载 ≠ 占座」的会员制语义）');
  const host = await HarnessClient.connect('房主', users[0]!);
  const premature = await host.send('room.join', { roomCode });
  checks.eq(
    premature.code,
    ErrCode.NOT_IN_ROOM,
    '未占座时的 room.join（**不是** 12001 —— 房间确实存在）',
  );

  // ── 4) REST 占座 ───────────────────────────────────────────────
  step('房主 REST 占座：POST /api/rooms/:code/join ⇒ playerCount 1');
  const claimed = await claimSeat(users[0]!.accessToken, roomCode);
  checks.eq(claimed.body?.code, ErrCode.OK, '占座 code');
  checks.eq(claimed.body?.data?.playerCount, 1, '占座后 playerCount');
  checks.eq(
    JSON.stringify(Object.keys(claimed.body?.data ?? {}).sort()),
    JSON.stringify(ROOM_INFO_KEYS),
    '占座响应的字段集恰好是 RoomInfo（不泄漏 players/seat）',
  );

  // ── 5) 占座之后挂载：这一步通了，就说明「占座 → 挂载」这条链成立 ──
  step('房主占座后再 WS room.join ⇒ code 0 + seat 0（F6 修的就是这条链）');
  const hostJoin = await host.send('room.join', { roomCode });
  checks.eq(hostJoin.code, ErrCode.OK, '占座后 room.join code');
  checks.eq(hostJoin.data?.seat, 0, '房主座位（第一个空位）');
  checks.that(
    Array.isArray(hostJoin.data?.players) && hostJoin.data.players.length === 1,
    `ack 的 players 恰好 1 项（${JSON.stringify(hostJoin.data?.players)}）`,
  );

  // ── 6) 第二人：房号加入路径（占座 + 挂载）──────────────────────
  step('第二人：REST 占座 ⇒ 1；WS room.join ⇒ seat 1');
  const secondClaim = await claimSeat(users[1]!.accessToken, roomCode);
  checks.eq(secondClaim.body?.data?.playerCount, 2, '第二人占座后 playerCount');
  const second = await seatPlayer('第二人', users[1]!, roomCode);
  checks.eq(second.ack.code, ErrCode.OK, '第二人 room.join code');
  checks.eq(second.ack.data?.seat, 1, '第二人座位');

  // ── 7) 第三人：坐满 ────────────────────────────────────────────
  step('第三人：REST 占座 ⇒ 2；WS room.join ⇒ seat 2（房间坐满）');
  const thirdClaim = await claimSeat(users[2]!.accessToken, roomCode);
  checks.eq(thirdClaim.body?.data?.playerCount, 3, '第三人占座后 playerCount');
  const third = await seatPlayer('第三人', users[2]!, roomCode);
  checks.eq(third.ack.code, ErrCode.OK, '第三人 room.join code');
  checks.eq(third.ack.data?.seat, 2, '第三人座位');

  const full = await roomFromList(users[0]!.accessToken, roomCode);
  checks.eq(full?.playerCount, 3, '列表里该房间的 playerCount');

  // ── 8) 三人齐 ⇒ **自动开局**（本片接入的开局链路）───────────────
  step('第三人入座后**房间满 ⇒ 立刻开局**：三方都收到 room.matched');
  const matched = await Promise.all([
    host.waitFor('room.matched', 20_000),
    second.client.waitFor('room.matched', 20_000),
    third.client.waitFor('room.matched', 20_000),
  ]);
  for (const [i, m] of matched.entries()) {
    checks.eq(m.payload.roomCode, roomCode, `第 ${i + 1} 方收到的房号与建房一致`);
  }
  info(
    '⚠️ **满即开局**由最后一个入座者在 `room.join` 成功路径上**同步**触发（R902）；' +
      '5 秒一轮的扫描器只是兜底 —— 两者共用同一条链（`RoomStartService.startRoom`）。',
  );

  // ── 8b) 各回一条 room.join（挂载；客户端收到 room.matched 后就是这么做的）
  step('三方各发 room.join（挂载）⇒ seat 与 REST 占座时一致');
  for (const [i, c] of [host, second.client, third.client].entries()) {
    const ack = await c.send('room.join', { roomCode });
    checks.eq(ack.code, ErrCode.OK, `第 ${i + 1} 方 room.join code`);
    checks.eq(ack.data?.seat, i, `第 ${i + 1} 方座位`);
  }

  // ── 8c) 三家都拿到牌 ⇒ **端到端**：占座 → 挂载 → 真能开局 ─────────
  step('三方都收到 game.deal（17 张）—— 片④ 欠下的那条判据，本片补上');
  const deals = await Promise.all([
    host.waitFor('game.deal', 20_000),
    second.client.waitFor('game.deal', 20_000),
    third.client.waitFor('game.deal', 20_000),
  ]);
  for (const [i, d] of deals.entries()) {
    checks.eq(d.payload.roomCode, roomCode, `第 ${i + 1} 方的 deal 房号`);
    checks.eq(d.payload.hand?.length, 17, `第 ${i + 1} 方的手牌张数`);
  }

  // ── 9) 第 4 人：此刻房间**已开局** ⇒ 12008（不是 12002）─────────
  step('第 4 个账号占座 ⇒ 12008（游戏已开始）—— 开局之后占座这条路自己关上了');
  const stranger = await registerUser(3);
  const late = await claimSeat(stranger.accessToken, roomCode);
  checks.eq(
    late.body?.code,
    ErrCode.ROOM_ALREADY_STARTED,
    '第 4 人占座 code（⚠️ 不是 12002：房间已 playing，占座入口先撞上「已开局」）',
  );
  const settled = await roomFromList(users[0]!.accessToken, roomCode);
  checks.eq(settled?.status, 'playing', '列表里该房间的状态');

  // ── 9b) 单人房：等补位死线（20–30s 随机）⇒ 机器人补位 ⇒ 开局 ──────
  step('单人建房 ⇒ REST 占座 ⇒ WS 挂载 ⇒ 等死线 ⇒ 机器人补位 ⇒ 开局');
  const solo = await registerUser(4);
  const soloRoom = (await createRoom(solo.accessToken)).room?.code ?? '';
  checks.that(/^[0-9A-Z]{6}$/.test(soloRoom), `单人房号形状合法（${soloRoom}）`);
  const soloClaim = await claimSeat(solo.accessToken, soloRoom);
  checks.eq(soloClaim.body?.data?.playerCount, 1, '单人占座后 playerCount');
  const soloClient = await HarnessClient.connect('单人居', solo);
  const soloJoin = await soloClient.send('room.join', { roomCode: soloRoom });
  checks.eq(soloJoin.code, ErrCode.OK, '单人居 room.join code（1/3 也能挂载）');

  /**
   * ⚠️ **负对照：不能提前补位**。用户裁决是「先等 20 秒」—— 若实现成「立刻补」，
   * 下面这条会红。⚠️ 它**不**给死线写精确断言（那是 20–30 秒的**随机**值，
   * 精确断言必然 flaky）：只判两端 —— **不会早于 20 秒**、**最终会发生**。
   */
  const early = await roomFromList(solo.accessToken, soloRoom);
  checks.eq(early?.playerCount, 1, '刚入座时仍是 1 人（不得提前补位）');

  step('等 room.matched（死线上界 30s + 扫描周期 5s + 补位/开局开销 ⇒ 给 60s）');
  const soloMatched = await soloClient.waitFor('room.matched', 60_000);
  checks.eq(soloMatched.payload.roomCode, soloRoom, '单人房开局后的房号');
  const filled = await roomFromList(solo.accessToken, soloRoom);
  checks.eq(filled?.playerCount, 3, '补位后的人数');
  checks.eq(filled?.status, 'playing', '补位后房间状态');

  const soloJoin2 = await soloClient.send('room.join', { roomCode: soloRoom });
  checks.eq(soloJoin2.code, ErrCode.OK, '开局后 room.join code');
  checks.eq(soloJoin2.data?.seat, 0, '人类在 0 号位（补位不重排已入座的人）');
  const robots = (soloJoin2.data?.players ?? []).filter(
    (p: { id: string }) => p.id !== solo.id,
  );
  checks.eq(robots.length, 2, '补进来两个机器人');
  checks.that(
    robots.every((p: { id: string }) => !p.id.startsWith('bot-')),
    `机器人的出站 id 不含 bot- 前缀（§9.8）：${JSON.stringify(robots.map((p: { id: string }) => p.id))}`,
  );
  const soloDeal = await soloClient.waitFor('game.deal', 20_000);
  checks.eq(soloDeal.payload.hand?.length, 17, '单人房开局后手牌张数');
  await soloClient.send('room.leave', { roomCode: soloRoom });

  // ── 10) 片⑥（多实例安全）：真 Redis 上的 CAS —— 让**服务端自己**跑一次那段 Lua ──
  //
  // 为什么必须有这条（spec §6.1）：假 Redis **永远证不了**两件事 ——
  //  ① **原子性**：它里面没有「交错」这个可能；
  //  ② 那段 Lua 在**真 Redis** 上**可执行**：单测里的 `eval` 是替身按脚本文本比对后
  //     **模拟**出来的（`makeFakeEval`），它连语法错误、`redis.call` 用法都发现不了。
  // ⇒ 这里在真后端上造一次「开局链返回 false **且房间仍在 `waiting`**」，
  //    把 `match.service` 的降级路径真的走到（它内部就是 `cancelIfStillWaiting` → `EVAL`）。
  step('片⑥ §6.1：造一次降级 ⇒ 服务端必须在真 Redis 上真的执行那段 CAS Lua');
  info('注入手法：把**本用例自己那个新账号**的 `match:pending:{id}` 预置成错类型的键（String）');
  info('  ⇒ `startRoom` 写凭据的 HSET 当场 WRONGTYPE ⇒ 开局链返回 false，');
  info('    而房间**仍在 waiting**（写点先于 `startAndAnnounce`）⇒ 降级那一支被走到。');
  info('⚠️ 写作点迁移说明（片⑦ 修复）：该 HSET 原先挂在匹配路径的 `onSeats` 挂钩上，');
  info('   现已上移为 `RoomStartService.startRoom` 的单一来源（一切开局写凭据）—— 因果链逐字不变。');
  info('⚠️ 只动这个新账号自己的键（TTL 300s，与 §10.4 一致；跑完显式删）：不碰机器人池、');
  info('   不碰任何共享状态 —— 与 slice-07.2-rpc 注入合成池成员是同一手法（R232）。');

  const casUser = await registerUser(5);
  const casClient = await HarnessClient.connect('片⑥降级', casUser);
  const casPendingKey = `match:pending:${casUser.id}`;
  const casMetaKey = `match:meta:${casUser.id}`;
  /** 匹配路径的房号是服务端随机生成的 ⇒ 靠「新出现的 `bot:room:{code}`」反查（见下）。 */
  const roomsBefore = new Set(
    redisLines(['--scan', '--pattern', 'bot:room:*']).map((k) => k.slice('bot:room:'.length)),
  );
  /**
   * **真 Redis 自己记的 `EVAL` 调用次数**（`INFO commandstats`）—— 这条判据的**命门**。
   *
   * ⚠️ 为什么非要它：`attempts ≥ 1` 在**修复前**的实现上**照样**成立（那时降级走
   * `findOne` → `updateStatus('cancelled')`，一次 `EVAL` 都不会发生）⇒ 只断言 `attempts`
   * 的话，这条判据在**旧镜像**上是**空测**（实测：重启前的容器里
   * `dist/rooms/rooms.service.js` **不含** `cancelIfStillWaiting`）。
   * 而 `cmdstat_eval` 的增量是**服务端计数器**：只有真的执行了一段 Lua 才会动。
   * 全仓 `.eval(` **只有一处**（`RoomsService.cancelIfStillWaiting`，`grep` 核过）。
   */
  const evalCalls = (): number => {
    const line = redisCli(['INFO', 'commandstats'])
      .split('\n')
      .find((l) => l.trim().startsWith('cmdstat_eval'));
    return line ? Number(/calls=(\d+)/.exec(line)?.[1] ?? '0') : 0;
  };
  const evalsBefore = evalCalls();
  info(`注入前：真 Redis 的 cmdstat_eval.calls = ${evalsBefore}`);
  redisCli(['SET', casPendingKey, 'poisoned-by-conformance', 'EX', '300']);

  /**
   * 本场景用的底分 = **缺省档位**（15）—— 与 slice-12 其余房间一致（REST 建房不传
   * `baseScore` ⇒ 服务端取档位表最低档；当前种子最低档 = 15）。
   *
   * ⚠️ **片规格 §2.4 协议②之后 `room.match` 的 `baseScore` 必填**（撮合键多了那一维）：
   *  · 少了它 ⇒ 服务端 `validateClientMessage` 当场 10001（下面那条 `checks.eq` 会红）；
   *  · 它同时进**队列键** ⇒ 下面那条 ZSCORE 必须以**同一个值**拼键，否则读到的是一个
   *    **永不存在的键**（恒空 ⇒ 断言恒绿，Task 3c 修复 2 修掉的正是这个形态）。
   */
  const casBaseScore = 15;
  const casAck = await casClient.send('room.match', { mode: 'random', baseScore: casBaseScore });
  checks.eq(casAck.code, ErrCode.OK, '片⑥：room.match code（先正常入队）');

  step('等 30 秒补位窗口（`BOT_FILL_WAIT_MS`）⇒ 扫描器成局 → startRoom 写凭据失败（毒键）→ 降级');
  const attemptsOf = (): number => Number(redisCli(['HGET', casMetaKey, 'attempts']).trim() || '0');
  let casAttempts = 0;
  const casDeadline = Date.now() + 45_000;
  while (Date.now() < casDeadline && casAttempts === 0) {
    await sleep(1_000);
    casAttempts = attemptsOf();
  }

  /**
   * ⚠️ **这一条就是「那段 Lua 在真 Redis 上被服务端执行了」的证据** —— 因果链，不是间接信号：
   * `attempts` **只有一处**会 +1（`match.service` 的 `incrementAttempts()`），
   * 而它挂在 `if (cancelled)` 之下，`cancelled` 就是 `cancelIfStillWaiting()` 里
   * `EVAL` 的返回值。⇒ `attempts ≥ 1` ⟺ 真 Redis 上那段脚本**编译通过、执行成功、返回 1**；
   * 而脚本返回 1 **必然**已经把 `status` 写成 `cancelled`（同一次往返、同一段脚本）。
   *
   * ⚠️ 不写 `=== 1`：扫描周期 5s，轮询可能跨过第二次 ⇒ 读到 2 是同类事件，不是缺陷。
   */
  checks.atLeast(casAttempts, 1, '降级后 match:meta.attempts（只有 CAS 返回 1 才会累加）');

  /**
   * 🔴 **`EVAL` 真的在真 Redis 上执行过**（服务端计数器，不是任何间接信号）。
   * 这条同时挡住「镜像没重建」的**空测**形态（见上面 `evalCalls` 的说明）。
   */
  const evalsAfter = evalCalls();
  checks.atLeast(
    evalsAfter - evalsBefore,
    1,
    `真 Redis 的 cmdstat_eval.calls 增量（注入前 ${evalsBefore} ⇒ 现在 ${evalsAfter}）`,
  );

  const casRoom = redisLines(['--scan', '--pattern', 'bot:room:*'])
    .map((k) => k.slice('bot:room:'.length))
    .find((code) => !roomsBefore.has(code));
  const casStatus = casRoom ? redisCli(['HGET', `room:${casRoom}`, 'status']).trim() : '';
  info(
    `该房间（${casRoom ?? '？'}）此刻的 status = ${casStatus || '（键已不在：回收任务可能刚删了它）'}`,
  );
  info('⚠️ **刻意不断言**这个 status：`cancelled` 的房间会被回收任务**立即**删掉（周期 60s），');
  info('   它随时可能在轮询间隙消失 ⇒ 断言它必然变成一条**偶发假红**（本仓最贵的一类判据）。');
  info('   上面那条 `attempts ≥ 1` 已经**因果地**证明了同一件事（脚本返回 1 ⇔ 已写 cancelled）。');

  /**
   * ⚠️ **片规格 §2.4 之后键多了一维**（`{mode}:{baseScore}:{region}`）—— 旧写法
   * `match:queue:random:global` 在本片之后**再也不存在**，ZSCORE 会读到空值，
   * 于是这条断言**前后都空、恒绿**（Task 3c 修复 2：静默假绿）。
   * 现在用**发出去的那个底分**（`casBaseScore`）拼键：键形状若再变，这里读到的又是空
   * ⇒ 当场变红（判别力由「恒绿」恢复成「钉住键形状」）。
   */
  const casQueueScore = redisCli([
    'ZSCORE',
    `match:queue:random:${casBaseScore}:global`,
    casUser.id,
  ]).trim();
  checks.that(
    casQueueScore.length > 0,
    `§8.4②：降级**不丢人** —— 票必须还在队列里（下个周期重试），实际 ZSCORE=${casQueueScore || '（不在队列里）'}`,
  );

  step('服务端日志：降级**有留痕**、且**没有** Lua 报错（那才是「脚本在真 Redis 上跑通了」）');
  const casLogs = composeLogs('room-service', 180);
  checks.that(
    casLogs.includes('Room start failed for'),
    'room-service 日志里有降级那一行（⇒ 真的走到了 CAS 那一支，而不是「什么都没发生」）',
  );
  const luaHits = casLogs
    .split('\n')
    .filter((line) => /Error (compiling|running) script|Match scan for .* failed/.test(line))
    .map((line) => line.trim());
  checks.that(
    luaHits.length === 0,
    `room-service 日志不得有 Lua 报错 / 整轮扫描失败，实际 ${luaHits.join(' | ') || '（无）'}`,
  );

  // 收尾：先清掉注入的毒键（否则下一轮扫描还会重试一次），再正常退队
  redisCli(['DEL', casPendingKey]);
  checks.eq(
    (await casClient.send('room.unmatch', {})).code,
    ErrCode.OK,
    '片⑥：收尾 room.unmatch code',
  );
  casClient.close();

  // ── 12) 可观测性（一）：traceId 的**三条真栈判据**（判据 6 / 6′ / 11）────────────
  //
  // 为什么必须在真栈上验（spec §7.1 的判据边界四句话）：单测只能证「ALS → 日志行」这一段，
  // **谁把值放进 ALS**、以及容器真的在写 NDJSON，只有真栈能证。
  step('可观测性（一）判据 6：HTTP 一路到底 —— 响应头里的 id 必须出现在下游日志里');
  const obsUser = await registerUser(6);
  const obsCreated = await postJson<RoomInfo>('/api/rooms', { mode: 'practice' }, obsUser.accessToken);
  checks.eq(obsCreated.status, 201, '判据 6：建房 HTTP 状态');
  const httpTraceId = obsCreated.headers?.['x-trace-id'] ?? '';
  checks.that(
    httpTraceId.length > 0,
    `响应必须带 X-Trace-Id（R1106「总是生成 + 回给客户端」）—— 实际 ${JSON.stringify(httpTraceId)}`,
  );
  await sleep(1500); // 日志落地（dockerd 写 json-file 有毫秒级延迟）
  // ⚠️ 消息必须写成**正面陈述**：`checks.that(cond, msg)` 在**成功时也打印 msg**
  //    （本片实测踩过：写成"未找到 X"的口吻，绿行读起来像红 —— 本仓最忌讳的形态）。
  const httpHits = composeLogs('room-service', 60)
    .split('\n')
    .filter((line) => line.includes(httpTraceId)).length;
  checks.that(
    httpHits > 0,
    `room-service 的日志里出现了同一个 id（生成 → 转发 → ALS → 记录 四段一致）：${httpTraceId} 命中 ${httpHits} 行`,
  );

  // 判据 6 的**跨源半边**（最终评审 M1 / R1109）：不带 `Origin` 的 Node 探针能读到回传头，
  // **浏览器**不能 —— 除非网关显式暴露它。这条单测测不出（单测不发 CORS 请求）⇒ 只能真栈验。
  const corsProbe = await fetch(`${GATEWAY_URL}/api/health`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  const exposed = (corsProbe.headers.get('access-control-expose-headers') ?? '').toLowerCase();
  checks.that(
    exposed.split(',').map((s) => s.trim()).includes('x-trace-id'),
    `跨源（带 Origin）的响应必须**暴露** X-Trace-Id —— 否则浏览器客户端读不到回传的 id，` +
      `而 Node 探针照样绿（"声称有、实际没有"形态）—— 实际 expose-headers=${JSON.stringify(exposed)}`,
  );

  step('可观测性（一）判据 6′：WS 两侧同一 id（复核⑦ 的生成点上移）');
  const obsWsUser = await registerUser(7);
  const obsClient = await HarnessClient.connect('可观测性', obsWsUser);
  // ⚠️ 光连上 room-service **不会**打带该 id 的行 —— 要**一条消息**才会（连接级 id + 消息级 reqId
  //    都由消息入口那层 `runWithTrace` 写进 ALS）⇒ 发一条会留下日志的消息（入队），收尾再退队。
  // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
  const obsMatch = await obsClient.send('room.match', { mode: 'random', baseScore: 15 });
  checks.eq(obsMatch.code, ErrCode.OK, '判据 6′：入队 ack（这条消息会给 room-service 留下一行日志）');
  await sleep(1500);
  const connectedLine = composeLogs('api-gateway', 60)
    .split('\n')
    .map(safeJson)
    .find((record) => String(record?.msg ?? '').startsWith('Client connected'));
  checks.that(
    connectedLine?.traceId != null,
    `网关的 \`Client connected\` 行必须带 traceId（复核⑦：生成点已上移到 handleConnection 开头）—— ` +
      `实际 ${JSON.stringify(connectedLine ?? null)}`,
  );
  const wsTraceId = String(connectedLine!.traceId);
  const roomSideLines = composeLogs('room-service', 60)
    .split('\n')
    .map(safeJson)
    .filter((record): record is Record<string, any> => record !== null)
    .filter((record) => record.traceId === wsTraceId);
  checks.that(
    roomSideLines.length > 0,
    `room-service 侧出现了**同一个** traceId ${wsTraceId}，共 ${roomSideLines.length} 行（连接级 id 两侧一致）`,
  );
  checks.that(
    roomSideLines.some((record) => record.source === 'edge'),
    `该行标着 source=edge（WS 消息入口）—— 实测 ${JSON.stringify(roomSideLines.map((r) => r.source).slice(0, 3))}`,
  );
  await obsClient.send('room.unmatch', {});
  obsClient.close();

  step('可观测性（一）判据 11：无来源不编造 —— 定时器族的行不得被标成 bootstrap');
  const roomRecords = composeLogs('room-service', 180)
    .split('\n')
    .map(safeJson)
    .filter((record): record is Record<string, any> => record !== null);
  // 定时器族：一轮工作打的行（`Reaped` / `Matched`）与**轮级 catch**（整轮炸了才打）。
  const TIMER_FAMILY = /Reaped \d+ room\(s\)|Matched \d+ seats|Room start failed|Autostart failed|Room reap failed|Match scan failed/;
  const ROUND_CATCH = /Room reap failed|Autostart scan failed|Match scan failed/;
  const timerLines = roomRecords.filter((record) => TIMER_FAMILY.test(String(record.msg)));
  const roundCatchLines = timerLines.filter((record) => ROUND_CATCH.test(String(record.msg)));
  checks.that(
    timerLines.length > 0,
    `180s 内扫到 ${timerLines.length} 条定时器族的日志行（**反空测**：一条都没有说明这一轮什么都没扫到，` +
      `那本条判据就是空转）`,
  );
  const mislabeled = timerLines.filter((record) => record.source !== 'timer');
  checks.that(
    mislabeled.length === 0,
    `定时器族的行来源都如实标着 timer（${timerLines.length} 条）—— 把定时器标成 bootstrap（含义是"启动早期"）` +
      `是**假话**，R1107 明文禁止；违例 ${mislabeled.length} 条`,
  );
  const badIds = timerLines.filter((record) =>
    ROUND_CATCH.test(String(record.msg)) ? record.traceId !== null : record.traceId === null,
  );
  checks.that(
    badIds.length === 0,
    `一轮工作都带**自建 id**（非空，同一轮的行因此成组）；轮级 catch 才是 null（本次 ${roundCatchLines.length} 条）—— ` +
      `违例 ${badIds.length} 条`,
  );
  info(
    `定时器族样本 ${timerLines.length} 条（轮级 catch ${roundCatchLines.length} 条，应为 null）；` +
      `示例：${JSON.stringify(timerLines.slice(0, 2).map((r) => ({ source: r.source, traceId: r.traceId, msg: String(r.msg).slice(0, 48) })))}`,
  );

  step('可观测性（一）判据 7：跨 RPC 那一跳 —— 同一轮的 id 必须跨过 TCP 出现在对端');
  // ⚠️ **判据形态订正（本片实测踩过三轮，教训值得留）**：真栈判据里的「**哪两行**」必须先用实测数据
  //    核过，**不能凭「这条链应该长这样」推断**：
  //   ① 用单人房开局 ⇒ 那条链**成功时不打日志** ⇒「对侧出现同一个 id」结构性无从成立；
  //   ② 用匹配房的 `Matched N seats` ⇒ **本用例没有匹配路径的房间**（3 人房是 REST 建的手动房）；
  //   ③ 用「最后一个入座者的 `joined room … at seat 2`」⇒ 那是 **REST 占座**（`d3e014f8`）这条**另一次操作**，
  //      而房间其实由**紧随其后的 WS `room.join`**（连接级 `2e7fcc2b`）同步触发（R902）⇒ 两者**本就该不同**。
  //   ⇒ 最终形态**不依赖"哪两行"的推断**：断言 game-service 那行的 id **在 room-service 侧出现过** ——
  //      那个 id 只可能来自我们发过去的 `meta`（接收侧的 `source: 'rpc'` 也是同一份证据）。
  const gsRecords = composeLogs('game-service', 240)
    .split('\n')
    .map(safeJson)
    .filter((record): record is Record<string, any> => record !== null);
  const createdLine = gsRecords.find((record) =>
    String(record.msg).includes(`Game created for room ${roomCode}`),
  );
  checks.that(
    createdLine != null,
    `game-service 记录了「Game created for room ${roomCode}」（RPC 那一跳的接收侧工作行，否则本条空转）`,
  );
  checks.eq(
    createdLine!.source,
    'rpc',
    `接收侧来源如实标 rpc（由 RPC 的 meta 带入上下文）—— traceId=${String(createdLine!.traceId)}`,
  );
  checks.that(
    createdLine!.traceId != null,
    `接收侧必须拿到**调用方**的 id（不是自己生成的）—— 实际 ${JSON.stringify(createdLine!.traceId)}`,
  );
  const rpcId = String(createdLine!.traceId);
  const callerSideLines = composeLogs('room-service', 240)
    .split('\n')
    .filter((line) => line.includes(rpcId)).length;
  checks.that(
    callerSideLines > 0,
    `**同一个** id ${rpcId} 在 room-service 侧出现了（共 ${callerSideLines} 行）⇒ meta 真的跨过 TCP、` +
      `被对端 ALS 接住，且它就是调用方那条链的 id；这一条同时**经验性地**回答了` +
      `「ValidationPipe 会不会剥掉载荷里的 meta」——没剥`,
  );

  // ── 判据 8：S7 运行态**泄敏采样**（§5.5）──────────────────────────────
  //
  // ⚠️ **本条的来历要说清楚**（本片实测发现）：规格把它写成「既有采样…继续绿」，
  //    但全仓 `tools/conformance` 里**没有**采样代码 —— 它原本是 P14 那次**一次性人工验证**
  //    （「跑完一局真局后采样 10 类危险模式全 0」）。本片改了**日志形态**（纯文本 → NDJSON）
  //    ⇒ 泄敏面必须复检 ⇒ 这里把它**实现成自动化判据**（把一次性人工验证变成判据）。
  //
  // ⚠️ 三条纪律：
  //  ① 模式只认**值**不认**键**（脱敏后的形态是 `"password":"[REDACTED]"` ⇒ 键名当然还在，
  //     认键会把**脱敏正确**的行判成泄漏 —— 假红）；
  //  ② **正对照**：把一段合成的泄漏样本喂给同一个谓词 ⇒ 每个模式都必须命中（否则谓词是空转）；
  //  ③ **反空测**：真实样本里必须有我们的 NDJSON 行（否则扫的是一个空窗口）。
  const LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['手牌数组', /"hand"\s*:\s*\[/],
    ['底牌数组', /"bottomCards"\s*:\s*\[/],
    ['actionLog', /"actionLog"/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/],
    ['Bearer 令牌', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/],
    ['password 值', /"password"\s*:\s*"(?!\[REDACTED\])/i],
    ['refreshToken 值', /"refreshToken"\s*:\s*"(?!\[REDACTED\])/i],
    ['accessToken 值', /"accessToken"\s*:\s*"(?!\[REDACTED\])/i],
    ['手机号', /\b1[3-9]\d{9}\b/],
    ['内部令牌头', /x-internal-token["']?\s*[:=]\s*["'][^"'\s]{8,}/i],
  ];
  /** 同一段谓词既跑真实样本、也跑正对照（R115：先证明探针有效，再相信它的结论）。 */
  const leaksIn = (text: string): string[] =>
    LEAK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

  // 正对照：合成的泄漏样本必须**每一个模式都命中**（把某个模式写错/写宽了这里会红）。
  // ⚠️ 样本是**泄漏形状的文本**（不追求是合法 JSON —— 谓词扫的就是文本）。
  //    ⚠️ 单引号字符串里的双引号**不需要**转义：写成 `\\"` 会得到 `\"`（反斜杠+引号），
  //    那样正对照会当场红（本片实测踩过：10 个模式只命中 6 个）。
  const SYNTHETIC_LEAK = [
    '{"ts":"x","level":"log","service":"s","context":"C","traceId":null,"reqId":null,"userId":null,',
    '"source":"bootstrap","msg":"hand="hand":[{"r":3,"s":0}] "bottomCards":[1] "actionLog":[...] ',
    'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abcdefgh Bearer abcdefghijklmnop ',
    '"password":"pw" "refreshToken":"rt" "accessToken":"at" 13912345678 x-internal-token: "super-secret-value"}',
  ].join('');
  const syntheticHits = leaksIn(SYNTHETIC_LEAK);
  checks.eq(
    syntheticHits.length,
    LEAK_PATTERNS.length,
    `判据 8 正对照：合成泄漏样本必须让**全部 ${LEAK_PATTERNS.length} 个模式**都命中（证明谓词有效）—— ` +
      `命中 ${syntheticHits.join(', ') || '（无）'}`,
  );

  // 实扫：五个服务近 10 分钟的日志（真局刚跑过 ⇒ 里面确实有牌局与令牌的痕迹可查）。
  const sampledServices = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service'];
  let sampledLines = 0;
  const violations: string[] = [];
  for (const service of sampledServices) {
    for (const line of composeLogs(service, 600).split('\n')) {
      if (safeJson(line) === null) continue; // 只看我们的 NDJSON 行（启动横幅等非 JSON 行不算）
      sampledLines += 1;
      const hits = leaksIn(line);
      if (hits.length > 0) violations.push(`${service}: [${hits.join(',')}] ${line.trim().slice(0, 160)}`);
    }
  }
  checks.that(
    sampledLines > 50,
    `判据 8 反空测：真实样本里有 ${sampledLines} 条 NDJSON 行（**日志形态本片刚改过** ⇒ 这里同时证明新形态真的在写）`,
  );
  checks.that(
    violations.length === 0,
    `§5.5 泄敏：五个服务的日志里**不得**出现牌面 / 令牌 / 口令 / 手机号（采样 ${sampledLines} 行）—— ` +
      `违例 ${violations.length} 条：${violations.slice(0, 3).join(' | ')}`,
  );

  // ── 11) 收尾：三人显式离开，让房间尽快进回收窗口 ────────────────
  step('收尾：三人 room.leave（不留垃圾房间）');
  for (const [label, c] of [
    ['房主', host],
    ['第二人', second.client],
    ['第三人', third.client],
  ] as const) {
    const left = await c.send('room.leave', { roomCode });
    checks.eq(left.code, ErrCode.OK, `${label} room.leave code`);
  }

  return checks;
}
