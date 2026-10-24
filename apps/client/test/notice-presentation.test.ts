/**
 * 提示的**展示形态**（Task 11 终稿 · 提示收敛片）。
 *
 * ## 本文件判四件事
 *
 *  ① **展示 = 悬浮**：`NoticeStack` 根（`.notice-stack`）与 `LandscapeStage` 的
 *     `overlay` 槽（`.stage__overlay`）都是**绝对定位**，不参与文档流布局；
 *     外壳 `pointer-events: none`、条目 `pointer-events: auto`（空白区不吞点击）。
 *  ② **六页全部接线**：login / lobby / game / table / wallet / history 都挂 `<NoticeStack>`
 *     并投进 `#overlay` 槽。jsdom 没有布局，页面级判据取源码形态；观感由模拟器/真机
 *     截图复核（走查清单）。
 *  ③ **旧锚点清零**：Tasks 5–10 迁移落地的 16 个旧宿主类名不得在 `src/**`（**剥注释视图**）
 *     复现 —— 注释里解释「为什么删」是允许的，代码面复现即红。
 *  ④ **旧内部术语清零**：socket 层的玩家文案不得再含 `socket.io` / `M03` / `lastVersion` /
 *     `取回快照`；行为级逐字断言在 `reconnect-flow.test.ts`。这里只钉源码无残留，
 *     并带**判别力自证**（把旧文案原样喂给同一组检查 ⇒ 每条都必须命中）。
 *
 * 逐字旧串的全量扫描在 `player-sink.test.ts`（范围更大：所有玩家面旧技术串）。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();

function sourceOf(path: string): string {
  const file = sources.find((f) => f.path === path);
  expect(file, `${path} 必须在源码扫描集合里`).toBeDefined();
  return file!.content;
}

/**
 * 取某条 CSS 规则的**声明体**（`selector { … }` 的匹配花括号内文本，按括号深度配平）。
 *
 * ⚠️ **不能用 `[^}]*`**：`.notice-stack` 的规则体里有 SCSS 插值 `#{$ftl-space-8}` ——
 *    插值的 `}` 会让非贪婪字符类提前截断，后面的 `pointer-events: none` 从闸的视图里消失
 *    （执行期发现的假绿形态）；按深度配平后嵌套规则（`&::after { … }`）也能正确跳过。
 */
function ruleBody(source: string, selector: string): string | null {
  const code = stripComments(source);
  const hit = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).exec(code);
  if (!hit) return null;
  const start = hit.index + hit[0].length;
  let depth = 1;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i);
    }
  }
  return null;
}

describe('提示展示形态：悬浮浮层（不挤页面）', () => {
  it('NoticeStack 与 overlay 槽绝对定位', () => {
    const stack = sourceOf('src/components/NoticeStack.vue');
    expect(ruleBody(stack, '.notice-stack')).toContain('position: absolute');
    const stage = sourceOf('src/components/LandscapeStage.vue');
    expect(ruleBody(stage, '.stage__overlay')).toContain('position: absolute');
    // 外壳穿透、条目接管点击：常驻的空 Stack 不得挡住页面交互。
    expect(ruleBody(stack, '.notice-stack')).toContain('pointer-events: none');
    expect(ruleBody(stack, '.notice')).toContain('pointer-events: auto');
  });

  it('判别力：ruleBody 真的读到了规则体（不是 null 上的 toContain 假绿）', () => {
    const stack = sourceOf('src/components/NoticeStack.vue');
    expect(ruleBody(stack, '.notice-stack')).not.toBeNull();
    expect(ruleBody(stack, '.notice-stack')!.trim().length).toBeGreaterThan(0);
    expect(ruleBody(stack, '.不存在的规则')).toBeNull();
  });
});

describe('八页都填了 overlay 槽', () => {
  it('login / lobby / game / table / wallet / recharge / withdraw / history 均挂 NoticeStack', () => {
    // 显式路径对：子页不是 `${page}/${page}.vue`（钱包拆分起充值/提现子页同目录）。
    for (const page of [
      'src/pages/login/login.vue',
      'src/pages/lobby/lobby.vue',
      'src/pages/game/game.vue',
      'src/pages/table/table.vue',
      'src/pages/wallet/wallet.vue',
      'src/pages/wallet/recharge.vue',
      'src/pages/wallet/withdraw.vue',
      'src/pages/history/history.vue',
    ]) {
      const src = sourceOf(page);
      expect(src, `${page} 必须挂 NoticeStack`).toContain('<NoticeStack');
      expect(src, `${page} 的 NoticeStack 必须投进 #overlay 槽`).toContain('#overlay');
    }
  });
});

