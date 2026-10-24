# 删除冻结的缺省底分：缺省 = 档位表最低档 — 设计

- 日期：2026-10-21
- 范围：protocol / shared / room-service / game-service / currency-service / 客户端（仅门槛算式）/ admin（文案 + 行为）/ 文档
- 用户裁决（2026-10-21）：
  1. 不接受「底分 15 冻结在代码里」——换经济（如 1 元 = 100 金币的换算关系变化）时必须只改配置、不发版；
  2. 底分对外必填；服务端省略时的兜底 = **档位表最低档**；
  3. 三个实现取向按开发方推荐：`createSession` 用 0 哨兵 + `game.start` 强校验；REST 保留可选（省略 ⇒ 最低档）；救助档位表不可用时 fail-closed。
- 审查轮次：r1（独立 reviewer，2026-10-21）——发现 4 高 / 9 低，全部已处置，见 §9。

## 1. 背景 / 问题

`DEFAULT_BASE_SCORE = 15` 是 protocol 包里的代码常量（唯一真源），并且
`parseBaseScoreLevels` 强制「档位表必须包含它」。这条不变量存在的原因很具体：

- 建房省略 `baseScore` 时走 `dto.baseScore ?? DEFAULT_BASE_SCORE`，而这条路径**故意不读档位表**
  （见 `rooms.service.ts:194-232`）——所以「缺省 ∈ 表」只能在**写入口**保证；
- 客户端 `room.match` 一直必传底分；省略只发生在 REST 建房（旧 App / 深链刷新 / 工具）；
- 救助门槛 `DEFAULT_BASE_SCORE × entryMultiplier` 是 15 在经济面上的真正锚点
  （`wallet.controller.ts:167`、`ad-callback.service.ts:196`、客户端 `stores/game.ts:439`）。

问题：调整经济（整体缩放下注、改 1 元 = 100 金币的兑换率、换最低档）必须改代码常量 → 发版，
并且还要同步迁移/测试/文档；而定档位表本身是后台可改的。**同一个经济参数，一半可配、一半冻结**。

目标：删掉这个冻结值。缺省由**档位表本身**推导（最低档），救助门槛同源；以后换经济只改
`game.baseScoreLevels`（必要时连带 `currency.reliefAmount`），零代码、零迁移。

## 2. 范围

**做**

- protocol：删除 `DEFAULT_BASE_SCORE` 与「表必须含缺省档」校验；
- room-service：省略 `baseScore` ⇒ 档位表数值最小档；档位表始终读取（fail-closed 10007 不变）；
  推导前校验表项形状（坏表 ⇒ 10007，不得算出 NaN）；
- shared / game-service：删除常量兜底；`game.start` 强校验正整数；`createSession` 改用入参；
  `settleGame` 增加底分正整数的响亮守卫（防御 0 哨兵泄漏）；
- currency-service：救助门槛 = `min(档位表) × entryMultiplier`；档位表不可用 ⇒ 钱包 `10007`、
  广告回调瞬态重投（沿用现有失败语义）；
- 客户端：救助门槛从 `baseScoreLevels` 取最低档；空表必须显式判空；
- admin：删除「必须含 15 / 15 档不可删」的**行为性**拦截与提示；
- admin / design.md / 运维文档文案；相关测试与夹具。

**不做**

- 不改协议线格式（`room.match.baseScore` 已必填）、不加配置键、不加数据库迁移；
- 不把 REST `CreateRoomDto.baseScore` 改成必填（兼容旧 App / 深链；省略走最低档）；
- 不改客户端交互（大厅仍需用户点选档位，不做自动预选）；
- 不改 `entryFeePercents`（未覆盖的底分 = 0 台费，既有 fail-safe）；
- 不改机器人资金水位（见 R4）；
- 不修改历史 spec/plan（只改 `docs/design.md` 与运维文档）。

## 3. 决策表

