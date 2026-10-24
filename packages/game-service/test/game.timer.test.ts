import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  GameState,
  HandType,
  createCapturingSink,
  createRedactingLogger,
} from '@fight-the-landlord/shared';
import type { Card } from '@fight-the-landlord/protocol';

/** R696：牌是 `{r, s}`。本文件的断言只关心点数，故 `s` 取 0。 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));
import { GameService } from '../src/game/game.service';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble, type RedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});


const startDto = (roomCode: string) => ({
  roomCode,
  baseScore: 100,
  players: [
    { id: 'user-1', seat: 0, isRobot: false },
    { id: 'user-2', seat: 1, isRobot: false },
    { id: 'user-3', seat: 2, isRobot: false },
  ],
});

describe('GameService with timers', () => {
  let service: GameService;
  let redis: RedisDouble;

  beforeEach(async () => {
    vi.useFakeTimers();
    redis = redisDouble;
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    // 片① R1：起始座位确定（座位 0 先叫），与改动前的行为一致。
    // 文件级统一注入：本文件的叫抢夹具（C28 / startPlayingGame / ROOM-T2 / ROOM-T11）
    // 都按「user-1 = 座位 0 先动」写就 —— 不注入则随起始座位 1/3 概率过。
    service.random = () => 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a turn timer when the game is created', async () => {
    await service.startGame(startDto('ROOM1'));
    expect(service['timers'].has('ROOM1')).toBe(true);
  });

  it('counts the turn down from bidPhase.currentBidder, not currentPlayer (偏差 C28)', async () => {
    const started = await service.startGame(startDto('ROOM2'));
    expect(started.state).toBe(GameState.Bidding);

    // 首位叫牌人先表态，把行动者推进到座位 1
    await service.bid('ROOM2', 'user-1', false);
    const session = await service.getSession('ROOM2');
    expect(session!.bidPhase.currentBidder).toBe(1);
    // 叫抢阶段 currentPlayer 恒为 0 —— 超时必须按 currentBidder 取人
    expect(session!.currentPlayer).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    const after = await service.getSession('ROOM2');
    // 座位 1 被自动「不叫」，而不是抛错后永久停摆
    expect(after!.bidPhase.currentBidder).toBe(2);
  });

  it('does not throw when the timer fires but the game is gone', async () => {
    await service.startGame(startDto('ROOM5'));
    service['cache'].delete('ROOM5');
    redis._store.delete('game:session:ROOM5');
    await expect(vi.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow();
  });

  it('clears all timers on shutdown', async () => {
    await service.startGame(startDto('ROOM4'));
    await service.onApplicationShutdown();
    expect(service['timers'].size).toBe(0);
  });

  // ── C22① / R106：超时动作抛错后必须重挂计时器，且不得静默吞错 ──────────

  /** 开局 → 1 抢 2 不抢 → playing，返回地主席位。 */
  async function startPlayingGame(roomCode: string): Promise<number> {
    await service.startGame(startDto(roomCode));
    await service.bid(roomCode, 'user-1', true);
    await service.bid(roomCode, 'user-2', false);
    await service.bid(roomCode, 'user-3', false);
    const playing = (await service.getSession(roomCode))!;
    expect(playing.state).toBe(GameState.Playing);
    return playing.currentPlayer; // 地主
  }

  /** §1.4 的「点数最小」按**内部 Rank** 取（DouZero 值恰好单调，但口径必须写死）。 */
  /** R695：全系统只有 DouZero 一套编码 ⇒ 直接比 `r`，`toInternalRank` 已删除。 */
  const smallestByRank = (hand: Card[]): Card =>
    hand.reduce((m, c) => (c.r < m.r ? c : m), hand[0]!);

  it('首出超时 ⇒ 打手牌中最小的单张，并重挂计时器（C5/R162/R163）', async () => {
    await startPlayingGame('ROOM-P1');
    const before = (await service.getSession('ROOM-P1'))!;
    const actor = before.players[before.currentPlayer]!;
    const smallest = smallestByRank(actor.hand);
    const fired = service['timers'].get('ROOM-P1');
    const errorSpy = vi.spyOn(service['logger'], 'error');

    await vi.advanceTimersByTimeAsync(30_000);

    const after = (await service.getSession('ROOM-P1'))!;
    expect(after.version).toBe(before.version + 1);
    expect(after.lastPlayedHand!.cards).toEqual([smallest]);
    expect(after.players[before.currentPlayer]!.hand).toHaveLength(actor.hand.length - 1);
    expect(after.currentPlayer).toBe((before.currentPlayer + 1) % 3);
    // §9.2：超时动作本身也要重挂；⚠️ 判据必须是「句柄被换掉」（R119：timers 从不自我清理）
    expect(service['timers'].get('ROOM-P1')).not.toBe(fired);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  /**
   * §9.1 的**跟牌**分支（C5 收口 / R204 修正版）：超时必须**先找最小可压牌**，
   * 找不到才过牌。「能过牌就过牌」是白送回合的旧行为（旧实现下这条必红）。
   */
  it('跟单张超时 ⇒ 打**最小可压**单张，而不是过牌（§9.1 ①②③）', async () => {
    const landlord = await startPlayingGame('ROOM-P2');
    const base = (await service.getSession('ROOM-P2'))!;
    const actor = (landlord + 1) % 3; // 地主的下一家 = 跟牌者（§6.2 轮转）
    /**
     * 直接换掉缓存里的会话 = **模拟一次回合转移**。真实的转移由写者完成并会重挂
     * 计时器；T5 的回合身份复核（actor/deadline 与安装时不符 ⇒ 放弃）之后，
     * 这里必须**同款重挂**，否则旧计时器会正确地拒绝替新回合动作（那才是对的）。
     */
    const mutated = {
      ...base,
      currentPlayer: actor,
      lastPlayerIdx: landlord,
      lastPlayedHand: { cards: h(7), type: HandType.Single, keyRank: 7, length: 0 },
      playPhase: { ...base.playPhase, consecutivePasses: 0 },
      players: base.players.map((p) => (p.seat === actor ? { ...p, hand: h(5, 6, 9) } : p)),
    };
    service['cache'].set('ROOM-P2', mutated);
    service['startTurnTimer']('ROOM-P2', mutated);

    await vi.advanceTimersByTimeAsync(30_000);

    const after = (await service.getSession('ROOM-P2'))!;
    expect(after.lastPlayedHand!.cards).toEqual(h(9));
    expect(after.lastPlayedHand!.type).toBe(HandType.Single);
    expect(after.playPhase.consecutivePasses).toBe(0); // **不是**过牌
  });

  it('无可压 ⇒ 跟牌超时才过牌（§9.1 第 ④ 步；正对照是上一条）', async () => {
    const landlord = await startPlayingGame('ROOM-P4');
    const base = (await service.getSession('ROOM-P4'))!;
    const actor = (landlord + 1) % 3;
    // 同 ROOM-P2：换缓存 = 模拟回合转移 ⇒ 必须按真实写者同款重挂计时器（T5 复核）。
    const mutated = {
      ...base,
      currentPlayer: actor,
      lastPlayerIdx: landlord,
      // 上一手是单张 2（R695：DouZero 编码 17）：手里既没有更大的单张，也没有炸弹/王炸
      lastPlayedHand: { cards: h(17), type: HandType.Single, keyRank: 17, length: 0 },
      playPhase: { ...base.playPhase, consecutivePasses: 0 },
      players: base.players.map((p) => (p.seat === actor ? { ...p, hand: h(3, 4, 5) } : p)),
    };
    service['cache'].set('ROOM-P4', mutated);
    service['startTurnTimer']('ROOM-P4', mutated);

    await vi.advanceTimersByTimeAsync(30_000);

    const after = (await service.getSession('ROOM-P4'))!;
    expect(after.playPhase.consecutivePasses).toBe(1);
    expect(after.lastPlayedHand!.cards).toEqual(h(17)); // 过牌不清空上一手
    expect(after.players[actor]!.hand).toEqual(h(3, 4, 5)); // 一张都没出
  });

  it('超时动作抛错（不可能状态：手牌为空）后仍记 error + 重挂 + 不落盘（R106 旧路径的替代覆盖）', async () => {
    const landlord = await startPlayingGame('ROOM-P3');
    const session = (await service.getSession('ROOM-P3'))!;
    /**
     * 手工把**行动者换成一个（空手牌的）农民**，而不是清空 `currentPlayer`（= 地主）的手牌。
     *
     * 两条都是夹具事实，不是猜的：
     *  ① 叫抢刚结束时 `currentPlayer === landlord`（§3.4），若清空地主手牌，
     *     `checkWinCondition` 会在 `finishTransition` 里判出**地主胜**并置 `ended`
     *     （实测 `version 5 / state ended`）⇒ 超时动作**根本不会被调用**，用例测不到 catch；
     *  ② 行动者若仍是地主，`handlePlayCards` 会在**抛错前**先把地主 17 张手牌扣掉 1 张并落盘
     *     ⇒ 「不落盘」那条断言一起失去判别力（`expected 4 to be 3`）。
     */
    const farmer = session.players.find((p) => !p.isLandlord)!.seat;
    const mutated = {
      ...session,
      currentPlayer: farmer,
      lastPlayedHand: null,
      lastPlayerIdx: -1,
      playPhase: { ...session.playPhase, consecutivePasses: 0 },
      players: session.players.map((p) => (p.seat === farmer ? { ...p, hand: [] } : p)),
    };
    service['cache'].set('ROOM-P3', mutated);
    // 换缓存 = 模拟回合转移 ⇒ 按真实写者同款重挂（T5 回合身份复核）。
    service['startTurnTimer']('ROOM-P3', mutated);
    const fired = service['timers'].get('ROOM-P3');
    const errorSpy = vi.spyOn(service['logger'], 'error');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('has no card to play');
    expect(service['timers'].get('ROOM-P3')).not.toBe(fired); // 重挂
    const after = (await service.getSession('ROOM-P3'))!;
    expect(after.version).toBe(session.version); // 不编造状态转移（且没有先扣掉一张手牌）
    expect(after.currentPlayer).toBe(farmer);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[landlord]!.hand).toEqual(session.players[landlord]!.hand);
    errorSpy.mockRestore();
  });

  it('任一时刻至多一个活动计时器（玩法 §9.2 第 3 条）', async () => {
    await service.startGame(startDto('ROOM-T2'));
    const first = service['timers'].get('ROOM-T2');
    await service.bid('ROOM-T2', 'user-1', false);
    const second = service['timers'].get('ROOM-T2');
    expect(service['timers'].size).toBe(1);
    expect(second).not.toBe(first); // 旧句柄被清掉、换成了新的
  });

  it('房间已消失时不安装新计时器（没有可挂的回合）', async () => {
    await service.startGame(startDto('ROOM-T3'));
    const fired = service['timers'].get('ROOM-T3');
    service['cache'].delete('ROOM-T3');
    redis._store.delete('game:session:ROOM-T3');
    await vi.advanceTimersByTimeAsync(30_000);
    // ⚠️ 计划 Task 4 Step 1 这里写的是 `timers.has('ROOM-T3') === false`，但**两条实现都做不到**
    //    —— 同 ②：触发后的旧句柄仍留在 map 里。真正的判据是「没有安装新计时器」。
    expect(service['timers'].get('ROOM-T3')).toBe(fired);
  });

  it('行动者座位在会话里不存在时：记 error 并重挂，而不是静默放弃（C22①/R106）', async () => {
    // 计划 Task 4 Step 1 想用「currentBidder 指向不存在的座位」制造抛错；但那一步
    // **走不到 `catch`**，而是命中 `!playerId` 这个前置守卫 —— 所以它值得自己一条用例。
    // 这里经既有测试同款的私有出口（`service['cache']`）构造残缺会话，
    // **不必**为测试往生产类上加 `saveSessionForTest`（计划建议优先方案 ②）。
    await service.startGame(startDto('ROOM-T4'));
    const session = (await service.getSession('ROOM-T4'))!;
    const mutated = {
      ...session,
      bidPhase: { ...session.bidPhase, currentBidder: 7 },
    };
    service['cache'].set('ROOM-T4', mutated);
    // 换缓存 = 模拟回合转移 ⇒ 按真实写者同款重挂（T5 回合身份复核）。
    service['startTurnTimer']('ROOM-T4', mutated);

    const fired = service['timers'].get('ROOM-T4');
    const errorSpy = vi.spyOn(service['logger'], 'error');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('has no player');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // 重挂：否则这一局静默停摆且没有任何后续信号
    expect(service['timers'].get('ROOM-T4')).not.toBe(fired);
    // 不编造状态转移
    expect((await service.getSession('ROOM-T4'))!.version).toBe(session.version);
    errorSpy.mockRestore();
  });

  // ── N37 / R525：**动作被规则拒绝**后，计时器也必须被重挂 ──────────────
  //
  // 缺陷形态（P13 的只读审计翻出、协调者独立复核）：`applyAction` 在**执行动作之前**
  // 就 `clearTimer(roomCode)`，而 `catch` 直接 `throw` ⇒ 这个房间**再也没有活动计时器**
  // （该回合零时限）。当前玩家若掉线/不操作，对局**永久停摆**，客户端只看到一次「动作被拒」。
  // ⚠️ 代码自己的注释（`game.service.ts:453-455`）已把该后果写成**必须避免** —— 只是
  //    **人类动作被拒**这条路径漏接（超时路径 `:636` 有重挂）。

  it('人类动作被规则拒绝后，计时器必须被重挂，且下一次超时仍会真的触发（N37）', async () => {
    await startPlayingGame('ROOM-N37');
    const before = (await service.getSession('ROOM-N37'))!;
    const fired = service['timers'].get('ROOM-N37');
    expect(fired).toBeDefined();

    // 投一个**必然被拒**的动作：非当前回合玩家出牌 ⇒ `Not your turn`（12003）。
    const notActor = before.players.find((p) => p.seat !== before.currentPlayer)!;
    await expect(service.playCards('ROOM-N37', notActor.id, [notActor.hand[0]!])).rejects.toThrow(
      /Not your turn/,
    );

    /**
     * ① 结构性判据（R119 / N26：`timers.has()` **不能**当「有活动计时器」用）：
     *    旧句柄已被 `clearTimer` 从 map 里**删掉** ⇒ 必须换上一个**新的活句柄**。
     * ⚠️ **不能只写 `not.toBe(fired)`** —— 在**未修**的实现上 `get()` 返回 `undefined`，
     *    `undefined !== fired` **恒真**，那会是一条**假绿**判据。必须断言 `toBeDefined()`。
     */
    const rearmed = service['timers'].get('ROOM-N37');
    expect(rearmed).toBeDefined();
    expect(rearmed).not.toBe(fired);

    // ② 不编造状态转移（拒绝 ≠ 转移）：版本/行动者/状态一律不动
    const unchanged = (await service.getSession('ROOM-N37'))!;
    expect(unchanged.version).toBe(before.version);
    expect(unchanged.currentPlayer).toBe(before.currentPlayer);
    expect(unchanged.state).toBe(GameState.Playing);

    // ③ 证明换上的是**活的**计时器（换个空句柄也能满足 ①）：再过 30s 必须真的推进这一局。
    await vi.advanceTimersByTimeAsync(30_000);
    const afterTimeout = (await service.getSession('ROOM-N37'))!;
    expect(afterTimeout.version).toBeGreaterThan(before.version);
  });

  // ── 判据 11（单测半边）：回合计时器链路 `source: 'timer'`（R1107）──────────
  //
  // R1107「无来源不编造」的**另一半**：超时链**不是**「没有来源」——
  // 它以「**这次超时**」为来源 ⇒ 计时器回调里自建一个 traceId + `source: 'timer'`
  //（spec §3 载体表的「定时器」行）。包裹点必须在 **`startTurnTimer` 的回调体**里：
  // 包在 `onTurnTimeout` 内部也能让超时那一行带上 id，但回调里其余逻辑（将来的）会重新
  // 掉回 `bootstrap` —— 判据钉的是「**这一轮**从头到尾都在同一条链上」。
  it('判据 11：回合计时器触发的一轮，日志带 source=timer 且 traceId 非空（无来源才该是 null）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'game-service' }));

    await service.startGame(startDto('ROOM-T11'));
    await service.bid('ROOM-T11', 'user-1', false); // 把行动者推进到座位 1（同偏差 C28 那条的前置）
    const before = (await service.getSession('ROOM-T11'))!;

    await vi.advanceTimersByTimeAsync(30_000);

    // 反空测：超时动作**真的发生了**（行动者被自动推进）—— 否则「日志行带 id」可能是
    // 因为定时器压根没触发、而记录里残留了别的行（假绿）。
    const after = (await service.getSession('ROOM-T11'))!;
    expect(
      after.bidPhase.currentBidder,
      '超时必须真的自动推进一步（否则本判据空转）',
    ).not.toBe(before.bidPhase.currentBidder);
    const line = records.find((r) => r.msg.includes('Turn timeout for room ROOM-T11'));
    expect(line, '超时那行日志必须在（否则本判据空转）').toBeDefined();
    expect(line!.source).toBe('timer');
    expect(line!.traceId).not.toBeNull();
  });
});
