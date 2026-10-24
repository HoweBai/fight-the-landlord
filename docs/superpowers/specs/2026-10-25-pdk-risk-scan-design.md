# 风控扫描支持跑得快（paodekuai）· 设计 v1.0

> 用户裁决（2026-10-25）：
> - 跑得快的对局记录进入胜率风控；斗地主行为不变；
> - 阈值按玩法独立；不加 `game.paodekuai.risk.enabled`——有对局记录即自动纳入扫描；
> - 管理面能看到分玩法战绩；
> - 跑得快 2/4 人的胜率期望与 3 人不同：阈值可按玩法调，不做归一化。

## 1. 背景与问题

风控扫描自风控片起只统计斗地主两张表（`game_record_players` + `game_records`）。
2026-10-23 多玩法片接入跑得快后，战绩落在独立两表（`game_record_players_pdk` +
`game_records_pdk`，见 `1796300000000-PdkRecords.ts`），**扫描完全看不到**：
跑得快玩家无论胜率多高都不会进入审核队列。

2026-10-24 配置平行化已把斗地主风控两键迁到 `game.doudizhu.risk.*`
（`risk.winRateThreshold` / `risk.minGames` 只读回退）。跑得快没有任何风控键，
也没有扫描面。本片补齐这两处。

## 2. 范围

### 2.1 做

- protocol 新增 2 个配置键：
  - `game.paodekuai.risk.winRateThreshold`（number 0.5–1.0、≤2 位小数、默认 0.8）
  - `game.paodekuai.risk.minGames`（int 1–100000、默认 100）
- config-service 新迁移 `1796700000000-PdkRiskConfigSeed.ts`（两键种子 0.8 / 100，`down` 删除）。
- user-service 配置缓存新增跑得快两 getter：
  `game.paodekuai.risk.*` → `game.doudizhu.risk.*`（含旧键回退）→ 代码默认；
  跑得快新键存在但非法 ⇒ 代码默认，**不回退**。
- 扫描新增跑得快胜率 SQL；按玩法分别判定；任一玩法命中即算“胜率命中项”；
  两玩法同时命中**不叠加分数**；`reasons` 每个命中玩法各一条（带 `gameType`）。
- 管理面风控详情 `stats` 增加 `byGame`；顶层 `games/wins/winRate` = 两玩法合计；
  `deviceCount` 不变；admin 详情行显示总战绩 + 分玩法。
- admin IA 跑得快域新增「风控检测」页签（两新键）；控件/备注/计数/verifier 同步。
- 文档、conformance 键集与种子断言同步。
- 测试：protocol、config-service 迁移与种子、user config cache 回退、risk-scan、risk-admin、
  admin verifier、conformance lint；全量 turbo test/lint。

### 2.2 不做

- 不加 `game.paodekuai.risk.enabled`（用户裁决：有记录即扫描）。
- 不把设备命中（`risk.deviceLimit` / `risk.deviceWindowDays`）玩法化；仍为平台级。
- 不新增协议错误码；不改客户端 `/api/config` 形状（`CLIENT_CONFIG_KEYS` 仍 21 键）。
- 不改斗地主扫描 SQL 与斗地主判定行为（唯一差异：命中后 `reasons.detail` 多 `gameType:'doudizhu'`）。
- 不做 2/4 人胜率归一化（用户裁决；阈值按玩法调）。
- 不把跑得快战记录入斗地主表；两套表继续独立。
- 不改 `risk_reviews` 表结构（`reasons` 仍是 JSON 列，无迁移）。
- 不改客户端 App/H5 的展示（风控结果只影响登录/限流，已有链路）。

## 3. 方案对比与推荐

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 保留斗地主 SQL；新增一条跑得快 SQL；内存并集后按玩法分别判定 | 斗地主路径零改动；SQL 可独立钉全文；测试夹具可按玩法造数 | 每轮多一次 SQL（可接受：扫描 1h 一轮） |
| B | 把两条查询 `UNION ALL` 成一条，带 `gameType` 列 | 少一次往返 | 改动现有斗地主 SQL 文本；fake 库/全文断言全改；两表列不同，UNION 需补齐列，SQL 更脆 |
| C | 给两表加统一视图/新表 | 查询统一 | 新迁移 + 数据同步 + 回滚面，远超本片 |