| # | 决策 | 依据 |
|---|------|------|
| D1 | 删除 `DEFAULT_BASE_SCORE` 常量与 `parseBaseScoreLevels` 的「必须含缺省档」校验；表只需非空 · 名字非空 · 正整数 ≤ 8191 · 唯一 | 用户裁决①；缺省改为数据推导后，原不变量**结构性成立**，不再需要写入口规则 |
| D2 | 省略底分 ⇒ `Math.min(...levels.map(l => l.baseScore))`（数值最小，**不是数组第一项**） | 用户裁决②；数组顺序是展示顺序，不应兼作语义 |
| D3 | `room.match` 继续必填（现状）；客户端有选中档时必传；REST 保持可选 | 用户裁决③；不破坏旧 App / 深链刷新 |
| D4 | `RoomsService.create` **总是**读档位表：显式值做成员校验，省略值取最低档；读不到 ⇒ 既有 `DomainError(10007, '底分档位表不可用')`，详情只进日志 | 删除「缺省路径不读表」的特权——那条特权正是冻结值的来源；读的是进程内快照，不是每请求 RPC |
| D5 | `game.start` 的 `baseScore` 必须为正整数；非法 ⇒ `GameError(BAD_PARAM)`；**校验放在幂等早退之后** | `dto.baseScore > 0 ? … : DEFAULT` 的兜底删掉后，0/非法值绝不能静默流入结算；重复 start 仍按幂等返回既有会话 |
| D6 | `createSession` 新增可选第 4 参 `baseScore = 0`（0 = 未设置哨兵）；唯一生产调用点 `game.service` 传入；`settleGame` 增加「`baseScore` 是正整数」守卫 | 把必填参数加在可选 `random` 之后会迫使全仓 ~25 处测试调用改签名（纯噪音）；用出站视图校验 + 结算守卫把哨兵泄漏变成响亮失败 |
| D7 | 救助门槛 = `min(baseScoreLevels) × entryMultiplier`；服务端从配置快照读，客户端从 `/api/config` 读 | 门槛语义 = 「能回最低档桌」，与经济表自动联动；用户裁决③ |
| D8 | 失败方向分层：钱包 GET / 签发 ⇒ `503/10007`；广告回调 ⇒ 抛错（瞬态、不落 done、等重投）；建房 ⇒ `10007`。**绝不回退到 15 或任何代码常量** | 钱不出、不吞广告奖励；沿用 `ad-callback.service.ts:185-187` 的既有语义 |
| D9 | currency-service 新增 `minBaseScoreLevel(): number \| null`，读侧复用 `parseConfigValue`（唯一校验点纪律）；fail 方向 = null | 写入口与读侧同版；钱路径 fail-closed。注意 currency 侧**没有** `entryFeePercents()`（那是 room 侧），参照物是 `reliefAmount()` 的读法 |
| D10 | 客户端 `reliefAvailable` 必须显式判空：`levels.length === 0 ⇒ false` | `Math.min()` 空数组 = `Infinity` ⇒ `balance < ∞` 恒真，会误点亮救助入口 |
| D11 | admin 不仅改文案：删除「15 档不可删除」的点击拦截与「必须含 15」的保存校验；`verify-admin-static` 增加旧串不存在的断言 | 运营唯一入口若仍在行为上强制 15，D1 等于没落地 |
| D12 | 新增风险登记：`currency.reliefAmount` 必须 ≥ `min(档位表) × entryMultiplier`，否则领完回不了最低档桌；本片**不做跨键校验**（配置写入口是单键事务，跨键不变量无法可靠保证），只在 admin/运维文档写明 | 既有运维文档已有该约束（`first-deploy.md:1036`），只是现在最低档可动，风险面变大 |

## 4. 实现设计

### 4.1 `packages/protocol/src/config.ts`

- 删除 `export const DEFAULT_BASE_SCORE = 15;`（及文件头相关说明）。
- `parseBaseScoreLevels`：删除「表必须含缺省档」分支（现 632-636 行）；注释同步。
- 保留：非空数组、`name` 非空、`baseScore` 正整数 ≤ 8191、唯一。

### 4.2 `packages/room-service/src/rooms/rooms.service.ts`

`create()` 改成「先读表，再分流」：

