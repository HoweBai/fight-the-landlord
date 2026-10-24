# 通知通道管理化（SMTP/IM 凭据进管理面）实施计划

> **给执行者（子代理）**：For agentic workers: REQUIRED SUB-SKILL = `superpowers:subagent-driven-development`
> （或 `superpowers:executing-plans`）；本计划逐任务执行，步骤用 `- [ ]` 勾选。
> 规则：**一任务一提交**·**判据同提交**·**「跑了」必须指向本次日志**·偏离 ⇒ 台账登记
> （`.superpowers/sdd/2026-10-07-notify-channel/progress.md`）。
> 上游（必须先读）：规格 **v1.3 冻结** `docs/superpowers/specs/2026-10-07-notify-channel-admin-spec.md`
> （本文所有「§/⚙️」均指它，除注明「设计 §」外）；设计 **v1.3 冻结** `...-design.md`；
> 评审报告 `review-{design,spec}-r*.md`（台账内）。

**Goal:** 通知九键（SMTP 五项 + 三个 IM webhook… 共九项）从 `.env` 搬进 config-service 加密键空间，
经专用拉取通道由 alert-relay（IM 投递）与 am-renderer（渲染 Alertmanager 配置 + 原地重载）消费；
管理页掩码写、审计脱敏；**邮件仍由 AM 原生发出**，`.env` 不再承载任何通知凭据。

**Architecture:** config-service 第三键空间（独立表 `notify_channel_config`，AES-256-GCM，复用支付片设施）
+ 管理三端点 + RPC `config.notifyChannel.get`（三持有令牌）；relay 改拉取驱动（30s 轮询 + 裁剪 + /data 持久化）；
新增 am-renderer 极小组件（拉取 → 渲染 `alertmanager.yml` → 共享卷 → `POST /-/reload`）；AM entrypoint 重写为「等文件→预检→exec」。

**Tech Stack:** NestJS（config-service / api-gateway）· TypeORM 裸 SQL 迁移 · node:crypto · 纯 node 服务
（alert-relay / am-renderer，零框架）· vitest · conformance 真栈切片（含首例 AM 注入判据）· 无构建静态管理页。

## Global Constraints（每任务隐含适用；逐字来自规格）

- 键名九项逐字（⚙️1 序）：`notify.smtp.host|port|user|pass` · `notify.email.to` ·
  `notify.webhook.feishuUrl|wecomUrl|dingtalkUrl|dingtalkSecret`；机密集 = 五（`pass` + 三 URL + `dingtalkSecret`）。
- 九键**不入** `CONFIG_KEYS`（34 键面 12 处硬断言零改动）。
- 加密：**复用支付片设施**（主钥 `PAY_CONFIG_ENC_KEY`，已裁 Q2-A）；`crypto-core.ts` 为纯原语（零 env 访问），
  pay 侧薄绑定**行为/文案/导出零变化**；notify 侧文案 = §2.9（§2.3/⚙️6）。
- env：`NOTIFY_CHANNEL_PULL_TOKEN` **三持有**（config-service + alert-relay + am-renderer）；**空默认透传**，
  dev 值 `dev-notify-channel-pull-token-change-in-production` 由栈脚本/`run.ts ??=` 供给（⚙️13/§5.4）。
  拓扑 env（compose 字面）：`CONFIG_SERVICE_RPC_HOST=config-service` · `CONFIG_SERVICE_RPC_PORT=3106`。
- 拉取（§2.5/⚙️8/⚙️9）：30s 轮询（启动先拉）、超时 3000ms、不重试、**无 meta**（登记）、线格式复刻
  `lib/rpc.ts:131-241`；成功 = 整图替换；relay **拉后即裁（只留 IM 四键）**；持久化 `/data/notify-config.json`
  （600、原子写；读失败按 `null`）；`lastGood===null` ⇒ `/webhook` **500**；成功空图 ⇒ 200 no-op。
- renderer（§3.4/⚙️14）：B1 启动序（**仅卷无文件时写 baseline**；失败**不动文件**）；yml 值输出 = **JSON 双引号标量**；
  amtool 预检失败**不落盘**；`h = sha256(desired)`，`h===lastWrittenHash && lastReloadOk` 才跳过；
  reload 失败置 `lastReloadOk=false` 下轮重试；**日志只允许键名/状态/错误类别**。
- AM entrypoint（§3.5/⚙️15）：有界等待 90s（45×2s，超时 exit 1）→ **token 落盘（600）→ amtool 预检**
  （顺序照 §3.5 的 1–4 步，评审 G7）→
  `exec /bin/alertmanager --config.file=/alertmanager-live/alertmanager.yml --storage.path=/alertmanager`（不转发 `$@`）。
