<script setup lang="ts">
/**
 * 开始游戏页（片② 客户端 · 片规格 §4）：**选完底分进来的那一屏**。
 *
 * 形态：左上「返回大厅」· 左下玩家信息条 · 中央「场次名 + 底分 N」+「**开始游戏**」大按钮
 * （= 随机匹配，带上**选中的**底分，协议②）· 「**好友房**」二级入口（片⑦：按服务端配置门控）。
 *
 * 匹配完全在服务端（F05）——这里只发 `room.match`，然后等 `room.matched` 推送。
 *
 * 🔴 **「好友房」是弹层、不是子页**（片规格 §4 裁决二）：页面栈的唯一真源是 `auth.page`，
 * 加一页要动 `pages.json` + `auth.page` 联合类型 + `page-stack` 判据 —— 而它本来就只是次要入口。
 *
 * ⚠️ **本页不再自己取档位表**（片② 客户端起）：客户端配置（`GET /api/config`：档位表 +
 * 好友房开关）由**大厅**取一次写进 store，本页复用它查**场次名**（片规格 §3 的第二个接口）。
 * `baseScore` 也不再取「第一档」——用的是**用户选中的那一档**（`store.selectedBaseScore`）。
 *
 * ⚠️ **锚点纪律**：`.game` 是页面根 class（`table-hud` 的单根闸 + `landscape-canvas` 的
 * 「每个页面都套 `<LandscapeStage>`」都按它判）· `.game__match .btn` 是探针锚点 ·
 * `.table__bar .btn` 那条同族。**「返回大厅」的文案逐字保留**（探针按文本匹配）。
 *
 * ⚠️ **跨页状态**：玩法 id、选中底分、**选中场次**（`store.roomMode`）都从 `game` store 读
 * —— **不得**在本页写死「斗地主」、任何底分字面量、或 `mode: 'random'`（R752 / M09 / ② §14）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ClientAction,
  ErrCode,
  type RoomInfo,
} from "@fight-the-landlord/protocol";
import {
  currentSession,
  getGameSession,
  stopGameSession,
} from "../../composables/useGameSession";
import type { RoomPlayerLike } from "../../net/session";
import * as rest from "../../net/rest";
import { classifyAck, dispatchRestFailure } from "../../net/errors";
/** 玩家提示收敛与浮层化 Task 9：REST/本地条件的玩家文案统一走查表（不带码、不带异常串）。 */
import { playerMessage } from "../../net/copy";
/** 死态 fail-fast 的拦下原因：页面据此**不写**本地错误（呈现交给 Stack 的内置死态项）。 */
import { ConnectionDeadError } from "../../net/socket";
/** 原始异常只进上报链（排查靠上报，不靠把 e.message 拼进玩家文案）。 */
import { reportError } from "../../observability/reporter";
/** 风控 T8：设备指纹（跨登出/换号持久，随 `room.match` 上行）。 */
import {
  getDeviceId,
  clearPendingCardCounterPurchase,
  loadPendingCardCounterPurchase,
  savePendingCardCounterPurchase,
  PENDING_CARD_COUNTER_TTL_MS,
  type PendingCardCounterPurchase,
} from "../../net/storage";
import { refreshClientConfig } from "../../composables/useClientConfig";
import { useAuthStore } from "../../stores/auth";
import { useGameStore } from "../../stores/game";
import { usePageAlignment } from "../../composables/usePageAlignment";
import { DEFAULT_MODE_ID, findMode } from "../../gameModes";
import { loadAudioPrefs, playBgm, stopBgm } from "../../audio";
import { CUES } from "../../audio/cues";
/** 片①：横屏画布（R710）。 */
import LandscapeStage from "../../components/LandscapeStage.vue";
/**
 * 统一提示浮层（提示收敛 Task 9 + Task 11）：本地项 + session notice + 连接死态
 * 全部在这里渲染（挂在 `LandscapeStage` 的 `overlay` 槽）。ConnectionDeadBar 在玩法页
 * 已退役——连接死态和大厅页一样走 NoticeStack 内置 connection-dead 项。
 */
import NoticeStack from "../../components/NoticeStack.vue";
import { usePageNotices } from "../../composables/usePageNotices";
/** 玩家信息条共用件（本片新增）：与大厅顶栏是同一件事。 */
import PlayerChip from "../../components/PlayerChip.vue";

const auth = useAuthStore();
/** 页面栈（Task 3）：挂载时对齐一次（`auth.page` 才是唯一真源）。 */
usePageAlignment("game");
const store = useGameStore();

/**
 * 提示收敛（Task 9）：本页提示不再占文档流，统一走 `NoticeStack` 浮层
 * （挂在 `LandscapeStage` 的 `overlay` 槽）。每个失败/状态面一个状态位 id：
 *  - `game-error`：本地条件（未选底分 / 串行队列忙 / 传输拒绝 / REST 进房与建房失败）；
 *  - `rooms`：房间列表加载失败（sticky + critical + 「刷新」）；
 *  - `cc-error`：记牌器购买错误（与入口圆点 `ccAttention` 同源）。
 *
 * 等待提示 `match.wait_prompt` 保留 origin/dev 的底部悬浮卡片（`.game__waitprompt`），
 * 不进 Stack；其余事件提示（含连接死态）统一走 Stack。
 *
 * ⚠️ **来源分流**（不得 1:1 替换旧 `error`）：WS ack 非 0（match / unmatch / join /
 * room.*）只由 session notice 呈现，本页**不写任何本地文案**（否则同句双呈现）；
 * 只有本地条件与 REST 失败才进本地项。连接死态与 session 提示由 Stack 内置承担。
 */
const notices = usePageNotices();
const { items: noticeItems } = notices;
/** 页面级错误是否在场：等待卡片据此让位（原 `error` 控制位的替代）。 */
const hasGameError = computed(() => notices.items.value.some((item) => item.id === "game-error"));

function showGameError(id: string, text: string): void {
  notices.setNotice(id, text, { level: "error" });
}

/**
 * REST 占座/建房的**房间业务码**（Task 9）：这些码在 `CLIENT_ACTION` 表里映的是
 * `BACK_TO_LOBBY`（WS 语境下的处置），但 REST 占座被拒**不是**会话失效 ——
 * 「房间已满」不等于登录失效，走 `dispatchRestFailure` 的该分支会把玩家直接登出。
 * ⇒ 就地提示、留在本页。
 */
const ROOM_LOCAL_CODES = new Set([
  ErrCode.ROOM_NOT_FOUND,
  ErrCode.ROOM_FULL,
  ErrCode.NOT_IN_ROOM,
  ErrCode.ROOM_ALREADY_STARTED,
  /** 12012（玩法未开放 / 暂不支持该人数）：REST 建房/占座被拒时就地提示。 */
  ErrCode.GAME_UNAVAILABLE,
]);

/**
 * 玩法名从 **store** 读（R752）—— 本页**不得**写死「斗地主」字面量。
 * 查不到就回落缺省（`DEFAULT_MODE_ID`）—— 那只会发生在「store 里的 id 与 GAME_MODES 不同步」
 * 这种异常上，回落比渲染空白好。
 */
const mode = computed(
  () => findMode(store.activeMode) ?? findMode(DEFAULT_MODE_ID)!,
);

/** 中央：场次名（**按选中的底分查档位表**；查不到就是 `null` —— 不编名字）。 */
const levelName = computed(() => store.selectedLevelName);
/** 中央：选中的底分。`null` = 用户还没在大厅选过。 */
const selectedBaseScore = computed(() => store.selectedBaseScore);

/** 好友房弹层是否展开（**不是**路由 —— 页面栈的唯一真源仍是 `auth.page`）。 */
const friendsOpen = ref(false);

const rooms = ref<RoomInfo[]>([]);
const joinCode = ref("");
/** R49：匹配中状态归 store —— 页面局部 ref 收不到 12007 的复位信号。 */
const matching = computed(() => store.matching);
/**
 * 匹配用时（**纯展示秒表 · 递增**）：watch store.matching 的沿变，true 起表 / false 归零停表。
 * 沿变驱动 ⇒ 入队成功、12009 幂等、12007 超时、取消、reset() 任一置位/复位路径都自动收口，
 * 不用在 match()/unmatch()/事件处理里各自打点。
 *
 * 从 **1s** 起显示（0~1s 这一秒就是「第 1 秒」——匹配等待已经发生，不是倒计时）；
 * 读数基于 `Date.now()-startedAt` 而不是自增累加，interval 漂移不会积误差。
 *
 * ⚠️ 这是**玩法页的展示时钟**，不是牌桌时钟（§9.6「牌桌区不得新造时钟」只约束
 * `src/pages/table/**` 与 `src/components/**`）；但卸载必须清 interval —— 与 `useCountdown`
 * 同纪律，否则组件测完后留下每秒写 ref 的常驻定时器。
 */
const matchNow = ref(Date.now());
const matchElapsed = computed(() => {
  // 起点在 store（`matchingStartedAt`）：跨「返回大厅 → 再进本页」仍在（票没撤）。
  const started = store.matchingStartedAt;
  if (!matching.value || started === null) return 0;
  // 从 **1s** 起显示（0~1s 这一秒就是「第 1 秒」——匹配等待已经发生，不是倒计时）。
  return Math.max(1, Math.floor((matchNow.value - started) / 1000) + 1);
});
let matchTimer: ReturnType<typeof setInterval> | null = null;
function stopMatchTimer() {
  if (matchTimer) {
    clearInterval(matchTimer);
    matchTimer = null;
  }
}
/**
 * ⚠️ `immediate: true` 是必需的：匹配中点「返回大厅」（纯导航、不撤票）后重新挂载本页时，
 * `matching` **没有沿变**（卸载前是 true、挂载后仍是 true）⇒ 非 immediate 的 watcher 不会
 * 触发、秒表停摆（2026-10-18 实机形态：「正在匹配…0s」）。这里只负责**驱动重绘**，
 * 真实等待时长由 store 的起点计算。
 */
