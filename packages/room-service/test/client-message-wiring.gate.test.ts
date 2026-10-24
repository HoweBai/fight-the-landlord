/**
 * 挂机治理 T6（规格 **C26**）：C→S 消息接线的**两条腿**闸。
 *
 * ## 它守的是什么
 *
 * `CLIENT_MESSAGE_TYPES` 是契约清单（protocol 包），而 room-service 的接线是**手写的两处**：
 *  1. `ws.gateway.ts` 的逐条 `@SubscribeMessage('<type>')` —— 少了它，socket.io 根本不订阅
 *     该事件名，处理函数永远不可达（**机器人补位片真实咬过**：router 有 case、网关漏装饰器，
 *     玩家点「延长匹配时间」没反应，lint / 单测全绿）；
 *  2. `message.router.ts` 的 `switch (message.type)` —— 少了 `case`，`validateClientMessage`
 *     放行后落到 `default` 抛 `Unhandled client message type`，被通用 catch 压成 **13001**。
 *
 * 两条腿各带**判别力自证**：合成的「坏」样本必须让同一个判定函数变红（只测正向无法证明
 * 它看得见；只测负向无法证明它不误伤）。
 *
 * ## 判据形态
 *  - 腿①：**源扫描**（`ws.gateway.ts` 是逐条装饰器的静态形态，扫描才看得见「缺失」）——
 *    先剥注释，再对 `CLIENT_MESSAGE_TYPES` 每一条找 `@SubscribeMessage('<type>')`；
 *  - 腿②：**行为**（遍历同清单走**真实** `routeClientMessage` + 共享 deps 工厂）——
 *    断言路由日志里**不出现**该 type 的 `Unhandled client message type`，且消息**没有被
 *    本地校验拒掉**（反空测：证明它真的走到了 dispatch，而不是在入口短路后「什么错都没有」）。
 *
 * ⚠️ deps 工厂来自 `test/helpers/router-deps.ts`（单一真源，`message.router.test.ts` 同源）——
 * 闸不得依赖私有构造（规格 C26 逐字）；替身与接口同宽，路由新增调用点时不至于把闸自己弄红。
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { CLIENT_MESSAGE_TYPES, type ClientMessageType } from '@fight-the-landlord/protocol';
import { makeDeps, makeSocket, route } from './helpers/router-deps';

/**
 * 从本文件所在目录**向上**找仓库根（以 `packages/room-service` + `packages/protocol`
 * 为锚）。⚠️ **R179**：不得用固定层数的相对路径 —— 层数一错就静默扫到旧文件或空目录
 * ⇒ 闸恒绿；找不到锚点必须**抛错**。
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const roomAnchor = join(dir, 'packages', 'room-service', 'package.json');
    const protocolAnchor = join(dir, 'packages', 'protocol', 'package.json');
    if (existsSync(roomAnchor) && existsSync(protocolAnchor) && statSync(roomAnchor).isFile()) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（以 packages/room-service + packages/protocol 为锚）');
}

const REPO = findRepoRoot();
const GATEWAY_SOURCE = join(REPO, 'packages', 'room-service', 'src', 'gateway', 'ws.gateway.ts');

/** 把注释替换成**等长空白**（与 `meta-on-every-rpc-send.gate.test.ts` 同款）。 */
function blankComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) =>
      line.replace(/(^|[^:])\/\/.*$/, (m, prefix: string) => prefix + ' '.repeat(m.length - prefix.length)),
    )
    .join('\n');
}

/**
 * 腿①的判定（纯函数，供判别力自证共用）：返回 `types` 里**缺装饰器**的那些。
 * 装饰器形态 = `@SubscribeMessage('<type>')`（单/双引号均可；点号转义）。
 */
function missingSubscribeDecorators(source: string, types: readonly string[]): string[] {
  const code = blankComments(source);
  return types.filter((type) => {
    const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`@SubscribeMessage\\(\\s*['"]${escaped}['"]\\s*\\)`).test(code);
  });
}

/**
 * 腿②的判定（纯函数）：从路由的 `logger.error` 文本里找出「命中 dispatcher default」的 type。
 *
 * 失败形态的**唯一**可观测面就是这一行（`message.router.ts` 的通用 catch 把异常压成 13001，
 * 所以不能只断言 ack 码 —— 13001 与「下游炸了」不可区分）。
 */
function unhandledTypes(errors: readonly string[], types: readonly string[]): string[] {
  return types.filter((type) =>
    errors.some((line) => line.includes(`Unhandled client message type: ${type}`)),
  );
}

