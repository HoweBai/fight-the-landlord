# 玩法开放开关（管理面顶部）设计

日期：2026-10-24
状态：待实现

## 0. 背景与问题

管理面「配置中心 → 玩法」下已有斗地主 / 跑得快两个域：

- 跑得快的总开关 `game.paodekuai.enabled` 埋在「开关」页签里，与其余 13 个规则键混排；
- 斗地主**没有**总开关：`room-service` 的 `gameEnabled()` 对斗地主恒真，客户端 `games.doudizhu.enabled`
  在 `client-config.controller.ts` 里硬编码 `true`。

运营需要一个**每个玩法设置页顶部**的显式「是否开放该玩法」开关。关闭语义 = 停止**新匹配/新建房**，
不影响进行中的对局与已存在的房间（与现有跑得快关闭语义一致）。

## 1. 范围

### 做

- 新增配置键 `game.doudizhu.enabled`（严格 boolean，种子 `true`）；
- `room-service` 的玩法闸读该键（缺键默认 `true`，旧库兼容）；
- `config-service` 的 `/api/config` 下发 `games.doudizhu.enabled`；
- 客户端大厅按配置隐藏玩法；两个玩法都关闭时显示空态文案；
- 管理面每个玩法域顶部一张「开放该玩法」开关卡（斗地主 / 跑得快各一个）；
- 跑得快页签移除重复的 `enabled` 行，只留「开放 2/4 人」；
- 真栈 conformance 判据、协议/配置/房间/客户端/管理面静态闸的测试；
- 相关文档与键数断言同步。

### 不做

- 不清理已入队的匹配票、不终止进行中的对局、不拦截已存在房间的 `join`（与现有跑得快语义一致）；
- 不做按场次（免费/金币/好友房）的二级玩法开关（已有 `room.*RoomEnabled`）；
- 不新增 RBAC 权限（复用现有 config 写权限与管理审计）；
- 不改跑得快现有键的默认值/语义。

## 2. 决策表

| # | 决策 | 结论 | 来源 |
|---|---|---|---|
| D1 | 斗地主是否也做真实开关 | **做**：新增 `game.doudizhu.enabled`，服务端 12012 拦截 | 用户 2026-10-24 |
| D2 | 两个玩法都关闭 | **允许**；关闭最后一个时管理面二次确认并提示「大厅将没有可选玩法」 | 用户 2026-10-24 |
| D3 | 顶部开关交互 | **立即 PUT 生效**；关闭时二次确认；失败回滚开关 | 用户 2026-10-24 |
| D4 | 管理面 IA 表示 | 每个玩法域新增 `headerKeys`，顶部专属卡；页签内不再重复该键 | 技术决策（单一控制点） |
| D5 | 关闭语义 | 只拦**新匹配入队 / 新建房**（12012）；进行中对局、已有房间、已入队票不受影响 | 用户 2026-10-24 确认 |
| D6 | 键缺失时的默认 | 斗地主 `true`（旧库/旧快照保持现状）；跑得快 `false`（现状） | 技术决策（向后兼容） |
| D7 | 客户端空态 | 两个玩法都关闭 ⇒ 大厅显示「暂无开放的玩法」 | 技术决策（现有代码不崩，但需要可读提示） |
| D8 | 真栈判据落点 | 扩展 `slice-14-config-center`（配置中心片） | 技术决策 |
| D9 | 管理面确认弹窗 | 复用现有 `#modal` 组件，新增「无输入 confirm」模式（不引入第二套弹窗） | 技术决策（单一组件） |
| D10 | 配置键可见性 | `game.doudizhu.enabled` **不进** `CLIENT_CONFIG_KEYS`；客户端只读折叠后的 `games` | 技术决策（不扩大公开键面） |

## 3. 实现设计

### 3.1 protocol（`packages/protocol/src/config.ts`）

