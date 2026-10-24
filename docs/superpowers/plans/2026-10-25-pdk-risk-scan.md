# 风控扫描支持跑得快（paodekuai）· 实现计划 v1.1

> 依据：`docs/superpowers/specs/2026-10-25-pdk-risk-scan-design.md` v1.1。
> 分支：`dev`。每个任务一个 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 斗地主扫描 SQL `RISK_WIN_RATE_SQL` **逐字不变**；斗地主判定结果不变（唯一差异：命中
  `reasons.detail` 多 `gameType:'doudizhu'`）。
- 不新增协议错误码；`CLIENT_CONFIG_KEYS` 仍 21 键；不改 `/api/config` 形状。
- 跑得快读键顺序：`game.paodekuai.risk.*` 存在 ⇒ 校验（非法 ⇒ 代码默认）；缺失 ⇒
  斗地主 getter（新键 → 旧键 → 默认）。`snapshot === null` 必须安全回落。
- 两玩法同时命中**不叠分**：`score = (hit1?25:0)+(hit2?25:0)`；`reasons` 每个命中玩法一条。
- 跑得快 SQL 失败 ⇒ 整轮失败（既有 fail-fast 语义），不做静默降级。
- 迁移 version 起点 = `SELECT MAX(version)`（至少 1），不用硬编码 1。
- 机械计数：protocol 92、active 76、IA 76、简单控件 71、结构化 5、数字键 35、
  `CONFIG_NOTES` 63；`CLIENT_CONFIG_KEYS` 21。
- 不改历史计划文档里的旧计数；只改当前状态文档/源码注释。
- 不 push master、不部署；推 dev 前先 fetch/merge `origin/dev` 并重跑全量。
- 提交前跑受影响包 test + lint；每任务一个 commit。

## 任务

### T1 protocol：两键、解析器、契约测试

**Files**：`packages/protocol/src/config.ts`、`packages/protocol/src/config.test.ts`

**Test first**：
1. `config.test.ts:15` 标题改“既有键 + 16 个跑得快键；客户端子集暂不变”。
2. 精确数组在 `game.paodekuai.entryMultiplier` 之后插入：
   `'game.paodekuai.risk.winRateThreshold'`、`'game.paodekuai.risk.minGames'`。
3. 在现有 `game.doudizhu.risk.*` parser 用例旁新增（每条反例都断言错误文案带**新键名**）：
   ```ts
   it('跑得快风控两键：胜率阈值 / 最少局数（与斗地主同域）', () => {
     expect(parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.5)).toBe(0.5);
     expect(parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.79)).toBe(0.79);
     expect(parseConfigValue('game.paodekuai.risk.winRateThreshold', 1)).toBe(1);
     expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.785)).toThrow(/game\.paodekuai\.risk\.winRateThreshold.*两位小数/);
     expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', 0.49)).toThrow(/game\.paodekuai\.risk\.winRateThreshold.*0\.5 ≤ n ≤ 1/);
     expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', 1.01)).toThrow(/game\.paodekuai\.risk\.winRateThreshold.*0\.5 ≤ n ≤ 1/);
     expect(() => parseConfigValue('game.paodekuai.risk.winRateThreshold', '0.8')).toThrow(/game\.paodekuai\.risk\.winRateThreshold.*必须/);
     expect(parseConfigValue('game.paodekuai.risk.minGames', 1)).toBe(1);
     expect(parseConfigValue('game.paodekuai.risk.minGames', 100000)).toBe(100000);
     expect(() => parseConfigValue('game.paodekuai.risk.minGames', 0)).toThrow(/game\.paodekuai\.risk\.minGames.*1 ≤ n ≤ 100000/);
     expect(() => parseConfigValue('game.paodekuai.risk.minGames', 100001)).toThrow(/game\.paodekuai\.risk\.minGames.*1 ≤ n ≤ 100000/);
     expect(() => parseConfigValue('game.paodekuai.risk.minGames', 3.5)).toThrow(/game\.paodekuai\.risk\.minGames.*必须是整数/);
     expect(() => parseConfigValue('game.paodekuai.risk.minGames', '100')).toThrow(/game\.paodekuai\.risk\.minGames.*必须是整数/);
   });
   ```
4. `pnpm -C packages/protocol test` ⇒ 红（键缺失/数组不等）。

