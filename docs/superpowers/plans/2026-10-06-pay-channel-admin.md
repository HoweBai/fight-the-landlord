# 支付配置管理化（渠道凭据进管理面）实施计划

> **给执行者（子代理）**：本计划逐任务执行；每个任务 = 独立可验收交付物 + 一提交。
> 规则：**一任务一提交**·**判据同提交**·**「跑了」必须指向本次日志**·偏离 ⇒ 台账登记（`.superpowers/sdd/2026-10-06-pay-config/progress.md`）。
> 上游（必须先读）：规格 v1.3 冻结 `docs/superpowers/specs/2026-10-06-pay-channel-admin-spec.md`（本文所有「§」均指它，
> 除注明「设计 §」外）；设计 v2.2 冻结 `...-design.md`；评审报告 `review-{design,spec}-r*.md`（台账内）。

**Goal:** 六项支付渠道凭据从 `.env` 搬进 config-service 独立加密存储，经专用拉取通道下发 payment-service，管理页掩码写、审计脱敏；`.env` 只剩根信任锚与拓扑。

**Architecture:** config-service 新增第二键空间（独立表 `pay_channel_config`，AES-256-GCM）+ 管理三端点 + RPC `config.payChannel.get`（拉取令牌）；payment-service 每次渠道调用现拉 + 失败整图回落；管理页新视图「支付渠道」。

**Tech Stack:** NestJS（config-service / payment-service / api-gateway）· TypeORM 裸 SQL 迁移 · node:crypto（AES-256-GCM / RSA 解析）· vitest · conformance 真栈切片（node:net RPC 探针）· 无构建静态管理页。

## Global Constraints（每任务隐含适用；逐字来自规格）

- 键名六项逐字：`pay.channel.gatewayUrl|appId|privateKey|publicKey|sellerId|publicBaseUrl`（⚙️1）；机密集 = `{pay.channel.privateKey}`。
- 六键**不入** `CONFIG_KEYS`（34 键面 12 处硬断言零改动，设计附录 B）。
- 加密：AES-256-GCM、12B IV、AAD=键名、tag 16B、`v1:` 前缀 base64(iv‖ct‖tag)；指纹 `sha256(canonical)[:12]` hex（§2.3）。
- 主钥 env `PAY_CONFIG_ENC_KEY`（仅 config-service）· 拉取令牌 `PAY_CHANNEL_PULL_TOKEN`（双持有）——**空默认透传**，dev 值由栈脚本/`run.ts ??=` 供给（⚙️13/§5.4）。
- 权限 E′：写面（PUT/DELETE）**仅 super_admin**；读面任意已认证角色。
- 拉取：每调用现拉、超时 **1000ms**、不重试、`.send` 必带 `...metaFromTrace()`；成功 = **整图替换**（§3.3/§2.5）。
- 审计：非密键 JSON 字符串原文；密键 `{"redacted":true,"fingerprint":"<12hex>"}`；首写 `old_value`=SQL NULL；清空 `new_value`=JSON 串 `'null'`（⚙️17）。
- 写路径 **不得复用** `PlatformConfigService.set()`；**不得 publish**（无广播）；错误 message **不得内嵌值**。
- 平台纪律：Windows 先跑绿（`MSYS_NO_PATHCONV=1`）；实现期只跑受影响包测试，**六阶段只在 push 前跑一次**；conformance 全序只在验收跑。

---

### Task 1: protocol 键空间与 RPC pattern（T1）

**Files:**
- Create: `packages/protocol/src/pay-channel.ts`
- Modify: `packages/protocol/src/index.ts`（re-export）· `packages/protocol/src/rpc.ts`（`RPC_PATTERNS` +2 类型）· `packages/protocol/src/messages.test.ts:53-78`
- Test: `packages/protocol/src/pay-channel.test.ts`（新）

