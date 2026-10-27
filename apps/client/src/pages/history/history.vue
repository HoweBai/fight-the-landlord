﻿<script setup lang="ts">
/**
 * 历史战绩（记录片 T8 / 规格 §1 F2 · 设计 D6）：**第 5 页**。
 *
 * ## 两条结构事实
 *
 *  - `pages.json` 与入口**同提交**注册本页（否则真机导航失败 —— 那是单测看不见的形态）；
 *  - 本页**不是** `auth.page` 四页投影之一：从大厅 `navigateTo` **压栈**进来，
 *    `auth.page` 仍是 `lobby`；返回用 `uni.navigateBack()` 弹栈，**不写** `page`。
 *
 * ## 数据与口径（全部来自 `GET /api/records/mine`，规格 §2.3）
 *
 * 本页是**哑终端**：不算分、不排序（`ended_at DESC` 是服务端给的），只做「枚举 → 文案」的
 * 映射（与 `Settlement.vue` 的 `SPRING_LABEL` 同族）。三条写死的口径：
 *  - `nextCursor` 是**不透明串**：**原样回传**，既不解析也不构造（编码收在服务端）；
 *  - 模式标签：`random→「匹配」`、`practice→「好友房」`（**禁「练习」字样** —— 规格 §1 F4；
 *    全 src 有一条机械负断言）；
 *  - 昵称回落与 `table.vue` 的 `nameOf()` 同款：昵称 → 「玩家{seat}」；我那一行是「我」。
 *
 * ## 🔴 翻页为什么不是页级 `onReachBottom`
 *
 * 设计 D6 的语义是「到达底部 → 用游标拉下一页」。它的**页级原语**在本仓有两处硬障碍：
 *  ① 舞台 `.stage` 是 `position: fixed; inset: 0; overflow: hidden`（spec §2.2：整页不滚动）
 *     ⇒ 页面级滚动事件**永不发生**，`onReachBottom` 挂上了也不会响；
 *  ② `@dcloudio/uni-app` 的组合式钩子被 `source-boundary` 闸挡在 `src/**` 之外
 *     （裸依赖闭集 = pinia / socket.io-client / vue；`usePageAlignment.ts` 记着同一条）。
 * ⇒ 用 **`scroll-view` 的 `@scrolltolower`**（列表自己的滚动容器 + 到达底部事件）——
 * **行为与「onReachBottom 翻页」一致**，且三端可用。
 */
import { computed, onMounted, ref } from 'vue';
import type { MyRecord, MyRecordPlayer, PdkRecord } from '../../net/rest';
import * as rest from '../../net/rest';
import { dispatchRestFailure } from '../../net/errors';
import { playerMessage } from '../../net/copy';
import { GAME_MODES } from '../../gameModes';
import { useAuthStore } from '../../stores/auth';
import { stopGameSession } from '../../composables/useGameSession';
import { usePageNotices } from '../../composables/usePageNotices';
import LandscapeStage from '../../components/LandscapeStage.vue';
import NoticeStack from '../../components/NoticeStack.vue';
/** 牌面**复用**共用件（F2 明文）：一手牌 = `Hand`（内部逐张 `Card`）、底牌 = `BottomCards`。 */
import Hand from '../../components/Hand.vue';
import BottomCards from '../../components/BottomCards.vue';

const auth = useAuthStore();

/**
 * 提示收敛（Task 6）：本页失败原因/出路不再占列表文档流，走 `NoticeStack` 浮层
 * （挂在 `LandscapeStage` 的 `overlay` 槽）。两个落点各司其职：
 *  - 浮层项 `history`：**sticky**（`durationMs: 0`）到重试成功 —— 原因文案 + 「重试」动作；
 *  - 模板里的静态失败态（`.history__muted`）：`error` 非空且没有列表时显示，保证关掉浮层后
 *    玩家仍知道「这里是加载失败了」（不是「还没有对局记录」）。
 */
const notices = usePageNotices();
const { items: noticeItems } = notices;

function showHistoryError(text: string): void {
  notices.setNotice('history', text, {
    level: 'error',
    durationMs: 0,
    priority: 'critical',
    dismissible: true,
    actions: [{ label: '重试', onClick: () => void loadFirst() }],
  });
}

