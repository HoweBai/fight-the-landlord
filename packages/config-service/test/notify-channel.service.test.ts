import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { NOTIFY_CHANNEL_KEYS, type NotifyChannelKey } from '@fight-the-landlord/protocol';
import {
  NotifyChannelService,
  NotifyChannelStorageDisabledError,
  NotifyChannelValidationError,
  NOTIFY_CHANNEL_DELETE_SQL,
  NOTIFY_CHANNEL_LIST_SQL,
  NOTIFY_CHANNEL_LOCK_SQL,
  NOTIFY_CHANNEL_UPSERT_SQL,
} from '../src/notify-channel/notify-channel.service';
import { NOTIFY_CHANNEL_GAUGE_SQL } from '../src/notify-channel/notify-channel.metrics';
import { CONFIG_CHANGES_INSERT_SQL } from '../src/admin/admin-changes.service';
import { decrypt, encrypt, fingerprintOf } from '../src/notify-channel/notify-channel.crypto';
import {
  FakeNotifyChannelDb,
  SPEC_NOTIFY_CHANNEL_DELETE_SQL,
  SPEC_NOTIFY_CHANNEL_LIST_SQL,
  SPEC_NOTIFY_CHANNEL_LOCK_SQL,
  SPEC_NOTIFY_CHANNEL_UPSERT_SQL,
  type FakeNotifyChannelEm,
  type FakeNotifyChannelRow,
  type RecordedAdminQuery,
} from './helpers/config-probe';

/**
 * service 层单测（规格 §5.1-3；T5 交付物）。载体 = 假库 `FakeNotifyChannelDb`（T2 交付；
 * 「假库不建模锁」⇒ 并发语义以 **1213 重试注入**验证）。结构逐字同构
 * `pay-channel.service.test.ts`，两处**有意差异**（写在这里防误读）：
 *
 *  1. ⚙️17 的 gauge 刷新进入写路径 ⇒ 写事务成功后**事务外恰有一条**库调用
 *     （`NOTIFY_CHANNEL_GAUGE_SQL` 的只键 SELECT）。假库不认识它（T2 只誊写四条 §2.2 SQL）
 *     ⇒ 该读**当场失败**，但 `refreshNotifyGauges` 内部自吞（⚙️17「读失败 ⇒ 保持旧值 + WARN」）
 *     ——本文件因此同时**顺带钉住**「gauge 读失败不打穿写响应」；gauge 值的正路断言在
 *     `notify-channel.metrics.test.ts`（专门夹具喂 gauge SQL）。「事务外零库操作」的判据
 *     本文件改形为：**事务外唯一调用 = 提交后的 gauge 读**，锁/UPSERT/审计三句零出现在事务外。
 *  2. `status()` 项形状含 `hint`（§2.4）；URL 三键（同为密键）逐格钉 hint。
 *
 * 用例族（与 §5.1-3 逐条对位）：
 *  1. 写事务三段序（锁 → UPSERT → 审计**同事务**）+ ⚙️17 刷新点在**提交后**（顺序观测面）；
 *  2. 审计形状（§3.1 逐字 JSON 串）：密键 redacted / 非密 JSON 串 / 清空 new='null' / 无行 clear 不落审计；
 *  3. `status()` 九项固定序 + 密键 value 恒 null + URL 三键 hint 逐格 + epoch ms；
 *  4. `pull()` 仅已配置键（缺键不补；密键含值）；
 *  5. **实现常量 === 测试侧誊写（四条全文互钉）**；
 *  6. 1213 有界重试（四种形态各恰一次重试；连抛 3 次 ⇒ 抛；非 1213 不重试；失败不刷新 gauge）；
 *  7. 校验失败**先于一切库操作**；主钥缺 fail-closed（四方法一致拒）+ **观测序（400 先于 503）**。
 *
 * ⚠️ 主钥用例走 `vi.resetModules()` + 动态 import 取**全新模块图**（crypto 的进程缓存使
 * 「未设主钥」在既有实例上不可达——同 `pay-channel.service.test.ts` 的 fresh 形态）。
 * ⚠️ `Logger.prototype.warn` 全程静音（gauge 读失败与 1213 重试都会产生 WARN——各自的正路
 * 断言在 `notify-channel.metrics.test.ts` / 本文件的行为断言里，此处不重复）。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')（复用既有供给链）。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

/* 九键夹具（值全部落在 example 域/stub 语义内；密键五：pass + 三 URL + dingtalkSecret）。 */
const HOST = 'smtp.example.com';
const PASS = 'super-secret-pass';
const TO = 'ops@example.com,oncall@example.com';
const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz-789';
const DINGTALK_SECRET = 'SEC1234567890abcdef';

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64; // 主钥用例（fresh 模块）后复位
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/* ------------------------------------------------------------------ *
 * 探针：假库 + 双通道观测（事务外 / 事务）
 * ------------------------------------------------------------------ */

