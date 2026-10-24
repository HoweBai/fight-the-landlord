/**
 * conformance 用例：**配置中心 + 好友房开关**（片⑦ spec §3 的 C1/C2/C5半/C6半/C7/C8/C13–C17/C20）。
 *
 * 🎯 状态编排（spec §3 末小节「写死」，S-C1）——**本文件最要紧的一条纪律**：
 *    铁律 = **任何判据不得假设前序切片留下的状态**（本片追加在 CASES 末尾；slice-06/07.1/
 *    07.2-hardening/12 对开关**只开不还原**）。所以每一段**自带前置**（`setFriendRooms(...)`，
 *    admin PUT + **建房行为轮询** ≤30s），结尾**统一收尾** `setFriendRooms(false)`
 *    （复原生产默认；C11 只管 fresh —— 此收尾是卫生，不承担判据）。
 *
 * 段序（逐段见文件内 step 标题）：
 *   ① C1（自带前置 false）→ C17a（关推送变异：正证推送路径）→ 还原注入
 *   ② C2（直接改库 ⇒ 无 publish ⇒ 安全网送达；收尾经 admin 写回）→ C17b（拉长安全网变异：70s 时点仍未翻转 ⇒ 正证安全网）→ 还原注入
 *   ③ C8（ON 窗造在途房 ⇒ 置 false ⇒ 三面断言；匹配正对照在 T7 单测）
 *   ④ C13（同键并发 PUT ×2（值相反）⇒ version = v0+2 ⇒ 建房行为探针 ≤30s 与终值一致）
 *   ⑤ C16（错序自愈：stop config → **force-recreate** room → 热项默认 / start config → ≤70s 恢复）
 *   ⑥ C5半 / C6半 / C7 / C14 / C15 / C20（与开关态无关）
 *   ⑦ 统一收尾 setFriendRooms(false)（+ `finally` 的注入态兜底复原）
 *
 * ⚠️ 本片**做 docker 操作**（stop/start/`up -d --no-deps`/`compose exec`）——刻意如此：
 * C6半/C16/C17 的变异必须**经真容器**构造（渲染层 `docker compose config` 证不了「注入到没到」
 * 与「重建会不会拉快照」）。形态先例：`compose()` 照 `slice-07.3-edge.ts:141-159` 的 spawnSync
 * 手型；`exec()` 先例 = `lib/redis.ts` 的 redisRaw / `slice-07.5-backup` 的 `docker exec`
 * （`docker compose exec` **必带 `-T`**，CI 无 TTY）。
 *
 * ⚠️ 两个观测点分得开（C13 的 r1-S-I4）：
 *   - `GET /api/config`（**每次查库**）只反映**库** —— 见 `pollConfigValue`；
 *   - 消费侧**缓存**的真实出口 = **建房行为**（`POST /api/rooms` 的返回码）—— 见 `pollCreateCode`。
 *   不要拿前者去证「缓存收敛」。
 */
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  ADMIN_PASSWORD,
  ROOM_URL,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  setFriendRooms,
  type HarnessUser,
} from '../lib/http';
import { redisRaw, redisReplyText } from '../lib/redis';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度 ⇒ 与 `lib/redis.ts` 同一个相对路径）。
 * ⚠️ 每个 docker 子进程都显式带 `cwd: REPO_ROOT`：pnpm 跑脚本时 cwd 是包目录，
 * 不带它 `docker compose` 在包目录里找不到 compose 文件（slice-07.3 的同款成例）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** 门口 HTTP 口（宿主 → 容器 :80，Caddy 的 http→https 跳转监听；C20 从这一口起跳、逐跳跟随）。 */
const EDGE_HTTP_PORT = process.env.EDGE_HTTP_PORT ?? '8080';

/** 门口 HTTPS 口 —— **只供 C20 前置**（起门口时与 `EDGE_HTTP_PORT` 一起进 compose 的插值
 *  env：基文件的宿主映射 `"${EDGE_HTTPS_PORT:-443}:${EDGE_HTTPS_PORT:-443}"` 与 override 的
 *  `SITE_ADDRESS=localhost:${EDGE_HTTPS_PORT:-8443}` 都取自它 —— 不显式传时两者**回落值不同**
 *  （443 vs 8443）⇒ 会起出一个 C20 跳不进去的形态）。默认值与 `slice-07.3-edge.ts` 的常量同值。 */
const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';

/** 好友房开关的键名 —— **写死**（C13；规格 §2.2 四十四键之一）。 */
const FRIEND_ROOM_KEY = 'game.doudizhu.friendRoomEnabled';

// ────────────────────────────────────────────────────────────────────────────
// docker 助手（形态先例见文件头）
// ────────────────────────────────────────────────────────────────────────────

/** `compose()` 的返回：退出码 + stdout/stderr 合流（失败断言里带上尾部，结论才看得见原因）。 */
interface CommandResult {
  code: number;
  out: string;
}

/**
 * `docker compose …`（照 `slice-07.3-edge.ts:141-159`）。
 *
 * `extraEnv` 覆盖宿主 env —— C6半/C17 的**注入与还原**全走它（`up -d --no-deps` 只重建点名的
 * 服务；`--no-deps` 防把传递依赖一起拉进计划/无谓重建其它常驻容器）。
 */
