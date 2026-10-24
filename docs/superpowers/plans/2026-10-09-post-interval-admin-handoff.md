# 节奏/清理旋钮管理化片 收口交接（2026-10-09 片 · 2026-10-10 T18 收口）

> **给新会话/未来的你**：本片 = 把六个节奏/清理 env（`PAY_SCAN_INTERVAL_MS` · `PAY_RECONCILE_INTERVAL_MS` ·
> `CURRENCY_RECONCILE_INTERVAL_MS` · `RISK_SCAN_INTERVAL_MS` · `RECORDS_CLEANUP_INTERVAL_MS` ·
> `RISK_DEVICES_CLEANUP_INTERVAL_MS`）从 env/代码常数**整体搬进** config-service 业务配置面（`CONFIG_KEYS` 第 35–40 键），
> 六循环改**排期处现读配置缓存**（**下一轮排期即生效、无需重启**，Q3 裁决）。
> **当前状态（2026-10-10）**：实现全链完成（T1–T17）· 六阶段全绿（`t18-ci.log`，exit 0）· baselines 已回填 ·
> 六 env 清零核销完毕（`t18-env-sweep.log`）· **未 push、未打 tag**（= 用户侧动作，见 §4）。

---

## 0. 交付了什么（一段话）

六键表（键名 / 默认 / 上限）：`pay.scanIntervalMs`(60000, ≤600000) · `pay.reconcileIntervalMs`(86400000, ≤864000000) ·
`currency.reconcileIntervalMs`(3600000, ≤36000000) · `risk.scanIntervalMs`(3600000, ≤36000000) ·
`risk.devicesCleanupIntervalMs`(3600000, ≤36000000) · `record.cleanupIntervalMs`(3600000, ≤36000000)。
协议层 40 键 + `parseIntervalMs`（严格 int、拒字符串、拒未知键——`Object.hasOwn` 防原型链，W1-I1）· 种子迁移
`1794000000000-IntervalConfigSeed`（**值 = 各自旧默认 ⇒ 第 0 天行为零变化**）· 六循环统一「首排动作」形态
（有界等首快照 ≤10s → 解析 → 启动行 → 排首轮；快路径同帧 + 至多一次）· compose 六行透传退役 · stack.sh
注入换源（数值版 `config_seed_put` 六键种子；测试值 pay 两键 2000）· `RETIRED_ENVS` +6（防回流闸）· 管理页
`CONFIG_NOTES` +6 与计数四十 + 保存横幅新文案（「≤60s 内读到新值（节奏类键自下一轮排期起生效）」）· conformance
六片迁移（T12–T15：slice-15/17/18/20/21/22 + slice-23 计数组；重建纪律全场性 `--force-recreate`）· 文档面
（`design.md` 键表 +6 行/计数四十/walkthrough · `first-deploy.md` 四十键一览 + 「节奏旋钮怎么调」· `client-protocol.md`）。
台账 N115–N121 在案（`docs/superpowers/plans/deviation-ledger.md`）。

## 1. 三件套与评审链（唯一上游）

- 开工交接：`docs/superpowers/plans/2026-10-06-post-pay-channel-handoff.md` §8 第二梯队 + `2026-10-07-post-notify-channel-handoff.md`。
- 设计 **v1.3 冻结**：`docs/superpowers/specs/2026-10-09-interval-admin-design.md`（`920d9f8`；Q1 六键全搬 · Q2 进业务键面 · Q3 每轮现读）。
- 规格 **v1.2 冻结**：`docs/superpowers/specs/2026-10-09-interval-admin-spec.md`（`848b752`）+ 实施期微审 **v1.3**（`b4fff42`，W1-I1 同步）——**契约以 v1.3 文本为准**。
- 计划 **v1.2 冻结**：`docs/superpowers/plans/2026-10-09-interval-admin.md`（`742a21d`；+v1.2.1 T1 注记随 `b4fff42`；T1–T18）。
- 评审报告（台账 `.superpowers/sdd/2026-10-09-interval-admin/`，gitignore）：design r1/r2/r3 · spec r1 · plan r1/r2 · W1–W5 波次评审 ·
  **T18 全套日志**（`t18-ci.log` / `t18-env-sweep.log` / `t18-baseline-check.log`）；`progress.md` = 全程登记。

## 2. 关键数字

