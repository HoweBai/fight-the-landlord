import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { RPC_PATTERNS, type UserNicknamesGetResponse } from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';

/** 昵称片：与 `record.write` 同一条边、同一预算（3s / 不重试）。 */
export const NICKNAME_TIMEOUT_MS = 3000;

/**
 * room-service → user-service 的昵称读客户端（`user.nicknames.get`）。
 *
 * ⚠️ **失败不抛**：昵称是纯展示字段 —— RPC 故障只让牌桌回落「玩家N」，
 * 绝不能拖垮入房/开局。原因只进 warn 日志。
 */
@Injectable()
export class NicknameClient {
  private readonly logger = new Logger(NicknameClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  async getNicknames(userIds: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (userIds.length === 0) return result;

    try {
      const res = await lastValueFrom(
        this.proxy
          // meta-on-every-rpc-send 闸：发送点必须带 metaFromTrace()
          .send<UserNicknamesGetResponse>(RPC_PATTERNS.userNicknamesGet, {
            userIds,
            ...metaFromTrace(),
          })
          .pipe(timeout(NICKNAME_TIMEOUT_MS)),
      );
      if (!res?.ok) {
        this.logger.warn(
          `user-service RPC ${RPC_PATTERNS.userNicknamesGet} failed: code=${String(res?.code)} ${res?.message ?? ''}`,
        );
        return result;
      }
      for (const entry of res.data.nicknames) result.set(entry.userId, entry.nickname);
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`user-service RPC ${RPC_PATTERNS.userNicknamesGet} failed: ${reason}`);
      return result;
    }
  }
}
