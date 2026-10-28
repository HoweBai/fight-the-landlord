# 四川麻将规则配置表单化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把管理后台 `game.mahjong.rules` 的裸 JSON 文本框换成描述表驱动的分组表单（含预设重置、护栏、版本错位自救），服务端契约零改动。

**Architecture:** `admin/app.js` 里新增一个**纯字面量**描述表 `MAHJONG_RULES_FORM`（分组/字段/枚举/范围/番名），由通用渲染器 `buildMahjongRulesEditor` 生成控件；读取时按「存在的番键清空 = 写 0、不存在的番键省略」组装整对象，仍走既有 `saveRow` 原子保存。协议侧用真 `parseMahjongRules` 做行为级门禁，shared 侧校验番名一致性，jsdom 探针覆盖交互。

**Tech Stack:** 原生 JS（admin 无构建）、jsdom 探针、vitest、node:fs 源码门禁。

## Global Constraints

- **纯 admin / 测试 / 文档改动**：不改 protocol 契约、config-service、room-service、客户端、数据库、迁移；协议源码零改动（只在 `packages/shared/src/mahjong/scoring.ts` 加一个 `export`）。
- 单键不变：`game.mahjong.rules` 仍是整对象原子保存；`preset` 永不进入普通保存路径（D3）。
- 番表读写语义（D9）：**快照中存在的番键，输入为空 ⇒ 写 0**；快照中不存在的番键，输入为空 ⇒ 省略。未知顶层键/番种键原样保留（D6）。
- 文案以 `docs/games/mahjong.md` + 代码实际行为为准；`refundOnDraw` 两档、`selfDrawMode` 的 `addBase/addPoint`、`chajiaoAllSameState` 两档**当前同义**，表单必须如实写明。
- 每个任务 TDD：先红 → 最小实现 → 绿 → 提交；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 验证命令（Windows 优先）：
  - `pnpm --filter @fight-the-landlord/test-utils build`
  - `pnpm -C packages/protocol test -- admin-rules-form.gate`
  - `pnpm -C packages/shared test -- admin-mahjong-labels.gate`
  - `node scripts/verify-admin-static.mjs`（期望 `admin static verify: N checks passed`）
  - `node scripts/admin-mahjong-rules-form-probe.mjs`（期望 `admin mahjong rules form probe: all checks passed`）
  - `node scripts/admin-config-tabs-probe.mjs`
- 不夹带无关重构；只改本任务列出的文件。

## 文件结构

| 文件 | 职责 |
|---|---|
| `admin/app.js` | 描述表 `MAHJONG_RULES_FORM`、预设名表、渲染器、`CONFIG_NOTES` / `STRUCT_META` 文案 |
| `admin/style.css` | `.mj-*` 分组/番表/信息条/护栏样式 |
| `scripts/admin-mahjong-rules-form-probe.mjs` | 新 jsdom 探针（渲染/保存/重置/护栏/自救） |
| `scripts/verify-admin-static.mjs` | 新增表单针脚 |
| `scripts/ci.sh`、`package.json` | 探针接线（stage 7 + `verify:admin-mahjong-rules`） |
| `packages/test-utils/src/extract-js-literal.ts`、`index.ts` | 跨包测试工具：从源码提取纯对象字面量 |
| `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts` | 行为级门禁（真解析器验证描述表） |
| `packages/shared/src/mahjong/scoring.ts` | `NAMED_LABELS` 加 `export`（无行为变化） |
| `packages/shared/test/admin-mahjong-labels.gate.test.ts` | 番名一致性门禁 |
| `docs/games/mahjong.md` | §8 增加后台表单说明 + 差异标注 |
| `admin/index.html`、`scripts/admin-config-tabs-probe.mjs` | 随 `053a63a1` cherry-pick |

---

### Task 0: 合入麻将配置域左树叶（`053a63a1`）

**Files:**
- Modify: `admin/app.js`、`admin/index.html`、`scripts/verify-admin-static.mjs`、`scripts/admin-config-tabs-probe.mjs`（cherry-pick 带来）

**Interfaces:**
- Consumes: `majiang` 分支上的 `053a63a1`（已 `git apply --check` 通过）。
- Produces: `#nav-cfg-mahjong-btn` / `#nav-count-mahjong` 左树叶；`CFG_NAV` 含 mahjong 域。

- [ ] **Step 1: cherry-pick**

```bash
cd d:/Code/pokergame
git cherry-pick 053a63a1
```

Expected: 无冲突（若冲突，保留本仓当前内容 + 只补 CFG_NAV 的 mahjong 项与 index.html 按钮）。

- [ ] **Step 2: 跑既有闸**

```bash
node scripts/verify-admin-static.mjs
node scripts/admin-config-tabs-probe.mjs
```

Expected: 两个脚本均 `all checks passed` / `checks passed`。

- [ ] **Step 3: 验证入口可达**

```bash
node -e "const s=require('fs').readFileSync('admin/app.js','utf8');console.log(/nav-cfg-mahjong-btn/.test(s), /\{ leaf: 'nav-cfg-mahjong-btn'/.test(s))"
```

Expected: `true true`。

- [ ] **Step 4: 提交（cherry-pick 已生成提交，此步仅确认）**

```bash
git log -1 --oneline
git status --short
```

Expected: 顶部为 `fix(admin): 四川麻将配置域补左树叶…`；工作区干净。

---

### Task 1: 描述表 + 提取工具 + protocol 行为级门禁

**Files:**
- Create: `packages/test-utils/src/extract-js-literal.ts`
- Modify: `packages/test-utils/src/index.ts`
- Create: `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`
- Modify: `admin/app.js`（新增 `MAHJONG_RULES_FORM` 与 `MAHJONG_PRESET_LABELS`，放在 `STRUCT_META` 之后）

**Interfaces:**
- Produces: `extractJsLiteral(source: string, constName: string): unknown`（test-utils 导出，找不到/不平衡直接 throw）。
- Produces: `MAHJONG_RULES_FORM = { fanLabels, tables, groups }`（admin 全局常量，纯字面量）。
- Produces: `MAHJONG_PRESET_LABELS = { chengdu: '成都血战到底', sbr: 'SBR 竞技近似' }`。

- [ ] **Step 1: 先写提取工具与门禁（失败测试）**

`packages/test-utils/src/extract-js-literal.ts`：

```ts
/**
 * 从 JS/TS 源码文本里提取 `const <name> = { … };` 的**纯字面量**并求值。
 * 字符串感知（跳过 ' / " / ` 内的括号与转义）；找不到或括号不平衡 ⇒ 抛错。
 * 纪律：绝不静默返回 undefined —— 门禁提取失败必须是响亮的红。
 */
export function extractJsLiteral(source: string, constName: string): unknown {
  const marker = `const ${constName} =`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`未找到 ${marker}`);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`${marker} 后没有对象字面量`);
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(open, i + 1);
        return new Function(`"use strict"; return (${literal});`)();
      }
    }
  }
  throw new Error(`${marker} 的对象字面量不平衡`);
}
```

`packages/test-utils/src/index.ts` 追加：

```ts
export { extractJsLiteral } from './extract-js-literal';
```

`packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑门禁确认红**

```bash
pnpm --filter @fight-the-landlord/test-utils build
pnpm -C packages/protocol test -- admin-rules-form.gate
```

Expected: FAIL — `未找到 const MAHJONG_RULES_FORM =`。

- [ ] **Step 3: 写描述表（admin/app.js，`STRUCT_META` 之后）**

