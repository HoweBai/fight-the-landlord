/**
 * **容器门禁**（R216/R217 同族，协调者复核源码时点名）。
 *
 * ─── 这条闸要抓的具体缺陷 ─────────────────────────────────────────────
 * `ws.gateway.ts` **早就**用 `@Optional() robot?: RobotClient` 注入 `ROBOT_CLIENT`，
 * 而 `ws.module.ts` **从来没有**提供它 ⇒ 容器里 `this.robot === undefined` ⇒
 * `game.ended` 分支的 `robot.release()`（§9.6 归池）**在生产路径上一次都没跑过**；
 * 只有单测手工 `new WsGateway(..., fakeRobot)` 时才工作。
 *
 * 这与两个前科完全同族：
 *  - R216：`GameClient` 用 `useClass` ⇒ 启动即崩（`Nest can't resolve dependencies`），
 *    而**所有单测全绿**（单测直接 `new GameClient(fake)`，不经容器）；
 *  - R217：`RobotPool` 缺 `@Injectable()` ⇒ `this.redis === undefined` ⇒ 运行期 500，
 *    单测同样全绿。
 *
 * ⇒ **只有真 compile 才能抓到**。本片（N20/P4 Task 3）已把两个客户端注册进
 * `RpcClientsModule` 并**删掉**了构造参数上的 `@Optional()`（缺 provider 时启动即崩）。
 *
 * ─── 为什么只 compile 装配子集而不是整个 `WsModule` ──────────────────────
 * `WsModule` 会拉起 `MatchModule` / `ReconnectModule` / `RoomsModule` 与**真 Redis 连接**
 * （`WsGateway` 构造函数里 `new Redis(...)`、`RedisProviderModule` 建客户端）。
 * 本文件要钉的是 **DI 图**，不是 Redis 连接 —— 因此按计划 Task 3 Step 1 的授权，
 * 「退一步只 compile 一个只含 `ClientsModule.register(...) + 两个 provider` 的最小模块」，
 * 并且**用 `overrideProvider` 把两个裸 proxy token 换成替身**，
 * 让**真实的** `useFactory` 跑起来（这是判据能成立的关键：不是复制粘贴一份工厂，
 * 而是让 `RpcClientsModule` 里那两行真的执行）。
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RpcClientsModule } from '../src/gateway/rpc-clients.module';
import {
  CONFIG_RPC_PROXY,
  GAME_RPC_PROXY,
  RECORD_RPC_PROXY,
  ROBOT_RPC_PROXY,
} from '../src/gateway/rpc.options';
import { ConfigClient } from '../src/gateway/config.client';
import { GameClient } from '../src/gateway/game.client';
import { RiskClient } from '../src/gateway/risk.client';
import { RobotClient } from '../src/gateway/robot.client';
import { GAME_CLIENT, ROBOT_CLIENT, WsGateway } from '../src/gateway/ws.gateway';
import { ConfigCacheService } from '../src/config/config-cache.service';
// ② 金币场 T4：WsGateway 的第 9/10 个构造依赖（装配门禁的判定对象）。
import { WsModule } from '../src/gateway/ws.module';
import { ConfigCacheModule } from '../src/config/config-cache.module';
import { CurrencyModule } from '../src/currency/currency.module';
import { CurrencyClient, ROOM_CURRENCY_RPC_PROXY } from '../src/currency/currency.client';
// ② 金币场 T5：WsGateway 的第 11 个构造依赖（结算服务）与 CurrencyModule 的两个新 provider。
import { SETTLE_ROBOT_HOOK, SettleService } from '../src/currency/settle.service';
import { SettleSweeper } from '../src/currency/settle.sweeper';
// ② 金币场 T6：机器人资金面（ensure + 结算钩子本体；`useExisting` 接缝的判定对象）。
import { RobotFunding } from '../src/currency/robot-funding';
import { RoomStartService } from '../src/rooms/rooms.start';
import { MatchModule } from '../src/match/match.module';
import { MatchService } from '../src/match/match.service';
import { RoomsModule } from '../src/rooms/rooms.module';
import { RoomsService } from '../src/rooms/rooms.service';
import { RoomsAutostartTask } from '../src/rooms/rooms.autostart';
import { RoomNicknamesService } from '../src/rooms/room-nicknames.service';
import { StartModule } from '../src/rooms/start.module';

/** 假的**裸** `ClientProxy`（就是 `ClientsModule.register` 本该提供的东西）。 */
const fakeProxy = (tag: string) => ({ tag, send: () => undefined });

