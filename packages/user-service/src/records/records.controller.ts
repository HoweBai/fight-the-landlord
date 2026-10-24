import { Controller, Get, Headers, Query } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { httpException, toHttpException } from '../http/errors';
import { RecordsService, type MyRecordsPage, type PdkRecordsPage } from './records.service';

/**
 * 记录片 T6（规格 §2.3 / 设计 D4）：`GET /api/records/mine` 的 **user-service HTTP 面**。
 *
 * ⚠️ 身份**只**来自 `X-User-Id`（§5.2：网关验签后注入；本服务要求的 `X-Internal-Token`
 * 由全局中间件在 `main.ts` 统一强制 —— 直连 3001 + 伪造 `X-User-Id` 打不进来）。
 * 本控制器**不接受**任何「查谁的记录」参数：没有 `userId` 查询参数、没有路径变量。
 *
 * ⚠️ 响应是 §11.1 的统一信封 `{ code, data }`（与 auth 控制器同形）；错误经
 * `toHttpException` 翻成契约码 + 状态码（非法游标 ⇒ 400/10001 等）。
 *
 * ## 筛选参数（全部可选）
 *  - `mode`：'random' | 'practice' | 'gold' —— 精确匹配；非法值 ⇒ 400。
 *  - `from` / `to`：epoch ms 整数 —— 日期范围 `[from, to)`；两者都不传则不筛。
 *    任一缺失则视为无下限 / 无上限；非整数形态静默忽略（不抛错）。
 */
const USER_ID_HEADER = 'x-user-id';

@Controller('records')
export class RecordsController {
  constructor(private readonly recordsService: RecordsService) {}

  @Get('mine')
  async mine(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('gameType') gameType?: string,
  ): Promise<{ code: ErrCode; data: MyRecordsPage | PdkRecordsPage }> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    }
    // 多玩法（S7.2）：缺省 = 斗地主（旧客户端零破坏）；非法值 ⇒ 10001。
    if (gameType !== undefined && gameType !== 'doudizhu' && gameType !== 'paodekuai') {
      throw httpException(ErrCode.BAD_PARAM, 'gameType 必须是 doudizhu 或 paodekuai');
    }
    try {
      // from/to 是字符串 query ⇒ 转 number；非法值留给 service 做静默忽略
      const fromMs = from !== undefined ? Number(from) : undefined;
      const toMs = to !== undefined ? Number(to) : undefined;
      const query = { cursor, limit, mode, from: fromMs, to: toMs };
      return {
        code: ErrCode.OK,
        data:
          gameType === 'paodekuai'
            ? await this.recordsService.getMyPdkRecords(userId, query)
            : await this.recordsService.getMyRecords(userId, query),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
