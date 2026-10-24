// packages/user-service/src/users/admin-users.controller.ts
import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { XAdminGuard } from '../http/x-admin.guard';
import { httpException } from '../http/errors';
import { UsersRepository } from './users.repository';
import { ONLINE_TTL_MS, ONLINE_USERS_KEY } from '@fight-the-landlord/shared';
import type { Redis } from 'ioredis';
import { REDIS } from '../auth/token.service';

/**
 * 管理面用户查询（`@Controller('admin/users')`）。
 *
 * ── `lookup`（货币片 T6 / 规格 §2.6 第三行 + ⚙️7；设计 §4.2 第三行）────────────
 *
 * 手机号 → `{ userId }`。运营按手机号操作（手动发放的可用性前置），**不背 uuid** ——
 * 管理页「钱包调整」的第一步就是这个端点（§2.14 ①）。
 *
 * - 守卫 = `XAdminGuard`（复制件，fail-closed）：未带 `X-Admin: 1`（网关验完管理令牌后
 *   注入）⇒ 401 + 10002，**不进 handler**；
 * - 成功 ⇒ `{ code: 0, data: { userId } }`；
 * - 未找到 ⇒ **404 + 11004**（⚙️7）；`phone` 缺失/非法 ⇒ **400 + 10001**（⚙️7）。
 *
 * ── `:userId` 详情（③ 财务后台 T9 / 规格 §2.9）────────────────────────────────
 *
 * `userId` → `{ userId, phone, nickname, status, createdAt(epoch ms) }`。
 *
 * ⚠️ **注册面**（T6 教训）：本控制器必须在 `users.module.ts` 的 `controllers:` 里注册
 * —— 未注册时单测（直接 `new` 控制器）全绿而真容器**404**（与 `RecordsController` 的
 * 登记同族；`container-assembly.gate.test.ts` 的「一控制器只被一个模块注册」也扫这里）。
 * ⚠️ **声明顺序**：`lookup` 必须先于 `:userId` 声明（Express 注册顺序即匹配顺序；
 * 反了 `lookup` 会被 `:userId` 吃掉；网关侧 `admin/users/lookup` 同款注记）。
 */
@Controller('admin/users')
@UseGuards(XAdminGuard)
export class AdminUsersController {
  constructor(
    private readonly usersRepo: UsersRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 手机号查询用户 id。
   *
   * 合法性口径 = **注册面同款**（`RegisterDto` 的 `@MinLength(11)`，`users.phone` 列宽
   * varchar(20)）：凡可注册的手机号都可查 —— 查询侧**不得**比注册侧更严，否则会造出
   * 「查不到的已注册用户」。不做字符集校验（注册面也没有——保持一致）。
   */
  @Get('lookup')
  async lookup(@Query('phone') phone?: string) {
    if (typeof phone !== 'string' || phone.length < 11) {
      throw httpException(ErrCode.BAD_PARAM, 'phone 缺失或格式非法（至少 11 字符）');
    }
    const user = await this.usersRepo.findByPhone(phone);
    if (!user) throw httpException(ErrCode.USER_NOT_FOUND, '未找到该手机号');
    return { code: ErrCode.OK, data: { userId: user.id } };
  }

  /**
   * 用户详情（③ T9 / 规格 §2.9）：`{userId, phone, nickname, status, createdAt}`。
   *
   * - `userId` **长度 1..36** 之外 ⇒ **400 + 10001**；**窗口内不做字符集预检**——任何串
   *   都只是「查这个 id」，预检只会发明规格没有的错误面（照 `admin-wallet.controller.ts`
   *   `accounts/:userId` 的注释先例）。⚠️ `length < 1` 分支真管线不可达（空段不匹配
   *   `:userId`），保留只为与 `admin-finance.controller.ts:181` 同款判定对齐；
   * - miss ⇒ **404 + 11004**（既有 USER_NOT_FOUND，与 lookup 同码）；
   * - `createdAt` = **epoch ms 整数**（⚙️1；helper 照 `records.service.ts` 的 `toEpochMs`
   *   先例复制——驱动回值型别容错）；`nickname` 可 null，原样透传；
   * - **读端点不强求 actor 头**（规格 §2.7 尾句裁定）：守卫只管 `X-Admin: '1'`。
   */
  @Get(':userId')
  async detail(@Param('userId') userId: string) {
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 36) {
      throw httpException(ErrCode.BAD_PARAM, 'userId 非法：长度须为 1–36');
    }
    const user = await this.usersRepo.findById(userId);
    if (!user) throw httpException(ErrCode.USER_NOT_FOUND, '未找到该用户');
    return {
      code: ErrCode.OK,
      data: {
        userId: user.id,
        phone: user.phone,
        nickname: user.nickname,
        status: user.status,
        createdAt: toEpochMs(user.createdAt),
        online: await onlineOf(this.redis, user.id),
      },
    };
  }
}

/**
 * `created_at` 的驱动回值型别 ⇒ epoch ms 整数（`Date` / ms 数 / 可解析串三形态）。
 * 逐字照 `records.service.ts:115-120` 先例；按本仓惯例（currency-service 两处私有）就地
 * 复制三行，不做跨文件抽公共件。
 */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(String(value)).getTime();
}


/** 在线判定（presence ZSET；Redis 失败降级 false，详情不得 500）。 */
async function onlineOf(redis: Redis, userId: string): Promise<boolean> {
  try {
    const score = await redis.zscore(ONLINE_USERS_KEY, userId);
    return score !== null && Number(score) > Date.now() - ONLINE_TTL_MS;
  } catch {
    return false;
  }
}
