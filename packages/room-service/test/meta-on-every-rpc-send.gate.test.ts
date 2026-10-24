/**
 * **R1（最终全分支评审 Recommendation 1）：结构性防线 —— 每一处 RPC 发送点都必须带 `meta`。**
 *
 * ## 它守的是什么
 *
 * 本片把 traceId 串过了 RPC 那一跳（R1104/R1105）：**发送侧**在 `ClientProxy.send()`
 * 的载荷里附加 `...metaFromTrace()`。而这件事今天是靠「**三处手写 + 每条边的单测**」
 * 维持的 —— 评审者点名的两种失效形态：
 *  ① **新增第四条边**（新写一个 `this.proxy.send(...)`）时**忘记** `metaFromTrace()`
 *     ⇒ 那一跳的日志在接收侧全部退化成 `traceId: null`（`source: 'rpc'`，正确的**如实降级**，
 *     所以**不会报错**，只是链子断了）；
 *  ② 把一次 `send` **搬家**（抽到新的私有方法 / 换一个封装）时把 `...metaFromTrace()` 落下。
 * 两种形态下**单测各自全绿**（每条边只看自己那一跳），真栈判据 7 只覆盖 `game.start`
 * 一条链 ⇒ **没有任何闸看得见**。
 *
 * ## 判据形态（与 `no-internal-http.gate.test.ts` 同族：钉**性质**，不钉形态）
 *
 * - **正向（反空测）**：扫到的 `.send(` 调用点必须 **≥ 4**（今天恰好 4 处：room 的
 *   `game.call` / `robot.acquire` / `robot.release` + game 的 `robot.decide`）。
 *   没有这一条，扫描面被删空/改名时本闸会**恒绿**（切片 11 教训第 7 条：
 *   「没扫到坏东西」在旧栈上也可能是绿的）。
 * - **反向**：每一处 `.send(...)` 的**调用实参文本**里都必须出现 `metaFromTrace()`。
 * - **判别力自证**：**纯函数**探针（合成的正/负样本串）—— 本闸连临时文件都不落盘。
 *   对照：`no-legacy-message-names.gate.test.ts` 原先往 `src/` 写**固定名**探针文件，
 *   同包并发跑测试时会假红（**Obs-5** 实测）—— 2026-09-23 已改为写在**每次调用独有的临时根**里。
 *   本闸的形态更省：只喂字符串。
 *
 * ⚠️ **假红边界（写清楚，免得下一个人把闸删掉）**：本闸把 `packages/<pkg>/src` 里的**每一处**
 * `.send(` 都当成 RPC 发送点 —— 本仓今天没有别的 `.send(`（HTTP 面用的是 `.json()`）。
 * 将来若出现**非 RPC** 的 `.send(`（如 `res.send(...)`），这里会**假红** ⇒ 正确处置是
 * **在闸里显式排除那一种形态并写明理由**，而不是删掉判据（R150：最常见的错误「修法」
 * 是把判别力一起删掉）。
 * 📌 **该处置已落地（③ T13 修复，2026-10-05）**：`res.send(...)`（Express **HTTP 响应**发送点）
 * 已在 `isHttpResponseSend()` 处**显式排除**——触发实况 = api-gateway 的 **CSV 字节透传**
 * （`proxy.gateway.ts` 的 `res.send(Buffer.from(bytes))`，CSV 闸由 `arrayBuffer()` 保 BOM 时引入；
 * 它既不进 `ClientProxy`、也没有 `meta` 这个概念）。排除后 `sends` 计数 13→12
 * （正向判据 ≥4 不变）；**排除面只此一种形态**，其余任何 `.send(` 照旧受判据约束。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * 从本文件所在目录**向上**找到仓库根（以 `packages/room-service` + `packages/game-service`
 * 为锚）。⚠️ **R179**：不得用固定层数的相对路径 —— 层数一错就静默扫到主检出的旧文件 ⇒ 闸恒绿；
 * 找不到锚点必须**抛错**（宁可红，也不要空测）。
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
  throw new Error('找不到仓库根（以 packages/room-service + packages/game-service 为锚）');
}

const REPO = findRepoRoot();

/** 扫描面 = 八个包的 `src/`（RPC 发送点只可能在这八个里；`apps/` 与 `tools/` 不在其列）。
 *  ⚠️ 支付片 T2：payment-service 补入（新服务的发送边 = `config/config.client.ts` 的
 *  `config.snapshot` —— 不补则新服务的发送边**没有任何闸在看**，本闸头注自证同族）。 */
const PACKAGES = [
  'api-gateway',
  'user-service',
  'room-service',
  'game-service',
  'robot-service',
  'payment-service',
  'shared',
  'protocol',
] as const;

