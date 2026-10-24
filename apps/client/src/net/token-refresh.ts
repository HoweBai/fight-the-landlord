/**
 * 静默令牌续期（WS 握手前置 + REST 401 恢复共用）。
 *
 * 背景：App 息屏隔夜后 access token（TTL 2h）过期。socket.io 握手被网关拒 10004 后，
 * 现有客户端把连接判死（`server_rejected`），即使 refresh token（TTL 7d）仍有效、
 * 本应无感续期。本模块提供「确保 access token 新鲜」的唯一真源：
 *
 * - `ensureFreshAccessToken()`：预检型（WS auth 回调 / 冷启动 / 回前台）——本地解 JWT
 *   exp 未过期（skew=60s）就零请求；过期则单飞发起 refresh。
 * - `rotateRefreshToken()`：强制型（REST authedRequest 拿到 10004 时 / socket.ts 静默
 *   续期路径）——跳过 exp 预检，直接单飞 refresh。
 *
 * 五态（`TokenRenewResult`）：
 * - `fresh`：本地解 JWT exp 未过期，零请求
 * - `rotated`：refresh 成功且已写回 storage + clientConfig
 * - `invalid`：refresh 确定性拒绝（10002 / 10004 / 10005）→ 会话真死
 * - `unavailable`：网络错误 / 传输失败 / 非信封 / 10007 → 不判死，留 reconnecting 退避
 * - `no_session`：本地无 refresh token（dev mock 路径）
 *
 * 单飞：模块级 `refreshInFlight` 与 REST 的 `authedRequest` 共享同一 Promise，
 * 并发 401 只轮换一次。
 *
 * 代数交错保护：发起前 `sessionGeneration()` 记一代，写入前再比对，不等则丢弃写入
 * （防幽灵会话，与 rest.ts 原 rotateOnce 语义一致）。
 *
 * 依赖纪律：本模块 → http.ts / storage.ts / config.ts / protocol（rest.ts 仅 type-only）。
 * net 层不 import store（store 回填走 `onTokensRenewed` 回调注入，见 session.ts）。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { clientConfig } from '../config';
import { TransportFailureError, requestJson, resolveApiBase } from './http';
import { getDeviceId, loadSession, saveSession, sessionGeneration } from './storage';
import type { AuthTokens, RestResponse } from './rest';

// ---------------------------------------------------------------------------
// JWT exp 本地解码
// ---------------------------------------------------------------------------

/**
 * base64url → 普通字符串（自带查表，不依赖 atob，兼容小程序无 atob 的环境）。
 *
 * JWT 的 payload 字段（exp、jti、sub 等）全是 ASCII 数字 / 字母 / 点号 / 下划线，
 * 解码后是普通 JS 字符串。只取 exp 字段，不需要更复杂的 base64 解码。
 */
function b64urlDecode(input: string): string {
  // 去掉 padding（JWT base64url 没有 `=` 填充）
  const padded = input + '==='.slice((input.length + 3) % 4 || 4);
  // 把 `+` `-` 替换回 `+` `/`（base64url → base64）
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  // 查表解码（不依赖 atob，跨平台安全）
  const ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const PAD = '=';
  let out = '';
  let i = 0;
  const bytes: number[] = [];
  while (i < b64.length) {
    const c = b64[i];
    if (c === PAD) break;
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) return '';
    bytes.push(idx);
    i++;
  }
  // 每 4 个 6-bit 拼 3 字节
  for (let j = 0; j + 3 < bytes.length; j += 4) {
    const b0 = bytes[j];
    const b1 = bytes[j + 1];
    const b2 = bytes[j + 2];
    const b3 = bytes[j + 3];
    out += String.fromCharCode(
      ((b0 << 2) | (b1 >> 4)) & 0xff,
      ((b1 << 4) | (b2 >> 2)) & 0xff,
      ((b2 << 6) | b3) & 0xff,
    );
  }
  // 处理尾部（bytes.length % 4 === 2 或 3 的情况）
  const rem = bytes.length % 4;
  if (rem === 2) {
    const b0 = bytes[bytes.length - 2];
    const b1 = bytes[bytes.length - 1];
    out += String.fromCharCode(((b0 << 2) | (b1 >> 4)) & 0xff);
  } else if (rem === 3) {
    const b0 = bytes[bytes.length - 3];
    const b1 = bytes[bytes.length - 2];
    const b2 = bytes[bytes.length - 1];
    out += String.fromCharCode(
      ((b0 << 2) | (b1 >> 4)) & 0xff,
      ((b1 << 4) | (b2 >> 2)) & 0xff,
    );
  }
  return out;
}

