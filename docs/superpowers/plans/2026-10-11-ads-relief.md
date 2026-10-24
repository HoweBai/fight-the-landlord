# 广告小片（App 端激励视频 → 每日救助）实现计划 v1.3 · 已冻结

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App 端激励视频接入金币场「每日救助」：回调即发放（claim 绑定身份）+ GET 查询/轮询 + 第四键空间管理化 + edge 路由 + conformance 新片与 slice-18 改写。

**Architecture:** 回调链「读记录短路 → 账本先行 → 正向裁决 → apply → 终态后落 done」；claim 双键（记录+索引）NX+条件删；观测沿既有指标名（`currency_relief_total` 零改动）+ 新回调面计数；键空间克隆 pay/notify 四件套；客户端薄层 `net/ads.ts` + lobby 流程重写。

**Tech Stack:** TypeScript / NestJS / ioredis（WATCH/MULTI）/ vitest / TypeORM 迁移 / bash（stack.sh）/ conformance TS 驱动 / uni-app（uni.createRewardedVideoAd）。

**上游（契约唯一真源）：** 规格 **v1.3 冻结**（`ac7ff27`）（`docs/superpowers/specs/2026-10-11-ads-relief-spec.md`）；设计 v1.4 冻结 `2637e18`。**实施中任何与规格相抵的发现 ⇒ 停手登记，不擅自改道。** 本计划经 plan-r1–r4 四轮评审 → **plan-r4「可通过（计划可执行）」放行冻结**（报告 `.superpowers/sdd/2026-10-11-ads/review-plan-r4.md`；`08fd329` 即冻结本）。

## Global Constraints（每个任务隐性包含；逐条来自规格）

1. 第 41 键 `ad.reliefAdpid`：string，trim 后 `''`（合法=未配置）或 `^[0-9A-Za-z]{1,32}$`；**客户端下发裸名 `reliefAdpid`**（第 15 键），归一/fail 方向 = 空串。
2. claim 常量：nonce = `randomBytes(16).toString('base64url')`（22 字符）· issued TTL **900s**（eligible GET 续期）· done TTL **172800s** · 双键 `relief:claim:{nonce}` + `relief:claim:u:{userId}` · find-or-create = NX + **条件删** · done 落定删索引。
3. 回调链五条不可放宽：①链序（读记录 done 短路 → 账本先行 → 正向裁决 ①快照 503/10007 ②开关 ③余额 → apply → 终态后落 done）②计数六路径（§2.7 表）③身份只来自 claim ④应答词面封闭 ⑤防护链次序 405→415→413→429→验签。
4. `AD_NOTIFY_PATH = '/ad/notify/uniad'`（精确豁免对钉）· 限流键 `ad:notify:rate`（60s / >600 拒 / fail-open+WARN）· 16KB 闸（`rawBody` 字节）。
5. 第四键空间：域 `ad-channel` · 表 `ad_channel_config` · 迁移 `1795000000000`（表）+ `1795100000000`（键种子，值 `'""'`）· RPC `config.adChannel.get` · env **`AD_CHANNEL_PULL_TOKEN`**（两持有：config-service + currency-service）· 网关 P-a1/P-a2（仅 super_admin，置 P9 前）· 管理页第 12 视图 · 主钥复用 `PAY_CONFIG_ENC_KEY` · 消费侧「现拉 + lastGood，无 lastGood ⇒ 回调 5xx」。
6. reason 文案逐字：`今天已经领过了` / `救助暂未开放` / `余额充足，无需救助` / `领取凭证已失效，请重试`；客户端本地文案：`完整观看才能领取` / `暂时没有可播放的广告，稍后再试` / `发放可能稍有延迟，稍后回到本页查看` / `已领取救助 +N` / `网络异常，请重试`。
7. 每任务：先写失败测试 → 跑红 → 最小实现 → 跑绿 → **git commit**（尾行 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）；提交只 add 显式路径。
8. 命令口径：单包测 `pnpm --filter @fight-the-landlord/<pkg> test`（过滤 `… test -- <file>`）；六阶段 `bash scripts/ci.sh`；编排自检 `docker compose config -q`；真栈 `bash scripts/deploy/conformance-stack.sh up`（含 `--profile edge --profile monitoring`）。
9. Windows/本机：git bash；**行号 = 规格取证于 HEAD `7af1642`，实施时以实文复核**；docker build 不需代理参数（先查 base 镜像在不在本地）。
10. **T0 边界**（规格 §8）：凡涉验签算法/密钥形态（T0-2）· 内容类型闸与响应码/词面（T0-3）· 基座形态（T0-4）· extra 字符集（T0-5）——相关步骤显式标注 `【T0-x 到货后】`。**相位**：T13/T20/T21/T22 的**真绿判定**以 T0-2 到货为前置（签名样本定稿前，相关组先落「构造面 + 缺省夹具」跑红绿骨架；到货后按单点回填再判真绿）；其余任务到货前即可全绿。到货后按单点回填（规格 §8 表）。

## 任务总览与波次

| 波 | 任务 | 交付 | 规格映射 |
|---|---|---|---|
| W1 | T1 protocol 键面 | 41 键 + `parseReliefAdpid` + 15 客户端键 | §2.1 |
| W1 | T2 种子迁移 | `1795100000000` + 迁移测试 | §2.2 |
| W1 | T3 config-service 同步面 | 四副本/名单/计数/组装/deny-list | §2.2 · §5.3 行 1–3 |
| W2 | T4 protocol `ad-channel` | 常量文件 + index（**pattern 归 T7**） | §2.3 |
| W2 | T5 表迁移 | `1795000000000` + 迁移测试 | §2.3 |
| W2 | T6 `ad-channel` 四件套 | controller/service/crypto/validators + 单测 | §2.3 |
| W2 | T7 RPC 接收侧 + 假库 | 第四 `@MessagePattern` + 第五套 Fake | §2.3 |
| W2 | T8 网关 policy + 转发 | P-a1/P-a2 + 三方法 + 单测 | §2.3 · §3 |
| W2 | T9 管理页 | 第 12 视图 + NOTES + 计数 + G12 针脚 | §2.3 |
| W2 | T10 shared/编排/栈 | redact + NEW_ENVS + compose + stack 种子 | §2.3 · §5.4 |
| W3 | T11 回调挂载 + 限流 | main.ts 三件套 + `AdRateLimiter` | §2.4 |
| W3 | T12 claim 服务 | `claim.service.ts`（NX+条件删）+ 单测 | §2.6 |
| W3 | T13 验签器 | `ads-verifier.ts` 接口 + 【T0-2】实现 | §2.4 · §8 |
| W3 | T14 回调业务链 | `ad-callback.service.ts` + 单测（落序两注入） | §2.4 · §2.6 · §2.7 |
| W4 | T15 查询端点 | `GET /api/wallet/relief`（两侧）+ 网关 query 白名单 | §2.5 |
| W5 | T16 观测 | `relief_callback_total` + 告警 2 条 + 计数面（yml 源 + slice-16 七点 + slice-18 一点） | §2.7 |
| W5 | T17 edge 路由 | Caddyfile 行 + 重建手顺 | §2.8 |
| W6 | T18 客户端薄层 | `net/ads.ts` + 单测 | §2.9 |
| W6 | T19 lobby 流程 | store/lobby/rest/manifest + 单测 + 源码闸 | §2.9 |
| W7 | T20 夹具 | `fixtures/ad-callback/` + 签名 helper + gitleaks 连带 | §5.4 |
| W7 | T21 slice-24 | 十二组 + baseline 条目 | §5.2 |
| W7 | T22 slice-18 G 改写 | 新链驱动 + H 断言逻辑不动（除 :1322 计数面） | §5.2 · §5.3 行 6 |
| W7 | T23 计数面迁移 | 七片计数 40→41/14→15 | §5.3 行 4 |
| W8 | T24 文档面 | design.md/client-protocol/first-deploy/ledger/注释扫 | §6 |
| W8 | T25 收口 | baselines + 六阶段 + 全序 + 交接 | §5.5 · §7 |

依赖：T2←T1；T3←T1,T2；T5←T4；T6←T4,T5；T7←T6；T8←T4；T9←T6；T10←T7,T8；T11←T10（env）；T12,T13,T14←T11；T14←T12,T13；T15←T12；T16←T14,T15；T18←空；T19←T15,T18；T20←T13；T21←T14,T20；T22←T21；T23←T15；T24,T25←全部。

---

### T1 — protocol 第 41 键 + string 校验 + 第 15 客户端键

