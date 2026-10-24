# 风控片 设计 v1.0（首稿）

> **定位**：路线图 P1′「运营地基：记录 → 风控」的第二片（记录 ✅ 2026-10-03）。本片 = **四条链**：**谓词链**（匹配期防串通）· **数据链**（IP 透传 + deviceId 采集）· **检测链**（胜率/设备异常 → 审核队列）· **处置链**（限流档/封禁 + 管理面 + 审计第五源）。前置全就位：记录片（检测数据源）· 监控片（指标面）· ③（RBAC + 审计模式）。**无新服务、无新容器**。
> **作者**：协调者（opus）；**状态**：**v1.1.2**（设计冻结本 + 规格 r1 三项订正回填：兜底顺位/子集=3/reopen 动作）。评审报告：`.superpowers/sdd/2026-10-05-risk-control/review-design-r1.md`；规格 r1 报告同目录 `review-spec-r1.md`。
> **用户裁决（2026-10-05，本设计不得与之冲突）**：
>
> | # | 裁决 | 说明 |
> |---|---|---|
> | K1 | **申诉：不做（明说）** | 封禁解除 = 管理端人工动作 + 审计留痕；封禁提示文案补「如有异议请联系客服」；申诉流程挂后续片 |
> | K2 | **处置：全套（含限流档）** | 队列 + 限流档 + 封禁。修复参考设计「throttle 不可达」的本仓口径 = 让「限流档」真正可达（§5.3） |
> | K3 | **deviceId：落库 + 管理员可见原文** | 玩家面永不出站（既有纪律）不变；管理员在风控视图可见 deviceId 原文与同设备关联账号 |
> | K4 | **机器人局：全量计入** | 不排除机器人局。用户理由：机器人补位水平需足够高；该假设的风险登记 §11 R3 |
> | K5 | **阈值：照搬附录 + 配置化** | 0.8 / 100 局 / >3 设备 作种子，全部进配置中心 |
>
> **开工前必读**：路线图 P1′（`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md:42`）· 附录 §3.4（`docs/appendix/platform-roadmap.md:140`）· `docs/design.md` §5.4/§8.2-8.5/§10.1 · **侦察笔记**（`.superpowers/sdd/2026-10-05-risk-control/recon-notes.md`，本设计全部 file:line 的事实出处）。

---

## §1 范围

### 1.1 本片做（八项）

1. **匹配谓词框架 + 选择形态改造**（room-service）：实现 `MatchPredicate`/`canFormTable` 纯函数框架（R53 当初「无调用方故意不做」，本片即首个调用方）；撮合取人从确定性 `alive.slice(0,3)`（`match.service.ts:602`）改为 **随机凑 → 判定 → 扔回**（§8.2/§8.4 既有规格；**含 `match.service.ts:546-566` 到点出口与 `attempts` 语义的明改**——§D1）；`match:rejected:{a}:{b}` 从「仅保留形状」转为**真写入**（TTL 5s、抽取时排除）。
2. **IP 透传链**：网关 → room-service（下游握手 `auth` 注入 `clientIp`，连接级事实、防伪面与 `userId` 同级）→ `match:meta` 新字段 `ip`。
3. **deviceId 采集链**：客户端（uni-app 一份代码 = H5 + App）生成并持久化 → `room.match` 可选新字段 → 服务端形状校验 → `match:meta` 新字段 `deviceId`；协议**出站禁键**清单加 `deviceId`（机械防线）。
4. **同 IP / 同设备两条谓词**：逐条配置键控制（**默认关**，§D4）；谓词命中即拒绝该对同桌（回队 + 失败记忆），并用 Redis 计数留档。
5. **异常检测（user-service 定时扫描）**：胜率/局数（记录片数据）+ 同账号设备数 → 评分 → **审核队列**（`risk_reviews`）。
6. **处置（全套）**：**限流档**（3 次/秒，自动 + 人工）· **封禁**（登录/WS 新连接/匹配入队/房间加入四读点即停）· 放行/解除；全部落 **审计第五源**（`risk_actions`）。
7. **管理面**：管理页新「风控」视图（队列 + 用户详情 + 动作 + 原因必填）+ 审计视图第五页签；网关 `admin-policy.ts` 矩阵扩条目（super_admin|operator）。
8. **可观测 + 验收**：新指标（谓词拒绝/抽选轮/扫描/队列水位/处置）+ 告警 2 条（扫描停摆 · 谓词拒绝率异常）+ 「06-risk」Grafana 面板；conformance 新切片 `slice-20-risk-control` + 全部既有闸同步（§9）。

### 1.2 明确不做（逐条明说，防「沉默缺口」）

- **地理 500m 谓词**：前置（第二 region + §8.4①「扩大候选范围」）未满足——**R475 明文：引入第二 region 前必须先补**；本片不引入 region，故 ① 保持「明说不做」。
- **近期交手谓词**：谓词框架**留位**（注册表加一条即可）、数据面 P1 已就绪；本片不塞第三个谓词（片体控制）。评审若要求可加。
- **申诉流程**（K1）：不做产品化（无玩家端表单/状态机/SLA）；参考设计的 `POST /api/appeal/create` 与「24h 响应」**无落点，挂后续片**。
- **频率面重做**：五维限流已实现且为规格值（§5.4）——不动；参考 `checkFastAction` 不另造一份。
- **自动封禁**：封禁**恒人工**（对参考 score≥75 自动 ban 的**有意偏离**：本片检测项恰两项 ⇒ score∈{25,50}，「75 档」在本语义下不存在，见 §5.2）。
- **长期 IP 留存**：IP 只在匹配期 meta 短存（谓词用）+ 命中计数（无 IP 值）；参考证据对象里的 `ipAddress` 有意不做（§7）。
- **地理/ELO/其它模式旁路**：不动匹配候选检索（O(n) 全量扫描维持现状，演进项不变）。

### 1.3 与既有资产的接触面（只扩展，不搬家）

| 既有资产 | 本片动作 |
|---|---|
| 五维限流（网关/room 各一份 ZSET 滑窗） | **只读扩展**：限流档 = 对该用户换用 3/1s 参数（§5.3）；**机制与键形状零改动、阈值参数化**；WS 档按 userId 计数（§5.3） |
| 记录两表（`game_records`/`game_record_players`） | 只读消费（胜率/局数）；**列零改动** |
| `users.status` + 11003（登录拦截已存在、**写路径为零**） | 本片补：封禁/解封写路径 + 三个即时读点（§5.4） |
| 网关 `admin-policy.ts`（P1–P9 显式枚举） | 追加风控 4 条（读 ×3 + 写 ×1）；P9 fail-closed 语义不变 |
| 审计四源（直读不建第二账） | 第五源 `risk_actions`（新表，同模式）；管理页审计视图 +1 页签 |
| 管理页 `admin/app.js`（五视图） | +1「风控」视图；VIEWS 角色门面 +2 项；沿用 textContent 禁 innerHTML 纪律 |
| 指标地基（shared/metrics） | 新指标按 `room.metrics.ts` 先例接线；Prometheus 规则 +2；Grafana +`06-risk.json` |
| 配置中心（17 键） | +8 键（17→25）；客户端可见子集（7 键）**不动** |
| 协议包（messages/validate/config） | `room.match` payload +可选字段；出站禁键 +1；键清单 +8 |

### 1.4 参考设计缺陷对账（附录 §3.4/§6 标注项，逐条落）

| 参考缺陷 | 本片口径 |
|---|---|
| `getRiskLevel()` 永不返回 `throttle` → 3/s 不可达（#24） | 参考代码**本仓无对象可修**（路线图措辞订正）；本仓 = 定义完整梯级 正常→**限流档**→封禁，限流档自动/人工双通道可达（§5.3） |
| 地理规则可被 GPS 伪造（:207） | 地理谓词不做（R475）；「谓词是威慑级、非强控」的定性已吸收（§7） |
| 申诉 24h 响应 + evidence 含 `ipAddress`（:157） | K1 不做申诉；`ipAddress` 不做长期留存（§7 偏离登记） |

