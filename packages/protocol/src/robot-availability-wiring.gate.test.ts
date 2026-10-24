/**
 * **J21 机械闸（片②）**：每个 `RPC_PATTERNS` 条目都**真的有接收侧**——
 * ① `@MessagePattern(RPC_PATTERNS.<键>)` 在 `packages/<包>/src` 全树里找得到（全包扫描）；
 * ② 承载 handler 的类**被某个 `*.module.ts` 的 `controllers:` 注册**（Nest 只从模块绑）。
 *
 * ─── 它守的是什么（设计层 v3-2 的 P0）────────────────────────────────────
 * 没有接收侧 ⇒ RPC 报 `NO_MESSAGE_HANDLER` ⇒ room 侧 `availability()` **fail-open**
 * ⇒ 门禁恒答「能给」⇒「整条门禁机制可以不上线而所有闸全绿」。② 是 v4-6 补的第二半：
 * 装饰器写在**未被模块注册**的类里，运行时同样 `NO_MESSAGE_HANDLER` + fail-open（同一条 P0）。
 *
 * ─── 为什么是**全包**扫描（v5-6 的两条事实）──────────────────────────────
 *  - `config.snapshot`（片⑦ 取代 `config.baseScoreLevels`）的接收侧在
 *    **`packages/config-service/src/rpc/config.rpc.controller.ts`**（不是 AppModule）⇒ 只扫 game+robot 会把它判成漏收；
 *  - 本闸在 `packages/protocol` ⇒ 必须**文本级**（protocol 零运行期依赖、拿不到 `@nestjs`，
 *    做不了 `Reflect.getMetadata` 的真身份版；要硬形式得落到各服务内，范式
 *    `packages/game-service/test/rpc-listen-bind.test.ts` 的真端口 + 真打一发）。
 *
 * ─── 为什么不用 `import.meta.url` 找仓库根 ───────────────────────────────
 * protocol 的 `lint` 是**裸** `tsc --noEmit`（`include: src/**`、`types: []`、`module: NodeNext`），
 * 而本包 `package.json` 没有 `"type": "module"` ⇒ 该配置下 `import.meta` 会报 **TS1470**
 * （实测：本文件第一版就是这么红的）。因此这里从 `process.cwd()` **向上**找锚点
 * （内容校验 `packages/protocol/package.json` 的 name），找不到**抛错**、绝不静默空测。
 * `turbo run test` / `pnpm --filter <包> test` 都会把 cwd 设为**包目录**，从那里向上走到仓库根；
 * 若 cwd 在仓库外 ⇒ 抛错（响亮红，而不是扫到别的仓库的旧文件）。
 *
 * ─── 扫描纪律 ──────────────────────────────────────────────────────────
 *  - **先剥注释**（台账 N46：唯一真源 `@fight-the-landlord/test-utils`，守卫语义 ——
 *    URL 里的 `//` 不误剥；收敛前本文件是跨包 8 份私有副本之一）：
 *    `game.controller.ts:58/141/157`、`robot.controller.ts:10`、`game.service.ts:259`、
 *    `rpc.ts:5/36/38` 等处的**注释**里都有 `@MessagePattern`，不剥会误算；
 *  - **跳过 `*.test.ts`**：测试里的探针串（含本文件自己的合成样本）不是接收侧，
 *    不跳的话闸会读到**自己**（本仓 Obs-5 教训的同族：探针不得污染被扫集合）；
 *  - 探针用 `mkdtempSync` 的**每次调用独有**临时根（不自造「探针文件住在 src 里」的共享状态）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';
import { RPC_PATTERNS } from './rpc';

/**
 * 从 `process.cwd()` 向上找仓库根（以 `packages/protocol/package.json` 为锚，
 * 并校验其 name 字段 —— 光看存在可能撞上别的检出）。找不到就抛错（见文件头）。
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/protocol"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '找不到仓库根（锚 = packages/protocol/package.json 且 name 校验通过；起点 = process.cwd()）—— ' +
      '绝不静默变成空测',
  );
}

/** 递归列出 `dir` 下全部**文件**（不跟符号链接目录由 `isDirectory` 判定天然处理）。 */
function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

interface HandlerSite {
  /** 仓库根相对路径（`/` 分隔，跨平台稳定）。 */
  file: string;
  /** 承载该装饰器的类名；`null` = 装饰器不在任何 class 里（违规形态）。 */
  className: string | null;
  /** `@MessagePattern(RPC_PATTERNS.<此键>)` 的键名。 */
  patternKey: string;
}

/**
 * 在**已剥注释**的一份源码里按**出现顺序**扫「类声明」与「接收侧装饰器」，
 * 把每个装饰器归属到它**前面最近的**类。
 */
function handlersIn(code: string): Array<{ className: string | null; patternKey: string }> {
  const out: Array<{ className: string | null; patternKey: string }> = [];
  const re = /\bclass\s+(\w+)|@MessagePattern\(\s*RPC_PATTERNS\.(\w+)\s*\)/g;
  let currentClass: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[1] !== undefined) currentClass = m[1];
    else out.push({ className: currentClass, patternKey: m[2] as string });
  }
  return out;
}

