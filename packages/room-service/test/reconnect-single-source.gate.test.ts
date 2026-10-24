/**
 * 断线恢复单一来源闸（规格 v1.1 C12/C13）。
 *  - C12：窗口/独立键/时钟注入 → 退役符号在**各包 `src/`** 0 命中；
 *  - C13：组合定位（哈希+pending 择优）只住在 resolver（reconnect 模块）；
 *         `RECONNECT_HASH_KEY` 只允许出现在 reconnect 模块的 src 里、`findActiveRoom` 0 命中。
 * ⚠️ 扫描面**只**是各包 `src/`（排除 `dist/`、`*.test.ts`）——照 `meta-on-every-rpc-send.gate.test.ts`
 *   的「逐包 src 白名单」纪律；`dist/` 里是旧产物，扫到它本闸恒红。
 * allowlist 纪律（R150 同族）：将来出现**合法**的第二读取方 ⇒ 先在本闸显式放行并写明理由，
 *   不得直接删闸。
 * 判别力自证：纯字符串探针（逐词正样本 + 负样本 + 词表逐字锁）——不落盘。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * 从本文件所在目录**向上**找到仓库根（以 `packages/room-service` + `packages/game-service`
 * 为锚）。⚠️ **R179**：不得用固定层数的相对路径 —— 层数一错就静默扫到主检出的旧文件 ⇒ 闸恒绿；
 * 找不到锚点必须**抛错**（宁可红，也不要空测）。
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'room-service', 'package.json');
    const gameAnchor = join(dir, 'packages', 'game-service', 'package.json');
    if (existsSync(anchor) && existsSync(gameAnchor) && statSync(anchor).isFile()) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（以 packages/room-service + packages/game-service 为锚）');
}

const REPO = findRepoRoot();
const RETIRED = ['RECONNECT_WINDOW_MS', 'RECONNECT_TTL_SECONDS', 'reconnectKey', 'validateReconnect', 'RECONNECT_CLOCK', 'findActiveRoom'];

/** 递归收集某目录下的 .ts，排除 *.test.ts（与 meta 闸同纪律）。 */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTs(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 扫描面 = 各包 `src/`（逐包枚举；不得扫 dist）。 */
function packagesSrcFiles(): string[] {
  const packagesDir = join(REPO, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    if (existsSync(src) && statSync(src).isDirectory()) files.push(...collectTs(src));
  }
  return files;
}

describe('断线恢复单一来源闸', () => {
  const files = packagesSrcFiles();

  it('扫描面非空（反空测；下界按实测校准：2026-10-12 实测 319 个文件）', () => {
    // 下界 300 ≈ 实测 319 的 94%：路径/枚举失效（或扫到 dist 之外的错误根）会立刻红；
    // 正常增删（余量 ≥19 个文件）不会假红。真的大规模删文件时按实测重校准 —— 不得直接删闸。
    expect(files.length).toBeGreaterThan(300);
  });

  it('退役符号 0 命中（C12）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const term of RETIRED) if (text.includes(term)) offenders.push(`${file}: ${term}`);
    }
    expect(offenders).toEqual([]);
  });

  it('判别力自证：逐词可击落（正/负样本 + 词表逐字锁）', () => {
    // ① 逐词正样本：**每个**退役词各自的合成样本都被判定逻辑（`text.includes(term)`）标红 ——
    //    不得只喂组合样本（`.some` 的短路会掩盖单个词的判定退化成哑弹）。
    for (const term of RETIRED) {
      const sample = `const x = ${term};`;
      expect(sample.includes(term)).toBe(true);
    }
    // ② 负样本：干净标识符不被任一退役词击落。
    expect(RETIRED.some((t) => 'const x = resolveRecoverableRoom;'.includes(t))).toBe(false);
    // ③ 词表逐字锁死：**删/改/加任何一个退役词**都红（Task 7 审查 Issue 1：原探针只击落
    //    「整表删空」，删单个词不会被发现）。合法变更退役面时须**有意**同步本断言 ——
    //    allowlist 纪律（R150 同族）：缩表 = 改闸，不得悄悄进行。
    expect(RETIRED).toEqual([
      'RECONNECT_WINDOW_MS',
      'RECONNECT_TTL_SECONDS',
      'reconnectKey',
      'validateReconnect',
      'RECONNECT_CLOCK',
      'findActiveRoom',
    ]);
  });

  it('RECONNECT_HASH_KEY 只现于 reconnect 模块的 src（C13 组合定位单一来源）', () => {
    const offenders = files
      .filter((f) => !f.split(/[\\/]/).includes('reconnect'))
      .filter((f) => readFileSync(f, 'utf8').includes('RECONNECT_HASH_KEY'));
    expect(offenders).toEqual([]);
  });

  it('resolveRecoverableRoom 恰定义一次（组合定位单一实现）', () => {
    const defs = files.filter((f) => readFileSync(f, 'utf8').includes('async resolveRecoverableRoom('));
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain(join('reconnect', 'reconnect.service.ts'));
  });
});
