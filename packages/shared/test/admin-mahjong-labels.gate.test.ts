/**
 * 四川麻将番名一致性门禁（2026-10-29）。
 * admin 规则表单的 fanLabels 与对局内展示（shared scoring.ts 的 NAMED_LABELS）是两份拷贝；
 * 本闸保证**有交集的键**标签逐字一致，防止后台中文名与牌桌展示名漂移。
 * 这是补偿性一致性闸：现状应绿；若红，先对齐文案（不要放宽断言）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsLiteral } from '@fight-the-landlord/test-utils';
import { NAMED_LABELS } from '../src/mahjong/scoring';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    if (
      existsSync(anchor) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/shared/package.json）——绝不静默空测');
}

const REPO = findRepoRoot();
const form = extractJsLiteral(
  readFileSync(join(REPO, 'admin', 'app.js'), 'utf-8'),
  'MAHJONG_RULES_FORM',
) as { fanLabels: Record<string, string> };

describe('admin 番名 ⇄ 对局展示名', () => {
  it('有交集的番键标签逐字一致', () => {
    const overlap = Object.keys(NAMED_LABELS).filter((k) => k in form.fanLabels);
    expect(overlap.length).toBeGreaterThanOrEqual(25);
    for (const key of overlap) {
      expect(form.fanLabels[key], key).toBe(NAMED_LABELS[key]);
    }
  });
});
