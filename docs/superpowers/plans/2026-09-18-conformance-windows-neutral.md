# conformance 跨平台中立化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 conformance 的 13 个用例在 Windows 上全绿，且不削弱任何一条判据（Linux 侧由用户人工复核一次）。

**Architecture:** 把 4 类平台假设（进程启动 / 环境文件 / 超时 / 网络地址）逐一改写成**平台中立**形态 —— 不引入 `process.platform` 分支。能中立就中立，确实环境相关的（如「哪个地址回 RST」）改为**运行时发现 + 响亮失败**，绝不跳过。

**Tech Stack:** TypeScript（Node 20 语义，本机 Node 24）、conformance 自研探针框架（`lib/probe.ts` / `lib/rpc.ts`）、docker compose、vitest。

**设计真源：** `docs/superpowers/specs/2026-09-18-conformance-windows-neutral-design.md`（`1d11c8f`）
**前置：** `6fa11a1`（路径分隔符归一化）已完成。

## Global Constraints

逐字来自规格，**每个任务都隐含包含**：

1. **不引入 `process.platform` 分支**（规格「本片-1」）。环境相关的差异一律用**运行时实测/发现**解决。
2. **不削弱任何一条判据**（R435）。本片**不增删任何 `checks.*` 调用**；判据面的改动**恰好 5 处调用点**（其中**只有 1 处**是判据参数变化），逐条见下表。
3. **任何「本环境提供不了该条件」的情况一律响亮失败并打印诊断，绝不跳过**（R115）。
4. **不改生产代码**；**不改 CI**（conformance 仍不进 `scripts/ci.sh`）。
5. **不碰 `packages/` 与 `apps/`** —— 本片只动 `tools/conformance/`。
6. 提交信息末尾逐字加：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### 判据面改动清单（全片就这 5 处调用点，逐字对照）

> **执行期扩表（2026-09-18）**：原为 4 处。Task 3 评审的 Important 发现要求订正一处
> 事实错误的注释，连带清掉一条 `checks.that` 的**消息文案**里的同类残留提及
> ⇒ 变 5 处。**业务上仍然只有 1 处判据参数变化**，第 5 处纯文案。用户已裁决。

| # | 位置 | 改动 | 性质 |
|---|---|---|---|
| 1 | `slice-07.2-deploy.ts` `checks.eq(empty.status, 1, …)` | 消息文案（去「124」） | 仅消息文案 |
| 2 | `slice-07.2-deploy.ts` `checks.eq(withValue.signal, 'SIGTERM', …)` | `withValue.status, 124` → `withValue.signal, 'SIGTERM'` | ⚠️ **判据参数变（全片唯一一处）** |
| 3 | `slice-07.2-deploy.ts` `checks.that(withValue.timedOut, …)` | 消息文案（去「退出码 124」） | 仅消息文案 |
| 4 | `slice-07.2-deploy.ts` `checks.that(!empty.timedOut, …)` | 消息文案（去反引号包裹的 `` `timeout` `` 命令名） | 仅消息文案 |
| 5 | `slice-07.2-rpc.ts` `checks.eq(refused.kind, 'ECONNREFUSED', …)` | 消息文案（提示端口可能被抢占） | 仅消息文案 |

**任何其它 `checks.*` 调用都不得出现在 diff 里。** 收尾时用 Task 5 Step 1 的跨行感知脚本核对。

### 提交划分（相对规格的一处细化，已在下方说明）

规格原本写「两个提交」。本计划改为 **5 个提交**（每任务一个）：回滚粒度更细，且「①=任务1+2 / ②=任务3+4」的 B/C 边界仍可还原。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `tools/conformance/src/lib/probe.ts` | 子进程探针（`runProc`） | 修改：`shell:true` + `timedOut` 判据 |
| `tools/conformance/src/lib/env-file.ts` | **新增**：空 env 文件的生命周期助手 | 创建 |
| `tools/conformance/src/lib/rpc.ts` | RPC 传输层探针 | 修改：删 `REFUSING_HOST`，加 loopback 端点构造；改文件头注释 |
| `tools/conformance/src/slices/slice-07.2-deploy.ts` | 生产编排收口用例 | 修改：`composeConfig` 用 helper；`runOneShot` 去 `timeout` 命令 |
| `tools/conformance/src/slices/slice-07.2-rpc.ts` | TCP RPC 迁移用例 | 修改：端点发现 + 接线 + 注释 |

**边界理由**：`lib/rpc.ts` 只管「RPC 传输层怎么探」（纯 `node:net`，不碰 docker）；**需要 docker 的编排留在 slice 里**。所以端点发现函数放 slice，`lib/rpc.ts` 只提供 loopback 构造。

---

## Task 1: #2 + #2b —— `runProc` 的进程启动与超时判据

**Files:**
- Modify: `tools/conformance/src/lib/probe.ts:26-58`

**Interfaces:**
- Consumes: 无（本任务是第一个）
- Produces: `runProc(cmd, args, {cwd, timeoutMs})` 签名不变，返回 `ProcResult {status, timedOut, output}` 不变。**唯一变化**：内部改用 `shell: true`、`timedOut` 改判据。

- [ ] **Step 1: 记录 RED（最小复现）**

```bash
cd /d/Code/pokergame && node -e "
const {spawnSync}=require('node:child_process');
const r=spawnSync('pnpm',['--version'],{encoding:'utf-8'});
console.log('status='+String(r.status)+' error='+(r.error?r.error.code:'—'));
"
```

期望输出：`status=null error=ENOENT`（`pnpm` 在 Windows 上只有 `pnpm.cmd`，Node 自 CVE-2024-27980 修复后禁止无 shell 直启 `.cmd`）。

- [ ] **Step 2: 记录 RED（集成层，确认该缺陷确实卡住用例）**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-hardening 2>&1 | tail -3
```

期望：`❌ slice-07.2-hardening 失败：注入前 \`client/source-boundary\` 必须先绿（实际退出码 null）`
（`null` 就是 Step 1 的 ENOENT 被误传成「没退出」的结果。）

- [ ] **Step 3: 实现**

把 `tools/conformance/src/lib/probe.ts` 的 `ProcResult` 注释与 `runProc` 整体替换为：

