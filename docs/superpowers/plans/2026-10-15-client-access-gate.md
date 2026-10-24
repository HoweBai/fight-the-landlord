# 客户端接入开关（App / H5 整端准入闸）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `app`/`h5` 两个端各配一把管理端可翻转的准入开关（整端封禁、拦新不踢旧），默认全开暗上线。

**Architecture:** 识别 = 客户端自报（HTTP 头 `X-Client-Platform` / socket 握手 `auth.clientPlatform`）；执法 = api-gateway 唯一执法点（新中间件插最前 + `handleConnectionInner` 验签前）;配置 = 第 43/44 键走既有 config 机制，网关新增 `config.snapshot` RPC 出站边（专用订阅连接）；留痕 = 拒绝 warn 日志 + 两计数器。

**Tech Stack:** Nest 11 / Express 5 / socket.io 4 / TypeORM migration / protocol 配置契约 / uni-app 客户端 / conformance 真栈片。

**依据（均已定稿，冲突时以设计为准并回改本文件）**：
- 设计 `docs/superpowers/specs/2026-10-15-client-access-gate-design.md` **v1.5**
- 规格 `docs/superpowers/specs/2026-10-15-client-access-gate-spec.md` **v1.2（判据 C1–C42）**

**修订史**：v1.0 → 计划评审 r1「修后再评」（8 重要 + 8 次要，关键 4 条经抽查复现）→ **v1.1 逐条处置**（处置 = 文内 ⚠️ 标记）→ **差量收口复评 r2「可以定稿」**（6 处次要随版订正：注释机理/C31 措辞/OPTIONS 前提/E′ 清理纪律/镜像重建前置/docs 面口径）。**状态：定稿 —— 待用户拍执行方式后开工。**

## Global Constraints

- **命名钉子（规格 §0，⛔ 不许就地变体）**：头 `X-Client-Platform`（值恰小写 `app`/`h5`）；socket 字段 `auth.clientPlatform`；键 `client.appEnabled`/`client.h5Enabled`（严格 boolean、种子 `true`、客户端不可见）；码 `CLIENT_DISABLED = 10008`、`CLIENT_ACTION = TOAST`；文案单一真源 = `net/copy.ts` 的 `当前客户端已暂停服务，请稍后再试或更换客户端`；计数器 `client_gate_blocked_total{platform}` / `client_gate_unidentified_total`；安全网 ≤60s（`CONFIG_SYNC_SAFETY_NET_MS` 默认 60000，同 payment 口径）。
- **三豁免**：`/api/admin/*`（`isAdminPath`）、健康两条（`isHealthPath`）、`/api/config`（新增 `isClientConfigPath`）——判定**必须复用 `public-paths.ts` 单一真源**，⛔ 中间件内不抄字面量。
- **失败语义**：拉过快照后刷新失败 ⇒ last-good **继续执法**；从未拉到 ⇒ 默认 `true` **放行**（fail-open）。
- **纪律**：① 每步 TDD（先写失败测试再实现）；② 假红先单跑确认，别「重跑直到绿」，未复现如实记；③ 任何「跑了/绿了」必须指向本次产生的日志；④ 新闸类断言必须带正/负对照（判别力自证）。
- **测试命令（Windows 本机，工作目录 = 仓库根）**：`pnpm --filter <包名> exec vitest run <文件>`；lint 用各包 `pnpm --filter <包名> run lint`；conformance 单跑 `node tools/conformance/dist/run.js <片名>`（先 `pnpm --filter @fight-the-landlord/conformance build`）。
- **每个 Task 结束必须 commit**（信息带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）。

---

### Task 1: 协议层（两键 + 10008 + 逐字表）

**Files:**
- Modify: `packages/protocol/src/config.ts`（CONFIG_KEYS 尾 + `parseConfigValue`）
- Modify: `packages/protocol/src/errors.ts`（枚举 + CLIENT_ACTION）
- Test: `packages/protocol/src/config.test.ts`、`packages/protocol/src/errors.test.ts`

**Interfaces:**
- Produces: `ErrCode.CLIENT_DISABLED = 10008`；键字面量 `'client.appEnabled' | 'client.h5Enabled'`；`parseConfigValue` 两分支。

- [ ] **Step 1: 先改测试（失败态）**——`config.test.ts`：
  ① 顶部两个 it 标题「四十二键…」改「四十四键…」，字面量数组在 `'currency.entryFeePercents',` 后追加两行：
```ts
  'client.appEnabled',
  'client.h5Enabled',
```
  ② ⚠️ r1 重要 5 补 **C2 落点**：照 `:240` 支付两键的**逐键族体例**新增 it（正负样本全）：
```ts
  it('客户端接入片第 43–44 键：appEnabled/h5Enabled = 严格 boolean（拒字符串 \'true\' 与数字；种子 true=暗上线全开）', () => {
    expect(parseConfigValue('client.appEnabled', false)).toBe(false);
    expect(parseConfigValue('client.h5Enabled', true)).toBe(true);
    expect(() => parseConfigValue('client.appEnabled', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('client.h5Enabled', 1)).toThrow(/boolean/);
    expect(() => parseConfigValue('client.appEnabled', null)).toThrow(/boolean/);
    expect(() => parseConfigValue('client.h5Enabled', [])).toThrow(/boolean/);
  });
```
  ③ `errors.test.ts` 的 `SPEC_CODES`（⚠️ r1 重要 5 勘正：**纯数字数组**，`errors.test.ts:8-17`）在 `10001, 10002, …` 行尾追加 `10008,`（行内注释体例照邻行：`// 10008 = 客户端接入闸（本片）`）。

- [ ] **Step 2: 跑测试确认失败**
Run: `pnpm --filter @fight-the-landlord/protocol exec vitest run src/config.test.ts src/errors.test.ts`
Expected: FAIL（CONFIG_KEYS 少两键 / ErrCode 无 CLIENT_DISABLED）

- [ ] **Step 3: 实现**——`config.ts`：
  ① `CONFIG_KEYS` 数组尾（`'currency.entryFeePercents',` 之后、`] as const;` 之前）追加：
```ts
  /** 客户端接入片（第 43 键）：App 端准入（严格 boolean、种子 `true`、客户端不可见——不进 CLIENT_CONFIG_KEYS）。 */
  'client.appEnabled',
  /** 客户端接入片（第 44 键）：H5 端准入（严格 boolean、种子 `true`、客户端不可见）。 */
  'client.h5Enabled',
```
  ② `parseConfigValue` 内（`if (key === 'ad.reliefAdpid') …` 行后）追加：
