/**
 * REST 调用（认证走 REST，WebSocket 不承载登录 —— §5.1）。
 *
 * 前端不发规则、不算分；这里只做「把服务端说的话搬回来」。
 * 统一响应形态 `{ code, message, data }`（§11.1），`code === 0` 才是成功。
 *
 * 鉴权：需要身份的请求走 `authedRequest`，自动带 `Authorization: Bearer <access>`；
 * 收到 `10004`（Token 已过期/已吊销）时，用 refresh token **轮换一次**（§5.1）
 * 后**重放一次**原请求。不循环重试——轮换也失败就把 `10004` 原样交给调用方。
 */
import {
  ErrCode,
  type Card as ProtocolCard,
  type ClientConfig,
  type GameType,
  type PdkRecord,
  type RoomInfo,
} from '@fight-the-landlord/protocol';
import { clientConfig } from '../config';
import { TransportFailureError, requestJson, resolveApiBase, type JsonRequest } from './http';
import { detectPlatform } from './mp-transport';
import { getDeviceId } from './storage';
import { refreshTokens, rotateRefreshToken, type TokenRenewResult } from './token-refresh';

export interface RestResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface AuthUser {
  id: string;
  phone?: string;
  /**
   * 服务端的 `user.nickname` 可以是 `null`（`auth.service.ts`：`dto.nickname ?? null`）——
   * 不是「没字段」，是服务端明确说的「这个人没有昵称」⇒ 消费点用 `?? ''` 归一，
   * 回落（昵称 → 手机号 → userId）交给 `auth.displayName`。
   */
  nickname?: string | null;
}

/** R25：认证接口恒返回 refresh token，客户端不解析有效期（`expiresIn` 不返回）。 */
export interface LoginResult extends AuthTokens {
  refreshToken: string;
  user: AuthUser;
}

/**
 * 解析统一信封 `{ code, message, data }`（§11.1）。
 *
 * ⚠️ **不得把 HTTP 状态码当业务错误码用**：§11.2 的码是 5 位数字、按服务分段，
 * `code: 200` 这种东西既有歧义（`200 !== 0` 会被上层报成「失败：code=200」），
 * 也不在 `CLIENT_ACTION` 表里。因此——响应体不是 JSON、或不是带数字 `code` 的信封
 * （空体、HTML 错误页、裸数组…）——一律映射为 `10007`（下游不可用），
 * 这是「拿到的不是平台信封」这一类事实的唯一表达。
 */
function parse(res: { statusCode: number }, text: string): RestResponse<unknown> {
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as RestResponse<unknown>).code === 'number'
      ) {
        return parsed as RestResponse<unknown>;
      }
    } catch {
      // 非 JSON：落到下面的统一兜底
    }
  }
  return {
    code: ErrCode.UPSTREAM_UNAVAILABLE,
    message: `响应不是平台信封（HTTP ${res.statusCode}）`,
  };
}

/**
 * 客户端接入片 §0（C30）：端标识头 —— HTTP 识别边（网关 `ClientGateMiddleware`
 * 按它判端闸；socket 侧同口径见 `config.ts#buildSocketAuth` 的 `clientPlatform`）。
 *
 * browser→`h5`；app→`app`；mp-weixin/未知 ⇒ **不带**（未识别流量照常放行，且
 * **不臆造**标识）。
 * ⚠️ 平台在**调用时**判定（`detectPlatform()` 不在模块顶层读 uni，与 `http.ts` 同规矩）。
 * ⚠️ 只有经本模块 `request()` 收口的请求带头；两处裸 `uni.request`
 *（`useVersionCheck` 的 `/version.json`、`observability/reporter` 的外部收集端）
 * **不经收口、按设计不注入**（负对照用例钉在上述两处）。
 */
export function clientPlatformHeaders(): Record<string, string> {
  const kind = detectPlatform();
  if (kind === 'browser') return { 'X-Client-Platform': 'h5' };
  if (kind === 'app') return { 'X-Client-Platform': 'app' };
  return {};
}

