/**
 * 管理面**用户名规则单一真源**（③ 财务后台 + RBAC + 审计 T1；规格 §0.3 ⚙️8）。
 *
 * 规则逐字：`^[a-z0-9][a-z0-9._-]{2,31}$` —— 首字符 `[a-z0-9]`、其后 2..31 位 `[a-z0-9._-]`，
 * 总长 3..32。**不做 trim、不做归一**；空白字符一律由正则直接拒绝。
 * 归一（`toLowerCase()`）是**调用方**的事，且必须发生在跑本函数之前。
 *
 * 校验三处共用 `isAdminUsername()`：建号 / CLI（hatch）/ currency 侧 `X-Admin-Actor`；
 * **登录路径不跑正则**（只归一 + 查无此人 ⇒ 401，规格 §2.3 处理序）。
 *
 * ⚠️ **为什么放 protocol**（规格 S2）：config-service 与 currency-service 都要用，
 * 放 config-service 私有包会让 currency 侧跨服务 import 撞
 * `packages/shared/test/dockerfile-workspace-copy.gate.test.ts` 那条副本闸。
 *
 * ⚠️ **为什么 `ADMIN_USERNAME_PATTERN` 以字符串形态导出**（而非直接导出 RegExp）：
 * 消费方需要**逐字引用**它（错误文案/断言/文档核对）；函数本体与它共用同一真源
 * （`new RegExp(ADMIN_USERNAME_PATTERN)`）——两条真源互锁，改任一侧另一侧的测试必红。
 */

/** 用户名正则的字面形态（单一真源；`isAdminUsername` 用它构造匹配器）。 */
export const ADMIN_USERNAME_PATTERN = '^[a-z0-9][a-z0-9._-]{2,31}$';

/** 模块级单例匹配器（无 `g`/`m` 旗标 ⇒ `test` 无 `lastIndex` 状态、`$` 只认输入末尾）。 */
const ADMIN_USERNAME_RE = new RegExp(ADMIN_USERNAME_PATTERN);

/**
 * 用户名合法性（⚙️8）：合法 = 3..32 字符、首字符 `[a-z0-9]`、其后 `[a-z0-9._-]`。
 * 非字符串（`null` / `undefined` / 数字 / 对象…）一律 `false`；**不做 trim**。
 */
export function isAdminUsername(s: unknown): boolean {
  return typeof s === 'string' && ADMIN_USERNAME_RE.test(s);
}
