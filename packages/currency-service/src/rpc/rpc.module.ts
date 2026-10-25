import { Module } from '@nestjs/common';
import { CurrencyRpcController } from './currency.rpc.controller';
import { ApplyService } from '../apply/apply.service';
import { GetService } from '../apply/get.service';
import { EntryFeeSkipService } from '../skip/entry-fee-skip.service';
import { CardCounterConsumeService } from '../card-counter/consume.service';
import { AgentModule } from '../agent/agent.module';

/**
 * 货币片的 **RPC 接收面**装配（T4；台费片 T3 起 +`currency.entryFeeSkip`）：
 * `currency.apply`（唯一写边）+ `currency.get`（读）+ `currency.entryFeeSkip`
 * （免单逐笔记账，审计表写 —— 非资金边）。
 *
 * 🔴 `controllers:` 里**必须**列 `CurrencyRpcController`：J21 门禁
 * （`robot-availability-wiring.gate.test.ts`）的第二半就是「承载 `@MessagePattern` 的类被某个
 * `*.module.ts` 注册」—— 只写装饰器不注册，运行时同样是 `NO_MESSAGE_HANDLER`（T6 教训）。
 * 本模块经 `app.module.ts` 的 `imports` 进入容器（**注册链完整**：app → rpc → controller）。
 *
 * ⚠️ **值导入**（不是 `import type`）：DI 需要类的运行期身份（`di-type-import-trap`）。
 * `ApplyService` / `GetService` 的依赖（`DataSource` / `REDIS`）分别由 `TypeOrmModule.forRoot`
 * 与 `@Global` 的 `RedisModule`（均在 `AppModule` 装配）提供。
 *
 * `exports`：T5 的 HTTP 双面（玩家余额读 / 管理调整写）与 T8 的对账循环复用同两个服务 ——
 * 经 `imports: [RpcModule]` 取，不另造服务实例。
 */
@Module({
  imports: [AgentModule],
  controllers: [CurrencyRpcController],
  providers: [ApplyService, GetService, EntryFeeSkipService, CardCounterConsumeService],
  exports: [ApplyService, GetService],
})
export class RpcModule {}
