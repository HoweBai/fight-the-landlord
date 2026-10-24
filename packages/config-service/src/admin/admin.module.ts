import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AuditController } from './audit.controller';
import { AdminAccountsService, ADMIN_SCRYPT_PARAMS } from './admin-accounts.service';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AdminChangesService } from './admin-changes.service';
import { LoginEventsService } from './login-events.service';
import { DEFAULT_SCRYPT_PARAMS } from './admin-password';

/**
 * 管理面装配（③ T2 起账号 CRUD；T3 起登录事件 + 首启引导；T4 起审计三读口）。
 *
 * ⚠️ **服务/控制器必须在此注册**（否则单测绿、真容器 404/DI 崩——本仓踩过的坑）；
 * `AdminModule` 被 `AppModule` 与 `ConfigModule` 各导入一次（后者借 `LoginEventsService`
 * 给登录处理器用）——Nest 对**同一模块类**只实例化一次，控制器注册不变式
 * （`container-assembly.gate.test.ts`：一个控制器只能被一个模块注册）不受影响。
 *
 * `DataSource` 由 `TypeOrmModule.forRoot`（`TypeOrmCoreModule`，@Global）提供，不需再导入。
 * scrypt 参数经令牌注入：生产 = `DEFAULT_SCRYPT_PARAMS`；单测可注入小参数（规格 §2.1 口径）。
 * `AdminBootstrapService` 实现 `OnApplicationBootstrap`（容器首启自动跑，§2.13）。
 */
@Module({
  controllers: [AccountsController, AuditController],
  providers: [
    AdminAccountsService,
    AdminChangesService,
    LoginEventsService,
    AdminBootstrapService,
    { provide: ADMIN_SCRYPT_PARAMS, useValue: DEFAULT_SCRYPT_PARAMS },
  ],
  exports: [LoginEventsService],
})
export class AdminModule {}
