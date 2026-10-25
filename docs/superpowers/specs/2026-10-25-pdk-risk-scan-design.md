# 风控扫描支持跑得快（paodekuai）· 设计 v1.1

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

> **基线发现（审查补记）**：当前 HEAD 的 conformance `slice-20` ① 组风控键集断言
> 已经因为平行化改名而红——`K_WIN_RATE`/`K_MIN_GAMES` 已改为 `game.doudizhu.risk.*`，
> 但实际集过滤仍是 `startsWith('risk.')`，且 legacy 两键仍在 `CONFIG_KEYS` 与种子中。
> 本片顺手把该断言改成与 `CONFIG_KEYS` 同一谓词生成，关闭这个既有红窗口。

## 2. 范围

### 2.1 做

- protocol 新增 2 个配置键：
  - `game.paodekuai.risk.winRateThreshold`（number 0.5–1.0、≤2 位小数、默认 0.8）
  - `game.paodekuai.risk.minGames`（int 1–100000、默认 100）
- config-service 新迁移 `1796700000000-PdkRiskConfigSeed.ts`（两键种子 0.8 / 100，
  version 起点 = 全表 MAX，`down` 删除）。
- user-service 配置缓存新增跑得快两 getter：
  `game.paodekuai.risk.*` → `game.doudizhu.risk.*`（含旧键回退）→ 代码默认；
  跑得快新键存在但非法 ⇒ 代码默认，**不回退**；`snapshot` 为 null 时安全回落。
- 扫描新增跑得快胜率 SQL；按玩法分别判定；任一玩法命中即算“胜率命中项”；
  两玩法同时命中**不叠加分数**；`reasons` 每个命中玩法各一条（带 `gameType`）。
- 管理面风控详情 `stats` 增加 `byGame`；顶层 `games/wins/winRate` = 两玩法合计；
  `deviceCount` 不变；admin 详情行显示总战绩 + 分玩法。
