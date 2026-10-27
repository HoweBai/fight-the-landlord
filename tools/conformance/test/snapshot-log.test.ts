import { describe, expect, it } from 'vitest';
import { countSnapshotApplied } from '../src/lib/snapshot-log';

/**
 * 行格式**逐字**照 2026-10-27 CI 现场的 currency-service 日志（`docker compose logs` 的
 * `ftl-<service>  | ` 前缀 + NDJSON）。⚠️ 判据回归的正是「版本号后面还有字段」这一点：
 * 行尾是 `, reliefEnabled=false)`，不是 `)`。
 */
const line = (ts: string, msg: string, service = 'currency-service'): string =>
  `ftl-${service}  | {"ts":"${ts}","level":"log","service":"${service}","context":"ConfigCacheService",` +
  `"traceId":null,"reqId":null,"userId":null,"source":"internal","msg":"${msg}"}`;

const APPLIED = (version: number): string =>
  `config snapshot applied (version=${version}, reliefEnabled=false)`;

/** 时间锚（照 `putLevels`：PUT 之前取；只有 ts ≥ 它的行才算「PUT 之后」）。 */
const ANCHOR = Date.parse('2026-10-27T15:16:22.000Z');

describe('countSnapshotApplied', () => {
  it('真实行格式 `config snapshot applied (version=28, reliefEnabled=false)` 必须计数（右括号陷阱）', () => {
    const log = [
      line('2026-10-27T15:16:23.157Z', APPLIED(28)),
      line('2026-10-27T15:17:12.233Z', APPLIED(28)),
    ].join('\n');

    expect(countSnapshotApplied(log, 28, ANCHOR)).toBe(2);
  });

  it('时间锚之前的行不计（旧行不假通过）', () => {
    const log = [
      line('2026-10-27T15:16:12.240Z', APPLIED(28)), // 锚前：轮 C 启动拉取
      line('2026-10-27T15:16:23.157Z', APPLIED(28)), // 锚后：还原 PUT 的推送
    ].join('\n');

    expect(countSnapshotApplied(log, 28, ANCHOR)).toBe(1);
  });

  it('版本号必须整词相等：version=280 / version=2 都不算 version=28', () => {
    const log = [
      line('2026-10-27T15:16:23.157Z', APPLIED(280)),
      line('2026-10-27T15:16:23.157Z', APPLIED(2)),
      line('2026-10-27T15:16:23.157Z', APPLIED(27)),
    ].join('\n');

    expect(countSnapshotApplied(log, 28, ANCHOR)).toBe(0);
  });

  it('非快照行、非 JSON 行、缺 ts 的行一律忽略', () => {
    const log = [
      'Currency Service running on port 3004 (RPC 3104)',
      line('2026-10-27T15:16:23.157Z', 'Subscribed to config:changed'),
      line('2026-10-27T15:16:23.157Z', 'config snapshot reload failed (keeping cached snapshot): boom'),
      line('2026-10-27T15:16:23.157Z', APPLIED(28)),
    ].join('\n');

    expect(countSnapshotApplied(log, 28, ANCHOR)).toBe(1);
  });
});
