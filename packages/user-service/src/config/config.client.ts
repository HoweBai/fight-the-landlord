// packages/user-service/src/config/config.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type ConfigSnapshotResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';

/**
 * user-service → config-service 的调用封装（记录片 T7 / 设计 D5：本服务的**第一条配置消费链**，
 * 读 `record.retentionDays`（记录片新增的第 10 键；风控片后二十五键、支付片后三十四键、节奏/清理旋钮管理化片后四十键、广告片后四十一键、台费片后四十二键、客户端接入片后四十四键、机器人补位开关片后共五十一键；配置平行化后九十键；2026-10-25 跑得快风控后九十三键）；经 `config.snapshot` 一次拉**全量**）。
 *
 * 形态逐字照 room-service 的 `gateway/config.client.ts` 与 robot-service 的
 * `config/config.client.ts`（`ClientProxy` + `lastValueFrom` + `timeout` + `RpcResult`
 * 解包 + 传输故障 ⇒ `10007`）—— 本边的错误类、固定文案、token 与 options 都收在本文件里
 *（room 侧因还有 game/robot/record 三条边才拆成 `gateway/`）。
 * ⚠️ 货币片 T6 起本服务**不再是「只有这一条出站 RPC 边」**：第二条 = `currency.apply`
 *（注册赠送），错误类/文案同形，收在 `src/currency/currency.client.ts`。
 *
 * ⚠️ **失败一律抛**：调用方（`ConfigCacheService`）拿不到快照就必须走默认值分层
 *（design D5 / 规格 §2.4：`retentionDays()` 缺省回落 365）—— 返回空快照会把
 *「读不到」伪装成「没有配置」。
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

/**
 * 传输层故障（连不上 / 超时）时给**调用方**的固定文案。
 *
 * 🔴 消息**不得**内插 `err.message`（传输故障下它是 `ECONNREFUSED 172.28.x.x:3106`
 * 这类内部拓扑）—— 详情只进日志（`snapshot()` 抛之前的 warn 行），不透传 ≠ 不留痕。
 * 文案与 room/robot 两服务的同名常量**逐字相同**（三端失败时运维看到同一句话）。
 */
export const TRANSPORT_FAILURE_MESSAGE = '服务暂时不可用，请稍后重试';

/**
 * `ClientsModule.register()` 用的**内部 token** —— 与包装类 token（`ConfigClient`）
 * **故意不同**（同 room/robot 侧的坑：同一个 `name` 两处提供 ⇒ 解析到哪一个取决于注册顺序）。
 */
export const USER_CONFIG_RPC_PROXY = 'USER_SERVICE_CONFIG_RPC_PROXY';

/**
 * 规格 §2.3 / §2.7：`CONFIG_SERVICE_RPC_HOST` / `CONFIG_SERVICE_RPC_PORT`
 * （默认 `config-service` / `3106`）—— 新 env 的**唯一代码读取点**（r1-S-I7）。
 */
export const configClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.CONFIG_SERVICE_RPC_HOST ?? 'config-service',
    port: Number(process.env.CONFIG_SERVICE_RPC_PORT ?? 3106),
  },
});

/** 拉快照的超时（规格 §2.3 的低频读；与 room/robot 侧**同值**）。 */
const CONFIG_CLIENT_TIMEOUT_MS = 3000;

/**
 * user-service → config-service 的 RPC 客户端（`RPC_PATTERNS.configSnapshot`）。
 *
 * ⚠️ `ClientProxy` 由 `ConfigCacheModule` 经 `ClientsModule.register()` 提供
 * （token `USER_CONFIG_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会崩）。
 */
@Injectable()
export class ConfigClient {
  private readonly logger = new Logger(ConfigClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 拉**全量配置快照**（`config.snapshot`）。
   *
   * ⚠️ **失败时抛**（不返回空快照/默认值）—— 失败分层由消费方决定（`retentionDays()`
   * 缺省回落 365），传输层只负责如实报告。
   * ⚠️ **不重试**：§4.3 的重试表只覆盖幂等的 `game.start` / `game.snapshot` / `robot.acquire`；
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
      // 传输层故障（连不上 / 超时）⇒ 10007，与 room/robot 那条边**同码**；原因只进日志。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`config-service RPC ${RPC_PATTERNS.configSnapshot} failed: ${reason}`);
      throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }
}
