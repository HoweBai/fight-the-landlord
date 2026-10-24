/**
 * 广告片 T11 落骨架 + T14 业务链接入 + **T0 回填 GET/JSON 化**（规格 v1.4 §2.4）。
 *
 * ─── 挂载形态（三件套；照 `payment-service/src/main.ts` 形态）─────────────────
 *  - `rawBody: true`：**保留**（v1.4 明示——与 pay 同形；GET 无 body ⇒ 本件不承载判据）；
 *  - 内部 token 中间件**精确豁免**：`main.ts` 以 `[...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]`
 *    注入条目（**不动**中间件默认清单——`DEFAULT_EXEMPT_PATHS` 仍只有健康面）。该面是
 *    edge 直连的公网回调（平台 S2S 投递），渠道**拿不到也不该带**内部 token ⇒ 由本文件的
 *    防护链自守；**唯一信任入口 = 验签**；
 *  - 全局前缀豁免：`setGlobalPrefix('api', { exclude: [...] })`。
 *
 * ─── 🔴 勘误①（实现期实测；GET 化后依旧成立）──────────────────────────────
 * 前缀豁免**不得**用字面量 `exclude: [AD_NOTIFY_PATH]`：Nest 把**整条路由模式串**
 * （`'/ad/notify/:provider'`）交给 exclude 的 pathToRegexp 正则做 exec —— 字面量
 * `'/ad/notify/uniad'` 的 regexp 匹配不到 `:provider` 模式 ⇒ 排除不生效、路由被注册到
 * `/api/ad/notify/:provider`，公开路径恒 **404**。
 * ⇒ exclude 一律用 RouteInfo `{ path: AD_NOTIFY_ROUTE, method: RequestMethod.ALL }`
 * （`AD_NOTIFY_ROUTE` 与 `@All(...)` 字面量对钉，防两处漂移）。
 *
 * ─── 防护顺序（v1.4 §2.4 钉死；顺序本身是判据）────────────────────────────
 *  ① 方法闸：仅 **GET**（平台恒 GET；其余动词 ⇒ **405**，面向**非平台流量**，
 *     `@All` 接住全部动词再自检——Nest 缺省对方法不符给 404 不是 405），
 *     无 isValid 语义、维持纯文本 `failure`；
 *  ② 限流：`AdRateLimiter` 边缘单桶 600/分（**按 socket peer 如实记**——反代后 peer
 *     恒为 edge 容器，不复制 XFF 信任口径），超桶 **429 + `{"isValid": false}`**
 *     （瞬态形态 ⇒ 平台重投）；Redis 故障 fail-open + 响亮 WARN；
 *  ③ 验签 → claim 解析 → 账本先行 → 正向裁决 → apply → 落 done（`AdCallbackService`；
 *     链序/计数/落序见其文件头——本文件只做「结果 → 状态码 + JSON」的映射）。
 *
 * 应答形态（v1.4 落定字面；官方「唯一确认信号」语义）：
 *  - **终态**（granted / replayed / 正向裁决拒绝 / claim 无效 / **坏签名 / 畸形**）
 *    ⇒ **200 + `{"isValid": true}`**——坏签名/畸形归终态是有意口径（确定性结局
 *    不可改变，回 true 止投；密钥错配窗口靠 `ReliefCallbackBroken` 告警兜底）；
 *  - **瞬态**（claim 读取故障 / apply 失败 / 记录写失败 / 配置或密钥拉取不可用）
 *    ⇒ **503 + `{"isValid": false}`**（平台重试窗内重投自愈）。
 *  - 原 POST 时代的 415 内容类型闸 / 413 体积闸随 GET 化**删除**（字段走 query、无 body；
 *    URL 长度由 edge/Caddy 层自然约束，不设应用闸）。
 */

import { All, Controller, Inject, Logger, Req, Res } from '@nestjs/common';
import { AdRateLimiter } from './ad-rate-limiter';
import { AdCallbackService } from './ad-callback.service';
import type { AdCallbackOutcome } from './ad-callback.service';

/** 公开回调路径（edge 原样转发；内部 token 中间件**精确豁免**条目——单常量对钉）。 */
export const AD_NOTIFY_PATH = '/ad/notify/uniad';

/**
 * 路由模式（provider 段预留；渠道段 = 首发平台 `uniad`）。与 `@All('ad/notify/:provider')`
 * 字面量对钉（单测钉字面量防漂移）。
 *
 * ⚠️ **全局前缀豁免（exclude）必须用本常量**（RouteInfo path）——字面量路径排除不掉参数化
 * 路由（勘误①，见文件头；实测 404）。
 */
export const AD_NOTIFY_ROUTE = 'ad/notify/:provider';

