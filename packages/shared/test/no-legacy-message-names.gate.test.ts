/**
 * 防复活闸（**R361 判据 ③**，独立小片 P7）：`packages/shared/src/**` 里**不得再出现**
 * 那份被整条删除的「遗留第二契约」的任何名字。
 *
 * ## 它守的是什么
 *
 * `packages/shared/src/protocol/message.ts` 曾定义过一份与 `docs/design.md` §6.1/§6.2/§6.3
 * **逐字冲突**的契约（含应用层 `'ping'`、`GameMessage.seq`、以及 §6.3 里「明确不存在」的
 * 一批消息名）。R361 的裁决是**整条删除**而不是「标 deprecated 保留」——三条理由里最关键的一条是
 * **它的类型名与真契约包 `packages/protocol` 重名**（`ClientMessageType` / `ServerEventName` /
 * `GameMessage` / `ServerEvent`）⇒ 下一个 session 误 import 的后果不是编译错，而是
 * **静默用了错的那份**。删除本身没有留任何机械守卫，所以这道闸就是防止它「复活」的那道闸。
 *
 * ## 判据的两族（各自对应一种复活形态）
 *
 * ① **已废除或从未存在的消息名字面量**（真源：`docs/design.md` §6.3 的消息清单 +
 *    「明确不存在」段 + 旧名迁移映射表）。复活形态 = 有人把旧清单抄回来。
 * ② **遗留契约的类型名**，且只匹配**声明形态**（`interface X` / `type X` / `enum X` / `class X`）。
 *    复活形态 = 有人重新声明一份线格式契约。⚠️ 刻意**不**匹配「提及」：
 *    `import type { ClientMessageType } from '@fight-the-landlord/protocol'` 是**合法**的
 *    （引用唯一契约源），按裸名字匹配会让闸在一种正当写法上假红 —— 而假红最终会逼着人把闸删掉
 *    （R150 的原话：最常见的错误「修法」是把判别力一起删掉）。
 *
 * ## 逐字执行的判据纪律
 *
 * - **R150（先量底数再定正则）**：本文件写出前的底数 grep（`packages/shared/src`，删除两个遗留文件之后）
 *   两族都**零命中**：
 *   ```
 *   grep -rnE "(interface|type|enum|class)[[:space:]]+(ClientMessageType|ServerMessageType|ServerEventName|GameMessage|ServerEvent)\b" packages/shared/src   # 0
 *   grep -rnE "['\"\`](game\.deal_cards|…|ping)['\"\`]" packages/shared/src                                                                                   # 0
 *   ```
 *   ⚠️ 第二族用**带引号的字面量**形态（而不是裸子串）是因为 `ping` 是**通用单词**：
 *   裸子串会命中 `pingInterval` / `mapping` / `typing` 之类无关文本。带引号后它只命中
 *   「真的把 `'ping'` 当消息名写」这一件事 —— 底数实测它在 `packages/shared/src` 里零命中，
 *   因此**不**把 `ping` 从清单里排除（排除掉等于白丢一条判别力）。
 * - **R115 / R150（判别力必须自证）**：下面 `it.each` 对**每一个**名字做一次注入式自证 ——
 *   在**每次调用独有的临时根**里写一行包含该名字的源码，闸**必须红**；且断言**每条坏输入只触发一条**
 *   违规（防「抓到的是另一条分支」的空测）。`finally` **连根删除**。
 * - **R179（worktree 路径陷阱）**：扫描根相对**本测试文件**解析，不写相对 CWD 的路径 ——
 *   写错一层会静默扫到主检出的旧源码（闸恒绿）或直接 ENOENT。并有一条哨兵断言证明
 *   扫描根解析到了一个**真实且非空**的目录。
 * - **R242 / R250（零命中是结果、不是状态）**：本闸**没有** allowlist、**没有** `NOT_YET_*`
 *   待清空清单 —— 期望值就是**字面空数组**。
 * - **Obs-5（2026-09-23）：探针写在真实源码树之外**。原先探针是 `src/` 下一个**固定名**文件 ⇒
 *   「同一包被两个 vitest 进程同时跑」（控制者在实现者跑测试时并行核数 / 两个实现者撞车）时，
 *   A 的探针会被 B 的扫描当成真实源码 ⇒ **整文件 21 条全红**（实测 3/3 轮复现；单留一个探针文件
 *   也单独造出 21/21 红）。⚠️ **只给文件名加 `process.pid` 不够**（实测：单跑 21/21 绿，
 *   6/6 并发跑仍红）—— 扫描读的**是整棵树**，别人的探针无论叫什么名字都照样进结果。
 *   修法 = 探针移进 `mkdtempSync` 出的**每次调用独有**的临时根 ⇒ 共享可变状态为零。
 *   这正是 P6 教训 4（判据不能在门禁负载下变成假红）在「同包两进程」形态上的重演。
 * - ⚠️ 探针仍带**点前缀**（`PROBE_FILE_NAME`）：它现在是「**扫描器不过滤点前缀**」这条管辖声明的
 *   活证据（`listSourceFiles` 与闸本身都不过滤）；且临时根在 `src/` 之外 ⇒ 并发的
 *   `tsc --noEmit` 也不会读它。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `packages/shared/src`（相对本测试文件解析，见 R179 说明）。 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/**
 * `docs/design.md` §6.3「明确不存在」+ 旧名迁移映射表里**已废除或从未存在**的消息名。
 * §6.3 是消息清单的**唯一真源**；这些名字一个都不在它的清单里。
 */
