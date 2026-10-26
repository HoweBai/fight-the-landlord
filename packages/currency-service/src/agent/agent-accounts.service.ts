import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { AGENT_MAX_DEPTH, RATE_BP_MAX } from './agent.constants';
import { AgentSettingsService } from './agent-settings.service';
import { AgentInviteService } from './agent-invite.service';
import { generatePassword, hashPassword } from './agent-password';
import { normalizePhone, toDate, toSafeInt } from './agent.util';

export type AgentStatus = 'active' | 'frozen';

export interface AgentAccount {
  id: string;
  name: string;
  phone: string;
  parentId: string | null;
  rateBp: number;
  region: string | null;
  contactName: string | null;
  payoutName: string | null;
  payoutAccount: string | null;
  payoutBank: string | null;
  status: AgentStatus;
  mustChangePassword: boolean;
  createdAt: Date | null;
}

export interface CreateAgentInput {
  name: string;
  phone: string;
  password?: string;
  parentId?: string | null;
  rateBp?: number;
  region?: string | null;
  contactName?: string | null;
  payoutName?: string | null;
  payoutAccount?: string | null;
  payoutBank?: string | null;
}

export interface UpdateAgentPatch {
  name?: string;
  parentId?: string | null;
  rateBp?: number;
  region?: string | null;
  contactName?: string | null;
  payoutName?: string | null;
  payoutAccount?: string | null;
  payoutBank?: string | null;
}

const ACCOUNT_COLUMNS =
  '`id`, `name`, `phone`, `parent_id`, `rate_bp`, `region`, `contact_name`, `payout_name`, ' +
  '`payout_account`, `payout_bank`, `status`, `must_change_password`, `created_at`';
const ACCOUNT_SELECT_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM \`agent_accounts\``;
const ACCOUNT_BY_ID_SQL = `${ACCOUNT_SELECT_SQL} WHERE \`id\` = ?`;
const ACCOUNT_BY_ID_FOR_UPDATE_SQL = `${ACCOUNT_BY_ID_SQL} FOR UPDATE`;
const ACCOUNT_TREE_FOR_UPDATE_SQL =
  'SELECT `id`, `parent_id`, `rate_bp`, `status` FROM `agent_accounts` FOR UPDATE';
const ACCOUNT_INSERT_SQL =
  'INSERT INTO `agent_accounts` (`id`, `name`, `phone`, `password_hash`, `parent_id`, `rate_bp`, ' +
  '`region`, `contact_name`, `payout_name`, `payout_account`, `payout_bank`, `status`, ' +
  "`must_change_password`, `token_version`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 0)";
const ACCOUNT_UPDATE_SQL =
  'UPDATE `agent_accounts` SET `name` = ?, `parent_id` = ?, `rate_bp` = ?, `region` = ?, ' +
  '`contact_name` = ?, `payout_name` = ?, `payout_account` = ?, `payout_bank` = ? WHERE `id` = ?';
const ACCOUNT_STATUS_SQL =
  'UPDATE `agent_accounts` SET `status` = ?, `token_version` = `token_version` + ? WHERE `id` = ?';
const ACCOUNT_PASSWORD_SQL =
  'UPDATE `agent_accounts` SET `password_hash` = ?, `must_change_password` = 1, ' +
  '`token_version` = `token_version` + 1 WHERE `id` = ?';
const ACCOUNT_PAYOUT_SQL =
  'UPDATE `agent_accounts` SET `payout_name` = ?, `payout_account` = ?, `payout_bank` = ? WHERE `id` = ?';
const RATE_HISTORY_INSERT_SQL =
  'INSERT INTO `agent_rates` (`agent_id`, `rate_bp`, `actor`, `reason`) VALUES (?, ?, ?, ?)';
const STATUS_HISTORY_INSERT_SQL =
  'INSERT INTO `agent_status_history` (`agent_id`, `status`, `actor`, `reason`) VALUES (?, ?, ?, ?)';
const AUDIT_INSERT_SQL =
  'INSERT INTO `agent_admin_audit` (`actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';