/** 已加载的斗地主对局（**服务端顺序**：`ended_at DESC` —— 本页不重排）。 */
const records = ref<MyRecord[]>([]);
/** 已加载的跑得快对局（S6.3；与斗地主分开存，形状不同、接口按 gameType 分支）。 */
const pdkRecords = ref<PdkRecord[]>([]);
/**
 * 玩法筛选（S6.3）：历史页按玩法分表（pdk 单独建表）。
 * 缺省斗地主 —— 旧行为/旧客户端零破坏；切玩法 = 重置列表 + cursor 重新拉第一页。
 */
const filterGame = ref<'doudizhu' | 'paodekuai'>('doudizhu');
/** 不透明游标：`null` = 没有下一页。 */
const nextCursor = ref<string | null>(null);
/** 首次请求在挂载时发出 ⇒ 初值 `true`，防「加载中 → 空态」闪跳。 */
const loading = ref(true);
/**
 * 失败态控制位（Task 6 起**不再直接渲染**）：非空 ⇒ 空列表分支显示静态失败态
 * （`.history__muted`）；具体原因与「重试」出口在 `NoticeStack` 的 `history` 项。
 */
const error = ref('');
/** 展开中的卡片键（`${roomCode}:${endedAt}` —— 房号可复用，必须带上结束时间）。 */
const expandedKeys = ref<ReadonlySet<string>>(new Set());

/**
 * P1-7：**请求代际**。每次 `load()` 自增；响应回来时代际不符 ⇒ 旧响应（翻页在途时
 * 用户切了筛选、或重放取代了它）一字节都不落：不追加列表、不覆盖 `nextCursor`、
 * 不改 `loading`/`error`。只靠 `loading` 闸挡不住已发出的请求。
 */
let loadGeneration = 0;

// ─── 2026-10 战绩筛选 ──────────────────────────────────────────────────────

/** 模式筛选：`undefined` = 全部；否则精确匹配。 */
const filterMode = ref<MyRecord['mode'] | undefined>(undefined);

/** 日期预设筛选（全部/今日/本周/本月）：缺省 'all'。 */
type DatePreset = 'all' | 'today' | 'week' | 'month';
const filterDate = ref<DatePreset>('all');

/** 下拉菜单打开标记：null = 全关；否则是当前打开的筛选组。 */
type FilterKey = 'game' | 'mode' | 'date';
const activeFilter = ref<FilterKey | null>(null);

/**
 * 点击切换下拉：点同一个 trigger 第二次关闭；
 * 点另一个 trigger 切换打开项。
 */
function toggleFilter(key: FilterKey) {
  activeFilter.value = activeFilter.value === key ? null : key;
}

/** 标签 → 显示值（下拉触发按钮用）。 */
const GAME_LABEL: Readonly<Record<typeof GAME_MODES[number]['id'], string>> = {
  doudizhu: '斗地主',
  paodekuai: '跑得快',
};
const MODE_LABEL_SHORT: Readonly<Record<string, string>> = {
  all: '全部',
  random: '匹配',
  practice: '好友房',
  gold: '金币场',
};
const DATE_LABEL: Readonly<Record<DatePreset, string>> = {
  all: '全部',
  today: '今日',
  week: '本周',
  month: '本月',
};

/** 关闭下拉（遮罩或 ESC 用）。 */
function closeFilterMenu() {
  activeFilter.value = null;
}

/** 日期预设 → `[from, to)` epoch ms 区间；`null` = 不筛。 */
function dateRangeOf(preset: DatePreset): { from?: number; to?: number } | null {
  if (preset === 'all') return null;
  const now = new Date();
  // 今日：当天 00:00 ~ 次日 00:00
  if (preset === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return { from, to: from + 86_400_000 };
  }
  // 本周：周一 00:00 ~ 下周一 00:00（getDay()：日=0，一=1 … 六=6；周一起点 = 今天 − (day − 1 + 7) % 7）
  if (preset === 'week') {
    const day = now.getDay();
    const mondayOffset = (day === 0 ? 6 : day - 1);
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset).getTime();
    return { from, to: from + 7 * 86_400_000 };
  }
  // 本月：当月 1 日 ~ 下月 1 日
  if (preset === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return { from, to };
  }
  return null;
}

/** 筛选改变：重置列表 + cursor，重新拉第一页。 */
function onFilterChange() {
  expandedKeys.value = new Set();
  void loadFirst();
}

/** 选模式；不传参 = 清空筛选。 */
function selectMode(mode?: MyRecord['mode']) {
  filterMode.value = mode;
  activeFilter.value = null;
  onFilterChange();
}