**推荐 A**：与既有“SQL 常量全文钉死 + 假库按文本识别”的测试纪律一致，改动面最小。
代价只是每轮多一条 SQL；扫描默认 1h 一轮，数据量远未到需要合并查询的量级。

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新增 `game.paodekuai.risk.winRateThreshold` / `game.paodekuai.risk.minGames` 两键；不加 enabled | 用户裁决；有记录即扫描，避免“关了玩法就不查历史作弊”的盲区 |
| D2 | 跑得快读键顺序：`game.paodekuai.risk.*` 存在 ⇒ 校验后使用（非法 ⇒ 代码默认）；缺失 ⇒ `game.doudizhu.risk.*` getter（内部再走旧键 → 默认） | 用户裁决；部署窗口内跑得快键未种下时与斗地主同阈值，行为保守可解释 |
| D3 | 保留 `RISK_WIN_RATE_SQL`（斗地主）逐字不变；新增 `RISK_WIN_RATE_PDK_SQL` | 斗地主零破坏；SQL 全文可被测试钉死 |
| D4 | 判定按玩法独立：`games > 该玩法 minGames && winRate > 该玩法阈值`；`hit1 = 任一玩法命中` | 用户裁决；玩法间样本量/期望胜率不同，不能合并样本 |
| D5 | `score = (hit1 ? 25 : 0) + (hit2 ? 25 : 0)`；两玩法同时命中不叠加 | 用户裁决；继续沿用“命中项数 ×25”的两类语义，避免自动限流线被玩法数放大 |
| D6 | `reasons`：每个命中玩法一条 `{check:'winRate',detail:{gameType,games,wins,winRate}}`；设备 reason 不变；旧 reasons 缺 `gameType` 视为 `doudizhu` | 用户裁决；管理面/未来消费方可区分玩法；旧行原样可读 |
| D7 | 跑得快 SQL 过滤：`r.mode IN ('random','gold')`、`p.user_id IS NOT NULL`、`p.is_robot = 0`、`u.status='active'` | 与斗地主同口径：只统计真实玩家的免费/金币对局，跳过练习房、机器人与已封禁账号 |
| D8 | 管理详情 `stats.byGame` 恒含 `doudizhu` / `paodekuai` 两项（无记录也返回 0）；顶层 = 两玩法合计；`deviceCount` 不变 | 固定形状便于 admin 渲染；合计口径与现有字段兼容 |
| D9 | 管理详情跑得快 SQL 不带 `users.status` 过滤（沿用斗地主详情“诊断视图”口径），但带 `is_robot=0` | 封禁用户的战绩照常可诊断；机器人行不是玩家战绩 |
| D10 | 迁移 `1796700000000-PdkRiskConfigSeed.ts`：两键 `INSERT IGNORE`，version 1，`updated_by='seed'`；`down` 只删这两键 | 与既有种子迁移同形；可重跑、可回滚 |
| D11 | 计数：protocol `CONFIG_KEYS` 92、active 76、`CLIENT_CONFIG_KEYS` 21 不变；admin IA 76、简单控件 71、结构化 5；`CONFIG_NOTES` 62 | 机械闸必须与单一真源同步；跑得快新键纯服务端、不进客户端子集 |
| D12 | conformance slice-20 的 `risk.*` 键集断言扩为“平台 risk.* + 跑得快 risk.*”，种子数组加两键；总数仍用 `CONFIG_KEYS.length` | 只加键不写死数字，避免下次加键再红 |
| D13 | 回滚 runbook 只注明“跑得快风控两键可保留，无需旧键回填” | 两键没有旧平台对应键；旧镜像不读它们，保留无害 |
| D14 | 文档计数与键表同步：`docs/design.md`、`docs/ops/first-deploy.md`、`docs/games/paodekuai.md`、`docs/client-protocol.md` | 机械闸之外的权威文档不能留 90/74 旧数 |

## 5. 实现设计

### 5.1 protocol（`packages/protocol/src/config.ts`）

- `CONFIG_KEYS` 在 `game.paodekuai.entryMultiplier` 之后、`currency.reliefThresholdCoins`
  之前插入两键（保持玩法键分组；总数 92）。
