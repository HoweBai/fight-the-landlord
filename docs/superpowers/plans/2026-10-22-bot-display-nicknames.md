# 机器人拟人昵称 · 实现计划

> 依据：[设计 spec](../specs/2026-10-22-bot-display-nicknames-design.md)（已过对抗审查）
> 分支：`feature/nickname`（从 `dev` 开出）
> 纪律：每个任务 TDD（红 → 绿 → 提交）；不夹带无关重构；提交信息带 attribution。

---

## Global Constraints

1. **客户端零改动**：不得修改 `apps/client/**`（工作区已有未提交的 `rest.ts` / `history.vue`
   改动，属于用户，不得纳入本片提交）。规范/计划文档已全部提交，无遗留文档改动。
2. **不动 robot-service / `robot.acquire` 协议**；机器人 `displayId` 绝不落库。
3. 昵称池元素不含 `机器人` / `人机` / `电脑` / `AI` / `bot` / `系统` / `官方`。
4. 新增路径一律 **fail-open**：分配、Hash 读写、记录快照读取失败都不得阻塞开局/记录。
5. 引用键名一律走助手：`nicknamesKey()` / `botsKey()` / 新增 `botNamesLockKey()`，
   不写死字面量。
6. 提交信息末尾：
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
7. 每个任务完成后更新本计划的勾选状态，并单独提交。

---

## Task 1: protocol 契约 — `RecordWriteRequest.seats[].nickname?`

**Files**
- `packages/protocol/src/rpc.ts`
- `packages/protocol/src/rpc.test.ts`

**TDD**
1. 在 `rpc.test.ts` 增加类型用例：构造 3 座请求，机器人座带 `nickname: '阿豆'`，
   人类座 `nickname: null`；断言类型可构造。
2. 运行 `pnpm -C packages/protocol lint` ⇒ **红**（`nickname` 不在类型上）。
3. 在 `RecordWriteRequest.seats` 元素类型增加：
   ```ts
   /** 仅机器人座：本局展示昵称快照；人类座必须省略/null（由 user-service 查 users）。 */
   nickname?: string | null;
   ```
   并补注释说明「room 只从昵称 Hash 读取，displayId 不落库」。
4. 运行 `pnpm -C packages/protocol test && pnpm -C packages/protocol lint` ⇒ **绿**。
5. **必须**运行 `pnpm -C packages/protocol build`：room-service / user-service 的
   `tsc --noEmit` 读的是 `packages/protocol/dist/*.d.ts`（`main/types` 指向 `dist/`），
   不 build 会按旧类型报 TS2353/TS2339。`dist/` 已 gitignore，不能靠提交解决。
6. 提交：`feat(protocol): record.write 支持机器人昵称快照字段`

**回归**
- `pnpm -C packages/protocol test`
- `pnpm -C packages/protocol lint`
- `pnpm -C packages/protocol build`

---

## Task 2: `bot-names` 模块（池 / 分配 / 短锁 / 落盘）

**Files**
- 新增 `packages/room-service/src/rooms/bot-names.ts`
- 新增 `packages/room-service/test/bot-names.test.ts`
- 修改 `packages/room-service/src/rooms/rooms.seats.ts`（新增 `botNamesLockKey()`）
- 修改 `packages/room-service/test/helpers/fake-redis.ts`（`makeFakeEval` 增加 `strings` 参数与释放锁脚本）
- 修改 `packages/room-service/test/match.service.test.ts`（第二个 `makeFakeEval(hashes, strings)` 调用点）

**Interfaces**

```ts
export const BOT_DISPLAY_NAMES: readonly string[]; // ≥ 200，2–8 字，唯一，无禁词
export function fnv1a32(input: string): number;

export function assignBotDisplayNames(
  roomCode: string,
  robots: ReadonlyArray<{ seat: number; displayId: string }>,
  taken?: Iterable<string>,
): Array<{ displayId: string; nickname: string }>;

export async function ensureBotDisplayNames(
  redis: Redis,
  roomCode: string,
  robots: ReadonlyArray<{ seat: number; displayId: string }>,
  options?: { sleep?: (ms: number) => Promise<void>; spinAttempts?: number; spinIntervalMs?: number },
): Promise<void>;
```

