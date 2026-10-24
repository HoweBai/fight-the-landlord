/**
 * 支付片 T8：**回调控制器**（`POST /pay/notify/alipay` —— 公网**无鉴权**写端点的全部防线；
 * 规格 §2.7.4 逐字 + ⚙️7 应答两词 + 设计 §2.2 信任边界第 3 条）。
 *
 * ─── 挂载形态（两个"避开"，各有其因）──────────────────────────────────────
 *  - **全局前缀豁免**：`main.ts` 的 `setGlobalPrefix('api', { exclude: [ALIPAY_NOTIFY_PATH] })`
 *    —— edge（Caddy `handle /pay/notify/*`）**原样转发**该路径，不经网关（§2.7.1）；
 *  - **内部 token 中间件豁免**：`main.ts` 以
 *    `createInternalTokenMiddleware([...DEFAULT_EXEMPT_PATHS, ALIPAY_NOTIFY_PATH])` 注入
 *    **精确条目**（不改中间件默认清单——`DEFAULT_EXEMPT_PATHS` 仍只有健康面，既有
 *    container-assembly 闸的「豁免面不得扩大」不变式照常成立）。该面**拿不到也不该带**
 *    内部 token（支付宝不是内部调用方）⇒ 由本文件的防护链自守；**唯一信任入口 = 验签**。
 *
 * ─── 防护顺序（规格 §2.7.4 钉死；顺序本身是判据）──────────────────────────
 *  ① 方法闸：仅 POST，其余 **405**（`@All` 接住全部动词再自检——Nest 缺省对
 *     POST-only 路由的 GET 会给 404，不是 405）；
 *  ② 内容类型闸：仅 `application/x-www-form-urlencoded`（带 `;charset=` 参数照收），
 *     其余 **415**；
 *  ③ 体积闸：body **≤ 16KB**（超 ⇒ **413**；`req.rawBody` 字节数为准——带 `rawBody: true`
 *     的 Nest 管线对表单体必有该 Buffer；测不出 ⇒ **拒**（fail-closed 一侧））；
 *     ⚠️ 表达式的上限 100kb `urlencoded` 解析限制仍是外层粗线（>100kb 由 express 自己 413，
 *     体是 Nest 信封——同为 413，不改变裁决）；
 *  ④ 边缘单桶：600/分（**按 socket peer 如实记**——反代后 peer 恒为 edge 容器，**不复制
 *     XFF 信任口径**；查询扫描可补丢通知 ⇒ 丢一条通知不丢钱）；超桶 **429**；
 *     **Redis 故障 = fail-open + 响亮 WARN**（钱进路径宁可通过再补审计，见 `NotifyRateLimiter`）；
 *  ⑤ 验签 ⇒ 四项校验 ⇒ 推进（`NotifyService`；应答两词由它给）。
 *
 * 应答形态（⚙️7）：纯文本 body，**只有 `success`/`failure` 两词**——200 是正常轮回，
 * 拒绝码（405/415/413/429）也回 `failure`（拒绝语义在**状态码**里，body 词面保持封闭）。
 */

import { All, Controller, Inject, Injectable, Logger, Optional, Req, Res } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { NotifyService } from './notify.service';
import type { NotifyAnswer } from './notify.service';

/** 公开回调路径（edge 原样转发；与 `@All('pay/notify/alipay')` 对钉——单测钉字面量）。 */
export const ALIPAY_NOTIFY_PATH = '/pay/notify/alipay';

/** §2.7.4：body ≤ 16KB（超 ⇒ 413）。 */
export const NOTIFY_MAX_BODY_BYTES = 16 * 1024;

/** §2.7.4：边缘单桶键（**单键**——peer 恒为 edge 容器，桶就该是"整条边缘"一个）。 */
export const NOTIFY_RATE_KEY = 'pay:notify:rate';

/** §2.7.4：边缘单桶 600/分（INCR + 首次 EXPIRE 60s——固定窗口，照 admin-login 先例）。 */
export const NOTIFY_RATE_LIMIT = { max: 600, windowSeconds: 60 } as const;

/** 拒绝面统一词（成功面的 `success` 由 `NotifyService` 的应答域给出——两词封闭，见 ⚙️7）。 */
const ANSWER_FAILURE: NotifyAnswer = 'failure';

/** 控制器面的请求最小结构（**不 import express**——照 `internal-token.middleware.ts` 先例）。 */
interface NotifyHttpRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  socket?: { remoteAddress?: string | null };
}

/** 控制器面的响应最小结构（`type()` = express 的 MIME 设置器）。 */
interface NotifyHttpResponse {
  status(code: number): NotifyHttpResponse;
  type(t: string): NotifyHttpResponse;
  send(body: string): unknown;
}

