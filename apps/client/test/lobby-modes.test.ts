/**
 * ➋ 大厅的玩法入口区（spec §5-➋ + R745/R746/R752 + roadmap §2.2）。
 *
 * 判据三条：
 *  ① 结构上存在**玩法选择容器 + 玩法卡**，现在**只有一个**玩法；
 *  ② 玩法卡**整体可点**（R745/R762）：点击**只切换选中**（写 `store.activeMode`）、**不跳页**
 *     —— 进开始游戏页靠点**底分卡**（片规格 §3 裁决一，本片的行为变更）。
 *     **R652 已作废**（R746：它的理由是测试脆弱性，不是产品决定）⇒「进入」按钮与
 *     提示文案（`modeHint` / `.lobby__hint`）随之没了 —— 旧用例**成对迁移**成本组正反两面；
 *  ③ **源码级**：没有第二个玩法的任何实现/规则常量，也没有「在线人数」这类凭空的字段。
 *
 * ⚠️ 开局区（四条开局路径）**不在本文件**，而且它的覆盖**分在两家**（片③ Task 3 起随开局区
 * 一起挂到玩法页）：**开始游戏**（含 12009 幂等 / 取消匹配 / 12007 复位）与**手动房号加入**
 * 在 `auth-ui-wiring`（用例名逐字带「开始游戏」「取消匹配」「手动「加入」」）；**创建房间**
 * （含失败态）与**房间列表项**（含两路归一化）在 `lobby-ux`（用例名带「创建房间」「房间列表项」）。
 * 原先这里那条「路径仍在大厅」随 R652 一起撤出 —— 判据没丢，只是此后由上面两家继续守。
 *
 * ⚠️ 挂载脚手架照抄 `lobby-ux.test.ts` 的 `mountLobby` 形态：`GET /api/rooms` 由 `stubFetch`
 * 顶掉、WS 会话由 `startGameSession(() => new FakeSocket())` 顶掉 —— 本页这两条依赖在
 * 既有契约测试里**只有这一种**已被验证的替身方式，不另造一套。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { RoomInfo } from '@fight-the-landlord/protocol';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import type { SocketFactory } from '../src/net/transport';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import { FakeSocket } from './helpers/fake-socket';

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

function capturingFactory() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

/**
 * 源码级判据的两条扫描——**生产断言与正对照共用同一份实现**（否则正对照只是空转）。
 *
 * · `modeIds()` 是**计数/存在性**形态 ⇒ 按 R572/R622 读**原始文本**，且**只截 `GAME_MODES`
 *   字面量块**（`[^=]*` 吃掉类型标注 —— 片③ Task 2 起这个字面量在 `src/gameModes.ts`）：
 *   对整份文件抽 `id: '…'` 会让将来任何 `id: 'x'`（组件 props、注释举例）
 *   以「只有一个玩法」这条**错误信息**变红。
 * · `FORBIDDEN_FIELDS` / `SECOND_MODE` 是**违规类**判据 ⇒ 按 R572/R622 **必须**读剥注释视图
 *   （`helpers/source-scan.ts` 的 `stripComments`）：读原始文本会把「解释这条禁令的注释」
 *   本身打红，于是唯一能变绿的做法是删掉解释——方向反了（本文件顶注释即引 R572）。
 */
function modeIds(raw: string): string[] {
  const block = /const GAME_MODES[^=]*= \[[\s\S]*?\]/.exec(raw)?.[0] ?? '';
  return [...block.matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!);
}
const FORBIDDEN_FIELDS = /在线人数|onlineCount|playerOnline/;
const SECOND_MODE = /mahjong|majiang|麻将/;

/** ② 金币场：稳定的 7 键配置夹具（免费场开 = 与种子一致；金币场**显式**关 ——
    默认态已经 2026-10-04 用户裁决翻为开，这里构造「单开免费」的左格）。 */
const STABLE_CONFIG = {
  code: 0,
  data: {
    baseScoreLevels: [
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
    ],
    friendRoomEnabled: true,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 3,
  },
};

/** ② 双开关都开的配置（场次切换用例的底座）。 */
const GOLD_CONFIG = {
  code: 0,
  data: { ...STABLE_CONFIG.data, goldRoomEnabled: true },
};

