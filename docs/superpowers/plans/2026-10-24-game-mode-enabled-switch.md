# 玩法开放开关 Implementation Plan（对抗审查修订）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理面每个玩法设置页顶部一个「开放该玩法」开关；斗地主新增真实服务端开关 `game.doudizhu.enabled`。

**Architecture:** protocol 新键 → 管理面 IA/顶部卡（先做，保持静态闸绿）→ config-service 迁移与 `/api/config` → room-service 闸与匹配暂停 → 客户端大厅门控 → conformance → 全量验证。

**Tech Stack:** TypeScript/NestJS、uni-app Vue3、零构建 admin、conformance 真栈、TypeORM。

## Global Constraints

- spec：`docs/superpowers/specs/2026-10-24-game-mode-enabled-switch-design.md`
- 关闭只拦新匹配/新建房（12012）；进行中对局、已有房间、已入队票不受影响；关闭时匹配扫描暂停
- 缺键默认：斗地主 `true`、跑得快 `false`
- 每任务结尾 commit；attribution 行照 CLAUDE.md
- `ci.sh` 七阶段在每个任务后保持绿；conformance 的 4 个 65 键断言在 Task 5 统一改（权威轮在最后）

---

### Task 1: protocol 键 + 管理面顶部开关 + 静态闸

**Files:**
- Modify: `packages/protocol/src/config.ts`、`config.test.ts`
- Modify: `admin/app.js`、`admin/style.css`
- Modify: `scripts/verify-admin-static.mjs`

**Interfaces:**
- Produces: `ConfigKey` 含 `'game.doudizhu.enabled'`；`parseConfigValue` 严格 boolean；
  管理面 `CONFIG_IA[].headerKeys`、`GAME_SWITCH_DEFAULTS`、`lastEnabledGameWarning()`。

- [ ] **Step 1: protocol 失败测试**

`config.test.ts` 两处逐字数组（约 :56、:467）末尾追加 `'game.doudizhu.enabled'`；加：

```ts
it('game.doudizhu.enabled：严格 boolean', () => {
  expect(parseConfigValue('game.doudizhu.enabled', true)).toBe(true);
  expect(parseConfigValue('game.doudizhu.enabled', false)).toBe(false);
  for (const bad of [1, 'true', null, undefined]) {
    expect(() => parseConfigValue('game.doudizhu.enabled', bad)).toThrow();
  }
});
```

Run: `pnpm --filter @fight-the-landlord/protocol test` ⇒ FAIL

- [ ] **Step 2: protocol 实现**

`CONFIG_KEYS` 末尾加注释 + `'game.doudizhu.enabled'`；`parseConfigValue` 加
`if (key === 'game.doudizhu.enabled') return parseStrictBoolean(key, value);`；头注释改「六十六键」。

Run: `pnpm --filter @fight-the-landlord/protocol test` ⇒ PASS

- [ ] **Step 3: 管理面 IA/键集/控件**

- ddz 域加 `headerKeys: ['game.doudizhu.enabled']`；pdk 域加 `headerKeys: ['game.paodekuai.enabled']`，
  从 pdk `switches` 页签删掉 `game.paodekuai.enabled`。
- `IA_KEY_SET` 改为展平 `[...(d.headerKeys ?? []), ...d.tabs.flatMap((t) => t.keys)]`。
- `domainSnapshotCount(domain)` 用
  `new Set([...(domain.headerKeys ?? []), ...(domain.tabs ?? []).flatMap((t) => t.keys)])` 去重计数。
- `CONFIG_CONTROLS` 加 `'game.doudizhu.enabled': { label: '斗地主总开关', type: 'bool' }`；
  `CONFIG_NOTES` 给两个 header 键补 4 行。
- 新增常量与纯函数（自包含）：

```js
const GAME_SWITCH_DEFAULTS = {
  'game.doudizhu.enabled': true,
  'game.paodekuai.enabled': false,
};
function lastEnabledGameWarning(currentConfig, targetKey, defaults, headerKeys) {
  return headerKeys
    .filter((k) => k !== targetKey)
    .every((k) => (k in currentConfig ? currentConfig[k].value : defaults[k]) === false);
}
```

- `renderConfigRows` 非搜索态先渲染 `buildGameHeader(domain)`，`rendered += 1`；
  `buildGameHeader` 的 `dataset.key = headerKey`；运行时把**全局** `IA_DOMAINS` 的 `headerKeys`
  传给 `lastEnabledGameWarning`（不是 `domain.headerKeys`）；缺键按 `GAME_SWITCH_DEFAULTS` 显示且禁用；
  关闭走原生 `confirm()`（最后玩法追加提示）；成功后 `loadAll()`，失败回滚。
- `admin/style.css` 补 `.game-switch-card` 必要样式（复用 `.row-card` 布局）。