/**
 * 本地解 JWT 的 `exp`（epoch 秒）。
 *
 * 形如 `header.payload.signature`；只解 payload（`.` 分隔的第二段）取 `exp`。
 * 非法 JWT（段数不对 / payload 非 JSON / 无 exp）→ `null`（调用方按「新鲜」处理，
 * 不拦握手——dev mock 的非 JWT 令牌走这条路）。
 */
export function decodeJwtExp(token: string): number | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let payload: string;
  try {
    payload = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  if (payload === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('exp' in parsed) ||
    typeof (parsed as { exp: unknown }).exp !== 'number'
  ) {
    return null;
  }
  return (parsed as { exp: number }).exp;
}

/**
 * 本地判断 access token 是否「新鲜」（exp 未过期且留有 `skewMs` 余量）。
 *
 * `nowMs` 缺省用 `Date.now()`；测试可注入。
 * 非法 JWT / 无 exp → `true`（按新鲜处理，不拦握手）。
 */
export function isAccessTokenFresh(
  token: string,
  skewMs = 60_000,
  nowMs?: number,
): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return true;
  const now = (nowMs ?? Date.now()) / 1000;
  return exp - now * 1 > skewMs / 1000;
}

// ---------------------------------------------------------------------------
// 信封解析（与 rest.ts 的 parse 同规则，独立一份避免循环依赖）
// ---------------------------------------------------------------------------

/**
 * 解析 `{ code, message?, data? }` 信封（§11.1）。
 *
 * 与 rest.ts 的 `parse` 逻辑一致：响应体不是 JSON、或不是带数字 `code` 的信封
 * （空体、HTML 错误页、裸数组…）→ 映射为 `10007`（下游不可用）。
 *
 * ⚠️ 这里**不** import rest.ts 的 `parse`（rest.ts 会 import 本模块，循环）。
 * 规则「拿到的不是平台信封」→ `10007` 与 rest.ts 逐字同。
 */
function parseEnvelope(
  res: { statusCode: number },
  text: string,
): RestResponse<AuthTokens> {
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as RestResponse<unknown>).code === 'number'
      ) {
        return parsed as RestResponse<AuthTokens>;
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

// ---------------------------------------------------------------------------
// refresh 端点
// ---------------------------------------------------------------------------

/**
 * `POST /auth/refresh`（`{ refreshToken }` → `{ accessToken, refreshToken? }`）。
 *
 * 用 http.ts 的 `requestJson` / `resolveApiBase`，信封解析与 rest.ts 同规则。
 * 传输失败（`TransportFailureError`）或 `TypeError`（fetch 拒绝）→ 返回 `10007` 信封
 * （**不抛**，调用方按 unavailable 处理，不判死会话）。
 *
 * 公开路径（不带 `Authorization`），与 rest.ts 的 `post` 一致。
 */
export async function refreshTokens(
  refreshToken: string,
): Promise<RestResponse<AuthTokens>> {
  try {
    const res = await requestJson({
      url: `${resolveApiBase()}/auth/refresh`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken, deviceId: getDeviceId() }),
    });
    return parseEnvelope(res, res.text);
  } catch (error) {
    if (error instanceof TransportFailureError) {
      return parseEnvelope({ statusCode: 0 }, '');
    }
    // H5 fetch 的 TypeError（Failed to fetch）等 → 同样当传输不可用，不判死
    return {
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '续期请求未送达，请检查网络后重试',
    };
  }
}

// ---------------------------------------------------------------------------
// 五态续期（单飞）
// ---------------------------------------------------------------------------

