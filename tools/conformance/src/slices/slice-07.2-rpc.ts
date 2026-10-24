/**
 * 切片 P4（N20）conformance：**§4.2 的 TCP RPC 迁移**的在线判据。
 *
 * 计划：`docs/superpowers/plans/2026-09-16-slice-p4-tcp-rpc-migration.md` **Task 6 Step 2**；
 * 权威依据：裁决 **R218–R226** + `docs/design.md` **§2.1 / §2.3 / §4.1 / §4.2 / §4.3**。
 *
 * 六组判据（全部**正向**为主 —— 切片 11 教训第 7 条：「机械扫描没扫到坏东西」在旧栈上
 * 也可能成立，判别力只能来自「**必须发生** X」）：
 *
 *  1. `listen` **监听方真的存在**：`game.snapshot`（3103）对不存在的房间必须得到一个
 *     **业务信封**（R220 的 `{ok:false,…}`），**而不是** `ECONNREFUSED`。
 *     旧栈 RED 原文（当时那台 Linux 开发机实测，**措辞按实测**）：`RPC 传输层故障（timeout）：localhost:3103
 *     pattern=game.snapshot 耗时 3004ms —— 超过 3000ms 没有回包`（§4.2 末段的 `[偏差]`：
 *     「三个服务只有 `app.listen`，没有任何 `connectMicroservice`」）。
 *     ⚠️ 计划预言的是 `connect ECONNREFUSED 127.0.0.1:3103` —— 该环境里 `127.0.0.1` 的 SYN 被**丢弃**
 *     （不是 RST）⇒ 表现为**超时**；⚠️ 出现哪种失败形态**取决于环境**（Windows 上恰好相反）。
 *     归因不变（3103 无监听），见**执行期裁决 R229** / 规格 **§3.5**。
 *     正向的那一半更重要：`game.start` 建局后 `game.snapshot` 必须回 `{ok:true}` + 完整会话。
 *     不存在房间的期望码是 **12001**（`ROOM_NOT_FOUND`，R230 实测），并另有「必须是 5 位数字」的形态判据。
 *
 *  2. `view` **两条通道同一真源**（R224）：走真实 WS 打出一局，再分别用 **RPC `game.view`**
 *     与 **经网关 `GET /api/games/<code>`** 取调用者自己的视图 ⇒ `hand` **逐张相等**。
 *     旧栈 RED：RPC 那条通道连不上（当时那台机器形态是 `timeout`；⚠️ 出现哪种失败形态**取决于环境** —— 见 R229 / 规格 §3.5）。
 *
 *  3. `gone` **被删的内部 HTTP 路由确实没了**（R218 的**结构性**判据）：直连 3003/3005
 *     打 `POST /api/games`、`GET /api/games/<code>/snapshot`、`POST /api/robots/{acquire,release,decide}`
 *     ⇒ **404**。旧栈 RED 原文（2026-09-16 实测）：
 *       `POST /api/games` → **201** `{"code":0,"data":{"roomCode":…}}`（**用合法 body**，
 *       空 body 只会拿到 DTO 的 400 —— 那不是判别力）；
 *       `GET /api/games/<code>/snapshot` → **200** + 完整会话（含三家 `hand`）；
 *       `POST /api/robots/acquire` → **200** `{"bots":[…]}`；`release` → **200**；`decide` → **500**。
 *
 *  4. `idem` **`robot.acquire` 走 RPC 且幂等**（R201，把 `slice-11` 第 6 组的判据换载体）：
 *     同一 `{roomCode, seats:[1]}` 调两次 ⇒ 同一 `botId`/`displayId`，且 `ZCARD bot:pool:doudizhu`
 *     不净增。旧栈 RED：连不上 3105（旧栈这条路是 HTTP，本组**只**看 TCP）。
 *
 *  5. `probe` **探针的判别力自证**（R115）：对**运行时发现**的回 RST 端点必须
 *     `ECONNREFUSED` 且**在 1s 内**返回（不是挂到超时）；对**默认 `127.0.0.1:1`** 只要求
 *     **在超时窗口内失败**（`ECONNREFUSED` 还是 `timeout` 是**环境属性** —— 见 R229 / 规格 §3.5）；
 *     对**不存在的 pattern** 必须拿到服务端的 `err` 原文（`NO_MESSAGE_HANDLER`）而不是超时。
 *     这条在**任何**镜像上都该绿 —— 它是第 1/2/4 组「`ECONNREFUSED` 真的是 `ECONNREFUSED`」的前提。
 *
 *  6. `prod` **生产形态不发布 RPC 端口**（§2.1「不对外暴露」/ R226）：`docker compose
 *     --env-file <空文件> -f docker-compose.yml config --format json` ⇒ game/robot/config
 *     （三个 RPC 监听方）的 `ports` **不含** 3103/3105/3106（本仓形态是**空数组**），
 *     `expose` **含**它们。
 *     （片⑦ T13 换键：第三个监听方由 `user-service` 3101 换成 **`config-service` 3106**
 *     —— 原 3101 面随 user 的 RPC 监听退役，逐条**改而不删**。）
 *     与 `slice-07.2-deploy` 第 ① 步同源（那里钉「生产形态**只有门口**（edge）发布宿主端口；
 *     `api-gateway` 零发布 + `expose: 3000`」，R1203 —— 原句「只有 api-gateway 发布宿主端口」
 *     已随门口片被替换为 A1/A2）。
 *
 *  7. `pool`  **池索引的**绝对**一致性（R231/R232②，conformance 侧唯一验收判据）**：
 *     `bot:pool:doudizhu` 的**每一个**成员都必须有对应的 `bot:{id}` 记录（`EXISTS == 1`）——
 *     **无悬挂成员**。现场证据（协调者独立复核 + 本切片复现）：`ZCARD=2` 而
 *     `bot-79659432`/`bot-41887b4c` 的 `EXISTS` **都是 0**。
 *     ⚠️ **纯 `redis-cli`，不经 RPC**（R232 的指示）：验收的是**池的一致性**，与传输层无关
 *     ⇒ 它在**当前 master 上就能立刻取到 RED**，不必等后端 Task 1/1b 合并。
 *     ⚠️ **这不是**「池计数没减少」那种**相对量**判据 —— 后者对「池退化成 0/绝对容量丢失」
 *     完全免疫（正是它让 R231 藏着走到今天）。判据以「每个成员都有记录」这个**绝对**性质为准。
 *     ⚠️ 与 `slice-11` 第 5 组的分工：那条钉「一局之后按机器人数**净增**」（业务语义），
 *     本条钉「池索引**自身**不自相矛盾」（结构不变式）。两条都要有。
 *
 * ⚠️ 步骤选择器 `CONFORMANCE_STEPS`（默认=全部，合法 id：`listen,view,gone,idem,probe,prod,pool`）：
 *   这个环境变量可以**只减不增**地选步骤，**不能**放宽任何断言（未知 id 直接抛错）。
 *   **门禁 / 最终判定必须不带它。**
 *
 * ⚠️⚠️ **fail-fast 下的步骤顺序**（`run.js` 第一个红步就终止整条用例，`step()` 的编号 =
 *   执行顺序，**不是**本文件头 1–7 的编号）：
 *
 *   1. `pool`（前置，纯 Redis；标签是「第 2 组」）  2. `probe`（前置，自证；标签是「第 1 组」）
 *   3. `listen`  4. `view`  5. `gone`  6. `idem`  7. `prod`
 *
 *   ⚠️ 上面这行**就是**执行顺序（`runs(...)` 在文件里的排列）；**不要**按「第 N 组」的 N 去读顺序 ——
 *   两组前置的**标签编号**（1=probe / 2=pool）与它们的**执行次序**（先 pool 后 probe）**故意**不同，
 *   因为标签按「自证强度」排（探针能不能看见网络，是更基础的那条），而执行按「谁更早拿到现场」排。
 *   协调者复核时就是在这里被绊了一下 —— 想读顺序，读这行，不要读 `step()` 的编号。
 *
 *   **为什么把两条前置放到最前**：它们**不依赖后端新代码**（`probe` 只证明「探针真的在等网络」，
 *   `pool` 纯 `redis-cli`），因此在**旧栈上也能跑完并打出通过记录**。若把它们放在会红的
 *   `listen` 之后，旧栈取 RED 时它们的输出**永远看不到** —— 而「探针不是空测」的**唯一**证据
 *   就是那几行 ✅。这是把「前置条件的证明」当成**步骤顺序**问题的处置（R115 / R193③）。
 *
 * ⚠️ **第 5 组的「经网关」那一半在旧栈上也是绿的**（**执行期裁决 R230**，实测）：网关从来没有
 *   这三条路由 —— 带用户 token ⇒ Nest 的 `Cannot POST /api/games` **404**；不带 token ⇒ 网关
 *   自己的 **401**；带内部 token ⇒ 边缘检查 **403**。判别力**全部**在「**直连** 3003/3005」
 *   那一半（旧栈 201/200/200/200/500）+ 「404 的成因是路由不存在」这条**形状**断言
 *   （`Cannot POST` 对比 game-service 自己的 `{code:12001}`）。不要把网关那一半读成判别力。
 *
 * ⚠️ **海森堡**：
 *   - 第 1/2/4 组的 `game.start` / `robot.acquire` 会**真的**建会话/占机器人 ⇒ 房号用
 *     `X72RPC` / `X72RPCQ` / `X72RPCZ` 这种一次性前缀，**避开** `slice-11` 的 `S11IDEM`
 *     （那个房号的池计数是它的判据）。
 *   - 第 2 组（池一致性）本来是**只读**判据，但它要**自证判别力** ⇒ 必须往池里注入一个
 *     **合成成员** `bot-PROBE-R232`（`ZADD` + `SET`，**只碰这一个 id**），跑完在 `finally` 里
 *     清掉，并**断言**清理后 `ZCARD` 回到基线 —— 判据不得污染被观测状态。除此之外
 *     Redis 只**读**（`ZRANGE`/`EXISTS`）；`robot.release` 那一轮（新栈才有）会按 §9.6 归池。
 *   - 环境变量 `DDZ_POOL_KEY` **刻意不提供**：池键是可被测试改写的观测目标，
 *     提供覆盖口等于让人把判据对准一个别的键（R150 的教训：判据不要留后门）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { withEmptyEnvFile } from '../lib/env-file';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type GameSnapshotRequest,
  type GameViewRequest,
  type PlayerView,
  type StartGameRequest,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { HarnessClient } from '../lib/client';
import { getJson, INTERNAL_TOKEN, registerUser, type HarnessUser } from '../lib/http';
import { idempotentAcquireViolations } from '../lib/pool-idempotency';
import {
  GAME_RPC,
  NO_MESSAGE_HANDLER,
  ROBOT_RPC,
  RpcTransportError,
  constructRefusingEndpoint,
  probeClosedPort,
  rpcCall,
  type RpcEndpoint,
} from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `src/slices/*.ts` 同深度 ⇒ 同一个相对路径；R179）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * 发现一个**本环境确实回 RST** 的端点（本片中立化：不写死地址）。
 *
 * 候选按序探测，取第一个 `kind === 'ECONNREFUSED'` 的：
 *   ① `constructRefusingEndpoint()` —— 构造出的回环端点（覆盖多数环境，含 Windows）；
 *   ② compose 网关 + 一个确定没人听的端口（覆盖回环被黑洞的环境，如 R229 那台）。
 *
 * ⚠️ **一个都找不到 ⇒ 响亮失败**，并打印每个候选的实测形态（kind / code / 耗时）。
 * 不跳过、不假绿（R115）—— 「本环境提供不了该条件」是必须被看见的事实。
 */
