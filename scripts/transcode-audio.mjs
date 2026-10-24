#!/usr/bin/env node
/**
 * ogg → mp3 转码（spec 2026-10-22 · U5-2；原 spec §7 的「用系统 ffmpeg，不进依赖」）。
 *
 * ## 为什么必须转
 *
 * **OGG/Vorbis 在 iOS WKWebView 上不能播。** 转 mp3 是兼容性必需，不是体积优化。
 *
 * ## 码率
 *
 * 源 ogg 本身只有 65–72 kbps（已高度压缩）：
 *   · BGM 64k mono（≈ 源码率）
 *   · 既有语音 96k mono（历史产物，保持不动）
 *   · 2026-10-22 新增的牌型播报 64k mono（49 条合计 38.4s ≈ 307 KiB）
 *
 * ## 输出目录（项 6 分包后）
 *
 *   · 牌桌 62 条 → `apps/client/src/pages/table/static/audio/`
 *   · 大厅 BGM 1 条 → `apps/client/src/static/audio/`
 * 脚本直接写入归属目录，不再手工搬。预算与 `test/asset-budget.test.ts` 一致。
 *
 * ## 幂等与孤儿检查
 *
 * 目标文件已存在且非空则跳过；转码后检查输出目录里是否有清单外的 `.mp3`，
 * 有则报错（防止旧脚本/旧储备残留）。
 *
 * ## 用法
 *
 * ```bash
 * AUDIO_SRC='D:/Code/pokergame/resources' node scripts/transcode-audio.mjs
 * ```
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 参考实现的素材根（本仓 `resources/` 被 gitignore，通常用环境变量指向外部）。 */
const SRC = process.env.AUDIO_SRC;
if (!SRC) {
  console.error(
    "!!! 缺少 AUDIO_SRC。用法：AUDIO_SRC='D:/Code/pokergame/resources' node scripts/transcode-audio.mjs",
  );
  process.exit(1);
}

const TABLE_OUT = join('apps', 'client', 'src', 'pages', 'table', 'static', 'audio');
const MAIN_OUT = join('apps', 'client', 'src', 'static', 'audio');

/** 目录预算（KiB）。必须与 `test/asset-budget.test.ts` 的 `table/audio` / `main/audio` 一致。 */
const BUDGETS = new Map([
  [TABLE_OUT, 1024],
  [MAIN_OUT, 320],
]);