```js
/* ── 四川麻将规则表单（2026-10-29）────────────────────────────────
 * 描述表是**纯字面量**（无外部标识符、无函数）：protocol 门禁
 * packages/protocol/src/mahjong/admin-rules-form.gate.test.ts 会从本文件提取它，
 * 用真 parseMahjongRules 验证枚举/范围/番键等价——改这里必须同步协议。 */

/** 预设展示名（只读徽标 + 重置确认文案）。 */
const MAHJONG_PRESET_LABELS = { chengdu: '成都血战到底', sbr: 'SBR 竞技近似' };

const MAHJONG_RULES_FORM = {
  fanLabels: {
    // 命名番表（17）
    pingHu: '平胡',
    duiDuiHu: '对对胡',
    qingYiSe: '清一色',
    daiYaoJiu: '带幺九',
    qiDui: '七对',
    qingDui: '清对',
    jiangDui: '将对',
    longQiDui: '龙七对',
    qingQiDui: '清七对',
    qingYaoJiu: '清幺九',
    qingLongQiDui: '清龙七对',
    gangShangHua: '杠上花',
    gangShangPao: '杠上炮',
    qiangGangHu: '抢杠胡',
    jinGouDiao: '金钩钓',
    gen: '根',
    ziMo: '自摸',
    // 加法番表（9）
    root: '根（每组）',
    allPungs: '碰碰胡',
    goldenWait: '金钩钓',
    fullFlush: '清一色',
    sevenPairs: '七对',
    winAfterKong: '杠上花',
    shootAfterKong: '杠上炮',
    robbingKong: '抢杠胡',
    underTheSea: '海底',
    // 可选番（8）
    duanYaoJiu: '断幺九',
    haiDi: '海底',
    perGang: '每杠',
    shuangLong: '双龙七对',
    sanLong: '三龙七对',
    shiBaLuoHan: '十八罗汉',
    tianHu: '天胡',
    diHu: '地胡',
  },
  tables: {
    fanTable: {
      keys: [
        'pingHu', 'duiDuiHu', 'qingYiSe', 'daiYaoJiu', 'qiDui', 'qingDui', 'jiangDui',
        'longQiDui', 'qingQiDui', 'qingYaoJiu', 'qingLongQiDui', 'gangShangHua',
        'gangShangPao', 'qiangGangHu', 'jinGouDiao', 'gen', 'ziMo',
      ],
      min: 0,
      max: 20,
    },
    additiveFanTable: {
      keys: [
        'root', 'allPungs', 'goldenWait', 'fullFlush', 'sevenPairs', 'winAfterKong',
        'shootAfterKong', 'robbingKong', 'underTheSea',
      ],
      min: 0,
      max: 20,
    },
    optionalFans: {
      keys: [
        'duanYaoJiu', 'haiDi', 'perGang', 'shuangLong', 'sanLong', 'shiBaLuoHan',
        'tianHu', 'diHu',
      ],
      min: 0,
      max: 20,
    },
  },
  groups: [
    {
      id: 'scoring',
      title: '计分',
      fields: [
        {
          path: 'scoringPolicy',
          label: '计分方式',
          type: 'enum',
          options: [
            ['named', '命名番表（成都口径）'],
            ['additive', '加法番表（SBR 口径）'],
          ],
          note: '命名 = 取单一最高主番再加番；加法 = 逐项特征相加。',
        },
        {
          path: 'fanBase',
          label: '底番',
          type: 'enum',
          valueType: 'number',
          options: [
            [1, '1（番从 1 起算：平胡 1 番 = 1× 底）'],
            [0, '0（番从 0 起算：0 番 = 1× 底）'],
          ],
        },
        { path: 'fanCap', label: '封顶番数', type: 'int', min: 1, max: 8 },
        { path: 'minFanToHu', label: '起胡番', type: 'int', min: 0, max: 6, note: '0 = 不设门槛。' },
        {
          path: 'selfDrawMode',
          label: '自摸加成',
          type: 'enum',
          options: [
            ['addBase', '每家多付 1× 底'],
            ['addPoint', '每家多付 1× 底（SBR 写法，当前同 addBase）'],
            ['addFan', '番 +1'],
            ['none', '无加成'],
          ],
          note: 'addBase 与 addPoint 当前实现同义；addFan 读命名番表的「自摸」项，SBR 空表时实际 +0。',
        },
        {
          path: 'rootIncludesKong',
          label: '根包含杠',
          type: 'bool',
          note: '开 = 已杠的四张也算根；龙七对的定义四张始终不算根。',
        },
      ],
    },
    {
      id: 'namedFan',
      title: '命名番表',
      table: 'fanTable',
      note: '仅「命名番表」口径生效；0 或留空 = 该番不成立；平胡建议 ≥1。',
    },
    {
      id: 'additiveFan',
      title: '加法番表',
      table: 'additiveFanTable',
      note: '仅「加法番表」口径生效；全为 0 时任何牌都是 0 番（只按底分结算）。',
    },
    {
      id: 'optionalFan',
      title: '可选番',
      table: 'optionalFans',
      note: '0 = 关闭；非 0 = 满足条件时加该番（每杠 × 杠数）。',
    },
    {
      id: 'flow',
      title: '换牌与流程',
      fields: [
        { path: 'exchangeThreeEnabled', label: '换三张', type: 'bool' },
        {
          path: 'exchangeDirection',
          label: '交换方向',
          type: 'enum',
          options: [
            ['random', '随机（掷骰）'],
            ['clockwise', '下家（顺时针）'],
            ['counterclockwise', '上家（逆时针）'],
            ['opposite', '对家'],
          ],
        },
        { path: 'lastFourForcedHu', label: '最后四张必胡', type: 'bool' },
        {
          path: 'passHuMode',
          label: '过水',
          type: 'enum',
          options: [
            ['off', '不过水（可立即再胡）'],
            ['sameTile', '同张不可再胡'],
            ['sameTileOrHigherFan', '同张需番更高'],
          ],
        },
      ],
    },
    {
      id: 'gang',
      title: '杠与转账',
      fields: [
        {
          path: 'directGangMode',
          label: '直杠付款',
          type: 'enum',
          options: [
            ['contract', '仅点杠者付 2× 底'],
            ['everyone', '点杠者 2× 底 + 其余在场每家 1× 底'],
          ],
        },
        {
          path: 'gangTransfer',
          label: '呼叫转移',
          type: 'enum',
          options: [
            ['none', '不转移（杠分退回）'],
            ['toEachWinner', '转给每个赢家'],
            ['split', '拆分'],
          ],
        },
        {
          path: 'refundOnDraw',
          label: '荒庄退税',
          type: 'enum',
          options: [
            ['nonReadyAll', '所有未听者退'],
            ['kongDeclarerOnly', '仅杠者退'],
          ],
          note: '两档当前实现同义：退税对象都是杠事件收款人且荒庄未听/花猪。',
        },
      ],
    },
    {
      id: 'settle',
      title: '花猪与查叫',
      fields: [
        {
          path: 'huazhuMode',
          label: '花猪处置',
          type: 'enum',
          options: [
            ['payEach', '赔每家封顶分'],
            ['burn48', '销毁 48× 底（SBR）'],
            ['off', '不罚'],
          ],
        },
        {
          path: 'huazhuPayees',
          label: '花猪赔付对象',
          type: 'enum',
          options: [
            ['active', '仍在场的非花猪玩家'],
            ['nonFlowerPig', '除花猪外所有玩家（含已胡者）'],
          ],
        },
        { path: 'chajiaoEnabled', label: '查大叫', type: 'bool' },
        {
          path: 'chajiaoAllSameState',
          label: '全员同状态',
          type: 'enum',
          options: [
            ['none', '不结算（当前实现与「照常赔付」同义）'],
            ['pay', '照常赔付'],
          ],
          note: '当前代码两档无可观测差异（settle.ts 的守卫分支不产生查叫事件）；文档描述的差异尚未实现，另立片对账。',
        },
      ],
    },
    {
      id: 'timing',
      title: '决策时长',
      fields: [
        { path: 'claimWindowMs', label: '出牌响应窗口', type: 'int', min: 1000, max: 60000, unit: '毫秒' },
        { path: 'exchangeWindowMs', label: '换三张窗口', type: 'int', min: 1000, max: 60000, unit: '毫秒' },
        { path: 'lackWindowMs', label: '定缺窗口', type: 'int', min: 1000, max: 60000, unit: '毫秒' },
      ],
    },
  ],
};
```

