<script setup lang="ts">
/**
 * 牌桌**通用壳**（S5.2 / spec §4.10.2）。
 *
 * 壳只持有玩法无关职责：
 *  - 会话接线（`useGameSession`）、房间状态、通知（`NoticeStack`）、连接（`ConnectionOverlay`）；
 *  - 结算揭示（`useSettlementReveal`）、倒计时（`useCountdown`）、通用音效/BGM、返回/重开；
 *  - 按 `view.gameType` 渲染对应 board（首版 `DdzBoard`；S6 起 `PdkBoard`）。
 *
 * board 约定：只收 `view/mySeat/...` props、只 emit 动作（`bid/play/pass/trustee/more/leave`），
 * **不读 store**；发送、busy、通知、返回确认都在壳这一层。
 *
 * 返回大厅（K1/K3，判定链次序写死）：
 *  ① `view === null`（等待房）与 `state === 'ended'`（结算）⇒ **只导航**；
 *  ② 其余（`init/bidding/playing`）⇒ 确认弹窗 → `room.leave` 真弃局。
 *
 * 「再来一局」：只写意向 + 回玩法页（`room.match` 的唯一实现仍在玩法页）。
 */
import { computed, onMounted, onUnmounted, ref, toRef, watch } from "vue";
import { ErrCode, isPdkSettlementResult, type Card } from "@fight-the-landlord/protocol";
import ConnectionOverlay from "../../components/ConnectionOverlay.vue";
import NoticeStack from "../../components/NoticeStack.vue";
import MoreMenu from "../../components/MoreMenu.vue";
import Settlement from "../../components/Settlement.vue";
import PdkSettlement from "../../components/PdkSettlement.vue";
import DdzBoard from "../../components/table/ddz/DdzBoard.vue";
import PdkBoard from "../../components/table/pdk/PdkBoard.vue";
import { useGameStore } from "../../stores/game";
import { useAuthStore } from "../../stores/auth";
import { currentSession, getGameSession } from "../../composables/useGameSession";
import { useCountdown } from "../../composables/useCountdown";
/** 等待上限（`room.leave` 的 5s 本地超时）：计时器本体在 composable（R675 闸的合规落点）。 */
import { raceTimeout } from "../../composables/raceTimeout";
import { usePageAlignment } from "../../composables/usePageAlignment";
import { useAppVisibility } from "../../composables/useAppVisibility";
import { useTableSound } from "../../composables/useTableSound";
import { useRedealNotice } from "../../composables/useRedealNotice";
import { usePlayedCards } from "../../composables/usePlayedCards";
import { useSettlementReveal } from "../../composables/useSettlementReveal";
import { usePageNotices } from "../../composables/usePageNotices";
import { actionCopyFor } from "../../net/action-copy";
/** 死态 fail-fast 的拦下原因：页面据此**不写**本地提示（呈现交给 `ConnectionOverlay`）。 */
import { ConnectionDeadError } from "../../net/socket";
import {
  loadAudioPrefs,
  playBgm,
  preheatCues,
  stopBgm,
  stopCues,
  isMusicOn,
  isSfxOn,
  setMusicOn,
  setSfxOn,
  getVolume,
  setVolume,
} from "../../audio";
import { CUES, type CueName } from "../../audio/cues";
import {
  haptic,
  isHapticsEnabled,
  loadHapticsPrefs,
  setHapticsEnabled,
} from "../../feedback/haptics";
import LandscapeStage from "../../components/LandscapeStage.vue";

const store = useGameStore();
const auth = useAuthStore();
usePageAlignment("table");

/**
 * 提示单通道（提示收敛 Task 10）：`table-local`（忙锁/离开失败）与 `table-12003`
 * 由本页写；其余 WS ack 非 0 由 session notice 呈现。
 */
const notices = usePageNotices();
const { items: noticeItems } = notices;

/** 动作忙锁（board 只读该值禁用按钮）。 */
const busy = ref(false);
/** 二级弹层（D16）开合；开在壳、由 board 的「更多」emit 触发。 */
const moreOpen = ref(false);

/**
 * 记牌器权益门（统一判定表，spec §2.7）：壳计算，board 只消费结果。
 */
const cardCounterGate = computed(() => {
  if (!store.cardCounterEnabled) return false;
  const status = store.cardCounterStatus;
  if (status !== null && status.roomCode === store.roomCode) return status.active;
  if (
    store.cardCounterPricePerGameCoins === null ||
    store.cardCounterPricePerHourCoins === null
  ) {
    return true;
  }
  return false;
});

/** 按座位昵称 / 余额（board 只收投影，不读 store）。 */
const seatNames = computed<Record<number, string>>(() => ({ ...store.seatNicknames }));
const balances = computed<Array<number | null>>(() => [
  store.seatBalance(0),
  store.seatBalance(1),
  store.seatBalance(2),
]);