/**
 * 发一次请求，并把应答交给**唯一**的信封解析点（`parse`）。
 *
 * 传输从裸 `fetch` 换成 `http.ts` 的适配器（切片 P17 / R549）后，多出一个分支要在这里收口：
 * 小程序端 `uni.request` 的 `fail` 是**抛错**出来的（`TransportFailureError`，没有拿到任何应答），
 * 它与「拿到的不是平台信封」是**同一类事实** ⇒ 交给**既有的** `parse` 兜底（HTTP 0）→ `10007`。
 *
 * ⚠️ **只 catch 这一个类**：H5 上 `fetch` 的拒绝（`TypeError: Failed to fetch`）继续原样抛出 ——
 * 那条路径的传播行为**一字不改**（P9 真浏览器探针 + 发行产物级探针压着它）。
 *
 * 客户端接入片（C30）：端标识头在**本收口点**合并进最终 headers（全量 REST 一处注入；
 * 平台头最后展开 ⇒ 调用点无法改写端标识，且不与既有 `content-type` / `Authorization` 相冲）。
 */
async function request<T>(input: JsonRequest): Promise<RestResponse<T>> {
  try {
    const res = await requestJson({
      ...input,
      headers: { ...input.headers, ...clientPlatformHeaders() },
    });
    return parse(res, res.text) as RestResponse<T>;
  } catch (error) {
    if (!(error instanceof TransportFailureError)) throw error;
    return parse({ statusCode: error.statusCode }, '') as RestResponse<T>;
  }
}