---

## §2 架构决策（D1–D10）

**D1｜谓词框架与选择形态：按 §8.2/§8.4 既有规格实现，框架落 room-service。** 实现物 = `match/predicates.ts`（`MatchPredicate` 类型 + 两条具体谓词 + `canFormTable` 纯函数 + 注册表，开关由 config-cache 注入）。选择算法（`processQueue` 内）：**随机贪心抽 3**——洗牌 `alive` 后依序取候选，逐个检查「与已选全员两两允许」（允许 = 不在 5s `match:rejected` 记忆内 **且** 全部启用谓词通过），凑满 3 成组；凑不满 ⇒ 本轮不成组，转「最大合法子集」判定（§5.1）。成组失败 ⇒ **谓词拒绝**：对每一对写 `match:rejected`（字典序、值=失败时刻、TTL 5s）+ **两端** `attempts+1` + INCR；**记忆拒绝**：仅两端 `attempts+1`（不重写记忆、不 INCR——规格 F5 定案）；人始终留在队里（ZSET 不退，enteredAt 不变）。**孤儿票（无 meta）前置清出（v1.1.4 回填，波 1 F1）**：扫描前置筛选对每票读一次 `readMeta`，`null` ⇒ 静默 `cancelQueue` 清出（**无 12007**）——到点出口改写后不得让无主票流入抽取/兜底（原「60s 直走 failMatch」顺带承担的清理职责由此补回）；有 meta 的到点者维持兜底语义（断线者经 `match:pending` 可重连补回）。⚠️ **`attempts` 语义重定义**：现义 =「补机器人失败」计数（`match.service.ts:543` 注释原文），且现有 `:546-566` 的到点出口 = `failMatch`→12007；本片改为「**被随机抽中但成组失败**」计数，`546-566` 读点**同步改写**（§5.1；§9.1 #8——旧稿「前置不变」措辞废除，此处为**设计明改点**）。**回退链**（§8.4 次序不变）：① 扩范围 = R475 明说不做；② **机器人兜底三条入口**：<3 人 + 30s 越窗（既有主路径）· **≥3 人但凑不出合法三人组 ⇒ 最大合法子集（二人）+ 机器人**（同 30s 窗口；否则「A、B 互斥、C 与二者皆可」时 A/C 本可即刻合法成局却全体陪跑到 60s——F4 修）· 到点者（60s / attempts≥10）**先并入正常抽取**；本轮未成组者 ⇒ 兜底成组（≤3 人合法组）或「本人 + 机器人」；机器人不参与谓词（**v1.1.2 订正：旧稿「立即兜底」作废**——到点者仍可能被选入合法人类组，是更优结局，删「立即」）；③ 门禁答不能 ⇒ 12007。⏱ 时序注：attempts≥10 每轮至多 +1（5s/轮）⇒ 最早约 50s 可达，与 60s 出口接近但各自独立触发（谁先到谁走）。**机器人补位路径同样过谓词**（真人子集必须两两允许，否则拆组）——🔴 与现状的实现差异点（现状无谓词直接补）。数据缺失 **fail-open**（缺 ip/deviceId 的对视为允许——旧客户端与注入失败不打灭匹配）。**已否**：保留确定性 `slice(0,3)`（违背 §8.2 原文「随机选取」，且「同时入队相邻位」可被串通者利用）；全量组合搜索最大合法组（无必要）；谓词放网关侧（队列与 meta 都在 room）。

**D2｜IP 透传：注入点 = 网关→room 的*下游握手 auth*（连接级），不逐消息注入。** 网关在握手限流处已有可信 IP（`proxy.gateway.ts:164` 经 `requestIp`/`clientIpFrom`，唯一实现纪律），把 `{ip}` 挂 `client.request` 的槽位对象（`rate-limit.ts:214-229` 既有）；建下游连接时读回并注入 `auth: {userId, internalToken, traceId, clientIp?}`（防伪面与 `userId` 同级：auth 由网关构造、客户端值不可达）。room 端握手读入 `socket.data.clientIp`（形状校验 string ≤64，非法丢弃）；`handleMatch` 写 `match:meta`。缺失/unknown ⇒ 不写该字段（fail-open）+ 计数。**已否**：逐消息 `__clientIp`（每消息开销 + 复制 `__ackId` 面）；room 直读 upgrade 头（可信解析必须留在网关验真面，否则端口暴露即伪造）。**HTTP 面不动**（风控无需求；限流链路已有）。

**D3｜deviceId 采集：客户端生成持久化 + `room.match` 可选字段 + 服务端 meta + 落库上报。** 客户端（`apps/client`，H5/App 同代码）：首次生成 UUID（`crypto.randomUUID`，回落 `createReqId` 式，`net/socket.ts:262-266` 先例），持久化 `ftl.deviceId`（`net/storage.ts` KEYS 家族）；`room.match` payload 增可选 `deviceId`（≤64、`[A-Za-z0-9._-]`，protocol `validate` 形状校验）；room 写 `match:meta`。**落库（K3）**：匹配**入队成功**后 fire-and-forget RPC `risk.deviceReport`（room→user，3s 超时、失败即丢、无重试——记录片 `record.write` 同款纪律）；user-service 幂等 upsert（`uk(user_id, device_id)`，`last_seen` 1 小时节流）。**机械防线**：`FORBIDDEN_OUTBOUND_KEYS` 增 `'deviceId'`（今天只有 DTO 纪律与一句注释，无机械闸）。**已否**：全部连接上报（噪音 + 隐私面扩大的最省路径被否）；随 `record.write` 携带（污染记录契约）；放连接 auth（协议改动面更大）。**登记**：客户端生成值可伪造/可重装漂移——本采集是**威慑级**（§7），非强控。

**D4｜两条谓词与开关：逐条配置键、默认关、暗上线。** `risk.predicate.sameDevice` / `risk.predicate.sameIp` 默认 `false`。理由三条：① conformance/浏览器探针**全部同源同 IP**——同 IP 谓词一默认开就互斥全部测试配对；② 浏览器探针为**单实例 + 每轮临时 profile**（`browser-e2e.mjs:207/:219`）⇒ 同轮全部玩家共享 localStorage ⇒ deviceId 相同——同设备谓词也会打灭多玩家场景；③ CGNAT 误伤（§11 R1）。**生产开启手顺**（写进交接与手册）：先开 `sameDevice` 观察一周（看谓词拒绝率面板与告警），再评估 `sameIp`；两键随时可回关。**已否**：默认开（打灭既有测试与开发多开）；只金币场启用（模式旁路复杂化；random 场同样有「同伙同桌」动机的登记留察）。

**D5｜检测落点：user-service 定时扫描（照记录清理任务先例）。** 数据源 = `game_record_players ⨝ game_records`（`won`/`score_change` 现成）+ `user_devices`；**口径（K4）= 全量计入**（不排除机器人局；用户理由：机器人补位水平需足够高 → §11 R3 登记）；**模式口径 = random + gold**（practice 好友房不计——非匹配对局、熟人自愿同局，登记可审）。频率 = 固定间隔 3600s（env `RISK_SCAN_INTERVAL_MS` 测试覆盖，照 `RECORDS_CLEANUP_INTERVAL_MS` 先例）；启动 30s 首轮；**多实例安全照清理任务先例**（规格期先读其机制原文再抄，recon §E-2）。产出 = 每用户 stats → 命中判定（K5 阈值，§5.2）→ `risk_reviews` upsert + （score≥50 且 `risk.autoThrottle`）自动限流。**已否**：实时/事件驱动（复杂、无必要）；每局滚动窗口物化（现规模全表 GROUP BY 够用，§11 R5）。

