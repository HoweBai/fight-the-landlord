import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES, sinkConfigsFromState, startNotifyLoop, startRelayServer } from '../src/server';
import type { NotifyLoop, RelayRuntimeState } from '../src/server';
import type { NotifyValues, SinkConfigs } from '../src/config';
import { freePort, httpCall, startStub } from './helpers';
import type { StubServer } from './helpers';

/**
 * T12 单测半边之四（server 改造，§5.1#12 逐字）：
 *
 *  - `/webhook` 三态：`lastGood===null` ⇒ **500**（从未拉到 ≠ 成功空图）；成功空图/零派生槽
 *    ⇒ 200 `no sinks configured`；扇出照旧（200/500 与单槽隔离纪律不动）。
 *  - **热更新换槽**：每次请求现取「当前槽位闭包」的新快照 —— 闭包换引用 ⇒ 下一请求即新槽位，
 *    在途投递用旧快照完成。
 *  - **轮询衔接**（`startNotifyLoop`）：拉取 ⇒ 裁剪 ⇒ 整图替换 ⇒ 持久化 ⇒ 槽位状态日志
 *    （半配 WARN / 拉取失败 WARN，**状态变化时一条**）；任何异常不得打穿（D4）。
 *
 * ⚠️ 计数断言一律**基线化**（先读后读、比增量）：prom-client 的 registry 是模块级单例、
 * 跨用例存活 —— 钉绝对值会让用例顺序变成隐式依赖（照 Y8 的口径）。
 */

const TOKEN = 'relay-test-token';

/** 固定时钟 = sign.test.ts / sinks.test.ts 的向量时间（2020-01-22T02:23:49.250Z）。 */
const CLOCK_MS = 1579659829250;
const DINGTALK_SECRET = 'SEC5b17d83d0e2627c5f6aac34d78912ab2a91221f307dbe0bab7c7a268cec8c916';
const DINGTALK_SIGN_ENCODED = 'Exy6a4GAAJ7WliaOkGZ14WzlEeuWP7npnn%2BDvqtkbxI%3D';

/** 文案预期（与 format.test.ts 同口径；这里走完整端点 ⇒ 标题+正文一路到出站字节）。 */
const EXPECTED_TITLE = '[critical] ServiceDown';
const EXPECTED_BODY =
  '- api-gateway/api-gateway:9000 · api-gateway 抓不到了 · 开始 2020-01-22 02:18 UTC · 持续 5m';

/** 轮询面 WARN 逐字（§2.9）。 */
const PULL_FAIL_WARN = '通知配置拉取失败，使用上次成功值';
const HALF_WARN = '钉钉 URL 与加签密钥须成对（当前半配）——该槽位已停用';

const PAYLOAD = {
  version: '4',
  groupKey: '{}/{alertname="ServiceDown"}:{job="api-gateway"}',
  truncatedAlerts: 0,
  status: 'firing',
  receiver: 'all',
  commonLabels: { alertname: 'ServiceDown', severity: 'critical', job: 'api-gateway' },
  commonAnnotations: { summary: 'api-gateway 抓不到了' },
  externalURL: 'http://alertmanager:9093',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'ServiceDown', severity: 'critical', job: 'api-gateway', instance: 'api-gateway:9000' },
      annotations: { summary: 'api-gateway 抓不到了' },
      startsAt: '2020-01-22T02:18:49Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus:9090/graph?g0.expr=up',
      fingerprint: 'aa11bb22',
    },
  ],
};

/** 捕获 console.warn 行（轮询面 WARN 断言用；消费掉输出避免噪音）。 */
function captureWarnings(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return lines;
}

/** 脚本化拉取序列（耗尽/Error 步 ⇒ throw，模拟「这次拉不到」）。 */
function scriptedPull(steps: Array<NotifyValues | Error>): () => Promise<NotifyValues> {
  return async () => {
    const step = steps.shift();
    if (step === undefined) throw new Error('脚本化拉取已耗尽');
    if (step instanceof Error) throw step;
    return step;
  };
}