/** S5.4：多玩法客户端配置（ddz 开 / pdk 可开可关）。 */
const gamesConfig = (pdkEnabled: boolean) => ({
  code: 0,
  data: {
    ...STABLE_CONFIG.data,
    games: {
      doudizhu: {
        enabled: true,
        supportedPlayerCounts: [3],
        defaultPlayerCount: 3,
        baseScoreLevels: [
          { name: '休闲场', baseScore: 15 },
          { name: '标准场', baseScore: 80 },
        ],
      },
      paodekuai: {
        enabled: pdkEnabled,
        supportedPlayerCounts: [3],
        defaultPlayerCount: 3,
        baseScoreLevels: [{ name: '快跑场', baseScore: 80 }],
      },
    },
  },
});

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

describe('➋ 大厅的玩法入口区（玩法卡）', () => {
  /**
   * 片② 金币场起，大厅挂载会发**两条** REST：`GET /api/config`（场次/档位/开关）与
   * `GET /api/wallet/balance`（余额 chip）。本组只关心左栏玩法卡，config 给一份
   * 「免费场开、金币场关」的稳态（与种子一致），其余请求落兜底。
   */
  function mountLobby(list: RoomInfo[] = [], config: unknown = STABLE_CONFIG) {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    stubFetch((call) =>
      call.url.includes('/config')
        ? config
        : call.url.includes('/wallet/balance')
          ? { code: 0, data: { balance: 0 } }
          : { code: 0, data: list },
    );
    /**
     * 「用户已经在大厅」的前置：生产里由 `hydrate()` / `navigate('lobby')` 写成 ——
     * 这里照 `page-stack.test.ts` 的既有办法用**唯一入口** `navigate()` 补上，
     * 好让「点卡之前仍在大厅」这条正对照有真值可比。
     */
    useAuthStore().navigate('lobby');
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]!, store: useGameStore() };
  }

  it('旧服务端（无 games）：只有斗地主一张卡（结构上是列表容器）', async () => {
    const { wrapper } = mountLobby();
    await flushPromises();

    expect(wrapper.find('.lobby__modes').exists(), '大厅必须有玩法入口区（spec §5-➋）').toBe(true);
    expect(
      wrapper.find('.lobby__mode-list').exists(),
      '玩法卡必须渲染在列表容器里（加第二个玩法时只加数据、不改结构）',
    ).toBe(true);
    expect(flat(wrapper.find('.lobby__modes-title').text())).toBe('选择玩法');

    expect(wrapper.findAll('.lobby__mode')).toHaveLength(1);
    expect(flat(wrapper.find('.lobby__mode-name').text())).toBe('斗地主');
    expect(flat(wrapper.find('.lobby__mode-tagline').text())).toBe('三人一局，比谁先出完手牌');
    // R762：卡是 `<button>`（整卡可点），不是 `view` + `@click`。
    expect(wrapper.find('.lobby__mode').element.tagName, '玩法卡用 <button>（R762）').toBe('BUTTON');
    // R747：斗地主没有图标素材 ⇒ 走**CSS 兜底**（玩法名首字），不白屏。
    expect(flat(wrapper.find('.lobby__mode-icon-char').text()), '缺素材时图标位走 CSS 兜底').toBe('斗');
  });

  it('点玩法卡 ⇒ 只写 store 的 activeMode、**不跳页**（片规格 §3 裁决一 · 行为变更）', async () => {
    const { wrapper, store } = mountLobby();
    await flushPromises();

    // 正对照：点之前仍在大厅
    expect(useAuthStore().page, '未点之前仍在大厅').toBe('lobby');

    /**
     * T2-R1 的判别力保留：**断言「这次点击调了 setActiveMode」**，不是只看值 ——
     * `activeMode` 的默认值恰好就是唯一那张卡的 id（`DEFAULT_MODE_ID === 'doudizhu'`）
     * ⇒ 只断言 `store.activeMode` 今天**不可能失败**。
     */
    const setActiveMode = vi.spyOn(store, 'setActiveMode');
    await wrapper.find('.lobby__mode').trigger('click');

    expect(setActiveMode, '点了哪张卡就写哪个玩法 id').toHaveBeenCalledWith('doudizhu');
    expect(store.activeMode, '写入落到 store 上').toBe('doudizhu');
    /**
     * 🔴 **本片的行为变更**：片③ 起这里是「一步进入」（`enterMode` → 直接 `navigate('game')`）。
     * 现在点玩法卡**只切换选中**，进页要靠**点底分卡**（`enterLevel`）。
     * 这条断言是**新的性质**（旧断言在「点完跳页」与「点完没反应」之间分不出来）。
     */
    expect(useAuthStore().page, '点玩法卡**不得**跳页（片规格 §3 裁决一）').toBe('lobby');
  });

  it('玩法卡不再有「进入」按钮，也没有 R652 的提示文案（R745/R746）', async () => {
    const { wrapper } = mountLobby();
    await flushPromises();
    expect(wrapper.find('.lobby__mode-enter').exists(), 'R745：一步进入 ⇒ 按钮没了').toBe(false);
    expect(wrapper.find('.lobby__hint').exists(), 'R746：R652 的提示随规则作废').toBe(false);
  });

  it('新服务端：pdk 关闭 ⇒ 只有斗地主卡；开启 ⇒ 两张卡', async () => {
    const off = mountLobby([], gamesConfig(false));
    await flushPromises();
    expect(off.wrapper.findAll('.lobby__mode')).toHaveLength(1);
    expect(flat(off.wrapper.find('.lobby__mode-name').text())).toBe('斗地主');

    const on = mountLobby([], gamesConfig(true));
    await flushPromises();
    expect(on.wrapper.findAll('.lobby__mode-name').map((n) => flat(n.text()))).toEqual([
      '斗地主',
      '跑得快',
    ]);
  });

  it('切到跑得快：写 activeMode；当前底分不在新玩法档位表 ⇒ 回落到第一档', async () => {
    const { wrapper, store } = mountLobby([], gamesConfig(true));
    await flushPromises();
    // 前置：默认选中斗地主第一档 15（生产里由玩家点档位卡写入）
    store.setSelectedBaseScore(15);
    expect(store.activeMode).toBe('doudizhu');
    expect(store.selectedBaseScore).toBe(15);

    const cards = wrapper.findAll('.lobby__mode');
    expect(cards).toHaveLength(2);
    await cards[1]!.trigger('click');

    expect(store.activeMode).toBe('paodekuai');
    // 跑得快档位表只有 80 ⇒ 选中回落
    expect(store.selectedBaseScore).toBe(80);
    expect(useAuthStore().page, '点玩法卡不得跳页').toBe('lobby');
  });

  it('档位卡按玩法切换：斗地主 15/80 → 跑得快只有 80（快跑场）', async () => {
    const { wrapper, store } = mountLobby([], gamesConfig(true));
    await flushPromises();

    expect(wrapper.findAll('.lobby__level-name').map((n) => flat(n.text()))).toEqual([
      '休闲场',
      '标准场',
    ]);

    await wrapper.findAll('.lobby__mode')[1]!.trigger('click');
    await flushPromises();

    expect(store.activeMode).toBe('paodekuai');
    expect(wrapper.findAll('.lobby__level-name').map((n) => flat(n.text()))).toEqual([
      '快跑场',
    ]);
    expect(flat(wrapper.find('.lobby__level-base').text())).toBe('底分 80');
  });

  it('当前玩法被服务端关闭 ⇒ 配置到达后自动切到第一个可见玩法', async () => {
    const { factory } = capturingFactory();
    startGameSession(factory);
    stubFetch((call) =>
      call.url.includes('/config')
        ? gamesConfig(false)
        : call.url.includes('/wallet/balance')
          ? { code: 0, data: { balance: 0 } }
          : { code: 0, data: [] },
    );
    useGameStore().setActiveMode('paodekuai');
    useAuthStore().navigate('lobby');
    mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(useGameStore().activeMode).toBe('doudizhu');
  });

  it('源码级：GAME_MODES 从 GAME_META 生成（禁止再抄 id 列表），且无越界字段', () => {
    // S5.4：玩法目录 id/name 必须来自 protocol `GAME_META`（单一真源）；游戏内不得
    // 再出现一份字面量 id 列表（第二真源形态）。
    const sources = collectSourceFiles();
    const modes = sources.find((f) => f.path === 'src/gameModes.ts');
    expect(modes, 'gameModes.ts 必须在源码扫描集合里').toBeDefined();
    expect(modes!.content).toMatch(/GAME_META\.doudizhu\.id/);
    expect(modes!.content).toMatch(/GAME_META\.paodekuai\.id/);
    expect(modeIds(modes!.content), '不得再抄一份玩法 id 列表').toEqual([]);
    // ② 违规类形态：读**剥注释视图**（R572/R622）——注释里点名禁词是解释，不是违规
    for (const path of ['src/pages/lobby/lobby.vue', 'src/gameModes.ts', 'src/pages/game/game.vue']) {
      const file = sources.find((f) => f.path === path)!;
      expect(file, `${path} 必须在源码扫描集合里`).toBeDefined();
      const code = stripComments(file.content);
      expect(code).not.toMatch(FORBIDDEN_FIELDS); // 不得造后端没有的字段
      expect(code, '不得引入麻将等未立项玩法').not.toMatch(SECOND_MODE);
    }
    // ③ R752（spec §7.1「玩法 id 跨页可达」）：玩法名必须**来自 store** ——
    //    `game.vue` **不得**写死「斗地主」字面量。
    const game = sources.find((f) => f.path === 'src/pages/game/game.vue');
    expect(game, 'src/pages/game/game.vue 必须在源码扫描集合里').toBeDefined();
    expect(stripComments(game!.content), 'R752：玩法名必须来自 store，game.vue 不得写死「斗地主」').not.toContain('斗地主');
  });

  it('正对照：硬编码 id 列表的样本确实被抓住', () => {
    const synthetic = `const GAME_MODES = [{ id: 'doudizhu' }, { id: 'paodekuai' }] as const;`;
    expect(modeIds(synthetic)).toEqual(['doudizhu', 'paodekuai']);
    expect(modeIds(`const GAME_MODES = [{ id: GAME_META.doudizhu.id }] as const;`)).toEqual([]);
  });

  it('正对照：剥注释视图对「真违规 + 解释它的注释」确实红、对纯注释确实绿', () => {
    // 红：违规代码与解释它的注释同时在场 ⇒ 剥注释后**仍然**报错
    const offending = [
      '// 反例：不得造后端没有的字段（如 onlineCount / 在线人数）',
      'const onlineCount = rooms.length;',
    ].join('\n');
    expect(stripComments(offending)).toMatch(FORBIDDEN_FIELDS);
    // 绿：只有解释、没有违规 ⇒ 不报错（R572：闸不惩罚解释本身）
    const explained = '// 反例：onlineCount / 在线人数 / 麻将 这类标识不得出现在 src 里';
    expect(stripComments(explained)).not.toMatch(FORBIDDEN_FIELDS);
    expect(stripComments(explained)).not.toMatch(SECOND_MODE);
  });
});

