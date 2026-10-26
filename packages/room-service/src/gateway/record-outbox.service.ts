// packages/room-service/src/gateway/record-outbox.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ErrCode, type GameType, type RecordWriteRequest } from '@fight-the-landlord/protocol';
import { incGame, normalizeGameType, setGame } from '@fight-the-landlord/shared';
import {
  recordOutboxOldestSeconds,
  recordOutboxResendTotal,
  recordOutboxSize,
} from '../metrics/room.metrics';
import { RecordClient, RecordClientError } from './record.client';

/** C1：记录补偿队列的 Hash 键（field=`<room>:<version>`）。 */
export const RECORD_OUTBOX_KEY = 'record:outbox';
/** C1：条目逻辑 TTL（24h；超龄 ⇒ abandoned）。 */
export const RECORD_OUTBOX_TTL_MS = 86_400_000;
/** C1：每轮最多投递条数。 */
export const RECORD_OUTBOX_MAX_PER_SWEEP = 100;
/** C1：每轮投递墙钟预算（从 record 阶段起点计）。 */
export const RECORD_OUTBOX_DELIVERY_BUDGET_MS = 2_000;
/** C1：record 阶段总硬超时（sweeper 的 Promise.race 用）。 */
export const RECORD_OUTBOX_PHASE_BUDGET_MS = 5_000;
/** C1：每轮最多清理的 corrupt/abandoned 条数（其余下轮）。 */
export const RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP = 500;
/** C1：未来 createdAt 的时钟容差（超过才按非法处理）。 */
export const RECORD_OUTBOX_FUTURE_TOLERANCE_MS = 300_000;
/** C1：每个 field 的 CAS 删除（比较 raw 后 HDEL；防误删快照后新条目）。 */
export const CAS_HDEL_RECORD_OUTBOX_LUA =
  "if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) else return 0 end";
/** C1：每个 field 的 CAS 自愈（比较 raw 后 HSET；防覆盖快照后新条目）。 */
export const CAS_HSET_RECORD_OUTBOX_LUA =
  "if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) else return -1 end";

export interface RecordOutboxEntry {
  request: RecordWriteRequest;
  createdAt: number;
  gameType?: GameType;
}

export type RecordOutboxEnqueueStatus = 'queued' | 'existing' | 'conflict' | 'unavailable';

export interface RecordOutboxEnqueueResult {
  status: RecordOutboxEnqueueStatus;
  /** 本请求拥有的 field 当前 raw（conflict/unavailable 时缺省）。 */
  raw?: string;
  /** conflict 时旧条目的 endedAt（日志/错误定位用）。 */
  existingEndedAt?: number;
}

export type RecordOutboxResult =
  | 'ok'
  | 'replayed'
  | 'failed'
  | 'abandoned'
  | 'corrupt'
  | 'rejected';

/** 首次投递失败（owned=入箱成功/已存在；false=conflict/unavailable）。 */
export class RecordWriteAttemptError extends Error {
  constructor(
    readonly cause: unknown,
    readonly owned: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RecordWriteAttemptError';
  }
}

/** 同 field 不同载荷（N51 room code 复用）：不直投、不覆盖旧条目。 */
export class RecordConflictError extends Error {
  constructor(
    readonly field: string,
    readonly existingEndedAt: number,
    readonly newEndedAt: number,
  ) {
    super(
      `record outbox conflict for ${field}: existing endedAt=${existingEndedAt}, new endedAt=${newEndedAt}`,
    );
    this.name = 'RecordConflictError';
  }
}

export function recordOutboxField(
  request: Pick<RecordWriteRequest, 'roomCode' | 'gameVersion'>,
): string {
  return `${request.roomCode}:${request.gameVersion}`;
}

/**
 * 重投所需的最小请求形状（完整校验仍在下游 `record.write`）。
 * ⚠️ `endedAt` 必须在场：`ack` 的 CAS 比较与 N51 冲突判定都依赖它。
 */
