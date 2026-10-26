import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  entryFeeOf,
  isGameType,
  type EntryFeePercent,
  type GameType,
} from '@fight-the-landlord/protocol';
import { runWithTrace, setGame } from '@fight-the-landlord/shared';
import { ConfigCacheService } from '../config/config-cache.service';
import { ReconcileInFlightError } from './reconcile.service';
import {
  currencyRecordsReconcileAmountMismatch,
  currencyRecordsReconcileConfigUnavailable,
  currencyRecordsReconcileEntryFeeOrphanOps,
  currencyRecordsReconcileEntryFeeSuspect,
  currencyRecordsReconcileEntryFeeUnknown,
  currencyRecordsReconcileLastSuccessTimestampSeconds,
  currencyRecordsReconcileMissingOps,
  currencyRecordsReconcileNullMoneyDelta,
  currencyRecordsReconcileNullNoOp,
  currencyRecordsReconcileOrphanOps,
  currencyRecordsReconcilePending,
  currencyRecordsReconcileRunsTotal,
  currencyRecordsReconcileTruncated,
} from '../metrics/currency.metrics';
import {
  RECORDS_RECONCILE_DDZ_SQL,
  RECORDS_RECONCILE_FLOWS_SQL,
  RECORDS_RECONCILE_OPS_SQL,
  RECORDS_RECONCILE_PDK_SQL,
  RECORDS_RECONCILE_SKIPS_SQL,
} from './records-reconcile.sql';

export const RECORDS_RECONCILE_TARGET_WINDOW_MS = 2 * 86_400_000; // 48h
export const RECORDS_RECONCILE_PAIR_MARGIN_MS = 86_400_000; // 24h
export const RECORDS_RECONCILE_ORPHAN_GRACE_MS = 90_000_000; // 25h
export const RECORDS_RECONCILE_OP_GRACE_MS = 7_200_000; // 2h
export const RECORDS_RECONCILE_NULL_GRACE_MS = 7_200_000; // 2h
export const RECORDS_RECONCILE_ENTRY_FEE_ORPHAN_GRACE_MS = 90_000_000; // 25h
export const RECORDS_RECONCILE_PAGE_SIZE = 5_000;
export const RECORDS_RECONCILE_MAX_TOTAL_ROWS = 200_000;
export const RECORDS_RECONCILE_ROUND_TIMEOUT_MS = 60_000;
export const RECORDS_RECONCILE_QUERY_MAX_EXECUTION_MS = 30_000;
export const RECORDS_RECONCILE_FIRST_RUN_DELAY_MS = 10_000;

export interface RecordsReconcileCounts {
  orphanOps: number;
  missingOps: number;
  nullNoOp: number;
  amountMismatch: number;
  pending: number;
  nullMoneyDelta: number;
  entryFeeSuspect: number;
  entryFeeUnknown: number;
  entryFeeOrphanOps: number;
  configUnavailable: 0 | 1;
}

export interface RecordsReconcileRoundResult extends RecordsReconcileCounts {
  truncated: boolean;
  byGame: { doudizhu: RecordsReconcileCounts; paodekuai: RecordsReconcileCounts };
}

export interface RecordsReconcileStatus {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastResult: RecordsReconcileRoundResult | null;
  lastError: string | null;
  running: boolean;
}

export interface RecordsReconcileRunOptions {
  pageSize?: number;
  maxTotalRows?: number;
  timeoutMs?: number;
}

export class RecordsReconcileTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`记录对账超过 ${timeoutMs}ms`);
    this.name = 'RecordsReconcileTimeoutError';
  }
}

export class RecordsReconcileTruncatedError extends Error {
  constructor(maxTotalRows: number) {
    super(`记录对账单查询超过 ${maxTotalRows} 行`);
    this.name = 'RecordsReconcileTruncatedError';
  }
}

type OpRow = {
  id: number;
  actionId: string;
  refId: string | null;
  source: 'game_settle' | 'entry_fee';
  gameType: GameType | null;
  createdAt: number;
  burnedResidue: number | null;
  burnedRake: number | null;
};

type FlowRow = {
  id: number;
  opId: number;
  ownerId: string;
  ownerType: string;
  delta: number;
};

type PlayerRow = {
  playerId: number;
  recordId: number;
  userId: string | null;
  isRobot: boolean;
  robotId: string | null;
  moneyDelta: number | null;
  scoreChange: number;
};

