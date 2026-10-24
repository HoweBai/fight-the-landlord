# 支付配置管理化（渠道凭据进管理面）**设计层 v2.2（冻结）**

> **上游**：开工交接 `docs/superpowers/plans/2026-10-06-payment-config-admin-manage.md`（用户裁决 2026-10-06）。
> **状态**：**v2.2 冻结**（2026-10-06）——产品问 4 条已获裁决（§1.1 D–G）、E′ 复审修订在案；
> **评审 r1**（1 阻断 + 7 🟡 + 9 🟢）与 **r2**（零阻断 + 1 🟡 + 4 🟢，含 Express 变体探针实测）全部处置收口；
> r2 结论「**可通过（设计冻结）**」。报告：`.superpowers/sdd/2026-10-06-pay-config/review-design-r{1,2}.md`。
> **本片一句话**：把支付渠道六项凭据从服务器 `.env` 搬进 config-service 的**独立加密存储**，经
> **专用拉取通道**（不进广播快照）下发到 payment-service，管理页新增「支付渠道」块做**掩码写**
> （私钥只写不可读）、审计脱敏；`.env` 只剩根信任锚与部署拓扑。

---

## 0. 一句话

**六项凭据**（`ALIPAY_GATEWAY_URL` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` /
`ALIPAY_SELLER_ID` / `PAY_PUBLIC_BASE_URL`）→ config-service 新表 `pay_channel_config`（AES-256-GCM 静态加密）
→ 新 RPC `config.payChannel.get`（支付服务**专属拉取**，每次渠道调用现拉 + 失败回落）
→ 管理页「支付渠道」视图（非密五项明文可读，**私钥只写不可读、只回指纹**）→ `config_changes` 审计脱敏。
**业务九键（26–34）不动、客户端 14 键不动、`CONFIG_KEYS` 34 键不动。**

## 1. 输入

### 1.1 用户裁决（逐条，本文全部设计不得与之冲突）

| # | 裁决（2026-10-06） | 本文落实 |
|---|---|---|
| A | 「**全面管理化**，包括当前 .env 中的其它配置，能管理化就管理化。」（交接 §0；即：支付相关配置尽量管理页可管，其它 .env 项盘点搬） | 六项落实为本片主体；**其余 .env 逐项盘点见附录 A**（可搬/不可搬+理由），**范围已裁（D 行=收敛六项）** |
| B | 安全硬要求七条（交接 §2，缺一即阻断级） | ①加密→D2 ②不进广播→D1/D3 ③掩码写→D4 ④审计脱敏→D5 ⑤轮换/泄露入册→D6 ⑥权限→D4 ⑦契约冻结面不动→D7 |
| C | 流程纪律（交接 §4）：一条龙；密钥不进日志/不出站；判据同提交；「跑了」指向本次日志；真栈回归；假红先单跑 | §6 判据计划 + §8 风险；规格/计划层承接 |
| D | **Q1 范围裁决：收敛六项**——其余 `.env` 只出盘点清单留档（附录 A），下片按点名搬 | §5 YAGNI 相应收口 |
| E | **Q2 权限裁决**（原版：私钥仅 `super_admin`、非密五项 `super_admin\|operator`）→ **E′ 复审修订（2026-10-06）：六项写面全部仅 `super_admin`**（operator 只读） | D4 角色表定稿（E′） |
| E′ | 修订由来：评审 r1 实测「支付宝公钥 = 回调验签唯一信任锚」（`notify.service.ts:143-153`）——operator 可写 ⇒ 可自签伪造回调入账（铸币）；原「半公开」分类系误判，经用户复核收紧 | 设计注记：将来若对渠道写面再引入角色分权，必须同时引入**按键字面路由**+变体负例（B1 教训入台账） |
| F | **Q3 主钥与备份裁决：备份剥离主钥**（v1 = env 单钥；`backup.sh` 打包 `.env` 时剔 `PAY_CONFIG_ENC_KEY` 行） | D6 定稿 + D8 增判据 + D9 slice-07.5 牵引 |
| G | **Q4 轮换验收裁决：要，真人验收项**（打 tag 后、开开关前；需用户在场产生证据） | D6/D10 落点 + D9 first-deploy 验收节 |

### 1.2 既有约束（本仓纪律，逐条适用）

- **结构性封死优先于纪律性封死**（片⑦先例：不进广播的东西要"结构上不可能进"）。
- **判据只增不减**；既有契约（15001 语义、每调用取值的时效）搬运后**等价**（硬要求 B⑦）。
- **审计六源命名不得混称**（实测订正）：`config_changes` = 管理页审计**第一页签**「配置变更」；
  「第六源」= 支付处置流 `/api/admin/pay/actions`（`admin/app.js:64`、`admin-pay.controller.ts:785`）。
  渠道变更审计**进第一页签**，不是新源。
- 本仓无 `.codegraph` 索引；文档/判据证据一律 file:line。
- 🔴 **路径归一化变体是本仓已咬三次的形态**（N1 尾斜杠越权 / ⚙️20 大小写变体旁路 / 评审 B1 %-编码变体）——
  凡「按路径/按键分权」必须**结构封死**（单角色或字面路由）+ 变体负例入判据；网关 policy 匹配的是
  **未解码原值路径**而 Express 路由参数**已解码**（`gateway.controller.ts:135-139` R75 在案）。

## 2. 现状（实测事实，带出处；三路探查汇总）

### 2.1 支付六项今天的形态

- **一份 `.env` 全栈共用**（根 `.env` gitignore；服务器 `/srv/pokergame/.env`），compose 以
  `${VAR:-}` 空串透传（`docker-compose.yml:352-365`）；测试值由 `conformance-stack.sh:46-53` export
  （fixture = `tools/conformance/fixtures/alipay-test/*.pem`，**仓内测试件**——生产值才是服务器侧/仓外）。
- **每次调用现读 env**：`channel/alipay/client.ts:245-252` 的 `readConfig()`（经 `callApi()` 首行 :287；
  createPayUrl/query/refund/close 四方法全走）；回调侧 `notify/notify.service.ts:143/156/165`
  现读公钥/APPID/SELLER_ID。**「未设定语义」= 冻结契约**，逐键清单见 D7 表。
- 🔴 **服务器 `.env` 进每小时备份**：`scripts/ops/backup.sh:181-185` 打 `env-<name>.gz` ——
  今天**私钥明文在备份里**（设计前提之一，D6 处理）。
- 仓库内无私钥值（生产值只在服务器；`PAY_CONFIG_ENC_KEY` 全仓 0 命中——全新建）。

### 2.2 配置中心（进广播的既有面）

- 注册表 = `protocol/src/config.ts:14-74`：**纯字符串数组**，无敏感性/作用域字段；客户端子集
  `CLIENT_CONFIG_KEYS`（14 键，:77-93）。写入校验唯一入口 = `parseConfigValue`（:146-175 分派）。
- 存储 `platform_config`（`key/value` **明文 JSON**/`version`/`updated_at`/`updated_by`）。
- 🔴 **广播 = 全键推全服务**：写库同事务后 `PUBLISH config:changed {keys}`（`platform-config.service.ts:175-185`）
  → 5 个消费服务收到提示后**全量重拉** `config.snapshot`（`config.rpc.controller.ts:31-46` 原样返回
  全部 34 键，**无按服务过滤**）+ 60s 安全网。⇒ 密钥若进 `platform_config` = 结构性泄漏到
  全部 5 个服务的进程内缓存与日志面。**这是「专用下发通道」的根源题。**
