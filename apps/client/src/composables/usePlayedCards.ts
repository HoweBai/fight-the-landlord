/**
 * 项 3：记牌器——累积「这一局已经打出过哪些牌」。
 *
 * **数据来源**：`PlayerView.recentActions`（协议 ④：斗地主窗口 2、跑得快按人数；旧→新、`cards: null` 表「不出」）。
 * 我们**只取 `cards !== null` 的条目**，把每张牌的 `r-s` 指纹塞进一个 Set 里。
 *
 * ⚠️ **固有限制（必须在注释里写死，不假装完美）**：
 *  `recentActions` 的窗口有限（斗地主 2、跑得快 2/3）⇒ **重连后，窗口之外的历史出牌无法还原**。
 *  结果是「已打出」集合偏小 ⇒ 「外面剩余」数字**只可能高估，不可能低估**。
 *  这是协议不给完整 actionLog 的代价（docs/design.md §4.4：永不出站 `actionLog`），
 *  客户端没有任何办法绕过——除非协议开后门，而那是禁区。
 *
 * ⚠️ **绝不做规则判断**：本文件只做「把出现过的牌记下来」这件事，不碰 canBeat /
 * parseHand / HandType（source-boundary ⑤ 闸）。记牌器的显示层（剩余张数）由消费方
 * 用 `总数 − 我手牌 − 已打出` 自己算，那是算术，不是规则。
 */
import { effectScope, ref, watchEffect } from "vue";
import type { Card } from "@fight-the-landlord/protocol";
import { useGameStore } from "../stores/game";
import { cardKey } from "../game/card-key";

/** 一张牌的唯一指纹：`${r}-${s}`。DouZero 编码下王的 s=4，r=20/30 ⇒ 各自唯一。 */
type CardKey = string;
const keyOf = (c: Card): CardKey => cardKey(c);

export interface PlayedCardsTracker {
  /** 已打出牌的指纹集合（**普通 Set**，直接读写）。 */
  played: Set<CardKey>;
  /** 判断某张牌是否已打出。 */
  has: (card: Card) => boolean;
  /** 已打出的总张数（响应式：读它即订阅变更）。 */
  size: number;
  /** 清空（换局时由 watch 自动触发，也暴露给消费方显式复位）。 */
  reset: () => void;
}

let singleton: PlayedCardsTracker | null = null;
/** detached scope 的停止器（测试复位专用；生产不调用 —— 单例活到应用结束）。 */
let disposeTracker: (() => void) | null = null;

export function usePlayedCards(): PlayedCardsTracker {
  if (singleton) return singleton;

  const store = useGameStore();
  /**
   * **故意用普通 Set + 独立 tick ref**，而不是 `reactive(new Set())`：
   * Vue 3.5 下，响应式 Set 代理在「闭包内读写」与「通过宿主对象属性读写」之间
   * 会出现读到两个不同快照的割裂（闭包里 size=4、通过属性读 size=0）—— 这是
   * 响应式集合代理与普通对象属性交互的实坑。普通 Set 没有代理层，读写永远是
   * 同一份数据；`tick` 专门承担「通知订阅者重算」的职责。
   */
  const played = new Set<CardKey>();
  const tick = ref(0);
  const bump = (): void => {
    tick.value++;
  };

  let lastRoomCode = store.roomCode;

  /**
   * 🔴 **detached scope**（记牌器片修复）：`watchEffect` 在组件 `setup` 内同步创建时会被
   * 收进组件的 effect scope，牌桌页一 `reLaunch` 卸载就停摆；而单例仍被复用 ⇒ 第二局起
   * 累积器「活着但瞎了」（旧牌残留、新牌不进）。`effectScope(true)` 与组件生命周期解耦，
   * 单例跨页面存活；测试复位时显式 `stop()`。
   */
  const scope = effectScope(true);
  scope.run(() => {
    // 单一 watchEffect：追踪配置开关、recentActions（吃牌）与 roomCode（换局清空）。
    // 自动追踪 ⇒ 不依赖「watch 源一定触发」的假设；flush:sync ⇒ 快照一到立即更新。
    watchEffect(
      () => {
        // 开关关闭 ⇒ 清空并跳过累积（不白跑；旧页面留下的单例同样受控）。
        if (!store.cardCounterEnabled) {
          if (played.size > 0) {
            played.clear();
            bump();
          }
          return;
        }
        const code = store.roomCode;
        if (code !== lastRoomCode) {
          lastRoomCode = code;
          if (played.size > 0) {
            played.clear();
            bump();
          }
        }
        // 读 recentActions 建立依赖；视图一换就重扫（Set 幂等）。
        const actions = store.recentActions;
        let changed = false;
        for (const a of actions) {
          if (!a.cards) continue;
          for (const c of a.cards) {
            const k = keyOf(c);
            if (!played.has(k)) {
              played.add(k);
              changed = true;
            }
          }
        }
        if (changed) bump();
      },
      { flush: "sync" },
    );
  });
  disposeTracker = () => scope.stop();

  singleton = {
    played,
    has: (c) => played.has(keyOf(c)),
    /** 读 `tick.value` 建立响应式依赖，再返回真实张数。 */
    get size() {
      void tick.value;
      return played.size;
    },
    reset: () => {
      if (played.size > 0) {
        played.clear();
        bump();
      }
    },
  };
  return singleton;
}

