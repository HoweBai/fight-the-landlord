import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ApplyService } from '../apply/apply.service';
import { httpException } from '../http/errors';
import { XAdminGuard, adminActorOf, type AdminRequest } from '../http/x-admin.guard';

/**
 * 管理 REST（T5；规格 §2.6 / §6.1 http.controller 行）：`POST /api/admin/wallet/adjust` +
 * `GET /api/admin/wallet/accounts/:userId`。守卫 = `XAdminGuard`（fail-closed，见该文件头）。
 *
 * ─── adjust（§2.6 逐字）─────────────────────────────────────────────────
 *  - body 契约：`{userId: 1..36 字符（字符集同 §2.3）, delta: int≠0 且 |d|≤1,000,000,
 *    reason: 1..200 必填, actionId?: 非空≤128, ownerType?: 'user'|'robot'}`；`actionId`
 *    缺省 ⇒ `admin:<randomUUID()>`；
 *  - 映射 apply：source=`admin_adjust`、**actor=网关注入的 `X-Admin-Actor`**（③ T6 接线；
 *    由 `XAdminGuard` 校验并随请求带给 handler——缺失/非法在 guard 即 401「管理身份缺失」，
 *    本端点**绝不**回退 `'admin'` 字面量：回退就是身份伪造面）、refId=null、
 *    entries=[{ownerId:userId, ownerType?, delta}]；**ownerType 透传**（② 金币场 §7 的
 *    种子通道：缺省归一 `'user'` 向后兼容；池种子/机器人注资传 `'robot'` —— 不透传会以
 *    user 建池户、与 refill 载荷的 `ownerType:'robot'` 相撞 10001）；
 *  - 成功/重放 ⇒ **200** `{balanceBefore, balanceAfter, opId}`：`balanceAfter` 取 apply 响应
 *    （首笔 = 本次快照；重放 = `flows` 的**历史**快照），`balanceBefore = balanceAfter − delta`
 *    （重放时同载荷 ⇒ 同 delta ⇒ 还原首笔的 Before）；
 *  - 错误映射：校验失败（apply 信封 10001 或本端点的 201..255 字 reason）⇒ **400**；
 *    14001/14002 ⇒ **409**（都经 `http/errors.ts` 的映射表，不手写状态码）；
 *  - **不允许扣成负数**：由 §2.3 内核 SQL 裁决 ⇒ 14001（管理员也不越权）——本控制器不预检余额
 *    （「先读再判再写」正是内核明令禁止的形态）。
 *
 * ⚠️ **reason 本端点先闸 1..200**：`validateCurrencyApply` 的列宽闸是 ≤255（ops.reason 列宽），
 *     admin body 契约更严（§2.6 = 1..200）——201..255 的 reason 必须在**进内核之前**拒掉
 *    （否则管理面契约被内核的宽限偷偷放宽）。
 *
 * ─── accounts/:userId（§2.6 逐字）──────────────────────────────────────
 *  - **读源 = MySQL 直读**（绕过 Redis——避开写穿窗口旧值；「发放后当场核对」的可用性前提）；
 *  - `recentFlows` ≤20 条 `id DESC`（新→旧）、JOIN ops 取 source/reason（两字段在 op 级）、
 *    `createdAt` = epoch ms；未开户 ⇒ **200** `{balance:0, recentFlows:[]}`（⚙️7）；
 *  - 两处就地判读（依据写在这里）：① `createdAt` 取 **flows 行**的 `created_at`（§2.6 只把
 *    source/reason 归到 op 级；行级时间 = 该笔流水的时间）；② path userId **不做字符集预检**——
 *    §2.6 没有这条错误面，任何字符串都只是「查这个 ownerId」，未开户即空态 200。
 *
 * ⚠️ **DI 纪律**：`ApplyService`/`DataSource` 值导入 + 显式 `@Inject(...)`（本仓既有惯例）。
 */
export const WALLET_ACCOUNTS_LIMIT = 20;

/** 直读余额（与 §2.3 快照 / `GetService` 回源同形；走 MySQL，不碰 Redis）。 */
const BALANCE_SELECT_SQL = 'SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = ?';

/** recentFlows（§2.6）：`id DESC` 新→旧 + 恰 20 上限；JOIN ops 取 source/reason。 */
const RECENT_FLOWS_SQL =
  'SELECT f.`delta`, f.`balance_after`, f.`created_at`, o.`source`, o.`reason` ' +
  'FROM `currency_flows` f JOIN `currency_ops` o ON o.`id` = f.`op_id` ' +
  'WHERE f.`owner_id` = ? ORDER BY f.`id` DESC LIMIT 20';

/** §2.6 body 契约（值一律 `unknown`：唯一校验点是 apply 内核 + 本端点的 reason 闸）。 */
interface AdjustBody {
  userId?: unknown;
  delta?: unknown;
  reason?: unknown;
  actionId?: unknown;
  /** ② 金币场 §7：`'user'`（缺省）/`'robot'`（池种子/机器人注资）——校验在归一化函数。 */
  ownerType?: unknown;
}

export interface AdminWalletAdjustResult {
  balanceBefore: number;
  balanceAfter: number;
  opId: number;
}

export interface AdminWalletRecentFlow {
  delta: number;
  balanceAfter: number;
  source: string;
  reason: string | null;
  createdAt: number;
}

export interface AdminWalletAccounts {
  balance: number;
  recentFlows: AdminWalletRecentFlow[];
}

/** 从库里读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默 NaN 进 JSON）。 */
function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** `datetime(3)` 的三种驱动形态 ⇒ epoch ms 整数（照 `records.service.ts:110-115` 先例）。 */
function toEpochMs(value: unknown, context: string): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}：读出的时间不是有限毫秒（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

