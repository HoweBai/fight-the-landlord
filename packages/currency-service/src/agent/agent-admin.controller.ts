import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError, toHttpException } from '../http/errors';
import { XAdminGuard, adminActorOf, type AdminRequest } from '../http/x-admin.guard';
import { AGENT_BULK_REBIND_MAX } from './agent-bindings.service';
import { AgentAccountsService } from './agent-accounts.service';
import { AgentAdjustmentService, type AdjustmentStatus } from './agent-adjustment.service';
import { AgentBindingsService } from './agent-bindings.service';
import { AgentReconcileService } from './agent-reconcile.service';
import { AgentSettingsService, type AgentSettings } from './agent-settings.service';
import {
  AgentSettlementService,
  type SettlementStatus,
} from './agent-settlement.service';
import { AgentUserClient } from './agent-user.client';
import type { AgentStatus } from './agent.constants';

function pageOf(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Number(query.page ?? 0);
  const pageSize = Number(query.pageSize ?? 20);
  return {
    page: Number.isFinite(page) && page >= 0 ? Math.trunc(page) : 0,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 20,
  };
}

function stringOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError(ErrCode.BAD_PARAM, `${name} 不能为空`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new DomainError(ErrCode.BAD_PARAM, `${name} 必须是字符串`);
  return value;
}

function idOf(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new DomainError(ErrCode.BAD_PARAM, 'id 非法');
  return id;
}

function reasonOf(body: Record<string, unknown>): string {
  const reason = optionalString(body.reason, 'reason');
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'admin';
}