**Files:**
- Modify: `packages/protocol/src/config.ts`（`CONFIG_KEYS` :85/:86 间 · `CLIENT_CONFIG_KEYS` **:103/:104 间（`'version'` 前——数组插位；测试 :37-44 为同序镜像、插位相同）** · `ClientConfig` :122/:123 间 · `parseConfigValue` 分支于 :201 兜底前 · 头注 :3）
- Test: `packages/protocol/src/config.test.ts`（:12-36 追加 + **:37-44 镜像名单 `'version',` 前插** · 新 describe）

**Interfaces:**
- Produces: `CONFIG_KEYS` 41 项（`'ad.reliefAdpid'` 末位）· `CLIENT_CONFIG_KEYS` 15 项（`'reliefAdpid'` 于 `'version'` 前）· `ClientConfig.reliefAdpid: string` · 模块私有 `parseReliefAdpid(value): string`。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

`config.test.ts`：40→41 名单尾部追加 `'ad.reliefAdpid',`；14→15 名单（:37-44 是**位置敏感镜像**——与 `config.ts` 数组同序，非排序名单！）在 **`'version',` 行之前**插 `'reliefAdpid',`（镜像位 = `'withdrawDailyMaxCoins'` 后；⚠️「`'rechargePackages'`/`'reliefEnabled'` 之间」是 **config-service `client-config.test.ts` 排序名单**的插位（T3），两处语境不可互换）；新增用例族（文案断言用**动态 RegExp**——vitest 2.1.9 `toThrow(asymmetric)` 恒 false 的教训，照 `:265-271` 形态）：

```ts
describe('parseReliefAdpid（第 41 键 · 首个 string 型）', () => {
  it('合法：空串 / base62 / 恰 32 位（trim 后返回）', () => {
    expect(parseConfigValue('ad.reliefAdpid', '')).toBe('');
    expect(parseConfigValue('ad.reliefAdpid', '  abc123  ')).toBe('abc123');
    expect(parseConfigValue('ad.reliefAdpid', 'A'.repeat(32))).toBe('A'.repeat(32));
  });
  it('非法：33 位 / 含 - _ 中文 空格 / 数字 / boolean / null ⇒ 抛 ProtocolError', () => {
    for (const bad of ['A'.repeat(33), 'a-b', 'a_b', '中', 'a b', 200, true, null, undefined]) {
      expect(() => parseConfigValue('ad.reliefAdpid', bad)).toThrow(ProtocolError);
    }
    expect(() => parseConfigValue('ad.reliefAdpid', 200)).toThrow(/必须是字符串/);
    expect(() => parseConfigValue('ad.reliefAdpid', 'a-b')).toThrow(/base62/);
  });
});
```

- [ ] **Step 2: 跑红** `pnpm --filter @fight-the-landlord/protocol test -- config.test.ts` ⇒ 名单长度断言失败。

- [ ] **Step 3: 实现（`config.ts`）**

`CONFIG_KEYS` 尾（`'record.cleanupIntervalMs',` 后）：

```ts
  /** 第 41 键：救助广告位 adpid（客户端下发裸名 `reliefAdpid`；空串=未配置 ⇒ 救助入口不渲染）。 */
  'ad.reliefAdpid',
```

`CLIENT_CONFIG_KEYS`：**`'version',` 行之前**插 `  'reliefAdpid',`（数组插位，与支付七键先例同——test 侧**镜像**插位见 Step 1）；`ClientConfig` 接口 `withdrawDailyMaxCoins: number;` 后插 `reliefAdpid: string;`。`parseConfigValue` 于 `throw …未知配置键`（:201）**之前**：

```ts
  if (key === 'ad.reliefAdpid') return parseReliefAdpid(value);
```

实现（`parseIntervalMs` 邻位）：

```ts
/** 救助广告位 adpid：string；trim 后 `''`（未配置）或 base62 ≤32（规格 §2.1 ⚙️A）。 */
function parseReliefAdpid(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProtocolError('ad.reliefAdpid 必须是字符串（严格类型：数字 / 布尔不算）');
  }
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!/^[0-9A-Za-z]{1,32}$/.test(trimmed)) {
    throw new ProtocolError('ad.reliefAdpid 必须是 ≤32 位 base62 字母数字（或空串）；已 trim');
  }
  return trimmed;
}
```

头注 :3「四十键清单」→「四十一键清单」。

- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/protocol test` ⇒ 全绿。

- [ ] **Step 5: Commit** `git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts && git commit -m "feat(protocol): 第 41 键 ad.reliefAdpid（首个 string 型）+ 客户端第 15 键 reliefAdpid"`

---

### T2 — 种子迁移 `1795100000000-AdReliefAdpidSeed.ts`

**Files:**
- Create: `packages/config-service/src/migrations/1795100000000-AdReliefAdpidSeed.ts`
- Test: `packages/config-service/test/migration.test.ts`（新段，照 Interval 块 `:796-869`）

**Interfaces:**
- Produces: 表 `platform_config` 第 41 键种子（`''`）。
- Consumes: T1 的键名。

- [ ] **Step 1: 写失败测试**（`migration.test.ts` 加新段：up 的 INSERT 整句含 `ad.reliefAdpid` 与 `'""'` 字面量 · 元组恰 1 · down 的 DELETE 单键 · 时间戳 `1795100000000` 全仓唯一（走既有扫描段））

- [ ] **Step 2: 跑红** `pnpm --filter @fight-the-landlord/config-service test -- migration.test.ts`

- [ ] **Step 3: 实现迁移**（形状照 `1794000000000-IntervalConfigSeed.ts:37-61`，单元组）：

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 第 41 键种子：`ad.reliefAdpid` = 空串（= 未配置 ⇒ 救助入口不渲染；暗上线语义）。
 * ⚠️ **string JSON 字面量首例**：`'""'` 是空字符串（不是空值）——数值先例 `'60000'` 会误导。
 */
export class AdReliefAdpidSeed1795100000000 implements MigrationInterface {
  name = 'AdReliefAdpidSeed1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        `('ad.reliefAdpid', '""', 1, NOW(3), 'seed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'ad.reliefAdpid'");
  }
}
```

- [ ] **Step 4: 跑绿** ⇒ migration 段全绿（含全仓时间戳唯一扫描）。

- [ ] **Step 5: Commit** `git add packages/config-service/src/migrations/1795100000000-AdReliefAdpidSeed.ts packages/config-service/test/migration.test.ts && git commit -m "feat(config-service): 第 41 键种子迁移（string JSON 字面量首例 '""'）"`

---

### T3 — config-service 同步面（四副本 + 名单 + 组装 + deny-list）

**Files:**（逐处实读改；行号 = 规格 §5.3 行 1–3 实测清单）
- `packages/config-service/test/helpers/config-probe.ts`（SEED `:140-191` 尾 +1；头注 `:29-32` 登记面同步）
- `test/platform-config.service.test.ts`（SEED `:204-256` +1；头注 `:200-203`；计数 `:297/:303/:304` 40→41）
- `test/admin.controller.test.ts`（`:175-221` 名单 +1）
- `test/config.rpc.test.ts`（`:113-159` 名单 +1）
- `test/client-config.test.ts`（排序 15 键 `reliefAdpid` 插 `'rechargePackages'`/`'reliefEnabled'` 间；`:97-108` deny-list **补 `'ad.'`**；`:139/:161` 兜底恒 15）
- `src/config/client-config.controller.ts`（组装行 :63/:64 间 + 头注 :8-13/:21-22/:32 计数）

**Interfaces:**
- Produces: 组装行 `reliefAdpid: (byKey.get('ad.reliefAdpid') ?? '') as string`（**fail 方向空串**）；`/api/config` 恰 15 键。

- [ ] **Step 1: 全量改四处名单/副本**（先跑一次现有测试全绿作基线：`pnpm --filter @fight-the-landlord/config-service test`）
- [ ] **Step 2: 组装行 + 头注实现**：

```ts
    reliefAdpid: (byKey.get('ad.reliefAdpid') ?? '') as string,
