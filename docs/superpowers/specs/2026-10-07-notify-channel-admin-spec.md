# 通知通道管理化（SMTP/IM 凭据进管理面）**规格层 v1（起草 · 待评审）**

> **上游**：设计 **v1.3 冻结**（`f695da2`；`docs/superpowers/specs/2026-10-07-notify-channel-admin-design.md`）
> + 设计评审 r1/r2 报告（`.superpowers/sdd/2026-10-07-notify-channel/`）。
> **规格状态**：**v1.4 冻结**（2026-10-07）——r3 全收口后按 §9 偏离路径做**一次微审修订**：
> §3.8 两规则的注记键 `description:` → **`runbook:`**（勘误：`ftl-alerts.yml` 全 23 条既有规则一律用
> `runbook:` 承载处置指引，ops 面按该约定消费；判据面无依赖——⑩ 只断言 alertname/state，slice-16
> 只计规则名；T11 勘误提交同源）。实施不得偏离本文；必要偏离 ⇒ 台账登记 + 规格修订（微审）。
> **本文职责**：把设计层 D1–D10 冻成**逐字契约**（键名/DDL/端点/RPC/校验/文案/渲染规则/状态机/判据）；
> 实施期不得偏离，任何偏离入 `.superpowers/sdd/2026-10-07-notify-channel/` 台账 + `deviation-ledger.md`。

## 0. 承接与订正

### 0.1 上游与版本

| 上游 | 版本 | 承接方式 |
|---|---|---|
| 开工交接 | `plans/2026-10-06-post-pay-channel-handoff.md` §8 | 第一梯队九键逐条落实（设计 §1.1-A） |
| 设计 | **v1.3 冻结**（`f695da2`） | D1–D10 逐条 → §2/§3 逐字；设计「规格定」留白 → §0.3 ⚙️ 裁定 |
| 本日探针 | 设计 §2.5（七项，已还原） | §3.4/§3.5 的机制依据（reload 语义/api·v2·status/amtool 可移植） |

### 0.2 D→本文落点对位

| 设计 | 本文落点 |
|---|---|
| D1 键空间/命名/密类/hint/D1 纪律 | §2.1 · §2.2 · §2.4 |
| D2 加密（复用设施 + 主钥 Q2-A） | §2.3 |
| D3 拉取通道/令牌/轮询/裁剪/持久化 | §2.5 · §2.6 · §3.3 |
| D4 relay 改造 | §3.3 · §3.6 |
| D4′ renderer + AM entrypoint + 共享卷 | §2.7 · §3.4 · §3.5 · §2.10 |
| D5 管理面/校验/页面 | §2.4 · §2.8 · §2.9 · §4 |
| D6 审计脱敏 | §3.1 |
| D7 等价表/gauge/规则 | §3.7 · §3.8 |
| D8 生命周期/导入/回滚窗 | §7 |
| D9 判据 | §5 |
| D10 部署 | §7 |

### 0.3 ⚙️ 规格级裁定（起草期就地定死；来源 = 设计留白 + 起飞实读）

- **⚙️1 键名逐字（九键，顺序即 UI 显示序与拉取地图组装序）**：
  `notify.smtp.host` · `notify.smtp.port` · `notify.smtp.user` · `notify.smtp.pass` ·
  `notify.email.to` · `notify.webhook.feishuUrl` · `notify.webhook.wecomUrl` ·
  `notify.webhook.dingtalkUrl` · `notify.webhook.dingtalkSecret`。
  机密集 = `{notify.smtp.pass, notify.webhook.feishuUrl, notify.webhook.wecomUrl,
  notify.webhook.dingtalkUrl, notify.webhook.dingtalkSecret}`（**按消费方切分**：
  「邮件组」= 前 5 键（renderer）·「IM 组」= 后 4 键（relay）——两处消费面**不相交**，
  裁剪/完整性口径均以此为准）。
- **⚙️2 表名/迁移号**：`notify_channel_config`；迁移 `1793000000000-NotifyChannelConfig.ts`
  （类名 `NotifyChannelConfig1793000000000`；`IF NOT EXISTS` 照先例；`key` 保留字反引号）。
- **⚙️3 端点逐字**：`GET /api/admin/notify-channel` · `PUT /api/admin/notify-channel/:key` ·
  `DELETE /api/admin/notify-channel/:key`（§2.4）。
- **⚙️4 RPC 逐字**：`config.notifyChannel.get`（`RPC_PATTERNS.configNotifyChannelGet`；§2.5）。
- **⚙️5 env 一条**：`NOTIFY_CHANNEL_PULL_TOKEN`（**三持有**：config-service + alert-relay +
  am-renderer；「空串 = 未设」`||` 不用 `??`）。主钥 = **复用 `PAY_CONFIG_ENC_KEY`**（已裁 Q2-A；
  无新主钥 env）。
- **⚙️6 加密设施泛化形态（逐字）**：新文件
  `config-service/src/sensitive-config/crypto-core.ts` —— **纯原语、零 env 访问**：
  `parseKey(raw: string|undefined): Buffer|null`（base64 恰 32B，否则 null）·
  `encryptWithKey(key, name, plaintext)` · `decryptWithKey(key, name, enc)` · `fingerprintOf(canonical)`
  ——算法/格式/AAD/前缀/指纹逐字 = 现 `pay-channel.crypto.ts`（AES-256-GCM · 12B IV · AAD=UTF-8 键名 ·
  `v1:` + base64(iv‖ct‖tag) · sha256[12]）。**pay 侧** `pay-channel.crypto.ts` 改为薄绑定
  （进程内缓存 + `process.env.PAY_CONFIG_ENC_KEY` + **现有文案逐字保留**），**导出面与行为零变化**；
  **notify 侧** `notify-channel.crypto.ts` 同构薄绑定，文案见 §2.9。偏离登记（pay 片 G 级：文件搬迁）。
- **⚙️7 校验矩阵**：§2.4 表（逐键规则 + 上限 + reason 文案逐字，**不含输入值**）。
- **⚙️8 拉取口径**：轮询 **30 000ms**（常量 `NOTIFY_PULL_INTERVAL_MS = 30_000`，不做 env 旋钮）；
  启动**立即**先拉一次；单次超时 **3000ms**；**不重试**（下一轮即重试）；**不携带 meta**
  （relay/renderer 非 Nest 服务、无 trace 基建——偏离登记；meta 机械闸扫描面不含 alert-relay）。
  线格式 = 复刻 Nest `JsonSocket`（`<len>#<json>`，`{pattern, data, id}`；回包 `{id, response}`；
  每次调用一条新连接）——**实现照抄** `tools/conformance/src/lib/rpc.ts:131-241` 的解析纪律
  （按字符计长、`#` 分帧、`id` 回验、`response` 必须是 `RpcResult` 信封）。
- **⚙️9 回落/裁剪/持久化**：成功 = **整图替换**（`{}` 亦为有效图）；relay **拉后即裁**（只保留
  四 IM 键，SMTP 五键进程内即弃）；持久化文件 `/data/notify-config.json`（**只含裁剪后四键的
  JSON 对象**，600，原子写 tmp+rename）；读失败（不存在/损坏）⇒ 不存在静默、损坏 WARN，**均按
  `null`（从未成功）**处理。
- **⚙️10 权限**：写面（PUT/DELETE）**仅 `super_admin`**；读面（GET）任意已认证角色（落 P8）。
- **⚙️11 页面**：视图 key `'notifyChannel'`；`VIEWS` roles `['super_admin','operator','finance']`
  （读面照 pay 先例有意扩 finance）；`VIEW_ORDER` 第 3 位（`config`、`payChannel` 之后）；
  保存/清空控件仅 `super_admin` 渲染；needle：`notify-channel-view` / `nav-notify-channel-btn` /
  「通知通道」。
- **⚙️12 文案**：§2.9 逐字（服务端错误、页面、WARN、AM/RPC 消息）。
- **⚙️13 dev 常量与供给点（仓库内；override/compose 一律空默认透传 `${VAR:-}`）**：
  `NOTIFY_CHANNEL_PULL_TOKEN` dev 值 = `dev-notify-channel-pull-token-change-in-production`；
  供给点 = `conformance-stack.sh` export + `run.ts` 启动处 `??=`（照 ⚙️先例；`??=` 尊重显式覆盖）。
  主钥 dev 值 = 复用既有 `PAY_CONFIG_ENC_KEY` 供给链（**零新增**）。
- **⚙️14 renderer 逐字**（状态机/渲染规则/常量）：§3.4。
- **⚙️15 AM entrypoint 逐字**：§3.5（有界等待 90s / token 落盘 600 / amtool 预检 / exec **两 flag**——`--config.file` + `--storage.path`，**不转发 `$@`**；v1.8 措辞勘误：原「三 flag」系陈旧表述，以 §3.5 代码块逐字为准）。
- **⚙️16 sink 派生与状态日志**：§3.6（顺序 feishu→dingtalk→wecom；状态**变化时**各打一条，不刷屏）。
- **⚙️17 完整性 gauge**：`notify_config_keys_configured{group}`（group ∈ {email(5),dingtalk(2)}）与
  `notify_config_group_complete{group}`（1/0）；**写路径现算**（`set()`/`clear()` 事务成功后 +
  config-service 启动时各一次，`SELECT \`key\` FROM notify_channel_config` 只数行**不解密**；
  读失败 ⇒ 保持旧值 + WARN，**不打穿 /metrics**）；共享 `createGauge`（`registry.ts:58`）。
