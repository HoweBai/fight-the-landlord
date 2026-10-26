import { describe, expect, it } from 'vitest';
import {
  CLIENT_CONFIG_KEYS,
  CONFIG_KEYS,
  LEGACY_CONFIG_KEYS,
  entryFeeOf,
  entryFeeOfLevel,
  entryFeePercentsFromLevels,
  isLegacyConfigKey,
  parseConfigValue,
  type ConfigKey,
} from './config';
import { ProtocolError } from './validate';

describe('完整键清单与客户端子集', () => {
  it('既有键 + 跑得快风控两键；客户端子集暂不变', () => {
    expect(CONFIG_KEYS).toEqual([
      'robot.skillDistribution', 'robot.ruleFallback', 'robot.modelBySkill',
      'robot.reclaimIntervalMs', 'room.matchScanIntervalMs',
      'room.autostartIntervalMs', 'room.reapIntervalMs',
      'room.friendRoomEnabled', 'game.baseScoreLevels', 'record.retentionDays',
      'currency.signupGrant',
      'room.freeRoomEnabled', 'room.goldRoomEnabled',
      'currency.entryMultiplier', 'currency.rakePercent',
      'currency.reliefEnabled', 'currency.reliefAmount',
      'risk.predicate.sameDevice', 'risk.predicate.sameIp',
      'risk.winRateThreshold', 'risk.minGames', 'risk.deviceLimit',
      'risk.deviceWindowDays', 'risk.autoThrottle', 'risk.deviceRetentionDays',
      // 支付片 T5（第 26–34 键；§2.5 九键逐字表）
      'pay.rechargeEnabled', 'pay.withdrawEnabled', 'pay.coinPerYuan',
      'pay.rechargePackages', 'pay.withdrawMinCoins',
      'pay.withdrawMaxCoinsPerOrder', 'pay.withdrawDailyMaxCoins',
      'pay.orderExpireMinutes', 'pay.withdrawTimeoutMinutes',
      /** 节奏/清理旋钮六键（第 35–40 键；本片）。 */
      'pay.scanIntervalMs',
      'pay.reconcileIntervalMs',
      'currency.reconcileIntervalMs',
      'risk.scanIntervalMs',
      'risk.devicesCleanupIntervalMs',
      'record.cleanupIntervalMs',
      'ad.reliefAdpid',
      'client.appEnabled',
      'client.h5Enabled',
      // 机器人补位开关片（第 45–47 键；纯服务端，不进 CLIENT_CONFIG_KEYS）
      'room.freeBotFillEnabled',
      'room.goldBotFillEnabled',
      'room.matchNoBotMaxWaitMs',
      // 提现再认证片（第 48 键；纯服务端闸，不进 CLIENT_CONFIG_KEYS）
      'risk.withdrawReAuthEnabled',
      // 设备绑定片（第 49 键；服务端私有，不在客户端子集）
      'risk.deviceBindingEnabled',
      // 记牌器片（第 50 键；客户端可见——裸名 `cardCounterEnabled`）
      'game.cardCounterEnabled',
      // 记牌器收费片（第 51/52 键；客户端可见——裸名两价格）
      'game.cardCounterPricePerGameCoins',
      'game.cardCounterPricePerHourCoins',
      // 多玩法片（跑得快 15 键；斗地主档位继续用旧 game.baseScoreLevels）
      'game.levels.paodekuai',
      'game.paodekuai.enabled',
      'game.paodekuai.twoPlayerEnabled',
      'game.paodekuai.nonThreePlayerEnabled',
      'game.paodekuai.bareTrioEnabled',
      'game.paodekuai.trioWithPairEnabled',
      'game.paodekuai.bareAirplaneEnabled',
      'game.paodekuai.fourWithTwoEnabled',
      'game.paodekuai.fourWithTwoPairKickerAllowed',
      'game.paodekuai.airplaneWings',
      'game.paodekuai.bombMultiplierEnabled',
      'game.paodekuai.guanMultiplierEnabled',
      'game.paodekuai.springMultiplierEnabled',
      'game.paodekuai.multiplierCap',
      'game.paodekuai.baobenEnabled',
      'game.doudizhu.enabled',
      // 配置平行化（2026-10-24）：24 新键
      'game.doudizhu.freeRoomEnabled',
      'game.doudizhu.goldRoomEnabled',
      'game.doudizhu.friendRoomEnabled',
      'game.doudizhu.freeBotFillEnabled',
      'game.doudizhu.goldBotFillEnabled',
      'game.doudizhu.rakePercent',
      'game.doudizhu.entryMultiplier',
      'game.levels.doudizhu',
      'game.doudizhu.cardCounterEnabled',
      'game.doudizhu.cardCounterPricePerGameCoins',
      'game.doudizhu.cardCounterPricePerHourCoins',
      'game.doudizhu.robot.skillDistribution',
      'game.doudizhu.robot.ruleFallback',
      'game.doudizhu.robot.modelBySkill',
      'game.doudizhu.risk.winRateThreshold',
      'game.doudizhu.risk.minGames',
      'game.paodekuai.freeRoomEnabled',
      'game.paodekuai.goldRoomEnabled',
      'game.paodekuai.friendRoomEnabled',
      'game.paodekuai.freeBotFillEnabled',
      'game.paodekuai.goldBotFillEnabled',
      'game.paodekuai.rakePercent',
      'game.paodekuai.entryMultiplier',
      // 跑得快风控（2026-10-25）：两玩法独立阈值
      'game.paodekuai.risk.winRateThreshold',
      'game.paodekuai.risk.minGames',
      // 跑得快风控按人数 + 自动限流（2026-10-26；旧两键为回退键）
      'game.paodekuai.risk.player2.winRateThreshold',
      'game.paodekuai.risk.player2.minGames',
      'game.paodekuai.risk.player3.winRateThreshold',
      'game.paodekuai.risk.player3.minGames',
      'game.paodekuai.risk.player4.winRateThreshold',
      'game.paodekuai.risk.player4.minGames',
      'game.paodekuai.risk.autoThrottleScore',
      'currency.reliefThresholdCoins',
      // 代理分润（2026-10-26）：客户端邀请码开关（裸名 agentInviteEnabled）
      'agent.inviteEnabled',
    ]);
    expect(CLIENT_CONFIG_KEYS).toEqual([
      'baseScoreLevels', 'friendRoomEnabled', 'freeRoomEnabled', 'goldRoomEnabled',
      'reliefEnabled', 'entryMultiplier',
      // 支付片 T5（⚙️11 七裸名；钱包页消费）
      'rechargeEnabled', 'withdrawEnabled', 'coinPerYuan', 'rechargePackages',
      'withdrawMinCoins', 'withdrawMaxCoinsPerOrder', 'withdrawDailyMaxCoins',
      'withdrawReAuthEnabled',
      'reliefAdpid',
      // 记牌器片（第 50 键裸名；客户端据此渲染左上角入口）
      'cardCounterEnabled',
      // 记牌器收费片（第 51/52 键裸名；开始游戏页购买面板）
      'cardCounterPricePerGameCoins',
      'cardCounterPricePerHourCoins',
      // 多玩法（Task 5.1）：按玩法配置（新客户端据此渲染玩法卡/档位；旧客户端忽略）
      'games',
      'reliefThresholdCoins',
      'version',
      // 代理分润：邀请码输入框门控（缺键/旧服务端 ⇒ false）
      'agentInviteEnabled',
    ]);
  });

  it('平行化：旧键恰 16 个、均仍在 CONFIG_KEYS；isLegacyConfigKey 只认旧键', () => {
    expect(LEGACY_CONFIG_KEYS).toEqual([
      'room.freeRoomEnabled',
      'room.goldRoomEnabled',
      'room.friendRoomEnabled',
      'room.freeBotFillEnabled',
      'room.goldBotFillEnabled',
      'currency.rakePercent',
      'currency.entryMultiplier',
      'game.baseScoreLevels',
      'game.cardCounterEnabled',
      'game.cardCounterPricePerGameCoins',
      'game.cardCounterPricePerHourCoins',
      'robot.skillDistribution',
      'robot.ruleFallback',
      'robot.modelBySkill',
      'risk.winRateThreshold',
      'risk.minGames',
    ]);
    for (const key of LEGACY_CONFIG_KEYS) {
      expect(CONFIG_KEYS).toContain(key);
      expect(isLegacyConfigKey(key)).toBe(true);
    }
    expect(isLegacyConfigKey('game.doudizhu.freeRoomEnabled')).toBe(false);
    expect(isLegacyConfigKey('game.paodekuai.freeRoomEnabled')).toBe(false);
    expect(isLegacyConfigKey('unknown.key')).toBe(false);
  });
});

