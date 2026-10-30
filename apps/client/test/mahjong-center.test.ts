import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongCenter from '../src/components/table/mahjong/MahjongCenter.vue';

const base = {
  wallCount: 42,
  phaseText: '请出牌',
  seconds: 12,
  active: true,
  claimW: 34,
  claimH: 51,
  tingW: 20,
  tingH: 30,
};

describe('MahjongCenter', () => {
  it('牌墙/阶段/倒计时', () => {
    const w = mount(MahjongCenter, { props: base });
    // P1: 牌墙现在是药丸格式 "🀄 42" 而非纯文本 "牌墙 42"
    expect(w.text()).toContain('🀄 42');
    expect(w.text()).toContain('请出牌');
    expect(w.find('.mj-center__clock').text()).toContain('12');
  });

  it('末 5 秒紧迫类', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 4 } });
    expect(w.find('.mj-center__clock').classes()).toContain('mj-center__clock--urgent');
    const calm = mount(MahjongCenter, { props: { ...base, seconds: 6 } });
    expect(calm.find('.mj-center__clock').classes()).not.toContain('mj-center__clock--urgent');
  });

  it('待响应牌 + 听牌', () => {
    const w = mount(MahjongCenter, {
      props: {
        ...base,
        claimTile: { s: 0, r: 5 },
        tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }],
        maxFan: 5,
      },
    });
    expect(w.findAll('image')).toHaveLength(3);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('听');
    expect(w.text()).toContain('5 番');
    expect(w.findAll('.mj-tile')[0]!.attributes('style')).toContain('width: 34px');
    expect(w.findAll('.mj-tile')[1]!.attributes('style')).toContain('width: 20px');
  });

  it('紧凑模式：单行、不出牌面、只出文字', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, compact: true, claimTile: { s: 0, r: 5 } },
    });
    expect(w.classes()).toContain('mj-center--compact');
    // P1: compact 模式移除了旧 sep 元素（用药丸替代），所以 sep 数量是 0
    expect(w.findAll('.mj-center__sep')).toHaveLength(0);
    expect(w.findAll('image')).toHaveLength(0);
    // compact-foot 应该显示可响应 + 万5
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('万5');
  });

  it('紧凑模式字号降到 12px（源码闸）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongCenter.vue', 'utf8');
    // P1: compact 模式 phase 字号降到 12px（药丸/phase 不再走 wall 类）
    expect(src).toMatch(/\.mj-center--compact &\s*\{[\s\S]*?font-size:\s*12px/);
  });

  it('已胡家数文案', () => {
    const w = mount(MahjongCenter, { props: { ...base, endedText: '已胡 2 家' } });
    expect(w.text()).toContain('已胡 2 家');
  });

  it('active=false 不渲染倒计时', () => {
    const w = mount(MahjongCenter, { props: { ...base, active: false } });
    expect(w.find('.mj-center__clock').exists()).toBe(false);
  });
});
