/**
 * 「配置快照已应用」日志的**行计数**（slice-35 消费；口径与 slice-20/24/31 的既有实现一致）。
 *
 * ─── 为什么判据只认 `version=N\b`（2026-10-27 真栈根因）─────────────────────
 * 各服务的行格式**不一样**：api-gateway 的 `config snapshot applied (version=N)` 直接以
 * 右括号收尾，而 currency-service / room-service / user-service / payment-service /
 * robot-service 的版本号后面**还有字段**（如
 * `config snapshot applied (version=28, reliefEnabled=false)`）。
 * 把判据写成字面量 `config snapshot applied (version=N)`（版本号后紧跟 `)`）在后者上
 * **恒不匹配** ⇒ 计数恒 0 ⇒ 等待永远超时（slice-35 权威轮首红即此；产品链路本身正常）。
 * 因此统一只匹配 `version=N\b`：整词相等（`version=28` 不会误吃 `version=280`）。
 *
 * ─── 为什么用**时间锚**而不是「滑动窗口 + 基线计数」─────────────────────────
 *  `docker compose logs --since <窗口>` 是**滑动**的：旧行老化会与新行到达相抵，出现
 *  「PUT 后计数 47→47」的**假红**（slice-20 的本机实证）。时间锚只数 `ts ≥ sinceMs`
 *  的行 ⇒ 老化无关，「PUT 之前已有的同版本行」也不会假通过。
 *  ⚠️ 锚必须取在 **PUT 之前**（发布→响应只有毫秒级窗口；取后取会漏掉自己那一行）。
 *  ⚠️ 依赖 `ts` 与调用方在同一时钟上（conformance 与容器同宿主，slice-20 同口径）。
 */

/** 一行 `docker compose logs` 输出里抽出 NDJSON 记录（`ftl-x  | {…}` 前缀 / 非 JSON 行 ⇒ null）。 */
function parseNdjson(line: string): Record<string, unknown> | null {
  const at = line.indexOf('{');
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at)) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 日志里 **`ts ≥ sinceMs`** 且 `msg` 为「该版本配置快照已应用」的行数。
 *
 * @param logText  `docker compose logs --no-color --since <窗口> <service>` 的原始输出
 * @param version  期望的快照版本（= `max(全局, 本键+1)`，PUT 后会成为新的全局 MAX）
 * @param sinceMs  时间锚（**PUT 之前**取的 `Date.now()`）；只数锚后的行
 */
export function countSnapshotApplied(logText: string, version: number, sinceMs: number): number {
  const matcher = new RegExp(`version=${version}\\b`);
  let count = 0;
  for (const line of logText.split('\n')) {
    const record = parseNdjson(line);
    if (record === null) continue;
    const msg = record['msg'];
    if (typeof msg !== 'string' || !msg.includes('config snapshot applied')) continue;
    const ts = Date.parse(String(record['ts'] ?? ''));
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    if (matcher.test(msg)) count += 1;
  }
  return count;
}
