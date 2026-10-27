import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import {
  createHttpMetricsMiddleware,
  createRedactingLogger,
  createTraceMiddleware,
  startMetricsListener,
} from '@fight-the-landlord/shared';
import { createInternalTokenMiddleware, DEFAULT_EXEMPT_PATHS } from './http/internal-token.middleware';
import { ALIPAY_NOTIFY_PATH } from './notify/notify.controller';
import { CASHIER_EXEMPT_PREFIX, CASHIER_ROUTE } from './cashier/cashier.controller';

async function bootstrap() {
  // N4/N7（R89）：服务间身份边界的 fail-closed —— 未配置直接退出
  // （照 currency-service main.ts:12-14：「未配置就放行」会把身份边界变成一个**静默可选开关**）。
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
      { service: 'payment-service' },
    ),
  );

  // T8：`rawBody: true` —— 回调防护的**16KB 体积闸**以 `req.rawBody` 字节数为准
  //（Nest 给 json/urlencoded 两个解析器挂 verify 钩子存原始 Buffer；对表单体 = 精确事实，
  //  不依赖可缺失/可伪造的 `content-length`）。其余端点只见增益（原样解析行为不变）。
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // k3s 优雅停机：SIGTERM 时关闭 HTTP/WS/RPC 连接（spec 2026-10-27 D16）
  app.enableShutdownHooks();
  // k3s 迁移 Job 专用：启动迁移跑完即退出，不监听端口。
  if (process.env.DB_MIGRATIONS_ONLY === 'true') {
    await app.close();
    process.exit(0);
  }
  // 顺序照 currency-service：trace 中间件**必须排在最前**（否则更早的中间件打的日志
  // 没有 trace 上下文）→ HTTP 指标 → 内部 token 边界。
  app.use(createTraceMiddleware());
  app.use(createHttpMetricsMiddleware());
  // 🔴 T8：回调公开面的 token 豁免 —— **精确条目**加在调用点，**不动**中间件的
  // `DEFAULT_EXEMPT_PATHS`（默认清单仍只有健康面 ⇒ container-assembly 闸的
  // 「豁免面不得扩大」不变式照旧成立）。理由逐字：`/pay/notify/*` 是 edge 直连的公网面
  // （设计 §2.2 第 3 条），支付宝**拿不到也不该带**内部 token —— 该面由「仅 POST+form /
  // 16KB / 边缘单桶 / 验签」防线自守（规格 §2.7.4，实现在 `notify/`）。
  // 桥接公开面 `/pay/cashier/*` 走**前缀**豁免（玩家浏览器直连，没有也不该带内部 token；
  // 该面由 HMAC 能力 token 自守——见 cashier/cashier.controller.ts）；精确清单语义不变。
  app.use(
    createInternalTokenMiddleware(
      [...DEFAULT_EXEMPT_PATHS, ALIPAY_NOTIFY_PATH],
      [CASHIER_EXEMPT_PREFIX],
    ),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // T8：全局前缀豁免同上口径 —— edge（Caddy `handle /pay/notify/*`）**原样转发**该路径
  //（不带 /api；规格 §2.7.1），豁免以 `ALIPAY_NOTIFY_PATH` 单一常量对钉（notify.test.ts ①）。
  // 桥接页 `CASHIER_ROUTE` 同口径豁免（edge `handle /pay/cashier/*`；`:orderNo` 由
  // path-to-regexp 编译匹配——cashier.test 真 HTTP 管线钉住）。
  app.setGlobalPrefix('api', { exclude: [ALIPAY_NOTIFY_PATH, CASHIER_ROUTE] });

  // ⚙️2：**零被调 RPC 面** —— 本服务**不开 TCP 微服务监听**（不接 `Transport.TCP` 服务端；
  // 源码级判据把「出现微服务接入调用」形态钉死）。
  // 入口三类：网关 HTTP（`/api/pay/*` 与 `/api/admin/pay/*`，T13 接路由）、
  // edge 回调直连（`/pay/notify/*`，**不经网关**、由 T8 的验签防线兜）、
  // edge 桥接页直连（`/pay/cashier/*`，不经网关、由 HMAC token 兜）。出站面 =
  // 渠道 HTTPS + 内网 currency/config 的 TCP RPC（都是**客户端**）。

  // E2（§2.3「禁止硬编码端口」）：端口只从 `PORT` 读，默认值才是本服务的端口。
  const port = parseInt(process.env.PORT ?? '3007');
  // ⚙️2：独立指标监听 **9007**（Bearer 守卫 fail-closed 在 shared 的监听器里：
  // env 未设 ⇒ 一律 401），照 9000–9006 序列空位，**在 `listen()` 之前**启动
  // （顺序照 currency main.ts:60-63）。
  startMetricsListener({ port: 9007 });
  await app.listen(port);
  // 日志必须报**实际**端口（写死字面量的话，容器里 `PORT` 之外的取值会让人以为服务
  // 监听在默认端口而实际不是 —— 排障时最贵的一类假信息）。
  // ⚠️ **明确的例外**（照 currency 最终评审 M3 / spec §6）：启动横幅（本行）与上面的
  // fail-closed 报错仍是**裸 `console`**、**不是** NDJSON —— 后者发生在 `overrideLogger`
  // **之前**、前者是运维直读的横幅。下一个人不必把它们当成「日志格式坏了」。
  console.log(`Payment Service running on port ${port}`);
}
bootstrap();