describe('parseConfigValue', () => {
  it('skillDistribution：三键齐全、各 ≥0、合计>0 ⇒ 归一化落库（15/35/50 ⇒ 0.15/0.35/0.5）', () => {
    expect(parseConfigValue('robot.skillDistribution', { beginner: 15, intermediate: 35, advanced: 50 }))
      .toEqual({ beginner: 0.15, intermediate: 0.35, advanced: 0.5 });
  });
  it('skillDistribution：缺档 / 为负 / 合计=0 ⇒ 抛（中文原因）', () => {
    expect(() => parseConfigValue('robot.skillDistribution', { beginner: 1, intermediate: 1 })).toThrow(/三键齐全/);
    expect(() => parseConfigValue('robot.skillDistribution', { beginner: -1, intermediate: 1, advanced: 1 })).toThrow(/非负|≥/);
    expect(() => parseConfigValue('robot.skillDistribution', { beginner: 0, intermediate: 0, advanced: 0 })).toThrow(/合计/);
  });
  it('ruleFallback / friendRoomEnabled：严格 boolean', () => {
    expect(parseConfigValue('robot.ruleFallback', true)).toBe(true);
    expect(() => parseConfigValue('robot.ruleFallback', 'true')).toThrow(/boolean/);
  });
  it('第 50 键 game.cardCounterEnabled：严格 boolean（拒字符串/数字）', () => {
    expect(parseConfigValue('game.cardCounterEnabled', true)).toBe(true);
    expect(parseConfigValue('game.cardCounterEnabled', false)).toBe(false);
    expect(() => parseConfigValue('game.cardCounterEnabled', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('game.cardCounterEnabled', 1)).toThrow(/boolean/);
  });
  it('代理第 101 键 agent.inviteEnabled：严格 boolean（拒字符串/数字）', () => {
    expect(parseConfigValue('agent.inviteEnabled', true)).toBe(true);
    expect(parseConfigValue('agent.inviteEnabled', false)).toBe(false);
    expect(() => parseConfigValue('agent.inviteEnabled', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('agent.inviteEnabled', 1)).toThrow(/boolean/);
  });
  it('modelBySkill：三键齐全且值 ∈ 三档模型名', () => {
    expect(parseConfigValue('robot.modelBySkill', { beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' }))
      .toEqual({ beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' });
    expect(() => parseConfigValue('robot.modelBySkill', { beginner: 'gpt', intermediate: 'sl', advanced: 'sl' })).toThrow(/模型名/);
  });
  it('四个周期：整数、0 < n ≤ 600000', () => {
    for (const k of ['robot.reclaimIntervalMs', 'room.matchScanIntervalMs', 'room.autostartIntervalMs', 'room.reapIntervalMs'] as const) {
      expect(parseConfigValue(k, 5000)).toBe(5000);
      expect(() => parseConfigValue(k, 0)).toThrow();
      expect(() => parseConfigValue(k, 600001)).toThrow();
      expect(() => parseConfigValue(k, 1.5)).toThrow();
    }
  });
  it('🔴 baseScoreLevels：非空、名字非空、正整数、唯一（不再要求含缺省档）', () => {
    const ok = [{ name: '休闲场', baseScore: 15 }, { name: '标准场', baseScore: 80 }];
    expect(parseConfigValue('game.baseScoreLevels', ok)).toEqual(ok);
    // 2026-10-21：缺省底分改为「表内最低档」⇒ 表不必再包含 15。
    const without15 = [{ name: '标准场', baseScore: 80 }];
    expect(parseConfigValue('game.baseScoreLevels', without15)).toEqual(without15);
    expect(() => parseConfigValue('game.baseScoreLevels', [])).toThrow(/非空/);
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: 'X', baseScore: 0 }])).toThrow(); // 非正（C5 的「非正」输入）
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: 'A', baseScore: 15 }, { name: 'B', baseScore: 15 }])).toThrow(/唯一/);
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: '', baseScore: 15 }])).toThrow(/名字/);
  });
  it('🔴 baseScoreLevels.entryFeePercent：可选、0..100 整数、round-trip 保留字段', () => {
    const withFee = [{ name: '休闲场', baseScore: 15, entryFeePercent: 10 }];
    expect(parseConfigValue('game.baseScoreLevels', withFee)).toStrictEqual(withFee);
    // 缺省合法，且结果**不含** undefined 的自有属性（JSON 落库会丢，不能用 toEqual 蒙混）
    const withoutFee = [{ name: '休闲场', baseScore: 15 }];
    const parsed = parseConfigValue('game.baseScoreLevels', withoutFee) as Array<
      Record<string, unknown>
    >;
    expect(parsed).toStrictEqual(withoutFee);
    expect('entryFeePercent' in parsed[0]!).toBe(false);
    for (const value of [0, 100]) {
      const input = [{ name: 'X', baseScore: 15, entryFeePercent: value }];
      expect(parseConfigValue('game.baseScoreLevels', input)).toStrictEqual(input);
    }
    for (const value of [-1, 101, 1.5, '10', null]) {
      expect(
        () => parseConfigValue('game.baseScoreLevels', [{ name: 'X', baseScore: 15, entryFeePercent: value }]),
        `entryFeePercent=${JSON.stringify(value)} 必须拒绝`,
      ).toThrow(/0 ≤ n ≤ 100 的整数/);
    }
  });
  it('entryFeePercentsFromLevels：缺省 0、显式保留、顺序不变、空表 []', () => {
    expect(
      entryFeePercentsFromLevels([
        { name: '休闲场', baseScore: 15, entryFeePercent: 10 },
        { name: '标准场', baseScore: 80 },
      ]),
    ).toEqual([
      { baseScore: 15, percent: 10 },
      { baseScore: 80, percent: 0 },
    ]);
    expect(entryFeePercentsFromLevels([])).toEqual([]);
  });
  it('entryFeeOfLevel：单档 ⇒ entryFeeOf 同值（10%⇒1、100%⇒底分、缺省/0⇒0）', () => {
    expect(entryFeeOfLevel({ name: '休闲场', baseScore: 15, entryFeePercent: 10 })).toBe(1);
    expect(entryFeeOfLevel({ name: '休闲场', baseScore: 15, entryFeePercent: 100 })).toBe(15);
    expect(entryFeeOfLevel({ name: '标准场', baseScore: 80 })).toBe(0);
    expect(entryFeeOfLevel({ name: '标准场', baseScore: 80, entryFeePercent: 0 })).toBe(0);
  });
  it('记录片第 10 键 record.retentionDays：整数、1 ≤ n ≤ 3650（种子 365）', () => {
    expect(parseConfigValue('record.retentionDays', 365)).toBe(365);
    expect(parseConfigValue('record.retentionDays', 1)).toBe(1);
    expect(parseConfigValue('record.retentionDays', 3650)).toBe(3650);
    expect(() => parseConfigValue('record.retentionDays', 0)).toThrow(/3650/);
    expect(() => parseConfigValue('record.retentionDays', 3651)).toThrow(/3650/);
    expect(() => parseConfigValue('record.retentionDays', 1.5)).toThrow(/整数/);
    expect(() => parseConfigValue('record.retentionDays', '365')).toThrow(/整数/);
  });
  it('货币核心第 11 键 currency.signupGrant：整数、0 ≤ n ≤ 1,000,000（种子 0）', () => {
    expect(parseConfigValue('currency.signupGrant', 0)).toBe(0);
    expect(parseConfigValue('currency.signupGrant', 100)).toBe(100);
    expect(parseConfigValue('currency.signupGrant', 1_000_000)).toBe(1_000_000);
    expect(() => parseConfigValue('currency.signupGrant', -1)).toThrow(/1000000/);
    expect(() => parseConfigValue('currency.signupGrant', 1_000_001)).toThrow(/1000000/);
    expect(() => parseConfigValue('currency.signupGrant', 1.5)).toThrow(/整数/);
    expect(() => parseConfigValue('currency.signupGrant', '100')).toThrow(/整数/);
  });
  it('②金币场第 12–17 键边界：free/gold/reliefEnabled 严格 boolean；entryMultiplier 1..100；rakePercent 0..50；reliefAmount 1..1000000', () => {
    expect(parseConfigValue('room.freeRoomEnabled', true)).toBe(true);
    expect(() => parseConfigValue('room.freeRoomEnabled', 'true')).toThrow(/boolean/);
    expect(parseConfigValue('room.goldRoomEnabled', false)).toBe(false);
    expect(() => parseConfigValue('room.goldRoomEnabled', 1)).toThrow(/boolean/);

    expect(parseConfigValue('currency.entryMultiplier', 1)).toBe(1);
    expect(parseConfigValue('currency.entryMultiplier', 100)).toBe(100);
    expect(() => parseConfigValue('currency.entryMultiplier', 0)).toThrow(/1 ≤ n ≤ 100/);
    expect(() => parseConfigValue('currency.entryMultiplier', 101)).toThrow(/1 ≤ n ≤ 100/);
    expect(() => parseConfigValue('currency.entryMultiplier', 1.5)).toThrow(/整数/);
    expect(() => parseConfigValue('currency.entryMultiplier', '10')).toThrow(/整数/);

    expect(parseConfigValue('currency.rakePercent', 0)).toBe(0);
    expect(parseConfigValue('currency.rakePercent', 50)).toBe(50);
    expect(() => parseConfigValue('currency.rakePercent', -1)).toThrow(/0 ≤ n ≤ 50/);
    expect(() => parseConfigValue('currency.rakePercent', 51)).toThrow(/0 ≤ n ≤ 50/);

    expect(parseConfigValue('currency.reliefEnabled', false)).toBe(false);
    expect(() => parseConfigValue('currency.reliefEnabled', 'false')).toThrow(/boolean/);
    expect(parseConfigValue('currency.reliefAmount', 1)).toBe(1);
    expect(parseConfigValue('currency.reliefAmount', 1_000_000)).toBe(1_000_000);
    expect(() => parseConfigValue('currency.reliefAmount', 0)).toThrow(/1 ≤ n ≤ 1000000/);
    expect(() => parseConfigValue('currency.reliefAmount', 1_000_001)).toThrow(/1 ≤ n ≤ 1000000/);
    expect(() => parseConfigValue('currency.reliefAmount', 1.5)).toThrow(/整数金币/);
  });

  it('C3 金标向量：entryFeeOf（未命中⇒0；(15,10)⇒1；(80,5)⇒4；(480,12)⇒57；percent=0⇒0 无保底；(8191,50)⇒4095；(15,100)⇒15；(8191,100)⇒8191；floor 截断）', () => {
    const t = (baseScore: number, percent: number) => [{ baseScore, percent }];
    expect(entryFeeOf(99, t(15, 10))).toBe(0); // 未命中 ⇒ 0
    expect(entryFeeOf(15, t(15, 10))).toBe(1); // floor(1.5) = 1 → max(1, 1)
    expect(entryFeeOf(80, t(80, 5))).toBe(4); // 恰整除
    expect(entryFeeOf(480, t(480, 12))).toBe(57); // floor(57.6) = 57（截断）
    expect(entryFeeOf(15, t(15, 0))).toBe(0); // percent=0 ⇒ 0（**无保底**）
    expect(entryFeeOf(8191, t(8191, 50))).toBe(4095); // floor(4095.5) = 4095（旧上界）
    expect(entryFeeOf(15, t(15, 100))).toBe(15); // floor(15) = 15（100% = 入场费等于底分）
    expect(entryFeeOf(8191, t(8191, 100))).toBe(8191); // floor(8191) = 8191（新算术上界）
    expect(entryFeeOf(80, t(80, 3))).toBe(2); // floor(2.4) = 2
    expect(entryFeeOf(1, t(1, 50))).toBe(1); // max(1, 0) = 1（baseScore=1 的保底支）
    expect(entryFeeOf(15, [])).toBe(0); // 空表
  });
  it('C24：底分单档上限 8191 —— 8191 可过、8192 拒（金币金额列 int 的容量上界）', () => {
    const ok = [{ name: '大场', baseScore: 8191 }, { name: '休闲场', baseScore: 15 }];
    expect(parseConfigValue('game.baseScoreLevels', ok)).toEqual(ok);
    expect(() =>
      parseConfigValue('game.baseScoreLevels', [{ name: '超大场', baseScore: 8192 }, { name: '休闲场', baseScore: 15 }]),
    ).toThrow(/1\.\.8191/);
    expect(() =>
      parseConfigValue('game.baseScoreLevels', [{ name: '超大场', baseScore: 8192 }, { name: '休闲场', baseScore: 15 }]),
    ).toThrow(/容量上界/);
  });
  it('风控第 18–19 与 24 键：sameDevice/sameIp/autoThrottle = 严格 boolean（拒字符串 \'true\'）', () => {
    expect(parseConfigValue('risk.predicate.sameDevice', false)).toBe(false);
    expect(parseConfigValue('risk.predicate.sameIp', true)).toBe(true);
    expect(parseConfigValue('risk.autoThrottle', true)).toBe(true);
    expect(() => parseConfigValue('risk.predicate.sameDevice', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('risk.predicate.sameIp', 1)).toThrow(/boolean/);
    expect(() => parseConfigValue('risk.autoThrottle', 'false')).toThrow(/boolean/);
  });
  it('设备绑定第 43 键 risk.deviceBindingEnabled：严格 boolean（拒字符串/数字）', () => {
    expect(parseConfigValue('risk.deviceBindingEnabled', false)).toBe(false);
    expect(parseConfigValue('risk.deviceBindingEnabled', true)).toBe(true);
    expect(() => parseConfigValue('risk.deviceBindingEnabled', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('risk.deviceBindingEnabled', 0)).toThrow(/boolean/);
  });
  it('风控第 20 键 risk.winRateThreshold：number 且 0.5 ≤ n ≤ 1.0 且最多两位小数', () => {
    expect(parseConfigValue('risk.winRateThreshold', 0.8)).toBe(0.8);
    expect(parseConfigValue('risk.winRateThreshold', 0.5)).toBe(0.5); // 下界
    expect(parseConfigValue('risk.winRateThreshold', 1)).toBe(1); // 上界（1.0）
    expect(parseConfigValue('risk.winRateThreshold', 0.79)).toBe(0.79); // 两位小数、域内 ⇒ 过（规格 §2.1-3：0.5 ≤ n ≤ 1.0）
    expect(() => parseConfigValue('risk.winRateThreshold', 0.785)).toThrow(/两位小数/); // 三位小数 ⇒ 拒
    expect(() => parseConfigValue('risk.winRateThreshold', 0.49)).toThrow(/0\.5 ≤ n ≤ 1/);
    expect(() => parseConfigValue('risk.winRateThreshold', 1.01)).toThrow(/0\.5 ≤ n ≤ 1/);
    expect(() => parseConfigValue('risk.winRateThreshold', '0.8')).toThrow(/必须/);
  });
  it('风控第 21 键 risk.minGames：整数且 1 ≤ n ≤ 100000', () => {
    expect(parseConfigValue('risk.minGames', 1)).toBe(1);
    expect(parseConfigValue('risk.minGames', 100000)).toBe(100000);
    expect(() => parseConfigValue('risk.minGames', 0)).toThrow(/1 ≤ n ≤ 100000/);
    expect(() => parseConfigValue('risk.minGames', 100001)).toThrow(/1 ≤ n ≤ 100000/);
    expect(() => parseConfigValue('risk.minGames', 1.5)).toThrow(/整数/);
  });
  it('风控第 22 键 risk.deviceLimit：整数且 2 ≤ n ≤ 100', () => {
    expect(parseConfigValue('risk.deviceLimit', 2)).toBe(2);
    expect(parseConfigValue('risk.deviceLimit', 100)).toBe(100);
    expect(() => parseConfigValue('risk.deviceLimit', 1)).toThrow(/2 ≤ n ≤ 100/);
    expect(() => parseConfigValue('risk.deviceLimit', 101)).toThrow(/2 ≤ n ≤ 100/);
    expect(() => parseConfigValue('risk.deviceLimit', '3')).toThrow(/整数/);
  });
  it('风控第 23 键 risk.deviceWindowDays：整数且 1 ≤ n ≤ 365', () => {
    expect(parseConfigValue('risk.deviceWindowDays', 1)).toBe(1);
    expect(parseConfigValue('risk.deviceWindowDays', 365)).toBe(365);
    expect(() => parseConfigValue('risk.deviceWindowDays', 0)).toThrow(/1 ≤ n ≤ 365/);
    expect(() => parseConfigValue('risk.deviceWindowDays', 366)).toThrow(/1 ≤ n ≤ 365/);
  });
  it('风控第 25 键 risk.deviceRetentionDays：整数且 1 ≤ n ≤ 3650（种子 365）', () => {
    expect(parseConfigValue('risk.deviceRetentionDays', 1)).toBe(1);
    expect(parseConfigValue('risk.deviceRetentionDays', 3650)).toBe(3650);
    expect(() => parseConfigValue('risk.deviceRetentionDays', 0)).toThrow(/1 ≤ n ≤ 3650/);
    expect(() => parseConfigValue('risk.deviceRetentionDays', 3651)).toThrow(/1 ≤ n ≤ 3650/);
    expect(() => parseConfigValue('risk.deviceRetentionDays', 1.5)).toThrow(/整数/);
  });
  it('支付片第 26–27 键：rechargeEnabled/withdrawEnabled = 严格 boolean（拒字符串 \'false\'；种子 false=暗上线）', () => {
    expect(parseConfigValue('pay.rechargeEnabled', false)).toBe(false);
    expect(parseConfigValue('pay.withdrawEnabled', true)).toBe(true);
    expect(() => parseConfigValue('pay.rechargeEnabled', 'false')).toThrow(/boolean/);
    expect(() => parseConfigValue('pay.withdrawEnabled', 1)).toThrow(/boolean/);
  });
  it('支付片第 28 键 pay.coinPerYuan：整数、1 ≤ n ≤ 1,000,000（种子 100）', () => {
    expect(parseConfigValue('pay.coinPerYuan', 100)).toBe(100);
    expect(parseConfigValue('pay.coinPerYuan', 1)).toBe(1);
    expect(parseConfigValue('pay.coinPerYuan', 1_000_000)).toBe(1_000_000);
    expect(() => parseConfigValue('pay.coinPerYuan', 0)).toThrow(/1 ≤ n ≤ 1000000/);
    expect(() => parseConfigValue('pay.coinPerYuan', 1_000_001)).toThrow(/1 ≤ n ≤ 1000000/);
    expect(() => parseConfigValue('pay.coinPerYuan', 1.5)).toThrow(/整数/);
    expect(() => parseConfigValue('pay.coinPerYuan', '100')).toThrow(/整数/);
  });
  it('支付片第 29 键 pay.rechargePackages：非空、正整数（元）、唯一、每项 ≤ 9,999,999（种子 [6,30,68,128,328]）', () => {
    const ok = [6, 30, 68, 128, 328];
    expect(parseConfigValue('pay.rechargePackages', ok)).toEqual(ok);
    expect(parseConfigValue('pay.rechargePackages', [9_999_999])).toEqual([9_999_999]); // 上界
    expect(() => parseConfigValue('pay.rechargePackages', [])).toThrow(/非空/);
    expect(() => parseConfigValue('pay.rechargePackages', '6,30')).toThrow(/非空/);
    expect(() => parseConfigValue('pay.rechargePackages', [0])).toThrow(/正整数/);
    expect(() => parseConfigValue('pay.rechargePackages', [6.5])).toThrow(/正整数/);
    expect(() => parseConfigValue('pay.rechargePackages', ['6' as never])).toThrow(/正整数/);
    expect(() => parseConfigValue('pay.rechargePackages', [10_000_000])).toThrow(/9999999/);
    expect(() => parseConfigValue('pay.rechargePackages', [6, 6])).toThrow(/唯一/);
  });
  it('支付片第 30–32 键：withdrawMinCoins / withdrawMaxCoinsPerOrder / withdrawDailyMaxCoins 整数且 1 ≤ n ≤ 1,000,000', () => {
    for (const k of [
      'pay.withdrawMinCoins',
      'pay.withdrawMaxCoinsPerOrder',
      'pay.withdrawDailyMaxCoins',
    ] as const) {
      expect(parseConfigValue(k, 1)).toBe(1);
      expect(parseConfigValue(k, 1_000_000)).toBe(1_000_000);
      expect(() => parseConfigValue(k, 0)).toThrow(/1 ≤ n ≤ 1000000/);
      expect(() => parseConfigValue(k, 1_000_001)).toThrow(/1 ≤ n ≤ 1000000/);
      expect(() => parseConfigValue(k, 1.5)).toThrow(/整数/);
    }
    // 种子逐字（§2.5 表）：门槛 1000 / 单笔 50000 / 单日 100000
    expect(parseConfigValue('pay.withdrawMinCoins', 1000)).toBe(1000);
    expect(parseConfigValue('pay.withdrawMaxCoinsPerOrder', 50000)).toBe(50000);
    expect(parseConfigValue('pay.withdrawDailyMaxCoins', 100000)).toBe(100000);
  });
  it('支付片第 33–34 键：orderExpireMinutes / withdrawTimeoutMinutes 整数且 1 ≤ n ≤ 10080（种子 30 / 4320；测试注入用 1）', () => {
    expect(parseConfigValue('pay.orderExpireMinutes', 30)).toBe(30);
    expect(parseConfigValue('pay.orderExpireMinutes', 1)).toBe(1);
    expect(parseConfigValue('pay.withdrawTimeoutMinutes', 4320)).toBe(4320);
    expect(parseConfigValue('pay.withdrawTimeoutMinutes', 1)).toBe(1); // 规格：便于测试注入
    expect(parseConfigValue('pay.withdrawTimeoutMinutes', 10080)).toBe(10080);
    expect(() => parseConfigValue('pay.orderExpireMinutes', 0)).toThrow(/1 ≤ n ≤ 10080/);
    expect(() => parseConfigValue('pay.orderExpireMinutes', 10081)).toThrow(/1 ≤ n ≤ 10080/);
    expect(() => parseConfigValue('pay.withdrawTimeoutMinutes', 1.5)).toThrow(/整数/);
    expect(() => parseConfigValue('pay.withdrawTimeoutMinutes', '4320')).toThrow(/整数/);
  });
  it('客户端接入片第 43–44 键：appEnabled/h5Enabled = 严格 boolean（拒字符串 \'true\' 与数字；种子 true=暗上线全开）', () => {
    expect(parseConfigValue('client.appEnabled', false)).toBe(false);
    expect(parseConfigValue('client.h5Enabled', true)).toBe(true);
    expect(() => parseConfigValue('client.appEnabled', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('client.h5Enabled', 1)).toThrow(/boolean/);
    expect(() => parseConfigValue('client.appEnabled', null)).toThrow(/boolean/);
    expect(() => parseConfigValue('client.h5Enabled', [])).toThrow(/boolean/);
  });
  it('未知键 ⇒ 抛', () => {
    expect(() => parseConfigValue('nope.key' as never, 1)).toThrow();
  });
});

describe('parseIntervalMs（节奏/清理六键）', () => {
  const CASES = [
    ['pay.scanIntervalMs', 600_000],
    ['pay.reconcileIntervalMs', 864_000_000],
    ['currency.reconcileIntervalMs', 36_000_000],
    ['risk.scanIntervalMs', 36_000_000],
    ['risk.devicesCleanupIntervalMs', 36_000_000],
    ['record.cleanupIntervalMs', 36_000_000],
  ] as const;
  for (const [key, max] of CASES) {
    it(`${key}：1 与上界合法；0/负/小数/上界+1/字符串/null 拒（类型 + 文案两道；W1-M1）`, () => {
      expect(parseConfigValue(key, 1)).toBe(1);
      expect(parseConfigValue(key, max)).toBe(max);
      // 类型类坏值：ProtocolError + 类型文案（旧「未知键」兜底路径文案不同 ⇒ 文案断言使路径漂移可判；W1-M1）
      for (const bad of [1.5, '3000', null, true]) {
        expect(() => parseConfigValue(key, bad)).toThrow(ProtocolError);
        expect(() => parseConfigValue(key, bad)).toThrow(/必须是整数毫秒/);
      }
      // 范围类坏值：ProtocolError + 含键名与各自上界的范围句（W1-M1）
      // 断文案用动态 RegExp（非 stringContaining——vitest 2.1.9 里 toThrow(asymmetric) 把 Error 对象交给
      // asymmetricMatch，StringContaining 要求字符串 ⇒ 恒 false；见 w1-fix-red-run1-stringcontaining.log）
      for (const bad of [0, -1, max + 1]) {
        expect(() => parseConfigValue(key, bad)).toThrow(ProtocolError);
        expect(() => parseConfigValue(key, bad)).toThrow(
          new RegExp(`${key.replace(/\./g, '\\.')} 必须在 1 ≤ n ≤ ${max}（毫秒）范围内`),
        );
      }
    });
  }
  it('原型链名不得被判为键（W1-I1）：toString/constructor/__proto__ 一律拒', () => {
    for (const evil of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() => parseConfigValue(evil as never, 5)).toThrow(ProtocolError);
    }
  });
});

