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
  isMahjongSettlementResult,
  isPdkSettlementResult,
  type MahjongPlayerView,
} from '@fight-the-landlord/protocol';
import { useGameStore } from '../stores/game';
import { playCue, cueForBid, cueForPass } from '../audio';
import { cueForPlay } from '../audio/play-cues';
import { cueForPdkPlay } from '../audio/pdk-play-cues';
import { haptic } from '../feedback/haptics';
import { meldKey, parseMeldKey, type ParsedMeldKey } from '../game/mahjong-keys';

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
      // 麻将没有「报单/报双」（张数 13/14 恒定），直接跳过。
      if (store.gameType === 'mahjong') {
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

  // ── 麻将（T9）：局首洗牌 / 首次发牌 / 副露 / 胡 / 回合 / 出牌 ──────────────
  /**
   * 只比较服务端视图的**增量事实**：新增的碰/明杠/暗杠、已胡人数上涨、手牌/弃牌增长。
   * 挂载后第一版只登记、不补播（与 bootstrap 同一条纪律）。
   *
   * 副露 key 带**座位**（`meldKey` = `${seat}:${kind}:${首张 type}`）：同一座位、同一牌型
   * 才算同一条副露 ⇒ 「碰→杠」可判为补杠（MjGang），跨座的同牌直杠仍是刮风（MjGuafeng）。
   */
  const mahjongMeldKeys = (v: MahjongPlayerView | null): string[] =>
    (v?.melds ?? []).flatMap((melds, seat) => melds.map((m) => meldKey(seat, m)));

  /**
   * 局首谓词（与 Board 的 `dealEpoch` 同一口径）：本局第一版（version === 1）
   * 且仍处于换三张 / 定缺。v>1 只可能是中途挂载 / 重连 ⇒ 不补洗牌。
   */
  const isMahjongGameStart = (v: MahjongPlayerView): boolean =>
    v.version === 1 && (v.state === 'exchange' || v.state === 'lack');

  let lastMjMelds = new Set(mahjongMeldKeys(store.mahjongView));
  let lastMjHu = (store.mahjongView?.huInfos ?? []).length;
  let lastMjHandLen = (store.mahjongView?.hand ?? []).length;
  let lastMjDiscards = (store.mahjongView?.discards ?? []).map((d) => d.length);
  let lastMjClaims = (store.mahjongView?.claimsForMe ?? []).length;
  let lastMjCurrent = store.mahjongView?.currentPlayer ?? null;
  let lastMjPhase = store.mahjongView?.state ?? null;
  /**
   * 「首次 play ⇒ MjDeal」的每局 latch：同一局只响一次；中途挂载（v>1）直接置位
   * （重连不补发牌声），新局（v1 exchange/lack）或 null→view 时重置。
   */
  let mjDealPlayed = false;

  /** 首版 / null→view：只登记游标；局首（v1 exchange|lack）补一声洗牌。 */
  function seedMahjong(v: MahjongPlayerView): void {
    lastMjMelds = new Set(mahjongMeldKeys(v));
    lastMjHu = (v.huInfos ?? []).length;
    lastMjHandLen = (v.hand ?? []).length;
    lastMjDiscards = (v.discards ?? []).map((d) => d.length);
    lastMjClaims = (v.claimsForMe ?? []).length;
    lastMjCurrent = v.currentPlayer;
    lastMjPhase = v.state;
    mjDealPlayed = !isMahjongGameStart(v);
    // 局首（v1 exchange/lack）补一声洗牌；v>1 的中途挂载/重连不补。
    if (isMahjongGameStart(v)) playCue('MjShuffle');
  }

  let mjBootstrapped = store.mahjongView !== null;
  // setup 时已有局首视图（页面重挂载）⇒ 立刻洗牌；已有 v>1 视图 ⇒ seed（不补播）。
  if (store.mahjongView) seedMahjong(store.mahjongView);

  watch(
    () => store.mahjongView,
    (v) => {
      if (!v) {
        // 视图清空（换局 / 离桌）⇒ 下一版按首次挂载处理（null→view 的局首照常播）。
        mjBootstrapped = false;
        return;
      }
      if (!mjBootstrapped) {
        mjBootstrapped = true;
        seedMahjong(v);
        return;
      }
      if (store.settlement) return; // 结算锁：终局后不再播副露 / 胡 / 出牌
      const prev = lastMjMelds;
      const melds = mahjongMeldKeys(v);
      /**
       * 上一版的「碰」集合：从**解析后**的 key 构造（`seat:tileType`），
       * 不按 `${seat}:peng:${type}` 的字符串格式反拼 —— 格式只由 `meldKey` 决定。
       */
      const prevPongs = new Set(
        [...prev]
          .map((key) => parseMeldKey(key))
          .filter((k): k is ParsedMeldKey => k?.kind === 'peng')
          .map((k) => `${k.seat}:${k.tileType}`),
      );
      for (const key of melds) {
        if (prev.has(key)) continue;
        const parsed = parseMeldKey(key);
        if (!parsed) continue;
        if (parsed.kind === 'peng') playCue('MjPeng');
        else if (parsed.kind === 'angang') playCue('MjRain');
        else {
          // 同座同牌的碰升级为补杠 ⇒ 通用杠声；其余新杠 ⇒ 刮风。
          playCue(
            prevPongs.has(`${parsed.seat}:${parsed.tileType}`) ? 'MjGang' : 'MjGuafeng',
          );
        }
        haptic('light');
      }
      if ((v.huInfos ?? []).length > lastMjHu) {
        playCue('MjHu');
        haptic('heavy');
      }
      // 新局（v1 换三张/定缺）⇒ 重置本局的首次 play 发牌 latch。
      if (isMahjongGameStart(v)) mjDealPlayed = false;
      const firstPlay = v.state === 'play' && !mjDealPlayed;
      if (firstPlay) {
        mjDealPlayed = true;
        playCue('MjDeal');
      }
      // 摸牌：手牌增长且**不是**首次 play 的发牌视野 ⇒ 理牌声。
      if ((v.hand ?? []).length > lastMjHandLen && !firstPlay) playCue('MjSort');
      // 碰/杠/胡提示：claimsForMe 从无到有（服务端算好的候选）⇒ 理牌声。
      if (lastMjClaims === 0 && (v.claimsForMe ?? []).length > 0) playCue('MjSort');
      const mySeat = store.mySeat ?? v.seat;
      // 自己出牌：**我的**弃牌数组增长才响（服务端确认后的视图 diff，不在 emit 路径补回声）。
      // 出牌是轻响的 MjSort（v5 §2.3 / v6 §4 裁定，不播 MjDeal）。
      // 不按相位过滤：出牌后若有人可碰/杠/胡，同一版视图的 state 已是 `claim`，弃牌仍是我出的。
      if (
        ((v.discards ?? [])[mySeat]?.length ?? 0) > (lastMjDiscards[mySeat] ?? 0)
      ) {
        playCue('MjSort');
        haptic('light');
      }
      // 回合切换：轮到我（play）⇒ 轻震一次（进入 play 那一版也算）。
      if (
        v.state === 'play' &&
        v.currentPlayer === mySeat &&
        (lastMjPhase !== 'play' || lastMjCurrent !== mySeat)
      ) {
        haptic('light');
      }
      lastMjMelds = new Set(melds);
      lastMjHu = (v.huInfos ?? []).length;
      lastMjHandLen = (v.hand ?? []).length;
      lastMjDiscards = (v.discards ?? []).map((d) => d.length);
      lastMjClaims = (v.claimsForMe ?? []).length;
      lastMjCurrent = v.currentPlayer;
      lastMjPhase = v.state;
    },
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
      // 麻将：赢家座位 + 花猪集合都是服务端字段；花猪按输处理。
      if (isMahjongSettlementResult(s)) {
        if (store.mySeat !== null) {
          const won =
            s.winnerSeats.includes(store.mySeat) && !s.huazhuSeats.includes(store.mySeat);
          playCue(won ? 'Win' : 'Lose');
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