/**
 * S5.3：`store.view` 是 ddz/pdk 联合；斗地主壳这一侧先窄化（S6 按 gameType 渲染 board）。
 * pdk 视图在 PdkBoard 落地前不交给 DdzBoard（绝不把跑得快当斗地主渲染）。
 */
const ddzView = computed(() =>
  store.view && store.view.gameType !== 'paodekuai' ? store.view : null,
);

/** S5.3：结算联合；斗地主结算面板先只接旧 9 键形状（S6.2 接 pdk 变体）。 */
const ddzSettlement = computed(() =>
  store.settlement && !isPdkSettlementResult(store.settlement) ? store.settlement : null,
);

/** S6：跑得快视图/结算（首版只做 3 人）。 */
const pdkView = computed(() =>
  store.view && store.view.gameType === 'paodekuai' ? store.view : null,
);
const isPdk = computed(() => pdkView.value !== null);
const pdkSettlement = computed(() =>
  store.settlement && isPdkSettlementResult(store.settlement) ? store.settlement : null,
);

/**
 * S6.1：首版客户端只支持 3 人跑得快。收到 2/4 人视图 ⇒ 提示并回大厅
 * （不得把不支持的人数渲染成 3 人牌桌 —— 座位/牌数都会说谎）。
 */
watch(
  pdkView,
  (v) => {
    if (!v || v.playerCount === 3) return;
    notices.setNotice("pdk-unsupported", "当前客户端暂不支持该人数的跑得快，已返回大厅", {
      level: "warn",
    });
    store.reset();
    auth.navigate("lobby");
  },
  { immediate: true },
);

/**
 * 结算面板出现时清本地提示：走查实测它们会留在遮罩后露出红边，而「本局已结束」才是事实。
 * （`clearNotice` 只清 `source:'action'`，连接类提示不受影响。）
 */
watch(
  () => store.settlement,
  (settlement) => {
    if (!settlement) return;
    notices.dismiss("table-local");
    getGameSession().clearNotice();
  },
);

const { seconds, start: startCountdown } = useCountdown({
  deadlineAt: () => store.deadlineAt,
  version: toRef(store, "currentVersion"),
});
startCountdown();

/**
 * 项 4 预热名单：高频对局内音效。U5 的 48 条牌型播报刻意不预热（D8）。
 */
const PREHEAT_CUES = [
  "Order",
  "Rob1",
  "NoOrder",
  "Buyao1",
  "Buyao2",
  "Buyao3",
  "Baojing1",
  "Baojing2",
  "SingleLittleJoker",
  "SingleBigJoker",
  "Win",
  "Lose",
] as const satisfies readonly CueName[];

/** 音效/BGM（spec §7 / R698 / U4）：BGM 随页面挂载/卸载；视图 diff 音效在 `useTableSound`。 */
loadAudioPrefs();
loadHapticsPrefs();
preheatCues(PREHEAT_CUES);
playBgm(CUES.BgmTable);
useTableSound();
const { visible: redealVisible, epoch: redealEpoch } = useRedealNotice();
/** 重发后本局内恒为 `redeal`（D9：不与横幅可见性绑定）。 */
const dealEnterMode = computed<"deal" | "redeal">(() =>
  redealEpoch.value > 0 ? "redeal" : "deal",
);
watch(redealEpoch, (n, o) => {
  if (n > o) haptic("medium");
});
/** 项 3：进牌桌即启动记牌累积器（单例）。 */
usePlayedCards();

/** 终局结算延迟揭示（2s）。揭示瞬间复位「更多」开态。 */
const { revealed: settlementRevealed, receivedAt: settlementReceivedAt } =
  useSettlementReveal();
watch(settlementRevealed, (revealed) => {
  if (!revealed) return;
  moreOpen.value = false;
});
onUnmounted(() => {
  stopBgm();
  stopCues();
});

/** 设置受控状态：初值取自音频/触感层，变更经 MoreMenu emit 回来落盘。 */
const musicOn = ref(isMusicOn());
const sfxOn = ref(isSfxOn());
const hapticsOn = ref(isHapticsEnabled());
const audioVolume = ref(getVolume());
function onMusic(on: boolean) {
  setMusicOn(on);
  musicOn.value = on;
  if (on) playBgm(CUES.BgmTable);
}
function onSfx(on: boolean) {
  setSfxOn(on);
  sfxOn.value = on;
}
function onHaptics(on: boolean) {
  setHapticsEnabled(on);
  hapticsOn.value = on;
}
function onVolume(value: number) {
  setVolume(value);
  audioVolume.value = value;
}