function compose(extraEnv: Record<string, string>, ...args: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // ⚠️ 与 slice-07.3/07.2-deploy 同值（64MiB）：日志超 spawnSync 的默认上限（1MiB）会以
    //    `ENOBUFS` 失败 ⇒ status 为 null ⇒ 折成 code -1 ⇒ 看起来像「compose 退 1」的误导性红。
    maxBuffer: 64 * 1024 * 1024,
    // 重建/启动都有 compose 自己的进度输出；180s 是防「挂死」的进程级上界（不是等待就绪——
    // 就绪一律另有 docker inspect / HTTP 轮询承担）。
    timeout: 180_000,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * `docker compose exec -T <service> …`（先例 = `lib/redis.ts` 的 `redisRaw`）。
 * ⚠️ `-T` 不能省：不分配 TTY；无 TTY 环境下缺它会挂住（CI）。
 */
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
 * C2/C17b 的「直接改库」：把 `game.doudizhu.friendRoomEnabled` 置 true、version+1、`updated_by='drill'`。
 *
 * 🔴 命令形态**照规格 §C2 逐字**（`slice-14` 的 mysql 先例形态）：容器内两变量
 * （`MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE`）由 compose 提供；`-e "…"` 内的字符串字面量用
 * `\"`（随 sh 进 mysql 时还原为 `"`）、标识符用 `` \` ``（防**容器 sh** 把反引号当命令替换）。
 * ⚠️ 这条 SQL **没有 publish** —— 它刻意绕过 config-service 的写路径，用来构造
 * 「丢消息」形态（C2 证安全网；C17b 变异它）。
 */
const MYSQL_FLIP_TRUE_SH =
  `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "UPDATE platform_config SET ` +
  `value=CAST(\\"true\\" AS JSON), version=version+1, updated_at=NOW(3), updated_by=\\"drill\\" ` +
  `WHERE \\\`key\\\`=\\"game.doudizhu.friendRoomEnabled\\""`;

/** 直接改库翻转（C2 手法；C17b 重复同一形态）。 */
function flipFriendRoomInDb(): CommandResult {
  return exec('mysql', 'sh', '-c', MYSQL_FLIP_TRUE_SH);
}

/**
 * 等容器 healthy（`docker inspect … {{.State.Health.Status}}`；config/room 都有 compose healthcheck）。
 * 返回 `{ok,last}` 由调用方断言（把最后一次读数带进消息）。
 */
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
 * 等 room-service 就绪（recreate 后的窗口）：轮询 `ROOM_URL/api/health` 200，≤60s。
 * ⚠️ 单次 fetch **自带超时**：Docker 的端口代理会**先接受 TCP** 再等容器里的进程 listen ——
 * 进程还没起时这个 await 会一直挂着（`lib/http.ts` 的 assertGatewayHealthy 同族教训：
 * 「有界」由**单次**超时决定，不是循环次数）。返回 `{ok,last}` 由调用方断言。
 */
async function waitRoomHealthy(timeoutMs = 60_000): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const res = await fetch(`${ROOM_URL}/api/health`, { signal: AbortSignal.timeout(5_000) });
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
// 观测助手（两个观测点分得开 —— 见文件头）
// ────────────────────────────────────────────────────────────────────────────

/** 建房探针（§7.1 `POST /api/rooms`；`mode: 'random'` 与 `setFriendRooms` 同形）。返回信封 code。 */
async function createRoomCode(token: string): Promise<unknown> {
  const res = await postJson('/api/rooms', { mode: 'random' }, token);
  return res.body?.code;
}

/**
 * 轮询**建房行为**直至 `want`（有上界）。返回最后一次读数 —— **由调用方断言**
 * （超时不是等待的错，而是「判据不成立」⇒ 让 `checks` 打出来，别用异常顶掉）。
 */
async function pollCreateCode(want: unknown, timeoutMs: number, token: string): Promise<{ ok: boolean; last: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    last = await createRoomCode(token);
    if (last === want) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

/**
 * `GET /api/config` 轮询 ≤timeout（观察点 = config-service 的**读面**；消费侧生效另由建房探针观测 ——
 * 它每次查库、证不了消费侧缓存，见文件头）。
 */
async function pollConfigValue(user: HarnessUser, expected: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cfg = await getJson<Record<string, unknown>>('/api/config', user.accessToken);
    if (cfg.body?.data?.friendRoomEnabled === expected) return;
    if (Date.now() >= deadline) {
      throw new ConformanceError(
        `friendRoomEnabled=${expected} ${timeoutMs}ms 内未生效（最后 ${JSON.stringify(cfg.body?.data)}）`,
      );
    }
    await sleep(1_000);
  }
}

/** `GET /api/admin/config` 的形状（每键 `{value, version}` + 全局 MAX）。 */
interface AdminConfigData {
  config: Record<string, { value: unknown; version: number }>;
  version: number;
}

/** 读**该键**的 `{value, version}`（缺行 ⇒ 抛，带原始载荷 —— 不让缺行伪装成 undefined 比较）。 */
async function adminFriendRoom(admin: string): Promise<{ value: unknown; version: number }> {
  const res = await adminGetConfig<AdminConfigData>(admin);
  const entry = res.body?.data?.config?.[FRIEND_ROOM_KEY];
  if (!entry) {
    throw new ConformanceError(
      `GET /api/admin/config 缺 ${FRIEND_ROOM_KEY} —— 实际 ${JSON.stringify(res.body?.data?.config ?? res.body)}`,
    );
  }
  return entry;
}

// ────────────────────────────────────────────────────────────────────────────
// C20：经门口逐跳取页（自签证书 ⇒ 不校验；undici 不接受 per-request 的 rejectUnauthorized，
// 所以照 slice-07.3-edge 用 node:https —— 也**不要**用进程级的 NODE_TLS_REJECT_UNAUTHORIZED=0）
// ────────────────────────────────────────────────────────────────────────────

/** 单跳（http 或 https；https 自签 ⇒ 不校验证书）。 */
function edgeHop(url: URL): Promise<{ status: number; location: string; body: string }> {
  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    rejectUnauthorized: false,   // 仅 https 生效；http 形态被结构性忽略（同一 options 两种协议共用）
  };
  return new Promise((resolve_, reject) => {
    const onRes = (res: http.IncomingMessage): void => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve_({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ''), body }));
    };
    // 两种协议各调各自的 request（`https.RequestOptions` 是 `http.RequestOptions` 的结构子型，两处都能用）。
    const req = url.protocol === 'https:' ? https.request(options, onRes) : http.request(options, onRes);
    req.on('error', reject);
    req.end();
  });
}