- **⚙️18 告警规则两条逐字**：§3.8。
- **⚙️19 relay no-op/500 语义**：§3.3（`lastGood===null` ⇒ 500；成功空图/裁剪后无槽 ⇒ 200 no-op）。
- **⚙️20 compose/Dockerfile 逐字差异**：§2.10。
- **⚙️21 栈脚本与 helpers**：§5.4。
- **⚙️22 slice-16 改造的就绪语义**：每实例内联 **stub 拉取源**（node net server 回 JsonSocket 帧；
  **同开 HTTP 控制面 `/_pulls`** 供回读计数——照 C5 `docker exec wget` 读法，评审 S-Y5）；
  `startRelay` 就绪 = `/health` 200 **且** `/_pulls` ≥1 **且** 200ms 沉降（待「首轮槽位应用」完成后再断言）；
  **半配断言不在 slice-16**（真身在 alert-relay 单测，见 §5.3#2）。

## 1. 改动面一览

### 1.1 新增文件

| 包 | 文件 | 内容 |
|---|---|---|
| protocol | `src/notify-channel.ts` | `NOTIFY_CHANNEL_KEYS`（九字面量）· `NotifyChannelKey` · `NOTIFY_CHANNEL_SECRET_KEYS`（五）· `ConfigNotifyChannelGetRequest/Response`（纯常量/类型；`index.ts` re-export） |
| config-service | `src/sensitive-config/crypto-core.ts` | ⚙️6 纯原语 |
| config-service | `src/notify-channel/notify-channel.crypto.ts` | 薄绑定（`PAY_CONFIG_ENC_KEY` 缓存 + notify 文案） |
| config-service | `src/notify-channel/notify-channel.service.ts` | 校验矩阵 · `status()` · `set()` · `clear()` · `pull()`；SQL 常量（`NOTIFY_CHANNEL_LOCK/UPSERT/LIST/DELETE_SQL`，仅表名不同） |
| config-service | `src/notify-channel/notify-channel.validators.ts` | 九键校验/规范化 + hint 原语（`urlHint(value)`） |
| config-service | `src/notify-channel/notify-channel.controller.ts` | 管理三端点（同 pay 族：`@Controller('admin')` + `XAdminGuard` + `requireActor`） |
| config-service | `src/notify-channel/notify-channel.metrics.ts` | ⚙️17 gauges（含 `refreshNotifyGauges()` 写路径入口） |
| config-service | `src/migrations/1793000000000-NotifyChannelConfig.ts` | §2.2 DDL |
| config-service | `test/notify-channel.*.test.ts`（validators/service/controller/crypto/metrics） | §5.1 |
| alert-relay | `src/notify-config.ts` | 拉取客户端（⚙️8 线格式）+ 裁剪 + last-good 持久化（⚙️9）——relay 与 renderer 共用 |
| alert-relay | `src/am-renderer.ts` | renderer 入口（§3.4；argv 守卫照 `server.ts:242-243` 形态） |
| alert-relay | `test/notify-config.test.ts` · `test/am-renderer.test.ts` · `test/sinks-from-values.test.ts` | §5.1 |
| conformance | `tools/conformance/src/slices/slice-23-notify-channel.ts` | §5.2 |
| docs | `docs/superpowers/specs/2026-10-07-notify-channel-admin-spec.md` | 本文 |
| docs | `docs/ops/notify-onboarding.md` | §6（平台取址 + 安全增益 + 轮换 + 验收；照 alipay-onboarding 形态） |

### 1.2 修改文件（按包）

| 包 | 文件 | 改动 |
|---|---|---|
| protocol | `src/rpc.ts` | `RPC_PATTERNS.configNotifyChannelGet='config.notifyChannel.get'`（+注释） |
| protocol | `src/messages.test.ts` | `RPC_PATTERNS` 全量 toEqual +1 + it 标题 |
| protocol | `src/index.ts` | re-export `notify-channel` |
| config-service | `src/pay-channel/pay-channel.crypto.ts` | 改薄绑定（⚙️6；**导出/行为/文案零变化**） |
| config-service | `src/rpc/config.rpc.controller.ts` | +第三 `@MessagePattern`：`notifyChannelGet`（§2.5） |
| config-service | 相应 `*.module.ts` | 注册新 controller/service/metrics 刷新点 |
| config-service | `src/notify-channel/notify-channel.service.ts` | 刷新点 = **`set()`/`clear()` 事务成功后**调用 `refreshNotifyGauges()`（不挂 controller） |
| config-service | `test/helpers/config-probe.ts` | 假库 helper 扩 `notify_channel_config` 表（第二副本纪律） |
| config-service | `test/config.rpc.test.ts` · `test/migration.test.ts` | +用例（§5.1/迁移号唯一性） |
| shared | `src/logging/redact.ts` | `SECRET_KEY_NAME` 定形新支（**枚举式**）：`/(^|[._])notify\.(smtp\.pass|webhook\.(feishuUrl|wecomUrl|dingtalkUrl|dingtalkSecret))$/`——不得命中 `REDIS_URL`/`DOUZERO_URL`/裸 `url`/`notify.smtp.host`；单测正反（§5.1#13） |
| shared | `test/design-md-ai-rollout.gate.test.ts` | `NEW_ENVS += NOTIFY_CHANNEL_PULL_TOKEN` · `RETIRED_ENVS += 九键`（防回流） |
| alert-relay | `src/config.ts` | env 装配退役：删四 IM 键与半配拒起（`RelayConfigError` 保留给 PORT）；新增 `sinksFromValues(values)` 派生 + 半配判定（纯函数） |
| alert-relay | `src/server.ts` | sink 装配改「当前槽位闭包（轮询热更新）」；`/webhook` 增 `lastGood===null ⇒ 500` 分支；启动衔接 `notify-config`（先读持久化 + 立即拉取 + 30s 轮询） |
| alert-relay | `src/metrics.ts` | 如需「拉取状态」指标——**不做**（gauge 面在 config-service，⚙️17；relay 指标面不动） |
| alert-relay | `test/config.test.ts` · `test/server.test.ts` · `test/helpers.ts` | 三态拒起 → 派生/半配改写；env 注入 → 注入值/拉取源（§5.3） |
| alert-relay | `Dockerfile.alert-relay` | **多阶段** `FROM prom/alertmanager:v0.34.1 AS alertmanager-bin` + `COPY --from=alertmanager-bin /bin/amtool /bin/amtool`（renderer 预检用；评审 S-Y3）+ `RUN mkdir -p /data && chown node:node /data` + `mkdir -p /alertmanager-live && chown 65534:65534`（两目录；见 §2.10 权限链） |
| alert-relay | `package.json` · 根 `pnpm-lock.yaml` | **+`"@fight-the-landlord/protocol": "workspace:*"`**（拉取客户端导入 `RPC_PATTERNS`/`NOTIFY_CHANNEL_KEYS`——**不以字面量硬编码**，反「pattern 字面量漂移」禁忌，评审 S-Y4）；lock 更新（根文件，协调者独占） |
| compose | `docker-compose.yml` · `docker-compose.override.yml` | §2.10 |
| API 网关 | `src/auth/admin-policy.ts` · `src/gateway/gateway.controller.ts` | P-n1/P-n2（置于 P9 前）+ 三条转发方法（R75 `encodeURIComponent`） |
| admin | `index.html` · `app.js` | §2.8（+「十视图」注释 ×4 随动） |
| prometheus | `deploy/monitoring/prometheus/rules/ftl-alerts.yml` | +2 规则（§3.8） |
| ops | `Dockerfile.alertmanager` | 预建 `/alertmanager-live` 属主 65534（§2.10） |
| ops | `deploy/monitoring/alertmanager/entrypoint.sh` · `alertmanager.yml.tmpl` | §3.5 重写（tmpl 文件**删除**——静态段迁 renderer TS） |
| conformance | `scripts/deploy/conformance-stack.sh` | export 新 env（⚙️13）+ down-rm 名单 +1（`am-renderer`）；**无通知种子** |
| conformance | `tools/conformance/src/run.ts` | `??=` 供给新 env（⚙️13/§5.4） |
| conformance | `tools/conformance/src/slices/slice-16-monitoring.ts` | §5.3#3/#4（注入机制/就绪/规则数三处） |
| conformance | `tools/conformance/src/lib/http.ts` | +`adminNotifyChannel{Get,Put,Delete}` helper 族 |
| conformance | `tools/conformance/src/slices/slice-07.2-deploy.ts` | `LOG_LIMIT_TARGETS+1`；env 面逐条核（§5.3#5） |
| conformance | `tools/conformance/src/slices/slice-19-admin-rbac-audit.ts` | G12 +3 needle（§5.3#9） |
| conformance | `baselines.json` / `run.ts` CASES | slice-23 注册（§5.5） |
| docs | `docs/design.md` · `docs/ops/first-deploy.md` · `deviation-ledger.md` · `.gitleaks.toml` | §6 |

