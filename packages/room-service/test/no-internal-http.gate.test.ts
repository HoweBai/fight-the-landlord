/**
 * N20/P4 Task 5（R225）：**源码级机械闸** —— 「内部面不得再出现 HTTP」。
 *
 * ─── 判据为什么这样设计（切片 11 教训第 5、7 条）────────────────────────
 *  - **第 5 条**：机械闸的「正对照」会随功能落地而**必然**失效。切片 11 的 A7④ 把
 *    `game.client.ts` 从 `fetch` 改成注入式 `HttpService` 之后，`outbound-timeout.gate.test.ts`
 *    里「该文件必须出现在 `callsFetch` 命中集」的正对照**注定变红**。
 *    本片它又变了一次（`HttpService` → `ClientProxy`），所以我们**不钉形态**：
 *    钉的是「内部面**没有** HTTP 出站」这个**性质**。
 *  - **第 7 条**：「没扫到坏东西」在**旧栈**上也可能是绿的 ⇒ 判别力必须来自**正向**断言。
 *    因此本闸的第一组判据是**正向**的：四个调用点（+ `game-service` 的 `robot.decide`
 *    客户端）必须**真的**在用 `RPC_PATTERNS.*`。少了它，下面那些「不得出现 X」的扫描
 *    在「文件被删空 / 被改名」时也会全绿。
 *
 * ─── R179：路径不得用固定层数的相对路径 ──────────────────────────────────
 * `join(REPO, ...)` 式写法一旦层数算错，会**静默**扫到**主检出**（`.worktrees/<role>/`
 * 之外）的同名旧文件 ⇒ 闸恒绿。因此这里从本文件所在目录**向上找** `packages/room-service`
 * 这个锚点（同名 `package.json` 校验），找不到就**抛错**（不静默变成空测）。
 *
 * ─── R226 的 `NOT_YET_MIGRATED` 清单覆盖情况 ─────────────────────────────
 * conformance 侧列了 4 个「迁移前仍走 HTTP」的文件：
 *   room 的 `gateway/game.client.ts` / `gateway/robot.client.ts` / `match/match.service.ts`、
 *   game 的 `game/robot.client.ts`。
 * 本闸的 `RPC_CLIENTS` **逐一对上这 4 个文件**（前三个在 room 侧调用点里，
 * 第四个是 `game` 的那条），并额外加了两条结构性判据（`game.controller.ts` 的两条内部路由不得复活、
 * `game-service` 不得出现 `ROBOT_SERVICE_URL`）与**本片新增的** `gateway/config.client.ts`
 * （不在 R226 清单里 —— 它生来就是 RPC-only，列进来是为让 pattern 名不手写这条对它也有牙齿）。
 * 因此本闸**不需要**「白名单/待迁移清单」这个概念 ——
 * 清单为空是「迁移完成」的结果，而不是本闸的一个状态。
 *
 * ─── 片②（T10/J19）的三处 ───────────────────────────────────────────────
 *  - `RPC_USAGE` 加第 9 条 `robotAvailability`：它的唯一发送点是 `RobotClient.availability()`
 *    （`gateway/robot.client.ts` —— **已在两张清单里 ⇒ 无需增行**，另有一条断言把落点钉住）；
 *    ⚠️ 只加名字不配负对照 = 无效补丁（本闸是「每文件至少一处 pattern 用法」的**正向**判据，
 *    负例见「探针判别力」里手写字面量的两条）。
 *  - `RPC_PATTERNS` 的恰好键集（货币片 T4 后**十二键**）由 `messages.test.ts` 覆盖，本闸**不重复**。
 *
 * ─── 记录片 T5 的一处 ────────────────────────────────────────────────────
 *  - `RPC_USAGE` 加第 10 条 `recordWrite`（唯一发送点 = `gateway/record.client.ts`）——
 *    该文件是**新边**（room → user 的 `record.write`），**两张清单同提交 +1 行**
 *    （它不像 `robotAvailability` 那样寄生在既有文件里）；探针的正/负两行见下。
 *    ⇒ 本条闸的「同提交五处」= RPC_USAGE 分支 + 两张清单 + 探针正/负两行。
 *
 * ─── 货币片 T6 的一处（返回边的扩展）─────────────────────────────────────
 *  - `RPC_USAGE` 加第 11 条 `currencyApply`（发送点 = **user-service** 的
 *    `src/currency/currency.client.ts` —— user → currency 的 `currency.apply`，注册赠送）；
 *    user 侧文件是**新边**（不在 room 的两张清单里，**勿往 room 清单塞 user 文件**）
 *    ⇒ 单列 `USER_RPC_CLIENTS` 扫描面 + 探针正/负两行 + 锚点校验一行，同提交。
 *
 * ─── 风控片 T3 的一处 ────────────────────────────────────────────────────
 *  - `RPC_USAGE` 加第 12 条 `riskDeviceReport`（唯一发送点 = `gateway/risk.client.ts`，
 *    room → user 的 `risk.deviceReport` —— user-service 3101 边上的**第二条**、
 *    恒 fire-and-forget）；该文件是**新边**、生来 RPC-only ⇒ **两张清单同提交 +1 行**
 *    （与记录片 T5 同形）+ 探针正/负两行（见下）。
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';

/**
 * 从本文件所在目录**向上**找到仓库根（以 `packages/room-service` 为锚）。
 *
 * ⚠️ R179：**不得**写 `join(REPO, '../../..')` 这种固定层数 —— 层数一错就静默扫到
 * 主检出的旧文件，闸恒绿。找不到锚点必须**抛错**（宁可红，也不要空测）。
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'room-service', 'package.json');
    const gameAnchor = join(dir, 'packages', 'game-service', 'package.json');
    if (existsSync(anchor) && existsSync(gameAnchor) && statSync(anchor).isFile()) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `找不到仓库根（以 packages/room-service + packages/game-service 为锚），起点见 R179 的说明`,
  );
}

const REPO = findRepoRoot();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

/** 内部面的 HTTP 路径（被 TCP RPC 取代的那几条）。 */
const INTERNAL_HTTP_PATH = /\/api\/(games|robots)(\/|\b)/;