- `CONFIG_KEYS` 末尾追加第 66 键：

  ```ts
  /** 玩法开放开关（第 66 键）：斗地主总开关（严格 boolean、种子 true——保持现状；
   *  客户端不可见——折叠进 `games.doudizhu.enabled`）。关 ⇒ 新匹配/新建房 12012。 */
  'game.doudizhu.enabled',
  ```

- `parseConfigValue()` 增加：

  ```ts
  if (key === 'game.doudizhu.enabled') return parseStrictBoolean(key, value);
  ```

- 不加入 `CLIENT_CONFIG_KEYS`。

### 3.2 config-service

1. **迁移**：新增 `packages/config-service/src/migrations/1796500000000-DdzEnabledSeed.ts`

   ```sql
   INSERT IGNORE INTO `platform_config`
     (`key`, `value`, `version`, `updated_at`, `updated_by`)
   VALUES ('game.doudizhu.enabled', 'true', 1, NOW(3), 'seed')
   ```

   `down()` 删除该键。`INSERT IGNORE` 保证重放/现有库可重跑，不覆盖管理员已改的值。

2. **客户端配置组装**（`config/client-config.controller.ts`）：

   ```ts
   const ddzEnabled = (byKey.get('game.doudizhu.enabled') ?? true) as boolean;
   // ...
   doudizhu: { enabled: ddzEnabled, supportedPlayerCounts: ..., ... }
   ```

   `paodekuai` 代码不动。

### 3.3 room-service

`config/config-cache.service.ts`：

```ts
/** 斗地主总开关（缺键 ⇒ true，旧库/旧快照保持现状）。 */
doudizhuEnabled(): boolean {
  const value = this.snapshot?.['game.doudizhu.enabled']?.value;
  return typeof value === 'boolean' ? value : true;
}

/** 玩法是否开放（两个玩法都读运营开关）。 */
gameEnabled(gameType: GameType): boolean {
  switch (gameType) {
    case 'doudizhu': return this.doudizhuEnabled();
    case 'paodekuai': return this.paodekuaiEnabled();
    default: {
      const exhaustive: never = gameType; // 新增玩法时这里编译失败，防漏接
      return exhaustive;
    }
  }
}
```

`switch` 穷尽 `GameType`，新增玩法时 TypeScript 会报错（防漏接）。

消费点不变：`gateway/message.router.ts`（匹配入队）与 `rooms/rooms.service.ts`（`create`）继续用
`gameEnabled()` ⇒ 返回 `12012 GAME_UNAVAILABLE`。

### 3.4 客户端

- `lobby.vue`：`visibleModes` 已经按 `store.modeEnabled()` 过滤，无需改过滤逻辑；
  在玩法列表处补空态：

  ```html
  <text v-if="visibleModes.length === 0" class="lobby__modes-empty">暂无开放的玩法，请稍后再试</text>
  ```

- `stores/game.ts` 的 `modeEnabled()` 不变：`games[id].enabled`，旧服务端缺 `games` ⇒ 斗地主可见。
- 旧服务端（无 `games.doudizhu`）⇒ 默认可见，行为零变化。

### 3.5 管理面（`admin/app.js` + `admin/index.html`）

1. **IA**（`CONFIG_IA`）：

   - 斗地主域新增 `headerKeys: ['game.doudizhu.enabled']`；
   - 跑得快域新增 `headerKeys: ['game.paodekuai.enabled']`，并从「开关」页签的 `keys` 中删掉它
     （该页签只留 `game.paodekuai.nonThreePlayerEnabled`）。

2. **计数**：`domainSnapshotCount(domain)` 改为
   `[...(domain.headerKeys ?? []), ...domain.tabs.flatMap(t => t.keys)].filter(k => k in currentConfig).length`，
   保证左树徽标/域回退把 header 键算进去。

3. **渲染**：`renderConfigRows()` 在非搜索态、当前域有 `headerKeys` 时，先渲染
   `buildGameHeader(domain)`，再渲染原有页签分区。搜索态仍按 `snapshotKeys()` 扁平展示（header 键作为普通
   布尔行出现，不与顶部卡同时出现）。

