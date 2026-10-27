import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { toDate, toSafeInt } from './agent.util';

/** `agent_settings` 单行（spec §3.1）。 */
export interface AgentSettings {
  enabled: boolean;
  effectiveFrom: Date | null;
  defaultRateBp: number;
  minSettlementYuan: number;
  coinPerYuan: number;
  quotaHoldDays: number;
  quotaAdminAdjustDailyLimitCoins: number;
  adjustMaxYuanPerOp: number;
  adjustMaxYuanPerDay: number;
}

/** 缺行/缺列时的 fail-safe：**关闭**（绝不凭默认值开钱）。 */
export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
  enabled: false,
  effectiveFrom: null,
  defaultRateBp: 0,
  minSettlementYuan: 100,
  coinPerYuan: 100,
  quotaHoldDays: 0,
  quotaAdminAdjustDailyLimitCoins: 50_000,
  adjustMaxYuanPerOp: 10_000,
  adjustMaxYuanPerDay: 20_000,
};

const SETTINGS_SELECT_SQL =
  'SELECT `enabled`, `effective_from`, `default_rate_bp`, `min_settlement_yuan`, `coin_per_yuan`, ' +
  '`quota_hold_days`, `quota_admin_adjust_daily_limit_coins`, `adjust_max_yuan_per_op`, ' +
  '`adjust_max_yuan_per_day` FROM `agent_settings` WHERE `id` = 1';
const SETTINGS_SELECT_FOR_UPDATE_SQL = `${SETTINGS_SELECT_SQL} FOR UPDATE`;
const SETTINGS_UPDATE_SQL =
  'UPDATE `agent_settings` SET `enabled` = ?, `effective_from` = ?, `default_rate_bp` = ?, ' +
  '`min_settlement_yuan` = ?, `coin_per_yuan` = ?, `quota_hold_days` = ?, ' +
  '`quota_admin_adjust_daily_limit_coins` = ?, `adjust_max_yuan_per_op` = ?, ' +
  '`adjust_max_yuan_per_day` = ?, `updated_by` = ? WHERE `id` = 1';
const SETTINGS_HISTORY_INSERT_SQL =
  'INSERT INTO `agent_settings_history` (`enabled`, `effective_from`, `actor`) VALUES (?, ?, ?)';
const AUDIT_INSERT_SQL =
  'INSERT INTO `agent_admin_audit` (`actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';

/**
 * 代理设置读写（spec §9.1/§3.1）。
 *
 * - `get()` 用**调用方传入的 manager**（钩子在同一事务内读，多副本立即生效、无缓存）；
 * - 缺行 ⇒ `null`；调用方用 `AGENT_SETTINGS_DEFAULTS`（enabled=false）fail-safe；
 * - `update()` 只由 super_admin 专用端点调用（任务 9），写 history + audit；
 * - `enable()` 只在第一次写 `effective_from`（关闭再开不重置，spec D16）。
 */
