/**
 * 音效播放（spec §7 / R698 / 用户裁决 U4）。
 *
 * ## 三条纪律
 *
 * 1. **`uni.xxx()` 必须是直接成员调用**（闸：`test/uni-api-access.test.ts`）——
 *    H5 发行构建靠 uni 编译器把这种直接调用改写成 `@dcloudio/uni-h5` 的 import
 *    （详见 `net/storage.ts` 顶部的长注释）。
 *    ✅ 已实测 `createInnerAudioContext` **确实在 `@dcloudio/uni-h5` 的导出名录里**
 *    （`uni-h5.es.js:24677`）⇒ 这里不属于「dev 正常、发行版静默失效」那一类。
 * 2. **绝不抛、绝不 `console.error`**：真浏览器探针有两条零容忍断言
 *    （`全程 Runtime.exceptionThrown 为 0` / `全程 error 级 console 为 0`）。
 *    ⚠️ **`InnerAudioContext.play()` 在 H5 上返回 `undefined`**（片② 实测：uni-h5 的
 *    `play() { this._audio.play(); }` **丢弃了返回值**，而 `_audio.play()` 的 promise
 *    在**无用户手势时会被拒 / 未就绪时长期 pending**）⇒ 任何 `ctx.play().catch(...)`
 *    在 H5 都是**够不着的**。真正的护栏是 **`playWhenReady`（等 `onCanplay` 再起播）**。
 *    ⇒ 每一处 `play()` 都**必须** `.catch(() => undefined)`。
 * 3. **开关 / 音量持久化**：走与 `net/storage.ts` 同一套 uni 存储，
 *    未命中返回 `''`（不是 `null`）—— 这是 uni 的实测语义。
 */
import { CUES, type CueName } from './cues';

const KEY_MUTED = 'ftl.audio.muted';
const KEY_VOLUME = 'ftl.audio.volume';
/**
 * 音乐 / 音效两个**独立通道**的关闭标记。
 *
 * ⚠️ 存「关闭标记」而不是「开启标记」：未命中返回 `''`，默认即「开」——
 * 与 `KEY_MUTED` 同构（那边是 `'1'` 表示静音）。
 */
const KEY_MUSIC_OFF = 'ftl.audio.musicOff';
const KEY_SFX_OFF = 'ftl.audio.sfxOff';

/**
 * 音频上下文的类型。
 *
 * ⚠️ **不要用 `any`**（本片第①份的教训：`as` / `any` / 与运行期不符的类型标注
 * 是三种「`tsc` 看不见」的逃逸口）。`uni` 全局由 `@dcloudio/types` 声明
 * （`apps/client/tsconfig.json` 的 `types` 里有它）。
 */
type AudioCtx = ReturnType<typeof uni.createInnerAudioContext>;

