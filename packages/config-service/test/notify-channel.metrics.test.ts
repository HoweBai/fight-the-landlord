import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { metricsRegistry } from '@fight-the-landlord/shared';
import {
  NOTIFY_CHANNEL_GAUGE_SQL,
  NOTIFY_CONFIG_GROUP_KEYS,
  notifyConfigGroupComplete,
  notifyConfigKeysConfigured,
  refreshNotifyGauges,
} from '../src/notify-channel/notify-channel.metrics';
import { NotifyChannelService } from '../src/notify-channel/notify-channel.service';
import {
  FakeNotifyChannelDb,
  type FakeNotifyChannelEm,
} from './helpers/config-probe';

/**
 * ⚙️17 完整性 gauges 单测（§5.1-6；T5 交付物）。
 *
 * 判据（与简报 Step 2 逐条对位）：
 *  1. **恒有定义**：模块加载即定形两组序列（初始 0/0）；两条指标名注册于 shared registry
 *     （同名同一性——落错注册表的形态由 shared 构造器纪律封死，此处钉「确实在册」）；
 *  2. gauge SQL 常量逐字 = ⚙️17（只 `SELECT `key`` 数行**不解密**；**无占位符**——写路径不得内嵌值）；
 *  3. 分组键集逐字（email 5 / dingtalk 2）；组外键（feishu/wecom）不进任何组计数；
 *  4. `refreshNotifyGauges` 成功：按组计数 + `group_complete` 0/1 翻转（表驱动逐格）；
 *  5. **写路径现算（端到端）**：真 `NotifyChannelService` + 假库 + 「gauge SQL 只键读」复合源——
 *     `set` 后 `keys_configured{group}` 增、`clear` 后减、`group_complete` 翻转；每次写恰一次
 *     gauge 读且**调用恰一参**（SQL 常量本身）；
 *  6. `OnModuleInit` 启动一次重算；
 *  7. **SQL 读失败 ⇒ 保持旧值 + WARN、不抛**（「不打穿 /metrics」）；**写响应不受影响**
 *     （set 仍成功落库、gauge 保持旧值）。
 *
 * ⚠️ 本文件**不做 `vi.resetModules()`**（无主钥用例；reset 会重估本体模块图，gauge 注册面随之多份）。
 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

const EMAIL_5 = [
  'notify.smtp.host',
  'notify.smtp.port',
  'notify.smtp.user',
  'notify.smtp.pass',
  'notify.email.to',
] as const;

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/** 读一个带 `group` 标签的 gauge 值（结构类型照 `reconcile.test.ts` 的 `MetricLike`——
 *  不引 prom-client 的类型，本包不直接依赖它）。 */
interface MetricLike {
  get(): Promise<{
    values: Array<{ value: number; labels: Partial<Record<string, string | number>> }>;
  }>;
}
async function gaugeValue(metric: MetricLike, group: string): Promise<number> {
  const { values } = await metric.get();
  const series = values.find((v) => String(v.labels.group) === group);
  expect(series, `gauge 无 group=${group} 序列（「恒有定义」被破坏）`).toBeDefined();
  return series!.value;
}

/** 纯 stub 读源（`refreshNotifyGauges` 的全部消费面 = 一个 `query` 函数）。 */
function stubSource(keys: string[]) {
  return { query: vi.fn(async (_sql: string) => keys.map((key) => ({ key }))) };
}

/**
 * 复合源（端到端夹具）：gauge SQL 由**内存只键视图**应答（= 真库语义），其余 SQL 全部委托
 * `FakeNotifyChannelDb`（事务三段序照走）。`gaugeFail` 注入读失败（读面故障态）。
 */
function makeE2eProbe(opts: { gaugeFail?: boolean } = {}) {
  const db = new FakeNotifyChannelDb();
  /** gauge 读的**原始调用参数**（arity 判据：恰一参 = SQL 常量本身、无值内嵌）。 */
  const gaugeCalls: unknown[][] = [];
  const ds = {
    query: (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql === NOTIFY_CHANNEL_GAUGE_SQL) {
        gaugeCalls.push(args);
        if (opts.gaugeFail) return Promise.reject(new Error('gauge read boom'));
        return Promise.resolve([...db.rows.keys()].map((key) => ({ key })));
      }
      return db.dataSource.query(sql, args[1] as unknown[] | undefined);
    },
    transaction: <T,>(cb: (em: FakeNotifyChannelEm) => Promise<T>) => db.dataSource.transaction(cb),
  };
  return { svc: new NotifyChannelService(ds as unknown as DataSource), db, gaugeCalls };
}

