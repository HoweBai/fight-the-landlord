# 麻将番型说明（admin + 客户端动态番表）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 admin 麻将规则表单的 34 个番键都有常驻说明，并让客户端大厅的麻将玩法介绍在打开时反映后台 `game.mahjong.rules` 的当前配置。

**Architecture:** protocol 持有番型元数据与文案生成器；config-service 把规则收敛成显式客户端白名单 `mahjongRules` 下发；客户端 store 只保存这一份视图，点开介绍时走不修改玩法/场次选择的轻量刷新；admin 保留字面量副本并用内容级门禁锁住；shared 的番名标签从 protocol 派生。

**Tech Stack:** TypeScript monorepo（pnpm + turbo）、vitest、NestJS（config-service）、Pinia + uni-app（client）、原生 JS 静态后台（admin）、jsdom 探针。

## Global Constraints

- 日常开发在 `dev` 分支；每次改动单独提交，提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个任务按 TDD：先写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。
- 协议改动后，跨包测试/lint 前先运行 `pnpm -C packages/protocol build`（config-service 与 `apps/client` 的 `vue-tsc` 走 `packages/protocol/dist`）。
- 客户端字段名必须是 `mahjongRules`；**不得**出现 `rules` 作为出站字段名（`FORBIDDEN_OUTBOUND_KEYS` 含 `rules`）。
- 所有 34 项计数必须从 `MAHJONG_NAMED_FAN_KEYS` / `MAHJONG_ADDITIVE_FAN_KEYS` / `MAHJONG_OPTIONAL_FAN_KEYS` 派生；不得在新测试里硬编码 34/8。
- 玩家可见文案（`desc/example/playerCaveat`）不得包含内部标记：`代码未实现`、`另立片`、`死配置`、`settle.ts`、`TODO`。
- `admin/app.js` 的 `MAHJONG_RULES_FORM` 必须保持纯字面量（可被 `extractJsLiteral` vm 提取），不得引用外部标识符或函数。
- 本片不改规则引擎/结算行为；shared 只允许改标签字典（`NAMED_LABELS`）。
- 所有文本渲染用 `textContent`，不得拼 HTML。
- 每次跑测试用精确命令；不得用「其他测试绿」替代本任务测试。
- 完成后工作区必须干净。

## File Structure

- `packages/protocol/src/mahjong/fan-info.ts`：34 项元数据（label/kind/desc/example/playerCaveat/adminOnly/wired）。
- `packages/protocol/src/mahjong/client-view.ts`：`MahjongRulesClientView` 显式白名单 + `mahjongRulesClientView()`。
- `packages/protocol/src/mahjong/rule-summary.ts`：配置中立段落 + 默认 fallback + `buildMahjongRuleSummary()`。
- `packages/protocol/src/config.ts`：`ClientGameConfig.mahjongRules?`。
- `packages/shared/src/mahjong/scoring.ts`：`NAMED_LABELS` 从元数据派生。
- `packages/config-service/src/config/client-config.controller.ts`：读取并映射 `game.mahjong.rules`。
- `apps/client/src/stores/game.ts`：保存 `mahjongRules`。
- `apps/client/src/composables/useClientConfig.ts`：`refreshMahjongRules()`。
- `apps/client/src/pages/lobby/lobby.vue`：规则弹层动态文案。
- `admin/app.js` / `admin/style.css`：行内说明与样式。
- 测试与探针：protocol/shared/config-service/client 各自测试 + `scripts/admin-mahjong-rules-form-probe.mjs` + `scripts/verify-admin-static.mjs`。

---

### Task 1: protocol 番型元数据 + 覆盖门禁

**Files:**
- Create: `packages/protocol/src/mahjong/fan-info.ts`
- Create: `packages/protocol/src/mahjong/fan-info.test.ts`
- Modify: `packages/protocol/src/mahjong/index.ts`

**Interfaces:**
- Produces: `MahjongFanKind`、`MahjongFanInfo`、`MAHJONG_FAN_INFO: Readonly<Record<string, MahjongFanInfo>>`
- Produces: 所有后续任务使用的 label/desc/example/playerCaveat/adminOnly/wired。

- [ ] **Step 1: 写失败测试**

```ts
// packages/protocol/src/mahjong/fan-info.test.ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/fan-info.test.ts`
Expected: FAIL（找不到 `./fan-info`）。

- [ ] **Step 3: 创建 `fan-info.ts`**

```ts
// packages/protocol/src/mahjong/fan-info.ts
export type MahjongFanKind =
  | 'namedMain'
  | 'namedAddon'
  | 'additive'
  | 'optionalMain'
  | 'optionalAddon';

export interface MahjongFanInfo {
  label: string;
  kind: MahjongFanKind;
  desc: string;
  example?: string;
  playerCaveat?: string;
  adminOnly?: string;
  wired: boolean;
}

const FAN_INFO: Record<string, MahjongFanInfo> = {
  // 命名番表：主番候选
  pingHu: {
    label: '平胡', kind: 'namedMain', wired: true,
    desc: '任意合法胡牌型；不是其他主番时的兜底。',
    example: '1-2-3万 4-5-6万 7-8-9筒 3-4-5条 9-9条',
    playerCaveat: '即使番值配成 0，引擎仍按兜底 1 番处理。',
  },
  duiDuiHu: {
    label: '对对胡', kind: 'namedMain', wired: true,
    desc: '4 副刻子/杠 + 将，没有顺子。',
    example: '1-1-1万 5-5-5筒 8-8-8条 2-2-2-2万(杠) 9-9条',
    playerCaveat: '与七对互斥（七对不按对对胡算）。',
  },
  qingYiSe: {
    label: '清一色', kind: 'namedMain', wired: true,
    desc: '全部牌为同一花色（万/筒/条），含副露。',
    example: '1-2-3万 4-5-6万 7-8-9万 2-3-4万 5-5万',
    playerCaveat: '与对对胡/七对等组合时，按更高的组合主番结算，不叠加。',
  },
  daiYaoJiu: {
    label: '带幺九', kind: 'namedMain', wired: true,
    desc: '每副面子都含 1 或 9，且将牌为 1/9；七对形态则每张都是 1/9。',
    example: '1-2-3万 7-8-9万 1-1-1筒 9-9-9筒 9-9万',
    playerCaveat: '七对形态按“全部牌为 1/9”判定。',
  },
  qiDui: {
    label: '七对', kind: 'namedMain', wired: true,
    desc: '14 张手牌组成 7 个对子，四张相同算两对。',
    example: '1-1万 2-2万 3-3万 5-5筒 7-7筒 9-9条 4-4条',
    playerCaveat: '七对要求无副露（不能有碰/杠）。',
  },
  qingDui: {
    label: '清对', kind: 'namedMain', wired: true,
    desc: '清一色 + 对对胡。',
    example: '1-1-1万 3-3-3万 5-5-5万 7-7-7万 9-9万',
    playerCaveat: '取代清一色/对对胡，不叠加。',
  },
  jiangDui: {
    label: '将对', kind: 'namedMain', wired: true,
    desc: '对对胡且全部牌点数为 2/5/8。',
    example: '2-2-2万 5-5-5筒 8-8-8条 2-2-2-2筒(杠) 5-5条',
    playerCaveat: '全部牌（含副露）都须是 2/5/8，将牌也是。',
  },
  longQiDui: {
    label: '龙七对', kind: 'namedMain', wired: true,
    desc: '七对中含至少 1 组未杠的四张（四张算两对）。',
    example: '1-1万 2-2万 3-3万 5-5-5-5筒 7-7条 9-9条',
    playerCaveat: '该定义四张不再计“根”。',
  },
  qingQiDui: {
    label: '清七对', kind: 'namedMain', wired: true,
    desc: '清一色 + 七对。',
    example: '1-1万 2-2万 3-3万 5-5万 7-7万 8-8万 9-9万',
    playerCaveat: '取代清一色/七对，不叠加。',
  },
  qingYaoJiu: {
    label: '清幺九', kind: 'namedMain', wired: true,
    desc: '清一色 + 带幺九。',
    example: '1-2-3万 1-2-3万 7-8-9万 7-8-9万 1-1万',
    playerCaveat: '取代清一色/带幺九，不叠加。',
  },
  qingLongQiDui: {
    label: '清龙七对', kind: 'namedMain', wired: true,
    desc: '清一色 + 龙七对（含至少 1 组未杠四张）。',
    example: '1-1万 2-2万 3-3万 5-5-5-5万 7-7万 9-9万',
    playerCaveat: '取代清一色/七对/龙七对；定义四张不计根。',
  },

  // 命名番表：另加番
  gangShangHua: {
    label: '杠上花', kind: 'namedAddon', wired: true,
    desc: '杠后补牌自摸胡。',
    example: '任意杠 → 补牌成胡（如暗杠 5-5-5-5筒 后补到 9条 自摸）',
    playerCaveat: '按自摸收付；加番后仍受封顶限制。',
  },
  gangShangPao: {
    label: '杠上炮', kind: 'namedAddon', wired: true,
    desc: '杠后打出的牌被别人点炮胡。',
    example: 'A 杠后打出 3万，B 用 3万 胡',
    playerCaveat: '胡家加番；杠分按“杠分转移”配置处理。',
  },
  qiangGangHu: {
    label: '抢杠胡', kind: 'namedAddon', wired: true,
    desc: '抢别人补杠（弯杠）的牌胡。',
    example: 'A 碰 5筒 后补杠第 4 张 5筒，B 用 5筒 胡',
    playerCaveat: '只能抢补杠，暗杠不可抢；被抢则杠无效、杠分退回。',
  },
  jinGouDiao: {
    label: '金钩钓', kind: 'namedAddon', wired: true,
    desc: '对对胡形态且单吊：胡牌张作将。',
    example: '1-1-1万 5-5-5筒 8-8-8条 9-9-9万 + 单吊 3条',
    playerCaveat: '加在已成立的主番上（通常为对对胡），不是独立主番。',
  },
  gen: {
    label: '根', kind: 'namedAddon', wired: true,
    desc: '四张相同且未杠，每组计一份。',
    example: '手里 5-5-5-5筒 未杠 ⇒ 计 1 组根',
    playerCaveat: '龙七对/清龙七对的定义四张不计根；“根包含杠”开启时副露杠也计根。',
  },
  ziMo: {
    label: '自摸', kind: 'namedAddon', wired: true,
    desc: '自摸时按本值加番。',
    example: '自摸胡牌 ⇒ 按本值加番',
    playerCaveat: '仅“自摸加成 = 番+1”时读取本值；每家多付 1×底/无加成两种模式不读。',
  },

  // 加法番表（SBR）
  root: {
    label: '根（每组）', kind: 'additive', wired: true,
    desc: '每组未杠四张加一份；“根包含杠”开启时副露杠也计。',
    example: '2 组未杠四张 ⇒ 计 2 份',
    playerCaveat: '仅加法番表口径生效。',
  },
  allPungs: {
    label: '碰碰胡', kind: 'additive', wired: true,
    desc: '碰碰胡（4 副刻子/杠 + 将）时加一份。',
    example: '1-1-1万 5-5-5筒 8-8-8条 2-2-2-2万(杠) 9-9条',
    playerCaveat: '仅加法番表口径生效。',
  },
  goldenWait: {
    label: '金钩钓', kind: 'additive', wired: true,
    desc: '金钩钓（对对胡且单吊）时加一份。',
    example: '四副刻子/杠已成型，单吊将牌胡出',
    playerCaveat: '仅加法番表口径生效。',
  },
  fullFlush: {
    label: '清一色', kind: 'additive', wired: true,
    desc: '清一色时加一份。',
    example: '1-2-3万 4-5-6万 7-8-9万 2-3-4万 5-5万',
    playerCaveat: '仅加法番表口径生效。',
  },
  sevenPairs: {
    label: '七对', kind: 'additive', wired: true,
    desc: '七对时加一份。',
    example: '1-1万 2-2万 3-3万 5-5筒 7-7筒 9-9条 4-4条',
    playerCaveat: '仅加法番表口径生效。',
  },
  winAfterKong: {
    label: '杠上花', kind: 'additive', wired: true,
    desc: '杠上花（杠后补牌自摸）时加一份。',
    example: '杠后补牌自摸',
    playerCaveat: '仅加法番表口径生效。',
  },
  shootAfterKong: {
    label: '杠上炮', kind: 'additive', wired: true,
    desc: '杠上炮（杠后打出的牌被胡）时加一份。',
    example: '杠后打出的牌被点炮胡',
    playerCaveat: '仅加法番表口径生效。',
  },
  robbingKong: {
    label: '抢杠胡', kind: 'additive', wired: true,
    desc: '抢杠胡时加一份。',
    example: '抢补杠胡',
    playerCaveat: '仅加法番表口径生效。',
  },
  underTheSea: {
    label: '海底', kind: 'additive', wired: true,
    desc: '海底（牌墙摸空后的最后一张牌成胡）时加一份。',
    example: '牌墙余 0 时胡最后一张',
    playerCaveat: '仅加法番表口径生效；与可选番“海底”同一判定，按当前计分方式只读其中一张表。',
  },

  // 可选番
  duanYaoJiu: {
    label: '断幺九', kind: 'optionalAddon', wired: true,
    desc: '胡牌时全部牌（含副露）没有 1/9，加一份。',
    example: '2-3-4万 5-6-7万 3-4-5筒 6-7-8筒 5-5筒',
    playerCaveat: '仅命名番表口径生效；含任意 1/9 即不成立。',
  },
  haiDi: {
    label: '海底', kind: 'optionalAddon', wired: true,
    desc: '海底：牌墙摸空后的最后一张牌成胡（自摸或点炮）时加一份。',
    example: '牌墙余 0 时胡最后一张',
    playerCaveat: '仅命名番表口径生效；与加法表 underTheSea 同一判定，按当前计分方式只读其中一张表。',
  },
  perGang: {
    label: '每杠', kind: 'optionalAddon', wired: true,
    desc: '每个副露杠加一份（明杠/补杠/暗杠都算）。',
    example: '2 个杠 ⇒ 计 2 份',
    playerCaveat: '仅命名番表口径生效；杠分（刮风下雨）另算，与本番叠加。',
  },
  shuangLong: {
    label: '双龙七对', kind: 'optionalMain', wired: true,
    desc: '主番候选：七对且含至少 2 组未杠四张。',
    example: '1-1万 2-2万 3-3-3-3筒 5-5-5-5条 7-7万',
    playerCaveat: '与其他主番取最高，不是另加番；定义四张不计根。',
  },
  sanLong: {
    label: '三龙七对', kind: 'optionalMain', wired: true,
    desc: '主番候选：七对且含至少 3 组未杠四张。',
    example: '1-1万 2-2-2-2万 3-3-3-3筒 5-5-5-5条',
    playerCaveat: '与其他主番取最高，不是另加番；定义四张不计根。',
  },
  shiBaLuoHan: {
    label: '十八罗汉', kind: 'optionalMain', wired: true,
    desc: '主番候选：对对胡且至少 4 个副露杠。',
    example: '4 个杠 + 将牌',
    playerCaveat: '按副露杠数判定；手牌未杠四张不算。',
  },
  tianHu: {
    label: '天胡', kind: 'optionalMain', wired: false,
    desc: '主番候选：天胡（庄家开局即胡）。',
    example: '庄家发牌后未出牌即成胡',
    playerCaveat: '当前版本预留未启用。',
    adminOnly: '计分侧已有分支（scoring.ts），但 huContext() 从未置位；配置开启也不会触发。',
  },
  diHu: {
    label: '地胡', kind: 'optionalMain', wired: false,
    desc: '主番候选：地胡（闲家首巡即胡）。',
    example: '闲家首巡成胡',
    playerCaveat: '当前版本预留未启用。',
    adminOnly: '计分侧已有分支（scoring.ts），但 huContext() 从未置位；地胡定义（首摸/首打被胡）尚未裁决。',
  },
};

export const MAHJONG_FAN_INFO: Readonly<Record<string, MahjongFanInfo>> =
  Object.freeze(FAN_INFO);
```