export function isValidRecordRequest(value: unknown): value is RecordWriteRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<RecordWriteRequest>;
  return (
    typeof r.roomCode === 'string' &&
    r.roomCode.length > 0 &&
    Number.isInteger(r.gameVersion) &&
    (r.gameVersion as number) > 0 &&
    typeof r.endedAt === 'number' &&
    Number.isFinite(r.endedAt) &&
    r.endedAt > 0 &&
    (r.mode === 'random' || r.mode === 'practice' || r.mode === 'gold') &&
    Array.isArray(r.seats) &&
    typeof r.result === 'object' &&
    r.result !== null
  );
}

/**
 * C1：`record:outbox` 的读写（enqueue/ack/sweep 的薄封装）。
 *
 * - enqueue：HSETNX 写前入箱；field 已存在时只在「同 room/version/endedAt」认作 existing，
 *   否则 conflict（**绝不覆盖**旧待投条目；N51 room code 复用）。
 * - ack：CAS_HDEL（比较 raw）后才删除；conflict/unavailable 不调用，避免误删别人的条目。
 * - 所有 Redis 异常都收敛为返回值/日志，**不抛**（局终链是 fire-and-forget）。
 */
@Injectable()
export class RecordOutboxService {
  private readonly logger = new Logger(RecordOutboxService.name);

  constructor(
    private readonly redis: Redis,
    private readonly record: RecordClient,
  ) {}

  /** 写前入箱；返回调用方是否拥有该 field 以及可 CAS 的 raw。 */
  async enqueue(request: RecordWriteRequest): Promise<RecordOutboxEnqueueResult> {
    const field = recordOutboxField(request);
    const raw = JSON.stringify({
      request,
      createdAt: Date.now(),
      gameType: normalizeGameType(request.gameType),
    } satisfies RecordOutboxEntry);
    try {
      const added = await this.redis.hsetnx(RECORD_OUTBOX_KEY, field, raw);
      if (added === 1) return { status: 'queued', raw };
      const existingRaw = await this.redis.hget(RECORD_OUTBOX_KEY, field);
      if (existingRaw === null) return { status: 'unavailable' };
      const existingRequest = parseRequest(existingRaw);
      if (existingRequest === null) {
        this.logger.error(
          `record outbox conflict for ${field}: existing entry is not a valid request (not overwritten)`,
        );
        return { status: 'conflict' };
      }
      if (
        existingRequest.roomCode === request.roomCode &&
        existingRequest.gameVersion === request.gameVersion &&
        existingRequest.endedAt === request.endedAt
      ) {
        return { status: 'existing', raw: existingRaw };
      }
      this.logger.error(
        `record outbox conflict for ${field}: existing endedAt=${existingRequest.endedAt}, new endedAt=${request.endedAt} (not overwritten)`,
      );
      return { status: 'conflict', existingEndedAt: existingRequest.endedAt };
    } catch (err) {
      this.logger.error(`record outbox enqueue failed for ${field}: ${String(err)}`);
      return { status: 'unavailable' };
    }
  }

  /** CAS 删除（只有 raw 仍等于本请求写入的值才删）。返回是否删除。 */
  async ack(field: string, raw: string): Promise<boolean> {
    try {
      const removed = await this.redis.eval(
        CAS_HDEL_RECORD_OUTBOX_LUA,
        1,
        RECORD_OUTBOX_KEY,
        field,
        raw,
      );
      return Number(removed) > 0;
    } catch (err) {
      this.logger.warn(`record outbox ack failed for ${field}: ${String(err)}`);
      return false;
    }
  }

