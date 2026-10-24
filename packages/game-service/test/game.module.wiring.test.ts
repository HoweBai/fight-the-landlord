/**
 * **容器门禁**（R216/R217 同族）：`robot.decide` 的 `ClientProxy` **真的**装配进了
 * `GameService` 吗？
 *
 * 为什么必须有这一条：本仓已经**两次**栽在同一处 ——
 *  - R216：`GameClient` 用 `useClass` ⇒ 启动即崩（`Nest can't resolve dependencies`），
 *    而**所有单测全绿**，因为单测直接 `new GameClient(fake)`，根本不经容器；
 *  - R217：`RobotPool` 缺 `@Injectable()` ⇒ `this.redis === undefined` ⇒ 运行期 500，
 *    单测同样全绿（`new RobotPoolService(fake)`）。
 *
 * ⚠️ 本片（N20/P4 Task 4）把 `robot.decide` 从 `fetch` 换成 `ClientProxy`：若装配没接上，
 * `GameService.robotClient` 会是 `null` ⇒ **每一个机器人回合都静默回退本地规则引擎**：
 * 对局照跑完（「看起来正常」），RPC 通道却整条是死的，而 `game.robot.test.ts` 全部用替身
 * ⇒ **一条都不会红**。因此这里 `Test.createTestingModule` **真的 compile** 那段装配，
 * 并且**真的驱动一次机器人回合**走完 `GameService → RobotClient → ClientProxy.send()`。
 *
 * ⚠️ 只 compile **装配子集**（不 compile 整个 `AppModule`）。R284 之后 `GameService`
 * 的 Redis 是**构造注入**（`@Inject(Redis)`）⇒ 本文件必须显式提供那个 token
 * （下面给的是 `vi.mock('ioredis')` 的替身）—— 要钉的是 **DI 图**，不是 Redis 连接。
 * `ClientsModule` 用 `ROBOT_RPC_PROXY` 的替身替掉。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameState } from '@fight-the-landlord/shared';
import { RPC_PATTERNS, type Card, type RpcResult, type RobotDecideResponse } from '@fight-the-landlord/protocol';
import { GameService } from '../src/game/game.service';
import { GameController } from '../src/game/game.controller';
import { GameRpcController } from '../src/rpc/game.rpc.controller';
import { RobotClient } from '../src/game/robot.client';
import { GameModule } from '../src/game/game.module';
import { ROBOT_RPC_PROXY } from '../src/rpc/rpc.options';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';
import { Redis } from 'ioredis';

/** R696：牌是 `{r, s}`。夹具只关心点数，故 `s` 取 0。（`RobotDecideResponse.cards` 仍是点数数组，不转。） */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/**
 * `ClientsModule` 提供的**原始 `ClientProxy`** 的替身。
 *
 * ⚠️ 它是 `ROBOT_RPC_PROXY` 这个**内部 token** 下的值，**不是** `RobotClient`
 * —— 本文件测的正是「包装 provider 能不能从**另一个** token 拿到它」，
 * 把两者混成一个 token 就测不到「同名覆盖」那个坑了（协调者点名的那个）。
 */
function makeFakeProxy(reply: () => RpcResult<RobotDecideResponse>) {
  const calls: Array<{ pattern: string; data: unknown }> = [];
  const proxy = {
    send: (pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      return of(reply());
    },
  } as unknown as ClientProxy;
  return { proxy, calls };
}

/** 与 `game.module.ts` 逐字同形的装配片段（改了那边这里也要改 —— 这就是判据的本意）。 */
async function compileAssembly(proxy: ClientProxy) {
  const mod = await Test.createTestingModule({
    controllers: [GameController, GameRpcController],
    providers: [
      GameService,
      { provide: ROBOT_RPC_PROXY, useValue: proxy },
      {
        provide: RobotClient,
        useFactory: (p: ClientProxy) => new RobotClient(p),
        inject: [ROBOT_RPC_PROXY],
      },
      // ⚠️ R284：`GameService` 的 Redis 连接现在是**构造注入**（`@Inject(Redis)`，
      // 由 `RedisProviderModule` 提供）⇒ 这段内联装配必须跟着补上同一个 token，
      // 否则 `Nest can't resolve dependencies of the GameService`（本文件的门禁
      // 正是为此存在：内联装配与生产装配漂移时，这里会红）。
      { provide: Redis, useValue: redisDouble },
    ],
  }).compile();
  return mod;
}

