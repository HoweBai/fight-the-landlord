import type { ClientConfig } from '@fight-the-landlord/protocol';
import type { ClientConfigState } from '../stores/game';
import { useGameStore } from '../stores/game';
import { fetchClientConfig } from '../net/rest';

/**
 * 客户端配置的**共享加载/归一化**（记牌器收费片 T11 从 `lobby.vue` 抽出）。
 *
 * ⚠️ **唯一真源**：`FAILSAFE_CLIENT_CONFIG` 与 `normalizeClientConfig` 只住这里；
 * 大厅与开始游戏页（价格刷新）共用 —— 不得在页面里复制第二份（本仓对「第二真源」
 * 付过多次代价）。
 *
 * 缺键语义（逐条）：
 *  - `freeRoomEnabled`/`goldRoomEnabled` 缺 ⇒ `true`（与种子一致：保持现状）；
 *  - `reliefEnabled`/`cardCounterEnabled` 缺 ⇒ `false`（未知的新能力 = 不开放）；
 *  - `cardCounterPricePerGameCoins`/`cardCounterPricePerHourCoins` 缺/非数字 ⇒ `null`
 *    （价格未知 ⇒ 购买面板不渲染，不编数）；
 *  - `entryMultiplier` 缺 ⇒ `null`；支付七键按「关/null/空表」。
 */
export const FAILSAFE_CLIENT_CONFIG: ClientConfigState = {
  baseScoreLevels: [],
  friendRoomEnabled: false,
  freeRoomEnabled: false,
  goldRoomEnabled: true,
  reliefEnabled: false,
  cardCounterEnabled: false,
  cardCounterPricePerGameCoins: null,
  cardCounterPricePerHourCoins: null,
  reliefAdpid: '',
  entryMultiplier: null,
  rechargeEnabled: false,
  withdrawEnabled: false,
  coinPerYuan: null,
  rechargePackages: [],
  withdrawMinCoins: null,
  withdrawMaxCoinsPerOrder: null,
  withdrawDailyMaxCoins: null,
  withdrawReAuthEnabled: false,
  version: 0,
};

/** 响应归一化（缺键语义见文件头）。 */
export function normalizeClientConfig(raw: ClientConfig | undefined): ClientConfigState {
  return {
    baseScoreLevels: raw?.baseScoreLevels ?? [],
    friendRoomEnabled: raw?.friendRoomEnabled === true,
    freeRoomEnabled: raw?.freeRoomEnabled ?? true,
    goldRoomEnabled: raw?.goldRoomEnabled ?? true,
    reliefEnabled: raw?.reliefEnabled ?? false,
    cardCounterEnabled: raw?.cardCounterEnabled === true,
    cardCounterPricePerGameCoins:
      typeof raw?.cardCounterPricePerGameCoins === 'number' &&
      Number.isSafeInteger(raw.cardCounterPricePerGameCoins) &&
      raw.cardCounterPricePerGameCoins >= 0 &&
      raw.cardCounterPricePerGameCoins <= 1_000_000
        ? raw.cardCounterPricePerGameCoins
        : null,
    cardCounterPricePerHourCoins:
      typeof raw?.cardCounterPricePerHourCoins === 'number' &&
      Number.isSafeInteger(raw.cardCounterPricePerHourCoins) &&
      raw.cardCounterPricePerHourCoins >= 0 &&
      raw.cardCounterPricePerHourCoins <= 1_000_000
        ? raw.cardCounterPricePerHourCoins
        : null,
    reliefAdpid: raw?.reliefAdpid ?? '',
    entryMultiplier:
      typeof raw?.entryMultiplier === 'number' ? raw.entryMultiplier : null,
    rechargeEnabled: raw?.rechargeEnabled === true,
    withdrawEnabled: raw?.withdrawEnabled === true,
    coinPerYuan: typeof raw?.coinPerYuan === 'number' ? raw.coinPerYuan : null,
    rechargePackages: Array.isArray(raw?.rechargePackages)
      ? raw.rechargePackages.filter((n): n is number => Number.isSafeInteger(n))
      : [],
    withdrawMinCoins:
      typeof raw?.withdrawMinCoins === 'number' ? raw.withdrawMinCoins : null,
    withdrawMaxCoinsPerOrder:
      typeof raw?.withdrawMaxCoinsPerOrder === 'number'
        ? raw.withdrawMaxCoinsPerOrder
        : null,
    withdrawDailyMaxCoins:
      typeof raw?.withdrawDailyMaxCoins === 'number'
        ? raw.withdrawDailyMaxCoins
        : null,
    withdrawReAuthEnabled: raw?.withdrawReAuthEnabled === true,
    // 多玩法（S5.4）：新服务端下发 `games`；缺省 = 旧服务端（只有斗地主可见）。
    games: raw?.games,
    version: raw?.version ?? 0,
  };
}

/**
 * 重新拉取一次配置并落 store（开始游戏页的「价格已更新」处置）。
 * 失败 ⇒ `false`（不写 fail-safe —— 调用方只需知道刷新没成功，不覆盖已有配置）。
 */
export async function refreshClientConfig(): Promise<boolean> {
  try {
    const res = await fetchClientConfig();
    if (res.code !== 0 || res.data === null || res.data === undefined) return false;
    useGameStore().setClientConfig(normalizeClientConfig(res.data));
    return true;
  } catch {
    return false;
  }
}