describe('parseReliefAdpid（第 41 键 · 首个 string 型）', () => {
  it('合法：空串 / base62 / 恰 32 位（trim 后返回）', () => {
    expect(parseConfigValue('ad.reliefAdpid', '')).toBe('');
    expect(parseConfigValue('ad.reliefAdpid', '  abc123  ')).toBe('abc123');
    expect(parseConfigValue('ad.reliefAdpid', 'A'.repeat(32))).toBe('A'.repeat(32));
  });
  it('非法：33 位 / 含 - _ 中文 空格 / 数字 / boolean / null ⇒ 抛 ProtocolError', () => {
    for (const bad of ['A'.repeat(33), 'a-b', 'a_b', '中', 'a b', 200, true, null, undefined]) {
      expect(() => parseConfigValue('ad.reliefAdpid', bad)).toThrow(ProtocolError);
    }
    expect(() => parseConfigValue('ad.reliefAdpid', 200)).toThrow(/必须是字符串/);
    expect(() => parseConfigValue('ad.reliefAdpid', 'a-b')).toThrow(/base62/);
  });
});

describe('机器人补位开关片（第 45–47 键）', () => {
  it('freeBotFillEnabled / goldBotFillEnabled：严格 boolean（字符串不算）', () => {
    for (const key of ['room.freeBotFillEnabled', 'room.goldBotFillEnabled'] as const) {
      expect(parseConfigValue(key, true)).toBe(true);
      expect(parseConfigValue(key, false)).toBe(false);
      for (const bad of ['true', 'false', 1, 0, null, undefined]) {
        expect(() => parseConfigValue(key, bad), `${key} <- ${String(bad)}`).toThrow(ProtocolError);
      }
    }
  });

  it('matchNoBotMaxWaitMs：整数毫秒、30000 ≤ n ≤ 1800000；种子 300000 合法', () => {
    expect(parseConfigValue('room.matchNoBotMaxWaitMs', 300000)).toBe(300000);
    expect(parseConfigValue('room.matchNoBotMaxWaitMs', 30000)).toBe(30000);
    expect(parseConfigValue('room.matchNoBotMaxWaitMs', 1800000)).toBe(1800000);
    for (const bad of [29999, 1800001, 60.5, '300000', true, null, undefined]) {
      expect(() => parseConfigValue('room.matchNoBotMaxWaitMs', bad), String(bad)).toThrow(ProtocolError);
    }
  });
});

