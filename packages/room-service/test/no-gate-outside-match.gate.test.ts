/**
 * 片② 围绕「机器人可用性门禁」的两条机械闸：
 *
 *  - **J30（用户裁决 14）**：门禁**只装匹配链**（`match.service.ts` 是唯一读点）。
 *    好友房 / 手动房 / 自动开局的补位链（`rooms.start.ts` / `rooms.autostart.ts`）**不得读
 *    `availability`** —— 那个错实现会把等着补位的玩家**钉死**在「等待发牌…」（补位链一读门禁，
 *    门禁说不可用就永远不补、也永远不开局），而既有单测全绿（手动房用例没有门禁替身）。
 *
 *  - **J28（片② D11；v7 那个 P0 值的机械守卫）**：门禁的**超时预算** —— room 侧
 *    `robot.availability` 的 RPC 超时（2s）必须**严格大于** robot 侧探测 DouZero 的超时（1s）。
 *    探测超时（1s）时 fail-open 立刻回「能给」；若 RPC 超时 ≤ 探测超时，**每一次探测超时都会
 *    先把 RPC 砍掉** ⇒ 门禁恒答「能给」= 整条机制失效（v7 的收尾句把 RPC 超时漂回 1s 正是
 *    这个形态；当年全片没有一条判据能抓住它 ⇒ 这里补上）。
 *
 * J28 为什么落在本包：门禁的**宿主**是 room-service（`match.service.ts` 读
 * `this.robot.availability()`），`ROBOT_AVAILABILITY_TIMEOUT_MS` 也由本包
 * `gateway/robot.client.ts` 导出；跨包读 robot-service 源码是本仓成例
 * （`no-internal-http.gate.test.ts` 同样读 game-service 的文件）。
 * T6 的 report 已登记「2000ms 值无直接判据」——本条即为那个缺口的收口。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';

/**
 * 从本文件所在目录**向上**找仓库根（锚 = `packages/room-service` + `packages/game-service` 的
 * 同名 `package.json` 校验）。⚠️ R179：不写固定层数 —— 层数一错会静默扫到主检出的旧文件
 * （闸恒绿）；找不到就**抛错**（宁可红，也不要空测）。
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
    '找不到仓库根（以 packages/room-service + packages/game-service 为锚，起点见 R179 的说明）',
  );
}

const REPO = findRepoRoot();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

// ─── J30 ──────────────────────────────────────────────────────────────────

/** 「读门禁」的探针：`availability` 一词的**任何代码出现**（调用 / 传参 / 字段都算）。 */
const GATE_READER = /availability/;

/** 补位链的两个文件（+ 各自的哨兵：防文件被改名/搬走后「扫到空」也全绿）。 */
const FILL_CHAIN_FILES = [
  { rel: 'packages/room-service/src/rooms/rooms.start.ts', marker: 'class RoomStartService' },
  { rel: 'packages/room-service/src/rooms/rooms.autostart.ts', marker: 'class RoomsAutostartTask' },
] as const;

// ─── J28 ──────────────────────────────────────────────────────────────────

/** 从源码里提取常量值；**找不到就抛错**（常量被改名/删除时闸必须红，绝不静默变绿）。 */
function extractMs(source: string, re: RegExp, what: string): number {
  const m = re.exec(source);
  if (m === null) throw new Error(`找不到 ${what}（${String(re)}）—— 常量被改名/删除？本闸不得静默变绿`);
  return Number(m[1]);
}

const RPC_TIMEOUT_RE = /ROBOT_AVAILABILITY_TIMEOUT_MS = (\d+)/;
const PROBE_TIMEOUT_RE = /PROBE_TIMEOUT_MS = (\d+)/;

