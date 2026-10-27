import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { classifyAgentSource, AGENT_MAX_DEPTH, type AgentSkipReason } from './agent.constants';
import { computeChainPayouts, type ChainAgent } from './commission.math';
import { AgentSettingsService } from './agent-settings.service';
import { AgentQuotaService } from './agent-quota.service';
import { AgentGapService } from './agent-gap.service';
import {
  agentCommissionEntriesTotal,
  agentCommissionMicroTotal,
  agentQuotaAdminCappedTotal,
  agentRevenueEventsTotal,
} from './agent.metrics';
import { hmacPhone, toDate, toSafeInt } from './agent.util';

/** `ApplyService` 传给代理钩子的最小上下文。 */
export interface AgentApplyEntry {
  ownerId: string;
  ownerType: 'user' | 'robot';
  delta: number;
}

export interface AgentApplyContext {
  opId: number;
  actionId: string;
  source: string;
  refId: string | null;
  entries: readonly AgentApplyEntry[];
}

const OP_CREATED_AT_SQL = 'SELECT `created_at` FROM `currency_ops` WHERE `id` = ?';
const EXISTING_REVENUE_SQL =
  'SELECT `id` FROM `agent_revenue_events` WHERE `source_op_id` = ? AND `owner_id` = ?';
const BINDING_SELECT_SQL =
  'SELECT `agent_id`, `phone_hash` FROM `agent_bindings` WHERE `owner_id` = ?';
// 单条递归 CTE 拉全代理链（最多 AGENT_MAX_DEPTH 级），消除逐级 N+1 查询。
const AGENT_CHAIN_CTE =
  'WITH RECURSIVE _chain AS (' +
  'SELECT `id`, `phone`, `rate_bp`, `status`, `parent_id`, 0 AS `lvl` ' +
  'FROM `agent_accounts` WHERE `id` = ? ' +
  'UNION ALL ' +
  'SELECT a.`id`, a.`phone`, a.`rate_bp`, a.`status`, a.`parent_id`, _chain.`lvl` + 1 ' +
  'FROM `agent_accounts` a JOIN _chain ON a.`parent_id` = _chain.`id` ' +
  'WHERE _chain.`lvl` < ? ' +
  'LIMIT 64' +
  ') SELECT * FROM _chain ORDER BY `lvl`';
const REVENUE_INSERT_SQL =
  'INSERT INTO `agent_revenue_events` (`owner_id`, `agent_id`, `source_op_id`, `fee_amount`, ' +
  '`base_amount`, `quota_consumed`, `top_rate_bp`, `expected_max_micro`, `chain_json`, ' +
  '`skipped_reason`, `ref_id`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON DUPLICATE KEY UPDATE `id` = LAST_INSERT_ID(`id`)';
const COMMISSION_INSERT_SQL =
  'INSERT INTO `agent_commission_entries` (`agent_id`, `owner_id`, `revenue_event_id`, ' +
  '`source_op_id`, `kind`, `level`, `rate_bp`, `paid_bp`, `commission_micro`) ' +
  "VALUES (?, ?, ?, ?, 'entry', ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `id` = `id`";

interface BindingRow {
  agentId: string;
  phoneHash: string;
}

/**
 * 代理记账钩子（spec §4.2）。
 *
 * 调用点：`ApplyService.applyWithEffect` 在 flows 写完、caller effect 之后、commit 之前，
 * 对「代理相关 source」调用；**同一事务、同一 manager**。钩子自身把任何异常写
 * `agent_ledger_gaps`（独立连接）后**原样抛出**，由 ApplyService 的保存点协议处置：
 * 语句级错误 ⇒ 回滚保存点 + 主事务继续；事务级错误 ⇒ 重抛让 apply 失败。
 *
 * 幂等：`agent_revenue_events(source_op_id, owner_id)` 已存在 ⇒ 整条 entry 跳过；
 * 佣金行 `(source_op_id, agent_id)` 唯一键兜底。
 */
