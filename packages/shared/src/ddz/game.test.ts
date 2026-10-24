import { describe, it, expect } from 'vitest';
import { compareCards, createSession, dealCards } from './game';
import { GameState } from './types';

describe('createSession', () => {
  it('creates a session with correct state', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    expect(session.roomCode).toBe('ROOM1');
    expect(session.state).toBe(GameState.Init);
    expect(session.players).toHaveLength(3);
    expect(session.players[0].id).toBe('user-1');
    expect(session.players[1].seat).toBe(1);
    expect(session.players[2].hand).toEqual([]);
    expect(session.version).toBe(0);
  });

  it('does not mutate input', () => {
    const session1 = createSession('ROOM1', ['a', 'b', 'c']);
    const session2 = createSession('ROOM2', ['x', 'y', 'z']);
    expect(session1.roomCode).toBe('ROOM1');
    expect(session2.roomCode).toBe('ROOM2');
  });
});

describe('dealCards', () => {
  it('deals 17 cards to each player', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);

    expect(dealt.state).toBe(GameState.Bidding);
    expect(dealt.players[0].hand).toHaveLength(17);
    expect(dealt.players[1].hand).toHaveLength(17);
    expect(dealt.players[2].hand).toHaveLength(17);
    expect(dealt.bottomCards).toHaveLength(3);
    // §3.2：`deck` 字段必须**不存在**（发牌后牌堆为空，保留它只会误导）—— 不是「为空数组」
    expect('deck' in dealt).toBe(false);
  });

  it('does not mutate input session', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);

    expect(session.state).toBe(GameState.Init);
    expect(session.players[0].hand).toEqual([]);
    expect(dealt.state).toBe(GameState.Bidding);
    expect(dealt.players[0].hand).toHaveLength(17);
  });

  it('hands are sorted', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);

    for (const player of dealt.players) {
      // R696：手牌是 `Card[]`，排序的**唯一实现**是 `compareCards`（先 `r` 再 `s`）。
      // 直接断言「等于它自己排过一遍的结果」比逐个比大小更强 —— 后者会漏掉花色维度。
      expect(player.hand).toEqual([...player.hand].sort(compareCards));
    }
  });

  it('bottom cards are 3', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    expect(dealt.bottomCards).toHaveLength(3);
  });
});

describe('initialHands 发牌快照（记录片 T2 / C2）', () => {
  it('dealCards 后恰 17×3，且与当次 hands 的排序后副本一致', () => {
    const dealt = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));

    expect(dealt.initialHands).toHaveLength(3);
    for (let seat = 0; seat < 3; seat++) {
      expect(dealt.initialHands![seat]).toHaveLength(17);
      // 「排序后一致」：hands 已按 compareCards 规范排序，快照应与排序结果逐张相等
      expect(dealt.initialHands![seat]).toEqual(
        [...dealt.players[seat]!.hand].sort(compareCards),
      );
    }
  });

  it('冻结副本：对 hands 做 splice/sort 后快照不变（非共享引用）', () => {
    const dealt = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));
    const frozen = dealt.initialHands!.map((hand) => [...hand]);

    // 模拟后续状态转移对 hand 的破坏：出牌 splice 摘除 + 底牌并入后的重排序
    dealt.players[0]!.hand.splice(0, 5);
    dealt.players[1]!.hand.push(...dealt.bottomCards);
    dealt.players[1]!.hand.sort((a, b) => b.r - a.r || b.s - a.s);
    dealt.players[2]!.hand.length = 0;

    expect(dealt.initialHands).toEqual(frozen);
    expect(dealt.initialHands![0]).toHaveLength(17);
    // 反向证明：快照与 hand 是**不同的数组**（共享引用时上面的 toEqual 已经会红）
    for (let seat = 0; seat < 3; seat++) {
      expect(dealt.initialHands![seat]).not.toBe(dealt.players[seat]!.hand);
    }
  });

  it('流局重发（再次 dealCards）⇒ 快照 = 新发牌，旧快照不留', () => {
    const first = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));
    // 第一轮中途：出牌摘牌；再破坏旧快照 —— 若重发「沿用已存在的快照」而不覆盖，下面必红
    first.players[0]!.hand.splice(0, 5);
    first.initialHands![0]!.length = 0;
    first.initialHands![1]!.splice(0, 17);

    // 流局重发路径 = `bid.ts` resetBidding 的再次 dealCards（同一会话上重新发牌）
    const second = dealCards(first);

    expect(second.initialHands![0]).toHaveLength(17);
    expect(second.initialHands![1]).toHaveLength(17);
    expect(second.initialHands).toEqual(
      second.players.map((p) => [...p.hand].sort(compareCards)),
    );
    for (let seat = 0; seat < 3; seat++) {
      expect(second.initialHands![seat]).not.toBe(first.initialHands![seat]);
    }
  });
});

describe('createSession 的随机起始座位（片① R1）', () => {
  it('传 () => 0 ⇒ 座位 0 先叫', () => {
    const s = dealCards(createSession('R', ['u0', 'u1', 'u2'], () => 0));
    expect(s.bidPhase.currentBidder).toBe(0);
  });

  it('传 () => 0.9 ⇒ 座位 2 先叫（不是恒 0）', () => {
    const s = dealCards(createSession('R', ['u0', 'u1', 'u2'], () => 0.9));
    expect(s.bidPhase.currentBidder).toBe(2);
  });

  it('新会话的两个新字段有确定初值', () => {
    const s = createSession('R', ['u0', 'u1', 'u2'], () => 0);
    expect(s.bidPhase.firstCaller).toBe(-1);
    expect(s.bidPhase.antiRobGranted).toBe(false);
  });
});
