/**
 * 切片 10 conformance：结算（玩法 §8.1–§8.5 + 主规格 §6.3/§6.4/§6.7；关闭 N1/N17，判据 C1/C2/C3/C26）。
 *
 * 两个场景（各起一房，驱动方式与 slice-09 的场景 A/B 相同）：
 *  A（地主胜 + **春天**）—— 地主每墩首出最大单张、两农民**全程过牌** ⇒ `farmerPlays === 0`
 *     ⇒ `spring === 'spring'`（§8.3）⇒ 倍数 = `bidMultiplier(2) × 2^0 × 春天 2 = 4`（§8.2 **乘法**）。
 *  B（农民胜 + **反春**）—— 地主只首出过**一手**（`landlordPlays === 1`）就被某农民压过并连打
 *     ⇒ `spring === 'anti-spring'`（§8.3）⇒ 倍数同样 4。
 *
 * 这里断言的是**N1 的活体形态**：`game.settlement` 在未修栈上**整条被网关出站校验拦掉**
 * （`settle.ts` 的内部 `SettlementResult` 与契约同名不同形 ⇒ `validateOutbound` 抛
 * `$.payload.baseScore must be a finite number, got undefined`），客户端**只收到 `game.finished`**。
 * 因此本片在未修栈上的第一条 RED 必然是「等 game.settlement 超时」，**不是**「字段不对」——
 * 这正说明判据抓的是根因。（R193：把实际值拼进消息，让 RED 自证。）
 *
 * 断言集的四组：
 *  ① **N1**：三家**都**收到 `game.settlement`（`Promise.all` 三个 `waitFor`），载荷字段集**恰好** 9 个；
 *  ② **C1/C2/C3/C26**：`baseScore`（= 撮合时发的 `MATCH_BASE_SCORE`，Task 3e 起读真源） / `winner` / `landlordSeat`（座位号） / `farmerSeats` /
 *     `spring` / 倍数**乘法** / 分数字段逐条按 §8.4 / **守恒**；
 *  ③ **N17**：三家的终局 `state='ended'` 裁剪视图（同版本、胜者张数为 0、带 `winner`）、
 *     该快照**先于**结算到达、终局版**不发** `game.current_turn`（**带正对照**：上一版确实有）；
 *  ④ **逐手覆盖度硬断言**：地主 20 墩 / 农民 16 墩**逐手**都在线可观测（终局那一版补齐后；
 *     旧实现 19/20、15/16）。
 *
 * ⚠️ 判据纪律（R168/R176/R193）：**不** import `@fight-the-landlord/shared`（拿被测实现当裁判会
 * 让判据失去判别力）；**不**用 `Checks.eq` 比数组/对象（`!==` 永不相等）—— 数组一律
 * `JSON.stringify` 成字符串或用 `checks.that(...length === 0/…)`；断言「**没有**发生」之前先让
 * **正对照**证明探针能观测到「发生」。
 *
 * ⚠️ 驱动在 `../lib/ddz-driver`（R190①），节流/换房静置（R155/R175）都在那里。
 * ⚠️ `CONFORMANCE_STEPS=a|b` 逐步取 RED（`run.js` 是 fail-fast）；**门禁不带**该变量。
 */
import { Checks, ConformanceError, info, assertNoLeak, step, sleep } from '../lib/assert';
import type { HarnessClient } from '../lib/client';
import {
  MATCH_BASE_SCORE,
  MAX_TRICKS,
  STEP_TIMEOUT_MS,
  checkRecentWindow,
  currentView,
  deckValues,
  extremeByRank,
  firstView,
  lastPlay,
  handsInfo,
  passAndSync,
  passCurrent,
  playAndSync,
  playBiddingToPlaying,
  playFinalHand,
  smallestBeatingSingle,
  startFreshRoom,
  type FreshRoom,
  type PlayViewWire,
} from '../lib/ddz-driver';
import type { Card } from '@fight-the-landlord/protocol';

/**
 * 结算载荷的**唯一**合法字段集（玩法 §8.5 / 主规格 §6.3）。
 * 「多一个字段」与「少一个字段」都必须红 —— 这是 N1 的机械判据。
 */
const SETTLEMENT_KEYS = [
  'roomCode', 'baseScore', 'winner', 'landlordSeat', 'farmerSeats',
  'multiplier', 'spring', 'landlordScoreChange', 'farmerScoreChange',
];

