import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { XAdminGuard } from '../config/admin.controller';
import {
  AdminAccountsService,
  type AdminAccountView,
  type CreateAccountInput,
  type UpdateAccountInput,
} from './admin-accounts.service';

/**
 * 账号管理 REST（规格 §2.4；判据 C12–C14）——`GET/POST /api/admin/accounts` + `PATCH …/:id`。
 *
 * ⚠️ **与既有 `src/config/admin.controller.ts` 同名异径**（本片新增件一律在 `src/admin/` 下；
 * 那个文件管登录与配置读写）。本文件只管账号——控制器保持薄：校验/事务/三闸/留痕全在
 * `AdminAccountsService`（错误信封与逐字文案只写一份）。
 *
 * 守卫 = 复用 config 侧既有 `XAdminGuard`（fail-closed 只认 `X-Admin: 1`；**授权矩阵不在
 * 服务侧**——角色矩阵在网关单点执行，设计 D2）。`X-Admin-Actor` 由网关注入（T5）；本任务
 * 阶段测试直接注入头值。
 *
 * 本 controller 三端点（GET/POST/PATCH）统一 **200**（`@HttpCode(200)`，管理面先例：POST 的
 * Nest 缺省 201 不用）。
 */

/**
 * 网关注入的操作者头（网关 `identity-headers.ts` 是它的真源；两处各定义一次是本仓既有
 * 惯例——同 `ADMIN_HEADER`，由 T5 的网关测试与 C8/C9 在真拓扑上钉住不漂移）。
 */
export const ADMIN_ACTOR_HEADER = 'x-admin-actor';

@Controller('admin/accounts')
@UseGuards(XAdminGuard)
export class AccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  /** 列表（⚙️10：不分页；`password_hash` 永不出站）。 */
  @Get()
  @HttpCode(200)
  async list(): Promise<{ code: ErrCode; data: { accounts: AdminAccountView[] } }> {
    return { code: ErrCode.OK, data: { accounts: await this.accounts.list() } };
  }

  /** 建号（唯一键冲突 ⇒ 409；同事务落 create 留痕）。 */
  @Post()
  @HttpCode(200)
  async create(
    @Body() body: CreateAccountInput | undefined,
    @Headers(ADMIN_ACTOR_HEADER) actor?: string,
  ) {
    return { code: ErrCode.OK, data: await this.accounts.create(body, actor) };
  }

  /** 更新（任意子集；自锁三闸 + 逐动作留痕，见服务层）。 */
  @Patch(':id')
  @HttpCode(200)
  async patch(
    @Param('id') id: string,
    @Body() body: UpdateAccountInput | undefined,
    @Headers(ADMIN_ACTOR_HEADER) actor?: string,
  ) {
    return { code: ErrCode.OK, data: await this.accounts.update(id, body, actor) };
  }
}
