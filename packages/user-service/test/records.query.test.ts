import { describe, it, expect, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ErrCode, type Card } from '@fight-the-landlord/protocol';
import {
  RecordsService,
  RECORDS_DEFAULT_LIMIT,
  RECORDS_MAX_LIMIT,
  clampRecordsLimit,
  encodeRecordsCursor,
  decodeRecordsCursor,
} from '../src/records/records.service';
import { RecordsController } from '../src/records/records.controller';

/**
 * 记录片 T6 的**单测载体**（规格 §2.3 / §3 C6·C7；设计 D4）：`GET /api/records/mine` 查询面。
 *
 * ⚠️ 与 T4 同样的选型：**不用真 DB**（user-service 单测惯例 = 直接 new + 假依赖），
 * 但假 DB 不是「按调用序返回剧本」的桩 —— 它是两张表的**最小仿真**：
 *  ① 页面查询：`WHERE user_id = ?` 等值过滤 + keyset（`ended_at DESC, id DESC`）+ LIMIT；
 *  ② 附页查询：按 `record_id IN (...)` 取三家玩家行。
 * 承重的语义全在「库行为」这一层：**只本人**（C6）是等值过滤的产物、翻页是 keyset 的产物、
 * `mySeat` 是「我那一行」的座位。按序打桩会把这三条断言退化成「实现调了几次」。
 *
 * ⚠️ 仿真能证的是**我们这侧**的责任：SQL 的**身份参数**确实是调用者（机械证据）、
 * 组装/翻页/白名单在真行数据上成立。「InnoDB + 真 JOIN」的最终证据在 T9 conformance
 * 真栈用例（C6 双账号 + C7 递归键集）。
 *
 * ⚠️ 本文件的 `dtoViolations()` 是**递归恰好键集**断言器（T9 真栈将做同形态）——
 * 它自己也有**判别力自证**用例（注入多余键 / 少键 / 类型漂移 ⇒ 非空），
 * 否则「全绿」可能只是断言器恒真（本仓：「拦得住最像正确答案的那个错吗」）。
 */

const T0 = Date.parse('2026-10-03T10:00:00.000Z');
/** 34 位合法 hex（`0f` = 15 ⇒ r=3,s=0，合法牌）——decode 侧按真实包络解回 Card[]。 */
const HAND34 = '0f'.repeat(17);
const BOTTOM6 = '0f'.repeat(3);
/** 34 位合法 hex 的第二种取值（`19` = 25 ⇒ r=5,s=0）。 */
const HAND34_B = '19'.repeat(17);

interface Statement {
  sql: string;
  params: unknown[];
}

interface RecordRow {
  id: number;
  room_code: string;
  mode: string;
  base_score: number;
  winner: string;
  landlord_seat: number;
  multiplier: number;
  spring: string;
  bottom_cards: string;
  started_at: Date;
  ended_at: Date;
}

interface PlayerRow {
  id: number;
  record_id: number;
  seat: number;
  user_id: string | null;
  is_robot: number;
  robot_id: string | null;
  nickname: string | null;
  role: string;
  score_change: number;
  won: number;
  hand: string;
  /** ② 金币场：该行的金币变动（NULL = 未回写/非金币场）。 */
  money_delta: number | null;
  ended_at: Date;
}

/**
 * 两张表的**最小仿真**（语义见文件头）：等值过滤 + keyset 排序 + LIMIT + 按 record 附页。
 * `won`/`is_robot` 刻意以 **0/1 数字**返回（mysql tinyint 的真实形态）⇒ DTO 必须转布尔。
 */
