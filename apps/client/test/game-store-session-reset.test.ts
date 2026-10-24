/**
 * 跨局/跨会话的**生命周期边界复位**（N32 + N30②，同一根因族）。
 *
 * ## 为什么需要这一族判据
 *
 * `version` 是**每局**的版本号（`design.md` §0.3 术语表逐字：「对局版本（version） | **每局**状态版本号」），
 * 而客户端把它存在**跨局存活**的 pinia store 里。于是「上一局的终值」会与「新局的初值」比较 ——
 * 这不是 M08（§6.2 快照类 `version < currentVersion` ⇒ 主动重连）意义上的**回退**，而是**换了命名空间**。
 *
 * 实测的后果（N32，真浏览器逐帧取证的原文）：
 * ```
 * S→C room.matched {roomCode:"HGC1JS"}
 * S→C game.deal    {version:1, …}
 * C→S game.reconnect {lastVersion:56}          ← 把新局的 v1 判成回退
 * notice「reconnect_ack 快照 version 1 回退于已应用的 56；按 M08 主动重连，不做本地修复」
 * ⇒ 连发 7 条 game.reconnect ⇒ 13010 ⇒ 被踢回大厅，第二局**永远进不去**
 * ```
 *
 * ## 两条复位点（R418/R419）
 *
 * - **换房间**（`setRoom` 的 `roomCode` 变化）⇒ 换局 ⇒ 复位 `currentVersion`；
 * - **销毁本次会话**（`stopGameSession`）⇒ 本地对局渲染状态失去意义 ⇒ 复位整个 game store。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useGameStore } from '../src/stores/game';
import type { ReconnectReason } from '../src/net/socket';
import { FakeSocket, playerViewFixture } from './helpers/fake-socket';
import { SRC_ROOT } from './helpers/source-scan';

function freshStore(onReconnect?: (r: ReconnectReason) => void) {
  setActivePinia(createPinia());
  return useGameStore().bindRuntime({ reconnect: (r) => onReconnect?.(r) });
}

describe('N32：换房间 ⇒ 换局 ⇒ 版本命名空间复位（R417/R418）', () => {
  it('进入**另一个**房间时复位 currentVersion 与对局渲染状态；新局的 v1 快照必须被应用（不是回退）', () => {
    const reconnect = vi.fn();
    const store = freshStore(reconnect);

    // 上一局：房间 AAAAAA 打到 v50
    store.setRoom('AAAAAA', 0);
    expect(store.applySnapshot(playerViewFixture({ roomCode: 'AAAAAA', version: 50, seat: 0 }))).toBe('applied');
    expect(store.currentVersion).toBe(50);

    // 用户点「返回大厅」→ 再点「开始游戏」→ 服务端下发新房间的 room.matched
    store.setRoom('BBBBBB', 1);

    // ⚠️ 核心断言：上一局的 50 不得跨到新局
    expect(store.currentVersion).toBe(-1);
    expect(store.view).toBeNull();

    // 新局的发牌（v1）必须被**接受** —— 修前这里返回 'rollback' 且 reconnect 被调 1 次
    expect(store.applySnapshot(playerViewFixture({ roomCode: 'BBBBBB', version: 1, seat: 1 }))).toBe('applied');
    expect(store.currentVersion).toBe(1);
    expect(store.roomCode).toBe('BBBBBB');
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('正对照：**同一房间**的重复 setRoom 不复位（不得清掉进行中的对局）', () => {
    const store = freshStore();
    store.setRoom('AAAAAA', 0);
    store.applySnapshot(playerViewFixture({ roomCode: 'AAAAAA', version: 7, seat: 0 }));

    // 重复到达的 room.matched / 同一房间的再次进房
    store.setRoom('AAAAAA', 0);

    expect(store.currentVersion).toBe(7);
    expect(store.view?.version).toBe(7);

    // 同一局内的 M08 语义**必须**保持：更低的版本仍是回退
    const reconnect = vi.fn();
    store.bindRuntime({ reconnect });
    expect(store.applySnapshot(playerViewFixture({ roomCode: 'AAAAAA', version: 6, seat: 0 }))).toBe('rollback');
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('两条进房路径共用同一个复位点（源码级：不得有第三条绕过 setRoom 的写法）', () => {
    const session = readFileSync(join(SRC_ROOT, 'composables/useGameSession.ts'), 'utf8');
    /**
     * ⚠️ 片③ Task 3：**手动进房**（房号加入 / 建房后进房 / 点列表项）随开局区从大厅
     * 搬到了玩法页（R749）⇒ 本条**跟着实现走**。
     *
     * ⚠️ **记一笔**：spec §6.2 的迁移表把本文件判成「不挂载页面、也没有页面清单 ⇒ 预期零改动」，
     * 实测**不成立** —— 本条是**按路径读文件内容**的源码级判据，实现搬走它就红。
     * （spec §6.2 自己写着：「发现要改就记下来（说明分类错了）」。）
     */
    const game = readFileSync(join(SRC_ROOT, 'pages/game/game.vue'), 'utf8');
    const lobby = readFileSync(join(SRC_ROOT, 'pages/lobby/lobby.vue'), 'utf8');

    // 自动路径（room.matched → joinMatchedRoom）与手动路径（输入房号加入）都必须经 store.setRoom
    expect(session).toContain('store.setRoom(payload.roomCode, payload.seat)');
    expect(game).toContain('store.setRoom(code,');
    // 复位规则只允许在 store 里出现一次（`reset()` 的实现体不算）—— 两个页面都不许自己写
    expect(session).not.toMatch(/currentVersion\s*=\s*-1/);
    expect(game).not.toMatch(/currentVersion\s*=\s*-1/);
    expect(lobby).not.toMatch(/currentVersion\s*=\s*-1/);
  });
});

