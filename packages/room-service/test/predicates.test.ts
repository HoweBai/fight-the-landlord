/**
 * 风控片 T2：谓词框架的单测（规格 §2.4-1/2 · C1）。
 *
 * 本文件只测**纯函数**（`predicates.ts`）：真值表、启用子集、缺数据 fail-open、
 * 三人三对、机器人透明（调用方契约的断言文档化）。「记忆排除」（`match:rejected`）是
 * **有 IO 的调用方职责**（`match.service` 的随机抽取）—— 它在 `match.service.test.ts`
 * 的 C3 记账矩阵里钉住；本文件用一条纯函数测试把这条边界**显式**钉下来，防误读。
 */
import { describe, expect, it } from 'vitest';
import { canFormTable, PICK_FAILURE_MARK_TTL_MS, sameDevice, sameIp } from '../src/match/predicates';
import type { MatchTicket } from '../src/match/match.service';

/** 票的构造器：本文件的判定只关心 `ip`/`deviceId` 两个可选字段，其余给同构缺省值。 */
const ticket = (playerId: string, fields: { ip?: string; deviceId?: string } = {}): MatchTicket => ({
  playerId,
  mode: 'random',
  baseScore: 15,
  region: 'global',
  enteredAt: 0,
  latency: 0,
  attempts: 0,
  ...fields,
});

describe('谓词真值表（§2.4-2 · C1）', () => {
  it('sameIp：相等即排除；不同 ⇒ 允许', () => {
    expect(sameIp.allows(ticket('a', { ip: '1.1.1.1' }), ticket('b', { ip: '2.2.2.2' }))).toBe(true);
    expect(sameIp.allows(ticket('a', { ip: '1.1.1.1' }), ticket('b', { ip: '1.1.1.1' }))).toBe(false);
  });

  it('sameDevice：相等即排除；不同 ⇒ 允许', () => {
    expect(
      sameDevice.allows(ticket('a', { deviceId: 'dev-1' }), ticket('b', { deviceId: 'dev-2' })),
    ).toBe(true);
    expect(
      sameDevice.allows(ticket('a', { deviceId: 'dev-1' }), ticket('b', { deviceId: 'dev-1' })),
    ).toBe(false);
  });

  it('双同（ip 与 device 都是同一对值）⇒ 两谓词各自拒绝；全异 ⇒ 双允许（判定只看各自那一维）', () => {
    const x = ticket('a', { ip: '1.1.1.1', deviceId: 'dev-1' });
    const y = ticket('b', { ip: '1.1.1.1', deviceId: 'dev-1' });
    expect(sameIp.allows(x, y)).toBe(false);
    expect(sameDevice.allows(x, y)).toBe(false);

    const z = ticket('c', { ip: '9.9.9.9', deviceId: 'dev-9' });
    expect(sameIp.allows(x, z)).toBe(true);
    expect(sameDevice.allows(x, z)).toBe(true);
  });

  it('缺数据 fail-open（§2.4-2）：任一缺字段 ⇒ 该谓词允许；单边缺也算缺', () => {
    const full = ticket('a', { ip: '1.1.1.1', deviceId: 'dev-1' });
    const bare = ticket('b'); // 旧客户端 / 注入失败：两字段都缺
    expect(sameIp.allows(full, bare)).toBe(true);
    expect(sameIp.allows(bare, full)).toBe(true);
    expect(sameDevice.allows(full, bare)).toBe(true);
    expect(sameDevice.allows(bare, full)).toBe(true);
    expect(sameIp.allows(bare, ticket('c'))).toBe(true);
    expect(sameDevice.allows(bare, ticket('c'))).toBe(true);
  });

  it('name 是稳定字面量（指标标签 `{predicate}` 与 `risk:hit:{userId}:{predicate}` 键的单一真源）', () => {
    expect(sameIp.name).toBe('sameIp');
    expect(sameDevice.name).toBe('sameDevice');
  });

  it('PICK_FAILURE_MARK_TTL_MS = 5000（§2.3：match:rejected 5s）', () => {
    expect(PICK_FAILURE_MARK_TTL_MS).toBe(5000);
  });
});

describe('canFormTable：全两两（§2.4-1 · C1）', () => {
  it('启用子集：只跑 enabled 里的谓词 —— 同 device 对在「只启用 sameIp」时通过', () => {
    const a = ticket('a', { ip: '1.1.1.1', deviceId: 'dev-1' });
    const b = ticket('b', { ip: '2.2.2.2', deviceId: 'dev-1' });
    expect(canFormTable([a, b], [sameIp])).toBe(true);
    expect(canFormTable([a, b], [sameDevice])).toBe(false);
    expect(canFormTable([a, b], [sameIp, sameDevice])).toBe(false);
    expect(canFormTable([a, b], [])).toBe(true); // 谓词全关 ⇒ 全允许
  });

  it('三人的三对全查：第 3 对（c 与 a 同 ip）否 ⇒ false（只查「相邻对」的实现会假绿）', () => {
    const a = ticket('a', { ip: '1.1.1.1' });
    const b = ticket('b', { ip: '2.2.2.2' });
    const c = ticket('c', { ip: '1.1.1.1' }); // 与 a 同、与 b 不同
    expect(canFormTable([a, b], [sameIp])).toBe(true);
    expect(canFormTable([a, b, c], [sameIp])).toBe(false);
  });
});

describe('机器人透明（§2.4-6 · C1：调用方保证，断言文档化）', () => {
  it('对「像机器人」的票不做任何特殊处理 —— 「机器人从不传入」是 match.service 的调用方契约', () => {
    // 机器人透明（§2.4-6）的落点：match.service 只把**真人**子集交给本函数
    //（补机器人的三条入口：<3 越窗 · 最大合法子集 · 到点兜底 —— 三处同规）。
    // 本函数没有 isRobot 概念（MatchTicket 也不带该字段）⇒ 这里用行为钉住
    //「判定只看 ip/deviceId，不因 playerId 形态而变」：
    const botLike = ticket('p_00000001', { deviceId: 'dev-robot' });
    const sameDevHuman = ticket('u1', { deviceId: 'dev-robot' });
    const otherHuman = ticket('u2', { deviceId: 'dev-other' });
    expect(canFormTable([botLike, sameDevHuman], [sameDevice])).toBe(false); // 同 device ⇒ 拒绝
    expect(canFormTable([botLike, otherHuman], [sameDevice])).toBe(true);
  });

  it('纯函数（无 IO）：「记忆排除」由调用方（match.service 抽取时查 match:rejected）承担 —— 同输入恒同输出', () => {
    const a = ticket('a', { deviceId: 'dev-1' });
    const b = ticket('b', { deviceId: 'dev-1' });
    expect(canFormTable([a, b], [sameDevice])).toBe(false);
    // 再调一次（不受任何外部状态/调用历史影响）—— 若把记忆检查塞进本函数的实现，
    // 这条会以「两次结果不同」的形态现形。
    expect(canFormTable([a, b], [sameDevice])).toBe(false);
  });
});
