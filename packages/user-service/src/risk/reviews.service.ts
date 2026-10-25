// packages/user-service/src/risk/reviews.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import { ErrCode, type GameType } from '@fight-the-landlord/protocol';
import { REDIS } from '../auth/token.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { DomainError } from '../http/errors';
import { riskActionsTotal } from './risk.metrics';

/**
 * 队列 upsert 的锁定读（风控片 T5 / 规格 **⚙️10 逐字**：取该用户**最新一行（任意
 * status）**——F1 修：只取 open/throttled 会把 dismissed 抑制与 banned 跳过整条绕过）。
 *
 * ⚠️ **全文被单测钉**（`test/risk-scan.test.ts` 的 `toBe` 全等断言，且那份文本是测试侧
 * 按 ⚙️10 独立誊写的）——改一个字符都会红。同族先例 = ③ 最后超管保护锁定读
 * （`admin-accounts.service.ts` 的 `ADMIN_SUPER_LOCK_SQL`）/ 货币 ⚙️14。
 * 跨实例由扫描锁（⚙️3）兜底、锁定读的间隙锁为第二防线（真库双会话形态见 progress 核销节）。
 */
export const RISK_UPSERT_LOCK_SQL =
  'SELECT id,status,score,handled_by,handled_at,game_type,reasons FROM risk_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE';

/** `risk:limit` auto 旗的 TTL（规格 §2.3：auto=7d，每轮续期）。 */
export const RISK_LIMIT_TTL_SECONDS = 604_800;

/** `risk:limit:{userId}` 键（唯一拼法，勿在别处拼字符串；T6 管理动作同用）。 */
export function riskLimitKey(userId: string): string {
  return `risk:limit:${userId}`;
}

/**
 * `risk:banned:{userId}` 键（唯一拼法；T6 管理动作 / T5 自愈写点同用；T7 网关 / T3 room
 * 是**跨服务**消费点，各自持有文本 —— 服务间不互相 import 是本仓结构性事实）。
 * ⚠️ T6 归属迁移：本键与下述两常量原定义在 `scan.service.ts`（T5）。T6 的 ban/unban 也写它，
 * 而 `scan → reviews` 是既有单向依赖、**反向 import 会成环**（DI 元数据崩，真容器启动即炸）
 * ⇒ 单一真源随写面一起落回本文件，`scan.service.ts` **再导出**保持既有 import 面不破。
 */
export function riskBannedKey(userId: string): string {
  return `risk:banned:${userId}`;
}

/** `risk:banned` 旗 TTL（规格 §2.7-1/⚙️15：90 天；ban 动作与自愈补写共用）。 */
export const RISK_BANNED_FLAG_TTL_SECONDS = 7_776_000;

/**
 * users.status 读（T6 管理动作的源态校验 + T5 自愈的复核读共用）。
 * ⚠️ 全文被 `test/risk-scan.test.ts` 与 `test/risk-admin.test.ts` 双份独立誊写钉住。
 */
export const RISK_USER_STATUS_SQL = 'SELECT status FROM users WHERE id=?';

/** 管理动作的条目迁移（T6 / ⚙️19；`handled_by` = 管理员名——自动侧则恒 `'system'`）。 */
export const RISK_ADMIN_REVIEW_TRANSITION_SQL =
  'UPDATE risk_reviews SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?';

/** users.status 迁移（ban ⇒ `'banned'` / unban ⇒ `'active'`；与 `RISK_USER_STATUS_SQL` 配对）。 */
export const RISK_USER_STATUS_UPDATE_SQL = 'UPDATE users SET status = ? WHERE id = ?';

/** 管理面合法动作集（规格 §2.8：**5 值**；`auto_throttle|reopen` 为系统专用）。 */
export type RiskAdminAction = 'dismiss' | 'throttle' | 'unthrottle' | 'ban' | 'unban';

/** 一次管理动作的全部入参（controller 校验后传入；`now` 为注入时钟，测试钉值）。 */
export interface RiskAdminActionInput {
  userId: string;
  action: RiskAdminAction;
  /** 管理员用户名（XAdminGuard 已按 `isAdminUsername` 校验，写面绝无回退值）。 */
  actor: string;
  /** 1..200（controller 已校验非空）。 */
  reason: string;
  /** 可选：提交者「看到的条目」断言——与锁定读的最新行不符 ⇒ 409（陈旧提交）。 */
  reviewId?: number;
  /** epoch ms（注入；测试钉值）。 */
  now: number;
}

/**
 * 管理动作的 409 冲突（源态非法 / 陈旧提交 / 1213 重试耗尽）。服务层不碰 HTTP——
 * 控制器按 `message` 翻 409 借 10001（`adminError` 先例 = currency-service）。
 */
