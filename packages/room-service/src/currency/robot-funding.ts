// packages/room-service/src/currency/robot-funding.ts
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_GAME_TYPE, ErrCode, type CurrencyEntryIn, type GameType } from '@fight-the-landlord/protocol';
import { CurrencyClient, CurrencyServiceError } from './currency.client';
import { ConfigCacheService } from '../config/config-cache.service';
import type { SettleRobotHook } from './settle.service';
import {
  currencyRobotEnsureFailedTotal,
  currencyRobotTopupTotal,
} from '../metrics/room.metrics';

/**
 * ② 金币场 T6：**机器人资金面**（规格 §6 水位派生 + §7 ensure / 结算后动作）。
 *
 * ─── 三个正交面 ────────────────────────────────────────────────────────
 *  ① `robotWaterLevels(botId, top)`（规格 §6 **逐字**）：由 `sha256(botId)` 前 16 字节
 *     大端四段派生的三条水位（补给线 / 目标 / 回收线）。**纯函数、确定性**（同 botId
 *     永恒同值 —— 重启/多实例一致，这是「同观测 ⇒ 同 actionId ⇒ replayed 不双补」的根基）。
 *     `top = max(baseScoreLevels) × entryMultiplier`（默认 1200×10=12000）。
 *  ② `ensureBots(botIds)`（规格 §7 上半）：金币场 `fillBots` 内、`game.start` 前 ——
 *     观测余额，缺失或低于补给线的补到 `target`。**失败 ⇒ 抛**（调用方走既有补位失败
 *     路径：`fillBots` 返回 null ⇒ 不开局 ⇒ 匹配路径 cancel + attempts+1）。
 *  ③ `afterSettle(balances)`（规格 §7 下半）：结算收尾第 ③ 步钩子（`SETTLE_ROBOT_HOOK`
 *     的**本体** —— `currency.module.ts` 以 `useExisting` 指向本类；接口由
 *     `settle.service.ts` 的 `SettleRobotHook` 钉死，本类 `implements` 之、编译期兜底）。
 *     以 apply 响应 `balanceAfter` 为准：低于补给线 ⇒ 补；高于回收线 ⇒ 回收至 target。
 *     **fail-open**：逐座独立 try/catch（一间房的失败不得吞掉另一座的动作），只记 WARN + 指标。
 *
 * ─── 幂等锚（规格 §7 逐字）──────────────────────────────────────────────
 * `actionId = rr:<botId>:<target>:<观测余额|0>`（补给）/ `rc:<botId>:<target>:<观测>`
 * （回收）。同观测重复触发 ⇒ **同 id 同载荷** ⇒ 下游 replayed（不双补）——
 * 这也是「ensure 后未上桌（开局失败/房间取消/N36）：补款留账户，下轮复用」的机制：
 * 下一轮的观测已 ≥ 补给线 ⇒ 直接跳过；若观测仍低于线（余额在两次观测间漂移），
 * 也是新观测 ⇒ 新 id，照实补差。
 *
 * ─── 池账户（规格 §7）───────────────────────────────────────────────────
 * `owner_id='robot-pool'`、`owner_type='robot'`；池种子/充值 = 管理面 runbook（⚙️11）。
 * 池余额不足（14001）⇒ WARN + 指标（不是程序错误，是运营事件 —— 但**失败就是失败**：
 * ensure 路径照抛，结算后路径照 fail-open）。
 *
 * ─── 指标（规格 §11.1）──────────────────────────────────────────────────
 * 名称六组已在 T5 的 `room.metrics.ts` 注册（**本文件只加写点**，绝不二次注册 ——
 * 同名重复注册 ⇒ 进程启动即崩）：
 *  - `currency_robot_topup_total{action}`：**新的**（非 replayed）补款/回收各计一次
 *    —— replayed 意味着这笔钱早已动过，再计就会让「补给/回收速率」虚高（runbook 用它
 *    判断池资金方向）；
 *  - `currency_robot_ensure_failed_total`：ensure 失败（抛之前）与结算后动作失败
 *    （fail-open 兜底）各计一次 —— 一处失败 = 一次计数。
 *
 * ⚠️ **DI 值导入纪律**：`CurrencyClient` / `ConfigCacheService` 是构造参数上的类引用 ——
 * `import type` 会被擦除 ⇒ 真容器启动即崩（单测直接 `new` 看不见）。
 * ⚠️ 本文件**不发 RPC**（无 `.send(`）：两条边都经 `CurrencyClient` 的封装
 * （meta/超时/错误语义在那里统一 —— `meta-on-every-rpc-send` 闸扫的是那一处）。
 */

