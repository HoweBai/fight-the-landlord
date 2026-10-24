import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  ADMIN_EXEMPT_ROUTES,
  ADMIN_HEADER,
  isAdminExemptRoute,
} from '../src/config/admin.controller';
import { ADMIN_ACTOR_HEADER } from '../src/admin/accounts.controller';
import { FakeAdminDb, makeService, seedDb, startHttpProbe, type HttpProbe } from './helpers/config-probe';

/**
 * `/api/admin/*` 的管理面契约（规格 §2.5；C5 集成半边 / C12 面 / 「豁免恰好一条」）。
 *
 * 判据（三态 + 形状）：
 *  - 除 login 外**全部** admin 路由 fail-closed 校验 `X-Admin: 1`（缺 / 伪造值 ⇒ 401，且
 *    **碰不到 handler**（PUT 被拦时值必须原样））；
 *  - `PUT` 非法 ⇒ **400 + 原因**且**不落库**（C5：「400 了却先落库」是最像正确答案的错实现）；
 *  - `PUT` 成功 ⇒ `{saved:true, announced, version}`（announced 如实透传 C12）；
 *  - `GET /api/admin/config` ⇒ 全量六十五键 + 每键 `{value, version}` + 全局 MAX；
 *  - ③ T4：`PUT` 的 `X-Admin-Actor` 缺失/非法 ⇒ **401 fail-closed**（不回退）；成功写 ⇒
 *    `config_changes` 留痕行 `{key, oldValue, newValue, actor}` + `updated_by = actor`（§2.6）。
 *
 * HTTP 侧走**真 Nest 管线**（guard / 异常过滤器 / 状态码都是真的，见 helpers 头注释）。
 * ③ T3 起登录面改版（库内账号 + 归一 + 新文案）：本文件的「豁免恰一条」行为面用**库内有号 +
 * 错口令**证明「到达的是 handler（文案 `用户名或口令错误`）而不是 guard（`admin header required`）」。
 */

/** 管理读写的常用头（③ T4 起写面必带 actor——T5 网关上线后由网关注入）。 */
const AUTH = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'admin' };
/** 直接查假库的一行（读侧断言不经 HTTP —— 不用被测系统证明被测系统）。 */
const row = (db: ReturnType<typeof seedDb>, key: string) => db.rows.get(key) as { value: unknown; version: number };