/**
 * ② 金币场（§14）：大厅右栏的**场次切换**（免费/金币）。
 *
 * 判别矩阵：
 *  ① **按开关渲染**：双开 ⇒ 两个选项；单开 ⇒ 恰一个（拦「拿到配置就全渲染」）；
 *  ② **双关空态**：一个选项都没有 + **零张档位卡**（没有可进入的场次时，卡就是死按钮）；
 *  ③ **点场次 = 只切换选中**：写 `store.roomMode`、**不跳页**（与玩法卡同一条裁决形态）；
 *  ④ **可用性修复**：选中的场次被服务端关掉、另一个开着 ⇒ 选中切到开着的那一个
 *     （拦「开始游戏必撞 12010」）；
 *  ⑤ **缺键语义**（§2.4，服务端旧版）：`freeRoomEnabled` 缺 ⇒ 按**开**、
 *     `goldRoomEnabled` 缺 ⇒ 按**开**（2026-10-04 用户裁决默认开）、
 *     `reliefEnabled` 缺 ⇒ 按**关**、`entryMultiplier` 缺 ⇒ **不提示**。
 *  ⑥ **契约违约边格**：`code 0` 但 `data` 整个缺失（**`null`**）= 「服务端没答」⇒ 与失败
 *     同一处置（fail-safe：空表 + 各闸按 fail-safe 语义、金币场随裁决按开 + 零卡）；
 *     正对照 `data:{}`（对象**在场**、键全缺）⇒ 照走缺键语义（free 按开）——
 *     一格 `null` 一格 `{}`，钉住「没答 ≠ 少键」的分界。
 */
