# 记牌器开关 + 左上角浮层 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复记牌器累积器跨页失效的 bug，新增后台配置开关 `game.cardCounterEnabled`，并把客户端展示改为牌桌左上角的横向记牌条。

**Architecture:** 沿用现有「platform_config → GET /api/config → 客户端 store 门控」的配置链路；客户端把 `CardCounter.vue` 从居中弹窗重写为锚定横条，入口移到顶栏左侧；累积器改用 detached effect scope 并读取开关。

**Tech Stack:** TypeScript / Vue 3 / Pinia / NestJS / TypeORM / Vitest / Vue Test Utils

## Global Constraints

- 所有新增配置键必须同时更新 protocol 键清单、config-service 组装、admin IA/文档、静态校验计数。
- 配置写入严格 boolean：字符串 `'true'` 不算。
- 客户端 fail-safe：`cardCounterEnabled` 初值 `false`，未知 = 不渲染。
- 不做收费/购买/扣货币（另立片）。
- 不动 `PlayerView`、不动 `recentActions` 窗口、不做服务端强制门控。
- 每个任务结束必须跑对应测试并提交（提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）。

---

### Task 1: protocol 配置键

**Files:**
- Modify: `packages/protocol/src/config.ts`
- Test: `packages/protocol/src/config.test.ts`

**Interfaces:**
- Produces: `ConfigKey` 含 `'game.cardCounterEnabled'`；`ClientConfig.cardCounterEnabled: boolean`；`CLIENT_CONFIG_KEYS` 含 `'cardCounterEnabled'`。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 的 `CONFIG_KEYS` 精确数组末尾加入 `'game.cardCounterEnabled'`，在 `CLIENT_CONFIG_KEYS` 数组的 `'version'` 前加入 `'cardCounterEnabled'`，并新增：

```ts
it('第 50 键 game.cardCounterEnabled：严格 boolean（拒字符串/数字）', () => {
  expect(parseConfigValue('game.cardCounterEnabled', true)).toBe(true);
  expect(parseConfigValue('game.cardCounterEnabled', false)).toBe(false);
  expect(() => parseConfigValue('game.cardCounterEnabled', 'true')).toThrow(/boolean/);
  expect(() => parseConfigValue('game.cardCounterEnabled', 1)).toThrow(/boolean/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/protocol exec vitest run src/config.test.ts`
Expected: FAIL（`CONFIG_KEYS` 少一键 / `parseConfigValue` 抛「未知配置键」）

- [ ] **Step 3: 实现**

`CONFIG_KEYS` 末尾（`risk.deviceBindingEnabled` 之后）追加：

```ts
  /** 记牌器片（第 50 键）：斗地主牌桌记牌器总开关（严格 boolean、种子 true —— 保持现状；
   *  客户端可见——裸名 `cardCounterEnabled`）。关 ⇒ 客户端入口不渲染、累积器不启动。 */
  'game.cardCounterEnabled',
```

`parseConfigValue` 在 `game.baseScoreLevels` 分支旁加入：

```ts
  if (key === 'game.cardCounterEnabled') return parseStrictBoolean(key, value);
```

`CLIENT_CONFIG_KEYS` 在 `'version'` 之前加入：

```ts
  /** 记牌器片：记牌器总开关（裸名下发；客户端据此渲染左上角入口）。 */
  'cardCounterEnabled',
```

`ClientConfig` 在 `version` 之前加入：

```ts
  /** 记牌器片（第 50 键裸名）：牌桌左上角记牌器入口/横条的门控位。 */
  cardCounterEnabled: boolean;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/protocol exec vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts
git commit -m "feat(protocol): 新增 game.cardCounterEnabled 配置键

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: config-service 下发与测试夹具

**Files:**
- Modify: `packages/config-service/src/config/client-config.controller.ts`
- Modify: `packages/config-service/test/helpers/config-probe.ts`
- Modify: `packages/config-service/test/platform-config.service.test.ts`
- Modify: `packages/config-service/test/client-config.test.ts`
- Modify: `packages/config-service/test/admin.controller.test.ts`
- Modify: `packages/config-service/test/config.rpc.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CLIENT_CONFIG_KEYS` / `ClientConfig`。
- Produces: `GET /api/config` 的 `cardCounterEnabled` 字段（缺行默认 `true`）。

- [ ] **Step 1: 写失败测试**

`test/helpers/config-probe.ts` 的 `SEED` 数组末尾加：

```ts
  // 记牌器片（第 50 键；来自 `1795700000000-CardCounterSeed.ts`，true = 保持现状）
  ['game.cardCounterEnabled', true],
