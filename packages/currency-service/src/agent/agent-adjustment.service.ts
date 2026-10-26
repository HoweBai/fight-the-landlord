import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { MICRO_PER_COIN } from './agent.constants';
import { AgentSettingsService } from './agent-settings.service';
import { shanghaiDayRange, toDate, toSafeInt } from './agent.util';

export type AdjustmentStatus = 'pending' | 'approved' | 'rejected';

export interface AdjustmentRow {
  id: number;
  agentId: string;
  deltaMicro: number;
  reason: string;
  status: AdjustmentStatus;
  requestedBy: string;
  approvedBy: string | null;
  commissionEntryId: number | null;
  createdAt: Date | null;
  decidedAt: Date | null;
}

const ADJ_COLUMNS =
  '`id`, `agent_id`, `delta_micro`, `reason`, `status`, `requested_by`, `approved_by`, ' +
  '`commission_entry_id`, `created_at`, `decided_at`';
const ADJ_SELECT_SQL = `SELECT ${ADJ_COLUMNS} FROM \`agent_adjustments\``;
const ADJ_BY_ID_SQL = `${ADJ_SELECT_SQL} WHERE \`id\` = ?`;
const ADJ_BY_ID_FOR_UPDATE_SQL = `${ADJ_BY_ID_SQL} FOR UPDATE`;
const ADJ_LIST_SQL =
  `${ADJ_SELECT_SQL} WHERE (? IS NULL OR \`agent_id\` = ?) AND (? IS NULL OR \`status\` = ?) ` +
  'ORDER BY `id` DESC LIMIT ? OFFSET ?';
const ADJ_INSERT_SQL =
  'INSERT INTO `agent_adjustments` (`agent_id`, `delta_micro`, `reason`, `status`, `requested_by`) ' +
  "VALUES (?, ?, ?, 'pending', ?)";
const ADJ_UPDATE_APPROVED_SQL =
  "UPDATE `agent_adjustments` SET `status` = 'approved', `approved_by` = ?, " +
  '`commission_entry_id` = ?, `decided_at` = NOW(3) WHERE `id` = ?';
const ADJ_UPDATE_REJECTED_SQL =
  "UPDATE `agent_adjustments` SET `status` = 'rejected', `approved_by` = ?, " +
  '`decided_at` = NOW(3) WHERE `id` = ?';
const ADJ_DAY_SUM_SQL =
  "SELECT COALESCE(SUM(ABS(`delta_micro`)), 0) AS `total` FROM `agent_adjustments` " +
  "WHERE `agent_id` = ? AND `status` IN ('pending', 'approved') AND `created_at` >= ? AND `created_at` < ?";
const AGENT_LOCK_SQL = 'SELECT `id` FROM `agent_accounts` WHERE `id` = ? FOR UPDATE';
const MANUAL_INSERT_SQL =
  'INSERT INTO `agent_commission_entries` (`agent_id`, `owner_id`, `revenue_event_id`, ' +
  '`source_op_id`, `kind`, `level`, `rate_bp`, `paid_bp`, `commission_micro`, `reason`) ' +
  "VALUES (?, NULL, NULL, NULL, 'manual', 0, 0, 0, ?, ?)";
const AUDIT_INSERT_SQL =
  'INSERT INTO `agent_admin_audit` (`actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';

