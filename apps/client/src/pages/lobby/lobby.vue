<script setup lang="ts">
/**
 * 大厅（片② 客户端 · 片规格 §3 + ② 金币场 §14）：**顶栏 + 左玩法竖滚 + 右场次/底分**。
 *
 * 🔴 **本页只有五件事会离开大厅**：
 *   ① 点**底分卡** ⇒ 写选中底分 + `navigate('game')`（`enterLevel`；
 *     ② 起：**金币场且已判明余额不足**的档位不发跳页，就地出 14003 同形消息）；
 *   ② 点「退出」⇒ 登出（`onSignOut`）；
 *   ③ 点**头像** ⇒ 页内弹层 →「历史战绩」⇒ `uni.navigateTo('/pages/history/history')`
 *     （记录片 T8：子页**压栈**，`auth.page` 仍是 `lobby` —— 它**不是**四页投影之一）；
 *   ④ 点**金币显示处**（钱包区）⇒ `uni.navigateTo('/pages/wallet/wallet')`（支付片 T14；
 *     与历史页同族子页。金币视图从 `PlayerChip` 拆成 `part="coin"` 的**兄弟按钮**——
 *     「身份 ⇒ 玩家菜单」与「钱包 ⇒ 钱包页」是两件事，不能让一个嵌进另一个）；
 *   ⑤ 应用启动时读到 `?pay=<orderNo>`（支付回跳，§2.8）⇒ 写跨页载体 + **自动**压栈钱包页。
 *   而**点玩法卡只切换选中**（`selectMode`）、**点场次只切换选中**（`selectSession`），
 *   两者都**不跳页** —— 这是片规格 §3 裁决一 + ② §14 的同一形态。
 *
 * ② 金币场（本页新增的四件事，判据在 `lobby-modes` / `lobby-ux`）：
 *   - **余额 chip**（`GET /api/wallet/balance`；登录后进厅即拉、回厅重拉）；
 *   - **场次切换**（免费/金币，按开关渲染；双关空态 + 零张卡）；
 *   - **门槛提示**（金币场档位卡 `baseScore × entryMultiplier`，两个乘数都来自服务端）；
 *   - **领取救助**（广告片 T19 正片流程：`reliefEnabled` ∧ 余额 < `档位表最低档 × entryMultiplier`
 *     ∧ App 平台 ∧ `reliefAdpid` 非空 ⇒ 入口 → 预检签发 → 弹层 → 确认**续窗** →
 *     激励视频 → 携 claim 轮询到账；**发放的唯一入口 = 服务端广告回调链**，本页只查询与展示）。
 *
 * ⚠️ **这是行为变更**：片③ 起 `.lobby__mode` 的语义是「进入」（`enterMode` 直接跳页），
 * 现在改成「选中」。class 名一个不改（探针与用例的锚点），但**判据与探针都跟着改了**
 * —— 见计划的「判据改动记账」表。
 *
 * ⚠️ **开局区仍然不在本页**（片③ R749）：匹配 / 建房 / 房号加入 / 房间列表都在开始游戏页
 * ⇒ 本页**没有** `room.match` / `room.join` / `loadRooms`，「匹配只有一处实现」那条纪律
 * （R454/R658）继续由开始游戏页守；本页也**不消费**「再来一局」的意向（R760）。
 *
 * 🔴 **前端是哑终端**（`docs/design.md` §12）：底分**只能**来自服务端下发的档位表
 * （`GET /api/config` 的 `baseScoreLevels`）—— 本页**没有任何底分字面量**（M09）。
 * 拿不到档位表就**一张卡都不渲染**（用户无从选），绝不猜一个值。
 *
 * ⚠️ 片⑦：同一条响应还带 `friendRoomEnabled`（好友房入口的门控位）—— 本页只负责**写入**
 * store（入口渲染在开始游戏页 `game.vue`）；② 起响应共 **7 键**（档位表 + 四个门控位 +
 * 入场倍率 + version），一次写全（`store.setClientConfig`）。
 *
 * ⚠️ **共用件**：`PlayerChip.vue`（玩家信息条，两页同一份渲染）；本页所有提示
 * （本地失败/门槛/救助/更新 + 会话 + 连接死态）统一走 `NoticeStack.vue` 浮层
 * （挂在 `LandscapeStage` 的 `overlay` 槽）——两页都要显示的东西**不写两遍**。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { entryFeeOfLevel as feeOfLevel, type BaseScoreLevel } from "@fight-the-landlord/protocol";
import { useAuthStore } from "../../stores/auth";
import {
  useGameStore,
  type RoomMode,
} from "../../stores/game";
import {
  FAILSAFE_CLIENT_CONFIG,
  normalizeClientConfig,
  repairRoomMode,
} from "../../composables/useClientConfig";
import { usePageAlignment } from "../../composables/usePageAlignment";
import { useVersionCheck } from "../../composables/useVersionCheck";
import { stopGameSession } from "../../composables/useGameSession";
import * as rest from "../../net/rest";
import * as pay from "../../net/pay";
/**
 * 广告小片 T19：激励视频薄层（`net/ads.ts`）。渲染条件读 `isRewardedAdSupported()`
 * （非 App / 未知平台 ⇒ false ⇒ 入口不渲染，H5 隐藏）；发放**绝不**由它触发——
 * 它只回报 UX 结果，真正的到账由服务端回调链完成，本页用轮询确认。
 */
import { getLastRewardedAdErrorDetail, isRewardedAdSupported, playRewardedAd } from "../../net/ads";
import { dispatchRestFailure } from "../../net/errors";
/** Task 8：失败原因/踢出原因走统一玩家文案链（固定码不再透传服务端措辞）。 */
import { playerMessage } from "../../net/copy";
/** 传输拒绝的原始异常只进上报链（排查靠上报，不靠把 e.message 拼进玩家文案）。 */
import { reportError } from "../../observability/reporter";
import { loadAudioPrefs, playBgm, stopBgm } from "../../audio";
import { CUES } from "../../audio/cues";
/** 片①：横屏画布（R710）。 */
import LandscapeStage from "../../components/LandscapeStage.vue";
/**
 * 统一提示浮层（提示收敛 Task 8）：本地项 + session notice + 连接死态项一块渲染。
 * 本页不再挂 `SessionNotice`（已退役）——连接死态与 session 提示均由 Stack 内置承担。
 */
import NoticeStack from "../../components/NoticeStack.vue";
import { usePageNotices } from "../../composables/usePageNotices";
/** 玩家信息条共用件（本片新增）：大厅顶栏与开始游戏页左下是同一件事。 */
import PlayerChip from "../../components/PlayerChip.vue";
/** 玩法列表（片③ 单一真源）：大厅列出全部、开始游戏页查选中的那个 —— 两页读**同一个**数组。 */
import { GAME_MODES } from "../../gameModes";

const auth = useAuthStore();
/** 页面栈（Task 3）：挂载时对齐一次（`auth.page` 才是唯一真源）。 */
usePageAlignment('lobby');
const store = useGameStore();

/**
 * 提示收敛（Task 8）：本页提示不再占文档流，统一走 `NoticeStack` 浮层
 * （挂在 `LandscapeStage` 的 `overlay` 槽）。每个失败/状态面一个状态位 id：
 *  - `levels`：档位表加载失败（sticky + critical + 「重试」，成功时 dismiss）；
 *  - `entry`：门槛提示（warn，6s 自消；换场次时 dismiss）；
 *  - `relief`：救助过程/结果（面板外渲染点；层开着时同一条落在面板内）；
 *  - `update`：H5 发版提示（sticky + 「立即刷新」）。
 * 连接与会话提示由 Stack 内置承担（`connection-dead` / `session-notice`）。
 */
const notices = usePageNotices();
const { items: noticeItems } = notices;

/** 项 9：H5 发版更新提示（模块单例；非 H5 恒 false）。 */
const { updateAvailable } = useVersionCheck();
function reloadApp(): void {
  // 只在 H5 有 location；typeof 守卫让小程序/App 构建不碰 window 全局。
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { location?: { reload: () => void } }).location
      ?.reload === "function"
  ) {
    (globalThis as { location: { reload: () => void } }).location.reload();
  }
}

/**
 * 版本更新提示（Task 8 起浮层化）：sticky + critical（不被容量淘汰）+ 可手动关闭，
 * 动作「立即刷新」。`immediate`：模块单例在挂载前就可能已置位（先访问过别的页面）。
 */
