import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { AgentInviteService } from './agent-invite.service';
import { AgentSettlementService, type SettlementLine, type SettlementRow } from './agent-settlement.service';
import { AgentUserClient } from './agent-user.client';
import { toDate, toSafeInt } from './agent.util';

const AGENT_ROW_SQL =
  'SELECT `id`, `name`, `phone`, `rate_bp`, `status`, `region`, `contact_name`, `payout_name`, ' +
  '`payout_account`, `payout_bank`, `micro_carry`, `settled_watermark` ' +
  'FROM `agent_accounts` WHERE `id` = ?';
const DIRECT_COUNT_SQL = 'SELECT COUNT(*) AS `cnt` FROM `agent_bindings` WHERE `agent_id` = ?';
const ACTIVE_COUNT_SQL =
  'SELECT COUNT(DISTINCT `owner_id`) AS `cnt` FROM `agent_revenue_events` ' +
  'WHERE `agent_id` = ? AND `created_at` >= NOW(3) - INTERVAL 30 DAY';
const REVENUE_SUM_SQL =
  'SELECT COALESCE(SUM(`fee_amount`), 0) AS `fee`, COALESCE(SUM(`base_amount`), 0) AS `base` ' +
  'FROM `agent_revenue_events` WHERE `agent_id` = ?';
const COMMISSION_SUM_SQL =
  'SELECT COALESCE(SUM(`commission_micro`), 0) AS `micro` FROM `agent_commission_entries` WHERE `agent_id` = ?';
const UNSETTLED_SUM_SQL =
  'SELECT COALESCE(SUM(`commission_micro`), 0) AS `micro` FROM `agent_commission_entries` ' +
  'WHERE `agent_id` = ? AND `id` > ?';
const PAID_SUM_SQL =
  "SELECT COALESCE(SUM(`total_coins`), 0) AS `coins` FROM `agent_settlements` " +
  "WHERE `agent_id` = ? AND `status` = 'paid'";
const OVERRIDE_SUM_SQL =
  'SELECT COALESCE(SUM(`commission_micro`), 0) AS `micro` FROM `agent_commission_entries` ' +
  'WHERE `agent_id` = ? AND `level` > 0';
const ALL_ACCOUNTS_SQL = 'SELECT `id`, `parent_id` FROM `agent_accounts`';
// 递归 CTE：一次拉全子树，避免全表加载 + 应用层 BFS。LIMIT 作安全上限。
const DESCENDANTS_CTE =
  'WITH RECURSIVE _sub AS (' +
  'SELECT `id` FROM `agent_accounts` WHERE `id` = ? ' +
  'UNION ALL ' +
  'SELECT a.`id` FROM `agent_accounts` a JOIN _sub ON a.`parent_id` = _sub.`id` ' +
  'LIMIT 2048' +
  ') SELECT `id` FROM _sub WHERE `id` <> ?';
const SUBTREE_REVENUE_SQL =
  'SELECT COUNT(DISTINCT `owner_id`) AS `players`, COALESCE(SUM(`fee_amount`), 0) AS `fee` ' +
  'FROM `agent_revenue_events` WHERE `agent_id` IN';
const PLAYERS_SQL =
  'SELECT `owner_id`, `phone_masked`, `bound_at` FROM `agent_bindings` WHERE `agent_id` = ? ' +
  'ORDER BY `bound_at` DESC, `owner_id` DESC LIMIT ? OFFSET ?';
const PLAYER_REVENUE_SQL =
  'SELECT `owner_id`, COUNT(*) AS `cnt`, COALESCE(SUM(`fee_amount`), 0) AS `fee`, ' +
  'COALESCE(SUM(`base_amount`), 0) AS `base` FROM `agent_revenue_events` ' +
  'WHERE `agent_id` = ? AND `owner_id` IN';
const PLAYER_COMMISSION_SQL =
  'SELECT `owner_id`, COALESCE(SUM(`commission_micro`), 0) AS `micro` ' +
  'FROM `agent_commission_entries` WHERE `agent_id` = ? AND `level` = 0 AND `owner_id` IN';
const PLAYER_QUOTA_SQL =
  'SELECT `owner_id`, `inflow_total`, `consumed_total` FROM `agent_player_quota` WHERE `owner_id` IN';
const COMMISSIONS_SQL =
  'SELECT `id`, `owner_id`, `level`, `rate_bp`, `paid_bp`, `commission_micro`, `kind`, `reason`, ' +
  '`created_at` FROM `agent_commission_entries` WHERE `agent_id` = ? ORDER BY `id` DESC LIMIT ? OFFSET ?';
