# 支付配置管理化（渠道凭据进管理面）**规格层 v1.3（冻结）**

> **上游**：设计 v2.2 **冻结**（`665a57a`；`docs/superpowers/specs/2026-10-06-pay-channel-admin-design.md`）
> + 设计评审 r1/r2 与**规格评审 r1/r2/r3** 报告（`.superpowers/sdd/2026-10-06-pay-config/`）。
> **规格状态**：**v1.3 冻结**（r3 结论「可通过（规格冻结）」，零阻断零 🟡）。
> **本文职责**：把设计层 D1–D10 冻成**逐字契约**（DDL/键名/端点/RPC/校验/文案/判据）；实施期不得偏离，
> 任何偏离入 `.superpowers/sdd/2026-10-06-pay-config/` 台账 + `deviation-ledger.md`。

## 0. 承接与订正

### 0.1 上游与版本

| 上游 | 版本 | 承接方式 |
|---|---|---|
| 开工交接 | `plans/2026-10-06-payment-config-admin-manage.md` | 裁决 A–G/E′ 逐条落实（设计 §1.1） |
| 设计 | v2.2 冻结（`665a57a`） | D1–D10 逐条 → §2/§3 逐字；设计「规格定」留白 → §0.3 ⚙️ 裁定 |

### 0.2 D→本文落点对位

| 设计 | 本文落点 |
|---|---|
| D1 独立键空间/命名 | §2.1 · §2.2 |
| D2 加密/主钥/表形状 | §2.3 · §3.5 |
| D3 专用拉取通道（每调用+回落+令牌+meta） | §2.5 · §3.3 |
| D4 管理面/权限 E′/校验器/消息纪律 | §2.4 · §2.9 · §4 |
| D5 审计脱敏 | §3.1 ③ · §2.9 |
| D6 生命周期（轮换/备份剥离/回滚窗/真人验收） | §7 · §5.3（slice-07.5 改造） |
| D7 等价表 | §3.4 |
| D8 判据 | §5.2 · §5.3 |
| D9 台账/文档同步 | §6 |
| D10 部署/迁移/回滚 | §7 |

### 0.3 ⚙️ 规格级裁定（起草期就地定死；来源 = 设计留白 + 起飞实读）

- **⚙️1 键名逐字（六键，顺序即 UI 显示序）**：`pay.channel.gatewayUrl` · `pay.channel.appId` ·
  `pay.channel.privateKey` · `pay.channel.publicKey` · `pay.channel.sellerId` · `pay.channel.publicBaseUrl`。
  机密集 = `{pay.channel.privateKey}`（v1 唯一）。
- **⚙️2 表名/迁移号**：`pay_channel_config`；迁移 `1792000000000-PayChannelConfig.ts`（类名
  `PayChannelConfig1792000000000`；`migrationsTableName` 已独立，照 D1 惯例）。
- **⚙️3 端点逐字**：`GET /api/admin/pay-channel` · `PUT /api/admin/pay-channel/:key` ·
  `DELETE /api/admin/pay-channel/:key`（§2.4）。
- **⚙️4 RPC 逐字**：`config.payChannel.get`（§2.5）。
- **⚙️5 env 两条**：`PAY_CONFIG_ENC_KEY`（**仅 config-service**）· `PAY_CHANNEL_PULL_TOKEN`
  （config-service + payment-service）——「空串 = 未设」（`||` 不用 `??`，照 ⚙️18 先例）。
- **⚙️6 加密/指纹/规范化**：§2.3 逐字。
- **⚙️7 校验矩阵**：§2.4 表（逐键规则 + 上限）。
- **⚙️8 拉取口径**：每调用现拉 · 超时 **1000ms**（`PAY_CHANNEL_CLIENT_TIMEOUT_MS`）· 不重试 ·
  `.send` 带 `...metaFromTrace()`。
- **⚙️9 回落**：成功 = **整图替换**；失败 = 上次成功值 + 每次一条 WARN（NDJSON；文案不含值）；
  从未成功 = `null`。
- **⚙️10 权限（E′）**：写面（PUT/DELETE）**仅 `super_admin`**；读面（GET）任意已认证角色。
- **⚙️11 页面**：视图 key `'payChannel'`；`VIEWS` roles `['super_admin','operator','finance']`（**有意扩 finance**——
  「照配置视图先例」说法不实（配置视图实为 `super_admin|operator` 两角色，`app.js:290`；S-12）：本视图为**读面**扩
  finance，写控件仍仅 super_admin）；**保存/清空控件仅 `super_admin` 渲染**；视图排在 `'config'` 之后
  （`VIEW_ORDER` 第 2 位）。
- **⚙️12 文案**：§2.9 逐字。
- **⚙️13 dev 常量（仓库内，非生产）· 供给点照 `ADMIN_PASSWORD` 先例**：`PAY_CONFIG_ENC_KEY` dev 值 =
  `ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=`（= base64(32B ASCII)）；`PAY_CHANNEL_PULL_TOKEN` dev 值 =
  `dev-pay-channel-pull-token-change-in-production`。🔴 **override/compose 一律空默认透传**
  （`${VAR:-}`）——dev 值只由 **`conformance-stack.sh` export 与开发者 shell** 供给。
  理由：非空默认（`:-dev值`）会让「unset 主钥」**构造不出来**（空值也回落默认），§5.2 ⑨ 的 fail-closed
  判据将恒不可达（= 设计 D8-⑨ 的构造前提被破坏）；空默认 + 显式 export 则「裸 `docker compose up`
  = 渠道关闭（503）」与 `ADMIN_PASSWORD` 的「未设 ⇒ 管理面关闭」逐字同构。
- **⚙️14 备份剥离**：`backup.sh` 的 ⓒ 段 = `awk '!/^PAY_CONFIG_ENC_KEY=/' "$ENV_FILE" | gzip -c > tmp`
  （awk ⇒ 空输入 exit 0，避 pipefail 坑；**不得**裸 `grep -v`）。
- **⚙️15 slice-07.5 判据 d 派生规则**：期望 = 源 `.env` 逐行过滤 `^PAY_CONFIG_ENC_KEY=` 后的逐字内容
  （行序/换行不变；规则来自本节而非产物）。
- **⚙️16 固定摘要更字**：`CHANNEL_CONFIG_ERROR`（`client.ts:60-61`）改口径为「管理页未配置」——
  逐字见 §2.9；实施时 grep 全仓引用面（测试/文案）逐处适配。