- [ ] **Step 4: 导出并跑绿**

Modify `packages/protocol/src/mahjong/index.ts`:

```ts
export * from './tile';
export * from './actions';
export * from './rules';
export * from './types';
export * from './rule-summary';
export * from './fan-info';
export * from './client-view';
```

⚠️ `client-view` 在 Task 3 创建；本任务先只加 `export * from './fan-info';`，Task 3 再加 client-view 行。

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/fan-info.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 类型检查**

Run: `pnpm -C packages/protocol lint`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add packages/protocol/src/mahjong/fan-info.ts packages/protocol/src/mahjong/fan-info.test.ts packages/protocol/src/mahjong/index.ts
git commit -m "feat(protocol): 麻将番型元数据单一真源（34 项）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: shared 番名标签从元数据派生 + 加法口径中文标签

**Files:**
- Modify: `packages/shared/src/mahjong/scoring.ts:53-79`
- Modify: `packages/shared/test/admin-mahjong-labels.gate.test.ts`
- Modify: `packages/shared/src/mahjong/hu.test.ts`

**Interfaces:**
- Consumes: `MAHJONG_FAN_INFO`（Task 1）
- Produces: `NAMED_LABELS` 覆盖 34 键；结算 `items` 不再出现英文键。

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/admin-mahjong-labels.gate.test.ts` 增加：

```ts
import { MAHJONG_FAN_INFO } from '@fight-the-landlord/protocol';

it('NAMED_LABELS 覆盖全部 34 个番键，且与 protocol label 逐字一致', () => {
  expect(Object.keys(NAMED_LABELS).sort()).toEqual(Object.keys(MAHJONG_FAN_INFO).sort());
  for (const [key, info] of Object.entries(MAHJONG_FAN_INFO)) {
    expect(NAMED_LABELS[key], key).toBe(info.label);
  }
});
```

在 `packages/shared/src/mahjong/hu.test.ts` 的 `sbr additive scoring` 内增加：

```ts
it('加法口径结算 items 使用中文标签（不出现英文键）', () => {
  const hand = [...tiles(0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), t(1, 5), t(1, 5)];
  const r = score(hand, 2, DEFAULT_SBR_RULES);
  expect(r.items.join('|')).toContain('碰碰胡');
  expect(r.items.join('|')).not.toMatch(/allPungs|fullFlush|sevenPairs|root/);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/shared exec vitest run test/admin-mahjong-labels.gate.test.ts src/mahjong/hu.test.ts`
Expected: FAIL（`NAMED_LABELS` 缺加法键；items 含 `allPungs`）。

- [ ] **Step 3: 实现派生标签**

Modify `packages/shared/src/mahjong/scoring.ts`：删除手写 `NAMED_LABELS` 对象，改为：

```ts
import { MAHJONG_FAN_INFO, /* 现有 imports */ } from '@fight-the-landlord/protocol';

export const NAMED_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MAHJONG_FAN_INFO).map(([key, info]) => [key, info.label]),
  ),
);
```

保留 `label()` 函数不变。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/shared exec vitest run test/admin-mahjong-labels.gate.test.ts src/mahjong/hu.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/mahjong/scoring.ts packages/shared/src/mahjong/hu.test.ts packages/shared/test/admin-mahjong-labels.gate.test.ts
git commit -m "refactor(shared): 番名标签从 protocol 元数据派生，补齐加法口径中文标签

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: protocol 客户端规则视图 + `ClientGameConfig.mahjongRules`

**Files:**
- Create: `packages/protocol/src/mahjong/client-view.ts`
- Create: `packages/protocol/src/mahjong/client-view.test.ts`
- Modify: `packages/protocol/src/config.ts`（`ClientGameConfig` 约 292）
- Modify: `packages/protocol/src/mahjong/index.ts`

**Interfaces:**
- Consumes: `MahjongRulesConfig` 及枚举类型（既有）
- Produces: `MahjongRulesClientView`、`MAHJONG_RULES_CLIENT_KEYS`、`mahjongRulesClientView(rules)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/protocol/src/mahjong/client-view.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { MAHJONG_RULES_CLIENT_KEYS, mahjongRulesClientView } from './client-view';

