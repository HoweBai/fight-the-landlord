// packages/robot-service/test/douzero.client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DouZeroClient } from '../src/robot/douzero.client';

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

/** 取出发给 DouZero 的请求体（解出 JSON）。 */
const bodyOf = (mockFetch: any) => JSON.parse(mockFetch.mock.calls[0][1].body);

/** 一个最小可用的上下文；各用例只覆盖自己要考的那一格。 */
const ctx = (over: Partial<Parameters<DouZeroClient['getMove']>[0]> = {}) => ({
  model: 'douzero_WP' as const,
  position: 'landlord' as const,
  hand: [3, 5, 7],
  bottomCards: [],
  lastMove: [],
  lastMovePosition: '',
  numCardsLeft: {},
  playedCards: {},
  actionSeq: [],
  ...over,
});

const okFetch = () => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ action: [3] }),
  });
  global.fetch = mockFetch as any;
  return mockFetch;
};

describe('DouZeroClient', () => {
  it('returns action from DouZero API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ action: [1, 2, 3] }),
    });
    global.fetch = mockFetch as any;

    const client = new DouZeroClient();
    const result = await client.getMove({
      model: 'sl',
      position: 'landlord',
      hand: [1, 2, 3],
      bottomCards: [4, 5],
      lastMove: [],
      lastMovePosition: '',
      numCardsLeft: {},
      playedCards: {},
      actionSeq: [],
    });

    expect(result).toEqual([1, 2, 3]);
    // 片② J1 修点 1：**出站字节**必须逐字带回我方给的 model。区分度：另两处 ctx
    // （`ctx()` 助手 / 非 200 用例）都是 `'douzero_WP'`，这里专挑 `'sl'` ——
    // 实现若把 model 硬编码（忽略 `context.model`），仅本行必红。
    expect(bodyOf(mockFetch).model).toBe('sl');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/decide_play'),
      expect.any(Object)
    );
  });

  /**
   * 🔴 判据（2026-09-29 补，源自一个真缺陷）：
   * **`must_play` 必须被发送，且取值正确。**
   *
   * 背景：`DouZeroRequestBody.must_play` 声明了却**从不赋值** ⇒ `server.py` 的
   * `data.get("must_play", True)` 恒取 **`True`** ⇒ DouZero 每一次调用都被当作
   * **「自由首出」**（`rival_move=[]` ⇒ 合法集 = 手里的**所有**牌，且 **`[]` 不在其中**）：
   *   ① 它**结构上永远无法过牌**（`gen_moves()` 只产非空动作）——
   *      而 `bot.player.ts` 里「DouZero 空数组 = 明确 pass 意图」那段处理因此是**死代码**；
   *   ② 跟牌时它会从「手里所有牌」里挑价值最高的一手 ⇒ 可能**根本压不上一手** ⇒
   *      被 game-service 当场拒（`Invalid move - cannot beat last hand`）⇒ **静默降级成规则引擎**。
   *       实测（近 24h）：`Robot action rejected` **93** / `Robot p_*. applied` **1278** ≈ **6.8%**。
   *   ⇒ advanced 机器人因此频繁表现得与规则机器人一样笨。
   *
   * 取值依据（**不是猜的**）：`shared` 的 `handlePass` 在**两家连续过牌**时把 `lastPlayedHand`
   * 置 `null`（`play.ts:157`，牌权回到最后出牌者）⇒
   * 「`lastMove` 为空」⟺「首出 / 牌权回手，不得过牌」⟺ `must_play = true`。
   */
  it('🔴 首出（lastMove 为空）⇒ must_play = true', async () => {
    const mockFetch = okFetch();
    await new DouZeroClient().getMove(ctx({ lastMove: [] }));
    expect(bodyOf(mockFetch).must_play).toBe(true);
  });

  it('🔴 跟牌（lastMove 非空）⇒ must_play = false（否则 DouZero 永远无法过牌）', async () => {
    const mockFetch = okFetch();
    await new DouZeroClient().getMove(ctx({ lastMove: [9], lastMovePosition: 'landlord_up' }));
    expect(bodyOf(mockFetch).must_play).toBe(false);
  });

  /**
   * 🔴 看门狗判据（同类缺陷的通用形态）：
   * 请求体里**不得出现 `undefined`** —— 契约字段（README 的 API 示例逐字列了它们）
   * 必须**真的被赋值**。「声明了却没填」正是 `must_play` 这条缺陷的形态，
   * 而它对类型系统是合法的（字段是可选的）⇒ 只能靠这条守住。
   */
  it('🔴 请求体不得含 undefined 字段（契约字段必须全部真被赋值）', async () => {
    const mockFetch = okFetch();
    await new DouZeroClient().getMove(ctx({ lastMove: [9], lastMovePosition: 'landlord_up' }));
    const body = bodyOf(mockFetch);
    expect(Object.entries(body).filter(([, v]) => v === undefined)).toEqual([]);
    // 契约字段清单（douzero/README.md 的 API 示例）
    for (const key of [
      'model',
      'position',
      'hand',
      'bottom_cards',
      'last_move',
      'last_move_position',
      'num_cards_left',
      'played_cards_landlord',
      'played_cards_landlord_down',
      'played_cards_landlord_up',
      'card_play_action_seq',
      'must_play',
    ]) {
      expect(body).toHaveProperty(key);
    }
  });

  it('throws on API error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('boom'), // 片② D7：非 200 要先读 body 再抛
    });
    global.fetch = mockFetch as any;

    const client = new DouZeroClient();
    await expect(
      client.getMove({
        model: 'douzero_WP',
        position: 'landlord',
        hand: [1, 2, 3],
        bottomCards: [],
        lastMove: [],
        lastMovePosition: '',
        numCardsLeft: {},
        playedCards: {},
        actionSeq: [],
      })
    // 片② D7 修点 2：detail（替身 `text()` 回来的 `'boom'`）**必须进消息**。
    // 只断言前缀 `'DouZero HTTP 500'` 时，实现里去掉 `${detail}` 也照样绿（空转）——
    // 本正则要求状态码与 detail **同现**，才真正钉住「先读 body 再抛」。
    ).rejects.toThrow(/DouZero HTTP 500[\s\S]*boom/);
  });
});
