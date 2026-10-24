/**
 * 广告小片 T19（规格 v1.3 §2.9 逐字）：lobby **救助正片流程** ——
 * 点击预检 → 弹层 → 确认**续窗** → `playRewardedAd` →（`completed`）携 claim 轮询到账。
 *
 * ## 判据射程
 *
 * `net/ads.ts`（激励视频薄层）由 T18 的 `ads.test.ts` 单测；这里把它**整个换成替身**
 * （`isRewardedAdSupported` 恒 true、`playRewardedAd` 由用例驱动四结果）——
 * 本文件证的是 **lobby 的编排**：什么时候查询、拿哪一发响应的 claim 去播、
 * 播完后怎么轮询、到账后怎么收口。jsdom 里没有真广告，真机形态由走查确认。
 *
 * ## 判别矩阵（每条对着一种「最像正确答案」的错实现）
 *
 *  ① **点击 = 预检签发**（不是「先弹层再查询」）：可领才开层；不可领 ⇒ 服务端 reason
 *    落提示行；失败 ⇒「网络异常，请重试」。弹层打开本身**不再发**任何请求。
 *  ② **确认 = 续窗**（第二发**无 claim** 的裁决 GET；不是复用点击时的旧值）：
 *    播放实参的 `extra` 必须是**续窗那一发**返回的 claim（夹具让两发 claim 不同 ⇒
 *    「拿旧值去播」当场红）；续窗失败/不可领 ⇒ 不播放、不轮询。
 *  ③ **`completed` ⇒ 轮询到账**（2s×3、终态即止）三出口：
 *    成功面（关层 + `setWalletBalance` + 「已领取救助 +N」）/ 终态 reason（显示并止）/
 *    纯 pending 满窗（「发放可能稍有延迟，稍后回到本页查看」）。
 *  ④ **`closed` / `unavailable` / `error` 都不轮询、不发放**；前三者各自文案逐字
 *    （`closed` ⇒「完整观看才能领取」；`unavailable` 与 `error` ⇒「暂时没有可播放的
 *    广告，稍后再试」——两出口同文案＝规格冻结后的补充登记，见 `lobby.vue` 的注释）。
 *  ⑤ **防双击**：确认按钮在流程进行中重复点击不得造出第二个播放（`playRewardedAd` 恰 1 次）。
 *  ⑥ **关层 = 流程中止**：取消后 busy 复位、可重新走完整条流程。
 *
 * 时序口径：照 `wallet-page.test.ts` ⑤ 的既有形态 —— `vi.useFakeTimers()` 后
 * 一切「发放 → 落定」用 `vi.advanceTimersByTimeAsync(0)`（settle）驱动；
 * 轮询间隔（2s）由假钟推进，**同时钉住「首查立即」与「每 2s 一发」**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { getLastRewardedAdErrorDetail, isRewardedAdSupported, playRewardedAd } from '../src/net/ads';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { clearSession, saveSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { stopGameSession } from '../src/composables/useGameSession';

/**
 * `net/ads` 整体替身：**薄层的四分支由 `ads.test.ts` 单独覆盖**，本文件的被测对象是
 * lobby 的编排（什么时候调它、拿什么实参调、结果怎么收口）。真实平台收口
 * （`isRewardedAdSupported` 的 uni 平台判定）由 `lobby-ux.test.ts` 的入口条件组覆盖。
 */
vi.mock('../src/net/ads', () => ({
  isRewardedAdSupported: vi.fn(() => true),
  playRewardedAd: vi.fn(),
  // 诊断面：生产缺省无详情（空串）⇒ 冻结文案不变；诊断构建的显示分支在本文件另有专测。
  getLastRewardedAdErrorDetail: vi.fn(() => ''),
}));

/** 断言模板文本时先折叠空白（同 `lobby-ux.test.ts`）。 */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** 记录 `fetch` 的每一次调用（`rest.ts` 只用到 `status` 与 `text()`）。 */
interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** `GET /api/wallet/relief` 可领面（签发/复用）：claim 随响应返回。 */
function eligible(claim: string) {
  return { code: 0, data: { eligible: true, grantedToday: false, amount: 200, balance: 90, claim } };
}