describe('relay HTTP 契约（C8；槽位改「当前闭包」注入 —— T12）', () => {
  let stubs: StubServer[] = [];
  let closers: Array<{ close(): Promise<void> }> = [];
  let loops: NotifyLoop[] = [];
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN; // 默认 fail-closed；用例自己按需设置
  });

  afterEach(async () => {
    for (const loop of loops) loop.stop();
    loops = [];
    await Promise.all(closers.map((c) => c.close()));
    closers = [];
    await Promise.all(stubs.map((s) => s.close()));
    stubs = [];
    if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
    vi.restoreAllMocks();
  });

  async function newStub(): Promise<StubServer> {
    const s = await startStub();
    stubs.push(s);
    return s;
  }

  /** 起一个 relay 实例（槽位 = 注入的「当前闭包」；用例可覆写任意依赖）。 */
  async function startRelay(
    currentSinks: () => SinkConfigs | null,
    deps: { timeoutMs?: number } = {},
  ): Promise<number> {
    const port = await freePort();
    closers.push(startRelayServer({ port }, { clock: () => CLOCK_MS, currentSinks, ...deps }));
    return port;
  }

  /** 三槽齐备的标准装配（返回槽位指向的 stub，供断言收件）。 */
  async function startFullRelay(deps: { timeoutMs?: number } = {}) {
    const feishu = await newStub();
    const wecom = await newStub();
    const dingtalk = await newStub();
    const cfg: SinkConfigs = {
      feishu: { url: feishu.baseUrl },
      wecom: { url: wecom.baseUrl },
      dingtalk: { url: `${dingtalk.baseUrl}?access_token=stub-tk`, secret: DINGTALK_SECRET },
    };
    const port = await startRelay(() => cfg, deps);
    return { port, feishu, wecom, dingtalk };
  }

  function postWebhook(port: number, body: string, token: string | null = TOKEN) {
    return httpCall({
      port,
      method: 'POST',
      path: '/webhook',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body,
    });
  }

  async function metricValue(port: number, sink: string, result: string): Promise<number> {
    const res = await httpCall({ port, path: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
    const m = res.body.match(
      new RegExp(`^alert_deliveries_total\\{sink="${sink}",result="${result}"\\} (\\d+)$`, 'm'),
    );
    return m ? Number(m[1]) : 0;
  }

  describe('Bearer 守卫（fail-closed）与路由', () => {
    it('env 未设 ⇒ /webhook 与 /metrics 一律 401，且**出站零请求**（守卫在扇出之前）', async () => {
      const { port, feishu, wecom, dingtalk } = await startFullRelay();

      expect((await postWebhook(port, JSON.stringify(PAYLOAD), null)).status).toBe(401);
      expect((await postWebhook(port, JSON.stringify(PAYLOAD), 'anything')).status).toBe(401);
      expect((await httpCall({ port, path: '/metrics' })).status).toBe(401);

      expect(feishu.requests).toHaveLength(0);
      expect(wecom.requests).toHaveLength(0);
      expect(dingtalk.requests).toHaveLength(0);
    });

    it('错 token ⇒ 401；正确 Bearer ⇒ 200（同一实例对照，排除「恒 401」）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port } = await startFullRelay();

      expect((await postWebhook(port, JSON.stringify(PAYLOAD), 'wrong-token')).status).toBe(401);
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
    });

    it('/health 无守卫（env 未设也 200）；未知路径与非 POST 的 /webhook ⇒ 404', async () => {
      const { port } = await startFullRelay(); // 注意：env 未设

      const health = await httpCall({ port, path: '/health' });
      expect(health.status).toBe(200);
      expect(health.body).toBe('ok\n');

      expect((await httpCall({ port, path: '/nope' })).status).toBe(404);
      expect((await httpCall({ port, path: '/webhook' })).status).toBe(404); // GET /webhook：只有 POST 存在
    });
  });

  describe('POST /webhook 返回语义（三态 + 扇出 200/500）', () => {
    it('全槽成功 ⇒ 200；三槽各收到逐字 golden（钉钉含固定时钟向量）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port, feishu, wecom, dingtalk } = await startFullRelay();

      const res = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(res.status).toBe(200);
      expect(res.body).toBe('ok\n');

      expect(feishu.requests).toHaveLength(1);
      expect(feishu.requests[0].body).toBe(
        JSON.stringify({ msg_type: 'text', content: { text: `${EXPECTED_TITLE}\n${EXPECTED_BODY}` } }),
      );
      expect(wecom.requests).toHaveLength(1);
      expect(wecom.requests[0].body).toBe(
        JSON.stringify({ msgtype: 'markdown', markdown: { content: `**${EXPECTED_TITLE}**\n${EXPECTED_BODY}` } }),
      );
      expect(dingtalk.requests).toHaveLength(1);
      expect(dingtalk.requests[0].url).toBe(
        `/hook?access_token=stub-tk&timestamp=${CLOCK_MS}&sign=${DINGTALK_SIGN_ENCODED}`,
      );
    });

    it('单槽 500 隔离：该槽计 error、其余照达、HTTP 仍 200（基线化计数）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port, feishu, wecom, dingtalk } = await startFullRelay();
      feishu.status = 500;

      const before = {
        fErr: await metricValue(port, 'feishu', 'error'),
        fOk: await metricValue(port, 'feishu', 'ok'),
        wOk: await metricValue(port, 'wecom', 'ok'),
        dOk: await metricValue(port, 'dingtalk', 'ok'),
      };
      const res = await postWebhook(port, JSON.stringify(PAYLOAD));

      expect(res.status).toBe(200); // 至少一个成功 ⇒ 200
      expect(wecom.requests).toHaveLength(1);
      expect(dingtalk.requests).toHaveLength(1);
      expect(await metricValue(port, 'feishu', 'error')).toBe(before.fErr + 1);
      expect(await metricValue(port, 'feishu', 'ok')).toBe(before.fOk); // 失败槽不虚报成功
      expect(await metricValue(port, 'wecom', 'ok')).toBe(before.wOk + 1);
      expect(await metricValue(port, 'dingtalk', 'ok')).toBe(before.dOk + 1);
    });

    it('对端挂起（超时替身）⇒ 只该槽 error、其余照达、HTTP 200（隔离在时间维也成立）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const feishu = await newStub();
      feishu.hang = true;
      const wecom = await newStub();
      const port = await startRelay(
        () => ({ feishu: { url: feishu.baseUrl }, wecom: { url: wecom.baseUrl } }),
        { timeoutMs: 100 },
      );

      const beforeErr = await metricValue(port, 'feishu', 'error');
      const started = Date.now();
      const res = await postWebhook(port, JSON.stringify(PAYLOAD));

      expect(res.status).toBe(200);
      expect(wecom.requests).toHaveLength(1);
      expect(await metricValue(port, 'feishu', 'error')).toBe(beforeErr + 1);
      expect(Date.now() - started).toBeLessThan(2000); // 超时没接上会拖到 vitest 5s 上限
    });

    it('已配置槽位全失败 ⇒ 500（AM 按 repeat_interval 重投；不内置重试 = 每槽恰一次请求）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port, feishu, wecom, dingtalk } = await startFullRelay();
      for (const s of [feishu, wecom, dingtalk]) s.status = 500;

      const before = await Promise.all([
        metricValue(port, 'feishu', 'error'),
        metricValue(port, 'wecom', 'error'),
        metricValue(port, 'dingtalk', 'error'),
      ]);
      const res = await postWebhook(port, JSON.stringify(PAYLOAD));

      expect(res.status).toBe(500);
      expect(res.body).toBe('delivery failed\n');
      expect([feishu.requests, wecom.requests, dingtalk.requests].map((r) => r.length)).toEqual([1, 1, 1]);
      expect(
        await Promise.all([
          metricValue(port, 'feishu', 'error'),
          metricValue(port, 'wecom', 'error'),
          metricValue(port, 'dingtalk', 'error'),
        ]),
      ).toEqual([before[0] + 1, before[1] + 1, before[2] + 1]);
    });

    it('成功空图（闭包给 {}）⇒ 200 明示 no-op（不投递、不失败；≠ 从未拉到）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const port = await startRelay(() => ({}));
      const res = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(res.status).toBe(200);
      expect(res.body).toBe('no sinks configured\n');
    });

    it('未配槽位不发（负对照：dingtalk stub 在监听但不在配置里 ⇒ 零请求）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const feishu = await newStub();
      const wecom = await newStub();
      const dingtalk = await newStub(); // 起而不用：负对照的观测点
      const port = await startRelay(() => ({ feishu: { url: feishu.baseUrl }, wecom: { url: wecom.baseUrl } }));

      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(feishu.requests).toHaveLength(1);
      expect(wecom.requests).toHaveLength(1);
      expect(dingtalk.requests).toHaveLength(0);
    });
  });

  describe('三态判别力：从未拉到（500）vs 成功空图（200）vs 有槽（扇出）', () => {
    it('同一实例换闭包：null ⇒ 500 `notify config unavailable`（守卫仍先于 500）；{} ⇒ 200 no-op；有槽 ⇒ 投递', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const feishu = await newStub();
      let cfgNow: SinkConfigs | null = null;
      const port = await startRelay(() => cfgNow);

      // 守卫先于 500 分支（无 Bearer ⇒ 401，不是 500）
      expect((await postWebhook(port, JSON.stringify(PAYLOAD), null)).status).toBe(401);

      const never = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(never.status).toBe(500);
      expect(never.body).toBe('notify config unavailable\n');
      expect(feishu.requests).toHaveLength(0); // 500 路径出站零请求

      cfgNow = {}; // 成功空图（有效图）
      const empty = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(empty.status).toBe(200);
      expect(empty.body).toBe('no sinks configured\n');

      cfgNow = { feishu: { url: feishu.baseUrl } }; // 拉到图
      const ready = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(ready.status).toBe(200);
      expect(ready.body).toBe('ok\n');
      expect(feishu.requests).toHaveLength(1);
    });

    it('缺省闭包（未接线）⇒ 恒 500（fail-closed 缺省：未知按未拉到处理）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const port = await freePort();
      closers.push(startRelayServer({ port }, { clock: () => CLOCK_MS }));
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(500);
    });

    it('热更新换槽：闭包换新引用 ⇒ 下一请求走新地址、旧地址不再增长；切回 null ⇒ 500', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const stubA = await newStub();
      const stubB = await newStub();
      let cfgNow: SinkConfigs | null = { feishu: { url: stubA.baseUrl } };
      const port = await startRelay(() => cfgNow);

      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(stubA.requests).toHaveLength(1);

      cfgNow = { feishu: { url: stubB.baseUrl } }; // 下一轮拉取的新引用
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(stubB.requests).toHaveLength(1);
      expect(stubA.requests).toHaveLength(1); // 旧地址不再增长

      cfgNow = null; // 回落「从未拉到」
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(500);
    });
  });

  describe('请求体校验', () => {
    it('非法 JSON / 非对象 ⇒ 400（错误不回声正文），且出站零请求', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port, feishu } = await startFullRelay();

      for (const body of ['{not json', '[]', '"str"', 'null']) {
        const res = await postWebhook(port, body);
        expect(res.status, body).toBe(400);
        expect(res.body).toBe('bad request\n');
        expect(res.body).not.toContain(body); // 不回声
      }
      expect(feishu.requests).toHaveLength(0);
    });

    it('请求体超上限 ⇒ 413（上限本身是防内存面；先排空再应答，客户端行为确定）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port, feishu } = await startFullRelay();

      const res = await postWebhook(port, 'x'.repeat(MAX_BODY_BYTES + 16));

      expect(res.status).toBe(413);
      expect(res.body).toBe('payload too large\n');
      expect(feishu.requests).toHaveLength(0);
    });
  });

  describe('GET /metrics（Bearer 守卫 + alert_deliveries_total + 默认集）', () => {
    it('带守卫；输出含 alert_deliveries_total（按 {sink,result}）与 prom-client 默认集', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const { port } = await startFullRelay();

      const before = await metricValue(port, 'feishu', 'ok');
      await postWebhook(port, JSON.stringify(PAYLOAD));

      const unauth = await httpCall({ port, path: '/metrics' });
      expect(unauth.status).toBe(401);

      const res = await httpCall({ port, path: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; version=0.0.4');
      expect(res.body).toMatch(/^# TYPE alert_deliveries_total counter$/m);
      expect(res.body).toMatch(/^# TYPE process_cpu_user_seconds_total /m); // 默认集（不经 shared，本包自带 registry）
      expect(await metricValue(port, 'feishu', 'ok')).toBe(before + 1); // feishu stub 本次是 200
    });
  });

  describe('URL/secret 永不进日志/指标（S2③）', () => {
    it('成功与失败两条路径的日志只有 sink 名与状态码；哨兵值不出现在任何 console 输出与 /metrics 里', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      // 捕获全部 console.*（并消音 —— 这些行在本测试里是被审对象）。
      const captured: string[] = [];
      for (const name of ['log', 'warn', 'error'] as const) {
        vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
          captured.push(args.map((a) => String(a)).join(' '));
        });
      }

      const deadPort = await freePort(); // 没人听 ⇒ 连接层错误（错误原文最可能带 URL 的路径）
      const wecom = await newStub();
      const dingtalk = await newStub();
      dingtalk.status = 500; // 有响应的失败路径
      const port = await startRelay(() => ({
        feishu: { url: `http://127.0.0.1:${deadPort}/SENTINEL-URL-PATH?token=SENTINEL-TOKEN` },
        wecom: { url: wecom.baseUrl },
        dingtalk: { url: `${dingtalk.baseUrl}?access_token=SENTINEL-TOKEN`, secret: 'SENTINEL-SECRET' },
      }));

      const res = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(res.status).toBe(200); // wecom 成功

      const logs = captured.join('\n');
      for (const sentinel of ['SENTINEL-URL-PATH', 'SENTINEL-TOKEN', 'SENTINEL-SECRET', '127.0.0.1', 'http']) {
        expect(logs, `日志泄漏了 ${sentinel}`).not.toContain(sentinel);
      }

      // 「日志只允许 sink 名与状态码」：逐行结构断言（键恰为 sink/status，顺序即槽位顺序）。
      const lines = captured.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toEqual([
        { sink: 'feishu', status: 0 }, // 连接层失败 ⇒ 无响应可记 ⇒ 0
        { sink: 'dingtalk', status: 500 },
        { sink: 'wecom', status: 200 },
      ]);

      // 指标面同样不许出现凭据（标签只有 {sink,result}）。
      const metrics = await httpCall({ port, path: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
      for (const sentinel of ['SENTINEL-URL-PATH', 'SENTINEL-TOKEN', 'SENTINEL-SECRET', '127.0.0.1']) {
        expect(metrics.body).not.toContain(sentinel);
      }

      // 捕获器判别力自证：注入一条真泄漏，它必须被看得见（防「零命中 = 探针瞎了」）。
      console.error('SENTINEL-TOKEN');
      expect(captured.join('\n')).toContain('SENTINEL-TOKEN');
    });
  });

  describe('轮询衔接（startNotifyLoop：拉取 ⇒ 裁剪 ⇒ 整图替换 ⇒ 持久化 ⇒ 重算槽位）', () => {
    it('首拉即用：九键图被裁剪后整图替换（SMTP 不落盘）+ /webhook 由 500 转可投', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const feishu = await newStub();
      const state: RelayRuntimeState = { lastGood: null };
      const port = await startRelay(() => sinkConfigsFromState(state));

      // 首拉前 = 从未拉到 ⇒ 500
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(500);

      const pulled: NotifyValues = {
        'notify.smtp.host': 'smtp.invalid',
        'notify.smtp.port': '465',
        'notify.smtp.user': 'probe@example.invalid',
        'notify.smtp.pass': 'probe-pass',
        'notify.email.to': 'probe@example.invalid',
        'notify.webhook.feishuUrl': feishu.baseUrl,
      };
      const persisted: NotifyValues[] = [];
      const loop = startNotifyLoop(state, {
        pull: async () => pulled,
        persist: async (values) => {
          persisted.push(values);
        },
        intervalMs: 60_000, // 手推；不让定时器掺和本用例
      });
      loops.push(loop);
      await loop.firstTick;

      const trimmed = { 'notify.webhook.feishuUrl': feishu.baseUrl };
      expect(state.lastGood).toEqual(trimmed); // 整图替换 = 裁剪后四键图
      expect(persisted).toEqual([trimmed]); // 只落四键（SMTP 进程内即弃、不落盘）

      const res = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(res.status).toBe(200);
      expect(feishu.requests).toHaveLength(1);
    });

    it('拉取失败 ⇒ WARN 逐字（状态变化时一条）、保持 last-good 可投；恢复后再失败会再报', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const stubA = await newStub();
      const stubB = await newStub();
      const state: RelayRuntimeState = { lastGood: null };
      const port = await startRelay(() => sinkConfigsFromState(state));
      const warnings = captureWarnings();

      const loop = startNotifyLoop(state, {
        pull: scriptedPull([
          { 'notify.webhook.feishuUrl': stubA.baseUrl },
          new Error('config-service down'),
          new Error('config-service down'),
          { 'notify.webhook.feishuUrl': stubB.baseUrl },
          new Error('config-service down'),
        ]),
        persist: async () => {},
        intervalMs: 60_000,
      });
      loops.push(loop);

      await loop.firstTick; // 成功（A）
      expect(state.lastGood).toEqual({ 'notify.webhook.feishuUrl': stubA.baseUrl });

      await loop.tick(); // 失败 #1 ⇒ 恰好一条 WARN
      expect(warnings.filter((l) => l === PULL_FAIL_WARN)).toHaveLength(1);
      // 保持上次成功值：仍可投递、仍打 A
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(stubA.requests).toHaveLength(1);

      await loop.tick(); // 失败 #2 ⇒ 不刷屏（仍一条）
      expect(warnings.filter((l) => l === PULL_FAIL_WARN)).toHaveLength(1);

      await loop.tick(); // 恢复（B）⇒ 复位
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(stubB.requests).toHaveLength(1);

      await loop.tick(); // 再失败 ⇒ 状态变化 ⇒ 第二条
      expect(warnings.filter((l) => l === PULL_FAIL_WARN)).toHaveLength(2);

      // 日志纪律：WARN 行不含任何值（本用例的哨兵 = stub 地址）。
      expect(warnings.join('\n')).not.toContain(stubA.baseUrl);
      expect(warnings.join('\n')).not.toContain(stubB.baseUrl);
    });

    it('钉钉半配 ⇒ 该槽停用 + WARN 逐字（状态变化时一条；整配↔半配往返各一条）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const feishu = await newStub();
      const dingtalk = await newStub();
      const state: RelayRuntimeState = { lastGood: null };
      const port = await startRelay(() => sinkConfigsFromState(state));
      const warnings = captureWarnings();

      const HALF: NotifyValues = {
        'notify.webhook.feishuUrl': feishu.baseUrl,
        'notify.webhook.dingtalkUrl': `${dingtalk.baseUrl}?access_token=tk`,
      };
      const FULL: NotifyValues = { ...HALF, 'notify.webhook.dingtalkSecret': 'a-secret' };

      const loop = startNotifyLoop(state, {
        pull: scriptedPull([HALF, HALF, FULL, HALF]),
        persist: async () => {},
        intervalMs: 60_000,
      });
      loops.push(loop);

      await loop.firstTick; // 进入半配 ⇒ 一条 WARN；半配图仍是有效整图（挂起的是派生槽位）
      expect(warnings.filter((l) => l === HALF_WARN)).toHaveLength(1);
      expect(state.lastGood).toEqual(HALF);

      const halfRes = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(halfRes.status).toBe(200);
      expect(feishu.requests).toHaveLength(1);
      expect(dingtalk.requests).toHaveLength(0); // 半配槽不出站

      await loop.tick(); // 半配持续 ⇒ 不重复报
      expect(warnings.filter((l) => l === HALF_WARN)).toHaveLength(1);

      await loop.tick(); // 转整配 ⇒ 钉钉开始出站
      const fullRes = await postWebhook(port, JSON.stringify(PAYLOAD));
      expect(fullRes.status).toBe(200);
      expect(dingtalk.requests).toHaveLength(1);

      await loop.tick(); // 再转半配 ⇒ 状态变化 ⇒ 第二条
      expect(warnings.filter((l) => l === HALF_WARN)).toHaveLength(2);
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(dingtalk.requests).toHaveLength(1); // 停用后不再增长
    });

    it('定时器在轮询（intervalMs 短值时 ≥2 轮；firstTick = 启动立即先拉一次）', async () => {
      const state: RelayRuntimeState = { lastGood: null };
      let calls = 0;
      const loop = startNotifyLoop(state, {
        pull: async () => {
          calls += 1;
          return { 'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu' };
        },
        persist: async () => {},
        intervalMs: 25,
      });
      loops.push(loop);

      await loop.firstTick;
      expect(calls).toBe(1); // 立即先拉一次（⚙️8）
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 10 });
    });

    it('持久化失败 ⇒ 内存 last-good 保持可投 + WARN 状态变化一条（恢复后再坏再报）', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
      const feishu = await newStub();
      const state: RelayRuntimeState = { lastGood: null };
      const port = await startRelay(() => sinkConfigsFromState(state));
      const warnings = captureWarnings();
      const PERSIST_FAIL_WARN = '通知配置持久化失败（last-good 仅存内存）';

      let persistFails = true;
      const loop = startNotifyLoop(state, {
        pull: async () => ({ 'notify.webhook.feishuUrl': feishu.baseUrl }),
        persist: async () => {
          if (persistFails) throw new Error('disk full');
        },
        intervalMs: 60_000,
      });
      loops.push(loop);

      await loop.firstTick;
      expect(warnings.filter((l) => l === PERSIST_FAIL_WARN)).toHaveLength(1);
      await loop.tick();
      expect(warnings.filter((l) => l === PERSIST_FAIL_WARN)).toHaveLength(1); // 持续失败不刷屏

      // 内存值照常生效（持久化只是重启存活面，不挡本进程投递）
      expect((await postWebhook(port, JSON.stringify(PAYLOAD))).status).toBe(200);
      expect(feishu.requests).toHaveLength(1);

      persistFails = false;
      await loop.tick(); // 恢复 ⇒ 复位
      persistFails = true;
      await loop.tick(); // 再坏 ⇒ 第二条
      expect(warnings.filter((l) => l === PERSIST_FAIL_WARN)).toHaveLength(2);
    });

    it('兜底：自身代码级异常也不外抛（D4「任何异常不得打穿常驻进程」），状态回退保持', async () => {
      const state: RelayRuntimeState = { lastGood: null };
      const warnings = captureWarnings();
      const steps: unknown[] = [null, { 'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu' }];

      const loop = startNotifyLoop(state, {
        // null 进 trimForRelay ⇒ 内部 TypeError（模拟「不该发生的」代码级异常）
        pull: async () => steps.shift() as NotifyValues,
        persist: async () => {},
        intervalMs: 60_000,
      });
      loops.push(loop);

      await loop.firstTick; // 必须 resolve（不外抛），状态保持
      expect(state.lastGood).toBeNull();
      expect(warnings.filter((l) => l.includes('轮询内部错误'))).toHaveLength(1);

      await loop.tick(); // 下一轮照常工作
      expect(state.lastGood).toEqual({ 'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu' });
    });
  });
});
