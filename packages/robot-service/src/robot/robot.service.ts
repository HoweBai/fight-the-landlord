// packages/robot-service/src/robot/robot.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type {
  BotInstance,
  GameType,
  RobotAcquireRequest,
  RobotAcquireResponse,
  RobotAvailabilityResponse,
  RobotDecideRequest,
  RobotDecideResponse,
  RobotReleaseRequest,
  RobotReleaseResponse,
} from '@fight-the-landlord/protocol';
import { DEFAULT_GAME_TYPE } from '@fight-the-landlord/protocol';
import { BotPlayer } from './bot.player';
import { RobotPool } from './robot.pool';
// 监控片 T5：决策收口计数（定义与值域见 robot.metrics.ts）。
import { robotDecisionsTotal } from './robot.metrics';
// ⚠️ **值导入**（不是 `import type`）：`emitDecoratorMetadata` 会把构造参数的类型写进
// DI 元数据 —— 类型导入会被编译掉 ⇒ Nest 拿到 `Object` 当 provider 记号 ⇒ **容器启动即崩**
// （单测与 tsc 都看不见，见本仓 DI 陷阱的踩坑记录）。
import { DouZeroHealth } from './douzero.health';
import { ConfigCacheService } from '../config/config-cache.service';

@Injectable()
export class RobotService {
  private readonly logger = new Logger(RobotService.name);

  /**
   * R135（S4）曾是「**没有** `BotPlayer` 注入」；切片 11 按 §4.2 的 `robot.decide` 重新接上
   * —— 但入参**不再是整份对局会话**，而是 `RobotDecideRequest{view, features}`
   * （§9.5 的可见信息边界；`test/no-session-boundary.test.ts` 是那条边界的机械闸）。
   *
   * 机器人的存储也从「进程内 `Map`（永不回收）」换成 **Redis 池**（§9.6/R201）：
   * 池在 `bot:pool:{gameType}`（ZSET），实例在 `bot:{botId}`（String(JSON)）。
   */
  constructor(
    private readonly botPlayer: BotPlayer,
    private readonly pool: RobotPool,
    private readonly health: DouZeroHealth,           // 片② D5
    /**
     * 片⑦ E4：**日志行**的 model 随 cache 同步（旧 `MODEL_BY_SKILL` 常量读点退役）。
     * ⚠️ 它**不是决策点** —— 决策路径的读点在 `BotPlayer.buildDouZeroContext()`
     * （J29 闸的白名单语义见 `no-switch-in-decision.gate.test.ts`）。
     */
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * 片② D5 的 `robot.availability`（room → robot）—— 房间侧门禁问「机器人能给吗」。
   * **只转发**：探测、六态判定与 5s 缓存都在 `DouZeroHealth`（`canProvide()` 永不抛）。
   */
  availability(gameType: GameType = DEFAULT_GAME_TYPE): Promise<RobotAvailabilityResponse> {
    /**
     * 多玩法（Task 2.6 / spec §4.8）：跑得快是**规则 bot**，不依赖 DouZero/模型 ⇒
     * 恒可给（新 bot 可按需创建；池容量不是门禁）。斗地主仍走 DouZero 六态探测。
     */
    if (gameType === 'paodekuai') return Promise.resolve({ canProvide: true });
    return this.health.canProvide();
  }

  /**
   * 机器人决策（§4.2 的 `robot.decide`，本片是内部 HTTP 过渡形态，R200）。
   * 只做**转发**：决策逻辑在 `BotPlayer`（§9.3 三档三模型 + C9 降级链）。
   */
  async decide(req: RobotDecideRequest): Promise<RobotDecideResponse> {
    const decision = await this.botPlayer.decide(req);
    // 监控片 T5（规格 §2.2）：**决策收口恰一次** —— `decision.source` 即 `result` 值域
    // `{douzero,rule}`；叫抢期恒 rule 是协议约定（Y4，不是失败信号——失败读
    // `robot_decision_errors_total`，写点在 BotPlayer 的两条回落路径）。
    robotDecisionsTotal.inc({ result: decision.source, skill: req.skillLevel });
    // 片② D10/规格 A2b：日志钉死 `model=<sl|douzero_WP|douzero_ADP>` —— 回退到规则引擎时，
    // `model` 记的是「本该用的那个模型」（否则回退占比不可归因）；`source=` 已有，不重复加。
    const model = this.configCache.modelBySkill()[req.skillLevel];
    this.logger.log(
      `Bot ${req.botId} decided ${decision.kind} (source=${decision.source}, model=${model}, cards=${decision.cards?.length ?? 0})`,
    );
    return decision;
  }

  /**
   * §9.6 第 1/2 条：`robot.acquire`（room → robot）。**幂等**（R201）——
   * 同一 `{roomCode, seat}` 重复调用返回**同一个** `BotInstance`，
   * 这正是 A7⑤ 的「失败重试 1 次」得以安全落地的前提。
   */
  async acquire(req: RobotAcquireRequest): Promise<RobotAcquireResponse> {
    const bots = await this.pool.acquire(
      req.roomCode,
      req.seats ?? [],
      req.gameType ?? DEFAULT_GAME_TYPE,
    );
    return { bots };
  }

  /** §9.6 归池：`robot.release`（room → robot）。玩法由池从 bot 记录推导，不信任调用方。 */
  async release(req: RobotReleaseRequest): Promise<RobotReleaseResponse> {
    const released = await this.pool.release(req.botIds ?? []);
    return { released };
  }

  /**
   * 旧入口的**兼容壳**：`POST /api/robots/create` 委托 `acquire`（**单一实现**，R207）。
   *
   * ⚠️ 它不再是「每次生成新 `bot-<uuid>`」的非幂等实现 —— 那正是 A7⑤ 当年不能重试的原因。
   */
  async createBot(roomCode: string, seat = 0): Promise<BotInstance> {
    const { bots } = await this.acquire({ roomCode, seats: [seat] });
    const bot = bots[0];
    if (!bot) throw new Error(`acquire returned no bot for ${roomCode} seat ${seat}`);
    return bot;
  }

  /** `GET /api/robots/list`：**池中空闲**的机器人（对局中的机器人在池外，故不在此列表）。 */
  async getAllBots(): Promise<BotInstance[]> {
    return this.pool.listIdle();
  }

  /** 兼容壳：`POST /api/robots/remove` 委托 `release`。 */
  async removeBot(botId: string): Promise<number> {
    const { released } = await this.release({ botIds: [botId] });
    return released;
  }

  /** 兜底回收（§9.6）：由 `RobotReclaimTask` 周期调用；测试与运维也可直接调。 */
  async reclaimIdleBots(): Promise<string[]> {
    return this.pool.reclaimIdle();
  }
}
