/**
 * conformance 用例：**机器人 AI 全量化**（片②）—— 新片 `slice-13-ai-rollout`（Task 9）。
 *
 * 计划：`docs/superpowers/plans/2026-10-01-ai-rollout.md` Task 9；
 * 规格：`docs/superpowers/specs/2026-10-01-ai-rollout-spec.md` §3（J11/J12/J13/J32/J22；原第 6 组
 * J4 **已删** —— 见下）+ §5；
 * 设计层（「替代错实现」逐条）：`docs/superpowers/specs/2026-10-01-ai-rollout-design.md` §8。
 *
 * 五组判据（全部真栈；不跑客户端代码）：
 *  1. J11  douzero 并发（🔴 **容器内 vantage**）：20/20 成功、0 连接重置；同变体比值 p50_conc ≤ 60 × p50_serial。
 *     ⚠️ 宿主视角**看不出** backlog 缺陷（设计层实测：宿主比值仅 5.1×、0 失败）⇒ 必须 `docker exec`
 *     进**在跑的**容器里发。K=60 的锚（同变体口径）：修后 14.5×（58ms/4.0ms）、把 backlog 改回 5
 *     的变异 409×（1022ms/2.5ms）。复现命令与逐次读数留档：
 *     `docs/superpowers/plans/2026-10-01-ai-rollout-t9-j11-evidence.md`（⚠️ **不**放 `.superpowers/`，
 *     那里被 gitignore）。
 *  2. J12  未知 `model` ⇒ 400；正对照 `douzero_WP` ⇒ 200 且返回**该模型**动作（判别局面 WP=[3]）。
 *     替代错实现：①未知档静默回退缺省 ②一律 503 —— 两条都会在正对照/动作值上红。
 *  3. J13  只读挂载空目录 ⇒ 服务**照常起**（`State.Running`）+ `/health` 报 `missing`（按**模型名**）
 *     + 该档 503 + 容器内执行 healthcheck 的**原命令**退出码 0（`depends_on: service_healthy` 的因果链）。
 *     等待有上界。替代错实现：任一缺失即退出（会拖垮 game/robot）。
 *  4. J32  **补下的成功路径**（⚠️ **需要网**）：宿主预拷 8 个、只缺 `douzero_ADP/landlord_up.onnx`
 *     ⇒ 服务补下 + 加载 + `/health` 齐备。容器连不上 HF 时**只能** `checks.skip()` ——
 *     绝不许把「没验」写成 ok（`lib/assert.ts` 的 skip 纪律）。
 *  5. J22  真栈真打 `robot.availability`：ON（**常驻栈** ROBOT_RPC；配置中心 `game.doudizhu.robot.ruleFallback`
 *     默认 `true` = 规则兜底开着的旧世界 ⇒ 不探测、直接「能给」）⇒ `canProvide:true`。OFF（片⑦
 *     K11 重做：旧 `-e ROBOT_RULE_FALLBACK=false` 已随 env 退役失效）先经 admin PUT
 *     `game.doudizhu.robot.ruleFallback=false`，再起一只一次性容器（`-e DOUZERO_URL=http://127.0.0.1:9`
 *     `-e RPC_PORT=3199` + **显式发布** 3199 —— `docker compose run` 不发布 compose 里的 `ports`；
 *     但**自动入 compose 网络** ⇒ 容器启动时从 config-service 拉快照，拿到的就是关闭态）⇒
 *     `canProvide:false` + `reason:douzero-unreachable`。**用后还原 true**（PUT code 0 + 读回）。
 *     带「3199 未被占用」前提断言 + 后置残留断言。
 *  6. ~~J4（非法 env ⇒ 退出码 1 + logger.error 行）~~ —— **已删**（片⑦ K11）：`ROBOT_RULE_FALLBACK`
 *     的 env 解析随配置中心退役，junk-env 构造不再存在。语义继受 = `slice-14` 的 **C5半**（真栈
 *     2 例非法 PUT ⇒ 400 且值未变，其中一例就是 `game.doudizhu.robot.ruleFallback='yes'`）。判据减少（−4 条）
 *     已在片⑦ T16 的提交信息显式登记。
 *
 * 一次性容器的纪律（**命名**先例 `slice-07.2-deploy:202/:461`、**纪律**先例 `slice-07.3-edge`）：
 *  - 名字固定 `ftl-conformance-*`；起之前**先 `docker rm -f` 同名残留**（否则 `--name` 冲突，
 *    失败会以怪形状出现在下游断言里）；
 *  - 收集完观测值 → **先拆容器、再断言**（判据失败是 fail-fast，放后面的清理永远不会执行）；
 *  - 每处等待都有**上界**（绝不裸等）；
 *  - 宿主端口（2028/2029/3199）在起容器前断言「未被占用」，占用时红得可归因；
 *  - `MSYS_NO_PATHCONV=1`：`spawnSync` **不经 shell** ⇒ 天然免疫 Git Bash 的路径转写；仍显式带上
 *    （与 brief 纪律逐字一致，将来若把命令逻辑挪回 shell 也不会踩回去）。⚠️ **手敲**复现命令时它是
 *    **必需**的（`-w /app` 会被转写成 `E:/...` ⇒ docker 报 `Cwd must be an absolute path`）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RobotAvailabilityResponse, RpcResult } from '@fight-the-landlord/protocol';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, fieldSetViolations, info, sleep, step } from '../lib/assert';
import { adminGetConfig, adminLogin, adminPutConfig, DOUZERO_URL } from '../lib/http';
import { ROBOT_RPC, rpcCall } from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度 ⇒ 与 `lib/redis.ts` 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** §3 的判别局面同款事实：三档 × 三位置。 */
const MODELS = ['sl', 'douzero_WP', 'douzero_ADP'] as const;
const POSITIONS = ['landlord', 'landlord_down', 'landlord_up'] as const;

