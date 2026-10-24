/**
 * Task 3 的页面栈判据（§1A）。
 *
 * 被钉住的不变量：**`auth.page` 是唯一状态源，uni 的页面栈只是它的投影**。
 *
 *  ① 冷启动对齐：入口页恒为登录页，而本地有令牌时 `hydrate()` 已经把 `page` 置成 `lobby`
 *     ⇒ 登录页挂载时必须立刻把页面栈追上去（目标 url 必须来自 `pageUrl()` 那份唯一映射）；
 *     负对照：`page === 'login'` 时**不跳**；`page` 与页面自身一致时**不跳**。
 *  ② `navigate(page)`：**先写 page 再投影**（顺序不能反，否则失败时会留下分叉），
 *     且四个路由的目标 url 都等于 `pageUrl(page)`。
 *  ③ 会话动作（`applySession` / `enterAsDevUser` / `clearLocalSession`）也投影 ——
 *     它们是运行期改 `page` 的路径，不走 `navigate()` 就会与页面栈分叉。
 *  ④ 结构判据：`pages.json` 的页面栈顺序 = 登录 → 大厅 → 玩法 → 牌桌 **+ 第 5/6 页（历史战绩 / 钱包 ——
 *     记录片 T8 / 支付片 T14 起：`navigateTo` 压栈，**不进** `auth.page` 的四页投影）**；`pageUrl` 与 `pages.json`
 *     前四页逐条一致（两处漂移 = 跳到未声明页面）；页壳已删除；四个页面各自装了冷启动对齐；
 *     除 `stores/auth.ts` 外没有别处直接写 `page`（不得绕过 `navigate()`）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginPage from '../src/pages/login/login.vue';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import GamePage from '../src/pages/game/game.vue';
import TablePage from '../src/pages/table/table.vue';
import { PAGE_URLS, pageUrl, routes, type RouteName } from '../src/router';
import { useAuthStore } from '../src/stores/auth';
import { saveSession, clearSession } from '../src/net/storage';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { FakeSocket } from './helpers/fake-socket';
import { installUniStub, type UniStub } from './helpers/uni-stub';
import { collectSourceFiles, SRC_ROOT } from './helpers/source-scan';

/** 本文件里 `uni` 的替身（`beforeEach` 重装，拿到本次的调用流水）。 */
let uni: UniStub;
/** **同一个** pinia：页面组件经 `global.plugins` 拿到的必须是下面 `useAuthStore()` 那个实例。 */
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  uni = installUniStub();
  clearSession();
  // 大厅页挂载时会拉房间列表（REST）：给个空列表，避免用例挂在不相关的 fetch 上
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: [] }),
    })),
  );
});

/** 挂载某个页面（页面栈在单测里不存在，这里直接挂页面组件）。 */
function mountPage(page: 'login' | 'lobby' | 'game' | 'table') {
  const pages = { login: LoginPage, lobby: LobbyPage, game: GamePage, table: TablePage } as const;
  return mount(pages[page], { global: { plugins: [pinia] } });
}

describe('① 冷启动对齐：页面栈追上 auth.page', () => {
  it('入口页是登录页，但本地有令牌（hydrate 已把 page 置成 lobby）⇒ 挂载时立刻 reLaunch 到大堂', () => {
    // 走真实路径产生「已 hydrate」：写本地会话 → hydrate
    saveSession({ accessToken: 'a', refreshToken: 'r', userId: 'u1', phone: '', nickname: '' });
    const auth = useAuthStore();
    expect(auth.hydrate()).toBe(true);
    expect(auth.page).toBe('lobby');
    // hydrate 本身不跳（它跑在入口创建时，页面栈还没有第一页）
    expect(uni.calls.reLaunch).toEqual([]);

    mountPage('login');

    // 目标 url 必须来自**那一份** page → url 映射，不得在页面里另写一份路径
    expect(uni.calls.reLaunch).toEqual([pageUrl('lobby')]);
    expect(uni.calls.reLaunch[0]).toBe('/pages/lobby/lobby');
  });

  it('负对照：没有本地会话（page 仍是 login）⇒ 登录页**不跳**', () => {
    const auth = useAuthStore();
    expect(auth.hydrate()).toBe(false);
    expect(auth.page).toBe('login');

    mountPage('login');

    expect(uni.calls.reLaunch).toEqual([]);
  });

  it('负对照：页面身份与 auth.page 一致时**不跳**（大厅页 / 牌桌页各自成立）', () => {
    // 牌桌页的渲染要读会话（`getGameSession()`）⇒ 给一个假 socket（不连网络）
    startGameSession(() => new FakeSocket());
    const auth = useAuthStore();
    auth.navigate('lobby');
    uni.resetCalls();

    mountPage('lobby');
    expect(uni.calls.reLaunch).toEqual([]);

    auth.navigate('table');
    uni.resetCalls();
    mountPage('table');
    expect(uni.calls.reLaunch).toEqual([]);
    stopGameSession();
  });

  it('每个页面的对齐判据是**它自己的**身份（不是写死的常量）', () => {
    startGameSession(() => new FakeSocket());
    const auth = useAuthStore();
    auth.navigate('lobby');
    uni.resetCalls();

    // 牌桌页发现真源说「大厅」⇒ 跳回大厅（若某页把 'login' 抄成了参数，这条会红）
    mountPage('table');
    expect(uni.calls.reLaunch).toEqual([pageUrl('lobby')]);
    stopGameSession();
  });
});

