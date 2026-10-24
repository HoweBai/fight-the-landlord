# 风控片：规格层 v1.1.3（冻结）

> **承接**：设计 v1.1.3（`docs/superpowers/specs/2026-10-05-risk-control-design.md`，`0ba8d16`；设计 r1 14 条 + 核验 7 处 + 规格 r1 三项回填全收口）。本文 = 形式化层（契约/判据/矩阵写死）。
> **作者**：协调者（opus）；**状态**：**v1.1.3 —— 规格冻结**（r1 17 条 + 核验 6 处 + 计划 r1 回填 3 处 + 核验 3 处）。
> **K1–K5 承接口径**：K1 申诉不做 · K2 全套含限流档 · K3 deviceId 落库+管理员可见原文 · K4 全量计入 · K5 阈值照搬+配置化——逐条见设计 §0/§D6/§D8/§5.2。

---

## 0. 承接与订正

### 0.1 上游与版本

- **范围真源**：`docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md:42-51`；参考设计 `docs/appendix/platform-roadmap.md:140-161`（缺陷对账见设计 §1.4）。
- **规格基线**：`docs/design.md` §5.4（限流）/ §8.2-8.5（匹配与谓词）/ §10.1（Redis 键表）/ §7.5（配置键表）。
- **事实基线**：`.superpowers/sdd/2026-10-05-risk-control/recon-notes.md`（四路侦察；§E 低置信项已在本文 §0.3 逐条裁定）。

### 0.2 K1–K5 承接（逐条对位）

| 裁决 | 本规格落点 |
|---|---|
| K1 申诉不做 | §2.7 封禁解除=人工；§2.11 文案；§8 明确不做 |
| K2 全套含限流档 | §2.6 限流档两执行点；§2.5 自动限流状态机；§2.7 封禁 |
| K3 deviceId 落库+管理员可见原文 | §2.2 `user_devices` 原文列；§2.8 详情返回原文；玩家面 §2.1 禁键 |
| K4 全量计入 | §2.5 统计口径（无机器人排除项；practice 排除——设计登记项） |
| K5 照搬+配置化 | §2.1 八键（0.8/100/3 种子）；§2.5 判定式 |

### 0.3 ⚙️ 规格级裁定（起草期就地定死；来源 = 设计 R14/低置信项 + 本次实读）

| # | 事项 | 裁定（实读依据） |
|---|---|---|
| ⚙️1 | 迁移号 | user-service 三表 = **`1790000000000-RiskControl.ts`**（现有最大 `1789400000000`）；config-service 种子 = **`1790000001000-RiskConfigSeed.ts`**（现有最大 `1789900000000`） |
| ⚙️2 | `attempts` 现义与增点 | 实读：`incrementAttempts`（`match.service.ts:691-696`）仅在**补机器人/开局失败**路径调用（:672）；注释 :543「只在补机器人失败时累加」。本片新增第二增点（成组失败），两处合计每人每轮至多 +1 |
| ⚙️3 | 清理任务「多实例安全」机制 | 实读：**无锁自重排**（`records-cleanup.service.ts:104-106/:121-124`），幂等批删天然容忍多实例。风险扫描**不照抄**：加 Redis 锁（`risk:scan:lock`，SET NX EX 600），拿不到 ⇒ 跳过本轮；upsert 再走**锁定读**（⚠️5）为第二防线 |
| ⚙️4 | `readMeta` 对新增字段的态度 | 实读：只读已知字段（`match.service.ts:196-220`）⇒ `match:meta` 加 `ip`/`deviceId` 无兼容问题；读取侧各加两行解析（缺 = 不写） |
| ⚙️5 | 令牌 TTL（封禁窗口） | 实读：access **2h** / refresh **7d**（`token.service.ts:9-10`）；refresh 轮换不查库（`:98-113`）⇒ 封禁窗口登记为：**新对局入口即时全断（②③④ 读旗）；存量连接的对局自然推进（断线即出局——§2.7-4）**，HTTP 只读面 ≤2h（续刷可至 7d）——接受登记（R8 措辞订正，v1.1.6） |
| ⚙️6 | 调色板/术语 | 本片无玩家可见新界面（K1）；管理页沿用既有视觉 |
| ⚙️7 | 扫描锁与 upsert 的相对位置 | 锁在整轮外层（拿到锁才做统计与写）；upsert 内层事务（见 ⚙️10） |
| ⚙️8 | 谓词配置读取面 | room-service 已有 `config/config-cache.service.ts`（四消费服务同构先例）；增 2 个 getter，缺省 `false`；**每轮扫描前读一次**（热生效 ≤60s 安全网既有） |
| ⚙️9 | 谓词开关生效粒度 | 全局（不分模式/底分）；好友房与手动房不经过匹配扫描器 ⇒ 结构性豁免（设计 §1.2 已明说） |
| ⚙️10 | 队列 upsert 事务写法 | `SELECT id,status,score,handled_by,handled_at … WHERE user_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE`——**取该用户最新一行（任意 status）**（F1 修：只取 open/throttled 会把 dismissed 抑制与 banned 跳过整条绕过）；无行 ⇒ INSERT；同族先例 = ③ 最后超管保护锁定读；跨实例由 ⚙️3 锁兜底、锁定读间隙锁为第二防线 |
| ⚙️11 | 设备 upsert SQL | `INSERT … ON DUPLICATE KEY UPDATE last_seen_at = IF(last_seen_at < NOW(3) - INTERVAL 1 HOUR, NOW(3), last_seen_at)`（幂等 + 1h 节流；`uk(user_id,device_id)`） |
| ⚙️12 | 统计窗口 | 全量（K4）**由记录保留期天然约束**（365d 清理）；不另设窗口键 |
| ⚙️13 | `risk.hit` 计数读法 | 键形状 `risk:hit:{userId}:{predicate}`，详情页用两个已知 predicate 名 MGET；无 SCAN |
| ⚙️14 | 到点者兜底的分组 | 到点者集合先按谓词**贪心成组**（组 ≤3 人，组内两两允许）→ 各房补机器人；门禁（`round.can`）一轮至多问一次（沿用 `??=` 纪律）；不能给 ⇒ 该组 12007 |
| ⚙️15 | `risk.banned` 旗 TTL | 90 天；每个扫描轮对 `status='banned'` 用户**写旗前复核最新 status**（设计 r1-F14）后幂等补写 |
| ⚙️16 | 客户端 deviceId 生成 | `crypto.randomUUID()`（`net/socket.ts:262-266` 同款回落 `dev-<base36>`）；存储键 `ftl.deviceId`（`storage.ts` KEYS 家族）；**不新增依赖** |
| ⚙️17 | slice-19 G12 针脚 | 追加风控端点串（`/api/admin/risk/` 三串）——一行级，纳入本片 |
| ⚙️18 | 告警表达式 | §2.12 逐字；`promtool check rules` 语法闸；规则名加入 slice-16 `EXPECTED_RULES`（16→18） |
| ⚙️19 | 管理动作 → 状态迁移（写死） | `dismiss`：open⇒dismissed；`throttle`：open⇒throttled；`unthrottle`：**源态校验按旗不看条目**——`risk:limit` 在 ⇒ 允许（删旗 + 审计；条目为 throttled ⇒ 顺带⇒dismissed；条目已 dismissed/banned/无 ⇒ 仅删旗——F6：清 ban→unban 后的孤儿旗）；`ban`：最新条目（任意态）⇒banned（无条目亦可执行，仅写 users.status+旗+审计）——**旗写 post-commit（F2 回填：事务外、失败 warn 不回滚、漏旗由扫描自愈 ≤1h 收敛）**；`unban`：banned⇒dismissed（**源态放宽 = `status='banned'` 或旗在**——孤儿旗清旗+审计+200，F2 回填）。非法源态 ⇒ 409（文案指明合法动作）。**reviewId 陈旧断言仅限条目态动作（dismiss/throttle/unthrottle；F6 回填）；404（用户不存在）先于其余校验** |
| ⚙️20 | 自动动作用户是否需条目 | 自动限流**只对已有 `open` 条目**发生（无条目 ⇒ 只统计与命中，不置旗） |
| ⚙️21 | `risk.deviceReport` 失败面 | 不重试、不抛、warn 日志一行（room 侧）；无新指标（报告计数仅日志） |
| ⚙️22 | 设计 v1.1.1 三项订正（规格 r1 回填；设计 v1.1.2 已同步） | ① 兜底顺位 =「正常抽取先行」（旧稿「立即兜底」作废）· ② 子集路径 `|S|=3 ⇒ 直接成组` · ③ dismissed 涨分复活 ⇒ reasons `revived` + `risk_actions(reopen,'system')` |
| ⚙️23 | 洗牌保序 | 洗牌 `alive` **的副本**；原序数组保留（`oldest`/「最长等待者」判定依赖 `match.service.ts:569` 原序） |
| ⚙️24 | 扫描锁释放 | 轮末 **compare-and-delete**（GET 值 == 本实例 id 才 DEL；EX 600 只是持有者崩溃兜底，规格 r1-F14） |

