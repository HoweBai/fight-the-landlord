/**
 * 玩法目录（多玩法平台化的**单一静态真源**）。
 *
 * 约定（spec §4.2 / K3）：
 *  - 规范 id 只有 `doudizhu` / `paodekuai`；`ddz` 仅作为机器人池旧键别名，不在此处。
 *  - 只有 `undefined` / `null`（字段缺失）才缺省斗地主；空串/未知/`ddz` 一律抛错。
 *  - `supportedPlayerCounts` 是协议/房间/匹配的共用能力表；生产是否暴露 2/4 由
 *    配置 `game.paodekuai.twoPlayerEnabled` / `game.paodekuai.nonThreePlayerEnabled`
 *    分别闸住，不在这里硬编码。
 */
import { ProtocolError } from './validate';

export const GAME_TYPES = ['doudizhu', 'paodekuai'] as const;
export type GameType = (typeof GAME_TYPES)[number];
export const DEFAULT_GAME_TYPE: GameType = 'doudizhu';

export interface GameCapabilities {
  /** 是否支持记牌器（斗地主专属付费能力）。 */
  cardCounter: boolean;
  /** 是否支持机器人补位。 */
  bots: boolean;
  /** 是否支持金币场。 */
  goldRoom: boolean;
  /** 是否有牌型语音播报。 */
  voiceAnnouncements: boolean;
}

export interface GameMeta {
  readonly id: GameType;
  readonly name: string;
  /** 升序；首版跑得快 = [2, 3, 4]，斗地主 = [3]。 */
  readonly supportedPlayerCounts: readonly number[];
  readonly defaultPlayerCount: number;
  readonly capabilities: GameCapabilities;
}

export const GAME_META: Readonly<Record<GameType, GameMeta>> = {
  doudizhu: {
    id: 'doudizhu',
    name: '斗地主',
    supportedPlayerCounts: [3],
    defaultPlayerCount: 3,
    capabilities: {
      cardCounter: true,
      bots: true,
      goldRoom: true,
      voiceAnnouncements: true,
    },
  },
  paodekuai: {
    id: 'paodekuai',
    name: '跑得快',
    supportedPlayerCounts: [2, 3, 4],
    defaultPlayerCount: 3,
    capabilities: {
      cardCounter: false,
      bots: true,
      goldRoom: true,
      voiceAnnouncements: true,
    },
  },
};

export function isGameType(value: unknown): value is GameType {
  return typeof value === 'string' && (GAME_TYPES as readonly string[]).includes(value);
}

/**
 * 解析玩法 id。
 *
 * - `undefined` / `null` ⇒ `DEFAULT_GAME_TYPE`（旧载荷缺字段）；
 * - 空串、`ddz`、拼错的 id ⇒ `ProtocolError`（不得静默当斗地主）。
 */
export function parseGameType(value: unknown): GameType {
  if (value === undefined || value === null) return DEFAULT_GAME_TYPE;
  if (isGameType(value)) return value;
  throw new ProtocolError(
    `gameType must be one of ${GAME_TYPES.join(' | ')}, got ${JSON.stringify(value)}`,
  );
}

export function supportsPlayerCount(gameType: GameType, count: number): boolean {
  return GAME_META[gameType].supportedPlayerCounts.includes(count);
}