function dateOf(value: unknown, name: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new DomainError(ErrCode.BAD_PARAM, `${name} 必须是 ISO 时间`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new DomainError(ErrCode.BAD_PARAM, `${name} 不是合法时间`);
  return d;
}

/**
 * 管理端代理 API（spec §9）。
 *
 * - 角色矩阵在网关 policy（显式 P 条目，先于 P8）；本控制器只做 `XAdminGuard`
 *   （`X-Admin:1` + 写面 `X-Admin-Actor`）与参数/审计。
 * - 字面路由（tree/settings/bind/unbind/...）声明在 `:id` **之前**（Nest 按声明序匹配）。
 * - 所有写动作带 actor；敏感动作写 audit（service 层）。
 */
@Controller()
@UseGuards(XAdminGuard)
export class AgentAdminController {
  constructor(
    private readonly accounts: AgentAccountsService,
    private readonly bindings: AgentBindingsService,
    private readonly settings: AgentSettingsService,
    private readonly settlements: AgentSettlementService,
    private readonly adjustments: AgentAdjustmentService,
    private readonly users: AgentUserClient,
    private readonly reconcile: AgentReconcileService,
  ) {}

  @Get('admin/agents')
  async listAgents(@Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      const statusRaw = optionalString(query.status, 'status');
      const status =
        statusRaw === undefined || statusRaw === null || statusRaw === ''
          ? undefined
          : (statusRaw as AgentStatus);
      if (status !== undefined && status !== 'active' && status !== 'frozen') {
        throw new DomainError(ErrCode.BAD_PARAM, 'status 必须是 active/frozen');
      }
      const q = optionalString(query.q, 'q');
      return {
        code: ErrCode.OK,
        data: await this.accounts.list({
          status,
          q: q === null ? undefined : q,
          page,
          pageSize,
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents')
  @HttpCode(200)
  async createAgent(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    try {
      const name = stringOf(body.name, 'name');
      const phone = stringOf(body.phone, 'phone');
      const parentId = optionalString(body.parentId, 'parentId');
      const rateBp =
        body.rateBp === undefined
          ? undefined
          : typeof body.rateBp === 'number'
            ? body.rateBp
            : Number(body.rateBp);
      const password = optionalString(body.password, 'password');
      return {
        code: ErrCode.OK,
        data: await this.accounts.create(
          {
            name,
            phone,
            password: typeof password === 'string' ? password : undefined,
            parentId: parentId === undefined ? undefined : parentId,
            rateBp,
            region: optionalString(body.region, 'region'),
            contactName: optionalString(body.contactName, 'contactName'),
            payoutName: optionalString(body.payoutName, 'payoutName'),
            payoutAccount: optionalString(body.payoutAccount, 'payoutAccount'),
            payoutBank: optionalString(body.payoutBank, 'payoutBank'),
          },
          adminActorOf(req),
        ),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agents/tree')
  async tree() {
    try {
      return { code: ErrCode.OK, data: await this.accounts.tree() };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agents/settings')
  async getSettings() {
    try {
      return { code: ErrCode.OK, data: await this.settings.getOrDefault() };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Patch('admin/agents/settings')
  async updateSettings(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    try {
      const patch: Partial<AgentSettings> = {};
      for (const key of [
        'enabled',
        'defaultRateBp',
        'minSettlementYuan',
        'coinPerYuan',
        'quotaHoldDays',
        'quotaAdminAdjustDailyLimitCoins',
        'adjustMaxYuanPerOp',
        'adjustMaxYuanPerDay',
      ] as const) {
        if (body[key] !== undefined) {
          if (key === 'enabled') {
            if (typeof body[key] !== 'boolean') {
              throw new DomainError(ErrCode.BAD_PARAM, 'enabled 必须是 boolean');
            }
            patch.enabled = body[key] as boolean;
          } else {
            const n = Number(body[key]);
            if (!Number.isSafeInteger(n) || n < 0) {
              throw new DomainError(ErrCode.BAD_PARAM, `${key} 必须是非负整数`);
            }
            patch[key] = n;
          }
        }
      }
      return {
        code: ErrCode.OK,
        data: await this.settings.update(patch, adminActorOf(req), reasonOf(body)),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agent-audit')
  async audit(@Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      return { code: ErrCode.OK, data: await this.accounts.auditList(page, pageSize) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agent-reconciliation')
  async reconciliation(@Query() query: Record<string, unknown>) {
    try {
      const to = dateOf(query.to, 'to', new Date());
      const from = dateOf(query.from, 'from', new Date(to.getTime() - 7 * 86_400_000));
      if (from >= to) throw new DomainError(ErrCode.BAD_PARAM, 'from 必须早于 to');
      return { code: ErrCode.OK, data: await this.reconcile.summary(from, to) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/bind')
  @HttpCode(200)
  async bind(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    try {
      const ownerId = stringOf(body.ownerId, 'ownerId');
      const agentId = stringOf(body.agentId, 'agentId');
      const profile = await this.users.profile(ownerId);
      if (profile.phone === null || profile.phone.trim() === '') {
        throw new DomainError(ErrCode.BAD_PARAM, '玩家不存在或没有手机号');
      }
      return {
        code: ErrCode.OK,
        data: await this.bindings.rebind({
          ownerId,
          agentId,
          phone: profile.phone,
          actor: adminActorOf(req),
          reason: reasonOf(body),
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/unbind')
  @HttpCode(200)
  async unbind(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    try {
      await this.bindings.unbind({
        ownerId: stringOf(body.ownerId, 'ownerId'),
        actor: adminActorOf(req),
        reason: reasonOf(body),
      });
      return { code: ErrCode.OK, data: { unbound: true } };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agents/:id')
  async getAgent(@Param('id') id: string) {
    try {
      const row = await this.accounts.get(id);
      if (row === null) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      return { code: ErrCode.OK, data: row };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Patch('admin/agents/:id')
  async updateAgent(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.accounts.update(
          id,
          {
            name: optionalString(body.name, 'name') ?? undefined,
            parentId: optionalString(body.parentId, 'parentId'),
            rateBp:
              body.rateBp === undefined
                ? undefined
                : typeof body.rateBp === 'number'
                  ? body.rateBp
                  : Number(body.rateBp),
            region: optionalString(body.region, 'region'),
            contactName: optionalString(body.contactName, 'contactName'),
            payoutName: optionalString(body.payoutName, 'payoutName'),
            payoutAccount: optionalString(body.payoutAccount, 'payoutAccount'),
            payoutBank: optionalString(body.payoutBank, 'payoutBank'),
          },
          adminActorOf(req),
          reasonOf(body),
        ),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/:id/status')
  @HttpCode(200)
  async setStatus(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      const status = String(body.status ?? '');
      if (status !== 'active' && status !== 'frozen') {
        throw new DomainError(ErrCode.BAD_PARAM, 'status 必须是 active/frozen');
      }
      return {
        code: ErrCode.OK,
        data: await this.accounts.setStatus(id, status, adminActorOf(req), reasonOf(body)),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/:id/reset-password')
  @HttpCode(200)
  async resetPassword(@Req() req: AdminRequest, @Param('id') id: string) {
    try {
      return { code: ErrCode.OK, data: await this.accounts.resetPassword(id, adminActorOf(req)) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/:id/invite-code/rotate')
  @HttpCode(200)
  async rotateInviteCode(@Req() req: AdminRequest, @Param('id') id: string) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.accounts.rotateInviteCode(id, adminActorOf(req)),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Patch('admin/agents/:id/payout')
  async updatePayout(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.accounts.updatePayout(
          id,
          {
            payoutName: optionalString(body.payoutName, 'payoutName') ?? null,
            payoutAccount: optionalString(body.payoutAccount, 'payoutAccount') ?? null,
            payoutBank: optionalString(body.payoutBank, 'payoutBank') ?? null,
          },
          adminActorOf(req),
          reasonOf(body),
        ),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agents/:id/bindings')
  async listBindings(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      return { code: ErrCode.OK, data: await this.bindings.listByAgent(id, page, pageSize) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/:id/bindings/bulk')
  @HttpCode(200)
  async bulkRebind(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      const toAgentId = stringOf(body.toAgentId, 'toAgentId');
      return {
        code: ErrCode.OK,
        data: await this.bindings.bulkRebind({
          fromAgentId: id,
          toAgentId,
          dryRun: body.dryRun === true,
          actor: adminActorOf(req),
          reason: reasonOf(body),
          limit: AGENT_BULK_REBIND_MAX,
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agents/:id/adjustments')
  @HttpCode(200)
  async createAdjustment(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      const deltaCoins = Number(body.deltaCoins);
      if (!Number.isSafeInteger(deltaCoins)) {
        throw new DomainError(ErrCode.BAD_PARAM, 'deltaCoins 必须是整数');
      }
      return {
        code: ErrCode.OK,
        data: await this.adjustments.create({
          agentId: id,
          deltaCoins,
          reason: stringOf(body.reason, 'reason'),
          requestedBy: adminActorOf(req),
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agent-settlements')
  async listSettlements(@Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      const statusRaw = optionalString(query.status, 'status');
      const status =
        statusRaw === undefined || statusRaw === null || statusRaw === ''
          ? null
          : (statusRaw as SettlementStatus);
      if (
        status !== null &&
        !['pending', 'paid', 'rejected', 'cancelled'].includes(status)
      ) {
        throw new DomainError(ErrCode.BAD_PARAM, 'status 非法');
      }
      return {
        code: ErrCode.OK,
        data: await this.settlements.listQueue(status, page, pageSize),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agent-settlements/:id')
  async settlementDetail(@Param('id') id: string) {
    try {
      const settlement = await this.settlements.getById(idOf(id));
      if (settlement === null) throw new DomainError(ErrCode.BAD_PARAM, '结算单不存在');
      return {
        code: ErrCode.OK,
        data: { settlement, lines: await this.settlements.lines(settlement.agentId, settlement.id) },
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agent-settlements/:id/pay')
  @HttpCode(200)
  async paySettlement(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.settlements.pay({
          id: idOf(id),
          voucherNo: stringOf(body.voucherNo, 'voucherNo'),
          actor: adminActorOf(req),
          reason: optionalString(body.remark, 'remark') ?? undefined,
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agent-settlements/:id/reject')
  @HttpCode(200)
  async rejectSettlement(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.settlements.reject({
          id: idOf(id),
          reason: stringOf(body.reason, 'reason'),
          actor: adminActorOf(req),
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('admin/agent-adjustments')
  async listAdjustments(@Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      const agentId = optionalString(query.agentId, 'agentId');
      const statusRaw = optionalString(query.status, 'status');
      const status =
        statusRaw === undefined || statusRaw === null || statusRaw === ''
          ? undefined
          : (statusRaw as AdjustmentStatus);
      if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
        throw new DomainError(ErrCode.BAD_PARAM, 'status 非法');
      }
      return {
        code: ErrCode.OK,
        data: await this.adjustments.list({
          agentId: agentId === null ? undefined : agentId,
          status,
          page,
          pageSize,
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agent-adjustments/:id/approve')
  @HttpCode(200)
  async approveAdjustment(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.adjustments.approve({
          id: idOf(id),
          approvedBy: adminActorOf(req),
          reason: optionalString(body.reason, 'reason') ?? undefined,
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('admin/agent-adjustments/:id/reject')
  @HttpCode(200)
  async rejectAdjustment(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.adjustments.reject({
          id: idOf(id),
          actor: adminActorOf(req),
          reason: stringOf(body.reason, 'reason'),
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
