import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  ErrCode,
  validateCurrencyCardCounterConsume,
  type CurrencyCardCounterConsumeData,
  type CurrencyCardCounterConsumeRequest,
  type CurrencyCardCounterConsumeResponse,
} from '@fight-the-landlord/protocol';

/**
 * 记牌器收费片：`currency.cardCounterConsume`（room-service 开局调用；规格 §2.4e）。
 *
 * - 一房每人**至多一次**消费（`uk_cc_consume_room_owner`）；重复调用返回首笔结果；
 * - 优先级：**包时优先**（不扣单局卡）→ 单局卡 −1 → none；
 * - 到期判定只用 **DB 时间**（`NOW(3) AS db_now`），不用服务端/客户端时钟；
 * - 并发撞唯一键 ⇒ 回滚后**新事务/直读**首笔结果（不得把 1062 冒成未知态）。
 */
const ENTITLEMENT_CONSUME_SELECT_SQL =
  'SELECT `credits`, `pass_expires_at`, NOW(3) AS `db_now` FROM `card_counter_entitlements` WHERE `owner_id` = ? FOR UPDATE';

const CONSUMPTION_SELECT_SQL =
  'SELECT `kind`, `expires_at` FROM `card_counter_consumptions` WHERE `room_code` = ? AND `owner_id` = ?';

const CONSUMPTION_INSERT_SQL =
  'INSERT INTO `card_counter_consumptions` (`room_code`, `owner_id`, `seat`, `kind`, `expires_at`, `trace_id`) VALUES (?, ?, ?, ?, ?, ?)';

const CREDITS_DECREMENT_SQL =
  'UPDATE `card_counter_entitlements` SET `credits` = `credits` - 1 WHERE `owner_id` = ? AND `credits` > 0';

type ConsumptionKind = 'pass' | 'credit' | 'none';

@Injectable()
export class CardCounterConsumeService {
  private readonly logger = new Logger(CardCounterConsumeService.name);

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async consume(dto: unknown): Promise<CurrencyCardCounterConsumeResponse> {
    try {
      validateCurrencyCardCounterConsume(dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: ErrCode.BAD_PARAM, message };
    }
    const req = dto as CurrencyCardCounterConsumeRequest;
    const traceId = req.meta?.traceId ?? null;

    try {
      const data = await this.consumeOnce(req, traceId);
      return { ok: true, data };
    } catch (err) {
      if (isDuplicateConsumptionError(err)) {
        // 并发同房：胜者已提交 ⇒ 回滚本事务后读首笔结果（不得冒未知态）。
        const existing = await this.readConsumption(req.roomCode, req.ownerId);
        if (existing !== null) {
          this.logger.log(
            `currency.cardCounterConsume duplicate（回读首笔）roomCode=${req.roomCode} ownerId=${req.ownerId}`,
          );
          return { ok: true, data: existing };
        }
      }
      throw err;
    }
  }

  private async consumeOnce(
    req: CurrencyCardCounterConsumeRequest,
    traceId: string | null,
  ): Promise<CurrencyCardCounterConsumeData> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // ① 先锁权益行（规格 §2.4e 次序：锁 entitlement → 查 consumption）
      const rows = (await manager.query(ENTITLEMENT_CONSUME_SELECT_SQL, [req.ownerId])) as Array<{
        credits: unknown;
        pass_expires_at: unknown;
        db_now: unknown;
      }>;

      // ② 本房是否已消费（幂等回读）
      const previous = await this.readConsumptionWith(manager, req.roomCode, req.ownerId);
      if (previous !== null) return previous;

      const row = rows[0];
      const credits = row === undefined ? 0 : Number(row.credits);
      const passExpiresAt = row === undefined ? null : toEpochMs(row.pass_expires_at);
      const dbNow = row === undefined ? Date.now() : toEpochMs(row.db_now) ?? Date.now();

      let kind: ConsumptionKind;
      let expiresAt: number | null = null;
      if (passExpiresAt !== null && passExpiresAt > dbNow) {
        kind = 'pass';
        expiresAt = passExpiresAt;
      } else if (credits > 0) {
        const decremented = (await manager.query(CREDITS_DECREMENT_SQL, [req.ownerId])) as {
          affectedRows?: unknown;
        };
        if (decremented.affectedRows !== 1) {
          throw new Error(
            `card_counter_entitlements credits 递减失败 ownerId=${req.ownerId}（不变量破坏）`,
          );
        }
        kind = 'credit';
      } else {
        kind = 'none';
      }

      await manager.query(CONSUMPTION_INSERT_SQL, [
        req.roomCode,
        req.ownerId,
        req.seat ?? null,
        kind,
        expiresAt === null ? null : new Date(expiresAt),
        traceId,
      ]);

      return {
        active: kind !== 'none',
        source: kind,
        expiresAt,
      };
    });
  }

  /** 直读（冲突回读面；无行 ⇒ null）。 */
  private async readConsumption(
    roomCode: string,
    ownerId: string,
  ): Promise<CurrencyCardCounterConsumeData | null> {
    const rows = (await this.dataSource.query(CONSUMPTION_SELECT_SQL, [roomCode, ownerId])) as Array<{
      kind: unknown;
      expires_at: unknown;
    }>;
    return rows[0] === undefined ? null : toConsumptionData(rows[0]);
  }

  /** 事务内读（同一 manager）。 */
  private async readConsumptionWith(
    manager: EntityManager,
    roomCode: string,
    ownerId: string,
  ): Promise<CurrencyCardCounterConsumeData | null> {
    const rows = (await manager.query(CONSUMPTION_SELECT_SQL, [roomCode, ownerId])) as Array<{
      kind: unknown;
      expires_at: unknown;
    }>;
    return rows[0] === undefined ? null : toConsumptionData(rows[0]);
  }
}

function toConsumptionData(row: { kind: unknown; expires_at: unknown }): CurrencyCardCounterConsumeData {
  const source = row.kind as ConsumptionKind;
  return {
    active: source !== 'none',
    source,
    expiresAt: toEpochMs(row.expires_at),
  };
}

/** 撞 `uk_cc_consume_room_owner`（真 MySQL/假 DB 的 message 都含索引名）。 */
function isDuplicateConsumptionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  if (!/uk_cc_consume_room_owner/i.test(message)) return false;
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /Duplicate entry/i.test(message);
}

/** DB datetime/驱动回值 ⇒ epoch ms（Date/整数/ISO 字符串；其余 ⇒ null）。 */
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
