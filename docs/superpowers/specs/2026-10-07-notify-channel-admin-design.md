# 通知通道管理化（SMTP/IM 凭据进管理面）**设计层 v1.3（冻结）**

> **上游**：支付配置管理化片收口交接 `docs/superpowers/plans/2026-10-06-post-pay-channel-handoff.md` §8
> 「第一梯队 · 通知通道」（推荐下一片）。
> **状态**：**v1.3（2026-10-07）冻结**——Q1/Q2 已裁（renderer 侧车 · 复用主钥）；评审 r1（1 阻断 + 9 🟡 +
> 8 🟢）与 r2（19/19 处置核验 + 1 🟡 + 3 🟢 新项）**全部收口，两轮结论均为「可通过」**；报告与台账
> `.superpowers/sdd/2026-10-07-notify-channel/`。下一环 = 规格层。
> **本片一句话**：把邮件告警（SMTP 五项）与三个 IM 告警通道（webhook 四项）从服务器 `.env` 搬进
> config-service 的**通知键空间**（AES-256-GCM 加密存储 + 专用拉取通道 + 管理页掩码写 + 审计脱敏），
> 由 alert-relay（IM 投递）与新增的 AM 配置渲染器（写 Alertmanager 生成配置 + 原地重载）消费；
> **邮件仍由 Alertmanager 原生发出（模板/呈现/独立性零变化）**，`.env` 不再承载任何通知凭据。

---

## 0. 一句话

**九键**（`SMTP_HOST/PORT/USER/PASS` · `ALERT_EMAIL_TO` · `FEISHU/WECOM/DINGTALK_WEBHOOK_URL` ·
`DINGTALK_SECRET`）→ config-service 新表 `notify_channel_config`（同支付键空间形态）
→ 新 RPC `config.notifyChannel.get`（拉取令牌 `NOTIFY_CHANNEL_PULL_TOKEN` 三持有）
→ 消费端：**alert-relay**（改为拉取驱动，槽位随拉取图热更新）+ **am-renderer**（新极小组件：渲染
`alertmanager.yml` → 原子写共享卷 → `POST /-/reload`）
→ 管理页「通知通道」视图（密键只写不可读、只回指纹）+ `config_changes` 审计脱敏。
**34 键广播面/客户端 14 键不动；`CONFIG_KEYS` 不动。**

## 1. 输入

### 1.1 用户裁决与上游输入（**Q1/Q2 2026-10-07 已裁**；其余为上游交接已定）

| # | 来源 | 内容 | 本文落实 |
|---|---|---|---|
| A | 交接 §8（2026-10-07 复扫） | 第一梯队 = 通知通道九键（现役：SMTP 五 + WECOM；留后：飞书/钉钉三键一并搬，日后有 webhook 直接在管理页配） | D1 范围：九键全搬 |
| B | 交付 §4 流程纪律（一条龙/密钥不进日志/判据同提交/「跑了」指向本次日志/真栈回归/假红先单跑） | 同支付片 | §6 判据计划 + §8 风险 |
| C | 支付片先例（安全硬要求七条已裁形态） | 加密/不进广播/掩码写/审计脱敏/权限/契约冻结面 | D2–D7 逐条对位（附录 C） |
| **Q1** | **本片产品问（2026-10-07 已裁）** | **AM 邮件链路的配置下发架构** | **裁决：E：renderer 侧车**（D4′）；未选 D（relay 收编邮件） |
| **Q2** | **本片产品问（2026-10-07 已裁）** | **通知键空间主钥：复用 `PAY_CONFIG_ENC_KEY` vs 新 `NOTIFY_CONFIG_ENC_KEY`** | **裁决：A：复用 `PAY_CONFIG_ENC_KEY`**（D2；名字债入台账）；未选 B（新钥） |
| D | 交接 §8 第二/三梯队 | 节奏旋钮、`GRAFANA_ADMIN_PASSWORD` 均**不在本片** | §5 YAGNI 明文收口 |

### 1.2 既有约束（本仓纪律，逐条适用）

- 结构性封死优先于纪律性封死（独立键空间、结构上不进广播——支付片 D1 先例）。
- **判据只增不减**；既有行为搬运处**语义等价或显式偏离登记**（本片有一处大的：半配拒起，见 D7）。
- 路径归一化变体（尾斜杠/大小写/`%2E`）是本仓已咬多次的形态：凡按路径/按键分权必须**结构封死** +
  变体负例入判据；网关 policy 匹配**未解码原值路径**（`gateway.controller.ts:135-139` R75 在案）。
- 「跑了」的表述必须指向本次产生的日志；文档/判据证据一律 file:line（本仓无 `.codegraph` 索引）。
- 环境事实（本日实测，2026-10-07，见 §2.5）与代码事实同等入册。

## 2. 现状（实测事实，带出处）

### 2.1 通知九键今天的形态

- **一份 `.env` 全栈共用**，compose `${VAR:-}` 空串透传：SMTP 五键 → alertmanager
  （`docker-compose.yml:766-770`）；IM 四键 → alert-relay（`:873-876`）。**空串 = 未设**。