**Interfaces:** Produces: `PAY_CHANNEL_KEYS` · `PayChannelKey` · `PAY_CHANNEL_SECRET_KEYS` · `ConfigPayChannelGetRequest{pullToken,meta?}` · `ConfigPayChannelGetResponse{values:Partial<Record<PayChannelKey,string>>}` · `RPC_PATTERNS.configPayChannelGet='config.payChannel.get'`。

- [ ] **Step 1**：写测试（`pay-channel.test.ts`）：六键数组逐字 + secret 子集恰 `['pay.channel.privateKey']` + 与 `CONFIG_KEYS` 交集为空。
- [ ] **Step 2**：跑测试看红：`pnpm -F @fight-the-landlord/protocol test`（模块不存在）。
- [ ] **Step 3**：实现 `pay-channel.ts`（内容 = 规格 §2.1 代码块逐字）；`rpc.ts` 加 pattern（含注释：「支付配置管理化片；请求/响应类型见 ./pay-channel」）+ `ConfigPayChannelGetRequest/Response`；`index.ts` re-export。
- [ ] **Step 4**：`messages.test.ts` 的 `RPC_PATTERNS` toEqual 全量 +1（标题「十五键」按实际数改）；跑测试全绿（含该文件）。
- [ ] **Step 5**：Commit：`feat(protocol): pay-channel 键空间与 config.payChannel.get pattern（T1）`

### Task 2: config-service 迁移 + 假库扩表（T2）

**Files:**
- Create: `packages/config-service/src/migrations/1792000000000-PayChannelConfig.ts`
- Modify: `packages/config-service/test/helpers/config-probe.ts`（假库扩 `pay_channel_config`）
- Test: 既有 `migration.test.ts` 形态 +1 用例（建表/回滚）

**Interfaces:** Produces: 表 `pay_channel_config`（规格 §2.2 DDL 逐字；`down` = DROP）。

- [ ] **Step 1**：按规格 §2.2 DDL 逐字写迁移（类名 `PayChannelConfig1792000000000`；`CREATE TABLE IF NOT EXISTS` + 反引号 `key`）。
- [ ] **Step 2**：假库 helper 扩表（照现有 `platform_config` 假表形态 + 支持 `ON DUPLICATE KEY UPDATE` 语义——评审已实证该形态可扩）+ **一格 smoke**（假库建表后 INSERT+SELECT 往返——该扩表由 T4 首度行使，防「到 T4 才发现扩错」，评审 F8）。
- [ ] **Step 3**：跑 `pnpm -F @fight-the-landlord/config-service test` —— 全绿（迁移用例 + 既有 34 键面**不红**）。
- [ ] **Step 4**：Commit：`feat(config-service): pay_channel_config 迁移 + 假库扩表（T2）`

### Task 3: 校验器 + 加密模块（T3）

**Files:**
- Create: `packages/config-service/src/pay-channel/pay-channel.validators.ts` · `pay-channel.crypto.ts`
- Test: `packages/config-service/test/pay-channel.validators.test.ts` · `pay-channel.crypto.test.ts`

**Interfaces:** Produces: `validateAndNormalize(key, raw): {ok:true,canonical}|{ok:false,reason}`（reason 不含值）· `encrypt(name, plaintext)`·`decrypt(name, enc)`·`fingerprintOf(canonical)`·`parseMasterKey(env)`。

- [ ] **Step 1**：测试——校验矩阵正反（规格 §2.4 表逐格：PEM↔base64 两态**同 canonical/同指纹**、坏 PEM、空串、超长、坏 URL、非数字 PID）；理由文本**不含输入值**（合成含标记串的坏值 ⇒ 断言理由无该串）。
- [ ] **Step 2**：测试——加解密：往返；AAD 绑定（错键名解密必败）；`v1:` 前缀/截断/garbled ⇒ 抛；主钥缺失/长度非 32 ⇒ 视同未设。
- [ ] **Step 3**：实现（canonical 规则 = §2.3 逐字；密钥两键用 `crypto.createPrivateKey/createPublicKey` 解析；PEM↔base64 归一 `base64(trimmedPem+'\n')`）。
- [ ] **Step 4**：跑测试全绿；Commit：`feat(config-service): 渠道校验器与 AES-GCM 加密模块（T3）`

