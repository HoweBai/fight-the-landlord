/**
 * 切片 7.1 conformance：room-service 的**原子入座**（偏差 C11 / §10.2 / §3.1；裁决 R124–R128）。
 *
 * 为什么必须单独一条用例：切片 6/7 的用例**从没并发入座过**（切片 7 走的是
 * `room.match` → `createGameRoom` 一次性建局），而 `GET → push → SET` 的丢失更新
 * 只在**并发**下暴露。两条判据一条不靠时序、一条靠并发：
 *   ① **幂等**：同一 userId 连续 join 两次，旧实现 `push` 两次 ⇒ `playerCount = 2`
 *      （**不依赖时序的 RED 判据**，本用例的负对照以它为准）；
 *   ③ **20 路直连并发**：修复后必须 `ok=3 / playerCount=3`（原子性）；
 *      旧实现在**连接已预热**时是 `ok=20 / playerCount=1`（丢人）。
 *
 * ⚠️ **必须直连 `ROOM_URL`（3002）**：本机实测**经网关**的 20 路并发 3 轮全部
 * `ok=3 / playerCount=3` —— 网关的验签 + 会话白名单把到达时刻错峰了，竞态打不出来（R131）。
 *
 * ⚠️ **并发窗口的前提是「连接已预热」**（R132，实测）：旧实现的丢更新窗口只在
 * 「N 条连接已就绪、N 个请求在同一 tick 内被写出」时才打得开。用全局 `fetch`
 * **冷连接**发 20 路时，TCP 建连 + accept 会把到达时刻**串行化**，localhost 的
 * `GET→SET` 往返（亚毫秒）往往在下一个请求的数据事件之前就结束 ⇒ 旧实现**意外地正确**
 * （实测 `ok=3 / playerCount=3`，用例会假绿）。因此第 ③⑥ 组的并发 burst **必须**
 * 走下面这个显式 keep-alive 连接池（先 `/api/health` 预热 ≥ `BURST` 条连接）。
 * 修复后（`HSETNX`）这组是**结构性确定**的：预热与否都恰好 3 席，不会假红。
 *
 * ⚠️ 「不丢人」与「不超员」是**两个独立不变量**（实测 `ok=4 / playerCount=3`：
 * 4 个人被告知入座成功、房间只有 3 席）：`playerCount` 只能证**不超员**，
 * **`并发成功路数 === 3` 才是「不丢人」的唯一判据**。
 *
 * ⚠️ 直连**必须带** `X-Internal-Token`（P1/R96），否则会被 10002 挡在中间件层，
 * 用例会以「全部 10002」假红。`directJson` 的 `internalToken` 默认就是正确的 token。
 *
 * ⚠️ `POST /api/rooms/:code/join` 的成功响应是**信封** `{ code, data: RoomInfo }`
 * （与 `game.*` 的裸 `PlayerView` 不同）；`RoomInfo` 里**没有** `players`/`seat`，
 * 因此座位形状只能用 `room.join`（WS）的 ack 读回（第 ⑤ 组）。
 */
import { Agent, request as httpRequest } from 'node:http';
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, info, sleep, step } from '../lib/assert';
import {
  directJson, getJson, postJson, registerUser, setFriendRooms, INTERNAL_TOKEN, ROOM_URL, type HarnessUser,
} from '../lib/http';
import { HarnessClient } from '../lib/client';

/** 并发路数。20 路足以让旧实现「20 人全部入座、房间只剩 1 人」（连接预热后实测）。 */
const BURST = 20;

/** 直连 room-service 入座：§10.2 的原子性契约在**服务自身**，与网关无关。 */
async function joinDirect(user: HarnessUser, roomCode: string) {
  return directJson<unknown>(ROOM_URL, `/api/rooms/${roomCode}/join`, {
    method: 'POST',
    userId: user.id,
    internalToken: INTERNAL_TOKEN,
    body: {},
  });
}

/**
 * 第 ③⑥ 组的**专用 keep-alive 连接池**（`node:http`，**不是**全局 `fetch`/undici）。
 *
 * 存在的唯一理由见文件头 R132：全局 `fetch` 的**冷连接**会把 20 路并发串行化，
 * 让旧实现的丢更新窗口根本打不开（用例假绿）。这里显式预热 `BURST + 4` 条连接，
 * 使 20 个请求真的在同一 tick 内落到 room-service。
 *
 * ⚠️ 保持 `keepAlive: true` 且**不要**设 `maxSockets`（默认 `Infinity`）：
 * 预热几次就真的开几条连接；预热与 burst 必须用**同一个 agent**，
 * 否则预热的是另一个池（这正是「用 fetch 预热 fetch」最容易踩空的地方）。
 */
const burstAgent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

interface RawResponse {
  status: number;
  code: number;
  text: string;
}

