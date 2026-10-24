/**
 * 每页可选底纹（spec §5.4 的**机制**部分 / 片③ 阶段 B · Task B7）。
 *
 * ## 判据射程（**只做 prop 行为**）
 *
 * 本文件只回答「**给的 prop 对不对**」：缺省铺哪张、`backdrop="table"` 铺哪张。
 *
 * ⚠️ 「**舞台只有一层底纹**」那条判定在 `landscape-canvas.test.ts` 的 R713（**源码扫描**形态）
 * —— **不在这里再写一条**。同一性质写两份的代价不是「更保险」，而是**两份各自过期**：
 * 改天形态变了（比如底纹改由 CSS 变量给），改一份忘另一份 ⇒ 红的是一份、绿的那份继续
 * 给人「已验证」的错觉（本仓 `stripComments` 的收敛注释逐字记过这个失败模式）。
 *
 * ## 为什么舞台要**显式声明**而不是「按页面身份查表」
 *
 * `LandscapeStage` 是**纯布局组件**：它不该知道 `auth.page`（知道页面身份 = 把路由知识
 * 塞进一个与路由无关的组件里）。⇒ 页面传 prop，舞台只认 prop。
 *
 * ## 底纹载体（2026-10-13 形态变迁）
 *
 * 底纹从「`.stage` 的内联 `background-image: url(…)`」改成「**`<image class="stage__backdrop">`
 * 垫底层**」——发布包实证：App 发布态页面走 `file://`，内联样式里的**绝对** url('/static/…')
 * 会解析到文件系统根 ⇒ 底纹不加载（登录/玩法/牌桌全白底）；而 `<image>` 组件按绝对本地路径
 * 加载是发布包实测可用的形态（卡面/头像同族）。本文件的判据改为读**底纹层的 `src`**。
 *
 * ⚠️ 本文件**不是**观感判据：哪张底纹好看只能人眼（spec §1.1-8），截图在
 * `.tmp_shots/b7/`（Task B7 Step 4）。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LandscapeStage from '../src/components/LandscapeStage.vue';

/** 底纹层的 `src`（底纹**只**从这里来 —— 舞台内联样式里已无任何图路径）。 */
function backdropSrcOf(props?: Record<string, unknown>): string {
  return (
    mount(LandscapeStage, props ? { props } : {})
      .find('.stage__backdrop')
      .attributes('src') ?? ''
  );
}

describe('每页可选底纹（§5.4）：prop 行为', () => {
  it('缺省 ⇒ 铺 default 底纹（bg.png）', () => {
    expect(backdropSrcOf()).toContain('bg.png');
  });

  it('backdrop="default" 显式给出 ⇒ 与缺省同图（缺省值不是第三种行为）', () => {
    expect(backdropSrcOf({ backdrop: 'default' })).toBe(backdropSrcOf());
  });

  it('backdrop="table" ⇒ 换成牌桌底纹（bg_table.png）', () => {
    expect(backdropSrcOf({ backdrop: 'table' })).toContain('bg_table.png');
  });

  it('两种取值铺的**不是同一张**（防「映射表两个键指向同一图」的复制粘贴错）', () => {
    // ⚠️ 这条与上面两条**不重复**：上面只钉「各自包含什么」，
    //    而 `/static/ui/bg.png` 恰好是 `bg_table.png` 的**不同**文件名（后者也不含 `bg.png`
    //    子串，`toContain('bg.png')` 不会误命中）——
    //    两个键写同一张图时，两条 `toContain` 里必有一条红，但**「table 分支悄悄指向 default」
    //    这种错在只有 toContain 的形态下要等到人去看 `bg_table.png` 那条才发现**。
    //    直接比较两条 src：不同 = prop 真的接上了（而不是被 default 吞掉）。
    expect(backdropSrcOf({ backdrop: 'table' })).not.toBe(backdropSrcOf({ backdrop: 'default' }));
  });

  it('未知取值 ⇒ 回落 default（不是空 src 这种静默空底纹）', () => {
    // 类型系统挡得住字面量拼错，但挡不住「字符串从数据里来」（`:backdrop="cfg.backdrop"`）。
    // R693 同族：拿不到图不许变成空洞，必须退到一张**确定存在**的图。
    const src = backdropSrcOf({ backdrop: 'nope' });
    expect(src).toContain('bg.png');
    expect(src).not.toContain('undefined');
  });
});
