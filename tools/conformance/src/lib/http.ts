/**
 * 真实后端的注册/登录/令牌（走 api-gateway，§5.1 / §7.1）。
 *
 * 响应形态是平台统一信封 `{ code, message, data }`（§11.1）：
 * `code === 0` 才算成功，**HTTP 状态码只作辅助断言**。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { ConformanceError, info } from './assert';

export const GATEWAY_URL = process.env.GW ?? 'http://localhost:3000';
export const NAMESPACE = process.env.DDZ_NAMESPACE ?? '/ws/ddz';

/** §5.2：身份头（直连下游服务时只能自己带，见 `directJson`）。 */
export const USER_ID_HEADER = 'x-user-id';

/**
 * §5.2 规则 3 的内部令牌头名。与 `api-gateway/src/auth/identity-headers.ts` 的
 * `INTERNAL_TOKEN_HEADER` 同名；四个下游服务在**全部业务路由**上校验它
 * （`/api/health` 豁免，裁决 R87）。
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * dev/联调形态里 `INTERNAL_SERVICE_TOKEN` 的**默认值**（`docker-compose.override.yml`
 * 的 **6 个服务**逐字相同：user / config / room / game / robot / api-gateway）：
 *
 *   `INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}`
 *
 * ⚠️ **基文件（生产形态）里它是空默认**（`${INTERNAL_SERVICE_TOKEN:-}` —— R98/R144 起
 * 未配置 ⇒ 容器内为空 ⇒ 启动期 fail-closed）。本常量对齐的是**开发形态**：conformance
 * 在宿主机上跑、针对的正是 dev 栈。（T14 实测补登：原注释写「docker-compose.yml 里
 * 5 个服务」——基文件早已换成空默认、且片⑦ 起是 6 个服务。）
 *
 * ⚠️ 本常量必须与它对**逐字一致**（R96）—— 不一致的话，用 compose 默认值起的平台
 * 会把 conformance 的每一次直连都判成 401，用例全红而原因极难定位。
 */
export const DEFAULT_INTERNAL_TOKEN = 'dev-internal-token-change-in-production';

/**
 * conformance 直连下游服务时用的内部 token。
 *
 * 优先级：`INTERNAL_TOKEN` → `INTERNAL_SERVICE_TOKEN` → `DEFAULT_INTERNAL_TOKEN`。
 * 之所以也认 `INTERNAL_SERVICE_TOKEN`：那是 compose 自己的变量名，
 * 若有人用 `.env` 覆盖了它而 conformance 只认 `INTERNAL_TOKEN`，两边就会**静默**不一致。
 */
export const INTERNAL_TOKEN =
  process.env.INTERNAL_TOKEN ?? process.env.INTERNAL_SERVICE_TOKEN ?? DEFAULT_INTERNAL_TOKEN;

/** §5.1：`registerUser` 用的密码。需要「直连登录」的用例复用它，避免两处漂移。 */
export const HARNESS_PASSWORD = 'passw0rd';

export interface HarnessUser {
  id: string;
  phone: string;
  nickname: string;
  /** §5.1：access token（2h），用于 HTTP `Authorization` 与 WS 握手。 */
  accessToken: string;
  /** §5.1：refresh token（7d），仅用于 `/api/auth/refresh`。 */
  refreshToken: string;
}

export interface Envelope<T = any> {
  code: number;
  message?: string;
  data?: T;
}

export interface HttpResult<T = any> {
  status: number;
  body: Envelope<T> | null;
  /**
   * 响应头（**小写键**）。本片（可观测性）加：判据 6 要从 `x-trace-id` 回传头里取 id
   * ⇒ 没有它就只能绕过本助手手搓 fetch（那会把 §11.1 信封与身份头的处理复制一份）。
   * ⚠️ 加性字段：既有切片只读 `status`/`body`，不受影响。
   */
  headers?: Record<string, string>;
}

/**
 * 「写进死套接字」类失败的判定（**只**用于幂等读的有界重试，见 `fetchDeadSocketRetry`）。
 *
 * undici 把根因挂在 `err.cause` 链上（同 `run.ts` 的打印口径）：三个码各对应一种
 * 「连接已死」的实测形态 —— `UND_ERR_SOCKET`（SocketError: other side closed，
 * FIN 已到、写进去才发现）、`ECONNRESET`（RST）、`EPIPE`（半关写失败）。
 */
