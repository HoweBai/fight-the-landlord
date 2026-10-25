import { Controller, Inject, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { DataSource, type EntityManager } from 'typeorm';
import {
  ErrCode,
  RPC_PATTERNS,
  isPdkSettlementResult,
  validateRecordMoneyDelta,
  type DdzSettlementResult,
  type PdkSettlementResult,
  type RecordMoneyDeltaRequest,
  type RecordMoneyDeltaResponse,
  type RecordWriteRequest,
  type RecordWriteResponse,
} from '@fight-the-landlord/protocol';

/**
 * 记录片 T4（规格 §2.2 / 设计 D2·D3）：`record.write` 的 **user-service 接收侧**。
 * ② 金币场 T7 起本类**同时**承载 `record.moneyDelta`（结算后 `money_delta` 向量回写，
 * 规格 §3；见下方 handler 处的语义注释）。
 *
 * 🔴 **J21 的接收侧**：本类的 `@MessagePattern(RPC_PATTERNS.recordWrite)` /
 * `@MessagePattern(RPC_PATTERNS.recordMoneyDelta)` 是
 * `robot-availability-wiring.gate.test.ts` 全包扫描要找的那两条；承载类还必须被某个
 * `*.module.ts` 的 `controllers:` 注册（`app.module.ts`）——**加键与接收侧/注册必须同一提交**。
 * ⚠️ 常量形态（`RPC_PATTERNS.<键>`）是硬要求：字面量形态在 J21 的集合等值里会表现为
 * 「缺少接收侧」（闸的自证②钉着这条）。
 *
 * ─── 写入语义（逐条对应设计 D2·D3）────────────────────────────────────────
 *  - **事务**：`dataSource.transaction` 内写 1 行 `game_records` + 3 行 `game_record_players`
 *    —— 防「有记录无 players」孤儿；任何一步抛 ⇒ 整个事务回滚、统一返回 `{ok:false}`（不静默）。
 *  - **幂等**：唯一键 `(room_code, game_version)`。重复投递 ⇒ 命中既有行 ⇒ 比对 `ended_at`：
 *    |差| **超**阈值 ⇒ **error 级日志**（码复用静默吞的保险），否则静默 `written=false`。
 *    ⚠️ 真正防重的硬闸是**库的唯一键**；这里是「命中时怎么表现」的语义层。
 *  - **昵称快照**：人类 = 按 `user_id IN (...)` 查 `users` 表；机器人（`user_id=NULL`）
 *    **不进查询**，快照取发送侧携带的展示名（`RecordWriteRequest.seats[].nickname`，
 *    2026-10-22 机器人拟人昵称片），缺省 NULL。查无此人（账号已删）⇒ NULL，不抛。
 *  - **绝不写 displayId**：`game_record_players.user_id` 只写人类真 id；`robot_id` 写内部 botId。
 *  - `role`/`score_change`/`won` **由 `landlordSeat` 与 `winner` 推导**（不信座位自带身份）。
 *
 * ⚠️ **业务错误不抛**（R220 信封）：校验失败 ⇒ `{ok:false, BAD_PARAM}`；库/未知故障 ⇒
 * `{ok:false, UPSTREAM_UNAVAILABLE}`。调用方（room 的 RecordClient）按码分流/兜底。
 * ⚠️ **不设应用层 token**（R223）：TCP 监听方不走 HTTP 中间件；边界 = compose 内网 +
 * 3101 不发布到宿主（基文件只 `expose`，宿主映射只在 override）。RPC 元数据（`dto.meta`）
 * 本任务不消费——处理期日志的 trace 上下文接线（R1107 的接收侧半边）不在 T4 的改动面内。
 *
 * ⚠️ **DDL 是唯一真源**（`migrations/1789400000000-GameRecords.ts`）：本文件全部 SQL 的
 * 列序/列名与它逐字对齐；两边由 `migration.test.ts` 与 `record.rpc.test.ts` 分别钉住。
 */

/**
 * 重复投递时 `ended_at` 允许的 |差|（毫秒）。
 *
 * 语义（设计 D2：**码复用静默吞的保险**）：同一局被重复投递时 payload 逐毫秒相同
 * （room 不重试、payload 一次性组装），任何**有意义的**差异都指向「同 `(room_code,
 * game_version)` 被另一局复用」——一局牌最短也以分钟计，而重复投递的差异只可能是
 * 截断/解析噪声，故取 **60s**：留足时钟/驱动口径的余量，又远小于两局牌的最小间隔。
 */
export const ENDED_AT_MISMATCH_THRESHOLD_MS = 60_000;

/**
 * 金币场 T7（规格 §3 逐字）：`record.moneyDelta` 的两条 SQL。
 *
 * ① 存在集合的读：`game_record_players` 只有 `record_id` 列（`1789400000000-GameRecords.ts`），
 *    房间/局号全在 `game_records` ⇒ 必须 JOIN；
 * ② 逐座回写：MySQL 多表 UPDATE 语法（`SET p.money_delta = ?`），参数序
 *    `[delta, roomCode, gameVersion, seat]`。
 *
 * ⚠️ **回执行存在性（不得用 affectedRows）**：同值重写时 MySQL 的 affectedRows = 0 ——
 * 拿它当回执会把「幂等重发」误判成「未落库」。命中集合由 ① 的存在集合 ∩ 请求座位得出。
 */
const MONEY_DELTA_SEATS_SQL =
  'SELECT p.seat FROM game_record_players p JOIN game_records r ON p.record_id = r.id WHERE r.room_code = ? AND r.game_version = ?';
const MONEY_DELTA_UPDATE_SQL =
  'UPDATE game_record_players p JOIN game_records r ON p.record_id = r.id SET p.money_delta = ? WHERE r.room_code = ? AND r.game_version = ? AND p.seat = ?';

/**
 * pdk 分支的两条 SQL（Task 4.0）：与上面同语义，只是换单独的 pdk 两表（D11）。
 * 回执行存性仍以「存在集合 ∩ 请求座位」为准，**不用 affectedRows**（同值重写 = 0）。
 */
const MONEY_DELTA_SEATS_SQL_PDK =
  'SELECT p.seat FROM game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id WHERE r.room_code = ? AND r.game_version = ?';
const MONEY_DELTA_UPDATE_SQL_PDK =
  'UPDATE game_record_players_pdk p JOIN game_records_pdk r ON p.record_id = r.id SET p.money_delta = ? WHERE r.room_code = ? AND r.game_version = ? AND p.seat = ?';

/** 校验失败的中文原因（`{ok:false}` 的 message；与 `parseConfigValue` 同口径）。 */

/**
 * 玩家座位的身份/昵称规则（ddz 与 pdk 共用）。
 *
 * 设计 D2 逐字：机器人座 ⇒ `userId` NULL（绝不写 displayId）；人类座必须有 userId；
 * 人类昵称只允许来自 `users` 表；机器人昵称快照 trim 后 1–50 字符。
 */
function invalidSeatIdentityReason(
  seat: RecordWriteRequest['seats'][number],
  i: number,
): string | null {
  if (seat.userId !== null && typeof seat.userId !== 'string') return `seats[${i}].userId 必须是字符串或 null`;
  if (typeof seat.isRobot !== 'boolean') return `seats[${i}].isRobot 必须是布尔`;
  if (seat.robotId !== null && typeof seat.robotId !== 'string') return `seats[${i}].robotId 必须是字符串或 null`;
  if (seat.isRobot && seat.userId !== null) {
    // 设计 D2 逐字：机器人座 ⇒ userId NULL（发送侧若把 displayId 塞进来，在这里当场拒收）
    return `seats[${i}] 是机器人座但带了 userId —— 机器人座位的 userId 必须为 null（绝不写 displayId）`;
  }
  if (!seat.isRobot && seat.userId === null) {
    // 2026-10-22 机器人昵称片：人类座必须有 userId；否则会写出
    // 「user_id=NULL 且 is_robot=0」的脏行（历史「我的战绩」永远 JOIN 不到）。
    return `seats[${i}] 是人类座但 userId 为 null —— 人类座必须带 userId`;
  }
  if (seat.nickname !== undefined && seat.nickname !== null && typeof seat.nickname !== 'string') {
    return `seats[${i}].nickname 必须是字符串或 null`;
  }
  if (typeof seat.nickname === 'string') {
    const nickname = seat.nickname.trim();
    if (nickname.length < 1 || nickname.length > 50) {
      return `seats[${i}].nickname trim 后必须是 1–50 字符`;
    }
    if (!seat.isRobot) {
      // 人类昵称快照只允许来自 users 表；发送侧携带一律视为契约错误。
      return `seats[${i}] 是人类座但带了 nickname —— 人类昵称快照只允许来自 users 表`;
    }
  }
  return null;
}

/**
 * pdk 分支的校验（spec §4.9.2）：`seats.length === playerCount`、手牌 16/12 张、
 * `playedCount` 必填且 = 初始手牌 − `remaining[seat]`、无 `bottomCards`、
 * `unusedCards` 仅 2 人局且 32 hex、`result` 必须是跑得快结算且零和。
 */
function invalidPdkReason(r: Partial<RecordWriteRequest>): string | null {
  const rawResult = r.result as RecordWriteRequest['result'] | undefined;
  if (rawResult === undefined || !isPdkSettlementResult(rawResult)) {
    return 'result 必须是跑得快结算（gameType=paodekuai 时）';
  }
  const result: PdkSettlementResult = rawResult;
  const playerCount = result.playerCount;
  if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) {
    return 'result.playerCount 必须是 2、3 或 4';
  }
  if (r.playerCount !== playerCount) {
    return `playerCount 必须等于 result.playerCount（${playerCount}）`;
  }
  if (r.bottomCards !== undefined) {
    return 'pdk 记录不得带 bottomCards（跑得快没有底牌）';
  }
  if (r.unusedCards !== undefined) {
    if (playerCount !== 2) return 'unusedCards 仅 2 人局可用（扣下的第三份牌）';
    if (typeof r.unusedCards !== 'string' || r.unusedCards.length !== 32) {
      return 'unusedCards 必须是 32 位字符串（16 张 × 2 hex）';
    }
  }

  if (!Array.isArray(result.winnerSeats) || result.winnerSeats.length !== 1) {
    return 'result.winnerSeats 必须恰 1 个座位（跑得快只有一个赢家）';
  }
  const winnerSeat = result.winnerSeats[0] as number;
  if (!Number.isInteger(winnerSeat) || winnerSeat < 0 || winnerSeat >= playerCount) {
    return `result.winnerSeats[0] 必须是 0..${playerCount - 1} 的整数`;
  }
  if (!Array.isArray(result.remaining) || result.remaining.length !== playerCount) {
    return `result.remaining 必须恰 ${playerCount} 条`;
  }
  for (const [seat, remaining] of result.remaining.entries()) {
    if (!Number.isInteger(remaining) || remaining < 0) {
      return `result.remaining[${seat}] 必须是非负整数`;
    }
  }
  if (!Array.isArray(result.scoreChanges) || result.scoreChanges.length !== playerCount) {
    return `result.scoreChanges 必须恰 ${playerCount} 条`;
  }
  let scoreSum = 0;
  for (const [i, change] of result.scoreChanges.entries()) {
    if (typeof change !== 'object' || change === null) return `result.scoreChanges[${i}] 必须是对象`;
    // 「长度 = playerCount、座位 0..playerCount-1 升序」⇔ 第 i 条的 seat === i。
    if (change.seat !== i) return `result.scoreChanges[${i}].seat 必须是 ${i}（座位升序）`;
    if (typeof change.delta !== 'number' || !Number.isInteger(change.delta)) {
      return `result.scoreChanges[${i}].delta 必须是整数`;
    }
    scoreSum += change.delta;
  }
  if (scoreSum !== 0) return `result.scoreChanges 必须零和（sum=${scoreSum}）`;
  if (typeof result.multiplier !== 'number' || !Number.isInteger(result.multiplier) || result.multiplier < 1) {
    return 'result.multiplier 必须是正整数';
  }
  if (!Number.isInteger(result.bombCount) || result.bombCount < 0) {
    return 'result.bombCount 必须是非负整数';
  }
  if (typeof result.guan !== 'boolean' || typeof result.spring !== 'boolean') {
    return 'result.guan / result.spring 必须是布尔';
  }
  if (!Array.isArray(result.baobenSeats)) return 'result.baobenSeats 必须是数组';
  for (const [i, seat] of result.baobenSeats.entries()) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= playerCount) {
      return `result.baobenSeats[${i}] 必须是 0..${playerCount - 1} 的整数`;
    }
  }

  if (!Array.isArray(r.seats) || r.seats.length !== playerCount) {
    return `seats 必须恰 ${playerCount} 条`;
  }
  const seatSeen = new Set<number>();
  const handLength = playerCount === 4 ? 24 : 32;
  const initialHand = playerCount === 4 ? 12 : 16;
  for (const [i, seat] of r.seats.entries()) {
    if (typeof seat !== 'object' || seat === null) return `seats[${i}] 必须是对象`;
    if (!Number.isInteger(seat.seat) || seat.seat < 0 || seat.seat >= playerCount) {
      return `seats[${i}].seat 必须是 0..${playerCount - 1} 的整数`;
    }
    if (seatSeen.has(seat.seat)) return `座位必须是 0..${playerCount - 1} 各一（不得重复）`;
    seatSeen.add(seat.seat);
    const identity = invalidSeatIdentityReason(seat, i);
    if (identity !== null) return identity;
    if (typeof seat.hand !== 'string' || seat.hand.length !== handLength) {
      return `seats[${i}].hand 必须是 ${handLength} 位字符串`;
    }
    if (
      typeof seat.playedCount !== 'number' ||
      !Number.isInteger(seat.playedCount) ||
      seat.playedCount < 0
    ) {
      return `seats[${i}].playedCount 必须是非负整数（跑得快记录必填）`;
    }
    // RH1-b：playedCount 的来源必须可审计 —— 初始手牌数 − 剩余张数。
    const expectedPlayed = initialHand - (result.remaining[seat.seat] as number);
    if (seat.playedCount !== expectedPlayed) {
      return `seats[${i}].playedCount 必须等于初始手牌 − remaining[${seat.seat}]（期望 ${expectedPlayed}，收到 ${seat.playedCount}）`;
    }
  }
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return 'startedAt 必须是有限数（epoch ms）';
  if (typeof r.endedAt !== 'number' || !Number.isFinite(r.endedAt)) return 'endedAt 必须是有限数（epoch ms）';
  return null;
}

