/**
 * 切片 7.2-P1 conformance：**服务间身份边界**（偏差 N4 / N7）。
 *
 * 计划：`docs/superpowers/plans/2026-09-14-slice-07.2-p1-internal-token.md`
 *（Task 3 Step 1 的断言序列；裁决 R87–R96）。
 *
 * 本片关掉的通道：
 *   > 直连 3001 / 3002 / 3003 / 3005 并伪造 `X-User-Id` ⇒ 冒充任意玩家（N4）；
 *   > 服务间调用没有可校验的对端凭据（N7）。
 * 做法是两半：**网关在每一跳下游注入 `X-Internal-Token`** ＋ **四个下游服务在全部业务
 * 路由上校验它（`/api/health` 豁免）**。本用例把两半都钉在集成层。
 *
 * 断言序列（缺一条就漏一条）：
 *   1. 直连四个下游服务的业务路由、**不带** token ⇒ 401 + `10002`；
 *   2. 直连带**错误** token ⇒ 仍然 `10002`（错值不得放行）；
 *   3. 直连 `/api/health` 无 token ⇒ **200**（R87 的豁免；防的是「加固把容器打成 unhealthy」
 *      进而全线雪崩 —— 本片最可能的失败模式是「加固把平台打断」，不是「漏洞还在」）；
 *   4. 直连带**正确** token + `X-User-Id: <真实玩家>` ⇒ 200（内部路径仍可用，不是一律拒绝）；
 *   5. 经网关的业务请求**自带** `X-Internal-Token` ⇒ 网关边缘必须拒绝，且不返回业务数据；
 *   6. 全程不新增业务数据（唯一带 body 的探针是那句幽灵手机号登录，它在边界层就被拒，
 *      根本打不到 service）。
 *
 * ⚠️ **第 6 步（N20/P4 新增，R218）**：`POST /api/games`、`GET /api/games/:roomCode/snapshot`、
 *   `POST /api/robots/{acquire,release,decide}` 这五条**内部**路由已被 TCP RPC 取代并**整条删除**
 *   ⇒ 直连（带**正确**内部 token）必须 **404**。第 1/2/4 步的既有直连断言**全部保留**：
 *   `GET /api/games/:roomCode/state` 与 `GET /api/robots/list` 没被删，N4/N7 的边界仍在。
 *   判别力：旧栈上这五条是 201/200/200/200/500（实测），只有「路由确实不存在」才会 404。
 *
 * ⚠️ 第 1 步为什么带 `X-User-Id`：那正是 N4 的攻击形态。不带它的话，user-service 的
 * `/api/users/me` 与 game-service 的视图在 **P1 之前**也会因为「缺少身份」而 401，
 * 断言就失去判别力（负对照要求：在**没有**本片修复的镜像上，第 1/2 步必须红）。
 *
 * ⚠️ robot-service 的 `10002` 是**本地常量**（R93：它不依赖 `packages/protocol`，以免动
 * `pnpm-lock.yaml`）。所以本用例对 robot 的 `code === 10002` 断言就是那份常量漂移的
 * **集成层兜底** —— 它红了要改 robot-service 的常量，**不要**放宽这里的断言。
 *
 * ⚠️ 响应形状（N6 / R139 之后 = **§11.1 信封**）：
 *   - `game-service` 的 `GET /api/games/*` 成功时返回 `{ code: 0, data: PlayerView }`
 *     （**修前是裸 `PlayerView`** ⇒ `body.code === undefined`；错误路径 `{ code, message, data: null }`）；
 *   - `robot-service` 的 `GET /api/robots/list` 返回**裸数组**（本片**不动**它：没有偏差编号指派，
 *     见计划「已知缺口」）；
 *   - `user-service` / `room-service` 是 `{ code, message, data }` 信封。
 * `hand` 一律**排序后**逐张比较（DouZero 编码顺序不是契约）。
 */
import { ErrCode, type PlayerView } from '@fight-the-landlord/protocol';
import { Checks, info, step } from '../lib/assert';
import {
  directJson,
  gameGetJson,
  getJson,
  GAME_URL,
  HARNESS_PASSWORD,
  INTERNAL_TOKEN,
  INTERNAL_TOKEN_HEADER,
  registerUser,
  ROBOT_URL,
  ROOM_URL,
  USER_URL,
  type HarnessUser,
} from '../lib/http';
import { HarnessClient } from '../lib/client';

