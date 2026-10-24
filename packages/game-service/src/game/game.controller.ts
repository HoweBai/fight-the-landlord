// packages/game-service/src/game/game.controller.ts
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
} from '@nestjs/common';
import { ErrCode, type Card, type GameView } from '@fight-the-landlord/protocol';
import { GameService } from './game.service';
import { GameError } from './game.errors';

/** §5.2：身份**只**来自网关验签后注入的头。 */
const USER_ID_HEADER = 'x-user-id';

/** 契约错误码 → HTTP 状态码（§11.2）。 */
const HTTP_STATUS: Partial<Record<ErrCode, number>> = {
  [ErrCode.BAD_PARAM]: 400,
  [ErrCode.UNAUTHENTICATED]: 401,
  [ErrCode.FORBIDDEN]: 403,
  [ErrCode.ROOM_NOT_FOUND]: 404,
  [ErrCode.NOT_YOUR_TURN]: 403,
  [ErrCode.NOT_IN_ROOM]: 403,
  [ErrCode.VERSION_CONFLICT]: 409,
  [ErrCode.GAME_OVER]: 409,
  [ErrCode.GAME_NOT_STARTED]: 409,
  [ErrCode.INVALID_CARDS]: 400,
  [ErrCode.ILLEGAL_ACTION]: 400,
  [ErrCode.UPSTREAM_UNAVAILABLE]: 503,
};

function httpException(code: ErrCode, message: string): HttpException {
  return new HttpException({ code, message, data: null }, HTTP_STATUS[code] ?? 500);
}

