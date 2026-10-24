/**
 * 切片 8 conformance：叫抢地主（玩法 §2/§3/§9 + 主规格 §6.4）。
 *
 * 主线是「**1 抢 + 2 不抢**」这一条真实链路，判别力来自四组断言：
 *  1. **`grabActions` 按「决策次数」计**（玩法 §3.1 的 ⚠️）：若误读为「抢的次数」，
 *     这条链路会永不结束（grabActions=1 < 3 且 bidPasses=2 < 3）⇒ 用例超时；
 *  2. **底牌并入地主手牌**（C15/R101）：地主 `hand.length === 20`、两农民 17、
 *     且 `bottomCards ⊆ 地主 hand`；同时三家 `hand.length === cardCounts[seat]`
 *     （协议不变式，三个改动哪一个漏了都会在这里红）；
 *  3. **倍数**：1 次「抢」⇒ `bidMultiplier === 2`（上限 8 的边界另有单测，见 shared/bid.test.ts）；
 *  4. **叫抢结束的收口**：`state === 'playing'`、`landlordSeat` = 抢者的座位、
 *     `bidPhase.landlordCandidate` 同一值、`currentPlayer` = 地主。
 *
 * 片① R2 追加（规格 §8）：上面的主线是**1 声称** ⇒ 第 3 拍即收口 ⇒ 反抢**永不触发** ——
 * 本片唯一新增分支的在线判据为零。故文件尾另有「**2 声称 ⇒ 第 4 拍（反抢）**」三组：
 *   A. 反抢者不抢 ⇒ 末位声称者为地主，且本轮**必须结束**；
 *   B. 反抢者抢 ⇒ 反抢者为地主（3 次声称 ⇒ 倍数 8 —— 它**恰好等于 CAP**，
 *      本条只抓「多翻一次 → 16」，**抓不到截断本身**；4 次声称的 CAP 边界见 `shared` 单测 #7）；
 *   C.（片① 修复轮）「不叫/叫/叫」⇒ 第 4 拍行动者 = **首个声称者** —— 唯一能在线判别
 *      「反抢派发用 `(playerIdx+1)%3` 指错人」的形状（A/B 的形状下两公式**同值**，判别不了）。
 *
 * ⚠️ 陷阱一：`assertNoLeak()` 的黑名单含 `players`，而 `room.join` 的 ack **合法地**带
 * `data.players: RoomPlayer[]`（§6.3）⇒ **不得**对它调用 `assertNoLeak()`（与切片 7 同一条陷阱）。
 * 本用例只对 `game.deal` / `game.state_update` 的 `PlayerView` 载荷做泄漏检查。
 *
 * ⚠️ 陷阱二：推送的线格式是 `{ version, payload }`（§6.2 信封），
 * 所以叫抢状态要从 `message.payload.state` / `message.payload.bidPhase.currentBidder` 读，
 * **不是** `message.state`。
 */
import { ErrCode, type Card } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { registerUser } from '../lib/http';
import { HarnessClient } from '../lib/client';
import { redisCli } from '../lib/redis';

/**
 * 出站线格式的 `PlayerView`（§6.4）。只声明本用例真正读的字段。
 *
 * ⚠️ **R696：不再自己抄一份 `hand` 的形状** —— 抄的那份会在契约变化时静默过期
 * （本文件此前抄的是 `number[]`）。要么用 `lib/ddz-driver.ts` 的 `PlayViewWire`，
 * 要么像这里一样**直接引用 `PlayerView`**。
 */
interface PlayerViewWire {
  roomCode: string;
  version: number;
  state: 'init' | 'bidding' | 'playing' | 'ended';
  seat: number;
  hand: Card[];
  cardCounts: [number, number, number];
  bottomCards: Card[] | null;
  landlordSeat: number | null;
  currentPlayer: number;
  bidPhase: {
    currentBidder: number;
    bidMultiplier: number;
    landlordCandidate: number;
    grabActions: number;
    redealCount: number;
  };
}

const STEP_TIMEOUT_MS = 8000;
const MATCH_TIMEOUT_MS = 25_000;

/** 「取一局」的返回：主流程与反例流程共用同一套形状（DRY）。 */
interface FreshRoom {
  roomCode: string;
  clients: HarnessClient[];
  /** seat → client，用于「轮到谁就叫谁说话」。 */
  bySeat: Map<number, HarnessClient>;
  /** client → seat，用于反例里选一个「不是当前叫抢者」的客户端。 */
  seatOf: Map<HarnessClient, number>;
  /** 三家各自的发牌视图（叫抢起点）。 */
  deals: PlayerViewWire[];
}

