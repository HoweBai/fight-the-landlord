import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { AgentSettingsService } from './agent-settings.service';
import { computeSettlementTotals } from './commission.math';
import { sha256Hex, toDate, toSafeInt } from './agent.util';

export type SettlementStatus = 'pending' | 'paid' | 'rejected' | 'cancelled';

export interface SettlementRow {
  id: number;
  settlementNo: string;
  agentId: string;
  clientRequestId: string;
  status: SettlementStatus;
  fromEntryId: number;
  toEntryId: number;
  totalMicro: number;
  totalCoins: number;
  itemsCount: number;
  carryBefore: number;
  carryAfter: number;
  coinPerYuan: number;
  payout: Record<string, unknown> | null;
  minYuan: number;
  itemsHash: string;
  requestedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  paidAt: Date | null;
  paidBy: string | null;
  voucherNo: string | null;
  rejectReason: string | null;
}

export interface SettlementLine {
  level: number;
  ownerId: string | null;
  count: number;
  micro: number;
}

const SETTLEMENT_COLUMNS =
  '`id`, `settlement_no`, `agent_id`, `client_request_id`, `status`, `from_entry_id`, `to_entry_id`, ' +
  '`total_micro`, `total_coins`, `items_count`, `carry_before`, `carry_after`, `coin_per_yuan`, ' +
  '`payout_json`, `min_yuan`, `items_hash`, `requested_at`, `decided_at`, `decided_by`, `paid_at`, ' +
  '`paid_by`, `voucher_no`, `reject_reason`';
const SETTLEMENT_SELECT_SQL = `SELECT ${SETTLEMENT_COLUMNS} FROM \`agent_settlements\``;
const SETTLEMENT_BY_ID_SQL = `${SETTLEMENT_SELECT_SQL} WHERE \`id\` = ?`;
const SETTLEMENT_BY_ID_FOR_UPDATE_SQL = `${SETTLEMENT_BY_ID_SQL} FOR UPDATE`;
const SETTLEMENT_BY_CLIENT_SQL = `${SETTLEMENT_SELECT_SQL} WHERE \`agent_id\` = ? AND \`client_request_id\` = ?`;
const AGENT_SETTLE_LOCK_SQL =
  'SELECT `micro_carry`, `settled_watermark`, `pending_settlement_id`, `payout_name`, ' +
  '`payout_account`, `payout_bank` FROM `agent_accounts` WHERE `id` = ? FOR UPDATE';
const AGENT_SET_PENDING_SQL = 'UPDATE `agent_accounts` SET `pending_settlement_id` = ? WHERE `id` = ?';
const AGENT_SET_SETTLED_SQL =
  'UPDATE `agent_accounts` SET `settled_watermark` = ?, `micro_carry` = ?, ' +
  '`pending_settlement_id` = NULL WHERE `id` = ?';
const MAX_ENTRY_SQL =
  'SELECT COALESCE(MAX(`id`), 0) AS `max_id` FROM `agent_commission_entries` WHERE `agent_id` = ?';
const RANGE_SUM_SQL =
  'SELECT COALESCE(SUM(`commission_micro`), 0) AS `sum_micro`, COUNT(*) AS `cnt` ' +
  'FROM `agent_commission_entries` WHERE `agent_id` = ? AND `id` > ? AND `id` <= ?';
const RANGE_ITEMS_SQL =
  'SELECT `id`, `commission_micro` FROM `agent_commission_entries` ' +
  'WHERE `agent_id` = ? AND `id` > ? AND `id` <= ? ORDER BY `id`';
const LINES_SQL =
  'SELECT `level`, `owner_id`, COUNT(*) AS `cnt`, COALESCE(SUM(`commission_micro`), 0) AS `micro` ' +
  'FROM `agent_commission_entries` WHERE `agent_id` = ? AND `id` > ? AND `id` <= ? ' +
  'GROUP BY `level`, `owner_id` ORDER BY `level`, `owner_id`';
const SETTLEMENT_INSERT_SQL =
  'INSERT INTO `agent_settlements` (`settlement_no`, `agent_id`, `client_request_id`, `status`, ' +
  '`from_entry_id`, `to_entry_id`, `total_micro`, `total_coins`, `items_count`, `carry_before`, ' +
  '`carry_after`, `coin_per_yuan`, `payout_json`, `min_yuan`, `items_hash`) ' +
  "VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const SETTLEMENT_NO_UPDATE_SQL = 'UPDATE `agent_settlements` SET `settlement_no` = ? WHERE `id` = ?';
