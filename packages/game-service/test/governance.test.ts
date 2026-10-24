/**
 * 挂机治理（T3）：game-service 侧的**核心**判据。
 *
 * 覆盖（任务书 Step 2 清单）：
 *  - C10  三档时长（叫抢/出牌同效，`deadlineFor` 纯算 + 计时器真按该档触发的行为面）
 *  - C1   超时成功 ⇒ count+1；count ≥ after ⇒ trustee（用 ≥）
 *  - C2   超时动作抛错 ⇒ 不计数、不改会话（负对照）
 *  - C2b  两处 catch（`applyAction` 动作被拒 / `onTurnTimeout` 超时失败）都按 **normal** 档重挂
 *  - C3   手动动作成功 ⇒ 复位**写在 handler 返回的 updated 上**（出牌 / 定地主两条新数组路径）
 *         + 负对照：超时自动动作**不**复位
 *  - C6   非行动者动作 ⇒ 治理量不变
 *  - C5   `botIds` 座位不计数/不托管
 *  - C10b 机器人行动后的 deadline 按**下一行动者**档写（`:722` 写入点）
 *  - C6b  旧会话缺字段 ⇒ 读出 0/false；坏形状不炸、不落错档
 *  - startTurnTimer 时长优先级：overrideMs > forceNormal > 默认档
 *
 * ⚠️ 机器人判定**只**用 `session.botIds?.[seatIdx] !== undefined`（夹具里 bot 座位的
 * `isBot` 保持 false —— 生产形态就是恒 false；⛔ 用 `isBot` 的实现在这里会红）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameState, type GamePlayer, type GameSession } from '@fight-the-landlord/shared';
import type { Card } from '@fight-the-landlord/protocol';
import { buildPlayerView } from '../src/game/view.builder';
import { GameService } from '../src/game/game.service';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/** 牌是 `{r, s}`；本文件只关心点数（s 统一取 0）。 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

const ROOM = 'GOV01';

/** 注入态：normal 1500 / accel 1000 / trustee 400 / 阈值 3（与 conformance 同值）。 */
const ENV: Record<string, string> = {
  GAME_TURN_TIMEOUT_MS: '1500',
  GAME_TURN_TIMEOUT_ACCEL_MS: '1000',
  GAME_TRUSTEE_DELAY_MS: '400',
  GAME_TRUSTEE_AFTER: '3',
};
const ENV_KEYS = Object.keys(ENV);
let savedEnv: Record<string, string | undefined> = {};

function player(seat: number, over: Partial<GamePlayer> = {}): GamePlayer {
  return {
    id: `player-${seat}`,
    seat,
    hand: h(3, 4, 5, 6, 7),
    isLandlord: false,
    isBot: false,
    isOffline: false,
    timeoutCount: 0,
    trustee: false,
    ...over,
  };
}

const BID_PHASE: GameSession['bidPhase'] = {
  currentBidder: 0,
  landlordCaller: -1,
  landlordCandidate: -1,
  bidPasses: 0,
  grabActions: 0,
  bidMultiplier: 1,
  redealCount: 0,
  decisions: [],
  firstCaller: -1,
  antiRobGranted: false,
};

function makeSession(over: Partial<GameSession> = {}): GameSession {
  const base: GameSession = {
    roomCode: ROOM,
    gameType: 'doudizhu',
    playerCount: 3,
    baseScore: 100,
    state: GameState.Playing,
    players: [player(0), player(1), player(2)],
    bottomCards: h(8, 9, 10),
    currentPlayer: 0,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    turnDeadlineAt: 0,
    version: 1,
    actionLog: [],
    bidPhase: { ...BID_PHASE },
    playPhase: { bombCount: 0, landlordPlays: 0, farmerPlays: 0, consecutivePasses: 0 },
    createdAt: 0,
    finishedAt: null,
  };
  return { ...base, ...over };
}

function biddingSession(over: Partial<GameSession> = {}): GameSession {
  return makeSession({ state: GameState.Bidding, bidPhase: { ...BID_PHASE }, ...over });
}