watch(
  matching,
  (isMatching) => {
    stopMatchTimer();
    if (!isMatching) return;
    matchNow.value = Date.now();
    matchTimer = setInterval(() => {
      matchNow.value = Date.now();
    }, 1000);
  },
  { immediate: true },
);
onUnmounted(stopMatchTimer);
const busy = ref(false);

/* ─── 记牌器收费片：购买面板（规格 §2.7；仅开局前、仅金币场）───────────────── */
const ccStatus = ref<rest.CardCounterStatusData | null>(null);
const ccStatusFailed = ref(false);
const ccError = ref("");
const purchasing = ref(false);
/**
 * 记牌器购买错误（Task 9 浮层化）：`ccError` 仍是入口圆点（`ccAttention`）的数据源，
 * 浮层 `cc-error` 是玩家可见的呈现 —— 两处**同源**，写/清必须一起做。
 */
function setCcError(text: string): void {
  ccError.value = text;
  showGameError("cc-error", text);
}
function clearCcError(): void {
  ccError.value = "";
  notices.dismiss("cc-error");
}
/** 确认弹窗在途守卫（防双击开两个确认框、并发覆盖待确认记录）。 */
const confirming = ref(false);
/**
 * 记牌器购买弹层（2026-10-19 入口改造）：主界面只留顶栏小入口，购买内容收进弹层。
 * 弹层只承载「购买/权益」，**不改变**购买逻辑（幂等/待确认/14003 预检全在原函数里）。
 */
const ccShopOpen = ref(false);

/**
 * 是否存在「同用户、未过期」的待确认购买记录（入口提示点的数据源）。
 * 钱路径的未知结局要求玩家可重试 —— 提示必须能在**弹层关闭**时被看见。
 */
const ccPending = ref(false);
/** 购买错误 / 待确认订单 ⇒ 入口小圆点。 */
const ccAttention = computed(() => ccError.value !== "" || ccPending.value);

function refreshCardCounterPending(): void {
  const pending = loadPendingCardCounterPurchase();
  ccPending.value =
    pending !== null &&
    pending.userId === auth.userId &&
    Date.now() - pending.createdAt <= PENDING_CARD_COUNTER_TTL_MS;
}

function openCounterShop(): void {
  ccShopOpen.value = true;
  // 弹层是天然刷新点：包时卡「约剩 N 分钟」随时间变化，开层即复拉一次权益。
  void loadCardCounterStatus();
}

/**
 * 匹配开始 ⇒ 强制关闭购买弹层：
 * 匹配中不可购买（`buyCardCounter` 会早退），若只靠 `v-if` 隐藏，匹配结束后弹层会自动重开；
 * 且打开态的全屏遮罩会挡住「取消匹配」与等待提示 —— 这里把状态也一并复位。
 */
watch(matching, (isMatching) => {
  if (isMatching) ccShopOpen.value = false;
});

const ccPerGame = computed(() => store.cardCounterPricePerGameCoins);
const ccPerHour = computed(() => store.cardCounterPricePerHourCoins);
/**
 * 入口/弹层可见条件（2026-10-19 入口改造）：总开关开 + 金币场 + 两价格均为数值
 * （旧服务端 null ⇒ 整块不渲染）。
 * ⚠️ **不含 matching**：模板另外叠 `&& !matching`（匹配中入口隐藏、弹层由 watcher 强制关闭）。
 */
const ccPanelVisible = computed(
  () =>
    store.cardCounterEnabled &&
    store.roomMode === "gold" &&
    typeof ccPerGame.value === "number" &&
    typeof ccPerHour.value === "number",
);
const ccFree = computed(() => ccPerGame.value === 0 && ccPerHour.value === 0);
const ccThreshold = computed(() => {
  const base = store.selectedBaseScore;
  return base === null ? null : store.goldThreshold(base);
});
/** 14003 预检：买完会跌回金币场门槛以下 ⇒ 该商品禁用（服务端仍是权威）。 */
function ccBlocked(price: number): boolean {
  return (
    store.walletBalance !== null &&
    ccThreshold.value !== null &&
    store.walletBalance - price < ccThreshold.value
  );
}
const ccBlockWarning = computed(() => {
  const threshold = ccThreshold.value;
  const balance = store.walletBalance;
  if (threshold === null || balance === null) return "";
  // 注意：总价 = 单价 × 数量（Stepper 用户选的数量）
  const gameTotal = (ccPerGame.value ?? 0) * ccGameCount.value;
  const hourTotal = (ccPerHour.value ?? 0) * ccHourCount.value;
  if ((gameTotal > 0 && balance - gameTotal < threshold) || (hourTotal > 0 && balance - hourTotal < threshold)) {
    return `购买后余额将低于本场门槛（${threshold} 金币），请先补充金币`;
  }
  return "";
});

/* ─── Stepper 状态：单局卡 1..10、包时卡 1..8 ──────────────────────────── */
const ccGameCount = ref(1);
const ccHourCount = ref(1);
const CC_GAME_MAX = 10;
const CC_HOUR_MAX = 8;
const ccGameTotalPrice = computed(() => (ccPerGame.value ?? 0) * ccGameCount.value);
const ccHourTotalPrice = computed(() => (ccPerHour.value ?? 0) * ccHourCount.value);

function stepGame(delta: -1 | 1): void {
  ccGameCount.value = Math.max(1, Math.min(CC_GAME_MAX, ccGameCount.value + delta));
}
function stepHour(delta: -1 | 1): void {
  ccHourCount.value = Math.max(1, Math.min(CC_HOUR_MAX, ccHourCount.value + delta));
}
const ccPassText = computed(() => {
  if (ccStatus.value === null) {
    // 未知（拉取失败/旧服务端）⇒ 如实显示「—」，不得把未知呈现成「未开通」。
    return ccStatusFailed.value ? "—" : "未开通";
  }
  const expires = ccStatus.value.passExpiresAt ?? null;
  if (expires !== null && expires > Date.now()) {
    const minutes = Math.max(1, Math.ceil((expires - Date.now()) / 60_000));
    return `约剩 ${minutes} 分钟`;
  }
  return "未开通";
});

function createCardCounterRequestId(kind: "game" | "hour"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `cc-${kind}-${Date.now().toString(36)}-${rand}`;
}

function confirmCardCounterPurchase(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    uni.showModal({
      title: "购买记牌器",
      content: `确认购买${label}？`,
      success: (res) => resolve(res.confirm === true),
      fail: () => resolve(false),
    });
  });
}

async function loadCardCounterStatus(): Promise<void> {
  try {
    const res = await rest.fetchCardCounterStatus();
    if (res.code === 0 && res.data) {
      ccStatus.value = res.data;
      ccStatusFailed.value = false;
    } else {
      /**
       * Task 9：按 `CLIENT_ACTION` 表分流 —— `BACK_TO_LOBBY`（令牌失效类）清本地会话回登录页；
       * 其余（含 10007 上游不可用与「code 0 但无 data」的契约违约）只落静态失败位
       *（面板显示「—」+「权益信息加载失败（不影响购买）」）。
       */
      const classified = classifyAck(res);
      if (classified.action === ClientAction.BACK_TO_LOBBY) {
        stopGameSession();
        auth.sessionEnded(playerMessage(res.code, { context: "auth" }));
      } else {
        ccStatusFailed.value = true;
      }
    }
  } catch {
    ccStatusFailed.value = true;
  }
}

/**
 * 购买（幂等优先）：确认 → 生成 requestId → **先持久化待确认记录** → 请求。
 * 未知结果（网络/10007）保留记录，同号重试；确定性失败清记录。status 只作展示。
 */
async function buyCardCounter(kind: "game" | "hour"): Promise<void> {
  if (purchasing.value || confirming.value || matching.value) return;
  /**
   * 🔴 未决订单优先：存在同用户、未超 24h 的待确认记录 ⇒ **同 requestId 重试**，
   * 绝不生成新号（否则「首笔已成功但响应丢失」后的再次点击会合法地再扣一次）。
   * 这条路径不需要重新确认（上一条意向已由用户确认过）。
   */
  const outstanding = loadPendingCardCounterPurchase();
  if (
    outstanding !== null &&
    outstanding.userId === auth.userId &&
    Date.now() - outstanding.createdAt <= PENDING_CARD_COUNTER_TTL_MS
  ) {
    await sendCardCounterPurchase(outstanding);
    return;
  }
  const count = kind === "game" ? ccGameCount.value : ccHourCount.value;
  const unitPrice = kind === "game" ? ccPerGame.value : ccPerHour.value;
  if (unitPrice === null || unitPrice <= 0) return;
  const totalPrice = unitPrice * count;
  if (ccBlocked(totalPrice)) {
    setCcError(ccBlockWarning.value || "金币不足");
    return;
  }
  const label =
    kind === "game"
      ? count === 1
        ? `单局卡（${unitPrice} 金币/局）`
        : `单局卡 ×${count}（${totalPrice} 金币）`
      : count === 1
        ? `包时卡 1 小时（${unitPrice} 金币）`
        : `包时卡 ${count} 小时（${totalPrice} 金币）`;
  confirming.value = true;
  let confirmed = false;
  try {
    confirmed = await confirmCardCounterPurchase(label);
  } finally {
    confirming.value = false;
  }
  if (!confirmed) return;

  const pending: PendingCardCounterPurchase = {
    userId: auth.userId,
    kind,
    ...(kind === "hour" ? { hours: count } : {}),
    ...(kind === "game" && count > 1 ? { credits: count } : {}),
    expectedPrice: totalPrice,
    requestId: createCardCounterRequestId(kind),
    createdAt: Date.now(),
  };
  savePendingCardCounterPurchase(pending);
  // 记录一落盘就让入口带提示：请求可能长时间不落地（无超时），不能等 finally 才亮圆点。
  refreshCardCounterPending();
  await sendCardCounterPurchase(pending);
}

