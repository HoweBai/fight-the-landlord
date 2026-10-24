import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrCode, RPC_PATTERNS, type ConfigSnapshot } from '@fight-the-landlord/protocol';
import { ConfigRpcController } from '../src/rpc/config.rpc.controller';
import type { PlatformConfigService } from '../src/config/platform-config.service';
import { encrypt, fingerprintOf } from '../src/pay-channel/pay-channel.crypto';
import { PayChannelService } from '../src/pay-channel/pay-channel.service';
import {
  encrypt as notifyEncrypt,
  fingerprintOf as notifyFingerprintOf,
} from '../src/notify-channel/notify-channel.crypto';
import { NotifyChannelService } from '../src/notify-channel/notify-channel.service';
import {
  encrypt as adEncrypt,
  fingerprintOf as adFingerprintOf,
} from '../src/ad-channel/ad-channel.crypto';
import { AdChannelService } from '../src/ad-channel/ad-channel.service';
import {
  FakeAdChannelDb,
  FakeNotifyChannelDb,
  FakePayChannelDb,
  makeService,
  seedDb,
} from './helpers/config-probe';

/**
 * 各服务 → config-service 的 `config.snapshot`（规格 §2.3 / R220）——
 * 取代了旧 `config.baseScoreLevels` 边（其参照测试 `user-service/test/base-score-levels.rpc.test.ts`
 * 已随片⑦ T13 退役）。
 *
 * 三条判据：
 *  ① pattern 名**逐字**来自 `RPC_PATTERNS.configSnapshot`（不是手写字面量 —— R70 的教训：
 *     pattern 写错时替身不会失败，只有真拓扑才拒）；
 *  ② 成功 ⇒ R220 的 `{ok:true,data}` 信封，`data = {config, version}`（每键 value+version、
 *     全局 version = MAX）—— ⚠️ `data` 是信封的**内层**：T6 的 `ConfigClient.snapshot()`
 *     逐字保留既有 `!res?.ok` 分支并 `return res.data`（spec D1 行 + 计划 T6 Step 3），
 *     裸返回 `{config,version}` 会让每个消费方恒抛（客户端契约的一部分，不是装饰）；
 *  ③ 🔴 读快照失败 ⇒ `{ok:false,code:10007}` 信封、**不抛**（Nest 的 `RpcException`
 *     到客户端只剩字符串 message，5 位数字码会丢 —— R220 存在的理由）。
 *
 * 支付配置管理化 T6 起本文件追加第二 handler 的用例（规格 §2.5 逐字）：
 * `config.payChannel.get` —— 令牌常数时间比对（sha256 + timingSafeEqual；env 未设 ⇒ 一律拒）、
 * token 不匹配 ⇒ `{ok:false,10002,'拉取令牌不匹配'}`、主钥未设/解密失败 ⇒ `{ok:false,10007,
 * '渠道密钥存储未启用'}`、成功 ⇒ `values` **仅含已配置键**（密钥类值 = base64(PEM) 明文下发，
 * 与「管理 GET 掩码写」相反 —— 专用通道的读侧契约）。
 *
 * 通知通道管理化 T7 起本文件追加第三 handler 的用例（通知规格 §2.5 逐字）：
 * `config.notifyChannel.get` —— 与 pay 侧**同构**（常数时间令牌 / 10002 / 10007），差异只两处：
 * 文案组（'通知通道密钥存储未启用'，**无**管理面 503 的「（缺主钥）」后缀）与 env 名
 * （`NOTIFY_CHANNEL_PULL_TOKEN`）；另钉「`config.snapshot` 响应无 `notify.` 子串」
 * （九键不进广播，§5.2 ②；本包级）。
 *
 * 广告片 T7 起本文件追加第四 handler 的用例（广告规格 §2.3 逐字）：
 * `config.adChannel.get` —— 与 pay/notify 两侧**同构**（常数时间令牌 / 10002 / 10007），差异只两处：
 * 文案组（'广告回调密钥存储未启用'，**无**管理面 503 的「（缺主钥）」后缀）与 env 名
 * （`AD_CHANNEL_PULL_TOKEN`）；另钉「`config.snapshot` **含** ad 段（参数键 `ad.reliefAdpid`
 * 第 41 键在广播面）且**无** `ad.callback` 子串」（密钥第四键空间不进广播，§2.3；本包级）。
 */

/** Nest 内部的 pattern 元数据键（`@nestjs/microservices/constants` 的 `PATTERN_METADATA`）。 */
const PATTERN_METADATA = 'microservices:pattern';

/** 最小替身：只实现本片用到的 `list()`。 */
const fakeConfig = (impl: () => Promise<unknown>) =>
  ({ list: vi.fn(impl) }) as unknown as PlatformConfigService;

