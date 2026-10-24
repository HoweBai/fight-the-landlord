/**
 * **J29 机械闸（片② D1 / 用户裁决 9）**：**开关不得接到决策侧**。
 *
 * ─── 它守的是什么 ──────────────────────────────────────────────────────
 * 裁决 9 的语义：`robot.ruleFallback` 只决定 **room 侧补位门禁**问不问 DouZero；
 * **已入座**的机器人照旧全走 DouZero（失败才回退规则引擎）。把开关接进
 * `bot.player.ts`（如「OFF ⇒ 决策直接用规则引擎」）是把裁决 9 反着实现 ——
 * 而那个错实现**不会打扰任何既有单测**（三档仍各调一次 DouZero 的用例照样绿，
 * 因为开关默认 ON、测试环境没有 OFF 的会话）。⇒ 用源码级闸钉死。
 *
 * ─── 判据 ──────────────────────────────────────────────────────────────
 * ① `bot.player.ts`（剥注释后）不得出现 `ROBOT_RULE_FALLBACK` / `getRobotConfig`；
 * ② 全包扫描（更强口径）：`ROBOT_RULE_FALLBACK` / `.ruleFallback` 的**读者**只能是
 *    白名单三处 —— 见 `ALLOWED_SWITCH_READERS` 的逐条理由（片⑦ E6 白名单同步：
 *    env 退役后新定义点在 `config-cache.service.ts`；`config.ts` 是四键**代码默认值**
 *    的导出点）。任何**新增读者**（比如接进 `robot.service.ts` 的 RPC 转发或
 *    `douzero.client.ts`）都会在这里红。
 *
 * ─── 探针纪律 ──────────────────────────────────────────────────────────
 *  - 扫源码前**先剥注释**（台账 N46：唯一真源 `@fight-the-landlord/test-utils`，守卫语义 ——
 *    URL 里的 `//` 不误剥；收敛前本文件是跨包 8 份私有副本之一）——
 *    将来有人在注释里写「此处不读 ROBOT_RULE_FALLBACK」不该假红；
 *  - 每条断言配**正/负对照**（判别力自证），并有一条**等价反事实**：把开关按错实现的
 *    形态接进决策链，合成样本必须命中（= 真实文件若这么写，本闸必红）。
 *  - ⚠️ 片⑦ E6 只动了**白名单集合**（`ALLOWED_SWITCH_READERS`）与其理由注释；
 *    扫描谓词（`SWITCH_TERM` / `SWITCH_ACCESS`）与全部正/负对照**一字未动**。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';

/**
 * 从本文件所在目录**向上**找仓库根（锚 = `packages/robot-service/package.json` +
 * `packages/protocol/package.json`，并校验前者的 name 字段）。
 * ⚠️ 不写固定层数的相对路径（R179）：层数一错会静默扫到主检出；找不到必须**抛错**。
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'robot-service', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/robot-service"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '找不到仓库根（锚 = packages/robot-service/package.json 且 name 校验通过 + packages/protocol）—— 绝不静默空测',
  );
}

const REPO = findRepoRoot();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

/** 「读开关」的两种形态：直接读 env 名，或读 `RobotConfig` 的 `ruleFallback` 字段。 */
const SWITCH_TERM = /ROBOT_RULE_FALLBACK|\.ruleFallback\b/;

/** J29① 对 `bot.player.ts` 的独家口径：连**开关的访问器**都不许出现在决策侧。 */
const SWITCH_ACCESS = /ROBOT_RULE_FALLBACK|getRobotConfig/;

/** 递归列出 `dir` 下全部文件。 */
function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** `packages/robot-service/src` 下的全部 `.ts`（跳过测试文件），仓库根相对路径（`/` 分隔）。 */
function robotSrcFiles(): string[] {
  const srcDir = join(REPO, 'packages', 'robot-service', 'src');
  if (!existsSync(srcDir)) throw new Error(`扫描面不存在：${srcDir}`);
  return listFiles(srcDir)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .map((path) => relative(REPO, path).split(sep).join('/'));
}

/** 剥注释后含开关词的文件（读者集合）。 */
function switchReaders(): string[] {
  return robotSrcFiles().filter((rel) => SWITCH_TERM.test(stripComments(read(rel))));
}