const SETTLEMENT_PAID_SQL =
  "UPDATE `agent_settlements` SET `status` = 'paid', `decided_at` = NOW(3), `decided_by` = ?, " +
  '`paid_at` = NOW(3), `paid_by` = ?, `voucher_no` = ? WHERE `id` = ?';
const SETTLEMENT_REJECT_SQL =
  "UPDATE `agent_settlements` SET `status` = 'rejected', `decided_at` = NOW(3), `decided_by` = ?, " +
  '`reject_reason` = ? WHERE `id` = ?';
const SETTLEMENT_CANCEL_SQL =
  "UPDATE `agent_settlements` SET `status` = 'cancelled', `decided_at` = NOW(3), `decided_by` = ? " +
  'WHERE `id` = ?';
const SETTLEMENT_LIST_AGENT_SQL =
  `${SETTLEMENT_SELECT_SQL} WHERE \`agent_id\` = ? ORDER BY \`id\` DESC LIMIT ? OFFSET ?`;
const SETTLEMENT_QUEUE_SQL =
  `${SETTLEMENT_SELECT_SQL} WHERE (? IS NULL OR \`status\` = ?) ORDER BY \`id\` DESC LIMIT ? OFFSET ?`;
const AUDIT_INSERT_SQL =
  'INSERT INTO `agent_admin_audit` (`actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';

/** items_hash 规范串（spec §6.2）：agent|from|to|carryBefore|totalMicro|id:micro,... */
export function computeItemsHash(input: {
  agentId: string;
  fromEntryId: number;
  toEntryId: number;
  carryBefore: number;
  totalMicro: number;
  items: ReadonlyArray<{ id: number; micro: number }>;
}): string {
  const body = [...input.items]
    .sort((a, b) => a.id - b.id)
    .map((i) => `${i.id}:${i.micro}`)
    .join(',');
  return sha256Hex(
    `${input.agentId}|${input.fromEntryId}|${input.toEntryId}|${input.carryBefore}|${input.totalMicro}|${body}`,
  );
}

function agentIdOf(result: unknown): number {
  const id = (result as { insertId?: unknown } | null)?.insertId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`agent_settlements INSERT 未返回自增 id（收到 ${JSON.stringify(result)}）`);
  }
  return id;
}

/**
 * 结算（spec §6）：ID 水位、**不锁佣金行**。
 *
 * - 申请：锁 agent 行 → `client_request_id` 幂等（先于 pending 校验）→ pending 唯一 →
 *   窗口 `(settled_watermark, MAX(id)]` → 取整/最低额/hash → 插入 settlement → 置 pending；
 * - 打款：锁 settlement + agent → 水位/carry 校验 → **重算 SUM/hash**（并发晚提交 ⇒ 409，
 *   撤回后重新申请）→ 推进水位/carry → paid；
 * - 驳回/撤回：清 pending，不动水位/carry；
 * - 已 paid 不可改；错账走人工调账 + 线下应收。
 */