/**
 * 递归列出 `dir` 下的 `.ts` 源码（**排除 `*.test.ts`**：同目录的测试会造**替身**
 * `proxy.send`，那不是生产发送点 —— 把它们算进来是假红）。
 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      listSourceFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 把注释替换成**等长空白**（保留所有字符偏移量）。
 *
 * ⚠️ 为什么是「等长空白」而不是「删除」：后面要按**偏移量**做括号配对并回算行号 ——
 * 删掉注释会让偏移错位（配到别的括号上、行号偏移），那种错**看起来完全正常**。
 * ⚠️ 行注释的判定与 `no-raw-console.test.ts` 同款（`(^|[^:])//`）：跳过 `https://` 里的 `//`。
 */
function blankComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) =>
      line.replace(/(^|[^:])\/\/.*$/, (m, prefix: string) => prefix + ' '.repeat(m.length - prefix.length)),
    )
    .join('\n');
}

/** 一处 `.send(...)` 调用：整段实参文本 + 在（剥注释后的）源码里的偏移量。 */
interface SendCall {
  text: string;
  index: number;
}

/**
 * **R150 显式排除面（③ T13 修复，2026-10-05）**：`res.send(...)` 是 Express **HTTP 响应**的
 * 发送点（本仓唯一实例 = api-gateway 的 CSV 字节透传 `res.send(Buffer.from(bytes))`，
 * 由 `arrayBuffer()` 字节保真修复引入）——它不进 `ClientProxy`、没有 `meta` 这个概念
 * ⇒ 对它判「有没有 `metaFromTrace()`」是**假红**。按文件头「假红边界」段的处方**显式排除
 * 这一种形态**：接收者名恰为裸 `res` 的 `.send(` 之一。
 *
 * ⚠️ **排除面刻意收得很窄**：只跳过接收者**就是** `res` 的调用——`myres.send(...)`（更长
 * 标识符）与 `obj.res.send(...)`（属性名恰为 `res`）**都不在豁免内**，照旧受判据约束。
 * 不得把这里放宽成「HTTP 层都不用 meta」之类——那会连判别力一起删掉（R150）。
 */
function isHttpResponseSend(code: string, matchIndex: number): boolean {
  // `matchIndex` 指向 `.send` 里那个 `.`；接收者名（若有）恰在其前 3 字符。
  if (code.slice(Math.max(0, matchIndex - 3), matchIndex) !== 'res') return false;
  const prev = matchIndex >= 4 ? code[matchIndex - 4] : '';
  return prev === '' || !/[\w$.]/.test(prev);
}

/**
 * 抽出每一处 `.send(...)` 的**调用实参文本**（从 `.send` 起到与实参括号配对的 `)` 为止）。
 * `res.send(...)`（HTTP 响应发送点，见 `isHttpResponseSend` 的排除面说明）**不收集**。
 *
 * - 泛型实参（`.send<RpcResult<T>>(…`）写在 `(` 之前 ⇒ 从 `.send` 之后的**第一个 `(`**
 *   起配对（本仓的泛型实参里从不出现 `(` —— 探针里有一条自证）。
 * - **字符串里的括号不特殊处理**（模板串里出现 `(` 会让配对错位）—— 本仓的 4 处发送点
 *   都没有这种形态；这是本探针的**已知边界**，写在这里免得下一个人以为它什么都能解。
 */
function rpcSendCalls(src: string): SendCall[] {
  const code = blankComments(src);
  const calls: SendCall[] = [];
  const re = /\.send\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    if (isHttpResponseSend(code, match.index)) continue;
    const open = code.indexOf('(', match.index);
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    calls.push({ text: code.slice(match.index, end + 1), index: match.index });
  }
  return calls;
}

/** 一处违规：那次 `send` 的调用文本里**没有** `metaFromTrace()`。 */
const uncoveredSends = (src: string): string[] =>
  rpcSendCalls(src)
    .filter((call) => !call.text.includes('metaFromTrace()'))
    .map((call) => call.text.replace(/\s+/g, ' ').slice(0, 120));

interface ScanResult {
  /** 扫到的文件数（反空测用）。 */
  files: number;
  /** `.send(` 调用点总数（正向判据用）。 */
  sends: number;
  /** 违规点的人读形态（`文件:行 → 片段`）。 */
  violations: string[];
}

/** 扫全部包的 `src/`：统计调用点，并收集「调用文本里没有 metaFromTrace()」的那些。 */
function scanPackages(): ScanResult {
  const result: ScanResult = { files: 0, sends: 0, violations: [] };
  for (const pkg of PACKAGES) {
    for (const path of listSourceFiles(join(REPO, 'packages', pkg, 'src'))) {
      result.files += 1;
      const src = readFileSync(path, 'utf-8');
      const calls = rpcSendCalls(src);
      result.sends += calls.length;
      for (const call of calls) {
        if (call.text.includes('metaFromTrace()')) continue;
        const line = src.slice(0, call.index).split('\n').length;
        result.violations.push(
          `${relative(REPO, path).split('\\').join('/')}:${line} → ${call.text.replace(/\s+/g, ' ').slice(0, 100)}`,
        );
      }
    }
  }
  return result;
}

