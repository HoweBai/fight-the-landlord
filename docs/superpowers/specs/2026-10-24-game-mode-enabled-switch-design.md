# 玩法开放开关（管理面顶部）设计

日期：2026-10-24
状态：待实现（已过一轮独立对抗审查）

## 0. 背景与问题

管理面「配置中心 → 玩法」下已有斗地主 / 跑得快两个域：

- 跑得快的总开关 `game.paodekuai.enabled` 埋在「开关」页签里，与其余规则键混排；
- 斗地主**没有**总开关：`room-service` 的 `gameEnabled()` 对斗地主恒真，客户端 `games.doudizhu.enabled`
  在 `client-config.controller.ts` 里硬编码 `true`。

运营需要一个**每个玩法设置页顶部**的显式「是否开放该玩法」开关。关闭语义 = 停止**新匹配/新建房**，
不影响进行中的对局与已存在的房间（与现有跑得快关闭语义一致）。

## 1. 范围

### 做

- 新增配置键 `game.doudizhu.enabled`（严格 boolean，种子 `true`）；
- `room-service` 的玩法闸读该键（缺键默认 `true`，旧库兼容）；
- **关闭玩法时暂停该队列的匹配扫描**（票保留、不逐 tick 抛错/刷日志），重新开放后恢复；
- `config-service` 的 `/api/config` 下发 `games.doudizhu.enabled`；
- 客户端大厅按配置隐藏玩法；两个玩法都关闭时**同时隐藏右侧档位卡**并显示空态文案；
- 管理面每个玩法域顶部一张「开放该玩法」开关卡（斗地主 / 跑得快各一个）；
- 跑得快页签移除重复的 `enabled` 行，只留「开放 2/4 人」；
- 真栈 conformance 判据、协议/配置/房间/客户端/管理面静态闸的测试；
- 相关文档与键数断言同步。

### 不做

- 不清理已入队的匹配票、不终止进行中的对局、不拦截已存在房间的 `join`（与现有跑得快语义一致）；
- 不做按场次（免费/金币/好友房）的二级玩法开关（已有 `room.*RoomEnabled`）；
- 不新增 RBAC 权限（复用现有 config 写权限与管理审计）；
- 不改跑得快现有键的默认值/语义；
- 不补齐 `docs/design.md` 里**跑得快 14 键**的历史缺失（已登记债务，另开任务）；本任务只补 ddz 键并修正计数。

## 2. 决策表

| # | 决策 | 结论 | 来源 |
|---|---|---|---|
| D1 | 斗地主是否也做真实开关 | **做**：新增 `game.doudizhu.enabled`，服务端 12012 拦截 | 用户 2026-10-24 |
| D2 | 两个玩法都关闭 | **允许**；关闭最后一个时管理面二次确认并提示「大厅将没有可选玩法」 | 用户 2026-10-24 |
| D3 | 顶部开关交互 | **立即 PUT 生效**；关闭时二次确认；失败回滚开关 | 用户 2026-10-24 |
| D4 | 管理面 IA 表示 | 每个玩法域新增 `headerKeys`，顶部专属卡；页签内不再重复该键 | 技术决策（单一控制点） |
| D5 | 关闭语义 | 只拦**新匹配入队 / 新建房**（12012）；进行中对局、已有房间、已入队票不受影响 | 用户 2026-10-24 确认 |
| D6 | 键缺失时的默认 | 斗地主 `true`（旧库/旧快照保持现状）；跑得快 `false`（现状） | 技术决策（向后兼容） |
| D7 | 客户端空态 | 两个玩法都关闭 ⇒ 大厅显示「暂无开放的玩法」且**零张档位卡** | 技术决策（现有代码不崩，但右栏仍可点） |
| D8 | 真栈判据落点 | 扩展 `slice-14-config-center`（配置中心片），插在 C20 之后、统一收尾之前 | 技术决策 |
| D9 | 管理面确认方式 | 复用现有 `confirm()` 先例（`admin/app.js:3278` 等 5 处），**不改造共享 `#modal`** | 技术决策（避免共享弹窗回归面） |
| D10 | 配置键可见性 | `game.doudizhu.enabled` **不进** `CLIENT_CONFIG_KEYS`；客户端只读折叠后的 `games` | 技术决策（不扩大公开键面） |
| D11 | 关闭时的匹配扫描 | `processQueue` 开头 `gameEnabled(queue.gameType)` 为 false ⇒ **直接 return**（票保留、不建组、不抛错）；重开后按原有超时逻辑继续 | 技术决策（避免日志风暴与冻结票无提示） |
| D12 | 在线客户端刷新边界 | 大厅只在 `onMounted` 拉配置；在线玩家需重进大厅才看到入口变化（服务端 12012 兜底） | 已知边界，写入 §4 |
| D13 | 文档范围 | 修 `docs/design.md` 的计数与 ddz 键；跑得快 14 键缺失不在本任务 | 技术决策（控制爆炸半径） |

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

