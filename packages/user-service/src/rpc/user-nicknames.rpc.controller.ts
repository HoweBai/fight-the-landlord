import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type UserNicknamesGetRequest,
  type UserNicknamesGetResponse,
} from '@fight-the-landlord/protocol';
import { UsersRepository } from '../users/users.repository';

/** 单次批量读上限（一间房最多 3 个；留余量给未来复用）。 */
export const USER_NICKNAMES_MAX_BATCH = 50;

/**
 * `user.nicknames.get` 接收侧（昵称片）：批量读昵称，**只读、无写边**。
 *
 * - 非法载荷 / 超上限 ⇒ `{ok:false, BAD_PARAM}`；
 * - 空数组 ⇒ 不查库，直接返回空列表；
 * - 不存在的 userId ⇒ 该条 `nickname: null`（不是漏项）；
 * - 数据库故障 ⇒ `{ok:false, UPSTREAM_UNAVAILABLE}`（与 `record.write` 同口径）。
 *
 * ⚠️ J21 三同提交：本类的 `@MessagePattern` 与 `RPC_PATTERNS.userNicknamesGet`、
 * `app.module.ts` 的 `controllers:` 注册必须同笔落地。
 */
@Controller()
export class UserNicknamesRpcController {
  private readonly logger = new Logger(UserNicknamesRpcController.name);

  constructor(private readonly usersRepo: UsersRepository) {}

  @MessagePattern(RPC_PATTERNS.userNicknamesGet)
  async get(@Payload() dto: UserNicknamesGetRequest): Promise<UserNicknamesGetResponse> {
    if (typeof dto !== 'object' || dto === null || !Array.isArray(dto.userIds)) {
      return { ok: false, code: ErrCode.BAD_PARAM, message: 'userIds 必须是数组' };
    }
    if (dto.userIds.length > USER_NICKNAMES_MAX_BATCH) {
      return {
        ok: false,
        code: ErrCode.BAD_PARAM,
        message: `userIds 最多 ${USER_NICKNAMES_MAX_BATCH} 个`,
      };
    }
    if (dto.userIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      return { ok: false, code: ErrCode.BAD_PARAM, message: 'userIds 的元素必须是非空字符串' };
    }
    if (dto.userIds.length === 0) return { ok: true, data: { nicknames: [] } };

    try {
      const rows = await this.usersRepo.findNicknamesByIds(dto.userIds);
      const byId = new Map(rows.map((row) => [row.id, row.nickname]));
      return {
        ok: true,
        data: {
          nicknames: dto.userIds.map((userId) => ({ userId, nickname: byId.get(userId) ?? null })),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`user.nicknames.get 失败：${message}`);
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }
}