async function sendCardCounterPurchase(pending: PendingCardCounterPurchase): Promise<void> {
  purchasing.value = true;
  try {
    const res = await rest.purchaseCardCounter({
      kind: pending.kind,
      ...(pending.hours === undefined ? {} : { hours: pending.hours }),
      ...(pending.credits === undefined ? {} : { credits: pending.credits }),
      requestId: pending.requestId,
      expectedPrice: pending.expectedPrice,
    });
    if (res.code === 0 && res.data) {
      clearPendingCardCounterPurchase();
      ccStatus.value = { credits: res.data.credits, passExpiresAt: res.data.passExpiresAt };
      ccStatusFailed.value = false;
      store.setWalletBalance(res.data.balanceAfter);
      clearCcError();
      return;
    }
    /**
     * Task 9：非 0 先过 `CLIENT_ACTION` 表 —— `BACK_TO_LOBBY`（令牌失效类）清本地会话后
     * 直接收口（待确认记录一并清掉：会话都结束了，重试入口已不存在）。其余业务分支
     * 保持原样（14009/14010/14001/14008/10007/default），只是文案同时进浮层 `cc-error`。
     */
    const classified = classifyAck(res);
    if (classified.action === ClientAction.BACK_TO_LOBBY) {
      clearPendingCardCounterPurchase();
      stopGameSession();
      auth.sessionEnded(playerMessage(res.code, { context: "auth" }));
      return;
    }
    switch (res.code) {
      case ErrCode.E_CARD_COUNTER_PRICE_CHANGED: {
        /**
         * 价格已变：先刷新配置再提示。刷新失败 ⇒「价格刷新失败，请重试」并**保留**
         * 待确认记录（下一发仍用同 requestId；配置刷新成功后玩家再按新价重新确认）。
         */
        const refreshed = await refreshClientConfig();
        if (refreshed) {
          clearPendingCardCounterPurchase();
          setCcError("价格已更新，请重新确认后购买");
        } else {
          setCcError("价格刷新失败，请重试");
        }
        return;
      }
      case ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT:
        clearPendingCardCounterPurchase();
        setCcError("请求号冲突，请重新购买");
        return;
      case ErrCode.E_INSUFFICIENT_FUNDS:
        clearPendingCardCounterPurchase();
        setCcError("金币不足");
        return;
      case ErrCode.E_CARD_COUNTER_UNAVAILABLE:
        clearPendingCardCounterPurchase();
        setCcError("记牌器暂未开放");
        return;
      case ErrCode.UPSTREAM_UNAVAILABLE:
        // 未知结局：保留待确认记录（重挂载/重试复用同 requestId，端点幂等优先）。
        setCcError("结果确认中，请再次点击购买以重试（不会重复扣费）");
        return;
      default:
        clearPendingCardCounterPurchase();
        setCcError(res.message || "购买失败");
        return;
    }
  } catch (e) {
    reportError("game.purchaseCardCounter", e);
    setCcError("结果确认中，请再次点击购买以重试（不会重复扣费）"); // 网络错误：保留记录
  } finally {
    purchasing.value = false;
    refreshCardCounterPending();
  }
}

/** 重挂载对账：同 userId、未超 24h 的待确认记录 ⇒ 同 requestId 重试。 */
async function resumePendingCardCounterPurchase(): Promise<void> {
  const pending = loadPendingCardCounterPurchase();
  if (!pending) return;
  if (pending.userId !== auth.userId) {
    clearPendingCardCounterPurchase();
    return;
  }
  if (Date.now() - pending.createdAt > PENDING_CARD_COUNTER_TTL_MS) {
    clearPendingCardCounterPurchase();
    return;
  }
  await sendCardCounterPurchase(pending);
}
/**
 * `RoomInfo['status']`（**服务端字段**）→ `wd-tag` 的**配色档位**。
 *
 * ⚠️ 这只是「枚举 → 颜色」的展示翻译，**不是**规则判断：准入/胜负/能否进房全部在服务端，
 * 前端不改写也不推理 `status`（哑终端）。
 */
const STATUS_TAG_TYPE: Record<
  RoomInfo["status"],
  "primary" | "success" | "warning" | "danger"
> = {
  waiting: "success",
  playing: "primary",
  finished: "warning",
  cancelled: "danger",
};

/**
 * 房间列表失败的**唯一**呈现（信封失败与传输拒绝共用）：sticky + critical 的 `rooms` 项
 * + 「刷新」动作。sticky 是刻意的：它挡着「点列表项进房」这条路径，直到刷新成功
 * （成功分支 `dismiss('rooms')`）。服务端 message 保留在文案里（「参数错误」等具体原因
 * 不能被吞掉 —— `playerMessage` 的 message-first 码会优先采用它）。
 */
function setRoomsFailure(reason: string): void {
  notices.setNotice("rooms", `房间列表加载失败：${reason}`, {
    level: "error",
    durationMs: 0,
    priority: "critical",
    dismissible: true,
    actions: [{ label: "刷新", onClick: () => void loadRooms() }],
  });
}

/**
 * R22：只按统一信封读，`data` 就是 `RoomInfo[]`。
 *
 * R34：非 0 的码一律经 `dispatchRestFailure` 查 `CLIENT_ACTION` 表后执行——
 * `BACK_TO_LOBBY`（`10002`/`10005`）**先销毁本地 WS 会话**（R36）再清本地会话回登录页
 * （**不**再调服务端登出）；`TOAST` 提示；`REFRESH_SNAPSHOT`/`RECONNECT` 在 REST 语境下
 * 退化为「重放一次」。`replayed` 保证重放**最多一次**，不循环。
 *
 * Task 9：失败原因走浮层 sticky 项（`rooms`），不再占页面文档流；成功时收起。
 */
async function loadRooms(replayed = false) {
  notices.dismiss("game-error");
  try {
    const res = await rest.rooms(store.activeGameType);
    if (res.code === 0) {
      rooms.value = res.data ?? [];
      notices.dismiss("rooms");
      return;
    }
    rooms.value = [];
    await dispatchRestFailure(res, {
      toast: (report) => {
        setRoomsFailure(
          playerMessage(report.code, { context: "rest", serverMessage: report.message }),
        );
      },
      // R34/R36：BACK_TO_LOBBY（10002/10005）→ 先销毁本地 WS 会话，再清本地认证状态回登录页。
      // 令牌已不可用，**不**调服务端登出（它也会返回同样的码）。
      signOutLocally: () => {
        stopGameSession();
        auth.clearLocalSession();
      },
      replay: () => (replayed ? Promise.resolve() : loadRooms(true)),
    });
  } catch (e) {
    // 房间列表失败不该阻塞主路径（匹配按钮仍然可用）；原始异常只进上报链。
    reportError("game.loadRooms", e);
    setRoomsFailure("网络异常，请稍后重试");
    rooms.value = [];
  }
}

/**
 * 随机匹配（协议②）：带上**大厅选中的底分** + **大厅选中的场次**（② 金币场 §14）。
 *
 * ⚠️ **不得写死一个数字**（M09：前端不得含规则常量）—— 这里用的是 store 里那个
 * **服务端下发的**档位值，本页一个底分字面量都没有。
 * ⚠️ **`mode` 不得硬编码 `'random'`**（本片替换的正是 :139 那处）：它读
 * `store.roomMode`（大厅的场次切换写的选中值，`'random'`/`'gold'`）——
 * 判据在 `auth-ui-wiring.test.ts`（「开始游戏 mode 接线」：gold 选中 ⇒ 载荷 mode='gold'）。
 * 没选过（`null`）就**不发**：如实报错，**不猜**（猜出来的值就是前端规则常量）。
 * 这在 UI 上是**双重**的：按钮本身禁用 + 一行 `.game__hint` 说明原因
 * （本仓明文忌讳「点了没反应的活按钮」）。
 *
 * ⚠️ **风控 T8**：载荷随行 `deviceId`（`net/storage` 的 `getDeviceId()`，跨登出/换号持久）。
 * 这是它在**客户端唯一**的发送点 —— 不得再复制第二处（`settlement-rematch.test.ts` ⑤
 * 按源码计数钉「`send('room.match'` 恰一处」）。
 */
async function match() {
  const session = getGameSession();
  session.clearNotice(); // 玩家主动重开匹配 ⇒ 清掉上一次的失败提示
  if (busy.value) return;
  notices.dismiss("game-error");
  const baseScore = store.selectedBaseScore;
  if (baseScore === null) {
    showGameError("game-error", "请先在大厅选择底分");
    return;
  }
  busy.value = true;
  try {
    const outcome = await getGameSession().client.send("room.match", {
      mode: store.roomMode,
      baseScore,
      // 多玩法（S5.4）：玩法 + 人数随匹配上行。人数来自 store 的有效值
      //（客户端能力 ∩ 服务端开放）。模板写 `@click="match()"`，避免 MouseEvent 被当成人数。
      gameType: store.activeGameType,
      playerCount: store.effectivePlayerCount,
      // 风控 T8：设备指纹随行（服务器可见、玩家面永不出站 —— K3）
      deviceId: getDeviceId(),
    });
    if (outcome.status === "blocked") {
      // 链路已判死：连接死态由 NoticeStack 内置 connection-dead 项承担，页面不写本地错误。
      if (outcome.reason instanceof ConnectionDeadError) return;
      showGameError("game-error", "上一个操作还在进行中，请稍候");
      return;
    }
    // R51：12009 = 已在队列中，`CLIENT_ACTION` 表把它归为 IGNORE ⇒ 处置层什么也没做，
    // 页面必须自己把它当成**幂等成功**（用户点了两次，结果一样）。
    if (outcome.code === ErrCode.ALREADY_IN_QUEUE) {
      store.setMatching(true);
      return;
    }
    /**
     * 本片（「返回大厅」弃局出口 + 匹配守卫 / 用户裁决 K2）：12011 = **在局/在房**守卫拒绝
     * ——**只导航、不写本地文案**。
     *
     *  - 不写本地提示：同句中文若既进 `game-error` 又进 session notice 会**双呈现**
     *    （牌桌既有同族教训）；文案**只走 TOAST 通道**（`net/copy.ts` 的 12011 条目，
     *    由 `CLIENT_ACTION` 表派发到会话提示）。
     *  - 导航前过 `store.roomCode !== null` 守卫（`canShowTable` 同族纪律）：等待房与进行中
     *    命中者都满足它、被送回牌桌；多端 B 端在补推到达前 store 尚空的空壳形态不满足
     *    ⇒ **不导航**（不得把用户送到一张空牌桌），只留 TOAST。
     */
    if (outcome.code === ErrCode.ALREADY_IN_GAME) {
      if (store.roomCode !== null) auth.navigate('table');
      return;
    }
    // 其余 ack 非 0：**只由 session notice 呈现**（本页零本地文案 —— Task 9 的来源分流）。
    if (outcome.code !== 0) return;
    store.setMatching(true);
  } catch (e) {
    // 死态类异常：呈现交给 Stack，不写本地错误。
    if (e instanceof ConnectionDeadError) return;
    reportError("game.match", e);
    showGameError("game-error", "匹配失败，请稍后重试");
  } finally {
    busy.value = false;
  }
}