- 不加入 `CLIENT_CONFIG_KEYS`；同步头注释里的「五十一键」为「六十六键」。

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

#### 3.3.1 玩法闸

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

#### 3.3.2 匹配扫描：关闭的玩法暂停（D11）

`match/match.service.ts` 的 `processQueue`（或 `scanAndMatchInner` 调用点）**开头**：

```ts
if (!this.configCache.gameEnabled(queue.gameType)) return; // 关闭的玩法：暂停匹配，票保留（D5/D11）
```

- 目的：关闭斗地主后，若队列里还有旧票，现有 `startGroup → createGameRoom` 会每 5s 抛一次
  `12012`，被 `scanAndMatchInner` 的 `catch` 打成 error 日志（日志风暴），且票既不被清也不会匹配。
- 语义：**不删票、不 fail、不记 attempts**；重新开放后按原有超时/匹配逻辑继续。
- 测试：`configCache.gameEnabled` 为 false 时 `processQueue` 不调用 `startGroup`、不抛错、票原样；
  重新置 true 后能正常成组。

### 3.4 客户端

- `lobby.vue`：

  ```html
  <text v-if="visibleModes.length === 0" class="lobby__modes-empty">暂无开放的玩法，请稍后再试</text>
  ```

  并把右侧档位区整块与玩法可见性绑定：

  ```html
  <view v-if="visibleModes.length > 0 && store.activeLevels.length > 0" ...>
  ```

  否则两个玩法全关时右栏仍渲染「休闲场/标准场…」，点进去撞 12012（现有先例：
  `test/lobby-modes.test.ts:424-435` 要求场次双关 ⇒ 零档位卡）。

- 新增 `.lobby__modes-empty` 的样式（复用现有空态字号/颜色；若已有通用空态类则复用）。
- `stores/game.ts` 的 `modeEnabled()` 不变：旧服务端缺 `games` ⇒ 斗地主可见。
- **已知边界（D12）**：在线玩家停在大厅时不会自动重拉配置；运营关闭玩法后，入口要等玩家重进大厅才消失。
  服务端 12012 兜底，不会真的开新局。

### 3.5 管理面（`admin/app.js` + `admin/index.html` + `admin/style.css`）

1. **IA**（`CONFIG_IA`）：

   - 斗地主域新增 `headerKeys: ['game.doudizhu.enabled']`；
   - 跑得快域新增 `headerKeys: ['game.paodekuai.enabled']`，**并从「开关」页签的 `keys` 中删掉它**
     （该页签只留 `game.paodekuai.nonThreePlayerEnabled`）。

2. **运行时键集**：`IA_KEY_SET`（`admin/app.js:662`）必须同步：

   ```js
   const IA_KEY_SET = new Set(
     IA_DOMAINS.flatMap((d) => [...(d.headerKeys ?? []), ...d.tabs.flatMap((t) => t.keys)]),
   );
   ```

   否则两个 header 键会被 `ungroupedKeys()` 判成「未分组」⇒ 左树多出「未分组 2」+ 重复控件。
   `domainSnapshotCount` 用 `new Set([...headerKeys, ...tabKeys])` 去重后计数。

