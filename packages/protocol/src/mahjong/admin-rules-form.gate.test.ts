/**
 * 四川麻将规则表单描述表 ⇄ 协议 的**行为级等价门禁**（2026-10-29）。
 *
 * 为什么是行为级：描述表在 admin 里是一份独立的枚举/范围副本。这里不比对文本，
 * 而是把描述表的每个选项/边界喂给**真** `parseMahjongRules`——协议改范围、改枚举、
 * 增删番键，本闸必红；协议重构实现而不改语义时，本闸保持绿。
 *
 * 提取失败/为空 ⇒ 直接失败（不允许静默空测）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsLiteral } from '@fight-the-landlord/test-utils';
import {
  DEFAULT_CHENGDU_RULES,
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
  parseMahjongRules,
} from './index';

/** 从 cwd 向上找仓库根（锚 = packages/protocol/package.json 的 name；找不到抛错）。 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/protocol"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/protocol/package.json）——绝不静默空测');
}

interface FormField {
  path: string;
  type: 'bool' | 'int' | 'enum';
  min?: number;
  max?: number;
  valueType?: 'number';
  options?: Array<[string | number, string]>;
}
interface FormGroup {
  id: string;
  title: string;
  table?: string;
  fields?: FormField[];
}
interface FormTable {
  keys: string[];
  min: number;
  max: number;
}
interface MahjongRulesForm {
  fanLabels: Record<string, string>;
  tables: Record<string, FormTable>;
  groups: FormGroup[];
}

const REPO = findRepoRoot();
const FORM = extractJsLiteral(
  readFileSync(join(REPO, 'admin', 'app.js'), 'utf-8'),
  'MAHJONG_RULES_FORM',
) as MahjongRulesForm;

const DEFAULTS = DEFAULT_CHENGDU_RULES as unknown as Record<string, unknown>;
const TABLE_NAMES = new Set(['fanTable', 'additiveFanTable', 'optionalFans']);
/** 顶层**标量**字段（三张表由 FORM.tables 单独验）。 */
const TOP_PATHS = Object.keys(DEFAULTS).filter(
  (k) => k !== 'preset' && k !== 'rulesVersion' && !TABLE_NAMES.has(k),
);

describe('MAHJONG_RULES_FORM ⇄ protocol', () => {
  it('描述表可被提取且结构完整', () => {
    expect(FORM).toBeTruthy();
    expect(Object.keys(FORM.tables).sort()).toEqual(
      ['additiveFanTable', 'fanTable', 'optionalFans'].sort(),
    );
    expect(FORM.groups.length).toBe(8);
  });

  it('顶层标量字段集合 = 协议默认对象 − {preset, rulesVersion} − 三张表，无重复', () => {
    const fields = FORM.groups.flatMap((g) => g.fields ?? []);
    const paths = fields.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual([...TOP_PATHS].sort());
  });

  it('bool 字段集合 = 默认值为 boolean 的顶层键', () => {
    const bools = FORM.groups
      .flatMap((g) => g.fields ?? [])
      .filter((f) => f.type === 'bool')
      .map((f) => f.path)
      .sort();
    const expected = TOP_PATHS.filter((k) => typeof DEFAULTS[k] === 'boolean').sort();
    expect(bools).toEqual(expected);
  });

  it('每个 enum 选项都被真解析器接受，非法值被拒', () => {
    const enums = FORM.groups.flatMap((g) => g.fields ?? []).filter((f) => f.type === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    for (const f of enums) {
      expect(f.options?.length, `${f.path} 缺 options`).toBeGreaterThan(0);
      for (const [value] of f.options ?? []) {
        const v = f.valueType === 'number' ? Number(value) : value;
        expect(() => parseMahjongRules({ [f.path]: v }), `${f.path}=${String(v)}`).not.toThrow();
      }
      const bad = f.valueType === 'number' ? 2 : '__invalid__';
      expect(() => parseMahjongRules({ [f.path]: bad }), `${f.path} 非法值应被拒`).toThrow();
    }
  });

  it('每个 int 的 min/max 被接受，边界外被拒', () => {
    const ints = FORM.groups.flatMap((g) => g.fields ?? []).filter((f) => f.type === 'int');
    expect(ints.length).toBeGreaterThan(0);
    for (const f of ints) {
      expect(typeof f.min, `${f.path} 缺 min`).toBe('number');
      expect(typeof f.max, `${f.path} 缺 max`).toBe('number');
      expect(() => parseMahjongRules({ [f.path]: f.min }), `${f.path} min`).not.toThrow();
      expect(() => parseMahjongRules({ [f.path]: f.max }), `${f.path} max`).not.toThrow();
      expect(() => parseMahjongRules({ [f.path]: (f.min as number) - 1 })).toThrow();
      expect(() => parseMahjongRules({ [f.path]: (f.max as number) + 1 })).toThrow();
    }
  });

  it('三张番表的键集合与协议常量逐一相等', () => {
    expect([...FORM.tables.fanTable.keys].sort()).toEqual([...MAHJONG_NAMED_FAN_KEYS].sort());
    expect([...FORM.tables.additiveFanTable.keys].sort()).toEqual(
      [...MAHJONG_ADDITIVE_FAN_KEYS].sort(),
    );
    expect([...FORM.tables.optionalFans.keys].sort()).toEqual(
      [...MAHJONG_OPTIONAL_FAN_KEYS].sort(),
    );
  });

  it('fanLabels 恰好覆盖全部番键、无多余', () => {
    const all = new Set(Object.values(FORM.tables).flatMap((t) => t.keys));
    expect(Object.keys(FORM.fanLabels).sort()).toEqual([...all].sort());
  });

  it('按描述表组装的完整对象经真解析器往返不变', () => {
    const sample: Record<string, unknown> = {};
    for (const g of FORM.groups) {
      for (const f of g.fields ?? []) sample[f.path] = DEFAULTS[f.path];
    }
    for (const table of Object.keys(FORM.tables)) sample[table] = DEFAULTS[table];
    sample.preset = 'chengdu';
    sample.rulesVersion = DEFAULTS.rulesVersion;
    expect(parseMahjongRules(sample)).toEqual(
      JSON.parse(JSON.stringify(DEFAULT_CHENGDU_RULES)),
    );
  });

  it('番表 0–20 的边界由真解析器接受/拒绝', () => {
    for (const [table, meta] of Object.entries(FORM.tables)) {
      expect(meta.min).toBe(0);
      expect(meta.max).toBe(20);
      expect(() => parseMahjongRules({ [table]: { [meta.keys[0] as string]: 0 } })).not.toThrow();
      expect(() => parseMahjongRules({ [table]: { [meta.keys[0] as string]: 20 } })).not.toThrow();
      expect(() => parseMahjongRules({ [table]: { [meta.keys[0] as string]: 21 } })).toThrow();
    }
  });
});
