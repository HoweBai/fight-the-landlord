// packages/user-service/src/risk/scan.service.ts
import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { runWithTrace } from '@fight-the-landlord/shared';
import { REDIS } from '../auth/token.service';
import {
  ConfigCacheService,
  RISK_SCAN_DEFAULT_INTERVAL_MS,
  SNAPSHOT_BOOT_WAIT_MS,
} from '../config/config-cache.service';
import {
  ReviewsService,
  riskBannedKey,
  RISK_BANNED_FLAG_TTL_SECONDS,
  RISK_USER_STATUS_SQL,
  type ScanReason,
} from './reviews.service';
import {
  riskReviewsOpen,
  riskScanLastSuccessTimestampSeconds,
  riskScanRunsTotal,
} from './risk.metrics';

/**
 * ⚠️ T6 归属迁移：`riskBannedKey` / `RISK_BANNED_FLAG_TTL_SECONDS` / `RISK_USER_STATUS_SQL`
 * 的**定义**已随管理动作（ban/unban 写面）落回 `reviews.service.ts`（单一真源；本文件对
 * reviews 是既有单向依赖，反向 import 成环 ⇒ 常量随写面走）。本处**再导出**保持既有
 * import 面不破（`test/risk-scan.test.ts` 与消费点仍从本文件导入）。
 */
export { riskBannedKey, RISK_BANNED_FLAG_TTL_SECONDS, RISK_USER_STATUS_SQL };

/** 默认扫描间隔（规格 §2.5-1：3600s）—— 唯一真源已迁 `ConfigCacheService`（本片 T4）；此处 re-export 保引用面。 */
export { RISK_SCAN_DEFAULT_INTERVAL_MS };
/** 启动后首轮延迟（规格 §2.5-1：30s；配置面只改**间隔**，不改它）。 */
export const RISK_SCAN_FIRST_RUN_DELAY_MS = 30_000;
/** 扫描锁键（规格 §2.3 逐字；单轮单实例）。 */
export const RISK_SCAN_LOCK_KEY = 'risk:scan:lock';
/** 扫描锁 TTL（规格 §2.5-1：EX 600 —— 只是持有者崩溃兜底；正常路径走 CAD 释放）。 */
export const RISK_SCAN_LOCK_TTL_SECONDS = 600;

/**
 * 胜率统计（规格 §2.5-2 **SQL1 逐字**；用户 join 写法照 `record.rpc.controller.ts:235-244`
 * 昵称快照先例——F7 订正先例指认）。`users.status='active'` 过滤 = banned 双保险
 * （banned 用户跳过统计是 ⚙️10 分支层的判定，这里是第二道）。
 */
export const RISK_WIN_RATE_SQL =
  "SELECT p.user_id, COUNT(*) AS games, SUM(p.won) AS wins FROM game_record_players p JOIN game_records r ON r.id=p.record_id JOIN users u ON u.id = p.user_id AND u.status='active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL GROUP BY p.user_id";

/**
 * 跑得快胜率统计（2026-10-25 **SQL1b**，spec §5.4 逐字）：独立两表 +
 * `p.seat = r.winner_seat` 判胜；过滤练习房、机器人行与已封禁账号，与斗地主同口径。
 * 行形状与 `RISK_WIN_RATE_SQL` 相同：`{ user_id, games, wins }`。
 */
export const RISK_WIN_RATE_PDK_SQL =
  "SELECT p.user_id, COUNT(*) AS games, SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id JOIN users u ON u.id = p.user_id AND u.status = 'active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL AND p.is_robot = 0 GROUP BY p.user_id";

/**
 * 设备数统计（规格 §2.5-2 **SQL2 逐字**；`? = now − risk.deviceWindowDays 天`）。
 * ⚠️ F1 修：**同样带 users 过滤**，防 banned 用户经此单边进入轮次。
 */
export const RISK_DEVICE_COUNT_SQL =
  "SELECT d.user_id, COUNT(DISTINCT d.device_id) AS devices FROM user_devices d JOIN users u ON u.id = d.user_id AND u.status='active' WHERE d.last_seen_at >= ? GROUP BY d.user_id";