- 管理面：`GET/PUT /api/admin/config*`（`admin.controller.ts:182-212`）；`config_changes`
  （`AdminRbac.ts:57-68`：id/key/old_value/new_value/actor/created_at）**落原文**，写点
  `platform-config.service.ts:163-170`（与值写入同事务）。
- 全仓**无任何 AES/静态加密实现**；可借鉴件：`admin-password.ts`（scrypt 零依赖模式）、
  `alipay/sign.ts`（RSA2）、`decodePem`（`client.ts:95-100`）。

### 2.3 管理面权限与网关（新写面的落点）

- 四角色 = `super_admin|finance|operator|viewer`（`admin-policy.ts:25`）。**授权全在网关 policy**
  （P1–P9 + P-r* + P-p* 显式枚举，未登记写路径 fail-closed 403）；config-service 只认
  `x-internal-token` + `x-admin:1` + `x-admin-actor`（零 JWT/RBAC）。
- 先例：`PUT /api/admin/config/:key` ⇒ `super_admin|operator`（P4）；**其余 GET ⇒ 任意已认证角色**（P8，
  viewer 可读全部 34 键）。网关对 admin 路由是**显式转发方法**（`gateway.controller.ts:126-155`），
  新端点 = 新转发方法 + 新 policy 条目（**两处都要，缺一 404/403**）。
- 管理页 = 无构建静态页（`admin/index.html` + `app.js`），门口托管；`slice-19` G12 断言线上
  `app.js` 逐字等于仓库文件（改页面 ⇒ 必须 build edge + 上镜像）。

### 2.4 探针与夹具（判据可行性）

- `tools/conformance/src/lib/rpc.ts`：**零依赖 TCP RPC 探针已存在**（node:net，长度前缀+`#` 分隔，
  game 3103/robot 3105 先例）⇒「快照面无渠道键」可直连断言。
- slice-21 ⓪ 组（`:520-537`）现断言「容器 env 实读 ALIPAY_* / PAY_SCAN_*」（`containerEnv` helper）⇒
  **本片必改的夹具点**（D8）。

## 3. 设计决策

### D1 — 归属与隔离：渠道凭据 = config-service 的**第二键空间（独立表）**，结构上不进广播

- **归属**：新表 `pay_channel_config`（config-service 自己的迁移建表；同 MySQL 实例）。六键**不入**
  `CONFIG_KEYS`、**不入** `platform_config`。
- **结构性理由（本片第一决策）**：快照 = `list(platform_config)`（`config.rpc.controller.ts:31-46`）
  ⇒ 独立表**在代码路径上不可能**被广播带出；`/api/config` 客户端面 = `CONFIG_KEYS` 交集 ⇒ 同样结构不达。
  34 键面 12 处硬断言（附录 B）**全部不动**。
- **弃案 A（同表 + `sensitive` 列 + 快照过滤）**：过滤点乘 3（快照 RPC / 管理 GET / 客户端交集），
  任一漏 = 密钥进 5 服务缓存；且 12 处 34 键断言全部进改动面，**收益为零**。
- **弃案 B（专用 Redis 频道推送）**：pub/sub 无鉴权（任何服务可 SUBSCRIBE）+ at-most-once 无投递保证，
  与硬要求 B② 正面冲突，且与「每调用取值」语义不合。
- **键名**（规格层逐字冻结；本文提案）：`pay.channel.gatewayUrl` · `pay.channel.appId` ·
  `pay.channel.privateKey` · `pay.channel.publicKey` · `pay.channel.sellerId` ·
  `pay.channel.publicBaseUrl`。protocol 导出 `PAY_CHANNEL_KEYS`（六）+ `PAY_CHANNEL_SECRET_KEYS`
  （一：私钥）两个**纯字符串常量**（客户端可 import，无副作用；**不**进 `CONFIG_KEYS`）。

### D2 — 静态加密（at-rest）：AES-256-GCM，主钥只在 config-service

- **算法/格式**：AES-256-GCM；每值随机 12B IV；存储 `v1:<base64(iv|ct|tag)>`；**AAD = 键名**
  （把密文绑死到所在行，防跨行互换）。指纹 = `sha256(规范化值)[:12]`（hex）。
- **规范化**：密钥类入库统一为 **base64(PEM) 单行**（= 今天 env 的格式，`decodePem` 消费面零改动）；
  管理面输入**接受 PEM 原文或 base64 两态**（服务端归一 → 省掉操作者 `base64 -w0` 一步，非运维用户友好）；
  指纹对规范化值计算。
