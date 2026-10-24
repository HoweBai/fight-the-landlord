/**
 * 切片 7.2-P0 conformance：**视图座位归属**（偏差 S2 / S8 / N3）。
 *
 * 为什么必须单独一条用例：切片 7 的 §6.4 泄漏扫描只检查「**自己**收到的载荷里有没有
 * 黑名单字段」（`assertNoLeak`），**从没断言过「非成员读不到别人的座位」** ——
 * `GET /api/games/:roomCode?seat=<n>` 这条第二座位通道正是因此活到了今天。
 * 本用例补的判据是**归属**，不是字段名：
 *
 *   > A 用 `?seat=<B 的座位>` 拿到的 `seat` 必须 **等于 A 自己的座位**，
 *   > 且 `hand` 与 **A 自己的手牌逐张相等**（排序后比较，不依赖 DouZero 编码顺序）；
 *   > 唯一不可接受的结果是拿到 **B 的手牌**。
 *
 * 三条通道，四种进入方式（缺一条就漏一条）：
 *   第 3 步 S2 —— `GET /api/games/<code>?seat=<B>` 经网关（Express 解出的 query，网关**不转发**）；
 *   第 4 步 N3 —— `GET /api/games/<code>%3Fseat=<B>` 经网关（`%3F` 走私成下游 query）；
 *   第 5 步 S8 —— `GET /api/games/<code>/state?seat=<B>` **直连 game-service**（该路由不经网关）；
 *   第 5 步 S2/S8 —— `GET /api/games/<code>?seat=<B>` **直连 game-service**（`?seat=` 分支本身；
 *     经网关时永远到不了它，因为网关只转发路径、不转发客户端 query，见下方 ⚠️）。
 *
 * ⚠️ P1（`X-Internal-Token` 边界）之后，第 5 步的直连**必须带**内部 token（R96）：
 * 不带的话两条探针会被 10002 挡在中间件层，而 `checkChannel` 把「401 = 被拒」判为通过
 * ⇒ 用例仍绿但**对照证明没了**。因此第 5 步里既有「带 token ⇒ 200 自己视图」的非空断言，
 * 也有「不带 token ⇒ 401 + 10002」的边界断言。
 *
 * ⚠️ 第 3 步在**有漏洞的**镜像上也是绿的：网关不把客户端 query 转发给下游
 * （`gateway.controller.ts` 只插值 `req.params.roomCode`），所以 `?seat=` 的覆盖分支
 * 只有**直连**才碰得到。真正抓 S2/S8 的是第 4 步（走私）与第 5 步（直连）。
 *
 * ⚠️ 响应形状（N6 / R139 之后 = **§11.1 信封**）：`game.controller.ts` 的 `get()`/`getState()`
 * 返回 `{ code: 0, data: PlayerView }`，错误路径是 `{ code: <5 位>, message, data: null }`。
 * **修前**成功路径是**裸 `PlayerView`**（`body.code === undefined`、视图字段在顶层）⇒ 本文件
 * 的 N6 断言在未修镜像上**必然是红的** —— 那正是「判据有判别力」的负对照。
 * ⚠️ 造房路径与切片 7 相同（3 人 `room.match` → `room.matched` → `room.join` → `game.deal`），
 * 但**不复用**它的实现：conformance 的价值就在于各自独立可读、可单独跑。
 */
import { ErrCode, type PlayerView } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, info, step } from '../lib/assert';
import { gameGetJson, getJson, registerUser, INTERNAL_TOKEN, type HarnessUser } from '../lib/http';
import { HarnessClient } from '../lib/client';

/**
 * `GET /api/games/:roomCode`（及 `/state`）的响应形状（**N6 / R139 之后**）：
 *  - 成功：`{ code: 0, data: PlayerView }`（§11.1 信封）；
 *  - 失败：`{ code: <5 位错误码>, message, data: null }`（`toHttpException`）。
 *
 * **修前**：成功路径是**裸 `PlayerView`** ⇒ `body.code === undefined`、视图字段在**顶层**。
 * 因此 `isOkView()` 现在要求 `body.code === 0`（这正是 N6 的判据），视图字段一律读 `body.data`。
 */
interface ViewShape {
  seat?: number;
  hand?: unknown;
}

interface ViewBody {
  code?: number;
  data?: ViewShape | null;
}

/** 成功 = HTTP 200 且 §11.1 信封的 `code === 0`（修前：裸 PlayerView ⇒ `code` 是 undefined ⇒ false）。 */
function isOkView(status: number, body: ViewBody): boolean {
  return status === 200 && body.code === 0;
}