**实现要点**
- `rooms.seats.ts` 新增 `botNamesLockKey(code)`（返回 `room:{code}:botnames:lock`）。
- `BOT_DISPLAY_NAMES`：精选中文昵称（目标 240 个），测试机械校验长度/唯一性/禁词。
- `assignBotDisplayNames`：
  - 按 `seat` 升序处理；`index = fnv1a32(`${roomCode}:${displayId}:${seat}`) % pool.length`；
  - 与 `taken` 或本批已用名字重复 ⇒ 线性探测（最多 `pool.length` 次）；
  - 探测耗尽 ⇒ 跳过该机器人（不抛、不死循环）。
- `ensureBotDisplayNames`：
  1. `robots.length === 0` ⇒ 直接返回（零 Redis 调用）。
  2. 抢锁：`SET botNamesLockKey(code) <randomUUID> EX 3 NX`；失败则 `sleep(20)` 重试
     `spinAttempts`（默认 15）次；仍失败 ⇒ `logger.warn` 后返回。**每次抢锁用新 token**。
  3. `hgetall(nicknamesKey(code))`；失败 ⇒ `logger.warn` + `{}`。
  4. `missing = robots.filter(r => !(r.displayId in hash))`。
  5. `assignBotDisplayNames(code, missing, Object.values(hash).filter(v => v !== ''))`
     —— 空串是「已知无昵称」哨兵，不参与撞名。
  6. 逐字段 `hsetnx`；**只要本次有任何字段写入成功，就在 `finally` 里 `expire`**
     （即使后续字段抛错也要保证 TTL）。
  7. `finally`：Lua compare-and-delete 释放锁（token 匹配才删）；失败只 WARN。
  - 整个函数 **catch 所有异常并 WARN**，绝不向外抛。
- 锁脚本常量：
  ```lua
  if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end
  ```

**TDD（先写测试，确认红）**
- 池：≥ 200、唯一、2–8 字、无禁词。
- `assignBotDisplayNames`：输入乱序结果稳定；同输入幂等；`taken` 去重；探测上界；
  `taken` 里的空串不影响结果。
- 换房间：固定 `displayId/seat`，50 个 `roomCode` 的结果集合 > 1。
- `ensureBotDisplayNames`：
  - 正常写入：字段/TTL 正确；
  - 已存在 `displayId` 不覆盖；
  - 锁被占用（fake `set` 返回 `null`）+ 注入 `sleep: async () => {}` ⇒ 不写、不抛；
  - **锁释放**：正常结束后 `await redis.exists(botNamesLockKey(code)) === 0`；
  - **token 不匹配不删锁**：fake eval 的锁值与传入 token 不同 ⇒ 返回 0、锁仍在；
  - `hgetall` / `hsetnx` 抛错 ⇒ 不抛；
  - **部分 `hsetnx` 成功后抛错 ⇒ 昵称键仍有 TTL**；
  - `robots=[]` ⇒ 零调用。
- 扩展 `makeFakeEval(hashes, strings)`：
  - 识别释放锁脚本并按 token 匹配删除；
  - 其他脚本仍抛错（保持替身纪律）；
  - 同步更新 `fake-redis.ts:263` 与 `match.service.test.ts:226` 两个调用点；
  - `match.service.test.ts` 的 `beforeEach` 补齐 `_strings.clear()`（锁 TTL 不推进时
    不会残留到下一用例）。
- 注：`createFakeRedis.set` 已支持 `EX/NX`，无需扩展；`hsetnx` 语义已实现。

**实现后**
- `pnpm -C packages/room-service test -- bot-names` ⇒ 绿。
- 提交：`feat(room): 机器人拟人昵称池与房间级分配`

---

## Task 3: `startRoom` 接入（覆盖全量机器人座位）

**Files**
- `packages/room-service/src/rooms/rooms.start.ts`
- `packages/room-service/test/rooms.start.test.ts`
- `packages/room-service/test/match.service.test.ts`（两条既有 `redis.set` 精确断言）

**改动**
- 在 `startRoom` 中、`fillBots` 成功之后、`match:pending` / 余额 / `startAndAnnounce` 之前：
  ```ts
  await ensureBotDisplayNames(
    this.redis,
    code,
    filled.seats
      .filter((s) => s.isRobot)
      .map((s) => ({ seat: s.seat, displayId: s.userId })),
  );
  ```
