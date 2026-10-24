// packages/room-service/src/gateway/record.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type RecordMoneyDeltaData,
  type RecordMoneyDeltaRequest,
  type RecordMoneyDeltaResponse,
  type RecordWriteRequest,
  type RecordWriteResponse,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';
import { TRANSPORT_FAILURE_MESSAGE } from './transport-failure';

/**
 * room-service → user-service 的调用封装（记录片 T5 / 设计 D2 —— `record.write`，
 * user-service **重挂 TCP 3101** 后的唯一一条边）。
 *
 * ⚠️ 3101 的叙事（别读混）：片⑦ 退役的是「room → user 读**底分档位表**」那**一条边**
 * （随档位收编进 `config.snapshot`），**不是端口**；记录片起 user-service 重新监听 3101
 * 承载对局记录写入（`protocol/src/rpc.ts:14-19` 逐字）。
 *
 * 形态逐字照 `config.client.ts`：`ClientProxy` + `lastValueFrom` + `timeout` +
 * `RpcResult` 解包 + 传输故障 ⇒ `10007`（+ 固定文案，原因只进日志）。
 *
 * ⚠️ **超时 3s、不重试**（设计 D2 明文）：§4.3 的重试表不含这条边；接收侧虽然幂等
 * （`(room_code, game_version)` 唯一键），但**不重试**是规格写死的口径 —— 失败即
 * 单次尝试失败（丢该局记录、error 日志、台账登记），与 pub/sub at-most-once 同族。
 *
 * ⚠️ **失败时抛**：调用方（`WsGateway.finalizeRoomEnd`）要区分「写成功/幂等命中」与
 * 「没写成」—— 返回 `false` 会把二者混成一种（`false` 的语义已被幂等命中占用）。
 */
export class RecordClientError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecordClientError';
  }
}

/** 设计 D2：`record.write` 的跨服务超时 = 3s（与 user 侧配置链的读超时同值）。 */
export const RECORD_WRITE_TIMEOUT_MS = 3000;

/**
 * room-service → user-service 的 RPC 客户端（`RPC_PATTERNS.recordWrite`）。
 *
 * ⚠️ `ClientProxy` 由 `RpcClientsModule` 经 `ClientsModule.register()` 提供
 * （token `RECORD_RPC_PROXY`），再由 `useFactory` 包成本类（R216：`useClass` 会在启动时崩）。
 */
@Injectable()
export class RecordClient {
  private readonly logger = new Logger(RecordClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  /**
   * 投一局记录（`record.write`）。
   *
   * @returns `true` = 新写入；`false` = **幂等命中**（非错误 —— 重复投递的正常路径）
   * @throws RecordClientError 业务错误（下游 5 位码**原样**）或传输故障（`10007` + 固定文案）
   */
  async write(request: RecordWriteRequest): Promise<boolean> {
    try {
      const res = await lastValueFrom(
        this.proxy
          // R1104/R1105（判据 5）：本类是本条边的**唯一**发送点 ⇒ `meta` 只在这里加一次
          //（`...metaFromTrace()` 在 `send` 实参里 —— `meta-on-every-rpc-send` 闸扫这一处）。
          // 无 ALS ⇒ 展开 `{}` ⇒ 载荷逐字不变。
          .send<RecordWriteResponse>(RPC_PATTERNS.recordWrite, {
            ...request,
            ...metaFromTrace(),
          })
          .pipe(timeout(RECORD_WRITE_TIMEOUT_MS)),
      );
      if (!res?.ok) {
        // R220：下游的 5 位数字码**原样**成为 `RecordClientError.code`（§11.2）
        throw new RecordClientError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? RPC_PATTERNS.recordWrite,
        );
      }
      return res.data.written;
    } catch (err) {
      if (err instanceof RecordClientError) throw err;
      // 传输层故障（连不上 / 超时）⇒ 10007，与另外三条边**同码**。
      //
      // 🔴 **原因只进日志**（Task 3g 修复 I2 同族规则）：传输故障下 `err.message` 是
      // `connect ECONNREFUSED 172.28.0.9:3101` 这类**内部拓扑**；消息给固定的一句
      // 面向调用方的话。⚠️ 业务错误（上面那一支）**不在此列** —— `res.message` 逐字保留。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`user-service RPC ${RPC_PATTERNS.recordWrite} failed: ${reason}`);
      throw new RecordClientError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }

  /**
   * 回写一局的三人 `money_delta` 向量（② 金币场 T5 消费 / T7 接收侧；规格 §3）。
   *
   * 形态与 `write()` **逐字同款**（3s 超时、不重试、`RpcResult` 解包、传输故障 ⇒ 10007
   * + 固定文案）——同样的边、同样的超时预算；重试由**调用方**（结算的 outbox 收敛链）
   * 决定，本传输层不叠加。
   *
   * 语义提醒：`matched` = **命中的座位集合**（来自接收侧的存在性回执，不是 affectedRows）
   * ——「齐三座」才是收敛（缺座 ⇒ 调用方留 `recordmoney:outbox` 重试，规格 §5）。
   *
   * @throws RecordClientError 业务错误（下游 5 位码原样）或传输故障（10007 + 固定文案）
   */
  async moneyDelta(request: RecordMoneyDeltaRequest): Promise<RecordMoneyDeltaData> {
    try {
      const res = await lastValueFrom(
        this.proxy
          // meta 纪律与 `write()` 同款（`meta-on-every-rpc-send` 闸扫每一处 `.send(`）。
          .send<RecordMoneyDeltaResponse>(RPC_PATTERNS.recordMoneyDelta, {
            ...request,
            ...metaFromTrace(),
          })
          .pipe(timeout(RECORD_WRITE_TIMEOUT_MS)),
      );
      if (!res?.ok) {
        throw new RecordClientError(
          (res?.code ?? ErrCode.UPSTREAM_UNAVAILABLE) as ErrCode,
          res?.message ?? RPC_PATTERNS.recordMoneyDelta,
        );
      }
      return res.data;
    } catch (err) {
      if (err instanceof RecordClientError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`user-service RPC ${RPC_PATTERNS.recordMoneyDelta} failed: ${reason}`);
      throw new RecordClientError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
  }
}
