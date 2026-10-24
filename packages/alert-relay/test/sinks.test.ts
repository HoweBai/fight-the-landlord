import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OUTBOUND_TIMEOUT_MS, configuredSinkNames, createSinks } from '../src/sinks';
import type { FormattedMessage } from '../src/format';
import { freePort, startStub } from './helpers';
import type { StubServer } from './helpers';

/**
 * C8 单测半边：**三 sink 的线上字节**（规格 §2.6「三 sink」段）。
 *
 * 载荷断言读的是 stub **真正收到的原始请求体**（不是被实现的构造器回显）——
 * 「golden 载荷逐字」要钉的是上线字节，中间多一层回显就少一层判别力。
 *
 * 钉钉签名走**固定时钟注入**（`clock`）+ sign.test.ts 的外部对照向量：本文件里
 * URL 期望值同样是硬编码字面量（`DINGTALK_SIGN_ENCODED`），不现算。
 */

const MSG: FormattedMessage = {
  title: '[critical] ServiceDown',
  body: '- api-gateway/api-gateway:9000 · api-gateway 抓不到了 · 开始 2026-10-03 04:00 UTC · 持续 5m',
};

const DINGTALK_CLOCK_MS = 1579659829250; // sign.test.ts 的向量 1 同款
const DINGTALK_SECRET = 'SEC5b17d83d0e2627c5f6aac34d78912ab2a91221f307dbe0bab7c7a268cec8c916';
const DINGTALK_SIGN_ENCODED = 'Exy6a4GAAJ7WliaOkGZ14WzlEeuWP7npnn%2BDvqtkbxI%3D';

describe('createSinks：golden 载荷逐字（C8）', () => {
  let stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.map((s) => s.close()));
    stubs = [];
  });
  async function stub(): Promise<StubServer> {
    const s = await startStub();
    stubs.push(s);
    return s;
  }

  it('飞书：{"msg_type":"text","content":{"text":"标题\\n正文"}}，POST + application/json', async () => {
    const feishu = await stub();
    const [sink] = createSinks({ feishu: { url: feishu.baseUrl } });
    expect(sink.name).toBe('feishu');

    const result = await sink.deliver(MSG);

    expect(result).toEqual({ sink: 'feishu', ok: true, status: 200 });
    expect(feishu.requests).toHaveLength(1);
    const req = feishu.requests[0];
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toBe(
      JSON.stringify({
        msg_type: 'text',
        content: { text: `${MSG.title}\n${MSG.body}` },
      }),
    );
  });

  it('企业微信：{"msgtype":"markdown","markdown":{"content":"**标题**\\n正文"}}', async () => {
    const wecom = await stub();
    const [sink] = createSinks({ wecom: { url: wecom.baseUrl } });
    expect(sink.name).toBe('wecom');

    const result = await sink.deliver(MSG);

    expect(result).toEqual({ sink: 'wecom', ok: true, status: 200 });
    expect(wecom.requests).toHaveLength(1);
    expect(wecom.requests[0].body).toBe(
      JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: `**${MSG.title}**\n${MSG.body}` },
      }),
    );
  });

  it('钉钉：markdown{title,text} + URL 带毫秒 timestamp 与 percent-encode 的 sign（固定时钟向量）', async () => {
    const dingtalk = await stub();
    const url = `${dingtalk.baseUrl}?access_token=stub-tk`;
    const [sink] = createSinks({ dingtalk: { url, secret: DINGTALK_SECRET } }, { clock: () => DINGTALK_CLOCK_MS });
    expect(sink.name).toBe('dingtalk');

    const result = await sink.deliver(MSG);

    expect(result).toEqual({ sink: 'dingtalk', ok: true, status: 200 });
    expect(dingtalk.requests).toHaveLength(1);
    const req = dingtalk.requests[0];
    expect(req.url).toBe(
      `/hook?access_token=stub-tk&timestamp=${DINGTALK_CLOCK_MS}&sign=${DINGTALK_SIGN_ENCODED}`,
    );
    expect(req.body).toBe(
      JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: MSG.title, text: `**${MSG.title}**\n${MSG.body}` },
      }),
    );
  });

  it('槽位全集为空 ⇒ 零 sink（空串已被 config 归一到「未设」；这里钉 createSinks 的边界）', () => {
    expect(createSinks({})).toEqual([]);
    expect(configuredSinkNames({})).toEqual([]);
  });

  it('槽位顺序固定 feishu → dingtalk → wecom（结果数组/日志顺序可预期）', async () => {
    const s = await stub();
    const sinks = createSinks({
      feishu: { url: s.baseUrl },
      wecom: { url: s.baseUrl },
      dingtalk: { url: `${s.baseUrl}?access_token=tk`, secret: 'x' },
    });
    expect(sinks.map((x) => x.name)).toEqual(['feishu', 'dingtalk', 'wecom']);
  });
});

describe('出站契约：超时、失败不外抛、状态码语义（C8）', () => {
  let stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.map((s) => s.close()));
    stubs = [];
  });

  it('超时常量 = 5000ms（规格钉死）', () => {
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(5000);
  });

  it('响应非 2xx ⇒ {ok:false,status:500}（封装为结果，**不抛**：单槽失败隔离的前提）', async () => {
    const s = await startStub();
    stubs.push(s);
    s.status = 500;
    const [sink] = createSinks({ wecom: { url: s.baseUrl } });
    await expect(sink.deliver(MSG)).resolves.toEqual({ sink: 'wecom', ok: false, status: 500 });
  });

  it('出站超时（对端挂起）⇒ {ok:false,status:0}，且 AbortSignal 真的切断了等待', async () => {
    const s = await startStub();
    stubs.push(s);
    s.hang = true;
    const [sink] = createSinks({ feishu: { url: s.baseUrl } }, { timeoutMs: 80 });

    const started = Date.now();
    const result = await sink.deliver(MSG);

    expect(result).toEqual({ sink: 'feishu', ok: false, status: 0 });
    // 若超时没接上，这里的耗时会一直拖到 vitest 的 5s 用例超时 —— 显式收窄成快速失败。
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('连接层错误（端口没人听）⇒ {ok:false,status:0}（错误原文不落任何可见面，见 server.test.ts 的日志捕获）', async () => {
    const deadPort = await freePort(); // 探针占过又放了 ⇒ 此刻必然没人监听
    const [sink] = createSinks({ feishu: { url: `http://127.0.0.1:${deadPort}/hook` } });
    await expect(sink.deliver(MSG)).resolves.toEqual({ sink: 'feishu', ok: false, status: 0 });
  });
});
