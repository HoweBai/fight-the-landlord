/// <reference types="vite/client" />

/**
 * 运行期环境变量声明。Vite 的 `ImportMetaEnv` 已有索引签名，
 * 这里只在**模块作用域**追加具名文档，避免污染全局类型。
 */
export {};

declare global {
  interface ImportMetaEnv {
    /** socket.io origin；空则同源（vite 代理到 api-gateway）。 */
    readonly VITE_WS_ENDPOINT?: string;
    /** REST 前缀，默认 `/api`。 */
    readonly VITE_API_BASE?: string;
    /** 开发期直连 mock 的身份，默认 `u_dev`。 */
    readonly VITE_DEV_USER_ID?: string;
    /** 错误上报收集端 URL（项 8）；未配置 ⇒ 降级 console.warn，不出端。 */
    readonly VITE_ERROR_REPORT_URL?: string;
    /** 错误上报采样率 0–1，缺省 1（全采）。 */
    readonly VITE_ERROR_REPORT_SAMPLE_RATE?: string;
    /**
     * 广告诊断构建开关（`'1'` = 开）：把激励视频 SDK 的 `errCode/errMsg` 附在失败文案后。
     * 仅用于真机排障的临时打包；未设（生产缺省）⇒ 冻结文案逐字不变。
     */
    readonly VITE_AD_DIAG?: string;
    /**
     * 玩家文案诊断构建开关（`'1'` = 开）：未知码的中性兜底后附 `（code=N）`。
     * 仅用于真机排障的临时打包；未设（生产缺省）⇒ 中性文案逐字不变。
     */
    readonly VITE_PLAYER_DIAG?: string;
  }

  /**
   * 应用版本（ftl-version 插件构建期 define）：
   * dev 固定 `'dev'`；生产为 `<package version>-<git short sha>`。
   * 用于静态资源版本 query 与 H5 发版更新检查。
   */
  const __FTL_APP_VERSION__: string;
}