/**
 * 每条契约消息的**合法最小载荷**（`validateClientMessage` 必须放行 —— 本闸要验的是
 * 「校验之后接线还在不在」，不是校验器本身）。
 */
const VALID_BODIES: Record<ClientMessageType, Record<string, unknown>> = {
  'room.match': { mode: 'random', baseScore: 15 },
  'room.unmatch': {},
  'room.match.extend': {},
  'room.join': { roomCode: 'ROOM1' },
  'room.leave': { roomCode: 'ROOM1' },
  'game.bid': { grab: true },
  'game.play': { cards: [{ r: 3, s: 0 }] },
  'game.pass': {},
  'game.reconnect': {},
  'game.resync': {},
  'game.trustee': { on: true },
};

/** 一条消息的路由观测结果。 */
interface RoutedMessage {
  type: string;
  ackCode: number | undefined;
  warnings: string[];
  errors: string[];
}

/** 用共享 deps 工厂把清单里的每一条消息真的走一遍路由，收集 ack 与日志两面。 */
async function routeAll(types: readonly ClientMessageType[]): Promise<RoutedMessage[]> {
  const results: RoutedMessage[] = [];
  for (const type of types) {
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    const { deps } = makeDeps({ logger: logger as unknown as Logger });
    const ack = await route(deps, makeSocket('alice'), {
      type,
      body: {
        reqId: `gate-${type}`,
        // `game.trustee` 不是 CAS 消息（契约要求 baseVersion=0）；其余按 0 也合法。
        baseVersion: 0,
        timestamp: Date.now(),
        payload: VALID_BODIES[type],
      },
    });
    results.push({
      type,
      ackCode: ack?.code,
      warnings: logger.warn.mock.calls.map((args) => String(args[0] ?? '')),
      errors: logger.error.mock.calls.map((args) => String(args[0] ?? '')),
    });
  }
  return results;
}

describe('C26 · 腿①：每条 CLIENT_MESSAGE_TYPES 都有 @SubscribeMessage', () => {
  it('闸自身的锚点与扫描面非空（R179：找不到就抛，绝不静默空测）', () => {
    expect(existsSync(GATEWAY_SOURCE)).toBe(true);
    expect(CLIENT_MESSAGE_TYPES.length).toBeGreaterThanOrEqual(11);
  });

  it('真实源：11 条契约消息逐条都有装饰器（缺失即红——网关不订阅 ⇒ 处理函数不可达）', () => {
    const source = readFileSync(GATEWAY_SOURCE, 'utf-8');
    expect(
      missingSubscribeDecorators(source, CLIENT_MESSAGE_TYPES),
      '这些 type 在 ws.gateway.ts 里没有 @SubscribeMessage ⇒ 网关永远不会收到该事件',
    ).toEqual([]);
  });

  it('判别力自证：从真实源里删掉 `game.trustee` 装饰器 ⇒ 闸当场看见它', () => {
    const source = readFileSync(GATEWAY_SOURCE, 'utf-8');
    const mutated = source.replace(/@SubscribeMessage\('game\.trustee'\)/, '');
    expect(mutated).not.toBe(source); // 变异真的发生了（防正则写错后「删了等于没删」）
    expect(missingSubscribeDecorators(mutated, CLIENT_MESSAGE_TYPES)).toEqual(['game.trustee']);
  });

  it('判别力自证：合成正/负样本（注释里的同名文本不算接线）', () => {
    const full = CLIENT_MESSAGE_TYPES.map((t) => `@SubscribeMessage('${t}')`).join('\n');
    expect(missingSubscribeDecorators(full, CLIENT_MESSAGE_TYPES)).toEqual([]);
    // 负：只有注释提到 —— 必须仍判缺失
    const commented = CLIENT_MESSAGE_TYPES.map((t) => `// @SubscribeMessage('${t}')`).join('\n');
    expect(missingSubscribeDecorators(commented, CLIENT_MESSAGE_TYPES)).toEqual([...CLIENT_MESSAGE_TYPES]);
  });
});

