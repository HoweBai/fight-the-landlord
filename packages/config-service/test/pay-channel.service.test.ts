import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { PAY_CHANNEL_KEYS, type PayChannelKey } from '@fight-the-landlord/protocol';
import {
  PayChannelService,
  PayChannelStorageDisabledError,
  PayChannelValidationError,
  PAY_CHANNEL_DELETE_SQL,
  PAY_CHANNEL_LIST_SQL,
  PAY_CHANNEL_LOCK_SQL,
  PAY_CHANNEL_UPSERT_SQL,
} from '../src/pay-channel/pay-channel.service';
import { CONFIG_CHANGES_INSERT_SQL } from '../src/admin/admin-changes.service';
import { decrypt, encrypt, fingerprintOf } from '../src/pay-channel/pay-channel.crypto';
import {
  FakePayChannelDb,
  SPEC_PAY_CHANNEL_DELETE_SQL,
  SPEC_PAY_CHANNEL_LIST_SQL,
  SPEC_PAY_CHANNEL_LOCK_SQL,
  SPEC_PAY_CHANNEL_UPSERT_SQL,
  type FakePayChannelEm,
  type FakePayChannelRow,
  type RecordedAdminQuery,
} from './helpers/config-probe';

/**
 * service 层单测（规格 §5.1-3；T4 交付物）。载体 = 假库 `FakePayChannelDb`（T2 交付；
 * 「假库不建模锁」⇒ 并发语义以 **1213 重试注入**验证，T-2/§5.1-3）。
 *
 * 用例族（与 §5.1-3 逐条对位）：
 *  1. 写事务三段序（锁 → UPSERT → 审计**同事务**；事务外通道零调用 = 「事务外无审计行」）；
 *  2. 审计形状（⚙️17 逐字 JSON 串）：密键 redacted / 非密 JSON 串 / 清空 new='null' / 无行 clear 不落审计；
 *  3. `status()` 六项固定序 + secret value 恒 null + 缺行 configured:false + epoch ms；
 *  4. `pull()` 仅已配置键（缺键不补）；
 *  5. **实现常量 === 测试侧誊写（四条全文互钉）**；
 *  6. 1213 有界重试（四种形态各恰一次重试；连抛 3 次 ⇒ 抛；非 1213 不重试）；
 *  7. 校验失败**先于一切库操作**（库零调用）；主钥缺 fail-closed（set/status/pull 一致拒）。
 *
 * ⚠️ 主钥用例走 `vi.resetModules()` + 动态 import 取**全新模块图**（crypto 的进程缓存使
 * 「未设主钥」在既有实例上不可达——同 `pay-channel.crypto.test.ts` 的 freshCrypto 形态）。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

/** 密钥素材 = 切片内现生成（RSA-2048；校验器要 `createPrivateKey` 可解析，同 validators.test）。 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PRIVATE_CANONICAL = Buffer.from(PRIVATE_PEM.trim() + '\n', 'utf8').toString('base64');

const GW_CANONICAL = 'https://api.example.com/pay';

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterEach(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64; // 主钥用例（fresh 模块）后复位
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/* ------------------------------------------------------------------ *
 * 探针：假库 + 双通道观测（事务外 / 事务）
 * ------------------------------------------------------------------ */

interface PayChannelProbe {
  svc: PayChannelService;
  db: FakePayChannelDb;
  /** **事务外**通道（`dataSource.query`）观测面——「事务外无审计行/零库操作」断言用它。 */
  outer: RecordedAdminQuery[];
  /** `dataSource.transaction()` 调用次数（重试断言：1 = 无重试；2/3 = 重试次数+1）。 */
  txCalls: () => number;
}

/**
 * 假库 + 计数包装：`transaction` 前 N 次按 `failures` 注入失败（模拟 1213 死锁/任意错误），
 * 其后委托假库。`ctor` 缺省 = 静态导入的类；fresh 模块用例传动态 import 的类（instanceof 对位）。
 */