- **两处消费面**：
  1. **alertmanager**（邮件腿）：entrypoint **启动时**拼装 `/alertmanager/alertmanager.yml`
     （`deploy/monitoring/alertmanager/entrypoint.sh:18-147`）——三态分支：五键全非空 ⇒ 拼
     `global.smtp_*` + email 接收器；全空 ⇒ 整段省略（心跳走**已定义的空接收器**）；
     **半配 ⇒ 拒启动（exit 1，响亮）**；注入值含 `"`/`\`/换行 ⇒ 拒启动（YAML 引号纪律）；
     拼装后 `amtool check-config` 预检 → `exec alertmanager`（脚本全给 flag，不转发 CMD——O3）。
     每次**启动**重生成；运行期**从不重载**（改值 = 改 .env + 重建容器）。
  2. **alert-relay**（IM 腿）：`loadConfig(env)` 在**启动时**装配一次
     （`packages/alert-relay/src/config.ts:81-104`；`server.ts:43-74` 装配 sink 闭包）——
     空串=未设；**钉钉 URL/SECRET 半配 ⇒ `RelayConfigError` ⇒ 拒启动**（config.ts:96-101）。
- 现役值在**服务器 `.env`**（邮箱 163:465 + 企微 webhook 已配；飞书/钉钉未配）；本机/conformance
  全部为空（本机实测：两个消费容器 `ftl-alertmanager`/`ftl-alert-relay` 九键均空串）。
- `.env` 进每小时备份（`scripts/ops/backup.sh:181-193` 打 `env-*.gz`）⇒ 今天九键明文在备份里。

### 2.2 支付片已建成的复用面（第二键空间全套机制）

- 表形态与迁移：`pay_channel_config`（`packages/config-service/src/migrations/1792000000000-PayChannelConfig.ts`，
  下一空号 `1793000000000`）；AES-256-GCM/AAD=键名/`v1:` 密文/指纹 sha256[12]（`pay-channel.crypto.ts`）。
- 服务层三段序（校验→主钥→锁/ODKU/审计同事务 + 1213 重试，`pay-channel.service.ts`）·
  校验器矩阵（`pay-channel.validators.ts`）· 管理三端点（`pay-channel.controller.ts`）·
  RPC 拉取 + 常数时间令牌（`rpc/config.rpc.controller.ts:86-123`）·
  协议注册表（`packages/protocol/src/pay-channel.ts`；`rpc.ts:107` RPC_PATTERNS）。
- 管理面：页面视图（`admin/app.js:357-395` VIEWS + `:1967-2119` load/save/clear + `:2001-2068` 行构建）·
  网关 policy 前缀两条（`admin-policy.ts:245-253` P-c1/P-c2）+ 三条转发方法（`gateway.controller.ts:166-209`，
  键 `encodeURIComponent`）· 审计 `config_changes`（密键 `{"redacted":true,"fingerprint"}`）。
- 消费端先例：payment 侧「每调用现拉 + 失败回落上次成功值 + 整图替换」（`pay-channel.config.service.ts`）。
- 日志纵深：`shared/src/logging/redact.ts:98-99` SECRET_KEY_NAME 段界规则（`privateKey|pullToken`）。
- 备份剥离：`backup.sh:191` `awk '!/^PAY_CONFIG_ENC_KEY=/'`（含 pipefail 坑注记）。
- 机械闸：`design-md-*.gate.test.ts` NEW_ENVS/RETIRED_ENVS（只增不减）；`messages.test.ts:53-70`
  RPC_PATTERNS 全量 `toEqual`；gitleaks 全历史扫描（`.gitleaks.toml` 5 条 allowlist）。

### 2.3 监控两容器的运行形态

- **alertmanager**：`prom/alertmanager:v0.34.1` + 自造 entrypoint（`Dockerfile.alertmanager`）；
  运行用户 `nobody(65534)`；卷 `alertmanager-data:/alertmanager`（生成配置 + 静默/nflog 态，600）；
  webhook 接收器恒在（指向 `alert-relay:8090`，Bearer 走 `credentials_file`
  `/alertmanager/secret/internal_token`，600）；健康检查 `wget /-/healthy`。
- **alert-relay**：`node:20-alpine`（BusyBox wget 供 healthcheck），运行用户 `node(1000)`；
  无卷（运行期不写盘）；`/webhook`+`/metrics` Bearer 守卫，`/health` 无守卫；扇出 allSettled、
  单槽失败隔离、5s 出站超时、**URL/secret 永不进日志/指标**（`sinks.ts:15-17`、`server.ts:197-199`）；
  `--profile monitoring`（dev）/恒起（prod）。
- 监控六容器**已在 conformance 真栈内**（`scripts/deploy/conformance-stack.sh:92,97` 双 profile）；
  slice-16 以「临时 docker run relay 实例 + 内联 stub」测 relay 行为（`slice-16-monitoring.ts:472-494,763-798`），
  AM 目前仅作 Prometheus 抓取目标（`:82-112` EXPECTED_JOBS=15 / EXPECTED_RULES=23 / NEST_TARGETS=8）。

### 2.4 判据台既有先例（slice-22 为主）

- 种子走 conformance-stack.sh（管理面 PUT ×N，`conformance-stack.sh:199-205`），切片 ⓪ 组只回读。
- TCP 直连 RPC 探针（`lib/rpc.ts`，端点 `CONFIG_RPC` 3106）；「不进广播」= `config.snapshot` 无子串 +
  恰 34 键；DB 密文 = `mysqlScalar` 直查；容器 env = `containerEnv`；fail-closed = `compose({KEY:''}, up
  --force-recreate)` 重建；收尾 finally 还原（slice-22:1094-1116）。
- **注入合成告警**（AM API `POST /api/v2/alerts`）本日已实证可行（§2.5 探针 5）。

### 2.5 🔴 本日探针实测（2026-10-07，本机 dev 栈，全可逆、已还原）

> 这些事实直接决定 D3/D4 与判据设计，全部为**本次实测**（非文档推断）。

| # | 探针 | 结论 |
|---|---|---|
| 1 | `POST /-/reload`（AM v0.34.1） | **默认可用、返回 200**；`--web.enable-lifecycle` 在该版本**不存在**（--help 全列无此 flag）⇒ 无需任何额外 flag |
| 2 | `kill -HUP 1` | 同样触发重载（日志 `Loading configuration file`） |
| 3 | 坏配置 + reload | **500** + `level=ERROR "Loading configuration file failed"`，**旧配置继续在内存运行**（恢复文件再 reload ⇒ 200）⇒ 「坏配置不打断既有投递」语义成立、可测试 |
| 4 | `GET /api/v2/status` | **回显当前已载入配置**（`config.original` 全文，`smtp_auth_password: <secret>` 掩码）⇒ 判据台的「配置已到达 AM」断言面；`/-/config` 在该版本**不存在**（404） |
| 5 | 改配（全 SMTP 形态指向伪造 SMTP）+ reload + 注入合成告警 | reload 200；group_wait 30s 后 `notifications_total{email/webhook}` 双 +1（webhook 打到 relay no-op 200）；**AM 对 `require_tls: true` 的连接先发 `EHLO`，对端不广告 STARTTLS 则直接 `QUIT`**（`failed_total{email,reason="other"}` +1）⇒ 邮件腿语义与今天逐字一致；本片 conformance **只断言「配置到达 AM」，不做 SMTP 会话级 E2E**（邮件腿真投递 = 用户验收项，其代码路径本片零改动） |
| 6 | amtool 二进制在 `node:20-alpine` | **直接可运行**（静态二进制）⇒ renderer 镜像可多阶段 COPY amtool（预检能力可带走） |
| 7 | 探针告警残留 | 合成告警按 `endsAt` 自然过期（`send_resolved: false` 于 email ⇒ 无真实投递副作用）；探针期间 relay 无槽位 ⇒ 全部 no-op 200；**已还原 AM 原配置并 reload 200、stub 容器已删** |

## 3. 设计决策

### D1 — 归属与隔离：通知九键 = config-service **第三键空间（独立表）**，结构上不进广播

- 新表 `notify_channel_config`（形状逐字照 `pay_channel_config`：`key` PK varchar64 ·
  `value_enc` text（`v1:` 密文）· `fingerprint` char(12) · `updated_at` datetime(3) · `updated_by`）；
  迁移号 `1793000000000`（顺排下一空号）；**无种子**（出厂 = 全未配置 = 与今天「通道全关」等价）。
- 九键**不入** `CONFIG_KEYS`/`platform_config`；`config.snapshot`、`/api/config`（14 键）结构上不达
  （支付片附录 B 的 12 处硬断言零改动）。
- 键名（规格层逐字冻结；本文提案）与密否：

| # | 键 | 密 | 管理页 label | 消费方 |
|---|---|---|---|---|
| 1 | `notify.smtp.host` | 否 | 邮件服务器 | renderer |
| 2 | `notify.smtp.port` | 否 | 端口 | renderer |
| 3 | `notify.smtp.user` | 否 | 账号 | renderer |
| 4 | `notify.smtp.pass` | **是** | 授权码 | renderer |
| 5 | `notify.email.to` | 否 | 收件地址 | renderer |
| 6 | `notify.webhook.feishuUrl` | **是** | 飞书 webhook | relay |
| 7 | `notify.webhook.wecomUrl` | **是** | 企业微信 webhook | relay |
| 8 | `notify.webhook.dingtalkUrl` | **是** | 钉钉 webhook | relay |
| 9 | `notify.webhook.dingtalkSecret` | **是** | 钉钉加签密钥 | relay |

- 🔴 **密类判定依据**：三个 webhook **URL 本身即凭据**（token 在 query/路径里，今天 relay 纪律
  「URL/secret 永不进日志/指标」即由此）⇒ 与私钥同规格：只写不可读、只回**指纹**；额外回显
  **`hint`**——仅当 host 命中**三平台 allowlist**（`qyapi.weixin.qq.com` / `open.feishu.cn` /
  `oapi.dingtalk.com`）时回 origin，否则「外部地址」（防「host 即令牌」形态的凭据片段回显到
  任意已认证角色；评审 Y7）。
  `smtp.pass` = 授权码（密）；`host/port/user/to` = 非密（今天在 .env、运维需要肉眼核对）。
- **实现纪律**：通知写路径**不得复用** `PlatformConfigService.set()`（防顺手复用把通知值写进
  `platform_config`/进广播；照 pay 片 G3 先例，评审 G4）。
- protocol 新文件 `notify-channel.ts`（纯常量/类型，客户端可 import）：`NOTIFY_CHANNEL_KEYS`（九，
  顺序即管理页显示序）+ `NOTIFY_CHANNEL_SECRET_KEYS`（五：`smtp.pass` + 三 URL + `dingtalkSecret`）。

### D2 — 静态加密：**复用支付片加密设施**（主钥 = **已裁 Q2-A：复用 `PAY_CONFIG_ENC_KEY`**）

- 加密原语与形态**逐字复用**：AES-256-GCM、12B 随机 IV、AAD=键名、`v1:base64(iv|ct|tag)`、
  指纹 `sha256(规范化值)[:12]`；规范化 = `trim()`（通知值无 PEM 类变换；URL 不去尾斜杠——
  **凭据 URL 保持逐字**，避免任何改写）。
- **主钥（已裁 Q2-A：复用 `PAY_CONFIG_ENC_KEY`，2026-10-07）**：同一 config-service、同一 `.env`、
  同一备份伞 ⇒ 域分离的实际爆炸半径收益 ≈ 0，而用户侧要多生成/保管一枚密钥（丢钥才是真事故）；
  复用 ⇒ **备份剥离/恢复手册/既有判据（slice-07.5 判据 d）零改动**。代价 = 名字债，入台账
  （「未来触发 rename 时改为空间中性名」）。备选（新 `NOTIFY_CONFIG_ENC_KEY`）已裁否，在案见 §7。
- 实现形态：把 `pay-channel.crypto.ts` 泛化为**空间中立**的参数化原语（缺主钥文案按键空间传入），
  pay 侧导入点不动、行为逐字不变（单测全量复跑钉住）——偏离登记（「crypto 从 pay 专属提为共享」）。
- 主钥未设 ⇒ **通知键空间 fail-closed**（管理端点 503 / RPC `ok:false` / 消费端回落 last-good），
  config-service 其它面不受影响（照支付片 ⚙️3/§3.5 精神）。

### D3 — 专用下发通道：RPC `config.notifyChannel.get` + `NOTIFY_CHANNEL_PULL_TOKEN`

- 形态逐字照 `config.payChannel.get`：TCP 3106；载荷 `{pullToken, meta?}`；服务端
  `timingSafeEqual(sha256(a), sha256(b))` 常数时间比对；env 未设 ⇒ 一律拒（fail-closed）；
  响应 `RpcResult<{values: Partial<Record<NotifyChannelKey,string>>}>`（**仅已配置键**）。
- **令牌三持有**：config-service + alert-relay + am-renderer（新 env `NOTIFY_CHANNEL_PULL_TOKEN`；
  与支付令牌**分开**——最小权限面按键空间切）。⚠️ 标 `pullToken` 的日志脱敏已由
  `redact.ts:98-99` 段界规则覆盖（`pull[_]?token`），**无需**为新令牌加规则。
- 消费端获取策略（**与支付侧「每调用现拉」刻意不同**，理由见下）：
  - relay / renderer 均为**低频轮询**（**30s**，钉死常量，不做 env 旋钮——避免第二梯队「旋钮管理化」
    泥潭）＋启动首次拉取；失败 ⇒ **回落上次成功拉取的整图**（整图替换语义，`{}` 亦为有效图）；
  - 🔴 **为什么不是每投递现拉**：告警投递**恰恰发生在事故时**，此时 config-service 可能正不可达；
    告警链路对 config-service 的依赖必须是「无感」的 ⇒ 拉取只影响**配置更新延迟（≤30s）**，
    绝不影响投递本身。改动生效路径 = 保存 ⇒ ≤30s 内 relay 换槽 / renderer 重渲染 + reload。
- **last-good 持久化**（relay 侧）：拉到成功图后**按消费方裁剪**（relay 只保留 IM 四键——SMTP
  五键在 relay 进程内即弃、不落盘，收窄凭据持有面；评审 Y6）再原子写 `/data/notify-config.json`
  （600，新增小卷），重启时先读文件作为初值 ⇒ config-service 故障期间**重启 relay 不丢通道**
  （支付片的进程内回落在此不适用——告警丢投递的代价不对称）。renderer 侧**不需要**额外持久化：
  共享卷上的 `alertmanager.yml` 本身就是它的 last-good（拉取失败 ⇒ 不动文件，见 D4′ 启动序）。

### D4 — 消费端之一：**alert-relay 改造**（拉取驱动、槽位热更新）

- `config.ts` 的 env 装配退役，改由**拉取值 → 槽位派生**（纯函数，单测钉）：
  - 四键各自在场 ⇒ 对应槽位；**钉钉 URL/SECRET 必须成对**——半配 ⇒ **该槽位停用 + WARN**
    （**取代今天的「拒启动」**——运维语义变更，见 D7）；
  - **成功拉到的图**为空（或裁剪后无槽位）⇒ 零槽位 no-op 200（= 今天「明确未配」语义）；
    **从未成功拉到**（`lastGood===null`：首启且 config-service 不可达／`/data` 空或**文件损坏读失败**
    ——读失败 ⇒ WARN + 按 null 走；评审 r2-N3③）⇒ **500**——未知 ≠
    成功（回 200 会让 AM 记成投递成功不重投 = 假成功静默丢告警；偏离登记，评审 Y8）；
    `PORT` env 保留（本机调试用）。
- 30s 轮询线程（`setInterval` + 防重入；每轮 try/catch 收全，任何异常**不得**打穿常驻进程）；
  新图 ⇒ 重算槽位闭包并原子换引用（在途投递用旧闭包完成，天然不撕裂）。
- 日志纪律不变：只允许 sink 名与状态码（URL 绝不出现在 WARN/错误文案）。

### D4′ — 消费端之二：**am-renderer（新极小组件，已裁 Q1-E）**

- **单职责**：拉取通知图 → 渲染完整 `alertmanager.yml` → 原子写共享卷 → 内容变化时
  `POST http://alertmanager:9093/-/reload`（探针 1：默认可用、200）→ 失败保住旧文件。