- 不放在 `fillBots` 内部（覆盖预置机器人、半途失败重试、房间已满早返）。
- `match.service.test.ts:2574` / `:2701` 的 `expect(redis.set).not.toHaveBeenCalled()`
  会因新锁而红：改为只断言拒绝记账键，例如
  `expect(redis.set.mock.calls.filter(([k]) => String(k).startsWith('match:rejected:'))).toHaveLength(0)`。
  三条满房用例（`:2211/:2233/:2302/:2614`）无机器人 ⇒ ensure 早返、不发锁，保持原样。

**TDD（先写测试，确认红）**
1. 扩展既有 `ROOM10` 用例：预置 `p_deadbeef` → `startRoom` 后
   `room:ROOM10:nicknames` 含 `p_deadbeef` 且值非空。
2. 半途 acquire 失败重试：`acquireBot` 内部**重试恰好 1 次**（`RPC_MAX_ATTEMPTS = 2`），
   因此必须让目标座位的**两次** acquire 都失败（handler 持续失败到首次 `startRoom`
   结束，或按调用次数让第 1、2 次都抛）⇒ 首次 `startRoom` 返回 false；恢复后重试
   ⇒ 先入座机器人与新机器人都带昵称。
3. 昵称写入失败：**不能用 `mockRejectedValueOnce`** —— 第一次 `hsetnx` 会被
   `rooms.addBot → claimSeat` 消耗。改为 `mockImplementation` **按首参过滤**：
   ```ts
   const orig = redis.hsetnx.getMockImplementation()!;
   redis.hsetnx.mockImplementation(async (key, field, value) => {
     if (key === nicknamesKey('ROOMXX')) throw new Error('nickname write failed');
     return orig(key, field, value);
   });
   ```
   ⇒ `startRoom` 仍返回 true、`game.start` 照常调用。
4. 运行 `pnpm -C packages/room-service test -- rooms.start match.service` ⇒ **红**。
5. 实现接入 ⇒ 绿。
6. 提交：`feat(room): 开局为全量机器人座位分配拟人昵称`

**回归**
- `pnpm -C packages/room-service test -- rooms.start match.service`

---

## Task 4: 昵称读路径与下发的判别力测试

**Files**
- `packages/room-service/test/room-nicknames.service.test.ts`
- `packages/room-service/test/message.router.test.ts`

**改动**
- `room-nicknames.service.test.ts` 增加真实 `RoomNicknamesService + fakeRedis` 用例：
  - Hash 预置 `{ p_abc: '阿豆' }` ⇒ `ensure` 返回 `p_abc → 阿豆`，且
    `client.getNicknames` 不被调用；
  - 无缓存负例仍保持。
- `message.router.test.ts` 更新旧用例：
  - 原「机器人/缺失则省略」改为「人类昵称原样、机器人昵称来自 ensure 的缓存」；
  - 至少一条用例使用**真实** `RoomNicknamesService`（fake Redis 预置 displayId 条目），
    不得只 mock 一个 Map。
- **判别力自证**：临时把 `ensure` 的 `out` 改成过滤 `p_` 前缀 ⇒ 新用例必须变红；
  恢复后绿。把这一步写进提交信息或本计划备注。

**TDD**
- **本任务无生产改动**：`RoomNicknamesService.ensure` 本来就会返回已缓存条目；
  本任务的价值是回归钉死读路径，防止未来误加 `isRobot` 过滤。
- 先改测试；用定向 mutation 自证判别力：
  临时把 `ensure` 的 `out` 改成 `if (!userId.startsWith('p_')) out.set(...)` ⇒ 新用例必须变红；
  恢复后绿。把这一步写进提交信息或本计划备注。
- 运行 `pnpm -C packages/room-service test -- room-nicknames message.router` ⇒ 绿。
- 提交：`test(room): 机器人昵称读路径与下发判别力`

---

## Task 5: user-service 记录快照

**Files**
- `packages/user-service/src/rpc/record.rpc.controller.ts`
- `packages/user-service/test/record.rpc.test.ts`
- `packages/user-service/test/records.query.test.ts`

