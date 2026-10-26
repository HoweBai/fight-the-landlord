import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { ConfigCacheService } from '../config/config-cache.service';
import { AgentSettingsService } from './agent-settings.service';
import { AgentInviteService } from './agent-invite.service';
import { hmacPhone, maskPhone, normalizePhone, toDate } from './agent.util';

const BIND_INSERT_IGNORE_SQL =
  'INSERT IGNORE INTO `agent_bindings` (`owner_id`, `agent_id`, `source`, `bound_by`, `phone_hash`, `phone_masked`) ' +
  "VALUES (?, ?, 'signup', NULL, ?, ?)";
const BIND_SELECT_SQL =
  'SELECT `agent_id`, `phone_hash`, `phone_masked`, `bound_at`, `source` FROM `agent_bindings` WHERE `owner_id` = ?';
const BIND_SELECT_FOR_UPDATE_SQL = `${BIND_SELECT_SQL} FOR UPDATE`;
const BIND_UPDATE_SQL =
  "UPDATE `agent_bindings` SET `agent_id` = ?, `bound_at` = NOW(3), `source` = 'admin', " +
  '`bound_by` = ?, `phone_hash` = ?, `phone_masked` = ? WHERE `owner_id` = ?';
const BIND_DELETE_SQL = 'DELETE FROM `agent_bindings` WHERE `owner_id` = ?';
const BIND_LIST_SQL =
  'SELECT `owner_id`, `phone_masked`, `bound_at`, `source` FROM `agent_bindings` WHERE `agent_id` = ? ' +
  'ORDER BY `bound_at` DESC, `owner_id` DESC LIMIT ? OFFSET ?';
const BIND_COUNT_SQL = 'SELECT COUNT(*) AS `cnt` FROM `agent_bindings` WHERE `agent_id` = ?';
const BIND_CHUNK_SQL =
  'SELECT `owner_id` FROM `agent_bindings` WHERE `agent_id` = ? AND `owner_id` > ? ' +
  'ORDER BY `owner_id` LIMIT 500';
const BIND_BULK_UPDATE_SQL =
  "UPDATE `agent_bindings` SET `agent_id` = ?, `bound_at` = NOW(3), `source` = 'admin', " +
  '`bound_by` = ? WHERE `owner_id` = ?';
const AGENT_STATUS_SELECT_FOR_UPDATE_SQL =
  'SELECT `status` FROM `agent_accounts` WHERE `id` = ? FOR UPDATE';
const HISTORY_INSERT_SQL =
  'INSERT INTO `agent_binding_history` (`owner_id`, `agent_id`, `action`, `actor`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?)';
const AUDIT_INSERT_SQL =
  'INSERT INTO `agent_admin_audit` (`actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';

export interface BindResult {
  status: 'bound' | 'already_bound' | 'ignored';
}

export interface BindingRow {
  ownerId: string;
  agentId: string;
  boundAt: Date | null;
  source: string;
  phoneMasked: string;
}

export const AGENT_BULK_REBIND_MAX = 5_000;