- [ ] **Step 4: 跑门禁确认绿**

```bash
pnpm -C packages/protocol test -- admin-rules-form.gate
```

Expected: 9 个用例全 PASS。

- [ ] **Step 5: 提交**

```bash
git add admin/app.js packages/test-utils/src packages/protocol/src/mahjong/admin-rules-form.gate.test.ts
git commit -m "feat(admin): 四川麻将规则表单描述表 + protocol 行为级门禁

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 渲染器骨架（分组/控件/番表）+ 样式 + 探针骨架

**Files:**
- Modify: `admin/app.js`（`buildStructCard` 分支 + 新函数 `buildMahjongRulesEditor`，删除 `buildRulesJsonEditor`）
- Modify: `admin/style.css`
- Create: `scripts/admin-mahjong-rules-form-probe.mjs`

**Interfaces:**
- Consumes: `MAHJONG_RULES_FORM`、`MAHJONG_PRESET_LABELS`（Task 1）。
- Produces: `buildMahjongRulesEditor(body, ctx)`；DOM 约定 `[data-field]`、`.mj-field`、`.mj-fan-row`、`[data-group]`。

- [ ] **Step 1: 写探针（渲染断言，失败）**

`scripts/admin-mahjong-rules-form-probe.mjs`：

```js
#!/usr/bin/env node
/**
 * 四川麻将规则表单探针（2026-10-29）。
 * jsdom 加载真实 admin/index.html + app.js，桩 fetch/sessionStorage/confirm；
 * fetch 是**有状态**的：PUT 更新内存快照，GET 返回最新值（否则验证不了保存后的重渲染）。
 * 运行：node scripts/admin-mahjong-rules-form-probe.mjs（仓库根）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/client/package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = process.cwd();
const html = readFileSync(`${ROOT}/admin/index.html`, 'utf8');
const appJs = readFileSync(`${ROOT}/admin/app.js`, 'utf8');

const failures = [];
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e)));
const ok = (cond, label) => {
  if (cond) console.log(`✓ ${label}`);
  else {
    failures.push(label);
    console.log(`✗ ${label}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 1500, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}
const $ = (w, id) => w.document.getElementById(id);
const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => [...w.document.querySelectorAll(sel)];
const clickEl = (w, node) => {
  if (!node) return false;
  node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return true;
};
const json = (status, body) => ({ status, json: async () => body });

/** 测试夹具：与 protocol DEFAULT_CHENGDU_RULES 同形（探针专用，不参与门禁）。 */
const RULES = {
  preset: 'chengdu',
  rulesVersion: 1,
  scoringPolicy: 'named',
  fanBase: 1,
  fanCap: 6,
  fanTable: {
    pingHu: 1, duiDuiHu: 2, qingYiSe: 3, daiYaoJiu: 3, qiDui: 3, qingDui: 4,
    jiangDui: 4, longQiDui: 5, qingQiDui: 5, qingYaoJiu: 5, qingLongQiDui: 6,
    gangShangHua: 1, gangShangPao: 1, qiangGangHu: 1, jinGouDiao: 1, gen: 1, ziMo: 1,
  },
  additiveFanTable: {},
  rootIncludesKong: false,
  selfDrawMode: 'addBase',
  minFanToHu: 0,
  exchangeThreeEnabled: true,
  exchangeDirection: 'random',
  lastFourForcedHu: true,
  passHuMode: 'sameTileOrHigherFan',
  directGangMode: 'contract',
  gangTransfer: 'toEachWinner',
  refundOnDraw: 'nonReadyAll',
  huazhuMode: 'payEach',
  huazhuPayees: 'active',
  chajiaoEnabled: true,
  chajiaoAllSameState: 'pay',
  optionalFans: {
    duanYaoJiu: 0, haiDi: 0, perGang: 0, shuangLong: 0,
    sanLong: 0, shiBaLuoHan: 0, tianHu: 0, diHu: 0,
  },
  claimWindowMs: 5000,
  exchangeWindowMs: 15000,
  lackWindowMs: 15000,
};

function baseSnapshot(rules) {
  return {
    'game.doudizhu.enabled': true,
    'game.paodekuai.enabled': false,
    'game.mahjong.enabled': true,
    'game.levels.mahjong': [
      { name: '休闲场', baseScore: 15, entryFeePercent: 0 },
      { name: '标准场', baseScore: 80, entryFeePercent: 0 },
    ],
    'game.mahjong.rules': rules,
  };
}

function makeDom(snapshot) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message ?? e)));
  const dom = new JSDOM(html, {
    url: 'https://localhost/admin/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.confirm = () => true;
  const state = { snapshot: JSON.parse(JSON.stringify(snapshot)), lastPut: null };
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    if (u.startsWith('/api/admin/config/') && method === 'PUT') {
      const key = decodeURIComponent(u.slice('/api/admin/config/'.length));
      const body = JSON.parse(opts.body);
      state.lastPut = { key, body };
      state.snapshot[key] = { value: body.value, version: (state.snapshot[key]?.version ?? 1) + 1 };
      return json(200, { code: 0, data: { version: state.snapshot[key].version, announced: true } });
    }
    if (u.startsWith('/api/admin/config')) {
      const config = {};
      for (const [k, v] of Object.entries(state.snapshot)) {
        config[k] = { value: v, version: 1 };
      }
      return json(200, { code: 0, data: { config, version: 1 } });
    }
    return json(200, { code: 0, data: {} });
  };
  window.sessionStorage.setItem('ftl-admin-token', 't');
  window.sessionStorage.setItem('ftl-admin-username', 'admin');
  window.sessionStorage.setItem('ftl-admin-role', 'super_admin');
  window.eval(appJs);
  return { window, state, errors };
}