describe('记牌器收费片（第 51/52 键）', () => {
  it('两价格键：整数 0..1,000,000（0 合法 = 该商品隐藏/免费态）', () => {
    for (const key of [
      'game.cardCounterPricePerGameCoins',
      'game.cardCounterPricePerHourCoins',
    ] as const) {
      expect(parseConfigValue(key, 0)).toBe(0);
      expect(parseConfigValue(key, 10)).toBe(10);
      expect(parseConfigValue(key, 1_000_000)).toBe(1_000_000);
      for (const bad of [-1, 1_000_001, 1.5, '10', true, null, undefined]) {
        expect(() => parseConfigValue(key, bad), `${key} <- ${String(bad)}`).toThrow(ProtocolError);
      }
    }
  });

  it('非法值的消息含键名（便于管理端定位）', () => {
    expect(() => parseConfigValue('game.cardCounterPricePerGameCoins', -1)).toThrow(
      /game\.cardCounterPricePerGameCoins/,
    );
  });
});

describe('跑得快配置键（多玩法片）', () => {
  it('levels.paodekuai 走 BaseScoreLevel[] 校验', () => {
    const levels = [{ name: '休闲场', baseScore: 15 }];
    expect(parseConfigValue('game.levels.paodekuai', levels)).toEqual(levels);
    expect(() => parseConfigValue('game.levels.paodekuai', [])).toThrow(ProtocolError);
    expect(() =>
      parseConfigValue('game.levels.paodekuai', [{ name: 'x', baseScore: 0 }]),
    ).toThrow(ProtocolError);
  });

  it('13 个 boolean 键严格 boolean', () => {
    for (const key of [
      'game.paodekuai.enabled',
      'game.paodekuai.twoPlayerEnabled',
      'game.paodekuai.nonThreePlayerEnabled',
      'game.paodekuai.bareTrioEnabled',
      'game.paodekuai.trioWithPairEnabled',
      'game.paodekuai.bareAirplaneEnabled',
      'game.paodekuai.fourWithTwoEnabled',
      'game.paodekuai.fourWithTwoPairKickerAllowed',
      'game.paodekuai.bombMultiplierEnabled',
      'game.paodekuai.guanMultiplierEnabled',
      'game.paodekuai.springMultiplierEnabled',
      'game.paodekuai.baobenEnabled',
      'game.doudizhu.enabled',
    ] as const) {
      expect(parseConfigValue(key, true)).toBe(true);
      expect(parseConfigValue(key, false)).toBe(false);
      for (const bad of ['true', 0, 1, null, undefined]) {
        expect(() => parseConfigValue(key, bad), `${key} <- ${String(bad)}`).toThrow(ProtocolError);
      }
    }
  });

  it('airplaneWings 只接受 pairs/singles/both', () => {
    for (const v of ['pairs', 'singles', 'both'] as const) {
      expect(parseConfigValue('game.paodekuai.airplaneWings', v)).toBe(v);
    }
    for (const bad of ['pair', 'single', 'BOTH', '', null, 1]) {
      expect(() => parseConfigValue('game.paodekuai.airplaneWings', bad), String(bad)).toThrow(
        ProtocolError,
      );
    }
  });

  it('multiplierCap 整数 1..1024', () => {
    expect(parseConfigValue('game.paodekuai.multiplierCap', 1)).toBe(1);
    expect(parseConfigValue('game.paodekuai.multiplierCap', 64)).toBe(64);
    expect(parseConfigValue('game.paodekuai.multiplierCap', 1024)).toBe(1024);
    for (const bad of [0, 1025, 1.5, '64', true, null, undefined]) {
      expect(() => parseConfigValue('game.paodekuai.multiplierCap', bad), String(bad)).toThrow(
        ProtocolError,
      );
    }
  });
});

