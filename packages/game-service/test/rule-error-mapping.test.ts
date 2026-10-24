/**
 * N2 / R164：规则引擎的错误映射必须**可枚举**，并且有两道机械闸：
 *  ① **覆盖闸**：规则引擎源码里**每一处** `throw new Error(...)` 都能被
 *     `RULE_ERROR_MAPPINGS` 的某条 pattern 命中 —— 任何人新增一个 `throw` 都会当场红。
 *     ⚠️ 规则源有**两处**（2026-10-12 项 ⑤ 起）：`packages/shared/src/{ddz,rule}`（对局流程）
 *     ＋ `packages/protocol/src/rule.ts`（牌型规则已迁入 protocol）—— 缺任一都会让本闸
 *     静默变窄（R150 形态）。`shared/src/rule/rule.ts` 现为纯重导出、**故意不含 throw**。
 *  ② **规格闸**：`SPEC_ROWS` 逐行抄自玩法 §11.1，断言 `classifyRuleError` 给出**文档写的那个码**
 *     （N16：本片把「压不过」与「牌不在手中」两条方向相反的错配收敛回文档）。
 *
 * ⚠️ 扫描器**必须支持模板字面量**（R150 的教训）：`play.ts` 里最关键的几条
 * （`Card ${card} not in hand`、`不支持的牌型: ${...}`、`Invalid DouZero card int: ${int}`）
 * 全是模板字面量，只匹配 `'…'` 的正则会**静默漏扫**它们，闸就变成了恒真。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RULE_ERROR_MAPPINGS, classifyRuleError } from '../src/game/rule-error.mapping';

// ⚠️ 路径解析照 `apps/client/test/helpers/source-scan.ts` 的既有写法（**不要**用 `__dirname`：
//    本仓的测试由 vitest 以 ESM 语义加载）。
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 定位 `packages/shared/src`。
 *
 * `test/` 的上两级恰好是 `packages/`，所以 `../../shared/src` 在**两种**布局下都对：
 *  - 主检出（门禁在这里跑 `turbo run test`）：`<root>/packages/shared/src`；
 *  - agent worktree：`<root>/.worktrees/<role>/packages/shared/src`（它**自己**那份，
 *    与主检出共用 `packages/` 这一层，因此**不必**补层数）。
 *
 * ⚠️ 这里踩过两个坑，都是 R150 的形态（闸扫错对象 ⇒ 恒真），别再退回去：
 *  - `'../../../shared/src'`（本片计划里写的）⇒ `<root>/shared/src`，**不存在** ⇒ ENOENT；
 *  - `'../../../../../packages/shared/src'`（我第一版的「修法」）⇒ 在 worktree 里**存在**，
 *    但它指到的是**主检出**的同名文件 ⇒ 闸读到不含本片改动的旧源码，**恒定绿灯**
 *    （实测：`hasPlant=false`、`hasOpening=false`，本片新增的 3 处 throw 从未进闸）；
 *    在主检出里则 ENOENT。
 *  ⇒ 下面第 2 条正对照（本片新增的文案必须被扫到）就是这两个坑的判别力，**不得删除**。
 */
const SHARED_SRC = resolve(HERE, '../../shared/src');
/**
 * 牌型规则实现（`parseHand` / `canBeat` / `HandType` 等）于 2026-10-12（项 ⑤ 出牌提示）
 * 从 `shared/src/rule/rule.ts` 迁入 protocol —— 覆盖闸必须跟到新家，否则「每处 throw
 * 都有人负责」这条判据在搬迁当天就静默失效（正是本闸注释反复警告的 R150 形态；
 * 2026-10-13 合并态全量验证实测捕获）。
 */
const PROTOCOL_RULE = resolve(HERE, '../../protocol/src/rule.ts');
/**
 * 多玩法片 S4（Task 4.1）：扫描面扩到 pdk —— `shared/src/pdk` 与 `protocol/src/pdk`
 * 是跑得快规则/特征/回合的全部实现（spec §5.8「覆盖闸扫描所有玩法目录」）。
 */
const PROTOCOL_PDK_DIR = resolve(HERE, '../../protocol/src/pdk');
const SCAN_DIRS = ['ddz', 'rule', 'pdk', 'core'] as const;

/** 把 `throw new Error(...)` 的实参**静态化**：剥掉 `${...}` 插值，只留模板的字面部分。 */
export function staticMessageOf(arg: string): string {
  return arg.replace(/\$\{[^}]*\}/g, '');
}