### 1.3 明确不在改动面（有意）

- `platform_config` 与 34 键全链、客户端 14 键、`apps/client/**`；`GRAFANA_ADMIN_PASSWORD` 与
  节奏旋钮族（第二/三梯队，不搬）；AM 的邮件模板/路由结构/聚合参数（零改动）；
  `INTERNAL_SERVICE_TOKEN` 面（AM webhook Bearer / relay 守卫，照旧）；relay 指标面（`alert_deliveries_total` 等）。

## 2. 新契约（写死）

### 2.1 protocol：键空间与类型

```ts
// packages/protocol/src/notify-channel.ts（纯常量/类型；不 import node:*）
export const NOTIFY_CHANNEL_KEYS = [
  'notify.smtp.host', 'notify.smtp.port', 'notify.smtp.user', 'notify.smtp.pass',
  'notify.email.to',
  'notify.webhook.feishuUrl', 'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl', 'notify.webhook.dingtalkSecret',
] as const;
export type NotifyChannelKey = (typeof NOTIFY_CHANNEL_KEYS)[number];
export const NOTIFY_CHANNEL_SECRET_KEYS = [
  'notify.smtp.pass', 'notify.webhook.feishuUrl', 'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl', 'notify.webhook.dingtalkSecret',
] as const satisfies readonly NotifyChannelKey[];

export interface ConfigNotifyChannelGetRequest { pullToken: string; meta?: RpcMeta }
export interface ConfigNotifyChannelGetResponse { values: Partial<Record<NotifyChannelKey, string>> }
```

- ⚠️ 九键**不入** `CONFIG_KEYS`（结构性；34 键面 12 处硬断言零改动）。
- `rpc.ts`：`configNotifyChannelGet: 'config.notifyChannel.get'`（末位追加；messages.test 全量 ±1）。

### 2.2 数据表 DDL 逐字（`1793000000000-NotifyChannelConfig.ts`）

```sql
CREATE TABLE IF NOT EXISTS `notify_channel_config` (
  `key` varchar(64) NOT NULL,
  `value_enc` text NOT NULL,
  `fingerprint` char(12) NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` varchar(64) NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

- `down()`：`DROP TABLE IF EXISTS \`notify_channel_config\``；**无种子**。
- SQL 常量（被单测钉全文）：`NOTIFY_CHANNEL_LOCK_SQL` / `NOTIFY_CHANNEL_UPSERT_SQL` /
  `NOTIFY_CHANNEL_LIST_SQL` / `NOTIFY_CHANNEL_DELETE_SQL` —— 与 pay 四常量**逐字同构，仅表名替换**；
  审计 insert 复用 `CONFIG_CHANGES_INSERT_SQL`（`admin-changes.service.ts:33-34`）。

### 2.3 加密与指纹（逐字；= 支付片 §2.3 同设施）

- 主钥 `PAY_CONFIG_ENC_KEY`（**已裁复用**）：base64 恰 32B；失败/长度非 32 ⇒ 视同未设；
  进程内首次解析成功后缓存（pay 与 notify 两个薄绑定**各自缓存同一把钥**——同 env 同值，无行为差）。
- AES-256-GCM · 12B IV · AAD=UTF-8 键名 · tag 16B · `v1:base64(iv‖ct‖tag)` ·
  指纹 `sha256(canonical)[:12]`；解密任一失败 ⇒ **抛**（响亮；不静默丢行）。
- **规范化（canonical）**：全键先 `trim()`；**唯一变换 = trim**（URL **不改写**——凭据 URL 逐字保真）。

### 2.4 HTTP 契约（管理面；信封 `{code,data}` 照既有）

| # | 端点 | 请求 | 200 响应 data | 错误 |
|---|---|---|---|---|
| 1 | `GET /api/admin/notify-channel` | — | `{keys:[<九项，⚙️1 顺序>]}`；项 = `{key,label,secret,configured,value:string\|null,fingerprint:string\|null,hint:string\|null,updatedAt:number\|null,updatedBy:string\|null}`——**secret 键 `value` 恒 null**；**URL 三键 `hint`** = 规则见下；非密键 `value` 明文、`hint` 恒 null | 503（主钥缺/解密失败） |
| 2 | `PUT /api/admin/notify-channel/:key` | `{value:string}` | `{saved:true, fingerprint, updatedAt}` | 401（actor 缺失/非法，先于一切）· 400（未知键/空串/校验不过，message=reason 不含值）· 503 |
| 3 | `DELETE /api/admin/notify-channel/:key` | — | `{saved:true}`（行不存在也 200） | 401 · 400（未知键）· 503 |

- **`label` 逐字**（⚙️1 序）：`邮件服务器` · `邮件端口` · `邮件账号` · `邮件授权码` · `告警收件地址` ·
  `飞书机器人地址` · `企业微信机器人地址` · `钉钉机器人地址` · `钉钉加签密钥`。
- **`hint` 规则逐字**（仅三 URL 键；读路径解密后现算，非存储列）：`h = new URL(value).host`；
  **全等**匹配（WHATWG 已小写归一）`{qyapi.weixin.qq.com, open.feishu.cn, oapi.dingtalk.com}`
  之一 ⇒ `hint = new URL(value).origin`；否则 `hint = '外部地址'`。其余六键 `hint` 恒 null。
- **校验矩阵**（⚙️7；`validateAndNormalize(key, raw): {ok:true,canonical}|{ok:false,reason}`；
  全键先 trim；reason 为常量、**不含输入值**）：

| 键 | 规则 | 上限 | reason（逐字） |
|---|---|---|---|
| `smtp.host` | 非空；`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$`（**微审 v1.7**：拒 `...`/`..`/首尾点/首尾横线/纯符号；≥1 字母数字——W3 深扫实证旧式 `^[A-Za-z0-9.-]+$` 放行 `...` ⇒ 邮件静默死且完整性规则不响） | ≤253 | `必须是合法主机名（字母/数字/点/横线）` · `长度超过上限 253` · `值不得为空` |
| `smtp.port` | `^\d{1,5}$` 且 1–65535；canonical=trim 原文 | ≤5 | `必须是 1-65535 的端口号` |
| `smtp.user` | 非空；无空白（`\s`） | ≤254 | `不得包含空白字符` · `长度超过上限 254` |
| `smtp.pass` | 非空；**无 `\u0000-\u001f`/`\u007f` 控制字符** | ≤512 | `授权码不得包含换行或控制字符` · `长度超过上限 512` |
| `email.to` | 逗号分隔逐项：非空 + `^[^\s@,]+@[^\s@,]+$`；canonical=逐项 trim 后 `,` 连接 | 项 ≤254 | `收件地址格式不合法（单个或逗号分隔列表）` · `长度超过上限 254` |
| 三 URL | `new URL()` 可解析 + `http:`/`https:`；canonical=trim 原文（不改写） | ≤2048 | `必须是 http/https 协议的合法 URL` · `长度超过上限 2048` |
| `dingtalkSecret` | 非空；无空白 | ≤256 | `不得包含空白字符` · `长度超过上限 256` |

### 2.5 RPC 契约（`config.notifyChannel.get`）

- 请求 `{pullToken: string, meta?: RpcMeta}`；响应 `RpcResult<ConfigNotifyChannelGetResponse>`——
  `values` 仅含**已配置**键；值 = 存储 canonical（URL 逐字）。
- 服务端序（照 pay 逐字）：① 常数时间令牌比对（`timingSafeEqual(sha256(a),sha256(b))`；env 未设 ⇒
  一律拒）⇒ 不匹配 `{ok:false, code:10002, message:'拉取令牌不匹配'}`；② 主钥未设/解密失败 ⇒
  `{ok:false, code:10007, message:'通知通道密钥存储未启用'}`；③ 成功 `{ok:true,data}`；失败**不抛**（R220）。
- ⚠️ 消息不含令牌/值；消费端**不带 meta**（⚙️8；登记）。

### 2.6 环境变量一条

| env | 服务 | 空默认透传 | 生产 | 未设（空串）语义 |
|---|---|---|---|---|
| `NOTIFY_CHANNEL_PULL_TOKEN` | config-service + alert-relay + am-renderer | `${VAR:-}`（dev 值由栈脚本/`??=` 供给，⚙️13） | 服务器 `.env` 必填（新行，三端同值） | config-service 端未设 ⇒ 拒一切拉取；消费端未设 ⇒ 拉取被拒 ⇒ last-good/从未拉到语义 |

