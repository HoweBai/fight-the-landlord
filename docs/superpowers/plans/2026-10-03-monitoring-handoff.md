# 监控片收口后的交接（2026-10-03）

> **给新会话**：这份文档 + 自动加载的 `MEMORY.md`（重点 `monitoring-slice-in-progress` / `parallelize-machine-waits` / `conformance-cycle-time-costs` / `token-economy-model-tiering`）即可续跑。
> **状态**：✅ **已收口**（2026-10-03）。master = `b11cf40`（随本批文档提交再推一笔，见 §1）；本机：六阶段绿 · 全序 21/21；**CI 权威轮三绿**：ci `37123045464`（7m2s）· conformance `37123045492`（24m3s，21 片全过）· images `37123045432`（5m47s）。**首跑观察点全部落地**：`[baseline] full slice-16-monitoring = 86` ✅（CI 与预填同值；Linux 单跑 60.3s）· **cadvisor 在 CI Linux 首次受检 = up**（C2「13 目标逐个 up」通过）✅。收口途中三次 CI 红全部定位并修复再推（gitleaks 测试夹具误报→允许项 #3；slice-16 C11 净增量竞态→真值对账口径；slice-07.5 scratch-mysql 就绪谓词→`@@port=3306`）。
> 全链产物：设计 `docs/superpowers/specs/2026-10-03-monitoring-design.md`（v1.2 定稿）· 规格 `…-spec.md`（v1.1，含订正④⑤/N2 与 ⚙️ 回填）· 计划 `docs/superpowers/plans/2026-10-03-monitoring.md`（v2）· 台账 `.superpowers/sdd/2026-10-03-monitoring/progress.md`（含 `review-final.md` 终审）。

---

## 1. 现在的状态

| 事项 | 状态 | 关键入口 |
|---|---|---|
| 设计与规格与计划 | ✅ 全链定稿（各过独立审查 + 收口复核） | 三件套路径见上 |
| 实现（T1–T12） | ✅ 全部交付并逐任务放行 + **终审（opus）B1 解除** | `review-final.md` |
| 本机六阶段 | ✅ 全绿 | `pnpm run ci` 输出 |
| 本机全序 conformance（21 片） | ✅ 全绿（两个非绿项=环境性：`--fresh` 脏卷 / check-baselines 的 Windows 14 跳过；**权威以 CI 为准**） | `/tmp/full-run2.log` |
| 合 master + push + CI 三 workflow | ✅ `--ff-only` 合入 → push `8acd79e..b11cf40`；**CI 三绿见文首**（期间三轮红均修复再推） | — |

## 2. 上线前必须由用户完成的三件（**按序**）

1. **服务器 `.env` 加一行 `GRAFANA_ADMIN_PASSWORD=<强口令>`**（不写 ⇒ 监控的 Grafana 守卫 fail-closed 起不来——**站不受影响，但没有看板**；手册「监控（看板与告警）」详注⑩）。
2. **打 tag 上线**（先 push master 再打 tag——既有纪律；release 三 job 串行）。
3. **验收演练（需用户在场）**：手册给的最省事配方——`docker stop ftl-grafana` 等 ~2 分钟再 `start` ⇒ 邮箱与**已配**的 IM 应各收到一条 `ServiceDown`；顺带确认 Watchdog 心跳邮件（配了邮箱后 ~24h 一封；「多久没收到=说明什么」表在手册）。
   - 可选加演：真的停一个业务容器（如 user-service）验证更强的告警面。

## 3. 高危登记（下次发布注意）

- **cadvisor 在真 Linux 服务器上未验证过**（本机 Docker Desktop 真栈已核 16 目标全 up）——首次上线是它的真考场；若权限问题 ⇒ **响亮失败**（目标 down），按规格 C2 的「降级配方 checklist」摘除（compose 摘块 + conformance-stack rm 名单 + prometheus.yml 摘 job + C13 断言改五块）。
- **Grafana `/metrics` 子路径**已修（`metrics_path: /grafana/metrics`）——别再改回裸 `/metrics`（会 301 → prod 出站回环 + 假 critical ServiceDown）。
- 旧账（与本片无关但同在发布线上）：edge `/data` 卷属主迁移（手册详注⑨）。

## 4. 残余风险（本片如实登记，不掩盖）

- Watchdog 心跳依赖**邮箱通道**；只配 IM 不配邮箱 ⇒ 无心跳（手册讲明了）。
- cadvisor 降级形态 `MONITORING_EXPECT_CADVISOR=0` 的**真栈执行**未跑（谓词有合成正负对照自证；真要用它时按 checklist 执行）。
- 快照/面板内容随用随迭代（判据只钉「面板在」）。

## 5. 下一片候选

- **P2′ 货币→{支付∥对账}**（支付范围待用户拍板；渠道商户号需实名主体）；
- **风控片**（IP 透传 + deviceId 采集 + 谓词框架，路线图 P1′ 后段）；
- Minor 池清理批（记录片终审 triage 留题，台账在 `2026-10-03-records/progress.md` 末尾）。

## 6. 流程入口速查

同前几片：设计→审→规格→审→计划→审→实现（子 agent 逐任务 + 审查）→终审→收口；报告落 `.superpowers/sdd/<日期>-<主题>/`（gitignored）。本片的四条开工纪律（迭代期只跑受影响包 / 派出去回头收 / 审查分档 / 静态回填免首跑红）继续有效。