**Implement**：
- `CONFIG_KEYS` 插入两键；文件头“六十六键”改“九十二键”；平行化块注释 24→26。
- 新增 `GAME_RISK_WIN_RATE_KEYS: readonly ConfigKey[]` / `GAME_RISK_MIN_GAMES_KEYS: readonly ConfigKey[]`
  （**必须显式标注 `readonly ConfigKey[]`**；用 `as const` 会在 `.includes(key: ConfigKey)` 处
  TS2345，而 vitest 的 esbuild 不报类型错，只有 `pnpm -C packages/protocol lint/build` 会红），
  替换现有两条 `game.doudizhu.risk.*` 显式 if 为数组分派。
- 不改 `CLIENT_CONFIG_KEYS` / `LEGACY_CONFIG_KEYS`。

**Green**：`pnpm -C packages/protocol build && pnpm -C packages/protocol test && pnpm -C packages/protocol lint`。
**Commit**：`feat(protocol): 新增跑得快风控两键与解析器`。

### T2 config-service：迁移 + 全部种子夹具

**Files**：
- 新增 `packages/config-service/src/migrations/1796700000000-PdkRiskConfigSeed.ts`
- `packages/config-service/test/migration.test.ts`
- `packages/config-service/test/helpers/config-probe.ts`
- `packages/config-service/test/platform-config.service.test.ts`
- `packages/config-service/test/admin.controller.test.ts`
- `packages/config-service/test/client-config.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`（注释）

**Test first**：
1. `migration.test.ts` 顶部 import 新类；文件尾新增 describe：
   - 自定义 fake runner **必须有行表语义**（照 `SplitFakeRunner`）：`rows: Map<string,{value,version}>`，
     `SELECT MAX(version)` 回 `[{ maxVersion: ... }]`，`INSERT IGNORE` 仅在键不存在时落行，
     记录参数化 INSERT；断言一条多值
     `INSERT IGNORE ... VALUES (?, ?, ?, NOW(3), ?), (?, ?, ?, NOW(3), ?)`，
     两键值 `'0.8'`/`'100'`、version 7、`updated_by='seed'`。
   - 空表 ⇒ `maxVersion: null` ⇒ version 1。
   - `down` 恰一条 `DELETE ... IN (?, ?)`，只含两键。
   - 重放 `up` 两次：行表值/版本不变（证明 `INSERT IGNORE` 不覆盖）。
   - 形状/时间戳：`PdkRiskConfigSeed1796700000000`，晚于 `SplitGameConfig1796600000000`，
     全仓唯一。
2. `helpers/config-probe.ts` SEED 追回：
   ```ts
   ['game.paodekuai.risk.winRateThreshold', 0.8],
   ['game.paodekuai.risk.minGames', 100],
   ```
3. `platform-config.service.test.ts` SEED 追加同样两键；标题“九十键”→“九十二键”；
   `toHaveLength(90)` → `92`。
4. `admin.controller.test.ts:169` 标题 90→92。
5. `client-config.test.ts:251` 标题“90 键键名”→“92 键键名”。
6. `client-config.controller.ts:89` 注释“90 键齐全”→“92 键齐全”。
7. `pnpm -C packages/protocol build && pnpm -C packages/config-service test` ⇒ 红
   （类不存在 + SEED/92 行计数不符；**红跑必须覆盖 SEED 计数断言**，不能只跑 migration.test.ts）。

**Implement**：按 spec §5.2 写迁移（`SELECT MAX` → 多值 `INSERT IGNORE` → `down` 删除）。
**Green**：`pnpm -C packages/protocol build && pnpm -C packages/config-service test && pnpm -C packages/config-service lint`。
**Commit**：`feat(config-service): 种下跑得快风控两键`。

### T3 user-service 配置缓存：跑得快回退链

**Files**：`packages/user-service/src/config/config-cache.service.ts`、
`packages/user-service/test/config-cache.test.ts`

**Test first**：在现有“风控键平行化”describe 后新增 describe，**沿用 `vi.useFakeTimers()` /
`afterEach` 还原**（snapshot-null 用例会排 1s 重试定时器；不设假时钟会留真实定时器）：
1. 合法值逐值：`{pdk winRate: 0.5/0.79/1}`、`{pdk minGames: 1/100000}` ⇒ 原值。
2. 缺失回退：仅 ddz 新键（0.9/50）⇒ 0.9/50；仅旧键（0.7/10）⇒ 0.7/10；
   全缺 ⇒ 0.8/100。
