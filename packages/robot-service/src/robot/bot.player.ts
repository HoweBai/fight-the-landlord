// packages/robot-service/src/robot/bot.player.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  type DdzRobotFeatures,
  type PlayerView,
  type RobotDecideRequest,
  type RobotDecideResponse,
} from '@fight-the-landlord/protocol';
import { HandType, findSmallestBeatingCards } from '@fight-the-landlord/shared';
import { DouZeroClient, type DouZeroContext } from './douzero.client';
import { decidePdkBot, type PdkRobotDecideRequest } from './bots/pdk';
// 监控片 T5：失败计数（**失败路径恰一次**；reason 的有界值域与分类依据见该文件注释）。
import { classifyDouZeroFailure, robotDecisionErrorsTotal } from './robot.metrics';
// ⚠️ **值导入**（DI 陷阱纪律）：容器要按类型解析构造参数。
import { ConfigCacheService } from '../config/config-cache.service';

/** 斗地主决策路径的窄化入参（pdk 在 S3.6 之前由 decide 拒绝）。 */
type DdzRobotDecideRequest = RobotDecideRequest & {
  view: PlayerView;
  features: DdzRobotFeatures;
};

/**
 * 机器人决策（§4.2 的 `robot.decide`；C7/C8/C9 + §9.3 三档三模型）。
 *
 * **可见信息边界（§9.5）**：入参只有
 *  - `view` —— 与人类玩家**完全相同**的裁剪视图（自己的手牌 + 他人张数 + 上一手牌 + 底牌）；
 *  - `features` —— 由 game-service 从 `GameSession.actionLog` 投影出的**公开**特征。
 *
 * ⚠️ 本类**不接收** `GameSession`（R135/§9.5：那等于把三家手牌交给 AI），也不再自己造特征：
 * `playedCards` / `actionSeq` 全部来自 `features`（旧实现用「总牌堆 − 当前手牌」反推再倒序
 * 硬分配给三家 —— C8 的伪造形态，随本片删除）。
 */
@Injectable()
export class BotPlayer {
  private readonly logger = new Logger(BotPlayer.name);

  /**
   * 可注入的随机源（**仅测试**用；生产恒为 `Math.random`）。
   * ⚠️ 本片（片①）起**无消费者**：§9.3 的 `errorRate`「失误」机制随片① 删除
   * （那段逻辑只活在被删的 `decideBid` / `errorRateOf` 里）；片② 重建难度体系时再接。
   */
  random: () => number = Math.random;

  /**
   * 一次性告警闸（Minor 5，2026-09-28 评审）：`lastMoveMeta` **键缺失**只可能来自
   * **旧服务的混部**（本仓真被「常驻容器是旧镜像」咬过），而它在 `??` 兜底里与合法的
   * `null`（首出）**同形** ⇒ 机器人会**安静地**按首出决策。这里对 `undefined` 记一条
   * 一次性 WARN（只记一次，免得每次决策都刷屏）；`null` 是协议内取值，不记。
   */
  private warnedMissingLastMoveMeta = false;