**D6｜处置（K2 全套）：三档梯级 + 全部动作落审计第五源。** 正常 → **限流档**（3 次/秒，HTTP 用户维 + WS 消息维）→ **封禁**（`users.status='banned'` + Redis 旗 + 四个即停读点）。审核队列服务于人工决策：`dismiss | throttle | unthrottle | ban | unban`，原因必填（1..200）。**自动动作上限 = 限流档**（score≥50 且 `risk.autoThrottle`）；**封禁恒人工**。全部动作同事务写 `risk_actions`（actor = 管理员用户名 \| `'system'`）。**已否**：自动封禁（误伤不可逆；参考的 ≥75 自动 ban 档不做——检测项恰两项 ⇒ score∈{25,50}，75 在本语义下自然不存在，将来增项自动扩展，F7）；把风控塞进财务视图（角色语义混乱）。

**D7｜管理面：user-service 四端点 + 网关矩阵扩条 + 管理页一视图一页签。** 读（reviews 列表 / 用户详情 / actions 明细+CSV）= super_admin\|operator；写（actions）= super_admin\|operator；finance/viewer 无风控可见性（403 由网关矩阵产出）。服务侧照旧只信 `X-Admin:1` + `X-Admin-Actor`（写面 fail-closed，`requireActor` 先例）。**已否**：单独 admin 端点面挂 config-service（风控数据全在 user 库；③ 的「不新起服务」纪律延伸）。

**D8｜隐私与证据（K3）：deviceId 原文入库、管理员可见；IP 不留存。** deviceId 原文存 `user_devices`、管理端详情可见（含**同设备关联账号**——审核最需要的信号）；玩家面永不出站（三层 DTO 纪律不动 + 机械禁键）。IP：仅匹配期 meta 短存（谓词用）+ Redis 命中计数（无 IP 值）；**不做长期 IP 留存**（对参考 evidence `ipAddress` 的有意偏离，登记）。证据面 = 统计快照（reasons json）+ 设备原文 + 命中计数（近 7 天）。

**D9｜可观测：指标 7 条 + 告警 2 条 + 一面板。** room（3）：`match_predicate_rejections_total{predicate}` · `match_selection_rounds_total` · `match_no_legal_group_total`；user（4）：`risk_scan_runs_total{result}` · `risk_scan_last_success_timestamp_seconds` · `risk_reviews_open`（gauge）· `risk_actions_total{action}`。告警：`RiskScanStalled`（扫描停摆，照 `RecordsCleanupStalled` 先例）· `MatchPredicateRejectionHigh`（拒绝率 >50% 且样本足够、10m 窗口——**谓词开启后的安全绳**：CGNAT 全灭时打铃）。面板 `06-risk.json`（uid `ftl-risk`）**五块、每块都有指标源**：谓词拒绝（按 predicate）/ 抽选轮与不成组 / 扫描（runs + last_success）/ 队列水位（open 数）/ 处置计数（F8：旧稿「匹配时长/机器补位」无指标源，删）。**已否**：为默认关的谓词加默认告警（开后才有意义——同一条规则以「样本量」条件自然静默）。

**D10｜申诉：不做（K1）。** 封禁解除 = 管理端 `unban`（原因必填 + 审计）；封禁提示文案补「如有异议请联系客服」（客户端一处文案）；申诉产品化挂后续片（建议触发点：支付片前复盘）。

---

## §3 数据模型

### 3.1 user-service 三新表（共库 `fight_the_landlord`）

```sql
-- 1) 用户设备（K3：原文入库；玩家面永不出站；清理任务见 §5.6）
CREATE TABLE IF NOT EXISTS `user_devices` (
  `id`            bigint       NOT NULL AUTO_INCREMENT,
  `user_id`       varchar(64)  NOT NULL,
  `device_id`     varchar(64)  NOT NULL,
  `first_seen_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at`  datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_device` (`user_id`,`device_id`),
  KEY `idx_device` (`device_id`),
  KEY `idx_last_seen` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) 审核队列（检测产出；一用户一条「当前态」）