describe('C26 · 腿②：每条 CLIENT_MESSAGE_TYPES 走 routeClientMessage 不命中 Unhandled', () => {
  it('真实清单：全部走到 dispatch 且每条都有 case（无 Unhandled、无本地校验拒绝）', async () => {
    const results = await routeAll(CLIENT_MESSAGE_TYPES);

    // 反空测：每条都必须真的过了本地校验（否则「没有 Unhandled」可能只是入口短路）
    const rejected = results.filter((r) =>
      r.warnings.some((line) => line.includes('Rejected malformed client message')),
    );
    expect(rejected.map((r) => r.type)).toEqual([]);

    // 每条都必须产生 ack（路由契约：请求必有 ack）
    expect(results.filter((r) => typeof r.ackCode !== 'number').map((r) => r.type)).toEqual([]);

    // 判据本体：没有任何一条落到 dispatcher 的 default 分支
    const errors = results.flatMap((r) => r.errors);
    expect(
      unhandledTypes(errors, CLIENT_MESSAGE_TYPES),
      '这些 type 没有 router case ⇒ default 抛 Unhandled（生产上被压成 13001）',
    ).toEqual([]);
  });

  it('判别力自证：判定函数能看见失败形态，且不误伤无关错误', () => {
    // 正：dispatcher default 的真实日志形态
    const errorLine = 'Message game.__probe failed: Unhandled client message type: game.__probe';
    expect(unhandledTypes([errorLine], ['game.__probe'])).toEqual(['game.__probe']);
    // 负：别的错误、别的 type 都不得命中
    expect(unhandledTypes(['Message game.trustee failed: boom'], ['game.__probe'])).toEqual([]);
    expect(unhandledTypes([errorLine], ['game.trustee'])).toEqual([]);
  });

  /**
   * **端到端判别力**：让协议层放行一条 router 未接的合成 type，走**同一条**真实路由与
   * 同一套 deps ⇒ 通用 catch 的 `logger.error` 必须出现 `Unhandled client message type`。
   *
   * 这是腿②的「坏样本」：现实中它就是「protocol 新增了消息、router 漏了 case」的形态。
   * 用 `vi.doMock`（非 hoisted）只替换 `validateClientMessage`，让合成 type 通过校验；
   * 动态 import 拿到一份新的模块图，用完 reset 还原，不影响本文件其余用例。
   */
  it('端到端判别力：router 漏 case 的合成 type 会被同一条日志通道抓到', async () => {
    vi.resetModules();
    vi.doMock('@fight-the-landlord/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@fight-the-landlord/protocol')>();
      return {
        ...actual,
        // 只放宽校验（让合成 type 过闸），其余符号保持真实
        validateClientMessage: (type: unknown) => ({
          type,
          meta: { reqId: 'probe', baseVersion: 0, timestamp: Date.now() },
          payload: {},
        }),
      };
    });
    /**
     * ⚠️ 模块重求值会让 `room-metrics` 在**同一个** prom-client registry 上重复注册指标
     *（`@fight-the-landlord/shared` 是 externalized，registry 单例不随 resetModules 重建）
     * ⇒ 用 no-op 指标桩替换该模块（本用例与指标无关）。
     */
    vi.doMock('../src/metrics/room.metrics', () => {
      const gauge = { inc: () => {}, dec: () => {}, set: () => {} };
      const counter = { inc: () => {} };
      return {
        wsConnections: gauge,
        gamesStartedTotal: counter,
        gamesEndedTotal: counter,
        roomsActive: gauge,
        matchQueueLength: gauge,
        matchPredicateRejectionsTotal: counter,
        matchSelectionRoundsTotal: counter,
        matchNoLegalGroupTotal: counter,
        currencySettleResultTotal: counter,
        currencySettleResidueTotal: counter,
        currencySettleOutboxSize: gauge,
        currencySettleOutboxOldestSeconds: gauge,
        currencyRobotTopupTotal: counter,
        currencyRobotEnsureFailedTotal: counter,
        entryFeeSkippedTotal: counter,
        entryFeeConflictTotal: counter,
      };
    });
    try {
      const { makeDeps: freshMakeDeps, makeSocket: freshMakeSocket, route: freshRoute } = await import(
        './helpers/router-deps'
      );
      const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
      const { deps } = freshMakeDeps({ logger: logger as unknown as Logger });

      await freshRoute(deps, freshMakeSocket('alice'), {
        type: 'game.__probe',
        body: { reqId: 'probe', baseVersion: 0, timestamp: Date.now(), payload: {} },
      });

      const errors = logger.error.mock.calls.map((args) => String(args[0] ?? ''));
      expect(unhandledTypes(errors, ['game.__probe'])).toEqual(['game.__probe']);
    } finally {
      vi.doUnmock('../src/metrics/room.metrics');
      vi.doUnmock('@fight-the-landlord/protocol');
      vi.resetModules();
    }
  });
});