export class RiskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskConflictError';
  }
}

/** 409 文案前缀（规格 §2.13 逐字「当前状态不允许该动作」；括号内指明合法动作）。 */
const STATE_CONFLICT_PREFIX = '当前状态不允许该动作';
const stateConflictMessage = (hint: string): string => `${STATE_CONFLICT_PREFIX}（${hint}）`;

/** 1213 重试耗尽后的 409 文案（T5 遗留裁决第 0 条逐字；控制器原样透传）。 */
export const CONCURRENCY_CONFLICT_MESSAGE = '并发冲突，请重试';

/** 事务提交后的旗操作（波 2 F2：ban/unban 的 `risk:banned` 旗写从事务体内移到 COMMIT 之后）。 */
type AdminPostCommitFlag = 'set-banned' | 'del-banned' | null;

/** 孤儿旗清理的审计 `detail`（F2：unban 源态放宽分支的留痕；json 列存 JSON 串）。 */
const ORPHAN_FLAG_CLEANUP_DETAIL = JSON.stringify({ orphanFlagCleanup: true });

/**
 * InnoDB 1213（`ER_LOCK_DEADLOCK`）判别。两种驱动形态都认：
 *  - mysql2 裸错误：`errno: 1213` / `code: 'ER_LOCK_DEADLOCK'`；
 *  - TypeORM 包裹（`QueryFailedError.driverError` 持原错误）。
 * 触发场景 = ⚙️10 锁定读 + 首写 INSERT 的间隙锁固有形态（T5 真库双会话演练实证）。
 */
function isDeadlockError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { errno?: unknown; code?: unknown; driverError?: unknown };
  if (e.errno === 1213 || e.code === 'ER_LOCK_DEADLOCK') return true;
  const d = e.driverError as { errno?: unknown; code?: unknown } | null | undefined;
  return d !== null && d !== undefined && (d.errno === 1213 || d.code === 'ER_LOCK_DEADLOCK');
}

/** 单命中项分值（规格 §2.5-2：`score = 命中项数 × 25` ∈ {25,50}）。 */
const SINGLE_HIT_SCORE = 25;
/** 账号级自动限流线（规格 §2.5-3：score ≥ 50 且 `risk.autoThrottle` 才武装）；PDK 命中可被 autoThrottleScore 下调至 25–50。 */
const AUTO_THROTTLE_SCORE = 50;

/** 自动解除的审计 reason（规格 §2.5-3 逐字；`<25 ⇒ dismissed` 分支的语义标签）。 */
const AUTO_THROTTLE_RELEASE_REASON = '指标回落，自动解除';

/**
 * 扫描产出的命中快照元素（`risk_reviews.reasons` 的 JSON 形状；规格 §2.2 注释）。
 *
 * 2026-10-25 起 `check:'winRate'` 的 `detail` 恒带 `gameType:'doudizhu'|'paodekuai'`
 * （每个命中玩法一条）。**旧行缺 `gameType` 时按 `doudizhu` 解释**——当前没有消费方
 * 解析 `reasons`（admin 原样展示 JSON），此规则是给未来消费方的兼容契约。
 */
export interface ScanReason {
  check: 'winRate' | 'devices' | 'revived';
  detail: Record<string, unknown>;
}

/** 审核行的当前玩法维度（B 组 U5/D15-D16）。 */
export type ReviewGameType = 'doudizhu' | 'paodekuai' | 'mixed' | 'platform';

/** 旧行/未知值按 doudizhu 解释（U5：旧行缺省 ddz）。 */
function normalizeReviewGameType(value: unknown): ReviewGameType {
  return value === 'paodekuai' || value === 'mixed' || value === 'platform'
    ? value
    : 'doudizhu';
}

/** 锁定读的 `reasons` 可能是 JSON 字符串/对象/数组；解析失败按空。 */
function parseReasonsValue(value: unknown): ScanReason[] {
  if (Array.isArray(value)) return value as ScanReason[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ScanReason[]) : [];
  } catch {
    return [];
  }
}

/**
 * 由**本次** reasons 推导审核行的 game_type：
 * winRate 的 gameType 集合（缺省/未知 ⇒ doudizhu）；两玩法 ⇒ mixed；
 * 无 winRate 但有 devices ⇒ platform；无 reasons ⇒ null（调用方保留最新行值）。
 */
