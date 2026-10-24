/**
 * 切片 7.2 完整片 conformance：**安全收口**的端到端判据（A6 / S4 / S5 / N5 / N6 / S6 / §9.8）。
 *
 * 计划：`docs/superpowers/plans/2026-09-15-slice-07.2-security-hardening.md` Task 7 Step 1。
 * 裁决：R135–R147。
 *
 * 为什么必须单独一条用例：前几片的用例只覆盖「能用的路径」——
 *   * 没有任何断言检查过**某条路由应该不存在**（`POST /api/games`、`/api/robots/*`、
 *     临时验证页 `/`）：它们过去**全都是 200/201**，而测试一片绿（偏差 S4/S5/N5/A6）；
 *   * 没有任何断言检查过**限流**（S6）与**视图路的 §11.1 信封**（N6）。
 * 本用例把「应该消失的东西」也变成断言 —— 每条断言的**修前形态**都写在该步的开头，
 * 那就是本用例判别力的说明书（负对照：在未修的 master 镜像上必须红）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠️ A7（网关下游超时）的 **e2e 刻意不做** —— 这是边界，不是遗漏（计划 Task 7 Step 1 第 8 条）。
 *
 * 要造出「下游超时」必须**停掉一个容器**（或注入一个不响应的下游），而本机是 8 容器
 * 共享的常驻栈：把它留在半死状态会让**同一轮门禁里的其它切片**（slice-05/06/07/08）
 * 假红，风险大于收益（同族教训 R132：判据的前提必须写出来，而不是靠运气）。
 *
 * 替代判据（**两条**，都不需要停容器）：
 *   ① `packages/api-gateway/test/proxy.gateway.test.ts` 的**结构性断言**：spy
 *      `AbortSignal.timeout(GATEWAY_UPSTREAM_TIMEOUT_MS=5000)` + 失败路径 `503/10007`
 *      （与负载无关，切片 7 的通用教训③）；
 *   ② 本文件第 9 步（`a7`）的**源码机械闸**：`packages/<service>/src/**` 里每一处出站
 *      HTTP 调用（**裸 `fetch(` 与注入式 `fetchImpl(` 两种写法都算** —— 见 R150 与 `callsFetch()`）
 *      所在文件必须出现超时标记（`AbortSignal` / `signal:` / `timeout:`），并带**指名正对照**。
 *      它读的是**主检出源码**（不是容器），因此能在不改动运行栈的前提下对 A7 取 RED —
 *      修前 `proxy.gateway.ts` 既无 `AbortSignal` 也无 `signal:`（实测）。
 *
 *      ⚠️ **R225（N20/P4 Task 6）**：`room-service` 的内部面从 HTTP 整条搬到 TCP RPC 之后，
 *      `game.client.ts` / `robot.client.ts` 用 `ClientProxy.send()`，**不再**出现 fetch 字面量
 *      ⇒ 形态判据（「必须还在走 fetch」）**必然**失效。故把**形态判据**与**性质判据**分离
 *      （照抄 `packages/api-gateway/test/outbound-timeout.gate.test.ts` 判据 A′ 的改法）：
 *      正对照只列**仍走 fetch** 的文件；迁走的文件由「无出站调用 ⇒ 无违规」自然覆盖。
 *      同处新增一条探针判别力自证：`ClientProxy.send()` + rxjs `timeout(` **不**得被误判成出站 HTTP。
 * ⚠️ 这条机械闸是**替代**判据，**不等于**「下游超时会返回 10007」的端到端证明；
 *    后者由上述 ① 的单测承担。不要把本条读成 e2e 覆盖（不许沉默，两处都写明）。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ A6 的可观测结局与计划原字面**不同**（执行期实测，协调者独立复现后改判为 **R149**）：
 *   `JwtMiddleware` 经 `consumer.apply(JwtMiddleware).forRoutes('*')` 注册，而 `main.ts`
 *   有 `setGlobalPrefix('api')` ⇒ 中间件**只在 `/api/*` 上运行**。实测：`GET /foo` 匿名
 *   返回 **404**（不是 401），`GET /` 匿名在**修前**返回 200 的 HTML（那是 `app.use()`
 *   注册的 express 处理器，跑在 Nest 路由之前）。删除静态页后 `/` 根本没有路由 ⇒
 *   **`/` 与 `/index.html` 恒为 404**，与是否带 token 无关；`/api/*` 之外的处理器整条
 *   绕过验签这件事已登记为 **N14**。
 *   因此 R138 的「未认证 401 / 已认证 404」作废（R149）。本用例钉实测值：**404**
 *   （404 与 401 会告诉你**是哪一层**拒绝的；而且将来有人把静态页加回来时，404 判据
 *   立刻红），同时保留「响应体不含 `<html>` / `findBeatingHand`」。
 *
 * ⚠️ **N15 的判据形态随实现变化（独立小片 P3 / R246 / R282）**：第 8 步（`ws`）过去断言的是
 *   **旧**形态 —— 「第 6 条先 `connect`、再 `system.error`、再 `io server disconnect`」
 *   （R152 的实测）。限额挪到 engine.io 的 `allowRequest` 之后，超限连接在**传输层**就被拒
 *   ⇒ 客户端拿到 **`connect_error`** 且**从未** `connect`。**判据不弱化**（仍然钉住「限额生效」），
 *   但必须换成传输层形态：`sawConnectError === true` + `sawConnect === false` + 前 5 条不受影响。
 *   另加一条与后端实现**无关**的判别力自证：**故意用错的 socket.io path** ⇒ 握手必然失败 ⇒
 *   必须观测到 `connect_error` 且从未 `connect`。
 *   ⚠️ **不要**改用「连一个不存在的端口」当自证：本机 `127.0.0.1` 未监听端口的 SYN 被**丢弃**
 *   （不是 RST，R229 同族）⇒ 连接**挂住**、窗口内零事件（实测 2.5s 无任何事件 = 空测）。
 *
 * ⚠️ **N9 的在线判据（第 10 步 / R249）**：§10.1 要求 `room:{code}` 是 **Hash**（字段集**恰好**
 *   8 个：`code`/`mode`/`gameType`/`baseScore`/`status`/`maxPlayers`/`createdAt`/`timeoutAt`）+ TTL 3600s。
 *   房号取自一条**真实的** `POST /api/rooms`（经网关）—— **不自己 `SET` 造键**：自造的键只能证明
 *   「我们把键写成了 hash」，证明不了**产品**写的是 hash。反向判据：`GET room:<code>` 必须报
 *   `WRONGTYPE`（证明确实不是 String）。修前（master 实测）：`TYPE` = **string**、`HKEYS` 报
 *   `WRONGTYPE`、`GET` 返回 `String(JSON)`。
 *
 * ⚠️ 步骤选择器 `CONFORMANCE_STEPS`（默认=全部）：`run.js` 是 **fail-fast**，
 *   第一个红步会终止整条用例 ⇒ 在未修代码上只能看到**第一个**判据的 RED。
 *   为了让每条断言的负对照都能单独取到（例如 `CONFORMANCE_STEPS=s98,n5,n6,http,ws`），
 *   这个环境变量可以**只减不增**地选择要跑的步骤；它**不能**放宽任何断言。
 *   合法 id：a6, s4, s5, s98, n5, n6, http, ws, a7, n9, gate, cov。
 *   **门禁 / 最终判定必须不带该环境变量**（等价于 `CONFORMANCE_STEPS=a6,s4,s5,s98,n5,n6,http,ws,a7,n9,gate,cov`）；
 *   未列出的 id **直接抛错**（`CONFORMANCE_STEPS=htpp` 这种手误绝不能被当成「筛过了」）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠️ **第 11/12 步（`gate` / `cov`，独立小片 P5 / Task 5 / R300–R319）**：
 *    §12.4 的五条源码闸与 §13.3 的覆盖率门槛「**真的会失败**」的自证。
 *
 * 为什么必须自证（R115 / 切片 11 教训第 7 条 / `deviation-ledger.md` N14/N15/N22）：
 *   本仓的失败模式**不是**闸太松，而是**闸恒绿**——`allFilesStillHttp`、`NOT_YET_MIGRATED`、
 *   以及 `pcak-11` 第 5/6 组的相对量判据都绿着漏掉了真缺陷。一条「跑绿了」的闸如果**从未**在
 *   违规输入上红过，它与不存在没有区别。所以这两步**主动制造违规**、看闸是否红：
 *
 *   - `gate`：① 读 `scripts/ci.sh`（**只读**）断言第 6 阶段的六条闸**每条都指向一个真实存在的
 *     测试文件**（过滤名与文件名脱节 ⇒ vitest「跑 0 个用例」而退出 0 ⇒ 恒绿，R291）；
 *     ② **向 `apps/client/src` 注入**一个含 `baseScore = 100` 的临时文件 ⇒ `source-boundary` **必须红**；
 *     ③ **向 `packages/shared/src/rule` 注入**一个未映射的 `throw new Error(…)` ⇒
 *     `rule-error-mapping` **必须红**（**与 ② 形态不同**的第五条闸：它比对的是「throw 站点集合 ⊆
 *     映射表」，不是「禁止字面量」——一条闸有效**不等于**五条闸都有效）。
 *     两次注入都在 `finally` 里删除并**断言删除成功**（门禁会审查 `git status`）。
 *
 *   - `cov`：读 `packages/shared/vitest.config.ts` 断言门槛 `thresholds.lines === 80`（**读配置**，
 *     不是读运行结果），再**变异自证**：把 `80` 临时改成 `99` ⇒ `test:coverage` **必须非零退出**，
 *     用原始字符串备份恢复后 ⇒ **必须零退出**。
 *     ⚠️ 这条**改的是产品配置文件**，因此恢复是三层保险（`finally` + `process.on('exit')` +
 *     `SIGTERM/SIGINT/SIGHUP`，见 `lib/probe.ts`），并且恢复后**逐字比对** `content === before`。
 *     ⚠️ 若本步在「变异已写入、尚未恢复」的窗口里被 `timeout` 杀掉，`lib/probe.ts` 的信号处理器
 *     会把文件写回原状（**这是它存在的唯一理由**，不是装饰）。
 * ══════════════════════════════════════════════════════════════════════════════
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { ErrCode, RPC_PATTERNS, type Card } from '@fight-the-landlord/protocol';
import {
  Checks,
  ConformanceError,
  fieldSetViolations,
  info,
  sleep,
  step,
} from '../lib/assert';
import {
  backupForMutation,
  createTempFile,
  pendingRestoreCount,
  readText,
  restorePath,
  runProc,
} from '../lib/probe';
import {
  directJson,
  gameGetJson,
  getJson,
  GAME_URL,
  GATEWAY_URL,
  INTERNAL_TOKEN,
  NAMESPACE,
  postJson,
  registerUser,
  ROBOT_URL,
  setFriendRooms,
  type HarnessUser,
} from '../lib/http';
import { HarnessClient } from '../lib/client';
import { GAME_RPC, rpcCall } from '../lib/rpc';
import { redisCli, redisLines, redisRaw, redisReplyText } from '../lib/redis';

/** 仓库根（`dist/slices/*.js` 与 `src/slices/*.ts` 同深度 ⇒ 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * 绝对路径 → 仓库相对路径，**分隔符恒为 `/`**（跨平台）。
 *
 * ⚠️ `REPO_ROOT` 由 `resolve()` 得到，**不以分隔符结尾** ⇒ 不能走 `slice(REPO_ROOT.length)`
 * （会多吃掉一个字符）。这里保留 `relative()`，只把它的输出归一化。
 *
 * 为什么不归一化就红：下面的「指名正对照」把 `relative()` 的结果与**按 `/` 写成的**字面量
 * 比较（`rel.includes(required)`）。Windows 上 `relative()` 得到
 * `packages\api-gateway\src\gateway\proxy.gateway.ts` ⇒ `includes()` 落空 ⇒
 * 实测报「指名正对照：机械闸扫到了 packages/api-gateway/…」而失败。
 * 归一化只改**表示**，不改判据强度。同族范例见 `apps/client/test/helpers/source-scan.ts:44`。
 */