describe('room-service 装配门禁：GAME_CLIENT / ROBOT_CLIENT（R216/R217 同族）', () => {
  it('容器里 `GameClient` / `RobotClient` 都是**真实例**（不是 undefined、不是裸 proxy）', async () => {
    const gameProxy = fakeProxy('game');
    const robotProxy = fakeProxy('robot');

    const mod = await Test.createTestingModule({ imports: [RpcClientsModule] })
      // 把 `ClientsModule.register()` 提供的裸 proxy 换成替身 —— 真实的 `useFactory` 仍会跑。
      .overrideProvider(GAME_RPC_PROXY)
      .useValue(gameProxy)
      .overrideProvider(ROBOT_RPC_PROXY)
      .useValue(robotProxy)
      .compile();

    const game = mod.get(GameClient);
    const robot = mod.get(RobotClient);

    expect(game).toBeInstanceOf(GameClient);
    expect(robot).toBeInstanceOf(RobotClient);
    // 风控 T3：第五对（`RiskClient` / `RISK_RPC_PROXY`）也必须被 `RpcClientsModule`
    // 真的提供（缺 provider ⇒ 真容器装配 `WsGateway` 启动即崩）。
    expect(mod.get(RiskClient)).toBeInstanceOf(RiskClient);
    // 反向判据：「包装类的位置被裸 proxy 占了」是同名 token 覆盖的经典症状
    expect(game).not.toBe(gameProxy);
    expect(robot).not.toBe(robotProxy);

    // 正向：包装类**真的**拿到了对应的裸 proxy（不是拿错了另一个）
    expect((game as unknown as { proxy: unknown }).proxy).toBe(gameProxy);
    expect((robot as unknown as { proxy: unknown }).proxy).toBe(robotProxy);

    await mod.close();
  });

  it('两个内部 token 与两个公开 token **互不相同**（否则包装 provider 会覆盖裸 proxy）', () => {
    expect(GAME_RPC_PROXY).not.toBe(ROBOT_RPC_PROXY);
    // 协调者点名的坑：`ClientsModule.register({name})` 与包装 provider 同名 ⇒
    // 后者覆盖前者，`inject` 解析到哪个取决于注册顺序。
    expect([GAME_CLIENT, ROBOT_CLIENT]).not.toContain(GAME_RPC_PROXY);
    expect([GAME_CLIENT, ROBOT_CLIENT]).not.toContain(ROBOT_RPC_PROXY);
  });

  /**
   * ⚠️ **门禁期实测补上的判据（这是本闸真正的漏洞）**。
   *
   * 上面第一条判据只证明「`RpcClientsModule` 提供了**类 token**」—— 而 `WsGateway`
   * 注入的是**字符串 token** `'ROOM_SERVICE_GAME_CLIENT'` / `'ROOM_SERVICE_ROBOT_CLIENT'`。
   * 两者是不同的 token，于是出现过这样的现场：**本文件全绿，而真容器启动即崩**：
   *
   *   `Nest can't resolve dependencies of the WsGateway (…, ?, ROOM_SERVICE_ROBOT_CLIENT).
   *    Please make sure that the argument "ROOM_SERVICE_GAME_CLIENT" at index [4] is available
   *    in the WsModule context.`
   *
   * 教训（R216/R217 同族第三次发作，且是**判据自身**的缺陷）：**「装配子集 compile 通过」
   * 不蕴含「真容器起得来」**。要抓这一类，判据必须用**消费方声明的 token**
   * （从 `WsGateway` 的依赖元数据里读出来）去 `get()`，而不是用我们自己挑的 token。
   */
  it('容器里能用 **WsGateway 声明的 token** 取到实例（不是用我们自己挑的 token 自证）', async () => {
    const mod = await Test.createTestingModule({ imports: [RpcClientsModule] })
      .overrideProvider(GAME_RPC_PROXY)
      .useValue(fakeProxy('game'))
      .overrideProvider(ROBOT_RPC_PROXY)
      .useValue(fakeProxy('robot'))
      .compile();

    // ① WsGateway 真正会注入的 token 必须**都能**解析（修前：这两行直接抛
    //    `Nest can't resolve dependencies ...`）
    const viaStringTokens = [GAME_CLIENT, ROBOT_CLIENT].map((token) => mod.get(token));
    expect(viaStringTokens[0]).toBeInstanceOf(GameClient);
    expect(viaStringTokens[1]).toBeInstanceOf(RobotClient);

    // ② 两条路径必须是**同一个实例**（`useExisting` 而不是复制一份）—— 否则单测与生产
    //    会各自持有一份客户端，`retry`/连接状态互不可见。
    expect(mod.get(GAME_CLIENT)).toBe(mod.get(GameClient));
    expect(mod.get(ROBOT_CLIENT)).toBe(mod.get(RobotClient));

    // ③ 反向（**这条才是抓「token 不匹配」的判据**）：把 `WsGateway` 声明的每一个
    //    `@Inject` token 拿去 `mod.get()`。修前必须**返回 undefined**（模块没有以那个 token 提供），
    //    而真容器在装配 `WsGateway` 时正是这样失败 ⇒ 启动即崩。
    //    ⚠️ 不要用「读我们自己的 exports 列表」来自证：那是自己给自己出题（判据会跟着实现漂移）。
    const selfDeps =
      (Reflect.getMetadata('self:paramtypes', WsGateway) as
        | Array<{ index: number; param: unknown }>
        | undefined) ?? [];
    const requiredTokens = selfDeps
      .map((d) => d.param)
      .filter((t): t is string => typeof t === 'string');
    // 正对照（R115）：循环必须真的读到两个字符串 token，否则本判据是空测。
    expect(
      requiredTokens.length,
      'WsGateway 的字符串 @Inject token 一个都没读出来 —— 判据失效（探针瞎了）',
    ).toBeGreaterThanOrEqual(2);
    for (const token of requiredTokens) {
      expect(
        mod.get(token),
        `WsGateway 声明要注入 ${token}，但 RpcClientsModule 没有以该 token 提供任何东西 ` +
          '—— 真容器装配 WsGateway 时会启动即崩（Nest can\'t resolve dependencies）',
      ).toBeDefined();
    }

    await mod.close();
  });

  /**
   * 结构性判据：`WsGateway` 的**构造参数**确实声明了这两个 token 的注入，
   * 且**不再**带 `@Optional()`。
   *
   * ⚠️ 为什么需要它：上面那条判据证明「这套装配是通的」，但证明不了
   * **`WsGateway` 真的要求它们** —— 若有人把 `@Optional()` 加回去，
   * `ROBOT_CLIENT` 缺席时容器会静默注入 `undefined`，上面那条**照样绿**
   * 而归池路径又整条消失（正是本闸要防的原始缺陷）。
   */
  it('结构性：WsGateway 的构造参数要求 GAME_CLIENT + ROBOT_CLIENT，且**没有** @Optional', () => {
    // ⚠️ 判据要**分别**证明两件事，因此两个元数据键都要读（P18/N41 升级后的形态）：
    //
    //  ① `self:paramtypes`（`@Inject(...)` 写的自有依赖元数据）—— **谁被注入**。
    //     字符串 token 的身份**只**在这里有（见 ②），所以这条通道不可替代。
    //  ② `design:paramtypes`（`emitDecoratorMetadata` 的产物）—— **构造签名有几个参数、各自什么类型**。
    //
    // 升级前（P18 之前）这里写的是「**不能**读 `design:paramtypes`：Vitest/esbuild 不发出后者，
    // 即便发出了，字符串 token 的位置也只会是 `Object`，断言不出 token 身份」。
    // **实测证明那两半现在都不成立**（P18 让测试环境真的发出该元数据）：
    //   - `Reflect.getMetadata('design:paramtypes', WsGateway)` 实测 6 个元素、非 `undefined`；
    //   - 下标 4/5（`@Inject(GAME_CLIENT)` / `@Inject(ROBOT_CLIENT)`）拿到的是**真实的类引用**
    //     `GameClient` / `RobotClient`（不是 `Object`）：tsc 对 `@Inject` 参数**也**发类型元数据
    //     ⇒ 字符串 token 的身份确实**仍然**只能从 `self:paramtypes` 读（因此不能删掉那条），
    //     但「签名里有几个参数、token 落在哪几个下标上」现在**可以**机械证明。
    // ⇒ 升级后**同时**钉住两条通道，比升级前强（升级前完全没碰 `design:paramtypes`）。
    const selfDeps =
      (Reflect.getMetadata('self:paramtypes', WsGateway) as
        | Array<{ index: number; param: unknown }>
        | undefined) ?? [];
    const injectedTokens = selfDeps.map((d) => d.param);
    expect(injectedTokens).toContain(GAME_CLIENT);
    expect(injectedTokens).toContain(ROBOT_CLIENT);

    /**
     * ① 构造参数的**类型**元数据：必须真的发出，且长度与构造签名一致。
     *
     * ⚠️ 本片（spec §2.2 / R902）：`WsGateway` 多了第 5 个参数 `RoomStartService`
     *（`room.join` 成功后若房间满，**同步**触发开局）⇒ 6 → **7**。
     * ⚠️ 记录片 T5（设计 D2）：又多了第 8 个参数 `@Inject(RECORD_CLIENT)`（`record.write`
     * 投递）⇒ 7 → **8**。
     * ⚠️ **② 金币场 T4**：又多了第 9/10 个参数 —— `ConfigCacheService`（`room.match`
     * 双开关读面 C1/C2）与 `CurrencyClient`（门槛读边 C4）⇒ 8 → **10**。
     * ⚠️ **② 金币场 T5**：又多了第 11 个参数 `SettleService`（`finalizeRoomEnd` 的
     * `:809` 位结算 + 构造期 `bindBroadcast`）⇒ 10 → **11**。
     * ⚠️ **风控 T3**：又多了第 12 个参数 `RiskClient`（`room.match` 入队成功后的
     * `risk.deviceReport` 上报，经 `routerDeps()` 下传）⇒ 11 → **12**。
     * 这条断言的作用没变：**构造签名一变就必须有人来看一眼**，不能悄悄改。
     */
    const designTypes = Reflect.getMetadata('design:paramtypes', WsGateway) as unknown[] | undefined;
    expect(
      designTypes,
      'design:paramtypes 读不到 —— 测试环境没有发出 DI 元数据（检查 vitest.config.ts 的插件与 setupFiles）',
    ).toBeDefined();
    expect(designTypes).toHaveLength(13);

    // ②′ T4/T5 的三个新类 token：**身份**（不是「有个函数就行」）—— 与 design:paramtypes
    // 的机制自证同款（`@Inject` 参数两侧都有元数据；`import type` 写错会把这里变成 undefined）。
    expect(designTypes?.[8], '第 9 个参数必须是 ConfigCacheService（T4 双开关读面）').toBe(
      ConfigCacheService,
    );
    expect(designTypes?.[9], '第 10 个参数必须是 CurrencyClient（T4 门槛读边）').toBe(CurrencyClient);
    expect(designTypes?.[10], '第 11 个参数必须是 SettleService（T5 结算入口）').toBe(SettleService);
    expect(designTypes?.[11], '第 12 个参数必须是 RiskClient（风控 T3 上报客户端）').toBe(RiskClient);
    expect(designTypes?.[12], '第 13 个参数必须是 RoomNicknamesService（昵称缓存）').toBe(
      RoomNicknamesService,
    );

    // ② `self:paramtypes` 里的每个 token 下标，在 `design:paramtypes` 里都有对应的**真实类引用**
    //    （不是 `Object`、不是 `undefined`）—— 「token 落在了签名里」的机械证明。
    //    这条同时钉住「`@Inject(字符串 token)` 的参数仍然有类型元数据」这个事实，
    //    它是上面那段注释的依据；若哪天形态变了，这里会红而不是让注释悄悄过期。
    for (const dep of selfDeps) {
      expect(
        typeof designTypes?.[dep.index],
        `token ${String(dep.param)} 所在下标 [${dep.index}] 的 design:paramtypes 不是函数（类引用）`,
      ).toBe('function');
    }

    // `@Optional()` 写的是 `optional:paramtypes` —— 必须为空（或至少不含这两个下标）
    const optionalParams =
      (Reflect.getMetadata('optional:paramtypes', WsGateway) as
        | Array<{ index: number; param: unknown }>
        | undefined) ?? [];
    const optionalTokens = optionalParams.map((d) => d.param);
    expect(
      optionalTokens,
      'WsGateway 上又出现了 @Optional() —— ROBOT_CLIENT 缺席时会被静默注入 undefined（归池路径消失）',
    ).not.toContain(ROBOT_CLIENT);
    expect(optionalTokens).not.toContain(GAME_CLIENT);
  });
});

