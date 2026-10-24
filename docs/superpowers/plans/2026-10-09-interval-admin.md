# 节奏/清理旋钮管理化 实现计划 v1.2.1（冻结）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 六个节奏/清理间隔 env 搬进业务配置面（CONFIG_KEYS 第 35–40 键），六循环排期处现读、下一轮即生效；env 退役 + conformance 注入链换源。

**Architecture:** 复用既有配置中心广播/缓存/管理面全套机制（零新表/零新 env/零新容器）；六循环套用统一「首排动作」（有界等首快照 → 解析 → 启动行 → 排首轮，once 闸）；conformance 六片注入改管理面 PUT、还原写知基线值。

**Tech Stack:** TypeScript / NestJS / vitest / TypeORM 迁移 / bash（stack.sh）/ conformance TS 驱动。

**上游（契约唯一真源）：** 规格 v1.3 冻结（`b4fff42`）（`docs/superpowers/specs/2026-10-09-interval-admin-spec.md`）；设计 v1.3 冻结 `920d9f8`。**实施中任何与规格相抵的发现 ⇒ 停手登记，不擅自改道。**

## Global Constraints（每个任务隐性包含；逐条来自规格）

1. 六键逐字：`pay.scanIntervalMs`(60000, ≤600000) · `pay.reconcileIntervalMs`(86400000, ≤864000000) · `currency.reconcileIntervalMs`(3600000, ≤36000000) · `risk.scanIntervalMs`(3600000, ≤36000000) · `risk.devicesCleanupIntervalMs`(3600000, ≤36000000) · `record.cleanupIntervalMs`(3600000, ≤36000000)——int、下界 1、**内部键**（不进 CLIENT_CONFIG_KEYS）。
2. 启动行 = 判据物，**格式逐字不变**，`interval`/`first round in` 位 = **解析值**（解析+打印在首排动作续体内）。
3. 首排动作三条**不可放宽**：快路径真同步（不得经 await/微任务）· race 败方定时器清除 + **once 闸至多一次** · `onModuleInit` 同步返回（`void` 浮动续体）。
4. getter 回落 = 代码默认（缺键/坏值/快照不可用——janitor fail-safe；注释写明与钱面 fail-closed 分层）。
5. conformance 迁移统一形态：`PUT 注入 → GET 确认 → 重建 → 观测（判据不变）→ PUT **知基线值**（pay 两键=2000；四键=3600000）→ GET 确认 → 重建`——**还原不写「现值」**。
6. 判据只增不减；baselines 下调必须在本任务提交信息写明理由。
7. 每任务：先写失败测试 → 跑红 → 最小实现 → 跑绿 → **git commit**（结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）；提交只 add 显式路径。
8. 命令口径（**r1 🔴1 订正**）：本仓 = **pnpm 工作区**（根 `package.json` 无 `workspaces`；`packageManager: pnpm@9.15.0`）——单包测 = `pnpm --filter @fight-the-landlord/<pkg> test`（过滤：`… test -- <file>`）；六阶段 = `bash scripts/ci.sh`；compose 自检 = `docker compose config -q`。
9. Windows/本机：git bash；**行号=规格取证于 HEAD，实施时以实文复核**（本计划行号同为 HEAD 口径）。

## 任务总览与波次

| 波 | 任务 | 交付 | 规格行级映射 |
|---|---|---|---|
| W1 | T1 protocol 键面+校验 | 40 键 + `parseIntervalMs` | ⚙️1/⚙️2 · 附录 A#1 测试面 |
| W1 | T2 种子迁移 | `1794000000000` + 计数测试 | ⚙️3 |
| W1 | T3 config-service 测试面全量同步 | 四份名单/双副本/文案 40 | ⚙️10 硬断言组 |
| W2 | T4 三份缓存 getter/常数/补 hasSnapshot | getter 六枚 + 常数 + WAIT | ⚙️4 |
| W2 | T5 records 循环改造+单测 | 现读+首排 | ⚙️5–⚙️7 |
| W2 | T6 risk-scan 循环改造+单测 | 同 | ⚙️5–⚙️7 |
| W2 | T7 devices 循环改造+单测 | 同 | ⚙️5–⚙️7 |
| W3 | T8 currency reconcile 改造+单测 | 注入+现读+首排 | ⚙️5–⚙️7 |
| W3 | T9 payment scan 两链改造+单测 | 注入+现读+首排×2 链 | ⚙️5–⚙️7 |
| W4 | T10 compose 六行删 + stack.sh 换源 | 编排面 | ⚙️8.1/8.2 |
| W4 | T11 RETIRED_ENVS +6 | 机械闸 | ⚙️8.3 |
| W5 | T12 slice-15/17/18 迁移 | 三片 | ⚙️9 |
| W5 | T13 slice-20 迁移 + 设备小组 | 一片+新判据 | ⚙️9 |
| W5 | T14 slice-21 迁移 | ⓪/①/⑬/计数 | ⚙️9 |
| W5 | T15 slice-22/23 迁移+计数 | 两片 | ⚙️9 |
| W6 | T16 admin 页（NOTES+计数+横幅） | 文案面 | ⚙️10 admin |
| W6 | T17 文档面 + 注释扫修 + 台账 | docs/ledger | ⚙️10 文档/注释 |
| W6 | T18 baselines+六阶段+全序+清零核销+交接 | 收口 | P6/⚙️8.5/§5 |

依赖：T2←T1；T3←T1,T2；T5–T7←T4;T8,T9←T4；T12–T15←T10（跑真栈时）；T18←全部。

---

### T1 — protocol 键面与 `parseIntervalMs`

**Files:**
- Modify: `packages/protocol/src/config.ts`（`CONFIG_KEYS` :14-74 · 新 `INTERVAL_KEYS`/`parseIntervalMs` 置 `CYCLE_KEYS` 区 :118-123 邻 · 派发 `parseConfigValue` :146-175 · 头注 :3 文案「三十四重→四十」）
- Test: `packages/protocol/src/config.test.ts`（:9-28 数组与文案 · 新增 `parseIntervalMs` describe）

**Interfaces:**
- Produces: `CONFIG_KEYS` 40 项 · `parseIntervalMs(key, value): number`（合法原值/抛 `ProtocolError`）· 模块私有 `INTERVAL_KEYS: Partial<Record<ConfigKey, number>>`（上界表——r1 ⚪12 订正措辞；不导出）。
- Consumes: 无。

- [ ] **Step 1: 写失败测试（清单 + 校验族）**

`config.test.ts`：:9/:10 文案「四十键」；:11-28 数组追加（**顺序=规格 ⚙️1**）：
```ts
  /** 节奏/清理旋钮六键（第 35–40 键；本片）。 */
  'pay.scanIntervalMs',
  'pay.reconcileIntervalMs',
  'currency.reconcileIntervalMs',
  'risk.scanIntervalMs',
  'risk.devicesCleanupIntervalMs',
  'record.cleanupIntervalMs',
```
新增 describe（照该文件既有 parse 用例族形态）：
```ts
describe('parseIntervalMs（节奏/清理六键）', () => {
  const CASES = [
    ['pay.scanIntervalMs', 600_000],
    ['pay.reconcileIntervalMs', 864_000_000],
    ['currency.reconcileIntervalMs', 36_000_000],
    ['risk.scanIntervalMs', 36_000_000],
    ['risk.devicesCleanupIntervalMs', 36_000_000],
    ['record.cleanupIntervalMs', 36_000_000],
  ] as const;
  for (const [key, max] of CASES) {
    it(`${key}：1 与上界合法；0/负/小数/上界+1/字符串/null 拒`, () => {
      expect(parseConfigValue(key, 1)).toBe(1);
      expect(parseConfigValue(key, max)).toBe(max);
      for (const bad of [0, -1, 1.5, max + 1, '3000', null, true]) {
        expect(() => parseConfigValue(key, bad)).toThrow(ProtocolError);
      }
    });
  }
});
```
（如该文件未 import `parseConfigValue`/`ProtocolError`，补 import。）

