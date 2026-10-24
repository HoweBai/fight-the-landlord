import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ADMIN_HEADER } from '../src/config/admin.controller';
import { ADMIN_ACTOR_HEADER } from '../src/admin/accounts.controller';
import { makeService, seedDb, startHttpProbe, type HttpProbe } from './helpers/config-probe';

/**
 * **C5 / C18 的判据本体**（规格 §2.2 的校验表 + §3 的 C5/C18 行）：
 *
 *  - parse 的非正输入**全覆盖**（比例缺档/为负/合计 0；档位表空/重值/非正/不含 15；未知模型名；
 *    周期 ≤0 或 >600000；开关非严格 boolean；未知键）⇒ **400 + 原因**，且**全库逐字未变**
 *    （「400 了却先落库」是最像正确答案的错实现 —— 每组用例都在写前写后比对**整张表**）；
 *  - **归一化落库**：PUT `robot.skillDistribution = {15,35,50}` ⇒ 200 且库里存
 *    `{0.15,0.35,0.5}`（§2.2：「写入时按合计归一化后落库」，'15,35,50' 合法）；
 *  - **C18**：档位表不含 15 ⇒ 400 不落库；含 15 ⇒ 200。
 *
 * 走真 Nest 管线 + 真 `PlatformConfigService`（校验发生在 `set()` 的第一行、任何库操作之前）。
 */

/** 管理读写的常用头（③ T4 起写面必带 actor——T5 网关上线后由网关注入）。 */
const AUTH = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'admin' };

/** 整张假库的可比对快照（行集顺序无关化；用于「全库未变」断言）。 */
function snapshotRows(db: ReturnType<typeof seedDb>): Record<string, unknown> {
  return Object.fromEntries(
    [...db.rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]),
  );
}

describe('C5：非法写入 ⇒ 400 + 原因、全库逐字未变（真管线）', () => {
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

  /** 每条：{key, value, reason} —— reason 是 parseConfigValue 的中文原因片段。 */
  const cases: Array<{ name: string; key: string; value: unknown; reason: RegExp }> = [
    {
      name: '比例缺档',
      key: 'game.doudizhu.robot.skillDistribution',
      value: { beginner: 1, intermediate: 1 },
      reason: /三键齐全/,
    },
    {
      name: '比例为负',
      key: 'game.doudizhu.robot.skillDistribution',
      value: { beginner: -1, intermediate: 1, advanced: 1 },
      reason: /非负/,
    },
    {
      name: '比例合计 = 0',
      key: 'game.doudizhu.robot.skillDistribution',
      value: { beginner: 0, intermediate: 0, advanced: 0 },
      reason: /合计/,
    },
    { name: '档位表空', key: 'game.levels.doudizhu', value: [], reason: /非空数组/ },
    {
      name: '档位重复',
      key: 'game.levels.doudizhu',
      value: [
        { name: '休闲场', baseScore: 15, entryFeePercent: 0 },
        { name: '又一场', baseScore: 15, entryFeePercent: 0 },
      ],
      reason: /唯一/,
    },
    {
      name: '档位非正',
      key: 'game.levels.doudizhu',
      value: [{ name: '零分场', baseScore: 0, entryFeePercent: 0 }],
      reason: /正整数/,
    },
    {
      name: 'D13：档位表旧形态（全部缺 entryFeePercent）⇒ 400 + 请硬刷新',
      key: 'game.levels.doudizhu',
      value: [{ name: '学习场', baseScore: 15 }],
      reason: /请硬刷新[\s\S]*0–100/,
    },
    {
      name: '旧费率键已删除 ⇒ 未知配置键',
      key: 'currency.entryFeePercents',
      value: [{ baseScore: 15, percent: 10 }],
      reason: /未知配置键/,
    },
    {
      name: '未知模型名',
      key: 'game.doudizhu.robot.modelBySkill',
      value: { beginner: 'gpt-5', intermediate: 'sl', advanced: 'sl' },
      reason: /可用模型名/,
    },
    { name: '周期 ≤ 0', key: 'room.reapIntervalMs', value: 0, reason: /0 < n ≤ 600000/ },
    { name: '周期 > 600000', key: 'room.reapIntervalMs', value: 600_001, reason: /0 < n ≤ 600000/ },
    { name: '周期非整数', key: 'room.matchScanIntervalMs', value: 1.5, reason: /整数毫秒/ },
    {
      name: '开关非严格 boolean（字符串不算）',
      key: 'game.doudizhu.friendRoomEnabled',
      value: 'true',
      reason: /boolean/,
    },
    { name: '旧键只读（room.friendRoomEnabled）', key: 'room.friendRoomEnabled', value: true, reason: /已废弃/ },
    { name: '旧键只读（game.baseScoreLevels）', key: 'game.baseScoreLevels', value: [{ name: 'X', baseScore: 15, entryFeePercent: 0 }], reason: /已废弃/ },
    { name: '旧键只读（robot.ruleFallback）', key: 'robot.ruleFallback', value: true, reason: /已废弃/ },
    { name: '未知键', key: 'nope.key', value: 1, reason: /未知配置键/ },
  ];

  for (const c of cases) {
    it(`PUT ${c.key} = ${c.name} ⇒ 400 + 原因「${c.reason.source}」且全库未变`, async () => {
      const before = snapshotRows(db);

      const res = await probe.putJson(`/api/admin/config/${encodeURIComponent(c.key)}`, { value: c.value }, AUTH);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrCode.BAD_PARAM);
      expect(res.body.message, '400 必须带 parseConfigValue 的**原因**（不是泛化文案）').toMatch(c.reason);
      // 判别力：值、version、updated_by 全部逐字未变 —— 没有任何一行被碰过
      expect(snapshotRows(db)).toEqual(before);
    });
  }
});