describe('GameModule 装配门禁（R216/R217 同族 / N20-P4 Task 4）', () => {
  beforeEach(() => {
    resetRedisDouble();
  });

  it('`moduleRef.get(RobotClient)` 是**真的** RobotClient 实例（不是 undefined / 不是裸 proxy）', async () => {
    const { proxy } = makeFakeProxy(() => ({ ok: true, data: { kind: 'pass', source: 'rule' } }));
    const mod = await compileAssembly(proxy);

    const client = mod.get(RobotClient);
    expect(client).toBeInstanceOf(RobotClient);
    // 反向判据：**不得**是那个裸 `ClientProxy`（同名 token 覆盖的经典症状）
    expect(client).not.toBe(proxy);

    await mod.close();
  });

  /**
   * **端到端装配判据**（本文件的核心）：走容器拿到 `GameService`，驱动一次机器人回合，
   * 断言那一次决策**真的**经 `ClientProxy.send(RPC_PATTERNS.robotDecide, …)` 出站，
   * 并且 DouZero 的应答**真的**被采纳。
   *
   * 判别力：「装配没接上」时（旧形态 `robotClient = new RobotClient()` 或 `null`）
   * `calls` 会是**空数组**、且落盘的是规则引擎的牌 —— 两条断言都会红。
   */
  it('端到端：容器装配的 GameService 驱动机器人回合 ⇒ 真的发 robot.decide 并采纳应答', async () => {
    // DouZero 给 9（规则引擎在同一局面会给 6 ⇒ 打出 9 证明应答被采纳）
    const { proxy, calls } = makeFakeProxy(() => ({
      ok: true,
      data: { kind: 'play', cards: [9], source: 'douzero' },
    }));
    const mod = await compileAssembly(proxy);
    const service = mod.get(GameService);
    service.robotDelay = async () => {}; // 0 思考延迟（§9.4 的可注入缝）

    await service.startGame({
      roomCode: 'WIRE01',
      baseScore: 100,
      players: [
        { id: 'p_bot0', seat: 0, isRobot: true, botId: 'bot-0', skillLevel: 'beginner' },
        { id: 'human-1', seat: 1, isRobot: false },
        { id: 'human-2', seat: 2, isRobot: false },
      ],
    });

    // ⚠️ 必须先把 `startGame()` 里那次 `void driveRobotTurn()` 放干净：
    // `GameService` 有**同房间串行闸**（`robotDriving`，R208），闸没释放时
    // 下面手动调 `driveRobotTurn()` 会直接 return（`calls` 为空 ⇒ 假红）。
    // 这与 `game.robot.test.ts` 的 `await flush()` 是同一件事（那边用假计时器，
    // 这里用真微任务队列即可）。
    for (let i = 0; i < 100; i += 1) await Promise.resolve();

    // 造一个「座位 0（机器人）跟单张 5」的出牌阶段局面（不依赖随机发牌）
    const base = (await service.getSession('WIRE01'))!;
    service['cache'].set('WIRE01', {
      ...base,
      state: GameState.Playing,
      currentPlayer: 0,
      lastPlayerIdx: 2,
      lastPlayedHand: { cards: h(5), type: 1, keyRank: 5, length: 0 },
      playPhase: { ...base.playPhase, consecutivePasses: 0 },
      actionLog: [],
      players: base.players.map((p) => (p.seat === 0 ? { ...p, hand: h(5, 6, 9) } : p)),
    });
    calls.length = 0;

    await service['driveRobotTurn']('WIRE01');

    // ① 正向：那次决策**真的**从 RPC 通道出去了（装配接上了）
    expect(calls.map((c) => c.pattern)).toContain(RPC_PATTERNS.robotDecide);
    expect(calls[0]!.data).toMatchObject({ roomCode: 'WIRE01', botId: 'bot-0' });

    // ② 正向：应答被采纳（9 而不是规则引擎会给的 6）
    const after = (await service.getSession('WIRE01'))!;
    expect(after.lastPlayedHand!.cards).toEqual(h(9));
    expect(after.players[0]!.hand).toEqual(h(5, 6));

    await mod.close();
  });

  /**
   * 正向元数据判据：`GameService` 声明了 `robotClient` 的容器注入点，且默认值是 `null`。
   *
   * ⚠️ 断言的是**元数据 + 默认值**而不是「碰巧有值」——
   * 默认 `null` 让「装配没接上」变成**可观测**（`driveOneRobotTurn` 记 error），
   * 而不是静默造一个「没有 proxy 的假客户端」。
   */
  it('正向：GameService 声明了 robotClient 的容器注入点，且默认值是 null（fail loud）', () => {
    // ⚠️ 属性注入的元数据写在**构造函数**上（`@Inject()` 的属性分支用 `target.constructor`），
    // 键名是 Nest 内部的 `PROPERTY_DEPS_METADATA = 'self:properties_metadata'`
    // （`@nestjs/common/constants`，未从包根导出 ⇒ 写字面量；与 `game.rpc.test.ts` 里
    // `'microservices:pattern'` 同一手法）。
    const propertyDeps = Reflect.getMetadata('self:properties_metadata', GameService) as
      | Array<{ key: string; type: unknown }>
      | undefined;
    expect(
      propertyDeps,
      'GameService 缺少属性注入元数据 —— robot.decide 客户端不会被装配进容器（R217 同族）',
    ).toBeDefined();
    expect(propertyDeps!.map((d) => d.key)).toContain('robotClient');

    expect(new GameService(redisDouble as unknown as Redis).robotClient).toBeNull();
  });

  /**
   * 结构性判据：**真实** `GameModule` 的元数据里（不是本文件抄的那份）确实声明了
   * `RobotClient` 的 `useFactory` + `inject: [ROBOT_RPC_PROXY]`。
   *
   * ⚠️ 为什么需要它：上面两条用的是本文件**内联**的 providers —— 它们能证明「这套装配
   * 是通的」，但**证明不了 `GameModule` 用的是这一套**。若有人把 `game.module.ts` 里的
   * `ROBOT_RPC_PROXY` 改回与包装类同名的 token（协调者点名的那个坑），上面两条会**照样绿**
   * 而生产装配已经坏了。因此这里直接读 `GameModule` 的模块元数据。
   */
  it('结构性：GameModule 的元数据里 RobotClient 走 useFactory + inject[ROBOT_RPC_PROXY]', () => {
    // `MODULE_METADATA.PROVIDERS = 'providers'`（`@nestjs/common/constants`）。
    const providers = (Reflect.getMetadata('providers', GameModule) ?? []) as Array<
      Record<string, unknown>
    >;
    const robotProvider = providers.find((p) => p['provide'] === RobotClient);
    expect(
      robotProvider,
      'GameModule 没有声明 RobotClient 的 provider —— robot.decide 不会被装配（R217 同族）',
    ).toBeDefined();
    expect(typeof robotProvider!['useFactory']).toBe('function');
    expect(robotProvider!['inject']).toEqual([ROBOT_RPC_PROXY]);

    // 反向：`ClientsModule.register` 用的 `name` **不得**与包装类同名（否则后者覆盖前者）。
    // 该名字由 `robotClientOptions()` 之外的常量钉住，这里从模块的 imports 反查不到字符串，
    // 因此改为断言「两个 token 不是同一个值」这一**不变量**。
    expect(ROBOT_RPC_PROXY).not.toBe(RobotClient);

    // 且 `ROBOT_RPC_PROXY` 确实是 `ClientsModule.register` 的 name（结构判据的收口）：
    // 它是字符串 token，`RobotClient` 是类 token ⇒ 二者永不相等。
    expect(typeof ROBOT_RPC_PROXY).toBe('string');
  });
});