/**
 * 从**门口 HTTP 口**（`EDGE_HTTP_PORT`，8080）起跳、逐跳跟随重定向（≤6 跳）。
 *
 * ⚠️ 环境事实（T12 实测，本判据**必须**知悉）：开发/CI 形态的门口，宿主 :8080 一律
 * **308** 跳 `https://localhost:8443`（自签）—— 裸 `fetch('http://localhost:8080/admin/')`
 * 会在跟随那一步撞自签证书。所以 C20 故意用「逐跳 + 不校验证书」的手型，
 * 起点仍是规格要求的 **8080**；跳转链原样进断言消息（301 形态可见）。
 */
async function edgeGetFollowing(path: string): Promise<{ status: number; body: string; chain: string[] }> {
  let url = new URL(`http://localhost:${EDGE_HTTP_PORT}${path}`);
  const chain: string[] = [];
  for (let i = 0; i < 6; i++) {
    const hop = await edgeHop(url);
    chain.push(`${url.protocol}//${url.host}${url.pathname} ⇒ ${hop.status}${hop.location ? ` → ${hop.location}` : ''}`);
    if (hop.status >= 300 && hop.status < 400 && hop.location !== '') {
      url = new URL(hop.location, url);
      continue;
    }
    return { status: hop.status, body: hop.body, chain };
  }
  throw new ConformanceError(`C20：重定向超过 6 跳仍未落定（链：${chain.join(' | ')}）`);
}

// ────────────────────────────────────────────────────────────────────────────
// 主体
// ────────────────────────────────────────────────────────────────────────────

