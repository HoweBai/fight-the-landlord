/**
 * 契约行为断言 ③：错误码处置（§11 / §6.5 / §12）。
 *
 * 前端**必须**按 `CLIENT_ACTION` 表分支，不得自行发明处置。
 * 本文件把「表的内容」与「执行器的分支」两件事都钉死：
 *  - 13004 的唯一处置是「就地刷新快照」，**不是**断线重连（§6.5）；
 *  - 每条错误码都必须能被执行器分派到某个处置；
 *  - 未登记的码不得静默吞掉。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ACTION,
  ClientAction,
  ErrCode,
  isBenign,
} from '@fight-the-landlord/protocol';
import { classifyAck, createActionExecutor, dispatchErrorCode, dispatchRestFailure } from '../src/net/errors';
import type { ClientActionHandlers, ClientActionReport, RestFailureHandlers } from '../src/net/errors';
import { FakeSocket, playerViewFixture } from './helpers/fake-socket';
import { GameClient } from '../src/net/socket';

function recordingHandlers() {
  const calls: ClientActionReport[] = [];
  const handlers: ClientActionHandlers = {
    ignore: (r) => calls.push(r),
    refreshSnapshot: (r) => calls.push(r),
    reconnect: (r) => calls.push(r),
    toast: (r) => calls.push(r),
    backToLobby: (r) => calls.push(r),
  };
  return { calls, handlers };
}

describe('③ CLIENT_ACTION 表就是契约（§11）', () => {
  it('13004 → REFRESH_SNAPSHOT，且绝不是 RECONNECT', () => {
    expect(CLIENT_ACTION[ErrCode.VERSION_CONFLICT]).toBe(ClientAction.REFRESH_SNAPSHOT);
    expect(CLIENT_ACTION[ErrCode.VERSION_CONFLICT]).not.toBe(ClientAction.RECONNECT);
  });

  it('RECONNECT 只出现在「快照回退」的处置上，而不是任何错误码', () => {
    for (const [code, action] of Object.entries(CLIENT_ACTION)) {
      expect(
        action,
        `错误码 ${code} 不得把处置升级为断线重连（§6.5：重连只用于快照类 version 回退）`,
      ).not.toBe(ClientAction.RECONNECT);
    }
  });

  it('每个错误码都能被分派到某个处置（不多不少）', () => {
    const { calls, handlers } = recordingHandlers();
    const dispatch = dispatchErrorCode(handlers);

    for (const code of Object.values(ErrCode)) {
      if (typeof code !== 'number') continue;
      const report = dispatch(code);
      expect(report.action, `错误码 ${code} 没有可执行的处置`).toBeDefined();
    }
    expect(calls.length).toBe(Object.values(ErrCode).filter((c) => typeof c === 'number').length);
  });

  it('未登记的未知错误码 → 安全兜底为 toast，不得静默吞掉', () => {
    const { calls, handlers } = recordingHandlers();
    const dispatch = dispatchErrorCode(handlers);
    const report = dispatch(99999);

    expect(report.known).toBe(false);
    expect(report.action).toBe(ClientAction.TOAST);
    expect(calls.map((c) => c.action)).toContain(ClientAction.TOAST);
  });

  it('isBenign 与 IGNORE 处置保持一致', () => {
    expect(isBenign(ErrCode.NOT_YOUR_TURN)).toBe(true);
    expect(isBenign(ErrCode.VERSION_CONFLICT)).toBe(false);
  });
});

describe('③ 执行器分支', () => {
  it('13004 走 refreshSnapshot，且**不触发** reconnect', async () => {
    const refresh = vi.fn();
    const reconnect = vi.fn();
    const client = new GameClient({
      endpoint: 'http://mock.test',
      namespace: '/ws/ddz',
      auth: { userId: 'u_dev' },
      socketFactory: () => new FakeSocket(),
      currentVersion: () => 4,
    });
    client.onAction(createActionExecutor({ refreshSnapshot: refresh, reconnect }));

    client.handleAck({ reqId: 'r1', type: 'game.play', code: 13004 });

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('refreshSnapshot 处置走 game.resync 拉取当前裁剪快照，且全程不 emit game.reconnect（§6.3/§6.5）', async () => {
    const socket = new FakeSocket();
    const client = new GameClient({
      endpoint: 'http://mock.test',
      namespace: '/ws/ddz',
      auth: { userId: 'u_dev' },
      socketFactory: () => socket,
      currentVersion: () => 11,
    });

    const started = client.resync();
    const req = socket.lastRequest();
    expect(req?.type).toBe('game.resync');
    req!.ack(null, { code: 0, data: playerViewFixture({ version: 11 }) });
    await started;

    expect(socket.emitted).toHaveLength(1);
    expect(socket.emitted[0]!.type).toBe('game.resync');
    // §6.5 适用范围表：game.resync 不参与 CAS → baseVersion 0，载荷为空对象
    expect(socket.emitted[0]!.env).toMatchObject({ baseVersion: 0, payload: {} });
    expect(socket.emitted.map((e) => e.type)).not.toContain('game.reconnect');
  });

  it('game.resync / game.reconnect 的 ack 快照都按 version 规则应用（不跳过丢弃规则）', async () => {
    const socket = new FakeSocket();
    const client = new GameClient({
      endpoint: 'http://mock.test',
      namespace: '/ws/ddz',
      auth: { userId: 'u_dev' },
      socketFactory: () => socket,
      currentVersion: () => 11,
    });

    const resynced = client.resync();
    expect(socket.lastRequest()?.type).toBe('game.resync');

    // ack 带回的裁剪快照 version === currentVersion → 必须走「丢弃」而不是重复应用
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 11 }) });
    await expect(resynced).resolves.toEqual({ status: 'discarded', version: 11 });

    // 更新的快照 → 应用
    const fresher = client.resync();
    socket.lastRequest()!.ack(null, { code: 0, data: playerViewFixture({ version: 12 }) });
    await expect(fresher).resolves.toEqual({ status: 'applied', version: 12 });
  });

  it('未知 code 走 toast', () => {
    const handlers: ClientActionHandlers = {
      ignore: vi.fn(),
      refreshSnapshot: vi.fn(),
      reconnect: vi.fn(),
      toast: vi.fn(),
      backToLobby: vi.fn(),
    };
    dispatchErrorCode(handlers)(12345);
    expect(handlers.toast).toHaveBeenCalledTimes(1);
  });
});

describe('③ ack 归类', () => {
  it('code 0 表示成功，code !== 0 表示失败', () => {
    expect(classifyAck({ code: 0 }).ok).toBe(true);
    expect(classifyAck({ code: 13004 }).ok).toBe(false);
    expect(classifyAck({ code: 13004 }).message).toBeUndefined();
  });

  it('ack 的 message 仅供调试，不参与分支（§6.2）', () => {
    const classified = classifyAck({ code: 13004, message: '任意人类可读文本' });
    expect(classified.action).toBe(ClientAction.REFRESH_SNAPSHOT);
  });
});

/**
 * R34：REST 消费点也必须按 `CLIENT_ACTION` 表分派。
 * 差别只在**执行**：`BACK_TO_LOBBY` 不调服务端登出、快照类处置退化为「重放一次」。
 */
