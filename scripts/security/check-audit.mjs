#!/usr/bin/env node
// 依赖漏洞门（M0.1 · 规格 v3 §2.1；被 slice-07.4-pipeline 的 C3 按执行语句提取断言）。
// ⚠️ 本文件的文本是判据面——三处结构不得擅动（改动 = 同提交改 C3）：
//   ① spawnSync 的【数组实参字面量】token 恰好 = ['audit','--prod','--json','--registry','https://registry.npmjs.org']
//      （不得抽常量——C3 提取的是字面量）；
//   ② 等级集合必须逐字 `const LEVELS = ['critical', 'high'];`（引号与次序都是判据的一部分）；
//   ③ 全文（剥注释后）不得出现禁旗标串。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const EXCEPTIONS_PATH = 'scripts/security/audit-exceptions.json';

const LEVELS = ['critical', 'high'];

/** 形状断言（fail-closed）：注册表故障/输出格式变化都在这拦下。返回错误消息（空数组 = 形状 OK）。 */
export function shapeViolations(rawStdout) {
  let parsed;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return ['stdout 不是合法 JSON（注册表故障或输出格式变化）'];
  }
  if (parsed === null || typeof parsed !== 'object') return ['顶层不是对象'];
  if (parsed.error) return [`audit 端点返回错误：${JSON.stringify(parsed.error).slice(0, 300)}`];
  if (typeof parsed.advisories !== 'object' || parsed.advisories === null) return ['advisories 缺失或非对象'];
  if (typeof parsed.metadata?.vulnerabilities !== 'object' || parsed.metadata?.vulnerabilities === null) {
    return ['metadata.vulnerabilities 缺失或非对象'];
  }
  return [];
}

/** 违例 = levels 级通告 − 豁免集（匹配语义 = (id, module) 精确对；id 为数字）。 */
export function violations(advisories, exemptions, levels = LEVELS) {
  const exempt = new Set(exemptions.map((e) => `${e.id}|${e.module}`));
  return Object.values(advisories)
    .filter((a) => levels.includes(a.severity))
    .filter((a) => !exempt.has(`${a.id}|${a.module_name}`))
    .map((a) => `${a.severity} ${a.module_name} id=${a.id} ${String(a.title).slice(0, 80)}`);
}

/** 陈腐 = 豁免集里已不再被报出的条目（须删掉）。 */
export function staleExemptions(advisories, exemptions) {
  const present = new Set(Object.values(advisories).map((a) => `${a.id}|${a.module_name}`));
  return exemptions.filter((e) => !present.has(`${e.id}|${e.module}`)).map((e) => `${e.id}|${e.module}`);
}

/** --self-test：合成输入喂同一批纯函数（规格 C26–C31 = 负①–⑤ + 正①）。 */
function selfTest() {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const adv = (list) => Object.fromEntries(list.map((a, i) => [String(i + 1), a]));
  // 负① 形状断言四种坏形态
  ok(shapeViolations('not json').length > 0, '负①a 非 JSON 必须判形状错');
  ok(shapeViolations('{"error":{"code":"X"}}').length > 0, '负①b error 形态必须判形状错');
  ok(shapeViolations('{"metadata":{"vulnerabilities":{}}}').length > 0, '负①c advisories 缺失必须判形状错');
  ok(shapeViolations('{"advisories":{},"metadata":{"vulnerabilities":null}}').length > 0, '负①d vulnerabilities=null 必须判形状错');
  // 负② 未登记 high（默认 LEVELS）⇒ 违例非空
  ok(violations(adv([{ id: 1, module_name: 'x', severity: 'high', title: 't' }]), []).length === 1, '负② 未登记 high 必须被抓');
  // 负③ 陈腐豁免
  ok(staleExemptions(adv([{ id: 1, module_name: 'x', severity: 'low', title: 't' }]), [{ id: 9, module: 'gone' }]).length === 1, '负③ 陈腐豁免必须被抓');
  // 负④ 机制对偶：levels 参数生效 + 默认 LEVELS 完整性守卫（有人摘掉 high ⇒ 负④b 红）
  ok(violations(adv([{ id: 1, module_name: 'x', severity: 'high', title: 't' }]), [], ['critical']).length === 0, '负④a levels=[critical] 时应放行 high（参数生效）');
  ok(violations(adv([{ id: 1, module_name: 'x', severity: 'high', title: 't' }]), []).length === 1, '负④b 默认 LEVELS 必须含 high');
  // 负⑤ 豁免按 module 泛化不生效（同 module 异 id 不得被放）
  ok(violations(adv([{ id: 2, module_name: 'vite', severity: 'high', title: 't' }]), [{ id: 1, module: 'vite' }]).length === 1, '负⑤ 同 module 异 id 不得被豁免');
  // 正① 通告集只剩豁免条目 ⇒ 判齐
  const ex = [{ id: 1, module: 'vite' }];
  ok(violations(adv([{ id: 1, module_name: 'vite', severity: 'high', title: 't' }]), ex).length === 0, '正① 豁免条目必须判齐');
  ok(staleExemptions(adv([{ id: 1, module_name: 'vite', severity: 'high', title: 't' }]), ex).length === 0, '正①b 陈腐必须为空');
  if (fails.length) {
    console.error('❌ check-audit --self-test 失败：');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✅ check-audit --self-test：负①–⑤ + 正① 全部按预期');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const exemptions = JSON.parse(readFileSync(resolve(REPO_ROOT, EXCEPTIONS_PATH), 'utf8'));
  const res = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['audit', '--prod', '--json', '--registry', 'https://registry.npmjs.org'], // ⚠️ C3①：数组实参字面量——改动此数组须同提交改 C3
    { cwd: REPO_ROOT, shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const shape = shapeViolations(res.stdout ?? '');
  if (shape.length) {
    console.error('❌ audit 输出形状异常（注册表故障或格式变化）：');
    for (const s of shape) console.error('  - ' + s);
    process.exit(1);
  }
  const parsed = JSON.parse(res.stdout);
  const stale = staleExemptions(parsed.advisories, exemptions);
  if (stale.length) {
    console.error('❌ 豁免条目已不再被报出，请从 audit-exceptions.json 删除：');
    for (const s of stale) console.error('  - ' + s);
    process.exit(1);
  }
  const v = violations(parsed.advisories, exemptions);
  if (v.length) {
    console.error(`❌ ${v.length} 条 ${LEVELS.join('/')} 通告未处理：`);
    for (const x of v) console.error('  - ' + x);
    process.exit(1);
  }
  console.log(`✅ 依赖漏洞门：${Object.keys(parsed.advisories).length} 条去重通告，未处理 ${LEVELS.join('/')} 级 0 条（豁免 ${exemptions.length} 条）`);
}

main();
