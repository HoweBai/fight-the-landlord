/**
 * §8 动效的**机械闸**。
 *
 * ⚠️ **判据射程（诚实版）**：jsdom **不注入 CSS、不跑动画** ⇒ 这里**不证明**动效好看、
 * 流畅或时长合适。它只钉三件**会静默失效**的事：
 *  ① `prefers-reduced-motion` 降级**存在**（spec §8 的「必须」，不是可选项）；
 *  ② 动效**不新造时钟**（§9.6 同族纪律：牌桌区不得有 `setTimeout`/`setInterval`）；
 *  ③ 降级块**不是空壳**（正反对照证明它真的能判）。
 *
 * 观感（错峰顺不顺、时长对不对）只能由真浏览器 / App 走查证明 —— **不要造假判据**。
 */
import { describe, expect, it } from 'vitest';
import { REDEAL_BANNER_MS } from '../src/composables/useRedealNotice';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
const anim = sources.find((f) => f.path === 'src/styles/animations.scss');

describe('§8 动效', () => {
  it('styles/animations.scss 存在，且定义了 reduced-motion 降级（spec §8 的「必须」）', () => {
    expect(anim, 'src/styles/animations.scss 必须存在').toBeDefined();
    expect(anim!.content, '必须有 prefers-reduced-motion 媒体查询').toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    );
    expect(anim!.content, '降级里必须关掉 animation').toMatch(/animation:\s*none/);
  });

  it('降级是**正反对照**可判的（合成样本：合规样本必须命中、缺降级的样本必须不命中）', () => {
    const hasReducedMotion = (src: string) =>
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none/.test(src);
    expect(hasReducedMotion('@media (prefers-reduced-motion: reduce) { .x { animation: none !important; } }')).toBe(
      true,
    );
    expect(hasReducedMotion('.x { animation: foo 1s; }')).toBe(false);
    expect(hasReducedMotion('@media (prefers-reduced-motion: reduce) { .x { color: red; } }')).toBe(false);
  });

  it('animations.scss 里没有裸十六进制色值（token 纪律）', () => {
    const code = stripComments(anim!.content);
    expect(code, '动效文件不得出现裸色值').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('动效**不新造时钟**：牌桌区源码里没有 setTimeout/setInterval', () => {
    // ⚠️ 本仓**已有一条**同类判据（`table-bid-ui.test.ts` 的 `TIMER_TRACES`），
    //    但它只扫 `TABLE_AREA` 那 10 个文件。本条的扫描面**更大**
    //    （`src/components/**` + `src/pages/table/**`），额外覆盖 `Settlement.vue` 与
    //    本片新增的 `Panel.vue` —— 是**扩大覆盖**，不是重复。
    const offenders = sources
      .filter((f) => f.path.startsWith('src/components/') || f.path.startsWith('src/pages/table/'))
      .filter((f) => /\bset(Timeout|Interval)\s*\(/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(offenders, `牌桌区不得新造时钟（§9.6）：${offenders.join(', ')}`).toEqual([]);
  });

  it('错峰用内联变量而不是 JS 定时器（判别力：动画类必须消费 --ftl-delay）', () => {
    const code = stripComments(anim!.content);
    expect(code, '错峰必须走 --ftl-delay 内联变量').toMatch(/animation-delay:\s*var\(--ftl-delay/);
  });

  /**
   * 走查实测（2026-10）：`.anim-deal-in` 的类**播完不移除**（手牌 Hand 常驻），
   * `both` 的 forwards 填充会让 to 帧 `transform: none` 永久压过普通规则——
   * `.card--selected { transform: translateY(…) }` 整局失效（选牌只剩描边不抬升）。
   * jsdom 不跑动画，这件事没有任何组件测试能发现 ⇒ 只能钉源码。
   */
  it('发牌动画不得 forwards 填充：`.anim-deal-in` 用 backwards（否则选中抬升被填充压住）', () => {
    const code = stripComments(anim!.content);
    const rule = /\.anim-deal-in\s*\{([^}]*)\}/.exec(code);
    expect(rule, '.anim-deal-in 规则必须存在').not.toBeNull();
    const body = rule![1]!;
    expect(body, '发牌动画必须用 backwards（延迟期摆好起始姿势，播完归还 transform）').toMatch(
      /animation:[^;]*\bbackwards\b/,
    );
    expect(body, '不得用 both/forwards：forwards 填充的 transform 会永久压住 .card--selected').not.toMatch(
      /\b(?:both|forwards)\b/,
    );
    // 正反对照：等价的合规/违规短样本必须按预期判
    const isBackwardsOnly = (s: string) =>
      /animation:[^;]*\bbackwards\b/.test(s) && !/\b(?:both|forwards)\b/.test(s);
    expect(isBackwardsOnly('animation: x .3s ease backwards;')).toBe(true);
    expect(isBackwardsOnly('animation: x .3s ease both;')).toBe(false);
  });
});

/**
 * C9：等待提示的入场动画必须真的被降级覆盖、关键帧存在且起始态可见、模板真的使用它。
 *
 * ⚠️ 不能对整份文件做 `toContain('.anim-float-up')` —— 类规则本身就会命中，
 * 即使媒体查询清单没加也绿（设计审查发现的高-2）。必须按花括号配对截出媒体查询块。
 */
describe('C9：ftl-float-up 入场动画', () => {
  /** 从 `at` 起找第一个 `{`，按花括号配对返回块内文本（不含最外层花括号）。 */
  function braceBlock(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  function reducedMotionBlock(src: string): string | null {
    const at = src.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    return at < 0 ? null : braceBlock(src, at);
  }

  it('降级清单的媒体查询块内含 .anim-float-up（含正反对照）', () => {
    const code = stripComments(anim!.content);
    const block = reducedMotionBlock(code);
    expect(block, 'prefers-reduced-motion 媒体查询必须存在').not.toBeNull();
    expect(block, '降级清单必须覆盖新动画').toContain('.anim-float-up');

    const inside =
      '@media (prefers-reduced-motion: reduce) { .anim-float-up { animation: none !important; } }';
    const outside =
      '.anim-float-up { animation: x 1s; } @media (prefers-reduced-motion: reduce) { .anim-deal-in { animation: none !important; } }';
    expect(reducedMotionBlock(inside), '块内样本必须命中').toContain('.anim-float-up');
    expect(reducedMotionBlock(outside), '块外样本不得命中').not.toContain('.anim-float-up');
  });

  it('关键帧存在、只动 transform、起始态可见', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@keyframes\s+ftl-float-up/);
    expect(at, '@keyframes ftl-float-up 必须存在').toBeGreaterThanOrEqual(0);
    const body = braceBlock(code, at);
    expect(body).not.toBeNull();
    expect(body).toContain('transform');
    expect(body, '起始态不得用 opacity: 0（降级时必须可见）').not.toContain('opacity');
    expect(body, '不得用 visibility/display 隐藏起始态').not.toMatch(/visibility|display/);
    expect(body, '不得用 left/top 触发布局').not.toMatch(/(?:^|[;\s])(?:left|top)\s*:/);
    expect(body, '不得用 scale(0) 假装隐藏').not.toMatch(/scale\(\s*0\s*\)/);
    expect(body, 'to 帧必须归还 transform').toMatch(/to\s*\{[^}]*transform:\s*none/);

    // 判别力自证：违规样本必须被判负。
    const bad = '@keyframes ftl-float-up { from { opacity: 0; transform: scale(0); } to { transform: none; } }';
    expect(bad, '负样本必须被 opacity/scale(0) 命中').toMatch(/opacity/);
    expect(bad).toMatch(/scale\(\s*0\s*\)/);
  });

  it('入场类用 backwards（播完归还 transform，不用 both/forwards）', () => {
    const code = stripComments(anim!.content);
    const rule = /\.anim-float-up\s*\{([^}]*)\}/.exec(code);
    expect(rule, '.anim-float-up 规则必须存在').not.toBeNull();
    expect(rule![1]).toMatch(/animation:[^;]*\bbackwards\b/);
    expect(rule![1]).not.toMatch(/\b(?:both|forwards)\b/);
    // 正反对照
    const isBackwardsOnly = (s: string) =>
      /animation:[^;]*\bbackwards\b/.test(s) && !/\b(?:both|forwards)\b/.test(s);
    expect(isBackwardsOnly('animation: x .24s ease backwards;')).toBe(true);
    expect(isBackwardsOnly('animation: x .24s ease both;')).toBe(false);
  });

  it('game.vue 实际使用了 .anim-float-up（防死动画）', () => {
    const game = sources.find((f) => f.path === 'src/pages/game/game.vue');
    expect(game, 'game.vue 必须在源码扫描集合里').toBeDefined();
    expect(stripComments(game!.content)).toContain('anim-float-up');
  });
});

/**
 * 重新发牌片的动效机械闸（2026-10-22）。
 *
 * ⚠️ 同样**不证明**观感，只钉会静默失效的机械事实：
 *  · 重发整手动画必须 `backwards`（同 `.anim-deal-in`：`both` 的填充值会压住选中抬升）；
 *  · 两个新类必须进 `prefers-reduced-motion` 降级清单；
 *  · 横幅时长与 JS 常量 `REDEAL_BANNER_MS` **单一真源**（CSS 兜底不得漂移）；
 *  · 横幅起始态可见（`0%` 不得 `opacity: 0`）。
 */
describe('重新发牌动画（2026-10-22）', () => {
  /** 从 `at` 起按花括号配对截块（与 C9 的局部 helper 同形，测试侧小工具）。 */
  function braceBlock(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  function reducedMotionBlock(src: string): string | null {
    const at = src.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    return at < 0 ? null : braceBlock(src, at);
  }

  /** 从一条规则/样本里截出 `var(--ftl-redeal-ms, Nms)` 的 N。 */
  function bannerFallbackMs(src: string): number | null {
    const m = /var\(--ftl-redeal-ms,\s*(\d+)ms\)/.exec(src);
    return m ? Number(m[1]) : null;
  }

  it('.anim-redeal-in 必须 backwards（不得 both/forwards）', () => {
    const code = stripComments(anim!.content);
    const rule = /\.anim-redeal-in\s*\{([^}]*)\}/.exec(code);
    expect(rule, '.anim-redeal-in 规则必须存在').not.toBeNull();
    const body = rule![1]!;
    expect(body, '重发整手动画必须用 backwards').toMatch(/animation:[^;]*\bbackwards\b/);
    expect(body, '不得用 both/forwards：填充的 transform 会永久压住 .card--selected').not.toMatch(
      /\b(?:both|forwards)\b/,
    );
    // 正反对照
    const isBackwardsOnly = (s: string) =>
      /animation:[^;]*\bbackwards\b/.test(s) && !/\b(?:both|forwards)\b/.test(s);
    expect(isBackwardsOnly('animation: x .46s ease backwards;')).toBe(true);
    expect(isBackwardsOnly('animation: x .46s ease both;')).toBe(false);
  });

  it('降级清单必须覆盖 .anim-redeal-in 与 .anim-redeal-banner', () => {
    const code = stripComments(anim!.content);
    const block = reducedMotionBlock(code);
    expect(block, 'prefers-reduced-motion 块必须存在').not.toBeNull();
    expect(block, '重发整手动画必须进降级清单').toContain('.anim-redeal-in');
    expect(block, '横幅必须进降级清单').toContain('.anim-redeal-banner');
  });

  it('横幅时长与 REDEAL_BANNER_MS 单一真源', () => {
    const code = stripComments(anim!.content);
    const rule = /\.anim-redeal-banner\s*\{([^}]*)\}/.exec(code);
    expect(rule, '.anim-redeal-banner 规则必须存在').not.toBeNull();
    expect(rule![1], '横幅时长必须走 --ftl-redeal-ms 变量').toContain('var(--ftl-redeal-ms');
    expect(
      bannerFallbackMs(rule![1]!),
      'CSS 兜底值必须等于 REDEAL_BANNER_MS（改一处漏改另一处会红）',
    ).toBe(REDEAL_BANNER_MS);

    // 判别力：合成的违规样本必须被判负。
    expect(bannerFallbackMs('animation: x var(--ftl-redeal-ms, 3000ms) ease both;')).not.toBe(
      REDEAL_BANNER_MS,
    );
    expect(bannerFallbackMs('animation: x 2s ease both;')).toBeNull();
  });

  it('横幅 keyframes 起始态可见（0% 不得 opacity: 0）', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@keyframes\s+ftl-redeal-banner-life/);
    expect(at, '@keyframes ftl-redeal-banner-life 必须存在').toBeGreaterThanOrEqual(0);
    const body = braceBlock(code, at);
    expect(body).not.toBeNull();
    const zero = /(?:0%|from)\s*\{([^}]*)\}/.exec(body!);
    expect(zero, '必须有 0%/from 帧').not.toBeNull();
    expect(zero![1], '起始态不得不可见').not.toMatch(/opacity:\s*0\b/);
    expect(zero![1], '起始态要有可见的 transform 起手').toMatch(/transform/);
    // 正反对照
    const bad = '@keyframes ftl-redeal-banner-life { 0% { opacity: 0; } }';
    expect(/(?:0%|from)\s*\{([^}]*)\}/.exec(bad)![1]).toMatch(/opacity:\s*0\b/);
  });
});