const repoRel = (abs: string): string => relative(REPO_ROOT, abs).split('\\').join('/');

/** §10.1 逐字的 8 个字段（`room:{code}` 是 Hash；`gameType` 为多玩法新增，旧房缺省读 doudizhu）。 */
const ROOM_META_FIELDS = [
  'code',
  'mode',
  'gameType',
  'baseScore',
  'status',
  'maxPlayers',
  'createdAt',
  'timeoutAt',
] as const;

/** §10.1：`room:{code}` 的 TTL 是 3600s。 */
const ROOM_TTL_SECONDS = 3600;

/** 步骤 id（见文件头 `CONFORMANCE_STEPS`）。 */
const ALL_STEPS = ['a6', 's4', 's5', 's98', 'n5', 'n6', 'http', 'ws', 'a7', 'n9', 'gate', 'cov'] as const;
type StepId = (typeof ALL_STEPS)[number];

// ── §12.4 闸判别力 / §13.3 覆盖率门槛（P5 / Task 5 Step 2–3）───────────────

/** `scripts/ci.sh` 第 6 阶段**应有的六条闸**（R268/R291 逐字；集合本身也是判据）。 */
const EXPECTED_GATES: ReadonlyArray<{ pkg: string; filter: string }> = [
  { pkg: 'client', filter: 'source-boundary' },
  { pkg: 'room-service', filter: 'no-internal-http.gate' },
  { pkg: 'api-gateway', filter: 'outbound-timeout.gate' },
  { pkg: 'api-gateway', filter: 'no-route-outside-api.gate' },
  { pkg: 'game-service', filter: 'rule-error-mapping' },
  // P7（R361）新增：`shared` 的「防遗留第二契约复活」闸。⚠️ 它**必须**在这个集合里，
  // 否则本文件的两条判据会同时失真：① `missingExpected` 不再保护它（它可以从 `ci.sh` 里
  // 静默消失）；② 下面那条**负对照**的合成解析器
  // （`EXPECTED_GATES.filter(pkg).map(filter + '.test.ts')`）对 `shared` 返回**空数组**
  // ⇒ 真实接线被判成「过滤名匹配不到任何文件」而**假红**。
  // 本片门禁实测踩到过（原文：`探针负对照：真实接线 + … ⇒ 不报违规：期望 0，实际 1`）——
  // 那说明这条负对照是活的，不是空测。
  { pkg: 'shared', filter: 'no-legacy-message-names.gate' },
];

interface GateWiring {
  label: string;
  pkg: string;
  filter: string;
}

/** 从 `ci.sh` 里提取 `run_gate "<label>" … pnpm --filter … <pkg> test -- <filter>` 三元组。 */
function extractGateWirings(ciSh: string): GateWiring[] {
  const out: GateWiring[] = [];
  const re = /run_gate\s+"([^"]+)"[\s\S]{0,300}?pnpm --filter @fight-the-landlord\/([\w-]+) test -- ([\w.:-]+)/g;
  for (const m of ciSh.matchAll(re)) out.push({ label: m[1]!, pkg: m[2]!, filter: m[3]! });
  return out;
}

/**
 * 第 6 阶段的**接线判据**（纯函数，便于用合成输入自证判别力）：
 * 每条闸的过滤名必须能在对应包的 `test/` 下匹配到**真实存在**的测试文件。
 *
 * ⚠️ 这条抓的形态（R291）：`pnpm … test -- <过滤名>` 里的过滤名与文件名**脱节**时，
 * vitest 可能「一个用例都没跑」而**退出 0** ⇒ 这道闸恒绿。`run_gate` 已经在运行期防了它，
 * 这里再防一层「静态就能看出来」的版本（改名而忘了改 `ci.sh` 的人会在**跑测试之前**就被点名）。
 */
function gateWiringViolations(
  gates: readonly GateWiring[],
  testFilesOf: (pkg: string) => string[],
): string[] {
  const v: string[] = [];
  const missingExpected = EXPECTED_GATES.filter(
    (expected) => !gates.some((g) => g.pkg === expected.pkg && g.filter === expected.filter),
  );
  if (missingExpected.length > 0) {
    v.push(
      `第 6 阶段缺了应跑的闸：${missingExpected.map((g) => `${g.pkg}/${g.filter}`).join('、')}` +
        `（实际接线：${gates.map((g) => `${g.pkg}/${g.filter}`).join('、') || '无'}）` +
        ' —— §12.4 的覆盖面缩水必须改名/补回来，不能静默消失',
    );
  }
  for (const gate of gates) {
    const hits = testFilesOf(gate.pkg).filter((file) => basename(file).includes(gate.filter));
    if (hits.length === 0) {
      v.push(
        `${gate.label}：过滤名 \`${gate.filter}\` 在 ${gate.pkg} 的 test/ 下**匹配不到任何文件** ` +
          '⇒ 这道闸会「跑 0 个用例」而恒绿（R291）',
      );
    }
  }
  return v;
}