function toHttpException(err: unknown): HttpException {
  if (err instanceof GameError) return httpException(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  return httpException(ErrCode.ILLEGAL_ACTION, message);
}

@Controller('games')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  /**
   * `game.view` 的对外投影（§7.1 / §4.1 的「gateway → game-service HTTP」边）。
   *
   * N6（R139）：返回 **§11.1 的统一信封** `{ code: 0, data: PlayerView }` —— 与本控制器
   * 的 `action()` 同形。历史实现直接返回**裸 `PlayerView`**，于是任何
   * 「`body.code === 0` 才算成功」的断言在这两条路由上必然假绿/假红（conformance 实测确认）。
   * 座位**只**由 `X-User-Id` 在会话中定位（§5.3），**不接受** `?seat=` 覆盖（S2/S8/R74）；
   * 不接受时 `12004`，且**没有**该玩家 → 同上。
   *
   * ⚠️ **R224（N20/P4 Task 2）**：座位解析的唯一实现在
   * `GameService.getViewForUser(roomCode, userId)` —— 本方法与 `@MessagePattern('game.view')`
   * 共用它。本文件**不得**再出现第二处 `findSeatByUserId` 调用点。
   */
  @Get(':roomCode')
  async get(
    @Param('roomCode') roomCode: string,
    @Headers(USER_ID_HEADER) userId?: string,
  ): Promise<{ code: ErrCode; data: GameView }> {
    return { code: ErrCode.OK, data: await this.view(roomCode, userId) };
  }

  /**
   * 与 `GET /api/games/:roomCode` 同一泄漏点（偏差 S8），修法相同：`?seat=` 已删除；
   * 返回值同样改成 §11.1 信封（N6/R139）。
   */
  @Get(':roomCode/state')
  async getState(
    @Param('roomCode') roomCode: string,
    @Headers(USER_ID_HEADER) userId?: string,
  ): Promise<{ code: ErrCode; data: GameView }> {
    return { code: ErrCode.OK, data: await this.view(roomCode, userId) };
  }

  @Post(':roomCode/bid')
  async bid(
    @Param('roomCode') roomCode: string,
    @Body() dto: { grab?: boolean; bid?: boolean; baseVersion?: number },
    @Headers(USER_ID_HEADER) userId?: string,
  ) {
    const grab = dto.grab ?? dto.bid ?? false;
    return this.action(() =>
      this.gameService.actAndView(
        roomCode,
        this.requireUser(userId),
        'bid',
        { grab },
        dto.baseVersion,
      ),
    );
  }

  /**
   * **人类出牌的唯一 HTTP 入口**（R697）。
   *
   * ⚠️ DTO 的 `cards` 是 `Card[]`（带花色），服务端在 `handlePlayCards` 里
   * **按身份精确摘除**：逐个在行动者手里找 `(r, s)` 完全相等的牌并移除，任一找不到即拒。
   * 旧清单（v3）**完全没列这一处** —— 它是因为 `handlePlayCards` 的签名变了、
   * 由 `tsc` 顺着调用链追出来的。
   */
  @Post(':roomCode/play')
  async playCards(
    @Param('roomCode') roomCode: string,
    @Body() dto: { cards: Card[]; baseVersion?: number },
    @Headers(USER_ID_HEADER) userId?: string,
  ) {
    return this.action(() =>
      this.gameService.actAndView(
        roomCode,
        this.requireUser(userId),
        'play',
        { cards: dto.cards },
        dto.baseVersion,
      ),
    );
  }

  @Post(':roomCode/pass')
  async pass(
    @Param('roomCode') roomCode: string,
    @Body() dto: { baseVersion?: number },
    @Headers(USER_ID_HEADER) userId?: string,
  ) {
    return this.action(() =>
      this.gameService.actAndView(roomCode, this.requireUser(userId), 'pass', {}, dto.baseVersion),
    );
  }

  // ─── 内部 ───────────────────────────────────────────────────────

  /**
   * 座位解析的对外入口（§5.3）：**委托** `GameService.getViewForUser()`。
   *
   * ⚠️ **R224（N20/P4 Task 2）**：这里的座位解析已上移进 service —— 本方法与
   * `@MessagePattern('game.view')` 共用**同一个**实现，全仓只有一处 `findSeatByUserId()`。
   * 历史实现自己 `getSnapshot()` + `findSeatByUserId()` + `getView()`，
   * 于是 RPC 面必然复制第二份（那正是 R224 要防的第二真源）。
   *
   * 本方法只保留**HTTP 面特有的**一件事：`X-User-Id` 缺失 ⇒ `401 + 10002`
   * （`10002 UNAUTHENTICATED`，与全局中间件的码一致）。RPC 面没有这个 header 概念，
   * 它的身份由**调用方**（room-service）在载荷里给出，因此那条判定不属于共用层。
   *
   * ⚠️ R76（P0 片）**已被 N7 取代**：那条约束是「客户端路径不要加内部 token 校验，
   * 因为网关不转发它」。N7 之后网关**每一跳**都注入 `X-Internal-Token`，
   * 因此本路由**已经**由 `main.ts` 注册的**全局中间件**
   * （`src/http/internal-token.middleware.ts`，`/api/health` 豁免）统一要求，
   * 不需要（也不该）在这里逐条写校验：逐条挑必漏，全局中间件让新增路由默认安全。
   *
   * ⚠️ **R218（本片）**：`POST /api/games`（`game.start`）与
   * `GET :roomCode/snapshot`（`game.snapshot`）**整条删除** —— 它们是「内部面的 HTTP
   * 过渡形态」，现已由 `@MessagePattern` 承担（`src/rpc/game.rpc.controller.ts`）。
   * **一次全切**：同一语义不得既有 HTTP 又有 RPC（那会形成第二个真源）。
   */
  private async view(roomCode: string, userId?: string): Promise<GameView> {
    if (!userId) throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    try {
      return await this.gameService.getViewForUser(roomCode, userId);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  private requireUser(userId?: string): string {
    if (!userId) throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    return userId;
  }

  private async action(fn: () => Promise<unknown>) {
    try {
      const session = await fn();
      return { code: ErrCode.OK, data: session };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
