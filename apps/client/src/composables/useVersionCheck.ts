/**
 * 项 9：H5 发版更新提示。
 *
 * 只在 H5 生效（小程序/App 没有「热更新后提示刷新」这条通道——它们走各平台发版）。
 * 轮询 `/version.json`（服务端 no-store，由 vite `ftl-version` 插件生成），
 * 与编译期注入的 `__FTL_APP_VERSION__` 对比：
 *  - 一致 ⇒ 无事；
 *  - 不一致 ⇒ `updateAvailable.value = true`，由大厅渲染刷新条。
 *
 * 触发时机（两路 + 轮询兜底）：
 *  - 回前台边沿（`useAppVisibility` 的 `onShow`）—— 用户切走再切回来时最可能赶上发版；
 *  - 5 分钟轮询 —— 用户长时间不切后台也能看到。
 *
 * 只提示一次：本会话内一旦 `updateAvailable` 置 true 就不再回 false（也不再重复提示）。
 * 失败静默：网络错 / 解析错 / 非 H5 都不抛、不打扰用户。
 */
import { ref, type Ref } from "vue";
import { detectPlatform } from "../net/mp-transport";
import { startAppVisibility, type VisibilityController } from "./useAppVisibility";

/** 轮询间隔：5 分钟。 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 是否有新版本可更新。模块级单例：全应用共享一个状态，
 * 入口启动一次、大厅读它即可。
 */
export const updateAvailable: Ref<boolean> = ref(false);

let started = false;
let visibility: VisibilityController | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 是否 H5（`detectPlatform()` 返回 `'browser'`，对应 uniPlatform `web`/`h5`）。非 H5 整条功能不启用。 */
function isH5(): boolean {
  return detectPlatform() === "browser";
}

/** 当前编译进包的版本号。未定义（测试 / dev 未 define）时回退 `'dev'`（与 asset.ts / reporter.ts 一致）。 */
function currentVersion(): string {
  return typeof __FTL_APP_VERSION__ !== "undefined" ? __FTL_APP_VERSION__ : "dev";
}

async function checkVersion(): Promise<void> {
  // 已提示过就不再检查（避免反复请求；本会话一次足矣）。
  if (updateAvailable.value) return;
  if (!isH5()) return;
  try {
    const res = await new Promise<{ data: unknown }>((resolve, reject) => {
      uni.request({
        url: "/version.json",
        method: "GET",
        timeout: 5000,
        success: (r) => resolve({ data: r.data }),
        fail: (e) => reject(e),
      });
    });
    const data = res.data as { version?: string } | null;
    const remote = data?.version;
    if (remote && remote !== currentVersion()) {
      updateAvailable.value = true;
    }
  } catch {
    // 网络/解析失败静默（项 9：不打扰用户）。
  }
}

/**
 * 启动版本检查（入口调用一次）。重复调用幂等。
 * 非 H5 平台直接返回（无副作用）。
 */
export function startVersionCheck(): void {
  if (started) return;
  started = true;
  if (!isH5()) return;

  visibility = startAppVisibility();
  visibility.onShow(() => {
    void checkVersion();
  });
  pollTimer = setInterval(() => {
    void checkVersion();
  }, POLL_INTERVAL_MS);
  // 启动即查一次（冷启动可能正赶上刚发版）。
  void checkVersion();
}

/** 测试用：复位单例状态。 */
export function __resetVersionCheckForTest(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  visibility?.stop();
  visibility = null;
  started = false;
  updateAvailable.value = false;
}

/** 组件层读取：返回共享的 `updateAvailable` ref。 */
export function useVersionCheck(): { updateAvailable: Ref<boolean> } {
  return { updateAvailable };
}
