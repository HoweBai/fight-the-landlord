/**
 * **台账 N46 的机械闸**：注释剥离器的「唯一真源」对账 —— 防第 N 份私有副本复活。
 *
 * ## 背景（为什么这条闸长这样）
 *
 * 本仓的注释剥离器曾散出 **8 份私有副本**（api-gateway×3 / protocol / robot-service /
 * room-service×2 / user-service），且分属**两套语义**（带 `:` 守卫 vs 不带）——
 * 不带守卫的副本会把 `"http://evil/api/games"` 截成 `"http:`，**把真违规喂给判据看不见**。
 * N46 把它收敛为唯一真源 `packages/test-utils/src/strip-comments.ts`。
 *
 * ## 判据（两层，一起报 —— N46 的三层教训：**任何单层都不够**）
 *
 *  - **名字族（A+B₂）**：`function strip…Comment(s)(` 与 `const strip…Comment(s) =`
 *    两种声明形式。⚠️ 这层**只按名字**：族外改名 / 无名字（原地内联）会逃逸；
 *  - **结构族（C，兜底）**：块注释的「删除式」形态（`replace(块注释正则, 空串)`）——
 *    与名字、写法无关。⚠️ 它依赖那个字面形态：一个手写状态机式剥离器**两层全逃**
 *    （N46 逐字登记过这条残余）—— 那一层只能靠人评审，别把本闸当全覆盖。
 *
 * ⚠️ **两层读法不同**（都是被实测逼出来的，不是随意的）：
 *  - 名字层**先剥注释**（用真源本体 —— 它也是 test-utils 的第一个生产消费者）：
 *    否则「注释里解释这条闸」的散文（如说明文字里写出定义形态）会**自造假红**，
 *    而假红的诱人修法是给闸开白名单 —— 把判别力换成豁免权（N46 原文警告过这一类）；
 *  - 结构层**读原始文本**：真源自身的正则字面量里 `\*\//g` 的两处相邻斜杠会被本剥离器的
 *    「行注释」规则误剥（它对正则字面量的已知边界）⇒ 剥完反而**看不见真源自己**。
 *    代价：注释里**逐字**引用这个删除式的散文也会命中 —— 处置是把注释改写成指针
 *    （指向真源），不是给闸开白名单。
 *
 * ⚠️ **判据涉及的样本形态由片段拼出**：本文件自身也在扫描面里（`packages/`），
 * 若把定义形态/结构字面量**原样**写进本文件，闸会命中**自己**。
 * 同款纪律先例：`no-di-metadata-shim.gate.test.ts` 的 REFLECT/KEY 拼接。
 *
 * ## 扫描面与已知边界
 *
 *  - 面 = `packages/*` 与 `tools/*` 下全部 `.ts`（跳过 `node_modules` / `dist` / 点目录）；
 *  - **`apps/client` 刻意不在面内**：客户端侧有自己的 canonical（`apps/client/test/helpers/
 *    source-scan.ts`，引号感知、另一层契约）与 P25 立的三层判据（含 oracle 与故意保留的
 *    SCSS 变体）—— 那是**另一件事**，不归这条闸管（台账 N46 的「客户端侧余量」条目）；
 *  - 允许集**恰好一份**且必须**命中**：`toEqual([真源])` 同时完成「哨兵非空」与
 *    「零 offenders」两件事 —— 真源被改名/被删时命中集会变空，闸照样红（不自欺）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 真源本体：本闸**先剥注释再匹配**（原因见上）。它也是 test-utils 的第一个生产消费者。
import { stripComments } from '@fight-the-landlord/test-utils';

/** 从本文件所在目录向上找仓库根（锚 = `packages/shared` + `packages/protocol`；找不到抛错）。 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/shared/package.json 且 name 校验通过 + packages/protocol）');
}

const REPO = findRepoRoot();

/** 递归列 `.ts`（跳过 `node_modules` / `dist` / 点目录）。 */
function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // 目录不存在（如 tools/ 被移走）⇒ 不静默：下方哨兵会把空扫兜红
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SCANNED: string[] = ['packages', 'tools']
  .flatMap((group) => walk(join(REPO, group)))
  .map((file) => relative(REPO, file).split(sep).join('/'))
  .sort();

/** 真源（唯一允许命中者）；下一条用例同时断言它**必须**命中。 */
const CANONICAL = 'packages/test-utils/src/strip-comments.ts';

/**
 * 名字族（A+B₂）：两种**声明**形式的家族正则（只按名字 —— 见文件头「残余」说明）。
 *
 * ⚠️ `(?!Docker)` 是按**语义**排除，不是豁免名单：`stripDockerComments` 是两处 Dockerfile
 * 闸自带的局部工具（剥的是 `#` 开头的 Dockerfile 注释 —— 另一种语法、另一种事），
 * 与「JS/TS 注释剥离器」不是同一对象。判别力自证里有它的负样本。
 */
