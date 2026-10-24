/**
 * `AdminUsersController` 的 HTTP 边界（货币片 T6 / 规格 §2.6 第三行 + ⚙️7；§6.1
 * user-service 行：`X-Admin` fail-closed / 命中 `{userId}` / 未找到 404+11004）。
 *
 * 判据（全列）：
 *  ── lookup（T6）──
 *  - `XAdminGuard` fail-closed：缺 / `'0'` / `'true'` 等任何非 `'1'` 值 ⇒ **401 + 10002**、
 *    **碰不到 handler**（零仓储调用）；
 *  - 命中 ⇒ 200 + `{code:0, data:{userId}}`，且按 query 里的 phone 查仓储；
 *  - 未找到 ⇒ **404 + 11004**（⚙️7）；`phone` 缺失 / 非法（非串 / 太短）⇒ **400 + 10001**
 *    且**零仓储调用**（校验先于任何 IO）。
 *  ── :userId 详情（③ T9 / §2.9）──
 *  - 同样在 `XAdminGuard` 之后：缺 `X-Admin` ⇒ 401 + 10002、零仓储调用；
 *  - 命中 ⇒ 200 + **五字段逐字** `{userId, phone, nickname, status, createdAt}`；
 *    `createdAt` = **epoch ms 整数**（照 `records.service.ts:116-119` 先例）；`nickname`
 *    可 null（原样透传，不吞成 `''`/`undefined`）；
 *  - miss ⇒ **404 + 11004**；`userId` **长度 1..36 之外** ⇒ **400 + 10001** 且零仓储调用
 *    （长度闸先于任何 IO）；**窗口内字符集不预检**（照 `admin-wallet.controller.ts:46-48`
 *    先例——36 字符含 `@` 也照常落库查，miss 即 404，不是 400）。
 *  - ⚠️ `userId.length < 1` 分支在真管线**不可达**（`:userId` 段为空时 Express 路由不匹配
 *    ⇒ 框架级 404，进不了 handler；照 lookup 的「非字符串分支不可达」同款注记）——保留
 *    只为与 `admin-finance.controller.ts:181` 的同款判定逐字对齐。
 *
 * HTTP 侧走**真 Nest 管线**（真 guard、真异常过滤器、真 globalPrefix —— 状态码/信封不是
 * 手写的；形态照 `currency-service/test/helpers/http-probe.ts` 先例，服务依赖就地假装配）。
 * ⚠️ 不挂 `createInternalTokenMiddleware()`：那是服务间边界（网关在每一跳注入），有独立的
 * 栈级判据（`internal-token.test.ts`）；本夹具只覆盖管理查询这一个控制器面。
 * ⚠️ `listen(0)` 在 Windows 上偶发撞「Node fetch 封禁端口」——本仓已知假红族 ⑤
 * （判别法：同一次 run 里同一文件在某阶段绿、另一阶段红 ⇒ 环境假红，不必「重跑直到绿」）。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Module,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AdminUsersController } from '../src/users/admin-users.controller';
import { UsersRepository } from '../src/users/users.repository';
import { REDIS } from '../src/auth/token.service';

@Module({})
class ProbeModule {}

describe('AdminUsersController（T6 / §2.6：GET /api/admin/users/lookup）', () => {
  let app: INestApplication;
  let url: string;
  let findByPhone: ReturnType<typeof vi.fn>;
  let findById: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    findByPhone = vi.fn(async () => null);
    findById = vi.fn(async () => null);
    const module: DynamicModule = {
      module: ProbeModule,
      controllers: [AdminUsersController],
      providers: [
        { provide: UsersRepository, useValue: { findByPhone, findById } },
        { provide: REDIS, useValue: { zscore: vi.fn(async () => null) } },
      ],
    };
    app = await NestFactory.create(module, { logger: false });
    // 与 `src/main.ts` 逐字同形（差异面 = internal-token 中间件 + TCP 微服务，见文件头）。
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  // 用例间互不串扰：清调用记录（保留默认实现返回 null）。
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const get = async (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${url}${path}`, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it('🔴 fail-closed：缺 X-Admin ⇒ 401 + 10002，且**碰不到 handler**（零仓储调用）', async () => {
    const { status, body } = await get('/api/admin/users/lookup?phone=13800000001');

    expect(status).toBe(401);
    expect(body).toEqual({ code: ErrCode.UNAUTHENTICATED, message: 'admin header required', data: null });
    expect(body.code).toBe(10002);
    expect(findByPhone).not.toHaveBeenCalled(); // 不进 handler
  });

  it('fail-closed：任何非 `1` 的 X-Admin（0 / true / 空串）同样 401 —— 只认逐字的 `1`', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
      const { status, body } = await get('/api/admin/users/lookup?phone=13800000001', {
        'x-admin': value,
      });
      expect(status, `x-admin=${JSON.stringify(value)} 不得放行`).toBe(401);
      expect(body.code).toBe(10002);
    }
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('命中 ⇒ 200 + `{code:0, data:{userId}}`，按 query 的 phone 查仓储', async () => {
    findByPhone.mockResolvedValueOnce({ id: 'u-1111' });

    const { status, body } = await get('/api/admin/users/lookup?phone=13800000001', {
      'x-admin': '1',
    });

    expect(status).toBe(200);
    expect(body).toEqual({ code: ErrCode.OK, data: { userId: 'u-1111' } });
    expect(findByPhone).toHaveBeenCalledTimes(1);
    expect(findByPhone).toHaveBeenCalledWith('13800000001');
  });

  it('未找到 ⇒ 404 + 11004（⚙️7：查无此号是正常结果，不是 500/200）', async () => {
    const { status, body } = await get('/api/admin/users/lookup?phone=13900000000', {
      'x-admin': '1',
    });

    expect(status).toBe(404);
    expect(body).toEqual({ code: ErrCode.USER_NOT_FOUND, message: '未找到该手机号', data: null });
    expect(findByPhone).toHaveBeenCalledWith('13900000000');
  });

  it('phone 缺失 ⇒ 400 + 10001 且**零仓储调用**（校验先于任何 IO）', async () => {
    const { status, body } = await get('/api/admin/users/lookup', { 'x-admin': '1' });

    expect(status).toBe(400);
    expect(body.code).toBe(ErrCode.BAD_PARAM);
    expect(body.data).toBeNull();
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('phone 非法（太短 / 非字符串）⇒ 400 + 10001 且零仓储调用', async () => {
    // 太短（< 11：注册面 `@MinLength(11)` 同款口径 —— 查询侧不得比注册侧更严/更松）
    const short = await get('/api/admin/users/lookup?phone=138', { 'x-admin': '1' });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe(ErrCode.BAD_PARAM);

    // 重复 query 参数（**实测钉住的管线行为**）：`ValidationPipe({transform:true})` 对
    // 参数 metatype = String 做 `String(value)` 归一 ⇒ Express 给的数组在这里已变成
    // `'13800000001,13800000002'`，控制器的「非字符串」分支**在真管线里不可达**。
    // 该形态按「一个不存在的手机号」处理（404/11004 —— 与「凡可注册即可查」一致，
    // 注册面本身不禁止逗号字符）。
    const repeated = await get('/api/admin/users/lookup?phone=13800000001&phone=13800000002', {
      'x-admin': '1',
    });
    expect(repeated.status).toBe(404);
    expect(repeated.body.code).toBe(ErrCode.USER_NOT_FOUND);
    expect(findByPhone).toHaveBeenCalledWith('13800000001,13800000002'); // 归一后的串（非数组）

    expect(findByPhone).toHaveBeenCalledTimes(1); // 两次请求里恰一次命中 handler
  });

  describe('③ T9 / §2.9：GET /api/admin/users/:userId', () => {
    it('fail-closed：缺 X-Admin ⇒ 401 + 10002，且碰不到 handler（零仓储调用）', async () => {
      const { status, body } = await get('/api/admin/users/u-0001');

      expect(status).toBe(401);
      expect(body.code).toBe(ErrCode.UNAUTHENTICATED);
      expect(findById).not.toHaveBeenCalled();
    });

    it('命中 ⇒ 200 + 五字段逐字；createdAt = epoch ms 整数', async () => {
      findById.mockResolvedValueOnce({
        id: 'u-7c2a',
        phone: '13800000007',
        nickname: '阿明',
        status: 'active',
        createdAt: new Date('2026-09-30T12:00:00.000Z'),
      });

      const { status, body } = await get('/api/admin/users/u-7c2a', { 'x-admin': '1' });

      expect(status).toBe(200);
      // 逐字五字段（toEqual 钉住：不多不少）；createdAt 是**数字**（epoch ms）而非 ISO 串。
      expect(body).toEqual({
        code: ErrCode.OK,
        data: {
          userId: 'u-7c2a',
          phone: '13800000007',
          nickname: '阿明',
          status: 'active',
          createdAt: 1790769600000, // 2026-09-30T12:00:00.000Z 的 epoch ms（字面钉死）
          online: false,
        },
      });
      expect(findById).toHaveBeenCalledTimes(1);
      expect(findById).toHaveBeenCalledWith('u-7c2a'); // 按 path 的 userId 查仓储
    });

    it('nickname=null ⇒ 原样 null 透传（不吞成空串 / undefined）', async () => {
      findById.mockResolvedValueOnce({
        id: 'u-8d3b',
        phone: '13800000008',
        nickname: null,
        status: 'banned',
        createdAt: new Date('2026-01-05T08:30:00.000Z'),
      });

      const { status, body } = await get('/api/admin/users/u-8d3b', { 'x-admin': '1' });

      expect(status).toBe(200);
      expect(body.data).toEqual({
        userId: 'u-8d3b',
        phone: '13800000008',
        nickname: null,
        status: 'banned',
        createdAt: 1767601800000,
        online: false,
      });
    });

    it('未找到 ⇒ 404 + 11004（查无此人是正常结果，不是 500/200）', async () => {
      const { status, body } = await get('/api/admin/users/no-such-user', { 'x-admin': '1' });

      expect(status).toBe(404);
      expect(body).toEqual({ code: ErrCode.USER_NOT_FOUND, message: '未找到该用户', data: null });
      expect(findById).toHaveBeenCalledWith('no-such-user');
    });

    it('userId 超长（37 字符，字符集全合法）⇒ 400 + 10001 且零仓储调用（长度闸先于 IO）', async () => {
      const tooLong = 'a'.repeat(37);

      const { status, body } = await get(`/api/admin/users/${tooLong}`, { 'x-admin': '1' });

      expect(status).toBe(400);
      expect(body).toEqual({ code: ErrCode.BAD_PARAM, message: 'userId 非法：长度须为 1–36', data: null });
      expect(findById).not.toHaveBeenCalled();
    });

    it('窗口内字符集不预检：36 字符含 @ 也照常落库查（miss ⇒ 404，不是 400）', async () => {
      const oddCharset = `${'x'.repeat(35)}@`; // 恰 36 字符、含字符集外 '@'

      const { status, body } = await get(`/api/admin/users/${oddCharset}`, { 'x-admin': '1' });

      expect(status).toBe(404);
      expect(body.code).toBe(ErrCode.USER_NOT_FOUND);
      expect(findById).toHaveBeenCalledWith(oddCharset); // 原样传给仓储（无归一/无预拒）
    });
  });
});