/** 选玩法（S6.3）：切表 + 重置列表。 */
function selectGame(game: 'doudizhu' | 'paodekuai') {
  if (filterGame.value === game) {
    activeFilter.value = null;
    return;
  }
  filterGame.value = game;
  activeFilter.value = null;
  onFilterChange();
}

/** 选日期预设。 */
function selectDate(preset: DatePreset) {
  filterDate.value = preset;
  activeFilter.value = null;
  onFilterChange();
}

/** 模式标签映射（**写死**：规格 §1 F4；禁「练习」）。键集与 DTO 联合类型逐字对齐（三值，② 金币场）。 */
const MODE_LABEL: Record<MyRecord['mode'], string> = {
  random: '匹配',
  practice: '好友房',
  gold: '金币场',
};
/** 身份标签（枚举 → 中文，与 `Settlement.vue` 同族；不是结果推导）。 */
const ROLE_LABEL: Record<MyRecordPlayer['role'], string> = { landlord: '地主', farmer: '农民' };

function recordKey(record: MyRecord): string {
  return `${record.roomCode}:${record.endedAt}`;
}

/** `endedAt`（epoch ms）→ 本地时间短格式。纯展示，不做任何换算/推导。 */
function formatTime(endedAt: number): string {
  const at = new Date(endedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 分差带符号原样展示（`+30` / `-15` / `0`）——**不取绝对值、不折叠正负**。 */
function formatDelta(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * 我那一行 —— **身份映射，不是结果推导**（与 `Settlement.vue` 的 `isMyRow` 同族）：
 * `mySeat` 与行座位号**都是服务端下发的**，这里只把它们对上。
 */
function mineOf(record: MyRecord): MyRecordPlayer | undefined {
  return record.players.find((p) => p.seat === record.mySeat);
}

/** 昵称回落（`table.vue:271-273` 的 `nameOf()` 同款）：昵称 → 「玩家{seat}」；我 → 「我」。 */
function playerName(record: MyRecord, p: MyRecordPlayer): string {
  return p.nickname ?? (p.seat === record.mySeat ? '我' : `玩家${p.seat}`);
}

/** 卡片视图模型：把我那一行接上（模板里不再重复 find）。**纯展示**。 */
const cards = computed(() =>
  records.value.map((record) => ({
    key: recordKey(record),
    record,
    mine: mineOf(record) ?? null,
    open: expandedKeys.value.has(recordKey(record)),
  })),
);

/** 跑得快卡片视图模型（S6.3）：我那一行 + 是否赢家。纯展示。 */
function pdkMineOf(record: PdkRecord): PdkRecord['players'][number] | undefined {
  return record.players.find((p) => p.seat === record.mySeat);
}
function pdkWon(record: PdkRecord): boolean {
  return record.winnerSeats.includes(record.mySeat);
}
function pdkName(record: PdkRecord, p: PdkRecord['players'][number]): string {
  return p.nickname ?? (p.seat === record.mySeat ? '我' : `玩家${p.seat}`);
}
function pdkKey(record: PdkRecord): string {
  return `pdk:${record.roomCode}:${record.endedAt}`;
}
const pdkCards = computed(() =>
  pdkRecords.value.map((record) => ({
    key: pdkKey(record),
    record,
    mine: pdkMineOf(record) ?? null,
    won: pdkWon(record),
    open: expandedKeys.value.has(pdkKey(record)),
  })),
);

function toggle(key: string) {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedKeys.value = next;
}

/**
 * 返回大厅（弹栈）。全局 `navigationStyle: custom` ⇒ 没有原生返回键，**必须有**这一颗
 * ——否则本页就是死胡同（本仓忌讳「把用户困住」的形态）。
 */
function onBack() {
  uni.navigateBack({ delta: 1 });
}

/**
 * 拉一页。`cursor === undefined` = 第一页（**替换**）；否则**追加**。
 *
 * 筛选参数来自 `filterMode` / `filterDate`（ref）——翻页时**保持不变**（keyset 分页在同一 WHERE 子集上）。
 * 改筛选由 `onFilterChange()` 触发：重置 cursor 和列表，重新拉第一页。
 *
 * 失败处置照既有惯例（`dispatchRestFailure` 查 `CLIENT_ACTION` 表，与大厅/玩法页同一套
 * 姿势，不另造 toast 形态）：`TOAST` ⇒ 静态失败态 + 浮层错误项（Task 6 起文案走
 * `playerMessage` 统一取值链）；`BACK_TO_LOBBY` ⇒ 清本地会话回登录页；
 * `REFRESH_SNAPSHOT`/`RECONNECT` 在 REST 语境退化为「重放一次」（`replayed` 保证最多一次）。
 */
function buildFetchOptions(cursor: string | undefined) {
  const opts: rest.FetchRecordsOptions = {};
  if (cursor !== undefined) opts.cursor = cursor;
  if (filterMode.value !== undefined) opts.mode = filterMode.value;
  const dr = dateRangeOf(filterDate.value);
  if (dr) {
    if (dr.from !== undefined) opts.from = dr.from;
    if (dr.to !== undefined) opts.to = dr.to;
  }
  return opts;
}

async function load(cursor: string | undefined, replayed = false) {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = '';
  try {
    if (filterGame.value === 'paodekuai') {
      const res = await rest.fetchPdkRecords(buildFetchOptions(cursor));
      if (res.code === 0) {
        const page = res.data ?? { items: [], nextCursor: null };
        pdkRecords.value = cursor === undefined ? page.items : [...pdkRecords.value, ...page.items];
        nextCursor.value = page.nextCursor;
        notices.dismiss('history');
        return;
      }
      await dispatchRestFailure(res, {
        toast: (report) => {
          error.value = `历史战绩加载失败：${playerMessage(report.code, {
            context: 'rest',
            serverMessage: report.message,
          })}`;
          showHistoryError(error.value);
        },
        signOutLocally: (report) => {
          stopGameSession();
          auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
        },
        replay: () => (replayed ? Promise.resolve() : load(cursor, true)),
      });
      return;
    }
    const res = await rest.fetchMyRecords(buildFetchOptions(cursor));
    // P1-7：晚到的旧响应直接丢弃（切筛选/重放已经发出了更新的一代）。
    if (generation !== loadGeneration) return;
    if (res.code === 0) {
      /**
       * 成功 = 服务端说什么就是什么（含空页）。`?? 空页` 只防**违约响应**（`code 0` 却不给
       * `data`）：那种响应等于「什么也没说」⇒ 与「空页」同一处置，绝不让它把已有列表打掉。
       */
      const page = res.data ?? { items: [], nextCursor: null };
      records.value = cursor === undefined ? page.items : [...records.value, ...page.items];
      nextCursor.value = page.nextCursor;
      // 成功（含重试成功/翻页成功）⇒ 收掉 sticky 失败项（同 id 状态位式提示的退场）。
      notices.dismiss('history');
      return;
    }
    await dispatchRestFailure(res, {
      toast: (report) => {
        error.value = `历史战绩加载失败：${playerMessage(report.code, {
          context: 'rest',
          serverMessage: report.message,
        })}`;
        showHistoryError(error.value);
      },
      // 令牌不可用：先销毁本地 WS 会话，再**带原因**清本地认证状态（回登录页）——与大厅/钱包
      // 同一条 R36 纪律 + Task 8 的 Global 约束：被踢回登录页必须留原因（登录页渲染 `auth.error`）；
      // 无参 `clearLocalSession()` 是静默踢出，玩家不知道为什么回到了登录页。
      signOutLocally: (report) => {
        stopGameSession();
        auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
      },
      replay: () => (replayed ? Promise.resolve() : load(cursor, true)),
    });
  } catch {
    // P1-7：旧一代的失败同样不上屏（新请求才是用户此刻等待的结果）。
    if (generation !== loadGeneration) return;
    /**
     * ⚠️ **H5 上 `fetch` 的拒绝会抛出**（`src/net/rest.ts:81-83` 记着这条传播行为）⇒
     * 少了这一支，网络故障（离线 / DNS / 连接被拒）会在挂载那一刻静默收场，只剩一个
     * unhandled rejection（单测里表现为**整包退出码 1**，`lobby.vue` 记着同款）。
     * 底层异常细节（`e.message`）对玩家没有可操作性（Task 6 起不再拼进文案）——
     * 提示固定为「稍后重试」+ 「重试」动作；排查靠上报链，不靠玩家转述。
     */
    error.value = '历史战绩加载失败，请稍后重试';
    showHistoryError(error.value);
  } finally {
    // P1-7：loading 归新一代所有 —— 旧请求收尾不得提前放行触底翻页。
    if (generation === loadGeneration) loading.value = false;
  }
}

/** 第一页 = 重置列表 + cursor 后 load(undefined)。筛选改变时调这个。 */
async function loadFirst() {
  records.value = [];
  pdkRecords.value = [];
  nextCursor.value = null;
  await load(undefined);
}

/** 到达列表底部（`scroll-view` 的 `@scrolltolower`）= 设计 D6 的翻页点。 */
function loadMore() {
  // 在途 / 终页都不再发：否则「一次触底翻多页」或「每次都拉第一页」的死循环。
  if (loading.value || nextCursor.value === null) return;
  void load(nextCursor.value);
}

onMounted(() => {
  void loadFirst();
});
</script>

<template>
  <LandscapeStage>
    <!--
      ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
      `classes()` 静默返回 `[]`（单根闸 `table-hud.test.ts` 盯着六页）。
      ⚠️ 三段互斥（`v-if` / `v-else-if` / `v-else`）：失败**不得**伪装成「还没有对局记录」。
    -->
    <view class="history">
      <view class="history__bar">
        <!-- 返回：次按钮语言（§5.2.1）。全局 navigationStyle: custom ⇒ 没有原生返回键。 -->
        <button type="button" class="btn btn--small history__back" @click="onBack">返回</button>
        <text class="history__title">历史战绩</text>
      </view>

      <!--
        筛选条（2026-10-27 UI 优化：下拉选择器替代胶囊按钮）。
        三组筛选 —— 玩法 / 场次 / 日期 —— 各占一个紧凑的下拉按钮，
        比原来平铺一排胶囊更节省横向空间、层次更清晰。
        同一时间只开一个下拉（activeFilter 互斥）。
      -->
      <view class="history__filters" @click="closeFilterMenu">
        <!-- 遮罩层：下拉打开时拦截外部点击（click.stop 让 trigger 能正常 toggle）。 -->
        <view v-if="activeFilter !== null" class="history__filter-shade" @click.stop="closeFilterMenu" />

        <!-- 玩法 -->
        <view class="history__filter-group" @click.stop>
          <text class="history__filter-label">玩法</text>
          <button
            type="button"
            class="history__select"
            :class="{ 'history__select--open': activeFilter === 'game' }"
            @click="toggleFilter('game')"
          >
            <text class="history__select-value">{{ GAME_LABEL[filterGame] }}</text>
            <text class="history__select-arrow">▾</text>
          </button>
          <view v-if="activeFilter === 'game'" class="history__dropdown">
            <button
              v-for="m in GAME_MODES"
              :key="m.id"
              type="button"
              class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterGame === m.id }"
              @click="selectGame(m.id)"
            >{{ m.name }}</button>
          </view>
        </view>

        <!-- 场次 -->
        <view class="history__filter-group" @click.stop>
          <text class="history__filter-label">场次</text>
          <button
            type="button"
            class="history__select"
            :class="{ 'history__select--open': activeFilter === 'mode' }"
            @click="toggleFilter('mode')"
          >
            <text class="history__select-value">{{ MODE_LABEL_SHORT[filterMode ?? 'all'] }}</text>
            <text class="history__select-arrow">▾</text>
          </button>
          <view v-if="activeFilter === 'mode'" class="history__dropdown">
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterMode === undefined }"
              @click="selectMode()"
            >全部</button>
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterMode === 'random' }"
              @click="selectMode('random')"
            >匹配</button>
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterMode === 'practice' }"
              @click="selectMode('practice')"
            >好友房</button>
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterMode === 'gold' }"
              @click="selectMode('gold')"
            >金币场</button>
          </view>
        </view>

        <!-- 日期 -->
        <view class="history__filter-group" @click.stop>
          <text class="history__filter-label">日期</text>
          <button
            type="button"
            class="history__select"
            :class="{ 'history__select--open': activeFilter === 'date' }"
            @click="toggleFilter('date')"
          >
            <text class="history__select-value">{{ DATE_LABEL[filterDate] }}</text>
            <text class="history__select-arrow">▾</text>
          </button>
          <view v-if="activeFilter === 'date'" class="history__dropdown">
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterDate === 'all' }"
              @click="selectDate('all')"
            >全部</button>
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterDate === 'today' }"
              @click="selectDate('today')"
            >今日</button>
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterDate === 'week' }"
              @click="selectDate('week')"
            >本周</button>
            <button type="button" class="history__dropdown-item"
              :class="{ 'history__dropdown-item--active': filterDate === 'month' }"
              @click="selectDate('month')"
            >本月</button>
          </view>
        </view>
      </view>

      <view class="history__body">
        <scroll-view
          v-if="records.length > 0 || pdkRecords.length > 0"
          class="history__list"
          scroll-y
          @scrolltolower="loadMore"
        >
          <template v-if="filterGame === 'doudizhu'">
          <view v-for="card in cards" :key="card.key" class="history__card">
            <!-- 摘要（整卡头部可点 = 展开/收起）。class 锚点：`.history__summary`。 -->
            <button type="button" class="history__summary" @click="toggle(card.key)">
              <view class="history__row">
                <text class="history__time">{{ formatTime(card.record.endedAt) }}</text>
                <text class="history__mode">{{ MODE_LABEL[card.record.mode] }}</text>
              </view>
              <view class="history__row">
                <!-- 我的身份与胜负：自 `mySeat` 定位那一行（服务端两字段对上，不推导）。 -->
                <text class="history__role">{{ card.mine ? ROLE_LABEL[card.mine.role] : '—' }}</text>
                <text
                  class="history__result"
                  :class="{
                    'history__result--win': card.mine?.won === true,
                    'history__result--lose': card.mine !== null && !card.mine.won,
                  }"
                >
                  {{ card.mine ? (card.mine.won ? '胜' : '负') : '—' }}
                </text>
                <text class="history__score">{{ card.mine ? formatDelta(card.mine.scoreChange) : '—' }}</text>
                <!--
                  ② 金币场（§14）：**仅 `mode='gold'` 行**显示金币列 —— 我那一行的
                  `moneyDelta`（服务端 NULL 是值：「非金币场 / 尚未回写」⇒ 显「—」，
                  **不下沉成 0**）。非金币行整格不存在（不是显示 0）。
                -->
                <text v-if="card.record.mode === 'gold'" class="history__money">
                  {{ card.record.moneyDelta === null ? '—' : formatDelta(card.record.moneyDelta) }}
                </text>
                <text class="history__expand">{{ card.open ? '收起' : '展开' }}</text>
              </view>
            </button>

            <!-- 展开：三家明细（昵称/身份/分 + 17 张手牌）+ 底牌 3 张。牌面全部复用共用件。 -->
            <view v-if="card.open" class="history__detail">
              <view v-for="p in card.record.players" :key="p.seat" class="history__player">
                <view class="history__player-head">
                  <text class="history__player-name">{{ playerName(card.record, p) }}</text>
                  <text class="history__player-role">{{ ROLE_LABEL[p.role] }}</text>
                  <text class="history__player-score">{{ formatDelta(p.scoreChange) }}</text>
                </view>
                <!-- `enter="none"`：历史记录不做发牌动效（那是开局的语汇）。 -->
                <Hand :cards="p.hand" size="small" enter="none" />
              </view>
              <view class="history__bottom">
                <text class="history__bottom-title">底牌</text>
                <BottomCards :cards="card.record.bottomCards" />
              </view>
            </view>
          </view>
          </template>

          <!-- S6.3：跑得快战绩（不同于斗地主：无地主/底牌；显示名次、剩余张数、倍数与标记）。 -->
          <template v-else>
            <view v-for="card in pdkCards" :key="card.key" class="history__card history__card--pdk">
              <button type="button" class="history__summary" @click="toggle(card.key)">
                <view class="history__row">
                  <text class="history__time">{{ formatTime(card.record.endedAt) }}</text>
                  <text class="history__mode">{{ MODE_LABEL[card.record.mode] }}</text>
                  <text class="history__mode">跑得快</text>
                  <text class="history__mode">{{ card.record.playerCount }} 人局</text>
                </view>
                <view class="history__row">
                  <text
                    class="history__result"
                    :class="{
                      'history__result--win': card.won,
                      'history__result--lose': !card.won,
                    }"
                  >{{ card.won ? '胜' : '负' }}</text>
                  <text class="history__score">{{ card.mine ? formatDelta(card.mine.scoreChange) : '—' }}</text>
                  <text class="history__mode">剩余 {{ card.record.remaining[card.record.mySeat] ?? 0 }} 张</text>
                  <text class="history__mode">倍数 {{ card.record.multiplier }}</text>
                  <text v-if="card.record.mode === 'gold'" class="history__money">
                    {{ card.record.moneyDelta === null ? '—' : formatDelta(card.record.moneyDelta) }}
                  </text>
                  <text class="history__expand">{{ card.open ? '收起' : '展开' }}</text>
                </view>
              </button>

              <view v-if="card.open" class="history__detail">
                <view class="history__row history__pdk-tags">
                  <text class="history__mode">炸弹 {{ card.record.bombCount }}</text>
                  <text v-if="card.record.guan" class="history__mode">关牌</text>
                  <text v-if="card.record.spring" class="history__mode">春天</text>
                  <text v-if="card.record.baobenSeats.length > 0" class="history__mode">保本</text>
                </view>
                <view v-for="p in card.record.players" :key="p.seat" class="history__player">
                  <view class="history__player-head">
                    <text class="history__player-name">{{ pdkName(card.record, p) }}</text>
                    <text class="history__player-role">剩余 {{ card.record.remaining[p.seat] ?? 0 }} 张</text>
                    <text class="history__player-role">出牌 {{ p.playedCount }} 张</text>
                    <text class="history__player-score">{{ formatDelta(p.scoreChange) }}</text>
                  </view>
                  <Hand :cards="p.hand" size="small" enter="none" />
                </view>
              </view>
            </view>
          </template>
        </scroll-view>

        <text v-else-if="loading" class="history__muted">加载中…</text>
        <!--
          加载失败的**静态兜底**（Task 6）：原因与「重试」出口在浮层 `history` 项里；
          这里保证关掉浮层后仍能区分「失败了」与「还没有对局记录」（三段互斥不变）。
        -->
        <text v-else-if="error" class="history__muted">历史战绩加载失败</text>
        <text v-else class="history__empty">还没有对局记录</text>
      </view>
    </view>

    <!-- 提示浮层（Task 6）：失败原因 + 「重试」动作，不占列表文档流。 -->
    <template #overlay>
      <NoticeStack :items="noticeItems" surface="history" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/**
 * 视觉语言照抄总规格 §5.2.1（半透明深蓝面板 / 次按钮语言 / 金色强调）；
 * 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（只引用，不改定义）。
 * 面板语言与 `lobby.vue` / `game.vue` 的弹层同族（同类容器同观感）。
 */