/**
 * **同一族的第二处**（片规格 §2.1 / Task 2；T7 换依赖为 `ConfigCacheService`）：
 * `RoomsService` 的构造依赖从 `ConfigClient` 换成了 `ConfigCacheService`
 *（建房时的底分校验改走快照缓存 —— T6 落地、T7 重接线）。
 *
 * ⚠️ 为什么必须有这条：单测**全部**直接 `new RoomsService(fakeRedis, fakeCache)` ——
 * **不经容器** ⇒ 少提供 / 少导出 `ConfigCacheService` 时单测照样全绿，而容器启动即崩
 *（原文形态见上面 R216：`Nest can't resolve dependencies of the RoomsService (Redis, ?)`）。
 * 判据照本文件上半部分的形态：**真的 compile** `RoomsModule`，并把三个裸 proxy 换成替身
 *（让 `RpcClientsModule` 里那三条 `useFactory` 真的执行）；`RoomsReaperTask` 与
 * `RoomsController` 的同一依赖由这次 compile 顺带钉住（模块装不起来就会在这里崩）。
 *
 * ⚠️ 这条断言同时钉住 T7 的三处装配（`RoomsModule` / `StartModule` / `MatchModule` 都要
 * import `ConfigCacheModule`）的一半 —— 另两半见下面两条 describe。
 */