- 权限：写（PUT/DELETE）**仅 super_admin**；读任意已认证。hint = host **全等** allowlist 三平台，否则「外部地址」（§2.4）。
- 审计：五密键 `{"redacted":true,"fingerprint":"<12hex>"}`；四非密 JSON 字符串；清空 `new_value`=JSON 串 `'null'`；
  首写 `old_value`=SQL NULL；1213 捕获边界包整事务（§3.1）。
- 文案/日志：错误 message **不含值**；§2.9 逐字（503/RPC/relay/renderer WARN 与半配 WARN）。
- 平台纪律：Windows 先跑绿（`MSYS_NO_PATHCONV=1`）；实现期只跑受影响包测试；**六阶段只在 push 前跑一次**；
  conformance 全序只在验收跑；假红先单跑确认（不「重跑直到绿」）。

---

### Task 1: protocol 键空间与 RPC pattern（T1）

**Files:**
- Create: `packages/protocol/src/notify-channel.ts`
- Modify: `packages/protocol/src/index.ts`（re-export）· `packages/protocol/src/rpc.ts`（`RPC_PATTERNS` +1）· `packages/protocol/src/messages.test.ts:53-70`
- Test: `packages/protocol/src/notify-channel.test.ts`（新；照 `pay-channel.test.ts` 形态）

**Interfaces:** Produces: `NOTIFY_CHANNEL_KEYS`（九字面量）· `NotifyChannelKey` · `NOTIFY_CHANNEL_SECRET_KEYS`（五）· `ConfigNotifyChannelGetRequest{pullToken,meta?}` · `ConfigNotifyChannelGetResponse{values:Partial<Record<NotifyChannelKey,string>>}` · `RPC_PATTERNS.configNotifyChannelGet='config.notifyChannel.get'`。

- [ ] **Step 1**：写测试：九键数组逐字 + 密子集恰五 + 与 `CONFIG_KEYS`/`PAY_CHANNEL_KEYS` 交集为空；`RPC_PATTERNS` 键值逐字。
- [ ] **Step 2**：跑测试看红：`pnpm -F @fight-the-landlord/protocol test`（模块不存在）。
- [ ] **Step 3**：实现 `notify-channel.ts`（内容 = 规格 §2.1 代码块逐字）；`rpc.ts` 加 pattern（含注释：「通知通道管理化片；专用拉取通道，消费端 30s 轮询/无 meta」）；`index.ts` re-export。
- [ ] **Step 4**：`messages.test.ts` 全量 toEqual +1（标题按实际数改）；跑 protocol 全绿。
- [ ] **Step 5**：Commit：`feat(protocol): notify-channel 键空间与 config.notifyChannel.get pattern（T1）`

### Task 2: config-service 迁移 + 假库扩表（T2）

**Files:**
- Create: `packages/config-service/src/migrations/1793000000000-NotifyChannelConfig.ts`
- Modify: `packages/config-service/test/helpers/config-probe.ts`（假库扩 `notify_channel_config`，第二副本纪律）
- Test: `test/migration.test.ts` +1 用例（建表/回滚/号唯一）

**Interfaces:** Produces: 表 `notify_channel_config`（规格 §2.2 DDL 逐字；`down` = DROP）。

- [ ] **Step 1**：按 §2.2 DDL 逐字写迁移（类名 `NotifyChannelConfig1793000000000`；`IF NOT EXISTS` + 反引号 `key`）。
- [ ] **Step 2**：假库扩表（照 `pay_channel_config` 假表形态 + ODKU 语义）+ 一格 smoke（INSERT+SELECT 往返）。
- [ ] **Step 3**：跑 `pnpm -F @fight-the-landlord/config-service test` 全绿（34 键面不红）。
- [ ] **Step 4**：Commit：`feat(config-service): notify_channel_config 迁移 + 假库扩表（T2）`

### Task 3: crypto 泛化（crypto-core + 双薄绑定）（T3）

**Files:**
- Create: `packages/config-service/src/sensitive-config/crypto-core.ts` · `packages/config-service/src/notify-channel/notify-channel.crypto.ts`
- Modify: `packages/config-service/src/pay-channel/pay-channel.crypto.ts`（改薄绑定，**导出/行为/文案零变化**）
- Test: `test/notify-channel.crypto.test.ts`（新）+ **pay 既有 crypto 测试全量复跑**（行为钉住）

**Interfaces:** Produces: `parseKey(raw): Buffer|null` · `encryptWithKey(key,name,plaintext)` · `decryptWithKey(key,name,enc)` · `fingerprintOf(canonical)`（零 env 访问）；notify 绑定：`encrypt/decrypt/fingerprintOf/parseMasterKey`（env `PAY_CONFIG_ENC_KEY` + 缓存 + §2.9 文案）。