3. 存在但非法不回退：`{pdk winRate: 0.785, ddz: 0.7}` ⇒ 0.8；
   `{pdk winRate: null, ddz: 0.7}` ⇒ 0.8（`cachedWith` 的 `snapshotWith` 走
   `Object.entries` ⇒ 该键**存在且值 null**，不是缺失）；
   `{pdk minGames: 0, ddz minGames: 50}` ⇒ 100；
   `{pdk minGames: '100', ddz: 50}` ⇒ 100。
4. `snapshot === null`：照 C8 用例用 `snapshot.mockRejectedValue(transportDown())`，
   在首拉失败后**立即**调两 getter ⇒ 0.8/100，不抛；末尾 `cache.onApplicationShutdown()`。
5. 斗地主回归判别（防共享 normalize 漂移）：
   `{ddz winRate: 0.785, legacy risk.winRateThreshold: 0.7}` ⇒ 0.8；
   `{ddz minGames: 0, legacy risk.minGames: 50}` ⇒ 100。
6. `pnpm -C packages/user-service test test/config-cache.test.ts` ⇒ 红。

**Implement**：
- `hasSnapshotKey(key)`：`this.snapshot !== null && Object.hasOwn(this.snapshot, key)`。
- `normalizeWinRate(value)` / `normalizeMinGames(value)` 私有方法（现有校验逐字搬入）。
- 现有 `riskWinRateThreshold()` / `riskMinGames()` 改用 normalize + `readWithLegacy`。
- 新增 `riskPaodekuaiWinRateThreshold()` / `riskPaodekuaiMinGames()` 按 spec §5.3。

**Green**：`pnpm -C packages/user-service test test/config-cache.test.ts && pnpm -C packages/user-service lint`。
**Commit**：`feat(user-service): 跑得快风控键回退链`。

### T4 user-service 扫描：PDK SQL + 按玩法判定

**Files**：`packages/user-service/src/risk/scan.service.ts`、
`packages/user-service/src/risk/reviews.service.ts`（注释）、
`packages/user-service/test/risk-scan.test.ts`

**Test first（夹具必须先生效，不得只改生产代码）**：
1. 测试侧独立誊写：
   ```ts
   const SPEC_RISK_WIN_RATE_PDK_SQL =
     "SELECT p.user_id, COUNT(*) AS games, SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id JOIN users u ON u.id = p.user_id AND u.status = 'active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL AND p.is_robot = 0 GROUP BY p.user_id";
   ```
   SQL 常量用例加 `expect(RISK_WIN_RATE_PDK_SQL).toBe(SPEC_RISK_WIN_RATE_PDK_SQL)`。
2. `FakeScanDb` 增加 `pdkWinRows` 与分支：
   ```ts
   if (sql === SPEC_RISK_WIN_RATE_PDK_SQL) return Promise.resolve(this.pdkWinRows);
   ```
   增加 `failPdk = false`；命中 PDK SQL 时若为 true ⇒ reject `new Error('pdk db down（仿真）')`。
3. `makeScanConfig` 覆盖类型加 `pdkMinGames` / `pdkWinRateThreshold`，实现：
   ```ts
   riskPaodekuaiMinGames: vi.fn(() => over.pdkMinGames ?? 100),
   riskPaodekuaiWinRateThreshold: vi.fn(() => over.pdkWinRateThreshold ?? 0.8),
   ```
4. 现有命中矩阵用例：
   - 查询断言改为 `queries[0]` 斗地主、`queries[1]` PDK（空）、`queries[2]` 设备；
   - `u-both` / `u-win` 的 reasons 补 `gameType:'doudizhu'`；
   - 阈值现读用例的 ddz reason 补 `gameType:'doudizhu'`。