4. **`buildGameHeader(domain)`**：

   - 结构：`div.row-card.game-switch-card`（复用行卡片样式）+ 标题「开放『<玩法名>』」+
     状态徽标（`已开放` / `已关闭`）+ 现有 `.switch` 复选框 + 一行说明：
     「关闭后：新的匹配/建房会被拒绝（12012），进行中的对局与已有房间不受影响。」
   - 拨动开启 ⇒ 直接 `putConfigKey(key, true)`；
   - 拨动关闭 ⇒ 先弹确认：
     - 常规：`title: '关闭「<玩法名>」？'`，`desc: '关闭后：新的匹配/建房会被拒绝（12012），进行中的对局与已有房间不受影响。'`
     - 若当前是**最后一个**开放玩法：`desc` 追加 `'这是最后一个开放的玩法，关闭后大厅将没有可选玩法。'`
     - `confirmLabel: '关闭'`；取消 ⇒ 复选框回滚；
   - 保存中：`input.disabled = true`；成功后 `await loadAll()`（复用现有快照刷新/重渲染）；
     失败：复选框回滚到旧值（`putConfigKey` 已负责错误提示）。
   - 判断「最后一个开放玩法」：对 `GAME_MODES` 中除当前键外的每个玩法，取其键在 `currentConfig` 的值；
     **键缺失时按默认值**（斗地主 `true`、跑得快 `false`）。当前键按目标值 `false` 计算。

5. **`modalConfirm`**：在现有 `modalPrompt` 旁增加无输入模式（复用 `#modal` 的标题/描述/确定/取消；
   无输入时隐藏 `#modal-input` 且不聚焦），Promise 返回 `true/false`。不新建第二套弹窗 DOM。

6. **控件表**：

   - `CONFIG_CONTROLS` 增加 `'game.doudizhu.enabled': { label: '斗地主总开关', type: 'bool' }`；
   - `CONFIG_NOTES` **必须**为 `game.doudizhu.enabled` 与 `game.paodekuai.enabled` 各补 4 行说明
     （作用/取值/生效/注意）。原因：搜索态会把 header 键当普通行渲染，无备注会走
     「IA 表未收录的键」兜底文案（误导——它其实在 IA 里）。

7. **静态闸**（`scripts/verify-admin-static.mjs`）：

   - `protoSet.size === 65` → `66`；
   - `iaKeySet.size === 65` → `66`（IA 提取基于 CONFIG_IA 块内的引号点分串，`headerKeys` 自动纳入）；
   - `entries.size === 60` → `61`；
   - `BOOL_KEYS.length === 28` → `29`，并把新键加入 `BOOL_KEYS` 清单；
   - 更新相关注释里的键数（65→66、60→61）。

### 3.6 conformance（`slice-14-config-center`）

在现有配置中心片内新增一组真栈判据（带 `try/finally`，**无论如何恢复 `game.doudizhu.enabled=true`**）：

1. 前置：`setFriendRooms(true, ...)` —— `POST /api/rooms` 的第一道闸是 `friendRoomEnabled`（关 ⇒ 12006）；
   不先开它，12012 会被 12006 遮住（slice-29 同款坑）。
2. 管理员 PUT `game.doudizhu.enabled = false` ⇒ 200；
3. `GET /api/config`（玩家令牌）⇒ `games.doudizhu.enabled === false`（该端点每次查库，立即读得到）；
4. **轮询**建房直到 `12012`（≤60s，1s 间隔，**不钉墙钟**）：
   - 每次探针用**新鲜账号**；若某次返回 `0`（陈旧缓存 ⇒ 真的建出了房），换一个新账号继续，
     否则同账号下一次只会撞 12011，永远等不到 12012；
5. 管理员 PUT `game.doudizhu.enabled = true` ⇒ 200；
6. `GET /api/config` ⇒ `games.doudizhu.enabled === true`；
7. **轮询**建房直到 `0`（≤60s）；返回 12012 时用同一账号重试即可（失败不会占房）——正对照，证明恢复后可用。

