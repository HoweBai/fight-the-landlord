import { describe, expect, it } from 'vitest';
import { GAME_META } from '../game';
import { resolveGameType } from '../views';
import { validateClientMessage, validateOutbound, ProtocolError } from '../validate';
import { decodeMahjongHand, encodeMahjongHand, type Tile } from './tile';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES, parseMahjongRules } from './rules';
import type { MahjongPlayerView, MahjongSettlementResult } from './types';
import type { MahjongRulesConfig } from './rules';

const tile = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });

function baseView(): MahjongPlayerView {
  return {
    roomCode: 'R1',
    gameType: 'mahjong',
    playerCount: 4,
    version: 1,
    state: 'play',
    baseScore: 10,
    seat: 0,
    hand: [tile(0, 1), tile(0, 1)],
    cardCounts: [2, 13, 13, 13],
    trustees: [false, false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: Date.now() + 5000,
    activeSeats: [0],
    dealerSeat: 0,
    wallCount: 40,
    lackSuits: [null, null, null, null],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    isOut: [false, false, false, false],
    huInfos: [],
    claimsForMe: [],
    mahjongRules: {} as MahjongRulesConfig,
    revealedHands: [],
    windowId: 'turn:1',
  };
}

function baseSettlement(): MahjongSettlementResult {
  return {
    roomCode: 'R1',
    gameType: 'mahjong',
    playerCount: 4,
    baseScore: 10,
    winnerSeats: [0],
    scoreChanges: [
      { seat: 0, delta: 10 },
      { seat: 1, delta: -10 },
      { seat: 2, delta: 0 },
      { seat: 3, delta: 0 },
    ],
    fanDetails: [],
    events: [],
    burn: [],
    rakeTotal: 0,
    chajiao: [],
    liuju: false,
    huazhuSeats: [],
    endReason: 'threeWinners',
    writtenOff: [],
  };
}

describe('mahjong protocol', () => {
  it('tile codec roundtrip and 27-char count string', () => {
    const tiles = [tile(0, 1), tile(0, 1), tile(1, 9), tile(2, 3)];
    expect(encodeMahjongHand(tiles)).toBe('200000000000000001001000000');
    expect(decodeMahjongHand(encodeMahjongHand(tiles), 4)).toEqual(tiles);
    expect(() => decodeMahjongHand('0'.repeat(26))).toThrow(/27/);
    expect(() => decodeMahjongHand(`${'0'.repeat(26)}5`)).toThrow(/0\.\.4/);
    expect(() => decodeMahjongHand(encodeMahjongHand(tiles), 13)).toThrow(/sum/);
  });

  it('GAME_META.mahjong is 4-player', () => {
    expect(GAME_META.mahjong.supportedPlayerCounts).toEqual([4]);
    expect(GAME_META.mahjong.defaultPlayerCount).toBe(4);
  });

  it('resolveGameType recognizes mahjong', () => {
    expect(resolveGameType(baseView())).toBe('mahjong');
  });

  it('game.play accepts exactly one of cards|mahjong, with optional windowId', () => {
    const body = {
      reqId: 'r1',
      baseVersion: 1,
      timestamp: Date.now(),
      windowId: 'claim:3',
      payload: { mahjong: { type: 'exchange', tiles: [tile(0, 1), tile(0, 2), tile(0, 3)] } },
    };
    expect(validateClientMessage('game.play', body).meta.windowId).toBe('claim:3');
    expect(() => validateClientMessage('game.play', { ...body, payload: {} })).toThrow(ProtocolError);
    expect(() =>
      validateClientMessage('game.play', {
        ...body,
        payload: { cards: [{ r: 3, s: 0 }], mahjong: { type: 'selfDrawHu' } },
      }),
    ).toThrow(ProtocolError);
    expect(() =>
      validateClientMessage('game.play', {
        ...body,
        payload: { mahjong: { type: 'exchange', tiles: [tile(0, 1), tile(1, 2), tile(0, 3)] } },
      }),
    ).toThrow(/same suit/);
  });

  it('outbound mahjong view passes leak guard', () => {
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: 1, payload: baseView() }),
    ).not.toThrow();
  });

  it('outbound mahjong view rejects wall/rngSeed leaks', () => {
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: 1,
        payload: { ...baseView(), wall: [] },
      }),
    ).toThrow(/wall/);
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: 1,
        payload: { ...baseView(), rngSeed: 'x' },
      }),
    ).toThrow(/rngSeed/);
  });

  it('mahjong settlement must be zero-sum', () => {
    const ok = baseSettlement();
    expect(() =>
      validateOutbound({ type: 'game.settlement', version: 1, payload: ok }),
    ).not.toThrow();
    const bad = baseSettlement();
    bad.scoreChanges[0]!.delta = 11;
    expect(() =>
      validateOutbound({ type: 'game.settlement', version: 1, payload: bad }),
    ).toThrow(/zero-sum/);
  });

  it('rules preset: chengdu 6/32×, sbr 3/8×, overrides and unknown key', () => {
    expect(parseMahjongRules(undefined)).toMatchObject({
      preset: 'chengdu',
      fanCap: 6,
      exchangeThreeEnabled: true,
      huazhuMode: 'payEach',
    });
    expect(parseMahjongRules({ preset: 'sbr' })).toMatchObject({
      preset: 'sbr',
      fanCap: DEFAULT_SBR_RULES.fanCap,
      exchangeThreeEnabled: false,
      huazhuMode: 'burn48',
      gangTransfer: 'none',
    });
    expect(parseMahjongRules({ preset: 'chengdu', fanCap: 4 }).fanCap).toBe(4);
    expect(parseMahjongRules({ preset: 'chengdu', fanTable: { qingYiSe: 5 } }).fanTable.qingYiSe).toBe(5);
    expect(() => parseMahjongRules({ nope: 1 })).toThrow(/unknown key/);
    expect(() => parseMahjongRules({ fanCap: 99 })).toThrow(/fanCap/);
    expect(DEFAULT_CHENGDU_RULES.preset).toBe('chengdu');
  });
});
