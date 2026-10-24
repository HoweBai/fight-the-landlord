/**
 * 静态资源 URL 的唯一版本化入口（项 7 / 项 6 分包）。
 *
 * 策略（与 `vite.config.ts` 的 ftl-version 插件配对）：
 * - **dev/preview**：dev server 中间件已对 `/static/**` 强制 `Cache-Control: no-cache`，
 *   同名换图刷新即生效 ⇒ **原样返回**，不需要任何手工 `?v=` bump；
 * - **生产构建**：追加 `?v=<应用版本>`（package version + git sha，构建期注入），
 *   发版后 URL 整体变化，浏览器/CDN 旧缓存自然失效。
 *
 * 本地静态资源有两个根（项 6 小程序分包后）：
 *  - 主包：`/static/...`；
 *  - 分包：`/pages/<subpkg>/static/...`（如牌桌的 `/pages/table/static/cards/...`）。
 * 远程 URL、API 路径、已带 query 的路径原样返回。
 */

/** 构建期由 ftl-version 插件 define（声明见 env.d.ts）；非 Vite 环境兜底 'dev'。 */
const APP_VERSION =
  typeof __FTL_APP_VERSION__ !== 'undefined' ? __FTL_APP_VERSION__ : 'dev';

/** 主包 `/static/` 或分包 `/pages/<root>/static/` 下的本地资源。 */
const LOCAL_STATIC = /^\/(?:static|pages\/[^/]+\/static)\//;

/**
 * 纯拼接逻辑（无环境判断），便于单测直接锁定「生产形态」：
 * 非本地 static、已有 query、版本串为空 ⇒ 原样返回；否则追加 `?v=<version>`。
 */
export function appendVersionQuery(path: string, version: string): string {
  if (!LOCAL_STATIC.test(path) || path.includes('?') || version === '') {
    return path;
  }
  return `${path}?v=${version}`;
}

/** 业务侧取主包资源 URL 的统一入口：dev 原样、生产带版本。 */
export function assetUrl(path: string): string {
  if (!import.meta.env.PROD) return path;
  return appendVersionQuery(path, APP_VERSION);
}

/**
 * 牌桌分包静态资源（项 6：小程序分包）。
 *
 * 牌桌专用素材（牌面、牌桌音频、牌桌底图等）物理放在 `src/pages/table/static/`，
 * 构建后位于 `/pages/table/static/...`（H5 / 小程序同路径，uni 按目录结构原样拷贝），
 * 只有进入牌桌分包时才下载，不占微信主包 2MB 配额。
 *
 * @param path 相对分包 static 的路径，如 `'cards/SpadeOne.png'`
 */
export function tableAsset(path: string): string {
  return assetUrl(`/pages/table/static/${path}`);
}
