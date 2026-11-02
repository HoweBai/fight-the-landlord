/**
 * 代理域共享 SQL 结果解析（2026-11-03）。
 *
 * `affectedRowsOf` 原先私有在 `agent-bindings.service.ts`；一次性邀请码的
 * rotate/revoke 也需要同一判据 ⇒ 抽到本文件，避免三份克隆漂移。
 */
export function affectedRowsOf(result: unknown, context: string): number {
  const n = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）`);
  }
  return n;
}