const { window, state, errors } = makeDom(baseSnapshot(RULES));
const card = () => q(window, '[data-key="game.mahjong.rules"]');
const fieldEl = (p) => card()?.querySelector(`[data-field="${p}"]`);
/** 同时发 input + change：文本/数字控件听 input，select 听 change（两者都发最稳）。 */
const setInput = (node, value) => {
  node.value = String(value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
  node.dispatchEvent(new window.Event('change', { bubbles: true }));
};

ok(await waitFor(() => $(window, 'nav-cfg-mahjong-btn')), '左树麻将叶存在');
clickEl(window, $(window, 'nav-cfg-mahjong-btn'));
ok(await waitFor(() => card() !== null), '麻将域「玩法规则」出现规则卡');
ok(qa(window, '#settings-rows .mj-group').length === 8, `8 个分组（实测 ${qa(window, '#settings-rows .mj-group').length}）`);
ok(qa(window, '#settings-rows .mj-field').length === 20, `20 个字段控件（实测 ${qa(window, '#settings-rows .mj-field').length}）`);
ok(qa(window, '#settings-rows .mj-fan-row').length === 34, `34 个番表输入（实测 ${qa(window, '#settings-rows .mj-fan-row').length}）`);
ok(fieldEl('fanCap')?.querySelector('input')?.value === '6', 'fanCap 初值 6');
ok(fieldEl('huazhuMode')?.querySelector('select')?.value === 'payEach', 'huazhuMode 初值 payEach');
ok(fieldEl('fanTable.pingHu')?.querySelector('input')?.value === '1', '番表 pingHu 初值 1');
ok(q(window, '#settings-rows .mj-fan-group')?.tagName === 'DETAILS', '番表组是折叠 details');

ok(errors.length === 0, `零运行时异常（实测 ${errors.length}）`);
ok(unhandled.length === 0, `零未处理 rejection（实测 ${unhandled.length}）`);

if (failures.length) {
  console.error(`admin mahjong rules form probe: ${failures.length} FAILED`);
  process.exit(1);
}
console.log('admin mahjong rules form probe: all checks passed');
```

- [ ] **Step 2: 跑探针确认红**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: FAIL —— 规则卡里还是 `textarea.json-box`，`.mj-group` 数为 0。

- [ ] **Step 3: 写渲染器 + 切换分支**

`admin/app.js`：删除 `buildRulesJsonEditor` 整个函数（含其上方注释），把 `buildStructCard` 里的

```js
  else if (key === 'game.mahjong.rules') buildRulesJsonEditor(body, ctx);
```

改为

```js
  else if (key === 'game.mahjong.rules') buildMahjongRulesEditor(body, ctx);
```

并在原 `buildRulesJsonEditor` 的位置放入：

```js
/**
 * 四川麻将规则表单（2026-10-29）：描述表驱动；整对象原子保存。
 * 与其它结构化卡共用行内协议：ctx.bind(read, reset)；read 抛错 ⇒ saveRow 行内拦截。
 * 番表语义（D9）：快照中存在的番键清空 ⇒ 写 0；不存在的番键清空 ⇒ 省略。
 */
function buildMahjongRulesEditor(body, ctx) {
  const snap = ctx.snap && typeof ctx.snap === 'object' ? ctx.snap : {};
  const fieldRefs = new Map();
  const tableRefs = new Map();

  function onChange() {
    ctx.dirty();
    ctx.state('', '');
  }

  function fieldErr(errEl, msg) {
    errEl.textContent = msg;
    throw new Error(msg);
  }

  function buildFieldRow(field) {
    const row = el('div', 'mj-field');
    row.dataset.field = field.path;
    const label = el('label', 'mj-label', field.label);
    label.htmlFor = `mj-${field.path}`;
    row.append(label, el('code', 'mj-key', field.path));
    const errEl = el('p', 'mj-field-err');
    const clearErr = () => {
      errEl.textContent = '';
    };

    if (field.type === 'bool') {
      const wrap = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `mj-${field.path}`;
      input.checked = snap[field.path] === true;
      wrap.append(input, el('span', 'switch-track'));
      row.append(wrap);
      fieldRefs.set(field.path, () => input.checked);
      input.addEventListener('change', () => {
        clearErr();
        onChange();
      });
    } else if (field.type === 'enum') {
      const input = document.createElement('select');
      input.className = 'mj-select';
      input.id = `mj-${field.path}`;
      for (const [value, text] of field.options) {
        const opt = document.createElement('option');
        opt.value = String(value);
        opt.textContent = text;
        input.append(opt);
      }
      input.value = String(snap[field.path]);
      row.append(input);
      fieldRefs.set(field.path, () =>
        field.valueType === 'number' ? Number(input.value) : input.value,
      );
      input.addEventListener('change', () => {
        clearErr();
        onChange();
      });
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'mj-num';
      input.id = `mj-${field.path}`;
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = '1';
      input.value = String(snap[field.path]);
      row.append(input);
      if (field.unit) row.append(el('span', 'mj-unit', field.unit));
      fieldRefs.set(field.path, () => {
        const raw = input.value.trim();
        if (raw === '') fieldErr(errEl, `「${field.label}」不能为空`);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < field.min || n > field.max) {
          fieldErr(errEl, `「${field.label}」须为 ${field.min}–${field.max} 的整数`);
        }
        return n;
      });
      input.addEventListener('input', () => {
        clearErr();
        onChange();
      });
    }
    if (field.note) row.append(el('p', 'mj-note', field.note));
    row.append(errEl);
    return row;
  }

  function buildFieldGroup(group) {
    const sec = el('section', 'mj-group');
    sec.dataset.group = group.id;
    sec.append(el('h4', 'mj-group-title', group.title));
    if (group.note) sec.append(el('p', 'mj-group-note', group.note));
    for (const field of group.fields ?? []) {
      if (!Object.hasOwn(snap, field.path)) continue;
      sec.append(buildFieldRow(field));
    }
    return sec;
  }

  function buildFanGroup(group) {
    const meta = MAHJONG_RULES_FORM.tables[group.table];
    const src =
      snap[group.table] && typeof snap[group.table] === 'object' ? snap[group.table] : {};
    const details = document.createElement('details');
    details.className = 'mj-group mj-fan-group';
    details.dataset.group = group.id;
    const summary = document.createElement('summary');
    summary.textContent = `${group.title}（${meta.keys.length} 项）`;
    details.append(summary);
    if (group.note) details.append(el('p', 'mj-group-note', group.note));
    const rows = new Map();
    for (const fanKey of meta.keys) {
      const row = el('div', 'mj-fan-row');
      row.dataset.field = `${group.table}.${fanKey}`;
      row.append(el('span', 'mj-fan-name', MAHJONG_RULES_FORM.fanLabels[fanKey] ?? fanKey));
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'mj-num';
      input.min = String(meta.min);
      input.max = String(meta.max);
      input.step = '1';
      input.value = Object.hasOwn(src, fanKey) ? String(src[fanKey]) : '';
      if (!Object.hasOwn(src, fanKey)) input.placeholder = '未设置';
      const errEl = el('p', 'mj-field-err');
      input.addEventListener('input', () => {
        errEl.textContent = '';
        onChange();
      });
      row.append(input, errEl);
      rows.set(fanKey, { input, errEl });
      details.append(row);
    }
    tableRefs.set(group.table, rows);
    return details;
  }

  function buildGroups() {
    const box = el('div', 'mj-groups');
    for (const group of MAHJONG_RULES_FORM.groups) {
      box.append(group.table ? buildFanGroup(group) : buildFieldGroup(group));
    }
    return box;
  }

  function readValue() {
    return snap;
  }

  function paint() {
    body.textContent = '';
    fieldRefs.clear();
    tableRefs.clear();
    body.append(buildGroups());
  }

  ctx.bind(readValue, paint);
  paint();
}
```

- [ ] **Step 4: 加样式（`admin/style.css` 末尾）**

```css
/* ── 四川麻将规则表单（2026-10-29）──────────────────────────── */
.mj-preset-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.mj-preset-now { font-size: 13px; font-weight: 600; }
.mj-ver { font-size: 11px; color: var(--dim); }
.mj-reset-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); }
.mj-select {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
}
.mj-banners { display: flex; flex-direction: column; gap: 6px; }
.mj-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(90, 160, 255, 0.1);
  border: 1px solid rgba(90, 160, 255, 0.35);
}
.mj-banner-warn { background: rgba(255, 190, 80, 0.08); border-color: rgba(255, 190, 80, 0.35); }
.mj-warnings { display: flex; flex-direction: column; gap: 4px; }
.mj-warn { margin: 0; font-size: 12px; color: var(--warn); }
.mj-group { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 10px; }
.mj-group-title { margin: 0 0 6px; font-size: 13px; }
.mj-group-note { margin: 0 0 8px; font-size: 12px; color: var(--dim); }
.mj-field {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 4px 10px;
  align-items: center;
  padding: 4px 0;
}
.mj-label { font-size: 13px; }
.mj-key { font-size: 10px; color: var(--dim); }
.mj-num {
  width: 120px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
}
.mj-unit { font-size: 12px; color: var(--dim); }
.mj-note, .mj-field-err { grid-column: 2; margin: 0; font-size: 11px; }
.mj-note { color: var(--dim); }
.mj-field-err { color: var(--err); }
.mj-field-err:empty { display: none; }
.mj-fan-group summary { cursor: pointer; font-size: 13px; font-weight: 600; }
.mj-fan-row { display: flex; align-items: center; gap: 10px; padding: 3px 0 3px 12px; flex-wrap: wrap; }
.mj-fan-name { width: 120px; font-size: 13px; }
.mj-fan-row .mj-field-err { flex-basis: 100%; padding-left: 130px; }
```

- [ ] **Step 5: 跑探针确认绿**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: `admin mahjong rules form probe: all checks passed`。

- [ ] **Step 6: 提交**

```bash
git add admin/app.js admin/style.css scripts/admin-mahjong-rules-form-probe.mjs
git commit -m "feat(admin): 四川麻将规则分组表单渲染（替换 raw JSON 编辑器）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 读取 / 本地校验 / 保存语义（D3 + D9）

