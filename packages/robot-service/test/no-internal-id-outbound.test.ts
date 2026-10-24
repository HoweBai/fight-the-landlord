/**
 * §9.8 / R211② 的**源码级机械闸**：robot-service 的**出站标识**不得以 `bot` 为前缀。
 *
 * §9.1-1 的不可区分性是**硬约束**：任何下发给客户端的消息里，机器人的 id 必须与人类同构
 * （`p_<8位>`），不得出现 `bot` 前缀、`isRobot`、`botId`、`skillLevel`。
 * 运行时那半边由 `slice-07.2-hardening` 第 4 步与 conformance `slice-11` 第 4 组端到端覆盖；
 * 这里钉住**源码形状**，否则下一个人可以随手把 `displayId` 改回 `bot-<uuid>`
 * 而所有单测仍然绿（`displayId` 的正则断言只在池的用例里，改生成式就会红 —— 但那条闸
 * 在 robot.pool.test.ts，本文件是它的**机械复本**，覆盖「生成式被绕开」的形态）。
 *
 * ⚠️ R212①：必须有**正负对照**，否则「没命中」可能只是正则写瞎了。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf-8');

/**
 * 探针：是否存在「把 `bot` 前缀的 id 当作**对外** id」的形态。
 * 正例 = `displayId: \`bot-…\`` / `userId = botId`（把内部 id 直接当对外 id 用）。
 */
const LEAKY_ASSIGNMENT = /(displayId\s*[:=]\s*[`'"][^`'"]*\bbot|userId\s*[:=]\s*botId\b|seatUserId\s*[:=]\s*botId\b)/;

describe('§9.8 / R211②：robot-service 不得产出 bot 前缀的对外 id', () => {
  it('正对照：探针能看见「displayId 用 bot- 前缀」这个形态', () => {
    expect(LEAKY_ASSIGNMENT.test('displayId: `bot-${hex}`,')).toBe(true);
    expect(LEAKY_ASSIGNMENT.test('const userId = botId;')).toBe(true);
    // 负对照：本片的正确形态不得被误判
    expect(LEAKY_ASSIGNMENT.test('displayId: `p_${hex.substring(8, 16)}`,')).toBe(false);
  });

  it('robot.pool.ts 的 displayId 生成式是 `p_…`，不是 `bot-…`', () => {
    const src = read('robot/robot.pool.ts');
    expect(LEAKY_ASSIGNMENT.test(src)).toBe(false);
    // 生成式本身必须是 `p_` 前缀（否则「不是 bot-」也可能只是换了个别的前缀）
    expect(src).toMatch(/displayId:\s*`p_\$\{/);
  });

  it('bot.player.ts / robot.service.ts 不把内部 botId 当对外 id 用', () => {
    for (const rel of ['robot/bot.player.ts', 'robot/robot.service.ts']) {
      expect(LEAKY_ASSIGNMENT.test(read(rel)), `${rel} 把内部 id 当对外 id 用了`).toBe(false);
    }
  });
});