interface NotifyChannelProbe {
  svc: NotifyChannelService;
  db: FakeNotifyChannelDb;
  /** **事务外**通道（`dataSource.query`）观测面——写成功后应恰含一条 gauge 读。 */
  outer: RecordedAdminQuery[];
  /** `dataSource.transaction()` 调用次数（重试断言：1 = 无重试；2/3 = 重试次数+1）。 */
  txCalls: () => number;
}

/**
 * 假库 + 计数包装：`transaction` 前 N 次按 `failures` 注入失败（模拟 1213 死锁/任意错误），
 * 其后委托假库。`ctor` 缺省 = 静态导入的类；fresh 模块用例传动态 import 的类（instanceof 对位）。
 */
function makeProbe(
  db: FakeNotifyChannelDb,
  opts: { ctor?: typeof NotifyChannelService; failures?: unknown[] } = {},
): NotifyChannelProbe {
  const Ctor = opts.ctor ?? NotifyChannelService;
  const failures = opts.failures ?? [];
  const outer: RecordedAdminQuery[] = [];
  let txCalls = 0;
  let failIdx = 0;
  const ds = {
    query: (sql: string, params: unknown[] = []) => {
      outer.push({ sql, params });
      return db.dataSource.query(sql, params);
    },
    transaction: <T,>(cb: (em: FakeNotifyChannelEm) => Promise<T>): Promise<T> => {
      txCalls += 1;
      if (failIdx < failures.length) return Promise.reject(failures[failIdx++]);
      return db.dataSource.transaction(cb);
    },
  };
  return { svc: new Ctor(ds as unknown as DataSource), db, outer, txCalls: () => txCalls };
}

/** 直插一行「真实」数据：密文可解 + 指纹 = canonical 指纹（= set 路径会落的样子）。 */
function seedRow(
  db: FakeNotifyChannelDb,
  key: NotifyChannelKey,
  canonical: string,
  over: Partial<FakeNotifyChannelRow> = {},
): FakeNotifyChannelRow {
  return db.addRow(key, {
    value_enc: encrypt(key, canonical),
    fingerprint: fingerprintOf(canonical),
    updated_by: 'seed',
    ...over,
  });
}

/** 审计留痕的 INSERT 参数（`[key, old, new, actor]`，**原始绑定值**——JSON 串断言在此逐字）。 */
function changeInserts(db: FakeNotifyChannelDb): RecordedAdminQuery[] {
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
  return import('../src/notify-channel/notify-channel.service');
}

/* ------------------------------------------------------------------ *
 * 1/5：常量互钉 + 校验先于库操作
 * ------------------------------------------------------------------ */