---

## 1. 改动面一览

### 1.1 新增文件

- **room-service**：`src/match/predicates.ts`（类型 + 两谓词 + `canFormTable` + 注册表）；`src/gateway/risk.client.ts`；`test/predicates.test.ts`。
- **user-service**：`src/risk/device-report.rpc.controller.ts` · `src/risk/devices.service.ts` · `src/risk/scan.service.ts` · `src/risk/reviews.service.ts` · `src/risk/admin-risk.controller.ts` · `src/risk/devices-cleanup.service.ts` · `src/risk/risk.metrics.ts`；`src/migrations/1790000000000-RiskControl.ts`；`test/risk-*.test.ts`（设备/扫描/动作/清理 四件）。
- **config-service**：`src/migrations/1790000001000-RiskConfigSeed.ts`。
- **conformance**：`src/slices/slice-20-risk-control.ts`。
- **deploy**：`deploy/monitoring/grafana/dashboards/06-risk.json`。
- **client**：无新文件（三处修改）。

### 1.2 修改文件（按包）

- **protocol**：`config.ts`（+8 键 + 解析分支）· `validate.ts`（room.match deviceId 校验；`FORBIDDEN_OUTBOUND_KEYS` +`deviceId`）· `messages.ts`（room.match payload 类型）· `rpc.ts`（`RPC_PATTERNS.riskDeviceReport`）· `config.test.ts` / `messages.test.ts`（计数与 pattern 清单）。
- **room-service**：`match/match.service.ts`（选择/谓词/失败记忆/到点出口/attempts/指标）· `gateway/ws.gateway.ts`（握手读 `auth.clientIp`）· `gateway/message.router.ts`（meta 写 ip/deviceId；封禁/限流读点；WS 档按 userId）· `metrics/room.metrics.ts`（+3）· `app.module.ts`（若 risk.client 需注入）· 三件套闸文件（见 §4）。
- **user-service**：`app.module.ts`（controllers/providers 注册）· `config/config-cache.service.ts`（+6 getter）· `auth` 无改（11003 既有）· 单测族。
- **api-gateway**：`auth/admin-policy.ts`（+4 条）· `gateway/gateway.controller.ts`（4 路由 + query 白名单）· `gateway/proxy.gateway.ts`（auth +clientIp；握手封禁读旗）· `http/http-rate-limit.middleware.ts`（限流档 peek）· 单测族。
- **admin**：`index.html`（风控视图壳 + 审计第五页签）· `app.js`（VIEWS + 视图逻辑 + 页签逻辑 + 字面量）· `style.css`（如需）。
- **client**：`net/storage.ts`（KEYS +`ftl.deviceId`）· `pages/game/game.vue:142`（发送带 deviceId）· `net/copy.ts`（11003 文案）。
- **deploy**：`prometheus/rules/ftl-alerts.yml`（+2 规则）。
- **conformance**：`src/run.ts`（CASES 真源 `:44`；**v1.1.2 订正**：旧文误指 `src/index.ts`）· `baselines.json`（回填）。
- **docker-compose.yml**：user-service 两行测试注入 env（`RISK_SCAN_INTERVAL_MS` / `RISK_DEVICES_CLEANUP_INTERVAL_MS`，空缺省；slice-15 `:177` 先例；**v1.1.2 登记**——设计 §6「compose 零改动」的例外，随偏离台账记）。
- **docs**：`design.md` 四处（§8.3/§8.4 标记、§10.1 行、§7.5 键表、:142 计数）· `client-protocol.md` · `post-mvp-roadmap.md` · `deviation-ledger.md` · 台账。

### 1.3 明确不在改动面（有意）

五维限流既有判定结构 / 记录两表 schema / 匹配候选检索（O(n) 维持）/ `RoomMeta`（7 字段不动）/ 好友房与手动房路径 / compose 拓扑与 Dockerfile / edge Caddyfile / 客户端其它页面 / `11003` 登录拦截逻辑 / 16xxx 错误码段。

---

## 2. 新契约（写死）

### 2.1 协议（packages/protocol）

1. **`room.match` payload**（`messages.ts:41`）：`{ mode: 'random'|'practice'|'gold'; baseScore: number; deviceId?: string }`。
   - 校验（`validate.ts` room.match 分支，`baseScore` 断言之后）：`deviceId` 缺省 ⇒ 过；存在 ⇒ `typeof string && length 8..64 && /^[A-Za-z0-9._-]+$/`，否则 `ProtocolError`（⇒ 400 `10001`）。
2. **出站禁键**（`validate.ts:37-42`）：`FORBIDDEN_OUTBOUND_KEYS` 追加 `'deviceId'`（注释一行：K3 服务器可见/玩家面永不出站）。
3. **配置键 +8**（追加至 `CONFIG_KEYS` 尾部，第 18–25 键；每键 JSDoc）：