describe('② 场次切换（免费/金币，按开关渲染；双关空态）', () => {
  /** 与上面 `mountLobby` 同形（同文件两处需要不同 config，各自独立更清楚）。 */
  function mountWithConfig(config: unknown) {
    const { factory } = capturingFactory();
    startGameSession(factory);
    stubFetch((call) =>
      call.url.includes('/config')
        ? config
        : call.url.includes('/wallet/balance')
          ? { code: 0, data: { balance: 100000 } }
          : { code: 0, data: [] },
    );
    useAuthStore().navigate('lobby');
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    return { wrapper, store: useGameStore() };
  }

  it('双开 ⇒ 两个选项（免费场默认选中）；点「金币场」只写 store.roomMode、不跳页', async () => {
    const { wrapper, store } = mountWithConfig(GOLD_CONFIG);
    await flushPromises();

    const sessions = wrapper.findAll('.lobby__session');
    expect(sessions.map((s) => flat(s.text()))).toEqual(['免费场', '金币场']);
    expect(wrapper.findAll('button.lobby__session'), '双开：两段都是可点按钮').toHaveLength(2);
    expect(flat(wrapper.find('.lobby__session--active').text()), '缺省选中免费场').toBe('免费场');
    expect(useAuthStore().page, '前置：仍在大厅').toBe('lobby');

    await sessions[1]!.trigger('click');

    expect(store.roomMode, '点金币场 = 写 store.roomMode（开始游戏页读它）').toBe('gold');
    expect(flat(wrapper.find('.lobby__session--active').text()), '选中态跟着走').toBe('金币场');
    expect(useAuthStore().page, '点场次**不得**跳页（与玩法卡同一条裁决形态）').toBe('lobby');

    // 正对照另一半：点回免费场 ⇒ 写回 'random'（不是单向写死）
    await wrapper.findAll('.lobby__session')[0]!.trigger('click');
    expect(store.roomMode).toBe('random');
  });

  it('单开免费 ⇒ 恰一个选项；单开金币 ⇒ 恰一个选项且**选中被修复**为金币场', async () => {
    const freeOnly = mountWithConfig(STABLE_CONFIG); // 免费场开、金币场关
    await flushPromises();
    expect(freeOnly.wrapper.findAll('.lobby__session').map((s) => flat(s.text()))).toEqual(['免费场']);
    expect(
      freeOnly.wrapper.findAll('button.lobby__session'),
      '单开：只有一个选项 ⇒ 不得渲染按钮（切换器是死按钮）',
    ).toHaveLength(0);
    expect(
      freeOnly.wrapper.find('.lobby__session--static').exists(),
      '单开：静态标识仍要显示当前场次',
    ).toBe(true);
    expect(freeOnly.store.roomMode, '免费场可用 ⇒ 保持缺省').toBe('random');
    freeOnly.wrapper.unmount();

    const goldOnly = mountWithConfig({
      code: 0,
      data: { ...STABLE_CONFIG.data, freeRoomEnabled: false, goldRoomEnabled: true },
    });
    await flushPromises();
    expect(goldOnly.wrapper.findAll('.lobby__session').map((s) => flat(s.text()))).toEqual(['金币场']);
    expect(goldOnly.wrapper.findAll('button.lobby__session'), '单开金币：同样不得渲染按钮').toHaveLength(0);
    expect(goldOnly.wrapper.find('.lobby__session--static').exists()).toBe(true);
    expect(
      goldOnly.store.roomMode,
      '「免费场」被服务端关掉、金币场开着 ⇒ 选中修复为金币场（否则开始游戏必撞 12010）',
    ).toBe('gold');
  });

  it('🔴 双关 ⇒ 空态文案 + 零个场次选项 + **零张档位卡**（没有可进入的场次）', async () => {
    const { wrapper } = mountWithConfig({
      code: 0,
      data: { ...STABLE_CONFIG.data, freeRoomEnabled: false, goldRoomEnabled: false },
    });
    await flushPromises();

    expect(flat(wrapper.find('.lobby__sessions-empty').text())).toBe('当前没有开放的场次');
    expect(wrapper.findAll('.lobby__session'), '开关都关 ⇒ 一个选项都不渲染').toHaveLength(0);
    expect(wrapper.findAll('.lobby__level'), '没有可进入的场次 ⇒ 档位卡一张都不渲染（不是死按钮）').toHaveLength(0);
    expect(wrapper.find('.lobby__levels-empty').exists(), '这不是错误（服务端配置如此）').toBe(false);
  });

  it('② 缺键语义（服务端旧版）：free 缺 ⇒ 按开；gold 缺 ⇒ 按开（裁决）；relief 缺 ⇒ 按关；entryMultiplier 缺 ⇒ 不提示', async () => {
    const { wrapper, store } = mountWithConfig({
      code: 0,
      // 旧版服务端：只有片⑦ 的三键（今天线上「落后」的真实形态）
      data: {
        baseScoreLevels: [
          { name: '休闲场', baseScore: 15 },
          { name: '标准场', baseScore: 80 },
        ],
        friendRoomEnabled: true,
        version: 4,
      },
    });
    await flushPromises();

    expect(store.freeRoomEnabled, 'freeRoomEnabled 缺 ⇒ 按**开**（与种子一致）').toBe(true);
    expect(store.goldRoomEnabled, 'goldRoomEnabled 缺 ⇒ 按**开**（2026-10-04 用户裁决：默认开）').toBe(true);
    expect(store.reliefEnabled, 'reliefEnabled 缺 ⇒ 按**关**').toBe(false);
    expect(store.entryMultiplier, 'entryMultiplier 缺 ⇒ null（不提示）').toBeNull();

    expect(wrapper.findAll('.lobby__session').map((s) => flat(s.text()))).toEqual(['免费场', '金币场']);
    expect(wrapper.find('.lobby__relief').exists(), 'relief 缺 ⇒ 救助入口不渲染').toBe(false);
    expect(wrapper.find('.lobby__level-need').exists(), '缺省选中免费场 ⇒ 本来就没有门槛提示（正对照）').toBe(false);
  });

  it('⑥ 契约违约边格：`data:null`（code 0 但整个 data 缺失）⇒ 与失败同一处置（fail-safe）', async () => {
    const { wrapper, store } = mountWithConfig({ code: 0, data: null });
    await flushPromises();

    // 🔴 「没答」≠「少键」：null 是违约 ⇒ 不得走缺键语义（那会让 free 按开 = 故障期放行）。
    expect(store.freeRoomEnabled, 'data 缺失 ⇒ free **不得**按开（缺键语义只服务「对象在场」）').toBe(false);
    expect(
      store.goldRoomEnabled,
      '金币场 fail-safe 按种子开（2026-10-04 用户裁决；这条走的是 FAILSAFE 常量，不是缺键语义）',
    ).toBe(true);
    expect(wrapper.findAll('.lobby__session'), 'fail-safe ⇒ 零个场次选项（空表门控；与开关值无关）').toHaveLength(0);
    expect(wrapper.findAll('.lobby__level'), 'fail-safe ⇒ 零张档位卡（不猜底分）').toHaveLength(0);
  });

  it('⑥ 正对照：`data:{}`（对象在场、键全缺）⇒ 照走缺键语义（free 按开；与 null 格相反）', async () => {
    const { store } = mountWithConfig({ code: 0, data: {} });
    await flushPromises();

    // 与上一格**恰相反**的处置：{} 是「答了、只是没带键」⇒ free 按开（旧服务端形态）。
    // ⚠️ 断言落在 **store** 上：场次选项的 DOM 整体受 `baseScoreLevels.length > 0` 门控
    // （空表 ⇒ 连场次区都不渲染）——用 DOM 区分这两格会被空表短路掩盖（实测教训）。
    expect(store.freeRoomEnabled, '对象在场（哪怕没有键）⇒ 缺键语义：free 按开').toBe(true);
    expect(store.baseScoreLevels, '键全缺 ⇒ 空表（这一步与 null 格同形，不是判别面）').toEqual([]);
  });

  it('② 落后服务端：金币场开着但**没有倍率** ⇒ 档位卡不提示、不置灰（门槛判定留给服务端）', async () => {
    const { wrapper, store } = mountWithConfig({
      code: 0,
      data: {
        baseScoreLevels: [
          { name: '休闲场', baseScore: 15 },
          { name: '标准场', baseScore: 80 },
        ],
        friendRoomEnabled: true,
        freeRoomEnabled: true,
        goldRoomEnabled: true,
        reliefEnabled: false,
        version: 4,
        // entryMultiplier 缺：服务端还在旧版
      },
    });
    await flushPromises();

    expect(store.entryMultiplier).toBeNull();
    await wrapper.findAll('.lobby__session')[1]!.trigger('click'); // 切到金币场

    expect(wrapper.findAll('.lobby__level'), '卡照常渲染').toHaveLength(2);
    expect(wrapper.find('.lobby__level-need').exists(), '倍率未知 ⇒ 不提示门槛（§2.4）').toBe(false);
    expect(wrapper.find('.lobby__level--locked').exists(), '倍率未知 ⇒ 不置灰（服务端仍是权威）').toBe(false);
  });
});
