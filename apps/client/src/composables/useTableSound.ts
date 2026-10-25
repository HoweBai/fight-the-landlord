/**
 * 把牌桌的**视图变化**译成音效（spec 2026-10-22 · U5 / R698 / §6.5-2）。
 *
 * ## ⚠️ 这里没有任何规则判定（§12 哑终端）
 *
 * 全部输入都是服务端已经下发的数字 / 字段，本 composable 只做「与上一版比，谁变了」
 * 这一件事。牌型识别只用于**选哪条音效**（斗地主 `cueForPlay`、跑得快
 * `cueForPdkPlay`），不判断合法性 / 胜负 / 倍数。
 *
 * ## 两个来源要分清
 *
 * · **视图 diff**（`cardCounts` / `recentActions` / `settlement` / `bidPhase.decisions`）——
 *   服务端事实；
 * · **本地回声**已全部退役：叫抢走 `decisions`（协议⑦），过牌走 `recentActions.cards === null`。
 *
 * ## 播放优先级（同一 flush 内后注册者最后执行）
 *
 * bootstrap → 出牌/过牌 → 报单/报双 → 胜负 → 叫抢。
 * 后执行的 cue 会打断前一条（U5-3），因此警示与胜负压过牌型播报。
 * ⚠️ 该顺序只在**同一 setup、默认 pre flush** 下成立，不得跨消息依赖。
 */
import { watch } from 'vue';
import {
  isPdkSettlementResult,
} from '@fight-the-landlord/protocol';
import { useGameStore } from '../stores/game';
import { playCue, cueForBid, cueForPass } from '../audio';
import { cueForPlay } from '../audio/play-cues';
import { cueForPdkPlay } from '../audio/pdk-play-cues';
import { haptic } from '../feedback/haptics';

export function useTableSound(): void {
  const store = useGameStore();

  /** `recentActions` 的指纹（斗地主窗口 2、跑得快按人数；只看内容，不看数组引用）。 */
  const actionsKey = (): string =>
    store.recentActions
      .map((a) => `${a.seat}:${a.cards === null ? 'pass' : a.cards.map((c) => c.r).join('.')}`)
      .join(',');

  /**
   * 上一版的 `cardCounts`（报单 / 报双看的是**跃迁**，不是当前值）。
   * ⚠️ 放 composable 内而不是模块级：模块级会带着上一局的状态进新挂载。
   */
  let lastCounts: number[] | null = store.view ? [...store.cardCounts] : null;
  let lastActionsKey = actionsKey();
  let playedDecisions = store.ddzBidPhase?.decisions?.length ?? 0;
  /** 挂载后第一版快照只登记、不播（重连 / 重挂载不补播历史）。 */
  let bootstrapped = store.view !== null;

  // ── bootstrap：必须注册在动作 watcher 之前（同一 flush 内先对齐游标）────────
  watch(
    () => store.view,
    (v) => {
      if (!v || bootstrapped) return;
      bootstrapped = true;
      lastActionsKey = actionsKey();
      lastCounts = [...store.cardCounts];
      playedDecisions = store.ddzBidPhase?.decisions?.length ?? 0;
    },
  );

  // ── 出牌 / 过牌（所有座位）：`recentActions` 最新一条 ─────────────────────
  watch(actionsKey, (key) => {
    if (!bootstrapped) {
      lastActionsKey = key;
      return;
    }
    if (key === lastActionsKey) return;
    lastActionsKey = key;
    if (store.settlement) return; // 结算锁：终局后不再播牌型 / 过牌
    const newest = store.recentActions[store.recentActions.length - 1];
    if (!newest) return;
    if (newest.cards === null) {
      cueForPass(newest.seat);
      return;
    }
    /**
     * 跑得快（2026-10-25）：复用斗地主素材的牌型播报
     *（点数/三带一/顺子/连对/飞机/四带二/炸弹）；王/王炸/叫抢不接。
     */
    if (store.gameType === 'paodekuai') {
      const cue = cueForPdkPlay([...newest.cards], store.pdkRules);
      if (cue) playCue(cue);
      return;
    }
    const cue = cueForPlay(newest.cards);
    if (cue) playCue(cue);
  });

  // ── 报单 / 报双（§6.5-2）：`cardCounts` 的**下降跃迁** ──────────────────
  // 注册在动作 watcher 之后 ⇒ 同一更新里它最后响，打断牌型播报（U5-3 的优先级）。
  watch(
    () => store.cardCounts.join(','),
    () => {
      const now = [...store.cardCounts];
      // 结算锁：终局后不再播报单/报双（与牌型播报同一锁）。
      if (store.settlement) {
        lastCounts = now;
        return;
      }
      if (lastCounts) {
        now.forEach((count, seat) => {
          if (count === lastCounts![seat]) return;
          if (count === 1) {
            playCue('Baojing1');
            /* 报单（最强警示）：长震；报双：短震。开关与静音互不影响。 */
            haptic('heavy');
          } else if (count === 2) {
            playCue('Baojing2');
            haptic('medium');
          }
        });
      }
      lastCounts = now;
    },
    { immediate: true },
  );

  // ── 胜负：结算载荷出现 ─────────────────────────────────────────────────
  watch(
    () => store.settlement,
    (s) => {
      if (!s) return;
      // pdk：赢家座位在 `winnerSeats` 里（服务端字段，不推导）。
      if (isPdkSettlementResult(s)) {
        if (store.mySeat !== null) {
          playCue(s.winnerSeats.includes(store.mySeat) ? 'Win' : 'Lose');
        }
        return;
      }
      /**
       * `SettlementResult.winner` 说的是**哪一方赢**（`'landlord' | 'farmer'`），
       * 不是「我赢了没有」。用两个服务端字段对一下即可选音，这不是规则计算。
       */
      const iAmLandlord = s.landlordSeat === store.mySeat;
      const iWon = (s.winner === 'landlord') === iAmLandlord;
      playCue(iWon ? 'Win' : 'Lose');
    },
  );

  // ── 叫抢（协议⑦）：`decisions` **增长**时为新增的几条播对应音效 ──────────
  watch(
    () => store.ddzBidPhase?.decisions?.length ?? 0,
    (n) => {
      if (store.settlement) return;
      // 流局重发 ⇒ decisions 清空（长度回落）⇒ 游标归零
      if (n < playedDecisions) playedDecisions = 0;
      const list = store.ddzBidPhase?.decisions ?? [];
      for (let i = playedDecisions; i < n; i += 1) {
        const d = list[i];
        if (!d) continue;
        cueForBid(d.kind, d.grab, d.seat);
      }
      playedDecisions = Math.max(playedDecisions, n);
    },
  );
}