**改动**
1. `invalidReason` 的 seat 循环增加：
   - `nickname` 允许 `undefined` / `null` / 字符串；
   - 字符串 trim 后必须 1–50 字符；
   - `!seat.isRobot && seat.nickname`（非空）⇒ 拒收；
   - `!seat.isRobot && seat.userId === null` ⇒ 拒收。
2. INSERT 的 nickname 列：
   ```ts
   seat.isRobot
     ? (seat.nickname?.trim() || null)
     : (nicknameById.get(seat.userId!) ?? null)
   ```
3. 昵称快照查询仍只查 `userId !== null` 的人类（既有逻辑不变）。

**TDD（先写测试，确认红）**
- 机器人座带 `nickname=' 阿豆 '` ⇒ 落库 `'阿豆'`。
- 机器人座不带 nickname ⇒ 落库 `NULL`。
- 人类座携带 nickname ⇒ `BAD_PARAM`。
- `!isRobot && userId=null` ⇒ `BAD_PARAM`。
- nickname 非字符串 / trim 空 / 51 字 ⇒ `BAD_PARAM`。
- 既有「人类快照来自 users」「displayId 不落库」断言保持。
- `records.query.test.ts`：
  - 机器人昵称非空时原样透出（guard 用例）；
  - 既有「机器人恒 NULL」用例名/注释改为「旧数据 / 无快照机器人返回 null」
    （断言本身仍成立，避免新数据路径下名不副实）。
- 运行 `pnpm -C packages/user-service test -- record.rpc records.query` ⇒ 红 → 实现 → 绿。
- 提交：`feat(user): 记录快照支持机器人展示昵称`

---

## Task 6: `ws.gateway` 记录快照与读取时序

**Files**
- `packages/room-service/src/gateway/ws.gateway.ts`
- `packages/room-service/test/ws.gateway.test.ts`

**改动**
1. `onGameEvent` 的 `game.ended` 分支：
   - 先 `void this.finalizeRoomEnd(event, result)`；
   - 再 `void this.roomsService.updateStatus(...,'finished').catch(...)`。
2. `finalizeRoomEnd` 顶部、**第一个 await 之前**：
   ```ts
   const botNicknamesPromise = this.redis
     .hgetall(nicknamesKey(event.roomCode))
     .catch((err) => { this.logger.warn(...); return {} as Record<string,string>; });
   ```
   随后照旧读 bots；最后 `const botNicknames = await botNicknamesPromise;`
3. `writeGameRecord(event, record, result, botBySeat, endedAt, botNicknames)`：
   - 机器人座 `nickname: botNicknames[seat.userId] ?? null`；
   - 人类座 `nickname: null`。
4. 保持 `deleteRoom` 删 `nicknamesKey` 的现状（读取时序已保证先读后删）。

**TDD（先写测试，确认红）**
- `makeRecordFixtures` 预置 `room:ROOM1:nicknames`：
  `p_bot0001 → 阿豆`、`p_bot0002 → 小北`；
  断言请求 seats[1]/[2] 的 nickname、seats[0] 为 `null`。
- 既有精确 `toEqual`（`:1857-1871`）同步加 `nickname` 字段。
- 昵称 Hash 读失败（`hgetall.mockRejectedValueOnce`）⇒ 机器人 nickname `null`，记录仍写入。
- 时序：spy `rooms.updateStatus`，并用
  `redis.hgetall.mock.calls.findIndex(([key]) => key === nicknamesKey('ROOM1'))`
  定位**昵称键**的读取（不要用「任意 hgetall」—— bots / 房间元数据也会调用）；
  断言 `readIdx >= 0`（反空测）且其 `invocationCallOrder` 小于 `updateStatus`。
  另：`hgetall.mockRejectedValueOnce` 用例的前提是昵称 Hash 已预置、
  且该次 rejection 只作用于昵称键（用 `mockImplementation` 按 key 过滤，
  避免 bots 读先消耗掉）。
- 运行 `pnpm -C packages/room-service test -- ws.gateway` ⇒ 红 → 实现 → 绿。
- 提交：`feat(room): 历史记录快照机器人昵称并固定读取时序`

---

## Task 7: 文档同步

