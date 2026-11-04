import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { AgentInviteSingleUse1798600000000 } from '../src/migrations/1798600000000-AgentInviteSingleUse';

function recordingRunner() {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const runner = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      return undefined;
    },
  } as unknown as QueryRunner;
  return { runner, statements };
}

describe('AgentInviteSingleUse 迁移', () => {
  it('up：加 used_by/used_at 两列；down：先重置 used 再删列', async () => {
    const migration = new AgentInviteSingleUse1798600000000();

    const up = recordingRunner();
    await migration.up(up.runner);
    expect(up.statements).toHaveLength(1);
    expect(up.statements[0]!.sql).toContain('ADD COLUMN `used_by` varchar(36)');
    expect(up.statements[0]!.sql).toContain('ADD COLUMN `used_at` datetime(3)');

    const down = recordingRunner();
    await migration.down(down.runner);
    expect(down.statements).toHaveLength(2);
    expect(down.statements[0]!.sql).toContain("SET `status` = 'active' WHERE `status` = 'used'");
    expect(down.statements[1]!.sql).toContain('DROP COLUMN `used_by`');
    expect(down.statements[1]!.sql).toContain('DROP COLUMN `used_at`');
  });

  it('形状（name/up/down）；迁移号 1798600000000 全仓唯一', () => {
    const migration = new AgentInviteSingleUse1798600000000();
    expect(migration.name).toBe('AgentInviteSingleUse1798600000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