  /**
   * 一轮 record 箱处置：一次快照 → 分类/CAS 自愈 → 最老优先投递（2s 预算）→
   * CAS 清理 corrupt/abandoned（≤500）→ 同一快照刷 gauge。
   * 单条异常不抛；整段异常交给 sweeper 的 record 阶段 catch。
   */
  async sweep(
    rawMap: Readonly<Record<string, string>>,
    now: number,
    nowFn: () => number = Date.now,
  ): Promise<void> {
    const snapshot = Object.entries(rawMap);
    const corrupt: CleanupItem[] = [];
    const abandoned: CleanupItem[] = [];
    const candidates: Candidate[] = [];

    for (const [field, raw] of snapshot) {
      const parsed = parseStored(raw);
      if (parsed === null) {
        corrupt.push({ field, raw, gameType: 'doudizhu' });
        continue;
      }
      const gameType = normalizeGameType(parsed.gameType);
      const createdAt = parsed.createdAt;
      if (
        !Number.isFinite(createdAt) ||
        createdAt <= 0 ||
        createdAt > now + RECORD_OUTBOX_FUTURE_TOLERANCE_MS
      ) {
        const repaired = await this.repairCreatedAt(field, raw, parsed.entry, now, gameType);
        if (repaired === null) continue; // CAS 失配：field 已被替换，跳过本快照项
        candidates.push({ field, raw: repaired, entry: parsed.entry, createdAt: now, gameType });
        continue;
      }
      if (now - createdAt > RECORD_OUTBOX_TTL_MS) {
        abandoned.push({ field, raw, gameType });
        continue;
      }
      candidates.push({ field, raw, entry: parsed.entry, createdAt, gameType });
    }

    candidates.sort((a, b) => a.createdAt - b.createdAt);
    const removed = new Set<string>();
    const deliveryStart = nowFn();
    for (const candidate of candidates.slice(0, RECORD_OUTBOX_MAX_PER_SWEEP)) {
      if (nowFn() - deliveryStart >= RECORD_OUTBOX_DELIVERY_BUDGET_MS) break;
      if (await this.resendOne(candidate)) removed.add(candidate.field);
    }

    const cleanup: Array<{ item: CleanupItem; result: 'corrupt' | 'abandoned' }> = [
      ...corrupt.map((item) => ({ item, result: 'corrupt' as const })),
      ...abandoned.map((item) => ({ item, result: 'abandoned' as const })),
    ].slice(0, RECORD_OUTBOX_MAX_CLEANUP_PER_SWEEP);
    if (corrupt.length + abandoned.length > cleanup.length) {
      this.logger.warn(
        `record outbox cleanup backlog: ${corrupt.length + abandoned.length - cleanup.length} entr(ies) deferred to next round`,
      );
    }
    for (const { item, result } of cleanup) {
      if (await this.drop(item, result)) removed.add(item.field);
    }

    this.setGauges(now, snapshot, removed);
  }

  /** CAS 自愈非法/未来 createdAt；成功返回 new raw，失配返回 null（跳过），异常返回旧 raw（仍投递一次）。 */
  private async repairCreatedAt(
    field: string,
    raw: string,
    entry: RecordOutboxEntry,
    now: number,
    gameType: GameType,
  ): Promise<string | null> {
    const nextRaw = JSON.stringify({ ...entry, createdAt: now, gameType } satisfies RecordOutboxEntry);
    try {
      const res = await this.redis.eval(
        CAS_HSET_RECORD_OUTBOX_LUA,
        1,
        RECORD_OUTBOX_KEY,
        field,
        raw,
        nextRaw,
      );
      if (Number(res) === 1) {
        this.logger.warn(`record outbox createdAt repaired for ${field} (was invalid/future)`);
        return nextRaw;
      }
      this.logger.warn(`record outbox createdAt repair skipped for ${field} (entry changed)`);
      return null;
    } catch (err) {
      this.logger.error(`record outbox createdAt repair failed for ${field}: ${String(err)}`);
      return raw; // 仍投递一次；CAS ack 若 raw 未变仍可删除
    }
  }

  /** 投递一条；成功/幂等/确定性 10001 都 CAS 删除（删除成功才计数）。返回是否删除。 */
  private async resendOne(candidate: Candidate): Promise<boolean> {
    try {
      const written = await this.record.write(candidate.entry.request);
      const removed = await this.ack(candidate.field, candidate.raw);
      if (removed) {
        incGame(recordOutboxResendTotal, candidate.gameType, 1, {
          result: written ? 'ok' : 'replayed',
        });
      } else {
        this.logger.warn(
          `record outbox ack skipped for ${candidate.field} (entry changed or already removed)`,
        );
      }
      return removed;
    } catch (err) {
      if (err instanceof RecordClientError && err.code === ErrCode.BAD_PARAM) {
        const removed = await this.ack(candidate.field, candidate.raw);
        if (removed) {
          incGame(recordOutboxResendTotal, candidate.gameType, 1, { result: 'rejected' });
          this.logger.error(`record outbox rejected for ${candidate.field}: ${err.message}`);
        }
        return removed;
      }
      incGame(recordOutboxResendTotal, candidate.gameType, 1, { result: 'failed' });
      this.logger.warn(`record outbox resend failed for ${candidate.field}: ${String(err)}`);
      return false;
    }
  }

