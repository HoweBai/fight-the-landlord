# 玩法开放开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理面每个玩法设置页顶部一个「开放该玩法」开关；斗地主新增真实服务端开关 `game.doudizhu.enabled`。

**Architecture:** 新配置键经 protocol → config-service（迁移 + `/api/config` 折叠）→ room-service（`gameEnabled` 闸 + 关闭时暂停匹配扫描）→ 客户端大厅门控；管理面用 `CONFIG_IA.headerKeys` 渲染顶部卡，原生 `confirm()` 二次确认。

**Tech Stack:** TypeScript/NestJS、uni-app Vue3、零构建 admin（vanilla JS）、conformance 真栈、TypeORM 迁移。

## Global Constraints

- spec：`docs/superpowers/specs/2026-10-24-game-mode-enabled-switch-design.md`（已过对抗审查）
- 关闭语义：只拦新匹配/新建房（12012）；进行中对局、已有房间、已入队票不受影响；关闭时匹配扫描暂停（D11）
- 键缺失默认：斗地主 `true`、跑得快 `false`
- 每个改动一个 commit；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 所有测试先红后绿；交付前 `bash scripts/ci.sh` 七阶段全绿

---

### Task 1: protocol 键与校验

**Files:**
- Modify: `packages/protocol/src/config.ts`（`CONFIG_KEYS` 末尾、`parseConfigValue`、头注释）
- Test: `packages/protocol/src/config.test.ts`

**Interfaces:**
- Produces: `ConfigKey` 含 `'game.doudizhu.enabled'`；`parseConfigValue` 对该键严格 boolean。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 的两处逐字键数组（约 :56 与 :467）末尾追加 `'game.doudizhu.enabled'`，并加：

```ts
it('game.doudizhu.enabled：严格 boolean', () => {
  expect(parseConfigValue('game.doudizhu.enabled', true)).toBe(true);
  expect(parseConfigValue('game.doudizhu.enabled', false)).toBe(false);
  for (const bad of [1, 'true', null, undefined]) {
    expect(() => parseConfigValue('game.doudizhu.enabled', bad)).toThrow();
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/protocol test`
Expected: FAIL（键不存在/数组不等）

- [ ] **Step 3: 实现**

`CONFIG_KEYS` 末尾加：

```ts
/** 玩法开放开关（第 66 键）：斗地主总开关（严格 boolean、种子 true——保持现状；
 *  客户端不可见——折叠进 `games.doudizhu.enabled`）。关 ⇒ 新匹配/新建房 12012。 */
'game.doudizhu.enabled',
```

`parseConfigValue()` 加：`if (key === 'game.doudizhu.enabled') return parseStrictBoolean(key, value);`
头注释「五十一键」→「六十六键」。

- [ ] **Step 4: 跑绿并提交**

Run: `pnpm --filter @fight-the-landlord/protocol test`
Expected: PASS

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts
git commit -m "feat(protocol): 新增 game.doudizhu.enabled 配置键"
```

---

### Task 2: config-service 迁移 + 客户端配置 + 键集夹具

**Files:**
- Create: `packages/config-service/src/migrations/1796500000000-DdzEnabledSeed.ts`
- Modify: `packages/config-service/src/config/client-config.controller.ts`
- Test/Modify: `packages/config-service/test/{migration,client-config,platform-config.service,admin.controller,config.rpc}.test.ts`、`test/helpers/config-probe.ts`

**Interfaces:**
- Consumes: Task 1 的键与校验
- Produces: 库中种子 `true`；`/api/config.data.games.doudizhu.enabled`。

- [ ] **Step 1: 写失败测试**

- `migration.test.ts`：在多种子键清单加 `'game.doudizhu.enabled'`，并断言迁移后值 `true`、version `1`。
- `client-config.test.ts`：两条用例——
  - `db.rows.set('game.doudizhu.enabled', { value: false, version: 2, updatedAt: 'admin', updatedBy: 'admin' })` ⇒ `data.games.doudizhu.enabled === false`；
  - 缺行 ⇒ `true`（独立用例，不复用 SEED）。
- `platform-config.service.test.ts`：SEED 加键；`toHaveLength(65)` → `66`；注释同步。
- `admin.controller.test.ts`、`config.rpc.test.ts`：逐字键清单追加 `game.doudizhu.enabled`。
- `helpers/config-probe.ts`：SEED 加 `['game.doudizhu.enabled', true]`。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/config-service test`
Expected: FAIL（迁移缺键/夹具 65）

- [ ] **Step 3: 实现迁移**