### Task 4: service 层（T4）

**Files:**
- Create: `packages/config-service/src/pay-channel/pay-channel.service.ts`
- Test: `packages/config-service/test/pay-channel.service.test.ts`

**Interfaces:** Produces: SQL 常量四个（规格 §2.2 逐字，全文被单测钉）· `status()` · `set(key,value,actor)` · `clear(key,actor)` · `pull()`。

- [ ] **Step 1**：测试——写事务三段序（锁→upsert→审计同事务）；密键审计 redacted / 非密 JSON 串 / 清空 `'null'` 串 / 无行 clear 不落审计；`status()` 六项固定序 + secret value 恒 null；**1213 重试注入**（mock 首次抛 1213 ⇒ 成功；连抛 3 次 ⇒ 抛/500 路径）——捕获边界包住整个事务（§3.1 U-2）。
- [ ] **Step 2**：实现（事务照 `platform-config.service.ts:110-175` 形态；**不 publish**；`requireActor` 不在此层）。
- [ ] **Step 3**：跑测试全绿；Commit：`feat(config-service): pay-channel service（状态/写/清空/拉取 + 1213 有界重试）（T4）`

### Task 5: 管理三端点 controller + 模块注册（T5）

**Files:**
- Create: `packages/config-service/src/pay-channel/pay-channel.controller.ts`
- Modify: 相应 `*.module.ts`（定位既有 `AdminController` 注册处）
- Test: `packages/config-service/test/pay-channel.controller.test.ts`

**Interfaces:** Produces: `GET/PUT/DELETE /api/admin/pay-channel[/:key]`（契约 = 规格 §2.4 表逐字：401 requireActor 先行 · 400 未知键/空串/校验不过 · 503 主钥缺 · DELETE 幂等）。

- [ ] **Step 1**：测试三端点全契约（401/400/503/200 形状；403 不在本层——网关管）。
- [ ] **Step 2**：实现（`@Controller('admin')` + `@UseGuards(XAdminGuard)`；`requireActor` 自 `admin-accounts.service.ts:89`；错误体照 `admin.controller.ts:193-211` 形态；503 文案 ⚙️18）。
- [ ] **Step 3**：跑测试全绿；Commit：`feat(config-service): 管理面 pay-channel 三端点（T5）`

### Task 6: RPC 接收侧（T6）

**Files:**
- Modify: `packages/config-service/src/rpc/config.rpc.controller.ts`（同控制器第二 `@MessagePattern`）
- Test: `packages/config-service/test/config.rpc.test.ts` +用例

**Interfaces:** Consumes: `PayChannelService.pull()`；Produces: `config.payChannel.get` handler（R220 信封；令牌常数时间比对；缺主钥 `{ok:false,10007,'渠道密钥存储未启用'}`）。

- [ ] **Step 1**：测试——正确令牌 ⇒ `{ok:true,data:{values}}`（仅已配置键）；错/缺令牌 ⇒ `ok:false`；主钥缺 ⇒ `ok:false,10007`；J21 承载闸（`robot-availability-wiring.gate.test.ts`）**仍绿**。
- [ ] **Step 2**：实现（`timingSafeEqual(sha256(a),sha256(b))`；env 未设 ⇒ 一律拒；失败不抛）。
- [ ] **Step 3**：跑测试全绿；Commit：`feat(config-service): config.payChannel.get 接收侧（拉取令牌）（T6）`

### Task 7: 网关 policy + 转发（T7）

**Files:**
- Modify: `packages/api-gateway/src/auth/admin-policy.ts`（P9 前加两条）· `packages/api-gateway/src/gateway/gateway.controller.ts`（三条转发方法）
- Test: 网关既有 policy/转发测试族 +用例（含变体矩阵 §4 逐格 + 近邻 `PUT /api/admin/config/pay.channel.privateKey ⇒ 400`）

