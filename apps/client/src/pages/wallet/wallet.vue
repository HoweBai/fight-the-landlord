<script setup lang="ts">
/**
 * 钱包页（支付片 T14 / 规格 §4 全 + 设计 §11）：**第 6 页**。
 *
 * ## 结构（A1，2026-10-23 拆分）
 *
 *  - **顶部横条**：余额面板（`balance` + `withdrawable`，读数源 = ⑤ `GET /api/pay/wallet/summary`；
 *    失败**不伪造 0**，显「—」+ 静态失败行）+ 右侧双入口卡；
 *  - **入口卡**（`rechargeEnabled` / `withdrawEnabled` 各自门控）：充值/提现分别
 *    `navigateTo` 到 `pages/wallet/recharge` / `pages/wallet/withdraw`（子页承载档位、
 *    预检、再认证等整套 UI；本页不再渲染表单）；
 *  - **记录区（全宽）**：三 tab（订单/退款/提现）各自 `mine` 端点 keyset 加载
 *    （`scrolltolower` 翻页；`cursor` 不透明串原样回传）；14006/14007 行内提示。
 *
 * 摘要状态在 `game` store（`useWalletSummary`，与子页共享，序号化写入）；
 * 提现子页成功后置 `walletRecordsStale`，本页消费后重取提现 tab。
 *
 * ## 开关隐藏语义（§4）
 *
 * 两开关缺省 `false`（种子即暗上线）：对应**入口卡隐藏**，但**页面不空**——余额区与
 * 记录区不随开关隐藏（各有空态）。大厅入口因此恒在（「入口保留」；判据见 `lobby.vue`
 * 的 `openWallet` 注释）。
 *
 * ## 回跳 `?pay=<orderNo>`（§4 / §2.8）
 *
 * 应用启动/本页挂载时读（载体**保留到终态或用户关闭**）：命中 ⇒ **订单详情面板** + 轮询
 * （**3s × 10**，首查立即；`credited`/`closed` 为终态即停）；窗耗尽 ⇒ 面板显「**处理中**」
 * +「刷新」按钮 ⇒ ⑨ `sync`（主动查询补单）。到账时刷余额与订单列表。
 * 单号的跨页载体 = `store.walletReturnOrderNo`（大厅消费 URL 后写入——页面间不传 query，
 * `pageUrl` 固定映射的既有纪律）；本页**也**直接读 URL（覆盖「在钱包页刷新」这一形态）。
 * ⚠️ **不在挂载时清载体**：H5 上进入充值/提现子页会让本页卸载，挂载即清会让面板与轮询
 * 永久消失（重挂后凭载体重启）。
 *
 * ## 14006/14007（§2.8 两文案的落点裁定，T14）
 *
 * 提现超时的**两相**各配一条（`rollback_reason` 刻意不入 DTO——协议注释：
 * 「超时/驳回由 `status` 区分」）：
 *  - `rolling_back`（已 claim、回滚在途）⇒ 14006「申请已超时，金币已退回」；
 *  - `timeout_rolled_back`（回滚落账、终态）⇒ 14007「超时自动退回，金币已到账」。
 * ⚠️ 已知不精确面（登记）：驳回流程在途时也短暂经过 `rolling_back`（同一状态，
 * 行数据分不出原因）⇒ 那一瞬也显示 14006；回滚落账即转 `rejected`（正常态无提示）。
 * 让 `rolling_back` 一条提示都不显示会让 14006 **没有落点**——两害取其轻。
 *
 * ## 测试钩子
 *
 * `wallet-recharge-entry` / `wallet-withdraw-entry` · `order-row-{orderNo}`
 * （`wallet-entry` 在大厅；`pay-package-{yuan}` / `withdraw-input` / `withdraw-submit`
 * 随 UI 移到两个子页）。
 *
 * ## 两条环境纪律
 *
 *  - 遮罩类交互若日后加入：**不得用 `@click.self`**（uni-app H5 结构性不可用）——
 *    本页当前没有遮罩；
 *  - 样式只用 `src/uni.scss` 的 `$ftl-*` 令牌（只引用，不改定义）；**禁 SCSS `@use`**
 *    （含 `@mixin` 的 uni.scss 会被前置到每个 scss 块，用 `@import`/直接 `@include`）。
 */
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type {
  PayOrderInfo,
  PayOrderStatus,
  PayRefundStatus,
  PayWithdrawStatus,
} from '@fight-the-landlord/protocol';
import { useAuthStore } from '../../stores/auth';
import { useGameStore } from '../../stores/game';
import * as pay from '../../net/pay';
import { dispatchRestFailure } from '../../net/errors';
import { playerMessage } from '../../net/copy';
import { reportError } from '../../observability/reporter';
import { stopGameSession } from '../../composables/useGameSession';
import { usePageNotices } from '../../composables/usePageNotices';
import { useWalletSummary } from '../../composables/useWalletSummary';
import LandscapeStage from '../../components/LandscapeStage.vue';
import NoticeStack from '../../components/NoticeStack.vue';
/** 金币视图复用共用件（`part="coin"`）——不把货币的渲染写第二遍。 */
import PlayerChip from '../../components/PlayerChip.vue';