```ts
  if (key === 'client.appEnabled') return parseStrictBoolean(key, value);
  if (key === 'client.h5Enabled') return parseStrictBoolean(key, value);
```
  ③ `errors.ts`：1xxxx 段 `UPSTREAM_UNAVAILABLE = 10007,` 后追加：
```ts
  /** 客户端接入片：本端已被管理端暂停（整端准入闸；软开关，非安全边界）。 */
  CLIENT_DISABLED = 10008,
```
  `CLIENT_ACTION` 表追加 `[ErrCode.CLIENT_DISABLED]: ClientAction.TOAST,`。

- [ ] **Step 4: 跑测试通过**（同 Step 2 命令，Expected: PASS；另跑 `pnpm --filter @fight-the-landlord/protocol run lint`）。

- [ ] **Step 5: Commit**
```bash
git add packages/protocol/src/config.ts packages/protocol/src/errors.ts packages/protocol/src/config.test.ts packages/protocol/src/errors.test.ts
git commit -m "feat(protocol): 客户端接入两键（43/44）+ CLIENT_DISABLED=10008 + 逐字表同步"
```

---

### Task 2: config-service（种子迁移 + 全测试面 42→44）

**Files:**
- Create: `packages/config-service/src/migrations/1795300000000-ClientAccessGateSeed.ts`
- Modify: `packages/config-service/test/migration.test.ts`（新块）
- Modify: `packages/config-service/test/helpers/config-probe.ts:145` 一带（种子副本）
- Modify: `packages/config-service/test/platform-config.service.test.ts`（种子副本 `:200-260` 一带 + `:316 toHaveLength(42)`）
- Modify: `packages/config-service/test/admin.controller.test.ts:175` 一带、`config.rpc.test.ts:141` 一带（逐字键集断言）
- Modify（注释同步）：`src/config/admin.controller.ts:101`、`src/config/platform-config.entity.ts:10`、`src/config/platform-config.service.ts:45/57`、`src/config/client-config.controller.ts:22`（「四十一/四十二键」→「四十四键」；CLIENT_CONFIG_KEYS 16 键断言不动）

**Interfaces:**
- Consumes: T1 的两键。
- Produces: 全新库 seed 后两键 = `true`；全测试面绿。

