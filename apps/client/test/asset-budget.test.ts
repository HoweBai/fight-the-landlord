/**
 * 素材侧的**机械闸**（spec §6.2.4 / R702 / R703；项 6 分包后分主包 / 牌桌分包两组）。
 *
 * 四条：
 *  ① 每类素材的体积 ≤ 预算（主包组直接关系微信 2MB 主包配额，预算从紧）；
 *  ② `manifest.json` 覆盖全部 54 个合法牌码 + 1 个牌背；
 *  ③ `cards/` 里**没有孤儿文件**（每个 PNG 都被 manifest 引用）；
 *  ④ manifest 的值只能是 `[A-Za-z]+.png` —— **这是 F10 的边界守卫**：
 *     它挡住「有人把中文牌面文字（'大王'/'小王'）塞进这份数据文件」，
 *     因为 `source-boundary` 的 `['"](?:大王|小王)['"]` 扫描面**包含 `src/**` 的 .json**
 *     （`source-scan.ts:27` 的 `SOURCE_EXTENSIONS` 含 `.json`）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT } from './helpers/source-scan';
import { CUES } from '../src/audio/cues';

/**
 * ⚠️ **不要在这里自己用 `new URL('.', import.meta.url)` 推路径** ——
 * 本仓的 vitest 跑在 jsdom 环境里，那里 `import.meta.url` **不是 `file://` URL**，
 * `fileURLToPath` 会抛 `TypeError: The URL must be of scheme file`（实测）。
 * `source-scan.ts` 能这么做是因为它是个被 import 的 helper，不是 test 文件。
 * ⇒ 直接复用它的 `SRC_ROOT`（= `apps/client/src`），既不重复推导也不会踩这个坑。
 */
const STATIC = join(SRC_ROOT, 'static');
/** 项 6：牌桌分包的 static 根（牌面 / 头像 / 牌桌音频 / 牌桌底纹）。 */
const TABLE_STATIC = join(SRC_ROOT, 'pages', 'table', 'static');

/**
 * 每类预算（KiB）。来源见 `src/static/ASSETS.md` 的「覆盖范围与体积预算」段。
 *
 * 项 6（小程序分包）后按**归属包**分两组：主包组要为微信 2MB 主包配额负责，预算从紧；
 * 分包组随牌桌分包下载，沿用历史宽限。
 */
const BUDGET_KIB = {
  // —— 牌桌分包 ——
  'table/cards': 500, // 实测 437
  'table/av': 160, // 实测 136（2026-10-12 第二批头像素材）
  'table/audio': 1024, // 实测 ~829（63 条牌桌音效 + BGM/胜负；2026-10-22 牌型播报 U5-2）
  'table/ui': 400, // 实测 ~329（bg_table）
  // —— 主包 ——
  'main/ui': 768, // 实测 ~574（登录/大厅/共用 UI；牌桌专用图已移分包）
  'main/audio': 320, // 实测 ~260（仅大厅 BGM MusicEx_Welcome）
} as const;

/**
 * 全部 **54 个合法牌码**（R695/R696）：4 花色 × 13 点数 + 2 张王。
 *
 * ⚠️ 点数是 **DouZero 编码**：3–14 / **17（= `2`，不是 15）** / 20（小王）/ 30（大王）。
 * 王的 `s` 恒为 `4`（两张王**都是** 4，沿用 `shared` 的 `Suit.Joker`）。
 */
const FACE_KEYS: string[] = [];
for (let s = 0; s <= 3; s++) {
  for (const r of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]) FACE_KEYS.push(`${s}-${r}`);
}
FACE_KEYS.push('4-20', '4-30');

/**
 * 目录体积（KiB）。⚠️ 这四个目录都是**平的**（无子目录）—— 若哪天有人塞了子目录，
 * `statSync` 会拿到目录项自身的 size（一个远小于内容的假值）⇒ 判据静默变松。
 * 因此这里**显式拒绝**子目录，宁可红也不要一条「看起来在量、其实没量」的判据。
 */
function dirSizeKiB(dir: string): number {
  let bytes = 0;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) throw new Error(`${dir}/${e} 是子目录：本闸假定素材目录是平的，请改断言`);
    bytes += st.size;
  }
  return bytes / 1024;
}

const manifest = JSON.parse(
  readFileSync(join(TABLE_STATIC, 'cards', 'manifest.json'), 'utf8'),
) as Record<string, string>;

/** 预算条目 → 盘上目录。 */
const BUDGET_DIRS: Record<keyof typeof BUDGET_KIB, string> = {
  'table/cards': join(TABLE_STATIC, 'cards'),
  'table/av': join(TABLE_STATIC, 'av'),
  'table/audio': join(TABLE_STATIC, 'audio'),
  'table/ui': join(TABLE_STATIC, 'ui'),
  'main/ui': join(STATIC, 'ui'),
  'main/audio': join(STATIC, 'audio'),
};

describe('① 各类素材体积 ≤ 预算', () => {
  for (const [name, budget] of Object.entries(BUDGET_KIB)) {
    it(`${name}/ ≤ ${budget} KiB`, () => {
      const actual = dirSizeKiB(BUDGET_DIRS[name as keyof typeof BUDGET_DIRS]);
      expect(actual, `${name}/ 实测 ${actual.toFixed(0)} KiB`).toBeLessThanOrEqual(budget);
    });
  }

  it('判别力自证：预算表非空且量级正确（不是「空集合恒绿」）', () => {
    expect(Object.keys(BUDGET_KIB)).toHaveLength(6);
    // 牌面至少有 400 KiB —— 若分包目录没拷进来这条当场红
    expect(dirSizeKiB(join(TABLE_STATIC, 'cards'))).toBeGreaterThan(400);
    // 主包音频只剩大厅 BGM 一条：若有人把牌桌音频挪回主包，这条立刻红
    expect(readdirSync(join(STATIC, 'audio')).filter((f) => f.endsWith('.mp3'))).toEqual([
      'MusicEx_Welcome.mp3',
    ]);
  });
});

