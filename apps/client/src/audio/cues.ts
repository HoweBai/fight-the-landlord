/**
 * cue 名 → 音频文件名的**纯数据**表（R698 + spec §10 的例外 + 用户裁决 U4）。
 *
 * ⚠️ **这里没有、也不该有任何牌型判定**：表只把「已经发生的事」翻译成一个文件名。
 * 「什么时候算发生了」由调用方决定（`src/audio/index.ts` 的 `cueForBid`/`cueForPass`，
 * 以及 `composables/useTableSound.ts` 的视图 diff）。
 *
 * ⚠️ **牌型播报（50 条）已全量接入**（2026-10-22 用户裁决 U5-2）：
 * 选择逻辑在 `play-cues.ts`（`parseHand` → cue 名），本表只放文件名。
 * 牌型判定只用于**选哪条音效**，不用于合法性 / 胜负判断。
 *
 * 项 6（小程序分包）：除大厅 BGM（`MusicEx_Welcome`，主包 `/static/audio/`）外，
 * 全部牌桌音效都在**牌桌分包** `/pages/table/static/audio/` —— 不进牌桌不下载、
 * 不占微信主包 2MB。
 */

/** 牌桌分包音频根（项 6）。 */
const TABLE_AUDIO = '/pages/table/static/audio';

export const CUES = {
  /** 抢（按座位取变体：seat 0/1/2 → Rob1/2/3）。 */
  Rob1: `${TABLE_AUDIO}/Woman_Rob1.mp3`,
  Rob2: `${TABLE_AUDIO}/Woman_Rob2.mp3`,
  Rob3: `${TABLE_AUDIO}/Woman_Rob3.mp3`,
  /** 叫地主（`kind='call'` + 抢；U5 恢复）。 */
  Order: `${TABLE_AUDIO}/Woman_Order.mp3`,
  /** 不抢 / 不叫。 */
  NoOrder: `${TABLE_AUDIO}/Woman_NoOrder.mp3`,
  /** 过牌（按座位取变体；3 个座位用 1–3）。 */
  Buyao1: `${TABLE_AUDIO}/Woman_buyao1.mp3`,
  Buyao2: `${TABLE_AUDIO}/Woman_buyao2.mp3`,
  Buyao3: `${TABLE_AUDIO}/Woman_buyao3.mp3`,
  /** 报单（剩 1 张）/ 报双（剩 2 张）—— §6.5-2。 */
  Baojing1: `${TABLE_AUDIO}/Woman_baojing1.mp3`,
  Baojing2: `${TABLE_AUDIO}/Woman_baojing2.mp3`,
  /** 大小王**单张**出牌。 */
  SingleLittleJoker: `${TABLE_AUDIO}/Woman_100.mp3`,
  SingleBigJoker: `${TABLE_AUDIO}/Woman_200.mp3`,
  // ── 牌型播报（50 条，U5-2）；序号与素材一致：3..14 = 3..A，15 = 2 ──────────
  Single3: `${TABLE_AUDIO}/Woman_3.mp3`,
  Single4: `${TABLE_AUDIO}/Woman_4.mp3`,
  Single5: `${TABLE_AUDIO}/Woman_5.mp3`,
  Single6: `${TABLE_AUDIO}/Woman_6.mp3`,
  Single7: `${TABLE_AUDIO}/Woman_7.mp3`,
  Single8: `${TABLE_AUDIO}/Woman_8.mp3`,
  Single9: `${TABLE_AUDIO}/Woman_9.mp3`,
  Single10: `${TABLE_AUDIO}/Woman_10.mp3`,
  Single11: `${TABLE_AUDIO}/Woman_11.mp3`,
  Single12: `${TABLE_AUDIO}/Woman_12.mp3`,
  Single13: `${TABLE_AUDIO}/Woman_13.mp3`,
  Single14: `${TABLE_AUDIO}/Woman_14.mp3`,
  Single15: `${TABLE_AUDIO}/Woman_15.mp3`,
  Pair3: `${TABLE_AUDIO}/Woman_dui3.mp3`,
  Pair4: `${TABLE_AUDIO}/Woman_dui4.mp3`,
  Pair5: `${TABLE_AUDIO}/Woman_dui5.mp3`,
  Pair6: `${TABLE_AUDIO}/Woman_dui6.mp3`,
  Pair7: `${TABLE_AUDIO}/Woman_dui7.mp3`,
  Pair8: `${TABLE_AUDIO}/Woman_dui8.mp3`,
  Pair9: `${TABLE_AUDIO}/Woman_dui9.mp3`,
  Pair10: `${TABLE_AUDIO}/Woman_dui10.mp3`,
  Pair11: `${TABLE_AUDIO}/Woman_dui11.mp3`,
  Pair12: `${TABLE_AUDIO}/Woman_dui12.mp3`,
  Pair13: `${TABLE_AUDIO}/Woman_dui13.mp3`,
  Pair14: `${TABLE_AUDIO}/Woman_dui14.mp3`,
  Pair15: `${TABLE_AUDIO}/Woman_dui15.mp3`,
  Trio3: `${TABLE_AUDIO}/Woman_tuple3.mp3`,
  Trio4: `${TABLE_AUDIO}/Woman_tuple4.mp3`,
  Trio5: `${TABLE_AUDIO}/Woman_tuple5.mp3`,
  Trio6: `${TABLE_AUDIO}/Woman_tuple6.mp3`,
  Trio7: `${TABLE_AUDIO}/Woman_tuple7.mp3`,
  Trio8: `${TABLE_AUDIO}/Woman_tuple8.mp3`,
  Trio9: `${TABLE_AUDIO}/Woman_tuple9.mp3`,
  Trio10: `${TABLE_AUDIO}/Woman_tuple10.mp3`,
  Trio11: `${TABLE_AUDIO}/Woman_tuple11.mp3`,
  Trio12: `${TABLE_AUDIO}/Woman_tuple12.mp3`,
  Trio13: `${TABLE_AUDIO}/Woman_tuple13.mp3`,
  Trio14: `${TABLE_AUDIO}/Woman_tuple14.mp3`,
  Trio15: `${TABLE_AUDIO}/Woman_tuple15.mp3`,
  Straight: `${TABLE_AUDIO}/Woman_shunzi.mp3`,
  PairStraight: `${TABLE_AUDIO}/Woman_liandui.mp3`,
  Plane: `${TABLE_AUDIO}/Woman_feiji.mp3`,
  TrioWithSingle: `${TABLE_AUDIO}/Woman_sandaiyi.mp3`,
  TrioWithPair: `${TABLE_AUDIO}/Woman_sandaiyidui.mp3`,
  FourWithTwo: `${TABLE_AUDIO}/Woman_sidaier.mp3`,
  FourWithTwoPairs: `${TABLE_AUDIO}/Woman_sidailiangdui.mp3`,
  Bomb: `${TABLE_AUDIO}/Woman_zhadan.mp3`,
  Rocket: `${TABLE_AUDIO}/Woman_wangzha.mp3`,
  /** 胜负。 */
  Win: `${TABLE_AUDIO}/MusicEx_Win.mp3`,
  Lose: `${TABLE_AUDIO}/MusicEx_Lose.mp3`,
  /** BGM（循环）。 */
  BgmTable: `${TABLE_AUDIO}/MusicEx_Normal.mp3`,
  /** 大厅 BGM 在**主包**（进厅即播，不能等分包）。 */
  BgmLobby: '/static/audio/MusicEx_Welcome.mp3',
} as const;

export type CueName = keyof typeof CUES;