```

- [ ] **Step 3: 跑绿** `pnpm --filter @fight-the-landlord/config-service test` ⇒ 全绿（含 client-config 15 键 + deny `'ad.'`）。
- [ ] **Step 4: Commit** `git add packages/config-service/src/config/client-config.controller.ts packages/config-service/test && git commit -m "feat(config-service): 第 41 键四面同步 + 客户端第 15 键组装（fail 方向空串）"`

---

### T4 — protocol `ad-channel` 常量 + index（**RPC pattern 移至 T7 与接收侧同提交**——J21 闸 `robot-availability-wiring.gate.test.ts:205` 断言「接收侧集合 == `RPC_PATTERNS` 键」全仓扫描，pattern 先落 ⇒ 至 T7 前恒红）

**Files:**
- Create: `packages/protocol/src/ad-channel.ts` + `src/ad-channel.test.ts`
- Modify: `src/index.ts`（:21 邻 +export）

**Interfaces:**
- Produces: `AD_CHANNEL_KEYS = ['ad.callbackSecret'] as const`（**工作名，T0-2 回填可改**）· `AdChannelKey` · `AD_CHANNEL_SECRET_KEYS` · `ConfigAdChannelGetRequest/Response`。（RPC pattern 归 T7。）
- Consumes: `RpcMeta`（照 `pay-channel.ts:39-43`）。

- [ ] **Step 1: 写失败测试**（照 `pay-channel.test.ts`：键名单恰 1 · 全键 ∈ SECRET · 类型导出。）
- [ ] **Step 2: 跑红** `pnpm --filter @fight-the-landlord/protocol test -- ad-channel.test.ts`
- [ ] **Step 3: 实现**（`ad-channel.ts` 全文形态照 `pay-channel.ts:1-52` 克隆；差异三处：HEADER 注释「第四键空间 · 广告回调密钥」/ 键名单 1 枚 / 类型名 Ad 前缀）：

```ts
/** 第四键空间（广告回调密钥）——不入 CONFIG_KEYS、不进广播、纯常量零依赖（照 pay-channel.ts 体例）。 */
export const AD_CHANNEL_KEYS = ['ad.callbackSecret'] as const;
export type AdChannelKey = (typeof AD_CHANNEL_KEYS)[number];
export const AD_CHANNEL_SECRET_KEYS: readonly AdChannelKey[] = AD_CHANNEL_KEYS;
export interface ConfigAdChannelGetRequest {
  pullToken: string;               // 先例 pay-channel.ts:40 —— 常数时间比对（T7 接收侧消费）
  meta?: RpcMeta;
}
export interface ConfigAdChannelGetResponse {
  values: Partial<Record<AdChannelKey, string>>;   // 字段名 `values` 照先例 pay-channel.ts:51（消费面读 res.values）
}
```

`index.ts:21` 邻 +`export * from './ad-channel';`。

- [ ] **Step 4: 跑绿** ⇒ protocol 全绿（不含 messages 面——pattern 归 T7）。
- [ ] **Step 5: Commit** `git add packages/protocol/src/ad-channel.ts packages/protocol/src/ad-channel.test.ts packages/protocol/src/index.ts && git commit -m "feat(protocol): 第四键空间 ad-channel 常量（pattern 随 T7 接收侧同提交）"`

---

### T5 — 表迁移 `1795000000000-AdChannelConfig.ts`

**Files:**
- Create: `packages/config-service/src/migrations/1795000000000-AdChannelConfig.ts`
- Test: `packages/config-service/test/migration.test.ts`（新段）

- [ ] **Step 1: 写失败测试**（同 T2 体例：CREATE 整句/列清单/down DROP/时间戳唯一）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（DDL **逐字**照 `1793000000000-NotifyChannelConfig.ts:26-33`，仅表名换 `ad_channel_config`；类名 `AdChannelConfig1795000000000`；**无种子**）
- [ ] **Step 4: 跑绿**
- [ ] **Step 5: Commit** `git add packages/config-service/src/migrations/1795000000000-AdChannelConfig.ts packages/config-service/test/migration.test.ts && git commit -m "feat(config-service): ad_channel_config 表迁移（DDL 逐字照通知片）"`

---

### T6 — `ad-channel` 四件套

**Files:**
- Create: `packages/config-service/src/ad-channel/{ad-channel.controller.ts,ad-channel.service.ts,ad-channel.crypto.ts,ad-channel.validators.ts}`
- Test: `packages/config-service/test/{ad-channel.controller.test.ts,ad-channel.service.test.ts,ad-channel.crypto.test.ts,ad-channel.validators.test.ts}`

**Interfaces:**
- Produces: 管理面三端点（**路径照 pay/notify 先例逐字形，无 `/status` 后缀**）：`GET /api/admin/ad-channel`（掩码读 · P8）· `PUT /api/admin/ad-channel/:key` · `DELETE /api/admin/ad-channel/:key`；`set/get/clear/pull` 服务方法。
- Consumes: T4 键名单 · T5 表。

- [ ] **Step 1: 克隆四件 + 替换差异**（逐文件照抄，差异表）：

| 文件 | 先例 | 差异 |
|---|---|---|
| `ad-channel.service.ts` | `pay-channel.service.ts`（SQL 四常量 :62-77 · 1213 重试 · 审计两列两形态 `:288/:344`） | 表名 `ad_channel_config` · 键类型 `AdChannelKey` |
| `ad-channel.crypto.ts` | `notify-channel.crypto.ts`（文案三枚 `:31-33`） | 域文案「广告回调密钥」 |
| `ad-channel.validators.ts` | `notify-channel.validators.ts:140-166` | 键材料形态校验**随 T0-2**（先落「非空字符串 ≤512」占位 + 注释 【T0-2 到货后按密钥形态收严】） |
| `ad-channel.controller.ts` | `pay-channel.controller.ts:55-130`（**路由面 `:60` 邻逐字**：`@Controller('admin')` + 三端点路径 `admin/ad-channel`——GET 无后缀） | 错误序 401→400→503 判别性专测 |

- [ ] **Step 2: 四份单测** 照 pay 四件（514/130/581/247 行）克隆改域；**错误序专测**（未登录 401 · 未知键/坏形态 400 · 主钥缺 503）。
- [ ] **Step 3: 跑绿** `pnpm --filter @fight-the-landlord/config-service test -- ad-channel`
- [ ] **Step 4: Commit** `git add packages/config-service/src/ad-channel packages/config-service/test/ad-channel.* && git commit -m "feat(config-service): 第四键空间 ad-channel 四件套（克隆先例）"`

---

### T7 — RPC 接收侧 + 模块注册 + 第五套假库

**Files:**
- Modify: `src/rpc/config.rpc.controller.ts`（**第四** `@MessagePattern`，形态照 `:141-162`；`pullTokenMatches` env 联合 `:171` +`AD_CHANNEL_PULL_TOKEN`；类头注计数句 **`:26` 与 `:30`**「三条」→「四条」）· **`packages/protocol/src/rpc.ts`（`configNotifyChannelGet` 后 +`configAdChannelGet = 'config.adChannel.get'`，注释长档照 `:99-116`）+ `packages/protocol/src/messages.test.ts:70-71`（全量 toEqual +1）——J21 约束：pattern 与接收侧同提交** · `src/config/config.module.ts`（controllers/providers **各 +1**）· `test/helpers/config-probe.ts`（+第五套 `FakeAdChannelDb`；头注 `:46-49` 登记）· `test/config.rpc.test.ts`（+新 describe 组，照 `:188-343`）
- Test: 上述

**Interfaces:**
- Produces: `config.adChannel.get` 接收侧（10002「拉取令牌不匹配」· 10007「广告回调密钥存储未启用」——**无「（缺主钥）」后缀**；文案形态照 `:104/:111/:146/:153` 各处现文）。
- Consumes: T6 service · **`ConfigAdChannelGetRequest/Response`（T4 常量）+ pattern 自产（同提交）**。

- [ ] **Step 1: 写失败测试**（token 正/负 · 空串=未设 · 主钥缺 10007 · 快照含 ad 段）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（接收侧方法 + env 联合 + 模块注册 + 假库；**常量与接收侧同提交**——J21 闸 `robot-availability-wiring.gate.test.ts:205`）
- [ ] **Step 4: 跑绿**（含 **protocol** 包 J21 闸：`pnpm --filter @fight-the-landlord/config-service test && pnpm --filter @fight-the-landlord/protocol test -- robot-availability-wiring`）
- [ ] **Step 5: Commit** `git add packages/config-service/src/rpc packages/config-service/src/config/config.module.ts packages/config-service/test/config.rpc.test.ts packages/config-service/test/helpers/config-probe.ts packages/protocol/src/rpc.ts packages/protocol/src/messages.test.ts && git commit -m "feat(config-service): config.adChannel.get 接收侧 + pattern 同提交 + 第五套假库"`

---

### T8 — 网关 policy + 转发

**Files:**
- Modify: `packages/api-gateway/src/auth/admin-policy.ts`（前缀常量 + P-a1/P-a2 置 P9 前，照 P-n2 `:281-289`；单角色编码变体注释照 :271-279）· `src/gateway/gateway.controller.ts`（三方法：GET/PUT/DELETE 照 `:220/:234/:254` 形态，`:key` 经 `encodeURIComponent`）
- Test: `test/admin-policy.test.ts`（新组，含**钉序**断言）· `test/gateway.controller.test.ts`（+转发用例；`a?b=1` 编码用例照 :336-342）

- [ ] **Step 1: 写失败测试** · [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（policy：PUT/DELETE 仅 `super_admin`；转发照抄）
- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/api-gateway test`
- [ ] **Step 5: Commit** `git add packages/api-gateway/src/auth/admin-policy.ts packages/api-gateway/src/gateway/gateway.controller.ts packages/api-gateway/test/admin-policy.test.ts packages/api-gateway/test/gateway.controller.test.ts && git commit -m "feat(gateway): ad-channel 管理面 policy P-a1/P-a2 + 三转发"`

