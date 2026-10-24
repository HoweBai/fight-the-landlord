/**
 * 支付片 T7：**订单状态机**（`payment_orders` 的全部状态迁移；规格 §3.1 逐字）。
 *
 * 本模块只有**常量**（裸 SQL，不用 TypeORM entity）——每个常量在 `orders-state.test.ts` 里
 * **全文钉**（一个字符的漂移即红）；消费方：T7 `OrdersService` · T8 回调链（同一迁移路径）·
 * T9 入账（`paid→credited` 的调用点在 T9 的 apply 成功之后）。
 *
 * ─── 转移与并发（条件更新 = 唯一并发安全机制）────────────────────────────
 *  ① `created→paid`：`WHERE order_no=? AND status='created'`——两回调并发时恰一行 affected=1，
 *     另一行 affected=0（`OrdersService.transitionToPaid` 读现状判别 already/none）；
 *  ② `closed→paid` **重开**：迟到回调 / trade.close 报「已支付」时走这条（**钱在手必入账**——
 *     本地过期与渠道窗口的时钟边缘不得吞钱），记 `late_reopen_at`；⚠️ 规格原文的该语句
 *     **不含** `trade_no`/`paid_at`（逐字照抄，见测试全文钉）；
 *  ③ `paid→credited`：apply 成功后的落账（T9 调用）；
 *  ④ 过期关闭：**批量**条件更新（无 order_no 参数——收集行后一次关批；逐行 trade.close 的
 *     「已支付」判别在服务层，转 ② 重开）。
 *
 * 时间一律 `NOW(3)`（UTC 存储、`datetime(3)`——服务端 DB 时钟是唯一权威，不传 JS 时间）。
 */

/** ① `created→paid`（回调/补单首达；参数 `[trade_no, order_no]`）。 */
export const ORDER_CREATED_TO_PAID_SQL =
  "UPDATE `payment_orders` SET `status`='paid', `trade_no`=?, `paid_at`=NOW(3) WHERE `order_no`=? AND `status`='created'";

/** ② `closed→paid` 重开（迟到支付；参数 `[order_no]`；记 `late_reopen_at`）。 */
export const ORDER_CLOSED_TO_PAID_REOPEN_SQL =
  "UPDATE `payment_orders` SET `status`='paid', `late_reopen_at`=NOW(3) WHERE `order_no`=? AND `status`='closed'";

/** ③ `paid→credited`（apply 成功落账；参数 `[order_no]`；调用点在 T9）。 */
export const ORDER_PAID_TO_CREDITED_SQL =
  "UPDATE `payment_orders` SET `status`='credited', `credited_at`=NOW(3) WHERE `order_no`=? AND `status`='paid'";

/** ④ 过期关闭（批量；无参数——`WHERE status='created' AND expires_at < NOW(3)`）。 */
export const ORDER_CLOSE_EXPIRED_SQL =
  "UPDATE `payment_orders` SET `status`='closed', `closed_at`=NOW(3) WHERE `status`='created' AND `expires_at` < NOW(3)";