function makeProbe(
  db: FakePayChannelDb,
  opts: { ctor?: typeof PayChannelService; failures?: unknown[] } = {},
): PayChannelProbe {
  const Ctor = opts.ctor ?? PayChannelService;
  const failures = opts.failures ?? [];
  const outer: RecordedAdminQuery[] = [];
  let txCalls = 0;
  let failIdx = 0;
  const ds = {
    query: (sql: string, params: unknown[] = []) => {
      outer.push({ sql, params });
      return db.dataSource.query(sql, params);
    },
    transaction: <T,>(cb: (em: FakePayChannelEm) => Promise<T>): Promise<T> => {
      txCalls += 1;
      if (failIdx < failures.length) return Promise.reject(failures[failIdx++]);
      return db.dataSource.transaction(cb);
    },
  };
  return { svc: new Ctor(ds as unknown as DataSource), db, outer, txCalls: () => txCalls };
}

/** 直插一行「真实」数据：密文可解 + 指纹 = canonical 指纹（= set 路径会落的样子）。 */
function seedRow(
  db: FakePayChannelDb,
  key: PayChannelKey,
  canonical: string,
  over: Partial<FakePayChannelRow> = {},
): FakePayChannelRow {
  return db.addRow(key, {
    value_enc: encrypt(key, canonical),
    fingerprint: fingerprintOf(canonical),
    updated_by: 'seed',
    ...over,
  });
}

/** 审计留痕的 INSERT 参数（`[key, old, new, actor]`，**原始绑定值**——JSON 串断言在此逐字）。 */
function changeInserts(db: FakePayChannelDb): RecordedAdminQuery[] {
  return db.queries.filter((q) => q.sql === CONFIG_CHANGES_INSERT_SQL);
}

/** 1213 四种注入形态（三重检测口径 + driverError 包装；逐形态各过一遍）。 */
function deadlockErr(shape: 'errno' | 'code' | 'message' | 'wrapped'): Error {
  switch (shape) {
    case 'errno':
      return Object.assign(new Error('write conflict'), { errno: 1213 });
    case 'code':
      return Object.assign(new Error('write conflict'), { code: 'ER_LOCK_DEADLOCK' });
    case 'message':
      return new Error('Deadlock found when trying to get lock; try restarting transaction');
    case 'wrapped':
      return Object.assign(new Error('Query failed'), {
        driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' },
      });
  }
}

/** 取一个全新模块图（crypto 无主钥缓存）并把 env 置为给定值。 */
async function freshServiceModule(envValue: string) {
  vi.resetModules();
  process.env.PAY_CONFIG_ENC_KEY = envValue;
  return import('../src/pay-channel/pay-channel.service');
}

/* ------------------------------------------------------------------ *
 * 1/5：常量互钉 + 校验先于库操作
 * ------------------------------------------------------------------ */