```

`test/platform-config.service.test.ts` 的 `SEED` 数组末尾加同一行。

`test/client-config.test.ts`：
- 精确键数组加入 `'cardCounterEnabled'`（`'version'` 前）。
- 值断言加入 `expect(body.data.cardCounterEnabled).toBe(true);`
- 新增缺行默认用例：

```ts
it('缺行兜底：game.cardCounterEnabled 行缺失 ⇒ 仍下发 true（与种子一致）', async () => {
  const { svc, db } = makeService(seedDb());
  db.rows.delete('game.cardCounterEnabled');
  const probe = await startHttpProbe(svc);
  try {
    const { body } = await probe.get('/api/config');
    expect(body.data.cardCounterEnabled).toBe(true);
  } finally {
    await probe.close();
  }
});
```

`test/admin.controller.test.ts` 与 `test/config.rpc.test.ts` 的精确排序键清单在 `'game.baseScoreLevels'` 后加入 `'game.cardCounterEnabled'`（排序：`baseScoreLevels` < `cardCounterEnabled`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/config-service exec vitest run test/client-config.test.ts test/platform-config.service.test.ts`
Expected: FAIL（子集少键 / 值 undefined）

- [ ] **Step 3: 实现**

`client-config.controller.ts` 的返回对象在 `goldRoomEnabled` 之后加入：

```ts
        // 记牌器片（第 50 键）：缺行默认 true（与种子一致：保持现状）。
        cardCounterEnabled: (byKey.get('game.cardCounterEnabled') ?? true) as boolean,
```

同步文件头注释：子集由十七键改为十八键，并列出 `cardCounterEnabled`；「响应恒十七键」改为「恒十八键」。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/config-service exec vitest run test/client-config.test.ts test/platform-config.service.test.ts test/admin.controller.test.ts test/config.rpc.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/config-service/src/config/client-config.controller.ts packages/config-service/test
git commit -m "feat(config-service): GET /api/config 下发 cardCounterEnabled

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 配置种子迁移

**Files:**
- Create: `packages/config-service/src/migrations/1795700000000-CardCounterSeed.ts`
- Test: `packages/config-service/test/migration.test.ts`

**Interfaces:**
- Produces: `CardCounterSeed1795700000000`，up 种下 `game.cardCounterEnabled = true`，down 删除。

- [ ] **Step 1: 写失败测试**

`migration.test.ts` 导入新类，并追加（照设备绑定块的形状）：

```ts
describe('CardCounterSeed1795700000000：第 50 键种子迁移（严格 boolean true —— 保持现状）', () => {
  it('up()：恰一条 INSERT、单 VALUE、json true、version=1、updated_by=seed', async () => {
    const statements: string[] = [];
    await new CardCounterSeed1795700000000().up(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));
    expect(sql).toContain(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES',
    );
    expect(sql).toContain("('game.cardCounterEnabled', 'true', 1, NOW(3), 'seed')");
    expect(sql.match(/INSERT INTO `platform_config`/g)).toHaveLength(1);
    expect(sql.match(/\('game\.[A-Za-z.]+',/g)).toHaveLength(1);
    expect(sql.match(/NOW\(3\), 'seed'\)/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('down()：删该行，单键精确匹配', async () => {
    const statements: string[] = [];
    await new CardCounterSeed1795700000000().down(fakeRunner(statements));
    const sql = flatten(statements.join('\n'));
    expect(sql).toContain("DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterEnabled'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it('形状与时间戳：晚于 RiskDeviceBindingSeed 且全仓唯一', () => {
    const migration = new CardCounterSeed1795700000000();
    expect(migration.name).toBe('CardCounterSeed1795700000000');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
    const ts = (m: { name: string }) => Number(m.name.match(/\d+$/)?.[0]);
    expect(ts(migration)).toBeGreaterThan(ts(new RiskDeviceBindingSeed1795600000000()));
    const hits: string[] = [];
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const dir = join(packagesDir, pkg, 'src', 'migrations');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(/export class (\w+)/g)) {
          if (m[1]!.includes('1795700000000')) hits.push(`${pkg}/${m[1]}`);
        }
      }
    }
    expect(hits).toEqual(['config-service/CardCounterSeed1795700000000']);
  });
});
```

