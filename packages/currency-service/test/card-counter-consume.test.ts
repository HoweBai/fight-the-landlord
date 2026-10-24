/**
 * 记牌器收费片 T8：`currency.cardCounterConsume`（规格 §2.4e；C18–C22 的单测半边）。
 *
 * 假 DB 已扩展 entitlements/consumptions 的精确 SQL 形状与 1062 注入面；
 * 真并发/真库判据由 conformance slice-28 承载。
 */
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrCode, type CurrencyCardCounterConsumeResponse } from '@fight-the-landlord/protocol';
import { CardCounterConsumeService } from '../src/card-counter/consume.service';
import { FakeCurrencyDb } from './helpers/fake-currency-db';

function makeService(db: FakeCurrencyDb): CardCounterConsumeService {
  return new CardCounterConsumeService(db.dataSource as unknown as DataSource);
}

function expectOk(res: CurrencyCardCounterConsumeResponse) {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`期望成功：${res.code}:${res.message}`);
  return res.data;
}

const USER = 'u-consume-1';

describe('currency.cardCounterConsume', () => {
  it('包时优先：不扣单局卡；kind=pass / expiresAt=包时到期；seat/trace 落行', async () => {
    const db = new FakeCurrencyDb([]);
    const expires = Date.now() + 60_000;
    db.entitlements.set(USER, { ownerId: USER, credits: 2, passExpiresAt: expires });
    const service = makeService(db);

    const data = expectOk(
      await service.consume({ roomCode: 'R1', ownerId: USER, seat: 1, meta: { traceId: 't1' } }),
    );
    expect(data.active).toBe(true);
    expect(data.source).toBe('pass');
    expect(data.expiresAt).toBe(expires);
    expect(db.entitlements.get(USER)?.credits).toBe(2);
    expect(db.consumptions).toHaveLength(1);
    expect(db.consumptions[0]).toMatchObject({
      roomCode: 'R1',
      ownerId: USER,
      seat: 1,
      kind: 'pass',
      expiresAt: expires,
      traceId: 't1',
    });
  });

  it('单局卡：credits−1 / kind=credit；用完后再开局 ⇒ none', async () => {
    const db = new FakeCurrencyDb([]);
    db.entitlements.set(USER, { ownerId: USER, credits: 1, passExpiresAt: null });
    const service = makeService(db);

    const first = expectOk(await service.consume({ roomCode: 'R1', ownerId: USER, seat: 0 }));
    expect(first).toEqual({ active: true, source: 'credit', expiresAt: null });
    expect(db.entitlements.get(USER)?.credits).toBe(0);

    const second = expectOk(await service.consume({ roomCode: 'R2', ownerId: USER, seat: 0 }));
    expect(second).toEqual({ active: false, source: 'none', expiresAt: null });
    expect(db.consumptions.map((c) => c.kind)).toEqual(['credit', 'none']);
  });

  it('无权益 ⇒ none（也落行，保证同房幂等）', async () => {
    const db = new FakeCurrencyDb([]);
    const service = makeService(db);
    const data = expectOk(await service.consume({ roomCode: 'R1', ownerId: USER }));
    expect(data).toEqual({ active: false, source: 'none', expiresAt: null });
    expect(db.consumptions).toHaveLength(1);
    expect(db.consumptions[0]).toMatchObject({ kind: 'none', seat: null, traceId: null });
  });

  it('同房幂等：重复调用返回首笔结果，credits 只扣一次', async () => {
    const db = new FakeCurrencyDb([]);
    db.entitlements.set(USER, { ownerId: USER, credits: 2, passExpiresAt: null });
    const service = makeService(db);

    const first = expectOk(await service.consume({ roomCode: 'R1', ownerId: USER }));
    const second = expectOk(await service.consume({ roomCode: 'R1', ownerId: USER }));
    expect(second).toEqual(first);
    expect(db.entitlements.get(USER)?.credits).toBe(1);
    expect(db.consumptions).toHaveLength(1);
  });

  it('并发 1062：回滚本事务后回读胜者行（不冒未知态、不双扣）', async () => {
    const db = new FakeCurrencyDb([]);
    db.entitlements.set(USER, { ownerId: USER, credits: 1, passExpiresAt: null });
    const service = makeService(db);
    let injected = false;

    db.beforeStatement = (sql, _params, session) => {
      if (injected || !sql.includes('INSERT INTO `card_counter_consumptions`')) return;
      injected = true;
      const winner = {
        id: 999,
        roomCode: 'R1',
        ownerId: USER,
        seat: 0,
        kind: 'credit' as const,
        expiresAt: null,
        traceId: 'winner',
      };
      // 胜者已提交：既写进事务 scratch（触发 1062），也写进已提交视图（回读面）。
      session.consumptions.push(winner);
      db.consumptions.push(winner);
      // 胜者已扣的那一张：已提交视图同步扣掉（模拟胜者事务提交后的终态）。
      const ent = db.entitlements.get(USER);
      if (ent) ent.credits -= 1;
    };

    const data = expectOk(await service.consume({ roomCode: 'R1', ownerId: USER }));
    expect(data).toEqual({ active: true, source: 'credit', expiresAt: null });
    expect(db.entitlements.get(USER)?.credits).toBe(0);
    expect(db.consumptions.filter((c) => c.roomCode === 'R1' && c.ownerId === USER)).toHaveLength(1);
    expect(injected).toBe(true);
  });

  it('契约校验：roomCode/ownerId/seat 反例 ⇒ {ok:false, 10001}，零库操作', async () => {
    const db = new FakeCurrencyDb([]);
    const service = makeService(db);
    const bad: unknown[] = [
      null,
      { roomCode: '', ownerId: USER },
      { roomCode: 'X'.repeat(17), ownerId: USER },
      { roomCode: 'R1', ownerId: 'bad id' },
      { roomCode: 'R1', ownerId: USER, seat: 3 },
    ];
    for (const dto of bad) {
      const res = await service.consume(dto);
      expect(res).toMatchObject({ ok: false, code: ErrCode.BAD_PARAM });
    }
    expect(db.consumptions).toHaveLength(0);
  });
});