describe('pay-channel.service —— 常量互钉与校验前置（§2.2 / §3.1 C5）', () => {
  it('实现四条 SQL 常量 === 测试侧誊写（全文互钉；漂移 ⇒ 当场红）', () => {
    expect(PAY_CHANNEL_LOCK_SQL).toBe(SPEC_PAY_CHANNEL_LOCK_SQL);
    expect(PAY_CHANNEL_UPSERT_SQL).toBe(SPEC_PAY_CHANNEL_UPSERT_SQL);
    expect(PAY_CHANNEL_LIST_SQL).toBe(SPEC_PAY_CHANNEL_LIST_SQL);
    expect(PAY_CHANNEL_DELETE_SQL).toBe(SPEC_PAY_CHANNEL_DELETE_SQL);
  });

  it('校验失败先于一切库操作：空串/坏 URL/未知键 ⇒ PayChannelValidationError 且库零调用', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db);

    await expect(p.svc.set('pay.channel.gatewayUrl', '', 'alice')).rejects.toBeInstanceOf(
      PayChannelValidationError,
    );
    // reason 原样透出（T5 作 400 message）、不含输入值（§2.9——用标记串自证）
    await expect(
      p.svc.set('pay.channel.gatewayUrl', 'not-a-url-ZZMARKERZZ', 'alice'),
    ).rejects.toMatchObject({ reason: '必须是 http/https 协议的合法 URL' });
    const badErr = await p.svc
      .set('pay.channel.gatewayUrl', 'not-a-url-ZZMARKERZZ', 'alice')
      .then(() => null, (e: unknown) => e);
    expect(String((badErr as PayChannelValidationError).reason)).not.toContain('ZZMARKERZZ');
    // 未知键（运行时形态）：validateAndNormalize 的 default 分支兜底 ⇒ 400 候选（T5 注册表之外仍拒）
    await expect(
      p.svc.set('pay.channel.nope' as unknown as PayChannelKey, 'https://x.example.com', 'alice'),
    ).rejects.toMatchObject({ reason: '未知键' });

    expect(db.queries).toHaveLength(0); // 库零调用（连锁定读都不发生）
    expect(db.changes).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2：写路径三段序 + 审计形状（⚙️17）
 * ------------------------------------------------------------------ */

describe('pay-channel.service —— 写事务三段序（§3.1）', () => {
  it('锁 → UPSERT → 审计：三句同事务（事务外零库操作）、顺序恰如此、密文落库可解回 canonical', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db);

    const t0 = Date.now();
    const res = await p.svc.set('pay.channel.gatewayUrl', GW_CANONICAL + '/', 'alice');

    // 「同事务」的观测面：三句全走事务内 EM（事务外通道一次都没被碰——审计不可能在事务外落）
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(1);
    expect(db.queries.map((q) => q.sql)).toEqual([
      SPEC_PAY_CHANNEL_LOCK_SQL,
      SPEC_PAY_CHANNEL_UPSERT_SQL,
      CONFIG_CHANGES_INSERT_SQL,
    ]);

    // UPSERT 参数：key / 密文（非明文）/ 指纹 / actor
    const upsert = db.queries[1]!;
    expect(upsert.params[0]).toBe('pay.channel.gatewayUrl');
    expect(String(upsert.params[1]).startsWith('v1:')).toBe(true);
    expect(String(upsert.params[1])).not.toContain('api.example.com');
    expect(upsert.params[2]).toBe(fingerprintOf(GW_CANONICAL)); // canonical = 去尾斜杠
    expect(upsert.params[3]).toBe('alice');

    // 落库行：密文可解回 canonical；审计行恰一（old=SQL NULL 首写、new=JSON 字符串原文）
    const stored = db.rows.get('pay.channel.gatewayUrl')!;
    expect(decrypt('pay.channel.gatewayUrl', stored.value_enc)).toBe(GW_CANONICAL);
    expect(db.changes).toEqual([
      { key: 'pay.channel.gatewayUrl', oldValue: null, newValue: GW_CANONICAL, actor: 'alice' },
    ]);

    // 返回值 {fingerprint, updatedAt}（updatedAt = 提交当刻 epoch ms）
    expect(res.fingerprint).toBe(fingerprintOf(GW_CANONICAL));
    expect(res.updatedAt).toBeGreaterThanOrEqual(t0);
    expect(res.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('非密键审计 = JSON 字符串原文；首写 old_value 传 SQL NULL（⚙️17①）', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db);
    await p.svc.set('pay.channel.sellerId', '2088721087500000', 'alice');

    const inserts = changeInserts(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params).toEqual([
      'pay.channel.sellerId',
      null, // ⚙️17①：首写/无旧行 ⇒ old_value 传 SQL NULL（绑定 null）
      JSON.stringify('2088721087500000'), // 非密 = JSON 字符串（JSON.stringify(value)）
      'alice',
    ]);
  });

  it('非密键覆盖写：old = 旧明文 JSON 串（锁定读解密）；重写不碰其它键', async () => {
    const db = new FakePayChannelDb();
    seedRow(db, 'pay.channel.gatewayUrl', 'https://old.example.com');
    const p = makeProbe(db);

    await p.svc.set('pay.channel.gatewayUrl', 'https://new.example.com', 'bob');

    const inserts = changeInserts(db);
    expect(inserts[0]!.params).toEqual([
      'pay.channel.gatewayUrl',
      JSON.stringify('https://old.example.com'),
      JSON.stringify('https://new.example.com'),
      'bob',
    ]);
  });

  it('密键审计 = {"redacted":true,"fingerprint":"<12hex>"}（⚙️17）；明文/base64 片段不出现在任何审计参数', async () => {
    const db = new FakePayChannelDb();
    // 旧行 value_enc 故意不可解密：密键 old 只用**存储指纹**（无需解密）——此断言钉住该性质
    db.addRow('pay.channel.privateKey', {
      value_enc: 'v1:not-needed-for-secret-old',
      fingerprint: 'cafebabecafe',
      updated_by: 'seed',
    });
    const p = makeProbe(db);

    const res = await p.svc.set('pay.channel.privateKey', PRIVATE_PEM, 'alice');
    expect(res.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const inserts = changeInserts(db);
    expect(inserts).toHaveLength(1);
    const [, oldParam, newParam] = inserts[0]!.params as [string, string, string, string];
    expect(oldParam).toBe('{"redacted":true,"fingerprint":"cafebabecafe"}'); // 旧指纹（存储列）
    expect(newParam).toBe(`{"redacted":true,"fingerprint":"${res.fingerprint}"}`); // 新指纹（逐字字符串）
    // 密文/明文两形态都不得出现（PEM 原文片段 + canonical base64 片段）
    for (const param of inserts[0]!.params) {
      expect(String(param)).not.toContain('-----BEGIN');
      expect(String(param)).not.toContain(PRIVATE_CANONICAL.slice(40, 100));
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2/4：clear（清空）与 pull（拉取）
 * ------------------------------------------------------------------ */

describe('pay-channel.service —— 清空（§3.1）', () => {
  it('非密键：锁 → DELETE → 审计同事务；old = 旧明文 JSON 串、new = JSON 字符串 \'null\'（⚙️17②）', async () => {
    const db = new FakePayChannelDb();
    seedRow(db, 'pay.channel.gatewayUrl', GW_CANONICAL);
    const p = makeProbe(db);

    await expect(p.svc.clear('pay.channel.gatewayUrl', 'alice')).resolves.toEqual({ existed: true });

    expect(p.outer).toHaveLength(0); // 三段同事务
    expect(db.queries.map((q) => q.sql)).toEqual([
      SPEC_PAY_CHANNEL_LOCK_SQL,
      SPEC_PAY_CHANNEL_DELETE_SQL,
      CONFIG_CHANGES_INSERT_SQL,
    ]);
    expect(db.rows.has('pay.channel.gatewayUrl')).toBe(false);
    expect(changeInserts(db)[0]!.params).toEqual([
      'pay.channel.gatewayUrl',
      JSON.stringify(GW_CANONICAL),
      'null', // ⚙️17②：清空 new_value 传 JSON 字符串 'null'（SQL NULL 会被 NOT NULL 以 1048 拒）
      'alice',
    ]);
  });

  it('密键：old = redacted 旧指纹、new = \'null\'；行删除', async () => {
    const db = new FakePayChannelDb();
    db.addRow('pay.channel.privateKey', {
      value_enc: encrypt('pay.channel.privateKey', PRIVATE_CANONICAL),
      fingerprint: 'cafebabecafe',
    });
    const p = makeProbe(db);

    await expect(p.svc.clear('pay.channel.privateKey', 'bob')).resolves.toEqual({ existed: true });

    expect(db.rows.has('pay.channel.privateKey')).toBe(false);
    expect(changeInserts(db)[0]!.params).toEqual([
      'pay.channel.privateKey',
      '{"redacted":true,"fingerprint":"cafebabecafe"}',
      'null',
      'bob',
    ]);
  });

  it('无行清空：existed:false、不落审计、不发 DELETE（幂等）', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db);

    await expect(p.svc.clear('pay.channel.sellerId', 'alice')).resolves.toEqual({ existed: false });

    expect(changeInserts(db)).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
    expect(db.queries.some((q) => q.sql === SPEC_PAY_CHANNEL_DELETE_SQL)).toBe(false);
  });
});

describe('pay-channel.service —— pull（§3.2 / §2.5）', () => {
  it('仅已配置键（缺键不补）；密键含值；值 = canonical（base64(PEM) 逐字）', async () => {
    const db = new FakePayChannelDb();
    seedRow(db, 'pay.channel.gatewayUrl', GW_CANONICAL);
    seedRow(db, 'pay.channel.privateKey', PRIVATE_CANONICAL);
    seedRow(db, 'pay.channel.sellerId', '2088721087500000');
    const p = makeProbe(db);

    const values = await p.svc.pull();

    expect(values).toEqual({
      'pay.channel.gatewayUrl': GW_CANONICAL,
      'pay.channel.privateKey': PRIVATE_CANONICAL, // 密钥类值 = 旧 env 格式（读侧零改）
      'pay.channel.sellerId': '2088721087500000',
    });
    expect(Object.keys(values)).toHaveLength(3); // appId/publicKey/publicBaseUrl 缺键不补
    expect(values['pay.channel.appId']).toBeUndefined();
  });

  it('空库 ⇒ {}（不补默认）', async () => {
    const p = makeProbe(new FakePayChannelDb());
    await expect(p.svc.pull()).resolves.toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * 3：status（管理读）
 * ------------------------------------------------------------------ */

describe('pay-channel.service —— status（§2.4 GET 项形状）', () => {
  it('空库：六项按 PAY_CHANNEL_KEYS 固定序、全 configured:false、label 逐字、secret 仅 privateKey', async () => {
    const p = makeProbe(new FakePayChannelDb());
    const items = await p.svc.status();

    expect(items.map((i) => i.key)).toEqual([...PAY_CHANNEL_KEYS]);
    expect(items.map((i) => i.label)).toEqual([
      '渠道网关地址',
      '应用 APPID',
      '应用私钥',
      '支付宝公钥',
      '商户 PID',
      '对外站点基址',
    ]);
    expect(items.map((i) => i.secret)).toEqual([false, false, true, false, false, false]);
    for (const item of items) {
      expect(item).toEqual({
        key: item.key,
        label: item.label,
        secret: item.secret,
        configured: false,
        value: null,
        fingerprint: null,
        updatedAt: null,
        updatedBy: null,
      });
    }
  });

  it('已配置：非密给明文 / 密键 value 恒 null 只给指纹 / updatedAt = epoch ms（⚙️1）', async () => {
    const db = new FakePayChannelDb();
    db.now = new Date('2026-10-06T08:00:00.000Z');
    seedRow(db, 'pay.channel.gatewayUrl', GW_CANONICAL);
    db.addRow('pay.channel.publicKey', {
      value_enc: encrypt('pay.channel.publicKey', 'some-canonical-public'),
      fingerprint: 'a1b2c3d4e5f6',
      updated_by: 'alice',
    });
    const p = makeProbe(db);

    const items = await p.svc.status();
    expect(items).toHaveLength(6);
    // W2-1 硬化（评审波 2 突变实证）：**有数据面**的顺序判据——种子的两行按 key 字母序 vs ⚙️1 序不同，
    // 若 status() 退化为「行序优先 + 缺键补尾」，此处当场红（空库用例只覆盖全缺键形态）。
    expect(items.map((i) => i.key)).toEqual([...PAY_CHANNEL_KEYS]);

    const gw = items.find((i) => i.key === 'pay.channel.gatewayUrl')!;
    expect(gw).toEqual({
      key: 'pay.channel.gatewayUrl',
      label: '渠道网关地址',
      secret: false,
      configured: true,
      value: GW_CANONICAL, // 非密键 = 明文回显
      fingerprint: fingerprintOf(GW_CANONICAL),
      updatedAt: Date.parse('2026-10-06T08:00:00.000Z'),
      updatedBy: 'seed',
    });
    const pub = items.find((i) => i.key === 'pay.channel.publicKey')!;
    expect(pub.configured).toBe(true);
    expect(pub.value).toBe('some-canonical-public'); // 第二个非密行同样明文回显

    // 密键（publicKey 也是非密；用 privateKey 钉掩码）+ 缺行（appId）钉 configured:false
    seedRow(db, 'pay.channel.privateKey', PRIVATE_CANONICAL, { updated_by: 'bob' });
    const items2 = await p.svc.status();
    const pk = items2.find((i) => i.key === 'pay.channel.privateKey')!;
    expect(pk.configured).toBe(true);
    expect(pk.value).toBeNull(); // 🔴 secret 键 value 恒 null（掩码写，D4）
    expect(pk.fingerprint).toBe(fingerprintOf(PRIVATE_CANONICAL));
    expect(pk.updatedBy).toBe('bob');
    const appId = items2.find((i) => i.key === 'pay.channel.appId')!;
    expect(appId.configured).toBe(false);
    expect(appId.updatedAt).toBeNull();
  });

  it('坏密文行 ⇒ PayChannelStorageDisabledError（响亮，不静默——§2.3「不静默丢行」）', async () => {
    const db = new FakePayChannelDb();
    db.addRow('pay.channel.appId', { value_enc: 'v1:' + Buffer.alloc(40, 7).toString('base64') });
    const p = makeProbe(db);
    await expect(p.svc.status()).rejects.toBeInstanceOf(PayChannelStorageDisabledError);

    // 密键坏行同样响亮：status 对密键也解密（§3.2「逐行解密」）——坏密文的密键行必须抛 503；
    // 若实现只解非密行，本断言会绿（= 坏行被静默伪装成「已配置 ✓ 指纹 xxx」），故用密键**坏**行判别
    const db2 = new FakePayChannelDb();
    db2.addRow('pay.channel.privateKey', {
      value_enc: 'v1:' + Buffer.alloc(40, 8).toString('base64'), // 结构合法但 GCM 认证必败
      fingerprint: 'cafebabecafe',
    });
    await expect(makeProbe(db2).svc.status()).rejects.toBeInstanceOf(
      PayChannelStorageDisabledError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 7（续）：主钥缺 fail-closed（fresh 模块图）
 * ------------------------------------------------------------------ */

describe('pay-channel.service —— 主钥缺 fail-closed（§3.5）', () => {
  it('主钥未设：status/pull 一律拒（含空库——不给「看起来正常」的中间态）', async () => {
    const mod = await freshServiceModule('');
    const db = new FakePayChannelDb(); // 空库
    const p = makeProbe(db, { ctor: mod.PayChannelService });

    await expect(p.svc.status()).rejects.toBeInstanceOf(mod.PayChannelStorageDisabledError);
    await expect(p.svc.pull()).rejects.toBeInstanceOf(mod.PayChannelStorageDisabledError);
  });

  it('主钥未设：set 合法值也拒（存储不可用）且库零调用；clear 同拒', async () => {
    const mod = await freshServiceModule('');
    const db = new FakePayChannelDb();
    const p = makeProbe(db, { ctor: mod.PayChannelService });

    await expect(p.svc.set('pay.channel.gatewayUrl', GW_CANONICAL, 'alice')).rejects.toBeInstanceOf(
      mod.PayChannelStorageDisabledError,
    );
    await expect(p.svc.clear('pay.channel.gatewayUrl', 'alice')).rejects.toBeInstanceOf(
      mod.PayChannelStorageDisabledError,
    );
    expect(db.queries).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(0);
  });

  it('旧非密行密文损坏：重写时旧值解密失败 ⇒ PayChannelStorageDisabledError（不静默吞旧值、不重试）', async () => {
    const db = new FakePayChannelDb();
    db.addRow('pay.channel.gatewayUrl', {
      value_enc: 'v1:' + Buffer.alloc(40, 9).toString('base64'),
      fingerprint: 'cafebabecafe',
    });
    const p = makeProbe(db);

    await expect(
      p.svc.set('pay.channel.gatewayUrl', 'https://new.example.com', 'alice'),
    ).rejects.toBeInstanceOf(PayChannelStorageDisabledError);
    expect(p.txCalls()).toBe(1); // 解密失败非 1213 ⇒ 不重试
    expect(db.changes).toHaveLength(0); // 审计零行（不静默吞）
  });
});

/* ------------------------------------------------------------------ *
 * 6：1213 有界重试（U-2 捕获边界 = 整个事务）
 * ------------------------------------------------------------------ */

describe('pay-channel.service —— 1213 有界重试（§3.1 T-2/U-2）', () => {
  it('四种 1213 形态（errno/code/message/driverError 包装）：各恰重试一次 ⇒ 成功；重试路径重读旧值（审计恰一行 old=前值）', async () => {
    for (const shape of ['errno', 'code', 'message', 'wrapped'] as const) {
      const db = new FakePayChannelDb();
      seedRow(db, 'pay.channel.gatewayUrl', 'https://old.example.com');
      const p = makeProbe(db, { failures: [deadlockErr(shape)] });

      const res = await p.svc.set('pay.channel.gatewayUrl', 'https://new.example.com', 'alice');

      expect(p.txCalls(), shape).toBe(2); // 恰一次重试（第 1 次死锁 ⇒ 第 2 次成功）
      const inserts = changeInserts(db);
      expect(inserts, shape).toHaveLength(1); // 重试成功后**恰一**审计行
      expect(inserts[0]!.params[1], shape).toBe(JSON.stringify('https://old.example.com')); // old=前值（重读）
      expect(res.fingerprint, shape).toBe(fingerprintOf('https://new.example.com'));
    }
  });

  it('恰两次死锁（重试用满）⇒ 第 3 次尝试成功（总尝试 3 = 1+2）', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db, { failures: [deadlockErr('errno'), deadlockErr('errno')] });

    await expect(p.svc.set('pay.channel.gatewayUrl', GW_CANONICAL, 'alice')).resolves.toMatchObject({
      fingerprint: fingerprintOf(GW_CANONICAL),
    });
    expect(p.txCalls()).toBe(3);
    expect(changeInserts(db)).toHaveLength(1);
  });

  it('连抛 3 次 ⇒ 第 3 次仍抛出（总尝试恰 3）；零审计残留', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db, {
      failures: [deadlockErr('errno'), deadlockErr('code'), deadlockErr('message')],
    });

    // 第 3 次（message 形态）仍被识别为死锁、但重试额度用尽 ⇒ **原样抛出**（不吞、不再试）
    await expect(p.svc.set('pay.channel.gatewayUrl', GW_CANONICAL, 'alice')).rejects.toThrow(
      'Deadlock found when trying to get lock; try restarting transaction',
    );
    expect(p.txCalls()).toBe(3);
    expect(db.changes).toHaveLength(0);
    expect(db.rows.size).toBe(0); // 三次尝试都死在注入点（未触库）
  });

  it('非 1213 错误不重试：直接抛（恰一次事务调用）', async () => {
    const db = new FakePayChannelDb();
    const p = makeProbe(db, { failures: [new Error('connection reset by peer')] });

    await expect(p.svc.set('pay.channel.gatewayUrl', GW_CANONICAL, 'alice')).rejects.toThrow(
      'connection reset by peer',
    );
    expect(p.txCalls()).toBe(1);
    expect(db.changes).toHaveLength(0);
  });

  it('clear 同走有界重试：首击死锁 ⇒ 重试后成功恰一行审计', async () => {
    const db = new FakePayChannelDb();
    seedRow(db, 'pay.channel.gatewayUrl', GW_CANONICAL);
    const p = makeProbe(db, { failures: [deadlockErr('wrapped')] });

    await expect(p.svc.clear('pay.channel.gatewayUrl', 'alice')).resolves.toEqual({ existed: true });
    expect(p.txCalls()).toBe(2);
    expect(db.rows.has('pay.channel.gatewayUrl')).toBe(false);
    expect(changeInserts(db)).toHaveLength(1);
  });
});