class FakeRecordsDb {
  records: RecordRow[] = [];
  players: PlayerRow[] = [];
  queries: Statement[] = [];
  nextRecordId = 1;
  nextPlayerId = 1;

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      if (sql.includes('JOIN `game_records`')) return Promise.resolve(this.pageQuery(sql, params));
      if (sql.includes('FROM `game_record_players`') && sql.includes('IN (')) {
        return Promise.resolve(this.playersQuery(params));
      }
      return Promise.reject(new Error(`FakeRecordsDb 未识别的 SQL：${sql}`));
    },
  };

  /** 播种一局：`ownerSeat` 是 `ownerId` 的座位，另两座 = 客人（可指定 id）+ 机器人。 */
  addGame(opts: {
    roomCode: string;
    ownerId: string;
    ownerSeat: 0 | 1 | 2;
    landlordSeat: 0 | 1 | 2;
    endedAtMs: number;
    guestId: string;
    ownerNickname?: string | null;
    guestNickname?: string | null;
    mode?: 'random' | 'practice' | 'gold';
    baseScore?: number;
    multiplier?: number;
    spring?: 'none' | 'spring' | 'anti-spring';
    ownerHand?: string;
    /** ② 金币场：我那一行的 `money_delta`（缺省 NULL = 未回写）。 */
    moneyDelta?: number | null;
  }): void {
    const recordId = this.nextRecordId++;
    const guestSeat = ((opts.ownerSeat + 1) % 3) as 0 | 1 | 2;
    const winner = 'landlord';
    this.records.push({
      id: recordId,
      room_code: opts.roomCode,
      mode: opts.mode ?? 'random',
      base_score: opts.baseScore ?? 15,
      winner,
      landlord_seat: opts.landlordSeat,
      multiplier: opts.multiplier ?? 2,
      spring: opts.spring ?? 'none',
      bottom_cards: BOTTOM6,
      started_at: new Date(opts.endedAtMs - 60_000),
      ended_at: new Date(opts.endedAtMs),
    });
    for (const seat of [0, 1, 2] as const) {
      const isOwner = seat === opts.ownerSeat;
      const isGuest = seat === guestSeat;
      const role = seat === opts.landlordSeat ? 'landlord' : 'farmer';
      const won = role === winner;
      this.players.push({
        id: this.nextPlayerId++,
        record_id: recordId,
        seat,
        user_id: isOwner ? opts.ownerId : isGuest ? opts.guestId : null,
        is_robot: isOwner || isGuest ? 0 : 1,
        robot_id: isOwner || isGuest ? null : `bot-${seat}`,
        nickname: isOwner
          ? opts.ownerNickname === undefined
            ? 'Alice'
            : opts.ownerNickname
          : isGuest
            ? opts.guestNickname === undefined
              ? 'Bob'
              : opts.guestNickname
            : null,
        role,
        score_change: role === 'landlord' ? 30 : -15,
        won: won ? 1 : 0,
        hand: isOwner ? (opts.ownerHand ?? HAND34) : HAND34,
        money_delta: isOwner ? (opts.moneyDelta ?? null) : null,
        ended_at: new Date(opts.endedAtMs),
      });
    }
  }

  /** 解析 WHERE 子句里有哪些条件，按 SQL 动态决定 params 语义（避免固定位置推断的脆弱性）。 */
  private pageQuery(sql: string, params: unknown[]): unknown[] {
    let pIdx = 0;
    const userId = params[pIdx++] as string;

    let modeFilter: string | null = null;
    let fromMs: number | null = null;
    let toMs: number | null = null;
    let cursorEndedAt: Date | null = null;
    let cursorId: number | null = null;

    if (sql.includes('r.`mode` = ?')) {
      modeFilter = params[pIdx++] as string;
    }
    if (sql.includes('ended_at` >= ?')) {
      fromMs = (params[pIdx++] as Date).getTime();
    }
    // to 条件：ended_at < ? 后面跟 AND 或 ORDER BY（不是 cursor 的 OR）
    if (sql.includes('ended_at` < ? AND') || sql.includes('ended_at` < ? ORDER')) {
      toMs = (params[pIdx++] as Date).getTime();
    }
    if (sql.includes('ended_at` < ? OR (')) {
      cursorEndedAt = params[pIdx++] as Date;
      pIdx++; // cursor ended_at = 条件中的第二个 Date
      cursorId = params[pIdx++] as number;
    }

    const limit = params[params.length - 1] as number;

    let rows = this.players.filter((p) => p.user_id === userId);
    if (modeFilter !== null) {
      rows = rows.filter((p) => {
        const r = this.records.find((rec) => rec.id === p.record_id);
        return r?.mode === modeFilter;
      });
    }
    if (fromMs !== null) rows = rows.filter((p) => p.ended_at.getTime() >= fromMs!);
    if (toMs !== null) rows = rows.filter((p) => p.ended_at.getTime() < toMs!);
    if (cursorEndedAt !== null && cursorId !== null) {
      const cMs = cursorEndedAt.getTime();
      rows = rows.filter(
        (p) => p.ended_at.getTime() < cMs || (p.ended_at.getTime() === cMs && p.id < cursorId),
      );
    }
    rows = [...rows].sort(
      (a, b) => b.ended_at.getTime() - a.ended_at.getTime() || b.id - a.id,
    );
    return rows.slice(0, limit).map((p) => {
      const r = this.records.find((rec) => rec.id === p.record_id);
      if (!r) throw new Error(`仿真库数据损坏：record ${p.record_id} 缺失`);
      return {
        mine_id: p.id,
        my_seat: p.seat,
        money_delta: p.money_delta,
        ended_at: p.ended_at,
        record_id: r.id,
        room_code: r.room_code,
        mode: r.mode,
        base_score: r.base_score,
        winner: r.winner,
        landlord_seat: r.landlord_seat,
        multiplier: r.multiplier,
        spring: r.spring,
        bottom_cards: r.bottom_cards,
      };
    });
  }

  private playersQuery(params: unknown[]): unknown[] {
    const ids = params as number[];
    return this.players
      .filter((p) => ids.includes(p.record_id))
      .sort((a, b) => a.record_id - b.record_id || a.seat - b.seat)
      .map((p) => ({
        record_id: p.record_id,
        seat: p.seat,
        nickname: p.nickname,
        role: p.role,
        score_change: p.score_change,
        won: p.won,
        hand: p.hand,
      }));
  }
}

// ─── DTO 递归恰好键集断言器（T9 真栈将做同形态；本文件先钉在单测层）──────────