```ts
let levels: { name: string; baseScore: number }[];
try {
  levels = await this.configCache.baseScoreLevels();
} catch (err) {
  // 原 catch 块逐字保留：WARN 带详情，对外固定文案 + 10007
}
// D2 + 审查 F8/r2：room 侧 readLevels() 不做元素校验；形状自证必须在**成员校验之前**
// —— 否则「显式值 + 坏表」会落到 10001，而 §5 承诺坏表一律 10007。
const validLevels = levels.every((l) => Number.isInteger(l.baseScore) && l.baseScore > 0);
if (!validLevels) {
  this.logger.warn(`Base score levels malformed: ${JSON.stringify(levels)}`);
  throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '底分档位表不可用');
}
if (dto.baseScore !== undefined && !levels.some((l) => l.baseScore === dto.baseScore)) {
  throw new DomainError(ErrCode.BAD_PARAM, '底分不属于档位表');
}
const baseScore = dto.baseScore ?? Math.min(...levels.map((l) => l.baseScore));
```

- `baseScoreLevels()` 对空表/缺失也抛（`readLevels()` 非空才返回）⇒ `Math.min` 的输入恒非空。
- 删除 `DEFAULT_BASE_SCORE` 的 import 与 re-export；删除类注释里的「缺省固定 15」表述。
- 影响：`createGameRoom`（匹配路径）本来就传显式值，行为不变；只有「省略」路径新增一次表读。

### 4.3 `packages/shared/src/ddz/game.ts` + `settle.ts`

```ts
export function createSession(
  roomCode: string,
  playerIds: string[],
  random: () => number = Math.random,
  baseScore = 0, // 0 = 未设置哨兵：唯一生产调用点 game.start 负责写入真实值
): GameSession
```

- 返回对象里 `baseScore` 用形参；删除 import/re-export 与「默认 15」注释。
- `settleGame` 的守卫位置钉死：`checkWinCondition` → `landlord` 检查 → **baseScore 守卫** →
  `multiplier` / `unitScore`。不能放在 winner 检查之前（`settle.test.ts:58-61` 用未结束局期待
  `'Game not finished'`）。

```ts
if (!Number.isInteger(session.baseScore) || session.baseScore <= 0) {
  throw new Error(`Invalid baseScore: ${session.baseScore}`);
}
```

- ⚠️ 0 哨兵的**第一道**响亮网不是 `settleGame`，而是出站视图校验
  （`buildPlayerView` → `validateOutbound`，`protocol/src/validate.ts:121-123` 要求 `baseScore > 0`）。
  `settleGame` 是最后一道；两者都要在计划里点名。

### 4.4 `packages/game-service`

- `game.service.ts`：
  - 删除 `DEFAULT_BASE_SCORE` import 与 `session.baseScore = dto.baseScore > 0 ? … : DEFAULT`；
  - 在幂等早退之后、`createSession` 之前校验：

```ts
if (!Number.isInteger(dto.baseScore) || dto.baseScore <= 0) {
  throw new GameError(ErrCode.BAD_PARAM, '底分必须是正整数');
}
```

  - `createSession(..., this.random, dto.baseScore)`。
- `view.builder.ts`：删除 `export { DEFAULT_BASE_SCORE } …`。
- 现存用例 `game.robot.test.ts:310-319`（「旧会话不崩」）直接 `createSession(...)` 后落 Redis、
  再走 `driveRobotTurn` → `buildPlayerView`；0 哨兵会让它撞上 `validateOutbound`。该夹具补第 4 参
  `100`，并在测试注释写明「旧会话底分由 game.start 写入，这里显式给」。

### 4.5 `packages/currency-service`

`config/config-cache.service.ts` 新增：

```ts
minBaseScoreLevel(): number | null {
  const value = this.snapshot?.['game.baseScoreLevels']?.value;
  if (value === undefined) return null;
  try {
    const levels = parseConfigValue('game.baseScoreLevels', value) as BaseScoreLevel[];
    return levels.length === 0 ? null : Math.min(...levels.map((l) => l.baseScore));
  } catch {
    return null;
  }
}
```