**Files:**
- Modify: `admin/app.js`（替换 `readValue`）
- Modify: `scripts/admin-mahjong-rules-form-probe.mjs`（追加保存断言）

**Interfaces:**
- Produces: `readValue()` 输出完整规则对象：控件字段 + `preset`/`rulesVersion` 取快照 + 三张番表按 D9 组装。

- [ ] **Step 1: 先追加探针断言（失败）**

在探针 `ok(errors.length === 0, …)` 之前插入：

```js
/* ── 保存语义（D3 / D9 / 越界）──────────────────────────── */
const saveBtn = () => card()?.querySelector('.struct-foot .btn.primary');
const footState = () => card()?.querySelector('.row-state');

// 1) 正常保存：只改三处
setInput(fieldEl('fanCap').querySelector('input'), '7');
setInput(fieldEl('huazhuMode').querySelector('select'), 'burn48');
setInput(fieldEl('fanTable.pingHu').querySelector('input'), '2');
state.lastPut = null;
clickEl(window, saveBtn());
await waitFor(() => state.lastPut !== null);
await sleep(60); // 等 saveRow → loadAll 重渲染落定
const expected1 = JSON.parse(JSON.stringify(RULES));
expected1.fanCap = 7;
expected1.huazhuMode = 'burn48';
expected1.fanTable.pingHu = 2;
ok(state.lastPut?.key === 'game.mahjong.rules', 'PUT 命中规则键');
ok(JSON.stringify(state.lastPut?.body.value) === JSON.stringify(expected1), '保存 body = 快照 + 三处改动');
ok(state.lastPut?.body.value.preset === 'chengdu', '保存不改变 preset（D3）');

// 2) D9：存在的番键清空 ⇒ 写 0
await waitFor(() => card() !== null);
setInput(fieldEl('fanTable.pingHu').querySelector('input'), '');
state.lastPut = null;
clickEl(window, saveBtn());
await waitFor(() => state.lastPut !== null);
await sleep(60); // 等 saveRow → loadAll 重渲染落定
ok(state.lastPut?.body.value.fanTable.pingHu === 0, '清空已存在的番键 ⇒ 写 0');

// 3) 越界 ⇒ 行内红字、不发请求
setInput(fieldEl('fanCap').querySelector('input'), '9');
state.lastPut = null;
clickEl(window, saveBtn());
await sleep(80);
ok(state.lastPut === null, '越界不发请求');
ok(footState()?.textContent.includes('封顶番数'), '越界错误写到卡片状态行');
ok(fieldEl('fanCap').querySelector('.mj-field-err')?.textContent.includes('1–8'), '字段行内红字');
setInput(fieldEl('fanCap').querySelector('input'), '6');
```

注意：`JSON.stringify` 比较依赖同键序——表单 `readValue` 的输出顺序是描述表顺序 + preset/rulesVersion + 三张表，与 `RULES` 字面量顺序不同。改为深比较：

```js
import { deepStrictEqual } from 'node:assert';
...
let deepOk = true;
try { deepStrictEqual(state.lastPut?.body.value, expected1); } catch { deepOk = false; }
ok(deepOk, '保存 body = 快照 + 三处改动');
```

（探针顶部加 `import { deepStrictEqual } from 'node:assert';`）

- [ ] **Step 2: 跑探针确认红**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: FAIL —— `readValue` 目前原样返回快照，三处改动不会出现，且越界不会被拦截。

- [ ] **Step 3: 实现 `readValue`（替换 Task 2 的最小版）**

```js
  function readValue() {
    const out = {};
    for (const [path, read] of fieldRefs) {
      out[path] = read();
    }
    out.preset = snap.preset ?? 'chengdu';
    out.rulesVersion = snap.rulesVersion ?? 1;
    for (const [table, meta] of Object.entries(MAHJONG_RULES_FORM.tables)) {
      const src =
        snap[table] && typeof snap[table] === 'object' ? snap[table] : {};
      const tableOut = {};
      const rows = tableRefs.get(table);
      for (const [fanKey, ref] of rows ?? []) {
        const raw = ref.input.value.trim();
        if (raw === '') {
          if (Object.hasOwn(src, fanKey)) tableOut[fanKey] = 0;
          continue;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < meta.min || n > meta.max) {
          fieldErr(
            ref.errEl,
            `「${MAHJONG_RULES_FORM.fanLabels[fanKey] ?? fanKey}」须为 ${meta.min}–${meta.max} 的整数`,
          );
        }
        tableOut[fanKey] = n;
      }
      out[table] = tableOut;
    }
    return out;
  }
```

- [ ] **Step 4: 跑探针确认绿**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: all checks passed（含 7 条新断言）。

- [ ] **Step 5: 提交**

```bash
git add admin/app.js scripts/admin-mahjong-rules-form-probe.mjs
git commit -m "feat(admin): 麻将规则表单读取/校验/保存语义（清空番键写 0，preset 不进保存路径）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 预设栏 + 一键重置 + 实时护栏

**Files:**
- Modify: `admin/app.js`（新增 `buildPresetBar`、`refreshWarnings`、`currentPolicy`、`fanTableAllZero`；`onChange`/`paint` 接线）
- Modify: `scripts/admin-mahjong-rules-form-probe.mjs`

**Interfaces:**
- Produces: `#mj-reset-preset`（select）、文案「按预设重置全部规则」按钮；重置 PUT `{preset, rulesVersion}`。
- Produces: `.mj-warn` 三条护栏。

- [ ] **Step 1: 追加探针断言（失败）**

在 Task 3 的越界断言之后、`errors.length` 之前插入：

