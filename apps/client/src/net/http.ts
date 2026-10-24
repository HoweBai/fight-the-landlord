/**
 * REST 的**传输适配器**：一个函数、按平台两条传输（切片 P17 / R549）。
 *
 * ## 为什么必须存在（实测，不是推测）
 *
 * `uni build -p mp-weixin` 的产物里 REST 用的是**裸 `fetch`**
 * （`dist/build/mp-weixin/net/rest.js`，改前裸 `fetch(` 计数 = 2），而整个小程序产物里
 * **没有** fetch 的 polyfill（`common/vendor.js` 的 polyfill 计数 = 0）。微信小程序运行时
 * 只有 `wx.request` / uni 的 `uni.request` ⇒ **注册/登录第一步就 `fetch is not defined`**。
 * 切片 P10 只适配了**传输层**（socket.io → `wx.connectSocket`），REST 层被漏掉了。
 *
 * ## 形状（为什么这不是「第二份 REST 实现」）
 *
 * 这里**只做传输**：给一个 `{ url, method, headers, body }`，回一个 `{ statusCode, text }`。
 * 信封解析（§11.1）、refresh 轮换（§5.1）、串行、错误码分支**全部仍在 `rest.ts` 一处** ——
 * 与 socket 传输同构（H5 浏览器路径 / 小程序适配路径，R441 补② 的同一逻辑）。
 *
 * ## ⚠️ `uni.request(...)` 必须是**直接的成员调用**
 *
 * H5 发行构建默认摇树，`@dcloudio/uni-h5-vite` 只注入空的 `window.uni = {}` 占位对象；
 * 真正可用的是 uni 编译器把源码里 `uni.xxx(...)` 的**直接调用**改写成 `@dcloudio/uni-h5`
 * 的具名 import（详见 `net/storage.ts#hasUni` 的注释）。写成 `const api = uni; api.request(...)`
 * 会让改写扫不到 ⇒ **dev 正常、发行版静默失效**。机械闸：`test/uni-api-access.test.ts`。
 *
 * ## 平台判定（R551）
 *
 * 一律复用 `net/mp-transport.ts` 的 `detectPlatform()`，**不新写第二份探测**：
 *  - `mp-weixin` **与 `app`** ⇒ `uni.request`（两条边的理由不同，见 `requestViaUni`：
 *    小程序端**没有** `fetch`，App 端**有名字但不是函数**）；
 *  - `web` / `h5` / 读不到平台（纯 web / SSR / 单测）⇒ `fetch`，
 *    **逐字搬**改动前 `rest.ts` 的写法（H5 路径被 P9 真浏览器探针与发行产物级探针压着，行为一字不改）；
 *  - **其它平台**（`mp-alipay` / `mp-baidu` / quickapp…）由 `classifyPlatform` **明确报错**，不静默退化。
 *
 * ## 端点解析（R550 / P26·R632）
 *
 * 本文件同时是**端点校验**的落点：`resolveApiBase()`（REST 前缀）与 `resolveWsEndpoint()`
 * （socket.io endpoint）。**无「同源」的平台**（`REQUIRE_ABSOLUTE_ENDPOINT` = mp-weixin + app）
 * 校验是**对称两条**：`VITE_API_BASE` 是相对路径 ⇒ 抛错；`VITE_WS_ENDPOINT` **空或相对路径**
 * ⇒ 抛错（两条消息都点名变量 + 给出**该平台自己的**构建入口命令）。不猜、不从另一个变量
 * 派生 host（R550）；浏览器语义逐字冻结（R633）。
 */
import { APP_ENDPOINT_BUILD_COMMAND, MP_ENDPOINT_BUILD_COMMAND, clientConfig } from '../config';
import { detectPlatform, type PlatformKind } from './mp-transport';
import { readWsEndpointEnv, resolveEndpoint } from './transport';

/** 一次 JSON 请求（`rest.ts` 只构造这个形状，不碰任何平台 API）。 */
export interface JsonRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** **已经序列化好**的请求体（`JSON.stringify` 仍由 `rest.ts` 负责，与改动前逐字一致）。 */
  body?: string;
}

/** 归一后的应答：**只有**状态码与原文（信封解析是 `rest.ts` 的事）。 */
export interface JsonResponse {
  statusCode: number;
  text: string;
}

/**
 * 传输层**没有拿到任何应答**（`uni.request` 的 `fail`，例如域名未加白名单 / 网络不可达）。
 *
 * `statusCode: 0` 是这个类别的语义表达：与「拿到的不是平台信封」**殊途同归** ——
 * `rest.ts` 把它交给**既有的**信封兜底（`parse`）落成 `10007`（下游不可用）。
 * ⚠️ H5 上 `fetch` 的拒绝（`TypeError: Failed to fetch`）**不走**这里：那条路径的传播行为
 * 一字不改（`rest.ts` 只 catch 本类），否则就是动了被探针压着的 H5 行为。
 */
