/**
 * P0-3：提现再认证票据闸的**三分支**（契约错误码 × HTTP 状态）。
 *
 * 断点（修复前）：`catch` 把故意抛出的 FORBIDDEN 改写成
 * 「reauth service unavailable」，且 `ErrCode.FORBIDDEN` 不在 `HTTP_STATUS` 表里
 * ⇒ `?? 500`：票据过期/已消费也变成 500，客户端无法区分「重新认证」与「稍后重试」。
 *
 * 判据：
 *  - 过期/已消费（Redis `DEL` 返回 0）⇒ 403 + `ErrCode.FORBIDDEN`，且**不**进入提现；
 *  - Redis 故障（`DEL` 抛）⇒ 503 + `ErrCode.UPSTREAM_UNAVAILABLE`；
 *  - 有效票据（`DEL` 返回 1）⇒ 正常进入提现。
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { WithdrawController } from '../src/withdraw/withdraw.controller';
import { HTTP_STATUS } from '../src/http/errors';

const make = (opts: { del: (...args: unknown[]) => Promise<number>; enabled?: boolean }) => {
  const withdrawals = {
    apply: vi.fn(async () => ({ withdrawNo: 'W-1', status: 'reviewing' as const })),
  };
  const configCache = { withdrawReAuthEnabled: () => opts.enabled ?? true };
  const redis = { del: vi.fn(opts.del) };
  const controller = new WithdrawController(
    withdrawals as never,
    configCache as never,
    redis as never,
  );
  return { controller, withdrawals, redis };
};

const catchHttp = async (p: Promise<unknown>): Promise<HttpException> => {
  try {
    await p;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected the call to reject');
};

describe('P0-3：提现再认证闸（票据无效 vs Redis 故障）', () => {
  it('票据过期/已消费（DEL=0）⇒ 403 + FORBIDDEN，且不进入提现', async () => {
    const { controller, withdrawals, redis } = make({ del: async () => 0 });

    const err = await catchHttp(controller.apply('u1', 't-used', { coins: 100 }));

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      code: ErrCode.FORBIDDEN,
      message: 'reauth ticket invalid or expired',
    });
    expect(redis.del).toHaveBeenCalledWith('reauth:u1:t-used');
    expect(withdrawals.apply).not.toHaveBeenCalled();
  });

  it('Redis 故障（DEL 抛）⇒ 503 + UPSTREAM_UNAVAILABLE（与票据无效区分）', async () => {
    const { controller, withdrawals } = make({
      del: async () => {
        throw new Error('redis down');
      },
    });

    const err = await catchHttp(controller.apply('u1', 't-1', { coins: 100 }));

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: 'reauth service unavailable',
    });
    expect(withdrawals.apply).not.toHaveBeenCalled();
  });

  it('有效票据（DEL=1）⇒ 进入提现', async () => {
    const { controller, withdrawals } = make({ del: async () => 1 });

    const res = await controller.apply('u1', 't-ok', { coins: 100 });

    expect(res.code).toBe(ErrCode.OK);
    expect(withdrawals.apply).toHaveBeenCalledWith('u1', 100);
  });

  it('缺少票据 ⇒ 403 + FORBIDDEN（开关开时不得放行）', async () => {
    const { controller, withdrawals, redis } = make({ del: async () => 1 });

    const err = await catchHttp(controller.apply('u1', undefined, { coins: 100 }));

    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      code: ErrCode.FORBIDDEN,
      message: 'reauth ticket required',
    });
    expect(redis.del).not.toHaveBeenCalled();
    expect(withdrawals.apply).not.toHaveBeenCalled();
  });

  it('HTTP_STATUS 补齐 FORBIDDEN→403（否则 ?? 500 静默吞掉 4xx）', () => {
    expect(HTTP_STATUS[ErrCode.FORBIDDEN]).toBe(403);
  });
});
