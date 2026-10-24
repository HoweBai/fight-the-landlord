import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { AD_CHANNEL_KEYS, type AdChannelKey } from '@fight-the-landlord/protocol';
import {
  AdChannelService,
  AdChannelStorageDisabledError,
  AdChannelValidationError,
  AD_CHANNEL_DELETE_SQL,
  AD_CHANNEL_LIST_SQL,
  AD_CHANNEL_LOCK_SQL,
  AD_CHANNEL_UPSERT_SQL,
} from '../src/ad-channel/ad-channel.service';
import { CONFIG_CHANGES_INSERT_SQL } from '../src/admin/admin-changes.service';
import { decrypt, encrypt, fingerprintOf } from '../src/ad-channel/ad-channel.crypto';
import {
  FakeAdChannelDb,
  SPEC_AD_CHANNEL_DELETE_SQL,
  SPEC_AD_CHANNEL_LIST_SQL,
  SPEC_AD_CHANNEL_LOCK_SQL,
  SPEC_AD_CHANNEL_UPSERT_SQL,
  type FakeAdChannelEm,
  type FakeAdChannelRow,
  type RecordedAdminQuery,
} from './helpers/config-probe';

/**
 * service 层单测（广告规格 §2.3 克隆先例：`pay-channel.service.ts` 形态，仅表名/键空间替换；
 * T6 交付物）。载体 = 假库 `FakeAdChannelDb`（**T7 起入 `test/helpers/config-probe.ts` 为唯一真源**
 * ——T6 曾自含 `test/ad-channel.probe.ts` 同构副本，T7 单向并轨后本文件 import 改指 helpers；
 * 同族取舍「假库不建模锁」⇒ 并发语义以 **1213 重试注入**验证）。
 *
 * 用例族（与克隆先例逐条对位）：
 *  1. 写事务三段序（锁 → UPSERT → 审计**同事务**；事务外通道零调用 = 「事务外无审计行」）；
 *  2. 审计形状（逐字 JSON 串）：**全键为密键** ⇒ redacted / 清空 new='null' / 首写 old=SQL NULL /
 *     无行 clear 不落审计；旧值指纹取**存储列**（旧密文无需解密）；
 *  3. `status()` 单项恒返回 + secret value 恒 null + 缺行 configured:false + epoch ms；
 *  4. `pull()` 仅已配置键（缺键不补；值 = canonical）；
 *  5. **实现常量 === 测试侧誊写（四条全文互钉）**；
 *  6. 1213 有界重试（四种形态各恰一次重试；连抛 3 次 ⇒ 抛；非 1213 不重试）；
 *  7. 校验失败**先于一切库操作**（库零调用）；主钥缺 fail-closed（set/clear/status/pull 一致拒）。
 *
 * ⚠️ 主钥用例走 `vi.resetModules()` + 动态 import 取**全新模块图**（crypto 的进程缓存使
 * 「未设主钥」在既有实例上不可达——同 `ad-channel.crypto.test.ts` 的 freshCrypto 形态）。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')（主钥复用支付片）。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

/** 本键空间唯一键（⚙️1 单一真源 `AD_CHANNEL_KEYS`；类型谓词即收窄点）。 */
const KEY: AdChannelKey = 'ad.callbackSecret';

/** 合法 canonical（占位规则 = 非空字符串 ≤512；T0-2 后随密钥形态收严）。 */
const SECRET_CANONICAL = 'uniad-callback-secret-canonical-001';
const SECRET_NEW_CANONICAL = 'uniad-callback-secret-canonical-002';

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

interface AdChannelProbe {
  svc: AdChannelService;
  db: FakeAdChannelDb;
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
  db: FakeAdChannelDb,
  opts: { ctor?: typeof AdChannelService; failures?: unknown[] } = {},
): AdChannelProbe {
  const Ctor = opts.ctor ?? AdChannelService;
  const failures = opts.failures ?? [];
  const outer: RecordedAdminQuery[] = [];
  let txCalls = 0;
  let failIdx = 0;
  const ds = {
    query: (sql: string, params: unknown[] = []) => {
      outer.push({ sql, params });
      return db.dataSource.query(sql, params);
    },
    transaction: <T,>(cb: (em: FakeAdChannelEm) => Promise<T>): Promise<T> => {
      txCalls += 1;
      if (failIdx < failures.length) return Promise.reject(failures[failIdx++]);
      return db.dataSource.transaction(cb);
    },
  };
  return { svc: new Ctor(ds as unknown as DataSource), db, outer, txCalls: () => txCalls };
}