- 新增两个解析分派（替换现有两条 `game.doudizhu.risk.*` 显式 if，改为数组复用）：
  ```ts
  const GAME_RISK_WIN_RATE_KEYS: readonly ConfigKey[] = [
    'game.doudizhu.risk.winRateThreshold',
    'game.paodekuai.risk.winRateThreshold',
  ];
  const GAME_RISK_MIN_GAMES_KEYS: readonly ConfigKey[] = [
    'game.doudizhu.risk.minGames',
    'game.paodekuai.risk.minGames',
  ];
  // parseConfigValue 内：
  if (GAME_RISK_WIN_RATE_KEYS.includes(key)) return parseWinRateThreshold(value, key);
  if (GAME_RISK_MIN_GAMES_KEYS.includes(key)) return parseMinGames(value, key);
  ```
- 注释更新：原“以下 24 键”改为“以下 26 键”；两新键注明“跑得快风控（2026-10-25）”。
- `CLIENT_CONFIG_KEYS` 不变（21 键）。`LEGACY_CONFIG_KEYS` 不变（16 键）。

### 5.2 config-service

#### 新迁移 `src/migrations/1796700000000-PdkRiskConfigSeed.ts`

```ts
export class PdkRiskConfigSeed1796700000000 implements MigrationInterface {
  name = 'PdkRiskConfigSeed1796700000000';
  // up: 两条 INSERT IGNORE INTO platform_config (key, value, version, updated_at, updated_by)
  //     VALUES ('game.paodekuai.risk.winRateThreshold', '0.8', 1, NOW(3), 'seed') 等
  // down: DELETE FROM platform_config WHERE key IN (两键)
}
```
- 值按 `JSON.stringify` 落库：`'0.8'`、`'100'`。
- `INSERT IGNORE` 可重跑；不覆盖运营已改值（与 `1796600000000` 同纪律）。

#### 测试夹具/计数

- `packages/config-service/test/helpers/config-probe.ts` 的 `SEED` 追加两键（0.8 / 100）。
- `packages/config-service/test/platform-config.service.test.ts` 的 `SEED` 追加两键；
  `expect(rows).toHaveLength(90)` → 92。
- `packages/config-service/test/admin.controller.test.ts` 标题 90 → 92（断言用 `CONFIG_KEYS` 自动跟随）。
- `packages/config-service/test/client-config.test.ts` 标题“90 键键名” → “92 键键名”（断言遍历 `CONFIG_KEYS`）。
- `packages/config-service/src/config/client-config.controller.ts` 注释“90 键齐全” → 92。
- `packages/config-service/test/migration.test.ts` 新增 `PdkRiskConfigSeed1796700000000` 的
  up/down/幂等/形状/时间戳唯一性用例（照 `DdzEnabledSeed` 先例）。
- 真 MySQL 冒烟（若 Docker 可用）：迁移后 `SELECT COUNT(*) FROM platform_config` = 92，
  抽查两键值。

### 5.3 user-service 配置缓存（`src/config/config-cache.service.ts`）

新增两个 getter（命名与现有 `riskWinRateThreshold` 对齐）：

```ts
riskPaodekuaiWinRateThreshold(): number;
riskPaodekuaiMinGames(): number;
```

读取规则（D2）：

1. `snapshot` 含 `game.paodekuai.risk.winRateThreshold`（`Object.hasOwn`）：
   - 合法（与 `parseWinRateThreshold` 同口径：number、0.5–1、≤2 位小数）⇒ 原值；
   - 非法 ⇒ `RISK_WIN_RATE_THRESHOLD_DEFAULT`（0.8），**不回退斗地主键**。
2. 缺失 ⇒ 返回 `this.riskWinRateThreshold()`（斗地主新键 → 旧 `risk.winRateThreshold` → 0.8）。
3. `riskPaodekuaiMinGames()` 同形（合法 int 1–100000；缺失 ⇒ `this.riskMinGames()`）。

实现上抽一个 `hasSnapshotKey(key: ConfigKey): boolean` 与
`normalizeWinRate(value)` / `normalizeMinGames(value)` 私有方法，避免三份校验复制；
斗地主现有两 getter 改为复用同一 normalize（行为逐字不变）。