**Files**
- `docs/design.md`：`:1337`、`:1351-1352`、§10.1 键表 `:1621-1639`
- `packages/protocol/src/views.ts`：`RoomPlayer.nickname` 注释
- `docs/superpowers/specs/2026-10-17-nickname-design.md`：§3.3 / §6
- `docs/superpowers/specs/2026-10-03-records-design.md`：`:190,217,309`
- `docs/superpowers/specs/2026-10-03-records-spec.md`：`:50`
- 如 `docs/client-protocol.md` 有相关表述，同步

**改动**
- 把「机器人昵称恒 NULL / 机器人恒无昵称 ⇒ 玩家N / 零区分器」改为：
  「机器人由 room-service 分配展示昵称并写入快照；昵称缺失时回落玩家N」。
- `§10.1` 补两行：
  - `room:{code}:nicknames`（Hash、room-service、3600s、field = userId/displayId、
    空串 = 已知无昵称）；
  - `room:{code}:botnames:lock`（String、room-service、3s、仅分配临界区短锁；
    `deleteRoom` 不删它，靠 TTL 过期）。
- 历史 spec 加「已被 2026-10-22 设计取代」注记，不改写历史结论。

**验证**
- `rg '机器人昵称|机器人.*玩家N|nickname.*NULL' docs packages/protocol/src/views.ts`
  确认无残留矛盾表述。
- 提交：`docs: 同步机器人拟人昵称的契约与设计说明`

---

## Task 8: 回归面排查 + 全量验证 + 合并推送

**回归面**
```bash
rg 'nickname' tools/conformance scripts apps/client/test packages/*/test
rg 'players.*toEqual|toEqual\(\[.*seat' packages/*/test
rg 'redis\.set' packages/room-service/test
```
- 找出对 `players` 做**精确相等**的断言并更新（已确认清单：`ws.gateway.test.ts:1857-1871`；
  `match.service.test.ts:2574/2701` 的 `redis.set` 断言）。
- **conformance C6 / C9 保持不变，不得放宽**：
  C6 用 `craftRecord` 直接构造 RPC 请求（不带 nickname）⇒ 机器人快照仍为 `NULL`，断言继续有效；
  C9③ 是三人真人房。本片不运行 conformance（需真栈）。

**定向验证**
```bash
pnpm -C packages/protocol build          # room/user 的 tsc 读 dist/*
pnpm -C packages/protocol test
pnpm -C packages/protocol lint
pnpm -C packages/room-service test
pnpm -C packages/room-service lint
pnpm -C packages/user-service test
pnpm -C packages/user-service lint
```

**全量验证**
```bash
pnpm test
pnpm lint
```
- 权威轮口径（如时间允许）：`pnpm exec turbo run test lint --force`。

**合并 / 推送（dev-process §9）**
- 确认工作区中**只有**用户原有的 `apps/client/src/net/rest.ts` / `history.vue` 未提交改动；
  不纳入本片提交。
- `git switch dev && git merge --ff-only feature/nickname`（若不能 ff，先 rebase/合并并重跑验证）。
- `git push origin dev`（dev 零 CI）。
- 不合并 master、不打 tag、不部署（本片无客户端改动；部署按用户后续指示）。

**交付报告**
- 变更内容与最终行为；
- 测试数量/结果、类型检查；
- 提交 SHA 范围；
- 是否已推送；
- 已知边界（旧记录不回填、极窄锁失败窗口、头像未多样化）。

---

## 任务状态

- [x] Task 1 protocol 契约
- [x] Task 2 bot-names 模块
- [x] Task 3 startRoom 接入
- [x] Task 4 读路径判别力测试
- [x] Task 5 user-service 记录快照
- [x] Task 6 ws.gateway 记录快照与时序
- [x] Task 7 文档同步
- [x] Task 8 全量验证 / 合并推送

---

## 计划审查记录

### 计划对抗审查（独立 reviewer，2026-10-22）