/** 收集一份 `*.module.ts`（已剥注释）里 `controllers: [...]` 的类名。 */
function registeredControllers(code: string): string[] {
  const out: string[] = [];
  const re = /controllers\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim();
      if (name.length > 0) out.push(name);
    }
  }
  return out;
}

interface TreeScan {
  handlers: HandlerSite[];
  /** 被扫到的 `packages/<包>/src` 下文件数（防「空树恒绿」的哨兵量）。 */
  fileCount: number;
  /** 所有模块 `controllers:` 出现的类名（去重前的并集）。 */
  moduleControllers: Set<string>;
}

/** 扫描 `<root>/packages/<包>/src` 下的全部 `.ts`（跳过 `*.test.ts`）：接收侧与模块注册一起收。 */
function scanTree(root: string): TreeScan {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) throw new Error(`扫描根下没有 packages/ 目录：${packagesDir}`);
  const handlers: HandlerSite[] = [];
  const moduleControllers = new Set<string>();
  let fileCount = 0;
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of listFiles(srcDir)) {
      if (!file.endsWith('.ts')) continue;
      // 探针/夹具在测试文件里 —— 它们不是接收侧；且本闸自身的合成样本不得进被扫集合。
      if (file.endsWith('.test.ts')) continue;
      fileCount += 1;
      const code = stripComments(readFileSync(file, 'utf-8'));
      const rel = relative(root, file).split(sep).join('/');
      if (file.endsWith('.module.ts')) {
        for (const name of registeredControllers(code)) moduleControllers.add(name);
      }
      for (const site of handlersIn(code)) handlers.push({ file: rel, ...site });
    }
  }
  return { handlers, fileCount, moduleControllers };
}

/** J21 的违规清单（空数组 = 合规）。两半一起判，返回可读的违规描述。 */
function wiringViolations(root: string): string[] {
  const { handlers, moduleControllers } = scanTree(root);
  const violations: string[] = [];
  const declared = new Set(handlers.map((h) => h.patternKey));
  for (const key of Object.keys(RPC_PATTERNS)) {
    if (!declared.has(key)) {
      violations.push(`缺少接收侧：packages/*/src 里找不到 @MessagePattern(RPC_PATTERNS.${key})`);
    }
  }
  for (const key of declared) {
    if (!Object.prototype.hasOwnProperty.call(RPC_PATTERNS, key)) {
      violations.push(`未知 pattern 键：RPC_PATTERNS.${key} 不在常量表里（拼错 / 常量已删？）`);
    }
  }
  for (const h of handlers) {
    if (h.className === null) {
      violations.push(`${h.file} 的 @MessagePattern(RPC_PATTERNS.${h.patternKey}) 不在任何 class 里`);
    } else if (!moduleControllers.has(h.className)) {
      violations.push(
        `${h.file} 的承载类 ${h.className} 未被任何 *.module.ts 的 controllers: 注册` +
          '（Nest 只从模块绑 ⇒ 运行时 NO_MESSAGE_HANDLER + fail-open）',
      );
    }
  }
  return violations;
}

const REPO = findRepoRoot();

