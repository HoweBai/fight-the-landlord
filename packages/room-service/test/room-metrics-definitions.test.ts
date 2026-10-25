import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { incGame } from '@fight-the-landlord/shared';
import {
  entryFeeConflictTotal,
  gameStartFailuresTotal,
  gamesEndedTotal,
  gamesStartedTotal,
  recordWriteFailuresTotal,
  recordWriteSkipsTotal,
} from '../src/metrics/room.metrics';
import { exactSeriesValue } from './helpers/metric-readout';

describe('room 指标定义（A1）', () => {
  it('新增失败/跳过计数器带 game_type 且有界 reason/kind', async () => {
    incGame(gameStartFailuresTotal, 'paodekuai', 1, { reason: 'rules' });
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'rules',
    })).toBe(1);

    incGame(recordWriteFailuresTotal, 'paodekuai', 1, { kind: 'record_lost' });
    expect(await exactSeriesValue(recordWriteFailuresTotal, {
      game_type: 'paodekuai', kind: 'record_lost',
    })).toBe(1);

    incGame(recordWriteSkipsTotal, 'doudizhu', 1, { reason: 'room_ttl' });
    expect(await exactSeriesValue(recordWriteSkipsTotal, {
      game_type: 'doudizhu', reason: 'room_ttl',
    })).toBe(1);
  });

  it('既有指标已声明 game_type：incGame 后序列带该标签', async () => {
    incGame(gamesStartedTotal, 'paodekuai');
    expect(await exactSeriesValue(gamesStartedTotal, { game_type: 'paodekuai' })).toBeGreaterThan(0);

    incGame(gamesEndedTotal, undefined);
    expect(await exactSeriesValue(gamesEndedTotal, { game_type: 'doudizhu' })).toBeGreaterThan(0);

    incGame(entryFeeConflictTotal, 'paodekuai');
    expect(await exactSeriesValue(entryFeeConflictTotal, { game_type: 'paodekuai' })).toBeGreaterThan(0);
  });
});