| # | 键 | 解析（`parseConfigValue` 分支） | 种子 |
|---|---|---|---|
| 18 | `risk.predicate.sameDevice` | 严格 boolean | `false` |
| 19 | `risk.predicate.sameIp` | 严格 boolean | `false` |
| 20 | `risk.winRateThreshold` | number，`0.5 ≤ n ≤ 1.0`，≤2 位小数 | `0.8` |
| 21 | `risk.minGames` | int，`1 ≤ n ≤ 100000` | `100` |
| 22 | `risk.deviceLimit` | int，`2 ≤ n ≤ 100` | `3` |
| 23 | `risk.deviceWindowDays` | int，`1 ≤ n ≤ 365` | `30` |
| 24 | `risk.autoThrottle` | 严格 boolean | `true` |
| 25 | `risk.deviceRetentionDays` | int，`1 ≤ n ≤ 3650` | `365` |

   - `config.test.ts` 计数断言 **17→25**，键清单全等更新；`CLIENT_CONFIG_KEYS` **不动**。
4. **RPC 模式**：`RPC_PATTERNS.riskDeviceReport = 'risk.deviceReport'`（`rpc.ts`）；请求 `{ userId: string; deviceId: string; meta?: RpcMeta }`；响应 `{ ok: true } | { ok: false; code: string }`（`BAD_PARAM` 命名沿用 record.write 先例）。

### 2.2 三新表最终 DDL（迁移 `packages/user-service/src/migrations/1790000000000-RiskControl.ts`；共库 `fight_the_landlord`）