- **⚙️17 审计对象形状**：非密键 = JSON 字符串（`JSON.stringify(value)`）；密键 =
  `{"redacted":true,"fingerprint":"<12hex>"}`。**两列的 null 形态分开钉**：① **首写/无旧行 ⇒ `old_value` 传
  SQL NULL**（绑定 `null`，照「首建 NULL」先例 `platform-config.service.ts:163-169`）；② **清空 ⇒ `new_value` 传
  JSON 字符串 `'null'`**（SQL NULL 会被 `NOT NULL` 以 1048 拒；'null' 串入 json 列实测成功）。实现按本行分开传，
  **不得混用**。
- **⚙️18 503 错误体**：`HttpException({code: ErrCode.UPSTREAM_UNAVAILABLE, message: '渠道密钥存储未启用（缺主钥）', data: null}, 503)`
  （「没开」不当「故障」伪装的反面：这里**确实是故障态**——主钥缺 = 存储不可用，503 语义正确；10007 同码）。

## 1. 改动面一览

### 1.1 新增文件

| 包 | 文件 | 内容 |
|---|---|---|
| protocol | `src/pay-channel.ts` | `PAY_CHANNEL_KEYS`（六字面量数组）· `PayChannelKey` · `PAY_CHANNEL_SECRET_KEYS` · `ConfigPayChannelGetRequest/Response` 类型（纯字符串/类型，无 node 依赖；`index.ts` re-export） |
| config-service | `src/pay-channel/pay-channel.crypto.ts` | 主钥解析（懒）、`encrypt(name, plaintext)`、`decrypt(name, enc)`、`fingerprintOf(canonical)`、`canonicalize` 辅助 |
| config-service | `src/pay-channel/pay-channel.service.ts` | 校验矩阵 · `status()` · `set()` · `clear()` · `pull()`；SQL 常量（`PAY_CHANNEL_LOCK_SQL/UPSERT_SQL/LIST_SQL/DELETE_SQL`，`key` 保留字**反引号**，全文本被单测钉） |
| config-service | `src/pay-channel/pay-channel.validators.ts` | 六键校验/规范化函数（`validateAndNormalize(key, raw): {ok:true,canonical} | {ok:false,reason}`；理由文案**不含输入值**） |
| config-service | `src/pay-channel/pay-channel.controller.ts` | 管理三端点（`@Controller('admin')` + `@UseGuards(XAdminGuard)`，与 `admin.controller.ts` 同族；`requireActor` 复用） |
| config-service | `src/migrations/1792000000000-PayChannelConfig.ts` | §2.2 DDL 逐字 |
| config-service | `test/pay-channel.service.test.ts` · `test/pay-channel.controller.test.ts` · `test/pay-channel.validators.test.ts` · `test/pay-channel.crypto.test.ts`（可并入 service 版）| §5.1 |
| payment-service | `src/config/pay-channel.config.service.ts` | `PayChannelConfigService`（§3.3；挂 `ConfigModule`） |
| payment-service | `test/pay-channel.config.test.ts` | §5.1 |
| conformance | `tools/conformance/src/slices/slice-22-pay-channel.ts` | §5.2 |
| docs | `docs/superpowers/specs/2026-10-06-pay-channel-admin-spec.md` | 本文 |

### 1.2 修改文件（按包）

| 包 | 文件 | 改动 |
|---|---|---|
| protocol | `src/rpc.ts` | `RPC_PATTERNS.configPayChannelGet='config.payChannel.get'`（+注释）；re-export pay-channel 类型；`RpcMeta` 复用 |
| protocol | `src/messages.test.ts` | `RPC_PATTERNS` 全量 toEqual +1 + it 标题（评审 Y3a） |
| config-service | `src/rpc/config.rpc.controller.ts` | 同控制器加第二 `@MessagePattern`：`payChannelGet`（§2.5） |
| config-service | 相应 `*.module.ts`（`config.module.ts` 一族，实施时定位管理控制器注册处） | 注册新 controller/service；RPC 控制器注入新服务 |
| config-service | `test/helpers/config-probe.ts` | 假库 helper 扩 `pay_channel_config` 表（第二副本纪律） |
| config-service | `test/config.rpc.test.ts` | +新 pattern 用例（§5.1） |
| payment-service | `src/config/config.client.ts` | +`payChannel(pullToken)` 方法（1000ms 桥，同款手工桥；`PAY_CHANNEL_CLIENT_TIMEOUT_MS` 导出） |
| payment-service | `src/config/config.module.ts` | provide/export `PayChannelConfigService` |
| payment-service | `src/channel/alipay/client.ts` | `readConfig()` → `readConfig(creds)` 纯函数；`callApi` 首行 `await this.payChannel.get()`；`CHANNEL_CONFIG_ERROR` 文案更字（⚙️16）；注入 `PayChannelConfigService`（**值导入**——DI 陷阱纪律） |
| payment-service | `src/notify/notify.service.ts` | 三处 env 读 → creds 取值（语义逐字保持；warn 文案改口径 §2.9）；注入（值导入） |
| payment-service | `src/orders/orders.service.ts` | `publicBaseUrl()` → async + creds（语义逐字保持） |
| payment-service | `test/notify.test.ts` · `test/sign.test.ts` · `test/orders-state.test.ts` | env 注入点 → mock 通道服务（核销表行；断言语义不动） |
| shared | `src/logging/redact.ts` | `SECRET_KEY_NAME` 加 `privateKey|pullToken`（G1） |
| shared | `test/design-md-ai-rollout.gate.test.ts` | `NEW_ENVS +2` · `RETIRED_ENVS +2`（Y5） |
| api-gateway | `src/auth/admin-policy.ts` | 新条目（置于 P8/P9 前）：P-c1 `PUT /api/admin/pay-channel/*` ⇒ super_admin；P-c2 同型 DELETE ⇒ super_admin。GET 落 P8 |
| api-gateway | `src/gateway/gateway.controller.ts` | 三条转发方法（照 `admin/config` 先例；`:key` 照 R75 `encodeURIComponent`） |
| api-gateway | 网关 policy/转发测试 | 新条目正反用例（含未登记写 fail-closed 不变） |
| admin | `index.html` · `app.js` | §2.8；`CONFIG_NOTES` 搭车补 pay.* 九键（D4） |
| compose | `docker-compose.yml` · `docker-compose.override.yml` | §2.7 |
| ops | `scripts/ops/backup.sh` | ⚙️14 剥离 |
| conformance | `scripts/deploy/conformance-stack.sh` | 六项 export → 栈起后种子（§5.4） |
| conformance | `tools/conformance/src/slices/slice-21-payment.ts` | ⓪ 组断言替换 + ⑬ helper 清理（§5.3） |
| conformance | `tools/conformance/src/slices/slice-07.5-backup.ts` | 判据 d 派生期望 + 负对照改基（§5.3） |
| conformance | `tools/conformance/src/lib/rpc.ts` · `lib/http.ts` | +CONFIG endpoint 常量（2 行）· +`adminPayChannel*` helper 族；头注订正（G9） |
| conformance | `tools/conformance/stub/alipay-stub.mjs` | `/_control/set-app-public`（G5）+ :31-34 注释订正 |
| conformance | `tools/conformance/src/slices/index`（或 run.ts 注册处） | 新片追加末尾（run.ts:56-57 纪律） |
| conformance | `tools/conformance/src/run.ts` | 启动处两行 `??=` 供给新 env（T-1；§5.4） |
| docs | `docs/design.md` · `first-deploy.md` · `alipay-onboarding.md` · `deploy/monitoring/.../ftl-alerts.yml` · `deviation-ledger.md` | §6 |