/** 自愈名单（规格 §2.5-4 **SQL3 逐字**）：全部 `status='banned'` 用户。 */
export const RISK_BANNED_USERS_SQL = "SELECT id FROM users WHERE status='banned'";

// 自愈的**复核读**（`RISK_USER_STATUS_SQL`；规格 §2.5-4：写旗前复核最新 status，防
// 「扫描先读名单 → 人工解封 → 扫描后写旗」的复活竞态，设计 r1-F14）现定义于
// `reviews.service.ts` 并经上面再导出 —— T6 的 ban/unban 源态校验与它共用同一文本。

/** 轮末队列水位（`risk_reviews_open` gauge 的读面；规格 §2.5-5「轮末设」）。 */
const RISK_OPEN_COUNT_SQL = "SELECT COUNT(*) AS cnt FROM risk_reviews WHERE status='open'";

/** 一天毫秒（cutoff 换算；不做日期串解析 —— 全链 epoch ms 口径）。 */
const DAY_MS = 86_400_000;
/** 单命中项分值（规格 §2.5-2：命中项数 × 25 ⇒ score ∈ {0,25,50}）。 */
const SINGLE_HIT_SCORE = 25;

/** 单玩法胜率统计（SQL1 / SQL1b 的同形行，已 `Number()` 归一）。 */
interface GameWinStat {
  games: number;
  wins: number;
}

/** 并集内一个用户的统计：按玩法分开，设备数平台级。 */
interface MergedRiskStat {
  byGame: { doudizhu?: GameWinStat; paodekuai?: GameWinStat };
  devices: number;
}

/** 一轮的读数（日志之外的机械回执；测试与运维用）。 */
export interface RiskScanRoundResult {
  /** true = 锁没抢到、本轮整轮跳过（不统计、不写旗、不记 runs 指标）。 */
  skipped: boolean;
  /** 并集用户数（SQL1 ∪ SQL1b ∪ SQL2）。 */
  users: number;
  /** 本轮 score ≥ 25 的命中用户数。 */
  flagged: number;
}