```js
/* ── 预设重置 + 护栏 ───────────────────────────────────── */
ok(q(window, '#mj-reset-preset') !== null, '预设重置下拉存在');
ok(card()?.textContent.includes('按预设重置全部规则'), '重置按钮文案');

// 护栏 1：chengdu 快照切 additive（加法表为空）⇒ 黄条
setInput(fieldEl('scoringPolicy').querySelector('select'), 'additive');
ok(
  qa(window, '#settings-rows .mj-warn').some((n) => n.textContent.includes('0 番')),
  '加法番表全 0 时出黄条',
);
setInput(fieldEl('scoringPolicy').querySelector('select'), 'named');

// 护栏 3：起胡番 > 封顶番
setInput(fieldEl('minFanToHu').querySelector('input'), '6');
setInput(fieldEl('fanCap').querySelector('input'), '3');
ok(
  qa(window, '#settings-rows .mj-warn').some((n) => n.textContent.includes('永远无法胡牌')),
  '起胡番高于封顶番时出黄条',
);

// D3 加强：下拉切 sbr 后普通保存仍带快照原 preset
setInput(q(window, '#mj-reset-preset'), 'sbr');
state.lastPut = null;
clickEl(window, saveBtn());
await waitFor(() => state.lastPut !== null);
await sleep(60); // 等 saveRow → loadAll 重渲染落定
ok(state.lastPut?.body.value.preset === 'chengdu', '切下拉不改变保存的 preset（D3）');

// 重置：PUT 恰为 {preset, rulesVersion}
await waitFor(() => card() !== null);
const resetBtn = [...card().querySelectorAll('.mj-preset-bar .btn')].find(
  (b) => b.textContent === '按预设重置全部规则',
);
state.lastPut = null;
clickEl(window, resetBtn);
await waitFor(() => state.lastPut !== null);
await sleep(60); // 等 saveRow → loadAll 重渲染落定
let resetOk = true;
try {
  deepStrictEqual(state.lastPut?.body.value, { preset: 'sbr', rulesVersion: 1 });
} catch {
  resetOk = false;
}
ok(resetOk, "重置 body 恰为 {preset:'sbr', rulesVersion:1}");
await waitFor(() => card()?.textContent.includes('当前预设：SBR 竞技近似'));
ok(card()?.textContent.includes('当前预设：SBR 竞技近似'), '重置后按新预设重渲染');
```

- [ ] **Step 2: 跑探针确认红**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: FAIL —— 无 `#mj-reset-preset`、无 `.mj-warn`。

- [ ] **Step 3: 实现（admin/app.js）**

在 `fieldRefs`/`tableRefs` 声明之后新增：

```js
  const warnings = el('div', 'mj-warnings');
```

`onChange` 改为：

```js
  function onChange() {
    ctx.dirty();
    ctx.state('', '');
    refreshWarnings();
  }
```

在 `buildGroups` 之后新增：

```js
  function buildPresetBar() {
    const bar = el('div', 'mj-preset-bar');
    bar.append(
      el(
        'span',
        'mj-preset-now',
        `当前预设：${MAHJONG_PRESET_LABELS[snap.preset] ?? String(snap.preset ?? 'chengdu')}`,
      ),
      el('span', 'mj-ver', `rulesVersion ${snap.rulesVersion ?? '?'}`),
    );
    const label = el('label', 'mj-reset-label', '重置为');
    const select = document.createElement('select');
    select.className = 'mj-select';
    select.id = 'mj-reset-preset';
    for (const [value, text] of Object.entries(MAHJONG_PRESET_LABELS)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      select.append(opt);
    }
    select.value = snap.preset === 'sbr' ? 'sbr' : 'chengdu';
    label.append(select);
    const resetBtn = btn('按预设重置全部规则', 'btn');
    resetBtn.addEventListener('click', async () => {
      const target = select.value;
      const targetLabel = MAHJONG_PRESET_LABELS[target] ?? target;
      if (
        !confirm(
          `按「${targetLabel}」预设重置全部规则？\n将立即保存并覆盖当前所有规则字段；未保存的修改会丢失。\n（SBR 的花猪 48× 底在金币场还需 game.mahjong.sbrGoldEnabled=开）`,
        )
      ) {
        return;
      }
      resetBtn.disabled = true;
      const res = await putConfigKey('game.mahjong.rules', {
        preset: target,
        rulesVersion: snap.rulesVersion ?? 1,
      });
      resetBtn.disabled = false;
      if (res.ok) await loadAll();
    });
    bar.append(
      label,
      resetBtn,
      el('p', 'mj-group-note', '保存只写入表单里显示的字段，不会改变预设；要整口径切换请用重置按钮。'),
    );
    return bar;
  }

  function currentPolicy() {
    const read = fieldRefs.get('scoringPolicy');
    return read ? read() : snap.scoringPolicy;
  }

  function fanTableAllZero(table) {
    const rows = tableRefs.get(table);
    if (!rows) return true;
    for (const ref of rows.values()) {
      const raw = ref.input.value.trim();
      if (raw !== '' && Number(raw) > 0) return false;
    }
    return true;
  }

  function refreshWarnings() {
    warnings.textContent = '';
    const list = [];
    if (currentPolicy() === 'additive' && fanTableAllZero('additiveFanTable')) {
      list.push('当前所有牌型都是 0 番，只按底分结算。可点「按预设重置」恢复 SBR 默认番表。');
    }
    if (currentPolicy() === 'named' && fanTableAllZero('fanTable')) {
      list.push('命名番表为空：绝大多数牌只按平胡兜底 1 番，请先补齐番值。');
    }
    const minHu = fieldRefs.get('minFanToHu');
    const cap = fieldRefs.get('fanCap');
    if (minHu && cap) {
      try {
        if (minHu() > cap()) list.push('起胡番高于封顶番数：永远无法胡牌。');
      } catch {
        /* 输入未填完时不提示（错误由保存拦截） */
      }
    }
    for (const text of list) warnings.append(el('p', 'mj-warn', text));
  }
```

`paint` 改为：

```js
  function paint() {
    body.textContent = '';
    fieldRefs.clear();
    tableRefs.clear();
    body.append(buildPresetBar(), buildGroups(), warnings);
    refreshWarnings();
  }
```

- [ ] **Step 4: 跑探针确认绿**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: all checks passed。

- [ ] **Step 5: 提交**

```bash
git add admin/app.js scripts/admin-mahjong-rules-form-probe.mjs
git commit -m "feat(admin): 麻将规则预设一键重置 + 实时护栏

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 版本错位自救（缺字段补齐 / 未知键移除）

**Files:**
- Modify: `admin/app.js`（顶部常量 + `buildBanners` + `readValue` + `paint`）
- Modify: `scripts/admin-mahjong-rules-form-probe.mjs`

**Interfaces:**
- Consumes: Task 3 的 `readValue`、Task 4 的 `paint`。
- Produces: `.mj-banner` 两条 + 按钮「按服务端默认补齐」「移除这些未知字段并保存」。

- [ ] **Step 1: 追加探针断言（失败）**

在 `errors.length` 断言之前插入：

```js
/* ── 版本错位自救 ─────────────────────────────────────── */
// A. 未知顶层键：透传 + 移除
{
  const rules = JSON.parse(JSON.stringify(RULES));
  rules.xyzFutureSwitch = true;
  const dom2 = makeDom(baseSnapshot(rules));
  await waitFor(() => $(dom2.window, 'nav-cfg-mahjong-btn'));
  clickEl(dom2.window, $(dom2.window, 'nav-cfg-mahjong-btn'));
  await waitFor(() => q(dom2.window, '[data-key="game.mahjong.rules"]'));
  const c2 = () => q(dom2.window, '[data-key="game.mahjong.rules"]');
  ok(c2().textContent.includes('未认识的新字段'), '未知键信息条出现');
  ok(c2().textContent.includes('xyzFutureSwitch'), '信息条列出未知键名');
  clickEl(dom2.window, c2().querySelector('.struct-foot .btn.primary'));
  await waitFor(() => dom2.state.lastPut !== null);
  ok(dom2.state.lastPut?.body.value.xyzFutureSwitch === true, '未知键原样透传');
  const dropBtn = [...c2().querySelectorAll('.mj-banner .btn')].find(
    (b) => b.textContent === '移除这些未知字段并保存',
  );
  dom2.state.lastPut = null;
  clickEl(dom2.window, dropBtn);
  await waitFor(() => dom2.state.lastPut !== null);
  ok(!('xyzFutureSwitch' in (dom2.state.lastPut?.body.value ?? {})), '移除后保存 body 不含未知键');
  ok(dom2.errors.length === 0, '未知键实例零运行时异常');
}