**Interfaces:** Produces: `PUT/DELETE /api/admin/pay-channel/*` ⇒ super_admin；GET 落 P8；转发 `:key` 走 `encodeURIComponent`（R75）。

- [ ] **Step 1**：测试（policy 正反 + 变体 + 未登记写 fail-closed 不回退）。
- [ ] **Step 2**：实现（注释引用 §4 与 B1 教训：「将来再分权必须字面路由+变体负例」）。
- [ ] **Step 3**：跑测试全绿；Commit：`feat(gateway): pay-channel 管理写路由与 policy（E′）（T7）`

### Task 8: payment 客户端 + 拉取服务（T8）

**Files:**
- Modify: `packages/payment-service/src/config/config.client.ts`（+`payChannel(pullToken)`，1000ms 桥）· `src/config/config.module.ts`
- Create: `packages/payment-service/src/config/pay-channel.config.service.ts`
- Test: `packages/payment-service/test/pay-channel.config.test.ts`

**Interfaces:** Produces: `PayChannelConfigService.get(): Promise<Partial<Record<PayChannelKey,string>>|null>`（现拉/整图替换/回落 lastGood+WARN/从未成功 null；`PAY_CHANNEL_CLIENT_TIMEOUT_MS=1000`；`.send` 带 meta）。

- [ ] **Step 1**：测试——成功整图替换（图 A 后图 B 少一键 ⇒ 该键即缺）；失败回落；从未成功 ⇒ null；超时 1000ms；mock proxy 断言 `.send` 实参含 meta。
- [ ] **Step 2**：实现（桥照 `config.client.ts:112-146` 同款手工桥；**值导入**接线防 DI 陷阱）。
- [ ] **Step 3**：跑测试全绿；Commit：`feat(payment): PayChannelConfigService 每调用拉取+整图回落（T8）`

### Task 9: 三消费点改造 + 文案 + 既有单测（T9）

**Files:**
- Modify: `src/channel/alipay/client.ts`（`readConfig(creds)` 纯函数 + `callApi` 现拉 + 文案 ⚙️16）· `src/notify/notify.service.ts`（三读点）· `src/orders/orders.service.ts`（`publicBaseUrl` async 化）
- Test: `test/notify.test.ts:116-121` · `test/sign.test.ts:303-313` · `test/orders-state.test.ts:486-492,642-666` 改造（env 注入 → mock 通道服务；**断言语义零改**）；⚠️ **唯一例外**：`test/notify.test.ts:605` 的 warn 文本断言 `includes('ALIPAY_SELLER_ID')` 随 §2.9 新文案更新（**文案耦合非语义**，评审 F3 实读确认全仓恰此一处）

**Interfaces:** Consumes: T8 的 `get()`。映射表 = 规格 §3.3 逐行（`creds?.['pay.channel.x'] || ''` / `decodePem(creds?.[...])`）。

- [ ] **Step 1**：改造三单测的注入面（由红自曝驱动）。
- [ ] **Step 2**：实现三消费点（语义逐字保持；warn 文案 §2.9 三个引点）。
- [ ] **Step 3**：跑 `pnpm -F @fight-the-landlord/payment-service test` 全绿；Commit：`refactor(payment): 渠道三消费点改拉取通道（语义等价）（T9）`

### Task 10: 管理页「支付渠道」视图（T10）

**Files:**
- Modify: `admin/index.html`（nav 按钮 + section）· `admin/app.js`（VIEWS/VIEW_ORDER/懒加载/渲染/角色门/CONFIG_NOTES 搭车补九键；:274 视图清单注释顺手更新）· `tools/conformance/src/slices/slice-19-admin-rbac-audit.ts`（**G12 追针**，照风控/支付片先例 :1419-1423）
- Test: **build edge 镜像后跑 slice-19 G12**（served `app.js` 逐字 = 仓库文件；追针内容 = 新视图 id/导航/槽选择器）。⚠️ 全仓无「admin 静态串」单测（评审实证）——静态面判据在 G12，**不新建单测文件**（F2）；加视图**不撞任何计数/枚举断言**（已实核）。

