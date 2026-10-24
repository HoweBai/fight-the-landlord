import 'reflect-metadata';
import {
  Module,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrCode, AD_CHANNEL_KEYS } from '@fight-the-landlord/protocol';
import { ADMIN_ACTOR_HEADER } from '../src/admin/admin-accounts.service';
import { ADMIN_HEADER } from '../src/config/admin.controller';
import { AdChannelController } from '../src/ad-channel/ad-channel.controller';
import { AdChannelService } from '../src/ad-channel/ad-channel.service';
import { type HttpResult, FakeAdChannelDb } from './helpers/config-probe';

/**
 * 管理三端点契约（广告规格 §2.3 克隆先例：`pay-channel.controller.ts:55-130` 形态**逐字**——
 * `@Controller('admin')` + 三端点路径 `admin/ad-channel`（**GET 无后缀**）；错误序照抄；T6）。
 *
 * 判据（五组）：
 *  1. guard fail-closed：三端点无 `X-Admin: 1` ⇒ 401（拦在 handler 之前）；
 *  2. **401 先于一切**：PUT/DELETE 的 `requireActor` 缺失/非法 ⇒ 401「管理身份缺失」
 *     ——配「未知键 / 非字符串 value」时观测到的仍是 401（序的判别性在案），且库零调用；
 *  3. **400**：未知键 ⇒「未知键」；非字符串 value（数字/null/缺省/对象）⇒「值必须是
 *     字符串」；校验不过 ⇒ message = 校验理由且**不含输入值**（标记串自证）；
 *  4. **200 形状逐字**：GET 单项（⚙️1 序 + 八字段、secret 键 `value` 恒 null）；PUT 回
 *     `{saved:true, fingerprint, updatedAt}`；DELETE 恒 `{saved:true}`（existent/absent 幂等）；
 *  5. **503（fresh 模块图）**：主钥缺 ⇒ GET/PUT/DELETE **三者同拒**；PUT 用**合法值**
 *     （400 先于 503，非法值观测不到 503——本组另加**逆判别**：非法值仍 400）且库零调用。
 *
 * **错误序专测（401→400→503 判别性）**：组 2 钉「401 先于 400」（未知键/坏形态配缺 actor
 * ⇒ 401）；组 5 钉「400 先于 503」（主钥缺时，非法值 ⇒ 400、合法值 ⇒ 503——同一 503 夹具
 * 下两观测面互斥可判）。组 3 钉「400 先于库操作」。
 *
 * HTTP 侧走**真 Nest 管线**（guard / 异常过滤器 / 状态码 / globalPrefix 都是真的）。夹具组装照
 * `pay-channel.controller.test.ts` 的 `startPayChannelProbe` 形态，差异两点：
 *  - 本文件的 `startAdChannelProbe` 装载 `AdChannelController`（共享探针只装管理配置族）
 *    且请求面含 **DELETE**（共享探针缺它——就地补齐，**未动**其探针接线；`helpers/config-probe.ts`
 *    在 T7 另有假库并轨改动，与本处取舍无涉）；
 *  - 503 组把 controller 与 service **成对**换成 `vi.resetModules()` 后动态 import 的**同一张
 *    fresh 图**（进程内主钥缓存使既有图上「未设主钥」不可达，同 service 单测口径）——图必须成对：
 *    controller 的 `instanceof AdChannel*Error` 用自己图里的错误类，混图会把 503 漏成 500。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')（主钥复用支付片）。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

/** 管理读写的常用头（写面必带 actor——网关注入前本阶段测试直接注入头值）。 */
const AUTH = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'admin' };

/** 本键空间唯一键 + 合法值（占位规则 = 非空字符串 ≤512；T0-2 后随密钥形态收严）。 */
const KEY = 'ad.callbackSecret';
const SECRET_VALUE = 'uniad-callback-secret-2026';
/** 标记串自证用：验证「响应/理由面不含输入值」。 */
const MARKER = 'ZZMARKERZZ';

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/* ------------------------------------------------------------------ *
 * 探针（真 Nest 管线；形态照 pay 先例，见文件头）
 * ------------------------------------------------------------------ */

