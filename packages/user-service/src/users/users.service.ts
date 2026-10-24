import { Injectable, NotFoundException } from '@nestjs/common';
import { UsersRepository } from './users.repository';
import { UpdateProfileDto } from './users.dto';

/**
 * 用户资料的读写。
 *
 * ⚠️ 注册 / 登录**不在这里** —— 它们归 `AuthService`（§7.2 的令牌签发在
 * `TokenService` 里）。这里曾有一份 `register` / `login`，用 `jwtService.sign({sub, phone})`
 * 签发**没有 `typ` 也没有 `jti`** 的 7 天令牌：那种令牌既过不了网关的 R24
 * （`typ !== 'access'` → `10005`），也没有白名单项（R26），是纯粹的活雷。
 * 因为它已不被任何路由调用（`AuthController` 走 `AuthService`），已整体删除。
 */
@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  async getMe(userId: string): Promise<{ id: string; phone: string; nickname: string | null; status: string }> {
    const user = await this.repo.findById(userId);
    if (!user) throw new NotFoundException('用户不存在');
    return { id: user.id, phone: user.phone, nickname: user.nickname, status: user.status };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<void> {
    await this.repo.update(userId, {
      ...(dto.nickname !== undefined && { nickname: dto.nickname }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
    });
  }
}