describe('② navigate：先写唯一真源、再投影页面栈', () => {
  it('四个路由都投影到 pageUrl(page)，且投影发生时 page 已经写好', () => {
    const auth = useAuthStore();
    /** 记录「reLaunch 被调用的那一刻，auth.page 是什么」。 */
    const pageWhenProjected: RouteName[] = [];
    vi.spyOn(uni, 'reLaunch').mockImplementation((options: { url: string }) => {
      pageWhenProjected.push(useAuthStore().page);
      uni.calls.reLaunch.push(options.url);
    });

    for (const page of routes) {
      uni.resetCalls();
      auth.navigate(page);
      expect(auth.page).toBe(page);
      expect(uni.calls.reLaunch).toEqual([pageUrl(page)]);
    }
    // 顺序判据：投影发生时 page 必须**已经**是目标页（先写状态，再跳页）
    expect(pageWhenProjected).toEqual([...routes]);
  });

  it('用 reLaunch（一步一页）而不是 navigateTo（会堆栈），且 reLaunch 是唯一入口', () => {
    const auth = useAuthStore();
    auth.navigate('table');
    expect(uni.calls.reLaunch).toEqual([pageUrl('table')]);
    expect(uni.calls.navigateTo, 'navigateTo 会与 auth.page 分叉，本项目不用它').toEqual([]);
  });
});

describe('③ 会话动作也必须投影（否则页面栈与真源分叉）', () => {
  it('enterAsDevUser → lobby', () => {
    useAuthStore().enterAsDevUser();
    expect(useAuthStore().page).toBe('lobby');
    expect(uni.calls.reLaunch).toEqual([pageUrl('lobby')]);
  });

  it('applySession（登录/注册成功）→ lobby', () => {
    useAuthStore().applySession({
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: 'u1', phone: '13800000000' },
    });
    expect(useAuthStore().page).toBe('lobby');
    expect(uni.calls.reLaunch).toEqual([pageUrl('lobby')]);
  });

  it('clearLocalSession（登出 / 令牌失效）→ login', () => {
    const auth = useAuthStore();
    auth.applySession({
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: 'u1', phone: '13800000000' },
    });
    uni.resetCalls();

    auth.clearLocalSession();

    expect(auth.page).toBe('login');
    expect(uni.calls.reLaunch).toEqual([pageUrl('login')]);
  });
});

