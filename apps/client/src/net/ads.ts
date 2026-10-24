/**
 * 广告小片 T18：App 端激励视频薄层（规格 v1.3 §2.9 · 设计 v1.4 §5.1）。
 *
 * ## 契约（逐字）
 *
 * ```ts
 * playRewardedAd(adpid, { extra: claim }): Promise<'completed' | 'closed' | 'unavailable' | 'error'>
 * isRewardedAdSupported(): boolean   // detectPlatform() 的异常收口版（非 App / 未知平台 ⇒ false）
 * ```
 *
 * ## 三条纪律
 *
 *  1. **身份只来自 claim**：本层**没有** `userId` 形参（评审 r3 🟡-8）——claim 经
 *     `urlCallback.extra` 原样透传给 uni-ad 的服务器回调；平台侧若有同名透传字段，
 *     服务端一律不读（回调链的身份读取只有 claim 一条）。
 *  2. **绝不触发发放**：`onClose(res.isEnded)` 只作 **UX 判据**（`completed`/`closed` 两分支）。
 *     发放由服务端回调链独立完成（账本先行 + claim 绑定）——本层不碰任何网络/钱包；
 *     真机上「看完」与「到账」是两条时间线，完成 ≠ 到账（到账由 lobby 轮询 `getRelief` 确认）。
 *  3. **异常收口**：`detectPlatform()` 对未知平台**抛错**（`mp-transport.ts` 的设计）——
 *     `isRewardedAdSupported()` 把它收成 `false`：渲染条件从模板里读它，抛错 = 白屏，
 *     这里必须是布尔出口。
 *
 * ## 结果映射
 *
 * - `completed`：`onClose` 且 `isEnded === true`（看完）；
 * - `closed`：`onClose` 但未看完（`isEnded` 缺失同样归此——**朝不发放方向收口**，
 *   绝不把「没写 isEnded」当成「看完了」）；
 * - `unavailable`：创建之后拿不到广告——`show`/`load` 失败（未就绪 / 无填充）或
 *   `onError` 加载失败回调；
 * - `error`：**创建阶段**的异常（宿主没有此 API、实参被拒等同步抛错）——不向调用方泄漏异常。
 *
 * ## API 形态与类型缺口
 *
 * `uni.createRewardedVideoAd({ adpid, urlCallback: { extra } })` —— `urlCallback` 是 uni-ad
 * **服务器回调**的创建参数（实参形态 = 规格 §2.9 逐字），但本仓 `@dcloudio/types` 的
 * `RewardedVideoAdOptions`（`uni-app/uni/legacy/uni.d.ts:8963`）尚未收录它 ⇒ 经
 * **非字面量变量**传入（对象字面量直传会被 TS 的 excess property 检查拒收；目标类型
 * 属性全可选，变量形态结构合法）。`urlCallback` 的线上真实行为 = T0-4 边界（真机走查复核）。
 *
 * ## show/load 协议（uni-ad 文档形态）
 *
 * 先 `show()`（广告可能已预载）；失败（未就绪）时按文档回落 `load() → show()` **重试一次**；
 * 仍失败 ⇒ `unavailable`。`onClose` / `onError` **先于** `show()` 注册（消掉「事件早于注册」
 * 的竞态）。整条链**不产生未处理的拒绝**（真机探针对 `Runtime.exceptionThrown` 零容忍）。
 */
import { detectPlatform } from './mp-transport';

export type AdOutcome = 'completed' | 'closed' | 'unavailable' | 'error';

/**
 * 最近一次播放失败的错误详情（诊断面；真机排障用）。
 *
 * 背景：`onError` 的平台形态是 `{ errCode, errMsg }`（如 `-5002 无效的广告位标识adpid`），
 * 但四结果契约只有 `unavailable`/`error`，错误对象被收口丢弃 ⇒ 真机上只剩一句通用文案，
 * 拿不到「为什么播不出来」。这里**只做记录**（不改四结果契约、不触发任何网络/发放）：
 * 每次 `playRewardedAd` 开始清空，失败出口写入；诊断构建经 `VITE_AD_DIAG=1` 把它显示在
 * 界面上（生产构建不显示，冻结文案不变）。
 */
