import { describe, it, expect, beforeEach } from "vitest";
import { installUniStub, triggerAppHide, triggerAppShow } from "./helpers/uni-stub";
import {
  startVersionCheck,
  updateAvailable,
  useVersionCheck,
  __resetVersionCheckForTest,
} from "../src/composables/useVersionCheck";

/** 把 uni.request 的回调式应答推进到 await 点（Promise resolve 是微任务）。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useVersionCheck（项 9：H5 发版更新提示）", () => {
  beforeEach(() => {
    __resetVersionCheckForTest();
  });

  it("远端版本与编译期不一致 ⇒ updateAvailable = true", async () => {
    const stub = installUniStub(); // 默认 platform = 'web'（H5）
    stub.requestResponder = () => ({ statusCode: 200, data: { version: "new-build-abc" } });

    startVersionCheck();
    await flush();

    expect(updateAvailable.value).toBe(true);
    expect(stub.calls.request.length).toBe(1);
    expect(stub.calls.request[0]!.url).toBe("/version.json");
  });

  /**
   * 客户端接入片 C30 负对照：`/version.json` 探测是**裸 `uni.request`**（不经
   * `rest.ts` 的 `request()` 收口点）⇒ 不得被注入端标识头。
   * 判别力：「给探测加头」的实现会在本条当场红（`header` 变 defined）。
   */
  it("C30 负对照：/version.json 探测不带头（不经 rest.ts 收口，不注入端标识）", async () => {
    const stub = installUniStub();
    stub.requestResponder = () => ({ statusCode: 200, data: { version: "dev" } });

    startVersionCheck();
    await flush();

    expect(stub.calls.request).toHaveLength(1);
    expect(stub.calls.request[0]!.header).toBeUndefined();
  });

  it("远端版本与编译期一致 ⇒ 保持 false", async () => {
    const stub = installUniStub();
    // 测试环境 __FTL_APP_VERSION__ = 'dev'（vite.config serve 分支）
    stub.requestResponder = () => ({ statusCode: 200, data: { version: "dev" } });

    startVersionCheck();
    await flush();

    expect(updateAvailable.value).toBe(false);
  });

  it("网络失败静默：不抛、保持 false", async () => {
    const stub = installUniStub();
    stub.requestResponder = () => {
      throw new Error("network down");
    };

    expect(() => startVersionCheck()).not.toThrow();
    await flush();
    expect(updateAvailable.value).toBe(false);
  });

  it("非 H5（mp-weixin）⇒ 不发请求、不启动可见性监听", () => {
    const stub = installUniStub({ platform: "mp-weixin" });

    startVersionCheck();

    expect(stub.calls.request.length).toBe(0);
    expect(stub.calls.appVisibility.onShow).toBe(0);
    expect(updateAvailable.value).toBe(false);
  });

  it("回前台触发一次检查", async () => {
    const stub = installUniStub();
    stub.requestResponder = () => ({ statusCode: 200, data: { version: "dev" } });

    startVersionCheck();
    await flush();
    expect(stub.calls.request.length).toBe(1); // 启动时那次

    // 边沿判定：先 hide 再 show，onShow 才会触发（初值 visible=true）。
    triggerAppHide();
    triggerAppShow();
    await flush();
    expect(stub.calls.request.length).toBe(2); // 回前台又查一次
  });

  it("已提示过则不再发请求（本会话一次足矣）", async () => {
    const stub = installUniStub();
    stub.requestResponder = () => ({ statusCode: 200, data: { version: "new-build" } });

    startVersionCheck();
    await flush();
    expect(updateAvailable.value).toBe(true);
    expect(stub.calls.request.length).toBe(1);

    triggerAppHide();
    triggerAppShow();
    await flush();
    expect(stub.calls.request.length).toBe(1); // 不再请求
  });

  it("useVersionCheck 返回共享的 updateAvailable", () => {
    const { updateAvailable: ref } = useVersionCheck();
    expect(ref).toBe(updateAvailable);
  });
});