### 1.3 明确不在改动面（有意）

- `apps/client/**`（客户端零改动；`CLIENT_CONFIG_KEYS` 14 键不动）；`platform_config` 与 34 键全链；
  支付业务九键（26–34）；`PAY_SCAN_INTERVAL_MS`/`PAY_RECONCILE_INTERVAL_MS`（Q1 裁决不搬，env 照旧）；
  主钥轮换机制；客户端构建面。

## 2. 新契约（写死）

### 2.1 protocol：键空间与类型

```ts
// packages/protocol/src/pay-channel.ts（纯常量/类型；不 import node:*）
export const PAY_CHANNEL_KEYS = [
  'pay.channel.gatewayUrl',
  'pay.channel.appId',
  'pay.channel.privateKey',
  'pay.channel.publicKey',
  'pay.channel.sellerId',
  'pay.channel.publicBaseUrl',
] as const;
export type PayChannelKey = (typeof PAY_CHANNEL_KEYS)[number];
export const PAY_CHANNEL_SECRET_KEYS = ['pay.channel.privateKey'] as const satisfies readonly PayChannelKey[];
```

- `rpc.ts`：`RPC_PATTERNS.configPayChannelGet = 'config.payChannel.get'`；
  `interface ConfigPayChannelGetRequest { pullToken: string; meta?: RpcMeta }`；
  `interface ConfigPayChannelGetResponse { values: Partial<Record<PayChannelKey, string>> }`；
  响应类型 = `RpcResult<ConfigPayChannelGetResponse>`（信封照 `config.snapshot` R220）。
- ⚠️ 六键**不入** `CONFIG_KEYS`（D1 结构性；附录 B 12 处硬断言零改动）。

### 2.2 数据表 DDL 逐字（`1792000000000-PayChannelConfig.ts`）

```sql
CREATE TABLE IF NOT EXISTS `pay_channel_config` (
  `key` varchar(64) NOT NULL,
  `value_enc` text NOT NULL,
  `fingerprint` char(12) NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` varchar(64) NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

- `down()`：`DROP TABLE IF EXISTS \`pay_channel_config\``。
- 无种子（出厂 = 未配置；与今天「暗上线无密钥可起」等价）。
- SQL 常量（被单测钉全文；`key` 为 MySQL 保留字 ⇒ **反引号**，同族教训 `admin-changes.service.ts:22-24`）：
  - `PAY_CHANNEL_LOCK_SQL` = `SELECT value_enc, fingerprint FROM pay_channel_config WHERE \`key\`=? FOR UPDATE`
  - `PAY_CHANNEL_UPSERT_SQL` = `INSERT INTO pay_channel_config (\`key\`, value_enc, fingerprint, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), fingerprint=VALUES(fingerprint), updated_by=VALUES(updated_by), updated_at=NOW(3)`
  - `PAY_CHANNEL_LIST_SQL` = `SELECT \`key\`, value_enc, fingerprint, updated_at, updated_by FROM pay_channel_config`
  - `PAY_CHANNEL_DELETE_SQL` = `DELETE FROM pay_channel_config WHERE \`key\`=?`

### 2.3 加密与指纹（逐字口径）

- **主钥**：env `PAY_CONFIG_ENC_KEY` = base64，解码后**必须恰 32 字节**；解码失败/长度非 32 ⇒ 视同未设。
  进程内首次解析成功后缓存（env 进程期不变）。
- **加密**：AES-256-GCM；每值 12B 随机 IV（`randomBytes(12)`）；AAD = UTF-8 键名（如
  `pay.channel.privateKey`）；tag 16B；`value_enc = 'v1:' + base64(iv || ciphertext || tag)`。
- **解密**：严格校验 `v1:` 前缀与长度；任何失败 ⇒ **抛**（响亮；管理 GET 503 / RPC `ok:false`；不静默丢行）。
- **指纹**：`sha256(canonical_plaintext)` hex 小写取前 **12** 位。
- **规范化（canonical）**：
  - 密钥两键：输入 trim；含 `-----BEGIN` ⇒ 视作 PEM 原文；否则按 base64 解码为 PEM；两种路径都要求
    解码/形态后**可被 `crypto.createPrivateKey` / `createPublicKey` 解析**（坏 ⇒ 400）；
    canonical = `base64(trimmedPem + '\n')`（尾换行归一；**读侧 `decodePem` 消费形态不变**——仍是
    base64(PEM)）。
  - `gatewayUrl`/`publicBaseUrl`：trim；`new URL()` 可解析且 protocol ∈ {http:, https:}；canonical =
    去尾斜杠后的原文（baseUrl **必须**去尾斜杠；gatewayUrl 去尾斜杠同规）。
  - `appId`/`sellerId`：trim；canonical = 原文（纯数字）。

### 2.4 HTTP 契约（管理面；信封 `{code, data}` 照既有）

