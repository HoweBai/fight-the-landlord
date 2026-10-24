import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrCode, type Card } from '@fight-the-landlord/protocol';
import type { PdkSession } from '@fight-the-landlord/shared';
import { resetRedisDouble } from './helpers-ioredis';
import { pdkService } from './helpers-pdk';
import { fullGameDeck, pdkPlayers } from './fixtures/pdk-fixtures';

/**
 * Task 4.4（spec §5.2 / RH6）：`game.start.seed` / `testDeck` 的**内部测试钩子**。
 *
 * 判据：
 *  - `INTERNAL_TEST_HOOKS !== '1'` ⇒ 字段被**忽略 + WARN**（不拒绝、不 10001）；
 *  - 开启时 testDeck 生效（按座位切份）、seed 确定性（同 seed 同手牌）；
 *  - 非法 testDeck（张数/合法集/重复）⇒ `10001`（ProtocolError 在 startGame 边界翻译）。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

const ORIGINAL = process.env.INTERNAL_TEST_HOOKS;

function startDto(roomCode: string, extra: Record<string, unknown> = {}) {
  return {
    roomCode,
    gameType: 'paodekuai' as const,
    playerCount: 3,
    baseScore: 15,
    players: pdkPlayers([]),
    ...extra,
  };
}

describe('Task 4.4：pdk seed/testDeck 测试钩子', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL === undefined) delete process.env.INTERNAL_TEST_HOOKS;
    else process.env.INTERNAL_TEST_HOOKS = ORIGINAL;
  });

  it('关闭时：非法 testDeck 被忽略 + WARN（不 10001），按随机发牌开局', async () => {
    delete process.env.INTERNAL_TEST_HOOKS;
    const service = pdkService();
    const warn = vi.spyOn(service['logger'], 'warn');
    const invalidDeck = fullGameDeck().slice(0, 47); // 张数不对 ⇒ 若被使用必然 10001

    await service.startGame(startDto('HOOK-OFF', { testDeck: invalidDeck, seed: 1 }));

    const session = (await service.getSession<PdkSession>('HOOK-OFF'))!;
    expect(session.players.map((p) => p.hand.length)).toEqual([16, 16, 16]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring test hooks'));
  });

  it('开启 + 合法 testDeck：按座位切份（seat0 = 牌堆前 16 张）', async () => {
    process.env.INTERNAL_TEST_HOOKS = '1';
    const service = pdkService();
    const deck = fullGameDeck();

    await service.startGame(startDto('HOOK-DECK', { testDeck: deck }));

    const session = (await service.getSession<PdkSession>('HOOK-DECK'))!;
    expect(session.players[0]!.hand).toEqual(deck.slice(0, 16));
    expect(session.players[1]!.hand).toEqual(deck.slice(16, 32));
    expect(session.players[2]!.hand).toEqual(deck.slice(32, 48));
    expect(session.currentPlayer).toBe(0);
  });

  it('开启 + seed：同 seed 同手牌（确定性），不同 seed 不同手牌', async () => {
    process.env.INTERNAL_TEST_HOOKS = '1';
    const service = pdkService();

    await service.startGame(startDto('HOOK-S42A', { seed: 42 }));
    await service.startGame(startDto('HOOK-S42B', { seed: 42 }));
    await service.startGame(startDto('HOOK-S43', { seed: 43 }));

    const handOf = async (room: string): Promise<Card[][]> =>
      (await service.getSession<PdkSession>(room))!.players.map((p) => p.hand);
    const a = await handOf('HOOK-S42A');
    const b = await handOf('HOOK-S42B');
    const c = await handOf('HOOK-S43');

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('开启 + 非法 testDeck：张数/重复/非法牌 ⇒ 10001', async () => {
    process.env.INTERNAL_TEST_HOOKS = '1';
    const service = pdkService();
    const valid = fullGameDeck();
    const cases: Array<[string, Card[]]> = [
      ['张数不是 48', valid.slice(0, 47)],
      ['重复牌', [...valid.slice(0, 47), { ...valid[0]! }]],
      ['牌不在 pdk 合法集', [...valid.slice(0, 47), { r: 15, s: 0 }]],
    ];

    for (const [label, deck] of cases) {
      let error: unknown;
      try {
        await service.startGame(startDto(`HOOK-BAD-${label}`, { testDeck: deck }));
      } catch (err) {
        error = err;
      }
      expect(error, label).toMatchObject({ code: ErrCode.BAD_PARAM });
    }
  });

  it('非法规则快照同样在 startGame 边界翻成 10001（不是 500）', async () => {
    process.env.INTERNAL_TEST_HOOKS = '1';
    const service = pdkService();
    let error: unknown;
    try {
      await service.startGame(startDto('HOOK-RULES', { rules: { multiplierCap: 0 } }));
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: ErrCode.BAD_PARAM });
  });
});