- **六项统一加密**（不区分机密与否）：写/读单一代码路径，消灭「哪些列是明文」的判断面；
  机密标记只决定 **UI/审计/日志**语义（D4/D5）。
- **主钥** `PAY_CONFIG_ENC_KEY`：`base64(32B)`，**只配在 config-service**（env + compose 透传）。
  **未设/非法 ⇒ 支付渠道块 fail-closed**（管理端点 503 + RPC 报错 ⇒ 支付侧走回落/15001），
  config-service 其它面（34 键/客户端/审计）不受影响（懒校验，**不阻塞启动**——照 ⚙️3 精神）。
- **表形状（设计层给形状；规格层逐字冻结 DDL，迁移号顺排 `1792000000000-PayChannelConfig.ts`）**：
  `pay_channel_config(`key` varchar(64) PK · value_enc text NOT NULL（`v1:` 前缀密文） ·
  fingerprint char(12) NOT NULL · updated_at datetime(3) · updated_by varchar(64))`；
  **无 version 列**（无广播/无缓存失效需求；updated_at 足够，YAGNI 登记）。
- **主钥轮换 v1 不做**（YAGNI，§5 登记：轮换 = 停机手工重加密）——但**主钥与备份的处置**是 §7-Q3
  （默认建议：备份剥离该行）。

### D3 — 专用下发通道：**每调用拉取 + 失败回落**（pull-only；不进任何广播）

- **RPC** `config.payChannel.get`（TCP 3106，信任面与 `config.snapshot` 同级）→ config-service
  **解密后**返回 `{values: {<键名>: <值>}}`（**仅已配置键**；值 = 今天的 env 格式）。规格冻结方法名。
- **专用拉取令牌**（新 env `PAY_CHANNEL_PULL_TOKEN`，**仅 config-service + payment-service 持有**）：
  RPC 载荷携带，config-service 常数时间比对，不匹配 ⇒ 拒。**理由**：没有它，内网任何服务（共享
  `INTERNAL_SERVICE_TOKEN`）都能拉到私钥明文——今天私钥只在 payment-service 容器 env 里，**这是信任面收窄手段**
  （「专用」= 别人拿不到）。缺令牌 ⇒ config-service 拒拉（fail-closed）。
  - ⚠️ **登记残余**：明文仍随内部网络每调用传输一次；内网嗅探（需容器 root/CAP_NET_RAW）可见——
    与片⑦内网信任模型同级，**不做服务间逐跳加密**（YAGNI 登记）。「按服务身份」的完整可见性机制
    需要 per-service token 体系，不属本片（§5）。
- **payment-service 侧**（新 `PayChannelConfigService`，挂在 `src/config/` 现有模块内）：
  - **每次渠道调用现拉**（与今天 `readConfig()` 每调用读 env 同构；createPayUrl/query/refund/close +
    notify 验签三读点全走它）；**超时 1s**（热路径专用，短于快照客户端 3s 先例 `config.client.ts:92-110`；
    不重试）；**`.send()` 必带 `...metaFromTrace()`**（traceId 过 RPC 既有契约，先例 `config.client.ts:132-134`；
    机械闸 `room-service/test/meta-on-every-rpc-send.gate.test.ts` 扫描面含 payment——评审 Y3b）。
  - **失败回落**：拉取失败 ⇒ 用进程内**上次成功值** + 一条 WARN（NDJSON）；**从未成功过** ⇒ 视同「未配置」
    ⇒ 走 D7 表各键既有语义。🔴 **成功拉取 = 整图替换缓存**（缺席键即「未配置」；回落只发生在失败路径）——
    防 merge 实现让 DELETE 在进程存活期内不生效（评审 Y4）。
  - **刻意差异登记**：今天「读 env 不可失败（只有未设）」；新「可失败 ⇒ 回落」。回落是**新增可用性**：
    config-service 短故障不影响已配置渠道。代价 = 明文在内部网络存在传输面（见上）。
- **为什么不是推送**：弃案 B 同 D1（无鉴权频道 + 投递保证问题）；且拉取天然满足「轮换下一次调用即生效」。
- **为什么 payment-service 不直读 DB**：跨服务直读他服务表破坏边界（且密文+主钥分离后它也解不开）。

### D4 — 管理面：新端点 + 掩码写 + 校验器落点 + 权限

- **端点**（命名避开 `/api/admin/pay/*`〔payment-service 命名空间〕与 `/api/admin/config/*`〔P4 前缀陷阱〕）：

  | 端点 | 语义 | 响应 |
  |---|---|---|
  | `GET /api/admin/pay-channel` | 六键状态 | `{keys:[{key,label,secret,configured,value?,fingerprint?,updatedAt,updatedBy}]}`——非密五项 `value` 明文回显；**私钥 `value` 恒 null、仅 `fingerprint`**（任何角色都读不回原文） |
  | `PUT /api/admin/pay-channel/:key` `{value}` | 写入=覆盖（非空；空串 400，清空走 DELETE）；`:key` 白名单 = 六键注册表（未知键 400 不落库，服务端校验**解码后**的键值） | `{saved:true, fingerprint, updatedAt}` |
  | `DELETE /api/admin/pay-channel/:key` | 清空=删除（此后该键回「未配置」语义） | `{saved:true}` |

- 🔴 **B1 消解（评审阻断，结构性）**：写面**单角色（仅 super_admin）** ⇒ 「按键分权的 %-编码变体绕过」的攻击
  前提**不存在**（policy 按未解码原值路径匹配、Express 路由参数已解码——`gateway.controller.ts:135-139` R75
  在案；同族 N1 尾斜杠 / ⚙️20 大小写变体教训）。第二层：网关转发照 R75 纪律 `encodeURIComponent(key)`；
  config-service 侧对**解码后**的键做注册表白名单校验（未知键 400 不落库）。**设计注记**：将来若对渠道写面
  再引入角色分权，必须同时引入**按键字面路由**（无参、policy 原值全等、编码变体 404）+ 变体负例——入台账。