### 5.4 扫描（`src/risk/scan.service.ts`）

#### SQL 常量

保留 `RISK_WIN_RATE_SQL` 逐字不变。新增：

```ts
export const RISK_WIN_RATE_PDK_SQL =
  "SELECT p.user_id, COUNT(*) AS games, SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id JOIN users u ON u.id = p.user_id AND u.status = 'active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL AND p.is_robot = 0 GROUP BY p.user_id";
```

> 行形状与斗地主 SQL1 相同：`{ user_id, games, wins }`；COUNT/SUM 可能是字符串 ⇒ `Number()` 归一。

#### 单轮流程（`runScanWork`）

1. 现读四个阈值：斗地主 `riskMinGames()` / `riskWinRateThreshold()`，
   跑得快 `riskPaodekuaiMinGames()` / `riskPaodekuaiWinRateThreshold()`。
2. 依次查询：斗地主 SQL → 跑得快 SQL → 设备 SQL（**查询顺序固定**，测试逐条钉）。
3. 并集结构：
   ```ts
   interface GameWinStat { games: number; wins: number }
   // Map<userId, { byGame: { doudizhu?: GameWinStat; paodekuai?: GameWinStat }; devices: number }>
   ```
   - 斗地主行写 `byGame.doudizhu`；
   - 跑得快行写 `byGame.paodekuai`；
   - 设备行只补 `devices`（新用户 ⇒ 两个 byGame 都缺省）。
4. 逐用户判定：
   ```ts
   const ddzHit = ddz !== undefined && ddz.games > ddzMinGames && ddz.wins / ddz.games > ddzThreshold;
   const pdkHit = pdk !== undefined && pdk.games > pdkMinGames && pdk.wins / pdk.games > pdkThreshold;
   const hit1 = ddzHit || pdkHit;
   const hit2 = devices > deviceLimit;
   const score = (hit1 ? 25 : 0) + (hit2 ? 25 : 0);
   ```
   - reasons 顺序：斗地主（若命中）→ 跑得快（若命中）→ 设备（若命中）。
   - 每条胜率 reason：
     `{ check:'winRate', detail:{ gameType:'doudizhu'|'paodekuai', games, wins, winRate } }`。
   - 设备 reason 逐字不变：`{ check:'devices', detail:{ devices } }`。
5. `applyScanResult(userId, score, reasons, now)` 与失败隔离、全量失败判据、自愈、水位、
   指标全部不变。

#### 注释

- 类注与 `RISK_WIN_RATE_SQL` 注释补“SQL1（斗地主）/ SQL1b（跑得快）”。
- `ScanReason` 注释补 `detail.gameType` 契约；旧行缺省 = doudizhu（仅供未来消费方）。

### 5.5 管理面详情（`src/risk/admin-risk.service.ts`）

新增常量（单用户；诊断视图不带 `users.status`，带 `is_robot = 0`）：

```ts
export const RISK_STATS_PDK_SQL =
  "SELECT COUNT(*) AS games, COALESCE(SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END), 0) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id WHERE p.user_id = ? AND r.mode IN ('random', 'gold') AND p.is_robot = 0";
```

`RiskUserDetail.stats` 形状：

```ts
stats: {
  games: number;       // 两玩法合计
  wins: number;        // 两玩法合计
  winRate: number;     // wins / games（games=0 ⇒ 0）
  deviceCount: number; // 不变
  byGame: {
    doudizhu: { games: number; wins: number; winRate: number };
    paodekuai: { games: number; wins: number; winRate: number };
  };
}
```

- `getUserDetail` 先查斗地主 `RISK_STATS_SQL`，再查 `RISK_STATS_PDK_SQL`，再查设备窗口。
- 无行 ⇒ 0（COUNT 恒回一行；COALESCE 兜 SUM）。
- 顶层 `winRate` 用合计值重算，不平均两个玩法胜率。

### 5.6 admin（`admin/app.js` + `scripts/verify-admin-static.mjs`）

#### IA / 控件 / 备注

