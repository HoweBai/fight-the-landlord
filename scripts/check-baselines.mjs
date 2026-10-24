#!/usr/bin/env node
// conformance 条数闸：把 runner 的输出与 `tools/conformance/baselines.json` 的**下限**比。
//
// ⚠️ 存在的理由（R115 同族）：CI 里「跑到了但只跑了 1 条」与「切片名写错、一个用例都没跑」
//    都会以**退出码 0** 收场 —— 这条把「跑过了」升级成「跑到足够多条」。
// ⚠️ 本机与 CI **共用同一个脚本**（spec B3③）；CI 里作为**独立一步**。
//
// 用法：
//   node scripts/check-baselines.mjs <render|full> <日志文件>
//   node scripts/check-baselines.mjs --self-test      # 负对照自证（不读任何文件）
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = resolve(HERE, '../tools/conformance/baselines.json');
/** runner 成功时的汇总行（`run.ts`）：`✅ <name> 通过：<N> 项断言，用时 <s>s` */
const SUMMARY = /✅\s+(\S+)\s+通过：(\d+)\s+项断言/g;

/** 剥掉 ANSI 转义（成例：`scripts/ci.sh:56` 的 `run_gate`）。 */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

/** 从日志里取出 `切片名 -> 条数`。重复出现⇒取**最大**（同一日志里同一片跑两次时按最好的算）。 */
export function parseCounts(log) {
  const found = new Map();
  for (const m of stripAnsi(log).matchAll(SUMMARY)) {
    const n = Number(m[2]);
    found.set(m[1], Math.max(found.get(m[1]) ?? 0, n));
  }
  return found;
}

/** 纯函数：给定基线表、模式、实际读数 ⇒ 违规清单（空数组 = 通过）。便于 `--self-test` 直接调。 */
export function violations(baselines, mode, counts) {
  const floor = baselines[mode] ?? {};
  const out = [];
  // ⚠️ 先查**缺席**：基线里列了、日志里没有 ⇒ 那一片根本没跑成（或从 `--list` 掉了）。
  //    少了这条，`| tee` 吞掉退出码时（见 `.github/workflows/conformance.yml` 的 `set -o pipefail`）
  //    **没有任何东西会红** —— 正是本仓 R115 要防的「闸静默地少做」。
  for (const name of Object.keys(floor)) {
    if (!counts.has(name)) out.push(`切片 ${name} 在日志里**缺席**（基线列了它）—— 没跑成，或从 --list 掉了`);
  }
  for (const [name, n] of counts) {
    if (!(name in floor)) {
      out.push(`切片 ${name} 的基线**未回填**（${mode} 列）—— 空着就是空测，先回填再跑`);
      continue;
    }
    if (n < floor[name]) out.push(`切片 ${name}：实测 ${n} < 基线 ${floor[name]}（判据只增不减）`);
  }
  return out;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    // 负对照：四条都要按预期表现 —— 否则本脚本自己就是空测。
    const b = { render: { a: 10 } };
    const cases = [
      ['低于下限必须报错', violations(b, 'render', new Map([['a', 9]])).length === 1],
      ['达到下限必须放行', violations(b, 'render', new Map([['a', 10]])).length === 0],
      // ⚠️ 日志里**带着**基线的 `a`：新加的「缺席」分支先跑，缺了它会多出一条「缺席」违规
      //    （1+1=2 条）⇒ 这条就不再是「恰一条」、测不到「未回填」这个分支。
      ['未回填的切片必须报错', violations(b, 'render', new Map([['a', 10], ['zz', 999]])).length === 1],
      // 第四条（修复轮的负对照）：基线列了 b、日志里没有 ⇒ **恰**一条「缺席」违规。
      // 少了它，上面那条缺席分支就是**没被测过**的代码（删掉也照样全绿）。
      [
        '基线列了、日志缺席的切片必须报错',
        violations({ render: { a: 10, b: 5 } }, 'render', new Map([['a', 10]])).length === 1,
      ],
    ];
    let bad = 0;
    for (const [what, ok] of cases) {
      console.log(`${ok ? '✅' : '❌'} self-test：${what}`);
      if (!ok) bad = 1;
    }
    process.exitCode = bad;
    return;
  }
  const [mode, logPath] = argv;
  if (!mode || !logPath || !['render', 'full'].includes(mode)) {
    console.error('用法：node scripts/check-baselines.mjs <render|full> <日志文件>');
    process.exitCode = 2;
    return;
  }
  const counts = parseCounts(readFileSync(logPath, 'utf8'));
  if (counts.size === 0) {
    console.error(`❌ 日志里**一条**「✅ <name> 通过：N 项断言」都没有 —— 切片根本没跑成（${logPath}）`);
    process.exitCode = 1;
    return;
  }
  const bad = violations(JSON.parse(readFileSync(BASELINES, 'utf8')), mode, counts);
  for (const [name, n] of counts) console.log(`[baseline] ${mode} ${name} = ${n}`);
  if (bad.length > 0) {
    for (const line of bad) console.error(`❌ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`=== [baseline] ${mode} 全部 ≥ 下限（${counts.size} 个切片）===`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
