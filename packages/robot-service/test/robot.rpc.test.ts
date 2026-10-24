/**
 * §4.2 的 TCP RPC 监听方（N20 / P4 Task 1b）—— `robot-service` 侧。
 *
 * 与 Task 1（game-service）**同形**：三个 pattern 名逐字来自 `RPC_PATTERNS`、
 * 业务抛错收敛成 R220 的信封、`robot.acquire` 的响应用**逐字**的
 * `{bots}` 形状（§4.2 的 `acquire(dto): { bots: BotInstance[] }`）。
 */
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { ErrCode, RPC_PATTERNS, type RobotAvailabilityResponse } from '@fight-the-landlord/protocol';
import { RobotRpcController } from '../src/rpc/robot.rpc.controller';
import { RobotController } from '../src/robot/robot.controller';
import { createInternalTokenMiddleware } from '../src/http/internal-token.middleware';
import { RobotService } from '../src/robot/robot.service';

/** Nest 内部的 pattern 元数据键（`@nestjs/microservices/constants` 的 `PATTERN_METADATA`）。 */
const PATTERN_METADATA = 'microservices:pattern';

/** 最小替身：只实现本片用到的三个方法。 */
function fakeRobotService() {
  return {
    // ⚠️ 两个 `vi.fn` **不**写 `as never`（与 `game.rpc.test.ts` 的同款取舍）：`as never`
    //    会让 `mockImplementationOnce` 只接受返回 `never` 的函数（vitest 的
    //    `NormalizedPrecedure` 逐字取 `ReturnType<T>`）⇒ 判据 7 想在替身里打一行
    //    「处理期间」的日志就没法编译。让返回值参与推断即可两全。
    acquire: vi.fn(async () => ({ bots: [{ botId: 'bot-1', displayId: 'p_1' }] })),
    release: vi.fn(async () => ({ released: 2 })),
    decide: vi.fn(async () => ({ kind: 'pass', source: 'rule' })),
    // 注出 `reason` 所在的联合形状（与上面「不写 `as never`」同一条理由 —— 返回值参与
    // 推断，`mockResolvedValueOnce` 才收得下带 `reason` 的形态，否则 TS2353）。
    availability: vi.fn(async (): Promise<RobotAvailabilityResponse> => ({ canProvide: true })),
  };
}