- [ ] **Step 1**：写 crypto-core 测试（往返/AAD 绑定/前缀与截断/garbled/规范 base64 比对——照 `pay-channel.crypto.test.ts` 全格）。
- [ ] **Step 2**：实现 `crypto-core.ts`（算法/格式 = §2.3 逐字；不读 env）。
- [ ] **Step 3**：pay 侧改薄绑定（保留其模块级缓存与逐字文案：`渠道密钥存储未启用（缺主钥）` 等）；跑 pay crypto 测试 + pay 全包测试**全绿**（行为零变化钉住）。
- [ ] **Step 4**：notify 绑定 + 测试（文案 = §2.9：`通知通道密钥存储未启用（缺主钥）` 等）；跑绿。
- [ ] **Step 5**：Commit：`refactor(config-service): crypto 提 crypto-core + pay/notify 双薄绑定（T3，pay 行为零变化）`

### Task 4: 校验器 + hint 原语（T4）

**Files:**
- Create: `packages/config-service/src/notify-channel/notify-channel.validators.ts`
- Test: `packages/config-service/test/notify-channel.validators.test.ts`

**Interfaces:** Produces: `validateAndNormalize(key, raw): {ok:true,canonical}|{ok:false,reason}`（§2.4 表逐格；reason 不含值）· `urlHint(value): string|null`（三平台 allowlist **全等** ⇒ origin，否则「外部地址」；非 URL ⇒ null）。

- [ ] **Step 1**：测试——九键矩阵正反逐格（§2.4 表：host 正则/port 范围/user 空白/pass 控制字符/email.to 逗号列表逐项/URL http(s)/secret 空白/各上限）；**reason 不含输入值**（含标记串的坏值 ⇒ 断言理由无该串）。
- [ ] **Step 2**：测试——`urlHint`：三平台域 ⇒ origin（含端口形态）；`https://example.com/hook` ⇒「外部地址」；仿冒 `evilqyapi.weixin.qq.com.hk` 与 `qyapi.weixin.qq.com.evil.com` ⇒「外部地址」；非 URL/非该键 ⇒ null。
- [ ] **Step 3**：实现（全键先 trim；canonical 规则 = §2.3「唯一变换 = trim」）。
- [ ] **Step 4**：跑绿；Commit：`feat(config-service): 通知九键校验器与 hint 原语（T4）`

### Task 5: service 层 + gauges 刷新（T5）

**Files:**
- Create: `packages/config-service/src/notify-channel/notify-channel.service.ts` · `notify-channel.metrics.ts`
- Test: `packages/config-service/test/notify-channel.service.test.ts` · `notify-channel.metrics.test.ts`

**Interfaces:** Produces: SQL 常量四个（§2.2；被单测钉全文）· `status()`（九项，⚙️1 序，URL 三键现算 `hint`）· `set(key,value,actor)` · `clear(key,actor)` · `pull()`；`refreshNotifyGauges()`（⚙️17：写路径现算 + 启动一次，读失败保持旧值 + WARN）。

- [ ] **Step 1**：测试——三段序（锁→UPSERT→审计同事务）；审计两列两形态（密 redacted/非密 JSON/清空 `'null'`）；幂等 clear 不落审计；`status()` 九项序 + 密键 value 恒 null + hint 逐格；**1213 重试注入**（捕获边界包整事务）。
- [ ] **Step 2**：测试——gauges：set 后 `keys_configured{group}` 增、clear 后减、`group_complete` 0/1 翻转；SQL 读失败 ⇒ 保持旧值 + WARN（不打穿）。
- [ ] **Step 3**：实现（事务照 `pay-channel.service.ts` 同构，表名替换；`OnModuleInit` 调 `refreshNotifyGauges()`；**不 publish**；**不得复用** `PlatformConfigService.set()`；写路径**不得**内嵌值）。
- [ ] **Step 4**：跑绿；Commit：`feat(config-service): notify-channel service（状态/写/清空/拉取/1213）+ 完整性 gauges（T5）`

### Task 6: 管理三端点 + 模块注册（T6）

**Files:**
- Create: `packages/config-service/src/notify-channel/notify-channel.controller.ts`
- Modify: 相应 `*.module.ts`（注册 controller/service/metrics）
- Test: `packages/config-service/test/notify-channel.controller.test.ts`

**Interfaces:** Produces: `GET/PUT/DELETE /api/admin/notify-channel[/:key]`（§2.4 契约逐字：401 先行 · 400 未知键/空串/校验不过 · 503 主钥缺 · DELETE 幂等；GET 项含 `hint`）。

