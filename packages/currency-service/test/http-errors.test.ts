/**
 * T5 / 规格 §2.9 / C15：currency-service 的 `HTTP_STATUS` 映射表
 * （「每服务各一份」的复制件 —— 不补 14001/14002 则 409 静默变 500）。
 *
 * 判据：货币两码 → **409**（② 金币场再补 14004 → 409 —— relief 端点拒绝面）；两条控制器
 * 实际依赖的码（10001→400 / 10002→401）同钉；表外码 ⇒ **500** 兜底（`?? 500`，防「静默借码」）。
 */
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { HTTP_STATUS, httpException } from '../src/http/errors';

describe('HTTP_STATUS 映射表（§2.9 / C15）', () => {
  it('货币两码 → 409（14001 余额不足 / 14002 actionId 冲突）', () => {
    expect(HTTP_STATUS[ErrCode.E_INSUFFICIENT_FUNDS]).toBe(409);
    expect(HTTP_STATUS[ErrCode.E_ACTION_CONFLICT]).toBe(409);
  });

  it('② 金币场：14004 救助不可用 → 409（design.md §11.2 表；relief 端点两条拒绝都走它）', () => {
    expect(HTTP_STATUS[ErrCode.E_RELIEF_UNAVAILABLE]).toBe(409);
    expect(httpException(ErrCode.E_RELIEF_UNAVAILABLE, '救助暂未开放').getStatus()).toBe(409);
  });

  it('记牌器收费三码 14008/14009/14010 → 409（不补则静默 500）', () => {
    for (const code of [
      ErrCode.E_CARD_COUNTER_UNAVAILABLE,
      ErrCode.E_CARD_COUNTER_PRICE_CHANGED,
      ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT,
    ]) {
      expect(HTTP_STATUS[code]).toBe(409);
      expect(httpException(code, 'x').getStatus()).toBe(409);
    }
  });

  it('代理六码：邀请码/比例 400、冻结 403、结算三态 409', () => {
    for (const [code, status] of [
      [ErrCode.AGENT_INVITE_INVALID, 400],
      [ErrCode.AGENT_RATE_INVALID, 400],
      [ErrCode.AGENT_FROZEN, 403],
      [ErrCode.AGENT_SETTLEMENT_MIN, 409],
      [ErrCode.AGENT_SETTLEMENT_PENDING, 409],
      [ErrCode.AGENT_SETTLEMENT_STATE, 409],
    ] as const) {
      expect(HTTP_STATUS[code], String(code)).toBe(status);
      expect(httpException(code, 'x').getStatus()).toBe(status);
    }
  });

  it('httpException 的 status 走表：14001/14002 ⇒ 409、10001 ⇒ 400、10002 ⇒ 401', () => {
    expect(httpException(ErrCode.E_INSUFFICIENT_FUNDS, '余额不足').getStatus()).toBe(409);
    expect(httpException(ErrCode.E_ACTION_CONFLICT, '同 id 不同内容').getStatus()).toBe(409);
    expect(httpException(ErrCode.BAD_PARAM, 'x').getStatus()).toBe(400);
    expect(httpException(ErrCode.UNAUTHENTICATED, 'x').getStatus()).toBe(401);
  });

  it('统一响应形态 `{code, message, data:null}`（§11.1）', () => {
    expect(httpException(ErrCode.E_INSUFFICIENT_FUNDS, '余额不足').getResponse()).toEqual({
      code: ErrCode.E_INSUFFICIENT_FUNDS,
      message: '余额不足',
      data: null,
    });
  });

  it('表外码 ⇒ 500 兜底（`?? 500`，不静默借码）', () => {
    // 12001 在 ErrCode 里存在但不在本服务的表里 —— 兜底必须生效（正对照 + 负对照）。
    expect(HTTP_STATUS[ErrCode.ROOM_NOT_FOUND]).toBeUndefined();
    expect(httpException(ErrCode.ROOM_NOT_FOUND, 'x').getStatus()).toBe(500);
    // 完全陌生的数值码同径（未来新增 ErrCode 而漏补表时的形态）
    expect(httpException(99999 as ErrCode, 'x').getStatus()).toBe(500);
  });
});