describe('④ 结构判据：页面栈声明 / 唯一映射 / 不得绕过 navigate', () => {
  const pagesJson = JSON.parse(readFileSync(join(SRC_ROOT, 'pages.json'), 'utf8')) as {
    pages: { path: string; style?: { navigationBarTitleText?: string } }[];
    subPackages?: { root: string; pages: { path: string; style?: { navigationBarTitleText?: string } }[] }[];
  };
  const sources = collectSourceFiles();

  /** 项 6 分包后：主包 `pages` + 各 `subPackages`（path = root + '/' + path）展开成统一清单。 */
  function allDeclaredPaths(): string[] {
    const main = pagesJson.pages.map((p) => p.path);
    const subs = (pagesJson.subPackages ?? []).flatMap((sp) => sp.pages.map((p) => `${sp.root}/${p.path}`));
    return [...main, ...subs];
  }

  it('pages.json 的页面栈顺序 = 登录 → 大厅 → 玩法（主包）→ 牌桌 / 历史战绩 / 钱包（分包；首个 = 冷启动入口）', () => {
    /**
     * ⚠️ **记录片 T8 的成对变更**（R755 的同一形态：页面栈确实变了 ⇒ 它该红）：
     * 第 5 页 `pages/history/history` 是**子页** —— 由大厅头像弹层 `navigateTo` 压栈，
     * **不是** `auth.page` 四页投影之一（页序仍以前四页为准）。**别的断言一条没少。**
     * ⚠️ **支付片 T14 的成对变更**（同族）：第 6 页 `pages/wallet/wallet` —— 由大厅
     * 钱包入口（金币显示处）`navigateTo` 压栈，也不是四页投影之一。
     * ⚠️ **项 6（小程序分包）**：牌桌 / 历史 / 钱包从主包 `pages` 移到 `subPackages`
     * （根分别是 `pages/table`、`pages/history`、`pages/wallet`），路径逐字不变。
     */
    expect(allDeclaredPaths()).toEqual([
      'pages/login/login',
      'pages/lobby/lobby',
      'pages/game/game',
      'pages/table/table',
      'pages/history/history',
      'pages/wallet/wallet',
      'pages/wallet/recharge',
      'pages/wallet/withdraw',
    ]);
    expect(pagesJson.pages[0]!.style?.navigationBarTitleText).toBe('登录');
  });

  it('pageUrl 与 pages.json 逐条一致（两处漂移 = 跳到未声明的页面）', () => {
    const declared = allDeclaredPaths().map((p) => `/${p}`);
    // 前四页 = `auth.page` 的投影面（`pageUrl` 的唯一映射）；第 5/6 页是声明过的子页。
    expect(routes.map((page) => pageUrl(page))).toEqual(declared.slice(0, routes.length));
    // 反证：映射真的被用到了（不是一份没人读的常量表）
    expect(Object.keys(PAGE_URLS).sort()).toEqual([...routes].sort());
    // 子页不减少强度：四页之外**恰**是历史页、钱包首页、充值/提现子页
    expect(declared.slice(routes.length)).toEqual([
      '/pages/history/history',
      '/pages/wallet/wallet',
      '/pages/wallet/recharge',
      '/pages/wallet/withdraw',
    ]);
  });

  it('页壳 src/pages/index/index.vue 已删除（职责被页面栈取代）', () => {
    expect(sources.map((f) => f.path)).not.toContain('src/pages/index/index.vue');
    // 四个页面各自在自己的目录里（`pages.json` 的 path 与之一一对应）
    for (const file of [
      'src/pages/login/login.vue',
      'src/pages/lobby/lobby.vue',
      'src/pages/game/game.vue',
      'src/pages/table/table.vue',
    ]) {
      expect(sources.map((f) => f.path), `${file} 必须在扫描集合里`).toContain(file);
    }
  });

  it('四个页面都装了冷启动对齐（各用自己的身份）', () => {
    for (const [page, file] of [
      ['login', 'src/pages/login/login.vue'],
      ['lobby', 'src/pages/lobby/lobby.vue'],
      ['game', 'src/pages/game/game.vue'],
      ['table', 'src/pages/table/table.vue'],
    ] as const) {
      const source = sources.find((f) => f.path === file);
      expect(source, `${file} 必须存在`).toBeDefined();
      // 引号风格不限：仓内格式化器可能输出双引号（game/lobby/table 已被格式化为双引号），
      // 本判据守的是「装了对齐且身份正确」，不是引号。
      expect(source!.content, `${file} 必须登记自己的页面身份`).toMatch(
        new RegExp(`usePageAlignment\\((['"])${page}\\1\\)`),
      );
    }
  });

  it('除 stores/auth.ts 外没有别处直接写 page（不得绕过 navigate）', () => {
    const offenders = sources
      .filter((f) => f.path !== 'src/stores/auth.ts')
      .filter((f) => /(?:auth|store|this)\.page\s*=/.test(f.content))
      .map((f) => f.path);
    expect(offenders, `这些文件绕过了 navigate()，页面栈会与 auth.page 分叉：${offenders.join(', ')}`).toEqual(
      [],
    );

    // auth.ts 内部：只有两处直接写 —— hydrate（冷启动，页面栈还没就位）与 navigate（投影入口）
    const auth = sources.find((f) => f.path === 'src/stores/auth.ts')!;
    expect([...auth.content.matchAll(/this\.page\s*=/g)]).toHaveLength(2);
    expect(auth.content).toContain('syncPageStack(page)');
  });
});