- [ ] **Step 1**：测试三端点全契约（形状/错误序/九项 hint 字段存在性）。
- [ ] **Step 2**：实现（`@Controller('admin')` + `XAdminGuard` + `requireActor`；错误序照 pay 先例；503 文案 §2.9）。
- [ ] **Step 3**：跑绿；Commit：`feat(config-service): 管理面 notify-channel 三端点（T6）`

### Task 7: RPC 接收侧（T7）

**Files:**
- Modify: `packages/config-service/src/rpc/config.rpc.controller.ts`（第三 `@MessagePattern`）
- Test: `packages/config-service/test/config.rpc.test.ts` +用例（含 J21 承载闸仍绿）

**Interfaces:** Consumes: `NotifyChannelService.pull()`；Produces: `config.notifyChannel.get` handler（R220 信封；令牌常数时间；10002 `拉取令牌不匹配`；10007 `通知通道密钥存储未启用`）。

- [ ] **Step 1**：测试——正令牌 ⇒ `{ok:true,data:{values}}`（仅已配置）；错/缺 ⇒ `ok:false,10002`；主钥缺 ⇒ `10007`；**`config.snapshot` 响应无 `notify.` 子串**（本包级）。
- [ ] **Step 2**：实现（照 pay 逐字形态；失败不抛）。
- [ ] **Step 3**：跑绿（**J21 承载闸住在 protocol 包**：`pnpm -F @fight-the-landlord/protocol test` 另跑一次，评审 G6）+ config-service 全包；Commit：`feat(config-service): config.notifyChannel.get 接收侧（T7）`

### Task 8: 网关 policy + 转发（T8）

**Files:**
- Modify: `packages/api-gateway/src/auth/admin-policy.ts`（P9 前两条）· `packages/api-gateway/src/gateway/gateway.controller.ts`（三条转发方法）
- Test: 网关既有测试族 +用例（变体矩阵 = §5.2⑤ 四段式逐格 + 近邻 `PUT /api/admin/config/notify.smtp.pass ⇒ 400`）

**Interfaces:** Produces: `PUT/DELETE /api/admin/notify-channel/*` ⇒ super_admin；GET 落 P8；转发 `:key` 走 `encodeURIComponent`（R75）。

- [ ] **Step 1**：测试（policy 字面+变体逐格；SA 键段 `%2E`/`%4B`/大小写 ⇒ 200；非 SA 全 403；`%2F`/裸/尾斜杠 ⇒ 403 含 SA；近邻 400）。
- [ ] **Step 2**：实现（注释引用 §4 与 B1 教训）。
- [ ] **Step 3**：跑绿；Commit：`feat(gateway): notify-channel 管理写路由与 policy（T8）`

### Task 9: 管理页「通知通道」视图 + slice-19 针脚（T9）

**Files:**
- Modify: `admin/index.html`（nav + section）· `admin/app.js`（`VIEWS.notifyChannel`、`VIEW_ORDER` 第 3 位、懒加载/保存/清空/行构建、组尾完整性提示、「十视图」注释 ×4 随动）· `tools/conformance/src/slices/slice-19-admin-rbac-audit.ts:1451-1465`（G12 +3 needle）
- Test: **不新建单测文件**（全仓无 admin/app.js 单测载体——pay 评审 F2 同裁，评审 F3）；验收载体 = slice-19 G12

**Interfaces:** Consumes: 任务 6 三端点；Produces: 视图 id `notify-channel-view` / nav `nav-notify-channel-btn` / 「通知通道」；选择器 `.notify-channel-{row,save,clear}-{slot}`（slot 九枚）。

- [ ] **Step 1**：slice-19 追针（+3 needle）；**角色门 = 代码面纪律**（写控件仅 SA 渲染），真门在后端 policy（T8）。
- [ ] **Step 2**：实现页面（§2.8 逐字：两组渲染、密键指纹 + URL hint、pass `type=password` + `-webkit-text-security:disc`、提示逐字、留空不预填）。
- [ ] **Step 3**：**build edge 后跑 G12**（G12 断言「served app.js == 仓库逐字」，admin 文件 `COPY admin /srv/admin` 进镜像——不重建必红；命令照 pay 先例：`docker compose build edge` + `EDGE_HTTP_PORT=8080 EDGE_HTTPS_PORT=8443 docker compose --profile edge up -d --no-deps --wait edge`——⚠️ 丢 `EDGE_HTTPS_PORT` 会掉回 443，记忆第 18 条）：对照跑 `slice-19` 全绿。
- [ ] **Step 4**：Commit：`feat(admin): 通知通道视图 + G12 针脚（T9）`

### Task 10: redact 扩展 + design-md 闸（T10）