function deriveReviewGameType(reasons: readonly ScanReason[]): ReviewGameType | null {
  const games = new Set<'doudizhu' | 'paodekuai'>();
  let hasDevices = false;
  for (const reason of reasons) {
    if (reason.check === 'winRate') {
      games.add(reason.detail.gameType === 'paodekuai' ? 'paodekuai' : 'doudizhu');
    } else if (reason.check === 'devices') {
      hasDevices = true;
    }
  }
  if (games.has('doudizhu') && games.has('paodekuai')) return 'mixed';
  if (games.has('doudizhu')) return 'doudizhu';
  if (games.has('paodekuai')) return 'paodekuai';
  return hasDevices ? 'platform' : null;
}

/** 最新行“涉及”的玩法集合：game_type 列 + reasons 兜底（旧行缺省 ddz 也能识别 PDK）。 */
function reviewInvolvedGames(latest: LatestReviewRow): Set<GameType> {
  const games = new Set<GameType>();
  const column = normalizeReviewGameType(latest.game_type);
  if (column === 'doudizhu' || column === 'mixed') games.add('doudizhu');
  if (column === 'paodekuai' || column === 'mixed') games.add('paodekuai');
  for (const reason of parseReasonsValue(latest.reasons)) {
    if (reason.check === 'winRate') {
      games.add(reason.detail.gameType === 'paodekuai' ? 'paodekuai' : 'doudizhu');
    }
  }
  return games;
}

/**
 * 有效自动限流线：PDK 胜率命中 ⇒ min(50, pdkAutoThrottleScore)；否则账号级 50。
 * pdkScore=25 时 PDK-only 25 分即武装；26–49 与 50 同效（PDK+设备 50 仍武装）。
 */
function autoThrottleLine(
  reasons: readonly ScanReason[],
  pdkAutoThrottleScore: number,
): number {
  const pdkHit = reasons.some(
    (reason) => reason.check === 'winRate' && reason.detail.gameType === 'paodekuai',
  );
  return pdkHit ? Math.min(AUTO_THROTTLE_SCORE, pdkAutoThrottleScore) : AUTO_THROTTLE_SCORE;
}

/** 本次调用落入 `risk_actions` 的系统动作（`null` = 没动作；仅用于指标写点）。 */
export type RiskSystemAction = 'auto_throttle' | 'unthrottle' | 'reopen' | null;

/**
 * 写入语句（裸 SQL；形状被 `test/risk-scan.test.ts` 的 FakeRiskDb 按形态识别 ——
 * 形状漂移 ⇒ 未识别 ⇒ 当场红。锁定读（规格钉的那条）不在此列）。
 * 🔴 **顺序纪律**：DB 语句在前、Redis 旗操作**最后** —— 旗操作失败会把整个 MySQL 事务
 * 一并回滚（本轮不落库、旗不动），下一轮扫描重新定夺（收敛路径见类注）。
 */
const REVIEW_INSERT_OPEN_SQL =
  "INSERT INTO risk_reviews (user_id, score, reasons, status, game_type) VALUES (?, ?, ?, 'open', ?)";
const REVIEW_UPDATE_SCORE_SQL =
  'UPDATE risk_reviews SET score = ?, reasons = ?, game_type = ? WHERE id = ?';
const REVIEW_UPDATE_TRANSITION_SQL =
  "UPDATE risk_reviews SET score = ?, reasons = ?, game_type = ?, status = ?, handled_by = 'system', handled_at = ? WHERE id = ?";
/** 终审 F1：manual 旗下 open⇒throttled 的迁移——**不写 handled_\***（处置者保持不动）。 */
const REVIEW_UPDATE_THROTTLE_KEEP_HANDLER_SQL =
  "UPDATE risk_reviews SET score = ?, reasons = ?, game_type = ?, status = 'throttled' WHERE id = ?";
const ACTION_INSERT_SQL =
  'INSERT INTO risk_actions (user_id, action, actor, reason, review_id, detail) VALUES (?, ?, ?, ?, ?, ?)';

/** 锁定读回执行（只含 ⚙️10 SELECT 的五个列）。 */
interface LatestReviewRow {
  id: number | string;
  status: string;
  score: number | string;
  handled_by: string | null;
  handled_at: Date | string | null;
  game_type: string | null;
  reasons: unknown;
}