- **网关两处**（缺一 404/403）：三条转发方法（照 `admin/config` 先例）+ policy 新条目（置于 P8 前）：
  **PUT/DELETE `/api/admin/pay-channel/*` ⇒ 仅 `super_admin`（E′）**；GET ⇒ 任意已认证角色（照 P8 精神）。
- **管理页**（`admin/index.html` + `app.js`）：顶栏新视图「支付渠道」（读可见性照配置视图先例
  `super_admin|operator|finance`，规格定；**写控件仅 `super_admin`**）。每键一行：状态（`已配置 ✓`/`未配置`）、
  非密显明文值、私钥显 `已配置 ✓ · 指纹 a1b2c3d4e5f6`、输入框（私钥 `type=password` + 粘贴友好）、
  `保存`/`清空`；保存后提示「**已保存；下一次渠道调用即生效**」。顺带修 `CONFIG_NOTES` 现存漂移
  （25 条、缺 pay.* 九键——低风险文本搭车）。
- **校验器住 config-service**（不进 protocol）：密钥类用 `node:crypto` 解析验真
  （`createPrivateKey`/`createPublicKey`，坏 PEM ⇒ 400 不落库）；其它按键形状校验。
  **偏离登记**：片⑦先例「校验住 protocol」是因为双端消费者；渠道键**唯一写入者 = config-service**，
  且 protocol 必须保持客户端可 import 的纯净（无 node:crypto）——偏离入台账。
- 🔴 **消息与写入纪律**（评审 G2/G3）：① 校验失败 message / 任何异常 message **不得内嵌值**（照
  `config.client.ts:44-47`「消息不内插」纪律；Nest TCP 对 handler 异常 `logger.error(error)`——拼了值即绕过脱敏）；
  ② 渠道写路径**不得复用** `PlatformConfigService.set()`（防「顺手复用」把渠道值写进 `platform_config`/进广播；
  D5 只复用 insert SQL 常量，是另一件事）。
- **错误语义**：校验失败 400（照既有）；主钥未设/未配 503 + 明确 message；不新造 15xxx（规格定）。

### D5 — 审计脱敏：复用 `config_changes`（第一页签），密类落指纹对象

- 渠道变更**写同一张 `config_changes`**（insert SQL 常量复用 `admin-changes.service.ts:33-34`；key = 渠道键名，
  64 字符内）⇒ 管理页「配置变更」页签**同一处看得到**渠道运维历史。
- **非密五项**照现状落原文（半公开；操作可见性有价值）。**私钥类** `old_value`/`new_value` 落
  `{"redacted":true,"fingerprint":"<12hex>"}`（**清空时 `new_value` = JSON null**）；
  **永不落**原文/base64/密文。无 schema 变更（JSON 列天然容纳对象）；CSV/JSON 读口不变。
- **实现纪律**（评审 G3/G4）：渠道写**不复用** `PlatformConfigService.set()`（D4 已钉）；redacted 对象经
  `AdminChangesService.listConfigChanges` 单点组行（CSV/JSON 同控制器同方法，`admin-changes.service.ts:151-187`）——
  规格钉「CSV 序列化后仍是对象字面量」，实现者不做二次加工。
- 判据（D8-④）：写私钥后该行序列化内容**不含**密钥原文子串、含指纹与 actor+时刻。

### D6 — 密钥生命周期（轮换 / 泄露 / 主钥备份 / 回滚窗）

- **轮换（应用私钥）四步**（入 `alipay-onboarding.md` + first-deploy「轮换」小节）：
  ① 支付宝后台生成新密钥对 → ② 上传新应用公钥 → ③ 管理页私钥字段**覆盖写入**（指纹肉眼可见变化）
  → ④ 旧钥随上传即废。管理页可核对生效（指纹 + 沙箱/生产全链）。
  **真人验收（已裁 Q4）**：打 tag 部署后、开开关前，在沙箱做一次全程演练（换密钥对 → 覆盖 → 指纹变化
  可见 → 全链复跑）——需用户在场产生证据。⚠️ 关态下 15008 拒单 ⇒ 验收节须写明**临时开/关开关步骤**
  （照 `alipay-onboarding.md` §5 既有联调口径；评审 G8）。
- **泄露应对**：渠道后台重签 + 订单/流水核对（支付片日自检 + 管理面订单视图已在）。
- **主钥与备份（已裁 Q3：备份剥离主钥）**：`backup.sh` 打包 `.env` 前**剔 `PAY_CONFIG_ENC_KEY` 行**（备选
  「照旧全备」已否）；恢复手册同步改：恢复需操作者**另持主钥副本**（丢失 ⇒ 渠道六值重填即可，应用私钥
  需支付宝后台换钥）。
  - 🔴 **与既有判据 d 的取舍（评审 Y1，规格照此冻结）**：slice-07.5 判据 d 现断言「`--restore-env` 产物与源
    `.env` 逐字一致」（`slice-07.5-backup.ts:1448-1449`）。剥离后必不相等 ⇒ **判据 d 期望改为「源文件剔掉该行
    后的派生值」**（派生规则来自设计文本而非产物，保判别力）；播种源加 `PAY_CONFIG_ENC_KEY=probe` 行 +
    **负例**（未剥的合成输入喂新断言 ⇒ 必须红）。属既有判据改造——**偏离登记**。
  - 🔴 **负对照同步（评审 r2-R2-1）**：同判据下既有负对照第一条（`slice-07.5-backup.ts:1453-1466` 的
    `dNegContent !== 源`）在新基底下对**全部可达状态恒真**（产物因剥离天然 ≠ 源）⇒ 改为对**派生期望**比对
    （保留 probeX 自证一条）。剥离模式锚定 `^PAY_CONFIG_ENC_KEY=`——对带前导空白/`export ` 前缀行的行为，
    规格写明假设（用户 .env 现状为裸 `KEY=` 行；或放宽模式，二选一）。
  - **实现坑（钉进规格）**：剥离用 `awk '!/^PAY_CONFIG_ENC_KEY=/'`（或吞退出码），**不得**裸用
    `grep -v … | gzip`——输入全空/只剩该行时 grep 退出码 1，`backup.sh:5` 的 pipefail 会让备份走失败分支。