**Files:**
- Modify: `packages/shared/src/logging/redact.ts:98-99`（枚举式新支）· `packages/shared/test/design-md-ai-rollout.gate.test.ts`（NEW_ENVS +1 · RETIRED_ENVS +9）· **`docs/design.md` §2.3**（+token 行；与闸同提交——评审 G2）
- Test: `packages/shared/test/redact.test.ts` +用例

**Interfaces:** Produces: `SECRET_KEY_NAME` 新支 = `/(^|[._])notify\.(smtp\.pass|webhook\.(feishuUrl|wecomUrl|dingtalkUrl|dingtalkSecret))$/`；`design.md §2.3` 侧（文档面在 T17，此处只**闸极化**——NEW_ENVS/RETIRED_ENVS 列表改；§2.3 未改动前闸会红 ⇒ **本任务与 T17 的 §2.3 行改动合并提交**）。

- [ ] **Step 1**：redact 测试正反：五密键键名命中；`notify.smtp.host`、`REDIS_URL`、`DOUZERO_URL`、裸 `url` **不**命中。
- [ ] **Step 2**：实现 redact 新支；跑 shared 全绿。
- [ ] **Step 3**：design-md 闸列表改（NEW_ENVS +`NOTIFY_CHANNEL_PULL_TOKEN`；RETIRED_ENVS +九键）+ `docs/design.md §2.3` 行（+token 行；注解指向 §7.5）**同提交**；跑 shared 全绿。
- [ ] **Step 4**：Commit：`feat(shared): redact notify 命名空间 + design-md 闸极化（T10）`

### Task 11: Prometheus 规则两条（T11）

**Files:**
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（§3.8 两规则逐字）
- Test: 规则语法（既有 promtool/装载路径）+ 断言数**留给 T14 同步**（EXPECTED_RULES 23→25 在 T14 改）

**Interfaces:** Produces: `NotifyEmailIncomplete` / `NotifyDingtalkIncomplete`（`for: 10m`，warning，中文 annotations 无插值）。

- [ ] **Step 1**：按 §3.8 逐字追加两条规则；验证：`docker compose --profile monitoring up -d --build prometheus`（**必须 `--build`**——rules 进镜像，评审 G4）后 `/api/v1/rules` 见 25 条（或 promtool/装载日志绿——择一取证）。
- [ ] **Step 2**：Commit：`feat(monitoring): 通知完整性规则两条（T11）`

### Task 12: alert-relay 拉取客户端 + server 改造（T12）

**Files:**
- Modify: `packages/alert-relay/package.json`（+`"@fight-the-landlord/protocol": "workspace:*"`）+ 根 `pnpm-lock.yaml`（`pnpm install` 生成；根文件协调者独占）+ `packages/alert-relay/src/config.ts`（env 四键与拒起退役；`sinksFromValues` + 半配判定纯函数）+ `src/server.ts`（sink 热更新；`lastGood===null ⇒ 500`；启动衔接轮询）
- Create: `packages/alert-relay/src/notify-config.ts`（拉取客户端 + 裁剪 + `/data` 持久化）
- Test: `test/notify-config.test.ts` · `test/sinks-from-values.test.ts` · `test/config.test.ts` 三态改写 · `test/server.test.ts` 改造 · `test/helpers.ts`（进程内 stub TCP server 大概率扩此，评审 G9）

**Interfaces:** Produces: `pullNotifyConfig(env): Promise<Partial<Record<NotifyChannelKey,string>>>`（JsonSocket 帧、3000ms、不重试、throw）· `trimForRelay(values)`（只留四 IM 键）· lastGood 持久化读写（`/data/notify-config.json`，600，原子写）· `sinksFromValues(values)`（顺序 feishu→dingtalk→wecom；半配停用）· `startRelayServer` 增「当前槽位闭包」与 500 分支。

- [ ] **Step 1**：写 `notify-config` 测试（进程内 stub TCP server：正/超时/坏帧/业务错 ⇒ throw；裁剪；原子写与读失败 ⇒ null）。
- [ ] **Step 2**：写 `sinks-from-values` 测试（槽位矩阵：全配/只 feishu/钉钉半配/空图）。
- [ ] **Step 3**：实现 `notify-config.ts` + `config.ts` 派生函数。
- [ ] **Step 4**：改 `config.test.ts` 三态拒起 → 派生/半配用例；改 `server.test.ts`（注入值直配 + 500 分支 + 热更新换槽）；实现 `server.ts`（轮询 tick：拉取 ⇒ 裁剪 ⇒ 整图替换 ⇒ 持久化 ⇒ 重算槽位闭包；失败 WARN 状态变化时一条；`/webhook` 三态：null⇒500 / 零槽⇒200 `no sinks configured` / 扇出）。
- [ ] **Step 5**：跑 alert-relay 全绿；Commit：`feat(alert-relay): 拉取驱动 + /data last-good + 500 语义（T12）`
  —— **中间提交态说明（评审 F2 连带）**：T12/T13 合并后、T15 前，dev 栈仍是旧 compose（relay 无 pull token env）——若此时本地重建并运行新 relay，`/webhook` 会回 500（可启动、不崩）；属**预期中间态**，无需暗态兼容（不重建即不受影响）。