@Controller('admin/wallet')
@UseGuards(XAdminGuard)
export class AdminWalletController {
  constructor(
    @Inject(ApplyService) private readonly applyService: ApplyService,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  @Post('adjust')
  @HttpCode(200) // POST 的 Nest 缺省是 201；本端点成功/重放都按 200（§2.6；管理页按 status===200 分流）
  async adjust(
    @Body() body: AdjustBody,
    @Req() req: AdminRequest,
  ): Promise<{ code: ErrCode; data: AdminWalletAdjustResult }> {
    // ③ T6 actor 接线（§2.7）：写端点的 actor 由 XAdminGuard 从 `X-Admin-Actor` 校验后带到
    // 此处（缺失/非法 ⇒ 401「管理身份缺失」fail-closed，绝不回退默认值）。
    const actor = adminActorOf(req);

    // admin body 契约比 apply 内核更严的一条：reason 1..200（§2.6；内核列宽闸是 ≤255）。
    const reason = body?.reason;
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) {
      throw httpException(
        ErrCode.BAD_PARAM,
        `reason 必须是 1..200 字符的非空字符串（收到 ${JSON.stringify(reason)}）`,
      );
    }

    // 映射 apply（§2.6「读源纪律」段）：actionId 缺省 = `admin:<randomUUID()>`；
    // 其余字段的校验（userId 字符集 / delta 域 / actionId 非空≤128 / ownerType ∈ allowlist）
    // 在内核的唯一校验点。ownerType **原样透传**（缺省 ⇒ 归一 'user'，向后兼容，② §7）。
    const applyRequest = {
      actionId: body?.actionId ?? `admin:${randomUUID()}`,
      source: 'admin_adjust',
      actor,
      reason,
      entries: [{ ownerId: body?.userId, ownerType: body?.ownerType, delta: body?.delta }],
    };

    const res = await this.applyService.apply(applyRequest);
    if (!res.ok) throw httpException(res.code, res.message); // 10001⇒400 / 14001·14002⇒409（映射表收口）

    const entry = res.data.entries[0];
    if (entry === undefined || res.data.entries.length !== 1) {
      throw new Error('apply 成功但 entries 与单条请求不同构（不变量破坏）');
    }
    const delta = body?.delta;
    if (typeof delta !== 'number' || !Number.isInteger(delta)) {
      throw new Error('apply 成功但 delta 不是整数（不变量破坏）');
    }
    return {
      code: ErrCode.OK,
      data: { balanceBefore: entry.balanceAfter - delta, balanceAfter: entry.balanceAfter, opId: res.data.opId },
    };
  }


  /**
   * 批量余额（玩家管理页 2026-10-22）：1–100 个 userId 去重；未开户 ⇒ balance 0/exists false。
   * 只读；owner_type='user'（池/机器人户不属于玩家）。
   */
  @Post('accounts/batch')
  @HttpCode(200)
  async batchAccounts(
    @Body() body: { userIds?: unknown },
  ): Promise<{ code: ErrCode; data: { accounts: Array<{ userId: string; balance: number; exists: boolean }> } }> {
    const userIds = normalizeUserIds(body?.userIds);
    const rows =
      userIds.length === 0
        ? []
        : ((await this.dataSource.query(
            `SELECT owner_id, balance FROM currency_accounts WHERE owner_type='user' AND owner_id IN (${userIds
              .map(() => '?')
              .join(',')})`,
            userIds,
          )) as Array<{ owner_id: unknown; balance: unknown }>);
    const byId = new Map(rows.map((r) => [String(r.owner_id), toSafeInt(r.balance, 'currency_accounts.balance')]));
    return {
      code: ErrCode.OK,
      data: {
        accounts: userIds.map((userId) => ({
          userId,
          balance: byId.get(userId) ?? 0,
          exists: byId.has(userId),
        })),
      },
    };
  }

  @Get('accounts/:userId')
  async accounts(
    @Param('userId') userId: string,
  ): Promise<{ code: ErrCode; data: AdminWalletAccounts }> {
    const rows = (await this.dataSource.query(BALANCE_SELECT_SQL, [userId])) as Array<{
      balance: unknown;
    }>;
    if (rows.length === 0) {
      return { code: ErrCode.OK, data: { balance: 0, recentFlows: [] } }; // ⚙️7：未开户 = 空态
    }
    const balance = toSafeInt(rows[0]!.balance, `currency_accounts.balance ownerId=${userId}`);

    const flowRows = (await this.dataSource.query(RECENT_FLOWS_SQL, [userId])) as Array<{
      delta: unknown;
      balance_after: unknown;
      created_at: unknown;
      source: unknown;
      reason: unknown;
    }>;
    const recentFlows = flowRows.map((row) => ({
      delta: toSafeInt(row.delta, 'currency_flows.delta'),
      balanceAfter: toSafeInt(row.balance_after, 'currency_flows.balance_after'),
      source: String(row.source),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      createdAt: toEpochMs(row.created_at, 'currency_flows.created_at'),
    }));
    return { code: ErrCode.OK, data: { balance, recentFlows } };
  }
}

/** 批量 userIds：数组、1–100、去重、每个 1–36；非法 ⇒ 400（10001）。 */
function normalizeUserIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    throw httpException(ErrCode.BAD_PARAM, 'userIds 必须是 1–100 个元素的数组');
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 36) {
      throw httpException(ErrCode.BAD_PARAM, 'userIds 元素必须是 1–36 字符的字符串');
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
