#!/usr/bin/env node
/**
 * 小程序端构建入口（切片 P17 / R552）：**一个参数**同时导出 REST 与 WS 两个端点。
 *
 * ## 为什么需要它
 *
 * 小程序端**没有「同源」概念**：`VITE_API_BASE`（默认 `/api`）与 `VITE_WS_ENDPOINT`
 * 都必须给**绝对地址**，否则运行时第一步就挂（REST 侧 R550 会响亮报错，WS 侧同理）。
 * 两种常见做法都不可取：
 *   - 把地址写进 `.env.production` ⇒ 那个文件**同时作用于 H5 的生产构建**，
 *     等于污染另一端的配置（造出第二个真源，R552 明确否掉）；
 *   - `VITE_API_BASE=… pnpm build` 这种 shell 前缀赋值 ⇒ **Windows 上不可用**
 *     （用户机器是 Windows/macOS）。
 *
 * 于是：一个零依赖的 Node 脚本，由**同一个参数**派生两个变量，再 spawn 真正的构建命令。
 * 端点解析与校验在 `apps/client/src/net/http.ts`（`resolveApiBase` / `resolveWsEndpoint`）。
 *
 * ## 用法
 *
 *   node scripts/build-mp-weixin.mjs 192.168.1.5:3000          # 一次性构建
 *   node scripts/build-mp-weixin.mjs 192.168.1.5:3000 --dev     # 监听模式（开发者工具热更新）
 *
 * ⚠️ `<host:port>` 必须是**手机能访问到的地址**（局域网 IP / 域名），不能用 `localhost`：
 * 开发者工具与手机同机时 `localhost` 也许能凑合，**真机必挂**。
 *
 * 退出码：透传子进程的退出码；参数不合法时打印用法并以 1 退出（**不启动构建**）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 `<repo>/scripts/` 下）——`pnpm --filter` 必须在 workspace 根执行。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = '@fight-the-landlord/client';

const USAGE = `用法：node scripts/build-mp-weixin.mjs <host:port> [--dev]

  <host:port>  微信小程序能访问到的网关地址，例如 192.168.1.5:3000
               （真机必须用局域网 IP / 域名，不能用 localhost）
  --dev        监听模式（pnpm --filter ${PACKAGE} dev:mp-weixin）
               不加则一次性构建（pnpm --filter ${PACKAGE} build:mp-weixin）

本脚本由**同一个参数**导出两个变量（R552）：
  VITE_API_BASE     = http://<host:port>/api
  VITE_WS_ENDPOINT  = http://<host:port>

⚠️ 小程序端没有「同源」概念：这两个变量缺一个，运行时会**直接报错**（R550，不猜、不派生）。`;

/** 把参数归一成 origin：允许省略 `http://`（默认 http），允许带结尾 `/`。 */
function normalizeOrigin(raw) {
  const trimmed = raw.replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** `host:port` 的形态校验（IPv4 / 主机名 + 可选端口）；IPv6 字面量请用域名。 */
const HOST_PORT = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
// `--dev` 之外只允许**一个**位置参数：多给一个就说明用户对用法有误解，响亮报错而不是猜。
const positional = argv.filter((arg) => !arg.startsWith('--'));
const unknownFlags = argv.filter((arg) => arg.startsWith('--') && arg !== '--dev');

if (unknownFlags.length > 0) fail(`未知参数：${unknownFlags.join(' ')}`);
if (positional.length !== 1) {
  fail(positional.length === 0 ? '缺少 <host:port> 参数。' : `只接受一个 <host:port>，收到 ${positional.length} 个。`);
}

const origin = normalizeOrigin(positional[0]);
if (!HOST_PORT.test(origin.replace(/^https?:\/\//i, ''))) {
  fail(`<host:port> 形态不合法：${positional[0]}`);
}

const apiBase = `${origin}/api`;
const wsEndpoint = origin;
const script = dev ? 'dev:mp-weixin' : 'build:mp-weixin';

// 开头先打印将要注入的两个变量：让用户能**核对**（这是「配错就响亮报错」之外的最后一道人工闸）。
process.stdout.write(
  `[build-mp-weixin] 即将注入的端点（R550/R552）：\n` +
    `  VITE_API_BASE=${apiBase}\n` +
    `  VITE_WS_ENDPOINT=${wsEndpoint}\n` +
    `[build-mp-weixin] 模式：${dev ? 'dev（监听）' : 'build（一次性）'} ⇒ pnpm --filter ${PACKAGE} ${script}\n`,
);

/**
 * `shell: true` 是**跨平台**的关键：Windows 上 `pnpm` 是 `pnpm.cmd`，不经 shell 起不来。
 * 整条命令由**固定常量**拼成（用户参数不参与），因此没有注入面。
 */
const child = spawn(`pnpm --filter ${PACKAGE} ${script}`, {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_API_BASE: apiBase, VITE_WS_ENDPOINT: wsEndpoint },
});

child.on('error', (error) => {
  process.stderr.write(`[build-mp-weixin] 无法启动 pnpm：${String(error)}\n`);
  process.exit(1);
});

// 透传退出码（`--dev` 时用户 Ctrl+C，child 以信号结束 ⇒ code 为 null，同样非零退出）。
child.on('close', (code) => {
  if (code === 0) assertNoNodeUrlRequire(dev);
  process.exit(typeof code === 'number' ? code : 1);
});

/**
 * 产物级判据（切片 P19 的缺陷回归闸）：**小程序产物里不得出现 `require("url")`**。
 *
 * ## 为什么必须是产物级
 *
 * 打包器为 `import.meta` 生成的 helper 长这样：
 * `{ url: typeof document === 'undefined' ? require("url").pathToFileURL(__filename).href : … }`。
 * 微信小程序的 service 上下文**没有 `document`** ⇒ 必走 `require("url")` 分支 ⇒ 小程序模块系统里
 * 没有 Node 的 `url` ⇒ `Error: module 'url.js' is not defined, require args is 'url'`
 * ⇒ **`app.js` 整条模块图在求值期中断**（连带症状：`Page "pages/login/login" has not been registered yet`）。
 *
 * **源码级**防线是「`src/**` 不得写 `typeof import.meta` / `import.meta.url`」
 * （`apps/client/test/import-meta-guard.gate.test.ts`）；但**依赖也可能**引入同样的 helper，
 * 所以这道**产物级**断言不可省 —— 它由本脚本在构建成功后自动执行，构建者不需要记得跑。
 */
function assertNoNodeUrlRequire(isDev) {
  const outDir = join(REPO_ROOT, 'apps', 'client', 'dist', isDev ? 'dev' : 'build', 'mp-weixin');
  if (!existsSync(outDir)) {
    process.stderr.write(`[build-mp-weixin] ⚠️ 找不到产物目录 ${outDir}，跳过产物级判据。\n`);
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
    process.stdout.write('[build-mp-weixin] ✅ 产物级判据：无 require("url") / pathToFileURL（P19 回归闸）\n');
    return;
  }
  process.stderr.write(
    `\n[build-mp-weixin] ❌ 产物级判据失败：小程序产物里出现了 Node 的 url 模块引用：\n` +
      offenders.map((f) => `  - ${f}\n`).join('') +
      `\n微信小程序的 service 上下文没有 document ⇒ 会走 require("url") 分支 ⇒ 运行期抛\n` +
      `  Error: module 'url.js' is not defined, require args is 'url'\n` +
      `⇒ app.js 整条模块图中断（页面不会注册）。\n` +
      `常见原因：源码里写了 \`typeof import.meta\` 或 \`import.meta.url\`（见 apps/client/src/config.ts#readEnv 的注释），\n` +
      `或者某个依赖引入了同样的 helper。\n`,
  );
  process.exit(1);
}

// 让 Ctrl+C 能落到子进程上（POSIX；Windows 下由 shell 的同控制台进程组处理）。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
