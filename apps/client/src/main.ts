/**
 * 入口：装配 Vue + Pinia + 会话，并在此处**唯一一次**引入 socket.io-client。
 *
 * 之所以在入口引入：net 层不 import socket.io-client，测试才能完全不碰网络栈；
 * 生产环境由这里把 io 注入进去（endpoint 由 config.ts 决定，切 mock/真实后端只改 URL）。
 *
 * ⚠️ 顺序：**先 hydrate 再建连**——`config.buildSocketAuth()` 读 `clientConfig.token`，
 * 恢复本地令牌的动作必须早于 socket 握手，否则刷新页面后握手里没有令牌（§5.1）。
 *
 * ⚠️ uni-app 的入口约定（切片 P10 Task 1 落地）：
 * 导出 `createApp()`（由 uni 运行时调用），内部用 **uni-app 的 Vue 应用工厂**（由 `vue`
 * 具名导入；H5 端由 uni 运行时负责挂载到 `#app`）。
 * ⚠️⚠️ 该工厂的**标识符在本文件里第一次出现，必须是下面那行 import** ——
 * 原因见 import 正下方的长注释（N39 实测的静默白屏根因）。
 * ⚠️ **不得**改成动态 `import('socket.io-client')`：实测动态 import 会造出 code-split chunk，
 * 而 App 端（`uni build -p app`）的 `output.format` 是 `iife`，直接构建失败
 * （`UMD and IIFE output formats are not supported for code-splitting builds`）。
 *
 * ⚠️ 传输的平台差异（切片 P10 Task 3）：`createSocketIoFactory` 的 `io(url, {...})` 只有一份，
 * 平台差异只体现为「把 `'websocket'` 换成哪个传输实现」——H5/App 用 engine.io 自带的浏览器
 * 传输（`browserTransportSelection`，原路径不分叉），微信小程序用 `wx.connectSocket` 适配层
 * （`net/mp-transport.ts`，**未在真机验证**）。判定在**调用时**做（不在这里写死平台常量）。
 */
import { createSSRApp } from 'vue';
/*
 * ⚠️⚠️ **本行 import 之前，不得出现 `createSSRApp` 这个字面量 —— 注释里也不行。**
 *
 * uni-app 的 App 端入口插件（`@dcloudio/uni-app-vite/dist/vue/plugins/mainJs.js` 的
 * `uniMainJsPlugin`）这样改写入口：
 *
 *     code.replace('createSSRApp', 'createVueApp as createSSRApp')
 *
 * 而 `String.prototype.replace` 传**字符串**模式时**只替换第一处**。若第一处落在注释里，
 * 改写就落进注释（随后被剥掉），真正的 import 与调用**原封不动**。
 *
 * ⇒ App 端拿到的是 `createSSRApp`（**SSR 应用**）而不是 `createVueApp`（客户端应用，
 *   即 uni-app 打过补丁的 Vue 运行时里的 `createApp`）。
 * ⇒ **不抛错、控制台全空、`createApp()` 全程跑完、首屏却永不渲染（纯白屏）。**
 *
 * N39 的 App 端白屏正是这条：本文件原有的一句文档注释里写了这个字面量，抢走了那次替换。
 * **机械闸：`test/entry-mainjs-rewrite.gate.test.ts`**（断言本文件里该字面量的第一次出现
 * 必须落在 import 行上）。
 */
import { createPinia, setActivePinia } from 'pinia';
import { io } from 'socket.io-client';
import App from './App.vue';
import { createSocketIoFactory } from './net/transport';
import { selectTransportSelection } from './net/mp-transport';
import { startGameSession } from './composables/useGameSession';
import { startVersionCheck } from './composables/useVersionCheck';
import { useAuthStore } from './stores/auth';
import { reportError } from './observability/reporter';

export function createApp() {
  const app = createSSRApp(App);
  const pinia = createPinia();
  app.use(pinia);
  setActivePinia(pinia);

  // Vue 组件内未捕获的渲染/侦听器错误（项 8）。app 级 onError 见 App.vue；
  // errorHandler 接住的是 Vue 组件树这一层，两者互补。
  app.config.errorHandler = (error, _instance, info) => {
    reportError('vue.errorHandler', error, { info });
  };

  const auth = useAuthStore();
  auth.hydrate(); // 先恢复令牌，socket 握手才会用上它（config.buildSocketAuth 读 clientConfig.token）

  const socketFactory = createSocketIoFactory(io, selectTransportSelection());
  try {
    startGameSession(socketFactory);
  } catch (error) {
    // 此处抛错会冒到 uni 引导层（createApp 调用点），那时 App.vue 的 onError 还没接上；
    // 先过 reporter（未配置端点时 console.warn），再原样抛出保持既有失败语义。
    reportError('session.start', error);
    throw error;
  }

  // 冷启动 / App 息屏隔夜后 access token 可能已过期：预检本地 JWT exp，
  // 新鲜则零请求，过期则单飞 refresh 并回填 store。fire-and-forget，
  // 失败（网络不可用）不阻塞启动——WS 连接会自己走 10004 静默续期恢复路径。
  void auth.renewHydratedSession();

  // 项 9：H5 发版更新提示（非 H5 平台内部直接返回，零副作用）。
  startVersionCheck();

  return { app };
}