const PAGE_KEYS = ['items', 'nextCursor'];
const RECORD_KEYS = [
  'roomCode',
  'mode',
  'endedAt',
  'baseScore',
  'winner',
  'landlordSeat',
  'multiplier',
  'spring',
  'mySeat',
  'moneyDelta',
  'bottomCards',
  'players',
];
const PLAYER_KEYS = ['seat', 'nickname', 'role', 'scoreChange', 'won', 'hand'];
const CARD_KEYS = ['r', 's'];

const keyCheck = (value: unknown, path: string, expectedKeys: string[], v: string[]): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    v.push(`${path}: 不是对象`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join('|') !== expected.join('|')) {
    v.push(`${path}: 键集 {${actual.join(',')}} ≠ {${expected.join(',')}}`);
    return false;
  }
  return true;
};

/** 递归收集 DTO 违约（键集恰好 + 数组长度 3/17/3 + 基本类型/枚举）。空数组 = 全符合。 */
function dtoViolations(page: unknown): string[] {
  const v: string[] = [];
  if (!keyCheck(page, 'page', PAGE_KEYS, v)) return v;
  const { items, nextCursor } = page as { items: unknown; nextCursor: unknown };
  if (!Array.isArray(items)) {
    v.push('page.items: 不是数组');
    return v;
  }
  if (nextCursor !== null && typeof nextCursor !== 'string') v.push('page.nextCursor: 不是 string|null');
  const enums = (value: unknown, path: string, allowed: string[]): void => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      v.push(`${path}: ${JSON.stringify(value)} 不在 ${allowed.join('/')}`);
    }
  };
  for (const [i, raw] of items.entries()) {
    const p = `items[${i}]`;
    if (!keyCheck(raw, p, RECORD_KEYS, v)) continue;
    const item = raw as Record<string, unknown>;
    enums(item.mode, `${p}.mode`, ['random', 'practice', 'gold']);
    enums(item.winner, `${p}.winner`, ['landlord', 'farmer']);
    enums(item.spring, `${p}.spring`, ['none', 'spring', 'anti-spring']);
    if (typeof item.roomCode !== 'string' || item.roomCode.length === 0) v.push(`${p}.roomCode: 非空字符串`);
    if (!Number.isInteger(item.endedAt)) v.push(`${p}.endedAt: 必须是整数（epoch ms），收到 ${typeof item.endedAt}`);
    for (const k of ['baseScore', 'multiplier']) {
      if (typeof item[k] !== 'number') v.push(`${p}.${k}: 必须是 number`);
    }
    for (const k of ['landlordSeat', 'mySeat']) {
      if (![0, 1, 2].includes(item[k] as number)) v.push(`${p}.${k}: 必须是 0/1/2`);
    }
    if (
      item.moneyDelta !== null &&
      (typeof item.moneyDelta !== 'number' || !Number.isInteger(item.moneyDelta))
    ) {
      v.push(`${p}.moneyDelta: 必须是整数或 null，收到 ${JSON.stringify(item.moneyDelta)}`);
    }
    if (!Array.isArray(item.bottomCards) || item.bottomCards.length !== 3) {
      v.push(`${p}.bottomCards: 必须恰 3 张`);
    } else {
      item.bottomCards.forEach((c, j) => {
        const cp = `${p}.bottomCards[${j}]`;
        if (keyCheck(c, cp, CARD_KEYS, v)) {
          const card = c as Record<string, unknown>;
          if (typeof card.r !== 'number' || typeof card.s !== 'number') v.push(`${cp}: r/s 必须是 number`);
        }
      });
    }
    if (!Array.isArray(item.players) || item.players.length !== 3) {
      v.push(`${p}.players: 必须恰 3 条`);
      continue;
    }
    const seats: number[] = [];
    item.players.forEach((pl, j) => {
      const pp = `${p}.players[${j}]`;
      if (!keyCheck(pl, pp, PLAYER_KEYS, v)) return;
      const player = pl as Record<string, unknown>;
      seats.push(player.seat as number);
      if (player.nickname !== null && typeof player.nickname !== 'string') {
        v.push(`${pp}.nickname: 必须是 string|null`);
      }
      enums(player.role, `${pp}.role`, ['landlord', 'farmer']);
      if (typeof player.scoreChange !== 'number') v.push(`${pp}.scoreChange: 必须是 number`);
      if (typeof player.won !== 'boolean') {
        v.push(`${pp}.won: 必须是布尔（不得是 0/1），收到 ${typeof player.won}`);
      }
      if (typeof player.seat !== 'number' || ![0, 1, 2].includes(player.seat)) {
        v.push(`${pp}.seat: 必须是 0/1/2`);
      }
      if (!Array.isArray(player.hand) || player.hand.length !== 17) {
        v.push(`${pp}.hand: 必须恰 17 张`);
      } else {
        player.hand.forEach((c, k) => {
          const cp = `${pp}.hand[${k}]`;
          if (keyCheck(c, cp, CARD_KEYS, v)) {
            const card = c as Record<string, unknown>;
            if (typeof card.r !== 'number' || typeof card.s !== 'number') v.push(`${cp}: r/s 必须是 number`);
          }
        });
      }
    });
    if (seats.slice().sort().join(',') !== '0,1,2') v.push(`${p}.players: 座位必须 0/1/2 各一，收到 [${seats.join(',')}]`);
  }
  return v;
}