- 两消费端另取**拓扑类** env（compose 字面量，非凭据）：`CONFIG_SERVICE_RPC_HOST=config-service` ·
  `CONFIG_SERVICE_RPC_PORT=3106`。
- 退役（env 面整体）：`SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` · `ALERT_EMAIL_TO` ·
  `FEISHU_WEBHOOK_URL` · `DINGTALK_WEBHOOK_URL` · `DINGTALK_SECRET` · `WECOM_WEBHOOK_URL`（**九项**）。

### 2.7 共享卷

- 新命名卷 **`alertmanager-live`**：renderer 挂 `/alertmanager-live`（rw）；alertmanager 挂
  **`/alertmanager-live:ro`**（结构性只读）。生成物 `/alertmanager-live/alertmanager.yml`（600）。
- 新命名卷 **`relay-data`**：relay 挂 `/data`（rw；`notify-config.json` 600）。

### 2.8 管理页「通知通道」视图（逐字）

- `admin/index.html`：`<nav>` 加 `nav-notify-channel-btn`「通知通道」（`nav-pay-channel-btn` 之后）；
  新增 `<section id="notify-channel-view">`（分两组：`邮件（SMTP）` 5 行 + `IM 通道` 4 行；
  骨架不含键值，懒加载回填）。
- `admin/app.js`：`VIEWS.notifyChannel = {el:'#notify-channel-view', nav:'#nav-notify-channel-btn',
  roles:['super_admin','operator','finance']}`；`VIEW_ORDER` 第 3 位；首次激活懒加载
  `GET /api/admin/notify-channel`；渲染规则：
  - 非密键：值明文（`<code>`）；输入框**留空**（不预填，防误覆盖）；
  - 密键：显示 `已配置 ✓ · 指纹 <12hex>` 或 `未配置`；URL 三键附 `hint`（`外部地址` 照显）；
    `smtp.pass` 输入 `type=password` + `-webkit-text-security:disc`（照私钥先例）；
  - **保存/清空按钮仅 `roleOf()==='super_admin'` 时渲染**（后端 policy 才是真门）；
  - 组尾**客户端算**完整性提示（**逐字**）：邮件组五键全齐 ⇒ `邮件通道：已就绪`，否则
    `邮件通道：未就绪（缺 N 项）`；钉钉两键全齐 ⇒ `钉钉通道：已就绪`，否则
    `钉钉通道：未就绪（缺 N 项）`（**微审 v1.7**：N 按缺项数**现算**——与邮件组同口径；
    v1.3 冻结的固定「缺 1 项」在双缺（全新安装）时误导操作者只补一键，W3 深扫实证；
    design D5「2/2 同理」的现算意图由此正名，M2 消解）。
- 交互文案：保存成功 `已保存；30 秒内生效`；清空成功 `已清空（未配置时该通道关闭）`；
  400 回显服务端 message；401 ⇒ 「请重新登录」；**503 ⇒ 显示服务端 message**（与 400 同口径；
  无 message 时回落 `通知通道密钥存储未启用（缺主钥）`）——**微审 v1.5**：服务端本就区分「缺主钥」与
  「密文解密失败（主钥不符或数据损坏）」两种 503 文案（§2.9），页面固定字面会误导排障。
- 稳定选择器（槽名 = 键末段的 kebab？**照 pay 先例用键末段原样**）：
  `.notify-channel-row-{slot}` · `.notify-channel-save-{slot}` · `.notify-channel-clear-{slot}`，
  `slot ∈ {host,port,user,pass,to,feishuUrl,wecomUrl,dingtalkUrl,dingtalkSecret}`。
- 「十视图」注释 ×4（`app.js:351,731,788,3048`）改「十一视图」。

### 2.9 文案逐字（引用处同步）

- config-service 503 message：`通知通道密钥存储未启用（缺主钥）`（照支付规格 ⚙️18 先例；crypto 内层文案：
  `通知配置密文格式非法（v1）` · `通知配置密文解密失败（主钥不符或数据损坏）`）。
- RPC 失败：`拉取令牌不匹配`（10002）· `通知通道密钥存储未启用`（10007，**无**「（缺主钥）」后缀——两处钉子分开）。
- relay 日志（只允许键名/状态/错误类别，**不含值**）：启动 `[alert-relay] listening on :8090; sinks: <名集|无>`；
  半配 WARN 逐字：`钉钉 URL 与加签密钥须成对（当前半配）——该槽位已停用`（状态变化时一条）；
  拉取失败 WARN：`通知配置拉取失败，使用上次成功值`（状态变化时一条）；
  **实现增补的无值 WARN 属允许面**（持久化写失败/读损坏/不可读、轮询内部错误——皆只许键名/状态/错误类别，微审 v1.6）。
- renderer 日志（只允许键名/状态/错误类别）：启动 `[am-renderer] 启动；配置=<baseline|既有>`；
  变更成功 `[am-renderer] 配置已更新并重载`；拉取失败 WARN `通知配置拉取失败，本轮不更新`（状态变化时一条）；
  **邮件组半配 WARN（1–4 项在场）**：`通知邮件配置不完整（已配 N/5），邮件段已省略`（状态变化时一条）；
  amtool 预检失败 ERROR `渲染产物未通过 amtool 预检，不落盘`；reload 失败 ERROR
  `重载失败（AM 未就绪或拒绝），将在下轮重试`；**兜底 ERROR `[am-renderer] 内部错误（本轮保持现状）`**
  （无值、状态变化一条——v1.8 并入允许面；T13 实装 `am-renderer.ts` 末段）。
- AM entrypoint：等超时 `[alertmanager] 等待 /alertmanager-live/alertmanager.yml 超时（90s）——拒绝启动`；
  amtool 失败文案照旧形态。
- 页面文案 = §2.8 逐字。

### 2.10 compose / Dockerfile 差异（逐字）

- `docker-compose.yml` alertmanager 段：**删** :766-770 五行（注释 :761-762 改写为「SMTP 配置已管理化
  ⇒ renderer 渲染 /alertmanager-live/alertmanager.yml；本段只留 INTERNAL_SERVICE_TOKEN」）；
  **加** `volumes: alertmanager-live:/alertmanager-live:ro`（现有 alertmanager-data 行保留）。
- `docker-compose.yml` alert-relay 段：**删** :873-876 四行（注释改写「槽位配置已管理化，见
  config.notifyChannel.get」）；**加** `NOTIFY_CHANNEL_PULL_TOKEN=${NOTIFY_CHANNEL_PULL_TOKEN:-}` ·
  `CONFIG_SERVICE_RPC_HOST=config-service` · `CONFIG_SERVICE_RPC_PORT=3106` ·
  `volumes: relay-data:/data`；`INTERNAL_SERVICE_TOKEN` 保留。
- **新服务块 `am-renderer`**（逐字口径）：`image: ${IMAGE_PREFIX:-pokergame}-alert-relay:${IMAGE_TAG:-latest}`
  （**与 alert-relay 同参数化表达式、逐字相同**；**无 `build:`**——r2-N2 钉死）；
  `command: ["node", "packages/alert-relay/dist/am-renderer.js"]`；
  `container_name: ftl-am-renderer`；`restart: unless-stopped`；日志上限块（R1108 同款）；
  `user: "65534:65534"`；`depends_on: [config-service]`（非 health 条件，仅顺序）；
  `environment: NOTIFY_CHANNEL_PULL_TOKEN / CONFIG_SERVICE_RPC_HOST / CONFIG_SERVICE_RPC_PORT`；
  `volumes: alertmanager-live:/alertmanager-live`；`networks: [ftl-platform]`；
  **无 `expose`/`ports`/healthcheck**（无服务面；可用性由判据 ⑦ 的行为承接——登记理由）。
- config-service 段：**加** `NOTIFY_CHANNEL_PULL_TOKEN=${NOTIFY_CHANNEL_PULL_TOKEN:-}`（`PAY_CONFIG_ENC_KEY`
  已有——Q2-A 复用）。
- `volumes:` 段：+`alertmanager-live` · `relay-data`（local）。
- `docker-compose.override.yml`：新 `am-renderer` 块 `profiles: ["monitoring"]` + 同 env 空默认透传 +
  同卷 + `user` 同值；relay 块补 pull token/RPC 两行/`relay-data` 卷（空默认）；alertmanager 块补 live 卷（ro）。
- `Dockerfile.alert-relay`：**多阶段**（`FROM prom/alertmanager:v0.34.1 AS alertmanager-bin` **置于文件
  顶部**、node stage 之前——中段插入会截断 node stage、build 必败；评审 r2-B5）
  + `COPY --from=alertmanager-bin /bin/amtool /bin/amtool`（renderer 的 `/bin/amtool` 预检；评审 S-Y3）
  + `RUN mkdir -p /data /alertmanager-live && chown node:node /data && chown 65534:65534 /alertmanager-live`
  （镜像预建两目录——卷初始化属主继承依据；评审 #17）。
- `Dockerfile.alertmanager`：`RUN mkdir -p /alertmanager-live && chown 65534:65534 /alertmanager-live`
  （**两镜像都预建**——哪个先挂载都成立）。