watch(
  updateAvailable,
  (available) => {
    if (available) {
      notices.setNotice("update", "发现新版本，刷新后即可体验", {
        level: "info",
        durationMs: 0,
        priority: "critical",
        dismissible: true,
        actions: [{ label: "立即刷新", kind: "primary", onClick: reloadApp }],
      });
    } else {
      notices.dismiss("update");
    }
  },
  { immediate: true },
);

/**
 * 档位表取不到的状态位（Task 8 起拆成两个**静态**控制位、不再装原因文案）：
 *  - `levelsFailed`：加载失败（含传输拒绝）⇒ 面板显示静态失败句；
 *  - `levelsEmpty`：服务端 code 0 但返回空表（如实照收，不猜一个底分）。
 * 具体原因与「重试」出口在浮层 `levels` 项 —— 关掉浮层后玩家仍能区分三种状态。
 *
 * ⚠️ 不再有「用户资料取不到」的第二条通道（Task 2R）：资料来自**登录响应**，
 * 由 `auth.applySession()` / `hydrate()` 写进 store —— 本页不再打取资料的接口。
 */
const levelsFailed = ref(false);
const levelsEmpty = ref(false);

/**
 * 档位表失败的**唯一**呈现（信封失败与传输拒绝共用）：静态失败位 + sticky 错误项。
 * sticky（`durationMs: 0`）+ `critical`：不被容量淘汰、不会自己消失 —— 它挡着
 * 「选底分」这条主路径，直到「重试」成功（成功分支 `dismiss('levels')`）。
 */
function setLevelsFailure(): void {
  levelsFailed.value = true;
  levelsEmpty.value = false;
  notices.setNotice("levels", "档位表加载失败，请稍后重试", {
    level: "error",
    durationMs: 0,
    priority: "critical",
    dismissible: true,
    actions: [{ label: "重试", onClick: () => void loadClientConfig() }],
  });
}

/**
 * 门槛提示（② §14）：点**已判明余额不足**的档位卡时走浮层 `entry` 项（warn，6s 自消）。
 *
 * ⚠️ 文案与服务端 14003 的 `message` 逐字同形（`room-service` 的
 * `金币不足：该场次需要 ≥ ${needed}`）：这条是**本地已知事实**的就地展示（余额与门槛
 * 都在手上），**不替代**服务端的 14003 —— 真正发匹配时若仍不足，服务端那条 TOAST
 * （直接展示服务端 message，§10）才是权威。
 */


/**
 * **场次选项**（② §14：按开关渲染）：大厅只渲染**开着**的场次；两个都关 ⇒ 空态。
 * 标签逐字：「免费场」/「金币场」（探针与用例的锚点文案）。
 */
const SESSION_LABEL: Record<RoomMode, string> = {
  random: "免费场",
  gold: "金币场",
};
const sessionOptions = computed<{ mode: RoomMode; label: string }[]>(() => {
  const options: { mode: RoomMode; label: string }[] = [];
  if (store.freeRoomEnabled)
    options.push({ mode: "random", label: SESSION_LABEL.random });
  if (store.goldRoomEnabled)
    options.push({ mode: "gold", label: SESSION_LABEL.gold });
  return options;
});

/** 点场次 = **只切换选中**（写 store，开始游戏页的 `room.match` 读它）。**不跳页**。 */
function selectSession(mode: RoomMode) {
  store.setRoomMode(mode);
  // 换场次 ⇒ 上一次的门槛提示作废（它说的是另一场的门槛）
  notices.dismiss('entry');
}

/**
 * 场次可用性修复见 `useClientConfig.ts#repairRoomMode`（P1-12 起与开始游戏页的价格刷新
 * 共用同一份实现 —— 两处各写一份就迟早漂移）。
 */

/** S5.4：只展示服务端开启的玩法（旧服务端无 `games` ⇒ 只有斗地主）。 */
const visibleModes = computed(() => GAME_MODES.filter((m) => store.modeEnabled(m.id)));

/**
 * 点玩法卡 = **只切换选中**（片规格 §3 裁决一）。**不跳页**。
 *
 * S5.4：切换后若当前底分不在新玩法档位表里 ⇒ 回落到第一档（不猜、不沿用别的玩法的档位）。
 */
function selectMode(id: string) {
  store.setActiveMode(id);
  const levels = store.activeLevels;
  if (
    store.selectedBaseScore === null ||
    !levels.some((l) => l.baseScore === store.selectedBaseScore)
  ) {
    store.setSelectedBaseScore(levels[0]?.baseScore ?? null);
  }
  levelsEmpty.value = levels.length === 0;
}

/**
 * 配置到达后修复当前玩法：服务端把当前玩法关掉 ⇒ 切到第一个可见玩法
 * （并同样修复底分选中）。全部关闭 ⇒ 保持原值（空态不渲染任何入口）。
 */
function repairActiveMode() {
  const modes = visibleModes.value;
  if (modes.length === 0) return;
  if (!store.modeEnabled(store.activeMode)) {
    store.setActiveMode(modes[0]!.id);
    const levels = store.activeLevels;
    if (
      store.selectedBaseScore === null ||
      !levels.some((l) => l.baseScore === store.selectedBaseScore)
    ) {
      store.setSelectedBaseScore(levels[0]?.baseScore ?? null);
    }
  }
}

/**
 * 某档位的**金币门槛**（② §14：金币档位卡阈值提示 `baseScore × entryMultiplier`）。
 *
 *  - 免费场（当前场次不是金币场）⇒ `null`（不提示 —— 免费场没有门槛）；
 *  - 金币场且倍率已知 ⇒ `baseScore × entryMultiplier`（**两个乘数都来自服务端** ——
 *    底分来自档位表、倍率来自配置，本页**没有任何门槛字面量**，`source-boundary` 盯着）；
 *  - 倍率未知（缺键/没取到）⇒ `null` ⇒ **不提示**（§2.4；服务端仍是权威）。
 */
function thresholdOf(baseScore: number): number | null {
  return store.roomMode === "gold" ? store.goldThreshold(baseScore) : null;
}

/**
 * 台费「入场费」：金币场且该档 `entryFeeOfLevel(lv) > 0` ⇒ 返回金额；
 * 其余（免费场 / percent=0 / 缺字段 / 空表）⇒ `null` ⇒ **整行不渲染**（不阻塞入场）。
 *
 * ⚠️ 金额**只**由 `entryFeeOfLevel` 算（protocol 纯函数——客户端=服务端**同一实现**）；
 * 与门槛行同款：金币场专属显示（免费场不收台费，不渲染是如实）。
 */
function ticketOfLevel(lv: BaseScoreLevel): number | null {
  if (store.roomMode !== "gold") return null;
  const fee = feeOfLevel(lv);
  return fee > 0 ? fee : null;
}

/**
 * 「该档位**已判明进不去**」的**唯一实现**（② §14：余额不足置灰）：进不去 ⇒ 返回
 * **所需金额**（置灰与消息两个消费点都要它）；其余 ⇒ `null`。
 *
 * 三个前提全成立才算「判明」：场次是金币场、倍率已知、余额已知且低于门槛。
 * 任何一项未知 ⇒ 不判（服务端 14003 仍是权威，客户端不猜）。
 */
function lockedNeed(baseScore: number): number | null {
  const needed = thresholdOf(baseScore);
  if (
    needed === null ||
    store.walletBalance === null ||
    store.walletBalance >= needed
  )
    return null;
  return needed;
}

/** 置灰（渲染用）：与点击拦截读**同一个出口**，两者不可能不一致。 */
function isLocked(baseScore: number): boolean {
  return lockedNeed(baseScore) !== null;
}

/**
 * 点底分卡 = 写选中底分 + 进开始游戏页。
 *
 * ⚠️ **顺序不可反**：`navigate` 会同步 `uni.reLaunch`，开始游戏页挂载时就要能读到
 * 选中值（与 `requestRematch()` / `setActiveMode` 同一纪律）。
 *
 * ② 金币场：**已判明余额不足的档位**不发跳页，就地给出门槛消息（浮层 `entry` 项）——
 * 与「置灰」是同一判定的两个面。未判明 ⇒ 照常进页，由服务端在 `room.match` 时用
 * 14003 兜底（TOAST 直接展示服务端 message）。
 */
function enterLevel(baseScore: number) {
  const need = lockedNeed(baseScore);
  if (need !== null) {
    notices.setNotice('entry', `金币不足：该场次需要 ≥ ${need}`, { level: 'warn' });
    return;
  }
  store.setSelectedBaseScore(baseScore);
  auth.navigate("game");
}

