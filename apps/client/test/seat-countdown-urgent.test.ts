/**
 * 行动倒计时钟（`TurnTimer.vue`）的**末 5 秒紧迫态**（A 档第⑥片）。
 *
 * 2026-10-11 第三轮布局调整：钟从 `Seat.vue` 头像角抽成独立哑组件 `TurnTimer.vue`，
 * 挂在 table.vue 的对手出牌/状态列（`.table__play-col`）里；同日用户裁决钟放大到
 * 与「我」的中央钟同档（88×92，字号 40/28/18）。
 *
 * 纯展示分档：`active && 0 < seconds <= 5` 时钟与数字挂危险色类、容器挂脉动类。
 * ⚠️ 这不是规则判定（不推任何超时行为）；`active=false` 时钟根本不渲染。
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TurnTimer from '../src/components/TurnTimer.vue';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

/** 只给必填 props（其余走 withDefaults）。 */
function mountTimer(over: Record<string, unknown> = {}) {
  return mount(TurnTimer, {
    props: {
      active: true,
      seconds: 10,
      ...over,
    },
  });
}

describe('TurnTimer 倒计时紧迫态（A 档）', () => {
  it('未轮到：钟不渲染，紧迫态无从谈起', () => {
    const w = mountTimer({ active: false, seconds: 3 });
    expect(w.find('.turn-timer').exists()).toBe(false);
  });

  it('秒数 > 5：钟在，但不挂任何紧迫类', () => {
    const w = mountTimer({ seconds: 6 });
    expect(w.find('.turn-timer').exists()).toBe(true);
    expect(w.find('.turn-timer').classes()).not.toContain('turn-timer--urgent');
    expect(w.find('.turn-timer').classes()).not.toContain('anim-urgent-pulse');
    expect(w.find('.turn-timer__value').classes()).not.toContain('turn-timer__value--urgent');
  });

  it.each([5, 4, 1])('秒数 %s（1–5）：钟与数字挂危险色、容器挂脉动', (seconds) => {
    const w = mountTimer({ seconds });
    expect(w.find('.turn-timer').classes()).toContain('turn-timer--urgent');
    expect(w.find('.turn-timer').classes()).toContain('anim-urgent-pulse');
    expect(w.find('.turn-timer__value').classes()).toContain('turn-timer__value--urgent');
  });

  it('秒数 0：不挂紧迫态（末拍 0 秒无信息量，钟通常随轮次切换被摘除）', () => {
    const w = mountTimer({ seconds: 0 });
    expect(w.find('.turn-timer').classes()).not.toContain('turn-timer--urgent');
    expect(w.find('.turn-timer__value').classes()).not.toContain('turn-timer__value--urgent');
  });
});

/**
 * 多位秒数压缩档（2026-10，用户卡点：两位秒溢出闹钟金边）。
 *
 * 灰玻璃钟面内径只有图宽 ~53%，字号必须按位数分档；档位的**贴合量尺**在真浏览器
 * （jsdom 不布局），这里钉两件事：
 *  ① 行为：位数类按 10 / 100 两道沿挂载（个位数不挂、两位挂 digits-2、三位挂 digits-3）；
 *  ② 源码：压缩字号必须引用令牌（不得就地写 px）。
 *     88×92 钟（与中央 `.table__clock` 同档，2026-10-11 用户裁决）：个位 xl(40)，
 *     两位 md(28)（`$ftl-font-md`），三位 compact(18)（`$ftl-font-clock-compact`）。
 */
describe('TurnTimer 倒计时秒数位数压缩档', () => {
  it.each([1, 5, 9])('个位数 %s：不挂任何位数类', (seconds) => {
    const classes = mountTimer({ seconds }).find('.turn-timer__value').classes();
    expect(classes).not.toContain('turn-timer__value--digits-2');
    expect(classes).not.toContain('turn-timer__value--digits-3');
  });

  it.each([10, 21, 99])('两位数 %s：挂 digits-2、不挂 digits-3', (seconds) => {
    const classes = mountTimer({ seconds }).find('.turn-timer__value').classes();
    expect(classes).toContain('turn-timer__value--digits-2');
    expect(classes).not.toContain('turn-timer__value--digits-3');
  });

  it.each([100, 120])('三位数 %s：挂 digits-3（不再叠 digits-2）', (seconds) => {
    const classes = mountTimer({ seconds }).find('.turn-timer__value').classes();
    expect(classes).toContain('turn-timer__value--digits-3');
    expect(classes).not.toContain('turn-timer__value--digits-2');
  });

  it('源码级：压缩档规则齐全且字号全部引用 $ftl-* 令牌', () => {
    const timerFile = collectSourceFiles().find((f) => f.path === 'src/components/TurnTimer.vue');
    expect(timerFile, '扫描器必须真的读到 TurnTimer.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(timerFile!.content);

    // 88×92 同中央钟档位：个位秒用 xl(40)
    expect(
      /\.turn-timer__value\s*\{[^}]*font-size:\s*\$ftl-font-xl\s*;/.test(code),
      '`.turn-timer__value` 必须用 $ftl-font-xl',
    ).toBe(true);
    // 两位降到 md(28)、三位降到 compact(18) —— 两条独立规则（不再并列共用 13 档）
    expect(
      /\.turn-timer__value--digits-2\s*\{[^}]*font-size:\s*\$ftl-font-md\s*;/.test(code),
      '`.turn-timer__value--digits-2` 必须用 $ftl-font-md',
    ).toBe(true);
    expect(
      /\.turn-timer__value--digits-3\s*\{[^}]*font-size:\s*\$ftl-font-clock-compact\s*;/.test(
        code,
      ),
      '`.turn-timer__value--digits-3` 必须用 $ftl-font-clock-compact',
    ).toBe(true);
    // 分档阈值（模板绑定里必须有这两道沿）
    expect(code).toMatch(/seconds\s*>=\s*10/);
    expect(code).toMatch(/seconds\s*>=\s*100/);

    const scssFile = collectSourceFiles().find((f) => f.path === 'src/uni.scss');
    expect(scssFile, '扫描器必须真的读到 uni.scss').toBeDefined();
    const scss = stripComments(scssFile!.content);
    expect(scss).toMatch(/\$ftl-font-clock-compact:\s*18px;/);
    // 旧迷你钟 13px 档位已随 52×54 迷你钟一起删除，不得复活
    expect(scss).not.toMatch(/\$ftl-font-clock-compact-3/);
  });
});