5. 新增用例：
   - **跑得快单独命中**：`pdkWinRows=[{user_id:'u-pdk',games:101,wins:90}]`、
     `makeScanConfig({pdkMinGames:100,pdkWinRateThreshold:0.8})` ⇒ score 25、
     reason `{check:'winRate',detail:{gameType:'paodekuai',games:101,wins:90,winRate:90/101}}`；
     断言 `riskPaodekuaiWinRateThreshold` getter 被调用（现读面）。
   - **跑得快-only 未命中仍进并集**：`pdkWinRows=[{user_id:'u-pdk-zero',games:5,wins:5}]`、
     默认阈值 ⇒ `callsByUser()['u-pdk-zero']` 为 `{score:0,reasons:[]}`
     （防实现只在命中时才把 pdk 用户写进 merged，丢失 auto 旗回落面）。
   - **按玩法阈值（双向判别）**：
     - pdk 51 局 46 胜（46/51≈0.902）、`pdkMinGames=50`/`pdkWinRateThreshold=0.9` ⇒ 命中；
     - 同一数据、`pdkWinRateThreshold=0.95`（ddz 0.8）⇒ **不命中**（score 0）——
       若实现误用 `riskWinRateThreshold()` 作为 pdk 胜率阈值，本反例红；
     - ddz 101 局 85 胜、ddz 阈值 0.8 ⇒ ddz 命中、reason `gameType:'doudizhu'`。
   - **跨玩法不聚合**：同一用户 ddz 60 局 55 胜 + pdk 60 局 55 胜、两边 minGames=100、
     阈值 0.8 ⇒ score 0、无 winRate reason（若实现把两玩法 games/wins 相加成 120 局，
     会命中 ⇒ 本用例红）。
   - **两玩法同时命中不叠加**：同一用户 ddz 101/90 + pdk 101/90、devices=5 ⇒
     score 50（不是 75），reasons = [ddz, pdk, devices]；
     两次 run 之间 `reviews.applyScanResult.mockClear()` 并清空 `db.deviceRows`，
     再跑一次 ⇒ score 25、reasons 仍两条（避免 `callsByUser()` 只看到最后一次）。
   - **查询顺序固定**：空数据跑一轮 ⇒ `db.queries.map(q=>q.sql)` 前三条依次 =
     `[SPEC_RISK_WIN_RATE_SQL, SPEC_RISK_WIN_RATE_PDK_SQL, SPEC_RISK_DEVICE_COUNT_SQL]`，
     总查询 5 条（+ 自愈名单 + open 计数）。
   - **PDK SQL 抛 ⇒ 整轮失败**：`db.winRows` 有数据、`db.failPdk=true`；先
     `riskScanLastSuccessTimestampSeconds.set(123)`；`runScanOnce` reject `/pdk db down/`；
     `runs{fail}+1`、`last_success` 仍 123、`reviews.applyScanResult` 零调用、锁释放。
6. `pnpm -C packages/user-service test test/risk-scan.test.ts` ⇒ 红。

**Implement**（spec §5.4）：
- 新增 `RISK_WIN_RATE_PDK_SQL` 常量与注释（SQL1/SQL1b）。
- `runScanWork` 读四个阈值；依次查 ddz / pdk / device；并集结构带 `byGame`。
- 逐用户算 `ddzHit`/`pdkHit`；`hit1 = ddzHit || pdkHit`；score 不叠；
  reasons 按 ddz → pdk → devices 顺序。
- `ScanReason` 注释补 gameType 契约（`reviews.service.ts` 只改注释）。
- **契约注释同步**：`RiskScanRoundResult.users` 的“并集用户数（SQL1 ∪ SQL2）”
  改“SQL1 ∪ SQL1b ∪ SQL2”；类注「单轮形态」第 2 步同步。
- 不改变 `applyScanResult` 签名与状态机。

**Green**：`pnpm -C packages/user-service test test/risk-scan.test.ts`，再跑全量
`pnpm -C packages/user-service test && pnpm -C packages/user-service lint`。
**Commit**：`feat(user-service): 风控扫描纳入跑得快对局`。

### T5 user-service 管理详情：byGame

**Files**：`packages/user-service/src/risk/admin-risk.service.ts`、
`packages/user-service/test/risk-admin.test.ts`

**Test first**：
1. 测试侧独立誊写 `SPEC_RISK_STATS_PDK_SQL`（全文同 spec §5.5），
   新增 `expect(RISK_STATS_PDK_SQL).toBe(SPEC_RISK_STATS_PDK_SQL)`。
2. `FakeRiskAdminDb`：
   - 增加 `pdkWinStats = new Map<string, {games:number;wins:number}>()`；
   - `reset()` 清空；
   - `exec` 识别 `SPEC_RISK_STATS_PDK_SQL`（用独立文本，不用 import 常量）⇒ 返回
     `[{ games, wins }]`（缺省 0/0）。
