# 通知通道管理化片 收口交接（2026-10-07 · 草案）

> **给新会话/未来的你**：本片 = 把告警通知九键（SMTP 五项 + 飞书/企微/钉钉 webhook 四项）从 `.env` 搬进
> config-service 第三键空间（加密存储 + 管理页掩码写 + 审计脱敏 + 专用拉取通道）；alert-relay 改拉取驱动、
> 新增 am-renderer 渲染 Alertmanager 配置并原地 reload；**邮件仍由 Alertmanager 原生发出**。
> **当前状态（2026-10-07 上线更新）**：**✅ 已上线 `v1.9.0`**（手动等价流程——Actions 额度耗尽，
> release 门禁轮待额度恢复后补跑，见 §0）；master 已推（`c91fa64..cbffe2e`）+ tag `v1.9.0` 已推；
> 部署后冒烟三连绿、19 容器（15 个 `:v1.9.0`）、**九值已导入**（6/9 配置：SMTP 五 + 企微；飞书/钉钉留后）、
> **验收测试告警双通道投递成功**（企微 relay `status:200` / 邮件 AM `notifications_total{email}=1` 零失败）。

---

## 0. 上线记录（2026-10-07，手动等价流程）

- **执行链**：本机 `build-images.sh v1.9.0`（bake 全 14 镜像推 GHCR）→ `deploy.sh v1.9.0`
  （tag 源 compose 送机 → 服务器 pull → `up -d` → 冒烟三连）→ 服务器侧导入九值 → 验收测试告警。
- **部署实证**：19 容器（15 `:v1.9.0` + mysql/redis/cadvisor/node-exporter 官方件）；`ftl-am-renderer` Up、
  live 卷 baseline → 全量演进；AM env 无 SMTP_*、relay env 无 IM 四键且 token SET、config-service token SET；
  **版本判别探针**：`GET /api/admin/notify-channel` 无鉴权 ⇒ **401**（旧版 404）、served `app.js` 含 30 处
  `notify-channel` needle；relay 启动 `sinks: 无`（空库）⇒ 导入后 `/data` 键 = `notify.webhook.wecomUrl`
  （**裁剪在线上实证：SMTP 口令未进 relay**）；renderer `配置已更新并重载`；AM 已载入 `smtp_smarthost:
  smtp.163.com:465`（密码 `<secret>`）；gauges `email 5/1 · dingtalk 0/0`；wecom hint 回显
  `https://qyapi.weixin.qq.com`（allowlist 线上实证）。
- **验收测试告警**：`NotifyAcceptanceProbe`（30 分钟后自动消解 ⇒ 会再收到一条「已解决」的**企微**消息，邮件不发
  resolved——`send_resolved:false`，属预期）。**待用户确认收到**（企微 + 163 邮箱各一条）。
- **待办**：① 用户确认验收 + **轮换演练**（企微后台重发 webhook ⇒ 管理页覆盖 ⇒ 指纹变化 ⇒ 再触发）；
  ② 验收通过后删服务器 `.env` 九行（回滚窗结束；此前保留）；③ **CI 权威轮**：额度恢复后补跑 release
  （含发布镜像上的 conformance；本轮 Actions 4–5 秒即败 = 额度未恢复）；④ slice-23 ⑥ 间歇的 CI 判定面。
- **回滚**：`rollback.sh v1.8.1` 或 `deploy.sh v1.8.1`（旧镜像仍在 GHCR；服务器 `.env` 九行未删 = 旧版仍可读 env）。

---

## 1. 三件套与评审链（唯一上游）

- 开工交接：`docs/superpowers/plans/2026-10-06-post-pay-channel-handoff.md` §8（第一梯队）
- 设计 **v1.3 冻结**：`docs/superpowers/specs/2026-10-07-notify-channel-admin-design.md`（`f695da2`；
  Q1 裁决 = renderer 侧车 · Q2-A 裁决 = 复用 `PAY_CONFIG_ENC_KEY`）
- 规格 **v1.3 冻结**：`docs/superpowers/specs/2026-10-07-notify-channel-admin-spec.md`（`edbb1f2`）
  + 实施期微审 **v1.4–v1.8**（`ddac50a` · `9394553` · `9954ab4` · `4e86844` · `9d1e9d3`）——
  **契约以 v1.9 文本为准**（runbook 注记键 / `%55` 变体格 / host 校验收紧 / 503 随服务端 message / 兜底
  ERROR；v1.9 = `70d3c4e`，§5.3 补核销 #19/#20）
