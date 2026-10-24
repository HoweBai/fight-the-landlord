import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * S4（§9.5）的**机械闸**：robot-service 不得再有「接收整份 `GameSession`」的入口。
 * 端到端 404 由 conformance（直连 3005）覆盖；这里钉住的是**源码形状**
 * （否则下一个人可以随手把路由加回来，而单测全绿）。
 *
 * 本片（切片 11 / R205）把这条闸**收紧**了：
 *  - 旧的正对照是「`bot.player.ts` 仍然 import `GameSession`」——那在切片 11 之后**必然**消失，
 *    因此正对照改成**合成样本**（R212①：源码级闸必须自带探针判别力，且不得依赖「待删的旧代码」）；
 *  - 新增「伪造特征函数不得复活」的机械断言（C7/C8：`computePlayedCards` /
 *    `computeActionSeq` / `getAllCards` 三个启发式/硬编码函数已删除）。
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf-8');

/**
 * 「接收整份会话」的两种源码形态：import 它，或把参数标注成它。
 *
 * ⚠️ `SESSION_IMPORT` **不能**写成 `/import[\s\S]*?GameSession/`：`[\s\S]*?` 会跨过语句边界，
 * 于是**注释里提到 `GameSession`** 也会被判成「import 了它」（实测误报）。用 `[^;]*` 把匹配
 * 限制在**同一条 import 语句**内。
 */
const SESSION_IMPORT = /import[^;]*GameSession/;
const SESSION_PARAM = /:\s*GameSession\b/;

describe('S4：robot-service 不得接收整份 GameSession（R135/§9.5）', () => {
  it('正对照：探针能看见「import 整份会话」与「参数标注整份会话」两种形态', () => {
    // 探针判别力（R212①）：若下面的负断言全绿只是因为正则写瞎了，这两条会当场红。
    expect(SESSION_IMPORT.test("import { GameSession } from '@fight-the-landlord/shared';")).toBe(true);
    expect(SESSION_PARAM.test('async decideMove(session: GameSession, playerId: string)')).toBe(true);
    // 负对照：切片 11 之后的真实形态（`view` + `features`）不得被误判
    expect(SESSION_IMPORT.test("import type { PlayerView, RobotDecideRequest } from '@x';")).toBe(false);
    expect(SESSION_PARAM.test('async decideMove(req: RobotDecideRequest)')).toBe(false);
  });

  it('bot.player.ts 只吃 `view` + `features`（不 import、也不标注 GameSession）', () => {
    const src = read('robot/bot.player.ts');
    expect(SESSION_IMPORT.test(src)).toBe(false);
    expect(SESSION_PARAM.test(src)).toBe(false);
  });

  it('bot.player.ts 的伪造特征函数不得复活（C7/C8）', () => {
    const src = read('robot/bot.player.ts');
    for (const dead of ['computePlayedCards', 'computeActionSeq', 'getAllCards']) {
      expect(src, `${dead} 是切片 11 删除的伪造实现，不得复活`).not.toContain(dead);
    }
  });

  it('robot.controller.ts 没有 move 路由，也不出现 session', () => {
    const src = read('robot/robot.controller.ts');
    expect(src).not.toMatch(/@Post\(\s*'move'/);
    expect(src).not.toMatch(/\bsession\b/);
  });

  it('robot.service.ts 没有 getBotMove，也不 import/标注 GameSession', () => {
    const src = read('robot/robot.service.ts');
    expect(src).not.toContain('getBotMove');
    expect(SESSION_IMPORT.test(src)).toBe(false);
    expect(SESSION_PARAM.test(src)).toBe(false);
  });
});
