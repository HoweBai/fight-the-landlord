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