describe('旧宿主锚点清零（剥注释视图）', () => {
  /**
   * Tasks 5–10 迁移落地时退役的 16 个旧锚点（逐字）。
   *
   * ⚠️ 必须对**剥注释视图**做：`table.vue` / `lobby.vue` / `wallet.vue` 等页头解释性注释
   *    会逐字引用旧类名（「旧 `.table__notice` 已迁到 …」），按原始文本匹配会误红。
   * ⚠️ 本数组是 `test/**` 中唯一允许出现这些旧类名的地方（本文件自身即迁移闸）。
   */
  const forbidden = [
    '.login__error',
    '.login__field-error',
    '.lobby__levels-error',
    '.lobby__entry-error',
    '.lobby__notice',
    '.lobby__update-bar',
    '.game__error',
    '.game__notice',
    '.table__notice',
    '.table__notices',
    '.wallet__error',
    '.wallet__hint',
    '.wallet__withdraw-result',
    '.history__error',
  ];

  it('src/** 代码面（剥注释）零残留', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      const code = stripComments(file.content);
      for (const anchor of forbidden) {
        if (code.includes(anchor)) offenders.push(`${file.path}: ${anchor}`);
      }
    }
    expect(offenders, `旧锚点残留：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('判别力：旧锚点样本在剥注释视图里必须命中（闸不是恒绿）', () => {
    const oldSample =
      '.table__notice { color: red; }\n' +
      '<!-- 历史说明：.table__notices 已退役 -->\n' +
      'const y = 1; // .lobby__notice';
    const code = stripComments(oldSample);
    expect(code).toContain('.table__notice');
    // 注释里的（HTML 注释与行注释）必须被剥掉 —— 否则解释性注释会误红。
    expect(code).not.toContain('.table__notices');
    expect(code).not.toContain('.lobby__notice');
  });
});

describe('救助 note 仅允许在弹层内', () => {
  it('唯一渲染点位于 `v-if="reliefOpen"` 的 `.lobby__relief-panel` 子树内', () => {
    const lobby = stripComments(sourceOf('src/pages/lobby/lobby.vue'));
    expect(lobby.match(/class="lobby__relief-note"/g)?.length ?? 0).toBe(1);
    /**
     * 结构判据（源码序）：`v-if="reliefOpen"`（弹层根）→ `.lobby__relief-panel` →
     * `class="lobby__relief-note"`，三者顺序出现 ⇒ note 只可能在开着弹层时渲染
     *（模板里没有第二个面板外渲染点 —— 上面 count==1 已钉住）。
     * 这是源码序启发式（面板内渲染点只有一个；关闭弹层后 note 可能仍留在
     * `reliefNote` 状态里，由浮层 `[data-notice-id="relief"]` 呈现）。
     */
    const openAt = lobby.indexOf('v-if="reliefOpen"');
    const panelAt = lobby.indexOf('lobby__relief-panel');
    const noteAt = lobby.search(/class="lobby__relief-note"/);
    expect(openAt, '`v-if="reliefOpen"` 必须在源码里').toBeGreaterThanOrEqual(0);
    expect(panelAt).toBeGreaterThan(openAt);
    expect(noteAt).toBeGreaterThan(panelAt);
  });
});

describe('玩家文案不得含内部术语（socket/session 源码级零残留）', () => {
  /** 旧文案（修复前逐字形态）—— 既是检查目标，也是判别力自证样本。 */
  const JARGON = ['socket.io 已重连', '已按 M03', 'lastVersion=', '取回快照'];

  it('socket/session 源码里没有旧文案残留', () => {
    for (const path of ['src/net/socket.ts', 'src/net/session.ts']) {
      const code = stripComments(sourceOf(path));
      for (const jargon of JARGON) {
        expect(code, `${path} 面向玩家的文案不得含「${jargon}」`).not.toContain(jargon);
      }
    }
    // 正对照：友好文案在源码里（行为级逐字断言在 reconnect-flow.test.ts 的成功/失败路径）。
    expect(stripComments(sourceOf('src/net/socket.ts'))).toContain('连接已恢复');
  });

  it('判别力自证：旧文案样本必须被同一组检查命中', () => {
    const oldCopy = 'socket.io 已重连，已按 M03 用 lastVersion=3 取回快照（applied）';
    for (const jargon of JARGON) {
      expect(oldCopy.includes(jargon), `旧文案样本必须被「${jargon}」命中`).toBe(true);
    }
  });
});

/**
 * 缺人等待提示（`match.wait_prompt`）的展示形态：
 * 2026-10-21 用户反馈「浮动提示，不挤用原来的 UI」⇒ 卡片改为底部绝对定位浮层。
 * jsdom 不注入 CSS，这里只钉**会静默失效**的源码性质；观感由截图复核。
 */
describe('缺人等待提示：底部悬浮卡片（不挤页面）', () => {
  it('C7/C8：层绝对定位、z-index 5、不拦截点击；卡片恢复可点击', () => {
    const source = sourceOf('src/pages/game/game.vue');
    const layer = ruleBody(source, '.game__waitprompt-layer');
    expect(layer, '.game__waitprompt-layer 规则必须存在（否则本断言空转）').not.toBeNull();
    expect(layer, '浮层必须不参与文档流').toContain('position: absolute');
    expect(layer, '浮层层级低于全屏弹层').toContain('z-index: 5');
    expect(layer, '全宽层不得拦截下层点击').toContain('pointer-events: none');

    const card = ruleBody(source, '.game__waitprompt');
    expect(card, '.game__waitprompt 规则必须存在').not.toBeNull();
    expect(card, '卡片自身必须恢复点击').toContain('pointer-events: auto');
    expect(card, '长文案必须有宽度上限').toContain('max-width');

    // 判别力自证：文档流内 / 缺 pointer-events 的旧形态样本必须判负。
    expect(ruleBody('.game__waitprompt-layer { display: flex; }', '.game__waitprompt-layer'))
      .not.toContain('position: absolute');
    expect(ruleBody('.game__waitprompt { width: 320px; }', '.game__waitprompt'))
      .not.toContain('pointer-events: auto');
  });

  it('C14b：匹配中好友房入口隐藏类只改 visibility（保留布局盒）', () => {
    const hidden = ruleBody(sourceOf('src/pages/game/game.vue'), '.game__friends-open--matching');
    expect(hidden, '.game__friends-open--matching 规则必须存在').not.toBeNull();
    expect(hidden).toContain('visibility: hidden');
    expect(hidden).not.toContain('display: none');
  });

  it('I1：等待按钮压回 line-height（uni-button 基样式 2.5555 会顶掉 min-height）', () => {
    const source = sourceOf('src/pages/game/game.vue');
    const btn = ruleBody(source, '.game__waitprompt-btn');
    expect(btn, '.game__waitprompt-btn 规则必须存在').not.toBeNull();
    expect(btn, '不压 line-height ⇒ 26px 字号的行盒 66.4px，卡片长高压住取消按钮').toContain(
      'line-height: 1.2',
    );
    // 判别力自证：缺 line-height 的旧形态样本必须判负。
    expect(ruleBody('.game__waitprompt-btn { flex: 1; }', '.game__waitprompt-btn'))
      .not.toContain('line-height');
  });

  it('I2：玩法页连接死态已收敛进 NoticeStack（不再有 ConnectionDeadBar）', () => {
    const source = stripComments(sourceOf('src/pages/game/game.vue'));
    // ConnectionDeadBar 退役：模板不再 import、不再挂载
    expect(source, '模板不应再有 ConnectionDeadBar 挂载').not.toContain('ConnectionDeadBar');
    // NoticeStack surface="game" 存在（玩法页和大厅同源）
    expect(source, '玩法页必须挂 NoticeStack surface="game"').toContain('surface="game"');
    // .game__deadbar CSS 规则已删除
    expect(source, '.game__deadbar 样式已随 ConnectionDeadBar 退役').not.toContain('.game__deadbar');
  });

  it('I2：等待卡片在页面错误/死态时让位（错误行走 Stack，不再有内联 .game__error）', () => {
    const code = stripComments(sourceOf('src/pages/game/game.vue'));
    expect(code, '内联 .game__error 已退役').not.toContain('class="game__error"');
    expect(code, '等待卡片必须由 hasGameError / connectionDead 让位').toContain(
      'v-if="waitPrompt && !hasGameError && !connectionDead"',
    );
    expect(code, 'hasGameError 必须由本地 game-error 项推导').toContain(
      'item.id === "game-error"',
    );
    // 判别力自证：旧的 error 控制位条件必须判负。
    expect('waitPrompt && !error && !connectionDead').not.toContain('hasGameError');
  });
});
