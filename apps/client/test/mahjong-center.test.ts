import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongCenter from '../src/components/table/mahjong/MahjongCenter.vue';

/**
 * 信息格三档（2026-10-30 第二片）：
 *  - full：牌墙大数字 + 阶段 + 倒计时 + 待响应牌（带来源座）+ 听牌；
 *  - dense：同上报头降一档，**不显示听牌列表**；
 *  - compact：单行「牌墙 N · 阶段 · 12s」，claim 只出文字。
 * 「已胡 N 家」已移除（座位卡徽标 + 亮牌承担）。
 */
const base = {
  wallCount: 42,
  phaseText: '请出牌',
  level: 'full' as const,
  seconds: 12,
  active: true,
  claimW: 34,
  claimH: 51,
  tingW: 20,
  tingH: 30,
};

describe('MahjongCenter', () => {
  it('full：牌墙/阶段/倒计时/待响应/来源座；有 claim 时听牌让位', () => {
    const w = mount(MahjongCenter, {
      props: {
        ...base,
        claimTile: { s: 0, r: 5 },
        claimFrom: '东家甲打出',
        tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }],
        maxFan: 5,
      },
    });
    expect(w.text()).toContain('牌墙 42');
    expect(w.text()).toContain('请出牌');
    expect(w.text()).toContain('东家甲打出');
    expect(w.findAll('.mj-tile')).toHaveLength(1);
    expect(w.find('.mj-center__ting').exists()).toBe(false);
    expect(w.find('.mj-center__head').classes()).toContain('mj-center__head--stacked');
  });

  it('full 无待响应时显示听牌与番', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }], maxFan: 5 },
    });
    expect(w.text()).toContain('听');
    expect(w.text()).toContain('5 番');
    expect(w.findAll('.mj-tile')).toHaveLength(2);
    expect(w.find('.mj-center__claim').exists()).toBe(false);
  });

  it('dense：有听牌也不渲染听牌列表', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, level: 'dense', tingTiles: [{ s: 0, r: 5 }] },
    });
    expect(w.find('.mj-center__ting').exists()).toBe(false);
    expect(w.text()).toContain('牌墙 42');
  });

  it('compact：单行、无牌面、claim 只出文字', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, level: 'compact', claimTile: { s: 0, r: 5 } },
    });
    expect(w.classes()).toContain('mj-center--compact');
    expect(w.findAll('image')).toHaveLength(0);
    expect(w.findAll('.mj-center__sep')).toHaveLength(2);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('万5');
  });

  it('可自摸胡文案', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, claimTile: { s: 0, r: 5 }, claimLabel: '可自摸胡' },
    });
    expect(w.text()).toContain('可自摸胡');
  });

  it('末 5 秒紧迫类；active=false 不出倒计时', () => {
    expect(
      mount(MahjongCenter, { props: { ...base, seconds: 4 } })
        .find('.mj-center__clock')
        .classes(),
    ).toContain('mj-center__clock--urgent');
    expect(
      mount(MahjongCenter, { props: { ...base, seconds: 6 } })
        .find('.mj-center__clock')
        .classes(),
    ).not.toContain('mj-center__clock--urgent');
    expect(
      mount(MahjongCenter, { props: { ...base, active: false } })
        .find('.mj-center__clock')
        .exists(),
    ).toBe(false);
  });

  it('紧凑模式字号仍 11px（源码闸；禁止跨 } 匹配，防被文件后段的 11px 救活）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongCenter.vue', 'utf8');
    expect(src).toMatch(/\.mj-center--compact \.mj-center__wall,[^}]*font-size:\s*11px/);
  });

  it('不再渲染「已胡 N 家」', () => {
    const w = mount(MahjongCenter, { props: base });
    expect(w.text()).toContain('牌墙 42');
    expect(w.text()).not.toContain('已胡');
  });

  it('无 claim 时不渲染待响应块', () => {
    const w = mount(MahjongCenter, { props: base });
    expect(w.find('.mj-center__claim').exists()).toBe(false);
  });
});