**Interfaces:** Produces: 视图 key `payChannel`（roles `['super_admin','operator','finance']`，写控件仅 super_admin）；选择器 `.pay-channel-row-{slot}`（槽名六值）；文案 §2.8 ⚙️12。

- [ ] **Step 1**：实现（view 排 `config` 后第 2 位；懒加载 `GET`；非密键不预填值；私钥 password 输入 + 指纹显示）。
- [ ] **Step 2**：build edge——**必须带显式端口与 profile**（照全仓唯一先例 `slice-14:577-580` 形态；G1）：`docker compose build edge` 后 `EDGE_HTTP_PORT=8080 EDGE_HTTPS_PORT=8443 docker compose --profile edge up -d --no-deps --wait edge`。⚠️ 裸 `up -d edge` 会把门口挪到 80/443（基文件 :633-634 与 override :133 的 `:-` 回落值不同——本仓注释 `slice-14:58-62` 逐字记过此坑；memory 第 18 条同族）⇒ G12 及一切门口探针环境性红。⇒ 跑 G12 追针 +绿；Commit：`feat(admin): 支付渠道视图（掩码写）（T10）`

### Task 11: compose/override + redact + design-md 闸（T11）

**Files:**
- Modify: `docker-compose.yml`（payment 段删六行+加令牌；config-service 段加两行）· `docker-compose.override.yml`（删 :127；两服务段加空默认透传两行）· `packages/shared/src/logging/redact.ts:85` · `packages/shared/test/design-md-ai-rollout.gate.test.ts:82,122-129` · **`docs/design.md` §2.3 :198-199**（删两退役行 + 加两新键行）
- Test: shared 两个测试族 +用例

**Interfaces:** compose 差异逐行 = 规格 §2.7（六行 = :354,355,356,357,361,365）；redact 加 `privateKey|pullToken`；闸 `NEW_ENVS+2`/`RETIRED_ENVS+2` 两侧极化。

- [ ] **Step 1**：redact 测试（键名命中）+ 实现；闸测试改（**先红后绿**验证新 env 名两侧）。🔴 **F1：design.md §2.3 的四行（删 :198/:199 + 加两行）必须在本任务内与闸同提交**——闸（`NEW_ENVS` 正向 + `RETIRED_ENVS` 反向）断言的就是 §2.3 文本，文档不同步 ⇒ 本提交起 CI 连红。
- [ ] **Step 2**：compose 改动 + `docker compose config` 渲染检查（本机）。
- [ ] **Step 3**：跑 shared 测试全绿；Commit：`chore: compose 差异 + redact 规则 + env 闸极化（T11）`

### Task 12: 备份剥离 + slice-07.5 改造（T12）

**Files:**
- Modify: `scripts/ops/backup.sh`（ⓒ 段 awk 剥离，⚙️14）· `tools/conformance/src/slices/slice-07.5-backup.ts`（判据 d 派生期望 + 负对照改基 + 播种源加 `PAY_CONFIG_ENC_KEY=probe`）
- Test: slice-07.5 单跑（真栈）

**Interfaces:** 派生规则 = ⚙️15（`^PAY_CONFIG_ENC_KEY=` 过滤，行序不变）；负例 = 未剥合成输入 ⇒ 新断言必红。

- [ ] **Step 1**：backup.sh 改 + 本机手工验证（造含该行的 .env，跑脚本，`zcat env-*.gz` 无该行、其余逐字）。
- [ ] **Step 2**：slice-07.5 改造（判据 d 期望 + :1453-1466 负对照第一条改对派生期望比对）。
- [ ] **Step 3**：Commit：`feat(ops): 备份剥离 PAY_CONFIG_ENC_KEY + slice-07.5 派生判据（T12）`