- admin IA 跑得快域新增「风控检测」页签（两新键）；控件/备注/计数/verifier 同步。
- 文档、conformance 键集与种子断言同步；关闭 slice-20 ① 的既有红窗口。
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
- 不改「玩家管理」列表页的 games/wins 口径（仍为斗地主；本片只把风控详情改为两玩法合计，
  差异登记在 §8）。

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
| D2 | 跑得快读键顺序：`game.paodekuai.risk.*` 存在 ⇒ 校验后使用（非法 ⇒ 代码默认）；缺失 ⇒ `game.doudizhu.risk.*` getter（内部再走旧键 → 默认）。**存在性判定必须 null-safe**：`snapshot !== null && Object.hasOwn(...)` | 用户裁决；部署窗口内跑得快键未种下时与斗地主同阈值；`snapshot=null` 时不得抛，`{value:null}` 算“存在但非法”⇒默认 |
| D3 | 保留 `RISK_WIN_RATE_SQL`（斗地主）逐字不变；新增 `RISK_WIN_RATE_PDK_SQL` | 斗地主零破坏；SQL 全文可被测试钉死 |
| D4 | 判定按玩法独立：`games > 该玩法 minGames && winRate > 该玩法阈值`；`hit1 = 任一玩法命中` | 用户裁决；玩法间样本量/期望胜率不同，不能合并样本 |
| D5 | `score = (hit1 ? 25 : 0) + (hit2 ? 25 : 0)`；两玩法同时命中不叠加 | 用户裁决；继续沿用“命中项数 ×25”的两类语义，避免自动限流线被玩法数放大 |
| D6 | `reasons`：每个命中玩法一条 `{check:'winRate',detail:{gameType,games,wins,winRate}}`；设备 reason 不变；旧 reasons 缺 `gameType` 视为 `doudizhu` | 用户裁决；管理面/未来消费方可区分玩法；旧行原样可读 |
| D7 | 跑得快 SQL 过滤：`r.mode IN ('random','gold')`、`p.user_id IS NOT NULL`、`p.is_robot = 0`、`u.status='active'` | 与斗地主同口径：只统计真实玩家的免费/金币对局，跳过练习房、机器人与已封禁账号 |
| D8 | 管理详情 `stats.byGame` 恒含 `doudizhu` / `paodekuai` 两项（无记录也返回 0）；顶层 = 两玩法合计；`deviceCount` 不变 | 固定形状便于 admin 渲染；合计口径与现有字段兼容 |
| D9 | 管理详情跑得快 SQL 不带 `users.status` 过滤（沿用斗地主详情“诊断视图”口径），但带 `is_robot=0`；SQL 全文在测试侧独立誊写并 `toBe` | 封禁用户的战绩照常可诊断；机器人行不是玩家战绩；防止漏 `mode`/`is_robot` 仍假绿 |
| D10 | 迁移 `1796700000000-PdkRiskConfigSeed.ts`：先 `SELECT MAX(version)` 取全表全局 MAX（至少 1）作新键 version 起点；两条 `INSERT IGNORE`（或一条多值 INSERT），`updated_by='seed'`；`down` 只删这两键 | 与 `1796600000000-SplitGameConfig` 的版本纪律一致：避免新键从 1 起写、后续 PUT 永远推不动全局 version |
| D11 | 计数：protocol `CONFIG_KEYS` 92、active 76、`CLIENT_CONFIG_KEYS` 21 不变；admin IA 76、简单控件 71、结构化 5；`CONFIG_NOTES` **63**（实测基线 61，不是注释里的 60） | 机械闸必须与单一真源同步；跑得快新键纯服务端、不进客户端子集 |
| D12 | conformance slice-20 风控键集断言改为**与 `CONFIG_KEYS` 同一谓词**：`risk.*` + `game.doudizhu.risk.*` + `game.paodekuai.risk.*`；期望集 = `CONFIG_KEYS.filter(同一谓词)`（自动含 legacy 两键）；种子数组加两键；总数继续用 `CONFIG_KEYS.length` | 关闭既有红窗口；只加键不写死数字，避免下次加键再红 |
| D13 | 回滚 runbook 只注明“跑得快风控两键可保留，无需旧键回填” | 两键没有旧平台对应键；旧镜像不读它们，保留无害 |
| D14 | 文档计数与键表同步：`docs/design.md`、`docs/ops/first-deploy.md`、`docs/games/paodekuai.md`、`docs/client-protocol.md`；源码里仍在描述“全量 N 键”的注释同步 | 机械闸之外的权威文档不能留 90/74/89/73 旧数 |
| D15 | admin 新代码必须用 `d.stats?.byGame?.doudizhu?.games ?? 0` 形态；新 admin + 旧 user-service 的部署窗口下详情行不得崩 | runbook 升级顺序是 config-service/edge 先、消费者后；窗口内 `byGame` 不存在 |
| D16 | 跑得快 SQL 失败按**既有整轮失败语义**处理（fail-fast），不静默降级；在 §6/runbook 登记影响面 | 与现有“任一统计 SQL 抛 ⇒ runs{fail}、本轮不写”一致；两表由同一服务的迁移保证，缺表属于部署事故，应告警而不是静默少查一个玩法 |

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
- 注释更新：原“以下 24 键”改为“以下 26 键”；两新键注明“跑得快风控（2026-10-25）”；
  文件头“六十六键清单”改为“九十二键清单”。
- `CLIENT_CONFIG_KEYS` 不变（21 键）。`LEGACY_CONFIG_KEYS` 不变（16 键）。

### 5.2 config-service

#### 新迁移 `src/migrations/1796700000000-PdkRiskConfigSeed.ts`

```ts
export class PdkRiskConfigSeed1796700000000 implements MigrationInterface {
  name = 'PdkRiskConfigSeed1796700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | null }>;
    const version = Math.max(1, Number(maxRows[0]?.maxVersion ?? 0));
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES (?, ?, ?, NOW(3), ?), (?, ?, ?, NOW(3), ?)',
      [
        'game.paodekuai.risk.winRateThreshold', JSON.stringify(0.8), version, 'seed',
        'game.paodekuai.risk.minGames', JSON.stringify(100), version, 'seed',
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE FROM `platform_config` WHERE `key` IN (?, ?)',
      ['game.paodekuai.risk.winRateThreshold', 'game.paodekuai.risk.minGames'],
    );
  }
}
```
- `INSERT IGNORE` 可重跑；不覆盖运营已改值（与 `1796600000000` 同纪律）。
- 若表为空 ⇒ MAX 为 null ⇒ version 1。

#### 测试夹具/计数

- `packages/config-service/test/helpers/config-probe.ts` 的 `SEED` 追加两键（0.8 / 100）。
- `packages/config-service/test/platform-config.service.test.ts` 的 `SEED` 追加两键；
  标题“九十键”改“九十二键”；`expect(rows).toHaveLength(90)` → 92。
