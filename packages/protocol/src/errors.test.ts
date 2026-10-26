import { describe, it, expect } from 'vitest';
import { ErrCode, CLIENT_ACTION, ClientAction, isBenign, isReserved } from './errors';

/**
 * 这张表必须与 docs/design.md §11.2 完全一致。
 * 改任一侧都必须同 PR 改另一侧——这个断言防的是「代码悄悄漂移」。
 */
const SPEC_CODES: number[] = [
  0,
  10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, // 10008 = 客户端接入闸（本片）
  11001, 11002, 11003, 11004, 11005, // 11005 = 设备绑定（账号已绑定其他设备）
  11006, 11007, // 代理分润：邀请码无效 / 冻结代理
  12001, 12002, 12003, 12004, 12005, 12006, 12007, 12008, 12009, 12010, // 12010 = 金币场（场次开关关闭）
  12011, // 在局/在房匹配守卫（本片）
  12012, // 多玩法片：玩法未开放/人数不支持/客户端与房间玩法不符
  13001, 13004, 13005, 13006, 13007, 13008, 13009, 13010,
  14001, 14002, 14003, 14004, // 货币核心片 14001/14002 + 金币场 14003（门槛）/14004（救助）
  14008, 14009, 14010, // 记牌器收费片（未开放/价格已更新/请求号冲突；14006/14007 已被记录行态占用）
  14011, 14012, 14013, 14014, // 代理分润：结算最低额/待处理/状态/比例
  15001, 15002, 15003, 15004, 15005, 15006, 15007, 15008, 15009, // 支付片 15001–15009（设计 §8 + ⚙️9；15007=内部面且入 RESERVED_CODES）
];

describe('error codes', () => {
  it('matches the spec set exactly', () => {
    const actual = (Object.values(ErrCode) as (string | number)[])
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    expect(actual).toEqual([...SPEC_CODES].sort((a, b) => a - b));
  });

  it('does not contain the deprecated 13002 / 13003', () => {
    const values = Object.values(ErrCode) as number[];
    expect(values).not.toContain(13002);
    expect(values).not.toContain(13003);
  });

  it('declares a client action for every code', () => {
    for (const v of Object.values(ErrCode)) {
      if (typeof v === 'number') {
        expect(CLIENT_ACTION[v as ErrCode]).toBeDefined();
      }
    }
  });

  it('routes version conflicts to snapshot refresh, never to reconnect', () => {
    // §6.5：13004 的唯一处置是就地刷新快照
    expect(CLIENT_ACTION[ErrCode.VERSION_CONFLICT]).toBe(ClientAction.REFRESH_SNAPSHOT);
  });

  it('货币两码（14001/14002）映射既有 TOAST —— ⚙️11：不新增 ClientAction 枚举值，文案走 message', () => {
    expect(CLIENT_ACTION[ErrCode.E_INSUFFICIENT_FUNDS]).toBe(ClientAction.TOAST);
    expect(CLIENT_ACTION[ErrCode.E_ACTION_CONFLICT]).toBe(ClientAction.TOAST);
  });

  it('金币场三码（12010/14003/14004）映射既有 TOAST —— ⚙️10：不新增 ClientAction 枚举值，文案走 message', () => {
    expect(CLIENT_ACTION[ErrCode.ROOM_MODE_DISABLED]).toBe(ClientAction.TOAST);
    expect(CLIENT_ACTION[ErrCode.E_ENTRY_THRESHOLD]).toBe(ClientAction.TOAST);
    expect(CLIENT_ACTION[ErrCode.E_RELIEF_UNAVAILABLE]).toBe(ClientAction.TOAST);
  });

  it('多玩法 12012 映射 TOAST', () => {
    expect(CLIENT_ACTION[ErrCode.GAME_UNAVAILABLE]).toBe(ClientAction.TOAST);
  });

  it('记牌器收费三码（14008/14009/14010）映射 TOAST', () => {
    expect(CLIENT_ACTION[ErrCode.E_CARD_COUNTER_UNAVAILABLE]).toBe(ClientAction.TOAST);
    expect(CLIENT_ACTION[ErrCode.E_CARD_COUNTER_PRICE_CHANGED]).toBe(ClientAction.TOAST);
    expect(CLIENT_ACTION[ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT]).toBe(ClientAction.TOAST);
  });

  it('支付九码（15001–15009）映射 —— ⚙️9：15001–15006/15008/15009 → TOAST；**15007 → IGNORE**（服务端内部面）', () => {
    for (const c of [
      ErrCode.PAY_CHANNEL_ERROR,
      ErrCode.PAY_ORDER_NOT_FOUND,
      ErrCode.PAY_WITHDRAW_UNAVAILABLE,
      ErrCode.PAY_WITHDRAW_LIMIT,
      ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT,
      ErrCode.PAY_REFUND_UNAVAILABLE,
      ErrCode.PAY_DISABLED,
      ErrCode.PAY_STATE_CONFLICT,
    ]) {
      expect(CLIENT_ACTION[c], `ErrCode ${c}`).toBe(ClientAction.TOAST);
    }
    expect(CLIENT_ACTION[ErrCode.PAY_NOTIFY_VERIFY_FAILED]).toBe(ClientAction.IGNORE);
  });

  it('marks idempotent duplicates as benign', () => {
    expect(isBenign(ErrCode.ALREADY_IN_QUEUE)).toBe(true);
    expect(isBenign(ErrCode.NOT_YOUR_TURN)).toBe(true);
    expect(isBenign(ErrCode.INVALID_CARDS)).toBe(false);
  });

  it('declares reserved codes explicitly (not just as prose in the spec)', () => {
    expect(isReserved(ErrCode.ACTION_TIMEOUT)).toBe(true);
    expect(isReserved(ErrCode.BOT_DECISION_TIMEOUT)).toBe(true);
    // 支付片 ⚙️9：回调验签失败 = 内部事件码（只日志+指标，不作响应码）——照 BOT_DECISION_TIMEOUT 先例
    expect(isReserved(ErrCode.PAY_NOTIFY_VERIFY_FAILED)).toBe(true);
    expect(isReserved(ErrCode.VERSION_CONFLICT)).toBe(false);
  });

  it('never maps any error code to RECONNECT', () => {
    // §6.5 收窄了 M08：13004 是「就地刷新快照」，不是重连。
    // 这条断言放在契约包里，将来若有人在表里加 RECONNECT 会立刻红。
    for (const v of Object.values(ErrCode)) {
      if (typeof v === 'number') {
        expect(CLIENT_ACTION[v as ErrCode]).not.toBe(ClientAction.RECONNECT);
      }
    }
  });
});