// B. 快照缺字段：隐藏 + 补齐
{
  const rules = JSON.parse(JSON.stringify(RULES));
  delete rules.claimWindowMs;
  const dom3 = makeDom(baseSnapshot(rules));
  await waitFor(() => $(dom3.window, 'nav-cfg-mahjong-btn'));
  clickEl(dom3.window, $(dom3.window, 'nav-cfg-mahjong-btn'));
  await waitFor(() => q(dom3.window, '[data-key="game.mahjong.rules"]'));
  const c3 = () => q(dom3.window, '[data-key="game.mahjong.rules"]');
  ok(c3().querySelector('[data-field="claimWindowMs"]') === null, '缺失字段不渲染');
  ok(c3().textContent.includes('缺少 1 个规则字段'), '缺失字段信息条出现');
  const fillBtn = [...c3().querySelectorAll('.mj-banner .btn')].find(
    (b) => b.textContent === '按服务端默认补齐',
  );
  dom3.state.lastPut = null;
  clickEl(dom3.window, fillBtn);
  await waitFor(() => dom3.state.lastPut !== null);
  ok(dom3.state.lastPut?.body.value.claimWindowMs === undefined, '补齐 PUT = 原快照（不含缺失字段）');
  ok(dom3.errors.length === 0, '缺字段实例零运行时异常');
}
```

- [ ] **Step 2: 跑探针确认红**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
```

Expected: FAIL —— 无 `.mj-banner`。

- [ ] **Step 3: 实现（admin/app.js）**

在 `snap` 声明之后新增：

```js
  const tableNames = new Set(Object.keys(MAHJONG_RULES_FORM.tables));
  const knownPaths = new Set();
  for (const g of MAHJONG_RULES_FORM.groups) {
    for (const f of g.fields ?? []) knownPaths.add(f.path);
  }
  const unknownTop = Object.keys(snap).filter(
    (k) => k !== 'preset' && k !== 'rulesVersion' && !knownPaths.has(k) && !tableNames.has(k),
  );
  const unknownFan = {};
  for (const [table, meta] of Object.entries(MAHJONG_RULES_FORM.tables)) {
    const src = snap[table] && typeof snap[table] === 'object' ? snap[table] : {};
    const extra = {};
    for (const [k, v] of Object.entries(src)) {
      if (!meta.keys.includes(k)) extra[k] = v;
    }
    unknownFan[table] = extra;
  }
  const unknownFanNames = Object.entries(unknownFan).flatMap(([t, m]) =>
    Object.keys(m).map((k) => `${t}.${k}`),
  );
  const missingTop = [...knownPaths].filter((p) => !Object.hasOwn(snap, p));
  let removeUnknown = false;
```

在 `buildPresetBar` 之后新增：

```js
  function buildBanners() {
    const box = el('div', 'mj-banners');
    if (missingTop.length > 0) {
      const b = el('div', 'mj-banner');
      b.append(
        el('span', '', `快照较旧：缺少 ${missingTop.length} 个规则字段（保存时按服务端默认合并补齐）。`),
      );
      const fill = btn('按服务端默认补齐', 'btn');
      fill.addEventListener('click', async () => {
        fill.disabled = true;
        const res = await putConfigKey('game.mahjong.rules', snap);
        fill.disabled = false;
        if (res.ok) await loadAll();
      });
      b.append(fill);
      box.append(b);
    }
    if (unknownTop.length > 0 || unknownFanNames.length > 0) {
      const names = [...unknownTop, ...unknownFanNames];
      const b = el('div', 'mj-banner mj-banner-warn');
      b.append(el('span', '', `快照含本页未认识的新字段：${names.join('、')}（保存时原样保留）。`));
      const drop = btn('移除这些未知字段并保存', 'btn');
      drop.addEventListener('click', async () => {
        if (!confirm(`移除以下字段并保存？\n${names.join('\n')}\n（移除后不可恢复）`)) return;
        removeUnknown = true;
        let value;
        try {
          value = readValue();
        } catch (err) {
          removeUnknown = false;
          ctx.state(err.message, 'err');
          return;
        }
        drop.disabled = true;
        const res = await putConfigKey('game.mahjong.rules', value);
        drop.disabled = false;
        if (res.ok) await loadAll();
        else removeUnknown = false;
      });
      b.append(drop);
      box.append(b);
    }
    return box;
  }
```

`readValue` 改为（新增未知键透传与番种透传）：

```js
  function readValue() {
    const out = {};
    if (!removeUnknown) {
      for (const k of unknownTop) out[k] = snap[k];
    }
    for (const [path, read] of fieldRefs) {
      out[path] = read();
    }
    out.preset = snap.preset ?? 'chengdu';
    out.rulesVersion = snap.rulesVersion ?? 1;
    for (const [table, meta] of Object.entries(MAHJONG_RULES_FORM.tables)) {
      const src =
        snap[table] && typeof snap[table] === 'object' ? snap[table] : {};
      const tableOut = removeUnknown ? {} : { ...unknownFan[table] };
      const rows = tableRefs.get(table);
      for (const [fanKey, ref] of rows ?? []) {
        const raw = ref.input.value.trim();
        if (raw === '') {
          if (Object.hasOwn(src, fanKey)) tableOut[fanKey] = 0;
          continue;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < meta.min || n > meta.max) {
          fieldErr(
            ref.errEl,
            `「${MAHJONG_RULES_FORM.fanLabels[fanKey] ?? fanKey}」须为 ${meta.min}–${meta.max} 的整数`,
          );
        }
        tableOut[fanKey] = n;
      }
      out[table] = tableOut;
    }
    return out;
  }
```

`paint` 改为：

```js
  function paint() {
    body.textContent = '';
    fieldRefs.clear();
    tableRefs.clear();
    body.append(buildPresetBar(), buildBanners(), buildGroups(), warnings);
    refreshWarnings();
  }
```

- [ ] **Step 4: 跑探针确认绿 + protocol 门禁不回归**

```bash
node scripts/admin-mahjong-rules-form-probe.mjs
pnpm -C packages/protocol test -- admin-rules-form.gate
```

Expected: 探针 all checks passed；门禁 9/9 PASS。

- [ ] **Step 5: 提交**

```bash
git add admin/app.js scripts/admin-mahjong-rules-form-probe.mjs
git commit -m "feat(admin): 麻将规则版本错位自救（缺字段补齐 / 未知键移除并保存）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 静态闸 + 文案 + 文档

**Files:**
- Modify: `scripts/verify-admin-static.mjs`
- Modify: `admin/app.js`（`CONFIG_NOTES`、`STRUCT_META`）
- Modify: `docs/games/mahjong.md`

**Interfaces:**
- Consumes: 全部 admin 实现。
- Produces: 静态闸新针脚；`STRUCT_META` 标题「四川麻将规则」。

- [ ] **Step 1: 先加静态闸断言（失败）**

在 `scripts/verify-admin-static.mjs` 的汇总段之前追加：

```js
/* ── 12. 四川麻将规则表单（2026-10-29）────────────────────────── */
ok(app.includes("'game.mahjong.rules': { label: '四川麻将规则' }"), '麻将规则标题已表单化');
ok(app.includes('const MAHJONG_RULES_FORM'), '麻将规则描述表存在');
ok(app.includes('function buildMahjongRulesEditor'), '麻将规则表单渲染器存在');
ok(!app.includes('function buildRulesJsonEditor'), 'raw JSON 编辑器已移除');
for (const title of ['计分', '命名番表', '加法番表', '可选番', '换牌与流程', '杠与转账', '花猪与查叫', '决策时长']) {
  ok(app.includes(`title: '${title}'`), `麻将表单分组：${title}`);
}
ok(app.includes('按预设重置全部规则'), '预设重置按钮文案');
ok(app.includes('移除这些未知字段并保存'), '未知字段自救按钮文案');
```

- [ ] **Step 2: 跑静态闸确认红**

```bash
node scripts/verify-admin-static.mjs
```

Expected: FAIL —— 标题仍是「四川麻将规则 JSON」、raw JSON 函数仍在（Task 2 已删，但标题未改）。

- [ ] **Step 3: 改文案（admin/app.js）**

`STRUCT_META`：

```js
  'game.mahjong.rules': { label: '四川麻将规则' },