| # | 端点 | 请求 | 200 响应 data | 错误 |
|---|---|---|---|---|
| 1 | `GET /api/admin/pay-channel` | — | `{keys:[<六项，⚙️1 顺序>]}`；项 = `{key,label,secret,configured,value:string\|null,fingerprint:string\|null,updatedAt:number\|null,updatedBy:string\|null}`——**secret 键 `value` 恒 null**；非密键 `value` = 明文；`fingerprint` 仅 configured 时非 null | 503（主钥缺/解密失败） |
| 2 | `PUT /api/admin/pay-channel/:key` | `{value:string}` | `{saved:true, fingerprint, updatedAt}` | 401（`x-admin-actor` 缺失/非法——`requireActor` 先于一切，照 §2.6 序）· 400（未知键 / 空串 / 校验不过，message = 校验理由**不含输入值**）· 503 |
| 3 | `DELETE /api/admin/pay-channel/:key` | — | `{saved:true}`（行不存在也 200——幂等） | 401 · 400（未知键）· 503 |

- `label` 逐字：`渠道网关地址` · `应用 APPID` · `应用私钥` · `支付宝公钥` · `商户 PID` · `对外站点基址`。
- 校验矩阵（⚙️7；`validateAndNormalize`；全部先 trim）：

| 键 | 规则 | 上限 |
|---|---|---|
| `gatewayUrl` | URL(http/https)；去尾斜杠 | ≤512 |
| `appId` | `^[0-9]{8,32}$` | ≤32 |
| `privateKey` | §2.3 密钥规范化 + `createPrivateKey` 解析 | ≤8192（canonical） |
| `publicKey` | §2.3 密钥规范化 + `createPublicKey` 解析 | ≤8192（canonical） |
| `sellerId` | `^[0-9]{8,32}$` | ≤32 |
| `publicBaseUrl` | URL(http/https)；去尾斜杠后非空 | ≤512 |

### 2.5 RPC 契约（`config.payChannel.get`）

- 请求 `{pullToken: string, meta?: RpcMeta}`；响应 `RpcResult<{values: Partial<Record<PayChannelKey,string>>}>`
  ——`values` 仅含**已配置**键；密钥类值为 **base64(PEM)**（= 旧 env 格式，读侧零改）。
- 服务端序：① 校验 `pullToken`（**常数时间**：`timingSafeEqual(sha256(a), sha256(b))`；env 未设 ⇒ 一律拒）
  ② 主钥未设/解密失败 ⇒ `{ok:false, code:10007, message:'渠道密钥存储未启用'}` ③ 成功 `{ok:true, data}`
  ——失败**不抛**（R220：Nest `RpcException` 会丢 5 位码）。
- ⚠️ 消息不得含令牌/值（G2）；每调用 `.send` 带 `metaFromTrace()`（D3/评审 Y3b）。

### 2.6 环境变量两条

| env | 服务 | 空默认透传 | 生产 | 未设（空串）语义 |
|---|---|---|---|---|
| `PAY_CONFIG_ENC_KEY` | config-service | `${VAR:-}`（dev 值由栈脚本/开发者 shell 供给，⚙️13） | 服务器 `.env` 必填（新行） | 渠道块整体 503 / RPC 拒（fail-closed） |
| `PAY_CHANNEL_PULL_TOKEN` | config-service + payment-service | `${VAR:-}`（同上） | 服务器 `.env` 必填（新行，两端同值） | config-service 端未设 ⇒ 拒一切拉取；payment 端未设 ⇒ 拉取被拒 ⇒ 未配置语义 |

- 退役：`ALIPAY_GATEWAY_URL` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` /
  `ALIPAY_SELLER_ID` / `PAY_PUBLIC_BASE_URL`（**六项**，env 面整体退役）。

### 2.7 部署片段（compose 差异）

- `docker-compose.yml` payment 段：**删** :354,:355,:356,:357,:361,:365 六行（含注释 :347-351 改写为
  「渠道凭据已管理化，见 §2.5；本段只留扫描/日自检注入两行」）；**加**
  `- PAY_CHANNEL_PULL_TOKEN=${PAY_CHANNEL_PULL_TOKEN:-}`。
- `docker-compose.yml` config-service 段：**加** `PAY_CONFIG_ENC_KEY=${PAY_CONFIG_ENC_KEY:-}` 与
  `PAY_CHANNEL_PULL_TOKEN=${PAY_CHANNEL_PULL_TOKEN:-}` 两行 + 注释（fail-closed 语义）。
- `docker-compose.override.yml`：**删** :127（`PAY_PUBLIC_BASE_URL=https://localhost:8443`——值改由
  栈脚本种子供给 `https://localhost:${EDGE_HTTPS_PORT}`）；config-service 段加两行**空默认透传**
  （`${PAY_CONFIG_ENC_KEY:-}` / `${PAY_CHANNEL_PULL_TOKEN:-}`，⚙️13）；payment 段加
  `PAY_CHANNEL_PULL_TOKEN=${PAY_CHANNEL_PULL_TOKEN:-}` 空默认透传（与 config-service 同源值）。

### 2.8 管理页「支付渠道」视图（逐字）

- `admin/index.html`：`<nav>` 加 `nav-pay-channel-btn`「支付渠道」（`nav-config-btn` 之后）；新增
  `<section id="pay-channel-view">`（六行：label/状态/值或指纹/输入框/`保存`/`清空`）。
- `admin/app.js`：`VIEWS.payChannel = {el:'#pay-channel-view', nav:'#nav-pay-channel-btn',
  roles:['super_admin','operator','finance']}`；`VIEW_ORDER` 第 2 位；首次激活懒加载
  `GET /api/admin/pay-channel`（照 :704-710 机制）；渲染规则：
  - 非密键：值明文（`<code>`），输入框预填**留空**（不预填值，防误覆盖）；
  - 私钥：显示 `已配置 ✓ · 指纹 <12hex>` 或 `未配置`；输入 `type=password`，placeholder
    `粘贴应用私钥 PEM 全文，或 base64 单行`；
  - **保存/清空按钮仅 `roleOf()==='super_admin'` 时渲染**（后端 policy 才是真门）。
- 交互文案（⚙️12）：保存成功 `已保存；下一次渠道调用即生效`；清空成功 `已清空（未配置时回默认/不可用语义）`；
  400 回显服务端 message；401 ⇒ 顶部「请重新登录」；503 ⇒ `渠道密钥存储未启用（缺主钥）`。