describe('③ REST 消费点的处置分派（R34）', () => {
  function restHandlers() {
    const calls: string[] = [];
    const signOutReports: ClientActionReport[] = [];
    const handlers: RestFailureHandlers = {
      toast: (r) => calls.push(`toast:${r.code}`),
      signOutLocally: (report) => {
        signOutReports.push(report);
        calls.push('signOutLocally');
      },
      replay: async () => {
        calls.push('replay');
      },
    };
    return { calls, signOutReports, handlers };
  }

  it('10002 / 10005（BACK_TO_LOBBY）→ 只清本地会话，**不**调服务端登出（report 一并交给处置方）', async () => {
    for (const code of [ErrCode.UNAUTHENTICATED, ErrCode.TOKEN_INVALID]) {
      const { calls, signOutReports, handlers } = restHandlers();
      const report = await dispatchRestFailure({ code, message: 'x' }, handlers);

      expect(report.action).toBe(ClientAction.BACK_TO_LOBBY);
      expect(calls).toEqual(['signOutLocally']);
      // Task 2：signOutLocally 现在收 report（与 toast 同源），不再是无参回调。
      expect(signOutReports).toHaveLength(1);
      expect(signOutReports[0]).toMatchObject({ code, action: ClientAction.BACK_TO_LOBBY });
    }
  });

  it('10001（TOAST）→ 提示，且不动会话、不重放', async () => {
    const { calls, handlers } = restHandlers();
    const report = await dispatchRestFailure({ code: ErrCode.BAD_PARAM, message: '手机号格式错误' }, handlers);

    expect(report.action).toBe(ClientAction.TOAST);
    expect(report.message).toBe('手机号格式错误');
    expect(calls).toEqual([`toast:${ErrCode.BAD_PARAM}`]);
  });

  it('13004（REFRESH_SNAPSHOT）→ 重放一次当前请求（REST 没有快照可刷）', async () => {
    const { calls, handlers } = restHandlers();
    const report = await dispatchRestFailure({ code: ErrCode.VERSION_CONFLICT }, handlers);

    expect(report.action).toBe(ClientAction.REFRESH_SNAPSHOT);
    expect(calls).toEqual(['replay']);
  });

  it('code 0（IGNORE）→ 什么都不做；未知码 → 兜底 toast，不静默吞掉', async () => {
    const ok = restHandlers();
    await dispatchRestFailure({ code: ErrCode.OK }, ok.handlers);
    expect(ok.calls).toEqual([]);

    const unknown = restHandlers();
    const report = await dispatchRestFailure({ code: 99999 }, unknown.handlers);
    expect(report.known).toBe(false);
    expect(unknown.calls).toEqual(['toast:99999']);
  });
});