### Task 13: am-renderer（入口 + 渲染 + 状态机）（T13）

**Files:**
- Create: `packages/alert-relay/src/am-renderer.ts`
- Test: `test/am-renderer.test.ts`

**Interfaces:** Consumes: `pullNotifyConfig`（T12）；Produces: `renderAlertmanagerYml(values)`（纯函数；§3.4 渲染规则逐字——静态段/baseline 两形态/全 SMTP 形态；值 = JSON 标量）· 状态机（§3.4：启动序/4–6 步/`lastWrittenHash`+`lastReloadOk`）· argv 守卫（照 `server.ts:242-243`）。

- [ ] **Step 1**：写 golden 测试——**两形态逐字对照现 entrypoint 输出**（baseline = 无 smtp 段 + heartbeat 空接收器；全量 = global 五行 + all/webhook/email/heartbeat 四接收器）；值含引号/反斜杠/换行 ⇒ JSON 标量安全用例；半配 ⇒ 省略 + WARN。**golden 必须固化为静态 fixture 入库**（评审 G8——不得让 golden 活依赖旧 entrypoint；T15 删 tmpl/重写 entrypoint 后本测试仍须可复跑）。
- [ ] **Step 2**：写状态机测试（注入 fake fs/fetch/amtool spawn）：文件在场+pull 失败 ⇒ 不动文件；content 不变 ⇒ 不 reload；reload 非 200 ⇒ 下轮重试且不重写；amtool 失败 ⇒ 不落盘；**全新卷无 pull ⇒ 写 baseline**。
- [ ] **Step 3**：实现（amtool 路径 `/bin/amtool`；原子写 tmp 600 + rename；reload `POST http://alertmanager:9093/-/reload` 3000ms；日志纪律）。
- [ ] **Step 4**：跑绿；Commit：`feat(alert-relay): am-renderer（yml 渲染 + 重载状态机）（T13）`

### Task 14: slice-16 改造 + 规则数三处（T14）

**Files:**
- Modify: `tools/conformance/src/slices/slice-16-monitoring.ts`（relay 组注入机制 = ⚙️22 stub 拉取源 + HTTP `/_pulls` 读数 + 就绪语义；`EXPECTED_RULES` :89-100 + promtool :599 + 计数 :662 三处 23→25）· **`slice-18-gold-room.ts:1286`（「恰 23 条」断言 23→25 + 构成式注释同步——实施期微审补入，规格 §5.3#4b）** · **`Dockerfile.prometheus:1` 头注 23→25（规格 §5.3#4c，显式指派）**
- Test: 跑 `slice-16` + `slice-18`（本机真栈）

**Interfaces:** Consumes: T11 两规则、T12/T13 relay 行为；Produces: slice-16 恢复全绿。

- [ ] **Step 0**：**先重建 alert-relay 镜像**：`docker compose --profile monitoring build alert-relay`（slice-16 探头取自本地镜像 `pokergame-alert-relay:latest`；不重建则新拉取客户端不在镜像里、`/_pulls≥1` 就绪语义恒不至 ⇒ 必红；评审 F2）。
- [ ] **Step 1**：写 stub 拉取源（node net server 回 JsonSocket 帧 + HTTP `/_pulls`）；改 `startRelay`/四组合（①②③④）为拉取注入 + 就绪语义（`/health` 200 且 `/_pulls`≥1 且 200ms 沉降）。
- [ ] **Step 2**：规则数三处 23→25。
- [ ] **Step 3**：本机跑 `slice-16` 全绿（日志落台账）；Commit：`test(conformance): slice-16 relay 拉取注入 + 规则数 25（T14）`

### Task 15: compose / Dockerfile / AM entrypoint（T15）

**Files:**
- Modify: `docker-compose.yml`（AM 段删五键 + live 卷 ro；relay 段删四键 + token/RPC env + relay-data 卷；**新 `am-renderer` 服务块** = §2.10 逐字〔无 build:/image 参数化同串/user 65534/无 healthcheck 与理由〕；config-service 段 +token；volumes +2）· `docker-compose.override.yml`（am-renderer profile 块；relay/AM 补行）· `Dockerfile.alert-relay`（多阶段 amtool + `/data` 与 `/alertmanager-live` 预建）· `Dockerfile.alertmanager`（`/alertmanager-live` 预建）· `deploy/monitoring/alertmanager/entrypoint.sh`（§3.5 重写）· **删** `alertmanager.yml.tmpl` · `scripts/deploy/conformance-stack.sh:213`（down-rm +`am-renderer`）· `tools/conformance/src/slices/slice-07.2-deploy.ts:970-981`（`LOG_LIMIT_TARGETS` +1）
- Test: 渲染类闸（A11/A12 不红）+ `slice-07.2-deploy` 本机绿

