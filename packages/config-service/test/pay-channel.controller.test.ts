import 'reflect-metadata';
import {
  Module,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrCode, PAY_CHANNEL_KEYS } from '@fight-the-landlord/protocol';
import { ADMIN_ACTOR_HEADER } from '../src/admin/admin-accounts.service';
import { ADMIN_HEADER } from '../src/config/admin.controller';
import { PayChannelController } from '../src/pay-channel/pay-channel.controller';
import { PayChannelService } from '../src/pay-channel/pay-channel.service';
import { FakePayChannelDb, type HttpResult } from './helpers/config-probe';

/**
 * 管理三端点契约（规格 §2.4 表**逐字** / §3.1 写路径序 / §3.5 + S-3 / ⚙️18；T5）。
 *
 * 判据（五组）：
 *  1. guard fail-closed：三端点无 `X-Admin: 1` ⇒ 401（拦在 handler 之前）；
 *  2. **401 先于一切（§3.1 序①）**：PUT/DELETE 的 `requireActor` 缺失/非法 ⇒ 401「管理身份缺失」
 *     ——配「未知键 / 非字符串 value」时观测到的仍是 401（序的判别性在案），且库零调用；
 *  3. **400（§2.4）**：未知键 ⇒「未知键」；非字符串 value（数字/null/缺省/对象）⇒「值必须是
 *     字符串」（W1-4 防御分支）；校验不过 ⇒ message = 校验理由且**不含输入值**（标记串自证）；
 *  4. **200 形状逐字**：GET 六项 ⚙️1 序 + 八字段（secret 键 `value` 恒 null）；PUT 回
 *     `{saved:true, fingerprint, updatedAt}`；DELETE 恒 `{saved:true}`（existent/absent 幂等）；
 *  5. **503（§3.5/⚙️18，fresh 模块图）**：主钥缺 ⇒ GET/PUT/DELETE **三者同拒**；PUT 用**合法值**
 *     （S-3 附注：400 先于 503，非法值观测不到 503）且库零调用。
 *
 * HTTP 侧走**真 Nest 管线**（guard / 异常过滤器 / 状态码 / globalPrefix 都是真的）。夹具组装照
 * `admin.controller.test.ts` + helpers 的 `startHttpProbe` 形态，差异两点：
 *  - 本文件的 `startPayChannelProbe` 装载 `PayChannelController`（共享探针只装管理配置族）
 *    且请求面含 **DELETE**（共享探针缺它——就地补齐，**未动** `helpers/config-probe.ts`）；
 *  - 503 组把 controller 与 service **成对**换成 `vi.resetModules()` 后动态 import 的**同一张
 *    fresh 图**（进程内主钥缓存使既有图上「未设主钥」不可达，同 service 单测口径）——图必须成对：
 *    controller 的 `instanceof PayChannel*Error` 用自己图里的错误类，混图会把 503 漏成 500。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')（同 service 单测）。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

/** 管理读写的常用头（写面必带 actor——T7 网关上线后由网关注入；本阶段测试直接注入头值）。 */
const AUTH = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'admin' };

/** 密钥素材 = 用例内现生成（RSA-2048；校验器要 `createPrivateKey` 可解析，同 service 单测）。 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
/** canonical 形态（base64(PEM)）——「不得出现在响应里的第二形态」断言用。 */
const PRIVATE_CANONICAL_B64 = Buffer.from(PRIVATE_PEM.trim() + '\n', 'utf8').toString('base64');

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/* ------------------------------------------------------------------ *
 * 探针（真 Nest 管线；形态照 helpers 的 startHttpProbe，见文件头）
 * ------------------------------------------------------------------ */

@Module({})
class PayChannelProbeModule {}

interface ChannelProbe {
  get: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  putJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  del: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  close: () => Promise<void>;
}

/**
 * `controller`/`serviceToken` 作参数传入而非写死：503 组要换成 fresh 图里的**同一对**类
 * （serviceToken 必须 === controller 的 `design:paramtypes` 引用的那个类对象，DI 才解析得到）。
 */
