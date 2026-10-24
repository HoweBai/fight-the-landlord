import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RoomsController } from '../src/rooms/rooms.controller';
import { MANUAL_ROOM_TIMEOUT_MS } from '../src/rooms/rooms.timeout';
import type { RoomsService, Room } from '../src/rooms/rooms.service';
import { DomainError } from '../src/http/errors';
import { seatsOf } from './helpers/room-fixture';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';

/**
 * `RoomsController` 的 HTTP 边界测试（§3.1 / §5.2 / §11.1 / R22）。
 *
 * 手搭 node `http` server 而不是 `@nestjs/testing`：本文件要断言「控制器产出 +
 * 异常过滤器映射」这一层，手搭能精确控制路由与打桩。服务端复刻 Nest
 * 默认异常过滤器：`HttpException` → `res.status(getStatus()).json(getResponse())`。
 * （P18/N41 之前这里的理由是「Vitest 用 esbuild 转译，不发出 `design:paramtypes`，
 * 反射式构造注入在测试里拿不到依赖」—— 那条**已不再成立**：测试环境现在真的发出该元数据。）
 */
const room = (over: Partial<Room> = {}): Room => ({
  code: 'AAA111',
  mode: 'random',
  baseScore: 15,
  players: [],
  maxPlayers: 3,
  status: 'waiting',
  createdAt: Date.now(),
  timeoutAt: Date.now() + 30_000,
  ...over,
});

