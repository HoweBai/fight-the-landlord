import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RoomsController } from '../src/rooms/rooms.controller';
import { DomainError } from '../src/http/errors';
import { RoomMode } from '../src/rooms/rooms.dto';
import { MANUAL_ROOM_TIMEOUT_MS } from '../src/rooms/rooms.timeout';
import type { Room, RoomsService } from '../src/rooms/rooms.service';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';

/**
 * **好友房开关的三面**（片⑦ · 片规格 §C8 / Task 7）—— 判据落点全部在 `RoomsController`：
 *
 *  - `POST /api/rooms`（create）· `POST /api/rooms/:code/join`（join）⇒ `12006`；
 *  - `GET /api/rooms`（findAll）⇒ `{code: 0, data: []}`（**返空**，不是报错 —— 客户端
 *    大厅空列表是正常态，见片规格 §C8③）。
 *
 * 🔴 **落层是本组的要害**：拒绝必须在 **controller 入口**，**不得**落进共用的
 * `RoomsService.create()` 服务体 —— `createGameRoom`（匹配建房的唯一入口）调的正是
 * `create()` ⇒ 落错一层就会**连坐匹配路径**（正对照见 `match.service.test.ts` 的
 * 「C8 正对照」用例：开关关时匹配照常成局）。
 *
 * 判据形态（R115 的一对）：关的态断言三面**全拒**且 **service 零调用**（入口短路）；
 * 开的态断言三面**照常** —— 没有后半，一个「无论开关一律拒」的实现会让前半全绿。
 *
 * ⚠️ 抛出的形状：`DomainError` 经既有 `toHttpException` 翻成 `HttpException`
 * （与其余 DOMAIN 错误的信封同一条路）⇒ HTTP 面 `{code: 12006, message: '好友房暂未开放'}`、
 * 状态码取 `HTTP_STATUS` 表（design.md §11.2：`12006 ⇒ 400`）。
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

describe('RoomsController：好友房开关三面（片规格 C8 —— 拒绝落在 controller 入口）', () => {
  let cache: ConfigCacheStub;
  let rooms: {
    findAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    join: ReturnType<typeof vi.fn>;
    setFillDeadline: ReturnType<typeof vi.fn>;
  };
  let controller: RoomsController;

  beforeEach(() => {
    vi.clearAllMocks();
    rooms = {
      findAll: vi.fn(async () => []),
      create: vi.fn(async () => room()),
      join: vi.fn(async () => room()),
      setFillDeadline: vi.fn(async () => undefined),
    };
    // 桩的缺省 = 种子 false（与生产初始态同）—— 本组大半用例就是这个态。
    cache = makeConfigCache();
    controller = new RoomsController(rooms as unknown as RoomsService, asConfigCache(cache));
  });

  // ── 开关关（= 生产种子态）：三面全拒，且都在入口短路 ──────────────────────

  it('C8①：开关关 ⇒ POST /api/rooms 抛 12006（拒绝在 controller 入口，不触碰 service 一步）', async () => {
    cache.friendRoomEnabled.mockReturnValue(false);

    const err = await controller.create({ mode: RoomMode.RANDOM }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    // 状态码：design.md §11.2 的 `12006 ⇒ 400`（HTTP_STATUS 表的映射结果）
    expect((err as HttpException).getStatus()).toBe(400);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: ErrCode.FRIEND_ROOM_FAILED,
      message: '好友房暂未开放',
    });
    // 🔴 入口短路的机械形态：一步都不许先碰 service（否则「拒了但房已建」这类半态会漏过本判据）
    expect(rooms.create, '拒绝必须在入口 —— service 一步都不许被碰').not.toHaveBeenCalled();
    expect(rooms.setFillDeadline).not.toHaveBeenCalled();
  });

  it('C8②：join 由 service 按好友房玩法执法（controller 只透传 gameType）', async () => {
    cache.friendRoomEnabled.mockReturnValue(false);
    rooms.join.mockRejectedValue(new DomainError(ErrCode.FRIEND_ROOM_FAILED, '好友房暂未开放'));

    const err = await controller.join('JOIN01', 'u1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(400);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: ErrCode.FRIEND_ROOM_FAILED,
      message: '好友房暂未开放',
    });
    // 闸在 service（按房间所属玩法）；controller 只负责透传，不重复全局判断。
    expect(rooms.join).toHaveBeenCalledWith('JOIN01', 'u1', 'doudizhu');
  });

  it('C8③：开关关 ⇒ GET /api/rooms 返空（code 0、data []），且不扫库（service 零调用）', async () => {
    cache.friendRoomEnabled.mockReturnValue(false);

    expect(await controller.findAll()).toEqual({ code: ErrCode.OK, data: [] });
    expect(rooms.findAll, '返空是入口短路 —— 不得先扫一遍再丢掉').not.toHaveBeenCalled();
  });

  // ── 开关开：正对照（三面照常）────────────────────────────────────────────
  //
  // 没有这一半，「无论开关一律拒」的实现会让上面三条全绿。
  it('正对照：开关开 ⇒ 三面照常（建房带手动房参数 / 入座 / 列表非空）', async () => {
    cache.friendRoomEnabled.mockReturnValue(true);
    rooms.create.mockResolvedValue(room({ code: 'NEW123' }));
    rooms.join.mockResolvedValue(room({ code: 'JOIN01', players: [] }));
    rooms.findAll.mockResolvedValue([room({ code: 'AAA111' })]);

    const created = await controller.create({ mode: RoomMode.PRACTICE });
    expect(created.code).toBe(ErrCode.OK);
    expect(created.data.code).toBe('NEW123');
    expect(rooms.create).toHaveBeenCalledWith(
      { mode: 'practice' }, // 枚举成员的运行期值就是字面量（DTO 的 `@IsEnum` 校验的就是它）
      { timeoutMs: MANUAL_ROOM_TIMEOUT_MS },
    );

    const joined = await controller.join('JOIN01', 'u1');
    expect(joined.code).toBe(ErrCode.OK);
    expect(rooms.join).toHaveBeenCalledWith('JOIN01', 'u1', 'doudizhu');

    const list = await controller.findAll();
    expect(list.code).toBe(ErrCode.OK);
    expect(list.data.map((r) => r.code)).toEqual(['AAA111']);
  });

  /**
   * 缺 `X-User-Id` 的 401 优先于开关 12006（既有短路保持在开关检查**之前**）：
   * 未认证的调用方读不到「开关现在是哪个态」，且既有判据（`rooms.controller.test.ts`
   * 的「缺少 X-User-Id → 401」）的语义一字不变。
   */
  it('join：缺 X-User-Id 仍是 401（优先于开关检查，且不碰 service）', async () => {
    cache.friendRoomEnabled.mockReturnValue(false); // 即便开关关，未认证也先答 401

    const err = await controller.join('JOIN01', undefined).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toMatchObject({ code: ErrCode.UNAUTHENTICATED });
    expect(rooms.join).not.toHaveBeenCalled();
  });
});