  /** CAS 删除一个 corrupt/abandoned 条目；删除成功才计数 + ERROR。 */
  private async drop(item: CleanupItem, result: 'corrupt' | 'abandoned'): Promise<boolean> {
    const removed = await this.ack(item.field, item.raw);
    if (removed) {
      incGame(recordOutboxResendTotal, item.gameType, 1, { result });
      this.logger.error(`record outbox ${result} entry dropped for ${item.field}`);
    } else {
      this.logger.warn(
        `record outbox ${result} drop skipped for ${item.field} (entry changed or already removed)`,
      );
    }
    return removed;
  }

  /** 从同一快照算 size/oldest；成功删除的 field 扣除；两种玩法都写。 */
  private setGauges(
    now: number,
    snapshot: ReadonlyArray<readonly [string, string]>,
    removed: ReadonlySet<string>,
  ): void {
    const sizes = new Map<GameType, number>([
      ['doudizhu', 0],
      ['paodekuai', 0],
    ]);
    const oldest = new Map<GameType, number>([
      ['doudizhu', 0],
      ['paodekuai', 0],
    ]);
    let bad = 0;
    for (const [field, raw] of snapshot) {
      if (removed.has(field)) continue;
      const parsed = parseStored(raw);
      if (parsed === null) {
        bad += 1;
        sizes.set('doudizhu', (sizes.get('doudizhu') ?? 0) + 1);
        continue;
      }
      const gameType = normalizeGameType(parsed.gameType);
      sizes.set(gameType, (sizes.get(gameType) ?? 0) + 1);
      const createdAt = parsed.createdAt;
      const effective =
        Number.isFinite(createdAt) &&
        createdAt > 0 &&
        createdAt <= now + RECORD_OUTBOX_FUTURE_TOLERANCE_MS
          ? createdAt
          : now;
      const age = Math.max(0, Math.round((now - effective) / 1000));
      oldest.set(gameType, Math.max(oldest.get(gameType) ?? 0, age));
    }
    if (bad > 0) {
      this.logger.warn(`record outbox gauge: ${bad} unparseable/invalid entr(ies) counted as doudizhu`);
    }
    for (const gameType of ['doudizhu', 'paodekuai'] as const) {
      setGame(recordOutboxSize, gameType, sizes.get(gameType) ?? 0);
      setGame(recordOutboxOldestSeconds, gameType, oldest.get(gameType) ?? 0);
    }
  }
}

interface CleanupItem {
  field: string;
  raw: string;
  gameType: GameType;
}

interface Candidate {
  field: string;
  raw: string;
  entry: RecordOutboxEntry;
  createdAt: number;
  gameType: GameType;
}

interface ParsedStored {
  entry: RecordOutboxEntry;
  createdAt: number;
  gameType?: GameType;
}

/** 解析快照值；坏 JSON/坏请求 ⇒ null（corrupt）。createdAt 非法保留 NaN 交给修复路径。 */
function parseStored(raw: string): ParsedStored | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RecordOutboxEntry>;
    if (!isValidRecordRequest(parsed?.request)) return null;
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : Number.NaN;
    return {
      entry: {
        request: parsed.request,
        createdAt,
        gameType: parsed.gameType,
      },
      createdAt,
      gameType: parsed.gameType,
    };
  } catch {
    return null;
  }
}

/** 解析已存在条目的 request；坏 JSON/坏形状 ⇒ null（调用方按 conflict 处理）。 */
function parseRequest(raw: string): RecordWriteRequest | null {
  return parseStored(raw)?.entry.request ?? null;
}
