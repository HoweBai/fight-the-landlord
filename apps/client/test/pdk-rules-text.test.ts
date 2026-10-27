import { describe, it, expect } from 'vitest';
import { GAME_META } from '@fight-the-landlord/protocol';
import { GAME_MODES } from '../src/gameModes';

/**
 * 审查 P0-4：大厅跑得快规则文案必须是跑得快，不是斗地主。
 *
 * 复用 `lobby.vue:769-802` 的解析假设（`\n\n` 分段、首行 `【标题】`、`·` 列表），
 * 避免裸 substring 断言穿过解析器的丢弃逻辑造成假绿。
 */
interface Section {
  title: string;
  lines: string[];
}

function parseSections(desc: string): Section[] {
  const out: Section[] = [];
  for (const raw of desc.split(/\n\n+/)) {
    const lines = raw.split('\n').map((l) => l.trim());
    const title = lines[0]?.match(/^【(.+?)】$/)?.[1];
    if (!title) continue;
    out.push({ title, lines: lines.slice(1).filter(Boolean) });
  }
  return out;
}

describe('跑得快大厅规则文案（审查 P0-4）', () => {
  const pdk = GAME_MODES.find((m) => m.id === GAME_META.paodekuai.id)!;

  it('包含四段结构化规则，每段非空', () => {
    expect(pdk.description, '跑得快必须有规则介绍').toBeTruthy();
    const sections = parseSections(pdk.description!);
    const titles = sections.map((s) => s.title);
    expect(titles).toEqual(['基本规则', '牌型与比较', '计分', '超时与托管']);
    for (const section of sections) {
      expect(section.lines.length, `【${section.title}】不得为空`).toBeGreaterThan(0);
    }
    // 列表段确实被解析成 `·` 项
    const bulletSections = sections.filter((s) =>
      s.lines.some((line) => line.startsWith('·')),
    );
    expect(bulletSections.map((s) => s.title)).toEqual([
      '基本规则',
      '牌型与比较',
      '计分',
      '超时与托管',
    ]);
  });

  it('覆盖跑得快真实规则要点', () => {
    const text = pdk.description!;
    for (const keyword of [
      '红桃 3',
      '48 张',
      '12 张',
      '保本',
      '关牌',
      '春天',
      '连对',
      '炸弹',
    ]) {
      expect(text, `缺少规则要点：${keyword}`).toContain(keyword);
    }
  });

  it('不得出现斗地主概念', () => {
    const text = pdk.description!;
    for (const forbidden of ['王炸', '地主', '叫抢', '大王 > 小王', '每人 16 张']) {
      expect(text, `不得出现斗地主概念：${forbidden}`).not.toContain(forbidden);
    }
  });
});