- [ ] **Step 2: 跑红** `pnpm --filter @fight-the-landlord/protocol test -- config.test.ts` ⇒ 断言失败（40 键/未定义行为）。

- [ ] **Step 3: 实现（`config.ts`）**

`CONFIG_KEYS` 尾部（`pay.withdrawTimeoutMinutes` 后）追加六项并加注（照既有逐键注释体例，注明「第 35–40 键 · 默认/界/消费方」）。`CYCLE_KEYS` 区旁新增：
```ts
/**
 * 节奏/清理旋钮六键（第 35–40 键）：int 毫秒、`1 ≤ n ≤ 10×默认`（照 CYCLE_KEYS 十倍余量惯例）。
 * ⚠️ 不复用 CYCLE_KEYS（上界族不同）；下界 1 保 env 等价（现行 env 语义即 >=1）。
 */
const INTERVAL_KEYS: Partial<Record<ConfigKey, number>> = {
  'pay.scanIntervalMs': 600_000,
  'pay.reconcileIntervalMs': 864_000_000,
  'currency.reconcileIntervalMs': 36_000_000,
  'risk.scanIntervalMs': 36_000_000,
  'risk.devicesCleanupIntervalMs': 36_000_000,
  'record.cleanupIntervalMs': 36_000_000,
};
```
`parseConfigValue` 派发（`CYCLE_KEYS` 行之后）：
```ts
  if (Object.hasOwn(INTERVAL_KEYS, key)) return parseIntervalMs(key, value);
```
实现（`parseCycleMs` 邻）：
```ts
/** 节奏/清理间隔：整数毫秒且 `1 ≤ n ≤ INTERVAL_KEYS[key]`（本片 ⚙️2 逐字）。 */
function parseIntervalMs(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数毫秒`);
  }
  const max = INTERVAL_KEYS[key] as number;
  if (value < 1 || value > max) {
    throw new ProtocolError(`${key} 必须在 1 ≤ n ≤ ${max}（毫秒）范围内`);
  }
  return value;
}
```
头注 :3 与 `config.test.ts:9` 文案同步「四十键」。

- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/protocol test` ⇒ 全绿。

- [ ] **Step 5: Commit** `git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts && git commit -m "feat(protocol): 节奏/清理六键入 CONFIG_KEYS（第 35–40 键）+ parseIntervalMs"`

---

### T2 — 种子迁移 `1794000000000-IntervalConfigSeed.ts`

**Files:**
- Create: `packages/config-service/src/migrations/1794000000000-IntervalConfigSeed.ts`
- Test: `packages/config-service/test/migration.test.ts`（+计数块，照 `:457-508` pay 块先例）

**Interfaces:**
- Produces: 六行种子（`version=1`、`updated_by='seed'`）；`down` 删六行。类名 `IntervalConfigSeed1794000000000`。
- Consumes: `platform_config` 表（既有）。

- [ ] **Step 1: 写失败测试**（`migration.test.ts` 新 describe，照 pay 块结构：up 后六行在场且值逐字、行数恰 6；down 后零行；migration name 记录；**⑭″ 时间戳单调（晚于 `1793000000000-NotifyChannelConfig`）+ 全仓唯一**——r1 ⚪14 补，照 `:510-515`/`:552-575` 先例形态）：
```ts
describe('IntervalConfigSeed1794000000000：第 35–40 键种子迁移', () => {
  it('up：恰六行（元组数 6）且值逐字 = 出厂默认', ...);
  it('down：六键行退场（IN 名单恰六）', ...);
  it('⑭″：时间戳单调（> 1793000000000）且全仓唯一', ...);
});
```
- [ ] **Step 2: 跑红** `pnpm --filter @fight-the-landlord/config-service test -- migration.test.ts`

- [ ] **Step 3: 实现迁移文件**（逐字照 `1791000001000-PayConfigSeed.ts` 形状）：
```ts
export class IntervalConfigSeed1794000000000 implements MigrationInterface {
  name = 'IntervalConfigSeed1794000000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('pay.scanIntervalMs', '60000', 1, NOW(3), 'seed'), " +
        "('pay.reconcileIntervalMs', '86400000', 1, NOW(3), 'seed'), " +
        "('currency.reconcileIntervalMs', '3600000', 1, NOW(3), 'seed'), " +
        "('risk.scanIntervalMs', '3600000', 1, NOW(3), 'seed'), " +
        "('risk.devicesCleanupIntervalMs', '3600000', 1, NOW(3), 'seed'), " +
        "('record.cleanupIntervalMs', '3600000', 1, NOW(3), 'seed')",
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE FROM `platform_config` WHERE `key` IN ' +
        "('pay.scanIntervalMs', 'pay.reconcileIntervalMs', 'currency.reconcileIntervalMs', " +
        "'risk.scanIntervalMs', 'risk.devicesCleanupIntervalMs', 'record.cleanupIntervalMs')",
    );
  }
}
```
（类注照 pay 先例写明「值=现行默认 ⇒ 行为保持」与「行为等价日 0」。）

- [ ] **Step 4: 跑绿（过滤）** + **Step 5: Commit**（`feat(config-service): 第 35–40 键种子迁移（IntervalConfigSeed）`）

---

### T3 — config-service 测试面全量同步（键面 40）

**Files（全部 Modify；本任务 src 零改，纯断言面收口）：**
- `packages/config-service/test/platform-config.service.test.ts`：`:200-203` 注释 · `:204-249` SEED **+6 元组**（值=⚙️1 种子）· `:290` 文案「四十键」· `:296` 行数 `34→40` · `:297` 符号同（自动）· `:303-337` **+6 逐键值断言** · `:529` 注释
- `packages/config-service/test/helpers/config-probe.ts`：`:139` 注释 · `:140-185` SEED **第二副本同源 +6**（⚠️ 与上一份逐字同源——严格读取纪律）· `:29-32` 头注迁移清单
- `packages/config-service/test/admin.controller.test.ts`：`:20` 注释 · `:169` it 名 · `:175-214` 逐字名单 **+6**（顺序=⚙️1）
- `packages/config-service/test/config.rpc.test.ts`：`:113-152` 逐字名单 **+6**（`:528-551` 通知片第⑥**不动**）
- `packages/config-service/test/client-config.test.ts`：`:92` 文案「三十四」核改（内部前缀扫描名单无需扩——六键带既有前缀）
- `packages/config-service/test/migration.test.ts`：`:457-508` 邻新块已在 T2

**Interfaces:** 无新符号；本任务后 `pnpm --filter @fight-the-landlord/config-service test` 全绿（W1 收口）。

- [ ] **Step 1: 逐文件落 +6/改文案**（按上列行号；SEED 两副本**同一次编辑内同步**）
- [ ] **Step 2: 跑绿** `pnpm --filter @fight-the-landlord/config-service test` ⇒ 全绿
- [ ] **Step 3: W1 波末门禁** `bash scripts/ci.sh` ⇒ 六阶段绿
- [ ] **Step 4: Commit**（`test(config-service): 键面四十同步（SEED 双副本/admin/rpc/文案）`）

---

### T4 — 三份缓存：getter 六枚 + 常数迁入 + 补 `hasSnapshot()` + `SNAPSHOT_BOOT_WAIT_MS`

**Files:**
- Modify: `packages/user-service/src/config/config-cache.service.ts`（`RETENTION_DAYS_DEFAULT` 区 :22 邻加三常数；`waitForFirstSnapshot` ⚠️ **上方补 `hasSnapshot()`**（照 payment `:186-188` 逐字）；getter 区尾 +3 getter；文件导出 `SNAPSHOT_BOOT_WAIT_MS`）
- Modify: `packages/payment-service/src/config/config-cache.service.ts`（+2 getter +2 常数 + `SNAPSHOT_BOOT_WAIT_MS`）
- Modify: `packages/currency-service/src/config/config-cache.service.ts`（+1 getter +1 常数 + `SNAPSHOT_BOOT_WAIT_MS`）
- Test: user `test/config-cache.test.ts` + currency `test/config-cache.test.ts`（同构既有文件，+各 getter 三态）；**payment 为 Create `packages/payment-service/test/config-cache.test.ts`**（r1 🟠5：该文件现不存在——13 个 test 文件实核；照 user/currency 同构，+2 getter 三态）