- 稳定选择器（供后续探针；⚠️ 键名含 `.`，**不得**整键拼进 class——用键的末段槽名）：
  `.pay-channel-row-{slot}` · `.pay-channel-save-{slot}` · `.pay-channel-clear-{slot}`，
  `slot ∈ {gatewayUrl, appId, privateKey, publicKey, sellerId, publicBaseUrl}`。

### 2.9 文案逐字（引用处同步）

- `CHANNEL_CONFIG_ERROR`（`client.ts`）新文案：
  `支付渠道配置缺失或非法（管理页 → 支付渠道；密钥形态 = base64(PEM)）`——**不再点名 env**。
- `notify.service.ts` 三处 warn：`ALIPAY_PUBLIC_KEY` → `渠道公钥（管理页 → 支付渠道）`；其余同口径。
- `orders.service.ts:486` warn 同口径更字：`PAY_PUBLIC_BASE_URL 未配置` → `站点基址未配置（管理页 → 支付渠道）`。
- 拉取回落 WARN：`渠道配置拉取失败，使用上次成功值（trace 见 meta）`——**不含值**。
- 服务侧 503 文案与页面文案 = §2.4/§2.8 逐字。

## 3. 服务端行为（逐字）

### 3.1 写路径（`set`）

`requireActor(401)` → `validateAndNormalize`（400，**先于一切库操作**，照 C5 纪律）→ `encrypt`（主钥缺 ⇒ 503）
→ **事务**〔①`PAY_CHANNEL_LOCK_SQL` 锁定读 ⇒ old（无行 ⇒ null）②`PAY_CHANNEL_UPSERT_SQL` ③`CONFIG_CHANGES_INSERT_SQL`
（key=渠道键名；old/new 照 ⚙️17；actor）**同事务**〕→ 返回 `{fingerprint, updatedAt}`。
`clear()`：锁定读 → 无行 ⇒ 直接 200（不落审计）→ 有行 ⇒ 事务〔DELETE + 审计（old 照 ⚙️17，new=JSON null）〕。
**不得复用** `PlatformConfigService.set()`（D4/G3）；**无广播**（不 publish；渠道不走 pub/sub）。
**并发同键写（T-2 实测订正）**：LOCK + ODKU 形态在两并发下**可达 1213 死锁**（评审在 ftl-mysql 两会话
两次复现：一成一败）——v1.1 的「无死锁面」不成立。处置：**有界重试**（照支付片 1213 先例）——写事务捕获
1213 ⇒ 重试 **≤2 次**（20ms 抖动）；仍失败 ⇒ 500 响亮。**捕获边界（U-2 钉死）**：捕获包住**整个
`dataSource.transaction()`（含提交）**——保守边界 = 仅整事务重试（回滚 ⇒ 零副作用；先例 `user-lock.service.ts:25-27`），
**不得**把 catch 放在回调内部。审计语义：重试成功后恰一「old=前值」行；首写并发时
先胜者 old=SQL NULL、后胜者 old=**先胜者值**（重试路径重读）；**不存在「两行同 NULL」**。

### 3.2 读路径

- 管理 `status()`：LIST → 逐行解密（非密给 `value`）→ 按 ⚙️1 顺序组装（缺行 = 未配置项也返回）。
- RPC `pull()`：LIST → 逐行解密 → `Record<PayChannelKey,string>`（缺键不补）。

### 3.3 payment 侧消费（`PayChannelConfigService`）

- `get(): Promise<Partial<Record<PayChannelKey,string>> | null>`：
  1. 现拉：`ConfigClient.payChannel(process.env.PAY_CHANNEL_PULL_TOKEN || '')`（1000ms/不重试/meta）；
  2. 成功 ⇒ **整图替换** `lastGood` ⇒ 返回之；
  3. 失败 ⇒ `lastGood ?? null` + WARN（⚙️9）；`lastGood` 不存在（从未成功）⇒ `null`。
- 消费侧映射（`null`/缺键 ⇒ 与「env 空串」逐字等价）：
  | 读点 | 今天 | 新 |
  |---|---|---|
  | `client.ts readConfig` | `process.env.ALIPAY_GATEWAY_URL \|\| DEFAULT` 等四读 | `creds?.['pay.channel.gatewayUrl'] \|\| DEFAULT` 等四读（其余判断逐字不动） |
  | `notify.service` 公钥 | `decodePem(process.env.ALIPAY_PUBLIC_KEY,'PUBLIC')` | `decodePem(creds?.['pay.channel.publicKey'],'PUBLIC')` |
  | `notify.service` appId | `process.env.ALIPAY_APP_ID \|\| ''` | `creds?.['pay.channel.appId'] \|\| ''` |
  | `notify.service` sellerId | `process.env.ALIPAY_SELLER_ID \|\| ''` | `creds?.['pay.channel.sellerId'] \|\| ''` |
  | `orders.service publicBaseUrl` | `(process.env.PAY_PUBLIC_BASE_URL \|\| '')…` | `(creds?.['pay.channel.publicBaseUrl'] \|\| '')…`（async 化） |

### 3.4 失败语义逐键表（= 设计 D7；冻结）

| 键未配置 | 语义（与今天逐字一致） |
|---|---|
| `gatewayUrl` | 生产默认网关（`ALIPAY_GATEWAY_URL_DEFAULT`） |
| `appId` / `privateKey` / `publicKey` | `readConfig()` null ⇒ **15001**；notify 侧 ⇒ `bad_sign` failure + 响亮日志 |
| `sellerId` | notify seller 校验不过 ⇒ failure 应答（**非** 15001） |
| `publicBaseUrl` | 下单 **15001** |

### 3.5 主钥缺失 fail-closed

config-service：管理三端点 503；RPC `{ok:false,10007}`；**其它面（34 键/客户端/审计）不受影响**（懒校验）。
payment：RPC 失败 ⇒ 回落/未配置（§3.3）——**不阻塞启动**（⚙️3 暗上线口径保持）。
⚠️ **观测序**（S-3 附注）：§3.1 的 400（校验）**先于** 503（主钥）——以 503 为判据的探针，PUT 必须用**合法值**。

## 4. 管理面权限（E′）与网关