- **渲染规则**（= 把今天 entrypoint.sh 的两态分支移植为 TS 纯函数 + golden 测试）：
  - 静态段（route/inhibit/group_wait 等）与 webhook 接收器恒在（逐字照 `alertmanager.yml.tmpl:14-29`
    + entrypoint 的 webhook 段）；
  - **SMTP 五项全在场** ⇒ 拼 `global.smtp_*` + `all`/`email`/`heartbeat` 的 email 成员；
  - **否则（含半配）⇒ 邮件段整段省略 + WARN**（心跳回落「已定义的空接收器」——与今天全空态同形）；
  - 值经 **JSON 字符串标量**输出（JSON 是 YAML 子集 ⇒ 引号/反斜杠/换行全量安全，是今天
    「拒含引号值」纪律的**上位替代**——fail-closed 从「拒绝」升级为「不可能生成坏 YAML」）；
  - 生成物 `amtool check-config` 预检（镜像多阶段 COPY amtool，探针 6）⇒ 通过才原子换入；
  - 「半配不应用」= 确定性期望态（store 即目标态，无历史依赖）；**拉取失败才保持旧文件**
    （last-good 的唯一边界）。
- **共享卷与权限**：新命名卷 `alertmanager-live`（挂载点 `/alertmanager-live`；renderer 读写、
  AM 只读 ro）；UID 对齐 65534（renderer 服务 `user: "65534:65534"`；**两个镜像都**预建
  `/alertmanager-live` 且属主 65534——卷初始化从首个挂载镜像的目录继承属主，`alertmanager-data`
  现役样本佐证（评审 #17 的条件）；文件 600 ⇒ AM 同 UID 可读。**AM 挂 ro ⇒ 结构上改不了自己的配置**。