**Interfaces:**
- Produces（供 T5–T9 消费）：`user: riskScanIntervalMs()/devicesCleanupIntervalMs()/recordsCleanupIntervalMs()/hasSnapshot(): boolean` · `payment: scanIntervalMs()/reconcileIntervalMs()` · `currency: reconcileIntervalMs()`；三份 `SNAPSHOT_BOOT_WAIT_MS = 10_000`；`hasSnapshot()` 三份齐（payment/currency 已有）。
- Consumes: 既有 snapshot 机制。

- [ ] **Step 1: 写失败测试**（每服务 config-cache.test.ts：snapshot 置合法值 ⇒ getter 原值；缺键/非整数/0/上界+1 ⇒ 默认常数；`hasSnapshot()` 前后态（user）；`SNAPSHOT_BOOT_WAIT_MS===10_000`）
- [ ] **Step 2: 跑红**（三包过滤跑：`pnpm --filter @fight-the-landlord/user-service test -- config-cache` · `…/payment-service …` · `…/currency-service …`）
- [ ] **Step 3: 实现**。getter 形态逐字（user 例，其余同名同式换键/界/默认）：
```ts
/** `record.cleanupIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 36000000）。 */
const RECORDS_CLEANUP_INTERVAL_MIN = 1;
const RECORDS_CLEANUP_INTERVAL_MAX = 36_000_000;
export const RECORDS_CLEANUP_DEFAULT_INTERVAL_MS = 3_600_000;
export const SNAPSHOT_BOOT_WAIT_MS = 10_000;   // 三份克隆同值（R96 同源纪律；注释互指）

/**
 * 保留期清理周期（第 40 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 1h。
 * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
 */
recordsCleanupIntervalMs(): number {
  const value = this.snapshot?.['record.cleanupIntervalMs']?.value;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RECORDS_CLEANUP_INTERVAL_MIN &&
    value <= RECORDS_CLEANUP_INTERVAL_MAX
    ? value
    : RECORDS_CLEANUP_DEFAULT_INTERVAL_MS;
}