/**
 * Task 10（2026-11-07，川麻红金牌桌重做）：红金动效 + **无限闸**。
 *
 * 判据射程（同文件头，诚实版）：jsdom 不注入 CSS、不跑动画 ⇒ 这里**不证明**观感。
 * 它钉的是会**静默蔓延**的机械事实（v6 §4 / v11 §4 / v12 §6）：
 *  · 麻将组件里**唯一**允许的 infinite 动画是 `anim-claim-pulse`（定义在 animations.scss）；
 *  · 组件 `<style>` 里不得另写 infinite（长写 `animation-iteration-count: infinite` 也算）；
 *  · 发牌两类必须 `backwards`（`both` 的 forwards 填充会永久压住选中抬升）；
 *  · 新动画必须进 `prefers-reduced-motion` 降级清单；
 *  · 死类（fly-out / active-glow / lack-pulse）必须真的删干净，不许留回收站。
 *
 * ⚠️ 已知限制（v12 §6）：`'anim-' + kind` 这类动态拼接扫不到；当前代码均为字面量，
 *    将来新增动态拼接需人工评审。
 */
describe('Task 10：麻将动效 + 无限闸', () => {
  const MAHJONG_DIR = 'src/components/table/mahjong/';
  /** 麻将 SFC 全集（扫描面自证：少于 8 个说明扫描器没读到）。 */
  const mahjongFiles = sources.filter(
    (f) => f.path.startsWith(MAHJONG_DIR) && f.path.endsWith('.vue'),
  );
  /** 唯一允许在麻将组件里出现的 infinite 类。 */
  const ALLOWED_INFINITE = 'anim-claim-pulse';

  /** 从 `at` 起按花括号配对截块（与 C9 / 重发片 helper 同形）。 */
  function braceBlock(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  function reducedMotionBlock(src: string): string | null {
    const at = src.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    return at < 0 ? null : braceBlock(src, at);
  }

  /** 取 SFC 的 `<style>` 块内容（供 style 闸使用）。 */
  function styleBlocks(src: string): string[] {
    return [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
  }

  /** 剥掉 `<style>` 块（无限闸只看 template + script）。 */
  function stripStyleBlocks(src: string): string {
    return src.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, ' ');
  }

  /** 解析 `.anim-*` 规则 → 类名到规则体。 */
  function parseAnimRules(css: string): Map<string, string> {
    const rules = new Map<string, string>();
    for (const m of css.matchAll(/\.(anim-[a-z0-9-]+)\s*\{([^}]*)\}/g)) {
      rules.set(m[1]!, m[2]!);
    }
    return rules;
  }

  /** `classInfinite`：规则体里含 `infinite` 的 `.anim-*` 类名集合。 */
  function classInfinite(css: string): Set<string> {
    const infinite = new Set<string>();
    for (const [name, body] of parseAnimRules(css)) {
      if (/\binfinite\b/.test(body)) infinite.add(name);
    }
    return infinite;
  }

  /** 扫 SFC 的 template + script（剥 style 与注释）里的 `anim-*` 字面量。 */
  function animUsages(src: string): string[] {
    return [...stripComments(stripStyleBlocks(src)).matchAll(/anim-[a-z0-9-]+/g)].map(
      (m) => m[0],
    );
  }

  /** 违禁 infinite 用法 = 字面量 ∩ classInfinite − 白名单。 */
  function infiniteOffenders(src: string, infinite: Set<string>): string[] {
    return [...new Set(animUsages(src).filter((c) => infinite.has(c) && c !== ALLOWED_INFINITE))];
  }

  it('① 无限类解析器：`.anim-*` 规则体含 infinite 才算（正反对照）', () => {
    const synthetic = classInfinite(
      '.anim-loop { animation: x 1s ease infinite; } .anim-once { animation: x 1s 3; }',
    );
    expect(synthetic.has('anim-loop'), '含 infinite 的规则必须被识别').toBe(true);
    expect(synthetic.has('anim-once'), '有限次数的规则不得误判').toBe(false);

    const real = classInfinite(stripComments(anim!.content));
    expect(real.has('anim-claim-pulse'), 'claim 呼吸必须仍是 infinite').toBe(true);
    for (const finite of [
      'anim-deal-in-radial',
      'anim-deal-in-side',
      'anim-discard-land',
      'anim-mj-urgent',
    ]) {
      expect(real.has(finite), `${finite} 不得是 infinite`).toBe(false);
    }
  });

  it('② 麻将模板/脚本：anim-* ∩ infinite 只允许 anim-claim-pulse（合成违例必红）', () => {
    expect(mahjongFiles.length, '扫描器必须读到麻将组件').toBeGreaterThanOrEqual(8);
    const infinite = classInfinite(stripComments(anim!.content));
    const offenders = mahjongFiles.flatMap((f) =>
      infiniteOffenders(f.content, infinite).map((c) => `${f.path}: ${c}`),
    );
    expect(offenders, `麻将组件不得使用无限动画：${offenders.join(', ')}`).toEqual([]);

    // 判别力：引用已有的 infinite 全局类（urgent-pulse）必须红；白名单类必须放行。
    expect(
      infiniteOffenders('<template><view class="anim-urgent-pulse" /></template>', infinite),
      '合成违例必须被判负',
    ).toEqual(['anim-urgent-pulse']);
    expect(
      infiniteOffenders('<template><view class="anim-claim-pulse" /></template>', infinite),
      '白名单类必须放行',
    ).toEqual([]);
  });

  it('③ 麻将 <style>：animation / animation-name / animation-iteration-count 不得含 infinite', () => {
    const re = /(?:animation|animation-name|animation-iteration-count)\s*:[^;{}]*\binfinite\b/;
    const offenders: string[] = [];
    for (const f of mahjongFiles) {
      const style = styleBlocks(f.content).map(stripComments).join('\n');
      if (re.test(style)) offenders.push(f.path);
    }
    expect(offenders, `infinite 只能写在 animations.scss：${offenders.join(', ')}`).toEqual([]);

    // 长写 `animation-iteration-count: infinite` 也必须被识别。
    expect(re.test('.x { animation-iteration-count: infinite; }'), '长写必须被判负').toBe(true);
    expect(re.test('.x { animation: none !important; }'), '降级写法必须放行').toBe(false);
  });

  it('④ 发牌两类必须 backwards（不得 both/forwards：填充会压住选中抬升）', () => {
    const code = stripComments(anim!.content);
    for (const cls of ['anim-deal-in-radial', 'anim-deal-in-side']) {
      const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(code);
      expect(rule, `.${cls} 规则必须存在`).not.toBeNull();
      const body = rule![1]!;
      expect(body, `${cls} 必须用 backwards`).toMatch(/animation:[^;]*\bbackwards\b/);
      expect(body, `${cls} 不得用 both/forwards`).not.toMatch(/\b(?:both|forwards)\b/);
    }
  });

  it('⑤ reduced-motion 降级清单覆盖四个新动画类', () => {
    const block = reducedMotionBlock(stripComments(anim!.content));
    expect(block, 'prefers-reduced-motion 块必须存在').not.toBeNull();
    for (const cls of [
      'anim-deal-in-radial',
      'anim-deal-in-side',
      'anim-discard-land',
      'anim-mj-urgent',
    ]) {
      expect(block, `降级清单必须覆盖 .${cls}`).toContain(`.${cls}`);
    }
  });

  it('⑥ 死类已删除：fly-out / active-glow / lack-pulse 的类与关键帧都不在', () => {
    const code = stripComments(anim!.content);
    for (const dead of [
      'anim-fly-out',
      'anim-active-glow',
      'anim-lack-pulse',
      'ftl-fly-out',
      'ftl-active-glow',
      'ftl-lack-pulse',
    ]) {
      expect(code, `${dead} 应已删除（无组件使用）`).not.toContain(dead);
    }
  });

  it('⑦ claim pulse 仍在，且是麻将组件里唯一的 infinite 类', () => {
    const code = stripComments(anim!.content);
    const rule = /\.anim-claim-pulse\s*\{([^}]*)\}/.exec(code);
    expect(rule, '.anim-claim-pulse 规则必须存在').not.toBeNull();
    expect(rule![1], 'claim pulse 必须保留 infinite').toMatch(/\binfinite\b/);

    const infinite = classInfinite(code);
    const used = new Set(
      mahjongFiles.flatMap((f) => animUsages(f.content).filter((c) => infinite.has(c))),
    );
    expect([...used].sort(), '麻将里唯一 infinite 类').toEqual([ALLOWED_INFINITE]);
  });

  it('⑧ 接线在位（类真的被组件引用，不只是定义）', () => {
    const has = (file: string, cls: string): boolean => {
      const f = sources.find((x) => x.path === `${MAHJONG_DIR}${file}`);
      return f ? f.content.includes(cls) : false;
    };
    expect(has('MahjongBoard.vue', 'anim-deal-in-radial'), 'Board 手牌必须用 radial').toBe(true);
    expect(has('MahjongHandBacks.vue', 'anim-deal-in-side'), 'HandBacks 必须用 side').toBe(true);
    expect(has('MahjongRiver.vue', 'anim-discard-land'), 'River 最新弃牌必须落桌').toBe(true);
    expect(has('MahjongHub.vue', 'anim-mj-urgent'), 'Hub 紧迫钟必须有限脉动').toBe(true);
    expect(has('MahjongActionBar.vue', 'anim-claim-pulse'), 'ActionBar claim 必须呼吸').toBe(true);
  });

  /**
   * 终审 Important 2：HuBanner 锚点居中。
   *
   * 组件基类用 `transform: translate(-50%, -100%)` 把 banner 的**底边中点**钉在画布锚点上；
   * 但 CSS 动画期间 keyframe 的 transform **整体覆盖**基类 —— 旧关键帧在 30%/70% 写
   * `transform: none`，可见停留期 banner 的左上角落在锚点上。修法：四帧都烘焙居中平移。
   */
  it('⑨ ftl-hu-banner 每一帧都带 translate(-50%, -100%)（动画不得覆盖锚点居中）', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@keyframes\s+ftl-hu-banner/);
    expect(at, '@keyframes ftl-hu-banner 必须存在').toBeGreaterThanOrEqual(0);
    const body = braceBlock(code, at);
    expect(body).not.toBeNull();
    const frames = [...body!.matchAll(/(?:0%|30%|70%|100%)\s*\{([^}]*)\}/g)];
    expect(frames, '0%/30%/70%/100% 四帧都必须存在').toHaveLength(4);
    for (const [, inner] of frames) {
      expect(
        inner,
        '动画期 keyframe 的 transform 会整体覆盖基类居中 —— 每一帧都必须自带 translate(-50%, -100%)',
      ).toContain('translate(-50%, -100%)');
    }

    // 组件基类保留居中 transform（reduced-motion / 动画不执行时的兜底）。
    const banner = sources.find(
      (f) => f.path === `${MAHJONG_DIR}MahjongHuBanner.vue`,
    );
    expect(banner, 'MahjongHuBanner.vue 必须在源码扫描集合里').toBeDefined();
    expect(stripComments(banner!.content)).toContain('transform: translate(-50%, -100%)');

    // 判别力：任一帧退回 `transform: none`（覆盖基类居中）必须被判负。
    const bad =
      '@keyframes ftl-hu-banner { 0% { transform: translate(-50%, -100%) scale(1.4); } 30% { transform: none; } 70% { transform: translate(-50%, -100%); } 100% { transform: translate(-50%, -100%); } }';
    const badBody = braceBlock(bad, bad.search(/@keyframes\s+ftl-hu-banner/))!;
    const badFrames = [...badBody.matchAll(/(?:0%|30%|70%|100%)\s*\{([^}]*)\}/g)];
    expect(
      badFrames.some(([, inner]) => !inner!.includes('translate(-50%, -100%)')),
      '合成负样本必须被判负',
    ).toBe(true);
  });

  /**
   * 终审残留：reduced-motion 的整组 `transform: none !important` 会压掉
   * 组件基类的 `translate(-50%, -100%)`，把胡 banner 钉在锚点左上角。
   * 因此 `.anim-hu-banner` 必须单列，只关 animation/transition，不动 transform。
   */
  it('⑩ reduced-motion 只关胡 banner 动画，不压掉居中 transform', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(at, 'prefers-reduced-motion 媒体查询必须存在').toBeGreaterThanOrEqual(0);
    const block = braceBlock(code, at);
    expect(block).not.toBeNull();

    // 1) 不得出现在整组 `transform: none !important` 的清单里。
    const blanket = /([^{}]*\{[^}]*transform:\s*none\s*!important[^}]*\})/.exec(block!);
    expect(blanket, '整组降级规则必须存在').not.toBeNull();
    expect(blanket![1], '胡 banner 不得被整组清除 transform').not.toContain('.anim-hu-banner');

    // 2) 自己的降级规则只关动画，不碰 transform。
    const own = /\.anim-hu-banner\s*\{([^}]*)\}/.exec(block!);
    expect(own, 'reduced-motion 下仍要有一条 .anim-hu-banner 规则').not.toBeNull();
    expect(own![1]).toMatch(/animation:\s*none/);
    expect(own![1], '不得 transform: none（会压掉基类居中）').not.toMatch(/transform:\s*none/);

    // 判别力：把 transform: none 写回单列规则必须被判负。
    const bad =
      '@media (prefers-reduced-motion: reduce) { .anim-hu-banner { animation: none !important; transform: none !important; } }';
    const badBlock = braceBlock(bad, bad.search(/@media/))!;
    expect(/\.anim-hu-banner\s*\{([^}]*)\}/.exec(badBlock)![1]).toMatch(/transform:\s*none/);
  });
});

