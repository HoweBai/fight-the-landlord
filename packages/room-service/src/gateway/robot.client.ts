// packages/room-service/src/gateway/robot.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  RPC_PATTERNS,
  type GameType,
  type RobotAcquireResponse,
  type RobotAvailabilityResponse,
  type RobotReleaseResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';
import { TRANSPORT_FAILURE_MESSAGE } from './transport-failure';

/**
 * §4.3：`robot.acquire`（room → robot）的跨服务超时 —— 与 `release` 同为 `robot.*` 通道。
 *
 * ⚠️ A7⑤ 的「失败重试恰好 1 次」在**调用方**（`match.service.ts` 的 `withRetry`），
 * 因为 `acquireBot` 的幂等性由 R201 的池保证；这里只负责超时与信封解包。
 */
export const ROBOT_ACQUIRE_TIMEOUT_MS = 3000;

/**
 * §4.3：`robot.release`（room → robot）的跨服务超时。
 * 键表/契约未单列它，与 `robot.acquire` 同为 `robot.*` 通道 ⇒ 沿用 3s。
 */
export const ROBOT_RELEASE_TIMEOUT_MS = 3000;

/** 片② D11：availability 的 RPC 超时（**2s**，必须 > 探测的 1s）。 */
export const ROBOT_AVAILABILITY_TIMEOUT_MS = 2000;

/**
 * room-service → robot-service 的客户端（§9.6 的 `robot.acquire` / `robot.release`）。
 *
 * ⚠️ **N20/P4 Task 3**：传输从「内部 HTTP 过渡形态」换成 §4.1/§4.2 逐字要求的
 * **`Transport.TCP` + `ClientProxy.send()`**。因此本类**不再**需要 `HttpService` /
 * `X-Internal-Token` / `ROBOT_SERVICE_URL`（§2.3 的那一行随之作废）——
 * 内部 token 的边界由「RPC 端口只在 compose 内网可达」承担（R223）。
 */
@Injectable()
export class RobotClient {
  private readonly logger = new Logger(RobotClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * §4.2 / §9.6 第 1 条：`robot.acquire` —— 补位申请。**幂等**（R201：同
   * `{roomCode, seat}` 返回**同一个** `BotInstance`），这正是 A7⑤ 的「失败重试 1 次」
   * 得以安全落地的前提。
   *
   * ⚠️ 失败（传输 / 超时 / 信封 `ok:false`）**抛错**而不是返回空数组：
   * 调用方（`match.service.acquireBotOnce`）把「拿不到机器人」当作本次补位失败，
   * 走 §8.4② 的降级（不补机器人 / 以较少人数开局）。**不能**把失败伪装成
   * 「成功但 0 个」—— 那会让重试逻辑失效。
   */
  async acquire(roomCode: string, seats: number[], gameType?: GameType): Promise<RobotAcquireResponse> {
    let res: RpcResult<RobotAcquireResponse> | undefined;
    try {
      res = await lastValueFrom(
        this.proxy
          // R1104/R1105（判据 5）：`robot.acquire` / `robot.release` 两处发送点各加一次 meta
          // （本类就是这两条边的唯一发送点）；无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变。
          // 多玩法（Task 2.6）：按玩法取池（pdk 与 ddz 池隔离）。
          .send<RpcResult<RobotAcquireResponse>>(RPC_PATTERNS.robotAcquire, {
            roomCode,
            seats,
            ...(gameType === undefined ? {} : { gameType }),
            ...metaFromTrace(),
          })
          .pipe(timeout(ROBOT_ACQUIRE_TIMEOUT_MS)),
      );
    } catch (err) {
      /**
       * 🔴 **传输层故障：原因只进日志，消息给固定文案**（Task 3g 修复 I2 —— 三个 client 同一规则）。
       *
       * 修前这里**裸放**传输错误（`err.message` 就是 `ECONNREFUSED 172.28.0.5:3005` /
       * `Timeout has occurred`）：今天它只到 `rooms.start.ts` 的 `logger.error`
       * （这条边没有客户端可见路径），但「错误对象自带内部详情」正是另外两个 client
       * 漏给玩家的那个形状 ⇒ 同一规则一起收口，将来换调用方也不会漏。
       */
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`robot-service RPC ${RPC_PATTERNS.robotAcquire} failed: ${reason}`);
      throw new Error(TRANSPORT_FAILURE_MESSAGE);
    }
    if (!res?.ok) {
      /**
       * **业务错误（信封 `{ok:false}`）**：码与消息来自下游 ⇒ 跟其它两个 client 的处置
       * 一致，**逐字保留**（那是调用方要用来判断/显示的文案，不是内部详情）——
       * `rooms.start.acquireBot` 靠它/失败本身走 §8.4② 的降级。
       */
      throw new Error(`robot.acquire failed: ${res?.code ?? 'no reply'} ${res?.message ?? ''}`.trim());
    }
    return res.data;
  }