function isDeadSocketFailure(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)?.cause;
  const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'EPIPE' ? code : null;
}

/**
 * 经网关请求的**死套接字**有界重试（2026-10-02，C17b② 偶发 `fetch failed` 根因修复）。
 *
 * 根因（T18 调试轮：真栈复现 4/4 + 网关日志零命中 + undici 源码逐行核对）：
 *  1. 本套件把 `docker compose …` 全走 `spawnSync`（`compose()`/`exec()`）——语义就是
 *     **同步冻结宿主进程的事件循环**（C17a/C17b 的重建可达 15–40s）；
 *  2. 冻结期间，网关（Node http server，keepAliveTimeout=5s）会照常关掉每一个空闲
 *     keep-alive 套接字；而 undici 的全部防护都依赖事件循环轮转：3s 空闲计时器、
 *     FIN/RST 处理、以及 GHSA-35p6 的空闲套接字校验（该校验**每个套接字只做一次**，
 *     writeH1 之后即被清掉）——冻结期间一个都跑不了；
 *  3. 解冻后紧随的 dispatch 可能被池挑中一个**已被对端关闭**的复用套接字，请求字节
 *     直接写进死套接字 ⇒ 1–10ms 内 `fetch failed / SocketError: other side closed`。
 *     **undici 自身不重试**（undici 7.21 实测：服务端杀复用连接 ⇒ 该 GET 直接失败）。
 *  复现命令与判别证据：`.superpowers/sdd/2026-10-01-config-center/t18dbg-01/`
 *  （`dead-socket-repro.cjs` 修复前 4/4 红；同窗口 api-gateway 日志 0 行 ⇒ 请求根本没到网关）。
 *
 * 归 harness 侧（产品无责）：没有任何请求到达平台，真实用户也不会同步冻结自己的事件循环。
 * ⇒ 对**幂等读（GET）**做**有界**（恰一次）重试；每次重试**必打日志**（不许静默掩盖 ——
 *   与 `assertGatewayHealthy` 的「有界重试 + 有界超时」先例同一条纪律）。
 *
 * ⚠️ **只许用于 GET**：POST/PUT/DELETE 可能在「响应丢失」之前已改变服务端状态 —— 重试会破坏
 *    「同键并发 PUT ⇒ version = v0+2」这类判据（C13）与建房/下单类探针的语义（支付配置管理化片
 *    的 DELETE 是幂等契约，不重试纯属保守取舍：宁可环境性偶发红，也不引入语义模糊）。
 * ⚠️ 判据面**零放宽**：重试只在「抛出、且 cause 是连接级死套接字」时发生；任何拿到
 *    响应的交换（含 4xx/5xx/信封错误码，如 12006）一律**不**重试 —— 那是真状态。
 * ⚠️ 直连（`directJson`/`waitRoomHealthy` 等）不走这里：直连探针各自已有有界的
 *    重试/轮询循环（如 `waitRoomHealthy` 的 1s 循环），本修复不扩面。
 */