/**
 * 风险扫描（风控片 T5 / 规格 §2.5 · §2.12 · ⚙️3/5/15/24 —— 检测链核心）。
 *
 * ─── 节奏（骨架逐字照 `records-cleanup.service.ts` 先例；本片 ⚙️5–⚙️7：
 *     间隔 = 配置第 38 键 `risk.scanIntervalMs`）──────────────────────────────
 *  - 默认间隔 **1h**（缺键/坏值/快照整体不可用 ⇒ 回落种子常数 —— 唯一真源 =
 *    `ConfigCacheService`）；**启动后 30s 首轮**（常数，不受配置影响）。间隔**排期处现读**
 *    （`resolveIntervalMs()` ⇒ `configCache.riskScanIntervalMs()`）—— 旧 env 注入面
 *    `RISK_SCAN_INTERVAL_MS` 已退役（本片 ⚙️8）。
 *  - 🔴 **自调度自重排**（`setTimeout` → 一轮跑完再排下一轮）：**当前一轮按旧值跑完 ⇒
 *    其后按现读的缓存值排期**（已排定的一轮不撤；改键最坏在「本间隔 + 新间隔」内生效 ——
 *    `setInterval` 无法承载「重排现读」的口径）。
 *  - 🔴 **首排动作**（本片 ⚙️5）：`onModuleInit` **同步返回**；`hasSnapshot()` 就绪 ⇒ 同帧
 *    解析+打+排；未就绪 ⇒ 有界等待 `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 两路经 **once 闸**
 *    汇入 `afterSnapshotReady()`（至多一次：超时后快照迟到 ⇒ 就绪路 no-op，败方定时器清除），
 *    超时路按缺省解析先排期、下一轮重排自愈。等待发生在**排期面**（不阻塞容器就绪）。
 *  - ⚠️ 配置的是**间隔**，不是首轮延迟：首轮恒在启动 30s 后（规格 §2.5-1 的两个数字是两条独立事实）。
 *
 * ─── 单轮形态（§2.5-1..6）─────────────────────────────────────────────────
 *  1. **抢锁**：`SET risk:scan:lock <实例id> NX EX 600`（⚙️3：拿不到 ⇒ debug 日志 +
 *     整轮跳过）；轮末 **compare-and-delete**（⚙️24：GET 值 == 本实例 id 才 DEL；
 *     EX 只是持有者崩溃兜底）。
 *  2. **统计**：SQL1（斗地主胜率）+ SQL1b（跑得快胜率）+ SQL2（设备数）→ 按玩法分组的内存并集
 *     （设备-only 用户 ⇒ 两玩法均无、hit1=false）；阈值/窗口每轮现读配置（见下）。
 *  3. **判定**：每个玩法独立 `games > 该玩法 minGames && winRate > 该玩法阈值`；
 *     `hit1 = 任一玩法命中`（两玩法同时命中**不叠分**）；`hit2 = devices > risk.deviceLimit`；
 *     `score = 命中项数 × 25`；reasons 每个命中玩法各一条（带 `gameType`），设备 reason 不变。
 *  4. **upsert**：并集**每个**用户都进 `ReviewsService.applyScanResult`（含 score=0 的
 *     用户 —— 规格 §2.5-2 括号：「score=0 ⇒ 本轮结束（**但**仍参与 … auto 旗回落
 *     判定）」；回落（throttled(auto) 的解限）只有让低分用户进状态机才触达）。
 *     ⚠️ **单用户失败不拖垮整轮**：per-user catch ⇒ warn 日志 + 跳过该用户（下一轮
 *     收敛；真库双会话下的 1213 形态即由此退化路径承接 —— progress 核销节有读数）。
 *     🔴 **全量失败例外（波2 F7）**：n > 0 且**全员**失败 ⇒ 本轮按**失败**处理
 *     （runs{fail} + 不刷 last_success + error 行）——否则系统性写故障会被 per-user
 *     catch 静默成「轮轮 ok」，RiskScanStalled 永不响。
 *  5. **自愈**（⚙️15）：SQL3 名单 → 逐人复核读 `SELECT status` → **仍 banned** 才
 *     `SET risk:banned:{id} '1' EX 7776000`（幂等；复核读防解封竞态）。
 *
 * ─── 指标（§2.12；定义见 `risk.metrics.ts`）───────────────────────────────
 *  `risk_scan_runs_total{result='ok'|'fail'}`（每轮结束分记；**锁跳过轮不算轮**）·
 *  成功轮 `risk_scan_last_success_timestamp_seconds.set(now/1000)`（失败轮不擦）·
 *  轮末 `risk_reviews_open` = open 计数。`onModuleInit` **先置 0**（「从未成功」语义 ⇒
 *  RiskScanStalled 必命中）**再**排首轮。
 */
