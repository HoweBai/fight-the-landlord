/**
 * 一次性生成 `apps/client/src/pages/table/static/cards/manifest.json`（R702）。
 *
 * ⚠️ **产物是数据、入库**；本脚本只是生成器，跑一次即可（生成器留下是为了
 * 「换了一批图」时能重跑，而不是每次构建都跑）。
 *
 * ⚠️ 输出目录 = **牌桌分包**（`src/pages/table/static/cards/`）—— 2026-10-12 项 6
 * 分包后牌面随 table 分包走。旧路径 `src/static/cards/` 已废弃：若哪天有人把这里
 * 改回去，重跑会**造出幽灵目录**（产物在产物里 404，源里多一份没人看的 manifest）。
 *
 * 键 = `{s}-{r}`（承 R696），值 = 文件名；外加一个保留键 `back`。
 * 键名 `back` 与 `{s}-{r}` 形状不冲突（`s` 是 0–4、`r` 是数字）⇒ 不会撞。
 *
 * 用法：`node scripts/gen-card-manifest.mjs`（在仓库根跑）
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';

/** 花色：与 protocol 的 `s` **逐位一致**（♠0 ♥1 ♣2 ♦3 王4）。 */
const SUIT = { Spade: 0, Heart: 1, Club: 2, Square: 3 };
/** 点数：DouZero 编码（R695，全系统唯一）。`One` = A = 14；`Two` = 2 = **17**（不是 15）。 */
const RANK = {
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
  Ten: 10,
  Jack: 11,
  Queen: 12,
  King: 13,
  One: 14,
  Two: 17,
};

const out = { back: 'CardBack.png' };
for (const file of readdirSync('resources/Poker').filter((f) => f.endsWith('.png'))) {
  if (file === 'CardBack.png') continue;
  if (file === 'BigJoker.png') {
    out['4-30'] = file;
    continue;
  }
  if (file === 'LittleJoker.png') {
    out['4-20'] = file;
    continue;
  }
  const m = /^([A-Z][a-z]+)([A-Z][a-z]+)\.png$/.exec(file);
  if (!m) throw new Error(`未知文件名：${file}`);
  const s = SUIT[m[1]];
  const r = RANK[m[2]];
  if (s === undefined || r === undefined) throw new Error(`未知花色/点数：${file}`);
  out[`${s}-${r}`] = file;
}

/** 稳定排序：`back` 最前，其余按 (花色, 点数) 数值序 —— 让 diff 可读。 */
const sorted = Object.fromEntries(
  Object.keys(out)
    .sort((a, b) => {
      if (a === 'back') return -1;
      if (b === 'back') return 1;
      const [as, ar] = a.split('-').map(Number);
      const [bs, br] = b.split('-').map(Number);
      return as - bs || ar - br;
    })
    .map((k) => [k, out[k]]),
);

const OUT_DIR = 'apps/client/src/pages/table/static/cards';
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/manifest.json`, `${JSON.stringify(sorted, null, 2)}\n`);
console.log('entries =', Object.keys(sorted).length);
