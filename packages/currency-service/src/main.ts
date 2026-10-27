import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { createHttpMetricsMiddleware, createRedactingLogger, createTraceMiddleware, startMetricsListener } from '@fight-the-landlord/shared';
import { createInternalTokenMiddleware, DEFAULT_EXEMPT_PATHS } from './http/internal-token.middleware';
import { AD_NOTIFY_PATH, AD_NOTIFY_ROUTE } from './ads/ads.controller';

async function bootstrap() {
  // N4/N7：服务间身份边界。fail closed —— 未配置直接退出（R89）：
  // 「未配置就放行」会把身份边界变成一个**静默可选开关**。
  if (!process.env.INTERNAL_SERVICE_TOKEN) {
    console.error('INTERNAL_SERVICE_TOKEN is required (see docs/design.md §5.2 rule 3)');
    process.exit(1);
  }

  // 代理分润（2026-10-26）：生产环境的两个密钥 fail-closed。
  // - `AGENT_PHONE_HMAC_KEY` 缺失 ⇒ 自玩判定会退化成公开兜底 key（不可接受）；
  // - `AGENT_JWT_SECRET` 与 `JWT_SECRET` 都缺失 ⇒ 代理令牌可用仓库公开默认值伪造。
  // dev/test 允许回落（与 admin middleware 的密钥链同族；生产必须显式配置）。
  if (process.env.NODE_ENV === 'production' && !process.env.AGENT_PHONE_HMAC_KEY) {
    console.error('AGENT_PHONE_HMAC_KEY is required in production (agent self-play HMAC)');
    process.exit(1);
  }
  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.AGENT_JWT_SECRET &&
    !process.env.JWT_SECRET
  ) {
    console.error('AGENT_JWT_SECRET or JWT_SECRET is required in production (agent portal JWT)');
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
      { service: 'currency-service' },
    ),
  );

  // 广告片 T11 / **v1.4 T0 回填后保留**：`rawBody: true` —— v1.4 回调已改为 GET（字段走
  // query、无 body，本件不再承载判据）；保留是规格明示——与 pay 同形（其余端点只见增益：
  // 原样解析行为不变）。POST 时代的 16KB 体积闸 / 415 内容类型闸随 GET 化退役（在控制器）。
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
  // 🔴 T11：回调公开面的 token 豁免 —— **精确条目**加在调用点，**不动**中间件的
  // `DEFAULT_EXEMPT_PATHS`（默认清单仍只有健康面 ⇒ 「豁免面不得扩大」不变式照旧成立）。
  // 理由逐字：`/ad/notify/*` 是 edge 直连的公网回调（平台 S2S 投递），渠道**拿不到也
  // 不该带**内部 token —— 该面由「仅 GET / 边缘单桶 / 验签」防线自守（实现在 `ads/`）。
  app.use(createInternalTokenMiddleware([...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // T11：全局前缀豁免（edge 的 `handle /ad/notify/*` **原样转发**、不带 /api——规格 §2.4），
  // 与 `AD_NOTIFY_PATH` 单一常量面同源。
  // 🔴 **勘误①**（实现期实测）：exclude **必须**用 RouteInfo 参数化形态（`AD_NOTIFY_ROUTE`）——
  // Nest 拿**整条路由模式串**（'/ad/notify/:provider'）与 exclude 的 pathToRegexp 正则做 exec，
  // 字面量 '/ad/notify/uniad' 排除不掉 ':provider' 模式 ⇒ 路由落回 `/api/ad/notify/:provider`、
  // 公开路径恒 **404**（原判据「不得 401」会被 404 假通过）。`test/ads.controller.test.ts` ①
  // 有负钉防「简化」复发。
  app.setGlobalPrefix('api', { exclude: [{ path: AD_NOTIFY_ROUTE, method: RequestMethod.ALL }] });

  // 货币片 §2.1：RPC 监听 3104 —— 唯一写边 `currency.apply` 与读边 `currency.get` 的
  // TCP 通道（T1 只起监听、**尚无 handler**；两条接收边在 T4 挂载）。
  // ⚠️ **RPC 端口只在 compose 内网可达**（`expose`，不是 `ports`）—— 照 game/robot/config 的处理。
  // ⚠️ 顺序照 `config-service/src/main.ts`：微服务在 `listen()` **之前**注册并启动
  //    （Nest 的 `listen()` 在微服务模式下不会自己启动它们）。
  // ⚠️ `options` 是**一层** `{host, port}`（R239：嵌错一层 ⇒ 静默回落 3000）；
  //    显式 `<MicroserviceOptions>` 就是让 tsc 守住这个形状。
  const rpcPort = parseInt(process.env.RPC_PORT ?? '3104');
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: { host: '0.0.0.0', port: rpcPort },
  });

  // E2（§2.3「禁止硬编码端口」）：端口只从 `PORT` 读，默认值才是本服务的端口。
  const port = parseInt(process.env.PORT ?? '3004');
  await app.startAllMicroservices();
  // 货币片 §2.1⑤：独立指标监听 9004（与主 HTTP 管线平行、Bearer 守卫见 shared 的监听器），
  // 照 9000–9006 序列空位，**在 `listen()` 之前**启动。
  startMetricsListener({ port: 9004 });
  await app.listen(port);
  // 日志必须报**实际**端口：写死字面量的话，容器里 `PORT` 之外的取值会让人以为服务
  // 监听在默认端口而实际不是（排障时最贵的一类假信息）。
  // ⚠️ **明确的例外**（最终评审 M3 / spec §6）：启动横幅（本行）与上面的 fail-closed 报错
  // 仍是**裸 `console`**、**不是** NDJSON —— 后者发生在 `overrideLogger` **之前**、
  // 前者是运维直读的横幅。下一个人不必把它们当成「日志格式坏了」。
  console.log(`Currency Service running on port ${port} (RPC ${rpcPort})`);
}
bootstrap();
