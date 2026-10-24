/**
 * R572：剥注释器的**判别力闸**。
 *
 * 为什么它自己也要有闸：这个函数唯一的用途是「让别的闸读得更准」，
 * 一旦它剥多了，下游的 §12 闸会**静默变松** —— 那是本仓最贵的失效形态。
 * 所以这里有 ①逐规则判别力 · ②**语料 + 合成样本**的单调性不变量 · ③「引号感知」交叉判据（C1）。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments, type ScannedFile } from './source-scan';

/** 改动前的旧规则（客户端 3 份副本逐字如此）——只作**参照**，用于不变量 ①。 */
function stripCommentsNaive(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * **合成样本**（I1 固定轮：计划 R618 逐字要求「**真实语料 + 合成样本**」，此前只跑了语料）。
 *
 * 为什么必须补：**真实语料按定义是干净的**（7 条闸全绿）⇒ 只跑语料时，不变量① 只在 1/27 个文件上
 * 出现分歧、不变量② 的**前件**（旧实现里确实抓到违规）在 189 对里只成立 **1** 对 —— 两条判据都近真空。
 * 合成样本补的正是语料里**缺席**的形态：
 *  ① `\` 守卫：`/x\//` 这类正则字面量 —— 旧实现会把它之后的**整行尾**当行注释吃掉；语料里只有
 *     一处受这个守卫保护的行 ⇒ 语料面上几乎观测不到「新旧分歧」。
 *  ② **每条谓词都命中一次的违规样本**（`backslash-guard-violations.ts`）：让不变量② 的**前件**在
 *     11 个谓词上都成立一次，而那批违规全部落在 `\` 守卫那一行的**前面** ⇒ 两版视图**真的分歧**、
 *     违规却**都该留下** —— 这正是本不变量要观测的那件事（`\` 守卫只许让视图变长，不许吃掉违规）。
 *  ③ `:` 守卫：`http://` 这类 URL（两版都放行 —— 钉住「守卫没有被误删」）。
 *  ④ **字符串里的 `//`**：两版**都会剥**（C1 的引号盲），放在这里是为了**钉住今天的行为** ——
 *     将来谁去建模字面量，这条样本的期望会跟着变，他会被迫读到「C1 守卫」那一段说明。
 */
const SYNTHETIC_CASES: ScannedFile[] = [
  { path: 'synthetic/backslash-guard.ts', content: 'const r = /x\\//; import y from "vue";' },
  {
    path: 'synthetic/backslash-guard-violations.ts',
    content: [
      "import { s } from '@fight-the-landlord/shared';",
      "const h = require('room-service');",
      "import a from 'lodash';",
      'const t = HandType.Single;',
      'const baseScore = 15;',
      "socket.emit('ping');",
      'const res = await fetch(url);',
      "if (typeof import.meta !== 'undefined') {}",
      'const api = uni;',
      "const face = '大王';",
      'const r = /x\\//;', // ← 这一行的 `\` 守卫让旧实现只剥到 `/x\`，两版视图在这里分歧
    ].join('\n'),
  },
  { path: 'synthetic/url-line.ts', content: "const u = 'http://cdn.example.com/x'; import z from 'vue';" },
  {
    path: 'synthetic/string-embedded-slash.ts',
    content: 'const u = "//cdn.example.com"; const t = HandType.Single;',
  },
];

/** 不变量跑的样本面 = **真实语料 + 合成样本**。 */
const SAMPLES: ScannedFile[] = [...collectSourceFiles(), ...SYNTHETIC_CASES];

// ---------------------------------------------------------------------------
// 不变量② 的谓词面：按**闸自己的定义**抄（不是重写规则）
// —— 见 source-boundary.test.ts / http.test.ts / import-meta-guard.gate.test.ts / uni-api-access.test.ts
// ---------------------------------------------------------------------------

/** ④ 的规则标识符清单（`source-boundary.test.ts` 逐字，**19** 个）。 */
const BANNED_IDENTIFIERS = [
  'isValidHand',
  'isValidPlay',
  'checkRule',
  'checkHand',
  'parseHand',
  'findBeating',
  'findBeatingHand',
  'compareHand',
  'calculateWin',
  'calculateMultiplier',
  'computeMultiplier',
  'computeSpring',
  'isBomb',
  'isRocket',
  'isStraight',
  'isPair',
  'isTriple',
  'canBeat',
  'HandType',
  // ⚠️ R696：`toInternalRank` / `toDouZero` 已从全仓删除 ⇒ 作为禁词无法命中（R377 的死条目）。
  //    与源闸同步删除，20 → 18 条（源闸那边还有 `isValidHand` 等 19 条）。
];

/** ③ 的禁止 import 目标（`source-boundary.test.ts` 逐字）。 */
const FORBIDDEN_IMPORT_TARGETS = [
  'game-service',
  'room-service',
  'user-service',
  'api-gateway',
  'robot-service',
  'tools/mock-server',
  'packages/shared',
  '@fight-the-landlord/shared',
];

/** ③ 的裸依赖精确集合断言里的白名单。 */
const ALLOWED_BARE_IMPORTS = ['@fight-the-landlord/protocol', 'pinia', 'socket.io-client', 'vue'];

const IMPORT_TARGET_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const SHARED_NAMESPACE_RE = /@fight-the-landlord\/[a-z-]+/g;
const BASE_SCORE_ASSIGN_RE = /\b(?:const|let|var)\s+\w*(?:base|unit)?score\w*\s*=\s*[\d_]+/gi;
const BASE_SCORE_CONST_RE = /\b(?:BASE_?SCORE|BASE_SCORE|DEFAULT_SCORE)\b\s*[:=]\s*[\d_]+/g;
const FACE_LITERAL_RE = /['"](?:大王|小王)['"]/g;
const APP_HEARTBEAT_RE = /emit\(\s*['"](?:ping|pong)['"]/;

/** `http.test.ts` ⑤：唯一允许直接调用 `fetch` 的文件。 */
const FETCH_ALLOWED = new Set(['src/net/http.ts']);
const BARE_FETCH_RE = /\bfetch\s*\(/;

/** `import-meta-guard.gate.test.ts` 的三条（逐字）。 */
const IMPORT_META_RES: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /typeof\s+import\.meta\b/, why: 'typeof import.meta' },
  { re: /import\.meta\.url\b/, why: 'import.meta.url' },
  { re: /import\.meta\.(currentScript|resolve)\b/, why: 'import.meta.{currentScript,resolve}' },
];

/** `uni-api-access.test.ts` 的三条（逐字；`g` 标志保留，`test` 前统一重置 `lastIndex`）。 */
const UNI_ALIAS_RES: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /[\w$]+\s*=\s*uni\b(?!\s*\.)/g, why: '把 uni 赋给变量' },
  { re: /\breturn\s+uni\b(?!\s*\.)/g, why: '把 uni 作为值返回' },
  { re: /uni\?\./g, why: '可选链调用 uni?.xxx' },
];

interface ViolationPredicate {
  name: string;
  /** 输入**已剥注释的整份文本**，输出违规描述（空数组 = 无违规）。 */
  offenders: (code: string, path: string) => string[];
}

const VIOLATION_PREDICATES: ViolationPredicate[] = [
  {
    name: '①shared 引用',
    offenders: (code) => (/@fight-the-landlord\/shared/.test(code) ? ['shared'] : []),
  },
  {
    name: '②命名空间集合里的非 protocol 元素',
    offenders: (code) =>
      [...code.matchAll(SHARED_NAMESPACE_RE)]
        .map((m) => m[0])
        .filter((x) => x !== '@fight-the-landlord/protocol'),
  },
  {
    name: '③禁止的 import/require 目标',
    offenders: (code) =>
      [...code.matchAll(IMPORT_TARGET_RE)]
        .map((m) => m[1]!)
        .filter((t) => FORBIDDEN_IMPORT_TARGETS.some((token) => t.includes(token))),
  },
  {
    name: '③裸依赖（白名单之外）',
    offenders: (code) =>
      [...code.matchAll(IMPORT_TARGET_RE)]
        .map((m) => m[1]!)
        .filter((t) => !t.startsWith('.') && !ALLOWED_BARE_IMPORTS.includes(t)),
  },
  {
    name: '④规则标识符（21 个）',
    offenders: (code) => BANNED_IDENTIFIERS.filter((id) => new RegExp(`\\b${id}\\b`).test(code)),
  },
  {
    name: '⑤底分字面量（两条正则）',
    offenders: (code) => [
      ...[...code.matchAll(BASE_SCORE_ASSIGN_RE)].map((m) => m[0]),
      ...[...code.matchAll(BASE_SCORE_CONST_RE)].map((m) => m[0]),
    ],
  },
  {
    name: '⑥自制牌面映射（大王/小王）',
    offenders: (code) => [...code.matchAll(FACE_LITERAL_RE)].map((m) => m[0]),
  },
  {
    name: '⑦应用层心跳',
    offenders: (code) => (APP_HEARTBEAT_RE.test(code) ? ['ping/pong'] : []),
  },
  {
    name: 'http.test.ts ⑤ 裸 fetch(（豁免 src/net/http.ts）',
    offenders: (code, path) =>
      FETCH_ALLOWED.has(path)
        ? []
        : code
            .split('\n')
            .filter((line) => BARE_FETCH_RE.test(line))
            .map((line) => line.trim()),
  },
  {
    name: 'import-meta-guard：import.meta 实体化',
    offenders: (code) =>
      IMPORT_META_RES.filter(({ re }) => re.test(code)).map(({ why }) => `import.meta: ${why}`),
  },
  {
    name: 'uni-api-access：uni 别名/可选链',
    offenders: (code) => {
      const out: string[] = [];
      for (const line of code.split('\n')) {
        for (const { re, why } of UNI_ALIAS_RES) {
          re.lastIndex = 0;
          if (re.test(line)) out.push(`${why}: ${line.trim()}`);
        }
      }
      return out;
    },
  },
];

describe('剥注释器：只删注释，且相对被替换的旧副本只会删得更少（R618/R571）', () => {
  it('删掉三种注释形态', () => {
    expect(stripComments('const a = 1; // 行注释\nconst b = 2;')).not.toContain('行注释');
    expect(stripComments('const a = 1; /* 块注释 */ const b = 2;')).not.toContain('块注释');
    expect(stripComments('<template><!-- 模板注释 --><view/></template>')).not.toContain('模板注释');
  });

  it('不误伤 URL：`http://` 与 `ws://` 里的 `//` 前面的字符是 `:`', () => {
    const src = "const u = 'http://192.168.1.5:3000/api'; import x from 'vue';";
    const out = stripComments(src);
    expect(out).toContain('http://192.168.1.5:3000/api');
    expect(out).toContain("import x from 'vue'");
  });

  it('不误伤正则字面量里的 `\\/\\/`（`\\` 守卫）—— 这是旧实现会吃掉的形态', () => {
    const src = 'const ABSOLUTE = /^https?:\\/\\//i; import y from "vue";';
    const out = stripComments(src);
    expect(out).toContain('/i;');
    expect(out).toContain('import y from "vue"');
    // 旧实现把 `/i; import y from "vue";` 整段当成行注释吃掉 ⇒ 这正是被修掉的**假阴性面**
    expect(stripCommentsNaive(src)).not.toContain('import y from "vue"');
  });

  it('注释里的违规写法不算违规（P19 实测的形态：`require("url")` 只出现在注释里）', () => {
    const src = '// 反面例子：const r = require("url");\nconst ok = 1;';
    expect(stripComments(src)).not.toContain('require');
  });

  it('不变量①：真实语料 + 合成样本上，新实现删掉的**不会比**旧实现多（逐文件长度单调不减）', () => {
    const relaxed: string[] = [];
    let discriminating = 0;
    for (const file of SAMPLES) {
      const before = stripCommentsNaive(file.content).length;
      const after = stripComments(file.content).length;
      if (before !== after) discriminating += 1;
      if (after < before) relaxed.push(`${file.path}: ${before} → ${after}`);
    }
    expect(relaxed, `新剥注释删得更多 ⇒ 下游闸可能变松：\n${relaxed.join('\n')}`).toEqual([]);
    // 判别力自证（R179/R193③ 同族）：样本面里必须**真的**有让新旧分歧的样本，否则本不变量恒真。
    expect(
      discriminating,
      '样本面（语料 + 合成）里没有任何一条让新旧实现分歧 ⇒ 本不变量在样本面上恒真',
    ).toBeGreaterThan(0);
  });

  /**
   * **不变量② 的范围（I1 固定轮订正 —— 别把标题读成比它更强的东西）**
   *
   * ✅ **在范围内**（读「整份剥注释文本」的违规谓词，逐条按闸自己的定义抄）：
   *    · `source-boundary.test.ts` 的 7 条 §12 判据 —— 含**全部 21 个**禁用标识符、⑤ 的**两条**
   *      底分正则、⑥ 的 `大王`/`小王`、②/③ 两条**精确集合断言**里「集合出现了不该出现的元素」谓词；
   *    · `http.test.ts` ⑤ 的裸 `fetch(`（豁免 `src/net/http.ts`）；
   *    · `import-meta-guard.gate.test.ts` 的 3 条 `import.meta` 实体化形态；
   *    · `uni-api-access.test.ts` 的 3 条 uni 别名/可选链形态。
   *
   * ❌ **范围外**（**不是漏了**，是它们的「视图」**不是**整份剥注释文本）：
   *    · `ui-tokens.test.ts` 的 px / 非 rpx 单位 / 裸色值 / `lang="scss"` / token 定义五条 ——
   *      它们读的是 `<style>` 块**提取**后的文本，且要先过 R619 **故意保留**的那份 `(scss: string)`
   *      两规则变体；把 px 谓词搬进来就得在**本文件**再抄一份 SCSS 变体 ⇒ 那正是 N46 记的
   *      「剥离器副本」病灶（B₂ 取数会多算一处，读数 7 → 8）。它们各自带合成正对照，判别力不靠本不变量。
   *
   * ⚠️ 与本不变量**无关**的那一处（C1）：它只能证明「相对**被替换的旧副本**没变松」，
   * 证明不了「相对**原始文本**没变松」—— 后者由下面的「C1 守卫」盯着。范围边界见 `source-scan.ts` 的 JSDoc。
   */
  it('不变量②：真实语料 + 合成样本上，旧实现抓到的违规，新实现必须仍抓到（范围见上方注释）', () => {
    const relaxed: string[] = [];
    let antecedent = 0;
    for (const file of SAMPLES) {
      const oldCode = stripCommentsNaive(file.content);
      const newCode = stripComments(file.content);
      for (const { name, offenders } of VIOLATION_PREDICATES) {
        const oldHits = offenders(oldCode, file.path);
        if (oldHits.length === 0) continue; // 前件不成立 ⇒ 这一对不构成证据
        antecedent += 1;
        const newHits = new Set(offenders(newCode, file.path));
        const missed = [...new Set(oldHits.filter((hit) => !newHits.has(hit)))];
        if (missed.length > 0) relaxed.push(`${file.path}: ${name} → 漏掉 ${missed.join(' / ')}`);
      }
    }
    expect(relaxed, `新实现漏掉了旧实现抓到的违规：\n${relaxed.join('\n')}`).toEqual([]);
    // 判别力自证：前件一次都没成立的话，本不变量是「真空绿」。
    expect(antecedent, '前件在样本面上从未成立 ⇒ 本不变量恒真（真空绿）').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C1 守卫：把「引号盲」从静默盲点变成红闸
// ---------------------------------------------------------------------------

/**
 * 判据：`stripComments` 的**删除集必须恰好等于**一个「引号感知」扫描器认定的注释跨度集。
 *
 * 为什么需要它（C1）：本闸的剥注释器**不建模字符串/模板字面量** —— 字面量里的 `//`、`/*`、`<!--`
 * 会被当成注释起点，于是「字符串吞掉后面的真代码」，而 7 条 §12 判据现在读的正是剥注释视图
 * ⇒ 那是相对「按原始文本匹配」的一处**已知变松**。本判据把这件事变响：
 * 只要剥注释器删掉了**引号内**的任何字符，两个实现就会分歧 ⇒ 当场红。
 *
 * ⚠️ 这个扫描器**故意比剥注释器更保守**（它认识引号），所以两者的**分歧就是证据**。
 * 它同样只认「引号外」的三种注释起点，且与剥注释器一样把 `\` 当转义（跳过下一字符）。
 */
function commentSpansQuoteAware(source: string): [number, number][] {
  const spans: [number, number][] = [];
  type State = 'code' | 'single' | 'double' | 'template' | 'line' | 'block' | 'html';
  let state: State = 'code';
  let start = 0;
  for (let i = 0; i < source.length; ) {
    const c = source.charAt(i);
    if (state === 'code') {
      if (c === '\\') {
        i += 2; // 转义 / 正则字面量：跳过下一字符（覆盖 `\/\/`）
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
        i += 1;
        continue;
      }
      if (c === '/' && source.charAt(i + 1) === '/') {
        state = 'line';
        start = i;
        i += 2;
        continue;
      }
      if (c === '/' && source.charAt(i + 1) === '*') {
        state = 'block';
        start = i;
        i += 2;
        continue;
      }
      if (source.startsWith('<!--', i)) {
        state = 'html';
        start = i;
        i += 4;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (c === '\\') {
        i += 2; // 字面量里的转义：`'\''` / `"\\"` / `` `\`` ``
        continue;
      }
      if (c === (state === 'single' ? "'" : state === 'double' ? '"' : '`')) state = 'code';
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        spans.push([start, i]);
        state = 'code';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && source.charAt(i + 1) === '/') {
        spans.push([start, i + 2]);
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // html：`<!-- … -->`
    if (source.startsWith('-->', i)) {
      spans.push([start, i + 3]);
      state = 'code';
      i += 3;
      continue;
    }
    i += 1;
  }
  // 收尾：**只**有未闭合的 `//` 算一个到文本末尾的跨度（剥注释器的 `//[^\n]*` 同样吃到末尾）。
  // 未闭合的 `/*` 与 `<!--` **不算**：剥注释器的 `[\s\S]*?\*\/` / `[\s\S]*?-->` 找不到配对时
  // 整段不匹配 ⇒ 一个字都不删。两侧在这两种形态上必须一致，否则本判据会在真实文件上误红。
  if (state === 'line') spans.push([start, source.length]);
  return spans;
}

/** 把 `commentSpansQuoteAware` 认定的每个跨度**换成一个空格**，其余原样（与剥注释器同构）。 */
function blankedLikeSpans(source: string): string {
  let out = '';
  let prev = 0;
  for (const [from, to] of commentSpansQuoteAware(source)) {
    out += `${source.slice(prev, from)} `;
    prev = to;
  }
  return out + source.slice(prev);
}

describe('C1 守卫：剥注释器的删除集 == 引号感知扫描认定的注释跨度集', () => {
  it('删除集 == 引号感知扫描认定的注释跨度（字面量里的 `//` 不算注释）', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      if (stripComments(file.content) !== blankedLikeSpans(file.content)) offenders.push(file.path);
    }
    expect(offenders, `剥注释器删掉了引号内/非注释的内容：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('判别力自证：C1 的两个合成样本上两者**必须分歧**，引号外的真注释上**必须一致**', () => {
    /**
     * C1 的两个最小复现（协调者复现原文，逐字）：
     *  ① `const u = "//cdn.example.com"; const t = HandType.Single;` ⇒ 剥完 `const u = " `，④ 看不到 `HandType`；
     *  ② `'src/**'` 里的 `/*` 与**下一行**的 `/** doc *\/` 配成一对块注释 ⇒ 中间的 `HandType` 整行被吃掉。
     */
    const c1Samples = [
      'const u = "//cdn.example.com"; const t = HandType.Single;',
      "const p = 'src/**';\nconst t = HandType.Single;\n/** doc */\nconst keep = 1;",
    ];
    for (const src of c1Samples) {
      expect(
        stripComments(src),
        `本判据对这一形态失灵（两者一致）⇒ 引号盲又回来了：\n${src}`,
      ).not.toBe(blankedLikeSpans(src));
    }
    // 反向：**真**注释（引号外）必须一致，否则这条判据只会「恒红」（红也不说明引号盲）。
    const agreeing =
      'const a = 1; // 行注释\nconst b = 2; /* 块注释 */\n<template><!-- 模板注释 --></template>';
    expect(stripComments(agreeing)).toBe(blankedLikeSpans(agreeing));
    // 而且上面那条「一致」不能是「两边都没动」造成的 —— 引号感知扫描器确实认出了三种注释跨度。
    expect(commentSpansQuoteAware(agreeing)).toHaveLength(3);
    // 语料面的判别力：真实文件里确实有大量注释被两侧一致地识别（不是空集比对）。
    const spansOnCorpus = collectSourceFiles().reduce(
      (n, file) => n + commentSpansQuoteAware(file.content).length,
      0,
    );
    expect(spansOnCorpus, '引号感知扫描器在语料上一处注释都没认出 ⇒ 主判据是真空绿').toBeGreaterThan(
      100,
    );
  });
});
