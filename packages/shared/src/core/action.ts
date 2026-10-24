/**
 * 玩法无关的动作联合（多玩法片 S1）。
 *
 * 线格式仍然是既有的 `game.bid` / `game.play` / `game.pass` 三条消息（D15：不新增消息类型）；
 * game-service 把它们归一化成这里的 `GameAction`，再交给对应 runtime。
 * pdk 只接受 `play`/`pass`；收到 `bid` ⇒ `13001`。
 */
import type { Card } from '@fight-the-landlord/protocol';

export type GameAction =
  | { kind: 'bid'; grab: boolean }
  | { kind: 'play'; cards: Card[] }
  | { kind: 'pass' };