function invalidReason(req: unknown): string | null {
  if (typeof req !== 'object' || req === null) return '载荷必须是对象';
  const r = req as Partial<RecordWriteRequest>;
  if (typeof r.roomCode !== 'string' || r.roomCode.length === 0) return 'roomCode 必须是非空字符串';
  if (!Number.isInteger(r.gameVersion) || (r.gameVersion as number) <= 0) {
    return 'gameVersion 必须是正整数';
  }
  if (r.mode !== 'random' && r.mode !== 'practice' && r.mode !== 'gold') {
    return 'mode 必须是 random、practice 或 gold';
  }
  if (typeof r.baseScore !== 'number' || !Number.isFinite(r.baseScore)) return 'baseScore 必须是有限数';
  if (r.gameType !== undefined && r.gameType !== 'doudizhu' && r.gameType !== 'paodekuai') {
    return 'gameType 必须是 doudizhu 或 paodekuai';
  }
  const result = r.result as Partial<RecordWriteRequest['result']> | undefined;
  if (typeof result !== 'object' || result === null) return 'result 必须是对象';
  // 多玩法（Task 4.0）：按 gameType 分支；**缺失 ⇒ 斗地主/3**（旧请求零破坏）。
  if (r.gameType === 'paodekuai') return invalidPdkReason(r);

  const ddz = result as Partial<DdzSettlementResult>;
  if ('gameType' in result && (result as { gameType?: unknown }).gameType === 'paodekuai') {
    return 'gameType 缺失或非 paodekuai 时 result 必须是斗地主结算';
  }
  if (ddz.winner !== 'landlord' && ddz.winner !== 'farmer') return 'result.winner 必须是 landlord 或 farmer';
  if (!Number.isInteger(ddz.landlordSeat) || (ddz.landlordSeat as number) < 0 || (ddz.landlordSeat as number) > 2) {
    return 'result.landlordSeat 必须是 0..2 的整数';
  }
  if (typeof ddz.multiplier !== 'number' || !Number.isFinite(ddz.multiplier)) return 'result.multiplier 必须是有限数';
  if (ddz.spring !== 'none' && ddz.spring !== 'spring' && ddz.spring !== 'anti-spring') {
    return 'result.spring 必须是 none/spring/anti-spring';
  }
  if (typeof ddz.landlordScoreChange !== 'number' || !Number.isFinite(ddz.landlordScoreChange)) {
    return 'result.landlordScoreChange 必须是有限数';
  }
  if (typeof ddz.farmerScoreChange !== 'number' || !Number.isFinite(ddz.farmerScoreChange)) {
    return 'result.farmerScoreChange 必须是有限数';
  }
  if (!Array.isArray(r.seats) || r.seats.length !== 3) return 'seats 必须恰 3 条';
  const seatSeen = new Set<number>();
  for (const [i, seat] of r.seats.entries()) {
    if (typeof seat !== 'object' || seat === null) return `seats[${i}] 必须是对象`;
    if (!Number.isInteger(seat.seat) || seat.seat < 0 || seat.seat > 2) return `seats[${i}].seat 必须是 0..2 的整数`;
    if (seatSeen.has(seat.seat)) return '座位必须是 0/1/2 各一（不得重复）';
    seatSeen.add(seat.seat);
    const identity = invalidSeatIdentityReason(seat, i);
    if (identity !== null) return identity;
    if (typeof seat.hand !== 'string' || seat.hand.length !== 34) return `seats[${i}].hand 必须是 34 位字符串`;
  }
  if (typeof r.bottomCards !== 'string' || r.bottomCards.length !== 6) return 'bottomCards 必须是 6 位字符串';
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return 'startedAt 必须是有限数（epoch ms）';
  if (typeof r.endedAt !== 'number' || !Number.isFinite(r.endedAt)) return 'endedAt 必须是有限数（epoch ms）';
  return null;
}

