import { execSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Connect, type Plugin, type PluginOption } from 'vite';
import uniModule from '@dcloudio/vite-plugin-uni';

/**
 * uni-app（Vue 3 线）的 Vite 配置。**多端**：H5 / 微信小程序 / App。
 *
 * ⚠️ 四条实测坑（切片 P10；本文件是它们的唯一修法落点）：
 *
 * 1. **`import uni from '@dcloudio/vite-plugin-uni'` 拿到的不是函数** ——
 *    该包是 CJS（`exports.default = uniPlugin` + `__esModule`），在 pnpm + ESM 下
 *    默认导入拿到的是整个 `module.exports` 对象 ⇒ 直接 `uni()` 会报
 *    `failed to load config … / uni is not a function`。必须显式解包。
 *
 * 2. **uni-app 内部把 `resolve.preserveSymlinks` 设成 `true`**
 *    （`@dcloudio/uni-cli-shared/dist/resolve.js:24` 与
 *    `@dcloudio/vite-plugin-uni/dist/config/resolve.js:64`）⇒ 在 pnpm 的符号链接布局下，
 *    依赖的**深层裸 import** 解析失败（实测：H5 构建报
 *    `Rollup failed to resolve import "socket.io-parser" from …/socket.io-client/build/esm/index.js`）。
 *    修法：在 `uni()` **之后**追加一个只做覆盖的插件 —— Vite 的 plugin `config` 是
 *    **后合并者胜**，所以顺序不能反。
 *
 * 3. Vite 被**钉在 5.2.8**（`@dcloudio/vite-plugin-uni` 的 peer 是精确 `vite: "5.2.8"`，裁决 R431）。
 *
 * 4. **（Task 2 新增）微信小程序端：Node _modules 里的 easycom 组件会生成非法路径** ——
 *    现象（Task 2 引入 `wot-design-uni` 之后暴露）：
 *      · `Invalid pattern "../../node-modules/.pnpm/wot-design-uni@…/wd-tag.js" for "output.chunkFileNames"`
 *      · `The "fileName" … must be strings that are neither absolute nor relative paths,
 *         received "../../node-modules/.pnpm/wot-design-uni@…/wd-tag.json"`
 *
 *    **机制**（读 uni 源码 + 本仓实测，坑 2 的直接后果）：
 *      a. `preserveSymlinks: false` ⇒ Rollup 拿到的是**真实路径**：`wot-design-uni` 落在 pnpm 的
 *         虚拟 store `<repo>/node_modules/.pnpm/wot-design-uni@…/node_modules/wot-design-uni/…`；
 *      b. 本仓是 **monorepo**：store 在**仓库根**，而 `UNI_INPUT_DIR` 是 `apps/client/src`
 *         ⇒ 相对深度是 `../../../node_modules/…`（独立工程只有 `../../`）；
 *      c. `@dcloudio/uni-cli-shared/dist/utils.js` 的 `normalizeNodeModules()` 只负责
 *         `/(\.\.\/)?node_modules/ → node-modules/` —— **每个 `node_modules` 只吃掉一层 `../`**，
 *         于是剩下两段 `../` ⇒ 违反 Rollup「chunk/asset 名不得是相对路径」的硬约束。
 *      Task 0 的 POC（`/tmp/p10-poc`，独立工程）之所以全绿，就是因为相对深度差这一层。
 *
 *    **修法**：在 `configResolved` 里包一层 `normalizeMiniProgramFilename` ——
 *    仍由 uni 自己决定「是不是 node_modules 组件」（`node-modules/…` 前缀原样保留），
 *    我们只堵住「逃出项目根」这种它自己也不接受的形态：把 `../` 段折回 `node-modules/`
 *    （`../../../node_modules/…` → `node-modules/…`），并兜底去掉其它前导 `../`。
 *    **判据**：`pnpm build:mp-weixin` / `build:app` / `build:h5` 三端 DONE。
 */
const uni = ((uniModule as unknown as { default?: unknown }).default ?? uniModule) as () => PluginOption;

const require_ = createRequire(import.meta.url);

/**
 * uni 编译期会把 `utils.js` 与 `mp-vite` 的构建插件放进**同一个 `require` 缓存**里，
 * 且后者是 `(0, utils_1.normalizeMiniProgramFilename)(…)` 这种**运行时属性访问**
 * （见 `@dcloudio/uni-mp-vite/dist/plugin/build.js`、`@dcloudio/uni-mp-weixin/dist/…`）
 * ⇒ 直接改这两个模块的 `exports` 就能生效（改 ESM 的命名导出不行：那是只读 getter）。
 */
const PATCHED_MODULES = [
  '@dcloudio/uni-cli-shared/dist/utils.js',
  '@dcloudio/uni-mp-vite/dist/plugin/build.js',
];

