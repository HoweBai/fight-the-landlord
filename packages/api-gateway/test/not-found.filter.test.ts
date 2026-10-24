import { AddressInfo } from 'node:net';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { NotFoundEnvelopeFilter } from '../src/http/not-found.filter';

/**
 * N12 / **R244**：网关**自身**的未知路由必须回 §11.1 的信封 `{code,message,data}`。
 *
 * ─── 判据（正反并列，缺一不可）──────────────────────────────────────
 *  ① **未知路由 ⇒ 404 + `{code:10001, message, data:null}`**（修前是 Nest 默认的
 *     `{statusCode,message,error}` —— 那不是契约形状）；
 *  ② **反向**：业务 404（下游 404 + `{code:12001}`，由代理 `res.status().json()` 直接写出）
 *     **一字不改** —— 它压根不经过过滤器（没有异常）；
 *  ③ **反向**：控制器自己抛的**带信封**的 404（`{code:12001}`）也必须原样放行；
 *  ④ **反向**：非 404 状态码的信封（401/403/429/503）一字不改（`slice-07.2-*` 依赖它们）；
 *  ⑤ **`headersSent`**：响应已经写过时不得再写一次（`ERR_HTTP_HEADERS_SENT` 是本次最
 *     容易踩的坑：代理写完 404 后再抛异常）；
 *  ⑥ 探针判别力：`@Catch` 元数据**恰好**只含 `NotFoundException`（不是「顺手多抓几个」）。
 *
 * ⚠️ 用**真 HTTP**（`NestFactory` + `app.listen(0)`）而不是 `supertest` 直接打
 * `app.getHttpServer()`：这条路由的控制器**故意**没有构造依赖，因此起一个最小 app 就够了。
 * （P18/N41 之前这里的理由是「本仓的单测环境里 esbuild 不发 `design:paramtypes`」——
 * 那条**已不再成立**：测试环境现在真的发出该元数据，见 `vitest.config.ts` 的插件。）
 */
@Controller()
class ProbeController {
  @Get('business-404-by-proxy')
  businessByProxy(@Res() res: any) {
    // 与 `ProxyGateway.forward()` 逐字同形：下游 404 的信封**直接写出**（没有异常）
    res.status(404).json({ code: ErrCode.ROOM_NOT_FOUND, message: '房间不存在', data: null });
  }

  @Get('business-404-by-throw')
  businessByThrow(): never {
    throw new NotFoundException({ code: ErrCode.ROOM_NOT_FOUND, message: '房间不存在', data: null });
  }

  @Get('unauthorized')
  unauthorized(@Res() res: any): void {
    res.status(401).json({ code: ErrCode.UNAUTHENTICATED, message: 'unauthenticated', data: null });
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException({ code: ErrCode.FORBIDDEN, message: 'forbidden', data: null });
  }

  @Get('too-many')
  tooMany(@Res() res: any): void {
    res.status(429).json({ code: ErrCode.RATE_LIMITED, message: 'rate limited', data: null });
  }

  @Get('unavailable')
  unavailable(@Res() res: any): void {
    res.status(503).json({ code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'downstream down', data: null });
  }

  /** `headersSent` 的受控复现：先写 404，再抛一个 `NotFoundException`。 */
  @Get('already-sent')
  @HttpCode(200)
  alreadySent(@Res() res: any): never {
    res.status(404).json({ code: ErrCode.ROOM_NOT_FOUND, message: 'first write', data: null });
    throw new NotFoundException('second write must not happen');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('N12/R244：网关未知路由 ⇒ §11.1 信封（只拦 404）', () => {
  let app: INestApplication;
  let baseUrl: string;

  const call = (path: string) => fetch(`${baseUrl}${path}`);

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new NotFoundEnvelopeFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('① 未知路由 → 404 + `{code:10001, message, data:null}`', async () => {
    for (const path of ['/definitely-not-a-route', '/api/nope', '/']) {
      const res = await call(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(await res.json(), path).toEqual({
        code: ErrCode.BAD_PARAM,
        message: expect.any(String),
        data: null,
      });
    }
  });

  it('② 反向：代理直接写出的业务 404（12001）一字不改', async () => {
    const res = await call('/api/business-404-by-proxy');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: ErrCode.ROOM_NOT_FOUND,
      message: '房间不存在',
      data: null,
    });
  });

  it('③ 反向：控制器自己抛的**带信封**的 404 也原样放行（不得改写成 10001）', async () => {
    const res = await call('/api/business-404-by-throw');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: ErrCode.ROOM_NOT_FOUND,
      message: '房间不存在',
      data: null,
    });
  });

  it('④ 反向：401 / 403 / 429 / 503 的信封一字不改', async () => {
    const cases: Array<[string, number, number]> = [
      ['/api/unauthorized', 401, ErrCode.UNAUTHENTICATED],
      ['/api/forbidden', 403, ErrCode.FORBIDDEN],
      ['/api/too-many', 429, ErrCode.RATE_LIMITED],
      ['/api/unavailable', 503, ErrCode.UPSTREAM_UNAVAILABLE],
    ];
    for (const [path, status, code] of cases) {
      const res = await call(path);
      expect({ path, status: res.status }).toEqual({ path, status });
      expect(await res.json(), path).toMatchObject({ code, data: null });
    }
  });

  it('⑤ `headersSent`：已经写过 404 之后再抛 NotFoundException ⇒ 不得再写一次（无 ERR_HTTP_HEADERS_SENT）', async () => {
    const res = await call('/api/already-sent');
    // 关键：第一次写的信封原样保留（若过滤器不检查 headersSent，这里会 500 或连接被毁）
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: ErrCode.ROOM_NOT_FOUND,
      message: 'first write',
      data: null,
    });
  });

  it('⑥ 探针判别力：`@Catch` 元数据**恰好**只含 NotFoundException', () => {
    const caught = (Reflect.getMetadata('__filterCatchExceptions__', NotFoundEnvelopeFilter) ??
      []) as unknown[];
    expect(caught).toEqual([NotFoundException]);
    // 负对照：`ForbiddenException` **不在**名单里（顺手改 403 的信封会打红 slice-07.2-*）
    expect(caught).not.toContain(ForbiddenException);
    expect(caught).not.toContain(NotFoundException.prototype);
  });
});