const auth = useAuthStore();
const store = useGameStore();

/**
 * 提示收敛（Task 7）：本页失败原因/出路不再占面板文档流，统一走 `NoticeStack` 浮层
 * （挂在 `LandscapeStage` 的 `overlay` 槽）。本页状态位 id：
 * `summary` · `list-{orders|refunds|withdrawals}` · `return`。
 * 充值/提现的 `recharge` / `withdraw` / `pay-hint` / `withdraw-result` 已随 UI 移到子页。
 * 模板里保留的 `.wallet__failure` / `.wallet__muted` 只是**静态状态位**——关掉浮层后
 * 玩家仍能区分「失败了」与「没有数据」。
 */
const notices = usePageNotices();
const { items: noticeItems } = notices;

/**
 * 错误提示的统一落点（设计 D2：REST/本地条件走页面 notices）：
 *  - 带重试 ⇒ sticky + `critical`（不被容量淘汰，直到重试成功由调用方 dismiss）；
 *  - 无重试 ⇒ 8s 自消；两者都可手动关闭。
 */
function setError(id: string, text: string, retry?: () => void): void {
  notices.setNotice(id, text, {
    level: 'error',
    durationMs: retry ? 0 : 8000,
    priority: retry ? 'critical' : 'normal',
    dismissible: true,
    actions: retry ? [{ label: '重试', onClick: retry }] : undefined,
  });
}

/* ------------------------------------------------------------------ *
 * 余额区（⑤ summary）—— 2026-10-23 拆分：摘要/错误在 game store，
 * 与充值/提现子页共享；本页只注入自己的错误面。
 * ------------------------------------------------------------------ */

const { summary, summaryError, loadSummary } = useWalletSummary({
  setError: (text, retry) => setError('summary', text, retry),
  dismiss: () => notices.dismiss('summary'),
});

/**
 * 失败态单一真源在 store：任一页取数成功都会清空 `walletSummaryError` ⇒
 * 本页的静态失败行与 sticky `summary` 项一起退场；反过来，后台页（提现子页）
 * 失败时本页也要给出「重试」出口（同 id 幂等）。
 */
watch(summaryError, (text) => {
  if (text === '') {
    notices.dismiss('summary');
    return;
  }
  setError('summary', text, () => void loadSummary());
});

/* ------------------------------------------------------------------ *
 * 状态中文映射（§4：订单三态逐字 + 14006/14007 行内提示）
 * ------------------------------------------------------------------ */

/** 订单状态（§4 逐字：`created→待支付`、`paid→处理中`、`credited→已到账`；`closed` 补「已关闭」）。 */
const ORDER_STATUS_LABEL: Record<PayOrderStatus, string> = {
  created: '待支付',
  paid: '处理中',
  credited: '已到账',
  closed: '已关闭',
};

/** 退款状态（状态机 $3.3 全值集；`refunded` 为终态「已退款」）。 */
const REFUND_STATUS_LABEL: Record<PayRefundStatus, string> = {
  holding: '提交中',
  pending: '审核中',
  approved: '退款中',
  rejecting: '驳回中',
  rejected: '已驳回',
  refunded: '已退款',
  failed: '已失败',
};

/** 提现状态（状态机 §3.2 全值集；§4 状态条五词 = pending/approved/paid/rejected/timeout_rolled_back）。 */
const WITHDRAW_STATUS_LABEL: Record<PayWithdrawStatus, string> = {
  holding: '提交中',
  pending: '审核中',
  approved: '已通过',
  paid: '已打款',
  rolling_back: '退回中',
  rejected: '已驳回',
  timeout_rolled_back: '已超时退回',
  failed: '已失败',
};

/**
 * 提现记录**行内提示**（§2.8 逐字；14006/14007 是「状态提示，非错误码路径」——
 * 它们不是 `ErrCode`，走状态映射不走 `CLIENT_ACTION`）。落点裁定见文件头注释。
 */
function withdrawNote(status: PayWithdrawStatus): string | null {
  if (status === 'rolling_back') return '申请已超时，金币已退回'; // 14006
  if (status === 'timeout_rolled_back') return '超时自动退回，金币已到账'; // 14007
  return null;
}

/** `createdAt`（epoch ms）→ 本地时间短格式。纯展示（`history.vue` 同款）。 */
function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 * 记录区（三 tab；各自 keyset 加载）
 * ------------------------------------------------------------------ */

