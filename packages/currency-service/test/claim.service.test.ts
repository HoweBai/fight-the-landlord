/**
 * 广告片 T12：**claim 双键服务**（规格 §2.6 逐字）—— claim 族判据 + FakeRedis 扩展语义自证。
 *
 * ─── 判据来源（§5.1 P3 claim 族）──────────────────────────────────────────
 *  复用同 nonce·续期（TTL 回 900）· 连发键数不增 · 悬垂恢复（删记录留索引 ⇒ 新签且索引
 *  更新；记录非 issued 同）· **条件删**（交错下不误删并发胜者的新索引——两个窗口各一例）·
 *  竞败补偿（自家记录被 DEL）· done 后新签 · 读取故障 ⇒ `'read-failure'`（**与 `null` 不
 *  混同**）· `markDone` 条件写（仅 issued⇒done、EX 172800、DEL 索引、竞败不覆盖）。
 *
 * ─── 测试形态（硬约束）────────────────────────────────────────────────────
 *  **单测不得依赖真 Redis**（CI Stage 4 无 redis、仓内零 testcontainers；`ci.sh:96`）——
 *  形态 = 扩展既有假库（`helpers/fake-currency-db.ts` 的 FakeRedis，本任务 T12 首创
 *  watch/multi/exec 语义；**注释与单测互指**：假库 T12 段 ↔ 本文件「① FakeRedis 扩展语义」组）。
 *  真 Redis 面由 slice-24 ③⑩ 在栈内覆盖。
 *
 * ─── 并发交错构造（「两客户端 + 手动插入对手操作」）───────────────────────
 *  `redis.secondClient()` = 同库第二客户端（共享键值/版本，独立 WATCH 快照）；
 *  `redis.injectBefore(op, fn, { key, repeat })` = 在**下一次**（或每次）op 进入时先调用
 *  对手操作。两个交错窗口各钉一层保护：
 *    · 交错一：对手写在 **WATCH 取快照前**（观察之后）⇒ 只有 `GET 值比对` 层能拦
 *      （此窗口下 EXEC 失效层救不了——快照在对手写之后）；
 *    · 交错二（简报指名窗口）：对手写在 **WATCH 与 EXEC 之间** ⇒ 只有 `EXEC 失效`层能拦
 *      （值比对已通过——GET 时索引还没被改）。
 *  **判别力自证**：把实现的 `conditionalDelIdx` 换成**非条件 DEL** ⇒ 两个交错用例必红
 *  （防「测试恒绿」；实跑输出见 task-12-report.md）。
 *
 * ─── 日期口径 ────────────────────────────────────────────────────────────
 *  `todayShanghai()` 与 `reliefActionId` 同源（`util/shanghai-date.ts` 唯一实现点）——
 *  跨 UTC 日界样本直取口径函数断言（e2e 不得照搬：现行种子金额 ≥ 门槛，回调后余额闸先接走）。
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { AppModule } from '../src/app.module';
import {
  ClaimService,
  ClaimTransientError,
  RELIEF_CLAIM_DONE_TTL_SECONDS,
  RELIEF_CLAIM_TTL_SECONDS,
} from '../src/ads/claim.service';
import { reliefActionId } from '../src/wallet/wallet.controller';
import { FakeRedis } from './helpers/fake-currency-db';

/* ------------------------------------------------------------------ *
 * 键形/记录帮助（规格 §2.6 逐字；**测试侧独立副本** —— 不 import 实现，防两边一起改）
 * ------------------------------------------------------------------ */

const REC = (nonce: string): string => `relief:claim:${nonce}`;
const IDX = (userId: string): string => `relief:claim:u:${userId}`;

/** 服务端「今天」（Asia/Shanghai）—— 测试侧独立副本（照 `relief.test.ts:56-63` 先例）。 */
const shanghaiToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** 记录 JSON（§2.6 值形逐字；over 覆写按需）。 */
const recordJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ userId: 'u-1', date: '2026-10-01', state: 'issued', ...over });

/* ==================================================================== *
 * ① FakeRedis 扩展语义（T12 首创；互指 `helpers/fake-currency-db.ts` 的 T12 段）
 * ==================================================================== */