- **回滚窗**：手顺钉死「管理页配置完成 + 首轮全链验收通过前，**不删**服务器 `.env` 六行」——回滚到旧版
  （读 env）仍可用；删除时机 = 验收通过后（先删后回滚 = 渠道未配置，需重填，登记）。

### D7 — 失败语义等价表（六键逐项；冻结契约，搬运后逐条等价）

| 键 | 今天（env 未设时） | 搬运后（行缺失/清空） | 依据 |
|---|---|---|---|
| `gatewayUrl` | 代码默认生产网关 | **同**（默认值留在支付侧代码，不进存储） | `client.ts:50` |
| `appId` | `readConfig()` null ⇒ **15001** | 同 | `client.ts:247,287-288` |
| `privateKey` | 缺失/坏 decode ⇒ **15001** | 同（写面校验拦坏值；读侧保留防御） | `client.ts:248` |
| `publicKey` | 出站缺失 ⇒ 15001；回调验签失败 ⇒ failure+响亮日志 | 同 | `client.ts:249` / `notify:143` |
| `sellerId` | 回调 seller 校验不过 ⇒ failure 应答+响亮日志（**非** 15001） | 同 | `notify.service.ts:165` |
| `publicBaseUrl` | 缺失 ⇒ **15001** | 同 | `orders.service.ts:484` |

- 「未配置」定义 = **行不存在**（PUT 已拒空串）⇒ 读取层缺键 ⇒ 上表右列。
- 「每次取值时效」等价：今天每次调用读 env；新每次调用拉取 ⇒ **轮换下一次调用即生效**（同强度）。

### D8 — 判据计划（新 slice-22 + 夹具改造 + 闸牵引）

**新 conformance 切片 `slice-22-pay-channel`（组草案；断言数 CI 回填 baseline）**：

| # | 判据 | 备注 |
|---|---|---|
| ① | 未配置 ⇒ 下单 15001；配置后 ⇒ 下单成功；**同进程「配→成功→删→15001」顺序组**（判别整图替换，评审 Y4） | 真栈 + stub |
| ② | **写新密钥对 ⇒ 下一单由新私钥签名**（负前置：stub 先换 appPublic ⇒ 旧钥下单必败 ⇒ 轮换后必成） | **stub 适配面（已实测）**：现无运行期换钥控制面（`alipay-stub.mjs:61-62,273-333`）⇒ 加 `/_control/set-app-public`（约 15–25 行，评审 G5）；第二对密钥切片内 `node:crypto` 现生成 |
| ③ | 私钥**读不回**：GET 仅指纹无 value；覆盖后指纹变化；清空 ⇒ 未配置 | |
| ④ | **审计脱敏**：`config_changes` 行无原文子串、含指纹 + actor + 时刻 | |
| ⑤ | **不进广播**：直连 RPC 探针（`lib/rpc.ts`；补 config endpoint 2 行）拉 `config.snapshot` ⇒ **无渠道键**；payment 容器 `containerEnv` ⇒ **无 ALIPAY_\***（防回流）；`/api/config` 仍恰 14 键（既有断言） | |
| ⑥ | **静态加密**：DB 直查 `value_enc` 无明文子串、前缀 `v1:` | SQL 直查先例 |
| ⑦ | **日志无密钥**：全链跑通后 **payment-service + config-service 两容器**日志 grep **base64 形态**子串 = 空（⚠️ PEM 原文形态会被脱敏器当场替换 ⇒ 恒空，不可作判据，评审 Y7）+ **判别力自证**（合成一行喂 grep 必须命中）+ `PAY_CHANNEL_PULL_TOKEN` 一并纳入 | 密钥不出站纪律的判据化 |
| ⑧ | **权限矩阵（E′）**：operator/finance/viewer × 任一键写 ⇒ 403；super_admin ⇒ 200；读面（GET）矩阵；**变体负例（评审 B1）**：`%2E`/`%4B`/混合大小写路径打写端点 ⇒ 403/404 | 照 ⑮ 先例（只测字面键名会放过变体形态） |
| ⑨ | **主钥 fail-closed**：unset `PAY_CONFIG_ENC_KEY` 重建 config-service ⇒ 渠道块 503 / RPC 错 / 支付 15001；34 键面与其它服务不受影响 | 分步重建先例 |
| ⑩ | **回落语义**：停 config-service ⇒ 已配置渠道照常下单（上次成功值）+ WARN；从未成功过的进程 ⇒ 15001 | |

**单测（config-service + payment-service）**：加解密往返/AAD 绑定/指纹稳定/规范化（PEM↔base64 两态同指纹）/
校验器（坏 PEM 400）/审计脱敏对象/回落缓存逻辑/假库 helper 扩表（`config-probe.ts` 第二副本同族纪律）。

**变体矩阵（评审 r2 的 Express 5.2.1 探针实测；规格照此逐格设断言）**：字面路径 ⇒ 前缀规则命中（非 SA 403 / SA 200）·
键段 `%2E`/`%4B` ⇒ 前缀段未编码仍命中规则（非 SA 403——B1 攻击链由此闭合）· 前缀段 `%2F` ⇒ 不中任何
PUT/DELETE 规则 ⇒ **一律 403（含 SA）+ 路由 404**（fail-closed）· 混合大小写 ⇒ 折叠命中 · 尾斜杠/裸路径 ⇒ 403 ·
小写动词 ⇒ 解析层 400（到不了应用）· `//` 前导 ⇒ 逃逸 admin 中间件但落玩家验签 401 + 路由 404。
唯一理论近邻 `PUT /api/admin/config/pay.channel.*`（P4 放行 operator）写的是 `platform_config` 且被
`parseConfigValue` 判未知键 400——进不了新表（⑧ 须覆盖此近邻一格）。

**既有闸牵引（核销表，实测清单）**：