/** 常驻 douzero 容器 / 它的开发栈镜像（R1303 命名规则默认形态）。 */
const DOUZERO_CONTAINER = 'ftl-douzero';
const DOUZERO_IMAGE = 'pokergame-douzero:latest';

/** 🔴 J11 阈值 K=60（**同变体**比值上界；锚见文件头，落在 (14.5, 409) 之间）。 */
const J11_RATIO_K = 60;

/** J13 只读缺模型探针（固定名 ⇒ 残留清理是确定的；端口避开 2021 与 3000/3005/310x）。 */
const J13_CONTAINER = 'ftl-conformance-douzero-ro';
const J13_PORT = 2029;

/** J32 补下探针（可写挂载；只缺这一个文件 —— 空目录 9 文件 54MB 会撞 60s 总预算，规格 v9-3）。 */
const J32_CONTAINER = 'ftl-conformance-douzero-fill';
const J32_PORT = 2028;
const J32_MISSING_REL = 'douzero_ADP/landlord_up.onnx';

/**
 * J32 日志谓词用的**基名**（去掉 `.onnx`）：产品 `douzero/server.py` 打的是
 * `Download failed for douzero_ADP/landlord_up: …` / `Download budget exhausted, skipping douzero_ADP/landlord_up`
 * —— 都是**不带扩展名**的 `{model}/{pos}`。只用于日志匹配；文件路径与夹具比较仍用 `J32_MISSING_REL`。
 * （带扩展名匹配的写法在断网环境下恒不中 ⇒ 走不到 skip，等满 150s 后误报成「不是断网形态」硬红。）
 */
const J32_MISSING_LOG_NAME = J32_MISSING_REL.replace(/\.onnx$/, '');

/**
 * J22 OFF 半的一次性探针（⚠️ 常驻 robot-service 已占 3105/3005 ⇒ 必须换空闲端口 + 显式发布）。
 * 关闭态 = admin PUT `game.doudizhu.robot.ruleFallback=false`（片⑦ K11 重做：旧 `-e ROBOT_RULE_FALLBACK=false`
 * 已随 env 退役失效）；容器经 `compose run` **自动入 compose 网络**（⛔ 勿加 `--network`）——
 * 启动时从 config-service 拉快照，才拿得到关闭态。
 */
const J22_OFF_CONTAINER = 'ftl-conformance-avail-off';
const J22_OFF_PORT = 3199;

/** 仓库里的模型目录（J32 的「预拷 8 个」从这里来）。 */
const REPO_MODELS = join(REPO_ROOT, 'douzero', 'models');

/**
 * J12/J13/J22/J32 共用的**判别局面**（规格 §3 逐字；Task 5 已实测锚定）：
 * `landlord_up` 手里 `[3,4,5]`、桌上 `landlord` 单张 5、`must_play=true`
 * ⇒ `sl=[4]` · `douzero_WP=[3]` · `douzero_ADP=[5]`（三档两两不同）。
 *
 * ⚠️ 「三档输出已知不同」是判别力的来源：随便挑一个局面的话，「任何档都返回同一动作」
 * 也会绿（设计层 §8 的 J33 行点名的空测形态）。
 */
const FIXTURE = {
  position: 'landlord_up',
  hand: [3, 4, 5],
  bottom_cards: [],
  last_move: [5],
  last_move_position: 'landlord',
  num_cards_left: { landlord: 5, landlord_down: 5, landlord_up: 3 },
  played_cards_landlord: [],
  played_cards_landlord_down: [],
  played_cards_landlord_up: [],
  card_play_action_seq: [],
  must_play: true,
} as const;

/**
 * 组① 的容器内探针（**Python 单进程**）：先 1 次预热（不计入读数）、再 10 次串行（取 p50 基线）、
 * 再 20 路由 `threading` 同时发出（同一进程、同一发送逻辑 ⇒ 「同变体自比」成立）。
 *
 * ⚠️ 为什么 vantage 必须是**容器内**：宿主 → 发布端口那条路有 ~264ms 的常量惩罚（设计层实测），
 * 会把「backlog=5 的排队时间」淹没掉 —— 修前修后在宿主视角**几乎一样绿**（比值 5.1×）。
 *
 * 输出一行 `J11_RESULT {...}`（JSON），由 TS 侧解析。
 * ⚠️ 脚本里刻意不用 f-string / `${}`：它是 TS 模板字符串的一部分。
 */
const J11_SCRIPT = `
import http.client, json, statistics, sys, threading, time

FIXTURE = sys.argv[1]
N = 20

def one():
    c = http.client.HTTPConnection("localhost", 2021, timeout=30)
    try:
        c.request("POST", "/decide_play", FIXTURE, {"Content-Type": "application/json"})
        r = c.getresponse()
        r.read()
        return r.status
    finally:
        c.close()

# 预热 1 次（不计入基线）：首次推理可能含惰性分配；它只让串行基线更稳，不改比值口径。
try:
    one()
except Exception:
    pass

serial = []
for _ in range(10):
    t0 = time.perf_counter()
    try:
        one()
    except Exception:
        pass
    serial.append((time.perf_counter() - t0) * 1000.0)

results = [None] * N

def worker(i):
    t0 = time.perf_counter()
    try:
        st = one()
        results[i] = ("ok" if st == 200 else "HTTP " + str(st), (time.perf_counter() - t0) * 1000.0)
    except Exception as e:
        results[i] = (type(e).__name__, (time.perf_counter() - t0) * 1000.0)

threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
t0 = time.perf_counter()
for t in threads:
    t.start()
for t in threads:
    t.join()
total_ms = (time.perf_counter() - t0) * 1000.0

ok = sum(1 for r in results if r and r[0] == "ok")
resets = sum(1 for r in results if r and r[0] == "ConnectionResetError")
errors = ["#" + str(i) + ":" + str(r[0]) for i, r in enumerate(results) if r and r[0] != "ok"]
conc = [r[1] for r in results if r]
out = {
    "ok": ok,
    "resets": resets,
    "errors": errors,
    "p50_serial_ms": round(statistics.median(serial), 3),
    "p50_conc_ms": round(statistics.median(conc), 3),
    "total_ms": round(total_ms, 1),
    "serial_ms": [round(x, 3) for x in serial],
    "conc_ms": [round(x, 3) for x in conc],
}
print("J11_RESULT " + json.dumps(out))
`;

interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** 到点被本进程的原生超时 SIGTERM 杀掉（`error.code === 'ETIMEDOUT'`，slice-07.2-deploy 成例）。 */
  timedOut: boolean;
}

/**
 * 跑一条 `docker` / `docker compose` 命令。
 *
 * `timeoutMs` 是**必需参数**（不是可选）：本片所有容器命令都必须有上界 —— 缺了它，
 * daemon 卡住时整个切片会**悬挂**而不是红（slice-07.2-deploy 的成例纪律）。
 */
function dockerRun(args: string[], timeoutMs: number, input?: string): DockerResult {
  const res = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    ...(input === undefined ? {} : { input }),
    // spawnSync 不经 shell ⇒ MSYS 路径转写本来就不适用；显式带上见文件头（brief 纪律）。
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

/** 清容器（不存在就什么都不做）。起容器**之前**也要跑一次（残留会让 `--name` 冲突）。 */
function removeContainer(name: string): void {
  dockerRun(['rm', '-f', name], 30_000);
}

/** 容器是否在 Running（容器已被 `--rm` 自动删掉时 docker inspect 失败 ⇒ 返回 false）。 */
function containerRunning(name: string): boolean {
  return dockerRun(['inspect', name, '--format', '{{.State.Running}}'], 15_000).stdout.trim() === 'true';
}

/** 同名容器残留清单（后置「无残留」断言的观测值；空串 = 无残留）。 */
function residualOf(name: string): string {
  return dockerRun(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], 15_000).stdout.trim();
}

/** 容器日志尾部（失败归因用；stdout/stderr 都可能承载启动 print）。 */
function containerLogs(name: string, tail = 80): string {
  const r = dockerRun(['logs', '--tail', String(tail), name], 20_000);
  return `${r.stdout}${r.stderr}`;
}