describe('挂机治理核心（T3）', () => {
  let service: GameService;

  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = ENV[key];
    }
    service = new GameService(redisDouble as unknown as Redis);
    // 片① R1：起始座位确定（座位 0 先叫）。
    service.random = () => 0;
    // §9.4 的注入缝：0 思考延迟（本文件不真发网络）。
    service.robotDelay = async () => {};
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.useRealTimers();
  });

  // ─── C10：三档时长（deadlineFor + 计时器行为面） ─────────────────────

  const TIERS = [
    { name: 'normal', gov: { timeoutCount: 0, trustee: false }, ms: 1500 },
    { name: 'accel', gov: { timeoutCount: 1, trustee: false }, ms: 1000 },
    { name: 'trustee', gov: { timeoutCount: 3, trustee: true }, ms: 400 },
  ] as const;

  describe('C10：回合时长按行动者治理态分档（叫抢 / 出牌同效）', () => {
    for (const phase of ['bidding', 'playing'] as const) {
      for (const tier of TIERS) {
        it(`${phase} · ${tier.name} ⇒ ${tier.ms}ms（deadlineFor + 计时器真的按该档触发）`, async () => {
          const actor = 1;
          const players = [0, 1, 2].map((seat) => player(seat, seat === actor ? tier.gov : {}));
          const session =
            phase === 'bidding'
              ? biddingSession({ players, bidPhase: { ...BID_PHASE, currentBidder: actor } })
              : makeSession({ players, currentPlayer: actor });

          // ① 纯算：deadlineFor 按**行动者**档。
          expect(service['deadlineFor'](session) - Date.now()).toBe(tier.ms);

          // ② 行为面：startTurnTimer 的默认时长与 deadlineFor 同源。
          const room = `GOV-C10-${phase}-${tier.name}`;
          service['cache'].set(room, session);
          service['startTurnTimer'](room, session);
          await vi.advanceTimersByTimeAsync(tier.ms - 1);
          expect((await service.getSession(room))!.version).toBe(session.version);
          await vi.advanceTimersByTimeAsync(1);
          expect((await service.getSession(room))!.version).toBe(session.version + 1);
        });
      }
    }
  });

  // ─── C1 / C2 ────────────────────────────────────────────────────

  describe('C1：超时成功 ⇒ count+1；count ≥ after ⇒ trustee', () => {
    const rows = [
      { start: 0, trustee: false, ms: 1500, nextCount: 1, nextTrustee: false },
      { start: 2, trustee: false, ms: 1000, nextCount: 3, nextTrustee: true },
      { start: 5, trustee: true, ms: 400, nextCount: 6, nextTrustee: true },
    ] as const;

    for (const row of rows) {
      it(`count ${row.start} ⇒ ${row.nextCount}（trustee=${String(row.nextTrustee)}）`, async () => {
        const room = `GOV-C1-${row.start}`;
        const session = makeSession({
          players: [player(0), player(1, { timeoutCount: row.start, trustee: row.trustee }), player(2)],
          currentPlayer: 1,
        });
        service['cache'].set(room, session);
        service['startTurnTimer'](room, session);

        await vi.advanceTimersByTimeAsync(row.ms);

        const after = (await service.getSession(room))!;
        expect(after.version).toBe(session.version + 1); // 自动动作**真的成功了**
        expect(after.players[1]!.timeoutCount).toBe(row.nextCount);
        expect(after.players[1]!.trustee).toBe(row.nextTrustee);
      });
    }
  });

  it('C2：超时动作抛错 ⇒ 不计数、不改会话（负对照）', async () => {
    const room = 'GOV-C2';
    const session = makeSession({
      // 不可能状态：行动者手牌为空 ⇒ handlePlayTimeout 抛错（R106 分支）
      players: [player(0), player(1, { hand: [], timeoutCount: 2 }), player(2)],
      currentPlayer: 1,
    });
    service['cache'].set(room, session);
    service['startTurnTimer'](room, session); // accel 档（count=2）⇒ 1000ms
    const errorSpy = vi.spyOn(service['logger'], 'error');

    await vi.advanceTimersByTimeAsync(1000);

    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('has no card to play');
    const after = (await service.getSession(room))!;
    expect(after.version).toBe(session.version); // 不编造状态转移
    expect(after.players[1]!.timeoutCount).toBe(2); // 不计数
    expect(after.players[1]!.trustee).toBe(false); // 不托管
    errorSpy.mockRestore();
  });

  // ─── C2b：R106 错误重挂按 normal 档（两处 catch） ─────────────────

  describe('C2b：错误重挂按 normal 档（即使行动者处于 trustee 也不用 400）', () => {
    it('① applyAction 动作被拒（:427 catch）', async () => {
      const room = 'GOV-C2B-1';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 3, trustee: true }), player(2)],
        currentPlayer: 1,
      });
      service['cache'].set(room, session);
      service['startTurnTimer'](room, session); // 初始档位无关：被拒后会重挂

      // 行动者投一张不在手中的牌 ⇒ 规则拒绝（不是 Not your turn）。
      await expect(service.playCards(room, 'player-1', [{ r: 14, s: 0 }])).rejects.toThrow(
        /not in hand/,
      );
      // 拒绝不等于一次状态转移。
      expect((await service.getSession(room))!.version).toBe(session.version);

      // 重挂时长 = normal(1500)，而 trustee 短档 = 400ms：**先越过 400ms** 才有判别力。
      // 若错用 trustee 档，定时器在第 400ms 已触发（version +1）⇒ 401ms 处断言必红。
      await vi.advanceTimersByTimeAsync(401);
      expect((await service.getSession(room))!.version).toBe(session.version);
      // 剩余 1099ms（累计 1500）：正确的 normal 档恰好在此触发一次。
      await vi.advanceTimersByTimeAsync(1099);
      expect((await service.getSession(room))!.version).toBe(session.version + 1);
    });

    it('② onTurnTimeout 超时失败（:793 catch）', async () => {
      const room = 'GOV-C2B-2';
      const session = makeSession({
        players: [player(0), player(1, { hand: [], timeoutCount: 3, trustee: true }), player(2)],
        currentPlayer: 1,
      });
      service['cache'].set(room, session);
      service['startTurnTimer'](room, session); // trustee 档 ⇒ 400ms 后第一次超时
      const errorSpy = vi.spyOn(service['logger'], 'error');

      await vi.advanceTimersByTimeAsync(400);
      expect(errorSpy).toHaveBeenCalledTimes(1); // 第一次超时失败（R106 catch）

      // 重挂 = normal(1500)。若错用 trustee(400)，再过 400ms 就会有第二次失败。
      await vi.advanceTimersByTimeAsync(399);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1101);
      expect(errorSpy).toHaveBeenCalledTimes(2);

      const after = (await service.getSession(room))!;
      expect(after.version).toBe(session.version); // 全程不编造转移
      expect(after.players[1]!.timeoutCount).toBe(3); // 失败不计数
      expect(after.players[1]!.trustee).toBe(true);
      errorSpy.mockRestore();
    });
  });

  // ─── C3：手动动作成功复位（updated 上生效） ─────────────────────

  describe('C3：手动回合消耗型动作成功 ⇒ 复位（写在 updated 上）', () => {
    it('① 出牌成功（handlePlayCards 的新 players 数组路径）', async () => {
      const room = 'GOV-C3-PLAY';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 2, trustee: true }), player(2)],
        currentPlayer: 1,
      });
      service['cache'].set(room, session);

      const updated = await service.playCards(room, 'player-1', h(3));

      // 判据在 handler 返回的新会话上：写 session.players 会静默丢（旧数组不是落盘对象）。
      expect(updated.players[1]!.timeoutCount).toBe(0);
      expect(updated.players[1]!.trustee).toBe(false);
      // 反向：原会话对象未被改写（复位只发生在 updated 上，且只对行动者）。
      expect(session.players[1]!.timeoutCount).toBe(2);
      expect(session.players[1]!.trustee).toBe(true);
      // 落盘后的缓存同样是复位态。
      expect((await service.getSession(room))!.players[1]).toMatchObject({
        timeoutCount: 0,
        trustee: false,
      });
    });

    it('② 定地主成功（finalizeBidding 的新 players 数组路径）', async () => {
      const room = 'GOV-C3-BID';
      const session = biddingSession({
        players: [player(0), player(1, { timeoutCount: 2, trustee: true }), player(2)],
        bidPhase: {
          ...BID_PHASE,
          currentBidder: 1,
          grabActions: 2,
          landlordCaller: 0,
          landlordCandidate: 0,
          firstCaller: 0,
          bidMultiplier: 2,
          decisions: [
            { seat: 0, kind: 'call', grab: true },
            { seat: 2, kind: 'call', grab: false },
          ],
        },
      });
      service['cache'].set(room, session);

      const updated = await service.bid(room, 'player-1', false);

      expect(updated.state).toBe(GameState.Playing); // 真的走了定地主路径
      expect(updated.players[1]!.timeoutCount).toBe(0);
      expect(updated.players[1]!.trustee).toBe(false);
      // 非行动者（地主）的治理量不受影响。
      expect(updated.players[0]).toMatchObject({ timeoutCount: 0, trustee: false });
    });

    it('负对照：超时自动动作**不**复位（托管中的人继续累计）', async () => {
      const room = 'GOV-C3-NEG';
      const session = makeSession({
        players: [player(0), player(1, { timeoutCount: 3, trustee: true }), player(2)],
        currentPlayer: 1,
      });
      service['cache'].set(room, session);
      service['startTurnTimer'](room, session);

      await vi.advanceTimersByTimeAsync(400);

      const after = (await service.getSession(room))!;
      expect(after.version).toBe(session.version + 1);
      expect(after.players[1]!.timeoutCount).toBe(4); // 继续累加，不是清零
      expect(after.players[1]!.trustee).toBe(true); // 仍是托管
    });
  });

  // ─── C6：非行动者动作不改治理量 ─────────────────────────────────

  it('C6：非行动者动作被拒 ⇒ 双方治理量都不变', async () => {
    const room = 'GOV-C6';
    const session = makeSession({
      players: [
        player(0, { timeoutCount: 1 }),
        player(1, { timeoutCount: 2, trustee: true }),
        player(2),
      ],
      currentPlayer: 0,
    });
    service['cache'].set(room, session);

    await expect(service.playCards(room, 'player-1', h(3))).rejects.toThrow(/Not your turn/);

    const after = (await service.getSession(room))!;
    expect(after.version).toBe(session.version);
    expect(after.players[0]).toMatchObject({ timeoutCount: 1, trustee: false });
    expect(after.players[1]).toMatchObject({ timeoutCount: 2, trustee: true });
  });

  // ─── C5：botIds 座位豁免 ───────────────────────────────────────

  it('C5：botIds 座位超时不计数、不托管（⛔ 不看 isBot——它生产恒 false）', async () => {
    const room = 'GOV-C5';
    const session = makeSession({
      players: [player(0), player(1), player(2)], // 座位 0 的 isBot 保持 false（生产形态）
      currentPlayer: 0,
      botIds: ['bot-0', undefined, undefined],
    });
    service['cache'].set(room, session);
    service['startTurnTimer'](room, session);

    await vi.advanceTimersByTimeAsync(1500); // 机器人座位 ⇒ normal 档

    const after = (await service.getSession(room))!;
    expect(after.version).toBe(session.version + 1); // 自动动作真的发生了
    expect(after.players[0]!.timeoutCount).toBe(0); // 不计数
    expect(after.players[0]!.trustee).toBe(false); // 不托管
  });

  // ─── C10b：机器人行动后 deadline 按下一行动者档（:722 写入点） ──

  describe('C10b：机器人行动后的 deadline 按**下一行动者**档', () => {
    const rows = [
      { name: 'trustee-next', next: { timeoutCount: 3, trustee: true }, ms: 400 },
      { name: 'accel-next', next: { timeoutCount: 1, trustee: false }, ms: 1000 },
      { name: 'normal-next', next: { timeoutCount: 0, trustee: false }, ms: 1500 },
    ] as const;

    for (const row of rows) {
      it(`${row.name} ⇒ ${row.ms}ms（⛔ 不用刚行动的机器人档）`, async () => {
        const room = `GOV-C10B-${row.name}`;
        const session = makeSession({
          players: [player(0), player(1, row.next), player(2)],
          currentPlayer: 0,
          botIds: ['bot-0', undefined, undefined],
        });
        service['cache'].set(room, session);
        const view = buildPlayerView(session, 0);

        const advanced = await service['commitRobotDecision'](
          room,
          session,
          'player-0',
          { kind: 'play', cards: [3] },
          view,
        );

        expect(advanced).toBe(true);
        const after = (await service.getSession(room))!;
        expect(after.currentPlayer).toBe(1); // 下一行动者 = 座位 1
        expect(after.turnDeadlineAt - Date.now()).toBe(row.ms);
        // 机器人座位自身从不累积治理量。
        expect(after.players[0]).toMatchObject({ timeoutCount: 0, trustee: false });
      });
    }
  });

  // ─── C6b：旧会话迁移 / 坏形状 ──────────────────────────────────

  describe('C6b：loadSession 缺字段迁移', () => {
    it('旧会话缺 timeoutCount/trustee ⇒ 读出 0/false，且 duration 落 normal 档', async () => {
      const old = makeSession({ roomCode: 'GOV-OLD', currentPlayer: 0 });
      const raw = JSON.parse(JSON.stringify(old)) as Record<string, unknown> & {
        players: Array<Record<string, unknown>>;
      };
      for (const p of raw.players) {
        delete p.timeoutCount;
        delete p.trustee;
      }
      redisDouble._store.set('game:session:GOV-OLD', JSON.stringify(raw));

      const loaded = await service.loadSession('GOV-OLD');

      expect(loaded).not.toBeNull();
      for (const p of loaded!.players) {
        expect(p.timeoutCount).toBe(0);
        expect(p.trustee).toBe(false);
      }
      // 「不落错档」：迁移后按 normal 档，而不是 NaN/accel。
      expect(service['deadlineFor'](loaded!)).toBe(Date.now() + 1500);
    });

    it('坏形状不炸：players 缺失 ⇒ 按既有约定返回 null（fail-closed）', async () => {
      redisDouble._store.set(
        'game:session:GOV-BAD',
        JSON.stringify({ roomCode: 'GOV-BAD', state: GameState.Playing }),
      );
      await expect(service.loadSession('GOV-BAD')).resolves.toBeNull();
    });

    it('governanceOf：缺位 / 缺字段都不抛，安全缺省 {0,false}', () => {
      expect(service['governanceOf'](undefined)).toEqual({ timeoutCount: 0, trustee: false });
      expect(service['governanceOf']({} as never)).toEqual({ timeoutCount: 0, trustee: false });
    });
  });

  // ─── startTurnTimer 时长优先级（逐字：overrideMs > forceNormal > 默认） ──

  it('startTurnTimer 优先级：overrideMs > forceNormal > 默认档', async () => {
    const room = 'GOV-PRIORITY';
    // 行动者处于 trustee（默认档 = 400）；同时给 forceNormal 与 overrideMs ⇒ 250 必须赢。
    const session = makeSession({
      players: [player(0), player(1, { timeoutCount: 3, trustee: true }), player(2)],
      currentPlayer: 1,
    });
    service['cache'].set(room, session);

    service['startTurnTimer'](room, session, { forceNormal: true, overrideMs: 250 });

    await vi.advanceTimersByTimeAsync(249);
    expect((await service.getSession(room))!.version).toBe(session.version);
    await vi.advanceTimersByTimeAsync(1);
    expect((await service.getSession(room))!.version).toBe(session.version + 1);
  });
});