同时把文件头注释追加一段「记牌器片起第 50 键由 ... 种下」。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C packages/config-service exec vitest run test/migration.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现迁移**

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 记牌器片：第 **50** 键 `game.cardCounterEnabled` 的种子迁移——
 * 斗地主牌桌记牌器总开关，严格 boolean，种子 **true**（保持现状）；
 * 管理后台置 false ⇒ 客户端入口不渲染、累积器不启动。
 */
export class CardCounterSeed1795700000000 implements MigrationInterface {
  name = 'CardCounterSeed1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('game.cardCounterEnabled', 'true', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterEnabled'");
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C packages/config-service exec vitest run test/migration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/config-service/src/migrations/1795700000000-CardCounterSeed.ts packages/config-service/test/migration.test.ts
git commit -m "feat(config-service): 种下记牌器开关 game.cardCounterEnabled

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 管理后台开关

**Files:**
- Modify: `admin/app.js`
- Modify: `scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes: Task 1 的键名。
- Produces: 斗地主域「对局辅助」页签、布尔控件、说明文档；静态校验计数 50/45/17。

- [ ] **Step 1: 写失败测试（静态校验先红）**

`scripts/verify-admin-static.mjs` 中先把计数闸改成新目标：
- `protoSet.size === 49` → `=== 50`，文案同步；
- `iaKeySet.size === 49` → `=== 50`；
- `entries.size === 44` → `=== 45`；
- `BOOL_KEYS` 数组加入 `'game.cardCounterEnabled'`（16→17）；
- 分类合计 `16+1+27=44` → `17+1+27=45`。

Run: `pnpm verify:admin`
Expected: FAIL（admin/app.js 还没有新键）

- [ ] **Step 2: 实现 admin/app.js**

`CONFIG_NOTES` 在 `'game.baseScoreLevels'` 之后加入：

```js
  'game.cardCounterEnabled': [
    ['作用', '记牌器总开关（客户端）。开 ⇒ 牌桌左上角显示记牌器入口与横条；关 ⇒ 入口不渲染、记牌累积器不启动。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 保持现状）。'],
    ['生效', '保存后玩家端下次进大厅取到新值；已打开的牌桌不热更新。'],
    ['注意', '客户端软门控：旧版客户端不认识该键，仍会显示记牌器；收费/购买不在本键范围（另立片）。'],
  ],
```

`CONFIG_IA` 的斗地主 tabs 在 `rules` 之后加入：

```js
          { id: 'assist', name: '对局辅助', keys: ['game.cardCounterEnabled'] },
```

`CONFIG_CONTROLS` 加入：

```js
  'game.cardCounterEnabled': { label: '记牌器', type: 'bool' },
```

同步 app.js 顶部与 IA 附近的计数注释：49→50、44→45、16→17。

- [ ] **Step 3: 运行静态校验确认通过**

Run: `pnpm verify:admin`
Expected: PASS（无失败行）

- [ ] **Step 4: 提交**

```bash
git add admin/app.js scripts/verify-admin-static.mjs
git commit -m "feat(admin): 斗地主对局辅助页签新增记牌器开关

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 客户端配置字段与门控

**Files:**
- Modify: `apps/client/src/stores/game.ts`
- Modify: `apps/client/src/pages/lobby/lobby.vue`
- Test: `apps/client/test/card-counter-gate.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `ClientConfig.cardCounterEnabled`。
- Produces: `useGameStore().cardCounterEnabled: boolean`（初值 false）；大厅配置归一化写入。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/card-counter-gate.test.ts`：

```ts
/**
 * 记牌器开关的 fail-safe 门控（与 friend-room-gate 同族）：
 * 初值 false；配置成功且 true ⇒ true；拉取失败 / 缺键 ⇒ false。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

function stubConfig(config: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(url.includes('/config') ? config : { code: 0, data: [] }),
    })),
  );
}

function mountLobby(): VueWrapper {
  startGameSession(() => new FakeSocket());
  useAuthStore().navigate('lobby');
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

const baseConfig = {
  baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
  friendRoomEnabled: false,
  freeRoomEnabled: true,
  goldRoomEnabled: true,
  reliefEnabled: false,
  entryFeePercents: [],
  entryMultiplier: 10,
  rechargeEnabled: false,
  withdrawEnabled: false,
  coinPerYuan: 100,
  rechargePackages: [],
  withdrawMinCoins: 1000,
  withdrawMaxCoinsPerOrder: 50000,
  withdrawDailyMaxCoins: 100000,
  withdrawReAuthEnabled: false,
  reliefAdpid: '',
  version: 5,
};

describe('记牌器开关 fail-safe 门控', () => {
  it('① 初值 = false（未知 = 不渲染）', () => {
    expect(useGameStore().cardCounterEnabled).toBe(false);
  });

  it('② 配置成功且 true ⇒ store = true', async () => {
    stubConfig({ code: 0, data: { ...baseConfig, cardCounterEnabled: true } });
    mountLobby();
    await flushPromises();
    expect(useGameStore().cardCounterEnabled).toBe(true);
  });

  it('③ 配置成功且 false ⇒ store = false', async () => {
    stubConfig({ code: 0, data: { ...baseConfig, cardCounterEnabled: false } });
    mountLobby();
    await flushPromises();
    expect(useGameStore().cardCounterEnabled).toBe(false);
  });

  it('④ 缺键（旧版服务端）⇒ false', async () => {
    stubConfig({ code: 0, data: baseConfig });
    mountLobby();
    await flushPromises();
    expect(useGameStore().cardCounterEnabled).toBe(false);
  });

  it('⑤ 拉取失败 ⇒ 保持 false', async () => {
    stubConfig({ code: 10007, message: '下游不可用', data: null });
    const store = useGameStore();
    store.cardCounterEnabled = true; // 先置 true，证明失败分支会写回 false
    mountLobby();
    await flushPromises();
    expect(store.cardCounterEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/client exec vitest run test/card-counter-gate.test.ts`
Expected: FAIL（store 无该字段 / 归一化未写）

- [ ] **Step 3: 实现**

`stores/game.ts` 在 `reliefEnabled` 之后加入 state：

```ts
    /**
     * 记牌器开关（记牌器片第 50 键 `game.cardCounterEnabled` 的裸名下发）——
     * 牌桌左上角入口与横条的门控位。
     *
     * 🔴 初值/fail-safe = `false`（未知 = 不渲染，C19 同族）；成功响应缺键 ⇒ 按 `false`
     * （旧版服务端没有该能力 = 不开放）。
     */
    cardCounterEnabled: false,
```

`setClientConfig()` 加入：

```ts
      this.cardCounterEnabled = cfg.cardCounterEnabled === true;
```

`lobby.vue` 的 `FAILSAFE_CLIENT_CONFIG` 加入 `cardCounterEnabled: false,`；`normalizeClientConfig()` 加入：

```ts
    cardCounterEnabled: raw?.cardCounterEnabled === true,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C apps/client exec vitest run test/card-counter-gate.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/stores/game.ts apps/client/src/pages/lobby/lobby.vue apps/client/test/card-counter-gate.test.ts
git commit -m "feat(client): 接入记牌器配置开关（fail-safe 默认关）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 累积器生命周期修复 + 开关闸

**Files:**
- Modify: `apps/client/src/composables/usePlayedCards.ts`
- Test: `apps/client/test/card-counter.test.ts`（A/B 组）

**Interfaces:**
- Consumes: Task 5 的 `store.cardCounterEnabled`。
- Produces: 跨页面存活的单例；`__resetPlayedCardsForTest()` 会停止 detached scope。

- [ ] **Step 1: 写失败测试**

在 `card-counter.test.ts` 的 `usePlayedCards` 组补充（并给现有用例显式打开开关）：

```ts
it('牌桌卸载 → 换房重进：累积器仍工作（detached scope 回归）', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.cardCounterEnabled = true;
  store.setRoom('R1', 0);

  const w1 = mount(TablePage, { global: { plugins: [pinia] } });
  socket.push(serverMessage('game.deal', playerViewFixture({
    roomCode: 'R1', state: 'playing', seat: 0, hand: makeCards(3),
    recentActions: [{ seat: 1, cards: makeCards(5) }],
  }), 1));
  await flushPromises();
  const tracker = usePlayedCards();
  expect(tracker.has({ r: 5, s: 0 })).toBe(true);

  w1.unmount();
  store.setRoom('R2', 0);
  const w2 = mount(TablePage, { global: { plugins: [pinia] } });
  socket.push(serverMessage('game.deal', playerViewFixture({
    roomCode: 'R2', version: 2, state: 'playing', seat: 0, hand: makeCards(3),
    recentActions: [{ seat: 2, cards: makeCards(7) }],
  }), 2));
  await flushPromises();

  expect(tracker.has({ r: 5, s: 0 }), '换房后旧牌应清空').toBe(false);
  expect(tracker.has({ r: 7, s: 0 }), '重进后新牌仍应记录').toBe(true);
  w2.unmount();
  stopGameSession();
});