  /**
   * 片⑦ E4（r1 计划审查 X-3）：**决策路径**的模型装配由此读 `ConfigCacheService`
   * —— `/admin` 改 `robot.modelBySkill` 后**发给 DouZero 的 model 真随动**
   * （若只接日志行，模型不随动而日志字面变化 = 静默无效）。
   */
  constructor(
    private readonly douzeroClient: DouZeroClient,
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * §4.2 / §9.4 的唯一入口。
   *
   * ⚠️ **动作是否合法由 game-service 裁判**（R206 末段）：本服务只做「明显非法」的自检
   * （空动作 / 牌不在自己的裁剪手牌里）；被 game-service 拒绝后由**它**回退规则引擎重决策。
   */
  async decide(req: RobotDecideRequest): Promise<RobotDecideResponse> {
    const view = req.view;
    if (view.gameType === 'paodekuai') {
      // 多玩法（Task 3.6）：pdk 走规则 bot（不调用 DouZero）。特征必须是 pdk 形状——
      // 旧服务/畸形载荷不得静默套用斗地主特征。
      if (req.features.gameType !== 'paodekuai' || !('pdkRules' in req.features)) {
        throw new Error(
          `paodekuai decide requires PdkRobotFeatures (bot ${req.botId})`,
        );
      }
      return decidePdkBot({ ...req, view, features: req.features } as PdkRobotDecideRequest);
    }
    // 片① R3：机器人在叫抢阶段**既不叫也不抢**（规格 §1-3）。
    // 叫抢没有 AI 模型可用（上游 kwai/DouZero 树里没有叫抢模型），
    // 而「按手牌强度抢」的策略已由用户裁决废除 ⇒ 恒 pass。
    if (view.state === 'bidding') return { kind: 'pass', source: 'rule' };
    // 多玩法（Task 2.6）：pdk 已在上面的分支拒绝；走到这里的一定是斗地主特征
    //（`RobotFeatures` 联合的判别位 = 玩法；旧服务缺 gameType 也按斗地主处理）。
    return this.decidePlay({ ...req, view, features: req.features as DdzRobotFeatures });
  }

  /**
   * 出牌决策（§9.3 三档三模型 + C9 的降级链）。
   *
   * 片② D1（用户裁决 1）：**不再按难度决定走不走 DouZero** —— 三档**一律**先问 DouZero，
   * 难度差异只体现在 `model`（`skillLevel` → `MODEL_BY_SKILL` 随请求下发）。
   *
   * ```
   * 三档一律先走 DouZero → douzero  ├─ 合法动作 ⇒ { kind:'play', source:'douzero' }
   *                                ├─ 空数组 ⇒ { kind:'pass', source:'douzero' }（明确 pass，不降级）
   *                                └─ 超时/HTTP 错/明显非法 ⇒ 落到规则引擎
   * 落到规则引擎 → rule            ├─ 有解 ⇒ { kind:'play', source:'rule' }
   *                                └─ 无解 ⇒ { kind:'pass', source:'rule' }
   * ```
   *
   * ⚠️ 旧实现是「DouZero 失败 ⇒ 直接 pass」（白送回合）；本实现**必须**回退规则引擎（C9/R206）。
   */
  private async decidePlay(req: DdzRobotDecideRequest): Promise<RobotDecideResponse> {
    try {
      const cards = await this.douzeroClient.getMove(this.buildDouZeroContext(req));
      if (cards.length === 0) {
        // DouZero 的空数组 = 明确的 pass 意图（协议约定），**不是**失败 ⇒ 不降级。
        // 顺序：空数组必须先判（`isPlausible` 对空数组恒假，混在一起会把 pass 误判成非法）。
        return { kind: 'pass', source: 'douzero' };
      }
      if (this.isPlausible(cards, req.view)) {
        return { kind: 'play', cards, source: 'douzero' };
      }
      // 监控片 T5：调用成功但返回不在手里的牌 = 一次失败的决策（回落规则引擎同已发生）。
      robotDecisionErrorsTotal.inc({ reason: 'douzero_invalid_cards' });
      this.logger.warn(
        `DouZero returned cards not in hand for bot ${req.botId}; falling back to rule engine`,
      );
    } catch (error) {
      // 监控片 T5：失败路径**恰一次** inc（reason 分档 = classifyDouZeroFailure）。
      // 超时（`DouZeroClient` 的 5s AbortSignal）/ HTTP 错 / 解析错：**一律回退规则引擎**
      robotDecisionErrorsTotal.inc({ reason: classifyDouZeroFailure(error) });
      this.logger.warn(
        `DouZero failed for bot ${req.botId}; falling back to rule engine: ${(error as Error).message}`,
      );
    }
    return this.ruleDecide(req);
  }

  /**
   * 规则引擎决策（§9.1 的四步；唯一实现是 `shared` 的 `findSmallestBeatingCards`）。
   *
   * - 跟牌（`lastMoveMeta !== null`）：① 同型最小可压 → ② 最小炸弹 → ③ 王炸 → ④ 无解 pass；
   * - 首出（`lastMoveMeta === null`）：打**最小单张**（与 §9.1 超时首出分支同口径）。
   */
  private ruleDecide(req: DdzRobotDecideRequest): RobotDecideResponse {
    // R696：`view.hand` 已经是 `Card[]` —— 旧的 `toCards()`（把点数**编造**成牌）
    // 已删除，与 `shared` 里删掉 `douzeroIntToCard` 是同一件事。
    /**
     * 跟牌目标读 `features.lastMoveMeta`（**Task A3**，协议 ④ 的连带面）：
     * 它是 game-service 由 `session.lastPlayedHand` 投影出的**规则字段**
     * （与 `playedCards` / `actionSeq` 同一来源）。
     *
     * 协议 ④ 之前这里读的是 `req.view.lastPlayedHand` —— 那是**显示字段**，已退役；
     * 本服务**按设计没有 `session`**（`no-session-boundary.gate`）⇒ 目标只能靠投影。
     * ⚠️ **不得**从 `view.recentActions` / `features.lastMove` 反推牌型/长度（明令禁止）。
     */
    const meta = req.features.lastMoveMeta;
    // 键缺失（`undefined`，只可能来自旧镜像的 RPC 载荷）≠ 首出（`null`）：前者**不得静默** ——
    // 一次性 WARN（见 `warnedMissingLastMoveMeta` 的声明注释）。合法 `null` 走同一兜底，不记。
    if (meta === undefined && !this.warnedMissingLastMoveMeta) {
      this.warnedMissingLastMoveMeta = true;
      this.logger.warn(
        `RobotDecideRequest.features.lastMoveMeta is missing for bot ${req.botId} ` +
          '(old service mixed deployment?); treating every turn as a first play',
      );
    }
    const target = meta ?? { type: HandType.Invalid, keyRank: 0, length: 0 };
    const beating = findSmallestBeatingCards(req.view.hand, target);
    if (beating && beating.length > 0) {
      // `RobotDecideResponse.cards` 是 rank-only（AI 契约，spec §4）⇒ 投影回点数。
      // 花色的补回由 **game-service** 的 `backfillSuits()` 统一做（单一落点）。
      return { kind: 'play', cards: beating.map((c) => c.r), source: 'rule' };
    }
    return { kind: 'pass', source: 'rule' };
  }

  /** `view` + `features` → DouZero 上下文；**不做任何推导**（C7/C8）。 */
  private buildDouZeroContext(req: DdzRobotDecideRequest): DouZeroContext {
    const { view, features } = req;
    return {
      // 片② D2：三档 = 三个模型，随请求下发（难度差异唯一的载体就是它）。
      // 片⑦ E4：映射现读配置快照（决策路径的唯一读点；`robot.service.ts` 的日志行不是它）。
      model: this.configCache.modelBySkill()[req.skillLevel],
      position: features.position,
      // ⚠️ **DouZero 上游结构上没有花色**（观测是 4×13 的「每个点数有几张」矩阵，
      // 见 spec §4）⇒ `DouZeroContext` 全程是 **rank-only**，这里是投影边界。
      hand: view.hand.map((c) => c.r).sort((a, b) => a - b),
      bottomCards: (view.bottomCards ?? []).map((c) => c.r),
      lastMove: [...features.lastMove],
      lastMovePosition: features.lastMovePosition,
      numCardsLeft: { ...features.numCardsLeft },
      playedCards: {
        landlord: [...features.playedCards.landlord],
        landlord_down: [...features.playedCards.landlord_down],
        landlord_up: [...features.playedCards.landlord_up],
      },
      actionSeq: features.actionSeq.map((a) => [...a]),
    };
  }

  /**
   * 「明显非法」的自检：非空，且每张牌都在自己的裁剪手牌里。
   *
   * ⚠️ **按点数多重集比对**，不是按 `(r, s)`：DouZero 给的是 **rank-only** 点数，
   * 它没有花色可对。花色由 **game-service** 的 `backfillSuits()` 从真实手牌里确定性挑出
   * （spec §4）—— 那才是权威校验（`handlePlayCards` 的精确摘除）。
   * 本函数只是**出站前的廉价自检**，不做也不该做权威判定。
   */
  private isPlausible(cards: number[], view: PlayerView): boolean {
    if (cards.length === 0) return false;
    const pool = view.hand.map((c) => c.r);
    for (const card of cards) {
      const idx = pool.indexOf(card);
      if (idx === -1) return false;
      pool.splice(idx, 1);
    }
    return true;
  }
}
