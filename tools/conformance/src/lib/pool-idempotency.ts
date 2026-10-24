/**
 * **幂等 acquire 的绝对性质谓词**（`R201` / `R253` / `R340`）—— conformance 的**唯一实现**。
 *
 * 为什么抽到 `lib/`：`slice-11` 第 6 组（`runIdempotentAcquire`）与 `slice-07.2-rpc` 第 6 组
 * 判的是**同一件事**（对同一 `{roomCode, seats:[1]}` 连调两次 `robot.acquire` ⇒ 同一个 bot +
 * 那次 acquire **对池没有副作用**）。两处各写一份「三条绝对性质」正是本片要消灭的东西
 * （P7 的 Task 1/B2 就是在删「同一事实的第二真源」；本项目的约定是：同一事实只有一份实现）。
 *
 * ⚠️ **只有谓词共用，Redis 探针外壳不共用**（两处的 `redisCli`/`poolMembers` 签名不同：
 * `slice-11` 用「返回 `{status, stdout, stderr}`、由调用方判退出码」的形态，
 * `slice-07.2-rpc` 用「退出码非 0 即抛」的形态）。把外壳拉平会改掉 `slice-11` 第 5 组
 * 既有的错误路径语义 —— 那是**为了共用而把两处语义拉平**，本片明确不许（R360）。
 *
 * 它取代的是那条**相对量**等式 `poolAfterSecond.length === poolAfterFirst.length`：
 * 那种等式实际断言的是「我这两次读池之间没有第三方动过池」（`releaseRobots()` 是 `void` 异步、
 * `reclaimIdle()` 每 60s 一次、跨运行的晚到 `release` 也会落地 ⇒ **假红**），而它对
 * 「池退化成 0 / 容量静默丢失 / 幽灵成员（N22）」**完全免疫**（P3 教训第 2 条）。
 */

/**
 * **悬挂成员** = 「在池索引里、却没有 `bot:{id}` 记录」。
 *
 * ⚠️ **纯函数**（记录是否存在由入参谓词决定，函数自己不碰 Redis）：判据纪律是「Redis 只读」，
 * 因此**不能**靠往池里注入合成成员来证明谓词有判别力；纯函数形态让正/负对照可以在
 * **不写 Redis** 的前提下完成（R115/R212②：断言「没有发生」之前先证明探针能观测到「发生」）。
 */
export function danglingMembers(
  members: readonly string[],
  exists: (botId: string) => boolean,
): string[] {
  return members.filter((id) => !exists(id));
}

/**
 * 第 6 组**幂等 acquire 的绝对性质**谓词（**纯函数**）：返回违规清单，空数组 = 通过。
 *
 * 三条都是绝对性质，**没有一条比较长度或差值**：
 *
 *  ① **窗口内没有新增池成员**：`after` 里**不在** `before` 里的成员必须为空
 *     （`before`/`after` 是**紧贴第 2 次 acquire** 的前后两次读 ⇒ 窗口就是那次 acquire 本身）。
 *     ⚠️ **窗口为什么必须收紧**：旧等式的窗口是「读 1（第 1 次 acquire 之后）→ 读 2」，
 *     它**横跨了两次 acquire 之间的调度/IO 间隙** —— 第三方（别的房间/别的运行）的
 *     `void release` 恰好落在那个间隙里，就进了 `after` 而没进 `before`
 *     ⇒ 旧等式红（**假红**）。若新判据沿用同一个窗口，它会**继承这个假红形态**
 *     （受控构造实测：宽窗口报 1 条违规、窄窗口 0 条 —— R341）。
 *     ⚠️ 判别力的来源不是这个窗口，而是：`acquire()` 对池**没有任何入池路径**
 *     （`findBound()` 命中即 `continue`，只有 `release()` 会 `ZADD`）⇒ 窗口内真出现新增成员
 *     一定是 bug（受控构造 + 合成输入都证明这条谓词抓得住，R115）。
 *  ② **第 2 次 acquire 返回的那个 bot 不得回池**：它**正被占用**（`ZREM` 之后不得回池）；
 *  ③ **池里每个成员都必须有 `bot:{id}` 记录**（悬挂为 0）——
 *     与 `slice-07.2-rpc` 第 2 组、`slice-11` 第 5 组**同源**（N22 的幽灵成员正是这样藏的）。
 *
 * 纯函数形态让「判别力自证」（R115）可以用**合成输入**完成：同一个谓词喂
 * 「窗口内被造出一个新增成员 / 被占用的 bot 回池 / 池成员缺记录」三种坏输入必须逐条报违规，
 * 而干净输入必须不报（否则判据恒红）。不需要往共享 Redis 里写任何东西。
 *
 * @param before      紧邻窗口**之前**的池成员（`ZRANGE`）
 * @param after       窗口**之后**的池成员
 * @param secondBotId 第 2 次 acquire 返回的 bot（内部 `bot-…`）
 * @param exists      `bot:{id}` 记录是否存在（谓词注入 ⇒ 正/负对照可合成）
 */
export function idempotentAcquireViolations(
  before: readonly string[],
  after: readonly string[],
  secondBotId: string,
  exists: (botId: string) => boolean,
): string[] {
  const violations: string[] = [];
  const beforeSet = new Set(before);
  const added = after.filter((id) => !beforeSet.has(id));
  if (added.length > 0) {
    violations.push(
      `第 2 次 acquire 的窗口内新增了池成员 ${JSON.stringify(added)}` +
        `（窗口前 ${JSON.stringify(before)} → 窗口后 ${JSON.stringify(after)}）` +
        ' —— acquire 只能**取出**，唯一的入池口是 `release()`/§9.6 归池',
    );
  }
  if (after.includes(secondBotId)) {
    violations.push(
      `第 2 次 acquire 返回的 bot \`${secondBotId}\` 又在池里（它**正被占用**：` +
        '`takeIdle()`/`bind()` 的 `ZREM` 之后不得回池）',
    );
  }
  const dangling = danglingMembers(after, exists);
  if (dangling.length > 0) {
    violations.push(
      `池里有**悬挂成员**（索引里有、\`bot:{id}\` 记录不存在）${JSON.stringify(dangling)}`,
    );
  }
  return violations;
}