/** 最小替身：只实现本片用到的 `pull()`（快照用例不触它；令牌拒用例借它断言「零调用」）。 */
const fakePayChannel = (impl: () => Promise<unknown>) =>
  ({ pull: vi.fn(impl) }) as unknown as PayChannelService;

/** 最小替身：只实现本片用到的 `pull()`（快照/支付用例不触它；令牌拒用例借它断言「零调用」）。 */
const fakeNotifyChannel = (impl: () => Promise<unknown>) =>
  ({ pull: vi.fn(impl) }) as unknown as NotifyChannelService;

/** 最小替身：只实现本片用到的 `pull()`（快照/支付/通知用例不触它；令牌拒用例借它断言「零调用」）。 */
const fakeAdChannel = (impl: () => Promise<unknown>) =>
  ({ pull: vi.fn(impl) }) as unknown as AdChannelService;

/** ⚙️13 dev 常量（同 T4/T5 单测）：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')。 */
const DEV_ENC_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
/** ⚙️13 dev 令牌（同 conformance-stack.sh 种子值）。 */
const DEV_PULL_TOKEN = 'dev-pay-channel-pull-token-change-in-production';
/** ⚙️13 dev 令牌（通知片；同 conformance-stack.sh 将供给的种子值）。 */
const DEV_NOTIFY_PULL_TOKEN = 'dev-notify-channel-pull-token-change-in-production';
/** ⚙️13 dev 令牌（广告片；同 conformance-stack.sh 将供给的种子值——T10）。 */
const DEV_AD_PULL_TOKEN = 'dev-ad-channel-pull-token-change-in-production';

const ORIGINAL_ENC_KEY = process.env.PAY_CONFIG_ENC_KEY;
const ORIGINAL_PULL_TOKEN = process.env.PAY_CHANNEL_PULL_TOKEN;
const ORIGINAL_NOTIFY_PULL_TOKEN = process.env.NOTIFY_CHANNEL_PULL_TOKEN;
const ORIGINAL_AD_PULL_TOKEN = process.env.AD_CHANNEL_PULL_TOKEN;

beforeAll(() => {
  // 主钥：本文件首个 crypto 调用前落定（`parseMasterKey` 首成功即缓存，env 进程期不变）。
  process.env.PAY_CONFIG_ENC_KEY = DEV_ENC_KEY_B64;
  process.env.PAY_CHANNEL_PULL_TOKEN = DEV_PULL_TOKEN;
  process.env.NOTIFY_CHANNEL_PULL_TOKEN = DEV_NOTIFY_PULL_TOKEN;
  process.env.AD_CHANNEL_PULL_TOKEN = DEV_AD_PULL_TOKEN;
});
afterAll(() => {
  // ⚠️ `process.env.X = undefined` 会写成字符串 'undefined' ⇒ 原值缺失必须 delete（T5 同款）。
  if (ORIGINAL_ENC_KEY === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENC_KEY;
  if (ORIGINAL_PULL_TOKEN === undefined) delete process.env.PAY_CHANNEL_PULL_TOKEN;
  else process.env.PAY_CHANNEL_PULL_TOKEN = ORIGINAL_PULL_TOKEN;
  if (ORIGINAL_NOTIFY_PULL_TOKEN === undefined) delete process.env.NOTIFY_CHANNEL_PULL_TOKEN;
  else process.env.NOTIFY_CHANNEL_PULL_TOKEN = ORIGINAL_NOTIFY_PULL_TOKEN;
  if (ORIGINAL_AD_PULL_TOKEN === undefined) delete process.env.AD_CHANNEL_PULL_TOKEN;
  else process.env.AD_CHANNEL_PULL_TOKEN = ORIGINAL_AD_PULL_TOKEN;
});

describe('ConfigRpcController（规格 §2.3 / R220）', () => {
  it('① pattern 名逐字来自 RPC_PATTERNS.configSnapshot（不是手写字面量）', () => {
    const patterns = Reflect.getMetadata(
      PATTERN_METADATA,
      ConfigRpcController.prototype.snapshot,
    ) as string[] | undefined;

    // 正对照（R115）：元数据真的读到了，否则下面那条是空测
    expect(patterns, '`microservices:pattern` 没读到 —— 元数据键写错或 Nest 升版变了').toBeDefined();
    expect(patterns).toEqual([RPC_PATTERNS.configSnapshot]);
    expect(RPC_PATTERNS.configSnapshot).toBe('config.snapshot');
  });

  it('② 成功 ⇒ `{ok:true,data:{config,version}}`：每键 {value,version}，全局 version = MAX（含非子集键）', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.get('robot.reclaimIntervalMs')!.version = 9; // 非子集键，最高
    const ctrl = new ConfigRpcController(
      svc,
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.snapshot({});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    const config = res.data.config as ConfigSnapshot;
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
        // 设备绑定片（第 49 键）
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
        'room.freeRoomEnabled',
        'room.friendRoomEnabled',
        'room.goldRoomEnabled',
        'room.matchScanIntervalMs',
        'room.reapIntervalMs',
        // 机器人补位开关片（第 45–47 键）
        'room.freeBotFillEnabled',
        'room.goldBotFillEnabled',
        'room.matchNoBotMaxWaitMs',
        // 节奏/清理片 T2（第 35–40 键）
        'pay.scanIntervalMs',
        'pay.reconcileIntervalMs',
        'currency.reconcileIntervalMs',
        'risk.scanIntervalMs',
        'risk.devicesCleanupIntervalMs',
        'record.cleanupIntervalMs',
      ].sort(),
    );
    expect(config['room.friendRoomEnabled']).toEqual({ value: false, version: 1 });
    // 金币场第 14 键：快照里种子值逐字（room-service/currency-service 的 getter 消费面）
    expect(config['currency.entryMultiplier']).toEqual({ value: 10, version: 1 });
    expect(config['game.baseScoreLevels']!.value).toEqual(db.rows.get('game.baseScoreLevels')!.value);
    expect(res.data.version).toBe(9);
  });

  it('③ 🔴 读快照失败 ⇒ `{ok:false,code:10007}` 信封、**不抛**（码要跨过 RPC 边界）', async () => {
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => {
        throw new Error('db down');
      }),
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );

    await expect(ctrl.snapshot({})).resolves.toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: 'db down',
    });
  });
});

