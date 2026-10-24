/**
 * 运行时配置：endpoint 与握手身份。
 *
 * 只有一个目的——**切换服务端不改业务代码**：
 *  - 开发期连协调者的 mock：`VITE_WS_ENDPOINT=http://localhost:3400`、`VITE_DEV_USER_ID=u_dev`
 *  - 联调期连真实网关：清空 endpoint（走同源 / vite 代理）、由登录接口拿到 token
 *
 * 握手身份的形态由契约决定：真实网关用 `auth: { token }`（§6.1），
 * mock 用 `auth: { userId }`（§5.2 的下游握手形态）。
 *
 * ⚠️ 依赖方向：本模块 import `net/mp-transport` 的 `detectPlatform()`（端标识判定，
 * 客户端接入片）。`net/mp-transport` 只依赖 `net/transport`（零模块级 import），
 * 不反向依赖本模块 ⇒ 无环。平台判定发生在**调用时**（不在模块顶层读 uni）。
 */
import { detectPlatform } from './net/mp-transport';
import { getDeviceId } from './net/storage';

export interface ClientConfig {
  /** socket.io origin；空 = 同源（vite 代理到 api-gateway）。 */
  wsEndpoint: string;
  /** REST 前缀。 */
  apiBase: string;
  /** 开发期直连 mock 时的身份。 */
  devUserId: string;
  /** access token（登录后写入；真实后端用）。 */
  token: string;
}

/**
 * 读 Vite/uni 注入的环境变量。
 *
 * ⚠️⚠️ **不得**写成 `typeof import.meta !== 'undefined' ? import.meta.env : undefined`
 * （切片 P19 实测的**阻断级**缺陷，微信小程序端整包挂掉）：
 *
 * 那个 `typeof import.meta` 守卫会逼打包器把 `import.meta` **实体化**，产物里生成
 * `{ url: typeof document === 'undefined' ? require(<Node 的 url 模块>).pathToFileURL(__filename).href : … }`
 * （上面那处只写模块名不写引号，是为了**不绊到 §12 的依赖边界闸** —— 它不剥注释，见 `test/source-boundary.test.ts`）。
 * 微信小程序的 service 上下文里 **`document` 不存在** ⇒ 只能走那条 Node `url` 分支，
 * 而小程序的模块系统里没有 Node 的 `url` ⇒ 抛
 * `Error: module 'url.js' is not defined, require args is 'url'`
 * ⇒ **`app.js` 的整条模块图在求值期就中断**（连带症状：`Page "pages/login/login" has not been registered yet`，
 * 因为页面注册代码在 `app.js` 求值之后）。
 *
 * ⇒ 只用**直接的属性访问**：`import.meta.env[key]` 在构建期被替换成字面量（H5 与小程序都一样），
 * 于是 `import.meta` 本身**再也不需要被实体化**。
 * 机械闸：`test/import-meta-guard.gate.test.ts`（源码级）＋ 门禁里的产物级判据
 * 「`dist/build/mp-weixin` 不得出现对 Node `url` 模块的引用」。
 */
function readEnv(key: string, fallback: string): string {
  const value = import.meta.env?.[key] as string | undefined;
  return value ?? fallback;
}

/**
 * 小程序端端点配错时，错误信息里必须给出的**唯一**构建入口（切片 P17 / R550、R552）。
 *
 * 之所以放在配置模块而不是在两个报错点各抄一遍：小程序端**没有「同源」概念**，
 * `VITE_API_BASE`（仍是相对路径）与 `VITE_WS_ENDPOINT`（空）都必须**响亮报错**，
 * 而报错的价值全在「用户知道下一条命令敲什么」——两处因此共用同一句命令
 * （避免出现第二个真源）。
 */
export const MP_ENDPOINT_BUILD_COMMAND = 'node scripts/build-mp-weixin.mjs <host:port>';

/**
 * App 端端点配错时，错误信息里必须给出的**唯一**构建入口（切片 P26 / R632、R636）。
 *
 * 与 `MP_ENDPOINT_BUILD_COMMAND` **同构**：App 端同样**没有「同源」概念**
 * （native 容器 + 本地资源 webview，`location.origin` 不是网关——实证：无端点配置的发布包里
 * socket 兜底落在 `http://localhost:3000` = 设备自己 ⇒ 真机必挂）。
 * ⚠️ **HBuilderX 云打包不走本命令**（GUI 内部构建读 `.env*` 文件，不经过本脚本）——
 * 云打包轮的端点来源 = `apps/client/.env.production.local`（本机专用、不入库）。
 */
export const APP_ENDPOINT_BUILD_COMMAND = 'node scripts/build-app.mjs <host:port>';

export const clientConfig: ClientConfig = {
  /**
   * ⚠️ 默认**空** ⇒ `resolveEndpoint` 回退到**同源**（浏览器里就是页面 origin），
   * 再由 `vite.config.ts` 的 `/socket.io` 代理转到 `api-gateway:3000`。
   *
   * 旧默认值写死 `http://localhost:3400`（mock）—— 那让默认开发路径**连不上真后端**，
   * 且因为 CI 里没有浏览器，这个事实长期不被发现（真浏览器验证直到 2026-09 才暴露它）。
   * 用 mock 请设 `VITE_WS_ENDPOINT`（见 `apps/client/.env.mock` 的说明）。
   */
  wsEndpoint: readEnv('VITE_WS_ENDPOINT', ''),
  apiBase: readEnv('VITE_API_BASE', '/api'),
  devUserId: readEnv('VITE_DEV_USER_ID', 'u_dev'),
  token: '',
};

/**
 * 握手 auth：有 token 走真实网关，否则用开发身份（仅 mock 接受）。
 *
 * 客户端接入片（§0）：恒带端标识 `clientPlatform`（网关 `handleConnectionInner`
 * 在验签**之前**按它判端闸）——browser→`'h5'`；app→`'app'`；mp-weixin/未知 ⇒
 * **不含该键**（未识别端不臆造标识：与 HTTP 头注入 `clientPlatformHeaders()` 同口径）。
 *
 * 设备绑定片：真实网关路径**恒带 `deviceId`**（与 REST 登录/refresh 载荷同一枚，
 * 取自 `getDeviceId()` 的持久指纹）—— 网关 `verifyClient` 在封禁旗之后读
 * `risk:binding:{userId}`，键在且≠本机 ⇒ 11005 拒连。旧端不带 ⇒ 服务端 fail-open，
 * 所以这里带上只有收益（开了绑定开关的账号才能被 WS 闸真正拦住）。
 *
 * ⚠️ 该值只在**建连**时求值一次（工厂只在 GameClient 构造时被调一次）。socket.io 的
 * 自动重连「重发 auth」是 socket.io-client 的**内部行为**（重连时直接复用建连时的
 * auth 对象，不经本函数）——单测不可达，登记不测。
 */
export function buildSocketAuth(accessToken?: string): Record<string, unknown> {
  const token = accessToken ?? clientConfig.token;
  const kind = detectPlatform();
  const platformField =
    kind === 'browser' ? { clientPlatform: 'h5' } : kind === 'app' ? { clientPlatform: 'app' } : {};
  // 开发身份路径不带 deviceId（mock 下游不读该键，保持夹具简单）。
  if (token) return { token, ...platformField, deviceId: getDeviceId() };
  return { userId: clientConfig.devUserId, ...platformField };
}