async function unmatch() {
  if (busy.value) return;
  notices.dismiss("game-error");
  busy.value = true;
  try {
    const outcome = await getGameSession().client.send("room.unmatch", {});
    if (outcome.status === "blocked") {
      if (outcome.reason instanceof ConnectionDeadError) return;
      showGameError("game-error", "上一个操作还在进行中，请稍候");
      return;
    }
    // 非 0 只由 session notice 呈现（Task 9：本页不写本地文案）。
    if (outcome.code !== 0) return;
    store.setMatching(false);
  } catch (e) {
    if (e instanceof ConnectionDeadError) return;
    reportError("game.unmatch", e);
    showGameError("game-error", "取消失败，请稍后重试");
  } finally {
    busy.value = false;
  }
}

/**
 * 机器人补位开关片：服务端 `match.wait_prompt` 的底部悬浮卡片态
 * （文案原样呈现，不前端自编）。只在「匹配中」才有内容
 * （store 的守卫 + setMatching 收口双保险）。
 *
 * ⚠️ 合并说明：等待提示保留 origin/dev 的底部悬浮卡片（较新的设计），
 * 不再进 `NoticeStack`；其余事件提示仍走 Stack。
 */
const waitPrompt = computed(() => store.matchWaitPrompt);

/**
 * 连接已死时等待卡片让位：卡片按钮发不出去。
 * 现在和大厅同源：直接读 currentSession 的 connectionState，不再靠 ConnectionDeadBar 上报。
 */
const connectionDead = computed(
  () => currentSession.value?.connectionState.value?.phase === "dead",
);

/**
 * 「继续等待」：发 `room.match.extend`（票**留在原队列**、排队位置不变，
 * 服务端只平移提示窗口锚点），随后关掉浮层继续等。
 * 不切 matching、不重启秒表（匹配没有终止过）。
 */
async function extendMatching() {
  if (busy.value) return;
  busy.value = true;
  try {
    const outcome = await getGameSession().client.send("room.match.extend", {});
    if (outcome.status === "blocked") return;
    // ack 非 0（如票已不在队列）也关窗：后续的成局/12007 推送会把 matching 自然收口，
    // 浮层留着只会挡「取消匹配」。错误码本身已由 CLIENT_ACTION 表派发提示。
    store.clearMatchWaitPrompt();
  } finally {
    busy.value = false;
  }
}

/**
 * 「重新匹配」：先取消当前票（出旧队列），再走**唯一**的匹配入口 `match()` 重新入队。
 *
 * ⚠️ 不得在本函数直接 `send('room.match'`（settlement-rematch ⑤ 按源码计数钉死
 * `game.vue` 里该发送点**恰好 1 处**）—— 取消后的重新入队复用 `match()`，
 * 与「开始游戏」/「再来一局」是同一条实现。
 * unmatch 非 0（票可能已被服务端清掉）也继续调 `match()`：服务端对仍在队的票回
 * 12009（幂等成功），`match()` 已把它当成功收口。
 */
async function rematchAfterPrompt() {
  if (busy.value) return;
  store.clearMatchWaitPrompt();
  busy.value = true;
  try {
    const outcome = await getGameSession().client.send("room.unmatch", {});
    if (outcome.status === "blocked") return;
    if (outcome.code === 0) store.setMatching(false);
  } finally {
    busy.value = false;
  }
  await match();
}

/**
 * 进房：**同一条 `room.join` 的唯一实现**（R61/R454）。
 *
 * 三条入口全部走这里，**不得**复制第二份 `room.join` 逻辑：
 *   - 手动输入房号（`join()` 默认取输入框）
 *   - 点击房间列表项（`join(room.code)`）
 *   - 创建房间成功之后（`createAndJoin()` 把房号写进输入框再调用它）
 *
 * `code` 省略时取输入框；两处都做同样的归一化（去空白 + 大写）——房号由服务端生成，
 * 前端只做大写化，不做任何格式判断（哑终端）。
 *
 * ⚠️ **两步，顺序不可反**（spec §3.2 / R802）：
 *   ① **REST 占座**（`POST /api/rooms/:code/join`）：服务端 `claimSeat`，真服务端里
 *      **唯一**的占座方式（`rooms.service.ts:136`）；
 *   ② **WS 挂载**（`room.join`）：把已占的座位挂到本连接上，ack 才带 `seat`/`players`。
 *
 * 建房 REST **不入座**（`players: []`）⇒ 少了 ① 就是 F6：`room.join` 拿 `12004`
 * ⇒ `CLIENT_ACTION` 判 BACK_TO_LOBBY ⇒ 人被踢回大厅而房间还挂着。
 *
 * ⚠️ **不能反过来「先发 WS、遇 12004 再补 REST」**：`client.send()` 在 ack 回调里
 * **同步**派发 `CLIENT_ACTION`（`net/socket.ts` 的 `dispatchAck`）⇒ 12004 到手时
 * 用户**已经在去大厅的路上**了，没有补救的余地（spec §1.2 H1）。
 *
 * ⚠️ 归一化后的局部变量**叫 `code`**：`game-store-session-reset.test.ts` 的源码级断言
 * （R418：两条进房路径共用 `setRoom`）钉的就是 `store.setRoom(code,` 这个字面量。
 */
async function join(entered?: string, replayed = false) {
  const code = (entered ?? joinCode.value).trim().toUpperCase();
  if (!code || busy.value) return;
  busy.value = true;
  notices.dismiss("game-error");
  try {
    // ① REST 占座（spec §3.2 的 ①）：失败就**不**发 WS、**不**进牌桌（R807）
    const seated = await rest.joinRoom(code, store.activeGameType);
    if (seated.code !== 0) {
      /**
       * Task 9：REST 占座不是会话失效场景 —— 12001/12002/12004/12008 在 `CLIENT_ACTION`
       * 表里映的是 `BACK_TO_LOBBY`（WS 语境），若走 `dispatchRestFailure` 的该分支，
       * 「房间已满」会把玩家直接登出。⇒ 这几个码就地提示、留在本页。
       * 其余码（鉴权失效等）才交给 `dispatchRestFailure` 的查表处置。
       *
       * ⚠️ dispatch 前必须**先释放** `busy`：replay 分支要重新进 `join()`，入口守卫会
       * 把持锁的重放静默吞掉。
       */
      busy.value = false;
      if (ROOM_LOCAL_CODES.has(seated.code as ErrCode)) {
        showGameError(
          "game-error",
          `加入房间失败：${playerMessage(seated.code, { context: "rest", serverMessage: seated.message })}`,
        );
        return;
      }
      await dispatchRestFailure(seated, {
        toast: (report) =>
          showGameError(
            "game-error",
            `加入房间失败：${playerMessage(report.code, { context: "rest", serverMessage: report.message })}`,
          ),
        signOutLocally: (report) => {
          stopGameSession();
          auth.sessionEnded(playerMessage(report.code, { context: "auth" }));
        },
        replay: () => (replayed ? Promise.resolve() : join(code, true)),
      });
      return;
    }
    // R804：以服务端回包的房号为准（输入框里那串只是候选）
    joinCode.value = (seated.data?.code ?? code).trim().toUpperCase();

    // ② WS 挂载（既有实现，逐字保留；S5.4：带客户端玩法，pdk 房缺它会被 12012 拒）
    const outcome = await getGameSession().client.send('room.join', {
      roomCode: code,
      gameType: store.activeGameType,
    });
    if (outcome.status === "blocked") {
      if (outcome.reason instanceof ConnectionDeadError) return;
      showGameError("game-error", "上一个操作还在进行中，请稍候");
      return;
    }
    // WS ack 非 0（12001/12002/12004/12008…）：只由 session notice 呈现，本页零本地文案。
    if (outcome.code !== 0) return;
    /**
     * R61：**同一条 `room.join` 只能有一种状态写入方式**。
     *
     * 自动进房（`useGameSession.joinMatchedRoom`）已经消费 ack 里的 `players`，
     * 手动加入这里是同一条消息、同一个 ack 载荷 `{ roomCode, seat, players }`，
     * 因此也必须消费 `players`——否则「进房后立刻渲染座位」在两条路径上表现不一致。
     * 座位取 ack 的 `seat`；**不写 `status`**（ack 里没有这个字段，由服务端推送决定）。
     */
    const data = outcome.data as
      | { seat?: number; players?: RoomPlayerLike[] }
      | undefined;
    store.setRoom(code, typeof data?.seat === "number" ? data.seat : -1);
    store.applyRoomState({ players: data?.players ?? [] });
    auth.navigate("table");
  } catch (e) {
    if (e instanceof ConnectionDeadError) return;
    reportError("game.join", e);
    showGameError("game-error", "加入房间失败，请稍后重试");
  } finally {
    busy.value = false;
  }
}