3. **渲染**：`renderConfigRows()` 在非搜索态、当前域有 `headerKeys` 时，先渲染
   `buildGameHeader(domain)`，再渲染原有页签分区；`rendered` 计数**包含**顶部卡
   （防「只剩 header 键」时同时出现卡片和「暂无可展示的配置键」假空态）。搜索态仍按
   `snapshotKeys()` 扁平展示（header 键作为普通布尔行出现，不与顶部卡同时出现）。

4. **`buildGameHeader(domain)`**：

   - 结构：`div.row-card.game-switch-card`（复用行卡片样式；`dataset.key = headerKey`，
     保证 focus 恢复可用）+ 标题「开放『<玩法名>』」+ 状态徽标（`已开放` / `已关闭`）+
     现有 `.switch` 复选框 + 说明：
     「关闭后：新的匹配/建房会被拒绝（12012），进行中的对局与已有房间不受影响。
       配置通常秒级生效，最坏 ≤60s。」
   - **缺键/未加载**：`key in currentConfig` 为 false 时，按 D6 的默认值显示，且**开关禁用**
     （避免把「未加载」误显示成「已关闭」并写入）。`game.doudizhu.enabled` 默认 `true`，
     `game.paodekuai.enabled` 默认 `false`。
   - 拨动开启 ⇒ 直接 `putConfigKey(key, true)`；
   - 拨动关闭 ⇒ 先 `confirm(...)`（原生确认，复用现有先例）：
     - 常规：`关闭「<玩法名>」？新的匹配/建房将被拒绝（12012），进行中的对局与已有房间不受影响。`
     - 若当前是**最后一个**开放玩法，追加：`这是最后一个开放的玩法，关闭后大厅将没有可选玩法。`
     - 取消 ⇒ 复选框回滚。
   - 保存中：`input.disabled = true`；成功后 `await loadAll()`；失败：复选框回滚（`putConfigKey` 已提示）。
   - **可测试的纯函数**（放进 `app.js`，自包含、全部输入走参数）：

     ```js
     function lastEnabledGameWarning(currentConfig, targetKey, defaults, headerKeys) { ... }
     ```

     从 `IA_DOMAINS` 的 `headerKeys` 推导玩法键列表（**不引入 `GAME_MODES`**——admin 里没有这个常量）；
     `defaults` 是 admin 内唯一一份 `{ key: 默认值 }` 表（ddz true / pdk false）。
     `verify-admin-static.mjs` 用 `vm` 提取该函数并执行合成输入，断言：
     - 另一个玩法开 ⇒ 不追加警告；
     - 另一个玩法关/缺键（按默认）⇒ 追加警告；
     - 当前键的旧值不参与判定。
     同时静态断言 `defaults` 的键集合恰好 = `CONFIG_IA` 的 `headerKeys` 集合。

5. **控件表**：

   - `CONFIG_CONTROLS` 增加 `'game.doudizhu.enabled': { label: '斗地主总开关', type: 'bool' }`；
   - `CONFIG_NOTES` **必须**为 `game.doudizhu.enabled` 与 `game.paodekuai.enabled` 各补 4 行说明
     （作用/取值/生效/注意）。原因：搜索态会把 header 键当普通行渲染，无备注会走
     「CONFIG_NOTES 未收录」兜底文案（误导——它其实在 IA 里）。

6. **样式**：`.game-switch-card` 复用 `.row-card` 的布局；只补必要的间距/徽标颜色，
   不引入新的设计令牌。

7. **静态闸**（`scripts/verify-admin-static.mjs`）：

   - `protoSet.size === 65` → `66`；
   - `iaKeySet.size === 65` → `66`（IA 提取基于 CONFIG_IA 块内的引号点分串，`headerKeys` 自动纳入）；
   - `entries.size === 60` → `61`；
   - `BOOL_KEYS.length === 28` → `29`，并把新键加入 `BOOL_KEYS` 清单；
   - **分类合计** `BOOL + TEXT + number === 60` → `61`（label 同步 `29+2+30=61`）；
   - **新增重复键断言**：`headerKeys + tabs[].keys` 展平后每个键恰好出现一次；
     并显式断言 `game.paodekuai.enabled` 只出现在 pdk 的 `headerKeys`；
   - **新增 `CONFIG_NOTES` 断言**：两个 header 键都必须在备注表里有条目（防空备注走误导兜底）；
   - **新增 `lastEnabledGameWarning` 的 `vm` 执行自证**（见 §3.5.4）；
   - 更新相关注释/标签里的键数（65→66、60→61、28→29）。

