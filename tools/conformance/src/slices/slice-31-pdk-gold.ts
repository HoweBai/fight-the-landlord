/**
 * slice-31：PDK 金币场 + 账本玩法维度 + 管理玩家统计（A2/A3 真栈）。
 *
 * 覆盖：
 *  ⓪ 容器/队列清源 + 配置快照/开启（pdk enabled、goldRoomEnabled、15 档台费 10%、rake=0）
 *  ① 3 人金币匹配/开局（gameType/playerCount）
 *  ② 台费：3 笔 entry_fee，金额 1、gameType=pdk、DB action_id
 *  ③ 确定性注入 game_settle（RUN_TAG 唯一）⇒ DB/管理面/汇总玩法维度
 *  ④ 真实对局结算：按非零 scoreChanges 逐座核对；全零 ⇒ 无 op
 *  ⑤ 汇总相对基线增量（entry_fee/game_settle pdk）
 *  ⑥ 免单 RPC：gameType=pdk 落库 + summary byGame
 *  ⑦ 记录：game_type/逐座 score_change/won + 对外 DTO
 *  ⑧ 管理玩家列表/最近对局/lastActive/active7
 *  ⑨ lastActive 三分支：device-only / DDZ-only / PDK
 *
 * ⚠️ 本机无 Docker 时只做 tsc；真栈执行登记“待权威轮”。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyEntryFeeSkipData,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type HarnessUser,
} from '../lib/http';
import { playPdkToEnd, startPdkRoom } from '../lib/pdk-driver';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { redisRaw, redisReplyText } from '../lib/redis';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-5);
const PDK_ENABLED = 'game.paodekuai.enabled';
const PDK_GOLD = 'game.paodekuai.goldRoomEnabled';
const PDK_LEVELS = 'game.levels.paodekuai';
const PDK_RAKE = 'game.paodekuai.rakePercent';
const BASE_SCORE = 15;
const ENTRY_FEE_PERCENT = 10;
const EXPECTED_FEE = 1;
const PRE_CHARGE = 1_000_000;
const WINDOW_FROM = Date.now() - 60 * 60_000;
const WINDOW_TO = Date.now() + 10 * 60_000;

const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

interface CommandResult {
  code: number;
  out: string;
}

function exec(service: string, ...cmd: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, ...cmd], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

function mysqlQuery(sql: string): CommandResult {
  return exec(
    'mysql',
    'sh',
    '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`,
  );
}

function mysqlExec(sql: string): void {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 写入失败（exit ${r.code}）：${tailOut(r.out)}`);
}

function mysqlTextOrNull(sql: string): string | null {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  const lines = r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('mysql:'));
  return lines.length === 0 ? null : lines[lines.length - 1]!;
}

function mysqlText(sql: string): string {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  const lines = r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('mysql:'));
  const last = lines[lines.length - 1];
  if (last === undefined) throw new ConformanceError(`mysql 文本读数为空（原文尾部：${tailOut(r.out)}）`);
  return last;
}

function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

function safeJson(line: string): Record<string, any> | null {
  const at = line.indexOf('{');
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function ndjson(service: string, sinceSeconds: number): Array<Record<string, any>> {
  return composeLogs(service, sinceSeconds)
    .split('\n')
    .map(safeJson)
    .filter((r): r is Record<string, any> => r !== null);
}

async function pollUntil<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (ok(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

function scanRedisKeys(pattern: string): string[] {
  const reply = redisRaw(['--scan', '--pattern', pattern]);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli --scan 失败：${redisReplyText(reply) || '（无输出）'}`);
  }
  return reply.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function replyText(reply: { stdout: string; stderr: string }): string {
  return (reply.stdout.trim() || reply.stderr.trim()).trim();
}

function purgeGoldQueues(): { deletedQueues: number; deletedMetas: number } {
  let deletedQueues = 0;
  for (const key of scanRedisKeys('match:queue:gold:*')) {
    redisRaw(['DEL', key]);
    deletedQueues += 1;
  }
  let deletedMetas = 0;
  for (const key of scanRedisKeys('match:meta:*')) {
    if (replyText(redisRaw(['HGET', key, 'mode'])) === 'gold') {
      redisRaw(['DEL', key]);
      deletedMetas += 1;
    }
  }
  return { deletedQueues, deletedMetas };
}

interface ConfigEntry {
  value: unknown;
  version: number;
}

async function adminConfig(admin: string): Promise<{ config: Record<string, ConfigEntry>; version: number }> {
  const res = await adminGetConfig<{ config: Record<string, ConfigEntry>; version: number }>(admin);
  if (res.body?.code !== ErrCode.OK || res.body.data === undefined) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

async function putConfigAndWaitEffect(
  admin: string,
  key: string,
  value: unknown,
  why: string,
): Promise<void> {
  const before = await adminConfig(admin);
  const expected = Math.max(before.version, (before.config[key]?.version ?? 0) + 1);
  const countWithVersion = (version: number): number =>
    ndjson('room-service', 900).filter(
      (r) => String(r.msg).includes('config snapshot applied') && new RegExp(`version=${version}\\b`).test(String(r.msg)),
    ).length;
  const baseline = countWithVersion(expected);
  const put = await adminPutConfig(key, value, admin);
  if (put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`${why}：PUT ${key} 失败 HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  const refreshed = await pollUntil(() => countWithVersion(expected), (n) => n > baseline, 30_000);
  if (!refreshed.ok) {
    throw new ConformanceError(`${why}：room-service 30s 内未应用配置快照 version=${expected}`);
  }
}

async function precharge(admin: string, user: HarnessUser): Promise<void> {
  const res = await postJson(
    '/api/admin/wallet/adjust',
    {
      userId: user.id,
      delta: PRE_CHARGE,
      reason: `slice31 ${RUN_TAG} precharge`,
      actionId: `s31:${RUN_TAG}:pre:${user.id}`,
    },
    admin,
  );
  if (res.status !== 200 || res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`预充失败 HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
}

interface OpsRow {
  actionId: string;
  source: string;
  gameType: string | null;
  ownerId: string;
  delta: number;
  refId: string | null;
}

async function opsQuery(
  admin: string,
  params: Record<string, string>,
): Promise<OpsRow[]> {
  const p = new URLSearchParams({ ...params, limit: '100' });
  const res = await getJson<{ rows: OpsRow[] }>(`/api/admin/wallet/ops?${p.toString()}`, admin);
  if (res.body?.code !== ErrCode.OK || !Array.isArray(res.body.data?.rows)) {
    throw new ConformanceError(`GET ops 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.rows;
}

async function findOp(
  admin: string,
  params: Record<string, string>,
  match: (row: OpsRow) => boolean,
): Promise<OpsRow | null> {
  const hit = await pollUntil(
    async () => (await opsQuery(admin, params)).find(match) ?? null,
    (row) => row !== null,
    20_000,
  );
  return hit.last;
}

interface SummaryRow {
  k: string;
  gameType: string | null;
  delta: number;
  flowCount: number;
}

interface SummaryData {
  rows: SummaryRow[];
  totals: { delta: number; flowCount: number };
  entryFeeSkips: { cnt: number; players: number; amount: number };
  entryFeeSkipsByGame: Array<{ gameType: string; cnt: number; players: number; amount: number }>;
}

async function summary(admin: string, groupBy: 'source' | 'day' = 'source'): Promise<SummaryData> {
  const res = await getJson<SummaryData>(
    `/api/admin/wallet/summary?groupBy=${groupBy}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    admin,
  );
  if (res.body?.code !== ErrCode.OK || res.body.data === undefined) {
    throw new ConformanceError(`GET summary 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

function summaryRow(data: SummaryData, k: string, gameType: string): SummaryRow {
  return data.rows.find((r) => r.k === k && r.gameType === gameType) ?? {
    k,
    gameType,
    delta: 0,
    flowCount: 0,
  };
}

function playerList(admin: string, q: string, activity?: string): Promise<any> {
  const p = new URLSearchParams({ q, page: '1', pageSize: '20' });
  if (activity !== undefined) p.set('activity', activity);
  return getJson<any>(`/api/admin/players?${p.toString()}`, admin).then((res) => {
    if (res.body?.code !== ErrCode.OK) {
      throw new ConformanceError(`GET players 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  });
}

function rpcApply(req: CurrencyApplyRequest): Promise<RpcResult<CurrencyApplyData>> {
  return rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, req, 8_000);
}

export async function runSlice31(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const admin = await adminLogin();
  const before = await adminConfig(admin);
  const original = {
    enabled: before.config[PDK_ENABLED]?.value,
    gold: before.config[PDK_GOLD]?.value,
    levels: before.config[PDK_LEVELS]?.value,
    rake: before.config[PDK_RAKE]?.value,
  };
  const originalLevels = Array.isArray(original.levels) ? (original.levels as Array<Record<string, unknown>>) : [];
  const levels = originalLevels.some((l) => Number(l.baseScore) === BASE_SCORE)
    ? originalLevels.map((l) =>
        Number(l.baseScore) === BASE_SCORE ? { ...l, entryFeePercent: ENTRY_FEE_PERCENT } : l,
      )
    : [...originalLevels, { name: '休闲场', baseScore: BASE_SCORE, entryFeePercent: ENTRY_FEE_PERCENT }];

  const users: HarnessUser[] = [];
  let room: Awaited<ReturnType<typeof startPdkRoom>> | null = null;
  let primaryError: unknown = null;
  try {
    step('⓪ 队列清源 + 配置开启 + 3 人预充 + 汇总基线');
    const purged = purgeGoldQueues();
    info(`清源：gold 队列键 ${purged.deletedQueues} 个、gold meta ${purged.deletedMetas} 个`);
    checks.eq(scanRedisKeys('match:queue:gold:*').length, 0, '⓪ 清源后 gold 队列零键');

    await putConfigAndWaitEffect(admin, PDK_ENABLED, true, '开启跑得快');
    await putConfigAndWaitEffect(admin, PDK_GOLD, true, '开启跑得快金币场');
    await putConfigAndWaitEffect(admin, PDK_LEVELS, levels, '设置 15 档台费 10%');
    await putConfigAndWaitEffect(admin, PDK_RAKE, 0, '设置跑得快抽水 0');

    for (const [i, index] of [140, 141, 142].entries()) {
      const user = await registerUser(index);
      await precharge(admin, user);
      users.push(user);
      checks.ok(`⓪ 用户 ${i} 预充 ${PRE_CHARGE} 完成（${user.id}）`);
    }

    const baseline = await summary(admin);
    const baselineEntryFee = summaryRow(baseline, 'entry_fee', 'paodekuai');
    const baselineSettle = summaryRow(baseline, 'game_settle', 'paodekuai');
    const baselineSkipPdk =
      baseline.entryFeeSkipsByGame.find((r) => r.gameType === 'paodekuai')?.cnt ?? 0;
    checks.ok(`⓪ 汇总基线快照（rows=${baseline.rows.length}）`);

    step('① 3 人金币匹配/开局（gameType/playerCount）');
    room = await startPdkRoom('S31', { mode: 'gold', baseScore: BASE_SCORE, users });
    checks.eq(room.matched[0]?.gameType, 'paodekuai', '① room.matched gameType=paodekuai');
    checks.eq(room.matched[0]?.playerCount, 3, '① room.matched playerCount=3');
    checks.eq(room.deals[0]?.hand.length, 16, '① 开局手牌 16 张');

    step('② 台费：3 笔 entry_fee（-1、gameType=pdk、DB action_id）');
    for (const user of users) {
      const row = await findOp(
        admin,
        { source: 'entry_fee', gameType: 'paodekuai', ownerId: user.id },
        (r) => r.refId === room!.roomCode,
      );
      checks.that(row !== null, `② ${user.id} 台费 op 落库（20s 轮询）`);
      checks.eq(row?.delta, -EXPECTED_FEE, `② ${user.id} 台费 delta=-${EXPECTED_FEE}`);
      checks.eq(row?.gameType, 'paodekuai', `② ${user.id} 台费 gameType=pdk`);
      checks.eq(
        mysqlText(
          `SELECT CONCAT(source,':',game_type) FROM currency_ops WHERE action_id='entryfee:${room!.roomCode}:${user.id}'`,
        ),
        'entry_fee:paodekuai',
        `② ${user.id} DB action_id 行 source:game_type`,
      );
    }

    step('③ 确定性 game_settle 注入（RUN_TAG 唯一）');
    const injectedAction = `s31:${RUN_TAG}:inject`;
    const injectedRef = `s31:${RUN_TAG}:injected`;
    const injected = await rpcApply({
      actionId: injectedAction,
      source: 'game_settle',
      gameType: 'paodekuai',
      refId: injectedRef,
      entries: [
        { ownerId: users[0]!.id, delta: 10 },
        { ownerId: users[1]!.id, delta: -10 },
      ],
    });
    checks.that(injected.ok, `③ 注入 apply ok（${JSON.stringify(injected)}）`);
    if (!injected.ok) throw new ConformanceError(`③ 注入失败：${JSON.stringify(injected)}`);
    checks.eq(injected.data.replayed, false, '③ 注入首发 replayed=false');
    checks.eq(
      mysqlText(`SELECT game_type FROM currency_ops WHERE action_id='${injectedAction}'`),
      'paodekuai',
      '③ 注入 op DB game_type=paodekuai',
    );
    const injectedOp = await findOp(
      admin,
      { source: 'game_settle', gameType: 'paodekuai', ownerId: users[0]!.id },
      (r) => r.actionId === injectedAction,
    );
    checks.that(injectedOp !== null, '③ 管理面按 gameType 过滤可查到注入 op');

    step('④ 真实对局结算：非零 scoreChanges 逐座核对 / 全零无 op');
    const outcome = await playPdkToEnd(room, 'slice-31');
    checks.eq(outcome.settlement?.gameType, 'paodekuai', '④ settlement.gameType=paodekuai');
    checks.that(
      typeof outcome.settlementVersion === 'number',
      `④ 结算信封 version 可读（实测 ${String(outcome.settlementVersion)}）`,
    );
    const version = outcome.settlementVersion;
    const scoreChanges = (outcome.settlement?.scoreChanges ?? []) as Array<{ seat: number; delta: number }>;
    const nonZero = scoreChanges.filter((c) => Number(c.delta) !== 0);
    if (version === null) {
      checks.that(false, '④ settlementVersion 缺失，无法拼 settle actionId');
    } else {
      const settleAction = `settle:${room.roomCode}:${version}`;
      if (nonZero.length === 0) {
        checks.eq(
          mysqlText(`SELECT COUNT(*) FROM currency_ops WHERE action_id='${settleAction}'`),
          '0',
          '④ 全零结算不调 apply（无 op）',
        );
      } else {
        await pollUntil(
          () => mysqlTextOrNull(`SELECT CONCAT(game_type,':',source) FROM currency_ops WHERE action_id='${settleAction}'`),
          (v) => v === 'paodekuai:game_settle',
          30_000,
        ).then((hit) => {
          checks.that(hit.ok, `④ DB settle op game_type=paodekuai（实测 ${hit.last}）`);
        });
        for (const change of scoreChanges) {
          const client = room.bySeat.get(change.seat);
          const user = client?.user;
          if (user === undefined) continue;
          if (Number(change.delta) === 0) {
            const rows = await opsQuery(admin, { source: 'game_settle', ownerId: user.id });
            checks.that(
              !rows.some((r) => r.refId === `${room!.roomCode}:${version}`),
              `④ seat ${change.seat} delta=0 不得有该 op 的分录`,
            );
          } else {
            const row = await findOp(
              admin,
              { source: 'game_settle', gameType: 'paodekuai', ownerId: user.id },
              (r) => r.refId === `${room!.roomCode}:${version}`,
            );
            checks.eq(row?.delta, Number(change.delta), `④ seat ${change.seat} 结算 delta 与向量一致`);
          }
        }
      }
    }

    step('⑤ 汇总相对基线增量（entry_fee/game_settle pdk）');
    const after = await pollUntil(
      () => summary(admin),
      (s) => {
        const fee = summaryRow(s, 'entry_fee', 'paodekuai');
        const settle = summaryRow(s, 'game_settle', 'paodekuai');
        return fee.flowCount >= baselineEntryFee.flowCount + 3 && settle.flowCount >= baselineSettle.flowCount + 2;
      },
      30_000,
    );
    const afterData = after.last;
    checks.that(after.ok, `⑤ 汇总增量满足（entry_fee +3 / game_settle +2 注入）—— 实际 ${JSON.stringify(afterData.rows)}`);
    const feeAfter = summaryRow(afterData, 'entry_fee', 'paodekuai');
    checks.eq(
      feeAfter.flowCount - baselineEntryFee.flowCount,
      3,
      '⑤ entry_fee pdk flowCount 增量=3',
    );
    checks.eq(feeAfter.delta - baselineEntryFee.delta, -3 * EXPECTED_FEE, '⑤ entry_fee pdk delta 增量=-3');
    const settleAfter = summaryRow(afterData, 'game_settle', 'paodekuai');
    checks.that(
      settleAfter.flowCount >= baselineSettle.flowCount + 2,
      `⑤ game_settle pdk flowCount ≥ 基线+2（实测 ${settleAfter.flowCount}）`,
    );
    checks.eq(
      afterData.totals.delta,
      afterData.rows.reduce((acc, r) => acc + r.delta, 0),
      '⑤ totals.delta = 各行之和',
    );
    checks.eq(
      afterData.totals.flowCount,
      afterData.rows.reduce((acc, r) => acc + r.flowCount, 0),
      '⑤ totals.flowCount = 各行之和',
    );

    step('⑥ 免单 RPC：gameType=pdk 落库 + summary byGame');
    const skipRoom = `S31${RUN_TAG}`.slice(0, 16);
    const skipRes = await rpcCall<CurrencyEntryFeeSkipData>(
      CURRENCY_RPC,
      RPC_PATTERNS.currencyEntryFeeSkip,
      {
        roomCode: skipRoom,
        ownerId: users[0]!.id,
        seat: 0,
        baseScore: BASE_SCORE,
        feeAmount: 1,
        reason: 'insufficient_funds',
        gameType: 'paodekuai',
      },
      8_000,
    );
    checks.that(skipRes.ok, `⑥ skip RPC ok（${JSON.stringify(skipRes)}）`);
    checks.eq(
      mysqlText(
        `SELECT game_type FROM currency_entry_fee_skips WHERE room_code='${skipRoom}' AND owner_id='${users[0]!.id}'`,
      ),
      'paodekuai',
      '⑥ skips 行 game_type=paodekuai',
    );
    const skipAfter = await pollUntil(
      () => summary(admin),
      (s) =>
        (s.entryFeeSkipsByGame.find((r) => r.gameType === 'paodekuai')?.cnt ?? 0) >= baselineSkipPdk + 1,
      20_000,
    );
    checks.that(skipAfter.ok, '⑥ summary entryFeeSkipsByGame pdk 计数 +1');

    step('⑦ 记录：game_type + 逐座 score_change/won + 对外 DTO');
    const recordHit = await pollUntil(
      async () => {
        const page = await getJson<any>('/api/records/mine?gameType=paodekuai', users[0]!.accessToken);
        if (page.body?.code !== ErrCode.OK) {
          throw new ConformanceError(`⑦ 战绩查询失败：${JSON.stringify(page.body)}`);
        }
        return (page.body?.data?.items ?? []).find((r: any) => r.roomCode === room!.roomCode) ?? null;
      },
      (r) => r !== null,
      30_000,
    );
    const record = recordHit.last;
    checks.that(record !== null, `⑦ 战绩列表命中本局（${room!.roomCode}）`);
    if (record !== null) {
      checks.eq(record.mode, 'gold', '⑦ 记录 mode=gold');
      checks.eq(record.playerCount, 3, '⑦ 记录 playerCount=3');
      const expectedBySeat = new Map(scoreChanges.map((c) => [Number(c.seat), Number(c.delta)]));
      const winnerSeat = Number(outcome.finishedPayload?.winnerSeats?.[0]);
      for (const p of record.players as Array<{ seat: number; scoreChange: number; won: boolean }>) {
        checks.eq(p.scoreChange, expectedBySeat.get(Number(p.seat)) ?? 0, `⑦ seat ${p.seat} scoreChange`);
        checks.eq(p.won, Number(p.seat) === winnerSeat, `⑦ seat ${p.seat} won`);
      }
      checks.eq(
        mysqlText(`SELECT game_type FROM game_records_pdk WHERE room_code='${room!.roomCode}'`),
        'paodekuai',
        '⑦ game_records_pdk.game_type=paodekuai',
      );
      const dbPlayers = mysqlText(
        `SELECT GROUP_CONCAT(CONCAT(seat,':',score_change,':',won) ORDER BY seat) FROM game_record_players_pdk WHERE record_id=(SELECT id FROM game_records_pdk WHERE room_code='${room!.roomCode}')`,
      );
      const expectedPlayers = scoreChanges
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((c) => `${c.seat}:${c.delta}:${c.seat === winnerSeat ? 1 : 0}`)
        .join(',');
      checks.eq(dbPlayers, expectedPlayers, '⑦ DB 玩家行逐座 score_change/won');
    }

    step('⑧ 管理玩家列表/最近对局/lastActive/active7');
    const mySeat = [...room.bySeat.entries()].find(([, c]) => c.user.id === users[0]!.id)?.[0];
    checks.that(mySeat !== undefined, '⑧ 找到用户 0 的座位');
    const recordEndedAt = Number(record?.endedAt);
    const gamesRes = await pollUntil(
      async () => {
        const res = await getJson<{ items: any[] }>(
          `/api/admin/players/${encodeURIComponent(users[0]!.id)}/games?limit=50`,
          admin,
        );
        if (res.body?.code !== ErrCode.OK) {
          throw new ConformanceError(`⑧ GET players games 失败：${JSON.stringify(res.body)}`);
        }
        return res.body.data?.items ?? [];
      },
      (items) => items.some((g) => g.gameType === 'paodekuai' && g.recordId === record?.recordId),
      30_000,
    );
    checks.that(gamesRes.ok, '⑧ 玩家最近对局含本局且 gameType=pdk');
    const list = await pollUntil(
      () => playerList(admin, users[0]!.phone),
      (d) => d.items?.[0]?.lastActiveAt >= recordEndedAt,
      20_000,
    );
    checks.that(list.ok, '⑧ 玩家列表 lastActiveAt ≥ 本局 endedAt（20s 轮询）');
    const item = list.last.items?.[0];
    checks.eq(item?.games, 1, '⑧ 新用户 games=1（精确）');
    checks.eq(
      item?.wins,
      mySeat === Number(outcome.finishedPayload?.winnerSeats?.[0]) ? 1 : 0,
      '⑧ wins 按座位精确',
    );
    checks.eq(item?.lastActiveAt, recordEndedAt, '⑧ lastActiveAt = 本局 endedAt（无设备/DDZ）');
    const active7 = await playerList(admin, users[0]!.phone, 'active7');
    checks.that(
      Array.isArray(active7.items) && active7.items.some((r: any) => r.userId === users[0]!.id),
      '⑧ activity=active7 命中该用户',
    );

    step('⑨ lastActive 三分支：device-only / DDZ-only / PDK');
    // device-only：直插 user_devices，last_seen_at 为已知 UTC 字面量
    const deviceUser = await registerUser(143);
    const deviceAt = '2026-10-25 00:00:00.000';
    mysqlExec(
      `INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at) VALUES ('${deviceUser.id}', 's31-${RUN_TAG}-dev', '${deviceAt}', '${deviceAt}')`,
    );
    const deviceList = await playerList(admin, deviceUser.phone);
    checks.eq(
      deviceList.items?.[0]?.lastActiveAt,
      Date.parse('2026-10-25T00:00:00.000Z'),
      '⑨ device-only lastActiveAt = TIMESTAMPDIFF(last_seen_at)',
    );

    // DDZ-only：直插一条最小合法记录
    const ddzUser = await registerUser(144);
    const ddzRoom = `S31D${RUN_TAG}`.slice(0, 16);
    const ddzAt = '2026-10-25 00:00:01.000';
    mysqlExec(
      `INSERT INTO game_records (room_code, game_version, mode, base_score, winner, landlord_seat, multiplier, spring, landlord_score_change, farmer_score_change, bottom_cards, started_at, ended_at, created_at) VALUES ('${ddzRoom}', 1, 'random', 15, 'landlord', 0, 1, 'none', 30, -15, '010203', '${ddzAt}', '${ddzAt}', '${ddzAt}')`,
    );
    const ddzId = mysqlText(`SELECT id FROM game_records WHERE room_code='${ddzRoom}' AND game_version=1`);
    mysqlExec(
      `INSERT INTO game_record_players (record_id, seat, user_id, is_robot, robot_id, nickname, role, score_change, won, hand, money_delta, ended_at) VALUES (${ddzId}, 0, '${ddzUser.id}', 0, NULL, 's31', 'landlord', 30, 1, '0102030405060708090a0b0c0d0e0f1011', NULL, '${ddzAt}')`,
    );
    const ddzList = await playerList(admin, ddzUser.phone);
    checks.eq(
      ddzList.items?.[0]?.lastActiveAt,
      Date.parse('2026-10-25T00:00:01.000Z'),
      '⑨ DDZ-only lastActiveAt = TIMESTAMPDIFF(ended_at)',
    );

    info('slice-31 全部断言完成');
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      if (room !== null) {
        for (const c of room.clients) c.close();
      }
      purgeGoldQueues();
      await adminPutConfig(PDK_ENABLED, original.enabled ?? false, admin);
      await adminPutConfig(PDK_GOLD, original.gold ?? false, admin);
      await adminPutConfig(PDK_LEVELS, original.levels ?? [], admin);
      await adminPutConfig(PDK_RAKE, original.rake ?? 0, admin);
      info('slice-31 配置已还原、队列已清源');
    } catch (restoreErr) {
      if (primaryError === null) throw restoreErr;
      info(`slice-31 还原失败（保留原始错误）：${String(restoreErr)}`);
    }
  }
  return { passed: checks.passed };
}
