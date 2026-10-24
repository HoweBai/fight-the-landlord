import { vi } from 'vitest';
import { CANCEL_IF_WAITING_LUA } from '../../src/rooms/rooms.service';
import { BOT_NAMES_RELEASE_LOCK_LUA } from '../../src/rooms/bot-names';
import type { Redis } from 'ioredis';

/**
 * **假 `EVAL` 的唯一实现**（spec §2 / R1002）—— 供本文件的 `createFakeRedis()` 与
 * `match.service.test.ts` 里那个**状态化替身**共用。
 *
 * ⚠️ 为什么抽出来：本仓的替身不止一个（`match.service.test.ts` 有自己的 `makeMockRedis`）。
 * 若 `eval` 各写一份，就会出现「同一个脚本、两套语义」——**第二真源**。
 * 而这里的语义一旦漂移，`cancelIfStillWaiting` 的那组判据（正/负对照）会一起变成空测。
 *
 * ⚠️ 三条纪律（写在这里因为它们正是「替身的宽容度 = 对缺陷的容忍度」的落点）：
 *
 *  1. **只认这一段脚本**（比对字面量）；别的脚本**抛错**，绝不返回一个「看起来成功」的假结果
 *     —— 本仓为「替身太宽容」付过多次代价（`hgetall` 恒返回 `{}`、缺 `hsetnx` 被 catch 吞掉…）。
 *  2. **真按脚本语义执行**（读 `status`、条件写两格），**不是**返回一个预设值 ——
 *     否则 `cancelIfStillWaiting` 的正/负对照会一起变成空测。
 *  3. 新增脚本请**同步扩展**这里（并给它自己的纪律）。
 *
 * ⚠️ **它证不了原子性**：假 Redis 里没有「交错」这个可能。原子性落在真 Redis
 *（conformance，见 spec §6.1）。
 */
export function makeFakeEval(
  hashes: Map<string, Record<string, string>>,
  strings?: Map<string, string>,
) {
  return vi.fn(async (script: string, _numKeys: number, key: string, ...args: unknown[]) => {
    if (script === CANCEL_IF_WAITING_LUA) {
      // 语义与脚本逐字对应：status 是 'waiting' 才写两格
      const hash = hashes.get(key);
      if (!hash || hash.status !== 'waiting') return 0;
      hash.status = 'cancelled';
      hash.timeoutAt = '0';
      return 1;
    }
    if (script === BOT_NAMES_RELEASE_LOCK_LUA) {
      // 2026-10-22 机器人昵称片：释放短锁 —— `GET` 等于 token 才 `DEL`。
      // 过期键仍留在 strings 里无妨：若已过期并被新持有者 `SET NX` 覆盖，
      // 值已是新 token ⇒ 不匹配、不会误删。
      if (!strings) return 0;
      const token = String(args[0] ?? '');
      if (strings.get(key) !== token) return 0;
      strings.delete(key);
      return 1;
    }
    throw new Error(
      'FakeRedis.eval 只实现了 CANCEL_IF_WAITING_LUA / BOT_NAMES_RELEASE_LOCK_LUA 两段脚本 —— 新增脚本请同步扩展本替身（别让它静默返回假结果）',
    );
  });
}

/**
 * 内存版 Redis，只实现断线重连路径（§6.6 / §10.1）真正用到的方法。
 *
 * 与「一把 `vi.fn()` 返回固定值」的 mock 不同，它**带真实的 TTL 语义**：
 *  - `set(key, value, 'EX', n)` 记下 n，`ttl(key)` 返回它（无 TTL → `-1`，键不存在 → `-2`）；
 *  - 重连记录（`reconnect:active` 哈希）**不设 TTL** —— 旧的「独立键到期消失、
 *    哈希字段仍在」可判定过期信号模型已随重连窗口退役（规格 v1.1 §2.7），模拟方法随之删除。
 *
 * 哈希为空时自动删键，与 Redis 的真实行为一致（`hget` → null）。
 */
