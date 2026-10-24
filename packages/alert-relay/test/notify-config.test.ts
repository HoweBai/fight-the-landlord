import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import {
  NOTIFY_PULL_INTERVAL_MS,
  NOTIFY_PULL_TIMEOUT_MS,
  pullNotifyConfig,
  readLastGood,
  trimForRelay,
  writeLastGood,
} from '../src/notify-config';
import type { NotifyValues } from '../src/config';
import { RELAY_IM_KEYS } from '../src/config';
import { freePort, jsonFrame, startJsonStub } from './helpers';
import type { JsonStubServer } from './helpers';

/**
 * T12 单测半边之一：**拉取客户端线格式（⚙️8）+ 裁剪（⚙️9）+ last-good 持久化（⚙️9）**。
 *
 * - 线格式判据照 `tools/conformance/src/lib/rpc.ts:131-241` 的解析纪律：按字符计长、`#` 分帧、
 *   `id` 回验、`RpcResult` 信封检查（多字节值用例钉「字符数 ≠ 字节数」）。
 * - 失败的三种形态（传输故障 / 坏帧 / 业务错）**一律 throw**，且错误消息**不回显任何值**
 *   （回包正文可能含 URL 凭据 —— 哨兵机械断言）。
 * - 持久化：原子写（tmp+rename，无残留）、600、读失败（不存在静默 / 损坏 WARN）均按 `null`。
 */

const TOKEN = 'pull-token-under-test';

/** rpc env 的等价体（host/port 指向进程内 stub）。 */
function rpcEnv(stub: JsonStubServer, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NOTIFY_CHANNEL_PULL_TOKEN: TOKEN,
    CONFIG_SERVICE_RPC_HOST: '127.0.0.1',
    CONFIG_SERVICE_RPC_PORT: String(stub.port),
    ...extra,
  };
}

