/**
 * 记录片 T8（规格 §2.3 / §1 F1–F5 · 设计 D6）：头像入口 +「历史战绩」页。
 *
 * 判别矩阵（每条都对着一种「最像正确答案」的错实现）：
 *  ① **入口**：PlayerChip 真的可点（点开**页内弹层**、不跳页）；弹层是**列表结构**（1 项也建表）；
 *     条目点击 → `uni.navigateTo('/pages/history/history')`，且目标与 `pages.json` 同提交登记的
 *     第 5 页**逐字一致**（两处漂移 = 真机导航失败——这条判据就是把它变得看得见的那只眼）；
 *     遮罩关闭走「裸 click + 面板 `.stop`」（`.self` 在 uni-app H5 里恒真 ⇒ handler 恒被吞）；
 *  ② **REST**：`GET /api/records/mine`、带鉴权、信封解析；`cursor` **原样透传**（拿含 URL
 *     保留字符的样例才有判别力：漏 `encodeURIComponent` 会在**解码面**现形）；非 0 原样交回；
 *  ③ **列表**：服务端顺序**原样渲染**（倒序是服务端的，不是客户端排的）；`scrolltolower` 用
 *     `nextCursor` 翻页、**追加不替换**、终页（`null`）后**不再发请求**（拦「每次都拉第一页」）；
 *  ④ **空态/失败态**：「还没有对局记录」／静态失败态 + `NoticeStack` 浮层错误项（Task 6
 *     提示浮层化：失败**不得**伪装成空态；fetch 被拒也要收口，不能只剩 unhandled rejection）；
 *  ⑤ **摘要**：时间 / 模式标签（`random→匹配`、`practice→好友房`；**禁「练习」字样**——
 *     渲染面与全 src 源码面各一条负断言）/ 我的身份与胜负（自 `mySeat` 定位那一行）/ 我的分；
 *  ⑥ **展开**：三家明细（昵称 →「玩家{seat}」回落，`nickname===null`；我那一行是 `table.vue`
 *     `nameOf()` 同款的「我」）+ 各 17 张手牌 + 底牌 3 张——牌面**复用** `Hand`/`BottomCards`/
 *     `Card`（按**数组件计数**钉住复用，而不是只看文本）；
 *  ⑦ **返回**：`navigateBack`（子页是压栈形态；没有它就是死胡同）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from '@fight-the-landlord/protocol';
import type { MyRecord, MyRecordPlayer } from '../src/net/rest';
import * as rest from '../src/net/rest';
import HistoryPage from '../src/pages/history/history.vue';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import CardComponent from '../src/components/Card.vue';
import PlayerChip from '../src/components/PlayerChip.vue';
import { useAuthStore } from '../src/stores/auth';
import { clearSession, saveSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { stopGameSession } from '../src/composables/useGameSession';
import { SRC_ROOT, collectSourceFiles, stripComments } from './helpers/source-scan';
import { installUniStub, type UniStub } from './helpers/uni-stub';

/** 断言模板文本时先折叠空白，避免被模板换行干扰。 */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** 记录 `fetch` 的每一次调用（`rest.ts` 只用到 `status` 与 `text()`）。 */
interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(route: (call: FetchCall) => unknown, status = 200) {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(route({ url, init })) };
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

// ---------------------------------------------------------------------------
// 夹具（形状逐字对应规格 §2.3 的 11 键 DTO）
// ---------------------------------------------------------------------------

/** 17 张合法牌（张数与值域都对得上真契约；`r∈3..14`、`s` 递增）。 */
function hand17(): Card[] {
  return Array.from({ length: 17 }, (_, i) => ({ r: 3 + (i % 12), s: i % 5 }));
}

/** 恰 3 张底牌。 */
function bottom3(): Card[] {
  return [
    { r: 17, s: 4 },
    { r: 20, s: 4 },
    { r: 14, s: 0 },
  ];
}

function playerFixture(seat: number, over: Partial<MyRecordPlayer> = {}): MyRecordPlayer {
  return { seat, nickname: null, role: 'farmer', scoreChange: 0, won: false, hand: hand17(), ...over };
}

/** 2026-10-03 14:05（**本地时区**构造 —— 展示格式按本地时间渲染，跨时区跑也稳定）。 */
const T0 = new Date(2026, 9, 3, 14, 5).getTime();
const T1 = T0 + 60_000;

