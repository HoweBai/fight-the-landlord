import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../src/observability/reporter', () => ({ reportError }));

import { dispatchErrorCode, resetUnknownCodeReports } from '../src/net/errors';

const noop = () => {};
const handlers = { ignore: noop, refreshSnapshot: noop, reconnect: noop, toast: noop, backToLobby: noop };

beforeEach(() => {
  reportError.mockClear();
  resetUnknownCodeReports();
});

describe('未知码上报', () => {
  it('同一未知码每会话只报一次', () => {
    const dispatch = dispatchErrorCode(handlers);
    dispatch(424242);
    dispatch(424242);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBe('notice.unknown_code');
    expect(reportError.mock.calls[0]![2]).toMatchObject({ code: 424242 });
  });
});