- **日志纪律**：renderer 日志只允许键名/状态/错误类别——**不得**打印渲染产物、拉取响应或任何值；
  WARN 文案不含值（renderer 是唯一接触含口令完整 yml 的组件；判据 ⑪ 覆盖，评审 Y3）。
- **AM entrypoint 改造**（`entrypoint.sh` 重写为三件事）：等 `/alertmanager-live/alertmanager.yml`
  出现（有界等待，超时 ⇒ exit 1 响亮）→ `amtool check-config` → 写 `credentials_file`（token 照旧）
  → `exec /bin/alertmanager --config.file=/alertmanager-live/alertmanager.yml --storage.path=/alertmanager`
  （flag 仍全给，不转发 CMD——O3 纪律保持）。**SMTP 拼装/qquote-guard 整段退役**（迁 renderer）。
- **启动次序（评审 B1 修）**：renderer 起 ⇒ **仅当共享卷无 `alertmanager.yml` 时**落 baseline
  （SMTP 段省略 = 今天全空形态）；**文件在场 ⇒ 直接进入拉取循环**（成功 ⇒ 重渲染、内容变化才
  reload；失败 ⇒ **不动文件**）⇒ renderer 重启/重建**绝不降级卷上配置**。AM 单独重启
  （renderer 未起）：卷上**有**文件 ⇒ 立即可起；**全新卷 + 仅起 AM** ⇒ entrypoint 有界等待
  （超时 ⇒ exit 1 响亮）——两分支均钉（评审 r2-N3①）。
- **打包形态**：倾向 **alert-relay 包内第二入口**（`src/am-renderer.ts`，共享拉取客户端/常量，
  同一镜像 `command` 覆盖起第二个 compose 服务）——零新镜像、零新 Dockerfile（该形态下 compose 块
  **不得带 `build:`**、`image:` **逐字取与 alert-relay 相同的参数化表达式**
  `${IMAGE_PREFIX:-pokergame}-alert-relay:${IMAGE_TAG:-latest}`——该行不在 A11/A12 闸内，字面量形态
  会 conformance 全绿、服务器 `compose pull` 才响亮失败（迟；评审 r2-N2））；独立 Dockerfile 形态则将触发
  **A12「带 build 的服务恰好 14 个」+1**（`slice-07.2-deploy.ts:569-578`）。两形态各自的完整牵动面
  见核销表「新服务」行（评审 Y5）；**规格层按门禁实况钉死**。

### D5 — 管理面：新视图 + 掩码写 + 校验矩阵 + 权限（形态逐字照支付片）

- 三端点（`/api/admin/notify-channel[/:key]`，语义与响应形状逐字照 pay-channel）：
  `GET`（九项状态；密键 `value` 恒 null + `fingerprint` + **`hint`**（仅三 URL 键：host 命中三平台
  allowlist 时回 origin，否则「外部地址」；**host 全等匹配**（WHATWG URL 解析已小写归一）——防
  `endsWith`/`includes` 仿冒变体；读路径解密后现算，非存储列——评审 Y7/r2-N4））· `PUT`（覆盖写，
  非空；空串 400）· `DELETE`（清空；幂等 200）。
- 写面白名单 = `NOTIFY_CHANNEL_KEYS`（未知键 400）；错误序 401→400→503 照先例。
- **权限**（照 E′ 精神收口）：写面（PUT/DELETE）**仅 `super_admin`**（webhook URL 可冒充组织向群
  发消息、SMTP 授权码可冒名发信 ⇒ 与渠道凭据同级）；读面任意已认证角色（照 P8）。网关两处：
  policy 前缀两条（`/api/admin/notify-channel/`，PUT/DELETE ⇒ super_admin）+ 三条转发方法。
- **校验矩阵**（住 config-service，纯函数、失败 400、reason 不含值）：

