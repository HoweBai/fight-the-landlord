# 支付配置管理化片 收口交接（2026-10-06）

> **给新会话/未来的你**：本片 = 把支付渠道六项凭据从 `.env` 搬进 config-service 的第二键空间（加密存储 + 专用拉取通道 + 管理页掩码写 + 审计脱敏）。
> **当前状态（2026-10-06 更新）：已 push（80 提交）+ tag `v1.8.0` + ✅ 已上线**（手动部署，全项冒烟绿——当日 GitHub Actions 额度耗尽，发布门禁轮以本机等价流程完成，「CI 权威轮」登记为额度恢复后随 v1.8.1 补跑）。**下一步 = 沙箱联调（含 Q4 轮换演练）**。

---

## 1. 三件套与评审链（唯一上游）

- 开工交接：`docs/superpowers/plans/2026-10-06-payment-config-admin-manage.md`（`bac4fee`）
- 设计 **v2.2 冻结**：`docs/superpowers/specs/2026-10-06-pay-channel-admin-design.md`（`665a57a`；产品问 4 裁决 + E′ 复审）
- 规格 **v1.3 冻结**：`docs/superpowers/specs/2026-10-06-pay-channel-admin-spec.md`（`5101f22`；⚙️1–18 + §5 判据 + §6 文档面）
- 计划 **冻结**：`docs/superpowers/plans/2026-10-06-pay-channel-admin.md`（`3090873`；T1–T18）
- 评审报告（台账 `.superpowers/sdd/2026-10-06-pay-config/`，gitignore）：design r1/r2 · spec r1/r2/r3 · plan r1/r2 · wave1/2/3 · **final-opus**；`progress.md` = 全程登记（含全部记法级偏差与残余）

## 2. 交付了什么（一段话）

六键（`pay.channel.gatewayUrl|appId|privateKey|publicKey|sellerId|publicBaseUrl`）→ config-service 新表
`pay_channel_config`（AES-256-GCM，主钥 `PAY_CONFIG_ENC_KEY` 只在该服务）· 新 RPC `config.payChannel.get`
（拉取令牌 `PAY_CHANNEL_PULL_TOKEN` 双持有；payment 侧**每调用现拉 + 失败整图回落**）· 管理页
「支付渠道」视图（私钥只写不可读、只回指纹；E′ 六项写面仅 super_admin）· 审计进既有 config_changes
（密类 `{redacted,fingerprint}`，清空写成 JSON `'null'`）· 备份按 ⚙️14 剥离主钥行 · conformance
**slice-22-pay-channel（十组 243 断言）** + slice-21 夹具改造（321）。

## 3. 关键数字与台账

- 提交：`87278f6`（设计首稿）→ `665a57a`（设计冻结）→ `5101f22`（规格冻结）→ `3090873`（计划冻结）→
  实现 20 笔（T1 `6503451` … T17 `ca6a643`）+ 评审修 `ed4a33b`/`5f07432`/`aecaa80` + T18 `a98b1a6`/`7d4c835`（+本交接文档）。
- 六阶段：**全绿**（`bash scripts/ci.sh`）。
- conformance 全序：**27/27 片全绿**（分四轮推进；三处中途红全为**脏卷历史残留/旧镜像**形态，逐条已实证归因，CI 全新卷不受影响：
  ① slice-13「douzero 旧镜像」前置 ⇒ 重建处置；② slice-17 ⑨ 全局 gauge 断言撞 10-05 先存漂移账户（diff −100）
  ⇒ 以流水为准修复后复证 ✅172；③ slice-19 G6 前置撞 10-05 残留探针超管账号 ⇒ 停用后 ✅484）。
  本片两片读数：**slice-21-payment = 321 · slice-22-pay-channel = 243**（与所装 baseline 逐字相等）。
  日志 `t18-*.log`（台账）；总对账唯一 ❌ 差 = slice-07.5 本机 184<196（Windows 无 flock/script(1) 的 14 条已登记跳过面）。
- baselines：`slice-21-payment 312→321`、新增 `slice-22-pay-channel=243`（本机实况口径；**待 CI 权威轮按实测复核/校正**——同 slice-21 先例）。
- 单测（opus 独立复跑）：protocol 168 · config-service 239 · payment-service 400 · api-gateway 390 · shared 273。

## 4. 上线脉络（**用户侧动作**）

1. ✅ **服务器 `.env` 两枚根信任锚**（已加，部署验证 `ENC_KEY=SET`/`PULL_TOKEN=SET`）；
2. ✅ **push master + tag `v1.8.0`**（已推，80 提交含支付片 + 本片）→ ✅ **v1.8.1 已推并部署**（2026-10-07 联调现场修：校验器补第三态「控制台直出裸 base64」+ 管理页密钥两键改 textarea——单行 input 会吃掉 PEM 换行；同口径手动部署，14 容器 `:v1.8.1`、served==仓库零差异、容器内端到端验证裸 base64 ACCEPTED）。⚠️ 当日 Actions 额度耗尽 ⇒ release 门禁轮以本机手动等价流程完成（记录在台账）；**CI 权威轮 = 额度恢复后对 `v1.8.1` 补跑**（全部提交已推）；
3. ⏳ **管理页填沙箱六值** → 沙箱联调（下单→付→回调→入账→退款全链；**含轮换演练**＝Q4 真人验收：换密钥对 → 上传新公钥 → 管理页覆盖私钥 → 指纹变化可见 → 全链复跑；临时开/关开关写法见 `first-deploy.md`「支付怎么上线（五步）」）；
4. ⏳ 管理页换**生产值** → 开充值开关（提现更晚，先观察）——开关默认关，全程暗上线；
5. **回滚窗**：服务器 `.env` 里旧六行（若曾填过）保留至首轮验收通过后再删；回滚 = `IMAGE_TAG=v1.7.0` 重建（旧镜像仍在服务器）。

