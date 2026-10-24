import { Controller, Get, Post, Body, Param, Headers, Query } from '@nestjs/common';
import { DEFAULT_GAME_TYPE, ErrCode, isGameType, type GameType } from '@fight-the-landlord/protocol';
import { RoomsService, toRoomInfo } from './rooms.service';
import { MANUAL_ROOM_TIMEOUT_MS, manualFillDeadlineAt } from './rooms.timeout';
import { CreateRoomDto, JoinRoomDto } from './rooms.dto';
import { DomainError, httpException, toHttpException } from '../http/errors';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析依赖时拿到 undefined、启动即崩。
import { ConfigCacheService } from '../config/config-cache.service';

/**
 * §5.2：身份**只**来自网关验签后注入的头。
 *
 * 旧实现在 `POST /rooms/:code/join` 里读 `dto.userId ?? 'anon'` —— 那等于让
 * 任意客户端自选身份入座（Global Constraint 8 明令禁止），已删除。
 */
const USER_ID_HEADER = 'x-user-id';

/**
 * **好友房开关的三面**（片⑦ · 片规格 §C8 / T7）—— 判据的落层是**本控制器**：
 *
 *  - `findAll()`：开关关 ⇒ 返**空列表**（`code 0` —— 大厅空列表是正常态，不是错误）；
 *  - `create()` / `join()`：开关关 ⇒ `12006 FRIEND_ROOM_FAILED`（「好友房暂未开放」）。
 *
 * 🔴 **不得落进 `RoomsService.create()` 的服务体**：那个 `create()` 被**两条路**共用 ——
 * `POST /api/rooms`（手动房）与匹配的 `createGameRoom`。把开关检查放进服务体就会
 * **连坐匹配**（开关关时匹配永远开不了局），正对照见 `match.service.test.ts` 的
 * 「C8 正对照」用例。放这里（controller 入口）还有一个附带好处：拒绝时**一步都不碰**
 * service（不扫库、不写键）—— `rooms.controller-switch.test.ts` 用「service 零调用」钉住。
 */
@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly roomsService: RoomsService,
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * §3.1 / R22：统一信封，`data` 是**裁剪后**的 `RoomInfo[]`
   * （`players`、`isRobot` 等内部字段永不出站）。
   *
   * ⚠️ 开关关 ⇒ **入口短路**（不扫 Redis 再丢掉）：返空是「大厅现在没有开放的房间」，
   * 与「请求失败」是两回事（片规格 §C8③ 断言的就是 `code 0` + `data []`）。
   */
  @Get()
  async findAll(@Query('gameType') gameTypeQuery?: string) {
    /**
     * 多玩法（Task 2.2 / spec §4.6.2）：`gameType` 缺省 = doudizhu（旧客户端只看到斗地主房）。
     * 非法值 ⇒ `10001`（协议语义：只有字段缺失才缺省，不得把拼错的玩法当斗地主）。
     */
    let gameType: GameType = DEFAULT_GAME_TYPE;
    if (gameTypeQuery !== undefined) {
      if (!isGameType(gameTypeQuery)) {
        throw httpException(ErrCode.BAD_PARAM, 'gameType must be doudizhu | paodekuai');
      }
      gameType = gameTypeQuery;
    }
    if (!this.configCache.friendRoomEnabled()) return { code: ErrCode.OK, data: [] };
    const rooms = await this.roomsService.findAll();
    // 旧房间缺 gameType ⇒ 按斗地主计（读侧语义与 RoomMeta 的兼容缺省一致）。
    const filtered = rooms.filter((room) => (room.gameType ?? DEFAULT_GAME_TYPE) === gameType);
    return { code: ErrCode.OK, data: filtered.map(toRoomInfo) };
  }

  /**
   * 建房（**手动路径**）。
   *
   * ⚠️ 本片（spec §3.1 / R913 / R904b）：手动房需要**更宽的回收窗口** + **补位死线**：
   *  - `timeoutMs: MANUAL_ROOM_TIMEOUT_MS`（补位死线上界 + 10s）—— 否则死线偏大的那批房间
   *    会在**正要补机器人时**被回收任务删掉（回收是无条件删，不看「是不是正要补位」）；
   *  - `setFillDeadline(...)`：死线要**落盘**（每轮扫描现抽会让它漂移、判据也不可判）。
   *
   * ⚠️ 匹配路径**不**走这里（它走 `MatchService.createGameRoom` ⇒ `create()` 的缺省
   * `WAITING_TIMEOUT_MS`），所以匹配房间既没有 40s 窗口、也不写死线。
   *
   * ⚠️ 片⑦ T7：好友房开关关 ⇒ `12006`（**方法体第一句**，在 try 内 —— 让既有
   * `toHttpException` 把它翻成带信封的 `HttpException`，状态码取 design.md §11.2
   * 的 `12006 ⇒ 400`；裸抛 `DomainError` 会落到 Nest 缺省过滤器的 500 且**没有**数字码）。
   */
  @Post()
  async create(@Body() dto: CreateRoomDto) {
    try {
      if (!this.configCache.friendRoomEnabled()) {
        throw new DomainError(ErrCode.FRIEND_ROOM_FAILED, '好友房暂未开放');
      }
      // ⚠️ `timeoutMs` **不进 DTO**：`main.ts:44` 的 `ValidationPipe` 是
      // `{ whitelist: true, transform: true }` —— **没有** `forbidNonWhitelisted`
      // ⇒ 未声明的属性会被**静默剥掉**（不是 400）——`timeoutMs` 只能是 `create()` 的
      // **第二个入参**，写进请求体也不会到服务层（`CreateRoomDto.baseScore` 依赖的同一机制）。
      const room = await this.roomsService.create(dto, { timeoutMs: MANUAL_ROOM_TIMEOUT_MS });
      await this.roomsService.setFillDeadline(room.code, manualFillDeadlineAt(Date.now(), Math.random));
      return { code: ErrCode.OK, data: toRoomInfo(room) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /**
   * 入座。
   *
   * ⚠️ 载重顺序（片⑦ T7）：**先 401、后 12006** ——
   *  - 缺 `X-User-Id` 的短路保持原样、仍在最前（未认证的调用方读不到开关是哪个态；
   *    既有判据「缺少 X-User-Id → 401 且不触碰 service」的语义一字不变）；
   *  - 开关检查在 try 内第一句（同 `create()`：经 `toHttpException` 出信封 +
   *    design.md §11.2 的 `12006 ⇒ 400`）。
   */
  @Post(':code/join')
  async join(
    @Param('code') code: string,
    @Headers(USER_ID_HEADER) userId?: string,
    /**
     * 多玩法（Task 2.2 / RB1）：请求体 `JoinRoomDto { gameType? }`。
     * 旧客户端不带 body ⇒ 缺省 doudizhu；进跑得快房由 service 在**占座前**拒 `12012`。
     */
    @Body() dto?: JoinRoomDto,
  ) {
    if (!userId) throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    try {
      if (!this.configCache.friendRoomEnabled()) {
        throw new DomainError(ErrCode.FRIEND_ROOM_FAILED, '好友房暂未开放');
      }
      return {
        code: ErrCode.OK,
        data: toRoomInfo(
          await this.roomsService.join(code, userId, dto?.gameType ?? DEFAULT_GAME_TYPE),
        ),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