async function startPayChannelProbe(opts: {
  controller: Type<unknown>;
  serviceToken: Type<unknown>;
  serviceInstance: unknown;
}): Promise<ChannelProbe> {
  const probeModule: DynamicModule = {
    module: PayChannelProbeModule,
    controllers: [opts.controller],
    providers: [{ provide: opts.serviceToken, useValue: opts.serviceInstance }],
  };
  const app: INestApplication = await NestFactory.create(probeModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const request = async (
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };

  return {
    get: (path, headers) => request('GET', path, undefined, headers),
    putJson: (path, body, headers) => request('PUT', path, body, headers),
    del: (path, headers) => request('DELETE', path, undefined, headers),
    close: () => app.close(),
  };
}

interface Harness {
  probe: ChannelProbe;
  db: FakePayChannelDb;
}

/** 静态图夹具：静态 controller + 静态 service（200/400/401 组用；503 组不走这里）。 */
async function makeHarness(): Promise<Harness> {
  const db = new FakePayChannelDb();
  const probe = await startPayChannelProbe({
    controller: PayChannelController,
    serviceToken: PayChannelService,
    serviceInstance: new PayChannelService(db.dataSource as unknown as DataSource),
  });
  return { probe, db };
}

/* ------------------------------------------------------------------ *
 * 1：guard fail-closed（真 guard）
 * ------------------------------------------------------------------ */

describe('X-Admin fail-closed（真 guard；三端点同门）', () => {
  let probe: ChannelProbe;
  let db: FakePayChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('无 X-Admin：GET/PUT/DELETE 一律 401（拦在 handler 之前），库零调用', async () => {
    const get = await probe.get('/api/admin/pay-channel');
    expect(get.status).toBe(401);
    expect(get.body.code).toBe(ErrCode.UNAUTHENTICATED);
    expect(get.body.data).toBeNull();

    const put = await probe.putJson('/api/admin/pay-channel/pay.channel.gatewayUrl', {
      value: 'https://localhost:8443',
    });
    expect(put.status).toBe(401);
    expect(put.body.message).toBe('admin header required'); // guard 文案（不是 handler 的）

    const del = await probe.del('/api/admin/pay-channel/pay.channel.gatewayUrl');
    expect(del.status).toBe(401);

    expect(db.queries).toHaveLength(0); // 三请求全被拦在 handler 之外
  });

  it('X-Admin: 1 ⇒ 放行（GET 200——判别力：401 不是「恒红」）；GET 不要求 actor 头（§2.4 仅 PUT/DELETE 列 401）', async () => {
    const res = await probe.get('/api/admin/pay-channel', { [ADMIN_HEADER]: '1' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);
  });
});

/* ------------------------------------------------------------------ *
 * 2：401（§3.1 序①——requireActor 先于一切）
 * ------------------------------------------------------------------ */

describe('写面 401（§3.1 序①：requireActor 先于一切）', () => {
  let probe: ChannelProbe;
  let db: FakePayChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('PUT actor 头缺失 ⇒ 401「管理身份缺失」（不是 400/503），库零调用', async () => {
    const res = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      { value: 'https://localhost:8443' },
      { [ADMIN_HEADER]: '1' },
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: '管理身份缺失',
      data: null,
    });
  });

  it('PUT actor 非法（用户名正则不过）⇒ 401；DELETE 同规', async () => {
    const invalid = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      { value: 'https://localhost:8443' },
      { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'Has Space' },
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body.message).toBe('管理身份缺失');

    const del = await probe.del('/api/admin/pay-channel/pay.channel.gatewayUrl', {
      [ADMIN_HEADER]: '1',
    });
    expect(del.status).toBe(401);
    expect(del.body.message).toBe('管理身份缺失');
  });

  it('序①判别：未知键 + 缺 actor ⇒ 401（而非「未知键」400）；非字符串 value + 缺 actor ⇒ 401', async () => {
    const unknownKey = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.nope',
      { value: 'https://localhost:8443' },
      { [ADMIN_HEADER]: '1' },
    );
    expect(unknownKey.status).toBe(401);
    expect(unknownKey.body.message).toBe('管理身份缺失');

    const badValue = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      { value: 123 },
      { [ADMIN_HEADER]: '1' },
    );
    expect(badValue.status).toBe(401);
    expect(badValue.body.message).toBe('管理身份缺失');

    expect(db.queries).toHaveLength(0); // 本组全 401 ⇒ 连形状校验都没发生
  });
});

/* ------------------------------------------------------------------ *
 * 3：400（未知键 / 非字符串 value / 校验不过；message 不含值）
 * ------------------------------------------------------------------ */