describe('room-service 装配门禁：RoomsService 的 ConfigCacheService 依赖（R216/R217 同族）', () => {
  it('RoomsModule 装得起来，且 RoomsService 真的拿到 ConfigCacheService（不是 undefined、不是裸 proxy）', async () => {
    const configProxy = fakeProxy('config');
    const mod = await Test.createTestingModule({ imports: [RoomsModule] })
      // `RedisProviderModule` 的工厂会**真连** Redis（`new Redis(...)`）⇒ 换掉；
      // 三个裸 proxy 同理（它们会去连各自的 TCP 端口）。
      .overrideProvider(Redis)
      .useValue({})
      .overrideProvider(GAME_RPC_PROXY)
      .useValue(fakeProxy('game'))
      .overrideProvider(ROBOT_RPC_PROXY)
      .useValue(fakeProxy('robot'))
      .overrideProvider(CONFIG_RPC_PROXY)
      .useValue(configProxy)
      .compile();

    const rooms = mod.get(RoomsService);
    expect(rooms).toBeInstanceOf(RoomsService);

    const injected = (rooms as unknown as { configCache: unknown }).configCache;
    expect(injected, 'RoomsService.configCache 是 undefined —— 容器少给了依赖').toBeInstanceOf(
      ConfigCacheService,
    );
    // 正向：拿到的**就是**挂在 config 那条边上的缓存（ConfigCacheService → ConfigClient → config 裸 proxy，
    // 不是拿错了 game / robot 的）—— 两层都扒开，证明整条链真的接到了被替换的那个 proxy。
    const client = (injected as { client: unknown }).client;
    expect(client, 'ConfigCacheService 的传输层不是 ConfigClient').toBeInstanceOf(ConfigClient);
    expect((client as unknown as { proxy: unknown }).proxy).toBe(configProxy);

    await mod.close();
  });
});