const NAME_FAMILY = [
  /function\s+strip(?!Docker)[A-Za-z]*Comments?\s*\(/,
  /\bconst\s+strip(?!Docker)[A-Za-z]*Comments?\s*=/,
];

/** 结构族（C）的针：块注释「删除式」形态。⚠️ 由片段拼出（本文件不得原样包含它）。 */
const STRUCT_NEEDLE = ['replace(/\\/', '\\*[\\s\\S]*?\\*', "\\//g, '')"].join('');

/** 命中判定（两层读法不同 —— 见文件头；名字层剥注释，结构层读原文）。 */
function isCopyCandidate(raw: string): boolean {
  const code = stripComments(raw);
  return NAME_FAMILY.some((re) => re.test(code)) || raw.includes(STRUCT_NEEDLE);
}

describe('N46：注释剥离器「唯一真源」的结构性对账闸', () => {
  it('哨兵（R179 型）：扫描面非空、含已知成员与真源（防 walk 失效恒绿）', () => {
    expect(SCANNED.length, '扫描面为空 —— walk 坏了？').toBeGreaterThan(100);
    expect(SCANNED).toContain(CANONICAL);
    expect(SCANNED).toContain('packages/api-gateway/test/no-raw-console.test.ts');
    expect(SCANNED).toContain('packages/shared/test/comment-stripping-single-source.gate.test.ts');
  });

  it('名字族（A+B₂）：定义恰好只有真源一处；真源必须在命中集里（双向自证）', () => {
    const offenders = SCANNED.filter((rel) => {
      const code = stripComments(readFileSync(join(REPO, ...rel.split('/')), 'utf-8'));
      return NAME_FAMILY.some((re) => re.test(code));
    });
    expect(
      offenders,
      `注释剥离器的私有副本复活了（台账 N46 已收敛为唯一真源）：${offenders.join(', ')}`,
    ).toEqual([CANONICAL]);
  });

  it('结构族（C，与名字无关）：块注释「删除式」形态也只有真源一处（**读原始文本**）', () => {
    // ⚠️ 这一层**不先剥注释**：真源自己的正则字面量会被本剥离器的行注释规则误剥
    //（`\*\//g` 的相邻斜杠 —— 它对正则字面量的已知边界）⇒ 剥完反而看不见真源。
    // 代价（注释里逐字引用该删除式的散文也会命中）见文件头 —— 处置是指针化注释。
    const offenders = SCANNED.filter((rel) =>
      readFileSync(join(REPO, ...rel.split('/')), 'utf-8').includes(STRUCT_NEEDLE),
    );
    expect(
      offenders,
      `块注释剥离的「删除式」实现出现第二处（台账 N46）：${offenders.join(', ')}`,
    ).toEqual([CANONICAL]);
  });

  it('判别力自证：A 形态 / B₂ 箭头形态 / C 结构形态都必须被看见；使用点、注释与 Dockerfile 变体不得误伤', () => {
    // 正：A 形态（本仓曾用过 6 次；样本由片段拼出，防本文件自命中）
    expect(isCopyCandidate('function str' + 'ipComments(src: string): string { return src; }')).toBe(true);
    // 正：B₂ 形态（user-service 的那份 —— 纯 A 判据**抓不到它**，N46 逐字登记）
    expect(isCopyCandidate('const str' + 'ipComments = (text: string): string => text;')).toBe(true);
    // 正：C 形态（无名字、族外改名都拦得住 —— 结构兜底的意义）
    expect(isCopyCandidate('const y = render.' + STRUCT_NEEDLE + ';')).toBe(true);
    // 负：import 使用点（收敛后的正常形态）
    expect(isCopyCandidate("import { stripComments } from '@fight-the-landlord/test-utils';")).toBe(false);
    // 负：注释里写出定义形态（名字层先剥注释 ⇒ 不算副本；否则闸会打自己）
    expect(isCopyCandidate('// 不要写 function str' + 'ipComments(...)：见台账 N46')).toBe(false);
    // 负：近似但无关的名字不得误伤
    expect(isCopyCandidate('const stripIndentCommentsCount = 0;')).toBe(false);
    // 负：Dockerfile 的 `#` 注释剥离器（另一种语法、另一种事 —— 按语义排除，不是豁免名单）
    expect(isCopyCandidate('function str' + 'ipDockerComments(src: string): string[] { return []; }')).toBe(false);
    // 负：改写成等长空白的实现不是「删除式」（room-service 的 blankComments —— 刻意保留的变体）
    expect(isCopyCandidate('const y = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, (m) => bl' + "ank(m));")).toBe(false);
  });
});