describe('N30②：销毁本地会话 ⇒ 复位 game store（R419）', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('stopGameSession() 清掉 matching —— 退出登录后再登录，必须还能点「开始游戏」', async () => {
    setActivePinia(createPinia());
    const session = await import('../src/composables/useGameSession');
    const store = useGameStore();
    session.startGameSession(() => new FakeSocket());
    store.setMatching(true);
    store.setRoom('AAAAAA', 0);
    store.applySnapshot(playerViewFixture({ roomCode: 'AAAAAA', version: 3, seat: 0 }));
    expect(store.matching).toBe(true);

    session.stopGameSession();

    // 大厅的按钮完全由 store.matching 决定（lobby.vue 的 `v-if="!matching"`）
    expect(store.matching).toBe(false);
    expect(store.view).toBeNull();
    expect(store.currentVersion).toBe(-1);
    expect(store.roomCode).toBeNull();
  });

  it('auth.clearLocalSession()（退出登录的路径）经 R36 钩子同样清掉 matching', async () => {
    setActivePinia(createPinia());
    const session = await import('../src/composables/useGameSession');
    const { useAuthStore } = await import('../src/stores/auth');
    const store = useGameStore();
    const auth = useAuthStore();

    session.startGameSession(() => new FakeSocket());
    store.setMatching(true);
    auth.applySession({ accessToken: 'a', refreshToken: 'r', user: { id: 'u', phone: '13800000000' } });

    auth.clearLocalSession();

    expect(store.matching).toBe(false);
    expect(auth.page).toBe('login');
  });
});

/**
 * 钱包摘要共享状态（2026-10-23 钱包拆分 §4.5）。
 *
 * 判别力：
 *  · 序号化写入 —— 慢响应晚到不得覆盖快响应；
 *  · `reset()` **自增**序号（不是归 0）⇒ 旧会话的在途响应被拦掉，不得写回上一账号的余额；
 *  · 摘要成功写回 `walletBalance`（大厅 chip 同源），失败/旧序号不动它。
 */
describe('钱包摘要共享状态：序号化写入与 reset 失效', () => {
  it('只接受最新序号；旧序号的成功/错误都返回 false 且不改状态', () => {
    setActivePinia(createPinia());
    const store = useGameStore();
    const view = (balance: number) => ({
      balance,
      withdrawable: balance - 40,
      dailyWithdrawRemainingCoins: 5000,
    });

    const a = store.beginWalletSummaryRequest();
    expect(store.applyWalletSummary(view(100), a)).toBe(true);
    expect(store.walletSummary?.balance).toBe(100);
    expect(store.walletBalance, '摘要余额同步大厅 chip').toBe(100);

    const b = store.beginWalletSummaryRequest();
    expect(b).toBeGreaterThan(a);
    expect(store.applyWalletSummary(view(200), b)).toBe(true);
    expect(store.applyWalletSummary(view(999), a), '慢响应晚到必须被拦').toBe(false);
    expect(store.walletSummary?.balance).toBe(200);
    expect(store.walletBalance).toBe(200);

    expect(store.setWalletSummaryError('旧错误', a)).toBe(false);
    expect(store.walletSummaryError).toBe('');
    expect(store.setWalletSummaryError('新错误', b)).toBe(true);
    expect(store.walletSummaryError).toBe('新错误');

    const c = store.beginWalletSummaryRequest();
    expect(store.applyWalletSummary(view(300), c)).toBe(true);
    expect(store.walletSummaryError, '成功写摘要时清错误').toBe('');
  });

  it('reset() 自增序号：清四项 + 旧会话在途响应被忽略', () => {
    setActivePinia(createPinia());
    const store = useGameStore();
    const view = { balance: 100, withdrawable: 60, dailyWithdrawRemainingCoins: 40 };

    const inFlight = store.beginWalletSummaryRequest();
    expect(store.applyWalletSummary(view, inFlight)).toBe(true);
    store.walletRecordsStale = true;

    store.reset();

    expect(store.walletSummary).toBeNull();
    expect(store.walletSummaryError).toBe('');
    expect(store.walletRecordsStale).toBe(false);
    expect(store.walletBalance).toBeNull();
    expect(store.applyWalletSummary(view, inFlight), '旧会话的在途响应不得写回').toBe(false);
    expect(store.walletSummary).toBeNull();
    expect(store.walletBalance).toBeNull();
  });
});
