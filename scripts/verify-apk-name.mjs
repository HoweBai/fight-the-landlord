#!/usr/bin/env node
/**
 * APK 下载文件名闸（2026-11-02）。
 *
 * 背景：线上下载链接曾是 `/download/优比棋牌.apk` —— 中文路径在聊天软件/部分浏览器里会被
 * 截断成 `/download`（点不进安装包）。自本片起文件名统一为 ASCII，并且**只有一处真源**：
 * `scripts/deploy/apk-name.txt`。本闸防止四个消费者（打包 / 发布 / CI / 预览）再各自硬编码，
 * 改一处漏一处。
 *
 * 判据：
 * ① 真源必须是纯小写 ASCII 的 `*.apk`；
 * ② 打包、发布、CI、预览四个消费者必须读真源，不得写死文件名；
 * ③ 关键链路里不得再出现中文 `*.apk` 字面量。
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const fail = [];

const name = read('scripts/deploy/apk-name.txt').trim();
if (!/^[a-z0-9][a-z0-9._-]*\.apk$/.test(name)) {
  fail.push(`真源 scripts/deploy/apk-name.txt 不是小写 ASCII 的 *.apk：${JSON.stringify(name)}`);
}

for (const [file, label] of [
  ['scripts/deploy/pack-apk.sh', '打包'],
  ['scripts/deploy/publish-apk.sh', '发布'],
  ['.github/workflows/images.yml', 'CI'],
  ['scripts/deploy/preview.sh', '预览'],
]) {
  if (!read(file).includes('apk-name.txt')) {
    fail.push(`${label}（${file}）未从 scripts/deploy/apk-name.txt 读取文件名`);
  }
}

for (const file of [
  'scripts/deploy/pack-apk.sh',
  'scripts/deploy/preview.sh',
  '.github/workflows/images.yml',
]) {
  const hit = read(file).match(/[一-鿿][^\s"'`]*\.apk/);
  if (hit) fail.push(`${file} 仍出现中文 *.apk 字面量：${hit[0]}`);
}

const readme = read('deploy/download/README.md');
if (!readme.includes(name)) fail.push(`deploy/download/README.md 未记录当前文件名 ${name}`);
if (!readme.includes('apk-name.txt')) fail.push('deploy/download/README.md 未说明文件名真源');

if (fail.length) {
  for (const f of fail) console.error(`❌ ${f}`);
  console.error(`\n当前真源值：${JSON.stringify(name)}`);
  process.exit(1);
}
console.log(
  `✅ APK 下载文件名真源 = ${name}；打包/发布/CI/预览四处消费一致，关键链路无中文 *.apk`,
);
