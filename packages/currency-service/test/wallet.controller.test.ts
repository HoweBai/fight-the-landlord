/**
 * T5 玩家 REST（规格 §2.5 / §6.1 http.controller 行）：`GET /api/wallet/balance`。
 *
 * 判据：
 *  - 身份**只**取 `X-User-Id`（缺/空 ⇒ 10002/401；照 `records/mine` 先例）；
 *    **没有**任何「查谁」参数（带 `?userId=` 也无效 —— 结构上不接受查询参数）；
 *  - 经 `GetService` 读路径（缓存优先、miss 回源；`exists=false` ⇒ balance 0）；
 *  - **不建行**（未开户查询前后账户行数不变 —— §2.5 / C3）。
 *
 * HTTP 侧走真 Nest 管线（状态码/信封是真的）——见 `helpers/http-probe.ts`。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { GetService } from '../src/apply/get.service';
import { WalletController } from '../src/wallet/wallet.controller';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';
import { startWalletProbe, type HttpProbe } from './helpers/http-probe';

describe('GET /api/wallet/balance（T5；§2.5）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let probe: HttpProbe;

  beforeAll(async () => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    const get = new GetService(db.dataSource as unknown as DataSource, redis as unknown as Redis);
    probe = await startWalletProbe(get);
  });
  afterAll(async () => {
    await probe.close();
  });

  it('注册面（T6 教训）：`WalletController` 在 `AppModule` 的 controllers 里', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(WalletController);
  });

  it('缺 X-User-Id ⇒ 10002/401（`data:null` 的统一信封）', async () => {
    const res = await probe.get('/api/wallet/balance');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: 'X-User-Id header is required',
      data: null,
    });
  });

  it('空 X-User-Id 视同缺失 ⇒ 10002/401（照 `records/mine` 的 fail-closed 先例）', async () => {
    const res = await probe.get('/api/wallet/balance', { 'x-user-id': '' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrCode.UNAUTHENTICATED);
  });

  it('已开户 ⇒ 200 `{balance}`（读数来自 get 读路径）', async () => {
    db.seedAccount('user-w-1', 'user', 42);

    const res = await probe.get('/api/wallet/balance', { 'x-user-id': 'user-w-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: ErrCode.OK, data: { balance: 42 } });
  });

  it('未开户 ⇒ 200 `{balance:0}` 且**不建行**（前后账户行数不变、无该键）', async () => {
    const before = db.accounts.size;

    const res = await probe.get('/api/wallet/balance', { 'x-user-id': 'user-w-missing' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: ErrCode.OK, data: { balance: 0 } });
    expect(db.accounts.size).toBe(before);
    expect(db.accounts.has('user-w-missing')).toBe(false);
  });

  it('身份只认头：`?userId=<别人>` 被无视（响应仍是自己的余额 —— 结构上无「查谁」参数）', async () => {
    db.seedAccount('user-w-me', 'user', 7);
    db.seedAccount('user-w-victim', 'user', 999);

    const res = await probe.get('/api/wallet/balance?userId=user-w-victim', {
      'x-user-id': 'user-w-me',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: ErrCode.OK, data: { balance: 7 } });
  });

  it('非法 X-User-Id（字符集外）⇒ 400/10001（get 契约校验直透，不静默当 0）', async () => {
    const readsBefore = db.directQueries.length;

    const res = await probe.get('/api/wallet/balance', { 'x-user-id': 'bad id!' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrCode.BAD_PARAM);
    expect(db.directQueries.length).toBe(readsBefore); // 校验先于任何 IO（本用例零直读）
  });
});