type RecordTab = 'orders' | 'refunds' | 'withdrawals';
const TAB_ORDER: RecordTab[] = ['orders', 'refunds', 'withdrawals'];
const TAB_LABEL: Record<RecordTab, string> = { orders: '订单', refunds: '退款', withdrawals: '提现' };

interface ListState<T> {
  items: T[];
  /** 不透明游标（`null` = 终页）——原样回传，不解析。 */
  nextCursor: string | null;
  /** 是否已成功加载过（tab 切换的懒加载判据；失败不算）。 */
  loaded: boolean;
  loading: boolean;
  error: string;
}

const lists = reactive({
  orders: { items: [], nextCursor: null, loaded: false, loading: false, error: '' } as ListState<PayOrderInfo>,
  refunds: {
    items: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    error: '',
  } as ListState<{ refundNo: string; orderNo: string; coins: number; amountYuan: string; status: PayRefundStatus; reason: string; createdAt: number }>,
  withdrawals: {
    items: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    error: '',
  } as ListState<{ withdrawNo: string; coins: number; amountYuan: string; status: PayWithdrawStatus; createdAt: number }>,
});

const activeTab = ref<RecordTab>('orders');

/**
 * 拉一页。`cursor === undefined` = 第一页（**整表替换**）；否则**追加**。
 *
 * 失败处置照既有惯例（`dispatchRestFailure` 查 `CLIENT_ACTION` 表）：`TOAST` ⇒ 浮层
 * `list-${tab}` 项（sticky + 「重试」）+ 静态失败控制位 `state.error`；
 * `BACK_TO_LOBBY` ⇒ 清本地会话回登录页；重放类码在 REST 语境退化为「重放一次」。
 * Task 7 起原因文案走 `playerMessage`（10007 固定文案），成功时 `dismiss('list-'+tab)`
 * ——否则 sticky 项在数据已经回来后仍然挡在浮层里。
 * ⚠️ `loading` 守卫在**调用方**（`loadMore`/`selectTab`/`reloadTab`）——不在这里：
 * 重放分支（`replay` ⇒ 再调本函数）发生在 `loading` 仍为 `true` 的时刻，入口守卫会把
 * 重放**静默吃掉**（`history.vue#load` 同款结构：守卫按调用点放）。
 * ⚠️ 三个分支各自直写自己的列表（**不用泛型指针**）：`lists[tab]` 的三态联合会让
 * 「写 items」失去类型收敛，而逐个分支写是显式且不会静默错位的。
 */
async function loadTab(tab: RecordTab, cursor?: string, replayed = false): Promise<void> {
  const state = lists[tab];
  state.loading = true;
  state.error = '';
  try {
    let failure: { code: number; message?: string } | null = null;
    if (tab === 'orders') {
      const res = await pay.fetchMyPayOrders(cursor);
      if (res.code === 0) {
        const page = res.data ?? { items: [], nextCursor: null };
        lists.orders.items = cursor === undefined ? page.items : [...lists.orders.items, ...page.items];
        lists.orders.nextCursor = page.nextCursor;
      } else {
        failure = res;
      }
    } else if (tab === 'refunds') {
      const res = await pay.fetchMyPayRefunds(cursor);
      if (res.code === 0) {
        const page = res.data ?? { items: [], nextCursor: null };
        lists.refunds.items = cursor === undefined ? page.items : [...lists.refunds.items, ...page.items];
        lists.refunds.nextCursor = page.nextCursor;
      } else {
        failure = res;
      }
    } else {
      const res = await pay.fetchMyPayWithdrawals(cursor);
      if (res.code === 0) {
        const page = res.data ?? { items: [], nextCursor: null };
        lists.withdrawals.items =
          cursor === undefined ? page.items : [...lists.withdrawals.items, ...page.items];
        lists.withdrawals.nextCursor = page.nextCursor;
      } else {
        failure = res;
      }
    }
    if (failure === null) {
      state.loaded = true;
      notices.dismiss(`list-${tab}`);
      return;
    }
    await dispatchRestFailure(failure, {
      toast: (report) => {
        const text = playerMessage(report.code, {
          context: 'rest',
          serverMessage: report.message,
        });
        state.error = text;
        setError(`list-${tab}`, text, () => reloadTab(tab));
      },
      signOutLocally: (report) => {
        stopGameSession();
        auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
      },
      replay: () => (replayed ? Promise.resolve() : loadTab(tab, cursor, true)),
    });
  } catch (e) {
    state.error = '记录加载失败，请稍后重试';
    setError(`list-${tab}`, state.error, () => reloadTab(tab));
    reportError('wallet.loadTab', e, { tab });
  } finally {
    state.loading = false;
    // 在途期间收到的失效标记：这一发可能早于提现提交 ⇒ 放行后补一次重取。
    if (tab === 'withdrawals') refreshWithdrawals();
  }
}