| 面 | 文件 | 处置 |
|---|---|---|
| slice-21 ⓪ 组 | `slice-21-payment.ts:520-537` | 「容器 env 实读 ALIPAY_*」**替换**为「env **无** ALIPAY_*（回流失败）+ 管理面种子生效」；`PAY_SCAN_*` 断言保留（按 Q1 裁决该两键本片不搬）；**偏离登记** |
| slice-21 种子 | `conformance-stack.sh:46-53` | 六项 export ⇒ 栈起后 **admin 登录 + PUT 种子**（值仍来自 fixture；`adminPutConfig` 族 helper 已有——`lib/http.ts:243`，新端点按同族新增 helper，评审 G6）；**override 删 :127 一行** + 两服务段各加 dev 值（D9 同口径，评审 Y2） |
| slice-19 G12 | served `app.js` 逐字 | 页面改动随 build edge + 镜像（流程既有） |
| slice-07.2-deploy | env 渲染断言面 | 六行删除后逐条核（清单只增不减纪律） |
| slice-07.5 判据 d | `slice-07.5-backup.ts:1448-1449`（源 :188） | **改造 + 负例**（D6 已钉取舍：期望=「源剔该行派生值」；评审 Y1） |
| `messages.test.ts` | `protocol/src/messages.test.ts:53-78` | `RPC_PATTERNS` 全量 toEqual 必红——加 `config.payChannel.get` + it 标题（评审 Y3a） |
| meta 机械闸 | `room-service/test/meta-on-every-rpc-send.gate.test.ts:67-73` | 扫描面含 payment ⇒ 新 `.send` 必带 `metaFromTrace()`（D3 已钉；评审 Y3b） |
| slice-21 ⑬ 重建 helper | `slice-21-payment.ts:335-366` | 六项 env 的**第二触点**：`recreatePaymentServiceWithScanInterval()` 的 ALIPAY_* pick 透传须一并清理（防空条目 + 陈旧注释；评审 Y3c） |
| payment 既有单测 | `notify.test.ts:116-121` · `sign.test.ts:303-313` · `orders-state.test.ts:486-492,642-666` | env 注入点失效（由红自曝）⇒ 改注入 mock 通道配置；进核销表（评审 §5） |
| design-md 闸极性 | `design-md-ai-rollout.gate.test.ts:82,122-129` | **两侧极化（评审 Y5）**：`NEW_ENVS +2`（PAY_CONFIG_ENC_KEY/PAY_CHANNEL_PULL_TOKEN）· **`RETIRED_ENVS +2`**（PAY_PUBLIC_BASE_URL/ALIPAY_SELLER_ID——退役的守卫也机械化，**不得**直接删正向断言）；§2.3 表同步 |
| 脱敏器纵深 | `shared/src/logging/redact.ts:85` | `SECRET_KEY_NAME` 加 `privateKey\|pullToken` 规则（结构性兜底，评审 G1；与 ⑦ 判据互为纵深） |
| 注释订正（搭车） | `alipay-stub.mjs:31-34` · `lib/rpc.ts` 头注（10.4.22 vs 实装 ^11.2.6，评审 G9） | 随改造一并订正 |
| `baselines.json` | 每切片条数下限 | 新片 CI 轮回填（照近例） |
| 34 键面 12 处 | 附录 B | **不动**（D1 结构性理由） |

### D9 — 台账/文档同步（照支付片 §13.4 核销表惯例）

| 文档 | 行号（现状） | 改法 |
|---|---|---|
| `docs/design.md` §2.3 env 表 | :171-207 | 删 PAY_PUBLIC_BASE_URL(:198)/ALIPAY_SELLER_ID(:199) 行；加 `PAY_CONFIG_ENC_KEY`/`PAY_CHANNEL_PULL_TOKEN` 行（+注释：渠道六项已管理化，见 §7.5） |
| `docs/design.md` §7.5 config-service | :1108-1181 | 增「渠道凭据第二键空间」小节：新表/RPC/管理端点/加密契约；:1157 消费面描述补 payment 拉取边 |
| `docs/design.md` §7.7 payment-service | :1217-1250 | 补「渠道凭据消费面 = config.payChannel.get（每调用拉取+回落）」 |
| `docs/design.md` §4.2/§4.3 | :430 / :599 | RPC 契约表补 `config.payChannel.get` pattern；**超时/降级表**补新边（1s、不重试、降级=回落缓存/未配置）——本仓每条 RPC 边都登记（评审 Y3d） |
| `docs/design.md` §10.3 / §11.2 | :1507 / :1538+ | §10.3 表描述补新表；错误码：不新造（503 语义规格写死） |
| `first-deploy.md` 支付节 | 六项表 :251-262；五步 :1374-1407 | 六项表 ⇒「管理页填写指引」（含主钥两行入基础 env 表）；五步改写：①打 tag ②**管理页填沙箱值** ③沙箱联调 ④管理页换生产值 ⑤开开关；新增「**密钥轮换**」小节（D6 四步）+ **验收节**：沙箱联调 + 轮换演练（已裁 Q4，真人验收项） |
| `alipay-onboarding.md` §4/§5 | :48-70 | 交付总表列名改「管理页字段」；删「编辑 .env/重启」语；**安全增益入文**：值不再经手他人、不再落服务器明文文件 |
| 报警 runbook | `ftl-alerts.yml:196`（坏签告警 runbook 提 ALIPAY_* 三件） | 指向改「管理页支付渠道块」 |
| `docker-compose.yml` + override | payment 段 :352-365（六行 = :354,355,356,357,361,365）· override :127 · config-service 段 | payment 段：删六行 + **加 `PAY_CHANNEL_PULL_TOKEN` 透传**（D3 双持有；漏则全链 15001，评审 Y2）；config-service 段：加 `PAY_CONFIG_ENC_KEY` + `PAY_CHANNEL_PULL_TOKEN` 两行；**override 只删 :127 一行**（六行在主文件——评审 Y2 订正 D8 旧措辞）；相应注释改写 |
| `deviation-ledger.md` | — | 新条：env 退役（六项）/ slice-21 ⓪ 断言替换 / 校验器位置偏离 / 六项统一加密 / 主钥轮换 YAGNI / 弃案 A·B |
| `backup.sh` + 恢复手册 | :181-185 | **已裁 Q3**：打包前剔 `PAY_CONFIG_ENC_KEY` 行 + 恢复手册同步（主钥副本由用户自持） |

