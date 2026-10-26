/**
 * conformance 用例：**记录片 T9** —— 真栈判据（规格 §3 的 C4 / C6 / C7 / C8 / C9 +
 * T6 审查建议的**同毫秒 keyset 跨界**；C3/C5 **引用既有**：slice-10 的「结算载荷恰 9 键」
 * 与结算链路、game-service 的窗口守卫单测 —— 本片**不重复造**）。
 *
 * ─── 编排顺序与理由（为什么是这个序）────────────────────────────────────────
 *  ① C4 幂等（rpcCall 直投宿主 3101 ×2 + `compose exec mysql` 查行；负对照 = 改
 *     `gameVersion` ⇒ 新行）—— SQL 写入面最便宜的一环，先跑；
 *  ② C6 只本人（双账号）+ C7 响应白名单（**递归恰好键集 + 判别力正/负自证**）——
 *     记录行都用 ① 的直投手法**造**（不依赖真打一局：判据对象是查询面的出站形状）；
 *  ③ 同毫秒 keyset 跨界（T6-review-🟡3 的路由）：专号两行 `ended_at` 逐毫秒相同 ⇒
 *     游标必须翻到 `id DESC` 决胜（缺 `id < ?` 的 SQL 形态会在第 2 页**静默跳过**）；
 *  ④ C8 保留期：管理面 PUT `record.cleanupIntervalMs` 短值（+ GET 确认）重起 user-service ⇒
 *     管理面改 `record.retentionDays=1` ⇒ 缓存刷新（日志读数）⇒ mysql backdate 一行旧记录 ⇒
 *     清理轮删旧行、界内行留 ⇒ 改回 365 ⇒ 再 backdate 一行 ⇒ ≥2 轮后**仍在**；
 *  ⑤ C9 失败姿态：停 user-service ⇒ **打一局**（账号先注册好 —— 停机窗口里注册面不可用）
 *     ⇒ 结算广播照常到三家 + room 出现 NDJSON error 行 + 库里**没有**该局行 ⇒ 起回
 *     ⇒ 再打一局 ⇒ `Record written` + 库行齐 + `/api/records/mine` **字段逐项对局内事实**
 *     （本轮同时充当规格 §3 的收口读数；也是 `ClientProxy` 重连性的活体证据）。
 *
 * ─── 手法先例（逐条对应，刻意与既有切片同形）────────────────────────────────
 *  - `compose()` / `exec()` / `tailOut()`：照 `slice-14-config-center.ts`（spawnSync 手型、
 *    `exec` 必带 `-T`、失败断言带输出尾部）；注入重起 = 该片 C17a 的 `up -d --no-deps`
 *    + `--force-recreate`（本片起注入走配置面、compose 无 env 变化 ⇒ 保重建必须件——W5-M1）；
 *    停/起 = 该片 C16 的 `stop`/`start`（`slice-14:432/442` 真先例）。
 *  - `composeLogs()` / `safeJson()`：照 `slice-12-manual-join.ts`（NDJSON 日志断言）。
 *  - mysql 查询：`mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"`（容器内两变量
 *    由 compose 提供）；⚠️ SQL 里**只许**单引号字符串字面量与数字 —— 整段进 sh 的双引号
 *    参数，禁 `$` / 反引号 / 双引号（会改变 sh 语义）。
 *
 * ─── 判据纪律 ────────────────────────────────────────────────────────────
 *  - 🔴 **C7 不得用 `assertNoLeak`**：它的 `LEAK_KEYS` 含 `players` —— 而本契约里
 *    `players` 是**合法**字段。REST 面**没有**既有出站闸（`game.settlement` 那条闸不覆盖
 *    `/api/records/mine`）⇒ 本片的递归恰好键集是**唯一机械防线** ⇒ 正/负对照自证**必做**：
 *    同一个 `recordViolations()` 谓词先跑真响应（必须零违例）、再跑四份合成注入
 *    （顶层多一键 / player 多一键 / Card 多一键 / player 少一键 —— 每一个都必须报违例，
 *    否则谓词失效而「真响应零违例」是空话）。
 *  - **不 import `@fight-the-landlord/shared`**（R168：不拿被测实现当裁判）；`protocol`
 *    只用于**造合法输入**（codec 编码）与契约常量（`RPC_PATTERNS`/`ErrCode`）——
 *    判定对象永远是**真后端的回答**（库行 / 响应 DTO / 容器日志）。
 *  - `Checks.eq` 用 `!==` ⇒ 数组/对象一律 `JSON.stringify` 成字符串比较（R176）。
 *
 * ─── 本片对真栈的副作用与复原 ────────────────────────────────────────────
 *  注入 `record.cleanupIntervalMs=3000`（管理面 PUT + 重起 user-service；收官 PUT 回知基线
 *  3600000）、`record.retentionDays` 临时改 1 后再改回 365、user-service 停/起 ——
 *  收官统一复原（`finally` 兜底），一条也不许泄漏给 `--list` 下的后续切片（本片在
 *  CASES 末尾，当前无后续，纪律照旧）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  encodeCards,
  encodeHand,
  type Card,
  type RecordWriteRequest,
  type DdzSettlementResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, fieldSetViolations, info, sleep, step } from '../lib/assert';
import { adminGetConfig, adminLogin, adminPutConfig, getJson, registerUser, type HarnessUser } from '../lib/http';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { redisLines } from '../lib/redis';
import { HarnessClient } from '../lib/client';
import {
  MATCH_BASE_SCORE,
  MATCH_TIMEOUT_MS,
  MAX_TRICKS,
  currentView,
  extremeByRank,
  firstView,
  passCurrent,
  playAndSync,
  playBiddingToPlaying,
  playFinalHand,
  sendThrottled,
  type FreshRoom,
  type PlayViewWire,
} from '../lib/ddz-driver';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度 ⇒ 与 `lib/redis.ts` 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** user-service 的宿主直连面（compose override 发布 3001；healthcheck 也打这里）。 */
const USER_SERVICE_URL = process.env.USER_URL ?? 'http://localhost:3001';

/**
 * `record.write` 的 TCP 监听（宿主直连 = compose override 的 `3101:3101`；
 * `lib/rpc.ts` 只登记了 game/robot 两处 RPC 端点 —— 本文件自带一个，**不碰**既有 lib）。
 */
const USER_RPC: RpcEndpoint = {
  host: process.env.USER_RPC_HOST ?? 'localhost',
  port: Number(process.env.USER_RPC_PORT ?? 3101),
};

/**
 * C8 的注入值（本片 ⚙️9 换源：管理面 PUT `record.cleanupIntervalMs` —— 旧 env 注入面已退役；
 * 3s 一轮，足够在秒级窗口里观测 ≥2 轮）。数值型：`parseIntervalMs` 拒字符串。
 */