- `conformance-stack.sh` down 行：`rm -sf` 名单 **+`am-renderer`**。
- compose 头 R1303 注释「14 个带 build」**不变**（共享镜像形态）；`SERVICES=14` 列表**不变**。

## 3. 服务端 / 消费端行为（逐字）

### 3.1 写路径（`set`/`clear`）+ 审计

逐字照支付片 §3.1（`requireActor(401)` → 校验 400 先于一切 → 主钥 503 → 事务〔锁定读 → UPSERT →
`CONFIG_CHANGES_INSERT_SQL` 同事务〕→ 1213 有界重试捕获边界包整事务；`clear` 幂等不落审计）。
密键（五）审计 = `{"redacted":true,"fingerprint":"<12hex>"}`；非密（四）= JSON 字符串明文；
清空 new = JSON 字符串 `'null'`；首写 old = SQL NULL（两列两形态分开钉）。
**事务成功后**调用 `refreshNotifyGauges()`（⚙️17；其内部异常 **catch + WARN**，不得回滚/影响写响应）。
**不得复用** `PlatformConfigService.set()`（设计 D1 纪律）；**不 publish**。

### 3.2 读路径

`status()`：LIST → 逐行解密（密键也解——坏行响亮）→ 按 ⚙️1 序组装九项（缺行 = `configured:false`；
非密给 `value`；密键 `value:null`+`fingerprint`；URL 三键现算 `hint`）。
`pull()`：LIST → 逐行解密 → 仅已配置键。

### 3.3 relay 消费（`notify-config.ts` + `server.ts`）

- **client**：`pullNotifyConfig(env): Promise<Partial<Record<NotifyChannelKey,string>>>`——
  每调用一条新连接、3000ms 超时、不重试、线格式 ⚙️8；**throw**（故障/业务错不分码——调用方统一当
  「这次拉不到」）。
- **last-good**：内存 `lastGood: Partial<...>|null`（**裁剪后四键图**）；启动先读 `/data/notify-config.json`
  ⇒ 命中即初值（**进程启动即可投递**）；轮询 tick：成功 ⇒ 裁剪 ⇒ `lastGood = 裁剪图`（整图替换，`{}` 亦替换）
  ⇒ 原子写文件 ⇒ 重算槽位；失败 ⇒ WARN（状态变化时）+ 保持。
- **槽位派生（纯函数 `sinksFromValues(values)`）**：`wecom = values['notify.webhook.wecomUrl']`（在场即启用）；
  `feishu = ...feishuUrl`；`dingtalk = 两者皆在场`（半配 ⇒ 停用）。槽位顺序 feishu→dingtalk→wecom（照旧）。
- **`/webhook`**：Bearer 守卫照旧 ⇒ `lastGood===null` ⇒ **500**（body `notify config unavailable\n`）；
  else 用当前槽位闭包：零槽位 ⇒ 200 `no sinks configured\n`；否则扇出照旧（allSettled/5s/日志纪律不动）。
- `/health` `/metrics` 面零改动；`PORT` env 保留。

### 3.4 am-renderer（状态机逐字）

- 常量：`AM_CONFIG_PATH='/alertmanager-live/alertmanager.yml'` · `AM_RELOAD_URL='http://alertmanager:9093/-/reload'` ·
  `NOTIFY_PULL_INTERVAL_MS=30_000` · reload 超时 3000ms · amtool 路径 `/bin/amtool`（镜像 COPY）。
- 状态：`lastWrittenHash: string|null` · `lastReloadOk: boolean` · `lastPullFailLogged: boolean`。
- **启动**：`AM_CONFIG_PATH` 不存在 ⇒ 渲染 **baseline**（无值依赖）⇒ 走下面 4–6 步（含首次 reload，
  AM 未就绪 ⇒ 容忍失败）；存在 ⇒ 直接进入循环。
- **循环（tick 0 立即，之后 30s）**：
  1. `pullNotifyConfig()`：失败 ⇒ 首次/状态变化打 WARN、置 `lastPullFailLogged=true`，**return（文件不动）**；
     成功 ⇒ 复位该标志、`values` 继续。
  2. `desired = renderAlertmanagerYml(values)`；`h = sha256(desired)`。
  3. `h === lastWrittenHash && lastReloadOk` ⇒ return。
  4. 写 tmp（600）→ **amtool check-config**（`/bin/amtool check-config <tmp>`）：失败 ⇒ ERROR + 删 tmp + return。
  5. 原子 rename → `AM_CONFIG_PATH`。
  6. `POST AM_RELOAD_URL`（3000ms）：200 ⇒ `lastWrittenHash=h` · `lastReloadOk=true` · INFO 一行；
     非 200/异常 ⇒ ERROR（含重试语义）+ `lastReloadOk=false`（文件已新、AM 内存旧；下轮以
     `h===lastWrittenHash && !lastReloadOk` 重走 4–6——写同名内容幂等）。
- **渲染规则逐字**（`renderAlertmanagerYml` 纯函数；值输出 = **JSON 双引号标量**（`JSON.stringify`——
  JSON 是 YAML 子集，引号/反斜杠/换行全量安全；是「拒含引号值」纪律的上位替代））：
  - 静态段（逐字 = 现 `alertmanager.yml.tmpl:14-29`）：`route`（receiver all · group_by [alertname, job] ·
    group_wait 30s · group_interval 5m · repeat_interval 4h · Watchdog 子路由 → heartbeat · 24h）+
    `inhibit_rules`（critical 抑制同 alertname/job 的 warning）。
  - `global:` 段 **当且仅当**邮件五键**全部**在场 ⇒ 逐字五行（键序照现 entrypoint）：
    `smtp_smarthost: "<host>:<port>"` · `smtp_from: "<user>"` · `smtp_auth_username: "<user>"` ·
    `smtp_auth_password: "<pass>"` · `smtp_require_tls: true`（值经 JSON 标量）；否则整段省略。
  - `receivers:` 恒在：`all` / `webhook`（webhook_configs 逐字：url `http://alert-relay:8090/webhook` +
    `http_config.authorization.type: Bearer` + `credentials_file: /alertmanager/secret/internal_token`）；
    SMTP 全在场时 `all`/`heartbeat` 附 `email_configs: [{to: "<to>"}]` 并加 `email` 接收器（**照今天全形态
    逐字含未引用的 `email` 接收器**）；否则 `heartbeat` = **已定义空接收器**、无 `email` 接收器
    （= 今天全空形态逐字；**半配时附 §2.9 的半配 WARN**，状态变化时一条）。
- 日志纪律：只允许键名/状态/错误类别；**不得**打印渲染产物、拉取响应或任何值。

### 3.5 AM entrypoint（重写后逐字）

```sh
set -eu
: "${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN required}"   # 照旧
# 1) 有界等待生成物（90s = 45 × 2s；超时 ⇒ exit 1 响亮，文案 §2.9）
# 2) umask 077 + 写 /alertmanager/secret/internal_token（600，照旧）
# 3) amtool check-config /alertmanager-live/alertmanager.yml（失败 ⇒ exit 1）
# 4) exec /bin/alertmanager --config.file=/alertmanager-live/alertmanager.yml --storage.path=/alertmanager
```

- **不转发 `"$@"`**（O3 照旧）；不预检 amtool 就 exec 的形态**不允许**。
- `alertmanager.yml.tmpl` 文件**删除**（静态段唯一真源迁至 renderer TS 常量；两条 yml 形态的
  逐字对照测试 = renderer golden（§5.1））。

### 3.6 sink 派生与状态日志

见 §3.3；「状态变化时一条」的判定 = 槽位集（含 disabled 原因类别）与上轮不同才打印。

### 3.7 失败语义等价表（冻结；= 设计 D7）

| 面 | 新语义 |
|---|---|
| 邮件五键全空（成功拉到） | 邮件段省略（= 今天全空态）；AM 照常健康 |
| 邮件五键半配 | 邮件段省略 + renderer WARN + `group_complete{email}=0` + 规则 `NotifyEmailIncomplete`（10m） |
| 钉钉半配 | 该槽停用 + relay WARN + `group_complete{dingtalk}=0` + 规则 `NotifyDingtalkIncomplete` |
| relay 从未成功拉到 | `/webhook` ⇒ **500**（未知 ≠ 成功；AM 按 repeat_interval 重投） |
| relay 成功空图/裁剪后无槽 | 200 no-op（= 今天「明确未配」） |
| 生效时效 | 保存 ⇒ ≤30s（轮询）+ reload（AM 腿另加一次 reload 往返） |

### 3.8 完整性 gauge 与告警规则

- gauges（⚙️17）：`notify_config_keys_configured{group="email"|"dingtalk"}` ·
  `notify_config_group_complete{group=...}`（键集 = ⚙️1 分组；`complete = configured == 组大小`；
  组大小 0 不出现——恒有定义）。刷新点 = config-service 启动 + `set/clear` 成功后；**写路径现算**（不解密）。
