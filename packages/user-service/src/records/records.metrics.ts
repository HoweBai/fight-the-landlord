// packages/user-service/src/records/records.metrics.ts
import { createCounter, createGauge } from '@fight-the-landlord/shared';

/**
 * 记录保留期清理的**四个指标**（监控片规格 §2.2 的四行；设计 Y4/§2.4bis 的
 * `RecordsCleanupStalled` / `RecordsCleanupFailing` 两条规则的读面）。
 *
 * 写点全在 `records-cleanup.service.ts`（`onModuleInit` / 成功分支 / 失败 catch），
 * 本文件只是**定义**。四个指标都经 shared 的构造器（规格 §2.3 的 registry 同一性纪律
 * ——不许直连 prom-client）。
 *
 * ⚠️ **显式 `ReturnType<typeof createGauge/createCounter>` 注记不是风格偏好**：本包不直接
 * 依赖 prom-client（类型无法在声明里命名）⇒ 不加注记时 `tsc` 报 TS2742（declaration emit
 * 要求类型可命名）。注记让声明按字面写入，不跨包引用 prom-client 的路径
 * （先例：robot-service 的 `robot.metrics.ts`）。
 *
 * 四个都**无标签**（值域天然唯一 ⇒ 基数题不存在）。
 */

/**
 * 「最近一次成功」的 Unix 时间戳（**秒**）。
 *
 * 🔴 语义的一半在**初值**：`onModuleInit` 先置 **0** —— 「从未成功」（首启 / 一直失败）
 * 也会被 `RecordsCleanupStalled`（`time() - 值 > 7200`）命中；首轮 30s 成功即消失。
 * 失败轮**不擦**它（失败只进 `records_cleanup_failures_total`）。
 */
export const recordsCleanupLastSuccessTimestampSeconds: ReturnType<typeof createGauge> = createGauge(
  'records_cleanup_last_success_timestamp_seconds',
  '记录清理最近一次成功的 Unix 时间戳（秒）。启动置 0（「从未成功」语义，供 RecordsCleanupStalled 判读）；成功分支写 Date.now()/1000；失败轮不擦。',
);

/** 失败轮数（一轮抛错计一次；失败不终止循环，下一轮照排——所以它是「曾经坏过多久」的读面）。 */
export const recordsCleanupFailuresTotal: ReturnType<typeof createCounter> = createCounter(
  'records_cleanup_failures_total',
  '记录清理轮失败次数（一轮抛错计一次；失败不终止循环）。',
);

/**
 * 累计删除的 `game_records` 行数（口径 = 每轮成功分支的 `recordsDeleted`）。
 *
 * ⚠️ `game_record_players` 的删除行数**不计入**（规格 §2.2 逐字；它先于 records 删、
 * 是记录行的从属）——那边读数在每轮日志行的 `deletedPlayers=` 里。
 */
export const recordsRowsDeletedTotal: ReturnType<typeof createCounter> = createCounter(
  'records_rows_deleted_total',
  '记录清理累计删除的 game_records 行数（按玩法；值 = 每轮 recordsDeleted；players 侧删除量见日志行）。',
  ['game_type'],
);

/**
 * 两表体积之和（`DATA_LENGTH + INDEX_LENGTH`，`information_schema` 口径 —— **近似值**，
 * InnoDB 的行数与体积本就是估算）。成功分支采样；**采样失败保留旧值**（WARN 留痕，绝不擦）。
 */
export const recordsTableBytes: ReturnType<typeof createGauge> = createGauge(
  'records_table_bytes',
  'game_records + game_record_players 的 DATA_LENGTH+INDEX_LENGTH 之和（information_schema 近似值；仅采样成功时更新，失败保留旧值）。',
);
