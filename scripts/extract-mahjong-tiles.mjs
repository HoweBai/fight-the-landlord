/**
 * 从 babykylin_scmj 的 Cocos Creator Atlas (plist + PNG) 切出独立麻将牌面 PNG。
 *
 * 用法：
 *   node scripts/extract-mahjong-tiles.mjs
 *
 * 输入目录（硬编码或环境变量覆盖）：
 *   SRC = D:\Code\babykylin_scmj\client\assets\resources\textures
 *
 * 输出目录（相对于 repo 根）：
 *   OUT_TILES = apps/client/src/pages/table/static/mahjong/{my,top,left,right}/
 *   OUT_MJROOM = apps/client/src/pages/table/static/ui/mahjong-table/
 *
 * 依赖：@napi-rs/canvas（workspace devDep）；无需 XML 库（regex 提取 plist）。
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const SRC = process.env.SRC || 'D:/Code/babykylin_scmj/client/assets/resources/textures';
const OUT_TILES_ROOT = join(
  REPO_ROOT,
  'apps/client/src/pages/table/static/mahjong',
);
const OUT_MJROOM = join(
  REPO_ROOT,
  'apps/client/src/pages/table/static/ui/mahjong-table',
);

/** 4 方向 Atlas 配置：输出目录 → (Atlas 相对路径, plist key 前缀) */
const DIRECTIONS = [
  { outDir: 'my',    atlas: 'MJ/my/Z_my.png',      plist: 'MJ/my/Z_my.plist',      prefix: 'M_' },
  { outDir: 'top',   atlas: 'MJ/bottom/Z_bottom.png', plist: 'MJ/bottom/Z_bottom.plist', prefix: 'B_' },
  { outDir: 'left',  atlas: 'MJ/left/Z_left.png',   plist: 'MJ/left/Z_left.plist',  prefix: 'L_' },
  { outDir: 'right', atlas: 'MJ/right/Z_right.png',  plist: 'MJ/right/Z_right.plist', prefix: 'R_' },
];

/** 牌背来源（独立 Atlas，不在方向 Atlas 里） */
const BACK_ATLAS = 'MJ/mjEmpty.png';
const BACK_PLIST = 'MJ/mjEmpty.plist';
const BACK_KEY = 'e_mj_v_1.png';

/** MJRoom 牌桌资源（直接 copy，不切） */
const MJROOM_FILES = [
  'Z_corner_ltop.png',
  'Z_corner_rtop.png',
  'Z_corner_lbottom.png',
  'Z_corner_rbottom.png',
  'Z_bg_bottom.png',
];

/** babykylin → ftl 文件名映射 */
const SUIT_MAP = { character: 'wan', dot: 'tong', bamboo: 'tiao' };

/** 需要切的正脸 regex（跳过字牌花牌） */
const KEEP_RE = /^[MBLR]_(character|dot|bamboo)_([1-9])\.png$/;

/* ===================================================================== *
 * Plist 解析（regex 提取，无需 XML 库）
 * ===================================================================== */

/**
 * 从 Cocos Creator plist 里提取所有 frame 字典。
 * Cocos plist 的 frames 结构：<key>frames</key><dict>... 每个条目是
 *   <key>XXX.png</key><dict>
 *     <key>frame</key><string>{{x,y},{w,h}}</string>
 *     <key>sourceSize</key><string>{w,h}</string>
 *     <key>rotated</key><true/>          或 <false/>
 *   </dict>
 */
function parsePlist(text) {
  const frames = {};
  // 每个 frame 条目：<key>XXX.png</key><dict>...</dict>
  const entryRe = /<key>([\w\.]+\.png)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let m;
  while ((m = entryRe.exec(text))) {
    const key = m[1];
    const block = m[2];
    const frameMatch = block.match(
      /<key>frame<\/key>\s*<string>\{\{(\d+),(\d+)\},\{(\d+),(\d+)\}\}<\/string>/,
    );
    const ssMatch = block.match(
      /<key>sourceSize<\/key>\s*<string>\{(\d+),(\d+)\}<\/string>/,
    );
    const rotatedMatch = block.match(/<key>rotated<\/key>\s*<(true|false)\/>/);
    if (frameMatch && ssMatch) {
      frames[key] = {
        frame: {
          x: +frameMatch[1],
          y: +frameMatch[2],
          w: +frameMatch[3],
          h: +frameMatch[4],
        },
        sourceSize: { w: +ssMatch[1], h: +ssMatch[2] },
        rotated: rotatedMatch ? rotatedMatch[1] === 'true' : false,
      };
    }
  }
  return frames;
}

/* ===================================================================== *
 * 切图
 * ===================================================================== */

/**
 * 从 Atlas 切一张牌面 PNG 并写入 outPath。
 * @param atlas @napi-rs/canvas 的 Image 对象（已加载 Atlas PNG）
 * @param info plist 解析出的 frame 字典项
 * @param outPath 输出路径
 */
