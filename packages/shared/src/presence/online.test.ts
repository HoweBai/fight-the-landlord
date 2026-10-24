import { describe, expect, it } from 'vitest';
import {
  ONLINE_PRUNE_MS,
  ONLINE_TTL_MS,
  ONLINE_USERS_KEY,
  PLAYERS_SUMMARY_KEY,
} from './online';

describe('presence 共享契约', () => {
  it('键名与窗口值固定（跨服务单一真源）', () => {
    expect(ONLINE_USERS_KEY).toBe('presence:online');
    expect(PLAYERS_SUMMARY_KEY).toBe('players:summary');
    expect(ONLINE_TTL_MS).toBe(60_000);
    expect(ONLINE_PRUNE_MS).toBe(300_000);
  });
});