- `CONFIG_IA` 跑得快域新增页签：
  ```js
  {
    id: 'risk',
    name: '风控检测',
    keys: [
      'game.paodekuai.risk.winRateThreshold',
      'game.paodekuai.risk.minGames',
    ],
  }
  ```
- `CONFIG_CONTROLS` 增加两条 number：
  - `game.paodekuai.risk.winRateThreshold`：label「胜率阈值」、`step: 0.01`、无 suffix；
  - `game.paodekuai.risk.minGames`：label「扫描最少局数」、无 suffix。
- `CONFIG_NOTES` 增加两条（运营口吻，说明“仅跑得快、与斗地主独立、两玩法同时命中不叠加分数、
  自动限流仍看 50 分线”）。
- 计数更新：protocol 92、active 76、IA 76、简单控件 71（34 bool + 2 text + 35 number）、
  structured 5、notes 62。
- 详情行：
  - 总战绩行文案改为 `总战绩：${games} 局 / ${wins} 胜 · 胜率 ${winRate} · 窗口内设备 ${deviceCount}`；
  - 新增一行 `分玩法：斗地主 X 局 / Y 胜 · 胜率 Z；跑得快 X 局 / Y 胜 · 胜率 Z`
    （games=0 时胜率显示 `—`；全部 textContent，无 innerHTML）。
- 玩家详情页（`showPlayerDetail`）沿用顶层合计值，不改形状；可选把文案改成“对局/胜场（含合计）”。

#### verifier

- `protoSet.size === 92`、`activeProtoSet.size === 76`、`iaKeySet.size === 76`。
- pdk 域页签断言从五页签改为六页签（`rules/scoring/switches/rooms/goldEconomy/risk`），
  并断言 pdk 域含两新键。
- `CONFIG_CONTROLS` 条目 71；`NUMBER_SUFFIX` 35 键（加两新键，suffix `''`）；
  布尔 34 + 文本 2 + 数字 35 = 71；`76 键 = 71 简单 ∪ 5 结构化`。
- 断言 pdk 胜率阈值 `step: 0.01` 且不带 suffix。
- `CONFIG_NOTES` 含两新键（以 `balancedBlock` 取块后 includes 两键）。
- 详情渲染源码断言含 `分玩法` 与 `byGame`（防只改服务端不改 UI）。

### 5.7 conformance（`tools/conformance/src/slices/slice-20-risk-control.ts`）

- 新增键常量：
  `K_PDK_WIN_RATE = 'game.paodekuai.risk.winRateThreshold'`、
  `K_PDK_MIN_GAMES = 'game.paodekuai.risk.minGames'`。
- `RISK_SEED_VALUES` 追加 `[K_PDK_WIN_RATE, 0.8]`、`[K_PDK_MIN_GAMES, 100]`（共 10 项）。
- ① 组的键集过滤扩为：
  ```ts
  const g1RiskKeys = g1Keys
    .filter((k) => k.startsWith('risk.') || k.startsWith('game.paodekuai.risk.'))
    .sort();
  ```
  期望集仍由数组拼出（10 种子 + 2 节奏 + 2 后片键 = 14），断言文案同步；
  总数断言继续用 `TOTAL_CONFIG_KEYS = CONFIG_KEYS.length`（自动 92）。
- step 文案中写死的“65 键”改为模板 `${TOTAL_CONFIG_KEYS}`。
- 跑得快扫描本身在 slice-20 不造 PDK 记录（PDK 对局造数另属多玩法 slice），
  本片只补配置种子与键集；扫描行为由 user-service 单测覆盖。

### 5.8 文档

- `docs/design.md`：
  - §7.5 风险键表加两行（默认 0.8 / 100，消费者 user-service，说明按玩法独立）；
  - 所有“90 键（74 active + 16 旧键）”计数改 92 / 76；
  - §7.5 消费者段与 §2.2 概览补“跑得快风控两键”。
- `docs/games/paodekuai.md` §7.1：加两行，并注明“有对局记录即自动纳入风控扫描，
  无 enabled 键；与斗地主阈值独立；2/4 人胜率期望不同，不做归一化”。