/** 扫出源码里所有 `throw new Error(<字面量>)`；返回静态化后的文本。
 *
 * ⚠️ Task 4.1：实参可能是**多行模板字面量 + 尾逗号**（`shared/pdk/settle.ts`），
 * 因此闭合引号后允许一个可选的尾逗号；否则扫描器会把后续源码当成同一条字面量，
 * 产出畸形消息（实测：覆盖闸对 settle.ts 的三处 throw 全部误判）。
 */
export function scanThrows(source: string): string[] {
  const out: string[] = [];
  const re = /throw new Error\(\s*([`'"])([\s\S]*?)\1\s*,?\s*\)/g;
  for (const m of source.matchAll(re)) out.push(staticMessageOf(m[2]!));
  return out;
}

function collectThrowSites(): Array<{ file: string; message: string }> {
  const sites: Array<{ file: string; message: string }> = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(SHARED_SRC, dir);
    for (const entry of readdirSync(abs)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const file = join(abs, entry);
      if (!statSync(file).isFile()) continue;
      for (const message of scanThrows(readFileSync(file, 'utf8'))) {
        sites.push({ file: `${dir}/${entry}`, message });
      }
    }
  }
  // ② protocol 侧迁入的规则实现（见 PROTOCOL_RULE 注释）
  for (const message of scanThrows(readFileSync(PROTOCOL_RULE, 'utf8'))) {
    sites.push({ file: 'protocol/rule.ts', message });
  }
  // ③ 跑得快规则实现（Task 4.1：协议层的 pdk 目录；以后新增文件自动进闸）
  for (const entry of readdirSync(PROTOCOL_PDK_DIR)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const file = join(PROTOCOL_PDK_DIR, entry);
    if (!statSync(file).isFile()) continue;
    for (const message of scanThrows(readFileSync(file, 'utf8'))) {
      sites.push({ file: `protocol/pdk/${entry}`, message });
    }
  }
  return sites;
}

/** 规格表：逐行抄自 `docs/games/doudizhu.md` §11.1（`design.md` §11.2 只定义码义）。 */
const SPEC_ROWS: ReadonlyArray<{ message: string; code: ErrCode; basis: string }> = [
  { message: 'Not your turn', code: ErrCode.NOT_YOUR_TURN, basis: '§11.1 非当前回合玩家操作' },
  { message: 'Not your turn to bid', code: ErrCode.NOT_YOUR_TURN, basis: '§11.1 非当前叫抢者决策' },
  { message: 'Game is not in playing state', code: ErrCode.ILLEGAL_ACTION, basis: '§11.1 阶段不符' },
  { message: 'Game is not in bidding state', code: ErrCode.ILLEGAL_ACTION, basis: '§11.1 state !== bidding 时收到 game.bid' },
  { message: 'Cannot pass on the opening lead', code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-2 / §11.1 首出过牌' },
  { message: 'Cannot pass when you last played', code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-3 / §11.1 最后出牌者过牌' },
  { message: 'Card 7 not in hand', code: ErrCode.ILLEGAL_ACTION, basis: '§6.1-2 / §11.1 牌不在手中（N16：原为 13006）' },
  { message: 'Invalid move - cannot beat last hand', code: ErrCode.INVALID_CARDS, basis: '§6.1-3 / §11.1 压不过上一手（N16：原为 13001）' },
  { message: '不支持的牌型: 3,4', code: ErrCode.INVALID_CARDS, basis: '§4.3 / §11.1 牌型非法' },
  { message: '不能出空牌', code: ErrCode.INVALID_CARDS, basis: '§4.3 非法牌组（空手出牌应走 game.pass）' },
  { message: 'Player p1 not found', code: ErrCode.NOT_IN_ROOM, basis: '§5.3 身份映射' },
  { message: 'Invalid DouZero card int: 99', code: ErrCode.INVALID_CARDS, basis: '防御：牌值不在 DouZero 值域（当前不可达）' },
  { message: 'Game not finished', code: ErrCode.ILLEGAL_ACTION, basis: '内部前置：结算前必须已有胜负（不可达）' },
  { message: 'Player p1 has no card to play', code: ErrCode.ILLEGAL_ACTION, basis: '§9.1 兜底（不可能状态）' },
  {
    message: 'invariant violated: lastPlayedHand !== null requires currentPlayer !== lastPlayerIdx',
    code: ErrCode.ILLEGAL_ACTION,
    basis: '§6.3 不变式 1（本条 pattern 覆盖 §6.3 的全部不变式变体）',
  },
  // 跑得快（Task 4.1 / spec §5.8）
  { message: 'Invalid pdk hand', code: ErrCode.INVALID_CARDS, basis: 'spec §5.5 牌型非法' },
  {
    message: 'paodekuai does not support game.bid',
    code: ErrCode.ILLEGAL_ACTION,
    basis: 'spec §5.8 跑得快收到 game.bid ⇒ 13001',
  },
  {
    message: 'pdk settlement requires exactly one winner (players with 0 cards: [])',
    code: ErrCode.ILLEGAL_ACTION,
    basis: '内部前置：结算前必须恰一名赢家（不可达）',
  },
  {
    message: 'pdk session is missing a player at seat 1',
    code: ErrCode.ILLEGAL_ACTION,
    basis: '内部投影前置：pdk 会话形状写坏（不可达）',
  },
  {
    message: 'seat 5 is out of range 0..2',
    code: ErrCode.ILLEGAL_ACTION,
    basis: '内部投影前置：座位越界（不可达）',
  },
];

describe('规则引擎错误映射（N2/R164）', () => {
  it('规格闸：玩法 §11.1 的逐因映射逐行成立（N16 的两处错配已收敛）', () => {
    for (const row of SPEC_ROWS) {
      expect(classifyRuleError(new Error(row.message)), `${row.message}（${row.basis}）`).toBe(row.code);
    }
  });

  it('覆盖闸：shared/src/{ddz,rule,pdk,core} 与 protocol/src/{rule.ts,pdk} 的每一处 throw 都有映射', () => {
    const sites = collectThrowSites();
    // 探针：扫描器真的读到了代码，而不是「什么也没扫到」的恒真闸
    expect(sites.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'ddz/play.ts',
        'ddz/bid.ts',
        'ddz/settle.ts',
        'pdk/play.ts',
        'pdk/features.ts',
        'protocol/rule.ts',
      ]),
    );
    expect(sites.length).toBeGreaterThanOrEqual(12);
    /**
     * 探针②（实测补上，**不得删除**）：扫描根必须落在**本检出**里，且真的扫到了各源的
     * throw。早先的固定层数相对路径在 `.worktrees/<role>/` 下会读到**主检出**的同名文件，
     * 于是这条闸全程绿灯、却对本片改动一无所知（R150 形态）。三条文案分别来自
     * shared 的 Task 2（C18 过牌前置）/ Task 4（`handlePlayTimeout` 兜底）与
     * protocol 迁入的牌型规则（项 ⑤，「不能出空牌」）。
     */
    expect(
      sites.map((s) => s.message),
      '扫描根指向的不是本检出的源码（见 SHARED_SRC / PROTOCOL_RULE 的注释）',
    ).toEqual(
      expect.arrayContaining([
        'Cannot pass on the opening lead',
        'Player  has no card to play',
        '不能出空牌',
        // Task 4.1：pdk 的两类新 throw 也真的被扫到（play.ts 牌型非法 / settle.ts 内部前置）
        'Invalid pdk hand',
        'pdk settlement missing player at seat ',
      ]),
    );
    for (const site of sites) {
      const hit = RULE_ERROR_MAPPINGS.find((m) => m.pattern.test(site.message));
      expect(hit, `${site.file} 的 throw「${site.message}」没有任何映射（新增 throw 必须同步加映射）`).toBeDefined();
    }
  });

  it('探针判别力：扫描器支持模板字面量，且未映射的文本确实不被任何 pattern 命中（R150/R171①）', () => {
    // 正对照：模板字面量必须被扫到（只匹配 '…' 的写法会漏掉 play.ts 里最关键的几条）
    expect(scanThrows('throw new Error(`Card ${c} not in hand`);')).toEqual(['Card  not in hand']);
    expect(scanThrows("throw new Error('Not your turn');")).toEqual(['Not your turn']);
    // Task 4.1：多行实参 + 尾逗号（settle.ts 的真实形态）也必须被完整扫到
    expect(scanThrows('throw new Error(\n  `boom ${x}`,\n);')).toEqual(['boom ']);
    // 负对照：闸门对**未映射**的文本给出 undefined（否则覆盖闸也是恒真）
    expect(RULE_ERROR_MAPPINGS.find((m) => m.pattern.test('definitely-unmapped-message'))).toBeUndefined();
    // 兜底仍必须是契约内的码，而不是 500
    expect(classifyRuleError(new Error('definitely-unmapped-message'))).toBe(ErrCode.ILLEGAL_ACTION);
  });
});
