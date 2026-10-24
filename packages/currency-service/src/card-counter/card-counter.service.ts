import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { ApplyEffectRejectError, ApplyService } from '../apply/apply.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { DomainError } from '../http/errors';

/**
 * 记牌器收费片：购买 / 状态（规格 §2.4c/d；玩家 REST 面）。
 *
 * - **扣款额 = 玩家确认价 `expectedPrice`**；effect 内校验它等于服务端当前价（14009）。
 *   理由见规格 §2.4c：扣款额取服务端价会在价格切 0 时让同号重试无法靠 op 撞键重放。
 * - **幂等优先级**：形状校验后**直接** `applyWithEffect`；`uk_action_id` 首插是唯一裁决点。
 *   重放（`ok` 或 14002）才读 `card_counter_purchases` 行校验 kind/hours —— **不再评估当前态**。
 * - 权益入账与扣费**同一事务**（effect 用同一 EntityManager）；任何 effect 拒绝整批回滚。
 */
export type CardCounterPurchaseKind = 'game' | 'hour';

export interface CardCounterPurchaseBody {
  kind: CardCounterPurchaseKind;
  hours?: number;
  /** 单局卡数量（kind==='game' 时有效，1..10；缺省 1）。包时卡用 hours 字段。 */
  credits?: number;
  requestId: string;
  expectedPrice: number;
}

export interface CardCounterPurchaseResult {
  credits: number;
  /** epoch ms；null = 无包时。 */
  passExpiresAt: number | null;
  priceCharged: number;
  balanceAfter: number;
}

export interface CardCounterStatus {
  credits: number;
  passExpiresAt: number | null;
}

/** 购买行（effect 写；响应/重放读）。 */
const PURCHASE_INSERT_SQL =
  'INSERT INTO `card_counter_purchases` (`action_id`, `owner_id`, `kind`, `hours`, `credits`, `price`) VALUES (?, ?, ?, ?, ?, ?)';

/** 单局卡：credits + N（N = 本次购买数量；同 owner 并发由 account 行锁串行化后再到本行）。 */
const ENTITLEMENT_GAME_UPSERT_SQL =
  'INSERT INTO `card_counter_entitlements` (`owner_id`, `credits`, `pass_expires_at`) VALUES (?, ?, NULL) ' +
  'ON DUPLICATE KEY UPDATE `credits` = `credits` + ?';

/** 包时卡：从 max(now, 原到期) 起顺延 hours 小时（到期判定只用 DB 时间）。 */
const ENTITLEMENT_HOUR_UPSERT_SQL =
  'INSERT INTO `card_counter_entitlements` (`owner_id`, `credits`, `pass_expires_at`) VALUES (?, 0, DATE_ADD(NOW(3), INTERVAL ? HOUR)) ' +
  'ON DUPLICATE KEY UPDATE `pass_expires_at` = DATE_ADD(GREATEST(COALESCE(`pass_expires_at`, NOW(3)), NOW(3)), INTERVAL ? HOUR)';

const PURCHASE_SELECT_SQL =
  'SELECT `kind`, `hours`, `credits`, `price` FROM `card_counter_purchases` WHERE `action_id` = ? LIMIT 1';

const ENTITLEMENT_SELECT_SQL =
  'SELECT `credits`, `pass_expires_at` FROM `card_counter_entitlements` WHERE `owner_id` = ?';

