/**
 * 广告小片 T18（规格 v1.3 §2.9 逐字）：客户端薄层 `net/ads.ts` —— 激励视频四分支 + 平台收口。
 *
 * ⚠️ **判据射程**：jsdom 里没有真广告。这里证明的是「平台收口的分支选择」与「四个结果由
 * 正确的宿主事件映射出来」——**不是**「真机上广告播得出来 / 到账」（真机走查确认，设计 §7）。
 *
 * 判别矩阵（每条对着一种「最像正确答案」的错实现）：
 *  ① 平台收口：无 uni 宿主（`readUniSystemInfo()→{}`）⇒ browser ⇒ false；`'app'` ⇒ true；
 *     `'web'`（H5 真实取值）/ `'mp-weixin'` ⇒ false；**未知平台（`detectPlatform` 抛错）
 *     ⇒ false 而不是把异常泄漏给调用方**（渲染条件在模板里读它，抛错 = 白屏）；
 *  ② 创建实参逐字：`{ adpid, urlCallback: { extra } }` —— extra 只承载 claim；
 *     **身份字段零传**（实参对象上不得出现 `userId`；导出签名只有 2 个形参，r3 🟡-8）；
 *  ③ 四分支：`completed`（onClose `isEnded=true`）· `closed`（`false` 或缺字段——朝不发放
 *     方向收口）· `unavailable`（show/load 失败 = 未就绪/无填充；onError 加载失败回调）·
 *     `error`（创建即抛；宿主没有此 API 的同步 TypeError）；
 *  ④ **绝不触发发放**：completed 全程零网络请求（`fetch` 零调用）——发放只由服务端回调链
 *     完成，本层 `onClose` 仅 UX 判据。
 *
 * 假桩形态：在 **stock `installUniStub`** 之上只补 `uni.createRewardedVideoAd` 这一个成员
 * （stock 替身如实不提供宿主尚未被用到的能力）；假广告实例只实现本层用到的方法
 * （`load` / `show` / `onClose` / `onError`）——少一个就是实现越界，当场 TypeError。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUniStub, type UniStub } from './helpers/uni-stub';
import { detectPlatform, readUniSystemInfo } from '../src/net/mp-transport';
import { isRewardedAdSupported, playRewardedAd, getLastRewardedAdErrorDetail } from '../src/net/ads';

/** 假广告实例只实现本层用到的方法（多余成员不存在 ⇒ 实现不得越界调用）。 */
interface FakeRewardedAdContext {
  load(): Promise<void>;
  show(): Promise<void>;
  onClose(callback: (res: { isEnded?: boolean } | undefined) => void): void;
  onError(callback: (err: unknown) => void): void;
}

interface RewardedAdFaults {
  /** 创建即抛（宿主不支持 / 参数被拒形态）。 */
  createThrows?: boolean;
  /** `show()` 的拒绝形态：`'always'` 次次拒；`'first'` 只第一次拒（考 load 重试回落）。 */
  showRejects?: 'always' | 'first';
  /** `load()` 次次拒（无填充）。 */
  loadRejects?: boolean;
}

/**
 * 装一个可手动驱动的假激励视频环境（在 stock 桩上加 `createRewardedVideoAd`）。
 * 记录创建实参；`onClose` / `onError` 经返回的 emit 函数驱动。
 */