- **六阶段**（`bash scripts/ci.sh`；日志 `t18-ci.log`，HEAD = `e934a5f` 树）：**全绿 exit 0**。
  1/6 install 1s（本机既有形态：非 TTY 下 pnpm 重装提示自动确认，t3/t9 同款）· 2/6 lint 17.9s（18 tasks，
  0 cached）· 3/6 build 24.0s（15 tasks）· 4/6 test 57.8s（29 tasks）· 5/6 coverage 6s（shared All files 行
  **98.27%** ≥ 80%）· 6/6 eslint-forbidden 15s（6 闸全过：26+12+5+6+3+21 passed）。
- **单测（stage 4/6，14 包，合计 3865 passed + 2 skip）**：protocol 180 · config-service 350 · shared 275 ·
  api-gateway 406 · game-service 130 · room-service 599 · user-service 264 · robot-service 118 ·
  currency-service 233 · payment-service 418 · alert-relay 124 · client 751(+2 skip) · mock-server 10 · test-utils 7。
- **conformance 受改七片读数**（本片最终代码树）：slice-15 = 211 · slice-17 = 172 · slice-18 = 132 ·
  slice-20 = **181**（175 + 6：④b 设备清理小组端到端——第 6 键首个 conformance 覆盖）· slice-21 = **328**（321 + 7：⓪ 归一重建等）·
  slice-22 = 243（净 0：透传面删 3 加 3）· slice-23 = 380（净 0：计数五处 34→40）。
- **baselines 回填**（本次 diff）：`slice-20-risk-control` 175→**181** · `slice-21-payment` 321→**328**；其余 26 片零调整、
  **零下调**。对账（`node scripts/check-baselines.mjs full t15-full.log`）= **26 片在场，除唯一计数差（slice-07.5 本机 184 < 196）外全 ≥ 下限 + 3 条已分类项**
  （slice-13/slice-23 在该日志里「缺席」＝ 该次两红〔均单跑复证绿〕+ slice-07.5 本机跳过形态 184 < 196，baselines 原文自注「不得用本机读数回填」——**不下调**）。
- **全序口径（T18 未重跑，如实引用）**：T15 在本片最终 conformance 树上跑过一次全序 = **26/28 绿 + 2 红全分类**
  （`t15-full.log`）：红-1 slice-13 = 常驻容器悬挂旧镜像（环境性；按守卫处方重建后单跑 **35 绿**）· 红-2 slice-23 = ⑥ AM 链
  （T15 零触碰面；根因见 §5）。**T18 不重跑依据** = T16/T17 相对 T15 终树仅注释/文档/静态页差异（含 `tools/conformance/src/lib/http.ts:248`
  一处注释句，零断言面）+ 用户口径「全序只在验收跑一次」。**CI 权威轮**（Actions 额度恢复后）仍需按实测复核/校正 20/21 两片下限。
  **权威重跑须走标准 `up --build`**（重建边缘镜像）——否则 slice-19 G12 字节对拍会以「旧镜像」形态红（防空测的设计内检测，非缺陷）。

## 3. 六 env 清零核销（`t18-env-sweep.log`）

树内 `git grep` 六 env 名 ⇒ **90 行 / 30 文件，全部属四类白名单**（逐点枚举在日志）：
**A 注册点 6 行**（`packages/shared/test/design-md-ai-rollout.gate.test.ts:111-116`，`RETIRED_ENVS` 数组）·
**B 历史案卷 51 行**（`docs/superpowers/**` 旧片 plans/specs + `deviation-ledger.md` N63/N66/N115）·
**C 本片文档自身 23 行**（2026-10-09 三件套 + 本交接文档）· **D 退役登记点注释 10 行**（compose `:178-179/:363` · stack.sh `:42` ·
5 个循环 src 注释 · user `risk-scan.test.ts:7`——W4 已裁保留类）。**零陈述现役残留**；规格 ⚙️9 清单所列 step/info/注释点全清
（tools/conformance 切片文件零命中）。判别力负对照：向 design.md §2.3 注入 `RISK_SCAN_INTERVAL_MS` ⇒ J18② 当场红
（exit 1、点名该名），还原后 7/7 绿。

## 4. 上线脉络（**用户侧动作；纯 tag+deploy，零服务器 `.env` 动作**）

