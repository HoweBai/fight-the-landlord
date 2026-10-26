import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';

/**
 * 邀请码（spec §5.1）：
 * - 8 字符 `[A-HJ-NP-Z2-9]`（去掉 I/O/0/1），大写；
 * - 一代理同时只有一枚 active；轮换 = 旧码 revoked + 新码 active（调用方锁 agent 行）；
 * - `resolve` 返回代理状态，冻结/无效由调用方统一翻 `AGENT_INVITE_INVALID`。
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CREATE_ATTEMPTS = 8;

const CODE_INSERT_SQL =
  'INSERT INTO `agent_invite_codes` (`code`, `agent_id`, `status`) VALUES (?, ?, \'active\')';
const CODE_RESOLVE_SQL =
  'SELECT c.`agent_id`, a.`name`, a.`status` FROM `agent_invite_codes` c ' +
  'JOIN `agent_accounts` a ON a.`id` = c.`agent_id` ' +
  "WHERE c.`code` = ? AND c.`status` = 'active'";
const CODE_REVOKE_SQL =
  "UPDATE `agent_invite_codes` SET `status` = 'revoked' WHERE `agent_id` = ? AND `status` = 'active'";
const CODE_ACTIVE_SQL =
  "SELECT `code` FROM `agent_invite_codes` WHERE `agent_id` = ? AND `status` = 'active' ORDER BY `created_at` DESC LIMIT 1";

export interface ResolvedInvite {
  agentId: string;
  agentName: string;
  status: string;
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
      status: String(rows[0]!.status),
    };
  }

  /** 轮换（调用方必须已锁 agent 行 —— 防并发出现两枚 active）。 */
  async rotate(manager: EntityManager, agentId: string): Promise<string> {
    await manager.query(CODE_REVOKE_SQL, [agentId]);
    return this.createFor(manager, agentId);
  }

  async activeCode(agentId: string): Promise<string | null> {
    const rows = (await this.dataSource.query(CODE_ACTIVE_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    return rows.length === 0 ? null : String(rows[0]!.code);
  }
}