/** 携 claim 轮询看到的 **pending** 面（记录 issued；无 claim / 无 reason）。 */
function pending() {
  return { code: 0, data: { eligible: true, grantedToday: false, amount: 200, balance: 90 } };
}

/** 成功面（granted / replayed 同处置；账本已真）。 */
function granted(balance = 290) {
  return { code: 0, data: { eligible: false, grantedToday: true, amount: 200, balance } };
}

/** 不可领 / 终态拒绝面：服务端 reason 逐字。 */
function notEligible(reason: string) {
  return {
    code: 0,
    data: { eligible: false, grantedToday: false, amount: 200, balance: 90, reason },
  };
}

let pinia: ReturnType<typeof createPinia>;

/**
 * 挂大厅：`/config`（带 `reliefAdpid`、救助开、倍率 10）、`/wallet/balance`（90 < 150 ⇒
 * 入口点亮）、`/wallet/relief` 按**本端点序号**给预先排好的响应（序号 0 = 点击预检那一发）。
 */
function mountLobby(options: { relief?: (n: number) => unknown } = {}) {
  let reliefN = 0;
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.includes('/wallet/relief')
      ? (options.relief?.(reliefN++) ?? notEligible('救助暂未开放'))
      : url.includes('/wallet/balance')
        ? { code: 0, data: { balance: 90 } }
        : url.includes('/config')
          ? {
              code: 0,
              data: {
                baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
                friendRoomEnabled: false,
                freeRoomEnabled: true,
                goldRoomEnabled: true,
                reliefEnabled: true,
                reliefAdpid: 'adpid_test_1',
                entryMultiplier: 10,
                version: 9,
              },
            }
          : { code: 0, data: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal('fetch', mock);
  useAuthStore().navigate('lobby');
  const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

/** 只数 `/wallet/relief` 的调用（按调用序；序号 0 = 点击预检、1 = 确认续窗、2.. = 轮询）。 */
function reliefCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.includes('/wallet/relief'));
}

/** 假钟下「发放 → 落定」的冲洗（wallet-page.test.ts ⑤ 同款）。 */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

/** 从入口点到弹层打开（前置：入口必须已渲染）。 */
async function clickEntry(wrapper: ReturnType<typeof mount>) {
  const entry = wrapper.find('.lobby__relief');
  expect(entry.exists(), '前置：入口必须已渲染（reliefAvailable ∧ App ∧ adpid 非空）').toBe(true);
  await entry.trigger('click');
  await settle();
}