- 计划 **v1.2 冻结**：`docs/superpowers/plans/2026-10-07-notify-channel-admin.md`（`da2c9db`；T1–T18）
- 评审报告（台账 `.superpowers/sdd/2026-10-07-notify-channel/`，gitignore）：design r1/r2 · spec r1/r2/r3 ·
  plan r1/r2 · W1–W6 波次评审 · **T18 全套日志**（六阶段 ×3 / 全序 / 逐红复跑 / 复盘对跑）；
  `progress.md` = 全程登记（**终态节在文末**，含三红逐条实证）

## 2. 交付了什么（一段话）

九键（`notify.smtp.host|port|user|pass` · `notify.email.to` · `notify.webhook.feishuUrl|wecomUrl|dingtalkUrl|
dingtalkSecret`）→ config-service 新表 `notify_channel_config`（AES-256-GCM，主钥复用 `PAY_CONFIG_ENC_KEY`，
Q2-A）· RPC `config.notifyChannel.get`（拉取令牌 `NOTIFY_CHANNEL_PULL_TOKEN` **三持有**）· 管理页「通知通道」
视图（两组渲染、掩码写只回指纹、URL hint、写面仅 super_admin）· 审计进既有 `config_changes`（五密键
`{redacted,fingerprint}`，四非密原文，清空 `'null'`）· relay 改拉取驱动（30s 轮询 + 拉后即裁四 IM 键 +
`/data` last-good 持久化；从未拉到 ⇒ 500）· **am-renderer**（拉取 → amtool 预检 → 原子写共享卷
`alertmanager-live` → `POST /-/reload`）· AM entrypoint 重写（等文件 90s → token 落盘 → amtool 预检 →
exec）· 完整性 gauges + 两规则（`NotifyEmailIncomplete` / `NotifyDingtalkIncomplete`）· conformance
**slice-23-notify-channel（380 断言）** + slice-16/18/19/07.2-deploy 改造。生产形态 18→**19 容器**（+am-renderer）。

## 3. 关键数字与台账

- 提交：`0617431`（设计首稿）→ `f695da2`/`edbb1f2`/`da2c9db`（三冻结）→ 实现 T1 `77745e1` … T16 `7afe0b0`
  → **W5 微修 `8610da8`** → T18 收口提交（本文件）。**未 push**（`git rev-list --count origin/master..master` = 39+）。
- 六阶段：**全绿**（`bash scripts/ci.sh`；权威轮日志 `t18-ci-postw5.log` = HEAD `8610da8` 树；run1 首跑仅
  game-service `rpc-listen-bind` 超时一次——已登记假红，单跑 2/2 + 整包 130/130 双绿实证）。
- conformance 全序：**25/28 绿**（`t18-full.log`），三红全分类（`t18-baseline-check.log` 对账）：
  - **slice-13**：常驻容器旧镜像前置红 ⇒ 按片内处方 `build douzero && up -d --force-recreate douzero`
    ⇒ 单跑 **35/35 绿**（环境形态；CI 新栈免疫）。
  - **slice-23**：⑥ 首步（AM 注入 ≤45s 窗）**1/5 间歇**，单跑 **380/380 绿 ×2**（含 slice-22→23 邻接
    复现对跑）；机制取证三方一致（调度时刻 relay 侧零活动 + AM 无 webhook 失败 WARN + 槽位=3 审计实证）
    ⇒ 疑 AM 调度瞬态；**CI 权威轮重验**。**本片两片读数：slice-23 = 380（下限，两跑逐字相等）·
    slice-16 = 90（新接线，下限 86）。**
  - **slice-07.4-pipeline**：**真红（确定性，单跑逐字复现）⇒ 已修并在本机复绿**——`70d3c4e`（双 pin 同
    步：`wantEx` +`1241259 @vue/server-renderer`、`topAllow` 5→7；规格 v1.9 同提交；单跑 **75/75 绿**，
    t19 双证〔`t19-slice07.4-repro.log` 红再现 → `t19-slice07.4-green.log` 绿〕）。两处 pin 漂移：
    C4：`59105ef`（支付片 v1.8.0 轮，**已在 origin**）加第三审计豁免未同步 `wantEx`；C6③：T17 +2
    gitleaks 允许清单未同步「须恰好 5」。
- 对账：26 片在场全 ≥ 下限；**唯一计数差 = slice-07.5-backup 184 < 196**（Windows 无 flock/script(1)
  的 14 条跳过面——与支付片 T18 逐字同数；基线不得下调）。baselines **无改动**。
- 单测（run3）：protocol 173 · config-service 347 · alert-relay 124 · shared 275 · api-gateway 406 ·
  game-service 130 · room-service 599 · user-service 249 · robot-service 118 · currency-service 226 ·
  payment-service 400 · client 729(+2 skip) · mock-server 10。