interface SettlementWire {
  roomCode: string;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  farmerSeats: number[];
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number;
  farmerScoreChange: number;
}

const readView = (m: any): PlayViewWire => m.payload as PlayViewWire;

/** 某个 client 的 `received` 里第一条匹配消息的下标（**结构性**顺序判据，不依赖墙钟）。 */
function indexOfReceived(client: HarnessClient, type: string, pred: (message: any) => boolean): number {
  return client.received.findIndex((r) => r.type === type && pred(r.message));
}

/**
 * N1：三家**都**收到结算（旧实现 0 家）。
 *
 * `Promise.all` 里任一 `waitFor` 超时即抛 —— 这正是未修栈上的第一条 RED。
 */
async function receiveSettlements(room: FreshRoom, checks: Checks): Promise<any[]> {
  const settlements = await Promise.all(
    room.clients.map((c) => c.waitFor('game.settlement', STEP_TIMEOUT_MS)),
  );
  checks.eq(settlements.length, 3, '三家都收到 game.settlement（N1：旧实现 0 家，整条被网关出站校验拦掉）');
  const texts = settlements.map((m) => JSON.stringify(m.payload));
  checks.that(
    new Set(texts).size === 1,
    `三家收到的结算载荷逐字相同（§6.4 规则 8：结算由 game-service 产出、room-service 广播，不按座位裁剪）` +
      `：实际 ${texts.join(' | ')}`,
  );
  // §6.4 规则 4：actionLog / isRobot / botId / skillLevel / … 一个都不许有
  assertNoLeak(settlements[0]!.payload, 'game.settlement');
  return settlements;
}

/**
 * 结算载荷逐字段断言（C1/C2/C3/C26 + §8.4 守恒）。
 *
 * `finalView` 用**终局前那一版 playing 视图**：`bidPhase.bidMultiplier` / `playPhase.bombCount` /
 * `landlordSeat` 在结算发生前就已经定稿（本片全程单张 ⇒ `bombCount === 0`）。
 */
function checkSettlement(
  raw: unknown,
  room: FreshRoom,
  finalView: PlayViewWire,
  expectedWinner: 'landlord' | 'farmer',
  expectedSpring: 'spring' | 'anti-spring',
  checks: Checks,
): SettlementWire {
  const s = raw as SettlementWire;
  const keys = Object.keys(s).sort();
  checks.that(
    JSON.stringify(keys) === JSON.stringify([...SETTLEMENT_KEYS].sort()),
    `结算载荷字段集必须逐字等于契约（多一个/少一个都红，§8.5）：实际 ${JSON.stringify(keys)}`,
  );
  checks.eq(s.roomCode, room.roomCode, 'roomCode 与房间一致');
  /**
   * ⚠️ **不写死数字**（Task 3e）：协议② 之后撮合**必须**带 `baseScore`，结算里的底分
   * 必须逐字等于撮合时发的那一档 ⇒ 读驱动导出的真源（写死的 100 已随缺省值 100 → 15 过期）。
   * C26 的下半条（分数字段必须由**载荷里的** baseScore 算）在下面第 4 组断言里。
   */
  checks.eq(
    s.baseScore,
    MATCH_BASE_SCORE,
    `结算底分 = 撮合时发送的那一档（${MATCH_BASE_SCORE}；C26：不得硬编码在 settleGame 里）`,
  );
  checks.eq(s.winner, expectedWinner, `winner 与 game.finished 一致（实际 ${JSON.stringify(s.winner)}）`);

  const landlordSeat = finalView.landlordSeat;
  if (landlordSeat === null) throw new ConformanceError('结算判定时 finalView.landlordSeat 仍为 null');
  checks.eq(s.landlordSeat, landlordSeat, 'landlordSeat = 视图里的**座位号**（C2：不是 players 数组下标）');
  checks.that(
    JSON.stringify([...s.farmerSeats].sort()) ===
      JSON.stringify([0, 1, 2].filter((x) => x !== landlordSeat)),
    `farmerSeats 恰好是另外两家（座位号，C2）：实际 ${JSON.stringify(s.farmerSeats)}`,
  );
  checks.eq(
    s.spring,
    expectedSpring,
    `春天/反春（C3，§8.3 逐字两条）：地主胜且农民一手未出 ⇒ spring；农民胜且地主**恰好**一手 ⇒ anti-spring` +
      `（实际 ${JSON.stringify(s.spring)}）`,
  );

  // C1：倍数 = bidMultiplier × 2^bombCount × 春天倍数（**乘法**，§8.2；本片全是单张 ⇒ bombCount 0、春天倍数 2）
  const oldAdditive = finalView.bidPhase.bidMultiplier + finalView.playPhase.bombCount;
  const expectedMultiplier =
    finalView.bidPhase.bidMultiplier * 2 ** finalView.playPhase.bombCount * 2;
  checks.eq(
    s.multiplier,
    expectedMultiplier,
    `倍数按 §8.2 **乘法**合成 = bidMultiplier(${finalView.bidPhase.bidMultiplier}) × 2^bombCount(${finalView.playPhase.bombCount}) × 春天 2` +
      `（旧加法实现给 ${oldAdditive}；实际 ${JSON.stringify(s.multiplier)}）`,
  );
  // C26：分数必须用**载荷里的** baseScore 算，不是写死的一个数字（§8.4）
  checks.eq(
    s.landlordScoreChange,
    expectedWinner === 'landlord' ? s.baseScore * s.multiplier * 2 : -s.baseScore * s.multiplier * 2,
    `地主变动（§8.4：胜方 ±baseScore×倍数×2；实际 ${JSON.stringify(s.landlordScoreChange)}）`,
  );
  checks.eq(
    s.farmerScoreChange,
    expectedWinner === 'landlord' ? -s.baseScore * s.multiplier : s.baseScore * s.multiplier,
    `每名农民变动（§8.4：胜方 ±baseScore×倍数；实际 ${JSON.stringify(s.farmerScoreChange)}）`,
  );
  checks.eq(
    s.landlordScoreChange + s.farmerScoreChange * s.farmerSeats.length,
    0,
    `分数守恒（§8.4：地主 ${s.landlordScoreChange} + ${s.farmerSeats.length} 名农民 × ${s.farmerScoreChange} = 0）`,
  );
  return s;
}