- `wallet.controller.ts:167`：在「救助开关关」判定之后、余额判定之前：

```ts
const lowest = this.configCache.minBaseScoreLevel();
if (lowest === null) {
  throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
}
const threshold = lowest * this.configCache.entryMultiplier();
```

- `ads/ad-callback.service.ts:196`：同法；`lowest === null` ⇒
  `throw new Error('底分档位表不可用（瞬态：不落 done）')`，与 `hasSnapshot()` 分支同语义。
- 注释同步（审查 F10/F12）：
  - `config/config.client.ts:17-19`「消费面只有三键」→ 四键（含 `game.baseScoreLevels`）；
  - `config/config-cache.service.ts:84`「三键的键级缺省（false / 200 / 10）」→ 四键口径；
  - 同文件 `:197`、`wallet.controller.ts:37,166`、`ads/ad-callback.service.ts:33` 的「15 ×」→「最低档 ×」。

### 4.6 `apps/client/src/stores/game.ts`

```ts
reliefAvailable: (s): boolean => {
  if (s.baseScoreLevels.length === 0) return false; // D10：空表 = 门槛未知
  const lowest = s.baseScoreLevels.reduce((m, l) => Math.min(m, l.baseScore), Infinity);
  return (
    s.reliefEnabled &&
    s.walletBalance !== null &&
    s.entryMultiplier !== null &&
    s.walletBalance < lowest * s.entryMultiplier
  );
},
```

- 删除 `DEFAULT_BASE_SCORE` import；注释同步。
- `source-boundary.test.ts`：删除针对 `DEFAULT_BASE_SCORE × 数字` 的两条正则（:363-364）时，
  **必须同时删除/改写 :389 的正例**（`expect(hit('const threshold = DEFAULT_BASE_SCORE * 10;')).toBe(true)`），
  并把 :393 的合法形态样本换成新算式（`lowest * s.entryMultiplier`）；否则删正则等于当场红。

### 4.7 文档 / admin

- `admin/app.js`（审查 F3，**行为性**改动，不只是文案）：
  - 删除删除按钮里的 15 拦截（:1443-1447）与保存校验「必须包含缺省底分 15」（:1482）；
  - 更新结构提示（:1466）为「底分须为正整数、唯一、≤ 8191；省略底分时取表内最低档」；
  - `scripts/verify-admin-static.mjs` 增加旧串不存在的断言（`必须包含缺省底分 15`、
    `缺省底分 15 档不可删除`），防止文案改一半。
- `docs/design.md`：术语表 `baseScore`（:53）、`Room.baseScore`（**:257**）、
  `GameSession.baseScore`（:298）、配置键表 `game.baseScoreLevels`（:1233）。
- `docs/ops/first-deploy.md`：:1021（键表「必须含 15」）、:1036（救济金额门槛）、:1065（填错示例）。
  :1037 的种子四档**不改**（那是种子值，仍然是 15/80/480/1200）。
- R4/R5 的文档落点：在 :1021 行后补「机器人资金水位要求 `max(档位) × entryMultiplier ≥ 15`」；
  在 :1036 行保留并强化「救济金额 ≥ 最低档 × `entryMultiplier`」。
- 生产源码注释（换经济后会误导，全部顺手改）：`shared/src/ddz/types.ts:60`、
  `currency-service` 四处（见 §4.5）、`protocol/src/config.ts` 文件头与解析注释、
  `room-service/src/rooms/rooms.service.ts` 类注释。
- conformance/工具注释（只改注释）：`ddz-driver.ts:83`、`slice-06-auth-rooms.ts:105-109`、
  `slice-12-manual-join.ts:403-410`；客户端注释（`lobby.vue:22,698`、`game.vue:646`、
  `net/rest.ts:310-313`）与 `scripts/verify-*.mjs` 可同批顺手改，不单列判据。

## 5. 错误处理与边界