/** 虚拟池账户（规格 §7 逐字；池种子/充值 runbook 用同一 ownerId）。 */
export const ROBOT_POOL_OWNER_ID = 'robot-pool';
/** 资金面的 ownerType（规格 §7：池与机器人**都是** 'robot' —— 与人类 'user' 的类型闸隔离）。 */
export const ROBOT_FUNDING_OWNER_TYPE = 'robot' as const;
/** 写边 source（规格 §4/§7；上限 2^31−1 的 source 化档位见 protocol §8）。 */
export const ROBOT_FUNDING_SOURCE = 'robot_pool';

/**
 * `top` 的下界（规格 §6 不变量的前提：**任意 top ≥ 15** 下
 * `refillLine < target < recallLine` 且三值 %100≠0）。
 * 配置推导出的 top 落到 15 以下 ⇒ 水位不可用 ⇒ **响亮失败**（ensure 抛 / afterSettle
 * fail-open），绝不带着破掉不变量的水位去动钱。
 */
export const ROBOT_WATER_MIN_TOP = 15;

/** 三条水位（规格 §6 逐字：补给线 / 目标 / 回收线）。 */
export interface RobotWaterLevels {
  refillLine: number;
  target: number;
  recallLine: number;
}

/**
 * `sha256(input)` 前 16 字节 → 四个**大端** `uint32`（规格 §6 逐字）。
 * 服务端用 `node:crypto`（不受客户端依赖面约束 —— protocol 里那份纯 TS sha256
 * 是为浏览器侧准备的，与本处互不相干）。
 */
export function sha256Uint32x4(input: string): [number, number, number, number] {
  const digest = createHash('sha256').update(input, 'utf8').digest();
  return [
    digest.readUInt32BE(0),
    digest.readUInt32BE(4),
    digest.readUInt32BE(8),
    digest.readUInt32BE(12),
  ];
}

/**
 * 机器人水位派生（规格 §6 **逐字**；纯函数）。
 *
 * ```ts
 * nudge = (v) => v % 100 === 0 ? v + 1 : v             // 非整百修正（含整千）
 * refillLine = nudge(floor(top*1.025) + h1 % (floor(top*0.05)+1))
 * target     = nudge(floor(top*1.15)  + h2 % (floor(top*0.2) +1) + h3 % 97)
 * recallLine = nudge(floor(target*2.8) + h4 % (floor(target*0.4)+1))
 * ```
 *
 * 口径边界（规格 §6「对 J10 的诚实化」）：非整百只对三个**派生水位**成立 ——
 * 余额随对局输赢漂移（步长 = 底分×倍数），整百偶发、与人类同形。
 */
export function robotWaterLevels(botId: string, top: number): RobotWaterLevels {
  const [h1, h2, h3, h4] = sha256Uint32x4(botId);
  const nudge = (v: number): number => (v % 100 === 0 ? v + 1 : v);
  const refillLine = nudge(Math.floor(top * 1.025) + (h1 % (Math.floor(top * 0.05) + 1)));
  const target = nudge(Math.floor(top * 1.15) + (h2 % (Math.floor(top * 0.2) + 1)) + (h3 % 97));
  const recallLine = nudge(Math.floor(target * 2.8) + (h4 % (Math.floor(target * 0.4) + 1)));
  return { refillLine, target, recallLine };
}