/* ------------------------------------------------------------------ *
 * T6：`config.payChannel.get`（规格 §2.5 逐字；J21 窗口的闭合侧）
 * ------------------------------------------------------------------ */

describe('ConfigRpcController.config.payChannel.get（规格 §2.5；T6）', () => {
  it('⓪ pattern 名逐字来自 RPC_PATTERNS.configPayChannelGet（J21 闭合的那条接收侧）', () => {
    const patterns = Reflect.getMetadata(
      PATTERN_METADATA,
      ConfigRpcController.prototype.payChannelGet,
    ) as string[] | undefined;

    expect(patterns, '`microservices:pattern` 没读到 —— 元数据键写错或 Nest 升版变了').toBeDefined();
    expect(patterns).toEqual([RPC_PATTERNS.configPayChannelGet]);
    expect(RPC_PATTERNS.configPayChannelGet).toBe('config.payChannel.get');
  });

  it('① 正确令牌 ⇒ `{ok:true,data:{values}}`：仅含已配置键；密钥类值 = base64(PEM) 明文下发', async () => {
    const db = new FakePayChannelDb();
    const GW = 'http://ftl-alipay-stub:8801';
    const PRIV_B64 = Buffer.from(
      '-----BEGIN PRIVATE KEY-----\nRkFLRS1URVNULUtFWQ==\n-----END PRIVATE KEY-----\n',
      'utf8',
    ).toString('base64');
    // 真 `encrypt()` 产密文（AAD = 键名；同图解密往返 ⇒ 值逐字还原）
    db.addRow('pay.channel.gatewayUrl', {
      value_enc: encrypt('pay.channel.gatewayUrl', GW),
      fingerprint: fingerprintOf(GW),
    });
    db.addRow('pay.channel.privateKey', {
      value_enc: encrypt('pay.channel.privateKey', PRIV_B64),
      fingerprint: fingerprintOf(PRIV_B64),
    });
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      new PayChannelService(db.dataSource as unknown as DataSource),
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.payChannelGet({ pullToken: DEV_PULL_TOKEN });

    expect(res).toEqual({
      ok: true,
      data: {
        values: {
          'pay.channel.gatewayUrl': GW,
          'pay.channel.privateKey': PRIV_B64, // 专用通道下发**明文 canonical**（与管理 GET 掩码写相反）
        },
      },
    });
    if (!res.ok) throw new Error('unreachable');
    // 「仅含已配置键」—— 恰两键（其余四键缺行不补；toEqual 对 undefined 值域宽容，这行收紧口径）
    expect(Object.keys(res.data.values).sort()).toEqual([
      'pay.channel.gatewayUrl',
      'pay.channel.privateKey',
    ]);
  });

  it('② 错令牌 ⇒ `{ok:false,10002}` 信封、无 values、pull 零调用；消息不含任何令牌内容', async () => {
    const pull = vi.fn(async () => ({ 'pay.channel.gatewayUrl': 'not-read' }));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      { pull } as unknown as PayChannelService,
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.payChannelGet({ pullToken: 'definitely-wrong-token' });

    expect(res).toEqual({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' });
    expect('data' in res).toBe(false); // 无 values 字段
    expect(pull).not.toHaveBeenCalled(); // 拒在取存储之前
    const text = JSON.stringify(res);
    expect(text).not.toContain('definitely-wrong-token'); // G2：消息面不含令牌
    expect(text).not.toContain(DEV_PULL_TOKEN);
  });

  it('③ env 令牌未设（空串 = 未设，⚙️5）⇒ 一律拒：正确字符串 / 空串 / 真缺 env 全拒；pull 零调用', async () => {
    const before = process.env.PAY_CHANNEL_PULL_TOKEN;
    const pull = vi.fn(async () => ({}));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      { pull } as unknown as PayChannelService,
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );
    try {
      process.env.PAY_CHANNEL_PULL_TOKEN = '';
      const withCorrect = await ctrl.payChannelGet({ pullToken: DEV_PULL_TOKEN });
      expect(withCorrect).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });
      const withEmpty = await ctrl.payChannelGet({ pullToken: '' });
      expect(withEmpty).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });

      delete process.env.PAY_CHANNEL_PULL_TOKEN; // 真未设（`|| ''` 兜底）与空串同规
      const missing = await ctrl.payChannelGet({ pullToken: DEV_PULL_TOKEN });
      expect(missing).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });

      expect(pull).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.PAY_CHANNEL_PULL_TOKEN;
      else process.env.PAY_CHANNEL_PULL_TOKEN = before;
    }
  });

  it('④ 长度不等的令牌（正确令牌的**前缀** / **加尾巴** / 超长）同走「不匹配」分支不炸（sha256 后定长）', async () => {
    const pull = vi.fn(async () => ({}));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      { pull } as unknown as PayChannelService,
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );

    for (const token of [DEV_PULL_TOKEN.slice(0, 8), `${DEV_PULL_TOKEN}x`, 'x'.repeat(500)]) {
      const res = await ctrl.payChannelGet({ pullToken: token });
      expect(res).toEqual({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' });
    }

    // 判别力（R115）：同一条 handler 拿正确令牌 ⇒ ok:true —— 上面的红是令牌判出来的，不是「恒拒」
    await expect(ctrl.payChannelGet({ pullToken: DEV_PULL_TOKEN })).resolves.toEqual({
      ok: true,
      data: { values: {} },
    });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('⑤ 解密失败（AAD 不符的坏行）⇒ `{ok:false,10007}` + §2.5② 逐字文案（与主钥缺同门）', async () => {
    const db = new FakePayChannelDb();
    // 用**另一个键名**的 AAD 加密 ⇒ 存到 gatewayUrl 行解密必败（GCM 认证失败路径，§2.3）
    db.addRow('pay.channel.gatewayUrl', {
      value_enc: encrypt('pay.channel.publicKey', 'https://gateway.example'),
      fingerprint: '000000000000',
    });
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      new PayChannelService(db.dataSource as unknown as DataSource),
      fakeNotifyChannel(async () => ({})),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.payChannelGet({ pullToken: DEV_PULL_TOKEN });

    expect(res).toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '渠道密钥存储未启用', // §2.5② 逐字（**不带** ⚙️18 的「（缺主钥）」后缀）
    });
  });
});