/**
 * 取**客户端配置**（`GET /api/config`，片规格 §2.3 的接口；**每次挂载取一次**，服务端侧不缓存）。
 *
 * R34：非 0 的码一律经 `dispatchRestFailure` 查 `CLIENT_ACTION` 表后执行 ——
 * `BACK_TO_LOBBY`（`10002`/`10005`/`10004`）**先销毁本地 WS 会话**（R36）再清本地会话
 * 回登录页；`TOAST` 提示；`REFRESH_SNAPSHOT`/`RECONNECT` 在 REST 语境下退化为「重放一次」。
 * `replayed` 保证重放**最多一次**，不循环。
 *
 * ⚠️ **失败一律写 fail-safe 配置**（`FAILSAFE_CLIENT_CONFIG`：空表 + 各闸按 fail-safe 语义，
 * 金币场随 2026-10-04 用户裁决按开）：
 * 空数组的含义是「没取到」，页面据此不渲染任何卡 —— 这是「**不猜一个底分**」（M09）
 * 在用户能看见的那一步上的形态；免费场/好友房/救助写回 `false` 是 C19/§2.4 在**故障期**
 * 的形态（不是只写空表、留着上一次的 `true`）。
 *
 * Task 8：失败原因**不拼进玩家文案**（统一「档位表加载失败，请稍后重试」+ 浮层
 * `levels` 项带「重试」）；原始异常/服务端细节只进上报链与既有日志。
 *
 * ② 金币场：成功路径先过 `normalizeClientConfig`（**缺键语义**，§2.4）再落 store ——
 * 服务端旧版少键时免费场/金币场仍按「开」等；落 store 后做一次**场次可用性修复**。
 */
async function loadClientConfig(replayed = false) {
  try {
    const res = await rest.fetchClientConfig();
    if (res.code === 0) {
      /**
       * ⚠️ **成功** = 服务端说什么写什么（哑终端，含空表响应 —— 如实照收），
       * **缺键**才补缺省（§2.4 的归一化；`data` 整个缺失 = 违约响应 ⇒ 与失败同一处置）。
       */
      const cfg =
        res.data == null
          ? FAILSAFE_CLIENT_CONFIG
          : normalizeClientConfig(res.data);
      store.setClientConfig(cfg);
      // P1-10：`data === null` 是违约响应 —— 与失败同一处置（配置未知，不是「服务端说关」）。
      if (res.data == null) store.markClientConfigFailsafe();
      repairRoomMode();
      // S5.4：当前玩法若被服务端关闭 ⇒ 切到第一个可见玩法（并修复底分选中）
      repairActiveMode();
      levelsEmpty.value = store.activeLevels.length === 0;
      levelsFailed.value = false;
      notices.dismiss("levels");
      return;
    }
    store.setClientConfig(FAILSAFE_CLIENT_CONFIG);
    // P1-10：失败路径的 `cardCounterEnabled=false` 是「未知」不是「关」——打标记供牌桌区分。
    store.markClientConfigFailsafe();
    repairActiveMode();
    levelsEmpty.value = store.activeLevels.length === 0;
    setLevelsFailure();
    await dispatchRestFailure(res, {
      // 静态失败位 + sticky 项已在上面给出；服务端 message 不拼进玩家文案。
      toast: () => {},
      // R34/R36：BACK_TO_LOBBY → 先销毁本地 WS 会话，再带原因清本地认证状态回登录页。
      // 令牌已不可用，**不**调服务端登出（它也会返回同样的码）。
      signOutLocally: (report) => {
        stopGameSession();
        auth.sessionEnded(playerMessage(report.code, { context: "auth" }));
      },
      replay: () => (replayed ? Promise.resolve() : loadClientConfig(true)),
    });
  } catch (e) {
    /**
     * ⚠️ **H5 上 `fetch` 的拒绝会抛出**（`src/net/rest.ts:76-78` 记着这条传播行为）⇒
     * 少了这一支，网络故障（离线 / DNS / 连接被拒）会在挂载那一刻静默收场，只剩一个
     * unhandled rejection（单测里表现为**整包退出码 1**，见 `login-layout.test.ts` 的头注释）。
     *
     * Task 8：与信封失败同一处置（静态失败位 + sticky 项）；原始异常只进上报链。
     */
    store.setClientConfig(FAILSAFE_CLIENT_CONFIG);
    store.markClientConfigFailsafe();
    repairActiveMode();
    levelsEmpty.value = store.activeLevels.length === 0;
    setLevelsFailure();
    reportError("lobby.loadClientConfig", e);
  }
}

/**
 * 取**钱包余额**（② §14：`GET /api/wallet/balance`；登录后进大厅即拉、**每次回厅重拉**）。
 *
 * 三个消费点共用 store 里这一份值：余额 chip / 金币档位的置灰 / 救助入口的点亮条件。
 * ⚠️ **失败一律写回 `null`（未知）** —— 与配置失败同一条 fail-safe 纪律：
 * chip 显「—」、救助不点亮、档位不置灰（服务端仍是权威）。**不额外弹提示**：
 * 这个失败的用户可见形态就是「—」，它不阻塞大厅的任何主路径；
 * `BACK_TO_LOBBY` 类仍照常经 `dispatchRestFailure` 清本地会话（R34/R36）。
 */
async function loadWalletBalance(replayed = false) {
  try {
    const res = await rest.fetchWalletBalance();
    if (res.code === 0) {
      const balance = res.data?.balance;
      store.setWalletBalance(typeof balance === "number" ? balance : null);
      return;
    }
    store.setWalletBalance(null);
    await dispatchRestFailure(res, {
      toast: () => {
        // 见上方注释：余额取不到 = chip 显「—」（fail-safe），不打断用户。
      },
      signOutLocally: (report) => {
        stopGameSession();
        auth.sessionEnded(playerMessage(report.code, { context: "auth" }));
      },
      replay: () => (replayed ? Promise.resolve() : loadWalletBalance(true)),
    });
  } catch {
    // H5 上 `fetch` 的拒绝会抛出（`rest.ts` 记着这条传播行为）⇒ 与信封失败同一处置。
    store.setWalletBalance(null);
  }
}

/* ------------------------------------------------------------------ *
 * 领取救助（② §14 + 广告小片 T19 正片流程）
 *
 * 规格 §2.9 逐字：点击 ⇒ `getRelief()`（签发/复用）→ 可领 ⇒ 弹层 →
 * 确认 ⇒ `getRelief()`（**续窗**）→ `playRewardedAd(adpid, { extra: claim })` →
 * `completed` ⇒ 携 claim 轮询 `getRelief(claim)`（2s×3，终态即止）。
 *
 * 🔴 **发放的唯一入口 = 服务端广告回调链**（广告片 T14）：本页**从不**发放，
 * 只查询与展示。弹层里的这次观看算不算数由服务端回调（验签 + claim 绑定）独立裁决
 * ——「看完」与「到账」是两条时间线，中间那段等待就是下面的轮询窗。
 * ------------------------------------------------------------------ */

/**
 * 救助确认弹层是否展开（与玩家菜单同款裁决：**弹层不是路由**；关着时整棵子树不在 DOM 里）。
 */
const reliefOpen = ref(false);

/**
 * 结果 / 过程的一行提示。**客户端本地文案逐字**（规格冻结表）：`完整观看才能领取` /
 * `暂时没有可播放的广告，稍后再试` / `发放可能稍有延迟，稍后回到本页查看` /
 * `已领取救助 +N` / `网络异常，请重试`；不可领 / 终态拒绝面显示**服务端 reason**（§10）。
 *
 * 渲染点**两处互斥**（同一个状态、由 `reliefOpen` 二选一）：层开着 ⇒ 面板内
 * （`.lobby__relief-note`）；关着 ⇒ 浮层 `relief` 项（Task 8 起不再是文档流行）——
 * 不存在「该看的字被层吃掉」，也不会两处同时显示。
 */
const reliefNote = ref("");

/**
 * 面板外渲染点（Task 8）：联合 watch 由状态推导浮层项 —— 层关着且有文案才显示；
 * 层开着 / 文案清空 ⇒ `dismiss`（关层的成功面「已领取救助 +N」走 3s 成功态）。
 * 级别映射：成功（`已领取救助` 前缀）success、网络异常 error、其余（reason / 过程
 * 提示）warn —— 都是「一条状态说明」，不是错误码路径。
 */
watch(
  [reliefNote, reliefOpen],
  ([note, open]) => {
    if (note !== "" && !open) {
      const level = note.startsWith("已领取救助")
        ? "success"
        : note === "网络异常，请重试"
          ? "error"
          : "warn";
      notices.setNotice("relief", note, {
        level,
        durationMs: level === "success" ? 3000 : 6000,
      });
    } else {
      notices.dismiss("relief");
    }
  },
  { immediate: true },
);