| 键 | 规则（canonical） |
|---|---|
| `smtp.host` | 非空、无空白、≤253；`^[A-Za-z0-9.-]+$` |
| `smtp.port` | `^\d{1,5}$` 且 1–65535（存原文数字串） |
| `smtp.user` | 非空、无空白、≤254 |
| `smtp.pass` | 非空、**无换行/控制字符**、≤512（授权码；防粘贴事故） |
| `email.to` | 逗号分隔列表逐项校验（`^[^@\s,]+@[^@\s,]+$`；≤254×项）——保留今天 `to:` 直填语义 |
| 三 URL | `new URL()` 可解析 + `http(s)` + ≤2048；canonical = trim 原文（**不改写 URL**） |
| `dingtalkSecret` | 非空、无空白、≤256 |

- 管理页：顶栏新视图「通知通道」（读角色同支付视图：`super_admin|operator|finance`；写控件仅
  super_admin）：分两组渲染——「邮件（SMTP）」5 行 +「IM 通道」4 行；密键显
  `已配置 ✓ · 指纹 xxxxxxxxxxxx`（URL 键附 hint）、`smtp.pass` 输入框 `type=password`、
  其余单行 input；保存后提示「已保存；≤30 秒内生效」。完整性提示**客户端算**（邮件 5/5 ⇒「邮件通道：
  已就绪」；否则「未就绪（缺 N 项）」；钉钉 2/2 同理）——零新服务端面。

### D6 — 审计脱敏：复用 `config_changes`（第一页签）

- 逐字照支付片：key = 通知键名；**五密键**落 `{"redacted":true,"fingerprint":"<12hex>"}`
  （清空 new = JSON `'null'`）；四非密键落 JSON 字符串明文；不落任何密文/明文片段（判据同族）。

### D7 — 失败语义与等价表（含**两处显式偏离**）

| 面 | 今天 | 本片后 | 说明 |
|---|---|---|---|
| 邮件五键全空 | 邮件通道关闭、AM 照常健康 | **同**（renderer 输出省略邮件段） | 判据等价 |
| 邮件五键半配 | **AM 拒启动**（fail-closed 响亮） | **邮件通道关闭 + WARN + 完整性 gauge + 新告警规则** | 🔴 **偏离登记**：拒起退役（容器拒起与「动态配置」不相容）；响亮性由「`notify_config_group_complete{group="email"}` 0 + 告警规则 `NotifyEmailIncomplete`（10m）路由到 IM 腿」承接 |
| 钉钉半配 | **relay 拒启动** | 钉钉槽停用 + WARN + 同款 gauge/规则（`group="dingtalk"`） | 🔴 同上；relay 必须常驻投递其它通道 |
| 全空（**成功拉到的**空图） | relay no-op 200 / AM 无邮件 | **同**（零槽位/省略邮件段）；**从未拉到 ⇒ relay 500**（未知 ≠ 成功） | 判据等价 + 偏离登记（Y8） |
| 生效时效 | 改 .env + 重建容器（分钟级、需 SSH） | 管理页保存 ⇒ **≤30s**（轮询）+ reload | 增益（照支付片「下次调用生效」精神） |
| 「未配置」定义 | env 空串 | **行不存在**（PUT 拒空串；清空走 DELETE） | 同支付片 |
| 邮件呈现/路由 | AM 原生模板、心跳 email-only 24h | **逐字不变**（Q1-E；route/receiver 形态照旧） | 等价 |
| at-rest | 明文 .env（且进备份） | 九键全加密（DB）；`.env` 不再承载；**新增两处容器内明文落点**（共享卷 yml 含 SMTP 口令 · relay `/data` 仅 IM 四键）——600、命名卷、非宿主挂载，登记 | 净增益（备份剥离主钥沿用支付片；评审 Y6） |
| 权限 | .env = 服务器 root 面 | 写=仅 super_admin（管理页+审计留痕） | 增益 |

- **完整性 gauge**（config-service 现成 metrics 面，`main.ts:57` startMetricsListener 9006；共享
  `createGauge` 形态 = currency/payment 先例）：`notify_config_keys_configured{group}`（email=5 键、
  dingtalk=2 键）与 `notify_config_group_complete{group}`（1/0）；**采集 = 写路径现算**（`set()`/
  `clear()` 事务成功后 + 启动时一次重算；本键空间变更全经管理端点 ⇒ 值不漂移）——**不引入 scrape
  回调**：shared `createGauge` 无 collect 参数，且 collect 抛错会把整个 `/metrics` 打成 500（评审 Y2）。
  Prometheus 新增 2 条规则（`group_complete==0 且 configured>0` 持续 10m ⇒ warning；⚠️ `for:` 窗口
  内判据只能观测 **pending** 态——⑩ 照此钉）——**route 走默认 `all` ⇒ webhook 腿照达**
  （邮件腿挂了时 IM 腿仍在）。

### D8 — 生命周期：导入 / 轮换 / 备份 / 回滚窗（**与支付片的最大差异 = 有现役值要搬**）

- **一次性导入（本片特有）**：服务器 `.env` 现有真值 ⇒ 管理页手工填（推荐，值不再经手任何人）
  **或**服务器侧一行式脚本（读 `.env` 九行 → 登录 → `PUT ×9`；值不离开服务器——照支付片
  「已填过 .env 的情形」兜底片段的形态）。
- **回滚窗**：服务器 `.env` 九行**保留至验收通过后再删**；期间全量换 tag 回 v1.8.x ⇒ 旧镜像照读
  env（AM entrypoint 旧逻辑/relay 旧 env 装配都在旧镜像里）。⚠️ **必须走 `deploy.sh`/`rollback.sh`**
  ——送机 compose 取自**目标 tag**（`deploy.sh:102-111`）、九行 env 随旧 compose 一并回位；手工
  `IMAGE_TAG=v1.8.x docker compose up -d` 会拿新 compose（九行已删）**静默裸奔**（评审 G1）。**验收 = 真人项**（用户在场）：
  ①管理页填真值 ②触发一次测试告警 ⇒ **收到真邮件 + 真企微** ③轮换演练：企微后台重发 webhook ⇒
  管理页覆盖 ⇒ 指纹变化可见 ⇒ 再触发 ⇒ 收到新群消息。验收通过 ⇒ 删服务器/.本机 `.env` 九行 + compose 行。
- **⚠️ 导入窗口**：新镜像上线至导入完成的数分钟里，通道处于「未配置」= 无投递。手顺钉死
  「**部署后立即导入**」（文档加粗；窗口内真出告警 = 丢一条，可接受并登记）。
- **轮换**：任一条目 = 平台后台重新生成（企微/飞书/钉钉机器人重发 webhook；邮箱重开授权码）⇒
  管理页覆盖写入 ⇒ ≤30s 生效，**全程不重启任何容器**（≥今天「改 .env + 重建」）。