  /** 把 `botIds` 交还机器人池。失败**不抛**（局终归池是**兜底**，不能反过来打断对局收尾）。 */
  async release(botIds: string[]): Promise<number> {
    if (botIds.length === 0) return 0;
    try {
      const res = await lastValueFrom(
        this.proxy
          .send<RpcResult<RobotReleaseResponse>>(RPC_PATTERNS.robotRelease, {
            botIds,
            ...metaFromTrace(),
          })
          .pipe(timeout(ROBOT_RELEASE_TIMEOUT_MS)),
      );
      // R220：业务错误在信封里（5 位数字码）；这里只需知道「成功了多少个」
      if (!res?.ok) return 0;
      return res.data?.released ?? 0;
    } catch (err) {
      // §9.6 的**兜底回收**就是为这条路径准备的：release 丢了不会泄漏机器人。
      this.logger.error(`robot.release failed for ${botIds.length} bot(s): ${String(err)}`);
      return 0;
    }
  }

  /**
   * 片② D5：可用性门禁。**永不 reject**、永不 undefined —— 问不到一律 `true`（fail-open）。
   *
   * 「问不到」的三种形态都归一到同一个处置（调用方只认 `false` 这一个值，见协议里
   * `RobotAvailabilityResponse` 的注释）：
   *  - RPC 抛错 / 超时（2s —— 必须大于 robot 侧探测的 1s 上界，D11）；
   *  - 信封 `{ok:false}`；
   *  - 信封 `{ok:true}` 但 `data.canProvide` 缺失（新旧版本混跑的形态）。
   *
   * ⚠️ **为什么 fail-open 而不是 fail-closed**：门禁的语义是「DouZero 不可用 ⇒ 别补机器人」，
   * 而「问不到」≠「不可用」—— 旧 robot-service（不认识 `robot.availability`）正是
   * 「问不到」的绝大多数来源，把它当不可用会让滚动升级期间**全服停补**。
   * fail-open 退化成旧行为（补位照常，失败由 acquire 自己的降级兜底），是安全的默认。
   */
  async availability(gameType?: GameType): Promise<boolean> {
    try {
      const res = await lastValueFrom(
        this.proxy
          .send<RpcResult<RobotAvailabilityResponse>>(RPC_PATTERNS.robotAvailability, {
            ...metaFromTrace(),
            // 多玩法（Task 2.6 / spec §4.6.1）：pdk 不检查 DouZero（规则 bot）。
            ...(gameType === undefined ? {} : { gameType }),
          })
          .pipe(timeout(ROBOT_AVAILABILITY_TIMEOUT_MS)),
      );
      const canProvide = res?.ok ? res.data?.canProvide : undefined;
      if (canProvide === undefined) {
        this.logger.warn('robot.availability gave no usable answer; treating DouZero as available');
        return true;
      }
      return canProvide;
    } catch (error) {
      this.logger.warn(`robot.availability failed (${String(error)}); treating DouZero as available`);
      return true;
    }
  }
}