/** `../../../node_modules/x` → `node-modules/x`；`../…/foo` → `foo`（兜底）。 */
function clampMiniProgramPath(value: string): string {
  return value
    .replace(/(?:\.\.\/)+node-modules\//g, 'node-modules/')
    .replace(/^(?:\.\.\/)+/, '');
}

/**
 * 见文件头第 4 条。对「以 `.` 开头的返回值」做 clamp；纯 JS 实现，不碰 uni 的判断逻辑。
 */
function installMiniProgramPathClamp() {
  for (const id of PATCHED_MODULES) {
    let mod: { exports?: Record<string, unknown> } | undefined;
    try {
      mod = require_.cache[require_.resolve(id)];
    } catch {
      // 该端没有这个模块（例如 h5 端不加载 mp 构建插件）⇒ 跳过
      continue;
    }
    const exports = mod?.exports;
    if (!exports) continue;
    // 只包 `normalizeMiniProgramFilename`：它覆盖了 chunk 名与 asset 名两条失败路径，
    // 且语义最窄（`normalizeNodeModules` 还被别的路径处理复用，不去动它）。
    const key = 'normalizeMiniProgramFilename';
    const original = exports[key];
    if (typeof original !== 'function') continue;
    exports[key] = (...args: unknown[]) =>
      clampMiniProgramPath(String((original as (...a: unknown[]) => unknown)(...args)));
  }
}

// ---------------------------------------------------------------------------
// ftl-version：应用版本注入 + 静态资源缓存策略（项 7 / 项 9 共用）
// ---------------------------------------------------------------------------

const CLIENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 应用版本：
 * - dev/preview：固定 `'dev'`（dev server 对 /static/** 直接给 no-cache，版本号无意义）；
 * - 生产构建：`<package.json version>-<git short sha>`；git 不可用时回退时间戳。
 */
function resolveAppVersion(command: 'build' | 'serve'): string {
  if (command !== 'build') return 'dev';
  const pkg = JSON.parse(readFileSync(resolve(CLIENT_DIR, 'package.json'), 'utf8')) as {
    version: string;
  };
  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR }).toString().trim();
  } catch {
    // 无 git 环境（解压源码包等）⇒ 时间戳兜底，仍保证每次构建 URL 变化。
  }
  return sha ? `${pkg.version}-${sha}` : `${pkg.version}-dev${Date.now()}`;
}

/**
 * dev/preview 两件事：
 *  ① `GET /version.json` → `{version}`（no-store；H5 发版更新提示轮询它，项 9）；
 *  ② 所有 `/static/**` 响应强制 `Cache-Control: no-cache` —— 同名换图刷新即生效，
 *     彻底消灭手工 `?v=` bump（Vite/uni 的静态伺服在下层，这里 unshift 到链首并
 *     包一层 setHeader，下层设什么缓存策略都会被改写成 no-cache）。
 */
function installDevMiddlewares(middlewares: Connect.Server, version: string) {
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const pathname = (req.url ?? '').split('?')[0]!;
    if (req.method === 'GET' && pathname === '/version.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ version }));
      return;
    }
    if (pathname.startsWith('/static/')) {
      // 主动设一次（下层静态伺服可能根本不设缓存头），再包一层防止被其覆盖。
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: number | string | readonly string[]) => {
        if (name.toLowerCase() === 'cache-control') return originalSetHeader(name, 'no-cache');
        return originalSetHeader(name, value);
      }) as typeof res.setHeader;
      res.setHeader('Cache-Control', 'no-cache');
    }
    next();
  };
  middlewares.stack.unshift({ route: '', handle });
}

function ftlVersionPlugin(): Plugin {
  let version = 'dev';
  let isBuild = false;
  /** build.outDir 绝对路径在 configResolved 才最终确定 ⇒ 延迟持有。 */
  let outDir = CLIENT_DIR;

  return {
    name: 'ftl-version',
    config(_config, { command }) {
      isBuild = command === 'build';
      version = resolveAppVersion(command);
      return { define: { __FTL_APP_VERSION__: JSON.stringify(version) } };
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      // uni-app 自己把 src/uni.scss 全文塞进 scss.additionalData（见 uni.scss 文件头）；
      // configResolved 在所有插件 config 合并之后 ⇒ 这里 wrap 最终值，把版本变量前置，
      // 不覆盖 uni 的注入。空串 = dev（URL 不带 query），非空 = 生产版本串。
      const scssOptions = (config.css.preprocessorOptions.scss ??= {}) as {
        additionalData?: string | ((source: string, filename: string) => string);
      };
      const previous = scssOptions.additionalData;
      const injection = `$ftl-asset-version: ${JSON.stringify(isBuild ? version : '')};\n`;
      scssOptions.additionalData = (source: string, filename: string) =>
        injection +
        (typeof previous === 'function' ? previous(source, filename) : previous ?? '') +
        source;
    },
    configureServer(server) {
      installDevMiddlewares(server.middlewares, version);
    },
    configurePreviewServer(server) {
      installDevMiddlewares(server.middlewares, version);
    },
    buildStart() {
      // 仅 H5 产物带 version.json（小程序/App 没有轮询更新提示这条通道；
      // mp 产物多个白给文件还会进包占体积）。
      // ⚠️ 必须 emitFile 随 Rollup 产物一起写：uni 在 buildEnd 之后还有 static 复制等
      // 后置步骤，手工 writeFileSync 落盘的文件会被它清掉（实测）。
      const isH5 =
        process.env.UNI_PLATFORM === 'h5' || /[\\/]build[\\/]h5(?:[\\/]|$)/.test(outDir);
      if (!isBuild || !isH5) return;
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ version })}\n`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// ftl-subpackage-static：dev server 伺服分包 static（项 6 小程序分包补洞）
// ---------------------------------------------------------------------------

/**
 * ⚠️ **实测坑（2026-10-12）**：uni 的 `uniCopyPlugin` 只在**构建**时把
 * `src/pages/<root>/static/**` 拷进产物（H5 发行 / mp-weixin 均已验证 OK）；
 * 但 **vite dev server 不伺服这些目录** —— 请求 `/pages/table/static/…` 会落到
 * SPA history 回退、返回 index.html（HTTP 200 + text/html），浏览器当图解码失败 ⇒
 * 牌桌底纹 / 牌面 / 头像在 `pnpm dev` 下全白。主包 `/static/**` 由 uni 的中间件伺服，
 * 不受影响。
 *
 * 修法（仅 dev/preview 伺服链，零构建影响）：把
 * `GET /pages/<root>/static/<file>` 映射回源文件 `src/pages/<root>/static/<file>`
 * 直接出流；不存在则 `next()`（交回 uni/Vite 与 SPA 回退）。
 * preview 端构建产物里本来就有拷贝件，此中间件对 preview 是无害双保险。
 */
