/**
 * 底分档位 + 选中底分（片规格 §3 的「两页之间的接口」）。
 *
 * ① ② ③ 组是 **store 单元**（Task 1）；④ ⑤ ⑥ 组是**大厅页**（Task 4）。
 *
 * ⚠️ 大厅那三组的挂载姿势逐字照抄 `lobby-modes.test.ts`：`beforeEach` 建**一个** pinia
 * 并 `setActivePinia`，页面经 `global.plugins` 拿到的**必须**是同一个实例 ——
 * 否则用例里 `useGameStore()` 拿到的是另一个 store，断言会静默失配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession, saveSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { installUniStub } from './helpers/uni-stub';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  installUniStub(); // 大厅要读本地会话（`clearSession` / `saveSession` 走 uni 存储 API）
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

describe('① 底分档位 + 选中底分是**跨页载体**（片规格 §3）', () => {
  it('两个 setter 写进 store；selectedLevelName 按**选中的**底分查场次名', () => {
    const store = useGameStore();
    expect(store.baseScoreLevels, '起始态必须是空数组（不是 undefined）').toEqual([]);
    expect(store.selectedBaseScore, '起始态必须是 null —— **不预置一个缺省底分**（那是前端规则常量）').toBeNull();
    expect(store.selectedLevelName, '没选之前查不到场次名').toBeNull();

    // 片⑦：档位表与好友房开关**同一条响应**（`GET /api/config`）⇒ 一次写入；
    // ② 金币场：7 键全给；支付片 T14 再扩到 14 键、广告片 T19 加第 15 键 `reliefAdpid: ''`
    // （本组只消费档位表，其余键给**一组稳定值**——本文件无 oracle 读它们，取关态即可）。
    store.setClientConfig({
      baseScoreLevels: [
        { name: '休闲场', baseScore: 15 },
        { name: '标准场', baseScore: 80 },
      ],
      friendRoomEnabled: false,
      freeRoomEnabled: true,
      goldRoomEnabled: false,
      reliefEnabled: false,
      reliefAdpid: '',
      entryMultiplier: 10,
      // 支付片 T14：扩至 14 键（本文件只消费档位表，支付七键给稳定关态即可）。
      rechargeEnabled: false,
      withdrawEnabled: false,
      coinPerYuan: null,
      rechargePackages: [],
      withdrawMinCoins: null,
      withdrawMaxCoinsPerOrder: null,
      withdrawDailyMaxCoins: null,
      withdrawReAuthEnabled: false,
      version: 5,
    });
    store.setSelectedBaseScore(80);

    expect(store.selectedLevelName, '必须按**选中的**底分查，不是取第一条').toBe('标准场');
  });

  it('查不到的底分 ⇒ selectedLevelName 为 null（**不编名字**）', () => {
    const store = useGameStore();
    store.setClientConfig({
      baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
      friendRoomEnabled: false,
      freeRoomEnabled: true,
      goldRoomEnabled: false,
      reliefEnabled: false,
      reliefAdpid: '',
      entryMultiplier: 10,
      // 支付片 T14：扩至 14 键（本文件只消费档位表，支付七键给稳定关态即可）。
      rechargeEnabled: false,
      withdrawEnabled: false,
      coinPerYuan: null,
      rechargePackages: [],
      withdrawMinCoins: null,
      withdrawMaxCoinsPerOrder: null,
      withdrawDailyMaxCoins: null,
      withdrawReAuthEnabled: false,
      version: 5,
    });
    store.setSelectedBaseScore(999);
    expect(store.selectedLevelName).toBeNull();
  });

  it('③ reset() 不动这两个字段（页面的选择 vs 对局状态）', () => {
    const store = useGameStore();
    store.setClientConfig({
      baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
      friendRoomEnabled: false,
      freeRoomEnabled: true,
      goldRoomEnabled: false,
      reliefEnabled: false,
      reliefAdpid: '',
      entryMultiplier: 10,
      // 支付片 T14：扩至 14 键（本文件只消费档位表，支付七键给稳定关态即可）。
      rechargeEnabled: false,
      withdrawEnabled: false,
      coinPerYuan: null,
      rechargePackages: [],
      withdrawMinCoins: null,
      withdrawMaxCoinsPerOrder: null,
      withdrawDailyMaxCoins: null,
      withdrawReAuthEnabled: false,
      version: 5,
    });
    store.setSelectedBaseScore(15);
    store.setMatching(true);

    store.reset();

    expect(store.baseScoreLevels, 'reset 是**对局**边界，不清页面的选择').toHaveLength(1);
    expect(store.selectedBaseScore).toBe(15);
    /**
     * 正对照：对局状态确实被清了 —— 否则这条与「reset 什么也没做」不可区分。
     * ⚠️ 用 `matching`（本用例**显式置脏**过）而**不是** `view`：`view` 从 `state()` 的初值起
     * 一直是 `null`，断言它恒真、零判别力（复核发现）。
     */
    expect(store.matching).toBe(false);
  });
});