@Controller()
export class RecordRpcController {
  private readonly logger = new Logger(RecordRpcController.name);

  /**
   * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例，见 `health.service.ts`）：不依赖
   * `emitDecoratorMetadata` 发出的 `design:paramtypes`（vitest/esbuild 不发它 ⇒
   * 只靠类型的注入在单测里会静默注入 `undefined`）。
   * ⚠️ `DataSource` 是**值导入**（`import { DataSource } from 'typeorm'`）——
   * `import type` 会让容器解析不到 token（DI 陷阱：单测与 tsc 都看不见，真容器启动即崩）。
   */
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  @MessagePattern(RPC_PATTERNS.recordWrite)
  async write(@Payload() dto: RecordWriteRequest): Promise<RecordWriteResponse> {
    const reason = invalidReason(dto);
    if (reason !== null) {
      // 调用方（room）的组装 bug —— 校验先于**任何**库操作（不得「400 了却先落库」）。
      return { ok: false, code: ErrCode.BAD_PARAM, message: `record.write 载荷不合法：${reason}` };
    }

    try {
      const written = await this.dataSource.transaction((manager) => this.persist(manager, dto));
      return { ok: true, data: { written } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `record.write 失败：roomCode=${dto.roomCode} gameVersion=${dto.gameVersion} reason=${message}`,
      );
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }

  /**
   * 金币场 T7（规格 §3）：`record.moneyDelta` 接收侧 —— 结算后把三人 `money_delta`
   * 向量（**含 0**，零变动座写 0、不留 NULL）回写到该局的三条玩家行。
   *
   * ─── 语义（逐条对应规格 §3）──────────────────────────────────────────────
   *  - **回执行存在性**：先查该局**已落库**的座位集合，再对**交集**逐座 UPDATE；
   *    `matched` = 命中集合（升序，来自存在性而非 affectedRows）。
   *  - **记录行缺失 ≠ 错误**：`record.write` 与 `record.moneyDelta` 都是幂等写、
   *    发送侧可能乱序（record 行未落库时本 handler 返回 `matched:[]`）——由 room 侧
   *    outbox 重发收敛；这里**不抛**、不返回错误码。
   *  - **校验先于任何库操作**：唯一校验点 = protocol 的 `validateRecordMoneyDelta`
   *    （T2 契约，本文件不另写一份）；失败 ⇒ `{ok:false, BAD_PARAM}` 并带中文原因。
   *  - 库/未知故障 ⇒ `{ok:false, UPSTREAM_UNAVAILABLE}`（与 `record.write` 同口径）。
   *  - 回写**无事务**：逐座 UPDATE 各自幂等、乱序/半程失败由重发收敛（matched 即进度），
   *    不存在 `record.write` 那种「有记录无 players」的跨行不变量。
   */
  @MessagePattern(RPC_PATTERNS.recordMoneyDelta)
  async moneyDelta(@Payload() dto: RecordMoneyDeltaRequest): Promise<RecordMoneyDeltaResponse> {
    try {
      validateRecordMoneyDelta(dto);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, code: ErrCode.BAD_PARAM, message: `record.moneyDelta 载荷不合法：${reason}` };
    }

    try {
      const matched = await this.applyMoneyDelta(dto);
      return { ok: true, data: { matched } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `record.moneyDelta 失败：roomCode=${dto.roomCode} gameVersion=${dto.gameVersion} reason=${message}`,
      );
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }

  /**
   * 存在集合 → 交集逐座 UPDATE（SQL 逐字规格 §3，见文件上方的两条常量）。
   * ⚠️ `matched` 只由**存在集合 ∩ 请求座位**得出，与 UPDATE 的 affectedRows 无关
   * （同值重写返回 0，正是幂等重发时不能拿它当回执的原因）。
   */
  private async applyMoneyDelta(req: RecordMoneyDeltaRequest): Promise<number[]> {
    // 多玩法（Task 4.0）：pdk 战绩在**单独的表**里（D11）；旧请求缺 gameType ⇒ 斗地主。
    if (req.gameType === 'paodekuai') return this.applyMoneyDeltaPdk(req);

    const rows = (await this.dataSource.query(MONEY_DELTA_SEATS_SQL, [
      req.roomCode,
      req.gameVersion,
    ])) as Array<{ seat: number | string }>;
    const existing = new Set(rows.map((row) => Number(row.seat)));

    const matched: number[] = [];
    for (const { seat, delta } of req.deltas) {
      // deltas 已被校验为座位 0/1/2 升降各一 ⇒ 交集 = 存在集合；按升序逐座回写。
      if (!existing.has(seat)) continue;
      await this.dataSource.query(MONEY_DELTA_UPDATE_SQL, [delta, req.roomCode, req.gameVersion, seat]);
      matched.push(seat);
    }
    return matched;
  }

  /** pdk 分支：同语义（存在集合 ∩ 请求座位、逐座 UPDATE），只是换两张 pdk 表。 */
  private async applyMoneyDeltaPdk(req: RecordMoneyDeltaRequest): Promise<number[]> {
    const rows = (await this.dataSource.query(MONEY_DELTA_SEATS_SQL_PDK, [
      req.roomCode,
      req.gameVersion,
    ])) as Array<{ seat: number | string }>;
    const existing = new Set(rows.map((row) => Number(row.seat)));

    const matched: number[] = [];
    for (const { seat, delta } of req.deltas) {
      if (!existing.has(seat)) continue;
      await this.dataSource.query(MONEY_DELTA_UPDATE_SQL_PDK, [
        delta,
        req.roomCode,
        req.gameVersion,
        seat,
      ]);
      matched.push(seat);
    }
    return matched;
  }

  /**
   * 事务体：1 行记录 + 3 行玩家。返回 `written`（false = 幂等命中、未写新行）。
   * ⚠️ **本方法只许从 `dataSource.transaction` 的回调里调用** —— 直接调用会以
   * 自动提交逐条落库，「无孤儿」的保证当场失效。
   */
  private async persist(manager: EntityManager, req: RecordWriteRequest): Promise<boolean> {
    // 多玩法（Task 4.0）：pdk 写单独的 pdk 两表（D11）—— **幂等/昵称查询都不得碰旧表**，
    // 因此必须先于斗地主的幂等检查分支。
    if (isPdkSettlementResult(req.result)) {
      return this.persistPdk(manager, req, req.result);
    }

    // ── 幂等检查：命中既有行 ⇒ 比对 ended_at，绝不 INSERT ─────────────────
    // `FOR UPDATE`：给「同 key 并发首写」串行化（后到者在此读到先到者已提交的行）；
    // 唯一键 uk_room_version 仍是最终硬闸（SELECT 与 INSERT 之间不再有可乘之隙）。
    const existing = (await manager.query(
      'SELECT `id`, `ended_at` FROM `game_records` WHERE `room_code` = ? AND `game_version` = ? FOR UPDATE',
      [req.roomCode, req.gameVersion],
    )) as Array<{ id: number | string; ended_at: Date | string }>;

    if (existing.length > 0) {
      this.flagEndedAtMismatch(req, existing[0]!.ended_at);
      return false;
    }

    // ── 昵称快照：user_id IN 查 users（机器人不进查询 ⇒ 快照取发送侧展示名）──────
    const nicknameById = await this.loadNicknameSnapshots(manager, req.seats);

    const ddzResult: DdzSettlementResult = req.result;

    // ── 1 行 game_records（列序与 DDL 逐字一致）──────────────────────────
    const insertResult = (await manager.query(
      'INSERT INTO `game_records` (' +
        '`room_code`, `game_version`, `mode`, `base_score`, `winner`, `landlord_seat`, `multiplier`, `spring`, ' +
        '`landlord_score_change`, `farmer_score_change`, `bottom_cards`, `started_at`, `ended_at`, `created_at`' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))',
      [
        req.roomCode,
        req.gameVersion,
        req.mode,
        req.baseScore,
        ddzResult.winner,
        ddzResult.landlordSeat,
        ddzResult.multiplier,
        ddzResult.spring,
        ddzResult.landlordScoreChange,
        ddzResult.farmerScoreChange,
        req.bottomCards,
        new Date(req.startedAt),
        new Date(req.endedAt),
      ],
    )) as { insertId?: number };