describe('C5 正半边 + C18 正半边：合法写入 ⇒ 200 且**归一化后**落库', () => {
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

  it('🔴 归一化落库：PUT {15,35,50} ⇒ 200，GET /api/admin/config 里存 0.15/0.35/0.5', async () => {
    const v0 = db.rows.get('game.doudizhu.robot.skillDistribution')!.version;

    const put = await probe.putJson(
      '/api/admin/config/game.doudizhu.robot.skillDistribution',
      { value: { beginner: 15, intermediate: 35, advanced: 50 } },
      AUTH,
    );

    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({ saved: true, announced: true, version: v0 + 1 });
    // 经管理读复核（不是直接看入参对象 —— 断言的是**落库形态**）
    const get = await probe.get('/api/admin/config', AUTH);
    expect(get.body.data.config['game.doudizhu.robot.skillDistribution']).toEqual({
      value: { beginner: 0.15, intermediate: 0.35, advanced: 0.5 },
      version: v0 + 1,
    });
  });

  it('归一化不是「原样存」：换一组份额（1/1/2）⇒ 存 0.25/0.25/0.5', async () => {
    const put = await probe.putJson(
      '/api/admin/config/game.doudizhu.robot.skillDistribution',
      { value: { beginner: 1, intermediate: 1, advanced: 2 } },
      AUTH,
    );

    expect(put.status).toBe(200);
    const get = await probe.get('/api/admin/config', AUTH);
    expect(get.body.data.config['game.doudizhu.robot.skillDistribution'].value).toEqual({
      beginner: 0.25,
      intermediate: 0.25,
      advanced: 0.5,
    });
  });

  it('档位表正半边：带 entryFeePercent ⇒ 200 且整表落库（含自定义名次与费率）', async () => {
    const levels = [
      { name: '学习场', baseScore: 15, entryFeePercent: 10 },
      { name: '高手场', baseScore: 2000, entryFeePercent: 0 },
    ];

    const put = await probe.putJson('/api/admin/config/game.levels.doudizhu', { value: levels }, AUTH);

    expect(put.status).toBe(200);
    const get = await probe.get('/api/admin/config', AUTH);
    expect(get.body.data.config['game.levels.doudizhu'].value).toEqual(levels);
  });
});