type RecordAgg = {
  gameType: GameType;
  roomCode: string;
  gameVersion: number;
  mode: string;
  baseScore: number;
  endedAt: number;
  players: PlayerRow[];
};

type Bucket = Record<keyof Omit<RecordsReconcileCounts, 'configUnavailable'>, Set<string>>;

function emptyBucket(): Bucket {
  return {
    orphanOps: new Set(),
    missingOps: new Set(),
    nullNoOp: new Set(),
    amountMismatch: new Set(),
    pending: new Set(),
    nullMoneyDelta: new Set(),
    entryFeeSuspect: new Set(),
    entryFeeUnknown: new Set(),
    entryFeeOrphanOps: new Set(),
  };
}

function countsOf(bucket: Bucket, configUnavailable: 0 | 1): RecordsReconcileCounts {
  return {
    orphanOps: bucket.orphanOps.size,
    missingOps: bucket.missingOps.size,
    nullNoOp: bucket.nullNoOp.size,
    amountMismatch: bucket.amountMismatch.size,
    pending: bucket.pending.size,
    nullMoneyDelta: bucket.nullMoneyDelta.size,
    entryFeeSuspect: bucket.entryFeeSuspect.size,
    entryFeeUnknown: bucket.entryFeeUnknown.size,
    entryFeeOrphanOps: bucket.entryFeeOrphanOps.size,
    configUnavailable,
  };
}

