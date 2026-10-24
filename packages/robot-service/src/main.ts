import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { createHttpMetricsMiddleware, createRedactingLogger, createTraceMiddleware, startMetricsListener } from '@fight-the-landlord/shared';
import { createInternalTokenMiddleware } from './http/internal-token.middleware';
import { ROBOT_RPC_PORT, robotRpcServerOptions } from './rpc/rpc.options';

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
      { service: 'robot-service' },
    ),
  );

  // ⚠️ 片⑦ E1（design D3）：旧 `getRobotConfig()` 的**启动预检已删除** —— env 解析
  // 退役后没有任何「本地可校验的配置」；配置改由 config-service 提供，且它是**软依赖**
  //（design D2/D8-3）：快照拉不到 ⇒ `ConfigCacheService` 取代码默认值照常就绪
  //（1s 退避重试 + 60s 安全网自愈），**不得**在这条路径上 fail-closed 退出。

  const app = await NestFactory.create(AppModule);
  // Task 4（R1106/R1107）：trace 中间件**必须排在最前**（在 `createInternalTokenMiddleware()`
  // 之前）—— 否则更早的中间件（如 401 拒答）打的日志没有 trace 上下文。
  // 下游用缺省：继承网关传来的 `X-Trace-Id`；直连（无该头，如 conformance 探针）自建一条。
  app.use(createTraceMiddleware());
  app.use(createHttpMetricsMiddleware());
  app.use(createInternalTokenMiddleware());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  /**
   * §4.2 末段逐字（N20/P4 Task 1b）：`robot-service` 必须启动 TCP 微服务监听。
   *
   * ⚠️ 顺序：`connectMicroservice` 在 `listen()` **之前**注册、`startAllMicroservices()`
   * 在 `listen()` **之前**调用（`listen()` 不会自己启动已注册的微服务）——
   * 写反的症状是 HTTP 面正常、3105 **根本没人 listen**。
   *
   * ⚠️ TCP 监听方**不走** HTTP 中间件（R223）：`createInternalTokenMiddleware()` 只保护
   * 剩余的 HTTP 面；RPC 端口只在 compose 内网可达（§2.1「不对外暴露」）。
   */
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: robotRpcServerOptions(),
  });

  const port = parseInt(process.env.PORT ?? '3005');
  await app.startAllMicroservices();
  startMetricsListener({ port: 9005 });
  await app.listen(port);
  // ⚠️ **明确的例外**（最终评审 M3 / spec §6）：启动横幅（本行）与上面的 fail-closed 报错
  // 仍是**裸 `console`**、**不是** NDJSON —— 后者发生在 `overrideLogger` **之前**、
  // 前者是运维直读的横幅。下一个人不必把它们当成「日志格式坏了」。
  console.log(`Robot Service running on port ${port} (RPC ${ROBOT_RPC_PORT})`);
}
bootstrap();