- `packages/config-service/test/admin.controller.test.ts` 标题 90 → 92（断言用 `CONFIG_KEYS` 自动跟随）。
- `packages/config-service/test/client-config.test.ts` 标题“90 键键名” → “92 键键名”（断言遍历 `CONFIG_KEYS`）。
- `packages/config-service/src/config/client-config.controller.ts` 注释“90 键齐全” → 92。
- `packages/config-service/test/migration.test.ts` 新增 `PdkRiskConfigSeed1796700000000` 用例：
  up 一条多值 `INSERT IGNORE`（键/值/version/updated_by 逐字，version = 假库 MAX）；
  down 只删两键；重放幂等；迁移号晚于 1796600000000 且全仓唯一。
- 真 MySQL 冒烟（若 Docker 可用）：迁移后 `SELECT COUNT(*) FROM platform_config` = 92，
  抽查两键值；不可用则报告中登记未跑及原因。

### 5.3 user-service 配置缓存（`src/config/config-cache.service.ts`）

新增两个 getter：

```ts
riskPaodekuaiWinRateThreshold(): number;
riskPaodekuaiMinGames(): number;
```

读取规则（D2，**必须 null-safe**）：

1. `hasSnapshotKey(key)` = `this.snapshot !== null && Object.hasOwn(this.snapshot, key)`。
2. `snapshot` 含 `game.paodekuai.risk.winRateThreshold`：
   - 合法（number、0.5–1、≤2 位小数）⇒ 原值；
   - 非法（含 `null` / `undefined` / 类型漂移 / 越界 / 三位小数）⇒
     `RISK_WIN_RATE_THRESHOLD_DEFAULT`（0.8），**不回退斗地主键**。
3. 缺失（含 `snapshot === null`）⇒ 返回 `this.riskWinRateThreshold()`
   （斗地主新键 → 旧 `risk.winRateThreshold` → 0.8）。
4. `riskPaodekuaiMinGames()` 同形（合法 int 1–100000；缺失 ⇒ `this.riskMinGames()`）。

实现上抽 `hasSnapshotKey` / `normalizeWinRate` / `normalizeMinGames` 私有方法；
斗地主现有两 getter 改为复用同一 normalize，**行为逐字不变**（用 D7.3 的回归用例钉住）。

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
6. **跑得快 SQL 抛 ⇒ 整轮失败**（与斗地主 SQL 同语义）：`runs{fail}`、不刷
   `last_success`、锁照常释放、逐用户循环不执行。补一条用例钉住。

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

- `CONFIG_IA` 跑得快域新增页签（放在 `goldEconomy` 之后）：
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
  自动限流仍看 50 分线、2/4 人胜率期望不同可按玩法调”）。
- 计数更新：protocol 92、active 76、IA 76、简单控件 71（34 bool + 2 text + 35 number）、
  structured 5、notes **63**；`admin/app.js` 相关注释同步（含“跑得快 14 键”改 16 键）。
- 详情行（**必须可选链**，D15）：
  - 总战绩行文案改为 `总战绩：${games} 局 / ${wins} 胜 · 胜率 ${winRate} · 窗口内设备 ${deviceCount}`；
  - 新增一行 `分玩法：斗地主 X 局 / Y 胜 · 胜率 Z；跑得快 X 局 / Y 胜 · 胜率 Z`
    （games=0 时胜率显示 `—`；全部 textContent，无 innerHTML；用
    `d.stats?.byGame?.doudizhu?.games ?? 0` 形态）。
- 玩家详情页（`showPlayerDetail`）的“对局/胜场”文案改为“对局/胜场（两玩法合计）”，
  不改列表页口径（§8 登记差异）。

#### verifier

- `protoSet.size === 92`、`activeProtoSet.size === 76`、`iaKeySet.size === 76`。
- pdk 域页签断言从五页签改为六页签（`rules/scoring/switches/rooms/goldEconomy/risk`），
  并断言 pdk 域含两新键。
- `CONFIG_CONTROLS` 条目 71；`NUMBER_SUFFIX` 35 键（加两新键，suffix `''`）；
  布尔 34 + 文本 2 + 数字 35 = 71；`76 键 = 71 简单 ∪ 5 结构化`。