---

### T9 — 管理页第 12 视图 + NOTES + 计数 + G12 针脚

**Files:**
- Modify: `admin/app.js`（VIEWS `:410-421` · VIEW_ORDER `:452` 11→12 · state `:527-536` · 懒加载 `:862-863` · 新视图函数（照通知视图 `:2187-2387` **单列表**简化）· nav 监听 `:3318-3319` · `CONFIG_NOTES` 追加点 `:384/:385` 间 · 计数注记链 **`:110-111/:124/:134-137/:290-292/:646/:662`**）· `admin/index.html`（nav + `<section>` 照 `:40/:119-128`）
- Test: `tools/conformance/src/slices/slice-19-admin-rbac-audit.ts`（G12 针脚，取 **pay 形态两表**——app.js 针照 `:1430-1433` + index.html 针照 `:1461-1464`，各 +3~4 条）

- [ ] **Step 1: CONFIG_NOTES 条目（**数组对格式逐字——`['标签', '文案']` 四行，渲染器 `for (const [label, text] of lines)` 按对解构（`admin/app.js:696-703`），**不得平铺字符串**——新键唯一文案真源）**：

```js
  'ad.reliefAdpid': [
    ['作用', '救助广告位 ID（App 端激励视频）—— 填了它且救助开关（currency.reliefEnabled）打开时，「看广告领救助」才可用。'],
    ['取值', '字母数字字符串 ≤32 位；以带引号字符串输入（如 "abc123"）；空串（""）= 未配置 ⇒ 入口关闭。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '与 uni-ad 后台申请的广告位 ID 逐字一致；换广告位 = 改此键即生效（在途观看按旧凭证锚发放，不双发）。'],
  ],
```

（⚠️ 文案行内**不得出现 markdown `**`**——管理页按纯文本渲染，星号会字面显示。）

- [ ] **Step 2: 视图实现**（掩码写照抄：secret 行只显 `已配置 ✓ · 指纹 <12hex>`、`value` 恒 null、输入框不预填、保存/清空仅 super_admin；**string 键编辑器 = JSON textarea 带引号输入**）
- [ ] **Step 3: 计数注记 + G12 针脚**（「11 视图」→12；针脚在 slice-19 两表）
- [ ] **Step 4: 跑绿**（admin 无独立测试面——由 slice-19 G12 + 手工核对；`node -e "require('./admin/app.js')"` 无法直跑 ⇒ 以浏览器/切片核验，实施时按 slice-19 判据）
- [ ] **Step 5: Commit** `git add admin/app.js admin/index.html tools/conformance/src/slices/slice-19-admin-rbac-audit.ts && git commit -m "feat(admin): 第 12 视图「广告回调」+ CONFIG_NOTES + 计数 + G12 针脚"`

---

### T10 — shared / 编排 / 栈补给

**Files:**
- Modify: `packages/shared/src/logging/redact.ts`（`SECRET_KEY_NAME` :104 **加密钥键名（工作名 `ad.callbackSecret`，T0-2 回填可改）**；正反用例——`AD_CHANNEL_PULL_TOKEN` **无需加**：段界规则 `(^|[._])pull[_]?token$`（`:104`）已覆盖）· `packages/shared/test/design-md-ai-rollout.gate.test.ts`（`NEW_ENVS` :131-141 +1）· `docker-compose.yml`（config-service `:276` 邻 +env；currency-service `:317` 邻 +env）· `docker-compose.override.yml`（`config-service :109-110` / `currency :112-120` 空默认透传）· `scripts/deploy/conformance-stack.sh`（顶部 export 照 `:57-58/:65`；`up)` 节奏块后 `:249-251` 间加第四键空间种子段）· `tools/conformance/src/run.ts`（`??=` 照 `:134-135/:144`）· `tools/conformance/src/lib/http.ts`（+3 helper 照 `:288-298`）

- [ ] **Step 1: 写失败测试**（redact 正反 · NEW_ENVS 闸）
- [ ] **Step 2: 跑红** `pnpm --filter @fight-the-landlord/shared test`
- [ ] **Step 3: 实现**（env 名逐字 `AD_CHANNEL_PULL_TOKEN`；stack 种子段 = `seed_put` 兄弟换路径 `/api/admin/ad-channel/` + 登录/重试复用 `:192-208`；**回调测试密钥值随 T0-2**——先落占位测试值 `conformance-ad-callback-secret`，注释【T0-2 到货后换真形态】）
- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/shared test && docker compose config -q`
- [ ] **Step 5: Commit** `git add packages/shared docker-compose.yml docker-compose.override.yml scripts/deploy/conformance-stack.sh tools/conformance/src/run.ts tools/conformance/src/lib/http.ts && git commit -m "feat(infra): 第四键空间 env/compose/栈种子/redact/NEW_ENVS"`

---

### T11 — 回调挂载三件套 + 限流器

**Files:**
- Modify: `packages/currency-service/src/main.ts`（`:35` `{ rawBody: true }` · `:40` 豁免 `[...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]` · `:42` `setGlobalPrefix('api', { exclude: [AD_NOTIFY_PATH] })`）· `src/app.module.ts:65-73`（注册 AdsController——**未注册=真容器 404**）· `src/metrics/currency.metrics.ts`（+`relief_callback_total` 与类型）
- Create: `src/ads/ads.controller.ts`（骨架：路径常量导出 + `@All('ad/notify/:provider')` + 防护链五步骨架，业务留 T14）· `src/ads/ad-rate-limiter.ts`（**克隆 `payment-service/src/notify/notify.controller.ts:92-143`**，键 `ad:notify:rate`）
- Test: `test/ads.controller.test.ts`（防护链五步各一：405/415/413/429/正常路径 401-前豁免自证）· `test/ad-rate-limiter.test.ts`

**Interfaces:**
- Produces: `export const AD_NOTIFY_PATH = '/ad/notify/uniad'` · `AD_NOTIFY_MAX_BODY_BYTES = 16 * 1024` · 限流 `{ key: 'ad:notify:rate', max: 600, windowSeconds: 60 }`。
- Consumes: T10 env。

- [ ] **Step 1: 写失败测试**（照 `payment-service/test/notify.test.ts:382-391` 形态钉常量与挂载面；豁免近邻负例：`/ad/notify/uniadx` ⇒ 401）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现 main.ts 三件套 + 控制器骨架 + 限流器 + 注册**（方法闸 `@All`+自检 405（Nest POST-only 对 GET 给 404 的教训）；内容类型闸【T0-3 到货后定字面，缺省 form-urlencoded】；**AdsController 与 AdRateLimiter 进 `src/app.module.ts` providers/controllers**——照 payment `app.module.ts:55/77-78` 三件全注册；未注册 = 真容器 404/起不来）
- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/currency-service test -- ads ad-rate` + **真容器起停自证**（三件套只有真容器能验——DI 陷阱记忆；HTTP 3004 不发布宿主端口（`docker-compose.override.yml:112-117`）⇒ 探针走 **exec + curl**（`Dockerfile.currency-service:2/8` = node:20-slim **只装 curl，无 wget**——wget 先例仅在 busybox stub 容器）：`docker compose up -d currency-service` 后 `docker compose exec -T currency-service curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3004/ad/notify/uniad` ⇒ 不得 401（证明中间件豁免通）；对照组 `/api/health` 200、`/api/wallet/balance` 无令牌 401）
- [ ] **Step 5: Commit** `git add packages/currency-service/src/main.ts packages/currency-service/src/app.module.ts packages/currency-service/src/metrics/currency.metrics.ts packages/currency-service/src/ads packages/currency-service/test/ads.controller.test.ts packages/currency-service/test/ad-rate-limiter.test.ts && git commit -m "feat(currency): 回调挂载三件套 + 限流器 + relief_callback_total"`

---

### T12 — claim 服务（NX + 条件删）

**Files:**
- Create: `packages/currency-service/src/ads/claim.service.ts`
- Test: `test/claim.service.test.ts`（**单测不得依赖真 Redis**（CI Stage 4 无 redis、仓内零 testcontainers——见 Step 1）；真 Redis 面由 slice-24 ③⑩ 栈内覆盖）

