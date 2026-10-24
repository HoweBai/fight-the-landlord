/**
 * §9 机器人契约的**边界判据**（设计 §9.5/§9.8 + §4.2 的永不出站字段）。
 *
 * 这些类型是**服务间**契约：它们既不是 S→C 消息，也不允许任何内部字段混进出站载荷。
 * 本文件把这两条写成机械判据 —— 只靠「文档里写了」是不够的（切片 7.2 的教训）。
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_OUTBOUND_KEYS, assertNoLeak, validateOutbound } from './validate';
import { SERVER_MESSAGE_TYPES } from './messages';
import type { BotInstance, RobotDecideRequest } from './robot';
import type { Card, PlayerView } from './views';

/** R696 之后牌是 `{r, s}`，夹具用这个构造。默认黑桃（`s = 0`）。 */
const c = (r: number, s = 0): Card => ({ r, s });

/** 一个合法的裁剪视图（只用作出站载荷的底座）。 */
function view(): PlayerView {
  return {
    roomCode: 'ROOM1',
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: [c(3), c(4), c(5)],
    cardCounts: [3, 17, 17],
    trustees: [false, false, false],
    bottomCards: [c(6), c(7), c(8)],
    landlordSeat: null,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 1,
      landlordCandidate: -1,
      grabActions: 0,
      redealCount: 0,
      kind: 'call',
      decisions: [],
    },
    playPhase: { bombCount: 0 },
  };
}

describe('§9 机器人契约的可见性边界', () => {
  it('四个机器人类型都不是 S→C 消息类型', () => {
    // 它们只走服务间通道（本切片是内部 HTTP，R200）；一旦有人把它们塞进 messages.ts，
    // 这条会红 —— 那是「把 GameSession/机器人内部结构下发给客户端」的第一步。
    for (const name of ['robot.acquire', 'robot.release', 'robot.decide', 'bot.instance']) {
      expect(SERVER_MESSAGE_TYPES as readonly string[]).not.toContain(name);
    }
  });

  it('BotInstance 形状的对象喂给出站校验必定被拦（botId / skillLevel 是禁止字段）', () => {
    const bot: BotInstance = {
      botId: 'bot-1234abcd',
      displayId: 'p_1234abcd',
      skillLevel: 'advanced',
      personality: { thinkingSpeed: 400 },
      roomCode: null,
      seat: null,
      gamesPlayed: 0,
    };
    expect(() => assertNoLeak(bot)).toThrow(/botId/);
  });

  it('RobotDecideRequest 形状的对象同样被拦（它含 view + botId + skillLevel）', () => {
    const req: RobotDecideRequest = {
      roomCode: 'ROOM1',
      botId: 'bot-1234abcd',
      skillLevel: 'advanced',
      view: view(),
      features: {
        position: 'landlord',
        lastMove: [],
        lastMovePosition: '',
        lastMoveMeta: null, // 协议 ④：首出（尚无上一手牌）
        numCardsLeft: { landlord: 20, landlord_down: 17, landlord_up: 17 },
        playedCards: { landlord: [], landlord_down: [], landlord_up: [] },
        actionSeq: [],
      },
    };
    expect(() => assertNoLeak(req)).toThrow(/botId/);
  });

  it('出站载荷里混入 isRobot/botId/skillLevel/actionLog 都会被 validateOutbound 拦下', () => {
    for (const key of FORBIDDEN_OUTBOUND_KEYS) {
      expect(() =>
        validateOutbound({ type: 'game.state_update', version: 1, payload: { ...view(), [key]: 'x' } }),
      ).toThrow(new RegExp(key));
    }
  });

  it('thinkingSpeed 是服务端内部字段：混入出站消息必被拦下', () => {
    expect(() => assertNoLeak({ thinkingSpeed: 2000 })).toThrow(/thinkingSpeed/);
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: 1,
        payload: { ...view(), thinkingSpeed: 2000 },
      }),
    ).toThrow(/thinkingSpeed/);
  });
});