- `docs/ops/first-deploy.md` 风险表：加两行，说明两玩法分别判定、合并不叠分。
- `docs/client-protocol.md`：“90 键之一” → “92 键之一”。
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`：§5 加一句
  “`game.paodekuai.risk.*` 为新增专有键，无旧键对应；回滚时保留即可，无需回填”。
- `admin/app.js` 两键备注。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 跑得快新键缺失（迁移未跑/旧快照） | 回退斗地主 `risk.*` getter（新键 → 旧键 → 0.8/100） |
| 跑得快新键存在但非法（类型/越界/三位小数） | 代码默认 0.8/100，**不回退斗地主键**（与 D2 一致） |
| 跑得快无对局记录 | SQL 返回空；该用户不因跑得快进入并集（设备行仍可带入） |
| 两玩法都命中 | `hit1` 只算一项（25 分）；`reasons` 两条 |
| 两玩法 + 设备都命中 | 50 分（25 + 25）；不会出现 75 |
| 跑得快练习房（practice） | SQL 过滤，不计入 |
| 跑得快机器人行（`is_robot=1`） | SQL 过滤，不计入 |
| 跑得快已封禁账号（`users.status='banned'`） | 扫描 SQL 过滤（与斗地主同口径）；管理详情仍可诊断 |
| 跑得快两表不存在 | 该轮 SQL 抛 ⇒ 整轮按失败处理（既有失败语义）；两表由 user-service 迁移 `1796300000000` 保证 |
| 管理详情无任何对局 | `byGame` 两玩法均 0；顶层 0 局、胜率 0 |
| 旧 `reasons` 缺 `gameType` | 原样透传/可读；按 doudizhu 解释（当前无消费方解析 reasons） |
| 回滚到旧镜像 | 跑得快风控两键保留；旧镜像不读，无回填动作 |

## 7. 测试判据

### 7.1 protocol

- `CONFIG_KEYS` 精确数组含两新键（位置在 pdk entryMultiplier 之后）；总数 92；
  `CLIENT_CONFIG_KEYS` 仍 21、`LEGACY_CONFIG_KEYS` 仍 16。
- 两新键 parser 正例/反例：
  - winRate：0.5 / 0.79 / 1 过；0.785 / 0.49 / 1.01 / `'0.8'` 拒，错误文案带新键名；
  - minGames：1 / 100000 过；0 / 100001 / 3.5 / `'100'` 拒，错误文案带新键名。
- 旧键 parser 仍可用。

### 7.2 config-service

- 新迁移：up 恰两条 `INSERT IGNORE`，键/值/version/updated_by 逐字；down 只删两键；
  重放幂等；迁移号 1796700000000 晚于 1796600000000 且全仓唯一。
- 种子夹具：`config-probe` 与 `platform-config.service.test` 的 SEED 均含两键；
  全量行数 92、键集 = SEED。
- admin `GET /api/admin/config` 键数 = `CONFIG_KEYS.length`（92）。
- 若 Docker 可用：真 MySQL 迁移后 92 行、抽查两键值；不可用则在报告中登记未跑及原因。

### 7.3 user config cache

- 跑得快两键存在且合法 ⇒ 原值（含边界 0.5 / 1、1 / 100000）。
- 跑得快键缺失 ⇒ 斗地主新键；斗地主新键缺失 ⇒ 旧键；全部缺失 ⇒ 0.8 / 100。
- 跑得快键存在但非法 ⇒ 代码默认，**不取斗地主键的值**（判别用例：pdk 坏值 + ddz 0.7 ⇒ 期望 0.8）。
- 斗地主现有 getter 行为不回归（现有用例保持绿）。

### 7.4 risk-scan

- SQL 常量全文：`RISK_WIN_RATE_SQL`（斗地主）逐字不变；
  `RISK_WIN_RATE_PDK_SQL` 逐字等于 spec §5.4。
- 查询顺序：`[斗地主 SQL, 跑得快 SQL, 设备 SQL, 自愈名单, open 计数]`；
  现有 `queries[0]/queries[1]` 断言同步更新（不得只改 fake）。
- 仅跑得快命中：score 25、reason 带 `gameType:'paodekuai'`。
- 按玩法阈值：同一跑得快行在 ddz 阈值下不命中、在 pdk 阈值下命中（反之亦然）。
- 跨玩法不聚合：斗地主低胜率 + 跑得快高胜率 ⇒ 只有跑得快命中（合计胜率即使更高也不影响）。
- 两玩法同时命中：score 25（无设备）/ 50（有设备）；reasons 两条 winRate + 一条 devices。
- 设备命中不变：无任何对局、devices > limit ⇒ score 25 + devices reason。
- 跑得快-only 用户进入并集并被调用 `applyScanResult`（score 0 也进）。
- 旧 reasons 形状（无 gameType）在 `ReviewsService` 直接调用路径仍原样落库（现有用例保留）。
- 现有全量失败/单用户失败/锁/自愈/指标用例保持绿。

### 7.5 risk-admin

- `RiskUserDetail.stats` 恒含 `byGame.doudizhu/paodekuai`；
  顶层 = 两玩法合计；`deviceCount` 不变。
- FakeRiskAdminDb 识别 `RISK_STATS_PDK_SQL`；详情查询顺序 ddz → pdk → device。
- 新用例：ddz 12/9 + pdk 5/4 ⇒ 总 17/13、byGame 各自正确。
- 既有详情形状用例更新 expected（byGame 补零），不得只改 fake 放宽断言。
- 旧 reasons（无 gameType）列表读口原样透传（既有用例保持）。

### 7.6 admin / conformance

- `pnpm verify:admin`：92 / 76 / 76；pdk 六页签；71 简单 + 5 结构化；
  35 数字键含两新键（suffix `''`）；pdk 胜率阈值 step 0.01；
  notes 含两键；详情渲染含 `byGame`/`分玩法`。
- `pnpm -C tools/conformance lint` 通过。
- slice-20 ① 组：`game.paodekuai.risk.*` 两键种子 0.8/100 逐值；键集 14；总数 `CONFIG_KEYS.length`。

### 7.7 全量

- `pnpm exec turbo run test lint --force`（Cached 不算真跑）。
- `pnpm verify:admin`、`pnpm -C tools/conformance lint`。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 跑得快扫描 SQL 慢/全表扫 | 1h 一轮、数据量小；`idx_pdk_user` 与 `uk_pdk_record_seat` 可支撑 JOIN/GROUP BY；后续量大再加索引 |
| 两玩法阈值语义被误解为“合并胜率” | 文档/管理备注写明按玩法独立；单测“跨玩法不聚合”判别 |
| 分数被玩法数放大 | D5 明确 hit1 只算一项；单测断言两玩法命中 score 仍 25（或 +设备 50） |
| 旧 reasons 兼容规则没有消费方 | 现有 admin 原样展示；契约写进注释/文档；新写入恒带 gameType |
| 机械闸计数遗漏 | 单一真源 `CONFIG_KEYS.length` + verifier 显式 92/76 + 全量搜索旧计数 |
| 迁移时间戳撞车 | 1796700000000，迁移测试全仓唯一断言 |
| 真库冒烟因 Docker paused 未跑 | 报告中登记；恢复后执行 §7.2 的冒烟 SQL |

## 9. 涉及文件

- `packages/protocol/src/config.ts`、`packages/protocol/src/config.test.ts`
- `packages/config-service/src/migrations/1796700000000-PdkRiskConfigSeed.ts`（新）
- `packages/config-service/src/config/client-config.controller.ts`（注释计数）
- `packages/config-service/test/migration.test.ts`、`helpers/config-probe.ts`、
  `platform-config.service.test.ts`、`admin.controller.test.ts`、`client-config.test.ts`
- `packages/user-service/src/config/config-cache.service.ts`
- `packages/user-service/src/risk/scan.service.ts`
- `packages/user-service/src/risk/admin-risk.service.ts`
- `packages/user-service/src/risk/reviews.service.ts`（仅注释契约）
- `packages/user-service/test/config-cache.test.ts`、`risk-scan.test.ts`、`risk-admin.test.ts`
- `admin/app.js`、`scripts/verify-admin-static.mjs`
- `tools/conformance/src/slices/slice-20-risk-control.ts`
- `docs/design.md`、`docs/games/paodekuai.md`、`docs/ops/first-deploy.md`、
  `docs/client-protocol.md`、`docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`
- 本 spec 的「审查记录」

## 10. 审查记录

（待第一轮独立对抗审查）