const CHILD_COUNT_SQL = 'SELECT COUNT(*) AS `cnt` FROM `agent_accounts` WHERE `parent_id` = ?';
const BINDING_COUNT_SQL = 'SELECT COUNT(*) AS `cnt` FROM `agent_bindings` WHERE `agent_id` = ?';
const AUDIT_LIST_SQL =
  'SELECT `id`, `actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`, `created_at` ' +
  'FROM `agent_admin_audit` ORDER BY `id` DESC LIMIT ? OFFSET ?';

function isDuplicate(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown };
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
}

function assertRate(rateBp: number): number {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > RATE_BP_MAX) {
    throw new DomainError(ErrCode.AGENT_RATE_INVALID, `分成比例必须是 0–100 的整数（收到 ${rateBp}）`);
  }
  return rateBp;
}

function assertName(name: string): string {
  const v = name.trim();
  if (v.length === 0 || v.length > 50) {
    throw new DomainError(ErrCode.BAD_PARAM, '代理名称必须 1–50 字符');
  }
  return v;
}

interface TreeRow {
  id: string;
  parentId: string | null;
  rateBp: number;
  status: string;
}

/**
 * 代理账号/树/比例/状态（spec §5/§9）。
 *
 * 树校验（写侧）：**事务内 `SELECT ... FOR UPDATE` 锁全表**（代理数量小）——
 * 同时防「并发改父/改比例」破坏 `parent ≥ self ≥ max(child)`、环与深度 ≤5。
 * 单测用假 manager 钉控制流；并发不变量由 slice-30 真 MySQL 判。
 */
