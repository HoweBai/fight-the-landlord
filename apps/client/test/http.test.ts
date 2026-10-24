/**
 * REST 的**传输适配器**（`src/net/http.ts`）与端点校验（切片 P17 的 R549/R550/R551/R553）。
 *
 * 这一片要关闭的事实（实测）：小程序产物里 REST 是**裸 `fetch`**，而产物里没有 fetch 的
 * polyfill ⇒ 注册/登录第一步就 `fetch is not defined`。因此这里的用例分三组：
 *
 *  ① 小程序分支（假 `uni.request`）：URL / 方法 / 头 / 体 / 状态码 / 文本归一，且归一出来的
 *     `text` 能被 `rest.ts` 的信封解析真正吃下（不是「形状像」而已）；
 *  ② 浏览器分支：仍然走 `fetch`，且 `uni.request` **一次都没被调用**（负对照）；
 *  ③ 端点校验（R550/R551/R632）：相对 `VITE_API_BASE` + 无「同源」平台（小程序/**App**）⇒ 抛错；
 *     空 `VITE_WS_ENDPOINT` ⇒ 抛错；其它平台 ⇒ 明确报错（不静默退化成浏览器路径）；
 *  ④ 机械闸（R553）：`src/**` 里**只有** `net/http.ts` 可以出现裸 `fetch(`，带判别力自证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ENDPOINT_BUILD_COMMAND, MP_ENDPOINT_BUILD_COMMAND, clientConfig } from '../src/config';
import {
  REQUIRE_ABSOLUTE_ENDPOINT,
  TransportFailureError,
  requestJson,
  resolveApiBase,
  resolveWsEndpoint,
} from '../src/net/http';
import * as rest from '../src/net/rest';
import { classifyPlatform } from '../src/net/mp-transport';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import { installUniStub, type UniStub } from './helpers/uni-stub';

const MP_API_BASE = 'http://192.168.1.5:3000/api';

let stub: UniStub;
/** `clientConfig` 是模块级可变对象（既有用例一直这么用），这里负责恢复。 */
let originalApiBase = '';

beforeEach(() => {
  originalApiBase = clientConfig.apiBase;
  stub = installUniStub(); // 默认 `web` —— H5 的真实取值
});

afterEach(() => {
  clientConfig.apiBase = originalApiBase;
  vi.unstubAllGlobals();
});