/** 连接相位（重连提示条 / 终态遮罩只读它）。 */
const connectionState = computed(
  () => currentSession.value?.connectionState.value ?? null,
);
function onConnectionRetry() {
  getGameSession().client.retryConnect();
}

/**
 * 发一个动作，并把服务端的应答变成玩家能看懂的一句话（➎ / R651）。
 *
 * 红线「文案 ≠ 判定」：被拒时只翻译服务端 code；合法性/轮次/能否过牌全归服务端。
 * 来源分流：忙锁 ⇒ `table-local`；12003 ⇒ 就地提示一次；其余非 0 ⇒ session notice；
 * `ConnectionDeadError` ⇒ 静默（呈现归 ConnectionOverlay）。
 */
async function send(
  type: "game.bid" | "game.play" | "game.pass" | "game.trustee",
  payload: unknown,
) {
  if (busy.value) return;
  busy.value = true;
  notices.dismiss("table-local");
  notices.dismiss("table-12003");
  try {
    const outcome = await getGameSession().client.send(type, payload);
    if (outcome.status === "blocked") {
      if (outcome.reason instanceof ConnectionDeadError) return;
      notices.setNotice("table-local", "上一个操作尚未确认，请稍候", { level: "warn" });
      haptic("medium");
      return;
    }
    if (outcome.code === ErrCode.NOT_YOUR_TURN) {
      notices.setNotice("table-12003", actionCopyFor(ErrCode.NOT_YOUR_TURN)!, {
        level: "warn",
      });
      haptic("heavy");
      return;
    }
    if (outcome.code !== ErrCode.OK) {
      haptic("heavy");
      return;
    }
    haptic("light");
  } catch (e) {
    if (e instanceof ConnectionDeadError) return;
    throw e;
  } finally {
    busy.value = false;
  }
}

function onBid(grab: boolean): void {
  void send("game.bid", { grab });
}
function onPlay(cards: Card[]): void {
  void send("game.play", { cards });
}
function onPass(): void {
  void send("game.pass", {});
}
function onTrustee(on: boolean): void {
  void send("game.trustee", { on });
}

/**
 * 「再来一局」：只写一次性意向 + 回玩法页（`room.match` 的唯一实现仍在玩法页）。
 */
function onAgain() {
  if (store.selectedBaseScore === null && store.view?.baseScore != null) {
    store.setSelectedBaseScore(store.view.baseScore);
  }
  store.requestRematch();
  auth.navigate("game");
}

/**
 * `room.leave` 的本地超时（本片 §0.3-7）：发送层对 leave 没有安全时钟。
 */
const LEAVE_TIMEOUT_MS = 5000;

/**
 * 顶栏「返回大厅」的唯一处理体（K1/K3）：等待房/结算只导航；进行中确认后 `room.leave`。
 */
function onBackToLobby(): void {
  const v = store.view;
  if (v === null || v.state === "ended") {
    auth.navigate("lobby");
    return;
  }
  uni.showModal({
    title: "退出本局",
    content: "本局将由系统自动打完（金币场按结果结算），期间无法回到本局。",
    confirmText: "退出",
    cancelText: "取消",
    success: (res) => {
      if (res.confirm) void doLeave();
    },
  });
}

/**
 * 确认退出：发 `room.leave`，成功（或 12001 视为成功）才 reset + 回大厅。
 * 超时/非零 ⇒ 留守 + 提示，绝不假装已离场。
 */
async function doLeave(): Promise<void> {
  const roomCode = store.roomCode;
  if (!roomCode) {
    auth.navigate("lobby");
    return;
  }
  notices.dismiss("table-local");
  const outcome = await raceTimeout(
    getGameSession()
      .client.sendQueued("room.leave", { roomCode }, 5)
      .catch(() => null),
    LEAVE_TIMEOUT_MS,
  );
  if (outcome === null || outcome === "timeout" || outcome.status !== "sent") {
    notices.setNotice("table-local", "退出失败，请重试", { level: "error" });
    return;
  }
  if (outcome.code === ErrCode.OK || outcome.code === ErrCode.ROOM_NOT_FOUND) {
    if (outcome.code === ErrCode.ROOM_NOT_FOUND) getGameSession().clearNotice();
    store.reset();
    auth.navigate("lobby");
    return;
  }
  notices.setNotice("table-local", "退出失败，请重试", { level: "error" });
}

/** 回前台补快照的节流窗口（项 1）。 */
const FOREGROUND_RESYNC_THROTTLE_MS = 500;
const appVisibility = useAppVisibility();
let lastForegroundResyncAt = 0;
appVisibility.onShow(() => {
  if (store.currentVersion < 0 || store.view === null) return;
  if (!getGameSession().client.connected) return;
  const now = Date.now();
  if (now - lastForegroundResyncAt < FOREGROUND_RESYNC_THROTTLE_MS) return;
  lastForegroundResyncAt = now;
  void getGameSession().client.resync();
});