/**
 * 创建房间（§7.1 的 `POST /api/rooms`，N30③/R454）：建房成功后**复用 `join()`** 进房。
 *
 * ⚠️ **带上大厅选中的底分**（协议 §2 第 6 条允许 `{ mode, baseScore? }`，与 `match()` 同一条纪律）：
 *   - **为什么不写死**（M09）：前端不得含规则常量 —— 底分只能取自服务端下发的档位表里
 *     用户选中的那一档。此前这里不带 `baseScore` ⇒ 服务端落回**它自己的缺省档**（15），
 *     而同一屏中央写着「底分 N」（用户选的那一档）⇒ **同屏自相矛盾**。
 *   - **为什么 `null` 时省略这个键、而不是传 `null`**：「不传」⇒ 服务端走自己的缺省档
 *     （`rooms.service.ts` 的 `dto.baseScore ?? Math.min(档位表)`）；而传 `null` 会让服务端
 *     把它当成一个值去查档位表（`dto.baseScore !== undefined` 成立）、查不到 ⇒ `10001`
 *     ⇒「没选」只能用**省略键**表达。
 *
 * ⚠️ 顺序是刻意的：REST 建房阶段持 `busy` 锁，成功后在 `finally` 里**先释放**再调 `join()` ——
 * `join()` 自己也要拿同一把锁（`busy.value` 时早退）。若在锁内直接调用，进房会被静默吞掉
 * （房间建好了、人没进去）。释放与调用之间没有 `await`，因此不存在被别的点击插队的窗口。
 */
async function createAndJoin(replayed = false) {
  if (busy.value) return;
  busy.value = true;
  notices.dismiss("game-error");
  let roomCode = "";
  try {
    const res = await rest.createRoom({
      mode: "practice",
      gameType: store.activeGameType,
      playerCount: store.effectivePlayerCount,
      ...(store.selectedBaseScore === null ? {} : { baseScore: store.selectedBaseScore }),
    });
    if (res.code !== 0) {
      /**
       * Task 9：与 `join()` 的 REST 占座同一分流 —— 房间业务码就地提示（**不登出**），
       * 其余码（鉴权失效等）交给 `dispatchRestFailure`；replay 前先释放 `busy`。
       */
      busy.value = false;
      if (ROOM_LOCAL_CODES.has(res.code as ErrCode)) {
        showGameError(
          "game-error",
          `创建房间失败：${playerMessage(res.code, { context: "rest", serverMessage: res.message })}`,
        );
        return;
      }
      await dispatchRestFailure(res, {
        toast: (report) =>
          showGameError(
            "game-error",
            `创建房间失败：${playerMessage(report.code, { context: "rest", serverMessage: report.message })}`,
          ),
        signOutLocally: (report) => {
          stopGameSession();
          auth.sessionEnded(playerMessage(report.code, { context: "auth" }));
        },
        replay: () => (replayed ? Promise.resolve() : createAndJoin(true)),
      });
      return;
    }
    roomCode = (res.data?.code ?? "").trim().toUpperCase();
    if (!roomCode) {
      // 服务端没给房号就没法进房：如实报错，**不**编一个房号
      showGameError("game-error", "创建房间失败：服务端未返回房号");
      return;
    }
    joinCode.value = roomCode;
  } catch (e) {
    if (e instanceof ConnectionDeadError) return;
    reportError("game.createAndJoin", e);
    showGameError("game-error", "创建房间失败，请稍后重试");
    return;
  } finally {
    busy.value = false;
  }
  await join(roomCode);
}

onMounted(() => {
  loadRooms();
  // 记牌器收费片：面板状态 + 待确认购买对账（同 requestId 重试；不阻塞页面）。
  // 入口圆点：挂载先同步判一次待确认记录；对账结束后再判一次（失败/成功都会变）。
  refreshCardCounterPending();
  void loadCardCounterStatus();
  void resumePendingCardCounterPurchase().finally(refreshCardCounterPending);
  /**
   * R658「再来一局」：牌桌回**本页**前写了**一次性意向**（`store.rematchPending`）——
   * 本页挂载时**消费一次**并复用本页唯一的 `match()`。
   *
   * ⚠️ 意向兑现用的是**当时选中的底分**（`selectedBaseScore` 跨页存活，`reset()` 不动它）
   * ⇒ 「再来一局」不需要用户重选。
   */
  if (store.consumeRematch()) {
    // 上一局人数回写到选择（闸已关时 setter 拒绝，`effectivePlayerCount` 自动回落）。
    store.setSelectedPlayerCount(store.playerCount);
    void match();
  }
});

/**
 * 本页是**非牌桌**那一屏 ⇒ 与大厅同一首 `CUES.BgmLobby`。
 *
 * ⚠️ 不接这一手的话「大厅 → 本页」会**静默**：大厅卸载时 `onUnmounted` 停了它那一首，
 * 而本页此前什么都不播。
 * ⚠️ 与 `lobby.vue` **逐字同形**：每个页面只管**自己**那一首、自己卸载时停掉 ——
 * 切曲**不跨页面做**（页面栈的唯一真源是 `auth.page`，音频跟着挂载/卸载走）。
 * `playBgm` 自身会先停掉当前曲 ⇒ 大厅 → 牌桌的切换不会叠放两首。
 */
loadAudioPrefs();
playBgm(CUES.BgmLobby);
onUnmounted(() => stopBgm());
</script>