function insertIdOf(result: unknown, context: string): number {
  const id = (result as { insertId?: unknown } | null)?.insertId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${context}：INSERT 未返回自增 id（收到 ${JSON.stringify(result)}）`);
  }
  return id;
}

/**
 * 人工调账（spec §7）：super_admin 发起 + **另一名** super_admin 复核。
 *
 * - 单笔/单日上限来自 `agent_settings`（元 → 币 → micro）；
 * - 日限查询在锁 agent 行后执行 ⇒ 并发申请不超限；
 * - 复核通过才插入 `kind='manual'` 佣金行（只影响未来结算）；
 * - 请求人 == 复核人 ⇒ 403。
 */
@Injectable()
export class AgentAdjustmentService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AgentSettingsService) private readonly settings: AgentSettingsService,
  ) {}

  async create(input: {
    agentId: string;
    deltaCoins: number;
    reason: string;
    requestedBy: string;
  }): Promise<AdjustmentRow> {
    if (!Number.isSafeInteger(input.deltaCoins) || input.deltaCoins === 0) {
      throw new DomainError(ErrCode.BAD_PARAM, '调账金币必须是非零整数');
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 255) {
      throw new DomainError(ErrCode.BAD_PARAM, '调账原因必须 1–255 字符');
    }
    const deltaMicro = input.deltaCoins * MICRO_PER_COIN;
    if (!Number.isSafeInteger(deltaMicro)) {
      throw new DomainError(ErrCode.BAD_PARAM, '调账金额过大');
    }
    return this.dataSource.transaction(async (manager) => {
      await this.lockAgent(manager, input.agentId);
      const settings = await this.settings.get(manager);
      if (settings === null) throw new DomainError(ErrCode.BAD_PARAM, '代理设置未初始化');
      const maxPerOpMicro = settings.adjustMaxYuanPerOp * settings.coinPerYuan * MICRO_PER_COIN;
      if (Math.abs(deltaMicro) > maxPerOpMicro) {
        throw new DomainError(
          ErrCode.BAD_PARAM,
          `单笔调账上限 ${settings.adjustMaxYuanPerOp} 元（约 ${settings.adjustMaxYuanPerOp * settings.coinPerYuan} 金币）`,
        );
      }
      const { start, end } = shanghaiDayRange(new Date());
      const sumRows = (await manager.query(ADJ_DAY_SUM_SQL, [
        input.agentId,
        start,
        end,
      ])) as Array<Record<string, unknown>>;
      const todayMicro = toSafeInt(sumRows[0]?.total ?? 0, 'agent_adjustments.day_total');
      const maxDayMicro = settings.adjustMaxYuanPerDay * settings.coinPerYuan * MICRO_PER_COIN;
      if (todayMicro + Math.abs(deltaMicro) > maxDayMicro) {
        throw new DomainError(
          ErrCode.BAD_PARAM,
          `单代理单日调账上限 ${settings.adjustMaxYuanPerDay} 元（约 ${settings.adjustMaxYuanPerDay * settings.coinPerYuan} 金币）`,
        );
      }
      const inserted = await manager.query(ADJ_INSERT_SQL, [
        input.agentId,
        deltaMicro,
        reason,
        input.requestedBy,
      ]);
      const id = insertIdOf(inserted, 'agent_adjustments');
      await this.audit(manager, input.requestedBy, 'agent.adjustment.create', id, null, {
        agentId: input.agentId,
        deltaMicro,
      }, reason);
      return this.readById(manager, id);
    });
  }

  async approve(input: { id: number; approvedBy: string; reason?: string }): Promise<AdjustmentRow> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockForUpdate(manager, input.id);
      if (current.status !== 'pending') {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, `调账状态为 ${current.status}`);
      }
      if (current.requestedBy === input.approvedBy) {
        throw new DomainError(ErrCode.FORBIDDEN, '复核人不能是发起人');
      }
      await this.lockAgent(manager, current.agentId);
      const entry = await manager.query(MANUAL_INSERT_SQL, [
        current.agentId,
        current.deltaMicro,
        current.reason,
      ]);
      const entryId = insertIdOf(entry, 'agent_commission_entries(manual)');
      await manager.query(ADJ_UPDATE_APPROVED_SQL, [input.approvedBy, entryId, input.id]);
      await this.audit(manager, input.approvedBy, 'agent.adjustment.approve', input.id, {
        status: 'pending',
      }, { status: 'approved', commissionEntryId: entryId }, input.reason ?? null);
      return this.readById(manager, input.id);
    });
  }

  async reject(input: { id: number; actor: string; reason: string }): Promise<AdjustmentRow> {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 255) {
      throw new DomainError(ErrCode.BAD_PARAM, '驳回原因必须 1–255 字符');
    }
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockForUpdate(manager, input.id);
      if (current.status !== 'pending') {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, `调账状态为 ${current.status}`);
      }
      await manager.query(ADJ_UPDATE_REJECTED_SQL, [input.actor, input.id]);
      await this.audit(manager, input.actor, 'agent.adjustment.reject', input.id, {
        status: 'pending',
      }, { status: 'rejected', reason }, reason);
      return this.readById(manager, input.id);
    });
  }

  async list(input: {
    agentId?: string;
    status?: AdjustmentStatus;
    page: number;
    pageSize: number;
  }): Promise<AdjustmentRow[]> {
    const size = Math.min(Math.max(Math.trunc(input.pageSize), 1), 100);
    const offset = Math.max(Math.trunc(input.page), 0) * size;
    const rows = (await this.dataSource.query(ADJ_LIST_SQL, [
      input.agentId ?? null,
      input.agentId ?? null,
      input.status ?? null,
      input.status ?? null,
      size,
      offset,
    ])) as Array<Record<string, unknown>>;
    return rows.map(mapAdjustment);
  }

  async getById(id: number): Promise<AdjustmentRow | null> {
    const rows = (await this.dataSource.query(ADJ_BY_ID_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    return rows.length === 0 ? null : mapAdjustment(rows[0]!);
  }

  private async lockAgent(manager: EntityManager, agentId: string): Promise<void> {
    const rows = (await manager.query(AGENT_LOCK_SQL, [agentId])) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
  }

  private async lockForUpdate(manager: EntityManager, id: number): Promise<AdjustmentRow> {
    const rows = (await manager.query(ADJ_BY_ID_FOR_UPDATE_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '调账记录不存在');
    return mapAdjustment(rows[0]!);
  }

  private async readById(manager: EntityManager, id: number): Promise<AdjustmentRow> {
    const rows = (await manager.query(ADJ_BY_ID_SQL, [id])) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new Error(`agent_adjustments 读不到 id=${id}`);
    return mapAdjustment(rows[0]!);
  }

  private async audit(
    manager: EntityManager,
    actor: string,
    action: string,
    id: number,
    before: unknown,
    after: unknown,
    reason: string | null,
  ): Promise<void> {
    await manager.query(AUDIT_INSERT_SQL, [
      actor,
      action,
      'agent_adjustment',
      String(id),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    ]);
  }
}

function mapAdjustment(r: Record<string, unknown>): AdjustmentRow {
  const status = String(r.status);
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new Error(`agent_adjustments.status 非法：${status}`);
  }
  return {
    id: toSafeInt(r.id, 'agent_adjustments.id'),
    agentId: String(r.agent_id),
    deltaMicro: toSafeInt(r.delta_micro, 'agent_adjustments.delta_micro'),
    reason: String(r.reason),
    status: status as AdjustmentStatus,
    requestedBy: String(r.requested_by),
    approvedBy: r.approved_by === null ? null : String(r.approved_by),
    commissionEntryId:
      r.commission_entry_id === null
        ? null
        : toSafeInt(r.commission_entry_id, 'agent_adjustments.commission_entry_id'),
    createdAt: toDate(r.created_at, 'agent_adjustments.created_at'),
    decidedAt: toDate(r.decided_at, 'agent_adjustments.decided_at'),
  };
}