describe('notify-channel.service —— 常量互钉与校验前置（§2.2 / §3.1 校验先于一切）', () => {
  it('实现四条 SQL 常量 === 测试侧誊写（全文互钉；漂移 ⇒ 当场红）', () => {
    expect(NOTIFY_CHANNEL_LOCK_SQL).toBe(SPEC_NOTIFY_CHANNEL_LOCK_SQL);
    expect(NOTIFY_CHANNEL_UPSERT_SQL).toBe(SPEC_NOTIFY_CHANNEL_UPSERT_SQL);
    expect(NOTIFY_CHANNEL_LIST_SQL).toBe(SPEC_NOTIFY_CHANNEL_LIST_SQL);
    expect(NOTIFY_CHANNEL_DELETE_SQL).toBe(SPEC_NOTIFY_CHANNEL_DELETE_SQL);
  });

  it('校验失败先于一切库操作：空串/坏 host/未知键 ⇒ NotifyChannelValidationError 且库零调用', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db);

    await expect(p.svc.set('notify.smtp.host', '', 'alice')).rejects.toBeInstanceOf(
      NotifyChannelValidationError,
    );
    // reason 原样透出（T6 作 400 message）、不含输入值（§2.9——用标记串自证）
    await expect(
      p.svc.set('notify.smtp.host', 'bad host ZZMARKERZZ', 'alice'),
    ).rejects.toMatchObject({ reason: '必须是合法主机名（字母/数字/点/横线）' });
    const badErr = await p.svc
      .set('notify.webhook.wecomUrl', 'not-a-url-ZZMARKERZZ', 'alice')
      .then(() => null, (e: unknown) => e);
    expect(String((badErr as NotifyChannelValidationError).reason)).not.toContain('ZZMARKERZZ');
    // 未知键（运行时形态）：validateAndNormalize 的 default 分支兜底 ⇒ 400 候选（T6 注册表之外仍拒）
    await expect(
      p.svc.set('notify.nope' as unknown as NotifyChannelKey, 'smtp.example.com', 'alice'),
    ).rejects.toMatchObject({ reason: '未知键' });

    expect(db.queries).toHaveLength(0); // 库零调用（连锁定读都不发生）
    expect(db.changes).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2：写路径三段序 + ⚙️17 刷新点 + 审计形状
 * ------------------------------------------------------------------ */

describe('notify-channel.service —— 写事务三段序与 ⚙️17 刷新点（§3.1）', () => {
  it('锁 → UPSERT → 审计三句同事务；事务外唯一调用 = 提交后的 gauge 只键读；密文落库可解回 canonical', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db);

    const t0 = Date.now();
    const res = await p.svc.set('notify.smtp.host', HOST, 'alice');

    // 「同事务」的观测面：三句全走事务内 EM；事务外通道恰有 ⚙️17 的一条 gauge 读（**在提交之后**——
    // 顺序判据 = 第四条；锁/UPSERT/审计零出现在事务外 ⇒ 审计不可能在事务外落）
    expect(p.outer).toEqual([{ sql: NOTIFY_CHANNEL_GAUGE_SQL, params: [] }]);
    expect(p.outer.some((q) => q.sql === CONFIG_CHANGES_INSERT_SQL)).toBe(false);
    expect(p.txCalls()).toBe(1);
    expect(db.queries.map((q) => q.sql)).toEqual([
      SPEC_NOTIFY_CHANNEL_LOCK_SQL,
      SPEC_NOTIFY_CHANNEL_UPSERT_SQL,
      CONFIG_CHANGES_INSERT_SQL,
      NOTIFY_CHANNEL_GAUGE_SQL,
    ]);
    // 假库不认识 gauge SQL（T2 只誊写四条）⇒ 该读当场失败，但 set 照常成功——本断言顺带钉住
    // ⚙️17「读失败 ⇒（内部自吞）不打穿写响应」的 service 级观测面。

    // UPSERT 参数：key / 密文（非明文）/ 指纹 / actor
    const upsert = db.queries[1]!;
    expect(upsert.params[0]).toBe('notify.smtp.host');
    expect(String(upsert.params[1]).startsWith('v1:')).toBe(true);
    expect(String(upsert.params[1])).not.toContain('smtp.example.com');
    expect(upsert.params[2]).toBe(fingerprintOf(HOST));
    expect(upsert.params[3]).toBe('alice');

    // 落库行：密文可解回 canonical；审计行恰一（old=SQL NULL 首写、new=JSON 字符串原文）
    const stored = db.rows.get('notify.smtp.host')!;
    expect(decrypt('notify.smtp.host', stored.value_enc)).toBe(HOST);
    expect(db.changes).toEqual([
      { key: 'notify.smtp.host', oldValue: null, newValue: HOST, actor: 'alice' },
    ]);

    // 返回值 {fingerprint, updatedAt}（updatedAt = 提交当刻 epoch ms）
    expect(res.fingerprint).toBe(fingerprintOf(HOST));
    expect(res.updatedAt).toBeGreaterThanOrEqual(t0);
    expect(res.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('非密键审计 = JSON 字符串原文；首写 old_value 传 SQL NULL（§3.1 首写形态）', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db);
    await p.svc.set('notify.email.to', TO, 'alice');

    const inserts = changeInserts(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params).toEqual([
      'notify.email.to',
      null, // §3.1：首写/无旧行 ⇒ old_value 传 SQL NULL（绑定 null）
      JSON.stringify(TO), // 非密 = JSON 字符串（canonical 逐项逗号连接）
      'alice',
    ]);
  });

  it('非密键覆盖写：old = 旧明文 JSON 串（锁定读解密）；重写不碰其它键', async () => {
    const db = new FakeNotifyChannelDb();
    seedRow(db, 'notify.smtp.host', 'smtp.old.example.com');
    seedRow(db, 'notify.email.to', TO);
    const p = makeProbe(db);

    await p.svc.set('notify.smtp.host', HOST, 'bob');

    const inserts = changeInserts(db);
    expect(inserts[0]!.params).toEqual([
      'notify.smtp.host',
      JSON.stringify('smtp.old.example.com'),
      JSON.stringify(HOST),
      'bob',
    ]);
    expect(db.rows.get('notify.email.to')!.updated_by).toBe('seed'); // 其它键未动
  });

  it('密键审计 = {"redacted":true,"fingerprint":"<12hex>"}（§3.1；URL 键同密）；明文/密文片段不出现在任何审计参数', async () => {
    const db = new FakeNotifyChannelDb();
    // 旧行 value_enc 故意不可解密：密键 old 只用**存储指纹**（无需解密）——此断言钉住该性质
    db.addRow('notify.smtp.pass', {
      value_enc: 'v1:not-needed-for-secret-old',
      fingerprint: 'cafebabecafe',
      updated_by: 'seed',
    });
    const p = makeProbe(db);

    const res = await p.svc.set('notify.smtp.pass', PASS, 'alice');
    expect(res.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const inserts = changeInserts(db);
    expect(inserts).toHaveLength(1);
    const [, oldParam, newParam] = inserts[0]!.params as [string, string, string, string];
    expect(oldParam).toBe('{"redacted":true,"fingerprint":"cafebabecafe"}'); // 旧指纹（存储列）
    expect(newParam).toBe(`{"redacted":true,"fingerprint":"${res.fingerprint}"}`); // 新指纹（逐字字符串）
    // 明文/密文两形态都不得出现
    for (const param of inserts[0]!.params) {
      expect(String(param)).not.toContain(PASS);
      expect(String(param)).not.toContain('v1:');
    }
  });

  it('URL 三键同为密键：审计 redacted（新指纹）、落库密文可解回 canonical 逐字（含查询串）', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db);

    await p.svc.set('notify.webhook.wecomUrl', WECOM, 'alice');

    expect(changeInserts(db)[0]!.params[2]).toBe(
      `{"redacted":true,"fingerprint":"${fingerprintOf(WECOM)}"}`,
    );
    expect(decrypt('notify.webhook.wecomUrl', db.rows.get('notify.webhook.wecomUrl')!.value_enc)).toBe(
      WECOM, // canonical 逐字保真（唯一变换 = trim；URL 不改写，§2.3）
    );
  });
});