/* ------------------------------------------------------------------ *
 * 主钥未设：fresh 模块图（同 T5 503 组口径）
 * ------------------------------------------------------------------ */

describe('主钥未设 ⇒ `{ok:false,10007}`（§2.5②；fresh 模块图）', () => {
  it('fresh 图 + env 空串：令牌正确也拒（序 = 令牌先过、存储后拒）；库零调用', async () => {
    const before = process.env.PAY_CONFIG_ENC_KEY;
    // fresh 图（进程内主钥缓存使既有图上「未设」不可达，同 T5 口径）：controller 与 service
    // 必须成对取自同一张 fresh 图 —— 控制器用自己图里的 `PayChannelStorageDisabledError` 做
    // `instanceof`，混图会把 10007 漏进兜底分支（fallback 会透传底层文案，判据不再逐字）。
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = ''; // 空串 = 未设（⚙️5）
    try {
      const controllerModule = await import('../src/rpc/config.rpc.controller');
      const serviceModule = await import('../src/pay-channel/pay-channel.service');
      const db = new FakePayChannelDb();
      const ctrl = new controllerModule.ConfigRpcController(
        fakeConfig(async () => ({})),
        new serviceModule.PayChannelService(db.dataSource as unknown as DataSource),
        fakeNotifyChannel(async () => ({})),
        fakeAdChannel(async () => ({})),
      );

      const res = await ctrl.payChannelGet({ pullToken: DEV_PULL_TOKEN });

      expect(res).toEqual({
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: '渠道密钥存储未启用',
      });
      expect(db.queries).toHaveLength(0); // 主钥检查先于 LIST：库一次都没被碰（fail-closed）
    } finally {
      if (before === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
      else process.env.PAY_CONFIG_ENC_KEY = before;
    }
  });
});

/* ------------------------------------------------------------------ *
 * T7：`config.notifyChannel.get`（通知规格 §2.5 逐字；J21 窗口闭合的第三接收侧）
 * ------------------------------------------------------------------ */

describe('ConfigRpcController.config.notifyChannel.get（通知规格 §2.5；T7）', () => {
  it('⓪ pattern 名逐字来自 RPC_PATTERNS.configNotifyChannelGet（J21 窗口闭合的那条接收侧）', () => {
    const patterns = Reflect.getMetadata(
      PATTERN_METADATA,
      ConfigRpcController.prototype.notifyChannelGet,
    ) as string[] | undefined;

    expect(patterns, '`microservices:pattern` 没读到 —— 元数据键写错或 Nest 升版变了').toBeDefined();
    expect(patterns).toEqual([RPC_PATTERNS.configNotifyChannelGet]);
    expect(RPC_PATTERNS.configNotifyChannelGet).toBe('config.notifyChannel.get');
  });

  it('① 正确令牌 ⇒ `{ok:true,data:{values}}`：仅含已配置键；密键值 = 存储 canonical 明文下发', async () => {
    const db = new FakeNotifyChannelDb();
    const HOST = 'smtp.example.com';
    const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz-789';
    // 真 `notifyEncrypt()` 产密文（AAD = 键名；同图解密往返 ⇒ 值逐字还原）
    db.addRow('notify.smtp.host', {
      value_enc: notifyEncrypt('notify.smtp.host', HOST),
      fingerprint: notifyFingerprintOf(HOST),
    });
    db.addRow('notify.webhook.wecomUrl', {
      value_enc: notifyEncrypt('notify.webhook.wecomUrl', WECOM),
      fingerprint: notifyFingerprintOf(WECOM),
    });
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      new NotifyChannelService(db.dataSource as unknown as DataSource),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.notifyChannelGet({ pullToken: DEV_NOTIFY_PULL_TOKEN });

    expect(res).toEqual({
      ok: true,
      data: {
        values: {
          'notify.smtp.host': HOST,
          'notify.webhook.wecomUrl': WECOM, // 专用通道下发**明文 canonical**（与管理 GET 掩码写相反）
        },
      },
    });
    if (!res.ok) throw new Error('unreachable');
    // 「仅含已配置键」—— 恰两键（其余七键缺行不补；toEqual 对 undefined 值域宽容，这行收紧口径）
    expect(Object.keys(res.data.values).sort()).toEqual([
      'notify.smtp.host',
      'notify.webhook.wecomUrl',
    ]);
  });

  it('② 错令牌 ⇒ `{ok:false,10002}` 信封、无 values、pull 零调用；消息不含任何令牌内容', async () => {
    const pull = vi.fn(async () => ({ 'notify.smtp.host': 'not-read' }));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      { pull } as unknown as NotifyChannelService,
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.notifyChannelGet({ pullToken: 'definitely-wrong-token' });

    expect(res).toEqual({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' });
    expect('data' in res).toBe(false); // 无 values 字段
    expect(pull).not.toHaveBeenCalled(); // 拒在取存储之前
    const text = JSON.stringify(res);
    expect(text).not.toContain('definitely-wrong-token'); // G2：消息面不含令牌
    expect(text).not.toContain(DEV_NOTIFY_PULL_TOKEN);
  });

  it('③ env 令牌未设（空串 = 未设，⚙️5）⇒ 一律拒：正确字符串 / 空串 / 真缺 env 全拒；pull 零调用', async () => {
    const before = process.env.NOTIFY_CHANNEL_PULL_TOKEN;
    const pull = vi.fn(async () => ({}));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      { pull } as unknown as NotifyChannelService,
      fakeAdChannel(async () => ({})),
    );
    try {
      process.env.NOTIFY_CHANNEL_PULL_TOKEN = '';
      const withCorrect = await ctrl.notifyChannelGet({ pullToken: DEV_NOTIFY_PULL_TOKEN });
      expect(withCorrect).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });
      const withEmpty = await ctrl.notifyChannelGet({ pullToken: '' });
      expect(withEmpty).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });

      delete process.env.NOTIFY_CHANNEL_PULL_TOKEN; // 真未设（`|| ''` 兜底）与空串同规
      const missing = await ctrl.notifyChannelGet({ pullToken: DEV_NOTIFY_PULL_TOKEN });
      expect(missing).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });

      expect(pull).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.NOTIFY_CHANNEL_PULL_TOKEN;
      else process.env.NOTIFY_CHANNEL_PULL_TOKEN = before;
    }
  });

  it('④ 长度不等的令牌（正确令牌的**前缀** / **加尾巴** / 超长）同走「不匹配」分支不炸（sha256 后定长）', async () => {
    const pull = vi.fn(async () => ({}));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      { pull } as unknown as NotifyChannelService,
      fakeAdChannel(async () => ({})),
    );

    for (const token of [
      DEV_NOTIFY_PULL_TOKEN.slice(0, 8),
      `${DEV_NOTIFY_PULL_TOKEN}x`,
      'x'.repeat(500),
    ]) {
      const res = await ctrl.notifyChannelGet({ pullToken: token });
      expect(res).toEqual({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' });
    }

    // 判别力（R115）：同一条 handler 拿正确令牌 ⇒ ok:true —— 上面的红是令牌判出来的，不是「恒拒」
    await expect(ctrl.notifyChannelGet({ pullToken: DEV_NOTIFY_PULL_TOKEN })).resolves.toEqual({
      ok: true,
      data: { values: {} },
    });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('⑤ 解密失败（AAD 不符的坏行）⇒ `{ok:false,10007}` + §2.5② 逐字文案（无「（缺主钥）」后缀）', async () => {
    const db = new FakeNotifyChannelDb();
    // 用**另一个键名**的 AAD 加密 ⇒ 存到 wecomUrl 行解密必败（GCM 认证失败路径，§2.3）
    db.addRow('notify.webhook.wecomUrl', {
      value_enc: notifyEncrypt('notify.webhook.feishuUrl', 'https://qyapi.weixin.qq.com/hook'),
      fingerprint: '000000000000',
    });
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      new NotifyChannelService(db.dataSource as unknown as DataSource),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.notifyChannelGet({ pullToken: DEV_NOTIFY_PULL_TOKEN });

    expect(res).toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '通知通道密钥存储未启用', // §2.5② 逐字（**不带** §2.9 管理面 503 的「（缺主钥）」后缀）
    });
  });

  it('⑥ `config.snapshot` 响应无 `notify.` 子串（九键不进广播，§5.2 ②；本包级）', async () => {
    const { svc } = makeService(seedDb());
    const notifyDb = new FakeNotifyChannelDb();
    const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz-789';
    notifyDb.addRow('notify.webhook.wecomUrl', {
      value_enc: notifyEncrypt('notify.webhook.wecomUrl', WECOM),
      fingerprint: notifyFingerprintOf(WECOM),
    });
    const ctrl = new ConfigRpcController(
      svc,
      fakePayChannel(async () => ({})),
      new NotifyChannelService(notifyDb.dataSource as unknown as DataSource),
      fakeAdChannel(async () => ({})),
    );

    const res = await ctrl.snapshot({});

    expect(res.ok).toBe(true);
    const text = JSON.stringify(res);
    expect(text).not.toContain('notify.'); // 九键不进广播（结构上：快照只读 platform_config）
    expect(text).not.toContain(WECOM); // 值同样不出站
    // 判别力（R115）：响应是**真的**快照（含真键），「无 notify.」不是空响应凑出来的
    expect(text).toContain('robot.skillDistribution');
    expect(notifyDb.queries).toHaveLength(0); // 快照路径一次都不碰通知表
  });
});