function normalizeGameType(value: unknown): GameType {
  return isGameType(value) ? value : 'doudizhu';
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function recordKeyOf(record: RecordAgg): string {
  return `${record.gameType}:${record.roomCode}:${record.gameVersion}`;
}

function ownerKeyOf(player: PlayerRow): string {
  return player.isRobot
    ? `robot:${player.robotId ?? ''}`
    : `user:${player.userId ?? ''}`;
}

/**
 * C2：资金（`game_settle`/`entry_fee` op + flows）↔ 对局记录（两玩法）的只读对账。
 *
 * - 目标窗口 48h + 查询两侧 24h 配对余量；只统计自身时间落在目标窗口的条目；
 * - 只读事务显式 REPEATABLE READ；会话变量在**同一 manager** 的 finally 复位；
 * - keyset 分页（records+players 按 player_id，防多玩家记录被页边界切掉）；
 * - 只报不改：所有 SQL 都是 SELECT/SET SESSION；单测以库零写钉死。
 *
 * 判定四态（spec v4）：
 *  - op→record：op 无记录 <25h pending / ≥25h orphanOps；ref 畸形 ⇒ amountMismatch；
 *  - record→op（gold）：记录无 op ≤2h pending；>2h 非零 ⇒ missingOps；任一 NULL 无非零
 *    ⇒ nullNoOp；全 0（无 NULL）⇒ 合法跳过；
 *  - money_delta NULL（有 op）：op 年龄 ≤2h pending / >2h nullMoneyDelta；
 *  - 台费：有 op 以流水为历史事实（不比当前费额）；skip 通过；都无按当前档位判
 *    suspect/unknown；percents=null ⇒ configUnavailable（独立 gauge，不进 Mismatch）。
 */
@Injectable()
export class RecordsReconcileService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RecordsReconcileService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private inFlight = false;
  private activeAttempt: number | null = null;
  private abortedAttempt: number | null = null;
  private attemptSeq = 0;

  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastResult: RecordsReconcileRoundResult | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    currencyRecordsReconcileLastSuccessTimestampSeconds.set(0);
    this.logger.log(
      `records reconcile loop started (first run in ${RECORDS_RECONCILE_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`,
    );
    this.scheduleNext(RECORDS_RECONCILE_FIRST_RUN_DELAY_MS);
  }

  private resolveIntervalMs(): number {
    return this.configCache.reconcileIntervalMs();
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => this.runRound(), delayMs);
  }

  private runRound(): void {
    if (this.inFlight) {
      this.logger.warn('records reconcile skipped: previous round still in flight');
      this.scheduleNext(this.resolveIntervalMs());
      return;
    }
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.runOnce()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`records reconcile failed: ${reason}`);
        })
        .finally(() => {
          if (!this.shuttingDown) this.scheduleNext(this.resolveIntervalMs());
        });
    });
  }

  getStatus(): RecordsReconcileStatus {
    return {
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      running: this.inFlight,
    };
  }

  /** 立即跑一轮（测试/运维用；定时链走 `runRound`）。 */
  async runOnce(options: RecordsReconcileRunOptions = {}): Promise<RecordsReconcileRoundResult> {
    if (this.inFlight) throw new ReconcileInFlightError();
    const pageSize = Math.max(
      1,
      Math.min(options.pageSize ?? RECORDS_RECONCILE_PAGE_SIZE, RECORDS_RECONCILE_PAGE_SIZE),
    );
    const maxTotalRows = Math.max(1, options.maxTotalRows ?? RECORDS_RECONCILE_MAX_TOTAL_ROWS);
    const timeoutMs = Math.max(1, options.timeoutMs ?? RECORDS_RECONCILE_ROUND_TIMEOUT_MS);
    const attempt = ++this.attemptSeq;
    this.inFlight = true;
    this.activeAttempt = attempt;
    this.abortedAttempt = null;
    this.lastAttemptAt = Date.now();
    currencyRecordsReconcileRunsTotal.inc();

    const snapshot = this.runSnapshot(attempt, pageSize, maxTotalRows).finally(() => {
      if (this.activeAttempt === attempt) {
        this.inFlight = false;
        this.activeAttempt = null;
      }
    });
    void snapshot.catch(() => undefined); // 超时后底层 promise 的迟到 rejection 不得未处理
    try {
      const result = await withTimeout(snapshot, timeoutMs);
      if (this.abortedAttempt === attempt) throw new RecordsReconcileTimeoutError(timeoutMs);
      const finishedAt = Date.now();
      this.lastSuccessAt = finishedAt;
      this.lastResult = result;
      currencyRecordsReconcileLastSuccessTimestampSeconds.set(finishedAt / 1000);
      currencyRecordsReconcileTruncated.set(0);
      this.logRound(result);
      return result;
    } catch (err) {
      this.lastError = String(err).slice(0, 500);
      if (err instanceof RecordsReconcileTimeoutError) {
        this.abortedAttempt = attempt;
      } else if (err instanceof RecordsReconcileTruncatedError) {
        // 截断是「本轮查询失败」而非 abort：显式置 1（成功轮会归 0）。
        currencyRecordsReconcileTruncated.set(1);
      }
      throw err;
    }
  }

  private async runSnapshot(
    attempt: number,
    pageSize: number,
    maxTotalRows: number,
  ): Promise<RecordsReconcileRoundResult> {
    const to = Date.now();
    const from = to - RECORDS_RECONCILE_TARGET_WINDOW_MS;
    const marginFrom = from - RECORDS_RECONCILE_PAIR_MARGIN_MS;
    const marginTo = to + RECORDS_RECONCILE_PAIR_MARGIN_MS;

    const data = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      // SET 放在 try 内：即使 SET 自身失败，finally 也会尝试复位（防会话变量泄漏到
      // 复用连接上的下一轮）。三条 SET 仍严格先于首读。
      try {
        await manager.query(
          `SET SESSION max_execution_time = ${RECORDS_RECONCILE_QUERY_MAX_EXECUTION_MS}`,
        );
        await manager.query('SET SESSION lock_wait_timeout = 30');
        await manager.query('SET SESSION innodb_lock_wait_timeout = 30');
        const ops = await fetchAll<Record<string, unknown>>(
          manager,
          RECORDS_RECONCILE_OPS_SQL,
          [new Date(marginFrom), new Date(marginTo)],
          pageSize,
          maxTotalRows,
          'id',
        );
        const flows = await fetchAll<Record<string, unknown>>(
          manager,
          RECORDS_RECONCILE_FLOWS_SQL,
          [new Date(marginFrom), new Date(marginTo)],
          pageSize,
          maxTotalRows,
          'id',
        );
        const ddz = await fetchAll<Record<string, unknown>>(
          manager,
          RECORDS_RECONCILE_DDZ_SQL,
          [new Date(marginFrom), new Date(marginTo)],
          pageSize,
          maxTotalRows,
          'player_id',
        );
        const pdk = await fetchAll<Record<string, unknown>>(
          manager,
          RECORDS_RECONCILE_PDK_SQL,
          [marginFrom, marginTo], // game_records_pdk.ended_at = BIGINT(ms) ⇒ 绑 number
          pageSize,
          maxTotalRows,
          'player_id',
        );
        const skips = await fetchAll<Record<string, unknown>>(
          manager,
          RECORDS_RECONCILE_SKIPS_SQL,
          [new Date(marginFrom), new Date(marginTo)],
          pageSize,
          maxTotalRows,
          'id',
        );
        return { ops, flows, ddz, pdk, skips };
      } finally {
        for (const sql of [
          'SET SESSION max_execution_time = DEFAULT',
          'SET SESSION lock_wait_timeout = DEFAULT',
          'SET SESSION innodb_lock_wait_timeout = DEFAULT',
        ]) {
          await manager.query(sql).catch((err: unknown) => {
            this.logger.warn(`records reconcile session reset failed (${sql}): ${String(err)}`);
          });
        }
      }
    });

    if (this.abortedAttempt === attempt) {
      throw new RecordsReconcileTimeoutError(RECORDS_RECONCILE_ROUND_TIMEOUT_MS);
    }
    return this.classify(data, { from, to });
  }

  private classify(
    data: {
      ops: Array<Record<string, unknown>>;
      flows: Array<Record<string, unknown>>;
      ddz: Array<Record<string, unknown>>;
      pdk: Array<Record<string, unknown>>;
      skips: Array<Record<string, unknown>>;
    },
    window: { from: number; to: number },
  ): RecordsReconcileRoundResult {
    const { from, to } = window;
    const buckets: Record<GameType, Bucket> = {
      doudizhu: emptyBucket(),
      paodekuai: emptyBucket(),
    };
    const configUnavailable: Record<GameType, 0 | 1> = { doudizhu: 0, paodekuai: 0 };
    const inWindow = (ms: number | null): boolean => ms !== null && ms >= from && ms < to;
    const gameTypeOfOp = (op: OpRow): GameType => op.gameType ?? 'doudizhu';

    // ── 解析 ops（全 margin 窗；计数时再按目标窗裁剪）─────────────────────
    const ops: OpRow[] = [];
    const settleByRoomVersion = new Map<string, OpRow[]>();
    const entryFeeOps: OpRow[] = [];
    const entryFeeByKey = new Map<string, OpRow>();
    for (const raw of data.ops) {
      const id = Number(raw['id']);
      const createdAt = toEpochMs(raw['created_at']);
      const source = typeof raw['source'] === 'string' ? raw['source'] : '';
      if (
        !Number.isFinite(id) ||
        createdAt === null ||
        (source !== 'game_settle' && source !== 'entry_fee')
      ) {
        const gameType = normalizeGameType(raw['game_type']);
        buckets[gameType].amountMismatch.add(`op:${String(raw['id'])}:malformed`);
        continue;
      }
      const op: OpRow = {
        id,
        actionId: typeof raw['action_id'] === 'string' ? raw['action_id'] : '',
        refId: typeof raw['ref_id'] === 'string' ? raw['ref_id'] : null,
        source,
        gameType:
          raw['game_type'] === null || raw['game_type'] === undefined
            ? null
            : normalizeGameType(raw['game_type']),
        createdAt,
        burnedResidue: toNullableNumber(raw['burned_residue']),
        burnedRake: toNullableNumber(raw['burned_rake']),
      };
      ops.push(op);
      if (op.source === 'game_settle') {
        const key = roomVersionOf(op.refId);
        if (key !== null) {
          const list = settleByRoomVersion.get(key) ?? [];
          list.push(op);
          settleByRoomVersion.set(key, list);
        }
      } else {
        entryFeeOps.push(op);
        const parsed = parseEntryFeeAction(op.actionId);
        if (parsed === null) {
          if (inWindow(op.createdAt)) {
            buckets[gameTypeOfOp(op)].amountMismatch.add(`op:${op.id}:action`);
          }
        } else {
          entryFeeByKey.set(`${gameTypeOfOp(op)}:${parsed.room}:${parsed.owner}`, op);
        }
      }
    }

    const flowsByOp = new Map<number, FlowRow[]>();
    for (const raw of data.flows) {
      const opId = Number(raw['op_id']);
      const delta = Number(raw['delta']);
      if (!Number.isFinite(opId) || !Number.isFinite(delta)) continue;
      const flow: FlowRow = {
        id: Number(raw['id']),
        opId,
        ownerId: String(raw['owner_id'] ?? ''),
        ownerType: String(raw['owner_type'] ?? 'user'),
        delta,
      };
      const list = flowsByOp.get(opId) ?? [];
      list.push(flow);
      flowsByOp.set(opId, list);
    }

    // ── 记录聚合（跨页按 record_id 合并；按 room:version 另建配对索引）────────
    const records = new Map<string, RecordAgg>();
    const recordsByRoomVersion = new Map<string, RecordAgg[]>();
    const recordsByRoom = new Map<string, RecordAgg[]>();
    for (const [rows, fixedGameType] of [
      [data.ddz, 'doudizhu' as const],
      [data.pdk, null],
    ] as const) {
      for (const raw of rows) {
        const recordId = Number(raw['record_id']);
        const gameType = fixedGameType ?? normalizeGameType(raw['game_type']);
        const roomCode = String(raw['room_code'] ?? '');
        const gameVersion = Number(raw['game_version']);
        const endedAt = toEpochMs(raw['ended_at']);
        const key = `${gameType}:${roomCode}:${gameVersion}`;
        let record = records.get(key);
        if (record === undefined) {
          record = {
            gameType,
            roomCode,
            gameVersion,
            mode: String(raw['mode'] ?? ''),
            baseScore: Number(raw['base_score'] ?? 0),
            endedAt: endedAt ?? 0,
            players: [],
          };
          records.set(key, record);
          const rvKey = `${roomCode}:${gameVersion}`;
          const rvList = recordsByRoomVersion.get(rvKey) ?? [];
          rvList.push(record);
          recordsByRoomVersion.set(rvKey, rvList);
          const roomList = recordsByRoom.get(roomCode) ?? [];
          roomList.push(record);
          recordsByRoom.set(roomCode, roomList);
        }
        if (!Number.isFinite(recordId)) continue;
        record.players.push({
          playerId: Number(raw['player_id']),
          recordId,
          userId:
            raw['user_id'] === null || raw['user_id'] === undefined
              ? null
              : String(raw['user_id']),
          isRobot: Number(raw['is_robot']) === 1 || raw['is_robot'] === true,
          robotId:
            raw['robot_id'] === null || raw['robot_id'] === undefined
              ? null
              : String(raw['robot_id']),
          moneyDelta: toNullableNumber(raw['money_delta']),
          scoreChange: Number(raw['score_change'] ?? 0),
        });
      }
    }

    const skips = new Set<string>();
    for (const raw of data.skips) {
      const gameType = normalizeGameType(raw['game_type']);
      const roomCode = String(raw['room_code'] ?? '');
      const ownerId = String(raw['owner_id'] ?? '');
      if (roomCode !== '' && ownerId !== '') skips.add(`${gameType}:${roomCode}:${ownerId}`);
    }

    // A2 旧标签兼容（D12）：room 唯一 ⇒ pdk 记录可回退到标了 ddz 的旧 op/skip。
    const lookupEntryFeeOp = (
      gameType: GameType,
      room: string,
      owner: string,
    ): OpRow | undefined => {
      const exact = entryFeeByKey.get(`${gameType}:${room}:${owner}`);
      if (exact !== undefined) return exact;
      return gameType === 'doudizhu'
        ? undefined
        : entryFeeByKey.get(`doudizhu:${room}:${owner}`);
    };
    const hasEntryFeeSkip = (gameType: GameType, room: string, owner: string): boolean => {
      if (skips.has(`${gameType}:${room}:${owner}`)) return true;
      return gameType !== 'doudizhu' && skips.has(`doudizhu:${room}:${owner}`);
    };

    const handledRecordKeys = new Set<string>();

    // ── B：game_settle op → 记录 ──────────────────────────────────────────
    for (const op of ops) {
      if (op.source !== 'game_settle') continue;
      const opInTarget = inWindow(op.createdAt);
      const opGameType = gameTypeOfOp(op);
      const key = roomVersionOf(op.refId);
      if (key === null) {
        if (opInTarget) buckets[opGameType].amountMismatch.add(`op:${op.id}:ref`);
        continue;
      }
      const candidates = recordsByRoomVersion.get(key) ?? [];
      const exact = records.get(`${opGameType}:${key}`);
      if (exact === undefined && candidates.length > 1) {
        // 精确玩法缺失且 room:version 命中多条 ⇒ 无法判定配对（不静默并入正常）。
        if (opInTarget || candidates.some((candidate) => inWindow(candidate.endedAt))) {
          buckets[opGameType].amountMismatch.add(`op:${op.id}:ambiguous`);
        }
        continue;
      }
      const record: RecordAgg | undefined = exact ?? candidates[0];
      if (record === undefined) {
        if (!opInTarget) continue;
        const age = to - op.createdAt;
        if (age < RECORDS_RECONCILE_ORPHAN_GRACE_MS) {
          buckets[opGameType].pending.add(`op:${op.id}:no-record`);
        } else {
          buckets[opGameType].orphanOps.add(`op:${op.id}`);
        }
        continue;
      }
      const recordInTarget = inWindow(record.endedAt);
      if (!opInTarget && !recordInTarget) continue;
      handledRecordKeys.add(recordKeyOf(record));
      const bucket = buckets[record.gameType];
      if (record.mode !== 'gold') {
        bucket.amountMismatch.add(`op:${op.id}:mode`);
        continue;
      }

      const flows = flowsByOp.get(op.id) ?? [];
      if (flows.length === 0) {
        bucket.amountMismatch.add(`op:${op.id}:no-flows`);
        continue;
      }
      const playerByOwner = new Map<string, PlayerRow>();
      for (const player of record.players) {
        if (player.isRobot ? player.robotId !== null : player.userId !== null) {
          playerByOwner.set(ownerKeyOf(player), player);
        }
      }
      const flowOwners = new Set<string>();
      for (const flow of flows) {
        const ownerKey = `${flow.ownerType === 'robot' ? 'robot' : 'user'}:${flow.ownerId}`;
        flowOwners.add(ownerKey);
        const player = playerByOwner.get(ownerKey);
        if (player === undefined) {
          bucket.amountMismatch.add(`op:${op.id}:owner:${flow.ownerId}`);
          continue;
        }
        if (player.moneyDelta === null) {
          // D6：op 年龄 ≤2h ⇒ pending；>2h ⇒ nullMoneyDelta（不直接排除金额不一致）。
          if (to - op.createdAt <= RECORDS_RECONCILE_NULL_GRACE_MS) {
            bucket.pending.add(`op:${op.id}:null:${player.playerId}`);
          } else {
            bucket.nullMoneyDelta.add(`op:${op.id}:${player.playerId}`);
          }
          continue;
        }
        if (flow.delta !== player.moneyDelta) {
          bucket.amountMismatch.add(`op:${op.id}:delta:${player.playerId}`);
        }
        // D8：赢家 money_delta ≥ score_change（抽水/截断）；输家 ≤ score_change。
        if (flow.delta > 0 && player.scoreChange < flow.delta) {
          bucket.amountMismatch.add(`op:${op.id}:win-bound:${player.playerId}`);
        }
        if (flow.delta < 0 && player.scoreChange > flow.delta) {
          bucket.amountMismatch.add(`op:${op.id}:lose-bound:${player.playerId}`);
        }
      }
      for (const player of record.players) {
        if (player.moneyDelta === null || player.moneyDelta === 0) continue;
        if (!flowOwners.has(ownerKeyOf(player))) {
          bucket.amountMismatch.add(`op:${op.id}:missing-flow:${player.playerId}`);
        }
      }
      // D9：全部非 NULL 且 burn 两列非 NULL ⇒ Σ + residue + rake === 0；否则跳过。
      if (
        op.burnedResidue !== null &&
        op.burnedRake !== null &&
        record.players.every((player) => player.moneyDelta !== null)
      ) {
        const sum = record.players.reduce((acc, player) => acc + (player.moneyDelta ?? 0), 0);
        if (sum + op.burnedResidue + op.burnedRake !== 0) {
          bucket.amountMismatch.add(`op:${op.id}:conservation`);
        }
      }
    }

    // ── A：记录 → settle op（仅目标窗内 gold 记录）──────────────────────────
    for (const record of records.values()) {
      if (!inWindow(record.endedAt)) continue;
      if (record.mode !== 'gold') continue;
      const key = recordKeyOf(record);
      if (handledRecordKeys.has(key)) continue;
      const age = to - record.endedAt;
      if (age <= RECORDS_RECONCILE_OP_GRACE_MS) {
        buckets[record.gameType].pending.add(key);
        continue;
      }
      const deltas = record.players.map((player) => player.moneyDelta);
      if (deltas.some((delta) => delta !== null && delta !== 0)) {
        buckets[record.gameType].missingOps.add(key);
      } else if (deltas.some((delta) => delta === null)) {
        buckets[record.gameType].nullNoOp.add(key);
      }
      // 全 0（无 NULL）⇒ 合法跳过。
    }

    // ── C1：记录（gold）↔ entry_fee op / skip ─────────────────────────────
    const percentsCache = new Map<GameType, readonly EntryFeePercent[] | null>();
    const percentsOf = (gameType: GameType): readonly EntryFeePercent[] | null => {
      if (!percentsCache.has(gameType)) {
        percentsCache.set(gameType, this.configCache.entryFeePercents(gameType));
      }
      return percentsCache.get(gameType) ?? null;
    };
    for (const record of records.values()) {
      if (!inWindow(record.endedAt) || record.mode !== 'gold') continue;
      for (const player of record.players) {
        if (player.isRobot || player.userId === null) continue;
        const op = lookupEntryFeeOp(record.gameType, record.roomCode, player.userId);
        if (op !== undefined) {
          const flows = flowsByOp.get(op.id) ?? [];
          if (
            flows.length !== 1 ||
            flows[0]!.ownerId !== player.userId ||
            flows[0]!.delta >= 0
          ) {
            buckets[record.gameType].amountMismatch.add(
              `fee:${record.gameType}:${record.roomCode}:${player.userId}:flow`,
            );
          }
          continue;
        }
        if (hasEntryFeeSkip(record.gameType, record.roomCode, player.userId)) continue;
        const percents = percentsOf(record.gameType);
        if (percents === null) {
          configUnavailable[record.gameType] = 1;
          continue;
        }
        const fee = entryFeeOf(record.baseScore, percents);
        if (fee > 0) {
          buckets[record.gameType].entryFeeSuspect.add(
            `${record.gameType}:${record.roomCode}:${player.userId}`,
          );
        } else {
          buckets[record.gameType].entryFeeUnknown.add(
            `${record.gameType}:${record.roomCode}:${player.userId}`,
          );
        }
      }
    }

    // ── C2：entry_fee op（目标窗内）→ 记录 ──────────────────────────────────
    for (const op of entryFeeOps) {
      if (!inWindow(op.createdAt)) continue;
      const parsed = parseEntryFeeAction(op.actionId);
      if (parsed === null) continue; // 已在解析段计 mismatch
      const recordsInRoom = recordsByRoom.get(parsed.room) ?? [];
      if (recordsInRoom.length === 0) {
        const age = to - op.createdAt;
        // D11：≤25h pending；>25h entryFeeOrphanOps。
        if (age <= RECORDS_RECONCILE_ENTRY_FEE_ORPHAN_GRACE_MS) {
          buckets[gameTypeOfOp(op)].pending.add(`fee-op:${op.id}:no-record`);
        } else {
          buckets[gameTypeOfOp(op)].entryFeeOrphanOps.add(`fee-op:${op.id}`);
        }
        continue;
      }
      // D12：有记录以记录表玩法为准（旧 PDK op 标 ddz 不误报）；优先精确玩法。
      const opGameType = gameTypeOfOp(op);
      const goldRecords = recordsInRoom.filter((record) => record.mode === 'gold');
      const bucketGameType =
        goldRecords.find((record) => record.gameType === opGameType)?.gameType ??
        goldRecords[0]?.gameType ??
        recordsInRoom.find((record) => record.gameType === opGameType)?.gameType ??
        recordsInRoom[0]!.gameType;
      const ownerIsRealSeat = goldRecords.some((record) =>
        record.players.some((player) => !player.isRobot && player.userId === parsed.owner),
      );
      if (goldRecords.length === 0 || !ownerIsRealSeat) {
        buckets[bucketGameType].amountMismatch.add(`fee-op:${op.id}:owner`);
      }
    }

    const byGame: RecordsReconcileRoundResult['byGame'] = {
      doudizhu: countsOf(buckets.doudizhu, configUnavailable.doudizhu),
      paodekuai: countsOf(buckets.paodekuai, configUnavailable.paodekuai),
    };
    const totals: RecordsReconcileCounts = {
      orphanOps: byGame.doudizhu.orphanOps + byGame.paodekuai.orphanOps,
      missingOps: byGame.doudizhu.missingOps + byGame.paodekuai.missingOps,
      nullNoOp: byGame.doudizhu.nullNoOp + byGame.paodekuai.nullNoOp,
      amountMismatch: byGame.doudizhu.amountMismatch + byGame.paodekuai.amountMismatch,
      pending: byGame.doudizhu.pending + byGame.paodekuai.pending,
      nullMoneyDelta: byGame.doudizhu.nullMoneyDelta + byGame.paodekuai.nullMoneyDelta,
      entryFeeSuspect: byGame.doudizhu.entryFeeSuspect + byGame.paodekuai.entryFeeSuspect,
      entryFeeUnknown: byGame.doudizhu.entryFeeUnknown + byGame.paodekuai.entryFeeUnknown,
      entryFeeOrphanOps:
        byGame.doudizhu.entryFeeOrphanOps + byGame.paodekuai.entryFeeOrphanOps,
      configUnavailable: configUnavailable.doudizhu || configUnavailable.paodekuai ? 1 : 0,
    };

    for (const gameType of ['doudizhu', 'paodekuai'] as const) {
      const counts = byGame[gameType];
      setGame(currencyRecordsReconcileOrphanOps, gameType, counts.orphanOps);
      setGame(currencyRecordsReconcileMissingOps, gameType, counts.missingOps);
      setGame(currencyRecordsReconcileNullNoOp, gameType, counts.nullNoOp);
      setGame(currencyRecordsReconcileAmountMismatch, gameType, counts.amountMismatch);
      setGame(currencyRecordsReconcilePending, gameType, counts.pending);
      setGame(currencyRecordsReconcileNullMoneyDelta, gameType, counts.nullMoneyDelta);
      setGame(currencyRecordsReconcileEntryFeeSuspect, gameType, counts.entryFeeSuspect);
      setGame(currencyRecordsReconcileEntryFeeUnknown, gameType, counts.entryFeeUnknown);
      setGame(currencyRecordsReconcileEntryFeeOrphanOps, gameType, counts.entryFeeOrphanOps);
      setGame(currencyRecordsReconcileConfigUnavailable, gameType, counts.configUnavailable);
    }
    return { ...totals, truncated: false, byGame };
  }

  private logRound(result: RecordsReconcileRoundResult): void {
    this.logger.log(
      `records reconcile done: orphanOps=${result.orphanOps} missingOps=${result.missingOps} ` +
        `nullNoOp=${result.nullNoOp} amountMismatch=${result.amountMismatch} pending=${result.pending} ` +
        `nullMoneyDelta=${result.nullMoneyDelta} entryFeeSuspect=${result.entryFeeSuspect} ` +
        `entryFeeUnknown=${result.entryFeeUnknown} entryFeeOrphanOps=${result.entryFeeOrphanOps}`,
    );
    for (const gameType of ['doudizhu', 'paodekuai'] as const) {
      const counts = result.byGame[gameType];
      if (
        counts.amountMismatch > 0 ||
        counts.missingOps > 0 ||
        counts.nullNoOp > 0 ||
        counts.nullMoneyDelta > 0
      ) {
        this.logger.warn(
          `records reconcile ${gameType}: mismatch/missing=${counts.amountMismatch}/${counts.missingOps} ` +
            `nullNoOp=${counts.nullNoOp} nullMoneyDelta=${counts.nullMoneyDelta}`,
        );
      }
    }
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** `room:version`（ref_id）解析；最后冒号切分，version 正整数。 */
function roomVersionOf(refId: string | null): string | null {
  if (refId === null) return null;
  const idx = refId.lastIndexOf(':');
  if (idx <= 0 || idx === refId.length - 1) return null;
  const room = refId.slice(0, idx);
  const version = Number(refId.slice(idx + 1));
  if (!Number.isInteger(version) || version <= 0) return null;
  return `${room}:${version}`;
}

/** `entryfee:<room>:<owner>` 解析。 */
function parseEntryFeeAction(actionId: string): { room: string; owner: string } | null {
  const parts = actionId.split(':');
  if (parts.length !== 3 || parts[0] !== 'entryfee' || parts[1] === '' || parts[2] === '') return null;
  return { room: parts[1]!, owner: parts[2]! };
}

async function fetchAll<T extends Record<string, unknown>>(
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  sql: string,
  baseParams: unknown[],
  pageSize: number,
  maxTotalRows: number,
  lastIdKey: string,
): Promise<T[]> {
  const rows: T[] = [];
  let lastId = 0;
  for (;;) {
    const page = (await manager.query(sql, [...baseParams, lastId, pageSize])) as T[];
    rows.push(...page);
    if (rows.length > maxTotalRows) throw new RecordsReconcileTruncatedError(maxTotalRows);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]!;
    const next = Number(last[lastIdKey] ?? last['id']);
    if (!Number.isFinite(next) || next <= lastId) {
      throw new Error(`records reconcile pagination did not advance (${lastIdKey}=${String(next)})`);
    }
    lastId = next;
  }
  return rows;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RecordsReconcileTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
