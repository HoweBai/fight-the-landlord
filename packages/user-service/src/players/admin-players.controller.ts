import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { XAdminGuard } from '../http/x-admin.guard';
import { httpException } from '../http/errors';
import {
  AdminPlayersService,
  type PlayersActivityFilter,
  type PlayersOnlineFilter,
  type PlayersQuery,
  type PlayersSort,
} from './admin-players.service';

const QUERY_KEYS = ['q', 'status', 'online', 'activity', 'page', 'pageSize', 'sort'] as const;
const PAGE_SIZES = [10, 20, 50, 100] as const;

/** 玩家管理页读面（spec §4.2/§4.3）：strict query 白名单，未知键 400。 */
@Controller('admin/players')
@UseGuards(XAdminGuard)
export class AdminPlayersController {
  constructor(private readonly players: AdminPlayersService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    for (const key of Object.keys(query)) {
      if (!(QUERY_KEYS as readonly string[]).includes(key)) {
        throw httpException(ErrCode.BAD_PARAM, `未知查询参数：${key}`);
      }
    }
    const q = bounded(query.q, 'q', 1, 64);
    const status = enumOf(query.status, 'status', ['active', 'banned'] as const);
    const online = enumOf(query.online, 'online', ['online', 'offline'] as const);
    const activity = enumOf(query.activity, 'activity', [
      'active7',
      'active30',
      'inactive14',
      'inactive30',
    ] as const);
    const page = intOf(query.page, 'page', 1, 1_000_000, 1);
    const pageSize = intOf(query.pageSize, 'pageSize', 10, 100, 20);
    if (!(PAGE_SIZES as readonly number[]).includes(pageSize)) {
      throw httpException(ErrCode.BAD_PARAM, `pageSize 非法：须为 ${PAGE_SIZES.join('/')}`);
    }
    const sort = (enumOf(query.sort, 'sort', ['lastActive', 'created'] as const) ??
      'lastActive') as PlayersSort;
    const parsed: PlayersQuery = {
      ...(q === undefined ? {} : { q }),
      ...(status === undefined ? {} : { status }),
      ...(online === undefined ? {} : { online: online as PlayersOnlineFilter }),
      ...(activity === undefined ? {} : { activity: activity as PlayersActivityFilter }),
      page,
      pageSize,
      sort,
    };
    return { code: ErrCode.OK, data: await this.players.list(parsed) };
  }

  @Get(':userId/games')
  async games(@Param('userId') userId: string, @Query() query: Record<string, unknown>) {
    for (const key of Object.keys(query)) {
      if (key !== 'limit') throw httpException(ErrCode.BAD_PARAM, `未知查询参数：${key}`);
    }
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 36) {
      throw httpException(ErrCode.BAD_PARAM, 'userId 非法：长度须为 1–36');
    }
    const n = intOf(query.limit, 'limit', 1, 50, 20);
    return { code: ErrCode.OK, data: { items: await this.players.recentGames(userId, n) } };
  }
}

function bounded(value: unknown, name: string, min: number, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw httpException(ErrCode.BAD_PARAM, `${name} 非法：长度须为 ${min}–${max}`);
  }
  return value;
}

function enumOf<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw httpException(ErrCode.BAD_PARAM, `${name} 非法：须为 ${values.join('/')}`);
  }
  return value as T;
}

function intOf(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw httpException(ErrCode.BAD_PARAM, `${name} 非法：须为整数`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw httpException(ErrCode.BAD_PARAM, `${name} 非法：须在 ${min}–${max}`);
  }
  return n;
}