async function discoverRefusingEndpoint(
  pattern: string,
  data: unknown,
): Promise<RpcEndpoint> {
  const candidates: RpcEndpoint[] = [await constructRefusingEndpoint()];

  // 候选②：运行时解析 compose 网络网关（**不**硬编码项目名 —— 它随目录名变）。
  try {
    const ls = execFileSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    const net = String(ls)
      .split('\n')
      .map((s) => s.trim())
      .find((n) => n.endsWith('ftl-platform'));
    if (net) {
      const gw = String(
        execFileSync(
          'docker',
          ['network', 'inspect', net, '--format', '{{(index .IPAM.Config 0).Gateway}}'],
          { cwd: REPO_ROOT, encoding: 'utf-8' },
        ),
      ).trim();
      if (gw) candidates.push({ host: gw, port: 3999 });
    }
  } catch {
    // 候选②是兜底：解析失败就只用候选①，但下面若①也不回 RST 会**响亮失败**并列出候选，
    // 所以这里吞掉异常不会造成静默跳过。
  }

  const observed: string[] = [];
  for (const ep of candidates) {
    try {
      const r = await probeClosedPort(pattern, data, 3000, ep);
      observed.push(`${ep.host}:${ep.port} → kind=${r.kind} code=${String(r.code)} ${r.elapsedMs}ms`);
      if (r.kind === 'ECONNREFUSED') return ep;
    } catch (err) {
      observed.push(`${ep.host}:${ep.port} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new ConformanceError(
    '本环境找不到「回 RST」的端点 —— 逐候选实测：\n  ' +
      observed.join('\n  ') +
      '\n（设计上要求本环境提供至少一个这样的端点；不跳过、不假绿。' +
      '⚠️ 上面列出的候选未必有两条：候选②（compose 网关）只在 docker 解析到 ' +
      '`ftl-platform` 网络时才加入 —— 解析失败或没有该网络时它就不在其中（缺席原因即此，不是跳过）。' +
      '若上面列出的候选都给 timeout，说明本环境已试的地址都不回 RST（回环/容器网关被黑洞），' +
      '需再补候选。）',
  );
}

/** §9.6 / R201 的池键（键表 §10.1；S2 起规范玩法 id = `doudizhu`，旧 `ddz` 只读）。 */
const GAME_TYPE = 'doudizhu';
const POOL_KEY = `bot:pool:${GAME_TYPE}`;

/** §9.2/E9：机器人对外 id 与人类同构的**唯一**形状（与 `slice-11` 同值）。 */
const DISPLAY_ID = /^p_[0-9A-Za-z]{8}$/;

/** 第 3 组（listen）的探针房号（**必须**不存在会话）。 */
const ABSENT_ROOM = 'NOPE72';

/** 第 2/3 组的一次性房号前缀（避开 `slice-11` 的 `S11IDEM`）。 */
const PROBE_ROOM = 'X72RPC';
/** 第 6 组（idem）的房号（避开 `S11IDEM`）。 */
const IDEM_ROOM = 'X72RPCQ';

/** 第 1 组（前置 probe）：`ECONNREFUSED` 必须在 **1s** 内回来（挂住 = 探针没在等网络/端口被丢弃）。 */
const REFUSED_WINDOW_MS = 1000;

/** 步骤 id（见文件头 `CONFORMANCE_STEPS`）。 */
const ALL_STEPS = ['listen', 'view', 'gone', 'idem', 'probe', 'prod', 'pool'] as const;
type StepId = (typeof ALL_STEPS)[number];

/**
 * 牌 → 规范键。R696：牌是 `{r, s}`，用 `"r-s"` 作为它的身份。
 * 已经是键（`string`）时原样返回 —— **本函数必须幂等**：有调用方先把结果存起来
 * （`const aHand = sorted(...)`）再传回 `sameHand()`，也有的读它的 `.length`。
 */
const cardKey = (c: unknown): string =>
  typeof c === 'string' ? c : `${(c as { r: number; s: number }).r}-${(c as { r: number; s: number }).s}`;

/**
 * 手牌比较一律排序后逐张比 —— 出站顺序不是契约（§4.2）。
 *
 * ⚠️ **R696 的关键修正** —— 旧实现是 `.map(Number).sort((a, b) => a - b)`。
 * 牌变成 `{r, s}` 之后 `Number({r,s})` = **`NaN`** ⇒ 排序结果恒为 `[NaN, NaN, ...]`
 * ⇒ `JSON.stringify` 得 `"[null,null,...]"` ⇒ **任意两副同长度手牌都被判为「相等」**。
 *
 * 后果分两种，方向相反且**都危险**：
 *  - `!sameHand(a, b)`（「两副牌必须不同」）⇒ 恒 `false` ⇒ **恒红**（看得见）；
 *  - `sameHand(a, b)`（「两副牌必须相同」）⇒ 恒 `true` ⇒ **假绿** —— 这半边才藏得住缺陷
 *    （例如「他人手牌泄漏进我的视图」这类断言会静默通过）。
 *
 * ⇒ 按 `(r, s)` 逐张比较 —— 那才是牌的真实身份。
 */
function sorted(cards: unknown): string[] {
  if (!Array.isArray(cards)) return [];
  return (cards as unknown[]).map(cardKey).sort();
}

function sameHand(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function describe(cards: unknown): string {
  return Array.isArray(cards) ? JSON.stringify(sorted(cards)) : String(cards);
}

/** 传输层故障的**原文**（RED 汇报要逐字引用，所以一律走到这里取 message）。 */
function transport(err: unknown): RpcTransportError {
  if (err instanceof RpcTransportError) return err;
  throw err;
}

/** 5 位数字错误码（§11.1）。「服务端回了信封」的**唯一**稳定判据。 */
function isBusinessCode(code: unknown): boolean {
  return typeof code === 'number' && Number.isInteger(code) && code >= 10001 && code <= 19999;
}

/** `bot:{botId}` 的记录键（`robot.pool.ts` 的 `botKey()`）。 */
function botKey(botId: string): string {
  return `bot:${botId}`;
}

/**
 * 只读/可写的 `redis-cli`（照 `slice-11-robot-system.ts` 的 `redisCli` 与
 * `slice-07.2-deploy.ts` 的 `spawnSync` 手法）。
 *
 * ⚠️ `-T` 必须有（不分配 TTY；无 TTY 环境下缺它会挂住），`
` 一律 trim
 * （`docker compose exec` 在部分实现里给每行补 `
`）。
 */
function redisCli(args: string[]): string {
  const res = spawnSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  if (res.status !== 0) {
    throw new ConformanceError(
      `redis-cli ${args.join(' ')} 失败（退出码 ${res.status}）：${String(res.stderr ?? '').trim()}`,
    );
  }
  return String(res.stdout ?? '');
}

/** `ZRANGE bot:pool:doudizhu 0 -1`（键不存在 ⇒ `[]`）。 */
function poolMembers(): string[] {
  return redisCli(['ZRANGE', POOL_KEY, '0', '-1'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `EXISTS bot:{id}` ⇒ 该机器人的**记录**是否还在。 */
function recordExists(botId: string): boolean {
  return redisCli(['EXISTS', botKey(botId)]).trim() === '1';
}

/**
 * R231/R232② 的**核心谓词**：返回「索引里有、记录却不存在」的悬挂成员清单。
 *
 * 这是**绝对**性质（每个成员都必须有记录），**不是**「池计数没减少」那种相对量判据 ——
 * 后者对「池退化成 0 / 绝对容量静默丢失」完全免疫（正是它让 R231 藏到今天）。
 */
function danglingPoolMembers(members: string[] = poolMembers()): string[] {
  return members.filter((botId) => !recordExists(botId));
}

/**
 * 渲染**生产形态**的 compose 配置（与 `slice-07.2-deploy` 逐字同形：两处环境隔离）。
 *
 * `--env-file <空文件>` 隔离仓库 `.env`；从子进程 env 剔除 `INTERNAL_SERVICE_TOKEN`
 * （shell 环境优先级高于 `--env-file`，R147）。少了任一处，判据就**不确定**。
 */
function prodConfig(): any {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'INTERNAL_SERVICE_TOKEN'),
  );
  const out = withEmptyEnvFile((envFile) =>
    execFileSync(
      'docker',
      ['compose', '--env-file', envFile, '-f', 'docker-compose.yml', 'config', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf-8', env, maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  return JSON.parse(out);
}

/** 一条 `ports` 条目的 `published`（compose config 的 JSON 里是数字）。 */
function publishedPorts(config: any, service: string): string[] {
  return (config.services?.[service]?.ports ?? []).map((p: any) => String(p.published ?? p));
}

/** 一条 `expose` 条目（`config --format json` 里 `expose` 是**字符串**数组）。 */
function exposedPorts(config: any, service: string): string[] {
  return (config.services?.[service]?.expose ?? []).map((p: any) => String(p));
}

export async function runSlice072Rpc(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  const only = process.env.CONFORMANCE_STEPS;
  const selected = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
  if (selected) {
    const unknownSteps = [...selected].filter((s) => !(ALL_STEPS as readonly string[]).includes(s));
    if (unknownSteps.length > 0) {
      throw new ConformanceError(
        `CONFORMANCE_STEPS 里有未知步骤：${unknownSteps.join(', ')}（合法值：${ALL_STEPS.join(', ')}）`,
      );
    }
  }
  const runs = (id: StepId): boolean => selected === undefined || selected.has(id);

  let primary: HarnessUser | undefined;
  const ensurePrimary = async (): Promise<HarnessUser> => (primary ??= await registerUser(0));

  try {
    // ── 2) 池索引的**绝对**一致性（R231/R232②）—— **前置**（纯 Redis，旧栈也跑得动）──
    if (runs('pool')) {
      step(
        `第 2 组（前置）R231/R232②：\`${POOL_KEY}\` 的**每一个**成员都必须有对应的 \`bot:{id}\` 记录` +
          '（`EXISTS == 1`，**无悬挂成员**）—— 池索引自身不得自相矛盾',
      );
      info('⚠️ **纯 `redis-cli`，不经 RPC**（R232 的指示）：验收的是池的一致性，与传输层无关 ⇒');
      info('   在**当前 master** 上就能立刻取到 RED（`CONFORMANCE_STEPS=pool`），不必等后端合并。');
      info('⚠️ 判据是**绝对性质**（「每个成员都有记录」），**不是**「池计数没减少」那种相对量判据 ——');
      info('   后者对「池退化成 0 / 绝对容量静默丢失」完全免疫，正是它让 R231 藏到今天。');

      // ⚠️ **顺序**：探针自证放在**绝对断言之前** —— `run.js` 是 fail-fast，若先跑绝对断言，
      //    旧栈上它会立刻抛出，**自证的输出就看不到**（那正是「这条判据不是空测」的唯一证据）。
      //    自证只碰我们注入的合成 id，跑完把池恢复原状，因此不影响随后绝对断言的现场。

      // ── 判别力自证（R115 + R193③）：先证明**这条判据看得见悬挂** ──
      // 只断言「当前池干净」是没有判别力的：一个永远返回 [] 的探针也能过。
      // 手法：往池里**注入**一个合成成员（只 `ZADD`、不建记录）⇒ 谓词必须看见它；
      //      再补上它的记录 ⇒ 必须消失；最后清理。全程只动那个合成 id，不碰真实机器人。
      const baseline = poolMembers();
      const SYNTHETIC = 'bot-PROBE-R232';
      try {
        redisCli(['ZADD', POOL_KEY, String(Date.now()), SYNTHETIC]);
        const seeded = poolMembers();
        const seededDangling = danglingPoolMembers(seeded);
        info(
          `探针正对照：注入合成成员 ${SYNTHETIC}（只 ZADD、不建记录）⇒ ZCARD=${seeded.length}，` +
            `谓词看见悬挂=${JSON.stringify(seededDangling)}`,
        );
        checks.that(
          seededDangling.includes(SYNTHETIC),
          `探针正对照：注入「索引有、记录无」的成员后，谓词必须把它列进悬挂清单（否则本条是空测）—— ` +
            `实际 dangling=${JSON.stringify(seededDangling)}`,
        );

        // 负对照：补上记录 ⇒ 同一成员必须**不再**算悬挂（证明谓词不是「凡 ZADD 就报」）。
        redisCli([
          'SET',
          botKey(SYNTHETIC),
          JSON.stringify({ botId: SYNTHETIC, displayId: 'p_00000000', roomCode: null, seat: null }),
        ]);
        const withRecord = danglingPoolMembers(poolMembers());
        info(`探针负对照：给 ${SYNTHETIC} 补上记录 ⇒ 悬挂清单=${JSON.stringify(withRecord)}`);
        checks.that(
          !withRecord.includes(SYNTHETIC),
          `探针负对照：记录补齐后，同一成员**不得**再算悬挂（否则谓词只是「池非空就红」）—— ` +
            `实际 dangling=${JSON.stringify(withRecord)}`,
        );
      } finally {
        // 清理探针（只删/只移我们自己注入的那一个 id）。
        redisCli(['ZREM', POOL_KEY, SYNTHETIC]);
        redisCli(['DEL', botKey(SYNTHETIC)]);
      }
      const afterCleanup = poolMembers();
      checks.eq(
        afterCleanup.length,
        baseline.length,
        `探针清理后池成员数回到基线（ZCARD ${baseline.length} → ${afterCleanup.length}）—— ` +
          '判据不得自己污染被观测状态',
      );

      // ── 绝对断言（本组的**真**判据；旧栈上这里确定性红）────────────────
      // 手工复核用的现场（RED 原文里要能看出**哪几个**成员悬挂 —— R179 同族）。
      const members = poolMembers();
      const zcard = members.length;
      const dangling = danglingPoolMembers(members);
      const existsMap = members.map((botId) => `${botId}:${recordExists(botId) ? 1 : 0}`);
      info(`现场：ZCARD=${zcard}，成员=${JSON.stringify(members)}`);
      info(`        逐个 EXISTS：${existsMap.join(', ') || '（池为空）'}`);
      checks.that(
        dangling.length === 0,
        `池里**没有**悬挂成员（索引里有、记录不存在）—— 悬挂 ${dangling.length} 个：` +
          `${JSON.stringify(dangling)}（ZCARD=${zcard}，成员=${JSON.stringify(members)}）`,
      );

      // ── 走一轮 acquire/release，确认它**不会**再造出悬挂成员 ────────
      // ⚠️ 这一段需要 RPC（3105）。旧栈上它会连不上 ⇒ 只作**读数**并**明确跳过**，
      //    绝不把它读成失败：失败的正确归因在第 1/4 组（切片 11 教训第 6 条）。
      const roundTripRoom = 'X72RPCZ';
      const acquired = await rpcCall<{ bots: Array<{ botId: string }> }>(
        ROBOT_RPC,
        RPC_PATTERNS.robotAcquire,
        { roomCode: roundTripRoom, seats: [1] },
      ).catch((err: unknown) => err as Error);
      if (acquired instanceof Error) {
        info(
          `⚠️ 跳过「acquire/release 一轮」的一致性复查：3105 当前连不上（${acquired.message.slice(0, 120)}）。`,
        );
        info('   §4.2 的 TCP 监听方（后端 Task 1b）合并后本段会真正执行；池一致性本身的判据已在上面断言。');
      } else {
        checks.that(acquired.ok, `acquire 必须 ok=true —— 实际 ${JSON.stringify(acquired)}`);
        if (acquired.ok) {
          const botId = acquired.data.bots[0]?.botId;
          info(`acquire（roomCode=${roundTripRoom}）→ botId=${String(botId)}`);
          const midDangling = danglingPoolMembers(poolMembers());
          checks.that(
            midDangling.length === 0,
            `acquire **之后**池里仍不得有悬挂成员（这正是 R231 的现场形态：takeIdle 先 ZREM 再 get，` +
              `取不到就静默吃掉名额）—— 悬挂 ${JSON.stringify(midDangling)}`,
          );
          const released = await rpcCall<{ released: number }>(
            ROBOT_RPC,
            RPC_PATTERNS.robotRelease,
            { botIds: botId ? [botId] : [] },
          ).catch((err: unknown) => err as Error);
          if (released instanceof Error) {
            info(`⚠️ release 调用失败（${released.message.slice(0, 120)}）—— 归池由 slice-11 第 5 组覆盖`);
          } else if (released.ok) {
            info(`release → released=${String((released.data as { released?: number }).released)}`);
            const endMembers = poolMembers();
            const endDangling = danglingPoolMembers(endMembers);
            info(`release 之后：ZCARD=${endMembers.length}，成员=${JSON.stringify(endMembers)}，悬挂=${JSON.stringify(endDangling)}`);
            checks.that(
              endDangling.length === 0,
              `release **之后**池里仍不得有悬挂成员 —— 悬挂 ${JSON.stringify(endDangling)}`,
            );
            // 正对照（R115）：`release` 真的把机器人放回了池 —— 否则上面的「零悬挂」是空测。
            checks.that(
              endMembers.length > 0,
              `release 之后池**非空**（正对照：证明归池真的发生了，否则「零悬挂」可能只是池为空）—— ` +
                `实际 ZCARD=${endMembers.length}`,
            );
          }
        }
      }
    }

    // ── 1) 探针的判别力自证（R115）—— **前置**，见文件头「fail-fast 下的步骤顺序」──
    if (runs('probe')) {
      step('第 1 组（前置）R115：探针**真的在等网络** —— 未监听地址必须失败（RST ⇒ ECONNREFUSED；黑洞 ⇒ 超时），不存在的 pattern 必须拿到 err');
      info('这条在**任何**镜像上都该绿：它是第 1/2/4 组「那个异常真的是连不上」的前提。');
      info('若这条红了，说明探针坏了 —— 那时第 3 组的红**不能**被读成「服务没起」。');
      info('');
      info('⚠️ 执行期发现（R229）：「连不上」有**两种**失败形态 ——');
      info('   ① 对端回 RST ⇒ `ECONNREFUSED`，1–2ms；');
      info('   ② SYN 被**丢弃** ⇒ 挂到超时窗口。');
      info('   ⚠️ **哪一种出现在哪个地址取决于环境**（R229 的观察只适用于那一台机器；本片在');
      info('      Windows + Docker Desktop 上实测到**相反**的组合）⇒ 本组**运行时发现**回 RST 的端点，');
      info('      不把地址与形态绑死；一个候选都不回 RST 时 discoverRefusingEndpoint 会响亮失败。');

      // ① 本环境**确实回 RST** 的端点（运行时发现，见 discoverRefusingEndpoint）。
      const refusing = await discoverRefusingEndpoint(RPC_PATTERNS.gameSnapshot, {
        roomCode: ABSENT_ROOM,
      } satisfies GameSnapshotRequest);
      const refused = await probeClosedPort(
        RPC_PATTERNS.gameSnapshot,
        { roomCode: ABSENT_ROOM } satisfies GameSnapshotRequest,
        3000,
        refusing,
      );
      info(`对 ${refusing.host}:${refusing.port} 的调用 → kind=${refused.kind}，code=${String(refused.code)}，耗时 ${refused.elapsedMs}ms`);
      info(`  原文：${refused.message}`);
      checks.eq(refused.kind, 'ECONNREFUSED', '回 RST 的地址上的失败类型是 ECONNREFUSED（若报 timeout：该端口可能在「构造」与「探测」之间被别的进程抢占 —— 重跑一次即可确认）');
      checks.eq(refused.code, 'ECONNREFUSED', '原始错误码逐字是 ECONNREFUSED');
      checks.that(
        refused.elapsedMs < REFUSED_WINDOW_MS,
        `ECONNREFUSED 必须在 ${REFUSED_WINDOW_MS}ms 内回来（实际 ${refused.elapsedMs}ms）—— ` +
          '挂到超时说明探针没有区分「连不上」与「不响应」',
      );

      // ② 默认 `localhost`（探针实际要打的那个 host）：**出现哪种 errno 取决于环境** ⇒ 只要求
      //    「**在超时窗口内失败**」，不要求具体 errno（那是地址属性，不是缺陷）。
      const localhostProbe = await probeClosedPort(
        RPC_PATTERNS.gameSnapshot,
        { roomCode: ABSENT_ROOM } satisfies GameSnapshotRequest,
        1000,
      );
      info(`对 127.0.0.1:1（timeout=1000ms）的调用 → kind=${localhostProbe.kind}，code=${String(localhostProbe.code)}，耗时 ${localhostProbe.elapsedMs}ms`);
      info(`  原文：${localhostProbe.message}`);
      checks.that(
        localhostProbe.kind === 'ECONNREFUSED' || localhostProbe.kind === 'timeout',
        `默认 localhost 上的失败必须是网络层错误（ECONNREFUSED 或 timeout），实际 kind=${localhostProbe.kind}`,
      );
      checks.that(
        localhostProbe.elapsedMs <= 1200,
        `该失败必须在 timeout 窗口附近返回（实际 ${localhostProbe.elapsedMs}ms）—— ` +
          '远超窗口说明 `rpcCall` 的定时器没生效（探针会挂住整个门禁）',
      );
      info('（② 的 kind 因机器而异：回环被黑洞的机器上是 timeout，有 RST 的机器上是 ECONNREFUSED —— 以上面实测到的 kind 为准。）');
      info('  ① 才是「探针能看见 RST」的**判别力**证据，② 是「探针不会静默成功/不会挂住」的证据。）');

      // ③ 不存在的 pattern：Nest 回 `{err: NO_MESSAGE_HANDLER}`（**协议层**，不是业务信封）。
      let unknownErr: RpcTransportError | undefined;
      let unknownOk: unknown;
      try {
        unknownOk = await rpcCall(GAME_RPC, 'no.such.pattern', {}, 3000);
      } catch (err) {
        unknownErr = transport(err);
      }
      info(
        `对 \`no.such.pattern\` 的调用（${GAME_RPC.host}:${GAME_RPC.port}）→ ${
          unknownErr ? `kind=${unknownErr.detail.kind}，原文：${unknownErr.message}` : `ok（!）=${JSON.stringify(unknownOk)}`
        }`,
      );
      checks.that(
        unknownErr !== undefined,
        `不存在的 pattern 必须**失败**（Nest 回 {err}）—— 若它 resolve 了 ${JSON.stringify(unknownOk)}，` +
          '说明探针把不该接受的回包当成成功',
      );
      if (unknownErr !== undefined && unknownErr.detail.kind === 'protocol') {
        // 新栈（3103 在听）——两条都该成立。
        checks.that(
          unknownErr.message.includes(NO_MESSAGE_HANDLER),
          `不存在的 pattern 的失败原文必须含 Nest 的 NO_MESSAGE_HANDLER（${JSON.stringify(NO_MESSAGE_HANDLER)}）—— ` +
            `实际：${unknownErr.message}`,
        );
        checks.eq(unknownErr.detail.kind, 'protocol', '不存在的 pattern 归因为**协议层**（不是连不上/超时）');
      } else {
        // 旧栈（3103 无监听）：这条**注定**是连接层错误。**不**把它读成失败 ——
        // 那会把「本切片第 3 组已经报的缺陷」在这里重复报一次、归因错位（切片 11 教训第 6 条）。
        info(
          `⚠️ 跳过 ③ 的协议层断言：${GAME_RPC.host}:${GAME_RPC.port} 当前**没有监听**` +
            `（kind=${String(unknownErr?.detail.kind)}），'no.such.pattern' 只可能拿到连接层错误。`,
        );
        info('   这条在新栈（后端 Task 1/1b 合并后）才具备判别力；门禁形态下会走上面的 protocol 分支。');
      }
    }

    // ── 3) 监听方存在（正向）──────────────────────────────────────────
    if (runs('listen')) {
      step(
        `第 3 组：\`game-service\` 必须在 ${GAME_RPC.host}:${GAME_RPC.port} 起 TCP RPC 监听 ` +
          `（§2.1 / §4.2 末段），且 \`game.snapshot\` 对不存在的房间回**业务信封**而不是连接错误`,
      );
      info(`pattern 取自 RPC_PATTERNS.gameSnapshot=${RPC_PATTERNS.gameSnapshot}（**不写字面量**）。`);
      info(
        '旧栈 RED 原文（当时那台 Linux 开发机实测，**措辞按实测**）：`RPC 传输层故障（timeout）：localhost:3103 ' +
          'pattern=game.snapshot 耗时 3003ms` —— 计划预言的是 `connect ECONNREFUSED 127.0.0.1:3103`，' +
          '该环境里 127.0.0.1 的 SYN 被丢弃 ⇒ 表现为超时（⚠️ 出现哪种失败形态**取决于环境** —— 见 R229 / 规格 §3.5）。',
      );
      info(
        '§4.2 末段的 `[偏差]` 逐字：「当前三个服务的 main.ts **只有 app.listen(PORT)，没有任何 ' +
          'connectMicroservice**」⇒ 3103 上没有任何监听方，与失败形态无关。',
      );

      const absentReq: GameSnapshotRequest = { roomCode: ABSENT_ROOM };
      let absent = { ok: false as boolean, code: undefined as number | undefined, message: '' };
      try {
        absent = (await rpcCall(GAME_RPC, RPC_PATTERNS.gameSnapshot, absentReq)) as any;
      } catch (err) {
        const t = transport(err);
        throw new ConformanceError(
          `第 3 组失败：对 ${GAME_RPC.host}:${GAME_RPC.port} 的 \`${RPC_PATTERNS.gameSnapshot}\` 调用**根本到不了服务**\n` +
            `  原文：${t.message}\n` +
            `  ⇒ ${GAME_RPC.host}:${GAME_RPC.port} 上没有 TCP RPC 监听（§4.2 要求 connectMicroservice）。`,
        );
      }
      info(
        `对不存在房间 ${ABSENT_ROOM} 的 \`${RPC_PATTERNS.gameSnapshot}\` → ` +
          `ok=${absent.ok}，code=${String(absent.code)}，message=${JSON.stringify(absent.message)}`,
      );
      // 判据的核心是「**服务在听**」：连接被接受 ⇒ handler 被调用 ⇒ 返回 R220 信封。
      // 形态判据（必须回 5 位数字业务码）＋ 口径判据（实测值是 12001，见 R230）两条并列。
      checks.that(!absent.ok, '对不存在房间的 game.snapshot 必须 ok=false（不是抛错、不是空响应）');
      checks.that(
        isBusinessCode(absent.code),
        `game.snapshot 的业务错误码必须是 5 位数字（§11.1；R220 的显式信封），实际 ${JSON.stringify(absent.code)} —— ` +
          '12001/12003/13009 均可接受，但 undefined/字符串不可',
      );
      checks.that(
        absent.code === ErrCode.ROOM_NOT_FOUND,
        `⚠️ 期望值是 §11.2 的 ROOM_NOT_FOUND(12001) —— 执行期实测（R230）：旧栈的 ` +
          `\`GET /api/games/NOPE/snapshot\` 带内部 token 返回 404 {"code":12001,"message":"Game not found"}` +
          `（game.controller 的 HTTP 状态表里 ROOM_NOT_FOUND → 404）。实际 ${String(absent.code)} —— ` +
          `若为 12003/13009，请按执行期裁决 R231+ 回填口径，**不要**放宽成本条`,
      );

      // 正向的那一半（判别力所在）：真的建一局 ⇒ snapshot 必须回完整会话。
      const a = await ensurePrimary();
      const b = await registerUser(1);
      const c = await registerUser(2);
      const roomCode = `${PROBE_ROOM}1`;
      const startReq: StartGameRequest = {
        roomCode,
        baseScore: 100,
        players: [a, b, c].map((u, seat) => ({ id: u.id, seat, isRobot: false })),
      };
      const started = await rpcCall<{ roomCode: string; state: string; version: number }>(
        GAME_RPC,
        RPC_PATTERNS.gameStart,
        startReq,
      );
      info(
        `\`${RPC_PATTERNS.gameStart}\`（roomCode=${roomCode}，3 个人类）→ ` +
          `ok=${started.ok}，data=${JSON.stringify(started.ok ? started.data : undefined)}`,
      );
      checks.that(started.ok, `game.start 必须回 ok=true（§4.2 GameStartedResponse）—— 实际 ${JSON.stringify(started)}`);
      if (!started.ok) throw new ConformanceError(`第 3 组：game.start 失败 ${JSON.stringify(started)}`);
      checks.eq(started.data.roomCode, roomCode, 'game.start 的 data.roomCode 就是请求里的房号');

      const snap = await rpcCall<{ roomCode: string; players?: Array<{ id: string; hand?: unknown[] }> }>(
        GAME_RPC,
        RPC_PATTERNS.gameSnapshot,
        { roomCode } satisfies GameSnapshotRequest,
      );
      info(
        `\`${RPC_PATTERNS.gameSnapshot}\`（roomCode=${roomCode}）→ ok=${snap.ok}，` +
          `players=${snap.ok ? JSON.stringify((snap.data.players ?? []).map((p) => ({ id: p.id, hand: sorted(p.hand).length }))) : '—'}`,
      );
      checks.that(snap.ok, 'game.snapshot 对**存在**的房间必须 ok=true（§4.2：返回完整 GameSession）');
      if (!snap.ok) throw new ConformanceError(`第 3 组：game.snapshot 失败 ${JSON.stringify(snap)}`);
      checks.eq(snap.data.roomCode, roomCode, 'game.snapshot 的 data.roomCode');
      checks.eq(
        (snap.data.players ?? []).length,
        3,
        'game.snapshot 返回完整会话（3 名玩家）—— 这正是「仅限服务间」的那条通道（§4.2 逐字）',
      );
      info('（该会话留在 Redis 的 game:session: 前缀下，与真实对局同生命周期；不额外清理。）');
    }

    // ── 4) 两条通道同一真源（R224）─────────────────────────────────────
    if (runs('view')) {
      step(
        `第 4 组 R224：\`${RPC_PATTERNS.gameView}\`（TCP ${GAME_RPC.port}）与经网关 ` +
          '`GET /api/games/<code>` 必须给出**同一份**调用者视图（hand 逐张相等）',
      );
      info('旧栈 RED：走 RPC 的那条通道 `ECONNREFUSED`（3103 无监听）；网关那条照常 200。');
      info('做法：真实 3 人 → room.match → room.join → game.deal（开工那一步在旧栈上就依赖 TCP）。');

      const users: HarnessUser[] = [await ensurePrimary(), await registerUser(1), await registerUser(2)];
      for (const [i, user] of users.entries()) clients.push(await HarnessClient.connect(`R${i}`, user));
      for (const client of clients) {
        // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
        const ack = await client.send('room.match', { mode: 'random', baseScore: 15 });
        if (ack.code !== ErrCode.OK) throw new ConformanceError(`${client.label} room.match 失败：${JSON.stringify(ack)}`);
      }
      const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', 25_000)));
      const roomCode = matched[0]!.payload.roomCode as string;
      info(`已匹配 roomCode=${roomCode}`);
      for (const client of clients) {
        const ack = await client.send('room.join', { roomCode });
        if (ack.code !== ErrCode.OK) throw new ConformanceError(`${client.label} room.join 失败：${JSON.stringify(ack)}`);
      }
      // `game.deal` 的前置就是 room-service → game-service 的 TCP `game.start`：
      // 旧栈上这一步**永远等不到**（这就是本组的 RED 形态之一）。
      const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
      const a = users[0]!;
      const dealHand = sorted((deals[0]!.payload as PlayerView).hand);
      info(`A(${a.id}) 的 game.deal hand=${describe(dealHand)}`);

      const viewReq: GameViewRequest = { roomCode, userId: a.id };
      const viaRpc = await rpcCall<PlayerView>(GAME_RPC, RPC_PATTERNS.gameView, viewReq);
      info(
        `RPC \`${RPC_PATTERNS.gameView}\`（userId=${a.id}）→ ok=${viaRpc.ok}，` +
          `seat=${viaRpc.ok ? String(viaRpc.data.seat) : '—'}，hand=${viaRpc.ok ? describe(viaRpc.data.hand) : '—'}`,
      );
      checks.that(viaRpc.ok, `game.view 必须 ok=true（§4.2 的裁剪视图）—— 实际 ${JSON.stringify(viaRpc)}`);
      if (!viaRpc.ok) throw new ConformanceError(`第 4 组：game.view 失败 ${JSON.stringify(viaRpc)}`);

      // ⚠️ R224：**seat 只能由服务端从 userId 解析**。探针故意**多发**一个 `seat` 字段，
      //    服务端必须无视它 —— 否则调用方就能拿到别人的座位（这正是 R224 要防的）。
      const withSeat = await rpcCall<PlayerView>(GAME_RPC, RPC_PATTERNS.gameView, {
        roomCode,
        userId: a.id,
        seat: (Number(viaRpc.data.seat) + 1) % 3,
      } as unknown as GameViewRequest);
      info(
        `RPC game.view（多塞一个伪造 seat=${(Number(viaRpc.data.seat) + 1) % 3}）→ ok=${withSeat.ok}，` +
          `seat=${withSeat.ok ? String(withSeat.data.seat) : '—'}`,
      );
      checks.that(
        withSeat.ok && Number(withSeat.data.seat) === Number(viaRpc.data.seat),
        `调用方**多带**的 seat 必须被忽略（R224：seat 由服务端从 userId 解析）—— ` +
          `不带=${String(viaRpc.ok ? viaRpc.data.seat : '')}，带了伪造值=${String(withSeat.ok ? withSeat.data.seat : '')}`,
      );

      // 经网关取同一份视图；版本若在两次调用之间前进就重取（避免把「时刻差」读成「真源不同」）。
      let gatewayView: any;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        const res = await getJson<PlayerView>(`/api/games/${roomCode}`, a.accessToken);
        info(
          `经网关 GET /api/games/${roomCode}（第 ${attempts} 次）→ HTTP ${res.status}，` +
            `body=${JSON.stringify(res.body).slice(0, 200)}`,
        );
        checks.eq(res.status, 200, '经网关 GET /api/games/<code> 的 HTTP 状态');
        checks.eq(res.body?.code, ErrCode.OK, '经网关 GET /api/games/<code> 的 body.code');
        gatewayView = res.body?.data;
        if (Number(gatewayView?.version) === Number(viaRpc.data.version) || attempts >= 4) break;
        info(`版本前进（${String(viaRpc.data.version)} → ${String(gatewayView?.version)}）⇒ 重取`);
        await sleep(200);
      }
      info(
        `网关通道：seat=${String(gatewayView?.seat)}、hand=${describe(gatewayView?.hand)}、version=${String(gatewayView?.version)}；` +
          `RPC 通道：seat=${String(viaRpc.data.seat)}、hand=${describe(viaRpc.data.hand)}、version=${String(viaRpc.data.version)}`,
      );
      checks.eq(
        Number(gatewayView?.seat),
        Number(viaRpc.data.seat),
        '两条通道给出**同一个** seat（同一真源的第一半）',
      );
      checks.that(
        sameHand(gatewayView?.hand, viaRpc.data.hand),
        `两条通道给出**逐张相等**的 hand（同一真源；网关=${describe(gatewayView?.hand)}，RPC=${describe(viaRpc.data.hand)}）`,
      );
      checks.that(
        sameHand(viaRpc.data.hand, dealHand) || sorted(viaRpc.data.hand).length > dealHand.length,
        `RPC 视图的 hand 与发牌一致，或已多拿底牌（叫抢推进）—— 发牌 ${describe(dealHand)}，现在 ${describe(viaRpc.data.hand)}`,
      );
    }

    // ── 5) 被删的内部 HTTP 路由确实没了（R218 的结构性判据）────────────
    if (runs('gone')) {
      step('第 5 组 R218：被 TCP 取代的**内部 HTTP 路由**直连 3003/3005 必须 404（旧栈 201/200/500）');
      info('旧栈 RED 原文（2026-09-16 实测、主检出容器）：');
      info('  direct3003 POST /api/games（**合法 body**）  → 201 {"code":0,"data":{"roomCode":"X72RP1",…}}');
      info('  direct3003 GET  /api/games/X72RP1/snapshot   → 200 {"code":0,"data":{…三家 hand…}}');
      info('  direct3005 POST /api/robots/acquire           → 200 {"bots":[{"botId":"bot-…","displayId":"p_…"}]}');
      info('  direct3005 POST /api/robots/release           → 200 {"released":0}');
      info('  direct3005 POST /api/robots/decide            → 500 {"statusCode":500,"message":"Internal server error"}');
      info('⚠️ 经网关那一半在旧栈上**也是 404**（网关从来没有这三条路由；带内部 token 会被边缘检查 403）——');
      info('   判别力在「**直连**」那一半 + 「404 的成因是路由不存在」的形状断言（见文件头）。');
      info('⚠️ POST /api/games 必须用**合法 body**：空 body 在旧栈上只得 DTO 的 400，那不是「路由已删」的证据。');

      const a = await ensurePrimary();
      const b = await registerUser(1);
      const c = await registerUser(2);
      const roomCode = `${PROBE_ROOM}2`;
      const startBody: StartGameRequest = {
        roomCode,
        baseScore: 100,
        players: [a, b, c].map((u, seat) => ({ id: u.id, seat, isRobot: false })),
      };

      // 直连 3003 的三条（用**真实**内部 token —— 否则 401 是中间件而不是「路由已删」）。
      const directCases: Array<{ label: string; ep: RpcEndpoint; method: string; path: string; body?: unknown }> = [
        { label: 'direct3003 POST /api/games', ep: { host: 'localhost', port: 3003 }, method: 'POST', path: '/api/games', body: startBody },
        { label: `direct3003 GET /api/games/${roomCode}/snapshot`, ep: { host: 'localhost', port: 3003 }, method: 'GET', path: `/api/games/${roomCode}/snapshot` },
        { label: 'direct3005 POST /api/robots/acquire', ep: { host: 'localhost', port: 3005 }, method: 'POST', path: '/api/robots/acquire', body: { roomCode, seats: [1] } },
        { label: 'direct3005 POST /api/robots/release', ep: { host: 'localhost', port: 3005 }, method: 'POST', path: '/api/robots/release', body: { roomCode, botIds: ['bot-00000000'] } },
        { label: 'direct3005 POST /api/robots/decide', ep: { host: 'localhost', port: 3005 }, method: 'POST', path: '/api/robots/decide', body: { roomCode, botId: 'bot-00000000' } },
      ];
      for (const kase of directCases) {
        const res = await directRaw(kase.ep, kase.method, kase.path, kase.body, a.id);
        info(`${kase.label} → HTTP ${res.status}，body=${res.text.slice(0, 140)}`);
        checks.eq(res.status, 404, `${kase.label} 的 HTTP 状态（R218：这条路由**整条删除**）`);
        // 形状断言：404 必须来自「**路由不存在**」，而不是「参数校验失败」「内部错误」等别的成因。
        checks.that(
          !res.text.includes('"code":10001') && !res.text.includes('Internal server error'),
          `${kase.label} 的 404 不得是 DTO 校验错误或 500 的伪装（body 原文见上）`,
        );
      }

      // 经网关：同一批路由（对比「直连」那一半）。
      const gatewayCases: Array<{ label: string; method: 'GET' | 'POST'; path: string; body: unknown }> = [
        { label: 'GW POST /api/games', method: 'POST', path: '/api/games', body: startBody },
        { label: `GW GET /api/games/${roomCode}/snapshot`, method: 'GET', path: `/api/games/${roomCode}/snapshot`, body: undefined },
        { label: 'GW POST /api/robots/acquire', method: 'POST', path: '/api/robots/acquire', body: { roomCode, seats: [1] } },
        { label: 'GW POST /api/robots/release', method: 'POST', path: '/api/robots/release', body: { roomCode, botIds: [] } },
        { label: 'GW POST /api/robots/decide', method: 'POST', path: '/api/robots/decide', body: { roomCode } },
      ];
      for (const kase of gatewayCases) {
        const res = await gatewayRequest(kase.method, kase.path, kase.body, a.accessToken);
        info(`${kase.label} → HTTP ${res.status}，body=${res.text.slice(0, 140)}`);
        checks.eq(res.status, 404, `${kase.label} 的 HTTP 状态`);
      }
      // 网关的 404 是 Nest 的「无此路由」（`Cannot POST /…`），**不是** game-service 自己的
      // 会话 404（`{code:12001}`）—— 这两者必须分得开，否则「网关没这条路由」会被读成
      // 「路由还在但房间不存在」。
      const gwGone = await gatewayRequest('POST', '/api/games', startBody, a.accessToken);
      checks.that(
        gwGone.text.includes('Cannot POST') || gwGone.text.includes('Not Found'),
        `网关侧 404 的成因必须是「网关无此路由」（Nest 的 \`Cannot POST\`），实际 ${gwGone.text.slice(0, 120)}`,
      );
    }

    // ── 6) robot.acquire 走 RPC 且幂等（R201 换载体）──────────────────
    if (runs('idem')) {
      step(
        `第 6 组 R201：\`${RPC_PATTERNS.robotAcquire}\`（TCP ${ROBOT_RPC.port}）对同一 ` +
          `\`{roomCode:'${IDEM_ROOM}', seats:[1]}\` 调两次 ⇒ 同一 bot + 绝对性质` +
          '（窗口内不新增池成员 / 该 bot 不回池 / 无悬挂成员）',
      );
      info('旧栈 RED：`ECONNREFUSED`（3105 无监听）—— 旧栈这条路是 `POST /api/robots/acquire`（HTTP）。');
      const req = { roomCode: IDEM_ROOM, seats: [1] };

      const first = await rpcCall<{ bots: any[] }>(ROBOT_RPC, RPC_PATTERNS.robotAcquire, req);
      info(`第 1 次 acquire → ok=${first.ok}，data=${JSON.stringify(first.ok ? first.data : first).slice(0, 200)}`);
      checks.that(first.ok, `robot.acquire 必须 ok=true —— 实际 ${JSON.stringify(first)}`);
      if (!first.ok) throw new ConformanceError(`第 6 组：robot.acquire 失败 ${JSON.stringify(first)}`);
      const bots1 = first.data?.bots ?? [];
      checks.eq(bots1.length, 1, `第 1 次 acquire 返回 1 个机器人（§4.2）—— 实际 ${JSON.stringify(bots1)}`);
      if (bots1.length === 0) throw new ConformanceError('第 6 组：acquire 没有返回机器人');
      const bot1 = bots1[0]!;
      checks.that(
        typeof bot1.botId === 'string' && String(bot1.botId).startsWith('bot-'),
        `内部 botId 形如 \`bot-<uuid8>\`（R207/E9）：${JSON.stringify(bot1.botId)}`,
      );
      checks.that(
        DISPLAY_ID.test(String(bot1.displayId)) && !String(bot1.displayId).startsWith('bot'),
        `对外 displayId 与人类同构 \`p_<8位>\`（§9.2/E9）：${JSON.stringify(bot1.displayId)}`,
      );

      const poolAfterFirst = poolMembers();
      info(`第 1 次之后 ${POOL_KEY}（ZCARD=${poolAfterFirst.length}）= ${JSON.stringify(poolAfterFirst)}`);

      // ⚠️ R253/R340：**旧等式已删** —— `checks.eq(poolAfterSecond.length, poolAfterFirst.length, …)`
      //    是**相对量**：它实际断言的是「我这两次读池之间没有第三方动过池」
      //    （`releaseRobots()` 是 `void` 异步、`reclaimIdle()` 每 60s 一次、跨运行的晚到 `release`
      //    也会落地 ⇒ **假红**），而它对「池退化成 0 / 容量静默丢失 / 幽灵成员（N22）」
      //    **完全免疫**（P3 教训第 2 条）。
      //    更根本的是：本仓 `acquire()` 的**幂等路径**（`findBound()` 命中即 `continue`）
      //    **完全不碰池** ⇒ 第 2 次 acquire 对池没有副作用 ⇒ 这类「两次 acquire 之间池计数不变」
      //    的判据在本仓**近乎恒真**（P6 实测：旧形态从没抓到过它本该抓的 bug，它的判别力
      //    全部来自「窗口外有人动池」这个假红来源）。
      //    ⇒ 换成下面的**绝对性质**谓词（`idempotentAcquireViolations`，唯一实现在
      //    `../lib/pool-idempotency`，与 `slice-11` 第 6 组共用），窗口 = 第 2 次 acquire 本身。
      //    上面那次 `poolAfterFirst` 读**只作 info**，不再是任何判据的左端。

      // ── 绝对性质（R253/R340）：窗口 = 第 2 次 acquire 本身，不是「读 1 → 读 2」──────────
      //    窗口左端**必须**紧贴这次 acquire 读（就在下面 `rpcCall` 的上一行），否则窗口会横跨
      //    「我两次 acquire 之间的调度/IO 间隙」，那正是旧等式假红的来源（R340/R341 实测：
      //    同一份观测值下宽窗口报 1 条违规、窄窗口 0 条）。
      const poolBeforeSecond = poolMembers();
      info(`第 2 次 acquire 前 ${POOL_KEY}（ZCARD=${poolBeforeSecond.length}）= ${JSON.stringify(poolBeforeSecond)}`);

      const second = await rpcCall<{ bots: any[] }>(ROBOT_RPC, RPC_PATTERNS.robotAcquire, req);
      info(`第 2 次 acquire → ok=${second.ok}，data=${JSON.stringify(second.ok ? second.data : second).slice(0, 200)}`);
      checks.that(second.ok, `第 2 次 robot.acquire 也必须 ok=true —— 实际 ${JSON.stringify(second)}`);
      if (!second.ok) throw new ConformanceError(`第 6 组：第 2 次 robot.acquire 失败 ${JSON.stringify(second)}`);
      const bots2 = second.data?.bots ?? [];
      checks.eq(bots2.length, 1, `第 2 次 acquire 返回 1 个机器人：实际 ${JSON.stringify(bots2)}`);
      const bot2 = bots2[0]!;
      checks.eq(bot2.botId, bot1.botId, '两次 acquire 返回**同一个** botId（R201 幂等 ⇒ §4.3「重试 1 次」的前提）');
      checks.eq(bot2.displayId, bot1.displayId, '两次 acquire 返回**同一个** displayId');

      const poolAfterSecond = poolMembers();
      info(
        `第 2 次 acquire 后 ${POOL_KEY}（ZCARD=${poolAfterSecond.length}）= ${JSON.stringify(poolAfterSecond)}` +
          '（**只作 info，不作相对量断言**：R253/R340 之后池计数的增减不是判据）',
      );

      // ── 判别力自证（R115）：同一个纯谓词喂合成坏输入，必须逐条报违规 ────────────────
      //    每条坏输入**只**触发一条违规（不要同时改成员集合与记录存在性，否则「抓到了」
      //    可能来自另一条分支 —— 那是空测）。
      const probeAdded = idempotentAcquireViolations(['bot-probe-a'], ['bot-probe-b'], 'bot-probe-a', () => true);
      const probeReturned = idempotentAcquireViolations(['bot-probe-a'], ['bot-probe-a'], 'bot-probe-a', () => true);
      const probeDangling = idempotentAcquireViolations(['bot-probe-a'], ['bot-probe-a'], 'bot-probe-b', () => false);
      const probeClean = idempotentAcquireViolations([], [], 'bot-probe-b', () => true);
      checks.eq(
        probeAdded.length,
        1,
        '探针正对照①：窗口内**新增**成员（池大小不变、只换了一个）⇒ 谓词必须报违规 —— ' +
          `实际 ${JSON.stringify(probeAdded)}`,
      );
      checks.eq(
        probeReturned.length,
        1,
        '探针正对照②：被占用的 bot **回池** ⇒ 谓词必须报违规 —— ' + `实际 ${JSON.stringify(probeReturned)}`,
      );
      checks.eq(
        probeDangling.length,
        1,
        '探针正对照③：池成员缺 `bot:{id}` 记录 ⇒ 谓词必须报违规 —— ' + `实际 ${JSON.stringify(probeDangling)}`,
      );
      // ⚠️ 负对照的输入必须与三条正对照**都不同**：空窗口 ⇒ ①的「新增」为空集；
      //    `exists` 恒真 ⇒ ③的悬挂为空集；该 bot 不在 `after` ⇒ ②不成立。
      //    （若只把「窗口相同」当作负对照，它在「谓词恒不报②」时也过 ⇒ 那是空测。）
      checks.eq(
        probeClean.length,
        0,
        '探针**负**对照：空窗口（两次读都是空池、该 bot 不在池）⇒ 谓词不得报违规' +
          '（否则判据恒红）—— ' + `实际 ${JSON.stringify(probeClean)}`,
      );

      // ── 实际判定：绝对性质（与上面四条探针**共用同一个谓词** ⇒ 判别力已被自证）──────
      const violations = idempotentAcquireViolations(
        poolBeforeSecond,
        poolAfterSecond,
        String(bot2.botId),
        recordExists,
      );
      checks.that(
        violations.length === 0,
        '第二次 acquire 的**绝对性质**必须全部成立（R253/R340；**不是**比较池计数）：' +
          '①窗口内**没有新增**池成员；②第 2 次 acquire 的 bot **不得回池**（它被占用中）；' +
          `③池里每个成员都必须有 \`bot:{id}\` 记录（悬挂为 0）—— 违规 ${violations.length} 条：` +
          `${violations.join('；') || '无'}（窗口 ${JSON.stringify(poolBeforeSecond)} → ` +
          `${JSON.stringify(poolAfterSecond)}；两次 acquire 之间池计数可因第三方写入而变，那不是判据）`,
      );
    }

    // ── 7) 生产形态不发布 RPC 端口（§2.1 / R226）──────────────────────
    if (runs('prod')) {
      step('第 7 组 §2.1：生产形态（`-f docker-compose.yml` + `--env-file <空文件>`）game/robot/config/currency 的 RPC 端口只在 expose');
      info(
        '与 `slice-07.2-deploy` 第 ① 步同源（那里钉「生产形态**只有门口**（edge）发布宿主端口；' +
          '`api-gateway` 零发布 + `expose: 3000`」，R1203）。',
      );
      info('两处环境隔离缺一不可（R147）：`--env-file <空文件>` + 从子进程 env 剔除 INTERNAL_SERVICE_TOKEN。');
      const config = prodConfig();
      for (const [service, port] of [
        ['game-service', '3103'],
        ['robot-service', '3105'],
        // ⚠️ 片规格 §2.1/§2.3：config-service 也是 RPC 监听方（3106）—— 与 game/robot 同规。
        // （片⑦ T13 换键：原 user-service 3101 随其 RPC 监听退役；3106 的 base `expose`
        // 与 override 宿主映射在 T4 已就位 ⇒ 换键即刻全绿。）
        ['config-service', '3106'],
        // ⚠️ 货币片 T1：currency-service 3104（`currency.apply`/`currency.get` 接收侧）——
        // base `expose` 与 override 宿主映射同提交就位。
        ['currency-service', '3104'],
      ] as const) {
        const published = publishedPorts(config, service);
        const exposed = exposedPorts(config, service);
        info(`${service}：ports=${JSON.stringify(published)}，expose=${JSON.stringify(exposed)}`);
        checks.that(
          !published.includes(port),
          `生产形态的 ${service} 宿主端口里**不得**有 ${port}（§2.1：内部 RPC 端口不对外暴露；` +
            `实际 ports=${JSON.stringify(published)}；开发形态的 ${port}:${port} 只允许出现在 override）`,
        );
        checks.that(
          exposed.includes(port),
          `生产形态的 ${service} \`expose\` 必须含 ${port}（compose 内网可达 —— §4.1 的四条 TCP 边靠它；` +
            `实际 expose=${JSON.stringify(exposed)}）`,
        );
      }
      checks.that(
        !JSON.stringify(publishedPorts(config, 'api-gateway')).includes('3103') &&
          !JSON.stringify(publishedPorts(config, 'api-gateway')).includes('3105'),
        'api-gateway 也不得发布 RPC 端口（它不参与 `Transport.TCP`，§4.1）',
      );
    }

    return checks;
  } finally {
    for (const client of clients) client.close();
  }
}


/** 经网关的原始请求（要**原文**才能区分「Nest 无此路由」与「service 自己的 404」）。 */
async function gatewayRequest(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${process.env.GW ?? 'http://localhost:3000'}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, text: await res.text() };
}

/**
 * **直连**下游服务的原始请求（带**正确**的内部 token）。
 *
 * 刻意不复用 `lib/http.ts` 的 `directJson`：本组要的是**原始文本**（`Cannot POST` vs
 * `{code:12001}`），而 `directJson` 会把非 JSON 压成 `{code: status}` 丢掉原文。
 */
async function directRaw(
  ep: RpcEndpoint,
  method: string,
  path: string,
  body: unknown,
  userId: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://${ep.host}:${ep.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': INTERNAL_TOKEN,
      'X-User-Id': userId,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, text: await res.text() };
}