### Task 13: conformance 基建（stub + lib）（T13）

**Files:**
- Modify: `tools/conformance/stub/alipay-stub.mjs`（`const appPublicPem`→`let`；新 `/_control/set-app-public?pem=<urlencoded PEM>`；:31-34 注释订正）· `tools/conformance/src/lib/http.ts`（+`adminPayChannelGet/Put/Delete`）· `tools/conformance/src/lib/rpc.ts`（+CONFIG endpoint 3106；头注版本订正 G9）
- Test: stub 单跑（起容器 curl 控制面）

**Interfaces:** Produces: 状态可复位（`/_control/state` 扩 `appPublicFingerprint`？按需）；`rpcCall(CONFIG, 'config.payChannel.get', {pullToken})` 可用。

- [ ] **Step 1**：stub 改造 + 手工 curl 验证（换钥后 wapPay 验签行为翻转）。
- [ ] **Step 2**：lib helper + endpoint；Commit：`feat(conformance): stub 换钥控制面 + 管理面 helper + CONFIG RPC 探针（T13）`

### Task 14: 栈脚本种子化 + run.ts 供给（T14）

**Files:**
- Modify: `scripts/deploy/conformance-stack.sh`（删五条 export 保留 :51；+两 export；up 末尾种子块：登录+PUT 六键，`node -e` 解析，失败响亮 exit 1；**就绪条件现成**——两条 up 路径均 `--wait --wait-timeout 900`（:89/:94）+ 全 17 服务带 healthcheck，已实测；登录 curl 加**有界重试 2–3 次**保险；**down 无需清理**——种子只落 DB 行、PUT 幂等，评审 F7）· `tools/conformance/src/run.ts`（启动两行 `??=`，注释说明「单一 runner 供给点」）
- Test: 本机 `conformance-stack.sh up` 全跑（含种子自证）+ `down`

**Interfaces:** 种子值 = 规格 §5.4 逐字（publicBaseUrl 字面 `https://localhost:8443`）。

- [ ] **Step 1**：实现两文件。
- [ ] **Step 2**：`conformance-stack.sh up`（本机）⇒ 末尾打印种子成功；`docker exec` 抽查 `GET /api/admin/pay-channel` configured×6（先经网关/或直查表）。
- [ ] **Step 3**：Commit：`feat(conformance): 栈脚本种子化 + run.ts env 供给（T14）`

### Task 15: slice-21 改造（T15）

**Files:**
- Modify: `tools/conformance/src/slices/slice-21-payment.ts`（⓪ :527-533 断言替换为「env 无 ALIPAY_*」负断言 + 「种子生效」；⑬ :335-366 删五 pick + 注释；:622 核对）
- Test: slice-21 单跑（真栈）

**Interfaces:** ⚠️ 偏离登记：⓪ 的「env 实读」判据**替换**（机制面）；PAY_SCAN_* 两断言保留。

- [ ] **Step 1**：实现改造；**单跑机制 = `run.js slice-21`**（`CONFORMANCE_STEPS` 是片内步骤子集变量、不同轴——评审 F9 订正）⇒ 全绿（含 ⑬ 重建段）。
- [ ] **Step 2**：Commit：`test(conformance): slice-21 夹具改造（env 退役 + 种子生效）（T15）`

### Task 16: slice-22 新片（T16）

**Files:**
- Create: `tools/conformance/src/slices/slice-22-pay-channel.ts`
- Modify: `tools/conformance/src/run.ts` 注册表——**追加在 slice-21 条目（:82-83）之后**（纪律注释在 **:64**；「:56-57」是旧锚，评审 F6 订正）

**Interfaces:** 十组 + 收尾 = 规格 §5.2 逐条（含 ⑨ 冷启构造、⑩ 停服回落、⑧ 变体矩阵、⑦ base64 形态 + 判别力自证）；断言数首跑不设 baseline。

