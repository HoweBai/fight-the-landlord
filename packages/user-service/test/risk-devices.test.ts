/**
 * `DevicesService` + `risk.deviceReport` 接收侧 —— 风控片 T4 / 规格 §2.1-4 · §2.8 · ⚙️11
 * （C20 单测半边 + C8 接收侧半边）。
 *
 * ─── 夹具（一件，形态照 `record.rpc.test.ts` 成例）────────────────────────────
 *  - **假 DB**：仿真 `uk(user_id, device_id)` 唯一键 + `ON DUPLICATE KEY UPDATE … IF(...)`
 *    的 **1h 节流**语义（承重语义全在「库行为」层：幂等一行、`last_seen_at` 刷/不刷的
 *    逐毫秒边界）；`now` 是仿真服务端 `NOW(3)` 的注入点。真 InnoDB 的最终证据 = T13 真栈回归。
 *  - **独立誊写**：SQL 断言用测试侧按 ⚙️11 **逐字誊写**的常量（不 import 实现那份），
 *    且假 DB 只认这一份文本 —— 实现常量一漂移，全部行为用例当场红（不是只红一条断言）。
 *  - **路由纪律**：`SELECT \`id\` FROM \`users\` …`（存在性读）与 upsert 两条 SQL 之外，
 *    任何语句都让假 DB 抛错 ⇒「先查存在、后 upsert」的次序与「坏参零库操作」都是机械证据。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { DEVICE_UPSERT_SQL, DevicesService } from '../src/risk/devices.service';
import { DeviceReportRpcController } from '../src/risk/device-report.rpc.controller';

const HOUR_MS = 3_600_000;
/** 固定时间轴原点（仿真 `NOW(3)` 的起点；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-05T12:00:00.000Z');

/** 规格 ⚙️11 逐字（**测试侧独立誊写** —— 断言执行面，不是回抄实现常量）。 */
const SPEC_DEVICE_UPSERT_SQL =
  'INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at) VALUES (?,?,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE last_seen_at = IF(last_seen_at < NOW(3) - INTERVAL 1 HOUR, NOW(3), last_seen_at)';

interface Statement {
  sql: string;
  params: unknown[];
}

interface DeviceRow {
  user_id: string;
  device_id: string;
  first_seen_at: number;
  last_seen_at: number;
}

/**
 * 最小仿真：`users` 存在性表 + `user_devices` 真语义 upsert（唯一键 + 1h 节流）。
 * `now` 由用例逐毫秒设置（= 服务端 `NOW(3)` 的代面）。
 */
class FakeDb {
  users = new Set<string>();
  devices: DeviceRow[] = [];
  now = T0;
  /** 全部语句的观测面（次序 / 参数 / 条数全靠它）。 */
  queries: Statement[] = [];
  /** > 0 ⇒ 该次 query 直接 reject（每次消一个；库故障用例）。 */
  failuresRemaining = 0;

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        return Promise.reject(new Error('db down（仿真）'));
      }
      // ── 存在性读（实现自选的写法；这里按前缀认，参数逐字核对）──────────
      if (sql.startsWith('SELECT `id` FROM `users`')) {
        const [id] = params as [string];
        return Promise.resolve(this.users.has(id) ? [{ id }] : []);
      }
      // ── ⚙️11 upsert：只认规格逐字文本（实现漂移 ⇒ 未识别 ⇒ 当场红）────
      if (sql === SPEC_DEVICE_UPSERT_SQL) {
        const [userId, deviceId] = params as [string, string];
        const existing = this.devices.find(
          (d) => d.user_id === userId && d.device_id === deviceId,
        );
        if (existing === undefined) {
          this.devices.push({
            user_id: userId,
            device_id: deviceId,
            first_seen_at: this.now,
            last_seen_at: this.now,
          });
          return Promise.resolve({ affectedRows: 1 });
        }
        // `ON DUPLICATE KEY UPDATE last_seen_at = IF(last_seen_at < NOW(3) - INTERVAL 1 HOUR, NOW(3), last_seen_at)`
        // —— 严格小于：恰满 1h **不刷**；超过 1h 才刷。
        if (existing.last_seen_at < this.now - HOUR_MS) existing.last_seen_at = this.now;
        return Promise.resolve({ affectedRows: existing.last_seen_at === this.now ? 1 : 0 });
      }
      return Promise.reject(new Error(`FakeDb 未识别的 SQL：${sql}`));
    },
  };
}

/** 一个**通过校验**的合法载荷（个别用例只改一处）。 */
function mkReq(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { userId: 'u-A', deviceId: 'dev-0001', ...over };
}

