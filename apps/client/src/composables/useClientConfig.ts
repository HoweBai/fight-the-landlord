import type { ClientConfig } from '@fight-the-landlord/protocol';
import type { ClientConfigState, RoomMode } from '../stores/game';
import { useGameStore } from '../stores/game';
import { fetchBootClientConfig, fetchClientConfig } from '../net/rest';
import { GAME_MODES } from '../gameModes';

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
  reliefThresholdCoins: null,
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
  agentInviteEnabled: false,
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
    reliefThresholdCoins:
      typeof raw?.reliefThresholdCoins === 'number' &&
      Number.isSafeInteger(raw.reliefThresholdCoins) &&
      raw.reliefThresholdCoins >= 1 &&
      raw.reliefThresholdCoins <= 1_000_000
        ? raw.reliefThresholdCoins
        : null,
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
    agentInviteEnabled: raw?.agentInviteEnabled === true,
    // 多玩法（S5.4）：新服务端下发 `games`；缺省 = 旧服务端（只有斗地主可见）。
    games: raw?.games,
    version: raw?.version ?? 0,
  };
}

/**
 * P1-12：**场次可用性修复**（原住在 `lobby.vue`，现上移为唯一真源）——
 * 服务端把**当前选中的**场次关掉了、而另一个开着 ⇒ 选中切到开着的那一个。
 *
 * 为什么必须共享：大厅的配置加载与 `refreshClientConfig()`（开始游戏页的价格刷新）
 * 都会写 store；只在其中一处修复，另一条路径就会让客户端继续发已被关闭的
 * `mode`（必然撞服务端 12010 —— 客户端**已知**的事实不该送出去撞墙）。
 * 两个都关 ⇒ 保持原值（空态不渲染任何入口，没有「送出去」这一说）。
 */
export function repairRoomMode(): void {
  const store = useGameStore();
  const enabled: RoomMode[] = [];
  if (store.activeFreeRoomEnabled) enabled.push('random');
  if (store.activeGoldRoomEnabled) enabled.push('gold');
  if (enabled.length > 0 && !enabled.includes(store.roomMode)) {
    store.setRoomMode(enabled[0]!);
  }
}

/**
 * 平行化：当前选中的玩法不再可玩（enabled ∧ 三入口至少一个）⇒ 切到第一个可玩玩法，
 * 并把底分修正到新玩法的档位表。全部不可玩 ⇒ 保持原值（空态不渲染任何入口）。
 */
export function repairActiveMode(): void {
  const store = useGameStore();
  const playable = GAME_MODES.filter((m) => store.gamePlayable(m.id));
  if (playable.length === 0) return;
  if (!store.gamePlayable(store.activeMode)) {
    store.setActiveMode(playable[0]!.id);
    const levels = store.activeLevels;
    if (
      store.selectedBaseScore === null ||
      !levels.some((l) => l.baseScore === store.selectedBaseScore)
    ) {
      store.setSelectedBaseScore(levels[0]?.baseScore ?? null);
    }
  }
}

/**
 * 代理分润（r3 Critical #1）：登录页在**无令牌**时拉公开启动配置。
 * 只落 `agentInviteEnabled`；**不**写 `clientConfigVersion`（避免冒充「全量配置已加载」）。
 * 失败 ⇒ false（调用方保持字段隐藏，注册照常）。
 */
export async function refreshInviteBootConfig(): Promise<boolean> {
  try {
    const res = await fetchBootClientConfig();
    if (res.code !== 0 || res.data === null || res.data === undefined) return false;
    useGameStore().setAgentInviteEnabled(res.data.agentInviteEnabled === true);
    return true;
  } catch {
    return false;
  }
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
    // P1-12：与大厅同一份修复 —— 管理端刚关掉当前场次时，下一次匹配不得再发旧 mode。
    repairActiveMode();
    repairRoomMode();
    return true;
  } catch {
    return false;
  }
}