function recordFixture(over: Partial<MyRecord> = {}): MyRecord {
  return {
    roomCode: 'ROOM01',
    mode: 'random',
    endedAt: T0,
    baseScore: 15,
    winner: 'landlord',
    landlordSeat: 0,
    multiplier: 2,
    spring: 'none',
    /** ② 金币场：`moneyDelta` 的缺省是 **`null`**（非金币场 / 尚未回写 —— NULL 是值不是 0）。 */
    moneyDelta: null,
    mySeat: 0,
    bottomCards: bottom3(),
    players: [
      playerFixture(0, { role: 'landlord', scoreChange: 30, won: true }),
      playerFixture(1, { scoreChange: -15 }),
      playerFixture(2, { scoreChange: -15 }),
    ],
    ...over,
  };
}

function page(items: MyRecord[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

let pinia: ReturnType<typeof createPinia>;
let uni: UniStub;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  uni = installUniStub();
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

/** 挂历史页：`route` 按调用序作答（第一页带 cursor=null，第二页带游标……）。 */
function mountHistory(route: (call: FetchCall, index: number) => unknown) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(route({ url, init }, calls.length - 1)),
      };
    }),
  );
  const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

/** 挂大厅（入口所在页）：`/config` 给空档位表 + 关闸（② 起 7 键）。 */
function mountLobby() {
  stubFetch((call) =>
    call.url.includes('/config')
      ? {
          code: 0,
          data: {
            baseScoreLevels: [],
            friendRoomEnabled: false,
            freeRoomEnabled: true,
            goldRoomEnabled: false,
            reliefEnabled: false,
            entryMultiplier: 10,
            version: 0,
          },
        }
      : { code: 0, data: { items: [], nextCursor: null } },
  );
  useAuthStore().navigate('lobby');
  uni.resetCalls();
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

// ---------------------------------------------------------------------------
// ① 入口：头像 → 页内弹层 → 历史战绩（F1/F3 · 设计 D6）
// ---------------------------------------------------------------------------

describe('① 入口：头像可点 → 弹层（列表结构）→ navigateTo（F3）', () => {
  it('弹层关着时不在 DOM；点头像打开：列表结构 + 恰 1 项「历史战绩」', async () => {
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findComponent(PlayerChip).exists(), '前置：大厅顶栏有 PlayerChip').toBe(true);
    const entry = wrapper.find('.lobby__player-entry');
    expect(entry.exists(), 'PlayerChip 必须包一层可点容器（F3）').toBe(true);
    expect(entry.findComponent(PlayerChip).exists(), '可点容器里就是 PlayerChip 本体').toBe(true);

    // 「收进弹层」的可证伪语义：关着的时候整棵子树不在 DOM 里（MoreMenu ① 同款）
    expect(wrapper.find('.lobby__menu').exists(), '弹层关着时不得在 DOM 里').toBe(false);

    await entry.trigger('click');

    expect(wrapper.find('.lobby__menu').exists(), '点头像 ⇒ 页内弹层打开（**不是**跳页）').toBe(true);
    expect(
      wrapper.find('.lobby__menu-list').exists(),
      '1 项也做列表结构（将来加「设置」只加数据、不改结构）',
    ).toBe(true);
    const items = wrapper.findAll('.lobby__menu-item');
    expect(items.map((i) => flat(i.text()))).toEqual(['历史战绩']);
    // 弹层是页内的：没有发生任何页面栈投影
    expect(uni.calls.reLaunch, '弹层不是路由（auth.page 仍是唯一状态源）').toEqual([]);
  });

  it('点「历史战绩」→ navigateTo 到 pages.json 同提交登记的第 5 页（两处漂移会红）', async () => {
    const wrapper = mountLobby();
    await flushPromises();

    await wrapper.find('.lobby__player-entry').trigger('click');
    await wrapper.findAll('.lobby__menu-item')[0]!.trigger('click');

    expect(uni.calls.navigateTo, '子页是**压栈**形态：navigateTo（不是 reLaunch）').toEqual([
      '/pages/history/history',
    ]);
    expect(wrapper.find('.lobby__menu').exists(), '导航后弹层收起').toBe(false);

    /**
     * 规格 §1 F1：`pages.json` **同提交**注册第 5 页 —— 否则真机导航失败（单测看不见的形态）。
     * 这条把「目标字符串」与「声明」钉在一起：改一处漏另一处当场红。
     */
    const pagesJson = JSON.parse(readFileSync(join(SRC_ROOT, 'pages.json'), 'utf8')) as {
      pages: { path: string }[];
      subPackages?: { root: string; pages: { path: string }[] }[];
    };
    // 项 6：历史页已移到 subPackages，主包与分包声明一起展开。
    const declared = [
      ...pagesJson.pages.map((p) => `/${p.path}`),
      ...(pagesJson.subPackages ?? []).flatMap((sp) => sp.pages.map((p) => `/${sp.root}/${p.path}`)),
    ];
    expect(
      declared,
      'navigateTo 的目标必须是 pages.json 里声明过的页面',
    ).toContain(uni.calls.navigateTo[0]);
  });

  it('遮罩裸 click 关闭、面板内点击不关闭（`.self` 在 uni-app H5 里恒真 ⇒ 全仓禁）', async () => {
    const wrapper = mountLobby();
    await flushPromises();

    await wrapper.find('.lobby__player-entry').trigger('click');
    expect(wrapper.find('.lobby__menu').exists()).toBe(true);

    await wrapper.find('.lobby__menu-panel').trigger('click');
    expect(wrapper.find('.lobby__menu').exists(), '面板内点击不得关闭（.stop 与遮罩裸 click 的分工）').toBe(
      true,
    );

    await wrapper.find('.lobby__menu').trigger('click');
    expect(wrapper.find('.lobby__menu').exists(), '点遮罩关闭').toBe(false);

    // 机械面：不得再用 `.self`（真机实测恒被吞；替代形态 = 裸 click + 容器根 @click.stop）
    const lobby = collectSourceFiles().find((f) => f.path === 'src/pages/lobby/lobby.vue');
    expect(lobby, 'lobby.vue 必须在扫描集合里').toBeDefined();
    expect(lobby!.content, '遮罩关闭不得用 .self').not.toMatch(/click\.self/);
  });
});