/**
 * 开关的**允许读者**（全包口径；片⑦ E6 同步为「新定义点」）。每一项都要给出理由，
 * 理由就是它为何**不是**决策侧：
 *  - `config.ts` —— 四键**代码默认值**（=种子）的导出点（`ROBOT_CONFIG_DEFAULTS`），
 *    含 `robot.ruleFallback` 键名与默认值 `true`。片⑦ E1 后这里**不再解析 env**；
 *  - `config-cache.service.ts` —— 开关的**新定义点**：`ruleFallback()` 从配置快照读
 *    `robot.ruleFallback`（缺失/非 boolean ⇒ 默认 true）。它是数据面，不是决策侧；
 *  - `douzero.health.ts` —— **探测门禁**按开关短路（开关 ON ⇒ 不探测、恒答「能给」）。
 *    它是房间侧可用性门禁的 robot 端；决策链（`bot.player.ts` → `douzero.client.ts`）
 *    与 RPC 转发（`robot.service.ts`）都不在此列。
 */
const ALLOWED_SWITCH_READERS = [
  'packages/robot-service/src/robot/config.ts',
  'packages/robot-service/src/config/config-cache.service.ts',
  'packages/robot-service/src/robot/douzero.health.ts',
] as const;

describe('J29：开关不得接到决策侧（片② D1 / 用户裁决 9）', () => {
  it('锚点与扫描面自证（防「找不到根」被静默吞掉，或扫到空树恒绿）', () => {
    expect(existsSync(join(REPO, 'packages', 'robot-service', 'src'))).toBe(true);
    expect(existsSync(join(REPO, 'packages', 'protocol', 'package.json'))).toBe(true);
    expect(robotSrcFiles().length).toBeGreaterThan(10);
  });

  it('J29①：bot.player.ts 不读 ROBOT_RULE_FALLBACK / getRobotConfig（剥注释后零命中）', () => {
    const code = stripComments(read('packages/robot-service/src/robot/bot.player.ts'));
    // 哨兵：扫到的必须是决策实现本体（防文件被改名/搬走后「扫到空」也全绿）。
    expect(code).toContain('class BotPlayer');
    expect(code).toContain('decidePlay');
    expect(
      SWITCH_ACCESS.test(code),
      'bot.player.ts 读了开关 —— 裁决 9：开关只管补位门禁，已入座机器人的决策必须全走 DouZero',
    ).toBe(false);
  });

  it('J29②：全包扫描 —— 开关的读者只有 config.ts（默认值）/ config-cache.service.ts（新定义点）/ douzero.health.ts（探测门禁）', () => {
    const readers = switchReaders().sort();
    expect(readers).toEqual([...ALLOWED_SWITCH_READERS].sort());
  });

  it('探针判别力（正/负对照）：两种真实读取形态命中，注释形态不命中', () => {
    // 正：直接读 env 名 / 读 config 的字段 / 意图把开关接进决策（等价反事实的坏样本）
    expect(SWITCH_TERM.test(stripComments("parseRuleFallback(process.env.ROBOT_RULE_FALLBACK)"))).toBe(true);
    expect(SWITCH_TERM.test(stripComments('if (getRobotConfig().ruleFallback) return;'))).toBe(true);
    expect(SWITCH_ACCESS.test(stripComments("import { getRobotConfig } from './config';"))).toBe(true);
    const evil =
      'export class BotPlayer {\n  decide(req: RobotDecideRequest) {\n' +
      "    const on = getRobotConfig().ruleFallback;\n    if (!on) return this.ruleDecide(req);\n  }\n}\n";
    expect(SWITCH_ACCESS.test(stripComments(evil)), '把开关接进决策链的错实现必须被看见').toBe(true);
    // 负：注释里的开关词不算（`stripComments` 先行）；无关标识符不得误伤
    expect(SWITCH_TERM.test(stripComments('// 本链不读 ROBOT_RULE_FALLBACK（J29）'))).toBe(false);
    expect(SWITCH_TERM.test(stripComments('/** 白名单见 J29 的注释 */'))).toBe(false);
    expect(SWITCH_TERM.test(stripComments('const ruleFallbackCount = 0;'))).toBe(false);
  });
});