it('开关关闭 ⇒ 不累积；从开切到关 ⇒ 清空', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useGameStore();
  store.cardCounterEnabled = false;
  store.setRoom('R1', 0);
  store.applySnapshot(playerViewFixture({
    state: 'playing',
    recentActions: [{ seat: 1, cards: makeCards(5) }],
  }));
  const tracker = usePlayedCards();
  await flushPromises();
  expect(tracker.size, '关闭时不累积').toBe(0);

  store.cardCounterEnabled = true;
  await flushPromises();
  expect(tracker.size, '打开后开始累积').toBe(1);

  store.cardCounterEnabled = false;
  await flushPromises();
  expect(tracker.size, '切到关 ⇒ 清空').toBe(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/client exec vitest run test/card-counter.test.ts`
Expected: FAIL（卸载后新牌不入集 / 开关不生效）

- [ ] **Step 3: 实现**

`usePlayedCards.ts`：

```ts
import { effectScope, ref, watchEffect } from "vue";
```

在 `usePlayedCards()` 内，把原 `watchEffect(...)` 包进 detached scope：

```ts
  const scope = effectScope(true);
  scope.run(() => {
    watchEffect(
      () => {
        // 记牌器片：开关关闭 ⇒ 清空并跳过累积（旧页面留下的单例同样受控）。
        if (!store.cardCounterEnabled) {
          if (played.size > 0) {
            played.clear();
            bump();
          }
          return;
        }
        const code = store.roomCode;
        if (code !== lastRoomCode) {
          lastRoomCode = code;
          if (played.size > 0) {
            played.clear();
            bump();
          }
        }
        const actions = store.recentActions;
        let changed = false;
        for (const a of actions) {
          if (!a.cards) continue;
          for (const c of a.cards) {
            const k = keyOf(c);
            if (!played.has(k)) {
              played.add(k);
              changed = true;
            }
          }
        }
        if (changed) bump();
      },
      { flush: "sync" },
    );
  });
```

模块级加入 `let disposeTracker: (() => void) | null = null;`，创建后赋值 `disposeTracker = () => scope.stop();`，测试复位改为：

```ts
export function __resetPlayedCardsForTest(): void {
  disposeTracker?.();
  disposeTracker = null;
  singleton = null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C apps/client exec vitest run test/card-counter.test.ts`
Expected: PASS（UI 组若仍走旧入口会在 Task 7 一并迁移；本步至少 A/B 组全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/composables/usePlayedCards.ts apps/client/test/card-counter.test.ts
git commit -m "fix(client): 记牌器累积器跨页存活并受开关门控

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 左上角横条 UI + 移除更多菜单入口

**Files:**
- Rewrite: `apps/client/src/components/CardCounter.vue`
- Modify: `apps/client/src/components/MoreMenu.vue`
- Modify: `apps/client/src/pages/table/table.vue`
- Test: `apps/client/test/card-counter.test.ts`（C 组重写）
- Test: `apps/client/test/more-menu.test.ts`（4→3）

**Interfaces:**
- Consumes: Task 5 的 `store.cardCounterEnabled`、Task 6 的 tracker。
- Produces: `.table__counter` 按钮、`.counter` 横条、15 列 `.counter__col`；MoreMenu 无记牌器。

- [ ] **Step 1: 重写 UI 测试（先红）**

`card-counter.test.ts` 的 C 组改为：

```ts
describe('CardCounter.vue（左上角横条）', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    __resetPlayedCardsForTest();
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  function mountTable(mySeat = 0, enabled = true) {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const store = useGameStore();
    store.cardCounterEnabled = enabled;
    store.setRoom('ROOM1', mySeat);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    return { wrapper, socket, store };
  }

  afterEach(() => stopGameSession());

  it('开关开：入口在顶栏左侧；点开 15 列倒序横条，剩余值/绝牌正确', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(serverMessage('game.deal', playerViewFixture({
      state: 'playing', seat: 0, version: 1,
      hand: makeCards(30),
      recentActions: [{ seat: 1, cards: makeCards(3, 3, 3, 3) }],
    }), 1));
    await flushPromises();

    const btn = wrapper.find('.table__bar-left .table__counter');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe('记牌器');
    await btn.trigger('click');

    const cols = wrapper.findAll('.counter__col');
    expect(cols).toHaveLength(15);
    expect(cols.map((c) => c.find('.counter__rank').text())).toEqual([
      '大王', '小王', '2', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3',
    ]);
    const col3 = cols[14]!;
    expect(col3.find('.counter__remain').text()).toBe('0');
    expect(col3.classes()).toContain('counter__col--gone');
    const colJoker = cols[0]!;
    expect(colJoker.find('.counter__remain').text()).toBe('0');
    expect(colJoker.classes(), '大王在我手里 ⇒ 非绝牌').not.toContain('counter__col--gone');

    await btn.trigger('click');
    expect(wrapper.find('.counter').exists()).toBe(false);
  });

  it('开关关：入口与横条都不在 DOM', async () => {
    const { wrapper } = mountTable(0, false);
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    expect(wrapper.find('.counter').exists()).toBe(false);
  });

  it('结算到达 ⇒ 横条让位', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(serverMessage('game.state_update', playerViewFixture({ state: 'playing', version: 2 }), 2));
    await wrapper.vm.$nextTick();
    await wrapper.find('.table__counter').trigger('click');
    expect(wrapper.find('.counter').exists()).toBe(true);

    const settlement = {
      roomCode: 'ROOM01', baseScore: 100, winner: 'landlord' as const,
      landlordSeat: 2, farmerSeats: [0, 1], multiplier: 4, spring: 'spring' as const,
      landlordScoreChange: 777, farmerScoreChange: -388.5,
    };
    socket.push(serverMessage('game.settlement', settlement, 3));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.counter').exists()).toBe(false);
  });
});
```

（结算夹具复用 `more-menu.test.ts` 的 `SETTLEMENT_FIXTURE`；若直接赋 store 不触发校验，也可 push `game.settlement`。）

`more-menu.test.ts`：
- `ART_LABELS` 改为 `['背包', '托管', '设置']`。
- 所有 `toHaveLength(4)` 改 `toHaveLength(3)`。
- 删除记牌器翻活断言；测试名「四个入口」改「三个入口」。
- 顶部/内联注释同步：记牌器入口已移到顶栏左侧。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/client exec vitest run test/card-counter.test.ts test/more-menu.test.ts`
Expected: FAIL（`.table__counter` 不存在；更多菜单仍有 4 个按钮）

