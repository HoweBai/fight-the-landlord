/**
 * slice-27 —— 挂机治理真栈组（C34 / C35 / C36 / C37 的载体；C11 / C12 / C13 / C14 / C18 的
 * 【conformance】半边）。
 *
 * 分组：
 *  ⓪ 注入四 env（1500/1000/400/3）**重建 game-service（本分支源码）** → 容器 healthy +
 *    HTTP 健康 → 容器内四值实读自证（注入落地）→ 3 真人起一局真实对局并推进到 playing
 *  A 加速两档：**一真人不动**（⛔ 不用补位机器人 —— 注入 normal=1500 与机器人 beginner
 *    思考 1500 打平会抖动；r1 重要 13）⇒ 首回合超时（读 ≈ normal=1500）→ 其下一回合
 *    deadline 差 ≈ accel=1000（读数 = `turnDeadlineAt - 收到时刻`；另报「回合开始 → 自动动作」
 *    的实际间隔作为同一判据的行为面）
 *  B 自动托管：**第三次超时后** `trustees[seat]=true`（快照实读；徽标是客户端 DOM、真栈不可达
 *    ⇒ 观测量 = trustees 数组）且**后续回合 ≤ trustee=400** 自动动作（两连回合各一格）
 *  C 复位（**normal 档 1500ms**）：自动托管的 `{on:false, via:'manual'}` ⇒ **count 清零**
 *    （redis 实读 `game:session:<code>`）、deadline 不动（非行动者）→ 其下一回合落 normal 档
 *    → 窗口内手动动作后 count 仍为 0（C4′ + C3 的行为面）
 *  D R8 三格 + C14 例外：R8① 行动者被置 trustee ⇒ deadline 收缩 min(剩余,400)（不延长）；
 *    R8② **手动开启的托管** manual off ⇒ **不重排不重算**（deadline 逐字不变，本轮仍按原短延时自动走一次）；
 *    自动托管 manual off 的 count 清零/accel 重排由 C 组与单测覆盖；
 *    R8③ 非行动者变更 ⇒ timer/deadline 均不动（快照差分）；C14 回桌（在局 `room.join`）按
 *    **count 基线**重排（count>0 ⇒ accel）；非 trustee 者反复 join 不动 timer（负对照）
 *  E 弃局→回桌：真实 `room.leave`（确认弃局）⇒ trustees 置位 → `room.join` 回桌拿回
 *    （解除 + 可继续动作）。⚠️ **弃局后 `game.reconnect` 必 13010**（slice-05 C5 已钉死）⇒
 *    只作负对照，⛔ 不写 reconnect 恢复路径
 *  F 回调复核（C18）：非行动者 toggle（纯 version 变化）后定时到点 ⇒ **仍自动动作**
 *  收尾（finally 兜底）：还原四 env + 重建回默认 + 健康探针 + **行为面复验**（下一回合
 *    读 ≈ 生产 normal=30000 —— slice-11 的「<5s ⇒ 非超时兜底」判别依赖默认 30s，C36）
 *
 * ─── 纪律块 ──────────────────────────────────────────────────────────────────
 *  - **注入 ⇒ 硬还原**：四 env 是**进程级**行为开关（game-service 常驻）——正常路径的还原
 *    断言失败即片内硬失败（不还原会让后续片全跑短回合）；finally 兜底只为异常路径尽力回默认
 *    （不得静默留下注入态）。还原判据 = 容器内四值**实读为空** + 健康 + 行为面 30s 实读。
 *  - 命名/清理：本片**无 actionId 面**（WS 消息 + compose 重建，均无锚）⇒ AID 纪律不适用；
 *    `RUN_TAG` 仅作日志标注。**不做 DB 硬清**：治理量活在 1h TTL 的对局会话里，房间一局制。
 *  - 读数一律**增量/差分维度**：deadline 读数用「服务端绝对时刻 − 本机收到时刻」；count 用
 *    redis 实读；trustees 用推送快照差分。⚠️ 本片**故意不用 `sendThrottled`**（R175 的 300ms
 *    节流会吃掉 400/1000ms 的治理窗口）—— 每客户端峰值 ≤4 条/5s，远低于服务端 20 条/5s 限额。
 *  - ⚠️ `spawnSync(docker …)` 会**冻结本进程事件循环**（slice-26/lib 同族事实）⇒ 本片把
 *    redis/compose 实读放在「刚完成一次转移」之后，且**不在 spawnSync 之后立即做时间读数**。
 *  - 驱动方 = `registerUser` 造 **3 个真人**（`startFreshRoom({humans:3})`，ddz-driver 先例），
 *    ⛔ 零补位机器人。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { GAME_URL } from '../lib/http';
import { redisRaw } from '../lib/redis';
import type { HarnessClient } from '../lib/client';
import {
  STEP_TIMEOUT_MS,
  extremeByRank,
  lastPlay,
  playBiddingToPlaying,
  smallestBeatingSingle,
  startFreshRoom,
  type FreshRoom,
  type PlayViewWire,
} from '../lib/ddz-driver';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15/17/18/25/26）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** 本 run 的日志标注（本片无 actionId 面——纪律块）。 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);

/** 四枚**仅测试** env（设计 §三；消费侧逐字 `Number(process.env.X) || 默认`）。 */
const ENV_NORMAL = 'GAME_TURN_TIMEOUT_MS';
const ENV_ACCEL = 'GAME_TURN_TIMEOUT_ACCEL_MS';
const ENV_TRUSTEE = 'GAME_TRUSTEE_DELAY_MS';
const ENV_AFTER = 'GAME_TRUSTEE_AFTER';

/** 注入值（设计 §三 / 规格 C34 逐字）：1500 / 1000 / 400 / 3。 */
const INJECT_VALUES = { normal: 1500, accel: 1000, trustee: 400, after: 3 } as const;
const INJECT_ENV: Record<string, string> = {
  [ENV_NORMAL]: String(INJECT_VALUES.normal),
  [ENV_ACCEL]: String(INJECT_VALUES.accel),
  [ENV_TRUSTEE]: String(INJECT_VALUES.trustee),
  [ENV_AFTER]: String(INJECT_VALUES.after),
};
/** 还原态：四值**显式空串**（compose `${VAR:-}` 未设即空串；`||` 吃空串 ⇒ 代码默认）。 */
const DEFAULT_ENV: Record<string, string> = {
  [ENV_NORMAL]: '',
  [ENV_ACCEL]: '',
  [ENV_TRUSTEE]: '',
  [ENV_AFTER]: '',
};

