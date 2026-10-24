/**
 * 端到端骨架联调（**默认跳过**，需要 mock/真实后端在跑）。
 *
 * 运行方式：
 *   CLIENT_E2E=1 CLIENT_E2E_ENDPOINT=http://localhost:3400 pnpm test
 *
 * 它证明的正是 Task 3 的目标路径：
 *   匹配 → room.matched → game.deal → 出一手/叫抢 → game.state_update
 *
 * 之所以默认跳过：`pnpm test` 必须是离线、确定性的（契约测试的 41 条断言不依赖任何服务）。
 */
import { describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import { GameClient } from '../src/net/socket';
import { createSocketIoFactory } from '../src/net/transport';
import type { GameView, PlayerView, ServerMessage } from '@fight-the-landlord/protocol';

const ENABLED = process.env.CLIENT_E2E === '1';
const ENDPOINT = process.env.CLIENT_E2E_ENDPOINT ?? 'http://localhost:3400';
const TIMEOUT = 20_000;

/** 等到某类推送出现（或超时），返回该消息。 */
function waitFor(
  client: GameClient,
  type: ServerMessage['type'],
  timeoutMs = 8000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时（${timeoutMs}ms）`)), timeoutMs);
    const off = client.on(type, (msg) => {
      clearTimeout(timer);
      off();
      resolve(msg);
    });
  });
}

/** 本 e2e 只驱动斗地主；pdk 视图出现即说明服务端/房间串了玩法。 */
function asDdzView(view: GameView): PlayerView {
  if (view.gameType === 'paodekuai') throw new Error('expected doudizhu view');
  return view;
}

function waitForSnapshot(
  client: GameClient,
  predicate: (view: PlayerView) => boolean,
  timeoutMs = 8000,
): Promise<PlayerView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待快照超时（${timeoutMs}ms）`)), timeoutMs);
    const off = client.on('game.state_update', (msg) => {
      const view = asDdzView(
        (msg as Extract<ServerMessage, { type: 'game.state_update' }>).payload,
      );
      if (predicate(view)) {
        clearTimeout(timer);
        off();
        resolve(view);
      }
    });
  });
}

describe.skipIf(!ENABLED)('端到端骨架（对 mock / 真实后端）', () => {
  it(
    '匹配 → room.matched → game.deal → 叫抢 → game.state_update',
    async () => {
      let version = -1;
      const snapshots: PlayerView[] = [];
      const client = new GameClient({
        endpoint: ENDPOINT,
        namespace: '/ws/ddz',
        auth: { userId: process.env.CLIENT_E2E_USER ?? 'u_dev' },
        socketFactory: createSocketIoFactory(io),
        currentVersion: () => version,
        onProtocolError: (error) => {
          throw error; // 开发期：服务端一旦漂移，测试立刻红
        },
      });

      // 骨架里 store 的职责：快照应用 + 推进 version（这里用最小实现代替 pinia）
      client.on('game.deal', (msg) => {
        const view = asDdzView((msg as Extract<ServerMessage, { type: 'game.deal' }>).payload);
        version = view.version;
        snapshots.push(view);
      });
      client.on('game.state_update', (msg) => {
        const view = asDdzView(
          (msg as Extract<ServerMessage, { type: 'game.state_update' }>).payload,
        );
        version = view.version;
        snapshots.push(view);
      });

      try {
        client.connect();

        const matched = waitFor(client, 'room.matched');
        // 协议②（片规格 §2.4）：`baseScore` 必填 —— 15 = 档位表里的最小档（缺省档）。
        // ⚠️ mock-server 会 `validateClientMessage`（两侧同一份 protocol）⇒ 漏了它拿 10001。
        const matchAck = await client.send('room.match', { mode: 'random', baseScore: 15 });
        expect(matchAck.status).toBe('sent');
        expect(matchAck.status === 'sent' && matchAck.code).toBe(0);
        const matchedMsg = await matched;
        const { roomCode, seat } = (
          matchedMsg as Extract<ServerMessage, { type: 'room.matched' }>
        ).payload;
        expect(typeof roomCode).toBe('string');
        expect([0, 1, 2]).toContain(seat);

        // 进房 → 等 game.deal
        const deal = waitFor(client, 'game.deal');
        const joinAck = await client.send('room.join', { roomCode });
        expect(joinAck.status === 'sent' && joinAck.code).toBe(0);
        const dealView = (await deal) as Extract<ServerMessage, { type: 'game.deal' }>;
        const dealPayload = asDdzView(dealView.payload);
        expect(dealPayload.state).toBe('bidding');
        expect(dealPayload.bottomCards).toBeNull();
        expect(dealPayload.landlordSeat).toBeNull();
        expect(dealPayload.cardCounts[dealPayload.seat]).toBe(dealPayload.hand.length);

        // 叫抢：baseVersion 必须是刚应用的 version（§6.5）
        expect(version).toBe(dealView.version);
        const nextUpdate = waitForSnapshot(client, (v) => v.version > dealView.version);
        const bidAck = await client.send('game.bid', { grab: true });
        expect(bidAck.status === 'sent' && bidAck.code).toBe(0);
        const afterBid = await nextUpdate;
        expect(afterBid.version).toBeGreaterThan(dealView.version);
        expect(afterBid.state).toBe('playing');
        // 出牌阶段的行动者从 currentPlayer 读（叫抢阶段则是 currentBidder，玩法 §9.1）
        expect([0, 1, 2]).toContain(afterBid.currentPlayer);

        // 出一手：只发原始牌值，合法性由服务端判定（F01）
        if (afterBid.currentPlayer === afterBid.seat && afterBid.hand.length > 0) {
          const card = afterBid.hand[0]!;
          const playUpdate = waitForSnapshot(client, (v) => v.version > afterBid.version);
          const playAck = await client.send('game.play', { cards: [card] });
          expect(playAck.status).toBe('sent');
          if (playAck.status !== 'sent') throw new Error('unreachable');
          // 服务端可能因牌型不合法返回 13006（那也证明链路通），但绝不能是「没应答」
          expect(playAck.code).not.toBe(-1);
          if (playAck.code === 0) {
            const afterPlay = await playUpdate;
            expect(afterPlay.version).toBeGreaterThan(afterBid.version);
          }
        }
      } finally {
        client.destroy();
      }
    },
    TIMEOUT,
  );
});
