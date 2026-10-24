/**
 * 文档对账闸：`docs/client-protocol.md`（客户端接入协议清单）与协议包**双向一致**。
 *
 * ## 为什么需要它
 *
 * 那份文档是**给人读的**（独立开发客户端的人照着它写），而人读的文档一旦与代码脱节，
 * 就变成**会撒谎的第二真源** —— 本仓为「第二真源」付过多次代价。
 * 所以它的每一条都必须由机器对账，而不是靠「记得改」。
 *
 * ## 双向
 *
 * - **正向**：契约里的**每一条**消息名、**每一个**错误码，都必须在文档里出现
 *   ⇒ 防「加了新消息却忘了写进文档」；
 * - **反向**：文档**表格里**列出的消息名/错误码，必须**恰好等于**契约的集合
 *   ⇒ 防「文档里留着已删除的条目」（R377：清单里的死条目会让「零命中」变成假绿）。
 *
 * ⚠️ **只解析表格行，不解析散文**：文档第 11 节「明确不存在的东西」**故意**列了一批
 * 契约里没有的名字（`bot.move` / `room.joined` / `ping`…）。按散文抓会把它们当成违规 ——
 * 那会让「把不存在的东西写清楚」这件事**反过来惩罚作者**。表格行有固定形状，是可靠的锚。
 *
 * ⚠️ **判别力自证**（R115/R150 的规矩）：本仓不接受「因为什么也没抓到所以恒绿」的闸 ——
 * 下面每条断言都配了合成样本，证明它**真的会红**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  ErrCode,
} from '@fight-the-landlord/protocol';
import { SRC_ROOT } from './helpers/source-scan';
import { messageTypeList } from '../src/net/socket';

/** `apps/client/test` → `apps/client` → `apps` → 仓库根 */
const DOC_PATH = join(SRC_ROOT, '..', '..', '..', 'docs', 'client-protocol.md');
const doc = readFileSync(DOC_PATH, 'utf8');

/**
 * 从文档的**表格行**里抽出消息名。
 *
 * 形状（§4.3 / §5 两张表）：`| 1 | \`room.match\` | \`{...}\` | ...`
 * 只认「行首是 `| 数字 |` + 反引号包住的消息名」这一种 —— 散文里的 `` `bot.move` `` 抓不到。
 * 消息名允许两段以上（如 `room.match.extend`）。
 */
function docMessageNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\|\s*\d+\s*\|\s*`([a-z]+(?:\.[a-z_]+)+)`/gm)) out.add(m[1]!);
  return out;
}

/**
 * 从文档的错误码表里抽出码值。
 *
 * 形状（§7）：`| \`13004\` | VERSION_CONFLICT | ... |`
 */
function docErrCodes(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/^\|\s*`(\d+)`\s*\|/gm)) out.add(Number(m[1]));
  return out;
}

/** 契约里的全部消息名（11 C→S + 11 S→C）。 */
const CONTRACT_MESSAGES = [...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES];
/** 契约里的全部错误码。 */
const CONTRACT_CODES = Object.values(ErrCode).filter((v): v is number => typeof v === 'number');

describe('① 正向：契约里的每一条都在文档里', () => {
  it(`消息名 ${CONTRACT_MESSAGES.length} 条，一条都不能漏`, () => {
    const missing = CONTRACT_MESSAGES.filter((t) => !doc.includes(t));
    expect(missing, `文档里找不到这些消息名（加了新消息要同步文档）：${missing.join('、')}`).toEqual(
      [],
    );
  });

  it(`错误码 ${CONTRACT_CODES.length} 个，一个都不能漏`, () => {
    const missing = CONTRACT_CODES.filter((c) => !new RegExp(`\\b${c}\\b`).test(doc));
    expect(missing, `文档里找不到这些错误码：${missing.join('、')}`).toEqual([]);
  });

  it('扫描器自证：文档真的被读到了（不是「文件为空所以恒绿」）', () => {
    expect(doc.length, '文档为空或读不到').toBeGreaterThan(2000);
    expect(doc).toContain('# 客户端接入协议清单');
  });
});

describe('② 反向：文档表格里的每一条都在契约里（防死条目）', () => {
  it('表格里列出的消息名，恰好等于契约集合', () => {
    const inDoc = [...docMessageNames(doc)].sort();
    const inContract = [...CONTRACT_MESSAGES].sort();
    expect(
      inDoc,
      '文档表格里的消息名与契约不一致 —— 多出来的多半是已删除的死条目',
    ).toEqual(inContract);
  });

  it('错误码表列出的码，恰好等于契约集合', () => {
    const inDoc = [...docErrCodes(doc)].sort((a, b) => a - b);
    const inContract = [...CONTRACT_CODES].sort((a, b) => a - b);
    expect(inDoc, '文档错误码表与契约不一致').toEqual(inContract);
  });
});