describe('② manifest 覆盖全部 54 个合法牌码 + 牌背', () => {
  it('牌码集合的基数恰好 54（先证明「54」这个数本身没写错）', () => {
    expect(FACE_KEYS).toHaveLength(54);
    expect(new Set(FACE_KEYS).size, '不得有重复键').toBe(54);
  });

  it('每个牌码都有映射，且对应文件**存在**', () => {
    const missing = FACE_KEYS.filter((k) => manifest[k] === undefined);
    expect(missing, `manifest 缺少：${missing.join(', ')}`).toEqual([]);
    for (const k of FACE_KEYS) {
      const file = manifest[k]!;
      expect(() => statSync(join(TABLE_STATIC, 'cards', file)), `文件不存在：${file}`).not.toThrow();
    }
    expect(manifest['4-20'], '小王').toBeDefined();
    expect(manifest['4-30'], '大王').toBeDefined();
    expect(manifest.back, '牌背必须在 manifest 里').toBe('CardBack.png');
  });

  it('manifest 条目数恰好 55（54 面 + 1 背）—— 多一条少一条都说明映射漂了', () => {
    expect(Object.keys(manifest)).toHaveLength(55);
  });
});

describe('③ 没有孤儿文件', () => {
  it('pages/table/static/cards/ 里每个 .png 都被 manifest 引用', () => {
    const referenced = new Set(Object.values(manifest));
    const orphans = readdirSync(join(TABLE_STATIC, 'cards')).filter(
      (f) => f.endsWith('.png') && !referenced.has(f),
    );
    expect(orphans, `未被引用的牌面文件：${orphans.join(', ')}`).toEqual([]);
  });
});

describe('④ F10 边界：manifest 的值只能是英文 PNG 文件名', () => {
  it('任何值都不得含中文 / 路径分隔符 / 非 .png 后缀', () => {
    const bad = Object.entries(manifest).filter(([, v]) => !/^[A-Za-z]+\.png$/.test(v));
    expect(bad, `非法值（会把这个文件变成「自制牌面映射」的入口）：${JSON.stringify(bad)}`).toEqual(
      [],
    );
  });

  it('判别力正对照：中文值与子路径必须被判违规', () => {
    const offenders = (m: Record<string, string>) =>
      Object.entries(m).filter(([, v]) => !/^[A-Za-z]+\.png$/.test(v));
    expect(offenders({ '4-30': '大王.png' })).toHaveLength(1);
    expect(offenders({ '0-3': 'sub/SpadeThree.png' })).toHaveLength(1);
    expect(offenders({ '0-3': 'SpadeThree.jpg' })).toHaveLength(1);
    expect(offenders({ '0-3': 'SpadeThree.png' })).toHaveLength(0);
  });
});

/**
 * ⑤ 音效资产：`CUES` ↔ 盘上文件**双向**精确比对。
 *
 * ⚠️ 必须用 `readdirSync` 的**精确字符串 Set**：Windows 的 `existsSync` 大小写不敏感，
 * `Woman_Feiji.mp3` 在开发机上会假绿、到 Linux/H5 构建后 404 静默无声。
 * ⚠️ 双向：既防「表里有、盘上没有」，也防「盘上有、表里没有」（孤儿文件）。
 */
describe('⑤ 音效资产与 CUES 双向一致', () => {
  const URL_RE = /^\/(?:static|pages\/table\/static)\/audio\/([A-Za-z0-9_]+\.mp3)$/;

  /** URL → { 目录, 文件名 }；无法解析直接让用例红（不是静默跳过）。 */
  function locate(src: string): { dir: string; file: string } {
    const path = src.split('?')[0]!;
    const m = URL_RE.exec(path);
    if (!m) throw new Error(`无法解析的音频 URL：${src}`);
    const file = m[1]!;
    const dir = path.startsWith('/pages/table/static/audio/')
      ? join(TABLE_STATIC, 'audio')
      : join(STATIC, 'audio');
    return { dir, file };
  }

  it('CUES 里每条 URL 都对应盘上真实文件（大小写敏感、非空）', () => {
    const byDir = new Map<string, Set<string>>();
    const missing: string[] = [];
    for (const [name, src] of Object.entries(CUES)) {
      const { dir, file } = locate(src);
      if (!byDir.has(dir)) byDir.set(dir, new Set(readdirSync(dir)));
      const set = byDir.get(dir)!;
      if (!set.has(file)) {
        missing.push(`${name} → ${file}`);
        continue;
      }
      if (statSync(join(dir, file)).size <= 0) missing.push(`${name} → ${file}（空文件）`);
    }
    expect(missing, `CUES 引用了不存在的音频：${missing.join(', ')}`).toEqual([]);
  });

  it('盘上每个 .mp3 都被 CUES 引用（无孤儿文件）', () => {
    const referenced = new Map<string, Set<string>>();
    for (const src of Object.values(CUES)) {
      const { dir, file } = locate(src);
      if (!referenced.has(dir)) referenced.set(dir, new Set());
      referenced.get(dir)!.add(file);
    }
    const orphans: string[] = [];
    for (const [dir, files] of referenced) {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.mp3') && !files.has(f)) orphans.push(`${dir}/${f}`);
      }
    }
    expect(orphans, `未被 CUES 引用的音频：${orphans.join(', ')}`).toEqual([]);
  });
});