let lastRewardedAdErrorDetail = '';

/** 读最近一次播放失败的错误详情（无失败 ⇒ 空串）。 */
export function getLastRewardedAdErrorDetail(): string {
  return lastRewardedAdErrorDetail;
}

/**
 * 把平台错误对象归一成一行可读文本：优先 `errCode + errMsg`（uni-ad 形态），
 * 其次 `code/message`，最后 `String(err)`。**只读字段，不抛**（诊断面自身不得成为新故障）。
 */
function describeAdError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { errCode?: unknown; errMsg?: unknown; code?: unknown; message?: unknown };
    const code = e.errCode ?? e.code;
    const msg = e.errMsg ?? e.message;
    const parts = [code, msg].filter((v) => v !== undefined && v !== null && v !== '');
    if (parts.length > 0) return parts.map(String).join(' ');
  }
  return String(err);
}

/** `uni.createRewardedVideoAd` 的实参（`urlCallback` 见头注「API 形态与类型缺口」）。 */
interface RewardedVideoAdCreateOptions {
  adpid: string;
  urlCallback: { extra: string };
}

/** `onClose` 回调入参：只读 `isEnded`（其余字段各端不统一）。 */
interface RewardedVideoAdCloseResult {
  isEnded?: boolean;
}

/**
 * 平台是否可能播放激励视频：`detectPlatform() === 'app'` 的异常收口版。
 * 非 App（H5 / 小程序）与未知平台（`detectPlatform` 抛错）⇒ `false`。**绝不抛**。
 */
export function isRewardedAdSupported(): boolean {
  try {
    return detectPlatform() === 'app';
  } catch {
    return false;
  }
}

/**
 * 播放一次激励视频，把宿主事件映射成四结果之一。**绝不触发发放**（只回报 UX 结果）。
 *
 * @param adpid 广告位 id（配置面第 15 键 `reliefAdpid` 下发；调用方保证非空）
 * @param opts.extra 透传串 = claim 的 nonce（身份唯一来源）
 */
export function playRewardedAd(adpid: string, opts: { extra: string }): Promise<AdOutcome> {
  lastRewardedAdErrorDetail = ''; // 每发重置（上一发的错误不得串到下一发）
  return new Promise<AdOutcome>((resolve) => {
    let settled = false;
    /** 单次收口：onClose / onError / load-show 失败可能竞相到达，首个事件定结果。 */
    const settle = (outcome: AdOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    try {
      const createOptions: RewardedVideoAdCreateOptions = {
        adpid,
        urlCallback: { extra: opts.extra },
      };
      const ad = uni.createRewardedVideoAd(createOptions);

      // 先注册再 show（事件时序各端不一，「注册晚一步」会丢事件）。
      ad.onError((err: unknown) => {
        lastRewardedAdErrorDetail = describeAdError(err);
        settle('unavailable');
      });
      ad.onClose((res: RewardedVideoAdCloseResult | undefined) =>
        settle(res?.isEnded ? 'completed' : 'closed'),
      );

      // show →（未就绪）→ load → show 重试一次；两条失败路都收口到 unavailable。
      // async 包一层：同步抛错也会变成函数内拒绝，被本函数的 try/catch 收住
      // ——整条链不可能产生未处理的拒绝。
      const showWithRetry = async (): Promise<void> => {
        try {
          await ad.show();
          return; // 已显示：此后唯一出口是 onClose / onError
        } catch (firstErr) {
          try {
            await ad.load();
            await ad.show();
          } catch (retryErr) {
            // 首拒多为「未就绪」（正常重试路径）；终结错误取重试那一次的，缺失再退回首拒。
            lastRewardedAdErrorDetail = describeAdError(retryErr) || describeAdError(firstErr);
            settle('unavailable');
          }
        }
      };
      void showWithRetry();
    } catch (err) {
      // 创建阶段异常（宿主无此 API / 实参被拒）⇒ 异常出口，不泄漏给调用方。
      lastRewardedAdErrorDetail = describeAdError(err);
      settle('error');
    }
  });
}