/**
 * **T7 的第三处**（同族）：`RoomsAutostartTask` 也注入了 `ConfigCacheService`
 *（发条从 env 常量换成 `cycleMs('room.autostartIntervalMs')`）⇒ `StartModule` 必须
 * import `ConfigCacheModule`。单测同样绕容器，只有真 compile 能抓到缺 import。
 */
describe('room-service 装配门禁：RoomsAutostartTask 的 ConfigCacheService 依赖（R216/R217 同族）', () => {
  it('StartModule 装得起来，且 RoomsAutostartTask 真的拿到 ConfigCacheService', async () => {
    const mod = await Test.createTestingModule({ imports: [StartModule] })
      .overrideProvider(Redis)
      .useValue({})
      .overrideProvider(GAME_RPC_PROXY)
      .useValue(fakeProxy('game'))
      .overrideProvider(ROBOT_RPC_PROXY)
      .useValue(fakeProxy('robot'))
      .overrideProvider(CONFIG_RPC_PROXY)
      .useValue(fakeProxy('config'))
      .compile();

    const task = mod.get(RoomsAutostartTask);
    expect(task).toBeInstanceOf(RoomsAutostartTask);

    const injected = (task as unknown as { configCache: unknown }).configCache;
    expect(
      injected,
      'RoomsAutostartTask.configCache 是 undefined —— StartModule 少 import 了 ConfigCacheModule',
    ).toBeInstanceOf(ConfigCacheService);
    /**
     * ② T5：`RoomStartService` 注入 `CurrencyClient`（金币房开局三座余额下发）⇒
     * `StartModule` 必须 import `CurrencyModule`（Nest 可见性只看本模块 imports 的 exports ——
     * `RpcClientsModule` 不会把它传递出来）。少 import ⇒ 真容器启动即崩，单测 `new` 全绿看不见。
     */
    const start = mod.get(RoomStartService);
    expect(start).toBeInstanceOf(RoomStartService);
    const injectedCurrency = (start as unknown as { currency: unknown }).currency;
    expect(
      injectedCurrency,
      'RoomStartService.currency 是 undefined —— StartModule 少 import 了 CurrencyModule',
    ).toBeInstanceOf(CurrencyClient);
    /**
     * ② T6：`RoomStartService` 还注入 `RobotFunding`（金币场补位后的 ensure 边）⇒
     * 同一可见性规则：`CurrencyModule` 必须 **export** 它。并且它必须与结算钩子
     * 是**同一个单例**（`useExisting` 的全链闭合 —— ensure 边与收尾③边共享状态）。
     */
    const injectedFunding = (start as unknown as { robotFunding: unknown }).robotFunding;
    expect(
      injectedFunding,
      'RoomStartService.robotFunding 是 undefined —— CurrencyModule 少 export 了 RobotFunding',
    ).toBeInstanceOf(RobotFunding);
    expect(
      injectedFunding,
      'ensure 边（RoomStartService）与结算钩子（SettleService）必须是同一个 RobotFunding 实例',
    ).toBe(mod.get(RobotFunding));
    const imports = (Reflect.getMetadata('imports', StartModule) as unknown[] | undefined) ?? [];
    expect(imports).toContain(CurrencyModule);

    await mod.close();
  });
});

