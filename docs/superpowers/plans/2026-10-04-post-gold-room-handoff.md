# ②金币场 收口后的交接（2026-10-04）

> **给新会话**：本文 + 自动加载的 `MEMORY.md`（重点 `p2-gold-room-slice` / `p2-currency-slice` / `ci-flake-known` / `monitoring-slice-in-progress` / `token-economy-model-tiering`）即可续跑。
> **状态**：✅ **②金币场全链完成并 push**（CI 三绿）**且已上线 `v1.5.0`**（2026-10-04 夜，release 三 job 绿）。

---

## 1. 现在的状态

| 事项 | 状态 | 关键入口 |
|---|---|---|
| ② 设计/规格/计划 | ✅ 全链定稿（设计 v1.2 两轮评审+**用户确认**；规格 v1.4；计划 v1.1） | `docs/superpowers/specs/2026-10-04-gold-room-{design,spec}.md` · `docs/superpowers/plans/2026-10-04-gold-room.md` |
| ② 实现 | ✅ T1–T13 + 修复批（`adf6c1b..bbfd54e`），各任务/波次门全过 + **opus 整支终审零 Critical**（2 条一行修已落） | 台账 `.superpowers/sdd/2026-10-04-gold-room/progress.md`（核销表+全部审批/登记） |
| 准入硬前置 ⚙️14 | ✅ T1 通过（真库双会话：正向 10001+整批回滚；**负对照用修复前文件复现假闭合红**） | `t1-evidence.md` |
| 本机六阶段 | ✅ 绿（第 4 次尝试；前三次各撞**不同的注册家族假红**、逐个单跑证实） | 见 §5 假红 |
| 本机全序 23 片 | ✅ 跑完（唯一红 = slice-06 旧二值 mode 断言被残留金币房咬中 → 修复+再认证 132） | `/tmp/full-run.log`（临时）·台账 |
| 远端 CI 权威轮 | ✅ **三绿**：ci 5m31s · **conformance 28m44s（全序 23 片）** · images 7m31s（`bbfd54e`，runs 37190866982 / 37190866979 / 37190866907） | `gh run list --commit bbfd54e` |
| 上线 | ✅ **已上线 `v1.5.0`**（2026-10-04；release 三 job 绿、服务器 17 容器全 v1.5.0 healthy；**首轮 deploy 撞手册详注⑨「edge 非 root 化卷属主迁移」已照手册修复**） | §2 |
| 用户后续项 | 只剩一件 + 两处节奏：**配告警通知通道**（见 §2.5）· 想开金币场时开开关 · 开救助前先接广告小片 | §2 |

## 2. 上线四件（**2026-10-04 夜全部执行完毕**）

1. ✅ 服务器 `.env` 加 `GRAFANA_ADMIN_PASSWORD`（已写入并生效）。
2. ✅ **tag `v1.5.0` 已打并上线**（monitoring + 货币核心 + 金币场三合一；release 三 job 绿）。
3. ✅ **Grafana 演练已做**：停 2 分钟 → Alertmanager 131 秒后 `ServiceDown | grafana 抓不到了 | active` → 恢复 healthy。
4. ✅ **虚拟池种子已放**：5 笔 ×100 万，池余额 **5,000,000**（`robot-pool`）。

**只剩一件（需要你的凭据）——配告警通知通道**：`ServiceDown` 在监控里**确实打铃了**，但 `.env` 里没有任何通知通道（无 SMTP、无 IM webhook）⇒ 这声铃**没有送达任何地方**。二选一即可（手册「监控（看板与告警）③」有逐项表格）：
- **邮箱**：填 `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS`（授权码）+ `ALERT_EMAIL_TO`（五项全填）；
- **或 IM 群**：填 `FEISHU_WEBHOOK_URL` 或 `DINGTALK_WEBHOOK_URL`+`DINGTALK_SECRET` 或 `WECOM_WEBHOOK_URL`（拿群机器人 webhook）。
填完 `.env` 后**再走一次部署**（打新 tag）才生效；生效后随便停个 Grafana 复验一次即可。

