import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { AGENT_QUOTA_SQL } from './agent-quota.service';
import { toSafeInt } from './agent.util';

const MATURE_SELECT_SQL =
  'SELECT `id`, `owner_id`, `amount` FROM `agent_quota_inflows` ' +
  'WHERE `matured_at` IS NULL AND `matures_at` <= NOW(3) ORDER BY `id` LIMIT 500 FOR UPDATE SKIP LOCKED';
const MATURE_ADD_INFLOW_SQL =
  'UPDATE `agent_player_quota` SET `inflow_total` = `inflow_total` + ? WHERE `owner_id` = ?';
const MATURE_MARK_SQL = 'UPDATE `agent_quota_inflows` SET `matured_at` = NOW(3) WHERE `id` = ?';

export const AGENT_MATURITY_INTERVAL_MS = 60_000;

/**
 * 额度成熟循环（spec §2.4/H13）：`quota_hold_days > 0` 时，正入账先待成熟；
 * 到期（`matures_at <= NOW(3)`）并入 `inflow_total`。
 *
 * - 默认 `hold=0` ⇒ 表恒空、循环空转；
 * - `FOR UPDATE SKIP LOCKED` + 逐行幂等标记（`matured_at`）⇒ 多副本不重复入账；
 * - `unref()` + `onModuleDestroy` ⇒ 不阻止进程退出/vitest 挂住。
 * - 持有人期间台费 `base=0`、**不递延补佣**（spec 明示）。
 */
@Injectable()
export class AgentQuotaMaturityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentQuotaMaturityService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, AGENT_MATURITY_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const n = await this.matureDue();
      if (n > 0) this.logger.log(`agent quota matured rows=${n}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`agent quota maturity failed: ${reason}`);
    }
  }

  /** 到期并入（可选传入 manager 供单测；否则自开事务）。返回处理行数。 */
  async matureDue(manager?: EntityManager): Promise<number> {
    const run = async (m: EntityManager): Promise<number> => {
      const rows = (await m.query(MATURE_SELECT_SQL)) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = toSafeInt(row.id, 'agent_quota_inflows.id');
        const ownerId = String(row.owner_id);
        const amount = toSafeInt(row.amount, 'agent_quota_inflows.amount');
        await m.query(AGENT_QUOTA_SQL.QUOTA_ENSURE_SQL, [ownerId]);
        await m.query(MATURE_ADD_INFLOW_SQL, [amount, ownerId]);
        await m.query(MATURE_MARK_SQL, [id]);
      }
      return rows.length;
    };
    return manager === undefined ? this.dataSource.transaction(run) : run(manager);
  }
}