/* ------------------------------------------------------------------ *
 * 主钥未设：fresh 模块图（同 T5/T6 口径；通知通道）
 * ------------------------------------------------------------------ */

describe('主钥未设 ⇒ `{ok:false,10007}`（通知规格 §2.5②；fresh 模块图）', () => {
  it('fresh 图 + env 空串：令牌正确也拒（序 = 令牌先过、存储后拒）；库零调用', async () => {
    const before = process.env.PAY_CONFIG_ENC_KEY;
    // fresh 图（进程内主钥缓存使既有图上「未设」不可达，同 T5/T6 口径）：controller 与 service
    // 必须成对取自同一张 fresh 图 —— 控制器用自己图里的 `NotifyChannelStorageDisabledError` 做
    // `instanceof`，混图会把 10007 漏进兜底分支（fallback 会透传底层文案，判据不再逐字）。
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = ''; // 空串 = 未设（⚙️5）
    try {
      const controllerModule = await import('../src/rpc/config.rpc.controller');
      const serviceModule = await import('../src/notify-channel/notify-channel.service');
      const db = new FakeNotifyChannelDb();
      const ctrl = new controllerModule.ConfigRpcController(
        fakeConfig(async () => ({})),
        fakePayChannel(async () => ({})),
        new serviceModule.NotifyChannelService(db.dataSource as unknown as DataSource),
        fakeAdChannel(async () => ({})),
      );

      const res = await ctrl.notifyChannelGet({ pullToken: DEV_NOTIFY_PULL_TOKEN });

      expect(res).toEqual({
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: '通知通道密钥存储未启用',
      });
      expect(db.queries).toHaveLength(0); // 主钥检查先于 LIST：库一次都没被碰（fail-closed）
    } finally {
      if (before === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
      else process.env.PAY_CONFIG_ENC_KEY = before;
    }
  });
});

/* ------------------------------------------------------------------ *
 * T7：`config.adChannel.get`（广告规格 §2.3 逐字；pattern 与接收侧同笔，
 * 无 J21 窗口——计划 v1.2 把常量自 T4 移入 T7）
 * ------------------------------------------------------------------ */

describe('ConfigRpcController.config.adChannel.get（广告规格 §2.3；T7）', () => {
  it('⓪ pattern 名逐字来自 RPC_PATTERNS.configAdChannelGet（与接收侧同笔提交的那条常量）', () => {
    const patterns = Reflect.getMetadata(
      PATTERN_METADATA,
      ConfigRpcController.prototype.adChannelGet,
    ) as string[] | undefined;

    expect(patterns, '`microservices:pattern` 没读到 —— 元数据键写错或 Nest 升版变了').toBeDefined();
    expect(patterns).toEqual([RPC_PATTERNS.configAdChannelGet]);
    expect(RPC_PATTERNS.configAdChannelGet).toBe('config.adChannel.get');
  });

  it('① 正确令牌 ⇒ `{ok:true,data:{values}}`：仅含已配置键；密键值 = 存储 canonical 明文下发', async () => {
    const db = new FakeAdChannelDb();
    const SECRET = 'uniad-callback-secret-canonical-001';
    // 真 `adEncrypt()` 产密文（AAD = 键名；同图解密往返 ⇒ 值逐字还原）
    db.addRow('ad.callbackSecret', {
      value_enc: adEncrypt('ad.callbackSecret', SECRET),
      fingerprint: adFingerprintOf(SECRET),
    });
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      new AdChannelService(db.dataSource as unknown as DataSource),
    );

    const res = await ctrl.adChannelGet({ pullToken: DEV_AD_PULL_TOKEN });

    expect(res).toEqual({
      ok: true,
      data: {
        values: { 'ad.callbackSecret': SECRET }, // 专用通道下发**明文 canonical**（与管理 GET 掩码写相反）
      },
    });
    if (!res.ok) throw new Error('unreachable');
    // 「仅含已配置键」—— 恰一键（本键空间键面恰 1 枚；空库时 values={}，缺键不补）
    expect(Object.keys(res.data.values).sort()).toEqual(['ad.callbackSecret']);
  });

  it('② 错令牌 ⇒ `{ok:false,10002}` 信封、无 values、pull 零调用；消息不含任何令牌内容', async () => {
    const pull = vi.fn(async () => ({ 'ad.callbackSecret': 'not-read' }));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      { pull } as unknown as AdChannelService,
    );

    const res = await ctrl.adChannelGet({ pullToken: 'definitely-wrong-token' });

    expect(res).toEqual({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' });
    expect('data' in res).toBe(false); // 无 values 字段
    expect(pull).not.toHaveBeenCalled(); // 拒在取存储之前
    const text = JSON.stringify(res);
    expect(text).not.toContain('definitely-wrong-token'); // G2：消息面不含令牌
    expect(text).not.toContain(DEV_AD_PULL_TOKEN);
  });

  it('③ env 令牌未设（空串 = 未设，⚙️5）⇒ 一律拒：正确字符串 / 空串 / 真缺 env 全拒；pull 零调用', async () => {
    const before = process.env.AD_CHANNEL_PULL_TOKEN;
    const pull = vi.fn(async () => ({}));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      { pull } as unknown as AdChannelService,
    );
    try {
      process.env.AD_CHANNEL_PULL_TOKEN = '';
      const withCorrect = await ctrl.adChannelGet({ pullToken: DEV_AD_PULL_TOKEN });
      expect(withCorrect).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });
      const withEmpty = await ctrl.adChannelGet({ pullToken: '' });
      expect(withEmpty).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });

      delete process.env.AD_CHANNEL_PULL_TOKEN; // 真未设（`|| ''` 兜底）与空串同规
      const missing = await ctrl.adChannelGet({ pullToken: DEV_AD_PULL_TOKEN });
      expect(missing).toEqual({
        ok: false,
        code: ErrCode.UNAUTHENTICATED,
        message: '拉取令牌不匹配',
      });

      expect(pull).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.AD_CHANNEL_PULL_TOKEN;
      else process.env.AD_CHANNEL_PULL_TOKEN = before;
    }
  });

  it('④ 长度不等的令牌（正确令牌的**前缀** / **加尾巴** / 超长）同走「不匹配」分支不炸（sha256 后定长）', async () => {
    const pull = vi.fn(async () => ({}));
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      { pull } as unknown as AdChannelService,
    );

    for (const token of [DEV_AD_PULL_TOKEN.slice(0, 8), `${DEV_AD_PULL_TOKEN}x`, 'x'.repeat(500)]) {
      const res = await ctrl.adChannelGet({ pullToken: token });
      expect(res).toEqual({ ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' });
    }

    // 判别力（R115）：同一条 handler 拿正确令牌 ⇒ ok:true —— 上面的红是令牌判出来的，不是「恒拒」
    await expect(ctrl.adChannelGet({ pullToken: DEV_AD_PULL_TOKEN })).resolves.toEqual({
      ok: true,
      data: { values: {} },
    });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('⑤ 解密失败（AAD 不符的坏行）⇒ `{ok:false,10007}` + §2.3 逐字文案（无「（缺主钥）」后缀）', async () => {
    const db = new FakeAdChannelDb();
    // 用**另一个键名**的 AAD 加密 ⇒ 存到 ad.callbackSecret 行解密必败（GCM 认证失败路径，§2.3）
    db.addRow('ad.callbackSecret', {
      value_enc: adEncrypt('notify.smtp.pass', 'uniad-callback-secret'),
      fingerprint: '000000000000',
    });
    const ctrl = new ConfigRpcController(
      fakeConfig(async () => ({})),
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      new AdChannelService(db.dataSource as unknown as DataSource),
    );

    const res = await ctrl.adChannelGet({ pullToken: DEV_AD_PULL_TOKEN });

    expect(res).toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: '广告回调密钥存储未启用', // §2.3 逐字（**不带**管理面 503 的「（缺主钥）」后缀）
    });
  });

  it('⑥ `config.snapshot` **含** ad 段（第 41 键在广播面）且**无** `ad.callback` 子串（第四键空间不进广播，§2.3；本包级）', async () => {
    const { svc } = makeService(seedDb());
    const adDb = new FakeAdChannelDb();
    const SECRET = 'uniad-callback-secret-canonical-001';
    adDb.addRow('ad.callbackSecret', {
      value_enc: adEncrypt('ad.callbackSecret', SECRET),
      fingerprint: adFingerprintOf(SECRET),
    });
    const ctrl = new ConfigRpcController(
      svc,
      fakePayChannel(async () => ({})),
      fakeNotifyChannel(async () => ({})),
      new AdChannelService(adDb.dataSource as unknown as DataSource),
    );

    const res = await ctrl.snapshot({});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    // 正面（「快照含 ad 段」）：参数键 `ad.reliefAdpid`（第 41 键）**在**广播快照里（T3 同步面的下游复核）
    expect(res.data.config['ad.reliefAdpid']).toEqual({ value: '', version: 1 });
    const text = JSON.stringify(res);
    // 反面：密钥第四键空间（键名/值）不进广播（结构上：快照只读 platform_config）
    expect(text).not.toContain('ad.callback');
    expect(text).not.toContain(SECRET); // 值同样不出站
    // 判别力（R115）：响应是**真的**快照（含真键），「无 ad.callback」不是空响应凑出来的
    expect(text).toContain('robot.skillDistribution');
    expect(adDb.queries).toHaveLength(0); // 快照路径一次都不碰广告表
  });
});