```

`CONFIG_NOTES` 的 `'game.mahjong.rules'` 条目替换为：

```js
  'game.mahjong.rules': [
    ['作用', '四川麻将规则快照（番表/封顶/换三张/呼叫转移/退税/花猪/查叫/时长等全部开关）。'],
    ['取值', '后台以分组表单编辑（计分/番表/换牌与流程/杠与转账/花猪与查叫/决策时长）；保存由服务端按严格 schema 校验。'],
    ['生效', '保存后新开的房间使用新规则；已在局中的沿用开局快照。'],
    ['注意', '保存不会改变预设；要整口径切换用「按预设重置全部规则」。番表项清空 = 关闭该番（写 0）。'],
  ],
```

- [ ] **Step 4: 补文档（docs/games/mahjong.md §8）**

在 §8 表格之后、闸键段落之前插入：

```markdown
**后台编辑**：配置中心 → 玩法 → 四川麻将 → 「玩法规则」页签提供分组表单
（计分 / 命名番表 / 加法番表 / 可选番 / 换牌与流程 / 杠与转账 / 花猪与查叫 / 决策时长），
不再直接编辑 JSON。保存只写入表单里显示的字段、**不改变 `preset`**；整口径切换用
「按预设重置全部规则」（服务端按所选预设补默认值）。番表项清空 = 关闭该番（写 0）——
服务端对缺键会按预设默认合并，所以「删键」并不能关闭番项。

`chajiaoAllSameState`：代码当前两档（`none` / `pay`）**无可观测差异**，与 §6 第 2 条的描述
不一致；该差异另立片对账，本表按当前实际行为标注。
```

- [ ] **Step 5: 跑静态闸确认绿**

```bash
node scripts/verify-admin-static.mjs
```

Expected: `admin static verify: N checks passed`。

- [ ] **Step 6: 提交**

```bash
git add admin/app.js scripts/verify-admin-static.mjs docs/games/mahjong.md
git commit -m "docs(admin): 麻将规则表单文案/静态闸/规则文档同步

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 番名一致性门禁 + CI 接线 + 全量回归

**Files:**
- Modify: `packages/shared/src/mahjong/scoring.ts`（`NAMED_LABELS` 加 `export`）
- Create: `packages/shared/test/admin-mahjong-labels.gate.test.ts`
- Modify: `package.json`、`scripts/ci.sh`

**Interfaces:**
- Consumes: `extractJsLiteral`（Task 1）、`MAHJONG_RULES_FORM.fanLabels`。
- Produces: `verify:admin-mahjong-rules` 脚本；CI stage 7 新探针。

- [ ] **Step 1: 写门禁（失败）**

`packages/shared/src/mahjong/scoring.ts` 的 `const NAMED_LABELS` 改为：

```ts
export const NAMED_LABELS: Record<string, string> = {
```

`packages/shared/test/admin-mahjong-labels.gate.test.ts`：

```ts
/**
 * 四川麻将番名一致性门禁（2026-10-29）。
 * admin 规则表单的 fanLabels 与对局内展示（shared scoring.ts 的 NAMED_LABELS）是两份拷贝；
 * 本闸保证**有交集的键**标签逐字一致，防止后台中文名与牌桌展示名漂移。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsLiteral } from '@fight-the-landlord/test-utils';
import { NAMED_LABELS } from '../src/mahjong/scoring';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    if (
      existsSync(anchor) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/shared/package.json）——绝不静默空测');
}

const REPO = findRepoRoot();
const form = extractJsLiteral(
  readFileSync(join(REPO, 'admin', 'app.js'), 'utf-8'),
  'MAHJONG_RULES_FORM',
) as { fanLabels: Record<string, string> };

describe('admin 番名 ⇄ 对局展示名', () => {
  it('有交集的番键标签逐字一致', () => {
    const overlap = Object.keys(NAMED_LABELS).filter((k) => k in form.fanLabels);
    expect(overlap.length).toBeGreaterThanOrEqual(25);
    for (const key of overlap) {
      expect(form.fanLabels[key], key).toBe(NAMED_LABELS[key]);
    }
  });
});
```

- [ ] **Step 2: 跑门禁确认绿**

```bash
pnpm --filter @fight-the-landlord/shared test -- admin-mahjong-labels.gate
```

Expected: 1/1 PASS。

- [ ] **Step 3: CI 接线**

`package.json` scripts 追加：

```json
"verify:admin-mahjong-rules": "node scripts/admin-mahjong-rules-form-probe.mjs"
```

`scripts/ci.sh` stage 7 追加一行（在 `npm run verify:admin-config-tabs` 之后）：

```bash
npm run verify:admin-mahjong-rules
```

- [ ] **Step 4: 全量回归**

```bash
pnpm -C packages/protocol test
pnpm -C packages/shared test
node scripts/verify-admin-static.mjs
node scripts/admin-mahjong-rules-form-probe.mjs
node scripts/admin-config-tabs-probe.mjs
```

Expected: 全绿；两个探针 `all checks passed`；静态闸 `checks passed`。

- [ ] **Step 5: 全仓（按 dev-process 第 8 节）**

```bash
pnpm test
pnpm lint
```

Expected: 全绿（`Cached` 不算真跑，必要时 `pnpm exec turbo run test lint --force`）。

- [ ] **Step 6: 真浏览器冒烟**

```bash
bash scripts/deploy/preview.sh
```

在浏览器打开 admin → 配置中心 → 四川麻将 → 玩法规则，确认：
分组表单渲染、番表可展开、保存成功、重置确认弹窗文案、无控制台错误。
（本机无 Docker 环境时登记为未执行并同步用户。）

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/mahjong/scoring.ts packages/shared/test/admin-mahjong-labels.gate.test.ts package.json scripts/ci.sh
git commit -m "test: 番名一致性门禁 + 麻将表单探针接入 CI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 计划自查（写完后）

- **Spec 覆盖**：D1–D17 全部有任务承接：D1/D2→T1/T2；D3→T3/T4；D4→T4；D5→T2（删除 raw JSON）；D6/D15→T5（两条信息条与自救按钮）；D7→T1（说明文案）；D8→T2（details 折叠）；D9→T3；D10→T1；D11→T3；D12→T3/T4；D13 既有语义；D14→T1/T6；D16→T1；D17→T1。
- **占位符扫描**：无 TBD/TODO；每个代码步骤给出完整代码。
- **类型/命名一致性**：`MAHJONG_RULES_FORM`、`MAHJONG_PRESET_LABELS`、`buildMahjongRulesEditor`、`readValue`、`refreshWarnings`、`buildPresetBar`、`buildBanners`、`buildGroups`、`buildFieldGroup`、`buildFanGroup` 在各任务中名称一致；探针选择器 `[data-field]`、`.mj-field`、`.mj-fan-row`、`#mj-reset-preset`、`.mj-banner`、`.mj-warn` 前后一致。
- **已知偏差**：spec §4.2 提到 `.mj-field-err` 行内红字——计划保留该元素（字段行内），同时 `saveRow` 仍会把同一错误写到卡片脚注 `.row-state`（既有协议），属预期冗余。
