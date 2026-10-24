# 记录片收口后的交接（2026-10-03）

> **给新会话**：这份文档 + 自动加载的 `MEMORY.md`（重点看 `post-mvp-roadmap` / `parallelize-machine-waits` / `conformance-cycle-time-costs` / `token-economy-model-tiering` 四条 memory）即可续跑。当前 **master = `c5fc861`**，工作区干净（除既有未跟踪 `AGENTS.md`），origin 同步（0 未推）。

---

## 1. 现在的状态（全部已入库、已推、三 workflow 全绿）

| 事项 | 状态 | 关键入口 |
|---|---|---|
| **M0.1 安全扫描进 CI** | ✅ 完成（master 内） | 设计 v1.2.2 `docs/superpowers/specs/2026-10-02-security-scan-design.md` · 规格 **v3.2** `…-spec.md`（豁免已 2 条）· `ci.yml` 第三 job `security-scan` |
| **路线图修订** | ✅（M0.2 裁决不做 → 真监控system 排「监控片」，位置 P1′↔P2′ 之间） | `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` |
| **P1 记录片（对局记录 + 我的历史战绩）** | ✅ **全链收口**（T1–T10 + 终审 opus「READY」；conformance 第 20 片 `slice-15-records` 211 断言） | 设计 v1.2 `docs/superpowers/specs/2026-10-03-records-design.md` · 规格 v1.1 `…-spec.md` · 计划 v2 `docs/superpowers/plans/2026-10-03-records.md` · 台账 `.superpowers/sdd/2026-10-03-records/progress.md` |
| **两处高危登记** | ① 下次发布注意：edge `/data` 卷属主迁移（手册 `docs/ops/first-deploy.md` 详注 ⑨）② 唯一豁免 2 条（vite/1123525 · braces/1240992）及其复查触发 | M0.1 规格 §0 v3.2 / 路线图 M0.1 节 |
| **一条产品级触发登记** | 任何引入「人类可设昵称」的切片**必须同时解决机器人展示名**（否则历史页变统计识别器） | 设计 v1.2 §2.6 |

## 2. 待用户拍板（开工前需一句裁决）

1. **下一步做哪个**：
   - **监控片**（Prometheus + 各服务 `/metrics` + Grafana + Alertmanager；**告警通道选型在这一片里定**——原 M0.2 的顺延项）；
   - 或 **P2 货币 → { 支付 ∥ 对账 }**（**支付范围**需裁：推荐只做充值；渠道商户号需实名主体）；
   - 或 **风控片**（记录片的直接后继，见下）。
2. （若走 P2）支付范围裁决。

## 3. 不需要新决策、可立即开工的三件

- **风控片**：IP 透传链（网关→room→meta）+ deviceId 采集链（已裁：**采、仅服务器可见**）+ 谓词框架/选择形态改造（现确定性 `slice(0,3)` → 随机凑→判定→扔回）+ `match:rejected` 写入。规格起点 = 路线图 P1′ 风控节；**开工前先读附录 §6 对应条目**（路线图文末映射）。
- **Minor 池清理批**（终审 triage 留题，全部一行级；清单在台账 `.superpowers/sdd/2026-10-03-records/progress.md` 末尾）：
  - `slice-07.5-backup.ts` 的 `sh()` 加 `cwd: REPO_ROOT`（同文件自相矛盾；挂 pnpm 脚本会恒红）；
  - 接收侧 meta trace 接线（user-service `record.rpc.controller` **与 config-service 同缺口并批**；先例 `game-service/src/rpc/to-result.ts`，每处 ~10 行）；
  - `.lobby__exit` 复合选择器 / `page-stack.test.ts:139` 标题 / 多包「九键」注释清扫 / `readBotBindings` 降助手或删 / `RECORD_WRITE_TIMEOUT_MS` 常值断言。
- **另线（等用户时间，原样挂着）**：App 端收尾（打包 + 真机走查；HBuilderX 5.26 已就绪）· 片③-B 两步真人验收（handoff `docs/superpowers/plans/2026-09-26-t9-acceptance-handoff.md`）。

## 4. 新会话开工纪律（**本会话 2026-10-03 刚定，务必遵守——否则又会慢**）

1. **迭代期只跑受影响包的测试**；六阶段只在 push 前跑一次；**全序 conformance 只在验收跑一次**；
2. **远端 CI 与子 agent 的等待「派出去、回头收」**，不用 `watch` 干等；**文件不相交的任务组用 worktree 真并行**（`.worktrees/` 有成例）；本机重跑期间只填纯文档工作；
3. **审查分档**：转录型任务（计划里给了完整代码的）协调者自查 diff；判断型任务上全审；**不单跑「修复验证轮」**（并进终审）；规格+计划小片同轮审；
4. **静态切片的基线回填免「首跑红」仪式**：本机确定性读数先填 + CI 首跑即验（动态/数据相关切片仍按 CI 实测回填）。
（展开见 memory `parallelize-machine-waits`、`conformance-cycle-time-costs`、`token-economy-model-tiering`）

## 5. 流程入口速查（本仓惯例）

- 每片：**设计 → 审设计 → 规格 → 审规格 → 计划 → 审计划 → 实现（子 agent 逐任务 + 审查）→ 终审 → 收口**；
- 审查报告与 task brief/report 落 `.superpowers/sdd/<日期>-<主题>/`（gitignored）；设计/规格/计划落 `docs/superpowers/{specs,plans}/`；
- 承诺：「修复」类表述必须指向**本次产生的日志**；「判据只增不减」；每次改动一个 commit（CLAUDE.md）。