/* ------------------------------------------------------------------ *
 * 2/4：clear（清空）与 pull（拉取）
 * ------------------------------------------------------------------ */

describe('notify-channel.service —— 清空（§3.1）', () => {
  it('非密键：锁 → DELETE → 审计同事务；old = 旧明文 JSON 串、new = JSON 字符串 \'null\'（§3.1 清空形态）', async () => {
    const db = new FakeNotifyChannelDb();
    seedRow(db, 'notify.smtp.host', HOST);
    const p = makeProbe(db);

    await expect(p.svc.clear('notify.smtp.host', 'alice')).resolves.toEqual({ existed: true });

    expect(p.outer).toEqual([{ sql: NOTIFY_CHANNEL_GAUGE_SQL, params: [] }]); // ⚙️17：clear 事务成功后同样刷新
    expect(db.queries.map((q) => q.sql)).toEqual([
      SPEC_NOTIFY_CHANNEL_LOCK_SQL,
      SPEC_NOTIFY_CHANNEL_DELETE_SQL,
      CONFIG_CHANGES_INSERT_SQL,
      NOTIFY_CHANNEL_GAUGE_SQL,
    ]);
    expect(db.rows.has('notify.smtp.host')).toBe(false);
    expect(changeInserts(db)[0]!.params).toEqual([
      'notify.smtp.host',
      JSON.stringify(HOST),
      'null', // §3.1：清空 new_value 传 JSON 字符串 'null'（SQL NULL 会被 NOT NULL 以 1048 拒）
      'alice',
    ]);
  });

  it('密键：old = redacted 旧指纹、new = \'null\'；行删除', async () => {
    const db = new FakeNotifyChannelDb();
    db.addRow('notify.webhook.dingtalkSecret', {
      value_enc: encrypt('notify.webhook.dingtalkSecret', DINGTALK_SECRET),
      fingerprint: 'cafebabecafe',
    });
    const p = makeProbe(db);

    await expect(p.svc.clear('notify.webhook.dingtalkSecret', 'bob')).resolves.toEqual({
      existed: true,
    });

    expect(db.rows.has('notify.webhook.dingtalkSecret')).toBe(false);
    expect(changeInserts(db)[0]!.params).toEqual([
      'notify.webhook.dingtalkSecret',
      '{"redacted":true,"fingerprint":"cafebabecafe"}',
      'null',
      'bob',
    ]);
  });

  it('无行清空：existed:false、不落审计、不发 DELETE（幂等）；gauge 刷新照走（口径统一）', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db);

    await expect(p.svc.clear('notify.email.to', 'alice')).resolves.toEqual({ existed: false });

    expect(changeInserts(db)).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
    expect(db.queries.some((q) => q.sql === SPEC_NOTIFY_CHANNEL_DELETE_SQL)).toBe(false);
    expect(p.outer).toEqual([{ sql: NOTIFY_CHANNEL_GAUGE_SQL, params: [] }]);
  });
});

