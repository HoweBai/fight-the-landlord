/**
 * 机械判据（切片 P19）：**`src/**` 不得出现 `typeof import.meta` 或 `import.meta.url`**。
 *
 * ## 为什么这条闸存在（实测的**阻断级**缺陷，微信小程序端整包挂掉）
 *
 * 这两个写法会逼打包器把 `import.meta` **实体化**，产物里变成：
 *
 * ```js
 * { url: typeof document === 'undefined'
 *     ? require("url").pathToFileURL(__filename).href
 *     : document.currentScript?.src ?? new URL(<file>, document.baseURI).href }
 * ```
 *
 * 微信小程序的 **service 上下文没有 `document`** ⇒ 只能走 `require("url")` 分支 ⇒
 * 小程序的模块系统里**没有 Node 的 `url`** ⇒ 抛
 * `Error: module 'url.js' is not defined, require args is 'url'`
 * ⇒ **`app.js` 整条模块图在求值期中断**。
 * 连带症状（看起来像另一个 bug）：`Page "pages/login/login" has not been registered yet.`
 * —— 因为页面注册代码在 `app.js` 求值之后才执行，而它前面就崩了。
 *
 * **用户实测的原文**（N39 回填，微信开发者工具 3.17.2）：
 * `module 'url.js' is not defined, require args is 'url'` + `Page "pages/login/login" has not been registered yet.`
 *
 * ## 正确的写法
 *
 * 只用**直接的属性访问**（`import.meta.env.VITE_X` / `import.meta.env?.[key]`）——
 * 它们在**构建期**被替换成字面量，`import.meta` 本身不再需要被实体化。
 *
 * ## 为什么还要有产物级判据
 *
 * 本闸只拦**我们自己的源码**；**依赖**同样可能引入那个 helper ⇒
 * `scripts/build-mp-weixin.mjs` 在构建成功后还会扫一遍 `dist/{build,dev}/mp-weixin`，
 * 发现 `require("url")` / `pathToFileURL` 就**非零退出**（两条防线互补，缺一不可）。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

/** 违规形态：强制打包器实体化 `import.meta` 的两种写法（`import.meta.env` 不在此列）。 */
const OFFENDING = [
  { re: /typeof\s+import\.meta\b/, why: '`typeof import.meta` 会让打包器实体化 import.meta' },
  { re: /import\.meta\.url\b/, why: '`import.meta.url` 会让打包器实体化 import.meta' },
  { re: /import\.meta\.(currentScript|resolve)\b/, why: '`import.meta.*` 的非常规成员同样会实体化 import.meta' },
];

/** 找出违规（返回 `文件: 原因` 列表）。**纯函数，便于用合成样本自证判别力。** */
function importMetaOffenders(files: { path: string; content: string }[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(file.content);
    for (const { re, why } of OFFENDING) {
      if (re.test(source)) offenders.push(`${file.path}: ${why}`);
    }
  }
  return offenders;
}

const sources = collectSourceFiles();

describe('P19 ① `src/**` 不得实体化 import.meta（微信小程序端会 require("url") 而崩）', () => {
  it('源码里没有 typeof import.meta / import.meta.url', () => {
    const offenders = importMetaOffenders(sources);
    expect(
      offenders,
      `以下写法会让打包器生成 require("url") 分支，微信小程序的 service 里没有 document ⇒ 必抛\n` +
        `（正确写法：import.meta.env.VITE_X / import.meta.env?.[key]）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('判别力正对照：闸对合成样本报错，对合法写法放行', () => {
    const bad = [
      { path: 'a.ts', content: `const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;` },
      { path: 'b.ts', content: `const here = import.meta.url;` },
    ];
    const good = [
      { path: 'c.ts', content: `const v = import.meta.env.VITE_WS_ENDPOINT;` },
      { path: 'd.ts', content: `const v = import.meta.env?.[key] as string | undefined;` },
      // 注释里出现是允许的（本仓注释习惯引用真实写法）
      { path: 'e.ts', content: `// 反例：typeof import.meta / import.meta.url\nconst v = import.meta.env.VITE_A;` },
    ];
    expect(importMetaOffenders(bad)).toHaveLength(2);
    expect(importMetaOffenders(good)).toEqual([]);
  });

  it('扫描器确实读到了环境变量读取点（否则本闸是空测）', () => {
    const text = sources.map((f) => f.content).join('\n');
    expect(text).toContain('import.meta.env');
    expect(sources.map((f) => f.path)).toContain('src/config.ts');
  });
});
