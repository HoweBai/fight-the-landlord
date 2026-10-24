// packages/room-service/src/gateway/game.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ErrCode, RPC_PATTERNS, type Card, type GameTrusteeRequest, type PlayerView, type RpcResult } from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';
import { TRANSPORT_FAILURE_MESSAGE } from './transport-failure';

/**
 * room-service → game-service 的调用封装。
 *
 * ⚠️ **N20/P4 Task 3**：传输从「内部 HTTP 过渡形态」换成 §4.1/§4.2 逐字要求的
 * **`Transport.TCP` + `ClientProxy.send()`**。本文件**不再**出现 `/api/games` 之类的
 * 内部 HTTP 路径（`test/no-internal-http.gate.test.ts` 是钉住这件事的机械闸）。
 *
 * **超时 / 重试 / 错误码语义逐字保留**（§4.3 + R209 + R210）：
 *  - 超时：`game.start` 3s，`snapshot` / `view` / `action` 2s（`GAME_CLIENT_TIMEOUT_MS` 不变）；
 *  - `game.start` / `game.snapshot` **失败重试恰好 1 次**（幂等 ⇒ 重试安全）；
 *  - `view` / `action` **不重试**（`view` 不在 §4.3 的表里；`action` 是 CAS，重试会重复出牌）；
 *  - 下游错误码（§11.2）经 R220 的**信封**原样到达 ⇒ 抛 `GameServiceError(code)`；
 *  - **传输层故障**（连不上 / 超时）⇒ `UPSTREAM_UNAVAILABLE (10007)`，与旧 HTTP 分支**同码**。
 *
 * ⚠️ **R220**：handler 返回 `RpcResult<T>` 信封（`{ok:true,data}` / `{ok:false,code,message}`），
 * 因为 Nest 的 `RpcException` 到了客户端只剩**字符串** `message`，5 位数字码会丢，
 * 而 `message.router.isMissingGameError()` 必须区分 `12004` 与 `10007`。
 */
export class GameServiceError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameServiceError';
  }
}

/**
 * §4.3 的超时表。
 *
 * ⚠️ **挂机治理 T6（C19，r1 次要 15）**：`trustee` 2s —— 写边，且**不重试**
 *（§4.3 的重试表只覆盖幂等的 `game.start` / `game.snapshot`）。
 */
export const GAME_CLIENT_TIMEOUT_MS = { start: 3000, view: 2000, snapshot: 2000, trustee: 2000 } as const;

const TIMEOUT_MS = GAME_CLIENT_TIMEOUT_MS;

/** §4.3：**恰好重试 1 次**（`maxAttempts = 2`），前提是接收端幂等（§4.3 的「幂等前提」）。 */
export const RPC_MAX_ATTEMPTS = 2;

export interface GameHttpResponse {
  /** 完整 `GameSession`（snapshot）或裁剪视图（view）。 */
  data: unknown;
}

/**
 * room-service → game-service 的 RPC 客户端（§4.2 的 `game.*` 四条边）。
 *
 * ⚠️ `ClientProxy` 由 `WsModule` 经 `ClientsModule.register()` 提供
 * （token `GAME_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会在启动时崩）。
 */