describe('① FakeRedis 扩展语义（watch/multi/exec/NX/EX/expire；T12 首创）', () => {
  it("set：无选项 ⇒ 'OK'（清 TTL）；'EX' ⇒ 记 TTL；'EX'+'NX' 已存在 ⇒ null 且不覆盖；缺键 ⇒ 'OK'；未识别形态 ⇒ 当场抛（形态漂移现形）", async () => {
    const r = new FakeRedis();
    expect(await r.set('k', 'v1')).toBe('OK');
    expect(r.store.get('k')).toBe('v1');
    expect(r.ttls.has('k')).toBe(false); // 无 EX 的 SET ⇒ 清 TTL（真语义）

    expect(await r.set('k', 'v2', 'EX', 60)).toBe('OK');
    expect(r.ttls.get('k')).toBe(60);

    expect(await r.set('k', 'v3', 'EX', 60, 'NX')).toBeNull(); // NX 命中已存在 ⇒ null
    expect(r.store.get('k')).toBe('v2'); // 未覆盖

    expect(await r.set('fresh', 'v4', 'EX', 900, 'NX')).toBe('OK');
    expect(r.store.get('fresh')).toBe('v4');
    expect(r.ttls.get('fresh')).toBe(900);

    await expect(r.set('k', 'v5', 'PX', 10)).rejects.toThrow(/未识别/);
  });

  it('expire：键在 ⇒ 1（TTL 记入）；键不在 ⇒ 0（真语义）', async () => {
    const r = new FakeRedis();
    await r.set('k', 'v');
    expect(await r.expire('k', 900)).toBe(1);
    expect(r.ttls.get('k')).toBe(900);
    expect(await r.expire('missing', 900)).toBe(0);
    expect(r.ttls.has('missing')).toBe(false);
  });

  it('watch → multi → exec：未变 ⇒ 依序执行、返各命令结果的数组（ioredis 形态 [[null, r], …]）；EXEC 后 WATCH 清空', async () => {
    const r = new FakeRedis();
    await r.set('a', '1');
    await r.watch('a');

    const results = await r.multi().set('b', '2').del('a').exec();
    expect(results).toEqual([
      [null, 'OK'],
      [null, 1],
    ]);
    expect(r.store.get('b')).toBe('2');
    expect(r.store.has('a')).toBe(false);

    await r.set('c', '3'); // EXEC 后 watch 已清空 ⇒ 无 watch 的 multi 照常执行
    expect(await r.multi().del('c').exec()).toEqual([[null, 1]]);
  });

  it('WATCH 键在 EXEC 前被改（对手 secondClient 写）⇒ EXEC 返 null 且**队列一条都不执行**（事务弃）', async () => {
    const r = new FakeRedis();
    const other = r.secondClient();
    await r.set('a', '1');
    await r.set('b', '1');

    await r.watch('a');
    await other.set('a', '2'); // 对手写（真 Redis：他方改被 WATCH 的键）

    expect(await r.multi().del('b').exec()).toBeNull();
    expect(r.store.has('b')).toBe(true); // DEL 未执行（事务弃 = 队列不跑）
    expect(r.store.get('a')).toBe('2'); // 对手写保留
  });

  it('判定按「被改过」而非「值不同」：A→B→A 的中间写同样弃事务（真 Redis 语义）', async () => {
    const r = new FakeRedis();
    const other = r.secondClient();
    await r.set('a', '1');
    await r.watch('a');
    await other.set('a', '2');
    await other.set('a', '1'); // 值回到原样
    expect(await r.multi().del('a').exec()).toBeNull();
    expect(r.store.has('a')).toBe(true);
  });

  it('unwatch：解除保护（此后他方写不影响 EXEC——条件删的「否则 UNWATCH」分支依赖它）', async () => {
    const r = new FakeRedis();
    const other = r.secondClient();
    await r.set('a', '1');
    await r.watch('a');
    await other.set('a', '2');
    expect(await r.unwatch()).toBe('OK');
    expect(await r.multi().del('a').exec()).toEqual([[null, 1]]);
  });
});

/* ==================================================================== *
 * ② 常量（⚙️C 逐字）
 * ==================================================================== */

describe('② 常量（⚙️C；不设配置键）', () => {
  it('RELIEF_CLAIM_TTL_SECONDS = 900 · RELIEF_CLAIM_DONE_TTL_SECONDS = 172800', () => {
    expect(RELIEF_CLAIM_TTL_SECONDS).toBe(900);
    expect(RELIEF_CLAIM_DONE_TTL_SECONDS).toBe(172800);
  });
});