function installRewardedAdEnvironment(faults: RewardedAdFaults = {}) {
  const calls = {
    create: [] as unknown[],
    show: 0,
    load: 0,
  };
  let closeCb: ((res: { isEnded?: boolean } | undefined) => void) | null = null;
  let errorCb: ((err: unknown) => void) | null = null;

  const ad: FakeRewardedAdContext = {
    load: () => {
      calls.load += 1;
      return faults.loadRejects
        ? Promise.reject(new Error('无广告填充（假）'))
        : Promise.resolve();
    },
    show: () => {
      calls.show += 1;
      const rejects =
        faults.showRejects === 'always' || (faults.showRejects === 'first' && calls.show === 1);
      return rejects ? Promise.reject(new Error('广告未就绪（假）')) : Promise.resolve();
    },
    onClose: (callback) => {
      closeCb = callback;
    },
    onError: (callback) => {
      errorCb = callback;
    },
  };

  const stub = installUniStub({ platform: 'app' }) as UniStub & {
    createRewardedVideoAd(options: unknown): FakeRewardedAdContext;
  };
  stub.createRewardedVideoAd = (options: unknown) => {
    if (faults.createThrows) throw new Error('createRewardedVideoAd 不可用（假）');
    calls.create.push(options);
    return ad;
  };

  return {
    calls,
    emitClose: (res?: { isEnded?: boolean }) => closeCb?.(res),
    emitError: (err: unknown) => errorCb?.(err),
  };
}

beforeEach(() => {
  // 每个用例从 stock 桩出发（platform='web'）；需要其它平台的用例自己重装。
  installUniStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isRewardedAdSupported：detectPlatform 的异常收口（非 App / 未知平台 ⇒ false）', () => {
  it('读不到平台（readUniSystemInfo()→{}，无 uni 宿主）⇒ browser ⇒ false', () => {
    const saved = (globalThis as { uni?: unknown }).uni;
    // @ts-expect-error 故意摘掉宿主（纯 web / SSR / 单测形态），考降级分支
    delete globalThis.uni;
    try {
      // 前提自证：这个环境下 readUniSystemInfo 确实返回 {}
      expect(readUniSystemInfo()).toEqual({});
      expect(isRewardedAdSupported()).toBe(false);
    } finally {
      (globalThis as { uni?: unknown }).uni = saved;
    }
  });

  it("uniPlatform='app' ⇒ true", () => {
    installUniStub({ platform: 'app' });
    expect(isRewardedAdSupported()).toBe(true);
  });

  it("H5 真实取值 uniPlatform='web' ⇒ false", () => {
    installUniStub({ platform: 'web' });
    expect(isRewardedAdSupported()).toBe(false);
  });

  it("已知但非 App 的平台（mp-weixin）⇒ false", () => {
    installUniStub({ platform: 'mp-weixin' });
    expect(isRewardedAdSupported()).toBe(false);
  });

  it('未知平台（detectPlatform 抛错）⇒ false，不把异常泄漏给调用方', () => {
    installUniStub({ platform: 'mp-alipay' });
    // 前提自证：detectPlatform 在这个平台上确实抛（收口才有意义）
    expect(() => detectPlatform()).toThrow();
    expect(isRewardedAdSupported()).toBe(false);
  });
});