const CLEANUP_INTERVAL_INJECT = 3000;
/** C8 的还原**知基线值**（= stack 种子 = 代码缺省 1h；还原不写「现值」）。 */
const CLEANUP_INTERVAL_RESTORE = 3_600_000;
/** 保留期键名（规格 §2.4 第 10 键，写死）。 */
const RETENTION_KEY = 'record.retentionDays';
/** 短保留期（1 天）与复原值（种子 365）。 */
const RETENTION_SHORT = 1;
const RETENTION_RESTORE = 365;

/**
 * 本片专用房间号。⚠️ 带 **per-run 后缀**：`--list` 全序与本机「先单跑、后全序」是**同一栈**
 * 里跑两遍 —— 固定房号会让 C4 的「首发 ⇒ written=true」在第二遍变成幂等命中（假红）。
 * 后缀取自 `Date.now()` 的 base36 末 4 位（字符集 ⊆ [0-9A-Z]，进 SQL 字面量与房号形状都安全；
 * 同一毫秒跑不了两遍，跨遍必不同）。
 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);
const ROOM_C4 = `C4${RUN_TAG}`;
const ROOM_A = `C6A${RUN_TAG}`;
const ROOM_B = `C6B${RUN_TAG}`;
const ROOM_MS1 = `M1${RUN_TAG}`;
const ROOM_MS2 = `M2${RUN_TAG}`;
const ROOM_C8_OLD = `C8O${RUN_TAG}`;
const ROOM_C8_KEEP = `C8K${RUN_TAG}`;
const ROOM_C8_SAFE = `C8S${RUN_TAG}`;

// ────────────────────────────────────────────────────────────────────────────
// docker 助手（形态先例见文件头）
// ────────────────────────────────────────────────────────────────────────────

/** `compose()` 的返回：退出码 + stdout/stderr 合流（失败断言里带上尾部，结论才看得见原因）。 */
interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose …`（照 `slice-14-config-center.ts` 的 spawnSync 手型，逐字同参）。 */
function compose(extraEnv: Record<string, string>, ...args: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 日志超 spawnSync 默认上限（1MiB）会以 ENOBUFS 失败 ⇒ status=null ⇒ 看起来像「compose 退 1」的误导性红。
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** `docker compose exec -T <service> …`（`-T` 不能省：无 TTY 环境下缺它会挂住）。 */
function exec(service: string, ...cmd: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, ...cmd], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 输出尾部 —— 失败断言里带上它（「跑挂 ≠ 判据红」：原因必须进结论）。 */
function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

/**
 * MySQL 查询（`-N` = 不带列名表头）。⚠️ SQL 只许单引号字面量与数字（见文件头）；
 * 表名/列名都是简单标识符，**不用反引号**（反引号进 sh 双引号内会被当命令替换）。
 */
function mysqlQuery(sql: string): CommandResult {
  return exec('mysql', 'sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "${sql}"`);
}

/** 查询返回**单个整数**（`COUNT(*)` 一类的读数）；任何形态异常**当场抛**（不让空串伪装成 0）。 */
function mysqlCount(sql: string): number {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  const numeric = r.out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s));
  const last = numeric[numeric.length - 1];
  if (last === undefined) {
    throw new ConformanceError(`mysql 读数不是整数（原文尾部：${tailOut(r.out)}）`);
  }
  return Number(last);
}

const recordsCount = (roomCode: string): number =>
  mysqlCount(`SELECT COUNT(*) FROM game_records WHERE room_code='${roomCode}'`);
const playersCount = (roomCode: string): number =>
  mysqlCount(
    `SELECT COUNT(*) FROM game_record_players p JOIN game_records r ON p.record_id=r.id WHERE r.room_code='${roomCode}'`,
  );
const recordIdOf = (roomCode: string): number =>
  mysqlCount(`SELECT id FROM game_records WHERE room_code='${roomCode}'`);
const playersCountByRecordId = (recordId: number): number =>
  mysqlCount(`SELECT COUNT(*) FROM game_record_players WHERE record_id=${recordId}`);

/** 把某房的两表行 backdate 到 2 天前（C8 的「旧记录」构造；两表各自成句）。 */
function backdateRoom(roomCode: string): CommandResult {
  const players = mysqlQuery(
    `UPDATE game_record_players SET ended_at=NOW(3) - INTERVAL 2 DAY WHERE record_id IN (SELECT id FROM game_records WHERE room_code='${roomCode}')`,
  );
  if (players.code !== 0) return players;
  return mysqlQuery(`UPDATE game_records SET ended_at=NOW(3) - INTERVAL 2 DAY WHERE room_code='${roomCode}'`);
}

/** 某服务最近的容器日志（照 `slice-12`；`--no-color` 必须有：ANSI 会让「找那一行」恒假）。 */
function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 一行日志里抽出 NDJSON 记录（前缀 `ftl-x | ` 与非 JSON 行一律返回 null；照 `slice-12`）。 */
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

/** 某服务近 `sinceSeconds` 秒的全部 NDJSON 记录。 */
function ndjson(service: string, sinceSeconds: number): Array<Record<string, any>> {
  return composeLogs(service, sinceSeconds)
    .split('\n')
    .map(safeJson)
    .filter((r): r is Record<string, any> => r !== null);
}

/**
 * user-service 的「配置快照已应用」日志里，值为 `retention` 的行数（C8 的**缓存刷新读数**）。
 * ⚠️ 用**计数**而不是「有没有」：容器启动时的首拉也会打这一行（值=365），只凭 exists
 * 会把「启动首拉」误读成「我们的 PUT 生效了」。调用方一律与**PUT 前的基线计数**比较。
 */
function snapshotAppliedCount(retention: number): number {
  return ndjson('user-service', 600).filter((r) => {
    const msg = String(r.msg);
    return msg.includes('config snapshot applied') && new RegExp(`retentionDays=${retention}\\b`).test(msg);
  }).length;
}

/** user-service 的清理轮日志里 `retentionDays=retention` 的轮数（同上的计数口径）。 */
function cleanupRoundCount(retention: number): number {
  return ndjson('user-service', 600).filter((r) => {
    const msg = String(r.msg);
    return msg.startsWith('records cleanup done') && new RegExp(`retentionDays=${retention}\\b`).test(msg);
  }).length;
}

/** 轮询直至谓词成立（有上界）。返回最后一次读数 —— **由调用方断言**（超时 = 判据不成立）。 */
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

