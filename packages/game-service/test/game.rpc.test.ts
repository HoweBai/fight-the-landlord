/**
 * §4.2 的 TCP RPC 监听方（N20 / P4 Task 1）。
 *
 * 判据（全部走**真实** `@MessagePattern` 元数据与**真实**业务方法替身）：
 *  ① 四个 pattern 名**逐字**来自 `RPC_PATTERNS`（不是手写字面量）——
 *     `RPC_PATTERNS` 本身由 `packages/protocol/src/messages.test.ts` 钉住；
 *  ② 业务层抛错 ⇒ 收敛成 R220 的 `{ok:false, code}` **信封**（5 位数字码必须
 *     原样跨过 RPC 边界，Nest 的 `RpcException` 只会剩字符串，这正是 R220 的理由）；
 *  ③ `game.snapshot` 找不到 ⇒ `{ok:false, code:12001}`（旧 HTTP 是 404 + `12001`）；
 *  ④ **R224**：`game.view` 只吃 `userId`，座位由服务端解析 —— handler 的入参形状
 *     里**不得**出现 `seat`（正向断言：把 `seat` 塞进载荷也不会被采纳）。
 */
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { ErrCode, RPC_PATTERNS, type Card } from '@fight-the-landlord/protocol';
import { GameRpcController } from '../src/rpc/game.rpc.controller';
import { GameService } from '../src/game/game.service';

/** R696：牌是 `{r, s}`。夹具只关心点数，故 `s` 取 0。 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

/**
 * Nest 内部的 pattern 元数据键（`@nestjs/microservices/constants` 的 `PATTERN_METADATA`）。
 * ⚠️ 它**未**从包根导出（无 `exports` map，可从子路径 import，但计划要求写字面量）；
 * 这里额外用一条自证判据钉住该字面量，防止 Nest 升版后本文件静默变成空测。
 */
const PATTERN_METADATA = 'microservices:pattern';

/**
 * 最小替身：只实现本片用到的四个方法。
 *
 * ⚠️ 旧写法把每个 `vi.fn` 的返回值标成 `as never` ⇒ `game.snapshot` 的替身**比真实实现更严**
 * （真实签名是 `getSnapshot(roomCode): Promise<GameSession | null>`，找不到就是 `null`），
 * 于是 `svc.getSnapshot.mockResolvedValueOnce(null)` 当场 TS2345。
 * 这里**去掉 `as never`**、让实现体的返回值参与推断（`startGame` 照真实出参形状），
 * 既不引入任何 `as`，也让替身重新和真实 `GameService` 同形。
 */
function fakeGameService() {
  return {
    startGame: vi.fn(async () => ({ roomCode: 'R1', state: 'bidding', version: 1 })),
    // `getSnapshot` 是**唯一**会被显式种 `null` 的方法（`game.snapshot` 的 12001 分支）
    // ⇒ 它必须能同时接受会话与 `null`。默认值仍是成功路径的 `{roomCode:'R1'}`
    // （只有 12001 那条用例用 `mockResolvedValueOnce(null)` 覆写一次）。
    getSnapshot: vi.fn<(roomCode: string) => Promise<{ roomCode: string } | null>>(
      async () => ({ roomCode: 'R1' }),
    ),
    getViewForUser: vi.fn(async () => ({ roomCode: 'R1', seat: 0 })),
    actAndView: vi.fn(async () => ({ roomCode: 'R1', seat: 0 })),
  };
}