/** 平台确认信号（v1.4 §2.4 逐字 JSON；终态 true 止投 / 瞬态 false 触发重投）。 */
const ANSWER_VALID = JSON.stringify({ isValid: true });
const ANSWER_INVALID = JSON.stringify({ isValid: false });

/** ① 方法闸的拒绝词（面向非平台流量；无 isValid 语义——拒绝语义在 405 状态码里）。 */
const ANSWER_METHOD_FAILURE = 'failure';

/**
 * ③ 结果 → 线上编码（§2.4 表的**唯一实现点**）。
 * 终态四值（含坏签名/畸形）⇒ 200 `{"isValid":true}`；瞬态 ⇒ 503 `{"isValid":false}`。
 */
export const AD_NOTIFY_MAP: Record<AdCallbackOutcome, { status: number; body: string }> = {
  'success-terminal': { status: 200, body: ANSWER_VALID },
  'reject-sign': { status: 200, body: ANSWER_VALID },
  'reject-malformed': { status: 200, body: ANSWER_VALID },
  transient: { status: 503, body: ANSWER_INVALID },
};

/** 控制器面的请求最小结构（**不 import express**——照 `internal-token.middleware.ts` 先例）。 */
interface AdNotifyHttpRequest {
  method?: string;
  /** 含 query 的原始路径（express `req.url` = path?search；控制器以占位 base 解析）。 */
  url?: string;
  socket?: { remoteAddress?: string | null };
}

/** 控制器面的响应最小结构（`type()` = express 的 MIME 设置器）。 */
interface AdNotifyHttpResponse {
  status(code: number): AdNotifyHttpResponse;
  type(t: string): AdNotifyHttpResponse;
  send(body: string): unknown;
}

/**
 * socket peer（**如实记**：不读 XFF/`x-real-ip`——反代后 peer 恒为 edge 容器，照 §2.4 口径）。
 * 本片无取证表 ⇒ 只进结果日志。
 */
function clientPeer(req: AdNotifyHttpRequest): string | null {
  const remote = req.socket?.remoteAddress;
  if (typeof remote !== 'string' || remote.length === 0) return null;
  return remote.slice(0, 64);
}

/**
 * 广告回调入口（唯一路由；`@All` 接全动词——方法自检在 ①闸，不是靠路由缺省）。
 */
@Controller()
export class AdsController {
  private readonly logger = new Logger(AdsController.name);

  /**
   * ⚠️ **值导入**依赖（DI 陷阱纪律）+ 显式 `@Inject`（不依赖 `emitDecoratorMetadata`
   * 的隐式注入）。
   */
  constructor(
    @Inject(AdRateLimiter) private readonly rateLimiter: AdRateLimiter,
    @Inject(AdCallbackService) private readonly callback: AdCallbackService,
  ) {}

  @All('ad/notify/:provider')
  async adNotify(@Req() req: AdNotifyHttpRequest, @Res() res: AdNotifyHttpResponse): Promise<void> {
    // ① 方法闸（仅 GET；其余 405 + 纯文本 failure——非平台流量，无 isValid 语义）
    if (req.method !== 'GET') {
      res.status(405).type('text/plain');
      res.send(ANSWER_METHOD_FAILURE);
      return;
    }

    // ② 边缘单桶（600/分；Redis 故障 fail-open——见 AdRateLimiter）。429 = 瞬态形态：
    //    回 {"isValid":false} 让平台重投（v1.4 §2.4 表）。
    if (await this.rateLimiter.exceeded()) {
      this.replyJson(res, 429, ANSWER_INVALID);
      return;
    }

    // ③ 验签 → claim 解析 → 账本先行 → 正向裁决 → apply → 落 done（T14 链；
    //    v1.4：字段走 query、无 body——形状解析单一真源在 T13 `extractCallbackFields`）。
    //    占位 base 仅为 URL 解析（express req.url 是相对路径，不含 origin）。
    const query = new URL(req.url ?? '', 'http://ad-notify.invalid').searchParams;
    const outcome = await this.callback.processCallback({ query });
    if (outcome !== 'success-terminal') {
      // 结果日志（运维面：`ReliefCallbackBroken` runbook 的「先看验签失败行」——详情在服务侧，
      // 此处带 peer；peer 如实记）。
      this.logger.warn(`广告回调结果 outcome=${outcome} peer=${clientPeer(req) ?? 'unknown'}`);
    }
    const mapped = AD_NOTIFY_MAP[outcome];
    this.replyJson(res, mapped.status, mapped.body);
  }

  /** JSON 应答（终态/瞬态/429 共面；Content-Type 显式 application/json——平台按 JSON 解析确认信号）。 */
  private replyJson(res: AdNotifyHttpResponse, status: number, body: string): void {
    res.status(status).type('application/json');
    res.send(body);
  }
}