```ts
/** 一次子进程调用的结果。`status === null` = 被信号杀死或超时（**不是**「成功」）。 */
export interface ProcResult {
  status: number | null;
  /** 被本探针的超时以 `killSignal`（默认 SIGTERM）杀掉。判据见 `res.error?.code`。 */
  timedOut: boolean;
  /** `stdout + stderr`（判据的 RED/GREEN 原文都从这里取）。 */
  output: string;
}

/**
 * 同步跑一条命令并把 stdout/stderr 收进结果（**不抛错** —— 退出码是判据的一部分）。
 *
 * 用 `spawnSync`（不是 `execFileSync`）：后者的非零退出直接抛，把「退出码」变成异常，
 * 而本文件的全部判据都是「**必须非零退出**」—— 抛错就看不到码。
 *
 * ⚠️ **`shell: true`（平台中立，R-本片-1）**：Windows 上 `pnpm` 只有 `pnpm.cmd`，
 * Node 自 CVE-2024-27980 修复后**禁止**无 shell 直启 `.cmd`（实测 `error=EINVAL`），
 * 而不带 shell 的裸 `spawnSync('pnpm', …)` 更是直接 `ENOENT`（实测）。
 * ⇒ 统一经 shell：Windows 走 `cmd.exe`、POSIX 走 `/bin/sh`，两侧同一份代码。
 *
 * ⚠️ **本函数要求 `cmd` 与 `args` 都是代码内字面量。** 经 shell 后参数**不再逐个转义**
 * （只是拼接），含空格或 shell 元字符的值会坏。全部调用点传的都是 `'pnpm'` + 包名/过滤名，
 * 满足该前提；将来若需传外部输入，必须先自己转义。
 *
 * ⚠️ **已知退化（POSIX）**：`shell: true` 下 `timeout` 杀掉的**只是外壳进程**，
 * 其子进程（`pnpm` → `vitest`）**不会被连带杀死** ⇒ 超时时可能留下孤儿。
 * 走到超时已说明该次运行是坏的，故接受；已在规格 §5.2 登记为 Linux 侧的观察项。
 */
export function runProc(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): ProcResult {
  // ⚠️ 整串命令形态（不是 `spawnSync(cmd, args, {shell:true})`）：后者在 Node ≥22 上
  // 会触发 DEP0190（「以 shell 跑子进程时传 args 不转义」），污染门禁输出。实测：
  // 参数数组形态触发、整串形态不触发。
  const res = spawnSync([cmd, ...args].join(' '), {
    cwd: opts.cwd,
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
    shell: true,
    // `CI=true` 让 pnpm/vitest 不要交互式提问；`FORCE_COLOR=0` 让 RED 原文可 grep。
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });
  return {
    status: res.status,
    // ⚠️ 旧实现是 `res.status === null`，**无法区分「超时」与「根本没启动起来」**
    // （实测量者都是 null）。实测三态：正常 `status=0` / 超时 `status=null error=ETIMEDOUT` /
    // 起不来 `status=null error=ENOENT` ⇒ 只有读 `error.code` 才分得开。
    timedOut: res.error?.code === 'ETIMEDOUT',
    output: `${String(res.stdout ?? '')}${String(res.stderr ?? '')}`,
  };
}
```

- [ ] **Step 4: 编译**

```bash
cd /d/Code/pokergame && pnpm --filter @fight-the-landlord/conformance build
```

期望：无输出（tsc 成功）。

- [ ] **Step 5: 验证 GREEN（最小复现）**

```bash
cd /d/Code/pokergame && node -e "
const {spawnSync}=require('node:child_process');
const r=spawnSync('pnpm --version',{encoding:'utf-8',shell:true});
console.log('status='+r.status+' out='+String(r.stdout).trim());
"
```

期望：`status=0 out=9.15.0`（且**无 DEP0190 告警**）。

- [ ] **Step 6: 验证 GREEN（集成层）**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-hardening 2>&1 | tail -6
```

期望：**不再**出现「实际退出码 null」。该用例可能仍在**更后面**的步骤失败 —— 那是预期内的（规格 §5.1 的「迭代允许」），本步只要求**越过**注入探针的前置断言。

- [ ] **Step 7: 提交**

```bash
cd /d/Code/pokergame
git add tools/conformance/src/lib/probe.ts
git commit -m "fix(conformance): runProc 改用 shell（Windows 上 pnpm 只有 .cmd）+ 修正 timedOut 判据

Windows 上裸 spawnSync('pnpm', …) 直接 ENOENT（实测），.cmd 又不能无 shell 直启
（EINVAL）。统一经 shell：整串命令形态（参数数组形态会触发 DEP0190 污染输出）。

顺带修 timedOut：旧判据 status === null 无法区分「超时」与「起不来」（两者都是 null），
改读 error.code === 'ETIMEDOUT'。如实标注：该字段全仓无人消费 ⇒ 卫生性修复，
不改变现有行为。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: #3 —— 空 env 文件替代 `/dev/null`

**Files:**
- Create: `tools/conformance/src/lib/env-file.ts`
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts:117-129`（`composeConfig`）
- Modify: `tools/conformance/src/slices/slice-07.2-rpc.ts:226-236`（`prodConfig`）

**Interfaces:**
- Consumes: 无
- Produces: `withEmptyEnvFile<T>(use: (envFilePath: string) => T): T` —— 在回调执行期间保证一个**空文件**存在，退出后（含抛错路径）删除整个临时目录。

- [ ] **Step 1: 记录 RED**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-deploy 2>&1 | grep -A2 "找不到\|env file" | head -5
```

期望：`couldn't find env file: D:\dev\null` —— `/dev/null` 在 Windows 上被解析成 `D:\dev\null`。

- [ ] **Step 2: 创建 helper**

新建 `tools/conformance/src/lib/env-file.ts`：

