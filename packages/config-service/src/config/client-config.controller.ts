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
 * `GET /api/config` —— 玩家客户端的配置**子集**（规格 §2.4 / C7）。
 *
 * 判据写死：`data` 的键集**恰好** `CLIENT_CONFIG_KEYS`（多玩法 Task 5.1 起 = 二十键：
 * `baseScoreLevels` / `friendRoomEnabled` / `freeRoomEnabled` / `goldRoomEnabled` /
 * `cardCounterEnabled` / `cardCounterPricePerGameCoins` / `cardCounterPricePerHourCoins` / `reliefEnabled` / `entryMultiplier` /
 * `rechargeEnabled` / `withdrawEnabled` /
 * `coinPerYuan` / `rechargePackages` / `withdrawMinCoins` / `withdrawMaxCoinsPerOrder` /
 * `withdrawDailyMaxCoins` / `withdrawReAuthEnabled` / `reliefAdpid` / `games` / `version`）——
 * **不得**顺手把内部键暴露进子集
 * （`CLIENT_CONFIG_KEYS` 是 protocol 里的单一真源；本文件只做组装）。
 * ⚠️ `entryMultiplier`（spec §2.4 偏差登记）与支付七裸名（⚙️11）、`reliefAdpid`（内部 `ad.reliefAdpid`）
 * **无内部前缀**——都是子集自己的键名（客户端换算/门控/广告位要用），前缀泄漏扫描天然放行。
 *
 * ⚠️ 两个数据面纪律：
 *  - `version` = **全局** MAX（每键 version 的最大值；不是子集几键的 MAX —— 规格 §2.1/§2.3）；
 *  - 每次请求都查库（`list()` 不缓存）—— 缓存会把「后台改了要生效」变成「改了要重启」。
 *
 * ⚠️ 缺行的兜底（**只在这里**，RPC 快照不兜）：子集形状恒十九键、缺行取**与种子一致的默认**
 * （空表 / 逐键见下）。子集是玩家面，形状变化会打到全部客户端；六十六键齐全由迁移
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
 *    T10 的客户端用例承担）；本控制器恒产出十九键，不制造那种形态。
 *  - 支付七键（支付片 T5，⚙️11）：两开关 `?? false`（钱面 fail-safe：说不清就不开）、
 *    `coinPerYuan ?? 100` / `withdrawMinCoins ?? 1000` / `withdrawMaxCoinsPerOrder ?? 50000` /
 *    `withdrawDailyMaxCoins ?? 100000`（与种子一致）、`rechargePackages ?? []`
 *    （空档位——与 `baseScoreLevels` 空表同向：钱的事不凭空造档位；服务端判定在 payment-service）。
 *  - 广告片 `reliefAdpid ?? ''`（fail 方向空串，与种子一致：未配置 ⇒ 救助入口不渲染；string 种子首例）。
 */
@Controller('config')
export class ClientConfigController {
  constructor(private readonly config: PlatformConfigService) {}