/** 合成一棵最小包树并扫它 —— 探针在**本次调用独有**的临时根里（Obs-5 纪律）。 */
function scanSyntheticTree(files: Record<string, string>): TreeScan {
  const root = mkdtempSync(join(tmpdir(), 'zz-availability-wiring-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    }
    return scanTree(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('J21：RPC_PATTERNS 的接收侧必须真存在且真绑定（片②）', () => {
  it('锚点校验（R179 的 protocol 变体）：找到的仓库根里有本包与 protocol 源码', () => {
    expect(existsSync(join(REPO, 'packages', 'protocol', 'src'))).toBe(true);
    expect(existsSync(join(REPO, 'packages', 'user-service', 'src'))).toBe(true);
    // 防「空树恒绿」：全包扫描必须真的扫到一批文件（protocol/game/robot/room/user 五个包起步）。
    expect(scanTree(REPO).fileCount).toBeGreaterThan(20);
  });

  it('J21①：全包扫描 —— 接收侧键集合 == Object.keys(RPC_PATTERNS)（二十一键：原十二键 + 金币场 recordMoneyDelta + 风控 riskDeviceReport + 支付片 currencyWithdrawableGet + 支付配置片 configPayChannelGet + 通知片 configNotifyChannelGet + 广告片 configAdChannelGet + 台费片 currencyEntryFeeSkip + 昵称片 userNicknamesGet + 挂机治理片 gameTrustee）', () => {
    const { handlers } = scanTree(REPO);
    const declared = new Set(handlers.map((h) => h.patternKey));
    // 全包扫描：declared 少一个键（漏实现 / 拼错常量名 / 写成字符串字面量）都会在这里红。
    expect([...declared].sort()).toEqual(Object.keys(RPC_PATTERNS).sort());
  });

  it('J21②：每个承载 handler 的类都被某个 *.module.ts 的 controllers: 注册', () => {
    const { handlers, moduleControllers } = scanTree(REPO);
    const classed = handlers.filter((h) => h.className !== null).map((h) => h.className as string);
    expect(classed.length).toBeGreaterThanOrEqual(18); // 二十一条接收侧都找得着承载类（12+9 键，见 J21① 标题）
    for (const h of handlers) {
      expect(h.className, `${h.file} 的装饰器不在任何 class 里`).not.toBeNull();
      expect(
        moduleControllers.has(h.className as string),
        `${h.file} 的承载类 ${h.className} 未被任何模块注册`,
      ).toBe(true);
    }
  });

  it('J21：真实仓库零违规（两半合并口径）', () => {
    expect(wiringViolations(REPO)).toEqual([]);
  });

  // ─── 判别力自证（R115/R150 的口径：正/负对照都要有）──────────────────────

  it('自证①：注释里的 @MessagePattern(RPC_PATTERNS.x) 不算接收侧；真形态才算', () => {
    // 负对照：块注释 / 行注释 —— 本仓真实源码里就有（`rpc.ts`、`robot.controller.ts` 等）
    expect(handlersIn(stripComments('/* @MessagePattern(RPC_PATTERNS.gameStart) */'))).toEqual([]);
    expect(handlersIn(stripComments('// @MessagePattern(RPC_PATTERNS.gameStart)'))).toEqual([]);
    // 正对照：真形态（且归属正确的类）
    expect(
      handlersIn(
        stripComments(
          'export class ProbeRpc {\n  @MessagePattern(RPC_PATTERNS.robotAvailability)\n  handle() {}\n}',
        ),
      ),
    ).toEqual([{ className: 'ProbeRpc', patternKey: 'robotAvailability' }]);
  });

  it('自证②：字符串字面量形态不算接收侧（它在集合等值里会表现为「缺少接收侧」）', () => {
    expect(handlersIn(stripComments("@MessagePattern('game.start')\nhandle() {}"))).toEqual([]);
  });

  it('自证③：合成树上喂三种违规 —— 未注册类 / 类外装饰器 / 未知键，各自必报', () => {
    const handler = 'export class ProbeRpc {\n  @MessagePattern(RPC_PATTERNS.gameStart)\n  handle() {}\n}\n';
    const unregistered = scanSyntheticTree({ 'packages/probe/src/rpc/probe.rpc.controller.ts': handler });
    expect([...unregistered.handlers.map((h) => h.className)]).toEqual(['ProbeRpc']);
    // 模块注册在场 ⇒ 该承载类被收进 moduleControllers；注释掉的注册不算数。
    const registered = scanSyntheticTree({
      'packages/probe/src/rpc/probe.rpc.controller.ts': handler,
      'packages/probe/src/probe.module.ts': "@Module({ controllers: [ProbeRpc] })\nexport class ProbeModule {}",
    });
    expect(registered.moduleControllers.has('ProbeRpc')).toBe(true);
    const commented = scanSyntheticTree({
      'packages/probe/src/rpc/probe.rpc.controller.ts': handler,
      'packages/probe/src/probe.module.ts': "// controllers: [ProbeRpc]\nexport class ProbeModule {}",
    });
    expect(commented.moduleControllers.has('ProbeRpc')).toBe(false);
    // 类外装饰器与未知键：直接对 handlersIn 的归属 + wiring 的键校验取证
    expect(handlersIn(stripComments('@MessagePattern(RPC_PATTERNS.robotAvailability)\nfunction loose() {}'))).toEqual([
      { className: null, patternKey: 'robotAvailability' },
    ]);
  });

  it('自证④（等价反事实）：把一条真实接收侧注释掉 ⇒ declared 集合恰好少一个键（这就是闸红的形态）', () => {
    // 用合成树等价复现「robot.rpc.controller.ts 的 availability 被注释掉」：
    const before = new Set(
      scanSyntheticTree({
        'packages/probe/src/robot.rpc.controller.ts':
          'export class RobotRpcController {\n  @MessagePattern(RPC_PATTERNS.robotAvailability)\n  availability() {}\n}',
        'packages/probe/src/robot.module.ts': "@Module({ controllers: [RobotRpcController] })\nexport class RobotModule {}",
      }).handlers.map((h) => h.patternKey),
    );
    const after = new Set(
      scanSyntheticTree({
        'packages/probe/src/robot.rpc.controller.ts':
          'export class RobotRpcController {\n  /* @MessagePattern(RPC_PATTERNS.robotAvailability) */\n  availability() {}\n}',
        'packages/probe/src/robot.module.ts': "@Module({ controllers: [RobotRpcController] })\nexport class RobotModule {}",
      }).handlers.map((h) => h.patternKey),
    );
    expect(before.has('robotAvailability')).toBe(true);
    expect(after.has('robotAvailability')).toBe(false); // ← 集合等值必红（缺少接收侧）
    expect(before.size - after.size).toBe(1);
  });
});