@Injectable()
export class AgentAccountsService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AgentSettingsService) private readonly settings: AgentSettingsService,
    @Inject(AgentInviteService) private readonly invite: AgentInviteService,
  ) {}

  async create(
    input: CreateAgentInput,
    actor: string,
  ): Promise<{ account: AgentAccount; initialPassword: string | null; inviteCode: string }> {
    const name = assertName(input.name);
    const phone = normalizePhone(input.phone);
    if (phone.length === 0 || phone.length > 20) {
      throw new DomainError(ErrCode.BAD_PARAM, '手机号必须 1–20 字符');
    }
    const settings = await this.settings.getOrDefault();
    const rateBp = assertRate(input.rateBp ?? settings.defaultRateBp);
    const password = input.password ?? generatePassword();
    const passwordHash = await hashPassword(password);
    const id = `ag_${randomUUID()}`;

    return this.dataSource.transaction(async (manager) => {
      const tree = await this.loadTreeForUpdate(manager);
      if (input.parentId !== undefined && input.parentId !== null) {
        const parent = tree.get(input.parentId);
        if (parent === undefined) throw new DomainError(ErrCode.BAD_PARAM, '上级代理不存在');
        if (parent.status !== 'active') throw new DomainError(ErrCode.BAD_PARAM, '上级代理已冻结');
        if (parent.rateBp < rateBp) {
          throw new DomainError(ErrCode.AGENT_RATE_INVALID, '上级比例必须 ≥ 下级比例');
        }
        if (this.depthOf(tree, input.parentId) + 1 > AGENT_MAX_DEPTH) {
          throw new DomainError(ErrCode.AGENT_RATE_INVALID, `代理层级不能超过 ${AGENT_MAX_DEPTH} 级`);
        }
      }
      try {
        await manager.query(ACCOUNT_INSERT_SQL, [
          id,
          name,
          phone,
          passwordHash,
          input.parentId ?? null,
          rateBp,
          input.region ?? null,
          input.contactName ?? null,
          input.payoutName ?? null,
          input.payoutAccount ?? null,
          input.payoutBank ?? null,
        ]);
      } catch (err) {
        if (isDuplicate(err)) throw new DomainError(ErrCode.BAD_PARAM, '手机号已存在');
        throw err;
      }
      await manager.query(RATE_HISTORY_INSERT_SQL, [id, rateBp, actor, 'create']);
      const inviteCode = await this.invite.createFor(manager, id);
      await this.audit(manager, actor, 'agent.create', id, null, { name, phone, parentId: input.parentId ?? null, rateBp }, null);
      const account = await this.readById(manager, id);
      return { account, initialPassword: input.password === undefined ? password : null, inviteCode };
    });
  }

  async update(
    id: string,
    patch: UpdateAgentPatch,
    actor: string,
    reason: string,
  ): Promise<AgentAccount> {
    return this.dataSource.transaction(async (manager) => {
      const tree = await this.loadTreeForUpdate(manager);
      const current = tree.get(id);
      if (current === undefined) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      const nextRate = patch.rateBp === undefined ? current.rateBp : assertRate(patch.rateBp);
      const nextParent =
        patch.parentId === undefined ? current.parentId : patch.parentId;
      if (nextParent === id) throw new DomainError(ErrCode.AGENT_RATE_INVALID, '上级不能是自己');
      if (nextParent !== null) {
        const parent = tree.get(nextParent);
        if (parent === undefined) throw new DomainError(ErrCode.BAD_PARAM, '上级代理不存在');
        if (parent.status !== 'active') throw new DomainError(ErrCode.BAD_PARAM, '上级代理已冻结');
        if (this.depthOf(tree, nextParent) + 1 > AGENT_MAX_DEPTH) {
          throw new DomainError(ErrCode.AGENT_RATE_INVALID, `代理层级不能超过 ${AGENT_MAX_DEPTH} 级`);
        }
        if (this.isDescendant(tree, id, nextParent)) {
          throw new DomainError(ErrCode.AGENT_RATE_INVALID, '不能把上级设为自己的下级（成环）');
        }
        if (parent.rateBp < nextRate) {
          throw new DomainError(ErrCode.AGENT_RATE_INVALID, '上级比例必须 ≥ 下级比例');
        }
      }
      const maxChild = Math.max(
        0,
        ...[...tree.values()].filter((a) => a.parentId === id).map((a) => a.rateBp),
      );
      if (nextRate < maxChild) {
        throw new DomainError(ErrCode.AGENT_RATE_INVALID, '下级比例不能高于本级比例');
      }
      const subtreeHeight = this.heightOf(tree, id);
      const newDepth = nextParent === null ? 1 : this.depthOf(tree, nextParent) + 1;
      if (newDepth + subtreeHeight > AGENT_MAX_DEPTH) {
        throw new DomainError(ErrCode.AGENT_RATE_INVALID, `代理层级不能超过 ${AGENT_MAX_DEPTH} 级`);
      }

      const before = await this.readById(manager, id);
      await manager.query(ACCOUNT_UPDATE_SQL, [
        patch.name === undefined ? before.name : assertName(patch.name),
        nextParent,
        nextRate,
        patch.region === undefined ? before.region : patch.region,
        patch.contactName === undefined ? before.contactName : patch.contactName,
        patch.payoutName === undefined ? before.payoutName : patch.payoutName,
        patch.payoutAccount === undefined ? before.payoutAccount : patch.payoutAccount,
        patch.payoutBank === undefined ? before.payoutBank : patch.payoutBank,
        id,
      ]);
      if (nextRate !== current.rateBp) {
        await manager.query(RATE_HISTORY_INSERT_SQL, [id, nextRate, actor, reason]);
      }
      const after = await this.readById(manager, id);
      await this.audit(manager, actor, 'agent.update', id, before, after, reason);
      return after;
    });
  }

  async setStatus(
    id: string,
    status: AgentStatus,
    actor: string,
    reason: string,
  ): Promise<AgentAccount> {
    if (status !== 'active' && status !== 'frozen') {
      throw new DomainError(ErrCode.BAD_PARAM, '状态必须是 active/frozen');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(ACCOUNT_BY_ID_FOR_UPDATE_SQL, [id])) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      const before = mapAccount(rows[0]!);
      if (before.status !== status) {
        await manager.query(ACCOUNT_STATUS_SQL, [status, status === 'frozen' ? 1 : 0, id]);
        await manager.query(STATUS_HISTORY_INSERT_SQL, [id, status, actor, reason]);
      }
      const after = await this.readById(manager, id);
      await this.audit(manager, actor, 'agent.status', id, before, after, reason);
      return after;
    });
  }

  async resetPassword(id: string, actor: string): Promise<{ password: string }> {
    const password = generatePassword();
    const hash = await hashPassword(password);
    await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(ACCOUNT_BY_ID_FOR_UPDATE_SQL, [id])) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      await manager.query(ACCOUNT_PASSWORD_SQL, [hash, id]);
      await this.audit(manager, actor, 'agent.password.reset', id, null, { mustChangePassword: true }, null);
    });
    return { password };
  }

  async rotateInviteCode(id: string, actor: string): Promise<{ code: string }> {
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(ACCOUNT_BY_ID_FOR_UPDATE_SQL, [id])) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      const code = await this.invite.rotate(manager, id);
      await this.audit(manager, actor, 'agent.invite.rotate', id, null, { code }, null);
      return { code };
    });
  }

  async updatePayout(
    id: string,
    payout: { payoutName: string | null; payoutAccount: string | null; payoutBank: string | null },
    actor: string,
    reason: string,
  ): Promise<AgentAccount> {
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(ACCOUNT_BY_ID_FOR_UPDATE_SQL, [id])) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      const before = mapAccount(rows[0]!);
      await manager.query(ACCOUNT_PAYOUT_SQL, [
        payout.payoutName,
        payout.payoutAccount,
        payout.payoutBank,
        id,
      ]);
      const after = await this.readById(manager, id);
      await this.audit(manager, actor, 'agent.payout.update', id, before, after, reason);
      return after;
    });
  }

  async get(id: string): Promise<{
    account: AgentAccount;
    children: number;
    bindings: number;
  } | null> {
    const rows = (await this.dataSource.query(ACCOUNT_BY_ID_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return null;
    const childRows = (await this.dataSource.query(CHILD_COUNT_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    const bindRows = (await this.dataSource.query(BINDING_COUNT_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    return {
      account: mapAccount(rows[0]!),
      children: Number(childRows[0]?.cnt ?? 0),
      bindings: Number(bindRows[0]?.cnt ?? 0),
    };
  }

  async list(input: {
    status?: AgentStatus;
    q?: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: AgentAccount[]; total: number }> {
    const size = Math.min(Math.max(Math.trunc(input.pageSize), 1), 100);
    const offset = Math.max(Math.trunc(input.page), 0) * size;
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.status !== undefined) {
      where.push('`status` = ?');
      params.push(input.status);
    }
    if (input.q !== undefined && input.q.trim() !== '') {
      const like = `%${input.q.trim()}%`;
      where.push('(`name` LIKE ? OR `phone` LIKE ? OR `region` LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    const rows = (await this.dataSource.query(
      `${ACCOUNT_SELECT_SQL}${whereSql} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ? OFFSET ?`,
      [...params, size, offset],
    )) as Array<Record<string, unknown>>;
    const countRows = (await this.dataSource.query(
      `SELECT COUNT(*) AS \`cnt\` FROM \`agent_accounts\`${whereSql}`,
      params,
    )) as Array<Record<string, unknown>>;
    return { rows: rows.map(mapAccount), total: Number(countRows[0]?.cnt ?? 0) };
  }

  async tree(): Promise<Array<AgentAccount & { children: unknown[] }>> {
    const rows = (await this.dataSource.query(
      `${ACCOUNT_SELECT_SQL} ORDER BY \`created_at\` ASC, \`id\` ASC`,
    )) as Array<Record<string, unknown>>;
    const accounts = rows.map(mapAccount);
    const byId = new Map(accounts.map((a) => [a.id, { ...a, children: [] as unknown[] }]));
    const roots: Array<AgentAccount & { children: unknown[] }> = [];
    for (const node of byId.values()) {
      if (node.parentId !== null && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async auditList(page: number, pageSize: number): Promise<Array<Record<string, unknown>>> {
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
    const offset = Math.max(Math.trunc(page), 0) * size;
    const rows = (await this.dataSource.query(AUDIT_LIST_SQL, [size, offset])) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: toSafeInt(r.id, 'agent_admin_audit.id'),
      actor: String(r.actor),
      action: String(r.action),
      targetType: String(r.target_type),
      targetId: String(r.target_id),
      before: r.before_json === null ? null : r.before_json,
      after: r.after_json === null ? null : r.after_json,
      reason: r.reason === null ? null : String(r.reason),
      createdAt: toDate(r.created_at, 'agent_admin_audit.created_at'),
    }));
  }

  private async loadTreeForUpdate(manager: EntityManager): Promise<Map<string, TreeRow>> {
    const rows = (await manager.query(ACCOUNT_TREE_FOR_UPDATE_SQL)) as Array<Record<string, unknown>>;
    const map = new Map<string, TreeRow>();
    for (const r of rows) {
      map.set(String(r.id), {
        id: String(r.id),
        parentId: r.parent_id === null ? null : String(r.parent_id),
        rateBp: toSafeInt(r.rate_bp, 'agent_accounts.rate_bp'),
        status: String(r.status),
      });
    }
    return map;
  }

  private depthOf(tree: Map<string, TreeRow>, id: string): number {
    let depth = 1;
    let current = tree.get(id);
    const seen = new Set<string>();
    while (current !== undefined && current.parentId !== null) {
      if (seen.has(current.id)) throw new DomainError(ErrCode.AGENT_RATE_INVALID, '代理树成环');
      seen.add(current.id);
      depth += 1;
      current = tree.get(current.parentId);
    }
    return depth;
  }

  private heightOf(tree: Map<string, TreeRow>, id: string): number {
    let height = 0;
    for (const node of tree.values()) {
      if (node.parentId === id) height = Math.max(height, 1 + this.heightOf(tree, node.id));
    }
    return height;
  }

  private isDescendant(tree: Map<string, TreeRow>, ancestorId: string, candidateId: string): boolean {
    let current = tree.get(candidateId);
    const seen = new Set<string>();
    while (current !== undefined && current.parentId !== null) {
      if (current.parentId === ancestorId) return true;
      if (seen.has(current.id)) throw new DomainError(ErrCode.AGENT_RATE_INVALID, '代理树成环');
      seen.add(current.id);
      current = tree.get(current.parentId);
    }
    return false;
  }

  private async readById(manager: EntityManager, id: string): Promise<AgentAccount> {
    const rows = (await manager.query(ACCOUNT_BY_ID_SQL, [id])) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new Error(`agent_accounts 读不到 id=${id}`);
    return mapAccount(rows[0]!);
  }

  private async audit(
    manager: EntityManager,
    actor: string,
    action: string,
    targetId: string,
    before: unknown,
    after: unknown,
    reason: string | null,
  ): Promise<void> {
    await manager.query(AUDIT_INSERT_SQL, [
      actor,
      action,
      'agent',
      targetId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    ]);
  }
}

function mapAccount(r: Record<string, unknown>): AgentAccount {
  return {
    id: String(r.id),
    name: String(r.name),
    phone: String(r.phone),
    parentId: r.parent_id === null ? null : String(r.parent_id),
    rateBp: toSafeInt(r.rate_bp, 'agent_accounts.rate_bp'),
    region: r.region === null ? null : String(r.region),
    contactName: r.contact_name === null ? null : String(r.contact_name),
    payoutName: r.payout_name === null ? null : String(r.payout_name),
    payoutAccount: r.payout_account === null ? null : String(r.payout_account),
    payoutBank: r.payout_bank === null ? null : String(r.payout_bank),
    status: String(r.status) === 'frozen' ? 'frozen' : 'active',
    mustChangePassword: Number(r.must_change_password) === 1,
    createdAt: toDate(r.created_at, 'agent_accounts.created_at'),
  };
}