@Injectable()
export class AgentSettlementService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AgentSettingsService) private readonly settings: AgentSettingsService,
  ) {}

  async create(input: {
    agentId: string;
    clientRequestId: string;
    actor: string;
  }): Promise<SettlementRow> {
    const clientRequestId = input.clientRequestId.trim();
    if (clientRequestId.length === 0 || clientRequestId.length > 64) {
      throw new DomainError(ErrCode.BAD_PARAM, 'clientRequestId 必须 1–64 字符');
    }
    return this.dataSource.transaction(async (manager) => {
      const agent = await this.lockAgent(manager, input.agentId);

      // H1：幂等查重必须在 pending 校验之前 —— 超时重试同 id 要返回原单。
      const existing = (await manager.query(SETTLEMENT_BY_CLIENT_SQL, [
        input.agentId,
        clientRequestId,
      ])) as Array<Record<string, unknown>>;
      if (existing.length > 0) return mapSettlement(existing[0]!);

      if (agent.pendingSettlementId !== null) {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_PENDING, '已有待处理的结算单');
      }
      for (const [label, value] of [
        ['户名', agent.payoutName],
        ['收款账号', agent.payoutAccount],
        ['开户行', agent.payoutBank],
      ] as const) {
        if (value === null || value.trim() === '') {
          throw new DomainError(ErrCode.BAD_PARAM, `请先补全收款信息（缺少${label}）`);
        }
      }
      const settings = await this.settings.get(manager);
      if (settings === null) throw new DomainError(ErrCode.BAD_PARAM, '代理设置未初始化');

      const from = agent.settledWatermark;
      const maxRows = (await manager.query(MAX_ENTRY_SQL, [input.agentId])) as Array<
        Record<string, unknown>
      >;
      const to = toSafeInt(maxRows[0]?.max_id ?? 0, 'agent_commission_entries.max_id');
      if (to <= from) {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_MIN, '暂无可结算佣金');
      }
      const sumRows = (await manager.query(RANGE_SUM_SQL, [input.agentId, from, to])) as Array<
        Record<string, unknown>
      >;
      const totalMicro = toSafeInt(sumRows[0]?.sum_micro ?? 0, 'settlement.sum_micro');
      const itemsCount = toSafeInt(sumRows[0]?.cnt ?? 0, 'settlement.cnt');
      const totals = computeSettlementTotals(agent.microCarry, totalMicro);
      if (
        totals.totalCoins <= 0 ||
        totals.totalCoins < settings.minSettlementYuan * settings.coinPerYuan
      ) {
        throw new DomainError(
          ErrCode.AGENT_SETTLEMENT_MIN,
          `未达最低结算额（当前 ${totals.totalCoins} 金币，最低 ${settings.minSettlementYuan * settings.coinPerYuan} 金币）`,
        );
      }
      const items = (await manager.query(RANGE_ITEMS_SQL, [input.agentId, from, to])) as Array<
        Record<string, unknown>
      >;
      const itemsHash = computeItemsHash({
        agentId: input.agentId,
        fromEntryId: from,
        toEntryId: to,
        carryBefore: agent.microCarry,
        totalMicro,
        items: items.map((r) => ({
          id: toSafeInt(r.id, 'agent_commission_entries.id'),
          micro: toSafeInt(r.commission_micro, 'agent_commission_entries.commission_micro'),
        })),
      });
      const payout = {
        name: agent.payoutName,
        account: agent.payoutAccount,
        bank: agent.payoutBank,
      };
      const inserted = await manager.query(SETTLEMENT_INSERT_SQL, [
        `AS${randomUUID().replace(/-/g, '').slice(0, 30)}`,
        input.agentId,
        clientRequestId,
        from,
        to,
        totalMicro,
        totals.totalCoins,
        itemsCount,
        agent.microCarry,
        totals.carryAfter,
        settings.coinPerYuan,
        JSON.stringify(payout),
        settings.minSettlementYuan,
        itemsHash,
      ]);
      const id = agentIdOf(inserted);
      const settlementNo = `AS${String(id).padStart(12, '0')}`;
      await manager.query(SETTLEMENT_NO_UPDATE_SQL, [settlementNo, id]);
      await manager.query(AGENT_SET_PENDING_SQL, [id, input.agentId]);
      await this.audit(manager, input.actor, 'agent.settlement.request', id, null, {
        settlementNo,
        totalCoins: totals.totalCoins,
      }, null);
      const rows = (await manager.query(SETTLEMENT_BY_ID_SQL, [id])) as Array<
        Record<string, unknown>
      >;
      return mapSettlement(rows[0]!);
    });
  }

  async pay(input: {
    id: number;
    voucherNo: string;
    actor: string;
    reason?: string;
  }): Promise<SettlementRow> {
    const voucherNo = input.voucherNo.trim();
    if (voucherNo.length === 0 || voucherNo.length > 64) {
      throw new DomainError(ErrCode.BAD_PARAM, '凭证号必须 1–64 字符');
    }
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockSettlement(manager, input.id);
      if (current.status !== 'pending') {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, `结算单状态为 ${current.status}`);
      }
      const agent = await this.lockAgent(manager, current.agentId);
      if (
        agent.settledWatermark !== current.fromEntryId ||
        agent.microCarry !== current.carryBefore ||
        agent.pendingSettlementId !== current.id
      ) {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, '结算单与代理状态不一致，请撤回后重试');
      }
      const sumRows = (await manager.query(RANGE_SUM_SQL, [
        current.agentId,
        current.fromEntryId,
        current.toEntryId,
      ])) as Array<Record<string, unknown>>;
      const totalMicro = toSafeInt(sumRows[0]?.sum_micro ?? 0, 'settlement.sum_micro');
      const items = (await manager.query(RANGE_ITEMS_SQL, [
        current.agentId,
        current.fromEntryId,
        current.toEntryId,
      ])) as Array<Record<string, unknown>>;
      const itemsHash = computeItemsHash({
        agentId: current.agentId,
        fromEntryId: current.fromEntryId,
        toEntryId: current.toEntryId,
        carryBefore: current.carryBefore,
        totalMicro,
        items: items.map((r) => ({
          id: toSafeInt(r.id, 'agent_commission_entries.id'),
          micro: toSafeInt(r.commission_micro, 'agent_commission_entries.commission_micro'),
        })),
      });
      if (totalMicro !== current.totalMicro || itemsHash !== current.itemsHash) {
        throw new DomainError(
          ErrCode.AGENT_SETTLEMENT_STATE,
          '结算期间有并发佣金入账（金额/hash 复核不一致），请撤回后重新申请',
        );
      }
      await manager.query(AGENT_SET_SETTLED_SQL, [
        current.toEntryId,
        current.carryAfter,
        current.agentId,
      ]);
      await manager.query(SETTLEMENT_PAID_SQL, [
        input.actor,
        input.actor,
        voucherNo,
        input.id,
      ]);
      await this.audit(manager, input.actor, 'agent.settlement.pay', input.id, {
        status: 'pending',
      }, { status: 'paid', voucherNo }, input.reason ?? null);
      const rows = (await manager.query(SETTLEMENT_BY_ID_SQL, [input.id])) as Array<
        Record<string, unknown>
      >;
      return mapSettlement(rows[0]!);
    });
  }

  async reject(input: {
    id: number;
    reason: string;
    actor: string;
  }): Promise<SettlementRow> {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 255) {
      throw new DomainError(ErrCode.BAD_PARAM, '驳回原因必须 1–255 字符');
    }
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockSettlement(manager, input.id);
      if (current.status !== 'pending') {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, `结算单状态为 ${current.status}`);
      }
      await manager.query(SETTLEMENT_REJECT_SQL, [input.actor, reason, input.id]);
      await manager.query(AGENT_SET_PENDING_SQL, [null, current.agentId]);
      await this.audit(manager, input.actor, 'agent.settlement.reject', input.id, {
        status: 'pending',
      }, { status: 'rejected', reason }, reason);
      const rows = (await manager.query(SETTLEMENT_BY_ID_SQL, [input.id])) as Array<
        Record<string, unknown>
      >;
      return mapSettlement(rows[0]!);
    });
  }

  async cancel(input: { id: number; agentId: string; actor: string }): Promise<SettlementRow> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockSettlement(manager, input.id);
      if (current.agentId !== input.agentId) {
        throw new DomainError(ErrCode.BAD_PARAM, '结算单不存在');
      }
      if (current.status !== 'pending') {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, `结算单状态为 ${current.status}`);
      }
      // 与 pay() 对齐：锁 agent 行断言 pending_settlement_id 一致，闭合并发窗口。
      const agent = await this.lockAgent(manager, input.agentId);
      if (agent.pendingSettlementId !== current.id) {
        throw new DomainError(ErrCode.AGENT_SETTLEMENT_STATE, '结算单与代理状态不一致，请刷新后重试');
      }
      await manager.query(SETTLEMENT_CANCEL_SQL, [input.actor, input.id]);
      await manager.query(AGENT_SET_PENDING_SQL, [null, current.agentId]);
      await this.audit(manager, input.actor, 'agent.settlement.cancel', input.id, {
        status: 'pending',
      }, { status: 'cancelled' }, null);
      const rows = (await manager.query(SETTLEMENT_BY_ID_SQL, [input.id])) as Array<
        Record<string, unknown>
      >;
      return mapSettlement(rows[0]!);
    });
  }

  async listByAgent(agentId: string, page: number, pageSize: number): Promise<SettlementRow[]> {
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const offset = Math.max(Math.trunc(page), 0) * size;
    const rows = (await this.dataSource.query(SETTLEMENT_LIST_AGENT_SQL, [
      agentId,
      size,
      offset,
    ])) as Array<Record<string, unknown>>;
    return rows.map(mapSettlement);
  }

  async listQueue(
    status: SettlementStatus | null,
    page: number,
    pageSize: number,
  ): Promise<SettlementRow[]> {
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const offset = Math.max(Math.trunc(page), 0) * size;
    const rows = (await this.dataSource.query(SETTLEMENT_QUEUE_SQL, [
      status,
      status,
      size,
      offset,
    ])) as Array<Record<string, unknown>>;
    return rows.map(mapSettlement);
  }

  async getById(id: number): Promise<SettlementRow | null> {
    const rows = (await this.dataSource.query(SETTLEMENT_BY_ID_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    return rows.length === 0 ? null : mapSettlement(rows[0]!);
  }

  async lines(agentId: string, id: number): Promise<SettlementLine[]> {
    const row = await this.getById(id);
    if (row === null || row.agentId !== agentId) return [];
    const rows = (await this.dataSource.query(LINES_SQL, [
      agentId,
      row.fromEntryId,
      row.toEntryId,
    ])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      level: toSafeInt(r.level, 'agent_commission_entries.level'),
      ownerId: r.owner_id === null ? null : String(r.owner_id),
      count: toSafeInt(r.cnt, 'agent_commission_entries.cnt'),
      micro: toSafeInt(r.micro, 'agent_commission_entries.micro'),
    }));
  }

  private async lockSettlement(manager: EntityManager, id: number): Promise<SettlementRow> {
    const rows = (await manager.query(SETTLEMENT_BY_ID_FOR_UPDATE_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '结算单不存在');
    return mapSettlement(rows[0]!);
  }

  private async lockAgent(
    manager: EntityManager,
    agentId: string,
  ): Promise<{
    microCarry: number;
    settledWatermark: number;
    pendingSettlementId: number | null;
    payoutName: string | null;
    payoutAccount: string | null;
    payoutBank: string | null;
  }> {
    const rows = (await manager.query(AGENT_SETTLE_LOCK_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
    const r = rows[0]!;
    return {
      microCarry: toSafeInt(r.micro_carry, 'agent_accounts.micro_carry'),
      settledWatermark: toSafeInt(r.settled_watermark, 'agent_accounts.settled_watermark'),
      pendingSettlementId:
        r.pending_settlement_id === null
          ? null
          : toSafeInt(r.pending_settlement_id, 'agent_accounts.pending_settlement_id'),
      payoutName: r.payout_name === null ? null : String(r.payout_name),
      payoutAccount: r.payout_account === null ? null : String(r.payout_account),
      payoutBank: r.payout_bank === null ? null : String(r.payout_bank),
    };
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
      'agent_settlement',
      String(id),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    ]);
  }
}