```sql
CREATE TABLE IF NOT EXISTS `user_devices` (
  `id`            bigint       NOT NULL AUTO_INCREMENT,
  `user_id`       varchar(64)  NOT NULL,
  `device_id`     varchar(64)  NOT NULL,     -- K3：原文入库；玩家面永不出站
  `first_seen_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at`  datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_device` (`user_id`,`device_id`),
  KEY `idx_device` (`device_id`),
  KEY `idx_last_seen` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `risk_reviews` (
  `id`         bigint       NOT NULL AUTO_INCREMENT,
  `user_id`    varchar(64)  NOT NULL,
  `score`      int          NOT NULL,              -- 命中项数×25（∈{25,50}）
  `reasons`    json         NOT NULL,              -- [{check:'winRate'|'devices'|'revived', detail:{...}}]
  `status`     varchar(12)  NOT NULL DEFAULT 'open', -- open|dismissed|throttled|banned
  `created_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `handled_by` varchar(32)  NULL,                  -- 管理员用户名 | 'system'
  `handled_at` datetime(3)  NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_id` (`status`,`id`),
  KEY `idx_user_id` (`user_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `risk_actions` (
  `id`         bigint       NOT NULL AUTO_INCREMENT,
  `user_id`    varchar(64)  NOT NULL,
  `action`     varchar(16)  NOT NULL,   -- auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen
  `actor`      varchar(32)  NOT NULL,   -- 管理员用户名 | 'system'
  `reason`     varchar(200) NULL,
  `review_id`  bigint       NULL,
  `detail`     json         NULL,
  `created_at` datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user_created` (`user_id`,`id`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**种子迁移**（`config-service/1790000001000-RiskConfigSeed.ts`）：8 键 `INSERT ... ('risk.…', <json 值>, 1, NOW(3), 'seed')`（照 `1789500000000-RecordRetention.ts` 先例）。

### 2.3 Redis 键（逐字）

| 键 | 类型 | 写点 | TTL | 语义 |
|---|---|---|---|---|
| `match:meta:{playerId}` | Hash | 既有 + 入队时新增 `ip` / `deviceId` 两字段 | 300s（既有） | 缺失 = 不写该字段（fail-open） |
| `match:rejected:{a}:{b}` | String（值=失败时刻 ms） | 匹配扫描器（成组失败的对，字典序拼键） | **5s** | 抽取时排除 |
| `risk:limit:{userId}` | String（JSON `{"source":"auto"\|"manual","at":<ms>}`） | 扫描（auto）/ 管理动作（manual） | auto=7d（每轮续期）；manual=无 TTL（解除才删） | 限流档旗 |
| `risk:banned:{userId}` | String `'1'` | 封禁动作；扫描自愈（复核 status 后） | 90d | 封禁旗；解封删除 |
| `risk:hit:{userId}:{predicate}` | String（INCR） | room 谓词拒绝（该对**两端各 +1**） | 7d（每次 INCR 后 EXPIRE） | 命中计数（详情面读） |
| `risk:scan:lock` | String（实例 id） | 扫描任务 | 600s（NX EX） | 单轮单实例 |

### 2.4 谓词与选择形态（room-service；`match.service.ts` + `match/predicates.ts`）

1. **类型**：语义形 = `(a: MatchTicket, b: MatchTicket) => boolean`（true = 允许同局）；**实现形（v1.1.2 订正）= 接口 `{ name: 'sameIp'|'sameDevice'; allows: (a, b) => boolean }`**（`name` 供指标标签；函数类型无法承载标签）；`canFormTable(players, enabled)` = 对全部两两组合执行**启用**谓词（纯函数，无 IO）。
2. **两谓词**（`predicates.ts`）：`sameDevice` / `sameIp`；启停来自 `config-cache`（⚙️8）；缺数据 fail-open。
3. **选择算法**（替换 `alive.slice(0,3)`，:602）：
   - **前置筛选（v1.1.4 回填，波 1 F1）**：`queued → alive` 循环对每张票读一次 `readMeta`；`null`（孤儿票）⇒ 循环后经 `cancelQueue` **静默清出**（无 12007——所有者已不存在）+ debug 日志；有 meta 的到点者维持兜底语义（断线者经 `match:pending` 可重连补回）。顺带收编旧「≥30s 才读 meta」优化（ticket 已在手）。**封禁票撤出（波 2 F4 / v1.1.6 回填）**：对 alive 全员 `EXISTS risk:banned:{playerId}`（pipeline 批读；catch ⇒ 按无旗）——命中 ⇒ `cancelQueue` 静默清出（debug「banned evicted」；无 12007）；**封禁者永不进入选择/兜底**；④ join 拦为第二防线。
   - 洗牌 `alive` **的副本**（⚙️23：原序数组保序——`oldest`/「最长等待者」判定依赖它）；RNG 注入（测试钉序列）；
   - 依序贪心：候选 c 与已选全员「两两允许」（不在 `match:rejected` ∩ 谓词全过）才入选；凑满 3 ⇒ 组；
   - 凑不满 ⇒ 转**子集/兜底路径**（⚙️14 限定 `alive ≥ 3`；`< 3` 走越窗主路径 §2.4-7）：对**最长等待者**（原序最久者）取贪心最大合法子集 S：**|S| = 3 ⇒ 直接成三人组**（⚙️22-②；无需机器人/窗口）；|S| = 2 且其最久者 ≥30s ⇒ S + 1 机器人；|S| = 1 且 ≥30s ⇒ 该人 + 2 机器人；窗口未到 ⇒ 本轮不动；门禁 `round.can` 复用；
   - **失败记账（F5 定案）**：**谓词拒绝** ⇒ 写 `match:rejected`（TTL 5s）+ 两端 `attempts+1` + 两端 `risk:hit:{predicate}` INCR；**记忆拒绝** ⇒ 仅两端 `attempts+1`（不重写记忆、不 INCR）；「洗牌未轮到」不计。
4. **到点出口改写**（`546-566`）：到点者（`waited ≥ 60s` 或 `≥30s 且 attempts ≥ 10`）**不再直走 `failMatch`**。**顺位（写死；= 对设计 v1.1.1「立即兜底」的订正 ⚙️22-①，设计 v1.1.2 已同步留痕）**：正常抽取先行（到点者仍可被选入合法组——更优结局）；本轮结束仍未被任何组选走的到点者 ⇒ 兜底集合（⚙️14 贪心成组 + 机器人）；门禁不能给 ⇒ `failMatch`（12007，既有语义/幂等面不动）。既有 `cancelIfStillWaiting` + `incrementAttempts` 的**开局失败路径（:655-674）不动**。
5. **指标写点**：每轮桶内 `alive ≥ 3` ⇒ `match_selection_rounds_total.inc()`；每对谓词拒绝 ⇒ `match_predicate_rejections_total{predicate}.inc()`（两谓词分别计；记忆拒绝不计数）；≥3 人且**本轮贪心未成组**（可观测定义；F9 修——不做组合搜索判定）⇒ `match_no_legal_group_total.inc()`。
6. **谓词判定范围**：仅「将同桌的真人子集」；机器人透明（§8.5）。
7. **`<3 人` 越窗主路径（F15 契约化）**：既有 :591-600 流程不变，但**补机器前先对真人子集做两两判定**；不通过 ⇒ **拆组**——拆出者按「子集 = 1」同规处理（各自等待 ≥30s 后「本人 + 2 机器人」；窗口**自各人 enteredAt 起算**；门禁 `round.can` 同规）。

### 2.5 检测扫描（user-service；`scan.service.ts`）

1. **节奏**：间隔 3600s（env `RISK_SCAN_INTERVAL_MS` 只改间隔，测试面）；启动 30s 首轮；自重排 + 关停闸（照清理任务先例）；每轮先抢 `risk:scan:lock`（⚙️3，`SET NX EX 600`），拿不到 ⇒ 记 debug 并跳过；轮末 **compare-and-delete**（⚙️24：GET 值 == 本实例 id 才 DEL——EX 只是持有者崩溃兜底）。
2. **统计（两句 SQL + 内存合并）**：
   - 胜率（**SQL1**）：`SELECT p.user_id, COUNT(*) AS games, SUM(p.won) AS wins FROM game_record_players p JOIN game_records r ON r.id=p.record_id JOIN users u ON u.id = p.user_id AND u.status='active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL GROUP BY p.user_id`（用户 join 写法照 `record.rpc.controller.ts:235-244` 昵称快照先例——F7 订正先例指认）；`winRate = wins/games`；`hit1 = games > risk.minGames && winRate > risk.winRateThreshold`。
   - 设备数（**SQL2**）：`SELECT d.user_id, COUNT(DISTINCT d.device_id) AS devices FROM user_devices d JOIN users u ON u.id = d.user_id AND u.status='active' WHERE d.last_seen_at >= ? GROUP BY d.user_id`（`? = now − risk.deviceWindowDays` 天；**F1 修：同样带 users 过滤**，防 banned 用户经此单边进入轮次）；`hit2 = devices > risk.deviceLimit`。
   - 合并：按 user_id 并集（SQL2 有而 SQL1 无 ⇒ games=0、hit1=false）。
   - `score = (hit1?25:0) + (hit2?25:0)`；score=0 ⇒ 本用户本轮结束（**但**仍参与 ⚙️15 自愈与 auto 旗回落判定）。
3. **upsert（⚙️10 事务 + 锁定读；分支对象 = ⚙️10 取回的「最新一行」，任意 status；状态机 = 设计 §5.2 表）**：**（波 2 F1 补注：全部分支仅在本轮 `score ≥ 25` 时生效——score<25 对各态零写（含 `open`；设计 §5.2 表头的门）**。**无行**：score≥25 ⇒ INSERT open；`open`：UPDATE score/reasons + （score≥50 且 `risk.autoThrottle` ⇒ **先读旗现值**：无旗/auto ⇒ 置/续旗 auto + UPDATE status='throttled' + handled_by='system' + `risk_actions(auto_throttle,'system')`；**旗=manual ⇒ 仅 UPDATE 条目迁 throttled（`handled_*` 保持不动）、旗不动、零审计**——终审 F1 修〔KEEP_HANDLER〕；**该旗读属「决策读」：失败照抛**（回滚 + 下轮收敛——fail-open 会复现该缺陷，见 §2.6-5））；`throttled`(auto)：score≥50 ⇒ 旗续期；score<50 ⇒ 删旗 + `risk_actions(unthrottle,'system')` + UPDATE（score≥25 ⇒ open；<25 ⇒ dismissed + reason「指标回落，自动解除」）；`throttled`(manual)：仅 UPDATE score/reasons；`dismissed`：score > 处置时 score ⇒ INSERT open（reasons 附 `revived` 元素 `{check:'revived', detail:{prevReviewId, prevScore, handledBy, handledAt}}` + `risk_actions(reopen,'system')`——F17/⚙️22-③）；`banned`（最新行）：跳过产出（F1：判定在分支层；SQL1/SQL2 的 users 过滤为双保险）。
4. **自愈（F7 补钉）**：**SQL3** = `SELECT id FROM users WHERE status='banned'`（名单）；逐人**复核读** `SELECT status FROM users WHERE id=?`（写旗前复核 ⇒ 仍 banned 才写，防复活竞态〔设计 r1-F14〕）⇒ `SET risk:banned:{id} '1' EX 7776000`（幂等）。
5. **指标**：`risk_scan_runs_total{result='ok'|'fail'}` · 成功轮设 `risk_scan_last_success_timestamp_seconds` · 轮末设 `risk_reviews_open`（open 计数）。
6. **模式口径**：`random|gold`；practice 不计（设计登记 R13）。

### 2.6 限流档（常量 + 两执行点）

1. **常量**：`THROTTLED_RATE_LIMIT = { max: 3, windowMs: 1000 }`（参考 `setLimit(userId,3,1000)`；规格值）。
2. **网关（HTTP 用户维）**：`http-rate-limit.middleware.ts` 在既有用户维判定处先读 `EXISTS risk:limit:{userId}`——**旗读单独 try/catch：失败 ⇒ 按无旗（走 20/5s）+ error 日志**（F8：不吞进既有 fail-closed 管道）；命中 ⇒ 以 `THROTTLED_RATE_LIMIT` 对同一键 `ratelimit:http:{userId}` 滑窗（超限 429 `10006`，信封不变）；正常限流链自身的 Redis 故障语义**不变**（503/10007 fail-closed）。
3. **room（WS 消息维）**：`message.router.ts` 判定处先读旗（ALS 有 `userId`；**旗读单独 catch ⇒ 按无旗**，F8 同规）；命中 ⇒ 以 `THROTTLED_RATE_LIMIT` 对**`ratelimit:ws-risk:{userId}`**（按 userId 聚合，替代按 socketId）判定（超限 ack `10006`）。
4. **阈值参数化**：`hitHttpLimit`/`isRateLimited` 扩参（`limit`/`windowMs` 可选）或加档位变体——**实现二选一，签名不得复制出第二套判定逻辑**。
5. **设置/解除**：§2.5 自动 + 管理动作（⚙️19）；人工旗不被自动逻辑清除；解除删旗。**旗读三类（波 2 F5 裁决 + 终审 F1 订正）**：**检测位读**（热路径执法：HTTP/WS 限流档、room 封禁读点、网关握手）= 单独 catch ⇒ 按无旗（R11）；**校验位读**（管理动作前置校验，如 unthrottle 的「旗在否」）= **fail-closed**（Redis 故障 ⇒ 显式报错，不谎报 409）；**决策读**（自动逻辑武装/解除前的现值判读，如 open 分支）= **失败照抛**（回滚 + 下轮收敛——fail-open 会复现缺陷本身）。

### 2.7 封禁

1. **写（管理动作事务）**：`users.status='banned'` + `SET risk:banned:{userId} EX 7776000`（90d）+ `risk_actions(ban, actor, reason)`。
2. **四读点**（统一 `assertNotBanned({userId})`，旗读 fail-open + error 日志，R11）：
   - ① 登录：既有 `auth.service.ts:84`（11003/403，不动）；
   - ② 网关 WS 握手：`verifyClient` 流程内 `EXISTS risk:banned`（在 session 校验**通过后**执行）；命中 ⇒ `rejectHandshake`（`disconnect(true)` + 尽力 `system.error` `11003`）；
   - ③ room `room.match`：入队前读旗 ⇒ ack `11003`（借既有码）；
   - ④ room `room.join`：读旗 ⇒ ack `11003`。
3. **解封**：`status='active'`（事务内）+ **提交后 `DEL` 旗**（F2 回填）+ `risk_actions(unban,…)`；**源态 = `status='banned'` **或** 旗在**（孤儿旗 ⇒ 清旗 + detail `orphanFlagCleanup` + 200；`active` 且无旗 ⇒ 409 不变）；即时全通。
4. **不打断**：进行中对局与存量连接不踢（设计登记）——**口径（波 2 F3 裁决）：不打断 = 存量连接与其对局自然推进；中途断线者**不**获「进行中局豁免」——封禁者断线即出局（对局由其座位超时自然推进至结算）**；存量令牌窗口 = ⚙️5。

### 2.8 user-service 管理端点（经网关；授权在 §2.9）

| 端点 | 契约 |
|---|---|
| `GET /api/admin/risk/reviews` | `?status&limit(≤100)&cursor`（keyset `id DESC`）→ `{items:[{id,userId,score,reasons,status,createdAt,updatedAt,handledBy,handledAt}], nextCursor}` |
| `GET /api/admin/risk/users/:userId` | `{userId, accountStatus:'active'\|'banned', bannedFlagPresent:boolean, limitSource:null\|'auto'\|'manual', stats:{games,wins,winRate,deviceCount}, devices:[{deviceId,firstSeenAt,lastSeenAt,others:[{userId,accountStatus}]≤20}], entries:[最近 10 条 {id,score,status,handledBy,handledAt,createdAt}], hits:{sameIp,sameDevice}}`（F13：`accountStatus`=users.status、`limitSource`=旗来源，动作合法性判断依赖它；**`bannedFlagPresent`=封禁旗存在性——终审 F2 加，展示位读失败 ⇒ false + warn，孤儿旗态由此在 UI 可见/可解**）；404 借 `11004` |
| `POST /api/admin/risk/actions` | body `{userId, action, reviewId?, reason}`（**管理面合法集 = 5 值**：dismiss\|throttle\|unthrottle\|ban\|unban——`auto_throttle\|reopen` 为系统专用，管理面提交 ⇒ 400 `10001`；`reason` 1..200 必填；人工动作 `reviewId` 可选）；非法 ⇒ 400 `10001`；非法源态 ⇒ 409；响应 `{ok:true}` |
| `GET /api/admin/risk/actions(.csv)` | 过滤 `userId&action&actor&from&to` + keyset；CSV 契约照既有（BOM/消毒/文件名 `risk-actions-<ts>.csv`） |
| `risk.deviceReport`（RPC） | ⚙️21；幂等 upsert（⚙️11）；`user_id` 不存在 ⇒ `{ok:false, code:'BAD_PARAM'}`（不抛） |
| 设备清理 | `devices-cleanup.service.ts`：batch `DELETE … WHERE last_seen_at < now − risk.deviceRetentionDays LIMIT 1000`（循环至 0 行）；env `RISK_DEVICES_CLEANUP_INTERVAL_MS`；自重排 + 关停闸 |

### 2.9 api-gateway

1. **WS auth 注入**：`proxy.gateway.ts` 下游连接 auth 增 `clientIp`（取连接槽位对象 `{ip}`；`'unknown'`/缺失 ⇒ 不注入）；下游 room 侧校验（string ≤64 且 ≠'unknown'）后写 `socket.data.clientIp`。
2. **握手封禁读旗**：见 §2.7-②。
3. **policy（`admin-policy.ts`，插在 P7 与 P8 之间；顺序敏感）**：

```
P-r1: GET  /api/admin/risk/reviews          ⇒ super_admin | operator
P-r2: GET  /api/admin/risk/users/:userId    ⇒ super_admin | operator（前缀 /api/admin/risk/users/）
P-r3: GET  /api/admin/risk/actions(.csv)    ⇒ super_admin | operator（精确两条：/actions、/actions.csv）
P-r4: POST /api/admin/risk/actions          ⇒ super_admin | operator
```

   - 写死在 P8 之前（否则 GET 落 P8 任意角色）；单测必须含 viewer/finance 对四端点 403（证未落 P8）。
4. **路由登记**：`gateway.controller.ts` 四端点（含 `.csv` 变体）逐条登记 + query 白名单（`status/limit/cursor/userId/action/actor/from/to`）+ 路径参数编码（R75 先例）。
5. **限流档 peek**：见 §2.6-2。

### 2.10 管理页（admin/）

- VIEWS 元表新增 `risk`（roles：super_admin/operator）；顶栏按钮 + 视图壳（队列表格 + 过滤（status）+ keyset 翻页 + 行内「详情/动作」；详情面板：stats/设备原文（含关联账号）/命中计数/历史条目；动作条：五按钮 + reason 输入（必填前端 + 服务端双校验））。
- 审计视图第五页签「风控处置」（读 `risk/actions` + CSV）。
- 既有字面量同步：「四页签」注释/文案四处（`app.js:30/:225/:1193/:1753`、`index.html:253`）→ 五页签。
- 纪律：只按 status 分流；`textContent` 禁 innerHTML（deviceId 同纪律）。

### 2.11 客户端（apps/client）

- `net/storage.ts`：KEYS 家族 +`DEVICE_ID: 'ftl.deviceId'` + 读写工具（照 session 先例）；**deviceId 不入 `clearSession`**——跨登出/换号持久（设备指纹语义；F12）。
- 生成：`crypto.randomUUID()`（回落 `dev-<base36>`，⚙️16）；首次读空即生成并持久化。
- `game.vue:142`：`client.send('room.match', { mode, baseScore, deviceId })`。
- `net/copy.ts`：`USER_BANNED(11003)` 文案追加「如有异议请联系客服」（K1）。

### 2.12 指标 / 告警 / 面板

- **指标 7 条**（写法照 `room.metrics.ts:36-39` 先例；写点文件见括号）：
  - room：`match_predicate_rejections_total{predicate}`（match.service）· `match_selection_rounds_total`（同）· `match_no_legal_group_total`（同）
  - user：`risk_scan_runs_total{result}` · `risk_scan_last_success_timestamp_seconds` · `risk_reviews_open` · `risk_actions_total{action}`（scan/reviews/admin-risk 服务）
- **告警 2 条**（`ftl-alerts.yml`；命名/注解照既有）：
  - `RiskScanStalled`：`time() - risk_scan_last_success_timestamp_seconds > 7200`，`for: 10m`，severity warning，runbook 指向扫描日志与锁键。
  - `MatchPredicateRejectionHigh`：`sum(rate(match_predicate_rejections_total[10m])) / clamp_min(sum(rate(match_selection_rounds_total[10m])), 0.001) > 0.5 and sum(rate(match_selection_rounds_total[10m])) > 0.05`，`for: 10m`，severity warning，runbook = 检查 `risk.predicate.*` 开关与 CGNAT 面板。
- **面板**：`06-risk.json`（uid `ftl-risk`，title `风控 / Risk`）五块：谓词拒绝（by predicate）/ 抽选轮与不成组 / 扫描（runs + last_success）/ 队列水位（open）/ 处置计数。

### 2.13 错误码与 HTTP 映射总表

| 场景 | 载体 | code |
|---|---|---|
| room.match deviceId 非法 | HTTP 400 / WS ack | `10001` |
| 封禁：登录 / 入队 / join | 403 / ack | `11003`（既有；不新造） |
| 封禁：WS 握手 | 断开 + 尽力 system.error | `11003` |
| 限流档超限 | 429 / ack | `10006`（既有） |
| 管理动作参数非法 / 源态非法 | 400 / 409 | `10001` / 文案「当前状态不允许该动作」 |
| 风控端点角色不足 | 403 | 既有管理员信封 |
| risk 详情用户不存在 | 404 | `11004` |
| 旗读失败（限流档/封禁） | 按无旗放行 + error 日志 | （fail-open，R11；**正常限流链自身故障语义不变**——503/10007；**校验位读除外**：管理动作前置校验 fail-closed，§2.6-5/F5） |

---

## 3. 判据总表（C1–C24；载体 = 单测 / conformance `slice-20` / 既有闸 / 手工核销；全部同提交）

| # | 判据 | 载体 |
|---|---|---|
| C1 | `canFormTable` 真值表：两谓词、缺数据 fail-open、机器人透明、记忆排除 | 单测 `predicates.test.ts` |
| C2 | 随机贪心抽取：凑满/凑不满/洗牌未轮到的语义（RNG 注入钉序列）；**洗牌副本/原序保留**；**回队 enteredAt 不变**；**孤儿票前置清出（不建局）** | 单测 `match.service.test.ts` |
| C3 | 失败记账：谓词拒绝 ⇒ 记忆（成对/字典序/TTL 参数）+ 两端 attempts+1 恰一次 + INCR；**记忆拒绝 ⇒ 只 attempts+1（不重写/不 INCR）**；「洗牌未轮到」不计 | 单测 + Redis 断言 |
| C4 | 到点出口：60s/attempts10 ⇒ 兜底成局（不直走 failMatch）；门禁不能给 ⇒ 12007 | 单测 |
| C5 | 子集路径：**\|S\|=3 ⇒ 直接成组**；≥3 人互斥场景 30s 后 \|S\|=2 组 + 机器人；\|S\|=1 单人 + 机器人；窗口未到不动 | 单测 |
| C6 | `<3 人` 越窗路径过谓词（不互斥才同房；互斥拆组） | 单测 |
| C7 | `match:meta` 写 ip/deviceId；读侧兼容（缺字段不炸） | 单测 |
| C8 | `risk.deviceReport` 恰在入队成功后一次 + `metaFromTrace()` 随行 + 失败不抛 | 单测 + 三件套闸 |
| C9 | 封禁/限流读点：入队/join ack 11003；WS 消息档按 userId 3/1s；HTTP 档 3/1s；**旗无 ⇒ 20/5s 原样（负对照）**；旗读失败 ⇒ 按无旗（正常链故障语义不变） | 单测 ×2 服务 |
| C10 | 网关握手：旗在 ⇒ rejectHandshake+11003；旗无 ⇒ 正常；Redis 故障 ⇒ 放行+日志 | 单测 |
| C11 | policy P-r1..r4 逐条正反 + viewer/finance 四端点 403（未落 P8）+ 未登记写 403 | 单测 |
| C12 | clientIp 注入：有则注/auth 形状；`'unknown'` 不注；room 侧非法丢弃；**deviceId 不存在于任何新注入头** | 单测 ×2 |
| C13 | deviceId 校验正反例（缺省过；长度/charset 负例 400） | 单测（protocol） |
| C14 | 出站禁键：含 `deviceId` 的 S→C 载荷被拒 | 单测（protocol） |
| C15 | 配置：25 键全等断言、8 新键解析边界（±）、种子迁移 8 行 | 单测 ×2 服务 |
| C16 | 扫描：命中矩阵（games>minGames 边界）、score、upsert 全行（含 throttled/抑制/涨分复活）、锁定读事务 | 单测 |
| C17 | 自动限流状态机：open⇒throttled 置旗记审（**manual 旗例外：仅迁条目、零旗写零审计**）；≥50 续期不刷审计；<50 解除+回迁+记审；manual 不动；同轮一次定夺 | 单测 |
| C18 | 自愈：写旗前复核 status（解封竞态负例：先名单后解封 ⇒ 不复活） | 单测 |
| C19 | 五动作 × 状态迁移 × 审计行同事务；非法源态 409；reason 必填/越权 | 单测 |
| C20 | 设备 upsert 幂等 + 1h 节流；清理批删（cutoff 现读配置） | 单测 |
| C21 | conformance `slice-20` 全组（§6.2） | conformance |
| C22 | slice-16 同步：规则 18 名集 / 面板 6 块名集 / promtool 18 | 既有切片（改动后） |
| C23 | 三件套 + no-internal-http 闸：新 RPC 边全链核销 | 既有闸 |
| C24 | 文案/字面量：五页签、client-protocol、`app.js` 端点串、11003 文案 | 手工核销 + 静态断言 |

---

## 4. 既有判据同步清单（设计 §9 逐条；实现先全仓 grep 再动）

### 4.1 硬闸

1. `config-service/test/platform-config.service.test.ts:270-277`（`toHaveLength(17)` + 全等 + SEED 17 行）与 `test/helpers/config-probe.ts:29-32` ⇒ 25。
2. `protocol/src/config.test.ts:11-21` 计数 ⇒ 25。
3. `protocol/src/messages.test.ts` pattern 清单 +`riskDeviceReport`；`robot-availability-wiring.gate.test.ts`（接收侧接线）；`meta-on-every-rpc-send.gate.test.ts`（新 send 行）。
4. `room-service/test/no-internal-http.gate.test.ts`：`RPC_USAGE`/`RPC_CLIENTS`/`ROOM_CALL_SITES` 三张清单 + 手写探针正/负两行（只加名字不配负对照 = 无效补丁）。
5. `api-gateway`：`admin-policy` 单测 + 握手 + 限流档 + 路由登记单测。
6. `room-service/test/match.service.test.ts` 全量重写受影响用例（slice(0,3) 断言、attempts 断言、到点出口断言）。
7. `tools/conformance/src/slices/slice-16-monitoring.ts`：`EXPECTED_RULES` 16→18（:89-95）· `16 rules found`（:593）⇒18 · `/api/v1/rules` 恰 16+名集（:649-657）⇒18 · 面板五块名集（:717-722）⇒六块（新标题 `风控 / Risk`）。
8. `admin/app.js` + `index.html` 字面量与结构（§2.10）。
9. slice-19 G12 针脚：追加风控端点串（⚙️17）。
10. `tools/conformance/src/run.ts`（CASES 真源 `:44`；**v1.1.2 订正**）CASES +`slice-20-risk-control`；`baselines.json` 新行（CI 实测回填）。
11. slice-07.4-pipeline：**已核不动**（闭集 = `.github/workflows` 四文件，本片不触及——F16）。
12. **slice-18**：`tools/conformance/src/slices/slice-18-gold-room.ts:855-856` `adminKeys.length === 17` ⇒ **25**（+ 注释 `:8/:818` 措辞同步；F2）。

### 4.2 计数/文案（人工同步，防文档谎报）

- `docs/design.md`：§8.3/§8.4 `[部分实现]` 标记与 R53/R475 注记回填（落地后）；§10.1 `match:rejected` 行（「MVP 不写入」→ 已写入）；§7.5 键表 17→25（含 `:142`「十七键」字样）；`design.md:1492` 11003 行如涉文案。
- `docs/ops/first-deploy.md:963`：「十七键一览」表 ⇒ 25 键；新增「风控谓词开启手顺」节（设计 D4：手顺写进交接**与手册**；F11）。
- `admin/app.js:73/:75` `CONFIG_NOTES`：+8 键中文备注（「17 条对 17 键」文案同步 25）——上片同类同步惯例（F11）。
- `docs/client-protocol.md`：room.match payload +deviceId；11003 文案。
- `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`：P1′ 风控节标完成。
- `deviation-ledger.md`：**N58–N64 七条**（IP 不留存 / 申诉不做 / practice 排除 / 自动封禁不做 / `games > minGames` 边界 / **compose 两行测试注入 env**〔A3 统一口径〕/ **N64 自动解除回迁 `open` 档置 `handled_by=system`**〔T5 裁决「准」新增〕）。
- `scripts/ledger-counts.mjs`。
- 台账 `.superpowers/sdd/2026-10-05-risk-control/`（progress + 评审报告）。

### 4.3 预期不动（复核后登记）

五维限流键与判定（除档位参数化）、记录两表、`RoomMeta`、好友房路径、compose/Dockerfile、edge、客户端其它页。

---

## 5. 验收条目（A1–A8）

| # | 条目 |
|---|---|
| A1 | 单测：五包（protocol / gateway / room / user / config）全绿 |
| A2 | conformance `slice-20-risk-control` 全过 + baselines 回填 |
| A3 | slice-16 同步后全过（规则 18 / 面板 6） |
| A4 | `scripts/browser-e2e.mjs` 先跑（谓词默认关，预期零影响）+ admin 风控视图实拍（队列/详情/动作/审计第五页签） |
| A5 | 玩家面回归：records/mine 键集不漏 deviceId；11003 文案可见 |
| A6 | 六阶段整轮（push 前一次）exit 0 |
| A7 | **CI 权威轮三绿**（ci / images / conformance 全序） |
| A8 | 真栈回归×2：① deviceReport→设备可见全链 ② 封禁→四读点实测（③ 教训：SQL/路径类改动默认要求真栈一条） |

---

## 6. 测试矩阵

### 6.1 单测（用例名级，新增/修改摘列）

- **predicates.test.ts**：同对/异对×两谓词全真值表；缺 deviceId/ip fail-open；机器人不参与；记忆排除与谓词拒绝的区分。
- **match.service.test.ts**（改）：抽取（RNG 注入：凑满/凑不满/未轮到）；C3–C6 全组；到点出口；`cancelIfStillWaiting` 路径不动性（回归）；meta 新字段；deviceReport 调用一次。
- **protocol**：room.match deviceId 校验（7 例）；禁键含 deviceId；键清单 25。
- **api-gateway**：P-r1..r4 正反 + 落 P8 反证；握手封禁三态；限流档（HTTP peek + WS 按 userId 合并）；clientIp 注入。
- **user-service**：device-report（幂等/节流/坏参）；扫描（C16/C17/C18 全组）；actions（C19）；清理（C20）；审计列表/CSV。
- **config-service**：25 键断言 + 8 键解析边界 + 种子。
- **client**：storage deviceId 生成/持久化（如既有前端单测面覆盖）。

### 6.2 conformance `slice-20-risk-control`（断言组）

1. **配置面**：25 键在场 + 8 风险键种子值；改 `risk.winRateThreshold` 非法值 ⇒ 400 不落库。
2. **谓词组**：`sameDevice` 开 ⇒ 两同 deviceId 客户端 + 第三人：同设备二人永不同房（30s 子集路径成局 + 落单兜底）；关 ⇒ 正常三人成局。`sameIp` 同构（同主机天然同 IP）。
3. **数据链**：入队 ⇒ `risk.deviceReport` 落库 ⇒ `GET risk/users/:id` 设备原文可见。
4. **检测面**：调低阈值 + 造数 ⇒ 扫描（env 缩间隔栈）⇒ 队列条目出现 ⇒ dismiss ⇒ 审计行；重扫不复活。
5. **限流档**：手动 throttle ⇒ 高频 HTTP 429（3/1s）⇒ unthrottle 恢复。
6. **封禁面**：ban ⇒ 新登录 403/11003；WS 握手被拒（断开）；unban ⇒ 恢复。
7. **权限面**：viewer/finance 四端点 403；operator 200。
8. **审计面**：`risk/actions` 列表 + CSV（BOM/消毒）。
9. **回归面**：玩家 records/mine 键集不含 deviceId。

### 6.3 门禁

六阶段（本机 push 前一次）· 全序 conformance = CI 权威轮 · promtool check rules · 三件套 + no-internal-http + EXPECTED_FILES。

---

## 7. conformance 登记与基线口径

- `tools/conformance/src/index.ts` 的 `CASES` 追加 `slice-20-risk-control`（按 `--list` 动态枚举，自动入 CI）。
- `baselines.json`：新切片下限 **CI 实测回填**；被改切片（16）读数只抬不降。

---

## 8. 部署、回滚与明确不做

- **部署**：零新服务/容器；**env 面唯一例外 = §1.2 登记的 user-service 两行测试注入面**（A2 口径统一）；既有 release 流程（tag `v*`）。**谓词默认关**——生产开启按手顺（先 `sameDevice` 观察一周，再评估 `sameIp`；**写进交接文档与 `first-deploy.md`**，F11）。
- **回滚**：镜像回滚即可；三新表与 8 键为纯增量（旧镜像无视；`risk_*` 键无消费方时零副作用）。
- **明确不做**（与设计 §1.2 同步）：申诉产品化（K1）· 地理/近期交手谓词 · 自动封禁 · 长期 IP 留存 · 频率面重做 · 16xxx 启用。

---

## 修订记录

- **v1.0**（2026-10-05）：首版。承接设计 v1.1.1；⚙️1–⚙️21 裁定（含 R14 全部低置信项实读落钉）；契约/判据/矩阵/验收成文。
- **v1.1**（2026-10-05）：**r1 规格评审 17 条全数处置**（1🔴/5🟠/11🟡；报告 `.superpowers/sdd/2026-10-05-risk-control/review-spec-r1.md`）——**F1** ⚙️10 锁定读改「最新一行（任意 status）」+ SQL2 补 users 过滤（dismissed 抑制/banned 跳过不再被绕过）· **F2** §4.1 补 slice-18 的 `adminKeys.length===17` ⇒ 25 · **F3** 兜底顺位订正（⚙️22-①，设计 v1.1.2 同步）· **F4** 子集=3 分支 + 洗牌副本保序（⚙️22-②/⚙️23）· **F5** 记忆拒绝只加 attempts 不 INCR · **F6** unthrottle 源态校验按旗（清孤儿旗）· **F7** 自愈 SQL3 + 复核读 + 先例指认订正 · **F8** 旗读单独 catch（不吞 fail-closed 管道）· **F9** `no_legal_group` 改可观测定义 · **F10** C2/C3/C9/C12 补三处负对照 · **F11** first-deploy 键表/手顺 + CONFIG_NOTES 8 条 · **F12** deviceId 不入 clearSession · **F13** 详情 `accountStatus/limitSource` 写死 · **F14** 锁 compare-and-delete（⚙️24）· **F15** `<3` 拆组契约化 · **F16** EXPECTED_FILES 改「已核不动」 · **F17** reopen 动作落点（⚙️22-③）。
- **v1.1.1**（2026-10-05）：**修复核验 6 处文本收口 → 规格冻结**——头部版本/承接升版 · §2.8「管理面合法集 = 5 值」写死（`auto_throttle|reopen` 系统专用）· §2.2 `reasons` 注释 +`revived` · ⚙️10 列清单补 `handled_by` · F14 引用消歧（设计 r1-F14 / 规格 r1-F14）· 设计侧对应收口 = v1.1.3（D1/§5.1 失败记账拆分、§3.1 注释）。核验回执：17/17 主处置落地。
- **v1.1.2**（2026-10-05）：**计划 r1 回填三处**——§1.2/§4.1#10 conformance 入口订正为 `src/run.ts`（F7）· §2.4-1 谓词实现形（`{name, allows}`）订正（F14）· §1.2 登记 `docker-compose.yml` user-service 两行测试注入 env（F12；随偏离台账）。
- **v1.1.3**（2026-10-05）：**计划核验 3 处收口 → 规格冻结（最终）**——头部/状态版本指针（A7）· §8 部署行 env 口径与 §1.2 统一（A2）· §4.2 偏离台账统一六条（A3）。**规格冻结。**
- **v1.1.4**（2026-10-05）：**波 1 评审回填（实现期语义补丁）**——§2.4-3 新增「前置筛选：孤儿票（无 meta）静默清出」+ C2 断言补（波 1 F1 裁决；F2/F3/F4 为用例补强，随实现修复提交）。
- **v1.1.5**（2026-10-05）：**波 2 裁决回填**——§2.7-2 F3（「断线即出局」口径：不打断=存量连接与对局自然推进，无「进行中局豁免」）· §2.6-5 F5（旗读两类：检测位 fail-open / 校验位 fail-closed）· §2.5-3 补注「score ≥ 25 门」（与设计 §5.2 表头统一，F1）。
- **v1.1.6**（2026-10-05）：**波 2 核验回填 4 处**——⚙️5/R2/§2.13「全断」措辞订正与 F5 例外附注（R1/R2）· ⚙️19/§2.7-3 补 F2 旗写后置与 unban 源态放宽、§2.4-3 补封禁票撤出（R3）· reviewId 断言限定与 404 次序注（F6）。
- **v1.1.7**（2026-10-05）：**opus 终审回填**——§2.5-3 open 分支护 manual 旗（终审 F1：先读旗现值、manual ⇒ 条目迁 throttled 旗与 handled_* 不动零审计；`KEEP_HANDLER`）· §2.6-5 旗读三类（+**决策读** = 失败照抛）· §2.8 详情 +`bannedFlagPresent`（终审 F2）· F3 口径（K1 文案覆盖 11003 全部可见面，客户端侧）· F4 台账七条已由 T12/F4 修复统一。
- **v1.1.8**（2026-10-05）：**终审核验回填**——C17 行补 manual 旗例外限定（同 F1 口径）。
