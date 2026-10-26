import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { shanghaiDateOf } from '../util/shanghai-date';
import { classifyAgentSource } from './agent.constants';
import { applyQuotaDelta } from './commission.math';
import { toSafeInt } from './agent.util';

const QUOTA_ENSURE_SQL =
  'INSERT INTO `agent_player_quota` (`owner_id`, `inflow_total`, `consumed_total`) VALUES (?, 0, 0) ' +
  'ON DUPLICATE KEY UPDATE `owner_id` = `owner_id`';
const QUOTA_SELECT_FOR_UPDATE_SQL =
  'SELECT `inflow_total`, `consumed_total` FROM `agent_player_quota` WHERE `owner_id` = ? FOR UPDATE';
const QUOTA_UPDATE_SQL =
  'UPDATE `agent_player_quota` SET `inflow_total` = ?, `consumed_total` = ? WHERE `owner_id` = ?';
const CREDIT_ENSURE_SQL =
  'INSERT INTO `agent_admin_quota_credits` (`owner_id`, `day`, `credited_coins`) VALUES (?, ?, 0) ' +
  'ON DUPLICATE KEY UPDATE `owner_id` = `owner_id`';
const CREDIT_SELECT_FOR_UPDATE_SQL =
  'SELECT `credited_coins` FROM `agent_admin_quota_credits` WHERE `owner_id` = ? AND `day` = ? FOR UPDATE';
const CREDIT_UPDATE_SQL =
  'UPDATE `agent_admin_quota_credits` SET `credited_coins` = `credited_coins` + ? WHERE `owner_id` = ? AND `day` = ?';
const PENDING_INSERT_SQL =
  'INSERT INTO `agent_quota_inflows` (`owner_id`, `source_op_id`, `amount`, `matures_at`) VALUES (?, ?, ?, ?) ' +
  'ON DUPLICATE KEY UPDATE `amount` = `amount`';

export interface QuotaState {
  inflow: number;
  consumed: number;
  available: number;
}

export interface ApplyQuotaInput {
  ownerId: string;
  source: string;
  /** 可正可负；0 ⇒ no-op。 */
  delta: number;
  sourceOpId: number;
  /** op 的 DB 时间（日限/成熟期锚）。 */
  now: Date;
  adminDailyLimitCoins: number;
  holdDays: number;
}

export interface QuotaDeltaResult extends QuotaState {
  /** 正入账实际计入额（admin_adjust 可能被日限裁剪；hold>0 时为 0）。 */
  creditedCoins: number;
  /** 负出账实际抵扣额（非负）。 */
  deductedCoins: number;
  /** hold>0 时本笔进入待成熟表。 */
  pending: boolean;
}

/**
 * 玩家额度读写（spec §2.2/§2.4）。
 *
 * - 首建用**原子 upsert**，随后对**已存在**行 `FOR UPDATE` —— 避免首局并发
 *   对缺失行做 gap lock（审查 B2）；
 * - 正入账：全额（`admin_adjust` 受单日上限裁剪）；`hold>0` 写待成熟表；
 * - 负出账：`min(-delta, max(0, inflow−consumed))`，额度永不为负。
 */
@Injectable()
export class AgentQuotaService {
  /** 锁额度行（不存在先建）。供台费钩子读 available + 后续 consume。 */
  async lockState(manager: EntityManager, ownerId: string): Promise<QuotaState> {
    await manager.query(QUOTA_ENSURE_SQL, [ownerId]);
    const rows = (await manager.query(QUOTA_SELECT_FOR_UPDATE_SQL, [ownerId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw new Error(`agent_player_quota 首建后仍读不到 ownerId=${ownerId}`);
    const inflow = toSafeInt(rows[0]!.inflow_total, 'agent_player_quota.inflow_total');
    const consumed = toSafeInt(rows[0]!.consumed_total, 'agent_player_quota.consumed_total');
    return { inflow, consumed, available: Math.max(0, inflow - consumed) };
  }

  /** 台费消耗额度（调用方已 lockState；扣减额 ≤ available）。 */
  async consume(manager: EntityManager, ownerId: string, amount: number): Promise<QuotaState> {
    const state = await this.lockState(manager, ownerId);
    if (amount < 0 || !Number.isSafeInteger(amount) || amount > state.available) {
      throw new Error(
        `consume 非法：amount=${amount} available=${state.available}（调用方应先裁剪）`,
      );
    }
    const consumed = state.consumed + amount;
    await manager.query(QUOTA_UPDATE_SQL, [state.inflow, consumed, ownerId]);
    return { inflow: state.inflow, consumed, available: state.inflow - consumed };
  }

  async applyDelta(manager: EntityManager, input: ApplyQuotaInput): Promise<QuotaDeltaResult | null> {
    if (classifyAgentSource(input.source) !== 'quota') return null;
    if (!Number.isSafeInteger(input.delta)) {
      throw new Error(`quota delta 非安全整数：${JSON.stringify(input.delta)}`);
    }
    if (input.delta === 0) {
      const state = await this.lockState(manager, input.ownerId);
      return { ...state, creditedCoins: 0, deductedCoins: 0, pending: false };
    }

    const state = await this.lockState(manager, input.ownerId);
    let { inflow, consumed } = state;
    let creditedCoins = 0;
    let deductedCoins = 0;
    let pending = false;

    if (input.delta > 0) {
      let credit = input.delta;
      if (input.source === 'admin_adjust') {
        const day = shanghaiDateOf(input.now);
        await manager.query(CREDIT_ENSURE_SQL, [input.ownerId, day]);
        const rows = (await manager.query(CREDIT_SELECT_FOR_UPDATE_SQL, [input.ownerId, day])) as Array<
          Record<string, unknown>
        >;
        if (rows.length === 0) {
          throw new Error(`agent_admin_quota_credits 首建后读不到 ownerId=${input.ownerId}`);
        }
        const already = toSafeInt(rows[0]!.credited_coins, 'agent_admin_quota_credits.credited_coins');
        const remaining = Math.max(0, input.adminDailyLimitCoins - already);
        credit = Math.min(credit, remaining);
        if (credit > 0) {
          await manager.query(CREDIT_UPDATE_SQL, [credit, input.ownerId, day]);
        }
      }
      creditedCoins = credit;
      if (credit > 0) {
        if (input.holdDays > 0) {
          const maturesAt = new Date(input.now.getTime() + input.holdDays * 86_400_000);
          await manager.query(PENDING_INSERT_SQL, [
            input.ownerId,
            input.sourceOpId,
            credit,
            maturesAt,
          ]);
          pending = true;
        } else {
          inflow += credit;
        }
      }
    } else {
      const next = applyQuotaDelta({ inflow, consumed }, input.delta);
      inflow = next.inflow;
      consumed = next.consumed;
      deductedCoins = next.deducted;
    }

    await manager.query(QUOTA_UPDATE_SQL, [inflow, consumed, input.ownerId]);
    return {
      inflow,
      consumed,
      available: Math.max(0, inflow - consumed),
      creditedCoins,
      deductedCoins,
      pending,
    };
  }
}

export const AGENT_QUOTA_SQL = {
  QUOTA_ENSURE_SQL,
  QUOTA_SELECT_FOR_UPDATE_SQL,
  QUOTA_UPDATE_SQL,
  CREDIT_ENSURE_SQL,
  CREDIT_SELECT_FOR_UPDATE_SQL,
  CREDIT_UPDATE_SQL,
  PENDING_INSERT_SQL,
} as const;