| 情况 | 行为 |
|---|---|
| 显式 `baseScore` 不在表 | `10001 BAD_PARAM`（现状不变） |
| 省略 `baseScore`，表可用 | 取数值最小档 |
| 省略/显式，表不可用（冷启动 + config-service 不可用） | `10007`，房间不落库（现状对显式路径已如此） |
| 表非空但元素坏（非整数/非正） | 推导/校验前拦下 ⇒ `10007`（room 侧新增；详情只进日志） |
| 稳态 config-service 故障 | 进程内快照保留最后已知表，照常工作（≤60s 安全网刷新） |
| `game.start` 收到 0 / 负数 / 非整数 / 缺失 | `BAD_PARAM`；既有会话的重复调用先命中幂等早退，不报错 |
| `createSession` 被新调用方忘记传底分 | 会话底分为 0 ⇒ 出站视图校验先响亮失败，`settleGame` 兜底再拦（不会静默按 0 结算） |
| 救助：从未拉到快照 | `503/10007`（现状） |
| 救助：快照在但档位表键缺失/坏值 | **仅在「开关开且今日未领」分支**：钱包 `503/10007`；广告回调瞬态抛错、不落 done、等重投。已领/开关关仍按原次序返回 |
| 救助：档位表正常 | 门槛 = 最低档 × `entryMultiplier` |
| 客户端 `/api/config` 失败 | `baseScoreLevels` 空 ⇒ 救助入口不点亮（fail-safe） |

## 6. 测试判据

1. **protocol**：表不含 15 不再被拒；空表 / 重复 / 0 / 8192 仍被拒；`DEFAULT_BASE_SCORE` 导出与断言删除。
2. **config-service**：C18（表不含 15）用例删除；其余校验用例不动。
3. **room-service**（含审查 F1 的 4 个导入文件）：
   - `rooms.base-score.test.ts`：省略底分 ⇒ 取桩表最低档（15），且 `baseScoreLevels` **被调用一次**；
     判别力：桩表 `[{80},{5},{15}]` ⇒ 省略得 5（min，不是首项/常量）；
     表不可用 + 省略 ⇒ `10007` 且 Redis 零写入；表元素坏（如 `baseScore: '5'`）⇒ `10007`；
     显式非法值 ⇒ `BAD_PARAM`（现状）。删除 `SHARED_DEFAULT_BASE_SCORE` 同值对与常量断言。
   - `rooms.start.test.ts` / `rooms.service.test.ts` / `rooms.controller.test.ts` /
     `rooms.controller-switch.test.ts`：`DEFAULT_BASE_SCORE` 导入改为字面量或
     `BASE_SCORE_TIERS[0].baseScore`；`Room` 夹具补合法底分。
4. **shared**：
   - `createSession(..., baseScore)` 写入入参；省略时为 0 哨兵；
   - `settleGame` 对 0 / 负数 / 非整数底分抛错，且**未结束局仍先报 `'Game not finished'`**
     （守卫位置判据）；正整数照常结算。
5. **game-service**（审查 F2）：
   - `startGame` 对 0 / 负数 / 非整数 / 缺失抛 `BAD_PARAM` 且不建会话；
     已有会话的重复 start（即便本次传入非法底分）仍走幂等返回；
   - `game.robot.test.ts:314` 的旧会话夹具补 `baseScore: 100`；
   - 补一条「0 哨兵会话经 `buildPlayerView` 抛 `ProtocolError`」的判别用例（或由旧会话用例覆盖）。
6. **currency-service**：
   - `minBaseScoreLevel` 四态：正常取最小 / 缺键 null / 坏值 null / 空表 null；
   - 钱包：桩最低档 15 ⇒ 现有 150/149 边界不变；桩最低档 5 ⇒ 50/49 边界（判别力）；
   - 钱包：最低档 null ⇒ `503/10007`，**不签发 claim、不发放、claim 键零新增**
     （测试先预热余额缓存，消掉 `GetService` 读穿写缓存的噪音——`relief.test.ts:132-137` 既有手法）；
   - 广告回调：最低档 null ⇒ 抛错、不落 done；最低档 5 ⇒ 50/49 边界（**判别力，防内联 max/首项/常量**）。
