import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AgentSettingsService } from './agent-settings.service';
import { toDate, toSafeInt } from './agent.util';

const ENTRY_FEE_TOTAL_SQL =
  'SELECT COALESCE(SUM(-f.`delta`), 0) AS `total` FROM `currency_flows` f ' +
  "JOIN `currency_ops` o ON o.id = f.op_id WHERE o.source = 'entry_fee' AND f.delta < 0 " +
  'AND o.created_at >= ? AND o.created_at < ?';
const BOUND_FEE_TOTAL_SQL =
  'SELECT COALESCE(SUM(`fee_amount`), 0) AS `total` FROM `agent_revenue_events` ' +
  'WHERE `agent_id` IS NOT NULL AND `created_at` >= ? AND `created_at` < ?';
const UNBOUND_FEE_TOTAL_SQL =
  'SELECT COALESCE(SUM(`fee_amount`), 0) AS `total` FROM `agent_revenue_events` ' +
  'WHERE `agent_id` IS NULL AND `created_at` >= ? AND `created_at` < ?';
const BASE_TOTAL_SQL =
  'SELECT COALESCE(SUM(`base_amount`), 0) AS `total`, COALESCE(SUM(`expected_max_micro`), 0) AS `expected` ' +
  'FROM `agent_revenue_events` WHERE `created_at` >= ? AND `created_at` < ?';
const COMMISSION_TOTAL_SQL =
  'SELECT COALESCE(SUM(`commission_micro`), 0) AS `total` FROM `agent_commission_entries` ' +
  'WHERE `created_at` >= ? AND `created_at` < ?';
const PAID_TOTAL_SQL =
  "SELECT COALESCE(SUM(`total_coins`), 0) AS `total` FROM `agent_settlements` " +
  "WHERE `status` = 'paid' AND `paid_at` >= ? AND `paid_at` < ?";
const GAP_COUNT_SQL =
  'SELECT COUNT(*) AS `cnt` FROM `agent_ledger_gaps` WHERE `created_at` >= ? AND `created_at` < ?';
const SETTINGS_HISTORY_SQL =
  'SELECT `enabled`, `effective_from`, `changed_at` FROM `agent_settings_history` ORDER BY `id` ASC';
const MISSING_EVENT_SQL =
  'SELECT COUNT(*) AS `cnt` FROM `currency_flows` f ' +
  'JOIN `currency_ops` o ON o.id = f.op_id ' +
  'LEFT JOIN `agent_revenue_events` re ON re.`source_op_id` = o.id AND re.`owner_id` = f.`owner_id` ' +
  "WHERE o.`source` = 'entry_fee' AND f.`owner_type` = 'user' AND f.`delta` < 0 " +
  'AND o.`created_at` >= ? AND o.`created_at` < ? AND re.`id` IS NULL';

export interface ReconcileSummary {
  from: Date;
  to: Date;
  entryFeeTotal: number;
  boundFeeTotal: number;
  unboundFeeTotal: number;
  baseTotal: number;
  commissionMicroTotal: number;
  expectedMaxMicroTotal: number;
  paidCoins: number;
  gapCount: number;
  missingEventCount: number;
}

interface Period {
  start: Date;
  end: Date;
}

/**
 * 启用区间（spec §12.2）：`agent_settings_history` 的 enabled=1 段；
 * 没有 history 时回落当前 settings（enabled + effective_from → to）。
 * 对账只统计这些区间内的 entry_fee op，避免关闭期历史被误报为缺口。
 */
export function buildEnabledPeriods(
  history: ReadonlyArray<{ enabled: boolean; effectiveFrom: Date | null; changedAt: Date | null }>,
  fallback: { enabled: boolean; effectiveFrom: Date | null },
  to: Date,
): Period[] {
  const periods: Period[] = [];
  let openStart: Date | null = null;
  for (const row of history) {
    const at = row.changedAt ?? row.effectiveFrom;
    if (at === null) continue;
    if (row.enabled) {
      if (openStart === null) openStart = row.effectiveFrom ?? at;
    } else if (openStart !== null) {
      periods.push({ start: openStart, end: at });
      openStart = null;
    }
  }
  if (openStart !== null) periods.push({ start: openStart, end: to });
  if (periods.length === 0 && fallback.enabled && fallback.effectiveFrom !== null) {
    periods.push({ start: fallback.effectiveFrom, end: to });
  }
  return periods;
}

@Injectable()
export class AgentReconcileService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AgentSettingsService) private readonly settings: AgentSettingsService,
  ) {}

  async summary(from: Date, to: Date): Promise<ReconcileSummary> {
    const [entryFeeTotal, boundFeeTotal, unboundFeeTotal, baseRows, commissionMicroTotal, paidCoins, gapCount] =
      await Promise.all([
        this.scalar(ENTRY_FEE_TOTAL_SQL, [from, to]),
        this.scalar(BOUND_FEE_TOTAL_SQL, [from, to]),
        this.scalar(UNBOUND_FEE_TOTAL_SQL, [from, to]),
        this.dataSource.query(BASE_TOTAL_SQL, [from, to]) as Promise<Array<Record<string, unknown>>>,
        this.scalar(COMMISSION_TOTAL_SQL, [from, to]),
        this.scalar(PAID_TOTAL_SQL, [from, to]),
        this.scalar(GAP_COUNT_SQL, [from, to]),
      ]);
    const current = await this.settings.getOrDefault();
    const historyRows = (await this.dataSource.query(SETTINGS_HISTORY_SQL)) as Array<
      Record<string, unknown>
    >;
    const periods = buildEnabledPeriods(
      historyRows.map((r) => ({
        enabled: Number(r.enabled) === 1,
        effectiveFrom: toDate(r.effective_from, 'agent_settings_history.effective_from'),
        changedAt: toDate(r.changed_at, 'agent_settings_history.changed_at'),
      })),
      { enabled: current.enabled, effectiveFrom: current.effectiveFrom },
      to,
    );
    let missingEventCount = 0;
    for (const period of periods) {
      const start = period.start > from ? period.start : from;
      const end = period.end < to ? period.end : to;
      if (start >= end) continue;
      missingEventCount += await this.scalar(MISSING_EVENT_SQL, [start, end]);
    }
    return {
      from,
      to,
      entryFeeTotal,
      boundFeeTotal,
      unboundFeeTotal,
      baseTotal: toSafeInt(baseRows[0]?.total ?? 0, 'reconcile.base'),
      commissionMicroTotal,
      expectedMaxMicroTotal: toSafeInt(baseRows[0]?.expected ?? 0, 'reconcile.expected'),
      paidCoins,
      gapCount,
      missingEventCount,
    };
  }

  private async scalar(sql: string, params: unknown[]): Promise<number> {
    const rows = (await this.dataSource.query(sql, params)) as Array<Record<string, unknown>>;
    const value = rows[0]?.total ?? rows[0]?.cnt ?? 0;
    return toSafeInt(value, 'reconcile.scalar');
  }
}
