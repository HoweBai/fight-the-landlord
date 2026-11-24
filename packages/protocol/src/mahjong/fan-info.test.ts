import { describe, expect, it } from 'vitest';
import {
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
} from './rules';
import { MAHJONG_FAN_INFO, type MahjongFanKind } from './fan-info';

const ALL_KEYS = [
  ...MAHJONG_NAMED_FAN_KEYS,
  ...MAHJONG_ADDITIVE_FAN_KEYS,
  ...MAHJONG_OPTIONAL_FAN_KEYS,
] as string[];

const EXPECTED_KIND: Record<string, MahjongFanKind> = {
  pingHu: 'namedMain', duiDuiHu: 'namedMain', qingYiSe: 'namedMain',
  daiYaoJiu: 'namedMain', qiDui: 'namedMain', qingDui: 'namedMain',
  jiangDui: 'namedMain', longQiDui: 'namedMain', qingQiDui: 'namedMain',
  qingYaoJiu: 'namedMain', qingLongQiDui: 'namedMain',
  gangShangHua: 'namedAddon', gangShangPao: 'namedAddon',
  qiangGangHu: 'namedAddon', jinGouDiao: 'namedAddon', gen: 'namedAddon',
  ziMo: 'namedAddon',
  root: 'additive', allPungs: 'additive', goldenWait: 'additive',
  fullFlush: 'additive', sevenPairs: 'additive', winAfterKong: 'additive',
  shootAfterKong: 'additive', robbingKong: 'additive', underTheSea: 'additive',
  duanYaoJiu: 'optionalAddon', haiDi: 'optionalAddon', perGang: 'optionalAddon',
  shuangLong: 'optionalMain', sanLong: 'optionalMain',
  shiBaLuoHan: 'optionalMain', tianHu: 'optionalMain', diHu: 'optionalMain',
};

describe('MAHJONG_FAN_INFO', () => {
  it('键集恰等于三张番表键的并集', () => {
    expect(Object.keys(MAHJONG_FAN_INFO).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('kind 分类与既有番表一致', () => {
    for (const key of ALL_KEYS) {
      expect(MAHJONG_FAN_INFO[key]?.kind, key).toBe(EXPECTED_KIND[key]);
    }
  });

  it('每项 label/desc 非空且无嵌套换行；playerCaveat 不出现内部标记', () => {
    for (const key of ALL_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      expect(info.label.trim().length, key).toBeGreaterThan(0);
      expect(info.desc.trim().length, key).toBeGreaterThan(0);
      for (const text of [info.desc, info.example ?? '', info.playerCaveat ?? '']) {
        expect(text, key).not.toContain('\n\n');
        expect(text, key).not.toMatch(/^【/);
        expect(text, key).not.toMatch(/代码未实现|另立片|死配置|settle\.ts|TODO/);
      }
    }
  });

  it('天胡/地胡 wired=false；其余 wired=true', () => {
    for (const key of ALL_KEYS) {
      expect(MAHJONG_FAN_INFO[key]?.wired, key).toBe(key !== 'tianHu' && key !== 'diHu');
    }
  });
});