/**
 * 观看流程进行中（确认 ⇒ 续窗 ⇒ 播放 ⇒ 轮询收口）：确认按钮据此**防双击**
 * （第二发会造出第二个广告实例）、并保持 `:disabled` 的可见反馈。
 * 复位点：流程端点（失败/不可领/四结果/轮询终点）与关层（`closeRelief`）。
 */
const reliefBusy = ref(false);

/** 轮询节奏（规格 §2.9 逐字：2s × 3；终态即止）。口径同 `wallet.vue`：首查立即 + 每 2s 一发。 */
const RELIEF_POLL_INTERVAL_MS = 2000;
const RELIEF_POLL_MAX = 3;

let reliefTimer: ReturnType<typeof setInterval> | null = null;
let reliefPolls = 0;
/** 本窗轮询的凭证（`completed` 后由**续窗那一发**的 claim 绑定；关层即作废）。 */
let reliefPollClaim: string | null = null;
/** 上一发轮询未回（慢网）⇒ 本次 tick 跳过（不并发叠发；同 `wallet.vue` 的 in-flight 纪律）。 */
let reliefPollInFlight = false;

function stopReliefPolling() {
  if (reliefTimer !== null) {
    clearInterval(reliefTimer);
    reliefTimer = null;
  }
}

/**
 * 关层（取消 / 关闭 / 遮罩）：本次观看流程随层结束 —— 轮询停表、busy 复位。
 * ⚠️ 已在路上的那一发响应仍会落定（若恰好是成功面，用户会从面板外那行看到
 * 「已领取救助 +N」——钱是服务端记的，不受本地层开合影响）；停表只拦**后续**发。
 */
function closeRelief() {
  reliefOpen.value = false;
  stopReliefPolling();
  reliefPollClaim = null;
  reliefBusy.value = false;
}

/**
 * 无 claim 的裁决 GET（`GET /api/wallet/relief`）——点击预检与确认续窗**同一条路径**
 * （服务端次序：已发 ⇒ 开关 ⇒ 余额 ⇒ 签发/复用；`rest.getRelief` 头注）。
 *
 * 返回 claim ⇔ 服务端说 `eligible:true` 且给了**非空** claim；其余一律 `null` 且
 * `reliefNote` 已写：
 *  - 传输拒绝（H5 上 `fetch` 会抛出，`rest.ts` 记着这条传播行为）/ 非 0 信封
 *    ⇒「网络异常，请重试」（动作类处置仍经 `dispatchRestFailure`：BACK_TO_LOBBY 清本地会话；
 *    REFRESH_SNAPSHOT/RECONNECT 在 REST 语境退化为**重放一次**——重放成功时它的 claim 照常回传）；
 *  - 不可领 ⇒ **服务端 reason** 逐字（四条文案都由服务端给，客户端不另写）；
 *  - 契约违约（eligible 却无 claim / `data` 缺失）⇒「网络异常，请重试」（不编一个状态）。
 */
async function queryReliefClaim(replayed = false): Promise<string | null> {
  let res: rest.RestResponse<rest.ReliefQueryData>;
  try {
    res = await rest.getRelief();
  } catch {
    reliefNote.value = "网络异常，请重试";
    return null;
  }
  if (res.code === 0) {
    const data = res.data;
    if (data?.eligible === true && typeof data.claim === "string" && data.claim !== "") {
      return data.claim;
    }
    reliefNote.value = data?.reason ?? "网络异常，请重试";
    return null;
  }
  // 非 0：查表处置；重放分支的返回值必须接住（否则重放成功会「拿到 claim 又丢」）。
  let replayedClaim: string | null = null;
  await dispatchRestFailure(res, {
    toast: () => {
      reliefNote.value = "网络异常，请重试";
    },
    signOutLocally: (report) => {
      stopGameSession();
      auth.sessionEnded(playerMessage(report.code, { context: "auth" }));
    },
    replay: async () => {
      replayedClaim = replayed ? null : await queryReliefClaim(true);
    },
  });
  return replayedClaim;
}

/**
 * 点击「领取救助」（规格 §2.9 第一步）：先 `getRelief()` 预检（签发/复用 claim）——
 *  - 可领 ⇒ 开层（claim **不在**这里留存：确认时的续窗 GET 才是唯一可信来源，规格 §2 的窗口时点）；
 *  - 不可领 ⇒ 服务端 reason 落提示行、**不开层**；
 *  - 失败 ⇒「网络异常，请重试」、不开层。
 */
async function openRelief(): Promise<void> {
  if (reliefBusy.value) return;
  stopReliefPolling(); // 上一窗的残留（重开层前的保险；正常路径关层已停表）
  reliefNote.value = "";
  if ((await queryReliefClaim()) === null) return;
  reliefOpen.value = true;
}

/**
 * 弹层「确认领取」（规格 §2.9 逐字）：续窗 ⇒ 播放 ⇒（看完后）轮询到账。
 *
 * **续窗**：点击与确认之间可能隔了任意久（凭证窗 900s）⇒ 用**新的一发**裁决 GET
 * （find-or-create 复用同 nonce 并续期）拿 claim 再播，**绝不**用点击那一刻的旧值。
 * 播放四结果的分支（`net/ads.ts` 的契约）：
 *  - `completed` ⇒ 走向轮询（发放由服务端回调链独立完成）；
 *  - `closed` ⇒「完整观看才能领取」（不轮询、不发放）；
 *  - `unavailable` / `error` ⇒「暂时没有可播放的广告，稍后再试」
 *    （两出口同文案＝规格冻结后的**补充登记**：用户视角均为「播不出来」，均不发放、不轮询）。
 *
 * ⚠️ `reliefOpen` 兼作**流程存活判据**：关层事件与续窗/播放的 await 交错的窄窗里，
 * 幸存分支必须在每个检查点先确认「层还开着」再继续（否则会出现「点了取消却在播广告」）。
 */
async function confirmRelief(): Promise<void> {
  if (reliefBusy.value) return;
  reliefBusy.value = true;
  reliefNote.value = "";
  const claim = await queryReliefClaim(); // 续窗（失败/不可领 ⇒ note 已写）
  if (claim === null || !reliefOpen.value) {
    reliefBusy.value = false;
    return;
  }
  const outcome = await playRewardedAd(store.reliefAdpid, { extra: claim });
  if (outcome === "completed") {
    if (!reliefOpen.value) {
      reliefBusy.value = false;
      return;
    }
    startReliefPolling(claim); // busy 交由轮询端点复位（窗内保持 :disabled）
    return;
  }
  if (outcome === "closed") {
    reliefNote.value = "完整观看才能领取";
  } else {
    // 诊断构建（`VITE_AD_DIAG=1`）把广告 SDK 的错误码/消息附在通用文案后 —— 真机排障用；
    // **生产构建不带后缀**（`VITE_AD_DIAG` 未设 ⇒ 冻结文案逐字不变）。
    const adErrorDetail =
      import.meta.env.VITE_AD_DIAG === "1" ? getLastRewardedAdErrorDetail() : "";
    reliefNote.value = adErrorDetail
      ? `暂时没有可播放的广告，稍后再试（${adErrorDetail}）`
      : "暂时没有可播放的广告，稍后再试";
  }
  reliefBusy.value = false;
}

/**
 * 开一轮到账轮询（`completed` 之后）：首查立即，随后每 2s 一发，合计 `RELIEF_POLL_MAX` 发
 * （「2s×3」口径同 `wallet.vue` 的「3s×10 = 首查 + 9 次定时」）；**终态即止**；
 * 纯 pending 满窗 ⇒「发放可能稍有延迟，稍后回到本页查看」。
 */
function startReliefPolling(claim: string) {
  stopReliefPolling();
  reliefPollClaim = claim;
  reliefPolls = 0;
  void pollReliefClaim(); // 首查立即（t=0）
  reliefTimer = setInterval(() => {
    void pollReliefClaim();
  }, RELIEF_POLL_INTERVAL_MS);
}

/**
 * 轮询一发（携 claim 的**只读** GET；不签发、不续期——查询本身不改变服务端任何状态）。
 *
 * 三出口（服务端五态到客户端的映射，`rest.getRelief` 头注）：
 *  - `grantedToday:true`（granted/replayed 同处置；账本已真）⇒ 成功面：关层 +
 *    `setWalletBalance(balance)` + 「已领取救助 +N」，停表；
 *  - `reason` 在场（终态拒绝 disabled/balance_ok 或失效 claim_invalid）⇒ 显示服务端 reason 并止；
 *  - 其余（issued pending / 契约畸形）⇒ 继续等下一个 tick；满窗 ⇒「稍后回看」。
 * 查询失败与传输拒绝**不打断**轮询（网络抖动是暂时的；动作类处置仍经 `dispatchRestFailure`）。
 * 慢网：上一发未回 ⇒ 本 tick 跳过（不并发叠发）。
 */