describe('X-Admin fail-closed（真 guard）', () => {
  let probe: HttpProbe;
  let db: ReturnType<typeof seedDb>;

  beforeAll(async () => {
    const a = makeService(seedDb());
    db = a.db;
    const adminDb = new FakeAdminDb();
    // 形状合法的库内账号（占位哈希——本组只走 ⑤ verify fail 分支，判别点在「文案来自 handler」）
    adminDb.addAccount({ username: 'admin', role: 'super_admin' });
    probe = await startHttpProbe(a.svc, adminDb);
  });
  afterAll(async () => {
    await probe.close();
  });

  it('无 X-Admin：GET /api/admin/config ⇒ 401 + 10002，且不带任何配置值', async () => {
    const res = await probe.get('/api/admin/config');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrCode.UNAUTHENTICATED);
    expect(res.body.data).toBeNull();
  });

  it('伪造值 must be exactly `1`（fail-closed）：`0` / `true` / 空串 / `01` 全部 401', async () => {
    // ⚠️ 不要拿 `'1 '` 当伪造值：HTTP 规范剥掉头值的首尾空白，线上到达 guard 的就是 `1`
    //    （实测 fetch 会把 `'1 '` 归一成 `'1'`）—— 那是协议行为，不是守卫的洞。
    for (const forged of ['0', 'true', '', '01']) {
      const res = await probe.get('/api/admin/config', { [ADMIN_HEADER]: forged });
      expect(res.status, `X-Admin: ${JSON.stringify(forged)}`).toBe(401);
    }
  });

  it('无 X-Admin 的 PUT 被拦在 handler 之前：401 且值**逐字未变**（连 version 都不动）', async () => {
    const before = { ...row(db, 'room.friendRoomEnabled') };

    const res = await probe.putJson('/api/admin/config/room.friendRoomEnabled', { value: true });

    expect(res.status).toBe(401);
    expect(row(db, 'room.friendRoomEnabled')).toEqual(before);
  });

  it('X-Admin: 1 ⇒ 放行（GET 200 / PUT 200）—— 判别力：401 不是「恒红」', async () => {
    const get = await probe.get('/api/admin/config', AUTH);
    expect(get.status).toBe(200);

    const put = await probe.putJson('/api/admin/config/room.friendRoomEnabled', { value: false }, AUTH);
    expect(put.status).toBe(200);
    expect(row(db, 'room.friendRoomEnabled').value).toBe(false);
  });

  it('豁免**恰好一条**：豁免表 = [POST /api/admin/login]（结构钉死），行为与表一致', async () => {
    expect(ADMIN_EXEMPT_ROUTES).toEqual([{ method: 'POST', path: '/api/admin/login' }]);
    expect(isAdminExemptRoute('POST', '/api/admin/login')).toBe(true);
    // 近邻全部不豁免（防「顺手多豁免」的洞）
    expect(isAdminExemptRoute('GET', '/api/admin/login')).toBe(false);
    expect(isAdminExemptRoute('POST', '/api/admin/login/extra')).toBe(false);
    expect(isAdminExemptRoute('POST', '/api/admin/config')).toBe(false);
    expect(isAdminExemptRoute('PUT', '/api/admin/config/room.friendRoomEnabled')).toBe(false);

    // 行为面：login 不带 X-Admin 也能**到达 handler**（错口令 ⇒ 401 来自 login 自身——
    // 文案是 handler 的「用户名或口令错误」，不是 guard 的 'admin header required'）
    const res = await probe.postJson('/api/admin/login', { username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('用户名或口令错误'); // ← 不是 guard 的 'admin header required'
  });
});

describe('PUT /api/admin/config/:key（C5 集成半边 / C12 面）', () => {
  let probe: HttpProbe;
  let db: ReturnType<typeof seedDb>;
  let publish: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const a = makeService(seedDb());
    db = a.db;
    publish = a.publish;
    probe = await startHttpProbe(a.svc);
  });
  afterAll(async () => {
    await probe.close();
  });

  it('非法值 ⇒ 400 + 原因（parseConfigValue 的中文消息）且**不落库**（值 + version 都未变）', async () => {
    const before = { ...row(db, 'room.friendRoomEnabled') };
    publish.mockClear();

    const res = await probe.putJson(
      '/api/admin/config/room.friendRoomEnabled',
      { value: 'true' }, // 严格 boolean：字符串不算
      AUTH,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrCode.BAD_PARAM);
    expect(res.body.message).toContain('boolean'); // 「400 + 原因」的「原因」不是泛化文案
    expect(row(db, 'room.friendRoomEnabled')).toEqual(before);
    expect(publish).not.toHaveBeenCalled(); // 校验在**任何**库操作之前（含广播）
  });

  it('未知键 ⇒ 400（不是 500、更不是静默落库）', async () => {
    const res = await probe.putJson('/api/admin/config/nope.key', { value: 1 }, AUTH);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('未知配置键');
  });

  it('成功 ⇒ `{saved:true, announced:true, version:v0+1}`；值已落库、广播已发', async () => {
    const v0 = row(db, 'room.friendRoomEnabled').version;

    const res = await probe.putJson('/api/admin/config/room.friendRoomEnabled', { value: true }, AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { saved: true, announced: true, version: v0 + 1 },
    });
    expect(row(db, 'room.friendRoomEnabled')).toMatchObject({ value: true, version: v0 + 1 });
    expect(publish).toHaveBeenCalledWith(
      'config:changed',
      JSON.stringify({ keys: ['room.friendRoomEnabled'] }),
    );
  });

  it('C12 面：publish 失败 ⇒ 仍 200 `{saved:true, announced:false}`（值**已落库**，如实报未广播）', async () => {
    const v0 = row(db, 'room.reapIntervalMs').version;
    publish.mockRejectedValueOnce(new Error('redis down'));

    const res = await probe.putJson('/api/admin/config/room.reapIntervalMs', { value: 61000 }, AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ saved: true, announced: false, version: v0 + 1 });
    expect(row(db, 'room.reapIntervalMs')).toMatchObject({ value: 61000, version: v0 + 1 });
  });

  it('GET /api/admin/config：全量六十五键、每键 {value, version}、全局 version = MAX', async () => {
    const res = await probe.get('/api/admin/config', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(ErrCode.OK);
    const config = res.body.data.config as Record<string, { value: unknown; version: number }>;
    expect(Object.keys(config).sort()).toEqual(
      [
        // 广告片 T2（第 41 键）
        'ad.reliefAdpid',
        // 客户端接入片 T2（第 43/44 键）
        'client.appEnabled',
        'client.h5Enabled',
        'currency.entryMultiplier',
        'currency.rakePercent',
        'currency.reliefAmount',
        'currency.reliefEnabled',
        'currency.signupGrant',
        'game.baseScoreLevels',
        // 记牌器片（第 50 键）
        'game.cardCounterEnabled',
        // 记牌器收费片（第 51/52 键）
        'game.cardCounterPricePerGameCoins',
        'game.cardCounterPricePerHourCoins',
        // 多玩法（Task 5.1）：跑得快 14 键
        'game.levels.paodekuai',
        'game.paodekuai.airplaneWings',
        'game.paodekuai.baobenEnabled',
        'game.doudizhu.enabled',
        'game.paodekuai.bareAirplaneEnabled',
        'game.paodekuai.bareTrioEnabled',
        'game.paodekuai.bombMultiplierEnabled',
        'game.paodekuai.enabled',
        'game.paodekuai.fourWithTwoEnabled',
        'game.paodekuai.fourWithTwoPairKickerAllowed',
        'game.paodekuai.guanMultiplierEnabled',
        'game.paodekuai.multiplierCap',
        'game.paodekuai.nonThreePlayerEnabled',
        'game.paodekuai.springMultiplierEnabled',
        'game.paodekuai.trioWithPairEnabled',
        // 支付片 T5（第 26–34 键）
        'pay.coinPerYuan',
        'pay.orderExpireMinutes',
        'pay.rechargeEnabled',
        'pay.rechargePackages',
        'pay.withdrawDailyMaxCoins',
        'pay.withdrawEnabled',
        'pay.withdrawMaxCoinsPerOrder',
        'pay.withdrawMinCoins',
        'pay.withdrawTimeoutMinutes',
        'record.retentionDays',
        // 风控片 T1（第 18–25 键）
        'risk.autoThrottle',
        // 设备绑定（第 43 键；服务端私有，仍出现在管理后台全量清单里）
        'risk.deviceBindingEnabled',
        'risk.deviceLimit',
        'risk.deviceRetentionDays',
        'risk.deviceWindowDays',
        'risk.minGames',
        'risk.predicate.sameDevice',
        'risk.predicate.sameIp',
        'risk.winRateThreshold',
        // 提现再认证片（第 48 键）
        'risk.withdrawReAuthEnabled',
        'robot.modelBySkill',
        'robot.reclaimIntervalMs',
        'robot.ruleFallback',
        'robot.skillDistribution',
        'room.autostartIntervalMs',
        'room.freeBotFillEnabled',
        'room.freeRoomEnabled',
        'room.friendRoomEnabled',
        'room.goldBotFillEnabled',
        'room.goldRoomEnabled',
        'room.matchNoBotMaxWaitMs',
        'room.matchScanIntervalMs',
        'room.reapIntervalMs',
        // 节奏/清理片 T2（第 35–40 键）
        'pay.scanIntervalMs',
        'pay.reconcileIntervalMs',
        'currency.reconcileIntervalMs',
        'risk.scanIntervalMs',
        'risk.devicesCleanupIntervalMs',
        'record.cleanupIntervalMs',
      ].sort(),
    );
    for (const [key, cell] of Object.entries(config)) {
      expect(Object.keys(cell).sort(), key).toEqual(['value', 'version']);
      expect(typeof cell.version, key).toBe('number');
    }
    expect(config['game.baseScoreLevels']!.value).toEqual(row(db, 'game.baseScoreLevels').value);
    // 金币场第 14 键：种子 10（本用例前面的 PUT 都未碰它）
    expect(config['currency.entryMultiplier']!.value).toBe(10);
    expect(res.body.data.version).toBe(Math.max(...Object.values(config).map((c) => c.version)));
  });
});