/**
 * 宿主端口是否被占用（J22 的「3199 未被占用」前提断言）。
 *
 * ⚠️ 判「空闲」的两形态（R229 同族）：连上 ⇒ 占用；`ECONNREFUSED` 或超时 ⇒ 空闲
 * （本机回环回 RST 是常态；黑洞形态下用短超时兜底，700ms 只是「没占」的证据强度问题 ——
 * 真占用（有进程 listen）在任何形态下都会在 milli 级回 `connect`）。
 */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolveBusy) => {
    const sock = connect({ host: '127.0.0.1', port });
    const finish = (busy: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolveBusy(busy);
    };
    sock.setTimeout(700);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 起一只 `docker compose run` 一次性容器（`-d` 后台；`--rm` + 显式 `--name` 让清理是确定的）。 */
function startOneShot(name: string, extraArgs: string[]): void {
  removeContainer(name);
  const res = dockerRun(['compose', 'run', '-d', '--rm', '--no-deps', '--name', name, ...extraArgs], 120_000);
  if (res.timedOut || res.status !== 0) {
    removeContainer(name);
    throw new ConformanceError(
      `一次性容器 ${name} 起不来（退出码 ${res.status}，超时=${res.timedOut}）：${(res.stderr || res.stdout).slice(-600)}`,
    );
  }
}

/**
 * 轮询 `/health` 直到 `done(body)` 为真（**有上界**；容器不在 Running 时提前放弃）。
 *
 * ⚠️ 单次 fetch 必须自带超时：Docker 的端口代理会**先接受 TCP** 再等容器里的进程应答 ——
 * 进程还没 listen 时这个 await 会一直挂着（`lib/http.ts` 的 `assertGatewayHealthy` 同族教训）。
 */
async function pollHealth(
  base: string,
  container: string,
  timeoutMs: number,
  done: (body: any) => boolean,
): Promise<{ done: boolean; body: any; lastErr: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  let lastBody: any = null;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
      if (res.status === 200) {
        lastBody = await res.json();
        if (done(lastBody)) return { done: true, body: lastBody, lastErr: '' };
        lastErr = `health 已应答但条件未满足：${JSON.stringify(lastBody).slice(0, 200)}`;
      } else {
        lastErr = `health HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (!containerRunning(container)) {
      return { done: false, body: lastBody, lastErr: `${lastErr}；容器 ${container} 已不在 Running` };
    }
    if (Date.now() >= deadline) return { done: false, body: lastBody, lastErr };
    await sleep(1_000);
  }
}

/** 对某基址 POST `/decide_play`，返回**原始** `{status, body, text}`（J12/J33 要 status、J33 要字节）。 */
async function askRaw(base: string, body: unknown): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}/decide_play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, text };
}

/**
 * `/health.models` 的「三档齐备、**每档恰好** `landlord`/`landlord_down`/`landlord_up`」违例清单。
 *
 * ⚠️ 设计层 v6-4：只断「每档 3 个位置」**不够** —— 名字重/缺的 body（如 `[landlord, landlord, up]`）
 * 长度齐而 D5 的解析会答 `models-incomplete`（门禁拒供），J26 却绿。⇒ 按**名称集合**判，
 * 用 `fieldSetViolations`（恰好语义：缺 X / 多 Y 都报）。
 */
function modelTableViolations(models: unknown): string[] {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return [`models 不是对象：${JSON.stringify(models)}`];
  }
  const table = models as Record<string, unknown>;
  const violations = fieldSetViolations(Object.keys(table), [...MODELS]);
  for (const m of MODELS) {
    const positions = table[m];
    if (positions === undefined) continue; // 缺档已由上面的 fieldSet 报出
    if (!Array.isArray(positions)) {
      violations.push(`${m} 的位置清单不是数组：${JSON.stringify(positions)}`);
      continue;
    }
    for (const miss of fieldSetViolations(positions.map(String), [...POSITIONS])) {
      violations.push(`${m}: ${miss}`);
    }
  }
  return violations;
}

/** 读容器的 `Healthcheck.Test`（`["CMD", …]` / `["CMD-SHELL", …]`），拿不到时 null。 */
function healthcheckTest(name: string): string[] | null {
  const r = dockerRun(['inspect', name, '--format', '{{json .Config.Healthcheck.Test}}'], 15_000);
  if (r.status !== 0 || r.stdout.trim() === '') return null;
  try {
    const arr: unknown = JSON.parse(r.stdout.trim());
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch {
    return null;
  }
}

/** 在容器内**手工执行** healthcheck 的原命令（J13 第 4 条：`depends_on: service_healthy` 的因果链）。 */
function runHealthcheckInContainer(name: string, test: string[]): { status: number | null; cmd: string; stderr: string } {
  const head = test[0];
  if (head === 'CMD') {
    const r = dockerRun(['exec', name, ...test.slice(1)], 30_000);
    return { status: r.status, cmd: test.slice(1).join(' '), stderr: r.stderr };
  }
  if (head === 'CMD-SHELL') {
    const r = dockerRun(['exec', name, 'sh', '-c', test[1] ?? ''], 30_000);
    return { status: r.status, cmd: test[1] ?? '', stderr: r.stderr };
  }
  return { status: null, cmd: JSON.stringify(test), stderr: `未知的 Healthcheck.Test 形态：${JSON.stringify(test)}` };
}

/**
 * `GET /api/admin/config` 读 `game.doudizhu.robot.ruleFallback` 的 `{value, version}`（缺行 ⇒ 抛，带原始载荷 ——
 * 不让缺行伪装成 undefined 比较）。形态同 `slice-14` 的 `adminFriendRoom`（那个钉友房键）。
 */
async function adminRuleFallback(admin: string): Promise<{ value: unknown; version: number }> {
  const res = await adminGetConfig<{ config: Record<string, { value: unknown; version: number }> }>(admin);
  const entry = res.body?.data?.config?.['game.doudizhu.robot.ruleFallback'];
  if (!entry) {
    throw new ConformanceError(
      `GET /api/admin/config 缺 game.doudizhu.robot.ruleFallback —— 实际 ${JSON.stringify(res.body?.data?.config ?? res.body)}`,
    );
  }
  return entry;
}

export async function runSlice13(): Promise<Checks> {
  const checks = new Checks();

  // ── 前置：真栈自证（不通过就**别往下测** —— 测的不可能是本分支产物）──────────────
  step('前置：真栈自证（常驻 ftl-douzero 在跑、且用的就是 :latest 的最新构建）');
  const dz = dockerRun(['inspect', DOUZERO_CONTAINER, '--format', '{{.State.Running}}|{{.Image}}'], 15_000);
  const [dzRunning = '', dzImage = ''] = dz.stdout.trim().split('|');
  const dzLatest = dockerRun(['image', 'inspect', DOUZERO_IMAGE, '--format', '{{.Id}}'], 15_000).stdout.trim();
  checks.that(
    dzRunning === 'true',
    `前置：${DOUZERO_CONTAINER} 在跑（没有它 J11 无法取证）—— 实际 ${JSON.stringify(dz.stdout.trim())}；` +
      `先 \`docker compose up -d douzero\`（stderr：${dz.stderr.slice(0, 200)}）`,
  );
  checks.eq(
    dzImage,
    dzLatest,
    '前置：常驻容器用的**就是** :latest 的最新构建（⚠️「常驻容器可能是旧镜像」⇒ 旧产物会让 J11/J12 读数失真；' +
      '重建：docker compose build douzero && docker compose up -d --force-recreate douzero）',
  );
  if (dzRunning !== 'true' || dzImage !== dzLatest || dzImage === '') {
    throw new ConformanceError(
      `前置失败：douzero 真栈未就绪（Running=${JSON.stringify(dzRunning)}，镜像 ${JSON.stringify(dzImage)} ≠ ${JSON.stringify(dzLatest)}）` +
        '—— 先按提示重建容器再跑本片。',
    );
  }

  // ── 组① J11：20 路并发（容器内 vantage）──────────────────────────────────────
  step(`组① J11：douzero 并发（容器内 vantage）—— 预热 1 + 串行 10（p50 基线）+ 20 路并发；K=${J11_RATIO_K}`);
  info(`vantage = 容器 ${DOUZERO_CONTAINER} 内（宿主视角对 backlog 缺陷**不敏感**，设计层实测比值仅 5.1×）。`);
  const j11 = dockerRun(
    ['exec', '-i', DOUZERO_CONTAINER, 'python', '-', JSON.stringify(FIXTURE)],
    180_000,
    J11_SCRIPT,
  );
  const j11Line = j11.stdout.split(/\r?\n/).find((l) => l.startsWith('J11_RESULT ')) ?? '';
  if (j11.status !== 0 || j11Line === '') {
    throw new ConformanceError(
      `J11：容器内探针没有产出读数（退出码 ${j11.status}）—— stdout 尾：${j11.stdout.slice(-500)}；` +
        `stderr：${j11.stderr.slice(-500)}`,
    );
  }
  const r11 = JSON.parse(j11Line.slice('J11_RESULT '.length)) as {
    ok: number;
    resets: number;
    errors: string[];
    p50_serial_ms: number;
    p50_conc_ms: number;
    total_ms: number;
  };
  info(
    `J11 读数：ok=${r11.ok}/20 · resets=${r11.resets} · 错误=${JSON.stringify(r11.errors)} · ` +
      `p50_serial=${r11.p50_serial_ms}ms · p50_conc=${r11.p50_conc_ms}ms · 20 路总耗时 ${r11.total_ms}ms`,
  );
  checks.that(
    r11.ok === 20 && r11.resets === 0,
    `J11：20 路并发全成功且 0 连接重置 —— ok=${r11.ok}/20，resets=${r11.resets}，错误 ${JSON.stringify(r11.errors)}` +
      '（backlog 改回 5 的形态：ConnectionResetError + 1s 级尾延迟）',
  );
  checks.that(
    r11.p50_conc_ms <= J11_RATIO_K * r11.p50_serial_ms,
    `J11：并发/串行比值 ${(r11.p50_conc_ms / r11.p50_serial_ms).toFixed(1)}× ≤ ${J11_RATIO_K}` +
      `（p50_conc=${r11.p50_conc_ms}ms / p50_serial=${r11.p50_serial_ms}ms；锚：修后 ≈14.5×、变异 ≈409×）`,
  );

  // ── 组② J12：未知 model ⇒ 400；正对照 douzero_WP ⇒ 200 且返回该模型动作 ──────────
  step('组② J12：未知 model ⇒ 400；正对照 douzero_WP ⇒ 200 且返回**该模型**动作（判别局面 WP=[3]）');
  const j12Bad = await askRaw(DOUZERO_URL, { ...FIXTURE, model: 'nope' });
  info(`未知档：HTTP ${j12Bad.status} ${JSON.stringify(j12Bad.body)}`);
  checks.eq(j12Bad.status, 400, 'J12：未知 model ⇒ 400（替代错实现：静默回退缺省档）');
  const j12Wp = await askRaw(DOUZERO_URL, { ...FIXTURE, model: 'douzero_WP' });
  info(`正对照 douzero_WP：HTTP ${j12Wp.status} ${JSON.stringify(j12Wp.body)}`);
  checks.eq(j12Wp.status, 200, 'J12 正对照：已知 model=douzero_WP ⇒ 200（替代错实现：一律 503）');
  checks.that(
    JSON.stringify(j12Wp.body?.action) === '[3]',
    `J12 正对照：200 的 body 必须是**该模型**的动作（判别局面下 WP=[3]；` +
      `若其实用别的档做了推理 ⇒ 这里红）—— 实际 ${JSON.stringify(j12Wp.body)}`,
  );

  // ── 组③ J13：只读挂载空目录 ⇒ 照常起 + 报 missing + 该档 503 + healthcheck 原命令 0 ──
  step('组③ J13：只读挂载空目录（/app/models）⇒ 容器仍 Running + /health 报 missing + 该档 503 + healthcheck 原命令退出码 0');
  removeContainer(J13_CONTAINER);
  const j13Dir = mkdtempSync(join(tmpdir(), 'ftl-conformance-j13-'));
  const j13Base = `http://localhost:${J13_PORT}`;
  let j13: { done: boolean; body: any; lastErr: string } = { done: false, body: null, lastErr: '' };
  let j13Logs = '';
  let j13Running = false;
  let j13HcTest: string[] | null = null;
  let j13HcExec: { status: number | null; cmd: string; stderr: string } = { status: null, cmd: '', stderr: '' };
  let j13Five03: { status: number; body: any } = { status: 0, body: null };
  let j13Default: { status: number; body: any } = { status: 0, body: null };
  try {
    // ⚠️ 前提断言与 startOneShot 都在 try 内：`checks.that` 失败即**抛**（fail-fast）⇒
    //    从 mkdtempSync 起的每条早抛路径都必须被下面的 finally 托住，否则临时目录泄漏。
    checks.that(
      !(await portBusy(J13_PORT)),
      `J13 前置：宿主 ${J13_PORT} 未被占用（显式发布 ${J13_PORT}:2021 需要它空闲）`,
    );
    startOneShot(J13_CONTAINER, [
      '-p',
      `${J13_PORT}:2021`,
      '-v',
      `${j13Dir.replace(/\\/g, '/')}:/app/models:ro`,
      'douzero',
    ]);
    j13 = await pollHealth(j13Base, J13_CONTAINER, 60_000, (b) => b?.status === 'ok');
    if (!j13.done) j13Logs = containerLogs(J13_CONTAINER);
    j13Running = containerRunning(J13_CONTAINER);
    if (j13.done) {
      info(`只读挂载下 /health：${JSON.stringify(j13.body)}`);
      j13HcTest = healthcheckTest(J13_CONTAINER);
      if (j13HcTest) j13HcExec = runHealthcheckInContainer(J13_CONTAINER, j13HcTest);
      j13Five03 = await askRaw(j13Base, { ...FIXTURE, model: 'sl' });
      j13Default = await askRaw(j13Base, { ...FIXTURE });
      info(`sl（已知未加载）：HTTP ${j13Five03.status} ${JSON.stringify(j13Five03.body)}`);
      info(`缺省档（未加载的 WP）：HTTP ${j13Default.status} ${JSON.stringify(j13Default.body)}`);
    }
  } finally {
    // 「先拆容器、再断言」（slice-07.3-edge 的纪律）：判据失败是 fail-fast，放后面的清理不会执行。
    removeContainer(J13_CONTAINER);
    try {
      rmSync(j13Dir, { recursive: true, force: true });
    } catch (err) {
      info(`J13 临时目录清理失败（不影响判据）：${String(err)}`);
    }
  }
  const j13Residual = residualOf(J13_CONTAINER);
  if (!j13.done) {
    throw new ConformanceError(
      `J13：60s 上界内 /health 未应答 —— lastErr=${j13.lastErr}；容器 Running=${j13Running}；日志尾 ${j13Logs.slice(-600)}`,
    );
  }
  checks.that(
    j13Running,
    'J13：只读挂载缺模型时服务**照常起**（State.Running=true；替代错实现：任一缺失即退出，会拖垮 game/robot）',
  );
  checks.eq(j13.body?.status, 'ok', 'J13：/health 恒 200 且 status=ok');
  checks.that(
    JSON.stringify([...(j13.body?.missing ?? [])].sort()) === JSON.stringify([...MODELS].sort()),
    `J13：missing 按**模型名**报三档全缺（不是按位置、不是文件路径）—— 实际 ${JSON.stringify(j13.body?.missing)}`,
  );
  checks.eq(
    JSON.stringify(Object.keys(j13.body?.models ?? { '!坏形态': true })),
    '[]',
    'J13：models 为空对象（没有一档加载成功）',
  );
  checks.eq(j13Five03.status, 503, 'J13：已知但未加载的档（sl）⇒ 503（替代错实现：静默用别的模型）');
  checks.eq(j13Default.status, 503, 'J13：缺省档（douzero_WP，同样未加载）⇒ 503');
  checks.eq(
    j13HcExec.status,
    0,
    `J13：容器内手工执行 healthcheck 原命令退出码 0（这是 depends_on: service_healthy 的因果链）—— ` +
      `命令 ${JSON.stringify(j13HcExec.cmd)}${j13HcExec.stderr ? `；stderr ${j13HcExec.stderr.slice(0, 200)}` : ''}`,
  );
  checks.eq(j13Residual, '', 'J13：后置无残留（一次性容器已拆）');

  // ── 组④ J32：只缺一个文件 ⇒ 补下 + 加载 + /health 齐备（可写挂载；需要网）──────────
  step('组④ J32：宿主预拷 8 个、只缺 douzero_ADP/landlord_up.onnx ⇒ 补下 + 加载 + /health 齐备（可写挂载）');
  removeContainer(J32_CONTAINER);
  const j32Dir = mkdtempSync(join(tmpdir(), 'ftl-conformance-j32-'));
  let j32Copied = 0;
  const j32HostFile = join(j32Dir, J32_MISSING_REL);
  const j32Base = `http://localhost:${J32_PORT}`;
  const j32Complete = (b: any): boolean =>
    modelTableViolations(b?.models).length === 0 && Array.isArray(b?.missing) && b.missing.length === 0;
  let j32: { done: boolean; body: any; lastErr: string } = { done: false, body: null, lastErr: '' };
  let j32Logs = '';
  let j32Running = false;
  let j32FileExists = false;
  let j32FileSize = 0;
  try {
    // ⚠️ 夹具拷贝/前提断言/startOneShot 全在 try 内（同 J13）：`checks.*` 失败即抛（fail-fast）⇒
    //    从 mkdtempSync 起的每条早抛路径都必须被 finally 托住（本目录含 8 个 onnx ≈48MB）。
    for (const m of MODELS) {
      for (const p of POSITIONS) {
        if (`${m}/${p}.onnx` === J32_MISSING_REL) continue;
        mkdirSync(join(j32Dir, m), { recursive: true });
        copyFileSync(join(REPO_MODELS, m, `${p}.onnx`), join(j32Dir, m, `${p}.onnx`));
        j32Copied += 1;
      }
    }
    checks.eq(j32Copied, 8, 'J32 夹具前置：宿主已预拷 8 个模型文件（其余 8 个从仓库 douzero/models 逐字节复制）');
    checks.that(
      !existsSync(j32HostFile),
      `J32 夹具前置：缺的那一个确实不在（${J32_MISSING_REL}）—— 否则本组测不到补下路径`,
    );
    checks.that(
      !(await portBusy(J32_PORT)),
      `J32 前置：宿主 ${J32_PORT} 未被占用（显式发布 ${J32_PORT}:2021 需要它空闲）`,
    );
    startOneShot(J32_CONTAINER, [
      '-p',
      `${J32_PORT}:2021`,
      // 🔴 断网判别的可观测性命门（2026-10-01 修复轮实测）：Tty=false 时 Python 对管道**块缓冲**
      //    （8KB），而全部启动输出 <1KB（含 `Download failed …` 行）⇒ `docker logs` 在容器
      //    运行期间**恒空**（常驻 ftl-douzero 跑 1 小时也空）。不设它时断网环境即便谓词正确
      //    也读不到行 ⇒ 误红。PYTHONUNBUFFERED=1 只改 stdio 缓冲、不动产品逻辑（--network none
      //    探针实测：设前空日志、设后逐行可见；证据见 task-9 报告「修复轮」）。
      '-e',
      'PYTHONUNBUFFERED=1',
      // ⚠️ 与 J13 相反：**可写**挂载（补下要写穿到宿主 —— 宿主侧「文件出现了」正是「补下」的独立证据）。
      '-v',
      `${j32Dir.replace(/\\/g, '/')}:/app/models`,
      'douzero',
    ]);
    // 上界 150s：单文件超时 30s + 总预算 60s（规格 v9-3 的实测锚：本机单文件 4–24s）+ 启动与加载。
    j32 = await pollHealth(j32Base, J32_CONTAINER, 150_000, j32Complete);
    if (!j32.done) j32Logs = containerLogs(J32_CONTAINER);
    if (j32.done) info(`补下完成后的 /health：${JSON.stringify(j32.body)}`);
    else if (j32.body !== null) info(`150s 上界时 /health 仍不齐备：${JSON.stringify(j32.body)}`);
    j32Running = containerRunning(J32_CONTAINER);
    j32FileExists = existsSync(j32HostFile);
    j32FileSize = j32FileExists ? statSync(j32HostFile).size : 0;
  } finally {
    removeContainer(J32_CONTAINER);
    try {
      rmSync(j32Dir, { recursive: true, force: true });
    } catch (err) {
      info(`J32 临时目录清理失败（不影响判据）：${String(err)}`);
    }
  }
  const j32Residual = residualOf(J32_CONTAINER);
  if (!j32.done) {
    // ⚠️ 断网 vs 产品缺陷的判别：日志里必须有 **Download failed** 行（网络类）才允许 skip；
    //    「HTTP Error」（404/403 —— URL 模板/文件名错）与「什么都没有」都是**产品缺陷**，响亮红。
    const failedLine =
      j32Logs.split(/\r?\n/).find((l) => l.includes(`Download failed for ${J32_MISSING_LOG_NAME}`) || l.includes(`Download budget exhausted, skipping ${J32_MISSING_LOG_NAME}`)) ?? '';
    info(`补下失败观测：文件存在=${j32FileExists}；容器 Running=${j32Running}；相关日志行=${failedLine || '（无）'}`);
    if (failedLine.includes('HTTP Error')) {
      throw new ConformanceError(
        `J32：下载失败行指向 **HTTP Error**（URL/文件名错）—— 这是产品缺陷，不许 skip：${failedLine}`,
      );
    }
    if (failedLine !== '') {
      checks.skip(
        'J32：只缺一个文件 ⇒ 补下 + 加载 + /health 齐备',
        `本机容器连不上 HuggingFace（未验；CI 有外网，跑在那边）：${failedLine}`,
      );
      checks.eq(j32Residual, '', 'J32：后置无残留（一次性容器已拆）');
    } else {
      throw new ConformanceError(
        `J32：150s 上界内 /health 未齐备，且日志里**没有** Download failed 行（不是断网形态）—— ` +
          `lastErr=${j32.lastErr}；容器 Running=${j32Running}；日志尾 ${j32Logs.slice(-600)}`,
      );
    }
  } else {
    const violations = modelTableViolations(j32.body?.models);
    checks.that(
      violations.length === 0,
      `J32：/health.models 三档齐备、每档恰好三个位置名 —— 违规 ${violations.length} 条：${violations.join('；') || '无'}`,
    );
    checks.eq(JSON.stringify(j32.body?.missing), '[]', 'J32：missing 为空（缺的那个已补下并加载）');
    checks.eq(
      JSON.stringify([...(j32.body?.agents ?? [])].sort()),
      JSON.stringify([...MODELS].sort()),
      'J32：agents = 三个模型名（两侧都 sort —— 不钉产品返回顺序；三档全部加载完成）',
    );
    checks.that(
      j32FileExists && j32FileSize > 0,
      `J32：缺的那个文件已**写穿到宿主**（可写挂载的独立证据：补下真的发生了）—— ` +
        `exists=${j32FileExists} size=${j32FileSize}`,
    );
    const repoSame = existsSync(join(REPO_MODELS, J32_MISSING_REL)) ? statSync(join(REPO_MODELS, J32_MISSING_REL)).size : -1;
    info(`补下的文件大小 ${j32FileSize} 字节（仓库同路径文件 ${repoSame} 字节；只作 info —— HF 内容若更新，字节数可不同）`);
    checks.eq(j32Residual, '', 'J32：后置无残留（一次性容器已拆）');
  }

  // ── 组⑤ J22：robot.availability —— ON（常驻栈）true / OFF（admin PUT 关开关 + 一次性容器）false ──
  step(`组⑤ J22：真栈 robot.availability —— ON（常驻 ${ROBOT_RPC.host}:${ROBOT_RPC.port}）⇒ true；OFF（admin PUT game.doudizhu.robot.ruleFallback=false + 一次性 + 发布 ${J22_OFF_PORT}）⇒ false`);
  removeContainer(J22_OFF_CONTAINER);
  checks.that(
    !(await portBusy(J22_OFF_PORT)),
    `J22 前置：宿主 ${J22_OFF_PORT} 未被占用（常驻栈占的是 3105/3005；OFF 半必须换空闲端口 + 显式发布，` +
      '因为 `docker compose run` **不发布** compose 里的 ports）',
  );
  let on: RpcResult<RobotAvailabilityResponse>;
  try {
    on = await rpcCall<RobotAvailabilityResponse>(ROBOT_RPC, RPC_PATTERNS.robotAvailability, {});
  } catch (err) {
    throw new ConformanceError(
      `J22 ON：常驻栈的 ${RPC_PATTERNS.robotAvailability} 打不通：${err instanceof Error ? err.message : String(err)}\n` +
        '  ↳ 若原文含「no matching message handler」⇒ 常驻 robot-service 还是**旧镜像**（片② Task 4B 未入库）：\n' +
        '     docker compose build robot-service && docker compose up -d --no-deps robot-service',
    );
  }
  info(`ON（配置中心 game.doudizhu.robot.ruleFallback 默认 true ⇒ 不探测、直接能给）：${JSON.stringify(on)}`);
  checks.that(on.ok, `J22 ON：常驻栈必须回信封成功 —— 实际 ${JSON.stringify(on)}`);
  if (!on.ok) throw new ConformanceError(`J22 ON 前置失败：${JSON.stringify(on)}`);
  checks.that(
    on.data.canProvide === true,
    `J22 ON：开关 ON（配置中心 game.doudizhu.robot.ruleFallback 默认 true）⇒ canProvide:true —— 实际 ${JSON.stringify(on.data)}`,
  );

  // ── OFF 半（片⑦ K11 重做）：旧构造 `-e ROBOT_RULE_FALLBACK=false` 已随 env 退役失效 ——
  //    关闭态改经 **admin PUT** `game.doudizhu.robot.ruleFallback=false`；一次性容器经 `compose run`
  //    **自动入 compose 网络**（⛔ 勿加 `--network`），启动时从 config-service 拉快照（拿到 false）
  //    ⇒ 探测门禁放行 probe；DOUZERO_URL 指到容器**自己**的回环:9（无人 listen ⇒ 立刻
  //    ECONNREFUSED）⇒ canProvide:false / douzero-unreachable（确定性）。
  //    **用后还原 true**（成败皆然 —— 不许给同轮其它切片/下一轮留下关闭态）。
  const j22Admin = await adminLogin();
  let off: RpcResult<RobotAvailabilityResponse> | null = null;
  let offLastErr = '';
  let offLogs = '';
  let j22RestoreCode: number | null = null;      // null = 还原 PUT 没跑成（异常）
  let j22RestoreValue: unknown = '<未读回>';     // 读回值；读回失败时保持占位
  let j22RestoreErr = '';                        // 还原路径异常原文（PUT 或读回）
  try {
    const j22PutOff = await adminPutConfig('game.doudizhu.robot.ruleFallback', false, j22Admin);
    checks.eq(j22PutOff.body?.code, ErrCode.OK, 'J22 OFF 前置①：admin PUT game.doudizhu.robot.ruleFallback=false ⇒ code 0（旧 env 构造已退役）');
    const j22OffEntry = await adminRuleFallback(j22Admin);
    checks.eq(j22OffEntry.value, false, 'J22 OFF 前置②：读回 game.doudizhu.robot.ruleFallback=false（容器启动前，快照真源已是关闭态）');

    startOneShot(J22_OFF_CONTAINER, [
      '-p',
      `${J22_OFF_PORT}:${J22_OFF_PORT}`,
      // 容器**自己**的回环:9 无人 listen ⇒ fetch 立刻 ECONNREFUSED ⇒ douzero-unreachable（确定性）。
      '-e',
      'DOUZERO_URL=http://127.0.0.1:9',
      '-e',
      `RPC_PORT=${J22_OFF_PORT}`,
      'robot-service',
    ]);
    const offEp = { host: 'localhost', port: J22_OFF_PORT };
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const res = await rpcCall<RobotAvailabilityResponse>(offEp, RPC_PATTERNS.robotAvailability, {}, 2_000);
        off = res;   // 采用**最后一次**读数（超时分支把它带进报错）
        // 收敛判据：快照生效前 `ruleFallback()` 取代码默认 `true` ⇒ 会先答 canProvide:true；
        // 快照生效后（开关 false）才走 probe ⇒ false。轮询到 false 才停（有上界）。
        if (res.ok && res.data.canProvide === false) break;
        offLastErr = res.ok
          ? `已应答但 canProvide=${JSON.stringify(res.data)}（快照未生效前会先取默认 true —— 继续等）`
          : `已应答但信封 ok=false（${JSON.stringify(res)}）`;
      } catch (err) {
        offLastErr = err instanceof Error ? err.message : String(err);
      }
      if (!containerRunning(J22_OFF_CONTAINER)) break;
      if (Date.now() >= deadline) break;
      await sleep(1_000);
    }
    const converged = off !== null && off.ok && off.data.canProvide === false;
    if (!converged) offLogs = containerLogs(J22_OFF_CONTAINER);
  } finally {
    removeContainer(J22_OFF_CONTAINER);
    // 还原 true + 读回（记录式，断言在 finally 之外 —— 这里**不许**用异常顶掉原始结论）。
    try {
      const restored = await adminPutConfig('game.doudizhu.robot.ruleFallback', true, j22Admin);
      j22RestoreCode = restored.body?.code ?? null;
      try {
        j22RestoreValue = (await adminRuleFallback(j22Admin)).value;
      } catch (err) {
        j22RestoreErr = `读回失败：${err instanceof Error ? err.message : String(err)}`;
      }
    } catch (err) {
      j22RestoreErr = `PUT 异常：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const j22Residual = residualOf(J22_OFF_CONTAINER);
  if (off === null) {
    throw new ConformanceError(
      `J22 OFF：60s 上界内 ${J22_OFF_PORT} 没有 RPC 应答 —— 末次错误：${offLastErr}；日志尾 ${offLogs.slice(-600)}`,
    );
  }
  info(`OFF（game.doudizhu.robot.ruleFallback=false + DOUZERO_URL=http://127.0.0.1:9）：${JSON.stringify(off)}`);
  checks.that(off.ok, `J22 OFF：一次性容器必须回信封成功 —— 实际 ${JSON.stringify(off)}`);
  if (!off.ok) throw new ConformanceError(`J22 OFF 前置失败：${JSON.stringify(off)}`);
  checks.that(
    off.data.canProvide === false,
    `J22 OFF：开关 OFF + DouZero 不可达 ⇒ canProvide:false（替代错实现：探不通就当能给）—— 实际 ${JSON.stringify(off.data)}` +
      (offLogs ? `；日志尾 ${offLogs.slice(-400)}` : ''),
  );
  checks.eq(
    off.data.reason,
    'douzero-unreachable',
    'J22 OFF：reason 归因 douzero-unreachable（契约 RobotAvailabilityResponse 的两值之一）',
  );
  checks.eq(j22Residual, '', 'J22：后置无残留（一次性容器已拆）');
  checks.that(
    j22RestoreCode === ErrCode.OK,
    'J22 OFF 收尾①：用后还原 admin PUT game.doudizhu.robot.ruleFallback=true ⇒ code 0（成败皆然 —— 关闭态不许留过本轮）' +
      ` —— 实际 code=${j22RestoreCode === null ? '（未执行）' : j22RestoreCode}${j22RestoreErr ? `；${j22RestoreErr}` : ''}`,
  );
  checks.that(
    j22RestoreValue === true,
    `J22 OFF 收尾②：读回 game.doudizhu.robot.ruleFallback=true（还原真的落库）—— 实际 ${JSON.stringify(j22RestoreValue)}` +
      (j22RestoreErr ? `；${j22RestoreErr}` : ''),
  );

  // ── 原组⑥ J4（非法 env ⇒ fail-closed）**已删**（片⑦ K11）：`ROBOT_RULE_FALLBACK` 的 env 解析
  //    随配置中心退役，junk-env 构造不再存在。**语义继受 = `slice-14` 的 C5半**（真栈 2 例非法
  //    PUT ⇒ 400 且值未变 —— 非法 `game.doudizhu.robot.ruleFallback='yes'` 就在那两例里）。判据减少（−4 条）
  //    已在片⑦ T16 的提交信息显式登记（仓规：判据只增不减，删减必须显式）。
  return checks;
}
