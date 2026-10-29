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
    expect(w.text()).toContain('牌墙 42');
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
    expect(w.findAll('image')).toHaveLength(0);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('万5');
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
