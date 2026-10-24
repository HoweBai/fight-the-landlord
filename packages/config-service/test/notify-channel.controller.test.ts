import 'reflect-metadata';
import {
  Logger,
  Module,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrCode, NOTIFY_CHANNEL_KEYS } from '@fight-the-landlord/protocol';
import { ADMIN_ACTOR_HEADER } from '../src/admin/admin-accounts.service';
import { ADMIN_HEADER } from '../src/config/admin.controller';
import { NotifyChannelController } from '../src/notify-channel/notify-channel.controller';
import { NotifyChannelService } from '../src/notify-channel/notify-channel.service';
import { FakeNotifyChannelDb, type HttpResult } from './helpers/config-probe';

/**
 * 管理三端点契约（规格 §2.4 表**逐字** / §3.1 写路径序 / S-3 附注 / §2.9；T6）。
 *
 * 判据（五组）：
 *  1. guard fail-closed：三端点无 `X-Admin: 1` ⇒ 401（拦在 handler 之前）；
 *  2. **401 先于一切（§3.1 序①）**：PUT/DELETE 的 `requireActor` 缺失/非法 ⇒ 401「管理身份缺失」
 *     ——配「未知键 / 非字符串 value」时观测到的仍是 401（序的判别性在案），且库零调用；
 *  3. **400（§2.4）**：未知键 ⇒「未知键」；非字符串 value（数字/null/缺省/对象）⇒「值必须是
 *     字符串」（W1-4 防御分支）；校验不过 ⇒ message = 校验理由且**不含输入值**（标记串自证）；
 *  4. **200 形状逐字**：GET 九项 ⚙️1 序 + 九字段（secret 键 `value` 恒 null；URL 三键 `hint`
 *     流入管理面、其余六键恒 null）；PUT 回 `{saved:true, fingerprint, updatedAt}`；
 *     DELETE 恒 `{saved:true}`（existent/absent 幂等）；
 *  5. **503（§2.9，fresh 模块图）**：主钥缺 ⇒ GET/PUT/DELETE **三者同拒**；PUT 用**合法值**
 *     （S-3 附注：400 先于 503，非法值观测到的是 400）且库零调用。
 *
 * HTTP 侧走**真 Nest 管线**（guard / 异常过滤器 / 状态码 / globalPrefix 都是真的）。夹具组装照
 * `pay-channel.controller.test.ts`（同族先例）逐字同构，**两处有意差异**（写在这里防误读）：
 *  - `NotifyChannelService` 实现 `OnModuleInit`（⚙️17 启动刷新）⇒ probe 启动时**必然**有一轮
 *    gauge 读（`NOTIFY_CHANNEL_GAUGE_SQL`；假库不认识它——T2 只誊写四条 §2.2 SQL ⇒ 当场失败，
 *    被 `refreshNotifyGauges` 自吞，同 service 单测口径）。夹具以**断言钉住「恰一次」**
 *    （真生命周期行为的唯一判据），随后**起点清账**，之后 `db.queries` 只承载**用例自身**的
 *    库调用观测（「库零调用」断言才有判别力）；
 *  - GET 项含 `hint`（§2.4；九字段）且 URL 三键 hint 有流入断言（矩阵逐格在 validators/service 单测）。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')（同 T5 单测；复用既有供给链）。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

/** 管理读写的常用头（写面必带 actor——T8 网关上线后由网关注入；本阶段测试直接注入头值）。 */
const AUTH = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'admin' };

