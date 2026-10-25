import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@fight-the-landlord/test-utils';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGETS = [
  'gamesStartedTotal', 'gamesEndedTotal', 'roomsActive', 'gamesActive',
  'currencySettleResultTotal', 'currencySettleResidueTotal',
  'currencySettleOutboxSize', 'currencySettleOutboxOldestSeconds',
  'entryFeeSkippedTotal', 'entryFeeConflictTotal',
  'currencyRobotTopupTotal', 'currencyRobotEnsureFailedTotal',
  'matchPredicateRejectionsTotal', 'matchSelectionRoundsTotal', 'matchNoLegalGroupTotal',
  'recordsRowsDeletedTotal', 'robotDecisionsTotal', 'robotDecisionErrorsTotal',
  'robotRuleErrorsTotal', 'riskScanHitsTotal',
  'gameStartFailuresTotal', 'gameSettleFailuresTotal',
  'recordWriteFailuresTotal', 'recordWriteSkipsTotal',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('A1 源码闸：指标写点必须经 incGame/setGame', () => {
  it('src 下不得直接对目标指标 .inc()/.set()/.labels()', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'packages'))) {
      if (file.includes(`${sep}test${sep}`) || file.endsWith('.test.ts')) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const name of TARGETS) {
        if (new RegExp(`\\b${name}\\s*\\??\\s*\\.\\s*(inc|set|labels)\\b`).test(src)) {
          offenders.push(`${file.replace(ROOT, '')}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('闸的正例自证：直写形态会被识别（防目标名拼错静默失效）', () => {
    expect(new RegExp('\\bgamesStartedTotal\\s*\\??\\s*\\.\\s*(inc|set|labels)\\b').test('gamesStartedTotal.inc();')).toBe(true);
    expect(new RegExp('\\bgamesStartedTotal\\s*\\??\\s*\\.\\s*(inc|set|labels)\\b').test('gamesStartedTotal?.set({});')).toBe(true);
  });
});