`1796500000000-DdzEnabledSeed.ts`：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DdzEnabledSeed1796500000000 implements MigrationInterface {
  name = 'DdzEnabledSeed1796500000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      "INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) " +
        "VALUES ('game.doudizhu.enabled', 'true', 1, NOW(3), 'seed')",
    );
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query("DELETE FROM `platform_config` WHERE `key` = 'game.doudizhu.enabled'");
  }
}
```

- [ ] **Step 4: 实现配置组装**

`client-config.controller.ts` 在 pdk 两行旁加：

```ts
const ddzEnabled = (byKey.get('game.doudizhu.enabled') ?? true) as boolean;
// games.doudizhu 里：
enabled: ddzEnabled,
```

- [ ] **Step 5: 跑绿并提交**

Run: `pnpm --filter @fight-the-landlord/config-service test`
Expected: PASS

```bash
git add packages/config-service/src/migrations/1796500000000-DdzEnabledSeed.ts \
  packages/config-service/src/config/client-config.controller.ts packages/config-service/test
git commit -m "feat(config): 斗地主总开关种子与客户端配置下发"
```

---

### Task 3: room-service 闸 + 关闭时暂停匹配

**Files:**
- Modify: `packages/room-service/src/config/config-cache.service.ts`
- Modify: `packages/room-service/src/match/match.service.ts`（`processQueue` 开头）
- Modify: `packages/room-service/test/helpers/config-cache.stub.ts`
- Test: `packages/room-service/test/config-cache.test.ts`、`match-switch-game.test.ts`（或同族）

**Interfaces:**
- Consumes: Task 1/2
- Produces: `doudizhuEnabled(): boolean`；`gameEnabled()` 两玩法分派。

- [ ] **Step 1: 写失败测试**

`config-cache.test.ts` 加三例：缺键 ⇒ `doudizhuEnabled()===true`；显式 false ⇒ false；显式 true ⇒ true。
匹配测试：`gameEnabled.mockReturnValue(false)` 时 `processQueue` 不调用 `createGameRoom`、不抛错、票仍在；
重开后可成组（沿用现有 match 测试夹具）。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: FAIL

- [ ] **Step 3: 实现**

`config-cache.service.ts`：

```ts
doudizhuEnabled(): boolean {
  const value = this.snapshot?.['game.doudizhu.enabled']?.value;
  return typeof value === 'boolean' ? value : true;
}

gameEnabled(gameType: GameType): boolean {
  switch (gameType) {
    case 'doudizhu': return this.doudizhuEnabled();
    case 'paodekuai': return this.paodekuaiEnabled();
    default: { const exhaustive: never = gameType; return exhaustive; }
  }
}
```

`match.service.ts` 的 `processQueue` 开头（取到 `queue` 后、任何匹配逻辑前）：

```ts
if (!this.configCache.gameEnabled(queue.gameType)) return; // 关闭的玩法：暂停匹配，票保留（D11）
```

`config-cache.stub.ts` 加 `doudizhuEnabled: vi.fn(() => true)`，`gameEnabled` 改为与生产同形 switch。

- [ ] **Step 4: 跑绿并提交**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS

```bash
git add packages/room-service/src packages/room-service/test
git commit -m "feat(room): 斗地主总开关闸 + 关闭时暂停匹配扫描"
```

---

### Task 4: 客户端大厅空态与档位卡门控

**Files:**
- Modify: `apps/client/src/pages/lobby/lobby.vue`（模板 + 样式）
- Test: `apps/client/test/lobby-modes.test.ts`

- [ ] **Step 1: 写失败测试**

新增/扩展现有用例：
- `games.doudizhu.enabled=false` ⇒ 不渲染斗地主入口；
- 两个玩法都 false ⇒ 出现「暂无开放的玩法」且 `.lobby__level` 数量为 0；
- 缺 `games` ⇒ 斗地主入口可见。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/lobby-modes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

模板：玩法列表加

```html
<text v-if="visibleModes.length === 0" class="lobby__modes-empty">暂无开放的玩法，请稍后再试</text>
```

右侧档位区条件改为 `v-if="visibleModes.length > 0 && store.activeLevels.length > 0"`；
样式区补 `.lobby__modes-empty`（复用现有空态字号/颜色）。

- [ ] **Step 4: 跑绿并提交**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/lobby-modes.test.ts`
Expected: PASS

```bash
git add apps/client/src/pages/lobby/lobby.vue apps/client/test/lobby-modes.test.ts
git commit -m "feat(client): 玩法全关时大厅空态且隐藏档位卡"
```

---

### Task 5: 管理面顶部开关 + 静态闸

**Files:**
- Modify: `admin/app.js`、`admin/style.css`
- Modify: `scripts/verify-admin-static.mjs`

- [ ] **Step 1: 实现 IA 与运行时键集**

- ddz 域加 `headerKeys: ['game.doudizhu.enabled']`；pdk 域加 `headerKeys: ['game.paodekuai.enabled']`，并从 `switches` 页签删掉它。
- `IA_KEY_SET` 改为展平 `headerKeys + tabs[].keys`。
- `domainSnapshotCount` 用 `new Set([...headerKeys, ...tabKeys])` 去重。
- `CONFIG_CONTROLS` 加 `'game.doudizhu.enabled': { label: '斗地主总开关', type: 'bool' }`；
  `CONFIG_NOTES` 给两个 header 键各补 4 行。