/** 切 tab：首次激活才发请求（懒加载；已加载过的不重发——重发点只有显式 `reloadTab`）。 */
function selectTab(tab: RecordTab) {
  activeTab.value = tab;
  const state = lists[tab];
  if (!state.loaded && !state.loading) void loadTab(tab);
}

/** 重新拉第一页（**整表替换**）——到账/提现成功/回跳落账后的刷新点。 */
function reloadTab(tab: RecordTab) {
  const state = lists[tab];
  if (state.loading) return;
  void loadTab(tab);
}

/* ------------------------------------------------------------------ *
 * 提现记录失效标记（2026-10-23 拆分：提现子页成功后置位）
 * ------------------------------------------------------------------ */

/** 本地待办：标记到达时提现列表在途 ⇒ 保留到该 tab 的 `finally` 再消费（不丢刷新）。 */
let withdrawalsStale = false;

/** 调度一次提现列表重取；在途时不丢，由 `loadTab('withdrawals')` 的 finally 补消费。 */
function refreshWithdrawals(): void {
  if (!withdrawalsStale) return;
  if (lists.withdrawals.loading) return;
  withdrawalsStale = false;
  reloadTab('withdrawals');
}

/** 消费共享标记：无论 activeTab 是哪个，提现列表都必须重取（`selectTab` 只懒加载一次）。 */
function consumeWalletRecordsStale(): void {
  if (!store.walletRecordsStale) return;
  store.walletRecordsStale = false;
  withdrawalsStale = true;
  refreshWithdrawals();
}

watch(
  () => store.walletRecordsStale,
  (stale) => {
    if (stale) consumeWalletRecordsStale();
  },
);

/** 到达列表底部（`scroll-view` 的 `@scrolltolower`）：在途 / 终页都不再发。 */
function loadMore() {
  const state = lists[activeTab.value];
  if (state.loading || state.nextCursor === null) return;
  void loadTab(activeTab.value, state.nextCursor);
}

/* ------------------------------------------------------------------ *
 * 充值入口（2026-10-23 拆分：档位/下单/收银台整套 UI 已移到子页）
 * ------------------------------------------------------------------ */

/** 压栈到充值子页（子页返回走 navigateBack）。 */
function openRecharge() {
  uni.navigateTo({ url: '/pages/wallet/recharge' });
}

/* ------------------------------------------------------------------ *
 * 提现入口（2026-10-23 拆分：表单/预检/再认证整套 UI 已移到子页）
 * ------------------------------------------------------------------ */

/** 压栈到提现子页（子页返回走 navigateBack）。 */
function openWithdraw() {
  uni.navigateTo({ url: '/pages/wallet/withdraw' });
}

/* ------------------------------------------------------------------ *
 * 回跳 `?pay=`（订单详情面板 + 轮询 3s × 10 + 手动刷新 ⇒ sync）
 * ------------------------------------------------------------------ */

/** 轮询节奏（§4 逐字：3s × 10）。 */
const RETURN_POLL_INTERVAL_MS = 3000;
const RETURN_POLL_MAX = 10;

const returnOrderNo = ref<string | null>(null);
const returnOrder = ref<PayOrderInfo | null>(null);
/** 轮询在跑（面板据此显示「自动查询中…」并隐藏「刷新」——自动查着时手动按没意义）。 */
const returnPolling = ref(false);
/** 窗耗尽（≥10 发未终态）⇒ 面板显「处理中」+「刷新」。 */
const returnExhausted = ref(false);
const returnRefreshing = ref(false);
const returnPolls = ref(0);
let returnTimer: ReturnType<typeof setInterval> | null = null;
/** 上一发轮询未回（慢网）⇒ 本次 tick 跳过（不并发叠发）。非渲染态 ⇒ 普通变量。 */
let returnInFlight = false;

/** 终态：`credited`（到账）/ `closed`（关闭）；`paid` 是「钱已收、入账中」⇒ 继续轮询。 */
function isTerminalOrderStatus(status: PayOrderStatus): boolean {
  return status === 'credited' || status === 'closed';
}

function stopReturnPolling() {
  if (returnTimer !== null) {
    clearInterval(returnTimer);
    returnTimer = null;
  }
  returnPolling.value = false;
}

/**
 * 应用一个订单读数：终态 ⇒ 停表 + 刷新相关面（到账刷新余额与订单列表；关闭只刷列表）。
 * 非终态什么都不做（由轮询循环决定继续/耗尽）。成功读数同时收掉浮层 `return` 项。
 */