/**
 * 起一局真实的三人对局：入队 → `room.matched` → `room.join` → 等 `game.deal`。
 *
 * ⚠️ 每次调用都必须用**新的三个账号**：同账号再次 `room.match` 会撞 `12009`，
 * 再次 `room.join` 同一房间会撞 `12004`（切片 7 的 R63 / 12009 语义）。
 * `registerUser(index)` 每次都用「时间戳 + 随机数」拼手机号，因此复用同一个 index 是安全的。
 */
async function startFreshRoom(labelPrefix: string): Promise<FreshRoom> {
  // R156：`clients` 必须在 `try` **之外**声明，catch 才够得着它（否则 TS2552）。
  const clients: HarnessClient[] = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const user = await registerUser(i);
      clients.push(await HarnessClient.connect(`${labelPrefix}${i}`, user));
    }
    for (const client of clients) {
      // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
      const ack = await client.send('room.match', { mode: 'random', baseScore: 15 });
      if (ack.code !== ErrCode.OK) throw new Error(`${client.label} room.match code=${ack.code}`);
    }
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', MATCH_TIMEOUT_MS)));
    const roomCode = matched[0]!.payload.roomCode as string;

    const bySeat = new Map<number, HarnessClient>();
    const seatOf = new Map<HarnessClient, number>();
    for (const [i, client] of clients.entries()) {
      const seat = matched[i]!.payload.seat as number;
      bySeat.set(seat, client);
      seatOf.set(client, seat);
      const ack = await client.send('room.join', { roomCode });
      if (ack.code !== ErrCode.OK) throw new Error(`${client.label} room.join code=${ack.code}`);
    }

    const dealMsgs = await Promise.all(clients.map((c) => c.waitFor('game.deal', MATCH_TIMEOUT_MS)));
    return {
      roomCode,
      clients,
      bySeat,
      seatOf,
      deals: dealMsgs.map((m) => m.payload as PlayerViewWire),
    };
  } catch (err) {
    // R156：**失败路径也必须收干净**。此前这里抛出时，已经连上的 client 既不在 `rooms` 数组里
    // （`room2` 还没赋值 ⇒ 外层 finally 够不着），也没被关掉 ⇒ socket 吊住事件循环 ⇒
    // `run.js` 设了 `process.exitCode` 却**永不退出**，门禁会**永久卡住**（切片 7.2 实测卡了 19 分钟）。
    for (const client of clients) client.close();
    throw err;
  }
}

/**
 * 取该客户端**最近一次**收到的裁剪视图（同步，不等待）。
 *
 * 一次状态转移会向三家各发一份**同 version** 的 `PlayerView`（§6.2/§6.4），
 * 因此用任一方的最新视图取 `bidPhase.currentBidder` 与 `version` 都成立。
 *
 * ⚠️ 不要用 `game.deal` 里那次快照去算后续动作的 `baseVersion` —— 版本已经往前走了，会拿到 `13004`。
 */
function currentView(client: HarnessClient): PlayerViewWire {
  const latest = client.last('game.state_update') ?? client.last('game.deal');
  if (!latest) throw new Error(`尚未收到任何 game.* 推送（client=${client.label}）`);
  return latest.payload as PlayerViewWire;
}

/** 等一条 version **严格大于**给定值的裁剪视图。 */
async function waitForNewerVersion(client: HarnessClient, version: number): Promise<PlayerViewWire> {
  const msg = await client.waitFor(
    'game.state_update',
    STEP_TIMEOUT_MS,
    (m: any) => (m.payload as PlayerViewWire).version > version,
  );
  return msg.payload as PlayerViewWire;
}

/**
 * 等该客户端拿到**恰好** `version` 那一版裁剪视图（可能已经在 `received` 里）。
 *
 * 与 `waitForNewerVersion` 的区别是「等哪一版」：叫抢收口时三家必须比**同一个 version** 的
 * `cardCounts`，用「更新即可」会三家比到不同版本。
 */
async function waitForVersion(client: HarnessClient, version: number): Promise<PlayerViewWire> {
  const existing = [...client.received]
    .reverse()
    .find((r) => (r.message?.payload as PlayerViewWire | undefined)?.version === version);
  if (existing) return existing.message.payload as PlayerViewWire;
  const msg = await client.waitFor(
    'game.state_update',
    STEP_TIMEOUT_MS,
    (m: any) => (m.payload as PlayerViewWire).version === version,
  );
  return msg.payload as PlayerViewWire;
}