- **备份/恢复**（已裁 Q2-A ⇒ **零改动**）：backup.sh 已剥 `PAY_CONFIG_ENC_KEY` 行；拉取令牌照支付片
  惯例不剥；恢复手册不变。
- **泄露应对**：平台后台重发 webhook/重置授权码 ⇒ 管理页覆盖（旧值即废）；审计面可见操作历史。

### D9 — 判据计划（新 slice-23-notify-channel + 单测 + 既有片牵引）

**新 conformance 切片 `slice-23-notify-channel`（组草案；断言数 CI 回填 baseline）**：

| # | 判据 | 备注 |
|---|---|---|
| ⓪ | 管理面九键种子回读：顺序/标签/密键 value=null+指纹+**URL hint（allowlist 行为：非三平台 host ⇒「外部地址」；仿冒变体负例：`evilqyapi.weixin.qq.com` / `qyapi.weixin.qq.com.evil.com` 各一 ⇒ 不得回 origin）** | 种子在切片内 PUT（finally 全 DELETE 还原——conformance 默认零种子） |
| ① | RPC 拉取：正令牌 ⇒ 九键图；错/缺令牌 ⇒ 10002；未配置键缺省；主钥缺 ⇒ 10007 | `lib/rpc.ts` 直连 3106 |
| ② | 不进广播：`config.snapshot` 无 `notify.` 子串 + 恰 34 键；`/api/config` 恰 14 键；relay/renderer/AM **容器 env 无九键**（防回流） | `containerEnv` |
| ③ | 静态加密：DB `value_enc` 全 `v1:` 前缀、无任一值明文子串 | `mysqlScalar` |
| ④ | 审计脱敏：五密键 redacted 对象（无原文子串、含指纹+actor）、四非密明文、清空 new=JSON 'null' | 同支付片 ④ 形态 |
| ⑤ | 权限矩阵+变体：四角色×PUT/DELETE ⇒ 仅 super_admin 过；`%2E`/大小写/尾斜杠变体 ⇒ 403/404；GET 读面矩阵 | 照 slice-22 ⑧ |
| ⑥ | **relay 端到端（真栈）**：PUT wecom/feishu ⇒ stub 收到；改 URL ⇒ 下一轮按新图；DELETE ⇒ 停止投递；钉钉半配 ⇒ 该槽不投+WARN；全清 ⇒ no-op 200 | 触发 = AM API 注入合成告警（探针 5 已验证）；stub 照 slice-16 内联形态 |
| ⑦ | **AM 渲染端到端（真栈）**：PUT SMTP 五键 ⇒ ≤窗口后 ①共享卷 yml 逐字含值（docker exec grep -F，容器内断言不外印）②`GET /api/v2/status` 显示 `smtp_smarthost/smtp_from/to` 且密码为 `<secret>`；删一键 ⇒ 邮件段消失（baseline 态）；全程 `amtool check-config` 绿 | 探针 4 的断言面；**不做 SMTP 会话级 E2E**（探针 5 登记）；**邮件「完整但坏」（值错/连不上）不在本判据面**（今天亦零断言）——实时信号 = AM 日志/`alertmanager_notifications_failed_total`（可加规则），真人验收覆盖，入台账（评审 G8） |
| ⑧ | 回落：停 config-service ⇒ relay 照常投递（last-good）、**重启 relay 仍 last-good**（持久化判据）；**重建 renderer ⇒ 共享卷 yml 逐字不变 + `/api/v2/status` 的 AM 配置不变**（B1 形态，relay/renderer 两侧同覆盖）；**从未拉到 ⇒ relay 500（非 200）**；AM baseline 仅「卷无文件」时出现；**`/data/notify-config.json` 内容断言**（含 IM 四键、**无 `notify.smtp` 子串/无 SMTP 任一模态值**——容器内断言、值不外印；评审 r2-N1） | compose recreate 先例 |
| ⑨ | fail-closed：主钥 unset 重建 config-service ⇒ 管理面 503 / RPC 10007 / 消费端保持 last-good；34 键面与其它服务不受影响 | 支付片 ⑨ 形态 |
| ⑩ | 完整性 gauge+规则：半配 ⇒ `notify_config_group_complete{group="email"}=0`（9006 `expose` 无宿主口——**exec+Bearer 读法照 slice-16 C1**）；Prometheus **`/api/v1/alerts`**（全仓新面 0 先例）见 `NotifyEmailIncomplete`，**断言 state ∈ {pending,firing}**（`for:` 窗口内=pending）+ 负例（另造 alertname 不命中） | 新增面（评审 Y1） |
| ⑪ | 日志无凭据：三容器（relay+renderer+config-service）日志 grep **九值（含 URL 子串）+ `NOTIFY_CHANNEL_PULL_TOKEN`** 全空 + **窗口正向对照**（必含本次 run 产生的某行）+ 判别力自证（合成一行喂 grep 必中） | 照 slice-22 ⑦（:855-859,865；评审 Y3） |

**单测（config-service + alert-relay + renderer）**：校验矩阵九键表驱动；槽位派生纯函数（含半配矩阵）；
yml 渲染三态 golden（全空/半配/全配；含引号/反斜杠/换行值的安全性用例）；拉取客户端（进程内 stub
TCP server）；last-good 原子写/读 + **裁剪用例**（落盘仅含消费方键集；评审 r2-N1）；reload 客户端
（stub HTTP）；crypto 泛化后 pay 侧回归全量复跑。

**既有面牵引（核销表草案，规格层逐条冻结）**：