function patternOf(method: keyof RobotRpcController): string[] {
  return Reflect.getMetadata(PATTERN_METADATA, RobotRpcController.prototype[method]) as string[];
}

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('robot-service 的 §4.2 RPC handler（N20/R220）', () => {
  let controller: RobotRpcController;
  let svc: ReturnType<typeof fakeRobotService>;

  beforeEach(async () => {
    svc = fakeRobotService();
    const mod = await Test.createTestingModule({
      controllers: [RobotRpcController],
      providers: [{ provide: RobotService, useValue: svc }],
    }).compile();
    controller = mod.get(RobotRpcController);
  });

  it('§4.2：四个 pattern 名逐字来自 RPC_PATTERNS（不是手写字面量）', () => {
    expect(patternOf('acquire')).toEqual([RPC_PATTERNS.robotAcquire]);
    expect(patternOf('release')).toEqual([RPC_PATTERNS.robotRelease]);
    expect(patternOf('decide')).toEqual([RPC_PATTERNS.robotDecide]);
    expect(patternOf('availability')).toEqual([RPC_PATTERNS.robotAvailability]);
  });

  it('robot.acquire：`{ok:true, data:{bots}}` 逐字照 §4.2，且载荷原样透传', async () => {
    await expect(controller.acquire({ roomCode: 'R1', seats: [1] })).resolves.toEqual({
      ok: true,
      data: { bots: [{ botId: 'bot-1', displayId: 'p_1' }] },
    });
    expect(svc.acquire).toHaveBeenCalledWith({ roomCode: 'R1', seats: [1] });
  });

  it('robot.release：`{ok:true, data:{released}}`', async () => {
    await expect(controller.release({ botIds: ['bot-1', 'bot-2'] })).resolves.toEqual({
      ok: true,
      data: { released: 2 },
    });
  });

  it('robot.decide：`{ok:true, data}` 逐字透传决策结果', async () => {
    await expect(controller.decide({ roomCode: 'R1', botId: 'bot-1' } as never)).resolves.toEqual({
      ok: true,
      data: { kind: 'pass', source: 'rule' },
    });
  });

  it('robot.availability：`{ok:true, data}` 逐字透传可用性判定（片② D5）', async () => {
    // 带 `reason` 走一遍：handler 自己不得增删字段（信封只加 `ok/data` 这一层）。
    svc.availability.mockResolvedValueOnce({ canProvide: false, reason: 'douzero-unreachable' });
    await expect(controller.availability({})).resolves.toEqual({
      ok: true,
      data: { canProvide: false, reason: 'douzero-unreachable' },
    });
  });

  it('R220：业务抛错收敛成 `{ok:false, code}` —— **不抛裸错**，5 位数字码原样过界', async () => {
    svc.acquire.mockRejectedValueOnce(
      Object.assign(new Error('pool exhausted'), { code: ErrCode.UPSTREAM_UNAVAILABLE }),
    );
    await expect(controller.acquire({ roomCode: 'R1', seats: [1] })).resolves.toEqual({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: 'pool exhausted',
    });

    // 无 `code` 的裸错归 ILLEGAL_ACTION(13001)，与 game-service 侧**逐字同码**
    svc.decide.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.decide({ roomCode: 'R1', botId: 'bot-1' } as never)).resolves.toEqual({
      ok: false,
      code: ErrCode.ILLEGAL_ACTION,
      message: 'boom',
    });
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * **判据 7（单测半边）/ R1107**：接收侧把**处理期间**的日志挂到调用方那条链上。
   * ─────────────────────────────────────────────────────────────────────────
   *
   * 观测口与 `robot.pool.test.ts` 的判据 11 同款：`Logger.overrideLogger` 装捕获 sink
   * ——Nest 的 logger 是**进程级**的（`staticInstanceRef`），业务侧 `new Logger(...)`
   * 打的行也进同一个 sink。
   *
   * ⚠️ **三个 handler 逐个来**（不是只测一个）：计划的要求是「7 个 handler 各传一个
   * `dto?.meta`」——只测 acquire 的话，漏传 release/decide 在单测层是**隐形**的。
   * 漏掉任何一个，它那条日志的 traceId 就是 null ⇒ 下面按 handler 命名的断言必红。
   *
   * ⚠️ 替身里**必须真的打一行**：handler 本身不产生日志，真实链上的行来自被它包住的
   * 业务层（`robot.pool.ts:153` 的 `Acquired bot …`、`:180` 的 `Released bot …`、
   * `RobotService.decide()` 的 `Bot … decided …`）。替身不打 ⇒ `records` 是空的 ⇒
   * 判据退化成在**空集**上做断言（与 ALS 毫无关系的假绿/假红）。
   */
  it('判据 7 的一半：handler 处理期间的日志带调用方传的 traceId 与 source=rpc', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'robot-service' }));
    const META = { traceId: 'T7', reqId: 'R7' };
    // 三个替身各自在生产同形的日志点打一行
    svc.acquire.mockImplementationOnce(async () => {
      new Logger('RobotPool').log('Acquired bot bot-1 (p_1) for R1 seat 1');
      return { bots: [{ botId: 'bot-1', displayId: 'p_1' }] };
    });
    svc.release.mockImplementationOnce(async () => {
      new Logger('RobotPool').log('Released bot bot-1 back to the pool (idleSince=1)');
      return { released: 1 };
    });
    svc.decide.mockImplementationOnce(async () => {
      new Logger('RobotService').log('Bot bot-1 decided pass (source=rule, cards=0)');
      return { kind: 'pass', source: 'rule' };
    });

    // ⚠️ 载荷**带类型**（不写 `as never`）⇒ `meta` 字段本身也被类型层钉住
    //    （若协议里没有 `meta`，这一行编译不过，而 `as never` 会把它藏起来）。
    const cases: Array<{ handler: string; invoke: () => Promise<unknown>; msg: string }> = [
      {
        handler: 'robot.acquire',
        msg: 'Acquired bot',
        invoke: () => controller.acquire({ roomCode: 'R1', seats: [1], meta: META }),
      },
      {
        handler: 'robot.release',
        msg: 'Released bot',
        invoke: () => controller.release({ botIds: ['bot-1'], meta: META }),
      },
      {
        handler: 'robot.decide',
        msg: 'decided pass',
        invoke: () => controller.decide({ roomCode: 'R1', botId: 'bot-1', meta: META } as never),
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
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'robot-service' }));
    svc.acquire.mockImplementationOnce(async () => {
      new Logger('RobotPool').log('Acquired bot bot-1 (p_1) for R1 seat 1');
      return { bots: [{ botId: 'bot-1', displayId: 'p_1' }] };
    });

    await controller.acquire({ roomCode: 'R1', seats: [1] }); // 载荷里**没有** meta

    const line = records.find((r) => r.msg.includes('Acquired bot'));
    expect(line, '处理期间的日志不在捕获 sink 里 —— 判据空转，先查观测口').toBeDefined();
    // 不编造 id（R1107）；但「我在处理一次 RPC」这个**来源**仍在 ⇒ source 是 `rpc`
    //（若它变成 `bootstrap`/`edge`，说明包裹点没生效或降级口径写错）。
    expect(line!.traceId).toBeNull();
    expect(line!.source).toBe('rpc');
  });
});