/**
 * **同一族的第三处**（片规格 §2.5 / Task 3b；T7 换依赖为 `ConfigCacheService`）：
 * `MatchService` 的档位校验也改走快照缓存（入队前的底分校验，与建房路径同一张表）。
 *
 * ⚠️ 与本文件上半部分同一条理由：单测**全部**直接 `new MatchService(fakeRedis, …, fakeCache)`
 * —— **不经容器** ⇒ 少提供 / 少导出 `ConfigCacheService`（或把它写成 `import type` ⇒ 元数据变成
 * `Object`）时单测照样全绿，而容器启动即崩（R216/R217 同族，本仓已三次发作）。
 * ⚠️ 本次 compile 还会实例化 `MatchModule` 自己那份 `RoomsService`（providers 里声明的）
 * ⇒ 顺带钉住「`MatchModule` 也 import 了 `ConfigCacheModule`」。
 */
describe('room-service 装配门禁：MatchService 的 ConfigCacheService 依赖（R216/R217 同族）', () => {
  it('MatchModule 装得起来，且 MatchService 真的拿到 ConfigCacheService（不是 undefined、不是裸 proxy）', async () => {
    const configProxy = fakeProxy('config');
    const mod = await Test.createTestingModule({ imports: [MatchModule] })
      // 与上面两处同形：`RedisProviderModule` 的工厂会**真连** Redis、三个裸 proxy 会去连 TCP 端口。
      .overrideProvider(Redis)
      .useValue({})
      .overrideProvider(GAME_RPC_PROXY)
      .useValue(fakeProxy('game'))
      .overrideProvider(ROBOT_RPC_PROXY)
      .useValue(fakeProxy('robot'))
      .overrideProvider(CONFIG_RPC_PROXY)
      .useValue(configProxy)
      .compile();

    const match = mod.get(MatchService);
    expect(match).toBeInstanceOf(MatchService);

    const injected = (match as unknown as { configCache: unknown }).configCache;
    expect(injected, 'MatchService.configCache 是 undefined —— 容器少给了依赖').toBeInstanceOf(
      ConfigCacheService,
    );
    // 正向：拿到的**就是**挂在 config 那条边上的缓存（两层都扒开，证明整条链真的接到了被替换的 proxy）
    const client = (injected as { client: unknown }).client;
    expect(client, 'ConfigCacheService 的传输层不是 ConfigClient').toBeInstanceOf(ConfigClient);
    expect((client as unknown as { proxy: unknown }).proxy).toBe(configProxy);

    await mod.close();
  });
});

