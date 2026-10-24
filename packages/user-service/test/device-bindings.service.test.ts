/**
 * 设备绑定片：`DeviceBindingsService` 单元测试。
 *
 * 与 `risk-admin.test.ts` 的分工：那份在真 Nest HTTP 管线上覆盖解绑（事务/审计/DEL/404）；
 * 本文件只覆盖登录闸 `checkOrBind` 的五态（放行不绑 / 首绑 / 一致 / 不一致 / 并发首绑落败）
 * + Redis 写透故障 fail-open。假件只实现本服务实际碰到的查询面。
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  DeviceBindingsService,
  DEVICE_BINDING_SELECT_SQL,
  DEVICE_BINDING_INSERT_IGNORE_SQL,
  DEVICE_BINDING_DELETE_SQL,
  DEVICE_BINDING_LOCK_SELECT_SQL,
  DEVICE_UNBIND_AUDIT_INSERT_SQL,
  riskBindingKey,
} from '../src/risk/device-bindings.service';
import { DomainError } from '../src/http/errors';

interface FakeBindingRow {
  device_id: string;
}

/** 最小 DataSource 假件：用一个函数解释全部 query；事务 = 直接跑回调（manager 同一解释器）。 */
function makeDataSource(script: {
  /** SELECT 的返回队列（按调用顺序消费；缺省 []）。 */
  selectResults?: Array<FakeBindingRow[] | FakeBindingRow[] | FakeBindingRow[]>;
  onInsert?: (userId: string, deviceId: string) => void;
  onDelete?: (userId: string) => void;
}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let selectIndex = 0;
  const exec = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql === DEVICE_BINDING_SELECT_SQL || sql === DEVICE_BINDING_LOCK_SELECT_SQL) {
      const queue = script.selectResults ?? [];
      return queue[Math.min(selectIndex++, queue.length - 1)] ?? [];
    }
    if (sql === DEVICE_BINDING_INSERT_IGNORE_SQL) {
      const [userId, deviceId] = params as [string, string];
      script.onInsert?.(userId, deviceId);
      return { affectedRows: 1 };
    }
    if (sql === DEVICE_BINDING_DELETE_SQL) {
      script.onDelete?.(String(params[0]));
      return { affectedRows: 1 };
    }
    if (sql === DEVICE_UNBIND_AUDIT_INSERT_SQL) return { affectedRows: 1 };
    throw new Error(`未预期的 SQL：${sql}`);
  };
  return {
    queries,
    dataSource: {
      query: exec,
      transaction: async <T,>(cb: (manager: { query: typeof exec }) => Promise<T>) => cb({ query: exec }),
    },
  };
}

function fakeRedis(overrides: { set?: ReturnType<typeof vi.fn> } = {}) {
  return {
    set: overrides.set ?? vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  } as any;
}