/** 结算后动作的入参（= T5 `SettleRobotHook` 的形状：只含**有** `balanceAfter` 的机器人座）。 */
export interface RobotBalanceAfter {
  botId: string;
  balanceAfter: number;
}

/**
 * 机器人资金面服务（DI 装配见 `currency.module.ts`；`StartModule` 经 `CurrencyModule`
 * 拿到**同一个单例** —— `RoomStartService.fillBots` 的 ensure 边也走这里）。
 */
@Injectable()
export class RobotFunding implements SettleRobotHook {
  private readonly logger = new Logger(RobotFunding.name);

  constructor(
    private readonly currency: CurrencyClient,
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * 金币场开局前注资（规格 §7 上半）。空列表 ⇒ 零调用（房满、无机器人座）。
   *
   * 失败语义：**任何失败都抛**（get 失败 / apply 失败 / top 不可推导）——
   * 调用方（`fillBots` 的 catch）据此走既有补位失败路径。抛之前先记
   * `currency_robot_ensure_failed_total` + ERROR（含 botIds），失败原因不丢。
   */
  async ensureBots(
    botIds: readonly string[],
    gameType: GameType = DEFAULT_GAME_TYPE,
  ): Promise<void> {
    if (botIds.length === 0) return;
    try {
      const top = await this.computeTop(gameType);
      const { balances } = await this.currency.get({ ownerIds: [...botIds] });
      const observed = new Map(balances.map((b) => [b.ownerId, b]));
      for (const botId of botIds) {
        const entry = observed.get(botId);
        // 契约：`exists=false` 时 balance 就是 0；条目缺失同样按 0 观测（读路径不建行）。
        const balance = entry && entry.exists ? entry.balance : 0;
        const { refillLine, target } = robotWaterLevels(botId, top);
        if (entry && entry.exists && balance >= refillLine) continue;
        await this.applyFunding('refill', botId, target, balance);
      }
    } catch (err) {
      currencyRobotEnsureFailedTotal.inc();
      this.logger.error(
        `Robot ensure failed for [${botIds.join(',')}]: ${this.describeError(err)}`,
      );
      throw err;
    }
  }

  /**
   * 结算后动作（规格 §7 下半；T5 收尾第 ③ 步的**本体**）。
   *
   * 以 apply 响应 `balanceAfter` 为准逐座判定：低于补给线 ⇒ 补；高于回收线 ⇒ 回收至
   * `target`；带内 ⇒ 不动。**fail-open**：整函数绝不 reject —— 配置不可推导 / 单座失败
   * 都只记 WARN + `currency_robot_ensure_failed_total`，继续下一座（一间房的一步失败
   * 不得阻塞收尾链的其余部分，而收尾链自身另有 try/catch 兜底）。
   */
  async afterSettle(
    balances: RobotBalanceAfter[],
    gameType: GameType = DEFAULT_GAME_TYPE,
  ): Promise<void> {
    if (balances.length === 0) return;
    let top: number;
    try {
      top = await this.computeTop(gameType);
    } catch (err) {
      currencyRobotEnsureFailedTotal.inc();
      this.logger.warn(
        `Robot after-settle funding skipped (water levels underivable; fail-open): ${this.describeError(err)}`,
      );
      return;
    }
    for (const { botId, balanceAfter } of balances) {
      try {
        const { refillLine, target, recallLine } = robotWaterLevels(botId, top);
        if (balanceAfter < refillLine) {
          await this.applyFunding('refill', botId, target, balanceAfter);
        } else if (balanceAfter > recallLine) {
          await this.applyFunding('recall', botId, target, balanceAfter);
        }
        // 带内（refillLine ≤ balanceAfter ≤ recallLine）⇒ 不动 —— 正常路径。
      } catch (err) {
        currencyRobotEnsureFailedTotal.inc();
        this.logger.warn(
          `Robot after-settle funding failed for ${botId} (fail-open): ${this.describeError(err)}`,
        );
      }
    }
  }

  /**
   * `top = max(baseScoreLevels) × entryMultiplier`（规格 §6 逐字；**读最大档**，
   * 不是本房底分 —— 机器人在任何档位都拿同一套水位）。
   *
   * `baseScoreLevels()` 是 fail-closed 的（拿不到 ⇒ 抛 10007）⇒ 这里原样传播；
   * 推导值 < 15（不变量的前提）同样抛 —— 两条路径的失败语义由调用方决定。
   */
  private async computeTop(gameType: GameType = DEFAULT_GAME_TYPE): Promise<number> {
    const levels = await this.configCache.baseScoreLevels(gameType);
    const maxBaseScore = levels.reduce((max, level) => Math.max(max, level.baseScore), 0);
    const multiplier = this.configCache.entryMultiplier(gameType);
    const top = maxBaseScore * multiplier;
    if (!Number.isInteger(top) || top < ROBOT_WATER_MIN_TOP) {
      throw new Error(
        `robot water top=${top} underivable (max baseScore=${maxBaseScore} × entryMultiplier=${multiplier}; must be an integer ≥ ${ROBOT_WATER_MIN_TOP})`,
      );
    }
    return top;
  }

  /**
   * 一次资金动作（`currency.apply` 唯一写边）：
   *  - refill（池→机器人）：`x = target − 观测`，entries `[pool −x, bot +x]`，
   *    `actionId = rr:<botId>:<target>:<观测>`；
   *  - recall（机器人→池）：`x = 观测 − target`，entries `[bot −x, pool +x]`，
   *    `actionId = rc:<botId>:<target>:<观测>`。
   *
   * 两侧都带 `ownerType:'robot'`（类型闸隔离人类账户）；`refId = botId`（业务关联）。
   * 计量只在 **replayed=false** 时发生（同观测重复触发 = 钱早已动过，不重复计速率）。
   */
  private async applyFunding(
    action: 'refill' | 'recall',
    botId: string,
    target: number,
    observed: number,
  ): Promise<void> {
    const amount = action === 'refill' ? target - observed : observed - target;
    // 调用点的前置条件保证 amount ≥ 1（refill: observed < refillLine < target；
    // recall: observed > recallLine > target）——协议要求 delta ≠ 0，这里不设兜底。
    const entries: CurrencyEntryIn[] =
      action === 'refill'
        ? [
            { ownerId: ROBOT_POOL_OWNER_ID, ownerType: ROBOT_FUNDING_OWNER_TYPE, delta: -amount },
            { ownerId: botId, ownerType: ROBOT_FUNDING_OWNER_TYPE, delta: amount },
          ]
        : [
            { ownerId: botId, ownerType: ROBOT_FUNDING_OWNER_TYPE, delta: -amount },
            { ownerId: ROBOT_POOL_OWNER_ID, ownerType: ROBOT_FUNDING_OWNER_TYPE, delta: amount },
          ];
    const actionId = `${action === 'refill' ? 'rr' : 'rc'}:${botId}:${target}:${observed}`;
    const data = await this.currency.apply({
      actionId,
      source: ROBOT_FUNDING_SOURCE,
      refId: botId,
      entries,
    });
    if (data.replayed) {
      // 同 id 同载荷 ⇒ 下游幂等回放：钱**不**再动，速率指标也不再加 —— 但留一条日志
      //（「为什么这次没记账」要可解释）。
      this.logger.log(`Robot ${action} replayed (no double movement): ${actionId}`);
      return;
    }
    currencyRobotTopupTotal.inc({ action });
    this.logger.log(
      `Robot ${action}: ${botId} observed=${observed} → target=${target} (x=${amount}; ${actionId})`,
    );
  }

  /** 失败原因的人读化：池余额不足是**运营事件**（runbook 充值），单独点名。 */
  private describeError(err: unknown): string {
    if (err instanceof CurrencyServiceError && err.code === ErrCode.E_INSUFFICIENT_FUNDS) {
      return 'robot pool balance insufficient (14001) — runbook: top up the pool (admin wallet adjust, ≤1e6 per operation)';
    }
    return String(err);
  }
}