## 4. 上线脉络（**用户侧动作**）

1. **服务器 `.env` 先加一行**：`NOTIFY_CHANNEL_PULL_TOKEN=<openssl rand -hex 32>`（**config-service +
   alert-relay + am-renderer 三端同值**——compose 空默认透传，漏配 ⇒ 管理面照常但拉取全拒、通道不生效、
   relay 首启 `/webhook` 500；照「先补根信任锚」先例）。主钥 `PAY_CONFIG_ENC_KEY` **零新增**（Q2-A）。
2. **push master → 打 tag（`v*`）→ `deploy.sh` 部署**（19 容器新形态；am-renderer 起 → 卷出 baseline yml
   → AM healthy 自证）。
3. **部署后立即导入九值**（管理页手工，或服务器侧一行式：读 `.env` 九行旧键 → admin 登录 → PUT ×9；
   值不离开服务器）——⚠️ **导入窗口**：部署完成到第 3 步之间通道 = 未配置（这几分钟真出告警会丢；
   已登记、可接受 ⇒ **部署后立即做**）。服务器原九行 `.env` **暂留 = 回滚窗**。
4. **验收（真人项）**：触发测试告警（停 `ftl-grafana` 2 分钟配方）⇒ **收真邮件 + 真企微**；
   再做企微轮换演练（后台重发 webhook → 管理页覆盖 → 指纹变化 → 新群收到，全程不重启不发版）。
5. 观察通过后（裁决）删服务器/本机 `.env` 九行（**不删也无害**——无容器再读）。
6. **回滚**：九行保留至验收通过；**回滚必须经 `deploy.sh`/`rollback.sh`**（送机 compose 取自目标 tag）。
   ⚠️ 主钥 = 唯一顺路径：**恢复须用原钥副本**——换新钥 ⇒ 非密键的改/清也会 503（旧值解密失败挡回；
   已登记缺陷），只能手工清行重填（手顺见 `first-deploy.md` 恢复节）。

## 5. 残余 / 未闭项（与台账终态节同集合）

- **slice-07.4 真红 —— 已闭环**（`70d3c4e`：双 pin 同步——`wantEx` +`1241259 @vue/server-renderer`、
  `topAllow` 5→7 + 规格微审 v1.9〔§5.3 补 #19/#20〕；单跑 75/75 绿，t19 双证）。
- **slice-23 ⑥ 间歇**（1/5；CI 权威轮重验，复发即升格）。
- **CI 权威轮**（Actions 额度恢复后）：全序复核 + baselines 最终校正（slice-16=90 / slice-19=487 等
  向上漂移是否回填、slice-23=380 复核——同 slice-21/22 口径）。
- 常驻栈镜像相位注记（relay/renderer 容器为 T15 构建，先于 `8610da8` 两行日志级别；不触判据面）。
- 已知缺陷：换钥后非密键不可修复（原钥副本唯一顺路径）· 存储健康观测缺口（主钥坏 ⇒ gauge 照数/规则
  不响/admin 503 而 relay/renderer last-good 续投——未来片）· pay 三处 503 文案同缺陷。
- **I-2（终审新发现）**：am-renderer 生产可用性信号缺口（无 expose/healthcheck/metrics、不在
  `EXPECTED_JOBS`；持续故障 ⇒ 配置更新静默冻结）——建议随 N113「存储健康告警」未来片一并收编。
- Minor 池 + 技术债池 ①–⑨（台账在案，供终审 triage）。
- **命名卷跨 run 残留面（登记）**：`alertmanager-live` 卷内 yml 若「崩在 ⑦–收尾之间」残留 smtp.invalid
  值 —— **下一轮首拉 ≤30s 收敛**（收尾收敛自证已实证）；AM 以其启动无害（smtp.invalid 仅真发信时失败）；
  `relay-data` 卷同理（内容 = 裁剪后四键 JSON，不含 SMTP）。两卷均含通知配置（非凭据原文以外的新面）。
- `.env` 九行清理（服务器 + 本机）待验收后；down-rm `+am-renderer` 无机械判据（留目）。

## 6. 新会话入口（读什么）

1. 本文件 → 2. 规格 **v1.9**（契约唯一真源）→ 3. 台账 `progress.md` **终态节**（三红实证/对账/核销全链）→
   4. `docs/ops/first-deploy.md`「通知怎么上线（三步）」+ `docs/ops/notify-onboarding.md`（平台取址/轮换/验收）。

**恢复口令**（如需要）：「继续通知通道管理化片收尾：读 `docs/superpowers/plans/2026-10-07-post-notify-channel-handoff.md`。」