describe('DeviceBindingsService.checkOrBind（登录/注册/refresh 设备闸）', () => {
  it('无 deviceId ⇒ 直接放行：零 SQL、零 Redis（旧端/隐私模式 fail-open 且不绑）', async () => {
    const ds = makeDataSource({});
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await expect(svc.checkOrBind('u1', undefined)).resolves.toBeUndefined();
    expect(ds.queries).toHaveLength(0);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('无绑定行 ⇒ 静默首绑：INSERT IGNORE + 重读确认 + 写透 risk:binding:{userId}（无 TTL）', async () => {
    const ds = makeDataSource({ selectResults: [[], [{ device_id: 'dev-device-1234' }]] });
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await svc.checkOrBind('u1', 'dev-device-1234');

    expect(ds.queries.map((q) => q.sql)).toEqual([
      DEVICE_BINDING_SELECT_SQL,
      DEVICE_BINDING_INSERT_IGNORE_SQL,
      DEVICE_BINDING_SELECT_SQL,
    ]);
    expect(ds.queries[1]!.params).toEqual(['u1', 'dev-device-1234']);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(riskBindingKey('u1'), 'dev-device-1234');
    // 无 TTL：SET 只有两个参数（键、值）。
    expect(redis.set.mock.calls[0]!).toHaveLength(2);
  });

  it('已绑同一设备 ⇒ 放行热路径：一次点查，无 INSERT、无 Redis 访问', async () => {
    const ds = makeDataSource({ selectResults: [[{ device_id: 'dev-device-1234' }]] });
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await expect(svc.checkOrBind('u1', 'dev-device-1234')).resolves.toBeUndefined();
    expect(ds.queries.map((q) => q.sql)).toEqual([DEVICE_BINDING_SELECT_SQL]);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('已绑其他设备 ⇒ 抛 11005（DEVICE_MISMATCH）；无 INSERT、无 Redis 写', async () => {
    const ds = makeDataSource({ selectResults: [[{ device_id: 'dev-device-9999' }]] });
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await expect(svc.checkOrBind('u1', 'dev-device-1234')).rejects.toMatchObject({
      code: ErrCode.DEVICE_MISMATCH,
      message: '账号已绑定其他设备',
    });
    expect(ds.queries.map((q) => q.sql)).toEqual([DEVICE_BINDING_SELECT_SQL]);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('并发首绑落败（INSERT 被 PK 忽略、重读是别人的设备）⇒ 11005，且不写透自己的设备', async () => {
    const ds = makeDataSource({ selectResults: [[], [{ device_id: 'dev-device-9999' }]] });
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await expect(svc.checkOrBind('u1', 'dev-device-1234')).rejects.toBeInstanceOf(DomainError);
    await expect(svc.checkOrBind('u1', 'dev-device-1234')).rejects.toMatchObject({
      code: ErrCode.DEVICE_MISMATCH,
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('首绑写透 Redis 失败 ⇒ 不抛（MySQL 是真相；登录闸已成立，WS 缓存残余只 warn）', async () => {
    const ds = makeDataSource({ selectResults: [[], [{ device_id: 'dev-device-1234' }]] });
    const redis = fakeRedis({ set: vi.fn(async () => { throw new Error('redis down（仿真）'); }) });
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await expect(svc.checkOrBind('u1', 'dev-device-1234')).resolves.toBeUndefined();
  });
});

describe('DeviceBindingsService.unbind（管理面人工解绑）', () => {
  it('有绑定 ⇒ 返旧设备；锁读→删行→审计在同一事务，COMMIT 后 DEL 缓存', async () => {
    const ds = makeDataSource({ selectResults: [[{ device_id: 'dev-device-1234' }]] });
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    const result = await svc.unbind('u1', 'admin-a');

    expect(result).toEqual({ previousDeviceId: 'dev-device-1234' });
    const sqls = ds.queries.map((q) => q.sql);
    expect(sqls).toEqual([
      DEVICE_BINDING_LOCK_SELECT_SQL,
      DEVICE_BINDING_DELETE_SQL,
      DEVICE_UNBIND_AUDIT_INSERT_SQL,
    ]);
    // 审计参数：action 是 SQL 内定值；detail 携带旧设备。
    const auditParams = ds.queries[2]!.params as unknown[];
    expect(auditParams[0]).toBe('u1');
    expect(auditParams[1]).toBe('admin-a');
    expect(JSON.parse(String(auditParams[2]))).toEqual({ previousDeviceId: 'dev-device-1234' });
    expect(redis.del).toHaveBeenCalledWith(riskBindingKey('u1'));
  });

  it('无绑定行 ⇒ 11004（USER_NOT_FOUND 借码）；不删、不审计、不 DEL', async () => {
    const ds = makeDataSource({ selectResults: [[]] });
    const redis = fakeRedis();
    const svc = new DeviceBindingsService(ds.dataSource as any, redis);

    await expect(svc.unbind('ghost', 'admin-a')).rejects.toMatchObject({
      code: ErrCode.USER_NOT_FOUND,
    });
    expect(ds.queries.map((q) => q.sql)).toEqual([DEVICE_BINDING_LOCK_SELECT_SQL]);
    expect(redis.del).not.toHaveBeenCalled();
  });
});