## 5. 运维口径（已入手册）

- **轮换（应用私钥）四步**：支付宝后台生成新密钥对 → 上传新应用公钥 → 管理页私钥字段覆盖写入（指纹肉眼变化）→ 旧钥即废。泄露应对：渠道后台重签 + 订单/流水核对。
- **恢复**：备份的 `.env` 副本**不含**主钥（剥离锚定行首裸 `KEY=` 行）；恢复需**另持主钥副本**；主钥丢失 ⇒ 渠道六值重填。
- **只写不可读**：私钥任何角色都读不回（GET 只给指纹）；改=覆盖、清空=删除（DELETE 后回「未配置」语义=15001/回调拒，照旧语义）。

## 6. 已登记残余 / 未闭项（全部在案，供后片）

- **待 CI 权威轮**：baselines `321`/`243` 校正。
- **设计已登记残余**：内网明文传输面（拉取每调用一次）· per-service 身份可见性（未做，独立立项）· 主钥轮换机制（YAGNI）· W3-1 管理页角色门「读验代测」· W3-2 stub `set-app-public` 形状拒未加 · 备份剥离锚定假设（前导空白/`export ` 前缀不剥，手顺维持裸 `KEY=`）· slice-07.5 ORS 边角声明 · 端到端日志判据面=payment+config 两容器（网关面已独立穷举无落点，登记）。
- **真机验收（Q4，用户在场）**：轮换演练。

## 7. 新会话入口（读什么）

1. 本文件 → 2. 规格 v1.3（契约唯一真源）→ 3. 台账 `progress.md`（全程登记/偏差/评审）→
   4. `first-deploy.md`「支付怎么上线（五步）」+「密钥轮换」节（运维手顺）。

**恢复口令**（如需要）：「继续支付配置管理化片收尾：读 `docs/superpowers/plans/2026-10-06-post-pay-channel-handoff.md`。」

## 8. 下片候选：`.env` 还能搬什么（2026-10-07 复扫确认，基于设计附录 A 盘点）

**第一梯队 · 通知通道（推荐下一片，复用本片全套机制）**：`SMTP_HOST/PORT/USER/PASS` · `ALERT_EMAIL_TO` ·
`WECOM_WEBHOOK_URL`（现役）+ `FEISHU_WEBHOOK_URL`/`DINGTALK_WEBHOOK_URL`/`DINGTALK_SECRET`（留后待配）。
价值：webhook URL / SMTP 口令**本质是凭据**（URL 即密钥）⇒ 复用本片的加密存储 + 掩码写 + 审计脱敏 +
专用拉取通道形态；日后换通知渠道无需 SSH。代价：alert-relay（自研 Node）好改；alertmanager（官方镜像
+ entrypoint 生成配置）需照 `config.payChannel.get` 增一条「拉取通道」，中等工程量。

**第二梯队 · 节奏/清理旋钮（值低，可搭车或再下片）**：`PAY_SCAN_INTERVAL_MS` · `PAY_RECONCILE_INTERVAL_MS`
（唯一带「生产可调」属性的支付间隔）· `CURRENCY_RECONCILE_INTERVAL_MS` · `RISK_SCAN_INTERVAL_MS` ·
`RECORDS_CLEANUP_INTERVAL_MS` · `RISK_DEVICES_CLEANUP_INTERVAL_MS`。代价：进业务键面 ⇒ 撞「34 键面 12 处
硬断言」（全量更新）+ 各循环改造；收益仅运维深水区。

**第三梯队**：`GRAFANA_ADMIN_PASSWORD`（需 grafana entrypoint 拉取改造，收益低）；`GF_*` 为 grafana 官方
镜像键 ⇒ 不动。

**不可搬（硬性理由）**：根信任锚/自举循环——`JWT_SECRET`·`ADMIN_JWT_SECRET`·`ADMIN_PASSWORD`·
`INTERNAL_SERVICE_TOKEN`·`DB_PASSWORD`·`PAY_CONFIG_ENC_KEY`（管理页的登录/鉴权/DB/加密靠它们本身）；
部署拓扑/门面——`SITE_ADDRESS`·`TLS_MODE`·`TRUST_PROXY`·全部 `*_SERVICE_URL`/`*_RPC_HOST/PORT`·`REDIS_URL`·
`RPC_PORT`·`DOUZERO_URL`；测试注入——`CONFIG_SYNC_*`；构建期——`VITE_*`；部署身份——`SSH_*`/`GHCR_*`/
`IMAGE_TAG`/`GITHUB_TOKEN`（见设计附录 A 逐条理由）。

**顺手清理项**：本机根 `.env` 的 `DB_HOST/PORT/USER` + 四个 `*_SERVICE_URL` + `DOUZERO_URL` 是**遗留副本**
（compose 不读）⇒ 可删防误改。