const BINDINGS_BY_OWNERS_SQL =
  'SELECT `owner_id`, `phone_masked` FROM `agent_bindings` WHERE `owner_id` IN';

export interface AgentProfile {
  id: string;
  name: string;
  phoneMasked: string;
  rateBp: number;
  status: string;
  region: string | null;
  contactName: string | null;
  inviteCode: string | null;
  payout: { name: string | null; accountMasked: string | null; bank: string | null };
}

export interface PlayerRow {
  ownerId: string;
  nickname: string | null;
  phoneMasked: string;
  boundAt: Date | null;
  games: number;
  feeAmount: number;
  baseAmount: number;
  remainingQuota: number;
  commissionMicro: number;
}

export interface CommissionRow {
  id: number;
  level: number;
  ownerId: string | null;
  nickname: string | null;
  phoneMasked: string | null;
  rateBp: number;
  paidBp: number;
  commissionMicro: number;
  kind: string;
  reason: string | null;
  settled: boolean;
  createdAt: Date | null;
}

export interface SettlementLineView extends SettlementLine {
  nickname: string | null;
  phoneMasked: string | null;
}

function inClause(n: number): string {
  return `(${Array.from({ length: n }, () => '?').join(',')})`;
}

function maskAccount(account: string | null): string | null {
  if (account === null || account.length === 0) return null;
  return account.length <= 4 ? '****' : `****${account.slice(-4)}`;
}