/** `fetch` 替身：按 URL 分流（客户端配置 / 其它）。片⑦ 起档位表与好友房开关**同一条响应**。 */
function stubRoutes(routes: Record<string, unknown>, fallback: unknown = { code: 0, data: [] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.includes(k));
      return { ok: true, status: 200, text: async () => JSON.stringify(key ? routes[key] : fallback) };
    }),
  );
  return calls;
}

/** `GET /api/config` 的成功响应（② 金币场的 7 键：档位表 + 四个门控位 + 倍率 + 版本）。 */
const CONFIG_OK = {
  code: 0,
  data: {
    baseScoreLevels: [
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
    ],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 5,
  },
};

function mountLobby(): VueWrapper {
  startGameSession(() => new FakeSocket());
  useAuthStore().navigate('lobby');
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

describe('④ 大厅取客户端配置：成功渲染卡，失败**一张卡都不渲染**（不猜底分）', () => {
  it('成功 ⇒ 每档一张卡，名字与底分都来自服务端', async () => {
    stubRoutes({ '/config': CONFIG_OK });
    const wrapper = mountLobby();
    await flushPromises();

    const cards = wrapper.findAll('.lobby__level');
    expect(cards, '两档 ⇒ 两张卡').toHaveLength(2);
    expect(wrapper.findAll('.lobby__level-name').map((n) => n.text())).toEqual(['休闲场', '标准场']);
    expect(wrapper.find('.lobby__level-base').text(), '底分来自服务端（不是写死的）').toContain('15');
    expect(wrapper.find('.lobby__levels-empty').exists(), '成功时不该有状态位行').toBe(false);
  });

  it('🔴 信封非 0 ⇒ 报错文案 + **零张卡**（用户无从选 ⇒ 不会猜一个底分）', async () => {
    stubRoutes({ '/config': { code: 10007, message: '下游不可用', data: null } });
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findAll('.lobby__level'), '拿不到档位表就不得渲染任何一档').toHaveLength(0);
    expect(wrapper.find('.lobby__levels-empty').text()).toContain('档位表加载失败');
  });

  it('code 0 但空表 ⇒ 同样零张卡 + 如实报错', async () => {
    stubRoutes({
      '/config': {
        code: 0,
        data: {
          baseScoreLevels: [],
          friendRoomEnabled: false,
          freeRoomEnabled: true,
          goldRoomEnabled: false,
          reliefEnabled: false,
          entryMultiplier: 10,
          version: 5,
        },
      },
    });
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findAll('.lobby__level')).toHaveLength(0);
    expect(wrapper.find('.lobby__levels-empty').text()).toContain('档位表为空');
  });

  it('🔴 fetch 被拒（H5 上会抛出）⇒ 如实报错、零张卡、不炸出 unhandled rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findAll('.lobby__level')).toHaveLength(0);
    expect(wrapper.find('.lobby__levels-empty').text()).toContain('档位表加载失败');
  });

  it('🔴 10004（BACK_TO_LOBBY）⇒ 走 dispatchRestFailure：清本地会话回登录页（R34/R36）', async () => {
    /**
     * 前置：**先真的登录过**（否则「回登录页」这条断言在「本来就在登录页」上恒真）。
     *
     * ⚠️ **`/auth/refresh` 必须显式 stub 成也失败**（复核订正）：本用例存了 `refreshToken: 'r1'`
     * ⇒ `rest.rotateOnce()` 的 `if (!stored?.refreshToken) return false` **不会**早退，
     * 它会**真的发一次** `POST /auth/refresh`。若不 stub，这次请求会落到 `stubRoutes` 的
     * fallback `{ code: 0, data: [] }` ⇒ `!res.data?.accessToken` ⇒ 轮换仍然失败
     * ⇒ 断言**照样绿，但绿的理由与注释写的不是一回事**（那是「引用未核」的隐身版）。
     * ⇒ 把「轮换也失败」**明写出来**，让这条用例断言的机制与它声称的一致。
     */
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const auth = useAuthStore();
    expect(auth.hydrate(), '前置：必须真的拿到会话').toBe(true);
    expect(auth.loggedIn).toBe(true);
    stubRoutes({
      '/config': { code: 10004, message: '令牌已过期', data: null },
      '/auth/refresh': { code: 10004, message: 'refresh 令牌也已失效', data: null },
    });

    const wrapper = mountLobby();
    await flushPromises();

    expect(auth.loggedIn, '10004 轮换不成就按 CLIENT_ACTION 表处置').toBe(false);
    expect(auth.page, '必须回登录页（旧的档位表失败路径会停在原地显示「加载失败」）').toBe('login');
    /**
     * Task 8：回登录页的**原因**落在 `auth.error`（由登录页 Task 5 的 watch 渲染成浮层项），
     * 大厅页不渲染它 —— 这里断言 store 里的原因本身，不在 LobbyPage 的 DOM 上找。
     */
    expect(auth.error).toBe('登录状态已失效，请重新登录');
    expect(wrapper.findAll('.lobby__level')).toHaveLength(0);
  });
});