describe('MahjongRulesClientView', () => {
  it('键集恰为显式白名单（不含内部调参）', () => {
    const view = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);
    expect(Object.keys(view).sort()).toEqual([...MAHJONG_RULES_CLIENT_KEYS].sort());
    for (const forbidden of [
      'preset', 'rulesVersion', 'claimWindowMs', 'exchangeWindowMs',
      'lackWindowMs', 'refundOnDraw', 'huazhuPayees', 'chajiaoAllSameState',
    ]) {
      expect(view).not.toHaveProperty(forbidden);
    }
  });

  it('成都默认值逐字段映射', () => {
    const view = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);
    expect(view).toMatchObject({
      scoringPolicy: 'named', fanBase: 1, fanCap: 6,
      selfDrawMode: 'addBase', rootIncludesKong: false, minFanToHu: 0,
      exchangeThreeEnabled: true, exchangeDirection: 'random',
      lastFourForcedHu: true, passHuMode: 'sameTileOrHigherFan',
      directGangMode: 'contract', gangTransfer: 'toEachWinner',
      huazhuMode: 'payEach', chajiaoEnabled: true,
    });
    expect(view.fanTable.pingHu).toBe(1);
    expect(view.optionalFans.perGang).toBe(0);
  });

  it('SBR 默认值逐字段映射', () => {
    const view = mahjongRulesClientView(DEFAULT_SBR_RULES);
    expect(view.scoringPolicy).toBe('additive');
    expect(view.fanBase).toBe(0);
    expect(view.fanCap).toBe(3);
    expect(view.additiveFanTable.fullFlush).toBe(2);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/client-view.test.ts`
Expected: FAIL（找不到 `./client-view`）。

- [ ] **Step 3: 实现 `client-view.ts`**

```ts
// packages/protocol/src/mahjong/client-view.ts
import type {
  MahjongDirectGangMode,
  MahjongExchangeDirection,
  MahjongGangTransfer,
  MahjongHuazhuMode,
  MahjongOptionalFans,
  MahjongPassHuMode,
  MahjongRulesConfig,
  MahjongScoringPolicy,
  MahjongSelfDrawMode,
} from './rules';

export interface MahjongRulesClientView {
  scoringPolicy: MahjongScoringPolicy;
  fanBase: 0 | 1;
  fanCap: number;
  fanTable: Record<string, number>;
  additiveFanTable: Record<string, number>;
  optionalFans: MahjongOptionalFans;
  rootIncludesKong: boolean;
  selfDrawMode: MahjongSelfDrawMode;
  minFanToHu: number;
  exchangeThreeEnabled: boolean;
  exchangeDirection: MahjongExchangeDirection;
  lastFourForcedHu: boolean;
  passHuMode: MahjongPassHuMode;
  directGangMode: MahjongDirectGangMode;
  gangTransfer: MahjongGangTransfer;
  huazhuMode: MahjongHuazhuMode;
  chajiaoEnabled: boolean;
}

export const MAHJONG_RULES_CLIENT_KEYS = [
  'scoringPolicy', 'fanBase', 'fanCap', 'fanTable', 'additiveFanTable',
  'optionalFans', 'rootIncludesKong', 'selfDrawMode', 'minFanToHu',
  'exchangeThreeEnabled', 'exchangeDirection', 'lastFourForcedHu',
  'passHuMode', 'directGangMode', 'gangTransfer', 'huazhuMode',
  'chajiaoEnabled',
] as const;

export function mahjongRulesClientView(rules: MahjongRulesConfig): MahjongRulesClientView {
  return {
    scoringPolicy: rules.scoringPolicy,
    fanBase: rules.fanBase,
    fanCap: rules.fanCap,
    fanTable: { ...rules.fanTable },
    additiveFanTable: { ...rules.additiveFanTable },
    optionalFans: { ...rules.optionalFans },
    rootIncludesKong: rules.rootIncludesKong,
    selfDrawMode: rules.selfDrawMode,
    minFanToHu: rules.minFanToHu,
    exchangeThreeEnabled: rules.exchangeThreeEnabled,
    exchangeDirection: rules.exchangeDirection,
    lastFourForcedHu: rules.lastFourForcedHu,
    passHuMode: rules.passHuMode,
    directGangMode: rules.directGangMode,
    gangTransfer: rules.gangTransfer,
    huazhuMode: rules.huazhuMode,
    chajiaoEnabled: rules.chajiaoEnabled,
  };
}
```

- [ ] **Step 4: 加到 `ClientGameConfig`**

`packages/protocol/src/config.ts` 顶部增加：

```ts
import type { MahjongRulesClientView } from './mahjong/client-view';
```

`ClientGameConfig` 接口末尾增加：

```ts
  /** 麻将规则客户端视图；旧服务端/坏值 ⇒ 缺省，客户端回退静态介绍。 */
  mahjongRules?: MahjongRulesClientView;
```

- [ ] **Step 5: 导出并跑绿**

`packages/protocol/src/mahjong/index.ts` 增加：

```ts
export * from './client-view';
```

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/client-view.test.ts`
Expected: PASS（3 tests）。
Run: `pnpm -C packages/protocol lint`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add packages/protocol/src/mahjong/client-view.ts packages/protocol/src/mahjong/client-view.test.ts packages/protocol/src/mahjong/index.ts packages/protocol/src/config.ts
git commit -m "feat(protocol): 麻将规则客户端白名单视图 + ClientGameConfig.mahjongRules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 静态文案拆分为配置中立段落 + 默认 fallback

**Files:**
- Modify: `packages/protocol/src/mahjong/rule-summary.ts`
- Create: `packages/protocol/src/mahjong/rule-summary.test.ts`

**Interfaces:**
- Provides: `MAHJONG_BASE_SUMMARY`、`MAHJONG_DEFAULT_SCORING`、`MAHJONG_TIMEOUT_SECTION`、`MAHJONG_RULE_SUMMARY`
- Later tasks add `buildMahjongRuleSummary` to the same file.

- [ ] **Step 1: 写失败测试**

```ts
// packages/protocol/src/mahjong/rule-summary.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAHJONG_BASE_SUMMARY,
  MAHJONG_DEFAULT_SCORING,
  MAHJONG_RULE_SUMMARY,
  MAHJONG_TIMEOUT_SECTION,
} from './rule-summary';

function sections(text: string): Array<{ title: string; lines: string[] }> {
  return text.split(/\n\n+/).map((raw) => {
    const lines = raw.split('\n');
    const title = lines[0]?.match(/^【(.+?)】$/)?.[1] ?? '';
    return { title, lines: lines.slice(1) };
  });
}

describe('MAHJONG_RULE_SUMMARY fallback', () => {
  it('恰含 5 段且每段非空', () => {
    const s = sections(MAHJONG_RULE_SUMMARY);
    expect(s.map((x) => x.title)).toEqual([
      '基本规则', '血战到底', '刮风下雨', '计分', '超时与托管',
    ]);
    for (const section of s) expect(section.lines.length, section.title).toBeGreaterThan(0);
  });

  it('base 段不含可被后台关闭的完整性断言', () => {
    expect(MAHJONG_BASE_SUMMARY).not.toContain('最后 4 张能胡必胡');
    expect(MAHJONG_BASE_SUMMARY).not.toContain('过水同张锁定');
    expect(MAHJONG_BASE_SUMMARY).not.toContain('直杠：点杠者付');
    expect(MAHJONG_BASE_SUMMARY).not.toContain('强胡时=胡');
  });

  it('默认计分段标注默认口径并提供默认流程', () => {
    expect(MAHJONG_DEFAULT_SCORING).toContain('默认口径');
    expect(MAHJONG_DEFAULT_SCORING).toContain('默认封顶 6 番');
    expect(MAHJONG_DEFAULT_SCORING).toContain('最后 4 张能胡必胡');
    expect(MAHJONG_DEFAULT_SCORING).toContain('直杠仅点杠者付 2×底');
  });

  it('超时段保留托管说明', () => {
    expect(MAHJONG_TIMEOUT_SECTION).toContain('超时与托管');
    expect(MAHJONG_TIMEOUT_SECTION).toContain('托管');
    expect(MAHJONG_TIMEOUT_SECTION).not.toContain('强胡时=胡');
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/rule-summary.test.ts`
Expected: FAIL（导出不存在）。

- [ ] **Step 3: 重写 `rule-summary.ts`（仅静态部分）**

```ts
/**
 * 客户端玩法介绍：配置中立段落 + 默认 fallback。
 * `buildMahjongRuleSummary`（Task 5）在有配置时用动态段替换默认计分段。
 */

export const MAHJONG_BASE_SUMMARY =
  '【基本规则】\n' +
  '· 4 人，108 张（万/筒/条 1–9 各 4 张），不能吃，只能碰/杠\n' +
  '· 每家 13 张；换三张（可配）→ 定缺 → 庄家摸第 14 张\n' +
  '· 定缺后必须先打完缺门牌；手里有缺门牌不能胡\n\n' +
  '【血战到底】\n' +
  '· 一家胡牌后不离场，剩余玩家继续，直到 3 家胡或牌墙摸空\n' +
  '· 已胡者不再参与后续任何支付/收取；已胡手牌公开\n' +
  '· 点炮者付；自摸其余未胡每家付；一炮多响每个赢家分别收\n' +
  '· 胡 > 杠 > 碰 > 摸牌；最后 4 张与过水规则按房间设置\n\n' +
  '【刮风下雨】\n' +
  '· 直杠/补杠/暗杠的杠分按房间设置结算\n' +
  '· 杠上炮：本次杠分按房间设置处理；抢杠只抢补杠\n' +
  '· 荒庄：花猪 / 查大叫 / 退税按规则配置结算';

export const MAHJONG_DEFAULT_SCORING =
  '【计分】\n' +
  '· 默认口径，实际以房间设置为准\n' +
  '· 默认成都口径：平胡 1 番（×1），每 +1 番翻倍，默认封顶 6 番（32×）\n' +
  '· 主番：平胡/对对胡/清一色/带幺九/七对/清对/将对/龙七对/清七对/清幺九/清龙七对\n' +
  '· 另加：杠上花/杠上炮/抢杠胡/金钩钓/根/自摸；具体番值全部可配置\n' +
  '· 默认流程：最后 4 张能胡必胡；过水同张或加番可胡；换三张开启；直杠仅点杠者付 2×底；补杠其余未胡每家 1×底；暗杠其余未胡每家 2×底';

export const MAHJONG_TIMEOUT_SECTION =
  '【超时与托管】\n' +
  '· 换三张/定缺超时自动选；响应窗口超时=过；最后 4 张的处理按房间设置\n' +
  '· 超时、托管、机器人共用同一套自动决策';

export const MAHJONG_RULE_SUMMARY = [
  MAHJONG_BASE_SUMMARY,
  MAHJONG_DEFAULT_SCORING,
  MAHJONG_TIMEOUT_SECTION,
].join('\n\n');
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/rule-summary.test.ts`
Expected: PASS（4 tests）。
Run: `pnpm -C packages/protocol lint`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/mahjong/rule-summary.ts packages/protocol/src/mahjong/rule-summary.test.ts
git commit -m "refactor(protocol): 玩法介绍拆分配置中立段与默认 fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `buildMahjongRuleSummary` 动态文案生成器

**Files:**
- Modify: `packages/protocol/src/mahjong/rule-summary.ts`
- Modify: `packages/protocol/src/mahjong/rule-summary.test.ts`

**Interfaces:**
- Consumes: `MahjongRulesClientView`（Task 3）、`MAHJONG_FAN_INFO`（Task 1）、三张番键数组
- Produces: `buildMahjongRuleSummary(rules?: MahjongRulesClientView): string`

- [ ] **Step 1: 追加失败测试**

在 `rule-summary.test.ts` 追加：

```ts
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { mahjongRulesClientView } from './client-view';
import { buildMahjongRuleSummary } from './rule-summary';

const chengdu = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);

describe('buildMahjongRuleSummary', () => {
  it('无参数 ⇒ 与 MAHJONG_RULE_SUMMARY 逐字相等', () => {
    expect(buildMahjongRuleSummary(undefined)).toBe(MAHJONG_RULE_SUMMARY);
  });

  it('默认成都：动态段替换默认计分，含封顶/主番/流程/未启用', () => {
    const text = buildMahjongRuleSummary(chengdu);
    expect(text).toContain('【番型与倍率】');
    expect(text).toContain('【当前流程设置】');
    expect(text).not.toContain('默认封顶 6 番');
    expect(text).toContain('封顶 6 番（×32）');
    expect(text).toContain('清七对 5 番（×16）');
    expect(text).toContain('未启用：');
    expect(text).toContain('最后 4 张：能胡必胡');
    const s = sections(text);
    expect(s.map((x) => x.title)).toEqual([
      '基本规则', '血战到底', '刮风下雨', '番型与倍率',
      '当前流程设置', '超时与托管',
    ]);
    for (const section of s) expect(section.lines.length, section.title).toBeGreaterThan(0);
  });

  it('自定义封顶 5 / 每杠 1 / 关龙七对 生效', () => {
    const view = {
      ...chengdu,
      fanCap: 5,
      fanTable: { ...chengdu.fanTable, longQiDui: 0 },
      optionalFans: { ...chengdu.optionalFans, perGang: 1 },
    };
    const text = buildMahjongRuleSummary(view);
    expect(text).toContain('封顶 5 番（×16）');
    expect(text).toContain('每杠 +1 番');
    expect(text).toContain('龙七对');
    expect(text).toMatch(/未启用：[^\n]*龙七对/);
  });

  it('加法口径只列加法表，并注明不使用可选番', () => {
    const text = buildMahjongRuleSummary(mahjongRulesClientView(DEFAULT_SBR_RULES));
    expect(text).toContain('计分方式：加法番表');
    expect(text).toContain('碰碰胡 +1 番');
    expect(text).toContain('加法口径不使用可选番');
    expect(text).not.toContain('清七对 5 番');
  });

  it('全 0 ⇒ 明确提示未配置任何番型', () => {
    const zero = { ...chengdu, fanTable: {}, optionalFans: { ...chengdu.optionalFans } };
    const text = buildMahjongRuleSummary(zero);
    expect(text).toContain('当前未配置任何番型');
    expect(text).not.toContain('清七对 5 番');
  });

  it('天胡/地胡值 > 0 但 wired=false ⇒ 只进预留列表', () => {
    const view = {
      ...chengdu,
      optionalFans: { ...chengdu.optionalFans, tianHu: 6, diHu: 6 },
    };
    const text = buildMahjongRuleSummary(view);
    expect(text).toContain('预留未启用：天胡、地胡');
    expect(text).not.toMatch(/· 天胡 \d+ 番/);
  });

  it('pingHu=0 ⇒ 明示引擎兜底 1 番', () => {
    const view = { ...chengdu, fanTable: { ...chengdu.fanTable, pingHu: 0 } };
    expect(buildMahjongRuleSummary(view)).toContain('平胡：表值为 0，但引擎仍按兜底 1 番处理');
  });

  it('起胡番 > 封顶 ⇒ 明示当前配置无法胡牌', () => {
    const view = { ...chengdu, minFanToHu: 6, fanCap: 5 };
    expect(buildMahjongRuleSummary(view)).toContain('当前配置无法胡牌');
  });

  it('主番表值 > 封顶 ⇒ 显示表值与封顶后倍率', () => {
    const view = {
      ...chengdu,
      fanCap: 5,
      fanTable: { ...chengdu.fanTable, qingYiSe: 8 },
    };
    expect(buildMahjongRuleSummary(view)).toContain('清一色 表值 8 番 / 封顶后 ×16');
  });

  it('自摸口径：addFan 读 ziMo；addBase 每家多付', () => {
    const addFan = {
      ...chengdu,
      selfDrawMode: 'addFan' as const,
      fanTable: { ...chengdu.fanTable, ziMo: 2 },
    };
    expect(buildMahjongRuleSummary(addFan)).toContain('自摸：番 +2');
    expect(buildMahjongRuleSummary(chengdu)).toContain('自摸：每家多付 1×底');
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/rule-summary.test.ts`
Expected: FAIL（`buildMahjongRuleSummary` 未导出）。

- [ ] **Step 3: 实现生成器**

在 `rule-summary.ts` 追加：

```ts
import {
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
} from './rules';
import { MAHJONG_FAN_INFO, type MahjongFanInfo } from './fan-info';
import type { MahjongRulesClientView } from './client-view';

function labelOf(key: string): string {
  return MAHJONG_FAN_INFO[key]?.label ?? key;
}

function multiplierOf(fan: number, rules: MahjongRulesClientView): number {
  return 2 ** Math.max(0, Math.min(fan, rules.fanCap) - rules.fanBase);
}

function noteText(info: MahjongFanInfo): string {
  const parts = [info.desc];
  if (info.example) parts.push(`例：${info.example}`);
  if (info.playerCaveat) parts.push(`⚠ ${info.playerCaveat}`);
  return parts.join(' ');
}

function mainLine(key: string, info: MahjongFanInfo, value: number, rules: MahjongRulesClientView): string {
  const mult = multiplierOf(value, rules);
  const head = value > rules.fanCap
    ? `${labelOf(key)} 表值 ${value} 番 / 封顶后 ×${mult}`
    : `${labelOf(key)} ${value} 番（×${mult}）`;
  return `· ${head}：${noteText(info)}`;
}

function addonLine(key: string, info: MahjongFanInfo, value: number): string {
  return `· ${labelOf(key)} +${value} 番：${noteText(info)}`;
}

function selfDrawText(rules: MahjongRulesClientView): string {
  switch (rules.selfDrawMode) {
    case 'addFan': {
      const v = rules.fanTable.ziMo ?? 0;
      return v > 0 ? `番 +${v}` : '番 +0（命名番表“自摸”项未配置）';
    }
    case 'none':
      return '无加成';
    default:
      return '每家多付 1×底';
  }
}

function directionText(dir: MahjongRulesClientView['exchangeDirection']): string {
  switch (dir) {
    case 'clockwise': return '顺时针';
    case 'counterclockwise': return '逆时针';
    case 'opposite': return '对家';
    default: return '随机';
  }
}

function passHuText(mode: MahjongRulesClientView['passHuMode']): string {
  switch (mode) {
    case 'sameTile': return '同张不可再胡';
    case 'sameTileOrHigherFan': return '同张或加番可胡';
    default: return '不限制';
  }
}

function transferText(mode: MahjongRulesClientView['gangTransfer']): string {
  switch (mode) {
    case 'toEachWinner': return '转给每个赢家';
    case 'split': return '均分（余数按座位升序）';
    default: return '退回原付款人';
  }
}

function huazhuText(mode: MahjongRulesClientView['huazhuMode']): string {
  switch (mode) {
    case 'burn48': return '销毁 48×底';
    case 'off': return '不罚';
    default: return '按当前配置赔给未胡玩家（封顶分）';
  }
}

function buildScoringSection(rules: MahjongRulesClientView): string {
  const lines: string[] = [];
  lines.push(
    `计分方式：${rules.scoringPolicy === 'named' ? '命名番表' : '加法番表'}；` +
    `底番 ${rules.fanBase}；封顶 ${rules.fanCap} 番（×${multiplierOf(rules.fanCap, rules)}）；` +
    `自摸：${selfDrawText(rules)}`,
  );
  if (rules.minFanToHu > rules.fanCap) {
    lines.push('⚠ 起胡番高于封顶番：当前配置无法胡牌。');
  }

  if (rules.scoringPolicy === 'named') {
    const reserved: string[] = [];
    let enabledCount = 0;
    const consider = (key: string, info: MahjongFanInfo, value: number): void => {
      if (value <= 0) return;
      if (!info.wired) {
        reserved.push(labelOf(key));
        return;
      }
      enabledCount += 1;
      lines.push(
        info.kind === 'namedAddon' || info.kind === 'optionalAddon'
          ? addonLine(key, info, value)
          : mainLine(key, info, value, rules),
      );
    };

    for (const key of MAHJONG_NAMED_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      if (info.kind === 'namedMain') consider(key, info, rules.fanTable[key] ?? 0);
    }
    for (const key of MAHJONG_NAMED_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      if (info.kind === 'namedAddon' && key !== 'ziMo') {
        consider(key, info, rules.fanTable[key] ?? 0);
      }
    }
    for (const key of MAHJONG_OPTIONAL_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      if (info.kind === 'optionalMain' || info.kind === 'optionalAddon') {
        consider(key, info, rules.optionalFans[key] ?? 0);
      }
    }

    if ((rules.fanTable.pingHu ?? 0) === 0) {
      lines.push('· 平胡：表值为 0，但引擎仍按兜底 1 番处理。');
    }

    const disabled: string[] = [];
    for (const key of MAHJONG_NAMED_FAN_KEYS) {
      if (key === 'ziMo') continue;
      if ((rules.fanTable[key] ?? 0) === 0) disabled.push(labelOf(key));
    }
    for (const key of MAHJONG_OPTIONAL_FAN_KEYS) {
      if ((rules.optionalFans[key] ?? 0) === 0) disabled.push(labelOf(key));
    }
    if (disabled.length > 0) lines.push(`· 未启用：${disabled.join('、')}`);
    if (enabledCount === 0) lines.push('· 当前未配置任何番型，只按底分结算。');
    if (reserved.length > 0) {
      lines.push(`· 预留未启用：${reserved.join('、')}（当前版本不会触发）`);
    }
  } else {
    let enabledCount = 0;
    for (const key of MAHJONG_ADDITIVE_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      const value = rules.additiveFanTable[key] ?? 0;
      if (value > 0) {
        enabledCount += 1;
        lines.push(addonLine(key, info, value));
      }
    }
    if (enabledCount === 0) {
      lines.push('· 当前未配置任何加法番型，只按底分结算。');
    }
    lines.push(
      `· 各项相加后按封顶 ${rules.fanCap} 番（×${multiplierOf(rules.fanCap, rules)}）结算。`,
    );
    lines.push('· 加法口径不使用可选番。');
  }

  return ['【番型与倍率】', ...lines].join('\n');
}

function buildFlowSection(rules: MahjongRulesClientView): string {
  const lines = [
    `· 换三张：${rules.exchangeThreeEnabled ? `开（方向：${directionText(rules.exchangeDirection)}）` : '关'}`,
    '· 定缺：必选',
    `· 最后 4 张：${rules.lastFourForcedHu ? '能胡必胡' : '可过'}`,
    `· 过水：${passHuText(rules.passHuMode)}`,
    `· 直杠：${rules.directGangMode === 'contract' ? '仅点杠者付 2×底' : '家家有（点杠者 2×底 + 其余未胡每家 1×底）'}`,
    `· 杠分转移：${transferText(rules.gangTransfer)}`,
    `· 花猪：${huazhuText(rules.huazhuMode)}`,
    `· 查叫：${rules.chajiaoEnabled ? '开' : '关'}`,
    `· 自摸：${selfDrawText(rules)}`,
  ];
  return ['【当前流程设置】', ...lines].join('\n');
}

export function buildMahjongRuleSummary(rules?: MahjongRulesClientView): string {
  if (!rules) return MAHJONG_RULE_SUMMARY;
  return [
    MAHJONG_BASE_SUMMARY,
    buildScoringSection(rules),
    buildFlowSection(rules),
    MAHJONG_TIMEOUT_SECTION,
  ].join('\n\n');
}
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/rule-summary.test.ts`
Expected: PASS（10 tests）。
Run: `pnpm -C packages/protocol lint`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/mahjong/rule-summary.ts packages/protocol/src/mahjong/rule-summary.test.ts
git commit -m "feat(protocol): 麻将动态玩法介绍生成器（按配置列番型/倍率/流程）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: config-service 下发 `games.mahjong.mahjongRules`

**Files:**
- Modify: `packages/config-service/src/config/client-config.controller.ts`
- Modify: `packages/config-service/test/client-config.test.ts`

**Interfaces:**
- Consumes: `parseMahjongRules`、`mahjongRulesClientView`、`MahjongRulesClientView`
- Produces: `GET /api/config` 的 `data.games.mahjong.mahjongRules`（合法时）

- [ ] **Step 1: 写失败测试**

在 `client-config.test.ts` 的 `describe` 内追加：

```ts
it('game.mahjong.rules 合法 ⇒ 下发客户端白名单视图', async () => {
  const { svc, db } = makeService(seedDb());
  const probe = await startHttpProbe(svc);
  try {
    const { body } = await probe.get('/api/config');
    expect(body.data.games.mahjong.mahjongRules).toEqual(
      mahjongRulesClientView(DEFAULT_CHENGDU_RULES),
    );
    expect(body.data.games.mahjong.mahjongRules).not.toHaveProperty('claimWindowMs');
    expect(body.data.games.mahjong.mahjongRules).not.toHaveProperty('preset');
  } finally {
    await probe.close();
  }
}, 20000);

it('rules 缺失/null/{}/坏值 ⇒ 不下发 mahjongRules（不 500）', async () => {
  for (const value of [undefined, null, {}, { nope: 1 }, { fanCap: 99 }]) {
    const { svc, db } = makeService(seedDb());
    if (value === undefined) db.rows.delete('game.mahjong.rules');
    else db.rows.set('game.mahjong.rules', { value, version: 2, updatedAt: 'x', updatedBy: 'x' });
    const probe = await startHttpProbe(svc);
    try {
      const { body } = await probe.get('/api/config');
      expect(body.data.games.mahjong).not.toHaveProperty('mahjongRules');
    } finally {
      await probe.close();
    }
  }
}, 20000);
```

并在文件顶部 import：

```ts
import { DEFAULT_CHENGDU_RULES, mahjongRulesClientView } from '@fight-the-landlord/protocol';
```

同时更新 `games` 全等断言（约 109-123 行）在 `mahjong` 对象末尾加：

```ts
          mahjongRules: mahjongRulesClientView(DEFAULT_CHENGDU_RULES),
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/config-service exec vitest run test/client-config.test.ts`
Expected: FAIL（`mahjongRules` 未下发）。

- [ ] **Step 3: 实现控制器**

在 `client-config.controller.ts` 顶部：

```ts
import { Controller, Get, Logger } from '@nestjs/common';
import {
  ErrCode,
  GAME_META,
  mahjongRulesClientView,
  parseConfigValue,
  parseMahjongRules,
  type BaseScoreLevel,
  type ClientConfig,
  type ClientGameConfig,
  type MahjongRulesClientView,
} from '@fight-the-landlord/protocol';
```

类内加：

```ts
  private readonly logger = new Logger(ClientConfigController.name);

  private readMahjongRules(byKey: ConfigByKey): MahjongRulesClientView | undefined {
    const raw = byKey.get('game.mahjong.rules');
    if (raw === undefined) return undefined; // 旧服务端/缺行：正常，不告警
    if (raw === null || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)) {
      this.logger.warn('game.mahjong.rules missing/empty; client intro falls back to static');
      return undefined;
    }
    try {
      return mahjongRulesClientView(parseMahjongRules(raw));
    } catch {
      this.logger.warn('game.mahjong.rules invalid; client intro falls back to static');
      return undefined;
    }
  }
```

在 `get()` 的 `games.mahjong` 对象中条件加入：

```ts
      mahjong: {
        // ...现有字段
        ...(mahjongRulesView ? { mahjongRules: mahjongRulesView } : {}),
      },
```

其中在 `const games ...` 之前：

```ts
    const mahjongRulesView = this.readMahjongRules(byKey);
```

- [ ] **Step 4: 构建 protocol 后跑绿**

先构建，否则 config-service 解析到旧 dist：

Run: `pnpm -C packages/protocol build`
Run: `pnpm -C packages/config-service exec vitest run test/client-config.test.ts`
Expected: PASS。
Run: `pnpm -C packages/config-service lint`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add packages/config-service/src/config/client-config.controller.ts packages/config-service/test/client-config.test.ts
git commit -m "feat(config): /api/config 下发麻将规则客户端白名单视图

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 引擎行为审计（每个番正例 + 反例）

**Files:**
- Create: `packages/shared/src/mahjong/fan-behavior.test.ts`

**Interfaces:**
- Consumes: `scoreBestHand`、`huContext`、`EMPTY_HU_CONTEXT`、规则默认值、`MAHJONG_FAN_INFO`
- 本任务只加测试；若测试暴露引擎与文档不一致，按“引擎实际行为”对齐并在测试中注明，不修改引擎。

- [ ] **Step 1: 写测试文件**

```ts
// packages/shared/src/mahjong/fan-behavior.test.ts
import { describe, expect, it } from 'vitest';
import type {
  MahjongMeldView, MahjongRulesConfig, Tile,
} from '@fight-the-landlord/protocol';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { EMPTY_HU_CONTEXT, type HuContext } from './features';
import { scoreBestHand } from './scoring';
import {
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_FAN_INFO,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
} from '@fight-the-landlord/protocol';
import { huContext } from './claims';
import type { MahjongSession } from './session';

const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });
const T = (s: 0 | 1 | 2, ranks: number[]): Tile[] => ranks.map((r) => t(s, r));

interface Case {
  key: string;
  hand: Tile[];
  melds?: MahjongMeldView[];
  lack?: 0 | 1 | 2;
  winning?: Tile;
  context?: HuContext;
  rules?: MahjongRulesConfig;
  expectedBase?: string;
  expectedItem?: string;
}

const gang = (s: 0 | 1 | 2, r: number, fromSeat = 1): MahjongMeldView => ({
  kind: 'gang', tiles: [t(s, r), t(s, r), t(s, r), t(s, r)], fromSeat,
});

const plainHand = [...T(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]), t(1, 5), t(1, 5)];
const pungsHand = [...T(0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), t(1, 5), t(1, 5)];
const flushHand = [...T(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4]), t(0, 5), t(0, 5)];
const sevenPairsHand = [...T(0, [1, 1, 2, 2, 3, 3]), ...T(1, [4, 4, 5, 5, 6, 6, 7, 7])];
const dragonPairsHand = [...T(0, [1, 1, 1, 1, 2, 2, 3, 3]), ...T(1, [4, 4, 5, 5, 6, 6])];
const noTerminalsHand = [
  ...T(0, [2, 3, 4, 5, 6, 7]), ...T(1, [3, 4, 5, 6, 7, 8]), t(1, 5), t(1, 5),
];

const withOptional = (
  base: MahjongRulesConfig,
  patch: Partial<MahjongRulesConfig['optionalFans']>,
  fanCap = base.fanCap,
): MahjongRulesConfig => ({
  ...base,
  fanCap,
  optionalFans: { ...base.optionalFans, ...patch },
});

const CASES: Case[] = [
  { key: 'pingHu', hand: plainHand, expectedBase: 'pingHu' },
  { key: 'duiDuiHu', hand: pungsHand, winning: t(0, 4), expectedBase: 'duiDuiHu' },
  { key: 'qingYiSe', hand: flushHand, lack: 1, expectedBase: 'qingYiSe' },
  {
    key: 'daiYaoJiu', lack: 2, expectedBase: 'daiYaoJiu',
    hand: [...T(0, [1, 2, 3, 7, 8, 9]), ...T(1, [1, 1, 1, 9, 9, 9]), t(0, 9), t(0, 9)],
  },
  { key: 'qiDui', hand: sevenPairsHand, expectedBase: 'qiDui' },
  {
    key: 'qingDui', lack: 2, expectedBase: 'qingDui',
    hand: [...T(0, [1, 1, 1, 3, 3, 3, 5, 5, 5, 7, 7, 7]), t(0, 9), t(0, 9)],
  },
  {
    key: 'jiangDui', lack: 2, expectedBase: 'jiangDui',
    hand: [...T(0, [2, 2, 2, 5, 5, 5, 8, 8, 8]), ...T(1, [2, 2, 2]), t(1, 5), t(1, 5)],
  },
  { key: 'longQiDui', hand: dragonPairsHand, expectedBase: 'longQiDui' },
  {
    key: 'qingQiDui', lack: 2, expectedBase: 'qingQiDui',
    hand: [...T(0, [1, 1, 2, 2, 3, 3, 5, 5, 7, 7, 8, 8, 9, 9])],
  },
  {
    key: 'qingYaoJiu', lack: 2, expectedBase: 'qingYaoJiu',
    hand: [...T(0, [1, 2, 3, 1, 2, 3, 7, 8, 9, 7, 8, 9, 1, 1])],
  },
  {
    key: 'qingLongQiDui', lack: 2, expectedBase: 'qingLongQiDui',
    hand: [...T(0, [1, 1, 2, 2, 3, 3, 5, 5, 5, 5, 7, 7, 9, 9])],
  },
  {
    key: 'gangShangHua', hand: plainHand, expectedItem: '杠上花',
    context: { ...EMPTY_HU_CONTEXT, selfDraw: true, winAfterKong: true },
  },
  {
    key: 'gangShangPao', hand: plainHand, expectedItem: '杠上炮',
    context: { ...EMPTY_HU_CONTEXT, shootAfterKong: true },
  },
  {
    key: 'qiangGangHu', hand: plainHand, expectedItem: '抢杠胡',
    context: { ...EMPTY_HU_CONTEXT, robbingKong: true },
  },
  {
    key: 'jinGouDiao', lack: 2, expectedItem: '金钩钓',
    hand: [...T(0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), t(1, 5), t(1, 5)],
    winning: t(1, 5),
  },
  {
    key: 'gen', lack: 2, expectedItem: '根',
    hand: [...T(0, [1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9]), t(1, 5), t(1, 5)],
  },
  {
    key: 'ziMo', hand: plainHand, expectedItem: '自摸',
    rules: {
      ...DEFAULT_CHENGDU_RULES,
      selfDrawMode: 'addFan',
      fanTable: { ...DEFAULT_CHENGDU_RULES.fanTable, ziMo: 1 },
    },
    context: { ...EMPTY_HU_CONTEXT, selfDraw: true },
  },

  // 加法口径
  { key: 'root', hand: [...T(0, [1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9]), t(1, 5), t(1, 5)], lack: 2, rules: DEFAULT_SBR_RULES, expectedItem: '根（每组）' },
  { key: 'allPungs', hand: pungsHand, winning: t(0, 4), rules: DEFAULT_SBR_RULES, expectedItem: '碰碰胡' },
  { key: 'goldenWait', hand: pungsHand, winning: t(1, 5), rules: DEFAULT_SBR_RULES, expectedItem: '金钩钓' },
  { key: 'fullFlush', hand: flushHand, lack: 1, rules: DEFAULT_SBR_RULES, expectedItem: '清一色' },
  { key: 'sevenPairs', hand: sevenPairsHand, rules: DEFAULT_SBR_RULES, expectedItem: '七对' },
  { key: 'winAfterKong', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, selfDraw: true, winAfterKong: true }, expectedItem: '杠上花' },
  { key: 'shootAfterKong', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, shootAfterKong: true }, expectedItem: '杠上炮' },
  { key: 'robbingKong', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, robbingKong: true }, expectedItem: '抢杠胡' },
  { key: 'underTheSea', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, underTheSea: true }, expectedItem: '海底' },

  // 可选番
  { key: 'duanYaoJiu', hand: noTerminalsHand, lack: 2, rules: withOptional(DEFAULT_CHENGDU_RULES, { duanYaoJiu: 1 }), expectedItem: '断幺九' },
  { key: 'haiDi', hand: plainHand, rules: withOptional(DEFAULT_CHENGDU_RULES, { haiDi: 1 }), context: { ...EMPTY_HU_CONTEXT, underTheSea: true }, expectedItem: '海底' },
  {
    key: 'perGang', melds: [gang(0, 1)], lack: 2,
    hand: [...T(0, [2, 3, 4, 5, 6, 7, 7, 8, 9]), t(1, 5), t(1, 5)],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { perGang: 1 }),
    expectedItem: '每杠',
  },
  {
    key: 'shuangLong', lack: 2, expectedBase: 'shuangLong',
    hand: [...T(0, [1, 1, 1, 1, 2, 2, 2, 2]), ...T(1, [3, 3, 4, 4, 5, 5])],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { shuangLong: 8 }, 8),
  },
  {
    key: 'sanLong', lack: 2, expectedBase: 'sanLong',
    hand: [...T(0, [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]), t(1, 4), t(1, 4)],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { sanLong: 8 }, 8),
  },
  {
    key: 'shiBaLuoHan', lack: 2, expectedBase: 'shiBaLuoHan',
    melds: [gang(0, 1), gang(0, 2), gang(0, 3), gang(0, 4)],
    hand: [t(1, 5), t(1, 5)],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { shiBaLuoHan: 8 }, 8),
  },
  {
    key: 'tianHu', hand: plainHand, expectedBase: 'tianHu',
    rules: withOptional(DEFAULT_CHENGDU_RULES, { tianHu: 6 }),
    context: { ...EMPTY_HU_CONTEXT, selfDraw: true, tianHu: true },
  },
  {
    key: 'diHu', hand: plainHand, expectedBase: 'diHu',
    rules: withOptional(DEFAULT_CHENGDU_RULES, { diHu: 6 }),
    context: { ...EMPTY_HU_CONTEXT, diHu: true },
  },
];

describe('番型行为审计', () => {
  for (const c of CASES) {
    it(`${c.key} 正例`, () => {
      const r = scoreBestHand({
        hand: c.hand,
        melds: c.melds ?? [],
        lackSuit: c.lack ?? 2,
        winningTile: c.winning ?? c.hand[c.hand.length - 1]!,
        context: c.context ?? EMPTY_HU_CONTEXT,
        rules: c.rules ?? DEFAULT_CHENGDU_RULES,
      });
      if (c.expectedBase) expect(r.baseName).toBe(c.expectedBase);
      if (c.expectedItem) expect(r.items.join('|')).toContain(c.expectedItem);
    });
  }

  it('反例：平胡手不触发任何其他番（平胡自身除外）', () => {
    const r = scoreBestHand({
      hand: plainHand, melds: [], lackSuit: 2,
      winningTile: plainHand[plainHand.length - 1]!,
      context: EMPTY_HU_CONTEXT, rules: DEFAULT_CHENGDU_RULES,
    });
    for (const [key, info] of Object.entries(MAHJONG_FAN_INFO)) {
      if (key === 'pingHu') continue;
      expect(r.items.join('|'), key).not.toContain(info.label);
    }
  });

  it('CASES 覆盖全部番键', () => {
    const covered = new Set(CASES.map((c) => c.key));
    for (const key of [
      ...MAHJONG_NAMED_FAN_KEYS,
      ...MAHJONG_ADDITIVE_FAN_KEYS,
      ...MAHJONG_OPTIONAL_FAN_KEYS,
    ]) {
      expect(covered.has(key), key).toBe(true);
    }
  });

  const negativeScore = (hand: Tile[], rules: MahjongRulesConfig) =>
    scoreBestHand({
      hand, melds: [], lackSuit: 2,
      winningTile: hand[hand.length - 1]!,
      context: EMPTY_HU_CONTEXT, rules,
    });

  it('duanYaoJiu 反例：有幺九不成立', () => {
    const r = negativeScore(plainHand, withOptional(DEFAULT_CHENGDU_RULES, { duanYaoJiu: 1 }));
    expect(r.items.join('|')).not.toContain('断幺九');
  });

  it('haiDi 反例：非海底不成立', () => {
    const r = negativeScore(plainHand, withOptional(DEFAULT_CHENGDU_RULES, { haiDi: 1 }));
    expect(r.items.join('|')).not.toContain('海底');
  });

  it('perGang 反例：无杠不成立', () => {
    const r = negativeScore(plainHand, withOptional(DEFAULT_CHENGDU_RULES, { perGang: 1 }));
    expect(r.items.join('|')).not.toContain('每杠');
  });

  it('shuangLong 反例：只有 1 组四张不成立', () => {
    const r = negativeScore(
      dragonPairsHand,
      withOptional(DEFAULT_CHENGDU_RULES, { shuangLong: 8 }, 8),
    );
    expect(r.baseName).not.toBe('shuangLong');
  });

  it('sanLong 反例：只有 2 组四张不成立', () => {
    const twoQuads = [...T(0, [1, 1, 1, 1, 2, 2, 2, 2]), ...T(1, [3, 3, 4, 4, 5, 5])];
    const r = negativeScore(twoQuads, withOptional(DEFAULT_CHENGDU_RULES, { sanLong: 8 }, 8));
    expect(r.baseName).not.toBe('sanLong');
  });

  it('shiBaLuoHan 反例：只有 3 个杠不成立', () => {
    const r = scoreBestHand({
      hand: [...T(0, [2, 3, 4]), t(1, 5), t(1, 5)],
      melds: [gang(0, 1), gang(0, 2), gang(0, 3)],
      lackSuit: 2,
      winningTile: t(1, 5),
      context: EMPTY_HU_CONTEXT,
      rules: withOptional(DEFAULT_CHENGDU_RULES, { shiBaLuoHan: 8 }, 8),
    });
    expect(r.baseName).not.toBe('shiBaLuoHan');
  });

  it('huContext 不置位天胡/地胡（接线守卫）', () => {
    const fake = { lastDraw: null, wall: [] } as unknown as MahjongSession;
    expect(huContext(fake, 0, true).tianHu).toBe(false);
    expect(huContext(fake, 0, true).diHu).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm -C packages/shared exec vitest run src/mahjong/fan-behavior.test.ts`
Expected: PASS。若某个正例失败，先核对真实引擎分解与文档；不得用放宽断言的方式“修绿”。把与文档不一致的项记录在提交信息里。

- [ ] **Step 3: 跑 shared 全量**

Run: `pnpm -C packages/shared test`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/shared/src/mahjong/fan-behavior.test.ts
git commit -m "test(shared): 每个番型标准牌例与行为审计（含天胡地胡接线守卫）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 客户端 store 保存 `mahjongRules`

**Files:**
- Modify: `apps/client/src/composables/useClientConfig.ts`
- Modify: `apps/client/src/stores/game.ts`
- Create: `apps/client/test/mahjong-rules-store.test.ts`

**Interfaces:**
- Produces: `ClientConfigState.mahjongRules: MahjongRulesClientView | null`；`setMahjongRules(rules)`

- [ ] **Step 1: 写失败测试**

```ts
// apps/client/test/mahjong-rules-store.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  mahjongRulesClientView,
} from '@fight-the-landlord/protocol';
import {
  FAILSAFE_CLIENT_CONFIG,
  normalizeClientConfig,
} from '../src/composables/useClientConfig';
import { useGameStore } from '../src/stores/game';

const view = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);

describe('mahjongRules store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('normalize 从 games.mahjong.mahjongRules 取值', () => {
    const cfg = normalizeClientConfig({
      games: { mahjong: { mahjongRules: view } },
    } as never);
    expect(cfg.mahjongRules).toEqual(view);
  });

  it('setClientConfig 写入；缺失时保留旧值', () => {
    const store = useGameStore();
    store.setClientConfig({
      ...FAILSAFE_CLIENT_CONFIG,
      mahjongRules: view,
    });
    expect(store.mahjongRules).toEqual(view);
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, mahjongRules: null });
    expect(store.mahjongRules).toEqual(view);
  });

  it('setMahjongRules 只改这一个字段', () => {
    const store = useGameStore();
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, version: 3 });
    store.setMahjongRules(view);
    expect(store.mahjongRules).toEqual(view);
    expect(store.clientConfigVersion).toBe(3);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client exec vitest run test/mahjong-rules-store.test.ts`
Expected: FAIL（`mahjongRules` 不存在）。

- [ ] **Step 3: 实现**

`useClientConfig.ts`：
- import `type MahjongRulesClientView`。
- `FAILSAFE_CLIENT_CONFIG` 增加 `mahjongRules: null`。
- `normalizeClientConfig` 返回值增加：
  ```ts
  mahjongRules: raw?.games?.mahjong?.mahjongRules ?? null,
  ```

`stores/game.ts`：
- import `type MahjongRulesClientView`。
- `ClientConfigState` 接口增加**可选**字段（可选是为了不破坏既有 7 个测试里构造的完整字面量；`apps/client/tsconfig.json` 的 include 含 `test/**/*.ts`）：
  ```ts
  /** 麻将规则客户端视图；null/缺省 = 未取到/旧服务端 ⇒ 静态介绍。 */
  mahjongRules?: MahjongRulesClientView | null;
  ```
- state 初值增加（照 `reliefThresholdCoins` 先例断言）：
  ```ts
  mahjongRules: null as MahjongRulesClientView | null,
  ```
- `setClientConfig` 内增加（**null/缺省不清空**）：
  ```ts
  if (cfg.mahjongRules) this.mahjongRules = cfg.mahjongRules;
  ```
- 新增 action：
  ```ts
  setMahjongRules(rules: MahjongRulesClientView | null) {
    this.mahjongRules = rules;
  },
  ```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C apps/client exec vitest run test/mahjong-rules-store.test.ts`
Expected: PASS。
Run: `pnpm -C packages/protocol build`
Expected: exit 0。
Run: `pnpm -C apps/client run lint`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/composables/useClientConfig.ts apps/client/src/stores/game.ts apps/client/test/mahjong-rules-store.test.ts
git commit -m "feat(client): store 保存麻将规则客户端视图（缺字段保留旧值）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 客户端轻量刷新 `refreshMahjongRules`

**Files:**
- Modify: `apps/client/src/composables/useClientConfig.ts`
- Create: `apps/client/test/mahjong-rules-refresh.test.ts`

**Interfaces:**
- Produces: `refreshMahjongRules(): Promise<boolean>`（单飞；不调用 `repairActiveMode/repairRoomMode`）

- [ ] **Step 1: 写失败测试**

```ts
// apps/client/test/mahjong-rules-refresh.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  DEFAULT_SBR_RULES,
  mahjongRulesClientView,
} from '@fight-the-landlord/protocol';
import { clientConfig } from '../src/config';
import { refreshMahjongRules } from '../src/composables/useClientConfig';
import { useGameStore } from '../src/stores/game';

const chengdu = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);
const sbr = mahjongRulesClientView(DEFAULT_SBR_RULES);