/* 值夹具（全部落在 example 域/stub 语义内；`ZZ...` 串 = 「不得回显输入值」的标记）。 */
const HOST_VALUE = 'smtp.example.com';
const PASS_VALUE = 'smtp-pass-ZZ-9988';
const WECOM_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz-789';
const WECOM_ORIGIN = 'https://qyapi.weixin.qq.com';
const EXTERNAL_URL = 'https://example.com/hook?token=abc';
const URL_MARKER = 'ZZMARKERZZ';

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
beforeEach(() => {
  // gauge 读在假库上必然失败（⇒ 一次 WARN，见文件头）；其正路断言在 metrics 单测，此处静音。
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  // ⚠️ 刻意**不**在本钩子复位 `PAY_CONFIG_ENC_KEY`：503 组（fresh 模块图）的 beforeAll 把 env
  // 置空后，逐用例复位会让 fresh crypto 的**首次成功解析进缓存**（`parseMasterKey` 语义）——
  // 第二个用例起主钥「复活」、503 组自相矛盾。复位点 = 该组 afterAll + 顶层 afterAll（照 pay 先例）。
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/* ------------------------------------------------------------------ *
 * 探针（真 Nest 管线；形态照 pay-channel.controller.test.ts，见文件头）
 * ------------------------------------------------------------------ */

@Module({})
class NotifyChannelProbeModule {}

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
async function startNotifyChannelProbe(opts: {
  controller: Type<unknown>;
  serviceToken: Type<unknown>;
  serviceInstance: unknown;
}): Promise<ChannelProbe> {
  const probeModule: DynamicModule = {
    module: NotifyChannelProbeModule,
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
  db: FakeNotifyChannelDb;
}

/**
 * 静态图夹具：静态 controller + 静态 service（200/400/401 组用；503 组不走这里）。
 * **起点清账**：listen 前 Nest 已跑 `onModuleInit`（⚙️17 启动刷新；真生命周期对 useValue
 * provider 同样触发）⇒ 假库上该 gauge 读已发生一次（失败并自吞）。清掉后 `db.queries`
 * 恰承载用例自身的调用观测。
 */
async function makeHarness(): Promise<Harness> {
  const db = new FakeNotifyChannelDb();
  const probe = await startNotifyChannelProbe({
    controller: NotifyChannelController,
    serviceToken: NotifyChannelService,
    serviceInstance: new NotifyChannelService(db.dataSource as unknown as DataSource),
  });
  // ⚙️17 启动刷新点经**真 Nest 生命周期**生效的实证（useValue provider 同样触发 onModuleInit）：
  // listen 前恰一次 gauge 读。T5 单测只手工调 `svc.onModuleInit()`——「真启动会触发」在此之前
  // 无任何判据；此处钉住它（若将来启动读消失/增读，本断言先红，而非被清账静默吸收）。
  expect(db.queries, 'probe 启动应恰有一次 onModuleInit 的 gauge 读').toHaveLength(1);
  db.queries.length = 0;
  return { probe, db };
}

/* ------------------------------------------------------------------ *
 * 1：guard fail-closed（真 guard）
 * ------------------------------------------------------------------ */

describe('X-Admin fail-closed（真 guard；三端点同门）', () => {
  let probe: ChannelProbe;
  let db: FakeNotifyChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('无 X-Admin：GET/PUT/DELETE 一律 401（拦在 handler 之前），库零调用', async () => {
    const get = await probe.get('/api/admin/notify-channel');
    expect(get.status).toBe(401);
    expect(get.body.code).toBe(ErrCode.UNAUTHENTICATED);
    expect(get.body.data).toBeNull();

    const put = await probe.putJson('/api/admin/notify-channel/notify.smtp.host', {
      value: HOST_VALUE,
    });
    expect(put.status).toBe(401);
    expect(put.body.message).toBe('admin header required'); // guard 文案（不是 handler 的）

    const del = await probe.del('/api/admin/notify-channel/notify.smtp.host');
    expect(del.status).toBe(401);

    expect(db.queries).toHaveLength(0); // 三请求全被拦在 handler 之外
  });

  it('X-Admin: 1 ⇒ 放行（GET 200——判别力：401 不是「恒红」）；GET 不要求 actor 头（§2.4 仅 PUT/DELETE 列 401）', async () => {
    const res = await probe.get('/api/admin/notify-channel', { [ADMIN_HEADER]: '1' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);
  });
});

/* ------------------------------------------------------------------ *
 * 2：401（§3.1 序①——requireActor 先于一切）
 * ------------------------------------------------------------------ */

describe('写面 401（§3.1 序①：requireActor 先于一切）', () => {
  let probe: ChannelProbe;
  let db: FakeNotifyChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('PUT actor 头缺失 ⇒ 401「管理身份缺失」（不是 400/503），库零调用', async () => {
    const res = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.host',
      { value: HOST_VALUE },
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
      '/api/admin/notify-channel/notify.smtp.host',
      { value: HOST_VALUE },
      { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'Has Space' },
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body.message).toBe('管理身份缺失');

    const del = await probe.del('/api/admin/notify-channel/notify.smtp.host', {
      [ADMIN_HEADER]: '1',
    });
    expect(del.status).toBe(401);
    expect(del.body.message).toBe('管理身份缺失');
  });

  it('序①判别：未知键 + 缺 actor ⇒ 401（而非「未知键」400）；非字符串 value + 缺 actor ⇒ 401', async () => {
    const unknownKey = await probe.putJson(
      '/api/admin/notify-channel/notify.nope',
      { value: HOST_VALUE },
      { [ADMIN_HEADER]: '1' },
    );
    expect(unknownKey.status).toBe(401);
    expect(unknownKey.body.message).toBe('管理身份缺失');

    const badValue = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.host',
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
  let db: FakeNotifyChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('未知键 ⇒ 400「未知键」（PUT/DELETE 同规；不是 500、库零调用）', async () => {
    const put = await probe.putJson(
      '/api/admin/notify-channel/notify.nope',
      { value: HOST_VALUE },
      AUTH,
    );
    expect(put.status).toBe(400);
    expect(put.body).toEqual({ code: ErrCode.BAD_PARAM, message: '未知键', data: null });

    const del = await probe.del('/api/admin/notify-channel/notify.nope', AUTH);
    expect(del.status).toBe(400);
    expect(del.body.message).toBe('未知键');

    expect(db.queries).toHaveLength(0);
  });

  it('非字符串 value（数字 / null / 缺省 / 数组 / 对象）⇒ 400「值必须是字符串」；对象内标记串不漏进 message（W1-4）', async () => {
    for (const body of [{ value: 123 }, { value: null }, {}, { value: ['x'] }]) {
      const res = await probe.putJson('/api/admin/notify-channel/notify.smtp.host', body, AUTH);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.message).toBe('值必须是字符串');
    }

    const marker = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.pass',
      { value: { pass: URL_MARKER } },
      AUTH,
    );
    expect(marker.status).toBe(400);
    expect(marker.body.message).toBe('值必须是字符串');
    expect(marker.body.message).not.toContain(URL_MARKER);

    expect(db.queries).toHaveLength(0); // 形状防御先于一切库操作
  });

  it('value 整缺（无 body）⇒ 400「值必须是字符串」', async () => {
    const res = await probe.putJson('/api/admin/notify-channel/notify.smtp.host', undefined, AUTH);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('值必须是字符串');
    expect(db.queries).toHaveLength(0);
  });

  it('校验不过 ⇒ 400 message = 校验理由（§2.4 逐字），且不含输入值（标记串自证；库零调用）', async () => {
    const badHost = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.host',
      { value: `bad host-${URL_MARKER}` },
      AUTH,
    );
    expect(badHost.status).toBe(400);
    expect(badHost.body.code).toBe(ErrCode.BAD_PARAM);
    expect(badHost.body.message).toBe('必须是合法主机名（字母/数字/点/横线）');
    expect(badHost.body.message).not.toContain(URL_MARKER);

    const empty = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.user',
      { value: '   ' },
      AUTH,
    );
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('值不得为空'); // 全键先 trim；空串统一理由（§2.4）

    const badPort = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.port',
      { value: '99999' },
      AUTH,
    );
    expect(badPort.status).toBe(400);
    expect(badPort.body.message).toBe('必须是 1-65535 的端口号');

    const badUrl = await probe.putJson(
      '/api/admin/notify-channel/notify.webhook.wecomUrl',
      { value: `not-a-url-${URL_MARKER}` },
      AUTH,
    );
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.message).toBe('必须是 http/https 协议的合法 URL');
    expect(badUrl.body.message).not.toContain(URL_MARKER);

    expect(db.queries).toHaveLength(0); // 校验先于一切库操作（C5「400 了却先落库」不可能）
    expect(db.changes).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4：200（§2.4 三端点成功形状逐字）
 * ------------------------------------------------------------------ */

describe('200（§2.4 三端点成功形状逐字）', () => {
  let probe: ChannelProbe;
  let db: FakeNotifyChannelDb;

  beforeAll(async () => {
    ({ probe, db } = await makeHarness());
  });
  afterAll(async () => {
    await probe.close();
  });

  it('GET 空库 ⇒ 九项按 ⚙️1 序、九字段逐字（含 hint）、全 configured:false（每字段 null）', async () => {
    const res = await probe.get('/api/admin/notify-channel', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);

    const keys = res.body.data.keys as Array<Record<string, unknown>>;
    expect(keys.map((k) => k.key)).toEqual([...NOTIFY_CHANNEL_KEYS]);
    expect(keys.map((k) => k.label)).toEqual([
      '邮件服务器',
      '邮件端口',
      '邮件账号',
      '邮件授权码',
      '告警收件地址',
      '飞书机器人地址',
      '企业微信机器人地址',
      '钉钉机器人地址',
      '钉钉加签密钥',
    ]);
    expect(keys.map((k) => k.secret)).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
    for (const item of keys) {
      expect(Object.keys(item).sort()).toEqual([
        'configured',
        'fingerprint',
        'hint',
        'key',
        'label',
        'secret',
        'updatedAt',
        'updatedBy',
        'value',
      ]);
      expect(item.configured).toBe(false);
      expect(item.value).toBeNull();
      expect(item.fingerprint).toBeNull();
      expect(item.hint).toBeNull();
      expect(item.updatedAt).toBeNull();
      expect(item.updatedBy).toBeNull();
    }
  });

  it('PUT 非密键（带前后空白）⇒ `{saved:true, fingerprint, updatedAt}`；canonical=trim 经 GET 回读一致、hint 恒 null；落库为密文', async () => {
    const put = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.host',
      { value: `  ${HOST_VALUE}  ` }, // 前后空白 ⇒ canonical = trim（§2.3 唯一变换）
      AUTH,
    );
    expect(put.status).toBe(200);
    expect(put.body.code).toBe(ErrCode.OK);
    expect(Object.keys(put.body.data).sort()).toEqual(['fingerprint', 'saved', 'updatedAt']);
    expect(put.body.data.saved).toBe(true);
    expect(put.body.data.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(put.body.data.updatedAt).toBeTypeOf('number');

    const get = await probe.get('/api/admin/notify-channel', AUTH);
    const host = (get.body.data.keys as Array<Record<string, unknown>>).find(
      (k) => k.key === 'notify.smtp.host',
    )!;
    expect(host.configured).toBe(true);
    expect(host.value).toBe(HOST_VALUE); // canonical = trim 后的原文
    expect(host.fingerprint).toBe(put.body.data.fingerprint);
    expect(host.hint).toBeNull(); // 非 URL 键 hint 恒 null（§2.4）
    expect(host.updatedAt).toBeTypeOf('number');
    expect(host.updatedBy).toBe('admin'); // = actor 头值

    // at-rest 底样：落库是 `v1:` 密文、不是明文（完整 at-rest 链在 slice-23 ③）
    const stored = db.rows.get('notify.smtp.host')!;
    expect(stored.value_enc.startsWith('v1:')).toBe(true);
    expect(stored.value_enc).not.toContain(HOST_VALUE);
  });

  it('PUT 密键（smtp.pass）⇒ GET 该项 value 恒 null、只给指纹；响应整串无明文片段（掩码写）', async () => {
    const put = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.pass',
      { value: PASS_VALUE },
      AUTH,
    );
    expect(put.status).toBe(200);
    expect(put.body.data.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const get = await probe.get('/api/admin/notify-channel', AUTH);
    const pass = (get.body.data.keys as Array<Record<string, unknown>>).find(
      (k) => k.key === 'notify.smtp.pass',
    )!;
    expect(pass.configured).toBe(true);
    expect(pass.secret).toBe(true);
    expect(pass.value).toBeNull(); // 🔴 授权码任何角色读不回原文（§2.4 掩码写）
    expect(pass.fingerprint).toBe(put.body.data.fingerprint);
    expect(pass.updatedBy).toBe('admin');

    expect(JSON.stringify(get.body)).not.toContain(PASS_VALUE); // 明文不出现在读面
  });

  it('PUT URL 密键 ⇒ GET `value` 恒 null；`hint` 流入：三平台全等 ⇒ origin，外部 ⇒「外部地址」；正文无完整 URL', async () => {
    const putWecom = await probe.putJson(
      '/api/admin/notify-channel/notify.webhook.wecomUrl',
      { value: WECOM_URL },
      AUTH,
    );
    expect(putWecom.status).toBe(200);

    const putExternal = await probe.putJson(
      '/api/admin/notify-channel/notify.webhook.feishuUrl',
      { value: EXTERNAL_URL },
      AUTH,
    );
    expect(putExternal.status).toBe(200);

    const get = await probe.get('/api/admin/notify-channel', AUTH);
    const keys = get.body.data.keys as Array<Record<string, unknown>>;
    const wecom = keys.find((k) => k.key === 'notify.webhook.wecomUrl')!;
    const feishu = keys.find((k) => k.key === 'notify.webhook.feishuUrl')!;

    expect(wecom.secret).toBe(true);
    expect(wecom.value).toBeNull(); // URL 同为密键 ⇒ 不回原文（🔴 凭据 URL 逐字保真只对拉取通道，§2.4）
    expect(wecom.hint).toBe(WECOM_ORIGIN); // 全等命中 qyapi.weixin.qq.com ⇒ origin

    expect(feishu.secret).toBe(true);
    expect(feishu.value).toBeNull();
    expect(feishu.hint).toBe('外部地址'); // 非三平台 ⇒ 外部地址

    const bodyText = JSON.stringify(get.body);
    expect(bodyText).not.toContain(WECOM_URL); // 完整凭据 URL（含 key= 段）不入读面
    expect(bodyText).not.toContain(EXTERNAL_URL);
  });

  it('DELETE 存在 ⇒ 200 `{saved:true}` + 行删除；再 DELETE（absent）⇒ 仍 200 `{saved:true}`（幂等）', async () => {
    const put = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.user',
      { value: 'ops@example.com' },
      AUTH,
    );
    expect(put.status).toBe(200);
    expect(db.rows.has('notify.smtp.user')).toBe(true);

    const del1 = await probe.del('/api/admin/notify-channel/notify.smtp.user', AUTH);
    expect(del1.status).toBe(200);
    expect(del1.body).toEqual({ code: ErrCode.OK, data: { saved: true } });
    expect(db.rows.has('notify.smtp.user')).toBe(false);

    const del2 = await probe.del('/api/admin/notify-channel/notify.smtp.user', AUTH); // 行已不存在
    expect(del2.status).toBe(200);
    expect(del2.body).toEqual({ code: ErrCode.OK, data: { saved: true } });

    const get = await probe.get('/api/admin/notify-channel', AUTH);
    const item = (get.body.data.keys as Array<Record<string, unknown>>).find(
      (k) => k.key === 'notify.smtp.user',
    )!;
    expect(item.configured).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5：503 主钥缺 fail-closed（§2.9；GET/PUT/DELETE 三者同拒）
 * ------------------------------------------------------------------ */

describe('503 主钥缺 fail-closed（§2.9；GET/PUT/DELETE 三者同拒）', () => {
  let probe: ChannelProbe;
  let db: FakeNotifyChannelDb;

  beforeAll(async () => {
    // fresh 图（crypto 无主钥缓存）：env 置空（空串 = 未设，⚙️5）⇒ 于模块求值后首调即「未设」。
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = '';
    const serviceModule = await import('../src/notify-channel/notify-channel.service');
    const controllerModule = await import('../src/notify-channel/notify-channel.controller');
    db = new FakeNotifyChannelDb();
    probe = await startNotifyChannelProbe({
      controller: controllerModule.NotifyChannelController,
      serviceToken: serviceModule.NotifyChannelService,
      serviceInstance: new serviceModule.NotifyChannelService(db.dataSource as unknown as DataSource),
    });
    db.queries.length = 0; // 起点清账（同 makeHarness：onModuleInit 的 gauge 读已自吞）
  });
  afterAll(async () => {
    await probe.close();
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64; // 复位（顶层 afterAll 另有原值还原）
  });

  it('GET（空库亦拒——不给「看起来正常」的中间态）⇒ 503 §2.9 逐字', async () => {
    const res = await probe.get('/api/admin/notify-channel', AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '通知通道密钥存储未启用（缺主钥）',
      data: null,
    });
  });

  it('PUT 用**合法值**（S-3：400 先于 503，非法值观测不到 503）⇒ 503；库零调用', async () => {
    const res = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.host',
      { value: HOST_VALUE }, // 合法：过校验后才轮到主钥检查（§3.1 序）
      AUTH,
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(res.body.message).toBe('通知通道密钥存储未启用（缺主钥）');
    expect(db.queries).toHaveLength(0); // 主钥检查先于事务：库一次都没被碰
  });

  it('序判别（S-3 附注）：非法值 PUT ⇒ 400（校验先于主钥），不是 503；库零调用', async () => {
    const res = await probe.putJson(
      '/api/admin/notify-channel/notify.smtp.host',
      { value: `bad host-${URL_MARKER}` },
      AUTH,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrCode.BAD_PARAM);
    expect(res.body.message).toBe('必须是合法主机名（字母/数字/点/横线）');
    expect(db.queries).toHaveLength(0);
  });

  it('DELETE ⇒ 503（写面同拒）；库零调用', async () => {
    const res = await probe.del('/api/admin/notify-channel/notify.smtp.host', AUTH);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(res.body.message).toBe('通知通道密钥存储未启用（缺主钥）');
    expect(db.queries).toHaveLength(0);
  });
});