/** 等 user-service 的宿主 HTTP 面就绪（`main.ts`：先 `startAllMicroservices()`（3101）再 `listen(3001)` ⇒ 3001 通了 3101 必在听）。 */
async function waitUserServiceHealthy(timeoutMs = 60_000): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const res = await fetch(`${USER_SERVICE_URL}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 200) return { ok: true, last: 'HTTP 200' };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 管理面间隔注入（本片 ⚙️9 换源：统一形态的 PUT 腿 —— PUT + GET 确认，取代旧 env 通道）
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/admin/config` 的单键值（PUT 后的 **GET 确认** 读口）。 */
async function adminGetConfigValue(admin: string, key: string): Promise<unknown> {
  const res = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data?.config?.[key]?.value;
}

/**
 * 规格 ⚙️9 统一形态的 **PUT 腿**：`PUT key=ms` ⇒ **GET 确认 = ms**（防 PUT 静默失败）。
 * 任一环不合 ⇒ **抛**（失败响亮；`why` 入消息）。其后的「重建 → 观测」由调用方承接。
 * ⚠️ 还原调用一律传**知基线值**（`CLEANUP_INTERVAL_RESTORE`），不写「现值」。
 */
async function putInterval(admin: string, key: string, ms: number, why: string): Promise<void> {
  const put = await adminPutConfig(key, ms, admin);
  if (put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`${why}：PUT ${key}=${ms} 失败：HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  const read = await adminGetConfigValue(admin, key);
  if (read !== ms) {
    throw new ConformanceError(`${why}：PUT 后 GET 确认不符 —— ${key}=${JSON.stringify(read)}，期望 ${ms}`);
  }
  info(`${why}：PUT ${key}=${ms} ⇒ GET 确认一致`);
}

// ────────────────────────────────────────────────────────────────────────────
// 记录造数（rpcCall 直投 3101 —— C4/C6 的同一手法；只用于**造输入**，不用作判定）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 从 codec 合法集 `{3–14,17,20,30} × {0–4}`（75 组合）里取 `count` 张 —— 固定遍历序 ⇒
 * 同一 offset 恒定得到同一批牌（判据可复读）。**不**模拟真牌堆（不是本判据的对象）。
 */
function sampleCards(offset: number, count: number): Card[] {
  const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];
  const pool: Card[] = [];
  for (const r of ranks) for (let s = 0; s < 5; s += 1) pool.push({ r, s });
  const out: Card[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[(offset + i) % pool.length]!);
  return out;
}

interface CraftSeat {
  seat: number;
  userId: string | null;
  isRobot: boolean;
  robotId: string | null;
}

/** 造一份合法的 `RecordWriteRequest`（校验面与 `record.rpc.controller.ts` 的 `invalidReason` 口径一致）。 */
function craftRecord(opt: {
  roomCode: string;
  gameVersion?: number;
  endedAt: number;
  startedAt?: number;
  seats: CraftSeat[];
  landlordSeat?: number;
  winner?: 'landlord' | 'farmer';
}): RecordWriteRequest {
  const baseScore = MATCH_BASE_SCORE;
  const multiplier = 2;
  const landlordSeat = opt.landlordSeat ?? 0;
  const winner = opt.winner ?? 'landlord';
  const result: DdzSettlementResult = {
    roomCode: opt.roomCode,
    baseScore,
    winner,
    landlordSeat,
    farmerSeats: [0, 1, 2].filter((s) => s !== landlordSeat),
    multiplier,
    spring: 'none',
    landlordScoreChange: winner === 'landlord' ? baseScore * multiplier * 2 : -baseScore * multiplier * 2,
    farmerScoreChange: winner === 'landlord' ? -baseScore * multiplier : baseScore * multiplier,
  };
  return {
    roomCode: opt.roomCode,
    gameVersion: opt.gameVersion ?? 1,
    mode: 'random',
    baseScore,
    result,
    seats: opt.seats.map((seat, i) => ({ ...seat, hand: encodeHand(sampleCards(i * 17, 17)) })),
    bottomCards: encodeCards(sampleCards(51, 3)),
    startedAt: opt.startedAt ?? opt.endedAt - 600_000,
    endedAt: opt.endedAt,
  };
}

/** rpcCall 直投 3101 并断言信封 `ok=true` + `data.written`（不等 ⇒ 抛，带上原始读数）。 */
async function writeAndExpect(
  req: RecordWriteRequest,
  expectedWritten: boolean,
  what: string,
): Promise<void> {
  const res = await rpcCall<{ written: boolean }>(USER_RPC, RPC_PATTERNS.recordWrite, req, 5_000);
  if (!res.ok) {
    throw new ConformanceError(`${what}：RPC 返回 {ok:false}（期望 ok=true）—— 实际 ${JSON.stringify(res)}`);
  }
  if (res.data.written !== expectedWritten) {
    throw new ConformanceError(
      `${what}：data.written 期望 ${JSON.stringify(expectedWritten)}，实际 ${JSON.stringify(res.data)}`,
    );
  }
}

/** 三座各一的机器人座位（C4/C8 的造数用 —— 无真人 ⇒ 昵称恒 NULL，这正是快照语义的一部分）。 */
const ROBOT_SEATS: CraftSeat[] = [
  { seat: 0, userId: null, isRobot: true, robotId: 'bot-slice15-0' },
  { seat: 1, userId: null, isRobot: true, robotId: 'bot-slice15-1' },
  { seat: 2, userId: null, isRobot: true, robotId: 'bot-slice15-2' },
];

/** 单真人 + 两机器人（C6 的 A/B 各一份）—— 首座放真人 ⇒ 昵称快照非空可判。 */
function humanPlusRobots(userId: string): CraftSeat[] {
  return [
    { seat: 0, userId, isRobot: false, robotId: null },
    { seat: 1, userId: null, isRobot: true, robotId: 'bot-slice15-h1' },
    { seat: 2, userId: null, isRobot: true, robotId: 'bot-slice15-h2' },
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// C7：递归恰好键集（谓词 + 判别力自证共用**同一实现** —— R115）
// ────────────────────────────────────────────────────────────────────────────

/** 规格 §2.3 逐字：MyRecord 12 键 / player 6 键 / Card 2 键（② 金币场 T12 同步：11→12，+moneyDelta）。 */
const MYRECORD_KEYS = [
  'roomCode', 'mode', 'endedAt', 'baseScore', 'winner', 'landlordSeat', 'multiplier',
  'spring', 'mySeat', 'moneyDelta', 'bottomCards', 'players',
];
const PLAYER_KEYS = ['seat', 'nickname', 'role', 'scoreChange', 'won', 'hand'];
const CARD_KEYS = ['r', 's'];

function exactKeyViolations(value: unknown, expected: readonly string[], where: string, out: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.push(`${where}: 不是对象（${Array.isArray(value) ? '是数组' : typeof value}）`);
    return;
  }
  const actual = Object.keys(value as Record<string, unknown>);
  const violations = fieldSetViolations(actual, expected);
  if (violations.length > 0) {
    out.push(`${where}: ${violations.join('、')}（实际键 ${JSON.stringify([...actual].sort())}）`);
  }
}

function cardViolations(card: unknown, where: string, out: string[]): void {
  exactKeyViolations(card, CARD_KEYS, where, out);
  if (typeof card === 'object' && card !== null && !Array.isArray(card)) {
    const c = card as Record<string, unknown>;
    if (typeof c.r !== 'number' || typeof c.s !== 'number') out.push(`${where}: r/s 必须都是数字`);
  }
}

/**
 * 递归恰好键集谓词：返回违例清单（空 = 完全符合契约）。层级口径（规格 §2.3）：
 * MyRecord 12 键（排序无关）/ players 恰 3（含每家的 6 键 + hand 恰 17 张）/ bottomCards 恰 3 /
 * 每张牌恰 `{r, s}`；**递归覆盖** ⇒ `userId`/`robotId`/`isRobot`/`startedAt` 这类内部字段
 * 只要出现在**任意深度**都会被报出。⚠️ ② 金币场 T12 起 `moneyDelta` 是**契约内**的第 12 键
 * （NULL 也是值），不再属于本名单。
 */
function recordViolations(value: unknown): string[] {
  const out: string[] = [];
  exactKeyViolations(value, MYRECORD_KEYS, 'MyRecord', out);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  const rec = value as Record<string, any>;
  if (!Array.isArray(rec.bottomCards) || rec.bottomCards.length !== 3) {
    out.push(`bottomCards: 必须恰 3 张（实际 ${JSON.stringify(rec.bottomCards)?.slice(0, 60)}）`);
  } else {
    rec.bottomCards.forEach((c: unknown, i: number) => cardViolations(c, `bottomCards[${i}]`, out));
  }
  if (!Array.isArray(rec.players) || rec.players.length !== 3) {
    out.push(`players: 必须恰 3 条（实际 ${Array.isArray(rec.players) ? rec.players.length : typeof rec.players}）`);
    return out;
  }
  rec.players.forEach((p: unknown, i: number) => {
    exactKeyViolations(p, PLAYER_KEYS, `players[${i}]`, out);
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return;
    const player = p as Record<string, any>;
    if (!Array.isArray(player.hand) || player.hand.length !== 17) {
      out.push(`players[${i}].hand: 必须恰 17 张（实际 ${Array.isArray(player.hand) ? player.hand.length : typeof player.hand}）`);
    } else {
      player.hand.forEach((c: unknown, j: number) => cardViolations(c, `players[${i}].hand[${j}]`, out));
    }
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 牌局驱动（C9 用）
// ────────────────────────────────────────────────────────────────────────────

/**
 * `startFreshRoom` 的「外部账号」变体：账号**先注册好**再进本函数。
 *
 * ⚠️ 为什么不能用 `startFreshRoom`：它内部 `registerUser ×3`，而 C9 的**局 1**要在
 * user-service **停机窗口**里打 —— 注册面（经网关 → user-service）已不可用。
 * 其余机械动作（connect → match → matched → join → deal）与它逐字同形（R190① 的精神：
 * 组装只留一处；这里是「同形复制 + 账号外置」，别无第二份变体）。
 */
async function startRoomWithUsers(labelPrefix: string, users: HarnessUser[]): Promise<FreshRoom> {
  const clients: HarnessClient[] = [];
  try {
    for (const [i, user] of users.entries()) {
      clients.push(await HarnessClient.connect(`${labelPrefix}${i}`, user));
    }
    for (const client of clients) {
      const ack = await sendThrottled(client, 'room.match', { mode: 'random', baseScore: MATCH_BASE_SCORE }, 0);
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(`${client.label} room.match code=${ack.code}（期望 0）`);
      }
    }
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', MATCH_TIMEOUT_MS)));
    const roomCode = matched[0]!.payload.roomCode as string;
    const bySeat = new Map<number, HarnessClient>();
    for (const [i, client] of clients.entries()) {
      const seat = matched[i]!.payload.seat as number;
      bySeat.set(seat, client);
      const ack = await sendThrottled(client, 'room.join', { roomCode }, 0);
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(`${client.label} room.join code=${ack.code}（期望 0）`);
      }
    }
    const dealMsgs = await Promise.all(clients.map((c) => c.waitFor('game.deal', MATCH_TIMEOUT_MS)));
    return { roomCode, clients, bySeat, deals: dealMsgs.map((m) => m.payload as PlayViewWire) };
  } catch (err) {
    // R156：失败路径也必须收干净，否则 socket 吊住事件循环 ⇒ run.js 永不退出。
    for (const client of clients) client.close();
    throw err;
  }
}

/** 一局打完的读数（C9 两局共用）。 */
interface FinishedGame {
  room: FreshRoom;
  settlement: DdzSettlementResult;
  /** 进 playing 那版视图的底牌（真源观察点之一；终局视图的 bottomCards 是否保留不在本片判内）。 */
  bottomCards: Card[];
  landlordSeat: number;
}

/**
 * 打一局到分出胜负 + 等三家收到结算（机械动作逐字照 slice-10 场景 A：地主每墩首出最大单张、
 * 两农民全程过牌 ⇒ `farmerPlays === 0` ⇒ 春天；这里**不**重复结算字段断言 —— 那是 slice-10 的面）。
 */
async function playOneGame(label: string, users: HarnessUser[], checks: Checks): Promise<FinishedGame> {
  const room = await startRoomWithUsers(label, users);
  await playBiddingToPlaying(room, checks);
  const playingView = firstView(room);
  const landlordSeat = playingView.landlordSeat;
  if (landlordSeat === null) throw new ConformanceError(`${label}：进入 playing 后 landlordSeat 仍为 null`);
  const bottomCards = playingView.bottomCards;
  if (bottomCards === null || bottomCards.length !== 3) {
    throw new ConformanceError(`${label}：playing 视图的 bottomCards 不是恰 3 张（${JSON.stringify(bottomCards)}）`);
  }
  const landlord = room.bySeat.get(landlordSeat);
  if (!landlord) throw new ConformanceError(`${label}：landlordSeat=${landlordSeat} 没有对应客户端`);

  for (let i = 0; i < MAX_TRICKS; i += 1) {
    const view = currentView(landlord);
    if (view.hand.length === 0) break;
    const card = extremeByRank(view.hand, 'max');
    if (view.hand.length === 1) {
      const winner = await playFinalHand(landlord, [card], checks, `${label} 地主终局手`);
      checks.eq(winner, 'landlord', `${label} 地主出完牌 ⇒ game.finished{landlord}`);
      break;
    }
    await playAndSync(room, landlord, [card], checks, `${label} 地主第 ${i + 1} 墩首出最大单张`);
    for (let k = 0; k < 2; k += 1) {
      await passCurrent(room, checks, `${label} 第 ${i + 1} 墩农民过牌`);
    }
  }

  const settlements = await Promise.all(
    room.clients.map((c) => c.waitFor('game.settlement', 15_000)),
  );
  for (const [i, m] of settlements.entries()) {
    checks.eq(m.payload.roomCode, room.roomCode, `${label}：第 ${i + 1} 家收到 game.settlement（房号一致）`);
  }
  return { room, settlement: settlements[0]!.payload as DdzSettlementResult, bottomCards, landlordSeat };
}

// ────────────────────────────────────────────────────────────────────────────
// 主体
// ────────────────────────────────────────────────────────────────────────────

export async function runSlice15(): Promise<Checks> {
  const checks = new Checks();
  const rooms: FreshRoom[] = [];
  // 起手自证：管理面口令与栈一致（不一致时整片从第一行就响亮失败，而不是退化成几十条误导性红）。
  const admin = await adminLogin();

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ① C4：幂等（rpcCall 直投 3101 ×2 + `compose exec mysql` 查行）
    // ══════════════════════════════════════════════════════════════════════
    step('C4：同一 payload 直投 3101 ×2 ⇒ written true/false + 库里恰 1 组行（1 记录 + 3 玩家）');
    const c4EndedAt = Date.now() - 1_800_000; // 固定 30 分钟前（C8 的 1 天保留期内 ⇒ 不会被清理轮误删）
    const c4Req = craftRecord({ roomCode: ROOM_C4, endedAt: c4EndedAt, seats: ROBOT_SEATS });
    await writeAndExpect(c4Req, true, 'C4① 首发（version 1）');
    checks.ok('C4① 首发 ⇒ data.written=true（库唯一键未命中 ⇒ 真写）');
    await writeAndExpect(c4Req, false, 'C4② 逐字同 payload 再投（version 1）');
    checks.ok('C4② 重复投递 ⇒ data.written=false（幂等命中，非错误）');
    const c4Records = recordsCount(ROOM_C4);
    checks.eq(c4Records, 1, `C4③ game_records 恰 1 行（room_code=${ROOM_C4}）`);
    checks.eq(playersCount(ROOM_C4), 3, 'C4③ game_record_players 恰 3 行（同 record_id JOIN）');

    // 负对照（规格 §3 C4 的判别力）：改 payload 的**幂等键一维**（gameVersion）⇒ 必须是**新行**。
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_C4, gameVersion: 2, endedAt: c4EndedAt, seats: ROBOT_SEATS }),
      true,
      'C4④ 负对照：同房号、gameVersion=2',
    );
    checks.eq(recordsCount(ROOM_C4), 2, 'C4④ 改 gameVersion ⇒ 新行（records=2 —— 幂等键确实是 (room_code, game_version)）');
    checks.eq(playersCount(ROOM_C4), 6, 'C4④ 新记录的 3 行玩家一并落库（players=6）');

    // ══════════════════════════════════════════════════════════════════════
    // ② C6 只本人（双账号）+ C7 响应白名单（递归恰好键集 + 正/负自证）
    // ══════════════════════════════════════════════════════════════════════
    step('C6：双账号 A/B（各自一局记录，房号互不相同）⇒ A 的响应绝不含 B 的房号（负对照）');
    const userA = await registerUser(30);
    const userB = await registerUser(31);
    const c6EndedAt = Date.now() - 1_700_000;
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_A, endedAt: c6EndedAt, seats: humanPlusRobots(userA.id) }),
      true,
      'C6 造数：A 的记录（seat0=真人 A，其余机器人）',
    );
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_B, endedAt: c6EndedAt, seats: humanPlusRobots(userB.id) }),
      true,
      'C6 造数：B 的记录（seat0=真人 B，其余机器人）',
    );

    interface RecordsPageWire {
      items: Array<Record<string, any>>;
      nextCursor: string | null;
    }
    const aPage = await getJson<RecordsPageWire>('/api/records/mine', userA.accessToken);
    const bPage = await getJson<RecordsPageWire>('/api/records/mine', userB.accessToken);
    checks.eq(aPage.body?.code, ErrCode.OK, 'C6 A 查询 code 0');
    checks.eq(bPage.body?.code, ErrCode.OK, 'C6 B 查询 code 0');
    const aText = JSON.stringify(aPage.body?.data ?? null);
    const bText = JSON.stringify(bPage.body?.data ?? null);
    checks.eq(aPage.body?.data?.items?.length, 1, 'C6 A 恰 1 条记录（正对照非空测：响应必须有内容）');
    checks.eq(bPage.body?.data?.items?.length, 1, 'C6 B 恰 1 条记录');
    checks.that(aText.includes(ROOM_A), `C6 正：A 的响应含 A 自己的房号 ${ROOM_A}`);
    checks.that(
      !aText.includes(ROOM_B),
      `C6 负：A 的响应**绝不含** B 的房号 ${ROOM_B}（实际前 200 字：${aText.slice(0, 200)}）`,
    );
    checks.that(bText.includes(ROOM_B), `C6 正：B 的响应含 B 自己的房号 ${ROOM_B}`);
    checks.that(
      !bText.includes(ROOM_A),
      `C6 负：B 的响应**绝不含** A 的房号 ${ROOM_A}（实际前 200 字：${bText.slice(0, 200)}）`,
    );
    const aItem = aPage.body!.data!.items[0]!;
    checks.eq(aItem.mySeat, 0, 'C6 A 的记录 mySeat=0（自 JOIN 命中「我」那一行，不是猜的）');
    checks.eq(aItem.players?.find?.((p: any) => p.seat === 0)?.nickname, userA.nickname,
      'C6 昵称快照 = A 注册时的昵称（真人座）');
    checks.that(
      (aItem.players ?? []).filter((p: any) => p.seat !== 0).every((p: any) => p.nickname === null),
      `C6 造数不带 nickname ⇒ 机器人快照 NULL —— 实际 ${JSON.stringify((aItem.players ?? []).map((p: any) => p.nickname))}`,
    );

    step('C7：真响应的**递归恰好键集**（MyRecord 11 / player 6 / Card 2；数组 3/17/3）+ 判别力正/负自证');
    // 主体：真响应必须零违例（A、B 两份都过 —— 不止一条样本）。
    for (const [who, page] of [['A', aPage], ['B', bPage]] as const) {
      const items = page.body?.data?.items ?? [];
      const violations = items.flatMap((it, i) => recordViolations(it).map((v) => `items[${i}] ${v}`));
      checks.that(
        violations.length === 0,
        `C7 ${who} 的响应递归恰好键集 ⇒ 零违例` +
          `${violations.length > 0 ? `（实际：${violations.join(' | ')}）` : '（REST 无既有出站闸 ⇒ 本谓词是唯一机械防线）'}`,
      );
    }
    checks.eq(aItem.players?.length, 3, 'C7 players 恰 3 条');
    checks.that(
      (aItem.players ?? []).every((p: any) => Array.isArray(p.hand) && p.hand.length === 17),
      'C7 每家 hand 恰 17 张',
    );
    checks.eq(aItem.bottomCards?.length, 3, 'C7 bottomCards 恰 3 张');

    // 自证（R115）：同一个谓词先跑四份**合成注入** —— 每一个都必须报违例，否则「真响应零违例」是空话。
    const injectExtra = (label: string, mutate: (copy: Record<string, any>) => void): void => {
      const copy = structuredClone(aItem) as Record<string, any>;
      mutate(copy);
      const violations = recordViolations(copy);
      checks.that(
        violations.length > 0,
        `C7 自证 负：${label} ⇒ 谓词必须报违例` +
          `${violations.length > 0 ? `（命中：${violations[0]}）` : '—— 实际零违例（谓词失去判别力！）'}`,
      );
    };
    injectExtra('顶层多一键 startedAt', (c) => { c.startedAt = 1700000000000; });
    injectExtra('player 多一键 userId', (c) => { c.players[0].userId = 'leak-user-id'; });
    injectExtra('Card 多一键 suit', (c) => { c.bottomCards[0].suit = '♠'; });
    injectExtra('player 少一键 won', (c) => { delete c.players[0].won; });

    // ══════════════════════════════════════════════════════════════════════
    // ③ 同毫秒 keyset 跨界（T6-review-🟡3 路由：游标必须翻到 id DESC 决胜）
    // ══════════════════════════════════════════════════════════════════════
    step('同毫秒 keyset：同账号两行 ended_at 逐毫秒相同 ⇒ 第 1 页取 id 大者，游标翻页取 id 小者（缺 `id < ?` 会静默跳过）');
    const userS = await registerUser(32);
    const sameMs = Date.now() - 3_600_000; // 1 小时前（C8 的 1 天保留期内）
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_MS1, endedAt: sameMs, seats: humanPlusRobots(userS.id) }),
      true,
      '同毫秒 造数 1：先写（player 行 id 较小）',
    );
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_MS2, endedAt: sameMs, seats: humanPlusRobots(userS.id) }),
      true,
      '同毫秒 造数 2：后写（player 行 id 较大 ⇒ 排序第 1 位）',
    );
    const ms1 = await getJson<RecordsPageWire>('/api/records/mine?limit=1', userS.accessToken);
    checks.eq(ms1.body?.code, ErrCode.OK, '同毫秒 第 1 页 code 0');
    checks.eq(ms1.body?.data?.items?.[0]?.roomCode, ROOM_MS2,
      '同毫秒 第 1 页 = 后写那行（ended_at DESC 平手 ⇒ id DESC 决胜）');
    const msCursor = ms1.body?.data?.nextCursor ?? null;
    checks.that(typeof msCursor === 'string' && msCursor.length > 0,
      `同毫秒 第 1 页必须给出 nextCursor（还有第 2 页）—— 实际 ${JSON.stringify(msCursor)}`);
    // 游标经网关**原样回传**（本仓首次 GET query 透传；按 R75 纪律编码 —— 客户端侧就是 URL 编码）。
    const ms2 = await getJson<RecordsPageWire>(
      `/api/records/mine?cursor=${encodeURIComponent(msCursor!)}&limit=1`,
      userS.accessToken,
    );
    checks.eq(ms2.body?.code, ErrCode.OK, '同毫秒 第 2 页 code 0');
    checks.eq(ms2.body?.data?.items?.[0]?.roomCode, ROOM_MS1,
      '同毫秒 第 2 页 = 先写那行（同 ended_at、id 更小 ⇒ 只有 `id < ?` 这条或项能取到它）');
    checks.eq(ms2.body?.data?.nextCursor, null, '同毫秒 第 2 页是终页（nextCursor=null）');

    // ══════════════════════════════════════════════════════════════════════
    // ④ C8：保留期即生效（注入短清理间隔 + 管理面改键 + backdate ⇒ 删旧留新 ⇒ 改回 ⇒ 不再删）
    // ══════════════════════════════════════════════════════════════════════
    step(`C8①：PUT record.cleanupIntervalMs=${CLEANUP_INTERVAL_INJECT}（管理面注入）+ 重建 user-service（清理轮节奏变快）`);
    await putInterval(admin, 'record.cleanupIntervalMs', CLEANUP_INTERVAL_INJECT, 'C8① 注入');
    // ⚠️ `--force-recreate` 不可省（slice-14 C16 同款截断）：`up -d` 对**未变**容器是 no-op，
    //    而「已排定的一轮不撤、其后按现读值排期」（本片 ⚙️7）⇒ 不真重启就只在**旧间隔**后
    //    才有下一轮清理（1h ⇒ C8③ 的 90s 观测窗必红）。
    const c8Up = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
    checks.eq(c8Up.code, 0, `C8① 注入重建 user-service —— 输出尾部：${tailOut(c8Up.out)}`);
    const c8Healthy = await waitUserServiceHealthy();
    checks.that(c8Healthy.ok, `C8① 重建后 user-service 就绪（3001 通 ⇒ 3101 已在听）—— ${c8Healthy.last}`);

    step('C8②：管理面改 record.retentionDays=1 ⇒ 缓存刷新（「config snapshot applied … retentionDays=1」日志读数）');
    const c8RowsEndedAt = Date.now() - 30_000; // 两条新造数都用「现在附近」的 ended_at（1 天保留期内的界内行）
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_C8_OLD, endedAt: Date.now(), seats: ROBOT_SEATS }),
      true,
      `C8② 造数：待删行（${ROOM_C8_OLD}，随后 backdate 到 2 天前）`,
    );
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_C8_KEEP, endedAt: c8RowsEndedAt, seats: ROBOT_SEATS }),
      true,
      `C8② 造数：界内行（${ROOM_C8_KEEP}，ended_at 保持在保留期内）`,
    );
    const c8KeepId = recordIdOf(ROOM_C8_KEEP);
    const c8PutShort = await adminPutConfig(RETENTION_KEY, RETENTION_SHORT, admin);
    checks.eq(c8PutShort.body?.code, ErrCode.OK, `C8② PUT ${RETENTION_KEY}=${RETENTION_SHORT} ⇒ code 0`);
    // ⚠️ 只证**推送路径**（30s 窗 < 安全网 60s —— 与 slice-14 C1 同口径）：超时 ⇒ 判据红。
    const c8Refresh = await pollUntil(
      () => snapshotAppliedCount(RETENTION_SHORT),
      (n) => n > 0,
      30_000,
    );
    checks.that(
      c8Refresh.ok,
      `C8② ≤30s 缓存刷新到 retentionDays=${RETENTION_SHORT}（推送路径生效；日志行数 ${c8Refresh.last}）`,
    );

    step('C8③：mysql backdate 待删行 ⇒ 清理轮删旧行 + 界内行**留**（两表各自核对）');
    const c8OldId = recordIdOf(ROOM_C8_OLD);
    checks.eq(playersCountByRecordId(c8OldId), 3, 'C8③ 前置：待删行确有 3 行玩家（否则「删掉了」是空测）');
    const c8Backdate = backdateRoom(ROOM_C8_OLD);
    checks.eq(c8Backdate.code, 0, `C8③ backdate（UPDATE 两表 ended_at=2 天前）—— 输出尾部：${tailOut(c8Backdate.out)}`);
    // 首轮 ≤40s（等快照 ≤10s〔首排动作的有界等待 —— 本片 ⚙️9 等待预算〕+ 30s 首轮常数）+ 其后每 3s
    // ⇒ 90s 上界足够；超时 = 清理链没工作（判据红，不是「等」的错）。
    const c8Deleted = await pollUntil(
      () => playersCountByRecordId(c8OldId) + recordsCount(ROOM_C8_OLD),
      (n) => n === 0,
      90_000,
      2_000,
    );
    checks.that(
      c8Deleted.ok,
      `C8③ 清理轮把旧行删净（players+records 合计 0）—— 最后一次读数 ${c8Deleted.last}`,
    );
    checks.eq(recordsCount(ROOM_C8_KEEP), 1, `C8③ 界内行 ${ROOM_C8_KEEP} 的记录行**留**（未满 1 天保留期）`);
    checks.eq(playersCountByRecordId(c8KeepId), 3, `C8③ 界内行 ${ROOM_C8_KEEP} 的 3 行玩家**留**`);

    step(`C8④：改回 ${RETENTION_KEY}=${RETENTION_RESTORE} ⇒ ≥2 轮后 backdate 的行**不再删**`);
    const c8Snap365Before = snapshotAppliedCount(RETENTION_RESTORE);
    const c8PutBack = await adminPutConfig(RETENTION_KEY, RETENTION_RESTORE, admin);
    checks.eq(c8PutBack.body?.code, ErrCode.OK, `C8④ PUT ${RETENTION_KEY}=${RETENTION_RESTORE} ⇒ code 0`);
    const c8BackTo365 = await pollUntil(
      () => snapshotAppliedCount(RETENTION_RESTORE),
      (n) => n > c8Snap365Before,
      30_000,
    );
    checks.that(
      c8BackTo365.ok,
      `C8④ 缓存刷新回 365（新行数 ${c8BackTo365.last}，基线 ${c8Snap365Before}）`,
    );
    await writeAndExpect(
      craftRecord({ roomCode: ROOM_C8_SAFE, endedAt: Date.now(), seats: ROBOT_SEATS }),
      true,
      `C8④ 造数：恢复后 backdate 的行（${ROOM_C8_SAFE}）`,
    );
    const c8SafeId = recordIdOf(ROOM_C8_SAFE);
    const c8Backdate2 = backdateRoom(ROOM_C8_SAFE);
    checks.eq(c8Backdate2.code, 0, `C8④ backdate ${ROOM_C8_SAFE} 到 2 天前 —— 输出尾部：${tailOut(c8Backdate2.out)}`);
    const c8RoundsBefore = cleanupRoundCount(RETENTION_RESTORE);
    const c8Rounds = await pollUntil(
      () => cleanupRoundCount(RETENTION_RESTORE),
      (n) => n >= c8RoundsBefore + 2,
      30_000,
    );
    checks.that(
      c8Rounds.ok,
      `C8④ 恢复后 ≥2 轮清理已跑（retentionDays=${RETENTION_RESTORE} 的轮数 ${c8RoundsBefore} ⇒ ${c8Rounds.last}；` +
        `反空测：没有它们「没删」无从说起）`,
    );
    checks.eq(recordsCount(ROOM_C8_SAFE), 1, 'C8④ 2 天前的行在 365 天保留期内 ⇒ **不被删**');
    checks.eq(playersCountByRecordId(c8SafeId), 3, 'C8④ 其 3 行玩家同样留下');

    // ══════════════════════════════════════════════════════════════════════
    // ⑤ C9：失败姿态（停 user-service ⇒ 打一局 ⇒ 广播照常 + room error 行 + 无库行 ⇒ 起回 ⇒ 再打一局可写）
    // ══════════════════════════════════════════════════════════════════════
    step('C9 前置：六名玩家**先注册好**（停机窗口里注册面不可用）+ 停 user-service');
    const game1Users = [await registerUser(33), await registerUser(34), await registerUser(35)];
    const game2Users = [await registerUser(36), await registerUser(37), await registerUser(38)];
    const c9Stop = compose({}, 'stop', 'user-service');
    checks.eq(c9Stop.code, 0, 'C9 前置：stop user-service');

    step('C9①：user-service 停着**打一局** ⇒ 三家照常收到结算（记录失败不得伤及广播）');
    const game1 = await playOneGame('C9局1', game1Users, checks);
    rooms.push(game1.room);
    info(`C9① 局 1 房号 ${game1.room.roomCode}（结算已到三家 ⇒ 广播与记录链已解耦）`);

    step('C9②：room-service 出现 NDJSON error 行「Record write failed for room …」 + 库里**没有**该局行');
    const c9FailPoll = await pollUntil(
      () =>
        ndjson('room-service', 300).filter((r) =>
          String(r.msg).includes(`Record write failed for room ${game1.room.roomCode}`),
        ),
      (lines) => lines.length > 0,
      30_000,
    );
    checks.that(
      c9FailPoll.ok,
      `C9② 「Record write failed for room ${game1.room.roomCode}」出现在 room-service 日志（30s 内）`,
    );
    checks.eq(c9FailPoll.last[0]?.level, 'error', 'C9② 该行是 error 级（响亮不静默）');
    checks.that(
      String(c9FailPoll.last[0]?.msg).includes('queued for retry (record:outbox)'),
      `C9② 该行含 queued for retry (record:outbox)（C1 写前入箱）—— 实际 ${String(c9FailPoll.last[0]?.msg)}`,
    );
    checks.eq(recordsCount(game1.room.roomCode), 0, 'C9② 库中**没有**局 1 的记录行（写失败 ≠ 静默半写）');
    // R155：换房前先 close() 上一房的客户端并静置 —— §5.4 的**每 IP 并发 WS 上限 5**，
    // 局 1 的三个连接不收掉，局 2 的握手会撞上限（表面症状是「连不上」，根因在配额）。
    for (const client of game1.room.clients) client.close();
    await sleep(400);

    step('C9③：start user-service ⇒ 就绪后再打一局 ⇒ 「Record written」+ 库行齐 + 我的记录**字段逐项对局内事实**');
    const c9Start = compose({}, 'start', 'user-service');
    checks.eq(c9Start.code, 0, 'C9③ start user-service');
    const c9Healthy = await waitUserServiceHealthy();
    checks.that(c9Healthy.ok, `C9③ user-service 就绪 —— ${c9Healthy.last}`);
    const game2 = await playOneGame('C9局2', game2Users, checks);
    rooms.push(game2.room);
    const room2 = game2.room.roomCode;
    info(`C9③ 局 2 房号 ${room2}（user-service 已起回 ⇒ 本条同时是 ClientProxy 重连性的活体证据）`);
    const c9WrittenPoll = await pollUntil(
      () =>
        ndjson('room-service', 300).filter((r) =>
          String(r.msg).includes(`Record written for room ${room2}`),
        ),
      (lines) => lines.length > 0,
      30_000,
    );
    checks.that(c9WrittenPoll.ok, `C9③ 「Record written for room ${room2}」出现在 room-service 日志（30s 内）`);
    checks.that(
      String(c9WrittenPoll.last[0]?.msg).includes('written=true'),
      `C9③ 日志行带 written=true（新写入，不是幂等命中）—— 实际 ${String(c9WrittenPoll.last[0]?.msg)}`,
    );
    checks.eq(recordsCount(room2), 1, 'C9③ 库中局 2 的记录恰 1 行');
    checks.eq(playersCount(room2), 3, 'C9③ 局 2 的玩家行恰 3 行');

    step('C9③b：user-service 恢复后 sweeper 自动补投局 1 ⇒ 记录落库 + 出箱（C1）');
    const c9Backfill = await pollUntil(
      () => recordsCount(game1.room.roomCode),
      (n) => n === 1,
      60_000,
    );
    checks.that(c9Backfill.ok, `C9③b 局 1 记录在 60s 内补投落库（实际 ${c9Backfill.last}）`);
    const c9PlayersBackfill = await pollUntil(
      () => playersCount(game1.room.roomCode),
      (n) => n === 3,
      30_000,
    );
    checks.that(
      c9PlayersBackfill.ok,
      `C9③b 局 1 玩家行 = 3（实际 ${c9PlayersBackfill.last}）`,
    );
    const c9OutboxPoll = await pollUntil(
      () =>
        redisLines(['HKEYS', 'record:outbox']).filter((f) =>
          f.startsWith(`${game1.room.roomCode}:`),
        ),
      (fields) => fields.length === 0,
      30_000,
    );
    checks.that(
      c9OutboxPoll.ok,
      `C9③b 局 1 已出箱（HKEYS 无 <room>: 前缀；实际 ${JSON.stringify(c9OutboxPoll.last)}）`,
    );
    checks.eq(recordsCount(game1.room.roomCode), 1, 'C9③b 补投后局 1 记录仍恰 1 行（幂等）');

    // ── 收口读数（规格 §3 末）：打一局 → /api/records/mine 字段逐项对局内事实 ──
    const viewer = game2.room.clients[0]!;
    const viewerSeat = game2.room.deals[0]!.seat;
    const g2Page = await getJson<RecordsPageWire>('/api/records/mine', viewer.user.accessToken);
    checks.eq(g2Page.body?.code, ErrCode.OK, 'C9③ 局 2 玩家查 /api/records/mine code 0');
    const g2Item = (g2Page.body?.data?.items ?? []).find((it) => it.roomCode === room2);
    checks.that(
      g2Item != null,
      `C9③ 局 2 的记录出现在「我的历史战绩」—— 实际 items=${JSON.stringify((g2Page.body?.data?.items ?? []).map((i) => i.roomCode))}`,
    );
    if (g2Item != null) {
      const settlement = game2.settlement;
      checks.eq(g2Item.mySeat, viewerSeat, 'C9③ mySeat = 查询者在局内的座位');
      checks.eq(g2Item.mode, 'random', 'C9③ mode 与房间一致（random）');
      checks.eq(g2Item.baseScore, settlement.baseScore, 'C9③ baseScore = 结算载荷的底分（撮合档 15）');
      checks.eq(g2Item.winner, settlement.winner, 'C9③ winner = 结算载荷的胜方');
      checks.eq(g2Item.landlordSeat, settlement.landlordSeat, 'C9③ landlordSeat = 结算载荷的地主位');
      checks.eq(g2Item.multiplier, settlement.multiplier, 'C9③ multiplier = 结算载荷的倍数');
      checks.eq(g2Item.spring, settlement.spring, 'C9③ spring = 结算载荷的春天判定');
      // 手牌：记录里的 hand 必须与**发牌视图**（当次排序后冻结副本）逐张一致（内容口径，排序无关）。
      const canon = (cards: Card[]): string => cards.map((c) => `${c.r}-${c.s}`).sort().join(',');
      const dealBySeat = new Map<number, Card[]>();
      for (const [i, deal] of game2.room.deals.entries()) {
        dealBySeat.set(deal.seat, game2.room.clients[i]!.last('game.deal').payload.hand as Card[]);
      }
      let handMismatch = '';
      for (const p of g2Item.players as Array<Record<string, any>>) {
        const dealt = dealBySeat.get(p.seat);
        if (!dealt || canon(p.hand) !== canon(dealt)) {
          handMismatch += `seat ${p.seat} 不一致；`;
        }
      }
      checks.that(handMismatch === '', `C9③ 三家手牌 = 发牌视图的手牌（内容逐张一致）${handMismatch !== '' ? `—— ${handMismatch}` : ''}`);
      checks.eq(
        canon(g2Item.bottomCards as Card[]),
        canon(game2.bottomCards),
        'C9③ bottomCards = playing 视图的底牌（内容逐张一致）',
      );
      let playerMismatch = '';
      for (const p of g2Item.players as Array<Record<string, any>>) {
        const isLandlord = p.seat === settlement.landlordSeat;
        const wantRole = isLandlord ? 'landlord' : 'farmer';
        const wantScore = isLandlord ? settlement.landlordScoreChange : settlement.farmerScoreChange;
        const wantWon = wantRole === settlement.winner;
        if (p.role !== wantRole) playerMismatch += `seat ${p.seat} role（${p.role}≠${wantRole}）；`;
        if (p.scoreChange !== wantScore) playerMismatch += `seat ${p.seat} scoreChange（${p.scoreChange}≠${wantScore}）；`;
        if (p.won !== wantWon) playerMismatch += `seat ${p.seat} won（${p.won}≠${wantWon}）；`;
      }
      checks.that(playerMismatch === '', `C9③ 身份/分数/胜负逐项对结算事实${playerMismatch !== '' ? `—— ${playerMismatch}` : ''}`);
      const nickBySeat = new Map<number, string>();
      for (const [i, deal] of game2.room.deals.entries()) {
        nickBySeat.set(deal.seat, game2.room.clients[i]!.user.nickname);
      }
      checks.that(
        (g2Item.players as Array<Record<string, any>>).every((p) => p.nickname === nickBySeat.get(p.seat)),
        `C9③ 昵称 = 三家注册昵称 —— 实际 ${JSON.stringify((g2Item.players as Array<Record<string, any>>).map((p) => p.nickname))}`,
      );
      // 收口读数顺带再过一遍递归键集（真响应样本多一份，成本为零）。
      checks.that(
        recordViolations(g2Item).length === 0,
        `C9③ 局 2 的记录同样通过递归恰好键集（零违例）${recordViolations(g2Item).length > 0 ? `—— 实际 ${recordViolations(g2Item).join(' | ')}` : ''}`,
      );
    }

    return checks;
  } finally {
    // ── 注入态与停机态**兜底复原**（成败皆然）─────────────────────────────────
    // 正常路径上 short 间隔已在 C8④ 后仍生效（有意为之），停机态在 C9③ 已起回 ——
    // 这里兜「前文抛错或被中断」：清理间隔 PUT 回知基线 3600000（= stack 种子 = 代码缺省，
    // 行为等价）、user-service 必须起着、保留期写回 365。整段吞错只 info：兜底复原**不许**
    // 顶掉原始结论。
    try {
      const admin2 = await adminLogin();
      await putInterval(admin2, 'record.cleanupIntervalMs', CLEANUP_INTERVAL_RESTORE, 'C8④ 还原基线');
      compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
      compose({}, 'start', 'user-service');
      await adminPutConfig(RETENTION_KEY, RETENTION_RESTORE, admin2);
    } catch (err) {
      info(`兜底复原失败（不影响原始结论；手动检查 user-service 的注入态与 ${RETENTION_KEY}）：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const room of rooms) {
      for (const client of room.clients) client.close();
    }
  }
}