- [ ] **Step 4: 静态闸**

`verify-admin-static.mjs`：65→66（两处）、`entries.size` 60→61、`BOOL_KEYS` 28→29、合计 60→61
（label 同步）；`BOOL_KEYS` 加新键；新增断言：
- `IA_KEY_SET` 表达式含 `headerKeys`（防运行时漏改）；
- `headerKeys + tabs[].keys` 无重复，且 pdk enabled 只在 headerKeys；
- 两个 header 键都有 `CONFIG_NOTES`；
- `GAME_SWITCH_DEFAULTS` 恰为 `{ddz:true, pdk:false}`；
- `renderConfigRows` 函数体含 `buildGameHeader(`；
- 用 balanced-brace 提取**完整函数签名**的 `lastEnabledGameWarning`，`vm` 执行三组合成输入。

Run: `node scripts/verify-admin-static.mjs` ⇒ PASS

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts admin scripts/verify-admin-static.mjs
git commit -m "feat: 玩法开放开关（protocol 键 + 管理面顶部卡 + 静态闸）"
```

---

### Task 2: config-service 迁移与客户端配置

**Files:**
- Create: `packages/config-service/src/migrations/1796500000000-DdzEnabledSeed.ts`
- Modify: `packages/config-service/src/config/client-config.controller.ts`
- Test/Modify: `packages/config-service/test/migration.test.ts`、`client-config.test.ts`、
  `platform-config.service.test.ts`、`admin.controller.test.ts`、`config.rpc.test.ts`、`helpers/config-probe.ts`

- [ ] **Step 1: 写失败测试**

- `migration.test.ts`：**不要动** `EXPECTED_SEED`（那是 PlatformConfig 九键）。新增 describe：
  import `DdzEnabledSeed1796500000000`，断言 `up()` 后 `game.doudizhu.enabled` 值 `true`/version 1；
  连续两次 `up()` 不报错（幂等）；`down()` 删键。照 `MultiGameConfigSeed` 现有测试（约 :1428-1497）形态。
- `client-config.test.ts`：显式 false ⇒ `games.doudizhu.enabled===false`；缺行 ⇒ true（独立用例）。
- `platform-config.service.test.ts`：SEED 加键；`toHaveLength(65)` → 66。
- `admin.controller.test.ts` / `config.rpc.test.ts`：逐字清单加新键（已 `.sort()`）。
- `helpers/config-probe.ts`：SEED 加 `['game.doudizhu.enabled', true]`。

Run: `pnpm --filter @fight-the-landlord/config-service test` ⇒ FAIL

- [ ] **Step 2: 实现**

迁移：

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

`client-config.controller.ts`：

```ts
const ddzEnabled = (byKey.get('game.doudizhu.enabled') ?? true) as boolean;
// games.doudizhu 的 enabled 改为 ddzEnabled
```

Run: `pnpm --filter @fight-the-landlord/config-service test` ⇒ PASS

- [ ] **Step 3: 提交**

```bash
git add packages/config-service/src packages/config-service/test
git commit -m "feat(config): 斗地主总开关迁移与客户端配置下发"
```

---

### Task 3: room-service 闸 + 匹配暂停

**Files:**
- Modify: `packages/room-service/src/config/config-cache.service.ts`
- Modify: `packages/room-service/src/match/match.service.ts`（`processQueue` 顶部）
- Modify: `packages/room-service/test/helpers/config-cache.stub.ts`
- Test: `packages/room-service/test/config-cache.test.ts`、`match-queue-key.test.ts`、`match-switch-game.test.ts`（或同族）、`rooms.controller-switch.test.ts`（或 `rooms-meta.test.ts`）

- [ ] **Step 1: 写失败测试**

- `config-cache.test.ts`：缺键 ⇒ `doudizhuEnabled()===true`；显式 false ⇒ `gameEnabled('doudizhu')===false`；
  显式 true ⇒ true。
- `match-queue-key.test.ts:270-312` 两例前置 `configCache.paodekuaiEnabled.mockReturnValue(true)`
  （否则新暂停闸让 `zrange`/`zrem` 不被调用）。
- 匹配暂停：`gameEnabled.mockReturnValue(false)` ⇒ `processQueue` 不调 `createGameRoom`、不抛错、
  `_zsets` 票还在；重开后成组。
- 建房闸：用真实 `gameEnabled`（`doudizhuEnabled` 返回 false）⇒ `RoomsService.create` 抛
  `12012`；`message.router` 同族用例。

Run: `pnpm --filter @fight-the-landlord/room-service test` ⇒ FAIL

- [ ] **Step 2: 实现**

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

`match.service.ts` 的 `processQueue` 顶部（`zrange` 之前）：

```ts
if (!this.configCache.gameEnabled(queue.gameType)) return; // 关闭的玩法：暂停匹配，票保留
```

`config-cache.stub.ts`：加 `doudizhuEnabled: vi.fn(() => true)`，`gameEnabled` 与生产同形 switch。

Run: `pnpm --filter @fight-the-landlord/room-service test` ⇒ PASS

- [ ] **Step 3: 提交**

```bash
git add packages/room-service/src packages/room-service/test
git commit -m "feat(room): 斗地主总开关闸 + 关闭时暂停匹配"
```

---

### Task 4: 客户端大厅

**Files:**
- Modify: `apps/client/src/pages/lobby/lobby.vue`
- Test: `apps/client/test/lobby-modes.test.ts`

- [ ] **Step 1: 写测试**

- 全关用例：两个 `games.*.enabled=false`，**保留非空 ddz 档位** ⇒ 出现「暂无开放的玩法」、
  `.lobby__level` 为 0、`.lobby__levels-empty` **不存在**；
- `ddz=false` 单个 ⇒ 不渲染入口（回归护栏；改造前本就绿）；
- 缺 `games` ⇒ 斗地主可见。

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/lobby-modes.test.ts` ⇒ 全关用例 FAIL

