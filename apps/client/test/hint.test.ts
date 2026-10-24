import { describe, expect, it } from "vitest";
import type { Card, RecentAction } from "@fight-the-landlord/protocol";
import { HandType, parseHand } from "@fight-the-landlord/protocol";
import { buildBeatTarget, hasBeatablePlay, suggestPlays } from "../src/game/hint";

const c = (r: number, s = 0): Card => ({ r, s });

/** 用 protocol 解析一手牌作为跟牌目标（避免手写 type/keyRank 与规则漂移）。 */
const targetOf = (...cards: Card[]) => parseHand(cards);

describe("buildBeatTarget", () => {
  it("窗口全 null ⇒ null（首出）", () => {
    const actions: RecentAction[] = [
      { seat: 1, cards: null },
      { seat: 2, cards: null },
    ];
    expect(buildBeatTarget(actions, 0)).toBeNull();
  });

  it("最后一手是别人出的单张 ⇒ 取其牌型", () => {
    const actions: RecentAction[] = [
      { seat: 1, cards: null },
      { seat: 2, cards: [c(5)] },
    ];
    const t = buildBeatTarget(actions, 0);
    expect(t).not.toBeNull();
    expect(t!.type).toBe(HandType.Single);
    expect(t!.keyRank).toBe(5);
  });

  it("最后一手是我自己出的 ⇒ null（我又该首出）", () => {
    const actions: RecentAction[] = [
      { seat: 1, cards: [c(7)] },
      { seat: 0, cards: [c(8)] },
    ];
    expect(buildBeatTarget(actions, 0)).toBeNull();
  });

  it("空窗口 ⇒ null", () => {
    expect(buildBeatTarget([], 0)).toBeNull();
  });
});

describe("suggestPlays", () => {
  it("无 target ⇒ 返回所有合法出牌（含单张/对子/三张/炸弹/王炸/顺子）", () => {
    const hand = [
      c(3), c(3), c(4), c(5), c(6), c(7), c(8), // 顺子 3-8 + 一对3
      c(10), c(10), c(10), c(10), // 炸弹 10
      c(20), c(30), // 王炸
    ];
    const plays = suggestPlays(hand, null);
    // 至少有单张、对子、三张、炸弹、王炸、顺子
    const types = new Set(plays.map((p) => p.parsed.type));
    expect(types.has(HandType.Single)).toBe(true);
    expect(types.has(HandType.Pair)).toBe(true);
    expect(types.has(HandType.Trio)).toBe(true);
    expect(types.has(HandType.Bomb)).toBe(true);
    expect(types.has(HandType.Rocket)).toBe(true);
    // 顺子 3-8（6 张）
    const straights = plays.filter((p) => p.parsed.type === HandType.Straight);
    expect(straights.length).toBeGreaterThan(0);
  });

  it("上家出单张 5 ⇒ 只返回能压过 5 的单张/炸弹/王炸", () => {
    const hand = [c(3), c(4), c(6), c(7), c(10), c(10), c(10), c(10), c(20), c(30)];
    const target = { type: HandType.Single, keyRank: 5, length: 1 };
    const plays = suggestPlays(hand, target);
    // 所有返回的都必须能压过 5
    for (const p of plays) {
      expect(p.parsed.type === HandType.Single ? p.parsed.keyRank > 5 : true).toBe(true);
      expect(p.parsed.keyRank > 5 || p.parsed.type === HandType.Bomb || p.parsed.type === HandType.Rocket).toBe(true);
    }
    // 单张 3、4 不应出现
    const singles = plays.filter((p) => p.parsed.type === HandType.Single).map((p) => p.parsed.keyRank);
    expect(singles).not.toContain(3);
    expect(singles).not.toContain(4);
    expect(singles).toContain(6);
    expect(singles).toContain(7);
  });

  it("上家出对子 7 ⇒ 返回压过的对子/炸弹/王炸，不返回单张", () => {
    const hand = [c(5), c(5), c(8), c(8), c(10), c(10), c(10), c(10)];
    const target = { type: HandType.Pair, keyRank: 7, length: 2 };
    const plays = suggestPlays(hand, target);
    const types = new Set(plays.map((p) => p.parsed.type));
    expect(types.has(HandType.Single)).toBe(false);
    expect(types.has(HandType.Pair)).toBe(true);
    // 对 5 压不过 7，不应出现
    const pairs = plays.filter((p) => p.parsed.type === HandType.Pair).map((p) => p.parsed.keyRank);
    expect(pairs).not.toContain(5);
    expect(pairs).toContain(8);
  });

  it("无牌可压 ⇒ 空数组（不返回非法候选）", () => {
    const hand = [c(3), c(3)]; // 只有对 3
    const target = { type: HandType.Pair, keyRank: 10, length: 2 };
    const plays = suggestPlays(hand, target);
    expect(plays).toEqual([]);
  });

  it("排序：同型按 keyRank 升序，炸弹在同型之后，王炸最后", () => {
    const hand = [c(6), c(7), c(8), c(9), c(10), c(10), c(10), c(10), c(20), c(30)];
    const target = { type: HandType.Single, keyRank: 5, length: 1 };
    const plays = suggestPlays(hand, target);
    expect(plays.length).toBeGreaterThan(0);
    const firstRocket = plays.findIndex((p) => p.parsed.type === HandType.Rocket);
    const firstBomb = plays.findIndex((p) => p.parsed.type === HandType.Bomb);
    const firstSingle = plays.findIndex((p) => p.parsed.type === HandType.Single);
    expect(firstSingle).toBeLessThan(firstBomb);
    expect(firstBomb).toBeLessThan(firstRocket);
  });

  it("性能：20 张手牌 < 5ms", () => {
    const hand: Card[] = [];
    for (let r = 3; r <= 15; r++) {
      for (let s = 0; s < 4; s++) hand.push(c(r, s));
    }
    hand.push(c(20), c(30)); // 20 张（实际 14*4+2 = 58，取前 20）
    const h20 = hand.slice(0, 20);
    const target = { type: HandType.Single, keyRank: 5, length: 1 };
    const t0 = performance.now();
    suggestPlays(h20, target);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(5);
  });
});