describe('notify-channel.service —— pull（§3.2 / §2.5）', () => {
  it('仅已配置键（缺键不补）；密键含值（canonical 逐字——消费端直接用）', async () => {
    const db = new FakeNotifyChannelDb();
    seedRow(db, 'notify.smtp.host', HOST);
    seedRow(db, 'notify.smtp.pass', PASS);
    seedRow(db, 'notify.webhook.dingtalkSecret', DINGTALK_SECRET);
    const p = makeProbe(db);

    const values = await p.svc.pull();

    expect(values).toEqual({
      'notify.smtp.host': HOST,
      'notify.smtp.pass': PASS,
      'notify.webhook.dingtalkSecret': DINGTALK_SECRET,
    });
    expect(Object.keys(values)).toHaveLength(3); // 其余六键缺键不补
    expect(values['notify.email.to']).toBeUndefined();
    // 读路径：事务外恰一条 LIST 读；**不触发** gauge 刷新（刷新点 = 写路径 + 启动各一次）
    expect(p.outer).toEqual([{ sql: NOTIFY_CHANNEL_LIST_SQL, params: [] }]);
    expect(p.outer.some((q) => q.sql === NOTIFY_CHANNEL_GAUGE_SQL)).toBe(false);
  });

  it('空库 ⇒ {}（不补默认）', async () => {
    const p = makeProbe(new FakeNotifyChannelDb());
    await expect(p.svc.pull()).resolves.toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * 3：status（管理读）
 * ------------------------------------------------------------------ */

describe('notify-channel.service —— status（§2.4 GET 项形状）', () => {
  it('空库：九项按 NOTIFY_CHANNEL_KEYS 固定序、全 configured:false、label/secret 逐格、hint 恒 null', async () => {
    const p = makeProbe(new FakeNotifyChannelDb());
    const items = await p.svc.status();

    expect(items.map((i) => i.key)).toEqual([...NOTIFY_CHANNEL_KEYS]);
    expect(items.map((i) => i.label)).toEqual([
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
    expect(items.map((i) => i.secret)).toEqual([
      false,
      false,
      false,
      true, // smtp.pass
      false,
      true, // feishuUrl
      true, // wecomUrl
      true, // dingtalkUrl
      true, // dingtalkSecret
    ]);
    for (const item of items) {
      expect(item).toEqual({
        key: item.key,
        label: item.label,
        secret: item.secret,
        configured: false,
        value: null,
        fingerprint: null,
        hint: null,
        updatedAt: null,
        updatedBy: null,
      });
    }
  });

  it('已配置：非密明文 / 密键 value 恒 null + 指纹 / URL 三键 hint 逐格 / updatedAt = epoch ms', async () => {
    const db = new FakeNotifyChannelDb();
    db.now = new Date('2026-10-07T08:00:00.000Z');
    seedRow(db, 'notify.smtp.host', HOST);
    seedRow(db, 'notify.smtp.pass', PASS, { updated_by: 'bob' });
    seedRow(db, 'notify.email.to', TO, { updated_by: 'alice' });
    // URL 三键 hint 逐格：allowlist 全等（含默认端口归一）⇒ origin；异域 ⇒「外部地址」；非默认端口 ⇒「外部地址」
    seedRow(db, 'notify.webhook.feishuUrl', 'https://open.feishu.cn:443/open-apis/bot/v2/hook/abc');
    seedRow(db, 'notify.webhook.wecomUrl', 'https://example.com/hook');
    seedRow(db, 'notify.webhook.dingtalkUrl', 'https://oapi.dingtalk.com:8443/robot/send?access_token=t');
    const p = makeProbe(db);

    const items = await p.svc.status();
    expect(items).toHaveLength(9);
    // 有数据面**顺序**判据：假库 LIST 按 key 字母序返回（email.to 在前），⚙️1 序另有其序——
    // 若 status() 退化为「行序优先」，此处当场红（空库用例只覆盖全缺键形态）。
    expect(items.map((i) => i.key)).toEqual([...NOTIFY_CHANNEL_KEYS]);

    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get('notify.smtp.host')).toEqual({
      key: 'notify.smtp.host',
      label: '邮件服务器',
      secret: false,
      configured: true,
      value: HOST, // 非密键 = 明文回显
      fingerprint: fingerprintOf(HOST),
      hint: null, // 非 URL 键 hint 恒 null
      updatedAt: Date.parse('2026-10-07T08:00:00.000Z'),
      updatedBy: 'seed',
    });

    const pass = byKey.get('notify.smtp.pass')!;
    expect(pass.configured).toBe(true);
    expect(pass.value).toBeNull(); // 🔴 密键 value 恒 null（掩码写，D4）
    expect(pass.fingerprint).toBe(fingerprintOf(PASS));
    expect(pass.hint).toBeNull(); // 非 URL 密键 hint 亦恒 null
    expect(pass.updatedBy).toBe('bob');

    // email.to：非密键回显存储 canonical 原文（逗号列表形态）
    expect(byKey.get('notify.email.to')!.value).toBe(TO);

    // URL 三键：secret=true、value=null（密），hint 为现算（全等规则逐格）
    const feishu = byKey.get('notify.webhook.feishuUrl')!;
    expect(feishu.secret).toBe(true);
    expect(feishu.value).toBeNull();
    expect(feishu.hint).toBe('https://open.feishu.cn'); // :443 默认端口归一 ⇒ 仍全等命中
    expect(byKey.get('notify.webhook.wecomUrl')!.hint).toBe('外部地址'); // 异域
    expect(byKey.get('notify.webhook.dingtalkUrl')!.hint).toBe('外部地址'); // 非默认端口 ⇒ 不命中全等

    // 未配置项：configured:false + hint null
    const missing = byKey.get('notify.webhook.dingtalkSecret')!;
    expect(missing.configured).toBe(false);
    expect(missing.hint).toBeNull();
  });

  it('坏密文行 ⇒ NotifyChannelStorageDisabledError（三形态：非密 / 密 / URL-hint 路径）', async () => {
    // ① 非密键（host）坏行
    const db1 = new FakeNotifyChannelDb();
    db1.addRow('notify.smtp.host', { value_enc: 'v1:' + Buffer.alloc(40, 7).toString('base64') });
    await expect(makeProbe(db1).svc.status()).rejects.toBeInstanceOf(
      NotifyChannelStorageDisabledError,
    );

    // ② 密键（pass）坏行：status 对密键也解密（§3.2 逐行解密）——若只解非密行，本断言会绿
    // （= 坏行被静默伪装成「已配置 ✓ 指纹 xxx」），故用密键**坏**行判别
    const db2 = new FakeNotifyChannelDb();
    db2.addRow('notify.smtp.pass', {
      value_enc: 'v1:' + Buffer.alloc(40, 8).toString('base64'), // 结构合法但 GCM 认证必败
      fingerprint: 'cafebabecafe',
    });
    await expect(makeProbe(db2).svc.status()).rejects.toBeInstanceOf(
      NotifyChannelStorageDisabledError,
    );

    // ③ URL 键（feishu）坏行：hint 以**解密后的明文**现算 ⇒ 坏行必须响亮，而非静默降级为「hint:null」
    const db3 = new FakeNotifyChannelDb();
    db3.addRow('notify.webhook.feishuUrl', {
      value_enc: 'v1:' + Buffer.alloc(40, 10).toString('base64'),
      fingerprint: 'cafebabecafe',
    });
    await expect(makeProbe(db3).svc.status()).rejects.toBeInstanceOf(
      NotifyChannelStorageDisabledError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 7（续）：主钥缺 fail-closed（fresh 模块图）+ 观测序
 * ------------------------------------------------------------------ */

describe('notify-channel.service —— 主钥缺 fail-closed 与观测序（设计 D2 / §3.1）', () => {
  it('主钥未设：status/pull 一律拒（含空库——不给「看起来正常」的中间态）', async () => {
    const mod = await freshServiceModule('');
    const db = new FakeNotifyChannelDb(); // 空库
    const p = makeProbe(db, { ctor: mod.NotifyChannelService });

    await expect(p.svc.status()).rejects.toBeInstanceOf(mod.NotifyChannelStorageDisabledError);
    await expect(p.svc.pull()).rejects.toBeInstanceOf(mod.NotifyChannelStorageDisabledError);
  });

  it('主钥未设：set 合法值也拒（存储不可用）且库零调用；clear 同拒', async () => {
    const mod = await freshServiceModule('');
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db, { ctor: mod.NotifyChannelService });

    await expect(p.svc.set('notify.smtp.host', HOST, 'alice')).rejects.toBeInstanceOf(
      mod.NotifyChannelStorageDisabledError,
    );
    await expect(p.svc.clear('notify.smtp.host', 'alice')).rejects.toBeInstanceOf(
      mod.NotifyChannelStorageDisabledError,
    );
    expect(db.queries).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
    expect(p.txCalls()).toBe(0);
  });

  it('观测序（400 先于 503，§3.1/§5.2⑨）：非法值 ⇒ 校验错误（400 面）先于主钥缺失（503 面）', async () => {
    const mod = await freshServiceModule('');
    const p = makeProbe(new FakeNotifyChannelDb(), { ctor: mod.NotifyChannelService });

    // 空串/坏 host ⇒ 先被校验拒（不是 503）——以 503 为判据的探针/测试必须用**合法值**
    await expect(p.svc.set('notify.smtp.host', '   ', 'alice')).rejects.toBeInstanceOf(
      mod.NotifyChannelValidationError,
    );
    await expect(p.svc.set('notify.smtp.host', 'bad host', 'alice')).rejects.toMatchObject({
      reason: '必须是合法主机名（字母/数字/点/横线）',
    });
  });

  it('旧非密行密文损坏：重写时旧值解密失败 ⇒ StorageDisabled（不静默吞旧值、不重试、不刷新 gauge）', async () => {
    const db = new FakeNotifyChannelDb();
    db.addRow('notify.smtp.host', {
      value_enc: 'v1:' + Buffer.alloc(40, 9).toString('base64'),
      fingerprint: 'cafebabecafe',
    });
    const p = makeProbe(db);

    await expect(p.svc.set('notify.smtp.host', 'smtp.new.example.com', 'alice')).rejects.toBeInstanceOf(
      NotifyChannelStorageDisabledError,
    );
    expect(p.txCalls()).toBe(1); // 解密失败非 1213 ⇒ 不重试
    expect(db.changes).toHaveLength(0); // 审计零行（不静默吞）
    expect(p.outer).toHaveLength(0); // 事务未成功 ⇒ 零 gauge 刷新
  });
});

/* ------------------------------------------------------------------ *
 * 6：1213 有界重试（捕获边界 = 整个事务；同支付片 U-2 先例）
 * ------------------------------------------------------------------ */

describe('notify-channel.service —— 1213 有界重试（§3.1；同支付片先例）', () => {
  it('四种 1213 形态（errno/code/message/driverError 包装）：各恰重试一次 ⇒ 成功；重试路径重读旧值（审计恰一行 old=前值）；gauge 刷新恰一次', async () => {
    for (const shape of ['errno', 'code', 'message', 'wrapped'] as const) {
      const db = new FakeNotifyChannelDb();
      seedRow(db, 'notify.smtp.host', 'smtp.old.example.com');
      const p = makeProbe(db, { failures: [deadlockErr(shape)] });

      const res = await p.svc.set('notify.smtp.host', HOST, 'alice');

      expect(p.txCalls(), shape).toBe(2); // 恰一次重试（第 1 次死锁 ⇒ 第 2 次成功）
      const inserts = changeInserts(db);
      expect(inserts, shape).toHaveLength(1); // 重试成功后**恰一**审计行
      expect(inserts[0]!.params[1], shape).toBe(JSON.stringify('smtp.old.example.com')); // old=前值（重读）
      expect(res.fingerprint, shape).toBe(fingerprintOf(HOST));
      // 重试只发生在事务面；gauge 刷新在**最终成功之后**恰一次（不随重试次数放大）
      expect(p.outer, shape).toEqual([{ sql: NOTIFY_CHANNEL_GAUGE_SQL, params: [] }]);
    }
  });

  it('恰两次死锁（重试用满）⇒ 第 3 次尝试成功（总尝试 3 = 1+2）；gauge 刷新恰一次', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db, { failures: [deadlockErr('errno'), deadlockErr('errno')] });

    await expect(p.svc.set('notify.smtp.host', HOST, 'alice')).resolves.toMatchObject({
      fingerprint: fingerprintOf(HOST),
    });
    expect(p.txCalls()).toBe(3);
    expect(changeInserts(db)).toHaveLength(1);
    expect(p.outer).toHaveLength(1);
  });

  it('连抛 3 次 ⇒ 第 3 次仍抛出（总尝试恰 3）；零审计残留；**不触发 gauge 刷新**（事务未成功）', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db, {
      failures: [deadlockErr('errno'), deadlockErr('code'), deadlockErr('message')],
    });

    // 第 3 次（message 形态）仍被识别为死锁、但重试额度用尽 ⇒ **原样抛出**（不吞、不再试）
    await expect(p.svc.set('notify.smtp.host', HOST, 'alice')).rejects.toThrow(
      'Deadlock found when trying to get lock; try restarting transaction',
    );
    expect(p.txCalls()).toBe(3);
    expect(db.changes).toHaveLength(0);
    expect(db.rows.size).toBe(0); // 三次尝试都死在注入点（未触库）
    expect(p.outer).toHaveLength(0);
  });

  it('非 1213 错误不重试：直接抛（恰一次事务调用）', async () => {
    const db = new FakeNotifyChannelDb();
    const p = makeProbe(db, { failures: [new Error('connection reset by peer')] });

    await expect(p.svc.set('notify.smtp.host', HOST, 'alice')).rejects.toThrow(
      'connection reset by peer',
    );
    expect(p.txCalls()).toBe(1);
    expect(db.changes).toHaveLength(0);
    expect(p.outer).toHaveLength(0);
  });

  it('clear 同走有界重试：首击死锁 ⇒ 重试后成功恰一行审计 + 一次 gauge 刷新', async () => {
    const db = new FakeNotifyChannelDb();
    seedRow(db, 'notify.smtp.host', HOST);
    const p = makeProbe(db, { failures: [deadlockErr('wrapped')] });

    await expect(p.svc.clear('notify.smtp.host', 'alice')).resolves.toEqual({ existed: true });
    expect(p.txCalls()).toBe(2);
    expect(db.rows.has('notify.smtp.host')).toBe(false);
    expect(changeInserts(db)).toHaveLength(1);
    expect(p.outer).toHaveLength(1);
  });
});
