// packages/game-service/test/ddz-golden.test.ts
//
// Task 0.1：斗地主重构前的**冻结回归**。
//
// 首次生成：`UPDATE_GOLDEN=1 pnpm -C packages/game-service exec vitest run test/ddz-golden.test.ts`
// 之后每次跑测试都拿当前代码与冻结 JSON 逐字比较；S1 重构不得改变任何旧字段。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settleGame } from '@fight-the-landlord/shared';
import { buildPlayerView } from '../src/game/view.builder';
import { makeDdzGoldenSession } from './fixtures/ddz-golden-session';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures/ddz-golden.json');

function buildGoldenSnapshot() {
  const session = makeDdzGoldenSession();
  return {
    views: [0, 1, 2].map((seat) => buildPlayerView(session, seat)),
    settlement: settleGame(session),
    finished: { winner: 'landlord' as const },
  };
}

describe('斗地主 golden（重构前冻结）', () => {
  it('当前输出与冻结 JSON 逐字一致', () => {
    const actual = buildGoldenSnapshot();

    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(fixturePath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    }

    expect(existsSync(fixturePath), '缺少 ddz-golden.json；先跑 UPDATE_GOLDEN=1').toBe(true);
    const expected = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(actual).toEqual(expected);
  });

  it('golden 结算恰为旧 9 键（不得新增 gameType/scoreChanges）', () => {
    const { settlement } = buildGoldenSnapshot();
    expect(Object.keys(settlement).sort()).toEqual(
      [
        'baseScore',
        'farmerScoreChange',
        'farmerSeats',
        'landlordScoreChange',
        'landlordSeat',
        'multiplier',
        'roomCode',
        'spring',
        'winner',
      ].sort(),
    );
  });
});