7. **客户端**：
   - 档位表 15/80 ⇒ 救助门槛 150（现有边界测试不变）；
   - 档位表 `[80, 5]` ⇒ 门槛 50（证明取 min）；
   - 档位表 `[]` ⇒ `reliefAvailable === false`（即便余额为 0；D10 的 Infinity 陷阱）；
   - `source-boundary` 同步删/改正例，见 §4.6。
8. **admin**：`pnpm verify:admin` 通过；静态脚本断言旧串不存在。
9. **回归**：
   - 受影响包测试；**单包直跑前先构建依赖包**（protocol/shared 的 `dist` 未重建会从旧 dist
     解析到已删符号，给出不可信的绿/红）——统一走 `pnpm exec turbo run test lint --force`；
   - 客户端类型闸 + 真构建：`pnpm -C apps/client build`（= `vue-tsc --noEmit && uni build`），
     不是单跑 `uni build`；
   - 全仓 `pnpm test` / `pnpm lint`。
10. **conformance**（行为不变；**需重建镜像**）：
    - 建房/缺省路径：slice-05、slice-06、slice-07.1、slice-12（多处在不带 `baseScore` 建房）；
    - 钱路径（本片真正改动的接线）：**slice-18 的 G 段**（「余额 200 ≥ 门槛 150」等）、
      **slice-24**（救助回调）；slice-25（台费按底分）。

## 7. 风险

| # | 风险 | 处置 |
|---|------|------|
| R1 | 省略底分的建房在冷启动 + 配置不可用时从「静默用 15」变成 `10007` | 用户已接受；这是把静默破改成响亮失败；客户端正常流程总是传选中档 |
| R2 | 0 哨兵泄漏 | 三道网：`game.start` 强校验 → `validateOutbound`（第一个爆点）→ `settleGame` 守卫；均有测试 |
| R3 | 客户端空表时 `Math.min = Infinity` 误点亮救助 | D10 显式判空 + 单测 |
| R4 | 经济整体缩放下注时，`max(档位) × entryMultiplier < 15` 会让机器人资金水位**响亮失败**（`ROBOT_WATER_MIN_TOP = 15` 是水位公式的数学前提，不是缺省底分） | 本片不动；写进 `first-deploy.md:1021` 行后，作为经济调整的已知下限 |
| R5 | `currency.reliefAmount` 可能小于新的「最低档 × 倍率」，领完回不了桌 | 本片不加跨键校验（单键写事务无法可靠保证）；`first-deploy.md:1036` 明确写「金额 ≥ 最低档 × 倍率」 |
| R6 | `currency.entryFeePercents` 仍按旧底分设费率，换档后未命中 = 0 台费 | 既有 fail-safe 语义；登记，不改 |
| R7 | 「最低档」随运营新增活动档自动变化（省略建房的底分随之变化） | 用户裁决②接受；客户端主路径始终显式选档，省略路径仅 REST/工具 |
| R8 | room 侧 `readLevels()` 不校验元素，坏表可能算出 NaN | 审查 F8：推导前自证元素形状，坏表 ⇒ `10007`（见 §4.2） |

## 8. 涉及文件

**生产代码（12）**

- `packages/protocol/src/config.ts`
- `packages/room-service/src/rooms/rooms.service.ts`
- `packages/shared/src/ddz/game.ts`、`packages/shared/src/ddz/settle.ts`、`packages/shared/src/ddz/types.ts`（注释）
- `packages/game-service/src/game/game.service.ts`、`packages/game-service/src/game/view.builder.ts`
- `packages/currency-service/src/config/config-cache.service.ts`
- `packages/currency-service/src/config/config.client.ts`（注释）
- `packages/currency-service/src/wallet/wallet.controller.ts`
- `packages/currency-service/src/ads/ad-callback.service.ts`
- `apps/client/src/stores/game.ts`

**测试（约 15）**