**Interfaces:** Produces: 生产形态 18→**19 容器**（17 + edge + am-renderer；渲染面）；env 九键退役完成。

- [ ] **Step 1**：按 §2.10 逐字改 compose/override/Dockerfile/entrypoint（tmpl 删除）；注释改写（:761-762/:866-867）。
- [ ] **Step 2**：`LOG_LIMIT_TARGETS` +1（不加不红=静默失明）；`conformance-stack.sh` down-rm +`am-renderer`；**+ `export NOTIFY_CHANNEL_PULL_TOKEN="${NOTIFY_CHANNEL_PULL_TOKEN:-dev-notify-channel-pull-token-change-in-production}"`（照 :52-55 四行区块之后——初起整栈的供给点，缺则三持有容器 token 空串、拉取全拒；评审 F1/r2-3-4）**。
- [ ] **Step 3**：**重建前先记现态**（`docker compose ps` 一行，评审红队①）；本机重建栈：`bash scripts/deploy/conformance-stack.sh up`（**主路径 = 脚本 up**——它自带 `:13-14` 端口与 `:52-55` 密钥 export 及 stub/种子段；「裸 compose up」**不等价、勿用**〔门口会落 80/443、token 空串〕，评审 r2-3-2）验证：am-renderer 起 → 卷出现 baseline yml → AM 起 healthy；`slice-07.2-deploy` 全绿（A12「恰好 14」不动）。
- [ ] **Step 4**：Commit：`feat(deploy): compose/entrypoint/renderer 服务 + LOG_LIMIT/down-rm（T15）`

### Task 16: conformance 基建 + slice-23 新片（T16）

**Files:**
- Modify: `tools/conformance/src/run.ts:130-131`（`??=` 供 `NOTIFY_CHANNEL_PULL_TOKEN`）· `tools/conformance/src/lib/http.ts`（+`adminNotifyChannel{Get,Put,Delete}` 族）· `tools/conformance/src/run.ts` CASES 末位 · `baselines.json`
- Create: `tools/conformance/src/slices/slice-23-notify-channel.ts`
- Test: 本机跑 `slice-23`（真栈）

**Interfaces:** Consumes: 全部前述（**T15 真栈 · T8 网关 · T9 页面 · T11 规则 · T12/T13 relay/renderer**）；Produces: 十一组判据（§5.2 逐组逐字，含组序/前置/末态链、投递 stub（**只做投递收集**——slice-23 的 relay 走**真 config-service** 拉取，`/_pulls` 属 T14 的 pull-stub 概念、此处不造，评审 G3）、路径分桶计数、AM 注入首步 `ProbeWecomA`、收敛自证与残留登记）。

- [ ] **Step 1**：基建（helpers/`??=`/CASES 注册）；写 slice-23 框架与 ⓪①②③④⑤ 组。
- [ ] **Step 2**：⑥–⑪ 组 + 收尾（含投递 stub 收集实测、`docker inspect` 存活、`/data` 内容、日志 needle 三容器点名、`/api/v1/alerts` pending ≤120s）。
- [ ] **Step 3**：本机跑 `slice-23` 全绿（日志落台账）；回填 `baselines.json`（**按本机实况回填、CI 权威轮复核——slice-21/22 近例口径**，评审 G9）；**再跑一次确认非偶绿**。
- [ ] **Step 4**：Commit：`test(conformance): slice-23 通知通道管理化十一组（T16）`

### Task 17: 文档面（T17）

**Files:**
- Modify: `docs/design.md`（§2.3：**token 行已在 T10 落地——不得重加**；但**须订正 `PAY_CONFIG_ENC_KEY` 行**（:198——同钥现管两键空间、缺钥亦 503 通知面；W3 深扫发现）· §4.2/§4.3 RPC 边 · §7.5 通知键空间小节 · §10.3 表清单）· `docs/ops/first-deploy.md`（键表九行删/两条硬规则改写/监控③节重写/「通知怎么上线（三步）」/恢复节 **+ 微审订正：主钥丢失后换新钥时非密键会卡死（旧值解密失败 ⇒ 写入 503）——口径 = 恢复必须用原钥副本；确需换钥须先手工清行（缺陷在案，修属未来片）**）· `docs/superpowers/plans/deviation-ledger.md`（§6 全部条目）· `.gitleaks.toml`（若夹具命中）· `docs/superpowers/specs/2026-10-07-notify-channel-admin-design.md`?（D5 钉钉提示措辞与规格字面不一致——**T17 顺带统一或登 1 行偏差**，评审 M2）
- Create: `docs/ops/notify-onboarding.md`
- Test: `slice-07.2-deploy` 渲染断言面 + design-md 闸（T10 已极化）全绿