- [ ] **Step 1: 写种子迁移（含 down）**——时间戳 `1795300000000`（> 既有最大 1795200000000），逐字照 `1795200000000-EntryFeePercentsSeed.ts` 形态：
```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 客户端接入片 T2：第 43/44 键 `client.appEnabled` / `client.h5Enabled` 的种子迁移
 * —— 双 `true`（**暗上线 = 全开** ⇒ 行为与今天逐字节一致；整端准入闸要显式关才咬）。
 *
 * ⚠️ 形状逐字照 `1795200000000-EntryFeePercentsSeed.ts`（类名 `<Name><时间戳>`、`name`
 * 属性与类名一致、SQL 反引号标识符、一语句多 VALUE 元组）。时间戳 1795300000000 >
 * 既有最大 1795200000000（同库内按序执行）。
 */
export class ClientAccessGateSeed1795300000000 implements MigrationInterface {
  name = 'ClientAccessGateSeed1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('client.appEnabled', 'true', 1, NOW(3), 'seed'),` +
        `('client.h5Enabled', 'true', 1, NOW(3), 'seed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` IN ('client.appEnabled', 'client.h5Enabled')",
    );
  }
}
```

- [ ] **Step 2: 同步四个测试面 + 补 C4 写面用例**（每处「失败态先行」——改完即跑）：① `migration.test.ts` 照既有 EntryFee 块同形加块（断言两键在库、值 true、`updated_by='seed'`）；② `config-probe.ts` 种子副本 +2；③ `platform-config.service.test.ts` 副本 +2 且 `toHaveLength(42)` → `toHaveLength(44)`；④ 两处**逐字键集断言**（`admin.controller.test.ts:175` 与 `config.rpc.test.ts:141`）各追加两行 `'client.appEnabled', 'client.h5Enabled',`（前者标题「全量四十二键」同改「四十四」）；⑤ ⚠️ r1 次要 11 补 **C4 四子性质**：在 `platform-config.service.test.ts` 既有写面族按体例加两键用例——true↔false 双向写成功、version 递增、非 bool 抛错（⇒ 400 语义）、`config_changes` 同事务留痕行含 actor（FakeEm 已记 key/oldValue/newValue/actor 四件，断言即可）。

- [ ] **Step 3: 跑 config-service 全量单测确认失败→实现→通过**
Run: `pnpm --filter @fight-the-landlord/config-service exec vitest run`
Expected: Step 2 后 FAIL（实现面没跟上）→ 跑上一步的 Step 1 迁移落地后再跑 ⇒ PASS。若首跑即红在别处：按形态判别，假红先单跑（纪律②）。

- [ ] **Step 4: 注释同步四处**（纯文案，改完 `pnpm --filter @fight-the-landlord/config-service run lint`）。

- [ ] **Step 5: Commit**
```bash
git add packages/config-service
git commit -m "feat(config-service): 第 43/44 键种子迁移 + 四个测试面 42→44 + 注释同步"
```

---

### Task 3: 管理端 IA + 静态闸

**Files:**
- Modify: `admin/app.js`（CONFIG_IA 新域 + META 两条 + 导航叶注册 + CONFIG_NOTES「42 条对 42 键」族注释 + 「5+1 配置叶」族 `:952/1798/4454` 一带）
- Modify: `admin/index.html`（导航叶按钮 + 「配置域 5 叶」注释）
- Modify: `scripts/verify-admin-static.mjs`（计数面 + 必需 id 清单）

**Interfaces:**
- Consumes: T1 的两键。
- Produces: 新域「客户端接入」在导航可达；静态闸实报绿。

- [ ] **Step 1: 改 `verify-admin-static.mjs`（先红）**：⚠️ **r1 重要 1 必做前置——扩键收集正则的首位**：`QUOTED_DOTTED`（`:177`）与 `ENTRY_RE`（`:246`）的段模式 `[a-z]+(?:\.[a-zA-Z]+)+` **容不下含数字的段**，`'client.h5Enabled'` 零命中（实测：h5Enabled 0 / appEnabled 1）⇒ 先改为 `[a-z][a-z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+`（两处同改；收集面**只增不减**，属放宽收集而非弱化断言，注释登记：「客户端接入片：段内允许数字（首字符仍须字母）——既有键无数字段，该形态此前不可达」）。然后计数面：`protoSet.size === 42` → `44`、`iaKeySet.size === 42` → `44`、`entries.size === 37` → `39`、`BOOL_KEYS.length === 10` → `12`、合计断言 `=== 37` → `=== 39`（`:277-280`）与「42 键 = 37 简单 ∪ 5 结构化」注释同改；`BOOL_KEYS` 清单（`:200-211` 一带）加两键；必需导航 id 清单（`:119-124`）追加 `'nav-cfg-client-btn'`。附**判别力自证**：扩正则后先跑 `node -e` 双样本自证（`'client.h5Enabled'` 与 `'client.appEnabled'` 均命中 1）再跑闸。
Run: `node scripts/verify-admin-static.mjs` ⇒ Expected: FAIL（admin 侧还没加）。

- [ ] **Step 2: 改 `admin/app.js`**：① `CONFIG_IA` 的「通用设置」group 内（`dataAds` 域后）追加：
```js
      {
        id: 'client',
        name: '客户端接入',
        tabs: [
          { id: 'gate', name: '端开关', keys: ['client.appEnabled', 'client.h5Enabled'] },
        ],
      },
```
  ② 导航叶映射数组追加：`{ leaf: 'nav-cfg-client-btn', count: 'nav-count-client', domain: 'client' },`
  ③ META（`CONFIG_CONTROLS` 一带）追加：
```js
  'client.appEnabled': { label: 'App 端', type: 'bool' },
  'client.h5Enabled': { label: 'H5 端', type: 'bool' },
```
  ④ CONFIG_NOTES 加两条（4 行「作用/取值/生效/注意」体例：作用=该端准入闸（整端拦截；拦新不踢旧）；取值 `开/关`（默认开）；生效=保存即生效（≤60s 安全网兜底）；注意=存量 App（无标识头）不受控、软开关非安全边界）。
  ⑤ 「42 条对 42 键」→「44 条对 44 键」（`:149/:310` 一带）与「5+1 配置叶」族注释（`:952/:1798/:4454` 一带，「5+1」→「6+1」）。

- [ ] **Step 3: 改 `admin/index.html`**：照 `nav-cfg-riskcfg-btn` 行同形加 `<button id="nav-cfg-client-btn" type="button" class="nav-leaf">客户端接入<span class="nav-count" id="nav-count-client"></span></button>`；「配置域 5 叶」注释改「6 叶」。

- [ ] **Step 4: 跑静态闸**
Run: `node scripts/verify-admin-static.mjs`
Expected: `admin static verify: <N> checks passed`（N 实报为准；逐点计数变化 = 上述 6 处）

- [ ] **Step 5: Commit**
```bash
git add admin/app.js admin/index.html scripts/verify-admin-static.mjs
git commit -m "feat(admin): 客户端接入域（App/H5 端开关）+ 静态闸计数面 42→44"
```

---

### Task 4: 网关配置读取（RPC 边 + 缓存 + 专用订阅）

**Files:**
- Create: `packages/api-gateway/src/config/config.client.ts`
- Create: `packages/api-gateway/src/config/config-cache.service.ts`
- Test: `packages/api-gateway/test/config-cache.test.ts`

**Interfaces:**
- Produces: `ConfigCacheService#snapshotOrNull(): ConfigSnapshot | null`（**从未拉到 ⇒ null**）与 `waitForFirstSnapshot(): Promise<void>`；env 名 `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）/`CONFIG_SYNC_DISABLE_PUSH`（照 payment 同名同口径，含「空串=未设」的 `||` 语义）。
- Consumes: `RPC_PATTERNS.configSnapshot`（`packages/protocol/src/rpc.ts:58`）。

- [ ] **Step 1: 克隆两个文件**——**先通读** `packages/payment-service/src/config/{config.client.ts,config-cache.service.ts}` 全文，然后：
  - `config.client.ts`：逐段对齐 payment 形态（`ClientProxy` + 3s 超时 + `RpcResult` 解包 + 传输故障 ⇒ `ConfigServiceError(10007)`），**差异清单**：① 只保留 `snapshot()` 一条边（删支付专属 `payChannel()` 与票据缓存）；② token 常量改名 `API_GATEWAY_CONFIG_RPC`（**与包装类 token 故意不同**——同坑注释照抄）；③ `snapshot()` 的 `.send(` **必须带 `...metaFromTrace()`**（`room-service/test/meta-on-every-rpc-send.gate.test.ts:67-76` 的扫描面含 api-gateway）。
  - `config-cache.service.ts`：逐段对齐 payment 的骨架（**专用订阅连接**——`new Redis(...)` 独立实例，⛔ **绝不**用注入的共享 `REDIS` provider：它是 SessionGuard/限流/WS 名额共用实例；1s 退避重试直到首拉成功（不阻塞就绪）；广播 `config:changed` 到达即重拉全量；安全网 ≤60s 无条件重拉；刷新失败**保留 last-good**）；**差异清单**：① 只保留 `snapshotOrNull()` + `waitForFirstSnapshot()`（删支付键 getter）；② 构造注入上面的 `ConfigClient`；③ 注释写明两态语义（拉过 ⇒ last-good 继续执法；从未拉到 ⇒ `null` ⇒ 调用方放行）。

- [ ] **Step 2: 写测试（失败态）**——`packages/api-gateway/test/config-cache.test.ts`（用既有网关测试的 stub 手法注入假 ConfigClient；⚠️ 先读同包既有测试怎么打桩 RPC/Redis，照其形态）：
```ts
// 用例清单（每条一 it；断言文案写清「性质」不写实现形态）：
// ① 从未拉到：snapshotOrNull() === null；waitForFirstSnapshot 在注入成功拉取后 resolve
// ② 拉过一次后刷新失败：snapshotOrNull() 仍返回旧快照（last-good 执法——关态不被一次失败放门）
// ③ 广播到达即刷：注入 subscriber emit 'config:changed' ⇒ 快照换成新值
// ④ 专用连接结构钉：缓存服务不持有共享 REDIS（断言其构造入参/内部无共享实例订阅——按测试面可达的形态写，⛔ 不钉实现外形）
```

- [ ] **Step 3: 跑测试确认失败 → 实现 → 通过**
Run: `pnpm --filter @fight-the-landlord/api-gateway exec vitest run test/config-cache.test.ts`
Expected: FAIL（文件不存在）→ 实现后 PASS。

- [ ] **Step 4: meta 扫描闸复核**
Run: `pnpm --filter @fight-the-landlord/room-service exec vitest run test/meta-on-every-rpc-send.gate.test.ts`
Expected: PASS（新 `.send(` 带 meta）。

- [ ] **Step 5: Commit**
```bash
git add packages/api-gateway/src/config packages/api-gateway/test/config-cache.test.ts
git commit -m "feat(gateway): config.snapshot 出站边 + 客户端接入缓存（专用订阅/last-good/≤60s 安全网）"
```

---

### Task 5: 网关 HTTP 闸 + 留痕 + 真链序判据

**Files:**
- Modify: `packages/api-gateway/src/auth/public-paths.ts`（新增 `isClientConfigPath`）
- Create: `packages/api-gateway/src/auth/client-gate.service.ts`（共享分类器 + 闸判定）
- Create: `packages/api-gateway/src/auth/client-gate.middleware.ts`
- Create: `packages/api-gateway/src/metrics/client-gate.metrics.ts`
- Modify: `packages/api-gateway/src/app.module.ts`（注册第 0 步 + 「顺序即契约」注释同步）
- Test: `packages/api-gateway/test/client-gate.middleware.test.ts`、`packages/api-gateway/test/client-gate-order.gate.test.ts`

**Interfaces:**
- Consumes: `ClientGateService#allows(platform)`；T4 的 `ConfigCacheService`。
- Produces: `classifyClientPlatform(raw: unknown): 'app' | 'h5' | null`（socket 侧 T6 复用）；`CLIENT_PLATFORM_HEADER = 'x-client-platform'`；两计数器。

- [ ] **Step 1: 写失败测试（矩阵表驱动 + 判别力自证）**——`client-gate.middleware.test.ts`（⚠️ 先读同包既有中间件测试的搭建形态——各测试手搭 configure()，不 import AppModule）：
```ts
// 表驱动：[头值 × 闸态 × 路径] ⇒ 期望，每格一条断言；必备格：
// {无头, 闸关, /api/auth/login} ⇒ 放行（next 被调）
// {app, 闸关, login} ⇒ 403 + {code:10008,message,data:null}；{app, 闸开} ⇒ 放行
// {h5, 闸关} ⇒ 403+10008；{h5, 闸开} ⇒ 放行
// 非法值 ['App','APP','android','', 超长串, ' app '] ⇒ 放行（未识别）
// 三豁免（显式带头 + 闸关）：/api/admin/xxx、/api/health、/api/health/live、/api/config ⇒ 放行
// 闸先于 jwt（同链）：无/坏 token + 关闸端 + 非豁免 ⇒ 10008 不是 10002/10005
// ⚠️ r1 次要 10 补格：OPTIONS 预检（带 h5 头 + 闸关打 login）⇒ 被 cors 短路（非 10008、带 ACAO）；
//    ⚠️ r2 次要 2：该格成立的前提 = 脚手架先 `app.enableCors(...)`（照 `main.ts:52` 次序：enableCors
//    在 Nest 中间件之前注册；手搭 app 不调它 ⇒ OPTIONS 会被闸拦成 10008 = 反语义绿）
// 留痕：拒绝 ⇒ logger.warn 一次且 message 含三要素（platform= / trigger=switch-off / path=；
//        traceId 由 NDJSON 日志层附带——本层不断言，登记）⚠️ r1 次要 15；两计数器增量
//       （blocked{platform} / 未识别路径 ++）
// unidentified 排除豁免路径（带头/不带头打 admin/health/config 不增量）
```
  另 `client-gate-order.gate.test.ts`（C14b 文本断言）：
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// 读 app.module.ts 源码文本；断言 consumer.apply( 行里 ClientGateMiddleware 的位置
// 早于 JwtMiddleware（indexOf 次序）；并断言该行仍以 '{/*splat}' 收尾（形态钉子）。
// ⛔ 不 import AppModule（会把 Nest 装配拖进单测）；本闸只读文本。
```

- [ ] **Step 2: 跑确认失败**：
Run: `pnpm --filter @fight-the-landlord/api-gateway exec vitest run test/client-gate.middleware.test.ts test/client-gate-order.gate.test.ts`
Expected: FAIL（模块不存在 / apply 行未含 ClientGate）。

- [ ] **Step 3: 实现**——① `public-paths.ts` 尾（照 `isHealthPath` 同形，精确匹配集）：
```ts
/**
 * 客户端配置拉取面（`GET /api/config`；路由在 gateway.controller 的 `@Get('config')`）——
 * `ClientGateMiddleware` 的第三条豁免（H5 被禁时页面须照常初始化）。与 HEALTH_PATHS 同族：
 * **精确匹配**、消费方不得再抄字面量（R462 同族漂移面）。
 */
export const CLIENT_CONFIG_PATHS = ['/api/config'] as const;

export function isClientConfigPath(path: string): boolean {
  return (CLIENT_CONFIG_PATHS as readonly string[]).includes(path);
}
```
  （⚠️ 若同文件 `isHealthPath` 的实读实现是 `some((p) => path === p)` 形态，按其逐字对齐——两者必须同形。）
  ② `client-gate.service.ts`：
```ts
import { Injectable } from '@nestjs/common';
import { ConfigCacheService } from '../config/config-cache.service';

/** 端标识值（§0 钉子；其余一律未识别）。 */
export function classifyClientPlatform(raw: unknown): 'app' | 'h5' | null {
  return raw === 'app' || raw === 'h5' ? raw : null;
}

const KEY_BY_PLATFORM = { app: 'client.appEnabled', h5: 'client.h5Enabled' } as const;

@Injectable()
export class ClientGateService {
  constructor(private readonly cache: ConfigCacheService) {}

  /** 闸判定：仅「拉到过快照且值恰为 false」才关；未拉到/键缺失/坏值一律放行（fail-open）。 */
  allows(platform: 'app' | 'h5'): boolean {
    const snap = this.cache.snapshotOrNull();
    if (snap === null) return true;
    return snap[KEY_BY_PLATFORM[platform]]?.value !== false;
  }
}
```
  ③ `metrics/client-gate.metrics.ts`（照 `payment.metrics.ts` 形态：`createCounter` + `ReturnType` 注记——那两处注释逐字对齐；⚠️ r1 次要 9：计名**逐字 = §0**，无前缀——与 `http_requests_total` 一族同形）：
```ts
export const clientGateBlockedTotal = createCounter(
  'client_gate_blocked_total',
  '客户端接入闸拒绝数（按端）',
  ['platform'],
);
export const clientGateUnidentifiedTotal = createCounter(
  'client_gate_unidentified_total',
  '非豁免面未带/非法端标识的请求数（只读存在性信号；不归属任何端）',
);
```
  ④ `client-gate.middleware.ts`：
```ts
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { NextFunction, Request, Response } from 'express';
import { isAdminPath, isClientConfigPath, isHealthPath, requestPath } from './public-paths';
import { CodedForbidden } from './jwt.middleware';
import { ClientGateService, classifyClientPlatform } from './client-gate.service';
import { clientGateBlockedTotal, clientGateUnidentifiedTotal } from '../metrics/client-gate.metrics';

export const CLIENT_PLATFORM_HEADER = 'x-client-platform';

@Injectable()
export class ClientGateMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ClientGateMiddleware.name);
  constructor(private readonly gate: ClientGateService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const path = requestPath(req);
    if (isAdminPath(path) || isHealthPath(path) || isClientConfigPath(path)) return next();
    const platform = classifyClientPlatform(req.headers[CLIENT_PLATFORM_HEADER]);
    if (platform === null) {
      clientGateUnidentifiedTotal.inc();
      return next();
    }
    if (this.gate.allows(platform)) return next();
    clientGateBlockedTotal.inc({ platform });
    // 留痕四要素（platform/path/trigger；traceId 由 NDJSON 日志层自动附带——照 jwt.middleware 的
    // logger 用法即可）。⛔ 头值不落未转义日志（platform 已归一为枚举、path 是请求路径）。
    this.logger.warn(`client-gate blocked platform=${platform} trigger=switch-off path=${path}`);
    throw new CodedForbidden(ErrCode.CLIENT_DISABLED, '当前客户端已暂停服务');
  }
}
```
  ⑤ `app.module.ts`：`consumer.apply(...)` 行改为
  `consumer.apply(ClientGateMiddleware, JwtMiddleware, AdminAuthMiddleware, HttpRateLimitMiddleware).forRoutes('{/*splat}');`
  并在「顺序**不可交换**」注释块头部补第 ⓪ 条：「\`ClientGateMiddleware\` 最先：端闸（自报头判定、不依赖身份）；⛔ 它不读也未验任何身份头——插最前不改变 ①②③ 的相对序与验真纪律」。
  模块面（⚠️ **r1 重要 3 补全**，逐字照 `payment-service/src/config/config.module.ts:19-31` 的三件套）：
  `imports` 追加 `ClientsModule.register([{ name: API_GATEWAY_CONFIG_RPC, ...configClientOptions() }])`；
  `providers` 追加**三条**：① `{ provide: ConfigClient, useFactory: (p: ClientProxy) => new ConfigClient(p), inject: [API_GATEWAY_CONFIG_RPC] }`——**必须 `useFactory`**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒ 启动即崩；payment 同处注释逐字照抄）；② `ConfigCacheService`；③ `ClientGateService`。
  ⚠️ 网关**无容器门禁测**（`container-assembly.gate.test.ts` 只扫 `controllers:`）⇒ 该形态的验证靠部署期真栈（T9 Step 4 的容器实读）+ 真栈片；单测/lint 全绿不代表容器不崩（DI 陷阱同族，登记）。

- [ ] **Step 4: 跑至绿 + 全包回归**
Run: `pnpm --filter @fight-the-landlord/api-gateway exec vitest run`（全量子集相关）+ `pnpm --filter @fight-the-landlord/api-gateway run lint`
Expected: PASS。⚠️ 既有测试若有钉 `consumer.apply(` 原文的闸（如 no-route-outside-api.gate），按其形态同步（改判据须同批升级并写明性质，⛔ 不许弱化）。

- [ ] **Step 5: Commit**
```bash
git add packages/api-gateway
git commit -m "feat(gateway): 客户端接入 HTTP 闸（第 0 步）+ 双计数器留痕 + 真链序文本判据"
```

---

### Task 6: 网关 socket 闸

**Files:**
- Modify: `packages/api-gateway/src/gateway/proxy.gateway.ts`（`handleConnectionInner`）
- Modify: `packages/api-gateway/test/proxy.gateway.test.ts`（⚠️ r1 重要 2：`:176` 直构 `new ProxyGateway(jwt, session, redis)` —— 加第 4 参后 **lint 的 tsc -p tsconfig.test.json 实参检查必红**）
- Modify: `packages/api-gateway/test/ws-allow-request.test.ts`（⚠️ r1 重要 2：`:174-184` 用 `Test.createTestingModule({ providers: [ProxyGateway, …] })` 真 DI —— 新依赖解析不到会在 beforeAll 崩）
- Test: `packages/api-gateway/test/client-gate.socket.test.ts`

**Interfaces:**
- Consumes: `ClientGateService`、`classifyClientPlatform`（T5）。
- Produces: 握手 `auth.clientPlatform` 关闸端 ⇒ `rejectHandshake(CLIENT_DISABLED)`。

- [ ] **Step 1: 写失败测试**——单测面（mock Socket + 假 gate；照同包 proxy 测试的桩法）：
```ts
// ① 关闸端 + auth.clientPlatform=app ⇒ rejectHandshake 被调且 code=CLIENT_DISABLED、client.disconnect 被调
// ② 开闸端 ⇒ 走到 verifyClient（下游桩：无 token ⇒ UNAUTHENTICATED——证明闸没截错人）
// ③ auth.clientPlatform 缺失/非法 ⇒ 放行到 verifyClient（未识别桶）
// ④ 闸先于 verifyClient：关闸端 + 无 token ⇒ 10008 不是 10002
```

- [ ] **Step 2: 跑确认失败**：`pnpm --filter @fight-the-landlord/api-gateway exec vitest run test/client-gate.socket.test.ts` ⇒ FAIL。

- [ ] **Step 3: 实现**——`handleConnectionInner` 内：
  ① `auth` 解构类型扩 `clientPlatform?: unknown`；
  ② 闸位 = `client.on('disconnect', …)` 名额释放注册**之后**、`const userId = await this.verifyClient(...)` **之前**（⚠️ 这条次序是硬要求——早于 disconnect 注册会让 `allowRequest` 占的 WS 名额**泄漏**到 TTL）：
```ts
    // 客户端接入闸（先于验签：端关了不必验签；位次在 disconnect 注册之后——保住名额释放）。
    const platform = classifyClientPlatform(auth.clientPlatform);
    if (platform !== null && !this.clientGate.allows(platform)) {
      this.rejectHandshake(client, ErrCode.CLIENT_DISABLED, `client gate closed: ${platform}`);
      return;
    }
```
  ③ 构造注入 `ClientGateService`（值导入纪律）。
  ④ ⚠️ r1 重要 2——**两个既有测试的配套改法**（先跑它们看红、再改、再绿）：`proxy.gateway.test.ts:176` 直构补第 4 参假 gate（`{ allows: () => true } as never` 或局部桩，照该文件既有桩法）；`ws-allow-request.test.ts` 的 `providers` 追加 `{ provide: ClientGateService, useValue: { allows: () => true } }`（该测不涉端闸，放行桩即可；⛔ 不要为它拉真 ConfigCacheService/ConfigClient）。

- [ ] **Step 4: 跑至绿 + lint**。

- [ ] **Step 5: Commit**
```bash
git add packages/api-gateway/src/gateway/proxy.gateway.ts packages/api-gateway/test/client-gate.socket.test.ts
git commit -m "feat(gateway): socket 握手端闸（verifyClient 之前、名额释放之后）"
```

---

### Task 7: 客户端面（注入 ×2 + 显示 ×4）

**Files:**
- Modify: `apps/client/src/config.ts`（⚠️ r1 重要 8 勘正：`buildSocketAuth` **实址 = `config.ts:84`**；`session.ts:126` 只是调用点 `auth: buildSocketAuth()`）——HTTP 头注入在 `rest.ts`；socket auth 字段在 `config.ts`
- Modify: `apps/client/src/net/rest.ts`（头注入）、`apps/client/src/net/socket.ts`（10008 兜底）、`apps/client/src/stores/auth.ts`（toast 覆盖）、`apps/client/src/net/copy.ts`（文案）、`apps/client/src/components/ConnectionOverlay.vue`、`apps/client/src/components/ConnectionDeadBar.vue`
- Test（⚠️ r1 重要 8 点名，含必红项）: `apps/client/test/transport-config.test.ts`（**:44-46 精确 `toEqual` 必红**——测试环境无 uni ⇒ `detectPlatform()==='browser'` ⇒ 恒带 `clientPlatform:'h5'` ⇒ 期望补该字段）+ `rest`/`session`（若拆文件）/`copy`/`auth`（auth-error-copy、auth-ui-wiring）/`socket`（connection-rejected）/两 .vue（connection-overlay、connection-dead）各面既有测试文件按新断言扩

**Interfaces:**
- Consumes: `detectPlatform()`（`mp-transport.ts:697`，值域 `'browser' | 'app' | 'mp-weixin'`）；`ErrCode.CLIENT_DISABLED`。
- Produces: `clientPlatformHeaders(): Record<string, string>`（rest.ts 导出，测试可钉）。

- [ ] **Step 1: 写失败测试**（逐面）：
  - `rest` 面：`clientPlatformHeaders()` —— detectPlatform 打桩（`'browser'` ⇒ `{'X-Client-Platform':'h5'}`；`'app'` ⇒ `'app'`；`'mp-weixin'` ⇒ `{}`）；且 `request()` 合并进最终 headers（桩 transport 读 headers）。
  - `config` 面（buildSocketAuth）：返回值含 `clientPlatform`（app/h5；mp 不带）；**同时更新 `transport-config.test.ts:44-46` 两处 `toEqual`**（补 `clientPlatform: 'h5'`，注释写明「vitest setup 装全局 uni 替身、默认 `uniPlatform='web'`（`test/helpers/uni-stub.ts:243-245`）⇒ `detectPlatform()==='browser'` ⇒ 'h5'」——⚠️ r2 次要 1 机理勘正：不是「测试环境无 uni」）；两处裸 `uni.request`（/version.json、外部收集端）**不**带头（负对照钉）。
  - `socket` 面：断线码 `10008` ⇒ `emitReconnect` 的 message 恰为 copy 串（⛔ 不含 `code=10008` 裸码）；11003/10006 两族行为逐字不动（负对照）；⚠️ r1 次要 14 / r2 次要 5 订正 **C31**：断言 = 「**建连** `opts.auth` 含 `clientPlatform`」（工厂只在 GameClient 构造时被调一次 `socket.ts:414-421`）；「重发」= socket.io 内部行为（`socket.js:405-414`）**不经工厂、单测不可达** ⇒ 登记不测，⛔ 不写「模拟 reconnect 路径」（名不副实）。
  - `auth` 面（C34b）：`dispatchRestFailure` 的 toast 处理器在 `code=CLIENT_DISABLED` 时 `this.error` = copy 串（**即使服务端 message 非空**——负对照：其余码服务端 message 优先逐字不动）。⚠️ 落点在 **toast 路径**（`net/errors.ts:147-148` 分派），⛔ 不是 11003 的 BACK_TO_LOBBY 位置。
  - `copy` 面：`authErrorMessage(ErrCode.CLIENT_DISABLED, '连接')` 返回 §0 长串。
  - 两 `.vue` 面：`canRetry` 在 `deadCode=10008` 时为 true；message 含 §0 串；两组件**同断言**（同口径纪律）。

- [ ] **Step 2: 跑确认失败**：`pnpm --filter @fight-the-landlord/client exec vitest run`（相关文件；client 全量在收口再跑）。

- [ ] **Step 3: 实现**（逐处锚定）：
  ① `rest.ts`（`detectPlatform` 导入 + 新函数 + `request()` 内 headers 合并——锚点 = 其内部调用 `requestJson(input)` 的入参处）：
```ts
/** §0：端标识头（browser→h5；app→app；mp-weixin/未知 → 不带）。 */
export function clientPlatformHeaders(): Record<string, string> {
  const kind = detectPlatform();
  if (kind === 'browser') return { 'X-Client-Platform': 'h5' };
  if (kind === 'app') return { 'X-Client-Platform': 'app' };
  return {};
}
```
  ② `config.ts:84`（⚠️ r1 重要 8 勘正实址）`buildSocketAuth()` 的返回对象加 `clientPlatform`（`detectPlatform()` 映射同上；mp ⇒ **不含该键**）。
  ③ `socket.ts:1176-1181` 兜底：在 `USER_BANNED` 分支后加同形分支：
```ts
    if (code === ErrCode.CLIENT_DISABLED) {
      this.emitReconnect({
        kind: 'server_rejected',
        version: this.currentVersion,
        message: authErrorMessage(ErrCode.CLIENT_DISABLED, '连接'),
      });
      return;
    }
```
  ④ `auth.ts` toast 处理器（`:156-162`）：`this.error = report.code === ErrCode.CLIENT_DISABLED ? authErrorMessage(ErrCode.CLIENT_DISABLED, label) : report.message || authErrorMessage(report.code, label);`
  ⑤ `copy.ts`：`[ErrCode.CLIENT_DISABLED]: '当前客户端已暂停服务，请稍后再试或更换客户端',`
  ⑥ 两 `.vue`：`canRetry` 谓词追加 `|| …deadCode === ErrCode.CLIENT_DISABLED`（Overlay 用 `props.state`、DeadBar 用 `state.value`——逐字同口径）；message computed 在既有按码分支处加 `10008 ⇒ authErrorMessage(ErrCode.CLIENT_DISABLED, '连接')`。

- [ ] **Step 4: 跑至绿 + `pnpm --filter @fight-the-landlord/client run lint`（vue-tsc）**。

- [ ] **Step 5: Commit**
```bash
git add apps/client
git commit -m "feat(client): 端标识注入（HTTP/socket）+ 10008 四面显示（登录toast/socket兜底/两死态组件）"
```

---

### Task 8: conformance 新片 slice-26-client-gate

**Files:**
- Create: `tools/conformance/src/slices/slice-26-client-gate.ts`
- Modify: `tools/conformance/src/run.ts`（注册：import + 表项 `'slice-26-client-gate'`）
- Modify: `tools/conformance/baselines.json`（**仅 full 列**回填）
- （如探针需 auth 透传）Modify: `tools/conformance/src/lib/client.ts`（`connect` 支持 `extraAuth`；⛔ 默认行为不动）

**Interfaces:**
- Consumes: `adminLogin/adminPutConfig/adminGetConfig`、`registerUser`、`HarnessClient`、`INTERNAL_TOKEN`、`execCurl`（照 slice-25 :208 同形本片自建）、`waitFor`/`sleep`。
- Produces: 片 `slice-26-client-gate`（真栈）。

- [ ] **Step 1: 写片（骨架 + 六组）**——头部注释照 slice-25 体例（纪律块：临时关闸 ⇒ **还原 true**（`ENTRY_GATE_SEED = true` 知基线）；还原失败=硬失败、finally 尽力；RUN_TAG/AID 纪律；不做 DB 硬清；读数增量维度）。组：
```
⓪ 起手：adminLogin；adminGetConfig 读两键基线 === true（前置自证，⛔ 不满足即显式失败）
A h5 关：adminPutConfig('client.h5Enabled', false) → waitFor 探针（fetch /api/auth/login，带
   {X-Client-Platform: 'h5'} + 空 creds；≤5s×12 轮）到「响应码 10008」；随后三条对照读数同一窗口：
   无头 ⇒ 非 10008；app 头 ⇒ 非 10008；⚠️ r1 次要 13 **非法值格**：`App` 头 / `android` 头 ⇒ 非 10008
B 真链序：关 h5 态 + 无 Authorization + 非豁免路径（⚠️ r1 重要 4 勘正：`GET /api/users/me`
   **网关无此路由** ⇒ 改用真路由 **`GET /api/rooms`**（`gateway.controller.ts:1038`）带 h5 头）
   ⇒ 10008（⛔≠10002）
C 三豁免（显式带头 + h5 关）：POST /api/admin/login（空体）⇒ 非 10008（业务 400 族）；
   GET /api/health、/api/health/live ⇒ 200；⚠️ r1 重要 4 勘正：GET /api/config **经玩家验签**
   （不在公开白名单；`gateway.controller.ts:106-109`）⇒ 用 registerUser 真 token 带 h5 头 ⇒ 200
   （对照：无 token ⇒ 401 非 10008——豁免的是端闸不是鉴权）
D app 关（h5 回开）：putConfig('client.appEnabled', false) → app 头 ⇒ 10008；h5 头 ⇒ 非 10008；
   非法值（`App`）⇒ 非 10008
E socket 新连接：registerUser 取真 token；raw io(网关, { auth: { token, clientPlatform:'app' } }) settle
   1.5s ⇒ 不 connected（锚断连不锚帧）；对照 { token, clientPlatform:'h5' } ⇒ connected ✓（收尾断开）
E′ ⚠️ r1 重要 6 补格（C19 拦新不踢旧——本裁决核心，唯一验证方式=conformance）：两键先复原 true →
   连一条 h5 真 token socket ⇒ connected；再 putConfig h5=false → waitFor 新连接探针确认闸已咬
   （第二条 h5 socket ⇒ 不 connected）；随后断言 E′ 首条 socket **仍 connected 且窗口内无 disconnect**
   （settle 2s）；最后断开。⚠️ r2 次要 3：**每轮探针成功即断开**（同时在场 ≤2 名额）——否则
   waitFor 的「不 connected」有二义面（端闸拒 vs `allowRequest` 5/ip 传输层限流拒），C38 判别力受损
F 留痕：execCurl('ftl-api-gateway', 9000, '/metrics', INTERNAL_TOKEN) 读两计数器增量；
   ⚠️ r1 次要 15：网关日志 `docker logs ftl-api-gateway` grep `client-gate blocked` **并抽样断言
   含 `platform=`**（不钉整行格式）
收尾：两键还原 true（adminPutConfig）+ 复验探针（无头/带头均非 10008）+ 连接全断 + owners info 落档
```
- [ ] **Step 2: 注册两处**：`run.ts` import + 表项（title 体例照邻片）；`baselines.json` **只加 full 列**初值（先按源内静态计数，跑后按实况校正；⛔ 不填 render 列——ci.yml 的 render 步骤键集恰好相等，真栈片无 render 步骤）。
- [ ] **Step 3: 构建 + 本机真栈跑**。**前置（⚠️ r2 次要 4 钉死）**：以**本分支源码**重建并重启两容器——`docker compose -f docker-compose.yml -f docker-compose.override.yml build api-gateway config-service` 后 `… up -d`（⛔ 不用 `conformance-stack.sh` 的 pull 模式——会跑旧发布镜像，⓪ 前置自证反成归因难题；quirk 9/16 同族）。
Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-26-client-gate`
Expected: 全绿；**连跑两跑**读数一致（纪律③：日志存 `.superpowers/sdd/2026-10-15-client-gate/`）。
- [ ] **Step 4: 基线回填**（按实跑读数；若走静态计数路线则写明依据）。
- [ ] **Step 5: Commit**
```bash
git add tools/conformance
git commit -m "test(conformance): slice-26-client-gate（六组真栈：闸矩阵/真链/豁免/socket/留痕/复原）"
```

---

### Task 9: 文档/env/全仓收口 + 部署

**Files:**
- Modify: `docs/design.md`（§2.3 env 表加 api-gateway 持有行；§11.2 表加 10008 行——与 `errors.test.ts` SPEC_CODES 同步）
- Modify: `docker-compose.yml`（网关块加 `CONFIG_SERVICE_RPC_HOST/PORT`）
- 收口面：全仓双面 grep（`\b41\b|\b42\b|\b44\b` + 「四十一/四十二键」+「5+1 配置叶」）三桶分类

- [ ] **Step 1: 文档 + env 三处**（改完 `pnpm --filter @fight-the-landlord/protocol exec vitest run src/errors.test.ts` 复跑——§11.2 与 SPEC_CODES 同 PR 纪律）。
- [ ] **Step 2: C8/C42 收口实扫**（⚠️ r1 重要 7 + 次要 16 补全扫描面）：
  ① **必改清单（点名，不是 grep 生成——它们是必红、非假红）**：conformance 5 片 7 处「42 键」断言——`slice-18-gold-room.ts:1012`（`checks.eq(adminKeys.length, 42, …)`）、`slice-20-risk-control.ts:142`（`const TOTAL_CONFIG_KEYS = 42;`）、`slice-22-pay-channel.ts:950/1193`、`slice-23-notify-channel.ts:735/1283`、`slice-24-ads-relief.ts:795`——逐处改为 44（并核对该片其余派生断言）。
  ② **扫描面含 `docs/`**：`docs/design.md` 是**活面文献**（非历史计划）——实读 8+ 处「四十一键」文（`:142/:409/:493/:500/:1136/:1560/:2036` 等）处置为四十四键，且**「数字 + 键族列举」同改**（⚠️ r2 次要 6：原列举缺台费与客户端接入两键 ⇒ 只改数字会让权威文档自相矛盾）；⚠️ `docs/design.md` §7.5 键表是 admin CONFIG_NOTES 的明示内容源（`admin/app.js:310` 注释），两处措辞须一致。
  ③ 全仓双面 grep（⚠️ r2 次要 6 恢复显式命令）：`grep -rnE '\b41\b|\b42\b|\b44\b' --include='*.ts' --include='*.js' --include='*.vue' --include='*.md' packages/ apps/ admin/ scripts/ tools/ docs/ | grep -v dist` ∪ 中文面（`grep -rn '四十一键\|四十二键' packages/ apps/ admin/ scripts/ tools/ docs/`）∪「5+1 配置叶」——产三桶清单（① 改完 ② 白名单登记 ③ 历史计划文档豁免）；②桶逐条落进提交信息。
  ④ ⚠️ r1 次要 12 补 **C29 验证步**：`grep -rn '10008' packages/*/src/http/errors.ts` ⇒ **零命中**（HTTP_STATUS 面不含它；唯一产码点 = 网关 `CodedForbidden` 硬编码 403），把该 grep 输出留档。
- [ ] **Step 3: 全量门禁**：受影响包全测（protocol/config-service/api-gateway/client）+ 静态闸 + `slice-26` + 受影响既有片（14/16/17/18/19/20/22/23/24/25 凡读过键计数的）单跑一遍。
- [ ] **Step 4: 部署**：`bash scripts/deploy/deploy-dev.sh`（种子全开=零影响）→ 钉 IP 复核 + `docker exec ftl-api-gateway grep client-gate dist`（quirk 9 防空测）。
- [ ] **Step 5: 人工验收交接（用户侧清单）**：H5 新开页关闸文案；App 新包（另行打包）；管理端照常；翻转后两计数器读数。
- [ ] **Step 6: Commit**（文档/env/收口批）+ 更新交接文档。

---

## Self-Review 记录（写完对照规格的覆盖检查；v1.1 随评审 r1 更新）

- **规格覆盖（v1.1 更新）**：C1→T1 · C2→T1（新增逐键族正负样本） · C3→T2 · C4→T2（新增四子性质）/T8 · C5→T3 · C6→T3（含正则扩面） · C7→T2 · C8/C42→T9（必改清单 + docs/ 面） · C9–C16→T5（含 OPTIONS 格） · C14b→T5 · C17/C18→T6 · **C19→T8 E′ 组（v1.1 落地）** · C20–C24→T4/T9 · C25–C27→T5/T8（含 message 三要素断言） · C28/C29→T1/T9（C29 补 grep 步） · C30–C35→T7（含 C31 重连重发、transport-config 必红项） · C36–C38→T8（矩阵补非法值列） · C39→T9 · C40→T9 · C41→T9。**无缺口。**
- **占位符扫描**：克隆类文件（T4）给了差异清单 + 构造面全码；正则/测试/锚点均带实读行号。无「TBD/TODO」。
- **类型一致性**：`classifyClientPlatform`（T5 定义，T6 消费）；`snapshotOrNull`（T4 定义，T5 消费）；`clientPlatformHeaders`（T7 定义/测）；键名/头名/码值/计名与规格 §0 逐字一致。
- **已知取舍登记**：T8 E/E′ 锚断连不锚帧；T5 的 traceId 不入本层断言（NDJSON 层）；T5 ⑤ 容器形态靠 T9 Step 4 真栈实证（网关无容器门禁测）；正则扩面属「收集面只增」（注释登记）。