### D10 — 部署 / 迁移 / 回滚

1. **部署顺序**：迁移建表（空）⇒ 新镜像 ⇒ **渠道未配置 = 与今天暗上线期等价**（15001、不阻塞启动）
   ⇒ 用户管理页填沙箱值 ⇒ **沙箱联调（含轮换演练——已裁 Q4 真人验收项）** ⇒ 换生产值 ⇒ 开开关。
   全程开关默认关不变。
2. **一次性导入**（交接 §3 要求，落地形态修正）：主路径 = **管理页直接填**（payment 尚未上线，值
   从未进过服务器 .env ⇒ 无需"从 .env 导入"）；dev/conformance 的导入 = 栈内种子（D8）；文档附
   「已填过 .env 的情形」一行式 bash 导入片段（读 .env → curl PUT ×6）作兜底。
3. **回滚**：全量换 tag 纪律不变；回滚窗语义见 D6（.env 六行保留至验收通过后删）。

## 4. 兼容面与混部

| 组合 | 行为 | 测法 |
|---|---|---|
| 新 payment-service + 老 config-service（无新 RPC） | 拉取失败 ⇒ 从未成功过 ⇒ 未配置语义（15001）⛔ 工具链全量换 tag ⇒ 不存在稳态混合（重建期瞬态以秒计） | 只能推理（并禁止手工混部） |
| 老 payment-service + 新 config-service | 老代码读 env（.env 六行在⇒照旧） | 回滚窗由 D6 钉死 |

## 5. 明确不做（YAGNI）

- 主钥轮换机制/多主钥/keystore 形态（**已裁**：v1 = env 单钥 + 备份剥离；轮换机制不做）。
- 双人复核/审批流（已裁：不做；要的话另行点名）。
- 渠道多套并存/环境一键切换（v1 靠覆盖写 + 清空回默认）。
- 密钥历史版本/回滚到旧密钥（审计指纹可核对，历史值不留）。
- 推送式下发（D3 已论）；per-service 身份可见性体系（独立立项）。
- 其它 `.env` 项搬运（**已裁 Q1=收敛六项**；附录 A 全量盘点留档，下片按点名搬——含 PAY_SCAN/RECONCILE
  间隔、通知通道等候选及代价）。
- 支付业务九键（26–34）与客户端 14 键不动。

## 6. 风险

1. **config-service 进入支付调用热路径**（1s 超时 + 回落兜底）；残余：config-service 挂 + payment-service
   恰重启（回落缓存是进程内的）= 渠道短暂不可用 ⇒ 登记，不做持久缓存（YAGNI）。
2. **主钥治理**：未设 ⇒ 渠道块 fail-closed（可测）；丢失 ⇒ 六值重填（恢复手册写清）。
3. **备份含主钥**（**已裁剥离**，D6；残余 = 主钥副本由用户自持，丢失恢复路径已入册）。
4. **stub 适配面**（判据②需运行时换 appPublic）——**已实测**：现无运行期控制面
   （`alipay-stub.mjs:61-62,273-333`）；D8-② 已定稿改造（`/_control/set-app-public`，~15–25 行）。
5. 管理页新增视图牵动 slice-19 G12 ⇒ 必须 build edge + 上镜像（流程既有，但漏了会红）。
6. 网关转发/policy 两处漏登记 ⇒ fail-closed 403（结构性保护，但全链红——核销表列全）。
7. **明文在内部网络有传输面**（D3 登记残余）——与片⑦内网信任模型同级。

## 7. 产品问与裁决（2026-10-06 已裁，在案）

> 四问均按「建议」口径裁决（用户 2026-10-06 于开工日集中裁定）；下述为在案记录（问题 + 选项 + 裁决结果）。

**Q1｜范围** → **裁决：收敛六项**。本片只搬支付渠道六项；其余 `.env` 全量盘点留档（附录 A），下片按点名搬。
（未选：+`PAY_SCAN_INTERVAL_MS`/`PAY_RECONCILE_INTERVAL_MS` 两键〔代价见附录 A 测试注入组〕；附录 A 另点名。）

**Q2｜写面权限** → 原裁决：私钥仅 `super_admin`、非密五项 `super_admin|operator`；**复审修订 E′（2026-10-06）：
六项写面全部仅 `super_admin`**（operator 只读）——评审 r1 实测「支付宝公钥 = 回调验签唯一信任锚」，
operator 可写者可自签伪造回调入账（铸币），原「半公开」分类系误判；用户复核后收紧。**不做双人复核**。
（未选：维持原裁决 + 登记残余。）

**Q3｜主钥形态与备份** → **裁决：v1 = env 单钥 + 备份剥离主钥**。`backup.sh` 打包 `.env` 前剔
`PAY_CONFIG_ENC_KEY` 行；恢复需用户另持主钥副本（丢失 ⇒ 六值重填，应用私钥需支付宝后台换钥）。
（未选：照旧全备 + 登记残余。）

**Q4｜轮换验收** → **裁决：要，真人验收项**。打 tag 后、开开关前，在沙箱做一次真轮换全程
（换密钥对 → 管理页覆盖 → 指纹变化 → 全链复跑），需用户在场产生证据。（未选：只留代码级判据。）

---

## 附录 A — `.env` 全量盘点（可搬 / 不可搬 + 理由）

> 来源 = 全栈逐文件扫描（本仓无 `env_file:`；一份根 `.env` 全栈插值；服务器 = `/srv/pokergame/.env`）。

### A1 本片移入管理面（六项）