function cutFrame(atlas, info, outPath) {
  const { x, y, w, h } = info.frame;
  const { w: srcW, h: srcH } = info.sourceSize;

  if (info.rotated) {
    // Atlas 上横着存的图，先横着裁再**逆时针**旋转 90° 还原
    // TexturePacker rotated=true 时 frame 里的 {w,h} 仍是原始尺寸 {srcW,srcH}
    // 但 atlas 上存储的矩形是交换后的：宽=srcH, 高=srcW
    // ⚠️ 方向：canvas 的 y 轴朝下，`rotate(+PI/2)` 视觉上是顺时针 ⇒ 剥出来会上下颠倒；
    //   正确做法是 `rotate(-PI/2)`（视觉逆时针）。像素比对见 2026-10-29 修复提交。
    const tmpCanvas = createCanvas(srcH, srcW);
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(atlas, x, y, srcH, srcW, 0, 0, srcH, srcW);

    const out = createCanvas(srcW, srcH);
    const ctx = out.getContext('2d');
    ctx.save();
    ctx.translate(srcW / 2, srcH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.translate(-srcH / 2, -srcW / 2);
    ctx.drawImage(tmpCanvas, 0, 0);
    ctx.restore();
    writeFileSync(outPath, out.toBuffer('image/png'));
  } else {
    const out = createCanvas(srcW, srcH);
    const ctx = out.getContext('2d');
    ctx.drawImage(atlas, x, y, w, h, 0, 0, srcW, srcH);
    writeFileSync(outPath, out.toBuffer('image/png'));
  }
}

/* ===================================================================== *
 * 主流程
 * ===================================================================== */

async function main() {
  console.log('=== 切麻将牌面 ===');
  console.log('输入:', SRC);
  console.log('输出 tiles:', OUT_TILES_ROOT);
  console.log('输出 mjroom:', OUT_MJROOM);

  if (!existsSync(SRC)) {
    console.error('输入目录不存在:', SRC);
    console.error('设置环境变量 SRC=... 覆盖默认路径');
    process.exit(1);
  }

  let total = 0;
  const skipped = [];

  // --- 4 方向 Atlas ---
  for (const dir of DIRECTIONS) {
    const outDir = join(OUT_TILES_ROOT, dir.outDir);
    mkdirSync(outDir, { recursive: true });

    const plistPath = join(SRC, dir.plist);
    const atlasPath = join(SRC, dir.atlas);
    if (!existsSync(plistPath) || !existsSync(atlasPath)) {
      console.warn('跳过（文件缺失）:', dir.outDir, plistPath, atlasPath);
      continue;
    }

    const plistText = readFileSync(plistPath, 'utf8');
    const frames = parsePlist(plistText);
    const atlasImg = await loadImage(atlasPath);
    console.log(`\n--- ${dir.outDir}（${dir.prefix}*）---`);
    console.log('  Atlas 尺寸:', atlasImg.width, '×', atlasImg.height);
    console.log('  Plist frame 数:', Object.keys(frames).length);

    for (const [key, info] of Object.entries(frames)) {
      const m = KEEP_RE.exec(key);
      if (!m) {
        skipped.push(key);
        continue;
      }
      const suit = SUIT_MAP[m[1]];
      const rank = m[2];
      const outName = `${suit}-${rank}.png`;
      const outPath = join(outDir, outName);
      cutFrame(atlasImg, info, outPath);
      total++;
    }
  }

  // --- 牌背（独立 Atlas） ---
  {
    const backOutDirs = ['my', 'top', 'left', 'right'].map((d) =>
      join(OUT_TILES_ROOT, d),
    );
    for (const d of backOutDirs) mkdirSync(d, { recursive: true });

    const plistPath = join(SRC, BACK_PLIST);
    const atlasPath = join(SRC, BACK_ATLAS);
    if (existsSync(plistPath) && existsSync(atlasPath)) {
      const plistText = readFileSync(plistPath, 'utf8');
      const frames = parsePlist(plistText);
      const info = frames[BACK_KEY];
      if (!info) {
        console.warn('牌背 key 未找到:', BACK_KEY, '可用 keys:', Object.keys(frames).slice(0, 10));
      } else {
        const atlasImg = await loadImage(atlasPath);
        console.log('\n--- 牌背 ---');
        console.log('  Atlas 尺寸:', atlasImg.width, '×', atlasImg.height);
        for (const d of backOutDirs) {
          cutFrame(atlasImg, info, join(d, 'back.png'));
          total++;
        }
      }
    } else {
      console.warn('牌背 Atlas 文件缺失:', plistPath, atlasPath);
    }
  }

  // --- MJRoom 牌桌资源（直接 copy） ---
  {
    mkdirSync(OUT_MJROOM, { recursive: true });
    const srcDir = join(SRC, 'MJRoom');
    let copied = 0;
    for (const f of MJROOM_FILES) {
      const src = join(srcDir, f);
      const dst = join(OUT_MJROOM, f);
      if (existsSync(src)) {
        copyFileSync(src, dst);
        copied++;
      } else {
        console.warn('MJRoom 文件缺失:', f);
      }
    }
    console.log(`\n--- MJRoom 资源：${copied}/${MJROOM_FILES.length} 已拷到 ${relative(REPO_ROOT, OUT_MJROOM)} ---`);
  }

  // --- 汇总 ---
  const perDir = {};
  for (const d of ['my', 'top', 'left', 'right']) {
    perDir[d] = existsSync(join(OUT_TILES_ROOT, d))
      ? (await import('node:fs')).readdirSync(join(OUT_TILES_ROOT, d)).length
      : 0;
  }
  console.log(`\n=== 切图完成：${total} 张牌面 ===`);
  console.log('每方向文件数:', perDir);
  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 个 frame（字牌花牌等），前 10 个:`, skipped.slice(0, 10));
  }
}

main().catch((err) => {
  console.error('切图失败:', err);
  process.exit(1);
});