- [ ] **Step 3: 实现 CardCounter.vue（整文件替换）**

```vue
<script setup lang="ts">
/**
 * 记牌器横条（记牌器片）：牌桌左上角、顶栏正下方的 15 列浅色横条。
 *
 * 显示语义（照欢乐斗地主）：从大到小 大王、小王、2、A…3；每列只显示
 * 「点数 + 外面剩余张数」；绝牌（剩余 0 且我手里没有）红色高亮。
 * 剩余 = 总数 − 我手牌 − 已打出；底牌不减（它在地主手里，属于「外面」）。
 */
import { computed } from "vue";
import { toDisplay } from "@fight-the-landlord/protocol";
import { useGameStore } from "../stores/game";
import {
  usePlayedCards,
  computeRemaining,
  countByRank,
} from "../composables/usePlayedCards";

/** 展示顺序：参考欢乐斗地主，从大到小。 */
const DISPLAY_RANK_ORDER: readonly number[] = [
  30, 20, 17, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
];

const store = useGameStore();
const tracker = usePlayedCards();

const columns = computed(() => {
  void tracker.size;
  const hand = store.hand;
  const handCounts = countByRank(hand);
  const remaining = computeRemaining(hand, tracker.played);
  return DISPLAY_RANK_ORDER.map((r) => {
    const inHand = handCounts.get(r) ?? 0;
    const remain = remaining.get(r) ?? 0;
    return {
      rank: r,
      label: toDisplay(r),
      remain,
      gone: remain === 0 && inHand === 0,
    };
  });
});
</script>

<template>
  <view class="counter" role="region" aria-label="记牌器">
    <view
      v-for="col in columns"
      :key="col.rank"
      class="counter__col"
      :class="{ 'counter__col--gone': col.gone }"
    >
      <text class="counter__rank">{{ col.label }}</text>
      <text class="counter__remain">{{ col.remain }}</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.counter {
  position: absolute;
  top: calc(#{$ftl-bar-h} + #{$ftl-space-3});
  left: $ftl-space-5;
  z-index: 5;
  display: flex;
  gap: $ftl-space-3;
  padding: $ftl-space-3 $ftl-space-4;
  border: $ftl-hairline solid rgba($ftl-color-night-deep, 0.28);
  border-radius: $ftl-radius-md;
  background: rgba(255, 249, 234, 0.95);
  box-shadow: 0 4px 12px rgba($ftl-color-night-deep, 0.25);
}
.counter__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
  min-width: 40px;
}
.counter__rank {
  color: rgba($ftl-color-night-deep, 0.72);
  font-size: $ftl-font-xs;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.counter__remain {
  color: $ftl-color-night-deep;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1;
}
.counter__col--gone .counter__rank,
.counter__col--gone .counter__remain {
  color: $ftl-color-danger-on-dark;
}
</style>
```

