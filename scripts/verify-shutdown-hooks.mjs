#!/usr/bin/env node
/**
 * 优雅停机源码闸：8 个 Nest 服务必须在 bootstrap 里调用 enableShutdownHooks()。
 * SIGTERM 默认直接杀进程 ⇒ OnApplicationShutdown 永不执行；k8s 滚动/缩容会硬断连接。
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

const bad = files.filter((p) => !readFileSync(p, 'utf8').includes('enableShutdownHooks()'));
if (bad.length) {
  console.error(`❌ 缺 enableShutdownHooks()（${bad.length}）：\n${bad.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`✅ ${files.length} 个服务均启用优雅停机`);