export class TransportFailureError extends Error {
  /** 0 = 没有拿到任何应答（区别于服务端返回的 HTTP 状态码）。 */
  readonly statusCode = 0;
  /** 原始 `fail` 参数，仅供排查（`(error as TransportFailureError).reason`）。 */
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super(`uni.request 失败（statusCode: 0，没有拿到任何应答）：${describeFailure(reason)}`);
    this.name = 'TransportFailureError';
    this.reason = reason;
  }
}

function describeFailure(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object' && reason !== null && 'errMsg' in reason) {
    return String((reason as { errMsg?: unknown }).errMsg);
  }
  return String(reason);
}

/**
 * 发一次请求并归一应答。
 *
 * **平台判定发生在调用时**（不在模块顶层读 `uni`，与 `mp-transport`/`storage` 同一规矩）；
 * 不支持的平台在 `detectPlatform()` 里就抛错（R551 的负对照）。
 */
export async function requestJson(input: JsonRequest): Promise<JsonResponse> {
  const platform = detectPlatform();
  // ⚠️ App 与 mp-weixin 同走 `uni.request`：App 的 **service 侧**跑在 weexjsb 的 V8 上下文里，
  //    不是 WebView（WebView 只是渲染层）⇒ `fetch` 有名字却**不是函数**，调用即
  //    `TypeError: fetch is not a function`。这是 N39「App 注册不了」的根因（2026-09-19 实测）。
  return platform === 'mp-weixin' || platform === 'app'
    ? requestViaUni(input)
    : requestViaFetch(input);
}

/**
 * `uni.request` 分支（**小程序端 + App 端**）。
 *
 * 进入本分支的前提是 `detectPlatform()` 读到了 `'mp-weixin'` 或 `'app'`，
 * 而那要求全局 `uni` 存在 ⇒ 这里不再重复做存在性判定。
 *
 * ⚠️ 这两类平台**绝不退化到 `fetch`**：
 *  - `mp-weixin`：运行时根本没有 `fetch`（P17 要消灭的形态）；
 *  - `app`：有 `fetch` 这个名字但**不是函数**（N39 实测的 `TypeError`）。
 */
function requestViaUni(input: JsonRequest): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    uni.request({
      url: input.url,
      method: input.method,
      header: input.headers,
      data: input.body,
      success: (res) => resolve({ statusCode: res.statusCode, text: toText(res.data) }),
      fail: (error) => reject(new TransportFailureError(error)),
    });
  });
}

/** H5（浏览器）分支：**逐字搬**改动前 `rest.ts` 的两处写法（`method` / `headers` / `body` / `res.text()`）。 */
async function requestViaFetch(input: JsonRequest): Promise<JsonResponse> {
  const res = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return { statusCode: res.status, text: await res.text() };
}

/**
 * `uni.request` 的 `data` 归一成文本。
 *
 * uni 的 `dataType` 默认 `json` ⇒ 服务端返回 JSON 时 `data` 已经是**对象**（uni 自己 parse 过），
 * 非 JSON（HTML 错误页 / 空体）时是**字符串**。这里只把对象序列化回文本 —— 否则
 * 「对象 vs 文本」这一个平台差异会漏进 `rest.ts`（那里不改，信封解析仍只有一处）。
 */
function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return '';
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// 端点解析（R550 / P26·R632）：**无「同源」的平台**（mp-weixin + app）配错就响亮报错，
// 不猜、不派生。浏览器语义逐字冻结（R633）。
// ---------------------------------------------------------------------------

/** 绝对地址（无「同源」平台唯一可用的形态：那里没有页面 origin 可依，相对路径发不出请求）。 */
const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * **需要显式绝对端点**的平台（P26/R632 的唯一真源）。
 *
 * 判据不是「哪个平台特殊」，而是「**这个平台有没有同源**」：
 *  · `mp-weixin`：只有 `wx.connectSocket` / `uni.request`，没有 `window.location`（R550）；
 *  · `app`：native 容器 + 本地资源 webview，`location.origin` 不是网关（P26/R631——
 *    实证：无端点配置的发布包里 socket 兜底落在 `http://localhost:3000` = 设备自己）。
 * `browser`（H5 / 纯 web / 单测）**有**同源与 vite 代理 ⇒ 不在集合里，语义逐字冻结（R633）。
 */
export const REQUIRE_ABSOLUTE_ENDPOINT: ReadonlySet<PlatformKind> = new Set(['mp-weixin', 'app']);

/**
 * 报错文案里平台的**人话名**（唯一来源，避免两处各写一遍）。
 *
 * ⚠️ `mp-weixin` 的用词与 R550 的既有报错**逐字一致**（`full='小程序端'` / `short='小程序'`）——
 * 既有用例对文案的断言不得被本次参数化改动打红。
 */
const PLATFORM_LABEL: Record<'mp-weixin' | 'app', { full: string; short: string }> = {
  'mp-weixin': { full: '小程序端', short: '小程序' },
  app: { full: 'App 端', short: 'App' },
};

/** 按平台给出构建入口命令（报错文案的唯一来源）。 */
function endpointBuildCommand(platform: 'mp-weixin' | 'app'): string {
  return platform === 'app' ? APP_ENDPOINT_BUILD_COMMAND : MP_ENDPOINT_BUILD_COMMAND;
}