### 3.6 conformance

1. **先修 4 个切片的硬编码 65**（否则新栈必红）：

   - `slice-18-gold-room.ts:1025` → `CONFIG_KEYS.length`（该文件已可 import protocol）或 `66`；
   - `slice-22-pay-channel.ts:1193` → 同上；
   - `slice-23-notify-channel.ts:735` 与 `:1283` → 同上；
   - `slice-24-ads-relief.ts:809` → 同上。

   优先改成 `CONFIG_KEYS.length`（`slice-20-risk-control.ts:143` 的正确先例），避免下次加键再红；
   保留的字符串 label 同步改数字。

2. **新增判据**（`slice-14-config-center.ts`，插在 **C20 之后、统一收尾之前**，带恢复）：

   - 前置：`setFriendRooms(true, ...)` —— `POST /api/rooms` 的第一道闸是 `friendRoomEnabled`（关 ⇒ 12006）；
     不先开它，12012 会被 12006 遮住（slice-29 同款坑）。
   - 管理员 PUT `game.doudizhu.enabled = false` ⇒ 200；
   - `GET /api/config`（玩家令牌）⇒ `games.doudizhu.enabled === false`（该端点每次查库，立即读得到）；
   - **轮询**建房直到 `12012`（≤70s，1s 间隔，**不钉墙钟**，对齐 slice-14 C2 的 70s 先例）：
     - 探针用**新鲜账号**。注意：`POST /api/rooms` **没有**「已在局」守卫（12011 只来自 WS `room.match`），
       陈旧缓存期探针会真的建出房；换新号是为了不让失败态混进同一账号的后续探针，不是因为 12011。
   - 管理员 PUT `game.doudizhu.enabled = true` ⇒ 200；
   - `GET /api/config` ⇒ `games.doudizhu.enabled === true`；
   - **轮询**建房直到 `0`（≤70s）；返回 12012 时同一账号可重试（失败不占房）——正对照。
   - **恢复**：局部 `try/finally` + 外层 `finally`（`slice-14` 现有 `:615-628`）都要把
     `game.doudizhu.enabled=true` 恢复；friendRoom 的收尾仍归 slice-14 统一收尾（`:612-614`）。
     进程被杀/超时也不能让 ddz 留在 false（否则后续 06/12/18/25/27 等建房切片级联红）。

3. `baselines.json` 的 `slice-14-config-center` 当前 `full=75`；新增断言后按权威轮**实测回填**（只增不减）。

## 4. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 非 boolean 值 PUT | `parseConfigValue` ⇒ 400，不落库（现有机制） |
| 管理员令牌过期 | 现有 `putConfigKey` 401 分流 ⇒ 回登录 |
| 网络失败/5xx | 开关回滚；顶栏错误提示（现有 `putConfigKey`） |
| 关到最后一个玩法 | 允许；`confirm` 加强提示；大厅空态且无档位卡 |
| 旧库/旧快照缺键 | 斗地主默认 `true`；跑得快默认 `false`；管理面按默认显示且开关禁用 |
| 进行中对局/已存在房间 | 不受影响（只拦新匹配/新建房） |
| 关闭时队列已有票 | 匹配扫描静默跳过（D11）；票保留，重开后按原逻辑继续/超时 |
| 配置传播 | `/api/config` 每次查库（立即）；room-service 走广播失效，最坏 ≤60s |
| 在线客户端 | 大厅只在挂载时拉配置 ⇒ 入口变化要等重进大厅（D12） |

## 5. 测试判据（TDD）

按层写失败测试 → 最小实现 → 转绿：

