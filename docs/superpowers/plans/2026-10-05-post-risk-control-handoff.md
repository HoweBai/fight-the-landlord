# 风控片 收口交接（2026-10-05）

> **给新会话**：本文 + 自动加载的 `MEMORY.md`（重点 `risk-control-slice-kickoff` / `post-mvp-roadmap` / `ci-flake-known` / `token-economy-model-tiering` / `windows-dev-env-quirks`）即可续跑。
> **状态**：✅ **全链完成**——三件套（设计 v1.1.8 / 规格 v1.1.8 / 计划 v1.1.4）冻结 → 实现 T1–T13 → 波 1/2/3 评审+核验全闭环 → **opus 整支终审 F1–F5 闭环** → 本机**六阶段最终树整轮绿**（`t13-ci-log-run2.txt`）。**CI 权威轮为最后一环**（读数回填见文末 §7）。

---

## 1. 现在的状态

| 事项 | 状态 | 关键入口 |
|---|---|---|
| 设计/规格/计划 | ✅ 冻结（设计 v1.1.8 `f2da42b` · 规格 v1.1.8 · 计划 v1.1.4） | `docs/superpowers/{specs/2026-10-05-risk-control-{design,spec}.md, plans/2026-10-05-risk-control.md}` |
| 实现 | ✅ T1–T13（含波 1/2/3 与终审修复共 30+ 提交；一任务一提交） | 台账 `.superpowers/sdd/2026-10-05-risk-control/progress.md`（全核销表） |
| 评审链 | ✅ 三件套 66 处（设计 14+7 · 规格 17+6 · 计划 14+8）· 波 1 4 · 波 2 8 · 波 3 4 · T13 收口 1🔴 已修（F-T13-1）· opus 终审 5 条已闭环 | 同目录 `review-*.md` + 台账核销节 |
| 本机验收 | ✅ 真栈全链回归（deviceReport 7/7 · 封禁四读点全谱）· browser-e2e 22/22 · admin 探针 24 断言 0 失败 · **六阶段最终树整轮 EXIT=0** | `t13-*.txt/png`（同目录） |
| conformance | ✅ `slice-20-risk-control`（175 断言）；`baselines.json` **待 CI 权威轮实测回填** | `tools/conformance/src/slices/slice-20-risk-control.ts` |
| CI 权威轮 | ✅ **三绿**（`0bf2f91`：ci 8m18s / images 6m16s / conformance 32m21s 全序 25 片） | §7 |

## 2. 交付速览（防走失）

**谓词链**：`MatchPredicate` 框架 + 随机贪心抽 3（洗牌副本/原序保序）→ 子集路径（|S|=3/2/1）→ 到点兜底；`match:rejected` 真写入（5s）；**孤儿票/封禁票前置静默清出**；`attempts` 双增点（每轮每人去重）。谓词 = 同设备/同 IP，**默认关**（配置键）。
**数据链**：网关握手 auth 注入 `clientIp`（唯一可信解析复用）→ `socket.data` → `match:meta`；客户端 deviceId（`ftl.deviceId`，不进 clearSession；写后回读+域校验自愈）→ `room.match` payload → meta → `risk.deviceReport`（fire-and-forget）→ `user_devices`（原文；1h 节流）。
**检测链**：user-service 扫描（`SQL1/2/3` + Redis 锁 + CAD；upsert「最新一行」锁定读状态机；自动限流；封禁旗自愈；全量失败降级）；阈值全配置化（`risk.*` 八键，17→25）。
**处置链**：限流档（3/1s，HTTP+WS 按 userId；旗读三类：检测位 fail-open / 校验位 fail-closed / 决策读照抛）· 封禁四读点（登录/网关握手/入队/join；**断线即出局**；旗写 post-commit；unban 清孤儿旗）· 管理页「风控」视图 + 审计第五页签 · `risk_actions` 五源审计。
**客户端**：**K1 文案覆盖 11003 全部可见面**（登录/会话/握手——全串「该账号已被封禁，如有异议请联系客服」）。
**监控**：7 指标 · 2 告警（`RiskScanStalled`/`MatchPredicateRejectionHigh`）· `06-risk` 面板（规则 18 / 面板 6，slice-16 已同步）。
**安全修复（搭车）**：policy **大小写折叠**——连堵 ③ 遗留的 `GET /API/admin/Accounts` 变体洞（真栈前后对照取证）。

## 3. 上线与用户动作