| 面 | 文件（现状行） | 处置 |
|---|---|---|
| relay env 装配 | `alert-relay/src/config.ts:81-104`·`server.ts:43-74,209-231` | 退役，改拉取驱动；**`test/config.test.ts:57-86` 半配拒起三态 → 槽停用+WARN 改写（真身在单测，非 slice-16；评审 Y4）** |
| slice-16 relay 组 | `slice-16-monitoring.ts:472-494,763-798,858-861` | 注入机制改「stub 拉取源」+ 就绪语义改「**有界等首次拉取成功**」（`/health` 200 ≠ 槽位就绪；评审 G5）；规则数 **23→25 三处同改**（EXPECTED_RULES:89-100 + :599 promtool + :662 计数；评审 G2） |
| slice-16 静态面 | `:1180-1188`（SERVICES=14）/ down 行 | renderer 若计入服务清单则同提交核（规格层钉打包形态后定） |
| **新服务（am-renderer）双形态** | `slice-07.2-deploy.ts:569-578`（A12）/`:970-981`（LOG_LIMIT_TARGETS）·`conformance-stack.sh:213`·override·compose | **共享镜像形态**：块**无 `build:`** + `image:` 显式指 relay 镜像（A12 不动）；**独立镜像形态**：A12「恰好 14 个带 build」+1（A11/重渲染派生面随之）。**共同**：`LOG_LIMIT_TARGETS` +1（不加不红=静默失明）、conformance-stack down-rm 名单 +1、override `profiles: ["monitoring"]` 块、relay **`/data` 卷**入 compose 行（评审 Y5）；可选小断言：slice-07.2 两形态渲染下 `renderer.image === relay.image`（r2-N2） |
| AM entrypoint/tmpl | `deploy/monitoring/alertmanager/entrypoint.sh`·`alertmanager.yml.tmpl` | 重写：等文件→预检→exec；拼装逻辑迁 renderer（TS 重实现 + golden） |
| AM Dockerfile | `Dockerfile.alertmanager` | 卷目录/权限；CMD 的 flag 面 | 
| compose | `docker-compose.yml:766-770,873-876` + 新服务块 + volumes | 删九行 env + **两处注释（:762 / :866-867「半配拒起/槽位=env 非空」）改写**；加拉取令牌/服务地址；新 am-renderer 服务 + `alertmanager-live` 卷 + relay **`/data` 卷**；config-service 段加令牌；独立镜像形态时 **compose 头 R1303「14 个」计数同步**（r2-N2） |
| slice-07.2-deploy | env 渲染断言面 | 九行删除/新增逐条核（只增不减） |
| slice-07.5-backup | 判据 d（:1448 起） | **零改动**（已裁 Q2-A：复用主钥） |
| protocol | `rpc.ts:107` 邻位 + `messages.test.ts:53-70` + `index.ts` | RPC_PATTERNS 新增 `config.notifyChannel.get`（全量 toEqual ±1）；新 `notify-channel.ts` 导出 |
| config-service | 迁移/`notify-channel/`/rpc controller/module/metrics | 照 pay-channel 逐件（crypto 泛化） |
| 网关 | `admin-policy.ts:245-253` 邻位·`gateway.controller.ts:166-209` 邻位 | P-n1/P-n2 + 三转发方法 |
| 管理页 | `admin/index.html:33-44,97-103`·`app.js:357-395,3050` 邻位 | 新视图（VIEWS 条目 + 懒加载 + 行构建） |
| 管理页机械针脚 | `slice-19-admin-rbac-audit.ts:1451-1465` | G12 **+3 needle**（`notify-channel-view` / `nav-notify-channel-btn` / `通知通道`）；VIEW_ORDER(:396) 与「十视图」注释 ×4（:351,731,788,3048）随动（文案类；评审 Y9） |
| redact | `shared/src/logging/redact.ts:98-99` | 扩展按 **`notify.` 前缀命名空间**（或键名枚举）收口；⚠️ **勿用 `(^|[._])url$`**——抓不到 camelCase `wecomUrl` 且会吞 `REDIS_URL`/`DOUZERO_URL`/裸 `url`（评审 G3 实测）；用例只增不减 |
| Prometheus | `deploy/monitoring/prometheus/rules/ftl-alerts.yml` | +2 规则（D7）；slice-16 三处 23→25 见「slice-16 relay 组」行 |
| conformance 基建 | `conformance-stack.sh`·`run.ts:130-131`·`baselines.json` | 新 env 供给点（`??=` + export）；slice-23 注册（CASES 末尾 + baseline 回填）；**无默认种子** |
| design-md 闸 | `design-md-ai-rollout.gate.test.ts:90-117` | NEW_ENVS +`NOTIFY_CHANNEL_PULL_TOKEN`；RETIRED_ENVS +九键（防回流保护） |
| `docs/design.md` | :171-207 §2.3·:1122-1208 §7.5·:514/:622 §4.2·**§4.3 重试/降级表**·:1537 §10.3 | 新增通知键空间小节（照 :1196-1207 支付先例）；RPC 表新边 = **§4.2 签名块 + §4.3 表两处**（:622-623 先例；评审 G6）；§2.3 行 |
| `docs/ops/first-deploy.md` | :248-258 键表·:1171-1286 监控节·（新）通知上线节 | 键表九行删、改指管理页；「怎么加/换通道」重写为管理页操作；**「两条硬规则」段（:1216-1219）与 :253/:255 逐条改写**（评审 Y4）；新增「通知怎么上线（三步）」（照「支付怎么上线」:1384-1412 形态） |
| 新运维文档 | `docs/ops/notify-onboarding.md`（提案） | 平台取址指引（企微/飞书/钉钉）+ 安全增益 + 轮换 + 验收（照 alipay-onboarding 形态） |
| deviation-ledger | `docs/superpowers/plans/deviation-ledger.md` §N | 新条：半配拒起退役（双向）/entrypoint 拼装迁 renderer/原地 reload 机制/last-good 持久化（含「从未拉到 ⇒ 500」）/按消费方裁剪拉取图/crypto 泛化/主钥名字债/邮件「完整但坏」不在判据面 |
| gitleaks | `.gitleaks.toml` | 若夹具含类真实 webhook URL 形态，须允许清单（防 feishu token 默认规则误伤） |
| `.env`（服务器+本机） | — | 验收后删九行；回滚窗纪律入文 |
| baselines.json | :38-39 | 新片回填（照近例） |

### D10 — 部署 / 迁移 / 回滚

1. **顺序**：打 tag（前置=push master，R1308 纪律）→ 部署新镜像 → **立即导入九值**（管理页或脚本）
   → 触发测试告警验收（真邮件+真企微）→ 轮换演练 → 观察 → （用户裁决后）删 `.env` 九行。
2. 全程**无开关**（通知通道是现役设施，不是暗上线对象）；风险面由「导入窗口数分钟」+ 回滚窗承接。
3. **回滚**：经 `deploy.sh`/`rollback.sh` 全量换 tag v1.8.x（**送机 compose 取自目标 tag** ⇒
   九行 env 随旧 compose 回位；手工命令形态禁用——评审 G1）；新表数据留存无害；新容器/卷可留
   （不参与旧版运行）。

## 4. 兼容面与混部

| 组合 | 行为 | 测法 |
|---|---|---|
| 新 config-service + 旧 AM/relay（无新渲染/拉取） | AM 照旧读 env 五键、relay 照旧读 env 四键 ⇒ **稳态零影响**；新表空置 | 只能推理（工具链全量换 tag，禁手工混部） |
| 旧 config-service + 新 renderer/relay | RPC 无 handler ⇒ 拉取失败 ⇒ last-good（盘/卷上有）或 baseline（**renderer** 首启且卷空）；**relay 首启且 `/data` 空 ⇒ 500**（⑧）（通道 = 未配置形态） | 重建期瞬态以秒计；禁止稳态混部 |
| 新全套 + `.env` 九行仍在 | 无消费者读它们（防回流判据 ② 钉死） | slice-23 ② |

## 5. 明确不做（YAGNI）