@Module({})
class AdChannelProbeModule {}

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
async function startAdChannelProbe(opts: {
  controller: Type<unknown>;
  serviceToken: Type<unknown>;
  serviceInstance: unknown;
}): Promise<ChannelProbe> {
  const probeModule: DynamicModule = {
    module: AdChannelProbeModule,
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
  db: FakeAdChannelDb;
}

/** 静态图夹具：静态 controller + 静态 service（200/400/401 组用；503 组不走这里）。 */
async function makeHarness(): Promise<Harness> {
  const db = new FakeAdChannelDb();
  const probe = await startAdChannelProbe({
    controller: AdChannelController,
    serviceToken: AdChannelService,
    serviceInstance: new AdChannelService(db.dataSource as unknown as DataSource),
  });
  return { probe, db };
}

/* ------------------------------------------------------------------ *
 * 1：guard fail-closed（真 guard）
 * ------------------------------------------------------------------ */

describe('X-Admin fail-closed（真 guard；三端点同门）', () => {
  let probe: ChannelProbe;
  let db: FakeAdChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('无 X-Admin：GET/PUT/DELETE 一律 401（拦在 handler 之前），库零调用', async () => {
    const get = await probe.get('/api/admin/ad-channel');
    expect(get.status).toBe(401);
    expect(get.body.code).toBe(ErrCode.UNAUTHENTICATED);
    expect(get.body.data).toBeNull();

    const put = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: SECRET_VALUE });
    expect(put.status).toBe(401);
    expect(put.body.message).toBe('admin header required'); // guard 文案（不是 handler 的）

    const del = await probe.del(`/api/admin/ad-channel/${KEY}`);
    expect(del.status).toBe(401);

    expect(db.queries).toHaveLength(0); // 三请求全被拦在 handler 之外
  });

  it('X-Admin: 1 ⇒ 放行（GET 200——判别力：401 不是「恒红」）；GET 不要求 actor 头（仅 PUT/DELETE 列 401）', async () => {
    const res = await probe.get('/api/admin/ad-channel', { [ADMIN_HEADER]: '1' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);
  });
});

/* ------------------------------------------------------------------ *
 * 2：401（错误序专测之一：401 先于一切）
 * ------------------------------------------------------------------ */

