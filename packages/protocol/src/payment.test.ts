import { describe, expect, it } from 'vitest';
import {
  PAY_ORDER_PREFIX,
  REFUND_PREFIX,
  WITHDRAW_PREFIX,
  type AdminPayActionRow,
  type AdminPayConfirmRequest,
  type AdminPayRefundReviewResponse,
  type AdminPayReviewRequest,
  type AdminPayWithdrawReviewResponse,
  type PayCreateOrderRequest,
  type PayCreateOrderResponse,
  type PayOrderInfo,
  type PayOrderStatus,
  type PayRefundApplyRequest,
  type PayRefundApplyResponse,
  type PayRefundInfo,
  type PayRefundStatus,
  type PayWalletSummary,
  type PayWithdrawApplyRequest,
  type PayWithdrawApplyResponse,
  type PayWithdrawInfo,
  type PayWithdrawStatus,
} from './payment';

/**
 * 支付片 T1：`payment.ts`（REST DTO 类型 + 单号前缀常量）单测。
 *
 * - **运行期可断言**的只有三个前缀常量（其余是纯类型）；
 * - 类型面用「带注解的字面量 + 键集断言」钉形状：键集逐字 = 规格 §2.4 两表**写死的那几列**；
 *   规格未枚举键集的形状（mine 列表行 / 管理面行等）只做**编译期**注解检查（`pnpm lint` 兜底），
 *   不在此做运行时键集断言（免得把「未钉死的行形状」误升格为冻结面）。
 */

describe('单号前缀常量（⚙️4：`pay_`/`rf_`/`wd_` 三前缀逐字）', () => {
  it('三个前缀逐字', () => {
    expect(PAY_ORDER_PREFIX).toBe('pay_');
    expect(REFUND_PREFIX).toBe('rf_');
    expect(WITHDRAW_PREFIX).toBe('wd_');
  });
});

describe('玩家面 DTO（规格 §2.4.1 表）：写死的键集逐字', () => {
  it('① 下单 请求 {packageYuan} / 响应 {orderNo,payUrl,expiresAt}', () => {
    const req: PayCreateOrderRequest = { packageYuan: 6 };
    const res: PayCreateOrderResponse = { orderNo: 'pay_x1', payUrl: 'https://example', expiresAt: 1_000 };
    expect(Object.keys(req).sort()).toEqual(['packageYuan']);
    expect(Object.keys(res).sort()).toEqual(['expiresAt', 'orderNo', 'payUrl']);
  });

  it('② 订单信息 = 规格写死的 9 键（#2/#3 同形；也是 #4 列表行类型）', () => {
    const info: PayOrderInfo = {
      orderNo: 'pay_x1',
      status: 'created',
      coins: 600,
      amountYuan: '6.00', // fen2yuan 字符串形态（⚙️5：禁浮点）
      packageYuan: 6,
      createdAt: 1,
      paidAt: null,
      creditedAt: null,
      closedAt: null,
    };
    expect(Object.keys(info).sort()).toEqual([
      'amountYuan',
      'closedAt',
      'coins',
      'createdAt',
      'creditedAt',
      'orderNo',
      'packageYuan',
      'paidAt',
      'status',
    ]);
  });

  it('⑤ 钱包摘要 {balance,withdrawable,dailyWithdrawRemainingCoins} 逐字', () => {
    const s: PayWalletSummary = { balance: 500, withdrawable: 300, dailyWithdrawRemainingCoins: 99_500 };
    expect(Object.keys(s).sort()).toEqual(['balance', 'dailyWithdrawRemainingCoins', 'withdrawable']);
  });

  it('⑥ 退款申请 请求 {orderNo,reason} / 响应 {refundNo,status}', () => {
    const req: PayRefundApplyRequest = { orderNo: 'pay_x1', reason: '不想玩了' };
    const res: PayRefundApplyResponse = { refundNo: 'rf_x1', status: 'holding' };
    expect(Object.keys(req).sort()).toEqual(['orderNo', 'reason']);
    expect(Object.keys(res).sort()).toEqual(['refundNo', 'status']);
  });

  it('⑧ 提现申请 请求 {coins} / 响应 {withdrawNo,status}', () => {
    const req: PayWithdrawApplyRequest = { coins: 1000 };
    const res: PayWithdrawApplyResponse = { withdrawNo: 'wd_x1', status: 'holding' };
    expect(Object.keys(req).sort()).toEqual(['coins']);
    expect(Object.keys(res).sort()).toEqual(['status', 'withdrawNo']);
  });

  it('状态联合类型覆盖状态机全值集（§3.1/§3.2/§3.3；编译期下界检查）', () => {
    const order: PayOrderStatus[] = ['created', 'paid', 'credited', 'closed'];
    const refund: PayRefundStatus[] = ['holding', 'pending', 'approved', 'rejecting', 'rejected', 'refunded', 'failed'];
    const withdraw: PayWithdrawStatus[] = [
      'holding',
      'pending',
      'approved',
      'paid',
      'rolling_back',
      'rejected',
      'timeout_rolled_back',
      'failed',
    ];
    expect([order.length, refund.length, withdraw.length]).toEqual([4, 7, 8]);
  });

  it('mine 列表行（规格未枚举键集——本仓形态：带注解字面量只做编译期检查）', () => {
    const r: PayRefundInfo = {
      refundNo: 'rf_x1',
      orderNo: 'pay_x1',
      coins: 600,
      amountYuan: '6.00',
      status: 'holding',
      reason: '不想玩了',
      reviewNote: null,
      reviewedAt: null,
      refundedAt: null,
      createdAt: 1,
    };
    const w: PayWithdrawInfo = {
      withdrawNo: 'wd_x1',
      coins: 1000,
      amountYuan: '10.00',
      status: 'holding',
      timeoutAt: 2,
      reviewNote: null,
      reviewedAt: null,
      confirmedAt: null,
      rolledBackAt: null,
      createdAt: 1,
    };
    expect([r.status, w.status]).toEqual(['holding', 'holding']);
  });
});

describe('管理面 DTO（规格 §2.4.2 表 + §5 CSV 列）', () => {
  it('审 / 确认 请求体逐字：{action: approve|reject, note?} 与 {voucher, note?}', () => {
    const review: AdminPayReviewRequest = { action: 'approve' };
    const reviewReject: AdminPayReviewRequest = { action: 'reject', note: '凭证不清' };
    const confirm: AdminPayConfirmRequest = { voucher: 'TT20261005', note: '已转' };
    expect(review.action).toBe('approve');
    expect(reviewReject.note).toBe('凭证不清');
    expect(confirm.voucher).toBe('TT20261005');
  });

  it('写面响应「返回实际态」：{refundNo,status} / {withdrawNo,status}（§2.4.2 #4/#6/#7）', () => {
    const rr: AdminPayRefundReviewResponse = { refundNo: 'rf_x1', status: 'approved' };
    const wr: AdminPayWithdrawReviewResponse = { withdrawNo: 'wd_x1', status: 'approved' };
    const wc: AdminPayWithdrawReviewResponse = { withdrawNo: 'wd_x1', status: 'paid' };
    expect([rr.status, wr.status, wc.status]).toEqual(['approved', 'approved', 'paid']);
  });

  it('审计行 = §5 CSV 列 actions（at,actor,kind,refNo,detail）', () => {
    const row: AdminPayActionRow = { at: 1, actor: 'fin.zhang', kind: 'applied', refNo: 'wd_x1', detail: '提现申请 1000 币' };
    expect(Object.keys(row).sort()).toEqual(['actor', 'at', 'detail', 'kind', 'refNo']);
  });
});