/**
 * R218：被 TCP RPC 取代的三条**内部 HTTP 路由必须整条消失**。
 *
 * ⚠️ 这条闸是**门禁期实测逼出来的**：后端 agent 漏删了 `acquire`/`release`/`decide`
 * 三条 `@Post`，而当时**没有任何单测**看得见 —— `robot.rpc.test.ts` 只测 RPC 控制器
 * （元数据 + 信封），`robot.decide.test.ts` 的 ⑤ 测的是 `helpers/internal-token-harness`
 * 自己挂的一个**假路由**，与真实 `RobotController` 无关。于是「同一语义两条通道」
 * （R218 明确禁止的第二真源）在单测层完全隐形，直到 `slice-07.2-rpc` 第 5 组
 * 在 `direct3005 POST /api/robots/acquire → 200` 上确定性红才暴露。
 *
 * ─── 判据形态：**真的把真实控制器挂起来发 HTTP**，而不是读装饰器元数据 ──────
 * 初稿用 `Reflect.getMetadata('path', …)` 读 `@Post` 的路由串，实测该元数据在本仓的
 * 编译链下**读不到**（`getOwnMetadataKeys` 为空）⇒ 判据会退化成恒真/恒假。
 * 改成「真 HTTP 请求」后，它测的就是**产品行为**（路由在不在），
 * 而且与 `slice-07.2-rpc` 第 5 组的判据同源。
 *
 * ① 反向：三条被删路由（带**正确**内部 token、**合法** body）必须 **404**
 *    —— 401/400 都说明路由还在（分别是「缺 token」与「DTO 不合法」）；
 * ② 正向对照：`list`/`create` 仍在且可达（证明这个探针**打得到**产品路由，
 *    不是因为整个 app 起不来才「全是 404」；R115 的判别力要求）。
 */
describe('R218：robot-service 的内部 HTTP 路由必须整条删除（N20/P4）', () => {
  let app: INestApplication | undefined;
  let baseUrl = '';
  const TOKEN = 'r218-internal-token';

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    const svc = {
      acquire: vi.fn(async () => ({ bots: [] })),
      release: vi.fn(async () => ({ released: 0 })),
      decide: vi.fn(async () => ({ kind: 'pass', source: 'rule' })),
      createBot: vi.fn(async () => ({ botId: 'bot-1', displayId: 'p_1' })),
      removeBot: vi.fn(async () => 1),
      getAllBots: vi.fn(async () => []),
    };
    // ⚠️ 只挂**真实**的 `RobotController`（HTTP 面），业务实现是替身 ——
    //    本判据问的是「路由在不在」，不是「业务对不对」。
    const mod = await Test.createTestingModule({
      controllers: [RobotController],
      providers: [{ provide: RobotService, useValue: svc }],
    }).compile();
    app = mod.createNestApplication();
    app.use(createInternalTokenMiddleware());
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    const url = await app.getUrl();
    baseUrl = url.replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  async function post(path: string, body: unknown): Promise<number> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': TOKEN },
      body: JSON.stringify(body),
    });
    return res.status;
  }

  it('① 反向：acquire / release / decide 的 HTTP 路由必须 404（带正确 token + 合法 body）', async () => {
    // body 用**合法**形状：非法 body 会得到 400，那不是「路由已删」的证据。
    expect(
      await post('/api/robots/acquire', { roomCode: 'R218', seats: [1] }),
      'POST /api/robots/acquire 仍在（R218：内部面只保留 TCP RPC）—— 200/201 或 400/401 都说明路由还在',
    ).toBe(404);
    expect(
      await post('/api/robots/release', { botIds: ['bot-00000000'] }),
      'POST /api/robots/release 仍在',
    ).toBe(404);
    expect(
      await post('/api/robots/decide', {
        roomCode: 'R218',
        botId: 'bot-00000000',
        skillLevel: 'beginner',
        view: {},
        features: {},
      }),
      'POST /api/robots/decide 仍在',
    ).toBe(404);
  });

  it('② 正向对照：仍在的路由可达（证明探针真的打得到产品路由，不是整个 app 没起来）', async () => {
    // ⚠️ 用**不带 token** 的请求作正对照：仍存在的路由会先被中间件拦成 **401**，
    //    而被删的路由是 **404**（路由不存在 ⇒ 中间件后面没有 handler）。
    //    401 vs 404 恰好把「路由还在」与「路由已删」区分开，且**不经过业务实现**
    //    （业务是替身，别让替身的返回值干扰这条判据）。
    const listNoToken = await fetch(`${baseUrl}/api/robots/list`);
    expect(
      listNoToken.status,
      'GET /api/robots/list 既不是 401（路由在、被中间件拦）也不是预期形态 —— 正对照失效',
    ).toBe(401);

    const createNoToken = await fetch(`${baseUrl}/api/robots/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: 'R218', seat: 1 }),
    });
    expect(createNoToken.status, 'POST /api/robots/create 不在（正对照失效）').toBe(401);

  });

  it('③ 三条语义仍然只由 @MessagePattern 承载（不是「连 RPC 也删了」）', () => {
    expect(patternOf('acquire')).toEqual([RPC_PATTERNS.robotAcquire]);
    expect(patternOf('release')).toEqual([RPC_PATTERNS.robotRelease]);
    expect(patternOf('decide')).toEqual([RPC_PATTERNS.robotDecide]);
  });
});