function applyReturnOrder(info: PayOrderInfo) {
  returnOrder.value = info;
  notices.dismiss('return');
  if (info.status === 'credited') {
    stopReturnPolling();
    returnExhausted.value = false;
    store.setWalletReturnOrderNo(null); // 终态：载体退役（重挂不再重启轮询）
    void loadSummary();
    reloadTab('orders');
  } else if (info.status === 'closed') {
    stopReturnPolling();
    returnExhausted.value = false;
    store.setWalletReturnOrderNo(null);
    reloadTab('orders');
  }
}

/**
 * 一次轮询（② `GET /api/pay/orders/:orderNo`）。
 *
 * 计满 `RETURN_POLL_MAX` 仍未终态 ⇒ 停表 + `returnExhausted`（「处理中」+「刷新」）。
 * 查询失败**不翻错误面**打断轮询（网络抖动是暂时的）：只给一条 8s 浮层提示
 * （`return` 项，不 sticky、无重试动作），照常走下一次；动作类处置（登录失效等）
 * 仍经 `dispatchRestFailure`（`signOutLocally`）。
 * 慢网（上一发未回）：本次 tick 跳过（不并发叠发；`returnInFlight` 在请求返回时先清，
 * 重放分支才进得来——「先放行再处置」与 `onBuyPackage` 同一条纪律）。
 */
async function pollReturnOrder(replayed = false) {
  const orderNo = returnOrderNo.value;
  if (orderNo === null) {
    stopReturnPolling();
    return;
  }
  if (returnInFlight) return;
  if (returnPolls.value >= RETURN_POLL_MAX) {
    stopReturnPolling();
    returnExhausted.value = true;
    return;
  }
  returnPolls.value += 1;
  returnInFlight = true;
  let res;
  try {
    res = await pay.fetchPayOrder(orderNo);
  } catch (e) {
    setError('return', '订单查询失败，请稍后重试');
    reportError('wallet.pollReturnOrder', e);
    return; // finally 清 in-flight；本发失败不计终态，等下一个 tick
  } finally {
    returnInFlight = false;
  }
  if (res.code === 0) {
    const data = res.data;
    if (data) applyReturnOrder(data);
    else setError('return', '订单查询失败，请稍后重试');
  } else {
    await dispatchRestFailure(res, {
      toast: (report) => {
        setError(
          'return',
          playerMessage(report.code, { context: 'rest', serverMessage: report.message }),
        );
      },
      signOutLocally: (report) => {
        stopReturnPolling();
        stopGameSession();
        auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
      },
      replay: () => (replayed ? Promise.resolve() : pollReturnOrder(true)),
    });
  }
  // 窗耗尽且未终态 ⇒ 停表进入「处理中」面（不等第 11 次 tick）。
  if (
    returnPolling.value &&
    returnPolls.value >= RETURN_POLL_MAX &&
    (returnOrder.value === null || !isTerminalOrderStatus(returnOrder.value.status))
  ) {
    stopReturnPolling();
    returnExhausted.value = true;
  }
}

/**
 * 手动刷新（面板的「刷新」按钮）：③ `sync`（主动查询补单）。
 *
 * 结果：终态 ⇒ 照 `applyReturnOrder` 收口；仍非终态 ⇒ 保持「处理中」手动面
 * （**不**自动重启轮询窗——手动点一次查一次，直到用户满意或状态变化）。
 */
async function refreshReturnOrder(replayed = false) {
  const orderNo = returnOrderNo.value;
  if (orderNo === null || returnRefreshing.value) return;
  returnRefreshing.value = true;
  notices.dismiss('return');
  let res;
  try {
    res = await pay.syncPayOrder(orderNo);
  } catch (e) {
    setError('return', '订单查询失败，请稍后重试');
    reportError('wallet.refreshReturnOrder', e);
    return;
  } finally {
    // ⚠️ 先放行再处置（理由同 `pollReturnOrder`）。
    returnRefreshing.value = false;
  }
  if (res.code === 0) {
    const data = res.data;
    if (data) {
      applyReturnOrder(data);
      if (!isTerminalOrderStatus(data.status)) returnExhausted.value = true;
    } else {
      setError('return', '订单查询失败，请稍后重试');
    }
    return;
  }
  await dispatchRestFailure(res, {
    toast: (report) => {
      setError(
        'return',
        playerMessage(report.code, { context: 'rest', serverMessage: report.message }),
      );
    },
    signOutLocally: (report) => {
      stopGameSession();
      auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
    },
    replay: () => (replayed ? Promise.resolve() : refreshReturnOrder(true)),
  });
}

/** 收面板（停表 + 清载具状态 + 载体退役）。 */
function dismissReturn() {
  stopReturnPolling();
  returnOrderNo.value = null;
  returnOrder.value = null;
  store.setWalletReturnOrderNo(null);
  notices.dismiss('return');
  returnExhausted.value = false;
}