describe('notify-channel.metrics —— 注册面与常量（⚙️17）', () => {
  it('模块加载即定形两组序列（「恒有定义」初始 0/0——两组大小恒非 0）', async () => {
    // ⚠️ 本用例必须在文件内**最先**执行（任何刷新/写路径都会改值）；vitest 按声明序执行。
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(0);
    expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk')).toBe(0);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(0);
    expect(await gaugeValue(notifyConfigGroupComplete, 'dingtalk')).toBe(0);
  });

  it('两条指标名在 shared registry 在册（同名同一性——经 shared createGauge 构造）', () => {
    expect(
      metricsRegistry().getSingleMetric('notify_config_keys_configured'),
      'registry 里没有 notify_config_keys_configured',
    ).toBe(notifyConfigKeysConfigured);
    expect(
      metricsRegistry().getSingleMetric('notify_config_group_complete'),
      'registry 里没有 notify_config_group_complete',
    ).toBe(notifyConfigGroupComplete);
  });

  it('gauge SQL 常量逐字 = ⚙️17：只 SELECT `key`（不解密列、无占位符——写路径不得内嵌值）', () => {
    expect(NOTIFY_CHANNEL_GAUGE_SQL).toBe('SELECT `key` FROM notify_channel_config');
    expect(NOTIFY_CHANNEL_GAUGE_SQL).not.toContain('?');
    expect(NOTIFY_CHANNEL_GAUGE_SQL).not.toMatch(/value_enc|fingerprint|updated_at|updated_by/);
  });

  it('分组键集逐字：email = SMTP 前 5 键、dingtalk = 钉钉 2 键（⚙️1 分组口径）', () => {
    expect(NOTIFY_CONFIG_GROUP_KEYS.email).toEqual([...EMAIL_5]);
    expect(NOTIFY_CONFIG_GROUP_KEYS.dingtalk).toEqual([
      'notify.webhook.dingtalkUrl',
      'notify.webhook.dingtalkSecret',
    ]);
  });
});

describe('notify-channel.metrics —— refreshNotifyGauges 成功路径（表驱动逐格）', () => {
  it('按组计数 + group_complete 0/1 翻转；组外键（feishu/wecom）不进任何组', async () => {
    const cases: Array<[string[], [number, number], [number, number]]> = [
      // [库中键集, email 组 [configured, complete], dingtalk 组 [configured, complete]]
      [[], [0, 0], [0, 0]],
      [['notify.smtp.host'], [1, 0], [0, 0]],
      [['smtp.host'], [0, 0], [0, 0]], // 近邻键名（缺 notify. 前缀）不命中
      [
        ['notify.webhook.feishuUrl', 'notify.webhook.wecomUrl'],
        [0, 0],
        [0, 0], // 组外 IM 两键：在场即启用，无完整性口径
      ],
      [EMAIL_5.slice(0, 4), [4, 0], [0, 0]], // 半配：4/5 ⇒ complete 0
      [[...EMAIL_5], [5, 1], [0, 0]], // 全配 ⇒ complete 1
      [
        ['notify.email.to', 'notify.webhook.dingtalkUrl', 'notify.webhook.dingtalkSecret'],
        [1, 0],
        [2, 1], // 钉钉两键成对 ⇒ complete 1
      ],
      [['notify.webhook.dingtalkUrl'], [0, 0], [1, 0]], // 钉钉半配
    ];

    for (const [keys, email, dingtalk] of cases) {
      const source = stubSource(keys);
      await refreshNotifyGauges(source);

      // 读路径恰一次、**恰一参**（SQL 常量本身——无参数绑定 ⇒ 不可能内嵌值）
      expect(source.query.mock.calls, JSON.stringify(keys)).toHaveLength(1);
      expect(source.query.mock.calls[0]).toEqual([NOTIFY_CHANNEL_GAUGE_SQL]);

      expect(await gaugeValue(notifyConfigKeysConfigured, 'email'), JSON.stringify(keys)).toBe(email[0]);
      expect(await gaugeValue(notifyConfigGroupComplete, 'email'), JSON.stringify(keys)).toBe(email[1]);
      expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk'), JSON.stringify(keys)).toBe(dingtalk[0]);
      expect(await gaugeValue(notifyConfigGroupComplete, 'dingtalk'), JSON.stringify(keys)).toBe(dingtalk[1]);
    }
  });
});