- [ ] **Step 2: 实现**

在 `.lobby__levels` 容器（约 :915）上加 `v-if="visibleModes.length > 0"`（**不要**改内部
`:922` 的三态条件）；玩法列表加：

```html
<text v-if="visibleModes.length === 0" class="lobby__modes-empty">暂无开放的玩法，请稍后再试</text>
```

样式区补 `.lobby__modes-empty`（复用现有空态）。

Run: 同上 ⇒ PASS

- [ ] **Step 3: 提交**

```bash
git add apps/client/src/pages/lobby/lobby.vue apps/client/test/lobby-modes.test.ts
git commit -m "feat(client): 玩法全关时大厅空态且隐藏档位区"
```

---

### Task 5: conformance

**Files:**
- Modify: `tools/conformance/src/slices/slice-14-config-center.ts`
- Modify: `tools/conformance/src/slices/{slice-18-gold-room,slice-22-pay-channel,slice-23-notify-channel,slice-24-ads-relief}.ts`
- Modify: `tools/conformance/baselines.json`（权威轮实测后）

- [ ] **Step 1: 4 个切片 65 → `CONFIG_KEYS.length`**

slice-18:1025、slice-22:1193、slice-23:735/:1283、slice-24:809；slice-18/23/24 补
`import { CONFIG_KEYS } from '@fight-the-landlord/protocol'`；label 数字同步。

- [ ] **Step 2: slice-14 新判据**

插在 C20（约 :607）之后、统一收尾（约 :612）之前；`try/finally` + 外层 finally 恢复 ddz true：

1. `setFriendRooms(true, ...)`；
2. PUT ddz=false；`/api/config` ⇒ false；
3. 轮询建房直到 12012（≤70s、1s；成功探针换新账号）；
4. PUT ddz=true；`/api/config` ⇒ true；
5. 轮询建房直到 0（≤70s）。

- [ ] **Step 3: 构建 + 提交**

Run: `pnpm exec turbo run build --filter=@fight-the-landlord/conformance...` ⇒ PASS

```bash
git add tools/conformance/src/slices
git commit -m "test(conformance): 玩法开放开关真栈判据 + 键数改用 CONFIG_KEYS.length"
```

权威轮后按实测回填 `slice-14-config-center` 的 `full`（当前 75，只增不减），单独提交。

---

### Task 6: 文档

- `docs/design.md` §7.5：补 `game.doudizhu.enabled`、计数改「六十六键」；跑得快 14 键缺失注明另开任务。
- `packages/protocol/src/config.ts` 头注释、`admin/app.js` 过期「65 键」注释同步。
- `grep -rnE '65|六十五|五十一'` 逐处核对。
- 提交 `docs: 同步玩法开关配置键文档`。

---

### Task 7: 全量验证与发布

- [ ] `bash scripts/ci.sh` ⇒ 七阶段通过。
- [ ] 合并 dev → master、推送；盯权威轮（ci / images / conformance）。
- [ ] 按日志修失败；全绿后回填 slice-14 基线。
- [ ] 需要时 `deploy-dev.sh` 部署并验证管理面开关与大厅。

## Self-Review

- 计划评审 B1（match-queue-key 前置）、B2（迁移测试独立 describe）、H1（IA_KEY_SET 断言）、
  H2（defaults 命名/全局 headerKeys/renderConfigRows 断言/签名提取）、H3（12012 单测）、
  H4（`.lobby__levels` 外层门控 + 空态断言）、H5（任务顺序保持 ci.sh 绿）均已修入。
- D1–D13 全部有任务；无占位符；命名统一。