describe('400（§2.4：未知键 / 非字符串 value / 校验不过；message 均不含值）', () => {
  let probe: ChannelProbe;
  let db: FakePayChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('未知键 ⇒ 400「未知键」（PUT/DELETE 同规；不是 500、库零调用）', async () => {
    const put = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.nope',
      { value: 'https://localhost:8443' },
      AUTH,
    );
    expect(put.status).toBe(400);
    expect(put.body).toEqual({ code: ErrCode.BAD_PARAM, message: '未知键', data: null });

    const del = await probe.del('/api/admin/pay-channel/pay.channel.nope', AUTH);
    expect(del.status).toBe(400);
    expect(del.body.message).toBe('未知键');

    expect(db.queries).toHaveLength(0);
  });

  it('非字符串 value（数字 / null / 缺省 / 数组 / 对象）⇒ 400「值必须是字符串」；对象内标记串不漏进 message（W1-4）', async () => {
    for (const body of [{ value: 123 }, { value: null }, {}, { value: ['x'] }]) {
      const res = await probe.putJson(
        '/api/admin/pay-channel/pay.channel.gatewayUrl',
        body,
        AUTH,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.message).toBe('值必须是字符串');
    }

    const marker = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.privateKey',
      { value: { pem: 'ZZMARKERZZ' } },
      AUTH,
    );
    expect(marker.status).toBe(400);
    expect(marker.body.message).toBe('值必须是字符串');
    expect(marker.body.message).not.toContain('ZZMARKERZZ');

    expect(db.queries).toHaveLength(0); // 形状防御先于一切库操作
  });

  it('value 整缺（无 body）⇒ 400「值必须是字符串」', async () => {
    const res = await probe.putJson('/api/admin/pay-channel/pay.channel.appId', undefined, AUTH);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('值必须是字符串');
    expect(db.queries).toHaveLength(0);
  });

  it('校验不过 ⇒ 400 message = 校验理由，且不含输入值（标记串自证；库零调用——C5「400 了却先落库」不可能）', async () => {
    const badUrl = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      { value: 'not-a-url-ZZMARKERZZ' },
      AUTH,
    );
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.code).toBe(ErrCode.BAD_PARAM);
    expect(badUrl.body.message).toBe('必须是 http/https 协议的合法 URL');
    expect(badUrl.body.message).not.toContain('ZZMARKERZZ');

    const empty = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.sellerId',
      { value: '   ' },
      AUTH,
    );
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('值不得为空');

    const badPid = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.appId',
      { value: 'nope' },
      AUTH,
    );
    expect(badPid.status).toBe(400);
    expect(badPid.body.message).toBe('必须是 8-32 位数字');

    expect(db.queries).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4：200（§2.4 三端点成功形状逐字）
 * ------------------------------------------------------------------ */

