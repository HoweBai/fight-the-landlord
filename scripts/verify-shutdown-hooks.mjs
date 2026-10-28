#!/usr/bin/env node
/**
 * 优雅停机源码闸：8 个 Nest 服务必须在 bootstrap 里
 * `app.enableShutdownHooks(undefined, { useProcessExit: true })`。
 *
 * ① `enableShutdownHooks`：SIGTERM 默认直接杀进程 ⇒ OnApplicationShutdown 永不执行；
 *    这一半管的是「钩子跑不跑」（spec 2026-10-27 D16）。
 * ② `useProcessExit`（2026-10-28 真栈实测补）：容器里 node 是 **PID 1** —— Nest 关停钩子
 *    跑完后默认「重发信号」（`process.kill(process.pid, signal)` 自杀），而**无处理器的信号
 *    对 PID 1 会被内核丢弃** ⇒ 进程关完也不退（实测：SIGTERM 后 >60s 仍 Running、3002 已关、
 *    9002 仍应答；compose 只能 10s 后 SIGKILL、k8s 会吃满 terminationGracePeriod）。
 *    这一半管的是「关完了到底退不退」—— 缺它，优雅停机只完成前半段。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('packages')
  .map((p) => join('packages', p, 'src', 'main.ts'))
  .filter((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });

const missingHooks = [];
const missingExit = [];
for (const p of files) {
  const text = readFileSync(p, 'utf8');
  if (!text.includes('enableShutdownHooks(')) {
    missingHooks.push(p);
  } else if (!/enableShutdownHooks\([\s\S]{0,200}?useProcessExit:\s*true/.test(text)) {
    missingExit.push(p);
  }
}

if (missingHooks.length) {
  console.error(
    `❌ 缺 enableShutdownHooks(...)（${missingHooks.length}）：\n${missingHooks.map((p) => `  - ${p}`).join('\n')}`,
  );
}
if (missingExit.length) {
  console.error(
    `❌ enableShutdownHooks 未带 useProcessExit: true（${missingExit.length}）—— PID 1 的重发信号会被丢弃，进程关完不退：\n` +
      missingExit.map((p) => `  - ${p}`).join('\n'),
  );
}
if (missingHooks.length || missingExit.length) process.exit(1);
console.log(`✅ ${files.length} 个服务均启用优雅停机（含 useProcessExit）`);