3. 现有详情形状用例 expected 的 `stats` 改为：
   ```ts
   { games: 12, wins: 9, winRate: 9/12, deviceCount: 2,
     byGame: {
       doudizhu: { games: 12, wins: 9, winRate: 9/12 },
       paodekuai: { games: 0, wins: 0, winRate: 0 },
     } }
   ```
4. 新用例：`db.winStats=12/9`、`db.pdkWinStats=5/4` ⇒ 顶层 17/13、winRate 13/17、
   `byGame.doudizhu=12/9/0.75`、`byGame.paodekuai=5/4/0.8`、deviceCount 不变。
5. 查询顺序：详情查询中 ddz stats 在 pdk stats 之前、pdk stats 在 device 之前
   （取 `db.queries.map(q=>q.sql)` 的 index 比较）。
6. 跑 `pnpm -C packages/user-service test test/risk-admin.test.ts` ⇒ 红。

**Implement**：
- 新增 `RISK_STATS_PDK_SQL` 常量。
- `RiskUserDetail.stats` 加 `byGame` 类型。
- `getUserDetail` 查两次 stats、聚合；`winRate` 用合计重算。
- 设备计数、设备原文、entries、hits、binding 均不变。

**Green**：`pnpm -C packages/user-service test && pnpm -C packages/user-service lint`。
**Commit**：`feat(user-service): 风控详情增加分玩法战绩`。

### T6 admin：IA/控件/备注/详情行 + 静态闸

**Files**：`admin/app.js`、`scripts/verify-admin-static.mjs`

**Test first**：先改 `verify-admin-static.mjs`：
- `protoSet.size === 92`、`activeProtoSet.size === 76`、`iaKeySet.size === 76`；
- pdk 页签断言加 `risk`（六页签），并补
  `pdkDomainBlock.includes("'game.paodekuai.risk.winRateThreshold'")` 与
  `pdkDomainBlock.includes("'game.paodekuai.risk.minGames'")`（防两键被塞到别的域/未分组）；
- `entries.size === 71`；`NUMBER_SUFFIX` 加两键；分类合计 34+2+35=71；
  `76 键 = 71 简单 ∪ 5 结构化`；
- pdk 胜率阈值 `step: 0.01` 且无 suffix；
- `CONFIG_NOTES` 用**条目形态**断言（防块内注释满足 includes）：
  `/'game\.paodekuai\.risk\.winRateThreshold':\s*\[/` 与
  `/'game\.paodekuai\.risk\.minGames':\s*\[/`；
- 详情断言限定 `functionBody(app,'function renderRiskDetail')`，并加可选链形态：
  `/d\.stats\?\.byGame\?\.doudizhu\?\.games\s*\?\?/` 与 `/d\.stats\?\.byGame\?\.paodekuai\?\.games\s*\?\?/`，
  以及 `分玩法`（不得只断言 `byGame` 字面）；
- 头注释/计数注释同步：`:13-14` 66/61、`:281` 47/4/51、`:399` 分类合计 61。
跑 `pnpm verify:admin` ⇒ 红。

**Implement**：
- `admin/app.js`：
  - 注释计数：`60 条备注 / 74 个 active 键` → `63 条备注 / 76 个 active 键`（:152、:354）；
    `六十六键` → `九十二键`（:120、:1230）；
    `47 键；其余 4 键` → `71 键；其余 5 键`（:852）；
    `跑得快（20 简单键）` → `22 简单键`（:872）；
    `:134` 的“跑得快 14 键暂走控件标签” → “跑得快 16 键中 14 键暂走控件标签”
    （新增 2 条备注后，仍无备注的是 14 键，不是 16）；
  - `CONFIG_NOTES` 两键（文案见 spec §5.6：仅跑得快、与斗地主独立、不叠分、
    自动限流 50 分线、2/4 人期望不同）；**文案内不得出现未配对的大括号**
    （会破坏 verifier 的 `balancedBlock`）；
  - `CONFIG_IA` pdk 域加 `risk` 页签（两键）；
  - `CONFIG_CONTROLS` 两 number（胜率 `step:0.01`、最少局数）；
  - `renderRiskDetail`：总战绩文案 + 分玩法行，全部可选链与 textContent；
  - `showPlayerDetail` 文案“对局/胜场（两玩法合计）”。