describe('PUT actor（§2.6）：fail-closed + 留痕接线', () => {
  let probe: HttpProbe;
  let db: ReturnType<typeof seedDb>;

  beforeAll(async () => {
    const a = makeService(seedDb());
    db = a.db;
    probe = await startHttpProbe(a.svc);
  });
  afterAll(async () => {
    await probe.close();
  });

  it('actor 头缺失/非法 ⇒ 401 + 10002「管理身份缺失」（不回退），值逐字未变、无留痕、未广播', async () => {
    const key = 'room.friendRoomEnabled';
    const before = { ...row(db, key) };

    const missing = await probe.putJson(
      `/api/admin/config/${key}`,
      { value: true },
      { [ADMIN_HEADER]: '1' },
    );
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: '管理身份缺失',
      data: null,
    });

    const invalid = await probe.putJson(
      `/api/admin/config/${key}`,
      { value: true },
      { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'Has Space' },
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body.message).toBe('管理身份缺失');

    expect(row(db, key)).toEqual(before); // 连锁定读都没发生（值/版本原样）
    expect(db.changes).toEqual([]);
  });

  it('成功 PUT ⇒ 留痕行 {key, oldValue=旧值, newValue=归一后值, actor}，且 updated_by = actor（同一次状态变化）', async () => {
    const key = 'room.friendRoomEnabled';

    const res = await probe.putJson(
      `/api/admin/config/${key}`,
      { value: true },
      { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'ops.user' },
    );

    expect(res.status).toBe(200);
    expect(db.changes).toEqual([
      { key, oldValue: false, newValue: true, actor: 'ops.user' }, // 旧值 = 种子 false
    ]);
    expect(row(db, key)).toMatchObject({ value: true, updatedBy: 'ops.user' });
  });
});