/** 直连探针要看的「原始」响应（要**原文**才能区分「路由不存在」与「业务 404」）。 */
interface RawResult {
  status: number;
  text: string;
}

/**
 * **直连**下游服务的原始请求（带**正确**的内部 token ⇒ 跨过 P1 的边界，直击路由是否存在）。
 *
 * ⚠️ 与 `directJson` 的分工：那个把非 JSON 压成 `{code: status}`，**丢掉**了
 * `Cannot POST /api/games` 这种原文，而本步的判据「404 的成因是**路由不存在**」正需要它。
 * （同一手法见 `slice-07.2-rpc` 第 3 组；`slice-07.2-hardening` 第 9 步也钉过这条区分。）
 */
async function directRaw(baseUrl: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<RawResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

/**
 * `game-service` 视图路由的响应形状（**N6 / R139 之后**）：
 * 成功 = `{ code: 0, data: PlayerView }`（§11.1 信封），失败 = `{ code: <5 位>, message, data: null }`。
 *
 * **修前**成功路径是**裸 `PlayerView`** ⇒ `body.code === undefined` ⇒ `isOkView` 为假 ⇒
 * 本文件的「对照组非空」断言会红 —— 这就是 N6 的负对照。
 */
interface ViewShape {
  seat?: number;
  hand?: unknown;
}

interface ViewBody {
  code?: number;
  data?: ViewShape | null;
}

/** 成功 = HTTP 200 且 §11.1 信封的 `code === 0`（修前：裸 PlayerView ⇒ false）。 */
function isOkView(status: number, body: ViewBody): boolean {
  return status === 200 && body.code === 0;
}

/** 取信封里的视图（没有 `data` 时给空对象，让断言给出「字段 undefined」而不是抛异常）。 */
function viewOf(body: ViewBody): ViewShape {
  return (body.data ?? {}) as ViewShape;
}

/**
 * 牌 → 规范键。R696：牌是 `{r, s}`，用 `"r-s"` 作为它的身份。
 * 已经是键（`string`）时原样返回 —— **本函数必须幂等**：有调用方先把结果存起来
 * （`const aHand = sorted(...)`）再传回 `sameHand()`，也有的读它的 `.length`。
 */
const cardKey = (c: unknown): string =>
  typeof c === 'string' ? c : `${(c as { r: number; s: number }).r}-${(c as { r: number; s: number }).s}`;

/**
 * 手牌比较一律排序后逐张比 —— 出站顺序不是契约（§4.2）。
 *
 * ⚠️ **R696 的关键修正** —— 旧实现是 `.map(Number).sort((a, b) => a - b)`。
 * 牌变成 `{r, s}` 之后 `Number({r,s})` = **`NaN`** ⇒ 排序结果恒为 `[NaN, NaN, ...]`
 * ⇒ `JSON.stringify` 得 `"[null,null,...]"` ⇒ **任意两副同长度手牌都被判为「相等」**。
 *
 * 后果分两种，方向相反且**都危险**：
 *  - `!sameHand(a, b)`（「两副牌必须不同」）⇒ 恒 `false` ⇒ **恒红**（看得见）；
 *  - `sameHand(a, b)`（「两副牌必须相同」）⇒ 恒 `true` ⇒ **假绿** —— 这半边才藏得住缺陷
 *    （例如「他人手牌泄漏进我的视图」这类断言会静默通过）。
 *
 * ⇒ 按 `(r, s)` 逐张比较 —— 那才是牌的真实身份。
 */
function sorted(cards: unknown): string[] {
  if (!Array.isArray(cards)) return [];
  return (cards as unknown[]).map(cardKey).sort();
}

function sameHand(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function describe(cards: unknown): string {
  return Array.isArray(cards) ? JSON.stringify(sorted(cards)) : String(cards);
}

export async function runSlice072Boundary(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];

  try {
    // ── 0) 准备一局真牌局：第 4 步的「内部路径仍可用」需要一个真实会话 ──
    step('准备：3 个真实账号 → 匹配成局 → room.join ×3 → game.deal（第 4 步的正对照需要真牌局）');
    const users: HarnessUser[] = [];
    for (let i = 0; i < 3; i += 1) users.push(await registerUser(i));
    for (let i = 0; i < 3; i += 1) clients.push(await HarnessClient.connect(`P${i}`, users[i]!));
    const playerA = users[0]!;
    checks.ok(`3 个客户端完成握手（A = ${playerA.id}）`);

    for (const client of clients) {
      // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
      checks.eq(
        (await client.send('room.match', { mode: 'random', baseScore: 15 })).code,
        ErrCode.OK,
        `${client.label} room.match code`,
      );
    }
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', 25_000)));
    const roomCode = matched[0]!.payload.roomCode as string;
    checks.that(/^[0-9A-Z]{6}$/.test(roomCode), `roomCode = ${roomCode}（形状与 R75 白名单一致）`);

    for (const client of clients) {
      checks.eq((await client.send('room.join', { roomCode })).code, ErrCode.OK, `${client.label} room.join code`);
    }

    const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
    const dealA = deals[0]!.payload as PlayerView;
    const aSeat = Number(dealA.seat);
    const aHand = sorted(dealA.hand);
    info(`A(${clients[0]!.label}) deal.seat=${aSeat} deal.hand=${describe(dealA.hand)}`);

    // 权威快照作为参照真值（与 `slice-07.2-security` 同一手法：多一条服务端自证的锚点）。
    const resyncA = await clients[0]!.send('game.resync', {}, 0);
    checks.eq(resyncA.code, ErrCode.OK, 'A game.resync code');
    checks.eq(Number(resyncA.data.seat), aSeat, 'A 的权威 seat 与 game.deal 一致');
    checks.that(sameHand(resyncA.data.hand, aHand), `A 的权威 hand 与 game.deal 一致（${describe(aHand)}）`);

    /**
     * 第 1 / 2 步的统一判据：**必须**是 401 + `10002`。
     *
     * 刻意**不**放宽成「≥ 400」或「任何 401」：那会让「路由还在、只是换了个报错」
     * 也算通过，等于把「边界生效」偷换成「有报错」。R88 规定缺失/错误一律 `10002`。
     */
    const expectRejected = (label: string, status: number, body: { code?: number; data?: unknown }): void => {
      checks.eq(status, 401, `${label} 的 HTTP 状态`);
      checks.eq(body?.code, ErrCode.UNAUTHENTICATED, `${label} 的 body.code（R88：必须精确等于 10002）`);
      checks.that(body?.data == null, `${label} 被拒时不返回任何 data`);
    };

    // 幽灵手机号：形状合法、但从未注册 ⇒ P1 之前它只会走到 service 层并返回「用户不存在」，
    // 因此「无 token 直连登录」这条探针在负对照里同样是红的（不是靠 10002 蒙对）。
    const ghostPhone = `139${String(Date.now()).slice(-8)}`;

    // ── 1) N4：直连四个下游的业务路由，不带内部 token（并伪造 X-User-Id） ──
    step('第 1 步 N4：直连 3001/3002/3003/3005 的业务路由、**不带** X-Internal-Token → 全部 401 + 10002');
    info('除那句幽灵手机号登录外，其余探针都伪造一个**真实**玩家的身份头（N4 的攻击形态）——');
    info('不带它的话 user/game 两条在 P1 之前也会因「缺身份」而 401，用例就失去判别力。');

    const userMeNoToken = await directJson<{ id?: string }>(USER_URL, '/api/users/me', {
      headers: { authorization: `Bearer ${playerA.accessToken}` },
    });
    expectRejected('直连 user:3001 GET /api/users/me（带 A 的 access token）', userMeNoToken.status, userMeNoToken.body ?? {});

    const userLoginNoToken = await directJson(USER_URL, '/api/auth/login', {
      method: 'POST',
      body: { phone: ghostPhone, password: HARNESS_PASSWORD },
    });
    expectRejected(
      '直连 user:3001 POST /api/auth/login（**公开**跳也必须过内部 token，网关注入漏一跳即全站登录失败）',
      userLoginNoToken.status,
      userLoginNoToken.body ?? {},
    );

    const roomListNoToken = await directJson(ROOM_URL, '/api/rooms', { userId: playerA.id });
    expectRejected('直连 room:3002 GET /api/rooms', roomListNoToken.status, roomListNoToken.body ?? {});

    const gameViewNoToken = await gameGetJson<unknown>(`/api/games/${roomCode}/state`, playerA.id, null);
    expectRejected(
      `直连 game:3003 GET /api/games/${roomCode}/state`,
      gameViewNoToken.status,
      (gameViewNoToken.body ?? {}) as ViewBody,
    );

    const robotListNoToken = await directJson(ROBOT_URL, '/api/robots/list', { userId: playerA.id });
    expectRejected(
      '直连 robot:3005 GET /api/robots/list（R93：robot 的 10002 是本地常量，这条断言是它的集成层兜底）',
      robotListNoToken.status,
      robotListNoToken.body ?? {},
    );

    // ── 2) 错误的 token 也不得放行 ─────────────────────────────────
    step('第 2 步：直连带**错误**的 X-Internal-Token → 仍然 401 + 10002');
    const wrongToken = 'not-the-internal-token';

    const userMeWrong = await directJson(USER_URL, '/api/users/me', {
      headers: { authorization: `Bearer ${playerA.accessToken}` },
      internalToken: wrongToken,
    });
    expectRejected('直连 user:3001 GET /api/users/me（错误 token）', userMeWrong.status, userMeWrong.body ?? {});

    const roomListWrong = await directJson(ROOM_URL, '/api/rooms', {
      userId: playerA.id,
      internalToken: wrongToken,
    });
    expectRejected('直连 room:3002 GET /api/rooms（错误 token）', roomListWrong.status, roomListWrong.body ?? {});

    const gameViewWrong = await gameGetJson<unknown>(`/api/games/${roomCode}/state`, playerA.id, wrongToken);
    expectRejected(
      `直连 game:3003 GET /api/games/${roomCode}/state（错误 token）`,
      gameViewWrong.status,
      (gameViewWrong.body ?? {}) as ViewBody,
    );

    const robotListWrong = await directJson(ROBOT_URL, '/api/robots/list', {
      userId: playerA.id,
      internalToken: wrongToken,
    });
    expectRejected('直连 robot:3005 GET /api/robots/list（错误 token）', robotListWrong.status, robotListWrong.body ?? {});

    // ── 3) R87：/api/health 必须豁免 ───────────────────────────────
    step('第 3 步 R87：四个下游服务的 /api/health **不带** token 必须 200（healthcheck 是直连的）');
    info('这条防的是「加固把容器打成 unhealthy → 网关依赖它们 → 全线雪崩」，不是漏洞面。');
    const healths: Array<[string, string, string]> = [
      ['user:3001', USER_URL, 'user-service'],
      ['room:3002', ROOM_URL, 'room-service'],
      ['game:3003', GAME_URL, 'game-service'],
      ['robot:3005', ROBOT_URL, 'robot-service'],
    ];
    for (const [label, baseUrl, service] of healths) {
      const res = await directJson(baseUrl, '/api/health');
      const raw = (res.raw ?? {}) as { status?: string; service?: string };
      checks.eq(res.status, 200, `${label} /api/health（无 token）的 HTTP 状态`);
      checks.eq(raw.status, 'ok', `${label} /api/health 的 status`);
      checks.eq(raw.service, service, `${label} 该端口确实指向 ${service}`);
    }

    // ── 4) 内部路径仍可用：正确 token + 真实身份 → 200 ──────────────
    step('第 4 步：直连带**正确** token（+ X-User-Id: A）→ 200 —— 内部路径仍可用，不是「一律拒绝」');
    info(`内部 token 取 ${INTERNAL_TOKEN_HEADER}，默认值与 docker-compose.yml 的 INTERNAL_SERVICE_TOKEN 一致。`);

    const userMeOk = await directJson<{ id?: string; phone?: string }>(USER_URL, '/api/users/me', {
      headers: { authorization: `Bearer ${playerA.accessToken}` },
      internalToken: INTERNAL_TOKEN,
    });
    checks.eq(userMeOk.status, 200, '直连 user:3001 GET /api/users/me（正确 token）的 HTTP 状态');
    checks.eq(userMeOk.body?.code, ErrCode.OK, '直连 user:3001 GET /api/users/me 的 body.code');
    checks.eq(userMeOk.body?.data?.id, playerA.id, '直连 user:3001 拿到的就是 A 自己');

    const roomListOk = await directJson<unknown[]>(ROOM_URL, '/api/rooms', {
      userId: playerA.id,
      internalToken: INTERNAL_TOKEN,
    });
    checks.eq(roomListOk.status, 200, '直连 room:3002 GET /api/rooms（正确 token）的 HTTP 状态');
    checks.eq(roomListOk.body?.code, ErrCode.OK, '直连 room:3002 GET /api/rooms 的 body.code');
    checks.that(Array.isArray(roomListOk.body?.data), '直连 room:3002 的 data 是房间数组');

    const gameViewOk = await gameGetJson<unknown>(`/api/games/${roomCode}/state`, playerA.id, INTERNAL_TOKEN);
    const gameViewOkBody = (gameViewOk.body ?? {}) as ViewBody;
    info(`直连 /state（正确 token）原始响应：HTTP ${gameViewOk.status}，body=${JSON.stringify(gameViewOk.body)}`);
    checks.eq(gameViewOk.status, 200, '直连 game:3003 GET /api/games/<code>/state（正确 token）的 HTTP 状态');
    checks.that(
      isOkView(gameViewOk.status, gameViewOkBody),
      '直连 game:3003 返回的是 N6 的 §11.1 信封（`code === 0`，视图在 `data`）',
    );
    checks.eq(Number(viewOf(gameViewOkBody).seat), aSeat, '直连拿到的 seat 就是 A 自己的座位');
    checks.that(
      sameHand(viewOf(gameViewOkBody).hand, aHand),
      `直连拿到的 hand 与 A 的手牌逐张相等（实际 ${describe(viewOf(gameViewOkBody).hand)}，A=${describe(aHand)}）`,
    );

    const robotListOk = await directJson(ROBOT_URL, '/api/robots/list', {
      userId: playerA.id,
      internalToken: INTERNAL_TOKEN,
    });
    checks.eq(robotListOk.status, 200, '直连 robot:3005 GET /api/robots/list（正确 token）的 HTTP 状态');
    checks.that(Array.isArray(robotListOk.raw), '直连 robot:3005 返回的是机器人数组（该路由不是信封）');

    // ── 5) 外部伪造内部 token：网关边缘必须拒 ──────────────────────
    step('第 5 步：经网关请求业务路由并**自带** X-Internal-Token → 网关边缘必须拒绝，且不返回业务数据');
    info('对照组：同一条路由、同一个用户 token，**不带**该头时必须照常 200 —— 否则「拒绝」无从归因。');

    const gatewayControl = await getJson<unknown>(`/api/games/${roomCode}`, playerA.accessToken);
    const gatewayControlBody = (gatewayControl.body ?? {}) as ViewBody;
    info(`对照组（经网关，无内部 token）原始响应：HTTP ${gatewayControl.status}，body=${JSON.stringify(gatewayControl.body)}`);
    checks.eq(gatewayControl.status, 200, '对照组经网关 GET /api/games/<code> 的 HTTP 状态');
    checks.that(isOkView(gatewayControl.status, gatewayControlBody), '对照组的响应形状是 N6 的 §11.1 信封');
    checks.eq(Number(viewOf(gatewayControlBody).seat), aSeat, '对照组拿到的 seat 就是 A 自己的座位');
    checks.that(
      sameHand(viewOf(gatewayControlBody).hand, aHand),
      `对照组拿到的 hand 与 A 的手牌逐张相等（实际 ${describe(viewOf(gatewayControlBody).hand)}，A=${describe(aHand)}）`,
    );

    const forged = await getJson<unknown>(`/api/games/${roomCode}`, playerA.accessToken, {
      [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
    });
    const forgedBody = (forged.body ?? {}) as ViewBody;
    info(`伪造内部 token 原始响应：HTTP ${forged.status}，body=${JSON.stringify(forged.body)}`);
    checks.that(
      forged.status === 401 || forged.status === 403,
      `经网关自带 X-Internal-Token 的 HTTP 状态必须是 401/403（实际 ${forged.status}）`,
    );
    checks.that(
      forgedBody.code === ErrCode.UNAUTHENTICATED || forgedBody.code === ErrCode.FORBIDDEN,
      `经网关自带 X-Internal-Token 的错误码必须是 10002/10003（实际 ${String(forgedBody.code)}）`,
    );
    checks.that(
      viewOf(forgedBody).seat === undefined && viewOf(forgedBody).hand === undefined,
      '被拒响应里既没有 seat 也没有 hand（不返回任何业务数据）',
    );
    checks.that(
      !JSON.stringify(forged.body ?? null).includes(roomCode),
      `被拒响应里不得出现房间号 ${roomCode}（不返回任何业务数据）`,
    );

    // ── 6) N20/P4：被 TCP 取代的**内部 HTTP 路由**必须整条消失（R218）───────
    step(
      '第 6 步 N20/P4（R218）：被删的内部路由直连 3003/3005 ⇒ **404**（证明边界是「路由不存在」，' +
        '不是「401 放行」或「参数校验拦住」）',
    );
    info('⚠️ 本步**保留**第 1/2/4 步的全部既有直连断言（`GET /api/games/<code>/state` 与');
    info('   `GET /api/robots/list` 这两条路由**没被删**，N4/N7 的边界仍在）—— 这里是**新增**，不是替换。');
    info('旧栈 RED 原文（2026-09-16 实测、主检出容器）：');
    info('   direct3003 POST /api/games（**合法 body**）→ 201 {"code":0,"data":{"roomCode":…}}');
    info('   direct3003 GET  /api/games/<code>/snapshot  → 200 + 完整会话（含三家 hand）');
    info('   direct3005 POST /api/robots/acquire          → 200 {"bots":[…]}；release → 200；decide → 500');
    info('⚠️ `POST /api/games` 必须用**合法 body**：空 body 在旧栈上只得 DTO 的 400，那不是「路由已删」的证据。');

    const removedRoom = 'B72RPC';
    const removedStartBody = {
      roomCode: removedRoom,
      baseScore: 100,
      players: [0, 1, 2].map((seat) => ({ id: playerA.id, seat, isRobot: false })),
    };
    const removed: Array<[string, string, 'GET' | 'POST', string, unknown]> = [
      ['game:3003', GAME_URL, 'POST', '/api/games', removedStartBody],
      ['game:3003', GAME_URL, 'GET', `/api/games/${removedRoom}/snapshot`, undefined],
      ['robot:3005', ROBOT_URL, 'POST', '/api/robots/acquire', { roomCode: removedRoom, seats: [1] }],
      ['robot:3005', ROBOT_URL, 'POST', '/api/robots/release', { roomCode: removedRoom, botIds: [] }],
      ['robot:3005', ROBOT_URL, 'POST', '/api/robots/decide', { roomCode: removedRoom }],
    ];
    for (const [label, baseUrl, method, path, body] of removed) {
      const res = await directRaw(baseUrl, method, path, body);
      info(`${label} ${method} ${path}（正确内部 token）→ HTTP ${res.status}，body=${res.text.slice(0, 140)}`);
      checks.eq(res.status, 404, `${label} ${method} ${path} 的 HTTP 状态（R218：这条内部路由整条删除）`);
      checks.that(
        !res.text.includes('"code":10001') && !res.text.includes('Internal server error'),
        `${label} ${method} ${path} 的 404 不得是 DTO 校验错误（10001）或 500 的伪装 —— body 原文见上`,
      );
    }
    // 正对照（R115）：**保留**的那条服务间/对外路由仍然可达 —— 否则「全站 404」也会让上面五条假绿。
    const keptView = await gameGetJson<unknown>(`/api/games/${roomCode}/state`, playerA.id, INTERNAL_TOKEN);
    checks.eq(
      keptView.status,
      200,
      '正对照：`GET /api/games/<code>/state` 直连仍然 200（R218 只删内部面，对外/网关面逐字保留）',
    );
    const keptBots = await directJson(ROBOT_URL, '/api/robots/list', {
      userId: playerA.id,
      internalToken: INTERNAL_TOKEN,
    });
    checks.eq(keptBots.status, 200, '正对照：`GET /api/robots/list` 直连仍然 200（同 R218 的「留」清单）');

    return checks;
  } finally {
    for (const client of clients) client.close();
  }
}