// ---------------------------------------------------------------------------
// ② REST：fetchMyRecords（F4 · 规格 §2.3）
// ---------------------------------------------------------------------------

describe('② rest.fetchMyRecords：GET /api/records/mine（信封 + 游标透传）', () => {
  it('GET + 带鉴权；第一页不带 cursor；信封解析出 { items, nextCursor }', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { calls } = stubFetch(() => ({ code: 0, data: page([recordFixture()], 'NEXT-1') }));

    const res = await rest.fetchMyRecords();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/records/mine');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    expect(calls[0]!.url, '第一页不带 cursor（服务端从第一页开始）').not.toContain('cursor=');
    expect(res.code).toBe(0);
    expect(res.data?.items).toHaveLength(1);
    expect(res.data?.nextCursor).toBe('NEXT-1');
  });

  it('cursor 原样透传：含 URL 保留字符的样例经编码往返后**逐字相等**（不解析、不构造）', async () => {
    /**
     * 样例刻意带 `+` `/` `=`：`+` 在查询串里会被解成空格（网关侧注释记着同一条）——
     * 漏 `encodeURIComponent` 的实现在 `searchParams.get('cursor')` 上当场现形。
     * 真实服务端今天发 base64url（URL 安全），但「原样透传」是对**不透明串**的承诺，
     * 不依赖当前字母表。
     */
    const cursor = 'MTc2MDAwMDAwMDAwMDox+8=/x';
    const { calls } = stubFetch(() => ({ code: 0, data: page([], null) }));

    await rest.fetchMyRecords({ cursor });

    const url = new URL(calls[0]!.url, 'http://example.test');
    expect(url.pathname).toBe('/api/records/mine');
    expect(url.searchParams.get('cursor'), 'cursor 必须原样往返（原样回传 = 不解析）').toBe(cursor);
  });

  it('非 0 信封原样交回调用方（不伪造成功）', async () => {
    stubFetch(() => ({ code: 10007, message: '下游不可用', data: null }));

    const res = await rest.fetchMyRecords();

    expect(res.code).toBe(10007);
    expect(res.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ 历史页：列表 / 摘要 / 空态 / 失败态 / 翻页
// ---------------------------------------------------------------------------

describe('③ 历史页：列表与摘要（F2 · 规格 §2.3 的展示面）', () => {
  it('挂载即拉第一页；服务端顺序原样渲染（倒序是服务端给的，不是客户端排的）', async () => {
    const newer = recordFixture({ roomCode: 'ROOM02', endedAt: T1 });
    const older = recordFixture({ roomCode: 'ROOM01', endedAt: T0 });
    const { wrapper, calls } = mountHistory(() => ({ code: 0, data: page([newer, older], null) }));
    await flushPromises();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/records/mine');
    expect(wrapper.findAll('.history__card')).toHaveLength(2);
    expect(
      wrapper.findAll('.history__time').map((t) => flat(t.text())),
      '渲染顺序 = 服务端顺序（本页不重排）',
    ).toEqual(['2026-10-03 14:06', '2026-10-03 14:05']);
    expect(wrapper.find('[data-notice-id="history"]').exists(), '成功加载不留失败提示项').toBe(false);
  });

  it('摘要：模式标签（匹配/好友房）+ 我的身份与胜负（自 mySeat 定位）+ 我的分', async () => {
    const practiced = recordFixture({
      roomCode: 'ROOM02',
      mode: 'practice',
      mySeat: 1,
      players: [
        playerFixture(0, { role: 'landlord', scoreChange: -30 }),
        playerFixture(1, { role: 'farmer', scoreChange: 15, won: true }),
        playerFixture(2, { role: 'farmer', scoreChange: 15, won: true }),
      ],
    });
    const matched = recordFixture({
      roomCode: 'ROOM01',
      mode: 'random',
      mySeat: 0,
      players: [
        playerFixture(0, { role: 'landlord', scoreChange: -30, won: false }),
        playerFixture(1, { role: 'farmer', scoreChange: 15, won: true }),
        playerFixture(2, { role: 'farmer', scoreChange: 15, won: true }),
      ],
    });
    const { wrapper } = mountHistory(() => ({ code: 0, data: page([practiced, matched], null) }));
    await flushPromises();

    expect(wrapper.findAll('.history__mode').map((t) => flat(t.text()))).toEqual(['好友房', '匹配']);

    // 我那一行 = `mySeat` 定位的那一行（第 1 局的 mySeat=1 ⇒ 农民·胜·+15）
    expect(flat(wrapper.find('.history__role').text())).toBe('农民');
    expect(flat(wrapper.find('.history__result').text())).toBe('胜');
    expect(wrapper.find('.history__result').classes()).toContain('history__result--win');
    expect(flat(wrapper.find('.history__score').text())).toBe('+15');

    // 第 2 局（mySeat=0 ⇒ 地主·负·-30）——胜负必须**跟着 mySeat 走**，不是「总有一个人赢」的近似
    const second = wrapper.findAll('.history__card')[1]!;
    expect(flat(second.find('.history__role').text())).toBe('地主');
    expect(flat(second.find('.history__result').text())).toBe('负');
    expect(second.find('.history__result').classes()).toContain('history__result--lose');
    expect(flat(second.find('.history__score').text())).toBe('-30');
  });

  it('「练习」是禁词（规格 §1 F4）：渲染面与全 src 源码面各一条负断言', async () => {
    const { wrapper } = mountHistory(() =>
      ({ code: 0, data: page([recordFixture({ mode: 'random' }), recordFixture({ mode: 'practice', roomCode: 'ROOM02' })], null) }),
    );
    await flushPromises();

    expect(wrapper.text()).not.toContain('练习');
    /**
     * 源码面按 R572 读**剥注释视图**：本仓的注释习惯是**逐字引用被禁的写法**（本文件的头注释、
     * `history.vue` 的映射注释都点名了这个禁词）——读原始文本会把「解释这条禁令」本身打红，
     * 唯一能变绿的做法是删掉解释（方向反了）。剥注释后仍在的字面量 = 真违规（如标签写死）。
     */
    const offenders = collectSourceFiles()
      .filter((f) => stripComments(f.content).includes('练习'))
      .map((f) => f.path);
    expect(offenders, 'practice 的标签是「好友房」——「练习」字样不得出现在 src/** 的代码里').toEqual([]);

    // 判别力自证：真违规（代码里的字面量）必须被这条判据报出
    expect(stripComments(`const label = '练习';`), '代码里的字面量必须存活于剥注释视图').toContain('练习');
  });

  it('空态：「还没有对局记录」', async () => {
    const { wrapper } = mountHistory(() => ({ code: 0, data: page([], null) }));
    await flushPromises();

    expect(flat(wrapper.find('.history__empty').text())).toBe('还没有对局记录');
    expect(wrapper.findAll('.history__card')).toHaveLength(0);
    expect(wrapper.find('[data-notice-id="history"]').exists(), '空页不是失败：不得有错误提示项').toBe(
      false,
    );
  });

  /**
   * Task 6（G3 浮层挂载闸）：失败时页面保留**静态失败态**（文档流里的兜底），
   * 具体原因/出路在 `NoticeStack` 浮层项（sticky + 重试动作）。
   * 判别力：
   *  · `.history__error` 旧的**内联错误行**必须不存在（两处都渲染 = 双提示）；
   *  · 浮层项文案 = `playerMessage(10007)` 的**固定文案**（不是服务端 message「上游不可用」）
   *    —— 钉住「错误码 → 玩家文案」的统一取值链；
   *  · 静态失败态仍让玩家知道「这里加载失败了」，不至于只剩一条可被关掉的浮层项。
   */
  it('加载失败显示静态失败态 + 一条 sticky 错误项（可重试）', async () => {
    stubFetch(() => ({ code: 10007, message: '上游不可用', data: null }), 500);
    const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('.history__error').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="history"] .notice__text').text()).toContain('服务暂时不可用，请稍后重试');
    expect(wrapper.find('.history__muted').text()).toContain('历史战绩加载失败');
    expect(
      wrapper.find('[data-notice-id="history"] .notice__action').text(),
      '玩家必须有出路：重试动作',
    ).toContain('重试');
  });

  it('失败态（信封非 0）：静态失败态 + 浮层错误项 —— 不得伪装成空态', async () => {
    const { wrapper } = mountHistory(() => ({ code: 10007, message: '下游不可用', data: null }));
    await flushPromises();

    const muted = wrapper.find('.history__muted');
    expect(muted.exists(), '失败必须给出可见的静态失败态').toBe(true);
    expect(flat(muted.text())).toContain('历史战绩加载失败');
    const notice = wrapper.find('[data-notice-id="history"] .notice__text');
    expect(notice.exists(), '失败原因/出路在浮层项里（.history__error 内联行已退役）').toBe(true);
    expect(flat(notice.text())).toContain('历史战绩加载失败');
    expect(flat(notice.text()), '10007 走固定文案（不用服务端 message）').toContain(
      '服务暂时不可用，请稍后重试',
    );
    expect(wrapper.find('.history__empty').exists(), '失败不得伪装成「还没有对局记录」').toBe(false);
  });

  it('失败态（fetch 被拒）：同样收口成静态失败态 + 浮层错误项（否则只剩 unhandled rejection）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(flat(wrapper.find('.history__muted').text())).toContain('历史战绩加载失败');
    expect(wrapper.find('[data-notice-id="history"] .notice__text').text()).toContain('请稍后重试');
  });

  /**
   * Task 8 收口（跨任务 Global 约束）：BACK_TO_LOBBY 的处置与大厅/钱包同一姿势 ——
   * `stopGameSession(); auth.sessionEnded(playerMessage(code, { context: 'auth' }))`。
   * 判别力：无参 `clearLocalSession()` 也会回登录页，但**静默**踢出（登录页 `auth` 项无原因）——
   * 这条用例把「回登录页」与「带原因」一起钉住；`auth.error` 的断言在错误实现下当场红。
   */
  it('10004（BACK_TO_LOBBY）⇒ 清本地会话回登录页且带原因；本页不渲染加载失败提示', async () => {
    /**
     * 前置：**先真的登录过**（否则「回登录页」这条断言在「本来就在登录页」上恒真）——
     * 与 `base-score-selection.test.ts` 的 10004 用例同款姿势。
     */
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const auth = useAuthStore();
    expect(auth.hydrate(), '前置：必须真的拿到会话').toBe(true);
    expect(auth.loggedIn).toBe(true);
    stubFetch(() => ({ code: 10004, message: '令牌已过期', data: null }));
    const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(auth.loggedIn, '10004 按 CLIENT_ACTION 表处置（BACK_TO_LOBBY ⇒ 清本地）').toBe(false);
    expect(auth.page, '必须回登录页').toBe('login');
    expect(
      auth.error,
      'Task 8：被踢必须带原因（登录页渲染 auth.error）——无参 clearLocalSession 会静默踢出',
    ).toBe('登录状态已失效，请重新登录');
    // 被踢不是「历史战绩加载失败」：本页不得渲染内联错误行或浮层错误项
    expect(wrapper.find('.history__error').exists(), '内联错误行已退役，被踢也不得复活').toBe(false);
    expect(wrapper.find('[data-notice-id="history"]').exists(), '被踢不走 toast 路径').toBe(false);
    expect(flat(wrapper.text())).not.toContain('历史战绩加载失败');
  });
});

describe('③ 历史页：翻页（scrolltolower + nextCursor 原样透传）', () => {
  it('到达底部 → 用 nextCursor 拉下一页；追加不替换；终页（null）后不再发请求', async () => {
    const cursor = 'MTc2MDAwMDAwMDAwMDox+8=/x'; // 含保留字符：透传的判别力见 ② 的同款样例
    const { wrapper, calls } = mountHistory((_call, index) =>
      index === 0
        ? { code: 0, data: page([recordFixture({ roomCode: 'ROOM02', endedAt: T1 })], cursor) }
        : { code: 0, data: page([recordFixture({ roomCode: 'ROOM01', endedAt: T0 })], null) },
    );
    await flushPromises();
    expect(calls).toHaveLength(1);

    await wrapper.find('.history__list').trigger('scrolltolower');
    await flushPromises();

    expect(calls).toHaveLength(2);
    const url = new URL(calls[1]!.url, 'http://example.test');
    expect(url.searchParams.get('cursor'), 'nextCursor 原样回传（不解析、不构造）').toBe(cursor);
    expect(wrapper.findAll('.history__card'), '第二页是**追加**，不是替换').toHaveLength(2);

    // 终页：nextCursor === null ⇒ 到达底部不再发请求（拦「每次都拉第一页」的死循环）
    await wrapper.find('.history__list').trigger('scrolltolower');
    await flushPromises();
    expect(calls).toHaveLength(2);
  });

  it('翻页在途期间再次触底不并发重放（loading 闸）', async () => {
    let n = 0;
    const pending: Array<() => void> = [];
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        n += 1;
        if (n === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: page([recordFixture()], 'CUR-1') }) };
        }
        await new Promise<void>((resolve) => {
          pending.push(resolve);
        });
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: page([], null) }) };
      }),
    );
    const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(calls, '前置：第一页已回来').toHaveLength(1);

    await wrapper.find('.history__list').trigger('scrolltolower');
    await Promise.resolve();
    expect(calls, '第二发已在途').toHaveLength(2);

    // 在途期间再触底：不得再发（否则「一次触底翻多页」——逐页的游标语义会被打乱）
    await wrapper.find('.history__list').trigger('scrolltolower');
    await Promise.resolve();
    expect(calls).toHaveLength(2);

    for (const resolve of pending) resolve();
    await flushPromises();
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ④ 展开：三家明细 + 手牌 + 底牌（牌面复用共用件）
// ---------------------------------------------------------------------------