/**
 * 审核队列的**唯一写入口**（状态机 + 自动限流；scan 与 admin 共用面 —— T6 复用本服务）。
 *
 * ─── 状态机（规格 §2.5-3 全行；分支对象 = ⚙️10 锁定读的「最新一行（任意 status）」）──
 *  - **无行**：score ≥ 25 ⇒ INSERT open；< 25 ⇒ 无操作（并集里的低分用户只是回落通道）。
 *  - **open**：score ≥ 25 ⇒ UPDATE score/reasons；其中 score ≥ 有效自动限流线（账号 50；
 *    PDK 命中可 25–50）且 `risk.autoThrottle`
 *    ⇒ **先读 `risk:limit` 现值**（终审 F1）：旗不存在/auto ⇒ 置旗 auto（7d）+ 迁
 *    `throttled`（handled_by='system'）+ `auto_throttle` 审计；**旗=manual ⇒ 仅迁条目
 *    （`handled_by`/`handled_at` **保持不动**）、旗**不动**、**无任何审计行**（无实际变更）
 *    ——防「人工旗被自动逻辑改写为 auto、再被下轮 release 静默删掉」的漂移链。
 *    ⚙️20：自动限流**只对已有 open 条目**发生 —— 本轮新建的行不武装（下一轮 open 分支才武装）。
 *  - **throttled(auto)**（`handled_by='system'` 判别）：score ≥ 有效自动限流线 ⇒ 旗**续期**（SET 重发
 *    EX 7d、**不刷审计**）；score < 50 ⇒ 删旗 + `unthrottle`(system) 审计 + 回迁
 *    （score ≥ 25 ⇒ open；< 25 ⇒ dismissed + reason「指标回落，自动解除」）。
 *  - **throttled(manual)**：一律**不动旗**（人工解除是唯一通道）；score ≥ 25 仅 UPDATE。
 *  - **dismissed**：score > 处置时 score ⇒ INSERT 新 open（reasons 附 `revived` 元素）+
 *    `reopen`(system) 审计（⚙️22-③）；否则**不动**（人工判过的抑制语义）。
 *  - **banned**：跳过产出（统计侧 users 过滤为双保险）。
 *  未知 status ⇒ **响亮抛**（事务回滚；绝不静默失明）。
 *
 * ─── 事务与旗的边界（无 2PC 的收敛论证）───────────────────────────────────
 *  DB 状态 + `risk_actions` 行**同事务**（规格 §2.5-3「一律同事务」）；Redis 旗**不是**
 *  事务参与者 —— 本实现把旗操作放在事务体**最后**，失败即异常 ⇒ MySQL 整体回滚 ⇒
 *  行与旗都不动，下一轮按同分支重新定夺（收敛）。残余窗口只剩「旗已写、COMMIT 恰好失败」
 *  （进程崩溃级）：下一轮 open 分支会重发旗/迁移或解除（幂等收敛）；`risk:limit` 的
 *  孤儿旗另有 T6 `unthrottle`（⚙️19：按旗不看条目）作为人工清道夫。
 *
 *  系统动作计数（`risk_actions_total{action}`，§2.12 的写点含 reviews 服务）在**事务提交
 *  成功后** inc —— 回滚的事务不计数。
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    /** ⚠️ `DataSource` 是**值导入** + 显式 `@Inject`（DI 陷阱纪律；本仓既有惯例）。 */
    @Inject(DataSource) private readonly dataSource: DataSource,
    /** ⚠️ 旗面注入 = `REDIS` 令牌（`import type { Redis }` —— 令牌是字符串常量的成例）。 */
    @Inject(REDIS) private readonly redis: Redis,
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * 把一轮扫描结果应用到该用户的队列条目（状态机 + 自动限流；见类注）。
   * 由 `ScanService` 逐用户调用；T6 的管理动作复用同一事务骨架。
   */
  async applyScanResult(
    userId: string,
    score: number,
    reasons: readonly ScanReason[],
    now: number,
    unavailableGames: readonly GameType[] = [],
  ): Promise<void> {
    const pdkAutoThrottleScore = this.configCache.riskPaodekuaiAutoThrottleScore();
    const throttleLine = autoThrottleLine(reasons, pdkAutoThrottleScore);
    const action = await this.dataSource.transaction(
      async (manager): Promise<RiskSystemAction> => {
        const rows = (await manager.query(RISK_UPSERT_LOCK_SQL, [userId])) as LatestReviewRow[];
        const latest = rows[0];
        if (latest !== undefined && unavailableGames.length > 0) {
          const autoThrottled =
            latest.status === 'throttled' && latest.handled_by === 'system';
          // ② 任一玩法失败 + throttled(auto)：不得解除；仅续 Redis 旗（零 DB 写/审计）。
          if (autoThrottled) {
            await this.armAutoThrottle(userId, now);
            return null;
          }
          // ① 最新行涉及失败玩法：零 DB 写/零审计。
          const involved = reviewInvolvedGames(latest);
          if (unavailableGames.some((game) => involved.has(game))) return null;
        }
        const nextGameType =
          deriveReviewGameType(reasons) ??
          (latest === undefined ? 'platform' : normalizeReviewGameType(latest.game_type));
        if (latest === undefined) {
          if (score >= SINGLE_HIT_SCORE) {
            await this.insertOpen(manager, userId, score, reasons, nextGameType);
          }
          return null;
        }

        const reviewId = Number(latest.id);
        switch (latest.status) {
          case 'open': {
            if (score < SINGLE_HIT_SCORE) return null;
            if (score >= throttleLine && this.configCache.riskAutoThrottle()) {
              // ⚠️ 终审 F1：**武装前读旗现值** —— 合法动作链（manual throttle → ban → unban
              // → 涨分 revive）后旗仍为 manual；无条件置 auto 会把人工旗改写成 auto，再被
              // 下轮 release 静默删掉（人工处置被解除 + limitSource 溯源漂移）。
              const flagSource = await this.readLimitFlagSource(userId);
              if (flagSource === 'manual') {
                // ② 旗=manual：仅迁条目（`handled_by`/`handled_at` 保持不动）、旗不动、无审计。
                await manager.query(REVIEW_UPDATE_THROTTLE_KEEP_HANDLER_SQL, [
                  score,
                  JSON.stringify(reasons),
                  nextGameType,
                  reviewId,
                ]);
                return null;
              }
              // ① 旗不存在 / ③ 旗=auto：现行为（武装/续期 + 迁 throttled + auto_throttle 审计）。
              await manager.query(REVIEW_UPDATE_TRANSITION_SQL, [
                score,
                JSON.stringify(reasons),
                nextGameType,
                'throttled',
                new Date(now),
                reviewId,
              ]);
              await this.insertAction(manager, userId, 'auto_throttle', 'system', null, reviewId, null);
              await this.armAutoThrottle(userId, now);
              return 'auto_throttle';
            }
            await manager.query(REVIEW_UPDATE_SCORE_SQL, [
              score,
              JSON.stringify(reasons),
              nextGameType,
              reviewId,
            ]);
            return null;
          }

          case 'throttled': {
            if (latest.handled_by === 'system') {
              if (score >= throttleLine) {
                // 续期：刷新 score/reasons + SET 重发 EX 7d；**不刷审计**。
                await manager.query(REVIEW_UPDATE_SCORE_SQL, [
                  score,
                  JSON.stringify(reasons),
                  nextGameType,
                  reviewId,
                ]);
                await this.armAutoThrottle(userId, now);
                return null;
              }
              // 自动解除：删旗 + unthrottle(system) 审计 + 回迁（≥25 ⇒ open；<25 ⇒ dismissed）。
              const nextStatus = score >= SINGLE_HIT_SCORE ? 'open' : 'dismissed';
              await manager.query(REVIEW_UPDATE_TRANSITION_SQL, [
                score,
                JSON.stringify(reasons),
                nextGameType,
                nextStatus,
                new Date(now),
                reviewId,
              ]);
              await this.insertAction(
                manager,
                userId,
                'unthrottle',
                'system',
                AUTO_THROTTLE_RELEASE_REASON,
                reviewId,
                null,
              );
              await this.redis.del(riskLimitKey(userId));
              return 'unthrottle';
            }
            // 人工档：旗零操作（人工解除是唯一通道）；分数快照照更新。
            if (score >= SINGLE_HIT_SCORE) {
              await manager.query(REVIEW_UPDATE_SCORE_SQL, [
                score,
                JSON.stringify(reasons),
                nextGameType,
                reviewId,
              ]);
            }
            return null;
          }

          case 'dismissed': {
            if (score > Number(latest.score)) {
              const revived: ScanReason = {
                check: 'revived',
                detail: {
                  prevReviewId: reviewId,
                  prevScore: Number(latest.score),
                  handledBy: latest.handled_by,
                  handledAt: latest.handled_at,
                },
              };
              const newId = await this.insertOpen(
                manager,
                userId,
                score,
                [...reasons, revived],
                nextGameType,
              );
              await this.insertAction(manager, userId, 'reopen', 'system', null, newId, null);
              return 'reopen';
            }
            return null; // 同分/降分：不动（抑制语义）。
          }

          case 'banned':
            return null; // 最新行 banned ⇒ 跳过产出（⚙️10 分支层判定）。

          default:
            throw new Error(
              `risk_reviews 出现未知 status='${String(latest.status)}'（user=${userId}）—— 状态机无此分支`,
            );
        }
      },
    );

    if (action !== null) riskActionsTotal.inc({ action });
  }

  /**
   * 管理动作（风控片 T6 / 规格 **⚙️19 全行** × §2.7-1/3 × §2.13；判据 C19。
   * 波 2 评审订正 F2/F6 已并入：旗写后置 + unban 清孤儿旗 / reviewId 断言限定条目态动作）。
   *
   * 与 `applyScanResult` 共用同一把锁定读（⚙️10）与 `risk_actions` 写入形 —— 队列状态机的
   * **唯一**两个入口都在这一个文件里，管理面不复制任何迁移规则。
   *
   * ─── 五动作的源态与产出（⚙️19 逐字；F2/F6 订正处已标注）───────────────────
   *  - `dismiss`：open ⇒ dismissed；否则 409。
   *  - `throttle`：open ⇒ throttled（handled_by=actor）+ `risk:limit` manual 旗（**无 TTL**）。
   *  - `unthrottle`：**源态校验按旗不看条目** —— 旗在 ⇒ 允许（删旗 + 审计；条目为 throttled
   *    ⇒ 顺带迁 dismissed，否则仅删旗——F6 孤儿旗清道夫）；旗不在 ⇒ 409。
   *  - `ban`：users.status='banned' + 最新条目（任意态）⇒ banned（**无条目亦可执行**，
   *    audit.review_id=null）；已在封禁态 ⇒ 409（指引 unban）。**F2：`risk:banned` 旗写
   *    后置到 COMMIT 之后**（失败只 warn —— DB 已定局，漏旗由扫描自愈 ≤1h 补写收敛）。
   *  - `unban`：**F2：源态放宽 = `users.status='banned'` 或 旗在** —— status 已 active 但
   *    旗在（崩溃遗留的**孤儿旗**）⇒ 允许：清旗 + 审计行（`detail` = `{orphanFlagCleanup:
   *    true}`）；条目为 banned ⇒ 顺带 dismissed；**旗删也后置到 COMMIT 之后**（失败只 warn
   *    —— 孤儿旗可经重发 unban 清掉）；status active 且无旗 ⇒ 409（重发语义不变）。
   *  - `reviewId`（可选）＝「提交者看到的条目」断言（**F6：仅条目态动作
   *    dismiss|throttle|unthrottle**；ban/unban 的源态 = users.status——扫描在 GET→POST 间
   *    涨分复活不得误伤合法 ban）：与锁定读最新行不符（含无行）⇒ 409（条目已变化）。
   *  - 用户不存在（ban/unban 的源读 miss）⇒ `DomainError(11004)`（控制器翻 404；**先于一切
   *    其余校验**——F6）。
   *
   * ─── 事务与旗的边界（F2 后置形态；条目态动作仍守 T5 纪律）───────────────────
   *  `dismiss`/`throttle`/`unthrottle`：DB 写入 + `risk:limit` 旗操作**同一事务体**、旗操作
   *  恒在**最后**（旗失败 ⇒ 整体回滚；`unthrottle` 的旗**读**在校验位、读失败照抛——「按无旗」
   *  会把 Redis 故障谎报成 409）。
   *  🔴 `ban`/`unban` 的 `risk:banned` 旗操作**移出事务、在 COMMIT 之后**（F2：原「事务内
   *  旗写」的崩溃窗口会留下**无主旗**，而自愈只补不删、旧 unban 又被 409 拒清 ⇒ 状态锁死）。
   *  后置后的失败模式：ban **漏旗**（DB 已 banned、登录 DB 闸即时生效；扫描自愈 ≤1h 补写）/
   *  unban **漏删**（孤儿旗经 F2 的 unban 源态放宽重发清掉）——两者都有收敛路径。
   *
   * ─── 1213（T5 遗留裁决第 0 条）─────────────────────────────────────────
   *  动作事务遇 1213 ⇒ **整事务重试一次**；再失败 ⇒ `RiskConflictError`（409「并发冲突，
   *  请重试」）。非 1213 的错误（业务冲突/库故障）**不重试**、原样上抛。指标只在最终成功后
   *  记一次（回滚的尝试不计数；后置旗操作失败也照记——动作在 DB 面已成立）。
   */
  async applyAdminAction(input: RiskAdminActionInput): Promise<void> {
    let attempts = 0;
    let postCommitFlag: AdminPostCommitFlag = null;
    for (;;) {
      try {
        postCommitFlag = await this.runAdminActionTransaction(input);
        break;
      } catch (err) {
        if (!isDeadlockError(err)) throw err;
        if (attempts >= 1) throw new RiskConflictError(CONCURRENCY_CONFLICT_MESSAGE);
        attempts += 1;
      }
    }

    // ── F2：旗操作后置（COMMIT 之后）——失败**不回滚、不翻错**，只 warn 一行。────────
    if (postCommitFlag === 'set-banned') {
      try {
        await this.redis.set(riskBannedKey(input.userId), '1', 'EX', RISK_BANNED_FLAG_TTL_SECONDS);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `risk ban flag set failed for userId=${input.userId} (DB 已定局；漏旗由扫描自愈 ≤1h 收敛): ${reason}`,
        );
      }
    } else if (postCommitFlag === 'del-banned') {
      try {
        await this.redis.del(riskBannedKey(input.userId));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `risk unban flag delete failed for userId=${input.userId} (孤儿旗可经重发 unban 清掉): ${reason}`,
        );
      }
    }

    riskActionsTotal.inc({ action: input.action });
  }

  /**
   * 一次管理动作的完整事务体（重试循环只重复本方法）。
   * 返回 = **提交后**要执行的旗操作（F2：ban=置旗 / unban=删旗；其余 = null）。
   */
  private async runAdminActionTransaction(input: RiskAdminActionInput): Promise<AdminPostCommitFlag> {
    const { userId, action, actor, reason, reviewId, now } = input;
    return this.dataSource.transaction(async (manager): Promise<AdminPostCommitFlag> => {
      const rows = (await manager.query(RISK_UPSERT_LOCK_SQL, [userId])) as LatestReviewRow[];
      const latest = rows[0];
      const latestId = latest === undefined ? null : Number(latest.id);

      // F6：reviewId 断言**仅条目态动作**消费（下面三分支各自调用）；ban/unban 不消费。
      const assertFreshReview = (): void => {
        if (reviewId !== undefined && latestId !== reviewId) {
          throw new RiskConflictError(stateConflictMessage('条目已变化，请刷新后重试'));
        }
      };

      switch (action) {
        case 'dismiss': {
          assertFreshReview();
          if (latest === undefined || latest.status !== 'open') {
            throw new RiskConflictError(stateConflictMessage('dismiss 仅适用于 open 条目'));
          }
          await this.transitionReview(manager, Number(latest.id), 'dismissed', actor, now);
          await this.insertAction(manager, userId, 'dismiss', actor, reason, Number(latest.id), null);
          return null;
        }

        case 'throttle': {
          assertFreshReview();
          if (latest === undefined || latest.status !== 'open') {
            throw new RiskConflictError(stateConflictMessage('throttle 仅适用于 open 条目'));
          }
          await this.transitionReview(manager, Number(latest.id), 'throttled', actor, now);
          await this.insertAction(manager, userId, 'throttle', actor, reason, Number(latest.id), null);
          // manual 旗：值 JSON `{source:'manual',at}`、**无 TTL**（解除才删；规格 §2.3）。
          await this.redis.set(riskLimitKey(userId), JSON.stringify({ source: 'manual', at: now }));
          return null;
        }

        case 'unthrottle': {
          assertFreshReview();
          // ⚙️19：源态校验**按旗不看条目**（F6：ban→unban 后的孤儿旗由这里清）。
          const flag = await this.redis.get(riskLimitKey(userId));
          if (flag === null) {
            throw new RiskConflictError(stateConflictMessage('该用户当前无限流旗'));
          }
          if (latest !== undefined && latest.status === 'throttled') {
            await this.transitionReview(manager, Number(latest.id), 'dismissed', actor, now);
          }
          await this.insertAction(manager, userId, 'unthrottle', actor, reason, latestId, null);
          await this.redis.del(riskLimitKey(userId));
          return null;
        }

        case 'ban': {
          const statusRows = (await manager.query(RISK_USER_STATUS_SQL, [userId])) as Array<{
            status?: unknown;
          }>;
          if (statusRows.length === 0) {
            throw new DomainError(ErrCode.USER_NOT_FOUND, '未找到该用户');
          }
          if (String(statusRows[0]?.status) === 'banned') {
            throw new RiskConflictError(stateConflictMessage('该用户已在封禁状态，请使用 unban'));
          }
          await manager.query(RISK_USER_STATUS_UPDATE_SQL, ['banned', userId]);
          if (latest !== undefined) {
            await this.transitionReview(manager, Number(latest.id), 'banned', actor, now);
          }
          await this.insertAction(manager, userId, 'ban', actor, reason, latestId, null);
          // F2：旗写后置（见方法注）——事务只返回「待写」指令，COMMIT 后才执行。
          return 'set-banned';
        }

        case 'unban': {
          const statusRows = (await manager.query(RISK_USER_STATUS_SQL, [userId])) as Array<{
            status?: unknown;
          }>;
          if (statusRows.length === 0) {
            throw new DomainError(ErrCode.USER_NOT_FOUND, '未找到该用户');
          }
          const isBanned = String(statusRows[0]?.status) === 'banned';
          // F2：源态放宽 = status='banned' **或** 旗在。旗读仅在 status 非 banned 时需要
          //（正常解封路径不依赖 Redis——读故障不扩大面）；读失败照抛（校验读，不做 fail-open）。
          const orphanFlagCleanup =
            !isBanned && (await this.redis.get(riskBannedKey(userId))) !== null;
          if (!isBanned && !orphanFlagCleanup) {
            throw new RiskConflictError(stateConflictMessage('该用户不在封禁状态'));
          }
          if (isBanned) {
            await manager.query(RISK_USER_STATUS_UPDATE_SQL, ['active', userId]);
          }
          if (latest !== undefined && latest.status === 'banned') {
            await this.transitionReview(manager, Number(latest.id), 'dismissed', actor, now);
          }
          await this.insertAction(
            manager,
            userId,
            'unban',
            actor,
            reason,
            latestId,
            orphanFlagCleanup ? ORPHAN_FLAG_CLEANUP_DETAIL : null,
          );
          // F2：旗删后置（见方法注）——孤儿旗场景同样走这条删除。
          return 'del-banned';
        }

        default: {
          // 类型面穷尽（controller 的 5 值白名单保证）；运行时兜底响亮抛，不静默吞动作。
          const exhaustive: never = action;
          throw new Error(`未知管理动作：${String(exhaustive)}`);
        }
      }
    });
  }

  /** 管理动作的条目迁移（handled_by = 管理员名；updated_at 由列 ON UPDATE 自刷）。 */
  private async transitionReview(
    manager: EntityManager,
    reviewId: number,
    status: string,
    actor: string,
    now: number,
  ): Promise<void> {
    await manager.query(RISK_ADMIN_REVIEW_TRANSITION_SQL, [status, actor, new Date(now), reviewId]);
  }

  /** 新建一条 open（无行 / 涨分复活共用）；拿不到自增 id ⇒ 当场抛（让事务回滚）。 */
  private async insertOpen(
    manager: EntityManager,
    userId: string,
    score: number,
    reasons: readonly ScanReason[],
    gameType: ReviewGameType,
  ): Promise<number> {
    const res = (await manager.query(REVIEW_INSERT_OPEN_SQL, [
      userId,
      score,
      JSON.stringify(reasons),
      gameType,
    ])) as { insertId?: number };
    const newId = res?.insertId;
    if (typeof newId !== 'number' || !Number.isFinite(newId)) {
      throw new Error('risk_reviews INSERT 未返回 insertId（审计行的 review_id 必错 ⇒ 回滚）');
    }
    return newId;
  }

  /**
   * `risk_actions` 一行（T5 系统动作 actor 恒 `'system'`；T6 管理动作 = 管理员名）。
   * 两个写面共用同一 INSERT 形（列序逐字 = 迁移 DDL，含 `detail`——波 2 F2 启用：
   * 孤儿旗清理留痕），不复制第二条语句。
   */
  private async insertAction(
    manager: EntityManager,
    userId: string,
    action: 'auto_throttle' | 'unthrottle' | 'reopen' | RiskAdminAction,
    actor: string,
    reason: string | null,
    reviewId: number | null,
    detail: string | null,
  ): Promise<void> {
    await manager.query(ACTION_INSERT_SQL, [userId, action, actor, reason, reviewId, detail]);
  }

  /** 置旗/续期：`risk:limit:{userId}` = JSON `{source:'auto', at}`，EX 7d（规格 §2.3）。 */
  private async armAutoThrottle(userId: string, now: number): Promise<void> {
    await this.redis.set(
      riskLimitKey(userId),
      JSON.stringify({ source: 'auto', at: now }),
      'EX',
      RISK_LIMIT_TTL_SECONDS,
    );
  }

  /**
   * 读 `risk:limit` 旗的 source（**终审 F1**，open 分支武装前的守卫）。`null` = 无旗；
   * **除合法 `'auto'` 外一律按 `'manual'` 保守处理**（含 JSON 不可解析/形状漂移——绝不
   * 覆写一个认不出的旗）。⚠️ 读失败**照抛**（事务回滚、该用户本轮跳过、下一轮收敛）——
   * 不做「按无旗」fail-open：那会在 Redis 故障窗口把 manual 旗改写为 auto，恰恰是本
   * 守卫要杜绝的漂移（本读点是**决策读**，不是 R11 的放行读）。
   */
  private async readLimitFlagSource(userId: string): Promise<'auto' | 'manual' | null> {
    const raw = await this.redis.get(riskLimitKey(userId));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { source?: unknown } | null;
      return parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { source?: unknown }).source === 'auto'
        ? 'auto'
        : 'manual';
    } catch {
      return 'manual';
    }
  }
}
