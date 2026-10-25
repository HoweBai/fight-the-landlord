import { describe, expect, it } from 'vitest';
import { createCounter, createGauge } from './registry';
import { gameLabel, incGame, normalizeGameType, setGame } from './game-label';

describe('normalizeGameType', () => {
  it('合法玩法原样返回', () => {
    expect(normalizeGameType('doudizhu')).toBe('doudizhu');
    expect(normalizeGameType('paodekuai')).toBe('paodekuai');
  });

  it('缺省/空串/未知值一律归一为斗地主', () => {
    for (const value of [undefined, null, '', 'pdk', 'PAODEKUAI', 1, {}, []]) {
      expect(normalizeGameType(value), JSON.stringify(value)).toBe('doudizhu');
    }
  });
});

describe('incGame / setGame', () => {
  it('amount=0 保留零值序列（残差 0 口径）', async () => {
    const counter = createCounter('test_inc_game_zero_total', 'test', ['game_type', 'kind']);
    incGame(counter, 'paodekuai', 0, { kind: 'settle' });
    const { values } = await counter.get();
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { game_type: 'paodekuai', kind: 'settle' }, value: 0 },
      ]),
    );
  });

  it('amount=2 累加 2，且缺省玩法归 ddz', async () => {
    const counter = createCounter('test_inc_game_amount_total', 'test', ['game_type']);
    incGame(counter, 'paodekuai', 2);
    incGame(counter, undefined, 1);
    const { values } = await counter.get();
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { game_type: 'paodekuai' }, value: 2 },
        { labels: { game_type: 'doudizhu' }, value: 1 },
      ]),
    );
  });

  it('调用方传入 game_type 不能覆盖助手归一值', async () => {
    const counter = createCounter('test_inc_game_override_total', 'test', ['game_type', 'kind']);
    incGame(counter, 'paodekuai', 1, { kind: 'x', game_type: 'doudizhu' } as never);
    const { values } = await counter.get();
    const hit = values.find((v) => v.labels.kind === 'x');
    expect(hit?.labels.game_type).toBe('paodekuai');
  });

  it('setGame 写入 game_type；gameLabel 与助手一致', async () => {
    const gauge = createGauge('test_set_game_gauge', 'test', ['game_type']);
    setGame(gauge, 'paodekuai', 7);
    expect(await gauge.get()).toMatchObject({
      values: [{ labels: { game_type: 'paodekuai' }, value: 7 }],
    });
    expect(gameLabel('paodekuai')).toEqual({ game_type: 'paodekuai' });
  });
});