- `packages/protocol/src/config.test.ts`
- `packages/config-service/test/config.validation.test.ts`
- `packages/shared/src/ddz/{types,settle}.test.ts`
- `packages/room-service/test/rooms.base-score.test.ts`
- `packages/room-service/test/{rooms.start,rooms.service,rooms.controller,rooms.controller-switch}.test.ts`（F1）
- `packages/game-service/test/{game.service,game.robot}.test.ts`（F2）
- `packages/currency-service/test/{relief,ad-callback,config-cache}.test.ts`
- `apps/client/test/{lobby-ux,source-boundary}.test.ts`

**文档 / 后台（5）**：`admin/app.js`、`scripts/verify-admin-static.mjs`、`docs/design.md`、
`docs/ops/first-deploy.md`、conformance 三处注释（同一提交）。

## 9. 审查记录（r1，独立 reviewer）

| # | 级别 | 发现（已逐条核对证据） | 处置 |
|---|------|------------------------|------|
| F1 | 高 | 删除 room-service 的 re-export 后，`rooms.start/rooms.service/rooms.controller/rooms.controller-switch` 四个测试文件仍导入 `DEFAULT_BASE_SCORE`，`tsc --noEmit` 必红；单包跑 vitest 还可能从旧 `dist` 解析到已删符号（假绿） | §6.3 / §8 补四个文件；§6.9 明确「先构建依赖包 / 走 turbo --force」 |
| F2 | 高 | 0 哨兵的第一爆点是 `buildPlayerView → validateOutbound`（`validate.ts:121-123`），现成用例 `game.robot.test.ts:310-319` 会红 | §4.3 / §4.4 / R2 点名；夹具补 `baseScore: 100`；§6.5 / §8 补 game-service 测试 |
| F3 | 高 | `admin/app.js:1443-1447` 删除拦截、`:1482` 保存校验仍在**行为上**禁止删/改 15，D1 在运营入口未落地；静态脚本抓不到 | D11 / §4.7 / §6.8 增补行为性改动与旧串不存在断言 |
| F4 | 高 | conformance 清单没覆盖真正改动的钱路径；slice-18 G 段与 slice-24 才有门槛断言；slice-06/07.1 也在不带底分建房 | §6.10 改为 05/06/07.1/12 + 18-G + 24 + 25，并注明重建镜像 |
| F5 | 高 | 文档漏 `design.md:257` 与 `first-deploy.md:1021`；R4/R5 的「写进运维文档」没有落点；`:1037` 无需改 | §4.7 / §8 订正；R4/R5 指定落点 |
| F6 | 低 | 删 `source-boundary` 两条正则后 `:389` 的正例必红 | §4.6 明确同步删/改 :389、:393 样本 |
| F7 | 低 | 钱包「不写 Redis」判据与读穿写缓存冲突；§5 的 503 未限定分支 | §5 限定「开关开且今日未领」；§6.6 改「不签发、claim 键零新增（先预热余额）」 |
| F8 | 低 | room 侧 `readLevels()` 不校验元素，坏表会算出 NaN/字符串强转 | §4.2 推导前自证；§5 / R8 / §6.3 增加坏表用例 |
| F9 | 低 | `settleGame` 守卫若放在 winner 检查之前会打破 `'Game not finished'` 既有用例 | §4.3 钉死守卫位置；§6.4 增加位置判据 |
| F10 | 低 | currency 侧没有 `entryFeePercents()`；「三键」注释实际在 `config.client.ts:17-19`，原 §8 漏该文件 | §4.5 / §8 订正 |
| F11 | 低 | 广告回调只测「15 ⇒ 150」无法区分实现是否内联 max/首项/常量 | §6.6 增加「最低档 5 ⇒ 50/49」判别用例 |
| F12 | 低 | 生产注释仍写死「15/缺省」的清单不完整 | §4.7 补 shared types、currency 四处、protocol/rooms 注释；客户端/脚本列为顺手改 |
| F13 | 低 |「真构建」命令不硬：`uni build` 不含 vue-tsc；未写权威轮与镜像重建 | §6.9 改 `pnpm -C apps/client build` + turbo --force；§6.10 注明重建镜像 |