CREATE TABLE IF NOT EXISTS `risk_reviews` (
  `id`         bigint       NOT NULL AUTO_INCREMENT,
  `user_id`    varchar(64)  NOT NULL,
  `score`      int          NOT NULL,              -- 命中项数×25（参考口径）
  `reasons`    json         NOT NULL,              -- [{check:'winRate'|'devices'|'revived', detail:{…}}]
  `status`     varchar(12)  NOT NULL DEFAULT 'open', -- open|dismissed|throttled|banned
  `created_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `handled_by` varchar(32)  NULL,                  -- 管理员用户名；自动动作为 'system'
  `handled_at` datetime(3)  NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_id` (`status`,`id`),
  KEY `idx_user_id` (`user_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) 处置动作（审计第五源：一切写动作的权威记录，直读不建第二账）
CREATE TABLE IF NOT EXISTS `risk_actions` (
  `id`         bigint       NOT NULL AUTO_INCREMENT,
  `user_id`    varchar(64)  NOT NULL,
  `action`     varchar(16)  NOT NULL,   -- auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen
  `actor`      varchar(32)  NOT NULL,   -- 管理员用户名 | 'system'
  `reason`     varchar(200) NULL,       -- 人工动作必填；自动=检测摘要
  `review_id`  bigint       NULL,
  `detail`     json         NULL,       -- 如 {"from":"open","to":"banned"} / 自动动作的 score
  `created_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user_created` (`user_id`,`id`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

约定：迁移 = user-service 单文件、**顺延空号**（`1789400000000-GameRecords` 之后，规格期钉号）；时间列 `datetime(3)` 惯例；`risk_actions` 是**审计源本体**（管理页审计第五页签直读它，不建第二账）。

### 3.2 配置中心 +8 键（17→25；默认=种子=代码默认值）

| 键 | 类型 · 范围 | 默认 | 消费方 | 说明 |
|---|---|---|---|---|
| `risk.predicate.sameDevice` | bool | `false` | room-service | 同设备谓词开关（D4：暗上线） |
| `risk.predicate.sameIp` | bool | `false` | room-service | 同 IP 谓词开关（D4：暗上线） |
| `risk.winRateThreshold` | 数（0.5–1.0，两位小数） | `0.8` | user-service | 胜率线（K5） |
| `risk.minGames` | 整数（1–100000） | `100` | user-service | 样本量门槛（K5；命中条件 = `games > minGames`，与附录「>100 局」逐字一致） |
| `risk.deviceLimit` | 整数（2–100） | `3` | user-service | 窗口内设备数上限（K5） |
| `risk.deviceWindowDays` | 整数（1–365） | `30` | user-service | 设备计数窗口（防重装漂移假阳性） |
| `risk.autoThrottle` | bool | `true` | user-service | 自动限流总开关（score≥50 时自动置限流档） |
| `risk.deviceRetentionDays` | 整数（1–3650） | `365` | user-service | 设备行清理保留期 |

键注册 = `protocol/src/config.ts`（每键 JSDoc + 解析分支）；`config.test.ts` 计数断言 17→25；种子迁移 = config-service 顺延空号（照 `1789500000000-RecordRetention` 先例）。**客户端可见子集不动**（风控键全不上客户端）。

### 3.3 Redis 键变化

| 键 | 变化 | 说明 |
|---|---|---|
| `match:meta:{playerId}` | **+2 字段** `ip` / `deviceId` | 入队时写入；读取侧同步解析（读侧对旧形状容错） |
| `match:rejected:{a}:{b}` | **从「保留形状」转为真写入** | 字典序拼键；值 = 失败时刻 ms；TTL 5s（§5.1） |
| `risk:limit:{userId}` | 新增 | 限流档旗；值 `{source:'auto'\|'manual', at}`；TTL 即到期（auto 7 天滚动续期；manual 不过期直至解除） |
| `risk:banned:{userId}` | 新增 | 封禁旗；TTL 90 天；封禁动作写入、扫描每轮幂等补写（自愈）、解封删除 |
| `risk:hit:{userId}:{predicate}` | 新增 | 谓词命中计数（INT INCR）；TTL 7 天；详情面读 |

---

## §4 接口

### 4.1 协议包（`packages/protocol`）

| 变化 | 位置 | 说明 |
|---|---|---|
| `room.match` payload +`deviceId?: string` | `messages.ts:41` | 可选；旧客户端不发 = fail-open |
| 形状校验 | `validate.ts:351-358` | 存在则 string、len 8..64、`/^[A-Za-z0-9._-]+$/`；非法 ⇒ 10001（400） |
| 出站禁键 +`'deviceId'` | `validate.ts:37-42` | `FORBIDDEN_OUTBOUND_KEYS` 追加；机械防线（K3 的「管理员可见」只走管理面，玩家出站恒禁） |
| 配置键 +8 | `config.ts:14-40` | 含解析分支与计数断言（§3.2） |
| RPC 模式 +1 | `rpc.ts`（`RPC_PATTERNS`） | `risk.deviceReport`（room→user；三件套闸同提交，§9.1 #4） |

### 4.2 api-gateway（改造点）

1. **WS 下游握手 auth +`clientIp`**：`proxy.gateway.ts:329-339` 的 auth 组装增 `clientIp`（取自已挂 `client.request` 的连接槽位对象；`'unknown'`/缺失 ⇒ 不注入该键）。**只此一处注入**（每连接一次）。
2. **`admin-policy.ts` 矩阵追加 4 条**（显式枚举）：读三条（`GET /api/admin/risk/reviews` · `…/risk/users/:userId` · `…/risk/actions(+.csv)`）→ super_admin\|operator，**必须插在 P8 之前**（P8 =「其余 GET 任意角色」、首个命中即 return——照字面在尾部追加会被 P8 吞掉，F9）；写一条（`POST /api/admin/risk/actions`）→ super_admin\|operator，插在 P9 之前。P9 fail-closed 语义不变；测试必须含 **viewer/finance 读被 403**（证明未落 P8）。
3. **握手封禁读旗（F6，新增面）**：`verifyClient` 侧增 `risk:banned:{userId}` 读取（网关本有 Redis；每握手一次 GET）；命中 ⇒ 走既有 `rejectHandshake` 面（`proxy.gateway.ts:451-495/:504-509`）以 `system.error` + `11003` 告知后拒绝——**用户可见的封禁拒绝面只可能在网关**（对下游断开，网关零处理面，不可指望 room 握手拒绝能传回客户端）。Redis 故障语义 = **本读点 fail-open**（按「无旗」放行 + error 日志）——与既有「session 查询失败 ⇒ rejectHandshake 10007」的 fail-closed（`proxy.gateway.ts:481-488`）**有意不同**：封禁主闸在登录 DB 面，此处可用性优先；口径与 §7/R11 一致。
4. **路由登记 + query 白名单**：`gateway.controller.ts` 四端点逐条登记；过滤参数照 `recordsQueryOf` 先例逐条白名单（`status/limit/cursor/userId/action/actor/from/to`）；路径参数编码照 `:key`/`:userId` 先例（R75）。
5. **不动**：`forward()` 头面（无新增下游头）；`identity-headers.ts` 纪律面；限流中间件结构（只在用户维判定处加「限流档旗 peek」，§5.3）。

### 4.3 room-service

| 点 | 变化 |
|---|---|
| 握手读入 | `ws.gateway.ts:287-311` 增读 `auth.clientIp` → `socket.data.clientIp`（形状校验；非法丢弃） |
| `handleMatch` | 校验后把 `deviceId` 与 `socket.data.clientIp` 写入 `match:meta`（新字段）；入队成功后 fire-and-forget `risk.deviceReport`（`metaFromTrace()` 随行） |
| 封禁/限流读点 | 统一小函数 `riskFlags(userId)`：入队前读 `risk:banned`（拒 11003）；WS 消息维读**限流档**（按 userId 计数，F12）与封禁；房间加入读封禁（§5.3/§5.4）。**WS 新连接的封禁读点在网关**（§4.2-3，F6） |
| `match.service` | D1 全部改造（随机贪心抽 3 / 谓词判定 / 失败记忆 / attempts / 回退链 / 指标）；谓词开关来自 config-cache |
| 指标 | `room.metrics.ts` 追加 3 条（§D9） |
| RPC 三件套 | `risk.deviceReport` 发送点 + `metaFromTrace()` + （接收侧在 user-service）|

### 4.4 user-service

| 端点/物 | 说明 |
|---|---|
| `risk.deviceReport`（RPC 接收侧） | 新 `@MessagePattern`；模块 `controllers:` 注册（J21 闸）；幂等 upsert（§5.6） |
| `GET /api/admin/risk/reviews` | 队列列表：`?status&limit&cursor`（keyset `id DESC`）；行 `{id,userId,score,reasons,status,createdAt,updatedAt,handledBy,handledAt}` |
| `GET /api/admin/risk/users/:userId` | 详情：stats（games/wins/winRate/deviceCount）+ devices（**原文**、首末见、每设备「同设备关联账号」≤20 条含 status）+ 近 10 条 reviews + hits（近 7 天各谓词计数）+ 当前 status（封禁/限流实时态） |
| `POST /api/admin/risk/actions` | `{userId, action: dismiss\|throttle\|unthrottle\|ban\|unban, reviewId?, reason}`；reason 1..200 必填；actor fail-closed；**同一事务**：状态变更（users.status / 旗 / review 状态）+ `risk_actions` 行 |
| `GET /api/admin/risk/actions(.csv)` | 审计第五源读口：过滤 `userId&action&actor&from&to` + keyset；CSV 照既有契约（BOM/消毒/附件名） |
| 扫描任务 | `risk/scan.service.ts`（D5）；新指标 4 条 |
| 设备清理 | `risk/devices-cleanup.service.ts`（照记录清理同款：批删 LIMIT 1000、自重排、env 覆盖间隔、cutoff=现读 `risk.deviceRetentionDays`） |
| 配置消费 | config-cache 增 8 个 getter（坏值回落默认） |
| 迁移 | 三新表（§3.1） |

### 4.5 管理页（admin/）

- **VIEWS 元表**（`app.js:196-211`）新增「风控」（roles：super_admin/operator）；index.html 顶栏 +1 按钮。
- **风控视图**：队列表（状态过滤 + keyset 翻页：用户/评分/reasons 摘要/状态/时间）+「用户详情」展开（stats/设备原文/关联账号/命中计数）+ 动作按钮（放行/限流/解除限流/封禁/解封）+ **原因输入必填**（前端校验 + 服务端 fail-closed）+ 每次动作后刷新当前行。
- **审计视图第五页签**「风控处置」（读 `risk_actions`：过滤 + CSV）。
- 纪律不变：只按 HTTP status 分流、**textContent 禁 innerHTML**（deviceId 是服务器数据，同样纪律）、401 回登录。

### 4.6 客户端（apps/client，H5/App 同代码）

- `net/storage.ts` KEYS 家族 +`ftl.deviceId`；首次生成 `crypto.randomUUID()`（回落 `dev-<base36>`），此后持久读取。
- `room.match` 发送点带 `deviceId`（唯一发送点 = `apps/client/src/pages/game/game.vue:142`——「匹配的唯一实现仍在玩法页一处」纪律原文见 `table.vue:395-396`；F11 核正）。
- 11003 展示文案补「如有异议请联系客服」（K1）。

---

## §5 语义细节

### 5.1 谓词与选择形态（D1 的实现口径）

- **允许谓词**：`sameDevice(a,b)`：`a.deviceId && b.deviceId && a.deviceId === b.deviceId` ⇒ **排除**；`sameIp` 同构。未启用/缺数据 ⇒ 允许（fail-open）。
- **抽取**：`alive`（已过超时筛选）**先洗牌（副本；原序保留供 `oldest` 判定）**；依序贪心取 3（新候选须与已选全员两两允许）；凑满 ⇒ 组；凑不满 ⇒ 本轮不成组，转**最大合法子集判定**（见下）。「洗牌未轮到」不算失败（不写记忆、不加 attempts）；**谓词拒绝**的对 ⇒ 写 `match:rejected` + 两端 `attempts+1`；**记忆拒绝** ⇒ 仅两端 `attempts+1`（不重写记忆、不 INCR——规格 F5 定案）。
- **记忆消费**：抽取时对每一对先查 `match:rejected`（5s 内 ⇒ 视为不允许）；TTL 自然过期即恢复可配。
- **与既有判据的合成（明改点）**：现 `match.service.ts:546-566` 的到点出口 = `failMatch`→12007、`attempts` = 「补机器人失败」计数（:543 注释原文）——本片**明改**：① `attempts` 改义为「被随机抽中但成组失败」计数（每轮至多 +1、5s/轮 ⇒ 最早 ~50s 达 10）；② 到点者（60s / attempts≥10）**优先参与正常抽取**（v1.1.2 订正；旧稿「立即兜底」措辞废除），本轮未成组者的出口改为 **②机器人兜底**（合规小组合／本人 + 机器人；过可用性门禁 fail-open）→ 门禁不能给 ⇒ **③ 12007**（§8.4 回退次序不变，F3）。
- **最大合法子集路径（F4 修；适用面 = `alive ≥ 3`，`< 3` 走既有越窗主路径，不重叠）**：**≥3 人**但凑不出合法三人组时，对**最长等待者**取「两两合法的最大子集」（贪心、至多 3）：**子集 = 3 ⇒ 直接成三人组（v1.1.2 补：无需机器人/窗口）**；子集 = 2 ⇒ 其最久者等待 ≥30s 后 **子集 + 1 机器人**成局；子集 = 1 ⇒ 该人按 `<3` 越窗同规、等待 ≥30s 后「本人 + 2 机器人」；两者窗口与门禁同既有规则。否则「A、B 互斥、C 与二者皆可」时 A/C 本可 30s 合法成局，却全体陪跑到 60s。
- **机器人透明**：谓词只判定「将同桌的真人子集」；三条补位入口（<3 越窗 · 最大合法子集 · 到点兜底）同规——真人子集必须两两允许，不通过 ⇒ 拆（各自与机器人开局）。
- **观测**：每轮「≥3 真人」计数 `match_selection_rounds_total`；拒绝 `match_predicate_rejections_total{predicate}`；不成组 `match_no_legal_group_total`；命中计数（Redis，两玩家各 +1，TTL 7d）。

### 5.2 检测扫描（D5 口径）

- **输入**：① 每用户（`status='active'` 且非 banned）在 `random|gold` 模式的 `games = COUNT(*)`、`wins = SUM(won)`、`winRate = wins/games`；② `deviceCount = COUNT(DISTINCT device_id)`（`last_seen_at ≥ now - risk.deviceWindowDays`）。
- **命中**：`hit1 = games > risk.minGames && winRate > risk.winRateThreshold`（F13：与附录「>100 局」逐字一致）；`hit2 = deviceCount > risk.deviceLimit`。**score = 命中项数 × 25**（参考口径；频率项不重复计入——五维限流已承接）。
- **产出（upsert 表，F5 修）**：score ≥ 25 时按现有条目状态分流：

  | 现有条目 | 本扫描行为 |
  |---|---|
  | 无 | 新建 `open`（reasons 含数值快照） |
  | `open` | 更新 score/reasons；若 score ≥ 50 && `risk.autoThrottle` ⇒ **先读旗现值**：无/auto ⇒ 自动置旗 + 迁 `throttled`（handled_by=system）；**旗=manual ⇒ 仅迁条目、旗与 handled_* 不动、零审计**（终审 F1；该读为「决策读」= 失败照抛） |
  | `throttled` | 更新 score/reasons；auto 旗按「自动限流」条目规则**本轮 score 一次定夺**（≥50 续期 / <50 解除）；manual 旗不动 |
  | `dismissed` | 仅当 score > 处置时 score ⇒ 新建 `open`（reasons 附 `revived` 元素 + `risk_actions(reopen,'system')`；v1.1.2 补落点，F17）；否则不动（**抑制语义**：人工判过后同分不复活） |
  | `banned` | 统计跳过；不产出行 |

- **自动限流（F5 修；同一轮按本轮 score 一次定夺）**：条目 `open` 且 score ≥ 50 且 `risk.autoThrottle` ⇒ **先读旗现值**：无/auto ⇒ 置旗（source=auto，TTL 7d）+ 迁 `throttled` + 记 `auto_throttle`（handled_by=system）；**旗=manual ⇒ 仅迁 `throttled`（旗与 handled_* 不动、零审计）**（终审 F1；该读=决策读，失败照抛）；条目 `throttled`(auto) 且本轮 score ≥ 50 ⇒ **续期**（不刷审计）；`throttled`(auto) 且本轮 score < 50 ⇒ **自动解除**：删旗 + 记 `unthrottle`(actor='system') + 回迁（score ≥ 25 ⇒ 回 `open`；score < 25 ⇒ 置 `dismissed`，reason「指标回落，自动解除」）；`throttled`(manual) 一律不动（人工解除是唯一通道）。**封禁恒人工**（检测项恰两项 ⇒ score∈{25,50}，参考的 75/自动 ban 档在本语义下不存在——将来增项自然扩展，F7）。
- **自愈（F14 修）**：每轮为 `status='banned'` 用户**写旗前复核该用户最新 status**、幂等补写 `risk:banned` 旗（防「扫描先读名单 → 人工解封 → 扫描后写旗」的复活竞态；Redis 丢失/重启后封禁不失效）。
- **模式口径**：practice 不计（§D5 登记）；banned 用户跳过统计。

### 5.3 限流档（K2 的「修复不可达」）

- **定义**：限流档 = 该用户的**单用户 HTTP 维**与**单用户 WS 消息维（按 userId 计数，见执行点）**阈值降为 `{max:3, windowMs:1000}`（常量 `THROTTLED_RATE_LIMIT`；**规格值**——参考 `setLimit(userId,3,1000)` 的落点）。
- **执行点两处**：网关 `http-rate-limit.middleware`（用户维判定处 peek `risk:limit`——命中走 3/1s）· room `message.router.ts:171-175`。**机制与键形状零改动、阈值参数化**（现阈值编进 `hitHttpLimit`/`isRateLimited` 常量 [rate-limit.ts:4/:74-86]，须扩参或加档位变体——规格定，F12）。⚠️ **WS 档按 userId 计数**（键 `ratelimit:ws-risk:{userId}`，替代按 socketId）——否则多开 5 连接可把 3/s 放大到 ~15/s，「压制自动化」的目标落空（F12）。**匹配入队无需另挂第三点**：入队本就限「同时 1 条」（12009），叠加无增益（用户选项稿里的「匹配点」以此收敛）。
- **设置/解除**：自动（§5.2）与人工（`POST risk actions: throttle|unthrottle`）双通道；人工旗不被自动逻辑清除；解除动作删旗 + 审计。
- **语义说明**：真人手动操作远达不到持续 3/s ⇒ 正常体验无感；该档压制的是**自动化脚本**的吞吐（威慑梯级的中间档，不是「降低整体体验」）。
- **有效面**：逐请求/逐消息判定 ⇒ 对存量连接即时生效。

### 5.4 封禁（写路径 + 四读点）

- **写**：动作事务内 `users.status='banned'` + 写 `risk:banned` 旗（TTL 90d）+ `risk_actions` 行（reason 必填）。
- **四读点即停**（统一 `assertNotBanned`）：① 登录（既有 `auth.service.ts:84`，11003/403 不变）② **网关 WS 握手**（`verifyClient` 读旗 ⇒ `rejectHandshake` + `system.error 11003`——用户可见的拒绝面只可能在网关，F6 修；§4.2-3）③ 匹配入队（room 读旗 ⇒ ack 11003 借既有码）④ 房间加入（room 读旗 ⇒ 拒）。存量连接与**进行中对局不打断**（一局分钟级；登记 §11）——**v1.1.5 口径（波 2 F3 裁决）：不打断 = 存量连接与其对局自然推进；断线者不获「进行中局豁免」（断线即出局）**。
- **解封**：`status='active'` + 删旗 + 审计；扫描自愈侧已加「写旗前复核 status」（§5.2），无双写竞态（F14）；即时全通（无需重登）。
- **存量令牌窗口**：封禁后既有 access/refresh 的 HTTP 只读面在 TTL 内仍通（**新对局入口已被 ②③④ 拦断；存量连接的对局自然推进、断线即出局**——v1.1.6 措辞订正）⇒ §11 R8 登记。

### 5.5 审核队列生命周期

`status` 反映**当前处置态**：`open`（待处理）→ `dismissed`（放行）\| `throttled`（限流中）\| `banned`（封禁中）；**解除动作一律回 `dismissed`**（人工判过的抑制语义——自动武装只在 `open` 发生；涨分重开为 `open`，F5 修）；**自动解除的回落见 §5.2**（score ≥25 回 `open`、<25 置 `dismissed`〔handled_by=system〕）。每次迁移 = `risk_actions` 一行（**例外**：KEEP_HANDLER 迁移——manual 旗下 `open`⇒`throttled`——**零审计**：无实际变更发生；终审 F1）。队列条目**不删除**（历史可查）。

### 5.6 设备记录（上报与清理）

- **上报**：匹配入队成功后 fire-and-forget `risk.deviceReport {userId, deviceId}`；upsert：新行插 `first_seen=last_seen=now`；已存在 ⇒ `last_seen` 仅当 >1h 未更新才刷（写放大节流）。**只报匹配路径**（好友房不报——谓词与检测均面向匹配对局）。
- **清理**：独立任务，批删 `last_seen_at < now - risk.deviceRetentionDays`（LIMIT 1000/批，间隔 env 覆盖）；每轮现读配置。

---

## §6 配置与 env

- **+8 配置键**（§3.2）；**无新 env**（扫描/清理间隔的 env 仅测试用，照 `RECORDS_CLEANUP_INTERVAL_MS` 先例：`RISK_SCAN_INTERVAL_MS` / `RISK_DEVICES_CLEANUP_INTERVAL_MS`）。
- **无新服务、无新容器、无新端口**；compose/Dockerfile 零改动。
- 热生效：谓词开关 ≤60s（config-cache 安全网）；扫描/清理「下一轮生效」。

---

## §7 安全与隐私

- **玩家面零暴露不变**：deviceId/IP 不进任何玩家出站（DTO 三层纪律 + **新增机械禁键**）；封禁提示为唯一玩家可见变化（文案）。
- **deviceId 可伪造/可重装漂移**：威慑级控制（诚实登记——清存储或伪造即失效）；`risk.deviceWindowDays` 窗口缓解重装假阳性。
- **IP 不留存**（对参考 evidence 的有意偏离）：匹配期 meta 短存 + 命中计数（无 IP 值）。
- **管理面**：风控读写 = super_admin\|operator；写动作 actor fail-closed（缺头 ⇒ 4xx，照 ③）；deviceId 原文只在管理面（K3）。
- **可信注入**：clientIp 只可能来自网关验真后的 auth（客户端值不可达）；对应纪律注释随改。
- **`risk:limit` / `risk:banned` 旗读三类（v1.1.8 终审 F1 起定稿；规格 §2.6-5 为逐字出处）**：**检测位读**（热路径执法）= 失败按「无旗」放行 + error 日志（可用性 > 边角防护；封禁主闸在登录 DB 面）；**校验位读**（管理动作前置校验）= fail-closed；**决策读**（自动逻辑武装/解除前判读）= 失败照抛（回滚 + 下轮收敛——fail-open 会复现缺陷本身）。
- **配置写审计沿用**：risk.* 键的修改走既有 `config_changes`（actor=用户名），operator 可改谓词开关（与既有 P4 一致，登记）。

---

## §8 错误码与 HTTP 映射

| 场景 | HTTP | code 口径 |
|---|---|---|
| `room.match` 的 deviceId 形状非法 | 400 | 借 `10001` + 原因串 |
| 封禁：登录 | 403 | `11003`（既有，不动） |
| 封禁：匹配入队 | ack 错误 | `11003`（借既有玩家段码；不新造） |
| 封禁：WS 握手被拒（网关读旗） | 断开（`rejectHandshake`：`disconnect(true)` + 尽力 `system.error`；**权威信号 = 断开本身**，`proxy.gateway.ts:499-509`） | `11003`（F6 修；沿用既有 `verifyClient` 拒绝面） |
| 封禁：房间加入 | ack 错误 | `11003` |
| 限流档：超 3/1s | 429 / ack | `10006`（既有；阈值换档不改码） |
| 管理动作参数非法（reason 缺失/超长、action 非法） | 400 | 借 `10001` + 原因串 |
| 风控端点角色不足 | 403 | 既有管理员信封（网关矩阵） |
| 用户不存在（risk detail） | 404 | 借 `11004`（既有先例） |

**16xxx 段**（`design.md:1469` 预留）：本片**不启用**（全部场景有既有码可借）——保留不动。

---

## §9 冲击清单（实施时**逐条**核销；漏一条 = push 必红或静默失明）

### 9.1 硬闸（不改必红）

| # | 资产 | 现状 → 本片 |
|---|---|---|
| 1 | `protocol/src/config.ts` + `config.test.ts:11-21` | 17→25 键；计数断言与清单同步 |
| 2 | `protocol/src/messages.ts:41` + `validate.ts:351-358` | room.match +deviceId 形状校验（含负例测试） |
| 3 | `validate.ts:37-42` 出站禁键 | +`'deviceId'`；出站泄漏族测试同步（断言清单处） |
| 4 | **RPC 三件套**：`messages.test.ts` pattern 清单 · `robot-availability-wiring.gate.test.ts`（`risk.deviceReport` 接收侧必须真接线）· `meta-on-every-rpc-send.gate.test.ts`（新 `.send(` 含 `metaFromTrace()`） | 同提交 |
| 5 | `room-service/test/no-internal-http.gate.test.ts` | 新 RPC 调用点进 `RPC_USAGE`/`RPC_CLIENTS`/`ROOM_CALL_SITES` + 手写探针正/负两行 |
| 6 | `api-gateway/src/auth/admin-policy.ts` + 其单测 | 追加 4 条（**读三条插在 P8 之前**——顺序敏感，F9；逐条正反 + viewer/finance 读被 403 证明未落 P8）；P9 fail-closed 不变 |
| 7 | `api-gateway/src/gateway/gateway.controller.ts` | 4 路由登记 + query 白名单逐条 |
| 8 | `packages/room-service/test/match*.test.ts` + `match.service.ts:546-566` 读点本体 | 选择逻辑重写；**到点出口改写（failMatch→机器人兜底→12007）与 `attempts` 语义重定义**（F3）；`slice(0,3)` 断言处全改；最大合法子集路径用例 |
| 9 | `tools/conformance/baselines.json` | +`slice-20-risk-control` 下限（CI 实测回填）；被改切片读数只抬不降 |
| 10 | **admin 两文件字面量**（F10 核正——slice-19 无页签断言） | 「审计四页签」字面量在 `admin/app.js:30/:225/:1193/:1753` 与 `index.html:253` ⇒ 同步改五页签；**建议**给 slice-19 G12 针脚追加风控端点串 |
| 11 | **config-service 单测**（F2 核正——真钉不在 slice-14/17）：`test/platform-config.service.test.ts:270-277`（`toHaveLength(17)` + `CONFIG_KEYS` 全等 + SEED 17 行）与 `test/helpers/config-probe.ts:29-32`（SEED 副本） | 17→25 同步；全仓扫「十七 / 17 键」字面量；slice-14 客户端七键断言**不动** |
| 12 | `scripts/ledger-counts.mjs` 台账计数 | 同步 |
| 13 | `admin/app.js` VIEWS 元表 + index.html | 风控视图 + 审计页签；UI 存量单测/断言（若有）同步 |
| 14 | `deploy/monitoring/**`（ftl-alerts.yml + 新面板 JSON） | promtool check + 面板 JSON 合法性 |
| 15 | slice-07.4-pipeline `EXPECTED_FILES` 类闭集闸 | 新文件（迁移/模块/面板）是否触及被钉集合 ⇒ 实施首日核销 |
| 16 | `tools/conformance/src/slices/slice-16-monitoring.ts`（F1 修） | **+2 告警必红**：`EXPECTED_RULES` 16 名集（:89-95）· `promtool … 16 rules found`（:593）· `/api/v1/rules` 恰 16 + 名集（:649-657）⇒ 16→18 同步；**+1 面板必红**：五块面板名集（:717-722）⇒ 5→6 |
| 17 | `api-gateway` 握手封禁读旗（F6 新增面） | `verifyClient` 读 `risk:banned` + `rejectHandshake` + 单测（旗在/旗无/Redis 故障三态） |

### 9.2 计数/文案（人工同步，防文档谎报）

- `docs/design.md`：§8.3/§8.4 的 `[部分实现]` 标记与 R53/R475 注记回填（谓词与 match:rejected 落地后）；§10.1 键表 `match:rejected` 行（「MVP 不写入」→ 已写入）；§7.5 键表 17→25；§2.1 表 config-service 行「十七键」字样（`design.md:142` 等）；风控相关 §5.4 注记（限流档衔接）。
- `docs/client-protocol.md`：room.match payload +deviceId；11003 文案（:251）。
- `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P1′ 风控节标完成 + `deviation-ledger.md` 新条目 **N58–N64 七条**（IP 不留存 / 申诉不做 / practice 排除 / 自动封禁不做 / `games > minGames` 边界 / compose 两行测试注入 env / **N64 自动解除回迁 `open` 档置 `handled_by=system`**〔T5 裁决「准」新增〕）。
- 台账 `.superpowers/sdd/2026-10-05-risk-control/`（recon-notes / progress / 评审报告）。

### 9.3 明确不动的面（防误伤）

玩家五维限流结构 / 记录两表 schema / 匹配候选检索（O(n) 维持）/ edge Caddyfile / compose 拓扑 / `slice-07.2-security` 座位归属面 / 好友房与手动房行为（谓词豁免——§8.5 群语义「自选同局」）。

---

## §10 测试与验收

**单测矩阵（每服务）**：

- **room-service**：`canFormTable` 真值表（同对/异对 × 两谓词 × 缺数据 fail-open × 机器人透明）；随机贪心选取（凑得满/凑不满/记忆排除/洗牌未轮到的语义）；失败写入（成对、字典序、TTL 参数）+ `attempts+1` 恰一次/人/轮（**新语义**）；回队 enteredAt 不变；回退链（30s/60s/attempts10 → 机器人兜底 → 门禁不能给 ⇒ 12007；**含到点出口改写——不再直走 failMatch**，F3）；**最大合法子集（2 人 + 机器人）路径**（F4）；`<3 人补位路径过谓词（拆组）`；`match:meta` 写 ip/deviceId（含读侧旧形状容错）；`risk.deviceReport` 恰在入队成功后触发一次（mock）+ meta 随行；封禁/限流读点（入队/join/消息维；**WS 档按 userId 合并计数**）。
- **user-service**：devices upsert 幂等 + last_seen 1h 节流；扫描（命中矩阵〔含 `games > minGames` 边界〕、score、**upsert 表全行（含 throttled 行与 dismissed 抑制语义）**、auto 限流置/删/续、**解封竞态（写旗前复核 status）**、banned 跳过、模式口径 random+gold）；actions 端点（actor fail-closed、reason 必填、六动作 × 状态迁移 × 审计行同事务、越权语义在网关侧）；审计列表过滤/keyset/CSV；设备清理任务（cutoff 现读配置、批删）。
- **api-gateway**：policy 4 条正反（operator/超管过；**finance/viewer 读被 403——证未落 P8**）；**握手封禁读旗（旗在 ⇒ rejectHandshake + 11003；旗无 ⇒ 正常；Redis 故障 ⇒ 沿握手纪律）**；限流档（旗在 ⇒ 3/1s 生效、旗无 ⇒ 20/5s 原样；**WS 档按 userId 合并计数——多连接不放大**）；clientIp 注入（有则注、unknown 不注）；deviceId 不存在于任何新注入头。
- **protocol**：deviceId 校验正反例（长度/charset/可选）；出站禁键 deviceId 拒发；键计数 25。

**conformance `slice-20-risk-control`**（真栈，E2E）：`risk.*` 配置键存在与种子值（25 键）· **谓词开/关行为对照**（开 `sameDevice`：两客户端同 deviceId + 第三人 ⇒ **同设备二人永不同房**；最大合法子集（先到者 + 第三人）于 30s 窗口后 + 机器人成局、落单者走兜底；关 ⇒ 正常成局；`sameIp` 同构——**同主机测试天然同 IP，是此用例的现成条件**）· 入队 → `risk.deviceReport` → 管理详情设备可见（原文）· 阈值调低 + 造数 ⇒ 扫描产出队列条目 → dismiss → 审计行 · **人工限流**：throttle → 快速请求触发 429 → unthrottle → 恢复 · **封禁全链**：ban → 新登录 403/11003 →（模拟存量）WS 拒连 → unban → 恢复 · **RBAC 负例**：viewer/finance 对 4 端点 403，operator 200 · 审计第五源列表 + CSV 头/消毒 · 玩家面回归（records/mine 键集不漏 deviceId——既有断言 + 本片复核）。

**验收轮**：本机六阶段（push 前一次）· **CI 权威轮三绿** · 浏览器级：`scripts/browser-e2e.mjs` 先跑（本片预期零影响——谓词默认关）+ admin「风控」视图实拍走查（队列/详情/动作/审计第五页签）+ 玩家 11003 文案观感 · 上线形态 = 用户打 tag（`v*`）；**谓词开启 = 上线后手顺**（§D4）。

---

## §11 残余风险与待审低置信项（评审重点）

| # | 风险 | 处置/口径 |
|---|---|---|
| R1 | CGNAT/校园网：同 IP 谓词误伤「整网玩家互斥」 | 默认关 + 开启手顺 + `MatchPredicateRejectionHigh` 告警 + 一键回关；登记 |
| R2 | deviceId 可伪造/可重装漂移 | 威慑级定性；窗口计数缓解重装；登记（强控需设备证明链——不做） |
| R3 | **K4 假设风险**：全量计入下，低档机器人偏弱 ⇒ 新服胜率整体抬升 ⇒ 假阳性 | 阈值全可配 + 自动动作仅到限流档 + 面板盯队列水位；**「机器人水平足够高」是产品前提**（依赖 `robot.skillDistribution` 现状）——评审请重点复核 |
| R4 | 谓词默认关 ⇒ 上线首日防护未武装的观感 | 明说 + 手顺（先同设备观察一周再同 IP）；本片交付物是「链 + 框架 + 可武装」 |
| R5 | 扫描全表 GROUP BY 的规模 | 现量级无虞（`idx_user_ended` 支撑）；>百万行再谈聚合表（登记，照 ③ R5 先例） |
| R6 | 多实例扫描并发 | 照清理任务机制（规格期先读原文再抄；若为「自重排无锁」则扫描天然幂等可接受）——低置信项，规格钉 |
| R7 | 密场景下 `match:rejected` 触发密度（极端全灭） | 5s 记忆 + 每轮只试一次 + attempts 上限 + 机器人兜底 + 拒绝率告警；登记 |
| R8 | 封禁存量令牌窗口（HTTP 只读面 ≤2h/续刷 ≤7d；**新对局入口四读点全拦；存量对局自然推进、断线即出局**——v1.1.6） | 登记接受（TTL 实读：2h/7d） |
| R9 | 限流档 3/s vs 正常 20/5s 差值小（HTTP 单通道仅 25% 降） | 规格值（参考原值）；WS 档已改按 userId 计数（F12），多连接放大面已封；主要威慑仍是队列+封禁；登记 |
| R10 | 申诉不做（K1）⇒ 误封无产品化申诉通道 | 人工解封 + 外部渠道文案兜底；挂后续片（建议支付前复盘）；登记 |
| R11 | 旗读取 fail-open（Redis 故障时限流/封禁短暂失效） | 可用性优先的显式取舍（登录 DB 主闸仍在）；评审可挑战为 fail-closed |
| R12 | 门槛数据面：`risk.autoThrottle` 默认 true 是否过激 | 自动动作上限=限流档（温和、可自动恢复）；评审可改默认 false |
| R13 | practice 模式排除（D5） | 设计裁量（非用户裁决）；登记可翻 |
| R14 | 规格期低置信项（recon §E）：attempts 现语义 / 清理任务多实例机制 / readMeta 容错 / 迁移空号 / slice-19 字面量 / user token TTL | 规格阶段逐条实读钉死 |

---

## §12 交接须知（给广告片与支付片）

- **支付片**：风控面就绪——`risk_actions` 审计模式、限流档执行点、封禁即停读点可直接复用；支付风控（异常充值/提现）建议按同框架加「检测项」而非新体系。
- **下一片候选**：广告小片（金币场救助前置）→ 支付片；**风控生产开启手顺**（D4）与「申诉复盘」进交接文档 TODO。
- 若后续要加「近期交手」谓词：注册表 +1 条 + 一个查询面（records 已有）；框架为此而建。

---

## 修订记录

- **v1.0**（2026-10-05）：首稿。K1–K5 用户裁决入表；D1–D10 架构决策；三新表/8 配置键/5 Redis 键；冲击清单 15 硬闸 + 文案同步面；残余风险 14 条。侦察笔记：`.superpowers/sdd/2026-10-05-risk-control/recon-notes.md`。
- **v1.1**（2026-10-05）：**r1 评审全数处置**（14 条：2🔴/4🟠/8🟡；评审报告 `.superpowers/sdd/2026-10-05-risk-control/review-design-r1.md`）——**F1** slice-16 两处闭集硬闸（规则名集 16→18、面板 5→6）入冲击清单 #16 · **F2** 键数同步真钉改指 config-service 单测 + SEED（#11 核正）· **F3** 到点出口与 attempts 语义改为**明改点**（D1/§5.1；「前置不变」措辞废除）· **F4** 补「最大合法子集（二人）+ 机器人」路径（D1/§5.1/§10）· **F5** upsert 表 + 抑制语义（解除回 dismissed、自动武装仅 open）· **F6** 封禁读点②上移网关握手（rejectHandshake + 11003；§4.2-3/§5.4/§8/§9.1 #17）· **F7** 删「75 线高优先入队」死文案 · **F8** 指标 7 条 + 面板五块按指标源收敛 · **F9** policy 读三条**插 P8 之前** + 403 正反测试 · **F10** 「四页签」字面量改指 admin 两文件 · **F11** 发送点核正为 `game.vue:142` · **F12** 阈值参数化 + WS 档按 userId（R9 同步）· **F13** `games > minGames`（逐字对齐附录）· **F14** 封禁旗自愈加「写旗前复核 status」。
- **v1.1.1**（2026-10-05）：**修复核验回执 7 处收口**（同审查者复查）——§1.2「75 线」残留 · §1.3「零改动」残留 · §4.2-3 握手 Redis 故障语义定案（**fail-open**，与既有 session 查询 fail-closed 显式区分）· §5.1 子集路径**适用面限定 `alive ≥ 3`** + 子集=1 语义 · §5.2 `throttled` 行/自动解除/回迁（同轮一次定夺，修「续期 vs 删旗」二义）· §5.3 定义行计数粒度 · §8 拒绝面措辞（权威信号=断开）。
- **v1.1.2**（2026-10-05）：**规格 r1 的三项订正回填**（规格评审发现设计文本须订正处）——① 到点者**先并入正常抽取**、「立即兜底」措辞作废（D1/§5.1）· ② 子集路径补 **|S|=3 ⇒ 直接成组** 分支（§5.1）· ③ dismissed 涨分复活的落点补全（reasons `revived` 元素 + `risk_actions(reopen,'system')`；§3.1 动作枚举 +reopen、§5.2 表行）。**设计仍为冻结态（订正不改变其余语义）**。
- **v1.1.3**（2026-10-05）：**规格核验的设计侧文本收口两处**——D1/§5.1 失败记账拆分（谓词拒绝 = 写记忆 + 两端 attempts+1 + INCR；记忆拒绝 = 仅两端 attempts+1；「参与抽选未成组每人」旧口径作废）· §3.1 `reasons` 注释 +`revived`。**设计仍为冻结态**。
- **v1.1.4**（2026-10-05）：**波 1 评审语义回填**——D1 补「孤儿票（无 meta）前置静默清出」口径（到点出口改写的连带职责补回；F2/F3 用例与 F4 迁移本体用例随实现修复，见台账）。**设计仍为冻结态**。
- **v1.1.5**（2026-10-05）：**波 2 裁决回填**——§5.4 F3（「断线即出局」口径：不打断=存量连接与对局自然推进、无进行中局豁免）。**设计仍为冻结态**。
- **v1.1.6**（2026-10-05）：**波 2 核验回填**——§5.4 存量令牌窗口与 R8 的「全断」措辞订正（新对局入口全拦 / 存量对局自然推进 / 断线即出局）。**设计仍为冻结态**。
- **v1.1.7**（2026-10-05）：**opus 终审回填**——§5.2 `open` 行护 manual 旗（终审 F1：先读旗现值；manual ⇒ 仅迁条目、旗与 handled_* 不动、零审计；决策读=失败照抛）。**设计仍为冻结态**。
- **v1.1.8**（2026-10-05）：**终审核验回填 3 处**——§5.2 散文行与表行对齐（F1 同口径）· §5.5 「每次迁移=一行」补 KEEP_HANDLER 零审计例外 · §7 旗读三类定稿。**设计仍为冻结态**。