- verifier 计数常量同步。

**Green**：`pnpm verify:admin`。
**Commit**：`feat(admin): 跑得快风控配置与分玩法战绩`。

### T7 conformance slice-20：风控键集与种子

**Files**：`tools/conformance/src/slices/slice-20-risk-control.ts`

**Implement**：
- 新增 `K_PDK_WIN_RATE` / `K_PDK_MIN_GAMES`；`RISK_SEED_VALUES` 加两项（10 项）。
- 定义 `isRiskKey`（`risk.` / `game.doudizhu.risk.` / `game.paodekuai.risk.`）；
  `g1RiskKeys = g1Keys.filter(isRiskKey).sort()`；
  `expectedRiskKeys = CONFIG_KEYS.filter(isRiskKey).sort()`；
  `fieldSetViolations(...) === 0`；文案用 `expectedRiskKeys.length`（16）。
- `TOTAL_CONFIG_KEYS` 保持 `CONFIG_KEYS.length`；step 文案“65 键”改模板，
  且同行的“8 风险键种子”改“10 风险键种子”；
- 同步文件头、`:130`（“八风险键…收尾复原值”）、`:718`、`:723-727`
  （“8 种子 + 2 节奏 … 现态恰十二”注释按新谓词重写）、`:737`、`:742` 的旧计数/表述；
- `pnpm -C tools/conformance lint` 绿；本机不跑真栈（用户未要求部署/真栈）。
**Commit**：`test(conformance): 对齐跑得快风控键与种子`。

### T8 文档与源码计数注释

**Files**：
- `docs/design.md`：143、427、533、540、1225、1526、1684、2165 的计数改 92/76；
  1289 的“跑得快 7 键”改“9 键（+风控两键）”；§7.5 风险表加两行、消费者段补两键。
- `docs/ops/first-deploy.md`：1016 改 92/76；风险表加两行。
- `docs/games/paodekuai.md` §7.1 加两行与说明。
- `docs/client-protocol.md:58` 90→92。
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md` §5 加“可保留、无需回填”。
- 源码当前计数注释（只改当前状态表述，不动历史迁移）：
  `admin/app.js:120/1230`、`packages/api-gateway/src/gateway/gateway.controller.ts:146`、
  `packages/config-service/src/config/admin.controller.ts:101`、
  `platform-config.entity.ts:10`、`platform-config.service.ts:45/57`、
  `packages/room-service/src/gateway/config.client.ts:21`、`rpc.options.ts:35`、
  `packages/robot-service/src/config/config.client.ts:14`。
- 测试夹具里的当前计数注释（T8 一并清）：
  `packages/config-service/test/helpers/config-probe.ts:29/152`、
  `packages/config-service/test/platform-config.service.test.ts:200`、
  `packages/config-service/test/admin.controller.test.ts:20`，
  以及 user/room/robot 测试里仍在描述当前全量的“五十一键”。
- **不要盲替换** `packages/user-service/src/config/config.client.ts:15`：该行是历史里程碑链
  （风控片 25 → … → 机器人补位片 51）；保留链条并在尾部追加
  “配置平行化后九十键；本片后九十二键”。

**Verify**：
```bash
grep -rn "90 键\|90键\|74 active\|74 个 active\|74 键\|89 键\|73 active\|73 键\|六十六键\|五十一键" \
  docs/design.md docs/ops/first-deploy.md docs/client-protocol.md \
  admin scripts packages/*/src packages/*/test 2>/dev/null | grep -v node_modules | grep -v dist