/** 仅供测试：停止 detached scope 并销毁单例（跨用例需复位，与 reporter / audio 的测试复位口同范式）。 */
export function __resetPlayedCardsForTest(): void {
  disposeTracker?.();
  disposeTracker = null;
  singleton = null;
}

/**
 * 按点数统计某手牌中各点数的张数（纯算术，给记牌器面板用）。
 */
export function countByRank(cards: readonly Card[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cards) m.set(c.r, (m.get(c.r) ?? 0) + 1);
  return m;
}

/** 点数显示顺序：3…A、2、小王、大王（DouZero 3..14, 17, 20, 30）。 */
export const CARD_RANK_ORDER: readonly number[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];

/** 每个点数在一副牌里的总张数：普通点数 4，王 1。 */
export const TOTAL_PER_RANK: ReadonlyMap<number, number> = new Map(
  CARD_RANK_ORDER.map((r) => [r, r === 20 || r === 30 ? 1 : 4]),
);

/**
 * 计算每个点数「外面还剩几张」。
 * 剩余 = 总数 − 我手牌里的张数 − 已打出的张数。
 * ⚠️ 底牌（bottomCards）**不减**——它在地主手里，属于「外面」。
 */
export function computeRemaining(
  myHand: readonly Card[],
  played: Set<CardKey>,
): Map</** rank */ number, /** remaining */ number> {
  const handCounts = countByRank(myHand);
  const playedCounts = new Map<number, number>();
  for (const key of played) {
    const r = Number(key.split("-")[0]);
    playedCounts.set(r, (playedCounts.get(r) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (const r of CARD_RANK_ORDER) {
    const total = TOTAL_PER_RANK.get(r) ?? 0;
    const inHand = handCounts.get(r) ?? 0;
    const playedCount = playedCounts.get(r) ?? 0;
    out.set(r, Math.max(0, total - inHand - playedCount));
  }
  return out;
}

/**
 * 校验：所有点数的「我手牌 + 已打出 + 剩余」之和恒等于 54（一副牌总数）。
 * 仅供测试 / 开发期自检，生产不调用。
 */
export function __debugTotalConservation(myHand: readonly Card[], played: Set<CardKey>): number {
  let sum = 0;
  const remaining = computeRemaining(myHand, played);
  const handCounts = countByRank(myHand);
  const playedCounts = new Map<number, number>();
  for (const key of played) {
    const r = Number(key.split("-")[0]);
    playedCounts.set(r, (playedCounts.get(r) ?? 0) + 1);
  }
  for (const r of CARD_RANK_ORDER) {
    sum += (handCounts.get(r) ?? 0) + (playedCounts.get(r) ?? 0) + (remaining.get(r) ?? 0);
  }
  return sum;
}