/**
 * Task 2（2026-11-08，红金皮肤）：血战盘胡牌金光。
 *
 * ⚠️ 判据射程同文件头：jsdom 不跑动画。这里只钉会静默失效的机械事实：
 *  · 规则必须**独立**（动画闸的 `parseAnimRules` 只捕获分组里的最后一个选择器）；
 *  · 0.8s 一次性（无 infinite）；关键帧 0% 可见 → 100% 透明；
 *  · 必须进 `prefers-reduced-motion` 降级清单。
 */
describe('Task 2：血战盘金光（anim-mj-hub-flash）', () => {
  function braceBlock(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  function reducedMotionBlock(src: string): string | null {
    const at = src.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    return at < 0 ? null : braceBlock(src, at);
  }

  it('独立规则（不分组）：0.8s 一次性、无 infinite', () => {
    const code = stripComments(anim!.content);
    // 前面必须是行首或一条规则的收尾 —— 分组选择器（`, .anim-mj-hub-flash {`）不算。
    const standalone = /(?:^|[\n}])\s*\.anim-mj-hub-flash\s*\{([^}]*)\}/m.exec(code);
    expect(standalone, '.anim-mj-hub-flash 必须是独立规则（不得挂进分组选择器）').not.toBeNull();
    const body = standalone![1]!;
    expect(body).toMatch(/animation:\s*ftl-mj-hub-flash\s+\.8s/);
    expect(body).not.toMatch(/\binfinite\b/);
    expect(body).toContain('forwards');

    // 判别力：分组写法不得被当成独立规则命中。
    const grouped =
      '.anim-other { animation: x 1s; }\n.anim-other, .anim-mj-hub-flash { animation: ftl-mj-hub-flash .8s; }';
    expect(/(?:^|[\n}])\s*\.anim-mj-hub-flash\s*\{/m.test(grouped)).toBe(false);
  });

  it('关键帧 0/35/100：起始可见、35% 金环高光、100% 透明', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@keyframes\s+ftl-mj-hub-flash/);
    expect(at, '@keyframes ftl-mj-hub-flash 必须存在').toBeGreaterThanOrEqual(0);
    const body = braceBlock(code, at);
    expect(body).not.toBeNull();
    const zero = /0%\s*\{([^}]*)\}/.exec(body!);
    const mid = /35%\s*\{([^}]*)\}/.exec(body!);
    const end = /100%\s*\{([^}]*)\}/.exec(body!);
    expect(zero, '0% 帧必须存在').not.toBeNull();
    expect(mid, '35% 帧必须存在').not.toBeNull();
    expect(end, '100% 帧必须存在').not.toBeNull();
    expect(zero![1], '0% 必须可见').toMatch(/opacity:\s*1\b/);
    expect(mid![1], '35% 金环高光').toMatch(/inset 0 0 48px 6px/);
    expect(end![1], '100% 必须淡出').toMatch(/opacity:\s*0\b/);
  });

  it('reduced-motion 降级清单覆盖 .anim-mj-hub-flash', () => {
    const code = stripComments(anim!.content);
    const block = reducedMotionBlock(code);
    expect(block, 'prefers-reduced-motion 块必须存在').not.toBeNull();
    expect(block, '降级清单必须覆盖新动画').toContain('.anim-mj-hub-flash');
  });
});