describe('④ 展开：三家明细 ×17 张 + 底牌 3 张（牌面复用 Hand/BottomCards/Card）', () => {
  it('点摘要展开：每家 17 张手牌、底牌 3 张；再点收起', async () => {
    const { wrapper } = mountHistory(() => ({ code: 0, data: page([recordFixture()], null) }));
    await flushPromises();

    expect(wrapper.find('.history__detail').exists(), '默认收起').toBe(false);
    expect(wrapper.findAllComponents(CardComponent), '收起时一张牌都不在 DOM 里').toHaveLength(0);

    await wrapper.find('.history__summary').trigger('click');

    expect(wrapper.find('.history__detail').exists()).toBe(true);
    const players = wrapper.findAll('.history__player');
    expect(players, '恰三家明细').toHaveLength(3);
    for (const [i, row] of players.entries()) {
      expect(row.findAll('.card'), `第 ${i + 1} 家必须是 17 张手牌`).toHaveLength(17);
    }
    expect(wrapper.findAll('.history__bottom .card'), '底牌恰 3 张').toHaveLength(3);
    // **复用**的机械形态：整块明细共 3×17+3 张牌，全部来自共用件（Card 组件计数）
    expect(wrapper.findAllComponents(CardComponent)).toHaveLength(3 * 17 + 3);
    // 每家的身份与分也原样（服务端字段）
    expect(wrapper.findAll('.history__player-role').map((t) => flat(t.text()))).toEqual([
      '地主',
      '农民',
      '农民',
    ]);
    expect(flat(wrapper.find('.history__player-score').text())).toBe('+30');

    await wrapper.find('.history__summary').trigger('click');
    expect(wrapper.find('.history__detail').exists(), '再点收起').toBe(false);
  });

  it('昵称回落（table.vue nameOf 同款）：昵称原样 → 玩家{seat}（null）→ 我（自己那行）', async () => {
    const { wrapper } = mountHistory(() =>
      ({
        code: 0,
        data: page(
          [
            recordFixture({
              mySeat: 0,
              players: [
                playerFixture(0), // 我：nickname === null
                playerFixture(1, { nickname: '阿豆' }), // 有昵称：原样
                playerFixture(2), // 对手、无昵称：玩家{seat} 回落
              ],
            }),
          ],
          null,
        ),
      }),
    );
    await flushPromises();
    await wrapper.find('.history__summary').trigger('click');

    expect(wrapper.findAll('.history__player-name').map((t) => flat(t.text()))).toEqual([
      '我',
      '阿豆',
      '玩家2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 返回：子页压栈形态
// ---------------------------------------------------------------------------

describe('⑤ 返回按钮', () => {
  it('点「返回」→ uni.navigateBack（子页是压栈的；没有返回就是死胡同）', async () => {
    const { wrapper } = mountHistory(() => ({ code: 0, data: page([], null) }));
    await flushPromises();

    const back = wrapper.find('.history__back');
    expect(back.exists(), '历史页必须有返回入口（全局 navigationStyle: custom ⇒ 没有原生返回键）').toBe(
      true,
    );
    await back.trigger('click');

    expect(uni.calls.navigateBack).toEqual([1]);
    expect(uni.calls.reLaunch, '返回不得走 reLaunch（那会把大厅重开一遍）').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑥ ② 金币场：金币列 +「金币场」标签（§14 / 服务端 DTO 12 键的 `moneyDelta`）
// ---------------------------------------------------------------------------

/**
 * ② 金币场（§14）：`mode='gold'` 行显**我那一行**的 `moneyDelta`；`NULL` 是值（「—」）；
 * 非金币行**整格不存在**（不是显 0、也不是显「—」——那会把「没有这回事」渲染成一条数据）。
 *
 * 判别矩阵：
 *  · 三值 label 映射（random/practice/gold ⇒ 匹配/好友房/金币场）—— 缺 gold 键会渲染 undefined；
 *  · 正负号：`formatDelta` 与「我的分」同款（+250 / -120）；
 *  · `null` ⇒「—」（拦「下沉成 0」与「整格消失」两种错实现）；
 *  · 非 gold 行**没有**这一格（拦「所有行都加列」）。
 */
describe('⑥ ② 战绩金币列（moneyDelta /「金币场」标签）', () => {
  it('mode 中文映射三值：random=匹配 / practice=好友房 / gold=金币场', async () => {
    const { wrapper } = mountHistory(() => ({
      code: 0,
      data: page(
        [
          recordFixture({ roomCode: 'R1', mode: 'random', endedAt: T0 + 120_000 }),
          recordFixture({ roomCode: 'R2', mode: 'practice', endedAt: T0 + 60_000 }),
          recordFixture({ roomCode: 'R3', mode: 'gold', endedAt: T0 }),
        ],
        null,
      ),
    }));
    await flushPromises();

    expect(wrapper.findAll('.history__mode').map((t) => flat(t.text()))).toEqual([
      '匹配',
      '好友房',
      '金币场',
    ]);
  });

  it('金币列：gold 行显 moneyDelta（带符号）；NULL ⇒「—」；非 gold 行**整格不存在**', async () => {
    const { wrapper } = mountHistory(() => ({
      code: 0,
      data: page(
        [
          recordFixture({ roomCode: 'R1', mode: 'gold', moneyDelta: 250 }),
          recordFixture({ roomCode: 'R2', mode: 'gold', moneyDelta: -120 }),
          recordFixture({ roomCode: 'R3', mode: 'gold', moneyDelta: null }),
          recordFixture({ roomCode: 'R4', mode: 'random', moneyDelta: null }),
        ],
        null,
      ),
    }));
    await flushPromises();

    const cards = wrapper.findAll('.history__card');
    expect(flat(cards[0]!.find('.history__money').text()), '正数带 +').toBe('+250');
    expect(flat(cards[1]!.find('.history__money').text()), '负数原样带 -').toBe('-120');
    expect(
      flat(cards[2]!.find('.history__money').text()),
      'NULL 是值（非金币场 / 尚未回写）⇒「—」——不下沉成 0',
    ).toBe('—');
    expect(
      cards[3]!.find('.history__money').exists(),
      '非金币行不显金币格（不是显 0 也不是显 —）',
    ).toBe(false);
    expect(wrapper.findAll('.history__money'), '全页恰 3 格（3 条 gold 行）').toHaveLength(3);
  });
});

/**
 * ⑦ 筛选胶囊的垂直居中（2026-10-22 玩家截图的走查修复）。
 *
 * 宿主是 `<button>` ⇒ H5/App-vue 编译成 `uni-button`，基样式 `display: block`；
 * 本页又把 `line-height` 压成 1.4、给了 `min-height: $ftl-control-h-sm`（56px）——
 * 块级盒里的行盒**顶对齐**，多出的高度全落在文字**下面** ⇒ 胶囊文字明显偏高
 * （实测偏 ~10px；文字越少越显眼）。
 * 修法与 `ftl-btn` mixin 同一条骨架：胶囊自身 flex 居中，不靠 line-height 撞高度。
 *
 * ⚠️ 射程诚实：jsdom 没有布局引擎，这里只能钉「居中骨架在场」；真实像素由截图验收。
 */
describe('⑦ 筛选胶囊：文字垂直居中（uni-button 是 display:block，min-height 撑高后行盒顶对齐）', () => {
  it('.history__chip 用 flex 居中（display:flex + align-items/justify-content:center）', () => {
    const historySrc = stripComments(readFileSync(join(SRC_ROOT, 'pages/history/history.vue'), 'utf8'));
    const start = historySrc.search(/\.history__chip\s*\{/);
    const end = historySrc.indexOf('.history__chip--active');
    expect(start, '`.history__chip` 基础块必须存在').toBeGreaterThanOrEqual(0);
    expect(end, '`.history__chip--active` 必须排在基础块之后').toBeGreaterThan(start);
    const block = historySrc.slice(start, end);
    expect(block, 'uni-button 基样式是 display:block：不改成 flex，行盒会顶对齐').toMatch(
      /display\s*:\s*flex\s*;/,
    );
    expect(block, 'align-items:center 是垂直居中的那条腿').toMatch(/align-items\s*:\s*center\s*;/);
    expect(block, 'justify-content:center 是水平居中的那条腿').toMatch(
      /justify-content\s*:\s*center\s*;/,
    );
  });
});

/**
 * P1-7：翻页与筛选的**竞态**。
 *
 * 场景：第 2 页（加载更多）在途时用户切筛选 ⇒ 新第一页先回来、旧第 2 页后到。
 * 旧实现无条件 `records = [...records, ...page.items]` 并覆盖 `nextCursor`
 * ⇒ 旧筛选的行混进新列表、新 `nextCursor`（null）被旧游标覆盖、「到达底部」再次发请求。
 *
 * 判据：旧响应一字节都不落 —— 不追加、不覆盖 cursor、不改 loading/错误。
 */
describe('P1-7：加载更多与筛选切换的竞态', () => {
  it('先发「加载更多」再切筛选：旧响应后到不追加、不覆盖新 cursor', async () => {
    const calls: FetchCall[] = [];
    let releaseOldPage!: (response: unknown) => void;

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const index = calls.length - 1;
        if (index === 1) {
          // 「加载更多」的第 2 页：挂住，稍后**后于**筛选响应返回。
          return new Promise((resolve) => {
            releaseOldPage = resolve;
          });
        }
        const body =
          index === 0
            ? { code: 0, data: page([recordFixture({ roomCode: 'ROOM-A', endedAt: T0 })], 'C1') }
            : { code: 0, data: page([recordFixture({ roomCode: 'ROOM-B', endedAt: T1 })], null) };
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
        });
      }),
    );

    const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.findAll('.history__card')).toHaveLength(1);

    // 第 2 页在途……
    await wrapper.find('.history__list').trigger('scrolltolower');
    await flushPromises();

    // ……此时切筛选（新第一页立刻返回）。
    const goldChip = wrapper
      .findAll('.history__chip')
      .find((chip) => chip.text().trim() === '金币场');
    expect(goldChip, '筛选胶囊必须存在').toBeDefined();
    await goldChip!.trigger('click');
    await flushPromises();

    expect(calls[2]!.url).toContain('mode=gold');
    expect(wrapper.findAll('.history__card'), '筛选结果替换列表').toHaveLength(1);

    // 旧第 2 页后到：不得追加、不得把 nextCursor（null）覆盖成 C_OLD。
    releaseOldPage({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          data: page([recordFixture({ roomCode: 'ROOM-OLD', endedAt: T0 - 60_000 })], 'C_OLD'),
        }),
    });
    await flushPromises();

    expect(wrapper.findAll('.history__card'), '旧响应不得污染新列表').toHaveLength(1);

    // 新列表已是终页（nextCursor=null）⇒ 触底不再发请求；旧游标若覆盖了它，这里会多第 4 发。
    await wrapper.find('.history__list').trigger('scrolltolower');
    await flushPromises();
    expect(calls).toHaveLength(3);
  });
});
