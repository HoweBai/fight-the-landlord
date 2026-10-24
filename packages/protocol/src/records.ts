/**
 * 记录片 T1：牌编码 codec —— **本仓唯一的「牌 ↔ 字符串」编码实现**。
 *
 * 用途：对局记录把三家手牌（17 张）与底牌（3 张）以**定长字符串**落库/过 RPC
 * （`game_records.bottom_cards CHAR(6)`、`game_record_players.hand CHAR(34)`），
 * 读写两侧（game-service 编码、conformance/查询面解码）都必须走这里。
 *
 * 口径（记录片规格 §2.1 逐字）：
 *  - 单张牌 = 1 字节 `r*5+s`，**定长 2 位小写 hex**（零填充）；
 *  - 合法集 = `{3–14,17,20,30} × {0–4}` ⇒ 包络 **15–154**；
 *    ⚠️ **包络内存在非法值**（如 75 = r15、155 则是包络外）——合法性以
 *    `decode → re-encode == 原值` 复核，解码只做 `floor(v/5)/v%5` 是不够的；
 *  - `encodeHand` 恰 17 张 ⇒ 34 字符；`encodeCards` 恰 3 张 ⇒ 6 字符；
 *    张数不符 / 值域外 / 非法值 ⇒ 抛 `ProtocolError`（中文原因）。
 *
 * ⚠️ 牌的**点数编码**（DouZero：2 = 17）不在这里——唯一真源是 `./codec`，
 *    本文件只做「牌 ↔ 字节串」的打包/解包，合法性从 `isValidDouZeroCard` 取。
 */
import { isValidDouZeroCard } from './codec';
import { ProtocolError } from './validate'; // 真实位置 `validate.ts:24-29`（errors.ts 无此导出）
import type { Card } from './views';

/** 一张牌 → 1 字节（调用方保证已校验）。 */
const cardByte = (card: Card): number => card.r * 5 + card.s;

/** 一张牌 → 定长 2 位小写 hex（零填充；`15 ⇒ "0f"`、`154 ⇒ "9a"`）。 */
const cardHex = (card: Card): string => cardByte(card).toString(16).padStart(2, '0');

/**
 * 张数前置条件 + 逐张合法性检查，再编码。`label` 只用于中文原因（如「手牌」「底牌」）。
 */
function encodeStrict(
  cards: Card[],
  expected: number,
  fnName: string,
  label: string,
): string {
  if (!Array.isArray(cards) || cards.length !== expected) {
    const got = Array.isArray(cards) ? `${cards.length} 张` : typeof cards;
    throw new ProtocolError(`${fnName} 需要恰好 ${expected} 张${label}，收到 ${got}`);
  }
  return cards
    .map((card, i) => {
      if (typeof card !== 'object' || card === null) {
        throw new ProtocolError(`${fnName}：第 ${i + 1} 张不是牌对象 {r, s}`);
      }
      if (!isValidDouZeroCard(card.r)) {
        throw new ProtocolError(
          `${fnName}：第 ${i + 1} 张的 r=${String(card.r)} 不是合法牌值（合法集 {3–14,17,20,30}）`,
        );
      }
      if (!Number.isInteger(card.s) || card.s < 0 || card.s > 4) {
        throw new ProtocolError(`${fnName}：第 ${i + 1} 张的 s=${String(card.s)} 必须是 0–4 的整数`);
      }
      return cardHex(card);
    })
    .join('');
}

/** 手牌 ⇒ 定长 hex；缺省 17 张（斗地主），跑得快传 16/12。 */
export function encodeHand(hand: Card[], expected = 17): string {
  return encodeStrict(hand, expected, 'encodeHand', '手牌');
}

/** 底牌 ⇒ 定长 hex；缺省 3 张（斗地主）；跑得快无底牌，不调用。 */
export function encodeCards(cards: Card[], expected = 3): string {
  return encodeStrict(cards, expected, 'encodeCards', '底牌');
}

/**
 * 定长字符串 ⇒ 恰 `expectedCards` 张牌。
 *
 * 复核顺序（规格 §2.1）：① 定长；② 每 2 字符必须是 hex；
 * ③ 字节解出的 `r` 必须在合法集内（拦 75、155 这类「包络内外的非法值」）；
 * ④ **`decode → re-encode == 原值`**（拦大写等非规范形态——定长小写是落库口径）。
 */
