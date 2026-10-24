# 货币核心收口后的交接（2026-10-04）

> **给新会话**：本文 + 自动加载的 `MEMORY.md`（重点 `p2-currency-slice` / `post-mvp-roadmap` / `parallelize-machine-waits` / `ci-flake-known` / `token-economy-model-tiering`）即可续跑。
> **状态**：✅ **①货币核心已收口**（HEAD `a51b5b0`，CI 三绿）；**未上线**（打 tag = 用户动作）；**②金币场未开工**（§3 是它的开工须知）。

---

## 1. 现在的状态

| 事项 | 状态 | 关键入口 |
|---|---|---|
| ①货币核心 设计/规格/计划 | ✅ 全链定稿（各过审 + 终审 opus「可通过 push」） | `docs/superpowers/specs/2026-10-03-currency-design.md`（v1.1.2）· `…-spec.md`（v1.1，⚙️1–15）· `docs/superpowers/plans/2026-10-03-currency.md`（v1.1） |
| ① 实现 | ✅ T1–T11 + T3b/T8b 修复批，共 44 提交（`51d17f3..a51b5b0`），已推 origin | 台账 `.superpowers/sdd/2026-10-03-currency/`（progress.md §4 核销表 + review-*.md + t9/t10 证据） |
| 本机六阶段 / 全序 22 片 | ✅ 六阶段绿；全序跑过一次（三类非绿全环境性定性，见台账） | progress.md |
| 远端 CI 权威轮 | ✅ **三绿**：ci / conformance（22 片全过，slice-17=172，基线全 ≥ 下限）/ images（13） | run `a51b5b0`；两轮间歇红未复现 + 失败诊断步已常备 |
| 上线 | ⏳ **等用户打 tag**（无新增 .env 必填项；唯一用户动作 = 监控片「三件」） | 建议 `v1.4.0` 一次带两片：①`.env` 加 `GRAFANA_ADMIN_PASSWORD` → ②打 tag → ③演练（停 Grafana 2 分钟） |
| 监控片遗留 | ⏳ 同上的「三件」；本机栈在跑（多容器；T9/T10 测试用户与数据留存，无碍） | `docs/superpowers/plans/2026-10-03-monitoring-handoff.md` |

## 2. ⚙️14 硬前置（②必须先过）

规格 ⚙️14 / 设计 v1.1.2 §12：**机器人接入经济前**，currency-service 的类型闸必须保持**锁定读**形态（快照步 `SELECT … FOR UPDATE` + owner_type 断言 + `affectedRows===1`）**并过真库双会话负向用例**（T3 审查曾以 dev MySQL 双会话实证旧普通 SELECT 重查在 RR 下假闭合）。此为 ② 的**准入阻碍项**，已闭合登记链路。

## 3. ②金币场 —— 新会话主任务的开局须知

**用户已裁决（不得违背）**：J1 三步走（本片 = ②）；**J2 免费场保留、新增金币场，两场各有开关**；**J3 金币场补机器人用虚拟币池**（附录 §3.7 规则，数值设计时复核）。

**流程**：同一条龙 —— 设计 → 审设计 → 规格 → 审规格 → 计划 → 审计划 → 实现（逐任务子代理 + 分档审查）→ 终审 → 收口。开工先读路线图 P2′ 节 + 附录 §6 #29/#34（货币侧已在①给答案，#21/#34 复用①结论）。

**①为②预埋的接缝（直接消费）**：`currency.apply` 批量原子（②结算 = 一局一条 `settle:<gameId>` + 三人 entries）；`currency.get` 批量读；`owner_type='robot'` 账户；source allowlist 单点扩（`game_settle`/`robot_pool`）；`game_record_players.money_delta` 回写（记录片预留列，注释写「P2 落地后写」）；管理面「钱包调整」块（③再升级）；对账指标与失败诊断步。

**设计首稿要一并交给用户的产品四问**（向用户预演过，未拍板）：抽水与否（推荐先零和）/ 入场门槛口径 / 破产兜底（每日救助？）/ 机器人池数值复核（附录 10000/1000/5000/50000）。

**设计期要定的硬骨头（预告）**：结算写账失败的补偿口径（对局不得被卡）；断线/托管期间的结算；mode 形态（新 mode vs random 场改造——玩家入口呈现）；客户端面（余额展示/金币场入口/占位转正/战绩页金币列）；观测（资金动账告警规则同批加，注意监控片资产计数）。

**已知会撞的闸族**：配置第 12/13 键（`currency.signupGrant` 那套「恰十一键」同步面再来一遍：protocol/config 测试族/泄漏名单/CONFIG_NOTES/手册键表/design §7.5）；conformance 新片 `slice-18`（run.ts CASES + baselines）；若加告警规则，slice-16 的规则计数同核。

**纪律四口径（继续有效）**：迭代期只跑受影响包；远端 CI 与子代理一律「派出去、回头收」；审查分档（转录型自查/判断型全审、一波一审、不单跑修复验证轮）；静态切片基线回填免首跑红。

**环境事实**：本机栈常驻（新服务已并入 compose）；`conformance.yml` **失败诊断步已常备**（红时自动取证容器 RestartCount/OOM/events）；新增 flake 家族成员见 [[ci-flake-known]] ⑦（07.2-deploy 降级探针高负载超时）⑧（conformance CI 间歇：slice-16 探针二连红/slice-11 单发，第三轮未复现）。

## 4. 新会话怎么开局（一句话配方）

新开会话，直接说：

> **按交接文档续跑：`docs/superpowers/plans/2026-10-04-post-currency-handoff.md`，开工②金币场。**

新会话会：读本文 + MEMORY.md → 复述现状与②范围 → 按（用户既定）纪律起②的设计（首稿带产品四问）→ 后续同一条龙。无需复述历史；三件套文档、git 历史（`a51b5b0`）、SDD 台账（`.superpowers/sdd/2026-10-03-currency/`，本机）是全部上下文。

## 5. 流程入口速查

同前几片：报告落 `.superpowers/sdd/<日期>-<主题>/`（gitignored）；设计/规格/计划落 `docs/superpowers/{specs,plans}/`；每个任务一提交（含 `Co-Authored-By` 行）；六阶段只在 push 前跑一次；全序只在验收跑一次。