async function fetchDeadSocketRetry(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${GATEWAY_URL}${path}`, init);
  } catch (err) {
    const code = method === 'GET' ? isDeadSocketFailure(err) : null;
    if (!code) throw err;
    info(
      `↻ GET ${path} 连接级失败（${code}: ${err instanceof Error ? err.message : String(err)}）—— ` +
        `池内 keep-alive 套接字已被对端关闭（spawnSync(docker …) 冻结事件循环的后遗症，见本函数注释）；` +
        `幂等读 ⇒ 有界重试一次`,
    );
    // 死套接字已被 undici 移出池 ⇒ 这一发必然新建连接；再失败则**原样**上抛（不第三次）。
    return await fetch(`${GATEWAY_URL}${path}`, init);
  }
}

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  // `extraHeaders` 排在最前：本助手自己设置的头（Content-Type / Authorization）
  // 永远优先，调用方**无法**靠它改掉身份。
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchDeadSocketRetry(method, path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Envelope | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    parsed = { code: res.status, message: text };
  }
  // 响应头一律转小写键（`Headers` 本来就是小写，这里显式一次，调用方不必猜大小写）。
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  return { status: res.status, body: parsed, headers: responseHeaders };
}

export function postJson<T = any>(path: string, body: unknown, token?: string): Promise<HttpResult<T>> {
  return request('POST', path, body, token);
}

/**
 * 经网关的 GET。
 *
 * `extraHeaders` 用于**故意**在网关边缘带一个不该带的头 —— `slice-07.2-boundary`
 * 第 5 步就用它模拟「外部调用方伪造 `X-Internal-Token`」。
 */
export function getJson<T = any>(
  path: string,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult<T>> {
  return request('GET', path, undefined, token, extraHeaders);
}

/**
 * 经网关的 PUT（片⑦ 起：管理面 `PUT /api/admin/config/:key`）。
 *
 * ⚠️ 刻意**不开放** `extraHeaders`（与 `postJson` 同形）：本仓还没有需要它的 PUT 调用点，
 * 少一个口子就少一条「调用方能改掉身份」的路；将来要放开时照 `getJson` 的样子加。
 */
export function putJson<T = any>(path: string, body: unknown, token?: string): Promise<HttpResult<T>> {
  return request('PUT', path, body, token);
}

/**
 * 经网关的 PATCH（代理分润片 2026-10-26：管理端代理资料/设置/payout 用 PATCH）。
 *
 * ⚠️ 与 `putJson` 同族同形：**不开放** `extraHeaders`，**不**做死套接字重试。
 */
export function patchJson<T = any>(path: string, body: unknown, token?: string): Promise<HttpResult<T>> {
  return request('PATCH', path, body, token);
}

/**
 * 经网关的 DELETE（支付配置管理化片起：管理面 `DELETE /api/admin/pay-channel/:key`）。
 *
 * ⚠️ 与 `putJson` 同族同形、同保守：**不开放** `extraHeaders`（调用方无法改身份）、
 *    **不**做死套接字重试（判据面纪律，见 `fetchDeadSocketRetry`）。
 */
export function delJson<T = any>(path: string, token?: string): Promise<HttpResult<T>> {
  return request('DELETE', path, undefined, token);
}

// ────────────────────────────────────────────────────────────────────────────
// 片⑦：管理面（`/api/admin/*`）—— 开关类判据（slice-06/07.1/07.2-hardening/12
// 的前置、slice-14 的正主）都靠这一小块。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 管理口令（config-service 的 `POST /api/admin/login` 用它登录；引导账号名恒为 `admin`）。
 *
 * ⚠️ 默认值必须与 `scripts/deploy/conformance-stack.sh` 的
 * `export ADMIN_PASSWORD="${ADMIN_PASSWORD:-conformance-admin-pass}"` **逐字一致**
 * （**两处同源**；同族教训 = 上面的 `DEFAULT_INTERNAL_TOKEN`）。那个 export 是 CI/起栈侧给
 * **首启 bootstrap** 的真源（零账号时 `INSERT` 引导行 `admin`，口令 = 该 env）。
 *
 * ⛔ **旧的「dev 栈用 `ADMIN_PASSWORD=` 空串覆盖 ⇒ 管理面整体关闭（登录 404）」机制已失效**
 * （③ T2/RBAC 起，规格 ⚙️16）：`ADMIN_PASSWORD` 只在**空表首启**喂 bootstrap，账号一旦在库，
 * env 就不再是开关 —— 以空串重建 config-service 后，用运行侧口令登录**仍然 200**
 * （`slice-14` C6半 就是按新语义重写的；「零账号 ⇒ 404」由 config-service 单测钉）。
 * 存量 dev 卷的引导口令对不上时，用 hatch CLI 复位（规格 §2.13），不要指望重起容器。
 */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'conformance-admin-pass';

/**
 * 管理登录 ⇒ 管理令牌（aud `ftl-admin`，TTL 7200s）。失败 ⇒ 抛（口令错 ⇒ 401；零账号 ⇒ 404）。
 *
 * ⚠️ body = `{username:'admin', password}`（③ 起管理面按账号登录；`username` 引导账号恒 `admin`）。
 * 本仓全部消费切片（06/07.1/07.2-hardening/12/13/14/15/17/18）自动跟随本函数，**不要在调用方
 * 各自拼 body** —— 一处改、全体跟随。
 */
export async function adminLogin(): Promise<string> {
  const res = await postJson<{ token: string; expiresIn: number }>('/api/admin/login', {
    username: 'admin',
    password: ADMIN_PASSWORD,
  });
  const token = res.body?.data?.token;
  if (res.body?.code !== ErrCode.OK || !token) {
    throw new ConformanceError(
      `管理登录失败：HTTP ${res.status} ${JSON.stringify(res.body)}（口令与 config-service 的 ADMIN_PASSWORD 是否一致？）`,
    );
  }
  return token;
}

/** `GET /api/admin/config`：全量四十四键 + 每键 version + 全局 MAX（持管理令牌读）。 */
export function adminGetConfig<T = any>(token: string): Promise<HttpResult<T>> {
  return getJson<T>('/api/admin/config', token);
}

/** `PUT /api/admin/config/:key`：管理写（持管理令牌）；body 恒为 `{ value }`。 */
export function adminPutConfig(key: string, value: unknown, token: string): Promise<HttpResult> {
  return putJson(`/api/admin/config/${encodeURIComponent(key)}`, { value }, token);
}

// ────────────────────────────────────────────────────────────────────────────
// 支付配置管理化片：渠道凭据六键管理面（`/api/admin/pay-channel`）。
// 契约 = 片规格 §2.4：GET 任意已认证角色；PUT/DELETE 仅 super_admin（403 由网关 policy 给，
// 不在本 helper 面）。⚠️ 键名含 `.`（`pay.channel.*`）⇒ `:key` 一律 `encodeURIComponent`
// （R75 先例，与 `adminPutConfig` 同款）。
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/admin/pay-channel`：六项 `{key,label,secret,configured,value,fingerprint,updatedAt,updatedBy}`（secret 键 `value` 恒 null）。 */
export function adminPayChannelGet<T = any>(token: string): Promise<HttpResult<T>> {
  return getJson<T>('/api/admin/pay-channel', token);
}

/** `PUT /api/admin/pay-channel/:key`：管理写（仅 super_admin）；body 恒为 `{ value }`。 */
export function adminPayChannelPut(key: string, value: string, token: string): Promise<HttpResult> {
  return putJson(`/api/admin/pay-channel/${encodeURIComponent(key)}`, { value }, token);
}

/** `DELETE /api/admin/pay-channel/:key`：清空（仅 super_admin；幂等——行不存在也 200）。 */
export function adminPayChannelDelete(key: string, token: string): Promise<HttpResult> {
  return delJson(`/api/admin/pay-channel/${encodeURIComponent(key)}`, token);
}

// ────────────────────────────────────────────────────────────────────────────
// 通知通道管理化片：通知通道九键管理面（`/api/admin/notify-channel`）。
// 契约 = 通知片规格 §2.4：GET 任意已认证角色；PUT/DELETE 仅 super_admin（403 由网关 policy
// 给，不在本 helper 面）。⚠️ 键名含 `.`（`notify.*`）⇒ `:key` 一律 `encodeURIComponent`
// （R75 先例，与 `adminPutConfig` 同款；`.` 是 unreserved ⇒ 字面形态即它本身）。
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/admin/notify-channel`：九项 `{key,label,secret,configured,value,fingerprint,hint,updatedAt,updatedBy}`（密键 `value` 恒 null）。 */
export function adminNotifyChannelGet<T = any>(token: string): Promise<HttpResult<T>> {
  return getJson<T>('/api/admin/notify-channel', token);
}

/** `PUT /api/admin/notify-channel/:key`：管理写（仅 super_admin）；body 恒为 `{ value }`。 */
export function adminNotifyChannelPut(key: string, value: string, token: string): Promise<HttpResult> {
  return putJson(`/api/admin/notify-channel/${encodeURIComponent(key)}`, { value }, token);
}

/** `DELETE /api/admin/notify-channel/:key`：清空（仅 super_admin；幂等——行不存在也 200）。 */
export function adminNotifyChannelDelete(key: string, token: string): Promise<HttpResult> {
  return delJson(`/api/admin/notify-channel/${encodeURIComponent(key)}`, token);
}

// ────────────────────────────────────────────────────────────────────────────
// 广告片：第四键空间（广告回调密钥）管理面（`/api/admin/ad-channel`）。
// 契约 = 片规格 §2.3：GET 任意已认证角色；PUT/DELETE 仅 super_admin（403 由网关 policy 给，
// 不在本 helper 面）。⚠️ 键名含 `.`（`ad.callbackSecret`）⇒ `:key` 一律 `encodeURIComponent`
// （R75 先例，与 `adminPutConfig` 同款；`.` 是 unreserved ⇒ 字面形态即它本身）。
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/admin/ad-channel`：单键项 `{key,label,secret,configured,value,fingerprint,updatedAt,updatedBy}`（全密键 ⇒ `value` 恒 null）。 */
export function adminAdChannelGet<T = any>(token: string): Promise<HttpResult<T>> {
  return getJson<T>('/api/admin/ad-channel', token);
}

/** `PUT /api/admin/ad-channel/:key`：管理写（仅 super_admin）；body 恒为 `{ value }`。 */
export function adminAdChannelPut(key: string, value: string, token: string): Promise<HttpResult> {
  return putJson(`/api/admin/ad-channel/${encodeURIComponent(key)}`, { value }, token);
}

/** `DELETE /api/admin/ad-channel/:key`：清空（仅 super_admin；幂等——行不存在也 200）。 */
export function adminAdChannelDelete(key: string, token: string): Promise<HttpResult> {
  return delJson(`/api/admin/ad-channel/${encodeURIComponent(key)}`, token);
}

/**
 * 置好友房开关并**轮询至生效**（片规格 §3 的 `setFriendRooms`）。
 *
 * ⚠️ 生效观测点 = **建房行为**（`POST /api/rooms` 的返回码）—— 那是 room-service
 * **缓存**的真实出口（片⑦ T7：controller 入口按 `configCache.friendRoomEnabled()` 拦）；
 * `GET /api/config` 每次查库、只反映**库**，证不了消费侧缓存已经换过来。
 *
 * ⚠️ 轮询产生的**探针房是副产品**（enable 路径必然会成功建出一间、留在 Redis 里；
 * 手动房有回收窗口，无害）—— 不要把它当成「测试没清干净」。
 *
 * ⚠️ 超时 30s **小于**消费侧 60s 安全网（片规格 C1）：只证**推送**路径，不靠兜底。
 * ⚠️ 只置位、不还原 —— 片的收尾（还原 false）是 slice-14 统一编排的职责（规格 §3 末）。
 */
export async function setFriendRooms(enabled: boolean, playerToken: string): Promise<void> {
  const admin = await adminLogin();
  const put = await adminPutConfig('game.doudizhu.friendRoomEnabled', enabled, admin);
  if (put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`置 friendRoomEnabled=${enabled} 失败：${JSON.stringify(put.body)}`);
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const probe = await postJson('/api/rooms', { mode: 'random' }, playerToken);
    const effective = enabled ? probe.body?.code === ErrCode.OK : probe.body?.code === ErrCode.FRIEND_ROOM_FAILED;
    if (effective) return;
    if (Date.now() >= deadline) {
      throw new ConformanceError(`friendRoomEnabled=${enabled} 30s 内未生效（最后一次 ${probe.body?.code}）`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * S8：`GET /api/games/:roomCode/state` **不经网关**（§7.1 的网关路由表里没有它），
 * 因此覆盖它必须直连 game-service —— compose 已发布该端口。
 */
export const GAME_URL = process.env.GAME_URL ?? 'http://localhost:3003';

/** 其余三个下游服务的直连基址（compose 已发布 3001 / 3002 / 3005）。 */
export const USER_URL = process.env.USER_URL ?? 'http://localhost:3001';
export const ROOM_URL = process.env.ROOM_URL ?? 'http://localhost:3002';
export const ROBOT_URL = process.env.ROBOT_URL ?? 'http://localhost:3005';

/**
 * DouZero 推理服务（`slice-11` 场景 C 直连它钉**线协议**）。
 *
 * ⚠️ 它不是平台服务：不在网关路由表里、没有内部 token、也不属于 `Envelope` 信封族 ——
 *    它是 robot-service 的一个**外部 AI 依赖**，compose 已发布 2021
 *    （`scripts/deploy/conformance-stack.sh` 的 `SERVICES` 里含 `douzero`）。
 */
export const DOUZERO_URL = process.env.DOUZERO_URL ?? 'http://localhost:2021';

/** `directJson()` 的可选入参。 */
export interface DirectCall {
  method?: 'GET' | 'POST';
  /** §5.2：直连没有网关，`X-User-Id` 只能自己带 —— 这正是偏差 N4 的冒充形态。 */
  userId?: string | null;
  /**
   * §5.2 规则 3 的内部 token。`undefined` / `null` / `''` ⇒ **不带**该头
   * （「无 token 必须被拒」的探针就靠它）；要带正确值请显式传 `INTERNAL_TOKEN`。
   */
  internalToken?: string | null;
  /** 额外头（例如 `authorization`）；本助手自己的头优先，调用方覆盖不了。 */
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * **直连**某个下游服务的通用助手（不经网关）。
 *
 * ⚠️ 响应形状与走网关的 `getJson` 不同，且**因服务而异**：
 * `game-service` 的 `GET /api/games/*` 成功时返回**裸 `PlayerView`**
 * （不是 `{ code, message, data }` 信封，见 `game.controller.ts` 的 `get()`/`getState()`），
 * 错误路径才是 `{ code: <5 位>, message }`；`robot-service` 的 `GET /api/robots/list`
 * 又直接返回裸数组。两者都塞进 `body`，由调用方按形状自行分辨；
 * 需要看未解释的 JSON 时用 `raw`。
 */
export async function directJson<T = any>(
  baseUrl: string,
  path: string,
  call: DirectCall = {},
): Promise<HttpResult<T> & { raw: unknown }> {
  const headers: Record<string, string> = { ...(call.headers ?? {}) };
  if (call.body !== undefined) headers['Content-Type'] = 'application/json';
  if (call.userId) headers[USER_ID_HEADER] = call.userId;
  if (call.internalToken) headers[INTERNAL_TOKEN_HEADER] = call.internalToken;

  const res = await fetch(`${baseUrl}${path}`, {
    method: call.method ?? 'GET',
    headers,
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });
  const text = await res.text();
  let raw: unknown = null;
  let parsed: Envelope<T> | null = null;
  try {
    raw = text ? JSON.parse(text) : null;
    parsed = raw as Envelope<T>;
  } catch {
    parsed = { code: res.status, message: text };
  }
  return { status: res.status, body: parsed, raw };
}

/**
 * 直连 game-service 的 GET。
 *
 * 身份按 §5.2 只从 `X-User-Id` 头注入 —— 直连时没有网关，只能自己带；
 * 这也让本助手**只能**扮演「某个已认证用户」，无法伪造别人。
 *
 * ⚠️ R96：P1 之后 game-service 的**全部业务路由**都校验 `X-Internal-Token`
 * （仅 `/api/health` 豁免），所以这里的 `internalToken` **默认为正确的内部 token**。
 * 否则直连一律 401，而 `slice-07.2-security` 第 5 步会把「401 = 被拒」判为通过 ⇒
 * 「对照组不是空测」那条证明被**静默**抹掉（安全上没错，判据没了）。
 * 想故意**不带**它（证明边界生效）就显式传 `null`。
 */
export async function gameGetJson<T = any>(
  path: string,
  userId?: string,
  internalToken: string | null = INTERNAL_TOKEN,
): Promise<HttpResult<T> & { raw: unknown }> {
  return directJson<T>(GAME_URL, path, { userId, internalToken });
}

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone?: string; nickname?: string | null };
}