function stubConfig(body: unknown) {
  const calls: string[] = [];
  const mock = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

const okBody = (rules: unknown) => ({
  code: 0,
  data: { version: 7, games: { mahjong: { mahjongRules: rules } } },
});

describe('refreshMahjongRules', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clientConfig.token = 't';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('成功 ⇒ 只更新 mahjongRules，不改 activeMode/roomMode/底分', async () => {
    const store = useGameStore();
    store.setActiveMode('doudizhu');
    store.setSelectedBaseScore(15);
    const beforeMode = store.activeMode;
    const beforeRoom = store.roomMode;
    const beforeScore = store.selectedBaseScore;
    stubConfig(okBody(sbr));
    expect(await refreshMahjongRules()).toBe(true);
    expect(store.mahjongRules).toEqual(sbr);
    expect(store.activeMode).toBe(beforeMode);
    expect(store.roomMode).toBe(beforeRoom);
    expect(store.selectedBaseScore).toBe(beforeScore);
  });

  it('并发调用单飞：只发一次请求', async () => {
    const { mock } = stubConfig(okBody(chengdu));
    const [a, b] = await Promise.all([refreshMahjongRules(), refreshMahjongRules()]);
    expect([a, b]).toEqual([true, true]);
    expect(mock.mock.calls.length).toBe(1);
  });

  it('响应缺 mahjongRules ⇒ 保留旧值', async () => {
    const store = useGameStore();
    store.setMahjongRules(chengdu);
    stubConfig({ code: 0, data: { version: 8, games: { mahjong: {} } } });
    expect(await refreshMahjongRules()).toBe(false);
    expect(store.mahjongRules).toEqual(chengdu);
  });

  it('坏值 ⇒ 保留旧值', async () => {
    const store = useGameStore();
    store.setMahjongRules(chengdu);
    stubConfig(okBody({ scoringPolicy: 'named' }));
    expect(await refreshMahjongRules()).toBe(false);
    expect(store.mahjongRules).toEqual(chengdu);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client exec vitest run test/mahjong-rules-refresh.test.ts`
Expected: FAIL（未导出）。

- [ ] **Step 3: 实现**

在 `useClientConfig.ts` 末尾追加：

```ts
let mahjongRulesInFlight: Promise<boolean> | null = null;

function isMahjongRulesView(value: unknown): value is MahjongRulesClientView {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.scoringPolicy === 'string'
    && (v.fanBase === 0 || v.fanBase === 1)
    && typeof v.fanCap === 'number'
    && typeof v.fanTable === 'object' && v.fanTable !== null
    && typeof v.additiveFanTable === 'object' && v.additiveFanTable !== null
    && typeof v.optionalFans === 'object' && v.optionalFans !== null;
}

/**
 * 打开麻将规则介绍时的轻量刷新：
 * 只更新 store.mahjongRules；不修复玩法/场次选择；单飞；缺字段/坏值保留旧值。
 */
export function refreshMahjongRules(): Promise<boolean> {
  if (mahjongRulesInFlight) return mahjongRulesInFlight;
  mahjongRulesInFlight = (async () => {
    try {
      const res = await fetchClientConfig();
      if (res.code !== 0 || res.data === null || res.data === undefined) return false;
      const rules = res.data.games?.mahjong?.mahjongRules;
      if (!isMahjongRulesView(rules)) return false;
      useGameStore().setMahjongRules(rules);
      return true;
    } catch {
      return false;
    } finally {
      mahjongRulesInFlight = null;
    }
  })();
  return mahjongRulesInFlight;
}
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C apps/client exec vitest run test/mahjong-rules-refresh.test.ts`
Expected: PASS。
Run: `pnpm -C packages/protocol build`
Expected: exit 0。
Run: `pnpm -C apps/client run lint`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/composables/useClientConfig.ts apps/client/test/mahjong-rules-refresh.test.ts
git commit -m "feat(client): 打开麻将规则时轻量刷新 mahjongRules（单飞/不改选择）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 大厅规则弹层接入动态文案

**Files:**
- Modify: `apps/client/src/pages/lobby/lobby.vue:733-807`
- Create: `apps/client/test/mahjong-rules-intro.test.ts`

**Interfaces:**
- Consumes: `buildMahjongRuleSummary`、`refreshMahjongRules`、store `mahjongRules`
- Produces: 麻将规则弹层显示动态【番型与倍率】/【当前流程设置】；点 info 触发刷新且不改玩法。

- [ ] **Step 1: 写失败测试**

```ts
// apps/client/test/mahjong-rules-intro.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  mahjongRulesClientView,
} from '@fight-the-landlord/protocol';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { FakeSocket } from './helpers/fake-socket';

const flat = (text: string) => text.replace(/\s+/g, ' ');

const rules = {
  ...mahjongRulesClientView(DEFAULT_CHENGDU_RULES),
  fanCap: 5,
  fanTable: {
    ...mahjongRulesClientView(DEFAULT_CHENGDU_RULES).fanTable,
    longQiDui: 0,
  },
  optionalFans: {
    ...mahjongRulesClientView(DEFAULT_CHENGDU_RULES).optionalFans,
    perGang: 1,
  },
};

const CONFIG = {
  code: 0,
  data: {
    baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 3,
    games: {
      doudizhu: {
        enabled: true, supportedPlayerCounts: [3], defaultPlayerCount: 3,
        baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
        freeRoomEnabled: true, goldRoomEnabled: false, friendRoomEnabled: false,
        entryMultiplier: 10,
      },
      mahjong: {
        enabled: true, supportedPlayerCounts: [4], defaultPlayerCount: 4,
        baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
        freeRoomEnabled: true, goldRoomEnabled: false, friendRoomEnabled: false,
        entryMultiplier: 10,
        mahjongRules: rules,
      },
    },
  },
};

function stubFetch(body: unknown) {
  const calls: string[] = [];
  const mock = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

describe('麻将规则介绍动态文案', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    clientConfig.token = 't';
  });
  afterEach(() => {
    stopGameSession();
    clearSession();
    vi.unstubAllGlobals();
  });

  it('点麻将 info ⇒ 显示当前配置的番型/倍率/流程', async () => {
    const sockets: FakeSocket[] = [];
    startGameSession(() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    const calls = stubFetch(CONFIG);
    useAuthStore().navigate('lobby');
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();

    const cards = wrapper.findAll('.lobby__mode');
    const mahjongCard = cards.find((c) => flat(c.text()).includes('四川麻将'));
    expect(mahjongCard, '麻将玩法卡可见').toBeTruthy();
    const wrap = mahjongCard!.element.parentElement!;
    const info = wrap.querySelector('.lobby__mode-info') as HTMLElement;
    const beforeMode = useGameStore().activeMode;
    const beforeCalls = calls.filter((u) => u.includes('/config')).length;

    info.click();
    await flushPromises();

    const body = flat(wrapper.find('.lobby__rule-body').text());
    expect(body).toContain('番型与倍率');
    expect(body).toContain('封顶 5 番（×16）');
    expect(body).toContain('每杠 +1 番');
    expect(body).toMatch(/未启用：.*龙七对/);
    expect(body).toContain('当前流程设置');
    expect(body).not.toContain('默认封顶 6 番');
    expect(useGameStore().activeMode, '点 info 不得切换玩法').toBe(beforeMode);
    expect(calls.filter((u) => u.includes('/config')).length, '点开触发一次配置刷新')
      .toBe(beforeCalls + 1);
  });

  it('无 mahjongRules ⇒ 回退静态默认文案', async () => {
    const noRules = JSON.parse(JSON.stringify(CONFIG));
    delete noRules.data.games.mahjong.mahjongRules;
    const sockets: FakeSocket[] = [];
    startGameSession(() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    stubFetch(noRules);
    useAuthStore().navigate('lobby');
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();

    const cards = wrapper.findAll('.lobby__mode');
    const mahjongCard = cards.find((c) => flat(c.text()).includes('四川麻将'))!;
    const info = mahjongCard.element.parentElement!.querySelector(
      '.lobby__mode-info',
    ) as HTMLElement;
    info.click();
    await flushPromises();

    const body = flat(wrapper.find('.lobby__rule-body').text());
    expect(body).toContain('默认封顶 6 番');
    expect(body).toContain('默认口径');
    expect(body).not.toContain('番型与倍率');
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client exec vitest run test/mahjong-rules-intro.test.ts`
Expected: FAIL（弹层仍显示静态文案/无刷新）。

- [ ] **Step 3: 实现**

`lobby.vue` 顶部 import 增加：

```ts
import { GAME_META } from '@fight-the-landlord/protocol';
import { buildMahjongRuleSummary } from '@fight-the-landlord/protocol';
import { refreshMahjongRules } from '../../composables/useClientConfig';
```

（如已有 `GAME_META` import，合并到同一行。）

`ruleSections` 计算属性把：

```ts
const desc = currentRuleMode.value?.description;
```

替换为：

```ts
const mode = currentRuleMode.value;
const desc = mode?.id === GAME_META.mahjong.id
  ? buildMahjongRuleSummary(store.mahjongRules ?? undefined)
  : mode?.description;
```

`store` 用大厅已有的 `const store = useGameStore()`（`lobby.vue:93`），不要重复创建。

`openRule` 中增加：

```ts
function openRule(modeId: string) {
  ruleModeId.value = modeId;
  ruleOpen.value = true;
  if (modeId === GAME_META.mahjong.id) void refreshMahjongRules();
}
```

⚠️ `useGameStore()` 已在大厅 setup 中存在时复用同一变量，不要重复创建。

- [ ] **Step 4: 跑绿**

Run: `pnpm -C apps/client exec vitest run test/mahjong-rules-intro.test.ts test/lobby-modes.test.ts`
Expected: PASS（含既有「点 info 不得切换玩法」）。
Run: `pnpm -C packages/protocol build`
Expected: exit 0。
Run: `pnpm -C apps/client run lint`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/pages/lobby/lobby.vue apps/client/test/mahjong-rules-intro.test.ts
git commit -m "feat(client): 麻将规则弹层按后台配置动态展示番型与流程

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: admin `fanNotes` 数据 + 内容门禁

**Files:**
- Modify: `admin/app.js`（`MAHJONG_RULES_FORM`，约 1265-1500）
- Modify: `packages/protocol/src/mahjong/admin-rules-form.gate.test.ts`

**Interfaces:**
- Consumes: `MAHJONG_FAN_INFO`（Task 1）
- Produces: `MAHJONG_RULES_FORM.fanNotes`（34 键，投影 desc/example/playerCaveat/adminOnly/wired）

- [ ] **Step 1: 扩展门禁测试（先红）**

`admin-rules-form.gate.test.ts` 的 `MahjongRulesForm` 接口增加：

```ts
  fanNotes: Record<string, {
    desc: string;
    example?: string;
    playerCaveat?: string;
    adminOnly?: string;
    wired: boolean;
  }>;
```

import 增加 `MAHJONG_FAN_INFO`。追加测试：

```ts
it('fanNotes 键集 = 三张番表并集，且与 protocol 元数据投影逐字一致', () => {
  const all = new Set(Object.values(FORM.tables).flatMap((t) => t.keys));
  expect(Object.keys(FORM.fanNotes).sort()).toEqual([...all].sort());
  for (const key of all) {
    const info = MAHJONG_FAN_INFO[key]!;
    const expected = {
      desc: info.desc,
      ...(info.example ? { example: info.example } : {}),
      ...(info.playerCaveat ? { playerCaveat: info.playerCaveat } : {}),
      ...(info.adminOnly ? { adminOnly: info.adminOnly } : {}),
      wired: info.wired,
    };
    expect(FORM.fanNotes[key], key).toStrictEqual(expected);
  }
});

it('fanLabels 与 protocol label 逐键一致', () => {
  for (const [key, info] of Object.entries(MAHJONG_FAN_INFO)) {
    expect(FORM.fanLabels[key], key).toBe(info.label);
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/admin-rules-form.gate.test.ts`
Expected: FAIL（`fanNotes` 未定义）。

- [ ] **Step 3: 生成 `fanNotes` 字面量**

先构建 protocol，再用命令打印投影：

```bash
pnpm -C packages/protocol build
node -e "const {MAHJONG_FAN_INFO}=require('./packages/protocol/dist/mahjong/fan-info.js');const out={};for(const [k,v] of Object.entries(MAHJONG_FAN_INFO)){out[k]=Object.assign({desc:v.desc},v.example?{example:v.example}:{},v.playerCaveat?{playerCaveat:v.playerCaveat}:{},v.adminOnly?{adminOnly:v.adminOnly}:{},{wired:v.wired});}console.log(JSON.stringify(out,null,2));"
```

把输出粘贴到 `MAHJONG_RULES_FORM` 中 `fanLabels` 之后、`tables` 之前：

```js
  fanNotes: {
    // 粘贴上一步输出（JSON 对象即合法 JS）
  },
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/protocol exec vitest run src/mahjong/admin-rules-form.gate.test.ts`
Expected: PASS。
Run: `pnpm verify:admin`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add admin/app.js packages/protocol/src/mahjong/admin-rules-form.gate.test.ts
git commit -m "feat(admin): 麻将番表 fanNotes 数据（与 protocol 元数据逐字门禁）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: admin 行内说明渲染 + 样式 + 探针

**Files:**
- Modify: `admin/app.js`（`buildFanGroup`，约 2524-2559）
- Modify: `admin/style.css`（约 1140-1147）
- Modify: `scripts/admin-mahjong-rules-form-probe.mjs`
- Modify: `scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes: `MAHJONG_RULES_FORM.fanNotes`（Task 11）
- Produces: 每个 `.mj-fan-row` 内的 `.mj-fan-note` 结构。

- [ ] **Step 1: 先改探针（先红）**

`scripts/admin-mahjong-rules-form-probe.mjs` 在 `34 个番表输入` 断言之后替换/追加：

```js
const fanRows = qa(w, '#settings-rows .mj-fan-row');
const formTables = w.eval('MAHJONG_RULES_FORM.tables');
const expectedFanRows = Object.values(formTables).reduce((n, t) => n + t.keys.length, 0);
ok(fanRows.length === expectedFanRows, `番表行数 = 三表键数（实测 ${fanRows.length}/${expectedFanRows}）`);
const noteRows = fanRows.filter((row) => row.querySelector('.mj-fan-note'));
ok(noteRows.length === fanRows.length, `每个番行都有说明（实测 ${noteRows.length}/${fanRows.length}）`);
const descOf = (p) => fieldOf(w, p)?.querySelector('.mj-fan-desc')?.textContent ?? '';
const caveatOf = (p) => fieldOf(w, p)?.querySelector('.mj-fan-caveat')?.textContent ?? '';
const adminOf = (p) => fieldOf(w, p)?.querySelector('.mj-fan-admin')?.textContent ?? '';
ok(descOf('fanTable.pingHu').includes('任意合法胡牌型'), '平胡说明渲染');
ok(descOf('fanTable.qingYiSe').includes('同一花色'), '清一色说明渲染');
ok(caveatOf('fanTable.gen').includes('不计'), '根边界说明渲染');
ok(descOf('optionalFans.perGang').includes('每个副露杠'), '每杠说明渲染');
ok(adminOf('optionalFans.tianHu').includes('从未置位'), '天胡内部说明渲染');
ok(fieldOf(w, 'optionalFans.tianHu')?.querySelector('.mj-fan-wired')?.textContent.includes('未接入'),
  '天胡 wired 徽标');
const descRows = fanRows.filter((row) => row.querySelector('.mj-fan-desc'));
const uniqueDesc = new Set(descRows.map((row) => row.querySelector('.mj-fan-desc')?.textContent));
ok(uniqueDesc.size === descRows.length, `说明不是同一段复制（实测 ${uniqueDesc.size}/${descRows.length}）`);
```

删除原有的硬编码 `34` 断言那一行。

`scripts/verify-admin-static.mjs` 把：

```js
ok(mjFormBlock.length > 500, `麻将规则描述表块可提取且非空（实测 ${mjFormBlock.length} 字符）`);
```

改为：

```js
ok(mjFormBlock.length > 500, `麻将规则描述表块可提取且非空（实测 ${mjFormBlock.length} 字符）`);
ok(mjFormBlock.includes('fanNotes:'), '麻将描述表含 fanNotes');
ok(app.includes('mj-fan-note'), '麻将行内说明渲染器存在');
```

- [ ] **Step 2: 跑红**

Run: `pnpm verify:admin-mahjong-rules`
Expected: FAIL（无 `.mj-fan-note`）。
Run: `pnpm verify:admin`
Expected: FAIL（无 `fanNotes:` / `mj-fan-note`）。

- [ ] **Step 3: 实现渲染**

在 `admin/app.js` 的 `buildFanGroup` 内、`row.append(input, errEl);` 之后追加：

```js
      const note = MAHJONG_RULES_FORM.fanNotes[fanKey];
      if (note) {
        const noteEl = el('div', 'mj-fan-note');
        noteEl.dataset.noteFor = `${group.table}.${fanKey}`;
        noteEl.append(el('p', 'mj-fan-desc', note.desc));
        if (note.example) noteEl.append(el('p', 'mj-fan-example', `例：${note.example}`));
        if (note.playerCaveat) noteEl.append(el('p', 'mj-fan-caveat', `⚠ ${note.playerCaveat}`));
        if (note.adminOnly) noteEl.append(el('p', 'mj-fan-admin', `内部：${note.adminOnly}`));
        if (note.wired === false) noteEl.append(el('span', 'mj-fan-wired', '当前版本未接入'));
        row.append(noteEl);
      }
```

- [ ] **Step 4: 样式**

`admin/style.css` 在 `.mj-fan-row .mj-field-err` 之后追加：

```css
.mj-fan-note {
  flex-basis: 100%;
  margin: 2px 0 4px 130px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  line-height: 1.5;
}
.mj-fan-note p { margin: 0; }
.mj-fan-desc { color: var(--dim); }
.mj-fan-example { color: var(--dim); opacity: 0.85; }
.mj-fan-caveat { color: #b8860b; }
.mj-fan-admin { color: var(--dim); font-style: italic; }
.mj-fan-wired {
  align-self: flex-start;
  color: #b8860b;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
}
```

- [ ] **Step 5: 跑绿**

Run: `pnpm verify:admin-mahjong-rules`
Expected: PASS（原保存/重置断言 + 新说明断言）。
Run: `pnpm verify:admin`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add admin/app.js admin/style.css scripts/admin-mahjong-rules-form-probe.mjs scripts/verify-admin-static.mjs
git commit -m "feat(admin): 番表行内常驻说明（判定/牌例/边界/内部状态）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: 文档更新 + 全量验证

**Files:**
- Modify: `docs/games/mahjong.md`
- Modify: `docs/client-protocol.md`
- Modify: `docs/superpowers/specs/2026-10-29-mahjong-rules-form-design.md`（仅文首 supersede 指针）
- Modify: `packages/shared/src/mahjong/doc-sync.test.ts`

**Interfaces:**
- 文档与代码的权威关系、`mahjongRules` 形状、天胡/地胡现状。

- [ ] **Step 1: 写 doc-sync 失败测试**

`packages/shared/src/mahjong/doc-sync.test.ts` 增加：

```ts
import { MAHJONG_FAN_INFO } from '@fight-the-landlord/protocol';

it('每个番 label 在文档中出现', () => {
  for (const [key, info] of Object.entries(MAHJONG_FAN_INFO)) {
    const normalized = info.label.replace(/（.*?）/g, '');
    expect(doc, key).toContain(normalized);
  }
});

it('文档包含客户端动态番表说明与 mahjongRules 字段', () => {
  expect(doc).toContain('mahjongRules');
  expect(doc).toContain('当前版本预留未启用');
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/shared exec vitest run src/mahjong/doc-sync.test.ts`
Expected: FAIL（文档缺 `mahjongRules`/预留说明）。

- [ ] **Step 3: 更新文档**

`docs/games/mahjong.md`：
- §4.1 表格前加一句：`展示文案来自 protocol 的 MAHJONG_FAN_INFO；语义以本文 + 引擎实际行为为准。`
- §9 把天胡/地胡条目改为：`天胡/地胡：计分分支已有、触发检测未接线；当前版本预留未启用，配置开启也不会触发。`
- 新增小节（§8 后）：

```md
## 8.1 客户端玩法介绍

- 大厅麻将规则弹层在打开时请求 `GET /api/config`，读取 `games.mahjong.mahjongRules`。
- 该字段是客户端白名单视图；缺失/坏值/旧服务端 ⇒ 回退静态默认文案。
- 点开介绍只刷新规则视图，不改变玩家选中的玩法/场次。
- 打开介绍时不会实时推送；后台改动在下一次点开时生效。
```

`docs/client-protocol.md` 在 `/api/config` 的 `games` 说明后加：

```md
- `games.mahjong.mahjongRules?`：麻将规则客户端白名单（配分方式/番表/可选番/自摸/换三张/最后4张/过水/直杠/杠分转移/花猪/查叫）。不含计时窗口、`preset`、`rulesVersion`。缺失 ⇒ 客户端回退静态玩法介绍。
```

`docs/superpowers/specs/2026-10-29-mahjong-rules-form-design.md` 文首加：

```md
> **Supersede（2026-11-24）**：本 spec 的 D7「不写 60 条三行文案」已由
> `docs/superpowers/specs/2026-11-24-mahjong-fan-info-design.md` 取代；现状为
> protocol 元数据单一真源 + admin 内容门禁 + 引擎行为审计。
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/shared exec vitest run src/mahjong/doc-sync.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量验证**

Run each; all must pass:

```bash
pnpm -C packages/protocol build
pnpm -C packages/protocol test
pnpm -C packages/protocol lint
pnpm -C packages/shared test
pnpm -C packages/config-service test
pnpm -C packages/config-service lint
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm verify:admin
pnpm verify:admin-mahjong-rules
```

发布口径：admin 静态面走 `bash scripts/deploy/preview.sh`；客户端改动需 H5 部署 + 新 APK；旧 APK/旧服务端回退静态玩法介绍，验收时分端记录。

- [ ] **Step 6: 提交**

```bash
git add docs/games/mahjong.md docs/client-protocol.md docs/superpowers/specs/2026-10-29-mahjong-rules-form-design.md packages/shared/src/mahjong/doc-sync.test.ts
git commit -m "docs(mahjong): 客户端动态番表说明、mahjongRules 协议形状与天胡地胡现状

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 计划审查记录（2026-11-24 独立对抗审查）

审查者：独立子代理（sonnet），只读核对计划与真实代码。结论：需修订；B1–B6 必须修，H1–H6 必须补覆盖。以下为处置：

| 编号 | 级别 | 问题 | 处置 |
|---|---|---|---|
| B1 | 阻断 | `gen`/`root` 用例 `lack:1` 但手牌含筒，`scoreBestHand` 必抛错 | 两处改 `lack:2`（缺条），手牌不变 |
| B2 | 阻断 | `ClientConfigState` 加必填 `mahjongRules` 会打破 7 个既有测试字面量 | 字段改可选 `mahjongRules?: MahjongRulesClientView | null`；初值 `null as …` |
| B3 | 阻断 | Pinia 初值 `null` 推断为 null 字面量，`setMahjongRules` 赋值 TS2322 | 初值显式断言 |
| B4 | 阻断 | config-service/client lint 走 protocol dist；计划未先 build | Global Constraints + Task 6/8/9/10/13 显式 `pnpm -C packages/protocol build` |
| B5 | 阻断 | 探针断言 `gen` caveat 含“不计”，元数据写“不算根” | 元数据统一为“不计根” |
| B6 | 阻断 | 静态 base 仍断言“直杠：点杠者付”，与 `directGangMode` 冲突；时间文案含“强胡时=胡” | base 改为“按房间设置结算”；默认流程事实移入默认计分段；超时段去掉强胡断言；补 not.toContain 测试 |
| H1 | 高 | 清幺九牌例 1 万 6 张，物理非法 | 改为 `1-2-3万 1-2-3万 7-8-9万 7-8-9万 1-1万`（各 4 张内） |
| H2 | 高 | 缺每番反例与 CASES 覆盖门禁 | 加 CASES 全键覆盖断言 + 断幺九/海底/每杠/双龙/三龙/十八罗汉 六条反例 |
| H3 | 高 | 缺 pingHu=0、minFanToHu>cap、表值>cap、addFan 自摸边界测试 | Task 5 追加四条断言 |
| H4 | 高 | 刷新未校验形状，坏值会崩规则弹层 | 加 `isMahjongRulesView` 守卫 + 坏值保留旧值测试 |
| H5 | 高 | 缺 lobby 无 rules 回退静态的集成测试 | Task 10 追加无 mahjongRules 用例 |
| H6 | 高 | 探针删掉 34 计数后只断言 >0，回归面缩水 | 从 `MAHJONG_RULES_FORM.tables` 派生期望行数；说明去重数等于有 desc 的行数 |
| H7 | 高 | 缺失/null/{}/坏值 WARN 语义与 spec 偏差 | null/{} 加 WARN；缺行（旧服务端）静默 |
| L1 | 低 | spec 写从 `cfg.games` 读，计划改为顶层 `cfg.mahjongRules` | 以计划为准，spec §5.1 同步改为 normalize 提升到顶层 |
| L2 | 低 | Task 2 新门禁是派生后的重言式 | 保留用于“先红”；真正的漂移门禁以 Task 11 为准，不单独宣称 |
| L3 | 低 | spec 与计划的 `+N 番/组`、`封顶后 ×M` 措辞微差 | spec §3.4 对齐计划的 `+N 番` / `（×M）` |
| L4 | 低 | 刷新测试未断言底分不变 | 加 `setSelectedBaseScore(15)` 前后相等 |
| L5 | 低 | 计划缺审查记录 | 本节 |
| L6 | 低 | 发布/回退面未登记 | Task 13 发布口径 |
| L7 | 低 | config-service 新用例无 timeout | 两处补 `20000` |
| L8 | 低 | 动态文本断言不证明“刷新后更新” | 保留调用计数判别；后续可加两段式响应测试 |
| L9 | 低 | admin 深比较用 `toEqual` | 改 `toStrictEqual` |
| L10 | 低 | stubFetch 未按路由分派 | 本用例不受影响，登记 |
| L11 | 低 | `mahjongRules` 与牌桌快照同名不同义 | 实现注释点明“客户端视图 vs 牌桌规则快照” |

修订后按流程做一次聚焦复审（只核对上述阻断/高危项），通过后进入实现。

## Self-Review Checklist（写完计划后由执行者复核）

- [ ] Spec §3.1 的 34 个键都有 Task 1 元数据 + Task 7 正例。
- [ ] Spec §3.2 的 17 个白名单字段与 Task 3 完全一致，未多未少。
- [ ] Spec §3.4 的所有边界（全 0、pingHu=0、minFanToHu>fanCap、天胡预留、加法不使用可选番）都有 Task 5 断言。
- [ ] Spec §5 的「不修选择、单飞、缺字段保留」都有 Task 8/9/10 测试。
- [ ] Spec §6 的 admin 门禁/探针都有 Task 11/12。
- [ ] Spec §13 的 26 条审查处置没有被实现遗漏；若发现遗漏，补任务再开工。
