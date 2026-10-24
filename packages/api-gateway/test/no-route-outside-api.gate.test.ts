import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { toPosixPath } from './helpers/repo-path';
import {
  Controller,
  Get,
  Injectable,
  MiddlewareConsumer,
  Module,
  type NestApplicationOptions,
  type NestMiddleware,
  type NestModule,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { NotFoundEnvelopeFilter } from '../src/http/not-found.filter';

/**
 * N14 / **R245**：`/api` **之外**注册的处理器一律 404 —— 两条判据**并列**，缺一不可。
 *
 * ⚠️ **2026-10-03（M0.1 T2 修复轮）**：Nest 10→11（Express 5）升级后，旧写法
 * `forRoutes('*')` 的 `prefix + '$'` 路径**静默失效**（Express 5 把 `$` 当字面量），
 * 裸 `/api` 一度跳过验签（本闸判据 A′ 正是目击者）；注册形态已迁到
 * `forRoutes('{/*splat}')`（见 `app.module.ts`）。下述读数在 Nest 11.2.7 + Express 5.2.1
 * 上**逐项复测一致**（断言未动）。
 *
 * ─── 这条闸要抓的具体缺陷 ───────────────────────────────────────────
 * `consumer.apply(JwtMiddleware).forRoutes('{/*splat}')` 被 `setGlobalPrefix('api')`
 * **收窄**到 `/api` 一段（展开为 `/api{/*splat}`：可选组 ⇒ 前缀**本身** + 其下全部子树；
 * Nest 10.4.22 时代同一覆盖由 `[prefix + '$', prefix + '/*']` 提供，R149 实测）
 * ⇒ `/api` 之外的路径**根本不经过验签中间件**。今天网关没有任何这类路由，
 * 但这个性质**没有任何东西守着** —— 将来谁写一个 `@Get('/foo')` 就整条绕过验签。
 *
 * ─── 判据 A：行为闸（真 HTTP / 真 Nest 路由）─────────────────────────
 * 非 `/api/` 的路径 ⇒ **404 + §11.1 信封**，且验签中间件**一次都没跑**（`mwCalls === 0`）。
 * 正对照（否则 `mwCalls === 0` 可能只是探针坏了）：`/api/rooms` 匿名 ⇒ **401 + 10002**
 * 且 `mwCalls === 1` —— 中间件**真的**会在 `/api` 下跑。
 *
 * ⚠️ **实测读数**（本文件先跑的探针；2026-09-16 首测于 Nest 10.4.22，2026-10-03 修复轮在
 * Nest 11.2.7 + Express 5.2.1 上**逐项复测一致**）：
 * ```
 * GET /            -> 404 + 10001   mwCalls=0
 * GET /index.html  -> 404 + 10001   mwCalls=0
 * GET /games       -> 404 + 10001   mwCalls=0
 * GET /apix        -> 404 + 10001   mwCalls=0
 * GET //api/rooms  -> 404 + 10001   mwCalls=0
 * GET /api         -> 401 + 10002   mwCalls=1   ← 见下方「执行期裁决」
 * GET /api/rooms   -> 401 + 10002   mwCalls=1
 * GET /api/nope    -> 401 + 10002   mwCalls=1（带凭证时才是 404 + 10001）
 * ```
 * ⇒ **`/api` 本身不在「必须 404」的集合里**：它就是那个前缀，因此它**经过**验签
 * （是 401，带凭证后才是 404）。覆盖它的中间件路径：Nest 10 为 `prefix + '$'`；
 * Nest 11/Express 5 下 `$` 路径已静默失效（当作字面量），由注册形态 `{/*splat}`
 * 展开出的 `/api{/*splat}` 的**裸前缀分支**（可选组缺席 ⇒ 精确匹配 `/api`）恢复同一覆盖。
 * 计划 R245 的路径清单里含 `/api`，与实测不符 —— 见计划文件「执行期裁决 R260」。
 * 关键是**没有任何处理器**落在 `/api` 之外（这一条由判据 B 守）。
 *
 * ─── 判据 B：源码机械闸 ─────────────────────────────────────────────
 * `api-gateway/src/**` 里**不得**出现「显式写了 `/` 开头且不是 `/api`」的注册路径：
 *  - `@Controller()`（空前缀）**合法** —— `setGlobalPrefix('api')` 会补上前缀；
 *  - `@Controller('games')` / `@Get('rooms')`（相对路径）**合法**；
 *  - `@Get('/api/rooms')`（显式 `/api`）**合法**；
 *  - **非法**的只有 `@Get('/foo')` / `@Controller('/games')` 这一种形态。
 */

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const GATEWAY_SRC = join(REPO, 'packages', 'api-gateway', 'src');

/** 非法形态：显式 `/` 开头、且**不是** `/api`（`/api` 后面必须是分隔符或字符串结尾）。 */
const ILLEGAL = /@(?:Controller|Get|Post|Put|Delete|Patch)\(\s*['"`]\/(?!api(?:\/|['"`]))/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

// ───────────────────────────── 判据 A 的探针脚手架 ─────────────────────────────

let mwCalls = 0;

/** 验签中间件的**位置替身**：只负责「跑过就打点」，以及「没打点就不放行」。 */
@Injectable()
class ProbeAuthMiddleware implements NestMiddleware {
  use(req: { headers: Record<string, unknown> }, res: any, next: () => void): void {
    mwCalls += 1;
    if (req.headers['x-test-authed']) {
      next();
      return;
    }
    res.status(401).json({ code: ErrCode.UNAUTHENTICATED, message: 'no token', data: null });
  }
}

@Controller()
class ProbeRoomsController {
  @Get('rooms')
  rooms() {
    return { code: ErrCode.OK, data: [] };
  }
}

@Module({ controllers: [ProbeRoomsController] })
class ProbeModule implements NestModule {
  // 与**生产逐字同形**（`app.module.ts`）：`{/*splat}` 通配（可选组 = 前缀本身 + 其下子树）
  // + 全局前缀 `api`（M0.1 T2 修复轮：原为 Nest 10 时代的 `'*'`）
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ProbeAuthMiddleware).forRoutes('{/*splat}');
  }
}

describe('N14/R245：/api 之外一律 404（行为闸 + 源码机械闸）', () => {
  let app: INestApplication;
  let baseUrl: string;

  const call = (path: string, authed = false) =>
    fetch(`${baseUrl}${path}`, authed ? { headers: { 'x-test-authed': '1' } } : undefined);

  beforeAll(async () => {
    const options: NestApplicationOptions = { logger: false };
    app = await NestFactory.create(ProbeModule, options);
    app.setGlobalPrefix('api'); // 与 main.ts 同形
    app.useGlobalFilters(new NotFoundEnvelopeFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('判据 A：非 /api 路径 ⇒ 404 + §11.1 信封，且验签中间件**一次都没跑**', async () => {
    for (const path of ['/', '/index.html', '/games', '/apix', '//api/rooms']) {
      mwCalls = 0;
      const res = await call(path);
      const body = await res.json();
      expect({ path, status: res.status }, path).toEqual({ path, status: 404 });
      expect(body, path).toEqual({
        code: ErrCode.BAD_PARAM,
        message: expect.any(String),
        data: null,
      });
      // N14 的**实质**：这些路径根本不经过验签中间件 ⇒ 将来若有人在这里注册处理器，
      // 它就是一条**无验签**的通道。这里必须一次都没跑过。
      expect(mwCalls, `${path} 竟然经过了验签中间件`).toBe(0);
    }
  });

  it('判据 A 的正对照：`/api/rooms` 匿名 ⇒ 401 + 10002，且中间件**真的**跑了一次', async () => {
    mwCalls = 0;
    const anonymous = await call('/api/rooms');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: ErrCode.UNAUTHENTICATED, data: null });
    expect(mwCalls, '验签中间件没有在 /api 下跑 —— 上面那条「一次都没跑」是坏探针').toBe(1);

    // 带凭证（替身认这个头）⇒ 命中真实路由；不存在时才是 10001 信封（R244）
    mwCalls = 0;
    const authed = await call('/api/rooms', true);
    expect(authed.status).toBe(200);
    expect(mwCalls).toBe(1);
  });

  it('判据 A′：`/api` **本身**是前缀、不是「非 /api 路径」⇒ 经过验签（401），带凭证后 404', async () => {
    mwCalls = 0;
    const anonymous = await call('/api');
    expect(anonymous.status).toBe(401);
    expect(mwCalls, '`/api` 是 prefix + \'$\' 那条中间件路径，必须经过验签').toBe(1);

    mwCalls = 0;
    const authed = await call('/api', true);
    expect(authed.status).toBe(404); // 没有控制器接住它 ⇒ R244 的信封
    expect(await authed.json()).toMatchObject({ code: ErrCode.BAD_PARAM, data: null });
  });

  it('判据 B：源码机械闸 —— api-gateway/src 里没有「非 /api 的显式路径注册」', () => {
    const offenders: string[] = [];
    for (const file of walk(GATEWAY_SRC)) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          if (ILLEGAL.test(line)) offenders.push(`${toPosixPath(file.slice(REPO.length))}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, `有非 /api 的显式注册：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('判据 B 的正对照：闸**真的**读到了 controller 文件（否则上面那条是空测）', () => {
    const files = walk(GATEWAY_SRC);
    const names = files.map((file) => basename(file));

    // ⚠️ R179：相对路径写错层会**静默扫到主检出的旧源码**（闸恒绿）。因此不但要有
    // 「扫到的文件数」下界，还要点名几个**只可能来自本包 src** 的文件。
    expect(files.length, `walk(${GATEWAY_SRC}) 没扫到源码（相对路径错了？）`).toBeGreaterThanOrEqual(10);
    expect(names).toEqual(
      expect.arrayContaining(['gateway.controller.ts', 'health.controller.ts', 'proxy.gateway.ts', 'main.ts']),
    );

    const withController = files.filter((file) => readFileSync(file, 'utf-8').includes('@Controller'));
    expect(withController.length, '没有任何 @Controller 文件 —— 闸是空测').toBeGreaterThanOrEqual(2);
    expect(withController.map((file) => basename(file)).sort()).toEqual(
      ['gateway.controller.ts', 'health.controller.ts'],
    );
  });

  it('探针判别力：非法形态被命中，三种合法形态不命中', () => {
    expect(ILLEGAL.test("@Get('/foo')"), '显式 / 开头且非 /api').toBe(true);
    expect(ILLEGAL.test("@Controller('/games')")).toBe(true);
    expect(ILLEGAL.test("@Post('/rooms/:code/join')")).toBe(true);
    expect(ILLEGAL.test("@Get('/apix')")).toBe(true); // 前缀相近但不是 /api
    // 合法：空前缀（全局前缀会补 /api）
    expect(ILLEGAL.test('@Controller()')).toBe(false);
    // 合法：相对路径（全局前缀会补 /api）
    expect(ILLEGAL.test("@Get('games')")).toBe(false);
    expect(ILLEGAL.test("@Controller('health')")).toBe(false);
    // 合法：显式 /api
    expect(ILLEGAL.test("@Get('/api/rooms')")).toBe(false);
    expect(ILLEGAL.test("@Get('/api')")).toBe(false);
    // 负对照：不带引号的路径参数写法（装饰器里是变量）不该被误判
    expect(ILLEGAL.test('@Get(ROUTE)')).toBe(false);
  });
});
