/**
 * 极简页面路由：**`auth.page` 是唯一状态源，uni 的页面栈只是它的投影**。
 *
 * uni-app 用 `pages.json` 声明页面栈；本文件保留 `RouteName`/`routes`/`isRoute`
 * （store 与测试都在用），并补上两件事：
 *
 *  1. `pageUrl(page)`：page → url 的**唯一映射**（与 `src/pages.json` 的 `path` 逐字对应）。
 *     `navigate()` 与「冷启动对齐」**共用**这一份，不得在别处再写一遍路径字符串；
 *  2. `syncPageStack(page)`：把当前 page **投影**到页面栈上（`uni.reLaunch`）。
 *
 * ⚠️ 为什么是 `reLaunch` 而不是 `navigateTo`：本项目是「一步一页」的形态
 * （登录 → 大厅 → 玩法 → 牌桌，页与页之间没有「返回」语义）。`navigateTo` 会**堆栈**，
 * 于是「用户按了返回」就会让真实栈与 `auth.page` 分叉；`reLaunch` 关掉所有页面再打开目标页，
 * 页面栈因此永远只是 page 的投影、不可能出现第二份状态。
 */
export type RouteName = 'login' | 'lobby' | 'game' | 'table';

export const routes: readonly RouteName[] = ['login', 'lobby', 'game', 'table'] as const;

export function isRoute(value: unknown): value is RouteName {
  return typeof value === 'string' && (routes as readonly string[]).includes(value);
}

/**
 * page → url 的**唯一映射**。
 *
 * ⚠️ 键的取值就是 `src/pages.json` 里 `pages[].path` 前面加 `/`。
 * 两处漂移会让「跳转到一个未声明的页面」变成运行期错误（H5 上表现为 404 空页），
 * 因此 `test/page-stack.test.ts` 有一条机械判据把两边钉在一起。
 */
export const PAGE_URLS: Readonly<Record<RouteName, string>> = {
  login: '/pages/login/login',
  lobby: '/pages/lobby/lobby',
  game: '/pages/game/game',
  table: '/pages/table/table',
};

export function pageUrl(page: RouteName): string {
  return PAGE_URLS[page];
}

/** 页面栈投影的注入点：测试可换成记账函数，生产是 `uni.reLaunch`。 */
export type Relaunch = (url: string) => void;

/**
 * 生产用的投影：`uni.reLaunch`。
 *
 * ⚠️ `uni.reLaunch(...)` 必须是**直接的成员表达式**：H5 发行构建（默认摇树）只注入一个
 * 空的 `window.uni` 占位对象，真正干活的是 uni 编译器把这种直接调用改写成
 * `@dcloudio/uni-h5` 的 import（`uni-h5-vite/dist/plugins/inject.js`）；把它读进变量
 * 再调用会让改写失效（dev 正常、发行版静默不跳）。详见 `net/storage.ts#hasUni` 的注释。
 *
 * 非 uni 宿主（纯 node / SSR）没有页面栈可言 ⇒ 静默跳过：页面栈只存在于 uni 运行时里，
 * 没有它时 `page` 就是全部状态。
 */
export const uniRelaunch: Relaunch = (url) => {
  if (typeof uni === 'undefined') return;
  uni.reLaunch({ url });
};

/**
 * 把 page 投影到页面栈（`navigate()` 与冷启动对齐共用）。
 *
 * 顺序由调用方保证：**先写 `auth.page`，再调它**——这样即使投影失败（页面栈报错），
 * 唯一状态源仍然是对的，下一次对齐会把它追上。
 */
export function syncPageStack(page: RouteName, relaunch: Relaunch = uniRelaunch): void {
  relaunch(pageUrl(page));
}