1. **push master → 打 tag `v*` → `deploy.sh <tag>`**（照既有流程；本片提交现均在本地）。
2. **零服务器 `.env` 动作**：六键生产**从未设过**（N115）；回滚 = 旧 tag 读 env 恒空 ⇒ 代码默认，与种子**逐字同值**。
3. 部署自证：config-service 启动即跑 `IntervalConfigSeed1794000000000`（六行种子入 `platform_config`）；六循环启动行
   按新配置链路打印；管理页 40 键含六节奏键（值 = 60000 / 86400000 / 3600000×4）。`deploy.sh` 既有冒烟三连照跑。
4. 运营口径：改节奏在**管理页**改，**下一轮排期即生效**（已排定的一轮不撤——秒级节奏最坏等一个旧间隔）；无需重启
   （`first-deploy.md`「节奏旋钮怎么调」已写）。
5. **回滚**：`rollback.sh`/`deploy.sh` 回旧 tag 即可；本片无新容器、无新 env、无服务器动作 ⇒ 回滚面干净。

## 5. 残余 / 未闭项

- **slice-23 ⑥ = 新「已知假红族」候选（两形态）**：① **AM 跨 run 同组调度零派发**（确定性：切片固定
  `alertname=ProbeWecomA`+`job=ftl-probe` ⇒ 相邻 run 共用同一 AM group，前序通知在 5m `group_interval` 内 ⇒ 新注入派发被推迟到窗外；
  带外探针 relay→stub **11/11=200** 为决定性反证）· ② **relay 扇出瞬时三 sink `status:0`**（偶发、未复现；分钟级后同机制 200 绿、
  容器零事件）。**判别法** = relay 日志有无 `{"sink":…}` 行（无 = 形态①）+ stub 经 exec 可读（存活）+ 带外探针 200（网络清白）。
  **处置建议（设计面，本片未动）**：⑥ 的 `alertname` 随 run 唯一化（同 stub 名先例）或 ⑥ 前置显式等待 `group_interval` 边界。
  三次红全部落在 ⑥（T15 零触碰面）；本片两片 40 键计数断言在全部 run（含三次红 run）中全部照绿（T15 报告 §3/§4.2）。
- **baselines 回填说明**：20 175→181 / 21 321→328 按本片最终代码树实测（单跑 + 全序双读数，见 §2）；**CI 权威轮后复核/校正**
  （同 slice-21/22 既有口径；Actions 额度恢复后）。对账 3 条分类项见 §2（均为既有已知形态，非本片引入）。
- **W5 Minor 终态**：M1（slice-15/17 手法注释漏 `--force-recreate`）**已收**（T17 `e934a5f`）· M2（slice-20 字面量/命名常量风格
  不一致，可选不阻断）**未收**· M3（T15 分类结论的承重「docker logs 当场实读」未落文件）**未收**——本报告与交接按
  「当场实读（未落文件）」如实记；下次触碰时补采集命令。
- **各登记项**：W2-M1 boot-wait 定时器关停不取消（≤10s 有界保活、受闸 no-op——⚙️5 冻结形态）· T3-③ probe 第二副本
  六新键**值**无运行时断言（SEED 族既有性质）· N120 超时窗还原侧**理论假绿**残留 · T16-① 横幅句尾「。」判定为引文标点
  （评审异读一行可回改）· T17 偏差 2（user `config.client.ts:15` 追记形态保留「三十四键」字样，属保留类）。
- **本机搭车项（T18 执行）**：仓根 `.env` 遗留副本裁除所列 8 行（`DB_HOST/PORT/USER` + 四个 `*_SERVICE_URL` +
  `DOUZERO_URL`——不被 compose 插值，复核：`git grep` 八键插值面零命中 + `docker compose config -q` 过；被插值三行
  `DB_PASSWORD/DB_NAME/JWT_SECRET` 保留。注：`.env.local` 不在本片裁决面内，未动）。
- **未 push / 未 tag**：`origin/master..master` = 36 条（1 条上片收口文档 `0f73c5b`〔随批推〕+ 本片 35 条；T18 收口提交后为 37 条），tag 未打。

## 6. 新会话入口（读什么）

1. 本文件 → 2. 规格 **v1.3**（契约唯一真源）→ 3. 台账 `progress.md` + T15 报告（全序与红分类全档）→
4. `docs/design.md` §7.5 键表（35–40 键）+ `docs/ops/first-deploy.md` 四十键一览与「节奏旋钮怎么调」。

**恢复口令**（如需要）：「继续节奏/清理旋钮管理化片收尾：读 `docs/superpowers/plans/2026-10-09-post-interval-admin-handoff.md`。」
