// packages/game-service/src/game/dto.ts
// R472：模块增强 `./game.types` 已整体删除 —— 内部形状归 shared，出站形状归契约包。
// 多玩法片 S1：`StartGameRequest`/`GameStartedResponse` 统一从 protocol 导入，
// 本文件不再保留第二份定义（避免 gameType/playerCount/rules/seed 被漏掉）。
import type { GameSessionBase } from '@fight-the-landlord/shared';
import type {
  GameStartedResponse,
  GameView,
  StartGameRequest,
} from '@fight-the-landlord/protocol';

export type { StartGameRequest, GameStartedResponse };

/** `game.snapshot` 的出参：**完整会话**（ddz/pdk 联合的基类形状），仅限服务间调用（§4.2）。 */
export type GameSnapshotResponse = GameSessionBase | null;

/** `game.view` 的出参：按座位裁剪的视图（§4.2 / §6.4）。 */
export type GameViewResponse = GameView | null;