// ────────────────────────────────────────────────────────────────────────────
// docker 助手（形态先例：slice-14 :83-96 / slice-25 / slice-26）
// ────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose …`（`extraEnv` 覆盖宿主 env —— 注入/还原全走它）。 */
function compose(extraEnv: Record<string, string>, timeoutMs: number, ...args: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // ⚠️ 与 slice-14/25 同值（64MiB）：构建日志超默认 1MiB 会以 ENOBUFS 失败 ⇒ status null
    //    ⇒ 折成 code -1 ⇒ 看起来像「compose 退 1」的误导性红。
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 输出尾部 —— 失败断言里带上它（「跑挂 ≠ 判据红」：原因必须进结论）。 */
function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

/** 等容器 healthy（`docker inspect … {{.State.Health.Status}}`；同 slice-14/20）。 */
async function waitContainerHealthy(container: string, timeoutMs: number): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const r = spawnSync('docker', ['inspect', container, '--format', '{{.State.Health.Status}}'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20_000,
    });
    last = `${(r.stdout ?? '').trim() || (r.stderr ?? '').trim()}`;
    if (last === 'healthy') return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

/**
 * 容器内读一枚 env 的**原值**（空串 vs 未设分开：`printf '%s' "$VAR"` 对空串输出空行、
 * 对未设也输出空 —— compose `${VAR:-}` 恒把变量**设置**为空串，故两者在这里等价；
 * 判据是「非注入态必须为空/非 1500 等」）。
 */
function readContainerEnv(name: string): string {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'game-service', 'sh', '-c', `printf '%s' "$${name}"`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  if (r.status !== 0) return `<exec 失败 status=${r.status}: ${tailOut(`${r.stdout ?? ''}${r.stderr ?? ''}`, 1)}>`;
  return String(r.stdout ?? '');
}

/** game-service 直连健康探针（端口 3003；`/api/health` 豁免内部 token —— R87）。 */
async function gameHttpHealthy(): Promise<{ ok: boolean; last: string }> {
  try {
    const res = await fetch(`${GAME_URL}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return { ok: res.status === 200, last: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, last: err instanceof Error ? err.message : String(err) };
  }
}

/** 注入态重建（`--build` = **本分支源码**；`--no-deps` 防把 douzero 等拉进计划）。 */
function rebuildGameService(extraEnv: Record<string, string>): CommandResult {
  return compose(extraEnv, 300_000, 'up', '-d', '--no-deps', '--build', 'game-service');
}

/** 还原态重建（镜像已是本分支；只换 env ⇒ 不 `--build`）。 */
function restoreGameService(): CommandResult {
  return compose(DEFAULT_ENV, 180_000, 'up', '-d', '--no-deps', 'game-service');
}

// ────────────────────────────────────────────────────────────────────────────
// 视图 / 会话读数助手
// ────────────────────────────────────────────────────────────────────────────

/** 出站视图 + 治理数组（T3 起 `view.builder` 生产 `trustees` 三元）。 */
interface GovView extends PlayViewWire {
  trustees: [boolean, boolean, boolean];
}

interface TimedView {
  view: GovView;
  /** 本机**收到**该条推送的时刻（`HarnessClient.received[].at`）。 */
  at: number;
}

/** 该客户端最近一条 game.* 推送（含其收到时刻）。 */
function latest(client: HarnessClient): TimedView {
  for (let i = client.received.length - 1; i >= 0; i -= 1) {
    const r = client.received[i]!;
    if (r.type === 'game.state_update' || r.type === 'game.deal') {
      return { view: r.message.payload as GovView, at: r.at };
    }
  }
  throw new ConformanceError(`${client.label} 尚未收到任何 game.* 推送`);
}

/** 在 `received` 里按消息**同一实例**找收到时刻（`waitFor` 解析出的就是记录下来的那个对象）。 */
function receivedAt(client: HarnessClient, message: unknown): number | null {
  const rec = client.received.find((r) => r.message === message);
  return rec ? rec.at : null;
}

/** 等一条 `version > fromVersion` 的推送（返回视图 + 收到时刻）。 */
async function timedAdvance(
  client: HarnessClient,
  fromVersion: number,
  timeoutMs: number,
  what: string,
): Promise<TimedView> {
  let msg: any;
  try {
    msg = await client.waitFor(
      'game.state_update',
      timeoutMs,
      (m: any) => (m.payload as GovView).version > fromVersion,
    );
  } catch {
    throw new ConformanceError(
      `${what}：${timeoutMs}ms 内没有 version > ${fromVersion} 的 game.state_update（最新 v${latest(client).view.version}）`,
    );
  }
  return { view: msg.payload as GovView, at: receivedAt(client, msg) ?? Date.now() };
}

/** 等一条满足谓词的推送（同样要求 `version > fromVersion` —— 防 `waitFor` 命中历史消息）。 */
async function waitForView(
  client: HarnessClient,
  fromVersion: number,
  timeoutMs: number,
  predicate: (v: GovView) => boolean,
  what: string,
): Promise<TimedView> {
  let msg: any;
  try {
    msg = await client.waitFor('game.state_update', timeoutMs, (m: any) => {
      const v = m.payload as GovView;
      return v.version > fromVersion && predicate(v);
    });
  } catch {
    throw new ConformanceError(
      `${what}：${timeoutMs}ms 内没有满足谓词的 game.state_update（最新 v${latest(client).view.version}）`,
    );
  }
  return { view: msg.payload as GovView, at: receivedAt(client, msg) ?? Date.now() };
}

/** `turnDeadlineAt - 收到时刻`（≈ 该回合的时长档减去本机传输延迟；本机真栈延迟个位数 ms）。 */
function deadlineReading(t: TimedView): number {
  return t.view.turnDeadlineAt - t.at;
}

/** 某版本推送里的最新一手（recentActions 窗口末条的座位；无则 -1）。 */
function newestActionSeat(view: GovView): number {
  const w = view.recentActions ?? [];
  return w.length > 0 ? w[w.length - 1]!.seat : -1;
}

interface SessionSeat {
  timeoutCount?: number;
  trustee?: boolean;
}

interface SessionWire {
  version: number;
  /** 下一回合的权威截止时刻（`turnDeadlineAt - Date.now()` = 真实剩余时长）。 */
  turnDeadlineAt?: number;
  players: SessionSeat[];
}

/** `game:session:<code>` 的**实读**（C34：count 的观测面 = redis）。 */
function readSession(roomCode: string): SessionWire {
  const res = redisRaw(['GET', `game:session:${roomCode}`]);
  const text = res.stdout.trim();
  if (res.status !== 0 || text === '') {
    throw new ConformanceError(
      `redis GET game:session:${roomCode} 失败（status=${res.status}；${tailOut(res.stderr || res.stdout, 1)}）`,
    );
  }
  try {
    return JSON.parse(text) as SessionWire;
  } catch {
    throw new ConformanceError(`game:session:${roomCode} 不是 JSON：${text.slice(0, 120)}`);
  }
}

/** 某座位的治理量（缺字段 = 旧会话形态，按「未迁移」如实报 -1，不得静默当 0）。 */
function govOf(session: SessionWire, seat: number): { timeoutCount: number; trustee: boolean } {
  const p = session.players?.[seat] ?? {};
  return { timeoutCount: typeof p.timeoutCount === 'number' ? p.timeoutCount : -1, trustee: p.trustee === true };
}

// ────────────────────────────────────────────────────────────────────────────
// 真人驱动（⛔ 不用规则引擎当裁判 —— R168 同纪律；只用值映射）
// ────────────────────────────────────────────────────────────────────────────

interface ManualAction {
  type: 'game.play' | 'game.pass';
  payload: Record<string, unknown>;
  label: string;
}

/** 该座位在当前视图下的**合法**手动动作（首出必出最小单张；跟单张能压则压，否则过）。 */
function actionFor(view: GovView, seat: number): ManualAction {
  const hand = view.hand ?? [];
  if (hand.length === 0) throw new ConformanceError(`seat ${seat} 手牌为空（对局应已结束）`);
  const item = lastPlay(view);
  if (!item || item.seat === seat) {
    const card = extremeByRank(hand, 'min');
    return { type: 'game.play', payload: { cards: [card] }, label: `首出最小单张 ${card.r}` };
  }
  if (item.cards.length === 1) {
    const beat = smallestBeatingSingle(hand, item.cards[0]!);
    if (beat) return { type: 'game.play', payload: { cards: [beat] }, label: `跟单张压 ${beat.r}` };
    return { type: 'game.pass', payload: {}, label: '跟单张压不过 ⇒ 过' };
  }
  return { type: 'game.pass', payload: {}, label: '多张牌型 ⇒ 过' };
}

/**
 * 行动者**自己的**最新视图（⚠️ 手牌是按座位裁剪的：用 observer 的视图出牌 = 拿别人的手牌
 * 当载荷（13006/越权错件）。这里等行动者客户端追上 `atLeastVersion`——同一次转移对三家
 * 发同一 version（§6.4），差几毫秒的投递延迟由有界轮询吸收）。
 */
async function actorLatest(room: FreshRoom, seat: number, atLeastVersion: number): Promise<TimedView> {
  const client = room.bySeat.get(seat);
  if (!client) throw new ConformanceError(`seat ${seat} 没有对应客户端`);
  for (let i = 0; i < 25; i += 1) {
    const t = latest(client);
    if (t.view.version >= atLeastVersion) return t;
    await sleep(20);
  }
  throw new ConformanceError(`seat ${seat} 的客户端未追上 v${atLeastVersion}（最新 v${latest(client).view.version}）`);
}

/**
 * 让**当前行动者**打出一手合法动作并等下一次转移。
 *
 * ⚠️ 用 `client.send` 直发（**刻意不走 `sendThrottled`**：300ms 节流会吃掉 C/D 的 400/1000ms
 * 窗口；本片每客户端峰值 ≤4 条/5s ≪ 服务端 20 条/5s）。13004 有界重试一次（版本在途）。
 * ⚠️ **不登记断言**（只记 info）：驱动步数依赖真实时序（等 redis 实读期间可能恰好发生一次
 * 自动动作）⇒ 把驱动次数写进条数会让「连续两跑读数一致」变成时序抽奖。判据在显式断言里。
 */
async function actCurrent(room: FreshRoom, observer: HarnessClient, what: string): Promise<TimedView> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const global = latest(observer);
    const seat = global.view.currentPlayer;
    // ⚠️ 动作载荷（手牌）必须取**行动者自己**的裁剪视图 —— 见 `actorLatest`。
    const own = await actorLatest(room, seat, global.view.version);
    const client = room.bySeat.get(seat)!;
    const action = actionFor(own.view, seat);
    const ack = await client.send(action.type, action.payload, own.view.version);
    if (ack.code === ErrCode.OK) {
      info(`${what}：seat ${seat} ${action.label}（v${own.view.version}）`);
      return timedAdvance(observer, own.view.version, STEP_TIMEOUT_MS, `${what}（转移）`);
    }
    if (ack.code !== ErrCode.VERSION_CONFLICT) {
      throw new ConformanceError(
        `${what}：seat ${seat} ${action.type} 被拒 code=${ack.code} ${ack.message ?? ''}`,
      );
    }
    info(`${what}：seat ${seat} 命中 13004（版本在途）⇒ 重读快照重发（第 ${attempt}/3 次）`);
    await sleep(120);
  }
  throw new ConformanceError(`${what}：13004 有界重试 3 次仍失败`);
}

/** 驱动到「谓词成立」的转移（最多 `maxActions` 次手动动作；动作本身只记 info）。 */
async function driveUntil(
  room: FreshRoom,
  observer: HarnessClient,
  what: string,
  predicate: (v: GovView) => boolean,
  maxActions = 4,
): Promise<TimedView> {
  let cur = latest(observer);
  for (let i = 0; i < maxActions; i += 1) {
    if (predicate(cur.view)) return cur;
    cur = await actCurrent(room, observer, `${what}#${i + 1}`);
  }
  if (predicate(cur.view)) return cur;
  throw new ConformanceError(`${what}：${maxActions} 次动作内未到达目标态（最新 currentPlayer=${cur.view.currentPlayer}）`);
}

/** 驱动到某座位成为行动者（轮转严格按 `(seat+1)%3` ⇒ ≤2 次动作）。 */
function driveToSeat(room: FreshRoom, observer: HarnessClient, seat: number, what: string): Promise<TimedView> {
  return driveUntil(room, observer, what, (v) => v.currentPlayer === seat);
}

// ────────────────────────────────────────────────────────────────────────────
// 主用例
// ────────────────────────────────────────────────────────────────────────────

export async function runSlice27(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  let restored = false;

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ⓪ 前置：注入四 env ⇒ 重建 game-service（本分支源码）⇒ healthy + HTTP 健康
    //    ⇒ 容器内四值实读（注入落地自证）
    // ══════════════════════════════════════════════════════════════════════
    step('⓪ 前置：注入 1500/1000/400/3 ⇒ `up -d --no-deps --build game-service`（本分支源码）');
    info(`RUN_TAG=${RUN_TAG}（本片无 actionId 面——WS 消息 + compose 重建均无锚；仅日志标注）`);
    const inject = rebuildGameService(INJECT_ENV);
    checks.eq(inject.code, 0, `⓪ 注入态重建退出码（失败尾部：${tailOut(inject.out)}）`);
    const injHealthy = await waitContainerHealthy('ftl-game-service', 150_000);
    checks.that(injHealthy.ok, `⓪ 注入态容器 healthy（末次 ${injHealthy.last}）`);
    const injHttp = await gameHttpHealthy();
    checks.that(injHttp.ok, `⓪ 注入态 HTTP 健康探针 ${GAME_URL}/api/health（末次 ${injHttp.last}）`);
    checks.eq(readContainerEnv(ENV_NORMAL), String(INJECT_VALUES.normal), `⓪ 容器内 ${ENV_NORMAL} 实读 = 注入值`);
    checks.eq(readContainerEnv(ENV_ACCEL), String(INJECT_VALUES.accel), `⓪ 容器内 ${ENV_ACCEL} 实读 = 注入值`);
    checks.eq(readContainerEnv(ENV_TRUSTEE), String(INJECT_VALUES.trustee), `⓪ 容器内 ${ENV_TRUSTEE} 实读 = 注入值`);
    checks.eq(readContainerEnv(ENV_AFTER), String(INJECT_VALUES.after), `⓪ 容器内 ${ENV_AFTER} 实读 = 注入值`);

    step('⓪ 起局：registerUser ×3（真人，⛔ 零机器人）⇒ 撮合/入座/发牌 ⇒ 叫抢推进到 playing');
    // recreate 后 room-service 的 TCP RPC 链路有短暂重连窗：先静置一拍再起局。
    await sleep(1_500);
    const room = await startFreshRoom(`t8-${RUN_TAG}-`, { humans: 3 });
    clients.push(...room.clients);
    checks.eq(room.clients.length, 3, '⓪ 三家真人客户端全部建立');
    await playBiddingToPlaying(room, checks);
    const playStart0 = latest(room.clients[0]!);
    const landlordSeat = playStart0.view.landlordSeat;
    if (landlordSeat === null || landlordSeat < 0) throw new ConformanceError('⓪ 地主座位缺席（landlordSeat=null）');
    const idleSeat = landlordSeat;
    const f1Seat = (landlordSeat + 1) % 3;
    const f2Seat = (landlordSeat + 2) % 3;
    // ⚠️ observer 必须是**全程不离开房间**的客户端：E 组的弃局者是 f2Seat ⇒ observer 取 f1Seat 的客户端
    //    （⛔ 不是 clients[0]——座位号由服务端随机分配，clients[0] 可能恰是弃局者）。
    const observer = room.bySeat.get(f1Seat)!;
    const playStart = latest(observer);
    info(`⓪ 座位布局：地主/挂机座位=${idleSeat}，农民=${f1Seat}/${f2Seat}；observer=农民1 的客户端`);
    checks.that(
      playStart.view.currentPlayer === idleSeat,
      `⓪ 进 playing 后首回合 = 地主（currentPlayer=${playStart.view.currentPlayer}，地主=${idleSeat}）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // A 加速两档：一真人不动 ⇒ 首回合超时 wait normal → 其下一回合 deadline ≈ accel
    // ══════════════════════════════════════════════════════════════════════
    step('A：一真人（地主）不动 ⇒ 首回合超时（normal 档）→ 其下一回合 deadline ≈ accel=1000');
    const aReadNormal = deadlineReading(playStart);
    checks.that(
      aReadNormal >= 1_200 && aReadNormal <= 1_700,
      `A 首回合读 ≈ normal=1500（turnDeadlineAt − 收到时刻 = ${aReadNormal}ms ∈ [1200,1700]）`,
    );
    const aTimeout1 = await timedAdvance(observer, playStart.view.version, 5_000, 'A 首回合超时');
    checks.eq(newestActionSeat(aTimeout1.view), idleSeat, 'A 首回合超时自动动作的座位 = 挂机者（无人发手动消息）');
    checks.eq(aTimeout1.view.trustees.length, 3, 'A 超时转移的 trustees 仍是三元数组（C23 形状在生产路径成立）');
    const aGov1 = govOf(readSession(room.roomCode), idleSeat);
    checks.eq(aGov1.timeoutCount, 1, 'A 首回合超时后 redis 实读 timeoutCount = 1（C1：超时 +1）');
    checks.that(
      aTimeout1.view.trustees[idleSeat] === false,
      'A 一次超时后 trustees[挂机者] 仍为 false（after=3）',
    );

    // 两个农民各打一手 ⇒ 轮回到挂机者（轮转严格 3 循环）
    await driveToSeat(room, observer, f1Seat, 'A 驱动农民1');
    const aIdleTurn2 = await driveToSeat(room, observer, idleSeat, 'A 驱动农民2');
    const aReadAccel = deadlineReading(aIdleTurn2);
    checks.that(
      aReadAccel >= 700 && aReadAccel <= 1_150,
      `A 下一回合读 ≈ accel=1000（= ${aReadAccel}ms ∈ [700,1150]；count=1 档）`,
    );
    checks.that(
      aReadNormal - aReadAccel >= 300,
      `A 两档差 = ${aReadNormal - aReadAccel}ms ≥ 300（normal 与 accel 确实分档，⛔ 不是同一读数）`,
    );
    const aTimeout2 = await timedAdvance(observer, aIdleTurn2.view.version, 5_000, 'A 第二回合超时');
    checks.eq(newestActionSeat(aTimeout2.view), idleSeat, 'A 第二回合超时自动动作的座位 = 挂机者');
    const aGov2 = govOf(readSession(room.roomCode), idleSeat);
    checks.eq(aGov2.timeoutCount, 2, 'A 第二次超时后 redis 实读 timeoutCount = 2（C1 累计）');

    // ══════════════════════════════════════════════════════════════════════
    // B 自动托管：第三次超时 ⇒ trustees[seat]=true；后续回合 ≤ trustee=400 自动动作
    // ══════════════════════════════════════════════════════════════════════
    step('B：第三次超时 ⇒ trustees[挂机者]=true（快照实读）且后续回合 ≤ trustee=400 自动动作');
    await driveToSeat(room, observer, f1Seat, 'B 驱动农民1');
    const bIdleTurn3 = await driveToSeat(room, observer, idleSeat, 'B 驱动农民2');
    checks.that(
      deadlineReading(bIdleTurn3) >= 700 && deadlineReading(bIdleTurn3) <= 1_150,
      `B 第三次回合仍是 accel 档（读 ${deadlineReading(bIdleTurn3)}ms ∈ [700,1150]；count=2）`,
    );
    const bTimeout3 = await timedAdvance(observer, bIdleTurn3.view.version, 5_000, 'B 第三次超时');
    checks.eq(newestActionSeat(bTimeout3.view), idleSeat, 'B 第三次超时自动动作的座位 = 挂机者');
    const bGov3 = govOf(readSession(room.roomCode), idleSeat);
    checks.eq(bGov3.timeoutCount, 3, 'B 第三次超时后 redis 实读 timeoutCount = 3（after=3）');
    checks.that(bGov3.trustee, 'B 第三次超时后 redis 实读 trustee = true（C2 阈值用 ≥）');
    checks.that(
      bTimeout3.view.trustees[idleSeat] === true,
      'B 第三次超时的推送快照 trustees[挂机者] = true（C34：徽标数据面实读）',
    );
    checks.that(
      bTimeout3.view.trustees.filter(Boolean).length === 1,
      `B trustees 只有挂机者一人置位（实读 ${JSON.stringify(bTimeout3.view.trustees)}）`,
    );

    // 托管档两连回合：每回合读 ≈ 400，且「回合开始 → 自动动作」实际间隔 ≈ 400
    for (let round = 1; round <= 2; round += 1) {
      await driveToSeat(room, observer, f1Seat, `B 托管档第 ${round} 轮·农民1`);
      const turn = await driveToSeat(room, observer, idleSeat, `B 托管档第 ${round} 轮·农民2`);
      const reading = deadlineReading(turn);
      checks.that(
        reading >= 150 && reading <= 650,
        `B 托管档第 ${round} 轮读 ≈ trustee=400（= ${reading}ms ∈ [150,650]）`,
      );
      const auto = await timedAdvance(observer, turn.view.version, 3_000, `B 托管档第 ${round} 轮自动动作`);
      const interval = auto.at - turn.at;
      checks.that(
        auto.view.version > turn.view.version && newestActionSeat(auto.view) === idleSeat,
        `B 托管档第 ${round} 轮到点仍自动动作（seat=${newestActionSeat(auto.view)}）`,
      );
      checks.that(
        interval >= 150 && interval <= 1_200,
        `B 托管档第 ${round} 轮「回合开始 → 自动动作」间隔 ${interval}ms ∈ [150,1200]（≤ trustee 档 + 传递余量）`,
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // C 复位（normal 档）：自动托管 manual off ⇒ count 清零 → 下一回合 normal → 手动动作保持 0
    // ══════════════════════════════════════════════════════════════════════
    step('C：自动托管 manual off（count 清零）→ 挂机者下一回合 normal（1500ms）→ 手动动作后仍为 0（redis 实读）');
    const idleClient = room.bySeat.get(idleSeat)!;
    const cBeforeOff = latest(observer);
    checks.that(
      cBeforeOff.view.currentPlayer !== idleSeat,
      `C 前置：挂机者不是当前行动者（currentPlayer=${cBeforeOff.view.currentPlayer}；C13 同族）`,
    );
    const cOffAck = await idleClient.send('game.trustee', { on: false }, cBeforeOff.view.version);
    checks.eq(cOffAck.code, ErrCode.OK, 'C manual off ack = 0（C19：客户端 case ⇒ via manual）');
    const cOffView = await timedAdvance(observer, cBeforeOff.view.version, STEP_TIMEOUT_MS, 'C off 转移');
    checks.that(cOffView.view.trustees[idleSeat] === false, 'C off 后快照 trustees[挂机者] = false');
    checks.eq(
      cOffView.view.turnDeadlineAt,
      cBeforeOff.view.turnDeadlineAt,
      'C off（非行动者）不改 deadline（C13 同族；R8③）',
    );
    const cGovAfterOff = govOf(readSession(room.roomCode), idleSeat);
    checks.eq(cGovAfterOff.trustee, false, 'C off 后 redis trustee = false');
    checks.eq(
      cGovAfterOff.timeoutCount,
      0,
      'C off 自动托管 ⇒ count 清零（C4′；redis 实读）',
    );

    await driveToSeat(room, observer, f1Seat, 'C 驱动农民1');
    const cIdleTurn = await driveToSeat(room, observer, idleSeat, 'C 驱动农民2');
    const cReading = deadlineReading(cIdleTurn);
    checks.that(
      cReading >= 1_200 && cReading <= 1_700,
      `C 挂机者回合按 count=0 落 normal 档（读 ${cReading}ms ∈ [1200,1700]）`,
    );
    // 窗口内手动动作（normal 1500ms 档）—— 立即发送（无 spawnSync、无节流；手牌取行动者自己的视图）
    const cOwn = await actorLatest(room, idleSeat, cIdleTurn.view.version);
    const cAction = actionFor(cOwn.view, idleSeat);
    const cActAck = await idleClient.send(cAction.type, cAction.payload, cOwn.view.version);
    checks.eq(cActAck.code, ErrCode.OK, `C 挂机者在 normal 窗口内手动动作：${cAction.label}`);
    const cAfterAct = await timedAdvance(observer, cOwn.view.version, STEP_TIMEOUT_MS, 'C 手动动作转移');
    checks.eq(newestActionSeat(cAfterAct.view), idleSeat, 'C 复位动作确实来自挂机者（窗口内未被超时兜底抢走）');
    const cGovReset = govOf(readSession(room.roomCode), idleSeat);
    checks.eq(cGovReset.timeoutCount, 0, 'C 手动动作后 redis 实读 timeoutCount = 0（C3 回合消耗型复位）');
    checks.eq(cGovReset.trustee, false, 'C 手动动作后 redis 实读 trustee = false');

    await driveToSeat(room, observer, f1Seat, 'C 复位后·农民1');
    const cIdleTurnNext = await driveToSeat(room, observer, idleSeat, 'C 复位后·农民2');
    const cReadingNext = deadlineReading(cIdleTurnNext);
    checks.that(
      cReadingNext >= 1_200 && cReadingNext <= 1_700,
      `C 复位后下一回合回 normal 档（读 ${cReadingNext}ms ∈ [1200,1700]）`,
    );
    await actCurrent(room, observer, 'C 复位后继续推进');

    // ══════════════════════════════════════════════════════════════════════
    // D R8 三格 + C14 例外（快照差分）
    // ══════════════════════════════════════════════════════════════════════
    step('D：R8① 行动者被置 trustee ⇒ deadline 收缩 min(剩余,400)；R8② **手动开启的托管** manual off 不重排；R8③ 非行动者不动');
    const f1Client = room.bySeat.get(f1Seat)!;
    const f2Client = room.bySeat.get(f2Seat)!;
    const d1Turn = await driveToSeat(room, observer, f1Seat, 'D R8① 等农民1回合');
    const d1OnAck = await f1Client.send('game.trustee', { on: true }, d1Turn.view.version);
    checks.eq(d1OnAck.code, ErrCode.OK, 'D R8① 行动者 manual on ack = 0');
    checks.eq(d1OnAck.data?.version, d1Turn.view.version + 1, 'D R8① 轻量转移 version + 1（C9）');
    const d1View = await timedAdvance(observer, d1Turn.view.version, STEP_TIMEOUT_MS, 'D R8① on 转移');
    checks.that(d1View.view.trustees[f1Seat] === true, 'D R8① 快照 trustees[农民1] = true');
    checks.that(
      d1View.view.turnDeadlineAt <= d1Turn.view.turnDeadlineAt,
      `D R8① deadline **不延长**（旧 ${d1Turn.view.turnDeadlineAt} ≥ 新 ${d1View.view.turnDeadlineAt}）`,
    );
    const d1Reading = deadlineReading(d1View);
    checks.that(
      d1Reading >= 100 && d1Reading <= 650,
      `D R8① 新 deadline = now + min(剩余,400)（读 ${d1Reading}ms ∈ [100,650]）`,
    );
    const d1Auto = await timedAdvance(observer, d1View.view.version, 3_000, 'D R8① 收缩后的自动动作');
    checks.eq(newestActionSeat(d1Auto.view), f1Seat, 'D R8① 收缩后的回合照常自动动作（seat=农民1）');

    await driveToSeat(room, observer, f2Seat, 'D R8② 先驱动农民2');
    const d2Turn = await driveToSeat(room, observer, f1Seat, 'D R8② 等农民1（trustee 档）回合');
    const d2Gov = govOf(readSession(room.roomCode), f1Seat);
    checks.eq(
      d2Gov.timeoutCount,
      1,
      'D 前置：农民1 count=1（< after=3 ⇒ manual off 走非 auto 分支）',
    );
    const d2OffAck = await f1Client.send('game.trustee', { on: false }, d2Turn.view.version);
    checks.eq(d2OffAck.code, ErrCode.OK, 'D R8② 行动者 manual off ack = 0');
    const d2View = await timedAdvance(observer, d2Turn.view.version, STEP_TIMEOUT_MS, 'D R8② off 转移');
    checks.eq(d2View.view.turnDeadlineAt, d2Turn.view.turnDeadlineAt, 'D R8② manual off **不重排不重算**（deadline 逐字不变）');
    checks.that(d2View.view.trustees[f1Seat] === false, 'D R8② 快照 trustees[农民1] = false');
    const d2Auto = await timedAdvance(observer, d2View.view.version, 3_000, 'D R8② 原短延时自动动作');
    checks.eq(newestActionSeat(d2Auto.view), f1Seat, 'D R8② 本轮仍按原短延时自动走一次（不因 off 续命）');

    // R8③：非行动者（地主/挂机座）在农民2 的回合里 toggle ⇒ 快照差分 deadline/currentPlayer 均不动
    const d3Turn = await driveToSeat(room, observer, f2Seat, 'D R8③ 等农民2回合');
    const d3OnAck = await idleClient.send('game.trustee', { on: true }, d3Turn.view.version);
    checks.eq(d3OnAck.code, ErrCode.OK, 'D R8③ 非行动者 manual on ack = 0');
    const d3View = await timedAdvance(observer, d3Turn.view.version, STEP_TIMEOUT_MS, 'D R8③ on 转移');
    checks.that(d3View.view.trustees[idleSeat] === true, 'D R8③ 快照 trustees[非行动者] = true');
    checks.eq(d3View.view.turnDeadlineAt, d3Turn.view.turnDeadlineAt, 'D R8③ 非行动者变更：deadline 不动（快照差分）');
    checks.eq(d3View.view.currentPlayer, d3Turn.view.currentPlayer, 'D R8③ 非行动者变更：currentPlayer 不动');
    const d3OffAck = await idleClient.send('game.trustee', { on: false }, d3View.view.version);
    checks.eq(d3OffAck.code, ErrCode.OK, 'D R8③ 非行动者 manual off ack = 0');
    const d3OffView = await timedAdvance(observer, d3View.view.version, STEP_TIMEOUT_MS, 'D R8③ off 转移');
    checks.that(d3OffView.view.trustees[idleSeat] === false, 'D R8③ 快照 trustees[非行动者] 复原 = false');
    checks.eq(d3OffView.view.turnDeadlineAt, d3Turn.view.turnDeadlineAt, 'D R8③ off 后 deadline 仍不动（timer 未被触碰）');

    step('D C14：在局 `room.join` ⇒ `{on:false, via:reconnect}` 且本人是行动者 ⇒ 按 count 基线重排');
    // 先让农民1 的回合到来（count 经 R8①/② 已 > 0），置 trustee 后立刻回桌：
    // R6 例外应把 deadline 从 400 重排回 accel（count>0）—— 这是「回桌拿回控制权」的调度面。
    await driveToSeat(room, observer, f2Seat, 'D C14 先驱动农民2');
    const c14Turn = await driveToSeat(room, observer, f1Seat, 'D C14 等农民1回合');
    checks.that(
      deadlineReading(c14Turn) >= 600 && deadlineReading(c14Turn) <= 1_150,
      `D C14 前置：农民1 count>0 ⇒ 回合落 accel 档（读 ${deadlineReading(c14Turn)}ms）`,
    );
    const c14OnAck = await f1Client.send('game.trustee', { on: true }, c14Turn.view.version);
    checks.eq(c14OnAck.code, ErrCode.OK, 'D C14 前置：农民1 置 trustee（行动者）ack = 0');
    const c14OnView = await timedAdvance(observer, c14Turn.view.version, STEP_TIMEOUT_MS, 'D C14 trustee 收缩转移');
    const c14Shrunk = deadlineReading(c14OnView);
    checks.that(c14Shrunk >= 100 && c14Shrunk <= 650, `D C14 前置：deadline 收缩到 trustee 档（读 ${c14Shrunk}ms）`);
    // ⚠️ 必须在 400ms 窗口内让回桌的 trustee-off RPC 落到 game-service（本机真栈 ~10-50ms）
    const c14JoinAck = await f1Client.send('room.join', { roomCode: room.roomCode }, 0);
    checks.eq(c14JoinAck.code, ErrCode.OK, 'D C14 在局 room.join ack = 0');
    checks.eq(c14JoinAck.data?.seat, f1Seat, 'D C14 room.join ack 座位 = 原座位');
    const c14AfterJoin = await waitForView(
      observer,
      c14OnView.view.version,
      STEP_TIMEOUT_MS,
      (v) => v.trustees[f1Seat] === false,
      'D C14 回桌解除托管',
    );
    checks.that(c14AfterJoin.view.trustees[f1Seat] === false, 'D C14 回桌 ⇒ trustees[农民1] = false（C22 清除面）');
    const c14NewReading = deadlineReading(c14AfterJoin);
    checks.that(
      c14NewReading >= 700 && c14NewReading <= 1_150,
      `D C14 按 count 基线重排回 accel 档（读 ${c14NewReading}ms ∈ [700,1150]；count>0）`,
    );
    checks.that(
      c14AfterJoin.view.turnDeadlineAt > c14OnView.view.turnDeadlineAt,
      'D C14 deadline 确实被**推后**（收缩态 400ms → 基线 accel，⛔ 不是未重排的旧值）',
    );
    await actCurrent(room, observer, 'D C14 回桌后可继续动作');

    // 负对照：非 trustee 者反复 join 不动 timer（no-op 零推送）
    const c14NoopBase = latest(observer);
    const c14NoopJoin = await f1Client.send('room.join', { roomCode: room.roomCode }, 0);
    checks.eq(c14NoopJoin.code, ErrCode.OK, 'D C14 负对照：非 trustee 者 room.join ack = 0');
    await sleep(400);
    checks.that(
      latest(observer).view.version === c14NoopBase.view.version,
      `D C14 负对照：join 后 400ms 内无新推送（version 仍 ${c14NoopBase.view.version} ⇒ timer/deadline 未动）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // E 弃局→回桌：真实 leave（确认弃局）⇒ trustees 置位；room.join 回桌 ⇒ 解除 + 可继续动作
    // ══════════════════════════════════════════════════════════════════════
    step('E：农民2 真实 room.leave ⇒ abandon 托管置位（快照实读）→ room.join 回桌拿回（⛔ reconnect 必 13010）');
    const eTurn = await driveToSeat(room, observer, idleSeat, 'E 先驱动农民2，使弃局发生在他人回合');
    checks.that(eTurn.view.currentPlayer !== f2Seat, 'E 弃局前提：当前行动者 ≠ 弃局者（隔离弃局与回合推进）');
    const eLeaveAck = await f2Client.send('room.leave', { roomCode: room.roomCode }, 0);
    checks.eq(eLeaveAck.code, ErrCode.OK, 'E room.leave ack = 0（确认弃局）');
    const eAbandon = await waitForView(
      observer,
      eTurn.view.version,
      STEP_TIMEOUT_MS,
      (v) => v.trustees[f2Seat] === true,
      'E 弃局托管置位',
    );
    checks.that(eAbandon.view.trustees[f2Seat] === true, 'E 弃局 ⇒ 推送快照 trustees[弃局者] = true（C21 转发生效）');
    const eGovAbandon = govOf(readSession(room.roomCode), f2Seat);
    checks.that(eGovAbandon.trustee, 'E 弃局后 redis 实读 trustee = true（治理量落盘）');

    const eReconnect = await f2Client.send('game.reconnect', { lastVersion: eAbandon.view.version });
    checks.eq(
      eReconnect.code,
      ErrCode.RECONNECT_RECORD_MISSING,
      'E 负对照：弃局后 game.reconnect ⇒ 13010（⛔ 不是恢复路径；slice-05 C5 已钉死）',
    );
    const eTrusteeNoRoom = await f2Client.send('game.trustee', { on: false });
    checks.eq(
      eTrusteeNoRoom.code,
      ErrCode.NOT_IN_ROOM,
      'E C20 非塌缩：弃局后 game.trustee ⇒ 12004（真实码原样过 C→S，⛔ 不是 10007）',
    );

    const eJoinAck = await f2Client.send('room.join', { roomCode: room.roomCode }, 0);
    checks.eq(eJoinAck.code, ErrCode.OK, 'E 回桌 room.join ack = 0');
    checks.eq(eJoinAck.data?.seat, f2Seat, 'E 回桌 ack 座位 = 原座位');
    const eJoinView = await waitForView(
      observer,
      eAbandon.view.version,
      STEP_TIMEOUT_MS,
      (v) => v.trustees[f2Seat] === false,
      'E 回桌解除托管',
    );
    checks.that(eJoinView.view.trustees[f2Seat] === false, 'E 回桌 ⇒ trustees[弃局者] 解除 = false（C22 回桌面）');
    const eGovBack = govOf(readSession(room.roomCode), f2Seat);
    checks.eq(eGovBack.trustee, false, 'E 回桌后 redis 实读 trustee = false');

    const eF2Turn = await driveToSeat(room, observer, f2Seat, 'E 回桌后等弃局者回合');
    const eOwn = await actorLatest(room, f2Seat, eF2Turn.view.version);
    const eAction = actionFor(eOwn.view, f2Seat);
    const eActAck = await f2Client.send(eAction.type, eAction.payload, eOwn.view.version);
    checks.eq(eActAck.code, ErrCode.OK, `E 回桌后可继续动作：${eAction.label}`);
    const eAfterAct = await timedAdvance(observer, eOwn.view.version, STEP_TIMEOUT_MS, 'E 回桌动作转移');
    checks.eq(newestActionSeat(eAfterAct.view), f2Seat, 'E 回桌动作确实由弃局者打出（控制权已拿回）');

    // ══════════════════════════════════════════════════════════════════════
    // F 回调复核（C18）：非行动者 toggle 后定时到点 ⇒ 仍自动动作
    // ══════════════════════════════════════════════════════════════════════
    step('F：非行动者 toggle（纯 version 变化）后定时到点 ⇒ 仍自动动作（C18：timer 身份复核不被 version 干扰）');
    const fIdleAct = await driveToSeat(room, observer, idleSeat, 'F 先驱动挂机座清 count');
    const fOwnIdle = await actorLatest(room, idleSeat, fIdleAct.view.version);
    const fAction = actionFor(fOwnIdle.view, idleSeat);
    const fIdleAck = await idleClient.send(fAction.type, fAction.payload, fOwnIdle.view.version);
    checks.eq(fIdleAck.code, ErrCode.OK, `F 清 count 动作：${fAction.label}`);
    const fTurn = await timedAdvance(observer, fOwnIdle.view.version, STEP_TIMEOUT_MS, 'F 农民1 回合开始');
    checks.eq(fTurn.view.currentPlayer, f1Seat, 'F 前提：回合轮到农民1');
    // 非行动者 = 农民2（离农民1 的下一回合最远）
    const fOnAck = await f2Client.send('game.trustee', { on: true }, fTurn.view.version);
    checks.eq(fOnAck.code, ErrCode.OK, 'F 非行动者 toggle ack = 0（纯 version 变化）');
    const fOnView = await timedAdvance(observer, fTurn.view.version, STEP_TIMEOUT_MS, 'F toggle 转移');
    checks.eq(fOnView.view.turnDeadlineAt, fTurn.view.turnDeadlineAt, 'F toggle 不动 deadline（前提自证：定时器身份未变）');
    checks.eq(fOnView.view.currentPlayer, f1Seat, 'F toggle 后 currentPlayer 仍 = 农民1');
    const fAuto = await timedAdvance(observer, fOnView.view.version, 4_000, 'F 定时到点的自动动作');
    checks.eq(newestActionSeat(fAuto.view), f1Seat, 'F 非行动者 toggle 后定时到点 ⇒ 行动者仍被自动动作（C18 核心）');
    const fRemaining = deadlineReading(fTurn);
    const fInterval = fAuto.at - fTurn.at;
    checks.that(
      fInterval >= fRemaining - 200 && fInterval <= fRemaining + 800 && fInterval >= 700,
      `F 「回合开始 → 自动动作」间隔 ${fInterval}ms ≈ 回合档 ${fRemaining}ms（±[−200,+800]；version 变化未使回调失效）`,
    );
    const fOffAck = await f2Client.send('game.trustee', { on: false }, fAuto.view.version);
    checks.eq(fOffAck.code, ErrCode.OK, 'F 农民2 收尾 off ack = 0');
    const fOffView = await timedAdvance(observer, fAuto.view.version, STEP_TIMEOUT_MS, 'F off 转移');
    checks.that(fOffView.view.trustees[f2Seat] === false, 'F 收尾：trustees[农民2] 复原 = false');

    // ── 收尾前置：三人各动一手 ⇒ 全部 count 归零（还原后 30s 读数必须落在 normal 档）
    step('收尾前置：三人各手动动作一手 ⇒ redis 实读全部 timeoutCount=0 / trustee=false');
    for (let i = 0; i < 3; i += 1) await actCurrent(room, observer, `收尾前置#${i + 1}`);
    const finalSession = readSession(room.roomCode);
    for (let seat = 0; seat < 3; seat += 1) {
      const g = govOf(finalSession, seat);
      checks.eq(g.timeoutCount, 0, `收尾前置：seat ${seat} redis timeoutCount = 0`);
      checks.eq(g.trustee, false, `收尾前置：seat ${seat} redis trustee = false`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // 收尾：还原四 env + 重建回默认 + 健康探针 + 行为面复验（30s 档实读）
    // ══════════════════════════════════════════════════════════════════════
    step('收尾：四 env 还原为空 ⇒ 重建 game-service 回默认 ⇒ 健康探针 + 下一回合读 ≈ 30000（C36）');
    const restore = restoreGameService();
    checks.eq(restore.code, 0, `收尾 还原态重建退出码（失败尾部：${tailOut(restore.out)}）`);
    const resHealthy = await waitContainerHealthy('ftl-game-service', 150_000);
    checks.that(resHealthy.ok, `收尾 还原态容器 healthy（末次 ${resHealthy.last}）`);
    const resHttp = await gameHttpHealthy();
    checks.that(resHttp.ok, `收尾 还原态 HTTP 健康探针（末次 ${resHttp.last}）`);
    checks.eq(readContainerEnv(ENV_NORMAL), '', `收尾 容器内 ${ENV_NORMAL} 实读为空（不静默留下注入态）`);
    checks.eq(readContainerEnv(ENV_ACCEL), '', `收尾 容器内 ${ENV_ACCEL} 实读为空`);
    checks.eq(readContainerEnv(ENV_TRUSTEE), '', `收尾 容器内 ${ENV_TRUSTEE} 实读为空`);
    checks.eq(readContainerEnv(ENV_AFTER), '', `收尾 容器内 ${ENV_AFTER} 实读为空`);
    // 还原判据全部落地后，finally 才允许跳过兜底重建（否则任何一条红都要重试一次）。
    restored = true;

    // 行为面复验：重建会清掉进程内 timer（对局暂停在最后一次落盘）⇒ 送一手真实动作，
    // 下一回合的 deadline 必然按**默认 30000** 写（C36：slice-11 的「<5s ⇒ 非超时兜底」依赖它）。
    await sleep(1_500); // room-service 的 TCP RPC 链路重建窗
    let restoreBase = latest(observer);
    let restoreOwn = await actorLatest(room, restoreBase.view.currentPlayer, restoreBase.view.version);
    let restoreAct = actionFor(restoreOwn.view, restoreOwn.view.seat);
    let restoreAck = await room.bySeat
      .get(restoreOwn.view.seat)!
      .send(restoreAct.type, restoreAct.payload, restoreOwn.view.version);
    for (let attempt = 1; restoreAck.code !== ErrCode.OK && attempt <= 5; attempt += 1) {
      // 重建后 RPC 链路的瞬时不可达（10007 / ack 超时）与缓冲推送未派发（13004）都是已知重建窗：
      // 重读快照后重发，**有界**（真故障仍红）。
      info(`收尾：还原后首条动作 ack=${restoreAck.code}（重建窗）⇒ 有界重试 ${attempt}/5`);
      await sleep(1_000);
      restoreBase = latest(observer);
      restoreOwn = await actorLatest(room, restoreBase.view.currentPlayer, restoreBase.view.version);
      restoreAct = actionFor(restoreOwn.view, restoreOwn.view.seat);
      restoreAck = await room.bySeat
        .get(restoreOwn.view.seat)!
        .send(restoreAct.type, restoreAct.payload, restoreOwn.view.version);
    }
    checks.eq(restoreAck.code, ErrCode.OK, `收尾 还原后动作仍可推进：seat ${restoreOwn.view.seat} ${restoreAct.label}`);
    /**
     * ⚠️ 读数**不能**再用 `turnDeadlineAt - 收到时刻`：重建后的推送可能被缓冲/重放，
     * 收到时刻晚于 deadline 写入时刻 ⇒ 把传输延迟算进读数（2026-10-24 CI 实测 1996ms，
     * 但 env 已空、容器已重建）。动作 ack 后**立即**读 Redis 会话的权威 deadline；
     * 轮询只等 version 前进（写路径同步），不等推送。
     */
    let restoreReading = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const s = readSession(room.roomCode);
      if (s.version > restoreOwn.view.version && typeof s.turnDeadlineAt === 'number') {
        restoreReading = s.turnDeadlineAt - Date.now();
        break;
      }
      await sleep(250);
    }
    checks.that(
      restoreReading >= 25_000 && restoreReading <= 33_000,
      `收尾 还原后下一回合读 ≈ 30000（= ${restoreReading}ms ∈ [25000,33000]；默认档行为面恢复，C36；读 Redis 会话权威 deadline）`,
    );

    return checks;
  } finally {
    // ── 兜底复原（成败皆然）──────────────────────────────────────────────
    for (const client of clients) {
      try {
        client.close();
      } catch {
        /* 幂等 */
      }
    }
    if (!restored) {
      try {
        info(`finally 兜底：还原四 env 并重建 game-service（注入态残留会让后续片全跑短回合）`);
        const r = restoreGameService();
        info(`finally 兜底：compose up 退出码 ${r.code}${r.code === 0 ? '' : `（${tailOut(r.out)}）`}`);
        const h = await waitContainerHealthy('ftl-game-service', 150_000);
        info(`finally 兜底：game-service healthy=${h.ok}（末次 ${h.last}）`);
        for (const name of [ENV_NORMAL, ENV_ACCEL, ENV_TRUSTEE, ENV_AFTER]) {
          info(`finally 兜底：${name} 实读 = ${JSON.stringify(readContainerEnv(name))}（期望空串）`);
        }
      } catch (err) {
        info(
          `🔴 兜底复原失败（不影响原始结论；**手动**执行 docker compose up -d --no-deps game-service 并核对四 env）：` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