function decodeStrict(s: string, expectedChars: number, expectedCards: number, fnName: string): Card[] {
  if (typeof s !== 'string' || s.length !== expectedChars) {
    const got = typeof s === 'string' ? `${s.length} 字符` : typeof s;
    throw new ProtocolError(
      `${fnName} 需要 ${expectedChars} 字符的牌编码串（${expectedCards} 张 × 2 位 hex），收到 ${got}`,
    );
  }
  const cards: Card[] = [];
  for (let i = 0; i < expectedCards; i++) {
    const pair = s.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new ProtocolError(`${fnName}：第 ${i + 1} 张的编码「${pair}」不是 2 位 hex`);
    }
    const v = Number.parseInt(pair, 16);
    const r = Math.floor(v / 5);
    const suit = v % 5;
    if (!isValidDouZeroCard(r)) {
      throw new ProtocolError(
        `${fnName}：第 ${i + 1} 张的字节 ${v} 不是合法牌值（r=${r} 不属于 {3–14,17,20,30}；包络 15–154 内存在非法值）`,
      );
    }
    cards.push({ r, s: suit });
  }
  // 合法性复核（规格 §2.1 的写死口径）：decode → re-encode == 原值
  const reencoded = cards.map(cardHex).join('');
  if (reencoded !== s) {
    throw new ProtocolError(
      `${fnName}：输入不是规范形态（decode → re-encode 得到「${reencoded}」≠ 原值）——要求定长 2 位小写 hex`,
    );
  }
  return cards;
}

/** 定长 hex ⇒ 手牌；缺省 17 张（斗地主），跑得快传 16/12。 */
export function decodeHand(s: string, expected = 17): Card[] {
  return decodeStrict(s, expected * 2, expected, 'decodeHand');
}

/** 定长 hex ⇒ 底牌；缺省 3 张（斗地主）。 */
export function decodeCards(s: string, expected = 3): Card[] {
  return decodeStrict(s, expected * 2, expected, 'decodeCards');
}

/* ------------------------------------------------------------------ *
 * 跑得快战绩（S6.3 契约 / spec §4.9.2）
 *
 * 与斗地主 `MyRecord` **不同形状**（pdk 单独建表，D11）：没有地主/农民/底牌，
 * 带 `remaining`（按座位剩余张数）、`playedCount`（实际出牌张数）与倍数标记。
 * 客户端历史页按 `gameType` 判别渲染；旧客户端只查斗地主表。
 * ------------------------------------------------------------------ */

/** 跑得快一局记录里的一名玩家（按座位升序）。 */
export interface PdkRecordPlayer {
  seat: number;
  /** 昵称快照；null ⇒ 页面回落「玩家{seat}」/「我」。 */
  nickname: string | null;
  scoreChange: number;
  won: boolean;
  /** 本局实际打出的张数（关牌判定依据；服务端写入）。 */
  playedCount: number;
  /** 初始手牌（16 或 12 张）。 */
  hand: Card[];
}

/** 一局跑得快战绩（服务端 `GET /api/records/mine?gameType=paodekuai` 的列表项）。 */
export interface PdkRecord {
  gameType: 'paodekuai';
  roomCode: string;
  playerCount: 2 | 3 | 4;
  mode: 'random' | 'practice' | 'gold';
  /** epoch ms（服务端已转毫秒整数）。 */
  endedAt: number;
  baseScore: number;
  /** 按座位升序。 */
  winnerSeats: number[];
  /** 按座位升序；赢家为 0。 */
  remaining: number[];
  multiplier: number;
  bombCount: number;
  guan: boolean;
  spring: boolean;
  baobenSeats: number[];
  /** 按座位升序，零和。 */
  scoreChanges: Array<{ seat: number; delta: number }>;
  /** 我那一行的座位（服务端 JOIN 命中行）。 */
  mySeat: number;
  /** 我那一行的金币变动；null = 非金币场 / 未回写。 */
  moneyDelta: number | null;
  /** 按座位升序。 */
  players: PdkRecordPlayer[];
}