- [ ] **Step 2: 实现顶部卡**

`renderConfigRows` 非搜索态先渲染 `buildGameHeader(domain)`；`rendered += 1`；卡片 `dataset.key = headerKey`。
`buildGameHeader`：状态徽标 + `.switch`；`key in currentConfig` 为 false 时按默认值显示且禁用；
关闭走原生 `confirm()`（含最后玩法提示）；成功后 `loadAll()`，失败回滚。

纯函数（自包含）：

```js
function lastEnabledGameWarning(currentConfig, targetKey, defaults, headerKeys) {
  const others = headerKeys.filter((k) => k !== targetKey);
  return others.every((k) => {
    const v = k in currentConfig ? currentConfig[k].value : defaults[k];
    return v === false;
  });
}
```

- [ ] **Step 3: 改静态闸**

`verify-admin-static.mjs`：65→66（两处）、60→61、28→29、分类合计 60→61（label 同步）；
`BOOL_KEYS` 加新键；新增「headerKeys+tabs 无重复」「pdk enabled 只在 headerKeys」「两个 header 键有 CONFIG_NOTES」；
用 `vm` 提取并执行 `lastEnabledGameWarning`，断言三组输入。

- [ ] **Step 4: 跑闸并提交**

Run: `node scripts/verify-admin-static.mjs`
Expected: `admin static verify: ... passed`

```bash
git add admin/app.js admin/style.css scripts/verify-admin-static.mjs
git commit -m "feat(admin): 玩法设置页顶部开放开关 + 静态闸"
```

---

### Task 6: conformance

**Files:**
- Modify: `tools/conformance/src/slices/{slice-14-config-center,slice-18-gold-room,slice-22-pay-channel,slice-23-notify-channel,slice-24-ads-relief}.ts`
- Modify: `tools/conformance/baselines.json`（实测后）

- [ ] **Step 1: 4 个切片 65 → `CONFIG_KEYS.length`**

slice-18:1025、slice-22:1193、slice-23:735/:1283、slice-24:809；保留字符串 label 的数字同步。

- [ ] **Step 2: slice-14 新判据**

插在 C20 之后、统一收尾前；`try/finally` 恢复 ddz true，外层 finally 也恢复：

1. `setFriendRooms(true, ...)`；
2. PUT ddz=false；`/api/config` ⇒ false；
3. 轮询建房直到 12012（≤70s，1s；成功探针换新账号）；
4. PUT ddz=true；`/api/config` ⇒ true；
5. 轮询建房直到 0（≤70s）。

- [ ] **Step 3: 构建 + 静态验证**

Run: `pnpm exec turbo run build --filter=@fight-the-landlord/conformance...`
Expected: 成功

- [ ] **Step 4: 提交**

```bash
git add tools/conformance/src/slices tools/conformance/baselines.json
git commit -m "test(conformance): 玩法开放开关真栈判据 + 键数改用 CONFIG_KEYS.length"
```

权威轮后把 `slice-14-config-center` 的 `full` 基线按实测回填（只增不减），单独提交。

---

### Task 7: 文档

**Files:**
- Modify: `docs/design.md`（§7.5 表补 ddz 键、计数改「六十六键」；跑得快 14 键缺失注明另开任务）
- Modify: `admin/app.js` 内过期「65 键」注释、`packages/protocol/src/config.ts` 头注释

- [ ] **Step 1:** 改文档与注释；`grep -rnE '65|六十五|五十一'` 逐处核对。
- [ ] **Step 2:** 提交 `docs: 同步玩法开关的配置键文档`。

---

### Task 8: 全量验证与发布

- [ ] **Step 1:** `bash scripts/ci.sh` ⇒ 七阶段通过。
- [ ] **Step 2:** `git checkout dev`（已在此）→ `git merge --ff-only origin/dev` 若落后；`git merge dev` 到 master 前先确认。
- [ ] **Step 3:** 合并 dev → master，推送；盯权威轮（ci / images / conformance）。
- [ ] **Step 4:** 按日志修失败；conformance 全绿后按实测回填 `slice-14` 基线并推送。
- [ ] **Step 5:** 用 `deploy-dev.sh` 部署到服务器（若需要），验证管理面开关与客户端大厅。

## Self-Review

- Spec 覆盖：D1–D13 均有任务（D11→Task3，D7→Task4，D9→Task5，D13→Task7，B2→Task6）。
- 无占位符；所有生产代码已给出。
- 类型/命名一致：`doudizhuEnabled`、`game.doudizhu.enabled`、`lastEnabledGameWarning` 全计划统一。