/** 宿主是否提供 `uni` 全局（存在性判定，**不**把 `uni` 读进变量）。 */
function hasUni(): boolean {
  return typeof uni !== 'undefined';
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

let muted = false;
let volume = 1;
/** 两个独立通道：默认都开。与 `muted` 是「与」关系（总开关关了，通道都不出声）。 */
let musicOn = true;
let sfxOn = true;

/** 活着的播放上下文（换曲 / 静音时要能停掉；BGM 与 cue 都在这里更新音量）。 */
const live = new Set<AudioCtx>();

/**
 * 一条 cue 的生命周期（U5-3 打断策略）。
 *
 * `playCalled && !started` 是**不能 stop 的窗口**：uni-h5 的 `stop()` 内部是
 * `_audio.pause()`，会以 `AbortError` 拒掉尚未 settle 的 `play()`，而那个 promise
 * 被 uni 丢弃 ⇒ 未处理的拒绝会让真浏览器探针的零容忍断言变红。
 */
interface LiveCue {
  ctx: AudioCtx;
  /** `play()` 已发出。 */
  playCalled: boolean;
  /** `onPlay` 已触发（此时 stop 安全）。 */
  started: boolean;
  /** 已被新 cue 取代，等 `onPlay` / `onError` 收尾。 */
  abandoned: boolean;
  /** 从册子上移除并销毁（幂等）。 */
  finish: () => void;
}

/** 所有 cue（不含 BGM）。 */
const cues = new Set<LiveCue>();
let currentCue: LiveCue | null = null;

/**
 * 项 4：已预热过的 cue 名（幂等）。
 * 预热失败也占名——媒体 404 / 解码失败时，每次进牌桌都重试一遍纯属浪费流量。
 */
const preheated = new Set<CueName>();

/** 当前 BGM。 */
let currentBgm: { src: string; ctx: AudioCtx } | null = null;

/** 从宿主存储读回开关与音量（页面挂载时调一次）。 */
export function loadAudioPrefs(): void {
  if (!hasUni()) return;
  try {
    muted = uni.getStorageSync(KEY_MUTED) === '1';
    musicOn = uni.getStorageSync(KEY_MUSIC_OFF) !== '1';
    sfxOn = uni.getStorageSync(KEY_SFX_OFF) !== '1';
    const raw = uni.getStorageSync(KEY_VOLUME);
    const vol = typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
    volume = Number.isFinite(vol) ? clamp01(vol) : 1;
  } catch {
    // 配额 / 隐私模式：读不到就用默认（开、满音量）
  }
}

function persist(key: string, value: string): void {
  if (!hasUni()) return;
  try {
    uni.setStorageSync(key, value);
  } catch {
    // 持久化失败不应让播放失败
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  persist(KEY_MUTED, next ? '1' : '0');
  if (next) {
    stopAll();
    stopBgm();
  }
}

/** 音乐通道是否开（与总静音是「与」关系）。 */
export function isMusicOn(): boolean {
  return musicOn;
}

/**
 * 切音乐通道。关掉时**立刻**停 BGM；重新打开**不自动起播**——
 * 由调用方（牌桌）在开关回调里决定播哪首（本层不知道当前场景该放什么）。
 */
export function setMusicOn(next: boolean): void {
  musicOn = next;
  persist(KEY_MUSIC_OFF, next ? '0' : '1');
  if (!next) stopBgm();
}

/** 音效通道是否开。 */
export function isSfxOn(): boolean {
  return sfxOn;
}

/** 切音效通道。只影响之后的 cue；已经在播的那条自然结束，不强行打断。 */
export function setSfxOn(next: boolean): void {
  sfxOn = next;
  persist(KEY_SFX_OFF, next ? '0' : '1');
}

export function getVolume(): number {
  return volume;
}

export function setVolume(next: number): void {
  volume = clamp01(next);
  persist(KEY_VOLUME, String(volume));
  for (const ctx of live) {
    try {
      ctx.volume = volume;
    } catch {
      // 某些端不支持运行期改音量 ⇒ 忽略
    }
  }
}

/**
 * 安全处置一条 cue。
 *
 * `started` 或 `!playCalled` ⇒ stop+destroy 安全；
 * `playCalled && !started` ⇒ 只标 abandoned（stop 会打断 pending play）。
 */
function disposeCue(cue: LiveCue): void {
  if (currentCue === cue) currentCue = null;
  live.delete(cue.ctx);
  if (cue.started || !cue.playCalled) {
    cues.delete(cue);
    try {
      cue.ctx.stop();
      cue.ctx.destroy();
    } catch {
      // 忽略
    }
  } else {
    /**
     * play 已发出、onPlay 未到：**既不能 stop 也不能 destroy**（uni-h5 的 destroy 内部
     * 也是 stop→pause，会打断 pending play）。摘出册子，由迟到的 onPlay / onError 收尾。
     */
    cue.abandoned = true;
    cues.delete(cue);
  }
}

/** 停掉所有 cue（不碰 BGM）；离桌 / 总静音时用。 */
export function stopCues(): void {
  for (const cue of [...cues]) disposeCue(cue);
}

function stopAll(): void {
  stopCues();
  stopBgm();
  live.clear();
}

/**
 * **立刻**起播，并把 `play()` 的拒绝接住（前提是它真的返回 promise）。
 *
 * ⚠️ **只给音效（cue）用**，BGM 一律走 `playWhenReady` —— 两者的寿命不同：
 * cue 是**一次性、自终止**的（`onEnded` / `onError` 里 `destroy()`），而 BGM 是**长命**的，
 * 跨导航被反复创建/销毁 ⇒ 「`pause()` 打断一个 64 秒没 settle 的 `play()`」那个 abort
 * 只发生在 BGM 上（片② 实测）。
 *
 * ⚠️ **H5 上 `ctx.play()` 返回 `undefined`**（uni 丢弃了返回值）⇒ 下面那句 `catch` 在 H5
 * **够不着**，它只在 App / 小程序端可能生效。
 * ⚠️ 本函数本身不等 `onCanplay`；cue 的等待由 `playCue` 的 `onCanplay` 回调保证
 * （U5-3 打断要求媒体就绪后才起播，否则 stop 会打断 pending play）。
 */
function playSafely(ctx: AudioCtx): void {
  try {
    const maybe: unknown = ctx.play();
    if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
      void (maybe as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // 宿主不支持 ⇒ 静默降级
  }
}

/**
 * **等媒体可播了再起播**（**只给 BGM 用** —— 理由见 `playSafely` 的注释）。
 *
 * ## 为什么必须等 `onCanplay`（片② 执行期实测修复）
 *
 * uni-h5 的 `InnerAudioContext.stop()` 内部是 `_audio.pause()`，而 **`pause()` 一个尚未
 * settle 的 `play()` 会被浏览器以 `AbortError` 拒掉**。更糟的是那个 promise 在 uni 内部
 * **被丢弃了**（`play() { this._audio.play(); }`，无 `.catch`）⇒ 它变成**未处理的拒绝**，
 * 把真浏览器探针的「全程异常为 0」打红。实测：进牌桌 `+68.51s` 起播、`+132.69s` 离开时爆 ——
 * **那首歌的 `play()` 挂了 64 秒都没 settle**（自动播放被拦 / 媒体从未就绪），
 * 也就是说**它根本没在响，而我们却去 `pause()` 它**。
 *
 * ⇒ **没就绪就压根不要调 `play()`**：那样 `stop()` 无论何时调都不会打断任何东西。
 * （`stop()` 本身在 `stopBgm` / `stopAll` 里保持**无条件**调用 —— 「换曲必停前一首」
 * 是既有判据 `audio.test.ts` 盯着的，不为了这个修复去动它。）
 *
 * ⚠️ `isAlive()` 是**第二道闸**：媒体就绪是**异步**的，回调可能在「我们已经离开 / 换曲」之后才跑。
 * 靠它保证**只有仍然在册的那一个**才会起播 ⇒ 顺带消掉「两首 BGM 同时响」的风险。
 *
 * ⚠️ **残余窗口（如实登记，不声称已消除）**：`onCanplay` 与 `onPlay` 之间 `play()` 仍是
 * pending，这个窗口若恰好被 `stop()` 打断，理论上仍会 abort。它从**实测的 64 秒**缩到了
 * 毫秒级 —— 「大幅改善」与「已消除」是两件事，后者由真浏览器 `full` 场景复跑判定。
 */
function playWhenReady(ctx: AudioCtx, isAlive: () => boolean): void {
  ctx.onCanplay(() => {
    if (!isAlive()) return;
    playSafely(ctx);
  });
}

/**
 * 静默预热音效（客户端优化项 4，**best-effort，仅承诺 H5 效果**）。
 *
 * 解决的问题：`InnerAudioContext` 首次播某条音效时才现下载/解码，弱网下首次
 * 「不抢」「不要」会明显晚半拍。预热 = 提前建 ctx、赋 `src` 让宿主把媒体拉下来
 * 缓存住，`onCanplay`（成功）/ `onError`（失败）一到立即 `destroy()`。
 *
 * 纪律（与播放路径一致）：
 *  - **绝不 `play()`**、**不进 `live`**：它只是把文件缓存热，不是一次播放；
 *  - **幂等**：同名 cue 全局只预热一次（`preheated` 占名，失败也不重试）；
 *  - **受开关约束**：总静音 / 音效通道关着就不下发（读 prefs 之后再调）；
 *  - **绝不抛**：宿主不支持 / 创建失败一律静默降级。
 *
 * ⚠️ 小程序端的缓存行为依宿主实现而定，不为它做任何承诺；H5 上媒体经 HTTP
 * 缓存后二次起播即时发声，这是本函数的目标平台。
 */
export function preheatCues(names: readonly CueName[]): void {
  if (muted || !sfxOn || !hasUni()) return;
  for (const name of names) {
    if (preheated.has(name)) continue;
    const src = (CUES as Record<string, string | undefined>)[name];
    if (!src) continue;
    preheated.add(name);
    try {
      const ctx = uni.createInnerAudioContext();
      const cleanup = (): void => {
        try {
          ctx.destroy();
        } catch {
          // 忽略
        }
      };
      ctx.onCanplay(cleanup);
      ctx.onError(cleanup);
      // 赋 src 即触发宿主加载；没有 play()，声音不会出来。
      ctx.src = src;
    } catch {
      // 宿主不支持音频 ⇒ 静默降级
    }
  }
}

/** 仅供测试：清空预热占名与 cue 模块级状态（跨用例需复位）。 */
export function __resetAudioForTest(): void {
  for (const cue of [...cues]) {
    cues.delete(cue);
    live.delete(cue.ctx);
    try {
      cue.ctx.stop();
      cue.ctx.destroy();
    } catch {
      // 忽略
    }
  }
  currentCue = null;
  preheated.clear();
}

/**
 * 播一条音效（一次性）。
 *
 * ⚠️ **未知 cue 名静默忽略** —— 拼错一个名字不该把牌桌打崩。
 * ⚠️ **每条音效新建一个上下文并自行销毁**：`InnerAudioContext` 不支持复用播多条；
 * 用完 `destroy()` 免得攒住音频资源（移动端有硬上限）。
 */
export function playCue(name: CueName): void {
  if (muted || !sfxOn) return;
  const src = (CUES as Record<string, string | undefined>)[name];
  if (!src || !hasUni()) return;

  /* 最新优先：旧 cue 先安全处置（不打断 pending play）。 */
  if (currentCue) disposeCue(currentCue);

  try {
    const ctx = uni.createInnerAudioContext();
    ctx.src = src;
    ctx.volume = volume;
    let done = false;
    const cue: LiveCue = {
      ctx,
      playCalled: false,
      started: false,
      abandoned: false,
      finish: () => undefined,
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      cues.delete(cue);
      live.delete(ctx);
      if (currentCue === cue) currentCue = null;
      try {
        ctx.destroy();
      } catch {
        // 忽略
      }
    };
    cue.finish = finish;

    ctx.onEnded(finish);
    ctx.onError(finish);
    ctx.onPlay(() => {
      cue.started = true;
      if (cue.abandoned) {
        try {
          ctx.stop();
        } catch {
          // 忽略
        }
        finish();
      }
    });
    /* 与 BGM 同一条教训：媒体就绪前绝不 play()，否则打断时 stop 会打出 AbortError。 */
    ctx.onCanplay(() => {
      if (cue.abandoned) {
        /**
         * play 已发出、onPlay 未到：这里**绝不能 finish()**（destroy→pause 会打断
         * pending play，且缓冲抖动可能让 canplay 再次触发）。交给 onPlay / onError。
         */
        return;
      }
      cue.playCalled = true;
      playSafely(ctx);
    });

    cues.add(cue);
    live.add(ctx);
    currentCue = cue;
  } catch {
    // 宿主不支持音频 ⇒ 静默降级（本仓「不得崩」的纪律）
  }
}

/** 播 BGM（循环）。同一首重复调不会叠加；换曲会先停掉前一首。 */
export function playBgm(src: string): void {
  if (currentBgm?.src === src) return;
  stopBgm();
  if (muted || !musicOn || !hasUni()) return;
  try {
    const ctx = uni.createInnerAudioContext();
    ctx.src = src;
    ctx.loop = true;
    ctx.volume = volume;
    ctx.onError(() => stopBgm());
    live.add(ctx);
    currentBgm = { src, ctx };
    /* `live.has` 当第二道闸：就绪回调可能在换曲/卸载之后才跑 ⇒ 只让仍然在册的那一首起播。 */
    playWhenReady(ctx, () => live.has(ctx));
  } catch {
    // 静默降级
  }
}

/** 停 BGM（幂等）。 */
export function stopBgm(): void {
  if (!currentBgm) return;
  const { ctx } = currentBgm;
  currentBgm = null;
  live.delete(ctx);
  try {
    ctx.stop();
    ctx.destroy();
  } catch {
    // 忽略
  }
}

/**
 * 「叫 / 抢」→ cue 名（U5 · 2026-10-22）。
 *
 * `kind` 是服务端 `BidDecision.kind` 的原话：`call`+抢播「叫地主」，`rob`+抢播
 * `Rob{seat+1}`；不叫/不抢共用 `NoOrder`（素材里没有「不抢」专用音）。
 *
 * ⚠️ 放在这里而不是 `useTableSound.ts`：它是**纯选择**（不碰 store），
 * 放这里可以让 `audio/` 的单测不必拉起 pinia。
 * ⚠️ `seat` 越界时回落到第一条 —— 宁可能听见一声不对的音，也不要静默全哑。
 */
export function cueForBid(kind: 'call' | 'rob', grab: boolean, seat: number): void {
  if (!grab) {
    playCue('NoOrder');
    return;
  }
  if (kind === 'call') {
    playCue('Order');
    return;
  }
  playCue((['Rob1', 'Rob2', 'Rob3'] as const)[seat] ?? 'Rob1');
}

/** 「过牌」→ cue 名（按座位取变体）。 */
export function cueForPass(seat: number): void {
  playCue((['Buyao1', 'Buyao2', 'Buyao3'] as const)[seat] ?? 'Buyao1');
}