async function pollReliefClaim(replayed = false): Promise<void> {
  const claim = reliefPollClaim;
  if (claim === null) {
    stopReliefPolling();
    return;
  }
  if (reliefPollInFlight) return;
  if (reliefPolls >= RELIEF_POLL_MAX) {
    stopReliefPolling();
    reliefBusy.value = false;
    reliefNote.value = "发放可能稍有延迟，稍后回到本页查看";
    return;
  }
  reliefPolls += 1;
  reliefPollInFlight = true;
  let res: rest.RestResponse<rest.ReliefQueryData>;
  try {
    res = await rest.getRelief(claim);
  } catch {
    // 传输拒绝（H5 fetch）：本发不判终态，等下一个 tick；窗尾统一给「稍后回看」。
    return; // finally 清 in-flight
  } finally {
    reliefPollInFlight = false;
  }
  if (res.code === 0) {
    const data = res.data;
    if (data && data.grantedToday === true) {
      // 成功面：关层 + 刷 chip + 「已领取救助 +N」（N = 服务端给的 amount）。
      stopReliefPolling();
      reliefOpen.value = false;
      reliefBusy.value = false;
      store.setWalletBalance(data.balance);
      reliefNote.value = `已领取救助 +${data.amount}`;
      return;
    }
    if (data && typeof data.reason === "string" && data.reason !== "") {
      // 终态拒绝 / 失效：服务端 reason 逐字显示并止（层留着——用户看一眼再自己关）。
      stopReliefPolling();
      reliefBusy.value = false;
      reliefNote.value = data.reason;
      return;
    }
    // issued pending（eligible:true）：继续等下一个 tick（尾部的满窗检查决定是否收口）。
  } else {
    await dispatchRestFailure(res, {
      // 轮询期的网络抖动不打断轮询（窗尾统一给「稍后回看」）——动作类处置照表执行。
      toast: () => {},
      signOutLocally: (report) => {
        stopReliefPolling();
        reliefBusy.value = false;
        stopGameSession();
        auth.sessionEnded(playerMessage(report.code, { context: "auth" }));
      },
      replay: () => (replayed ? Promise.resolve() : pollReliefClaim(true)),
    });
  }
  // 窗耗尽且未终态 ⇒ 停表 +「发放可能稍有延迟，稍后回到本页查看」（不等下一次 tick）。
  if (reliefTimer !== null && reliefPolls >= RELIEF_POLL_MAX) {
    stopReliefPolling();
    reliefBusy.value = false;
    reliefNote.value = "发放可能稍有延迟，稍后回到本页查看";
  }
}

/**
 * 玩家菜单（页内弹层）是否展开。
 *
 * ⚠️ **弹层不是路由**：页面栈的唯一真源仍是 `auth.page`（`game.vue` 的好友房同款裁决）。
 * 关着时整棵子树不在 DOM 里（`v-if`）——那是「收进弹层」的可证伪语义。
 */
const playerMenuOpen = ref(false);

/**
 * 玩家菜单条目（**列表结构** —— 现在 1 项；将来加「设置」只加数据、不改结构）。
 *
 * `url` 是子页目标：`/pages/history/history` 在 `pages.json` **同提交注册**（规格 §1 F1，
 * 否则真机导航失败）；`test/history-records.test.ts` 把「点击目标」与「声明」钉在一起。
 * 目标页用 `uni.navigateTo`（**压栈**）而不是 `reLaunch`：本项目的「一步一页」投影
 * （`router.ts`）只管 `auth.page` 四页；历史页是**子页**，进来时 `auth.page` 仍是 `lobby`。
 */
const PLAYER_MENU = [
  { id: "history", label: "历史战绩", url: "/pages/history/history" },
] as const;

function openMenuItem(item: (typeof PLAYER_MENU)[number]) {
  // 先收起弹层再导航：回来时大厅不挂着一层「点过的」菜单。
  playerMenuOpen.value = false;
  uni.navigateTo({ url: item.url });
}

/**
 * 支付片 T14：**钱包入口**（规格 §4：「大厅钱包区（`lobby.vue` 金币显示处）点击 ⇒ 跳钱包页」）。
 *
 * `wallet-entry` 钩子挂在金币视图的按钮上（`PlayerChip part="coin"`）——「点了金币显示处
 * 打开的是玩家菜单而不是钱包页」是这条需求最像正确答案的错实现，所以两个按钮必须是
 * **兄弟**（身份 ⇔ 菜单、金币 ⇔ 钱包），不能嵌套。
 *
 * 入口可见性（规格 §4 括号逐字复核）：「两开关全关**且页面无内容** ⇒ 入口隐藏」——
 * 当前页面结构下**恒可见**：余额区与记录区**不随**开关隐藏（各有自己的空态），钱包页
 * 永远有内容 ⇒ 第二合取项恒假，「入口保留」是主句（暗上线期用户仍能看余额与记录）。
 * ⚠️ 若将来给余额区/记录区加门控（页面可能空），这个判定必须在这里显式化。
 */
function openWallet() {
  uni.navigateTo({ url: "/pages/wallet/wallet" });
}

/**
 * 支付回跳（T14 / §2.8）：应用启动读到 `?pay=<orderNo>` ⇒ 写跨页载体 + 压栈钱包页
 * （钱包页据此进订单详情并轮询）。消费是一次性的（`net/pay.ts` 从地址栏摘参）——
 * 「回大厅又被弹回钱包页」的环由摘参断掉。
 *
 * ⚠️ 只有**登录后**才会走到这里（大厅是登录态的页）；登出态落在登录页，登录后回大厅
 * 再消费（URL 参数还在——摘参只在真被消费时发生）。
 */
function consumePayReturn() {
  const orderNo = pay.consumePayReturnOrderNo();
  if (orderNo === null) return;
  store.setWalletReturnOrderNo(orderNo);
  uni.navigateTo({ url: "/pages/wallet/wallet" });
}

/**
 * §5.1 登出：服务端吊销令牌 + 清本地会话。
 *
 * ⚠️ 这里**不**再自己调 `stopGameSession()`：`auth.signOut()` → `clearLocalSession()`
 * 已经通过 R36 的绑定钩子销毁了本地 WS 会话。会话销毁只有一个真相点，避免两处各调一次
 * （行为无害，但下次改「谁负责销毁」时会出现第二种写法）。
 */
async function onSignOut() {
  await auth.signOut();
}

onMounted(() => {
  // 两条互不依赖、并行发出：配置（场次/档位/开关）与余额（chip/门槛/救助）。
  void loadClientConfig();
  void loadWalletBalance();
  // 支付回跳（T14）：命中 `?pay=` 时写跨页载体并压栈钱包页（消费一次性；见函数注释）。
  consumePayReturn();
});

/**
 * 大厅 BGM（U4）。
 *
 * ⚠️ 每个页面只管**自己**那一首、自己卸载时停掉 —— 切曲**不跨页面做**
 * （页面栈的唯一真源是 `auth.page`，音频跟着挂载/卸载走）。
 * `playBgm` 自身会先停掉当前曲 ⇒ 大厅 → 牌桌的切换不会叠放两首。
 */
loadAudioPrefs();
playBgm(CUES.BgmLobby);
onUnmounted(() => stopBgm());
</script>