/** 走 `burstAgent` 的裸请求；只用于**直连 room-service** 的探针（响应是 `{ code, … }` 信封）。 */
function requestViaBurstAgent(
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest(
      `${ROOM_URL}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        agent: burstAgent,
        headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let code = -1;
          try {
            code = (JSON.parse(text) as { code?: number }).code ?? -1;
          } catch {
            code = -1; // 非 JSON（例如 404 的 HTML）—— 保留 -1 让断言自己红
          }
          resolve({ status: res.statusCode ?? 0, code, text });
        });
      },
    );
    req.on('error', reject);
    req.end(body ?? '');
  });
}

/**
 * 预热 `BURST + 4` 条 keep-alive 连接（R132）。
 *
 * `/api/health` 是内部 token 的**豁免**路由（R87），因此它既能开连接又不受鉴权干扰。
 * 预热不足时第 ③ 组会退化成「串行 20 次」（旧实现也能过）—— 这是本用例
 * **最脆弱的一环**，所以预热失败/条数不足必须**显式报错**，不能静默继续。
 */
async function warmBurstConnections(): Promise<void> {
  const warm = Array.from({ length: BURST + 4 }, async () => {
    const res = await requestViaBurstAgent('/api/health', {});
    if (res.status !== 200) throw new Error(`预热连接失败：HTTP ${res.status}`);
  });
  await Promise.all(warm);
}

/** 走**预热的**连接池直连入座，只回错误码。 */
function burstJoin(userId: string, roomCode: string): Promise<number> {
  return requestViaBurstAgent(
    `/api/rooms/${roomCode}/join`,
    {
      'Content-Type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
      'x-user-id': userId,
    },
    '{}',
  ).then((res) => res.code);
}

async function playerCountOf(token: string, roomCode: string): Promise<number | undefined> {
  const list = await getJson<Array<{ code: string; playerCount: number }>>('/api/rooms', token);
  return list.body?.data?.find((r) => r.code === roomCode)?.playerCount;
}

async function createRoom(token: string): Promise<string> {
  const created = await postJson<{ code: string }>('/api/rooms', { mode: 'random' }, token);
  const code = created.body?.data?.code ?? '';
  if (created.body?.code !== ErrCode.OK || code.length === 0) {
    throw new Error(`建房失败：HTTP ${created.status} ${JSON.stringify(created.body)}`);
  }
  return code;
}

export async function runSlice071(): Promise<Checks> {
  const checks = new Checks();
  step(`准备 ${BURST} 个真实账号`);
  const users: HarnessUser[] = [];
  for (let i = 0; i < BURST; i += 1) users.push(await registerUser(i));
  const owner = users[0]!;
  checks.eq(users.length, BURST, '账号数量');

  // ── 片⑦ 前置（T14）：好友房开关必须**开** ────────────────────────
  // 本片的建房（`POST /api/rooms`）与**全部占座**（`POST /api/rooms/:code/join`，含
  // ③⑥ 组直连 room-service 的 burst）都在 rooms.controller 的 12006 闸之后。
  // ⚠️ 只开**不还原**（规格 §3 编排：开关的复原是 slice-14 收尾的职责）。
  await setFriendRooms(true, owner.accessToken);

  // ── ① 幂等（R126）：不依赖时序的 RED 判据 ───────────────────────
  step('① 同一 userId 连续 join 两次 → 同一座位、人数不变（旧实现 push 两次 ⇒ 2）');
  const roomA = await createRoom(owner.accessToken);
  checks.eq((await joinDirect(owner, roomA)).body?.code, ErrCode.OK, 'u0 首次 join code');
  checks.eq(await playerCountOf(owner.accessToken, roomA), 1, '首次 join 后 playerCount');
  checks.eq((await joinDirect(owner, roomA)).body?.code, ErrCode.OK, 'u0 重复 join code（幂等，不是 12002）');
  checks.eq(await playerCountOf(owner.accessToken, roomA), 1, '重复 join 后 playerCount（旧实现 = 2）');

  // ── ② 满座边界（§11.2 的 12002） ───────────────────────────────
  step('② 顺序坐满 3 人；第 4 人 → 12002，且人数不变');
  checks.eq((await joinDirect(users[1]!, roomA)).body?.code, ErrCode.OK, 'u1 join code');
  checks.eq((await joinDirect(users[2]!, roomA)).body?.code, ErrCode.OK, 'u2 join code');
  checks.eq(await playerCountOf(owner.accessToken, roomA), 3, '坐满后 playerCount');
  checks.eq((await joinDirect(users[3]!, roomA)).body?.code, ErrCode.ROOM_FULL, '第 4 人 code（12002）');
  checks.eq(await playerCountOf(owner.accessToken, roomA), 3, '被拒后 playerCount 不变');

  // ── ③ 并发占座（§10.2 的核心：不丢人） ─────────────────────────
  step(`③ 预热 ${BURST + 4} 条 keep-alive 连接后，${BURST} 路**直连并发** join 同一空房 → 恰好 3 个 code 0、其余 12002、playerCount = 3`);
  const roomB = await createRoom(owner.accessToken);
  await warmBurstConnections(); // R132：不预热则旧实现的竞态窗口打不开（用例会假绿）
  checks.ok(`预热 ${BURST + 4} 条 keep-alive 连接完成（并发窗口的前提，R132）`);
  const results = await Promise.all(users.map((u) => burstJoin(u.id, roomB)));
  const winners = users.filter((_, i) => results[i] === ErrCode.OK);
  // ⚠️ 「不丢人」的**唯一**判据是这一条：`playerCount` 证不了它（实测旧实现 `ok=4 / playerCount=3`）
  checks.eq(winners.length, 3, `并发成功路数（旧实现预热后实测 ${BURST} 路全部成功）`);
  checks.eq(results.filter((c) => c === ErrCode.ROOM_FULL).length, BURST - 3, '被 12002 拒绝的路数');
  checks.eq(
    results.filter((c) => c !== ErrCode.OK && c !== ErrCode.ROOM_FULL).length, 0,
    '没有第三种错误码（尤其不能是 10002：内部 token 没带对）',
  );
  checks.eq(await playerCountOf(owner.accessToken, roomB), 3, '并发后 playerCount（旧实现预热后实测 = 1）');
  await sleep(300);
  checks.eq(await playerCountOf(owner.accessToken, roomB), 3, '静默窗后 playerCount 仍是 3（无迟到写入）');

  // ── ④ 反例：并发落败者**真的**没座位（否则「3 个赢家」可能是假象） ──
  step('④ 并发落败者 room.join（WS）→ 12004（不是成员，确实没入座）');
  const loserIndex = results.findIndex((c) => c === ErrCode.ROOM_FULL);
  checks.that(loserIndex >= 0, `存在落败者（index=${loserIndex}）`);
  const loserClient = await HarnessClient.connect('loser', users[loserIndex]!);
  try {
    checks.eq((await loserClient.send('room.join', { roomCode: roomB })).code, ErrCode.NOT_IN_ROOM, '落败者 room.join code');
  } finally {
    loserClient.close();
  }

  // ── ⑤ 同一真源：HTTP 占座的赢家 = WS 视图里的成员，座位恰好 {0,1,2} ──
  step('⑤ 并发赢家 room.join（WS）→ 成员恰好 3 席、座位 {0,1,2}、自己真的在里面');
  const winnerClient = await HarnessClient.connect('winner', winners[0]!);
  try {
    const ack = await winnerClient.send('room.join', { roomCode: roomB });
    checks.eq(ack.code, ErrCode.OK, '并发赢家 room.join code');
    const players = (ack.data?.players ?? []) as Array<{ id: string; seat: number }>;
    checks.eq(players.length, 3, 'WS 视图里的成员数');
    checks.eq(
      players.map((p) => p.seat).sort((a, b) => a - b).join(','), '0,1,2',
      '座位集合恰好 {0,1,2}',
    );
    checks.that(
      players.some((p) => p.id === winners[0]!.id),
      'HTTP 占座的赢家出现在 WS 成员表里（seats Hash 是同一真源）',
    );
    checks.that(!JSON.stringify(ack.data ?? {}).includes('isRobot'), 'ack 不泄漏 isRobot（§6.4 规则 3）');
  } finally {
    winnerClient.close();
  }

  // ── ⑥ 已坐满 + 并发 → 不超员（正向对照；旧实现也过，防「修成一律放行」） ──
  step('⑥ 先坐满 3 人，再并发 17 路 → 全部 12002、playerCount 恒为 3');
  const roomC = await createRoom(owner.accessToken);
  for (const u of users.slice(0, 3)) {
    checks.eq((await joinDirect(u, roomC)).body?.code, ErrCode.OK, `${u.nickname} 占座 code`);
  }
  const late = await Promise.all(users.slice(3).map((u) => burstJoin(u.id, roomC)));
  checks.eq(late.filter((c) => c === ErrCode.ROOM_FULL).length, late.length, '迟到者全部 12002');
  checks.eq(await playerCountOf(owner.accessToken, roomC), 3, '并发拥挤后 playerCount（不超员）');

  info(`房间：A=${roomA}（幂等/满座）· B=${roomB}（${BURST} 路并发）· C=${roomC}（不超员对照）`);
  // 收工：keep-alive 空闲连接虽然会被 unref（不会吊住事件循环），显式销毁更干净
  burstAgent.destroy();
  return checks;
}