describe('RoomsController（GET /api/rooms → RoomInfo[]，R22）', () => {
  let server: Server;
  let baseUrl: string;
  let cache: ConfigCacheStub;
  let rooms: {
    findAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    join: ReturnType<typeof vi.fn>;
    /** 本片新增：手动房要落补位死线（§3.1 / R904b）。 */
    setFillDeadline: ReturnType<typeof vi.fn>;
  };

  const call = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  const postJson = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    // ⚠️ `setFillDeadline` 必须在这里（本片新增：手动房要落补位死线）——
    //    漏掉它会让 POST /api/rooms 静默变成 400（服务抛错 → toHttpException 兜底）
    rooms = { findAll: vi.fn(), create: vi.fn(), join: vi.fn(), setFillDeadline: vi.fn() };
    // ⚠️ 片⑦ T7：控制器多了「好友房开关」这一面（拒绝/返空在 controller 入口）。桩的缺省
    //    镜像种子 = **false**（安全方向）；本文件测的是**开关开**时的既有行为 ⇒ 显式开，
    //    开关关闭时的三面在 `rooms.controller-switch.test.ts`。
    cache = makeConfigCache();
    cache.friendRoomEnabled.mockReturnValue(true);
    const controller = new RoomsController(rooms as unknown as RoomsService, asConfigCache(cache));

    const readJson = async (req: IncomingMessage): Promise<any> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (chunks.length === 0) return undefined;
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return undefined;
      }
    };

    server = createServer(async (req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      const joinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
      let status = 200;
      let body: unknown;
      try {
        if (path === '/api/rooms' && req.method === 'GET') {
          body = await controller.findAll();
        } else if (path === '/api/rooms' && req.method === 'POST') {
          status = 201; // Nest 对 POST 的默认状态码
          body = await controller.create((await readJson(req)) as never);
        } else if (joinMatch) {
          status = 201;
          body = await controller.join(
            decodeURIComponent(joinMatch[1]!),
            req.headers['x-user-id'] as string | undefined,
          );
        } else {
          status = 404;
          body = { code: 10001, message: 'not found', data: null };
        }
      } catch (err) {
        // 复刻 Nest 默认异常过滤器（§11.1 的信封就装在 HttpException 里）
        status = err instanceof HttpException ? err.getStatus() : 500;
        body = err instanceof HttpException ? err.getResponse() : { code: 10001, message: String(err), data: null };
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => vi.clearAllMocks());

  it('GET /api/rooms 返回 { code: 0, data: RoomInfo[] }，每项恰好七个字段', async () => {
    rooms.findAll.mockResolvedValue([
      room({ code: 'AAA111', players: seatsOf('u1', 'u2'), status: 'playing', baseScore: 100 }),
      room({ code: 'BBB222', mode: 'practice', status: 'finished' }),
    ]);

    const resp = await call('/api/rooms');
    expect(resp.status).toBe(200);
    const text = await resp.text();
    const parsed = JSON.parse(text) as { code: number; data: Array<Record<string, unknown>> };

    expect(parsed.code).toBe(ErrCode.OK);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
    for (const item of parsed.data) {
      expect(Object.keys(item).sort()).toEqual(
        ['baseScore', 'code', 'gameType', 'maxPlayers', 'mode', 'playerCount', 'status'].sort(),
      );
    }
    expect(parsed.data[0]).toMatchObject({
      code: 'AAA111',
      mode: 'random',
      status: 'playing',
      playerCount: 2,
      maxPlayers: 3,
      baseScore: 100,
    });

    // 出站文本里不得出现内部字段或玩家 id
    expect(text).not.toContain('players');
    expect(text).not.toContain('isRobot');
    expect(text).not.toContain('u1');
  });

  it('POST /api/rooms 也是信封，且 data 已裁剪成 RoomInfo', async () => {
    rooms.create.mockResolvedValue(room({ code: 'NEW123', players: [] }));

    const resp = await postJson('/api/rooms', { mode: 'random' });
    expect(resp.status).toBe(201);
    const parsed = (await resp.json()) as { code: number; data: Record<string, unknown> };

    expect(parsed.code).toBe(ErrCode.OK);
    expect(parsed.data.code).toBe('NEW123');
    expect(Object.keys(parsed.data).sort()).toEqual(
      ['baseScore', 'code', 'gameType', 'maxPlayers', 'mode', 'playerCount', 'status'].sort(),
    );
  });

  /**
   * 本片（自动开局 · spec §3.1 / R913 / R904b）：**手动房**用更宽的回收窗口 + 落补位死线。
   *
   * ⚠️ 与匹配路径的差异必须显式传参（`create()` 缺省仍是 `WAITING_TIMEOUT_MS`）——
   * 匹配房间**不补位**（它自己那条链在 `match.service` 里），所以**不写死线**。
   */
  it('POST /api/rooms 传手动房的回收窗口，并落补位死线', async () => {
    rooms.create.mockResolvedValue(room({ code: 'NEW123', players: [] }));
    rooms.setFillDeadline.mockResolvedValue(undefined);

    await postJson('/api/rooms', { mode: 'practice' });

    // ⚠️ `timeoutMs` 是 `create()` 的**第二个入参**（不进 DTO —— 真路由上未声明的请求体字段
    //    被 `ValidationPipe` **静默剥掉**（不是 400），见 `rooms.controller.ts` 的同款注记）
    expect(rooms.create).toHaveBeenCalledWith({ mode: 'practice' }, { timeoutMs: MANUAL_ROOM_TIMEOUT_MS });
    expect(rooms.setFillDeadline, '手动房必须落补位死线（R904b）').toHaveBeenCalledTimes(1);
    const [code, at] = (rooms.setFillDeadline as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(code).toBe('NEW123');
    expect(typeof at).toBe('number');
  });

  it('POST /api/rooms/:code/join 从 X-User-Id 取身份，请求体里的 userId 被无视', async () => {
    rooms.join.mockResolvedValue(room({ code: 'JOIN01', players: seatsOf('real-user') }));

    const resp = await postJson('/api/rooms/JOIN01/join', { userId: 'attacker' }, { 'x-user-id': 'real-user' });

    expect(resp.status).toBe(201);
    expect(rooms.join).toHaveBeenCalledWith('JOIN01', 'real-user', 'doudizhu');
    expect(rooms.join).not.toHaveBeenCalledWith('JOIN01', 'attacker');
    expect(JSON.stringify(await resp.json())).not.toContain('attacker');
  });

  it('缺少 X-User-Id → 401 + 10002，且不触碰 service', async () => {
    const resp = await postJson('/api/rooms/JOIN01/join', { userId: 'attacker' });

    expect(resp.status).toBe(401);
    expect((await resp.json()).code).toBe(ErrCode.UNAUTHENTICATED);
    expect(rooms.join).not.toHaveBeenCalled();
  });

  it('房间不存在 → 404 + 12001；房间已满 → 409 + 12002；已开局 → 409 + 12008', async () => {
    rooms.join.mockRejectedValueOnce(new DomainError(ErrCode.ROOM_NOT_FOUND, '房间不存在'));
    const missing = await postJson('/api/rooms/NOPE/join', {}, { 'x-user-id': 'u1' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe(12001);

    rooms.join.mockRejectedValueOnce(new DomainError(ErrCode.ROOM_FULL, '房间已满'));
    const full = await postJson('/api/rooms/FULL/join', {}, { 'x-user-id': 'u1' });
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe(12002);

    rooms.join.mockRejectedValueOnce(new DomainError(ErrCode.ROOM_ALREADY_STARTED, '游戏已开始'));
    const started = await postJson('/api/rooms/START/join', {}, { 'x-user-id': 'u1' });
    expect(started.status).toBe(409);
    expect((await started.json()).code).toBe(12008);
  });
});
