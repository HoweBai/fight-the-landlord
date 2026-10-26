import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { agentLedgerGapsTotal } from './agent.metrics';

const GAP_INSERT_SQL =
  'INSERT INTO `agent_ledger_gaps` (`source_op_id`, `owner_id`, `source`, `error`) VALUES (?, ?, ?, ?) ' +
  'ON DUPLICATE KEY UPDATE `error` = VALUES(`error`)';

export interface AgentGapInput {
  sourceOpId: number;
  ownerId: string | null;
  source: string;
  error: string;
}

/**
 * 缺口落库（spec §3.14/§4.1）：**独立连接**（`DataSource.query` 走池），
 * 因为主事务可能已毒化/回滚。失败只记日志——缺口写入本身绝不能升级故障。
 */
@Injectable()
export class AgentGapService {
  private readonly logger = new Logger(AgentGapService.name);

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async record(input: AgentGapInput): Promise<void> {
    try {
      await this.dataSource.query(GAP_INSERT_SQL, [
        input.sourceOpId,
        input.ownerId,
        input.source,
        input.error.slice(0, 500),
      ]);
      agentLedgerGapsTotal.inc();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `agent gap insert failed opId=${input.sourceOpId} source=${input.source} reason=${reason}`,
      );
    }
  }
}
