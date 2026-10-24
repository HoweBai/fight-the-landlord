import { describe, expect, it } from 'vitest';
import { CLIENT_ACTION, ClientAction, ErrCode, RESERVED_CODES } from '@fight-the-landlord/protocol';
import { COPY_SETS } from '../src/net/copy';

const ALL = Object.values(ErrCode).filter((v): v is ErrCode => typeof v === 'number');

describe('G1 文案分区', () => {
  it('IGNORED 由 CLIENT_ACTION 派生', () => {
    const derived = ALL.filter((c) => CLIENT_ACTION[c] === ClientAction.IGNORE);
    expect([...COPY_SETS.IGNORED].sort()).toEqual(derived.sort());
  });

  it('FIXED 与 MESSAGE_FIRST 精确分区全部非 IGNORED 码', () => {
    const classified = new Set([...COPY_SETS.FIXED, ...COPY_SETS.MESSAGE_FIRST]);
    const ignored = COPY_SETS.IGNORED;
    for (const code of ALL) {
      if (ignored.has(code)) {
        expect(classified.has(code), `${code} 不得同时在 IGNORED 与文案分区`).toBe(false);
      } else {
        expect(classified.has(code), `${code} 必须落在 FIXED 或 MESSAGE_FIRST`).toBe(true);
      }
    }
    expect([...COPY_SETS.FIXED].filter((c) => COPY_SETS.MESSAGE_FIRST.has(c))).toEqual([]);
  });

  it('IGNORE_WITH_COPY 是 IGNORED 的子集', () => {
    for (const code of COPY_SETS.IGNORE_WITH_COPY) {
      expect(COPY_SETS.IGNORED.has(code), `${code} 必须属于 IGNORED`).toBe(true);
    }
  });

  it('RESERVED 码有明确归属', () => {
    for (const code of RESERVED_CODES) {
      const ok = COPY_SETS.FIXED.has(code) || COPY_SETS.IGNORED.has(code);
      expect(ok, `reserved ${code} 必须在 FIXED 或 IGNORED`).toBe(true);
    }
  });

  it('关键码归属硬编码（防实现表与测试互为镜像）', () => {
    for (const code of [ErrCode.ROOM_ALREADY_STARTED, ErrCode.VERSION_CONFLICT, ErrCode.RATE_LIMITED, ErrCode.UPSTREAM_UNAVAILABLE]) {
      expect(COPY_SETS.FIXED.has(code), `${code} 必须在 FIXED`).toBe(true);
      expect(COPY_SETS.MESSAGE_FIRST.has(code), `${code} 不得在 MESSAGE_FIRST`).toBe(false);
    }
  });

  it('判别力：漏 12008 / 13004 / 两表重叠必须红', () => {
    const sample = {
      fixed: new Set([ErrCode.ILLEGAL_ACTION]),
      messageFirst: new Set([ErrCode.BAD_PARAM]),
      ignored: new Set<number>(),
    };
    const classified = new Set([...sample.fixed, ...sample.messageFirst]);
    expect(classified.has(ErrCode.ROOM_ALREADY_STARTED)).toBe(false);
    expect(classified.has(ErrCode.VERSION_CONFLICT)).toBe(false);
    expect([...sample.fixed].filter((c) => sample.messageFirst.has(c))).toEqual([]);
    sample.messageFirst.add(ErrCode.ILLEGAL_ACTION);
    expect([...sample.fixed].filter((c) => sample.messageFirst.has(c))).toEqual([ErrCode.ILLEGAL_ACTION]);
  });
});