describe('③ 判别力自证：这两组断言真的会红（R115/R150）', () => {
  it('少一条消息 ⇒ 正向报出它', () => {
    const trimmed = doc.replace(/`game\.resync`/g, '`game.REMOVED`');
    const missing = CONTRACT_MESSAGES.filter((t) => !trimmed.includes(t));
    expect(missing, '合成样本必须被抓到').toEqual(['game.resync']);
  });

  it('多一条死消息 ⇒ 反向报出它', () => {
    const polluted = `${doc}\n| 9 | \`game.legacy_thing\` | \`{}\` | 已删除的旧条目 |\n`;
    expect([...docMessageNames(polluted)].sort()).not.toEqual([...CONTRACT_MESSAGES].sort());
    expect([...docMessageNames(polluted)]).toContain('game.legacy_thing');
  });

  it('少一个错误码 ⇒ 正向报出它', () => {
    const trimmed = doc.replace(/\b13010\b/g, '99999');
    const missing = CONTRACT_CODES.filter((c) => !new RegExp(`\\b${c}\\b`).test(trimmed));
    expect(missing).toEqual([13010]);
  });

  it('多一个死错误码 ⇒ 反向报出它', () => {
    const polluted = `${doc}\n| \`99999\` | LEGACY | 已删除 | \`ignore\` |\n`;
    expect([...docErrCodes(polluted)].sort((a, b) => a - b)).not.toEqual(
      [...CONTRACT_CODES].sort((a, b) => a - b),
    );
  });
});

describe('客户端消息清单与协议清单（记牌器收费片 C30）', () => {
  it('messageTypeList() 与 SERVER_MESSAGE_TYPES **按集合**相等（漏列 = 服务端照发、客户端静默收不到）', () => {
    const client = messageTypeList();
    // 正对照：清单非空、且确实读到了新类型（防「两边都空」的恒真）
    expect(client.length).toBeGreaterThan(0);
    expect(client).toContain('game.card_counter');
    expect(new Set(client)).toEqual(new Set(SERVER_MESSAGE_TYPES));
  });
});

/**
 * 等待提示的**动作名与展示形态**在文档里同步（2026-10-21 底部悬浮卡片片）。
 *
 * ⚠️ 只抓**表格行**，与既有对账闸同一口径；散文里的历史语义不参与。
 * ⚠️ 每条谓词都配旧行负样本，证明判据能抓住回归（R115/R150）。
 */
describe('等待提示：文档动作名与展示形态（C13）', () => {
  /**
   * 按**消息名列**选行（表格第二列）。
   * ⚠️ 不能按「行内包含消息名」选：`room.match.extend` 行会在散文里提到
   * `match.wait_prompt`（「收到 `match.wait_prompt` 后…」），会先命中 extend 行。
   */
  function docRow(text: string, name: string): string {
    const token = `\`${name}\``;
    const rows = text.split('\n').filter((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.trim().split('|');
      return cells[2]?.trim() === token;
    });
    expect(rows, `文档里的消息名列必须恰好有一行是 ${name}`).toHaveLength(1);
    return rows[0]!;
  }

  /** `match.wait_prompt` 行：动作名 + 底部悬浮卡片形态。 */
  function isUpdatedPromptRow(row: string): boolean {
    return (
      row.includes('继续等待') &&
      row.includes('悬浮卡片') &&
      !row.includes('延长匹配时间') &&
      !row.includes('弹窗')
    );
  }

  /** `room.match.extend` 行：只要求动作名同步（该行本来就不描述展示形态）。 */
  function isUpdatedExtendRow(row: string): boolean {
    return row.includes('继续等待') && !row.includes('延长匹配时间');
  }

  it('docs/client-protocol.md 两行已同步', () => {
    expect(isUpdatedPromptRow(docRow(doc, 'match.wait_prompt'))).toBe(true);
    expect(isUpdatedExtendRow(docRow(doc, 'room.match.extend'))).toBe(true);
  });

  it('docs/design.md 两行已同步', () => {
    const design = readFileSync(
      join(SRC_ROOT, '..', '..', '..', 'docs', 'design.md'),
      'utf8',
    );
    expect(isUpdatedPromptRow(docRow(design, 'match.wait_prompt'))).toBe(true);
    expect(isUpdatedExtendRow(docRow(design, 'room.match.extend'))).toBe(true);
  });

  it('判别力自证：旧行样本必须判负，且选行不串行', () => {
    const oldPrompt =
      '| 11 | `match.wait_prompt` | `{ message: string }` | 弹窗给「重新匹配」与「延长匹配时间」两操作 |';
    const oldExtend =
      '| 10 | `room.match.extend` | `{}` | 玩家点「延长匹配时间」时发 |';
    expect(isUpdatedPromptRow(oldPrompt)).toBe(false);
    expect(isUpdatedExtendRow(oldExtend)).toBe(false);

    // 选行自证：extend 行的散文里提到 wait_prompt，docRow 仍必须选中 wait_prompt 自己的行。
    const twoRows = [
      '| 10 | `room.match.extend` | `{}` | 收到 `match.wait_prompt` 后点「继续等待」 |',
      '| 11 | `match.wait_prompt` | `{ message: string }` | 底部悬浮卡片…继续等待… |',
    ].join('\n');
    expect(docRow(twoRows, 'match.wait_prompt')).toContain('| 11 |');
  });
});
