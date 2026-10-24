import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { join } from 'path';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';
import { toPosixPath } from './helpers/repo-path';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * ⚠️ 判据涉及的**两个词**在本文件里也拼成了运行时字符串，而不是字面量：
 *
 * 本闸的判据是「测试源码里有没有写下那一行垫片」，而本文件自己就在扫描面内
 * （`packages/api-gateway/test/`）。若把被查的字符串**逐字**写进源码（哪怕在注释或
 * 用例名里），判据会**打到闸自己** —— 于是唯一能变绿的做法是给闸开一个自我豁免白名单，
 * 那是把判别力换成豁免权（与 `no-raw-console.test.ts` 拒绝「按原始文本匹配」同一条理由）。
 * 拼出来之后，本文件剥注释后**不含**任何可命中的字面量，闸因此不需要任何白名单。
 */
const REFLECT = 'Reflect';
const DEFINE = 'defineMetadata';
const KEY = 'design:param' + 'types';

/** 垫片形态：`<Reflect>.<defineMetadata>( '<design:paramtypes>' …`，允许任意空白/换行。 */
const SHIM_PATTERN = new RegExp(
  `${REFLECT}\\s*\\.\\s*${DEFINE}\\s*\\(\\s*['"\`]${KEY}['"\`]`,
);

/**
 * 剥注释：**唯一真源** = `@fight-the-landlord/test-utils`（台账 N46 收敛）。**这一步是必需的**，不是宽容：
 *
 * 判据是「有没有**写下**一处手工垫片」，而注释里引用真实写法是本仓的注释习惯
 * （`gateway.controller.test.ts` 此前正是靠注释解释这个坑）。按**原始文本**匹配
 * 会把那些告诫一起打红，于是唯一能让人变绿的做法是**删掉解释文档** —— 那是把判别力
 * 换成注释洁净度，方向反了（与 `no-raw-console.test.ts` 的同款处置）。
 */

/**
 * 「真的定义了一处 paramtypes 垫片」而不是「在注释里提到了它」。
 *
 * ⚠️ 正则里的 `\s*` 是判别力的关键：本片拆掉的 7 处里有一处是**多行写法**
 * （`ws-allow-request.test.ts` 的换行形态）。只匹配单行会让它**静默漏过**。
 */
export function hasParamtypesShim(src: string): boolean {
  return SHIM_PATTERN.test(stripComments(src));
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // 目录不存在（例如某个包的 test/ 被移走）⇒ 不算命中
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 收集两类根下的 `test` 目录：`<root>/packages/<pkg>/test` 与 `<root>/tools/<tool>/test`。 */
export function scanRoots(repoRoot: string): string[] {
  const roots: string[] = [];
  for (const group of ['packages', 'tools']) {
    let pkgs: string[];
    try {
      pkgs = readdirSync(join(repoRoot, group));
    } catch {
      continue;
    }
    for (const pkg of pkgs) roots.push(join(repoRoot, group, pkg, 'test'));
  }
  return roots;
}

/**
 * **R564 机械闸（防垫片复活）**：所有包的 `test/`（`packages` 与 `tools` 两组）不得再出现
 * 手工补 `design:paramtypes` 的那一行。
 *
 * 为什么必须有这条闸（而不是只靠「本片拆了 7 处」）：垫片是**最容易复活**的那种写法 ——
 * 任何人在测试里遇到 `Nest can't resolve dependencies` 时，抄一行旧代码就能让它变绿，
 * 而代价（测试从此自证自己的期望）**完全不可见**。N41 的缺口就是这么活到今天。
 *
 * 配套的**正对照**（R565）在 `packages/game-service/test/di-metadata.positive-control.test.ts`：
 * 那条证明环境**真的**发出元数据，于是本闸拦下的写法不再有存在的理由。
 */
describe('R564 机械闸：测试里不得再有 DI 元数据垫片（P18/N41 收口）', () => {
  it('剥注释后，扫描面内没有任何一处手工垫片', () => {
    const scanned = scanRoots(REPO).flatMap((root) => walk(root));

    // 正对照①：先证明扫描真的读到了文件（否则空数组会让本用例恒绿）。
    expect(scanned.length).toBeGreaterThan(50);

    const offenders = scanned
      .filter((f) => hasParamtypesShim(readFileSync(f, 'utf-8')))
      .map((f) => toPosixPath(f.slice(REPO.length)));

    expect(offenders).toEqual([]);
  });

  it('判别力自证：合成的真垫片（含**多行**形态）走全链必须被报出，注释与其它键不得误报', () => {
    // 造一个与仓库同形的临时树：`<tmp>/packages/<pkg>/test/**`。
    // 这是「全链」自证 —— 不是只测纯函数：`scanRoots` 的枚举、`walk` 的递归、
    // `.ts` 过滤、读盘、判定，任何一环坏掉本用例都会红。
    const sandbox = mkdtempSync(join(tmpdir(), 'p18-gate-'));
    const pkgTest = join(sandbox, 'packages', 'demo-service', 'test');
    const toolTest = join(sandbox, 'tools', 'demo-tool', 'test', 'nested');
    mkdirSync(pkgTest, { recursive: true });
    mkdirSync(toolTest, { recursive: true });

    // ① 单行形态（`health.test.ts` 的写法）—— 必须命中
    writeFileSync(
      join(pkgTest, 'single-line.test.ts'),
      `${REFLECT}.${DEFINE}('${KEY}', [A], B);\n`,
    );
    // ② 多行形态（`ws-allow-request.test.ts` 的写法）—— 必须命中（判别力就在这个 `\s*`）
    writeFileSync(
      join(toolTest, 'multi-line.test.ts'),
      `${REFLECT}.${DEFINE}(\n  '${KEY}',\n  [A, B],\n  C,\n);\n`,
    );
    // ③ 注释里的引用（本仓注释习惯）—— 不得命中
    writeFileSync(
      join(pkgTest, 'comment-only.test.ts'),
      `// 旧写法：${REFLECT}.${DEFINE}('${KEY}', [A], B)\n/* 同上 */\nexport const x = 1;\n`,
    );
    // ④ 其它元数据键 —— 不得命中
    writeFileSync(
      join(pkgTest, 'other-key.test.ts'),
      `${REFLECT}.${DEFINE}('design:returntype', [A], B);\n`,
    );
    // ⑤ 非 `.ts`（不该被扫）
    writeFileSync(join(pkgTest, 'ignored.js'), `${REFLECT}.${DEFINE}('${KEY}', [A], B);\n`);

    try {
      const scanned = scanRoots(sandbox).flatMap((root) => walk(root));
      const offenders = scanned
        .filter((f) => hasParamtypesShim(readFileSync(f, 'utf-8')))
        .map((f) => f.slice(sandbox.length).replace(/\\/g, '/'));

      // 正对照：合成树真的被扫到了全部 4 个 `.ts`（`.js` 被过滤）
      expect(scanned.length).toBe(4);
      expect(offenders.sort()).toEqual([
        '/packages/demo-service/test/single-line.test.ts',
        '/tools/demo-tool/test/nested/multi-line.test.ts',
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