/**
 * 等三家都拿到**同一个** version（R177）。
 *
 * ⚠️ 为什么叫抢驱动必须有这一步：`waitForNewerVersion(actor, …)` 只保证**行动者**拿到了新版，
 * 而下一轮决定「谁说话」读的是 `currentView(clients[0]!)` —— 那是**另一条 socket**，
 * 它可能还停在上一版 ⇒ 会把 `game.bid` 发给**上一轮**的叫抢者 ⇒ `12003`
 * （`handleBid` 先查 `playerIdx !== bidPhase.currentBidder`）。
 * 切片 9 实测过一次同样的形态：`叫抢第 3/3 次决策：座位 1 game.bid(grab=false)：期望 0，实际 12003`。
 * 广播几乎同时到达时看不出问题（本片在 7.2 门禁里绿过），但它是**真竞态**。
 */
async function syncAll(room: FreshRoom, version: number): Promise<void> {
  await Promise.all(room.clients.map((c) => waitForVersion(c, version)));
}

/**
 * 片① R2：驱动**一次**叫抢决策 —— 行动者从**视图**读（`currentBidder`），
 * 返回（实际行动的座位, 决策后的新版视图）。
 *
 * ⚠️ 为什么不能写成「让座位 N 抢」：片① R1 之后起始座位是**随机**的
 * （`createSession` / `resetBidding` 都摇座位），写死座位的驱动会在 2/3 的局里
 * 把 `game.bid` 发给错的人 ⇒ `12003`。行动者**只能**问视图。
 */
async function bidOnce(
  room: FreshRoom,
  version: number,
  grab: boolean,
  checks: Checks,
  label: string,
): Promise<{ bidder: number; view: PlayerViewWire }> {
  // R177：读 `currentBidder` 之前先让**三家**都到这一版（`clients[0]` 落后一版会把
  // game.bid 发给上一轮的叫抢者 ⇒ `12003`）。
  await syncAll(room, version);
  const bidder = currentView(room.clients[0]!).bidPhase.currentBidder;
  const actor = room.bySeat.get(bidder);
  if (!actor) {
    throw new Error(`currentBidder=${bidder} 没有对应客户端（座位集合 ${[...room.bySeat.keys()].join(',')}）`);
  }
  const ack = await actor.send('game.bid', { grab }, version);
  checks.eq(ack.code, ErrCode.OK, `${label}：座位 ${bidder} game.bid(grab=${grab}) code`);
  const view = await waitForNewerVersion(actor, version);
  assertNoLeak(view, `${label}：game.state_update(v${view.version})`);
  return { bidder, view };
}

/**
 * 片① R2 反抢组的**共同前缀**（规格 §8）：默认形状是前两拍「抢」、第三拍「不抢」。
 *
 * 「2 声称」的机械形态 ⇒ 第 3 拍后本轮**不得**收口 —— 反抢帧必须把行动者派发给
 * **首个声称者**（§4.2 ①）。旧实现（无反抢）在第 3 拍就 `playing`，前缀里的
 * `bidding` 断言会立刻红。
 *
 * ⚠️ `grabs` 是**参数化**的叫抢模式（片① 修复轮 R2-C），**不得**复制第二份前缀逻辑：
 * 默认形状 `[true, true, false]` 里「首个声称者」**恰好**等于 `(拍3+1)%3`（起点即声称者）
 * ⇒ **判别不了**「用 `(playerIdx+1)%3` 派发反抢」的错实现（两公式同值）；
 * 判别样本是 「不叫/叫/叫」= `[false, true, true]`（`bid.ts:93-96` 点名的形态）。
 */