function affectedRowsOf(result: unknown, context: string): number {
  const n = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）`);
  }
  return n;
}

/**
 * 玩家归属（spec §5.2/§5.3）。
 *
 * - 注册绑定：两个开关都开才绑；码在**同一事务**内重新解析（消除 TOCTOU）；
 *   `INSERT IGNORE` 首绑为准；
 * - 管理改绑/解绑/批量：只影响之后；history + audit 必写；
 * - 手机号一律 `normalizePhone` + `hmacPhone`（绑定行只存 hash）。
 */
@Injectable()
export class AgentBindingsService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AgentSettingsService) private readonly settings: AgentSettingsService,
    @Inject(ConfigCacheService) private readonly config: ConfigCacheService,
    @Inject(AgentInviteService) private readonly invite: AgentInviteService,
  ) {}

  async bindFromSignup(input: {
    ownerId: string;
    code: string;
    phone: string;
  }): Promise<BindResult> {
    if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
      throw new DomainError(ErrCode.BAD_PARAM, 'ownerId 必须是非空字符串');
    }
    return this.dataSource.transaction(async (manager) => {
      const settings = await this.settings.getOrDefault(manager);
      if (!settings.enabled || !this.config.agentInviteEnabled()) {
        return { status: 'ignored' as const };
      }
      const resolved = await this.invite.resolve(manager, input.code);
      if (resolved === null || resolved.status !== 'active') {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }
      const phoneHash = hmacPhone(normalizePhone(input.phone));
      const phoneMasked = maskPhone(input.phone);
      const inserted = await manager.query(BIND_INSERT_IGNORE_SQL, [
        input.ownerId,
        resolved.agentId,
        phoneHash,
        phoneMasked,
      ]);
      if (affectedRowsOf(inserted, 'agent_bindings INSERT IGNORE') === 1) {
        await manager.query(HISTORY_INSERT_SQL, [
          input.ownerId,
          resolved.agentId,
          'bind',
          'signup',
          null,
        ]);
        return { status: 'bound' as const };
      }
      const existing = (await manager.query(BIND_SELECT_SQL, [input.ownerId])) as Array<
        Record<string, unknown>
      >;
      if (existing.length === 0) {
        throw new Error(`agent_bindings INSERT IGNORE 0 行后读不到 ownerId=${input.ownerId}`);
      }
      return { status: 'already_bound' as const };
    });
  }

  async rebind(input: {
    ownerId: string;
    agentId: string;
    phone: string;
    actor: string;
    reason: string;
  }): Promise<{ action: 'bind' | 'rebind' }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertAgentActive(manager, input.agentId);
      const phoneHash = hmacPhone(normalizePhone(input.phone));
      const phoneMasked = maskPhone(input.phone);
      const existing = (await manager.query(BIND_SELECT_FOR_UPDATE_SQL, [input.ownerId])) as Array<
        Record<string, unknown>
      >;
      if (existing.length === 0) {
        await manager.query(BIND_INSERT_IGNORE_SQL, [
          input.ownerId,
          input.agentId,
          phoneHash,
          phoneMasked,
        ]);
        // INSERT IGNORE 的首绑 source 固定 signup；管理补绑要覆盖为 admin。
        await manager.query(BIND_UPDATE_SQL, [
          input.agentId,
          input.actor,
          phoneHash,
          phoneMasked,
          input.ownerId,
        ]);
        await manager.query(HISTORY_INSERT_SQL, [
          input.ownerId,
          input.agentId,
          'bind',
          input.actor,
          input.reason,
        ]);
        await this.audit(manager, input.actor, 'agent.binding.bind', input.ownerId, null, {
          agentId: input.agentId,
        }, input.reason);
        return { action: 'bind' as const };
      }
      const beforeAgent = String(existing[0]!.agent_id);
      await manager.query(BIND_UPDATE_SQL, [
        input.agentId,
        input.actor,
        phoneHash,
        phoneMasked,
        input.ownerId,
      ]);
      await manager.query(HISTORY_INSERT_SQL, [
        input.ownerId,
        input.agentId,
        'rebind',
        input.actor,
        input.reason,
      ]);
      await this.audit(manager, input.actor, 'agent.binding.rebind', input.ownerId, {
        agentId: beforeAgent,
      }, { agentId: input.agentId }, input.reason);
      return { action: 'rebind' as const };
    });
  }

  async unbind(input: {
    ownerId: string;
    actor: string;
    reason: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const existing = (await manager.query(BIND_SELECT_FOR_UPDATE_SQL, [input.ownerId])) as Array<
        Record<string, unknown>
      >;
      if (existing.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '该玩家没有绑定');
      const beforeAgent = String(existing[0]!.agent_id);
      await manager.query(BIND_DELETE_SQL, [input.ownerId]);
      await manager.query(HISTORY_INSERT_SQL, [
        input.ownerId,
        beforeAgent,
        'unbind',
        input.actor,
        input.reason,
      ]);
      await this.audit(manager, input.actor, 'agent.binding.unbind', input.ownerId, {
        agentId: beforeAgent,
      }, null, input.reason);
    });
  }

  async bulkRebind(input: {
    fromAgentId: string;
    toAgentId: string;
    dryRun: boolean;
    actor: string;
    reason: string;
    limit?: number;
  }): Promise<{ moved: number; dryRun: boolean }> {
    if (input.fromAgentId === input.toAgentId) {
      throw new DomainError(ErrCode.BAD_PARAM, '源代理与目标代理不能相同');
    }
    await this.dataSource.transaction((manager) => this.assertAgentActive(manager, input.toAgentId));
    const countRows = (await this.dataSource.query(BIND_COUNT_SQL, [input.fromAgentId])) as Array<
      Record<string, unknown>
    >;
    const total = Number(countRows[0]?.cnt ?? 0);
    const max = Math.min(input.limit ?? AGENT_BULK_REBIND_MAX, AGENT_BULK_REBIND_MAX);
    if (total > max) {
      throw new DomainError(ErrCode.BAD_PARAM, `批量改绑上限 ${max} 人（当前 ${total} 人）`);
    }
    if (input.dryRun) return { moved: total, dryRun: true };

    let moved = 0;
    let last = '';
    while (moved < max) {
      const chunk = await this.dataSource.transaction(async (manager) => {
        // spec §5.3：**每批执行时**重新校验目标 active（批量跑到一半被冻结 ⇒ 后续批次拒绝）。
        await this.assertAgentActive(manager, input.toAgentId);
        const rows = (await manager.query(BIND_CHUNK_SQL, [input.fromAgentId, last])) as Array<
          Record<string, unknown>
        >;
        for (const row of rows) {
          const ownerId = String(row.owner_id);
          await manager.query(BIND_BULK_UPDATE_SQL, [input.toAgentId, input.actor, ownerId]);
          await manager.query(HISTORY_INSERT_SQL, [
            ownerId,
            input.toAgentId,
            'rebind',
            input.actor,
            input.reason,
          ]);
        }
        return rows.map((r) => String(r.owner_id));
      });
      if (chunk.length === 0) break;
      last = chunk[chunk.length - 1]!;
      moved += chunk.length;
    }
    await this.dataSource.transaction(async (manager) => {
      await this.audit(manager, input.actor, 'agent.binding.bulk_rebind', input.fromAgentId, {
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
      }, { moved }, input.reason);
    });
    return { moved, dryRun: false };
  }

  async listByAgent(agentId: string, page: number, pageSize: number): Promise<BindingRow[]> {
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const offset = Math.max(Math.trunc(page), 0) * size;
    const rows = (await this.dataSource.query(BIND_LIST_SQL, [agentId, size, offset])) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      ownerId: String(r.owner_id),
      agentId,
      boundAt: toDate(r.bound_at, 'agent_bindings.bound_at'),
      source: String(r.source),
      phoneMasked: String(r.phone_masked),
    }));
  }

  async get(ownerId: string): Promise<{ agentId: string; phoneHash: string; phoneMasked: string } | null> {
    const rows = (await this.dataSource.query(BIND_SELECT_SQL, [ownerId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return null;
    return {
      agentId: String(rows[0]!.agent_id),
      phoneHash: String(rows[0]!.phone_hash),
      phoneMasked: String(rows[0]!.phone_masked),
    };
  }

  async countByAgent(agentId: string): Promise<number> {
    const rows = (await this.dataSource.query(BIND_COUNT_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    return Number(rows[0]?.cnt ?? 0);
  }

  private async assertAgentActive(manager: EntityManager, agentId: string): Promise<void> {
    const rows = (await manager.query(AGENT_STATUS_SELECT_FOR_UPDATE_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '目标代理不存在');
    if (String(rows[0]!.status) !== 'active') {
      throw new DomainError(ErrCode.BAD_PARAM, '目标代理已冻结');
    }
  }

  private async audit(
    manager: EntityManager,
    actor: string,
    action: string,
    targetId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason: string,
  ): Promise<void> {
    await manager.query(AUDIT_INSERT_SQL, [
      actor,
      action,
      'agent_binding',
      targetId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    ]);
  }
}
