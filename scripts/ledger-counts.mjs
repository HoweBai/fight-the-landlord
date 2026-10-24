#!/usr/bin/env node
/**
 * 对账表 §0 的机械校验（`docs/superpowers/plans/deviation-ledger.md`）。
 *
 * 为什么需要它：§0 的「总览」是**手抄**的统计，而 §1.1–§1.5 才是真源 —— 切片 7.2 收口时
 * 实测过一次漂移：C 区实际 27 行（C1–C28 去掉已撤销的 C21），§0 却写着 26，连带「合计 61 /
 * 仍开放 21」全错（真实是 62 / 22）。这种错误不会让任何测试变红，只会让下一个读表的人算错进度。
 *
 * 用法：
 *   node scripts/ledger-counts.mjs            # 打印逐区分布；与 §0 不一致时退出码 1
 *   node scripts/ledger-counts.mjs --write    # 打印建议的 §0 行（人工粘贴，不自动改文件）
 *
 * 设计约定（与 ledger §5 的维护约定一致）：
 *   - 只认 `### 1.x` 小节里的表格行，且第一列必须形如 `C12`/`S4`/`N10`（大写字母 + 数字）；
 *   - 判定只认四个值：已关闭 / 部分关闭 / 仍开放 / 文档过期；出现别的值就报错（口径漂移）；
 *   - 不改文件：`--write` 只**打印**建议行，避免脚本把表格改坏。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEDGER = fileURLToPath(new URL('../docs/superpowers/plans/deviation-ledger.md', import.meta.url));

/** §1.x 小节 → §0 里的区名关键字。 */
const SECTIONS = [
  { section: '1.1', key: 'C1–C28', title: '正确性类 C1–C28（C21 已撤销，不计）' },
  { section: '1.2', key: 'E1–E10', title: '工程类 E1–E10' },
  { section: '1.3', key: 'S1–S8', title: '安全类 S1–S8' },
  { section: '1.4', key: 'A1–A8', title: '架构类 A1–A8' },
  { section: '1.5', key: 'N 系列', title: '新增 N 系列' },
];

const VERDICTS = ['已关闭', '部分关闭', '仍开放', '文档过期'];
const strip = (s) => s.replace(/\*\*/g, '').trim();
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const lines = readFileSync(LEDGER, 'utf-8').split('\n');

/** 逐行解析 §1.x 的表格。 */
const parsed = Object.fromEntries(SECTIONS.map((s) => [s.section, []]));
let current = null;
for (const line of lines) {
  const heading = /^### (1\.\d) /.exec(line);
  if (heading) {
    current = heading[1];
    continue;
  }
  if (line.startsWith('## ')) current = null;
  if (!current || !parsed[current] || !line.startsWith('|')) continue;

  const cells = cellsOf(line);
  if (cells.length < 3) continue;
  const id = strip(cells[0]);
  if (!/^[A-Z]\d+$/.test(id)) continue;

  const verdict = strip(cells[1]);
  if (!VERDICTS.includes(verdict)) {
    console.error(`❌ ${current} 的 ${id} 判定值非法：「${verdict}」（只允许 ${VERDICTS.join(' / ')}）`);
    process.exit(1);
  }
  parsed[current].push({ id, verdict });
}

/** 统计。 */
const count = (rows) => {
  const out = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const { verdict } of rows) out[verdict] += 1;
  return out;
};

const actual = SECTIONS.map((s) => ({ ...s, rows: parsed[s.section], counts: count(parsed[s.section]) }));
const total = VERDICTS.reduce((acc, v) => acc + actual.reduce((n, s) => n + s.counts[v], 0), 0);
const totalCounts = Object.fromEntries(VERDICTS.map((v) => [v, actual.reduce((n, s) => n + s.counts[v], 0)]));

console.log('§1.x 实际分布（真源）：');
for (const s of actual) {
  const c = s.counts;
  console.log(
    `  ${s.section} ${s.title}: 条数=${s.rows.length}  ` +
      `已关闭=${c['已关闭']} 部分关闭=${c['部分关闭']} 仍开放=${c['仍开放']} 文档过期=${c['文档过期']}`,
  );
}
console.log(`  合计: 条数=${total}  已关闭=${totalCounts['已关闭']} 部分关闭=${totalCounts['部分关闭']} 仍开放=${totalCounts['仍开放']} 文档过期=${totalCounts['文档过期']}`);

/** 解析 §0 的总览表（在「## 0. 总览」与下一个 `## ` 之间）。 */
const start = lines.findIndex((l) => l.startsWith('## 0. '));
if (start < 0) {
  console.error('\n❌ 找不到 §0 总览小节');
  process.exit(1);
}
const zero = [];
for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i += 1) {
  if (!lines[i].startsWith('|')) continue;
  const cells = cellsOf(lines[i]).map(strip);
  if (cells.length < 6) continue;
  const nums = cells.slice(1, 6).map((n) => Number(n));
  if (nums.some((n) => Number.isNaN(n))) continue; // 表头/分隔行
  zero.push({ label: cells[0], nums });
}

/** 逐区对账。 */
let bad = 0;
for (const s of actual) {
  const row = zero.find((z) => z.label.includes(s.key));
  if (!row) {
    console.log(`⚠️  §0 里找不到「${s.key}」那一行（区名关键字变了？）`);
    bad += 1;
    continue;
  }
  const want = [s.rows.length, ...VERDICTS.map((v) => s.counts[v])];
  if (row.nums.join(',') !== want.join(',')) {
    console.log(`❌ §0 的「${row.label}」与 §1.x 不一致：表里是 [${row.nums.join(', ')}]，应为 [${want.join(', ')}]`);
    bad += 1;
  }
}
const totalRow = zero.find((z) => z.label.includes('合计'));
const wantTotal = [total, ...VERDICTS.map((v) => totalCounts[v])];
if (!totalRow) {
  console.log('⚠️  §0 里找不到「合计」行');
  bad += 1;
} else if (totalRow.nums.join(',') !== wantTotal.join(',')) {
  console.log(`❌ §0 的「合计」与 §1.x 不一致：表里是 [${totalRow.nums.join(', ')}]，应为 [${wantTotal.join(', ')}]`);
  bad += 1;
}

if (process.argv.includes('--write')) {
  console.log('\n建议的 §0 行（人工粘贴）：');
  for (const s of actual) {
    const c = s.counts;
    console.log(`| ${s.title} | ${s.rows.length} | ${c['已关闭']} | ${c['部分关闭']} | ${c['仍开放']} | ${c['文档过期']} |`);
  }
  console.log(
    `| **合计** | **${total}** | **${totalCounts['已关闭']}** | **${totalCounts['部分关闭']}** | ` +
      `**${totalCounts['仍开放']}** | **${totalCounts['文档过期']}** |`,
  );
}

if (bad > 0) {
  console.log(`\n❌ §0 与 §1.x 有 ${bad} 处不一致（§1.x 是真源；用 --write 拿建议行后人工更新 §0）`);
  process.exit(1);
}
console.log('\n✅ §0 与 §1.x 逐区一致');
