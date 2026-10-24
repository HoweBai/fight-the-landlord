/**
 * `docker compose exec -T redis redis-cli …` 的共享助手（conformance 的**只读** Redis 探针）。
 *
 * 为什么要抽出来：`slice-07.2-rpc` 第 2 组（池索引自洽性）、`slice-11` 第 5 组（池闭环）、
 * `slice-07.2-hardening` 第 10 步（N9：`room:{code}` 是 Hash）都要读同一批键。
 * 三处各自手写一份 `spawnSync` 会把「`-T` 不能省」「错误走 **stdout** 且退出码仍是 0」
 * 这些**实测**到的细节复制三遍（少一处就是一个难定位的假红/假绿）。
 *
 * ⚠️ 三条实测细节（写死在助手层，调用方不必再记）：
 *  1. **`-T` 必须有**（不分配 TTY；无 TTY 环境下缺它会挂住）；
 *  2. **服务端错误回复**（`WRONGTYPE …` / `ERR …`）走 **stdout**、退出码 **0**
 *     ⇒ 「命令失败」与「Redis 报错」是两件不同的事，`redisRaw()` 两者都交给调用方，
 *     `redisCli()` 只在**退出码非 0**（连不上/容器不在）时抛错；
 *  3. 输出一律 `trim`（`docker compose exec` 在部分实现里给每行补 `\r`）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ConformanceError } from './assert';

/** 仓库根（`dist/lib/*.js` 与 `dist/slices/*.js` 同深度 ⇒ 同一个相对路径；R179）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

export interface RedisReply {
  /** `redis-cli` 的退出码（`null` = 被信号/超时杀掉）。 */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 原始探针：**不抛错**，把退出码与两路输出都交给调用方（要观测 Redis 的错误回复时用它）。 */
export function redisRaw(args: string[]): RedisReply {
  const res = spawnSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/**
 * 「Redis 服务端回了什么」的**原文**（stdout 优先，回落 stderr）——
 * 成功回复是值/`OK`，失败回复是 `WRONGTYPE …` / `ERR …`。
 */
export function redisReplyText(reply: RedisReply): string {
  return (reply.stdout.trim() || reply.stderr.trim()).trim();
}

/** 只读探针：**退出码非 0** 时抛错（那是「redis-cli 根本没跑起来」，不是 Redis 的语义回复）。 */
export function redisCli(args: string[]): string {
  const reply = redisRaw(args);
  if (reply.status !== 0) {
    throw new ConformanceError(
      `redis-cli ${args.join(' ')} 失败（退出码 ${reply.status}）：` +
        `${redisReplyText(reply) || '（无输出）'}`,
    );
  }
  return reply.stdout;
}

/** 一行一个值的回复（`HKEYS` / `ZRANGE` / `--scan`）。 */
export function redisLines(args: string[]): string[] {
  return redisCli(args)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