function maskPhoneOf(phone: string): string {
  return phone.length < 7 ? phone : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/**
 * 代理门户读面（spec §8.2）：
 * - 所有查询都带 `agent_id = token`（控制器从 guard 取）；
 * - level > 0 的佣金**不返回玩家身份**（上级只看级差金额）；
 * - 昵称 RPC 失败降级 null；手机号用绑定行里的 `phone_masked`（不额外拉 PII）。
 */
@Injectable()
export class AgentPortalService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AgentInviteService) private readonly invite: AgentInviteService,
    @Inject(AgentSettlementService) private readonly settlements: AgentSettlementService,
    @Inject(AgentUserClient) private readonly users: AgentUserClient,
  ) {}

  async profile(agentId: string): Promise<AgentProfile> {
    const row = await this.agentRow(agentId);
    return {
      id: String(row.id),
      name: String(row.name),
      phoneMasked: maskPhoneOf(String(row.phone)),
      rateBp: toSafeInt(row.rate_bp, 'agent_accounts.rate_bp'),
      status: String(row.status),
      region: row.region === null ? null : String(row.region),
      contactName: row.contact_name === null ? null : String(row.contact_name),
      inviteCode: await this.invite.activeCode(agentId),
      payout: {
        name: row.payout_name === null ? null : String(row.payout_name),
        accountMasked: maskAccount(row.payout_account === null ? null : String(row.payout_account)),
        bank: row.payout_bank === null ? null : String(row.payout_bank),
      },
    };
  }

  async overview(agentId: string): Promise<Record<string, unknown>> {
    const row = await this.agentRow(agentId);
    const [direct, active, revenue, commission, unsettled, paid, override] = await Promise.all([
      this.scalar(DIRECT_COUNT_SQL, [agentId]),
      this.scalar(ACTIVE_COUNT_SQL, [agentId]),
      this.dataSource.query(REVENUE_SUM_SQL, [agentId]) as Promise<Array<Record<string, unknown>>>,
      this.scalar(COMMISSION_SUM_SQL, [agentId]),
      this.scalar(UNSETTLED_SUM_SQL, [
        agentId,
        toSafeInt(row.settled_watermark, 'agent_accounts.settled_watermark'),
      ]),
      this.scalar(PAID_SUM_SQL, [agentId]),
      this.scalar(OVERRIDE_SUM_SQL, [agentId]),
    ]);
    const subtreeIds = await this.descendants(agentId);
    let subtree: Record<string, unknown> | null = null;
    if (subtreeIds.length > 0) {
      const rows = (await this.dataSource.query(
        `${SUBTREE_REVENUE_SQL}${inClause(subtreeIds.length)}`,
        subtreeIds,
      )) as Array<Record<string, unknown>>;
      subtree = {
        agents: subtreeIds.length,
        players: toSafeInt(rows[0]?.players ?? 0, 'subtree.players'),
        feeAmount: toSafeInt(rows[0]?.fee ?? 0, 'subtree.fee'),
      };
    }
    const carry = toSafeInt(row.micro_carry, 'agent_accounts.micro_carry');
    return {
      agent: await this.profile(agentId),
      directPlayers: direct,
      activePlayers30d: active,
      grossFeeAmount: toSafeInt(revenue[0]?.fee ?? 0, 'overview.fee'),
      baseAmount: toSafeInt(revenue[0]?.base ?? 0, 'overview.base'),
      commissionMicro: commission,
      unsettledMicro: unsettled,
      carryMicro: carry,
      // 负 manual 可让 carry 为负；门户只展示可得金额（结算侧 total<=0 会拒绝申请）。
      unsettledCoins: Math.max(0, Math.floor((carry + unsettled) / 10_000)),
      paidCoins: paid,
      overrideMicro: override,
      subtree,
    };
  }

  async players(agentId: string, page: number, pageSize: number): Promise<PlayerRow[]> {
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const offset = Math.max(Math.trunc(page), 0) * size;
    const rows = (await this.dataSource.query(PLAYERS_SQL, [agentId, size, offset])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return [];
    const ownerIds = rows.map((r) => String(r.owner_id));
    const placeholders = inClause(ownerIds.length);
    const [revenueRows, commissionRows, quotaRows, bindingRows, nicknames] = await Promise.all([
      this.dataSource.query(`${PLAYER_REVENUE_SQL}${placeholders} GROUP BY \`owner_id\``, [
        agentId,
        ...ownerIds,
      ]) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(`${PLAYER_COMMISSION_SQL}${placeholders} GROUP BY \`owner_id\``, [
        agentId,
        ...ownerIds,
      ]) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(`${PLAYER_QUOTA_SQL}${placeholders}`, ownerIds) as Promise<
        Array<Record<string, unknown>>
      >,
      this.dataSource.query(`${BINDINGS_BY_OWNERS_SQL}${placeholders}`, ownerIds) as Promise<
        Array<Record<string, unknown>>
      >,
      this.users.nicknames(ownerIds).catch(() => []),
    ]);
    const revenueBy = new Map(revenueRows.map((r) => [String(r.owner_id), r]));
    const commissionBy = new Map(commissionRows.map((r) => [String(r.owner_id), r]));
    const quotaBy = new Map(quotaRows.map((r) => [String(r.owner_id), r]));
    const maskedBy = new Map(bindingRows.map((r) => [String(r.owner_id), String(r.phone_masked)]));
    const nicknameBy = new Map(nicknames.map((n) => [n.userId, n.nickname]));
    return rows.map((r) => {
      const ownerId = String(r.owner_id);
      const quota = quotaBy.get(ownerId);
      const inflow = quota === undefined ? 0 : toSafeInt(quota.inflow_total, 'quota.inflow');
      const consumed = quota === undefined ? 0 : toSafeInt(quota.consumed_total, 'quota.consumed');
      const revenue = revenueBy.get(ownerId);
      const commission = commissionBy.get(ownerId);
      return {
        ownerId,
        nickname: nicknameBy.get(ownerId) ?? null,
        phoneMasked: maskedBy.get(ownerId) ?? String(r.phone_masked),
        boundAt: toDate(r.bound_at, 'agent_bindings.bound_at'),
        games: revenue === undefined ? 0 : toSafeInt(revenue.cnt, 'player.games'),
        feeAmount: revenue === undefined ? 0 : toSafeInt(revenue.fee, 'player.fee'),
        baseAmount: revenue === undefined ? 0 : toSafeInt(revenue.base, 'player.base'),
        remainingQuota: Math.max(0, inflow - consumed),
        commissionMicro: commission === undefined ? 0 : toSafeInt(commission.micro, 'player.micro'),
      };
    });
  }

  async commissions(agentId: string, page: number, pageSize: number): Promise<CommissionRow[]> {
    const row = await this.agentRow(agentId);
    const watermark = toSafeInt(row.settled_watermark, 'agent_accounts.settled_watermark');
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const offset = Math.max(Math.trunc(page), 0) * size;
    const rows = (await this.dataSource.query(COMMISSIONS_SQL, [
      agentId,
      size,
      offset,
    ])) as Array<Record<string, unknown>>;
    const directOwnerIds = [
      ...new Set(
        rows
          .filter((r) => Number(r.level) === 0 && r.owner_id !== null)
          .map((r) => String(r.owner_id)),
      ),
    ];
    const [bindings, nicknames] = await Promise.all([
      directOwnerIds.length === 0
        ? Promise.resolve([] as Array<Record<string, unknown>>)
        : (this.dataSource.query(
            `${BINDINGS_BY_OWNERS_SQL}${inClause(directOwnerIds.length)}`,
            directOwnerIds,
          ) as Promise<Array<Record<string, unknown>>>),
      directOwnerIds.length === 0
        ? Promise.resolve([])
        : this.users.nicknames(directOwnerIds).catch(() => []),
    ]);
    const maskedBy = new Map(bindings.map((b) => [String(b.owner_id), String(b.phone_masked)]));
    const nicknameBy = new Map(nicknames.map((n) => [n.userId, n.nickname]));
    return rows.map((r) => {
      const level = toSafeInt(r.level, 'agent_commission_entries.level');
      const ownerId = r.owner_id === null ? null : String(r.owner_id);
      const direct = level === 0 && ownerId !== null;
      return {
        id: toSafeInt(r.id, 'agent_commission_entries.id'),
        level,
        ownerId: direct ? ownerId : null,
        nickname: direct ? (nicknameBy.get(ownerId) ?? null) : null,
        phoneMasked: direct ? (maskedBy.get(ownerId) ?? null) : null,
        rateBp: toSafeInt(r.rate_bp, 'agent_commission_entries.rate_bp'),
        paidBp: toSafeInt(r.paid_bp, 'agent_commission_entries.paid_bp'),
        commissionMicro: toSafeInt(r.commission_micro, 'agent_commission_entries.commission_micro'),
        kind: String(r.kind),
        reason: r.reason === null ? null : String(r.reason),
        settled: toSafeInt(r.id, 'agent_commission_entries.id') <= watermark,
        createdAt: toDate(r.created_at, 'agent_commission_entries.created_at'),
      };
    });
  }

  async settlementDetail(
    agentId: string,
    id: number,
  ): Promise<{ settlement: SettlementRow; lines: SettlementLineView[] } | null> {
    const settlement = await this.settlements.getById(id);
    if (settlement === null || settlement.agentId !== agentId) return null;
    const lines = await this.settlements.lines(agentId, id);
    const directOwnerIds = [
      ...new Set(
        lines
          .filter((l) => l.level === 0 && l.ownerId !== null)
          .map((l) => String(l.ownerId)),
      ),
    ];
    const [bindings, nicknames] = await Promise.all([
      directOwnerIds.length === 0
        ? Promise.resolve([] as Array<Record<string, unknown>>)
        : (this.dataSource.query(
            `${BINDINGS_BY_OWNERS_SQL}${inClause(directOwnerIds.length)}`,
            directOwnerIds,
          ) as Promise<Array<Record<string, unknown>>>),
      directOwnerIds.length === 0
        ? Promise.resolve([])
        : this.users.nicknames(directOwnerIds).catch(() => []),
    ]);
    const maskedBy = new Map(bindings.map((b) => [String(b.owner_id), String(b.phone_masked)]));
    const nicknameBy = new Map(nicknames.map((n) => [n.userId, n.nickname]));
    return {
      settlement,
      lines: lines.map((l) => ({
        ...l,
        ownerId: l.level === 0 ? l.ownerId : null,
        nickname: l.level === 0 && l.ownerId !== null ? (nicknameBy.get(l.ownerId) ?? null) : null,
        phoneMasked:
          l.level === 0 && l.ownerId !== null ? (maskedBy.get(l.ownerId) ?? null) : null,
      })),
    };
  }

  async subtree(agentId: string): Promise<Record<string, unknown> | null> {
    const ids = await this.descendants(agentId);
    if (ids.length === 0) return null;
    const rows = (await this.dataSource.query(
      `${SUBTREE_REVENUE_SQL}${inClause(ids.length)}`,
      ids,
    )) as Array<Record<string, unknown>>;
    return {
      agents: ids.length,
      players: toSafeInt(rows[0]?.players ?? 0, 'subtree.players'),
      feeAmount: toSafeInt(rows[0]?.fee ?? 0, 'subtree.fee'),
    };
  }

  private async agentRow(agentId: string): Promise<Record<string, unknown>> {
    const rows = (await this.dataSource.query(AGENT_ROW_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw new DomainError(ErrCode.USER_NOT_FOUND, '代理不存在');
    return rows[0]!;
  }

  private async scalar(sql: string, params: unknown[]): Promise<number> {
    const rows = (await this.dataSource.query(sql, params)) as Array<Record<string, unknown>>;
    const value = rows[0]?.cnt ?? rows[0]?.micro ?? rows[0]?.coins ?? 0;
    return toSafeInt(value, 'portal.scalar');
  }

  private async descendants(agentId: string): Promise<string[]> {
    const rows = (await this.dataSource.query(DESCENDANTS_CTE, [agentId, agentId])) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => String(r.id));
  }
}