async function twoClaimPrefix(
  room: FreshRoom,
  checks: Checks,
  label: string,
  grabs: readonly [boolean, boolean, boolean] = [true, true, false],
): Promise<{
  version: number;
  view: PlayerViewWire;
  firstCaller: number;
  lastCaller: number;
  /** 三拍的决策者座位（按拍序）—— 修复轮新增，供「错误公式会指向谁」的判别断言用。 */
  decisionSeats: number[];
}> {
  const claimers: number[] = [];
  const decisionSeats: number[] = [];
  let version = room.deals[0]!.version;
  let view = room.deals[0]!;

  for (const [i, grab] of grabs.entries()) {
    const outcome = await bidOnce(room, version, grab, checks, `${label} 第 ${i + 1} 拍`);
    decisionSeats.push(outcome.bidder);
    if (grab) claimers.push(outcome.bidder);
    version = outcome.view.version;
    view = outcome.view;
    checks.eq(view.state, 'bidding', `${label}：第 ${i + 1} 拍后仍在叫抢（3 拍走完不得收口）`);
  }

  const firstCaller = claimers[0]!;
  const lastCaller = claimers[1]!;
  checks.eq(view.bidPhase.grabActions, 3, `${label}：grabActions = 3（前缀走满 3 次决策）`);
  checks.eq(view.bidPhase.landlordCandidate, lastCaller, `${label}：landlordCandidate = 末位声称者`);
  checks.eq(view.bidPhase.currentBidder, firstCaller, `${label}：反抢帧行动者 = 首个声称者座位（§4.2 ①）`);
  return { version, view, firstCaller, lastCaller, decisionSeats };
}

/**
 * 片① 修复轮 R2-C：从 **Redis 的会话真源**（`game:session:{roomCode}`，§10.2）**只读**
 * 探一次内部标志 `bidPhase.antiRobGranted`。
 *
 * ⚠️ **为什么必须走内部探针**：`firstCaller` / `antiRobGranted` **永不出站**
 * （规格 §5.4 —— `PlayerView.bidPhase` 的子层键集穷尽判据钉住了这一点）⇒
 * 客户端视角**原理上**读不到它。本探针只**读**、不做任何写（与 slice-11 文件头
 * 「海森堡」同款纪律：§9.8 管的是「下发给客户端的消息」，内部键正是客户端拿不到的）。
 *
 * ⚠️ **时序安全**：`finishTransition` 先 `saveSession`（await `SET`）**再**推送 ⇒
 * 调用方等到的 state_update 落地时，Redis 里这一版必然已写完。
 */
function internalAntiRobGranted(roomCode: string): boolean {
  const raw = redisCli(['GET', `game:session:${roomCode}`]).trim();
  if (!raw) {
    throw new ConformanceError(
      `game:session:${roomCode} 不存在 —— 前缀等到的推送本应保证这一版已落盘（探针/时序有问题，不是被测缺陷）`,
    );
  }
  const session = JSON.parse(raw) as { bidPhase?: { antiRobGranted?: boolean } };
  return session.bidPhase?.antiRobGranted === true;
}

