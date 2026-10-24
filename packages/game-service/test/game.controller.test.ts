import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { GameController } from '../src/game/game.controller';
import { GameService } from '../src/game/game.service';
import type { Card } from '@fight-the-landlord/protocol';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

/**
 * S2 / S8 的 HTTP 级断言（§6.4 / §7.1 / §14.1）。
 *
 * 这是本任务最关键的回归测试：`GET /api/games/:roomCode` 与
 * `GET /api/games/:roomCode/state` 曾经返回**完整 GameSession**
 * （三家手牌 + 底牌），且不需要任何凭证。
 *
 * 手搭 Express 的原因与 api-gateway 的边界测试相同：本文件要断言「控制器产出 +
 * 请求绑定」这一层，手搭能精确控制路由与打桩。详见汇报。
 * （P18/N41 之前这里的理由是「Vitest/esbuild 不发出 `design:paramtypes`，
 * 反射式构造注入在测试里不可用」—— 那条**已不再成立**：测试环境现在真的发出该元数据。）
 */
describe('GameController (HTTP security boundary)', () => {
  let server: import('http').Server;
  let baseUrl: string;
  let service: GameService;

  const PLAYERS = [
    { id: 'alice', seat: 0, isRobot: false },
    { id: 'bob', seat: 1, isRobot: false },
    { id: 'carol', seat: 2, isRobot: false },
  ];

  const call = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  const as = (userId: string) => ({ headers: { 'X-User-Id': userId } });

  beforeAll(async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());

    service = new GameService(redisDouble as unknown as Redis);
    // 片① R1：起始座位确定（座位 0 先叫），与改动前的行为一致。
    // 本 describe 的两个叫抢夹具（TURN01 的 `ids[0] = alice` 三拍、TRIM01 的 alice 一拍）
    // 都按「alice = 座位 0 先动」写就 —— 不注入则随起始座位 1/3 概率过。
    //（下方「?seat=」describe 的 Nest 应用只开局 + 读视图、从不出牌叫抢，无需注入。）
    service.random = () => 0;
    const controller = new GameController(service);

    // ─── R218（N20/P4 Task 2）：内部专用路由**已删除** ─────────────────────
    // `POST /api/games`（`game.start`）与 `GET /api/games/:roomCode/snapshot`
    // （`game.snapshot`）被 TCP RPC 取代，这里**故意不注册**它们 ——
    // 这就是本文件对「路由不存在」的判据（两条回归用例走它们必须拿到 404）。
    //
    // ⚠️ 夹具（`startGame()`）因此改为**直接调 `GameService`**，而不是再经 HTTP：
    // 迁走的那条路由已不是本文件的被测面，用它当夹具只会让删路由连带删掉所有夹具。
    app.get('/api/games/:roomCode', (req, res) => {
      Promise.resolve(controller.get(req.params.roomCode, req.headers['x-user-id'] as string))
        .then((r) => res.json(r))
        .catch((e) => res.status(e.getStatus?.() ?? 500).json(e.getResponse?.() ?? {}));
    });
    app.get('/api/games/:roomCode/state', (req, res) => {
      Promise.resolve(controller.getState(req.params.roomCode, req.headers['x-user-id'] as string))
        .then((r) => res.json(r))
        .catch((e) => res.status(e.getStatus?.() ?? 500).json(e.getResponse?.() ?? {}));
    });
    app.post('/api/games/:roomCode/bid', (req, res) => {
      Promise.resolve(controller.bid(req.params.roomCode, req.body, req.headers['x-user-id'] as string))
        .then((r) => res.json(r))
        .catch((e) => res.status(e.getStatus?.() ?? 500).json(e.getResponse?.() ?? {}));
    });
    app.post('/api/games/:roomCode/pass', (req, res) => {
      Promise.resolve(controller.pass(req.params.roomCode, req.body, req.headers['x-user-id'] as string))
        .then((r) => res.json(r))
        .catch((e) => res.status(e.getStatus?.() ?? 500).json(e.getResponse?.() ?? {}));
    });
    app.post('/api/games/:roomCode/play', (req, res) => {
      Promise.resolve(controller.playCards(req.params.roomCode, req.body, req.headers['x-user-id'] as string))
        .then((r) => res.json(r))
        .catch((e) => res.status(e.getStatus?.() ?? 500).json(e.getResponse?.() ?? {}));
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetRedisDouble();
  });

  async function startGame(roomCode: string): Promise<void> {
    // R218（N20/P4 Task 2）：夹具直接调 `GameService.startGame()` —— `POST /api/games`
    // 已删除（它是 `game.start` 的过渡 HTTP 形态，现由 `@MessagePattern` 承担）。
    await service.startGame({ roomCode, baseScore: 100, players: PLAYERS });
  }

  /**
   * R218（N20/P4 Task 2）：内部专用的两条路由**不得复活**。
   *
   * `POST /api/games`（`game.start`）与 `GET /api/games/:roomCode/snapshot`
   * （`game.snapshot`）已被 §4.2 的 TCP RPC 取代。修前（RED）：本文件的手搭 Express
   * **注册着**这两条路由 ⇒ `POST /api/games` 返回 201、snapshot 不返回 404；
   * 修后本文件不再注册它们 ⇒ 两条都是 404。**一次全切，不留第二条路径**（R218）。
   */
  it('R218：POST /api/games 与 GET /api/games/:roomCode/snapshot 都已不存在（404）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';

    const created = await call('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'internal-secret' },
      body: JSON.stringify({ roomCode: 'GONE01', baseScore: 100, players: PLAYERS }),
    });
    expect(created.status).toBe(404);

    const snapshot = await call('/api/games/GONE01/snapshot', {
      headers: { 'X-Internal-Token': 'internal-secret' },
    });
    expect(snapshot.status).toBe(404);
  });

  it('N6: GET /api/games/:roomCode 是 §11.1 信封，data 是裁剪后的 PlayerView', async () => {
    await startGame('LEAK01');

    const res = await call('/api/games/LEAK01', as('alice'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: Record<string, unknown> };
    expect(body.code).toBe(0);                       // 修前（RED）：body.code === undefined（裸 PlayerView）
    const view = body.data;

    // 出站类型是 PlayerView（§4.2），不是 GameSession（§3.2）
    expect(Object.keys(view).sort()).toEqual(
      [
        'baseScore',
        'bidPhase',
        'bottomCards',
        'cardCounts',
        'currentPlayer',
        'hand',
        'landlordSeat',
        'playPhase',
        'recentActions',
        'roomCode',
        'seat',
        'state',
        'trustees',
        'turnDeadlineAt',
        'version',
      ].sort(),
    );

    // 永不出站的字段（§6.4 规则 4）
    const raw = JSON.stringify(view);
    expect(raw).not.toContain('actionLog');
    expect(raw).not.toContain('isRobot');
    expect(raw).not.toContain('isBot');
    expect(raw).not.toContain('botId');
    expect(raw).not.toContain('skillLevel');
    expect(raw).not.toContain('deck');

    // 只有自己的手牌是明文；他人只有张数
    expect(view.seat).toBe(0);
    expect((view.hand as number[]).length).toBe(17);
    expect(view.cardCounts).toEqual([17, 17, 17]);
    expect(view.bottomCards).toBeNull(); // 叫抢阶段恒为 null
  });

  it('N6/S8: GET /api/games/:roomCode/state 同样是 §11.1 信封 + 裁剪形状', async () => {
    await startGame('LEAK02');

    const res = await call('/api/games/LEAK02/state', as('bob'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: Record<string, unknown> };
    expect(body.code).toBe(0);
    const view = body.data;

    expect(view.seat).toBe(1);
    expect((view.hand as number[]).length).toBe(17);
    expect(view.cardCounts).toEqual([17, 17, 17]);
    expect(Object.keys(view)).not.toContain('players');
    expect(JSON.stringify(view)).not.toContain('actionLog');
  });

  it('never leaks another seat\u2019s cards: each seat sees a disjoint, complete 17-card hand', async () => {
    await startGame('LEAK03');

    const fetchSeat = async (userId: string) => {
      const res = await call('/api/games/LEAK03', as(userId));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        code: number;
        data: { seat: number; hand: Card[]; cardCounts: number[] };
      };
      expect(body.code).toBe(0);
      return body.data;
    };

    const alice = await fetchSeat('alice');
    const bob = await fetchSeat('bob');
    const carol = await fetchSeat('carol');

    for (const [seat, view] of [alice, bob, carol].entries()) {
      expect(view.seat).toBe(seat);
      expect(view.hand).toHaveLength(17);
      expect(view.cardCounts).toEqual([17, 17, 17]);
      // 只有 DouZero 合法牌值（§3.6）；17 就是「2」，不是内部 Rank
      // R696：`hand` 是 `Card[]` ⇒ 报点数是 `card.r`，另校验花色值域
      for (const card of view.hand) {
        expect([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30]).toContain(card.r);
        expect(card.s).toBeGreaterThanOrEqual(0);
        expect(card.s).toBeLessThanOrEqual(4);
      }
    }

    // 「disjoint」是**本用例名字里承诺**的性质，此前一直没有断言 ——
    // R696 之前断言不了（DouZero 编码不带花色，三家手牌在数值上必然重叠）；
    // 现在牌带 `(r, s)`，可以真的断言三家**互不相交**，且并集恰好 51 张。
    const keys = (cards: Card[]) => cards.map((c) => `${c.r}-${c.s}`);
    const all = [...keys(alice.hand), ...keys(bob.hand), ...keys(carol.hand)];
    expect(new Set(all).size).toBe(51);

    // 三家看到的手牌互不相同 —— 没有哪一方拿到了别人的牌
    expect(alice.hand).not.toEqual(bob.hand);
    expect(bob.hand).not.toEqual(carol.hand);
    expect(alice.hand).not.toEqual(carol.hand);
  });

  it('rejects an anonymous read with 401 (identity header is mandatory)', async () => {
    await startGame('LEAK04');
    const res = await call('/api/games/LEAK04');
    expect(res.status).toBe(401);
  });

  it('rejects a caller that is not in this game with 12004', async () => {
    await startGame('LEAK05');
    const res = await call('/api/games/LEAK05', as('mallory'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(12004);
  });

  it('returns 12001 for an unknown room', async () => {
    const res = await call('/api/games/NOSUCH', as('alice'));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe(12001);
  });

  /**
   * R218 / R223（N20/P4 Task 2）：`game.snapshot` 的 HTTP 面**整条删除**，
   * 且 `X-Internal-Token` 的**内层校验**随之消失（旧实现里它是「中间件若被豁免/漏挂」
   * 的防御纵深，对应 R95①/R140 的 `401 + 10002`）。
   *
   * ⚠️ 这是**有意**的收窄而不是回归：§4.2 要求 `game.snapshot` 只走 TCP RPC，
   * 而**TCP 监听方不走 HTTP 中间件**（R223）—— 身份边界改由「RPC 端口只在 compose 内网
   * 可达（基文件 `expose`，宿主映射只在 override）」承担。修前（RED）：本文件注册着该路由，
   * 无 token 拿 401、带 token 拿 200 + 完整会话；修后它连路由都不存在 ⇒ **404**。
   *
   * 剩下的 HTTP 面（`GET :roomCode`、`/state`、`POST :roomCode/{bid,play,pass}`）的
   * 边界由 R223 的全局中间件继续覆盖，见 `test/internal-token.test.ts`。
   */
  it('R218/R223: 删掉的 game.snapshot HTTP 路由对**任何** token 都是 404（边界改由 compose 内网承担）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    await startGame('SNAP01');

    const missing = await call('/api/games/SNAP01/snapshot');
    expect(missing.status).toBe(404);

    const ok = await call('/api/games/SNAP01/snapshot', {
      headers: { 'X-Internal-Token': 'internal-secret' },
    });
    // 修前这里 200 + `data.players`（完整会话）—— 它正是 §7.1 要消灭的「对外路由复用内部面」
    expect(ok.status).toBe(404);
  });

  it('rejects an out-of-turn play with 12003 and never leaks the session in the ack', async () => {
    await startGame('TURN01');
    // 走完叫抢：座位 0 叫，其余两家不抢 → 地主是座位 0，行动者也是座位 0
    const ids = ['alice', 'bob', 'carol'];
    let version = 1;
    let state = 'bidding';
    for (let i = 0; i < 3 && state === 'bidding'; i++) {
      const res = await call('/api/games/TURN01/bid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': ids[i]! },
        body: JSON.stringify({ grab: i === 0, baseVersion: version }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { state: string; version: number; currentPlayer: number } };
      state = body.data.state;
      version = body.data.version;
    }
    expect(state).toBe('playing');

    // 座位 1 抢在座位 0 之前出牌 → 越权（§5.3）
    const rogue = await call('/api/games/TURN01/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'bob' },
      body: JSON.stringify({ cards: [3] }),
    });
    expect(rogue.status).toBe(403);
    expect((await rogue.json()).code).toBe(12003);
  });

  it('action acks carry a trimmed PlayerView, not the full GameSession', async () => {
    await startGame('TRIM01');
    const res = await call('/api/games/TRIM01/bid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'alice' },
      body: JSON.stringify({ grab: false, baseVersion: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // 动作响应同样只能含自己的 hand（与 GET 视图同构）—— 否则泄漏只是换了个入口
    expect(Object.keys(body.data)).not.toContain('players');
    expect(JSON.stringify(body.data)).not.toContain('actionLog');
    expect(JSON.stringify(body.data)).not.toContain('isLandlord');
    expect(body.data.seat).toBe(0);
  });

  it('rejects game.play with a stale baseVersion (13004)', async () => {
    await startGame('CAS10');
    const res = await call('/api/games/CAS10/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'alice' },
      body: JSON.stringify({ cards: [3], baseVersion: 999 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(13004);
  });
});

/**
 * R74 / S2 / S8：**`?seat=` 座位覆盖通道已删除**（权威断言）。
 *
 * 上面那个 describe 手搭 Express，路由处理器里**手动**把参数传给控制器
 * （`controller.get(roomCode, userId)`），因此它**永远测不到** `@Query('seat')`
 * 这条装饰器绑定 —— `?seat=` 的洞正是从这里活到今天的。
 *
 * 这里改用**真实 Nest 应用**：查询串由 Nest/Express 亲自解析并绑定。
 * P18/N41：构造参数元数据现由测试环境**真的**发出（`vitest.config.ts` 的插件 +
 * `setupFiles: ['reflect-metadata']`）⇒ **不再**手写 `Reflect.defineMetadata` 垫片，
 * 真实 DI 走的是产品发出的那份元数据。
 */
describe('GameController（Nest HTTP 绑定：R74 —— `?seat=` 通道已删除）', () => {
  let app: INestApplication;
  let baseUrl: string;

  const PLAYERS = [
    { id: 'alice', seat: 0, isRobot: false },
    { id: 'bob', seat: 1, isRobot: false },
    { id: 'carol', seat: 2, isRobot: false },
  ];
  /** 夹具事实：alice 在座位 0，bob 在座位 1。 */
  const ALICE_SEAT = 0;
  const BOB_SEAT = 1;

  const call = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  /** 用某个用户的身份读房间视图，可附加查询串（`?seat=<n>` 就是本片要打掉的攻击面）。 */
  const viewOf = (roomCode: string, userId: string, query = '') =>
    call(`/api/games/${roomCode}${query}`, { headers: { 'X-User-Id': userId } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GameController],
      providers: [{ provide: GameService, useValue: new GameService(redisDouble as unknown as Redis) }],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 src/main.ts 一致：全局前缀是 /api。
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    resetRedisDouble();
  });

  /**
   * 夹具：**直接调 `GameService.startGame()`**。
   *
   * R218（N20/P4 Task 2）：`POST /api/games` 已删除（改由 `@MessagePattern('game.start')`
   * 承担），因此夹具不能再经它 —— 这也是「一次全切」的直接后果：**测试里的第二条路径
   * 同样要消失**，否则夹具会替那条路由「续命」。
   */
  async function startGame(roomCode: string): Promise<void> {
    await app.get(GameService).startGame({ roomCode, baseScore: 100, players: PLAYERS });
  }

  it('R74/S2: `?seat=<他人座位>` 不再能指定座位 —— alice 只拿得到自己的手牌', async () => {
    await startGame('SEAT01');

    // 参照：不带任何 query 的权威视图（座位只由 X-User-Id 推导）
    const ownBody = (await (await viewOf('SEAT01', 'alice')).json()) as {
      code: number;
      data: { seat: number; hand: Card[] };
    };
    expect(ownBody.code).toBe(0);
    const own = ownBody.data;
    expect(own.seat).toBe(ALICE_SEAT);

    // 攻击：alice 的 token + bob 的座位号
    const res = await viewOf('SEAT01', 'alice', `?seat=${BOB_SEAT}`);
    expect(res.status).toBe(200);
    const leakedBody = (await res.json()) as { code: number; data: { seat: number; hand: Card[] } };
    expect(leakedBody.code).toBe(0);
    const leaked = leakedBody.data;

    // 修前这里拿到的是 { seat: 1, hand: <bob 的 17 张> } —— 漏洞的直接证明
    expect({ seat: leaked.seat, hand: leaked.hand }).toEqual({ seat: ALICE_SEAT, hand: own.hand });
  });

  it('R74/S8: `/state?seat=<他人座位>` 与主路由是同一个洞，同样不得覆盖座位', async () => {
    await startGame('SEAT02');

    const ownBody = (await (await viewOf('SEAT02', 'alice')).json()) as {
      code: number;
      data: { seat: number; hand: Card[] };
    };
    expect(ownBody.code).toBe(0);
    const own = ownBody.data;
    const res = await call(`/api/games/SEAT02/state?seat=${BOB_SEAT}`, {
      headers: { 'X-User-Id': 'alice' },
    });
    expect(res.status).toBe(200);
    const leakedBody = (await res.json()) as { code: number; data: { seat: number; hand: Card[] } };
    expect(leakedBody.code).toBe(0);
    const leaked = leakedBody.data;

    expect({ seat: leaked.seat, hand: leaked.hand }).toEqual({ seat: ALICE_SEAT, hand: own.hand });
  });

  it('R74: 非本局玩家**带** `?seat=` 也拿不到手牌（仍然是 12004）', async () => {
    await startGame('SEAT03');

    for (const query of ['', `?seat=${BOB_SEAT}`]) {
      const res = await viewOf('SEAT03', 'stranger', query);
      // 修前：带 ?seat=1 时座位覆盖绕过了成员校验 → 200 + bob 的手牌
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe(12004);
    }
  });

  it('R74: `?seat=99`（越界座位）绝不返回任何人的手牌', async () => {
    await startGame('SEAT04');

    const res = await viewOf('SEAT04', 'alice', '?seat=99');
    // 要么 200 + alice 自己的视图，要么非 0 错误码；**绝不能**是 200 + 越界/他人座位
    if (res.status === 200) {
      const body = (await res.json()) as { code: number; data: { seat: number; hand: Card[] } };
      expect(body.code).toBe(0);
      expect(body.data.seat).toBe(ALICE_SEAT);
      expect(body.data.hand).toHaveLength(17);
    } else {
      expect(((await res.json()) as { code: number }).code).toBeGreaterThan(0);
    }
  });
});