describe('notify-channel.metrics —— 写路径现算与启动重算（⚙️17 / §3.1）', () => {
  it('端到端：set 后增、clear 后减、complete 翻转；每次写恰一次 gauge 读（恰一参）', async () => {
    const e2e = makeE2eProbe();

    // 启动重算（空库 ⇒ 0/0）
    await e2e.svc.onModuleInit();
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(0);
    expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk')).toBe(0);

    // set 后增：email 1/5 ⇒ [1,0]
    await e2e.svc.set('notify.smtp.host', 'smtp.example.com', 'alice');
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(1);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(0);

    // 补齐邮件组 ⇒ [5,1]（翻转）
    await e2e.svc.set('notify.smtp.port', '465', 'alice');
    await e2e.svc.set('notify.smtp.user', 'noreply@example.com', 'alice');
    await e2e.svc.set('notify.smtp.pass', 'super-secret-pass', 'alice');
    await e2e.svc.set('notify.email.to', 'ops@example.com', 'alice');
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(5);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(1);

    // clear 后减 ⇒ [4,0]（翻转回未齐）
    await e2e.svc.clear('notify.email.to', 'alice');
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(4);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(0);

    // 钉钉组：两键成对 ⇒ [2,1]；清一键 ⇒ [1,0]
    await e2e.svc.set('notify.webhook.dingtalkUrl', 'https://oapi.dingtalk.com/robot/send?access_token=t', 'alice');
    await e2e.svc.set('notify.webhook.dingtalkSecret', 'SEC1234567890', 'alice');
    expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk')).toBe(2);
    expect(await gaugeValue(notifyConfigGroupComplete, 'dingtalk')).toBe(1);
    await e2e.svc.clear('notify.webhook.dingtalkSecret', 'alice');
    expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk')).toBe(1);
    expect(await gaugeValue(notifyConfigGroupComplete, 'dingtalk')).toBe(0);

    // gauge 读的观测面：init 1 次 + 7 次 set + 2 次 clear = 10 次；**每次恰一参**（SQL 常量本身）
    expect(e2e.gaugeCalls).toHaveLength(10);
    for (const args of e2e.gaugeCalls) {
      expect(args).toEqual([NOTIFY_CHANNEL_GAUGE_SQL]);
    }
    // 假库行为照真库语义：5 邮件（clear 掉 email.to 后 4）+ 2 钉钉（clear 掉 secret 后 1）= 5 行
    expect(e2e.db.rows.size).toBe(5);
  });

  it('OnModuleInit：启动一次重算（先种子 ⇒ init 即得出正确值）', async () => {
    const e2e = makeE2eProbe();
    e2e.db.addRow('notify.smtp.host', {});
    e2e.db.addRow('notify.smtp.port', {});
    e2e.db.addRow('notify.smtp.user', {});

    await e2e.svc.onModuleInit();

    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(3);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(0);
    expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk')).toBe(0);
    expect(e2e.gaugeCalls).toHaveLength(1);
  });
});

describe('notify-channel.metrics —— 读失败保持旧值 + WARN（不打穿）', () => {
  let warnSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('SQL 读失败：refresh 不抛（不打穿 /metrics）、保持旧值、WARN 一条', async () => {
    // 先成功置于已知值（邮件全配 ⇒ 5/1）
    await refreshNotifyGauges(stubSource([...EMAIL_5]));
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(5);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(1);

    const failing = { query: vi.fn(async () => { throw new Error('gauge read boom'); }) };
    await expect(refreshNotifyGauges(failing)).resolves.toBeUndefined(); // 不抛 = 不打穿

    // 保持旧值（两侧一同冻结——曾成功过的 dingtalk 0/0 也不受影响）
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(5);
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(1);
    expect(await gaugeValue(notifyConfigKeysConfigured, 'dingtalk')).toBe(0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]![0]);
    expect(message).toContain('通知通道完整性 gauge 刷新失败（保持旧值）');
    expect(message).toContain('gauge read boom');

    // 恢复：下一次成功刷新照常覆盖（故障不是粘性的）
    await refreshNotifyGauges(stubSource(['notify.smtp.host']));
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(1);
  });

  it('读失败不影响写响应：set 仍 resolves 且落库、gauge 保持旧值 + WARN', async () => {
    // 先置于已知值（0/0 —— 用一次成功刷新钉定，不依赖本文件其它用例的遗留状态）
    await refreshNotifyGauges(stubSource([]));
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(0);

    const e2e = makeE2eProbe({ gaugeFail: true });
    const res = await e2e.svc.set('notify.smtp.host', 'smtp.example.com', 'alice');

    expect(res.fingerprint).toMatch(/^[0-9a-f]{12}$/); // 写响应照常返回
    expect(e2e.db.rows.has('notify.smtp.host')).toBe(true); // 落库照常（不回滚）
    expect(e2e.gaugeCalls).toHaveLength(1); // 刷新**确实被调用**（失败在读面，不是没调）
    expect(await gaugeValue(notifyConfigKeysConfigured, 'email')).toBe(0); // 保持旧值
    expect(await gaugeValue(notifyConfigGroupComplete, 'email')).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