/**
 * 内部面的 RPC pattern 用法（**正向**判据）。
 *
 * 片②（T10/J19）：加第 9 条 `robotAvailability`（唯一发送点 = `RobotClient.availability()`）。
 * 片⑦（T6）：第 8 条 `baseScoreLevels` → **`configSnapshot`**（`config.client.ts` 的 RPC 边
 * 由「room → user 读档位表」改为「room → config-service 拉全量快照」；旧 pattern 已从
 * protocol 删除 ⇒ 不改这里，本闸的正向断言（每个 RPC_CLIENTS 文件必须命中）当场红。
 * 名单换、总数仍九）。
 * 记录片（T5）：加第 10 条 `recordWrite`（唯一发送点 = `gateway/record.client.ts`，
 * room → user 的 `record.write` —— user-service 重挂 TCP 3101 后的唯一消费者）。
 * 货币片（T6）：加第 11 条 `currencyApply`（唯一发送点 = **user-service** 的
 * `src/currency/currency.client.ts`，user → currency 的 `currency.apply` —— 注册赠送的
 * 写边；该文件在 `USER_RPC_CLIENTS` 扫描面里，**不在** room 的两张清单里）。
 * 风控片（T3）：加第 12 条 `riskDeviceReport`（唯一发送点 = `gateway/risk.client.ts`，
 * room → user 的 `risk.deviceReport` —— fire-and-forget；该文件在两张 room 清单里）。
 */
const RPC_USAGE =
  /RPC_PATTERNS\.(gameStart|gameSnapshot|gameView|gameAction|robotAcquire|robotRelease|robotDecide|configSnapshot|robotAvailability|recordWrite|currencyApply|riskDeviceReport)/;