<template>
  <LandscapeStage>
    <view class="lobby">
      <!--
        标签映射（派工单 A）：`section/header/div/ul/li → view`、`span/p/h1/h2 → text`；
        `button`/`input` 保持 uni-app core 组件。class 名一个不改（探针与测试的锚点）。
        ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
        `classes()` 静默返回 `[]`。
      -->
      <!-- 顶栏（片规格 §3 + ② §14 + 支付片 T14 + 广告片 T19）：左 = **身份**（头像+昵称 ⇒ 玩家菜单）+
           **钱包入口**（金币显示处 ⇒ 钱包页；两个**兄弟**按钮，不得嵌套）；中 = 「领取救助」
           （**复合条件渲染**：`reliefEnabled` ∧ 余额 < 档位表最低档 × entryMultiplier（= `store.reliefAvailable`）
           ∧ **App 平台** ∧ `reliefAdpid` 非空 —— 后两条是 T19 追加的，H5 与「服务端未配广告位」
           两条路都隐藏）；右 = **只放退出**。
           ⚠️ 不设置齿轮等占位按钮 —— 本仓明文忌讳「点了没反应的活按钮」（规格 §6.2 订正）。 -->
      <view class="lobby__bar">
        <view class="lobby__player-area">
          <!-- 记录片 T8（设计 D6）：**头像可点** → 页内弹层（**不是**跳页、不是第二套导航）。 -->
          <button
            type="button"
            class="lobby__player-entry"
            @click="playerMenuOpen = true"
          >
            <PlayerChip
              class="lobby__player"
              part="identity"
              :name="auth.displayName"
            />
          </button>
          <!-- 支付片 T14：**钱包入口**（钩子 `wallet-entry`；规格 §4「金币显示处点击 ⇒ 跳钱包页」）。
               ⚠️ 入口恒渲染（规格 §4 的隐藏条款需「两开关全关 ∧ 页面无内容」，而钱包页恒有内容
               —— 余额区与记录区不随开关隐藏；判据见 `openWallet` 的注释）。 -->
          <button
            type="button"
            class="lobby__wallet-entry wallet-entry"
            @click="openWallet"
          >
            <!-- ② 余额 chip：数字来自 `GET /api/wallet/balance`（未取到 ⇒ 组件显「—」）。 -->
            <PlayerChip
              class="lobby__wallet"
              part="coin"
              :balance="store.walletBalance"
            />
          </button>
        </view>
        <button
          v-if="
            store.reliefAvailable &&
            isRewardedAdSupported() &&
            store.reliefAdpid !== ''
          "
          type="button"
          class="btn btn--small lobby__relief"
          @click="openRelief"
        >
          领取救助
        </button>
        <button
          type="button"
          class="btn btn--small lobby__exit"
          @click="onSignOut"
        >
          退出
        </button>
      </view>

      <!--
        面板外提示（Task 8）：救助结果 / 会话提示 / 连接死态都收进 `NoticeStack` 浮层
        （`LandscapeStage` 的 `overlay` 槽，见模板尾部）——本页不再有文档流内的提示条。
      -->

      <view class="lobby__body">
        <!--
          左：玩法列表（规格 §3）。现在只有斗地主一个条目，但结构上是**列表容器**（`v-for`）
          —— 加第二个玩法时只加数据、不改结构。
          🔴 **点卡 = 只切换选中**（不再跳页）：进开始游戏页靠右栏的底分卡。
          ⚠️ 玩法卡只显示名称与一句话说明：后端 `RoomInfo` 里**没有**的字段一律不造（不新增数据源）——
          例如「在线人数」后端根本没给这个字段，造它等于凭空新增一个数据源。
        -->
        <view class="lobby__modes">
          <text class="lobby__modes-title">选择玩法</text>
          <view class="lobby__mode-list">
            <button
              v-for="m in visibleModes"
              :key="m.id"
              type="button"
              class="lobby__mode"
              :class="{ 'lobby__mode--active': m.id === store.activeMode }"
              @click="selectMode(m.id)"
            >
              <!-- 图标位（R747）：给了文件名就渲染图，没给就走下面的 CSS 兜底 -->
              <image
                v-if="m.icon"
                class="lobby__mode-icon"
                :src="`/static/ui/${m.icon}`"
                mode="aspectFit"
              />
              <view v-else class="lobby__mode-icon lobby__mode-icon--fallback">
                <text class="lobby__mode-icon-char">{{
                  m.name.slice(0, 1)
                }}</text>
              </view>
              <view class="lobby__mode-text">
                <text class="lobby__mode-name">{{ m.name }}</text>
                <text class="lobby__mode-tagline">{{ m.tagline }}</text>
              </view>
            </button>
          </view>
        </view>

        <!--
          右：**场次切换 + 底分档位横滚**（规格 §3 + ② §14）。数据全部来自服务端（协议①）。
          🔴 点卡 = **进开始游戏页**（裁决一）。拿不到档位表 ⇒ 一张卡都不渲染（不猜底分）。
        -->
        <view class="lobby__levels">
          <text class="lobby__levels-title">选择底分</text>
          <!--
            ⚠️ **三段互斥**（`v-if` / `v-else-if` / `v-else`），不是「把加载中文案塞进 error 行」：
            一个叫 `error` 的元素装非错误内容，下一个人读代码时无从判断它到底是不是错误。
            ② 起「场次切换」也住在第一段里：档位表拿不到时它同样没有可进入的东西。
          -->
          <template v-if="store.activeLevels.length > 0">
            <!--
              场次切换（② §14：按开关渲染，双关空态）：选项只出现**开着**的场次；
              两个都关 ⇒ 空态文案 + **零张档位卡**（没有可进入的场次，卡就是死按钮）。
              点场次 = 只切换选中（写 `store.roomMode`）——`room.match` 的 mode 读它。
              单场次 ⇒ **静态标识**（不是按钮：没有第二个选项，切换器就是死按钮）。
            -->
            <view v-if="sessionOptions.length > 1" class="lobby__sessions">
              <button
                v-for="s in sessionOptions"
                :key="s.mode"
                type="button"
                class="lobby__session"
                :class="{ 'lobby__session--active': s.mode === store.roomMode }"
                @click="selectSession(s.mode)"
              >
                {{ s.label }}
              </button>
            </view>
            <view v-else-if="sessionOptions.length === 1" class="lobby__sessions">
              <text
                class="lobby__session lobby__session--active lobby__session--static"
              >{{ sessionOptions[0]!.label }}</text>
            </view>
            <text v-else class="lobby__sessions-empty">当前没有开放的场次</text>

            <view v-if="sessionOptions.length > 0" class="lobby__level-list">
              <button
                v-for="lv in store.activeLevels"
                :key="lv.baseScore"
                type="button"
                class="lobby__level"
                :class="{
                  'lobby__level--active':
                    lv.baseScore === store.selectedBaseScore,
                  'lobby__level--locked': isLocked(lv.baseScore),
                }"
                @click="enterLevel(lv.baseScore)"
              >
                <text class="lobby__level-name">{{ lv.name }}</text>
                <text class="lobby__level-base">底分 {{ lv.baseScore }}</text>
                <!-- ② 金币门槛提示：`baseScore × entryMultiplier`（两个乘数都来自服务端——
                     本页没有任何门槛字面量；倍率未知/免费场 ⇒ 整行不渲染）。 -->
                <text
                  v-if="thresholdOf(lv.baseScore) !== null"
                  class="lobby__level-need"
                >
                  需 ≥ {{ thresholdOf(lv.baseScore) }} 金币
                </text>
                <!-- 台费「入场费 N 金币」：仅金币场且该档 entryFeePercent>0 时渲染（entryFeeOfLevel 与服务端同一函数）。 -->
                <text
                  v-if="ticketOfLevel(lv) !== null"
                  class="lobby__level-fee"
                >
                  入场费 {{ ticketOfLevel(lv) }} 金币
                </text>
              </button>
            </view>
          </template>
          <!--
            三态互斥（Task 8）：失败 / 空表 / 加载中 —— 都是**静态状态位**，
            具体原因与「重试」出口在浮层 `levels` 项（关掉浮层后仍能区分三种状态）。
          -->
          <text v-else-if="levelsFailed" class="lobby__levels-empty">档位表加载失败，请稍后重试</text>
          <text v-else-if="levelsEmpty" class="lobby__levels-empty">档位表为空，暂无可用档位</text>
          <text v-else class="lobby__levels-empty">底分档位表加载中…</text>
        </view>
      </view>

      <!--
        玩家菜单弹层（记录片 T8 / 设计 D6）：**全屏遮罩 + 居中面板**（照 `game.vue` 的好友房弹层）。
        🔴 **遮罩关闭不得用 `.self`**（真浏览器实测：uni-app H5 的 `$nne` 事件归一化让
        `target`/`currentTarget` 是两个新建的 facade ⇒ `.self` 守卫恒真、handler 恒被吞；
        `MoreMenu.vue` 记着根因与真栈取证）⇒ 用「**裸 click** + 面板根 `@click.stop`」。
      -->
      <view
        v-if="playerMenuOpen"
        class="lobby__menu"
        @click="playerMenuOpen = false"
      >
        <view class="lobby__menu-panel" @click.stop>
          <view class="lobby__menu-head">
            <text class="lobby__menu-title">我的</text>
            <button
              type="button"
              class="btn btn--small lobby__menu-close"
              @click="playerMenuOpen = false"
            >
              关闭
            </button>
          </view>
          <!-- 列表结构（1 项也建表）：将来加「设置」只往 PLAYER_MENU 加一条数据。 -->
          <view class="lobby__menu-list">
            <button
              v-for="item in PLAYER_MENU"
              :key="item.id"
              type="button"
              class="btn lobby__menu-item"
              @click="openMenuItem(item)"
            >
              {{ item.label }}
            </button>
          </view>
        </view>
      </view>

      <!--
        救助确认弹层（② §14 + 广告小片 T19 正片）：与玩家菜单同一形态
        （全屏遮罩 + 居中面板；遮罩关闭 = 裸 click + 面板 `@click.stop`，**不得**用 `.self`）。
        🔴 弹层期间 = 一次观看的生命周期：确认 ⇒ 续窗 GET ⇒ 激励视频（宿主全屏盖住本层，
        事件回来时层还在）⇒ 轮询到账 ⇒ 成功才「关层」（规格 §2.9 逐字）。
        过程消息（失败 / 不可领 reason / 未看完 / 播不出来 / 稍后到账）落面板内的
        `.lobby__relief-note`；成功关层后同一条落面板外那行 —— 同一个状态、两处互斥渲染。
      -->
      <view
        v-if="reliefOpen"
        class="lobby__relief-dialog"
        @click="closeRelief"
      >
        <view class="lobby__relief-panel" @click.stop>
          <view class="lobby__relief-head">
            <text class="lobby__relief-title">领取救助</text>
            <button
              type="button"
              class="btn btn--small lobby__relief-close"
              @click="closeRelief"
            >
              关闭
            </button>
          </view>
          <text class="lobby__relief-copy">
            确认领取今日救助（需先完整观看一段激励视频，每天限领一次）。
          </text>
          <!-- 过程 / 结果消息（面板内渲染点；正片流程的每一步反馈都落这里）。 -->
          <text v-if="reliefNote" class="lobby__relief-note">{{ reliefNote }}</text>
          <view class="lobby__relief-actions">
            <button
              type="button"
              class="btn btn--primary lobby__relief-confirm"
              :disabled="reliefBusy"
              @click="confirmRelief"
            >
              确认领取
            </button>
            <button
              type="button"
              class="btn lobby__relief-cancel"
              @click="closeRelief"
            >
              取消
            </button>
          </view>
        </view>
      </view>
    </view>

    <!-- 提示浮层（Task 8）：本地项 + 会话提示 + 连接死态都在这里，不占大厅文档流。 -->
    <template #overlay>
      <NoticeStack :items="noticeItems" surface="lobby" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/**
 * 片② 客户端：**顶栏 + 左右两栏**（规格 §3 的形态）。
 *
 * ⚠️ **用 flex 列而不是 grid 行**：页面内容是条件渲染的（例如档位表的三种状态位）
 * ⇒ 若写成 `grid-template-rows: auto auto 1fr`，「它不在」时子项数变化会让
 * `.lobby__body` 落到**第 2 条轨道（`auto`）**而不是最后那条 `1fr` —— 两栏不再撑满高度
 * （隐式行放置按**实际存在**的子项算）。flex 的 `flex: 1 1 auto` 不依赖声明了几条轨道，
 * 条件渲染增减子项都不受影响。Task 8 起提示全部浮层化（`NoticeStack` 在 overlay 槽），
 * 页面主体不再有会增减的提示子项。
 * ⚠️ 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义** ——
 *    令牌是全局的，改一个值会同时改掉四个页面）。
 * ⚠️ 视觉语言**照抄总规格 §5.2.1**（半透明深蓝面板 / 金主按钮 / 分段·选中控件…）。
 *    **别各自发挥。**
 */
