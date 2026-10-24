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