```
只允许历史迁移/历史计划/`config.client.ts:15` 里程碑链中的旧表述命中；其余命中逐条改。
**Commit**：`docs: 同步跑得快风控键与 92 键计数`。

### T9 全量验证 + 独立代码审查 + 推送 dev

1. `pnpm -C packages/protocol build`。
2. `pnpm exec turbo run test lint --force`。
3. `pnpm verify:admin`。
4. `pnpm -C tools/conformance lint`。
5. 真 MySQL 迁移冒烟：先看 Docker 状态；可用则起 MySQL 跑迁移，
   `SELECT COUNT(*) FROM platform_config` = 92 + 抽查两键；不可用则登记。
6. 独立 reviewer 审 `44274955..HEAD`（用户给定基线；含 spec/plan/实现全部提交），
   对照 spec/plan 逐条核对，只报发现；Critical/Important 必修，修后补测试并复跑
   受影响 + 全量。
7. **先完成代码审查与修复**，再 `git fetch origin`；若 `origin/dev` 有更新 ⇒ merge 后
   **重跑全量**；工作区干净后 push `dev`（不 push master、不部署）。
8. 交付报告：变更、验证证据、提交范围、已知边界。

## 回归命令

```bash
pnpm -C packages/protocol build
pnpm -C packages/protocol test
pnpm -C packages/config-service test
pnpm -C packages/user-service test
pnpm verify:admin
pnpm -C tools/conformance lint
pnpm exec turbo run test lint --force
```

## 计划审查记录

### 第一轮独立对抗审查（2026-10-25）

审查者：独立子代理（sonnet），只报发现。共 18 条：1 高 / 7 中 / 10 低。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | T4 跑得快**胜率阈值**未被判别（所有用例 0.8/0.9 都过；只测了 minGames） | **已修**：T4 加 `pdkWinRateThreshold=0.95` 反例（同数据不命中）+ 0.9 正例 + getter 现读断言 |
| 2 | 中 | 缺“pdk-only 未命中（score 0）仍进并集”用例 | **已修**：T4 新增 `u-pdk-zero` 用例 |
| 3 | 中 | verifier 未断言两新键在 pdk 域内（可能塞进 ungrouped/ddz） | **已修**：T6 加 `pdkDomainBlock.includes` 两键 |
| 4 | 中 | verifier 未钉 D15 可选链，非可选链实现也能过 | **已修**：T6 加 `d.stats?.byGame?.doudizhu?.games ??` 与 pdk 形态正则 |
| 5 | 中 | `GAME_RISK_*_KEYS` 若写 `as const` 会 TS2345，vitest 不报类型错 | **已修**：T1 明确 `readonly ConfigKey[]`，Green 加 protocol lint |
| 6 | 中 | 各任务 Green 不跑 lint，与 Global 矛盾 | **已修**：T1–T5 Green 补 `lint`；T2/T3 明确先 build protocol |
| 7 | 中 | T9 代码审查 BASE 未钉 | **已修**：T9 钉 `44274955..HEAD` |
| 8 | 中 | 测试文件里的“五十一/六十六键”注释未列入，grep 不扫 test | **已修**：T8 加测试夹具注释清单，grep 加 `packages/*/test` 与 `scripts` |
| 9 | 低 | admin 注释残余（74 个 active、47/4、20 简单键、14 键、verifier 头注释） | **已修**：T6/T8 逐条列明（含“16 键中 14 键”表述） |
| 10 | 低 | T1 parser 缺 1.01/100001，且多数反例未断言新键名 | **已修**：T1 补边界，所有反例正则带新键名 |
| 11 | 低 | T2 “重放不改值”在纯记录 fake 下恒真 | **已修**：T2 要求 fake 行表 + `INSERT IGNORE` 幂等语义 |
| 12 | 低 | T3 新 describe 未钉假时钟/关停，null 用例留真实定时器 | **已修**：T3 明确 fake timers + `onApplicationShutdown()` |
| 13 | 低 | T4 双 run 覆盖 mock、失败用例无 last_success 基线 | **已修**：T4 明确 `mockClear()` 与预置 123 |
| 14 | 低 | T7 的 `:718`“8 风险键”与 `:723-727` 注释未列入 | **已修**：T7 补列 |
| 15 | 低 | `config.client.ts:15` 是历史里程碑链，不能盲替换 | **已修**：T8 要求保留链条并追加新计数 |
| 16 | 低 | T4 头部 `RiskScanRoundResult.users` 与类注仍是 SQL1 ∪ SQL2 | **已修**：T4 明确改 SQL1 ∪ SQL1b ∪ SQL2 |
| 17 | 低 | CONFIG_NOTES 的 includes 可被块内注释满足 | **已修**：T6 改用 `'key': [` 条目形态正则 |
| 18 | 低 | T2 红跑只跑 migration.test.ts，SEED 计数红无证据 | **已修**：T2 红跑改全量 config-service test |

> 复核自检：18/18 处置已落入对应任务；无新增分歧。