/** `[源相对路径, 输出名, 码率, 输出目录]`。 */
const TRACKS = [
  // ── 牌桌事件（既有，96k）────────────────────────────────────────────
  ['Sound/Fight/Woman_NoOrder.ogg', 'Woman_NoOrder.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_Rob1.ogg', 'Woman_Rob1.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_Rob2.ogg', 'Woman_Rob2.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_Rob3.ogg', 'Woman_Rob3.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_buyao1.ogg', 'Woman_buyao1.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_buyao2.ogg', 'Woman_buyao2.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_buyao3.ogg', 'Woman_buyao3.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_baojing1.ogg', 'Woman_baojing1.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_baojing2.ogg', 'Woman_baojing2.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_100.ogg', 'Woman_100.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/Woman_200.ogg', 'Woman_200.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/MusicEx_Win.ogg', 'MusicEx_Win.mp3', '96k', TABLE_OUT],
  ['Sound/Fight/MusicEx_Lose.ogg', 'MusicEx_Lose.mp3', '96k', TABLE_OUT],
  // ── 2026-10-22 U5 恢复（叫地主，64k）────────────────────────────────
  ['Sound/Fight/Woman_Order.ogg', 'Woman_Order.mp3', '64k', TABLE_OUT],
  // ── 牌型播报（2026-10-22 新增，64k；序号 3..14 = 3..A，15 = 2）────────
  ['Sound/Fight/Woman_3.ogg', 'Woman_3.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_4.ogg', 'Woman_4.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_5.ogg', 'Woman_5.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_6.ogg', 'Woman_6.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_7.ogg', 'Woman_7.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_8.ogg', 'Woman_8.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_9.ogg', 'Woman_9.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_10.ogg', 'Woman_10.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_11.ogg', 'Woman_11.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_12.ogg', 'Woman_12.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_13.ogg', 'Woman_13.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_14.ogg', 'Woman_14.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_15.ogg', 'Woman_15.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui3.ogg', 'Woman_dui3.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui4.ogg', 'Woman_dui4.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui5.ogg', 'Woman_dui5.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui6.ogg', 'Woman_dui6.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui7.ogg', 'Woman_dui7.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui8.ogg', 'Woman_dui8.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui9.ogg', 'Woman_dui9.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui10.ogg', 'Woman_dui10.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui11.ogg', 'Woman_dui11.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui12.ogg', 'Woman_dui12.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui13.ogg', 'Woman_dui13.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui14.ogg', 'Woman_dui14.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_dui15.ogg', 'Woman_dui15.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple3.ogg', 'Woman_tuple3.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple4.ogg', 'Woman_tuple4.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple5.ogg', 'Woman_tuple5.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple6.ogg', 'Woman_tuple6.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple7.ogg', 'Woman_tuple7.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple8.ogg', 'Woman_tuple8.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple9.ogg', 'Woman_tuple9.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple10.ogg', 'Woman_tuple10.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple11.ogg', 'Woman_tuple11.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple12.ogg', 'Woman_tuple12.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple13.ogg', 'Woman_tuple13.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple14.ogg', 'Woman_tuple14.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_tuple15.ogg', 'Woman_tuple15.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_shunzi.ogg', 'Woman_shunzi.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_liandui.ogg', 'Woman_liandui.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_feiji.ogg', 'Woman_feiji.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_sandaiyi.ogg', 'Woman_sandaiyi.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_sandaiyidui.ogg', 'Woman_sandaiyidui.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_sidaier.ogg', 'Woman_sidaier.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_sidailiangdui.ogg', 'Woman_sidailiangdui.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_zhadan.ogg', 'Woman_zhadan.mp3', '64k', TABLE_OUT],
  ['Sound/Fight/Woman_wangzha.ogg', 'Woman_wangzha.mp3', '64k', TABLE_OUT],
  // ── BGM（64k）──────────────────────────────────────────────────────
  ['MusicEx/MusicEx_Normal.ogg', 'MusicEx_Normal.mp3', '64k', TABLE_OUT],
  ['MusicEx/MusicEx_Welcome.ogg', 'MusicEx_Welcome.mp3', '64k', MAIN_OUT],
];

for (const dir of BUDGETS.keys()) mkdirSync(dir, { recursive: true });

let made = 0;
let skipped = 0;
const bytesByDir = new Map([...BUDGETS.keys()].map((d) => [d, 0]));

for (const [from, to, bitrate, outDir] of TRACKS) {
  const src = join(SRC, from);
  const dst = join(outDir, to);
  if (!existsSync(src)) {
    console.error(`!!! 源文件不存在：${src}`);
    process.exit(1);
  }
  if (existsSync(dst) && statSync(dst).size > 0) {
    skipped += 1;
  } else {
    // `-vn` 丢弃封面流；`-ar 44100` 统一采样率（移动端友好）。
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-b:a', bitrate, '-ar', '44100', dst]);
    made += 1;
  }
  bytesByDir.set(outDir, bytesByDir.get(outDir) + statSync(dst).size);
}

const expectedByDir = new Map([...BUDGETS.keys()].map((d) => [d, new Set()]));
for (const [, to, , outDir] of TRACKS) expectedByDir.get(outDir).add(to);

let ok = true;
for (const [dir, budget] of BUDGETS) {
  const kib = bytesByDir.get(dir) / 1024;
  const orphans = readdirSync(dir).filter(
    (f) => f.endsWith('.mp3') && !expectedByDir.get(dir).has(f),
  );
  console.log(`${dir}: ${kib.toFixed(0)} KiB / 预算 ${budget} KiB（${expectedByDir.get(dir).size} 条）`);
  if (kib > budget) {
    console.error(`!!! ${dir} 超预算 ${budget} KiB`);
    ok = false;
  }
  if (orphans.length > 0) {
    console.error(`!!! ${dir} 有清单外的 mp3：${orphans.join(', ')}`);
    ok = false;
  }
}

console.log(`转码 ${made} 条 / 跳过 ${skipped} 条（清单 ${TRACKS.length} 条）`);
if (made + skipped !== TRACKS.length) {
  console.error(`!!! 产出条数不符：${made + skipped} ≠ ${TRACKS.length}`);
  process.exit(1);
}
process.exit(ok ? 0 : 1);