function patternOf(method: keyof GameRpcController): string[] {
  return Reflect.getMetadata(PATTERN_METADATA, GameRpcController.prototype[method]) as string[];
}

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('game-service 的 §4.2 RPC handler（N20/R220）', () => {
  let controller: GameRpcController;
  let svc: ReturnType<typeof fakeGameService>;

  // P18/N41：`design:paramtypes` 现由测试环境**真的**发出（插件 + `setupFiles: ['reflect-metadata']`），
  // 因此**不再**手写 `Reflect.defineMetadata` 垫片 —— 下面 `compile()` 用的是产品真实元数据。

  beforeEach(async () => {
    svc = fakeGameService();
    const mod = await Test.createTestingModule({
      controllers: [GameRpcController],
      providers: [{ provide: GameService, useValue: svc }],
    }).compile();
    controller = mod.get(GameRpcController);
  });

  it('§4.2：四个 pattern 名逐字来自 RPC_PATTERNS（不是手写字面量）', () => {
    expect(patternOf('start')).toEqual([RPC_PATTERNS.gameStart]);
    expect(patternOf('snapshot')).toEqual([RPC_PATTERNS.gameSnapshot]);
    expect(patternOf('view')).toEqual([RPC_PATTERNS.gameView]);
    expect(patternOf('action')).toEqual([RPC_PATTERNS.gameAction]);
  });

  it('R220：`{ok:true,data}` 信封 + 业务抛错收敛成 `{ok:false,code}`（绝不抛裸错）', async () => {
    await expect(controller.start({ roomCode: 'R1', baseScore: 100, players: [] })).resolves.toEqual({
      ok: true,
      data: { roomCode: 'R1', state: 'bidding', version: 1 },
    });

    svc.startGame.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: ErrCode.ILLEGAL_ACTION }),
    );
    await expect(controller.start({ roomCode: 'R1', baseScore: 100, players: [] })).resolves.toEqual({
      ok: false,
      code: ErrCode.ILLEGAL_ACTION,
      message: 'boom',
    });
  });

  it('game.snapshot：找不到 ⇒ `{ok:false, code:12001}`（旧 HTTP 是 404 + 12001）', async () => {
    svc.getSnapshot.mockResolvedValueOnce(null);
    await expect(controller.snapshot({ roomCode: 'NOPE' })).resolves.toEqual({
      ok: false,
      code: ErrCode.ROOM_NOT_FOUND,
      message: expect.any(String),
    });
  });

  it('§4.2/R224：`game.view` 只吃 userId，座位由服务端解析（handler 里不得出现 seat 入参）', async () => {
    await expect(controller.view({ roomCode: 'R1', userId: 'u1' })).resolves.toEqual({
      ok: true,
      data: { roomCode: 'R1', seat: 0 },
    });
    expect(svc.getViewForUser).toHaveBeenCalledWith('R1', 'u1');

    // 攻击形态：调用方**自带** seat ⇒ 必须被忽略（否则等于绕过裁剪，§4.2 逐字）
    svc.getViewForUser.mockClear();
    await controller.view({ roomCode: 'R1', userId: 'u1', seat: 2 } as never);
    expect(svc.getViewForUser).toHaveBeenCalledWith('R1', 'u1');
    expect(svc.getViewForUser).not.toHaveBeenCalledWith('R1', expect.anything(), expect.anything());

    svc.getViewForUser.mockRejectedValueOnce(
      Object.assign(new Error('not in'), { code: ErrCode.NOT_IN_ROOM }),
    );
    await expect(controller.view({ roomCode: 'R1', userId: 'u9' })).resolves.toEqual({
      ok: false,
      code: ErrCode.NOT_IN_ROOM,
      message: 'not in',
    });
  });

  it('R219：`game.action` 把 action/payload/baseVersion 原样交给 actAndView（重试语义在调用方）', async () => {
    await controller.action({
      roomCode: 'R1',
      userId: 'u1',
      action: 'play',
      payload: { cards: h(3) },
      baseVersion: 7,
    });
    expect(svc.actAndView).toHaveBeenCalledWith('R1', 'u1', 'play', { cards: h(3) }, 7);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * **判据 7（单测半边）/ R1107**：接收侧把**处理期间**的日志挂到调用方那条链上。
   * ─────────────────────────────────────────────────────────────────────────
   *
   * 与 `robot.rpc.test.ts` 的同名两条**同形**（本 repo 的两个 `to-result.ts` 各自一份）。
   * 观测口：`Logger.overrideLogger` 装捕获 sink —— Nest 的 logger 是**进程级**的
   * （`staticInstanceRef`），业务侧 `new Logger(...)` 打的行也进同一个 sink。
   *
   * ⚠️ **四个 handler 逐个来**：计划的要求是「7 个 handler 各传一个 `dto?.meta`」——
   * 只测 start 的话，漏传 snapshot/view/action 在单测层是**隐形**的。
   * ⚠️ 替身里**必须真的打一行**：handler 本身不产生日志，真实链上的行来自被它包住的
   * `GameService`（`game.service.ts:185` 的 `Game created for room …` 等）。替身不打
   * ⇒ `records` 是空的 ⇒ 判据退化成在**空集**上做断言。
   */
  it('判据 7 的一半：handler 处理期间的日志带调用方传的 traceId 与 source=rpc', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'game-service' }));
    const META = { traceId: 'T7', reqId: 'R7' };
    // 四个替身各自在生产同形的日志点打一行
    svc.startGame.mockImplementationOnce(async () => {
      new Logger('GameService').log('Game created for room R1 (version 1)');
      return { roomCode: 'R1', state: 'bidding', version: 1 };
    });
    svc.getSnapshot.mockImplementationOnce(async () => {
      new Logger('GameService').log('Snapshot for room R1 handed out (RPC)');
      return { roomCode: 'R1' };
    });
    svc.getViewForUser.mockImplementationOnce(async () => {
      new Logger('GameService').log('View built for room R1 seat 0');
      return { roomCode: 'R1', seat: 0 };
    });
    svc.actAndView.mockImplementationOnce(async () => {
      new Logger('GameService').log('Action pass applied in R1 (version 8)');
      return { roomCode: 'R1', seat: 0 };
    });

    // ⚠️ 载荷**带类型**（不写 `as never`）⇒ `meta` 字段本身也被类型层钉住
    //    （若协议里没有 `meta`，这些行编译不过，而 `as never` 会把它藏起来）。
    const cases: Array<{ handler: string; invoke: () => Promise<unknown>; msg: string }> = [
      {
        handler: 'game.start',
        msg: 'Game created',
        invoke: () =>
          controller.start({ roomCode: 'R1', baseScore: 100, players: [], meta: META }),
      },
      {
        handler: 'game.snapshot',
        msg: 'Snapshot for room',
        invoke: () => controller.snapshot({ roomCode: 'R1', meta: META }),
      },
      {
        handler: 'game.view',
        msg: 'View built',
        invoke: () => controller.view({ roomCode: 'R1', userId: 'u1', meta: META }),
      },
      {
        handler: 'game.action',
        msg: 'Action pass applied',
        invoke: () =>
          controller.action({
            roomCode: 'R1',
            userId: 'u1',
            action: 'pass',
            payload: {},
            baseVersion: 7,
            meta: META,
          }),
      },
    ];

    for (const c of cases) {
      records.length = 0; // 只留**本次**处理期间的记录
      await c.invoke();
      const line = records.find((r) => r.msg.includes(c.msg));
      expect(line, `${c.handler}：处理期间的日志不在捕获 sink 里 —— 判据空转，先查观测口`).toBeDefined();
      expect(line!.traceId, `${c.handler} 的日志没挂上调用方的 traceId（漏传 dto?.meta？）`).toBe('T7');
      expect(line!.reqId, `${c.handler} 的日志没带上 reqId`).toBe('R7');
      expect(line!.source, `${c.handler} 的来源必须是 rpc`).toBe('rpc');
    }
  });

  it('判据 7 负对照：无 meta ⇒ traceId 为 null 且 source 仍是 rpc（不编造，R1107）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'game-service' }));
    svc.getViewForUser.mockImplementationOnce(async () => {
      new Logger('GameService').log('View built for room R1 seat 0');
      return { roomCode: 'R1', seat: 0 };
    });

    await controller.view({ roomCode: 'R1', userId: 'u1' }); // 载荷里**没有** meta

    const line = records.find((r) => r.msg.includes('View built'));
    expect(line, '处理期间的日志不在捕获 sink 里 —— 判据空转，先查观测口').toBeDefined();
    // 不编造 id（R1107）；但「我在处理一次 RPC」这个**来源**仍在 ⇒ source 是 `rpc`。
    expect(line!.traceId).toBeNull();
    expect(line!.source).toBe('rpc');
  });
});
