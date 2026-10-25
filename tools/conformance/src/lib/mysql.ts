/**
 * `docker compose exec -T mysql mysql …` 的共享助手（conformance 的**真库**探针）。
 *
 * 为什么抽出来：代理分润片（slice-30）要直接观测 17 张代理账本表；后续切片也可能需要。
 * 与 `redis.ts` 同族，把三条实测细节写死在助手层：
 *  1. **`-T` 必须有**（不分配 TTY；无 TTY 环境下缺它会挂住）；
 *  2. SQL 走 **stdin**（`spawnSync.input`）—— 避免 shell 引号/换行/`$` 展开把 SQL 改坏；
 *  3. 密码/库名取**容器自身 env**（`MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE`），
 *     不在调用方重复默认值（栈换了口令也不会两处漂移）。
 *
 * ⚠️ mysql 客户端把「密码在命令行」的告警写到 **stderr**、退出码仍是 0；读数一律取 stdout。
 * ⚠️ 本助手是**同步**的：`spawnSync` 会冻结事件循环。因此它只用于「发 SQL → 等结果」，
 *     **不得**用它构造跨 HTTP 的双会话事务（那需要长驻 `spawn`，见 slice-30 的构造说明）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ConformanceError } from './assert';

/** 仓库根（`dist/lib/*.js` 与 `dist/slices/*.js` 同深度 ⇒ 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

export interface MysqlResult {
  /** `mysql` 的退出码（`null` = 被信号/超时杀掉）。 */
  status: number | null;
  stdout: string;
  stderr: string;
}

function tail(text: string, lines = 3): string {
  return text.trim().split('\n').slice(-lines).join(' / ');
}

/** 原始探针：**不抛错**，退出码与两路输出都交给调用方。 */
export function mysqlRaw(sql: string, timeoutMs = 30_000): MysqlResult {
  const res = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'mysql',
      'sh',
      '-c',
      'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -B',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      input: sql,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/** 非空、非 `mysql:` 告警的输出行。 */
export function mysqlLines(sql: string, timeoutMs = 30_000): string[] {
  const res = mysqlRaw(sql, timeoutMs);
  if (res.status !== 0) {
    throw new ConformanceError(
      `mysql 查询失败（exit ${res.status}）：${tail(res.stderr) || tail(res.stdout) || '（无输出）'}`,
    );
  }
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('mysql:'));
}

/** 单值查询的末行文本（空结果 ⇒ 抛，不把空串装成值）。 */
export function mysqlText(sql: string, timeoutMs = 30_000): string {
  const lines = mysqlLines(sql, timeoutMs);
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new ConformanceError(`mysql 文本读数为空（SQL 前缀：${sql.slice(0, 120)}）`);
  }
  return last;
}

/** 单值数字（`COUNT(*)` / `SUM`）。 */
export function mysqlNum(sql: string, timeoutMs = 30_000): number {
  const text = mysqlText(sql, timeoutMs);
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new ConformanceError(`mysql 数字读数非法：${JSON.stringify(text)}（SQL 前缀：${sql.slice(0, 120)}）`);
  }
  return n;
}

/** 多行 × 多列（`-N -B` ⇒ TAB 分隔、无表头）。 */
export function mysqlRows(sql: string, timeoutMs = 30_000): string[][] {
  return mysqlLines(sql, timeoutMs).map((line) => line.split('\t'));
}

/**
 * 执行写语句（`UPDATE` / `INSERT` / `RENAME TABLE` …）。
 * 返回 stdout（`-B` 下通常为空）；非零退出 ⇒ 抛。
 */
export function mysqlExec(sql: string, timeoutMs = 30_000): string {
  const res = mysqlRaw(sql, timeoutMs);
  if (res.status !== 0) {
    throw new ConformanceError(
      `mysql 执行失败（exit ${res.status}）：${tail(res.stderr) || tail(res.stdout) || '（无输出）'}`,
    );
  }
  return res.stdout;
}
