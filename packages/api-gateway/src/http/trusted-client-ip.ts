import proxyaddr from 'proxy-addr';

/** 信任表：空数组 = **不信任任何人**（开发形态）。 */
export type TrustTable = readonly string[];

/**
 * 解析 `TRUST_PROXY`（逗号分隔的地址/CIDR）：
 *  - 空 / 全空白 ⇒ **空信任表**（⚠️ 绝不把这三种空值喂给 `proxyaddr.compile` ——
 *    实测 v2.0.7：`compile('')` 抛错、`compile([])` 返回 `undefined`（⇒ 请求期抛 ⇒ 每请求 500）、
 *    `compile([''])` 抛错 ⇒ 三种行为互不相同）；
 *  - 非空且不可解析 ⇒ **抛错**（fail-closed：宁可起不来，也不要静默信任一切）。
 */
export function parseTrustProxy(raw: string | undefined): TrustTable {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return [];
  proxyaddr.compile([...items]); // 启动期校验（C5）
  return items;
}

/** IPv4-mapped（`::ffff:a.b.c.d`）归一成 IPv4（R1206），其余原样。 */
export function normalizeAddress(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m ? m[1]! : addr;
}

/**
 * 可信客户端 IP —— **唯一实现**（R1207）：HTTP 中间件与 WS `allowRequest` 共用。
 * 输入是 `(headers, socket 对端地址)`（WS 那边没有 Express，拿不到 `req.ip`）。
 * 纪律：**先验对端可信、再采信头**；取不到 IP 不等于豁免（R141）。
 */
export function clientIpFrom(
  headers: Record<string, unknown>,
  socketAddress: string,
  trust: TrustTable,
): string {
  if (trust.length === 0) return normalizeAddress(socketAddress);
  const compiled = proxyaddr.compile([...trust]);
  if (!compiled(socketAddress, 0)) return normalizeAddress(socketAddress);
  const req = { headers, socket: { remoteAddress: socketAddress } };
  return normalizeAddress(proxyaddr(req as never, compiled));
}

/** 进程内信任表（模块加载时解析一次 ⇒ 非法值**启动即失败**）。 */
export const TRUST_TABLE: TrustTable = parseTrustProxy(process.env.TRUST_PROXY);

/** `requestClientIp` 的入参：Express `Request` 的可测**最小结构**（不拖 express 类型进来）。 */
export interface RequestPeerLike {
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: unknown };
  ip?: unknown;
}

/**
 * ③ T5（规格 §2.10 / S8 订正）：**peer 派生** —— 从 `http-rate-limit.middleware.ts:168-173`
 * 的私有实现**平移**到此处的导出 helper，限流（IP 维与登录失败桶）与登录事件
 * （`headersOf()` 的 `clientIp`）两处共用：防「限流 IP」与「登录事件 IP」两口径漂移 ——
 * 同一个请求在两处的账户必须是同一个 IP，否则桶与事件对不上账。
 *
 * 派生序**逐字**（原实现）：
 *  1. `req.socket.remoteAddress` —— 原始来源，不受任何 Express 设置影响；
 *  2. 没有 `socket` / 对端为空串时退回 `req.ip`（§0.3 实测口径：未启用 `trust proxy` 时
 *     `req.ip` 就是对端；**本实现不改 `trust proxy`**，那会造出第二套实现）；
 *  3. 两者都取不到 ⇒ 单一 `'unknown'` 桶 —— **仍然计数**（R141：取不到 IP 不等于豁免，
 *     否则「配上代理头」就成了绕过限流的手法）。
 *
 * ⚠️ 解析（信任表判定 + XFF 取值）仍走**三参** `clientIpFrom`（唯一实现；S8：
 * 不存在 `clientIpFrom(req)` 形态）。
 */
export function requestClientIp(req: RequestPeerLike): string {
  const address = req.socket?.remoteAddress;
  const socketPeer = typeof address === 'string' && address.length > 0 ? address : undefined;
  const peer = socketPeer ?? (typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : 'unknown');
  return clientIpFrom((req.headers ?? {}) as Record<string, unknown>, peer, TRUST_TABLE);
}
