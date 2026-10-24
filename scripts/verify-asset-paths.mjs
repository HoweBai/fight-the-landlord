#!/usr/bin/env node
/**
 * 产物级素材路径闸：**产物里发出去的素材路径，都必须在产物里真的存在**。
 *
 * ## 它补的是哪条缝
 *
 * 牌面接入有三层验证，本仓各有落点：
 *  ① **src 算对了** ⇒ `apps/client/test/card-hand-interaction.test.ts`（jsdom）；
 *  ② **产物的路径⇔文件对得上** ⇒ 本脚本；
 *  ③ **浏览器里真的画出来了** ⇒ 真浏览器探针 / App 走查。
 *
 * ②**不能**由 ① 顶替：jsdom **不加载图片**、也不跑构建 —— 一个拼错的路径、
 * 一个被 Vite 哈希过的名字、一个漏拷的文件，在 ① 里**全都是绿的**。
 * 这正是本仓第①份总结的「三种 `tsc` 看不见的逃逸口」在本片的形态。
 *
 * ⚠️ **本脚本仍不能证明图看得见**（那需要真浏览器/真机）。差别要如实说，别当走查用。
 *
 * ## ⚠️ 一条实测教训（本脚本第一版栽在这里）
 *
 * 牌面 URL 是**运行期拼出来的**：`Card.vue` 发的是 `` tableAsset(`cards/${file}`) ``
 * （= `/pages/table/static/cards/` + 文件名；2026-10-12 项 6 分包后随牌桌分包走），
 * `file` 来自 `manifest.json`（当模块 import 进包）。所以产物里只有**基址**、
 * **没有** `/pages/table/static/cards/SpadeThree.png` 这种**完整字面量**
 * —— 按字面量扫，一张牌面都扫不到，而闸会「零违规」地**全绿**（正是本仓最怕的那种假绿）。
 *
 * ⇒ 本脚本因此分两条腿：
 *  · **字面量腿**：扫产物里出现的完整静态 URL（**两族**：主包 `/static/...` 与
 *    牌桌分包 `/pages/table/static/...`；CSS 的 `url()`、静态字符串就是这种）；
 *  · **清单腿**：**把 manifest 的每个值逐个绑回产物文件** —— 牌面走的是这条腿。
 * 两条腿都要跑，且各自有自证判据（见下）。
 *
 * ## 用法
 *
 * ```bash
 * pnpm --filter @fight-the-landlord/client build:h5
 * node scripts/verify-asset-paths.mjs            # 默认校验 dist/build/h5
 * node scripts/verify-asset-paths.mjs --dir <产物根>
 * ```
 *
 * ⚠️ **产物不存在时非零退出**（不是跳过）—— 一条「因为没跑过所以恒绿」的判据，
 * 正是本仓反复付代价的那种假绿。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const dirFlag = process.argv.indexOf('--dir');
const DIST =
  dirFlag >= 0 ? process.argv[dirFlag + 1] : join(ROOT, 'apps', 'client', 'dist', 'build', 'h5');

if (!existsSync(DIST)) {
  console.error(`!!! 产物目录不存在：${DIST}`);
  console.error('    先跑 `pnpm --filter @fight-the-landlord/client build:h5`。');
  console.error('    （不跳过、不当通过 —— 否则这条闸会因为「没跑过」而恒绿。）');
  process.exit(1);
}

/** 递归收集产物里的全部文件。 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const allFiles = walk(DIST);
const textFiles = allFiles.filter((f) => /\.(js|css|html)$/.test(f));
const rel = (f) => relative(DIST, f).split('\\').join('/');

// ─── 判据 0：扫描器自证（否则后面的「零违规」可能只是「什么都没扫到」）────
// 牌面随牌桌分包（项 6）：产物落点 `dist/<platform>/pages/table/static/cards/`。
const CARD_DIR_IN_DIST = join('pages', 'table', 'static', 'cards');
const manifestPath = join(DIST, CARD_DIR_IN_DIST, 'manifest.json');
if (textFiles.length === 0) {
  console.error('!!! 产物里一个 .js/.css/.html 都没有 —— 扫描器失效或产物为空。');
  process.exit(1);
}
if (!existsSync(manifestPath)) {
  console.error(`!!! 产物里没有 ${rel(manifestPath)} —— 素材没被拷进产物。`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifestEntries = Object.entries(manifest);
if (manifestEntries.length === 0) {
  console.error('!!! manifest 是空的 —— 清单腿会「零违规」地恒绿。');
  process.exit(1);
}
console.log(`[asset-paths] 产物 ${DIST}`);
console.log(`[asset-paths] 文本文件 ${textFiles.length} 个，manifest 条目 ${manifestEntries.length} 个`);

let failed = 0;

// ─── 判据 1（字面量腿）：产物里出现的完整静态 URL 都有对应文件 ───────
// 两族基址都认：主包 `/static/...` 与牌桌分包 `/pages/table/static/...`（项 6 后）。
// ⚠️ 前缀正则必须一并吞掉 `pages/table/`：若只匹配 `/static/...`，分包字面量会被
//    截出 `/static/cards/...` 去主包落点找文件 —— 必然找不到，成假红。
const referenced = new Map(); // url -> Set<引用它的产物文件>
const URL_RE = /\/(?:pages\/table\/)?static\/[A-Za-z0-9_./ -]+?\.(?:png|jpg|jpeg|mp3|ogg|json)\b/g;
for (const file of textFiles) {
  for (const m of readFileSync(file, 'utf8').matchAll(URL_RE)) {
    if (!referenced.has(m[0])) referenced.set(m[0], new Set());
    referenced.get(m[0]).add(rel(file));
  }
}
for (const [url, sources] of [...referenced].sort()) {
  if (!existsSync(join(DIST, url.slice(1)))) {
    failed += 1;
    console.error(`  ❌ 字面量 ${url} —— 产物里没有这个文件（引用自 ${[...sources].join(', ')}）`);
  }
}
console.log(
  referenced.size > 0
    ? `  ✅ 字面量腿：${referenced.size} 个 URL 全部有对应文件`
    : '  ·  字面量腿：产物里暂无完整 /static/ URL（CSS 背景类素材接入后会出现；不是失败）',
);

// ─── 判据 2（清单腿）：manifest 的每个值都真的被拷进了产物 ────────────────
// 这条才是牌面真正走的腿（URL 是运行期拼的，见文件头）。
const missingFaces = [];
for (const [key, file] of manifestEntries) {
  if (!existsSync(join(DIST, CARD_DIR_IN_DIST, String(file)))) missingFaces.push(`${key} → ${file}`);
}
if (missingFaces.length > 0) {
  failed += 1;
  console.error(
    `  ❌ 清单腿：${missingFaces.length} 个值在产物里找不到：${missingFaces.slice(0, 5).join(', ')}`,
  );
} else {
  console.log(`  ✅ 清单腿：manifest 的 ${manifestEntries.length} 个值在产物里都存在`);
}

// ─── 判据 3：牌桌素材的运行期基址必须真的在包里（运行期拼装） ─────────────
// ⚠️ 这条防的是「基址被改坏」而清单腿发现不了的情形：清单腿只证明**文件在**，
//    不证明**代码找得到它们**。两条合起来才是「URL ⇔ 文件」。
//
// 基址 = `/pages/table/static/`（`asset.ts#tableAsset` / `cues.ts#TABLE_AUDIO` 的字面量）。
// ⚠️ **不能**判 `/pages/table/static/cards/` 整段（2026-10-13 实测教训）：`cards/` 段是
//    `Card.vue` 在**调用处**拼进来的（`` tableAsset(`cards/${file}`) ``），压缩产物里
//    基址与段**不连续**（实测形如 `/pages/table/static/${t}`）⇒ 判整段必假红。
//    `cards/` 段的正确性由 jsdom 层逐字钉死（`card-hand-interaction.test.ts`：`src ===
//    /pages/table/static/cards/<manifest 值>`），本闸只负责「基址在产物里」。
//
// 旧主包前缀 `/static/cards/` 属**残留错误**（线上必 404）：见下配对相减。
const tableBase = '/pages/table/static/';
const cardNewPrefix = '/pages/table/static/cards/';
const countOf = (hay, needle) => hay.split(needle).length - 1;
let hasTableBase = false;
let bareOldPrefix = 0;
for (const f of textFiles) {
  const content = readFileSync(f, 'utf8');
  if (content.includes(tableBase)) hasTableBase = true;
  // ⚠️ 新前缀**内含**旧前缀（`/pages/table` + `/static/cards/`）⇒ 不能写成
  //    「产物里不含 `/static/cards/`」（那恒红）。配对相减：每一处新前缀恰好
  //    贡献一处旧前缀出现，其余的出现就是真残留。
  bareOldPrefix += countOf(content, '/static/cards/') - countOf(content, cardNewPrefix);
}
if (!hasTableBase) {
  failed += 1;
  console.error(`  ❌ 产物里没有 ${tableBase} 这个基址 —— 牌桌素材 URL 运行期拼不出来`);
} else {
  console.log(`  ✅ 牌桌素材基址 ${tableBase} 在包里`);
}
if (bareOldPrefix > 0) {
  failed += 1;
  console.error(
    `  ❌ 出现 ${bareOldPrefix} 处旧主包前缀 /static/cards/（不在 /pages/table/static/cards/ 之内）` +
      ' —— 代码仍在拼旧基址，线上 404',
  );
} else {
  console.log('  ✅ 旧主包前缀 /static/cards/ 零残留（全部归于分包前缀）');
}

// ─── 判据 4：static 素材不许被哈希（不走 Vite asset 管线） ────────────────
const hashed = [...referenced.keys()].filter((u) => /-[A-Za-z0-9_]{8}\./.test(u));
if (hashed.length > 0) {
  failed += 1;
  console.error(`  ❌ 这些 URL 看起来被哈希了（static/ 应当原样复制）：${hashed.slice(0, 3).join(', ')}`);
} else {
  console.log('  ✅ 没有被哈希的 static URL');
}

if (failed > 0) {
  console.error(`\n!!! [asset-paths] ${failed} 条判据失败`);
  process.exit(1);
}
console.log('\n=== [asset-paths] 全部通过 ===');