/**
 * 续期五态。
 *
 * - `fresh`：本地 exp 未过期（skew=60s），零请求
 * - `rotated`：refresh 成功且写回 storage + clientConfig
 * - `invalid`：refresh 确定性拒绝（10002 / 10004 / 10005）→ 会话真死
 * - `unavailable`：网络错误 / 传输失败 / 非信封 / 10007 → 不判死
 * - `no_session`：本地无 refresh token（dev mock 路径）
 */
export type TokenRenewResult =
  | 'fresh'
  | 'rotated'
  | 'invalid'
  | 'unavailable'
  | 'no_session';

/** 确定性拒绝的三码（refresh 端点服务端只可能回这三个之一）。 */
const INVALID_CODES: ReadonlySet<number> = new Set([
  ErrCode.UNAUTHENTICATED, // 10002
  ErrCode.TOKEN_EXPIRED, // 10004
  ErrCode.TOKEN_INVALID, // 10005
]);

let refreshInFlight: Promise<TokenRenewResult> | null = null;

/**
 * 执行一次 refresh（单飞：并发调用共享同一 Promise）。
 *
 * 内部逻辑（从 rest.ts 的 `rotateOnce` 平移，升级为五态）：
 * 1. 无本地会话 / 无 refreshToken → `no_session`
 * 2. 记 `sessionGeneration()` 一代（交错时序保护）
 * 3. `refreshTokens(stored.refreshToken)`
 * 4. `code === 0` 且有 accessToken：
 *    - 代数变了 → 丢弃写入、返回 `invalid`（幽灵会话保护）
 *    - 代数未变 → 写 `clientConfig.token` + `saveSession`（五字段）→ `rotated`
 * 5. `code ∈ {10002,10004,10005}` → `invalid`
 * 6. 其余非 0（含 10007 / 11003 / 非信封）→ `unavailable`
 */
async function doRefresh(): Promise<TokenRenewResult> {
  const stored = loadSession();
  if (!stored?.refreshToken) return 'no_session';
  const generation = sessionGeneration();
  const res = await refreshTokens(stored.refreshToken);
  if (res.code === 0 && res.data?.accessToken) {
    // 交错时序保护：等待期间用户可能已登出（clearSession 代数 +1）
    if (generation !== sessionGeneration()) return 'invalid';
    clientConfig.token = res.data.accessToken;
    saveSession({
      accessToken: res.data.accessToken,
      refreshToken: res.data.refreshToken ?? stored.refreshToken,
      userId: stored.userId,
      // 轮换只换令牌——展示资料原样带过去（否则「令牌静默续期」会顺手把名字擦掉）
      phone: stored.phone,
      nickname: stored.nickname,
    });
    return 'rotated';
  }
  if (INVALID_CODES.has(res.code)) return 'invalid';
  return 'unavailable';
}

/** 单飞入口：并发调用共享同一 Promise。 */
function joinOrStart(): Promise<TokenRenewResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * 预检型：WS auth 回调 / 冷启动 / 回前台。
 *
 * - `clientConfig.token` 新鲜（exp 未过期，skew=60s）→ `fresh`（零请求）
 * - 无本地会话（无 accessToken）→ `no_session`
 * - 过期 → 单飞 refresh
 */
export function ensureFreshAccessToken(
  nowMs?: number,
): Promise<TokenRenewResult> {
  const token = clientConfig.token;
  if (token && isAccessTokenFresh(token, 60_000, nowMs)) {
    return Promise.resolve('fresh');
  }
  const stored = loadSession();
  if (!stored?.accessToken) return Promise.resolve('no_session');
  return joinOrStart();
}

/**
 * 强制型：REST authedRequest 拿到 10004 时 / socket.ts 静默续期路径。
 *
 * 跳过 exp 预检，直接单飞 refresh。无本地 refresh token → `no_session`。
 */
export function rotateRefreshToken(): Promise<TokenRenewResult> {
  const stored = loadSession();
  if (!stored?.refreshToken) return Promise.resolve('no_session');
  return joinOrStart();
}
