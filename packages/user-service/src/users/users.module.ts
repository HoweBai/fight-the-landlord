import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './users.entity';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AdminUsersController } from './admin-users.controller';

@Module({
  // 不再注册 `JwtModule`：本模块已不签发任何令牌（令牌签发归 `AuthModule` /
  // `TokenService`，见 `users.service.ts` 的说明）。
  imports: [TypeOrmModule.forFeature([UserEntity])],
  // `AuthController` 归 `AuthModule`（它只依赖 `AuthService`）。放在这里会让
  // `AuthService` / `TokenService` 被两个模块各实例化一份，且 `AuthModule`
  // 无法在不制造循环依赖的前提下把 `TokenService` 供给本模块。
  //
  // ⚠️ 货币片 T6（规格 §1.2 / US2 的「T6 教训」）：`AdminUsersController`
  // （`GET /api/admin/users/lookup`）**必须**在这里的 `controllers:` 注册 ——
  // 未注册时单测（直接 `new` 控制器）全绿而真容器 **404**（与 `RecordsController` 的
  // 登记同族）。依赖 `UsersRepository` = 本模块自己的 provider（无需 import 别的模块）。
  controllers: [UsersController, AdminUsersController],
  providers: [UsersRepository, UsersService],
  exports: [UsersRepository, UsersService],
})
export class UsersModule {}
