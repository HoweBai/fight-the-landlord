// packages/room-service/src/match/predicates.ts
import type { MatchTicket } from './match.service';

/**
 * 风控片 §2.4-1（实现形 v1.1.2）：单条匹配谓词。
 *
 * 语义 = `allows(a, b) === true` ⇒ 允许 a、b 同桌（规格的语义形是裸函数 `(a, b) => boolean`；
 * 实现形改成「对象 + allows」是为了给 `name` 一个载体 —— 指标标签
 * `match_predicate_rejections_total{predicate}` 与命中键 `risk:hit:{userId}:{predicate}`
 * 都要按谓词名分桶，函数类型承载不了标签）。
 */
export interface MatchPredicate {
  name: 'sameIp' | 'sameDevice';
  allows(a: MatchTicket, b: MatchTicket): boolean;
}

/** `match:rejected` 记忆的 TTL（§2.3：值 = 失败时刻 ms；TTL **5s**）。 */
export const PICK_FAILURE_MARK_TTL_MS = 5_000;

/**
 * §2.4-2 / 设计 D1：同 `ip` ⇒ **排除**（相等即排除）；任一缺 `ip` ⇒ **允许**
 *（缺数据 fail-open —— 旧客户端与注入失败不打灭匹配）。
 */
export const sameIp: MatchPredicate = {
  name: 'sameIp',
  allows: (a, b) => !(a.ip && b.ip && a.ip === b.ip),
};

/**
 * §2.4-2：同 `deviceId` ⇒ **排除**（与 `sameIp` 同构；缺 `deviceId` ⇒ 允许）。
 * ⚠️ 判定**只看已同桌的真人子集**（§2.4-6 机器人透明）—— 调用方保证机器人从不传入。
 */
export const sameDevice: MatchPredicate = {
  name: 'sameDevice',
  allows: (a, b) => !(a.deviceId && b.deviceId && a.deviceId === b.deviceId),
};

/**
 * 注册表（名称 ⇒ 实例的**单一真源**）：`match.service` 按 config 开关从中取用，
 * 防「两处各 new 一份谓词实例」（将来加谓词时那种漂移会让指标标签与判定对不上）。
 */
export const PREDICATE_REGISTRY: Record<MatchPredicate['name'], MatchPredicate> = {
  sameDevice,
  sameIp,
};

/**
 * §2.4-1：**全两两**判定 —— 对 `players` 的每一对跑**启用**的谓词；任一不过 ⇒ `false`。
 *
 * 纯函数、**无 IO**：`match:rejected` 的「记忆排除」是匹配扫描器（`match.service` 的
 * 随机抽取）的职责 —— 那里有 Redis 边，本函数没有（`predicates.test.ts` 有一条
 * 「同输入恒同输出」把这条边界显式钉住）。
 *
 * ⚠️ **机器人透明**（§2.4-6）：谓词只判定「将同桌的**真人**子集」——调用方不得把机器人
 * 传入（`MatchTicket` 也没有 `isRobot` 字段；补机器人的三条入口一律先对真人子集判定）。
 */
export function canFormTable(players: MatchTicket[], enabled: readonly MatchPredicate[]): boolean {
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      for (const predicate of enabled) {
        if (!predicate.allows(players[i]!, players[j]!)) return false;
      }
    }
  }
  return true;
}
