#!/usr/bin/env node
/**
 * App 端构建入口（切片 P26 / R552/R636）：**一个参数**同时导出 REST 与 WS 两个端点。
 *
 * ## 为什么需要它
 *
 * App 端**没有「同源」概念**（native 容器 + 本地资源 webview，`location.origin` 不是网关）：
 * `VITE_API_BASE`（默认 `/api`）与 `VITE_WS_ENDPOINT`（空）都必须给**绝对地址**，否则运行时
 * 第一步就挂 —— REST 侧 `resolveApiBase` 与 WS 侧 `resolveWsEndpoint` 都会**响亮报错**（R632）。
 * 两种常见做法都不可取（R552，与小程序端逐字同款理由）：
 *   - 把地址写进 `.env.production` 入库 ⇒ 同时作用于 H5 的生产构建，污染另一端的配置；
 *   - `VITE_API_BASE=… pnpm build` 这种 shell 前缀赋值 ⇒ **Windows 上不可用**。
 *
 * 于是：与 `scripts/build-mp-weixin.mjs` **逐字同形**的零依赖 Node 脚本，由**同一个参数**派生
 * 两个变量，再 spawn 真正的构建命令；构建成功后跑**产物级 P19 回归闸**。
 *
 * ## ⚠️ 与 HBuilderX 云打包的分工（两套构建入口，一份端点事实）
 *
 * HBuilderX 的云打包**不经过本脚本**（GUI 内部构建，读的是 `.env*` 文件）⇒ 云打包轮请在
 * `apps/client/.env.production.local` 放**同一对端点值**（本机专用：gitignore 覆盖；且
 * `.dockerignore` 对 `.env*` 的排除是任意深度匹配 ⇒ 不会污染任何 Docker/H5 镜像构建）。
 * 本脚本是 **CLI 构建入口**（P26 冻结口径），也是「端点值先在这里核对打印、再落到 .local」的
 * 人工闸：两端点不一致时以运行时**响亮报错**为准（不会静默）。
 *
 * ## 用法
 *
 *   node scripts/build-app.mjs api.example.com             # 生产端点（一次性构建）
 *   node scripts/build-app.mjs 192.168.1.5:3000 --dev     # 局域网 + 监听模式
 *
 * ⚠️ `<host:port>` 必须是**设备能访问到的地址**（域名 / 局域网 IP），不能用 `localhost`：
 * 模拟器同主机时 `localhost` 也许能凑合，**真机必挂**。
 *
 * 退出码：透传子进程的退出码；参数不合法时打印用法并以 1 退出（**不启动构建**）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 仓库根（本文件在 `<repo>/scripts/` 下）——`pnpm --filter` 必须在 workspace 根执行。
 *
 * ⚠️ 必须**惰性求值**：本文件会被 vitest **import**（`test/app-endpoint.test.ts` 消费四个纯函数），
 * 而本仓 vitest 跑在 jsdom 里，那里 `import.meta.url` **不是 `file://` URL** ⇒ import 期就调
 * `fileURLToPath` 会把测试进程炸掉（`TypeError: The URL must be of scheme file`，本仓既有教训）。
 */
function repoRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}
const PACKAGE = '@fight-the-landlord/client';

const USAGE = `用法：node scripts/build-app.mjs <host:port> [--dev]

  <host:port>  App 要访问的网关地址，例如 api.example.com 或 192.168.1.5:3000
               （真机必须用它可达的地址，不能用 localhost）
  --dev        监听模式（pnpm --filter ${PACKAGE} dev:app）
               不加则一次性构建（pnpm --filter ${PACKAGE} build:app）

本脚本由**同一个参数**导出两个变量（R552，与小程序端逐字同形）：
  VITE_API_BASE     = http://<host:port>/api
  VITE_WS_ENDPOINT  = http://<host:port>

⚠️ App 端没有「同源」概念：这两个变量缺一个，运行时会**直接报错**（R632，不猜、不派生）。
⚠️ HBuilderX 云打包不走本脚本（GUI 内部构建读 .env 文件）⇒ 云打包轮用
   apps/client/.env.production.local 放同一对端点（本机专用，不入库）。`;

/** `host:port` 的形态校验（IPv4 / 主机名 + 可选端口）；IPv6 字面量请用域名。 */
const HOST_PORT = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;

/**
 * 参数解析（**纯函数，供单测消费**）。
 *
 * ⚠️ 错误一律 **throw**（不在这里 `process.exit`）：本文件被 vitest 直接 import，
 * `process.exit(1)` 会把测试进程杀掉（P25 同类坑）。落 stderr + 退出码是 `main()` 的职责。
 */