**Interfaces:** Produces: 手册与台账收口（§6 表逐行）。

- [ ] **Step 1**：design.md 四处；first-deploy 五处；notify-onboarding 新文；deviation-ledger 新条；gitleaks 核。
- [ ] **Step 2**：跑文档相关闸（design-md/渲染类）全绿。
- [ ] **Step 3**：Commit：`docs(notify-channel): 设计/手册/台账收口（T17）`

### Task 18: 六阶段 + 全序回归与收口（T18）

**Files:**
- Modify: `.superpowers/sdd/2026-10-07-notify-channel/progress.md`（全程登记）
- Test: `bash scripts/ci.sh`（六阶段）+ conformance 全序

**Interfaces:** Produces: 全绿证据（日志落台账）+ baselines 校正 + 收口交接。

- [ ] **Step 1**：`bash scripts/ci.sh` 六阶段全绿（日志落台账；含全仓 test ⇒ **meta 闸**等代码面「验证不红」项机械覆盖；slice-07.5 由 Step 2 全序承载，评审 r2-3-3）。
- [ ] **Step 2**：conformance **全序（本机等价 CI 路径）**：`bash scripts/deploy/conformance-stack.sh up` → `node tools/conformance/dist/run.js --fresh`（默认态前置断言，CI 同款；**`scripts/ci-conformance` 不存在**——评审 F4）→ `--list` 循环逐片（输出 tee 到日志：`… 2>&1 | tee .superpowers/sdd/2026-10-07-notify-channel/conformance-<轮>.log`）→ `node scripts/check-baselines.mjs full <日志>`（**缺 `<日志>` 参会打用法 exit 2**，评审 r2-3-1）。**只跑一次**（若红先单跑确认假红/真红，批处理修复后复跑）。
- [ ] **Step 3**：对账（baselines 实况复核 + **台账点名核销 #6（slice-07.5 零改动验证不红）/ #8（meta 闸预期不红——扫描面不含 alert-relay，已实核）/ #12（34 键面零改动验证不红）**）；台账收口 + 交接文档（`post-notify-channel-handoff.md` 草案，含命名卷跨 run 残留面登记）。
- [ ] **Step 4**：Commit：`test: 六阶段+全序收口（T18）`

## 执行纪律（全局）

1. **一任务一提交**；提交信息带 `（Tn）`；判据/测试**同提交**。
2. **「跑了」= 本次产生的日志**：任何「通过/全绿」必须指向当场命令输出；禁止复述旧结论。
3. 假红先**单跑确认**（不「重跑直到绿」）；已知假红名单在 `ci-flake-known` 记忆与台账。
4. 实现期只跑**受影响包**测试；**六阶段只在 push 前跑一次**（T18）；conformance **全序只在验收跑一次**（T18）。
5. Windows 侧先绿（`MSYS_NO_PATHCONV=1`；路径转换坑见记忆「Windows 开发环境事实」）。
6. 任何与规格的偏离 ⇒ 台账登记 + 规格微审（规格 §9 纪律）。
7. 机器等待期不干等（远端 CI 派出去回头收；本机重跑期只填纯文档）。

## 自检记录（写计划时的对照）

- **规格覆盖**：§2.1→T1 · §2.2→T2 · §2.3/⚙️6→T3 · §2.4→T4/T6 · §3.1/§3.2/⚙️17→T5 · §2.5→T7 · §4→T8 · §2.8→T9 · §2.9/§5.3#10-11→T10/T12/T13 · §3.8→T11 · §3.3→T12 · §3.4→T13 · §5.3#3-4→T14 · §2.10/§3.5→T15 · §5.2/§5.4/§5.5→T16 · §6→T10/T17 · §7→T17/T18 · §5.3 其余行 → 各自任务同提交（#5 T15 · #7 T1 · #9 T9 · #12 验证不红 · #16 T15 · #17 T15 · #18 T7）。
- **占位符扫描**：无 TBD/TODO；「逐字」项均指向规格 §/⚙️/代码块。
- **一致性**：`pullNotifyConfig`/`sinksFromValues`/`trimForRelay`/`renderAlertmanagerYml`/`refreshNotifyGauges`/`urlHint` 命名全篇一致；产物名（视图 id/needle/选择器/规则名/gauge 名）逐字同规格。