/**
 * Task 3（2026-11-08，红金皮肤）：动作区滑入 + 亮牌翻转登记。
 *
 * ⚠️ 判据射程同文件头：jsdom 不跑动画。这里只钉会静默失效的机械事实：
 *  · `.anim-action-slide-in` 必须是**独立规则**（动画闸的 `parseAnimRules` 只捕获分组最后一个选择器）；
 *  · 0.16s 一次性（无 infinite）、`backwards`、起始态可见；
 *  · `.anim-action-slide-in` 与 `.anim-reveal-in` 都必须进 `prefers-reduced-motion` 降级清单。
 */
describe('Task 3：动作区滑入（anim-action-slide-in）', () => {
  function braceBlock(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  function reducedMotionBlock(src: string): string | null {
    const at = src.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    return at < 0 ? null : braceBlock(src, at);
  }

  it('独立规则：0.16s / backwards / 无 infinite', () => {
    const code = stripComments(anim!.content);
    const standalone = /(?:^|[\n}])\s*\.anim-action-slide-in\s*\{([^}]*)\}/m.exec(code);
    expect(standalone, '.anim-action-slide-in 必须是独立规则（不得挂进分组选择器）').not.toBeNull();
    const body = standalone![1]!;
    expect(body).toMatch(/animation:\s*ftl-action-slide-in\s+\.16s/);
    expect(body).toContain('backwards');
    expect(body).not.toMatch(/\binfinite\b/);

    // 判别力：分组写法不得被当成独立规则命中。
    const grouped =
      '.anim-other { animation: x 1s; }\n.anim-other, .anim-action-slide-in { animation: ftl-action-slide-in .16s; }';
    expect(/(?:^|[\n}])\s*\.anim-action-slide-in\s*\{/m.test(grouped)).toBe(false);
  });

  it('关键帧 translateY(12px) → none，起始态可见（无 opacity）', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@keyframes\s+ftl-action-slide-in/);
    expect(at, '@keyframes ftl-action-slide-in 必须存在').toBeGreaterThanOrEqual(0);
    const body = braceBlock(code, at);
    expect(body).not.toBeNull();
    expect(body!, 'from 帧必须从下方 12px 起手').toMatch(
      /from\s*\{[^}]*transform:\s*translateY\(12px\)/,
    );
    expect(body!, 'to 帧必须归还 transform').toMatch(/to\s*\{[^}]*transform:\s*none/);
    expect(body!, '起始态不得依赖 opacity').not.toContain('opacity');
  });

  it('reduced-motion 降级清单覆盖 .anim-action-slide-in 与 .anim-reveal-in', () => {
    const code = stripComments(anim!.content);
    const block = reducedMotionBlock(code);
    expect(block, 'prefers-reduced-motion 块必须存在').not.toBeNull();
    expect(block, '动作区滑入必须进降级清单').toContain('.anim-action-slide-in');
    expect(block, '亮牌翻转必须进降级清单').toContain('.anim-reveal-in');
  });
});
