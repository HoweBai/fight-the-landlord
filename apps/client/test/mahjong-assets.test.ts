import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT } from './helpers/source-scan';

const ROOT = join(SRC_ROOT, 'pages/table/static/mahjong');
const DIRS = ['my', 'top', 'left', 'right'] as const;
const SUITS = ['wan', 'tong', 'tiao'] as const;
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** 算出红色像素（萬字/红竹节）的重心，用来判方向。 */
async function redCentroid(path: string) {
  const img = await loadImage(readFileSync(path));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a > 128 && r > 120 && r > g * 1.5 && r > b * 1.5) {
        sx += x;
        sy += y;
        n += 1;
      }
    }
  }
  return { x: sx / n / width, y: sy / n / height, n };
}

describe('麻将素材完整性', () => {
  it('四方向恰好 27 面 + back', () => {
    const expected = [
      ...SUITS.flatMap((s) => Array.from({ length: 9 }, (_, i) => `${s}-${i + 1}.png`)),
      'back.png',
    ].sort();
    for (const dir of DIRS) {
      const files = readdirSync(join(ROOT, dir))
        .filter((f) => f.endsWith('.png'))
        .sort();
      expect(files).toEqual(expected);
    }
  });

  it('manifest 哈希/尺寸/方向一致', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(manifest.source).toContain('FluffyStuff/riichi-mahjong-tiles');
    expect(manifest.license).toBe('CC0-1.0');
    expect(manifest.commit).toBe('26e127ba2117f45cdce5ea0225748cc0cfad3169');
    expect(manifest.files).toHaveLength(112);
    for (const e of manifest.files) {
      const file = String(e.file).replace(/\\/g, '/');
      expect(file.startsWith(`${e.direction}/`)).toBe(true);
      expect(sha(readFileSync(join(ROOT, file)))).toBe(e.sha256);
      const portrait = e.direction === 'my' || e.direction === 'top';
      expect(e.width).toBe(portrait ? 180 : 240);
      expect(e.height).toBe(portrait ? 240 : 180);
    }
  });

  it('同方向 27 面互不相同', () => {
    for (const dir of DIRS) {
      const hashes = SUITS.flatMap((s) =>
        Array.from({ length: 9 }, (_, i) =>
          sha(readFileSync(join(ROOT, dir, `${s}-${i + 1}.png`))),
        ),
      );
      expect(new Set(hashes).size).toBe(27);
    }
  });

  it('方向抽检：1 万/9 万红字重心', async () => {
    for (const name of ['wan-1', 'wan-9']) {
      const my = await redCentroid(join(ROOT, 'my', `${name}.png`));
      const top = await redCentroid(join(ROOT, 'top', `${name}.png`));
      const left = await redCentroid(join(ROOT, 'left', `${name}.png`));
      const right = await redCentroid(join(ROOT, 'right', `${name}.png`));
      expect(my.y).toBeGreaterThan(0.55);
      expect(top.y).toBeLessThan(0.45);
      expect(left.x).toBeLessThan(0.45);
      expect(right.x).toBeGreaterThan(0.55);
    }
  });

  it('back.png 四角保留透明', async () => {
    const img = await loadImage(readFileSync(join(ROOT, 'my', 'back.png')));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
    for (const [x, y] of [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ]) {
      expect(data[(y! * width + x!) * 4 + 3]).toBe(0);
    }
  });
});