describe('配置平行化（2026-10-24）：新键校验与旧键兼容', () => {
  const GAME_BOOLS = [
    'game.doudizhu.freeRoomEnabled',
    'game.doudizhu.goldRoomEnabled',
    'game.doudizhu.friendRoomEnabled',
    'game.doudizhu.freeBotFillEnabled',
    'game.doudizhu.goldBotFillEnabled',
    'game.doudizhu.cardCounterEnabled',
    'game.doudizhu.robot.ruleFallback',
    'game.paodekuai.freeRoomEnabled',
    'game.paodekuai.goldRoomEnabled',
    'game.paodekuai.friendRoomEnabled',
    'game.paodekuai.freeBotFillEnabled',
    'game.paodekuai.goldBotFillEnabled',
  ] as const;

  it('玩法级 boolean：严格 true/false', () => {
    for (const key of GAME_BOOLS) {
      expect(parseConfigValue(key, true), key).toBe(true);
      expect(parseConfigValue(key, false), key).toBe(false);
      for (const bad of ['true', 0, 1, null, undefined]) {
        expect(() => parseConfigValue(key, bad), `${key} <- ${String(bad)}`).toThrow(ProtocolError);
      }
    }
  });

  it('玩法级抽水/门槛：各自范围；错误消息带新键名', () => {
    for (const key of ['game.doudizhu.rakePercent', 'game.paodekuai.rakePercent'] as const) {
      expect(parseConfigValue(key, 0), key).toBe(0);
      expect(parseConfigValue(key, 50), key).toBe(50);
      expect(() => parseConfigValue(key, 51), key).toThrow(new RegExp(key.replaceAll('.', '\.')));
    }
    for (const key of [
      'game.doudizhu.entryMultiplier',
      'game.paodekuai.entryMultiplier',
    ] as const) {
      expect(parseConfigValue(key, 1), key).toBe(1);
      expect(parseConfigValue(key, 100), key).toBe(100);
      expect(() => parseConfigValue(key, 0), key).toThrow(new RegExp(key.replaceAll('.', '\.')));
    }
  });

  it('game.levels.doudizhu：与旧档位表同 parser', () => {
    const levels = [{ name: '休闲场', baseScore: 15, entryFeePercent: 10 }];
    expect(parseConfigValue('game.levels.doudizhu', levels)).toEqual(levels);
    expect(() => parseConfigValue('game.levels.doudizhu', [])).toThrow(/非空/);
  });

  it('斗地主记牌器价格、机器人 AI、风控两键', () => {
    expect(parseConfigValue('game.doudizhu.cardCounterPricePerGameCoins', 10)).toBe(10);
    expect(parseConfigValue('game.doudizhu.cardCounterPricePerHourCoins', 100)).toBe(100);
    expect(
      parseConfigValue('game.doudizhu.robot.skillDistribution', {
        beginner: 15,
        intermediate: 35,
        advanced: 50,
      }),
    ).toEqual({ beginner: 0.15, intermediate: 0.35, advanced: 0.5 });
    expect(
      parseConfigValue('game.doudizhu.robot.modelBySkill', {
        beginner: 'sl',
        intermediate: 'douzero_WP',
        advanced: 'douzero_ADP',
      }),
    ).toEqual({ beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' });
    expect(parseConfigValue('game.doudizhu.risk.winRateThreshold', 0.8)).toBe(0.8);
    expect(parseConfigValue('game.doudizhu.risk.minGames', 100)).toBe(100);
    expect(() => parseConfigValue('game.doudizhu.risk.winRateThreshold', 0.785)).toThrow(
      /game\.doudizhu\.risk\.winRateThreshold/,
    );
  });

  it('跑得快风控两键：胜率阈值 / 最少局数（与斗地主同域，错误文案带新键名）', () => {
    expect(parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.5)).toBe(0.5);
    expect(parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.79)).toBe(0.79);
    expect(parseConfigValue('game.paodekuai.risk.winRateThreshold', 1)).toBe(1);
    expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.785)).toThrow(
      /game\.paodekuai\.risk\.winRateThreshold.*两位小数/,
    );
    expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.49)).toThrow(
      /game\.paodekuai\.risk\.winRateThreshold.*0\.5 ≤ n ≤ 1/,
    );
    expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', 1.01)).toThrow(
      /game\.paodekuai\.risk\.winRateThreshold.*0\.5 ≤ n ≤ 1/,
    );
    expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', '0.8')).toThrow(
      /game\.paodekuai\.risk\.winRateThreshold.*必须/,
    );
    expect(parseConfigValue('game.paodekuai.risk.minGames', 1)).toBe(1);
    expect(parseConfigValue('game.paodekuai.risk.minGames', 100000)).toBe(100000);
    expect(() => parseConfigValue('game.paodekuai.risk.minGames', 0)).toThrow(
      /game\.paodekuai\.risk\.minGames.*1 ≤ n ≤ 100000/,
    );
    expect(() => parseConfigValue('game.paodekuai.risk.minGames', 100001)).toThrow(
      /game\.paodekuai\.risk\.minGames.*1 ≤ n ≤ 100000/,
    );
    expect(() => parseConfigValue('game.paodekuai.risk.minGames', 3.5)).toThrow(
      /game\.paodekuai\.risk\.minGames.*必须是整数/,
    );
    expect(() => parseConfigValue('game.paodekuai.risk.minGames', '100')).toThrow(
      /game\.paodekuai\.risk\.minGames.*必须是整数/,
    );
  });

  it('跑得快按人数风控键：2/3/4 三组胜率/最少局数（错误文案带各自键名）', () => {
    for (const n of [2, 3, 4] as const) {
      const win = `game.paodekuai.risk.player${n}.winRateThreshold` as ConfigKey;
      const min = `game.paodekuai.risk.player${n}.minGames` as ConfigKey;
      expect(parseConfigValue(win, 0.5)).toBe(0.5);
      expect(parseConfigValue(win, 0.79)).toBe(0.79);
      expect(parseConfigValue(win, 1)).toBe(1);
      expect(() => parseConfigValue(win, 0.785)).toThrow(
        new RegExp(`${win.replaceAll('.', '\\.')}.*两位小数`),
      );
      expect(() => parseConfigValue(win, 0.49)).toThrow(
        new RegExp(`${win.replaceAll('.', '\\.')}.*0\\.5 ≤ n ≤ 1`),
      );
      expect(() => parseConfigValue(win, 1.01)).toThrow(
        new RegExp(`${win.replaceAll('.', '\\.')}.*0\\.5 ≤ n ≤ 1`),
      );
      expect(() => parseConfigValue(win, '0.8')).toThrow(
        new RegExp(`${win.replaceAll('.', '\\.')}.*必须`),
      );
      expect(parseConfigValue(min, 1)).toBe(1);
      expect(parseConfigValue(min, 100_000)).toBe(100_000);
      expect(() => parseConfigValue(min, 0)).toThrow(
        new RegExp(`${min.replaceAll('.', '\\.')}.*1 ≤ n ≤ 100000`),
      );
      expect(() => parseConfigValue(min, 100_001)).toThrow(
        new RegExp(`${min.replaceAll('.', '\\.')}.*1 ≤ n ≤ 100000`),
      );
      expect(() => parseConfigValue(min, 3.5)).toThrow(
        new RegExp(`${min.replaceAll('.', '\\.')}.*必须是整数`),
      );
      expect(() => parseConfigValue(min, '100')).toThrow(
        new RegExp(`${min.replaceAll('.', '\\.')}.*必须是整数`),
      );
    }
  });

  it('跑得快自动限流阈值：int 25–50；26/49 是中间值', () => {
    const key = 'game.paodekuai.risk.autoThrottleScore';
    for (const v of [25, 26, 49, 50]) expect(parseConfigValue(key, v)).toBe(v);
    for (const bad of [24, 51, 3.5, '25', null, true]) {
      expect(() => parseConfigValue(key, bad), `autoThrottleScore=${JSON.stringify(bad)}`).toThrow(
        /game\.paodekuai\.risk\.autoThrottleScore/,
      );
    }
  });

  it('currency.reliefThresholdCoins：整数 1..1,000,000', () => {
    expect(parseConfigValue('currency.reliefThresholdCoins', 150)).toBe(150);
    expect(parseConfigValue('currency.reliefThresholdCoins', 1)).toBe(1);
    expect(parseConfigValue('currency.reliefThresholdCoins', 1_000_000)).toBe(1_000_000);
    for (const bad of [0, 1_000_001, 1.5, '150', null]) {
      expect(() => parseConfigValue('currency.reliefThresholdCoins', bad), String(bad)).toThrow(
        ProtocolError,
      );
    }
  });

  it('旧键仍可解析（快照读取/回滚回填），但 isLegacyConfigKey 为真', () => {
    expect(parseConfigValue('room.freeRoomEnabled', true)).toBe(true);
    expect(parseConfigValue('currency.entryMultiplier', 10)).toBe(10);
    expect(parseConfigValue('game.baseScoreLevels', [{ name: 'X', baseScore: 15 }])).toEqual([
      { name: 'X', baseScore: 15 },
    ]);
    expect(parseConfigValue('robot.ruleFallback', true)).toBe(true);
    expect(parseConfigValue('risk.winRateThreshold', 0.8)).toBe(0.8);
    expect(isLegacyConfigKey('room.freeRoomEnabled')).toBe(true);
  });
});