describe('写面 401（错误序序①：requireActor 先于一切）', () => {
  let probe: ChannelProbe;
  let db: FakeAdChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('PUT actor 头缺失 ⇒ 401「管理身份缺失」（不是 400/503），库零调用', async () => {
    const res = await probe.putJson(
      `/api/admin/ad-channel/${KEY}`,
      { value: SECRET_VALUE },
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
      `/api/admin/ad-channel/${KEY}`,
      { value: SECRET_VALUE },
      { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'Has Space' },
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body.message).toBe('管理身份缺失');

    const del = await probe.del(`/api/admin/ad-channel/${KEY}`, { [ADMIN_HEADER]: '1' });
    expect(del.status).toBe(401);
    expect(del.body.message).toBe('管理身份缺失');
  });

  it('序①判别：未知键 + 缺 actor ⇒ 401（而非「未知键」400）；非字符串 value + 缺 actor ⇒ 401', async () => {
    const unknownKey = await probe.putJson(
      '/api/admin/ad-channel/ad.nope',
      { value: SECRET_VALUE },
      { [ADMIN_HEADER]: '1' },
    );
    expect(unknownKey.status).toBe(401);
    expect(unknownKey.body.message).toBe('管理身份缺失');

    const badValue = await probe.putJson(
      `/api/admin/ad-channel/${KEY}`,
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

describe('400（未知键 / 非字符串 value / 校验不过；message 均不含值）', () => {
  let probe: ChannelProbe;
  let db: FakeAdChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('未知键 ⇒ 400「未知键」（PUT/DELETE 同规；不是 500、库零调用）', async () => {
    const put = await probe.putJson(
      '/api/admin/ad-channel/ad.nope',
      { value: SECRET_VALUE },
      AUTH,
    );
    expect(put.status).toBe(400);
    expect(put.body).toEqual({ code: ErrCode.BAD_PARAM, message: '未知键', data: null });

    const del = await probe.del('/api/admin/ad-channel/ad.nope', AUTH);
    expect(del.status).toBe(400);
    expect(del.body.message).toBe('未知键');

    expect(db.queries).toHaveLength(0);
  });

  it('非字符串 value（数字 / null / 缺省 / 数组 / 对象）⇒ 400「值必须是字符串」；对象内标记串不漏进 message', async () => {
    for (const body of [{ value: 123 }, { value: null }, {}, { value: ['x'] }]) {
      const res = await probe.putJson(`/api/admin/ad-channel/${KEY}`, body, AUTH);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.message).toBe('值必须是字符串');
    }

    const marker = await probe.putJson(
      `/api/admin/ad-channel/${KEY}`,
      { value: { secret: MARKER } },
      AUTH,
    );
    expect(marker.status).toBe(400);
    expect(marker.body.message).toBe('值必须是字符串');
    expect(marker.body.message).not.toContain(MARKER);

    expect(db.queries).toHaveLength(0); // 形状防御先于一切库操作
  });

  it('value 整缺（无 body）⇒ 400「值必须是字符串」', async () => {
    const res = await probe.putJson(`/api/admin/ad-channel/${KEY}`, undefined, AUTH);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('值必须是字符串');
    expect(db.queries).toHaveLength(0);
  });

  it('校验不过 ⇒ 400 message = 校验理由，且不含输入值（标记串自证；库零调用）', async () => {
    const empty = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: '   ' }, AUTH);
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe(ErrCode.BAD_PARAM);
    expect(empty.body.message).toBe('值不得为空');

    const tooLong = await probe.putJson(
      `/api/admin/ad-channel/${KEY}`,
      { value: MARKER + 'a'.repeat(600) }, // 513+ 字符（占位上限 512）
      AUTH,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.message).toBe('长度超过上限 512');
    expect(tooLong.body.message).not.toContain(MARKER);

    expect(db.queries).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4：200（三端点成功形状逐字）
 * ------------------------------------------------------------------ */

describe('200（三端点成功形状逐字）', () => {
  let probe: ChannelProbe;
  let db: FakeAdChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('GET 空库 ⇒ 单项按 ⚙️1 序、八字段逐字、configured:false（每字段 null）', async () => {
    const res = await probe.get('/api/admin/ad-channel', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);

    const keys = res.body.data.keys as Array<Record<string, unknown>>;
    expect(keys.map((k) => k.key)).toEqual([...AD_CHANNEL_KEYS]);
    expect(keys.map((k) => k.label)).toEqual(['回调密钥']);
    expect(keys.map((k) => k.secret)).toEqual([true]);
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

  it('PUT 密键 ⇒ `{saved:true, fingerprint, updatedAt}`；GET 回读 value 恒 null 只给指纹（掩码写）；响应整串无密文片段', async () => {
    const put = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: SECRET_VALUE }, AUTH);
    expect(put.status).toBe(200);
    expect(put.body.code).toBe(ErrCode.OK);
    expect(Object.keys(put.body.data).sort()).toEqual(['fingerprint', 'saved', 'updatedAt']);
    expect(put.body.data.saved).toBe(true);
    expect(put.body.data.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(put.body.data.updatedAt).toBeTypeOf('number');

    const get = await probe.get('/api/admin/ad-channel', AUTH);
    const item = (get.body.data.keys as Array<Record<string, unknown>>).find((k) => k.key === KEY)!;
    expect(item.configured).toBe(true);
    expect(item.secret).toBe(true);
    expect(item.value).toBeNull(); // 🔴 密键任何角色读不回原文（掩码写）
    expect(item.fingerprint).toBe(put.body.data.fingerprint);
    expect(item.updatedAt).toBeTypeOf('number');
    expect(item.updatedBy).toBe('admin'); // = actor 头值

    // 响应整串无明文/密文片段（掩码写的出站面判据）
    const bodyText = JSON.stringify(get.body);
    expect(bodyText).not.toContain(SECRET_VALUE);

    // at-rest 底样：落库是 `v1:` 密文、不是明文
    const stored = db.rows.get(KEY)!;
    expect(stored.value_enc.startsWith('v1:')).toBe(true);
    expect(stored.value_enc).not.toContain(SECRET_VALUE);
  });

  it('PUT 首写 → 覆盖写：审计两列两形态（old=NULL 首写 / old=redacted 旧指纹覆盖）；GET 指纹随新值', async () => {
    // 先清空该键（本组 db 跨用例共享——清空保证本用例以「首写」起跑；del 的审计行不计入 tail 基线）。
    await probe.del(`/api/admin/ad-channel/${KEY}`, AUTH);
    const before = db.changes.filter((c) => c.key === KEY).length;

    const first = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: 'first-secret-001' }, AUTH);
    expect(first.status).toBe(200);
    const second = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: 'second-secret-002' }, AUTH);
    expect(second.status).toBe(200);

    const inserts = db.changes.filter((c) => c.key === KEY).slice(before);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.oldValue).toBeNull(); // 首写 old = SQL NULL
    expect(inserts[1]!.oldValue).toEqual({
      redacted: true,
      fingerprint: first.body.data.fingerprint, // 覆盖写 old = 旧指纹（redacted 形态）
    });

    const get = await probe.get('/api/admin/ad-channel', AUTH);
    const item = (get.body.data.keys as Array<Record<string, unknown>>).find((k) => k.key === KEY)!;
    expect(item.fingerprint).toBe(second.body.data.fingerprint);
  });

  it('DELETE 存在 ⇒ 200 `{saved:true}` + 行删除；再 DELETE（absent）⇒ 仍 200 `{saved:true}`（幂等）', async () => {
    const put = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: SECRET_VALUE }, AUTH);
    expect(put.status).toBe(200);
    expect(db.rows.has(KEY)).toBe(true);

    const del1 = await probe.del(`/api/admin/ad-channel/${KEY}`, AUTH);
    expect(del1.status).toBe(200);
    expect(del1.body).toEqual({ code: ErrCode.OK, data: { saved: true } });
    expect(db.rows.has(KEY)).toBe(false);

    const del2 = await probe.del(`/api/admin/ad-channel/${KEY}`, AUTH); // 行已不存在
    expect(del2.status).toBe(200);
    expect(del2.body).toEqual({ code: ErrCode.OK, data: { saved: true } });

    const get = await probe.get('/api/admin/ad-channel', AUTH);
    const item = (get.body.data.keys as Array<Record<string, unknown>>).find((k) => k.key === KEY)!;
    expect(item.configured).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5：503 主钥缺 fail-closed（fresh 模块图；错误序专测之二：400 先于 503）
 * ------------------------------------------------------------------ */

describe('503 主钥缺 fail-closed（GET/PUT/DELETE 三者同拒；400 先于 503 逆判别）', () => {
  let probe: ChannelProbe;
  let db: FakeAdChannelDb;

  beforeAll(async () => {
    // fresh 图（crypto 无主钥缓存）：env 置空（空串 = 未设）⇒ 于模块求值后首调即「未设」。
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = '';
    const serviceModule = await import('../src/ad-channel/ad-channel.service');
    const controllerModule = await import('../src/ad-channel/ad-channel.controller');
    db = new FakeAdChannelDb();
    probe = await startAdChannelProbe({
      controller: controllerModule.AdChannelController,
      serviceToken: serviceModule.AdChannelService,
      serviceInstance: new serviceModule.AdChannelService(db.dataSource as unknown as DataSource),
    });
  });
  afterAll(async () => {
    await probe.close();
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64; // 复位（顶层 afterAll 另有原值还原）
  });

  it('GET（空库亦拒——不给「看起来正常」的中间态）⇒ 503 逐字文案', async () => {
    const res = await probe.get('/api/admin/ad-channel', AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '广告回调密钥存储未启用（缺主钥）',
      data: null,
    });
  });

  it('PUT 用**合法值** ⇒ 503（过校验后才轮到主钥检查）；库零调用', async () => {
    const res = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: SECRET_VALUE }, AUTH);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(res.body.message).toBe('广告回调密钥存储未启用（缺主钥）');
    expect(db.queries).toHaveLength(0); // 主钥检查先于事务：库一次都没被碰
  });

  it('序判别（400 先于 503）：同一主钥缺夹具下，非法值 ⇒ 400（校验先拒）、合法值 ⇒ 503——两观测面互斥', async () => {
    const invalid = await probe.putJson(`/api/admin/ad-channel/${KEY}`, { value: '   ' }, AUTH);
    expect(invalid.status).toBe(400); // 不是 503：set() 内部先 validateAndNormalize
    expect(invalid.body.message).toBe('值不得为空');

    const unknown = await probe.putJson('/api/admin/ad-channel/ad.nope', { value: SECRET_VALUE }, AUTH);
    expect(unknown.status).toBe(400); // 注册表白名单先于 service
    expect(unknown.body.message).toBe('未知键');
  });

  it('DELETE ⇒ 503（写面同拒）；库零调用', async () => {
    const res = await probe.del(`/api/admin/ad-channel/${KEY}`, AUTH);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(res.body.message).toBe('广告回调密钥存储未启用（缺主钥）');
    expect(db.queries).toHaveLength(0);
  });
});