/** 确认并等「广告结果 → 首查落定」全部吐完。 */
async function clickConfirm(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('.lobby__relief-confirm').trigger('click');
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = 'a1';
  saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
  // ⚠️ `restoreMocks: true` 之下逐用例重设（不依赖上一个用例的残留实现）。
  vi.mocked(isRewardedAdSupported).mockReset().mockReturnValue(true);
  vi.mocked(playRewardedAd).mockReset().mockResolvedValue('completed');
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// ① 点击 = 预检签发（getRelief 无 claim）；可领 ⇒ 弹层
// ---------------------------------------------------------------------------

describe('① 点击 ⇒ 预检签发 → 可领 ⇒ 弹层', () => {
  it('点入口 ⇒ 一发**无 claim** 的 GET；可领 ⇒ 弹层（新文案、不再写「占位」）；开层不再发请求', async () => {
    const { wrapper, calls } = mountLobby({ relief: () => eligible('claim_click_1') });
    await settle();

    await clickEntry(wrapper);

    const relief = reliefCalls(calls);
    expect(relief, '点击 ⇒ 恰一发预检 GET').toHaveLength(1);
    expect(relief[0]!.init?.method ?? 'GET', '只读 GET（旧 POST 面已退役）').toBe('GET');
    expect(relief[0]!.url, '预检不带 claim（签发/复用走服务端裁决路径）').toMatch(/\/wallet\/relief$/);
    expect(relief[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });

    const panel = wrapper.find('.lobby__relief-panel');
    expect(panel.exists(), '可领 ⇒ 弹层').toBe(true);
    expect(flat(panel.text()), '文案说明「先看广告」——占位期的话术必须消失').toContain('激励视频');
    expect(flat(panel.text()), '「占位」字样不得残留（正片已上线）').not.toContain('占位');
    expect(wrapper.find('.lobby__relief-confirm').exists(), '确认按钮在场').toBe(true);
    expect(wrapper.find('.lobby__relief-cancel').exists(), '取消按钮在场').toBe(true);

    expect(reliefCalls(calls), '弹层打开本身不发第二个请求').toHaveLength(1);
  });

  it('点击时不可领（服务端 reason）⇒ 提示行显示 reason、**不开层**、零播放', async () => {
    const { wrapper, calls } = mountLobby({ relief: () => notEligible('今天已经领过了') });
    await settle();

    await clickEntry(wrapper);

    expect(wrapper.find('.lobby__relief-dialog').exists(), '不可领 ⇒ 无弹层').toBe(false);
    expect(flat(wrapper.get('[data-notice-id="relief"] .notice__text').text())).toBe('今天已经领过了');
    expect(vi.mocked(playRewardedAd)).not.toHaveBeenCalled();
    expect(reliefCalls(calls)).toHaveLength(1);
  });

  it('点击时失败（10007）⇒「网络异常，请重试」、不开层', async () => {
    const { wrapper } = mountLobby({ relief: () => ({ code: 10007, message: '下游不可用', data: null }) });
    await settle();

    await clickEntry(wrapper);

    expect(wrapper.find('.lobby__relief-dialog').exists()).toBe(false);
    expect(flat(wrapper.get('[data-notice-id="relief"] .notice__text').text())).toBe('网络异常，请重试');
  });
});

// ---------------------------------------------------------------------------
// ② 确认 = 续窗（第二发无 claim）⇒ playRewardedAd(adpid, { extra: 续窗的 claim })
// ---------------------------------------------------------------------------

describe('② 确认 ⇒ 续窗 ⇒ playRewardedAd（实参逐字）', () => {
  it('续窗用**新的一发**响应里的 claim 去播（两发 claim 不同 ⇒ 拿旧值去播当场红）', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) => (n === 0 ? eligible('claim_click_1') : n === 1 ? eligible('claim_confirm_2') : granted()),
    });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper);

    const relief = reliefCalls(calls);
    // 点击(0) + 续窗(1) + 首查立即(2, 已被上面的 granted 收口) = 3 发
    expect(relief, '确认 ⇒ 第二发（续窗）').toHaveLength(3);
    expect(relief[1]!.url, '续窗同样是**无 claim** 的裁决 GET（find-or-create 复用 + 续期）').toMatch(
      /\/wallet\/relief$/,
    );
    expect(vi.mocked(playRewardedAd), '播放实参 = (配置的 adpid, { extra: 续窗响应的 claim })').toHaveBeenCalledWith(
      'adpid_test_1',
      { extra: 'claim_confirm_2' },
    );
    expect(relief[2]!.url, '轮询携的也是**续窗那一发**的 claim').toContain('claim=claim_confirm_2');
  });

  it('续窗失败 ⇒「网络异常，请重试」、不播放、不轮询；弹层留着（可再试）', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) => (n === 0 ? eligible('claim_click_1') : { code: 10007, message: 'x', data: null }),
    });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper);

    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('网络异常，请重试');
    expect(vi.mocked(playRewardedAd)).not.toHaveBeenCalled();
    expect(reliefCalls(calls), '失败不轮询').toHaveLength(2);
    expect(wrapper.find('.lobby__relief-dialog').exists(), '层留着：用户可以再点一次确认').toBe(true);
  });

  it('续窗时不可领（期间已被别处领过/开关关）⇒ 服务端 reason、不播放', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) => (n === 0 ? eligible('claim_click_1') : notEligible('救助暂未开放')),
    });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper);

    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('救助暂未开放');
    expect(vi.mocked(playRewardedAd)).not.toHaveBeenCalled();
    expect(reliefCalls(calls)).toHaveLength(2);
  });

  it('防双击：流程进行中重复点确认 ⇒ playRewardedAd 恰 1 次、续窗恰 1 发', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) => (n === 0 ? eligible('c1') : n === 1 ? eligible('c2') : granted()),
    });
    await settle();
    await clickEntry(wrapper);

    // 两连击**不冲洗**：第二击必须被 busy 守卫挡在入口
    await wrapper.find('.lobby__relief-confirm').trigger('click');
    await wrapper.find('.lobby__relief-confirm').trigger('click');
    await settle();

    expect(vi.mocked(playRewardedAd)).toHaveBeenCalledTimes(1);
    // 点击 + 续窗**恰一发** + 首查立即（流程照常走到底）= 3；若有第二发续窗会在 4+。
    expect(reliefCalls(calls), '续窗只发一发').toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// ③ completed ⇒ 轮询终态三出口（2s × 3；终态即止）