- policy 新条目（**插在 P9 前**——即 P-p7（:217）之后；⚠️ 「P8 前、P-p7 后」措辞自相矛盾（P8 在 :192，先于 P-p5..p7），
  S-6 订正为「P9 前」；**不做通配**，同族纪律）：
  - `PUT /api/admin/pay-channel/` 前缀 ⇒ `allows('super_admin')`；
  - `DELETE` 同前缀 ⇒ `allows('super_admin')`；
  - GET ⇒ 落 P8（任意已认证角色）。
- 网关三条转发方法（`admin/config` 先例；paths: `/api/admin/pay-channel`、`.../:key`→`encodeURIComponent`）。
- 变体矩阵（设计 D8 已实测，⑧ 判据逐格）：字面/键段 %2E/%4B/大小写折叠 ⇒ 规则命中（非 SA 403 / SA 200）；
  前缀段 `%2F`/尾斜杠/裸 ⇒ 403（fail-closed）；`//` 前导 ⇒ 401+404；近邻
  `PUT /api/admin/config/pay.channel.*` ⇒ `parseConfigValue` 未知键 400（须覆盖断言）。

## 5. 测试与判据

### 5.1 单测清单

**config-service**（假库 helper 扩表）：
1. `pay-channel.validators.test.ts`：六键矩阵正反（含 PEM↔base64 两态**同指纹**；坏 PEM/空串/超长/坏 URL/非数字 PID ⇒
   400 理由；**理由文本不含输入值**）。
2. `pay-channel.crypto.test.ts`（或并入 service）：加密往返；AAD 绑定（换键名解密必败）；`v1:` 前缀/缺主钥/
   主钥长度错；指纹稳定性。
3. `pay-channel.service.test.ts`：写事务三段序（锁→upsert→审计，同事务）；密键审计 = redacted 对象、非密 = JSON 字符串、
   清空 new=null（JSON 'null'）、无行 clear 不落审计；`status()` 六项顺序/secret value 恒 null；**1213 重试分支**
   （mock 首次抛 1213 ⇒ 重试成功；连抛 3 次 ⇒ 500 响亮）——假库不建模锁，并发语义以**重试注入**验证（T-2）。
4. `pay-channel.controller.test.ts`：三端点契约（401/400/503/200 形状逐字；未知键 400；幂等 DELETE）。
5. `config.rpc.test.ts` +：token 匹配/不匹配（常数时间分支）/缺主钥 ⇒ `ok:false` 10007；成功后 `values` 仅含已配置键。
6. `messages.test.ts`：`RPC_PATTERNS` +1（Y3a）。
7. 迁移测试：新表建表/回滚（照既有 migration 用例形态）。

**payment-service**：
8. `pay-channel.config.test.ts`：成功整图替换（配→删同名键的图 ⇒ 新图替补）；失败回落 lastGood；从未成功 ⇒ null；
   超时 1000ms；`meta` 随 `.send`（mock proxy 断言实参含 meta）。
9. 既有三单测改造（`notify`/`sign`/`orders-state`）：env 注入 → mock 通道服务；**断言语义零改**。

**shared**：10. `redact` 新规则用例（privateKey/pullToken 键名命中）；11. design-md 闸两侧极化。

**api-gateway**：12. policy 新条目正反 + 变体（可用既有 policy 测试形态）；转发路径用例。

**admin 页**：13. 静态串（新 nav/视图 id/按钮字面量）；角色门（非 super_admin 无保存/清空）。

### 5.2 conformance `slice-22-pay-channel`（组；断言数 CI 回填 baseline）

① 未配置 ⇒ 下单 15001；PUT 全六键（种子值）⇒ 下单**200**（stub 全链；⚠️ 不是 201——`@HttpCode(200)` 实证）；
   **同进程「配→成功→删→15001」顺序组**。
② 轮换：stub `/_control/set-app-public?pem=<urlencoded PEM 原文>` 换 B 公钥 ⇒ 现私钥 A 下单**必败**
   （负前置 ⇒ 15001）⇒ PUT 新私钥 B ⇒ 下一单**200 且 stub wapPay 验签通过**（judge = 下单 200 + stub 侧
   验签通过；密钥对 B 由切片内 `node:crypto` 现生成）。
③ 私钥读不回：GET 仅指纹无 value；覆盖后指纹变化；DELETE ⇒ configured:false。
④ 审计：`config_changes` 该键行 old/new **不含**私钥值子串/base64 片段、含 `{"redacted":true,...}` 与 actor；
   非密键行落原文；清空行断言 **`JSON_TYPE(new_value)='NULL'`**（⚠️ 实测：'null' 串入 `json NOT NULL` 列成功、
   `IS NULL` 为 0——写 `IS NULL` 会错红；传 SQL NULL 会被 1048 拒）。
⑤ 不进广播：RPC 探针拉 `config.snapshot` ⇒ 响应串**无** `pay.channel` 子串；payment 容器 `containerEnv` ⇒
   **无 ALIPAY_\***；`/api/config` 仍恰 14 键（既有断言）；**通道专用性负例**：RPC 探针携**错令牌**打
   `config.payChannel.get` ⇒ `ok:false`（正确令牌 ⇒ `ok:true` 正对照）。
⑥ 加密 at-rest：SQL 直查 `pay_channel_config.value_enc` ⇒ 无以 base64 私钥片段、前缀 `v1:`。
⑦ 日志无密钥：跑全链后 `docker logs` payment-service + config-service ⇒ grep base64 私钥子串（**base64 形态**）
   与 pullToken **皆空** + **判别力自证**（合成一行含该子串喂同一 grep ⇒ 必命中）。
⑧ 权限矩阵（E′）+ 变体（**逐格照 §4 变体矩阵**）：operator/finance/viewer × PUT/DELETE（字面与
   %2E/%4B/大小写变体）⇒ 403；super_admin × 字面/键段变体 ⇒ 200；**`%2F` 前缀段形态含 SA 亦 403**；
   GET 任意角色 ⇒ 200；近邻 `PUT /api/admin/config/pay.channel.privateKey` ⇒ 400（非 200/非 500）。