```ts
/**
 * 「空 env 文件」的跨平台助手。
 *
 * ## 为什么需要它
 *
 * compose 的 `--env-file` 传 `/dev/null` 可以在**不加载仓库 `.env`** 的前提下渲染配置
 * （`slice-07.2-deploy` 与 `slice-07.2-rpc` 的生产形态断言都靠它，R98 / R147）。
 * 但 **Windows 上没有 `/dev/null`** —— `docker compose` 会把它当作盘符相对路径，
 * 解析成 `D:\dev\null` 并报 `couldn't find env file`（实测）。
 *
 * 中立写法：**运行时建一个真的空文件**，把它**自己的路径**传进去。
 * 语义等价（`/dev/null` 读作空，空文件同样读作空），且两侧都成立。
 *
 * ## 为什么是回调形态
 *
 * 返回路径、要求调用方自己清理，就把「不泄漏临时目录」变成了**靠自觉的约定** ——
 * 本仓对这类约定一贯不信任。用 `use` 回调把清理放进 `finally`，
 * **让泄漏在形态上不可能发生**（调用方拿不到绕过 finally 的机会）。
 *
 * ⚠️ 调用方必须在 `use` 回调**内部**发起子进程调用，不要只取路径、事后再用。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function withEmptyEnvFile<T>(use: (envFilePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-env-'));
  try {
    const path = join(dir, '.env.empty');
    writeFileSync(path, '');
    return use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: 接入 `slice-07.2-deploy.ts`**

在 import 区（`import { execFileSync, spawnSync } from 'node:child_process';` 之后）加：

```ts
import { withEmptyEnvFile } from '../lib/env-file';
```

把 `composeConfig`（`:121-129`）替换为：

```ts
/** 渲染一种形态的 compose 配置（`args` 里带 `-f docker-compose.yml` = 生产形态）。 */
function composeConfig(args: string[]): any {
  const out = withEmptyEnvFile((envFile) =>
    execFileSync(
      'docker',
      ['compose', '--env-file', envFile, ...args, 'config', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: isolatedEnv(), maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  return JSON.parse(out);
}
```

**同时更新本文件里把 `/dev/null` 写成事实的注释**（本仓的注释是承重文档，不留过时说法）：

`:14` 的
`*   ① \`docker compose --env-file /dev/null -f docker-compose.yml config --format json\``
改为
`*   ① \`docker compose --env-file <空文件> -f docker-compose.yml config --format json\``

`:20-21` 的
`*   1. **必须 \`--env-file /dev/null\`（隔离仓库 \`.env\`）＋ 从 \`env\` 里剔除`
改为
`*   1. **必须 \`--env-file <空文件>\`（隔离仓库 \`.env\`）＋ 从 \`env\` 里剔除`

并在该条末尾（`R147 只写了前半条。` 之后）补一句：
`     ⚠️ 空文件由 \`withEmptyEnvFile\` 运行时生成，**不写 \`/dev/null\`** —— 后者在 Windows 上被解析成 \`D:\dev\null\`。`

- [ ] **Step 4: 接入 `slice-07.2-rpc.ts`**

在 `import { execFileSync } from 'node:child_process';`（`:103`）之后加：

```ts
import { withEmptyEnvFile } from '../lib/env-file';
```

把 `prodConfig`（`:226-236`）替换为：

```ts
function prodConfig(): any {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'INTERNAL_SERVICE_TOKEN'),
  );
  const out = withEmptyEnvFile((envFile) =>
    execFileSync(
      'docker',
      ['compose', '--env-file', envFile, '-f', 'docker-compose.yml', 'config', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf-8', env, maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  return JSON.parse(out);
}
```

同时把该函数的 docblock 里 `--env-file /dev/null` 的措辞改为 `--env-file <空文件>`（保持解释「隔离仓库 `.env`」不变）。

- [ ] **Step 5: 编译**

```bash
cd /d/Code/pokergame && pnpm --filter @fight-the-landlord/conformance build
```

期望：无输出。

- [ ] **Step 6: 验证 GREEN**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-deploy 2>&1 | tail -6
```

期望：**不再**出现 `couldn't find env file`。用例可能仍在其后步骤失败（预期内）。

顺带验证不留临时目录：

```bash
ls -d "$TMPDIR"/conformance-env-* 2>/dev/null || ls -d /tmp/conformance-env-* 2>/dev/null || echo "无残留 ✅"
```

- [ ] **Step 7: 提交**

```bash
cd /d/Code/pokergame
git add tools/conformance/src/lib/env-file.ts tools/conformance/src/slices/slice-07.2-deploy.ts tools/conformance/src/slices/slice-07.2-rpc.ts
git commit -m "fix(conformance): 空 env 文件替代 /dev/null（Windows 上无此设备路径）

--env-file /dev/null 在 Windows 上被 docker compose 解析成 D:\\dev\\null ⇒
couldn't find env file。改为运行时建真的空文件并传其路径，语义等价且两侧都成立。

用回调形态（withEmptyEnvFile(use)）而非「返回路径 + 调用方自清理」：
后者把不泄漏变成靠自觉的约定，本仓对这类约定一贯不信任。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: #4 —— `runOneShot` 去掉 POSIX `timeout` 命令

**Files:**
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts:131-136`（`RunResult`）
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts:160-189`（`runOneShot`）
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts:441,445,455-462`（断言与 info）

**Interfaces:**
- Consumes: Task 1 的 `error.code === 'ETIMEDOUT'` 判据形态（同族，但本文件**不** import `lib/probe.ts`，自带实现）
- Produces: `RunResult` 变为 `{status: number|null; signal: NodeJS.Signals|null; timedOut: boolean; stderr: string}`

- [ ] **Step 1: 记录 RED（⚠️ 执行期订正：本机现象与规格预期不同，已实测立案）**

> **订正记录（2026-09-18，执行期）**：规格 §0 把本类记为「POSIX 专有命令」，预期 Windows 上 ENOENT。
> **实测不成立**：本机 PATH 上有 **Git 自带的 coreutils**，`timeout` 能解析并**碰巧正确**工作
> （`slice-07.2-deploy` 因此在改动前就已整例绿 104/104）。
> **但缺陷是真的，且比原描述更微妙 —— 它是 PATH 依赖性的。** 用户 2026-09-18 裁决：**继续中立化**。

```bash
cd /d/Code/pokergame && node -e "
const {spawnSync}=require('node:child_process');
const w=spawnSync('where',['timeout'],{encoding:'utf-8',shell:true});
console.log('where timeout →');
console.log(String(w.stdout||'').trim().split('\n').filter(Boolean).join('\n'));
"
```

实测输出：

```
E:\Softwares\Git\usr\bin\timeout.exe
C:\Windows\System32\timeout.exe
```

**同名两个程序，语义完全不同**：

| 解析到 | 后果 |
|---|---|
| `Git\usr\bin\timeout.exe`（GNU coreutils） | ✅ 正确语义 → 超时退出码 124 |
| `C:\Windows\System32\timeout.exe`（Windows 交互式等待） | ❌ **另一个命令**，不接受这些参数 |

**哪个赢由 PATH 顺序决定** —— 现在是「碰巧对」。本任务要消除的正是这个**隐式 PATH 依赖**。

⇒ 本步的作用是**记录该前提**，不是制造一个假 RED。**真正的验收在 Step 6**：
改完之后，行为由 Node 自身决定，与 PATH 无关。

- [ ] **Step 2: 改 `RunResult`**

```ts
interface RunResult {
  status: number | null;
  /** 被本用例的超时以 SIGTERM 杀掉（= 进程到点仍在跑）。`status` 此时为 `null`。 */
  signal: NodeJS.Signals | null;
  /** 本用例的超时生效（等价于 `signal === 'SIGTERM'`，单独留一个语义名给判据读）。 */
  timedOut: boolean;
  stderr: string;
}
```

- [ ] **Step 3: 改 `runOneShot`**

把 `:155-189` 的 docblock + 函数替换为：

```ts
/**
 * 用**生产形态**起一个一次性容器并显式注入 `INTERNAL_SERVICE_TOKEN`。
 *
 * `--no-deps` 的理由见文件头；`-T` 是「无 TTY 环境下不要分配 TTY」。
 *
 * ⚠️ **超时用 `spawnSync` 原生能力，不用 POSIX `timeout` 命令**（本片中立化）：
 * 后者是 POSIX 专有工具 —— Windows 上**解析到哪个同名程序由 PATH 顺序决定**：Git 自带的
 * coreutils（正确语义），或 `C:\Windows\System32\timeout.exe`（交互式等待，语义完全不同）。
 * 实测 `where timeout` 两者都命中 ⇒ 现状是**碰巧能用**而非保证可用；原生超时没有这个不确定性。
 * 原生超时在到点时以 `killSignal`（默认 SIGTERM）杀掉子进程：
 * `status === null` 且 `error.code === 'ETIMEDOUT'`（实测）。
 *
 * ⚠️ 因此**判据不能再读 124**：124 是 POSIX `timeout` 命令自己的退出码约定，
 * 中立化后不存在。表达同一意图（「不是自己退出的，是被我们的超时杀掉的」）
 * 的中立形态是 `signal === 'SIGTERM'`。
 */
function runOneShot(token: string, seconds: number): RunResult {
  removeProbeContainer();
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--name',
      PROBE_CONTAINER,
      '-e',
      `INTERNAL_SERVICE_TOKEN=${token}`,
      'api-gateway',
      'node',
      'packages/api-gateway/dist/main.js',
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', env: isolatedEnv(), timeout: seconds * 1000 },
  );
  return {
    status: res.status,
    signal: res.signal,
    timedOut: res.error?.code === 'ETIMEDOUT',
    stderr: String(res.stderr ?? ''),
  };
}
```

- [ ] **Step 4: 改断言与 info（`§4 判据面改动清单` 的 3 行就在这里）**

把 `:441` 的 `info(...)` 替换为：

```ts
    info('基线（协调者在 master 镜像上实测）：空 token ⇒ 退出码 1 + 那一行 error；给了值 ⇒ 被本用例的超时以 SIGTERM 杀掉。');
```

把 `:445` 替换为（**仅消息文案变**，判据参数 `1` 不动）：

```ts
    checks.eq(empty.status, 1, '空 token 时进程**自己**以退出码 1 结束（`process.exit(1)`；被杀表示它反而活到了超时）');
```

把 `:455-462` 替换为：

```ts
    const withValue = runOneShot('probe-value', 8);
    info(`给了 token：退出码 ${String(withValue.status)}，signal=${String(withValue.signal)}（SIGTERM = 仍在 listen，被本用例的超时杀掉）`);
    // ⚠️ 判据参数由 `status === 124` 改为 `signal === 'SIGTERM'`（本片唯一一处判据参数变化）。
    // 意图不变：证明「进程不是自己退出的，而是被我们的超时杀掉的」——否则
    // 「空 token 起不来」无从归因到 fail-closed。124 是 POSIX `timeout` 命令的退出码约定，
    // 中立化后不存在；SIGTERM 是同一意图的中立表达，且更直接。
    checks.eq(
      withValue.signal,
      'SIGTERM',
      '给了 token 时进程必须**留在 listen**（8 秒内不自行退出 ⇒ 被本用例的超时以 SIGTERM 杀掉）—— 否则「空 token 起不来」无从归因到 fail-closed',
    );
    checks.that(withValue.timedOut, '正对照确认：SIGTERM 就是本用例超时的语义（进程仍在运行）');
```

**同时更新本文件里把 `timeout` 命令/退出码 124 写成事实的注释**（不留过时说法）：

`:18-19` 的
`*      （\`timeout\` 杀掉 ⇒ 退出码 124）。这条把「配置为空」与「服务拒绝启动」连成闭环`
改为
`*      （被本用例的超时以 SIGTERM 杀掉）。这条把「配置为空」与「服务拒绝启动」连成闭环`

`:31-32` 的整段
`* ⚠️ 运行期探针的两条约束：\`--no-deps\`（否则会连带把 redis/mysql 拉起来）与`
`* \`timeout\` 包一层（否则「成功启动」会让用例**永久挂住**）。正对照**必须**用`
`* \`spawnSync('timeout', ...)\`；\`execFileSync\` 直接跑不退出，永远不返回。`
改为
`* ⚠️ 运行期探针的两条约束：\`--no-deps\`（否则会连带把 redis/mysql 拉起来）与`
`* **超时**（否则「成功启动」会让用例**永久挂住**）。超时用 \`spawnSync\` 的**原生`
`* \`timeout\` 选项，**不用 POSIX \`timeout\` 命令**（后者是 POSIX 专有工具，Windows 上`
`* **能否解析、解析到哪个由 PATH 顺序决定** —— 本机实测 \`where timeout\` 同时命中 Git 自带的`
`* coreutils 与 \`C:\Windows\System32\timeout.exe\`，前者语义正确、后者是交互式等待命令）`
`* —— 而 \`execFileSync\` 直接跑不退出，永远不返回。`

`:144` 的
`* ⚠️ 为什么必须显式清：\`timeout\` 杀掉的是 **\`docker compose\` 客户端**，客户端被信号`
改为
`* ⚠️ 为什么必须显式清：本用例的超时杀掉的是 **\`docker compose\` 客户端**，客户端被信号`

`:148` 的
`* \`--name\` 冲突，\`run\` 直接失败，断言会以「退出码不是 1/124」的形式红掉，`
改为
`* \`--name\` 冲突，\`run\` 直接失败，断言会以「退出码不是 1、也没被信号杀掉」的形式红掉，`

- [ ] **Step 5: 编译**

```bash
cd /d/Code/pokergame && pnpm --filter @fight-the-landlord/conformance build
```

期望：无输出。（若有 `noUnusedLocals` 报错，说明 `:456` 的旧 `info` 没删干净。）

- [ ] **Step 6: 验证 GREEN**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-deploy 2>&1 | tail -12
```

期望：**③ 运行期 fail-closed** 那一组全绿，含
`✅ 给了 token 时进程必须留在 listen（…SIGTERM…）` 与
`✅ 正对照确认：SIGTERM 就是本用例超时的语义`。

⚠️ **若这里有红**，说明规格 §3.4 的「待实测假设」不成立（`docker compose run` 场景产不出 `ETIMEDOUT`/`SIGTERM`）——
**停下来按规格 §3.4 的备选判据处理，不要就地打补丁绕过。**

- [ ] **Step 7: 验证无残留容器**

```bash
docker ps -a --filter name=ftl-conformance-deploy-probe --format '{{.Names}}'
```

期望：空输出。

- [ ] **Step 8: 提交**

```bash
cd /d/Code/pokergame
git add tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "fix(conformance): runOneShot 用 spawnSync 原生超时替代 POSIX timeout 命令

POSIX `timeout` 在 Windows 上是 PATH 依赖的同名解析（实测 `where timeout` 同时命中 Git 自带的
coreutils 与 `C:\Windows\System32\timeout.exe`），现状是碰巧能用而非保证可用。

⚠️ 连带一处**判据参数**变化（全片唯一）：checks.eq(withValue.status, 124, …)
→ checks.eq(withValue.signal, 'SIGTERM', …)。124 是 POSIX timeout 命令的退出码约定，
中立化后不存在；判据意图（「不是自己退出的，是被我们的超时杀掉的」）不变，
SIGTERM 是同一意图的中立表达且更直接。RunResult 因此增加 signal 字段。

其余 2 行 checks.* 只动消息文案（empty.status===1 的判据参数未动）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: #5 —— 端点发现替代硬编码 `172.17.0.1`

**Files:**
- Modify: `tools/conformance/src/lib/rpc.ts:36-43`（文件头注释）、`:240-249`（`probeClosedPort` 的 docblock）、`:275-276`（`REFUSING_HOST`）
- Modify: `tools/conformance/src/slices/slice-07.2-rpc.ts:108-117`（import）、`:400-421`（第 5 组接线）

**Interfaces:**
- Consumes: `probeClosedPort(pattern, data, timeoutMs?, ep?)`（已存在，签名不变）
- Produces:
  - `lib/rpc.ts`：删除 `REFUSING_HOST`；新增 `constructRefusingEndpoint(): Promise<RpcEndpoint>`（**纯 `node:net`，不碰 docker**）
  - `slice-07.2-rpc.ts`：`discoverRefusingEndpoint(pattern, data): Promise<RpcEndpoint>`

- [ ] **Step 1: 记录 RED（两组实测）**

```bash
cd /d/Code/pokergame && node -e "
const net=require('node:net');
const probe=(h,p)=>new Promise(r=>{const t=Date.now();const s=net.connect({host:h,port:p});
 s.setTimeout(3000);
 s.on('error',e=>{s.destroy();r('ERROR '+e.code+' '+(Date.now()-t)+'ms')});
 s.on('timeout',()=>{s.destroy();r('TIMEOUT '+(Date.now()-t)+'ms')})});
(async()=>{
 console.log('172.18.0.1:3999 (实际网关) →', await probe('172.18.0.1',3999));
 console.log('172.17.0.1:3999 (硬编码值)  →', await probe('172.17.0.1',3999));
})();
"
```

期望：两者都是 `TIMEOUT`（本机 compose 网关是 `172.18.0.1`，硬编码的 `172.17.0.1` 连地址都不对；且**两者都不回 RST**）。

- [ ] **Step 2: 记录 RED（用例层）**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-rpc 2>&1 | tail -4
```

期望：`❌ slice-07.2-rpc 失败：未监听地址（docker0 网关，对端 RST）上的失败类型是 ECONNREFUSED`

- [ ] **Step 3: `lib/rpc.ts` —— 换掉常量、加构造器**

删除 `:275-276` 的 `REFUSING_HOST` 及其 docblock，替换为：

```ts
/**
 * 构造一个**必然回 RST** 的回环端点：`bind 127.0.0.1:0` 拿到内核分配的临时端口，
 * 随即 `close` —— 此刻该端口「有主机、无监听」，任何连接都会被回 RST。
 *
 * ⚠️ **为什么用构造而不是写死一个地址**：哪种地址回 RST 是**环境属性**，不是缺陷。
 * 本仓实测过两台机器的观察**恰好相反**：
 *   - R229 那台：`172.17.0.1`（docker0 网关）回 RST；`127.0.0.1` 被黑洞 ⇒ 超时；
 *   - 本机（Windows + Docker Desktop）：`127.0.0.1` 回 RST；compose 网关**只给超时**。
 * ⇒ 写死地址在任一台机器上都是赌；构造出来的条件则**不依赖任何环境假设**。
 * ⚠️ 但仍有极小的「close 与 probe 之间端口被抢占」窗口 —— 那会表现为 RST 消失，
 * 调用方的 `kind === 'ECONNREFUSED'` 断言会**响亮失败**（不会被读成绿）。
 */
export async function constructRefusingEndpoint(): Promise<RpcEndpoint> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('构造 RST 端点失败：listen(0) 没有返回 AddressInfo');
  }
  const port = addr.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { host: '127.0.0.1', port };
}
```

并把 `:43` 的 import 改为：

```ts
import { connect, createServer, type Socket } from 'node:net';
```

- [ ] **Step 4: `lib/rpc.ts` —— 改两处「事实陈述」注释**

`:240-249` 的 docblock 目前把「①网关回 RST / ②回环黑洞」写成了**事实**。改为：

```
 * 有两种**截然不同**的失败形态，**哪一种出现在哪个地址取决于环境**（不是缺陷）：
 *   - `ECONNREFUSED`：对端真的回了 RST（1–2ms）；
 *   - `timeout`：SYN 被**丢弃**，不回 RST（挂到超时窗口）。
 *
 * ⚠️ R229 曾把「`172.17.0.1` 回 RST、`127.0.0.1` 被黑洞」记为事实，但那**只适用于那一台机器**：
 * 本片在 Windows + Docker Desktop 上实测，两者**恰好相反**（`127.0.0.1` 回 RST、
 * compose 网关只给超时）。⇒ **不要把地址与形态绑死**；需要 RST 时用
 * `constructRefusingEndpoint()` 构造，或用 `slice-07.2-rpc` 的 `discoverRefusingEndpoint()` 发现。
```

`:36-41` 的文件头那句「注意「连不上」在本机的**两种**形态（`ECONNREFUSED` 与 `ETIMEDOUT`，见 `probeClosedPort`）」保留（它说的是「有两种形态」这件事，与环境无关），无需改。

- [ ] **Step 5: `slice-07.2-rpc.ts` —— 加发现函数**

在 `REPO_ROOT`（`:120`）之后加：

```ts
/**
 * 发现一个**本环境确实回 RST** 的端点（本片中立化：不写死地址）。
 *
 * 候选按序探测，取第一个 `kind === 'ECONNREFUSED'` 的：
 *   ① `constructRefusingEndpoint()` —— 构造出的回环端点（覆盖多数环境，含 Windows）；
 *   ② compose 网关 + 一个确定没人听的端口（覆盖回环被黑洞的环境，如 R229 那台）。
 *
 * ⚠️ **一个都找不到 ⇒ 响亮失败**，并打印每个候选的实测形态（kind / code / 耗时）。
 * 不跳过、不假绿（R115）—— 「本环境提供不了该条件」是必须被看见的事实。
 */
async function discoverRefusingEndpoint(
  pattern: string,
  data: unknown,
): Promise<RpcEndpoint> {
  const candidates: RpcEndpoint[] = [await constructRefusingEndpoint()];

  // 候选②：运行时解析 compose 网络网关（**不**硬编码项目名 —— 它随目录名变）。
  try {
    const ls = execFileSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    const net = String(ls)
      .split('\n')
      .map((s) => s.trim())
      .find((n) => n.endsWith('ftl-platform'));
    if (net) {
      const gw = String(
        execFileSync(
          'docker',
          ['network', 'inspect', net, '--format', '{{(index .IPAM.Config 0).Gateway}}'],
          { cwd: REPO_ROOT, encoding: 'utf-8' },
        ),
      ).trim();
      if (gw) candidates.push({ host: gw, port: 3999 });
    }
  } catch {
    // 候选②是兜底：解析失败就只用候选①，但下面若①也不回 RST 会**响亮失败**并列出候选，
    // 所以这里吞掉异常不会造成静默跳过。
  }

  const observed: string[] = [];
  for (const ep of candidates) {
    try {
      const r = await probeClosedPort(pattern, data, 3000, ep);
      observed.push(`${ep.host}:${ep.port} → kind=${r.kind} code=${String(r.code)} ${r.elapsedMs}ms`);
      if (r.kind === 'ECONNREFUSED') return ep;
    } catch (err) {
      observed.push(`${ep.host}:${ep.port} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new ConformanceError(
    '本环境找不到「回 RST」的端点 —— 逐候选实测：\n  ' +
      observed.join('\n  ') +
      '\n（设计上要求本环境提供至少一个这样的端点；不跳过、不假绿。' +
      '若两个候选都给 timeout，说明本机回环与容器网关均被黑洞，需补第三个候选。）',
  );
}
```

- [ ] **Step 6: `slice-07.2-rpc.ts` —— 改 import 与第 5 组接线**

`import { execFileSync } from 'node:child_process';` —— 确认已在（`:103` 有）。若没有则加。

把 `:111` 的 `REFUSING_HOST,` 从 `../lib/rpc` 的 import 里删掉，并加 `constructRefusingEndpoint,`：

```ts
import {
  GAME_RPC,
  NO_MESSAGE_HANDLER,
  ROBOT_RPC,
  RpcTransportError,
  constructRefusingEndpoint,
  probeClosedPort,
  rpcCall,
  type RpcEndpoint,
} from '../lib/rpc';
```

把 `:406-421` 替换为：

```ts
      // ① 本环境**确实回 RST** 的端点（运行时发现，见 discoverRefusingEndpoint）。
      const refusing = await discoverRefusingEndpoint(RPC_PATTERNS.gameSnapshot, {
        roomCode: ABSENT_ROOM,
      } satisfies GameSnapshotRequest);
      const refused = await probeClosedPort(
        RPC_PATTERNS.gameSnapshot,
        { roomCode: ABSENT_ROOM } satisfies GameSnapshotRequest,
        3000,
        refusing,
      );
      info(`对 ${refusing.host}:${refusing.port} 的调用 → kind=${refused.kind}，code=${String(refused.code)}，耗时 ${refused.elapsedMs}ms`);
      info(`  原文：${refused.message}`);
      checks.eq(refused.kind, 'ECONNREFUSED', '回 RST 的地址上的失败类型是 ECONNREFUSED（若报 timeout：该端口可能在「构造」与「探测」之间被别的进程抢占 —— 重跑一次即可确认）');
      checks.eq(refused.code, 'ECONNREFUSED', '原始错误码逐字是 ECONNREFUSED');
      checks.that(
        refused.elapsedMs < REFUSED_WINDOW_MS,
        `ECONNREFUSED 必须在 ${REFUSED_WINDOW_MS}ms 内回来（实际 ${refused.elapsedMs}ms）—— ` +
          '挂到超时说明探针没有区分「连不上」与「不响应」',
      );
```

⚠️ 注意：`checks.eq(refused.kind, …)` 与 `checks.eq(refused.code, …)` 两条的**判据参数一字未动**，只有第 1 条的消息文案变了（这是「判据面改动清单」里第 5 处的消息文案）。

- [ ] **Step 7: `slice-07.2-rpc.ts` —— 改第 5 组的开头 `info`**

`:400-404` 的 `info(...)` 目前把「①网关回 RST / ②回环黑洞」当成事实。替换为：

```ts
      info('⚠️ 执行期发现（R229）：「连不上」有**两种**失败形态 ——');
      info('   ① 对端回 RST ⇒ `ECONNREFUSED`，1–2ms；');
      info('   ② SYN 被**丢弃** ⇒ 挂到超时窗口。');
      info('   ⚠️ **哪一种出现在哪个地址取决于环境**（R229 的观察只适用于那一台机器；本片在');
      info('      Windows + Docker Desktop 上实测到**相反**的组合）⇒ 本组**运行时发现**回 RST 的端点，');
      info('      不把地址与形态绑死；一个候选都不回 RST 时 discoverRefusingEndpoint 会响亮失败。');
```

- [ ] **Step 8: 编译**

```bash
cd /d/Code/pokergame && pnpm --filter @fight-the-landlord/conformance build
```

期望：无输出。（若报 `REFUSING_HOST` 未定义，说明 `:111` 的旧 import 没删干净。）

- [ ] **Step 9: 验证 GREEN**

```bash
cd /d/Code/pokergame/tools/conformance && node dist/run.js slice-07.2-rpc 2>&1 | tail -12
```

期望：第 5 组三条断言全绿，且 `info` 打印出的端点形如 `127.0.0.1:<随机端口>`（**不是** `172.x`）。

- [ ] **Step 10: 提交**

```bash
cd /d/Code/pokergame
git add tools/conformance/src/lib/rpc.ts tools/conformance/src/slices/slice-07.2-rpc.ts
git commit -m "fix(conformance): 端点发现替代硬编码 172.17.0.1（回 RST 的地址是环境属性）

硬编码的反例有三层（实测）：实际 compose 网关是 172.18.0.1 而非 172.17.0.1；
该地址在本机只给 TIMEOUT 不回 RST；而 127.0.0.1 反而回 RST —— 与 R229 那台
机器的观察**恰好相反**。⇒ 地址与形态不能绑死。

改为运行时发现：候选① 构造的回环端点（bind→close，实测 ECONNREFUSED 2ms），
候选② 运行时解析的 compose 网关（不硬编码项目名）。取第一个回 RST 的；
一个都没有则响亮失败并打印各候选实测形态（不跳过、不假绿）。

两处把「哪种地址回哪种形态」写成事实的注释一并改写 —— 原注释在别的平台上会误导人。
三条断言的判据参数一字未动，只改了一条的消息文案（提示端口被抢占的可能）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 全量验证与收口

**Files:**
- Create: `docs/superpowers/plans/2026-09-18-conformance-windows-neutral-handoff.md`（Linux 交接清单）

**Interfaces:**
- Consumes: Task 1–4 的全部改动
- Produces: Linux 侧人工验证所需的完整清单

- [ ] **Step 1: 机械核对「判据面只动了 5 处」**

> **订正记录（2026-09-18，执行期，Task 3 实测发现）**：本步原设计用
> `grep -E "^[+-].*checks\.(eq|that)\("` 数行 —— **该判据有缺陷**：有一条被判据改动的调用是
> **跨行形态**（`checks.eq(` 与其实参分列不同行），被改的实参行**不含** `checks.eq(`，
> 于是那条改动**数不出来**（实测：应有 3 处却只数到 2 处）。
> ⇒ 改为下面的**跨行感知**核对：按**调用点**对账，而不是按行。

做法分两步：

```bash
cd /d/Code/pokergame
BASE=6fa11a1 HEAD=$(git rev-parse HEAD) node -e '
const {execSync}=require("node:child_process");
const G=(rev,p)=>execSync(`git show ${rev}:${p}`,{encoding:"utf-8"});
const files=["tools/conformance/src/slices/slice-07.2-deploy.ts","tools/conformance/src/slices/slice-07.2-rpc.ts"];
// 抽出一个调用点的实参文本（括号配平，跨行容忍），空白归一化后比较
const extract=(src)=>{const out=[];const re=/checks\.(eq|that)\(/g;let m;
  while((m=re.exec(src))){let i=m.index+m[0].length-1,depth=0,j=i;
    for(;j<src.length;j++){if(src[j]==="(")depth++;else if(src[j]===")"){depth--;if(!depth)break;}}
    out.push(m[1]+"("+src.slice(i+1,j).replace(/\s+/g," ").trim()+")");}
  return out;};
let total=0;
for(const f of files){
  const b=extract(G(process.env.BASE,f)), a=extract(G(process.env.HEAD,f));
  console.log(`\n--- ${f}: ${b.length} → ${a.length} 条调用 ---`);
  const n=Math.max(b.length,a.length); let c=0;
  for(let k=0;k<n;k++) if(b[k]!==a[k]){c++;
    console.log(` [改动 ${c}] #${k}\n   − ${b[k]??"(缺失)"}\n   + ${a[k]??"(缺失)"}`);}
  total+=c; console.log(` 改动条数: ${c}`);
}
console.log(`\n两文件改动调用点合计: ${total}`);
'
```

期望：

- 两个文件的**调用条数前后相同**（本片基线：`slice-07.2-deploy` **51 → 51**、`slice-07.2-rpc` 同数不变）—— 这是「没增删判据」的机械证据
- **改动调用点合计 = 5**，且逐条与「判据面改动清单」对得上：

| # | 调用点 | 期望的改动形态 |
|---|---|---|
| 1 | `checks.eq(empty.status, 1, …)` | 仅消息文案 |
| 2 | `checks.eq(withValue.signal, 'SIGTERM', …)` | ⚠️ **判据参数变**（原 `withValue.status, 124`） |
| 3 | `checks.that(withValue.timedOut, …)` | 仅消息文案 |
| 4 | `checks.that(!empty.timedOut, …)` | 仅消息文案（去残留的 `` `timeout` `` 命令名） |
| 5 | `checks.eq(refused.kind, 'ECONNREFUSED', …)` | 仅消息文案 |

**若合计 ≠ 5，或某条改动不在上表内 ⇒ 停止并归因**，不得放行。
（本片业务上仍**只有 1 处判据参数变化** —— 第 2 处；其余 4 处纯文案。）

- [ ] **Step 2: 全量跑 13 个用例**

```bash
cd /d/Code/pokergame/tools/conformance
: > /tmp/conf-final.log
for c in slice-05 slice-06 slice-07 slice-07.1 slice-08 slice-09 slice-10 slice-11 slice-07.2-security slice-07.2-boundary slice-07.2-hardening slice-07.2-deploy slice-07.2-rpc; do
  out=$(node dist/run.js "$c" 2>&1); rc=$?
  echo "$out" | sed -e 's/\x1b\[[0-9;]*m//g' >> /tmp/conf-final.log
  printf "%-22s rc=%-2s %s\n" "$c" "$rc" "$(echo "$out" | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE '通过|失败' | tail -1 | cut -c1-80)"
done
```

期望：**13/13 全绿**。

- [ ] **Step 3: 处理迭代暴露的新问题（规格 §5.1 的「迭代允许」）**

若 Step 2 有红：**新暴露的平台问题自动纳入本轮范围**（新建 Task 6…N，同规格的中立化原则）。
**若撞上需要裁决的设计问题**（例如某个断言在 Windows 上根本无法等价表达）⇒ 停止，报给用户。
**不得**为了让用例变绿而放宽任何判据。

- [ ] **Step 4: 记录各切片的断言条数**

```bash
grep -a "通过：" /tmp/conf-final.log
```

把 13 条读数抄进交接清单。**甲组**（`05 29 · 06 49 · 07 39 · 07.1 28 · 08 55 · 09 160 · 10 185 · 11 50 · security 43 · boundary 82`）

> ⚠️ **甲组基线的口径订正（执行期，Task 5 实施者实测发现）**：**`slice-06` 的条数不是常量**，
> 而是**随环境状态浮动**：`34 + 5×N`，其中 `N` = 持久化的房间列表长度
> （`room-service` 的 `findAll()` 只过滤 `cancelled` ⇒ 打完的房间仍计数）。
> 实测三点：`N=3→49`、`N=6→64`、`N=15→109`。**该用例源码自 `6fa11a1` 起零改动**，
> 所以这是**本片之前就存在的属性**，不是本片引入的。
> ⇒ 对 `slice-06`，**应当核对公式而不是绝对数**；其余 12 个切片的条数是常量，照常核对。
> 交接清单 §3.1 已按此写明。
应与本片 §0 的 Windows 实测**逐字一致**（判据「条数不变」的现场证据）。

- [ ] **Step 5: 全仓测试与 lint**

```bash
cd /d/Code/pokergame && node_modules/.bin/turbo run test lint --force 2>&1 | tail -8
```

期望：`Tasks: N successful, N total` + `Cached: 0 cached`。

- [ ] **Step 6: 写 Linux 交接清单**

新建 `docs/superpowers/plans/2026-09-18-conformance-windows-neutral-handoff.md`，内容必须含：

1. **要执行的命令**（可直接复制）：起栈 → 跑 13 个用例 → 汇总
2. **三条判据**（全绿 / 条数逐切片对照表 / `checks.*` 5 处调用点对照表）
3. **甲组基线**（Step 4 记录的 13 条读数）
4. **观察项**：`shell: true` 的孤儿进程退化（若出现 180s 超时，留意 `pnpm`/`vitest` 是否残留）
5. **失败归因路径**：若某个 `checks.*` 红，对着第 2 条的表逐行判断「是本次改动引入的，还是环境差异」；
   若是**设计假设不成立**（如 §3.4 的 `ETIMEDOUT` 在 `docker compose run` 上产不出），
   附原始输出回报，不要就地改判据

- [ ] **Step 7: 更新规格状态**

把 `docs/superpowers/specs/2026-09-18-conformance-windows-neutral-design.md` 头部的
`**状态**：设计规格（已过用户逐节评审）→ 待转 writing-plans` 改为
`**状态**：已实施（Windows 侧 13/13 全绿，commit 见下）→ **待用户在 Linux 云服务器人工验证**`，
并补一行指向交接清单。

- [ ] **Step 8: 提交**

```bash
cd /d/Code/pokergame
git add docs/superpowers/plans/2026-09-18-conformance-windows-neutral-handoff.md docs/superpowers/specs/2026-09-18-conformance-windows-neutral-design.md
git commit -m "docs(conformance): Windows 侧收口 + Linux 人工验证交接清单

13/13 全绿；断言条数逐切片与基线一致；判据面改动恰好 5 处调用点（机械核对）。
交接清单含可复制的命令、三条判据、基线读数、孤儿进程观察项与失败归因路径。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾自检（实施者跑完 Task 5 后逐条确认）

- [ ] 跑 Task 5 Step 1 的**跨行感知**核对脚本：两文件 `checks.*` 调用条数前后相同，且**改动调用点合计 = 5**（逐条对得上「判据面改动清单」）。⚠️ 不要用「数含 `checks.eq(` 的行」那种写法 —— 有一条是跨行调用，会漏计。
- [ ] `grep -rn "REFUSING_HOST" tools/conformance/src` = 0 命中
- [ ] `grep -rnE "\b124\b" tools/conformance/src/slices | grep -vE ":\s*(//|\*|/\*)"` = 0 命中
      ⚠️ **口径订正（执行期，Task 5 实施者提出）**：只能查**代码层**的 124。
      `slice-07.2-deploy.ts:477` 的注释**正当地**提到 `status === 124` ——
      它解释的是「判据参数为什么从 124 改掉」，那是**历史陈述**，不是仍在使用的判据。
      把注释也算命中会让本检查**恒不可能通过**（与 `/dev/null` 那条同一类口径问题）。
- [ ] `grep -rnE "'/dev/null'|--env-file /dev/null" tools/conformance/src` = 0 命中
      ⚠️ **口径订正（执行期，Task 2 实施者提出并已被评审确认）**：只能查**用法形态**。
      文档里**解释「为什么不能用 `/dev/null`」的散文**是有意保留的（helper 的 docblock 有 3 处、
      `slice-07.2-deploy.ts:26` 的 ⚠️ 反向告诫 1 处）—— 把散文也当命中会让本检查**恒不可能通过**。
- [ ] `grep -rn "spawnSync('timeout'" tools/conformance/src` = 0 命中
- [ ] `grep -rn "process.platform" tools/conformance/src` = 0 命中（本片-1 的机械证据）
- [ ] 13/13 用例全绿，条数已抄进交接清单
- [ ] 规格状态已更新并指向交接清单
