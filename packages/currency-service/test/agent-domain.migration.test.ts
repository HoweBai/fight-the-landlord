import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { AgentDomain1798000000000 } from '../src/migrations/1798000000000-AgentDomain';

const SRC_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

function recordingRunner() {
  const statements: string[] = [];
  const runner = {
    query: async (sql: string) => {
      statements.push(sql);
      return undefined;
    },
  } as unknown as QueryRunner;
  return { runner, statements };
}

const TABLES = [
  'agent_settings',
  'agent_accounts',
  'agent_invite_codes',
  'agent_bindings',
  'agent_binding_history',
  'agent_rates',
  'agent_status_history',
  'agent_player_quota',
  'agent_quota_inflows',
  'agent_admin_quota_credits',
  'agent_revenue_events',
  'agent_commission_entries',
  'agent_settlements',
  'agent_adjustments',
  'agent_admin_audit',
  'agent_ledger_gaps',
  'agent_settings_history',
] as const;

describe('AgentDomain 迁移：17 张表 + settings 种子', () => {
  it('up()：17 CREATE + 1 INSERT；逐表名/引擎/字符集', async () => {
    const { runner, statements } = recordingRunner();
    await new AgentDomain1798000000000().up(runner);

    expect(statements).toHaveLength(18);
    const creates = statements.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'));
    expect(creates).toHaveLength(17);
    for (const table of TABLES) {
      const hit = creates.filter((s) => s.includes(`CREATE TABLE IF NOT EXISTS \`${table}\``));
      expect(hit, `缺少表 ${table}`).toHaveLength(1);
      expect(hit[0]).toContain(
        'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
      );
    }
    const seeds = statements.filter((s) =>
      s.includes('INSERT IGNORE INTO `agent_settings` (`id`) VALUES (1)'),
    );
    expect(seeds, 'settings 种子行恰好一条').toHaveLength(1);
  });

  it('关键默认值：watermark/carry/token_version 非空默认 0；must_change_password 默认 1；pending 可空', async () => {
    const { runner, statements } = recordingRunner();
    await new AgentDomain1798000000000().up(runner);
    const accounts = statements.find((s) => s.includes('`agent_accounts`'))!;
    for (const column of [
      '`micro_carry` bigint NOT NULL DEFAULT 0',
      '`settled_watermark` bigint NOT NULL DEFAULT 0',
      '`token_version` int NOT NULL DEFAULT 0',
      '`must_change_password` tinyint(1) NOT NULL DEFAULT 1',
      '`pending_settlement_id` bigint NULL DEFAULT NULL',
      'UNIQUE KEY `uk_agent_phone` (`phone`)',
    ]) {
      expect(accounts, `agent_accounts 缺 ${column}`).toContain(column);
    }
  });

  it('关键唯一键/索引：revenue/commission/settlement/quota', async () => {
    const { runner, statements } = recordingRunner();
    await new AgentDomain1798000000000().up(runner);
    const sqlOf = (table: string) =>
      statements.find((s) => s.includes(`CREATE TABLE IF NOT EXISTS \`${table}\``))!;

    expect(sqlOf('agent_revenue_events')).toContain(
      'UNIQUE KEY `uk_re_owner_op` (`source_op_id`, `owner_id`)',
    );
    expect(sqlOf('agent_revenue_events')).toContain('`skipped_reason` varchar(20) NULL DEFAULT NULL');
    expect(sqlOf('agent_revenue_events')).toContain('`top_rate_bp` int NOT NULL DEFAULT 0');
    expect(sqlOf('agent_commission_entries')).toContain(
      'UNIQUE KEY `uk_ce_op_agent` (`source_op_id`, `agent_id`)',
    );
    expect(sqlOf('agent_commission_entries')).not.toContain('settlement_id');
    expect(sqlOf('agent_settlements')).toContain(
      'UNIQUE KEY `uk_settlement_client` (`agent_id`, `client_request_id`)',
    );
    expect(sqlOf('agent_settlements')).toContain('`from_entry_id` bigint NOT NULL DEFAULT 0');
    expect(sqlOf('agent_settlements')).toContain('`to_entry_id` bigint NOT NULL DEFAULT 0');
    expect(sqlOf('agent_settlements')).toContain('`items_hash` char(64) NOT NULL');
    expect(sqlOf('agent_player_quota')).toContain('PRIMARY KEY (`owner_id`)');
    expect(sqlOf('agent_bindings')).toContain('`phone_masked` varchar(20) NOT NULL');
    expect(sqlOf('agent_quota_inflows')).toContain(
      'UNIQUE KEY `uk_qi_op_owner` (`source_op_id`, `owner_id`)',
    );
    expect(sqlOf('agent_admin_quota_credits')).toContain('PRIMARY KEY (`owner_id`, `day`)');
  });

  it('down()：17 DROP、逆序（settings_history 先、settings 后）', async () => {
    const { runner, statements } = recordingRunner();
    await new AgentDomain1798000000000().down(runner);
    expect(statements).toHaveLength(17);
    expect(statements[0]).toBe('DROP TABLE IF EXISTS `agent_settings_history`');
    expect(statements.at(-1)).toBe('DROP TABLE IF EXISTS `agent_settings`');
    expect(new Set(statements)).toEqual(
      new Set(TABLES.map((t) => `DROP TABLE IF EXISTS \`${t}\``)),
    );
  });

  it('类名不以 Currency 开头；时间戳 1798000000000 全仓唯一', () => {
    expect(AgentDomain1798000000000.name).not.toMatch(/^Currency/);
    const packagesDir = join(SRC_DIR, '..', '..');
    const hits: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1798000000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['currency-service/AgentDomain1798000000000']);
  });
});
