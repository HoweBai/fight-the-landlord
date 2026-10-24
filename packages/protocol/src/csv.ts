/**
 * **CSV 单元格算法单一真源**（③ 财务后台 + RBAC + 审计 T1；规格 §0.3 ⚙️7 + §2.11）。
 *
 * 五个列表面（flows / summary / config-changes / login-events / account-changes）共用本件的
 * `csvCell` 与 `CSV_BOM`；**禁复制**（规格 S3：放 protocol 的理由同 ⚙️8 —— 双服务已依赖本包，
 * 跨服务不可复制私有文件）。
 *
 * 判别式逐字（§2.11）：
 *  1. `null` / `undefined` ⇒ `''`；其余 `String(v)`；
 *  2. **非 NUMERIC** 且首字符 ∈ {`=` `+` `-` `@` `\t` `\r`} ⇒ 前置 `'`（公式注入消毒；合法数字豁免）；
 *  3. 含 `"` / `,` / CR / LF ⇒ 整格双引号包裹 + 内部 `"` 双写（RFC4180）。
 *
 * 行尾 `\r\n`、表头中文、`Content-Disposition` 文件名与各面的行上限是**各列表面**的事
 * （后续任务消费本件时照 §2.11 拼装），本件只钉 BOM 与单元格两个共享值。
 */

/** 内容首字节 BOM（§2.11：UTF-8 BOM，U+FEFF 恰好一字符）。 */
export const CSV_BOM = '\uFEFF';

/** 全数字形态（含负号与小数）—— 公式注入消毒的**豁免**判据（§2.11 逐字）。 */
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * 单元格消毒 + RFC4180 转义（§2.11 ⚙️7 逐字实现）。
 *
 * - `null` / `undefined` ⇒ 空串；其余 `String(v)`；
 * - 公式注入消毒：**非 NUMERIC** 且首字符 ∈ {`=` `+` `-` `@` `\t` `\r`} ⇒ 前置 `'`
 *   （`-12.5` 这类合法数字豁免；`-abc` 这类危险串不豁免）；
 * - 含 `"` / `,` / CR / LF ⇒ 双引号包裹、内部 `"` 双写。
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (!NUMERIC.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // 公式注入消毒（合法数字豁免）
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
