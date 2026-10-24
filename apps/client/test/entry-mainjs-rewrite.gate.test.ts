/**
 * 机械判据（N39 回填）：**`src/main.ts` 里 `createSSRApp` 的第一次出现必须落在 import 行上。**
 *
 * ## 为什么这条闸存在（实测的**静默白屏**：App 端整屏白、控制台全空）
 *
 * uni-app 的 App 端入口插件（`@dcloudio/uni-app-vite/dist/vue/plugins/mainJs.js` 的
 * `uniMainJsPlugin`）不是"编译"入口，而是**在入口源码上做一次字符串替换**：
 *
 * ```js
 * code.replace('createSSRApp', 'createVueApp as createSSRApp')
 * ```
 *
 * 于是 `import { createSSRApp } from 'vue'` 变成
 * `import { createVueApp as createSSRApp } from 'vue'` —— 而 `createVueApp` 正是 uni-app
 * 打过补丁的 Vue 运行时里的 `createApp`（客户端应用）。
 *
 * ### 陷阱：`String.prototype.replace` 传**字符串**模式时**只替换第一处**
 *
 * 它不认识注释。只要在 import **之前**的任何位置（**注释里也算**）出现过这个字面量，
 * 那次唯一的替换就落在那里 —— 而注释在随后的编译里被剥掉 ⇒ **真正的 import 与调用原封不动**。
 *
 * ⇒ App 端拿到的是 `createSSRApp`（**SSR 应用**），不是 `createVueApp`（客户端应用）。
 * ⇒ 它**不抛错**：`createApp()` 全程跑完、`console.log` 全部照常回传、`app.mount()` 也调了，
 *   但**首屏永不渲染** —— 纯白屏，且 `onError`/`onUnhandledRejection` 都收不到任何东西。
 *
 * ### 为什么这条闸要读**原始文本**（而不是像别的闸那样先 `stripComments`）
 *
 * 恰恰因为**注释就是肇事者**：先剥注释，这条闸就永远看不见那个抢走替换的字面量。
 * ⚠️ `helpers/source-scan.ts` 的 `stripComments` 在这里**必须不用**。
 *
 * ### 为什么 H5 与小程序端没暴露它
 *
 * H5/小程序的入口插件做同样的替换，但它们的 `vue` 就是**真的 Vue**（`createSSRApp` 合法可用）
 * ⇒ 替换落空也不影响渲染。**只有 App 平台**的 `vue` 是打过补丁的运行时，两种工厂语义不同。
 *
 * ## 正确的写法
 *
 * 入口里该字面量的**第一次出现**必须是那行 import；要解释这个坑，把说明写在 import **之后**。
 *
 * ## 复现（2026-09-19 实测）
 *
 * 该字面量第一次出现在一句文档注释里（`src/main.ts:11`）⇒ App 端白屏；
 * 把注释措辞换掉、让 import 抢回第一处后重建，产物立刻由
 * `const app = vue.createSSRApp(App)` 变成 `const app = vue.createVueApp(App)`。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT } from './helpers/source-scan';

/** 被插件替换的字面量。 */
const LITERAL = 'createSSRApp';

/** 合法的"第一处"形态：`import { createSSRApp } from 'vue'`。 */
const IMPORT_LINE_RE = /^\s*import\s*\{[^}]*\bcreateSSRApp\b[^}]*\}\s*from\s*['"]vue['"]/;

/**
 * 找出违规（返回 `文件:行: 原因` 列表）。
 *
 * **纯函数**：只看原始文本，便于用合成样本自证判别力（本仓闸的既有约定）。
 */
export function entryRewriteOffenders(source: string): string[] {
  const index = source.indexOf(LITERAL);
  const lines = source.split(/\r?\n/);
  if (index < 0) {
    return [
      `src/main.ts: 找不到 \`${LITERAL}\` —— 入口工厂的绑定形态变了，本闸的判据需要跟着改（不要直接删掉本闸）`,
    ];
  }
  const line = source.slice(0, index).split(/\r?\n/).length;
  const text = lines[line - 1] ?? '';
  if (IMPORT_LINE_RE.test(text)) return [];
  return [
    `src/main.ts:${line}: \`${LITERAL}\` 的第一次出现不在这行 import 上 —— ` +
      `uni-app 的入口替换会落在这里（随后被剥掉），App 端会拿到 SSR 应用而静默白屏。` +
      `该行内容：${text.trim().slice(0, 120)}`,
  ];
}

describe('N39 入口改写：`createSSRApp` 的第一次出现必须在 import 行上', () => {
  it('src/main.ts 通过', () => {
    const offenders = entryRewriteOffenders(readFileSync(join(SRC_ROOT, 'main.ts'), 'utf8'));
    expect(offenders, `入口被注释抢走了字符串替换 ⇒ App 端静默白屏：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('判别力正对照：注释抢先时闸报错，import 在首位时放行', () => {
    const bad = [
      // ① 注释抢走第一处（N39 的真实形态）
      `/** 内部用 \`createSSRApp\` 装配 */\nimport { createSSRApp } from 'vue';\nconst app = createSSRApp(App);`,
      // ② 换行注释同样会抢
      `// 见 createSSRApp 的说明\nimport { createSSRApp } from 'vue';`,
    ];
    const good = [
      `import { createSSRApp } from 'vue';\n/** 不要在这行之前写 \`createSSRApp\` */\nconst app = createSSRApp(App);`,
      `import { createSSRApp } from 'vue';\nconst app = createSSRApp(App);`,
    ];
    expect(entryRewriteOffenders(bad[0])).toHaveLength(1);
    expect(entryRewriteOffenders(bad[1])).toHaveLength(1);
    expect(entryRewriteOffenders(good[0])).toEqual([]);
    expect(entryRewriteOffenders(good[1])).toEqual([]);
  });

  it('扫描器确实读到了真实入口（否则本闸是空测）', () => {
    const source = readFileSync(join(SRC_ROOT, 'main.ts'), 'utf8');
    expect(source).toContain('export function createApp');
    expect(source).toContain(LITERAL);
  });
});