/** 合法的「最小 MyRecord」样本（断言器自证用例的底座；不值钱 —— 真判别力靠真响应）。 */
function sampleItem(): Record<string, unknown> {
  const card = (): Card => ({ r: 3, s: 0 });
  return {
    roomCode: 'AAAAA1',
    mode: 'random',
    endedAt: T0,
    baseScore: 15,
    winner: 'landlord',
    landlordSeat: 0,
    multiplier: 2,
    spring: 'none',
    mySeat: 0,
    moneyDelta: null,
    bottomCards: [card(), card(), card()],
    players: [0, 1, 2].map((seat) => ({
      seat,
      nickname: seat === 2 ? null : 'Alice',
      role: seat === 0 ? 'landlord' : 'farmer',
      scoreChange: seat === 0 ? 30 : -15,
      won: seat === 0,
      hand: Array.from({ length: 17 }, card),
    })),
  };
}

// ─── 用例 ──────────────────────────────────────────────────────────────────

describe('记录片 T6：GET /api/records/mine（规格 §2.3 / §3 C6·C7；设计 D4）', () => {
  let db: FakeRecordsDb;
  let controller: RecordsController;

  beforeEach(() => {
    db = new FakeRecordsDb();
    controller = new RecordsController(new RecordsService(db.dataSource as never));
  });

  type MineOpts = {
    cursor?: string;
    limit?: string | number;
    mode?: string;
    from?: number;
    to?: number;
  };
  const mine = (
    userId: string,
    cursorOrOpts?: string | MineOpts,
    limit?: string,
  ) => {
    let opts: MineOpts;
    if (typeof cursorOrOpts === 'string' || cursorOrOpts === undefined) {
      // 旧签名：(userId, cursor?, limit?)
      opts = { cursor: cursorOrOpts, limit };
    } else {
      opts = cursorOrOpts;
    }
    return controller.mine(
      userId,
      opts.cursor,
      opts.limit === undefined ? undefined : String(opts.limit),
      opts.mode,
      opts.from === undefined ? undefined : String(opts.from),
      opts.to === undefined ? undefined : String(opts.to),
    );
  };
  const data = (res: { data: unknown }) => res.data as {
    items: Array<{ roomCode: string; mySeat: number; endedAt: number; mode?: string }>;
    nextCursor: string | null;
  };
  const items = (page: { items: Array<Record<string, unknown>> }) => page.items;
  const nextCursor = (page: { nextCursor: string | null }) => page.nextCursor;
  const pageQueries = () => db.queries.filter((q) => q.sql.includes('JOIN `game_records`'));

  it('C6 只本人：两账号两局 ⇒ 各只见己局；响应全串绝不含他局 roomCode', async () => {
    db.addGame({ roomCode: 'AAAAA1', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-ga', landlordSeat: 1, endedAtMs: T0 + 1000 });
    db.addGame({ roomCode: 'AAAAA2', ownerId: 'u-A', ownerSeat: 2, guestId: 'u-ga', landlordSeat: 2, endedAtMs: T0 + 2000 });
    db.addGame({ roomCode: 'BBBBB1', ownerId: 'u-B', ownerSeat: 1, guestId: 'u-gb', landlordSeat: 0, endedAtMs: T0 + 3000 });
    db.addGame({ roomCode: 'BBBBB2', ownerId: 'u-B', ownerSeat: 0, guestId: 'u-gb', landlordSeat: 1, endedAtMs: T0 + 4000 });

    const pageA = data(await mine('u-A'));
    expect(pageA.items.map((i) => i.roomCode)).toEqual(['AAAAA2', 'AAAAA1']);
    // 负对照：全串扫描（含 players 明细/底牌在内，绝无他局痕迹）
    expect(JSON.stringify(pageA)).not.toContain('BBBBB');

    const pageB = data(await mine('u-B'));
    expect(pageB.items.map((i) => i.roomCode)).toEqual(['BBBBB2', 'BBBBB1']);
    expect(JSON.stringify(pageB)).not.toContain('AAAAA');

    // 机械证据：每一次页面查询的**身份参数**恰好是调用者 id（等值写死，非过滤后置）
    expect(pageQueries().map((q) => q.params[0])).toEqual(['u-A', 'u-B']);

    // 负对照：没有记录的账号 ⇒ 空页且不存在的 id 不会漏进任何查询
    const none = data(await mine('u-nobody'));
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  it('keyset 翻页：25 局 ⇒ 20 + 5，终页 nextCursor:null；游标原样回传续页不重不漏', async () => {
    for (let i = 1; i <= 25; i++) {
      db.addGame({
        roomCode: `AAAA${String(i).padStart(2, '0')}`,
        ownerId: 'u-A',
        ownerSeat: (i % 3) as 0 | 1 | 2,
        guestId: 'u-ga',
        landlordSeat: 1,
        endedAtMs: T0 + i * 1000,
      });
    }

    // 缺省 limit = 20（不传）
    const page1 = data(await mine('u-A'));
    expect(RECORDS_DEFAULT_LIMIT).toBe(20);
    expect(page1.items).toHaveLength(20);
    expect(page1.items[0]!.roomCode).toBe('AAAA25');
    expect(page1.items[19]!.roomCode).toBe('AAAA06');
    expect(typeof page1.nextCursor).toBe('string');
    // 游标是**不透明 URL 安全串**（base64url 字母表；`+` 在查询串往返里会被解成空格 ⇒ 不允许）
    expect(page1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    // 客户端**原样回传** nextCursor ⇒ 续页
    const page2 = data(await mine('u-A', page1.nextCursor!));
    expect(page2.items.map((i) => i.roomCode)).toEqual([
      'AAAA05',
      'AAAA04',
      'AAAA03',
      'AAAA02',
      'AAAA01',
    ]);
    expect(page2.nextCursor).toBeNull();

    // 不重不漏：两页并起来恰 25 个不同局
    const all = [...page1.items, ...page2.items].map((i) => i.roomCode);
    expect(new Set(all).size).toBe(25);
  });

  it('keyset 的 id 决胜：同 ended_at 的两局仍严格全序（不重不漏）', async () => {
    db.addGame({ roomCode: 'TIE001', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 1000 });
    db.addGame({ roomCode: 'TIE002', ownerId: 'u-A', ownerSeat: 1, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 2000 });
    db.addGame({ roomCode: 'TIE003', ownerId: 'u-A', ownerSeat: 2, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 2000 }); // 与 TIE002 同毫秒

    const page1 = data(await mine('u-A', undefined, '2'));
    expect(page1.items.map((i) => i.roomCode)).toEqual(['TIE003', 'TIE002']); // id DESC 决胜
    expect(page1.nextCursor).not.toBeNull();

    const page2 = data(await mine('u-A', page1.nextCursor!, '2'));
    expect(page2.items.map((i) => i.roomCode)).toEqual(['TIE001']);
    expect(page2.nextCursor).toBeNull();
  });

  it('limit clamp：999 ⇒ 100（真截断）；0/负数/非数字 ⇒ 缺省 20；小值如实生效', async () => {
    for (let i = 1; i <= 130; i++) {
      db.addGame({
        roomCode: `CLM${String(i).padStart(3, '0')}`,
        ownerId: 'u-A',
        ownerSeat: 0,
        guestId: 'u-ga',
        landlordSeat: 0,
        endedAtMs: T0 + i * 1000,
      });
    }

    const capped = data(await mine('u-A', undefined, '999'));
    expect(RECORDS_MAX_LIMIT).toBe(100);
    expect(capped.items).toHaveLength(100);
    expect(capped.items[0]!.roomCode).toBe('CLM130');
    expect(capped.items[99]!.roomCode).toBe('CLM031');
    expect(capped.nextCursor).not.toBeNull();
    // SQL 侧 LIMIT = clamp 后 +1（多用一行判「是否还有下一页」）
    expect(pageQueries().at(-1)!.params.at(-1)).toBe(101);

    // 0 / 负数 / 非数字 ⇒ 缺省 20（不是 0 条、也不是报错）
    for (const raw of ['0', '-5', 'abc']) {
      const p = data(await mine('u-A', undefined, raw));
      expect(p.items, `limit=${raw}`).toHaveLength(20);
      expect(pageQueries().at(-1)!.params.at(-1), `limit=${raw}`).toBe(21);
    }

    // 小值如实生效（证明 clamp 不是「一律缺省」）
    const small = data(await mine('u-A', undefined, '3'));
    expect(small.items).toHaveLength(3);
    expect(small.items.map((i) => i.roomCode)).toEqual(['CLM130', 'CLM129', 'CLM128']);
    expect(small.nextCursor).not.toBeNull();
  });

  it('clamp 纯函数边界（0/负/小数/undefined/数组形态）', () => {
    expect(clampRecordsLimit(undefined)).toBe(20);
    expect(clampRecordsLimit('')).toBe(20);
    expect(clampRecordsLimit('25')).toBe(25);
    expect(clampRecordsLimit('999')).toBe(100);
    expect(clampRecordsLimit(0)).toBe(20);
    expect(clampRecordsLimit(-1)).toBe(20);
    expect(clampRecordsLimit(3.9)).toBe(3);
    expect(clampRecordsLimit('abc')).toBe(20);
    expect(clampRecordsLimit(['5', '9'])).toBe(20); // 数组形态不猜 —— 走缺省
  });

  it('游标编解码：round-trip、URL 安全字母表；非法游标抛 10001（400）', async () => {
    const cursor = encodeRecordsCursor(1759496400000, 42);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRecordsCursor(cursor)).toEqual({ endedAtMs: 1759496400000, playerRowId: 42 });

    for (const bad of ['', 'abc', 'not-base64!!', encodeRecordsCursor(1759496400000, 42) + 'x', Buffer.from('x:y', 'utf8').toString('base64url')]) {
      const err = await mine('u-A', bad).catch((e: unknown) => e);
      expect(err, `cursor=${bad}`).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus(), `cursor=${bad}`).toBe(400);
      expect((err as HttpException).getResponse(), `cursor=${bad}`).toMatchObject({ code: ErrCode.BAD_PARAM });
    }
    expect(pageQueries()).toHaveLength(0); // 非法游标必须**先于任何查询**拒掉
  });

  it('缺 X-User-Id ⇒ 401 + 10002（下游信任模型的入口守卫；网关默认验签的兜底）', async () => {
    const err = await mine(undefined as unknown as string).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toMatchObject({ code: ErrCode.UNAUTHENTICATED });
  });

  it('C7 DTO：递归恰好键集（12 + 6 + 2）+ 长度 3/17/3 + epoch ms + 布尔 won + mySeat 命中我的行', async () => {
    db.addGame({ roomCode: 'DTO001', ownerId: 'u-A', ownerSeat: 2, guestId: 'u-ga', landlordSeat: 2, endedAtMs: T0 + 1000, ownerNickname: 'Alice', ownerHand: HAND34_B });
    db.addGame({ roomCode: 'DTO002', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-ga', landlordSeat: 1, endedAtMs: T0 + 2000 });

    const page = data(await mine('u-A'));
    expect(dtoViolations(page)).toEqual([]);

    // 逐项事实（值语义，不只是键集）
    const [newest, older] = page.items as unknown as Array<Record<string, any>>;
    expect(newest!.roomCode).toBe('DTO002');
    expect(newest!.endedAt).toBe(T0 + 2000); // epoch ms 整数，不是字符串/Date
    expect(newest!.mode).toBe('random');
    expect(newest!.baseScore).toBe(15);
    expect(newest!.multiplier).toBe(2);
    expect(newest!.spring).toBe('none');
    expect(newest!.winner).toBe('landlord');

    // DTO001：我在座位 2 且是地主 ⇒ mySeat=2、我的行 role 匹配、手牌是我的快照（34 位解回 17 张）
    const mineIn = older!;
    expect(mineIn.mySeat).toBe(2);
    expect(mineIn.landlordSeat).toBe(2);
    expect(mineIn.players.map((p: any) => p.seat)).toEqual([0, 1, 2]); // 按座位序
    const me = mineIn.players[mineIn.mySeat];
    expect(me.role).toBe('landlord');
    expect(me.won).toBe(true);
    expect(me.scoreChange).toBe(30);
    expect(me.nickname).toBe('Alice');
    expect(me.hand).toHaveLength(17);
    expect(me.hand[0]).toEqual({ r: 5, s: 0 }); // `19` ⇒ 25 ⇒ floor(25/5)=5, 25%5=0
    // 三家都能看到自己的底牌/手牌解码形态（robot 行也为 17 张）
    expect(mineIn.players[1].hand).toHaveLength(17);
    expect(mineIn.bottomCards).toHaveLength(3);
    expect(mineIn.bottomCards[0]).toEqual({ r: 3, s: 0 });
    // 农民行 won=false（winner=landlord）
    expect(mineIn.players[1].won).toBe(false);
  });

  it('nickname=null 数据路径：旧数据 / 无快照机器人原样透出 null，不回落成别的串', async () => {
    db.addGame({
      roomCode: 'NUL001',
      ownerId: 'u-A',
      ownerSeat: 1,
      guestId: 'u-ga',
      landlordSeat: 0,
      endedAtMs: T0 + 1000,
      ownerNickname: null, // 账号无昵称 ⇒ users.nickname=NULL ⇒ 快照 NULL
      guestNickname: 'Bob',
    });

    const page = data(await mine('u-A')) as unknown as { items: Array<Record<string, any>> };
    expect(dtoViolations(page)).toEqual([]);
    const item = page.items[0]!;
    expect(item.mySeat).toBe(1); // 我在座位 1
    expect(item.players[item.mySeat].nickname).toBeNull(); // 我（无昵称）
    expect(item.players[0].nickname).toBeNull(); // 座位 0 = 机器人（旧数据无快照）
    expect(item.players[2].nickname).toBe('Bob'); // 座位 2 = 客人（有昵称）
    // 键必须**在**（null 不是缺键）—— 键集断言已覆盖，这里再点一次语义
    expect(Object.keys(item.players[item.mySeat])).toContain('nickname');
  });

  it('新数据路径：机器人昵称快照非空时原样透出', async () => {
    db.addGame({
      roomCode: 'BOT001',
      ownerId: 'u-A',
      ownerSeat: 1,
      guestId: 'u-ga',
      landlordSeat: 0,
      endedAtMs: T0 + 2000,
      ownerNickname: 'Alice',
      guestNickname: 'Bob',
    });
    const robotRow = db.players.find((p) => p.is_robot === 1)!;
    robotRow.nickname = '小北';

    const page = data(await mine('u-A')) as unknown as { items: Array<Record<string, any>> };
    expect(dtoViolations(page)).toEqual([]);
    const item = page.items[0]!;
    expect(item.players.find((p: any) => p.seat === robotRow.seat)?.nickname).toBe('小北');
  });

  it('金币场：mode=gold + moneyDelta 读出（正/负/零原样透出；非金币场 NULL ⇒ null，键仍在）', async () => {
    db.addGame({ roomCode: 'GOLD01', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 4000, mode: 'gold', moneyDelta: 1500 });
    db.addGame({ roomCode: 'GOLD02', ownerId: 'u-A', ownerSeat: 1, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 3000, mode: 'gold', moneyDelta: -600 });
    db.addGame({ roomCode: 'GOLD03', ownerId: 'u-A', ownerSeat: 2, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 2000, mode: 'gold', moneyDelta: 0 });
    db.addGame({ roomCode: 'FREE01', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-ga', landlordSeat: 0, endedAtMs: T0 + 1000, mode: 'practice' });

    const page = data(await mine('u-A'));
    expect(dtoViolations(page)).toEqual([]); // 12 键递归恰好键集（moneyDelta 类型也在谓词内）

    const items = (page as unknown as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.roomCode)).toEqual(['GOLD01', 'GOLD02', 'GOLD03', 'FREE01']);
    expect(items.map((i) => i.mode)).toEqual(['gold', 'gold', 'gold', 'practice']);
    // 零变动座是 0（不是 null）；未回写/非金币场才是 null
    expect(items.map((i) => i.moneyDelta)).toEqual([1500, -600, 0, null]);
    expect(Object.keys(items[3]!)).toContain('moneyDelta'); // NULL 是值、不是缺键（「—」由客户端渲染）
  });

  it('断言器判别力自证：注入多余键/少键/类型漂移 ⇒ violations 非空（否则「全绿」可能恒真）', () => {
    const good = sampleItem();
    expect(dtoViolations({ items: [good], nextCursor: null })).toEqual([]);

    // ① 注入多余键（C7 要拦的正是这个：userId/isRobot 这类永不出站字段）
    const withExtra = { ...good, userId: 'u-A' };
    expect(dtoViolations({ items: [withExtra], nextCursor: null }).join()).toContain('userId');

    // ② player 注入 isRobot
    const players = good.players as Array<Record<string, unknown>>;
    const playerExtra = { ...good, players: players.map((p) => ({ ...p, isRobot: true })) };
    expect(dtoViolations({ items: [playerExtra], nextCursor: null }).join()).toContain('isRobot');

    // ③ 少键（缺 mySeat）
    const { mySeat: _omit, ...missKey } = good as Record<string, unknown> & { mySeat: number };
    expect(dtoViolations({ items: [missKey], nextCursor: null })).not.toEqual([]);

    // ④ 类型漂移：won 是 0/1（DB 原样）而不是布尔
    const wonDrift = { ...good, players: players.map((p) => ({ ...p, won: p.won ? 1 : 0 })) };
    expect(dtoViolations({ items: [wonDrift], nextCursor: null }).join()).toContain('won');

    // ⑤ hand 长度 16
    const shortHand = {
      ...good,
      players: players.map((p) => ({ ...p, hand: (p.hand as unknown[]).slice(0, 16) })),
    };
    expect(dtoViolations({ items: [shortHand], nextCursor: null }).join()).toContain('hand');

    // ⑥ moneyDelta 类型漂移（字符串形态）——「12 键里最新那只的眼睛」也要能被抓
    const moneyDrift = { ...good, moneyDelta: '1500' };
    expect(dtoViolations({ items: [moneyDrift], nextCursor: null }).join()).toContain('moneyDelta');
  });

  it('mode 筛选：practice/random/gold 各自只返回对应场次（用户服务端唯一事实来源）', async () => {
    db.addGame({ roomCode: 'R1', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-g1', landlordSeat: 0, endedAtMs: T0 + 1000, mode: 'random' });
    db.addGame({ roomCode: 'P1', ownerId: 'u-A', ownerSeat: 1, guestId: 'u-g2', landlordSeat: 0, endedAtMs: T0 + 2000, mode: 'practice' });
    db.addGame({ roomCode: 'G1', ownerId: 'u-A', ownerSeat: 2, guestId: 'u-g3', landlordSeat: 0, endedAtMs: T0 + 3000, mode: 'gold' });
    db.addGame({ roomCode: 'R2', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-g4', landlordSeat: 0, endedAtMs: T0 + 4000, mode: 'random' });

    const practice = data(await mine('u-A', { mode: 'practice' }));
    expect(items(practice).map((i) => i.roomCode)).toEqual(['P1']);
    expect(items(practice)[0]!.mode).toBe('practice');

    const gold = data(await mine('u-A', { mode: 'gold' }));
    expect(items(gold).map((i) => i.roomCode)).toEqual(['G1']);
    expect(items(gold)[0]!.mode).toBe('gold');

    const random = data(await mine('u-A', { mode: 'random' }));
    expect(items(random).map((i) => i.roomCode)).toEqual(['R2', 'R1']); // 倒序

    // 不传 mode ⇒ 全部
    const all = data(await mine('u-A'));
    expect(items(all)).toHaveLength(4);
  });

  it('mode 非法值（"xxx" 或空串）⇒ BAD_PARAM（服务端严格白名单）', async () => {
    await expect(mine('u-A', { mode: 'xxx' as any })).rejects.toBeInstanceOf(HttpException);
    await expect(mine('u-A', { mode: '' as any })).rejects.toBeInstanceOf(HttpException);
  });

  it('from/to 日期范围筛选：[from, to) 左闭右开；只 from / 只 to 也生效', async () => {
    // T0 + 0 = 第 0 天, T0 + 86400000 = 第 1 天, T0 + 172800000 = 第 2 天
    db.addGame({ roomCode: 'D0', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-g1', landlordSeat: 0, endedAtMs: T0, mode: 'random' });
    db.addGame({ roomCode: 'D1a', ownerId: 'u-A', ownerSeat: 1, guestId: 'u-g2', landlordSeat: 0, endedAtMs: T0 + 43200000, mode: 'random' }); // 第 1 天中间
    db.addGame({ roomCode: 'D1b', ownerId: 'u-A', ownerSeat: 2, guestId: 'u-g3', landlordSeat: 0, endedAtMs: T0 + 86400000, mode: 'random' }); // 第 1 天结束
    db.addGame({ roomCode: 'D2', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-g4', landlordSeat: 0, endedAtMs: T0 + 172800000, mode: 'random' });

    // 只 from = T0 + 43200000：D1a, D1b, D2 都 ≥
    const after = data(await mine('u-A', { from: T0 + 43200000 }));
    expect(items(after).map((i) => i.roomCode)).toEqual(['D2', 'D1b', 'D1a']);

    // 只 to = T0 + 86400000：D0, D1a <
    const before = data(await mine('u-A', { to: T0 + 86400000 }));
    expect(items(before).map((i) => i.roomCode)).toEqual(['D1a', 'D0']);

    // [T0 + 43200000, T0 + 172800000)：D1a, D1b
    const range = data(await mine('u-A', { from: T0 + 43200000, to: T0 + 172800000 }));
    expect(items(range).map((i) => i.roomCode)).toEqual(['D1b', 'D1a']);
  });

  it('mode + 日期 + cursor 组合：三重筛选同时生效（keyset 在同一子集上翻页）', async () => {
    // 10 局：5 gold + 5 random，各自在 dates[0..4]
    const dates: number[] = [];
    for (let i = 0; i < 5; i++) {
      dates.push(T0 + i * 86400000);
      db.addGame({ roomCode: `G${i}`, ownerId: 'u-A', ownerSeat: 0, guestId: 'u-g', landlordSeat: 0, endedAtMs: dates[i]!, mode: 'gold' });
      db.addGame({ roomCode: `R${i}`, ownerId: 'u-A', ownerSeat: 1, guestId: 'u-g', landlordSeat: 0, endedAtMs: dates[i]!, mode: 'random' });
    }

    // [from=dates[1], to=dates[4)) → 包含 G1, G2, G3（≥T0+1d, <T0+4d）
    const page1 = data(await mine('u-A', { mode: 'gold', from: dates[1]!, to: dates[4]!, limit: 2 }));
    const p1Rooms = items(page1).map((i) => i.roomCode);
    console.log('COMBINE page1 rooms:', p1Rooms, 'cursor:', nextCursor(page1));
    // 倒序：ended_at DESC → G3(T0+3d), G2(T0+2d), G1(T0+1d) → 前 2 条 G3, G2
    expect(p1Rooms).toEqual(['G3', 'G2']);
    expect(nextCursor(page1)).not.toBeNull();

    const page2 = data(await mine('u-A', { mode: 'gold', from: dates[1]!, to: dates[4]!, limit: 2, cursor: nextCursor(page1)! }));
    const p2Rooms = items(page2).map((i) => i.roomCode);
    console.log('COMBINE page2 rooms:', p2Rooms);
    expect(p2Rooms).toEqual(['G1']);
    expect(nextCursor(page2)).toBeNull();

    // 改 mode 不影响随机场次日期筛选
    const otherMode = data(await mine('u-A', { mode: 'random', from: dates[1]!, to: dates[4]!, limit: 10 }));
    expect(items(otherMode).map((i) => i.roomCode).sort()).toEqual(['R1', 'R2', 'R3']);
  });

  it('from/to 非法值：非整数静默忽略（不抛错，退化成"全量"）', async () => {
    db.addGame({ roomCode: 'R1', ownerId: 'u-A', ownerSeat: 0, guestId: 'u-g', landlordSeat: 0, endedAtMs: T0, mode: 'random' });

    // from='abc' → Number('abc') = NaN → service 静默忽略 → 返回全部
    const page1 = data(await mine('u-A', { from: 'abc' as any }));
    expect(items(page1)).toHaveLength(1);

    // to=NaN → Number(NaN) = NaN → 同样静默忽略
    const page2 = data(await mine('u-A', { to: NaN }));
    expect(items(page2)).toHaveLength(1);
  });
});