.history {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
.history__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-6;
  min-height: $ftl-bar-h;
}
/**
 * 筛选条（2026-10-27 UI 优化：下拉选择器替代胶囊按钮）。
 * 三组筛选紧凑排列在一行 —— 比原来 12 个胶囊按钮省横向空间、层次更清晰。
 * 用 position: relative 包住 filter-shade（全屏遮罩，下拉打开时关外面的点击）。
 */
.history__filters {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-5;
  padding: $ftl-space-3 $ftl-space-4;
  border: $ftl-hairline solid rgba($ftl-color-night-deep, 0.6);
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.3);
}
/**
 * 遮罩层：下拉打开时拦截 filter 区域外的点击。
 * absolute 覆盖整屏 —— 因为 .history__filters 是相对定位，遮罩相对于它定位。
 * 高度 100vh 足够覆盖整个舞台（横屏场景）。
 */
.history__filter-shade {
  position: absolute;
  top: 100%;
  left: 0;
  width: 100%;
  height: 100vh;
  z-index: 5;
}
/**
 * 单个筛选组：label + select 按钮（compact inline）。
 * position: relative —— 下拉浮层 .history__dropdown 定位在它下面。
 */
.history__filter-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.history__filter-label {
  flex: 0 0 auto;
  color: rgba($ftl-color-on-primary, 0.6);
  font-size: $ftl-font-xs;
  white-space: nowrap;
}
/**
 * 下拉触发按钮：冷灰弱底 + 淡描边 + 右对齐箭头。
 * 宿主是 `<button>` ⇒ flex 居中 + margin:0 是 uni-button 的标准骨架。
 */