- 规则两条（`ftl-alerts.yml` 追加；labels `severity: warning`）：

```yaml
- alert: NotifyEmailIncomplete
  expr: notify_config_group_complete{group="email"} == 0 and notify_config_keys_configured{group="email"} > 0
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "邮件告警通道配置不完整（缺项不会发出邮件）"
    runbook: "管理页 → 通知通道：邮件组被改到一半（五项未齐）。补全或清空。"
- alert: NotifyDingtalkIncomplete
  expr: notify_config_group_complete{group="dingtalk"} == 0 and notify_config_keys_configured{group="dingtalk"} > 0
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "钉钉告警通道配置不完整（URL/密钥半配）"
    runbook: "管理页 → 通知通道：钉钉两项须成对。补全或清空。"
```

- 路由照默认 `all`（webhook 腿照达）；`EXPECTED_RULES 23→25`（slice-16 三处同改）。

## 4. 权限（E′ 精神）与网关

- policy 新条目（**置于 P9 前**，不做通配）：
  `PUT /api/admin/notify-channel/` 前缀 ⇒ `allows('super_admin')`；`DELETE` 同前缀 ⇒ 同上；GET ⇒ 落 P8。
- 网关三条转发方法（`encodeURIComponent(key)` 照 R75）；变体矩阵照 §5.2⑤（含近邻
  `PUT /api/admin/config/notify.*` ⇒ `parseConfigValue` 未知键 400）。

## 5. 测试与判据

### 5.1 单测清单

**config-service**：1. validators（九键正反 + reason 不含值 + hint 全等/仿冒负例 + 逗号列表形态）；
2. crypto（core 往返/AAD 绑定/指纹稳定；**pay 侧全量回归**钉住行为零变化）；3. service（三段序/审计
两列两形态/1213 重试/status 九项序/密键 value null/hint）；4. controller（三端点契约 + 错误序）；
5. rpc（令牌正反/10007/仅已配置键）；6. metrics（写路径现算：set→gauge 变、clear→归零、读失败保持旧值）；
7. 迁移（建表/回滚/号唯一性）；8. `config-probe.ts` 假库扩表。
**alert-relay**：9. `notify-config`（进程内 stub TCP server 正反/超时/裁剪/原子写/读失败⇒null）；
10. `sinks-from-values`（槽位矩阵含半配与空图）；11. `am-renderer`（yml golden 三态**逐字对照**
现 entrypoint 两形态 + 引号/反斜杠/换行值安全用例 + 状态机：content-unchanged 不重载 / pull 失败不动文件 /
reload 非 200 ⇒ 下轮重试且不重写 / amtool 失败不落盘）；12. `server` 改造（lastGood null ⇒ 500；
零槽 200；热更新换槽）。
**shared**：13. redact 新规则正反（命中五密键键名；**不**命中 `REDIS_URL`/`DOUZERO_URL`/裸 `url`）；
14. design-md 闸极化。**api-gateway**：15. policy 正反 + 变体；转发。**admin**：16. 静态串 + 角色门。

### 5.2 conformance `slice-23-notify-channel`（组；断言数 CI 回填 baseline）

**组序与状态链（照 slice-22 纪律；评审 S-B1/S-Y1 收口）**：组序 = ①→⑪ 顺序执行；**每组给「前置/末态」，
未列组沿用前组末态**；relay 投递触发的**观察步一律直打 relay `/webhook`**（`curl` + Bearer + 合成
AM payload——slice-16 C5 先例，确定性、免 AM 通知时序）；**仅 ⑥ 首步**经 **AM API 注入**走一次全链
（**判据台新机制、全仓 0 先例**，登记）。经 AM 的触发一律**互异 alertname**（首投 `group_wait 30s`、
**同组再投要 `group_interval 5m`**——同名为最自然错法），注入后 **≤45s 有界轮询** stub 计数；
直打 relay 的观察窗 **≤3s**（同步扇出）。

① **种子回读与取值（评审 r2-B1 钉死）**：**种子值逐键**：feishuUrl=`http://<stub>/feishu` ·
wecomUrl=`http://<stub>/wecom` · dingtalkUrl=`http://<stub>/dingtalk` · dingtalkSecret=`probe-dingtalk-secret`
· smtp.host=`smtp.invalid` · smtp.port=`465` · smtp.user=`probe@example.invalid` · smtp.pass=`probe-pass` ·
email.to=`probe@example.invalid`（**（种子值）可达面全部圈在 stub 与不可解析域内**；hint 探针轮的
真实平台域短暂在位除外——该轮不触发投递；**计数断言一律按 stub 路径分桶**）。
PUT 九键 ⇒ GET 回读顺序/标签；密键 value=null+指纹非空；URL 三键 hint 六例（三平台 ⇒ origin；
`https://example.com/hook` ⇒ `外部地址`；**仿冒两例** `https://evilqyapi.weixin.qq.com.hk/h`
与 `https://qyapi.weixin.qq.com.evil.com/h` ⇒ 均 `外部地址`）用**独立 PUT/GET 探针轮**（完成后 PUT 回种子值）。
**末态 = 九键种子态**（供 ②–⑤；统一收尾 DELETE）。
② **不进广播**：RPC `config.snapshot` 响应串无 `notify.` 子串 + 恰 34 键；`/api/config` 恰 14 键；
`containerEnv` 三容器（alertmanager/alert-relay/am-renderer）无九键（防回流）。**前置 = ①末态**（无状态变更）。
③ **静态加密**：SQL 直查 `notify_channel_config.value_enc` ⇒ 全 `v1:` 前缀、无任一值明文子串。**前置 = ①末态**。
④ **审计脱敏**：五密键行 old/new 不含原文子串、含 redacted 对象 + actor；四非密行落原文；
清空行 `JSON_TYPE(new_value)='NULL'`（照 slice-22 ④ 口径）。**前置 = ①末态**。
⑤ **权限矩阵+变体**（四段式，照 slice-22 ⑧ 实测语义**逐格**）：**非 SA 三角色（operator/finance/viewer）** ×（字面 + `%2E`/`%4B`/
混合大小写变体）⇒ **403**；**SA** × {字面, 键段 `%2E`（=`.`）/ `%55`（=`U`，解码后落 `feishuUrl`）, 混合大小写} ⇒ **200**（policy 匹配未解码
原值路径、前缀段未编码 ⇒ 命中；**微审 v1.6**：九键**无 'K'**——slice-22 的 `%4B` 格不适用，改 `%55`；如另留 `%4B` 一格则期望 **400**（下游未知键拒——体现「policy 命中 + 下游白名单拒」双层结构））；`%2F` 前缀段 / 裸路径 / 尾斜杠 ⇒ **403（含 SA）**（本系统**无 404 来源**——policy 先于路由）；GET 读面矩阵（任意已认证 ⇒ 200）；近邻 `PUT /api/admin/config/notify.smtp.pass`
（SA/operator token）⇒ **400**（`parseConfigValue` 未知键）。**SA 正格 = DELETE `notify.smtp.host` ⇒ 200
⇒ 组内 PUT 回原值并自证 configured**（照 slice-22:936-947）。末态 = ①末态。
⑥ **relay 端到端（真栈）**：**前置 = ①末态**；PUT wecomUrl=`http://<stub>/wecom` ⇒ ≤60s（30s 轮询 + 余量；
GET 自证 configured）⇒ **AM API 注入**合成告警（alertname `ProbeWecomA`、短 `endsAt`）⇒ **≤45s** stub
**`/wecom` 路径**收到投递（≥1）；换 URL（`/wecom2`）⇒ ≤60s ⇒ **直打** `/webhook` ⇒ 新地址收到、旧地址计数不再增长；
DELETE wecomUrl ⇒ ≤60s ⇒ 直打 ⇒ stub（`/wecom2`）计数不变（不投）；**DELETE `dingtalkSecret` ⇒
PUT `dingtalkUrl=http://<stub>/dingtalk`（= 半配态）⇒ ≤60s ⇒ 直打 ⇒ 无 dingtalk 投递（`/dingtalk` 路径
计数不变）+ relay WARN 逐字（docker logs）**；**DELETE 四 IM 键 ⇒ ≤60s ⇒ 直打 ⇒ 200 `no sinks configured`**。
**末态 = IM 零键**（SMTP 五键仍在）。（注：⑥ 期间存活的种子槽 = feishu（stub）· dingtalk（stub）·
**被测 wecom（stub，即断言目标）** · email（`smtp.invalid` 惰性）⇒ AM 注入的扇出会额外命中 `/feishu`、
`/dingtalk` stub 路径与一次 email **尝试**（预期失败、无真投递、AM 侧计数无规则监听）——**故本组计数
断言按路径分桶、一律 delta 口径**；resolved 通知（email 面 `send_resolved: false` 有本日探针期 dump
观察、webhook 面默认值**未实证**——登记，断言不依赖之）会在 `endsAt` 到期后（受 `group_interval`
节流）多投一次 stub——对**负向**断言（已停用路径「计数不变」）免疫；对正向断言的低概率窗口重叠以
「按 `alerts[].status == "firing"` 分桶」消解（实施期落）。）
⑦ **AM 渲染端到端（真栈）**：**前置 = ⑥末态**；PUT SMTP 五键（host=`smtp.invalid`、port=465）⇒ ≤60s：
①`/alertmanager-live/alertmanager.yml`（docker exec 读）逐字含五值（`grep -F`，容器内断言）；
②`GET /api/v2/status` 显示 `smtp_smarthost/smtp_from/to` 且 `smtp_auth_password: <secret>`；
③ amtool 预检绿（由 renderer 成功写入 + AM 启动承接）；DELETE `smtp.pass` ⇒ ≤60s 邮件段消失（回归
baseline 态、reload 成功）。**末态 = SMTP 4/5（无 pass）· IM 零键**（不触 IM 侧，无 IM 断言）。
⑧ **回落（逐形态）**：**前置 = ⑧ 自种**——PUT 四 IM 键（值指向本次 stub）⇒ ≤60s 自证（GET configured
且 `/data` 含四键）⇒ 再停 config-service。a) stop config-service ⇒ **直打** `/webhook` ⇒ stub 收 +
renderer 卷 yml hash 前后相等；b) 期间 `--force-recreate` relay ⇒ 直打 ⇒ **仍收**（/data 持久化判据）；
c) 期间 `--force-recreate` renderer ⇒ 卷 yml 逐字不变 + `/api/v2/status` 不变 + **`docker inspect
ftl-am-renderer` 状态 running**（存活断言，防「重建即崩」假绿；评审 S-Y6）；d) `/data` 内容断言：
**含 IM 四键**、无 `notify.smtp` 子串/无 SMTP 值（容器内断言）；e) **从未拉到**：停 config-service +
清 `/data` + recreate relay ⇒ 直打 `/webhook` ⇒ **500**；恢复 config-service ⇒ ≤60s 拉取恢复 ⇒ 直打 ⇒
收（复绿）。**末态 = IM 四键（stub 值）· SMTP 4/5 · config-service 恢复**。
⑨ **fail-closed**：**前置 = ⑧末态**；取现容器主钥 `pick('PAY_CONFIG_ENC_KEY')` ⇒ 空值重建 config-service
⇒ GET/PUT ⇒ 503 逐字（用合法值 PUT，400 先于 503）· RPC ⇒ 10007 · relay 保持 last-good（**直打** ⇒ stub 仍收）·
renderer 卷 yml hash 与 ⑧c 读数相同（其「保持」由 ⑧a/c 承接）· 34 键面 200；恢复钥重建 ⇒ 复绿（PUT 成功 + 拉取恢复 + 直打复投）。
**末态 = ⑧末态**。
⑩ **gauge/规则**：**前置 = SMTP 4/5（⑦ 遗留；或显式重 PUT 成 4/5）**；9006 读（exec+Bearer，照
slice-16 C1）`keys_configured{email}=4` 且 `group_complete{email}=0`；**在 4/5 在位期间**经 Prometheus
`/api/v1/alerts`（新面）读到 `NotifyEmailIncomplete` **state ∈ {pending,firing}**——**≤120s 有界轮询**
（scrape 15s 与 eval 周期，照 slice-16 `:630-647` 先例）+ 负例（另造 alertname 不命中）；**随后**补第 5
键 ⇒ gauge `1`；再清空 ⇒ `0/0`。**末态 = 邮件 0/0**。
⑪ **日志无凭据**：**前置 = ⑩末态**；全链后 **三容器 = `alert-relay` · `am-renderer` · `config-service`**
（**不含 alertmanager**——其日志按设计允许出现 smarthost 名（⑥ 的 email 尝试/⑦ 的惰性值），属预期面，
不入本判据；照设计 D9-⑪ 逐字）`docker logs` grep **needle 集 = 五密键种子值 + `smtp.invalid` +
`probe@example.invalid` + `NOTIFY_CHANNEL_PULL_TOKEN`**（**不 grep `465` 等短值**——裸 substring 先例
（`grepHits=text.includes`）下 3 字符数字有假红面（NDJSON ts 毫秒域））**全空** + **窗口正向对照**
（必含本次 run 产生的某行）+ 判别力自证（合成行喂同 grep 必中）。
**收尾（收敛自证，评审 S-Y7）**：九键全 DELETE（幂等）⇒ **≤90s 自证收敛**：①卷 yml 回 baseline
（无 smtp 段）且 reload 成功；②relay 零槽（直打 ⇒ 200 no-op 且 `/data` = `{}`）；③stub 停；注入告警
自然过期。**残留登记**：「崩在 ⑦–收尾之间」的轮次可能留下 smtp.invalid 的卷 yml，下一轮首拉 ≤30s 收敛；
AM 以其启动**无害**（smtp.invalid 只在真发信时失败）——命名卷跨 run 延续面入台账。