/** 是否已成功拉到过一次快照（照 payment 同款；本片 ⚙️5 快路径消费）。 */
hasSnapshot(): boolean {
  return this.snapshot !== null;
}
```
⚠️ 默认常数与 getter **同文件**（唯一真源）；loop 文件（T5–T9）改为 `export { … } from '../config/config-cache.service'` re-export 保测试引用。
- [ ] **Step 4: 跑绿** 三包 ⇒ 绿
- [ ] **Step 5: Commit**（`feat(config-cache): 节奏六 getter + 常数迁入 + user 补 hasSnapshot + WAIT 常数三克隆`）

---

### T5 — records 循环改造（首排动作 + 重排现读）+ 单测

**Files:**
- Modify: `packages/user-service/src/records/records-cleanup.service.ts`（:84-85 删字段 · :93-101 onModuleInit · :123 重排处 · :20-23 常数改 re-export · 类注 :40-46 env 句改配置面口径）
- Test: `packages/user-service/test/records-cleanup.test.ts`（`ENV_KEY` 机制退役 `:44`/`:144-152`；`makeCache` 扩接口 `:120-127`）

**Interfaces:** Consumes T4（`recordsCleanupIntervalMs()`/`hasSnapshot()`/`waitForFirstSnapshot()`/`SNAPSHOT_BOOT_WAIT_MS`）· Produces 无新导出（`RECORDS_CLEANUP_DEFAULT_INTERVAL_MS` re-export 保名）。

- [ ] **Step 1: 写失败测试**。改造 `makeCache`：
```ts
function makeCache(opts: { days?: number; intervalMs?: number }) {
  const retentionDays = vi.fn(() => opts.days ?? 365);
  const recordsCleanupIntervalMs = vi.fn(() => opts.intervalMs ?? 3_600_000);
  const cache = {
    retentionDays,
    recordsCleanupIntervalMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
  return { cache, retentionDays, recordsCleanupIntervalMs };
}
```
新增用例（env 注入族**迁移**：`:163-189` 的节奏边界用例改「假缓存注入」；`:213-228`「空串/非法回落」语义用例删除——对象退役；r1 🟡10 行号订正——payment 侧同族用例在 `scan.test.ts:711`，属 T9）：
```ts
it('重排现读（本片核心）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值', async () => {
  // fake timers：hasSnapshot=true ⇒ 快路径同帧排首轮（30s）
  // 30s 到 ⇒ 首轮跑完 ⇒ 下一轮 = 3600000（默认）
  // cache.recordsCleanupIntervalMs.mockReturnValue(3000) ⇒ 排下一轮后推进 3000 触发、推进 2999 不触发
  // 再改 7000 ⇒ 同上断言
});
it('首排动作三态：晚到（hasSnapshot=false, wait 后 resolve ⇒ 用缓存值）/超时（缺省）/超时后迟到 ⇒ 恰一次排期', async () => { ... });
it('首排动作：续体关停闸（等待期间 shutdown ⇒ 零排期；vi.getTimerCount()===0 终态）', async () => { ... });
it('启动行 interval 位 = 解析值（捕获 sink 断 `interval 3000ms`）', async () => { ... });
```
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（service 三段替换，逐字）：
```ts
import { ConfigCacheService, RECORDS_CLEANUP_DEFAULT_INTERVAL_MS, SNAPSHOT_BOOT_WAIT_MS } from '../config/config-cache.service';
export { RECORDS_CLEANUP_DEFAULT_INTERVAL_MS };

onModuleInit(): void {
  recordsCleanupLastSuccessTimestampSeconds.set(0);   // T0 同步，顺序即语义（别对调）
  this.bootFirstScheduling();
}

private bootFirstScheduling(): void {
  if (this.configCache.hasSnapshot()) { this.afterSnapshotReady(); return; }  // 同帧（真同步）
  let settled = false;
  const settle = (): void => { if (settled) return; settled = true; clearTimeout(timeout); this.afterSnapshotReady(); };
  const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
  void this.configCache.waitForFirstSnapshot().then(settle, settle);
}

private afterSnapshotReady(): void {
  if (this.shuttingDown) return;
  this.logger.log(`Records cleanup loop started (first run in ${RECORDS_CLEANUP_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`);
  this.scheduleNext(RECORDS_CLEANUP_FIRST_RUN_DELAY_MS);
}

private resolveIntervalMs(): number { return this.configCache.recordsCleanupIntervalMs(); }
```
重排处（`:123`）：`if (!this.shuttingDown) this.scheduleNext(this.resolveIntervalMs());`；删 `intervalMs` readonly 字段。
- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/user-service test`（**该包其余两循环未改，本任务只保 records 用例族绿 + 全包无新增红**——risk-scan/devices 用例族此时未动，不会红）
- [ ] **Step 5: Commit**（`feat(user-service): records 循环首排动作+重排现读（本片 T5）`）

---

### T6 — risk-scan 循环改造 + 单测

**Files:**
- Modify: `packages/user-service/src/risk/scan.service.ts`（:130-131 删字段 · :142-150 onModuleInit（**保留 :145 `riskScanLastSuccessTimestampSeconds.set(0)` T0 同步**）· :170 重排 · :37 常数 re-export · 类注 :89 env 句）
- Test: `packages/user-service/test/risk-scan.test.ts`（`ENV_KEY` :45 机制退役 · `:1090 makeScanConfig` 扩接口 · `:1098-1143` 节奏边界用例迁移 · `:1145-1153` 先置 0 保持 T0 的断言**逐字保留**）

**Interfaces:** Consumes T4（`riskScanIntervalMs()`/`hasSnapshot()`/`waitForFirstSnapshot()`/WAIT）· Produces 无。

- [ ] **Step 1: 写失败测试**（照 T5 四件套改名换值：重排现读 / 首排三态（含 once）/ 关停闸 / 启动行 `interval <v>ms`；`makeScanConfig` 补 `hasSnapshot→true`、`waitForFirstSnapshot→resolved`、`riskScanIntervalMs` fn）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（T5 同形，逐字换名）：
```ts
onModuleInit(): void {
  riskScanLastSuccessTimestampSeconds.set(0);   // T0 同步（:145 先例保留）
  const warm = this.configCache.hasSnapshot();
  if (warm) { this.afterSnapshotReady(); return; }
  let settled = false;
  const settle = (): void => { if (settled) return; settled = true; clearTimeout(timeout); this.afterSnapshotReady(); };
  const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
  void this.configCache.waitForFirstSnapshot().then(settle, settle);
}
private afterSnapshotReady(): void {
  if (this.shuttingDown) return;
  this.logger.log(`Risk scan loop started (first run in ${RISK_SCAN_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`);
  this.scheduleNext(RISK_SCAN_FIRST_RUN_DELAY_MS);
}
private resolveIntervalMs(): number { return this.configCache.riskScanIntervalMs(); }
```
重排处 `:170` 同改；删字段；`RISK_SCAN_DEFAULT_INTERVAL_MS` re-export。
- [ ] **Step 4: 跑绿** + **Step 5: Commit**（`feat(user-service): risk-scan 循环首排动作+重排现读（本片 T6）`）

---

### T7 — devices-cleanup 循环改造 + 单测

**Files:**
- Modify: `packages/user-service/src/risk/devices-cleanup.service.ts`（:67-68 删字段 · :76-81 onModuleInit（**无 set(0)，不新增**）· :101 重排 · :15 常数 re-export · 类注 :35）
- Test: `packages/user-service/test/risk-devices-cleanup.test.ts`（`ENV_KEY` :35 退役 · `:95` fake cache 扩 · `:148` 注入用例迁移）

**Interfaces:** Consumes T4（`devicesCleanupIntervalMs()` 等）· Produces 无。

- [ ] **Step 1–4:** 照 T5/T6 同形（本循环无先置 0；启动行 `Risk devices cleanup loop started (first run in 30000ms, interval <v>ms)`）
- [ ] **Step 5: W2 波末门禁** `bash scripts/ci.sh` ⇒ 绿 + **Commit**（`feat(user-service): devices-cleanup 循环首排动作+重排现读（本片 T7）`）

---

### T8 — currency reconcile 改造（注入 + 现读 + 首排）+ 单测

**Files:**
- Modify: `packages/currency-service/src/reconcile/reconcile.service.ts`（构造 :188-192 **+`private readonly configCache: ConfigCacheService`（值导入直接参数注入，照 user 循环先例；无需 @Inject）**；:184-186 删字段 · :194-202 onModuleInit（保留 :197 set(0) T0 同步）· :235/:246 重排 · :24 常数 re-export · :9 import 补）
- Test: `packages/currency-service/test/reconcile.test.ts`（`ENV_KEY` :52 退役 · `:165` 注入用例迁移 · `:444-470` 首成功时间戳锚用例适配验证 · **构造点 `mkService` :126-127 补第三参 fake cache**）· `test/reconcile-admin.test.ts`（:49 ENV_KEY 面核改 · **构造点 :85-86/:163/:347 补第三参**——r1 🟠6）

**Interfaces:** Consumes T4（`reconcileIntervalMs()`/`hasSnapshot()`/`waitForFirstSnapshot()`/WAIT）· Produces 无。

- [ ] **Step 1: 写失败测试**（四件套 + 时锚用例：`(T0+10_000)/1000` 首成功时间戳在首排动作下不变——快路径同帧 ⇒ 锚点=构造时刻）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**：
```ts
constructor(
  @Inject(DataSource) private readonly dataSource: DataSource,
  @Inject(REDIS) private readonly redis: Redis,
  private readonly configCache: ConfigCacheService,   // 值导入（DI 陷阱纪律）
) {}

onModuleInit(): void {
  currencyReconcileLastSuccessTimestampSeconds.set(0);   // T0 同步
  this.bootFirstScheduling();
}
private bootFirstScheduling(): void { /* T5 同形（settle once 闸 + WAIT） */ }
private afterSnapshotReady(): void {
  if (this.shuttingDown) return;
  this.logger.log(`Currency reconcile loop started (first run in ${CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`);
  this.scheduleNext(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
}
private resolveIntervalMs(): number { return this.configCache.reconcileIntervalMs(); }
```
重排处 `:235`/`:246` 同改（`:246` 为 `.finally` 内重排，注意保留关停闸）。**真容器自证**：`docker compose up -d --build currency-service` 起得来（DI 解析实证）。
- [ ] **Step 4: 跑绿** + **Step 5: Commit**（`feat(currency-service): reconcile 循环注入缓存+首排动作+重排现读（本片 T8）`）

---

### T9 — payment scan 两链改造（注入 + 现读 + 首排×两链）+ 单测

**Files:**
- Modify: `packages/payment-service/src/scan/scan.service.ts`（构造 :247-253 **+`ConfigCacheService`（第 6 依赖；值导入）**；:76-109 两 resolve 导出函数 env 体退役 → 私有 `resolveScanIntervalMs()`/`resolveReconcileIntervalMs()`；:255-267 onModuleInit 两链合一首排；:289/:307 重排；:77/:90 常数 re-export（`PAY_SCAN_DEFAULT_INTERVAL_MS`/`PAY_RECONCILE_DEFAULT_INTERVAL_MS`）；类注 :31/:61 env 句）
- Test: `packages/payment-service/test/scan.test.ts`（15 处；**构造点 :262 补第 6 参**）· `test/reconcile.test.ts`（18 处；**构造点 :296 补**）· **`test/orders-state.test.ts:1001`、`test/notify.test.ts:311` 构造点补第 6 参 + 各自 fake cache 补 `hasSnapshot`/`waitForFirstSnapshot`（r1 🟠6）**

**Interfaces:** Consumes T4（payment 缓存两 getter/WAIT）· Produces 无对外新符号。

- [ ] **Step 1: 写失败测试**（两链四件套：重排现读 ×2（scan 链改值 ⇒ 下一轮延迟变；reconcile 链同）/ 首排三态 + once / 关停闸（**两 timer 都要被 clear**——`vi.getTimerCount()===0` 断言覆盖双链）/ 启动行两行格式。既有「空串=未设」解析用例退役）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（**两链共用一次等待**）：
```ts
onModuleInit(): void {
  this.bootFirstScheduling();   // 两链的首排都经此（判据物两行都须带解析值）
}

private bootFirstScheduling(): void {
  if (this.configCache.hasSnapshot()) { this.afterSnapshotReady(); return; }
  let settled = false;
  const settle = (): void => { if (settled) return; settled = true; clearTimeout(timeout); this.afterSnapshotReady(); };
  const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
  void this.configCache.waitForFirstSnapshot().then(settle, settle);
}

private afterSnapshotReady(): void {
  if (this.shuttingDown) return;
  const scan = this.resolveScanIntervalMs();
  this.logger.log(`Payment scan loop started (first round in ${scan}ms; loops: ① closeExpired ② sweepCreated ③ creditPending ④ resolveHolding ⑤ rollbackTimeout ⑥ refundResolveHolding ⑦ refundRollbackRecovery ⑧ refundUnknownReplay)`);
  this.scheduleNext(scan);
  this.logger.log(`Payment reconcile loop started (first run in ${PAY_RECONCILE_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveReconcileIntervalMs()}ms; 入账勾稽 + 锚勾稽 ⇒ payment_reconcile_diff)`);
  this.scheduleNextReconcile(PAY_RECONCILE_FIRST_RUN_DELAY_MS);
}

private resolveScanIntervalMs(): number { return this.configCache.scanIntervalMs(); }
private resolveReconcileIntervalMs(): number { return this.configCache.reconcileIntervalMs(); }
```
重排处 `:289` `this.scheduleNext(this.resolveScanIntervalMs());`、`:307` `this.scheduleNextReconcile(this.resolveReconcileIntervalMs());`。**真容器自证**：`docker compose up -d --build payment-service` 起得来（6 依赖 DI 解析 + forwardRef 环无损）。
- [ ] **Step 4: 跑绿**（payment 全包）+ **Step 5: W3 波末门禁** `bash scripts/ci.sh` + **Commit**（`feat(payment-service): scan 两链注入缓存+首排动作+重排现读（本片 T9）`）

---

### T10 — compose 六行删 + conformance-stack.sh 换源

**Files:**
- Modify: `docker-compose.yml`（payment `:366-367` 删 + **`:359-365` 注释块改写**；user `:178`/`:183-184` 删 + `:181-182` 注释重写（生产不设的「测试注入面」语义句退役，改述「已管理化：conformance 经管理面种子」）；`:321` currency 删；`:352` 注释句订正）
- Modify: `scripts/deploy/conformance-stack.sh`（`$1-54` 两 export 删 + 注释段 `:36-46` 重写；**渠道种子段后**追加 `config_seed_put` 助手 + 六键调用）

**Interfaces:** Produces：六键栈基线（pay 两键 2000 / 四键 3600000）——T12–T15 的还原基线引用点。

- [ ] **Step 1: compose 删行** ⇒ `docker compose config -q` 绿
- [ ] **Step 2: stack.sh**：
```bash
config_seed_put() {  # $1 = 键；$2 = 数值（JSON 数字，非字符串——parseIntervalMs 拒字符串）
  local key="$1" num="$2" encoded res
  encoded="$(SEED_KEY="$key" node -e 'process.stdout.write(encodeURIComponent(process.env.SEED_KEY))')"
  res="$(curl -sS --max-time 30 -X PUT "$SEED_GATEWAY/api/admin/config/$encoded" \
    -H "Authorization: Bearer $SEED_TOKEN" -H 'Content-Type: application/json' \
    -d "$(SEED_NUM="$num" node -e 'const n=Number(process.env.SEED_NUM);process.stdout.write(JSON.stringify({value:n}))')" 2>&1 || true)"
  if ! printf '%s' "$res" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>{let ok=false;try{ok=(JSON.parse(s).data||{}).saved===true}catch{}process.exit(ok?0:1)})'; then
    printf '❌ [stack] 节奏种子：PUT %s 失败（未返回 saved:true；响应形状以实测为准，非 saved 形态按实测调整判读但失败必须响亮）；响应尾部：\n' "$key" >&2
    printf '%s\n' "$res" | tail -c 400 >&2
    exit 1
  fi
}
config_seed_put 'pay.scanIntervalMs' 2000
config_seed_put 'pay.reconcileIntervalMs' 2000
config_seed_put 'currency.reconcileIntervalMs' 3600000
config_seed_put 'risk.scanIntervalMs' 3600000
config_seed_put 'risk.devicesCleanupIntervalMs' 3600000
config_seed_put 'record.cleanupIntervalMs' 3600000
printf '=== [stack] 节奏六键种子完成（基线 2000/2000/3600000×4）===\n'
```
注释段写明：**跨 run 残留收拢点**（每次 up 归一到基线）+ 与 run.ts 无关声明。删 `:53-54` 两 export。
- [ ] **Step 3: 真栈自证**：`bash scripts/deploy/conformance-stack.sh up` ⇒ 种子行打印 + `docker exec ftl-mysql mysql … -e "SELECT value FROM platform_config WHERE \`key\`='pay.scanIntervalMs'"` = `2000`（含端到端 PUT 路径实证）
- [ ] **Step 4: Commit**（`feat(ops): compose 六行退役 + stack.sh 六键种子（基线供给+残留收拢）`）

---

### T11 — `RETIRED_ENVS` +6

**Files:** Modify: `packages/shared/test/design-md-ai-rollout.gate.test.ts`（`:94-109` 数组 +6 · `:85-93` 注释续写本片条目）

- [ ] **Step 1: 写测试即实现**（本任务测试=闸本身）：数组尾追加六 env 名（逐字：`PAY_SCAN_INTERVAL_MS`/`PAY_RECONCILE_INTERVAL_MS`/`CURRENCY_RECONCILE_INTERVAL_MS`/`RISK_SCAN_INTERVAL_MS`/`RECORDS_CLEANUP_INTERVAL_MS`/`RISK_DEVICES_CLEANUP_INTERVAL_MS`）
- [ ] **Step 2: 跑绿** `pnpm --filter @fight-the-landlord/shared test -- design-md-ai-rollout` ⇒ 绿（§2.3 已核零命中）
- [ ] **Step 3: Commit**（`test(shared): RETIRED_ENVS +6（节奏六 env 防回流；N71 先例）`）

---

### T12 — slice-15 / slice-17 / slice-18 迁移

**Files:**
- Modify: `tools/conformance/src/slices/slice-15-records.ts`（`:690-694` 注入 · `:906` 还原 · `:727` 注释 ≤40s · `:9-13/:43` 头注）
- Modify: `slice-17-currency.ts`（**`:1042` step 串（六 env 残留点，r1 🟡7）** · `:1043`/`:1131`/`:1260` · 头注 `:27/:53` · 窗口 `:1047-1056`）
- Modify: `slice-18-gold-room.ts`（`:51` 头注 · `:1295`/`:1332`/`:1386` · `:855-856` 计数 40 · 90s 窗 `:1299-1312` 复算）

**Interfaces:** Consumes：各片既有管理面 helper（`adminToken`/`putConfigAndWaitEffect` 形态）；T10 的栈基线（3600000）。必要补助手（若片内无 config GET 读口）：
```ts
async function adminGetConfigValue(key: string): Promise<unknown> { /* 复用片内 adminGet 形态取 data.config[key].value */ }
async function putInterval(key: string, ms: number, why: string): Promise<void> { /* PUT + GET 确认=ms，失败响亮 */ }
```

- [ ] **Step 1: slice-15**：`:690-691` 改
```ts
step(`C8①：PUT record.cleanupIntervalMs=3000（管理面注入）+ 重建 user-service（清理轮节奏变快）`);
await putInterval('record.cleanupIntervalMs', 3000, 'C8① 注入');
const c8Up = compose({}, 'up', '-d', '--no-deps', 'user-service');
```
还原 `:906`：`await putInterval('record.cleanupIntervalMs', 3600000, 'C8④ 还原基线'); compose({}, 'up', '-d', '--no-deps', 'user-service');`；`:727` 注释「≤30s」→「≤40s（30s 首轮 + 等快照 ≤10s）」。
- [ ] **Step 2: slice-17**：`:1043` 注入 3000 ↔ `:1131`/`:1260` 还原 3600000（同形，目标 currency-service）；窗口 `:1047-1056` 按 ≤10s 等待复算（30s→40s 类断言若有余量即改注释）。
- [ ] **Step 3: slice-18**：`:1295`/`:1332`/`:1386` 同形；`:855-856`：`checks.eq(adminKeys.length, 40, 'A 管理面键总数 40（17 既有 + 9 支付 + 8 风控 + 6 节奏）')`；`:8` 头注同步；**90s 窗复算（r1 🟡8）**：实文 `:1299-1312`（90s、runs+2）——新机制最坏 ≈ 等待 ≤10s + 10s 首跑 + 3s×2 ≈ 26s ⇒ **数字不改**，复算结论入该步注释。
- [ ] **Step 4: 本地验证**（栈已在 T10 后起）：`node tools/conformance/dist/run.js slice-15-records`（先按既有构建命令编译 conformance）⇒ 绿；同 slice-17/18。
- [ ] **Step 5: Commit（逐片三条——r1 ⚪11）**：`test(conformance): slice-15 注入换源（PUT+基线还原）` → `… slice-17 …` → `… slice-18 换源+计数四十 …`

---

### T13 — slice-20 迁移 + 设备清理小组

**Files:** Modify: `tools/conformance/src/slices/slice-20-risk-control.ts`（`:5` 头注 · **`:11`/`:28`/`:42` 头注与注释（六 env 残留点，r1 🟡7）** · `:131` TOTAL_CONFIG_KEYS=40 · `:676-680` 文案 · `:860-873` ④ 注入 · `:977-992` 还原 · `:1294` finally · **新增设备小组（④ 后、⑤ 前）**）

**Interfaces:** Consumes T10 基线 3600000；片内 `putConfigAndWaitEffect` 辅助形态。

- [ ] **Step 1: ④ 注入迁移**（`:860-861`）：
```ts
step(`④ 检测面：PUT risk.scanIntervalMs=5000（管理面注入）+ 重起 user-service ⇒ 降阈（minGames=1 + winRate=0.5）⇒ …`);
await putInterval('risk.scanIntervalMs', 5000, '④ 注入');
const g4Up = compose({}, 'up', '-d', '--no-deps', 'user-service');
```
`:865-873` 启动行 poll **逐字不动**（`interval 5000ms`）。还原 `:977-979`：
```ts
await putInterval('risk.scanIntervalMs', 3600000, '④ 还原基线');
const g4RestoreT0 = Date.now();
const g4Restore = compose({}, 'up', '-d', '--no-deps', 'user-service');
```
`:982-992` 启动行断言**逐字不动**（`interval 3600000ms`）。finally `:1294` 同改（PUT 基线 + compose 空）。
- [ ] **Step 2: 新设备小组**（插 ④ 复原之后、⑤ step 之前）：
```ts
step('④b 设备清理节奏：PUT risk.devicesCleanupIntervalMs=5000 + 重建 ⇒ 心跳 ≥2 行 ⇒ 还原 3600000');
await putInterval('risk.devicesCleanupIntervalMs', 5000, '④b 注入');
const g4bUp = compose({}, 'up', '-d', '--no-deps', 'user-service');
checks.eq(g4bUp.code, 0, `④b 注入重建 user-service —— 输出尾部：${tailOut(g4bUp.out)}`);
checks.that((await waitContainerHealthy('ftl-user-service')).ok, '④b 注入态就绪');
const g4bBoot = await pollUntil(
  () => ndjson('user-service', 600).filter((r) => String(r.msg).includes('interval 5000ms') && String(r.msg).includes('Risk devices cleanup loop started')).length,
  (n) => n > 0, 30_000);
checks.that(g4bBoot.ok, '④b 启动行 `interval 5000ms`（解析值=配置值）');
const g4bRounds = await pollUntil(
  () => ndjson('user-service', 1200).filter((r) => String(r.msg).includes('risk devices cleanup done')).length,
  (n) => n >= 2, 45_000);
checks.that(g4bRounds.ok, `④b 心跳日志 ≥2 行（30s 首轮 + 5s 间隔；观测窗 ≥45s）—— 实际 ${g4bRounds.last}`);
const g4bT0 = Date.now();
await putInterval('risk.devicesCleanupIntervalMs', 3600000, '④b 还原基线');
const g4bDown = compose({}, 'up', '-d', '--no-deps', 'user-service');
checks.eq(g4bDown.code, 0, `④b 还原重建 —— 输出尾部：${tailOut(g4bDown.out)}`);
const g4bBack = await pollUntil(
  () => ndjson('user-service', 600).filter((r) => String(r.msg).includes('interval 3600000ms') && String(r.msg).includes('Risk devices cleanup loop started') && Number.isFinite(Date.parse(String(r.ts))) && Date.parse(String(r.ts)) >= g4bT0).length,
  (n) => n > 0, 30_000);
checks.that(g4bBack.ok, '④b 还原启动行确认（本 run 新 `interval 3600000ms`）');
```
⚠️ 心跳行字样以 `devices-cleanup.service.ts:128-131` 实文为准（实施时逐字核对；若非 `done` 结尾按实文改断言字面）。
- [ ] **Step 3: 计数** ：`TOTAL_CONFIG_KEYS = 40`（:131）+ 头注 :5 + :676/:680 文案。
- [ ] **Step 4: 本地跑** `node …/run.js slice-20-risk-control` ⇒ 绿。
- [ ] **Step 5: Commit**（`test(conformance): slice-20 注入换源 + 设备清理节奏小组（第 6 键端到端）`）

---

### T14 — slice-21 迁移（⓪/①/⑬/⑯/计数）

**Files:** Modify: `tools/conformance/src/slices/slice-21-payment.ts`（`:11-12` 头注 · `:557` ⓪ · `:581-592` ① · `:366-390` helper 改造 · `:881-910` ⑬ · `:1095/:1101` ⑯ 窗口与判据文案 · **新增片内 `ndjson`/`pollUntil` 两 helper（r1 🟠3）**）

**Interfaces:** Consumes：片内 `adminPutConfig(key, value, token)`（数值版直接可用）、`containerEnv`、**片内重组重建内联形态（`:371-388` `spawnSync('docker', ['compose', …])`）**。
⚠️ **片内没有 `ndjson`/`pollUntil`/`compose`（r1 🟠3 实核）**：本任务须先补两 helper（照 slice-20 `:209/:217` 逐字形态），`adminToken` 是 `runSlice21()` 局部量 ⇒ helper 一律**显式接 token 参数**。

- [ ] **Step 0: 片内 helper 新增**（r1 🟠3）：三件——
```ts
/** 读容器 NDJSON 日志尾（照 slice-20 `:209` 逐字形态——`--since` 秒窗语义，调用点 600/1200 即秒）。 */
function ndjson(container: string, sinceSeconds: number): Array<Record<string, unknown>> { /* docker logs --since Ns + JSON 逐行 parse，坏行丢弃 */ }
async function pollUntil<T>(fn: () => T, ok: (v: T) => boolean, timeoutMs: number, intervalMs = 1000): Promise<{ ok: boolean; last: T }> { /* 照 slice-20 `:217` 形态 */ }
/** 既有内联 spawnSync 重建段（`:371-388`）抽成小函数——`setScanIntervalAndRecreate` 与 ⓪ 归一共用（新-1 钉死）。 */
function composeWithRecreate(service: string): { code: number; out: string } { /* 原内联段逐字搬入 */ }
```
- [ ] **Step 1: helper 改造**（`:366-390` 区；改签名接 token）：
```ts
/** 迁移后：管理面 PUT 扫描周期（+GET 确认）→ 重建 payment-service（不再经 env；⑨⑩⑫⑯ 观测路径由启动行自证）。 */
async function setScanIntervalAndRecreate(paymentMs: number, token: string): Promise<void> {
  const put = await adminPutConfig('pay.scanIntervalMs', paymentMs, token);
  if (put.body?.code !== ErrCode.OK) throw new ConformanceError(`PUT pay.scanIntervalMs=${paymentMs} 失败`);
  const got = await adminGetConfig(token);   // 读口形态照 :582
  const gotValue = got.body?.data?.config?.['pay.scanIntervalMs']?.value;
  if (gotValue !== paymentMs) throw new ConformanceError(`GET 确认 pay.scanIntervalMs ≠ ${paymentMs}（实际 ${JSON.stringify(gotValue)}）`);
  const r = composeWithRecreate('payment-service');
  if (r.code !== 0) throw new ConformanceError(`⑬ 重建 payment-service 失败：${tailOut(r.out)}`);
}
```
（⚠️ 新-2：上例的 GET 比较是**实值形态**——不得写成恒 false 的空转检查。）调用点 `:884` `await setScanIntervalAndRecreate(600000, adminToken);`、`finally :907` `await setScanIntervalAndRecreate(2000, adminToken);`
- [ ] **Step 2: ⑬ 断言迁移**：`:909` env 实读 → 启动行自证：
```ts
const restored = await pollUntil(
  () => ndjson('payment-service', 600).filter((r) => String(r.msg).includes('first round in 2000ms')).length,
  (n) => n > 0, 30_000);
checks.that(restored.ok, '⑬ 扫描周期已还原：启动行 `first round in 2000ms`（解析值=配置值——⑨⑩⑫⑯ 观测路径不受扰）');
```
冻结侧同理（`first round in 600000ms` 1 条，插入 :885 邻）。
- [ ] **Step 3: ⓪ 迁移**（`:557` 删 env 断言）→ **归一 + 重建 + 自证**（照 `:574-578` 先例）：
```ts
// 归一（本片）：crashed run 残留与「起栈未走 stack.sh」缺陷在此收拢——归一后重建 ⇒ 观测路径由启动行自证。
const normI1 = await adminPutConfig('pay.scanIntervalMs', 2000, adminToken);
const normI2 = await adminPutConfig('pay.reconcileIntervalMs', 2000, adminToken);
checks.eq(normI1.body?.code, ErrCode.OK, '⓪ 归一 pay.scanIntervalMs=2000 ⇒ code 0');
checks.eq(normI2.body?.code, ErrCode.OK, '⓪ 归一 pay.reconcileIntervalMs=2000 ⇒ code 0');
const normUp = composeWithRecreate('payment-service');   // 片内内联重建（Step 0/1 抽出的同一小函数）
checks.eq(normUp.code, 0, `⓪ 归一重建 payment-service —— 输出尾部：${tailOut(normUp.out)}`);
checks.that(await waitContainerHealthy('ftl-payment-service'), '⓪ 归一态 payment-service 就绪');
const boot2000 = await pollUntil(
  () => ndjson('payment-service', 600).filter((r) => String(r.msg).includes('first round in 2000ms')).length,
  (n) => n > 0, 30_000);
checks.that(boot2000.ok, '⓪ 启动行自证 `first round in 2000ms`（⑨⑩⑫⑯ 的观测路径由此可执行；config 实读替 env 实读）');
```
（若 ⓪ 原本未重建 payment-service——新开销 ~15s，登记；`adminToken` 在 :560 后才建 ⇒ 归一动作**移至 :560 登录之后**，:`557` 原位只删断言、归一插在渠道种子断言区之后。）
- [ ] **Step 4: ① 扩十一键**（`:592` 后追加）：
```ts
checks.eq(cfgOf('pay.scanIntervalMs'), 2000, '① pay.scanIntervalMs=2000（=stack 种子基线，非出厂种子 60000）');
checks.eq(cfgOf('pay.reconcileIntervalMs'), 2000, '① pay.reconcileIntervalMs=2000（=stack 种子基线，非出厂种子 86400000）');
```
step 文案 `:581`「pay.* 九键逐字」→「pay.* 十一键逐字（九种子 + 两节奏基线）」。
- [ ] **Step 5: ⑯/头注**：`:1095` 45s 窗复算（等待 ≤10s 增量入注释）；`:11-12` 头注「测试注入（conformance-stack.sh export，⚙️18）」句改「管理面种子基线（stack.sh）＋切片内 PUT 注入」。
- [ ] **Step 6: 本地跑** `node …/run.js slice-21-payment` ⇒ 绿；**Step 7: Commit**（`test(conformance): slice-21 注入换源（⓪ 归一重建/① 十一键/⑬ helper 改造/启动行自证）`）

---

### T15 — slice-22 迁移 + slice-22/23 计数

**Files:** Modify: `slice-22-pay-channel.ts`（`:996-999` pickEnv 两键删 · `:1009` · `:1013-1014` · `:1048` · `:1052` · `:1131` · 计数 `:808/:812-816/:988/:1034` · 头注 `:28/:37` · **新增 `safeJson`/`ndjson`/`pollUntil` 三小函数（r1 🟠4）**）· `slice-23-notify-channel.ts`（`:27`/`:731`/`:735`/**`:1283`——r1 🟠2 补**/`:1237` 计数）

**Interfaces:** Consumes：**片内现成 `composeLogs`（`:278`）**；`ndjson`/`pollUntil` 须先补（全文件零命中——r1 🟠4 实核）。

- [ ] **Step 0: 片内 helper 新增**（r1 🟠4；复用 `composeLogs :278` + 三小函数）：
```ts
function safeJson(line: string): Record<string, unknown> | null { /* JSON.parse try/catch；坏行 null */ }
function ndjson(container: string, lines: number): Array<Record<string, unknown>> { /* composeLogs(container, lines) 逐行 safeJson，滤 null */ }
async function pollUntil<T>(fn: () => T, ok: (v: T) => boolean, timeoutMs: number, intervalMs = 1000): Promise<{ ok: boolean; last: T }> { /* 照 slice-20 :217 形态 */ }
```

- [ ] **Step 1:** `:996-998` 删两行 pickEnv（**`ADMIN_PASSWORD` :998 保留逐字**）；`:999` info 行删两键段。
- [ ] **Step 2:** `:1009` compose 参删 `PAY_SCAN_INTERVAL_MS: scanSaved, PAY_RECONCILE_INTERVAL_MS: reconcileSaved`；`:1013-1014` 两条「随行透传」断言替换为：
```ts
const win2Boot = await pollUntil(
  () => ndjson('payment-service', 600).filter((r) => String(r.msg).includes('first round in 2000ms')).length,
  (n) => n > 0, 30_000);
checks.that(win2Boot.ok, '⑨ 窗口② 重建后启动行 `first round in 2000ms`（config 值不受容器重建影响；连跑 slice-21 ⓪ 的判据对象）');
```
（若按条数对账需保 2 条：再加 1 条 reconcile 行 `interval 2000ms` 同 poll。）
- [ ] **Step 3:** `:1048`/`:1052` 恢复② 同形替换（`:1052` 保「（连跑 slice-21 的前置）」语义）；`:1131` compose 参删两键（**`PAY_CONFIG_ENC_KEY: encKeySaved` 保留**）。
- [ ] **Step 4:** 计数**五处** `34→40`（`:808` step 文案、`:812-816` 硬断言、`:988` step、`:1034` 断言、**slice-23 `:1283`「⑨ 窗口：34 键面完整」硬断言——r1 🟠2 补**）；slice-23 **另四处**（`:27`/`:731`/`:735`/`:1237`）同改；两片头注。
- [ ] **Step 5: 本地跑** slice-22/23 ⇒ 绿；**Step 6: 波末** 全序一次（28 片）⇒ 全绿或红全分类；**Step 7: Commit（逐片两条——r1 ⚪11）**：`test(conformance): slice-22 换源+计数（pickEnv 退役→启动行自证）` → `test(conformance): slice-23 计数四十`

---

### T16 — admin 页：CONFIG_NOTES +6 + 计数六处 + 横幅两变体

**Files:** Modify: `admin/app.js`（`CONFIG_NOTES` :139-346 +6 条（**语义照规格 ⚙️10，措辞可微调**——r1 ⚪13 口径统一）· 计数注记 `:134-137`/`:290`/`:110`/`:124`/`:607`/`:623` · 横幅 `:743`/`:746`）· `admin/index.html`（**`:89` 第三个横幅变体——r1 🟡9 补**）

- [ ] **Step 1:** 六条 NOTES（四段式，语义照规格 ⚙️10；`'生效'` 段统一含「当前一轮按旧值跑完，**下一轮排期起用新值**」）。
- [ ] **Step 2:** 六处「三十四/34」→「四十/40」。
- [ ] **Step 3:** 横幅三处逐字替换（规格 ⚙️10 新文案；`index.html:89` 同句同步）：
```js
// app.js :743 邻：'已保存（版本 N）；各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效）。'
// app.js :746 邻：'推送失败，安全网将在 ≤60s 内拉到新值（节奏类键自下一轮排期起生效）。'
// index.html :89：「保存后各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效；推送失败时经安全网）。」
```
- [ ] **Step 4: 引用核销**（r1 🟡9 白名单订正 + 新-4 时点限定）：`grep -rn "60s 内生效" tools/ docs/ packages/ admin/` ⇒ **终态 = T17 完成后**残余仅「历史案卷（docs/superpowers/** 旧片）+ 本片三件套自身（以旧句引文出现）」；T16 时点 `design.md:1185`/`first-deploy.md:982/:985` 仍含旧句属预期（T17 承接）；判据引用同句则随迁移并登记。
- [ ] **Step 5: Commit**（`feat(admin): 节奏六键注记 + 计数四十 + 横幅文案订正`）

---

### T17 — 文档面 + 注释扫修 + 台账

**Files:**
- Modify: `docs/design.md`（`:1140-1177` 表 +6 行 · `:1179` 消费者段 · `:1180` 十个周期键 · `:1185` 横幅锚述句 · `:1207`/`:1218` 口径 · `:1300` 句 · 计数句择现状改）
- Modify: `docs/ops/first-deploy.md`（`:992-1026` 表 +6 行 · `:982-983`/`:985-986` 横幅句 · 「节奏旋钮怎么调」一句）
- Modify: `docs/client-protocol.md:54`（视句义核改）
- Modify: 注释面 grep 扫全（口径「三十四|34 键」；含 protocol 四文件/config-service 两服务/各测注释——见规格 ⚙️10 清单）
- Modify: `docs/superpowers/plans/deviation-ledger.md`（新条目：六 env 退役 / compose 六行删 / 四片注入语义退役 / RETIRED_ENVS 加列 / slice-22 透传面替换 / 首排动作语义——编号续编，以实文末号为准）

- [ ] **Step 1:** design.md 逐处；**Step 2:** first-deploy 逐处；**Step 3:** 注释面 grep 清单逐处（`slice-14:64` 核销一句）；**Step 4:** ledger 条目；**Step 5: Commit**（`docs(interval-admin): design/first-deploy/注释面/台账（本片 T17）`）

---

### T18 — baselines + 六阶段 + 全序 + 清零核销 + 交接

**Files:** Modify: `tools/conformance/baselines.json`（受改六片实测回填）· Create: `docs/superpowers/plans/2026-10-09-post-interval-admin-handoff.md`

- [ ] **Step 1: baselines 回填**（读全序各片实测条数；下调项=透传面替换净减，提交理由写明）
- [ ] **Step 2: 六阶段** `bash scripts/ci.sh` ⇒ 绿（日志 `.superpowers/sdd/2026-10-09-interval-admin/t18-ci.log`——r1 ⚪15 落点）
- [ ] **Step 3: 全序** 28 片 ⇒ 全绿；若有红：**逐红分类**（环境假红先单跑复证；真红即修）——口径「全绿」或「N 红全分类」，不得含糊。
- [ ] **Step 4: 六 env 清零核销**（规格 ⚙️8.5）：树内 grep 六 env 名 ⇒ 残余仅三类（RETIRED_ENVS 注册点/历史案卷/本片文档）+ 规格清单所列 step/注释点全清；结果贴 `.superpowers/sdd/2026-10-09-interval-admin/t18-env-sweep.log`。
- [ ] **Step 5: 交接文档**（三件套链接/关键数字/上线脉络=纯 tag+deploy 无服务器动作/残余）+ **Commit**（`docs(interval-admin): T18 收口（baselines/六阶段/全序/清零核销/交接）`）

---

## 自检（计划 vs 规格，写后复核）

- **覆盖**：⚙️1(T1) ⚙️2(T1) ⚙️3(T2) ⚙️4(T4) ⚙️5–7(T5–T9) ⚙️8(T10/T11) ⚙️9(T12–T15) ⚙️10(T16/T17) P1–P6=各任务测试步+T18；附录 A 七条=对应任务内落地。
- **无占位**：全部步骤含确切路径/代码/命令；「以实文为准」处均为**判据原则**（心跳行字样、响应 saved 形态）而非空洞。
- **类型一致**：`resolveIntervalMs`/`resolveScanIntervalMs`/`resolveReconcileIntervalMs`/`hasSnapshot`/`SNAPSHOT_BOOT_WAIT_MS`/`config_seed_put` 全计划同名同形。
- **已知登记**：T14 ⓪ 新增重建 ~15s；T13 新小组两重建 ~60s；全序单轮预计 +3~5 分钟（窗口复算已各就位）。

## 修订记录（v1.0 → v1.1；报告 `review-plan-r1.md`，r1 结论 = 有条件通过）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 🔴1 | 阻断 | 命令口径 `npm test -w` 不可运行（本仓 = pnpm 工作区） | Global #8 + 全部使用点改 `pnpm --filter @fight-the-landlord/<pkg> test` |
| 🟠2 | 重要 | slice-23:1283「34 键面」硬断言漏列 | T15 Files + Step 4 补第五处 |
| 🟠3 | 重要 | T14 假定的片内 helper 不存在 + `adminToken` 作用域接不到 | T14 增 Step 0（补 `ndjson`/`pollUntil`）+ helper 显式接 token 参数 + 重建走片内内联形态 |
| 🟠4 | 重要 | T15 同族（slice-22 无 ndjson/pollUntil） | T15 增 Step 0（复用 `composeLogs` + 三小函数） |
| 🟠5 | 重要 | payment `test/config-cache.test.ts` 不存在 | T4 Files 改 Create（照 user/currency 同构） |
| 🟠6 | 重要 | T8/T9 构造点清单不全（lint 必红） | T8 补 reconcile.test:126-127 / reconcile-admin:85-86,163,347；T9 补 scan.test:262 / reconcile.test:296 / orders-state:1001 / notify:311 |
| 🟡7 | 次要 | 六 env 残留点未入任务 Files | T12 补 slice-17:1042；T13 补 slice-20:11/28/42；T14 补 slice-21:1101 |
| 🟡8 | 次要 | T12 缺 slice-18 90s 窗复算 | T12 Step 3 补复算结论（数字不改） |
| 🟡9 | 次要 | T16 漏 `admin/index.html:89`；Step 4 判据不可达 | T16 Files/Step 3/Step 4 白名单订正 |
| 🟡10 | 次要 | T5 引 `:711` 串档 | 改 records `:213-228` + 注明 payment 侧属 T9 |
| ⚪11 | 观察 | 多片合并提交粒度粗 | T12/T15 改逐片多条 commit |
| ⚪12 | 观察 | T1 `INTERVAL_KEYS` 类型自相矛盾 | 统一「模块私有 `Partial<Record<ConfigKey, number>>`」 |
| ⚪13 | 观察 | T16「逐字」与规格「可微调」张力 | 统一「语义照 ⚙️10（措辞可微调）」 |
| ⚪14 | 观察 | T2 缺时间戳单调/唯一测试 | T2 Step 1 补 `⑭″` 一行测试 |
| ⚪15 | 观察 | T18 台账落点未定 | 落点 = `.superpowers/sdd/2026-10-09-interval-admin/t18-*.log` |

### v1.1 → v1.2（r2「可通过（计划可执行）」；r2 新增 5 条精修随冻结版落定）

| # | 发现（r2 新-1..新-5） | 处置 |
|---|---|---|
| 新-1 | `composeWithRecreate` 被调用但未列交付项、二选一未钉死 | T14 Step 0 列为三件交付之一（「抽成小函数」钉死） |
| 新-2 | GET 确认片段恒 false 空转 + 未用变量（`noUnusedLocals` 编译不过） | 改实值比较形态（`gotValue !== paymentMs` 抛出）+ 显式「勿照抄」注 |
| 新-3 | `ndjson` 注释与 slice-20 形态相抵（`--tail N` vs `--since`） | 改 `--since` 秒窗语义（调用点 600/1200 即秒） |
| 新-4 | T16 Step 4 白名单未计 T17 待改点 | 加「终态 = T17 完成后」限定 |
| 新-5 | T15「另三处」实列四个号 | 改「另四处」 |

### v1.2 → v1.2.1（W1-I1 同步；报告 `review-wave1.md`）

- v1.2.1：T1 派发形态随规格 v1.3 同步（I1）。
