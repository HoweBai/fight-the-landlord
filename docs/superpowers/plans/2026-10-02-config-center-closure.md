# 片⑦「配置中心 + 好友房开关」收口登记（2026-10-02）

> 本文件 = T18 Step 7/8 的**收口记录**（进仓库、可追溯）。「未执行/未验证」一节按本仓纪律逐条如实，
> **不得**读成「已完成」。详细运行记录在 `.superpowers/sdd/2026-10-01-config-center/progress.md`（本机台账）。

## 状态

- T1–T18 全部完成；`feat/config-center`（34 commits）与 `fix/slice12-race` 两个分支均已 `--ff-only`
  合入 master 并删除；本收口提交后 master = 发布候选。
- **发布结果（2026-10-02 补记）**：`v1.3.0` 已发布上线；**`v1.3.1`（管理页九键逐项备注）亦已发布上线**；
  **C21② 回滚演练已执行完成**（证据见下「未执行」节的两条订正）。
- 设计 v3 / 规格 v2 / 计划 v3：`docs/superpowers/specs/2026-10-01-config-center-{design,spec}.md`、
  `docs/superpowers/plans/2026-10-01-config-center.md`。

## 验收证据（均指向本会话产生或 CI 产生的工件）

| 项 | 结果 |
|---|---|
| 本机 `pnpm run ci` | EXIT=0（分支上 + 合入后 master 各一轮；六阶段；无假红命中） |
| 真栈 conformance 全序（修复后） | **19/19 全绿**（`t18fin-*`；slice-12 修复后 `s12race-13-*` 同判） |
| 浏览器探针 `--scenario full` | 40/40（含好友房开启→创建→两态复原） |
| 整支终审（opus，`8609eca..2d73477`） | **Ready to merge = Yes**（零 Critical/Important；Minor 全部分诊·无合入前必修） |
| CI（push `2d73477`，run 36978722976/77/80） | ci 首跑红→**复跑绿**（`ws-allow-request` 400ms 采样窗，记未复现）· images 绿 · conformance 18/19 |
| └ 关键读数 | `slice-14-config-center = 73`（本轮回填）· `slice-07.5 = 196` ⇒ **本机跳过的 14 条断言在 Linux 全真跑全过** |
| 验收期修复 | `9a9cf7a` 管理令牌回落链（compose 透传 + ①k-bis）· `92bcb7a` C20 自带门口前置 · `2d73477` C17b② 根因（spawnSync 冻循环 ⇒ GET 恰一次有界重试）· `94b1d37` slice-12 开局竞态（补写 `match:pending` + 连接补推 matched+deal） |

## 判据/基线

- `tools/conformance/baselines.json`：新增 `slice-14-config-center = 73`（**CI run 36978722980 的
  Linux 读数**；非本机读数）。slice-12 由 77 → 88 条，属下限语义、无需回填。

## 未执行 / 未验证（如实）

- ~~C21② 跨边界回滚演练~~ ⇒ **✅ 已执行（2026-10-02 补记）**：回滚 v1.2.0（run `37001845156`）⇒ 旧栈健康、
  **孤儿 `ftl-config-service` 原样留存**（旧 compose 0 处提及它）、`/admin/` = 404；前进 v1.3.1（run `37002012320`）⇒
  站健康、`/admin/` = 200、**孤儿容器 ID 不变（`1bae323a96ad` = 自动复用不重建）**。两次 deploy 全 success
  （原始读数：`.superpowers/sdd/2026-10-01-config-center/drill-baseline.txt` / `drill-after-forward.txt`）。
- ~~服务器 `.env` 追加 `ADMIN_PASSWORD` / `ADMIN_JWT_SECRET`~~ ⇒ **✅ 已执行（2026-10-02 17:18 补记）**：
  备份 `/home/ubuntu/ftl-env-backup-20261002`。⚠️ 教训：**备份不得放 `/srv/pokergame`** —— C4 收尾断言要求
  该目录**恰好** `.env + docker-compose.yml` 两件；首跑曾因此红、挪走后复跑绿。
- **C17b② 修复环内未实弹**：全序/CI 上重试行 0 次（触发条件未出现）；判别证据 = 定向复现件
  （修复前 4/4 红 → 修复后 4/4 绿）。已入 `ci-flake-known` 第⑥条。
- **已知/新登记假红与余项**：`ws-allow-request` 400ms 采样窗首跑红（复跑绿，未复现）· room-service
  一次未复现整包失败（后 6 连跑绿）· 终审 3 条 Minor + T17 四条 Minor + slice-12 修复审查 3 条
  Minor（1 条报告指针已当场订正，2 条观察项）——明细在台账。
- 本机 Windows 跳过 14 条（slice-07.5）：**已由 Linux CI 真跑通过** ⇒ 本条关闭。

## 下一片候选（已登记）

假红④根因片 · conformance harness `spawnSync`→async（C17b② 同类的治本方向）· slice-14 C1②
单发断言的余量 · config-service 并发首建未兜 `ER_LOCK_DEADLOCK` · `isDeadSocketFailure` 只看
单层 cause。

## 发布步骤（**2026-10-02 已全部执行完成**，保留供追溯）

1. 服务器 `.env` 追加 `ADMIN_PASSWORD` / `ADMIN_JWT_SECRET`（手册「怎么改配置」节命令）；
2. 打 tag `v1.3.0` ⇒ release（images → conformance → deploy）全绿；
3. 线上独立验证（强制指 IP `<DEV_HOST_IP>`：`/api/health` + `GET /admin/` + 好友房关闭态）；
4. C21② 跨边界回滚演练（两次 deploy 日志 + 线上健康为证）。