- [ ] **Step 1**：实现十组（组前置/末态照规格收尾段）。
- [ ] **Step 2**：单跑 slice-22 ⇒ 全绿；跑完 slice-21+22 连跑一次（跨片残留态验证）。
- [ ] **Step 3**：Commit：`test(conformance): slice-22-pay-channel 十组（T16）`

### Task 17: 文档面（T17）

**Files:**
- Modify: `docs/design.md`（§4.2/§4.3/§7.5/§7.7/§10.3 照规格 §6 行号表；**§2.3 已在 T11 随闸改，不重复**）· `docs/ops/first-deploy.md`（六项表→管理页指引 + 五步改写 + 轮换小节 + 恢复节主钥说明）· `docs/ops/alipay-onboarding.md`（§4/§5）· `deploy/monitoring/prometheus/rules/ftl-alerts.yml:196`（runbook 指向）· `docs/superpowers/plans/deviation-ledger.md`（+条：env 退役/slice-21 改造/slice-07.5 改造/校验器落点/统一加密/主钥轮换 YAGNI/G1 redact）

- [ ] **Step 1**：按规格 §6 表逐行改。
- [ ] **Step 2**：`design-md-*.gate.test.ts` 等机械闸跑绿；Commit：`docs: 支付配置管理化文档面同步（T17）`

### Task 18: 全序回归与收口（T18）

- [ ] **Step 1**：`bash scripts/ci.sh`——**六阶段逐字 = install/lint/build/test/coverage/eslint-forbidden**（真源 `scripts/ci.sh:2,67-110`；评审 F4 订正：conformance/浏览器不属六阶段，另列）→ 本机 **conformance 全序**（`run.js` 全片）→ 浏览器级抽查。
- [ ] **Step 2**：CI 权威轮（`ci` / `conformance` / `images` 三 workflow）——**baseline 回填**（slice-22 首值 + 改动切片校正）。
- [ ] **Step 3**：opus 整支终审 → 处置 → 收口交接文档（`plans/2026-10-06-post-pay-channel-handoff.md`）。
- [ ] **Step 4**：Commit（收口文档）+ 更新台账/memory。

---

## 执行纪律（全局）

- **逐任务子代理（sonnet）**，一任务一提交；**每 2–3 任务一波评审**（子代理审，只读发现）。
- 「跑了」指向本次日志；失败先单跑判假红（已知假红族见 memory）；真栈问题先查 stale 镜像/陈旧 dist。
- 实施期发现规格偏差 ⇒ **停手上报**，台账登记，走规格微审——不得自行拍板。
- 受影响包 = protocol · config-service · payment-service · api-gateway · shared(+admin 静态/conformance)。

## 自检记录（写计划时的对照）

- 规格覆盖：§2.1→T1 · §2.2→T2 · §2.3→T3 · §2.4/§3.1/§3.5→T3/T4/T5 · §2.5/§3.2→T6 · §4→T7 · §3.3/§3.4→T8/T9 · §2.8/§2.9→T9/T10 · §2.6/§2.7→T11 · ⚙️14/15→T12 · §5.4→T13/T14 · §5.3→T11/T12/T14/T15 · §5.2→T16 · §6→T17 · §5.5/§7→T18。**无缺项**。
- 类型一致性：`PayChannelKey`/`PayChannelConfigService.get()`/`adminPayChannel*` 在 T1/T8/T13 定义与后续引用一致。
- 顺序约束（评审 r1-F5 补全）：T1→(T3..T9)；T2→T4；T8→T9；**T5/T6/T7→T14**；**T11→T14/T15/T16**（compose 不落地 ⇒ 种子 503 / 「env 无 ALIPAY_*」不成立）；**T13→T15/T16（实需）**；T13→T14（仅序，运行期无实需）；T14→T15/T16（种子先于切片）；**T7→T16**；T17 独立（§2.3 除外——已在 T11 随闸）；T18 最后。
