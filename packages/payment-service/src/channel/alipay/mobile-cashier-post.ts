/**
 * 支付片：**手机收银台代发传输**（手机端桥接专用；node:https 直连，不跟随 302）。
 *
 * ## 为什么不用全局 `fetch`
 * undici（Node 全局 fetch 的底座）在 `redirect: 'manual'` 下会把跨域 302 折叠成
 * opaqueredirect：`status=0`、`Location` 头被剥掉——而我们恰恰只要那个 `Location`
 * （`mobileclientgw-…/mobilepay.htm?…` 一次性签发地址）。故用 `node:http(s)` 直接
 * 发起 POST、读到响应行即回收状态码与 Location（响应体排空丢弃，不解析、不验签——
 * 这一跳的可信面只有「签发地址落在支付宝域白名单」，见 client.ts `isSafeCashierUrl`）。
 *
 * 传输形态与浏览器自动提交逐字一致：`application/x-www-form-urlencoded` + 已签名字段，
 * 仅 User-Agent 换成手机 UA（沙箱边缘据此分流到手机收银台集群）。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** 不跟随跳转的 POST 结果（体排空，只要状态码 + Location）。 */
export interface MobileFormPostResult {
  status: number;
  location: string | null;
}

/** 代发传输面（生产 = `postMobileForm`；单测注入替身，不经真网络）。 */
export type MobileFormPost = (
  gatewayUrl: string,
  formBody: string,
  userAgent: string,
  timeoutMs: number,
) => Promise<MobileFormPostResult>;

/** DI 令牌（`@Optional()`：容器不注册时构造器默认值兜底，测试可直构传参）。 */
export const MOBILE_FORM_POST = Symbol('MOBILE_FORM_POST');

/**
 * 默认传输：POST 表单到网关、**不跟随 302**，回收 `{status, location}`。
 * 传输错误/超时 ⇒ reject（调用方按渠道失败收口并重试）。
 */
export const postMobileForm: MobileFormPost = (gatewayUrl, formBody, userAgent, timeoutMs) =>
  new Promise<MobileFormPostResult>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(gatewayUrl);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const transport = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
    if (!transport) {
      reject(new Error(`不支持的网关协议：${url.protocol}`));
      return;
    }

    const req = transport(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          'content-length': Buffer.byteLength(formBody),
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      (res) => {
        const result: MobileFormPostResult = {
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === 'string' ? res.headers.location : null,
        };
        res.resume(); // 体不需要：排空即可（不排空会拖住连接收口）
        res.on('end', () => resolve(result));
        res.on('error', (err) => reject(err));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`alipay mobile cashier POST timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => reject(err));
    req.write(formBody);
    req.end();
  });