| # | 分级 | 发现 | 处置 |
|---|---|---|---|
| 高-1 | 高 | `match.service.test.ts:2574/2701` 的 `expect(redis.set).not.toHaveBeenCalled()` 会被新锁打破，计划漏列该文件 | **已修**：Task 3 Files/回归补 `match.service.test.ts`；断言收窄到 `match:rejected:` 前缀；满房无机器人用例保持原样 |
| 高-2 | 高 | `makeFakeEval(hashes)` 拿不到 `strings`，锁释放无法实现；`match.service.test.ts:226` 是第二个调用点 | **已修**：Task 2 改为 `makeFakeEval(hashes, strings)`，两个调用点同步；`_strings.clear()` 纳入 beforeEach |
| 高-3 | 高 | 锁释放/compare-and-delete 无判别力测试；token 语义未指定 | **已修**：Task 2 增加「正常释放后锁不存在」「token 不匹配不删锁」「未注册脚本仍抛错」；每次抢锁用 `randomUUID()` |
| 高-4 | 高 | protocol 未 build 时 room/user 的定向 lint 读旧 `dist` 会报错 | **已修**：Task 1 与 Task 8 增加 `pnpm -C packages/protocol build` |
| 高-5 | 高 | Task 3 两个 TDD 步骤会被占座 `hsetnx` / acquire 重试吞掉 | **已修**：昵称写入失败改为按 key 过滤的 `mockImplementation`；acquire 失败改为两次都失败（`RPC_MAX_ATTEMPTS=2`） |
| 低-1 | 低 | 锁键字面量违反 Global Constraint 5 | **已修**：新增 `botNamesLockKey()`；§10.1 键表补锁键行 |
| 低-2 | 低 | `taken` 未过滤空串哨兵 | **已修**：`Object.values(hash).filter(v => v !== '')` |
| 低-3 | 低 | 时序断言未按昵称键过滤，可能空转 | **已修**：`findIndex(key === nicknamesKey(...))` + `readIdx >= 0` 反空测 |
| 低-4 | 低 | conformance C6 不应被放宽 | **已修**：Task 8 明确 C6/C9 保持不变、本片不跑 conformance |
| 低-5 | 低 | 规范文档有未提交改动 | **已修**：spec 修订已单独提交（`35f1b93e`） |
| 低-6 | 低 | `records.query.test.ts` 的「机器人恒 NULL」用例名会过时 | **已修**：Task 5 改为「旧数据 / 无快照机器人返回 null」 |
| 低-7 | 低 | 部分 `hsetnx` 成功后抛错会漏设 TTL | **已修**：`finally` 中只要本次有成功写入就 `EXPIRE`，并加测试 |

结论：无阻断项；5 项高与 7 项低均已修入计划，可以开工。

---

## 代码审查记录

### 代码对抗审查（独立 reviewer，2026-10-22，范围 `729474f4..4450b805`）

结论：**无 Critical / Important 级生产缺陷**；2 项 Important 均为测试判别力缺口，已补测试。

| # | 分级 | 发现 | 处置 |
|---|---|---|---|
| I-1 | Important | `taken` 接线无判别力测试（改成 `[]` 现有测试仍绿） | **已修**：新增「新机器人避开 Hash 已写名字」用例；mutation 自证改成 `[]` 必红 |
| I-2 | Important | 抢锁 `SET` 抛错的 fail-open 无测试 | **已修**：新增 `redis.set.mockRejectedValue` 用例，断言 resolve 且不读/写 Hash |
| M-1 | Minor | 释放锁 `eval` 抛错无测试 | **已修**：新增 resolve 断言（名字已写，TTL 兜底） |
| M-2 | Minor | `fnv1a32` 无已知答案值 | **已修**：补 FNV-1a 32 标准向量（`''` / `'a'`） |
| M-3 | Minor | `message.router.test.ts` 写死昵称键字面量 | **已修**：改用 `nicknamesKey('ROOM1')` |
| M-4 | Minor | fake eval 释放锁忽略 TTL 过期 | **登记**：对现有断言等价；真 Redis 由 `EX 3` 保证，替身只服务测试 |
| M-5 | Minor | conformance C6 标签「机器人昵称恒 NULL」过时 | **已修**：改为「造数不带 nickname ⇒ 快照 NULL」；检查本身未放宽 |
| M-6 | Minor | 昵称 `hgetall` 同步抛错可能产生未处理 rejection | **已修**：同步调用外包 try/catch，仍保持命令先于 `updateStatus` 发出 |
| M-7 | Minor | `localeCompare` 次级排序依赖 locale | **已修**：改为 locale 无关的字符串比较（座位唯一，分支实际不可达） |

补测后已重跑：room-service 全量 773、user-service 315、protocol 217、三包 lint 全绿。