@Injectable()
export class ScanService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ScanService.name);
  /** 自重排定时器（`setTimeout` 链；片⑦ 三处循环的同款形态）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸（照 `ConfigCacheService` / `rooms.reaper.ts` 的成例）：在途一轮的迟到自重排不得复活循环。 */
  private shuttingDown = false;
  /** 本实例的锁值（⚙️24 CAD 的比对基准；随进程一次性生成）。 */
  private readonly instanceId = randomUUID();

  constructor(
    /** ⚠️ `DataSource` 是**值导入** + 显式 `@Inject`（DI 陷阱纪律；本仓既有惯例）。 */
    @Inject(DataSource) private readonly dataSource: DataSource,
    /** ⚠️ 旗/锁面注入 = `REDIS` 令牌（`import type { Redis }` 成例）。 */
    @Inject(REDIS) private readonly redis: Redis,
    private readonly configCache: ConfigCacheService,
    private readonly reviews: ReviewsService,
  ) {}

  onModuleInit(): void {
    // 🔴 **先置 0**（「从未成功」语义 —— 首启 / 一直失败都要被 RiskScanStalled 命中）
    // **再**进首排动作（本片 ⚙️5；排首轮在其内）。顺序即语义，别对调（照 records-cleanup 先例）。
    riskScanLastSuccessTimestampSeconds.set(0);
    this.bootFirstScheduling();
  }

  /**
   * 首排动作（本片 ⚙️5，D2；`onModuleInit` **同步返回**，此处不阻塞容器就绪）：
   *
   * - **快路径（真同步）**：`hasSnapshot()` 就绪 ⇒ 同帧解析+打启动行+排首轮（不经 await/微任务）；
   * - **有界等待**：未就绪 ⇒ `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 超时/就绪两路经 **once 闸
   *   `settle`** 汇入（先到先赢、后到 no-op、败方定时器清除）。🔴 不可放宽：没有它，「超时后
   *   快照迟到」会二次排期（双链 —— `onApplicationShutdown` 只清得掉一个句柄，另一条链复活）；
   * - 降级拓扑（配置服务不可用）：≤10s 后按缺省解析先打行排期，下一轮重排自愈。
   */
  private bootFirstScheduling(): void {
    if (this.configCache.hasSnapshot()) {
      this.afterSnapshotReady(); // 快路径：同帧（真同步）
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.afterSnapshotReady();
    };
    const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
    void this.configCache.waitForFirstSnapshot().then(settle, settle);
  }

  /**
   * 首排动作**唯一落点**（快/超时/就绪 三路共用；once 闸保证至多一次 —— 见 `bootFirstScheduling`）。
   * 续体先查关停闸（照关停闸纪律）：关停发生在等待期间 ⇒ 迟到的续体不得打行/排期。
   * 解析（`resolveIntervalMs()`，与重排处同一入口）⇒ 打启动行（⚙️6 逐字，interval 位 = 解析值）
   * ⇒ 排首轮（`RISK_SCAN_FIRST_RUN_DELAY_MS` 常数 —— **配置的是间隔，不是首轮延迟**）。
   */
  private afterSnapshotReady(): void {
    if (this.shuttingDown) return;
    this.logger.log(
      `Risk scan loop started (first run in ${RISK_SCAN_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`,
    );
    this.scheduleNext(RISK_SCAN_FIRST_RUN_DELAY_MS);
  }

  /** 间隔解析（本片 ⚙️7）：启动行与重排处**同一入口**；内部 = 缓存键级 getter（现读）。 */
  private resolveIntervalMs(): number {
    return this.configCache.riskScanIntervalMs();
  }

  /** 排下一轮（30s 首轮常数 / 其后间隔 = 重排处现读 —— 见类注的「配置的是间隔」）。 */
  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => this.runRound(), delayMs);
  }

  /**
   * 定时器起的一轮：ALS 包裹（自建 id + `timer` 来源）→ 跑 → 失败留 error 行（指标
   * 的 fail 在 `runScanInner` 内记）→ 关停闸后自重排。
   */
  private runRound(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.runScanInner()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`risk scan failed: ${reason}`);
        })
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（否则循环在关停后「复活」）；
          // 间隔在**重排处现读**（本片 ⚙️7：改键自该轮收尾排期起生效）。
          if (!this.shuttingDown) this.scheduleNext(this.resolveIntervalMs());
        });
    });
  }

  /**
   * 立即扫描一轮（**测试注入 now / 运维手动触发**用，不等下一个周期）。
   *
   * `now` 是**唯一**的时间输入（SQL2 的 cutoff = `now − riskDeviceWindowDays` 天）——
   * 时钟注入点；真定时链由 fake timers 驱动。
   */
  async runScanOnce(now: number = Date.now()): Promise<RiskScanRoundResult> {
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () =>
      this.runScanInner(now),
    );
  }

  /**
   * 一轮的实体（两条入口共用）：抢锁 → 工作 → 成败记指标 → CAD 释放。
   * 锁跳过（未抢到）⇒ 直接返回 `{skipped:true}`：**不记 runs 指标**（不算一轮真实扫描）。
   */
  private async runScanInner(now: number = Date.now()): Promise<RiskScanRoundResult> {
    let acquired = false;
    try {
      // ⚙️3：`SET NX EX 600`——拿不到 ⇒ debug 留痕 + 整轮跳过（不统计、不写旗）。
      const setRes = await this.redis.set(
        RISK_SCAN_LOCK_KEY,
        this.instanceId,
        'EX',
        RISK_SCAN_LOCK_TTL_SECONDS,
        'NX',
      );
      acquired = setRes === 'OK';
      if (!acquired) {
        this.logger.debug('risk scan: lock held by another instance, skipping this round');
        return { skipped: true, users: 0, flagged: 0 };
      }
      const result = await this.runScanWork(now);
      riskScanRunsTotal.inc({ result: 'ok' });
      return result;
    } catch (err) {
      riskScanRunsTotal.inc({ result: 'fail' });
      throw err;
    } finally {
      // ⚙️24：CAD 释放（只有还持有锁才删；释放失败不改变本轮成败 —— EX 是兜底）。
      if (acquired) await this.releaseLockIfMine();
    }
  }

  /** 单轮工作体（见类注的「单轮形态」）。 */
  private async runScanWork(now: number): Promise<RiskScanRoundResult> {
    const startedAtMs = Date.now();
    // 阈值/窗口每轮现读（热生效：改配置 ⇒ 下一轮生效；当前一轮按旧值跑完）。
    // 跑得快两键缺失时 getter 内部回退斗地主（新键 → 旧键 → 默认）。
    const minGames = this.configCache.riskMinGames();
    const winRateThreshold = this.configCache.riskWinRateThreshold();
    const pdkMinGames = this.configCache.riskPaodekuaiMinGames();
    const pdkWinRateThreshold = this.configCache.riskPaodekuaiWinRateThreshold();
    const deviceLimit = this.configCache.riskDeviceLimit();
    const deviceWindowDays = this.configCache.riskDeviceWindowDays();

    // ── 统计（SQL1 + SQL1b + SQL2；驱动对 COUNT/SUM 可能回字符串 ⇒ Number() 归一）────
    const winRows = (await this.dataSource.query(RISK_WIN_RATE_SQL)) as Array<{
      user_id: string;
      games: number | string;
      wins: number | string;
    }>;
    const pdkWinRows = (await this.dataSource.query(RISK_WIN_RATE_PDK_SQL)) as Array<{
      user_id: string;
      games: number | string;
      wins: number | string;
    }>;
    const deviceRows = (await this.dataSource.query(RISK_DEVICE_COUNT_SQL, [
      new Date(now - deviceWindowDays * DAY_MS),
    ])) as Array<{ user_id: string; devices: number | string }>;

    // ── 并集合并：设备-only ⇒ 两玩法均无、hit1=false；玩法间不合并样本 ─────────────
    const merged = new Map<string, MergedRiskStat>();
    const ensure = (userId: string): MergedRiskStat => {
      const existing = merged.get(userId);
      if (existing !== undefined) return existing;
      const created: MergedRiskStat = { byGame: {}, devices: 0 };
      merged.set(userId, created);
      return created;
    };
    for (const row of winRows) {
      ensure(String(row.user_id)).byGame.doudizhu = {
        games: Number(row.games),
        wins: Number(row.wins),
      };
    }
    for (const row of pdkWinRows) {
      ensure(String(row.user_id)).byGame.paodekuai = {
        games: Number(row.games),
        wins: Number(row.wins),
      };
    }
    for (const row of deviceRows) {
      ensure(String(row.user_id)).devices = Number(row.devices);
    }

    // ── 判定 + 逐用户 upsert（score=0 也进 —— 自动旗回落判定，规格 §2.5-2 括号）──
    let flagged = 0;
    let userFailures = 0;
    for (const [userId, stats] of merged) {
      const ddz = stats.byGame.doudizhu;
      const pdk = stats.byGame.paodekuai;
      const ddzHit =
        ddz !== undefined && ddz.games > minGames && ddz.wins / ddz.games > winRateThreshold;
      const pdkHit =
        pdk !== undefined &&
        pdk.games > pdkMinGames &&
        pdk.wins / pdk.games > pdkWinRateThreshold;
      // 两玩法同时命中只算“胜率命中项”一项（不叠分）。
      const hit1 = ddzHit || pdkHit;
      const hit2 = stats.devices > deviceLimit;
      const score = (hit1 ? SINGLE_HIT_SCORE : 0) + (hit2 ? SINGLE_HIT_SCORE : 0);
      if (score >= SINGLE_HIT_SCORE) flagged += 1;
      const reasons: ScanReason[] = [];
      if (ddzHit && ddz !== undefined) {
        reasons.push({
          check: 'winRate',
          detail: {
            gameType: 'doudizhu',
            games: ddz.games,
            wins: ddz.wins,
            winRate: ddz.wins / ddz.games,
          },
        });
      }
      if (pdkHit && pdk !== undefined) {
        reasons.push({
          check: 'winRate',
          detail: {
            gameType: 'paodekuai',
            games: pdk.games,
            wins: pdk.wins,
            winRate: pdk.wins / pdk.games,
          },
        });
      }
      if (hit2) reasons.push({ check: 'devices', detail: { devices: stats.devices } });

      try {
        await this.reviews.applyScanResult(userId, score, reasons, now);
      } catch (err) {
        // 单用户失败隔离：warn 留痕 + 跳过（下一轮收敛）。真库双会话的 1213 形态即由
        // 此退化路径承接（不会把整轮打红、不会丢后续用户）。
        userFailures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `risk scan: applyScanResult failed for userId=${userId} (user skipped this round; next round converges): ${reason}`,
        );
      }
    }

    // 🔴 波2 F7：**全量候选都失败** = 系统性故障（结构漂移类——每轮都抛）——不能按 ok 记
    // （否则 runs 全绿 + last_success 照刷 ⇒ RiskScanStalled 永不响）。按失败轮处理
    // （runs fail + 不刷 last_success + 响亮 error），与其它失败路径同形（fail-fast：
    // 该轮不再做自愈与水位 —— 系统性写故障下继续做库面无意义）。n=0 不判失败。
    if (merged.size > 0 && userFailures === merged.size) {
      throw new Error(
        `risk scan all-candidates-failed: ${userFailures}/${merged.size} users failed this round`,
      );
    }

    // ── 自愈（⚙️15）：名单 → 复核读 → 仍 banned 才写旗（幂等补写）──────────────
    const bannedRows = (await this.dataSource.query(RISK_BANNED_USERS_SQL)) as Array<{
      id: string;
    }>;
    let healed = 0;
    for (const row of bannedRows) {
      const userId = String(row.id);
      const recheck = (await this.dataSource.query(RISK_USER_STATUS_SQL, [userId])) as Array<{
        status?: string;
      }>;
      // 解封竞态：名单读出后、写旗前人工解封 ⇒ 这里读到 active ⇒ 不写旗（设计 r1-F14）。
      if (recheck[0]?.status !== 'banned') continue;
      await this.redis.set(riskBannedKey(userId), '1', 'EX', RISK_BANNED_FLAG_TTL_SECONDS);
      healed += 1;
    }

    // ── 轮末队列水位（§2.12：risk_reviews_open = open 计数）────────────────────
    const openRows = (await this.dataSource.query(RISK_OPEN_COUNT_SQL)) as Array<{
      cnt?: number | string;
    }>;
    const openCount = Number(openRows[0]?.cnt ?? 0);
    if (Number.isFinite(openCount)) riskReviewsOpen.set(openCount);

    // 成功轮设时间戳（失败轮不擦 —— 由外层 catch 保证不走到这里）。
    riskScanLastSuccessTimestampSeconds.set(Date.now() / 1000);
    const durationMs = Date.now() - startedAtMs;
    this.logger.log(
      `risk scan done: users=${merged.size} flagged=${flagged} healed=${healed} open=${openCount} durationMs=${durationMs}`,
    );
    return { skipped: false, users: merged.size, flagged };
  }

  /** ⚙️24 CAD：GET 值 == 本实例 id 才 DEL；释放失败仅 WARN（EX 600 是兜底，不改本轮成败）。 */
  private async releaseLockIfMine(): Promise<void> {
    try {
      const holder = await this.redis.get(RISK_SCAN_LOCK_KEY);
      if (holder === this.instanceId) await this.redis.del(RISK_SCAN_LOCK_KEY);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`risk scan: lock release failed (backstop = EX ${RISK_SCAN_LOCK_TTL_SECONDS}s): ${reason}`);
    }
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（同款闸的先例见片⑦ 三处循环）。
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