- 断言 pdk 胜率阈值 `step: 0.01` 且不带 suffix。
- `CONFIG_NOTES` 含两新键（以 `balancedBlock` 取块后 includes 两键）。
- 详情渲染断言**限定在 `functionBody(app, 'function renderRiskDetail')` 块内**，
  检查 `byGame` 与 `分玩法`（防止备注/注释满足全局 `includes` 假绿）。

### 5.7 conformance（`tools/conformance/src/slices/slice-20-risk-control.ts`）

- 新增键常量：
  `K_PDK_WIN_RATE = 'game.paodekuai.risk.winRateThreshold'`、
  `K_PDK_MIN_GAMES = 'game.paodekuai.risk.minGames'`。
- `RISK_SEED_VALUES` 追加 `[K_PDK_WIN_RATE, 0.8]`、`[K_PDK_MIN_GAMES, 100]`（共 10 项）。
- ① 组键集断言重写为同一谓词：
  ```ts
  const isRiskKey = (k: string) =>
    k.startsWith('risk.') ||
    k.startsWith('game.doudizhu.risk.') ||
    k.startsWith('game.paodekuai.risk.');
  const g1RiskKeys = g1Keys.filter(isRiskKey).sort();
  const expectedRiskKeys = CONFIG_KEYS.filter(isRiskKey).sort();
  checks.that(
    fieldSetViolations(g1RiskKeys, expectedRiskKeys).length === 0,
    `① 风控键集 = CONFIG_KEYS 中 risk.* + 两玩法 risk.*（共 ${expectedRiskKeys.length}）—— 实际 ${JSON.stringify(g1RiskKeys)}`,
  );
  ```
  `expectedRiskKeys` 自动含 legacy `risk.winRateThreshold` / `risk.minGames`，不再手工拼期望集。
- 总数断言继续用 `TOTAL_CONFIG_KEYS = CONFIG_KEYS.length`（自动 92）；
  step 文案中写死的“65 键”改为模板 `${TOTAL_CONFIG_KEYS}`。
- 同步注释/标题：文件头“65 键/8 风险键”、`:130`“八风险键…收尾复原值”、
  `:737`“恰十二”、`:742`“八风险键种子逐值”全部改为新计数/新表述
  （10 个种子 + 2 节奏 + 2 后片键 + 2 legacy = 16 个风控键）。
- 跑得快扫描本身在 slice-20 不造 PDK 记录（PDK 对局造数另属多玩法 slice），
  本片只补配置种子与键集；扫描行为由 user-service 单测覆盖。

### 5.8 文档与源码计数注释

- `docs/design.md`：
  - §2.1 表（:143）与 §4.2/§7.5/§7.10 等所有“90 键（74 active + 16 旧键）”改 92 / 76；
  - **旧一代“89 键（73 active + 16 旧键）”四处**（:533、:540、:1225）改 92 / 76；
  - `:1526`“配置中心 90 键之一”改 92；
  - §7.5 风险键表加两行（默认 0.8 / 100，消费者 user-service，说明按玩法独立）；
  - `:1289`“跑得快 7 键”改“跑得快 9 键”（+风控两键），并补 2026-10-25 说明；
  - §7.5 消费者段补“跑得快风控两键”。
- `docs/ops/first-deploy.md`：
  - `:1016`“89 键配置（73 active + 16 只读旧键）”改 92 / 76；
  - 风险表加两行，说明两玩法分别判定、合并不叠分。
- `docs/games/paodekuai.md` §7.1：加两行，并注明“有对局记录即自动纳入风控扫描，
  无 enabled 键；与斗地主阈值独立；2/4 人胜率期望不同，不做归一化”。