function mapSettlement(r: Record<string, unknown>): SettlementRow {
  const status = String(r.status);
  if (!['pending', 'paid', 'rejected', 'cancelled'].includes(status)) {
    throw new Error(`agent_settlements.status 非法：${status}`);
  }
  return {
    id: toSafeInt(r.id, 'agent_settlements.id'),
    settlementNo: String(r.settlement_no),
    agentId: String(r.agent_id),
    clientRequestId: String(r.client_request_id),
    status: status as SettlementStatus,
    fromEntryId: toSafeInt(r.from_entry_id, 'agent_settlements.from_entry_id'),
    toEntryId: toSafeInt(r.to_entry_id, 'agent_settlements.to_entry_id'),
    totalMicro: toSafeInt(r.total_micro, 'agent_settlements.total_micro'),
    totalCoins: toSafeInt(r.total_coins, 'agent_settlements.total_coins'),
    itemsCount: toSafeInt(r.items_count, 'agent_settlements.items_count'),
    carryBefore: toSafeInt(r.carry_before, 'agent_settlements.carry_before'),
    carryAfter: toSafeInt(r.carry_after, 'agent_settlements.carry_after'),
    coinPerYuan: toSafeInt(r.coin_per_yuan, 'agent_settlements.coin_per_yuan'),
    payout:
      r.payout_json === null || r.payout_json === undefined
        ? null
        : typeof r.payout_json === 'string'
          ? (JSON.parse(r.payout_json) as Record<string, unknown>)
          : (r.payout_json as Record<string, unknown>),
    minYuan: toSafeInt(r.min_yuan, 'agent_settlements.min_yuan'),
    itemsHash: String(r.items_hash),
    requestedAt: toDate(r.requested_at, 'agent_settlements.requested_at'),
    decidedAt: toDate(r.decided_at, 'agent_settlements.decided_at'),
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    paidAt: toDate(r.paid_at, 'agent_settlements.paid_at'),
    paidBy: r.paid_by === null ? null : String(r.paid_by),
    voucherNo: r.voucher_no === null ? null : String(r.voucher_no),
    rejectReason: r.reject_reason === null ? null : String(r.reject_reason),
  };
}