@Injectable()
export class GameClient {
  private readonly logger = new Logger(GameClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /** `game.start`：开局（**幂等**：同 `roomCode` 重复调用复用会话）。失败 → `10007`。 */
  async start(dto: unknown): Promise<GameHttpResponse> {
    return this.withRetry(() => this.call(RPC_PATTERNS.gameStart, dto, TIMEOUT_MS.start));
  }

  /**
   * `game.snapshot`（内部）：完整会话，仅供服务间使用。**幂等** ⇒ 失败重试 1 次。
   */
  async snapshot(roomCode: string): Promise<GameHttpResponse> {
    return this.withRetry(() =>
      this.call(RPC_PATTERNS.gameSnapshot, { roomCode }, TIMEOUT_MS.snapshot),
    );
  }

  /**
   * `game.view`（按座位裁剪，§4.2）。
   *
   * **R224**：只传 `userId` —— §4.2 逐字「**seat 由服务端从 userId 解析，不由调用方提供**」
   * （否则调用方可指定他人座位，等于绕过裁剪）。
   *
   * 返回值是唯一的出站对局类型 `PlayerView`（Global Constraint 9）；它已在
   * game-service 侧由 `buildPlayerView()` 过了一遍 `validateOutbound()`。
   *
   * ⚠️ **不重试**：§4.3 的重试表只覆盖 `game.start` / `game.snapshot`。
   * ⚠️ `12004`（不在本局）⇒ 返回 `null`，**不抛**（与旧 HTTP 分支逐字同义）。
   */
  async view(roomCode: string, userId: string): Promise<PlayerView | null> {
    try {
      const resp = await this.call(RPC_PATTERNS.gameView, { roomCode, userId }, TIMEOUT_MS.view);
      return (resp.data ?? null) as PlayerView | null;
    } catch (err) {
      // 「你不在这局里」不是传输故障 —— 返回 null 让调用方决定（§6.6.1 的四步判定）
      if (err instanceof GameServiceError && err.code === ErrCode.NOT_IN_ROOM) return null;
      throw err;
    }
  }

  /**
   * 动作转发（bid / play / pass）。
   *
   * **R219**：§4.2 未给动作定义 pattern，本片按 §4.1 的「room → game」边补一个**单一**
   * pattern `game.action`（拆成三个会把同一个 CAS 语义复制三份）。
   *
   * ⚠️ **不重试**：动作**不幂等**（`baseVersion` CAS + 状态转移），重试会重复出牌。
   *
   * ⚠️ `baseVersion` 是 R219 契约里的**顶层**字段（与 `roomCode`/`userId`/`action`/`payload`
   * 平级）—— `message.router` 构造载荷时把它平铺在 `payload` 里（旧 HTTP 形态如此），
   * 这里**显式提升到顶层**并把它从 `payload` 里摘掉，两种形态的调用方都能得到正确契约。
   */
  async action(
    roomCode: string,
    action: 'bid' | 'play' | 'pass',
    userId: string,
    /**
     * R697：`play` 时 `cards` 是 `Card[]`（带花色）。
     *
     * ⚠️ 这里此前是 `Record<string, unknown>` —— 与 `as` 断言**同族**：编译器不校验形状
     * （spec §3.5-A 记的那一类）。收紧之后，调用方传裸数字数组会**当场编译报错**，
     * 而不是等到运行期被 `validateClientMessage` 拦成 `10001`。
     */
    payload: { grab?: boolean; cards?: Card[]; baseVersion?: number },
  ): Promise<unknown> {
    const { baseVersion, ...params } = payload;
    const resp = await this.call(
      RPC_PATTERNS.gameAction,
      { roomCode, userId, action, payload: params, baseVersion },
      TIMEOUT_MS.view,
    );
    return resp.data;
  }

  /**
   * 挂机治理（T6 / 规格 C19）：托管开关转发（room → game 的第五条边）。
   *
   * **写边 ⇒ 不重试**（§4.3 的重试表只覆盖幂等读/开局）；超时 2s。
   * 失败**照抛** `GameServiceError`（下游 5 位码原样；传输故障 ⇒ 10007）——
   * 三处转发点的 fail-open 姿态由**调用方**决定（leave 只 warn；回桌不阻断）。
   *
   * `via` 是判别位（服务端据此区分手动 / 重连 / 弃局三条路径的 timer 语义）：
   * 四处调用点的取值由 `message.router.ts` 钉死，并由 `idle-trustee.router.test.ts` 逐处断言。
   */
  async trustee(
    roomCode: string,
    userId: string,
    on: boolean,
    via: GameTrusteeRequest['via'],
  ): Promise<unknown> {
    const resp = await this.call(RPC_PATTERNS.gameTrustee, { roomCode, userId, on, via }, TIMEOUT_MS.trustee);
    return resp.data;
  }

  /** R210：同参数重试**恰好 1 次**（`maxAttempts = 2`）。 */
  private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < RPC_MAX_ATTEMPTS; i += 1) {
      try {
        return await attempt();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  /**
   * 发一次 RPC 并解信封。
   *
   * ⚠️ **R221**：`timeout()` 在 `retry()` **之内**（`withRetry` 包住整个 `call`），
   * 因此每次重试**重新计时** —— 正确的「每次尝试各自 3s / 2s」语义。
   *
   * ⚠️ **R1104/R1105（判据 5，本片）**：本方法就是 `game.*` 四条边的**唯一**发送点 ⇒
   * `meta` 只在这里加一次（`...metaFromTrace()`）。**业务方法（`start`/`view`/`action`…）
   * 的签名与调用点一行不动** —— 加 meta 是发送侧的横切职责，不是每个调用方的事。
   * 无 ALS 时 `metaFromTrace()` 展开 `{}` ⇒ 载荷**逐字不变**（这正是省略语义的用处：
   * 既有「逐字载荷」断言全部照旧）。
   */
  private async call<T>(pattern: string, payload: unknown, timeoutMs: number): Promise<GameHttpResponse> {
    try {
      const res = await lastValueFrom(
        this.proxy
          .send<RpcResult<T>>(pattern, { ...(payload as object), ...metaFromTrace() })
          .pipe(timeout(timeoutMs)),
      );
      if (!res?.ok) {
        // R220：下游的 5 位数字码**原样**成为 `GameServiceError.code`（§11.2）
        throw new GameServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? pattern,
        );
      }
      return { data: res.data };
    } catch (err) {
      if (err instanceof GameServiceError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，与旧 HTTP 分支**同码**。
      //
      // 🔴 **原因只进日志**（Task 3g 修复 I2）：传输故障下 `err.message` 是
      // `ECONNREFUSED 172.28.0.7:3002` 这类**内部拓扑**，而本错误的消息经
      // `message.router` 的 `GameServiceError` 分支**原样 ack**、被客户端当 toast 弹给玩家
      // ⇒ 消息给固定的一句面向调用方的话（`TRANSPORT_FAILURE_MESSAGE`），详情落日志。
      // ⚠️ **业务错误（上面那一支：信封 `ok:false`）不在此列** —— `res.message` 是客户端
      // 要显示的业务文案，**逐字保留**。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`game-service RPC ${pattern} failed: ${reason}`);
      throw new GameServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }
}

/**
 * 下游错误码优先；否则按 HTTP 状态码映射（§11.2）。
 *
 * ⚠️ **N20/P4 Task 3 之后它是死代码**（本文件已无 HTTP 状态码可映射），但**保留导出**：
 *  - 它是 §11.2 的**映射表本身**，删掉会让「HTTP 状态码 → 契约错误码」这条规格
 *    在代码里失去唯一落点（将来若再加一条 HTTP 边，重建它必然漂移）；
 *  - `test/game.client.test.ts` 有一条判据钉住这张表的值。
 * 归类为**允许删除**（计划 Task 3 Step 3 明写），本片选择保留。
 */
export function mapHttpStatus(status: number, downstreamCode?: number): ErrCode {
  if (typeof downstreamCode === 'number' && downstreamCode !== 0) return downstreamCode as ErrCode;
  switch (status) {
    case 400:
      return ErrCode.BAD_PARAM;
    case 401:
      return ErrCode.UNAUTHENTICATED;
    case 403:
      return ErrCode.NOT_IN_ROOM;
    case 404:
      return ErrCode.ROOM_NOT_FOUND;
    case 409:
      return ErrCode.VERSION_CONFLICT;
    case 503:
      return ErrCode.UPSTREAM_UNAVAILABLE;
    default:
      return ErrCode.UPSTREAM_UNAVAILABLE;
  }
}