/* ------------------------------------------------------------------ *
 * 主钥未设：fresh 模块图（同 T5/T6/T7 口径；广告回调密钥）
 * ------------------------------------------------------------------ */

describe('主钥未设 ⇒ `{ok:false,10007}`（广告规格 §2.3；fresh 模块图）', () => {
  it('fresh 图 + env 空串：令牌正确也拒（序 = 令牌先过、存储后拒）；库零调用', async () => {
    const before = process.env.PAY_CONFIG_ENC_KEY;
    // fresh 图（进程内主钥缓存使既有图上「未设」不可达，同 T5/T6/T7 口径）：controller 与 service
    // 必须成对取自同一张 fresh 图 —— 控制器用自己图里的 `AdChannelStorageDisabledError` 做
    // `instanceof`，混图会把 10007 漏进兜底分支（fallback 会透传底层文案，判据不再逐字）。
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = ''; // 空串 = 未设（⚙️5）
    try {
      const controllerModule = await import('../src/rpc/config.rpc.controller');
      const serviceModule = await import('../src/ad-channel/ad-channel.service');
      const db = new FakeAdChannelDb();
      const ctrl = new controllerModule.ConfigRpcController(
        fakeConfig(async () => ({})),
        fakePayChannel(async () => ({})),
        fakeNotifyChannel(async () => ({})),
        new serviceModule.AdChannelService(db.dataSource as unknown as DataSource),
      );

      const res = await ctrl.adChannelGet({ pullToken: DEV_AD_PULL_TOKEN });

      expect(res).toEqual({
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: '广告回调密钥存储未启用',
      });
      expect(db.queries).toHaveLength(0); // 主钥检查先于 LIST：库一次都没被碰（fail-closed）
    } finally {
      if (before === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
      else process.env.PAY_CONFIG_ENC_KEY = before;
    }
  });
});