**Interfaces:**
- Produces:
  - `findOrCreate(userId: string): Promise<{ nonce: string; date: string; reused: boolean }>`
  - `read(nonce: string): Promise<{ userId: string; date: string; state: 'issued'|'done'; result?: ReliefResult } | null | 'read-failure'>`
  - `markDone(nonce: string, result: ReliefResult): Promise<void>`（**条件写**：仅 issued⇒done，EX 172800，DEL 索引）
  - `RELIEF_CLAIM_TTL_SECONDS = 900` · `RELIEF_CLAIM_DONE_TTL_SECONDS = 172800`
  - `type ReliefResult = 'granted'|'replayed'|'disabled'|'balance_ok'`
  - `class ClaimTransientError extends Error`（读取/写入故障与重试耗尽的统一出口 ⇒ 上层 GET 503 / 回调 5xx）
  - 私有 `todayShanghai(): string`——**口径照 `wallet.controller.ts:55-63` 的 `reliefActionId` 同源**（Asia/Shanghai 的 YYYY-MM-DD；实施时抽同一 util，两处互指注释）
- Consumes: `RedisModule.createRedis()`（`src/redis/redis.module.ts:19-31`）；**注册**：`ClaimService` 入 `src/app.module.ts` providers（同 T11 纪律）。

- [ ] **Step 1: 写失败测试**（规格 §5.1 P3 claim 族逐条；**形态 = 扩展既有假库**——`test/helpers/fake-currency-db.ts:421-473` 的 FakeRedis 现仅 `get/set/del/scan`，本任务**扩最小语义**（全仓零 watch/multi 假库先例 ⇒ 本任务首创，注释与单测互指）：`expire`、`set … NX/EX` 返回 `'OK'|null`、**`watch`/`unwatch`/`multi`/`exec`（语义逐字：被 WATCH 的键在 EXEC 前被改 ⇒ EXEC 返 `null`（事务弃）；未变 ⇒ 依序执行并返各命令结果的数组）**；**并发交错** = 同一假库上「两客户端 + 在 watch 与 exec 之间手动插入对手操作」构造。**判别力自证**：对照组把实现换成**非条件 DEL** ⇒ 交错用例**必红**（防「测试恒绿」）。**CI Stage 4 无 redis（`ci.sh:96`）、仓内零 testcontainers ⇒ 单测不得依赖真 Redis**；真 Redis 面由 slice-24 ③⑩ 在栈内覆盖）：复用同 nonce·续期（TTL 回 900）·连发键数不增·**悬垂恢复（删记录留索引 ⇒ 新签且索引更新）**·**条件删**（交错下不误删新索引）·竞败补偿（自家记录被 DEL）· done 后新签·读取故障 ⇒ `'read-failure'`（**不与 null 混同**）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（伪代码 → 代码；条件删 = `WATCH idx → GET → 值相符 ⇒ MULTI DEL EXEC（否则 UNWATCH）`；`markDone` 同形态条件写）：

```ts
async findOrCreate(userId: string): Promise<{ nonce: string; date: string; reused: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = await this.redis.get(idxKey(userId));
    if (observed !== null) {
      const rec = await this.readRecord(observed);
      if (rec !== null && rec.state === 'issued') {
        await this.redis.multi().expire(recKey(observed), TTL).expire(idxKey(userId), TTL).exec();
        return { nonce: observed, date: rec.date, reused: true };
      }
      await this.conditionalDelIdx(userId, observed); // 悬垂：仅当值 == 观察值才删（条件删）
    }
    const nonce = randomBytes(16).toString('base64url');
    const date = todayShanghai();
    await this.redis.set(recKey(nonce), JSON.stringify({ userId, date, state: 'issued' }), 'EX', TTL, 'NX');
    const ok = await this.redis.set(idxKey(userId), nonce, 'EX', TTL, 'NX');
    if (ok === 'OK') return { nonce, date, reused: false };
    await this.redis.del(recKey(nonce)); // 补偿自家记录
    const winner = await this.redis.get(idxKey(userId));
    if (winner !== null) {
      const wrec = await this.readRecord(winner);
      if (wrec !== null && wrec.state === 'issued') return { nonce: winner, date: wrec.date, reused: true };
      await this.conditionalDelIdx(userId, winner); // 悬垂（记录不在/非 issued）：比对观察值 winner 才删
    }
    // winner 为 null（索引已被对手删除/过期）⇒ 直接重试创建；两态皆由下一轮 NX 兜底
  }
  throw new ClaimTransientError('claim find-or-create 重试耗尽'); // ⇒ 上层 503（GET）/5xx（回调）
}
```

（`private async conditionalDelIdx(userId: string, observed: string)` = `WATCH idx → GET → 当前值 === observed ⇒ MULTI DEL EXEC；否则 UNWATCH`；`readRecord`/`read`/`markDone` 同文件；读取故障（连接异常）⇒ `'read-failure'`，**不与 null（不存在）混同**。）

- [ ] **Step 4: 跑绿**
- [ ] **Step 5: Commit** `git add packages/currency-service/src/ads/claim.service.ts packages/currency-service/src/app.module.ts packages/currency-service/test/claim.service.test.ts packages/currency-service/test/helpers/fake-currency-db.ts && git commit -m "feat(currency): claim 双键服务（NX+条件删，悬垂恢复，条件写 done）"`

---

### T13 — 验签器（【T0-2 边界】）

**Files:**
- Create: `packages/currency-service/src/ads/ads-verifier.ts`
- Test: `test/ads-verifier.test.ts`

**Interfaces:**
- Produces: `RewardedCallbackVerifier`（接口 + 默认实现）：`输入 { headers, rawBody } → { ok: true; extra; transId; ts } | { ok: false; reason }`；`resolveClaim(extra): { userId; date } | { invalid: true } | { readFailure: true }`。
- Consumes: T12 `read`。