// ---------------------------------------------------------------------------

describe('③ completed ⇒ 携 claim 轮询（2s×3）三出口', () => {
  it('成功面：首查立即命中 ⇒ 关层 + 刷 chip + 「已领取救助 +N」；停表不再发', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) => (n === 0 ? eligible('c1') : n === 1 ? eligible('c2') : granted(290)),
    });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper); // 播完 ⇒ 首查立即（t=0）

    const relief = reliefCalls(calls);
    expect(relief, '点击 + 续窗 + 首查立即 = 3 发').toHaveLength(3);
    expect(relief[2]!.url, '轮询携 claim（只读查询）').toContain('claim=c2');

    // 成功面的四件套：关层 / 余额 / 文案 / 入口随余额熄灭
    expect(wrapper.find('.lobby__relief-dialog').exists(), '成功 ⇒ 关层').toBe(false);
    expect(useGameStore().walletBalance, 'setWalletBalance(响应里的 balance)').toBe(290);
    // Task 8：成功面关层 ⇒ 同一条消息从面板内换到浮层 `relief` 项（成功态 3s）。
    expect(flat(wrapper.get('[data-notice-id="relief"] .notice__text').text())).toBe('已领取救助 +200');
    expect(wrapper.find('.wallet-entry .chip__currency').text(), 'chip 直刷').toBe('290');
    expect(wrapper.find('.lobby__relief').exists(), '290 ≥ 150 ⇒ 入口熄灭').toBe(false);

    await vi.advanceTimersByTimeAsync(10000);
    expect(reliefCalls(calls), '终态即止：之后一发都不再发').toHaveLength(3);
  });

  it('终态 reason：显示服务端 reason 并止（余额不动、层留着）', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) =>
        n === 0 ? eligible('c1') : n === 1 ? eligible('c2') : n === 2 ? pending() : notEligible('领取凭证已失效，请重试'),
    });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper); // 首查 pending
    expect(wrapper.find('.lobby__relief-dialog').exists(), 'pending 期间层继续开着').toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // 第 2 发 ⇒ 终态 reason

    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('领取凭证已失效，请重试');
    expect(useGameStore().walletBalance, '未发放 ⇒ 余额不动').toBe(90);
    expect(reliefCalls(calls), '点击 + 续窗 + 两发轮询 = 4（第 2 发即终态）').toHaveLength(4);

    await vi.advanceTimersByTimeAsync(10000);
    expect(reliefCalls(calls), '终态即止').toHaveLength(4);
  });

  it('纯 pending 满窗：恰 3 发、2s 间隔（首查立即）⇒「发放可能稍有延迟，稍后回到本页查看」', async () => {
    const { wrapper, calls } = mountLobby({
      relief: (n) => (n === 0 ? eligible('c1') : n === 1 ? eligible('c2') : pending()),
    });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper); // 首查立即（t=0）
    expect(reliefCalls(calls), '首查立即（不等第一个 2s）').toHaveLength(3);
    expect(wrapper.find('.lobby__relief-note').exists(), 'pending 不写提示').toBe(false);

    await vi.advanceTimersByTimeAsync(2000); // 第 2 发（t=2s）
    expect(reliefCalls(calls)).toHaveLength(4);
    expect(wrapper.find('.lobby__relief-note').exists(), '窗未满、仍 pending ⇒ 还不写').toBe(false);

    await vi.advanceTimersByTimeAsync(2000); // 第 3 发（t=4s）⇒ 满窗
    expect(reliefCalls(calls)).toHaveLength(5);
    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('发放可能稍有延迟，稍后回到本页查看');

    await vi.advanceTimersByTimeAsync(10000);
    expect(reliefCalls(calls), '满窗停表：不再发第 4 发').toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// ④⑤⑥ closed / unavailable / error：各自文案、不轮询、不发放
// ---------------------------------------------------------------------------

describe('④⑤⑥ 未看完 / 播不出来：文案逐字、不轮询', () => {
  it('closed（中途关闭）⇒「完整观看才能领取」、零轮询', async () => {
    vi.mocked(playRewardedAd).mockResolvedValue('closed');
    const { wrapper, calls } = mountLobby({ relief: (n) => (n === 0 ? eligible('c1') : eligible('c2')) });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper);

    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('完整观看才能领取');
    expect(useGameStore().walletBalance).toBe(90);
    await vi.advanceTimersByTimeAsync(10000);
    expect(reliefCalls(calls), 'closed 不轮询（点击 + 续窗 = 2）').toHaveLength(2);
  });

  it('unavailable（未就绪/无填充）⇒「暂时没有可播放的广告，稍后再试」、零轮询', async () => {
    vi.mocked(playRewardedAd).mockResolvedValue('unavailable');
    const { wrapper, calls } = mountLobby({ relief: (n) => (n === 0 ? eligible('c1') : eligible('c2')) });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper);

    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('暂时没有可播放的广告，稍后再试');
    await vi.advanceTimersByTimeAsync(10000);
    expect(reliefCalls(calls)).toHaveLength(2);
  });

  it('error（创建阶段异常）⇒ 与 unavailable **同文案**（规格冻结后的补充登记映射）', async () => {
    vi.mocked(playRewardedAd).mockResolvedValue('error');
    const { wrapper, calls } = mountLobby({ relief: (n) => (n === 0 ? eligible('c1') : eligible('c2')) });
    await settle();
    await clickEntry(wrapper);

    await clickConfirm(wrapper);

    expect(flat(wrapper.get('.lobby__relief-note').text())).toBe('暂时没有可播放的广告，稍后再试');
    expect(useGameStore().walletBalance, '不发放 ⇒ 余额不动').toBe(90);
    await vi.advanceTimersByTimeAsync(10000);
    expect(reliefCalls(calls), 'error 不轮询').toHaveLength(2);
  });

  it('诊断构建（VITE_AD_DIAG=1）⇒ 通用文案后附 SDK 错误码（生产构建缺省不附）', async () => {
    vi.stubEnv('VITE_AD_DIAG', '1');
    try {
      vi.mocked(playRewardedAd).mockResolvedValue('unavailable');
      vi.mocked(getLastRewardedAdErrorDetail).mockReturnValue('-5002 无效的广告位标识adpid');
      const { wrapper } = mountLobby({ relief: (n) => (n === 0 ? eligible('c1') : eligible('c2')) });
      await settle();
      await clickEntry(wrapper);

      await clickConfirm(wrapper);

      expect(flat(wrapper.get('.lobby__relief-note').text())).toBe(
        '暂时没有可播放的广告，稍后再试（-5002 无效的广告位标识adpid）',
      );
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(getLastRewardedAdErrorDetail).mockReturnValue('');
    }
  });
});

// ---------------------------------------------------------------------------
// ⑦ 关层 = 流程中止（busy 复位，可重新走整条流程）
// ---------------------------------------------------------------------------

describe('⑦ 关层（取消）⇒ 流程中止且可重走', () => {
  it('取消后再开层：GET 再发一发、弹层重新出现（busy 不粘死）', async () => {
    const { wrapper, calls } = mountLobby({ relief: () => eligible('c1') });
    await settle();
    await clickEntry(wrapper);

    await wrapper.find('.lobby__relief-cancel').trigger('click');
    expect(wrapper.find('.lobby__relief-dialog').exists(), '取消 ⇒ 关层').toBe(false);

    await clickEntry(wrapper);
    expect(wrapper.find('.lobby__relief-dialog').exists(), '重开 ⇒ 弹层再来').toBe(true);
    expect(reliefCalls(calls), '重开 = 再发一发无 claim 的预检 GET').toHaveLength(2);
  });
});