**✅ 通知通道已完成（2026-10-05 凌晨，v1.5.1）**：邮箱（163 SMTP 465）与**企微**已配置并经**真投递复验**——停 Grafana ⇒ `ServiceDown` ⇒ AM `notifications_total{email}=2/{webhook}=1`、**failed_total 全 0** ⇒ relay 企微 `status:200`；心跳邮件 ~24h 内首达。**钉钉/飞书留后**（有 webhook 时同法补键 + 再发一次）。

**开关节奏（本片交付默认值）**：金币场 `room.goldRoomEnabled` **默认开**（2026-10-04 用户裁决由「默认关/暗上线」翻转；生产库已由管理面置为开 —— 要关在管理页 `/admin` 改，口令 = 服务器 `.env` 的 `ADMIN_PASSWORD`）；**开启「每日救助」前必须先接广告小片**（现况=占位直接发放；广告 SDK 需你注册平台并提供广告位 ID，H5 与 App 可能两套）。

**运维小记（种子顺序）**：部署先起服务、后种子 ⇒ 首轮对账（1 小时间隔）会读到池 0 并误报一次 `CurrencyRobotPoolLow`；重启 currency-service 即消。以后充值后同理会有一小时内旧读数——属正常，看到该告警先核池实际余额。

## 3. 下一片候选

- **广告小片**（救助力口接入；J11 已裁决「另立小片」）；
- **③财务后台 + RBAC + 审计**（J1 第三步；货币设计 §1.3 已为其预埋 `actor/reason` 与管理面块）；
- **风控片**（数据链先行：IP 透传 + deviceId 采集改造）；
- 遗留 Minor 池（台账「Minor 池」节；**无 push 前必修项**）与监控片「三件」。

## 4. 本片交付速览（防走失）

金币场 = 新 `mode:'gold'`（仅匹配进入）× 结算 = `finalizeRoomEnd` 独立例程（`settle:<room>:<ver>`；**输光截断不欠账**；抽水可配默认 0；失败分级=超时原样重发/14001→`:r2`/10001·14002 终态/Redis outbox+sweeper「先收尾后清箱」）× 机器人虚拟池（`robot-pool` 账户；ensure/refill/recall，三档非整百水位哈希派生，无定时 job）× 双开关 + 门槛（底分×倍率）+ 每日救助（按天幂等）× 玩家面（场次切换/余额/门槛/救助/牌桌占位转真值仅金币场/结算三态/战绩金币列）× 观测（16 规则 + 5 面板）× conformance `slice-18`（132 断言）× 配置 17 键 / 客户端 7 键 / 错误码 +3。

## 5. 环境事实（会再咬人）

- **本机跑管理面 conformance 切片**需 `ADMIN_PASSWORD=conformance-admin-pass` 起 config-service（.env 为空时）。
- **假红家族更新**（本轮新增）：⑤ = listen(0) ∩ Windows 动态端口 ∩ **undici 封禁端口表**，**新成员 `currency-service/wallet.controller`（http-probe `fetch failed / bad port`）**；负载态超时族 **新成员 `config-service/client-config`（5s vitest 超时，单跑 2s 全过）**；`game-service/rpc-listen-bind` 复发（单跑 3/3 绿）。**判别法照旧：先单跑，别重跑直到绿。**
- 金币房局终会被 reaper ≤60s 删——「复现 slice-06 类残留红」须在**对局中存活窗**内操作。
- 全序本机复跑已由 CI 权威轮替代（门相同、环境更干净）。

## 6. 新会话怎么开局（一句话配方）

新开会话，直接说：

> **按交接文档续跑：`docs/superpowers/plans/2026-10-04-post-gold-room-handoff.md`，做 X。**

**报告落** `.superpowers/sdd/<日期>-<主题>/`；设计/规格/计划落 `docs/superpowers/{specs,plans}/`；每个任务一提交；六阶段只在 push 前跑一次；全序只在验收跑一次。
