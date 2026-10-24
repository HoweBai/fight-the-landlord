import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { createHttpMetricsMiddleware, createRedactingLogger, createTraceMiddleware, startMetricsListener } from '@fight-the-landlord/shared';
import { NotFoundEnvelopeFilter } from './http/not-found.filter';

async function bootstrap() {
  // R92：与四个下游服务**逐字同义**的 fail-closed。网关**自身不校验请求**
  // （它是边缘，客户端必须能到达它 —— R87 不变），但「没配 token ⇒ `headersOf()`
  // 拿不到值 ⇒ **每一跳都不注入** ⇒ 所有下游 401」是**静默**的，
  // 与 R89 的理由（不得把身份边界变成静默可选开关）直接冲突 ⇒ 起不来优于静默全 401。
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
      { service: 'api-gateway' },
    ),
  );

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  // Task 4（R1106）：网关是**边缘** ⇒ `overwriteExisting: true`：**总是生成**新 id、
  // **不采信**客户端传入的 `X-Trace-Id`（否则客户端可以拿别人的 id 污染链路）。
  // 中间件会把这个 id 同时回写到响应头与 `req.headers`（后者供 `headersOf()` 转发下一跳）。
  // ⚠️ 必须排在其他中间件之前：从请求进来（含被拒的）第一刻起就要有上下文。
  app.use(createTraceMiddleware({ overwriteExisting: true }));
  app.use(createHttpMetricsMiddleware());
  // R1109 的**落地**（最终评审 M1）：`X-Trace-Id` 是我们回给客户端的（R1106），但**跨源**
  // 浏览器默认**读不到**非 safelisted 的响应头 ⇒ 不写 `exposedHeaders` 的话，Node 探针 /
  // curl 照样能读到（判据 6 因此**照样绿**），而**用户侧的好处静默不存在** ——
  // 正是本仓最恨的「声称有、实际没有」。
  app.enableCors({ exposedHeaders: ['X-Trace-Id'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  // N12 / R244：**只**把「路由不存在」的 404 渲染成 §11.1 信封（`10001`）。
  // 其余状态码（401/403/429/503）与业务 404（`12001`）的信封**一字不改** ——
  // 后者的成因见 `not-found.filter.ts` 的类注释。
  app.useGlobalFilters(new NotFoundEnvelopeFilter());

  // A6（R138）：`web/index.html`（临时验证页 + 浏览器端规则引擎）已删除（§12.5 / §1.4）。
  // 这里**不再**有任何静态文件服务 —— 特别注意启动期那句 `readFileSync(indexPath)`
  // 也必须一起删：文件没了而代码还在，网关会**启动即崩**。
  //
  // 副作用（R149 实测；M0.1 T2 修复轮按 Nest 11 形态复述，**读数逐项不变**）：`GET /` 与
  // `GET /index.html` 一律 **404** —— `setGlobalPrefix('api')` 把
  // `consumer.apply(JwtMiddleware).forRoutes('{/*splat}')` 收窄成 `/api{/*splat}`
  // （可选组 = 前缀 `/api` **本身** + 其下全部子树；Nest 10 时代同一覆盖由
  // `[prefix + '$', prefix + '/*']` 提供，Express 5 下 `$` 那条已静默失效，见 app.module.ts），
  // 这两条路径**根本不经过中间件**，落到 Nest 的默认 404。关键是**没有任何 HTML**。
  // A6 之前它们返回 200 + 23KB 的 HTML（里面就是完整的浏览器端牌型引擎）。

  const port = parseInt(process.env.PORT ?? '3000');
  startMetricsListener({ port: 9000 });
  await app.listen(port);
  // ⚠️ **明确的例外**（最终评审 M3 / spec §6）：启动横幅（本行）与上面的 fail-closed 报错
  // 仍是**裸 `console`**、**不是** NDJSON —— 后者发生在 `overrideLogger` **之前**、
  // 前者是运维直读的横幅。下一个人不必把它们当成「日志格式坏了」。
  console.log(`API Gateway running on port ${port}`);
}
bootstrap();