/* ==================================================================== *
 * ③ findOrCreate（§2.6「找到或创建」）
 * ==================================================================== */

describe('③ findOrCreate（复用·续期·悬垂·条件删·竞败补偿）', () => {
  let redis: FakeRedis;
  let svc: ClaimService;

  beforeEach(() => {
    redis = new FakeRedis();
    svc = new ClaimService(redis as unknown as Redis);
  });

  it('首签：nonce 22 位 base64url（⚙️B）· date=今天(Asia/Shanghai) · 双键恰两键（键形逐字）、TTL 各 900（⚙️C）', async () => {
    const res = await svc.findOrCreate('u-1');
    expect(res.reused).toBe(false);
    expect(res.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.date).toBe(shanghaiToday());

    expect([...redis.store.keys()].sort()).toEqual([`relief:claim:u:u-1`, `relief:claim:${res.nonce}`].sort());
    expect(JSON.parse(redis.store.get(REC(res.nonce)) ?? 'null')).toEqual({
      userId: 'u-1',
      date: res.date,
      state: 'issued',
    });
    expect(redis.store.get(IDX('u-1'))).toBe(res.nonce);
    expect(redis.ttls.get(REC(res.nonce))).toBe(RELIEF_CLAIM_TTL_SECONDS);
    expect(redis.ttls.get(IDX('u-1'))).toBe(RELIEF_CLAIM_TTL_SECONDS);
  });

  it('复用同 nonce + 续期：两键 EXPIRE 同置回 900（窗起点=确认步骤；§2.6「EXPIRE 两键 = TTL」）', async () => {
    const first = await svc.findOrCreate('u-1');
    // 模拟窗内流逝（假库不做时间流逝——直接压 TTL 表）
    redis.ttls.set(REC(first.nonce), 100);
    redis.ttls.set(IDX('u-1'), 100);

    const second = await svc.findOrCreate('u-1');
    expect(second).toEqual({ nonce: first.nonce, date: first.date, reused: true });
    expect(redis.ttls.get(REC(first.nonce))).toBe(RELIEF_CLAIM_TTL_SECONDS);
    expect(redis.ttls.get(IDX('u-1'))).toBe(RELIEF_CLAIM_TTL_SECONDS);
  });

  it('连发 GET 键数不增（键数 O(用户数)）：连发 5 次恒同 nonce、恒 2 键', async () => {
    const first = await svc.findOrCreate('u-1');
    for (let i = 0; i < 4; i++) {
      const again = await svc.findOrCreate('u-1');
      expect(again.nonce).toBe(first.nonce);
      expect(again.reused).toBe(true);
    }
    expect(redis.store.size).toBe(2);
  });

  it('悬垂恢复①：索引在、记录不在（已过期）⇒ 新签且索引更新；悬垂索引被条件删、零孤儿', async () => {
    redis.store.set(IDX('u-1'), 'ghost-nonce-0000000000'); // 只留索引（记录从未写入/已过期）

    const res = await svc.findOrCreate('u-1');
    expect(res.reused).toBe(false);
    expect(res.nonce).not.toBe('ghost-nonce-0000000000');
    expect(redis.store.get(IDX('u-1'))).toBe(res.nonce);
    expect(redis.store.has(REC('ghost-nonce-0000000000'))).toBe(false);
    expect([...redis.store.keys()].sort()).toEqual([IDX('u-1'), REC(res.nonce)].sort());
  });

  it('悬垂恢复②：索引在、记录非 issued（done）⇒ 同样新签；旧 done 记录保留（48h 重投短路面不动）', async () => {
    redis.store.set(IDX('u-1'), 'stale-nonce-0000000000');
    redis.store.set(REC('stale-nonce-0000000000'), recordJson({ state: 'done', result: 'granted' }));

    const res = await svc.findOrCreate('u-1');
    expect(res.reused).toBe(false);
    expect(redis.store.get(IDX('u-1'))).toBe(res.nonce);
    expect(JSON.parse(redis.store.get(REC('stale-nonce-0000000000')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'granted',
    });
  });

  it('条件删·交错一（比较层）：对手在 WATCH 取快照**前**（观察之后）改写索引 ⇒ 值不符 ⇒ 不删、按胜者复用', async () => {
    const opponent = redis.secondClient();
    const win = 'winner-nonce-000000000';
    redis.store.set(IDX('u-1'), 'ghost-nonce-0000000000'); // 悬垂（记录不在）
    // 注入窗口：下一次 watch 进入时、取快照前——只有「GET 值比对」层能拦（EXEC 失效层救不了）。
    // 对手与真竞窗同形：条件删掉陈旧索引、再落自己的新索引（del + SET NX，先删后写）。
    redis.injectBefore(
      'watch',
      async () => {
        await opponent.del(IDX('u-1'));
        await opponent.set(REC(win), recordJson({ date: '2026-10-01' }), 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
        await opponent.set(IDX('u-1'), win, 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
      },
      { key: IDX('u-1') },
    );

    const res = await svc.findOrCreate('u-1');
    expect(res).toEqual({ nonce: win, date: '2026-10-01', reused: true }); // 胜者索引未被误删
    expect(redis.store.get(IDX('u-1'))).toBe(win);
    expect([...redis.store.keys()].sort()).toEqual([IDX('u-1'), REC(win)].sort()); // 自家瞬时记录已补偿
  });

  it('条件删·交错二（失效层·简报指名窗口）：对手在 WATCH 与 EXEC 之间改写 ⇒ EXEC 弃事务、队列不执行、不误删新索引', async () => {
    const opponent = redis.secondClient();
    const win = 'winner-nonce-000000000';
    redis.store.set(IDX('u-1'), 'ghost-nonce-0000000000'); // 悬垂（记录不在）
    // 注入窗口：下一次 exec 进入时、校验前——值比对已通过（GET 时索引还没被改），只有 EXEC 失效层能拦
    redis.injectBefore('exec', async () => {
      // 对手（第二客户端）与真竞窗同形：先删掉陈旧索引、再落自己的新索引
      await opponent.del(IDX('u-1'));
      await opponent.set(REC(win), recordJson({ date: '2026-10-01' }), 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
      await opponent.set(IDX('u-1'), win, 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
    });

    const res = await svc.findOrCreate('u-1');
    expect(res).toEqual({ nonce: win, date: '2026-10-01', reused: true });
    expect(redis.store.get(IDX('u-1'))).toBe(win);
    expect([...redis.store.keys()].sort()).toEqual([IDX('u-1'), REC(win)].sort());
    // 形态钉：条件删走了 WATCH → … → EXEC（非裸 DEL——判别力由对照组实跑自证）
    expect(redis.calls.some((c) => c.op === 'watch' && c.key === IDX('u-1'))).toBe(true);
    expect(redis.calls.some((c) => c.op === 'exec')).toBe(true);
  });

  it('竞败补偿：索引 NX 败 ⇒ 自家记录被 DEL（不留无人引用的记录），按胜者复用返回', async () => {
    const opponent = redis.secondClient();
    const win = 'winner-nonce-000000000';
    // 观察时索引缺失（对手在「自家记录 SET」瞬间才落子——竞窗后才可见）
    redis.injectBefore('set', async () => {
      await opponent.set(REC(win), recordJson({ date: '2026-10-01' }), 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
      await opponent.set(IDX('u-1'), win, 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
    });

    const res = await svc.findOrCreate('u-1');
    expect(res).toEqual({ nonce: win, date: '2026-10-01', reused: true });
    expect(redis.store.get(IDX('u-1'))).toBe(win);
    expect([...redis.store.keys()].sort()).toEqual([IDX('u-1'), REC(win)].sort()); // 自家记录已补偿删除
  });

  it('重试耗尽（两轮皆败）⇒ ClaimTransientError（上层 503 / 回调 5xx 统一出口）；两轮自家记录全补偿、零残留', async () => {
    const opponent = redis.secondClient();
    redis.injectBefore(
      'set',
      async () => {
        // 每次自家记录 SET 前，对手写回一个**悬垂**索引（记录不存在 ⇒ 下一轮同样败）
        await opponent.set(IDX('u-1'), 'ghost-nonce-0000000000', 'EX', RELIEF_CLAIM_TTL_SECONDS, 'NX');
      },
      { repeat: true },
    );

    await expect(svc.findOrCreate('u-1')).rejects.toThrow(ClaimTransientError);
    // 零残留：两轮自家记录全被补偿删除、悬垂索引被条件删（耗尽路径不留下任何键）
    expect(redis.store.size).toBe(0);
  });

  it('Redis 连接故障 ⇒ ClaimTransientError（统一出口，非裸抛）', async () => {
    redis.failKeys.add(IDX('u-1'));
    await expect(svc.findOrCreate('u-1')).rejects.toThrow(ClaimTransientError);
  });
});

/* ==================================================================== *
 * ④ read（读取故障分类：'read-failure' 与 null 不得混同）
 * ==================================================================== */

describe('④ read（读取故障分类；⚙️ r3 🟡-6）', () => {
  let redis: FakeRedis;
  let svc: ClaimService;

  beforeEach(() => {
    redis = new FakeRedis();
    svc = new ClaimService(redis as unknown as Redis);
  });

  it('issued 记录 ⇒ {userId, date, state}（无 result 字段）', async () => {
    const { nonce } = await svc.findOrCreate('u-1');
    expect(await svc.read(nonce)).toEqual({ userId: 'u-1', date: shanghaiToday(), state: 'issued' });
  });

  it('done 记录 ⇒ state done + result（轮询读终态的载体）', async () => {
    redis.store.set(REC('done-nonce-00000000000'), recordJson({ state: 'done', result: 'replayed' }));
    expect(await svc.read('done-nonce-00000000000')).toEqual({
      userId: 'u-1',
      date: '2026-10-01',
      state: 'done',
      result: 'replayed',
    });
  });

  it("不存在 ⇒ null；读取故障 ⇒ 'read-failure' —— **不得混同**（同一用例双侧断言）", async () => {
    expect(await svc.read('never-existed-nonce00')).toBeNull();

    redis.store.set(REC('n1'), recordJson());
    redis.failKeys.add(REC('n1'));
    const failure = await svc.read('n1');
    expect(failure).toBe('read-failure'); // 瞬态：上层 5xx 可重投（不归 claim_invalid）
    expect(failure).not.toBeNull(); // 与「不存在」分类互斥
  });

  it('畸形记录（非 JSON / 形状不符 / result 不在值域）⇒ null（按「无凭证」——与 resolveClaim 的「畸形 ⇒ invalid」归类一致）', async () => {
    redis.store.set(REC('bad-json'), 'not-json{');
    redis.store.set(REC('bad-shape'), JSON.stringify({ userId: 'u-1' }));
    redis.store.set(REC('bad-result'), recordJson({ state: 'done', result: 'weird' }));
    expect(await svc.read('bad-json')).toBeNull();
    expect(await svc.read('bad-shape')).toBeNull();
    expect(await svc.read('bad-result')).toBeNull();
  });
});

/* ==================================================================== *
 * ⑤ markDone（条件写：仅 issued⇒done，EX 172800，DEL 索引）
 * ==================================================================== */

describe('⑤ markDone（条件写 done；§2.6 末条）', () => {
  let redis: FakeRedis;
  let svc: ClaimService;

  beforeEach(() => {
    redis = new FakeRedis();
    svc = new ClaimService(redis as unknown as Redis);
  });

  it('issued ⇒ done：记录 {userId, date, state:done, result} · TTL 换 172800（⚙️C）· 索引被删（done 落定删索引——⚙️E）', async () => {
    const { nonce } = await svc.findOrCreate('u-1');
    await svc.markDone(nonce, 'granted');

    expect(JSON.parse(redis.store.get(REC(nonce)) ?? 'null')).toEqual({
      userId: 'u-1',
      date: shanghaiToday(),
      state: 'done',
      result: 'granted',
    });
    expect(redis.ttls.get(REC(nonce))).toBe(RELIEF_CLAIM_DONE_TTL_SECONDS);
    expect(redis.store.has(IDX('u-1'))).toBe(false); // 索引删除（无自致悬垂）
  });

  it('done 后新签：findOrCreate 不复用 done 记录（新 nonce、索引更新、旧 48h 记录保留）', async () => {
    const first = await svc.findOrCreate('u-1');
    await svc.markDone(first.nonce, 'granted');

    const second = await svc.findOrCreate('u-1');
    expect(second.reused).toBe(false);
    expect(second.nonce).not.toBe(first.nonce);
    expect(redis.store.get(IDX('u-1'))).toBe(second.nonce);
    expect(JSON.parse(redis.store.get(REC(first.nonce)) ?? 'null')).toMatchObject({ state: 'done', result: 'granted' });
  });

  it('幂等：done ⇒ 再 markDone 不覆盖（仅 issued⇒done——重复投递/竞败后到达者不夺胜者 result）', async () => {
    const { nonce } = await svc.findOrCreate('u-1');
    await svc.markDone(nonce, 'granted');
    await svc.markDone(nonce, 'replayed'); // 晚到者
    expect(JSON.parse(redis.store.get(REC(nonce)) ?? 'null')).toMatchObject({ result: 'granted' });
  });

  it('并发竞败（EXEC 前记录已被对手改）⇒ 事务弃：不覆盖胜者 result、索引 DEL 也未执行（队列不跑）', async () => {
    const opponent = redis.secondClient();
    const { nonce } = await svc.findOrCreate('u-1');

    redis.injectBefore('exec', async () => {
      // 对手（另一并发回调）在 EXEC 前抢先落 done:replayed
      await opponent.set(
        REC(nonce),
        recordJson({ date: shanghaiToday(), state: 'done', result: 'replayed' }),
        'EX',
        RELIEF_CLAIM_DONE_TTL_SECONDS,
      );
    });

    await svc.markDone(nonce, 'granted');
    expect(JSON.parse(redis.store.get(REC(nonce)) ?? 'null')).toMatchObject({ result: 'replayed' }); // 胜者优先
    expect(redis.store.has(IDX('u-1'))).toBe(true); // 本方事务整体弃 ⇒ DEL 索引未执行（claim_invalid 不建键面同侧）
  });

  it('记录不存在 ⇒ no-op（不建键、不抛——claim_invalid 不建键）', async () => {
    await svc.markDone('ghost-nonce-0000000000', 'granted');
    expect(redis.store.size).toBe(0);
  });

  it('Redis 连接故障 ⇒ ClaimTransientError（统一出口）', async () => {
    const { nonce } = await svc.findOrCreate('u-1');
    redis.failKeys.add(REC(nonce));
    await expect(svc.markDone(nonce, 'granted')).rejects.toThrow(ClaimTransientError);
  });
});

/* ==================================================================== *
 * ⑥ 日期口径（两处同源）与注册面
 * ==================================================================== */

describe('⑥ 日期口径（两处同源）与注册面', () => {
  let redis: FakeRedis;
  let svc: ClaimService;

  beforeEach(() => {
    redis = new FakeRedis();
    svc = new ClaimService(redis as unknown as Redis);
  });
  afterEach(() => {
    vi.useRealTimers(); // 跨日用例的 Date 假时钟兜底还原（异常路径也不漏）
  });

  it('date = Asia/Shanghai 签发日；复用续窗**不重锚**（跨 UTC 日界样本）——且与 reliefActionId 同源互证', async () => {
    vi.useFakeTimers();
    const beforeMidnight = new Date('2026-10-11T15:59:00Z'); // 沪 2026-10-11 23:59
    vi.setSystemTime(beforeMidnight);

    const first = await svc.findOrCreate('u-mid');
    expect(first.date).toBe('2026-10-11');
    // 同源互证：账本幂等锚内嵌的日期 == claim 签发日（两处同源判据——跨日界时若两处分歧，
    // 「凭证锚 A 日、账本查 B 日」会让回调判重放/发放错位）
    expect(reliefActionId('u-mid', beforeMidnight)).toBe(`relief:u-mid:${first.date}`);

    vi.setSystemTime(new Date('2026-10-11T16:01:00Z')); // 沪 2026-10-12 00:01
    const reused = await svc.findOrCreate('u-mid');
    expect(reused.nonce).toBe(first.nonce);
    expect(reused.reused).toBe(true);
    expect(reused.date).toBe('2026-10-11'); // 首发时刻固定——复用续窗不重锚（§2.6）

    const fresh = await svc.findOrCreate('u-mid-2'); // 另一用户在新的一天
    expect(fresh.date).toBe('2026-10-12');
  });

  it('注册面（T6/T11 教训）：`ClaimService` ∈ `AppModule.providers`（未注册 = 真容器解析注入即崩）', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(ClaimService);
  });
});