describe('R1：每处 RPC `send` 都必须与 `metaFromTrace()` 同现（最终评审 Recommendation 1）', () => {
  it('R179：仓库根锚点找得到（找不到就抛错，绝不静默变成空测）', () => {
    expect(existsSync(join(REPO, 'packages', 'room-service', 'src'))).toBe(true);
    expect(existsSync(join(REPO, 'packages', 'game-service', 'src'))).toBe(true);
  });

  /**
   * **正向（反空测）**：四种 RPC 边真的被扫到（今天恰好 4 处）。
   * ⚠️ 这条与 `no-internal-http.gate.test.ts` 的正向判据同一性质：**它必须随功能落地
   * 被人改**（真的删掉一条边时改这个数字），而不是在扫描面失效时**静默**变绿。
   */
  it('正向（反空测）：扫到 ≥ 4 处 `.send(` 调用点（否则下面的反向判据可能是空测）', () => {
    const { files, sends } = scanPackages();
    expect(files, '扫描面必须非空（R179：路径写错会扫到空目录）').toBeGreaterThan(20);
    expect(
      sends,
      'RPC 发送点必须真的被扫到：room 的 game.call / robot.acquire / robot.release + game 的 robot.decide（+ 将来新增的边）',
    ).toBeGreaterThanOrEqual(4);
  });

  it('反向：每一处 `.send(...)` 的调用实参里都必须有 `metaFromTrace()`（漏一处 ⇒ 那一跳静默断链）', () => {
    const { violations, sends } = scanPackages();
    expect(
      violations,
      `${sends} 处 RPC 发送点里，这些没有带 meta（那一跳的 traceId 会在接收侧退化成 null，且没有任何别的闸看得见）`,
    ).toEqual([]);
  });

  /**
   * **探针判别力自证**（纯函数正/负对照 —— **不写任何文件**，见文件头的 Obs-5 说明）。
   *
   * 每条探针都必须同时有**正**（合成串命中）与**负**（合成串不命中）两个方向：
   * 只测正向无法证明它不会误伤；只测负向无法证明它看得见。
   */
  it('探针判别力（正/负对照）', () => {
    // ── 正：漏带 meta 的真实形态（含多行实参）────────────────────────────
    expect(uncoveredSends("this.proxy.send(RPC_PATTERNS.gameView, { roomCode, userId })")).toHaveLength(1);
    expect(
      uncoveredSends('this.proxy\n  .send<RpcResult<T>>(pattern, { dto })\n  .pipe(timeout(2_000))'),
    ).toHaveLength(1);
    expect(uncoveredSends('proxy.send(RPC_PATTERNS.robotRelease, { botIds })')).toHaveLength(1);

    // ── 负：真实的带 meta 形态（同一条 `.send` 的多行对象实参）──────────────
    expect(
      uncoveredSends(
        'this.proxy\n  .send<RpcResult<T>>(pattern, { ...(payload as object), ...metaFromTrace() })\n  .pipe(timeout(timeoutMs))',
      ),
    ).toEqual([]);
    expect(
      uncoveredSends(
        'this.proxy\n  .send<RpcResult<RobotReleaseResponse>>(RPC_PATTERNS.robotRelease, {\n    botIds,\n    ...metaFromTrace(),\n  })',
      ),
    ).toEqual([]);

    // ── 负：注释里提到的 `send`（含**不带** meta 的用法示例）不得假红 ──────
    expect(uncoveredSends('// 用法：this.proxy.send(pattern, { ...payload, ...metaFromTrace() })')).toEqual([]);
    expect(uncoveredSends('/* 旧写法：this.proxy.send(pattern, { dto }) 不带 meta */')).toEqual([]);

    // ── 负：不是 `.send(` 的形态（`\b` 挡掉 `.sendLater(`；`.json(` 不是发送点）──
    expect(uncoveredSends('this.queue.sendLater(payload)')).toEqual([]);
    expect(uncoveredSends('res.status(200).json(body)')).toEqual([]);

    // ── 负（R150 显式排除面落地，③ T13）：`res.send(...)` = Express **HTTP 响应**发送点，
    //    不是 RPC 发送点（本仓实例 = api-gateway 的 CSV 字节透传 `res.send(Buffer.from(bytes))`）
    //    ⇒ 对它判「有没有 meta」是假红，覆盖与否都不该算违规 ──────────────────
    expect(uncoveredSends('res.send(Buffer.from(bytes))')).toEqual([]);
    expect(uncoveredSends('res.send(body)')).toEqual([]);

    // ── 正：排除面**只**罩「裸 `res` 接收者的 `.send(`」——近邻形态仍必须被看见
    //    （防把排除放宽成「凡是 HTTP 层都不用 meta」；`obj.res.send` 不在豁免内）────
    expect(uncoveredSends('myres.send(payload)')).toHaveLength(1);
    expect(uncoveredSends('this.res.send(payload)')).toHaveLength(1);

    // ── 负：泛型实参里没有 `(`（本探针的配对前提自证）──────────────────────
    expect(rpcSendCalls('this.proxy.send<RpcResult<T>>(p, { ...metaFromTrace() })')).toHaveLength(1);
  });
});
