import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { createHttpMetricsMiddleware, createRedactingLogger, createTraceMiddleware, startMetricsListener } from '@fight-the-landlord/shared';
import { createInternalTokenMiddleware } from './http/internal-token.middleware';

async function bootstrap() {
  // N4/N7：服务间身份边界。fail closed —— 未配置直接退出（R89）：
  // 「未配置就放行」会把身份边界变成一个**静默可选开关**。
  if (!process.env.INTERNAL_SERVICE_TOKEN) {
    console.error('INTERNAL_SERVICE_TOKEN is required (see docs/design.md §5.2 rule 3)');
    process.exit(1);
  }

  // S7（R142）：**所有** Nest 日志经统一脱敏器出站（§5.5）。
  // 必须在 `NestFactory.create` **之前**安装 —— 否则启动早期的日志不脱敏。
  // R148：顺序反过来也**安全**（我们的 logger 实现了 `setLogLevels`，`NestFactory.create`
  // 传 `logger` 数组时无条件调用它；缺了它网关会启动即崩）。
  Logger.overrideLogger(
    createRedactingLogger(
      (record) => {
        // R1102：一行一条 NDJSON 到 stdout/stderr（级别只影响走哪一路，**字段里也有 level**）。
        // R1103（Task 2 的 `emit()` 已保证顺序）：sink 是**朴素落点** —— 收到的是**已脱敏**的
        // 记录，这里**只** `JSON.stringify`，**不得**再加工/再脱敏/重新组装。顺序反了
        // （先序列化再脱敏）会让字符串参数里内嵌的 JSON 因引号被转义而**逃过正则** ⇒ 静默泄敏。
        const line = JSON.stringify(record);
        if (record.level === 'error' || record.level === 'fatal') console.error(line);
        else if (record.level === 'warn') console.warn(line);
        else console.log(line);
      },
      // ⚠️ 必须与 package.json 的 name **去掉 npm scope 后的末段**逐字一致（判据 4 的机械闸从这行源码里抓它）。
      // R1102 的 `service` 取**短名**（规格 §2 记录示例 + 运维可读性）：npm scope 是注册表产物、不是服务身份；
      // 服务改名 ⇒ 短名跟着变 ⇒ 闸照样红（防漂移意图不变）。
      { service: 'room-service' },
    ),
  );

  const app = await NestFactory.create(AppModule);
  // Task 4（R1106/R1107）：trace 中间件**必须排在最前**（在 `createInternalTokenMiddleware()`
  // 之前）—— 否则更早的中间件（如 401 拒答）打的日志没有 trace 上下文。
  // 下游用缺省：继承网关传来的 `X-Trace-Id`；直连（无该头，如 conformance 探针）自建一条。
  app.use(createTraceMiddleware());
  app.use(createHttpMetricsMiddleware());
  app.use(createInternalTokenMiddleware());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  const port = parseInt(process.env.PORT ?? '3002');
  startMetricsListener({ port: 9002 });
  await app.listen(port);
  // ⚠️ **明确的例外**（最终评审 M3 / spec §6）：启动横幅（本行）与上面的 fail-closed 报错
  // 仍是**裸 `console`**、**不是** NDJSON —— 后者发生在 `overrideLogger` **之前**、
  // 前者是运维直读的横幅。下一个人不必把它们当成「日志格式坏了」。
  console.log(`Room Service running on port ${port}`);
}
bootstrap();