/**
 * 迁移后**必须**走 TCP RPC 的客户端文件。
 *
 * ⚠️ 这就是 conformance 侧 `NOT_YET_MIGRATED` 清单的那 4 个文件 —— 逐一对上
 * （本片新增的 `gateway/config.client.ts` 不在那份清单里：它**生来**就是 RPC 客户端，
 *  从未走过内部 HTTP；列进来是为让「pattern 名不得手写」对它也有牙齿。
 *  记录片 T5 的 `gateway/record.client.ts` 与风控片 T3 的 `gateway/risk.client.ts`
 *  同族 —— 新边、生来 RPC-only，同提交入列）。
 */
const RPC_CLIENTS = [
  'packages/room-service/src/gateway/game.client.ts',
  'packages/room-service/src/gateway/robot.client.ts',
  'packages/room-service/src/gateway/config.client.ts',
  'packages/room-service/src/gateway/record.client.ts',
  // 风控片 T3：room → user 的第二条边（`risk.deviceReport`；生来 RPC-only，同 record 纪律）。
  'packages/room-service/src/gateway/risk.client.ts',
  'packages/room-service/src/match/match.service.ts',
  'packages/game-service/src/game/robot.client.ts',
] as const;

/** `game-service` 侧那条边（`robot.decide`）—— 单独列，判据同形。 */
const GAME_ROBOT_CLIENT = 'packages/game-service/src/game/robot.client.ts';

/**
 * 六个 `room-service` 的调用点（三个旧 HTTP 路径的宿主 + 三个新边 RPC-only 客户端：
 * 片⑦ 的 config.client、记录片 T5 的 record.client、风控片 T3 的 risk.client）。
 */
const ROOM_CALL_SITES = [
  'packages/room-service/src/gateway/game.client.ts',
  'packages/room-service/src/gateway/robot.client.ts',
  'packages/room-service/src/gateway/config.client.ts',
  'packages/room-service/src/gateway/record.client.ts',
  // 风控片 T3：`risk.deviceReport` 的发送点（同两张清单同提交 +1 行）。
  'packages/room-service/src/gateway/risk.client.ts',
  'packages/room-service/src/match/match.service.ts',
] as const;

/**
 * 货币片 T6：**user-service 侧**的新发送边（user → currency 的 `currency.apply`，注册赠送）。
 *
 * ⚠️ **不得**把它塞进 `RPC_CLIENTS` / `ROOM_CALL_SITES`（那两张清单是 **room-service**
 * 的调用点，塞进来既会让「room 调用点都 import ClientProxy」的锚点校验失真，也会把两个
 * 服务的判据混成一张表）；同形的正向/反向/锚点判据在下面单列一行套用。
 */
const USER_RPC_CLIENTS = ['packages/user-service/src/currency/currency.client.ts'] as const;

// ─── 探针（各自带判别力自证）────────────────────────────────────────────

/**
 * 剥注释：**唯一真源** = `@fight-the-landlord/test-utils`（台账 N46 收敛；守卫语义见其 JSDoc）。
 *
 * ⚠️ 这一步是必须的，不是洁癖：迁移后的文件**有意**在注释里保留历史注记
 * （「旧的 `POST /api/robots/decide` + `X-Internal-Token`」、指向
 * `no-internal-http.gate.test.ts` 的说明）—— 计划明确要求「不隐去历史」。
 * 把注释算成违规会让闸**误伤自己**：第一版实测就在这里红了
 * （`robot.client.ts` 的注释里有 `HttpService` 与 `ROBOT_SERVICE_URL` ⇒ 假阳性）。
 *
 * ⚠️ **本文件旧实现的已知假阴性已被真源修掉**：收敛前的无守卫副本会把
 * `const url = "http://evil/api/games";` 截成 `const url = "http:` ⇒ 本文件的
 *「内部 HTTP 出站」判据**看不见它**；真源带 `:` 守卫、URL 照留（正对照见探针的「正」组，
 * 收敛后该形态必须命中）。
 */

/**
 * 该源码是否**真的**在做内部 HTTP 出站（只看代码，不看注释）。
 *
 * 认三种形态：
 *  ① `HttpService` 注入 / 调用（`this.http.post(...)`）；
 *  ② 裸 `fetch(...)`；
 *  ③ 拼出 `/api/(games|robots)` 路径 —— 含 `http(s)://…/api/…` 与
 *     `` `${baseUrl}/api/games/…` `` 的模板串。
 */
