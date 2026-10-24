/**
 * 切片 9 conformance：出牌轮转（玩法 §4.1/§5/§6/§7/§9.1/§11.1 + 主规格 §6.4）。
 *
 * 三个场景（R168）：
 *  A（地主赢）—— 地主每墩**首出**手牌中最大的一张单张、两农民依次过牌 ⇒ 两墩过牌把出牌权
 *     交回地主（§6.2-5）⇒ 20 墩后地主手牌为 0 ⇒ `game.finished{landlord}` + `game.settlement`；
 *     同时逐手钉住**窗口口径**（协议 ④ / C19 的**在线**判据：最新一条 = 所出牌、seat = 行动者、
 *     长度 ≤ 2；每一手过牌再过 `checkPassOccupiesSlot` / `checkPlaySurvivesPass`）。
 *     ⚠️ 跟牌目标的 `type`/`keyRank`/`length` 协议 ④ 起**不在出站面上** —— 那条口径
 *     已**等价迁移**到 `packages/game-service/test/view.builder.test.ts` 的单测（Task A4）。
 *  B（农民赢）—— **C16 的唯一判据**：地主首出**最小**单张；两位农民里**能压过**的那位用其
 *     **最小的可压单张**压过；地主与另一农民过牌 ⇒ 出牌权交给该农民（§6.2-5）；此后该农民每墩
 *     首出**最大**单张、另两家过牌 ⇒ 17 张走完 ⇒ `game.finished{farmer}`。
 *     旧实现（`farmers.every`）在这里**不结束对局** ⇒ 本用例在 `game.finished` 上超时（红）。
 *     ⚠️ **首出顺序是执行期裁决改的（协调者插播，2026-09-15）**：R168 的字面是「最小单张」，
 *     改成**最大单张**只为把 DouZero `17`（2）**前置**到前几墩 ⇒ 落进**非终局手**、能被
 *     `checkRecentWindow` 观测到（升序时 2 往往正好是终局手，而终局手没有 `state_update`，R172）。
 *     判据强度不变：另两家是**主动过牌**（与该农民出什么牌无关），他反正要把 17 张打完 ⇒
 *     胜负与顺序无关，`farmerTricks = 16` 与断言集一条都没改。
 *  C（C18 反例）—— 首出（窗口里没有出牌项）时过牌 ⇒ `13001`；被拒的动作不推进
 *     `version`/`currentPlayer`；随后正常出牌成功 ⇒ 房间没被弄死。
 *
 * ⚠️ **C19 的 e2e 覆盖依旧是机会性的，不要把「没红」读成「有覆盖」（R171/R181）**：
 * 只有真的打出 DouZero `17`（2）时新旧实现才分歧，而这取决于发牌 ——
 * 场景 A 需要**地主**手里有 17（20 张抽自 54 张、其中 **4 张**是 2 ⇒ `1 − C(50,20)/C(54,20) ≈ 85.3%`），
 * 场景 B 需要**压过的那位农民**手里有 17（17 张 ⇒ `1 − C(50,17)/C(54,17) ≈ 79.1%`；改降序后
 * 它会在前几墩被非终局手观测到），两场景至少一个覆盖 ≈ **96.9%**（近似，两者负相关）。
 * ⚠️ 这里**曾经写错两次**：`20/54 ≈ 37%` 与 `61%` 分别对应「一副牌只有 1 个 2」与「有 2 个 2」，
 * 而 `packages/shared/src/card/card.ts` 的 `createDeck()` 是 `4 花色 × (3..2) + 2 王 = 52 + 2`
 * ⇒ **2 有四张**。判别性的**主证据**仍是 `packages/shared/src/ddz/play.test.ts` 的
 * 「同点数的 2 不能压过 2」（R158）；e2e 这一条是**回归锚**，`handsInfo()` 让每一跑
 * 「谁手里有 17」都可直接判读。
 *
 * ⚠️ 驱动只用手牌 + 单张点数（直接读 `Card.r`，R695 之后没有第二套编码）算动作，
 * **不** import `@fight-the-landlord/shared` 的 `parseHand`/`canBeat` —— 那等于拿被测实现当裁判（R168）。
 *
 * ⚠️ **驱动已抽到 `../lib/ddz-driver`（R190①，切片 10）**：本文件只留三个场景主体与
 * `selectedSteps()`（步骤 id 是切片自己的）。搬迁是机械的，行为与断言一条都没改。
 *
 * ⚠️ R155：三个场景是三个房间（同一 IP 的并发 WS 上限 5）⇒ 开新房前先关掉上一房并 `sleep(400)`
 * 等 `ZREM` 落地；R156：`startFreshRoom` 抛出前必须先 `close()` 已连上的客户端，
 * 否则失败路径泄漏的 socket 会把事件循环吊住（切片 7.2 实测卡了 693s）。
 * ⚠️ R172（**计划自身的缺陷，协调者评审期已就地修正**）：§7 的结束路径在 `finishTransition` 里
 * 直接 `saveSession` + `publishEnded` 后返回，**不发** `game.state_update` ⇒ 终局手必须走
 * `playFinalHand()`（等 `game.finished`），用「等更新版本」的 `playAndSync` 会在终局手白等 8s
 * **假红**。
 *
 * ⚠️ 本文件在执行期另记了四条裁决（**R174–R177**，编号接计划的 R172 与协调者的 R173；
 * 细节见计划文件「执行期裁决」，现已随驱动搬进 `lib/ddz-driver.ts`）：
 *  - **R174**：行动者**一律按 `currentPlayer` 从 `bySeat` 取**，不假定「客户端连接顺序 == 轮转顺序」。
 *    计划里的 `for (const farmer of farmersA)` 与「先地主后另一农民」在座位顺序不巧时会发出
 *    **非当前回合**的动作 ⇒ 拿 `12003` 而不是想要的 RED，且修好之后也会红（用例本身是坏的）。
 *  - **R175**：§5.4 的 WS 消息限额是**每个 socket 20 条 / 5 秒**（`message.router.ts:32`）。
 *    **实测**（未加节流的版本，`CONFORMANCE_STEPS=a`）：
 *      `❌ slice-09 失败：地主第 18 墩首出单张（seat 0）：期望 0，实际 10006`
 *    失败点与该 socket 已发出的消息数吻合（`room.match` + `room.join` + `game.bid` + 17×`game.play`
 *    = 20 条，第 21 条即第 18 墩的 `game.play` 被拒；这个逐条计数是对失败点的**复原**，
 *    不是另一次独立观测）。`sendThrottled()` 保证同一 client 两条消息间 ≥ `MSG_INTERVAL_MS`。
 *  - **R176**：`Checks.eq` 用 `!==` 比较，`checks.eq(violations, [])` **永远不可能通过**
 *    （两个不同的数组对象引用）⇒ 改用 `checks.that(violations.length === 0, …)` 并把违例原文
 *    拼进消息（否则 RED 只说「错了」，看不到是哪一手）。
 *  - **R177**：叫抢驱动**每轮收口前必须 `syncAll`** 再读下一轮的 `currentBidder`；
 *    `waitForNewerVersion(actor, …)` 只保证**行动者**拿到新版，而 `firstView(room)` 走的是
 *    `clients[0]` —— 它落后一版时会对着上一轮的叫抢者发 `game.bid`，拿 `12003`（实测）。
 *    ⚠️ `slice-08-bidding.ts` 的同款写法（`currentView(clients[0]!)`）有同一竞态。
 */