<template>
  <LandscapeStage backdrop="table">
    <view class="game">
      <!--
        ⚠️ **本注释必须在根元素内部**：模板注释放在根元素**之前**会让整页变成**多根**页面，
        `@vue/test-utils` 的 `wrapper.classes()` 于是静默返回 `[]`（`table-hud` 的单根闸盯着）。
        底纹：根元素 `<LandscapeStage backdrop="table">` 与牌桌同款（2026-10-12 用户裁决）。
      -->
      <view class="game__bar">
        <!-- ⚠️ 文案**逐字保留**：真浏览器探针按 `textContent.trim() === '返回大厅'` 匹配 -->
        <button
          type="button"
          class="btn btn--small"
          @click="auth.navigate('lobby')"
        >
          返回大厅
        </button>
        <!-- 记牌器入口（2026-10-19 入口改造）：与牌桌顶栏的记牌器入口同形同文案。
             可见条件沿用旧购买面板：总开关开 + 金币场 + 两价格均为数值 + 未在匹配。
             ⚠️ 入口必须在**顶栏**（`.game__bar`）：用例按作用域断言，挪回中央区会红。 -->
        <button
          v-if="ccPanelVisible && !matching"
          type="button"
          class="btn btn--small game__cardcounter-entry"
          :aria-expanded="ccShopOpen"
          @click="openCounterShop"
        >
          记牌器
          <text v-if="ccAttention" class="game__cardcounter-dot" />
        </button>
        <!-- R752：玩法名**从 store 读**（本页不得写死「斗地主」字面量） -->
        <text class="game__title">{{ mode.name }}</text>
      </view>

      <!-- 中央：场次名 + 底分 + 开始游戏 + 好友房 -->
      <view class="game__stage">
        <view class="game__scene">
          <!-- 场次名**从档位表按选中的底分查**（片规格 §4；查不到就不渲染 —— 不编名字） -->
          <text v-if="levelName" class="game__scene-name">{{ levelName }}</text>
          <text v-if="selectedBaseScore !== null" class="game__scene-base"
            >底分 {{ selectedBaseScore }}</text
          >
        </view>

        <!-- 跑得快 2 人场：人数选择（仅当客户端能力 ∩ 服务端开放 > 1 时出现）。
             ⚠️ 刻意放在 `.game__match` **之外**：既有探针按 `.game__match button`
             取唯一的「开始游戏」，控件不得挤进那条选择器。 -->
        <view v-if="!matching && store.activePlayerCounts.length > 1" class="game__players">
          <button
            v-for="n in store.activePlayerCounts"
            :key="n"
            type="button"
            class="game__player-option"
            :class="{ 'game__player-option--active': store.effectivePlayerCount === n }"
            @click="store.setSelectedPlayerCount(n)"
          >
            {{ n }} 人
          </button>
        </view>

        <view class="game__match">
          <button
            v-if="!matching && store.activeHasSessions"
            type="button"
            class="btn btn--primary"
            :disabled="busy || selectedBaseScore === null"
            @click="match()"
          >
            开始游戏
          </button>
          <template v-else-if="matching">
            <text class="game__matching">
              正在匹配
              <text class="game__matching-dots">
                <text class="game__matching-dot anim-wait-dot">•</text
                ><text
                  class="game__matching-dot anim-wait-dot"
                  :style="{ '--ftl-delay': '150ms' }"
                  >•</text
                ><text
                  class="game__matching-dot anim-wait-dot"
                  :style="{ '--ftl-delay': '300ms' }"
                  >•</text
                >
              </text>
              <!-- 匹配用时秒表（递增，纯展示）：无标签前缀，样式继承「正在匹配」，只留左间距。 -->
              <text class="game__matching-elapsed">{{ matchElapsed }}s</text>
            </text>
            <button type="button" class="btn" :disabled="busy" @click="unmatch">
              取消匹配
            </button>
          </template>
        </view>

        <!-- 记牌器收费片（2026-10-19 入口改造）：购买内容收进顶栏入口打开的**弹层**，
             主界面恢复「场次 + 开始游戏」两件事。刻意不再放在 `.game__match` 附近 ——
             既有探针按 `.game__match button` 取唯一按钮。 -->

        <!-- 机器人补位开关片：等待提示使用 origin/dev 的底部悬浮卡片
             （`.game__waitprompt-layer`）；刻意不在 `.game__match` 里：既有探针按
             `.game__match button` 取唯一按钮。 -->
        <text v-if="selectedBaseScore === null" class="game__hint"
          >请先在大厅选择底分</text
        >

        <!-- 错误行已退役（Task 9）：本地错误 / REST 失败统一走 `NoticeStack` 浮层
             （`game-error` 等），浮层 z=15 高于两个全屏弹层（z=10）⇒ 弹层打开时依然可见、
             也不会挤压弹层布局。等待卡片由 `hasGameError` 让位。 -->

        <!-- 「好友房」二级入口（规格 §4）：**弹层**，不新增路由。
             片⑦：入口按服务端配置门控 —— `false`/未知一律**不渲染**（C19 fail-safe）。 -->
        <button
          v-if="store.activeFriendRoomEnabled"
          type="button"
          class="btn game__friends-open"
          :class="{ 'game__friends-open--matching': matching }"
          :disabled="busy || matching"
          @click="friendsOpen = true"
        >
          好友房
        </button>
      </view>

      <!-- 左下：玩家信息条（与大厅顶栏同一个共用件）。
           ② 金币场：**金币场选中时显余额真值**（供玩家确认够不够入场），免费场恒「—」
           —— 与牌桌「免费场整场统一『—』」同一形态（D7；余额只属于金币语境）。 -->
      <PlayerChip
        class="game__player"
        :name="auth.displayName"
        :balance="store.roomMode === 'gold' ? store.walletBalance : null"
      />

      <!--
        缺人等待提示：底部悬浮卡片（设计 spec D2/D3）。
        ⚠️ 独立于 `.game__stage`：`position: absolute` 不参与文档流，出现/消失不挤中央 UI。
        ⚠️ 全宽层 `pointer-events: none`，卡片自身 `auto` —— 空白区不拦截下层点击。
        ⚠️ 放在 `.game__match` 外面：既有探针按 `.game__match button` 取唯一按钮。
        ⚠️ `!error`：页面级错误优先于等待提示（错误行在 stage 里，卡片会盖住它）；
        错误清掉后卡片自动回来，匹配生命周期不变。
        ⚠️ `!connectionDead`：死态优先（卡片按钮发不出去；connectionDead 由 currentSession 直接读）。
      -->
      <view v-if="waitPrompt && !hasGameError && !connectionDead" class="game__waitprompt-layer">
        <view class="game__waitprompt anim-float-up">
          <view class="game__waitprompt-main">
            <text class="game__waitprompt-icon" aria-hidden="true">⏳</text>
            <text class="game__waitprompt-text" role="status">{{ waitPrompt }}</text>
          </view>
          <view class="game__waitprompt-actions">
            <button
              type="button"
              class="btn btn--small game__waitprompt-btn"
              :disabled="busy"
              @click="rematchAfterPrompt"
            >
              重新匹配
            </button>
            <button
              type="button"
              class="btn btn--primary btn--small game__waitprompt-btn"
              :disabled="busy"
              @click="extendMatching"
            >
              继续等待
            </button>
          </view>
        </view>
      </view>

      <!--
        「好友房」弹层（片规格 §4 裁决二）：创建房间 / 输房号 / 房间列表三件**整体**收进来。
        class 前缀 `game__` 与文案**逐字保留**（探针与用例指着它们）。
        房间列表用 `wot-design-uni`（easycom，**零 import**）：`wd-cell-group` / `wd-cell` / `wd-loadmore`。
      -->
      <view v-if="friendsOpen" class="game__friends">
        <view class="game__friends-panel">
          <view class="game__friends-head">
            <text class="game__friends-title">好友房</text>
            <button
              type="button"
              class="btn btn--small game__friends-close"
              @click="friendsOpen = false"
            >
              关闭
            </button>
          </view>

          <!-- N30③/R454：§7.1 的 POST /api/rooms 前端入口（与「开始游戏」并列，不走匹配队列）。 -->
          <view class="game__create">
            <button
              type="button"
              class="btn game__create-room"
              :disabled="busy"
              @click="createAndJoin()"
            >
              创建房间
            </button>
          </view>

          <view class="game__join">
            <input
              v-model="joinCode"
              type="text"
              placeholder="输入 6 位房间号"
              maxlength="6"
            />
            <!-- ⚠️ 必须写成 `join()`：`join(code?: string)` 之下 `@click="join"` 会把 MouseEvent 当房号传进去 -->
            <button
              type="button"
              class="btn"
              :disabled="busy || !joinCode"
              @click="join()"
            >
              加入
            </button>
          </view>

          <view class="game__rooms">
            <view class="game__rooms-head">
              <text class="game__rooms-title">房间列表</text>
              <!-- ⚠️ 必须写成 `loadRooms()`：`@click="loadRooms"` 会把 MouseEvent 当成 `replayed` 参数 -->
              <button type="button" class="btn btn--small" @click="loadRooms()">
                刷新
              </button>
            </view>

            <wd-cell-group v-if="rooms.length > 0" class="game__list" border>
              <!-- N30③/R454：列表项可点 → **复用**同一条 `room.join`（见 `join(code?)` 的注释）。
                   `clickable` 才会 emit click（`wd-cell` 只在 clickable/is-link 时 emit）。 -->
              <wd-cell
                v-for="room in rooms"
                :key="room.code"
                class="game__item game__item--clickable"
                clickable
                center
                @click="join(room.code)"
              >
                <template #title>
                  <text class="game__code">{{ room.code }}</text>
                </template>
                <view class="game__meta">
                  <wd-tag
                    class="game__status"
                    :type="STATUS_TAG_TYPE[room.status]"
                    plain
                    >{{ room.status }}</wd-tag
                  >
                  <!-- 逐字保留改造前的整句文案（`status · n/m · 底分 x`）：测试对它的断言是文本级的 -->
                  <text class="game__count">
                    {{ room.status }} · {{ room.playerCount }}/{{
                      room.maxPlayers
                    }}
                    · 底分 {{ room.baseScore }}
                  </text>
                </view>
              </wd-cell>
            </wd-cell-group>

            <!-- 空态：`wd-loadmore` 的 `finished` 态自带一条分割线 + 文案。
                 ⚠️ **文案必须走 `finished-text` prop，不能写在标签之间**（片③ F7 的订正）：
                 该组件的 `finished` 分支是 `<wd-divider>{{ finishedText || translate('finished') }}</wd-divider>`
                 —— 模板里**根本没有 `<slot/>`** ⇒ 写在标签之间的内容**被丢弃**，
                 生产里只会显示组件库默认的「已加载完毕」（实测截图见片③ §9 F7）。
                 （初稿那句「文案放在插槽里而不是 finished-text」是**错的**，本片按组件源码订正。） -->
            <wd-loadmore
              v-else
              class="game__empty"
              state="finished"
              finished-text="暂无房间"
            />
          </view>
        </view>
      </view>
      <!--
        记牌器购买弹层（2026-10-19 入口改造；仅金币场、两价格均为数值）。
        ⚠️ 遮罩关闭必须是**裸 `@click` + 面板根 `@click.stop`**（`@click.self` 在 uni-app H5
           恒被吞 —— jsdom 看不见，源码闸在 card-counter-purchase.test.ts 里钉着）。
        ⚠️ z-index 10 与好友房弹层同档；两弹层靠全屏遮罩互相遮挡、实际互斥。
      -->
      <view
        v-if="ccShopOpen && !matching"
        class="game__cardcounter-mask"
        @click="ccShopOpen = false"
      >
        <view class="game__cardcounter" @click.stop>
          <view class="game__cardcounter-head">
            <view class="game__cardcounter-head-left">
              <text class="game__cardcounter-title">记牌器</text>
            </view>
            <button
              type="button"
              class="btn btn--small game__cardcounter-close"
              aria-label="关闭"
              @click="ccShopOpen = false"
            >
              ×
            </button>
          </view>

          <text v-if="ccFree" class="game__cardcounter-line game__cardcounter-line--free">
            🎉 金币场免费使用
          </text>

          <template v-else>
            <!-- 单局卡 -->
            <view
              v-if="ccPerGame !== null && ccPerGame > 0"
              class="game__cardcounter-card"
            >
              <!-- 卡头：名称 + 权益状态（各占一侧，窄宽下也不会把字挤成竖排）。 -->
              <view class="game__cardcounter-card-head">
                <text class="game__cardcounter-card-name">单局卡</text>
                <text class="game__cardcounter-card-desc">
                  {{ ccStatus ? `剩余 ${ccStatus.credits} 张` : "—" }}
                </text>
              </view>
              <!-- 操作行：单价（撑满剩余宽度）｜数量 stepper｜购买。 -->
              <view class="game__cardcounter-card-row">
                <text class="game__cardcounter-price">
                  {{ ccPerGame }}<text class="game__cardcounter-price-unit">金币</text>
                  <text class="game__cardcounter-price-suffix">/ 局</text>
                </text>
                <view class="game__cardcounter-stepper">
                  <button
                    type="button"
                    class="btn btn--small game__cardcounter-step"
                    :disabled="purchasing || confirming || ccGameCount <= 1"
                    @click="stepGame(-1)"
                  >−</button>
                  <text class="game__cardcounter-step-val">{{ ccGameCount }}</text>
                  <button
                    type="button"
                    class="btn btn--small game__cardcounter-step"
                    :disabled="purchasing || confirming || ccGameCount >= CC_GAME_MAX"
                    @click="stepGame(1)"
                  >+</button>
                </view>
                <button
                  type="button"
                  class="btn btn--primary btn--small game__cardcounter-buy"
                  :disabled="purchasing || confirming || ccBlocked(ccGameTotalPrice)"
                  @click="buyCardCounter('game')"
                >
                  购买
                </button>
              </view>
            </view>

            <!-- 包时卡 -->
            <view
              v-if="ccPerHour !== null && ccPerHour > 0"
              class="game__cardcounter-card"
            >
              <view class="game__cardcounter-card-head">
                <text class="game__cardcounter-card-name">包时卡</text>
                <text class="game__cardcounter-card-desc">{{ ccPassText }}</text>
              </view>
              <view class="game__cardcounter-card-row">
                <text class="game__cardcounter-price">
                  {{ ccPerHour }}<text class="game__cardcounter-price-unit">金币</text>
                  <text class="game__cardcounter-price-suffix">/ 小时</text>
                </text>
                <view class="game__cardcounter-stepper">
                  <button
                    type="button"
                    class="btn btn--small game__cardcounter-step"
                    :disabled="purchasing || confirming || ccHourCount <= 1"
                    @click="stepHour(-1)"
                  >−</button>
                  <text class="game__cardcounter-step-val">{{ ccHourCount }}</text>
                  <button
                    type="button"
                    class="btn btn--small game__cardcounter-step"
                    :disabled="purchasing || confirming || ccHourCount >= CC_HOUR_MAX"
                    @click="stepHour(1)"
                  >+</button>
                </view>
                <button
                  type="button"
                  class="btn btn--primary btn--small game__cardcounter-buy"
                  :disabled="purchasing || confirming || ccBlocked(ccHourTotalPrice)"
                  @click="buyCardCounter('hour')"
                >
                  购买
                </button>
              </view>
            </view>

            <view v-if="ccBlockWarning || ccStatusFailed" class="game__cardcounter-notice">
              <text v-if="ccBlockWarning" class="game__hint">{{ ccBlockWarning }}</text>
              <text v-if="ccStatusFailed" class="game__hint">权益信息加载失败（不影响购买）</text>
            </view>
          </template>
          <!-- 购买错误已迁入浮层 `cc-error`（Task 9）：z=15 高于本弹层 ⇒ 弹层打开时
               提示可见且不挤压面板；入口圆点仍由 `ccAttention`（ccError）驱动。 -->
        </view>
      </view>
    </view>

    <!-- 提示浮层（Task 9）：本地项 + 会话提示 + 连接死态都在这里，不占玩法页文档流。 -->
    <template #overlay>
      <NoticeStack :items="noticeItems" surface="game" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
