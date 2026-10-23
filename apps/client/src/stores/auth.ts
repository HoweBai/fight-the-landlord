/**
 * 会话与导航状态。
 *
 * 只存「渲染和连接所需」的东西：token、userId、当前页面。
 * **不存对局状态**——那是 stores/game.ts 的事，且永远以服务端推送为准（F03）。
 *
 * 令牌同时持久化到本地（`net/storage.ts`）：刷新页面后 `hydrate()` 能把它写回
 * `clientConfig.token`，socket 握手才用得上（§5.1）。
 */
import { defineStore, getActivePinia } from 'pinia';
import { ErrCode } from '@fight-the-landlord/protocol';
import * as rest from '../net/rest';
import { dispatchRestFailure } from '../net/errors';
import { authErrorMessage } from '../net/copy';
import { clearSession, loadSession, saveSession } from '../net/storage';
import { ensureFreshAccessToken } from '../net/token-refresh';
import { clientConfig } from '../config';
import { syncPageStack, type RouteName } from '../router';
import { reportError } from '../observability/reporter';

/**
 * 「销毁本地 WS 会话」的钩子（R36）。
 *
 * `BACK_TO_LOBBY` 要求先 `stopGameSession()` 再清认证状态，但本文件**不能**直接
 * `import { stopGameSession } from '../composables/useGameSession'`——后者要 import 本文件
 * 取 `useAuthStore`，会构成 store ↔ composable 的循环依赖（入口模块循环是本项目明令避免的）。
 * 因此沿用 `stores/game.ts` 的 `bindRuntime` 套路：由**拥有** `stopGameSession` 的一侧
 * （`useGameSession.ts`，在建立会话时）把钩子绑进来；未绑定（没建过会话）时是空操作。
 */
let stopSessionHook: (() => void) | null = null;