### 5.3 既有闸改造（核销表；逐行 = 验收清单）

| # | 面 | 文件:行 | 处置 |
|---|---|---|---|
| 1 | relay env 装配 | `alert-relay/src/config.ts:81-104`·`server.ts:209-231` | 退役；`PORT`/守卫保留 |
| 2 | relay 半配三态 | `test/config.test.ts:57-86` | 「拒起」三用例 → 「槽停用+WARN」/派生纯函数用例 |
| 3 | slice-16 relay 组 | `:472-494,763-798,858-861` | 注入改 ⚙️22 stub 拉取源 + 就绪语义（pulls≥1）；四组合判定力保留 |
| 4 | slice-16 规则数 | `:89-100`(EXPECTED_RULES) · `:599`(promtool '23') · `:662`(计数 23) | 三处 23→25 |
| 4b | slice-18 规则数 | `slice-18-gold-room.ts:1286`（「恰 23 条」硬断言） | **23→25**（通知 +2；注释里的构成式同步）——W3 评审发现的原核销表漏面，微审补入 |
| 4c | prometheus 镜像头注 | `Dockerfile.prometheus:1`（「23 条规则」） | **23→25**（随 T14 批核销；W3 深扫发现无任务自然承接，显式指派 T14） |
| 5 | slice-07.2-deploy | `:569-578`（A12）·`:970-981`（LOG_LIMIT_TARGETS，+1）· env 渲染断言面 | renderer 无 `build:` ⇒ A12 不动；LOG_LIMIT+1；env 面九行删/新增逐条核 |
| 6 | slice-07.5-backup | 判据 d | **零改动**（Q2-A；验证不红即过） |
| 7 | messages.test | `:53-70` | +1 pattern + 标题 |
| 8 | meta 机械闸 | `room-service/test/meta-on-every-rpc-send.gate.test.ts` | 扫描面不含 alert-relay ⇒ 预期不红；实施期确认 |
| 9 | slice-19 G12 | `:1451-1465` | +3 needle（§2.8） |
| 10 | design-md 闸 | `:90-117` | NEW_ENVS+1 · RETIRED_ENVS+9 |
| 11 | redact | `:98-99` | +`notify.` 命名空间支；正反用例 |
| 12 | 34 键面 12 处 | 设计附录 B | 零改动（验证不红） |
| 13 | compose 注释/头注 | `:761-762`·`:866-867`·（R1303 头注不动） | 改写口径 |
| 14 | admin「十视图」注释 | `app.js:351,731,788,3048` | → 十一视图 |
| 15 | baselines.json | — | 新片 CI 回填 |
| 16 | slice-16 SERVICES/C14 | `:1180-1188` 等 | 共享镜像形态**不动**；down-rm 名单走 conformance-stack（#17） |
| 17 | conformance-stack.sh | `:213`（down-rm） | +`am-renderer` |
| 18 | config.rpc J21 扫描闸 | `robot-availability-wiring.gate.test.ts` | 同控制器加 pattern ⇒ 确认仍绿 |
| 19 | slice-07.4 C4 pin | `slice-07.4-pipeline.ts:613-614`（`wantEx` 2→3） | **pin 同步**：+`1241259 @vue/server-renderer`、顺序照实况（不豁免增减判据语义）——来源 = 支付片 `59105ef`（增豁免 #3 时未同轮同步本 pin）；T18 全序真红发现（确定性、单跑逐字复现），本批修复 |
| 20 | slice-07.4 C6③ pin | `slice-07.4-pipeline.ts:631-633`（`topAllow` 5→7） | **pin 同步**：来源 = 本片 T17 `79fcfdb`（补列 2 条 path 型允许清单时未同轮同步本 pin）；T18 全序真红发现，本批修复 |

### 5.4 夹具与栈脚本

- `conformance-stack.sh`：`export NOTIFY_CHANNEL_PULL_TOKEN="${NOTIFY_CHANNEL_PULL_TOKEN:-<⚙️13 dev 值>}"`；
  **无通知种子**（默认态 = 全未配置 = 今天通道全关；slice-23 自种子自清）。