/** 公开路径（登录/注册/换令牌）用的 POST：不带 `Authorization`。 */
async function post<T>(path: string, body: unknown): Promise<RestResponse<T>> {
  return request<T>({
    url: `${resolveApiBase()}${path}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const value = token ?? clientConfig.token;
  if (value) headers.Authorization = `Bearer ${value}`;
  return headers;
}

async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<RestResponse<T>> {
  const headers = authHeaders(token);
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return request<T>({
    url: `${resolveApiBase()}${path}`,
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * 设备绑定片：登录/注册/refresh 的公开载荷**恒带 `deviceId`**（持久指纹，缺省也总有
 * 一枚域内 id —— 见 `storage.getDeviceId()`）。服务端在开关开启时「无绑行静默首绑 /
 * 不一致拒 11005」；开关关时该字段被忽略。三个端点一枚 id，不分支、不缓存。
 */
export function login(phone: string, password: string): Promise<RestResponse<LoginResult>> {
  return post<LoginResult>('/auth/login', { phone, password, deviceId: getDeviceId() });
}

export function register(
  phone: string,
  password: string,
  nickname: string,
  inviteCode?: string,
): Promise<RestResponse<LoginResult>> {
  return post<LoginResult>('/auth/register', {
    phone,
    password,
    nickname,
    ...(typeof inviteCode === 'string' && inviteCode.trim() !== ''
      ? { inviteCode: inviteCode.trim().toUpperCase() }
      : {}),
    deviceId: getDeviceId(),
  });
}

/**
 * 提交 3：提现敏感操作再认证——凭 access token + 登录密码换一次性票据。
 * 票据 5min 有效，带 `X-Reauth-Ticket` header 调 `/api/pay/withdrawals`。
 * 开关 risk.withdrawReAuthEnabled 默认 false（暗上线）——关闭时客户端不调本方法。
 */
export function reauth(password: string): Promise<RestResponse<{ ticket: string }>> {
  return authedRequest<{ ticket: string }>('POST', '/auth/reauth', { password });
}

/**
 * §5.1：登出（删除 access 与 refresh **两个** `jti`）。R33 / R35。
 *
 * ⚠️ 必须带 `Authorization`：网关只在**验签后**才把 access token 的 `jti` 通过内部头
 * `X-Token-Jti` 转给 user-service（`/api/auth/logout` 不在公开路径白名单里），
 * 因此不带令牌的登出会被网关拒成 401、两个 `jti` 一个也删不掉。
 * 令牌由调用方显式传入（不读 `clientConfig`）：登出正是要作废这里的令牌。
 *
 * **先轮换、再登出**（R35）：access 已失效时第一次登出会拿到 `10004`，此时用 refresh token
 * 换一对新的 `(a2, r2)` —— 轮换本身就把**旧** refresh 的 `jti` 吊销了 —— 再用新的一对登出，
 * 于是新旧四个 `jti` 全部失效，闭环成立。轮换也失败就**停**（返回失败响应，不循环），
 * 由调用方清本地并提示。
 *
 * 本函数**不改** `clientConfig` / 本地存储：登出后这些状态一律作废，避免中途留下「半新半旧」的令牌。
 *
 * ⚠️ `ErrCode.TOKEN_EXPIRED` 在这里是**刻意的传输层例外**：`CLIENT_ACTION` 表把 `10004`
 * 登记为 `BACK_TO_LOBBY`（回大厅/登录页），而 REST 客户端要先**就地轮换一次**才有机会
 * 无感续期 —— 轮换失败时才会把这个码原样交给消费点去查表。改表时不要顺手删掉这里的轮换。
 */
export async function logout(
  accessToken: string,
  refreshToken?: string,
): Promise<RestResponse<null>> {
  const body: Record<string, string> = refreshToken ? { refreshToken } : {};
  const first = await send<null>('POST', '/auth/logout', body, accessToken);
  if (first.code !== ErrCode.TOKEN_EXPIRED || !refreshToken) return first;

  const rotated = await refreshTokens(refreshToken);
  if (rotated.code !== 0 || !rotated.data?.accessToken || !rotated.data.refreshToken) {
    // 降级路径：refresh 也不可用/网络不通 → 不循环，把失败如实交给调用方
    return { code: rotated.code, message: rotated.message, data: null };
  }
  return send<null>(
    'POST',
    '/auth/logout',
    { refreshToken: rotated.data.refreshToken },
    rotated.data.accessToken,
  );
}

/**
 * P1-8：REST 侧 refresh 轮换成功后的**会话回填钩子**。
 *
 * `rotateRefreshToken()` 只把新令牌写回 storage + clientConfig；`signOut()` 读的却是
 * auth store 字段 ⇒ 不同步的话登出仍拿**已作废的旧 refresh token**（服务端吊销落空）。
 * net 层**不 import store**（同 token-refresh.ts 的分层纪律）⇒ 由 auth store 在模块
 * 加载时注册反向钩子（`syncTokensFromStorage()`）。缺省 no-op（纯 REST 单测无需 Pinia）。
 */
let tokenRotationHook: (() => void) | null = null;

export function bindRestTokenRotationHook(hook: (() => void) | null): void {
  tokenRotationHook = hook;
}

/**
 * 带鉴权的请求：遇 `ErrCode.TOKEN_EXPIRED` 先经 `rotateRefreshToken()`（token-refresh.ts 五态单飞）
 * 确保令牌新鲜，**rotated** 则重放一次；`unavailable` 返回 `10007` 信封（不杀会话）；
 * `invalid` / `no_session` 原样返回 `10004`（消费点按 `CLIENT_ACTION` 表处置，行为不变）。
 *
 * ⚠️ 同上：`10004` 在传输层**先轮换**，轮换不成才交回消费点按 `CLIENT_ACTION` 表处置。
 *
 * ⚠️ 重放语义只对**只读**路径安全。切片 7 一旦用 POST 走这里，必须给动作请求带上幂等依据
 * （§6.6 的 `baseVersion` / CAS），否则「第一次其实已经生效、只是响应丢了」的请求会被重放成第二次。
 */
export async function authedRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<RestResponse<T>> {
  const first = await send<T>(method, path, body, undefined, extraHeaders);
  if (first.code !== ErrCode.TOKEN_EXPIRED) return first;
  const result: TokenRenewResult = await rotateRefreshToken();
  if (result === 'rotated') {
    // P1-8：把新令牌同步回 auth store（否则 signOut 用旧的 refresh token 登出）。
    tokenRotationHook?.();
    return send<T>(method, path, body, undefined, extraHeaders);
  }
  if (result === 'unavailable') {
    return { code: 10007, message: '续期请求未送达，请检查网络后重试' };
  }
  // invalid / no_session：原样返回 10004，消费点按 CLIENT_ACTION 表处置
  return first;
}

export function authedGet<T>(path: string): Promise<RestResponse<T>> {
  return authedRequest<T>('GET', path);
}

/** §3.1 / R22：`GET /api/rooms` → `{ code, message?, data: RoomInfo[] }`。 */
export function rooms(gameType?: GameType): Promise<RestResponse<RoomInfo[]>> {
  // S5.4：缺省不传 ⇒ 服务端只返回斗地主房（旧客户端语义）；新客户端按 activeMode 传。
  const path = gameType ? `/rooms?gameType=${encodeURIComponent(gameType)}` : '/rooms';
  return authedGet<RoomInfo[]>(path);
}

/**
 * 档位表的一档（片规格 §2.3 的响应形状）。
 *
 * ⚠️ **形状属于接口**：协议包（片⑦）是唯一真源 —— 这里只**re-export**，
 * `fetchClientConfig()` 与消费它的 store 都必须用**同一个**类型
 * （各写一份就是第二真源；`BaseScoreLevel` 的本仓定义已收敛进 protocol）。
 */
export type { BaseScoreLevel, PdkRecord, PdkRecordPlayer } from '@fight-the-landlord/protocol';

/**
 * 片⑦：**客户端配置** —— `GET /api/config` → `{ code, data: { baseScoreLevels, friendRoomEnabled, version } }`。
 *
 * ⚠️ 这条**转发到 config-service**（每次查库、不缓存）：后台改了即生效，前端也**不要缓存**它。
 * 底分数组按 `sort_order` 升序（只是**展示顺序**）：本函数**只负责把服务端那张表搬回来** ——
 * 底分取自用户在大厅选中的那一档（`game` store 的 `selectedBaseScore` 持有），**不是**「取第一档」。
 *
 * 用途（协议②）：`room.match` 的 `baseScore` 必填，而前端**不得**含规则常量（M09）
 * ⇒ 底分只能取自服务端下发的这张表（**不猜、也不写死**）。只读 GET ⇒ 重放安全。
 *
 * ⚠️ `friendRoomEnabled` 是**好友房入口**的门控位（C19 fail-safe：未知 = 隐藏，见 store）。
 *
 * ⚠️ 函数名是 `fetchClientConfig`，**不是** `clientConfig`：本文件 `:12` 已经 import 了
 * 一个叫 `clientConfig` 的**构建期**配置对象（来自 `../config`）——函数与 import 同名 = TS2440。
 * ⚠️ 协议包的 `ClientConfig`（服务端下发形状）与本仓 `../config` 的同名 interface
 * （构建期环境配置）是**两个不同的物**；本文件只 import 前者（若同文件并用，import 时须 `as` 消歧）。
 */
export function fetchClientConfig(): Promise<RestResponse<ClientConfig>> {
  return authedGet<ClientConfig>('/config');
}

/** 代理分润（r3 Critical #1）：登录前的公开启动配置（只有两键）。 */
export interface BootClientConfig {
  version: number;
  agentInviteEnabled: boolean;
}

/** 公开 GET（**不带** `Authorization`；仅用于公开白名单里的启动面）。 */
async function publicGet<T>(path: string): Promise<RestResponse<T>> {
  return request<T>({
    url: `${resolveApiBase()}${path}`,
    method: 'GET',
    headers: {},
  });
}

/**
 * `GET /api/config/boot` —— 登录页在**无令牌**时判断是否渲染邀请码输入框。
 * 只回 `{version, agentInviteEnabled}`；不得用它冒充全量配置（不写 `clientConfigVersion`）。
 */
export function fetchBootClientConfig(): Promise<RestResponse<BootClientConfig>> {
  return publicGet<BootClientConfig>('/config/boot');
}

/**
 * §7.1 / N30③（R454）：`POST /api/rooms` → `{ code, message?, data: RoomInfo }`。
 *
 * 房间创建**是 MVP 范围内**的能力（§1.2 第 2 项：玩法模式 `random` / `practice`），
 * 路由与实现都**早已存在**（网关的 `@Post('rooms')` 转发 + room-service 的 `CreateRoomDto`），
 * 这一片只补前端入口 —— 没有新增后端能力。
 *
 * ⚠️ 复用既有的 `authedRequest(method, path, body)`（**不**另造第二份请求封装）：
 * 它带鉴权、`TOKEN_EXPIRED` 轮换一次后重放一次、按统一信封解析。重放对这条 POST 是安全的 ——
 * `10004` 是网关**验签阶段**的拒绝（`jwt.middleware.ts`），请求从未被转发给 room-service，
 * 因此不存在「第一次其实已生效」的副作用。
 *
 * ⚠️ **`baseScore` 可选**（协议 §2 第 6 条）：**省略这个键** ⇒ 服务端用缺省档；传了则必须是
 * 档位表里的一档（否则 `10001`）。⚠️ 传 `null` **不是**「省略」——服务端会把它当成一个值去
 * 查表（`rooms.service.ts` 的 `dto.baseScore !== undefined` 分支）⇒ 同样被拒
 * ⇒ 调用方只在用户**真的选过**底分时才带上它（见 `game.vue` 的 `createAndJoin()`）。
 */
export function createRoom(payload: {
  mode: 'random' | 'practice';
  baseScore?: number;
  /** 多玩法（S5.4）：缺省 = 斗地主/3。 */
  gameType?: GameType;
  playerCount?: number;
}): Promise<RestResponse<RoomInfo>> {
  return authedRequest<RoomInfo>('POST', '/rooms', payload);
}

/**
 * §7.1 / §10.2（N30③/R454 的补口）：`POST /api/rooms/:code/join` —— **占座**。
 *
 * ⚠️ 它与 WS 的 `room.join` 是**两件事**（spec §2）：
 *   - 这里：把座位**占下来**（服务端 `claimSeat`，原子 + 对同一 `userId` 幂等，R126）；
 *   - WS `room.join`：把**已占的座位**挂到这条 socket 上（并要求「已在 `room.players`」
 *     或「有 `match:pending`」，否则 `12004` —— 那是**有意设计**，见
 *     `room-service/src/gateway/message.router.ts:214-223`）。
 *
 * 建房（`POST /api/rooms`）**不入座**（`rooms.service.ts:111-128` 落 `players: []`）⇒
 * 「建房 → 直接 `room.join`」必然 `12004`（F6 的根因）。手动进房的两步顺序**不可反**：
 * 先 REST 占座、再 WS 挂载。
 *
 * ⚠️ 重放安全性（与 `createRoom` 同理）：`10004` 是**网关验签阶段**的拒绝，
 * 请求从未转发给 room-service ⇒ 不存在「第一次其实已生效」。即便退一步重放，
 * `claimSeat` 对同一 `userId` 也是幂等的（返回原座位）。
 */
export function joinRoom(code: string, gameType?: GameType): Promise<RestResponse<RoomInfo>> {
  // S5.4：REST join 与 WS 一致，带上客户端玩法（缺省 ⇒ 服务端按斗地主）。
  return authedRequest<RoomInfo>(
    'POST',
    `/rooms/${encodeURIComponent(code)}/join`,
    gameType ? { gameType } : {},
  );
}

/**
 * ② 金币场（§14）：`GET /api/wallet/balance` → `{ code, data: { balance } }`。
 *
 * 入参**只有** `X-User-Id`（网关验签后注入，客户端什么都不用传 —— 与 `/records/mine` 同族）；
 * 只读 GET ⇒ `authedRequest` 的「`10004` 轮换后重放一次」安全。
 * 消费点：大厅顶栏的余额 chip / 门槛置灰 / 救助入口点亮 —— 三处**共用同一份** store 状态。
 */
export function fetchWalletBalance(): Promise<RestResponse<{ balance: number }>> {
  return authedGet<{ balance: number }>('/wallet/balance');
}

/**
 * 广告小片 T19（规格 §2.5 逐字）：`GET /api/wallet/relief[?claim=]` 的响应 data（**六字段**）。
 *
 * **形状同形自声明**（先例 `MyRecordsPage`；与服务端 `wallet.controller.ts` 的
 * `ReliefQueryData` 同名同形）：`amount`/`balance` **恒在场**；`claim` 仅「签发/复用」
 * 路径在场；`reason` 仅不可领 / 终态拒绝 / 失效在场——四条文案（`今天已经领过了` /
 * `救助暂未开放` / `余额充足，无需救助` / `领取凭证已失效，请重试`）**都由服务端给**，
 * 客户端不另写（§10 纪律）。
 */
export interface ReliefQueryData {
  eligible: boolean;
  grantedToday: boolean;
  amount: number;
  balance: number;
  claim?: string;
  reason?: string;
}

/**
 * `GET /api/wallet/relief[?claim=]`（网关转发 currency-service；身份同取 `X-User-Id`——
 * 与 `/wallet/balance` 同族）。**两条路径**（服务端次序即判据，见 `wallet.controller.ts` 头注）：
 *
 *  - **无 claim 入参**（点击预检与「确认续窗」**同一条路径**）：裁决（已发 ⇒ 开关 ⇒ 余额）
 *    + eligible 时**签发/复用**凭证——复用同 nonce 并续期（900s 窗的刷新点）⇒ `claim`
 *    随响应返回；
 *  - **携 claim 入参**（轮询专用）：**只读**——不签发、不续期、永不写 Redis。
 *    五态（账本已真 / 记录 done·granted|replayed ⇒ 成功面；done·disabled|balance_ok ⇒
 *    对应 reason；issued ⇒ pending；记录不存在 ⇒ 「领取凭证已失效，请重试」）。
 *
 * 🔴 **本端点永不发放**（发放的唯一入口 = 广告回调链）⇒ 救助的旧写面
 * （`POST /api/wallet/relief` / `claimRelief`）已整体退役——`lobby-ux.test.ts` 的源码闸盯着。
 *
 * ⚠️ `claim` 是不透明串（服务端签发的凭证 nonce）：本函数**只回传、不解析**——解析它
 * 就是把服务端的凭证编码变成客户端里的第二份实现。进 URL 前 `encodeURIComponent`：
 * 值里可能带 URL 保留字符，编码不是「加工内容」而是让请求本身合法（先例 `fetchMyRecords`）。
 * ⚠️ 两条路径都不产生服务端写面 ⇒ `authedRequest` 的「`10004` 轮换后重放一次」安全。
 */
export function getRelief(claim?: string): Promise<RestResponse<ReliefQueryData>> {
  const path =
    claim === undefined ? '/wallet/relief' : `/wallet/relief?claim=${encodeURIComponent(claim)}`;
  return authedGet<ReliefQueryData>(path);
}

/**
 * 记录片 T8（规格 §2.3）：`GET /api/records/mine` ——「我的历史战绩」的 DTO。
 *
 * **形状同形自声明**（先例 `AuthTokens` / `LoginResult`）：逐键对应服务端
 * （user-service `records.service.ts`）的 **11 键白名单** —— 客户端不发明字段、不改名。
 * `bottomCards` / `players[].hand` 都是协议 `Card`（`{r, s}`）；牌面渲染一律交给
 * `components/Card.vue`（F10：前端不得自制点数映射）。
 *
 * ⚠️ **永不出站面**（服务端 C7 锁死的那批）：`userId` / `playerId` / `robotId` / `isRobot` /
 * `deviceId` / `money_delta` / `startedAt` —— 这里的类型也**不声明**它们：多一个键
 * 就是给「前端消费内部字段」开了口子。
 */
export interface MyRecordPlayer {
  seat: number;
  /**
   * 服务端的座位昵称快照；**可为 `null`**（机器人恒空 / 人类今日也恒空 —— 登录只有手机号）。
   * `null` 的回落（「玩家{seat}」）是**展示**的事，放在页面（`table.vue` 的 `nameOf()` 同款），
   * 传输层不替它归一。
   */
  nickname: string | null;
  role: 'landlord' | 'farmer';
  scoreChange: number;
  won: boolean;
  /** 恰 17 张（发牌那一刻的冻结快照，不是残牌）。 */
  hand: ProtocolCard[];
}

/** 一局对局记录（**12 键**，键集即服务端 C7 白名单）。 */
export interface MyRecord {
  roomCode: string;
  /** ② 金币场 §2.1：三值化（`gold` 行由战绩页渲染金币列与「金币场」label）。 */
  mode: 'random' | 'practice' | 'gold';
  /** epoch ms（服务端已转毫秒整数）。 */
  endedAt: number;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  /** 我那一行的座位（服务端 JOIN 命中行）——「我的身份与胜负」全靠它定位。 */
  mySeat: number;
  /**
   * ② 金币场：**我那一行**的金币变动（服务端 `money_delta`）。
   * `null` = 非金币场 / 尚未回写（NULL 是值，不是 0）⇒ 战绩页显「—」。
   */
  moneyDelta: number | null;
  /** 恰 3 张。 */
  bottomCards: ProtocolCard[];
  /** 恰 3 条、按座位升序。 */
  players: MyRecordPlayer[];
}

export interface MyRecordsPage {
  items: MyRecord[];
  /** **不透明字符串**：终页为 `null`；非 `null` 时**原样**回传给 `fetchMyRecords(cursor)`。 */
  nextCursor: string | null;
}

/** 跑得快战绩分页（同端点、`gameType=paodekuai`；形状见 `PdkRecord`）。 */
export interface PdkRecordsPage {
  items: PdkRecord[];
  nextCursor: string | null;
}

/** 战绩筛选选项（全部可选；缺省 = 不过滤任何维度）。 */
export interface FetchRecordsOptions {
  /** keyset 游标：客户端原样回传服务端签发的值，不解析不构造。 */
  cursor?: string;
  /** 模式精确匹配（'random' | 'practice' | 'gold'）；非法值服务端抛 400。 */
  mode?: 'random' | 'practice' | 'gold';
  /** 多玩法（S5.4/S6.3）：缺省 = doudizhu（旧客户端零破坏）。 */
  gameType?: GameType;
  /** 日期范围：epoch ms 整数，[from, to)；两者缺省则不过滤。 */
  from?: number;
  to?: number;
}

/**
 * `GET /api/records/mine`（网关转发到 user-service；**默认验签** ⇒ 走 `authedGet`）。
 *
 * ⚠️ `cursor` 是服务端签发的**不透明串**：本函数**只回传、不解析**（解析它 = 把服务端的
 * 游标编码变成客户端里的第二份实现）。回传前进 URL 要 `encodeURIComponent`：值里可能带
 * URL 保留字符（`+` 在查询串往返里会被解成空格），编码不是「加工内容」而是让请求本身合法。
 * ⚠️ 不传 `limit` ⇒ 服务端缺省 20（上限 100 由服务端 clamp —— 前端不猜分页参数）。
 * ⚠️ 只读 GET ⇒ `authedRequest` 的「`10004` 轮换后重放一次」安全。
 *
 * ## 筛选参数（2026-10 新增）
 *  - `mode`：精确匹配模式；`from`/`to`：日期范围（epoch ms，含 from 不含 to）。
 *  - 筛选参数和 cursor 独立：改筛选必须同时传 `cursor=undefined`（回第一页）；本函数不强制，
 *    因为服务端 keyset 分页在任何 WHERE 子集上都成立——强制重置是**页面**的职责，不压到底层。
 */
/**
 * 跑得快战绩（S6.3）：同一端点 + `gameType=paodekuai`，按 `PdkRecord` 解码。
 * 旧客户端不传 gameType ⇒ 服务端只返回斗地主表（零破坏）。
 */
export function fetchPdkRecords(
  options: Omit<FetchRecordsOptions, 'gameType'> = {},
): Promise<RestResponse<PdkRecordsPage>> {
  return fetchMyRecords({ ...options, gameType: 'paodekuai' }) as unknown as Promise<
    RestResponse<PdkRecordsPage>
  >;
}

export function fetchMyRecords(options?: FetchRecordsOptions): Promise<RestResponse<MyRecordsPage>> {
  const params: string[] = [];
  if (options?.cursor !== undefined) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
  if (options?.mode !== undefined) params.push(`mode=${encodeURIComponent(options.mode)}`);
  if (options?.from !== undefined) params.push(`from=${options.from}`);
  if (options?.to !== undefined) params.push(`to=${options.to}`);
  if (options?.gameType !== undefined) params.push(`gameType=${encodeURIComponent(options.gameType)}`);
  const path = params.length === 0 ? '/records/mine' : `/records/mine?${params.join('&')}`;
  return authedGet<MyRecordsPage>(path);
}

/**
 * 记牌器收费片：本人权益（`GET /api/card-counter/status`；默认验签）。
 * - `credits` = 单局卡张数；`passExpiresAt` = 包时到期（epoch ms；null = 无包时）。
 * - **只作展示**：购买成败的唯一权威是「同 requestId 的购买响应」。
 */
export interface CardCounterStatusData {
  credits: number;
  passExpiresAt: number | null;
}

export interface CardCounterPurchaseRequest {
  kind: 'game' | 'hour';
  hours?: number;
  /** 单局卡数量（kind==='game' 时有效，1..10；缺省 1）。包时卡用 hours 字段。 */
  credits?: number;
  requestId: string;
  /** 玩家在面板上确认的**总价**（服务端以它为扣款额并校验当前价）。 */
  expectedPrice: number;
}

export interface CardCounterPurchaseData {
  credits: number;
  passExpiresAt: number | null;
  priceCharged: number;
  balanceAfter: number;
}

export function fetchCardCounterStatus(): Promise<RestResponse<CardCounterStatusData>> {
  return authedGet<CardCounterStatusData>('/card-counter/status');
}

/** `POST /api/card-counter/purchase`（幂等锚 = requestId；10004 重放复用同一 body）。 */
export function purchaseCardCounter(
  body: CardCounterPurchaseRequest,
): Promise<RestResponse<CardCounterPurchaseData>> {
  return authedRequest<CardCounterPurchaseData>('POST', '/card-counter/purchase', body);
}
