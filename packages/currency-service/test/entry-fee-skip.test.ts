/**
 * 台费片 T3：`EntryFeeSkipService` —— 免单逐笔记账的写边内核（C21）。
 *
 * 判据：① 首发落行 ⇒ `inserted:true`；同房同人二投 ⇒ `affectedRows 0` ⇒ `inserted:false`
 * 且行数仍 1（`(room_code, owner_id)` 唯一键 + `INSERT IGNORE` —— C17 的单测半边）；
 * ② 校验失败 ⇒ `{ok:false, 10001}` 中文原因、**零库操作**（校验先于一切）；
 * ③ `affectedRows` 畸形（0/1 之外）⇒ **响亮抛**（不静默按成功）。
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { EntryFeeSkipService } from '../src/skip/entry-fee-skip.service';
import { FakeCurrencyDb } from './helpers/fake-currency-db';

const REQ = {
  roomCode: 'ABC123',
  ownerId: 'u-1',
  seat: 1,
  baseScore: 15,
  feeAmount: 1,
  reason: 'insufficient_funds' as const,
};

describe('EntryFeeSkipService（本片：INSERT IGNORE / affectedRows 0/1 / {inserted}）', () => {
  it('首发落行 ⇒ inserted:true（行内容逐字段）；同房同人二投 ⇒ inserted:false 且行数仍 1', async () => {
    const db = new FakeCurrencyDb();
    const svc = new EntryFeeSkipService(db.dataSource as unknown as DataSource);

    await expect(svc.record(REQ)).resolves.toEqual({ ok: true, data: { inserted: true } });
    expect(db.skips).toEqual([
      // C2 起夹具行带 createdAt（对账窗口过滤面；写边仍由 DB 默认值填）。
      { id: 1, roomCode: 'ABC123', ownerId: 'u-1', seat: 1, gameType: 'doudizhu', baseScore: 15, feeAmount: 1, reason: 'insufficient_funds', traceId: null, createdAt: expect.any(Number) },
    ]);

    await expect(svc.record(REQ)).resolves.toEqual({ ok: true, data: { inserted: false } });
    expect(db.skips).toHaveLength(1); // 幂等键：不重复行
  });

  it('A2：gameType 落库（缺席=doudizhu；显式 pdk=paodekuai）', async () => {
    const db = new FakeCurrencyDb();
    const svc = new EntryFeeSkipService(db.dataSource as unknown as DataSource);

    await expect(svc.record({ ...REQ, roomCode: 'GTDDZ' })).resolves.toEqual({
      ok: true,
      data: { inserted: true },
    });
    expect(db.skips[0]!.gameType).toBe('doudizhu');

    await expect(svc.record({ ...REQ, roomCode: 'GTPDK', gameType: 'paodekuai' })).resolves.toEqual({
      ok: true,
      data: { inserted: true },
    });
    expect(db.skips[1]!.gameType).toBe('paodekuai');
  });

  it('meta.traceId ⇒ trace_id 列；seat 缺席 ⇒ NULL', async () => {
    const db = new FakeCurrencyDb();
    const svc = new EntryFeeSkipService(db.dataSource as unknown as DataSource);

    await expect(
      svc.record({ ...REQ, seat: undefined, meta: { traceId: 'T-9' } }),
    ).resolves.toEqual({ ok: true, data: { inserted: true } });
    expect(db.skips[0]).toMatchObject({ seat: null, traceId: 'T-9' });
  });

  it('校验失败 ⇒ {ok:false, 10001} 中文原因 + 零库操作（校验先于一切库步）', async () => {
    const db = new FakeCurrencyDb();
    const svc = new EntryFeeSkipService(db.dataSource as unknown as DataSource);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const res = await svc.record({ ...REQ, reason: 'action_conflict' });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable: 上一行已断言');
      expect(res.code).toBe(ErrCode.BAD_PARAM);
      expect(res.message).toContain('reason 必须是 insufficient_funds / unknown_outcome / internal_error 之一');
      expect(db.skips).toHaveLength(0);
      expect(db.directQueries).toEqual([]); // 连直读都没发生
    } finally {
      warn.mockRestore();
    }
  });

  it('affectedRows 畸形（0/1 之外）⇒ 响亮抛（不静默按成功）', async () => {
    // ⚠️ 替身 = **含 `query` 的对象本体**直接 cast（照 `apply.test.ts:448-455` 先例）——
    // 多包一层 `{ dataSource: … }` 会让 `this.dataSource.query` 为 undefined
    // （TypeError 不命中本断言 ⇒ 恒红）。
    const broken = { query: async () => ({ affectedRows: 2 }) } as unknown as DataSource;
    const svc = new EntryFeeSkipService(broken);

    await expect(svc.record(REQ)).rejects.toThrow(/affectedRows=2/);
  });
});
