# 风控片 开工交接（2026-10-05）

> **给新会话**：本文 + 自动加载的 `MEMORY.md`（重点 `post-mvp-roadmap` / `p3-admin-rbac-audit-slice` / `ci-flake-known` / `token-economy-model-tiering` / `slice-workflow-one-shot-pipeline` / `windows-dev-env-quirks`）即可续跑。
> **当前状态**：P1′ 记录 ✅ · 监控片 ✅ · P2 货币三步走全部 ✅（③ 财务后台 + RBAC + 审计已收口：CI 三绿 `d6c8c44`、tag `v1.6.0` 已推、release 部署进行中）。**风控片本身尚未立项**（无设计/规格/计划）——本交接 = 开工起点。

---

## 1. 上游必读（按序）

1. **路线图 P1′「风控」八条**：`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md:42-51`（本片范围真源）；
2. **附录 §3.4 风控（原 §10.7）**：`docs/appendix/platform-roadmap.md:140-161`（参考规则/阈值/处置/申诉原始设计 + **已标注的三处缺陷**）；
3. **主规格基线**：`docs/design.md` §5.4（限流五维基线——频率面的实现口径在这里）；
4. 前置已就位的资产：记录片（胜负率统计的数据源）· 监控片（指标面）· ③ 管理面（处置动作的落点：RBAC 角色矩阵 + 四源审计可复用）。

## 2. 本片范围草案（路线图原文转录 + 注释）

- **谓词框架**：新框架 + **选择形态改造**（现为确定性 `slice(0,3)`；目标是「**随机凑 → 判定 → 扔回**」）+ **`match:rejected` 写入**（MVP 明确未写）；
- **同 IP 谓词** ← **IP 透传链**（网关 → room-service → meta 新字段；现链路无 IP。网关侧已有可信 IP 解析唯一实现：`packages/api-gateway/src/http/trusted-client-ip.ts`）；
- **同设备指纹** ← **deviceId 采集链**（客户端生成持久化 + 协议新字段 + 服务端落 meta；**隐私面需用户裁**，见 §3）；
- **异常检测**（胜率/局数类）← 硬依赖 P1 记录（✅ 已就位）；
- **频率面**：20 次/5 秒等**已实现**（五维限流）——不要重做；
- **申诉流程**：含，或**明说不做**（用户裁，见 §3）；
- **其余谓词**：近期交手（P1 后低成本）；地理 500m（前置 = region 分区 + §8.4①「扩大候选范围」——**R475：引入第二 region 前必须先补**）；
- ⚠️ **措辞订正（路线图原文）**：附录的 `throttle` 不可达缺陷在参考文档未实现代码里，**本仓无对象可修**；实现时按 `design.md` §5.4 基线。

**参考阈值备忘（附录 §3.4，注意均需过 §3 的裁决关）**：`checkFastAction` 5 秒窗口 >20 次（**全文唯一具体频率阈值**，主规格已取其基线）· `checkProbabilityAnomaly` winRate>0.8 且对局>100 · `checkDeviceFraud` 同一账号 >3 设备 · `score = 通过项数×25`（≥75 ban / ≥50 review / 否则 normal）· 处置例：`setLimit(userId,3,1000)` / 审核队列 / `banUser` + 通知 + evidenceId · 申诉 `POST /api/appeal/create` + 24h 响应 + 证据留存 `{userId, deviceId, ipAddress, recentActions, deviceFingerprint, collectedAt}`。

## 3. ⭐ 需用户拍板的产品问题（**设计首稿时一次性批量带来**，勿逐条挤牙膏）

1. **申诉流程**：做，还是明说不做？（参考设计含之；做了它依赖封禁/审核面）
2. **处置档位**：限流已有；**审核队列**（谁来审？用哪个角色？）与**封禁**（`banUser`，玩家段错误码 `11003` 已存在）要不要在本片落地？落地即成管理面动作 → 复用 ③ 的 RBAC + 审计四源；
3. **deviceId 采集的隐私面**：采（H5 + App 两套？）不采？存哪（meta/记录表？）保留多久？管理员可见性？（记录片纪律「isRobot/deviceId 永不出站」是既有先例，采集后仍要守）；
4. **机器人局口径**：胜负率统计是否排除机器人局？（random 场混机器人——不排除会把正常玩家的指标拉歪）；
5. **阈值照搬与否**：附录阈值（0.8/100 局、>3 设备）作为起点直接采用，还是按本仓现状另定？

## 4. 流程纪律（延续既定口径）

- **一条龙**：设计（首稿集中带来 §3 的产品问题）→ 审到满意 → 规格 → 审 → 计划 → 审 → 实现（逐任务 sonnet 实现者、一任务一提交、**每 2–3 任务一波评审**）→ 自测 → **opus 整支终审** → 收口；
- **审查减量**：审查者 sonnet · 报告只写发现 · 终审才用 opus；
- **六阶段只在 push 前跑一次**；**全序 conformance = CI 权威轮**（本机不跑全序）；
- **「跑了」必须指向本次产生的日志**；每任务台账落 `.superpowers/sdd/<日期>-risk-control/`；
- **假库会骗你**（③ 血泪四次：EXISTS 回值漂移 / 保留字 `key` / CSV 剥 BOM / 大小写变体）——**SQL 类与路径判定类改动默认要求一条真栈回归**；
- **探针要打在每条承重路径上**，尤其是下游无第二层守卫的那一条（③ 终审 F1 教训）。

## 5. 新会话怎么开局（一句话配方）

直接说：

> **按交接文档开工风控片：`docs/superpowers/plans/2026-10-05-risk-control-handoff.md`。先读 §1 上游，然后出设计首稿（把 §3 的五个产品问题集中一次带来）。**

报告落 `.superpowers/sdd/2026-10-05-risk-control/`；设计/规格/计划落 `docs/superpowers/{specs,plans}/`；本片收尾后照例写 `post-risk-control-handoff.md`。