/**
 * N17：三家都必须收到 `state === 'ended'` 的终局裁剪视图，且终局**不发** `game.current_turn`。
 *
 * 顺序与「没有发生」两类判据都走**结构性**形式（`received` 下标、`version` 相等），不依赖墙钟。
 * 返回终局版本号（逐手覆盖度计数与正对照都用它）。
 */
async function checkEndedViews(
  room: FreshRoom,
  winnerSeat: number,
  expectedWinner: 'landlord' | 'farmer',
  checks: Checks,
): Promise<number> {
  const isEnded = (m: any): boolean => readView(m).state === 'ended';
  const msgs = await Promise.all(
    room.clients.map((c) => c.waitFor('game.state_update', STEP_TIMEOUT_MS, isEnded)),
  );
  const versions = msgs.map((m) => readView(m).version);
  const endedVersion = versions[0]!;
  checks.that(
    versions.every((v) => v === endedVersion),
    `三家都收到 state='ended' 的终局视图且**同版本**（§6.7：同一次状态转移共享 version）：实际 ${JSON.stringify(versions)}`,
  );
  for (const [i, m] of msgs.entries()) {
    const v = readView(m);
    checks.eq(v.cardCounts[winnerSeat], 0, `终局视图 client ${i}：胜者（seat ${winnerSeat}）张数为 0（§8.3）`);
    checks.eq(v.winner, expectedWinner, `终局视图 client ${i}：winner = ${expectedWinner}（§4.2 PlayerView.winner）`);
  }

  // §6.7：同一次状态转移内 state_update **先于**结算/结束；这里是同一 client 的到达下标
  const first = room.clients[0]!;
  const endedIdx = indexOfReceived(first, 'game.state_update', isEnded);
  const settleIdx = indexOfReceived(first, 'game.settlement', () => true);
  checks.that(
    endedIdx >= 0 && settleIdx >= 0 && endedIdx < settleIdx,
    `终局视图必须先于结算到达（§6.7：ended@${endedIdx}, settlement@${settleIdx}）`,
  );

  // R187：终局**没有**「下一回合」⇒ 不发 game.current_turn。
  // R193②：先证明探针能观测到「**发生**」（上一版确实有 current_turn），再断言「没有」。
  const turnsBefore = first.received.filter(
    (r) => r.type === 'game.current_turn' && r.message.version === endedVersion - 1,
  ).length;
  checks.that(
    turnsBefore > 0,
    `正对照：上一版 v${endedVersion - 1} 确实有 game.current_turn（实际 ${turnsBefore} 条）—— 证明本探针能观测到「发生」`,
  );
  const turnsAtEnd = first.received.filter(
    (r) => r.type === 'game.current_turn' && r.message.version === endedVersion,
  ).length;
  checks.eq(
    turnsAtEnd,
    0,
    `终局版 v${endedVersion} **不发** game.current_turn（R187：终局没有「下一回合」；实际 ${turnsAtEnd} 条）`,
  );
  return endedVersion;
}