- 第二梯队节奏旋钮（`*_INTERVAL_MS` 族）与第三梯队 `GRAFANA_ADMIN_PASSWORD`——**按点名搬，本片不搬**。
- 推送式下发（Redis pub/sub 无鉴权、at-most-once——支付片弃案 B 同论）；per-service 拉取身份体系（独立立项）。
- SMTP TLS 可调（`require_tls`/跳过校验等）——**照今天逐字钉死 `true`**；邮件模板/聚合参数/路由结构零改动。
- 多收件人**新机制**（`email.to` 逗号列表仅保留今天直填语义，不做多行/分组）。
- 通知历史/重投面板、告警静默管理入管理页（AM 原生 UI 已够，且不在本片题域）。
- 飞书/钉钉接入的额外编排（配置即启用，无开关）。

## 6. 风险（草案）

1. **导入窗口丢告警**（数分钟）——手顺钉死「部署后立即导入」+ 回滚窗；（登记）。
2. **AM 重载语义依赖**（探针 1–3 已实证；规格需把「reload 200 才算生效、500 保旧」写成 renderer 的
   显式状态机 + 判据 ⑦）。
3. **半配语义迁移**是本片最大行为偏离——两类消费者（relay/renderer）与两条 gauge/规则必须同批落，
   否则「响亮的失败」被静默化（核销表逐条核）。
4. **relay 改造面较大**（env→拉取）：既有单测/slice-16 断言全部牵引——执行期最可能出「跑得起来吗」级
   问题的面；单测先行（拉取客户端/槽派生/半配矩阵）。
5. UID/卷权限（65534 对齐、卷初始化属主）在 Windows/WSL 本机与服务器行为需真栈实证（首个重建即验）。
6. **两处新明文 at-rest**：共享卷 yml（含 SMTP 口令；AM 侧 ro）+ relay `/data` last-good（**仅 IM 四键**，
   按消费方裁剪后落盘）——皆 600、命名卷、非宿主挂载，登记残余（评审 Y6）；AM web 面 `/-/reload`
   无鉴权（**今天即如此**）——内网信任模型同级，登记；URL `hint` 回显面已按 allowlist 收口（D1/Y7）。
7. `POST /api/v2/status` 断言面是「实现细节接口」——以 amtool 版本为锚钉住，字段缺失时判据响亮失败（不静默跳过）。

## 7. 产品问与裁决（**2026-10-07 已裁，在案**）

> 两问均按「推荐」口径裁决（用户 2026-10-07 于开工日集中裁定）；下述为在案记录（问题 + 选项 + 裁决结果）。

**Q1｜AM 邮件链路的配置下发架构** → **裁决：E：renderer 侧车**。邮件仍在 AM 原生发出（模板/呈现/
路由/心跳语义零变化，邮件腿不依赖 relay 存活）；新增极小渲染组件（渲染 yml → 共享卷 → `/-/reload`，
本日探针已全实证）；代价 = 多一容器 + 一共享卷（接受）。
（未选 D：relay 收编邮件——邮件呈现改变 + 邮件腿依赖 relay + 告警关键路径新写 SMTP 客户端。）

**Q2｜通知键空间主钥** → **裁决：A：复用 `PAY_CONFIG_ENC_KEY`**。同服务/同 `.env`/同备份伞 ⇒
域分离实际收益 ≈ 0；用户零新增仪式（少一枚要保管的密钥）；备份剥离/恢复手册/slice-07.5 判据零改动。
**名字债入台账**（未来触发 rename 时改空间中性名）。
（未选 B：新 `NOTIFY_CONFIG_ENC_KEY`——命名更干净但多一枚密钥行 + 剥离模式扩展 + 判据 d 再改造。）

## 附录 A — 九键逐条（旧 → 新；含"怎么拿"指引去向）

| 旧 env | 新键 | 密 | 今天在哪/怎么拿（改后指向管理页） |
|---|---|---|---|
| `SMTP_HOST` | `notify.smtp.host` | 否 | 邮箱服务商 SMTP 主机（如 `smtp.qq.com`） |
| `SMTP_PORT` | `notify.smtp.port` | 否 | 465（163/QQ 授权码体系） |
| `SMTP_USER` | `notify.smtp.user` | 否 | 邮箱地址 |
| `SMTP_PASS` | `notify.smtp.pass` | **是** | 授权码（非登录密码） |
| `ALERT_EMAIL_TO` | `notify.email.to` | 否 | 收件地址（可与 user 同） |
| `FEISHU_WEBHOOK_URL` | `notify.webhook.feishuUrl` | **是** | 群设置→机器人→自定义机器人→webhook |
| `WECOM_WEBHOOK_URL` | `notify.webhook.wecomUrl` | **是** | 群机器人→复制 webhook（现役） |
| `DINGTALK_WEBHOOK_URL` | `notify.webhook.dingtalkUrl` | **是** | 智能群助手→自定义→勾「加签」→webhook |
| `DINGTALK_SECRET` | `notify.webhook.dingtalkSecret` | **是** | 同上加签密钥（与 URL **成对**） |

## 附录 B — 硬要求对位表（照支付片附录 C 形态自检）

| 要求 | 落点 |
|---|---|
| ① 加密存储 | D2（复用设施；主钥=Q2） |
| ② 不进广播 | D1（独立表，结构性）+ D3（专用拉取+令牌）+ D9-② |
| ③ 管理页不回显原文 | D1/D5（五密键 value 恒 null + 指纹 + URL `hint`（三平台 allowlist 收口）） |
| ④ 审计脱敏 | D6（D9-④） |
| ⑤ 轮换/泄露/回滚窗 | D8（含**现役值导入**——本片特有条目） |
| ⑥ 权限 | D5（写面仅 super_admin；D9-⑤ 变体负例） |
| ⑦ 契约冻结面 | D7 等价表 + 两处显式偏离 + D9 核销表 |
| ⑧ 日志面纵深 | D4 纪律 + `redact.ts` 扩展 + D9-⑪ 判据（含判别力自证） |

## 附录 C — 待规格层钉死的开放点（本稿刻意留给规格，不是 TBD 设计问）

1. renderer 打包形态（同镜像第二入口 vs 独立 Dockerfile）——按门禁实况（A12/R1303/SERVICES/C14）二选一（两形态牵动面见核销表「新服务」行）。
2. `redact.ts` 段界扩展的**保守面**逐字（哪个正则、防吞哪些正常键名；评审 G3 已给形状）。
3. renderer/reload 状态机的**逐字状态转移表**（含 500 保旧、连续失败计数是否告警）。
4. 完整性 gauge 的名字/标签与两条规则逐字（**采集已钉=写路径现算**；`for:` 窗口与判据 ⑩ 的 pending 口径随之钉）。
5. slice-16 各组的具体改造清单（同提交核）与新 slice-23 断言数（CI 回填）。
6. `notify-onboarding.md` 是否独立成文 vs 并入 first-deploy（倾向独立，照 alipay 先例）。