@Injectable()
export class AgentSettingsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async get(manager?: EntityManager): Promise<AgentSettings | null> {
    const run = async (m: EntityManager) => {
      const rows = (await m.query(SETTINGS_SELECT_SQL)) as Array<Record<string, unknown>>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        enabled: Number(r.enabled) === 1,
        effectiveFrom: toDate(r.effective_from, 'agent_settings.effective_from'),
        defaultRateBp: toSafeInt(r.default_rate_bp, 'agent_settings.default_rate_bp'),
        minSettlementYuan: toSafeInt(r.min_settlement_yuan, 'agent_settings.min_settlement_yuan'),
        coinPerYuan: toSafeInt(r.coin_per_yuan, 'agent_settings.coin_per_yuan'),
        quotaHoldDays: toSafeInt(r.quota_hold_days, 'agent_settings.quota_hold_days'),
        quotaAdminAdjustDailyLimitCoins: toSafeInt(
          r.quota_admin_adjust_daily_limit_coins,
          'agent_settings.quota_admin_adjust_daily_limit_coins',
        ),
        adjustMaxYuanPerOp: toSafeInt(
          r.adjust_max_yuan_per_op,
          'agent_settings.adjust_max_yuan_per_op',
        ),
        adjustMaxYuanPerDay: toSafeInt(
          r.adjust_max_yuan_per_day,
          'agent_settings.adjust_max_yuan_per_day',
        ),
      } satisfies AgentSettings;
    };
    return manager === undefined ? this.dataSource.transaction(run) : run(manager);
  }

  async getOrDefault(manager?: EntityManager): Promise<AgentSettings> {
    const row = await this.get(manager);
    return row ?? { ...AGENT_SETTINGS_DEFAULTS };
  }

  /**
   * 更新设置（super_admin）。`enabled` 从 false→true 且 `effective_from` 为空时，
   * 同一事务写入当前 DB 时间；之后不再改。`enabled/effective_from` 变化写 history。
   */
  async update(
    patch: Partial<
      Pick<
        AgentSettings,
        | 'enabled'
        | 'defaultRateBp'
        | 'minSettlementYuan'
        | 'coinPerYuan'
        | 'quotaHoldDays'
        | 'quotaAdminAdjustDailyLimitCoins'
        | 'adjustMaxYuanPerOp'
        | 'adjustMaxYuanPerDay'
      >
    >,
    actor: string,
    reason: string,
  ): Promise<AgentSettings> {
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('actor 必须非空');
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(SETTINGS_SELECT_FOR_UPDATE_SQL)) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) throw new Error('agent_settings 单行缺失（迁移未跑？）');
      const before = rowToSettings(rows[0]!);
      const next: AgentSettings = { ...before, ...patch };
      if (next.enabled && next.effectiveFrom === null) {
        const nowRows = (await manager.query('SELECT NOW(3) AS now')) as Array<{ now: unknown }>;
        next.effectiveFrom = toDate(nowRows[0]?.now, 'NOW(3)');
      }
      await manager.query(SETTINGS_UPDATE_SQL, [
        next.enabled ? 1 : 0,
        next.effectiveFrom,
        next.defaultRateBp,
        next.minSettlementYuan,
        next.coinPerYuan,
        next.quotaHoldDays,
        next.quotaAdminAdjustDailyLimitCoins,
        next.adjustMaxYuanPerOp,
        next.adjustMaxYuanPerDay,
        actor,
      ]);
      if (before.enabled !== next.enabled || before.effectiveFrom !== next.effectiveFrom) {
        await manager.query(SETTINGS_HISTORY_INSERT_SQL, [
          next.enabled ? 1 : 0,
          next.effectiveFrom,
          actor,
        ]);
      }
      await manager.query(AUDIT_INSERT_SQL, [
        actor,
        'agent.settings.update',
        'agent_settings',
        '1',
        JSON.stringify(settingsForAudit(before)),
        JSON.stringify(settingsForAudit(next)),
        reason,
      ]);
      return next;
    });
  }
}

function settingsForAudit(s: AgentSettings): Record<string, unknown> {
  return {
    enabled: s.enabled,
    effectiveFrom: s.effectiveFrom?.toISOString() ?? null,
    defaultRateBp: s.defaultRateBp,
    minSettlementYuan: s.minSettlementYuan,
    coinPerYuan: s.coinPerYuan,
    quotaHoldDays: s.quotaHoldDays,
    quotaAdminAdjustDailyLimitCoins: s.quotaAdminAdjustDailyLimitCoins,
    adjustMaxYuanPerOp: s.adjustMaxYuanPerOp,
    adjustMaxYuanPerDay: s.adjustMaxYuanPerDay,
  };
}

function rowToSettings(r: Record<string, unknown>): AgentSettings {
  return {
    enabled: Number(r.enabled) === 1,
    effectiveFrom: toDate(r.effective_from, 'agent_settings.effective_from'),
    defaultRateBp: toSafeInt(r.default_rate_bp, 'agent_settings.default_rate_bp'),
    minSettlementYuan: toSafeInt(r.min_settlement_yuan, 'agent_settings.min_settlement_yuan'),
    coinPerYuan: toSafeInt(r.coin_per_yuan, 'agent_settings.coin_per_yuan'),
    quotaHoldDays: toSafeInt(r.quota_hold_days, 'agent_settings.quota_hold_days'),
    quotaAdminAdjustDailyLimitCoins: toSafeInt(
      r.quota_admin_adjust_daily_limit_coins,
      'agent_settings.quota_admin_adjust_daily_limit_coins',
    ),
    adjustMaxYuanPerOp: toSafeInt(
      r.adjust_max_yuan_per_op,
      'agent_settings.adjust_max_yuan_per_op',
    ),
    adjustMaxYuanPerDay: toSafeInt(
      r.adjust_max_yuan_per_day,
      'agent_settings.adjust_max_yuan_per_day',
    ),
  };
}