/** 进入回跳流程：切「订单」tab + 刷列表（详情行就在第一页——最新一单）+ 开轮询窗。 */
function startReturnFlow(orderNo: string) {
  stopReturnPolling();
  returnOrderNo.value = orderNo;
  returnOrder.value = null;
  notices.dismiss('return');
  returnExhausted.value = false;
  returnPolls.value = 0;
  selectTab('orders');
  reloadTab('orders');
  void pollReturnOrder(); // 首查立即（「3s × 10」= 首查 + 9 次定时）
  returnTimer = setInterval(async () => {
    await pollReturnOrder();
  }, RETURN_POLL_INTERVAL_MS);
  returnPolling.value = true;
}

/* ------------------------------------------------------------------ *
 * 挂载 / 卸载
 * ------------------------------------------------------------------ */

onMounted(() => {
  void loadSummary();
  void loadTab('orders'); // 默认 tab 立即加载；其余 tab 懒加载（selectTab）
  // H5 重挂形态：失效标记在挂载时也要消费（App 不重挂由 watch 覆盖）。
  consumeWalletRecordsStale();
  /**
   * 回跳（§4）：先读**跨页载体**（大厅消费 URL 后写入——覆盖「冷启动 → 大厅 → 钱包页」
   * 主路径），再读 URL 本身（覆盖「已在钱包页刷新」）。载体**保留到终态/用户关闭**：
   * H5 上进入充值/提现子页会让钱包页卸载，挂载即清会让面板与轮询永久消失。
   */
  let pending = store.walletReturnOrderNo;
  if (pending === null) pending = pay.consumePayReturnOrderNo();
  if (pending !== null) {
    store.setWalletReturnOrderNo(pending);
    startReturnFlow(pending);
  }
});

onUnmounted(() => {
  stopReturnPolling();
});

