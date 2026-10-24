import { describe, it, expect } from 'vitest';
import {
  GAME_META,
  GAME_TYPES,
  DEFAULT_GAME_TYPE,
  isGameType,
  parseGameType,
  supportsPlayerCount,
} from './game';
import { ProtocolError } from './validate';

describe('GameType / GameMeta', () => {
  it('规范 id 恰为 doudizhu/paodekuai，缺省斗地主', () => {
    expect(GAME_TYPES).toEqual(['doudizhu', 'paodekuai']);
    expect(DEFAULT_GAME_TYPE).toBe('doudizhu');
  });

  it('两玩法元数据：人数/默认人数/能力位', () => {
    expect(GAME_META.doudizhu.supportedPlayerCounts).toEqual([3]);
    expect(GAME_META.doudizhu.defaultPlayerCount).toBe(3);
    expect(GAME_META.doudizhu.capabilities.cardCounter).toBe(true);

    expect(GAME_META.paodekuai.supportedPlayerCounts).toEqual([2, 3, 4]);
    expect(GAME_META.paodekuai.defaultPlayerCount).toBe(3);
    expect(GAME_META.paodekuai.capabilities.cardCounter).toBe(false);
    expect(GAME_META.paodekuai.capabilities.voiceAnnouncements).toBe(false);
  });

  it('isGameType 只认规范 id', () => {
    expect(isGameType('doudizhu')).toBe(true);
    expect(isGameType('paodekuai')).toBe(true);
    expect(isGameType('ddz')).toBe(false);
    expect(isGameType('')).toBe(false);
    expect(isGameType(undefined)).toBe(false);
  });

  it('parseGameType：缺失/null 缺省斗地主；空串与拼错抛错', () => {
    expect(parseGameType(undefined)).toBe('doudizhu');
    expect(parseGameType(null)).toBe('doudizhu');
    expect(parseGameType('doudizhu')).toBe('doudizhu');
    expect(parseGameType('paodekuai')).toBe('paodekuai');
    expect(() => parseGameType('')).toThrow(ProtocolError);
    expect(() => parseGameType('ddz')).toThrow(ProtocolError);
    expect(() => parseGameType('mahjong')).toThrow(ProtocolError);
  });

  it('supportsPlayerCount：跑得快 2/3/4，斗地主仅 3', () => {
    expect(supportsPlayerCount('doudizhu', 3)).toBe(true);
    expect(supportsPlayerCount('doudizhu', 2)).toBe(false);
    expect(supportsPlayerCount('paodekuai', 2)).toBe(true);
    expect(supportsPlayerCount('paodekuai', 3)).toBe(true);
    expect(supportsPlayerCount('paodekuai', 4)).toBe(true);
    expect(supportsPlayerCount('paodekuai', 5)).toBe(false);
  });
});
