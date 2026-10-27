import { Controller, Get } from '@nestjs/common';
import {
  ErrCode,
  GAME_META,
  parseConfigValue,
  type BaseScoreLevel,
  type ClientConfig,
  type ClientGameConfig,
} from '@fight-the-landlord/protocol';
import { maxVersion, PlatformConfigService } from './platform-config.service';

/**
 * 配置平行化（2026-10-24）：读值顺序 = 新键 → 旧键（仅斗地主）→ 代码默认。
 * 新键存在但非法 ⇒ 走默认/空表，**不回退旧键**（与 spec D3 一致）。
 */
type ConfigByKey = Map<string, unknown>;

function pickRaw(byKey: ConfigByKey, key: string, legacyKey?: string): unknown {
  const value = byKey.get(key);
  if (value !== undefined) return value;
  return legacyKey === undefined ? undefined : byKey.get(legacyKey);
}

function readBoolean(
  byKey: ConfigByKey,
  key: string,
  legacyKey: string | undefined,
  fallback: boolean,
): boolean {
  const value = pickRaw(byKey, key, legacyKey);
  return typeof value === 'boolean' ? value : fallback;
}

function readInt(
  byKey: ConfigByKey,
  key: string,
  legacyKey: string | undefined,
  fallback: number,
): number {
  const value = pickRaw(byKey, key, legacyKey);
  if (value === undefined) return fallback;
  try {
    // 范围校验复用写入口 parser（唯一校验点）；非法 ⇒ 代码默认，不回退旧键。
    return parseConfigValue(key as never, value) as number;
  } catch {
    return fallback;
  }
}

function readLevels(byKey: ConfigByKey, key: string, legacyKey?: string): BaseScoreLevel[] {
  const value = pickRaw(byKey, key, legacyKey);
  if (value === undefined) return [];
  try {
    return parseConfigValue(key as never, value) as BaseScoreLevel[];
  } catch {
    return [];
  }
}

function readReliefThreshold(byKey: ConfigByKey): number | null {
  const value = byKey.get('currency.reliefThresholdCoins');
  if (value === undefined) return null;
  try {
    return parseConfigValue('currency.reliefThresholdCoins', value) as number;
  } catch {
    return null;
  }
}

/**
 * `GET /api/config` —— 玩家客户端的配置**子集**（规格 §2.4 / C7）。
 *
 * 判据写死：`data` 的键集**恰好** `CLIENT_CONFIG_KEYS`（多玩法配置平行化起 = 二十一键：
 * `baseScoreLevels` / `friendRoomEnabled` / `freeRoomEnabled` / `goldRoomEnabled` /
 * `cardCounterEnabled` / `cardCounterPricePerGameCoins` / `cardCounterPricePerHourCoins` / `reliefEnabled` / `entryMultiplier` /
 * `rechargeEnabled` / `withdrawEnabled` /
 * `coinPerYuan` / `rechargePackages` / `withdrawMinCoins` / `withdrawMaxCoinsPerOrder` /
 * `withdrawDailyMaxCoins` / `withdrawReAuthEnabled` / `reliefAdpid` / `games` / `reliefThresholdCoins` / `version`）——
 * **不得**顺手把内部键暴露进子集
 * （`CLIENT_CONFIG_KEYS` 是 protocol 里的单一真源；本文件只做组装）。
 * ⚠️ `entryMultiplier`（spec §2.4 偏差登记）与支付七裸名（⚙️11）、`reliefAdpid`（内部 `ad.reliefAdpid`）
 * **无内部前缀**——都是子集自己的键名（客户端换算/门控/广告位要用），前缀泄漏扫描天然放行。
 *
 * ⚠️ 两个数据面纪律：
 *  - `version` = **全局** MAX（每键 version 的最大值；不是子集几键的 MAX —— 规格 §2.1/§2.3）；
 *  - 每次请求都查库（`list()` 不缓存）—— 缓存会把「后台改了要生效」变成「改了要重启」。
 *
 * ⚠️ 缺行的兜底（**只在这里**，RPC 快照不兜）：子集形状恒二十一键、缺行取**与种子一致的默认**
 * （空表 / 逐键见下）。子集是玩家面，形状变化会打到全部客户端；101 键齐全由迁移
 * 种子保证，缺行只可能是建库事故 —— 此时「空档位 + 入口按种子」的既有客户端 fail-safe
 * 语义（§2.8）比 500 更稳。值的**合法性**由写入口的 `parseConfigValue` 保证；档位表在读取时
 * 复用同一个 parser 复核（坏值 ⇒ 空表，不 500）。
 *
 * 缺行默认逐键（规格 §2.4 的「缺键语义」按同一方向落到服务端兜底）：
 *  - `freeRoomEnabled ?? true`（与种子一致：免费场保持现状开）；
 *  - `goldRoomEnabled ?? true`（与种子一致：2026-10-04 用户裁决「金币场默认开」——原缺 ⇒ 关）；
 *  - `reliefEnabled ?? false`（缺 ⇒ 关：说不清就不开）；
 *  - `entryMultiplier ?? 10`（与种子一致：门槛提示退回初始倍率；服务端仍权威）。
 *    ⚠️ 客户端侧「响应整键缺失 ⇒ 不做门槛提示」是**另一回事**（旧版服务端的响应形态，
 *    T10 的客户端用例承担）；本控制器恒产出二十一键，不制造那种形态。
 *  - 支付七键（支付片 T5，⚙️11）：两开关 `?? false`（钱面 fail-safe：说不清就不开）、
 *    `coinPerYuan ?? 100` / `withdrawMinCoins ?? 1000` / `withdrawMaxCoinsPerOrder ?? 50000` /
 *    `withdrawDailyMaxCoins ?? 100000`（与种子一致）、`rechargePackages ?? []`
 *    （空档位——与 `baseScoreLevels` 空表同向：钱的事不凭空造档位；服务端判定在 payment-service）。
 *  - 广告片 `reliefAdpid ?? ''`（fail 方向空串，与种子一致：未配置 ⇒ 救助入口不渲染；string 种子首例）。
 */
