import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { NextFunction, Request, Response } from 'express';
// ⚠️ R462：豁免/白名单判定全部来自**单一真源** `public-paths.ts`（本文件不得再抄字面量
// —— 就地另抄一份正是「一条路径在一处豁免、在另一处不豁免」的漂移面）。
import { isAdminPath, isClientConfigPath, isHealthPath, requestPath } from './public-paths';
// ⚠️ 值导入：403 + §11.2 信封与玩家/管理面共用**同一份**工具（10003 同族形态）。
import { CodedForbidden } from './jwt.middleware';
import { ClientGateService, classifyClientPlatform } from './client-gate.service';
import { clientGateBlockedTotal, clientGateUnidentifiedTotal } from '../metrics/client-gate.metrics';

/** §0 钉子：头名逐字（值恰 `app`/`h5` 小写；其余一律未识别）。socket 侧（T6）走 `auth.clientPlatform`。 */
export const CLIENT_PLATFORM_HEADER = 'x-client-platform';

/**
 * 端闸中间件（客户端接入片 T5）—— 链上的**第 0 步**（`app.module.ts` 的顺序即契约）。
 *
 * **判定表（三桶；设计 §三）**：
 *  - 头 = `app` / `h5` ⇒ 查 `client.appEnabled` / `client.h5Enabled`（`ClientGateService`）：
 *    仅「拉到过快照且值恰为 `false`」才拒（`CodedForbidden(10008)`），其余一律放行；
 *  - 缺头 / 其它任何值（含大小写变体、空白包裹）⇒ **未识别桶：永远放行**（fail-open）
 *    —— 管理端、监控探针、脚本、未升级老包都在此桶（设计 §三）。
 *
 * **豁免三路**（`next()` 直过，**判定前**短路 —— 也不计 unidentified）：
 *  `/api/admin/*`（`isAdminPath`，双保险：管理端本就不带头）· 健康面（`isHealthPath`，
 *  监控/编排生死线）· `/api/config`（`isClientConfigPath`，H5 被禁时页面须照常初始化）。
 *
 * ⚠️ **位置 = 最前**（先于 `JwtMiddleware`）的理由：公开路径（登录/注册/刷新）也要过闸
 * —— 登录正是要拦的对象；且本中间件**不读也未验任何身份头**（只读自报平台头与路径），
 * 插最前不改变 ①②③ 的相对序与验真纪律（见 `app.module.ts` 的「顺序即契约」注释）。
 *
 * ⚠️ **软开关定位**（设计 §三/§七）：平台头是客户端**自报**值、不做服务端验真（也**不剥**）
 * —— 本闸是 ops 控制手段，**不是**安全边界；注释与文档不得暗示其安全语义。
 *
 * **留痕**（设计 §5.1：网关无 access-log、10008 与其它 403 混桶 ⇒ 本闸自带观测）：
 *  - 拒绝 ⇒ 结构化 warn 一次：`platform=`（已归一为枚举）/ `trigger=switch-off` / `path=`
 *    （traceId 由 NDJSON 日志层经 ALS 自动附带 —— 本层不手工拼，也不断言）；
 *  - ⛔ 头值不落未转义日志：platform 在 `classifyClientPlatform` 已归一为枚举，
 *    path 是请求路径 —— 原始头值在任何情况下都不进日志行（未识别桶干脆不留痕）；
 *  - 两计数器（`client_gate_blocked_total{platform}` / `client_gate_unidentified_total`）。
 */
@Injectable()
export class ClientGateMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ClientGateMiddleware.name);

  constructor(private readonly gate: ClientGateService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const path = requestPath(req);

    // 豁免三路（复用单一真源谓词；⛔ 不在此处写字面量路径）——**判定之前**短路：
    // 豁免路径既不过闸，也不计入 unidentified（C27）。
    if (isAdminPath(path) || isHealthPath(path) || isClientConfigPath(path)) return next();

    const platform = classifyClientPlatform(req.headers[CLIENT_PLATFORM_HEADER]);
    if (platform === null) {
      // 未识别桶：永远放行（fail-open 的固有形态 —— 存量 App / 脚本 / 小程序都在此桶）；
      // 只计存在性信号（⚠️ 不归属任何端，⛔ 不得当「某端流量」推断）。
      clientGateUnidentifiedTotal.inc();
      return next();
    }

    if (this.gate.allows(platform)) return next();

    // 拒绝：先计数、再留痕、后抛 —— 403 + §11.2 信封（CodedForbidden 直出；测试面钉逐字）。
    clientGateBlockedTotal.inc({ platform });
    this.logger.warn(`client-gate blocked platform=${platform} trigger=switch-off path=${path}`);
    throw new CodedForbidden(ErrCode.CLIENT_DISABLED, '当前客户端已暂停服务');
  }
}
