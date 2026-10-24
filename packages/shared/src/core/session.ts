/**
 * 玩法无关的会话基类（多玩法片 S1）。
 *
 * ⚠️ 这是**形状基类**，不是规则引擎：它只列两种玩法共有的字段；
 * ddz 的 `bidPhase`/`playPhase`/`bottomCards` 等仍留在 `ddz/types.ts`，
 * pdk 的 `lastPlayedHand`/`unusedCards` 等留在 `pdk/types.ts`。
 *
 * `P` 是牌元泛型位：首版 ddz/pdk 都实例化为 `Card`；麻将以后可用 `Tile`。
 */
import type { Card, GameType } from '@fight-the-landlord/protocol';

export interface GamePlayerBase<P = Card> {
  id: string;
  seat: number;
  hand: P[];
  isBot: boolean;
  isOffline: boolean;
  /** 连续超时次数（挂机治理 C1）。 */
  timeoutCount: number;
  /** 是否托管（规则引擎代打）。 */
  trustee: boolean;
}

export interface ActionLogEntryBase<P = Card> {
  version: number;
  seat: number;
  cards: P[];
  kind: 'play' | 'pass';
}

export interface GameSessionBase<P = Card> {
  roomCode: string;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  /** 玩法自己的状态机值（ddz: init/bidding/playing/ended；pdk: playing/ended）。 */
  state: string;
  players: GamePlayerBase<P>[];
  currentPlayer: number;
  turnDeadlineAt: number;
  version: number;
  actionLog: ActionLogEntryBase<P>[];
  createdAt: number;
  finishedAt: number | null;

  // ── 服务端内部字段（永不出站；两种玩法共用） ──
  /** 机器人内部 ID，按座位索引；人类为 undefined。 */
  botIds?: Array<string | undefined>;
  /** 机器人难度，按座位索引。 */
  botSkillLevels?: Array<'beginner' | 'intermediate' | 'advanced' | undefined>;
  /** 机器人基础手速（ms），按座位索引。 */
  botThinkingSpeeds?: Array<number | undefined>;
  /** 发牌后、动作前的初始手牌冻结快照（记录用）。 */
  initialHands?: P[][];
  /** 开局时的玩法规则快照（pdk 用；ddz 不用）。 */
  rules?: unknown;
}