| 变量 | 今天在哪 | 新家 |
|---|---|---|
| `ALIPAY_GATEWAY_URL` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` / `ALIPAY_SELLER_ID` / `PAY_PUBLIC_BASE_URL` | compose `:352-365` 透传；值 = 服务器 `.env`（`first-deploy.md:251-262`） | `pay_channel_config` + 管理页「支付渠道」 |

### A2 保留 env（不可搬及理由）

| 组 | 成员 | 理由 |
|---|---|---|
| **根信任锚/自举类** | `PAY_CONFIG_ENC_KEY`（新）· `JWT_SECRET` · `ADMIN_JWT_SECRET` · `ADMIN_PASSWORD` · `ADMIN_RESET_PASSWORD` · `INTERNAL_SERVICE_TOKEN` · `DB_PASSWORD` · `GRAFANA_ADMIN_PASSWORD` | ①管理面自举循环（登录/鉴权靠它们，搬进被它们保护的面）；②加密主钥搬进自己加密的存储 = 循环；③爆炸半径（域级密钥泄漏 = 全栈）⇒ 若要做，**独立立项**（不同威胁模型） |
| **拓扑类** | `*_SERVICE_URL`（网关 7 条）· 各 `*_RPC_HOST/PORT` · `REDIS_URL` · `SITE_ADDRESS` · `TLS_MODE` · `TRUST_PROXY` · `EDGE_*_PORT` · `RPC_PORT` · `PORT` · `DOUZERO_URL` | 部署形态**刻意的静态化**（compose 字面量）；运行期改 = 需重建/重路由，无热消费者；搬 = 零收益 + 新增失真面 |
| **测试注入类** | `CONFIG_SYNC_SAFETY_NET_MS` · `CONFIG_SYNC_DISABLE_PUSH` · `RECORDS_CLEANUP_INTERVAL_MS` · `RISK_SCAN_INTERVAL_MS` · `RISK_DEVICES_CLEANUP_INTERVAL_MS` · `CURRENCY_RECONCILE_INTERVAL_MS` | by-design 仅测试注入（生产 compose 不设）；⚠️ `PAY_SCAN_INTERVAL_MS`/`PAY_RECONCILE_INTERVAL_MS` 是**唯一带"生产可调"属性的间隔** ⇒ Q1-b 候选 |
| **通知通道** | `SMTP_HOST/PORT/USER/PASS` · `ALERT_EMAIL_TO` · `DINGTALK_SECRET` · `FEISHU/WECOM/DINGTALK_WEBHOOK_URL` | 属监控栈容器（alertmanager/alert-relay）；搬入需改 entrypoint 的配置生成逻辑 ⇒ 可搬，**建议下片**（Q1-c 可点名） |
| **douzero/运行时** | `PYTHONUNBUFFERED` · `DOUZERO_MODELS` · `GF_*`（grafana 官方镜像键） | 运行时环境变量，非配置 |
| **客户端构建期** | `VITE_API_BASE` · `VITE_WS_ENDPOINT` · `VITE_DEV_USER_ID` | 构建期常量（进产物、客户端可见）——本质不同类 |
| **部署身份（CI/deploy）** | `SSH_HOST/USER/KEY` · `GHCR_*` · `IMAGE_TAG` · `SITE_URL` · `GITHUB_TOKEN` | CI/部署面凭据，非运行时配置 |

### A3 盘点顺带发现（登记，不在本片改）

- 根 `.env` 的 4 个 `*_SERVICE_URL` + `DB_HOST/PORT/USER` + `DOUZERO_URL` 是**遗留副本**（compose 未插值它们，容器值走字面量）——清理另议。
- `admin/app.js` `CONFIG_NOTES` 25 条、缺 pay.* 九键（既有漂移）——本片**搭车补齐**（D4）。
- `docs/design.md` §2.3 未收录的运行时键 >10 个（`ADMIN_RESET_PASSWORD`/`PAY_SCAN_*`/`GRAFANA_ADMIN_PASSWORD`/`SMTP_*`/`GF_*` 等）——§2.3 与机械闸 `NEW_ENVS` 的覆盖口径另议（本片只动与六项相关行）。

## 附录 B — 「34 键面」必红清单（本设计**不动**的结构性理由，D1）

若要往 `CONFIG_KEYS` 加键，以下 12 处硬断言会红（实测）：`protocol/src/config.test.ts:11-28` ·
`config-service/test/platform-config.service.test.ts:204/296-297` · `test/helpers/config-probe.ts:134`（假库第二副本） ·
`test/admin.controller.test.ts:169-205` · `test/client-config.test.ts:18/92/139` · `test/config.rpc.test.ts:44-95` ·
`slice-14:498-505` · `slice-18:100-101/856` · `slice-20:130-131/676-680` · `slice-21:544-568` ·
`tools/mock-server/test/rest.test.ts:55-68`（已漂移）· `baselines.json`。外加文案面 8 处（`design.md` 等）。
**D1 的独立键空间 ⇒ 全部 12 处零改动。**

## 附录 C — 硬要求对位表（B①–⑦ 落点自检）

| 硬要求 | 落点 |
|---|---|
| ① 加密存储 | D2（AES-256-GCM / 主钥 env / 懒 fail-closed） |
| ② 不得进广播快照 | D1（独立表，结构性）+ D3（专用拉取 + 拉取令牌）+ D8-⑤（探针判据） |
| ③ 管理页不回显原文 | D4（私钥 value 恒 null、只回指纹；任何角色） |
| ④ 审计脱敏 | D5（redacted 对象；D8-④ 判据） |
| ⑤ 轮换与泄露应对 | D6（四步轮换 + 泄露应对 + 回滚窗）；入 first-deploy/alipay-onboarding |
| ⑥ 权限 | D4（policy 新条目；**E′ 已裁**：六项写面全收 super_admin、operator 只读）+ D8-⑧ 变体负例（B1） |
| ⑦ 契约冻结面 | D7（等价表）+ D8（判据只增不减 + 偏离登记） |
| ⑧（评审加）日志面纵深 | G1（`redact.ts` 键名规则）+ G2（message 不内嵌值）+ D8-⑦ 判据（base64 形态 + 两容器 + 判别力自证） |