export function parseArgs(argv) {
  const dev = argv.includes('--dev');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--dev');
  if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(' ')}`);
  if (positional.length !== 1) {
    throw new Error(
      positional.length === 0
        ? '缺少 <host:port> 参数。'
        : `只接受一个 <host:port>，收到 ${positional.length} 个。`,
    );
  }
  return { host: positional[0], dev };
}

/** 把参数归一成 origin：允许省略 `http://`（默认 http），允许带结尾 `/`。 */
export function normalizeOrigin(raw) {
  const trimmed = raw.replace(/\/+$/, '');
  if (trimmed.startsWith('[')) throw new Error(`IPv6 字面量请改用域名或 IPv4：${raw}`);
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!HOST_PORT.test(withScheme.replace(/^https?:\/\//i, ''))) {
    throw new Error(`<host:port> 形态不合法：${raw}`);
  }
  return withScheme;
}

/** 一个参数派生两个端点（与 build-mp-weixin.mjs 逐字同形，R552）。 */
export function deriveEndpoints(origin) {
  return { VITE_API_BASE: `${origin}/api`, VITE_WS_ENDPOINT: origin };
}

/** 扫 {相对路径: 内容} ⇒ 命中 Node url 引用的文件列表（纯函数，便于用合成样本自证）。 */
export function scanForNodeUrl(files) {
  return Object.entries(files)
    .filter(([, text]) => /require\(\s*["']url["']\s*\)/.test(text) || /pathToFileURL/.test(text))
    .map(([path]) => path);
}

/**
 * 产物级判据（切片 P19 的缺陷回归闸）：**App 产物里不得出现 `require("url")` / `pathToFileURL`**。
 *
 * 打包器为 `import.meta` 生成的 helper 形如
 * `{ url: typeof document === 'undefined' ? require("url").pathToFileURL(__filename).href : … }`；
 * App 的 plus 运行时 service 侧同样**没有** Node 的 `url` 模块 ⇒ 整条模块图在求值期中断
 * （与小程序端 P19 同形）。**源码级**防线是 `test/import-meta-guard.gate.test.ts`；
 * 但依赖也可能引入同款 helper ⇒ 这道**产物级**断言不可省（由本脚本构建后自动执行）。
 */
function assertNoNodeUrlRequire(isDev) {
  const REPO_ROOT = repoRoot();
  const outDir = join(REPO_ROOT, 'apps', 'client', 'dist', isDev ? 'dev' : 'build', 'app');
  if (!existsSync(outDir)) {
    process.stderr.write(`[build-app] ⚠️ 找不到产物目录 ${outDir}，跳过产物级判据。\n`);
    return;
  }
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8');
        if (/require\(\s*["']url["']\s*\)/.test(text) || /pathToFileURL/.test(text)) {
          offenders.push(relative(REPO_ROOT, full));
        }
      }
    }
  };
  walk(outDir);
  if (offenders.length === 0) {
    process.stdout.write('[build-app] ✅ 产物级判据：无 require("url") / pathToFileURL（P19 回归闸）\n');
    return;
  }
  process.stderr.write(
    `\n[build-app] ❌ 产物级判据失败：App 产物里出现了 Node 的 url 模块引用：\n` +
      offenders.map((f) => `  - ${f}\n`).join('') +
      `\nApp 的 plus 运行时 service 侧没有 Node 的 url ⇒ 会在求值期抛\n` +
      `  Error: module 'url.js' is not defined, require args is 'url'\n` +
      `⇒ 整条模块图中断（页面不会注册）。\n` +
      `常见原因：源码里写了 \`typeof import.meta\` 或 \`import.meta.url\`（见 apps/client/src/config.ts#readEnv 的注释），\n` +
      `或者某个依赖引入了同样的 helper。\n`,
  );
  process.exit(1);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    process.exit(1);
  }
  const { host, dev } = parsed;

  let origin;
  try {
    origin = normalizeOrigin(host);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const { VITE_API_BASE, VITE_WS_ENDPOINT } = deriveEndpoints(origin);
  const script = dev ? 'dev:app' : 'build:app';

  // 开头先打印将要注入的两个变量：让用户能**核对**（这是「配错就响亮报错」之外的最后一道人工闸）。
  process.stdout.write(
    `[build-app] 即将注入的端点（R552/R632）：\n` +
      `  VITE_API_BASE=${VITE_API_BASE}\n` +
      `  VITE_WS_ENDPOINT=${VITE_WS_ENDPOINT}\n` +
      `[build-app] 模式：${dev ? 'dev（监听）' : 'build（一次性）'} ⇒ pnpm --filter ${PACKAGE} ${script}\n`,
  );

  /**
   * `shell: true` 是**跨平台**的关键：Windows 上 `pnpm` 是 `pnpm.cmd`，不经 shell 起不来。
   * 整条命令由**固定常量**拼成（用户参数不参与），因此没有注入面。
   */
  const child = spawn(`pnpm --filter ${PACKAGE} ${script}`, {
    cwd: repoRoot(),
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, VITE_API_BASE, VITE_WS_ENDPOINT },
  });

  child.on('error', (error) => {
    process.stderr.write(`[build-app] 无法启动 pnpm：${String(error)}\n`);
    process.exit(1);
  });

  // 透传退出码（`--dev` 时用户 Ctrl+C，child 以信号结束 ⇒ code 为 null，同样非零退出）。
  child.on('close', (code) => {
    if (code === 0) assertNoNodeUrlRequire(dev);
    process.exit(typeof code === 'number' ? code : 1);
  });

  // 让 Ctrl+C 能落到子进程上（POSIX；Windows 下由 shell 的同控制台进程组处理）。
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

/** 主流程守卫：被测试 import 时**不执行** main（vitest 的 argv[1] 不是本文件）。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