@Controller('config')
export class ClientConfigController {
  constructor(private readonly config: PlatformConfigService) {}

  /**
   * 代理分润（2026-10-26，r3 Critical #1）：**登录前**公开启动配置。
   *
   * 登录页在无令牌时无法调用 `GET /api/config`（需玩家验签）⇒ 注册页的邀请码输入框
   * 永远拿不到开关。本端点只回两个字段（`version` + `agentInviteEnabled`），
   * 由网关 `PUBLIC_PATHS` 精确放行；**不得**把其余配置键顺手塞进来。
   */
  @Get('boot')
  async boot(): Promise<{
    code: ErrCode;
    data: { version: number; agentInviteEnabled: boolean };
  }> {
    const full = await this.get();
    return {
      code: full.code,
      data: {
        version: full.data.version,
        agentInviteEnabled: full.data.agentInviteEnabled,
      },
    };
  }

  @Get()
  async get(): Promise<{ code: ErrCode; data: ClientConfig }> {
    const rows = await this.config.list();
    const byKey: ConfigByKey = new Map(rows.map((r) => [r.key, r.value]));

    // 2026-10-21：档位表是台费的唯一来源；读侧复用写入口 parser（唯一校验点）。
    // 2026-10-24：斗地主新键 `game.levels.doudizhu` 优先，缺失回退旧 `game.baseScoreLevels`。
    const levels = readLevels(byKey, 'game.levels.doudizhu', 'game.baseScoreLevels');

    /**
     * 多玩法（Task 5.1 / spec §4.7.2）：`games` 是**新客户端**的玩法卡与档位来源。
     * - 斗地主：恒开、恰 3 人、档位 = `game.levels.doudizhu`（旧键回退）；
     * - 跑得快：开关/2-4 人闸读配置；档位读 `game.levels.paodekuai`（坏值 ⇒ 空表，不 500）。
     * 旧客户端只读顶层 `baseScoreLevels`，行为不变。
     */
    const pdkLevels = readLevels(byKey, 'game.levels.paodekuai');
    const pdkEnabled = readBoolean(byKey, 'game.paodekuai.enabled', undefined, false);
    const pdkTwo = readBoolean(byKey, 'game.paodekuai.twoPlayerEnabled', undefined, false);
    const pdkFour = readBoolean(
      byKey,
      'game.paodekuai.nonThreePlayerEnabled',
      undefined,
      false,
    );
    // 玩法开放开关（2026-10-24）：斗地主总开关；缺键 ⇒ true（旧库/旧快照保持现状）。
    const ddzEnabled = readBoolean(byKey, 'game.doudizhu.enabled', undefined, true);

    // 斗地主（旧键回退）与跑得快（代码默认）的场次/好友房/门槛。
    const ddzFree = readBoolean(
      byKey,
      'game.doudizhu.freeRoomEnabled',
      'room.freeRoomEnabled',
      true,
    );
    const ddzGold = readBoolean(
      byKey,
      'game.doudizhu.goldRoomEnabled',
      'room.goldRoomEnabled',
      true,
    );
    const ddzFriend = readBoolean(
      byKey,
      'game.doudizhu.friendRoomEnabled',
      'room.friendRoomEnabled',
      false,
    );
    const ddzEntryMultiplier = readInt(
      byKey,
      'game.doudizhu.entryMultiplier',
      'currency.entryMultiplier',
      10,
    );
    const pdkFree = readBoolean(byKey, 'game.paodekuai.freeRoomEnabled', undefined, true);
    const pdkGold = readBoolean(byKey, 'game.paodekuai.goldRoomEnabled', undefined, false);
    const pdkFriend = readBoolean(byKey, 'game.paodekuai.friendRoomEnabled', undefined, false);
    const pdkEntryMultiplier = readInt(byKey, 'game.paodekuai.entryMultiplier', undefined, 10);
    const games: Record<'doudizhu' | 'paodekuai', ClientGameConfig> = {
      doudizhu: {
        enabled: ddzEnabled,
        supportedPlayerCounts: [...GAME_META.doudizhu.supportedPlayerCounts],
        defaultPlayerCount: GAME_META.doudizhu.defaultPlayerCount,
        baseScoreLevels: levels,
        freeRoomEnabled: ddzFree,
        goldRoomEnabled: ddzGold,
        friendRoomEnabled: ddzFriend,
        entryMultiplier: ddzEntryMultiplier,
      },
      paodekuai: {
        enabled: pdkEnabled,
        // 2/4 人分别由 `twoPlayerEnabled` / `nonThreePlayerEnabled` 收窄
        //（引擎/协议始终支持 2/3/4）。
        supportedPlayerCounts: [
          ...(pdkTwo ? [2] : []),
          3,
          ...(pdkFour ? [4] : []),
        ],
        defaultPlayerCount: GAME_META.paodekuai.defaultPlayerCount,
        baseScoreLevels: pdkLevels,
        freeRoomEnabled: pdkFree,
        goldRoomEnabled: pdkGold,
        friendRoomEnabled: pdkFriend,
        entryMultiplier: pdkEntryMultiplier,
      },
    };

    return {
      code: ErrCode.OK,
      data: {
        baseScoreLevels: levels,
        friendRoomEnabled: ddzFriend,
        freeRoomEnabled: ddzFree,
        goldRoomEnabled: ddzGold,
        // 记牌器片（第 50 键）：缺行默认 true（与种子一致：保持现状）。
        cardCounterEnabled: readBoolean(
          byKey,
          'game.doudizhu.cardCounterEnabled',
          'game.cardCounterEnabled',
          true,
        ),
        // 记牌器收费片（第 51/52 键）：缺行默认 = 种子（10/100）。
        cardCounterPricePerGameCoins: readInt(
          byKey,
          'game.doudizhu.cardCounterPricePerGameCoins',
          'game.cardCounterPricePerGameCoins',
          10,
        ),
        cardCounterPricePerHourCoins: readInt(
          byKey,
          'game.doudizhu.cardCounterPricePerHourCoins',
          'game.cardCounterPricePerHourCoins',
          100,
        ),
        reliefEnabled: (byKey.get('currency.reliefEnabled') ?? false) as boolean,
        entryMultiplier: ddzEntryMultiplier,
        // 平行化：恒下发合法值或 null（缺失/非法 ⇒ null），保持 21 键精确集。
        reliefThresholdCoins: readReliefThreshold(byKey),
        // 支付七键（支付片 T5；缺行默认方向见文件头「缺行默认逐键」）
        rechargeEnabled: (byKey.get('pay.rechargeEnabled') ?? false) as boolean,
        withdrawEnabled: (byKey.get('pay.withdrawEnabled') ?? false) as boolean,
        coinPerYuan: (byKey.get('pay.coinPerYuan') ?? 100) as number,
        rechargePackages: (byKey.get('pay.rechargePackages') ?? []) as number[],
        withdrawMinCoins: (byKey.get('pay.withdrawMinCoins') ?? 1000) as number,
        withdrawMaxCoinsPerOrder: (byKey.get('pay.withdrawMaxCoinsPerOrder') ?? 50000) as number,
        withdrawDailyMaxCoins: (byKey.get('pay.withdrawDailyMaxCoins') ?? 100000) as number,
        // 提现再认证片（第 48 键）：缺行 ⇒ false（暗上线方向 = 不弹密码框，与种子一致）。
        withdrawReAuthEnabled: (byKey.get('risk.withdrawReAuthEnabled') ?? false) as boolean,
        // ⚠️ `String(...)` 不是多余转换（2026-10-18 测试服实锤）：TypeORM 的 json 列读路径会把
        // 「形如数字的 JSON 字符串」二次 `JSON.parse` ⇒ 库里存的是字符串 `"1948867796"`，读出来
        // 却是 number。协议与 uni-ad（`adpid: string`）都要求 string ⇒ 出站边界无条件归一回字符串
        // （空串经 `String('')` 仍是空串；写入侧的严格类型由 protocol `parseConfigValue` 拦）。
        reliefAdpid: String(byKey.get('ad.reliefAdpid') ?? ''),
        games,
        // 代理分润：邀请码输入框门控（缺键/旧快照 ⇒ false）。
        agentInviteEnabled: readBoolean(byKey, 'agent.inviteEnabled', undefined, false),
        version: maxVersion(rows),
      },
    };
  }
}