- [ ] **Step 1: 写占位实现（缺省形态 = 明确标注的缺省）**：接口与分类逻辑全落；**签名算法/canonical/密钥字段随 T0-2**——缺省实现 = HMAC-SHA256(`AD_CHANNEL_PULL_TOKEN` 为测试键？**不**——缺省 = 抛 `VerifierNotConfigured`，**回调按瞬态 5xx**（键未配置期语义正确））。
- [ ] **Step 2: 单测（分类面，实现无关）**：好样本（形状正确→走缺省拒绝路径）· 缺字段 · 畸形 · `resolveClaim` 三分类（invalid / readFailure / ok）。
- [ ] **Step 3: 跑绿**
- [ ] **Step 4: Commit** `git add packages/currency-service/src/ads/ads-verifier.ts packages/currency-service/test/ads-verifier.test.ts && git commit -m "feat(currency): 回调验签器接口与缺省形态（算法随 T0-2 回填）"`

- [ ] **Step 5【T0-2 到货后】回填**：按 T0-2 结论实现算法+canonical（一处函数），fixtures 重生成，样本直喂单测；提交单独一笔。

---

### T14 — 回调业务链（账本先行 / 落序 / 计数）

**Files:**
- Create: `packages/currency-service/src/ads/ad-callback.service.ts` + `src/ads/ad-channel.config.service.ts`（照 `pay-channel.config.service.ts:43-54`：现拉 + lastGood；**无 lastGood ⇒ 抛瞬态**）
- Modify: `src/ads/ads.controller.ts`（骨架接线）
- Test: `test/ad-callback.test.ts`

**Interfaces:**
- Produces: `processCallback({ extra, transId }): Promise<'success-terminal' | 'reject-sign' | 'reject-malformed' | 'transient'>`（控制器把前三者与 claim 无效编码为 200/4xx/5xx 与词面）。
- Consumes: T12 claim · T13 verifier · 既有 `ApplyService`/`GetService`/`ConfigCacheService`（`wallet.controller.ts:106-153` 的同款裁决四步，抽用即可）。

**链序（逐字实现，不可放宽）**：

```
① read(nonce)：'read-failure' ⇒ 抛瞬态（5xx）
② 记录 done ⇒ 短路：回调面 accepted；发放面不计；返回 success
③ 账本先行：ledgerExists(relief:{userId}:{date}) ⇒ markDone('replayed')；发放面 replayed；accepted
④ 正向裁决：hasSnapshot 缺 ⇒ 瞬态（不落 done）；开关关 ⇒ markDone('disabled') ⇒ rejected；余额 ≥ 门槛 ⇒ markDone('balance_ok') ⇒ rejected
⑤ apply（actionId=relief:{userId}:{date}）：granted ⇒ 立即计 granted ⇒ markDone('granted')；replayed/14002 ⇒ 计 replayed ⇒ markDone('replayed')
```

- [ ] **Step 1: 写失败测试（落序两注入 + 计数六路径 + 窗尾）**：

```ts
it('(a) apply 抛错 ⇒ 记录保持 issued + 5xx；重投 ⇒ 发放且落 done:granted', ...);
it('(b) apply 已提交但记录写失败 ⇒ 重投走账本先行 ⇒ replayed、done:replayed、金额不再增', ...);
it('窗尾：确认+14:59 回调 ⇒ 发放；+15:01 ⇒ claim_invalid 且不建键', ...);
it('计数六路径逐行（§2.7 表）', ...);
it('配置不可用（hasSnapshot 缺）⇒ 不落 done、5xx 可重投', ...);
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（`ledgerExists` = 账本按 actionId 存在性读——复用既有 get/apply 设施的读面或加一条只读查询，**设计 §3「actionId 内嵌签发日」口径（设计:86/91）：不看流水 created_at 落账时刻**；`AdCallbackService`/`AdChannelConfigService` **入 `src/app.module.ts` providers**（同 T11 纪律：值导入——`import type` 会容器崩））
- [ ] **Step 4: 跑绿** + **真容器自证**（DI 值导入纪律：新服务构造注入的 provider 必须**值导入**——`import type` 会容器崩，只有真容器抓得到）
- [ ] **Step 5: Commit** `git add packages/currency-service/src/ads/ad-callback.service.ts packages/currency-service/src/ads/ad-channel.config.service.ts packages/currency-service/src/ads/ads.controller.ts packages/currency-service/src/app.module.ts packages/currency-service/test/ad-callback.test.ts && git commit -m "feat(currency): 回调业务链（账本先行+落序+计数六路径）"`

---

### T15 — `GET /api/wallet/relief`（两侧）

**Files:**
- Modify: `packages/currency-service/src/wallet/wallet.controller.ts`（删 `:93-155` 旧 POST；+`@Get('relief')`）· `test/relief.test.ts`（**整族重写去向**：查询语义族）
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`（删 `@Post('wallet/relief')` `:317-329`；+`@Get` + `RELIEF_QUERY_KEYS = ['claim']` + `whitelistedQueryOf`（**唯一实现复用** `:1141-1152`；`:1138`「两个调用方」注释句**按实际调用方数订正**——现况已陈旧（≥4），以实文计数为准））· `test/gateway.controller.test.ts`（`:888-966,1132,1147` 改 + query 白名单判别 `?claim=x&smuggle=1`）

**Interfaces:**
- Produces: `GET /api/wallet/relief[?claim=]` → `{code:0, data:{eligible, grantedToday, amount, balance, claim?, reason?}}`（规格 §2.5 判定次序与五态逐字）。
- Consumes: T12 claim。

- [ ] **Step 1: 写失败测试**（无 claim 五步次序（**已领优先于余额闸**——余额回升场景）+ 携 claim 五态 + 跨主体按不存在 + 旁路 404）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（控制器新方法；网关 GET 转发 `'/api/wallet/relief' + whitelistedQueryOf(req, RELIEF_QUERY_KEYS)`）
- [ ] **Step 4: 跑绿**（两包测试）
- [ ] **Step 5: Commit** `git add packages/currency-service/src/wallet/wallet.controller.ts packages/currency-service/test/relief.test.ts packages/api-gateway/src/gateway/gateway.controller.ts packages/api-gateway/test/gateway.controller.test.ts && git commit -m "feat: GET /api/wallet/relief（五步次序+携 claim 五态）+ 旧 POST 退役"`

---

### T16 — 观测（指标 + 告警 + 计数面）

**Files:**
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（+2 条，25→27）· `tools/conformance/src/slices/slice-16-monitoring.ts`（`EXPECTED_RULES` :94-107 +2 名 · promtool 计数 :701-704 `'25'`→`'27'` · rules 名单 :764-768 随名单体）· `tools/conformance/src/slices/slice-18-gold-room.ts:1322`（`25`→`27` + 文案）

- [ ] **Step 1: 告警两条（YAML 逐字）**：

```yaml
      - alert: ReliefCallbackBroken
        expr: increase(relief_callback_total{result=~"bad_sign|error"}[10m]) > 10
        labels:
          severity: warning
        annotations:
          summary: 广告回调验签失败/内部错误 10m 内 > 10 次（密钥错配或攻击的第一道铃）
          runbook: 先看 currency-service 日志的验签失败行；核管理页「广告回调」的密钥与 uni-ad 后台是否逐字一致；疑似攻击查 edge 访问日志（回调面已有单桶限流兜底）
      - alert: ReliefGrantZero
        expr: increase(relief_callback_total[10m]) > 0 and increase(currency_relief_total{result="granted"}[10m]) == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: 回调有流量但 30m 零发放（「看了广告永不发」）
          runbook: 核窗长/时序（claim 过期）、claim 读取故障、apply 失败与余额闸误拦；对账 GET 日志与 Redis 键面
```

- [ ] **Step 2: 计数面同步**（ftl-alerts.yml 为源；**slice-16 七点**：名单体 `:94-107` · promtool 计数 `:701-704` · rules 名单 `:764-768` · 计数文案 `:93/:707/:709/:758` 四点；slice-18 `:1322` 一处）
- [ ] **Step 3: 跑红→绿**（本地无法全跑 slice-16——真栈；先静态 grep 核对全部点位字面一致，真栈判定入 T25 全序）
- [ ] **Step 4: Commit** `git add deploy/monitoring/prometheus/rules/ftl-alerts.yml tools/conformance/src/slices/slice-16-monitoring.ts tools/conformance/src/slices/slice-18-gold-room.ts && git commit -m "feat(monitoring): 救助回调两告警（25→27）全点位同核"`

---

### T17 — edge 路由

**Files:**
- Modify: `deploy/Caddyfile`（catch-all `handle {` :73 **之前**加块；照 `/pay/notify/*` :70-72 形态）：

```
	# 广告小片：激励视频回调公开面（唯一信任入口 = 验签；provider 段 = 首发平台 literal）。
	handle /ad/notify/* {
		reverse_proxy currency-service:3004
	}
```

- [ ] **Step 1: 实现 + 重建手顺（写进本任务提交信息与 T24 手册节）**：

```bash
docker compose build edge
EDGE_HTTP_PORT=8080 EDGE_HTTPS_PORT=8443 docker compose --profile edge up -d --no-deps --wait edge
```

（⚠️ 裸 `up -d` 会掉回 80/443——环境纪律第 18 条；Caddyfile 烤进镜像 `Dockerfile.edge:40` ⇒ 每次改动必 rebuild。）

- [ ] **Step 2: 真栈自证**：重建后 `curl -k -i https://localhost:8443/ad/notify/uniad -X POST` ⇒ 到达服务（非 404；无签名 ⇒ 4xx/瞬态，**证明路由通**）。
- [ ] **Step 3: Commit** `git add deploy/Caddyfile && git commit -m "feat(edge): /ad/notify/* → currency-service:3004（重建手顺见提交信息）"`

---

### T18 — 客户端薄层 `net/ads.ts`

**Files:**
- Create: `apps/client/src/net/ads.ts` + `apps/client/test/ads.test.ts`

**Interfaces:**
- Produces:

```ts
export type AdOutcome = 'completed' | 'closed' | 'unavailable' | 'error';
export function isRewardedAdSupported(): boolean;                       // detectPlatform()==='app' 的异常收口（非 App/未知平台 ⇒ false）
export function playRewardedAd(adpid: string, opts: { extra: string }): Promise<AdOutcome>;
```

- Consumes: `detectPlatform`（`net/mp-transport.ts:705`，未知平台抛错——此处包异常语义）。

- [ ] **Step 1: 写失败测试**（jsdom 注桩：`readUniSystemInfo()→{}` ⇒ browser ⇒ `isRewardedAdSupported()===false`；`{uniPlatform:'app'}` ⇒ true；四分支 `completed/closed/unavailable/error` 用假 `uni.createRewardedVideoAd` 桩）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（`uni.createRewardedVideoAd({ adpid, urlCallback: { extra: opts.extra } })`；`onClose(res.isEnded)` 仅 UX 判据，**绝不触发发放**；**无 userId 形参**）
- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/client test -- ads`
- [ ] **Step 5: Commit** `git add apps/client/src/net/ads.ts apps/client/test/ads.test.ts && git commit -m "feat(client): net/ads.ts 激励视频薄层（四分支+平台收口）"`

---

### T19 — lobby 流程重写 + store/rest/manifest

**Files:**
- Modify: `apps/client/src/net/rest.ts`（删 `claimRelief` `:327-346`；+`getRelief(claim?)` GET）· `src/stores/game.ts`（`ClientConfigState` +`reliefAdpid: string`；`setClientConfig :436-450` +写行；`:170` 邻 +缺省 `reliefAdpid: ''`）· `src/pages/lobby/lobby.vue`（`FAILSAFE_CLIENT_CONFIG :104-119` +`reliefAdpid: ''`；`normalizeClientConfig` +`reliefAdpid: raw?.reliefAdpid ?? ''`；入口 `v-if :560-562` 复合；流程 `:368-424` 重写；旧注释块 `:386-392` 删）· `src/manifest.json`（app-plus 广告配置【T0-4 到货后定形态】）
- Test: `test/wallet-entry.test.ts`（14→15 键族：`:222/:269` 邻）· **`test/lobby-ux.test.ts:923-1071` 救助族重写去向**（入口/占位流程/`rest.claimRelief` 接线 ⇒ 新流程面）· 新 `test/ads-flow.test.ts`（lobby 流程四分支 + 轮询终态三出口）· 源码闸（`test/source-gate.test.ts` 或既有形态：无 `'POST /api/wallet/relief'`/`claimRelief(`）

**流程（逐字实现）**：点击 ⇒ `getRelief()` → 可领 ⇒ 弹层 → 确认 ⇒ `getRelief()`（续窗；失败 ⇒ toast「网络异常，请重试」；不可领 ⇒ 服务端 reason）→ `playRewardedAd(adpid, {extra: claim})` → `completed` ⇒ 轮询 `getRelief(claim)` 2s×3 终态即止（成功 ⇒ 关层+`setWalletBalance`+「已领取救助 +N」；reason ⇒ 显示并止；pending 满窗 ⇒「发放可能稍有延迟，稍后回到本页查看」）；`closed` ⇒「完整观看才能领取」；`unavailable` 与 **`error`** ⇒「暂时没有可播放的广告，稍后再试」（**error 出口的映射为规格冻结后补充登记**——规格 §2.9 定义了四结果但未落 lobby 映射；两出口同文案的理由：用户视角均为「播不出来」，均不发放、不轮询——登记入 deviation-ledger）。

- [ ] **Step 1: 写失败测试**（上述全套 + 15 键归一）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑绿** `pnpm --filter @fight-the-landlord/client test`
- [ ] **Step 5: Commit** `git add apps/client/src/net/rest.ts apps/client/src/stores/game.ts apps/client/src/pages/lobby/lobby.vue apps/client/src/manifest.json apps/client/test && git commit -m "feat(client): lobby 救助流程重写（confirm 续窗+轮询终态）+ 15 键 + 源码闸"`

---

### T20 — fixtures + 签名 helper + gitleaks 连带

**Files:**
- Create: `tools/conformance/fixtures/ad-callback/`（测试密钥对 + `generate-fixtures.mjs`，照 `alipay-test/generate-fixtures.mjs` 形态；**值/形态随 T0-2**——先落占位密钥对）· 签名 helper（slice-18/24 共用，落 `tools/conformance/src/lib/ad-callback.ts`：canonical+签名，照 `alipay-stub.mjs:76-85` 近亲形态）
- Modify: `.gitleaks.toml`（**第 8 条** `[[allowlists]]`，目录锚定照第 5 条）· `tools/conformance/src/slices/slice-07.4-pipeline.ts`（`:633` 计数 7→8 + **新增一条对应 literal pin** 照 `:636-638`）· **M0.1 安全扫描规格同步**（注记 `generate-fixtures.mjs:19-20`）

- [ ] **Step 1: 夹具与生成器** · [ ] **Step 2: 连带四件**（gitleaks + pin + literal + M0.1 同步；**baselines 零调整**——pin 折叠进 C1–C10 谓词）
- [ ] **Step 3: 验证** `node tools/conformance/dist/run.js slice-07.4-pipeline --render` ⇒ 逐字「75 项断言」exit 0（**不加数**）
- [ ] **Step 4: Commit** `git add tools/conformance/fixtures/ad-callback tools/conformance/src/lib/ad-callback.ts .gitleaks.toml tools/conformance/src/slices/slice-07.4-pipeline.ts && git commit -m "test(conformance): ad-callback 夹具与签名 helper + gitleaks 第 8 条连带闸"`

- [ ] **Step 5【T0-2 到货后】**：按真形态重生成密钥对/helper（单独一笔）。

---

### T21 — `slice-24-ads-relief`

**Files:**
- Create: `tools/conformance/src/slices/slice-24-ads-relief.ts`
- Modify: `tools/conformance/src/run.ts`（CASES `:90/:91` 间注册）· `baselines.json`（`full` `:40/:41` 间 +条目）

**组设计（十二组；骨架照 slice-22/23 形态：`step()`/`checks.*`/真栈 helpers）**：

| 组 | 关键断言 |
|---|---|
| ⓪ | 前置自证（开关/adpid 种子态/规则 27 就位/无残留） |
| ① | 键空间面（管理面掩码·super_admin 写读回·非 SA 403·种子密钥生效） |
| ② | 键面（`/api/config` 恰 15 键排序字面·内部键零泄漏含 `ad.` 前缀扫描·管理面 41 键·adpid 空串种子方向+非空生效） |
| ③ | 签发面（claim 形态/双键·复用同 nonce+续期·键数不增·**悬垂**：`redisRaw` 删记录留索引 ⇒ 新签且索引更新） |
| ④ | 拒发穷尽（坏签名/畸形/未签发/过期/改串/中途切开关/中途充值/`provider` 非豁免段 ⇒ 中间件 401） |
| ⑤ | **正路一次**（经门口 `https://localhost:8443/ad/notify/uniad`——验收 Caddy 路由照 slice-21:101-102）：GET ⇒ 回调 ⇒ granted+余额+GET 已发+两指标 +1 |
| ⑥ | 重投幂等（同载荷二次 ⇒ 200+余额不变+发放面不重复计 granted） |
| ⑦ | **账本先行重放**（GET 签发 → `rpcApply` 预置 `relief:<userId>:<D>` 流水（**slice-18 形态 `:411/:1006`**——slice-21 的 rpcApply 不支持自定义 actionId）→ 回调 ⇒ replayed+余额不变+Redis 读证 done:replayed。⚠️ **不得以记录移除构造**） |
| ⑧ | **跨零点重投**（`redisRaw` :31-38 回写记录 `date` 为昨日 ⇒ 回调按昨日锚 ⇒ apply 成功且**今日** `grantedToday` 未翻转） |
| ⑨ | 轮询四态（pending/成功/终态拒绝/失效 + 只读自证（不签发不续期）+ 跨主体按不存在） |
| ⑩ | `claim_invalid` 不建键（回调前后 `redisRaw keys` 计数对照） |
| ⑪ | 旧 POST ⇒ 404（经网关） |
| ⑫ | 收尾（开关关/adpid 还原/零残留） |

- [ ] **Step 1: 写切片**（helpers 复用 `lib/http` 新三件 + 签名 helper T20；**单栈按 `--list` 顺序**——slice-24 在表尾；**④–⑧ 的签名回调谓词以 T20 helper 为准【T0-2 到货后真绿】**：到货前落构造壳 + 断言清单，到货后回填样本再判）
- [ ] **Step 2: 注册**（run.ts CASES 追加末尾 + baselines 新条目——**先按源码静态计数预估，跑后回填实况**；片含真实时序 ⇒ 按本机两跑实况回填 + CI 权威轮校正，同 slice-21/22/23 口径）
- [ ] **Step 3: 真栈跑红→绿** `bash scripts/deploy/conformance-stack.sh up && node tools/conformance/dist/run.js slice-24-ads-relief`（连跑两跑）
- [ ] **Step 4: Commit** `git add tools/conformance/src/slices/slice-24-ads-relief.ts tools/conformance/src/run.ts tools/conformance/baselines.json && git commit -m "test(conformance): slice-24-ads-relief（十二组）注册与实况回填"`

---

### T22 — slice-18 G 组原位改写（H **断言逻辑**不动；唯 `:1322` 计数由 T16 改）

**Files:**
- Modify: `tools/conformance/src/slices/slice-18-gold-room.ts`（G 组 `:1186-1256` 改写；`reliefG()`/POST 调用链 `:1195-1198` 删；`CLIENT_CONFIG_KEYS_SORTED` `:100-102` 插 `reliefAdpid`（`'rechargePackages'`/`'reliefEnabled'` 间）；`:8` 头注与 `:856/:861` 文案 14→15；**`:892` 40→41**）· `baselines.json`（slice-18 条目按实跑回填——**floor 只升不降**）

**G 改写契约**（H 的**断言逻辑**逐字不动、数据源仍由 G 提供；H 区间内唯 `:1322` 的告警计数 25→27 由 T16 同步——属计数面不属 G 改写）：四态新构造——`granted`=正路（GET 签发+签名回调）/ `replayed`=**先 GET 签发、后 RPC 预置同锚流水（`:411` 形态）、再投回调**（⚠️ 旧「扣回后再领」新链不可达，注释删正）/ `rejected×2`=中途切开关·中途充值后回调；追加「GET 已领优先于余额闸」（余额回升后 ⇒ 「今天已经领过了」）；断言数 **≥11**。

- [ ] **Step 1: 改写 + 计数面**（签名回调样本以 T20 helper 为准【T0-2 到货后真绿】） · [ ] **Step 2: 真栈单跑** `node tools/conformance/dist/run.js slice-18-gold-room`（H 三桶 ≥1/≥1/≥2 真绿为验收核心）
- [ ] **Step 3: baselines 回填（实跑读数）** · [ ] **Step 4: Commit** `git add tools/conformance/src/slices/slice-18-gold-room.ts tools/conformance/baselines.json && git commit -m "test(conformance): slice-18 G 组新链改写（H 原位，三桶数据源保真）"`

---

### T23 — 计数面迁移（七片 40→41 / 14→15）

**Files:**（逐处实读改；**操作数优先**——照规格 §5.3 行 4）
- `slice-20-risk-control.ts:141`（JSDoc 桶清单「17 既有 + 9 支付 + 8 风控 + 6 节奏」+`+ 1 广告`）· **`:142`**（`TOTAL_CONFIG_KEYS = 40`→41）· `slice-14:504` · `slice-17:1272` · `slice-21:687` · **`slice-22:853`**（sorted 字面操作数）
- 消息/文案面：`slice-14:498/:501/:505` · `slice-17:50/:1265/:1269/:1273` · `slice-18`（T22 已含）· `slice-20:717/:723` · `slice-21:688` · `slice-22:37/:854/:1027/:1097` · `slice-23:27/:731/:735/:741/:1283`

- [ ] **Step 1: 改 → 静态 grep 两口径自证**（「四十键\|40 键」残余 = 仅排除项（「第 35–40 键」序号句约 8 处）·「十四键\|14 键」= 仅 client-config 系改毕）
- [ ] **Step 2: 真栈抽跑**（slice-14 + slice-20 + slice-22 各一跑——计数片判定面）
- [ ] **Step 3: Commit** `git add tools/conformance/src/slices && git commit -m "test(conformance): 七片计数面迁移（41 键/15 键，操作数优先）"`

---

### T24 — 文档面 + 注释扫修 + 台账

**Files:**
- `docs/client-protocol.md`（`:52` data 形状 +`reliefAdpid` · `:54` 键数 · `:88` 14→15）
- `docs/design.md`（`:142/:408/:492/:499/:1092` 恰十四键句 · `:1185` 键面横幅 · `:1213/:1224/:1415/:1564/:2039` 消费者段 +`ad.` 句 · §2.3 env 面 +`AD_CHANNEL_PULL_TOKEN`）
- `docs/ops/first-deploy.md`（`:993-1033` 一览表 +`ad.reliefAdpid` 行 → 41 键 · 新增「广告怎么开通」节：回调 URL `https://<域名>/ad/notify/uniad`·换广告位·密钥轮换·edge 重建提醒）
- 注释散点两口径扫（规格 §5.3 行 3 全清单）
- `docs/superpowers/plans/deviation-ledger.md`（新条目：旧 POST 退役·四态驱动语义退役·第四键空间·edge 新行·slice-18 重写·**T19 error 出口映射**（规格冻结后补充登记））
- `scripts/deploy/conformance-stack.sh:93`（「26 个切片」→现数）· `.github/workflows/conformance.yml:32`（同）——**顺手订正实落点**（规格 §5.3 行 17）

- [ ] **Step 1: 全量改** · [ ] **Step 2: grep 自证** · [ ] **Step 3: Commit** `git add docs scripts/deploy/conformance-stack.sh .github/workflows/conformance.yml && git commit -m "docs(ads): 协议/权威/手册/台账四面同步（41 键 + 广告开通节 + 两处「26」订正）"`

---

### T25 — 收口（baselines + 六阶段 + 全序 + 交接）

- [ ] **Step 1: baselines 终值**（slice-18 实跑读数 · slice-24 两跑实况；**下调零容忍**——如需下调，提交信息写明理由）
- [ ] **Step 2: 六阶段** `bash scripts/ci.sh` ⇒ exit 0（含三件真容器自证与 gitleaks）
- [ ] **Step 3: 全序** `node tools/conformance/dist/run.js`（29 片；本机全序 + 两跑一致性）
- [ ] **Step 4: 静态终扫**（两口径 + `AD_CHANNEL_PULL_TOKEN`/`ad.callbackSecret` 全仓落点 + `claimRelief` 清零 + 旧 POST 全仓清零）
- [ ] **Step 5: 交接文档** `docs/superpowers/plans/2026-10-11-post-ads-handoff.md`（含用户侧五步上线手顺引用、T0 回填状态、真机验收清单）
- [ ] **Step 6: Commit** `git add tools/conformance/baselines.json docs/superpowers/plans/2026-10-11-post-ads-handoff.md && git commit -m "chore(ads): 收口（baselines 回填 + 全序 + 交接）"`

---

## 自检（计划 vs 规格，写后复核）

- ⚙️A–N 裁定逐条有落任务：A→T1 · B/C/D/E→T12 · F/G/H→T11 · I→T4/T5/T6/T7/T8/T9/T10 · J→T14 · K→T19 · L→T19 · M→T11（T0-3）· N→T2。
- §5.3 核销表逐行有主：行 1–3→T1/T2/T3 · 4→T23（+T22 内含）· 5→T16 · 6→T22 · 7→T15 · 8→T15/T14 · 9→T19 · 10–13→T24 · 14→T4–T10 · 15→T9 · 16→T21/T22 · 17→T24（conformance.yml:32 + stack.sh:93 实落点）· 18→T24 登记。
- T0 边界：T0-2→T13/T20/**T21/T22（真绿前置）**/T10 种子值 · T0-3→T11 闸字面 · T0-4→T19 manifest · T0-5→T12 nonce 编码 · T0-1→停手回 R1。凡标【T0-x 到货后】的步骤均有单点回填路径。
- 不可放宽五条在任务中的锚点：链序 T14 · 计数 T14/T16 · 身份 T13/T18 · 词面 T11/T14 · 防护链 T11。
- 命令口径与提交纪律逐任务在文；「六阶段只在 push 前跑」照片纪律（迭代期跑受影响包测）。

## 修订记录

| 版本 | 内容 |
|---|---|
| v1.0（2026-10-11） | 起草：T1–T25 八波 · Global Constraints 十条 · T0 边界显式标注 |
| v1.1（2026-10-11） | **plan-r1「有条件通过」全收口**（报告 `.superpowers/sdd/2026-10-11-ads/review-plan-r1.md`，8🟠+12🟡）：🟠-1 T1 插位正名 · 🟠-2 T6 路由去 `/status` 后缀 · 🟠-3 T12 测试改扩 FakeRedis · 🟠-4 T12 伪代码占位清 · 🟠-5 T9 NOTES 数组对格式 · 🟠-6 T11 exec 探针 · 🟠-7 providers 注册补入 · 🟠-8 T19 lobby-ux 去向 · 🟡 十二条 + 随行订正 |
| v1.2（2026-10-11） | **plan-r2 残项收口**（报告 `review-plan-r2.md`，判定「修毕再核」）：🟠 T1 测试侧改**位置敏感镜像**（`'version'` 前插；v1.1 的「排序名单位」为换位复发）· T12 Test 行互斥消解 + FakeRedis 扩展清单补 **`unwatch`** 与 **WATCH-改 ⇒ EXEC 返 null** 语义 + **非条件 DEL 必红判别力自证** · T11 探针改 **curl**（node:20-slim 无 wget）· **T12/T14 提交补 `app.module.ts`** · **RPC pattern 自 T4 移入 T7**（J21 闸红窗消解）· T24 提交补 `stack.sh`/`conformance.yml` · nano 六点 |
| v1.3（2026-10-11） | **plan-r3 残项收口**（报告 `review-plan-r3.md`，判定「修毕再核」；r2 五个实质残项全真闭合）：🟠 残点 T1:102「排序名单」一词正名 · **T4 代码块补 `pullToken: string` + 响应字段 `channel`→`values`**（先例 pay-channel.ts:40/:51——消费面读 `res.values`）· 总览 T4 行与 T7 Consumes 的 pattern 归属订正 · T16 「四处」标签口径全点位化（:45/:499/:525/:526） |
| **冻结（2026-10-11）** | **plan-r4：可通过（计划可执行）**——0 未闭合 / 0 新伤（报告 `review-plan-r4.md`）。**本文件（`08fd329`）即冻结本、实施契约**。随注观察（非阻断，零功能面）：`AD_CHANNEL_SECRET_KEYS` 声明式与两先例的 `as const satisfies` 字面量式不同——实施 T4 时按先例形态落即可 |