describe('200（§2.4 三端点成功形状逐字）', () => {
  let probe: ChannelProbe;
  let db: FakePayChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('GET 空库 ⇒ 六项按 ⚙️1 序、八字段逐字、全 configured:false（每字段 null）', async () => {
    const res = await probe.get('/api/admin/pay-channel', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);

    const keys = res.body.data.keys as Array<Record<string, unknown>>;
    expect(keys.map((k) => k.key)).toEqual([...PAY_CHANNEL_KEYS]);
    expect(keys.map((k) => k.label)).toEqual([
      '渠道网关地址',
      '应用 APPID',
      '应用私钥',
      '支付宝公钥',
      '商户 PID',
      '对外站点基址',
    ]);
    expect(keys.map((k) => k.secret)).toEqual([false, false, true, false, false, false]);
    for (const item of keys) {
      expect(Object.keys(item).sort()).toEqual(
        ['configured', 'fingerprint', 'key', 'label', 'secret', 'updatedAt', 'updatedBy', 'value'],
      );
      expect(item.configured).toBe(false);
      expect(item.value).toBeNull();
      expect(item.fingerprint).toBeNull();
      expect(item.updatedAt).toBeNull();
      expect(item.updatedBy).toBeNull();
    }
  });

  it('PUT 非密键 ⇒ `{saved:true, fingerprint, updatedAt}`；canonical（去尾斜杠）与指纹经 GET 回读一致；落库为密文', async () => {
    const put = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      { value: 'https://localhost:8443/' }, // 尾斜杠 ⇒ canonical 剥离（§2.3）
      AUTH,
    );
    expect(put.status).toBe(200);
    expect(put.body.code).toBe(ErrCode.OK);
    expect(Object.keys(put.body.data).sort()).toEqual(['fingerprint', 'saved', 'updatedAt']);
    expect(put.body.data.saved).toBe(true);
    expect(put.body.data.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(put.body.data.updatedAt).toBeTypeOf('number');

    const get = await probe.get('/api/admin/pay-channel', AUTH);
    const gw = (get.body.data.keys as Array<Record<string, unknown>>).find(
      (k) => k.key === 'pay.channel.gatewayUrl',
    )!;
    expect(gw.configured).toBe(true);
    expect(gw.value).toBe('https://localhost:8443'); // canonical = 去尾斜杠后的原文
    expect(gw.fingerprint).toBe(put.body.data.fingerprint);
    expect(gw.updatedAt).toBeTypeOf('number');
    expect(gw.updatedBy).toBe('admin'); // = actor 头值

    // at-rest 底样：落库是 `v1:` 密文、不是明文（完整 at-rest 链在 slice-22 ⑥）
    const stored = db.rows.get('pay.channel.gatewayUrl')!;
    expect(stored.value_enc.startsWith('v1:')).toBe(true);
    expect(stored.value_enc).not.toContain('localhost');
  });

  it('PUT 密键（privateKey PEM 原文）⇒ GET 该项 value 恒 null、只给指纹；响应整串无 PEM/base64 片段（掩码写）', async () => {
    const put = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.privateKey',
      { value: PRIVATE_PEM },
      AUTH,
    );
    expect(put.status).toBe(200);
    expect(put.body.data.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const get = await probe.get('/api/admin/pay-channel', AUTH);
    const pk = (get.body.data.keys as Array<Record<string, unknown>>).find(
      (k) => k.key === 'pay.channel.privateKey',
    )!;
    expect(pk.configured).toBe(true);
    expect(pk.secret).toBe(true);
    expect(pk.value).toBeNull(); // 🔴 私钥任何角色读不回原文（D4/§2.4）
    expect(pk.fingerprint).toBe(put.body.data.fingerprint);
    expect(pk.updatedBy).toBe('admin');

    const bodyText = JSON.stringify(get.body);
    expect(bodyText).not.toContain('-----BEGIN'); // PEM 原文形态
    expect(bodyText).not.toContain(PRIVATE_CANONICAL_B64.slice(40, 100)); // base64(PEM) 形态
  });

  it('DELETE 存在 ⇒ 200 `{saved:true}` + 行删除；再 DELETE（absent）⇒ 仍 200 `{saved:true}`（幂等）', async () => {
    const put = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.sellerId',
      { value: '2088721087500000' },
      AUTH,
    );
    expect(put.status).toBe(200);
    expect(db.rows.has('pay.channel.sellerId')).toBe(true);

    const del1 = await probe.del('/api/admin/pay-channel/pay.channel.sellerId', AUTH);
    expect(del1.status).toBe(200);
    expect(del1.body).toEqual({ code: ErrCode.OK, data: { saved: true } });
    expect(db.rows.has('pay.channel.sellerId')).toBe(false);

    const del2 = await probe.del('/api/admin/pay-channel/pay.channel.sellerId', AUTH); // 行已不存在
    expect(del2.status).toBe(200);
    expect(del2.body).toEqual({ code: ErrCode.OK, data: { saved: true } });

    const get = await probe.get('/api/admin/pay-channel', AUTH);
    const item = (get.body.data.keys as Array<Record<string, unknown>>).find(
      (k) => k.key === 'pay.channel.sellerId',
    )!;
    expect(item.configured).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5：503 主钥缺 fail-closed（§3.5/⚙️18；fresh 模块图）
 * ------------------------------------------------------------------ */

describe('503 主钥缺 fail-closed（§3.5/⚙️18；GET/PUT/DELETE 三者同拒）', () => {
  let probe: ChannelProbe;
  let db: FakePayChannelDb;

  beforeAll(async () => {
    // fresh 图（crypto 无主钥缓存）：env 置空（空串 = 未设，⚙️5）⇒ 于模块求值后首调即「未设」。
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = '';
    const serviceModule = await import('../src/pay-channel/pay-channel.service');
    const controllerModule = await import('../src/pay-channel/pay-channel.controller');
    db = new FakePayChannelDb();
    probe = await startPayChannelProbe({
      controller: controllerModule.PayChannelController,
      serviceToken: serviceModule.PayChannelService,
      serviceInstance: new serviceModule.PayChannelService(db.dataSource as unknown as DataSource),
    });
  });
  afterAll(async () => {
    await probe.close();
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64; // 复位（顶层 afterAll 另有原值还原）
  });

  it('GET（空库亦拒——不给「看起来正常」的中间态）⇒ 503 ⚙️18 逐字', async () => {
    const res = await probe.get('/api/admin/pay-channel', AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '渠道密钥存储未启用（缺主钥）',
      data: null,
    });
  });

  it('PUT 用**合法值**（S-3：400 先于 503，非法值观测不到 503）⇒ 503；库零调用', async () => {
    const res = await probe.putJson(
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      { value: 'https://localhost:8443' }, // 合法：过校验后才轮到主钥检查（§3.1 序）
      AUTH,
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(res.body.message).toBe('渠道密钥存储未启用（缺主钥）');
    expect(db.queries).toHaveLength(0); // 主钥检查先于事务：库一次都没被碰
  });

  it('DELETE ⇒ 503（写面同拒）；库零调用', async () => {
    const res = await probe.del('/api/admin/pay-channel/pay.channel.gatewayUrl', AUTH);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(res.body.message).toBe('渠道密钥存储未启用（缺主钥）');
    expect(db.queries).toHaveLength(0);
  });
});