- **push**：✅ 已完成（`fe8002e..a3f0f05` 48 提交快进；baselines 回填 `a3f0f05..0bf2f91`）。**tag `v1.7.0` = 协调者（用户 2026-10-05 授权）**→ release 部署（`v*` 才触发 release；**打 tag 前必须先 push**——R1308 已两度拒过）。
- **谓词开启手顺（上线后，写进 `first-deploy.md`）**：先开 `risk.predicate.sameDevice`，观察一周（看 `match_predicate_rejections_total` 与 `MatchPredicateRejectionHigh` 是否打铃），再评估 `risk.predicate.sameIp`（CGNAT 风险）；两键随时可回关。
- 部署零新增：无新服务/容器/env（唯一例外 = compose 两行测试注入面，已登记）；三表随启动迁移自动建；8 键种子自动种。
- 管理面：新「风控」视图（super_admin/operator）；封禁/限流/放行全部经审计留痕。

## 4. 下一片候选

- **广告小片**（金币场「每日救助」前置；需你注册平台+广告位 ID）→ **支付片**（充值/退款/提现；商户号=实名主体）。
- 转办/待办：slice-17/18 窗口计数 → 时间锚统一（T11 转办，超本片范围）· T9 备注的 reviewId 语义/刷行口径等已登记项 · Minor 池照旧。

## 5. 环境事实（会再咬人）

1. **dev 栈 `risk:hit:*` 残留 25 枚**（conformance 谓词组生成、TTL 7d 自灭；登记不删——T11 20 + T9 复跑前批 5）。
2. **edge 重建必须显式带 `EDGE_HTTP_PORT/EDGE_HTTPS_PORT=8080/8443`**（漏带掉回 80/443——T9 实测一次）。
3. **conformance 谓词用例必须还原开关默认关**（否则后续切片全崩——已按此实现）。
4. **改 protocol 后先 `protocol build` 再跑消费包测试**（workspace 解析 dist——T1/T4 两度咬）。
5. **六阶段本机 1/6 install 空转**（R285 老知识）；⑤ 族假红（`game-service/rpc-listen-bind`）本片两次到场、单跑即绿——**先单跑判别，别重跑直到绿**。
6. 谓词**默认关** ⇒ 上线首日「防护未武装」是**预期态**（手顺见 §3）。
7. `t9-walk-op` drill 管理员已 disable 留档；`risk:*` 除 hit 残留外全空；DB 演练数据全清。

## 6. 新会话怎么开局（一句话配方）

> **按交接文档续跑：`docs/superpowers/plans/2026-10-05-post-risk-control-handoff.md`，做 X。**

**报告落** `.superpowers/sdd/<日期>-<主题>/`；设计/规格/计划落 `docs/superpowers/{specs,plans}/`；每任务一提交；六阶段只在 push 前跑一次；全序只在验收（CI 权威轮）。

---

## 7. CI 权威轮回填（push 后）

- **push 已完成**：`fe8002e..a3f0f05`（48 提交快进）+ baselines 回填 `a3f0f05..0bf2f91`。
- **触发条件（本地核实）**：推 master 触发 `ci` · `conformance` · `images`；`release` 仅 `v*` tag。
- ✅ **权威轮三绿（`0bf2f91`，覆盖 T1–T13 全部实现与修复）**：
  - `ci` **success** 8m18s（run 37304292763）
  - `images` **success** 6m16s（run 37304292712）
  - `conformance` **success** 32m21s（run 37304292751，全序 25 片；`slice-20-risk-control` 175 断言 ≥ 新回填下限）
- **首轮说明（`a3f0f05`）**：唯一 ❌ = `check-baselines`「slice-20 未回填」（**设计内**——基线按 CI 实测回填的既定流程；该轮 25 片全 exit 0，实测 `slice-20 = 175`）⇒ 回填 `0bf2f91` 后权威轮三绿。**回填/文档类提交随推触发的 run 不影响本权威结论**（③ 先例）。
- **若后续 CI 有红**：先**单跑**该片确认（`ci-flake-known` ②⑤⑧ 族；失败诊断步常备）；确系真红 ⇒ 修复 + 重推。
- **tag**：✅ `v1.7.0` 已打并推（协调者执行，用户 2026-10-05 授权）→ **release 三 job 全绿**（run 37307952827）：
  - `images` success（12:12:44→12:19:42；构建并推送全部镜像）
  - `conformance` success（12:19:45→12:49:26；**在发布镜像上**跑全序）
  - `deploy` success（12:49:29→12:53:21）
- **线上探针（强制指 `<DEV_HOST_IP>`，DNS 陷阱纪律）**：`/api/health` ⇒ **200** `{"status":"ok","service":"api-gateway","checks":{"redis":"up"}}`；`/api/admin/risk/reviews` 免密 ⇒ **401**（**非 404 = 风控路由确已在线上**——旧版本会 404，此为版本判别探针）。