.lobby {
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-6;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
/** 顶栏（片规格 §3）：左信息条、右退出。 */
.lobby__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-6;
  min-height: $ftl-bar-h;
}
/**
 * 退出按钮：**次按钮语言**（§5.2.1 —— 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 白字）。
 * ⚠️ `margin: 0` 不是装饰：`uni-button` 基样式带 `margin-left/right: auto`
 * （`login.vue` / `game.vue` 都记过这个坑），在**有富余宽度**的 flex 行里会把按钮顶到中间。
 * ⚠️ `background-image: none` 必须写：`ftl-btn` mixin 带白色贴图，留着会在深底上糊成一块白板。
 */
.lobby__exit {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
/**
 * 「领取救助」（② §14）：**金色弱化**语言 —— 透明底 + 金描边 + 金字（与主按钮的实心金区分开，
 * 它是条件渲染的辅助入口，不是页面主操作）。
 */
.lobby__relief {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-gold-deep;
  background: transparent;
  background-image: none;
  color: $ftl-color-gold-light;
}
/** 救助过程 / 结果的一行提示（Task 8 起只剩**面板内**渲染点：层关着时同一条走浮层
    `relief` 项；两处互斥由 `reliefOpen` 保证 —— 见 `reliefNote` 的 watcher）。 */
.lobby__relief-note {
  flex: 0 0 auto;
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/**
 * 头像入口（记录片 T8）：PlayerChip 外面的**可点容器** —— 用 `<button>`（「可点即 button」，
 * R762 与玩法卡同一条纪律），并逐项重置 uni-button 的宿主默认样式：
 * `margin-left/right: auto` 会把整个信息条从顶栏左端顶到中间（`login.vue`/`game.vue` 记过同坑），
 * 底色/边框/字号不重置则与顶栏的「透明底 + 白字」语言不符。
 */
.lobby__player-entry {
  box-sizing: border-box;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
/** 左簇（支付片 T14）：身份按钮 + 钱包入口并列 —— 两个可点区域必须是**兄弟**（模板注释有理由）。 */
.lobby__player-area {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: $ftl-space-4;
  min-width: 0;
}
/**
 * 钱包入口（支付片 T14；钩子 `wallet-entry`）：胶囊语言（§5.2.1 的「分段/选中控件」）——
 * 透明底 + 发丝描边，内容 = 金币视图（`PlayerChip part="coin"`）。
 * ⚠️ 逐项重置 uni-button 宿主默认样式（`margin-left/right: auto` 会把按钮顶离左簇、
 * 底色/字体不重置则与深底顶栏语言不符——`.lobby__player-entry` 记过同款）。
 */
.lobby__wallet-entry {
  box-sizing: border-box;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  margin: 0;
  padding: $ftl-space-2 $ftl-space-5;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-pill;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
/**
 * 玩家菜单弹层（记录片 T8）：掩码 + 居中面板，形态与 `game.vue` 的好友房弹层**同族**
 * （遮罩 `$ftl-color-night-deep` 62%、面板 `rgba($ftl-color-night, .62)` + 640 宽 —— §5.2.1 的既有层次）。
 * ⚠️ `position: absolute` 的定位基准是 `.lobby`（上面已补 `position: relative`）。
 */
.lobby__menu {
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
.lobby__menu-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 640px;
  max-width: 100%;
  max-height: 100%;
  padding: $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.lobby__menu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
}
.lobby__menu-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
.lobby__menu-list {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
}
/**
 * 弹层里的按钮：次按钮语言（§5.2.1）。
 * ⚠️ 选择器必须带 `.lobby__menu` 前缀（复合选择器）：`.btn { @include ftl-btn }` 在本文件
 * **末尾**，同特指度下后者胜 ⇒ 单类选择器（`.lobby__menu-item`）的覆盖会被 mixin 的
 * `background: $ftl-color-surface` / 贴图 / `border` 反吃回去（game.vue 用
 * `.game__friends .btn:not(.btn--primary)` 是同一手法）。
 */
.lobby__menu .lobby__menu-close,
.lobby__menu .lobby__menu-item {
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.lobby__menu .lobby__menu-close {
  flex: 0 0 auto;
}
/** 菜单项：整行可点、左对齐（列表项语言，不是居中按钮）。 */
.lobby__menu .lobby__menu-item {
  width: 100%;
  justify-content: flex-start;
  text-align: left;
}
/**
 * 救助确认弹层（② §14）：与玩家菜单**同一条**遮罩/面板语言（同类容器同观感）。
 * 选择器同样带 `.lobby__relief-dialog` 前缀的理由与菜单块逐字相同（`.btn` mixin 在文件末尾）。
 */
.lobby__relief-dialog {
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
.lobby__relief-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 640px;
  max-width: 100%;
  max-height: 100%;
  padding: $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.lobby__relief-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
}
.lobby__relief-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** 占位说明正文（面板内标签字）。 */
.lobby__relief-copy {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-md;
  line-height: 1.4;
}
.lobby__relief-actions {
  display: flex;
  gap: $ftl-space-4;
}
.lobby__relief-actions .btn {
  flex: 1 1 0;
}
.lobby__relief-dialog .lobby__relief-close,
.lobby__relief-dialog .lobby__relief-cancel {
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.lobby__relief-dialog .lobby__relief-close {
  flex: 0 0 auto;
}
/** 确认按钮：主按钮语言（金色，§5.2.1）——与菜单块的自持写法一致。 */
.lobby__relief-dialog .lobby__relief-confirm {
  margin: 0;
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}
/**
 * 档位区三态状态位（Task 8）：失败 / 空表 / 加载中**同一条**中性标签字 —— 它们都只是
 * 「这块现在是什么状态」；具体原因与「重试」出口在浮层 `levels` 项。
 */
.lobby__levels-empty {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/**
 * 场次切换（② §14，右栏上方）：§5.2.1 的「分段/选中控件」——
 * 槽底 `rgba(night-deep,.55)` + `radius-md`；段项**等宽**、72 高
 * （可点区域从原来的 ~43 提到 72，与牌桌动作按钮同档）。
 */
.lobby__sessions {
  display: flex;
  flex: 0 0 auto;
  gap: $ftl-space-2;
  padding: $ftl-space-2;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.55);
}
.lobby__session {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0 $ftl-space-6;
  min-height: $ftl-control-h-action;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-sm;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font: inherit;
  font-size: $ftl-font-md;
  line-height: 1.2;
  cursor: pointer;
}
.lobby__session--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.18);
  color: $ftl-color-gold-light;
  font-weight: 700;
}
/** 单场次：静态标识 —— 没有第二个选项，不做成按钮（死按钮），也不给手型光标。 */
.lobby__session--static {
  cursor: default;
}
/** 双关空态（② §14）：没有可进入的场次 —— 其中性对等于「加载中」档，不是错误。 */
.lobby__sessions-empty {
  flex: 0 0 auto;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 两栏：左玩法（固定宽，够放下图标 + 名称 + 一句话说明）、右底分（横滚）。 */
.lobby__body {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 420px 1fr;
  gap: $ftl-space-6;
  min-height: 0;
}
/**
 * 两栏各自的**半透明深蓝面板**（§5.2.1 的第一条定格值）。
 * ⚠️ 画布底纹是一张风景插画，文字直接浮在上面读不清 —— 面板首先是**为可读性**。
 */
.lobby__modes,
.lobby__levels {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  min-height: 0;
  padding: $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.lobby__modes-title,
.lobby__levels-title {
  flex: 0 0 auto;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1.2;
}
/** 玩法列表：**竖滚**（规格 §3）。 */
.lobby__mode-list {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  min-height: 0;
  overflow-y: auto;
}
/** 底分档位：**横滚**（规格 §3）。 */
.lobby__level-list {
  display: flex;
  /**
   * 🔴 **2026-10-13 真机走查修复：必须换行（`flex-wrap: wrap`）**。
   * 算账（设计 px，**最小画布宽 1334** —— 16:9 及更窄的横屏都落到它）：
   *   4 张卡 × `min-width 240` + 3 × `gap 8` = **984**；
   *   而 `.lobby__levels` 面板内列表可用宽 ≈ **824** ⇒ 单行**必然溢出 116**
   *   （真机实测：豪侠场卡被面板右缘切一半 = 用户报的「底分外面的框显示不全」）。
   * 折行后：面板纵向空间充裕，四张卡完整显示；宽画布仍单行。**不得改回 `overflow-x: auto`**
   * —— 横向滚动的「框被切」观感本身就是缺陷本身。判据：`lobby-ux.test.ts` 的源码级用例
   * （含旧形态负样本自证）；折行观感由模拟器/真机截图复核。
   */
  flex-wrap: wrap;
  /* 走查修复：显式 stretch（防宿主按钮默认样式把纵向拉伸抹掉）⇒ 卡与卡描边框**等高**。 */
  align-items: stretch;
  gap: $ftl-space-4;
  min-height: 0;
}
/**
 * 两种卡共用的**未选中**语言（§5.2.1 的「分段/选中控件」）：
 * 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 字 `rgba($ftl-color-on-primary, .75)`。
 *
 * ⚠️ 它们**是卡不是按钮控件** ⇒ 不 `@include ftl-btn`、不挂 `class="btn"`（那会触发
 * 「渲染 class="btn" 的组件必须自带 mixin」那条闸）。`<button>` 自带的宿主默认样式逐项重置回
 * 卡片所需：默认的 `margin-left/right: auto` 会把 flex 子项从拉伸变成内容宽居中，
 * `text-align: center` / `color: #000` / 不继承字体则会改掉卡内文字的排版。
 */
.lobby__mode,
.lobby__level {
  box-sizing: border-box;
  display: flex;
  margin: 0;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font: inherit;
  cursor: pointer;
}
.lobby__mode {
  align-items: center;
  justify-content: flex-start;
  gap: $ftl-space-5;
  text-align: left;
}
/**
 * 底分卡：竖排（场次名在上、底分在下），与参考图 1 的卡片同形。
 *
 * 走查修复（等高）：第三行「需 ≥ N 金币」只在金币场有门槛时才渲染、第四行「入场费 N 金币」还要
 * 该档费率 > 0（免费场没有这些元素），于是各类卡天然差行高 —— 描边框一长一短。
 * `align-items: stretch` 之外再给一张卡的**四行满配高度**兜底（上下 padding + 场次名行 +
 * 三个 gap + 底分行 + 门槛槽行 + 入场费槽行），取值全部由令牌算（无字面量、不数像素）：
 * 缺行的卡用底部留白补齐，两行文案仍是 v-if。
 */
.lobby__level {
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: $ftl-space-3;
  min-width: 240px;
  min-height: $ftl-space-5 * 2 + $ftl-font-lg * 1.2 + $ftl-space-3 * 3 +
    $ftl-font-md * 1.2 + $ftl-font-xs * 1.2 * 2;
}
/** **选中**语言（§5.2.1）：描边金 + 底 `rgba(gold,.18)` + 字 `$ftl-color-gold-light` + 700。 */
.lobby__mode--active,
.lobby__level--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.18);
  color: $ftl-color-gold-light;
  font-weight: 700;
}
/** 图标位（R747）：有素材时是 `<image>`，缺素材时走 CSS 兜底（令牌底 + 玩法名首字，不白屏）。 */
.lobby__mode-icon {
  flex: 0 0 auto;
  width: $ftl-control-h-sm;
  height: $ftl-control-h-sm;
}
.lobby__mode-icon--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $ftl-radius-md;
  background: $ftl-color-primary;
}
.lobby__mode-icon-char {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 600;
}
.lobby__mode-text {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
}
.lobby__mode-name,
.lobby__level-name {
  color: inherit;
  font-size: $ftl-font-lg;
  font-weight: inherit;
  line-height: 1.2;
  white-space: nowrap;
}
/** 一句话说明：改浅色（面板内标签字，§5.2.1）—— 原来的 `$ftl-color-text-secondary`
    是深底上的灰字，压在深蓝面板上读不清。 */
.lobby__mode-tagline {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 「底分 N」：与场次名同一族，弱一档（面板内标签字）。 */
.lobby__level-base {
  color: inherit;
  font-size: $ftl-font-md;
  line-height: 1.2;
  white-space: nowrap;
}
/** ② 金币门槛（`baseScore × entryMultiplier`）：卡内最弱一档的标签字。 */
.lobby__level-need {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-xs;
  line-height: 1.2;
  white-space: nowrap;
}
/* 台费「入场费」行：与门槛行同观感（同色同字号）——不引新令牌。 */
.lobby__level-fee {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-xs;
  line-height: 1.2;
  white-space: nowrap;
}
/**
 * ② 已判明余额不足的档位：**置灰**（降透明度）。
 *
 * ⚠️ **刻意不写 `disabled` 属性**：卡片仍要收点击 —— 点了给出「为什么进不去」的一句
 * （浮层 `entry` 项），这是「置灰 + 消息」的可证伪语义；真禁用会让消息**永远无法**出现。
 */
.lobby__level--locked {
  opacity: 0.45;
  cursor: not-allowed;
}
/** Task 8：会话提示 / 连接死态 / 本地提示统一由 `NoticeStack` 浮层渲染（挂 overlay 槽），
    本页不再有 `.lobby__notice` 宿主样式（旧悬浮胶囊规则随 `SessionNotice` 摘除一并删除）。 */
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
 * 禁用态（广告片 T19 起本页又有可禁用的 `.btn`：救助确认按钮在 `reliefBusy`（续窗/播放/
 * 轮询进行中）时禁用 —— 防双击造出第二个广告实例）。形态与开始游戏页 `.btn:disabled` 逐字相同。
 */
.btn[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none !important;
  filter: grayscale(0.4);
}
</style>