describe('⑤ 点底分卡 = 写选中底分 + 进开始游戏页（片规格 §3 裁决一）', () => {
  it('写 store 并跳页；顺序不可反（页面挂载时就要读得到）', async () => {
    stubRoutes({ '/config': CONFIG_OK });
    const wrapper = mountLobby();
    await flushPromises();

    const store = useGameStore();
    expect(store.selectedBaseScore, '点之前没有选中值').toBeNull();

    const setSelected = vi.spyOn(store, 'setSelectedBaseScore');
    await wrapper.findAll('.lobby__level')[1]!.trigger('click'); // 第二张 = 标准场 80

    expect(setSelected, '必须真的调了 setSelectedBaseScore（不是靠缺省值）').toHaveBeenCalledWith(80);
    expect(store.selectedBaseScore).toBe(80);
    expect(store.selectedLevelName, '场次名跟着选中值走').toBe('标准场');
    expect(useAuthStore().page, '点底分卡才进开始游戏页').toBe('game');
  });
});

describe('⑥ 顶栏资料：昵称来自登录响应，**不再有资料网络取数**（Task 2R + ② 余额 chip）', () => {
  it('登录响应带昵称 ⇒ 昵称进信息条；挂载恰好发「配置 + 余额」两条请求，**没有第三条**', async () => {
    const calls = stubRoutes({ '/config': CONFIG_OK });
    /**
     * Task 2R（用户裁决 2026-09-27）：资料改由**登录响应**经 `applySession` 写进 store ——
     * 此前那条 `GET /api/users/me` 经网关**恒 401**（`forward()` 不转发 `Authorization`），
     * 而且失败折成 `10007`、不产生 `console.error`，探针与单测都看不见。
     *
     * ② 金币场（2026-10-04）：挂载期新增**第二条**有意为之的请求 —— 余额 chip 的
     * `GET /api/wallet/balance`（§14「登录后拉、回厅刷新」）。判据从「只发一条」收紧为
     * 「**恰好** config + wallet/balance 两条」：多出任何第三发（尤其资料取数复活）当场红。
     */
    useAuthStore().applySession({
      accessToken: 'a1',
      refreshToken: 'r1',
      user: { id: 'u1', phone: '13800000000', nickname: '阿豆' },
    });

    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.find('.lobby__player .chip__name').text()).toBe('阿豆');
    expect(wrapper.findAll('.lobby__level'), '档位区不受影响').toHaveLength(2);
    const others = calls.filter((c) => !c.url.includes('/config') && !c.url.includes('/wallet/balance'));
    expect(others, '挂载后不得发第三条请求（资料取数已撤销；余额只有 wallet/balance 一条）').toEqual([]);
    expect(calls.filter((c) => c.url.includes('/config')), '配置一条').toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/wallet/balance')), '余额一条').toHaveLength(1);
  });
});