/**
 * **② 金币场 T4**：`WsGateway` 多了第 9/10 个构造依赖（`ConfigCacheService` +
 * `CurrencyClient`，见上面 `toHaveLength(10)` 的那条）—— 两处装配新面必须各有判据：
 *
 *  ① `CurrencyModule` **装得起来**且 `CurrencyClient` 是真的包装类
 *    （`useFactory` 把裸 proxy 包住；R216：`useClass`/字符串 token 撞车的形态在这里现形）；
 *  ② `WsModule` 的 `imports` **包含提供这两个依赖的模块** —— Nest 的可见性只看
 *    「本模块 imports 的 exports」：`MatchModule` 只 export `MatchService`，
 *    **不会**把 `ConfigCacheService` 传递出来 ⇒ 少 import 一行就真容器启动即崩
 *    （`Nest can't resolve dependencies of the WsGateway (…, ?)`），而单测直接
 *    `new WsGateway(...)` 全绿看不见 —— 与 `ROBOT_CLIENT` 三次发作同一形态。
 */
describe('room-service 装配门禁：CurrencyModule + WsModule 的新依赖 import（② T4/T5）', () => {
  it('CurrencyModule 装得起来，且 CurrencyClient 包住的是被替换的裸 proxy（R216）；SettleService/SettleSweeper 是真实例', async () => {
    const currencyProxy = fakeProxy('currency');
    const mod = await Test.createTestingModule({ imports: [CurrencyModule] })
      // T5 起 CurrencyModule 还装配结算链：`SettleSweeper` 注入 Redis、`SettleService`
      // 注入 RecordClient/ConfigCacheService ⇒ 裸 proxy 与 Redis 都要换替身（否则真连 TCP/Redis）。
      .overrideProvider(Redis)
      .useValue({})
      .overrideProvider(GAME_RPC_PROXY)
      .useValue(fakeProxy('game'))
      .overrideProvider(ROBOT_RPC_PROXY)
      .useValue(fakeProxy('robot'))
      .overrideProvider(CONFIG_RPC_PROXY)
      .useValue(fakeProxy('config'))
      .overrideProvider(RECORD_RPC_PROXY)
      .useValue(fakeProxy('record'))
      .overrideProvider(ROOM_CURRENCY_RPC_PROXY)
      .useValue(currencyProxy)
      .compile();

    const client = mod.get(CurrencyClient);
    expect(client).toBeInstanceOf(CurrencyClient);
    // 反向：「包装类的位置被裸 proxy 占了」= 内部 token 与类 token 同名覆盖的经典症状。
    expect(client).not.toBe(currencyProxy);
    // 正向：包装类**真的**拿到了对应的裸 proxy。
    expect((client as unknown as { proxy: unknown }).proxy).toBe(currencyProxy);

    // ② T5：两个新 provider 必须真的可解析（缺 provider/import ⇒ 这里就崩，
    // 而不是等到真容器装配 `WsGateway` 时说「Nest can't resolve dependencies」）。
    expect(mod.get(SettleService)).toBeInstanceOf(SettleService);
    expect(mod.get(SettleSweeper)).toBeInstanceOf(SettleSweeper);

    /**
     * ② T6：机器人资金面 provider 可解析，且 **T5 留的钩子 token 必须解析到同一个实例**
     *（`useExisting: RobotFunding` 的收口判据 —— no-op 替身没换掉、或 useClass/useValue
     * 复制成第二份实例，都会在这里现形；两处消费方 `SettleService`（收尾③）与
     * `RoomStartService`（ensure 边）共享的正是这一个单例）。
     */
    const funding = mod.get(RobotFunding);
    expect(funding).toBeInstanceOf(RobotFunding);
    expect(
      mod.get(SETTLE_ROBOT_HOOK),
      'SETTLE_ROBOT_HOOK 必须 useExisting 指向 RobotFunding（同一个实例）',
    ).toBe(funding);

    await mod.close();
  });

  it('结构性：WsModule 的 imports 含 ConfigCacheModule 与 CurrencyModule（缺一行 ⇒ 真容器启动即崩）', () => {
    // ⚠️ 这条读的是 `@Module` 装饰器落下的 `imports` 元数据（Nest 装配 WsGateway 时
    // 用的就是它）——**不 compile 整个 WsModule**：`WsGateway` 的构造函数会
    // `new Redis(...)` 真连接（本文件头注写死的规避理由），编译它会把真连接带进来。
    const imports = (Reflect.getMetadata('imports', WsModule) as unknown[] | undefined) ?? [];
    expect(imports, 'WsModule.imports 读不到 —— 判据失效（探针瞎了，不是被测代码坏了）').not.toHaveLength(0);
    expect(imports, 'WsGateway 注入 ConfigCacheService ⇒ WsModule 必须 import 它').toContain(
      ConfigCacheModule,
    );
    expect(imports, 'WsGateway 注入 CurrencyClient ⇒ WsModule 必须 import 它').toContain(
      CurrencyModule,
    );
  });
});