@Injectable()
export class AgentLedgerService {
  private readonly logger = new Logger(AgentLedgerService.name);

  constructor(
    @Inject(AgentSettingsService) private readonly settings: AgentSettingsService,
    @Inject(AgentQuotaService) private readonly quota: AgentQuotaService,
    @Inject(AgentGapService) private readonly gap: AgentGapService,
  ) {}

  async onApply(manager: EntityManager, ctx: AgentApplyContext): Promise<void> {
    try {
      await this.apply(manager, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.gap.record({
        sourceOpId: ctx.opId,
        ownerId: ctx.entries.length === 1 ? ctx.entries[0]!.ownerId : null,
        source: ctx.source,
        error: message,
      });
      throw err;
    }
  }

  private async apply(manager: EntityManager, ctx: AgentApplyContext): Promise<void> {
    const settings = await this.settings.get(manager);
    if (settings === null || !settings.enabled) return;
    if (settings.effectiveFrom === null) {
      this.logger.error('agent_settings.enabled=1 但 effective_from=NULL —— 视为未启用');
      return;
    }
    const opCreatedAt = await this.readOpCreatedAt(manager, ctx.opId);
    if (opCreatedAt.getTime() < settings.effectiveFrom.getTime()) return;

    for (const entry of ctx.entries) {
      if (entry.ownerType !== 'user') continue;
      const purpose = classifyAgentSource(ctx.source);
      if (purpose === 'quota') {
        const result = await this.quota.applyDelta(manager, {
          ownerId: entry.ownerId,
          source: ctx.source,
          delta: entry.delta,
          sourceOpId: ctx.opId,
          now: opCreatedAt,
          adminDailyLimitCoins: settings.quotaAdminAdjustDailyLimitCoins,
          holdDays: settings.quotaHoldDays,
        });
        if (ctx.source === 'admin_adjust' && entry.delta > 0 && result !== null && result.creditedCoins < entry.delta) {
          agentQuotaAdminCappedTotal.inc();
        }
        continue;
      }
      if (purpose === 'entry_fee') {
        await this.onEntryFee(manager, ctx, entry);
      }
    }
  }

  private async readOpCreatedAt(manager: EntityManager, opId: number): Promise<Date> {
    const rows = (await manager.query(OP_CREATED_AT_SQL, [opId])) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new Error(`currency_ops id=${opId} 不存在（钩子上下文破坏）`);
    const d = toDate(rows[0]!.created_at, 'currency_ops.created_at');
    if (d === null) throw new Error(`currency_ops id=${opId} created_at 为空`);
    return d;
  }

  private async onEntryFee(
    manager: EntityManager,
    ctx: AgentApplyContext,
    entry: AgentApplyEntry,
  ): Promise<void> {
    const fee = Math.abs(entry.delta);
    if (!Number.isSafeInteger(fee) || fee <= 0) {
      throw new Error(`entry_fee delta 非法：${JSON.stringify(entry.delta)}`);
    }

    const existing = (await manager.query(EXISTING_REVENUE_SQL, [ctx.opId, entry.ownerId])) as Array<
      Record<string, unknown>
    >;
    if (existing.length > 0) return; // 幂等：该 op 已记账

    const bindings = (await manager.query(BINDING_SELECT_SQL, [entry.ownerId])) as Array<
      Record<string, unknown>
    >;
    if (bindings.length === 0) {
      await this.insertRevenue(manager, ctx, entry.ownerId, fee, 0, 0, 0, 0, null, 'unbound', null);
      agentRevenueEventsTotal.inc({ reason: 'unbound' });
      return;
    }
    const binding: BindingRow = {
      agentId: String(bindings[0]!.agent_id),
      phoneHash: String(bindings[0]!.phone_hash),
    };

    const state = await this.quota.lockState(manager, entry.ownerId);
    const base = Math.min(fee, state.available);
    const chain = await this.loadChain(manager, binding.agentId);
    const result = computeChainPayouts({ base, chain, playerPhoneHash: binding.phoneHash });

    if (base > 0) await this.quota.consume(manager, entry.ownerId, base);

    const hasPayee = result.payouts.some((p) => p.micro > 0);
    const skipped: AgentSkipReason | null =
      base === 0 ? 'quota_exhausted' : hasPayee ? null : 'no_payee';
    const chainJson = JSON.stringify(
      chain.map((a, level) => ({
        agentId: a.agentId,
        rateBp: a.rateBp,
        status: a.status,
        selfPlay: a.phoneHash === binding.phoneHash,
        level,
      })),
    );
    const revenueId = await this.insertRevenue(
      manager,
      ctx,
      entry.ownerId,
      fee,
      base,
      base,
      result.topRateBp,
      result.expectedMaxMicro,
      chainJson,
      skipped,
      binding.agentId,
    );

    for (const payout of result.payouts) {
      if (payout.micro <= 0) continue;
      await manager.query(COMMISSION_INSERT_SQL, [
        payout.agentId,
        entry.ownerId,
        revenueId,
        ctx.opId,
        payout.level,
        payout.rateBp,
        payout.paidBp,
        payout.micro,
      ]);
      agentCommissionEntriesTotal.inc({ level: String(payout.level) });
      agentCommissionMicroTotal.inc(payout.micro);
    }
    agentRevenueEventsTotal.inc({ reason: skipped ?? 'commissioned' });
  }

  private async insertRevenue(
    manager: EntityManager,
    ctx: AgentApplyContext,
    ownerId: string,
    feeAmount: number,
    baseAmount: number,
    quotaConsumed: number,
    topRateBp: number,
    expectedMaxMicro: number,
    chainJson: string | null,
    skippedReason: AgentSkipReason | null,
    agentId: string | null,
  ): Promise<number> {
    const res = await manager.query(REVENUE_INSERT_SQL, [
      ownerId,
      agentId,
      ctx.opId,
      feeAmount,
      baseAmount,
      quotaConsumed,
      topRateBp,
      expectedMaxMicro,
      chainJson,
      skippedReason,
      ctx.refId,
    ]);
    const insertId = (res as { insertId?: unknown } | undefined)?.insertId;
    if (typeof insertId === 'number' && Number.isSafeInteger(insertId) && insertId > 0) {
      return insertId;
    }
    const rows = (await manager.query(EXISTING_REVENUE_SQL, [ctx.opId, ownerId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) {
      throw new Error(`agent_revenue_events 写入后读不到 op=${ctx.opId} owner=${ownerId}`);
    }
    return toSafeInt(rows[0]!.id, 'agent_revenue_events.id');
  }

  private async loadChain(manager: EntityManager, directAgentId: string): Promise<ChainAgent[]> {
    // 单条递归 CTE 拉全链（最多 AGENT_MAX_DEPTH 级）
    const rows = (await manager.query(AGENT_CHAIN_CTE, [
      directAgentId,
      AGENT_MAX_DEPTH - 1,
    ])) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new Error(`代理不存在：agentId=${directAgentId}`);
    // ORDER BY lvl 保证从 direct 到顶层的顺序
    const chain: ChainAgent[] = rows.map((r) => ({
      agentId: String(r.id),
      rateBp: toSafeInt(r.rate_bp, `agent_accounts.rate_bp(${r.id})`),
      status: String(r.status) === 'frozen' ? 'frozen' : 'active',
      phoneHash: hmacPhone(String(r.phone)),
    }));
    // 最终安全网：LIMIT 截断时说明链超深或数据损坏
    if (chain.length >= AGENT_MAX_DEPTH) {
      // 最后一条仍有 parent_id 说明被截断了
      const top = rows[rows.length - 1]!;
      if (top.parent_id !== null && top.parent_id !== undefined) {
        throw new Error(`代理链深度超过 ${AGENT_MAX_DEPTH}（agentId=${directAgentId} 仍有上级）`);
      }
    }
    return chain;
  }
}
