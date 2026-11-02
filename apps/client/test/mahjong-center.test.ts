import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Tile } from '@fight-the-landlord/protocol';
import MahjongCenter from '../src/components/table/mahjong/MahjongCenter.vue';

const seats = [
  { label: '对', score: -800, dealer: false, badge: '缺万' },
  { label: '左', score: 1200, dealer: false, badge: '听' },
  { label: '右', score: 0, dealer: true, badge: '胡' },
  { label: '我', score: 0, dealer: false, badge: '缺筒' },
];

const base = {
  wallCount: 42,
  phaseText: '请出牌',
  seconds: 12,
  active: true,
  seats,
  tingW: 20,
  tingH: 27,
};

const ting13: Tile[] = Array.from({ length: 13 }, (_, i) => ({
  s: 0 as const,
  r: ((i % 9) + 1) as Tile['r'],
}));

function styleOf(src: string): string {
  return [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) =>
      m[1]!
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '),
    )
    .join('\n');
}

describe('MahjongCenter（天月对齐 v2）', () => {
  it('四家：label/score/badge/dealer 全部渲染', () => {
    const w = mount(MahjongCenter, { props: base });
    const cells = w.findAll('.mj-center__cell');
    expect(cells).toHaveLength(4);
    expect(cells[0]!.text()).toContain('对');
    expect(cells[0]!.text()).toContain('-800');
    expect(cells[0]!.text()).toContain('缺万');
    expect(cells[1]!.text()).toContain('+1200');
    expect(cells[1]!.text()).toContain('听');
    expect(cells[2]!.text()).toContain('庄');
    expect(cells[2]!.text()).toContain('胡');
    expect(cells[3]!.text()).toContain('我');
    expect(cells[3]!.text()).toContain('缺筒');
  });

  it('分数：0/+/- 原样，>=100万走万', () => {
    const w = mount(MahjongCenter, {
      props: {
        ...base,
        seats: [
          { label: '对', score: 0, dealer: false, badge: '' },
          { label: '左', score: -800, dealer: false, badge: '' },
          { label: '右', score: 1200, dealer: false, badge: '' },
          { label: '我', score: 1230000, dealer: false, badge: '' },
        ],
      },
    });
    expect(w.text()).toContain('0');
    expect(w.text()).toContain('-800');
    expect(w.text()).toContain('+1200');
    expect(w.text()).toContain('123.0万');
  });

  it('无 seats 不渲染四家列', () => {
    const w = mount(MahjongCenter, { props: { ...base, seats: [] } });
    expect(w.findAll('.mj-center__cell')).toHaveLength(0);
    expect(w.find('.mj-center__value').text()).toContain('12');
  });

  it('active + seconds>0：圆盘显示秒数', () => {
    const w = mount(MahjongCenter, { props: base });
    expect(w.find('.mj-center__value').text()).toContain('12');
    expect(w.text()).toContain('牌墙 42');
    expect(w.text()).toContain('请出牌');
  });

  it('active=false：圆盘显示牌墙数，不显示 12', () => {
    const w = mount(MahjongCenter, { props: { ...base, active: false } });
    expect(w.find('.mj-center__value').text()).toContain('42');
    expect(w.find('.mj-center__value').text()).not.toContain('12');
  });

  it('active + seconds=0：显示牌墙数，无 urgent', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 0 } });
    expect(w.find('.mj-center__value').text()).toContain('42');
    expect(w.find('.mj-center__dial').classes()).not.toContain('mj-center__dial--urgent');
  });

  it('active + seconds=6：非 urgent', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 6 } });
    expect(w.find('.mj-center__dial').classes()).not.toContain('mj-center__dial--urgent');
  });

  it('active + seconds=5：urgent + anim-urgent-pulse', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 5 } });
    expect(w.find('.mj-center__dial').classes()).toContain('mj-center__dial--urgent');
    expect(w.find('.mj-center__dial').classes()).toContain('anim-urgent-pulse');
  });

  it('ended：圆盘显示终，隐藏听牌，显示 endedText', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, ended: true, endedText: '已胡 2 家', tingTiles: ting13 },
    });
    expect(w.find('.mj-center__value').text()).toContain('终');
    expect(w.text()).toContain('已胡 2 家');
    expect(w.findAll('.mj-tile')).toHaveLength(0);
  });

  it('13 张听牌：最多 8 张 + 听 13 张 + fan', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, tingTiles: ting13, maxFan: 5 },
    });
    expect(w.findAll('.mj-tile')).toHaveLength(8);
    expect(w.text()).toContain('听 13 张');
    expect(w.text()).toContain('5番');
    expect(w.find('.mj-center__fan').exists()).toBe(true);
  });

  it('紧凑：单行、无牌面', () => {
    const w = mount(MahjongCenter, { props: { ...base, compact: true } });
    expect(w.classes()).toContain('mj-center--compact');
    expect(w.findAll('image')).toHaveLength(0);
    expect(w.text()).toContain('牌墙 42');
    expect(w.text()).toContain('12s');
  });

  it('源码闸：panel token、无 claim、尺寸/行高/字体 token', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongCenter.vue', 'utf8');
    const s = styleOf(src);
    expect(s).toContain('$ftl-color-mj-panel');
    expect(src).not.toContain('claimTile');
    const root = /\.mj-center\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
    expect(root).not.toMatch(/\bborder\s*:/);
    expect(root).not.toMatch(/\bgap\s*:/);
    expect(root).toContain('box-shadow');
    const dial = /\.mj-center__dial\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
    expect(dial).toContain('width: 80px');
    expect(dial).toContain('height: 80px');
    expect(dial).toContain('box-sizing: border-box');
    const strip = /\.mj-center__strip\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
    expect(strip).toContain('height: 28px');
    const body = /\.mj-center__body\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
    expect(body).toContain('height: 80px');
    const col = /\.mj-center__col\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
    expect(col).toContain('width: 100px');
    const cell = /\.mj-center__cell\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
    expect(cell).toContain('height: 40px');
    expect(cell).toContain('line-height: 1');
    expect(s).toContain('$ftl-font-mj-mini');
    expect(s).toContain('$ftl-font-mj-badge');
    expect(src).toContain("@import '../../../styles/animations.scss'");
  });
});