describe('pullNotifyConfig：JsonSocket 线格式（⚙️8）与失败语义（§3.3：故障/业务错不分码，一律 throw）', () => {
  let stub: JsonStubServer;

  beforeEach(async () => {
    stub = await startJsonStub();
  });
  afterEach(async () => {
    await stub.close();
    vi.restoreAllMocks();
  });

  it('成功：pattern 逐字来自 protocol 常量、令牌逐字、**无 meta**；values 原样返回（多字节值证明按字符计长）', async () => {
    const values = {
      'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu?名称=值', // 多字节：帧长按字符算才切得对
      'notify.webhook.wecomUrl': 'http://127.0.0.1:9/wecom',
    };
    stub.responder = (req) => jsonFrame({ id: req.id, response: { ok: true, data: { values } } });

    await expect(pullNotifyConfig(rpcEnv(stub))).resolves.toEqual(values);

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.pattern).toBe(RPC_PATTERNS.configNotifyChannelGet);
    expect(stub.requests[0]!.pattern).toBe('config.notifyChannel.get'); // 逐字钉子（两处同源）
    expect(stub.requests[0]!.data).toEqual({ pullToken: TOKEN });
    expect('meta' in stub.requests[0]!.data).toBe(false); // ⚙️8：不带 meta
  });

  it('成功空图（{} 亦为有效图）⇒ 返回 {}；不抛', async () => {
    stub.responder = (req) => jsonFrame({ id: req.id, response: { ok: true, data: { values: {} } } });
    await expect(pullNotifyConfig(rpcEnv(stub))).resolves.toEqual({});
  });

  it('每次调用**一条新连接**（两次调用 ⇒ 两条 TCP 连接、两个不同 id）', async () => {
    await pullNotifyConfig(rpcEnv(stub));
    await pullNotifyConfig(rpcEnv(stub));

    expect(stub.connections).toBe(2);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.id).not.toBe(stub.requests[1]!.id);
  });

  it('业务错（ok:false / code 10002）⇒ throw（不分码）；错误消息不回显服务端 message 与令牌', async () => {
    stub.responder = (req) =>
      jsonFrame({ id: req.id, response: { ok: false, code: 10002, message: '拉取令牌不匹配' } });

    let caught: unknown;
    try {
      await pullNotifyConfig(rpcEnv(stub));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('10002'); // code = 类别，允许
    expect((caught as Error).message).not.toContain(TOKEN); // 令牌（值）绝不回显
  });

  it('err 包（服务端无 handler 形态）⇒ throw', async () => {
    stub.responder = (req) => jsonFrame({ id: req.id, err: 'no handler' });
    await expect(pullNotifyConfig(rpcEnv(stub))).rejects.toThrow(/通知配置拉取失败（服务端返回 err/);
  });

  it('坏帧：长度前缀不是数字 / 前缀对但正文非 JSON ⇒ throw，且**不回显回包原文**', async () => {
    stub.responder = () => 'abc#{"id":"x"}';
    await expect(pullNotifyConfig(rpcEnv(stub))).rejects.toThrow(/分帧长度前缀不是数字/);

    const garbage = 'SENTINEL-NOT-JSON';
    stub.responder = () => `${garbage.length}#${garbage}`; // 前缀合法（按字符）、正文不是 JSON
    let caught: unknown;
    try {
      await pullNotifyConfig(rpcEnv(stub));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('回包不是合法 JSON');
    expect((caught as Error).message).not.toContain('SENTINEL'); // 原文（可能含凭据）不回显
  });

  it('id 不匹配 ⇒ throw；即便回包里带凭据哨兵也不回显', async () => {
    stub.responder = (req) =>
      jsonFrame({
        id: `${req.id}-不是这个`,
        response: { ok: true, data: { values: { 'notify.webhook.feishuUrl': 'http://SENTINEL-URL/' } } },
      });

    let caught: unknown;
    try {
      await pullNotifyConfig(rpcEnv(stub));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('回包 id 不匹配');
    expect((caught as Error).message).not.toContain('SENTINEL-URL');
  });

  it('response 不是 RpcResult 信封 / values 不是对象 ⇒ throw', async () => {
    stub.responder = (req) => jsonFrame({ id: req.id, response: { values: {} } }); // 无 ok 字段
    await expect(pullNotifyConfig(rpcEnv(stub))).rejects.toThrow(/不是 RpcResult 信封/);

    stub.responder = (req) => jsonFrame({ id: req.id, response: { ok: true, data: {} } }); // 缺 values
    await expect(pullNotifyConfig(rpcEnv(stub))).rejects.toThrow(/data\.values 不是对象/);

    stub.responder = (req) => jsonFrame({ id: req.id, response: { ok: true, data: { values: [] } } }); // 数组
    await expect(pullNotifyConfig(rpcEnv(stub))).rejects.toThrow(/data\.values 不是对象/);
  });

  it('对端挂起 ⇒ 超时 throw（短时替身；耗时 ≥ 超时且远小于生产 3000ms）', async () => {
    stub.responder = () => null; // 收下请求，永不响应

    const started = Date.now();
    await expect(pullNotifyConfig(rpcEnv(stub), { timeoutMs: 150 })).rejects.toThrow(/超时 150ms/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2000);
  });

  it('连不上（端口无监听）⇒ throw（连接失败类别）；端口非法 ⇒ throw（不发连接）', async () => {
    const deadPort = await freePort(); // 无人监听
    await expect(
      pullNotifyConfig({ ...rpcEnv(stub), CONFIG_SERVICE_RPC_PORT: String(deadPort) }),
    ).rejects.toThrow(/连接失败/);

    await expect(pullNotifyConfig(rpcEnv(stub, { CONFIG_SERVICE_RPC_PORT: '不是端口' }))).rejects.toThrow(
      /CONFIG_SERVICE_RPC_PORT 不是合法端口/,
    );
    expect(stub.requests).toHaveLength(0); // 端口非法在连接**之前**就拒绝
  });

  it('常量钉死（⚙️8：30s 周期 / 3000ms 单次超时）', () => {
    expect(NOTIFY_PULL_INTERVAL_MS).toBe(30_000);
    expect(NOTIFY_PULL_TIMEOUT_MS).toBe(3000);
  });
});

describe('trimForRelay：拉后即裁（只保留四 IM 键；SMTP 五键进程内即弃、不落盘）', () => {
  const NINE: NotifyValues = {
    'notify.smtp.host': 'smtp.invalid',
    'notify.smtp.port': '465',
    'notify.smtp.user': 'probe@example.invalid',
    'notify.smtp.pass': 'probe-pass',
    'notify.email.to': 'probe@example.invalid',
    'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu',
    'notify.webhook.wecomUrl': 'http://127.0.0.1:9/wecom',
    'notify.webhook.dingtalkUrl': 'http://127.0.0.1:9/dingtalk?access_token=tk',
    'notify.webhook.dingtalkSecret': 'dt-secret',
  };

  it('九键图 ⇒ 恰四 IM 键（顺序 = 拉取地图组装序）；JSON 里无 smtp 子串', () => {
    const out = trimForRelay(NINE);
    expect(Object.keys(out)).toEqual([...RELAY_IM_KEYS]);
    expect(out).toEqual({
      'notify.webhook.feishuUrl': NINE['notify.webhook.feishuUrl'],
      'notify.webhook.wecomUrl': NINE['notify.webhook.wecomUrl'],
      'notify.webhook.dingtalkUrl': NINE['notify.webhook.dingtalkUrl'],
      'notify.webhook.dingtalkSecret': NINE['notify.webhook.dingtalkSecret'],
    });
    expect(JSON.stringify(out)).not.toContain('smtp');
  });

  it('空串/空白值 = 未设 ⇒ 键被丢弃（全仓口径）；值逐字（不裁剪空白）', () => {
    const out = trimForRelay({
      'notify.webhook.feishuUrl': '  http://127.0.0.1:9/feishu  ',
      'notify.webhook.wecomUrl': '',
      'notify.webhook.dingtalkUrl': '   ',
      'notify.webhook.dingtalkSecret': 'dt-secret',
    });
    expect(out).toEqual({
      'notify.webhook.feishuUrl': '  http://127.0.0.1:9/feishu  ', // 逐字（在场判定用 trim，值不裁）
      'notify.webhook.dingtalkSecret': 'dt-secret',
    });
  });

  it('非字符串值丢弃（防御性；类型外输入），未修改入参，返回新对象', () => {
    const input = {
      'notify.webhook.feishuUrl': 42,
      'notify.webhook.wecomUrl': 'http://127.0.0.1:9/wecom',
    } as unknown as NotifyValues;
    const out = trimForRelay(input);
    expect(out).toEqual({ 'notify.webhook.wecomUrl': 'http://127.0.0.1:9/wecom' });
    expect(out).not.toBe(input);
    expect(input).toEqual({ 'notify.webhook.feishuUrl': 42, 'notify.webhook.wecomUrl': 'http://127.0.0.1:9/wecom' });
  });

  it('空图 ⇒ 空图（`{}` 是**有效图**：成功空图 ≠ 从未拉到）', () => {
    expect(trimForRelay({})).toEqual({});
  });
});

describe('last-good 持久化（⚙️9：/data 语义的临时目录替身 —— 原子写 / 600 / 读失败均按 null）', () => {
  const FOUR: NotifyValues = {
    'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu',
    'notify.webhook.dingtalkUrl': 'http://127.0.0.1:9/dingtalk?access_token=tk',
    'notify.webhook.dingtalkSecret': 'dt-secret',
  };

  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-lastgood-'));
    file = join(dir, 'notify-config.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('往返：写入 ⇒ 读回同一图；文件是 JSON 对象、无 .tmp 残留、无 smtp 子串', async () => {
    await writeLastGood({ ...FOUR, 'notify.smtp.pass': 'probe-pass' } as NotifyValues, file);

    await expect(readLastGood(file)).resolves.toEqual(FOUR);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(FOUR);
    expect(await readFile(file, 'utf8')).not.toContain('smtp');
    await expect(stat(`${file}.tmp`)).rejects.toThrow(); // 原子写后无残留
  });

  it('600（POSIX；Windows 无 POSIX mode 语义 ⇒ 只断言文件在场）', async () => {
    await writeLastGood(FOUR, file);
    const st = await stat(file);
    expect(st.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('写**总是**先裁剪：九键图 ⇒ 文件只含四键（文件不变量不依赖调用方纪律，⑧d）', async () => {
    const nine: NotifyValues = {
      'notify.smtp.host': 'smtp.invalid',
      'notify.smtp.port': '465',
      'notify.smtp.user': 'probe@example.invalid',
      'notify.smtp.pass': 'probe-pass',
      'notify.email.to': 'probe@example.invalid',
      ...FOUR,
    };
    await writeLastGood(nine, file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(FOUR);
  });

  it('整图替换：先写四键再写 {} ⇒ 读回 {}（不是「合并」；文件在场 = 成功过）', async () => {
    await writeLastGood(FOUR, file);
    await writeLastGood({}, file);
    await expect(readLastGood(file)).resolves.toEqual({});
  });

  it('文件不存在 ⇒ 静默 null（console 零调用 —— 首启的正常形态）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readLastGood(file)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('损坏（非 JSON / 非对象的 JSON：数组/数字/字符串/null）⇒ WARN + null，消息不回显文件内容', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const bad of ['SENTINEL-CORRUPT', '[]', '42', '"str"', 'null', '']) {
      warn.mockClear();
      await writeFile(file, bad, 'utf8');
      await expect(readLastGood(file), `坏内容=${JSON.stringify(bad)}`).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('损坏');
      expect(message).not.toContain('SENTINEL'); // 不回显文件内容
    }
  });

  it('读失败（路径是目录等 IO 错）⇒ WARN + null（与「不存在」区分）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readLastGood(dir)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('不可读');
  });

  it('外力塞入额外键（如 SMTP）⇒ 读回归一化为四键（裁剪是安全方向）', async () => {
    await writeFile(
      file,
      JSON.stringify({ ...FOUR, 'notify.smtp.pass': 'probe-pass' }),
      'utf8',
    );
    await expect(readLastGood(file)).resolves.toEqual(FOUR);
  });
});