/** 返回大厅（弹栈）。全局 `navigationStyle: custom` ⇒ 没有原生返回键，必须有这一颗。 */
/** 返回大厅（弹栈）。回大厅 = 结束回跳流程 ⇒ 载体退役（再进钱包页不再重弹旧面板）。 */
function onBack() {
  store.setWalletReturnOrderNo(null);
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <LandscapeStage>
    <!--
      ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
      `classes()` 静默返回 `[]`（单根闸盯着全部页面）。
    -->
    <view class="wallet">
      <view class="wallet__bar">
        <!-- 返回：次按钮语言（§5.2.1）。全局 navigationStyle: custom ⇒ 没有原生返回键。 -->
        <button type="button" class="btn btn--small wallet__back" @click="onBack">返回</button>
        <text class="wallet__title">钱包</text>
      </view>

      <view class="wallet__body">
        <!-- A1（2026-10-23 拆分）：顶部横条 = 余额 + 双入口；记录区全宽占满剩余高度。 -->
        <view class="wallet__top">
          <!-- 余额区（§4）：balance（共用件金币视图）+ withdrawable；未知显「—」，不伪造 0。 -->
          <view class="wallet__panel wallet__balance">
            <text class="wallet__section-title">钱包余额</text>
            <view class="wallet__balance-row">
              <PlayerChip
                class="wallet__balance-chip"
                part="coin"
                :balance="summary === null ? null : summary.balance"
              />
              <text class="wallet__withdrawable">
                可提额度 {{ summary === null ? '—' : summary.withdrawable }}
              </text>
            </view>
            <!-- 静态失败态（Task 7）：原因与「重试」出口在浮层 `summary` 项；这里只留状态位。 -->
            <text v-if="summaryError" class="wallet__failure">钱包信息暂不可用</text>
          </view>

          <!-- 双入口（2026-10-23 拆分）：充值/提现各自压栈到子页。 -->
          <view v-if="store.rechargeEnabled || store.withdrawEnabled" class="wallet__entries">
            <button
              v-if="store.rechargeEnabled"
              type="button"
              class="wallet__entry wallet__entry--recharge wallet-recharge-entry"
              @click="openRecharge"
            >
              <text class="wallet__entry-title">充值</text>
              <text class="wallet__entry-note">补充金币</text>
            </button>
            <button
              v-if="store.withdrawEnabled"
              type="button"
              class="wallet__entry wallet-withdraw-entry"
              @click="openWithdraw"
            >
              <text class="wallet__entry-title">提现</text>
              <text class="wallet__entry-note">提取金币</text>
            </button>
          </view>
        </view>

        <!-- 回跳面板（§4）：只在读到 ?pay= 时出现；订单详情 + 轮询状态 + 刷新。 -->
        <view v-if="returnOrderNo !== null" class="wallet__panel wallet__return">
          <view class="wallet__return-head">
            <text class="wallet__section-title">充值订单</text>
            <button
              type="button"
              class="btn btn--small wallet__return-dismiss"
              @click="dismissReturn"
            >
              关闭
            </button>
          </view>
          <text class="wallet__return-no">{{ returnOrderNo }}</text>
          <text v-if="returnOrder" class="wallet__return-status">
            {{ ORDER_STATUS_LABEL[returnOrder.status] }} · {{ returnOrder.coins }} 金币 ·
            {{ returnOrder.amountYuan }} 元
          </text>
          <text v-else class="wallet__return-status">查询中…</text>
          <view class="wallet__return-actions">
            <text v-if="returnPolling" class="wallet__return-hint">自动查询中…</text>
            <text v-else-if="returnExhausted" class="wallet__return-hint">处理中</text>
            <button
              v-if="!returnPolling"
              type="button"
              class="btn btn--small wallet__return-refresh"
              :disabled="returnRefreshing"
              @click="refreshReturnOrder()"
            >
              刷新
            </button>
          </view>
        </view>

        <!-- 记录区（§4，全宽）：三 tab（订单/退款/提现），keyset 翻页。 -->
        <view class="wallet__panel wallet__records">
          <view class="wallet__tabs">
            <button
              v-for="tab in TAB_ORDER"
              :key="tab"
              type="button"
              class="wallet__tab"
              :class="{ 'wallet__tab--active': activeTab === tab }"
              @click="selectTab(tab)"
            >
              {{ TAB_LABEL[tab] }}
            </button>
          </view>
          <!-- 静态失败态（Task 7）：原因与「重试」出口在浮层 `list-{tab}` 项；这里只留状态位。 -->
          <text v-if="lists[activeTab].error" class="wallet__failure">记录加载失败</text>
          <scroll-view
            v-if="lists[activeTab].items.length > 0"
            class="wallet__list"
            scroll-y
            @scrolltolower="loadMore"
          >
            <template v-if="activeTab === 'orders'">
              <view
                v-for="o in lists.orders.items"
                :key="o.orderNo"
                class="wallet__row"
                :class="`order-row-${o.orderNo}`"
              >
                <text class="wallet__row-status">{{ ORDER_STATUS_LABEL[o.status] }}</text>
                <text class="wallet__row-amount">{{ o.coins }} 金币 · {{ o.amountYuan }} 元</text>
                <text class="wallet__row-time">{{ formatTime(o.createdAt) }}</text>
                <text class="wallet__row-no">{{ o.orderNo }}</text>
              </view>
            </template>
            <template v-else-if="activeTab === 'refunds'">
              <view v-for="r in lists.refunds.items" :key="r.refundNo" class="wallet__row">
                <text class="wallet__row-status">{{ REFUND_STATUS_LABEL[r.status] }}</text>
                <text class="wallet__row-amount">{{ r.coins }} 金币 · {{ r.amountYuan }} 元</text>
                <text class="wallet__row-time">{{ formatTime(r.createdAt) }}</text>
                <text class="wallet__row-no">{{ r.refundNo }}</text>
              </view>
            </template>
            <template v-else>
              <view v-for="w in lists.withdrawals.items" :key="w.withdrawNo" class="wallet__row">
                <text class="wallet__row-status">{{ WITHDRAW_STATUS_LABEL[w.status] }}</text>
                <!-- 14006/14007 行内提示（§2.8；落点裁定见文件头注释）。 -->
                <text v-if="withdrawNote(w.status)" class="wallet__row-note">
                  {{ withdrawNote(w.status) }}
                </text>
                <text class="wallet__row-amount">{{ w.coins }} 金币 · {{ w.amountYuan }} 元</text>
                <text class="wallet__row-time">{{ formatTime(w.createdAt) }}</text>
                <text class="wallet__row-no">{{ w.withdrawNo }}</text>
              </view>
            </template>
          </scroll-view>
          <text v-else-if="lists[activeTab].loading" class="wallet__muted">加载中…</text>
          <text v-else-if="!lists[activeTab].error" class="wallet__muted">暂无记录</text>
        </view>
      </view>
    </view>

    <!-- 提示浮层（Task 7）：失败原因 / 降级引导 / 提现成功态都在这里，不占面板文档流。 -->
    <template #overlay>
      <NoticeStack :items="noticeItems" surface="wallet" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/**
 * 视觉语言照抄总规格 §5.2.1（半透明深蓝面板 / 次按钮语言 / 金色主按钮），
 * 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（只引用，不改定义）。
 * 形态与 `lobby.vue`（两栏 flex）/ `history.vue`（列表面板）同族。
 */
.wallet {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
.wallet__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-6;
  min-height: $ftl-bar-h;
}
/**
 * 返回：次按钮语言。⚠️ 选择器**必须**带 `.wallet` 前缀（`.btn { @include ftl-btn }` 在本文件
 * **末尾**，同特指度下后者胜——`history.vue` 记着同款产物实测）。
 */
.wallet .wallet__back {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.wallet__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** A1（2026-10-23 拆分）：纵向 flex —— 顶部横条、回跳面板、全宽记录区。 */
.wallet__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: $ftl-space-4;
  min-height: 0;
}
/** 顶部横条：余额面板占满左侧，双入口卡靠右（用上原本空着的右侧空间）。 */
.wallet__top {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  gap: $ftl-space-5;
}
.wallet__top .wallet__balance {
  flex: 1 1 auto;
}
.wallet__entries {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  gap: $ftl-space-4;
  margin-left: auto;
}
/** 面板（§5.2.1 的半透明深蓝面板）——顶部横条/回跳面板/记录区共用。 */
.wallet__panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  padding: $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.85);
}
.wallet__section-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1.2;
}
.wallet__balance-row {
  display: flex;
  align-items: center;
  gap: $ftl-space-6;
}
.wallet__withdrawable {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-md;
  line-height: 1.2;
}
/**
 * 静态失败态（Task 7：`.wallet__error` 内联错误行退役，原因在 `NoticeStack` 浮层）。
 * 与错误行同色 —— 它仍表示「这块坏了」，只是不再携带具体原因。
 */