- [ ] **Step 4: 实现 table.vue + MoreMenu.vue**

`table.vue` 顶栏左段「返回大厅」后加入：

```vue
          <button
            v-if="store.cardCounterEnabled"
            type="button"
            class="btn btn--small table__counter"
            :aria-expanded="counterOpen"
            @click="counterOpen = !counterOpen"
          >
            记牌器
          </button>
```

删除 `onOpenCounter()` 函数与相关注释；`counterOpen` 注释改为「左上角横条开合（入口在顶栏左侧）」。模板底部：

```vue
      <CardCounter v-if="counterOpen && !store.settlement" />
```

`MoreMenu.vue`：删除 `(e: "counter"): void;`、记牌器按钮与相关注释；网格剩背包/托管/设置。

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `pnpm -C apps/client exec vitest run test/card-counter.test.ts test/card-counter-gate.test.ts test/more-menu.test.ts`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: 0 errors

- [ ] **Step 6: 全量回归**

Run: `pnpm -C apps/client test`
Expected: 全部 PASS（除既有的 skip）

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/components/CardCounter.vue apps/client/src/components/MoreMenu.vue apps/client/src/pages/table/table.vue apps/client/test/card-counter.test.ts apps/client/test/more-menu.test.ts
git commit -m "feat(client): 记牌器改为左上角横条，更多菜单移除入口

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证

- [ ] `pnpm -C packages/protocol test`
- [ ] `pnpm -C packages/config-service test`
- [ ] `pnpm verify:admin`
- [ ] `pnpm -C apps/client test`
- [ ] `pnpm -C apps/client run lint`
- [ ] `git status --short`（确认无未提交改动）