onMounted(() => {
  if (store.currentVersion >= 0 && store.view === null) {
    void getGameSession().client.resync();
  }
});
</script>

<template>
  <LandscapeStage backdrop="table">
    <DdzBoard
      v-if="!isPdk"
      :view="ddzView"
      :my-seat="store.mySeat"
      :seconds="seconds"
      :busy="busy"
      :interactive="store.settlement === null"
      :settlement-arrived="store.settlement !== null"
      :settlement-revealed="settlementRevealed"
      :waiting-for-deal="store.waitingForDeal"
      :room-code="store.roomCode"
      :seat-names="seatNames"
      :balances="balances"
      :level-name="store.viewLevelName"
      :card-counter-gate="cardCounterGate"
      :redeal-visible="redealVisible"
      :redeal-epoch="redealEpoch"
      :deal-enter-mode="dealEnterMode"
      @bid="onBid"
      @play="onPlay"
      @pass="onPass"
      @trustee="onTrustee"
      @more="moreOpen = true"
      @leave="onBackToLobby"
    >
      <template #overlays>
        <view
          v-if="store.settlement && settlementRevealed"
          class="table__scrim"
        />
        <Settlement
          v-if="ddzSettlement && settlementRevealed"
          :settlement="ddzSettlement"
          :settlement-received-at="settlementReceivedAt ?? undefined"
          @again="onAgain"
          @back="auth.navigate('lobby')"
        />
        <MoreMenu
          v-if="moreOpen && !settlementRevealed"
          :music-on="musicOn"
          :sfx-on="sfxOn"
          :haptics-on="hapticsOn"
          :volume="audioVolume"
          @close="moreOpen = false"
          @music="onMusic"
          @sfx="onSfx"
          @haptics="onHaptics"
          @volume="onVolume"
        />
        <ConnectionOverlay
          v-if="connectionState !== null && connectionState.phase !== 'connected'"
          :state="connectionState"
          @retry="onConnectionRetry"
          @back="auth.navigate('lobby')"
          @relogin="auth.clearLocalSession()"
        />
      </template>
    </DdzBoard>

    <PdkBoard
      v-else
      :view="pdkView"
      :my-seat="store.mySeat"
      :seconds="seconds"
      :busy="busy"
      :interactive="store.settlement === null"
      :settlement-arrived="store.settlement !== null"
      :settlement-revealed="settlementRevealed"
      :waiting-for-deal="store.waitingForDeal"
      :room-code="store.roomCode"
      :seat-names="seatNames"
      :balances="balances"
      :level-name="store.viewLevelName"
      @play="onPlay"
      @pass="onPass"
      @trustee="onTrustee"
      @more="moreOpen = true"
      @leave="onBackToLobby"
    >
      <template #overlays>
        <view
          v-if="store.settlement && settlementRevealed"
          class="table__scrim"
        />
        <Settlement
          v-if="ddzSettlement && settlementRevealed"
          :settlement="ddzSettlement"
          :settlement-received-at="settlementReceivedAt ?? undefined"
          @again="onAgain"
          @back="auth.navigate('lobby')"
        />
        <PdkSettlement
          v-if="pdkSettlement && settlementRevealed"
          :settlement="pdkSettlement"
          :settlement-received-at="settlementReceivedAt ?? undefined"
          @again="onAgain"
          @back="auth.navigate('lobby')"
        />
        <MoreMenu
          v-if="moreOpen && !settlementRevealed"
          :music-on="musicOn"
          :sfx-on="sfxOn"
          :haptics-on="hapticsOn"
          :volume="audioVolume"
          @close="moreOpen = false"
          @music="onMusic"
          @sfx="onSfx"
          @haptics="onHaptics"
          @volume="onVolume"
        />
        <ConnectionOverlay
          v-if="connectionState !== null && connectionState.phase !== 'connected'"
          :state="connectionState"
          @retry="onConnectionRetry"
          @back="auth.navigate('lobby')"
          @relogin="auth.clearLocalSession()"
        />
      </template>
    </PdkBoard>

    <template #overlay>
      <NoticeStack :items="noticeItems" surface="table" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/**
 * 结算遮罩（壳持有；slot 内容的 scoped id 属于壳，因此样式必须在这里）。
 * ⚠️ 与结算面板同生同灭；定位基准是 board 的 `.table`（position: relative）。
 */
.table__scrim {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  background: rgb(0 0 0 / 45%);
}
</style>