/** 把任意 HTTP 结果体当作信封读（直连助手与走网关的助手返回的泛型不同，统一在这里消解）。 */
function asView(res: { body?: unknown }): ViewBody {
  return (res.body ?? {}) as ViewBody;
}

/** 信封里的视图（没有 `data` 时给空对象，让下游断言给出「字段是 undefined」而不是抛异常）。 */
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
 * ⚠️ **R696 的关键修正**：旧实现是 `.map(Number).sort((a, b) => a - b)`。
 * 牌变成 `{r, s}` 之后 `Number({r,s})` = **`NaN`** ⇒ 排序结果恒为 `[NaN, NaN, …]`
 * ⇒ `JSON.stringify` 得 `"[null,null,…]"` ⇒ **任意两副同长度手牌都被判为「相等」**。
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

export async function runSlice072Security(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  let stranger: HarnessClient | undefined;

  try {
    // ── 1) 造出一个真实三人局，记下 A/B 的座位与手牌 ──────────────────
    step('准备 4 个真实账号 → 3 人匹配成局 → room.join ×3 → 各自收到 game.deal');
    const users: HarnessUser[] = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(i));
    for (let i = 0; i < 3; i += 1) clients.push(await HarnessClient.connect(`P${i}`, users[i]!));
    checks.ok('3 个客户端完成握手');

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

    for (const [i, client] of clients.entries()) {
      const ack = await client.send('room.join', { roomCode });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.join code`);
      checks.eq(ack.data?.seat, matched[i]!.payload.seat, `${client.label} ack.seat 与 room.matched 一致`);
    }

    const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
    const observerA = clients[0]!;
    const observerB = clients[1]!;
    const dealA = deals[0]!.payload as PlayerView;
    const dealB = deals[1]!.payload as PlayerView;
    assertNoLeak(dealA, 'game.deal(A)');
    assertNoLeak(dealB, 'game.deal(B)');

    const aSeatFromDeal = dealA.seat;
    const bSeatFromDeal = dealB.seat;
    info(
      `A(${observerA.label}) deal.seat=${aSeatFromDeal} deal.hand=${describe(dealA.hand)}；` +
        `B(${observerB.label}) deal.seat=${bSeatFromDeal} deal.hand=${describe(dealB.hand)}`,
    );
    checks.that(aSeatFromDeal !== bSeatFromDeal, `A/B 座位不同（A=${aSeatFromDeal}, B=${bSeatFromDeal}）`);
    // 判据要求 A_hand ≠ B_hand，否则「拿到 B 的手牌」无法与「拿到自己的」区分开
    checks.that(
      !sameHand(dealA.hand, dealB.hand),
      `A/B 手牌不同（否则本用例无判别力）`,
    );

    // ── 2) A 的权威快照（game.resync）作为参照真值 ────────────────────
    step('A 用 game.resync 取自己的权威快照，作为 seat/hand 的参照真值');
    const resyncA = await observerA.send('game.resync', {}, 0);
    checks.eq(resyncA.code, ErrCode.OK, 'A game.resync code');
    assertNoLeak(resyncA.data, 'A game.resync ack.data');
    const aSeat = Number(resyncA.data.seat);
    const aHand: number[] = resyncA.data.hand ?? [];
    checks.eq(aSeat, aSeatFromDeal, 'A 的权威 seat 与 game.deal 一致');
    checks.that(
      sameHand(aHand, dealA.hand),
      `A 的权威 hand 与 game.deal 一致（${describe(aHand)}）`,
    );
    info(`A_seat=${aSeat}，A_hand=${describe(aHand)}`);

    const bResync = await observerB.send('game.resync', {}, 0);
    checks.eq(bResync.code, ErrCode.OK, 'B game.resync code（第 7 步的对照真值）');
    const bSeat = Number(bResync.data.seat);
    const bHand: number[] = bResync.data.hand ?? [];
    checks.that(
      !sameHand(bHand, aHand),
      `B 的权威 hand 与 A 不同（否则第 2/4/5 步的失败无法归因）`,
    );
    info(`B_seat=${bSeat}，B_hand=${describe(bHand)}`);

    /**
     * 把「A 借 B 的座位／别人的手牌」统一判死。
     *
     * 判据两条（**任一不满足即失败**）：
     *  ① 返回的 `seat` 必须等于 A 自己的座位；
     *  ② 返回的 `hand` 必须与 A 自己的手牌逐张相等。
     * ②是对①的补强：只断言 `seat` 的话，一个「seat 字段照抄、hand 却按别人发」的实现也能过。
     */
    const assertBelongsToA = (label: string, view: ViewShape): void => {
      checks.eq(Number(view.seat), aSeat, `${label} 返回的 seat 必须是 A 自己的座位`);
      const leaked = sameHand(view.hand, bHand) && !sameHand(aHand, bHand);
      checks.that(!leaked, `${label} 的 hand **不得**等于 B 的手牌`);
      checks.that(
        sameHand(view.hand, aHand),
        `${label} 的 hand 与 A 自己的手牌逐张相等（实际 ${describe(view.hand)}，A=${describe(aHand)}，B=${describe(bHand)}）`,
      );
    };

    /**
     * 一条通道的统一判定：**要么**服务端就地拒绝（§11.2 的错误码，安全），
     * **要么**返回 A 自己的视图（`assertBelongsToA`）。
     * 两种之外的一切 —— 尤其「200 + B 的座位/手牌」—— 都是失败。
     *
     * ⚠️ N6：成功路径是 `{ code: 0, data: PlayerView }`，视图只从 `body.data` 读；
     * 错误路径的 `code` 仍在**顶层**。修前（裸 PlayerView）`isOkView` 直接为假
     * ⇒ 本判定退化成「被拒」分支，而 `body.data?.hand` 是 undefined ⇒ 用例红。
     */
    const checkChannel = (label: string, status: number, body: ViewBody): void => {
      info(`${label} 原始响应：HTTP ${status}，body=${JSON.stringify(body)}`);
      if (isOkView(status, body)) {
        assertBelongsToA(label, viewOf(body));
        return;
      }
      if (status === 200) {
        // ⚠️ N6 修前的形态：**200 + 裸 `PlayerView`**（视图字段在顶层、没有 `code`/`data`）。
        // 这里**必须**判红，而且**不得**把它说成「被拒」—— 那是一句假陈述，会掩盖真实越权载荷：
        // 修前 `?seat=<B>` 通道正是「200 + B 的 seat/hand」，把它读成「被拒」等于把 S2/S8 放走。
        // 先做一次泄漏检查（信息更全），再用形状断言收口。
        const bare = body as unknown as ViewShape;
        checks.that(
          !sameHand(bare.hand, bHand),
          `${label}（200 但非信封）也不得夹带 B 的手牌（实际 ${describe(bare.hand)}）`,
        );
        checks.that(
          false,
          `${label} 是 HTTP 200 但**不是** §11.1 信封（顶层 code=${String(body.code)}、data=${String(body.data)}）` +
            ` —— N6（R139）未落地，本用例**不得**把 200 的裸视图当成「被拒」蒙混过关`,
        );
        return;
      }
      const hand = viewOf(body).hand;
      checks.that(
        !sameHand(hand, bHand),
        `${label} 被拒时也不得夹带 B 的手牌（实际 ${describe(hand)}）`,
      );
      checks.ok(`${label} 请求被拒（HTTP ${status}, code=${String(body.code)}），未返回任何手牌`);
    };

    // ── 3) 核心反例（S2）：A 经网关带 ?seat=<B.seat> ──────────────────
    step(`核心反例 S2：A 经网关请求 GET /api/games/${roomCode}?seat=${bSeat}（携带 A 自己的 token）`);
    info('注意：网关只转发路径、不转发客户端 query，因此这一步在有漏洞的镜像上也会是绿的；');
    info('     真正抓 S2/S8 的是第 4 步（%3F 走私）与第 5 步（直连）。');
    const s2 = await getJson<unknown>(`/api/games/${roomCode}?seat=${bSeat}`, observerA.user.accessToken);
    checkChannel(`S2（经网关 ?seat=${bSeat}）`, s2.status, asView(s2));

    // ── 4) 走私反例（N3）：%3F 把 query 塞进路径参数 ──────────────────
    step(`走私反例 N3：A 经网关请求 GET /api/games/${roomCode}%3Fseat=${bSeat}（%3F 走私）`);
    const s8 = await getJson<unknown>(
      `/api/games/${roomCode}%3Fseat=${bSeat}`,
      observerA.user.accessToken,
    );
    const s8Body = asView(s8);
    info(`N3 原始响应：HTTP ${s8.status}，body=${JSON.stringify(s8.body)}`);
    if (typeof s8Body.code === 'number' && s8Body.code === ErrCode.BAD_PARAM) {
      // R75 期望的结局：网关按房间号形状白名单**就地**拒掉，不发起下游请求
      checks.ok(`N3 被网关以 10001 拒绝（房间号形状非法：${roomCode}%3Fseat=${bSeat}）`);
    } else if (isOkView(s8.status, s8Body)) {
      // 网关放行的话，唯一可接受的载荷仍是 A 自己的视图
      assertBelongsToA(`N3（经网关 %3Fseat=${bSeat}）`, viewOf(s8Body));
    } else {
      checks.that(
        !sameHand(viewOf(s8Body).hand, bHand),
        `N3 被拒时也不得夹带 B 的手牌（实际 ${describe(viewOf(s8Body).hand)}）`,
      );
      checks.ok(`N3 请求被拒（HTTP ${s8.status}, code=${String(s8Body.code)}），未返回任何手牌`);
    }

    // ── 5) 直连反例（S8）：/state 不经网关，?seat= 分支也只能直连覆盖 ──
    //
    // 注意这里**两条路由各测一次**，且都必须直连 game-service：
    //  ① `/state` 根本不在 §7.1 的网关路由表里（R77）；
    //  ② `GET /api/games/:roomCode?seat=` 的 `?seat=` 分支经网关时**永远到不了**
    //     —— 网关只转发路径、不转发客户端 query（实测），所以只有直连才碰得到它。
    //     这同时说明「第 3 步在漏洞版本上也是绿的」：网关的 query 剥离是既有行为，
    //     与 `?seat=` 是否被删除无关。因此真正抓 S2/S8 的是这两条直连断言。
    //
    // ⚠️ R96：P1 之后 game-service 的**全部业务路由**都校验 `X-Internal-Token`。
    // 直连时**必须带上正确的内部 token**（`INTERNAL_TOKEN`），否则：
    //   - 这两条探针会被 401 挡在中间件层，而 `checkChannel` 把「401 = 被拒」判为通过
    //     ⇒ 用例仍绿，但「直连读到的确实是 A 自己的视图」这条**对照证明**被静默抹掉。
    // 下面紧跟的 `isOkView(...)` 断言就是防止这种退化（对照组必须非空）。
    step(`直连反例 S8：GET /api/games/${roomCode}/state?seat=${bSeat} 直连 game-service（带 A 的 x-user-id + 内部 token）`);
    const stateDirect = await gameGetJson<unknown>(
      `/api/games/${roomCode}/state?seat=${bSeat}`,
      observerA.user.id,
      INTERNAL_TOKEN,
    );
    const stateDirectBody = asView(stateDirect);
    checkChannel(`S8（直连 /state?seat=${bSeat}）`, stateDirect.status, stateDirectBody);
    checks.that(
      isOkView(stateDirect.status, stateDirectBody),
      `对照组非空：带内部 token 的直连必须真的返回 A 自己的视图（N6 信封），` +
        `而不是被拒后靠「401 = 被拒」蒙混过关（HTTP ${stateDirect.status}, body=${JSON.stringify(stateDirect.body)}；R96）`,
    );

    step(`直连反例 S2/S8：GET /api/games/${roomCode}?seat=${bSeat} 直连 game-service（同一 @Query('seat') 分支）`);
    const viewDirect = await gameGetJson<unknown>(
      `/api/games/${roomCode}?seat=${bSeat}`,
      observerA.user.id,
      INTERNAL_TOKEN,
    );
    const viewDirectBody = asView(viewDirect);
    checkChannel(`S2/S8（直连 ?seat=${bSeat}）`, viewDirect.status, viewDirectBody);
    checks.that(
      isOkView(viewDirect.status, viewDirectBody),
      `对照组非空：带内部 token 的直连必须真的返回 A 自己的视图（HTTP ${viewDirect.status}, body=${JSON.stringify(viewDirect.body)}；R96）`,
    );

    step('服务间边界（N4/N7）：同一路由直连但**不带** X-Internal-Token → 必须 401 + 10002');
    info('这条与上一条互为对照：带 token ⇒ 200 自己视图；不带 token ⇒ 10002（P1 之前是 200，即漏洞）。');
    const noTokenDirect = await gameGetJson<unknown>(
      `/api/games/${roomCode}/state?seat=${bSeat}`,
      observerA.user.id,
      null,
    );
    const noTokenBody = asView(noTokenDirect);
    info(`直连不带内部 token 的原始响应：HTTP ${noTokenDirect.status}，body=${JSON.stringify(noTokenDirect.body)}`);
    checks.eq(noTokenDirect.status, 401, '直连不带 X-Internal-Token 的 HTTP 状态');
    checks.eq(noTokenBody.code, ErrCode.UNAUTHENTICATED, '直连不带 X-Internal-Token 的错误码（R88：必须是 10002）');
    checks.that(
      !sameHand(viewOf(noTokenBody).hand, bHand),
      `被拒响应里也不得夹带 B 的手牌（实际 ${describe(viewOf(noTokenBody).hand)}）`,
    );

    // ── 6) 非成员反例：不在房间的人连自己的视图都不该有 ───────────────
    step('非成员反例：第 4 个账号经网关 GET /api/games/<code> → 12004（HTTP 403）');
    stranger = await HarnessClient.connect('stranger', users[3]!);
    const none = await getJson<unknown>(`/api/games/${roomCode}`, stranger.user.accessToken);
    const noneBody = asView(none);
    info(`非成员原始响应：HTTP ${none.status}，body=${JSON.stringify(none.body)}`);
    checks.eq(none.status, 403, '非成员请求的 HTTP 状态');
    checks.eq(noneBody.code, ErrCode.NOT_IN_ROOM, '非成员请求的错误码');
    checks.that(viewOf(noneBody).hand === undefined, '非成员响应里没有 hand 字段（被拒时 `data` 为空）');

    // ── 6b) §4 的原始要求（P14 / R511）：**非本房 token + `%3F` 走私**的「组合」─────
    // §4 逐字：「用**非本房** token 请求 `GET /api/games/<code>%3Fseat=1`，断言 403 或只返回本方手牌。
    //           **在补上这条断言前，S2/S8 的修复无法证明有效。**」
    // ⚠️ P14 实测：第 4 步（`%3F`）用的是 **A 自己的** token、第 6 步（非成员）走的是**普通路径**
    //    ⇒ 这个**组合**此前**没有**被直接断言（`grep '%3F' tools/conformance/src` 只命中第 4 步）。
    //    两半各自被覆盖 **不能**推出组合成立（§4 的纪律：不许用「应该已经被覆盖了」结案）。
    step(
      `非成员 + 走私组合（§4）：stranger 经网关请求 GET /api/games/${roomCode}%3Fseat=${aSeat} → 必须被拒且不含任何手牌`,
    );
    const strangerSmuggle = await getJson<unknown>(
      `/api/games/${roomCode}%3Fseat=${aSeat}`,
      stranger.user.accessToken,
    );
    const strangerSmuggleBody = asView(strangerSmuggle);
    info(
      `非成员走私原始响应：HTTP ${strangerSmuggle.status}，body=${JSON.stringify(strangerSmuggle.body)}`,
    );
    // 两条可接受结局（与第 4 步同形）：① 网关房间号形状闸就地拒（10001）；
    // ② 走到路由层 ⇒ 非成员必须是 403 + 12004（**不是** 12001，也不是任何视图）。
    if (
      typeof strangerSmuggleBody.code === 'number' &&
      strangerSmuggleBody.code === ErrCode.BAD_PARAM
    ) {
      checks.ok('非成员走私被网关以 10001 拒绝（房间号形状非法，未发起下游请求）');
    } else {
      checks.eq(strangerSmuggle.status, 403, '非成员走私请求的 HTTP 状态');
      checks.eq(strangerSmuggleBody.code, ErrCode.NOT_IN_ROOM, '非成员走私请求的错误码（12004）');
    }
    checks.that(
      viewOf(strangerSmuggleBody).hand === undefined,
      '非成员走私响应里没有 hand 字段',
    );
    checks.that(
      !sameHand(viewOf(strangerSmuggleBody).hand, aHand) &&
        !sameHand(viewOf(strangerSmuggleBody).hand, bHand),
      `非成员走私响应里不得夹带 A 或 B 的手牌（实际 ${describe(viewOf(strangerSmuggleBody).hand)}）`,
    );

    // ── 7) 对照：B 自己请求同一路由必须仍然正常（证明用例不是空测） ────
    step('对照：B 自己经网关请求同一路由 → 拿到自己的 seat/hand（合法路径未被误伤）');
    const bSelf = await getJson<unknown>(`/api/games/${roomCode}`, observerB.user.accessToken);
    const bSelfBody = asView(bSelf);
    info(`B 自请求原始响应：HTTP ${bSelf.status}，body=${JSON.stringify(bSelf.body)}`);
    checks.eq(bSelf.status, 200, 'B 自己请求的 HTTP 状态');
    checks.that(isOkView(bSelf.status, bSelfBody), 'B 自己请求的响应是 N6 的 §11.1 信封（`code === 0`）');
    checks.eq(Number(viewOf(bSelfBody).seat), bSeat, 'B 自己拿到的 seat 就是 B 的座位');
    checks.that(
      sameHand(viewOf(bSelfBody).hand, bHand),
      `B 自己拿到的 hand 与 B 的手牌逐张相等（实际 ${describe(viewOf(bSelfBody).hand)}，B=${describe(bHand)}）`,
    );

    return checks;
  } finally {
    stranger?.close();
    for (const client of clients) client.close();
  }
}