describe("hasBeatablePlay（穷尽型存在性判定）", () => {
  it("target 为 null（我首出）⇒ true（按钮永远全显）", () => {
    expect(hasBeatablePlay([c(3)], null)).toBe(true);
  });

  it("单张：同型更大可压、更小不可压；王/2 按点数比", () => {
    const t5 = targetOf(c(5));
    expect(hasBeatablePlay([c(3), c(4)], t5)).toBe(false);
    expect(hasBeatablePlay([c(6)], t5)).toBe(true);
    expect(hasBeatablePlay([c(30)], targetOf(c(20)))).toBe(true); // 大王压小王
    expect(hasBeatablePlay([c(17)], targetOf(c(14)))).toBe(true); // 2 压 A
  });

  it("对子：更大的对可压；单张/小对不可压", () => {
    const t = targetOf(c(10), c(10));
    expect(hasBeatablePlay([c(5), c(5)], t)).toBe(false);
    expect(hasBeatablePlay([c(11), c(11)], t)).toBe(true);
    expect(hasBeatablePlay([c(14)], t)).toBe(false); // 单张 A 压不了对子
  });

  it("三张：更大的三张可压", () => {
    const t = targetOf(c(10), c(10), c(10));
    expect(hasBeatablePlay([c(9), c(9), c(9)], t)).toBe(false);
    expect(hasBeatablePlay([c(11), c(11), c(11)], t)).toBe(true);
  });

  it("三带一：三张主体 + 一张异点翅膀；光三张不算", () => {
    const t = targetOf(c(5), c(5), c(5), c(3));
    expect(hasBeatablePlay([c(6), c(6), c(6), c(7)], t)).toBe(true);
    expect(hasBeatablePlay([c(6), c(6), c(6)], t)).toBe(false); // 缺翅膀
    expect(
      hasBeatablePlay([c(3), c(3), c(3), c(17)], t),
      "主体 333 小过 555，2 当单翼也救不了",
    ).toBe(false);
  });

  it("三带二：三张主体 + 一对异点翅膀（对翼可从三张里取两张）", () => {
    const t = targetOf(c(5), c(5), c(5), c(3), c(3));
    expect(hasBeatablePlay([c(6), c(6), c(6), c(7), c(7)], t)).toBe(true);
    expect(hasBeatablePlay([c(6), c(6), c(6), c(7), c(8)], t)).toBe(false); // 两只单张不是对翼
    expect(hasBeatablePlay([c(6), c(6), c(6), c(7), c(7), c(7)], t)).toBe(true); // 777 里取一对
  });

  it("suggestPlays 的枚举盲区（更大的三带一）不得被误判为要不起", () => {
    const t = targetOf(c(3), c(3), c(3), c(4));
    const hand = [c(5), c(5), c(5), c(6)];
    // 旧枚举器只覆盖单/对/三/炸弹/王炸/顺子 ⇒ 它给不出候选
    expect(suggestPlays(hand, t)).toEqual([]);
    // 穷尽判定必须认出 555+6 能压
    expect(hasBeatablePlay(hand, t)).toBe(true);
  });

  it("顺子：等长且起点更大才可压；持更长顺可取等长子集", () => {
    const t = targetOf(c(3), c(4), c(5), c(6), c(7)); // 3-7，长 5
    expect(hasBeatablePlay([c(4), c(5), c(6), c(7), c(8)], t)).toBe(true);
    expect(hasBeatablePlay([c(3), c(4), c(5), c(6), c(7)], t)).toBe(false); // 等大
    expect(hasBeatablePlay([c(4), c(5), c(6), c(7)], t)).toBe(false); // 不够长
    expect(
      hasBeatablePlay([c(3), c(4), c(5), c(6), c(7), c(8)], t),
      "6 张连牌里能取等长 5 张子集 4-8（起点更大）⇒ 压得过",
    ).toBe(true);
  });

  it("连对：等长连续对子；持更多连对可取等长子集", () => {
    const t = targetOf(c(3), c(3), c(4), c(4), c(5), c(5)); // 334455
    expect(hasBeatablePlay([c(4), c(4), c(5), c(5), c(6), c(6)], t)).toBe(true);
    expect(hasBeatablePlay([c(3), c(3), c(4), c(4), c(5), c(5)], t)).toBe(false);
    expect(hasBeatablePlay([c(4), c(4), c(5), c(5)], t)).toBe(false); // 只有两对
    expect(
      hasBeatablePlay([c(3), c(3), c(4), c(4), c(5), c(5), c(6), c(6)], t),
      "四连对里能取 445566 三子集 ⇒ 压得过",
    ).toBe(true);
  });

  it("飞机（裸）：等长连续三张；持更长飞机可取等长子集", () => {
    const t = targetOf(c(3), c(3), c(3), c(4), c(4), c(4));
    expect(hasBeatablePlay([c(5), c(5), c(5), c(6), c(6), c(6)], t)).toBe(true);
    expect(hasBeatablePlay([c(3), c(3), c(3), c(4), c(4), c(4)], t)).toBe(false);
    expect(
      hasBeatablePlay([c(5), c(5), c(5), c(6), c(6), c(6), c(7), c(7), c(7)], t),
      "三节飞机里能取 555666 两节子集 ⇒ 压得过",
    ).toBe(true);
  });

  it("飞机带单：主体 + 等量翅膀；单翼可含 2/王，对子可当两张单翼，缺翼不行", () => {
    const t = targetOf(c(3), c(3), c(3), c(4), c(4), c(4), c(5), c(6));
    expect(hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9), c(10)], t)).toBe(true);
    expect(hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9)], t)).toBe(false); // 缺一翼
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9), c(9)], t),
      "同点两张可以当两张单翼（对齐 DouZero 生成器）",
    ).toBe(true);
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(17), c(20)], t),
      "2 与小王可当单翼",
    ).toBe(true);
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(7), c(8), c(8), c(8), c(9)], t),
      "四张三想留一张当单翼：与主体重点数，不算异点翅膀（但炸弹本身可越级 ⇒ 仍 true）",
    ).toBe(true);
  });

  it("飞机带单：4 三张特判（非连续的第 4 组三张当翅膀）", () => {
    const t = targetOf(
      c(3), c(3), c(3), c(4), c(4), c(4), c(5), c(5), c(5),
      c(6), c(7), c(8),
    );
    expect(
      hasBeatablePlay(
        [c(4), c(4), c(4), c(5), c(5), c(5), c(6), c(6), c(6), c(9), c(9), c(9)],
        t,
      ),
      "444555666 + 999 是合法的飞机带单（特判）",
    ).toBe(true);
  });

  it("飞机带单：4 组三张全连续时不能当长度 3 的飞机带单", () => {
    const t = targetOf(
      c(3), c(3), c(3), c(4), c(4), c(4), c(5), c(5), c(5),
      c(6), c(7), c(8),
    );
    expect(
      hasBeatablePlay(
        [c(4), c(4), c(4), c(5), c(5), c(5), c(6), c(6), c(6), c(7), c(7), c(7)],
        t,
      ),
      "444555666777 会被解析成裸飞机（长度 4），压不过长度 3 的飞机带单",
    ).toBe(false);
  });

  it("飞机带对：主体 + 等量互异对翼（对翼可从三张里取两张，2 的对也行）", () => {
    const t = targetOf(
      c(3), c(3), c(3), c(4), c(4), c(4),
      c(5), c(5), c(6), c(6),
    );
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9), c(9), c(10), c(10)], t),
    ).toBe(true);
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9), c(9), c(9), c(10), c(10)], t),
      "对翼 99 从 999 里取两张",
    ).toBe(true);
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9), c(9)], t),
      "只有一对翅膀",
    ).toBe(false);
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(17), c(17), c(9), c(9)], t),
      "对 2 可当对翼（对翼不进连续主体，不受 2 不入顺限制）",
    ).toBe(true);
  });

  it("炸弹越级：压一切非炸弹；炸弹比炸弹看点数", () => {
    expect(hasBeatablePlay([c(3), c(3), c(3), c(3)], targetOf(c(14)))).toBe(true);
    expect(
      hasBeatablePlay([c(3), c(3), c(3), c(3)], targetOf(c(14), c(14))),
    ).toBe(true);
    const bomb10 = targetOf(c(10), c(10), c(10), c(10));
    expect(hasBeatablePlay([c(9), c(9), c(9), c(9)], bomb10)).toBe(false);
    expect(hasBeatablePlay([c(11), c(11), c(11), c(11)], bomb10)).toBe(true);
  });

  it("王炸越级：压一切；非王炸压不了王炸", () => {
    const rocket = [c(20), c(30)];
    expect(hasBeatablePlay(rocket, targetOf(c(14), c(14), c(14), c(14)))).toBe(true);
    expect(
      hasBeatablePlay([c(3), c(3), c(3), c(3)], targetOf(c(20), c(30))),
      "炸弹压不了王炸",
    ).toBe(false);
    // 单副牌只有一副王炸，「王炸压王炸」是不可达状态；判定一律委托 canBeat
    //（协议当前裁定为 true，方向也是保守的「显示按钮」），客户端不另写规则。
    expect(hasBeatablePlay(rocket, targetOf(c(20), c(30)))).toBe(true);
  });

  it("四带二：四张主体 + 两张异点单翼或一对异点翅膀；主体本身即炸弹可越级", () => {
    const t = targetOf(c(5), c(5), c(5), c(5), c(7), c(8));
    expect(hasBeatablePlay([c(6), c(6), c(6), c(6), c(9), c(10)], t)).toBe(true);
    expect(hasBeatablePlay([c(6), c(6), c(6), c(6), c(9), c(9)], t)).toBe(true); // 一对翅膀
    expect(
      hasBeatablePlay([c(6), c(6), c(6), c(6)], t),
      "光 6666 也是炸弹 ⇒ 越级压过四带二（翅膀凑不齐照样能压）",
    ).toBe(true);
    expect(
      hasBeatablePlay([c(9), c(9), c(9), c(9), c(20), c(30)], t),
      "双王当两张异点单翼（炸弹 9999 同样越级）",
    ).toBe(true);
    // 无炸弹无王炸才是确凿的「压不过」
    expect(hasBeatablePlay([c(3), c(3), c(4), c(4), c(5), c(5)], t)).toBe(false);
  });

  it("四带两对：四张主体 + 两对互异异点翅膀（对翼可从三张取两张）", () => {
    const t = targetOf(
      c(3), c(3), c(3), c(3),
      c(5), c(5), c(6), c(6),
    );
    expect(
      hasBeatablePlay([c(4), c(4), c(4), c(4), c(7), c(7), c(8), c(8)], t),
    ).toBe(true);
    expect(
      hasBeatablePlay([c(4), c(4), c(4), c(4), c(7), c(7), c(7), c(8), c(8)], t),
    ).toBe(true); // 对翼 77 从 777 取
    expect(
      hasBeatablePlay([c(4), c(4), c(4), c(4), c(7), c(7)], t),
      "只有一对翅膀，但 4444 本身是炸弹 ⇒ 越级可压",
    ).toBe(true);
    // 手里没有任何四张同点、也没有王炸 ⇒ 同型与越级都不存在
    expect(
      hasBeatablePlay([c(5), c(5), c(5), c(6), c(6), c(6), c(7), c(7), c(8), c(8)], t),
    ).toBe(false);
  });

  it("保守性：枚举盲区（Invalid / 异常长度）一律放行 true，绝不误杀", () => {
    expect(
      hasBeatablePlay([c(3)], { type: HandType.Invalid, keyRank: 0, length: 0 }),
    ).toBe(true);
    expect(
      hasBeatablePlay([c(3), c(4), c(5), c(6)], {
        type: HandType.Straight,
        keyRank: 3,
        length: 4, // parseHand 不可能产出长 4 的顺子
      }),
    ).toBe(true);
    expect(
      hasBeatablePlay([c(3)], { type: HandType.Plane, keyRank: 3, length: 1 }),
    ).toBe(true);
  });
});