- `run.ts`：启动处 `process.env.NOTIFY_CHANNEL_PULL_TOKEN ??= '<⚙️13 dev 值>'`（单一供给点，照 T-1 先例）。
- `lib/http.ts`：+`adminNotifyChannelGet/Put/Delete`（同族 helper）。
- stub：切片内联（net/TCP 帧 server + HTTP 收集端），照 slice-16 `STUB_SCRIPT` 形态。

### 5.5 baseline

- slice-23 追加 `run.ts` CASES 末尾（不中段插入）；`baselines.json` 由 CI 运行回填（照近例）。

## 6. 闸与核销（文档面；§5.3 为代码面）

| 文档 | 处置 |
|---|---|
| `docs/design.md` | §2.3 | +`NOTIFY_CHANNEL_PULL_TOKEN` 行（注释指向 §7.5 新小节；监控族键本无 §2.3 行——不动）；**并订正 `PAY_CONFIG_ENC_KEY` 行**（:198——现文称只保护「渠道六项凭据」/「其它面不受影响」；本片后同钥亦为通知九键主钥、缺钥同样 503 通知三端点并拒 `config.notifyChannel.get`——W3 深扫发现，T17 收编） |
| §4.2/§4.3 | +pattern 行；+「30s 轮询、不重试、降级=last-good」行 |
| §7.5 | +「通知通道键空间」小节（表/端点/RPC/加密/权限/审计/gauge-规则口径） |
| §10.3 | 表清单 +`notify_channel_config` |
| `first-deploy.md` | :248-258 键表九行删 + 指管理页；「两条硬规则」:1216-1219 与 :253/:255 改写；监控③节重写为管理页操作；+「通知怎么上线（三步）」；恢复节注明（主钥无新增） |
| `notify-onboarding.md`（新） | 平台取址（企微/飞书/钉钉/邮箱授权码）+ 安全增益 + 轮换 + 验收（照 alipay-onboarding） |
| `ftl-alerts.yml` | §3.8 两规则 + runbook 指「管理页 → 通知通道」 |
| `deviation-ledger.md` | N 条：半配拒起退役（双向）/entrypoint 拼装迁 renderer/原地 reload/last-good 持久化与「从未拉到⇒500」/按消费方裁剪/crypto 泛化搬迁/主钥名字债/邮件「完整但坏」不在判据面/无 meta 拉取/**导入窗口（部署至导入完成数分钟无投递）**/**命名卷跨 run 残留面（判据收尾已自证+登记）** |
| `.gitleaks.toml` | 若夹具含类真实 webhook URL 形态 ⇒ allowlist 条目（照「保留字面量」纪律） |
| `README` 等 | 实施期按 §5.3 实测面收尾 |

## 7. 上线 / 回滚 / 手册

1. 部署顺序（设计 D10）：**先把 `NOTIFY_CHANNEL_PULL_TOKEN` 补进服务器 `.env`（三端同值——漏配则
   管理面保存成功但拉取全拒：通道不生效、relay 首启 500；照「先补根信任锚」先例）** → push master →
   tag → `deploy.sh` 部署 → **立即导入九值**（管理页手工，
   或服务器侧一行式：读 `.env` 九行 → admin 登录 → PUT ×9；值不离开服务器）→ 触发测试告警
   ⇒ **收真邮件 + 真企微** → 轮换演练（企微后台重发 webhook ⇒ 覆盖 ⇒ 指纹变化 ⇒ 再触发 ⇒ 新群收到）
   → 观察 → （裁决后）删服务器/本机 `.env` 九行 + compose 行。
2. **回滚窗**：九行保留至验收通过；回滚**必须经 `deploy.sh`/`rollback.sh`**（送机 compose 取自目标 tag）。
3. 备份：**零改动**（Q2-A；剥离逻辑与恢复手册均不变）。

## 8. 修订记录

- **v1（2026-10-07）**：起草。来源 = 设计 v1.3 冻结 + r1/r2 评审处置全量 + 实读范式
  （DDL/RPC/管理端点·hint/relay 客户端/renderer 状态机与 yml 两形态/entrypoint/栈脚本/核销表）。
- **v1.1（2026-10-07）**：规格评审 r1 处置——**S-B1 阻断**（§5.2 组间状态链：每组补「前置/末态」+
  ⑧ 自种前置 + 收尾收敛自证）· S-Y1（直打 relay 触发 + 互异 alertname + 有界窗）· S-Y2（⑤ 四段式
  变体矩阵）· S-Y3（amtool COPY 落文）· S-Y4（protocol 依赖入改动面）· S-Y5（stub `/_pulls` 读数口）·
  S-Y6（⑧c 存活断言）· S-Y7（收尾收敛）· S-G1–G7（步号/规则文案/仿冒二例/定形两处/上线序 token/
  提示逐字/pending 窗口）。
- **v1.2（2026-10-07）**：规格评审 r2 处置——**r2-B1**（① 种子九键取值逐键钉死 + hint 独立探针轮 +
  计数按路径分桶）· **r2-B2**（⑥ 括号自相矛盾改写 + resolved 通知注记）· **r2-B3**（钉钉半配步骤补
  `DELETE dingtalkSecret` 前置）· r2-B4–B8（非 SA 三角色/多阶段置顶/⑩ 读数位序/⑨ renderer 承接句/
  半配 WARN 逐字入文案表与状态机）。
- **v1.3（2026-10-07）**：规格评审 r3 微审处置——**G1**（⑪ 容器集点名 = relay/renderer/config-service
  不含 AM；needle 集钉死、短值 `465` 排除）· G2（⑥ 计数三处精度：`/wecom` 路径、存活槽含被测 wecom、
  resolved 分桶）· G3（resolved 引注改探针期 dump 观察口径，webhook 默认值标未实证）· G4（① 可达面
  限定为「种子值」+ hint 探针轮除外语）。**冻结。**
- **v1.4（2026-10-07 · 实施期微审）**：两项——① §3.8 注记键 `description:` → `runbook:`（勘误：既有 23 条
  规则一律 `runbook:`；判据面无依赖；T11 勘误提交同源）；② §5.3 补 `#4b` slice-18 规则数 23→25
  （W3 评审发现的原核销表漏面；T14 同步收编）。
- **v1.5（2026-10-07 · 实施期微审）**：§2.8 交互文案的 503 一条改为「显示服务端 message（回落固定字面）」
  ——W3 深扫发现：服务端区分两种 503 文案，页面固定字面会把「密文损坏」误报为「缺主钥」；
  同批勘误含 `redact` ↔ protocol 常量的**同步机械闸**（新增密键时防静默漏脱敏）。
- **v1.6（2026-10-07 · 实施期微审）**：§5.2⑤ 的键段编码变体 `%4B` → **`%55`**（= `U`；九键无 'K'，
  slice-22 矩阵不适用——W3 评审 I1 实证：`%4B` 解码后非注册键、真栈该格落 400）；`%4B` 若保留则
  改判期望 400（双层结构展示）。T16 按本版执行。
- **v1.7（2026-10-07 · 实施期微审）**：① §2.4 `smtp.host` 规则收紧（拒 `...`/`..`/首尾点横线——
  W3 深扫实证旧式放行）；② §2.8 钉钉组尾提示改**按缺项数现算**（v1.3 固定「缺 1 项」在双缺时误导，
  design D5「同理」的现算意图正名，M2 消解）。redact **文本路径**的 notify 覆盖面**有意不扩**
  （与支付片 G1 同姿态：文本路径只认形状/通用名键值对，键空间名走对象路径 + 纪律兜底——入台账）。
- **v1.8（2026-10-07 · 实施期微审）**：W4 评审两条措辞级——① ⚙️15「exec 三 flag」→ **两 flag**
  （§3.5 代码块逐字为准；实现本就正确）；② §2.9 renderer 允许面补兜底 ERROR 行（`[am-renderer]
  内部错误（本轮保持现状）`，无值、状态变化一条）。另两条 Minor 入台账（slice-18 I 组「状态依赖」
  精确化表述 · down-rm 的 `+am-renderer` 无机械判据留目）。
- **v1.9（2026-10-07 · 实施期微审）**：§5.3 补 `#19`/`#20` —— slice-07.4 安全豁免 pin 同步
  （C4 `wantEx` 2→3：+`1241259 @vue/server-renderer`，来源 = 支付片 `59105ef` 遗留；C6③ `topAllow`
  5→7，来源 = 本片 T17 `79fcfdb`）。T18 全序真红（确定性、单跑逐字复现）⇒ 修复后单跑复绿（75 项）。

## 9. 冻结声明

- r3 评审结论「**修复后冻结**」：§3 四条（G1–G4）全数收口于 v1.3；**r1 的 1 阻断 + 7 🟡 + 7 🟢** 与
  **r2 的 3 🟡 + 5 🟢** 亦已全数收口（报告 `.superpowers/sdd/2026-10-07-notify-channel/review-spec-r{1,2,3}.md`）。
- 自此：**实施不得偏离本文**；实现期发现的任何必要偏离 ⇒ 台账登记 + 规格修订（走一轮微审）。