    const recordId = insertResult?.insertId;
    if (typeof recordId !== 'number' || !Number.isFinite(recordId)) {
      // 拿不到自增 id ⇒ 玩家行的 record_id 必错 ⇒ 当场抛，让事务回滚（不写孤儿）。
      throw new Error('game_records INSERT 未返回 insertId');
    }

    // ── 3 行 game_record_players（按座位序；role/score/won 由 landlordSeat+winner 推导）──
    // `money_delta` 刻意缺省（列可空；唯一回写入口 = 本类的 `record.moneyDelta` handler，
    // 结算后按向量回写 —— `record.write` 契约零改动，本 INSERT 不写它）。
    for (const seat of [...req.seats].sort((a, b) => a.seat - b.seat)) {
      const isLandlord = seat.seat === ddzResult.landlordSeat;
      const role = isLandlord ? 'landlord' : 'farmer';
      const scoreChange = isLandlord ? ddzResult.landlordScoreChange : ddzResult.farmerScoreChange;
      const won = role === ddzResult.winner;
      /**
       * 机器人昵称快照（2026-10-22）：只认发送侧带上的展示名；人类仍查 `users`。
       * `displayId` 永不落库 —— 这里只取 `seat.nickname` 这个展示字段。
       */
      const nicknameSnapshot = seat.isRobot
        ? (seat.nickname?.trim() || null)
        : seat.userId === null
          ? null
          : (nicknameById.get(seat.userId) ?? null);
      await manager.query(
        'INSERT INTO `game_record_players` (' +
          '`record_id`, `seat`, `user_id`, `is_robot`, `robot_id`, `nickname`, `role`, `score_change`, `won`, `hand`, `ended_at`' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          recordId,
          seat.seat,
          seat.userId,
          seat.isRobot ? 1 : 0,
          seat.robotId,
          nicknameSnapshot,
          role,
          scoreChange,
          won ? 1 : 0,
          seat.hand,
          new Date(req.endedAt),
        ],
      );
    }
    return true;
  }

  /**
   * pdk 事务体：1 行 `game_records_pdk` + `player_count` 行 `game_record_players_pdk`。
   *
   * - **单独建表**（D11）：本方法不写、也不读斗地主两表；
   * - 幂等与 ddz 同款：`uk_pdk_room_version` + 命中时只比对 `ended_at`（BIGINT 毫秒）；
   * - `remaining` / `baoben_seats` / `score_changes` 存 JSON；`winner_seat` 取唯一赢家；
   * - `unused_cards` 仅 2 人局（`null` 表示无扣牌）；
   * - `money_delta` 刻意缺省（唯一回写入口 = `record.moneyDelta` 的 pdk 分支）。
   */
  private async persistPdk(
    manager: EntityManager,
    req: RecordWriteRequest,
    result: PdkSettlementResult,
  ): Promise<boolean> {
    const existing = (await manager.query(
      'SELECT `id`, `ended_at` FROM `game_records_pdk` WHERE `room_code` = ? AND `game_version` = ? FOR UPDATE',
      [req.roomCode, req.gameVersion],
    )) as Array<{ id: number | string; ended_at: number | string }>;

    if (existing.length > 0) {
      this.flagEndedAtMismatch(req, existing[0]!.ended_at);
      return false;
    }

    const nicknameById = await this.loadNicknameSnapshots(manager, req.seats);

    const insertResult = (await manager.query(
      'INSERT INTO `game_records_pdk` (' +
        '`room_code`, `game_version`, `mode`, `game_type`, `player_count`, `base_score`, `winner_seat`, `remaining`, ' +
        '`multiplier`, `bomb_count`, `guan`, `spring`, `baoben_seats`, `score_changes`, `unused_cards`, ' +
        '`started_at`, `ended_at`' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        req.roomCode,
        req.gameVersion,
        req.mode,
        req.gameType ?? 'paodekuai',
        result.playerCount,
        req.baseScore,
        result.winnerSeats[0],
        JSON.stringify(result.remaining),
        result.multiplier,
        result.bombCount,
        result.guan ? 1 : 0,
        result.spring ? 1 : 0,
        JSON.stringify(result.baobenSeats),
        JSON.stringify(result.scoreChanges),
        req.unusedCards ?? null,
        req.startedAt,
        req.endedAt,
      ],
    )) as { insertId?: number };

    const recordId = insertResult?.insertId;
    if (typeof recordId !== 'number' || !Number.isFinite(recordId)) {
      // 拿不到自增 id ⇒ 玩家行的 record_id 必错 ⇒ 当场抛，让事务回滚（不写孤儿）。
      throw new Error('game_records_pdk INSERT 未返回 insertId');
    }

    for (const seat of [...req.seats].sort((a, b) => a.seat - b.seat)) {
      const nicknameSnapshot = seat.isRobot
        ? (seat.nickname?.trim() || null)
        : seat.userId === null
          ? null
          : (nicknameById.get(seat.userId) ?? null);
      const scoreChange = result.scoreChanges.find((c) => c.seat === seat.seat)?.delta ?? 0;
      const won = seat.seat === result.winnerSeats[0] ? 1 : 0;
      await manager.query(
        'INSERT INTO `game_record_players_pdk` (' +
          '`record_id`, `seat`, `user_id`, `is_robot`, `robot_id`, `nickname`, `hand`, `played_count`, `score_change`, `won`, `ended_at`' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          recordId,
          seat.seat,
          seat.userId,
          seat.isRobot ? 1 : 0,
          seat.robotId,
          nicknameSnapshot,
          seat.hand,
          seat.playedCount,
          scoreChange,
          won,
          req.endedAt,
        ],
      );
    }
    return true;
  }

  /**
   * 昵称快照的真源查询（ddz/pdk 共用）：人类 `user_id IN (...)` 查 `users`；
   * 机器人**不进查询**（快照取发送侧展示名）。查无此人 ⇒ 缺键 ⇒ 落 NULL，不抛。
   */
  private async loadNicknameSnapshots(
    manager: EntityManager,
    seats: RecordWriteRequest['seats'],
  ): Promise<Map<string, string | null>> {
    const humanIds = seats.flatMap((seat) => (seat.userId === null ? [] : [seat.userId]));
    const nicknameById = new Map<string, string | null>();
    if (humanIds.length === 0) return nicknameById;
    const placeholders = humanIds.map(() => '?').join(', ');
    const rows = (await manager.query(
      `SELECT \`id\`, \`nickname\` FROM \`users\` WHERE \`id\` IN (${placeholders})`,
      humanIds,
    )) as Array<{ id: string; nickname: string | null }>;
    for (const row of rows) nicknameById.set(row.id, row.nickname);
    return nicknameById;
  }

  /**
   * 幂等命中时的 `ended_at` 比对（设计 D2）：|差| 超阈值 ⇒ **error 级**日志
   * （响亮不静默——码复用静默吞的保险）；不超 ⇒ 什么都不做（重复投递是正常路径）。
   * ⚠️ 不抛：告警是**观测**，重复投递本身仍然返回 `written=false`。
   * ⚠️ pdk 表的 `ended_at` 是 BIGINT（epoch ms），ddz 是 datetime ⇒ 形参兼容 `Date | string | number`。
   */
  private flagEndedAtMismatch(req: RecordWriteRequest, storedEndedAt: Date | string | number): void {
    const storedMs =
      storedEndedAt instanceof Date
        ? storedEndedAt.getTime()
        : typeof storedEndedAt === 'number'
          ? storedEndedAt
          : new Date(storedEndedAt).getTime();
    const diff = Math.abs(storedMs - req.endedAt);
    if (Number.isFinite(diff) && diff <= ENDED_AT_MISMATCH_THRESHOLD_MS) return;
    this.logger.error(
      `record.write duplicate 命中但 ended_at 不一致（疑似 room_code+game_version 复用）：` +
        `roomCode=${req.roomCode} gameVersion=${req.gameVersion} ` +
        `storedEndedAt=${String(storedEndedAt)} incomingEndedAt=${req.endedAt} diffMs=${Number.isFinite(diff) ? String(diff) : 'unparsable'}`,
    );
  }
}