const BALANCE_SELECT_SQL = 'SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = ?';

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class CardCounterService {
  private readonly logger = new Logger(CardCounterService.name);

  constructor(
    @Inject(ApplyService) private readonly apply: ApplyService,
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigCacheService) private readonly config: ConfigCacheService,
  ) {}

  /** 本人权益（只读；无行 ⇒ 0/null，零 INSERT）。 */
  async status(userId: string): Promise<CardCounterStatus> {
    return this.readEntitlement(userId);
  }

  /** 购买单局卡/包时卡（同一事务扣金币 + 发权益）。 */
  async buy(userId: string, body: unknown): Promise<CardCounterPurchaseResult> {
    const req = this.readBody(body);
    const actionId = `cardcounter:${userId}:${req.requestId}`;
    const gameCount = req.kind === 'game' ? req.credits ?? 1 : null;
    const reason =
      req.kind === 'game'
        ? gameCount === 1
          ? 'cardcounter:game'
          : `cardcounter:game:${gameCount}`
        : `cardcounter:hour:${String(req.hours)}`;
    const hourCount = req.kind === 'hour' ? req.hours! : null;

    try {
      const response = await this.apply.applyWithEffect(
        {
          actionId,
          source: 'card_counter',
          entries: [{ ownerId: userId, delta: -req.expectedPrice }],
          refId: userId,
          reason,
          ...metaFromTrace(),
        },
        async (manager) => {
          if (!this.config.hasSnapshot()) {
            throw new ApplyEffectRejectError(ErrCode.UPSTREAM_UNAVAILABLE, '记牌器配置不可用');
          }
          const enabled = this.config.cardCounterEnabled();
          const { perGame, perHour } = this.config.cardCounterPrices();
          const serverPrice =
            req.kind === 'game'
              ? perGame * (req.credits ?? 1)
              : perHour * (req.hours as number);
          if (!enabled || serverPrice === 0) {
            throw new ApplyEffectRejectError(
              ErrCode.E_CARD_COUNTER_UNAVAILABLE,
              '记牌器暂未开放',
            );
          }
          if (req.expectedPrice !== serverPrice) {
            throw new ApplyEffectRejectError(
              ErrCode.E_CARD_COUNTER_PRICE_CHANGED,
              '记牌器价格已更新，请刷新后重试',
            );
          }
          await manager.query(PURCHASE_INSERT_SQL, [
            actionId,
            userId,
            req.kind,
            hourCount,
            req.kind === 'game' ? (req.credits ?? 1) : null,
            req.expectedPrice,
          ]);
          if (req.kind === 'game') {
            const n = req.credits ?? 1;
            await manager.query(ENTITLEMENT_GAME_UPSERT_SQL, [userId, n, n]);
          } else {
            await manager.query(ENTITLEMENT_HOUR_UPSERT_SQL, [userId, hourCount, hourCount]);
          }
        },
      );

      if (!response.ok && response.code !== ErrCode.E_ACTION_CONFLICT) {
        throw new DomainError(response.code, response.message);
      }
      // 成功 / 重放 / 14002（同锚异载荷 ⇒ 按 purchases 行判定）都走同一读面。
      const result = await this.buildExistingResult(userId, actionId, req);
      const outcome = response.ok && !response.data.replayed ? 'ok' : 'replayed';
      this.logPurchase(outcome, req, actionId, {
        price: result.priceCharged,
        credits: result.credits,
        balanceAfter: result.balanceAfter,
      });
      return result;
    } catch (err) {
      if (err instanceof DomainError) {
        this.logPurchase('rejected', req, actionId, { code: err.code, message: err.message });
      } else {
        this.logPurchase('error', req, actionId, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  /** 逐笔结构化购买日志（成功/重放/rejected/系统错都记；traceId 由 ALS 注入）。 */
  private logPurchase(
    outcome: 'ok' | 'replayed' | 'rejected' | 'error',
    req: CardCounterPurchaseBody,
    actionId: string,
    extra: Record<string, unknown>,
  ): void {
    const fields = Object.entries({ kind: req.kind, hours: req.hours ?? '-', expectedPrice: req.expectedPrice, ...extra })
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    const line = `event=card_counter.purchase result=${outcome} actionId=${actionId} ${fields}`;
    if (outcome === 'rejected' || outcome === 'error') this.logger.warn(line);
    else this.logger.log(line);
  }

  /** 重放/冲突路径：读 purchases 行（不再评估总开关/当前价）。 */
  private async buildExistingResult(
    userId: string,
    actionId: string,
    req: CardCounterPurchaseBody,
  ): Promise<CardCounterPurchaseResult> {
    const rows = (await this.dataSource.query(PURCHASE_SELECT_SQL, [actionId])) as Array<{
      kind: unknown;
      hours: unknown;
      credits: unknown;
      price: unknown;
    }>;
    const row = rows[0];
    if (row === undefined) {
      this.logger.error(
        `card-counter purchase row missing for actionId=${actionId}（op 已存在但 purchases 缺失）`,
      );
      throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '记牌器服务暂不可用');
    }
    const sameKind = row.kind === req.kind;
    const sameHours =
      req.kind === 'game' ? row.hours === null : row.hours === req.hours;
    // game 态重放：credits 必须一致（旧记录硬编码 1 → 新请求不传 credits → 1 vs 1 ✅；
    // 新请求传 credits=3 → 1 vs 3 ❌ 报 CONFLICT）。
    const sameCredits =
      req.kind === 'game'
        ? Number(row.credits) === (req.credits ?? 1)
        : true;
    if (!sameKind || !sameHours || !sameCredits) {
      throw new DomainError(
        ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT,
        '请求号冲突：请换一个新的请求号重试',
      );
    }
    const entitlement = await this.readEntitlement(userId);
    const balance = await this.readBalance(userId);
    return {
      credits: entitlement.credits,
      passExpiresAt: entitlement.passExpiresAt,
      priceCharged: Number(row.price),
      balanceAfter: balance,
    };
  }

  private readBody(body: unknown): CardCounterPurchaseBody {
    if (typeof body !== 'object' || body === null) {
      throw new DomainError(ErrCode.BAD_PARAM, '请求体必须是对象');
    }
    const { kind, hours, credits, requestId, expectedPrice } = body as Record<string, unknown>;
    if (kind !== 'game' && kind !== 'hour') {
      throw new DomainError(ErrCode.BAD_PARAM, "kind 必须是 'game' 或 'hour'");
    }
    if (kind === 'game') {
      if (hours !== undefined) {
        throw new DomainError(ErrCode.BAD_PARAM, '单局卡不接受 hours');
      }
      if (credits !== undefined) {
        if (
          typeof credits !== 'number' ||
          !Number.isInteger(credits) ||
          credits < 1 ||
          credits > 10
        ) {
          throw new DomainError(ErrCode.BAD_PARAM, 'credits 必须是 1..10 的整数');
        }
      }
    } else {
      if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 8) {
        throw new DomainError(ErrCode.BAD_PARAM, 'hours 必须是 1..8 的整数');
      }
      if (credits !== undefined) {
        throw new DomainError(ErrCode.BAD_PARAM, '包时卡不接受 credits');
      }
    }
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
      throw new DomainError(ErrCode.BAD_PARAM, 'requestId 必须是 1..64 位 [A-Za-z0-9_-]');
    }
    if (
      typeof expectedPrice !== 'number' ||
      !Number.isInteger(expectedPrice) ||
      expectedPrice < 1 ||
      expectedPrice > 1_000_000
    ) {
      throw new DomainError(ErrCode.BAD_PARAM, 'expectedPrice 必须是 1..1000000 的整数');
    }
    return {
      kind,
      ...(kind === 'hour' ? { hours: hours as number } : {}),
      ...(kind === 'game' && credits !== undefined ? { credits: credits as number } : {}),
      requestId,
      expectedPrice,
    };
  }

  private async readEntitlement(userId: string): Promise<CardCounterStatus> {
    const rows = (await this.dataSource.query(ENTITLEMENT_SELECT_SQL, [userId])) as Array<{
      credits: unknown;
      pass_expires_at: unknown;
    }>;
    const row = rows[0];
    if (row === undefined) return { credits: 0, passExpiresAt: null };
    return {
      credits: Number(row.credits),
      passExpiresAt: toEpochMs(row.pass_expires_at),
    };
  }

  private async readBalance(userId: string): Promise<number> {
    const rows = (await this.dataSource.query(BALANCE_SELECT_SQL, [userId])) as Array<{
      balance: unknown;
    }>;
    return rows[0] === undefined ? 0 : Number(rows[0].balance);
  }
}

/** DB datetime/驱动回值 ⇒ epoch ms（epoch 整数、Date、ISO 字符串三形态；其余 ⇒ null）。 */
function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
