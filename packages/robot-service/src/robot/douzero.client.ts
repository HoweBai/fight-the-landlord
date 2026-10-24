// packages/robot-service/src/robot/douzero.client.ts
import { Injectable, Logger } from '@nestjs/common';
import type { DouZeroModel } from './models';

/**
 * douzero 服务地址（**单一真源**：别再在别处二次读 env 或另抄一遍默认值）。
 * 片② 起导出 —— 可用性探测（Task 4B / A6）直接 import 它。
 */
export const DOUZERO_URL = process.env.DOUZERO_URL ?? 'http://localhost:2021';
const TIMEOUT_MS = 5000;

export interface DouZeroContext {
  /**
   * 片② D2（用户裁决 5）：三档 = 三个模型。档位 → 模型的映射在 `BotPlayer`（`MODEL_BY_SKILL`），
   * 这里**只透传**，不做决策。
   */
  model: DouZeroModel;
  position: 'landlord' | 'landlord_down' | 'landlord_up';
  hand: number[];
  bottomCards: number[];
  lastMove: number[];
  lastMovePosition: string;
  numCardsLeft: Record<string, number>;
  playedCards: Record<string, number[]>;
  actionSeq: number[][];
}

interface DouZeroRequestBody {
  /**
   * 片② D2：模型目录名（`douzero/models/<model>/` 逐字）。**必填、不给默认** ——
   * douzero 侧「不带 `model`」≡ 显式 `douzero_WP`（设计 §5.2/J33）⇒ 一旦「声明了却没填」，
   * 三档里只有中间档碰巧正确、其余两档**静默**拿到 WP。与 `must_play` 同款的防线：
   * 类型必填（这里是防线的一半）+ 契约键清单看门狗（另一半在 douzero.client.test.ts）。
   */
  model: string;
  position: string;
  hand: number[];
  bottom_cards: number[];
  last_move: number[];
  last_move_position: string;
  num_cards_left: Record<string, number>;
  played_cards_landlord: number[];
  played_cards_landlord_down: number[];
  played_cards_landlord_up: number[];
  card_play_action_seq: number[][];
  /**
   * 🔴 **必填，不得退回可选**（2026-09-29 修掉的真缺陷）。
   *
   * `server.py:150` 是 `data.get("must_play", True)`，而 `:174` 用它决定
   * **合法动作集**：`rival_move = [] if must_play else last_move`
   * ⇒ 传 `True` = 按**自由首出**算（合法集 = 手里的**所有**牌，且 **`[]`（过牌）不在其中**）。
   *
   * 旧实现把它声明成 `must_play?: boolean` 却**从不赋值** ⇒ 恒取缺省 `True` ⇒
   * ① DouZero **结构上永远无法过牌**（`gen_moves()` 只产非空动作）——
   *    而 `bot.player.ts` 里「空数组 = 明确 pass 意图」那段处理因此是**死代码**；
   * ② 跟牌时它从「手里所有牌」里挑价值最高的一手 ⇒ 可能压不上一手 ⇒ 被 game-service 拒
   *    （`Invalid move - cannot beat last hand`，近 24h 实测 **93 / 1371 ≈ 6.8%**）
   *    ⇒ **静默降级成规则引擎** ⇒ advanced 机器人频繁表现得和规则机器人一样笨。
   *
   * ⚠️ **类型改成必填是防线的一半**：可选字段「声明了却没填」对 `tsc` 合法 ⇒ 拦不住。
   * 另一半在 `test/douzero.client.test.ts`（三条行为判据 + 一条「请求体不得含 undefined」看门狗）。
   */
  must_play: boolean;
}

@Injectable()
export class DouZeroClient {
  private readonly logger = new Logger(DouZeroClient.name);

  async getMove(context: DouZeroContext): Promise<number[]> {
    try {
      const body: DouZeroRequestBody = {
        model: context.model,
        position: context.position,
        hand: context.hand,
        bottom_cards: context.bottomCards ?? [],
        last_move: context.lastMove ?? [],
        last_move_position: context.lastMovePosition ?? '',
        num_cards_left: context.numCardsLeft ?? {},
        played_cards_landlord: context.playedCards?.landlord ?? [],
        played_cards_landlord_down: context.playedCards?.landlord_down ?? [],
        played_cards_landlord_up: context.playedCards?.landlord_up ?? [],
        card_play_action_seq: context.actionSeq ?? [],
        /**
         * 「有没有上一手要压」——`last_move` 为空 ⟺ 自由首出 / 牌权刚回到手里。
         *
         * 判据来源（**不是猜的**）：`shared` 的 `handlePass` 在**两家连续过牌**时把
         * `lastPlayedHand` 置 `null`（`packages/shared/src/ddz/play.ts:157`，同时把
         * `currentPlayer` 交还给最后出牌者）⇒ 那一拍 `features.lastMove` 就是 `[]`。
         * 两侧同源（`features.ts:83` 由 `session.lastPlayedHand` 投影）⇒ 这里判空即正确。
         *
         * 语义对照：`True` = 必须出牌、合法集是手里的所有牌；`False` = 可以过牌、
         * 合法集只剩「压得过的牌 + 炸弹 + `[]`」。
         */
        must_play: (context.lastMove ?? []).length === 0,
      };

      const response = await fetch(`${DOUZERO_URL}/decide_play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        // 片② D7：非 200 时 body 里是 douzero 的失败原因（如「模型未加载」）⇒
        // **先读出来带上**再抛，否则运维只看到裸状态码文本，归因要多打一圈日志。
        const detail = await response.text().catch(() => '');
        throw new Error(`DouZero HTTP ${response.status}: ${response.statusText} ${detail}`.trim());
      }

      const data = await response.json();
      return data.action ?? [];
    } catch (error: any) {
      this.logger.error(`DouZero call failed: ${error.message}`);
      throw error;
    }
  }
}