@import "../../styles/animations.scss";
/**
 * 开始游戏页（片② 客户端）：顶栏 + 中央 + 左下信息条 + 好友房弹层。
 *
 * ⚠️ 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义**）。
 * ⚠️ 视觉语言**照抄总规格 §5.2.1**（半透明深蓝面板 / 金主按钮 / 分段·选中控件…）。
 * ⚠️ **锚点一个不改**：`.game__match .btn`（探针的锚点）· `.game__create-room` ·
 *    `.game__join input` · `.game__item` · `.game__rooms-head .btn`。
 */
.game {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  width: 100%;
  height: 100%;
  padding: $ftl-space-2 $ftl-space-5;
}
.game__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-5;
  min-height: $ftl-bar-h;
}
/**
 * ⚠️ **走查修复（片③ Task 6）**：`uni-button` 基样式带 `margin-left/right: auto`
 * （与 `login.vue` 是**同一个坑**：H5 上 `<button>` 编译成 `uni-button`）——
 * 在**有富余宽度**的 flex 行里这两个 auto 会把按钮**顶到中间**。
 * 实测（真浏览器，布局 px）：`.game__bar .btn` 的 `margin = 531px 531px` ⇒ 顶栏渲染成
 * 「返回大厅**居中** · 玩法名贴右」，而**本页的意图**是「返回大厅在左、玩法名跟着」
 * （`.game__bar` 是普通 flex 行，没有 `justify-content`）。
 * 本仓的既有形态是「按钮放进**内容宽**的组里」让 auto 自然失效（`table.vue` 的 `.table__bar-left`）；
 * 本页顶栏只有两个元素 ⇒ 直接压掉 auto 边距，回到左对齐。
 * ⚠️ 这是**观感类**修复（`mount()` 看不见样式）⇒ 证明方式是**产物 CSS + 真浏览器截图**，
 * **不写机械判据**（全局约束 8）。
 */
.game__bar .btn {
  margin: 0;
}
/** 玩法名（R752）：从 store 读，**不写死字面量**。 */
.game__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 600;
  line-height: 1.2;
}
/** 中央区：场次名 + 底分 + 开始游戏 + 好友房，整块居中。 */
.game__stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-6;
  min-height: 0;
}
/** 场次名 + 底分：**半透明深蓝面板**托住（§5.2.1 的第一条定格值；也是可读性需要）。 */
.game__scene {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-3;
  padding: $ftl-space-6 $ftl-space-9;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
/** 人数分段（跑得快 2 人场；仅 >1 个可选人数时渲染）。 */
.game__players {
  display: flex;
  gap: $ftl-space-3;
}
.game__player-option {
  padding: $ftl-space-2 $ftl-space-5;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night, 0.62);
  color: $ftl-color-text-muted;
  font-size: $ftl-font-sm;
  line-height: 1.2;
}
.game__player-option--active {
  border-color: $ftl-color-gold-deep;
  background: rgba($ftl-color-night-deep, 0.85);
  color: $ftl-color-gold-light;
}
/**
 * 中央大标题：白字 + **多层 `text-shadow`** 深色描边（§5.2.1 定稿的排版手法）。
 * ⚠️ 不用 `-webkit-text-stroke`（多端表现不一致，样板实测后未采用）。
 */
.game__scene-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-xxl;
  font-weight: 700;
  line-height: 1.2;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.game__scene-base {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-lg;
  line-height: 1.2;
}
/**
 * 匹配动作区：**纵排**（走查修复）——横排时「正在匹配…」长文案与「取消匹配」按钮
 * 在同一行挤位/重叠。纵排后文案一行、按钮整宽，拇指区也更大。
 */
.game__match {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  align-items: stretch;
  width: 320px;
}
.game__match .btn {
  margin: 0;
}
.game__matching {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-md;
  line-height: 1.4;
  text-align: center;
}
/** 等待动效的三个跳点（动效定义在 animations.scss，降级时静态显示「•••」，仍然可见）。 */
.game__matching-dots {
  display: inline-block;
  margin: 0 $ftl-space-2;
}
.game__matching-dot {
  display: inline-block;
  font-size: $ftl-font-lg;
  line-height: 1;
}
/** 匹配用时秒表（递增）：颜色/字号继承父级 `.game__matching`（与「正在匹配」同款），只留间距。 */
.game__matching-elapsed {
  display: inline-block;
  margin-left: $ftl-space-3;
}
/** 未选底分时的说明（按钮禁用 + 这里说**为什么** —— 本仓忌讳「点了没反应的活按钮」）。 */
.game__hint {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/**
 * 缺人等待提示：底部悬浮卡片（不参与文档流；与 `.game__notice` 同族的悬浮手法）。
 * ⚠️ 定位上下文是 `.canvas`（`.game` 是 static）；不得给 `.game` 加 position/transform。
 * ⚠️ 全宽层 pointer-events:none，卡片自身 auto —— 空白区不拦截下层点击。
 * ⚠️ bottom = 56 + 16：卡片底边落在玩家信息条上方约 12px，顶边在「取消匹配」下方约 8px。
 * ⚠️ 按钮必须显式 `line-height: 1.2`：H5/微信的 `uni-button` 基样式是
 *    `line-height: 2.5555` ⇒ 26px 字号的行盒 66.4px，会顶掉 `min-height: 56`，
 *    卡片实际长高后压住「取消匹配」（代码审查 I1）。
 */
.game__waitprompt-layer {
  position: absolute;
  right: 0;
  bottom: calc($ftl-control-h-sm + $ftl-space-6);
  left: 0;
  z-index: 5;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.game__waitprompt {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 640px;
  max-width: calc(100% - 2 * $ftl-space-9);
  padding: $ftl-space-5 $ftl-space-7;
  border: $ftl-hairline solid rgba($ftl-color-gold-light, 0.55);
  border-radius: $ftl-radius-lg;
  background: linear-gradient(
    160deg,
    rgba($ftl-color-night-soft, 0.94),
    rgba($ftl-color-night-deep, 0.96)
  );
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.5),
    inset 0 2px 0 rgba(255, 215, 0, 0.18);
  backdrop-filter: blur(20px);
  pointer-events: auto;
}
.game__waitprompt-main {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-4;
}
.game__waitprompt-icon {
  flex: 0 0 auto;
  font-size: $ftl-font-xl;
  line-height: 1;
}
.game__waitprompt-text {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  line-height: 1.5;
  text-align: center;
}
.game__waitprompt-actions {
  display: flex;
  gap: $ftl-space-5;
}
.game__waitprompt-btn {
  flex: 1;
  margin: 0;
  /* uni-button 基样式 line-height:2.5555；不压回去会把 56px 的按钮撑到 70px。 */
  line-height: 1.2;
}
/** 匹配中：好友房入口禁用且被悬浮卡片压住 ⇒ 视觉隐藏但保留 88px 布局盒。 */
.game__friends-open--matching {
  visibility: hidden;
}
/** 左下：玩家信息条（与大厅顶栏同一个共用件）。 */
.game__player {
  align-self: flex-start;
}
/**
 * 好友房弹层：**全屏遮罩 + 居中面板**（规格 §4 裁决二）。
 * ⚠️ `z-index` 10 —— 弹层盖住页面其余部分；提示浮层（Stack，z=15）在它之上（Task 9）。
 */
.game__friends {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($ftl-color-night-deep, 0.62);
}
.game__friends-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  width: 640px;
  max-height: 100%;
  padding: $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.game__friends-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
}
.game__friends-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** 弹层里的按钮：**次按钮语言**（§5.2.1）。 */
.game__friends-close {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.game__friends .btn:not(.btn--primary) {
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.game__create,
.game__join {
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
}
.game__create .btn {
  flex: 1;
}
.game__join input {
  box-sizing: border-box;
  flex: 1;
  height: $ftl-control-h;
  padding: 0 $ftl-space-7;
  border: $ftl-hairline solid $ftl-color-border-control;
  border-radius: $ftl-radius-md;
  /* 输入框保持白底深字（§5.2.1：参考图 1 的浅色卡片语言） */
  background: $ftl-color-surface;
  color: $ftl-color-text;
  font-size: $ftl-font-lg;
  text-transform: uppercase;
}
.game__join .btn {
  flex: 0 0 auto;
}
.game__rooms-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $ftl-space-3;
}
.game__rooms-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 600;
  line-height: 1.2;
}
.game__list {
  display: block;
}
.game__item {
  font-size: $ftl-font-md;
}
.game__code {
  color: $ftl-color-text;
  font-weight: 600;
  letter-spacing: 2px;
}
.game__meta {
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.game__count {
  color: $ftl-color-text-muted;
}
/**
 * 空态（`wd-loadmore` 的 `finished` 态）。
 *
 * 🔴 **颜色必须穿透给内部的 `wd-divider`**（复核发现）：该组件在 `finished` 时渲染的是
 * `<wd-divider>{{ finishedText }}</wd-divider>`，而 `wd-divider` **自持**颜色
 * （`color: rgba(0, 0, 0, .45)`）⇒ 文字**不在** `.game__empty` 的继承链上。
 * 本页这行「暂无房间」压在**.game__friends-panel 的半透明深蓝面板**上 ⇒ 近黑字读不出来。
 * ⚠️ 诚实记账：同一行字今天也压在同色系的 `.stage` 底纹上（**不是本片引入的退化**），
 * 但 §5.2.1 要求面板内文字走 `on-primary` 系 —— 这是目前唯一一处没兑现的。
 * ⚠️ `:deep()` 在本仓已有先例（`table.vue` / `Card.vue`）。
 */
.game__empty {
  display: block;
  font-size: $ftl-font-sm;
}
.game__empty :deep(.wd-divider) {
  color: rgba($ftl-color-on-primary, 0.75);
}
/** Task 9：会话提示 / 连接死态 / 本地提示统一由 `NoticeStack` 浮层渲染（挂 overlay 槽），
    本页不再有 `.game__notice` 宿主样式（旧悬浮胶囊规则随 `SessionNotice` 摘除一并删除）。 */
.btn {
  @include ftl-btn;
  /* 2026-10 UI 重设计：次按钮（默认态）改成冷灰弱化风格 */
  border-color: rgba(160, 170, 190, 0.5);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(120, 130, 150, 0.35), rgba(80, 90, 110, 0.5));
  color: rgba($ftl-color-on-primary, 0.7);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 2px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  transition: transform 0.1s, box-shadow 0.1s, border-color 0.15s;
  background-image: none;
  &:hover {
    border-color: rgba(180, 190, 210, 0.7);
    color: rgba($ftl-color-on-primary, 0.85);
  }
  &:active {
    transform: translateY(2px);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.3);
  }
}
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 2px 0 rgba(255, 255, 255, 0.06);
}
/**
 * 主按钮：**金色 + 深金描边 + 白字**（总规格 §5.2.1 的定稿值）。
 *
 * ⚠️ **必须有一行 `background:`** —— 真实理由就是上面那条视觉语言本身：§5.2.1 逐字要求
 * 主按钮 = `background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字。
 * ⚠️ **如实记账**：本页的主按钮**没有机械闸盯着** —— `table-bid-bottom.test.ts` 的「主按钮自持」
 * 闸的扫描面逐字是 `f.path.startsWith('src/components/')`，`game.vue` **不在射程内**
 * ⇒ 删掉这一行**没有任何单测会红**（早前把「少了它会被该闸报出」当理由，是**错的归因**）。
 * ⚠️ **`background-image` 与 `background-size` 必须删掉**（§5.2.1 逐字）：原处的
 * `url($ftl-btn-plate-primary)` 贴图会**盖住金色**。
 * 2026-10 UI 重设计：新增拟物化立体阴影。
 */