/** 头值归一（Express 形态：string | string[] | undefined）。 */
function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** body 字节数：`req.rawBody`（`rawBody: true` 管线的精确事实）⇒ 回落 `content-length`；测不出 ⇒ null。 */
function rawByteLength(req: NotifyHttpRequest): number | null {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.length;
  const length = firstHeader(req.headers['content-length']);
  if (length === null) return null;
  const n = Number(length);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 回调限流桶（§2.7.4：**边缘单桶 600/分**；Redis 故障 ⇒ **fail-open + 响亮 WARN**）。
 *
 * 连接面：ioredis **专用实例**（不蹭 `ConfigCacheService` 的订阅连接——那边进 subscribe
 * 模式后不可复用，注释逐字在先）+ `maxRetriesPerRequest: 1` / `enableOfflineQueue: false`
 * 的**快速失败**选项（照 api-gateway `createRedis()` 先例）：故障时立刻走 fail-open，
 * 不让回调请求堆在重试队列里。懒创建（首次收包才建连——boot 面零副作用）。
 */
@Injectable()
export class NotifyRateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(NotifyRateLimiter.name);
  private connection: Redis | null = null;

  /** `redisFactory` 是 `@Optional()` + 默认值的**测试替身注入口**（照 `AlipayClient.fetchImpl` 先例）。 */
  constructor(@Optional() private readonly redisFactory: () => Redis = defaultNotifyRedis) {}

  /**
   * @returns `true` = **超桶，必须 429**。任何 Redis 故障 ⇒ `false`（放行）+ 响亮 WARN。
   */
  async exceeded(): Promise<boolean> {
    try {
      const redis = this.redis();
      const count = await redis.incr(NOTIFY_RATE_KEY);
      // 固定窗口：窗口从**本窗第一发**起算（`incr` 返回 1 时才设 EXPIRE）——不被后续请求顺延。
      // 已知边角（登记不补保；**承网关 admin-login `recordAdminLoginFailure` 先例同款，接受**，
      // 波 3 评审 🟢-2）：INCR 成功而 EXPIRE 失败（两命令间连接瞬断）⇒ 键留存且无 TTL、count
      // 续累到 >600 后恒 429——后果可控（扫描②补单兜底不丢钱；清键/Redis 重启即愈）。
      if (count === 1) await redis.expire(NOTIFY_RATE_KEY, NOTIFY_RATE_LIMIT.windowSeconds);
      return count > NOTIFY_RATE_LIMIT.max;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`回调限流桶 Redis 故障 —— fail-open（放行本发；钱进路径不因缓存故障拒真回调）：${reason}`);
      return false;
    }
  }

  onModuleDestroy(): void {
    this.connection?.disconnect();
    this.connection = null;
  }

  private redis(): Redis {
    if (!this.connection) {
      const connection = this.redisFactory();
      connection.on('error', (err: Error) =>
        this.logger.warn(`回调限流桶 Redis 连接错误（fail-open 姿态）：${err.message}`),
      );
      this.connection = connection;
    }
    return this.connection;
  }
}

/** 默认连接（env 空串 = 未设，`||` 不用 `??`——照 payment 全服务口径）。 */
function defaultNotifyRedis(): Redis {
  return new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

/**
 * 支付宝异步通知入口（唯一路由；`@All` 接全动词——方法自检在 ①闸，不是靠路由缺省）。
 */
@Controller()
export class NotifyController {
  /** ⚠️ **值导入**两个依赖（DI 陷阱纪律）+ 显式 `@Inject`。 */
  constructor(
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(NotifyRateLimiter) private readonly rateLimiter: NotifyRateLimiter,
  ) {}

  @All('pay/notify/alipay')
  async alipayNotify(@Req() req: NotifyHttpRequest, @Res() res: NotifyHttpResponse): Promise<void> {
    // ① 方法闸（仅 POST；其余 405）
    if (req.method !== 'POST') {
      this.reply(res, 405, ANSWER_FAILURE);
      return;
    }

    // ② 内容类型闸（仅 form；415）
    const contentType = firstHeader(req.headers['content-type']);
    if (contentType === null || !contentType.trim().toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      this.reply(res, 415, ANSWER_FAILURE);
      return;
    }

    // ③ 体积闸（≤16KB；超/测不出 ⇒ 413——fail-closed 一侧）
    const size = rawByteLength(req);
    if (size === null || size > NOTIFY_MAX_BODY_BYTES) {
      this.reply(res, 413, ANSWER_FAILURE);
      return;
    }

    // ④ 边缘单桶（600/分；Redis 故障 fail-open——见 NotifyRateLimiter）
    if (await this.rateLimiter.exceeded()) {
      this.reply(res, 429, ANSWER_FAILURE);
      return;
    }

    // ⑤ 验签 ⇒ 四项校验 ⇒ 推进（应答两词由 service 给；两词之外无第三形态）
    const form = isPlainRecord(req.body) ? req.body : {};
    const answer = await this.notify.handleNotify(form, clientPeer(req), rawPayloadOf(req));
    this.reply(res, 200, answer);
  }

  /** 纯文本两词应答（⚙️7：拒绝码也回 `failure`——词面封闭）。
   *
   * ⚠️ **两条语句而非链式**（T9 卡外必要修复）：`.status(...).type(...).send(...)` 链式形态
   * 会让 `room-service/test/meta-on-every-rpc-send.gate.test.ts` 的「非 RPC 的 `res.send`
   * 显式排除面」失配（排除只认**裸 `res` 接收者**）⇒ 本文件被误报「send 缺 meta」。
   * 拆成两条后接收者恰为 `res`（排除面命中；语义逐字不变）——照该闸文件头「假红边界」
   * 段的处方处置（显式形态适配，不删判据）。 */
  private reply(res: NotifyHttpResponse, status: number, body: NotifyAnswer): void {
    res.status(status).type('text/plain');
    res.send(body);
  }
}

/** `express.urlencoded` 产物形态判别（`extended:true` 下嵌套值也在这层被 `NotifyService` 收窄）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** socket peer（**如实记**：不读 XFF/`x-real-ip`——反代后 peer 恒为 edge 容器，照 §2.7.4 口径）。 */
function clientPeer(req: NotifyHttpRequest): string | null {
  const remote = req.socket?.remoteAddress;
  if (typeof remote !== 'string' || remote.length === 0) return null;
  return remote.slice(0, 64); // client_ip varchar(64)
}

/** 原始表单文本（取证列 `raw_payload`；≤16KB 已在 ③闸 内）。 */
function rawPayloadOf(req: NotifyHttpRequest): string | null {
  return Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null;
}