describe('① 小程序分支：REST 走 uni.request（R549）', () => {
  it('URL/方法/头/体按 rest.ts 的构造原样交给 uni.request，应答归一成 { statusCode, text }', async () => {
    stub = installUniStub({ platform: 'mp-weixin' });
    clientConfig.apiBase = MP_API_BASE;
    const envelope = {
      code: 0,
      message: 'ok',
      data: { accessToken: 'a1', refreshToken: 'r1', user: { id: 'u1' } },
    };
    // 真 uni 的 dataType 默认 json ⇒ 服务端返回 JSON 时 data 已经是**对象**
    stub.requestResponder = () => ({ statusCode: 200, data: envelope });

    const res = await requestJson({
      url: `${MP_API_BASE}/auth/login`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', password: 'pw' }),
    });

    expect(res).toEqual({ statusCode: 200, text: JSON.stringify(envelope) });
    const sent = stub.calls.request[0]!;
    expect(sent.url).toBe(`${MP_API_BASE}/auth/login`);
    expect(sent.method).toBe('POST');
    expect(sent.header).toEqual({ 'content-type': 'application/json' });
    expect(sent.data).toBe(JSON.stringify({ phone: '13800000000', password: 'pw' }));
  });

  it('归一出来的 text 能被 rest.ts 的信封解析吃下（不是「形状像」而已）', async () => {
    stub = installUniStub({ platform: 'mp-weixin' });
    clientConfig.apiBase = MP_API_BASE;
    stub.requestResponder = () => ({
      statusCode: 200,
      data: { code: 0, message: 'ok', data: { accessToken: 'a1', refreshToken: 'r1', user: { id: 'u1' } } },
    });

    const res = await rest.login('13800000000', 'pw');

    expect(res.code).toBe(0);
    expect(res.data?.accessToken).toBe('a1');
    expect(res.data?.refreshToken).toBe('r1');
    expect(res.data?.user.id).toBe('u1');
    // rest.ts 仍然从 clientConfig.apiBase 拼 URL（只是端点先过 R550 校验）
    expect(stub.calls.request[0]!.url).toBe(`${MP_API_BASE}/auth/login`);
    // 设备绑定片：登录载荷在既有业务字段后恒带域内 deviceId
    const body = JSON.parse(stub.calls.request[0]!.data as string) as Record<string, unknown>;
    expect(body).toMatchObject({ phone: '13800000000', password: 'pw' });
    expect(body.deviceId as string).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('data 是字符串（非 JSON 的 dataType 分支）⇒ 原样透传，不二次序列化', async () => {
    stub = installUniStub({ platform: 'mp-weixin' });
    stub.requestResponder = () => ({ statusCode: 502, data: '<html>502 Bad Gateway</html>' });

    const res = await requestJson({ url: `${MP_API_BASE}/rooms`, method: 'GET' });

    expect(res).toEqual({ statusCode: 502, text: '<html>502 Bad Gateway</html>' });
  });

  it('data 缺失（空体）⇒ text 为空串 ⇒ 由 rest.ts 既有的兜底落成 10007', async () => {
    stub = installUniStub({ platform: 'mp-weixin' });
    clientConfig.apiBase = MP_API_BASE;
    stub.requestResponder = () => ({ statusCode: 204, data: undefined });

    const res = await rest.rooms();

    expect(res.code).toBe(10007);
    expect(res.message).toContain('204');
  });
});

describe('④ App 分支：REST 必须走 uni.request（N39 —— App 的 service 侧没有可用的 fetch）', () => {
  it('uniPlatform=app ⇒ uni.request，且一次都不碰 fetch', async () => {
    // 实测复现（Android 基座，2026-09-19）：App 的 service 侧跑在 weexjsb 的 V8 上下文里，
    // `fetch` **有这个名字却不是函数** ⇒ 调用抛 `TypeError: fetch is not a function`，
    // 页面把原文显示在字段错误位（用户看到的就是「注册不了」）。
    const fetchMock = vi.fn(() => {
      throw new TypeError('fetch is not a function');
    });
    vi.stubGlobal('fetch', fetchMock);

    stub = installUniStub({ platform: 'app' });
    clientConfig.apiBase = MP_API_BASE;
    const envelope = {
      code: 0,
      message: 'ok',
      data: { accessToken: 'a1', refreshToken: 'r1', user: { id: 'u1' } },
    };
    stub.requestResponder = () => ({ statusCode: 200, data: envelope });

    const res = await rest.login('13900000002', 'Passw0rd!');

    expect(res.code).toBe(0);
    expect(res.data?.accessToken).toBe('a1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stub.calls.request).toHaveLength(1);
    expect(stub.calls.request[0]!.url).toBe(`${MP_API_BASE}/auth/login`);
  });

  it('负对照：`app` 不得再被判成 `browser`（判错就等于把上面那条路径交给 fetch）', () => {
    for (const platform of ['app', 'app-plus', 'app-android']) {
      expect(classifyPlatform(platform)).toBe('app');
    }
  });
});

describe('② 浏览器分支：仍然走 fetch，且 uni.request 一次都不调用（负对照）', () => {
  it('web 平台 ⇒ fetch，URL 仍是相对 base（同源约定不变）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await rest.rooms();

    expect(res.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/rooms');
    expect(stub.calls.request).toHaveLength(0);
  });

  it('uni 不存在（纯 web / SSR）⇒ 也走 fetch，不抛错', async () => {
    vi.stubGlobal('uni', undefined);
    const fetchMock = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await rest.login('13800000000', 'pw')).code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('H5 上 fetch 的拒绝仍然**原样抛出**（适配器只把小程序传输失败折成 10007）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(rest.rooms()).rejects.toThrow('Failed to fetch');
  });
});

describe('③ 平台判定：其它平台明确报错，不静默退化（R551）', () => {
  it('mp-alipay ⇒ 抛错（负对照：不得当成浏览器路径）', async () => {
    stub = installUniStub({ platform: 'mp-alipay' });

    await expect(requestJson({ url: '/api/rooms', method: 'GET' })).rejects.toThrow(
      /不支持的运行平台 uniPlatform=mp-alipay/,
    );
    expect(stub.calls.request).toHaveLength(0);
  });

  it('小程序传输失败（uni.request 的 fail）⇒ TransportFailureError，statusCode 语义为 0', async () => {
    stub = installUniStub({ platform: 'mp-weixin' });
    clientConfig.apiBase = MP_API_BASE;
    stub.requestResponder = null; // 替身默认：fail（说明「用例没有配置应答」）

    await expect(requestJson({ url: `${MP_API_BASE}/rooms`, method: 'GET' })).rejects.toBeInstanceOf(
      TransportFailureError,
    );
    await expect(requestJson({ url: `${MP_API_BASE}/rooms`, method: 'GET' })).rejects.toThrow(
      /statusCode: 0/,
    );
    // 与「拿到的不是平台信封」殊途同归：交给 rest.ts 既有的 parse 兜底 → 10007
    const res = await rest.rooms();
    expect(res.code).toBe(10007);
    expect(res.message).toContain('HTTP 0');
  });
});

describe('④ 端点校验：小程序端配错就响亮报错（R550）', () => {
  it('相对 VITE_API_BASE + mp-weixin ⇒ 抛错，消息点名变量并给出构建命令', () => {
    clientConfig.apiBase = '/api';
    installUniStub({ platform: 'mp-weixin' });

    expect(() => resolveApiBase()).toThrow(/VITE_API_BASE/);
    expect(() => resolveApiBase()).toThrow(MP_ENDPOINT_BUILD_COMMAND);
    expect(() => resolveApiBase()).toThrow(/"\/api"/);
  });

  it('相对 base + mp ⇒ 请求路径上也抛（不是只在解析函数里）', async () => {
    clientConfig.apiBase = '/api';
    installUniStub({ platform: 'mp-weixin' });

    await expect(rest.rooms()).rejects.toThrow(/VITE_API_BASE/);
    expect(stub.calls.request).toHaveLength(0);
  });

  it('绝对 base + mp-weixin ⇒ 不抛，原样返回', () => {
    clientConfig.apiBase = MP_API_BASE;
    installUniStub({ platform: 'mp-weixin' });

    expect(resolveApiBase()).toBe(MP_API_BASE);
  });

  it('相对 base + 浏览器 ⇒ 照旧返回（同源 / vite 代理约定不变）', () => {
    clientConfig.apiBase = '/api';

    expect(resolveApiBase()).toBe('/api');
    expect(resolveApiBase('browser')).toBe('/api');
  });

  it('空 VITE_WS_ENDPOINT + mp-weixin ⇒ 抛错，消息点名 VITE_WS_ENDPOINT 并给出构建命令', () => {
    expect(() => resolveWsEndpoint('', 'mp-weixin')).toThrow(/VITE_WS_ENDPOINT/);
    expect(() => resolveWsEndpoint('', 'mp-weixin')).toThrow(/build-mp-weixin\.mjs/);
    expect(() => resolveWsEndpoint('', 'mp-weixin')).toThrow(MP_ENDPOINT_BUILD_COMMAND);
  });

  // 修复轮 1：与 `VITE_API_BASE` 对称的第二条 —— 相对路径在小程序上同样必挂（R550）
  it('相对 VITE_WS_ENDPOINT + mp-weixin ⇒ 抛错，消息点名变量与构建命令', () => {
    expect(() => resolveWsEndpoint('/ws', 'mp-weixin')).toThrow(/VITE_WS_ENDPOINT/);
    expect(() => resolveWsEndpoint('/ws', 'mp-weixin')).toThrow(MP_ENDPOINT_BUILD_COMMAND);
    expect(() => resolveWsEndpoint('/ws', 'mp-weixin')).toThrow(/"\/ws"/);
  });

  it('这条校验只作用于 mp 分支：浏览器上相对 endpoint 照旧原样返回（H5 行为未动）', () => {
    expect(resolveWsEndpoint('/ws')).toBe('/ws');
  });

  it('绝对 endpoint（含来自 env 的）+ mp-weixin ⇒ 通过', () => {
    // .env.test 里 VITE_WS_ENDPOINT=http://localhost:3400（绝对 ⇒ 小程序端放行）
    expect(resolveWsEndpoint(undefined, 'mp-weixin')).toBe('http://localhost:3400');
    expect(resolveWsEndpoint('https://gw.example.test:443', 'mp-weixin')).toBe('https://gw.example.test:443');
  });

  it('浏览器路径的 WS 解析逐字保持原语义（`\'\'` = 同源；不给 = 读 env）', () => {
    // .env.test 里 VITE_WS_ENDPOINT=http://localhost:3400
    expect(resolveWsEndpoint()).toBe('http://localhost:3400');
    // `''` 是**明确要求同源**（`??` 的语义，见 clientConfig.wsEndpoint 的默认值）
    expect(resolveWsEndpoint('')).toBe(window.location.origin);
    expect(resolveWsEndpoint('http://example.test:9999')).toBe('http://example.test:9999');
    expect(resolveWsEndpoint('http://example.test:9999', 'mp-weixin')).toBe('http://example.test:9999');
  });

  it('显式给了绝对 endpoint 时，小程序端不因 env 为空而抛错', () => {
    expect(resolveWsEndpoint('http://192.168.1.5:3000', 'mp-weixin')).toBe('http://192.168.1.5:3000');
  });
});

// ---------------------------------------------------------------------------
// P26（R632/R633）：无「同源」平台 = mp-weixin **+ app**，同一条规则、集合唯一真源
// ---------------------------------------------------------------------------

describe('P26：无「同源」平台（mp-weixin + app）都必须显式绝对端点', () => {
  it('相对 VITE_API_BASE + app ⇒ 抛错，并在文案里点名 build-app.mjs', () => {
    clientConfig.apiBase = '/api';

    expect(() => resolveApiBase('app')).toThrow(/VITE_API_BASE/);
    expect(() => resolveApiBase('app')).toThrow(APP_ENDPOINT_BUILD_COMMAND);
    expect(() => resolveApiBase('app')).toThrow(/"\/api"/);
  });

  it('空 / 相对 VITE_WS_ENDPOINT + app ⇒ 抛错，并在文案里点名 build-app.mjs', () => {
    expect(() => resolveWsEndpoint('', 'app')).toThrow(/VITE_WS_ENDPOINT/);
    expect(() => resolveWsEndpoint('/ws', 'app')).toThrow(/VITE_WS_ENDPOINT/);
    expect(() => resolveWsEndpoint('/ws', 'app')).toThrow(/build-app\.mjs/);
    expect(() => resolveWsEndpoint('/ws', 'app')).toThrow(/"\/ws"/);
  });

  it('app 的报错文案与小程序同构、但用「App 端」自己的词（不是复制粘贴 mp 的句子）', () => {
    clientConfig.apiBase = '/api';

    expect(() => resolveApiBase('app')).toThrow(/App 端/);
    expect(() => resolveWsEndpoint('', 'app')).toThrow(/App 端/);
    // 负对照：两条 mp 文案里不得出现「App 端」
    expect(() => resolveApiBase('mp-weixin')).not.toThrow(/App 端/);
    expect(() => resolveWsEndpoint('', 'mp-weixin')).not.toThrow(/App 端/);
  });

  it('给了绝对地址 ⇒ app 两个端点都放行（校验只 refuse 相对/空）', () => {
    clientConfig.apiBase = 'https://api.example.com/api';

    expect(resolveApiBase('app')).toBe('https://api.example.com/api');
    expect(resolveWsEndpoint('https://api.example.com', 'app')).toBe('https://api.example.com');
  });

  it('**负对照（R633）：H5 语义逐字不变** —— 相对 base 与同源 endpoint 都照旧放行', () => {
    clientConfig.apiBase = '/api';

    expect(resolveApiBase('browser')).toBe('/api');
    // `undefined` = 没给（允许读 VITE_WS_ENDPOINT）；`''` = 明确要求同源 ⇒ 都**不抛**
    expect(() => resolveWsEndpoint(undefined, 'browser')).not.toThrow();
    expect(() => resolveWsEndpoint('', 'browser')).not.toThrow();
    expect(resolveWsEndpoint('/ws', 'browser')).toBe('/ws');
  });

  it('集合是唯一真源：两个无同源平台都在集合里，browser 不在', () => {
    expect([...REQUIRE_ABSOLUTE_ENDPOINT].sort()).toEqual(['app', 'mp-weixin']);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 客户端接入片 §0（C30）：REST 全量请求带头（browser→h5 / app→app / mp 不带）
// ---------------------------------------------------------------------------

describe('⑥ 客户端接入片 §0（C30）：REST 端标识头', () => {
  it('映射逐平台钉死：browser⇒h5；app⇒app；mp-weixin⇒不带（未识别不臆造标识）', () => {
    installUniStub(); // 默认 'web' ⇒ browser
    expect(rest.clientPlatformHeaders()).toEqual({ 'X-Client-Platform': 'h5' });
    installUniStub({ platform: 'app' });
    expect(rest.clientPlatformHeaders()).toEqual({ 'X-Client-Platform': 'app' });
    installUniStub({ platform: 'mp-weixin' });
    expect(rest.clientPlatformHeaders()).toEqual({});
  });

  it('浏览器：request() 把端标识合并进最终 headers，且不冲掉既有 Authorization', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tokenBefore = clientConfig.token;
    clientConfig.token = 'access-x';
    try {
      await rest.rooms();
    } finally {
      clientConfig.token = tokenBefore;
    }

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Client-Platform']).toBe('h5');
    expect(headers.Authorization).toBe('Bearer access-x');
  });

  it('App：uni.request 分支同样带头（桩 transport 读 header 钉死）', async () => {
    stub = installUniStub({ platform: 'app' });
    clientConfig.apiBase = MP_API_BASE;
    stub.requestResponder = () => ({ statusCode: 200, data: { code: 0, data: null } });

    await rest.login('13900000002', 'Passw0rd!');

    expect(stub.calls.request[0]!.header).toEqual({
      'content-type': 'application/json',
      'X-Client-Platform': 'app',
    });
  });

  it('负对照：mp-weixin 不带头（出站形态与改动前逐字一致）', async () => {
    stub = installUniStub({ platform: 'mp-weixin' });
    clientConfig.apiBase = MP_API_BASE;
    stub.requestResponder = () => ({ statusCode: 200, data: { code: 0, data: null } });

    await rest.login('13900000002', 'Passw0rd!');

    expect(stub.calls.request[0]!.header).toEqual({ 'content-type': 'application/json' });
  });
});

// ---------------------------------------------------------------------------
// 机械闸（R553①）：裸 `fetch(` 只能出现在 `net/http.ts`
// ---------------------------------------------------------------------------

/** **唯一**允许直接调用 `fetch` 的文件（小程序端必须经 `uni.request`，见文件头）。 */
const FETCH_ALLOWED = new Set(['src/net/http.ts']);

/** 找出裸 `fetch(...)` 的调用点（`globalThis.fetch(...)` / `window.fetch(...)` 同样命中）。 */
function bareFetchOffenders(path: string, rawSource: string): string[] {
  const offenders: string[] = [];
  for (const line of stripComments(rawSource).split('\n')) {
    if (/\bfetch\s*\(/.test(line)) offenders.push(`${path}: ${line.trim()}`);
  }
  return offenders;
}

describe('⑤ 机械闸：src/** 里只有 net/http.ts 可以直接调用 fetch（R553）', () => {
  it('判别力正对照：合成样本必须被判违规，注释与合法写法必须放行', () => {
    expect(bareFetchOffenders('src/net/rest.ts', 'const res = await fetch(`${base}${path}`);')).toHaveLength(1);
    expect(bareFetchOffenders('src/net/rest.ts', 'const res = await globalThis.fetch(url);')).toHaveLength(1);
    // 豁免文件自身的写法放行（否则这道闸与实现互相矛盾）
    expect(bareFetchOffenders('src/net/http.ts', 'const res = await fetch(url, init);')).toHaveLength(1);
    // 剥注释：解释里写 `fetch(...)` 不算违规
    expect(bareFetchOffenders('src/net/rest.ts', '// 这里以前是 fetch(url)')).toEqual([]);
    expect(bareFetchOffenders('src/net/rest.ts', '/** 以前是 fetch(url) */')).toEqual([]);
    // 经适配器的写法放行
    expect(bareFetchOffenders('src/net/rest.ts', 'await requestJson({ url, method });')).toEqual([]);
  });

  it('src/** 里除 net/http.ts 外没有裸 fetch(（改前 rest.ts 有两处）', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      if (FETCH_ALLOWED.has(file.path)) continue;
      offenders.push(...bareFetchOffenders(file.path, file.content));
    }
    expect(
      offenders,
      `小程序运行时没有 fetch ⇒ 这些调用点会让「注册/登录第一步」直接挂，必须经 http.ts 的适配器：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('扫描器自证：被豁免的 http.ts 确实存在且真的调用了 fetch（否则豁免是个洞）', () => {
    const allowed = collectSourceFiles().filter((file) => FETCH_ALLOWED.has(file.path));
    expect(allowed.map((file) => file.path)).toEqual(['src/net/http.ts']);
    expect(bareFetchOffenders('src/net/http.ts', allowed[0]!.content).length).toBeGreaterThanOrEqual(1);
  });
});
