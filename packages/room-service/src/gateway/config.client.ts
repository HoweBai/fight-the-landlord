// packages/room-service/src/gateway/config.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type ConfigSnapshotResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';
import { TRANSPORT_FAILURE_MESSAGE } from './transport-failure';

/**
 * room-service → config-service 的调用封装（片⑦ 规格 §2.3；取代旧 room → user 的
 * `config.baseScoreLevels` 边）。
 *
 * ⚠️ 旧形态的来历（片规格 §2.1）：档位表原本在 user-service 的库里，room-service
 * **保持纯 Redis**（不加任何 DB 驱动 / TypeORM / `DB_HOST`）—— 它要读表就只能走 RPC。
 * 片⑦ 起配置（含档位表）由 config-service 统一提供：`config.snapshot` 一次返回
 * **全量一百零一键**（`ConfigSnapshotResponse{config, version}`），本 client 是它的传输层。
 *
 * 形态逐字照 `game.client.ts`（`ClientProxy` + `lastValueFrom` + `timeout` +
 * `RpcResult` 解包 + 传输故障 ⇒ `10007`）。
 *
 * ⚠️ **失败一律抛**：调用方（`ConfigCacheService` / `RoomsService.create()`）拿不到快照就
 * 必须失败/走默认值分层（design D2）—— 返回空表会把「读不到」伪装成「没有档位」
 * ⇒ 非法底分直接绕过校验（片规格 §2.4 的红线）。
 */
export class ConfigServiceError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigServiceError';
  }
}

/** 拉快照的超时（规格 §2.3 的低频读；比 game 的 2s 宽一点，因为它还可能等 DB）。 */
const CONFIG_CLIENT_TIMEOUT_MS = 3000;

/**
 * room-service → config-service 的 RPC 客户端（`RPC_PATTERNS.configSnapshot`）。
 *
 * ⚠️ `ClientProxy` 由 `RpcClientsModule` 经 `ClientsModule.register()` 提供
 * （token `CONFIG_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会在启动时崩）。
 */
@Injectable()
export class ConfigClient {
  private readonly logger = new Logger(ConfigClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 拉**全量配置快照**（`config.snapshot`）。
   *
   * ⚠️ **失败时抛**（不返回空快照/默认值）——  失败分层由消费方决定（design D2：
   * 热项取默认值、底分 fail-closed），传输层只负责如实报告。
   *
   * ⚠️ **不重试**：§4.3 的重试表只覆盖幂等的 `game.start` / `game.snapshot` / `robot.acquire`。
   * 启动期的「1s 退避直到首次成功」在消费方（`ConfigCacheService.pullWithRetry`）。
   */
  async snapshot(): Promise<ConfigSnapshotResponse> {
    try {
      const res = await lastValueFrom(
        this.proxy
          .send<RpcResult<ConfigSnapshotResponse>>(RPC_PATTERNS.configSnapshot, {
            ...metaFromTrace(),
          })
          .pipe(timeout(CONFIG_CLIENT_TIMEOUT_MS)),
      );
      if (!res?.ok) {
        // R220：下游的 5 位数字码**原样**成为 `ConfigServiceError.code`（§11.2）
        throw new ConfigServiceError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? RPC_PATTERNS.configSnapshot,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof ConfigServiceError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，与 game 那条边**同码**。
      //
      // 🔴 **原因只进日志**（Task 3g 修复 I2）：传输故障下 `err.message` 是
      // `config-service unavailable: connect ECONNREFUSED 172.28.0.9:3106` 这类**内部详情**，
      // 而本错误的消息会**原样**到客户端（WS 面经 `message.router` 的 ack、HTTP 面经
      // `toHttpException` 的信封）⇒ 消息给固定的一句面向调用方的话，详情落日志。
      // ⚠️ **业务错误（上面那一支：信封 `ok:false`）不在此列** —— `res.message` 逐字保留。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`config-service RPC ${RPC_PATTERNS.configSnapshot} failed: ${reason}`);
      throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }
}