const SUBPACKAGE_STATIC_RE = /^\/pages\/([^/]+)\/static\/(.+)$/;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
};

function subpackageStaticMiddleware(srcDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathname = (req.url ?? '').split('?')[0]!;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const m = SUBPACKAGE_STATIC_RE.exec(decodeURIComponent(pathname));
    if (!m) {
      next();
      return;
    }
    const file = normalize(resolve(srcDir, 'pages', m[1]!, 'static', m[2]!));
    const staticRoot = normalize(resolve(srcDir, 'pages', m[1]!, 'static')) + sep;
    // 防路径穿越：解析后的真实路径必须仍在该分包 static 根内。
    if (!file.startsWith(staticRoot) || !existsSync(file) || !statSync(file).isFile()) {
      next();
      return;
    }
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
    // 与主包 /static/** 同一纪律：dev 不缓存，换图刷新即生效。
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', next).pipe(res);
  };
}

function ftlSubpackageStaticPlugin(): Plugin {
  return {
    name: 'ftl-subpackage-static-dev',
    apply: 'serve',
    configureServer(server) {
      // 直接挂 = 跑在 Vite 内建中间件与 SPA 回退之前。
      server.middlewares.use(subpackageStaticMiddleware(resolve(CLIENT_DIR, 'src')));
    },
    configurePreviewServer(server) {
      server.middlewares.use(subpackageStaticMiddleware(resolve(CLIENT_DIR, 'src')));
    },
  };
}

export default defineConfig({
  plugins: [
    uni(),
    ftlVersionPlugin(),
    ftlSubpackageStaticPlugin(),
    {
      name: 'ftl-preserve-symlinks-off',
      config: () => ({ resolve: { preserveSymlinks: false } }),
    },
    {
      name: 'ftl-miniprogram-path-clamp',
      configResolved() {
        // 必须在 uni 的构建插件**真正组装 rollupOptions 之前**打完补丁；
        // `configResolved` 早于 `buildStart`，实测这个时机足够。
        installMiniProgramPathClamp();
      },
    },
  ],
  resolve: {
    alias: {
      // 直接指向契约包源码：apps/client 只允许依赖 protocol（docs/design.md §12）。
      // 指向源码而非 dist，避免「忘记先 build protocol 导致测试 collect 失败」。
      '@fight-the-landlord/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    // ⚠️ 5173 是**探针的契约**（`scripts/browser-e2e.mjs` 的 `--base-url` 默认值）。
    port: 5173,
    proxy: {
      // 真浏览器探针与开发路径都长在这两条代理上（§5.1 同源约定）。
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  /**
   * **发行产物**（`dist/build/h5`）的本地伺服：`pnpm preview`。
   *
   * ⚠️ 存在的理由是一条实测坑（Task 3）：H5 **发行构建默认摇树**，uni 只注入空的
   * `window.uni = {}` 占位对象，真正可用的是编译器把 `uni.xxx(…)` 的**直接调用**改写成
   * `@dcloudio/uni-h5` 的 import ⇒ 「dev 正常、发行版静默失效」是可能的（存储不落地、
   * `reLaunch` 不跳页），而**探针默认跑 dev，抓不到它**。
   * 因此本文件也配上 preview 的同一组代理，让探针能对着**发行产物**再跑一遍：
   *   `pnpm --filter @fight-the-landlord/client build:h5`
   *   `pnpm --filter @fight-the-landlord/client preview`
   *   `node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server --scenario minimal`
   */
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
});