describe('风控片 T4：risk.deviceReport 接收侧（规格 §2.1-4 / §2.8 / ⚙️11）', () => {
  let db: FakeDb;
  let controller: DeviceReportRpcController;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeDb();
    db.users.add('u-A');
    controller = new DeviceReportRpcController(new DevicesService(db.dataSource as never));
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('SQL 常量全文 == 规格 ⚙️11 逐字（全文相等——不是 toContain）', () => {
    expect(DEVICE_UPSERT_SQL).toBe(SPEC_DEVICE_UPSERT_SQL);
  });

  it('pattern 键逐字：RPC_PATTERNS.riskDeviceReport = risk.deviceReport（J21 的键面）', () => {
    expect(RPC_PATTERNS.riskDeviceReport).toBe('risk.deviceReport');
  });

  it('正路径：报告 ⇒ {ok:true}（恰此形状）+ 恰两语句（存在性读 → upsert）、参数逐字', async () => {
    const res = await controller.report(mkReq() as never);

    expect(res).toEqual({ ok: true }); // 无 data/message —— §2.1-4 的响应就是这一个形状
    expect(db.queries.map((s) => s.sql)).toEqual([
      'SELECT `id` FROM `users` WHERE `id` = ?',
      SPEC_DEVICE_UPSERT_SQL,
    ]);
    expect(db.queries[0]!.params).toEqual(['u-A']);
    expect(db.queries[1]!.params).toEqual(['u-A', 'dev-0001']);
    // 首见 = 末见 = 服务端 NOW(3)（两列由 SQL 的 NOW(3) 同刻写入）
    expect(db.devices).toEqual([
      { user_id: 'u-A', device_id: 'dev-0001', first_seen_at: T0, last_seen_at: T0 },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('幂等：同 (user, device) 两报 ⇒ **一行**；<1h 不刷 last_seen（恰 1h 边界也不刷——严格小于）', async () => {
    await controller.report(mkReq() as never);

    db.now = T0 + HOUR_MS - 1; // 59:59.999 —— 未满 1h
    await controller.report(mkReq() as never);
    expect(db.devices).toHaveLength(1);
    expect(db.devices[0]!.last_seen_at).toBe(T0); // 不刷

    db.now = T0 + HOUR_MS; // 恰满 1h —— `last_seen < now − 1h` 为 false ⇒ 仍不刷
    await controller.report(mkReq() as never);
    expect(db.devices).toHaveLength(1);
    expect(db.devices[0]!.last_seen_at).toBe(T0);

    // 三次报告只插过一行（幂等）：INSERT 形态的语句恰 1 条 —— 后两条走的都是 ON DUPLICATE 分支。
    expect(db.queries.filter((s) => s.sql === SPEC_DEVICE_UPSERT_SQL)).toHaveLength(3);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('1h 节流正反：超过 1h（1h+1ms）⇒ last_seen 刷新、first_seen 不动（保留首见）', async () => {
    await controller.report(mkReq() as never);

    db.now = T0 + HOUR_MS + 1; // 严格超过 1h —— 刷新点
    await controller.report(mkReq() as never);

    expect(db.devices).toEqual([
      { user_id: 'u-A', device_id: 'dev-0001', first_seen_at: T0, last_seen_at: T0 + HOUR_MS + 1 },
    ]);

    // 再报（同一时刻）⇒ 又不刷（刚刷过）。
    await controller.report(mkReq() as never);
    expect(db.devices[0]!.last_seen_at).toBe(T0 + HOUR_MS + 1);
  });

  it('不同 device ⇒ 各一行（uk 是 (user_id, device_id)，不是按用户去重）', async () => {
    await controller.report(mkReq({ deviceId: 'dev-0001' }) as never);
    await controller.report(mkReq({ deviceId: 'dev-0002' }) as never);

    expect(db.devices.map((d) => d.device_id)).toEqual(['dev-0001', 'dev-0002']);
  });

  it('坏参（两字段非空 string、deviceId ≤64）⇒ {ok:false,BAD_PARAM} 且**零库操作**（不抛）', async () => {
    const cases: Array<[string, unknown]> = [
      ['非对象（null）', null],
      ['非对象（字符串）', 'nope'],
      ['缺 userId', { deviceId: 'dev-0001' }],
      ['userId 空串', mkReq({ userId: '' })],
      ['userId 非 string', mkReq({ userId: 123 })],
      ['缺 deviceId', { userId: 'u-A' }],
      ['deviceId 空串', mkReq({ deviceId: '' })],
      ['deviceId 非 string', mkReq({ deviceId: 42 })],
      ['deviceId 65 位（越列宽 varchar(64)）', mkReq({ deviceId: 'a'.repeat(65) })],
    ];

    for (const [label, req] of cases) {
      const res = await controller.report(req as never);
      expect(res, label).toEqual({ ok: false, code: 'BAD_PARAM' });
    }
    expect(db.queries, '坏参一个都不许触库').toHaveLength(0);
    // 边界正对照：64 位恰合规（过校验 ⇒ 真的走到库面）。
    const ok64 = await controller.report(mkReq({ deviceId: 'a'.repeat(64) }) as never);
    expect(ok64).toEqual({ ok: true });
    expect(db.devices).toHaveLength(1);

    // 校验失败是调用方 bug（room 组装端口），不是 error 级运维告警（record.write 同口径）。
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('用户不存在 ⇒ {ok:false,BAD_PARAM}（**不抛**）+ 只发存在性读、不发 upsert', async () => {
    const res = await controller.report(mkReq({ userId: 'u-ghost' }) as never);

    expect(res).toEqual({ ok: false, code: 'BAD_PARAM' });
    expect(db.queries.map((s) => s.sql)).toEqual(['SELECT `id` FROM `users` WHERE `id` = ?']);
    expect(db.devices).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled(); // 业务性失败不是运维告警
  });

  it('库故障 ⇒ {ok:false,UPSTREAM_UNAVAILABLE} + error 日志一行（R220：业务错误不抛）', async () => {
    db.failuresRemaining = 1; // 存在性读就抛

    const res = await controller.report(mkReq() as never);

    expect(res).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain('db down（仿真）');
  });
});