- `docs/client-protocol.md`：“90 键之一” → “92 键之一”。
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`：§5 加一句
  “`game.paodekuai.risk.*` 为新增专有键，无旧键对应；回滚时保留即可，无需回填”。
- 源码里仍在描述当前全量的计数注释同步为 92（不作为历史记录）：
  `packages/protocol/src/config.ts` 文件头“六十六键”、
  `packages/config-service/src/config/admin.controller.ts:101`、
  `platform-config.entity.ts:10`、`platform-config.service.ts:45/57`、
  `packages/api-gateway/src/gateway/gateway.controller.ts:146`、
  `packages/room-service/src/gateway/config.client.ts:21`、`rpc.options.ts:35`、
  `packages/robot-service/src/config/config.client.ts:14`、
  `packages/user-service/src/config/config.client.ts:15`、
  `admin/app.js:120/1230`。
  历史迁移里“五十一键之一”一类过往表述保留不动。

### 5.9 PDK 真栈 conformance 补强（2026-10-25 追加）

> 动因：slice-20 不造 PDK 对局，PDK 扫描 SQL 目前只有假库单测；补一条真栈断言。

- **扩展现有 `slice-29-paodekuai`**（不新造数据）：它已经用 `room.match mode:'random'`
  打完一局真实 PDK 并等到 `/api/records/mine?gameType=paodekuai` 可见，正好满足
  “mode ∈ random/gold + 有记录”的扫描条件。
- 步骤：
  1. 记录断言补 `record.mode === 'random'`（证明进入扫描 mode 过滤面）；
  2. 管理面 PUT `game.paodekuai.risk.minGames=1`、`winRateThreshold=0.5`、
     `risk.scanIntervalMs=5000`；
  3. `docker restart ftl-user-service` + 轮询 healthy（首轮 30s、其后 5s 一轮）；
  4. 以 `winnerSeats[0]` 映射到 `room.bySeat` 的 winner user，轮询
     `GET /api/admin/risk/users/:winnerId` ≤90s；
  5. 断言 `entries[0].reasons` 含
     `{check:'winRate',detail:{gameType:'paodekuai',games:1,wins:1,winRate:1}}`；
     `stats.byGame.paodekuai = {games:1,wins:1}`、`stats.byGame.doudizhu.games=0`、
     顶层 `stats.games=1`、`entries[0].score=25`；
  6. dismiss 该条目（清理）；`finally` 还原三键（`minGames=100`、`winRateThreshold=0.8`、
     `scanIntervalMs=3600000`）。扫描间隔回 1h 由下一轮重排自愈，**无需再重启**。
- **不改生产代码**；新增 13 条断言，`baselines.json` 的 `full['slice-29-paodekuai']`
  55 → 68（静态核算；CI 权威轮复核实测值）。
- 真栈执行证据来自 master 推送的 conformance（或部署后的本机跑）；本机 Docker paused
  时只做 `tsc` lint/build。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 跑得快新键缺失（迁移未跑/旧快照） | 回退斗地主 `risk.*` getter（新键 → 旧键 → 0.8/100） |
| 跑得快新键存在但非法（类型/越界/三位小数/`null`） | 代码默认 0.8/100，**不回退斗地主键**（与 D2 一致） |
| `snapshot === null`（config-service 不可达） | 两 getter 安全回落斗地主 getter → 默认；不抛 TypeError |
| 跑得快无对局记录 | SQL 返回空；该用户不因跑得快进入并集（设备行仍可带入） |
| 两玩法都命中 | `hit1` 只算一项（25 分）；`reasons` 两条 |
| 两玩法 + 设备都命中 | 50 分（25 + 25）；不会出现 75 |
| 跑得快练习房（practice） | SQL 过滤，不计入 |
| 跑得快机器人行（`is_robot=1`） | SQL 过滤，不计入 |
| 跑得快已封禁账号（`users.status='banned'`） | 扫描 SQL 过滤（与斗地主同口径）；管理详情仍可诊断 |
| 跑得快 SQL / 两表不可用 | 整轮按失败处理（`runs{fail}`、不刷 `last_success`、告警可见）；两表由 user-service 迁移 `1796300000000` 保证，缺表属部署事故 |
| 管理详情无任何对局 | `byGame` 两玩法均 0；顶层 0 局、胜率 0 |
| 旧 `reasons` 缺 `gameType` | 原样透传/可读；按 doudizhu 解释（当前无消费方解析 reasons） |
| 新 admin + 旧 user-service | 详情行用可选链；`byGame` 缺失时显示 0 / `—`，不崩 |
| 回滚到旧镜像 | 跑得快风控两键保留；旧镜像不读，无回填动作 |

**已知限制（预登记）**：

- **dismissed 同分抑制**：状态机只在 `score > latest.score` 时复活。两玩法先后命中但
  `score` 都是 25 ⇒ 不会因“第二种玩法也命中”而重新 open（与 D5 不叠分一致）。
- **自动限流**：两玩法同时命中仍只有 25 分；要触发 50 分线必须有设备命中。
- **玩家管理列表口径**：列表页 games/wins 仍只算斗地主；风控详情改为两玩法合计，
  详情文案标注“两玩法合计”。列表页口径另立片（若有需要）。

## 7. 测试判据

### 7.1 protocol

- `CONFIG_KEYS` 精确数组含两新键（位置在 pdk entryMultiplier 之后）；总数 92；
  `CLIENT_CONFIG_KEYS` 仍 21、`LEGACY_CONFIG_KEYS` 仍 16。
- 两新键 parser 正例/反例：
  - winRate：0.5 / 0.79 / 1 过；0.785 / 0.49 / 1.01 / `'0.8'` 拒，错误文案带新键名；
  - minGames：1 / 100000 过；0 / 100001 / 3.5 / `'100'` 拒，错误文案带新键名。
- 旧键 parser 仍可用。

### 7.2 config-service

- 新迁移：up 先 `SELECT MAX(version)`，再一条多值 `INSERT IGNORE`；
  两键值 0.8/100、version = 假库全局 MAX（空表 ⇒ 1）、updated_by='seed'；
  down 只删两键；重放幂等；迁移号 1796700000000 晚于 1796600000000 且全仓唯一。
- 种子夹具：`config-probe` 与 `platform-config.service.test` 的 SEED 均含两键；
  全量行数 92、键集 = SEED。
- admin `GET /api/admin/config` 键数 = `CONFIG_KEYS.length`（92）。
- 若 Docker 可用：真 MySQL 迁移后 92 行、抽查两键值；不可用则在报告中登记未跑及原因。

### 7.3 user config cache

- 跑得快两键存在且合法 ⇒ 原值（含边界 0.5 / 1、1 / 100000）。
- 跑得快键缺失 ⇒ 斗地主新键；斗地主新键缺失 ⇒ 旧键；全部缺失 ⇒ 0.8 / 100。
- 跑得快键存在但非法 ⇒ 代码默认，**不取斗地主键的值**
  （判别用例：pdk `null` / 0.785 + ddz 0.7 ⇒ 期望 0.8；pdk 0 + ddz 50 ⇒ 100）。
- `snapshot === null` ⇒ 两 getter 返回 0.8 / 100，不抛。
- **斗地主回归判别**（重构共享 normalize 前先加）：
  ddz 新键 0.785 + 旧键 0.7 ⇒ 0.8（不回退旧键）；ddz 新键 0 + 旧键 50 ⇒ 100。
- 斗地主现有 getter 行为不回归（现有用例保持绿）。

### 7.4 risk-scan

- SQL 常量全文：`RISK_WIN_RATE_SQL`（斗地主）逐字不变；
  `RISK_WIN_RATE_PDK_SQL` 逐字等于 spec §5.4。
- 测试夹具同步（**必须列入任务，不得只改生产代码**）：
  - `FakeScanDb` 增加 `pdkWinRows` 字段与 `SPEC_RISK_WIN_RATE_PDK_SQL` 分支；
  - `makeScanConfig` 增加独立 `pdkMinGames` / `pdkWinRateThreshold` 覆盖（默认 100/0.8），
    否则 16 处 `mkSvc` 全部 `is not a function`；
  - `holdNextQuery` 用例（CAD）放行后要能继续走 PDK 查询。
- 查询顺序：`[斗地主 SQL, 跑得快 SQL, 设备 SQL, 自愈名单, open 计数]`；
  现有 `queries[0]/queries[1]` 断言同步更新为 `[0]` 斗地主、`[1]` 跑得快、`[2]` 设备。
- 斗地主 reasons 精确断言三处（命中矩阵 `u-both`/`u-win`、阈值现读用例）
  补 `gameType:'doudizhu'`；旧形状 `R25/R50` 输入 fixture 保持不变（代表旧行）。
- 仅跑得快命中：score 25、reason 带 `gameType:'paodekuai'`。
- 按玩法阈值：同一跑得快行在 ddz 阈值下不命中、在 pdk 阈值下命中（反之亦然）。
- 跨玩法不聚合：斗地主低胜率 + 跑得快高胜率 ⇒ 只有跑得快命中（合计胜率即使更高也不影响）。
- 两玩法同时命中：score 25（无设备）/ 50（有设备）；reasons 两条 winRate + 一条 devices。
- 设备命中不变：无任何对局、devices > limit ⇒ score 25 + devices reason。
- 跑得快-only 用户进入并集并被调用 `applyScanResult`（score 0 也进）。
- 跑得快 SQL 抛 ⇒ 整轮失败（runs{fail}、`last_success` 不推进、锁释放）。
- 现有全量失败/单用户失败/锁/自愈/指标/节奏用例保持绿。

### 7.5 risk-admin

- 测试侧**独立誊写** `SPEC_RISK_STATS_PDK_SQL` 并 `expect(RISK_STATS_PDK_SQL).toBe(...)`；
  至少覆盖 `p.user_id = ?`、`r.mode IN ('random', 'gold')`、`p.is_robot = 0` 三子句。
- `RiskUserDetail.stats` 恒含 `byGame.doudizhu/paodekuai`；
  顶层 = 两玩法合计；`deviceCount` 不变。
- FakeRiskAdminDb 识别 `RISK_STATS_PDK_SQL`（用独立誊写文本，不用 import 常量），
  并增加 `pdkWinStats` 映射；`reset()` 清理。
- 详情查询顺序 ddz → pdk → device。
- 新用例：ddz 12/9 + pdk 5/4 ⇒ 总 17/13、byGame 各自正确。
- 既有详情形状用例更新 expected（byGame 补零），不得只改 fake 放宽断言。
- 旧 reasons（无 gameType）列表读口原样透传（既有用例保持）。

### 7.6 admin / conformance

- `pnpm verify:admin`：92 / 76 / 76；pdk 六页签；71 简单 + 5 结构化；
  35 数字键含两新键（suffix `''`）；pdk 胜率阈值 step 0.01；
  notes 含两键；`renderRiskDetail` 函数体内含 `byGame` / `分玩法`。
- `pnpm -C tools/conformance lint` 通过。
- slice-20 ① 组：`game.paodekuai.risk.*` 两键种子 0.8/100 逐值；
  风控键集 = `CONFIG_KEYS.filter(isRiskKey)`（16 键，含 legacy 两键）；总数 `CONFIG_KEYS.length`。

### 7.7 全量

- `pnpm exec turbo run test lint --force`（Cached 不算真跑）。
- `pnpm verify:admin`、`pnpm -C tools/conformance lint`。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 跑得快扫描 SQL 慢/全表扫 | 1h 一轮、数据量小；`idx_pdk_user` 与 `uk_pdk_record_seat` 可支撑 JOIN/GROUP BY；后续量大再加索引 |
| 两玩法阈值语义被误解为“合并胜率” | 文档/管理备注写明按玩法独立；单测“跨玩法不聚合”判别 |
| 分数被玩法数放大 | D5 明确 hit1 只算一项；单测断言两玩法命中 score 仍 25（或 +设备 50） |
| 跑得快 SQL 失败拖垮整轮（含斗地主检测） | 已登记 D16/§6：保持 fail-fast 让部署事故可见；两表由同一服务迁移保证；不做静默降级 |
| 旧 reasons 兼容规则没有消费方 | 现有 admin 原样展示；契约写进注释/文档；新写入恒带 gameType |
| dismissed 用户不因第二种玩法命中而复活 | §6 已知限制；与“不叠分”一致，另立片才改状态机 |
| 新 admin + 旧 user-service 详情崩 | D15 可选链；详情行缺失字段按 0/`—` 渲染 |
| 玩家列表与风控详情口径不一致 | 详情文案标注“两玩法合计”；列表页另立片（§6 已知限制） |
| 机械闸计数遗漏 | 单一真源 `CONFIG_KEYS.length` + verifier 显式 92/76 + 全量搜索旧计数（含 89/73 一代） |
| 迁移时间戳撞车 | 1796700000000，迁移测试全仓唯一断言 |
| 真库冒烟因 Docker paused 未跑 | 报告中登记；恢复后执行 §7.2 的冒烟 SQL |

## 9. 涉及文件

- `packages/protocol/src/config.ts`、`packages/protocol/src/config.test.ts`
- `packages/config-service/src/migrations/1796700000000-PdkRiskConfigSeed.ts`（新）
- `packages/config-service/src/config/client-config.controller.ts`（注释计数）
- `packages/config-service/src/config/admin.controller.ts`、`platform-config.entity.ts`、
  `platform-config.service.ts`（仅计数注释）
- `packages/config-service/test/migration.test.ts`、`helpers/config-probe.ts`、
  `platform-config.service.test.ts`、`admin.controller.test.ts`、`client-config.test.ts`
- `packages/user-service/src/config/config-cache.service.ts`、`config/config.client.ts`（注释）
- `packages/user-service/src/risk/scan.service.ts`
- `packages/user-service/src/risk/admin-risk.service.ts`
- `packages/user-service/src/risk/reviews.service.ts`（仅注释契约）
- `packages/user-service/test/config-cache.test.ts`、`risk-scan.test.ts`、`risk-admin.test.ts`
- `packages/api-gateway/src/gateway/gateway.controller.ts`（仅计数注释）
- `packages/room-service/src/gateway/config.client.ts`、`rpc.options.ts`（仅计数注释）
- `packages/robot-service/src/config/config.client.ts`（仅计数注释）
- `admin/app.js`、`scripts/verify-admin-static.mjs`
- `tools/conformance/src/slices/slice-20-risk-control.ts`
- `tools/conformance/src/slices/slice-29-paodekuai.ts`、`tools/conformance/src/run.ts`、
  `tools/conformance/baselines.json`（2026-10-25 追加深栈断言）
- `docs/design.md`、`docs/games/paodekuai.md`、`docs/ops/first-deploy.md`、
  `docs/client-protocol.md`、`docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`
- 本 spec 的「审查记录」

## 10. 审查记录

### 10.1 第一轮独立对抗审查（2026-10-25）

审查者：独立子代理（sonnet），只报发现。共 16 条：3 高 / 9 中 / 4 低。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | slice-20 ① 键集断言当前已红：过滤只收 `risk.*`，期望集含 `game.doudizhu.risk.*`，且 legacy 两键不在期望集 | **已修**：D12/§5.7 改为同一 `isRiskKey` 谓词 + `CONFIG_KEYS.filter`；§1 登记既有红窗口 |
| 2 | 高 | `makeScanConfig` 未加新 getter，16 处 ScanService 用例会 TypeError | **已修**：§5.4/§7.4 明确加 `pdkMinGames`/`pdkWinRateThreshold` 独立覆盖 |
| 3 | 高 | `FakeScanDb` 未识别 PDK SQL 即 reject；`queries[1]` 断言会红 | **已修**：§7.4 明确新增 `pdkWinRows` 分支、独立 SQL 文本、三处索引位移 |
| 4 | 中 | 斗地主 reasons 加 `gameType` 会让三处 `toEqual` 精确断言红 | **已修**：§7.4 点名三处补 `gameType:'doudizhu'`；旧形状 fixture 保留 |
| 5 | 中 | `CONFIG_NOTES` 实际基线 61，目标应为 63 而非 62 | **已修**：D11/§5.6 改 63；`admin/app.js` 注释同步 |
| 6 | 中 | 快照 null / 键值 null 语义未定义，naive 实现会抛或错误回退 | **已修**：D2/§5.3/§7.3 明确 null-safe `hasSnapshotKey` 与两条判别用例 |
| 7 | 中 | 斗地主 getter 重构缺“新键非法 + 旧键合法 ⇒ 默认”回归断言 | **已修**：§7.3 新增两条 ddz 回归判别用例 |
| 8 | 中 | 文档漏“89 键（73 active）”旧一代计数；`game.paodekuai.* 7 键` 应变 9 | **已修**：D14/§5.8 逐行列改；源码计数注释一并同步 |
| 9 | 中 | 新 admin + 旧 user-service 窗口 `byGame` 未防御会崩 | **已修**：D15/§5.6/§6 要求可选链；详情缺失按 0/`—` |
| 10 | 中 | `RISK_STATS_PDK_SQL` 未独立钉全文，漏 `mode`/`is_robot` 会假绿 | **已修**：D9/§7.5 测试侧独立誊写 + `toBe` |
| 11 | 中 | PDK SQL 失败会把整轮风控打死 | **已处置**：D16/§6 明确保持 fail-fast 并登记影响面；§7.4 加失败用例 |
| 12 | 中 | 迁移 version=1 与 SplitGameConfig 的“新键起点=全局 MAX”纪律冲突 | **已修**：D10/§5.2 改为 `SELECT MAX(version)` 起点 |
| 13 | 低 | 玩家列表 ddz-only 与详情合计口径不一致 | **已登记**：§2.2/§6/§8；详情文案标注“两玩法合计” |
| 14 | 低 | 不叠分 ⇒ dismissed 不因第二种玩法命中复活 | **已登记**：§6 已知限制 |
| 15 | 低 | verifier 全局 `includes` 可能被备注假绿 | **已修**：§5.6 改为 `functionBody(renderRiskDetail)` 块内断言 |
| 16 | 低 | slice-20 旧注释/标题计数未列入 | **已修**：§5.7 逐处列出；platform-config 测试标题同步 |

> 第二轮：复核修订差异（只审上表处置是否落实）。