import { ErrCode, type Card } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, step } from '../lib/assert';
import {
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
  sendThrottled,
  sleep,
  smallestBeatingSingle,
  startFreshRoom,
  type FreshRoom,
} from '../lib/ddz-driver';

/** 步骤 id：`a` = 地主赢 · `b` = 农民赢 · `c` = 首出过牌反例。 */
const ALL_STEPS = ['a', 'b', 'c'] as const;
type StepId = (typeof ALL_STEPS)[number];

/**
 * 步骤选择器 `CONFORMANCE_STEPS`（默认 = 全部）。
 *
 * `run.js` 是 **fail-fast**：一次跑只暴露**第一条**失败的断言，而本片有三个独立的判别点
 * （C16 / C18 / C19+C20）需要各自的 RED 原文 ⇒ 负对照必须能逐步取。
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

export async function runSlice09(): Promise<Checks> {
  const checks = new Checks();
  const rooms: FreshRoom[] = [];
  // 未知 id 必须在**任何网络动作之前**就抛错（否则手误会被当成「筛过了」）。
  const steps = selectedSteps();

  try {
    if (steps.has('a')) {
      // ── 场景 A：地主赢（§6.2-5 的出牌权回归 + C19/C20 口径）────────────
      step('场景 A：地主每墩首出最大单张，两农民过牌 ⇒ 20 墩打到地主胜');
      const roomA = await startFreshRoom('A');
      rooms.push(roomA);
      await playBiddingToPlaying(roomA, checks);
      info(`场景 A：进 playing 时的三家手牌 = ${handsInfo(roomA)}`);

      const landlordSeat = firstView(roomA).landlordSeat;
      if (landlordSeat === null) throw new ConformanceError('场景 A：进入 playing 后 landlordSeat 仍为 null');
      const landlord = roomA.bySeat.get(landlordSeat);
      if (!landlord) throw new ConformanceError(`场景 A：landlordSeat=${landlordSeat} 没有对应客户端`);
      checks.eq(currentView(landlord).hand.length, 20, '地主起手 20 张（17 + 3 底牌，C15/R101）');

      const caliberViolations: string[] = [];
      const playedValuesA: Card[] = [];
      let tricks = 0;
      let observedA = 0;

      for (let i = 0; i < MAX_TRICKS; i += 1) {
        const view = currentView(landlord);
        if (view.hand.length === 0) break;
        if (view.currentPlayer !== landlordSeat) {
          throw new ConformanceError(
            `场景 A：第 ${i + 1} 墩轮到地主时 currentPlayer=${view.currentPlayer}，期望 ${landlordSeat}`,
          );
        }
        const card = extremeByRank(view.hand, 'max');
        playedValuesA.push(card);

        if (view.hand.length === 1) {
          // 终局手：不会有 state_update，等 game.finished（R172）
          const winner = await playFinalHand(landlord, [card], checks, `地主第 ${i + 1} 墩首出单张（DouZero ${card.r}）`);
          checks.eq(winner, 'landlord', '地主出完最后一张 ⇒ game.finished{landlord}');
          tricks += 1;
          break;
        }

        const played = await playAndSync(roomA, landlord, [card], checks, `地主第 ${i + 1} 墩首出单张（DouZero ${card.r}）`);
        checkRecentWindow(played, [card], landlordSeat, caliberViolations);
        observedA += 1;
        tricks += 1;
        for (let k = 0; k < 2; k += 1) {
          // 每一手过牌都查（协议 ④）：「不出」占一手；不结束一墩则上一手原样保留、
          // 结束一墩则被挤出 —— 违例进同一本册子，由下方那一条收口断言统一结算。
          await passCurrent(roomA, checks, `第 ${i + 1} 墩农民过牌`, caliberViolations);
        }
      }

      // ⚠️ 这两条 info 必须在口径断言**之前**：C20 的 RED 就发生在下一行，
      // 没有它们就无法说明「这一跑有没有覆盖到 DouZero 17（2）」（R171②/R168）。
      info(`场景 A：本房出现的牌值（三家发牌 + 底牌 54 张）= ${JSON.stringify(deckValues(roomA))}`);
      info(
        `场景 A：地主实际打出的单张 = ${JSON.stringify(playedValuesA)}；含 DouZero 17（2）= ${playedValuesA.some((c) => c.r === 17)}`,
      );

      checks.eq(tricks, 20, '地主恰好用了 20 墩（每墩 1 张，无卡死）');
      checks.that(
        caliberViolations.length === 0,
        `每一手 recentActions 的窗口口径（最新一条 = 所出牌、seat = 行动者、长度 ≤ 2；` +
          `每一次过牌还查「不出」占一手与「不结束一墩则上一手原样保留/结束则挤出」；` +
          `在线可观测 ${observedA} 手）` +
          `${caliberViolations.length > 0 ? ` ⇒ ${caliberViolations.join(' | ')}` : ''}`,
      );

      // N1 已由切片 10 关闭（`settleGame()` 复用契约类型 ⇒ 过得了网关的 `validateOutbound`）。
      // 判据恢复的正是切片 9 注释里预留的写法 —— 在那之前「结算推送能到达客户端」没有任何在线判据。
      const settlementA = await landlord.waitFor('game.settlement', STEP_TIMEOUT_MS);
      checks.eq(settlementA.payload.winner, 'landlord', 'game.settlement.winner = landlord（N1 恢复）');
      checks.eq(settlementA.payload.spring, 'spring', '两农民全程过牌 ⇒ 春天（C3 的在线判据）');
      checks.eq(
        settlementA.payload.multiplier,
        currentView(landlord).bidPhase.bidMultiplier * 2,
        '倍数 = 叫抢倍数 × 春天 2（C1 的在线判据）',
      );

      // 局终后再操作 ⇒ 13005（不是 0、也不是 500）
      // ⚠️ R697：载荷必须是 `Card[]`。写裸数字（`{ cards: [3] }`）会**先在入站校验
      //    失败**拿到 `10001`，把这条要验的 `13005` **整条遮住**（实测踩过）。
      const afterEnd = await sendThrottled(
        landlord,
        'game.play',
        { cards: [{ r: 3, s: 0 }] },
        currentView(landlord).version,
      );
      checks.eq(afterEnd.code, ErrCode.GAME_OVER, 'ended 后再出牌 ⇒ 13005');

      // R155：换房前先关客户端并静置，等 disconnect 的 ZREM 落地
      for (const client of roomA.clients) client.close();
      await sleep(400);
    }

    if (steps.has('b')) {
      // ── 场景 B：农民赢（C16 的唯一判据）──────────────────────────────
      step('场景 B：地主首出最小单张 → 某农民压过并连打 ⇒ 农民胜（C16）');
      const roomB = await startFreshRoom('B');
      rooms.push(roomB);
      await playBiddingToPlaying(roomB, checks);
      info(`场景 B：进 playing 时的三家手牌 = ${handsInfo(roomB)}`);

      const landlordSeatB = firstView(roomB).landlordSeat;
      if (landlordSeatB === null) throw new ConformanceError('场景 B：进入 playing 后 landlordSeat 仍为 null');
      const landlordB = roomB.bySeat.get(landlordSeatB);
      if (!landlordB) throw new ConformanceError(`场景 B：landlordSeat=${landlordSeatB} 没有对应客户端`);
      const farmersB = roomB.clients.filter((c) => c !== landlordB);
      checks.eq(farmersB.length, 2, '场景 B：地主之外恰好两位农民');

      // B1：地主首出**最小**单张（点数比较一律走内部 Rank）
      const leadCard = extremeByRank(currentView(landlordB).hand, 'min');
      await playAndSync(
        roomB,
        landlordB,
        [leadCard],
        checks,
        `地主首出最小单张（DouZero ${leadCard.r}）`,
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
          `压过者 seat ${beaterSeat}（用 ${beatCard.r}）；另一农民 seat ${currentView(otherFarmer).seat}`,
      );

      // 口径违例与在线可观测手数（终局手不可观测，见 playFinalHand 的注释）
      const caliberViolationsB: string[] = [];
      let observedB = 0;

      // B2：**按轮转**走到「压过者完成跟牌」为止（R174）。
      // 压过者可能恰好排在地主下家，此时他不需要谁先过牌；顺序一律读 currentPlayer。
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
            `农民用最小的可压单张压过（seat ${beaterSeat}，DouZero ${beatCard.r}）`,
          );
          checkRecentWindow(playedBeat, [beatCard], beaterSeat, caliberViolationsB);
          observedB += 1;
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
      // （旧契约没有字段能表达「谁刚过了牌」；旧断言只看「没有出牌项」，现在连两项的形状一起钉住。）
      const windowAfterTwoPasses = firstView(roomB).recentActions;
      checks.that(
        windowAfterTwoPasses.length === 2 && windowAfterTwoPasses.every((a) => a.cards === null),
        `两家过牌后窗口两项都是「不出」（§6.2-5；旧 lastPlayedHand 归 null 的等价读点）——` +
          ` 实际 ${JSON.stringify(windowAfterTwoPasses)}`,
      );

      // B4：压过者每墩首出**最大**单张、另两家过牌 ⇒ 手牌归零 ⇒ 农民胜（C16）。
      // ⚠️ 「最大」是执行期裁决（协调者插播）：R168 字面是「最小」，改降序只为把 DouZero 17（2）
      // 前置到非终局手（能被 checkRecentWindow 观测）；判据强度不变，另两家是主动过牌。
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
          // 终局手：不会有 state_update，等 game.finished（R172；C16 的判别点就在这里）
          const winner = await playFinalHand(beater, [card], checks, `农民第 ${i + 1} 墩首出单张（DouZero ${card.r}）`);
          checks.eq(winner, 'farmer', '任一农民出完牌 ⇒ 农民胜（C16；旧实现 every 会在这里超时红）');
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

      // 同样：C16 的 RED 发生在上一步（终局手等 game.finished 超时），info 放在断言之前才有证据。
      info(`场景 B：本房出现的牌值（三家发牌 + 底牌 54 张）= ${JSON.stringify(deckValues(roomB))}`);
      info(
        `场景 B：实际打出的单张 = ${JSON.stringify(playedValuesB)}；含 DouZero 17（2）= ${playedValuesB.some((c) => c.r === 17)}`,
      );

      checks.eq(farmerTricks, 16, '压过那一手之后该农民恰好再首出 16 墩（17 - 1）');
      checks.that(
        caliberViolationsB.length === 0,
        `场景 B 每一手 recentActions 的窗口口径（最新一条 = 所出牌、seat = 行动者、长度 ≤ 2；` +
          `每一次过牌还查「不出」占一手与一墩结束判据；在线可观测 ${observedB} 手）` +
          `${caliberViolationsB.length > 0 ? ` ⇒ ${caliberViolationsB.join(' | ')}` : ''}`,
      );

      // N1（切片 9 预留、切片 10 恢复）：场景 B 的农民胜结算必须到达。
      const settlementB = await beater.waitFor('game.settlement', STEP_TIMEOUT_MS);
      checks.eq(settlementB.payload.winner, 'farmer', 'game.settlement.winner = farmer（N1 恢复）');
      checks.eq(settlementB.payload.spring, 'anti-spring', '地主只出过一手 ⇒ 反春（C3 的在线判据）');

      for (const client of roomB.clients) client.close();
      await sleep(400);
    }

    if (steps.has('c')) {
      // ── 场景 C：C18 反例（首出不能过牌）──────────────────────────────
      step('场景 C：首出时 game.pass ⇒ 13001，且不推进状态；随后正常出牌成功（C18）');
      const roomC = await startFreshRoom('C');
      rooms.push(roomC);
      await playBiddingToPlaying(roomC, checks);
      info(`场景 C：进 playing 时的三家手牌 = ${handsInfo(roomC)}`);

      const landlordSeatC = firstView(roomC).landlordSeat;
      if (landlordSeatC === null) throw new ConformanceError('场景 C：进入 playing 后 landlordSeat 仍为 null');
      const landlordC = roomC.bySeat.get(landlordSeatC);
      if (!landlordC) throw new ConformanceError(`场景 C：landlordSeat=${landlordSeatC} 没有对应客户端`);

      const before = currentView(landlordC);
      checks.eq(lastPlay(before), null, '场景 C 起点：首出（窗口里没有出牌项）');
      // 协议 ④ 的投影边界：`recentActions` 只由**出牌/过牌**追加（叫抢阶段没有任何出牌，
      // §3.2/R205）⇒ 一局刚进 playing 时窗口必须是**空的**（不是「两条空条目」之类的形态）。
      checks.that(
        before.recentActions.length === 0,
        `场景 C 起点：窗口是空的（协议 ④ 由 actionLog 投影；叫抢阶段不产生条目）——` +
          ` 实际 ${JSON.stringify(before.recentActions)}`,
      );
      checks.eq(before.currentPlayer, landlordSeatC, '场景 C 起点：轮到地主');

      const badPass = await sendThrottled(landlordC, 'game.pass', {}, before.version);
      checks.eq(badPass.code, ErrCode.ILLEGAL_ACTION, '首出过牌 ⇒ 13001（玩法 §6.2-2）');

      // R68：不能只用 waitFor 证明「没发生」—— 正向等一段静默窗再断言状态原封不动
      await sleep(300);
      const after = currentView(landlordC);
      checks.eq(after.version, before.version, '被拒的过牌不推进 version');
      checks.eq(after.currentPlayer, before.currentPlayer, '被拒的过牌不改 currentPlayer');
      // 比旧断言（只看「没有出牌项」）更强：整段窗口**长度与内容逐字不变** —— 被拒的动作不留痕。
      checks.that(
        JSON.stringify(after.recentActions) === JSON.stringify(before.recentActions),
        `被拒的过牌不得改变窗口（长度与内容逐字不变）—— 前 ${JSON.stringify(before.recentActions)}，` +
          `后 ${JSON.stringify(after.recentActions)}`,
      );

      const smallest = extremeByRank(after.hand, 'min');
      const recovered = await playAndSync(roomC, landlordC, [smallest], checks, `首出被拒后仍能正常出牌（DouZero ${smallest.r}）`);
      const violationsC: string[] = [];
      checkRecentWindow(recovered, [smallest], landlordSeatC, violationsC);
      checks.that(
        violationsC.length === 0,
        `场景 C：被拒之后那一手的窗口口径（C19/C20 的在线半边）${violationsC.length > 0 ? ` ⇒ ${violationsC.join(' | ')}` : ''}`,
      );
      checks.eq(lastPlay(recovered)?.cards[0]?.r, smallest.r, 'C19：窗口最新一手的点数就是所出的那张（R695：内部 Rank 与 DouZero 编码已归一）');

      // ⚠️ Minor 2（2026-09-28 评审）：上面那条「被拒的过牌不改变窗口」的**真牙不足**——没有新推送时
      //    `before` / `after` 读的是**同一个** `client.last()` 缓存载荷（`currentView` 的语义）
      //    ⇒ 那一段是「自己比自己」（真正的牙只剩 `after.version === before.version`）。
      //    这条才是「被拒的动作不留痕」的**完整形态**：起点窗口**为空**（上面已断言）+ 被拒动作不得写
      //    `actionLog` ⇒ 这一手之后窗口必须**恰好**是这一条（多了任何一条都是被拒动作留的痕）。
      checks.that(
        JSON.stringify(recovered.recentActions) ===
          JSON.stringify([{ seat: landlordSeatC, cards: [smallest] }]),
        `被拒之后那一手是窗口里的**唯一**一条（起点窗口为空 + 被拒动作不留痕 ⇒ 窗口恰好 = [这一手]）` +
          `—— 实际 ${JSON.stringify(recovered.recentActions)}`,
      );

      for (const client of roomC.clients) client.close();
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
