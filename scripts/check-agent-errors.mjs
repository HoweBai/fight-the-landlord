#!/usr/bin/env node
/**
 * 代理门户前端 ERROR_TEXT ↔ 后端 ErrCode 同步闸（零依赖 Node 脚本）。
 *
 * agent/app.js 的 ERROR_TEXT 对象每个 code 必须在 protocol/src/errors.ts
 * 的 ErrCode 枚举里真实存在 —— 防止后端删/改错误码后前端静默残留
 * 无人维护的文案条目，同时防止前端新增文案却引用不存在的码值。
 *
 * 用法：node scripts/check-agent-errors.mjs [repoRoot]
 * 退出码 0 = OK，1 = 发现不一致。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontCodes(src) {
  // ERROR_TEXT = { 11006: '...', 11007: '...', ... }
  const m = src.match(/ERROR_TEXT\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) throw new Error('ERROR_TEXT object not found in agent/app.js');
  const out = new Set();
  for (const pair of m[1].split(',')) {
    const key = pair.trim().match(/^(\d+)\s*:/);
    if (key) out.add(key[1]);
  }
  return out;
}

function parseBackendCodes(src) {
  // ErrCode = { BAD_PARAM: 40000, UNAUTHENTICATED: 40100, AGENT_...: 14011, ... }
  const out = new Set();
  const m = src.match(/export\s+(enum|const)\s+ErrCode[\s\S]*?\{([\s\S]*?)\n\s*\}/);
  if (!m) throw new Error('ErrCode enum/const not found in protocol/src/errors.ts');
  for (const line of m[2].split('\n')) {
    const kv = line.match(/\s+(\w+)\s*=\s*(\d+)\s*,?/);
    if (kv) out.add(kv[2]);
  }
  return out;
}

export function checkAgentErrors(repoRoot = repo) {
  const front = readFileSync(resolve(repoRoot, 'agent/app.js'), 'utf-8');
  const back = readFileSync(resolve(repoRoot, 'packages/protocol/src/errors.ts'), 'utf-8');
  const frontCodes = parseFrontCodes(front);
  const backCodes = parseBackendCodes(back);

  const missing = []; // 前端引用了、但后端已删
  for (const code of frontCodes) {
    if (!backCodes.has(code)) missing.push(code);
  }

  return { frontCodes: [...frontCodes].sort(), backCodes: [...backCodes].sort(), missing };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  // 直接执行
  const result = checkAgentErrors();
  if (result.missing.length > 0) {
    console.error('❌ agent/app.js ERROR_TEXT 引用了不存在的 ErrCode：', result.missing.join(', '));
    console.error('   请从 ERROR_TEXT 删除这些条目（后端已删/改对应码值）。');
    process.exit(1);
  }
  console.log(
    `✓ agent/app.js ERROR_TEXT (${result.frontCodes.length}) 与 protocol ErrCode 枚举 — 同步 OK`,
  );
}