export async function runSlice14(): Promise<Checks> {
  const checks = new Checks();
  const user = await registerUser(14);
  const admin = await adminLogin();
  // ⚠️ `adminLogin()` 同时是**起手自证**：口令与栈不一致时整片从一开始就响亮地失败
  //    （而不是退化成几十条 401 假红）。

  try {
    // ══════════════════════════════════════════════════════════════════════
    // 编排第 1 段：C1（自带前置）+ C17a（关推送变异）→ 还原注入
    // ══════════════════════════════════════════════════════════════════════
    step('C1①②③：改了即生效（30s 窗 < 安全网 60s —— 只证**推送路径**，不靠安全网兜底）');
    await setFriendRooms(false, user.accessToken);            // 前置：不假设前序切片留下的状态
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED, 'C1① 起态 false ⇒ 建房 12006');
    const c1PutOn = await adminPutConfig(FRIEND_ROOM_KEY, true, admin);
    checks.eq(c1PutOn.body?.code, ErrCode.OK, 'C1② PUT true ⇒ code 0');
    await pollConfigValue(user, true, 30_000);                // GET /api/config 轮询 ≤30s（读面=库）
    checks.eq(await createRoomCode(user.accessToken), ErrCode.OK, 'C1② true 生效后建房 code 0（消费侧已跟）');
    const c1PutOff = await adminPutConfig(FRIEND_ROOM_KEY, false, admin);
    checks.eq(c1PutOff.body?.code, ErrCode.OK, 'C1③ PUT false ⇒ code 0');
    await pollConfigValue(user, false, 30_000);
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED, 'C1③ 还原 ⇒ 建房 12006');

    step('C17a：关推送（CONFIG_SYNC_DISABLE_PUSH=1 注入 room-service）⇒ 30s 时点仍未生效 ⇒ 推送路径得证');
    // 注入 = 宿主 env + `up -d --no-deps room-service`（env 变化 ⇒ 重建；重建即拉最新快照）。
    // ⚠️ 同时把 SAFETY_NET_MS 显式置空 —— 还原态不靠「宿主碰巧没导出它」。
    const c17aUp = compose({ CONFIG_SYNC_DISABLE_PUSH: '1', CONFIG_SYNC_SAFETY_NET_MS: '' }, 'up', '-d', '--no-deps', 'room-service');
    checks.eq(c17aUp.code, 0, 'C17a① 注入重建 room-service（CONFIG_SYNC_DISABLE_PUSH=1）');
    const c17aHealthy = await waitRoomHealthy();
    checks.that(c17aHealthy.ok, `C17a① 重建后 room-service 就绪 —— ${c17aHealthy.last}`);
    await setFriendRooms(false, user.accessToken);            // 前置：重建拉到的快照 = 库（上一段收尾 false）
    const c17aPut = await adminPutConfig(FRIEND_ROOM_KEY, true, admin);
    checks.eq(c17aPut.body?.code, ErrCode.OK, 'C17a② PUT true ⇒ code 0');
    await sleep(30_000);                                      // 30s 稳态窗（< 安全网 60s）
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED,
      'C17a② 30s 时点建房仍 12006（推送已关且安全网未到 ⇒ C1② 依赖的确实是推送路径）');
    const c17aDeadline = Date.now() + 40_000;                 // 总窗 = PUT 后 ≤70s（30s 已过）
    const c17aFlip = await pollCreateCode(ErrCode.OK, Math.max(1_000, c17aDeadline - Date.now()), user.accessToken);
    checks.that(c17aFlip.ok, `C17a③ ≤70s 内建房变 code 0（安全网兜底正证）—— 最后一次 ${JSON.stringify(c17aFlip.last)}`);
    // 还原注入：正常 env（两枚测试 env 都显式置空）重建 ⇒ 重建即拉最新快照（库=true）。
    const c17aBack = compose({ CONFIG_SYNC_DISABLE_PUSH: '', CONFIG_SYNC_SAFETY_NET_MS: '' }, 'up', '-d', '--no-deps', 'room-service');
    checks.eq(c17aBack.code, 0, 'C17a④ 还原注入（正常 env 重建）');
    const c17aHealthy2 = await waitRoomHealthy();
    checks.that(c17aHealthy2.ok, `C17a④ 还原后 room-service 就绪 —— ${c17aHealthy2.last}`);
    await setFriendRooms(false, user.accessToken);            // 置回 false（收尾）

    // ══════════════════════════════════════════════════════════════════════
    // 编排第 2 段：C2（改库 ⇒ 安全网送达）+ C17b（拉长安全网变异）
    // ══════════════════════════════════════════════════════════════════════
    step('C2：直接改库 ⇒ 无 publish ⇒ ≤70s 由安全网送达（收尾经 admin 写回）');
    // 前置自证：库值 false（否则「改库 ⇒ ≤70s 翻转」会退化成恒真——值本来就是 true）。
    const c2Pre = await adminFriendRoom(admin);
    checks.eq(c2Pre.value, false, 'C2 前提：库值 false（C1/C17a 已置回）');
    const c2Upd = flipFriendRoomInDb();
    checks.eq(c2Upd.code, 0, `C2① 直接改库（无 publish）必须成功 —— 输出尾部：${tailOut(c2Upd.out)}`);
    const c2UpdVal = await adminFriendRoom(admin);
    checks.eq(c2UpdVal.value, true, 'C2② 前提：UPDATE 已真落库（false ⇒ true）');
    const c2Flip = await pollCreateCode(ErrCode.OK, 70_000, user.accessToken);
    checks.that(c2Flip.ok,
      `C2② 无 publish 的直接改库 ⇒ ≤70s 建房变 code 0（安全网送达）—— 最后一次 ${JSON.stringify(c2Flip.last)}`);
    await setFriendRooms(false, user.accessToken);            // 收尾：经 admin 写回并轮询至生效

    step('C17b：CONFIG_SYNC_SAFETY_NET_MS=600000 注入 ⇒ 改库 ⇒ 70s 时点仍未翻转 ⇒ 安全网得证 ⇒ 还原');
    const c17bUp = compose({ CONFIG_SYNC_SAFETY_NET_MS: '600000', CONFIG_SYNC_DISABLE_PUSH: '' }, 'up', '-d', '--no-deps', 'room-service');
    checks.eq(c17bUp.code, 0, 'C17b① 注入超大安全网并重建 room-service');
    const c17bHealthy = await waitRoomHealthy();
    checks.that(c17bHealthy.ok, `C17b① 重建后 room-service 就绪 —— ${c17bHealthy.last}`);
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED,
      'C17b② 前提：重建后起态建房 12006（新建拉到的快照 = 库 = false）');
    const c17bAt = Date.now();
    const c17bUpd = flipFriendRoomInDb();
    checks.eq(c17bUpd.code, 0, `C17b② 直接改库必须成功 —— 输出尾部：${tailOut(c17bUpd.out)}`);
    const c17bVal = await adminFriendRoom(admin);
    checks.eq(c17bVal.value, true, 'C17b② 前提：库值已真翻 true（否则「70s 未翻转」是空测）');
    const c17bRemain = 70_000 - (Date.now() - c17bAt);
    if (c17bRemain > 0) {
      info(`C17b② 等到 70s 时点（还差约 ${Math.ceil(c17bRemain / 1000)}s；600s 安全网在此窗内必不到）……`);
      await sleep(c17bRemain);
    }
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED,
      'C17b② 70s 时点建房仍 12006（安全网被拉长 ⇒ 库已翻而消费侧未跟 ⇒ C2 依存安全网得证）');
    // 还原注入：正常 env 重建 ⇒ **重建即拉最新快照** —— 先正证拉到的正是库里的 true
    //（「改库真发生了」+「重建确实重拉」一条断言同时钉住）。
    const c17bBack = compose({ CONFIG_SYNC_DISABLE_PUSH: '', CONFIG_SYNC_SAFETY_NET_MS: '' }, 'up', '-d', '--no-deps', 'room-service');
    checks.eq(c17bBack.code, 0, 'C17b③ 还原注入（正常 env 重建）');
    const c17bHealthy2 = await waitRoomHealthy();
    checks.that(c17bHealthy2.ok, `C17b③ 还原后 room-service 就绪 —— ${c17bHealthy2.last}`);
    checks.eq(await createRoomCode(user.accessToken), ErrCode.OK,
      'C17b③ 还原后建房 code 0（重建即拉最新快照：拉到的正是库里的 true）');
    await setFriendRooms(false, user.accessToken);            // 收尾：写回 false（推送已恢复）
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED, 'C17b③ 收尾：建房回 12006');

    // ══════════════════════════════════════════════════════════════════════
    // 编排第 3 段：C8（ON 窗造在途房）
    // ══════════════════════════════════════════════════════════════════════
    step('C8：ON 窗 ⇒ 造在途房 ⇒ 置 false ⇒ 三面断言（匹配正对照在 T7 单测）');
    await setFriendRooms(true, user.accessToken);             // ON 窗（轮询至建房 code 0）
    const c8Created = await postJson<{ code: string }>('/api/rooms', { mode: 'random' }, user.accessToken);
    checks.eq(c8Created.body?.code, ErrCode.OK, 'C8① ON 窗建房 code 0');
    const c8Room = c8Created.body?.data?.code ?? '';
    checks.that(typeof c8Room === 'string' && c8Room !== '', `C8① 在途房必须有 code —— 实际 ${JSON.stringify(c8Created.body)}`);
    await setFriendRooms(false, user.accessToken);            // 轮询至建房 12006（开关已关）
    const c8Join = await postJson(`/api/rooms/${c8Room}/join`, {}, user.accessToken);
    checks.eq(c8Join.body?.code, ErrCode.FRIEND_ROOM_FAILED, 'C8② 在途房占座拒 12006');
    const c8List = await getJson<unknown[]>('/api/rooms', user.accessToken);
    checks.eq(c8List.body?.code, ErrCode.OK, 'C8③ 列表 code 0');
    checks.that(Array.isArray(c8List.body?.data) && c8List.body.data.length === 0,
      `C8③ 列表必须是空数组 —— 实际 ${JSON.stringify(c8List.body?.data)}`);

    // ══════════════════════════════════════════════════════════════════════
    // 编排第 4 段：C13（同键并发 PUT）
    // ══════════════════════════════════════════════════════════════════════
    step('C13：同键并发 PUT（值相反）⇒ version = v0+2；终值=其一；建房行为探针 ≤30s 收敛');
    await setFriendRooms(false, user.accessToken);            // 前置：不假设前序状态
    const c13V0 = (await adminFriendRoom(admin)).version;
    const [c13PutT, c13PutF] = await Promise.all([
      adminPutConfig(FRIEND_ROOM_KEY, true, admin),
      adminPutConfig(FRIEND_ROOM_KEY, false, admin),
    ]);
    checks.eq(c13PutT.body?.code, ErrCode.OK, 'C13① 并发 PUT true ⇒ code 0');
    checks.eq(c13PutF.body?.code, ErrCode.OK, 'C13① 并发 PUT false ⇒ code 0');
    const c13Agg = await adminFriendRoom(admin);
    checks.eq(c13Agg.version, c13V0 + 2, 'C13② 该键 version = v0+2（行锁串行化并发写、无覆盖丢弃）');
    checks.that(c13Agg.value === true || c13Agg.value === false,
      `C13② 终值 = 其一（经 admin 读定）—— 实际 ${JSON.stringify(c13Agg.value)}`);
    const c13Want = c13Agg.value === true ? ErrCode.OK : ErrCode.FRIEND_ROOM_FAILED;
    const c13Conv = await pollCreateCode(c13Want, 30_000, user.accessToken);
    checks.that(c13Conv.ok,
      `C13③ 建房行为探针 ≤30s 与终值一致（${c13Want === ErrCode.OK ? 'code 0' : '12006'}；` +
      `< 安全网 60s —— 不然缓存错序会被兜底 tick 救活而漏判）—— 最后一次 ${JSON.stringify(c13Conv.last)}`);
    await setFriendRooms(false, user.accessToken);            // 收尾

    // ══════════════════════════════════════════════════════════════════════
    // 编排第 5 段：C16（错序自愈）
    // ══════════════════════════════════════════════════════════════════════
    step('C16：错序自愈（stop config → force-recreate room → 热项默认 / start config → ≤70s 恢复）');
    await setFriendRooms(true, user.accessToken);             // 前置（自带）：轮询至建房 code 0
    checks.eq(await createRoomCode(user.accessToken), ErrCode.OK, 'C16 前置 true 生效（建房 code 0）');
    const c16Stop = compose({}, 'stop', 'config-service');
    checks.eq(c16Stop.code, 0, 'C16① stop config-service');
    // ⚠️ `--force-recreate` 不可省：`up -d` 对**未变**容器是 no-op —— 不强制就复现不出「冷启动」。
    // ⚠️ `--no-deps`：无硬门 ⇒ 不碰（已停的）config-service，也不动其它常驻容器。
    const c16Recreate = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'room-service');
    checks.eq(c16Recreate.code, 0, 'C16① force-recreate room-service（config 已停）');
    const c16Healthy = await waitRoomHealthy();
    checks.that(c16Healthy.ok, `C16② room /api/health 就绪（配置中心停着也不得停摆）—— ${c16Healthy.last}`);
    checks.eq(await createRoomCode(user.accessToken), ErrCode.FRIEND_ROOM_FAILED,
      'C16② 建房 ⇒ 12006（热项取代码默认 false 的证据：启动拉取失败 ⇒ 默认值兜底）');
    const c16Start = compose({}, 'start', 'config-service');
    checks.eq(c16Start.code, 0, 'C16③ start config-service');
    const c16Recover = await pollCreateCode(ErrCode.OK, 70_000, user.accessToken);
    checks.that(c16Recover.ok,
      `C16③ 自愈：≤70s 建房恢复 code 0（无需再重启 room）—— 最后一次 ${JSON.stringify(c16Recover.last)}`);
    await setFriendRooms(false, user.accessToken);            // 收尾

    // ══════════════════════════════════════════════════════════════════════
    // 编排第 6 段（与开关态无关）：C5半 / C6半 / C7 / C14 / C15 / C20
    // ══════════════════════════════════════════════════════════════════════
    step('C5半：真栈 2 例非法 PUT ⇒ 400 且值未变（adminGetConfig 前后对比）');
    const c5Before = await adminGetConfig<AdminConfigData>(admin);
    const c5Bads: ReadonlyArray<[string, unknown]> = [
      ['game.doudizhu.robot.ruleFallback', 'yes'],        // 严格 boolean ⇒ 字符串非法
      ['room.matchScanIntervalMs', 0],      // 整数 0 < n ≤ 600000 ⇒ 0 非法
    ];
    for (const [key, value] of c5Bads) {
      const bad = await adminPutConfig(key, value, admin);
      checks.eq(bad.status, 400, `C5半 非法 PUT ${key}=${JSON.stringify(value)} ⇒ 400（不落库）`);
    }
    const c5After = await adminGetConfig<AdminConfigData>(admin);
    for (const [key] of c5Bads) {
      // 比较整条 `{value, version}`：version 不变更强（证明**没写过**，不是「写了又写回」）。
      checks.eq(
        JSON.stringify(c5After.body?.data?.config?.[key]),
        JSON.stringify(c5Before.body?.data?.config?.[key]),
        `C5半 ${key} 的值与 version 必须原样未变`,
      );
    }

    step('C6半：compose 以 ADMIN_PASSWORD=（空串）重建 config-service ⇒ 账号在库 ⇒ 运行侧口令登录仍 200（⚙️16）');
    // ⚙️16 重写（③ T11；旧形态是「未设口令 ⇒ 管理面整体关闭 ⇒ 登录 404」）：③ 起
    // `ADMIN_PASSWORD` **只在零账号首启**喂 bootstrap（`INSERT` 引导行 `admin`），账号一旦
    // 在库，env 就不再是开关 —— 以空串重建后，**运行侧口令**（建行时用的
    // `ADMIN_PASSWORD`）登录必须**回 200**。「零账号 ⇒ 404」由 config-service 单测钉
    // （conformance 不造空表）。本段仍保留「重建容器 + 就绪 + 还原 + 还原自证」的容器级
    // 骨架：它证的是「env 值变化不影响已建账号的登录」这条新语义。
    const c6Off = compose({ ADMIN_PASSWORD: '' }, 'up', '-d', '--no-deps', 'config-service');
    checks.eq(c6Off.code, 0, 'C6半① 以 ADMIN_PASSWORD= 重建 config-service（显式空串）');
    const c6OffHealth = await waitContainerHealthy('ftl-config-service', 60_000);
    checks.that(c6OffHealth.ok, `C6半① 空 env 形态的 config-service 就绪 —— ${c6OffHealth.last}`);
    const c6Login = await postJson<{ token: string; username: string; role: string }>(
      '/api/admin/login',
      { username: 'admin', password: ADMIN_PASSWORD },
    );
    checks.eq(c6Login.status, 200, 'C6半② 空 env + 账号在库 ⇒ 运行侧口令登录 200（env 不再是开关）');
    checks.eq(c6Login.body?.code, ErrCode.OK, 'C6半② 登录信封 code 0');
    checks.eq(c6Login.body?.data?.username, 'admin', 'C6半② 登录响应 username = "admin"（归一后值）');
    checks.eq(c6Login.body?.data?.role, 'super_admin', 'C6半② 登录响应 role = "super_admin"（引导行角色）');
    const c6Back = compose({ ADMIN_PASSWORD }, 'up', '-d', '--no-deps', 'config-service');
    checks.eq(c6Back.code, 0, 'C6半③ 还原 config-service（ADMIN_PASSWORD=运行侧口令，不带空串）');
    const c6BackHealth = await waitContainerHealthy('ftl-config-service', 60_000);
    checks.that(c6BackHealth.ok, `C6半③ 还原后的 config-service 必须 healthy —— ${c6BackHealth.last}`);
    const c6Relogin = await adminLogin();                     // 抛 = 还原失败；成功 = 自证
    checks.that(c6Relogin.length > 0, 'C6半③ 还原后正确口令可登录（自证还原到位）');

    step('C7：GET /api/config 的 data 键集（排序后）恰好二十一键 + 值类型正确');
    const c7 = await getJson<Record<string, unknown>>('/api/config', user.accessToken);
    checks.eq(c7.body?.code, ErrCode.OK, 'C7 GET /api/config code 0');
    // ② 金币场 T12 同步：3 → 7 键；支付片 T5 同步：7 → 14；广告片 T23 同步：14 → 15；台费阶段 2：派生字段删除后 21 键
    // （§2.5/⚙️11 客户端 21 键，含九裸名——`entryFeePercents` 已删除）。
    checks.eq(
      Object.keys(c7.body?.data ?? {}).sort().join(','),
      'baseScoreLevels,cardCounterEnabled,cardCounterPricePerGameCoins,cardCounterPricePerHourCoins,coinPerYuan,entryMultiplier,freeRoomEnabled,friendRoomEnabled,games,goldRoomEnabled,rechargeEnabled,rechargePackages,reliefAdpid,reliefEnabled,reliefThresholdCoins,version,withdrawDailyMaxCoins,withdrawEnabled,withdrawMaxCoinsPerOrder,withdrawMinCoins,withdrawReAuthEnabled',
      'C7 data 键集（排序后）恰好 21 键（含 cardCounterEnabled）',
    );
    checks.that(
      Array.isArray(c7.body?.data?.baseScoreLevels) && (c7.body!.data!.baseScoreLevels as unknown[]).length > 0 &&
      typeof c7.body?.data?.friendRoomEnabled === 'boolean' &&
      typeof c7.body?.data?.freeRoomEnabled === 'boolean' &&
      typeof c7.body?.data?.goldRoomEnabled === 'boolean' &&
      typeof c7.body?.data?.reliefEnabled === 'boolean' &&
      typeof c7.body?.data?.entryMultiplier === 'number' &&
      typeof c7.body?.data?.rechargeEnabled === 'boolean' &&
      typeof c7.body?.data?.withdrawEnabled === 'boolean' &&
      typeof c7.body?.data?.coinPerYuan === 'number' &&
      Array.isArray(c7.body?.data?.rechargePackages) && (c7.body!.data!.rechargePackages as unknown[]).length > 0 &&
      typeof c7.body?.data?.withdrawMinCoins === 'number' &&
      typeof c7.body?.data?.withdrawMaxCoinsPerOrder === 'number' &&
      typeof c7.body?.data?.withdrawDailyMaxCoins === 'number' &&
      typeof c7.body?.data?.version === 'number',
      `C7 值类型正确（两个数组（均非空）/ 六个布尔 / 七个数字）—— 实际 ${JSON.stringify(c7.body?.data)?.slice(0, 200)}`,
    );
    checks.that(
      !('entryFeePercents' in (c7.body?.data ?? {})),
      'C7 派生字段 entryFeePercents 已删除（阶段 2）',
    );

    // 多玩法（S5.1/S7.3）：`games` 两个玩法；ddz 恒开、pdk enabled 读配置（本切片不改开关）。
    const games = (c7.body?.data as any)?.games;
    checks.that(
      games != null && games.doudizhu?.enabled === true && Array.isArray(games.doudizhu?.baseScoreLevels),
      'C7 games.doudizhu.enabled=true 且带档位表（旧顶层 baseScoreLevels 不迁移）',
    );
    checks.that(
      games != null && typeof games.paodekuai?.enabled === 'boolean' &&
        Array.isArray(games.paodekuai?.supportedPlayerCounts) &&
        Array.isArray(games.paodekuai?.baseScoreLevels),
      'C7 games.paodekuai 携带 enabled/supportedPlayerCounts/baseScoreLevels',
    );

    step('C14：匿名 /api/config ⇒ 401；匿名 /api/admin/config ⇒ 401');
    const c14A = await getJson('/api/config');
    checks.eq(c14A.status, 401, 'C14① 匿名 GET /api/config ⇒ 401');
    checks.eq(c14A.body?.code, ErrCode.UNAUTHENTICATED, 'C14① 401 的信封码 = 10002（UNAUTHENTICATED）');
    const c14B = await getJson('/api/admin/config');
    checks.eq(c14B.status, 401, 'C14② 匿名 GET /api/admin/config ⇒ 401');

    step('C15：5×错口令 ⇒ 第 6 次 429 ⇒ 正确口令也 429（桶达界）⇒ 清桶 ⇒ 正确口令 200（自证清干净）');
    // ③ T11 起 body = `{username:'admin', password}`（账号登录形态）；错口令尝试**必须带
    // 非空 username**，否则会打在形状闸（400 不计数）而非口令比较（401 计数）。
    for (let i = 0; i < 5; i++) {
      const wrong = await postJson('/api/admin/login', { username: 'admin', password: `wrong-${i}` });
      checks.eq(wrong.status, 401, `C15 第 ${i + 1} 次错口令 ⇒ 401（≤5 次内均 401）`);
    }
    const c15Sixth = await postJson('/api/admin/login', { username: 'admin', password: 'wrong-5' });
    checks.eq(c15Sixth.status, 429, 'C15 第 6 次 ⇒ 429（失败计次达界）');
    const c15Locked = await postJson('/api/admin/login', { username: 'admin', password: ADMIN_PASSWORD });
    checks.eq(c15Locked.status, 429, 'C15 桶达界 ⇒ 正确口令也 429（检查在口令比较之前）');
    // 🧹 清桶（**必须**做，不能只等 5min 窗口）：CI 串行同 runner IP，残留会污染后续切片与浏览器探针。
    // 形态 = `docker compose exec -T redis redis-cli --scan` + `DEL`（走 lib/redis 的共享助手；
    // 空结果安全：扫不到就不发 DEL）。「清干净」由下一条 200 **自证**。
    const c15Scan = redisRaw(['--scan', '--pattern', 'ratelimit:admin-login-fail:*']);
    const c15Keys = c15Scan.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
    if (c15Keys.length > 0) {
      const c15Del = redisRaw(['DEL', ...c15Keys]);
      info(`C15 清桶：删除 ${c15Keys.length} 个键（DEL ⇒ ${redisReplyText(c15Del) || '（无回复）'}）`);
    } else {
      info('C15 清桶：--scan 未扫到键（空结果容错 —— 仍以下面这条 200 自证）');
    }
    const c15Relogin = await postJson('/api/admin/login', { username: 'admin', password: ADMIN_PASSWORD });
    checks.eq(c15Relogin.status, 200, 'C15 清桶后正确口令 ⇒ 200（自证清干净）');

    step(`C20：经门口（http://localhost:${EDGE_HTTP_PORT}）GET /admin/ 与 /admin（逐跳跟随）⇒ 200 + 标志串`);
    // ── C20 **前置**：门口随取随起（结构性必需；2026-10-02 T18 全量首跑暴露）─────────────
    // ⚠️ 为什么必须有：`slice-07.3-edge` 按设计在收尾 `--profile edge rm -sf edge` 删掉门口，
    //    且其收尾断言**要求无残留**（那是它的生命周期判据 —— 不动它）；而 `--list` 全序里
    //    07.3 之后到本片之间（slice-12 / 07.4 / 07.5 / 13）**没有任何一步**重启门口 ⇒ 按序
    //    全量跑到 C20 时门口**必然不在**（实测 8080 ECONNREFUSED，**环境无关**，CI 同序同红）。
    //    处置（裁定 2026-10-02）= **切片自带前置**：C20 之前把门口起回来。手法先例 =
    //    `slice-07.3-edge.ts:177`（同 `--profile edge` + `--no-deps` + `--wait`）。
    // ⚠️ 与先例的**两处有意差异**（读码后的适配，非照抄）：
    //    ① 只点名 `edge`（先例点名 `api-gateway edge`）：先例要的是把网关重建成
    //       **TRUST_PROXY 注入态**（B0 的语义）；本片**不得**碰网关的注入/默认态（本片的
    //       卫生纪律）—— `--no-deps` 下运行中的网关原样不动。
    //    ② **不带 `--build`**：镜像新鲜度是 B0 / 起栈步的职责（全序里 07.3 刚构建过）；真重建
    //       含镜像内 H5 构建（实测 203.7s），会超过本文件 `compose()` 的 180s 进程级上界
    //       （先例是**有意**不设该上界的）⇒ 带上它反而可能杀掉前置本身。镜像全缺时 compose
    //       会自行构建（起栈脚本 / 07.3 已保证它存在）。
    // ⚠️ 幂等：门口已在 ⇒ `up -d` 是 no-op（单跑/乱序照样绿）。**不做收尾删除**：建/删的
    //    生命周期归 07.3；本片只保证在场（残留由 07.3 开头的 `docker rm -f` 与起栈脚本的
    //    `down` 清理）。
    const c20Edge = compose(
      { EDGE_HTTP_PORT, EDGE_HTTPS_PORT },
      '--profile', 'edge', 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '300', 'edge',
    );
    checks.eq(c20Edge.code, 0,
      `C20 前置：门口随取随起（--profile edge up -d --no-deps --wait edge）—— 输出尾部：${tailOut(c20Edge.out)}`);
    const c20A = await edgeGetFollowing('/admin/');
    checks.eq(c20A.status, 200, `C20① GET /admin/ ⇒ 200（链：${c20A.chain.join(' | ')}）`);
    checks.that(c20A.body.includes('FTL 管理面'),
      `C20① 响应含管理页标志串「FTL 管理面」—— 实际前 120 字：${c20A.body.slice(0, 120)}`);
    const c20B = await edgeGetFollowing('/admin');
    checks.eq(c20B.status, 200, `C20② GET /admin（301 跟随）⇒ 200（链：${c20B.chain.join(' | ')}）`);
    checks.that(c20B.body.includes('FTL 管理面'),
      `C20② 响应含管理页标志串「FTL 管理面」—— 实际前 120 字：${c20B.body.slice(0, 120)}`);

    // ══════════════════════════════════════════════════════════════════════
    // 编排第 7 段：统一收尾（规格 §3 末：复原生产默认；C11 只管 fresh——此收尾是卫生，不承担判据）
    // ══════════════════════════════════════════════════════════════════════
    step('统一收尾：setFriendRooms(false)');
    await setFriendRooms(false, user.accessToken);
    return checks;
  } finally {
    // ── 注入态**兜底复原**（成败皆然）────────────────────────────────────────
    // 正常路径上四种注入态已各段自复原（room 的 CONFIG_SYNC_* ×2 / config 的空口令 / config 停着）；
    // 这里只兜「前文抛错或被中断」——本片对真栈有副作用，CI 又是**同一栈串行**跑全部切片，
    // 一条也不许泄漏（同族纪律 = slice-07.3 的网关注入复原）。
    // ⚠️ 整段吞错只 info：兜底复原**不许**顶掉原始结论（原始错误照常向上抛）。
    try {
      compose({ CONFIG_SYNC_DISABLE_PUSH: '', CONFIG_SYNC_SAFETY_NET_MS: '' }, 'up', '-d', '--no-deps', 'room-service');
      compose({ ADMIN_PASSWORD }, 'up', '-d', '--no-deps', 'config-service');
      compose({}, 'start', 'config-service');
      await setFriendRooms(false, user.accessToken);
    } catch (err) {
      info(`兜底复原失败（不影响原始结论，手动检查 room/config 的注入态）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