/** 一个包（`client` 特指 `apps/client`）的 `test/` 下全部 `*.test.ts`。 */function packageTestFiles(pkg: string, repoRoot: string): string[] {
  const dir = pkg === 'client' ? join(repoRoot, 'apps', 'client', 'test') : join(repoRoot, 'packages', pkg, 'test');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 注入探针 A：`§12.2` M09 的**底分字面量**（`source-boundary` 的第五条用例抓它）。 */
const PROBE_CLIENT_PATH = join(REPO_ROOT, 'apps', 'client', 'src', '__conformance_probe__.ts');
const PROBE_CLIENT_SRC = [
  '// conformance 注入探针（P5 / Task 5 Step 2）：本文件跑完即删，**不是**产品代码。',
  '// 说明：注释里写「牌型」不构成违规（扫描器只拦标识符与字面量）—— 这也是本探针的负对照。',
  'export const baseScore = 100;',
  '',
].join('\n');

/** 注入探针 B：`packages/shared/src/{ddz,rule}` 里一个**未映射**的 `throw`（第五条闸抓它）。 */
const PROBE_SHARED_PATH = join(REPO_ROOT, 'packages', 'shared', 'src', 'rule', '__conformance_probe__.ts');
const PROBE_SHARED_SRC = [
  '/** conformance 注入探针（P5 / Task 5 Step 2）：本文件跑完即删，**不是**产品代码。 */',
  'export function conformanceProbeUnmappedThrow(): never {',
  "  throw new Error('conformance probe: this rule error maps to nothing in RULE_ERROR_MAPPINGS');",
  '}',
  '',
].join('\n');

/** `packages/shared/vitest.config.ts`（§13.3 覆盖率门槛的**唯一**真源）。 */
const SHARED_VITEST_CONFIG = join(REPO_ROOT, 'packages', 'shared', 'vitest.config.ts');

/** 短哈希：给「恢复后逐字相同」一条**可粘贴进汇报**的读数（不把整个文件打进输出）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** §5.4 / R141 的阈值：20 次 / 5 秒。这里刻意**写死**：放宽到跟着实现走就等于不测。 */
const HTTP_RATE_MAX = 20;
const HTTP_RATE_WINDOW_MS = 5000;
/**
 * 「20 连发确实落在同一个 5 秒窗口内」的**前提阈值**（协调者补充，R147 的延伸）。
 * 实测远低于它（本机 ~300ms）；高负载下超了 ⇒ 窗口滑动 ⇒ 判据不确定，
 * 此时**换一个新账号重试**（最多 3 次），三次都超时则**明确报错**而不是静默判过。
 */
const WINDOW_PRECONDITION_MS = 4000;
const HTTP_ATTEMPTS = 3;

/** §9.8：出站载荷里不得出现的机器人标记。 */
const BOT_MARKERS = ['bot-', 'isRobot', 'botId', 'skillLevel', 'thinkingSpeed'] as const;

interface ViewBody {
  code?: number;
  message?: string;
  data?: any;
}

/** 出站 `PlayerView` 只声明本用例真正读的字段（§6.4）。 */
interface PlayerViewWire {
  roomCode: string;
  version: number;
  seat: number;
  /** R696：`Card[]`，不是点数数组。此前标成 `number[]` 是**假**的（用法碰巧都走 sorted/length）。 */
  hand: Card[];
  cardCounts: [number, number, number];
  state: string;
}

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

/** §9.8 的扫描器（**只有一份实现**，正/负对照与实际扫描共用它）。 */
function botMarkers(raw: unknown): string[] {
  const text = JSON.stringify(raw ?? null);
  return BOT_MARKERS.filter((marker) => text.includes(marker));
}

/**
 * 字段集比较（N9：`HKEYS room:{code}` 必须**恰好**是 §10.1 的 7 个字段）。
 *
 * **纯函数**（不碰 Redis）：本切片的 Redis 探针是只读的（§海森堡），
 * 正/负对照只能靠合成输入来证明谓词有判别力（R115/R212②）。
 * 返回的是**人话**（`缺 x` / `多 y`），失败消息里能直接看出差异。
 *
 * ⚠️ **P5/Task 5 之后只有一份实现**：函数体搬到了 `lib/assert.ts`（`slice-07.2-deploy`
 * 的 §2.4 `checks` 字段集判据也要用它）—— 本仓为「同一事实的第二实现」付过多次代价
 * （N23 就是其一），所以这里不再留本地副本。
 */

/** 需要**原始文本**的探针（A6 要检查响应体里有没有 HTML / 牌型引擎）。 */
async function rawGet(path: string, token?: string): Promise<{ status: number; text: string; contentType: string }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${GATEWAY_URL}${path}`, { headers });
  return { status: res.status, text: await res.text(), contentType: String(res.headers.get('content-type') ?? '') };
}

/**
 * 一次「连接能不能**存活**」的探针：**静置一段时间后**读 `socket.connected`，
 * 并把**观测通道**（`connect` / `connect_error` / `disconnect(reason)`）分开记下来。
 *
 * ⚠️ R152 记录的是**旧**形态（限额在 `handleConnection` 里 `rejectHandshake()`）：
 * 服务端**先发 CONNECT 包**，然后才拒绝 ⇒ 客户端看到
 *   `connect` → `system.error` → `disconnect(reason='io server disconnect')`，
 *   **`connect_error` 根本不触发**。
 * R246/N15 之后限额挪到 engine.io 的 `allowRequest`：超限在**传输层**就被拒 ⇒
 * 客户端看到 **`connect_error`** 且**从未** `connect`。
 * 因此判据**必须**按形态分开断言（`sawConnect` vs `sawConnectError`），
 * 不能再用一个 `kicked || error` 的合成布尔把它们混成一件事（那正是旧版判据无法区分两者的原因）。
 */
interface ConnectProbe {
  socket: Socket;
  /** **静置之后**的 `socket.connected`。 */
  connected: boolean;
  /** 观测到过 `connect` 事件（旧形态的「先连上」= R115 的正对照）。 */
  sawConnect: boolean;
  /** 观测到过 `connect_error`（传输层拒绝 / 握手被拒的**唯一**通道）。 */
  sawConnectError: boolean;
  /** `connect_error` 的原文（RED 汇报要逐字引用）。 */
  errorMessage?: string;
  /** 服务端**主动**踢掉（`io server disconnect`）——旧形态的观测值，只作 info。 */
  kicked: boolean;
}

/** 通用连接探针：`url` / `path` 都可替换（判别力自证要故意让握手失败）。 */
async function connectProbe(
  url: string,
  token: string,
  settleMs: number,
  path = '/socket.io/',
): Promise<ConnectProbe> {
  const socket = io(url, {
    path,
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });
  let sawConnect = false;
  let sawConnectError = false;
  let errorMessage: string | undefined;
  let kicked = false;
  socket.on('connect', () => {
    sawConnect = true;
  });
  socket.on('connect_error', (err: Error) => {
    sawConnectError = true;
    errorMessage = err?.message ?? String(err);
  });
  socket.on('disconnect', (reason: string) => {
    if (reason === 'io server disconnect') kicked = true;
  });
  await sleep(settleMs);
  return { socket, connected: socket.connected, sawConnect, sawConnectError, errorMessage, kicked };
}

async function tryConnect(user: HarnessUser, settleMs = 800): Promise<ConnectProbe> {
  return connectProbe(`${GATEWAY_URL}${NAMESPACE}`, user.accessToken, settleMs);
}

/** 探针观测值的**一行**渲染（RED 归因全靠它）。 */
function describeProbe(label: string, p: ConnectProbe): string {
  return (
    `${label}：静置后 connected=${p.connected}，sawConnect=${p.sawConnect}，` +
    `sawConnectError=${p.sawConnectError}，kicked=${p.kicked}` +
    `${p.errorMessage ? `，error=${p.errorMessage}` : ''}`
  );
}

/** 递归收集 `packages/<service>/src/**` 的 `.ts`（A7 的源码机械闸用）。 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 「这个文件真的发起了出站 HTTP 调用吗」—— **R150**。
 *
 * 必须同时认两种写法，否则机械闸会指错方向：
 *   - 裸调用：`await fetch(url, opts)`（网关 `proxy.gateway.ts`、robot→douzero）；
 *   - **注入式**：`this.fetchImpl(url, init)`（room→game 的 `GameClient` 为了单测可替身，
 *     把 `fetch` 存成 `fetchImpl` 字段）—— 它的源码里**没有** `fetch(` 这个子串。
 *
 * ⚠️ 计划里写的「文件里必须出现 `fetch(`」在**当前源码上恒漏一个**（R150）：用那个子串
 * 扫描只命中 2 个文件，而计划要求 3 个「指名正对照」⇒ 那条正对照**永远为假**。
 * 另外**不要**用 `(^|[\w.])fetch\s*\(`（协调者初稿）：`await fetch(` 的前一个字符是**空格**，
 * 于是两个裸调用文件都会被漏掉（实测）。用 `\bfetch\s*\(`：`fetch(`、`await fetch(`
 * 命中，而 `fetchImpl(`（后面是 `Impl`）、`prefetch(`（`\b` 不成立）、`typeof fetch;`（无括号）
 * 都不命中。
 */
function callsFetch(src: string): boolean {
  return /\bfetch\s*\(|fetchImpl\s*\(/m.test(src);
}

export async function runSlice072Hardening(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  const sockets: Socket[] = [];
  const only = process.env.CONFORMANCE_STEPS;
  const selected = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
  if (selected) {
    // 未知 id **必须抛错**：否则 `CONFORMANCE_STEPS=htpp` 会静默跑全部步骤，
    // 让人以为「筛过了」（协调者要求，R149）。
    const unknownSteps = [...selected].filter((s) => !(ALL_STEPS as readonly string[]).includes(s));
    if (unknownSteps.length > 0) {
      throw new ConformanceError(
        `CONFORMANCE_STEPS 里有未知步骤：${unknownSteps.join(', ')}（合法值：${ALL_STEPS.join(', ')}）`,
      );
    }
  }
  const runs = (id: StepId): boolean => selected === undefined || selected.has(id);

  /** 主账号 A：A6/S4 只需要它；房间相关的步骤（s5/s98/n5/n6/ws）也以它为「自己人」。 */
  let primary: HarnessUser | undefined;
  const ensurePrimary = async (): Promise<HarnessUser> => (primary ??= await registerUser(0));

  interface Room {
    roomCode: string;
    users: HarnessUser[];
    clients: HarnessClient[];
    /** A 自己那一份发牌视图（`game.deal`）。 */
    dealA: PlayerViewWire;
    aSeat: number;
    /** R696：`sorted()` 的产物是 `string[]`（`"r-s"` 键），不是点数数组。 */
    aHand: string[];
    joinAcks: any[];
  }
  let room: Room | undefined;
  let roomClientsClosed = false;

  /** 造一局真牌局（3 人 match → join → game.deal）；按需创建并缓存。 */
  const ensureRoom = async (): Promise<Room> => {
    if (room) return room;
    const users: HarnessUser[] = [await ensurePrimary()];
    for (let i = 0; i < 2; i += 1) users.push(await registerUser(i + 1));
    for (const [i, user] of users.entries()) clients.push(await HarnessClient.connect(`H${i}`, user));

    for (const client of clients) {
      // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
      const ack = await client.send('room.match', { mode: 'random', baseScore: 15 });
      if (ack.code !== ErrCode.OK) throw new ConformanceError(`${client.label} room.match 失败：${JSON.stringify(ack)}`);
    }
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', 25_000)));
    const roomCode = matched[0]!.payload.roomCode as string;
    if (!/^[0-9A-Z]{6}$/.test(roomCode)) throw new ConformanceError(`roomCode 形状非法：${roomCode}`);

    const joinAcks: any[] = [];
    for (const client of clients) {
      const ack = await client.send('room.join', { roomCode });
      if (ack.code !== ErrCode.OK) throw new ConformanceError(`${client.label} room.join 失败：${JSON.stringify(ack)}`);
      joinAcks.push(ack);
    }
    const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
    const dealA = deals[0]!.payload as PlayerViewWire;
    room = {
      roomCode,
      users,
      clients,
      dealA,
      aSeat: Number(dealA.seat),
      aHand: sorted(dealA.hand),
      joinAcks,
    };
    info(`已造局 roomCode=${roomCode}，A 的 seat=${room.aSeat}，A 的 deal hand=${JSON.stringify(room.aHand)}`);
    return room;
  };

  const closeRoomClients = (): void => {
    if (roomClientsClosed) return;
    roomClientsClosed = true;
    for (const client of clients) client.close();
  };

  // ── 片⑦ 前置（T14）：好友房开关必须**开** ────────────────────────
  // 本片第 10 步（N9）要经网关 `POST /api/rooms` 建房、并按房号读 Redis —— 片⑦ 起该
  // 路由按 `game.doudizhu.friendRoomEnabled` 缓存值拦截（关 ⇒ 12006）。（第 5/6 步的
  // `ensureRoom` 走 `room.match`，匹配路径**不**受开关影响 —— 规格 C8 的正对照。）
  // ⚠️ 放在 `runs()` 的步骤选择**之外**、`try` 的清理范围**之前**：它是前置而不是某一步的
  //    判据（步骤选择器只**减步骤**、不弱化前置）；失败直接抛 ConformanceError 带因收场。
  // ⚠️ 只开**不还原**（规格 §3 编排：开关的复原是 slice-14 收尾的职责）。
  await setFriendRooms(true, (await ensurePrimary()).accessToken);

  try {
    // ── 1) A6：临时验证页必须消失 ─────────────────────────────────────
    if (runs('a6')) {
      step('第 1 步 A6：`/` 与 `/index.html` 不得再返回验证页（§1.4 / §12.5 / R138，判据按 R149 收紧为 404）');
      info('修前：匿名与已认证都返回 200 + ~23KB 的 HTML（响应体里有浏览器端牌型引擎 `findBeatingHand`）。');
      info('R149：`JwtMiddleware` 只在 `/api/*` 上运行（实测 `GET /foo` 匿名 = 404 而非 401）⇒ `/` 恒为 404。');
      const a = await ensurePrimary();

      const anonRoot = await rawGet('/');
      info(`匿名 GET / → HTTP ${anonRoot.status}，content-type=${anonRoot.contentType}，body 前 90 字：${anonRoot.text.slice(0, 90)}`);
      checks.eq(anonRoot.status, 404, '匿名 GET / 的 HTTP 状态（R149：`/` 恒为 404；修前 = 200 + HTML）');
      checks.that(!anonRoot.text.includes('<html') && !anonRoot.text.includes('findBeatingHand'), '匿名 GET / 的响应体里既没有 HTML 文档也没有牌型引擎 findBeatingHand');

      const anonIndex = await rawGet('/index.html');
      info(`匿名 GET /index.html → HTTP ${anonIndex.status}，body 前 90 字：${anonIndex.text.slice(0, 90)}`);
      checks.eq(anonIndex.status, 404, '匿名 GET /index.html 的 HTTP 状态（修前 = 200 + HTML）');
      checks.that(!anonIndex.text.includes('<html') && !anonIndex.text.includes('findBeatingHand'), '匿名 GET /index.html 的响应体里没有 HTML / 牌型引擎');

      const authedRoot = await rawGet('/', a.accessToken);
      info(`带 A 的 access token GET / → HTTP ${authedRoot.status}`);
      checks.eq(authedRoot.status, 404, '已认证 GET / 的 HTTP 状态（静态页已删、且 Nest 没有 `/` 路由）');
      const authedIndex = await rawGet('/index.html', a.accessToken);
      checks.eq(authedIndex.status, 404, '已认证 GET /index.html 的 HTTP 状态');
      checks.that(!authedRoot.text.includes('<html') && !authedRoot.text.includes('findBeatingHand'), '已认证 GET / 的响应体里没有 HTML / 牌型引擎');
    }

    // ── 2) S4：robots/move 的客户端可达面 + 路由本体都必须消失 ─────────
    if (runs('s4')) {
      step('第 2 步 S4：`POST /api/robots/move` 经网关与直连都必须 404（§9.5 / R135）');
      info('修前：两条路径都能到 `RobotService.getBotMove()` —— 它接收客户端传来的**整份 `GameSession`**');
      info('     （等于把三家手牌交给 AI）。本探针故意塞一份「形状合法但内容假」的 session。');
      info('     修前实测的 HTTP 码可能是 500（未知 bot ⇒ 抛错）而不是 200 —— 但**断言是 404**，');
      info('     所以「路由还在」的任何形态都是红，不会因为码不是 200 而漏判。');
      const a = await ensurePrimary();
      const fakeSession = {
        roomCode: 'PROBE1',
        version: 1,
        players: [{ id: a.id, seat: 0, hand: [3, 4, 5] }],
      };
      const moveBody = { roomCode: 'PROBE1', playerId: a.id, session: fakeSession };

      const viaGateway = await postJson<unknown>('/api/robots/move', moveBody, a.accessToken);
      info(`经网关 POST /api/robots/move → HTTP ${viaGateway.status}，body=${JSON.stringify(viaGateway.body)}`);
      checks.eq(viaGateway.status, 404, '经网关 POST /api/robots/move 的 HTTP 状态（修前：路由存在 ⇒ 500/201）');

      const direct = await directJson(ROBOT_URL, '/api/robots/move', {
        method: 'POST',
        body: moveBody,
        userId: a.id,
        internalToken: INTERNAL_TOKEN,
      });
      info(`直连 robot:3005 POST /api/robots/move（带内部 token）→ HTTP ${direct.status}，body=${JSON.stringify(direct.body)}`);
      checks.eq(direct.status, 404, '直连 robot:3005 POST /api/robots/move 的 HTTP 状态（R135：路由本体也删除）');
    }

    // ── 3) S5：robots/create 经网关必须消失 ───────────────────────────
    if (runs('s5')) {
      step('第 3 步 S5：网关不得再暴露 `POST /api/robots/create`（§9.6 / R136）');
      info('修前：经网关 201，响应体里**明文** `id: "bot-<uuid8>"`（偏差 S5 的活体形态，实测）。');
      info('正对照：该路由在 robot-service **本体保留**（服务间入口，见 §9.6）—— 本步只断言网关这一跳没了。');
      const a = await ensurePrimary();
      const r = await ensureRoom();
      const res = await postJson<{ id?: string }>('/api/robots/create', { roomCode: r.roomCode, seat: 1 }, a.accessToken);
      info(`经网关 POST /api/robots/create → HTTP ${res.status}，body=${JSON.stringify(res.body)}`);
      checks.eq(res.status, 404, '经网关 POST /api/robots/create 的 HTTP 状态（修前：201 + `id:"bot-..."`）');
      checks.that(!JSON.stringify(res.body ?? null).includes('bot-'), '404 响应体里不得夹带 `bot-` 前缀 id');
    }

    // ── 4) §9.8：出站载荷的机器人标记机械扫描 ──────────────────────────
    if (runs('s98')) {
      step('第 4 步 §9.8：一局里的**每一条** S→C 消息 + `GET /api/rooms` 的 data + `room.join` ack 都不得含机器人标记');
      info('⚠️ 修前**也是绿的**：本步是**回归锚点**（§9.8 在当时已满足），它的判别力来自下面两条');
      info('   探针正/负对照 + 「扫描面非空」；S5 的 RED 在上一条（网关 `robots/create` 201 + `bot-`）。');
      const a = await ensurePrimary();
      const r = await ensureRoom();
      const aClient = r.clients[0]!;

      // ⚠️ R115：断言「没发生」之前先证明探针**能观测到发生**。扫描器只有一份实现，
      //    所以这两条正/负对照直接证明实际扫描用的就是它。
      const probeHit = botMarkers({ id: 'bot-deadbeef', isRobot: true, botId: 'x', skillLevel: 'beginner', thinkingSpeed: 2000 });
      checks.eq(probeHit.length, BOT_MARKERS.length, `探针正对照：扫描器能识别全部 ${BOT_MARKERS.length} 种标记`);
      const probeClean = botMarkers({ roomCode: r.roomCode, seat: 1, hand: [3, 4] });
      checks.eq(probeClean.length, 0, '探针负对照：干净的 PlayerView 不命中任何标记');

      const rooms = await getJson<unknown[]>('/api/rooms', a.accessToken);
      checks.eq(rooms.status, 200, 'GET /api/rooms（§9.8 扫描面之一）的 HTTP 状态');
      const scanned: Array<[string, unknown]> = [
        ...aClient.received.map((m) => [`S→C ${m.type}`, m.message] as [string, unknown]),
        ['GET /api/rooms 的 data', rooms.body?.data],
        ...r.joinAcks.map((ack, i) => [`room.join ack(H${i})`, ack] as [string, unknown]),
      ];
      info(`扫描 ${scanned.length} 条载荷（其中 A 收到 ${aClient.received.length} 条 S→C 消息：${aClient.received.map((m) => m.type).join(', ')}）`);
      checks.atLeast(scanned.length, 4, '扫描面非空（列表为空时「零命中」是假绿 —— R115）');
      const offenders = scanned
        .map(([label, payload]) => [label, botMarkers(payload)] as const)
        .filter(([, hits]) => hits.length > 0)
        .map(([label, hits]) => `${label} → ${hits.join(',')}`);
      checks.that(offenders.length === 0, `出站载荷里不得出现 ${BOT_MARKERS.join(' / ')}（命中：${offenders.join('；') || '无'}）`);
    }

    // ── 5) N5：`POST /api/games` 不是客户端路由（载体已换 RPC，N20/P4）────
    if (runs('n5')) {
      step(
        '第 5 步 N5：网关不得再暴露 `POST /api/games`（§7.1 / R137），' +
          '而 `game.start` 的服务间入口**改走 TCP RPC**（§4.2 / R218 / N20-P4）',
      );
      info('修前：经网关 **201** + `{code:0,data:{...}}`（实测），即任何已认证客户端都能任意开局。');
      info('载体变更（Task 6）：正对照从「直连 HTTP 3003 POST /api/games ⇒ 201」');
      info(`  改成「\`rpcCall(GAME_RPC, RPC_PATTERNS.gameStart, …)\` ⇒ ok=true」——`);
      info('  那条 HTTP 路由已被 R218 **整条删除**（旧栈上它才是 201）。负对照（经网关 404）不变。');
      const a = await ensurePrimary();
      const r = await ensureRoom();
      const body = {
        roomCode: r.roomCode,
        baseScore: 100,
        players: r.users.map((u, i) => ({ id: u.id, seat: i, isRobot: false })),
      };

      const viaGateway = await postJson<unknown>('/api/games', body, a.accessToken);
      info(`经网关 POST /api/games → HTTP ${viaGateway.status}，body=${JSON.stringify(viaGateway.body)}`);
      checks.eq(viaGateway.status, 404, '经网关 POST /api/games 的 HTTP 状态（修前：201）');
      checks.that(
        viaGateway.body?.code !== ErrCode.OK,
        `经网关 404 不得是一个 code=0 的成功信封（网关层拒绝，未到 service）—— 实际 ${JSON.stringify(viaGateway.body)}`,
      );

      // ⚠️ 正对照（本步的核心）：**服务间入口仍在**，只是换了传送带（TCP RPC）。
      //    缺了它，「全站 404」也会让上一条断言假绿 —— 而 N5 关掉的是**网关那一跳**。
      const started = await rpcCall<{ roomCode: string; state: string; version: number }>(
        GAME_RPC,
        RPC_PATTERNS.gameStart,
        body,
      );
      info(`RPC \`${RPC_PATTERNS.gameStart}\`（${GAME_RPC.host}:${GAME_RPC.port}, roomCode=${r.roomCode}）→ ok=${started.ok}，data=${JSON.stringify(started.ok ? started.data : undefined)}`);
      checks.that(
        started.ok,
        `game.start 经 TCP RPC 必须 ok=true（正对照：服务间入口未删，只是从 HTTP 换成 RPC）—— 实际 ${JSON.stringify(started)}`,
      );
      if (!started.ok) throw new ConformanceError(`第 5 步：game.start 经 RPC 失败 ${JSON.stringify(started)}`);
      checks.eq(started.data.roomCode, r.roomCode, 'game.start 返回的就是这一局（未误伤其它入口）');

      // ⚠️ 回归锚点：被删的内部 HTTP 入口**整条不存在**（R218）。
      //
      // ⚠️⚠️ **必须带「正确的」内部 token 才能观测到 404**（执行期实测纠正）：
      //    `createInternalTokenMiddleware()` 是 **app.use 全局中间件**，跑在 Nest 路由**之前**
      //    ⇒ 不带 token 的请求在**任何**路径上都先得到 **401**（包括根本不存在的路径）。
      //    因此「不带 token ⇒ 404」是**不可能**成立的断言 —— 它会红在**正确的实现**上
      //    （门禁期实测原文：`期望 404，实际 401`，body=`{"code":10002,…}`）。
      //    旧栈上这条同时具有「401 也能通过」的假绿风险：401 在修前修后**都存在**。
      //    正确的形态：**带正确 token**（越过中间件）⇒ 路由不存在 ⇒ **404**。
      //    判别力因此更强：修前带 token 是 **201**（路由还在、真的开局），修后是 404。
      const directWithToken = await directJson(GAME_URL, '/api/games', {
        method: 'POST',
        body,
        userId: a.id,
        internalToken: INTERNAL_TOKEN,
      });
      info(
        `直连 game:3003 POST /api/games（**带正确内部 token**）→ HTTP ${directWithToken.status}，` +
          `body=${JSON.stringify(directWithToken.body)}`,
      );
      checks.eq(
        directWithToken.status,
        404,
        '直连 game:3003 POST /api/games 的 HTTP 状态（R218：路由整条删除 ⇒ 404；' +
          '修前带 token 是 201 —— 路由还在、真的开了一局）',
      );
      checks.that(
        !JSON.stringify(directWithToken.body ?? {}).includes('"code":0'),
        '被删路由的 404 不得是「成功信封」的伪装（body 原文见上）',
      );
    }

    // ── 6) N6：视图两条路由改 §11.1 信封 ──────────────────────────────
    if (runs('n6')) {
      step('第 6 步 N6：`GET /api/games/:roomCode` 与 `/state` 必须是 §11.1 信封 `{code:0,data:PlayerView}`（R139）');
      info('修前：成功路径返回**裸 `PlayerView`** ⇒ `body.code === undefined`、视图字段在**顶层**。');
      info('（`slice-07.2-boundary` / `slice-07.2-security` 的 N6 断言与此同源，两处一起红/绿。）');
      const a = await ensurePrimary();
      const r = await ensureRoom();

      // 参照真值取**权威快照**（`game.resync`）而不是 `game.deal`：叫抢可能在探针期间
      // 推进（地主会多拿 3 张底牌），只有 resync 是「此刻」的真值。
      const resync = await r.clients[0]!.send('game.resync', {}, 0);
      checks.eq(resync.code, ErrCode.OK, 'A game.resync code（N6 的参照真值）');
      const authSeat = Number(resync.data?.seat);
      const authHand = resync.data?.hand;
      info(`A 的权威 seat=${authSeat}，权威 hand=${JSON.stringify(sorted(authHand))}（发牌时是 17 张：${JSON.stringify(r.aHand)}）`);

      const assertEnvelopeView = (label: string, body: ViewBody): void => {
        checks.eq(body?.code, ErrCode.OK, `${label} 的 body.code === 0（修前：undefined —— 裸 PlayerView）`);
        const view = body?.data as PlayerViewWire | undefined;
        checks.that(view !== undefined && view !== null && typeof view === 'object', `${label} 的 body.data 是视图对象（修前：视图字段在顶层，data 不存在）`);
        checks.eq(Number(view?.seat), authSeat, `${label} 的 data.seat 就是 A 自己的座位`);
        checks.that(sameHand(view?.hand, authHand), `${label} 的 data.hand 与权威快照逐张相等（实际 ${JSON.stringify(sorted(view?.hand))}）`);
        const counts = view?.cardCounts;
        checks.that(
          Array.isArray(counts) && counts[Number(view?.seat)] === (view?.hand?.length ?? -1),
          `${label} 的 cardCounts[seat] === hand.length（协议不变式，漏了它会掩盖错张数）`,
        );
      };

      const viaGateway = await getJson<unknown>(`/api/games/${r.roomCode}`, a.accessToken);
      info(`经网关 GET /api/games/${r.roomCode} → HTTP ${viaGateway.status}，body 前 220 字：${JSON.stringify(viaGateway.body).slice(0, 220)}`);
      checks.eq(viaGateway.status, 200, '经网关 GET /api/games/<code> 的 HTTP 状态');
      assertEnvelopeView('经网关 GET /api/games/<code>', viaGateway.body as ViewBody);

      const direct = await gameGetJson<unknown>(`/api/games/${r.roomCode}/state`, a.id, INTERNAL_TOKEN);
      info(`直连 game:3003 GET /api/games/<code>/state → HTTP ${direct.status}，body 前 220 字：${JSON.stringify(direct.body).slice(0, 220)}`);
      checks.eq(direct.status, 200, '直连 game:3003 GET /api/games/<code>/state 的 HTTP 状态');
      assertEnvelopeView('直连 GET /api/games/<code>/state', direct.body as ViewBody);
    }

    // ── 7) S6-HTTP：单用户 20 次 / 5 秒 ───────────────────────────────
    if (runs('http')) {
      step(`第 7 步 S6-HTTP：单用户 ${HTTP_RATE_MAX} 次 / ${HTTP_RATE_WINDOW_MS / 1000} 秒（§5.4 / R141）`);
      info('修前：HTTP 侧**没有任何限流** ⇒ 21 次（乃至 200 次）全部 200。');
      info(`判据的确定性前提（R132/R147）：${HTTP_RATE_MAX} 连发必须落在**同一个** ${HTTP_RATE_WINDOW_MS}ms 窗口内，`);
      info(`否则窗口滑动 ⇒ 第 21 次不会被拒。先量耗时，> ${WINDOW_PRECONDITION_MS}ms 就**换新账号重试**（最多 ${HTTP_ATTEMPTS} 次）；`);
      info('三次都超时 ⇒ 明确报错「前提未满足」，**不静默判过**。');

      let measured = false;
      let lastElapsed = 0;
      for (let attempt = 1; attempt <= HTTP_ATTEMPTS && !measured; attempt += 1) {
        const u = await registerUser(30 + attempt);
        const first: Array<{ i: number; status: number; code?: number }> = [];
        const t0 = Date.now();
        for (let i = 1; i <= HTTP_RATE_MAX; i += 1) {
          const res = await getJson<unknown[]>('/api/rooms', u.accessToken);
          first.push({ i, status: res.status, code: res.body?.code });
        }
        const elapsed = Date.now() - t0;
        lastElapsed = elapsed;
        info(`第 ${attempt} 次尝试（账号 ${u.id}）：${HTTP_RATE_MAX} 连发耗时 ${elapsed}ms`);
        info(`  逐次结果：${first.map((f) => `${f.i}:${f.status}/${String(f.code)}`).join(' ')}`);
        if (elapsed > WINDOW_PRECONDITION_MS) {
          info(`  ⚠️ 耗时 ${elapsed}ms > ${WINDOW_PRECONDITION_MS}ms ⇒ 前提未满足，换新账号重试`);
          continue;
        }
        measured = true;

        checks.that(
          first.every((f) => f.status === 200 && f.code === ErrCode.OK),
          `窗口内前 ${HTTP_RATE_MAX} 次 GET /api/rooms 全部 200 + code 0（实际 ${first.map((f) => `${f.status}/${String(f.code)}`).join(' ')}）`,
        );

        // 第 21 次（窗口内 + 额外一次）——判别力核心：修前这里恒为 200。
        const extra: Array<{ status: number; code?: number }> = [];
        for (let i = 0; i < 2; i += 1) {
          const res = await getJson<unknown[]>('/api/rooms', u.accessToken);
          extra.push({ status: res.status, code: res.body?.code });
        }
        info(`窗口内第 ${HTTP_RATE_MAX + 1}/${HTTP_RATE_MAX + 2} 次 → ${extra.map((e) => `${e.status}/${String(e.code)}`).join(' ')}`);
        const rejected = extra.filter((e) => e.status === 429 && e.code === ErrCode.RATE_LIMITED).length;
        checks.atLeast(rejected, 1, `窗口内超限请求被拒的次数（429 + 10006；修前恒为 0）`);
        checks.eq(extra[0]!.status, 429, `第 ${HTTP_RATE_MAX + 1} 次 GET /api/rooms 的 HTTP 状态（修前：200）`);
        checks.eq(extra[0]!.code, ErrCode.RATE_LIMITED, `第 ${HTTP_RATE_MAX + 1} 次的 body.code（10006）`);
        checks.eq(extra[1]!.status, 429, `窗口内再打一次仍然 429（不是「恰好第 21 次」的巧合）`);

        // 维度是 per-user 而不是全局：另一个账号的第一次请求必须照常成功。
        const v = await registerUser(31 + attempt);
        const other = await getJson<unknown[]>('/api/rooms', v.accessToken);
        info(`另一个账号 ${v.id} 的第一次请求 → HTTP ${other.status}/code ${String(other.body?.code)}`);
        checks.eq(other.status, 200, '另一个账号的第一次请求 → 200（证明维度是 per-user，不是全局）');
        checks.eq(other.body?.code, ErrCode.OK, '另一个账号的 body.code');
      }
      if (!measured) {
        throw new ConformanceError(
          `❌ 前提未满足（实测 ${lastElapsed}ms > ${WINDOW_PRECONDITION_MS}ms，${HTTP_ATTEMPTS} 次重试均失败）：` +
            `${HTTP_RATE_MAX} 连发没有落在同一个 ${HTTP_RATE_WINDOW_MS}ms 窗口内，限流判据**不确定** —— ` +
            '这是环境负载问题，不是「限流不存在」，不得当成通过。',
        );
      }
    }

    // ── 8) S6-WS 连接维度：单 IP 并发 5 条（R246/N15：传输层拒绝）─────────
    if (runs('ws')) {
      step('第 8 步 S6-WS 连接维度：单 IP 并发 WebSocket 连接 5 条（§5.4 / R141 / R147 / R246）');
      info('形态（R246/N15 后端半边）：限额在 engine.io 的 `allowRequest` 里查 ⇒ 超限在**传输层**就被拒，');
      info('  客户端拿到 **`connect_error`** 且**从未** `connect`。');
      info('修前（旧形态，R152）：任何数量的连接都能连上；限额在握手后拒绝 ⇒ `connect` → `system.error`');
      info('  → `disconnect(io server disconnect)`，`connect_error` 根本不会触发。');
      info('⚠️ 已知环境事实：网关按 **IP** 计名额、`ZREM` 释放是**异步**的 ⇒ 开新一批之前先关掉上一批并静置 400ms。');

      // ⚠️ R147：开跑前清桶。上一轮崩溃/中断残留的 member 会让「第 6 条该被拒」不确定。
      //    同时**先关掉本用例自己开着的房间客户端**（它们占着同一个 IP 的名额）。
      closeRoomClients();
      await sleep(400);
      const scan = execFileSync(
        'docker',
        ['compose', 'exec', '-T', 'redis', 'redis-cli', '--scan', '--pattern', 'ratelimit:ws-conn:*'],
        { cwd: REPO_ROOT, encoding: 'utf-8' },
      );
      const staleKeys = scan.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const key of staleKeys) {
        execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'del', key], { cwd: REPO_ROOT });
      }
      info(`开跑前清桶：删掉 ${staleKeys.length} 个残留 member（${staleKeys.join(', ') || '无'}）—— 不清的话判据不确定（R147）`);

      // ── 判别力自证（与后端实现**无关**，在任何镜像上都该绿）──────────────
      // R115：断言「第 6 条拿到 connect_error」之前，先证明**探针能看见 connect_error**。
      // 手法：**故意用错的 socket.io path**（`/definitely-not-socketio/`）⇒ engine.io 的
      // websocket 升级必然失败 ⇒ 客户端拿到 `connect_error`（实测原文 `websocket error`），
      // 且**从未** `connect`。
      // ⚠️ 为什么不用「连一个不存在的端口」（本文件上一版就是这么写的，**实测假红**）：
      //    本机 `127.0.0.1` 上未监听端口的 SYN 被**丢弃**（不是 RST）⇒ 连接**挂住**、
      //    2.5s 内什么事件都没有（R229 同族的环境事实）。而错的 path 是**已连上的 HTTP**
      //    —— 立刻失败。
      // ⚠️ 这条路径**不经过** socket.io 服务器（它只挂在 `/socket.io/`）⇒ 既不占连接名额、
      //    也不污染后面的桶（R147 的前提不被破坏）。
      const dead = await connectProbe(
        `${GATEWAY_URL}${NAMESPACE}`,
        'probe',
        1500,
        '/definitely-not-socketio/',
      );
      sockets.push(dead.socket);
      info(describeProbe('探针自证（故意用错的 socket.io path ⇒ 握手必然失败）', dead));
      checks.that(
        dead.sawConnectError && !dead.sawConnect && !dead.connected,
        '探针自证：一次**必然失败**的握手必须观测到 `connect_error` 且从未 `connect` —— ' +
          '否则第 6 条的「拿到 connect_error」是空测（R115）',
      );

      const wsUsers: HarnessUser[] = [];
      for (let i = 0; i < 7; i += 1) wsUsers.push(await registerUser(40 + i));

      const opened: Socket[] = [];
      const firstFive: ConnectProbe[] = [];
      for (let i = 0; i < 5; i += 1) {
        const probe = await tryConnect(wsUsers[i]!, 800);
        opened.push(probe.socket);
        sockets.push(probe.socket);
        firstFive.push(probe);
        info(describeProbe(`第 ${i + 1} 条连接`, probe));
      }
      checks.that(
        firstFive.every((p) => p.connected),
        '前 5 条连接静置后仍然 connected（正对照：探针能观测到连接**存活**；修前同样如此 —— 它们是限额内的合法连接）',
      );
      checks.that(
        firstFive.every((p) => p.sawConnect),
        '前 5 条都观测到了 `connect` 事件（R115 的正对照：探针确实能看见「连上」—— 否则第 6 条的「没连上」是空测）',
      );

      // ── 第 6 条：限额生效 ⇒ **传输层**拒绝（R246）───────────────────────
      const sixth = await tryConnect(wsUsers[5]!, 2000);
      sockets.push(sixth.socket);
      info(describeProbe('第 6 条连接（静置 2000ms）', sixth));
      checks.that(
        sixth.sawConnectError,
        '第 6 条连接必须拿到 **`connect_error`**（R246：限额在 `allowRequest` 里 ⇒ 传输层拒绝；' +
          '修前它先 `connect` 再被踢 ⇒ 本断言红）—— ' +
          `实际 sawConnectError=${sixth.sawConnectError}，error=${sixth.errorMessage ?? '无'}`,
      );
      checks.that(
        !sixth.sawConnect,
        '第 6 条连接**从未**收到 `connect` 事件（R246：「传输层拒绝」与「握手后踢掉」是两件事，' +
          '判据必须分得开 —— 这正是 R152 记录的旧形态与本片新形态的分界）',
      );
      checks.that(!sixth.connected, '第 6 条连接静置后**不** connected（修前：与第 1–5 条一样一直连着）');
      checks.that(
        firstFive.every((p) => p.connected),
        '第 6 条被拒之后，前 5 条**仍然** connected（限额只拒第 6 条，不是把这一 IP 的所有连接掐掉）',
      );

      // 关掉 2 条（服务端 disconnect → ZREM 释放名额），新连接必须能进来。
      for (const socket of opened.slice(0, 2)) socket.disconnect();
      await sleep(600);
      const seventh = await tryConnect(wsUsers[6]!, 800);
      sockets.push(seventh.socket);
      info(describeProbe('关掉 2 条 + 600ms 后的新连接', seventh));
      checks.that(seventh.connected, '关掉 2 条后新连接静置后 connected（证明 disconnect 的 ZREM 真的释放了名额）');

      // ── 无效 token 的自证（**形态无关**）──────────────────────────────
      // 放在**最后**：此时桶里只有 4 个 member（5 条开着 − 2 条已关 + 1 条新开），
      // 无效 token 的连接能越过 `allowRequest` 落到验签阶段。
      // ⚠️ 只断言「静置后**不** connected」：验签失败发生在 `allowRequest`（⇒ `connect_error`）
      //   还是握手之后（⇒ `connect` → `system.error` → 被踢）是**实现形态**，
      //   本判据**不钉形态**（R115/R241：判据不要钉实现形态，否则实现一动就假红）。
      const bogusUser: HarnessUser = { ...wsUsers[5]!, accessToken: 'not-a-jwt' };
      const bogus = await tryConnect(bogusUser, 1200);
      sockets.push(bogus.socket);
      info(describeProbe('探针自证（无效 token）', bogus));
      checks.that(
        !bogus.connected,
        '探针自证：无效 token 的连接静置后**不** connected（具体是 connect_error 还是握手后被踢随实现，见 info：本判据不钉形态）',
      );
    }

    // ── 9) A7（替代判据，非 e2e）：出站 fetch 必须带超时 ───────────────
    if (runs('a7')) {
      step('第 9 步 A7（**替代判据**，见文件头）：`packages/<service>/src/**` 每处出站 HTTP 调用所在文件必须带超时（R143/R150/R225 机械闸）');
      info('本步**不是** e2e：它读主检出源码。端到端「下游超时 → 10007」需要停容器构造，计划已明确不做。');
      info('R150：调用探测同时认裸 `fetch(` 与注入式 `fetchImpl(`；只用前者会漏掉 room→game 的 GameClient。');
      info('⚠️ R225（N20/P4 Task 6）：`room-service` 的内部面**从 HTTP 整条搬到 TCP RPC** 之后，');
      info('   `game.client.ts` / `robot.client.ts` **必然**再从 `fetchers` 里消失（它们改用 `ClientProxy`）。');
      info('   照抄 `packages/api-gateway/test/outbound-timeout.gate.test.ts` 判据 A′ 的改法：');
      info('   **形态判据**（「必须还在走 fetch」）与**性质判据**（「只要有出站就必须有超时」）分离 ——');
      info('   正对照只列**仍走 fetch** 的文件，已迁走的文件由「无出站 ⇒ 无违规」自然覆盖。');
      // ⚠️ 监控片（规格 §4）：`alert-relay` 入列 —— 它有三处出站 `fetch`（sinks.ts 的三个 IM
      // 槽位，`AbortSignal.timeout` 5s），必须被这条机械闸扫到（否则这个新服务包的出站面
      // 没有任何闸在看）。货币片 T1：`config-service` / `currency-service` 一并入列（钉正陈旧
      // 名单 —— 两者当前都零 `fetch`，判据是「只要有出站就必须有超时」，零命中即合规）。
      // 支付片 T2：`payment-service` 入列（同上；骨架期零 `fetch`，T6 的渠道客户端落地后受本闸约束）。
      const pkgs = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service', 'shared', 'alert-relay'];
      const files = pkgs.flatMap((pkg) => walkTs(join(REPO_ROOT, 'packages', pkg, 'src')));
      checks.atLeast(files.length, 20, `扫描到 packages/<service>/src 下的 .ts 文件数（正对照：闸确实读到了源码）`);

      const fetchers = files.filter((f) => callsFetch(readFileSync(f, 'utf-8')));
      const rel = fetchers.map((f) => repoRel(f));
      info(`发起出站 HTTP 调用的文件（${rel.length} 个）：${rel.join(', ')}`);
      // ⚠️ A7④（R209 / 切片 11）之后 `room-service/src/gateway/game.client.ts` 走注入式 `HttpService`
      //    （`timeout:`）；**R225（N20/P4）** 之后它进一步改用 `ClientProxy.send()`，`fetch(` / `fetchImpl(`
      //    两种字面量**都**不再出现 ⇒ 它**必然**从 `fetchers` 里消失。
      // 正对照只列**仍走 fetch** 的文件 —— 把「已经不该存在」的形态留在正对照里，
      // 就是让闸在自己的正对照上红（R150 的同一课，这里第三次发作）。
      for (const required of [
        'packages/api-gateway/src/gateway/proxy.gateway.ts',
        'packages/robot-service/src/robot/douzero.client.ts',
      ]) {
        checks.that(rel.includes(required), `指名正对照：机械闸扫到了 ${required}（否则「零违规」可能只是探针瞎了）`);
      }
      // 性质判据（**不钉形态** —— R225 的「形态判据与性质判据分离」）：
      // `room-service` 三处内部面调用点（Task 3 的 `game.client.ts` / `robot.client.ts` /
      // `match.service.ts`）在 N20/P4 之后走 **TCP RPC** ⇒ 它们**不得**再出现内部 HTTP 的
      // **路径字面量**（`/api/games`、`/api/robots/`）。这是 R225 后半条在 conformance 侧
      // 的对应判据，也是「迁移真的发生了」的**正向**证据 —— 只证明「探针扫不到 fetch」
      // 在旧栈上也可能绿（切片 11 教训第 7 条）。
      // 迁移前实测（本文件跑出来的原文）：`game.client.ts` 命中 4 行、`robot.client.ts` 1 行、
      // `match.service.ts` 2 行 ⇒ 本条在旧栈上是**真** RED（见 `expectMigrated` 的 xfail 说明）。
      // ⚠️ 只扫**代码行**（跳过 `//` / `*` / `/*` 开头）：迁移后文件头会写「这里原本是
      //    `/api/games`」，那是**文档**不是调用；把注释算违规会逼人删掉有价值的迁移说明。
      const RPC_PATHS = ['/api/games', '/api/robots/'];
      const codeLinesWith = (src: string, needles: string[]): string[] =>
        src
          .split('\n')
          .filter((line) => {
            const t = line.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
          })
          .filter((line) => needles.some((n) => line.includes(n)))
          .map((line) => line.trim());
      const INTERNAL_FACE_FILES = [
        'packages/room-service/src/gateway/game.client.ts',
        'packages/room-service/src/gateway/robot.client.ts',
        'packages/room-service/src/match/match.service.ts',
        // `game-service → robot-service` 的 `robot.decide`（§4.1 的第三条 TCP 边；Task 4）。
        'packages/game-service/src/game/robot.client.ts',
      ];
      /**
       * 迁移**尚未完成**的调用点（xfail）：旧栈上它们必然命中，故本条此时只作**读数**不做断言。
       *
       * ⚠️⚠️ **后端 agent 合并（N20/P4 Task 2/3/4）之后，这个列表必须清空**（改成 `[]`）——
       * 它与计划 **R225** 要求的那条闸 `packages/room-service/test/no-internal-http.gate.test.ts`
       * 是**同一判据的两处实现**，正式验收由**后端 agent 的闸**承担，本条只是 conformance 侧的
       * 「旧栈也能读」的过渡形态。
       * **不清空 ⇒ 说明有调用点漏迁**：`INTERNAL_FACE_FILES` 里的四个文件
       * （`room-service/src/gateway/{game,robot}.client.ts`、`room-service/src/match/match.service.ts`、
       * `game-service/src/game/robot.client.ts`）是 §4.1 三条 TCP 边的**全部**调用点；
       * 只要还有一个文件残留内部 HTTP 路径字面量，就有一条边没搬上 `Transport.TCP`。
       * ⚠️ 这正是 R150 / 切片 11 教训第 5 条的**第三次**发作形态（正对照会随功能落地而失效）：
       * 若把「已经不该存在」的路径留在 xfail 里，闸就会**永远绿**——比红更危险。
       */
      /**
       * ⚠️ **迁移已完成**（N20/P4 门禁期核实）：四个调用点全部改用 `RPC_PATTERNS.*`、
       * 内部 HTTP 路径字面量 0 命中 ⇒ 本清单必须为空（见下方那条自查不变式：
       * 留着它等于让本条闸永远绿）。
       */
      const NOT_YET_MIGRATED: string[] = [];
      let allFilesStillHttp = true;
      let anyRpcPatterns = false;
      for (const migrated of INTERNAL_FACE_FILES) {
        let src: string;
        try {
          src = readFileSync(join(REPO_ROOT, migrated), 'utf-8');
        } catch {
          info(`${migrated} 不存在（被移动/改名）—— 跳过该条，但请在汇报里写明`);
          continue;
        }
        const hits = codeLinesWith(src, RPC_PATHS);
        const hasRpc = src.includes('RPC_PATTERNS.');
        // ⚠️ 语义必须是「**所有**文件都还留着 HTTP 路径字面量」才为 true：
        //    早先写成「任一文件清干净就置 false」，等于问的是「**有**文件清干净了吗」，
        //    与变量名/下游判据的意图相反 ⇒ 迁移一旦**部分**完成就会误报。
        if (hits.length > 0) allFilesStillHttp = false;
        if (hasRpc) anyRpcPatterns = true;
        info(
          `${migrated}：内部 HTTP 路径字面量命中 ${hits.length} 行${hits.length ? ` → ${JSON.stringify(hits)}` : ''}；` +
            `出现 \`RPC_PATTERNS.\`=${hasRpc}`,
        );
      }
      // 判据（**形态无关**）：只要文件中**仍有**内部 HTTP 路径，它就必须带超时标记；
      // 一旦某文件**已无**路径字面量，它必须改用 `RPC_PATTERNS` 这个契约常量
      // —— 两者都不满足才是违规（既不迁、又没有超时保护）。
      // `NOT_YET_MIGRATED` 保证**迁移完成之前**本条在旧栈上不会把「还没做」的调用点
      // 误报成违规（那是本片的**目标**，不是本步要证明的**已完成项**）；
      // 迁移完成后该列表应清空 —— 汇报里必须写明它是否清空（不清空说明有调用点漏迁）。
      const migOffenders: string[] = [];
      for (const migrated of INTERNAL_FACE_FILES) {
        if (NOT_YET_MIGRATED.includes(migrated)) continue;
        let src: string;
        try {
          src = readFileSync(join(REPO_ROOT, migrated), 'utf-8');
        } catch {
          continue;
        }
        const hits = codeLinesWith(src, RPC_PATHS);
        const hasTimeout = src.includes('AbortSignal') || src.includes('signal:') || /\btimeout\s*:/.test(src);
        if (hits.length > 0 && !hasTimeout && !src.includes('RPC_PATTERNS.')) migOffenders.push(migrated);
      }
      checks.that(
        migOffenders.length === 0,
        `room-service 的内部面调用点必须「迁到 RPC」或「保留但带超时」二选一（违规：${migOffenders.join(', ') || '无'}）`,
      );
      info(
        `迁移读数：仍有内部 HTTP 路径字面量=${allFilesStillHttp ? '全部' : '部分/无'}，` +
          `出现 \`RPC_PATTERNS.\`=${anyRpcPatterns}；\`NOT_YET_MIGRATED\`=${JSON.stringify(NOT_YET_MIGRATED)}`,
      );
      // ⚠️ **自查不变式**：一旦四个调用点**都不再**出现内部 HTTP 路径字面量（迁移完成），
      //    `NOT_YET_MIGRATED` 就**失去存在理由** ⇒ 必须清空。这条把「忘了清空」从
      //    「要靠人记得」变成**判据**（否则闸会永远绿，见上面那段注释的 R150 第三次发作）。
      checks.that(
        allFilesStillHttp || NOT_YET_MIGRATED.length === 0,
        '（读作：或者还有调用点没迁，或者 xfail 必须为空）迁移已完成 ⇒ `NOT_YET_MIGRATED` 必须清空为 [] ' +
          '（它只在迁移未完成时是 xfail；留着它等于让本条闸永远绿）—— ' +
          `实际 仍有内部 HTTP 路径字面量=${allFilesStillHttp}，NOT_YET_MIGRATED=${JSON.stringify(NOT_YET_MIGRATED)}`,
      );
      // 探针判别力自证：上面那个扫描器对合成串必须正/负分明（否则「零命中」可能只是它瞎了）。
      checks.eq(
        codeLinesWith("const url = `${base}/api/games`;", RPC_PATHS).length,
        1,
        '路径扫描器正对照：代码行里的 `/api/games` 会被命中',
      );
      checks.eq(
        codeLinesWith(' * 历史：这里原本走 `/api/games`（N20 已迁移）', RPC_PATHS).length,
        0,
        '路径扫描器负对照：注释行里的 `/api/games` **不**算违规（文档不是调用）',
      );

      const offenders = fetchers
        .filter((f) => {
          const src = readFileSync(f, 'utf-8');
          return !src.includes('AbortSignal') && !src.includes('signal:') && !/\btimeout\s*:/.test(src);
        })
        .map((f) => repoRel(f));
      checks.that(
        offenders.length === 0,
        `每处出站 fetch 都带超时（违规：${offenders.join(', ') || '无'}）—— 修前 proxy.gateway.ts 既无 AbortSignal 也无 signal:`,
      );

      // 判据 B′（照抄 `outbound-timeout.gate.test.ts`）：探针自身的判别力必须自证。
      checks.that(callsFetch('const r = this.fetchImpl(`${this.baseUrl}${path}`, init);'), '探针判别力：注入式 `fetchImpl(` 会被命中');
      checks.that(callsFetch('const r = await fetch(url, opts);'), '探针判别力：裸 `fetch(` 会被命中');
      checks.that(!callsFetch('  fetchImpl?: typeof fetch;\n'), '探针判别力：`typeof fetch` 不带括号，**不**命中');
      checks.that(
        !callsFetch('const r = lastValueFrom(this.proxy.send(pattern, payload).pipe(timeout(3000)));'),
        '探针判别力：`ClientProxy.send()` + rxjs `timeout(` **不**被误判成出站 HTTP（R225 的形态分离）',
      );
    }

    // ── 10) N9：`room:{code}` 必须是 §10.1 的 **Hash**（R249）───────────
    if (runs('n9')) {
      step(
        `第 10 步 N9：\`room:{code}\` 必须是 §10.1 的 **Hash**（字段集恰好 ${ROOM_META_FIELDS.length} 个 + ` +
          `TTL ${ROOM_TTL_SECONDS}s），而**不是** String(JSON)`,
      );
      info('修前（master 实测，2026-09-16）：`TYPE room:<code>` = **string**；`HKEYS` 报 WRONGTYPE；');
      info('  `GET room:<code>` 返回 `{"code":"…","mode":"random","baseScore":100,"maxPlayers":3,"status":"waiting","createdAt":…}`');
      info('  （既不是 Hash、也少 §3.1 的 `timeoutAt` —— E6/N9 两条偏差的活体形态）。');
      info('⚠️ 房号取自一条**真实的** `POST /api/rooms`（经网关）—— **不自己 `SET` 造键**：');
      info('   自造的键只能证明「我们把键写成了 hash」，证明不了**产品**写的是 hash。');

      // ⚠️ **顺序**（`run.js` 是 fail-fast）：判别力自证排在**会红的分组之前** ——
      //    修前 `TYPE` 就是 `string`，若把自证放在它后面，「谓词看得见多/少字段」这几行
      //    在 RED 现场**永远看不到**（R193③ / `slice-07.2-rpc` 的同一纪律）。
      //    自证是**纯函数**（不碰 Redis：本切片的 Redis 探针只读，§海森堡）。
      checks.eq(
        fieldSetViolations(['a', 'b'], ['a']).join('|'),
        '多 b',
        '探针正对照：字段集谓词能看出「多了一个字段」',
      );
      checks.eq(
        fieldSetViolations(['a'], ['a', 'b']).join('|'),
        '缺 b',
        '探针正对照：字段集谓词能看出「少了一个字段」',
      );
      checks.eq(
        fieldSetViolations(['a'], ['a']).length,
        0,
        '探针负对照：字段集**完全一致**时不报违规',
      );

      const a = await ensurePrimary();
      const created = await postJson<{ code?: string }>('/api/rooms', { mode: 'random' }, a.accessToken);
      info(`经网关 POST /api/rooms {mode:'random'} → HTTP ${created.status}，body=${JSON.stringify(created.body)}`);
      checks.eq(created.status, 201, 'POST /api/rooms 的 HTTP 状态（§7.1）');
      checks.eq(created.body?.code, ErrCode.OK, 'POST /api/rooms 的 body.code');
      const roomCode = String(created.body?.data?.code ?? '');
      checks.that(
        /^[0-9A-Z]{6}$/.test(roomCode),
        `新建房间的房号形状（§3.1：6 位大写字母/数字）—— 实际 ${JSON.stringify(roomCode)}`,
      );
      if (!/^[0-9A-Z]{6}$/.test(roomCode)) {
        throw new ConformanceError(`N9 前置失败：没有拿到合法房号（body=${JSON.stringify(created.body)}）`);
      }
      const roomKey = `room:${roomCode}`;

      // ① 类型：Hash（键不存在时 `TYPE` 返回 `none` ⇒ 这条也会红，消息里能看出区别）
      const type = redisCli(['TYPE', roomKey]).trim();
      const ttl = Number(redisCli(['TTL', roomKey]).trim());
      const fields = redisLines(['HKEYS', roomKey]);
      const getReply = redisRaw(['GET', roomKey]);
      const getText = redisReplyText(getReply);
      info(`现场：TYPE=${type}，TTL=${ttl}，HKEYS=${JSON.stringify(fields)}`);
      info(`      GET ${roomKey} → ${JSON.stringify(getText)}（Hash 上读它**必须**报 WRONGTYPE）`);
      checks.eq(
        type,
        'hash',
        `TYPE ${roomKey}（§10.1 逐字：**Hash**；修前是 string）`,
      );

      // ② 字段集：**恰好** §10.1 的 8 个（多一个/少一个都红 —— 防悄悄多/少，R249）
      const fieldViolations = fieldSetViolations(fields, ROOM_META_FIELDS);
      checks.that(
        fieldViolations.length === 0,
        `HKEYS ${roomKey} 的字段集必须**恰好**是 §10.1 的 ${ROOM_META_FIELDS.length} 个 ` +
          `（${ROOM_META_FIELDS.join('/')}）—— 实际 ${JSON.stringify(fields)}（${fieldViolations.join('、') || '无差异'}）`,
      );

      // ③ TTL：Hash 化最容易丢的就是 `EXPIRE`（String 的 `SET EX` 是一次性的）
      checks.that(
        Number.isInteger(ttl) && ttl > 0 && ttl <= ROOM_TTL_SECONDS,
        `TTL ${roomKey} 必须在 (0, ${ROOM_TTL_SECONDS}] 内（§10.1：TTL ${ROOM_TTL_SECONDS}s；` +
          `Hash 化时最容易被丢掉的就是这条 EXPIRE）—— 实际 ${ttl}`,
      );

      // ④ 反向：`GET` 必须报 WRONGTYPE —— 证明确实**不是** String（修前这里返回 String(JSON)）
      checks.that(
        /WRONGTYPE/i.test(getText),
        `GET ${roomKey} 必须报 WRONGTYPE（§10.1：它是 Hash ⇒ 用 GET 读它就是错的）—— 实际 ${JSON.stringify(getText)}`,
      );
    }

    // ── 11) §12.4 闸「真的拦得住」（R115/R268/R291；P5 / Task 5 Step 2）──
    if (runs('gate')) {
      step(
        '第 11 步 §12.4/R268：CI 第 6 阶段的五条源码闸「**真的拦得住**」' +
          '—— 接线静态判据 + 两次**注入**探针（两种不同形态的闸）',
      );
      info('为什么必须注入：本仓的失败模式不是闸太松，而是闸**恒绿**');
      info('  （`allFilesStillHttp` / `NOT_YET_MIGRATED` / 切片 11 第 5・6 组的相对量判据都绿着漏掉了真缺陷）');
      info('  ⇒「跑绿了」不等于「拦得住」：一条从未在违规输入上红过的闸与不存在没有区别（R115）。');

      // ── (a) `scripts/ci.sh` 第 6 阶段的**接线**判据（只读，不改任何产品文件）──
      const ciSh = readText(join(REPO_ROOT, 'scripts', 'ci.sh'));
      const wirings = extractGateWirings(ciSh);
      info(
        `scripts/ci.sh 提取到 ${wirings.length} 条 run_gate 接线：` +
          `${wirings.map((g) => `${g.pkg}/${g.filter}`).join('、') || '无'}`,
      );
      // 探针判别力自证（合成输入，不碰真实文件）：
      const synthetic = extractGateWirings(
        'run_gate "probeA/不存在" \\\n  pnpm --filter @fight-the-landlord/client test -- definitely-not-a-real-gate\n',
      );
      checks.eq(
        synthetic.length,
        1,
        '探针正对照：接线提取器能从合成 ci.sh 里读出一条 `run_gate`（否则「零违规」可能只是提取器瞎了）',
      );
      const syntheticViolations = gateWiringViolations(synthetic, () => ['source-boundary.test.ts']);
      checks.atLeast(
        syntheticViolations.length,
        2,
        '探针正对照：合成输入（过滤名匹配不到文件 + 缺少应跑的闸）必须报违规',
      );
      info(`   ↳ 判据原文：${syntheticViolations.join('；')}`);
      checks.eq(
        gateWiringViolations(
          wirings,
          (pkg) => EXPECTED_GATES.filter((g) => g.pkg === pkg).map((g) => `${g.filter}.test.ts`),
        ).length,
        0,
        '探针负对照：真实接线 + 一个「每个过滤名都能找到同名文件」的合成解析器 ⇒ 不报违规',
      );
      checks.atLeast(
        packageTestFiles('game-service', REPO_ROOT).length,
        1,
        '解析器正对照：`packages/game-service/test` 下确实有测试文件（否则上面的接线判据会因「读不到目录」而假红）',
      );
      const wiringViolations = gateWiringViolations(wirings, (pkg) => packageTestFiles(pkg, REPO_ROOT));
      checks.that(
        wiringViolations.length === 0,
        `第 6 阶段的六条闸必须都接在**真实存在**的测试文件上、且 EXPECTED_GATES 里的六条齐全：` +
          `${wiringViolations.join('；') || '无差异'}`,
      );

      /**
       * 「注入 ⇒ 必须红 ⇒ 恢复 ⇒ 必须重新绿」的通用执行器（两条探针共用）。
       *
       * ⚠️ **先跑基线**：注入前必须是绿的 —— 否则「注入后红」不可归因到注入（可能本来就红）。
       * ⚠️ 恢复在 `finally` 里，且**断言**文件真的没了（门禁会审查 git 状态）。
       */
      const injectionProbe = (
        label: string,
        path: string,
        content: string,
        attributable: readonly string[],
        command: readonly string[],
      ): void => {
        const relPath = repoRel(path);
        const prog = command[0]!;
        const argv = command.slice(1);
        const baseline = runProc(prog, argv, { cwd: REPO_ROOT, timeoutMs: 180_000 });
        checks.eq(
          baseline.status,
          0,
          `注入前 \`${label}\` 必须先绿（实际退出码 ${baseline.status}）—— 否则「注入后红」不可归因`,
        );
        let bodyError: unknown;
        let cleanupProblem: string | undefined;
        try {
          createTempFile(path, content);
          checks.that(existsSync(path), `探针文件已注入：${relPath}`);
          const red = runProc(prog, argv, { cwd: REPO_ROOT, timeoutMs: 180_000 });
          info(`注入后 \`${label}\` 退出码=${red.status}`);
          info(`  输出尾部：\n   ${red.output.trim().split('\n').slice(-16).join('\n   ')}`);
          checks.that(
            red.status !== 0,
            `注入违规输入后 \`${label}\` **必须非零退出**（实际 ${red.status}）—— ` +
              '否则 CI 第 6 阶段是空跑（R115/R268）',
          );
          const probeName = relPath.split('/').pop()!;
          checks.that(
            red.output.includes(probeName),
            `RED 输出必须**点名**注入的文件 \`${probeName}\`（否则红的原因可能不是本探针）`,
          );
          for (const needle of attributable) {
            checks.that(
              red.output.includes(needle),
              `RED 输出必须点到 \`${needle}\`（把红归因到本探针要抓的那条规则）`,
            );
          }
        } catch (err) {
          bodyError = err;
        } finally {
          restorePath(path);
          if (existsSync(path)) {
            cleanupProblem = `注入文件未被删除（残留 ${path}）—— 门禁会审查 \`git status\`，这是环境污染`;
          }
        }
        if (cleanupProblem !== undefined) {
          throw new ConformanceError(
            bodyError === undefined
              ? cleanupProblem
              : `${cleanupProblem}；此外体内断言先失败：${bodyError instanceof Error ? bodyError.message : String(bodyError)}`,
          );
        }
        if (bodyError !== undefined) throw bodyError;
        checks.ok(`收尾：注入文件已删除（${relPath} 不存在）`);
        const after = runProc(prog, argv, { cwd: REPO_ROOT, timeoutMs: 180_000 });
        info(
          `恢复后 \`${label}\` 退出码=${after.status}，尾部：` +
            `${after.output.trim().split('\n').slice(-3).join(' | ')}`,
        );
        checks.eq(
          after.status,
          0,
          `删除注入文件后 \`${label}\` 必须重新零退出（实际 ${after.status}）—— 证明刚才的红是注入造成的`,
        );
      };

      // ── (b) 注入探针 A：`source-boundary`（**禁止字面量**形态的闸）──
      info('探针 A（形态：扫描 `apps/client/src` 里的禁止标识符/字面量）：注入一个含底分字面量的文件。');
      injectionProbe(
        'client/source-boundary',
        PROBE_CLIENT_PATH,
        PROBE_CLIENT_SRC,
        ['baseScore'],
        ['pnpm', '--filter', '@fight-the-landlord/client', 'test', '--', 'source-boundary'],
      );

      // ── (c) 注入探针 B：`rule-error-mapping`（**集合覆盖**形态的闸）──
      // ⚠️ 必须与实践 A **形态不同**：它比对的是「`shared/src/{ddz,rule}` 的 throw 站点集合 ⊆ 映射表」，
      //    没有任何「禁止字面量」的扫描。一条闸有效**不等于**五条闸都有效（计划 Task 5 Step 2 的建议）。
      info('探针 B（形态：`shared/src/{ddz,rule}` 的每个 throw 站点都必须有 RULE_ERROR_MAPPINGS 条目）：');
      info('  注入一个未映射的 `throw new Error(…)` —— 它与探针 A 的「扫描禁止字面量」是**两种不同形态**。');
      injectionProbe(
        'game-service/rule-error-mapping',
        PROBE_SHARED_PATH,
        PROBE_SHARED_SRC,
        ['conformance probe: this rule error maps to nothing'],
        ['pnpm', '--filter', '@fight-the-landlord/game-service', 'test', '--', 'rule-error-mapping'],
      );
    }

    // ── 12) §13.3 覆盖率门槛「真的会失败」（R270/R289/R290；Step 3）────
    if (runs('cov')) {
      step(
        '第 12 步 §13.3/R270：`packages/shared` 的行覆盖率门槛 —— **读配置**断言 80 + **变异自证**' +
          '（80 ⇒ 绿 / 99 ⇒ 必须红 / 恢复 80 ⇒ 必须绿）',
      );
      info('⚠️ 这条**改的是产品配置文件**（`packages/shared/vitest.config.ts`）⇒ 恢复是三层保险：');
      info('  `finally` + `process.on("exit")` + `SIGTERM/SIGINT/SIGHUP`（见 `lib/probe.ts`）。');
      const before = readText(SHARED_VITEST_CONFIG);
      const thresholdMatch = /thresholds\s*:\s*\{[^}]*\blines\s*:\s*(\d+)/.exec(before);
      checks.that(
        thresholdMatch !== null,
        '`packages/shared/vitest.config.ts` 必须显式写着 `thresholds: { lines: <n> }`（R270：门槛要写进配置）',
      );
      checks.eq(Number(thresholdMatch![1]), 80, '§13.3 的门槛值（读的是**配置原文**，不是运行结果）');
      checks.that(
        /include\s*:\s*\[\s*['"]src\/\*\*['"]\s*\]/.test(before),
        "`coverage.include` 必须是 `['src/**']`（R270：默认 include 会把入口与测试文件一起夹带进来）",
      );
      info('R289：`coverage.exclude` 是**整体覆盖**而不是增量 —— 必须延用 `coverageConfigDefaults.exclude` 打头。');
      checks.that(
        before.includes('coverageConfigDefaults.exclude'),
        '`coverage.exclude` 必须以 `coverageConfigDefaults.exclude` 打头（R289：自写数组会把默认排除一并取消）',
      );

      // 变异：`lines: 80` ⇒ `lines: 99`（用函数式替换，避免 `$` 转义歧义）
      const mutated = before.replace(
        /(thresholds\s*:\s*\{[^}]*\blines\s*:\s*)80/,
        (_match, prefix: string) => `${prefix}99`,
      );
      checks.that(
        mutated !== before,
        '变异必须**真的落到配置文本里**（否则下面的「99 ⇒ 红」是空测 —— 与闸恒绿同一个形状）',
      );
      backupForMutation(SHARED_VITEST_CONFIG);
      let covError: unknown;
      let restoreProblem: string | undefined;
      try {
        writeFileSync(SHARED_VITEST_CONFIG, mutated);
        info('已把 `thresholds.lines` 临时改成 **99**（原始内容已备份，恢复用**原文**而不是重新拼写）。');
        const red = runProc('pnpm', ['--filter', '@fight-the-landlord/shared', 'test:coverage'], {
          cwd: REPO_ROOT,
          timeoutMs: 240_000,
        });
        info(`变异后 \`test:coverage\` 退出码=${red.status}`);
        info(`  输出尾部：\n   ${red.output.trim().split('\n').slice(-10).join('\n   ')}`);
        checks.that(
          red.status !== 0,
          `门槛抬到 99 后 \`test:coverage\` **必须非零退出**（实际 ${red.status}）—— ` +
            '不证明「它会失败」就等于没有门槛（R270）',
        );
        checks.that(red.output.includes('99'), 'RED 输出必须点到 `99`（归因到门槛，而不是别的失败）');
        checks.that(
          /threshold|Coverage|coverage/i.test(red.output),
          'RED 输出必须是**覆盖率门槛**的失败原文（不是「测试挂了」——那与门槛无关）',
        );
      } catch (err) {
        covError = err;
      } finally {
        restorePath(SHARED_VITEST_CONFIG);
        let now = '';
        try {
          now = readText(SHARED_VITEST_CONFIG);
        } catch {
          now = '<读不到>';
        }
        if (now !== before) {
          restoreProblem = `恢复失败：\`${SHARED_VITEST_CONFIG}\` 的内容与变异前的备份**不完全一致**`;
        }
      }
      if (restoreProblem !== undefined) {
        throw new ConformanceError(
          covError === undefined
            ? restoreProblem
            : `${restoreProblem}；此外体内断言先失败：${covError instanceof Error ? covError.message : String(covError)}`,
        );
      }
      if (covError !== undefined) throw covError;
      const restored = readText(SHARED_VITEST_CONFIG);
      checks.that(
        restored === before,
        '恢复后文件内容与变异前**逐字相同**（用原始字符串备份恢复，不是重新拼写）',
      );
      info(
        `  恢复校验：sha256(变异前)=${sha256(before)}，sha256(现状)=${sha256(restored)}，长度 ${before.length}B`,
      );
      checks.eq(pendingRestoreCount(), 0, '没有遗留待恢复项（探针的恢复账本必须清空）');

      const green = runProc('pnpm', ['--filter', '@fight-the-landlord/shared', 'test:coverage'], {
        cwd: REPO_ROOT,
        timeoutMs: 240_000,
      });
      info(`恢复门槛 80 后 \`test:coverage\` 退出码=${green.status}`);
      checks.eq(green.status, 0, `恢复门槛 80 后 \`test:coverage\` 必须零退出（实际 ${green.status}）`);
      const allFiles = /All files\s*\|\s*([\d.]+)/.exec(green.output);
      if (allFiles !== null) {
        info(`  实测行覆盖率（All files）= ${allFiles[1]}%（R290 记录的门禁读数：97.58%）`);
      }
    }

    return checks;
  } finally {
    closeRoomClients();
    for (const socket of sockets) socket.disconnect();
    for (const client of clients) client.close();
  }
}