describe('J30：门禁不得进好友房 / 自动开局的补位链（片② 裁决 14）', () => {
  it('两条补位链不读 availability（剥注释后零命中）', () => {
    for (const { rel, marker } of FILL_CHAIN_FILES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} 疑似被扫空 / 类被改名`).toContain(marker);
      expect(
        GATE_READER.test(code),
        `${rel} 读了 availability —— 裁决 14：门禁只装匹配链（match.service.ts），补位链读了会把玩家钉死`,
      ).toBe(false);
    }
  });

  it('正对照：探针看得见真实读点 match.service.ts（否则上面的零命中可能是空测）', () => {
    const code = stripComments(read('packages/room-service/src/match/match.service.ts'));
    expect(code).toContain('class MatchService');
    expect(GATE_READER.test(code)).toBe(true);
  });

  it('探针判别力（正/负对照）', () => {
    // 正：真实读取形态
    expect(GATE_READER.test(stripComments('const can = await this.robot.availability();'))).toBe(true);
    // 负：注释里的门禁词不算（先剥注释）；无关标识符不得误伤
    expect(GATE_READER.test(stripComments('// 本文件不读 availability（J30）'))).toBe(false);
    expect(GATE_READER.test(stripComments('/** availability 门禁只在匹配链 */'))).toBe(false);
    expect(GATE_READER.test(stripComments('const unavailableCount = 0;'))).toBe(false);
  });

  it('等价反事实：把门禁接进补位链 ⇒ 探针必命中（这就是闸红的形态）', () => {
    const wrong =
      'export class RoomStartService {\n  async fillBots() {\n' +
      '    if (!(await this.robot.availability())) return null; // 错实现：手动房也读门禁\n  }\n}';
    expect(GATE_READER.test(stripComments(wrong))).toBe(true);
  });
});

describe('J28：门禁的超时预算 —— RPC 超时(2s) 必须严格大于探测超时(1s)（v7 P0 的机械守卫）', () => {
  const rpcSource = (): string =>
    stripComments(read('packages/room-service/src/gateway/robot.client.ts'));
  const probeSource = (): string =>
    stripComments(read('packages/robot-service/src/robot/douzero.health.ts'));

  it('room 侧 RPC 超时 > robot 侧探测超时，且两值就是设计层点名的 2000 / 1000', () => {
    const rpcMs = extractMs(rpcSource(), RPC_TIMEOUT_RE, 'ROBOT_AVAILABILITY_TIMEOUT_MS');
    const probeMs = extractMs(probeSource(), PROBE_TIMEOUT_RE, 'PROBE_TIMEOUT_MS');
    expect(
      rpcMs,
      `RPC 超时 ${rpcMs}ms 未大于探测超时 ${probeMs}ms —— 探测超时时的 fail-open 会恒先触发（v7 的 P0）`,
    ).toBeGreaterThan(probeMs);
    // 两值本身也被设计层点名（D11）⇒ 一并钉住：改任一个值都必须同步改判据（有意为之的摩擦）。
    expect(rpcMs).toBe(2000);
    expect(probeMs).toBe(1000);
  });

  it('探针判别力（正/负对照）：提取函数不静默、不等式真能拦「相等」', () => {
    expect(extractMs('const X = 42;', /X = (\d+)/, 'X')).toBe(42);
    // 常量缺失 ⇒ 抛错（不是变成 NaN 后静默绿）
    expect(() => extractMs('const Y = 1;', /X = (\d+)/, 'X')).toThrow('找不到');
    // 喂 v7 的违规样本：两值相等 ⇒ 不等式必红
    const rpcMs = extractMs('ROBOT_AVAILABILITY_TIMEOUT_MS = 1000;', RPC_TIMEOUT_RE, 'rpc');
    const probeMs = extractMs('PROBE_TIMEOUT_MS = 1000;', PROBE_TIMEOUT_RE, 'probe');
    expect(() => expect(rpcMs).toBeGreaterThan(probeMs)).toThrow();
    // 反向（RPC 反而更小）也必红
    expect(() => expect(500).toBeGreaterThan(1000)).toThrow();
  });
});
