import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CLIENT_CONFIG_KEYS, ErrCode } from '@fight-the-landlord/protocol';
import { makeService, seedDb, startHttpProbe } from './helpers/config-probe';

/**
 * `GET /api/config` —— 玩家客户端的配置子集（规格 §2.4 / C7 的单测半边）。
 *
 * 判据写死：`data` 的键集**恰好** `CLIENT_CONFIG_KEYS`（记牌器收费片起 = 二十键；「顺手把内部键暴露
 * 进子集」是最像正确答案的错实现）；`version` = **全局** MAX（每键 version 的最大值 —— 不是
 * 子集几键的 MAX，也不是 last-write）；值形状与客户端 `ClientConfig` 一致。
 *
 * ⚠️ 本端点**不吃** `X-Admin`（它是玩家面；管理 guard 只挂在 `/api/admin/*`）——
 * 用例显式断言这一点，防「把 guard 顺手加到整个服务上」。
 */

describe('GET /api/config（C7 半边）', () => {
  it('子集键集**恰好** CLIENT_CONFIG_KEYS（二十键）；200 + code 0', async () => {
    const probe = await startHttpProbe(makeService(seedDb()).svc);
    try {
      const res = await probe.get('/api/config');

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(ErrCode.OK);
      expect(Object.keys(res.body.data).sort()).toEqual([...CLIENT_CONFIG_KEYS].sort());
      expect([...CLIENT_CONFIG_KEYS].sort()).toEqual([
        'baseScoreLevels',
        'cardCounterEnabled',
        'cardCounterPricePerGameCoins',
        'cardCounterPricePerHourCoins',
        'coinPerYuan',
        'entryMultiplier',
        'freeRoomEnabled',
        'friendRoomEnabled',
        'games',
        'goldRoomEnabled',
        'rechargeEnabled',
        'rechargePackages',
        'reliefAdpid',
        'reliefEnabled',
        'version',
        'withdrawDailyMaxCoins',
        'withdrawEnabled',
        'withdrawMaxCoinsPerOrder',
        'withdrawMinCoins',
        'withdrawReAuthEnabled',
      ]);
    } finally {
      await probe.close();
    }
  });

  it('games：ddz 恒开/3 人/旧档位；pdk 开关与人数闸跟随配置，档位取新键', async () => {
    const { svc, db } = makeService(seedDb());
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(body.data.games).toEqual({
        doudizhu: {
          enabled: true,
          supportedPlayerCounts: [3],
          defaultPlayerCount: 3,
          baseScoreLevels: body.data.baseScoreLevels,
        },
        paodekuai: {
          enabled: false,
          supportedPlayerCounts: [3],
          defaultPlayerCount: 3,
          baseScoreLevels: [
            { name: '休闲场', baseScore: 15, entryFeePercent: 0 },
            { name: '标准场', baseScore: 80, entryFeePercent: 0 },
            { name: '竞技场', baseScore: 480, entryFeePercent: 0 },
            { name: '豪侠场', baseScore: 1200, entryFeePercent: 0 },
          ],
        },
      });

      // 打开玩法与 2/4 人闸 ⇒ supportedPlayerCounts 收窄/放开的唯一真源是配置
      db.rows.set('game.paodekuai.enabled', { value: true, version: 2, updatedAt: 'admin', updatedBy: 'admin' });
      db.rows.set('game.paodekuai.nonThreePlayerEnabled', {
        value: true,
        version: 2,
        updatedAt: 'admin',
        updatedBy: 'admin',
      });
      const { body: after } = await probe.get('/api/config');
      expect(after.data.games.paodekuai.enabled).toBe(true);
      expect(after.data.games.paodekuai.supportedPlayerCounts).toEqual([2, 3, 4]);
      // 旧字段仍是斗地主档位（不迁移、不双写）
      expect(after.data.baseScoreLevels).toEqual(body.data.baseScoreLevels);
    } finally {
      await probe.close();
    }
  });

  it('缺行兜底：game.cardCounterEnabled 行缺失 ⇒ 仍下发 true（与种子一致）', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.delete('game.cardCounterEnabled');
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(body.data.cardCounterEnabled).toBe(true);
    } finally {
      await probe.close();
    }
  });

  it('缺行兜底：两价格键行缺失 ⇒ 仍下发 10/100（与种子一致）', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.delete('game.cardCounterPricePerGameCoins');
    db.rows.delete('game.cardCounterPricePerHourCoins');
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(body.data.cardCounterPricePerGameCoins).toBe(10);
      expect(body.data.cardCounterPricePerHourCoins).toBe(100);
    } finally {
      await probe.close();
    }
  });

  it('ad.reliefAdpid 以 number 形态读出（真栈 TypeORM 双解析）⇒ 出站仍下发 string（uni-ad 契约）', async () => {
    // 真栈实测（2026-10-18 测试服）：JSON 列存的是**字符串**，但 TypeORM 对「形如数字的 JSON
    // 字符串」做二次 `JSON.parse` ⇒ `"1948867796"` 被读成 number 1948867796。协议
    // (`parseConfigValue`) 与 uni-ad (`adpid: string`) 都要求 string ⇒ 出站边界必须归一回字符串。
    // 假库直接放 number，模拟真栈读路径的形态（而不是模拟写入 —— 写入侧由 protocol 的严格类型拦）。
    const { svc, db } = makeService(seedDb());
    db.rows.set('ad.reliefAdpid', { value: 1948867796, version: 2, updatedAt: 'admin', updatedBy: 'admin' });
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(body.data.reliefAdpid).toBe('1948867796');
    } finally {
      await probe.close();
    }
  });

  it('逐键值：baseScoreLevels 逐字来自库（{name, baseScore}[]）、开关/比率/限额 = 种子逐字、version 是 number', async () => {
    const probe = await startHttpProbe(makeService(seedDb()).svc);
    try {
      const { body } = await probe.get('/api/config');

      expect(body.data.baseScoreLevels).toEqual([
        { name: '休闲场', baseScore: 15 },
        { name: '标准场', baseScore: 80 },
        { name: '竞技场', baseScore: 480 },
        { name: '豪侠场', baseScore: 1200 },
      ]);
      expect(body.data.friendRoomEnabled).toBe(false); // 裁决 8：默认关（fail-safe 方向）
      // 金币场四键 + 门槛倍率：种子逐字（§1.1）
      expect(body.data.freeRoomEnabled).toBe(true); // 免费场保持现状开
      expect(body.data.goldRoomEnabled).toBe(true); // 默认开（2026-10-04 用户裁决；原暗上线）
      expect(body.data.cardCounterEnabled).toBe(true); // 记牌器片：保持现状（后台可关）
      expect(body.data.cardCounterPricePerGameCoins).toBe(10); // 记牌器收费片：首发单局价
      expect(body.data.cardCounterPricePerHourCoins).toBe(100); // 记牌器收费片：首发包时价
      expect(body.data.reliefEnabled).toBe(false); // 救助默认关
      expect(body.data.entryMultiplier).toBe(10); // 门槛 = 底分 × 10
      // 支付七键：种子逐字（支付片 §2.5 第 26–32 键；⚙️11 裸名）
      expect(body.data.rechargeEnabled).toBe(false); // 暗上线
      expect(body.data.withdrawEnabled).toBe(false); // 暗上线
      expect(body.data.coinPerYuan).toBe(100); // 1 元 = 100 金币
      expect(body.data.rechargePackages).toEqual([6, 30, 68, 128, 328]); // 档位（元）
      expect(body.data.withdrawMinCoins).toBe(1000);
      expect(body.data.withdrawMaxCoinsPerOrder).toBe(50000);
      expect(body.data.withdrawDailyMaxCoins).toBe(100000);
      // 广告片：adpid 种子 = 空串（未配置 ⇒ 救助入口不渲染；string 种子首例）
      expect(body.data.reliefAdpid).toBe('');
      expect(typeof body.data.version).toBe('number');
    } finally {
      await probe.close();
    }
  });

  it('🔴 残留旧键行不泄漏：库里仍有旧键 ⇒ /api/config 仍二十键、无 entryFeePercents', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.set('currency.entryFeePercents', {
      value: [{ baseScore: 15, percent: 10 }],
      version: 2,
      updatedAt: 'admin',
      updatedBy: 'admin',
    });
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(Object.keys(body.data)).toHaveLength(20);
      expect('entryFeePercents' in body.data).toBe(false);
      // 档位表照常下发（残留旧键不影响玩家面）。
      expect(body.data.baseScoreLevels).toHaveLength(4);
    } finally {
      await probe.close();
    }
  });

  it('🔴 坏档位表（非数组/坏元素）⇒ baseScoreLevels []，且仍是 200（不 500）', async () => {
    for (const value of [{}, 'x', [{ name: 'X', baseScore: '15' }]]) {
      const { svc, db } = makeService(seedDb());
      db.rows.set('game.baseScoreLevels', {
        value,
        version: 2,
        updatedAt: 'admin',
        updatedBy: 'admin',
      });
      const probe = await startHttpProbe(svc);
      try {
        const res = await probe.get('/api/config');
        expect(res.status, `值 ${JSON.stringify(value)}`).toBe(200);
        expect(res.body.data.baseScoreLevels).toEqual([]);
      } finally {
        await probe.close();
      }
    }
  });

  it('version = **全局** MAX（非子集键的 version 也要算进来 —— 判别「只对子集取 MAX」的错实现）', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.get('robot.reclaimIntervalMs')!.version = 9; // 非子集键，最高
    db.rows.get('game.baseScoreLevels')!.version = 2;
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');

      expect(body.data.version).toBe(9);
    } finally {
      await probe.close();
    }
  });

  it('不泄漏内部键：出站 JSON 里没有任何六十五键键名（外层的恰好二十键 + 值域检查）', async () => {
    const probe = await startHttpProbe(makeService(seedDb()).svc);
    try {
      const text = JSON.stringify((await probe.get('/api/config')).body);

      for (const internalKey of [
        'robot.',
        'room.matchScan',
        'room.autostart',
        'room.reap',
        'ruleFallback',
        'skillDistribution',
        'modelBySkill',
        'record.',
        'currency.',
        'risk.',
        'pay.',
        'ad.',
      ]) {
        expect(text, internalKey).not.toContain(internalKey);
      }
    } finally {
      await probe.close();
    }
  });

  it('不吃 X-Admin：玩家面不带管理头照常 200（guard 只挂 /api/admin/*）', async () => {
    const probe = await startHttpProbe(makeService(seedDb()).svc);
    try {
      expect((await probe.get('/api/config')).status).toBe(200);
    } finally {
      await probe.close();
    }
  });

  it('每次查库、不缓存：连续两次请求 ⇒ 假库被查两次（「改了要重启」的错实现会红）', async () => {
    const { svc, repo } = makeService(seedDb());
    const probe = await startHttpProbe(svc);
    try {
      await probe.get('/api/config');
      await probe.get('/api/config');

      expect(repo.find).toHaveBeenCalledTimes(2);
    } finally {
      await probe.close();
    }
  });

  it('缺行兜底 = 形状恒二十键 + 与种子一致的默认（空表 / 逐键见断言）—— 行缺失不得改子集形状', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.delete('game.baseScoreLevels');
    db.rows.delete('room.friendRoomEnabled');
    // 金币场六键全删 ⇒ 兜底方向逐键（§2.4 缺键语义落到服务端兜底）
    db.rows.delete('room.freeRoomEnabled');
    db.rows.delete('room.goldRoomEnabled');
    db.rows.delete('currency.reliefEnabled');
    db.rows.delete('currency.entryMultiplier');
    // 支付七键全删 ⇒ 兜底方向逐键（钱面 fail-safe：开关说不清就不开、档位不凭空造）
    db.rows.delete('pay.rechargeEnabled');
    db.rows.delete('pay.withdrawEnabled');
    db.rows.delete('pay.coinPerYuan');
    db.rows.delete('pay.rechargePackages');
    db.rows.delete('pay.withdrawMinCoins');
    db.rows.delete('pay.withdrawMaxCoinsPerOrder');
    db.rows.delete('pay.withdrawDailyMaxCoins');
    // 广告片第 41 键删除 ⇒ 兜底方向 fail 方向空串（未配置 ⇒ 不渲染入口）
    db.rows.delete('ad.reliefAdpid');
    const probe = await startHttpProbe(svc);
    try {
      const { status, body } = await probe.get('/api/config');

      expect(status).toBe(200);
      expect(Object.keys(body.data).sort()).toEqual([...CLIENT_CONFIG_KEYS].sort());
      expect(body.data.baseScoreLevels).toEqual([]); // 既有空表语义
      expect(body.data.friendRoomEnabled).toBe(false); // fail-safe：未知 ⇒ 关
      expect(body.data.freeRoomEnabled).toBe(true); // 与种子一致：免费场保持现状开
      expect(body.data.goldRoomEnabled).toBe(true); // 与种子一致：默认开（原「说不清就不开」经 2026-10-04 裁决翻转）
      expect(body.data.reliefEnabled).toBe(false); // 说不清就不开
      expect(body.data.entryMultiplier).toBe(10); // 与种子一致：门槛提示退回初始倍率
      expect(body.data.rechargeEnabled).toBe(false); // 说不清就不开（钱面 fail-safe）
      expect(body.data.withdrawEnabled).toBe(false); // 说不清就不开（钱面 fail-safe）
      expect(body.data.coinPerYuan).toBe(100); // 与种子一致
      expect(body.data.rechargePackages).toEqual([]); // 空档位（与 baseScoreLevels 空表同向：钱的事不凭空造档位）
      expect(body.data.withdrawMinCoins).toBe(1000); // 与种子一致
      expect(body.data.withdrawMaxCoinsPerOrder).toBe(50000); // 与种子一致
      expect(body.data.withdrawDailyMaxCoins).toBe(100000); // 与种子一致
      expect(body.data.reliefAdpid).toBe(''); // fail 方向空串（未配置 ⇒ 救助入口不渲染）
    } finally {
      await probe.close();
    }
  });
});