.history__select {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: $ftl-space-2;
  margin: 0;
  padding: 0 $ftl-space-4;
  min-height: $ftl-control-h-sm;
  border: $ftl-hairline solid rgba($ftl-color-night-soft, 0.5);
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.35);
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
  background-image: none;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
/** 打开态：金色描边 + 更深底（选中态高亮）。 */
.history__select--open {
  border-color: $ftl-color-gold-light;
  background: rgba($ftl-color-gold-deep, 0.28);
}
.history__select-value {
  white-space: nowrap;
}
.history__select-arrow {
  flex: 0 0 auto;
  color: rgba($ftl-color-on-primary, 0.5);
  font-size: $ftl-font-xs;
  line-height: 1;
  transition: transform 0.15s;
}
.history__select--open .history__select-arrow {
  color: $ftl-color-gold-light;
  transform: rotate(180deg);
}
/**
 * 下拉浮层：absolute 定位在 trigger 下方。
 * z-index 高于 filter-shade（shade 是 5，这里给 10）。
 * 宽度用 min-width 贴合 trigger 宽度，避免选项被压缩。
 */
.history__dropdown {
  position: absolute;
  top: calc(100% + $ftl-space-2);
  left: 0;
  min-width: 120px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  padding: $ftl-space-2;
  border: $ftl-hairline solid rgba($ftl-color-night-deep, 0.8);
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night, 0.92);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.history__dropdown-item {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  margin: 0;
  padding: $ftl-space-2 $ftl-space-4;
  min-height: $ftl-control-h-sm;
  border: none;
  border-radius: $ftl-radius-sm;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
  background-image: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.history__dropdown-item:hover {
  background: rgba($ftl-color-night-deep, 0.5);
}
/** 选中项：金色文字 + 浅金底。 */
.history__dropdown-item--active {
  background: rgba($ftl-color-gold-deep, 0.22);
  color: $ftl-color-gold-light;
  font-weight: 600;
}
/**
 * 返回：次按钮语言（§5.2.1 —— 透明底 + 实线描边 + 白字）。`margin: 0` 压掉 uni-button 的 auto 边距。
 * ⚠️ 选择器**必须**带 `.history` 前缀：`.btn { @include ftl-btn }` 在本文件**末尾**，
 * 同特指度下后者胜（产物 CSS 实测：`.btn[data-v-…]` 排在 `.history__back[data-v-…]` 之后）
 * ⇒ 单类选择器的「透明底 / 无贴图 / 白字」会被 mixin 的 `background:#fff` + `url(btn2.png)`
 * 反吃回去（`.game__friends .btn:not(.btn--primary)` 是同一手法）。
 */
.history .history__back {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.history__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** 列表面板（与大厅两栏同一个面板语言）。 */
.history__body {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: $ftl-space-4;
  min-height: 0;
  padding: $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.85);
}
/**
 * 面板内的中性标签字（「加载中…」/静态失败态/空态共用）。Task 6 起失败**原因**在
 * `NoticeStack` 浮层（`.notice--error`），这里只剩「状态位」文案 —— 故三态同一条规则
 * （旧的 `.history__error` 内联错误行已删）。
 */
.history__muted,
.history__empty {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 列表：`scroll-view` 是**自己的**滚动容器（舞台整页不滚动，见文件头）。 */
.history__list {
  flex: 1 1 0;
  min-height: 0;
}
/** 一局卡片：描边 + 压暗一档的底（在面板之上再分层）。 */
.history__card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  margin-bottom: $ftl-space-4;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.35);
}
/** 摘要 = 整卡头部可点的 `<button>`（R762 的「可点即 button」）；重置按钮宿主默认样式。 */
.history__summary {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-3;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.history__row {
  display: flex;
  align-items: center;
  gap: $ftl-space-5;
}
.history__time {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
  line-height: 1.2;
}
/** 模式标签：金色描边的胶囊（§5.2.1 的强调色只给「重点」，标签算轻度强调）。 */
.history__mode {
  flex: 0 0 auto;
  padding: 0 $ftl-space-4;
  border: $ftl-hairline solid $ftl-color-gold-deep;
  border-radius: $ftl-radius-pill;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xs;
  line-height: 1.4;
}
.history__role {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
}
/** 胜负：赢 = 金字、输 = 深底上的亮红（§5.2.1 的专用令牌）。 */
.history__result {
  flex: 0 0 auto;
  font-size: $ftl-font-md;
  font-weight: 700;
}
.history__result--win {
  color: $ftl-color-gold-light;
}
.history__result--lose {
  color: $ftl-color-danger-on-dark;
}
.history__score {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-md;
}
/** ② 金币列（仅 `mode='gold'` 行）：金色档 —— 与「我的分」区分开，它是钱不是分。 */
.history__money {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-md;
  font-weight: 600;
}
/** 「展开/收起」提示：贴右，弱化（它只是可点性的可见提示，不是按钮）。 */
.history__expand {
  margin-left: auto;
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-xs;
}
/** 展开区：与摘要以发丝线分隔。 */
.history__detail {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  padding-top: $ftl-space-4;
  border-top: $ftl-hairline solid $ftl-color-night-deep;
}
.history__player {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
}
.history__player-head {
  display: flex;
  align-items: center;
  gap: $ftl-space-5;
}
.history__player-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  font-weight: 600;
  line-height: 1.2;
}
.history__player-role {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-xs;
}
.history__player-score {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
}
.history__bottom {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
}
.history__bottom-title {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-sm;
}
/** 本页原生 `<button class="btn …">` 的观感自持（与 `lobby.vue` / `game.vue` 同款两条）。 */
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
</style>