const ABOLISHED_MESSAGE_NAMES = [
  'game.deal_cards',
  'game.bid_turn',
  'game.bid_result',
  'game.landlord',
  'game.play_turn',
  'game.card_played',
  'game.player_pass',
  'game.game_over',
  'room.chat_message',
  'room.joined',
  'room.players_updated',
  'game.match_found',
  'ping',
] as const;

/**
 * 已删的 `src/protocol/message.ts` 定义过的类型名。`packages/protocol` 是**唯一契约源**
 * ⇒ `shared` 不得**声明**它们（引用真契约源是允许的，见文件头 ②）。
 */
const LEGACY_CONTRACT_TYPE_NAMES = [
  'ClientMessageType',
  'ServerMessageType',
  'ServerEventName',
  'GameMessage',
  'ServerEvent',
] as const;

type FindingKind = 'message-name' | 'legacy-type';

interface Finding {
  /** 相对 `src/` 的路径，例如 `ddz/game.ts`。 */
  file: string;
  line: number;
  name: string;
  kind: FindingKind;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 带引号的字面量形态（`'ping'` / `"ping"` / `` `ping` ``）——刻意不用裸子串，理由见文件头。 */
const messageNamePattern = (name: string): RegExp =>
  new RegExp(`['"\`]${escapeRegExp(name)}['"\`]`);

/** 声明形态（`interface X` / `type X` / `enum X` / `class X`）——刻意不匹配 `import type { X }`。 */
const legacyDeclarationPattern = (name: string): RegExp =>
  new RegExp(`\\b(?:interface|type|enum|class)\\s+${escapeRegExp(name)}\\b`);

/** 递归列出 `dir` 下的全部文件（**不过滤点前缀**：点文件同样受闸管辖）。 */
export function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** 纯函数：扫描一棵源码树，返回全部违规点（空数组 = 合规）。 */
export function scanForLegacyContractNames(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const path of listSourceFiles(root)) {
    const file = relative(root, path);
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const name of ABOLISHED_MESSAGE_NAMES) {
        if (messageNamePattern(name).test(text)) {
          findings.push({ file, line: index + 1, name, kind: 'message-name' });
        }
      }
      for (const name of LEGACY_CONTRACT_TYPE_NAMES) {
        if (legacyDeclarationPattern(name).test(text)) {
          findings.push({ file, line: index + 1, name, kind: 'legacy-type' });
        }
      }
    });
  }
  return findings;
}

const render = (finding: Finding): string =>
  `${finding.file}:${finding.line} [${finding.kind}] ${finding.name}`;

