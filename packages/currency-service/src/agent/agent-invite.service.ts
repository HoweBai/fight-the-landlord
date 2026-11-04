import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { affectedRowsOf } from './agent-sql.util';

/**
 * 邀请码（spec §5.1 / 2026-11-03 一次性化）：
 * - 8 字符 `[A-HJ-NP-Z2-9]`（去掉 I/O/0/1），大写；
 * - 一次性：`active → used`（消费）/ `active → revoked`（轮换/撤销）；used/revoked 终态；
 * - 一代理可同时持有多枚 active（自助批量生成）；轮换 = 作废全部 active + 新码 1 枚；
 * - `resolve` 同时返回码状态与代理状态，**不预先过滤码状态**，由调用方三档分类。
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CREATE_ATTEMPTS = 8;

const CODE_INSERT_SQL =
  'INSERT INTO `agent_invite_codes` (`code`, `agent_id`, `status`) VALUES (?, ?, \'active\')';
const CODE_RESOLVE_SQL =
  'SELECT c.`agent_id`, a.`name`, a.`status` AS `agent_status`, c.`status` AS `code_status` ' +
  'FROM `agent_invite_codes` c ' +
  'JOIN `agent_accounts` a ON a.`id` = c.`agent_id` ' +
  'WHERE c.`code` = ?';
const CODE_REVOKE_SQL =
  "UPDATE `agent_invite_codes` SET `status` = 'revoked' WHERE `agent_id` = ? AND `status` = 'active'";
const CODE_ACTIVE_SQL =
  "SELECT `code` FROM `agent_invite_codes` WHERE `agent_id` = ? AND `status` = 'active' " +
  'ORDER BY `created_at` DESC, `code` DESC LIMIT 1';

export interface ResolvedInvite {
  agentId: string;
  agentName: string;
  agentStatus: string;
  codeStatus: string;
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

function isDuplicate(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown };
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
}

@Injectable()
export class AgentInviteService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    return out;
  }

  async createFor(manager: EntityManager, agentId: string): Promise<string> {
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const code = this.generateCode();
      try {
        await manager.query(CODE_INSERT_SQL, [code, agentId]);
        return code;
      } catch (err) {
        if (isDuplicate(err)) continue; // 撞码重抽
        throw err;
      }
    }
    throw new Error(`邀请码生成失败：${CREATE_ATTEMPTS} 次均撞码（agentId=${agentId}）`);
  }

  async resolve(manager: EntityManager, code: string): Promise<ResolvedInvite | null> {
    const normalized = normalizeInviteCode(code);
    if (normalized.length === 0) return null;
    const rows = (await manager.query(CODE_RESOLVE_SQL, [normalized])) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return {
      agentId: String(rows[0]!.agent_id),
      agentName: String(rows[0]!.name),
      agentStatus: String(rows[0]!.agent_status),
      codeStatus: String(rows[0]!.code_status),
    };
  }

  /** 批量生成（同一事务内逐枚插入；撞码重试沿用 createFor）。 */
  async createMany(manager: EntityManager, agentId: string, count: number): Promise<string[]> {
    const codes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      codes.push(await this.createFor(manager, agentId));
    }
    return codes;
  }

  /** 轮换（调用方必须已锁 agent 行）：作废全部 active + 新码 1 枚。 */
  async rotate(manager: EntityManager, agentId: string): Promise<{ code: string; revoked: number }> {
    const result = await manager.query(CODE_REVOKE_SQL, [agentId]);
    const revoked = affectedRowsOf(result, 'agent_invite_codes revoke all');
    const code = await this.createFor(manager, agentId);
    return { code, revoked };
  }

  async activeCode(agentId: string): Promise<string | null> {
    const rows = (await this.dataSource.query(CODE_ACTIVE_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    return rows.length === 0 ? null : String(rows[0]!.code);
  }
}