.wallet__failure {
  color: $ftl-color-danger-on-dark;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 「加载中…/暂无记录」是中性信息（不是错误）⇒ 面板内标签字，与错误行分开。 */
.wallet__muted {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/**
 * 入口卡（2026-10-23 拆分）：底分卡语言（竖排两行 + 描边卡），整卡可点。
 * 充值 = 金描边/金字（主操作），提现 = 中性描边（低频敏感操作）—— 两张卡不铺实心金底，
 * 避免再次形成「金色按钮墙」。
 * ⚠️ 逐项重置 `uni-button` 宿主默认样式（`margin-left/right:auto`、`color:#000`、
 * `font` 不继承——底分卡注释里的同款坑）。
 */
.wallet__entry {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: $ftl-space-2;
  min-width: 240px;
  min-height: $ftl-control-h;
  margin: 0;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.85);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  &:hover {
    background: rgba($ftl-color-on-primary, 0.08);
  }
}
.wallet__entry--recharge {
  border-color: $ftl-color-gold-deep;
  color: $ftl-color-gold-light;
}
.wallet__entry-title {
  color: inherit;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
.wallet__entry-note {
  color: rgba($ftl-color-on-primary, 0.7);
  font-size: $ftl-font-sm;
  line-height: 1.2;
}
/** 回跳面板：金描边强调（刚回到页面时最需要看见的那块）。 */
.wallet__return {
  border-color: $ftl-color-gold-deep;
}
.wallet__return-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
}
.wallet__return-no,
.wallet__return-status {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
  word-break: break-all;
}
.wallet__return-actions {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
}
.wallet__return-hint {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.wallet .wallet__return-dismiss,
.wallet .wallet__return-refresh {
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
/** 记录区面板：撑满剩余高度（全宽）。 */
.wallet__records {
  flex: 1 1 auto;
  min-height: 0;
}
/** 三 tab：分段控件语言（§5.2.1；与大厅场次切换同族）。 */
.wallet__tabs {
  display: flex;
  flex: 0 0 auto;
  gap: $ftl-space-3;
}
.wallet__tab {
  box-sizing: border-box;
  margin: 0;
  padding: $ftl-space-3 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-pill;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.9);
  font: inherit;
  cursor: pointer;
}
.wallet__tab--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.18);
  color: $ftl-color-gold-light;
  font-weight: 700;
}
/** 列表：`scroll-view` 是**自己的**滚动容器（舞台整页不滚动——`history.vue` 同款）。 */
.wallet__list {
  flex: 1 1 0;
  min-height: 0;
}
/** 一行记录：状态 + 金额 + 时间 + 单号（四段一行，窄屏折行）。 */
.wallet__row {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: $ftl-space-2 $ftl-space-5;
  margin-bottom: $ftl-space-3;
  padding: $ftl-space-4 $ftl-space-5;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.35);
}
.wallet__row-status {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-md;
  font-weight: 600;
  line-height: 1.2;
}
.wallet__row-note {
  color: $ftl-color-danger-on-dark;
  font-size: $ftl-font-xs;
  line-height: 1.4;
}
.wallet__row-amount {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.2;
}
.wallet__row-time {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-xs;
  line-height: 1.2;
}
.wallet__row-no {
  margin-left: auto;
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-xs;
  line-height: 1.2;
  word-break: break-all;
}
/** 本页原生 `<button class="btn …">` 的观感自持（与 `lobby.vue` / `history.vue` 同款两条）。 */
.btn {
  @include ftl-btn;
}
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
}
</style>