function toHarnessUser(data: AuthPayload, phone: string, fallbackNickname: string): HarnessUser {
  return {
    id: data.user.id,
    phone: data.user.phone ?? phone,
    nickname: data.user.nickname ?? fallbackNickname,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
}

/** 服务端只要求 11 位手机号 + 6 位密码；每轮用不同号码避免 `11001`。 */
export async function registerUser(index: number): Promise<HarnessUser> {
  const suffix = String(Date.now()).slice(-6) + Math.floor(Math.random() * 10);
  const phone = `139${index}${suffix}`.slice(0, 11);
  const nickname = `cf${index}-${suffix.slice(-4)}`;

  const { status, body } = await postJson<AuthPayload>('/api/auth/register', {
    phone,
    password: HARNESS_PASSWORD,
    nickname,
  });
  if (status !== 201 || body?.code !== 0 || !body.data?.accessToken) {
    throw new ConformanceError(`注册失败 phone=${phone} HTTP ${status}: ${JSON.stringify(body)}`);
  }
  return toHarnessUser(body.data, phone, nickname);
}

/** §5.1：`POST /api/auth/login`。失败时也返回信封，由调用方断言 `code`。 */
export function login(phone: string, password: string): Promise<HttpResult<AuthPayload>> {
  return postJson<AuthPayload>('/api/auth/login', { phone, password });
}

/** §5.1：`POST /api/auth/refresh` —— 轮换，旧 refresh token 立即失效。 */
export function refresh(refreshToken: string): Promise<HttpResult<{ accessToken: string; refreshToken: string }>> {
  return postJson('/api/auth/refresh', { refreshToken });
}

/** §5.1：`POST /api/auth/logout` —— 删除两个 jti；需要 access token（网关会注入其 jti）。 */
export function logout(accessToken: string, refreshToken?: string): Promise<HttpResult<null>> {
  return postJson<null>('/api/auth/logout', refreshToken ? { refreshToken } : {}, accessToken);
}

/** 网关健康检查，用于在跑用例前给出「服务没起」的明确报错。 */
/** 网关就绪等待（**有界**）。套件是**按序连跑**的，而 `slice-07.3-edge` 的收尾会重建网关。 */
const GATEWAY_READY_TIMEOUT_MS = 60_000;
const GATEWAY_READY_POLL_MS = 2_000;
/** **单次**尝试的上限。⚠️ 少了它，「60s 上限」是假的（见函数内注释）。 */
const GATEWAY_ATTEMPT_TIMEOUT_MS = 5_000;

export async function assertGatewayHealthy(): Promise<void> {
  // ⚠️ **有界重试**（2026-09-25，CI 首次真栈跑抓到根因）：套件按序**连跑**，而
  //    `slice-07.3-edge` 的收尾会 `docker compose up -d --no-deps api-gateway` **重建网关**
  //    （把注入的 `TRUST_PROXY` 复原成开发默认值）—— 重建后容器要几秒才就绪。
  //    原先这里**只发一次** fetch ⇒ 紧随其后的 `slice-12` 必然「连不上」。
  //    实测根因（不是猜）：本机连续跑 `slice-07.3-edge`（**通过**）后立刻跑 `slice-12`
  //    ⇒ **稳定复现**同一条失败 ⇒ 与 Linux 无关，是**顺序 + 就绪**问题，此前从未被跑到
  //    （计划里「本机按序跑全套」那一步与 gh 项一起后移了）。
  //    ⚠️ 这里等的是**上一个切片收尾后栈重新就绪**，不是产品缺陷 —— 所以是重试，不是放宽判据。
  //    ⚠️ **有界**：网关真起不来时照样红，只是晚 60s。⚠️ 只在「连不上」与 **503**（就绪端点自己
  //    说的「未就绪」）上重试；其它非 200 立刻红 —— 那是真状态，重试只会掩盖它。
  const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
  let lastFailure = '';
  for (;;) {
    try {
      // ⚠️ **单次尝试也必须自带超时**（2026-09-25，控制者自查出的自家缺陷）：`fetch` **没有**
      //    默认超时 —— 而 Docker 的端口代理会**先接受 TCP 连接**、再等容器里的进程应答；
      //    容器刚重建、进程还没 listen 时，这个 `await` 可以**一直挂着** ⇒ 循环根本走不到
      //    下面的 deadline 判断 ⇒ 所谓「有界」是**假的**（与终审在冒烟 curl 上抓到的是同一类：
      //    `60 次 × 5s` 不是上限，**单次**才决定上限）。⏱ 单次 5s ⇒ 真上限 = 60s + 一次尝试。
      const res = await fetch(`${GATEWAY_URL}/api/health`, {
        signal: AbortSignal.timeout(GATEWAY_ATTEMPT_TIMEOUT_MS),
      });
      if (res.status === 200) return;
      if (res.status !== 503) {
        throw new ConformanceError(`api-gateway /api/health 返回 ${res.status}，期望 200`);
      }
      lastFailure = `HTTP ${res.status}（就绪端点自报未就绪）`;
    } catch (err) {
      // 判据性的失败**不许**被重试吞掉：自己抛的 ConformanceError 直接穿透。
      if (err instanceof ConformanceError) throw err;
      lastFailure = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new ConformanceError(
        `连不上 api-gateway（${GATEWAY_URL}）：${lastFailure}\n` +
          `  已等待 ${GATEWAY_READY_TIMEOUT_MS / 1000}s 仍未就绪。按序连跑时上一个切片收尾会重建网关，等它是正常的；` +
          `若持续如此：先 docker compose build && docker compose up -d（镜像可能是旧的），或见 scripts/verify-dod.sh。`,
      );
    }
    await new Promise((r) => setTimeout(r, GATEWAY_READY_POLL_MS));
  }
}
