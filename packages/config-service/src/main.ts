import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
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
  Logger.overrideLogger(
    createRedactingLogger(
      (record) => {
        // R1102：一行一条 NDJSON 到 stdout/stderr（级别只影响走哪一路，**字段里也有 level**）。
        // R1103：sink 是**朴素落点** —— 收到的是**已脱敏**的记录，这里**只** `JSON.stringify`，
        // **不得**再加工/再脱敏/重新组装。
        const line = JSON.stringify(record);
        if (record.level === 'error' || record.level === 'fatal') console.error(line);
        else if (record.level === 'warn') console.warn(line);
        else console.log(line);
      },
      // ⚠️ 必须与 package.json 的 name **去掉 npm scope 后的末段**逐字一致（判据 4 的机械闸从这行源码里抓它）。
      { service: 'config-service' },
    ),
  );

  const app = await NestFactory.create(AppModule);
  // k3s 优雅停机：SIGTERM 时关闭 HTTP/WS/RPC 连接（spec 2026-10-27 D16）
  app.enableShutdownHooks();
  // k3s 迁移 Job 专用：启动迁移跑完即退出，不监听端口。
  if (process.env.DB_MIGRATIONS_ONLY === 'true') {
    await app.close();
    process.exit(0);
  }
  // Task 4（R1106/R1107）：trace 中间件**必须排在最前**（在 `createInternalTokenMiddleware()`
  // 之前）—— 否则更早的中间件（如 401 拒答）打的日志没有 trace 上下文。
  app.use(createTraceMiddleware());
  app.use(createHttpMetricsMiddleware());
  app.use(createInternalTokenMiddleware());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  // 片规格 §2.1（spec A2）：room-service（T6 起）要走 TCP RPC 读配置快照。
  // ⚠️ **RPC 端口只在 compose 内网可达**（`expose`，不是 `ports`）—— 照 game/robot 的处理。
  // ⚠️ 顺序照 `game-service/src/main.ts`（spec A2 口径）：微服务在 `listen()` **之前**
  //    注册并启动（Nest 的 `listen()` 在微服务模式下不会自己启动它们）。
  const rpcPort = parseInt(process.env.RPC_PORT ?? '3106');
  app.connectMicroservice({
    transport: Transport.TCP,
    options: { host: '0.0.0.0', port: rpcPort },
  });

  // E2（§2.3「禁止硬编码端口」）：端口只从 `PORT` 读，默认值才是本服务的端口。
  const port = parseInt(process.env.PORT ?? '3006');
  await app.startAllMicroservices();
  startMetricsListener({ port: 9006 });
  await app.listen(port);
  // 日志必须报**实际**端口：写死字面量的话，容器里 `PORT` 之外的取值会让人以为服务
  // 监听在默认端口而实际不是（排障时最贵的一类假信息）。
  // ⚠️ **明确的例外**（最终评审 M3 / spec §6）：启动横幅（本行）与上面的 fail-closed 报错
  // 仍是**裸 `console`**、**不是** NDJSON —— 后者发生在 `overrideLogger` **之前**、
  // 前者是运维直读的横幅。下一个人不必把它们当成「日志格式坏了」。
  console.log(`Config Service running on port ${port} (RPC ${rpcPort})`);
}
bootstrap();
