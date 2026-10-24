/**
 * 「自证式探针」的共享助手（独立小片 P5 / Task 5）。
 *
 * 本仓对「判据的判别力必须自证」有硬要求（R115）：
 * **断言「没发生」之前，先证明探针能观测到「发生」。** 对源码级闸（§12.4 / §13.3）来说，
 * 「能观测到发生」的唯一可靠形态就是**注入一个必然违规的东西、看闸是否红**：
 *
 *   - 向 `apps/client/src` 注入一个含 `baseScore = 100` 的文件 ⇒ `source-boundary` **必须红**；
 *   - 向 `packages/shared/src/rule` 注入一个未映射的 `throw new Error(…)` ⇒ `rule-error-mapping` **必须红**；
 *   - 把 `packages/shared/vitest.config.ts` 的 `thresholds.lines` 临时改成 `99` ⇒ `test:coverage` **必须非零退出**。
 *
 * 三条都**改动了工作区**，所以「恢复」不是收尾动作而是判据的一部分（本片 DoD 逐字要求
 * 「删除的所有临时文件/一次性容器都已清理」）。这里把恢复做在**三个层次**上：
 *   1. 调用方在 `try/finally` 里显式 `restorePath()`，随后**断言**文件已回到原状；
 *   2. `process.on('exit')` 兜底（`run.js` 的失败路径会 `process.exit`，那**不会**执行 finally）；
 *   3. `SIGINT`/`SIGTERM`/`SIGHUP` 处理器（门禁给每条切片套了 `timeout`
 *      —— 被 `timeout` 杀掉时默认**不**触发 `exit` 事件）。
 *
 * ⚠️ 恢复一律用**原始字符串备份**（读文件得到的 `before`），不是「重新拼写一遍」：
 * 重新拼写会在源文件被同步改动时**静默写成另一个文件**（R150 的同族：判据/恢复动作
 * 必须作用于它真正读到的那个对象）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

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
 * ⚠️ **已知退化**（`shell: true` 的固有代价，两个平台都适用；之所以单列，是因为它**改变了
 * Linux 的既有行为**）：`shell: true` 下 `timeout` 杀掉的**只是外壳进程**，
 * 其子进程（`pnpm` → `vitest`）**不会被连带杀死** —— Windows 上杀掉 `cmd.exe` 同样不会
 * 杀掉它起的 `node`/`vitest`。⇒ 超时时可能留下孤儿。
 * 走到超时已说明该次运行是坏的，故接受；已在规格 §5.2 登记为 Linux 侧的观察项。
 */
export function runProc(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): ProcResult {
  // ⚠️ 整串命令形态（不是 `spawnSync(cmd, args, {shell:true})`）：后者在 Node ≥22.9 上
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
    // （实测两者都是 null）。实测三态：正常 `status=0` / 超时 `status=null error=ETIMEDOUT` /
    // 起不来 `status=null error=ENOENT` ⇒ 只有读 `error.code` 才分得开。
    // 注：`@types/node` 把 `SpawnSyncReturns.error` 标成 `Error`（无 `code`），运行时实为
    // `ErrnoException` ⇒ 按 `NodeJS.ErrnoException` 收窄以读到 `code`。
    timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    output: `${String(res.stdout ?? '')}${String(res.stderr ?? '')}`,
  };
}

/** 待恢复项：`null` = 该路径**原本不存在**（恢复 = 删除它）。 */
const pendingRestores = new Map<string, string | null>();
let hooksInstalled = false;

/** 兜底恢复：只做同步 IO（退出路径上不能用 Promise）。 */
function restoreAll(): void {
  for (const [path, before] of [...pendingRestores.entries()]) {
    try {
      if (before === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        writeFileSync(path, before);
      }
    } catch {
      // 退出路径上尽力而为 —— 显式恢复（下面那些函数）才是判据。
    }
    pendingRestores.delete(path);
  }
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', restoreAll);
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    process.on(signal, () => {
      restoreAll();
      // eslint-disable-next-line no-console
      console.error(`\n⚠️ conformance 收到 ${signal}：已把探针注入/变异的文件恢复原状（退出码 ${code}）`);
      process.exit(code);
    });
  }
}

/**
 * 创建**探针自己的**临时文件（`finally` 里用 `restorePath` 删掉）。
 *
 * ⚠️ 目标路径**已存在**时直接抛错：探针绝不允许覆盖别人的文件（本片的注入面是
 * `apps/client/src` 与 `packages/shared/src/rule`，两者都是产品源码树）。
 */
export function createTempFile(path: string, content: string): void {
  installHooks();
  if (existsSync(path)) {
    throw new Error(`探针拒绝覆盖已存在的文件：${path}（请换一个只属于自己的临时文件名）`);
  }
  pendingRestores.set(path, null);
  writeFileSync(path, content);
}

/** 变异前**读**出原始内容并登记恢复（返回原文，调用方用它做「恢复成功」的断言）。 */
export function backupForMutation(path: string): string {
  installHooks();
  const before = readFileSync(path, 'utf-8');
  if (!pendingRestores.has(path)) pendingRestores.set(path, before);
  return before;
}

/** 显式恢复一个路径（删除临时文件，或写回原始内容）。没有待恢复项时是 no-op。 */
export function restorePath(path: string): void {
  const before = pendingRestores.get(path);
  if (before === undefined) return;
  if (before === null) {
    if (existsSync(path)) unlinkSync(path);
  } else {
    writeFileSync(path, before);
  }
  pendingRestores.delete(path);
}

/** 当前还有几个路径没恢复（自证：跑完应当为 0）。 */
export function pendingRestoreCount(): number {
  return pendingRestores.size;
}

/** 读文件的 UTF-8 文本（判据里的「读配置，不是读运行结果」用它）。 */
export function readText(path: string): string {
  return readFileSync(path, 'utf-8');
}
