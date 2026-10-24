import { describe, expect, it } from 'vitest';
import { ProtocolError } from './validate';
import { resolveGameType } from './views';

/**
 * S5.3 / spec §4.5.1：视图玩法解析的**唯一入口**。
 *
 * - 只有 `gameType` **缺失**才缺省斗地主（旧服务端视图）；
 * - 跑得快专属字段存在但 `gameType` 缺失 ⇒ 抛错（绝不把 pdk 当斗地主渲染）；
 * - 未知 id ⇒ 抛错（不得静默回落）。
 */
describe('resolveGameType', () => {
  const base = {
    roomCode: 'R1',
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: [],
    cardCounts: [0, 0, 0],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
  };

  it('旧服务端视图（无 gameType、无 pdk 字段）⇒ doudizhu', () => {
    expect(resolveGameType(base)).toBe('doudizhu');
    expect(resolveGameType({ ...base, gameType: 'doudizhu' })).toBe('doudizhu');
  });

  it('gameType=paodekuai ⇒ paodekuai', () => {
    expect(resolveGameType({ ...base, gameType: 'paodekuai' })).toBe('paodekuai');
  });

  it('pdk 专属字段存在但缺 gameType ⇒ ProtocolError（fail closed）', () => {
    expect(() => resolveGameType({ ...base, canPass: true } as never)).toThrow(ProtocolError);
    expect(() => resolveGameType({ ...base, pdkRules: {} } as never)).toThrow(/paodekuai fields/);
  });

  it('未知 gameType ⇒ ProtocolError（不静默当斗地主）', () => {
    expect(() => resolveGameType({ ...base, gameType: 'mahjong' } as never)).toThrow(ProtocolError);
  });
});