/** 直插一行「真实」数据：密文可解 + 指纹 = canonical 指纹（= set 路径会落的样子）。 */
function seedRow(
  db: FakeAdChannelDb,
  canonical: string,
  over: Partial<FakeAdChannelRow> = {},
): FakeAdChannelRow {
  return db.addRow(KEY, {
    value_enc: encrypt(KEY, canonical),
    fingerprint: fingerprintOf(canonical),
    updated_by: 'seed',
    ...over,
  });
}

/** 审计留痕的 INSERT 参数（`[key, old, new, actor]`，**原始绑定值**——JSON 串断言在此逐字）。 */
function changeInserts(db: FakeAdChannelDb): RecordedAdminQuery[] {
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
  return import('../src/ad-channel/ad-channel.service');
}

/* ------------------------------------------------------------------ *
 * 1/5：常量互钉 + 校验先于库操作
 * ------------------------------------------------------------------ */

describe('ad-channel.service —— 常量互钉与校验前置（克隆先例 §2.2 / 校验先于一切）', () => {
  it('实现四条 SQL 常量 === 测试侧誊写（全文互钉；漂移 ⇒ 当场红）', () => {
    expect(AD_CHANNEL_LOCK_SQL).toBe(SPEC_AD_CHANNEL_LOCK_SQL);
    expect(AD_CHANNEL_UPSERT_SQL).toBe(SPEC_AD_CHANNEL_UPSERT_SQL);
    expect(AD_CHANNEL_LIST_SQL).toBe(SPEC_AD_CHANNEL_LIST_SQL);
    expect(AD_CHANNEL_DELETE_SQL).toBe(SPEC_AD_CHANNEL_DELETE_SQL);
  });

  it('校验失败先于一切库操作：空串/超长/未知键 ⇒ AdChannelValidationError 且库零调用', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db);

    await expect(p.svc.set(KEY, '', 'alice')).rejects.toBeInstanceOf(AdChannelValidationError);
    // reason 原样透出（controller 作 400 message）、不含输入值（§2.9 纪律——用标记串自证）
    await expect(p.svc.set(KEY, 'ZZMARKERZZ' + 'a'.repeat(600), 'alice')).rejects.toMatchObject({
      reason: '长度超过上限 512',
    });
    const badErr = await p.svc
      .set(KEY, 'ZZMARKERZZ' + 'a'.repeat(600), 'alice')
      .then(() => null, (e: unknown) => e);
    expect(String((badErr as AdChannelValidationError).reason)).not.toContain('ZZMARKERZZ');
    // 未知键（运行时形态）：validateAndNormalize 的 default 分支兜底 ⇒ 400 候选（controller 注册表之外仍拒）
    await expect(
      p.svc.set('ad.nope' as unknown as AdChannelKey, 'anything', 'alice'),
    ).rejects.toMatchObject({ reason: '未知键' });

    expect(db.queries).toHaveLength(0); // 库零调用（连锁定读都不发生）
    expect(db.changes).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2：写路径三段序 + 审计形状（全键密键）
 * ------------------------------------------------------------------ */

describe('ad-channel.service —— 写事务三段序（克隆先例 §3.1）', () => {
  it('锁 → UPSERT → 审计：三句同事务（事务外零库操作）、顺序恰如此、密文落库可解回 canonical', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db);

    const t0 = Date.now();
    const res = await p.svc.set(KEY, SECRET_CANONICAL, 'alice');

    // 「同事务」的观测面：三句全走事务内 EM（事务外通道一次都没被碰——审计不可能在事务外落）
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(1);
    expect(db.queries.map((q) => q.sql)).toEqual([
      SPEC_AD_CHANNEL_LOCK_SQL,
      SPEC_AD_CHANNEL_UPSERT_SQL,
      CONFIG_CHANGES_INSERT_SQL,
    ]);

    // UPSERT 参数：key / 密文（非明文）/ 指纹 / actor
    const upsert = db.queries[1]!;
    expect(upsert.params[0]).toBe(KEY);
    expect(String(upsert.params[1]).startsWith('v1:')).toBe(true);
    expect(String(upsert.params[1])).not.toContain('uniad-callback-secret');
    expect(upsert.params[2]).toBe(fingerprintOf(SECRET_CANONICAL));
    expect(upsert.params[3]).toBe('alice');

    // 落库行：密文可解回 canonical；审计行恰一（old=SQL NULL 首写、new=redacted 新指纹）
    const stored = db.rows.get(KEY)!;
    expect(decrypt(KEY, stored.value_enc)).toBe(SECRET_CANONICAL);
    expect(db.changes).toEqual([
      {
        key: KEY,
        oldValue: null,
        newValue: { redacted: true, fingerprint: fingerprintOf(SECRET_CANONICAL) },
        actor: 'alice',
      },
    ]);

    // 返回值 {fingerprint, updatedAt}（updatedAt = 提交当刻 epoch ms）
    expect(res.fingerprint).toBe(fingerprintOf(SECRET_CANONICAL));
    expect(res.updatedAt).toBeGreaterThanOrEqual(t0);
    expect(res.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('密键审计 = {"redacted":true,"fingerprint":"<12hex>"}；首写 old_value 传 SQL NULL（两列两形态之一）', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db);

    await p.svc.set(KEY, SECRET_CANONICAL, 'alice');

    const inserts = changeInserts(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params).toEqual([
      KEY,
      null, // 首写/无旧行 ⇒ old_value 传 SQL NULL（绑定 null；与清空 new='null' 是分开钉的两种形态）
      `{"redacted":true,"fingerprint":"${fingerprintOf(SECRET_CANONICAL)}"}`, // 密键 = redacted（**原始绑定串**）
      'alice',
    ]);
  });

  it('覆盖写：old = redacted 旧指纹（取**存储列**、无需解密旧密文——旧行故意不可解密钉此性质）', async () => {
    const db = new FakeAdChannelDb();
    // 旧行 value_enc 故意不可解密：密键 old 只用**存储指纹**——此断言钉住该性质
    db.addRow(KEY, {
      value_enc: 'v1:not-needed-for-secret-old',
      fingerprint: 'cafebabecafe',
      updated_by: 'seed',
    });
    const p = makeProbe(db);

    const res = await p.svc.set(KEY, SECRET_NEW_CANONICAL, 'bob');
    expect(res.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const inserts = changeInserts(db);
    expect(inserts).toHaveLength(1);
    const [, oldParam, newParam] = inserts[0]!.params as [string, string, string, string];
    expect(oldParam).toBe('{"redacted":true,"fingerprint":"cafebabecafe"}'); // 旧指纹（存储列）
    expect(newParam).toBe(`{"redacted":true,"fingerprint":"${res.fingerprint}"}`); // 新指纹（逐字字符串）
    // 密文/明文两形态都不得出现在任何审计参数（密键支路：明文 canonical、`v1:` 密文均不得漏）
    for (const param of inserts[0]!.params) {
      expect(String(param)).not.toContain(SECRET_NEW_CANONICAL);
      expect(String(param)).not.toContain('v1:');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2/4：clear（清空）与 pull（拉取）
 * ------------------------------------------------------------------ */

describe('ad-channel.service —— 清空（克隆先例 §3.1）', () => {
  it('锁 → DELETE → 审计同事务；old = redacted 旧指纹、new = JSON 字符串 \'null\'（⚙️17 之二）', async () => {
    const db = new FakeAdChannelDb();
    seedRow(db, SECRET_CANONICAL);
    const p = makeProbe(db);

    await expect(p.svc.clear(KEY, 'alice')).resolves.toEqual({ existed: true });

    expect(p.outer).toHaveLength(0); // 三段同事务
    expect(db.queries.map((q) => q.sql)).toEqual([
      SPEC_AD_CHANNEL_LOCK_SQL,
      SPEC_AD_CHANNEL_DELETE_SQL,
      CONFIG_CHANGES_INSERT_SQL,
    ]);
    expect(db.rows.has(KEY)).toBe(false);
    expect(changeInserts(db)[0]!.params).toEqual([
      KEY,
      `{"redacted":true,"fingerprint":"${fingerprintOf(SECRET_CANONICAL)}"}`,
      'null', // 清空 new_value 传 JSON 字符串 'null'（SQL NULL 会被 NOT NULL 以 1048 拒）
      'alice',
    ]);
  });

  it('无行清空：existed:false、不落审计、不发 DELETE（幂等）', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db);

    await expect(p.svc.clear(KEY, 'alice')).resolves.toEqual({ existed: false });

    expect(changeInserts(db)).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
    expect(db.queries.some((q) => q.sql === SPEC_AD_CHANNEL_DELETE_SQL)).toBe(false);
  });
});

describe('ad-channel.service —— pull（克隆先例 §2.5）', () => {
  it('已配置 ⇒ {键: canonical}（密键值 = 存储 canonical 逐字）；缺失 ⇒ 缺键不补', async () => {
    const db = new FakeAdChannelDb();
    seedRow(db, SECRET_CANONICAL);
    const p = makeProbe(db);

    await expect(p.svc.pull()).resolves.toEqual({ [KEY]: SECRET_CANONICAL });
  });

  it('空库 ⇒ {}（不补默认）', async () => {
    const p = makeProbe(new FakeAdChannelDb());
    await expect(p.svc.pull()).resolves.toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * 3：status（管理读）
 * ------------------------------------------------------------------ */

describe('ad-channel.service —— status（掩码读；克隆先例 §2.4 项形状）', () => {
  it('空库：单项按 AD_CHANNEL_KEYS 固定序、configured:false、label 逐字、secret:true', async () => {
    const p = makeProbe(new FakeAdChannelDb());
    const items = await p.svc.status();

    expect(items.map((i) => i.key)).toEqual([...AD_CHANNEL_KEYS]);
    expect(items.map((i) => i.label)).toEqual(['回调密钥']);
    expect(items.map((i) => i.secret)).toEqual([true]);
    for (const item of items) {
      expect(item).toEqual({
        key: item.key,
        label: '回调密钥',
        secret: true,
        configured: false,
        value: null,
        fingerprint: null,
        updatedAt: null,
        updatedBy: null,
      });
    }
  });

  it('已配置：secret 键 value 恒 null（掩码写）、只给指纹、updatedAt = epoch ms（⚙️1 仓例）', async () => {
    const db = new FakeAdChannelDb();
    db.now = new Date('2026-10-12T08:00:00.000Z');
    seedRow(db, SECRET_CANONICAL);
    const p = makeProbe(db);

    const items = await p.svc.status();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      key: KEY,
      label: '回调密钥',
      secret: true,
      configured: true,
      value: null, // 🔴 secret 键 value 恒 null（掩码写；P8 掩码读面）
      fingerprint: fingerprintOf(SECRET_CANONICAL),
      updatedAt: Date.parse('2026-10-12T08:00:00.000Z'),
      updatedBy: 'seed',
    });
  });

  it('坏密文行 ⇒ AdChannelStorageDisabledError（响亮，不静默——「不静默丢行」）', async () => {
    const db = new FakeAdChannelDb();
    db.addRow(KEY, { value_enc: 'v1:' + Buffer.alloc(40, 7).toString('base64') }); // 结构合法但 GCM 认证必败
    await expect(makeProbe(db).svc.status()).rejects.toBeInstanceOf(AdChannelStorageDisabledError);

    // 前缀坏（格式非法支路）同样响亮
    const db2 = new FakeAdChannelDb();
    db2.addRow(KEY, { value_enc: 'v2:' + Buffer.alloc(40, 8).toString('base64') });
    await expect(makeProbe(db2).svc.status()).rejects.toBeInstanceOf(AdChannelStorageDisabledError);
  });
});

/* ------------------------------------------------------------------ *
 * 7（续）：主钥缺 fail-closed（fresh 模块图）
 * ------------------------------------------------------------------ */

describe('ad-channel.service —— 主钥缺 fail-closed（克隆先例 §3.5 精神）', () => {
  it('主钥未设：status/pull 一律拒（含空库——不给「看起来正常」的中间态）', async () => {
    const mod = await freshServiceModule('');
    const db = new FakeAdChannelDb(); // 空库
    const p = makeProbe(db, { ctor: mod.AdChannelService });

    await expect(p.svc.status()).rejects.toBeInstanceOf(mod.AdChannelStorageDisabledError);
    await expect(p.svc.pull()).rejects.toBeInstanceOf(mod.AdChannelStorageDisabledError);
  });

  it('主钥未设：set 合法值也拒（存储不可用）且库零调用；clear 同拒', async () => {
    const mod = await freshServiceModule('');
    const db = new FakeAdChannelDb();
    const p = makeProbe(db, { ctor: mod.AdChannelService });

    await expect(p.svc.set(KEY, SECRET_CANONICAL, 'alice')).rejects.toBeInstanceOf(
      mod.AdChannelStorageDisabledError,
    );
    await expect(p.svc.clear(KEY, 'alice')).rejects.toBeInstanceOf(mod.AdChannelStorageDisabledError);
    expect(db.queries).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(0);
  });

  it('主钥缺的 503 文案（默认 message）= crypto 逐字文案（管理面可透传）', async () => {
    const mod = await freshServiceModule('');
    const db = new FakeAdChannelDb();
    const p = makeProbe(db, { ctor: mod.AdChannelService });

    await expect(p.svc.status()).rejects.toThrow('广告回调密钥存储未启用（缺主钥）');
  });
});

/* ------------------------------------------------------------------ *
 * 6：1213 有界重试（捕获边界 = 整个事务）
 * ------------------------------------------------------------------ */

describe('ad-channel.service —— 1213 有界重试（克隆先例 T-2/U-2）', () => {
  it('四种 1213 形态（errno/code/message/driverError 包装）：各恰重试一次 ⇒ 成功；重试路径重读旧值（审计恰一行 old=前指纹）', async () => {
    for (const shape of ['errno', 'code', 'message', 'wrapped'] as const) {
      const db = new FakeAdChannelDb();
      seedRow(db, SECRET_CANONICAL);
      const p = makeProbe(db, { failures: [deadlockErr(shape)] });

      const res = await p.svc.set(KEY, SECRET_NEW_CANONICAL, 'alice');

      expect(p.txCalls(), shape).toBe(2); // 恰一次重试（第 1 次死锁 ⇒ 第 2 次成功）
      const inserts = changeInserts(db);
      expect(inserts, shape).toHaveLength(1); // 重试成功后**恰一**审计行
      expect(inserts[0]!.params[1], shape).toBe(
        `{"redacted":true,"fingerprint":"${fingerprintOf(SECRET_CANONICAL)}"}`, // old=前值（重读锁定行）
      );
      expect(res.fingerprint, shape).toBe(fingerprintOf(SECRET_NEW_CANONICAL));
    }
  });

  it('恰两次死锁（重试用满）⇒ 第 3 次尝试成功（总尝试 3 = 1+2）', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db, { failures: [deadlockErr('errno'), deadlockErr('errno')] });

    await expect(p.svc.set(KEY, SECRET_CANONICAL, 'alice')).resolves.toMatchObject({
      fingerprint: fingerprintOf(SECRET_CANONICAL),
    });
    expect(p.txCalls()).toBe(3);
    expect(changeInserts(db)).toHaveLength(1);
  });

  it('连抛 3 次 ⇒ 第 3 次仍抛出（总尝试恰 3）；零审计残留', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db, {
      failures: [deadlockErr('errno'), deadlockErr('code'), deadlockErr('message')],
    });

    // 第 3 次（message 形态）仍被识别为死锁、但重试额度用尽 ⇒ **原样抛出**（不吞、不再试）
    await expect(p.svc.set(KEY, SECRET_CANONICAL, 'alice')).rejects.toThrow(
      'Deadlock found when trying to get lock; try restarting transaction',
    );
    expect(p.txCalls()).toBe(3);
    expect(db.changes).toHaveLength(0);
    expect(db.rows.size).toBe(0); // 三次尝试都死在注入点（未触库）
  });

  it('非 1213 错误不重试：直接抛（恰一次事务调用）', async () => {
    const db = new FakeAdChannelDb();
    const p = makeProbe(db, { failures: [new Error('connection reset by peer')] });

    await expect(p.svc.set(KEY, SECRET_CANONICAL, 'alice')).rejects.toThrow(
      'connection reset by peer',
    );
    expect(p.txCalls()).toBe(1);
    expect(db.changes).toHaveLength(0);
  });

  it('clear 同走有界重试：首击死锁 ⇒ 重试后成功恰一行审计', async () => {
    const db = new FakeAdChannelDb();
    seedRow(db, SECRET_CANONICAL);
    const p = makeProbe(db, { failures: [deadlockErr('wrapped')] });

    await expect(p.svc.clear(KEY, 'alice')).resolves.toEqual({ existed: true });
    expect(p.txCalls()).toBe(2);
    expect(db.rows.has(KEY)).toBe(false);
    expect(changeInserts(db)).toHaveLength(1);
  });

  it('旧行密文损坏：重写时旧值解密失败 ⇒ 不静默吞（本空间全密键 ⇒ 旧值取存储指纹、**不触发解密**；坏整串下 set 仍成功且审计无明文）', async () => {
    // 全密键空间的语义钉：旧值支路永不解密旧密文（指纹 = 存储列）⇒ 「旧行密文损坏」不阻断重写。
    const db = new FakeAdChannelDb();
    db.addRow(KEY, { value_enc: 'v1:' + Buffer.alloc(40, 9).toString('base64'), fingerprint: 'deadbeefcafe' });
    const p = makeProbe(db);

    await expect(p.svc.set(KEY, SECRET_NEW_CANONICAL, 'alice')).resolves.toMatchObject({
      fingerprint: fingerprintOf(SECRET_NEW_CANONICAL),
    });
    expect(p.txCalls()).toBe(1);
    expect(changeInserts(db)[0]!.params[1]).toBe('{"redacted":true,"fingerprint":"deadbeefcafe"}');
  });
});