export function bindAuthRuntime(runtime: { stopSession: () => void }): void {
  stopSessionHook = runtime.stopSession;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    userId: clientConfig.devUserId,
    accessToken: '' as string,
    refreshToken: '' as string,
    /**
     * 展示用的用户资料（顶栏 / 开始游戏页的信息条）——**来源是登录/注册响应**里的
     * `user.phone` / `user.nickname`，与令牌一起持久化（Task 2R：资料没有网络取数，
     * 也就没有「取不到」这个中间态 —— 缺省就是 `''`，由 `displayName` 回落）。
     */
    nickname: '' as string,
    phone: '' as string,
    /** 已登录（拿到 token 或处于开发身份模式）。 */
    loggedIn: false,
    /** 登录/注册的错误提示（人类可读，来自服务端 message，仅供展示）。 */
    error: '' as string,
    page: 'login' as RouteName,
  }),

  getters: {
    /**
     * 界面上显示的**用户名**。
     *
     * ⚠️ 三级回落，**每一级都是服务端给过的真值**：昵称 → 手机号 → `userId`。
     * `userId` 这一级是**必需**的：开发身份（`enterAsDevUser()`）与会话里没有这两项时
     * （老会话 / 服务端没发）没有前两级，而「显示一串内部 id」比「显示空白」或「编一个名字」都诚实。
     *
     * ⚠️ **不得**在这里编造任何文案（如「游客1234」）—— 那是前端造数据（M09 的同一精神）。
     */
    displayName: (s): string => s.nickname || s.phone || s.userId,
  },

  actions: {
    /**
     * 从本地存储恢复会话（入口在 `startGameSession()` **之前**调用）。
     *
     * 返回是否恢复成功；调用方不需要它——写进返回值只是为了启动日志与测试方便。
     *
     * ⚠️ 这里**故意不调 `navigate()`**：`hydrate()` 跑在入口创建时（socket 握手之前），
     * 那一刻页面栈还没有第一页可言。页面栈由入口页（登录页）挂载时的冷启动对齐追上
     * （`composables/usePageAlignment.ts`：`onMounted` 自检 `auth.page` 是否还是自己）。
     * `auth.page` 因此仍是唯一状态源：`hydrate()` 先写它，页面栈随后被投影过来。
     */
    hydrate(): boolean {
      const stored = loadSession();
      if (!stored) return false;
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.userId = stored.userId;
      // Task 2R：展示资料与令牌一起恢复 —— 老会话读成 `''`（`displayName` 回落到 `userId`）。
      this.phone = stored.phone;
      this.nickname = stored.nickname;
      clientConfig.token = stored.accessToken;
      this.loggedIn = true;
      this.page = 'lobby';
      return true;
    },

    /**
     * 开发期直连 mock：没有 token 也能进大厅（mock 只认 userId）。
     *
     * ⚠️ 它**不带 token**，只对 mock 有效；真实网关会在握手时要求 access token（§5.1）。
     */
    enterAsDevUser() {
      this.userId = clientConfig.devUserId;
      this.loggedIn = true;
      this.error = '';
      this.navigate('lobby');
    },

    async signIn(phone: string, password: string, replayed = false): Promise<boolean> {
      this.error = '';
      try {
        const res = await rest.login(phone, password);
        if (res.code === 0 && res.data) {
          this.applySession(res.data);
          return true;
        }
        await this.handleAuthFailure(res, '登录', () =>
          replayed ? Promise.resolve() : this.signIn(phone, password, true),
        );
        return false;
      } catch (error) {
        // Task 5：原始 `error.message`（`Failed to fetch` 等技术串）不进玩家面 ——
        // 中性文案兜底，异常进 reporter（设计 §4.5 / G2）。
        this.error = '登录失败，请稍后重试';
        reportError('auth.signIn', error);
        return false;
      }
    },

    async signUp(
      phone: string,
      password: string,
      nickname: string,
      replayed = false,
    ): Promise<boolean> {
      this.error = '';
      try {
        const res = await rest.register(phone, password, nickname);
        if (res.code === 0 && res.data) {
          this.applySession(res.data);
          return true;
        }
        await this.handleAuthFailure(res, '注册', () =>
          replayed ? Promise.resolve() : this.signUp(phone, password, nickname, true),
        );
        return false;
      } catch (error) {
        this.error = '注册失败，请稍后重试';
        reportError('auth.signUp', error);
        return false;
      }
    },

    /**
     * R34：登录/注册失败的处置**只能**来自 `CLIENT_ACTION` 表（经 `dispatchRestFailure`）。
     *
     * `replay` 是 `REFRESH_SNAPSHOT`/`RECONNECT` 处置的落地：重放一次本次请求，最多一次。
     */
    async handleAuthFailure(
      res: { code: number; message?: string },
      label: string,
      replay: () => Promise<unknown>,
    ): Promise<void> {
      if (res.code === 0) {
        // code 0 却没有 data：§11.1 里 code 0 = 成功，这是契约被违反，没有错误码可分派 —— 必须显式报错
        this.error = `${label}失败：服务端未返回会话数据`;
        return;
      }
      await dispatchRestFailure(res, {
        toast: (report) => {
          // ⚠️ 必须用 `||` 而不是 `??`：`net/errors.ts` 对这个字段的契约原话是「可能为空」，
          // 而 `message: ''` 会短路掉整条降级链（本地文案表 + 带码兜底双双被绕过）——
          // `this.error = ''` 让登录页的 `auth` 提示项不渲染 ⇒ 登录失败**完全无提示**，
          // 正是 R651 要防的「静默吞掉」。
          //
          // 客户端接入片（C34b / §0 显示链）：`10008`（本端被暂停，处置 = `TOAST`）
          // **以客户端文案为准**——服务端 message（网关 `CodedForbidden` 的短串）不作显示
          // 承诺：它只与 socket 兜底 / 两死态组件三面不一致。其余码的服务端 message 优先
          // **逐字不动**（负对照：11002 等 TOAST 兄弟码用例未动仍绿）。
          // ⚠️ 本覆盖落在 **toast 路径**（`net/errors.ts` 的 TOAST 分派）上——⛔ **不是**
          // 下面 BACK_TO_LOBBY 里 11003 那种「按位置」的补位：那里存在是因为
          // BACK_TO_LOBBY 分支只调 `signOutLocally`、toast 不可达；10008 本身就走 toast，
          // 不存在那个可达性问题（照位置直搬会复刻同一教训）。
          this.error =
            report.code === ErrCode.CLIENT_DISABLED
              ? authErrorMessage(ErrCode.CLIENT_DISABLED, label)
              : report.message || authErrorMessage(report.code, label);
        },
        signOutLocally: () => {
          /**
           * T13 收口 F-T13-1：11003（封禁）在协议表里也映到 `BACK_TO_LOBBY`
           * （`packages/protocol/src/errors.ts:92`），而 `dispatchRestFailure` 的
           * BACK_TO_LOBBY 分支**只**执行 signOutLocally、从不执行 toast
           * （`net/errors.ts:147-149`）⇒ 上面的 K1 文案分支在登录失败路径**不可达**
           *（仪器化实测：403 到达但登录页四面全空）。登录语境补一条**可见**文案：
           * 以**客户端文案为准**（K1 裁决写死），不用服务端 message「用户已被封禁」。
           * ⚠️ **仅对 11003 生效** —— 其余 BACK_TO_LOBBY 码（10002/10005）的行为一字不动
           *（负对照用例钉在 `auth-ui-wiring.test.ts`）。
           */
          if (res.code === ErrCode.USER_BANNED) {
            this.error = authErrorMessage(ErrCode.USER_BANNED, label);
          }
          // 10002/10005：令牌已不可用 → 只清本地，**不**调服务端登出（它也会返回这两个码）
          this.clearLocalSession();
        },
        replay,
      });
    },

    /** 登录/注册成功后：写 store、写 `clientConfig`、**持久化**（§5.1/R25）。 */
    applySession(result: rest.LoginResult) {
      this.accessToken = result.accessToken;
      this.refreshToken = result.refreshToken;
      this.userId = result.user.id;
      /**
       * Task 2R：展示资料与令牌**同一次写入** —— 刷新页面后 `hydrate()` 能把名字写回来。
       * `?? ''`：服务端的 `user.nickname` 可以是 `null`（没设过昵称），回落交给 `displayName`。
       */
      this.phone = result.user.phone ?? '';
      this.nickname = result.user.nickname ?? '';
      clientConfig.token = result.accessToken;
      saveSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.user.id,
        phone: this.phone,
        nickname: this.nickname,
      });
      this.loggedIn = true;
      this.error = '';
      this.navigate('lobby');
    },

    /**
     * 只清**本地**会话并回登录页，**不**碰服务端。
     *
     * 调用点：
     *  - `signOut()`：服务端登出之后；
     *  - REST 失败的 `BACK_TO_LOBBY` 处置（R34，`10002`/`10005`）——此时令牌已不可用，
     *    再调服务端登出只会拿到同样的错误码；
     *  - `sessionEnded(message)`：已登录会话被踢 / 冷启动续期失效时带原因清场；
     *  - `NoticeStack` 死态项的「重新登录」动作（无原因）。
     *
     * `message`（Task 5）：只在**显式传入**时写 `this.error` —— 缺省时**保留**既有值。
     * 11003（封禁）先写 K1 文案、再调本函数清本地；若无参调用顺手清掉 `error`，
     * 登录页的 `auth` 提示项会当场消失（T13 的可见性回归）。
     *
     * R36：**先销毁本地 WS 会话**。用户已被判定为未认证，没有理由继续留着一条
     * （可能仍然活着的）下游连接让服务端把他当成在线；`stopSessionHook` 未绑定时空操作。
     */
    clearLocalSession(message?: string) {
      if (message !== undefined) this.error = message;
      stopSessionHook?.();
      clearSession();
      this.accessToken = '';
      this.refreshToken = '';
      this.userId = '';
      // 资料同样要清：否则「登出 → 换个人登录」的瞬间顶栏会显示**上一个人**的名字。
      this.nickname = '';
      this.phone = '';
      clientConfig.token = '';
      this.loggedIn = false;
      this.navigate('login');
    },

    /**
     * 已登录会话被确定性终止（REST 踢出 / 冷启动续期 `invalid`/`no_session`）：
     * 带玩家可读原因清本地并回登录页。登录/注册**尝试**不使用它（10005 负对照）。
     */
    sessionEnded(message: string) {
      this.clearLocalSession(message);
    },

    /**
     * WS 静默续期后回填 store（R35，由 `onTokensRenewed` 回调触发）。
     *
     * `token-refresh` 模块在 refresh 成功后已写回 storage + clientConfig，
     * 本方法只把最新的 `(accessToken, refreshToken)` 同步到 store 字段，
     * 使后续登出（`signOut()` 的 R35 先轮换再登出）拿到的是新令牌而非已作废的旧令牌。
     *
     * 无本地会话时（`loadSession()` 返回 null）直接返回，不做任何改动。
     */
    syncTokensFromStorage() {
      const stored = loadSession();
      if (!stored) return;
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
    },

    /**
     * 冷启动 / 回前台时确认本地 access token 仍然有效。
     *
     * - 无 accessToken（dev mock 路径）→ 直接返回 `true`，无需续期
     * - 本地 JWT exp 未过期（`ensureFreshAccessToken` 返回 `fresh`）→ 返回 `true`，零请求
     * - refresh 成功（`rotated`）→ 回填 store，返回 `true`
     * - refresh 确定性拒绝（`invalid` / `no_session`）→ 清本地会话，返回 `false`
     * - 网络不可用（`unavailable`）→ 不判死，返回 `false`（调用方留 reconnecting 退避）
     *
     * 返回是否仍持有有效会话。
     */
    async renewHydratedSession(): Promise<boolean> {
      if (!this.accessToken) return false;
      const result = await ensureFreshAccessToken().catch(() => 'unavailable' as const);
      switch (result) {
        case 'fresh':
          return true;
        case 'rotated':
          this.syncTokensFromStorage();
          return true;
        case 'invalid':
        case 'no_session':
          // Task 5：冷启动/回前台续期被确定性拒绝 ⇒ 登录页要留下原因（不再静默踢出）。
          this.sessionEnded('登录状态已失效，请重新登录');
          return false;
        case 'unavailable':
          return false;
      }
    },

    /**
     * §5.1：登出要让**服务端吊销**令牌（删掉两个 `jti`）；失败也必须清干净本地。
     *
     * `rest.logout()` 内部按 R35「先轮换、再登出」闭环（最多两次请求，不循环）；
     * 它返回非 0 只说明服务端那侧没做成，本地该清还是要清，并把结果提示出来。
     *
     * ⚠️ 轮换/登出**不会**断开已建立的 WS 连接（R28，已知边界）——
     * 本地会话由调用方在 `signOut()` 之后用 `stopGameSession()` 销毁。
     */
    async signOut(): Promise<void> {
      const { accessToken, refreshToken } = this;
      this.error = '';
      try {
        if (accessToken) {
          const res = await rest.logout(accessToken, refreshToken);
          if (res.code !== 0) {
            // Task 5：中性化 —— 码/技术串只进日志，不给玩家看（`res` 细节由调用栈持有）。
            this.error = '服务端登出未成功，本地会话已清除';
          }
        }
      } catch (error) {
        // 服务端不可达不阻塞本地登出；原始异常进 reporter。
        this.error = '服务端登出失败，本地会话已清除';
        reportError('auth.signOut', error);
      }
      this.clearLocalSession();
    },

    /**
     * 切换页面（**唯一**会改变 `page` 的运行期入口，冷启动的 `hydrate()` 是另一个）。
     *
     * 切片 P10 Task 3：`auth.page` 是**唯一状态源**，uni 的页面栈只是它的投影 ⇒
     * 「先写 page，再 `uni.reLaunch` 到 `pageUrl(page)`」。
     *
     * ⚠️ 顺序不能反：投影失败（页面栈报错）时唯一真源仍然是对的，下一次对齐能追上；
     * 反过来先跳页再写状态，就会留下「页面在大厅、状态说在牌桌」的分叉。
     * ⚠️ 用 `reLaunch` 而不是 `navigateTo`：一步一页、不堆栈（见 `router.ts`）。
     */
    navigate(page: RouteName) {
      this.page = page;
      syncPageStack(page);
    },
  },
});

/**
 * P1-8：REST 的 10004 恢复由 `rotateRefreshToken()` 写 storage + clientConfig，但**不碰
 * store**（net 层不 import store，见 `rest.ts#bindRestTokenRotationHook` 的分层说明）。
 * 在 store 模块加载时注册反向钩子：任何 `authedRequest` 的轮换都会回填 `accessToken` /
 * `refreshToken`，`signOut()` 的 R35「先轮换再登出」因此拿到的是最新 refresh token
 *（旧 token 的 jti 已被轮换吊销，用它登出等于吊销落空）。
 *
 * `getActivePinia()` 守卫：模块加载本身不建实例；纯工具测试（无 Pinia）时 no-op。
 */
rest.bindRestTokenRotationHook(() => {
  if (!getActivePinia()) return;
  useAuthStore().syncTokensFromStorage();
});