.btn--primary {
  margin: 0;
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
  border-radius: $ftl-radius-md;
  box-shadow:
    0 6px 0 $ftl-color-gold-deep,
    0 8px 20px rgb(255 152 0 / 0.45),
    inset 0 2px 0 rgb(255 255 255 / 0.6),
    inset 0 -2px 0 rgb(0 0 0 / 0.1);
  transition: transform 0.1s, box-shadow 0.1s;
  background-image: none;
  &:hover {
    transform: translateY(-2px);
    box-shadow:
      0 8px 0 $ftl-color-gold-deep,
      0 12px 28px rgb(255 152 0 / 0.55),
      inset 0 2px 0 rgb(255 255 255 / 0.6);
  }
  &:active {
    transform: translateY(4px);
    box-shadow:
      0 2px 0 $ftl-color-gold-deep,
      0 4px 10px rgb(255 152 0 / 0.3),
      inset 0 3px 8px rgb(0 0 0 / 0.2);
  }
}
/** 好友房入口：**幽灵/弱化按钮**语言（§5.2.1）—— 透明底 + 虚线描边 + 浅白字。 */
.game__friends-open {
  flex: 0 0 auto;
  width: auto;
  margin: 0;
  border-style: dashed;
  border-color: rgba($ftl-color-on-primary, 0.45);
  background: transparent;
  background-image: none;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
}
.btn[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none !important;
  filter: grayscale(0.4);
}
/**
 * 记牌器购买弹层（2026-10-19 入口改造；2026-10-20 UI 美化）：
 *   全屏遮罩 + 居中面板，两购买项为独立卡片容器，金主 CTA。
 * ⚠️ z-index 10 与 `.game__friends` 同档（弹层盖住页面其余部分，含错误行）；
 *    两弹层靠遮罩互相遮挡、实际互斥。
 * ⚠️ 所有 class 锚点保留：`.game__cardcounter-mask` / `.game__cardcounter` /
 *    `.game__cardcounter-buy` / `.game__cardcounter-close` / `.game__cardcounter-dot`。
 */
.game__cardcounter-mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($ftl-color-night-deep, 0.62);
}
.game__cardcounter {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 560px;
  max-height: 100%;
  padding: $ftl-space-7 $ftl-space-7 $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.72);
}
/* —— 标题行 —— */
.game__cardcounter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.game__cardcounter-head-left {
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.game__cardcounter-icon {
  font-size: $ftl-font-lg;
  line-height: 1;
}
.game__cardcounter-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/**
 * 弹层里的「关闭 ×」：**次按钮语言**，图标化小按钮。
 * ⚠️ `margin: 0` 必需：`uni-button` 基样式带 `margin-left/right:auto`，
 *    在 `space-between` 的 flex 行里会吞掉富余宽度、按钮不贴右（本文件已登记同坑）。
 */
.game__cardcounter-close {
  flex: 0 0 auto;
  margin: 0;
  min-width: auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border-color: transparent;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night-soft, 0.6);
  background-image: none;
  color: rgba($ftl-color-on-primary, 0.8);
  font-size: $ftl-font-sm;
  font-weight: 700;
  line-height: 1;
}
.game__cardcounter-close:hover {
  background: rgba($ftl-color-night-soft, 0.9);
  color: $ftl-color-on-primary;
}

/* —— 入口提示点（顶栏按钮内） —— */
.game__cardcounter-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: $ftl-space-2;
  border-radius: 50%;
  background: $ftl-color-danger;
}

/* —— 免费提示（ccFree 分支） —— */
.game__cardcounter-line--free {
  text-align: center;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 600;
}

/* —— 商品卡片（两个购买选项） ——
 * 2026-10-21 布局重排：卡内改成「卡头（名称｜权益状态）＋ 操作行（单价｜stepper｜购买）」两行。
 * 原三列（info + stepper + 长文案按钮）在窄宽下会把 info 挤到一字一行；
 * 按钮收成「购买」后，数量与总价仍由 stepper 与确认框承载（确认框文案未变）。
 */
.game__cardcounter-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: $ftl-space-4;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid rgba($ftl-color-night-soft, 0.7);
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.35);
}
/* 卡头：名称在左、权益状态在右（baseline 对齐 —— 两者字号不同也不歪）。 */
.game__cardcounter-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: $ftl-space-3;
}
.game__cardcounter-card-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
}
.game__cardcounter-card-desc {
  color: rgba($ftl-color-on-primary, 0.65);
  font-size: $ftl-font-xs;
  line-height: 1.3;
  white-space: nowrap;
}
/* 操作行：单价撑满剩余宽度 ⇒ 两个商品的 stepper 与购买按钮天然右对齐。 */
.game__cardcounter-card-row {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
  min-width: 0;
}
/* 价格金色高亮（独占操作行左侧，窄宽下可换行 —— 不再有竖排挤压） */
.game__cardcounter-price {
  flex: 1 1 auto;
  min-width: 0;
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.1;
}
.game__cardcounter-price-unit {
  margin-left: $ftl-space-2;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 500;
}
.game__cardcounter-price-suffix {
  color: rgba($ftl-color-on-primary, 0.55);
  font-size: $ftl-font-xs;
  font-weight: 400;
}

/* Stepper：[-] N [+]，小号（44px 触控目标），与「购买」同一操作行 */
.game__cardcounter-stepper {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-3;
}
.game__cardcounter-step {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  padding: 0;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1;
}
.game__cardcounter-step-val {
  min-width: 32px;
  text-align: center;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1.2;
}

/* 购买按钮：金色主按钮；文案固定「购买」（数量在 stepper、总价在确认框） */
.game__cardcounter-buy {
  flex: 0 0 auto;
  width: auto;
  min-width: 112px;
  margin: 0;
}

/* —— 提示/错误区 —— */
.game__cardcounter-notice {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  padding-top: $ftl-space-3;
  border-top: $ftl-hairline solid rgba($ftl-color-night-soft, 0.5);
}
</style>
