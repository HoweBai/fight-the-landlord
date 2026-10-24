import { describe, it, expect } from 'vitest';
import { GAME_META, type GameType } from '@fight-the-landlord/protocol';
import { GameRegistry } from '../src/games/registry';
import type { AnyGameRuntime } from '../src/games/runtime';

const fake = (gameType: GameType): AnyGameRuntime =>
  ({ gameType, meta: GAME_META[gameType] }) as unknown as AnyGameRuntime;

describe('GameRegistry', () => {
  it('注册/查找/has/list', () => {
    const registry = new GameRegistry();
    registry.register(fake('doudizhu'));
    registry.register(fake('paodekuai'));

    expect(registry.has('doudizhu')).toBe(true);
    expect(registry.has('paodekuai')).toBe(true);
    expect(registry.has('mahjong')).toBe(false);
    expect(registry.get('doudizhu').gameType).toBe('doudizhu');
    expect(registry.get('paodekuai').gameType).toBe('paodekuai');
    expect(registry.list().sort()).toEqual(['doudizhu', 'paodekuai']);
  });

  it('未知玩法响亮失败，绝不回落斗地主', () => {
    const registry = new GameRegistry();
    registry.register(fake('doudizhu'));
    expect(() => registry.get('paodekuai')).toThrow(/unknown game runtime/);
  });

  it('重复注册同一玩法 ⇒ 抛错', () => {
    const registry = new GameRegistry();
    registry.register(fake('doudizhu'));
    expect(() => registry.register(fake('doudizhu'))).toThrow(/already registered/);
  });
});
