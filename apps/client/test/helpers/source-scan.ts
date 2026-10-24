/**
 * 源码扫描器（供 §12 的依赖边界与「不得含规则」断言使用）。
 *
 * 只读 `apps/client/src`，不读 `test/`——测试里出现规则词汇是允许的
 * （断言本身就要写出被禁止的标识符）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScannedFile {
  /** 相对 apps/client 的路径，例如 `src/net/socket.ts` */
  path: string;
  content: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** test/helpers → apps/client */
export const APP_ROOT = resolve(HERE, '..', '..');
export const SRC_ROOT = join(APP_ROOT, 'src');

/**
 * 扫描面。Task 2（切片 P10）起把 **`.scss`** 也算进来：design token 的**单一真源**是
 * `src/uni.scss`（uni-app CLI 把它的内容注入每一个 `lang="scss"` 块）——
 * 不扫它就等于「token 闸读不到 token 文件」。
 */
const SOURCE_EXTENSIONS = ['.ts', '.vue', '.js', '.json', '.scss'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

export function collectSourceFiles(): ScannedFile[] {
  return walk(SRC_ROOT).map((full) => ({
    path: relative(APP_ROOT, full).split('\\').join('/'),
    content: readFileSync(full, 'utf8'),
  }));
}

export function readAllSources(): string {
  return collectSourceFiles()
    .map((f) => f.content)
    .join('\n');
}

/**
 * 去掉注释，返回**可扫描的代码文本**（R572）。
 *
 * ## 为什么必须有它
 *
 * 本仓的注释习惯是**逐字引用真实写法**：解释一个坑时就会写出 `require("url")`、`const api = uni`、
 * `emit('ping')`、`@fight-the-landlord/shared`、裸 `fetch(`、`typeof import.meta`。按原始文本匹配会把
 * **解释本身**打红 ⇒ 唯一能让人变绿的做法是**删掉解释** —— 那是把判别力换成注释洁净度，方向反了。
 * （本仓已实测三次：`ui-tokens` · `uni-api-access` · P19 的 `require("url")`；上面这串例子就是 Task 3
 * 收敛掉的 4 份副本**各自**在头注释里点名过的形态。）
 *
 * ## 规则（只有三条，且**保守**）
 *
 *  ① `<!-- … -->`（`.vue` 模板里的 HTML 注释）⇒ 换成空格；
 *  ② `/* … *\/`（块注释 / JSDoc）⇒ 换成空格；
 *  ③ `//…`（行注释）⇒ 换成一个空格 —— **但前一个字符是 `:` 或 `\` 时不动**：
 *     · `:` 覆盖 `http://` / `ws://`（URL 出现在代码与字符串里是常态，`src/net/http.ts` 就有）；
 *     · `\` 覆盖正则字面量里的 `\/\/`（`src/net/http.ts:147` 的 `/^https?:\/\//i`）——
 *       没有这个守卫时，那个正则的**行尾**会被当成行注释吃掉（`comment-stripping.test.ts` 的第 3 条钉住它）。
 *
 * ## 已知边界（**故意**不处理的）
 *
 *  · **对引号盲（quote-blind）：本剥注释器不建模字符串/模板字面量** —— 字面量里的 `//`、`/*`、
 *    `<!--` 会被当成**注释起点**，于是它之后（`//` 到行尾；`/*`、`<!--` 则连**后续各行**）的文本
 *    从闸的视图里**消失**。两个最小复现：
 *      · `const u = "//cdn.example.com"; const t = HandType.Single;` ⇒ 剥完只剩 `const u = " `（④ 看不到 `HandType`）；
 *      · `const p = 'src/**';⏎const t = HandType.Single;⏎/** doc *\/⏎const keep = 1;` ⇒
 *        `'src/**'` 里的 `/*` 与**下一行**的 `/** doc *\/` 配成一对块注释，把中间那行 `HandType` 整段吃掉。
 *    ⇒ 相对「按**原始文本**匹配」，这是把 7 条 §12 判据切到剥注释视图时引进的**一处已知的变松**。
 *    ⚠️ **`comment-stripping.test.ts` 的两条不变量兜不住它**：那不变量比的是**新实现 vs 被它替换掉的旧副本**，
 *    而两者的规则 ①（`<!-- -->`）/②（`/* *\/`）**逐字节相同**（只有 ③ 的 `\` 守卫不同）⇒ 规则 ①/② 在
 *    那不变量里**根本不受约束**；它们证明的是「**收敛没有比它替换掉的副本删得更多**」
 *    （canonical 的删除集 ⊆ 旧副本的删除集），**不**比较**原始文本 vs 剥注释文本** —— 而那正是这 7 条闸实际做的那一步。
 *    ⚠️ 建模字面量是一次**契约变更**，归台账 **N46**（同一层：剥注释契约的余量）⇒ 需**单独裁决**。
 *    今天语料**零命中**（实测：`src/**` 里**非注释性**的 `//` 出现都被 `:`（URL）或 `\`（正则）保护），
 *    且**这一处已经上了闸**：`comment-stripping.test.ts` 的「C1 守卫」用一个**引号感知**的独立扫描器
 *    逐文件比对 —— 只要本函数删掉了**引号内**的任何字符，那条判据**当场红**（R435：宁红不放宽）。
 *  · **不建模正则字面量的起止**：只靠 `\` 守卫覆盖 `\/\/`。
 *
 * ⚠️ **唯一实现**（R617/R623）：`apps/client/test/**` 下不得再出现第二份完整实现。
 * 判据必须**名字无关**且**排除 helper 自身**（`--exclude-dir=helpers`）—— 单名模式两个方向都会失灵：
 *
 *  · 少写 `(` 的 `function stripComments` 会**子串命中** Ruling C1 要求的局部 oracle
 *    `stripCommentsNaive`（`comment-stripping.test.ts:12`）⇒「副本只剩 SCSS 变体」这条标准
 *    **永远无法观测**（误报）；
 *  · 带上 `(` 虽避开了 oracle，却仍会**漏掉改名副本** `stripSfcComments`（Task 3 收敛**前**在
 *    `ui-tokens.test.ts:33`，与其余三份**逐字相同**的完整三规则实现；该行现在已是 `styleOpenTags`
 *    的 return）⇒ 收敛后 grep 干净、第二份完整实现却还在跑（漏报）。
 *    漏报比误报危险得多，所以判据不能依赖函数名。
 *
 * ```
 * # 副本（真源以外）：Task 1 落地时 = 5 行；Task 3 收敛后 = 1 行（只剩 ui-tokens.test.ts 的 (scss: string)
 * # 两规则变体 —— R619 故意保留：并入会给它加上 `<!-- -->` 规则 ⇒ 删得更多 ⇒ 更松）
 * grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers
 * # 完整三规则副本：Task 1 落地时 = 4 行；Task 3 收敛后 = 0
 * grep -rnE "function strip[A-Za-z]*Comments?\(source: string\)" apps/client/test --exclude-dir=helpers | wc -l
 * ```
 *
 * **Task 1 落地时的 4 份完整副本**（三条规则逐字相同）：`uni-api-access.test.ts:25` ·
 * `import-meta-guard.gate.test.ts:43` · `http.test.ts:252` · `ui-tokens.test.ts:33`
 * （`stripSfcComments` —— 唯一改了名的一份）；Task 3 已把这 4 份全部换成对上面这个 export 的 import。
 */
export function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}
