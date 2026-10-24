/**
 * 断言与输出工具。
 *
 * 机械断言，不用散文：每条 check 都会打印，失败抛 `ConformanceError`。
 * §6.4 规则 4 的「永不出站字段」检查在这里只有一份实现 —— 所有切片共用。
 */

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceError';
  }
}

/** 一条被显式跳过的断言：`message` = 该断言的文案，`reason` = 为什么在本环境构造不出。 */
export interface SkippedAssertion {
  readonly message: string;
  readonly reason: string;
}

/**
 * §6.4 规则 4：永不出站的字段。
 *
 * ⚠️ N27（收口）：`deck` 曾在此列 —— 它作为 `GameSession` 的字段**已按 §3.2 删除**（发牌后牌堆为空，
 * 保留只会误导），而 `PlayerView` 自始不含它 ⇒ 这条禁止项对当前契约是空转的，故移除。
 */
export const LEAK_KEYS = [
  'actionLog',
  'isRobot',
  'botId',
  'skillLevel',
  'thinkingSpeed',
  'players',
  // 多玩法（S7.3）：pdk 会话内部/规则态字段永不出站（spec §4.5.1）。
  'rules',
  'unusedCards',
  'lastPlayedHand',
  'initialHands',
  'botIds',
  'botSkillLevels',
  'botThinkingSpeeds',
] as const;

/** 他人手牌的检查：出站载荷里不得出现 `hand` 之外的牌面数组字段。 */
export function step(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n▶ ${message}`);
}

export function info(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`   ${message}`);
}

/** 通过的检查：收集起来，最后统一打印。 */
export class Checks {
  readonly passed: string[] = [];

  /**
   * **显式跳过**的断言（环境提供不了构造该判据的条件，例如本机没有 `flock`）。
   *
   * ⚠️ 与 `passed` **分开记、绝不混入**：本仓的复发失败形态是「判据存在 ≠ 判据有效」——
   *    一条**不可能失败**的断言比没有断言更坏，它制造的是虚假的信心。所以跳过只有这一个
   *    写法（`skip()`）：打印出来、带原因、计入收尾汇总（`run.ts` 的「跳过 N 项」）。
   *    本机的「带 N 条跳过的绿」是诚实的绿；「N 条假通过」不是。
   */
  readonly skipped: SkippedAssertion[] = [];

  ok(message: string): void {
    this.passed.push(message);
    // eslint-disable-next-line no-console
    console.log(`  ✅ ${message}`);
  }

  /**
   * 登记一条**被跳过**的断言：环境缺条件时**只**能用它 —— 绝不许改写成 `ok()` 的一句
   * 「通过（其实没验）」。`reason` 必须说清缺的是什么、为什么构造不出、以及哪里会真跑。
   */
  skip(message: string, reason: string): void {
    this.skipped.push({ message, reason });
    // eslint-disable-next-line no-console
    console.log(`  ⏭️  ${message}`);
    // eslint-disable-next-line no-console
    console.log(`       ↳ 跳过原因：${reason}`);
  }

  /** 断言条件为真，否则抛错。 */
  that(condition: unknown, message: string): void {
    if (!condition) throw new ConformanceError(message);
    this.ok(message);
  }

  eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) {
      throw new ConformanceError(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
    this.ok(`${what} = ${JSON.stringify(actual)}`);
  }

  /**
   * ⚠️ 上面的 `eq` 用 `!==` 比较 ⇒ **数组/对象字面量永远不相等**（哪怕内容一样）。
   *
   * 所以**不要**写 `checks.eq(someArray, [], …)` 或 `checks.eq(someObj, {…}, …)`：那种断言在
   * **任何**实现上都失败，最诱人的「修法」是把判据删掉（切片 9 执行期实测，R176）。
   * 判数组用 `checks.that(arr.length === 0, msg + arr.join(' | '))` —— 把违例原文拼进消息，
   * 失败时才看得到是哪一条；判对象先自行取字段或 `JSON.stringify` 成字符串再比。
   */

  atLeast(actual: number, floor: number, what: string): void {
    if (!(actual >= floor)) {
      throw new ConformanceError(`${what}：期望 ≥ ${floor}，实际 ${actual}`);
    }
    this.ok(`${what} = ${actual}（≥ ${floor}）`);
  }
}

/**
 * 出站载荷的泄漏检查（§6.4 规则 4）。
 *
 * 注意 `players` 也在黑名单里：`PlayerView` **没有** `players` 字段，
 * 出现它说明有人把 `GameSession` 直接下发了。
 *
 * ⚠️ **不能**用它检查 `room.join` / `room.state_update` 的 ack：那两种载荷里的
 * `players`（`RoomPlayer[]`）是**合法**字段（§6.3/§6.4 规则 3）。房间成员载荷请
 * **手写**断言（字段集恰好 `id,seat[,cardCount]` + id 无 `bot` 前缀），
 * 见 `slice-07-match-join.ts` 与 `slice-07.1-room-atomic-seating.ts`。
 */
export function assertNoLeak(raw: unknown, where: string): void {
  const text = JSON.stringify(raw ?? null);
  const hits = LEAK_KEYS.filter((key) => text.includes(key));
  if (hits.length > 0) {
    throw new ConformanceError(`${where} 出站载荷泄漏：${hits.join(', ')}（§6.4 规则 4）`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 字段集比较（**恰好**语义）：返回人话的「缺 x / 多 y」清单，空数组 = 完全一致。
 *
 * 用于所有「字段集恰好是这些」的判据（N9 的 `HKEYS room:{code}`、§2.4 的 `checks` 键集合）。
 * 一条判据同时抓「少报」与「多报」—— 后者正是 R267 点名的假信息形态
 * （「不得为了看起来齐全而报一个自己并不依赖的 `mysql: 'up'`」）。
 *
 * ⚠️ **只有一份实现**（P5/Task 5）：正/负对照与实际判定共用它，因此「谓词有没有判别力」
 * 可以直接用合成输入证明（R115），而不是靠再写一个「差不多的」比较器。
 */
export function fieldSetViolations(actual: readonly string[], expected: readonly string[]): string[] {
  const missing = expected.filter((field) => !actual.includes(field)).map((field) => `缺 ${field}`);
  const extra = actual.filter((field) => !expected.includes(field)).map((field) => `多 ${field}`);
  return [...missing, ...extra];
}