  @Get()
  async get(): Promise<{ code: ErrCode; data: ClientConfig }> {
    const rows = await this.config.list();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    // 2026-10-21：档位表是台费的唯一来源；读侧复用写入口 parser（唯一校验点）。
    // 坏配置 ⇒ 玩家面空表（不 500）；阶段 2 起 `/api/config` 不再派生 `entryFeePercents`。
    let levels: BaseScoreLevel[] = [];
    try {
      levels = parseConfigValue(
        'game.baseScoreLevels',
        byKey.get('game.baseScoreLevels') ?? [],
      ) as BaseScoreLevel[];
    } catch {
      levels = [];
    }

    /**
     * 多玩法（Task 5.1 / spec §4.7.2）：`games` 是**新客户端**的玩法卡与档位来源。
     * - 斗地主：恒开、恰 3 人、档位 = 旧 `baseScoreLevels`（**不迁移**）；
     * - 跑得快：开关/2-4 人闸读配置；档位读新键（坏值 ⇒ 空表，不 500）。
     * 旧客户端只读顶层 `baseScoreLevels`，行为不变。
     */
    let pdkLevels: BaseScoreLevel[] = [];
    try {
      pdkLevels = parseConfigValue(
        'game.levels.paodekuai',
        byKey.get('game.levels.paodekuai') ?? [],
      ) as BaseScoreLevel[];
    } catch {
      pdkLevels = [];
    }
    const pdkEnabled = (byKey.get('game.paodekuai.enabled') ?? false) as boolean;
    const pdkNonThree = (byKey.get('game.paodekuai.nonThreePlayerEnabled') ?? false) as boolean;
    // 玩法开放开关（2026-10-24）：斗地主总开关；缺键 ⇒ true（旧库/旧快照保持现状）。
    const ddzEnabled = (byKey.get('game.doudizhu.enabled') ?? true) as boolean;
    const games: Record<'doudizhu' | 'paodekuai', ClientGameConfig> = {
      doudizhu: {
        enabled: ddzEnabled,
        supportedPlayerCounts: [...GAME_META.doudizhu.supportedPlayerCounts],
        defaultPlayerCount: GAME_META.doudizhu.defaultPlayerCount,
        baseScoreLevels: levels,
      },
      paodekuai: {
        enabled: pdkEnabled,
        // 2/4 人由 `nonThreePlayerEnabled` 收窄（引擎/协议始终支持 2/3/4）。
        supportedPlayerCounts: pdkNonThree
          ? [...GAME_META.paodekuai.supportedPlayerCounts]
          : [3],
        defaultPlayerCount: GAME_META.paodekuai.defaultPlayerCount,
        baseScoreLevels: pdkLevels,
      },
    };

    return {
      code: ErrCode.OK,
      data: {
        baseScoreLevels: levels,
        friendRoomEnabled: (byKey.get('room.friendRoomEnabled') ?? false) as boolean,
        freeRoomEnabled: (byKey.get('room.freeRoomEnabled') ?? true) as boolean,
        goldRoomEnabled: (byKey.get('room.goldRoomEnabled') ?? true) as boolean,
        // 记牌器片（第 50 键）：缺行默认 true（与种子一致：保持现状）。
        cardCounterEnabled: (byKey.get('game.cardCounterEnabled') ?? true) as boolean,
        // 记牌器收费片（第 51/52 键）：缺行默认 = 种子（10/100）。
        cardCounterPricePerGameCoins: (byKey.get('game.cardCounterPricePerGameCoins') ?? 10) as number,
        cardCounterPricePerHourCoins: (byKey.get('game.cardCounterPricePerHourCoins') ?? 100) as number,
        reliefEnabled: (byKey.get('currency.reliefEnabled') ?? false) as boolean,
        entryMultiplier: (byKey.get('currency.entryMultiplier') ?? 10) as number,
        // 支付七键（支付片 T5；缺行默认方向见文件头「缺行默认逐键」）
        rechargeEnabled: (byKey.get('pay.rechargeEnabled') ?? false) as boolean,
        withdrawEnabled: (byKey.get('pay.withdrawEnabled') ?? false) as boolean,
        coinPerYuan: (byKey.get('pay.coinPerYuan') ?? 100) as number,
        rechargePackages: (byKey.get('pay.rechargePackages') ?? []) as number[],
        withdrawMinCoins: (byKey.get('pay.withdrawMinCoins') ?? 1000) as number,
        withdrawMaxCoinsPerOrder: (byKey.get('pay.withdrawMaxCoinsPerOrder') ?? 50000) as number,
        withdrawDailyMaxCoins: (byKey.get('pay.withdrawDailyMaxCoins') ?? 100000) as number,
        // 提现再认证片（第 48 键）：缺行 ⇒ false（暗上线方向 = 不弹密码框，与种子一致）。
        // ⚠️ 合并期补上：分支只加了 `CLIENT_CONFIG_KEYS` 与客户端消费点，**漏了本控制器的
        // 逐键组装**（本端点不遍历 `CLIENT_CONFIG_KEYS`，是显式逐键写出的）⇒ 不补则客户端
        // 永远收不到该键、开关打开也弹不出密码框。
        withdrawReAuthEnabled: (byKey.get('risk.withdrawReAuthEnabled') ?? false) as boolean,
        // ⚠️ `String(...)` 不是多余转换（2026-10-18 测试服实锤）：TypeORM 的 json 列读路径会把
        // 「形如数字的 JSON 字符串」二次 `JSON.parse` ⇒ 库里存的是字符串 `"1948867796"`，读出来
        // 却是 number。协议与 uni-ad（`adpid: string`）都要求 string ⇒ 出站边界无条件归一回字符串
        // （空串经 `String('')` 仍是空串；写入侧的严格类型由 protocol `parseConfigValue` 拦）。
        reliefAdpid: String(byKey.get('ad.reliefAdpid') ?? ''),
        games,
        version: maxVersion(rows),
      },
    };
  }
}