/** 构建入口的「把 <host:port> 换成什么」尾注（各平台各说各的）。 */
function endpointBuildHint(platform: 'mp-weixin' | 'app'): string {
  return platform === 'app'
    ? '（把 <host:port> 换成你的网关地址，例如 api.example.com）'
    : '（把 <host:port> 换成你的局域网地址，例如 192.168.1.5:3000）';
}

/**
 * REST 前缀（R550 / R632）。
 *
 * - 浏览器 / 读不到平台：**照旧**返回 `clientConfig.apiBase`（默认相对路径 `/api`，
 *   由 `vite.config.ts` 的代理转发到 api-gateway；P9 探针压着这条同源约定）；
 * - `REQUIRE_ABSOLUTE_ENDPOINT`（mp-weixin / app）：仍是相对路径 ⇒ **抛错**，
 *   点名 `VITE_API_BASE` 并给出**该平台自己的**构建入口命令。
 *
 * **不从另一个变量猜 host**（R550）：REST 与 WS 是两条边，互相派生只会造出第二个真源。
 */
export function resolveApiBase(platform: PlatformKind = detectPlatform()): string {
  const base = clientConfig.apiBase;
  if (!REQUIRE_ABSOLUTE_ENDPOINT.has(platform) || ABSOLUTE_URL.test(base)) return base;
  const p: 'mp-weixin' | 'app' = platform === 'app' ? 'app' : 'mp-weixin';
  const label = PLATFORM_LABEL[p];
  throw new Error(
    `${label.full} VITE_API_BASE 必须是绝对地址（http:// 或 https:// 开头），当前值是 ${JSON.stringify(base)}：` +
      `${label.short}没有「同源」概念，相对路径发不出请求。请用构建入口重新构建：` +
      `\n  ${endpointBuildCommand(p)}` +
      `\n  ${endpointBuildHint(p)}`,
  );
}

/**
 * 无「同源」平台的 WS endpoint 报错文案（**空**与**相对路径**两个分支共用后半句）。
 *
 * 与 `resolveApiBase` 的报错同构：点名变量 + 给出**该平台自己的**唯一构建入口命令
 * （R550 的价值全在「用户知道下一条命令敲什么」）。
 */
function endpointRequiredError(platform: 'mp-weixin' | 'app', reason: string): Error {
  const label = PLATFORM_LABEL[platform];
  return new Error(
    `${label.full} VITE_WS_ENDPOINT ${reason}：${label.short}没有「同源」概念，也不会回退到硬编码的 ` +
      'localhost（真机必挂）。请用构建入口重新构建（同一个参数会同时导出 VITE_API_BASE 与 ' +
      `VITE_WS_ENDPOINT）：\n  ${endpointBuildCommand(platform)}`,
  );
}

/**
 * socket.io 的 endpoint（R550 / P26·R632）。
 *
 * 与 `transport.ts#resolveEndpoint` 的分工：**校验在这里，浏览器语义的回退链在那里**。
 * `REQUIRE_ABSOLUTE_ENDPOINT`（mp-weixin + app）的校验是**对称的两条**（与 `resolveApiBase` 同构）：
 *  1. 没有配置（空）⇒ 抛错 —— 否则回退链会落到硬编码的 `http://localhost:3000`：
 *     开发者工具/同机环境能凑合，**真机必挂**（App 的实证：无端点的发布包就是这个值）；
 *  2. 配了但**不是绝对地址**（相对路径，例如 `/ws`）⇒ 也抛错 ——
 *     无「同源」平台只有绝对 origin 才建得起来（小程序：`wx.connectSocket` 要 `ws(s)://`，
 *     socket.io 从 `http(s)://` origin 派生；App：本地 webview 的 origin 不是网关），
 *     相对值在这里同样是「必挂但看不出来」的形态。
 * 两条都点名 `VITE_WS_ENDPOINT` + 给出**该平台自己的**构建入口命令，且**根本不进入**
 * `resolveEndpoint`。
 *
 * ⚠️ 浏览器路径**逐字保持**原语义（校验只在无同源分支）：`undefined` = 没给（允许读
 * `VITE_WS_ENDPOINT`），`''` = 明确要求同源，`'/ws'` 之类原样返回（`??` 的语义，
 * 见 `clientConfig.wsEndpoint` 的默认值）。
 */
export function resolveWsEndpoint(
  explicit?: string,
  platform: PlatformKind = detectPlatform(),
): string {
  if (REQUIRE_ABSOLUTE_ENDPOINT.has(platform)) {
    const p: 'mp-weixin' | 'app' = platform === 'app' ? 'app' : 'mp-weixin';
    const configured = explicit ?? readWsEndpointEnv() ?? '';
    if (!configured) throw endpointRequiredError(p, '为空');
    if (!ABSOLUTE_URL.test(configured)) {
      throw endpointRequiredError(
        p,
        `必须是绝对地址（http:// 或 https:// 开头），当前值是 ${JSON.stringify(configured)}`,
      );
    }
  }
  return resolveEndpoint(explicit);
}