⑨ 主钥 fail-closed（**顺序/冷启/环境供给是关键**，S-1/S-3/T-1/T-5）：① 先取现容器主钥 `pick('PAY_CONFIG_ENC_KEY')` 存变量；
窗口步 env = `{...process.env, PAY_CONFIG_ENC_KEY: ''}`（**注意**：两枚新 env 均参与 compose 插值，runner 进程 env
是插值的第二来源——**令牌必须照常在场**（run.ts `??=` 供给，§5.4），否则窗口步会因「令牌也空」而侥幸同结果、
判据证不到「主钥缺失」这一因）；`docker compose up -d --force-recreate config-service` **并同步**
`docker compose up -d --no-deps --force-recreate payment-service`（**必须冷 payment**——否则回落缓存已暖
（① 的成功下单已把 `lastGood` 整图替换），RPC 失败走回落 ⇒ 下单照常成功，15001 **恒不可达**；
照 slice-14 C16:432-442 先例）+ **两服务等 healthy**（slice-21:324-333 先例，防重建竞态假红）；
② 断言：GET/pay-channel ⇒ 503 · **PUT 用合法值**（如 `gatewayUrl=https://localhost:8443`；⚠️ §3.1 序 400 先于 503，
非法值观测不到 503）⇒ 503 · 下单 ⇒ **15001** · **同时** GET `/api/admin/config` 200 且 34 键在（其它面不受影响）；
③ 恢复步 env = `{...process.env, PAY_CONFIG_ENC_KEY: <①存的钥>}` 重建**两服务** + 等 healthy ⇒ 复绿
（下单成功 = 证明「下次调用即拉回」；恢复步同步重建 payment（又冷）⇒ 无回落可借，必为新鲜拉取）。
⑩ 回落：PUT 配置成功（拉过一次）⇒ `docker compose stop config-service` ⇒ 下单**照常成功** + WARN 出现；
   恢复 config-service。⚠️ 次序：⑩ 放 `restart` 类步骤前，避免污染后续组。
**收尾（钉唯一形态，S-4/T-4）**：PUT 回**六键种子值**（**不得选 DELETE 收尾**——① 的 row1 断言依赖「种子生效
configured」，DELETE 会让下轮 slice-21 ⓪ 必红）+ **stub 公钥恢复 = 唯一路径**：再
`/_control/set-app-public?pem=<A 公钥（读 fixture）>`（「重启 stub」降为兜底——较重）+ 开关归 false。
**组前置/末态**：① 前置 = 栈种子态；① 末态 = 顺序组末 PUT 回六键种子；② 末态 = **应用私钥 A**、stub A、
六键种子（⚠️ 术语：此处「A」是**应用私钥**，非 ENC 主钥）；③④ 前置 = ②末态；⑨ 末态 = ENC 主钥恢复 +
payment 复绿；⑩ 末态 = config-service 恢复；**未列组沿用前组末态**。

### 5.3 既有闸改造（核销表 20 行收编；逐行 = 验收清单）

| # | 面 | 文件:行 | 处置 |
|---|---|---|---|
| 1 | slice-21 ⓪ | `:527-533` | 「env 实读 ALIPAY_*」替换为「env **无** ALIPAY_\*（`containerEnv` 负断言）+ 管理面种子生效（GET 状态 configured）」；`PAY_SCAN_*` 两断言保留；**偏离登记** |
| 2 | slice-21 ⑬ | `:335-366` | `recreatePaymentServiceWithScanInterval` 删 5 个 ALIPAY_* pick（只留 PAY_SCAN/PAY_RECONCILE 透传）；陈旧注释改 |
| 3 | slice-21 种子 | `conformance-stack.sh:46-53` | export 六项删除 ⇒ 见 §5.4 |
| 4 | slice-21 :622 | notify_url 断言 | 值来源改种子（断言串不变） |
| 4b | slice-14 C6/C16 重建点 | `slice-14.ts:83-93,479,491,605` | 重建点位逐处核：run.ts `??=` 供给后**不插空**（T-1；不红即过） |
| 4c | runner 供给链 | `run.ts` 启动处 | 两行 `??=`（§5.4）；`conformance.yml` **不动**（避免副本漂移，T-1） |
| 5 | slice-07.5 判据 d | `:1448-1449`（源 :188） | 期望改 ⚙️15 派生值；播种源加 `PAY_CONFIG_ENC_KEY=probe` 行；**负例**：未剥合成输入 ⇒ 必红 |
| 6 | slice-07.5 负对照 | `:1453-1466` | 第一条改对**派生期望**比对（保留 probeX 自证） |
| 7 | messages.test | `protocol/src/messages.test.ts:53-78` | +1 pattern + 标题 |
| 8 | meta 机械闸 | `room-service/test/meta-on-every-rpc-send.gate.test.ts` | 新 `.send` 必带 metaFromTrace（D3；用例扫面自动覆盖，**确认不红**） |
| 9 | payment 三单测 | `notify.test.ts:116-121` · `sign.test.ts:303-313` · `orders-state.test.ts:486-492,642-666` | mock 通道服务 |
| 10 | design-md 闸 | `design-md-ai-rollout.gate.test.ts:82,122-129` | `NEW_ENVS+2`·`RETIRED_ENVS+2`；§2.3 表同步 |
| 11 | slice-07.2-deploy | 清单类断言 | env 面变更后逐条核（预期：六行删除不触其断言——实施时验证） |
| 12 | slice-19 G12 | served app.js 逐字 | 页面改动随 `build edge` + 镜像（流程既有） |
| 13 | redact.ts | `:85` | +规则（G1） |
| 14 | stub | `alipay-stub.mjs:31-34,61-62,273-333` | +`/_control/set-app-public`（参数形态 **`?pem=<urlencoded PEM 原文>`**；`const appPublicPem`→`let`，改造面 ~15–25 行）；注释订正 |
| 15 | rpc/lib | `lib/rpc.ts` 头注 | 版本注释订正（G9）；+CONFIG endpoint |
| 16 | 34 键面 12 处 | 设计附录 B | **零改动**（验证不红即过） |
| 17 | baselines.json | — | 新片 CI 回填 |
| 18 | `docker-compose.yml` 注释 | :339-351 | 改写（六行删后的口径） |
| 19 | gateway policy 测试 | 既有形态 | 新条目正反 + 未登记 fail-closed 不回退 |
| 20 | `config.rpc.controller` J21 扫描闸 | `robot-availability-wiring.gate.test.ts` | 同控制器加 pattern ⇒ 确认扫描仍绿 |

### 5.4 夹具与栈脚本（种子化）