const CALLS_INTERNAL_HTTP = (src: string): boolean => {
  const code = stripComments(src);
  return (
    /HttpService/.test(code) ||
    /\bthis\.http\.\w+\(/.test(code) ||
    // 裸 fetch：`fetch(` 前不能是 `.`（排除 `this.fetchX(`）或单词字符（排除 `prefetch(`）
    /(^|[^\w.])fetch\s*\(/m.test(code) ||
    /https?:\/\/[^\s'"`]*\/api\/(games|robots)/.test(code) ||
    /\/api\/(games|robots)(\/|['"`\s]|$)/.test(code)
  );
};

/** 迁移后的客户端**不得**再出现 `ROBOT_SERVICE_URL` / `GAME_SERVICE_URL`（§2.3）。 */
const USES_SERVICE_URL_ENV = (src: string): boolean =>
  /(ROBOT|GAME)_SERVICE_URL/.test(stripComments(src));

/** `game-service` 的内部 HTTP 路由（被 RPC 取代的两条）。 */
const HAS_EMPTY_POST_ROUTE = (src: string): boolean => /@Post\(\s*\)/.test(stripComments(src));
const HAS_SNAPSHOT_ROUTE = (src: string): boolean =>
  /:roomCode\/snapshot/.test(stripComments(src));

describe('N20/P4：内部面不得残留 HTTP（R218/R225）', () => {
  it('R179：仓库根锚点找得到（找不到就抛错，绝不静默变成空测）', () => {
    expect(existsSync(join(REPO, 'packages', 'room-service', 'src'))).toBe(true);
    expect(existsSync(join(REPO, 'packages', 'game-service', 'src'))).toBe(true);
  });

  /**
   * **正向判据**（切片 11 教训第 7 条）：七个调用点都**真的**在用 `RPC_PATTERNS.*`。
   *
   * 没有这一条，下面那些「不得出现 X」的反向扫描在「文件被删空 / 被改名 / 锚点找错」
   * 时**也会全绿** —— 那是「没扫到坏东西」的假安全。
   */
  it('正向：七个调用点都真的在用 RPC pattern（否则下面的反向判据可能是空测）', () => {
    for (const rel of RPC_CLIENTS) {
      expect(RPC_USAGE.test(read(rel)), `${rel} 没有 RPC pattern 用法 —— 反向判据会退化成空测`).toBe(
        true,
      );
    }
  });

  it('反向：七个调用点都不得再做内部 HTTP 出站（不含注释里的历史注记）', () => {
    for (const rel of RPC_CLIENTS) {
      expect(
        CALLS_INTERNAL_HTTP(read(rel)),
        `${rel} 仍在做内部 HTTP 出站 —— 一次全切（R218）被破坏了`,
      ).toBe(false);
    }
  });

  it('反向：七个调用点都不得再读 *_SERVICE_URL（§2.3：那两条已迁到 *_RPC_HOST/PORT）', () => {
    for (const rel of RPC_CLIENTS) {
      expect(USES_SERVICE_URL_ENV(read(rel)), `${rel} 仍在读 *_SERVICE_URL`).toBe(false);
    }
  });

  /**
   * 结构性判据：`game-service` 的两条**内部专用** HTTP 路由不得复活。
   *
   * `@MessagePattern` 那一侧由 `packages/game-service/test/game.rpc.test.ts` 的
   * 「pattern 名逐字来自 `RPC_PATTERNS`」正向覆盖 —— 这里只钉「HTTP 面没把它们加回来」。
   */
  it('game-service 的内部 HTTP 路由不得复活（只由 @MessagePattern 侧提供）', () => {
    const ctrl = read('packages/game-service/src/game/game.controller.ts');
    expect(HAS_EMPTY_POST_ROUTE(ctrl), '`@Post()`（POST /api/games = game.start）不得复活').toBe(false);
    expect(HAS_SNAPSHOT_ROUTE(ctrl), '`:roomCode/snapshot`（game.snapshot）不得复活').toBe(false);
  });

  it('game-service 的 robot.decide 客户端不得再读 ROBOT_SERVICE_URL', () => {
    expect(USES_SERVICE_URL_ENV(read(GAME_ROBOT_CLIENT))).toBe(false);
  });

  /**
   * **探针判别力自证**（正/负对照）—— 照抄 `outbound-timeout.gate.test.ts` 判据 B′ 的手法。
   *
   * ⚠️ 每条探针都必须同时有**正**（合成串命中）与**负**（合成串不命中）两个方向：
   * 只测正向无法证明它不会误伤；只测负向无法证明它看得见。
   */
  it('探针判别力（正/负对照）', () => {
    // ── CALLS_INTERNAL_HTTP：正（真实旧实现的四种形态）──────────────────
    expect(CALLS_INTERNAL_HTTP('await this.http.post(`${base}/api/robots/acquire`, dto)')).toBe(true);
    expect(CALLS_INTERNAL_HTTP("fetch('http://game-service:3003/api/games', init)")).toBe(true);
    // ⚠️ N46：收敛前的无守卫剥离器会把这一行截成 `const url = "http:` ⇒ 本判据**看不见它**
    //    （台账 N46 逐字登记过的假阴性）。真源带 `:` 守卫、URL 照留 ⇒ 这条必须命中 ——
    //    这就是「判别力不降反升」的直接证据。
    expect(CALLS_INTERNAL_HTTP('const url = "http://evil/api/games";')).toBe(true);
    expect(CALLS_INTERNAL_HTTP('const url = `${baseUrl}/api/games/${code}`;')).toBe(true);
    expect(CALLS_INTERNAL_HTTP('constructor(private readonly http: HttpService) {}')).toBe(true);
    expect(
      CALLS_INTERNAL_HTTP("const r = await fetch(`${process.env.ROBOT_SERVICE_URL}/api/robots/acquire`);"),
    ).toBe(true);

    // ── CALLS_INTERNAL_HTTP：负（迁移后的真实形态 + 注释里的历史注记）────
    expect(CALLS_INTERNAL_HTTP('this.proxy.send(RPC_PATTERNS.gameStart, dto)')).toBe(false);
    // ⚠️ 注释探针必须写成**真实形态**（`/* … */` 完整块、或 `//` 行）；
    // 第一版我写了「半行 JSDoc 续行」（缺开头的 `/*`）—— 那不是注释，
    // 探针如实报了 true，是**我的对照写错了**，不是探针坏了（保留此注记）。
    expect(CALLS_INTERNAL_HTTP('/* 旧的 `POST /api/robots/decide` + X-Internal-Token */')).toBe(false);
    expect(CALLS_INTERNAL_HTTP('// 本文件不再出现 `/api/games` 之类的内部 HTTP 路径')).toBe(false);
    expect(CALLS_INTERNAL_HTTP('// 见 `test/no-internal-http.gate.test.ts`')).toBe(false);
    // 这两条是**第一版实测红过**的假阳性来源（注释里的 `HttpService` 与 `ROBOT_SERVICE_URL`）
    expect(
      CALLS_INTERNAL_HTTP('/** ⚠️ 不再需要 `HttpService` / `ROBOT_SERVICE_URL`。 */'),
    ).toBe(false);
    expect(CALLS_INTERNAL_HTTP('/**\n * 传输换成 `Transport.TCP`；不再需要 `HttpService`。\n */')).toBe(false);
    // 反向误伤对照：`GET /api/health` 不是内部对局面
    expect(CALLS_INTERNAL_HTTP("app.get('/api/health', handler)")).toBe(false);
    // `prefetch(` 不是 `fetch(`
    expect(CALLS_INTERNAL_HTTP('this.prefetch(url)')).toBe(false);

    // ── USES_SERVICE_URL_ENV：正/负 ────────────────────────────────────
    expect(USES_SERVICE_URL_ENV("process.env.ROBOT_SERVICE_URL ?? 'http://localhost:3005'")).toBe(true);
    expect(USES_SERVICE_URL_ENV('process.env.ROBOT_SERVICE_RPC_HOST ?? "robot-service"')).toBe(false);
    expect(USES_SERVICE_URL_ENV('// ROBOT_SERVICE_URL 不再需要（§2.3）')).toBe(false);

    // ── 两条路由探针：正/负 ────────────────────────────────────────────
    expect(HAS_EMPTY_POST_ROUTE('  @Post()\n  async create() {}')).toBe(true);
    expect(HAS_EMPTY_POST_ROUTE("  @Post(':roomCode/bid')")).toBe(false);
    expect(HAS_SNAPSHOT_ROUTE("  @Get(':roomCode/snapshot')")).toBe(true);
    expect(HAS_SNAPSHOT_ROUTE("  @Get(':roomCode/state')")).toBe(false);
    expect(HAS_SNAPSHOT_ROUTE("/* `GET :roomCode/snapshot`（game.snapshot）整条删除 */")).toBe(false);

    // ── RPC_USAGE：正/负（**负向必须是「手写字面量」** —— 那正是要禁止的形态）──
    expect(RPC_USAGE.test('this.proxy.send(RPC_PATTERNS.robotAcquire, { roomCode, seats })')).toBe(true);
    expect(RPC_USAGE.test("this.proxy.send('robot.acquire', { roomCode, seats })")).toBe(false);
    expect(RPC_USAGE.test('const RPC_PATTERNS = { robotAcquire: "robot.acquire" }')).toBe(false);
    // 片②（J19 第 1 件事）：第 9 条 `robotAvailability` 的正/负对照（负向同样是手写字面量）
    expect(RPC_USAGE.test('this.proxy.send(RPC_PATTERNS.robotAvailability, { ...metaFromTrace() })')).toBe(true);
    expect(RPC_USAGE.test("this.proxy.send('robot.availability', { ...metaFromTrace() })")).toBe(false);
    // 片⑦（T6）：第 8 条 `configSnapshot` 的正/负对照（负向仍是手写字面量——正是要禁止的形态）
    expect(RPC_USAGE.test('this.proxy.send(RPC_PATTERNS.configSnapshot, { ...metaFromTrace() })')).toBe(true);
    expect(RPC_USAGE.test("this.proxy.send('config.snapshot', { ...metaFromTrace() })")).toBe(false);
    // 记录片（T5）：第 10 条 `recordWrite` 的正/负对照（负向同样是手写字面量——「只加名字
    // 不配负对照 = 无效补丁」，见文件头片②小节）
    expect(RPC_USAGE.test('this.proxy.send(RPC_PATTERNS.recordWrite, { ...request, ...metaFromTrace() })')).toBe(true);
    expect(RPC_USAGE.test("this.proxy.send('record.write', { ...request, ...metaFromTrace() })")).toBe(false);
    // 货币片（T6）：第 11 条 `currencyApply`（user-service 的发送边）的正/负对照（负向同样
    // 是手写字面量——正是要禁止的形态）
    expect(RPC_USAGE.test('this.proxy.send(RPC_PATTERNS.currencyApply, { ...request, ...metaFromTrace() })')).toBe(true);
    expect(RPC_USAGE.test("this.proxy.send('currency.apply', { ...request, ...metaFromTrace() })")).toBe(false);
    // 风控片（T3）：第 12 条 `riskDeviceReport` 的正/负对照（负向同样是手写字面量——
    // 「只加名字不配负对照 = 无效补丁」，见文件头片②小节）
    expect(RPC_USAGE.test('this.proxy.send(RPC_PATTERNS.riskDeviceReport, { userId, deviceId, ...metaFromTrace() })')).toBe(true);
    expect(RPC_USAGE.test("this.proxy.send('risk.deviceReport', { userId, deviceId, ...metaFromTrace() })")).toBe(false);

    // ── INTERNAL_HTTP_PATH：正/负（保留给「路径字符串」类扫描的通用探针）──
    expect(INTERNAL_HTTP_PATH.test('`${base}/api/games`')).toBe(true);
    expect(INTERNAL_HTTP_PATH.test('`${base}/api/robots/release`')).toBe(true);
    expect(INTERNAL_HTTP_PATH.test('/api/health')).toBe(false);
    expect(INTERNAL_HTTP_PATH.test('game.service.ts')).toBe(false);
  });

  /**
   * 反向判据的**锚点校验**：六个 `room-service` 调用点确实是**本仓**的那六个文件
   * （而不是「路径写错后扫到了别的地方」）。
   *
   * R179 的教训是「静默扫到主检出的旧文件 ⇒ 闸恒绿」；这里用**文件内容特征**再兜一层：
   * `room-service` 的调用点必须 import `@nestjs/microservices` 的 `ClientProxy`。
   */
  it('锚点校验：六个 room-service 调用点都 import 了 ClientProxy（证明扫的是本仓文件）', () => {
    for (const rel of ROOM_CALL_SITES) {
      expect(read(rel), `${rel} 没有 import ClientProxy —— 可能扫到了别处的同名文件`).toContain(
        'ClientProxy',
      );
    }
  });

  /**
   * 货币片 T6：**user-service 侧**新发送边的三条同形判据（正向 / 反向 / 锚点）。
   *
   * 「只加名字不配正负对照 = 无效补丁」的同一条纪律（见文件头片②小节）—— 新文件不在
   * room 的两张清单里，因此这里**单列**一组，形态与上面三组逐条同形。
   */
  it('货币片 T6 正向：user-service 的 currency.client 真的在用 RPC_PATTERNS.currencyApply（否则反向判据会退化成空测）', () => {
    for (const rel of USER_RPC_CLIENTS) {
      expect(RPC_USAGE.test(read(rel)), `${rel} 没有 RPC pattern 用法 —— 反向判据会退化成空测`).toBe(
        true,
      );
    }
  });

  it('货币片 T6 反向：user-service 的 currency.client 不做内部 HTTP 出站、也不读 *_SERVICE_URL', () => {
    for (const rel of USER_RPC_CLIENTS) {
      expect(
        CALLS_INTERNAL_HTTP(read(rel)),
        `${rel} 仍在做内部 HTTP 出站 —— 内部面必须走 TCP RPC`,
      ).toBe(false);
      expect(USES_SERVICE_URL_ENV(read(rel)), `${rel} 仍在读 *_SERVICE_URL（须用 *_RPC_HOST/PORT）`).toBe(
        false,
      );
    }
  });

  it('货币片 T6 锚点校验：user-service 的发送边 import 了 ClientProxy（证明扫的是本仓文件）', () => {
    for (const rel of USER_RPC_CLIENTS) {
      expect(read(rel), `${rel} 没有 import ClientProxy —— 可能扫到了别处的同名文件`).toContain(
        'ClientProxy',
      );
    }
  });

  /**
   * 片②（J19 第 2 件事）：`availability()` 的实现点 = **既有的**
   * `gateway/robot.client.ts`（它已在 `RPC_CLIENTS` / `ROOM_CALL_SITES` 两张清单里）
   * ⇒ 两张清单**无需增行**。这条断言把该事实钉住：
   *
   * 实现点一旦漂移（挪去新文件 / 被改名），新文件**不在两张清单的扫描面里** ⇒
   * 「每文件至少一处 pattern 用法」的正向判据与之后的全部反向扫描都会**静默漏掉**它
   * ⇒ 本断言必须红，逼着把新文件同步加进两张清单。
   */
  it('片②：availability() 的实现点 == 两张清单里的既有 gateway/robot.client.ts（清单无需增行，但不得漂移）', () => {
    const target = 'packages/room-service/src/gateway/robot.client.ts';
    expect(RPC_CLIENTS).toContain(target);
    expect(ROOM_CALL_SITES).toContain(target);
    const defining = ROOM_CALL_SITES.filter((rel) =>
      /async availability\s*\(/.test(stripComments(read(rel))),
    );
    expect(
      defining,
      'availability() 的实现点变了 —— 若挪去了新文件，必须把它同步加进 RPC_CLIENTS / ROOM_CALL_SITES',
    ).toEqual([target]);
  });
});