export async function runSlice08(): Promise<Checks> {
  const checks = new Checks();
  const rooms: FreshRoom[] = [];

  try {
    step('起第 1 局（3 个新账号 → 匹配 → join → game.deal）');
    const room = await startFreshRoom('P');
    rooms.push(room);
    const { clients, bySeat, roomCode } = room;
    checks.that(bySeat.size === 3, `三人成局且座位号互不相同，roomCode = ${roomCode}`);

    step('叫抢阶段：底牌恒 null、每家 17 张、无地主（§6.4 / 玩法 §2）');
    for (const [i, view] of room.deals.entries()) {
      assertNoLeak(view, `game.deal(P${i})`);
      checks.eq(view.state, 'bidding', `P${i} 发牌后状态`);
      checks.eq(view.bottomCards, null, `P${i} 叫抢阶段底牌不可见（§6.4）`);
      checks.eq(view.hand.length, 17, `P${i} 发牌手牌张数`);
      checks.eq(view.hand.length, view.cardCounts[view.seat], `P${i} hand.length === cardCounts[seat]`);
      checks.eq(view.landlordSeat, null, `P${i} 叫抢阶段无地主`);
    }

    step('按**服务端给的顺序**叫抢：1 抢 + 2 不抢（grabActions 按决策次数计，玩法 §3.1）');
    let version = room.deals[0]!.version;
    const grabs = [true, false, false];
    let grabSeat = -1;

    for (let round = 0; round < 3; round += 1) {
      // R177：读下一轮的 `currentBidder` 之前，先让**三家**都到这一版 ——
      // `clients[0]` 落后一版时会把 game.bid 发给上一轮的叫抢者（12003）。
      await syncAll(room, version);
      const bidder = currentView(clients[0]!).bidPhase.currentBidder;
      const actor = bySeat.get(bidder);
      if (!actor) {
        throw new Error(`currentBidder=${bidder} 没有对应客户端（座位集合 ${[...bySeat.keys()].join(',')}）`);
      }

      const grab = grabs[round]!;
      if (grab) {
        grabSeat = bidder;
      }

      const ack = await actor.send('game.bid', { grab }, version);
      checks.eq(ack.code, ErrCode.OK, `座位 ${bidder} game.bid(grab=${grab}) code`);

      const next = await waitForNewerVersion(actor, version);
      assertNoLeak(next, `game.state_update(round ${round})`);
      version = next.version;

      if (round < 2) {
        // 这一条就是「grabActions 按决策次数计」的判别点：1 抢 + 1 不抢 之后必须是 2。
        checks.eq(next.state, 'bidding', `第 ${round + 1} 次决策后仍在叫抢`);
        checks.eq(next.bidPhase.grabActions, round + 1, `grabActions = 已完成决策次数（第 ${round + 1} 次）`);
        checks.eq(next.bidPhase.bidMultiplier, 2, `1 次「抢」⇒ 倍数 2（第 ${round + 1} 次决策后）`);
      } else {
        // ── 收口：地主确定（C15 的核心判据段）──────────────────────────
        checks.eq(next.state, 'playing', '第 3 次决策后进入出牌阶段');
        checks.eq(next.bidPhase.grabActions, 3, 'grabActions = 3（一轮走满）');
        checks.eq(next.bidPhase.landlordCandidate, grabSeat, 'landlordCandidate = 抢者座位（§3.4-3）');
        checks.eq(next.landlordSeat, grabSeat, 'landlordSeat = 抢者座位');
        checks.eq(next.currentPlayer, grabSeat, 'currentPlayer = 地主（§3.4-6）');
        checks.eq(next.bidPhase.bidMultiplier, 2, '倍数 = 2（上限 8 的边界由 shared 单测覆盖）');
        checks.that(
          Array.isArray(next.bottomCards) && next.bottomCards.length === 3,
          `playing 后 bottomCards 可见且为 3 张：${JSON.stringify(next.bottomCards)}`,
        );
        /**
         * ⚠️ 这里此前是 `as number[]`（spec §3.5-A 记的**类型断言绕过**）。
         * 那个断言一次性遮住了**两个**缺陷：
         *  ① `.sort((a, b) => a - b)` 对 `Card` 是 `NaN` ⇒ 排序静默失效；
         *  ② `bottom` 被标成 `number[]`，于是下游的 `hand.includes(c)` 类型检查通过
         *     —— 而它对 `Card` 是**引用相等**，恒 false。
         * 换言之：**一个 `as` 关掉了编译器正好该管的那两点。**
         */
        const bottom = [...(next.bottomCards as Card[])].sort((a, b) => a.r - b.r || a.s - b.s);

        // 每家都拿同一套真相：地主 20 / 农民 17，且地主 hand 真的含底牌（C15/R101）
        for (const client of clients) {
          const latest = await waitForVersion(client, version);
          assertNoLeak(latest, `playing 视图(${client.label})`);
          const seat = latest.seat;
          const isLandlord = seat === grabSeat;
          checks.eq(latest.hand.length, isLandlord ? 20 : 17, `${client.label}(seat ${seat}) 手牌张数`);
          checks.eq(latest.hand.length, latest.cardCounts[seat], `${client.label} hand.length === cardCounts[seat]`);
          checks.eq(latest.cardCounts[grabSeat], 20, `${client.label} 看到的地主张数 = 20`);
          for (const s of [0, 1, 2]) {
            if (s === grabSeat) continue;
            checks.eq(latest.cardCounts[s], 17, `${client.label} 看到的农民(seat ${s})张数 = 17`);
          }
          if (isLandlord) {
            for (const c of bottom) {
              /**
               * ⚠️ **不得用 `latest.hand.includes(c)`** —— `Card` 是对象，`includes`
               * 做的是**引用相等**；而 `bottom` 与 `latest.hand` 来自**不同的 JSON 负载**
               * （线上各自解析出各自的对象）⇒ **恒 false**，这条判据会无条件失败。
               *
               * 这是本片第三次撞上同一类缺陷（前两处：`shared/ddz/play.ts` 的
               * `indexOf`、`mock-server` 的 `indexOf`）—— **对牌做引用相等**
               * 是 R696 之后最容易踩的一类坑，`tsc` 对它完全沉默。
               */
              if (!latest.hand.some((h) => h.r === c.r && h.s === c.s)) {
                throw new Error(
                  `${client.label} 地主手牌缺少底牌 ${JSON.stringify(c)}：hand=${JSON.stringify(latest.hand)}（C15 未并入）`,
                );
              }
            }
            checks.ok(
              `${client.label} 是地主：20 张，且底牌 ${bottom.map((c) => `${c.r}-${c.s}`).join(',')} 全部在 hand 内（C15/R101）`,
            );
          }
        }

        // 反例 A：叫抢已结束，抢者自己再发 game.bid ⇒ 13001（不是 0、也不是 500）
        const late = await actor.send('game.bid', { grab: true }, version);
        checks.eq(late.code, ErrCode.ILLEGAL_ACTION, 'playing 后再叫抢的 code');
        // 反例 B：**另一个座位**在 playing 阶段叫抢 —— 同样必须被拒
        const other = clients.find((c) => c !== actor)!;
        const otherAck = await other.send('game.bid', { grab: true }, version);
        checks.eq(otherAck.code, ErrCode.ILLEGAL_ACTION, 'playing 阶段另一座位再叫抢的 code');
      }
    }

    step('反例：非当前叫抢者抢 ⇒ 12003，且被拒的动作不推进 version / currentBidder / grabActions');

    // ⚠️ R155（§5.4 / R141）：切片 7.2 给网关加了「**单 IP 并发 WebSocket 连接 5**」的上限，而本用例
    // 此前会**同时**开着 P 房 3 条 + Q 房 3 条 = **6 条**（同一 IP）⇒ 第 6 条会在握手**之后**被拒
    // （`system.error {10006}` + `disconnect`），于是 `room.match` 永远等不到 ack（`code=-1`）。
    // 限额是规格（§5.4 逐字 5），因此**改用例**而不是放宽限额：开 Q 房前先关掉 P 房的客户端，
    // 并静置 400ms 等 `disconnect` 触发的 `ZREM` 落地（否则仍是与清理赛跑的竞态）。
    for (const client of clients) client.close();
    await sleep(400);

    const room2 = await startFreshRoom('Q');
    rooms.push(room2);
    const bidder2 = currentView(room2.clients[0]!).bidPhase.currentBidder;
    const wrong = room2.clients.find((c) => c !== room2.bySeat.get(bidder2))!;
    info(`room2 当前叫抢者 = 座位 ${bidder2}，用座位 ${room2.seatOf.get(wrong)} 的客户端去抢`);
    const before = currentView(room2.clients[0]!);
    const badAck = await wrong.send('game.bid', { grab: true }, before.version);
    checks.eq(badAck.code, ErrCode.NOT_YOUR_TURN, '非当前叫抢者 game.bid 的 code');

    // 反向断言（R68：不能只用 waitFor 证明「没发生」）：正向等一段静默窗，再断言状态原封不动。
    await sleep(300);
    const after = currentView(room2.clients[0]!);
    checks.eq(after.version, before.version, '被拒的动作不推进 version（叫抢仍需 baseVersion CAS）');
    checks.eq(after.bidPhase.currentBidder, bidder2, '被拒的动作不推进 currentBidder');
    checks.eq(after.bidPhase.grabActions, before.bidPhase.grabActions, '被拒的动作不增加 grabActions');
    checks.eq(after.state, 'bidding', '被拒之后对局仍在叫抢阶段');

    // 该局已被"叫过半次"但未推进 ⇒ 直接结束（不继续打完，避免影响 30s 窗口内的其它用例）
    info(`room1=${roomCode} room2=${room2.roomCode}：两局都只用于叫抢断言，不再继续出牌`);

    // ── 片① R2：2 声称 ⇒ 第 4 拍（反抢）──────────────────────────────────
    // 本片唯一新增分支的**在线**判据（规格 §8）：上面的既有场景全是「1 声称」⇒ 第 3 拍即收口，
    // 反抢永不触发。三组共用同一前缀 `twoClaimPrefix`（2 声称），只在第 4 拍分叉：
    //   A. 反抢者**不抢** ⇒ 末位声称者为地主，且本轮**必须结束**（抓「收口判据不终止」的洞）；
    //   B. 另起一局，反抢者**抢** ⇒ 反抢者为地主（3 次声称 ⇒ 8；
    //      4 次声称的 CAP 边界见 shared 单测 #7 —— 这里的 8 抓不到截断本身）；
    //   C.（修复轮）「不叫/叫/叫」⇒ 第 4 拍行动者 = 首个声称者（起点 ≠ 首个声称者的判别形状）。
    // ⚠️ R155：开新局前先关掉上一局（单 IP 并发 WS 上限 5），静置 400ms 等 `disconnect` 的 ZREM 落地。
    for (const client of room2.clients) client.close();
    await sleep(400);

    step('片① R2-A：2 人声称 ⇒ 第 4 拍反抢，反抢者不抢 ⇒ 末位声称者为地主（本轮必须结束）');
    const room3 = await startFreshRoom('R');
    rooms.push(room3);
    const prefixA = await twoClaimPrefix(room3, checks, '反抢组 A');
    const antiPass = await bidOnce(room3, prefixA.version, false, checks, '反抢组 A 第 4 拍（反抢者不抢）');
    checks.eq(antiPass.bidder, prefixA.firstCaller, '反抢组 A：第 4 拍的决策者 = 首个声称者（反抢权）');
    checks.eq(
      antiPass.view.state,
      'playing',
      '反抢组 A：反抢者不抢 ⇒ 本轮**必须结束**（收口判据对决策计数单调，§4.2 ②）',
    );
    checks.eq(antiPass.view.bidPhase.grabActions, 4, '反抢组 A：grabActions = 4（本轮走满 4 次决策）');
    checks.eq(antiPass.view.bidPhase.landlordCandidate, prefixA.lastCaller, '反抢组 A：landlordCandidate = 末位声称者');
    checks.eq(antiPass.view.landlordSeat, prefixA.lastCaller, '反抢组 A：地主 = 末位声称者（规格 §8）');
    checks.eq(antiPass.view.currentPlayer, prefixA.lastCaller, '反抢组 A：currentPlayer = 地主');
    checks.eq(antiPass.view.bidPhase.bidMultiplier, 4, '反抢组 A：倍数 = 4（反抢这一拍不抢，不贡献倍数）');
    for (const client of room3.clients) {
      const view = await waitForVersion(client, antiPass.view.version);
      assertNoLeak(view, `反抢组 A playing 视图(${client.label})`);
      checks.eq(
        view.hand.length,
        view.seat === prefixA.lastCaller ? 20 : 17,
        `反抢组 A：${client.label}(seat ${view.seat}) 手牌张数`,
      );
    }

    // 另起一局（前缀完全相同，只在第 4 拍分叉：反抢者抢）
    for (const client of room3.clients) client.close();
    await sleep(400);

    step('片① R2-B：反抢者抢 ⇒ 反抢者为地主（3 次声称 ⇒ 8；4 次声称的 CAP 边界见 shared 单测 #7）');
    const room4 = await startFreshRoom('S');
    rooms.push(room4);
    const prefixB = await twoClaimPrefix(room4, checks, '反抢组 B');
    const antiGrab = await bidOnce(room4, prefixB.version, true, checks, '反抢组 B 第 4 拍（反抢者抢）');
    checks.eq(antiGrab.bidder, prefixB.firstCaller, '反抢组 B：第 4 拍的决策者 = 首个声称者（反抢权）');
    checks.eq(antiGrab.view.state, 'playing', '反抢组 B：反抢者一抢本轮即收口（没有第 5 拍）');
    checks.eq(antiGrab.view.bidPhase.grabActions, 4, '反抢组 B：grabActions = 4（决策数上界，规格 §2）');
    checks.eq(antiGrab.view.bidPhase.landlordCandidate, prefixB.firstCaller, '反抢组 B：landlordCandidate = 反抢者');
    checks.eq(antiGrab.view.landlordSeat, prefixB.firstCaller, '反抢组 B：地主 = 反抢者（规格 §8）');
    checks.eq(antiGrab.view.currentPlayer, prefixB.firstCaller, '反抢组 B：currentPlayer = 地主');
    checks.eq(antiGrab.view.bidPhase.bidMultiplier, 8, '反抢组 B：倍数 = 8（3 次声称；§4.3 —— 不得变成 16）');
    for (const client of room4.clients) {
      const view = await waitForVersion(client, antiGrab.view.version);
      assertNoLeak(view, `反抢组 B playing 视图(${client.label})`);
      checks.eq(
        view.hand.length,
        view.seat === prefixB.firstCaller ? 20 : 17,
        `反抢组 B：${client.label}(seat ${view.seat}) 手牌张数`,
      );
    }

    // ── 片① 修复轮 R2-C：「不叫/叫/叫」—— 起点座位 ≠ 首个声称者 ──────────────
    // 🔴 为什么必须另起这个形状：A/B 用的「叫/叫/不叫」里，反抢派发的**错误**公式
    // `(playerIdx+1)%3` 指向第 1 拍（起点），而首拍**恰好就是**首个声称者 ⇒ 正确/错误
    // 两公式**同值**，A/B 对「指错人」全绿。而 `bid.ts:93-96` 点名的事故正是
    // 「指错人时规则违规静默通过、连错误码都没有」。
    // 「不叫/叫/叫」让两者分离：拍 1（起点）不叫 ⇒ 错误公式的目标（= 第 1 拍座位）
    // ≠ 首个声称者（= 第 2 拍座位）⇒ 本组是它**唯一**的在线判别器。
    // 行动者仍一律从视图读（`bidOnce` 内部即如此，无任何座位号假设）。
    // ⚠️ R155：开新局前先关掉上一局（单 IP 并发 WS 上限 5），静置 400ms 等 `disconnect` 的 ZREM 落地。
    for (const client of room4.clients) client.close();
    await sleep(400);

    step('片① 修复轮 R2-C：不叫/叫/叫 ⇒ 第 4 拍行动者 = 首个声称者（起点 ≠ 首个声称者的判别形状）');
    const room5 = await startFreshRoom('T');
    rooms.push(room5);
    const prefixC = await twoClaimPrefix(room5, checks, '反抢组 C', [false, true, true]);
    const seat1 = prefixC.decisionSeats[0]!;
    const seat2 = prefixC.decisionSeats[1]!;
    const seat3 = prefixC.decisionSeats[2]!;

    // 形状自查（判别力前提）：拍 1 = 起始座位且**不叫** ⇒ 首个声称者 = 拍 2；
    // 错误公式 `(拍3+1)%3` 指向拍 1 ⇒ 两目标在此形状**不同**（A/B 形状下恒相等）。
    checks.eq(seat1, room5.deals[0]!.bidPhase.currentBidder, '反抢组 C：第 1 拍 = 发牌视图的起始座位（该拍不叫）');
    checks.eq(prefixC.firstCaller, seat2, '反抢组 C：首个声称者 = 第 2 拍座位（起点不声称）');
    checks.eq((seat3 + 1) % 3, seat1, '反抢组 C：错误公式 (拍3+1)%3 的目标 = 第 1 拍座位（起点/不叫者）');
    checks.that(
      prefixC.firstCaller !== (seat3 + 1) % 3,
      `反抢组 C：判别力前提成立 —— 两公式目标不同（firstCaller = ${prefixC.firstCaller}，` +
        `错误公式指向 ${(seat3 + 1) % 3}；A/B 的形状下两者恒相等 ⇒ 判别不了）`,
    );

    // 🔴 「反抢帧已派发」的**直接**判据：`antiRobGranted` 永不出站（规格 §5.4 —— 出站视图的
    // 子层键集穷尽判据钉住）⇒ 从内部会话真源（`game:session:{roomCode}`，§10.2）只读探一次。
    checks.that(
      internalAntiRobGranted(room5.roomCode),
      '反抢组 C：反抢帧已派发（内部 antiRobGranted === true；该字段永不出站，经只读探针读得）',
    );

    const antiC = await bidOnce(room5, prefixC.version, false, checks, '反抢组 C 第 4 拍（反抢者不抢）');
    checks.eq(
      antiC.bidder,
      prefixC.firstCaller,
      '反抢组 C：第 4 拍行动者 = 首个声称者（§4.2 ①）——「用 (playerIdx+1)%3 派发」的实现**必红**',
    );
    checks.eq(antiC.view.state, 'playing', '反抢组 C：反抢者决策后本轮必须结束（§4.2 ②；state = playing）');
    checks.eq(antiC.view.bidPhase.grabActions, 4, '反抢组 C：grabActions = 4（本轮走满 4 次决策）');
    checks.eq(antiC.view.bidPhase.landlordCandidate, prefixC.lastCaller, '反抢组 C：landlordCandidate = 末位声称者');
    checks.eq(antiC.view.landlordSeat, prefixC.lastCaller, '反抢组 C：地主 = 末位声称者（反抢者不抢，§8）');
    checks.eq(antiC.view.currentPlayer, prefixC.lastCaller, '反抢组 C：currentPlayer = 地主');
    checks.eq(antiC.view.bidPhase.bidMultiplier, 4, '反抢组 C：倍数 = 4（2 次声称；反抢这一拍不抢不贡献）');

    return checks;
  } finally {
    for (const room of rooms) {
      for (const client of room.clients) client.close();
    }
  }
}