export function createFakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const ttls = new Map<string, number>();
  const zsets = new Map<string, Map<string, number>>();
  /** 本片 T6：**绝对到期时刻**（epoch ms；与 `ttls` 并存——后者是「记下的秒数」读面）。 */
  const expiresAt = new Map<string, number>();
  /** 本片 T6：**可注入时钟**（`advanceMs` 推进；仅测试 —— 让「TTL 过期 ⇒ 放行」可判）。 */
  const clock = { now: Date.now() };
  /** 未过期的存在性（真 Redis：过期键一律按不存在读）。 */
  const existsNow = (key: string): boolean => {
    const live = strings.has(key) || hashes.has(key) || zsets.has(key);
    if (!live) return false;
    const at = expiresAt.get(key);
    return at === undefined || at > clock.now;
  };

  const api = {
    hashes,
    strings,
    ttls,
    zsets,
    /**
     * `HSET key field value` **或** `HSET key { f1: v1, f2: v2 }`（两种形态真实 Redis 都支持）。
     *
     * ⚠️ 返回值是**新增**字段数（真实语义），不是「调用成功」：
     * 覆盖已有字段时返回 0。N9 之后元数据一律走 `hset(key, {...})`。
     */
    hset: vi.fn(async (key: string, fieldOrObject: string | Record<string, string>, value?: string) => {
      const hash = hashes.get(key) ?? {};
      if (typeof fieldOrObject === 'object') {
        let added = 0;
        for (const [field, fieldValue] of Object.entries(fieldOrObject)) {
          if (!(field in hash)) added += 1;
          hash[field] = fieldValue;
        }
        hashes.set(key, hash);
        return added;
      }
      const added = fieldOrObject in hash ? 0 : 1;
      hash[fieldOrObject] = String(value);
      hashes.set(key, hash);
      return added;
    }),
    /** §10.2 的原子占座就是它：字段已存在 ⇒ 0（**不覆盖**）。 */
    hsetnx: vi.fn(async (key: string, field: string, value: string) => {
      const hash = hashes.get(key) ?? {};
      if (field in hash) return 0;
      hash[field] = value;
      hashes.set(key, hash);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const hash = hashes.get(key);
      if (!hash) return 0;
      let removed = 0;
      for (const field of fields) {
        if (field in hash) {
          delete hash[field];
          removed += 1;
        }
      }
      if (Object.keys(hash).length === 0) hashes.delete(key);
      return removed;
    }),
    /**
     * 真实 Redis 的 `DEL` **不看类型**：String / Hash / ZSet 都删，且每个**真实存在**的键各计 1。
     *
     * ⚠️ 旧实现只碰 `strings` —— 于是任何 `del(hashKey)` 的断言都是**静默假绿**
     * （本项目最贵的一类缺陷：假 Redis 比真 Redis 更宽容）。
     * 每个键只会命中一个分支（`else if`）：同一个键不可能同时是 String 和 Hash。
     */
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (strings.delete(key)) removed += 1;
        else if (hashes.delete(key)) removed += 1;
        else if (zsets.delete(key)) removed += 1;
        ttls.delete(key);
        expiresAt.delete(key);
      }
      return removed;
    }),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      // 本片 T6：只认实现侧的三种形态 `(无)` / `('EX', n)` / `('EX', n, 'NX')`；漂移 ⇒ 当场抛（同 scan 纪律）。
      let ex: number | undefined;
      let nx = false;
      if (args.length === 0) {
        // 无选项（真语义：清 TTL）
      } else if (args[0] === 'EX' && typeof args[1] === 'number' && args.length === 2) {
        ex = args[1];
      } else if (args[0] === 'EX' && typeof args[1] === 'number' && args[2] === 'NX' && args.length === 3) {
        ex = args[1];
        nx = true;
      } else {
        throw new Error(`FakeRedis 未识别的 set 选项形态：${args.map(String).join(' ')}`);
      }
      if (nx && existsNow(key)) return null; // NX 命中**未过期**的已存在键 ⇒ 不写（真 Redis 语义）
      strings.set(key, value);
      if (ex !== undefined) {
        ttls.set(key, ex);
        expiresAt.set(key, clock.now + ex * 1000);
      } else {
        ttls.delete(key);
        expiresAt.delete(key);
      }
      return 'OK' as const;
    }),
    get: vi.fn(async (key: string) => (existsNow(key) ? (strings.get(key) ?? null) : null)),
    /**
     * 多玩法 Task 2.4：`room:{code}:start_attempts` 用 `INCR`（重试预算）。
     * 真语义：过期键按不存在起算；未过期键保留原 TTL（调用方随后 `EXPIRE` 续期）。
     */
    incr: vi.fn(async (key: string) => {
      const live = existsNow(key);
      const next = (live ? Number(strings.get(key) ?? '0') : 0) + 1;
      strings.set(key, String(next));
      if (!live) {
        ttls.delete(key);
        expiresAt.delete(key);
      }
      return next;
    }),
    /**
     * 真实 `EXISTS` 同样**不看类型**。
     *
     * ⚠️ 旧实现只认 `strings` / `hashes` ⇒ 用 `exists` 断言「匹配队列 ZSet 还在不在」
     * 会得到与 `del` 同一类**静默假绿**（`expect(await redis.exists(queueKey)).toBe(0)`
     * 在 ZSet 其实还在时也通过）。
     */
    exists: vi.fn(async (...keys: string[]) => keys.filter((key) => existsNow(key)).length),
    /** 真实 `TTL`：键不存在（或已过期）⇒ `-2`（**任何类型**都算存在）；存在但无 TTL ⇒ `-1`。 */
    ttl: vi.fn(async (key: string) => {
      if (!strings.has(key) && !hashes.has(key) && !zsets.has(key)) return -2;
      const at = expiresAt.get(key);
      if (at !== undefined && at <= clock.now) return -2; // 已过期 ⇒ 按不存在（真 Redis 语义）
      if (at === undefined) return -1;
      return Math.max(0, Math.ceil((at - clock.now) / 1000));
    }),
    /**
     * 偏差 C12 的回归断言点：**绝不**对不存在的键「生效」。
     * 语义与真实 Redis 一致：键不存在 ⇒ 0；存在 ⇒ 记下 TTL 并回 1
     * （`reconnect.service.test.ts:52` 的 `expect(redis.expire).not.toHaveBeenCalled()` 不受影响）。
     */
    expire: vi.fn(async (key: string, seconds: number) => {
      if (!existsNow(key)) return 0;
      ttls.set(key, seconds);
      expiresAt.set(key, clock.now + seconds * 1000);
      return 1;
    }),
    /**
     * `PING`（§2.4 / R267 的健康检查依赖探测）。
     *
     * 真实语义：连通 ⇒ `'PONG'`；连接不可用 ⇒ **reject**。用例用
     * `redis.ping.mockRejectedValueOnce(...)` 构造 `degraded` 分支。
     */
    ping: vi.fn(async (): Promise<string> => 'PONG'),
    /** `on('error', …)` —— `createRedis()` 在**构造期**就注册它（缺失会让 provider 当场炸）。 */
    on: vi.fn(),
    /** 游标式 `SCAN cursor MATCH pattern COUNT n`（§7.3 偏差 A8：遍历**不得**用 `KEYS`）。
     *
     * 参数故意松类型（`unknown[]`）：假 Redis 的签名**不参与** `Redis` 的结构校验
     * （`asRedis()` 是断言转换），所以用例可以直接
     * `redis.scan.mockResolvedValue(['0', ['room:AAA111']])`，不需要元组断言。
     *
     * ⚠️ **P15/N31 之前这里恒返回 `[]`**（一个桩）⇒ 任何**真的**去扫键的产品代码
     * （如 `RoomsReaperTask` 经 `RoomsService.findAll()`）在单测里都**看不到任何房间**，
     * 于是「回收没生效」会以「夹具没数据」的形态出现。现已按真实语义实现
     * （按 `MATCH` glob 过滤三类存储里**存在**的键）。
     * ⚠️ 光标语义：本替身**一轮返回全部**（`'0'`）—— 那是真实 Redis 的合法情形之一
     * （键少时就是一轮扫完），调用方必须能处理；「必须多轮」的形态由
     * `rooms.service.test.ts` 的 `mockResolvedValue` 用例单独覆盖。
     * ⚠️ `COUNT` 只是提示，**不参与**过滤（真实语义如此）。
     */
    scan: vi.fn(async (_cursor: string, ...args: unknown[]): Promise<[string, string[]]> => {
      const upper = args.map((a) => String(a).toUpperCase());
      const matchAt = upper.indexOf('MATCH');
      const pattern = matchAt >= 0 ? String(args[matchAt + 1]) : '*';
      // 先转义正则元字符（**不**转义 `*`/`?`），再把 glob 通配符翻译成正则
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      const all = new Set<string>([...strings.keys(), ...hashes.keys(), ...zsets.keys()]);
      return ['0', [...all].filter((key) => regex.test(key))];
    }),
    /** 生产环境禁止 KEYS：任何回退到 KEYS 的实现都会当场失败。 */
    keys: vi.fn(async (): Promise<never> => {
      throw new Error('KEYS 在生产环境被禁止（§7.3 偏差 A8）');
    }),

    // ─── 限流用的 ZSet 子集（§5.4）──────────────────────────────────
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const zset = zsets.get(key) ?? new Map<string, number>();
      zset.set(member, score);
      zsets.set(key, zset);
      return 1;
    }),
    zrem: vi.fn(async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0)),
    zscore: vi.fn(async (key: string, member: string) => {
      const score = zsets.get(key)?.get(member);
      return score === undefined ? null : String(score);
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const [member, score] of [...zset]) {
        if (score >= min && score <= max) {
          zset.delete(member);
          removed += 1;
        }
      }
      return removed;
    }),

    /**
     * `publish`：Redis 的**频道**发布。本片新增的消费者是 `RoomStartService.announce`
     * —— 「开局了」要经 `match:events` 频道推给 `WsGateway` ⇒ 客户端才收到 `room.matched`。
     * 这里只**记下来**供断言，不做投递（投递那一跳由 `ws.gateway` 自己的测试覆盖）。
     */
    publish: vi.fn(async (_channel: string, _message: string) => 0),

    /**
     * `EVAL`：实现见 `makeFakeEval`（**唯一**一份 —— 另一个状态化替身也用它）。
     */
    eval: makeFakeEval(hashes, strings),

    /** 本片 T6：**推进可注入时钟**（仅测试；`advanceMs(31_000)` = claim TTL 过期）。 */
    advanceMs: (ms: number): void => {
      clock.now += ms;
    },
  };

  return api;
}

export type FakeRedis = ReturnType<typeof createFakeRedis>;

/** 交给 `ReconnectService` / `WsGateway` 使用（仅测试）。 */
export function asRedis(fake: FakeRedis): Redis {
  return fake as unknown as Redis;
}