describe('playRewardedAd：四分支 + 身份零传 + 绝不触发发放', () => {
  it('完成观看（onClose isEnded=true）⇒ completed；实参逐字且无身份字段；全程零网络', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = installRewardedAdEnvironment();

    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });

    // 创建同步发生：实参逐字 { adpid, urlCallback: { extra } }（extra 只承载 claim）
    expect(env.calls.create).toEqual([
      { adpid: 'ad_pid_1', urlCallback: { extra: 'claim_nonce_abc123' } },
    ]);
    // 身份字段零传（r3 🟡-8）：实参对象上不得出现 userId 之类的透传字段
    expect(Object.keys(env.calls.create[0] as object)).toEqual(['adpid', 'urlCallback']);

    env.emitClose({ isEnded: true });
    await expect(pending).resolves.toBe('completed');

    // 广告确实被 show 过（「没播就报完成」是错实现）
    expect(env.calls.show).toBe(1);
    // 绝不触发发放：本层不碰任何网络（发放只由服务端回调链完成）
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('中途关闭（onClose isEnded=false）⇒ closed', async () => {
    const env = installRewardedAdEnvironment();
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    env.emitClose({ isEnded: false });
    await expect(pending).resolves.toBe('closed');
  });

  it('isEnded 缺失 ⇒ closed（朝不发放方向收口，绝不把缺失当看完）', async () => {
    const env = installRewardedAdEnvironment();
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    env.emitClose({});
    await expect(pending).resolves.toBe('closed');
  });

  it('show 失败（未就绪）+ load 失败（无填充）⇒ unavailable', async () => {
    const env = installRewardedAdEnvironment({ showRejects: 'always', loadRejects: true });
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    await expect(pending).resolves.toBe('unavailable');
    expect(env.calls.load).toBe(1); // load 失败即止：不再有第二次 show
    expect(env.calls.show).toBe(1);
  });

  it('load 成功但重试的 show 仍失败 ⇒ unavailable（重试一次即止，不无限循环）', async () => {
    const env = installRewardedAdEnvironment({ showRejects: 'always' });
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    await expect(pending).resolves.toBe('unavailable');
    expect(env.calls.load).toBe(1);
    expect(env.calls.show).toBe(2);
  });

  it('show 首次失败但 load 重试后 show 成功 ⇒ 仍等 onClose 收口（不提前判死）', async () => {
    const env = installRewardedAdEnvironment({ showRejects: 'first' });
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });

    // 冲刷微任务：show 拒 ⇒ load ⇒ show 成功，此后唯一出口是 onClose
    await Promise.resolve();
    await Promise.resolve();
    env.emitClose({ isEnded: true });
    await expect(pending).resolves.toBe('completed');
    expect(env.calls.load).toBe(1);
    expect(env.calls.show).toBe(2);
  });

  it('onError 回调（加载失败 / 无填充的平台形态）⇒ unavailable', async () => {
    const env = installRewardedAdEnvironment();
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    env.emitError(new Error('无广告填充（假）'));
    await expect(pending).resolves.toBe('unavailable');
  });

  it('onError 的 errCode/errMsg 被捕获到诊断详情（真机排障面）', async () => {
    const env = installRewardedAdEnvironment();
    const pending = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    env.emitError({ errCode: -5002, errMsg: '无效的广告位标识adpid' });
    await expect(pending).resolves.toBe('unavailable');
    expect(getLastRewardedAdErrorDetail()).toContain('-5002');
    expect(getLastRewardedAdErrorDetail()).toContain('无效的广告位标识adpid');
  });

  it('创建即抛的错误消息也进入诊断详情', async () => {
    installRewardedAdEnvironment({ createThrows: true });
    await expect(playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' })).resolves.toBe('error');
    expect(getLastRewardedAdErrorDetail()).toContain('createRewardedVideoAd 不可用');
  });

  it('每次播放开始重置诊断详情（上一发的错误不会串到下一发）', async () => {
    const env = installRewardedAdEnvironment();
    const first = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' });
    env.emitError({ errCode: -5002, errMsg: '无效的广告位标识adpid' });
    await first;
    expect(getLastRewardedAdErrorDetail()).not.toBe('');

    const second = playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc124' });
    expect(getLastRewardedAdErrorDetail()).toBe('');
    env.emitClose({ isEnded: true });
    await expect(second).resolves.toBe('completed');
  });

  it('创建即抛 ⇒ error（异常收口，不向调用方泄漏）', async () => {
    installRewardedAdEnvironment({ createThrows: true });
    await expect(playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' })).resolves.toBe('error');
  });

  it('宿主没有 uni.createRewardedVideoAd（H5 形态）⇒ error（同步 TypeError 被收口）', async () => {
    // 不装假桩：stock 替身没有这个成员（如实映射 uni-h5 的形态）
    installUniStub({ platform: 'app' });
    await expect(playRewardedAd('ad_pid_1', { extra: 'claim_nonce_abc123' })).resolves.toBe('error');
  });

  it('无 userId 形参（r3 🟡-8）：导出签名只有 adpid + opts 两个形参', () => {
    expect(playRewardedAd.length).toBe(2);
  });
});