/** 探针文件名（点前缀 ⇒ 「扫描器不过滤点前缀」的活证据，见文件头 Obs-5 一条）。 */
const PROBE_FILE_NAME = '.zz-legacy-contract-probe.ts';

/** 注入式自证用的临时根**前缀**（`mkdtempSync` 会补 6 位随机后缀 ⇒ 每次调用独有）。 */
const PROBE_ROOT_PREFIX = join(tmpdir(), 'zz-legacy-probe-');

/**
 * 注入一行源码 ⇒ 扫描 ⇒ `finally` **连根删除**。返回违规点的人读形态，便于在失败信息里定位。
 *
 * ⚠️ 探针写在本次调用独有的临时根里（Obs-5，见文件头）：与相邻进程的共享可变状态为零。
 * 扫描根 = 那个临时根 ⇒ `render` 出的相对路径**就是探针文件名**（与旧版在 `src/` 下时逐字相同）。
 *
 * ⚠️ 旧版这里有一条 `expect(existsSync(PROBE)).toBe(false)`（「绝不覆盖别人的文件」）——
 * 随固定路径一并删掉：它的风险源（共享路径）被 `mkdtempSync` **结构性**消除，而不是被忽略。
 */
function scanWithProbe(injectedSource: string): string[] {
  const root = mkdtempSync(PROBE_ROOT_PREFIX);
  try {
    writeFileSync(join(root, PROBE_FILE_NAME), injectedSource, 'utf8');
    return scanForLegacyContractNames(root).map(render);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('防复活闸（R361）：shared 不得再出现遗留第二契约的名字', () => {
  it('扫描根解析正确（R179：路径写错会静默扫到别处或空目录 ⇒ 闸恒绿）', () => {
    const files = listSourceFiles(SRC_DIR).map((path) => relative(SRC_DIR, path));
    expect(files.length).toBeGreaterThan(0);
    // 哨兵：桶文件与一个稳定的规则实现文件必须都在扫描集合里。
    expect(files).toContain('index.ts');
    expect(files).toContain(join('ddz', 'game.ts'));
    // 真实源码树里不得有探针文件（Obs-5 之后探针落在临时根里 ⇒ 这条守的是**残留**：
    // 崩掉的旧版本运行、或另一个检出的并发进程留下的探针）。
    expect(files.filter((file) => file.includes('.zz-legacy-contract-probe'))).toEqual([]);
  });

  it('src/** 中两族名字零命中（零命中是结果：期望值就是空数组，没有 allowlist）', () => {
    expect(scanForLegacyContractNames(SRC_DIR).map(render)).toEqual([]);
  });

  it.each(ABOLISHED_MESSAGE_NAMES)(
    '判别力自证：注入一行含 %s 的源码 ⇒ 闸必须红（且只报这一条）',
    (name) => {
      expect(scanWithProbe(`export const zzLegacyProbe = '${name}';\n`)).toEqual([
        `${PROBE_FILE_NAME}:1 [message-name] ${name}`,
      ]);
      // 真实源码树全程零命中（探针不落在那里，也不受相邻进程影响）。
      expect(scanForLegacyContractNames(SRC_DIR).map(render)).toEqual([]);
    },
  );

  it.each(LEGACY_CONTRACT_TYPE_NAMES)(
    '判别力自证：重新声明遗留类型 %s ⇒ 闸必须红（且只报这一条）',
    (name) => {
      expect(scanWithProbe(`export type ${name} = { probe: true };\n`)).toEqual([
        `${PROBE_FILE_NAME}:1 [legacy-type] ${name}`,
      ]);
      // 真实源码树全程零命中（探针不落在那里，也不受相邻进程影响）。
      expect(scanForLegacyContractNames(SRC_DIR).map(render)).toEqual([]);
    },
  );

  it('引用唯一契约源（`import type { … } from \'@fight-the-landlord/protocol\'`）不得假红', () => {
    expect(
      scanWithProbe(
        "import type { ClientMessageType, ServerMessageType } from '@fight-the-landlord/protocol';\n",
      ),
    ).toEqual([]);
  });
});