- `conformance-stack.sh`：
  - **删五条 export（:48-50,:52-53）、保留 :51 `ALIPAY_TEST_FIXTURES`**（种子仍要用；S-7 订正「删六行」）；新增
    `export PAY_CONFIG_ENC_KEY="${PAY_CONFIG_ENC_KEY:-ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=}"` 与
    `export PAY_CHANNEL_PULL_TOKEN="${PAY_CHANNEL_PULL_TOKEN:-dev-pay-channel-pull-token-change-in-production}"`；
  - **runner-side 供给（T-1 中心化）**：`tools/conformance/src/run.ts` 启动处两行：
    `process.env.PAY_CONFIG_ENC_KEY ??= '<⚙️13 dev 常量>'` · `process.env.PAY_CHANNEL_PULL_TOKEN ??= '<⚙️13 dev 值>'`
    ——覆盖**一切经 run.ts 的 `docker compose up` 重建点**（slice-14 C6/C16 :479/:491/:605 · slice-21 ⑬ :347 ·
    slice-22 ⑨ 两处），本机与 CI 同路径；`??=` 尊重显式覆盖（⑨ 的 `''` 空构造不受影响）。
    **单一 runner 供给点**——**不**另开 `conformance.yml` 副本（避免三处同源漂移，R96 教训）；将来若出现
    不经 run.ts 的 compose 调用点，扩此处管辖。
  - `up` 末尾（stub 就绪自证后）：`curl` 管理登录（`ADMIN_PASSWORD`；基址 **`http://localhost:3000`**——override:85
    发布，CI 与本机同）→ PUT 六键（值：gatewayUrl=`http://ftl-alipay-stub:8801` · appId=`9021000000000000` ·
    privateKey=base64(app-private.pem) · publicKey=base64(alipay-public.pem) · sellerId=`2088721087500000` ·
    **publicBaseUrl=`https://localhost:8443` 字面**——slice-21 三处断言是字面 8443（:622/:623/:629），
    动态 `${EDGE_HTTPS_PORT}` 在自定义口下必红，S-2 订正）——失败 ⇒ 响亮 exit 1（照 stub 就绪自证同款纪律）；
    **响应/基址解析用 `node -e`**（jq 不保证存在）。
- `tools/conformance/src/lib/http.ts`：+`adminPayChannelGet/adminPayChannelPut/adminPayChannelDelete`（同族 helper）。
- `lib/rpc.ts`：+`CONFIG_RPC = {host, port:3106}` endpoint 常量（宿主 3106 已发布，override :92-97）。

### 5.5 baseline

- 新片追加 `run.ts` 末尾（纪律：新片不在中段插入）；`baselines.json` 由 CI 运行回填（照近例）。

## 6. 闸与核销（文档面；§5.3 为代码面）

| 文档 | 处置 |
|---|---|
| `docs/design.md` §2.3 :198-199 | 删两行；+`PAY_CONFIG_ENC_KEY`/`PAY_CHANNEL_PULL_TOKEN` 两行（注释指向 §7.5 新小节） |
| §4.2/§4.3 :430/:599 | +pattern；+超时/降级行（1000ms、不重试、降级=整图回落/未配置） |
| §7.5 :1108-1181 | +「渠道凭据第二键空间」小节（表/端点/RPC/加密/权限/审计口径） |
| §7.7 :1217-1250 | +消费面（每调用拉取+回落） |
| §10.3 :1507 | 表清单 +`pay_channel_config`（加密列） |
| `first-deploy.md` :251-262 · :1374-1407 · 「数据没了怎么办」节 | 六项表 → 管理页指引；五步改写（②管理页填沙箱值）；+「密钥轮换」小节（四步 + 临时开关步骤）；恢复节 + 主钥副本与剥离说明 |
| `alipay-onboarding.md` §4/§5 | 列名改「管理页字段」；删 .env/重启语；安全增益入文 |
| `ftl-alerts.yml:196` runbook | 指向改「管理页 → 支付渠道」 |
| `deviation-ledger.md` | +条：env 退役六项 / slice-21 ⓪·⑬ 改造 / slice-07.5 判据 d+负对照改造 / 校验器落点偏离 / 六项统一加密 / 主钥轮换 YAGNI / G1 redact 扩容 |
| `README`/其它 | 实施时按 §5.3 实测面收尾 |

## 7. 上线 / 回滚 / 手册

1. 部署顺序照设计 D10：迁移建表 ⇒ 镜像 ⇒ 未配置=暗态（15001 不阻塞）⇒ 管理页填沙箱六值 ⇒ 沙箱联调
   （**含轮换演练**＝真人验收 Q4）⇒ 管理页换生产值 ⇒ 开开关。
2. **回滚窗**：服务器 `.env` 六行**保留至首轮验收通过后**再删（此前回滚到旧 tag 仍可读 env）。
3. 备份：`backup.sh` ⚙️14 + 恢复手册同步（主钥副本用户自持；丢主钥 ⇒ 六值重填，应用私钥需支付宝后台换钥）。

## 8. 修订记录

- **v1（2026-10-06）**：起草。来源 = 设计 v2.2 冻结 + r1/r2 评审处置全量 + 实读范式（DDL/RPC/管理端点/客户端/页面/stub/栈脚本）。
- **v1.1**（`9b30894`）：规格评审 r1 处置——**S-1 阻断**（⑨ 判据冷启构造）· S-2 种子字面 8443 · S-3 取钥恢复 ·
  S-4 收尾唯一化 · S-5 下单 200 · S-6..S-13 · 歧义 9 条定死。
- **v1.2**（`a82ce1f`）：规格评审 r2 处置——**T-1 阻断**（runner 供给链：run.ts `??=` 中心化）· **T-2**
  （并发登记被真 MySQL 实证否证 ⇒ 有界 1213 重试）· T-3/T-4/T-5。
- **v1.3**（本提交）：规格评审 r3 处置（U-1 序号打磨 · U-2 捕获边界钉死）；**冻结**。

## 9. 规格冻结声明

- r3 评审结论「**可通过（规格冻结）**」：T-1 修法经**全仓 21 处 compose-up 穷举**实证盖全（含 release.yml
  复用同一 workflow 的核查、`??=` × ⑨ 显式覆盖交互、slice-07.2 isolatedEnv 边界）；T-2 重试语义与
  `user-lock.service.ts:25-27` 先例逐字等价、「不存在两行同 NULL」在新路径下成立。
- 自此：**实施不得偏离本文**；实现期发现的任何必要偏离 ⇒ 台账登记 + 规格修订（走一轮微审）。