1. **protocol**：`config.test.ts` 逐字数组追加新键（与 `config.ts` 顺序一致）；`parseConfigValue`
   对 `true/false` 通过、对 `1/'true'/null` 抛错（该文件是逐字数组，**没有**计数断言，不要假设有）。
2. **config-service**：
   - 迁移测试：新键种子 `true`、重放幂等、down 删除；
   - `client-config.test.ts`：键 false ⇒ `games.doudizhu.enabled=false`；缺键 ⇒ true；
   - `config-probe.ts` 的 `SEED`、`platform-config.service.test.ts`（SEED + `toHaveLength(65)`）、
     `admin.controller.test.ts` 与 `config.rpc.test.ts` 的逐字键清单：同步到 66。
   - 新 ddz 用例**显式** `db.rows.set('game.doudizhu.enabled', { value:false, ... })`，
     并额外保留「缺键 ⇒ true」独立用例（防 SEED 漏加导致假绿）。
3. **room-service**：
   - `config-cache.test.ts`：缺键 true / 显式 false / 显式 true；
   - `test/helpers/config-cache.stub.ts` 增加 `doudizhuEnabled`（缺省 true），`gameEnabled` 镜像生产 switch；
   - `rooms.service`/`message.router`：`gameEnabled('doudizhu')===false` ⇒ 12012；
   - `match.service`：关闭时 `processQueue` 不建组、不抛错、票保留；重开后恢复匹配。
4. **client**：`modeEnabled('doudizhu')` 随 `games.doudizhu.enabled` 变化；大厅关闭斗地主后不渲染入口；
   两个都关 ⇒ 空态文案 + **零张 `.lobby__level`**；缺 `games` ⇒ 斗地主可见。
5. **admin 静态闸**：`node scripts/verify-admin-static.mjs` 全绿（66/61/29/合计 61 + 重复键断言 +
   `lastEnabledGameWarning` 执行自证）。
6. **conformance**：`slice-14` 新判据在真栈通过；4 个硬编码 65 的切片改为 `CONFIG_KEYS.length`；
   `baselines.json` 按实测回填。
7. **全量**：`bash scripts/ci.sh` 七阶段通过；合并 master 后权威轮（ci + conformance + images）全绿。

## 6. 风险

- **键数断言面广**：除 protocol / admin 静态闸外，还有：
  - 4 个 conformance 切片硬编码 65（§3.6）；
  - `platform-config.service.test.ts` 的 `toHaveLength(65)` 与两份逐字清单；
  - 中文数字（`docs/design.md`「五十一键」、源码注释「六十五键」）——
    用 `grep -rnE '65|六十五|五十一'` 而不是只搜 `65`。
- **管理面静态闸**是「第二真源」风险点：`CONFIG_IA`、`IA_KEY_SET`、`CONFIG_CONTROLS`、`BOOL_KEYS`
  四处都要同步；`IA_KEY_SET` 漏改不会被现有静态闸抓到（已加重复/集合断言）。
- **conformance 基线**：新增断言后旧基线会报「未回填」；按实测回填，不做预测。
- **大厅空态**：两个玩法全关是允许态，必须保证不白屏、无档位卡、有提示。
- **旧客户端**：旧服务端无 `games` ⇒ 斗地主可见；新服务端关斗地主后旧客户端仍能建房（服务端 12012 兜底），
  但大厅入口仍显示 —— 已知边界。
- **在线客户端**：不自动重拉配置（D12）。
- **`docs/design.md` 跑得快 14 键缺失**：本任务不补（D13），只修计数与 ddz 键。

## 7. 涉及文件

**改**

- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`
- `packages/config-service/src/migrations/1796500000000-DdzEnabledSeed.ts`（新）
- `packages/config-service/test/helpers/config-probe.ts`
- `packages/config-service/test/platform-config.service.test.ts`
- `packages/config-service/test/admin.controller.test.ts`
- `packages/config-service/test/config.rpc.test.ts`
- `packages/config-service/test/client-config.test.ts`、`migration.test.ts`
- `packages/room-service/src/config/config-cache.service.ts`
- `packages/room-service/src/match/match.service.ts`（D11 暂停匹配）
- `packages/room-service/test/helpers/config-cache.stub.ts`
- `packages/room-service/test/config-cache.test.ts`、匹配/建房相关测试
- `apps/client/src/pages/lobby/lobby.vue`（空态 + 档位区门控）
- `apps/client/test/lobby-modes.test.ts`（或新增客户端门控测试）
- `admin/app.js`、`admin/style.css`
- `scripts/verify-admin-static.mjs`
- `tools/conformance/src/slices/slice-14-config-center.ts`
- `tools/conformance/src/slices/slice-18-gold-room.ts`
- `tools/conformance/src/slices/slice-22-pay-channel.ts`
- `tools/conformance/src/slices/slice-23-notify-channel.ts`
- `tools/conformance/src/slices/slice-24-ads-relief.ts`
- `tools/conformance/baselines.json`
- `docs/design.md`（计数 + ddz 键）
- 本 spec

## 8. 审查记录

### 2026-10-24 设计对抗审查（独立评审员，只读）

**阻断（已全部修入本 spec）**

- B1 `IA_KEY_SET` 未纳入 `headerKeys` ⇒ 未分组重复控件；已修 §3.5.2。
- B2 4 个 conformance 切片硬编码 65 键（slice-18/22/23/24，共 5 处）⇒ 新栈必红；已修 §3.6/§7。
- B3 `verify-admin-static.mjs` 分类合计 `28+2+30=60` 未改 ⇒ 必红；已修 §3.5.7。
- B4 改造共享 `#modal` 的回归面（submit handler 永远返回字符串、prompt 不复位 input、焦点问题）；
  改用现有原生 `confirm()` 先例 ⇒ 已修 D9/§3.5.4，不再触碰共享弹窗。

**高（已处置）**

- H1 config-service 4 处 65 键副本（config-probe / platform-config / admin.controller / config.rpc）
  ⇒ 已列入 §5.2/§7。
- H2 两玩法全关时右侧档位卡仍可点 ⇒ 已修 D7/§3.4，并加零档位卡断言。
- H3 关闭玩法后旧队列每 tick 抛 12012、日志风暴、票冻结 ⇒ 新增 D11 与 §3.3.2（匹配扫描暂停）。
- H4 管理面缺键显示成「已关闭」、加载失败仍可写 ⇒ 已修 §3.5.4（按默认显示 + 禁用）。
- H5 静态闸无法证明「页签内不重复」⇒ 已加重复键断言与 pdk 归属断言（§3.5.7）。
- H6 admin 里不存在 `GAME_MODES` ⇒ 改为从 `IA_DOMAINS.headerKeys` 推导 + admin 内唯一 defaults 表（§3.5.4）。
- H7 room-service 测试桩是生产逻辑第二实现 ⇒ 桩增加 `doudizhuEnabled` 并镜像 switch（§5.3/§7）。
- H8 conformance 放置点/状态卫生 ⇒ 插在 C20 后、外层 finally 也恢复 ddz（§3.6）。
- H9 `POST /api/rooms` 不产生 12011（12011 只来自 WS `room.match`）⇒ 已改正换号理由（§3.6）。
- H10 文档是「五十一键」且缺 pdk 14 键 ⇒ 明确 D13 范围与 `grep -rnE '65|六十五|五十一'`（§6）。
- H11 管理面「最后一个开放玩法」判定无机械测试 ⇒ 抽纯函数 + `vm` 执行自证（§3.5.4/§3.5.7）。
- H12 在线客户端不自动重拉配置 ⇒ 登记为已知边界 D12（§3.4/§4）。

**低（已采纳）**：`rendered` 计入顶部卡、顶部卡 `data-key`、搜索态提示即时生效（文案）、
兜底文案成因改为 `CONFIG_NOTES`、补 CSS 落点、protocol 测试是逐字数组、清理过期「恒开」注释、
确认文案补「≤60s」、轮询上界 70s、ddz 测试显式 seed 与缺键用例分离。

**结论**：方向与最小改动成立；修订后无遗留阻断项。