/** 步骤 id：`a` = 地主胜 + 春天 · `b` = 农民胜 + 反春。 */
const ALL_STEPS = ['a', 'b'] as const;
type StepId = (typeof ALL_STEPS)[number];

/**
 * 步骤选择器 `CONFORMANCE_STEPS`（默认 = 全部）。
 *
 * `run.js` 是 **fail-fast**：一次跑只暴露**第一条**失败的断言，而本片有两个独立场景
 * （春天 / 反春）需要各自的 RED 原文 ⇒ 负对照必须能逐步取。
 * **门禁与最终判定一律不带该环境变量。** 未列出的 id 直接抛错（手误不能被当成「筛过了」）。
 */
function selectedSteps(): Set<StepId> {
  const raw = process.env.CONFORMANCE_STEPS;
  if (!raw) return new Set(ALL_STEPS);
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !(ALL_STEPS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new ConformanceError(
      `CONFORMANCE_STEPS 里有未知步骤：${unknown.join(', ')}（合法值：${ALL_STEPS.join(',')}）`,
    );
  }
  return new Set(ids as StepId[]);
}

export async function runSlice10(): Promise<Checks> {
  const checks = new Checks();
  const rooms: FreshRoom[] = [];
  // 未知 id 必须在**任何网络动作之前**就抛错（否则手误会被当成「筛过了」）。
  const steps = selectedSteps();

  try {
    if (steps.has('a')) {
      // ── 场景 A：地主胜 + 春天（C3 的 spring 半边 + C1 乘法 + N1/N17）────────
      step('场景 A：地主每墩首出最大单张、两农民全程过牌 ⇒ 地主胜 + 春天 + 结算');
      const roomA = await startFreshRoom('S10A');
      rooms.push(roomA);
      await playBiddingToPlaying(roomA, checks);
      info(`场景 A：进 playing 时的三家手牌 = ${handsInfo(roomA)}`);

      const landlordSeatA = firstView(roomA).landlordSeat;
      if (landlordSeatA === null) throw new ConformanceError('场景 A：进入 playing 后 landlordSeat 仍为 null');
      const landlordA = roomA.bySeat.get(landlordSeatA);
      if (!landlordA) throw new ConformanceError(`场景 A：landlordSeat=${landlordSeatA} 没有对应客户端`);
      checks.eq(currentView(landlordA).hand.length, 20, '地主起手 20 张（17 + 3 底牌）');

      const caliberViolationsA: string[] = [];
      const playedValuesA: Card[] = [];
      let tricksA = 0;
      /** 地主在**线可观测**的首出墩数（旧实现 19：终局那一版视图整体缺失）。 */
      let observedA = 0;
      let finalViewA: PlayViewWire | null = null;
      let finalCardA: Card | null = null;

      for (let i = 0; i < MAX_TRICKS; i += 1) {
        const view = currentView(landlordA);
        if (view.hand.length === 0) break;
        if (view.currentPlayer !== landlordSeatA) {
          throw new ConformanceError(
            `场景 A：第 ${i + 1} 墩轮到地主时 currentPlayer=${view.currentPlayer}，期望 ${landlordSeatA}`,
          );
        }
        const card = extremeByRank(view.hand, 'max');
        playedValuesA.push(card);

        if (view.hand.length === 1) {
          // 终局手：等 game.finished（终局那一版视图在下面单独取，见 N17）
          finalViewA = view;
          finalCardA = card;
          const winner = await playFinalHand(landlordA, [card], checks, `地主第 ${i + 1} 墩首出单张（DouZero ${card.r}）`);
          checks.eq(winner, 'landlord', '地主出完最后一张 ⇒ game.finished{landlord}');
          tricksA += 1;
          break;
        }

        const played = await playAndSync(roomA, landlordA, [card], checks, `地主第 ${i + 1} 墩首出单张（DouZero ${card.r}）`);
        checkRecentWindow(played, [card], landlordSeatA, caliberViolationsA);
        observedA += 1;
        tricksA += 1;
        for (let k = 0; k < 2; k += 1) {
          // 每一次过牌都查协议 ④ 的两条窗口判据（「不出」占一手 / 一墩结束则上一手作废）。
          await passCurrent(roomA, checks, `第 ${i + 1} 墩农民过牌`, caliberViolationsA);
        }
      }

      if (!finalViewA) throw new ConformanceError('场景 A：循环结束但没有终局手（地主没赢？）');

      // ⚠️ 这两条 info 必须在断言**之前**：后面的 RED 可能是结算超时，没有它们就说不出
      // 「这一跑到底打了哪些牌、覆盖到哪一手」（R171②/R181）。
      info(`场景 A：本房出现的牌值（三家发牌 + 底牌 54 张）= ${JSON.stringify(deckValues(roomA))}`);
      info(
        `场景 A：地主实际打出的单张 = ${JSON.stringify(playedValuesA)}；含 DouZero 17（2）= ${playedValuesA.some((c) => c.r === 17)}`,
      );

      // ── N1：三家**都**收到结算（未修栈上第一条 RED 就在这里）────────────
      const settlementsA = await receiveSettlements(roomA, checks);
      checkSettlement(settlementsA[0]!.payload, roomA, finalViewA, 'landlord', 'spring', checks);

      // ── N17：终局视图（state='ended'）+ 顺序 + 终局不发 current_turn ────
      await checkEndedViews(roomA, landlordSeatA, 'landlord', checks);

      // 终局那一版视图也必须能被口径断言观测到（旧实现这一版整体缺失 ⇒ 上面那次 waitFor 就超时）
      const endedLandlordA = await landlordA.waitFor('game.state_update', STEP_TIMEOUT_MS, (m: any) => readView(m).state === 'ended');
      checkRecentWindow(readView(endedLandlordA), [finalCardA!], landlordSeatA, caliberViolationsA);
      observedA += 1;

      checks.eq(tricksA, 20, '地主恰好用了 20 墩（每墩 1 张，无卡死）');
      checks.eq(
        observedA,
        20,
        `终局视图补齐后，地主 20 墩**逐手**都在线可观测（旧实现 19/20；实际 ${observedA}）`,
      );
      checks.that(
        caliberViolationsA.length === 0,
        `每一手 recentActions 的窗口口径（最新一条 = 所出牌、seat = 行动者、长度 ≤ 2；含终局那一版；` +
          `每一次过牌还查「不出」占一手与一墩结束判据）` +
          `${caliberViolationsA.length > 0 ? ` ⇒ ${caliberViolationsA.join(' | ')}` : ''}`,
      );

      // R155：换房前先关客户端并静置，等 disconnect 的 ZREM 落地
      for (const client of roomA.clients) client.close();
      await sleep(400);
    }

    if (steps.has('b')) {
      // ── 场景 B：农民胜 + 反春（C3 的 anti-spring 半边 + §8.4 守恒）────────
      step('场景 B：地主只首出一手 → 某农民压过并连打 ⇒ 农民胜 + 反春 + 结算');
      const roomB = await startFreshRoom('S10B');
      rooms.push(roomB);
      await playBiddingToPlaying(roomB, checks);
      info(`场景 B：进 playing 时的三家手牌 = ${handsInfo(roomB)}`);

      const landlordSeatB = firstView(roomB).landlordSeat;
      if (landlordSeatB === null) throw new ConformanceError('场景 B：进入 playing 后 landlordSeat 仍为 null');
      const landlordB = roomB.bySeat.get(landlordSeatB);
      if (!landlordB) throw new ConformanceError(`场景 B：landlordSeat=${landlordSeatB} 没有对应客户端`);
      const farmersB = roomB.clients.filter((c) => c !== landlordB);
      checks.eq(farmersB.length, 2, '场景 B：地主之外恰好两位农民');

      // B1：地主首出**最小**单张（反春要求他的出牌数**恰好** 1，见 §8.3）
      const leadCard = extremeByRank(currentView(landlordB).hand, 'min');
      await playAndSync(
        roomB,
        landlordB,
        [leadCard],
        checks,
        `地主首出最小单张（DouZero ${leadCard.r} / 内部 Rank ${leadCard.r}）`,
      );

      // 挑一位**能压过**的农民（只用 §10 的值映射比点数，不是规则引擎）
      const beater = farmersB.find((f) => smallestBeatingSingle(currentView(f).hand, leadCard) !== null);
      if (!beater) {
        throw new ConformanceError(
          `场景 B：两名农民都压不过地主的最小单张 DouZero ${leadCard.r}（内部 Rank ${leadCard.r}）—— 重跑该切片`,
        );
      }
      const beaterSeat = currentView(beater).seat;
      const otherFarmer = farmersB.find((f) => f !== beater)!;
      const beatCard = smallestBeatingSingle(currentView(beater).hand, leadCard)!;
      info(
        `场景 B：地主 seat ${landlordSeatB} 首出 ${leadCard.r}（内部 ${leadCard.r}）；` +
          `压过者 seat ${beaterSeat}（用 ${beatCard}）；另一农民 seat ${currentView(otherFarmer).seat}`,
      );

      const caliberViolationsB: string[] = [];
      /**
       * 压过者「连打」阶段的在线可观测墩数（== §8.3 那条 17 − 1 = 16）。
       *
       * 压过那一手（跟牌）**不计入**本计数：这里数的是**首出墩**（与 slice-09 的
       * `farmerTricks = 16` 同一口径）。旧实现 15（终局那一版视图整体缺失）。
       */
      let observedB = 0;
      let finalViewB: PlayViewWire | null = null;
      let finalCardB: Card | null = null;

      // B2：**按轮转**走到「压过者完成跟牌」为止（R174）
      let beats = 0;
      for (let guard = 0; guard < 2; guard += 1) {
        const turn = firstView(roomB).currentPlayer;
        const actor = roomB.bySeat.get(turn);
        if (!actor) throw new ConformanceError(`场景 B：currentPlayer=${turn} 没有对应客户端`);
        if (actor === beater) {
          const playedBeat = await playAndSync(
            roomB,
            beater,
            [beatCard],
            checks,
            `农民用最小的可压单张压过（seat ${beaterSeat}，DouZero ${beatCard}）`,
          );
          checkRecentWindow(playedBeat, [beatCard], beaterSeat, caliberViolationsB);
          beats += 1;
          break;
        }
        await passAndSync(roomB, actor, checks, `${actor.label} 过牌（让位给能压过的那位农民）`, caliberViolationsB);
      }
      checks.eq(beats, 1, '能压过的那位农民用**最小可压单张**压过了地主首出');

      // B3：另两家过牌 ⇒ 出牌权交回压过者（§6.2-5）
      for (let k = 0; k < 2; k += 1) {
        const turn = firstView(roomB).currentPlayer;
        const actor = roomB.bySeat.get(turn);
        if (!actor) throw new ConformanceError(`场景 B：currentPlayer=${turn} 没有对应客户端`);
        checks.that(actor !== beater, `第 ${k + 1} 手过牌的是另两家（seat ${turn}），不是刚出牌的那位`);
        await passAndSync(roomB, actor, checks, `${actor.label} 过牌（交回出牌权）`, caliberViolationsB);
        if (k === 0) {
          // 不变式②的在线形态（**旧契约根本表达不出**）：「不出」占一手但**不擦除**上一手 ——
          // 第一手过牌之后，压过的那一手（seat + 牌面逐字）必须仍在窗口里。
          const afterFirstPass = lastPlay(firstView(roomB));
          checks.that(
            afterFirstPass !== null &&
              afterFirstPass.seat === beaterSeat &&
              JSON.stringify(afterFirstPass.cards) === JSON.stringify([beatCard]),
            `第一手过牌后，被压过的那一手仍原样在窗口里（不变式②的在线形态）——` +
              ` 实际 ${JSON.stringify(afterFirstPass)}`,
          );
        }
      }
      checks.eq(firstView(roomB).currentPlayer, beaterSeat, '两家过牌后出牌权交给压过的那位农民（§6.2-5）');
      // 两家过牌后窗口里**两项都是显式的「不出」**：上一手作废（§6.2-5）。
      const windowAfterTwoPasses = firstView(roomB).recentActions;
      checks.that(
        windowAfterTwoPasses.length === 2 && windowAfterTwoPasses.every((a) => a.cards === null),
        `两家过牌后窗口两项都是「不出」（§6.2-5；旧 lastPlayedHand 归 null 的等价读点）——` +
          ` 实际 ${JSON.stringify(windowAfterTwoPasses)}`,
      );

      // B4：压过者每墩首出**最大**单张、另两家过牌 ⇒ 手牌归零 ⇒ 农民胜（§7）
      const playedValuesB: Card[] = [leadCard, beatCard];
      let farmerTricks = 0;

      for (let i = 0; i < MAX_TRICKS; i += 1) {
        const view = currentView(beater);
        if (view.hand.length === 0) break;
        if (view.currentPlayer !== beaterSeat) {
          throw new ConformanceError(
            `场景 B：第 ${i + 1} 墩轮到 seat ${beaterSeat} 时 currentPlayer=${view.currentPlayer}`,
          );
        }
        const card = extremeByRank(view.hand, 'max');
        playedValuesB.push(card);

        if (view.hand.length === 1) {
          finalViewB = view;
          finalCardB = card;
          const winner = await playFinalHand(beater, [card], checks, `农民第 ${i + 1} 墩首出单张（DouZero ${card.r}）`);
          checks.eq(winner, 'farmer', '任一农民出完牌 ⇒ 农民胜（§7）');
          farmerTricks += 1;
          break;
        }

        const played = await playAndSync(roomB, beater, [card], checks, `农民第 ${i + 1} 墩首出最大单张（DouZero ${card.r}）`);
        checkRecentWindow(played, [card], beaterSeat, caliberViolationsB);
        observedB += 1;
        farmerTricks += 1;
        for (let k = 0; k < 2; k += 1) {
          await passCurrent(roomB, checks, `第 ${i + 1} 墩另两家过牌`, caliberViolationsB);
        }
      }

      if (!finalViewB) throw new ConformanceError('场景 B：循环结束但没有终局手（农民没赢？）');

      info(`场景 B：本房出现的牌值（三家发牌 + 底牌 54 张）= ${JSON.stringify(deckValues(roomB))}`);
      info(
        `场景 B：实际打出的单张 = ${JSON.stringify(playedValuesB)}；含 DouZero 17（2）= ${playedValuesB.some((c) => c.r === 17)}`,
      );

      // ── N1：三家**都**收到结算 ────────────────────────────────────────
      const settlementsB = await receiveSettlements(roomB, checks);
      // ⚠️ 反春：地主**恰好**出过一手（就是上面那次首出）⇒ anti-spring、倍数 ×2
      checkSettlement(settlementsB[0]!.payload, roomB, finalViewB, 'farmer', 'anti-spring', checks);

      // ── N17：终局视图 + 顺序 + 终局不发 current_turn ────────────────────
      await checkEndedViews(roomB, beaterSeat, 'farmer', checks);

      const endedBeaterB = await beater.waitFor('game.state_update', STEP_TIMEOUT_MS, (m: any) => readView(m).state === 'ended');
      checkRecentWindow(readView(endedBeaterB), [finalCardB!], beaterSeat, caliberViolationsB);
      observedB += 1;

      checks.eq(farmerTricks, 16, '压过那一手之后该农民恰好再首出 16 墩（17 - 1）');
      checks.eq(
        observedB,
        16,
        `终局视图补齐后，农民 16 墩**逐手**都在线可观测（旧实现 15/16；实际 ${observedB}）`,
      );
      checks.that(
        caliberViolationsB.length === 0,
        `每一手 recentActions 的窗口口径（最新一条 = 所出牌、seat = 行动者、长度 ≤ 2；含终局那一版；` +
          `在线可观测 ${observedB} 墩 + 压过那一手；每一次过牌还查「不出」占一手与一墩结束判据）` +
          `${caliberViolationsB.length > 0 ? ` ⇒ ${caliberViolationsB.join(' | ')}` : ''}`,
      );

      for (const client of roomB.clients) client.close();
      await sleep(400);
    }

    info(`场景：${[...steps].join(',')} · 房间：${rooms.map((r) => r.roomCode).join(' / ')}`);
    return checks;
  } finally {
    for (const room of rooms) {
      for (const client of room.clients) client.close();
    }
  }
}