describe('⑦ 台费「入场费」行（档位项 entryFeePercent；仅金币场且 >0 渲染）', () => {
  /** 金币场在开，档位项给 15⇒10%（入场费 1）与 80⇒12%（入场费 9，floor(9.6)）。 */
  const GOLD_FEE_CONFIG_OK = {
    code: 0,
    data: {
      baseScoreLevels: [
        { name: '休闲场', baseScore: 15, entryFeePercent: 10 },
        { name: '标准场', baseScore: 80, entryFeePercent: 12 },
      ],
      friendRoomEnabled: false,
      freeRoomEnabled: true,
      goldRoomEnabled: true,
      reliefEnabled: false,
      entryMultiplier: 10,
      version: 5,
    },
  };

  it('金币场 + 档位项 percent>0 ⇒ 逐档渲染「入场费 N 金币」（entryFeeOfLevel 与服务端同一实现；未命中档不渲染）', async () => {
    stubRoutes({ '/config': GOLD_FEE_CONFIG_OK });
    const wrapper = mountLobby();
    await flushPromises();

    // 「仅金币场」半边（自审补强）：默认（免费场）不渲染入场费行 —— 去掉金币场 guard 的实现此条红。
    expect(wrapper.findAll('.lobby__level-fee')).toHaveLength(0);

    useGameStore().setRoomMode('gold');
    await flushPromises();

    const fees = wrapper.findAll('.lobby__level-fee').map((n) => n.text());
    expect(fees.join('|')).toContain('入场费 1 金币'); // 15 × 10% ⇒ max(1, floor(1.5)) = 1
    expect(fees.join('|')).toContain('入场费 9 金币'); // 80 × 12% ⇒ floor(9.6) = 9
    expect(wrapper.findAll('.lobby__level-fee')).toHaveLength(2);
  });

  it('档位项 percent=0 / 缺字段 ⇒ 不渲染入场费行、不阻塞卡片', async () => {
    stubRoutes({
      '/config': {
        code: 0,
        data: {
          ...GOLD_FEE_CONFIG_OK.data,
          baseScoreLevels: [
            { name: '休闲场', baseScore: 15, entryFeePercent: 0 },
            { name: '标准场', baseScore: 80 }, // 缺字段 = 0
          ],
        },
      },
    });
    const wrapper = mountLobby();
    await flushPromises();
    useGameStore().setRoomMode('gold');
    await flushPromises();

    expect(wrapper.findAll('.lobby__level-fee')).toHaveLength(0);
    expect(wrapper.findAll('.lobby__level')).toHaveLength(2); // 卡片照常、入场不阻塞
    expect(wrapper.find('.lobby__levels-empty').exists()).toBe(false);
  });
});

describe('⑧ 档位表失败 ⇒ sticky `levels` 浮层项 +「重试」收口（Task 8 修复轮）', () => {
  /**
   * 覆盖缺口：修复轮 1 之前**没有任何用例**引用 `[data-notice-id="levels"]` ——
   * 「失败项 sticky + 重试动作」这条主路径只有实现、没有判据。
   */
  it('10007 ⇒ sticky（越过 error 缺省 TTL 8s 仍在）+「重试」；重试成功 ⇒ 项消失、卡渲染', async () => {
    /** 路由表由 `stubRoutes` 按**引用**捕获 ⇒ 重试前把 `/config` 改回成功响应即可。 */
    const routes: Record<string, unknown> = {
      '/config': { code: 10007, message: '下游不可用', data: null },
    };
    stubRoutes(routes);

    /**
     * 🔴 sticky 的判别力靠**假时钟**：error 级的缺省 TTL 是 8s —— 若实现漏了
     * `durationMs: 0`，下面的 `advanceTimersByTime(9000)` 会把项摘掉、断言当场红。
     * 只替换 `setTimeout/clearTimeout`：`flushPromises` 的调度器（VTU 模块加载时捕获的
     * 真 `setImmediate`）与其他时钟不受影响。
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const wrapper = mountLobby();
      await flushPromises();

      const item = () => wrapper.find('[data-notice-id="levels"]');
      expect(item().exists(), '10007 ⇒ 必须出现 levels 浮层项').toBe(true);
      expect(item().find('.notice__text').text()).toContain('档位表加载失败，请稍后重试');
      const actionLabels = item()
        .findAll('.notice__action')
        .map((a) => a.text().replace(/\s+/g, ' ').trim());
      expect(actionLabels, '唯一的处置出口 =「重试」').toEqual(['重试']);

      // sticky：越过 error 级缺省 TTL（8s）+ 余量，项不得自行消失
      vi.advanceTimersByTime(9000);
      await flushPromises();
      expect(
        item().exists(),
        'sticky（durationMs: 0）⇒ 8s 后仍在；漏了 durationMs: 0 的实现在此红',
      ).toBe(true);

      // 重试 ⇒ 命中成功响应 ⇒ 成功分支 `dismiss('levels')`
      routes['/config'] = CONFIG_OK;
      await item().find('.notice__action').trigger('click');
      await flushPromises();

      expect(item().exists(), '重试成功 ⇒ levels 项必须消失').toBe(false);
      expect(wrapper.findAll('.lobby__level'), '成功后档位卡照常渲染').toHaveLength(2);
      expect(wrapper.find('.lobby__levels-empty').exists(), '静态失败句随卡片一起退场').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