断言数按实测回填（预计 +6～8），`baselines.json` 的 `slice-14-config-center` 在权威轮按实测更新（只增不减）。

## 4. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 非 boolean 值 PUT | `parseConfigValue` ⇒ 400，不落库（现有机制） |
| 管理员令牌过期 | 现有 `putConfigKey` 401 分流 ⇒ 回登录 |
| 网络失败/5xx | 开关回滚；顶栏错误提示（现有 `putConfigKey`） |
| 关到最后一个玩法 | 允许；确认文案加强提示；大厅空态 |
| 旧库/旧快照缺键 | 斗地主默认 `true`；跑得快默认 `false` |
| 进行中对局/已存在房间 | 不受影响（只拦新匹配/新建房） |
| 配置传播 | `/api/config` 每次查库（立即）；room-service 走广播失效，最坏 ≤60s 安全网 |

## 5. 测试判据（TDD）

按层写失败测试 → 最小实现 → 转绿：

1. **protocol**：`config.test.ts` 键集含新键、总数 66；`parseConfigValue` 对 `true/false` 通过、对 `1/'true'/null` 抛错。
2. **config-service**：迁移测试（新键种子 `true`、重放幂等、down 删除）；`client-config.test.ts`
   （键 false ⇒ `games.doudizhu.enabled=false`；缺键 ⇒ true）；配置探针/键集测试同步。
3. **room-service**：`config-cache.test.ts`（缺键默认 true、false 生效）；`rooms.service`/`message.router`
   在 `gameEnabled('doudizhu')===false` 时返回 12012（镜像现有跑得快用例）。
4. **client**：`modeEnabled('doudizhu')` 随 `games.doudizhu.enabled` 变化；大厅关闭斗地主后不渲染入口；
   两个都关 ⇒ 空态文案；缺 `games` ⇒ 斗地主可见。
5. **admin 静态闸**：`node scripts/verify-admin-static.mjs` 全绿（66/61/29）。
6. **conformance**：`slice-14` 新判据在真栈通过；`baselines.json` 按实测回填。
7. **全量**：`bash scripts/ci.sh` 七阶段通过；合并 master 后权威轮（ci + conformance + images）全绿。

## 6. 风险

- **键数断言面广**：protocol / admin 静态闸 / 配置探针 / 迁移测试都可能断言 65 键；任一漏改会红。
  实现时以 `grep -rn '65'` 与 `verify-admin-static.mjs` 为准逐处同步。
- **管理面静态闸**是「第二真源」风险点：`CONFIG_IA`、`CONFIG_CONTROLS`、`BOOL_KEYS` 三处都要加新键，
  且计数断言在脚本里；漏一处即红（这正是它存在的目的）。
- **conformance 基线**：新增断言后旧基线会报「未回填」；按实测回填，不做预测。
- **大厅空态**：两个玩法全关是允许态，必须保证不白屏、有提示。
- **旧客户端**：旧服务端无 `games` ⇒ 斗地主可见；新服务端关斗地主后旧客户端仍能建房（服务端 12012 兜底），
  但大厅入口仍显示 —— 属于「旧客户端不受新 UI 控制」的已知边界。

## 7. 涉及文件

**改**

- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`、相关测试与配置探针
- `packages/config-service/src/migrations/1796500000000-DdzEnabledSeed.ts`（新）
- `packages/room-service/src/config/config-cache.service.ts`、相关测试
- `apps/client/src/pages/lobby/lobby.vue`、客户端门控测试
- `admin/app.js`、`admin/index.html`（modal confirm 模式）
- `scripts/verify-admin-static.mjs`
- `tools/conformance/src/slices/slice-14-config-center.ts`、`tools/conformance/baselines.json`
- `docs/design.md`（配置键表/键数）、本 spec

## 8. 审查记录

（设计对抗审查后填写）
