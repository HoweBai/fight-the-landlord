# 代理分润（台费佣金）—— 设计 v1.1

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-26 起草；同日 r1 对抗审查后修订 |
| 状态 | **v1.1 · r1 审查已处置（8 阻断 / 27 高 / 13 低）· 待用户过目** |
| 用户裁决 | ①注册填邀请码绑定 + 管理员审计改绑 ②级差制、平台统一建树 ③只分台费，抽水不分佣 ④计佣口径 = 净入金（运营加减币计入） ⑤每个代理单独约定比例，有默认值 ⑥自玩只保留「同手机号」特判 ⑦按需结算、只结自己 ⑧代理不看抽水，管理后台/Grafana 看 ⑨暗上线默认关 ⑩生效时点不回溯 |
| 上游真源 | `rooms.start.ts` 台费块 · `currency_ops/currency_flows` · `apply.service.ts` 唯一写边 · `withdrawable.service.ts` 6 源 · `auth.service.ts` 注册 · `admin-policy.ts` 管理策略 · `rpc.module.ts` 装配面 |

---

## 0. 背景与目标

### 0.1 现状（实现前已核实）

1. **台费**：金币场每局开局成功后，逐真人一条 `currency.apply`：`source='entry_fee'`、`actionId='entryfee:<房号>:<ownerId>'`、`refId=<房号>`、`entries=[{ownerId, delta:-fee}]`。金额 `entryFeeOf = percent>0 ? max(1, floor(baseScore×percent/100)) : 0`；`baseScore ≤ 8191`、`entryFeePercent 0–100` ⇒ 单笔 ≤ 8191。斗地主与跑得快共用；机器人免收；免费场/好友房无台费。
2. **账本**：`currency_ops`（幂等锚 `uk_action_id`）/ `currency_flows`（只增不改）/ `currency_accounts`；`apply.service.ts` 是唯一写边，`applyWithEffect` 在 flows 之后、commit 之前执行可选 effect（抛错整批回滚；**RPC 默认不经过 effect**）。`ApplyService` 的 provider 在 `RpcModule`；`ConfigCacheService` 由 `ConfigModule` 导出。
3. **资金用途**：可提现 6 源 = `recharge/game_settle/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback`；`cap = max(0, min(cap_raw, balance))`。台费、记牌器、赠送、救助、`admin_adjust` 不可提现。
4. **退款/提现**：`refund_hold` / `withdraw_hold` 是实际扣币（负 delta）；驳回走 `refund_rollback` / `withdraw_rollback`（正 delta）；**已成功退款没有反向撤销路径**。
5. **冲正**：`admin_reverse` 只能冲正 `admin_adjust`（`source !== 'admin_adjust'` ⇒ 409），不能冲台费/充值。
6. **注册**：手机号 + 密码 + 昵称；先发 `signup_grant` 再落库；没有任何邀请码/归属字段。
7. **管理端**：单页 `admin/app.js`；四角色 `super_admin/finance/operator/viewer`；policy 显式枚举，**未登记的 GET 默认落 P8（任意已认证角色）**，未登记的写端点落 P9 全拒。`P4` 允许 `super_admin|operator` 写任意 config 键；`P5` 允许 `super_admin|finance` 做玩家 `wallet/adjust`（无单笔/日限）。
8. **玩家 JWT**：只签 `{sub, phone, jti, typ}`，**不校验 `aud`**；管理令牌才钉 `aud:'ftl-admin'`。
9. **配置**：`CONFIG_KEYS` 恰 93 键、`CLIENT_CONFIG_KEYS` 恰 21 键；`config.test.ts`、`errors.test.ts`（SPEC_CODES + `CLIENT_ACTION`）与 `verify-admin-static.mjs`（93/77/77/72/35/65）都有精确计数闸。
10. **静态站**：`Dockerfile.edge` 把 `admin` COPY 到 `/srv/admin`；`deploy/Caddyfile` 用 `handle /admin` + `handle /admin/*`（`redir * /admin/ 301`）。

### 0.2 目标与成功判据

- 平台可在后台建代理树、发邀请码；玩家注册填码即永久归属；管理员可审计改绑（只影响未来）。
- 代理按其名下玩家**实际支付的台费**拿级差佣金；抽水/残差/记牌器/充值全部归平台。
- 计佣口径为**净入金**：充值 + 运营加减币 + 各类回滚 − 退款/提现（**只抵扣未消耗本金**）；赠送/救助/广告/赢钱不计。
- 代理在独立门户查看自己名下玩家、台费贡献、剩余额度、佣金、结算单；上级只看整棵下线汇总。
- 佣金逐笔固化、万分位累计、按需结算、线下打款、全程可审计。
- 代理模块任何故障**不得**阻断台费/充值/退款/提现；`agent_settings.enabled=false` 时对既有链路零影响。

### 0.3 明确不做

- ❌ 抽水分成、按座位抽水持久化（代理不看；管理后台/Grafana 用既有 `burned_rake` 汇总）。
- ❌ 代理自助发展下级、代理钱包、代理自助提现、自动打款。
- ❌ 逐币溯源（FIFO 批次账）；不做按「输给他人/记牌器」扣额度（登记为残余风险）。
- ❌ 代理实名/发票/个税代扣的系统实现；只存收款信息快照与替代凭证。
- ❌ 代理排行榜、绩效升降级、合同电子签署、代理端搜索框（v1 只分页）。

---

## 1. 决策表

| # | 决策 | 内容 |
|---|---|---|
| D1 | 归属 | 注册填邀请码即绑定，永久；管理员可审计改绑/解绑，只影响之后产生的佣金；保留绑定历史 |
| D2 | 层级 | 级差制；平台在管理后台建树；默认最多 5 级；强制 `parent.rate ≥ self.rate ≥ max(child.rate)`，禁止环 |
| D3 | 分成基数 | 只分台费（`entry_fee` 实际收取金额）；抽水/残差/记牌器/充值归平台 |
| D4 | 计佣口径 | **净入金额度**。正入账：`recharge`、`admin_adjust`(+)、`admin_reverse`(+)、`refund_rollback`、`withdraw_rollback`。负出账：`refund_hold`、`withdraw_hold`、`admin_adjust`(−)、`admin_reverse`(−)，**最多抵扣 `max(0, inflow − consumed)`（只抵扣未消耗本金）**。赠送/救助/广告/赢钱/记牌器不计。`admin_adjust` 正数另有单玩家单日额度上限（默认 50,000 币）与审计。台费逐笔消耗额度 |
| D5 | 比例 | 每代理一个比例（内部 bp，UI 整数百分比，0–100）；新建时取 settings 默认值；改比例只影响之后的台费；每笔按发生时链上比例固化 |
| D6 | 自玩 | 玩家手机号 = 链条中某代理手机号 ⇒ 该代理份额 0 且**不推进档位**（顺延给上一级；无上级归平台）；冻结 ⇒ 份额 0 且**推进档位**（份额归平台）；优先级冻结 > 自玩；第二个手机号/家人号/换号一律正常计佣 |
| D7 | 结算 | 代理在门户发起，只结自己；一代理同时只能有一张 pending 单；**ID 水位**界定本单范围（不锁佣金行）；金额申请时快照；财务审核 → 线下打款 → 回填凭证；驳回/撤回只清 pending；已打款不可改单 |
| D8 | 代理账号 | 平台创建（手机号 + 初始密码），独立于玩家/管理员；门户 `/agent`，手机优先；独立 JWT `aud:'ftl-agent'` + `typ:'agent-access'` + `ver`；首登强制改密；管理员重置；收款信息仅管理员可改 |
| D9 | 可见性 | 代理：自己名下玩家（昵称、脱敏手机号、绑定时间、台费局数、台费贡献、剩余额度、佣金）+ 自己的佣金/结算单；上级：整棵下线汇总（人数、台费、自己的级差），不看下级玩家身份/金额；代理不看抽水 |
| D10 | 状态 | `active/frozen`；冻结停止新增自己的佣金、禁止成为新绑定目标，但**仍可登录、只读、发起存量结算**；不可删除，可解冻 |
| D11 | 暗上线 | `agent_settings.enabled` 默认 false（super_admin 专用端点）；客户端邀请码开关 `agent.inviteEnabled` 默认 false。**绑定要求两个开关都开**；关闭期不绑定、不计额度、不计佣 |
| D12 | 范围 | 金币场台费；斗地主 + 跑得快；机器人/免费场/好友房天然无台费 |
| D13 | 保留 | 佣金/结算/绑定/比例/状态历史永久保留；改绑、改比例、冻结都不追溯改写历史 |
| D14 | 故障隔离 | 代理记账作为 `ApplyService.applyWithEffect` 内置钩子；**仅语句级错误**用 SAVEPOINT 隔离；死锁/锁超时/连接错误一律重抛，让 apply 失败由调用方幂等重试 |
| D15 | 舍入 | 佣金内部以 1/10000 金币（micro）累计；每级 `micro = base × paid_bp`；结算 `floor((carry + Σmicro)/10000)` 转金币，零头结转 |
| D16 | 生效时点 | `agent_settings.effective_from` 设为上线时刻（DB 时钟）；只处理 `enabled=1 AND effective_from IS NOT NULL AND op.created_at >= effective_from`；永不回溯；老客户端无邀请码正常注册，未归属注册单独统计 |
| D17 | 财务 | 内部统一 micro；台费收入（flows）/ 佣金（entry + manual）/ 已结（settlement total_coins）/ 已付（现金）；专用 `agent_coin_per_yuan`，不用可被 operator 改的 `pay.coinPerYuan` |
| D18 | 对账 | 每笔 entry_fee op 必须有且仅有一条 revenue event（含 unbound/skipped）或一条 gap；逐行 `micro = base × paid_bp`；`0 ≤ Σmicro ≤ base × topBp`；日对账缺口 > 0 告警 |
| D19 | 人工调账 | 允许；super_admin 发起 + **另一名** super_admin 复核；单笔/单日限额；写原因；全程审计；调的是代理未结佣金，不动玩家钱包/额度 |
| D20 | 权限 | 代理管理/比例/状态/改绑/收款/调账 = super_admin；结算队列/打款/驳回 = finance 或 super_admin；代理侧全部读口 = super_admin 或 finance；viewer/operator 一律 403 |
| D21 | 隐私 | 手机号脱敏（前 3 后 4）；不返回玩家余额/充值/提现明细；IDOR 负例：`agent_id` 只从 token 取 |
| D22 | 合规 | 代理合同（回冲授权/数据保密/解约清算/税费承担）；收款信息受限访问；禁止代理经手玩家资金；替代凭证（签收单 + 银行流水） |

---

## 2. 资金模型

### 2.1 术语

- **计佣基数（base）**：`base = min(fee, max(0, inflow_total − consumed_total))`。
- **额度（quota）**：玩家终身可计佣上限；`available = max(0, inflow_total − consumed_total)`。**不为负**。
- **micro**：1/10000 金币；`rate_bp = percent × 100`（80% ⇒ 8000）。
- **级差**：从直接代理向上走，`paid_bp = r_i − lastPaidBp`；`lastPaidBp` 初始 0。
- **carry**：代理级零头，per-agent，结算打款时更新。
- **水位**：`agent_accounts.settled_watermark` = 已结佣金行的最大 `id`；结算只覆盖 `(watermark, to]`。

### 2.2 额度来源矩阵（13 源全分类）

| source | 对额度 | 说明 |
|---|---|---|
| `recharge` | +delta | 充值到账 |
| `admin_adjust` | +delta / −delta | 正数受单玩家单日上限（默认 50,000 币）与审计；负数按出账上限抵扣 |
| `admin_reverse` | +delta / −delta | 只能冲正 `admin_adjust`，delta 即反向 |
| `refund_hold` | 负 delta，最多抵扣未消耗本金 | 退款实际扣币 |
| `refund_rollback` | +delta | 退款驳回回滚 |
| `withdraw_hold` | 负 delta，最多抵扣未消耗本金 | 提现冻结扣币 |
| `withdraw_rollback` | +delta | 提现驳回回滚 |
| `entry_fee` | 0 | 走 base 消耗，不直接改 inflow |
| `game_settle` / `relief_grant` / `signup_grant` / `robot_pool` / `card_counter` | 0 | 赢钱/赠送/救助/机器人/记牌器不计 |

**负出账上限**：`deduct = min(abs(delta), max(0, inflow − consumed))`；`inflow -= deduct`。这使「赢钱后提现」不压低佣金，也保证额度不为负。
**纪律**：13 个 source 必须有显式分类；新增 source 未分类 ⇒ 单测红。

### 2.3 级差算法（逐字）

```
chain = [direct(level 0), parent(level 1), ..., root]   # 读侧 visited 集合 + 深度 ≤ 5
lastPaidBp = 0
for agent in chain:
  if agent.status == 'frozen':
      payoutBp = 0
      lastPaidBp = agent.rateBp          # 冻结：份额归平台，档位推进
      continue
  if binding.phoneHash == hmac(agent.phone):
      payoutBp = 0                        # 自玩：份额顺延，档位不推进
      continue
  payoutBp = agent.rateBp - lastPaidBp
  if payoutBp < 0:                        # 数据损坏兜底：绝不倒贴
      payoutBp = 0
      lastPaidBp = max(lastPaidBp, agent.rateBp)
      log.error(); metric.inc()
      continue
  lastPaidBp = agent.rateBp
  micro = base * payoutBp
  if micro > 0: insert commission(agent, level, rateBp, paidBp, micro)
平台留存 = base − Σ(micro)/10000
```

- **逐行不变量**：每行 `micro = base × paid_bp`；`0 ≤ Σmicro ≤ base × topBp`（冻结/自玩只改变分配对象，可能少于 topBp）。
- **chain 快照**：revenue event 存 `top_rate_bp`、`expected_max_micro = base × topBp`、`chain_json`（agentId/rateBp/status/selfPlay/level），供对账与争议。
- **示例**：台费 1、直接 60%、上级 80%、再上级 90%。直接 0.6、上级 0.2、再上级 0.1、平台 0.1；micro 累计后 5 局分别为 3/1/0.5/0.5 金币。
- **示例（自玩）**：直接代理本人是玩家 ⇒ 直接 0；上级拿 80%；再上级拿 10%；平台 10%。
- **示例（冻结）**：直接代理冻结 ⇒ 直接 0；上级拿 20%；再上级拿 10%；平台 70%。Σ=30% < topBp=90% —— 因此不变量只能是 `≤`。
- **负级差**：只可能来自数据损坏/并发改率；payout 0 且不降低 `lastPaidBp`，绝不出现总付出 > topBp。

### 2.4 额度更新时序

- 每笔 qualifying op 在**同一事务**内更新 `agent_player_quota`。
- 额度行首建用**原子 upsert**（`INSERT ... ON DUPLICATE KEY UPDATE owner_id=owner_id`），随后 `SELECT ... FOR UPDATE` 锁**已存在**行；禁止对缺失行先 `FOR UPDATE`（避免首局并发 gap-lock 死锁）。
- 正入账：`inflow += delta`（`admin_adjust` 受单日上限）。
- 负出账：`deduct = min(abs(delta), max(0, inflow − consumed))`；`inflow -= deduct`。
- 台费：读绑定 → 读链 → 锁额度行 → `base = min(fee, available)` → `consumed += base` → 写 revenue event → 写佣金行。
- `quota_hold_days > 0`：正入账先写 `agent_quota_inflows`（`matures_at = now + hold`），到期循环并入 `inflow_total`；**持有期内台费 base=0、不递延补佣**（合同写明）。
- `admin_adjust` 正数单日上限：`agent_admin_quota_credits(owner_id, day, credited_coins)`，超限部分只入账钱包、不计额度；指标告警。

---

## 3. 数据模型（currency-service 新表，17 张）

> 迁移类名 **不得** 以 `Currency` 开头（`migration.test.ts` 按 `/^Currency\d+$/` 取首个匹配，会抢位）。文件名 `<ts>-AgentDomain.ts`；ENGINE/CHARSET 照 `1789600000000-Currency.ts`（`InnoDB` + `utf8mb4` + `utf8mb4_0900_ai_ci`）。`agent_settings` 需 id=1 种子行。

### 3.1 `agent_settings`（单行 id=1）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | tinyint PK | 恒 1 |
| `enabled` | tinyint(1) | 总开关（默认 0） |
| `effective_from` | datetime(3) NULL | 上线时刻；NULL = 未启用 |
| `default_rate_bp` | int | 新建代理默认比例（0–10000，默认 0） |
| `min_settlement_yuan` | int | 最低结算额（元，默认 100） |
| `coin_per_yuan` | int | 代理结算专用汇率（币/元，默认 100；**不用 `pay.coinPerYuan`**） |
| `quota_hold_days` | int | 额度成熟天数（0–365，默认 0） |
| `quota_admin_adjust_daily_limit_coins` | int | 单玩家单日 admin_adjust 计额上限（默认 50000） |
| `adjust_max_yuan_per_op` | int | 单笔人工调账上限（元，默认 10000） |
| `adjust_max_yuan_per_day` | int | 单代理单日调账上限（元，默认 20000） |
| `updated_at` / `updated_by` | datetime(3) / varchar(50) | |

### 3.2 `agent_accounts`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | varchar(40) PK | `ag_` + uuid |
| `name` | varchar(50) | 代理名 |
| `phone` | varchar(20) UNIQUE | 登录手机号；与玩家同号触发自玩特判 |
| `password_hash` | varchar(255) | scrypt `s1$N$r$p$salt$hash` |
| `parent_id` | varchar(40) NULL | 上级；自引用；索引 |
| `rate_bp` | int | 当前比例 0–10000 |
| `region` | varchar(50) NULL | 片区（自由文本） |
| `contact_name` | varchar(50) NULL | 联系人 |
| `payout_name` / `payout_account` / `payout_bank` | varchar(100) NULL | 收款信息快照源；允许 NULL |
| `status` | varchar(10) | active/frozen；索引 |
| `must_change_password` | tinyint(1) NOT NULL DEFAULT 1 | 首登/重置后强制改密 |
| `token_version` | int NOT NULL DEFAULT 0 | JWT `ver`；重置密码/冻结时递增 |
| `micro_carry` | bigint NOT NULL DEFAULT 0 | 零头结转（稳态 0–9999） |
| `settled_watermark` | bigint NOT NULL DEFAULT 0 | 已结佣金行最大 id |
| `pending_settlement_id` | bigint NULL DEFAULT NULL | 一代理一 pending 的快速闸 |
| `created_at` / `updated_at` | datetime(3) | |

### 3.3 `agent_invite_codes`

`code varchar(16) PK`、`agent_id varchar(40)`、`status varchar(10)`（active/revoked）、`created_at`。索引 `(agent_id, status)`。
一代理同时只有一枚 active：轮换事务内**锁 agent 行**（`FOR UPDATE`）后 revoke 旧 + insert 新。

### 3.4 `agent_bindings` / `agent_binding_history`

- `agent_bindings`：`owner_id varchar(36) PK`、`agent_id`、`bound_at`、`source`（signup/admin）、`bound_by`、`phone_hash char(64) NOT NULL`（HMAC-SHA256，自玩判定）。索引 `(agent_id, bound_at)`。
- `agent_binding_history`：`id bigint AI PK`、`owner_id`、`agent_id`、`action`（bind/rebind/unbind）、`actor`、`reason`、`created_at`；索引 `(owner_id, id)`。

### 3.5 `agent_rates` / `agent_status_history`

- `agent_rates`：`id bigint AI PK`、`agent_id`、`rate_bp`、`actor`、`reason`、`created_at`；索引 `(agent_id, id)`。
- `agent_status_history`：`id bigint AI PK`、`agent_id`、`status`、`actor`、`reason`、`created_at`；索引 `(agent_id, id)`。

### 3.6 `agent_player_quota`

`owner_id varchar(36) PK`、`inflow_total bigint`、`consumed_total bigint`、`updated_at datetime(3)`。
`available = max(0, inflow_total − consumed_total)`；行不存在 ⇒ 0。

### 3.7 `agent_quota_inflows`（仅 `quota_hold_days > 0`）

`id bigint AI PK`、`owner_id`、`source_op_id bigint UNIQUE`、`amount int`、`matures_at datetime(3)`、`matured_at datetime(3) NULL`。索引 `(matures_at, matured_at)`。到期循环 `FOR UPDATE SKIP LOCKED` 并入 `inflow_total`。

### 3.8 `agent_admin_quota_credits`

`owner_id varchar(36)`、`day date`、`credited_coins int`、PK `(owner_id, day)`。仅用于 `admin_adjust` 正数单日上限。

### 3.9 `agent_revenue_events`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint AI PK | |
| `owner_id` | varchar(36) | 玩家 |
| `agent_id` | varchar(40) NULL | 发生时的直接代理；unbound ⇒ NULL |
| `source_op_id` | bigint | 台费 op；`UNIQUE(source_op_id, owner_id)` |
| `fee_amount` | int | 毛台费 |
| `base_amount` | int | 计佣基数（≤ fee） |
| `quota_consumed` | int | 本次消耗额度 |
| `top_rate_bp` | int | 链顶比例（unbound ⇒ 0） |
| `expected_max_micro` | bigint | `base × top_rate_bp` |
| `chain_json` | json NULL | 链快照（agentId/rateBp/status/selfPlay/level） |
| `skipped_reason` | varchar(20) NULL | `unbound` / `quota_exhausted` / `no_payee`；NULL = 已计佣 |
| `ref_id` | varchar(128) NULL | 房号 |
| `created_at` | datetime(3) | |

索引 `(agent_id, created_at)`、`(owner_id, created_at)`、`(skipped_reason, created_at)`。

### 3.10 `agent_commission_entries`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint AI PK | 水位依据 |
| `agent_id` | varchar(40) | 收佣代理 |
| `owner_id` | varchar(36) NULL | 玩家（manual 行可空） |
| `revenue_event_id` | bigint NULL | 台费来源行 |
| `source_op_id` | bigint NULL | 幂等：同一 op + agent 只一行 |
| `kind` | varchar(10) | entry/manual |
| `level` | int | 0 = 直接；1.. = 级差 |
| `rate_bp` / `paid_bp` | int | 代理比例 / 本次实付级差 |
| `commission_micro` | bigint | 可负（manual） |
| `reason` | varchar(255) NULL | manual 原因 |
| `created_at` | datetime(3) | |

`UNIQUE(source_op_id, agent_id)`；索引 `(agent_id, id)`、`(owner_id, id)`、`(revenue_event_id)`。**行只增不改**（水位结算，无 `settlement_id`）。

### 3.11 `agent_settlements`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint AI PK | |
| `settlement_no` | varchar(32) UNIQUE | `AS` + 12 位零填充 id |
| `agent_id` | varchar(40) | |
| `client_request_id` | varchar(64) | `UNIQUE(agent_id, client_request_id)` |
| `status` | varchar(10) | pending/paid/rejected/cancelled |
| `from_entry_id` / `to_entry_id` | bigint | 本单覆盖 `(from, to]` |
| `total_micro` | bigint | 本单条目 micro 合计 |
| `total_coins` | bigint | `floor((carry_before + total_micro)/10000)` |
| `items_count` | int | 条目数 |
| `carry_before` / `carry_after` | bigint | |
| `coin_per_yuan` | int | 申请时快照 |
| `payout_json` | json | 收款信息快照 |
| `min_yuan` | int | 申请时快照 |
| `items_hash` | char(64) | 规范串 SHA-256 |
| `requested_at` / `decided_at` / `paid_at` | datetime(3) | |
| `decided_by` / `paid_by` / `voucher_no` / `reject_reason` | varchar | |
| `created_at` / `updated_at` | datetime(3) | |

索引 `(agent_id, status, id)`、`(status, id)`。

### 3.12 `agent_adjustments`

`id bigint AI PK`、`agent_id`、`delta_micro bigint`、`reason varchar(255)`、`status`（pending/approved/rejected）、`requested_by`、`approved_by`、`commission_entry_id bigint NULL`、`created_at`、`decided_at`。索引 `(agent_id, status)`。

### 3.13 `agent_admin_audit`

`id bigint AI PK`、`actor varchar(50)`、`action varchar(50)`、`target_type varchar(30)`、`target_id varchar(64)`、`before_json json NULL`、`after_json json NULL`、`reason varchar(255) NULL`、`created_at`。索引 `(target_type, target_id, id)`。

### 3.14 `agent_ledger_gaps`

`id bigint AI PK`、`source_op_id bigint UNIQUE`、`owner_id varchar(36) NULL`、`source varchar(32)`、`error varchar(500)`、`created_at`。钩子失败时**独立连接** best-effort 写入（主事务可能已毒化）。

### 3.15 `agent_settings_history`

`id bigint AI PK`、`enabled tinyint(1)`、`effective_from datetime(3) NULL`、`changed_at datetime(3)`、`actor varchar(50)`。每次启用/停用写一行；对账据此只统计「启用区间」内的 entry_fee op，避免关闭期历史被误报为缺口。

### 3.16 bigint 读回纪律

所有 bigint 列（`micro_carry`/`settled_watermark`/`total_micro`/`total_coins`/`commission_micro`/`expected_max_micro`/`inflow_total`/`consumed_total`）读回必须经 `toSafeInt`（照 `reverse.service.ts:49-55`）；假 DB 需有「驱动返回字符串」用例，禁止 `"0" + "123"` 式字符串拼接。

---

## 4. 写边（ApplyService 内置钩子）

### 4.1 位置与隔离

- `ApplyService.applyWithEffect` 在调用方 effect 之后、commit 之前调用 `AgentLedgerService.onApply(manager, ctx)`。
- `onApply` 首步用**同一 manager** 读 `agent_settings`（不缓存，多副本立即生效）；`enabled=0` 或 `effective_from IS NULL` 或 `op.created_at < effective_from` ⇒ 返回。
- 保存点协议：
  ```
  SAVEPOINT agent_ledger
  try { onApply(); RELEASE SAVEPOINT agent_ledger }
  catch (err) {
    if (isFatalTxError(err)) throw err;       // 1213 死锁 / 1205 锁超时 / 连接错误 / 1305
    try { ROLLBACK TO SAVEPOINT agent_ledger; RELEASE SAVEPOINT agent_ledger; }
    catch (rbErr) { throw err; }              // 事务已毒化 ⇒ 让 apply 失败，调用方幂等重试
    logger.error(); agentHookFailures.inc({source});
    bestEffortGapInsert(err);                 // 独立连接；失败只记日志
  }
  ```
- 主事务照常提交；代理故障只影响佣金/额度（平台少付，玩家无损）。
- **不得**把事务级错误当语句级吞掉；**不得**在保存点回滚后继续使用已失效的 manager 写业务表（gap 用独立连接）。
- 重放分支不执行钩子（原事务已提交）；`uk_action_id` + 佣金唯一键双保险。

### 4.2 onApply 逻辑

1. 读 settings（同一 manager）。
2. 对每个 entry（只 `ownerType='user'`）：
   - `source` 在额度矩阵 ⇒
     - `INSERT ... ON DUPLICATE KEY UPDATE owner_id=owner_id` 确保额度行存在，再 `SELECT ... FOR UPDATE`。
     - 正入账：`admin_adjust` 先锁/读 `agent_admin_quota_credits`，`credit = min(delta, limit − credited)`；其余正入账全额。`quota_hold_days>0` ⇒ 写 `agent_quota_inflows`；否则 `inflow += credit`。
     - 负出账：`deduct = min(abs(delta), max(0, inflow − consumed))`；`inflow -= deduct`。
   - `source='entry_fee'`：
     - 读 `agent_bindings`；无绑定 ⇒ 写 revenue event（`agent_id NULL`、`skipped_reason='unbound'`、base 0），跳过佣金。
     - 锁额度行；`fee=abs(delta)`；`base=min(fee, available)`；`consumed += base`。
     - 读链（visited + 深度 ≤5）；`topBp`；按 §2.3 算 micro；写佣金行（micro>0）。
     - 写 revenue event（bound；`skipped_reason` = `quota_exhausted`（base=0）或 `no_payee`（无 micro）或 NULL）。
3. 所有 SQL 走同一 manager；唯一键 `ON DUPLICATE KEY UPDATE id=id` 幂等；失败按 §4.1。

### 4.3 幂等与重放矩阵

| 场景 | 结果 |
|---|---|
| 台费 op 首次成功 | 1 revenue event + N 佣金行 |
| 台费 op 重试/重放（`replayed`） | 事务未重跑 ⇒ 0 新行 |
| 同一 op 钩子重跑（理论） | 唯一键 ⇒ 0 新行 |
| 12002/14002 冲突 | 原 op 已成功 ⇒ 钩子只在首次执行 |
| 免单（apply 失败） | 无 op ⇒ 无钩子 |
| 钩子语句级失败 | 保存点回滚；op 照常提交；`agent_ledger_gaps` + 指标 |
| 死锁/锁超时/连接错误 | 重抛 ⇒ apply 失败 ⇒ room-service 幂等重试；不提交空事务 |

---

## 5. 归属生命周期

### 5.1 邀请码

- 格式：8 字符 `[A-HJ-NP-Z2-9]`（去掉 I/O/0/1），大写；输入 trim + uppercase；唯一 PK。
- 一代理一 active 码；轮换 = 锁 agent 行 → 旧码 revoked → 新码 active（事务）。既有绑定不受影响。

### 5.2 注册绑定（一次 RPC，fail-closed）

`RegisterDto` 增加可选 `inviteCode`（trim/uppercase/长度 8/字符域）。

注册时序：
1. 生成 `userId`。
2. 若 `inviteCode` 存在 ⇒ 调 `agent.bind({ownerId, code, phone, source:'signup'})`（**同一事务内重新校验**码、两个开关、代理状态）：
   - `bound` ⇒ 继续；
   - `already_bound`（该 owner 已有绑定）⇒ 继续（首绑为准，不覆盖）；
   - `ignored`（`agent_settings.enabled=false` 或 `agent.inviteEnabled=false`）⇒ 继续，注册为未归属；
   - `AGENT_INVITE_INVALID` ⇒ 注册失败 400，**不建用户、不发赠币**；
   - 传输失败 ⇒ 注册失败 10007（与 signup grant 同一姿态）。
3. 发 `signup_grant`（既有）。
4. 落 `users` 行（既有）。
5. 绑定已在第 2 步完成；若第 3/4 步失败，可能留下**孤儿绑定**（uuid 永不复用；日志 + 指标；提供按 owner 清理的运维 SQL）。
- **TOCTOU 消除**：`bind` 用 code 而非 agentId，在同一事务内重新解析/校验。
- **开关矩阵**：两个开关都开才 `bound`；任一关 ⇒ `ignored`。2×2 测试。
- **phone_hash**：`HMAC-SHA256(normalizePhone(phone), AGENT_PHONE_HMAC_KEY)`；`normalizePhone` = **trim + 数字归一**（去空格/`+`/`-`/括号、全角数字转半角、去 `86`/`0086` 国家码前缀；结果必须 `^1\d{10}$`，否则保留 trim 原值；唯一实现，bind/rebind/profile 三处共用；三处同值用例）。⚠️ 2026-10-26 r3 代码审订正：原写 `trim` 会被 `+86…`/分隔符变体绕过自玩特判（Important #2）。`AGENT_PHONE_HMAC_KEY` 在 **production 缺失 ⇒ `main.ts` 启动 `process.exit(1)`**（照 `INTERNAL_SERVICE_TOKEN`；加源码级闸）；v1 不支持轮换（文档写明；轮换需全量重算）。

### 5.3 改绑/解绑/批量

- 单玩家改绑/解绑：从 `user.agentProfile.get` 取手机号 → 计算 `phone_hash` → 更新 `agent_bindings` + history + audit；只影响之后。
- 批量改绑：按源代理 → 目标代理；`dryRun` 返回人数；**每批 500、keyset 续跑、每批独立事务**；执行时再校验目标 `status='active'`；上限 5000/次；进度 + audit。
- 代理冻结：禁止成为新绑定目标；既有绑定保留；不自动迁移。
- 索引：`agent_bindings(agent_id, bound_at)`。

### 5.4 effectiveFrom

- 首次启用时写 `effective_from = NOW(3)`（super_admin 端点，audit）；之后不再改。
- 钩子判定：`enabled=1 AND effective_from IS NOT NULL AND op.created_at >= effective_from`（**统一用 op.created_at**）。
- 关闭再开不重置；`enabled=1 && effective_from IS NULL` ⇒ 视为未启用 + 告警。

---

## 6. 结算（ID 水位，不锁佣金行）

### 6.1 状态机

```
(agent 申请) pending ──财务打款──> paid
                  ├──财务驳回──> rejected（清 pending）
                  └──代理撤回──> cancelled（清 pending）
```

- 一代理同时只能有一张 pending（`pending_settlement_id` + agent 行锁）。
- 已 paid 不可改；错误走人工调账 + 应收台账。
- 冻结代理仍可登录、只读、发起/撤回存量结算。

### 6.2 申请（事务，无佣金行锁）

1. `SELECT ... FROM agent_accounts WHERE id=? FOR UPDATE`。
2. **先**查 `(agent_id, client_request_id)` 幂等：存在 ⇒ 返回该单（任意状态；客户端重试须换新 id）。
3. 校验 `pending_settlement_id IS NULL`；非空 ⇒ `AGENT_SETTLEMENT_PENDING`。
4. `from = settled_watermark`；`to = COALESCE(MAX(id),0) FROM agent_commission_entries WHERE agent_id=?`。
5. `to <= from` ⇒ `AGENT_SETTLEMENT_MIN`（无可结）。
6. `SELECT SUM(commission_micro), COUNT(*) FROM ... WHERE agent_id=? AND id > from AND id <= to`。
7. `total_coins = floor((carry_before + total_micro)/10000)`；`total_coins <= 0` 或 `total_coins * 1 < min_yuan * coin_per_yuan` ⇒ `AGENT_SETTLEMENT_MIN`。
8. 插入 settlement（先以 `settlement_no = 'AS'+uuid 占位`，拿到自增 id 后同事务 UPDATE 为 `AS`+12 位零填充）；`agent.pending_settlement_id = id`；commit。
- `items_hash = SHA256(agentId|from|to|carry_before|total_micro| + 按 id 升序的 "id:micro" 逗号串)`。
- 收款信息缺失（payout_name/account/bank 任一空）⇒ 400「请先补全收款信息」。
- pending 期间新佣金行 id > to，不进入本单；人工调账同样只影响下一单（文档写明）。

### 6.3 打款（事务）

1. 锁 settlement + agent；require pending。
2. 校验 `agent.settled_watermark = from`、`agent.micro_carry = carry_before`。
3. **重新** `SUM(commission_micro)` 与 `items_hash`（`id > from AND id <= to`）；与单头不一致 ⇒ `AGENT_SETTLEMENT_STATE`（409）。
   - **并发提交序兜底**：低 id 事务可能晚于高 id 提交；若水位范围内出现申请后可见的行，SUM/hash 必然不一致。恢复路径 = 驳回/撤回 → 重新申请（水位未推进，行不会丢）；文档与 409 文案写明。
4. `agent.settled_watermark = to`；`micro_carry = carry_after`；`pending_settlement_id = NULL`；status paid、paid_at/by、voucher；audit。

### 6.4 驳回/撤回（事务）

- status rejected/cancelled；`pending_settlement_id=NULL`；不改进 carry/watermark；audit。

### 6.5 展示与财务口径

- 内部统一 **micro**；金币是展示；RMB = `total_coins / coin_per_yuan`（向下取整到分）**仅展示**；打款以合同/线下为准。
- 明细：level 0 按玩家聚合（昵称、脱敏手机号、局数、base、佣金）；level>0 聚合「下线级差」；manual 单独列出。
- 恒等式：`E = ΣT×10000 + C + U`（E=全部佣金 micro；ΣT=已结金币；C=carry；U=水位后未结 micro）。
- 平台净台费 = 台费毛利（coins）− E/10000（含 manual）。
- 负 manual 使未来可结 ≤ 0 ⇒ 拒绝申请、后台显示负余额；**v1 不建应收台账**，由财务线下追偿（合同写明）；已付错账同样走线下应收。

---

## 7. 人工调账（D19）

- 发起：super_admin；`POST /api/admin/agents/:id/adjustments {deltaCoins, reason}`；校验非零、单笔 ≤ `adjust_max_yuan_per_op × coin_per_yuan`、当日 pending+approved 合计 ≤ `adjust_max_yuan_per_day × coin_per_yuan`（事务内锁 agent + 当日调整行，防并发超限）；写 pending + audit。
- 复核：**另一名** super_admin；`POST /api/admin/agent-adjustments/:id/approve`；事务内插入 `agent_commission_entries(kind='manual', commission_micro=delta×10000)`，写 `commission_entry_id`；audit。请求人 == 复核人 ⇒ 403。
- 驳回：super_admin；写 reason；audit。
- 调账只影响代理未结佣金；不触碰玩家钱包/额度；pending 单金额冻结，调账只进下一单。

---

## 8. 代理门户

### 8.1 鉴权与会话

- `POST /api/agent/login {phone, password}`：
  - scrypt 校验；允许 `active` 与 `frozen`（冻结只读 + 结算）；无用户/密码错统一 401（不泄露）。
  - 失败计数：Redis `agent_login_fail:{phone}` 5 次/5 分钟；达界 429；成功清零；网关另有 IP 桶。
  - JWT：**逐字常量链** `process.env.AGENT_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production'`（`||` 不是 `??`；网关与 currency 各一份，由跨服务源码闸比对）；`{sub: agentId, phone, typ:'agent-access', aud:'ftl-agent', ver: token_version, jti}`；TTL 12h；无 refresh。production 缺 `AGENT_JWT_SECRET` 且缺 `JWT_SECRET` ⇒ `main.ts` 启动 `process.exit(1)`。
- 网关 `AgentAuthMiddleware`（所有路径先剥 `x-agent-id`；`/api/agent/*` 除 login 外验签 `aud/typ`、`sub` 以 `ag_` 开头；注入 `x-agent-id`）。
- currency-service `AgentGuard`（读 `x-agent-id`）：
  - 加载 agent 行；`token_version === ver`；否则 401。
  - `must_change_password=1` ⇒ 仅允许 `GET /api/agent/me`、`POST /api/agent/password`，其余 403。
  - 冻结允许读/结算/改密；不允许新绑定（平台侧本就没有代理绑定入口）。
- 重置密码（super_admin）：生成一次性初始密码（返回明文一次、不入日志/审计）、`must_change_password=1`、`token_version++`、audit。
- 收款信息：仅 super_admin `PATCH /api/admin/agents/:id/payout`，audit；门户只读脱敏。

### 8.2 页面/API

| 页面 | API | 内容 |
|---|---|---|
| 登录 | `POST /api/agent/login` | 手机号 + 密码 |
| 概览 | `GET /api/agent/overview` | 比例、邀请码、直接玩家数、活跃玩家数（30d）、台费贡献、计佣基数、累计/未结/已结/已付、carry、下线汇总（若有） |
| 玩家 | `GET /api/agent/players?page&pageSize` | 直接玩家：昵称、脱敏手机号、绑定时间、台费局数（revenue event 数）、台费贡献、剩余额度、佣金 |
| 佣金 | `GET /api/agent/commissions?page&pageSize` | 未结/已结明细；level 0 含玩家；level>0 聚合「下线级差」 |
| 结算 | `GET/POST /api/agent/settlements`、`GET /api/agent/settlements/:id`、`POST .../:id/cancel` | 申请、列表、详情、撤回 |
| 我的 | `GET /api/agent/me`、`POST /api/agent/password` | 资料、改密、邀请码、收款信息（脱敏） |

- 所有查询 `WHERE agent_id = token.agent_id`；**不接受** query/body 里的 agentId（IDOR 负例）。
- 昵称：currency → user 的 `user.nicknames.get`（批量 ≤50）；失败降级 `—`，不 500。
- 手机号脱敏 `138****1234`；不返回玩家余额/充值/提现；v1 不做搜索框（只分页/排序）。
- `局数` = 该玩家的 revenue event 数（台费局数；免费场/好友房不计）。

### 8.3 静态站

- `agent/index.html` / `agent/app.js` / `agent/style.css`；手机优先；`/agent/` 由 edge 静态服务。
- `Dockerfile.edge` 在 `COPY admin /srv/admin` 附近增加 `COPY agent /srv/agent`；`deploy/Caddyfile` 增加 `handle /agent { redir * /agent/ 301 }` + `handle /agent/* { root * /srv; file_server }`（必须在 catch-all 之前）。

---

## 9. 管理后台

### 9.1 页面

「代理」导航区，页签：

1. **代理树**：列表/树（名称、手机号、上级、比例、片区、状态、直接玩家数、未结合计）；新建/编辑（名称、手机号、上级、比例、片区、联系人、收款信息）；冻结/解冻；重置密码；轮换邀请码；**设置**（enabled/effective_from/default_rate/min/coin_per_yuan/quota_hold_days/admin 额度上限/调账限额）。
2. **玩家归属**：按代理看直接玩家；单玩家改绑/解绑；批量改绑（dry-run + 500/批 + 上限 + 审计）。
3. **结算队列**：pending 列表；详情（总额、金币、RMB、carry、收款快照、items_hash、明细）；打款（凭证号 + 备注）；驳回（原因）。
4. **调账**：发起（金额、原因）、待复核、复核/驳回；仅 super_admin。
5. **对账**：按日/区间显示台费毛利、计佣基数、佣金 entry/manual、已结、已付、平台净额、缺口、`agent_ledger_gaps`。
6. **审计**：代理管理/比例/状态/改绑/调账/结算/设置动作的 before/after。

### 9.2 网关 policy（显式、置于 P8/P4 之前）

| 面 | 角色 |
|---|---|
| `GET /api/admin/agents*`、`GET /api/admin/agent-settlements*`、`GET /api/admin/agent-adjustments*`、`GET /api/admin/agent-audit*`、`GET /api/admin/agent-reconciliation*` | super_admin \| finance |
| `POST/PATCH/DELETE /api/admin/agents*`（含 settings/payout/bind/reset/rotate） | super_admin |
| `POST /api/admin/agent-settlements/:id/pay|reject` | finance \| super_admin |
| `POST /api/admin/agents/:id/adjustments` | super_admin |
| `POST /api/admin/agent-adjustments/:id/approve|reject` | super_admin（复核人 ≠ 请求人，服务层判） |
| `PUT /api/admin/config/agent.inviteEnabled`（**P4 之前的 fail-closed 规则**） | super_admin |
| 其余 viewer/operator | 403（显式负例） |

- **P4 编码绕过**：`PUT /api/admin/config/` 下（a）原值等于 `agent.inviteEnabled`，或（b）键段含 `%`（如 `agent%2EinviteEnabled`），或（c）解码后键以 `agent.` 开头 ⇒ **仅 super_admin**；三种变体都写负例。

- **路由声明序**：`reconciliation`/`audit`/`settings` 等字面路由必须写在 `@Get(':id')` **之前**。
- 所有写端点走 `XAdminGuard`（`X-Admin:1` + `X-Admin-Actor`）；audit。
- 收款/审计读口含 PII：仅 super_admin/finance，viewer/operator 403。

### 9.3 抽水可见性

- 代理门户不展示抽水。
- 管理后台沿用既有 `GET /api/admin/wallet/summary` 的 burn 块（`burned_rake`/`burned_residue`）。
- Grafana 沿用现有营收面板；如缺 rake 面板，补一个只读面板（不改账本）。

---

## 10. 客户端

- 注册页（`apps/client/src/pages/login/login.vue`）注册态增加**可选**「邀请码」输入：
  - 仅当 `config.agentInviteEnabled === true` 时渲染；
  - ⚠️ **2026-10-26 r3 代码审 Critical #1 订正**：原方案「注册态懒拉 `GET /api/config`」**永远失败**——该路径需玩家令牌，新用户没有 ⇒ 字段永不出现。改为登录前拉**公开启动面** `GET /api/config/boot`（网关 `PUBLIC_PATHS` 第 6 条精确条目，只回 `{version, agentInviteEnabled}` 两键）；失败 ⇒ 仍不渲染、注册照常；
  - trim + uppercase；空 ⇒ 不发字段；
  - `AGENT_INVITE_INVALID` ⇒ 展示「邀请码无效，请确认后重试」；其它错误沿用既有文案。
- `net/rest.ts` `register(phone, password, nickname, inviteCode?)`；`stores/auth.ts` `signUp` 透传。
- 客户端配置类型/存储增加 `agentInviteEnabled`；启动面只写该开关，**不**冒充全量配置（不写 `clientConfigVersion`）。
- 老客户端不带该字段 ⇒ 服务端正常注册（未归属），不影响登录/对局。

---

## 11. 配置、错误码、RPC

### 11.1 新增配置键（1 个）

| 键 | 类型 | 种子 | 客户端 |
|---|---|---|---|
| `agent.inviteEnabled` | 严格 boolean | false | 可见（裸名 `agentInviteEnabled`） |

- `parseConfigValue` 增加分支；`CLIENT_CONFIG_KEYS` 增加裸名；`ClientConfig` 接口增加 `agentInviteEnabled: boolean`；客户端配置控制器读 `agent.inviteEnabled ?? false`；客户端 `ClientConfigState`/`FAILSAFE_CLIENT_CONFIG`/`normalizeClientConfig` 同步补字段（缺省 false）。
- 计数闸：protocol 93→94、active 77→78、`verify:admin` IA 77→78、`CONFIG_CONTROLS` 72→73、`BOOL_KEYS` 35→36、`CONFIG_NOTES` 65→66。
- IA 放新「代理」域的 `switches` 页签；`CONFIG_CONTROLS` 加 `type:'bool'`。
- 写权限：网关字面路由 `PUT /api/admin/config/agent.inviteEnabled` → **super_admin**（先于 P4）。
- 迁移种子：`('agent.inviteEnabled','false',1,NOW(3),'seed')`。

### 11.2 新增错误码

| 码 | 名称 | HTTP | 用途 |
|---|---|---|---|
| 11006 | `AGENT_INVITE_INVALID` | 400 | 邀请码无效/停用/代理冻结/关闭期 |
| 11007 | `AGENT_FROZEN` | 403 | 冻结代理被禁止的动作（预留） |
| 14011 | `AGENT_SETTLEMENT_MIN` | 409 | 未达最低结算额 / 可结 ≤ 0 |
| 14012 | `AGENT_SETTLEMENT_PENDING` | 409 | 已有待处理结算单 |
| 14013 | `AGENT_SETTLEMENT_STATE` | 409 | 状态机非法转移/金额或 hash 复核失败 |
| 14014 | `AGENT_RATE_INVALID` | 400 | 比例/树不变量违反 |

- 更新 user/currency 两份 `http/errors.ts` 的 `HTTP_STATUS`；`errors.test.ts` 的 `SPEC_CODES`；`CLIENT_ACTION`；`docs/design.md §11.2`。

### 11.3 RPC

| pattern | 方向 | 载荷 |
|---|---|---|
| `agent.bind` | user → currency | `{ownerId, code, phone, source:'signup'}` → `{status:'bound'|'ignored'}` / `AGENT_INVITE_INVALID` |
| `user.nicknames.get` | currency → user（复用） | `{userIds[]}` → nicknames（≤50） |
| `user.agentProfile.get` | currency → user（新增） | `{userId}` → `{nickname, phone}`（管理补绑用；PII，仅内部） |

- 均走既有 RPC 信封（`RpcResult`）；业务错误不抛；传输故障 10007。
- currency → user 新边：`USER_SERVICE_RPC_HOST/PORT`（默认 `user-service/3101`）、3s、失败降级；compose 增加 env。

---

## 12. 观测、对账、告警

### 12.1 指标

- `agent_commission_entries_total{level}`、`agent_commission_micro_total`
- `agent_hook_failures_total{source}`、`agent_ledger_gaps_total`
- `agent_bind_failed_total`、`agent_bind_ignored_total`
- `agent_settlements_pending`（gauge）、`agent_settlements_paid_total`
- `agent_login_failures_total`、`agent_login_blocked_total`
- `agent_quota_admin_capped_total`、`agent_rate_order_violation_total`
- `agent_reconciliation_gap{kind}`（**gauge**，每次对账 set）

### 12.2 对账

- 每笔 entry_fee op（user owner，**且落在 `agent_settings_history` 的启用区间内**）：恰好一条 revenue event（bound/unbound/skipped）或一条 gap；启用前/关闭期不要求，避免假缺口。
- 逐行 `micro = base × paid_bp`；`base ≤ fee`；`0 ≤ Σmicro ≤ expected_max_micro`。
- 日对账：台费流水合计 vs revenue event `fee_amount` 合计；`fee = base + no-quota`；佣金微合计 vs 逐行重算。
- 管理端 `GET /api/admin/agent-reconciliation?from&to` 返回上述数字与差额；缺口 > 0 ⇒ gauge + error 日志。
- `enabled=false` 期间不产生新行，对账只看区间内。

### 12.3 财务三本账

1. 台费收入：`−Σ flows(source='entry_fee')`（按 op/日）。
2. 佣金：entry micro、manual micro、已结金币、已付现金（含汇率快照）；内部统一 micro。
3. 其他：`burned_rake + burned_residue`（ops 列）+ `card_counter`。
- 恒等式：`E = ΣT×10000 + C + U`；平台净台费 = 台费毛利 − E/10000（含 manual）。
- 报表同时展示金币与人民币（专用 `coin_per_yuan`），不混算。

---

## 13. 安全、隐私、合规

- **身份**：代理 JWT 独立 `aud/typ/ver`；网关验签后才注入 `x-agent-id`；所有路径先剥客户端伪造的同名头；currency `AgentGuard` 校验 `token_version`/`must_change_password`。
- **IDOR**：`agent_id` 只从 token 取；所有查询强制 `WHERE agent_id = token`；负例测试 A 查 B ⇒ 403/空。
- **管理端**：显式 P 条目（D20）；写端点 actor fail-closed；审计 before/after；viewer/operator 403 负例；收款/审计读口仅 super_admin/finance。
- **PII**：代理只看脱敏手机号；不返回余额/充值/提现；收款信息仅 super_admin 可改、门户脱敏；导出需权限。
- **密码**：scrypt + 随机盐（参数写死）；首登改密；登录限流/按手机号锁定；管理员重置一次性密码；重置递增 `token_version`。
- **HMAC**：`AGENT_PHONE_HMAC_KEY` 生产缺失 ⇒ 启动 fail-closed；v1 不轮换（文档写明）。
- **合规**：代理合同含回冲授权、数据保密、解约清算、税费承担；禁止代理经手玩家资金；替代凭证（签收单 + 银行流水）；留存期与删除请求的冲突按财务留存优先并登记。

---

## 14. 测试判据

### 14.1 性质测试（必须）

1. **级差逐行**：随机 `fee∈[1,8191]`、5 级内非增比例、随机冻结/自玩集合 ⇒ 每行 `micro=base×paid_bp`；`0 ≤ Σmicro ≤ base×topBp`；冻结/自玩只改分配对象；负级差不倒贴。
2. **小额累计**：`fee=1、rate=80%`，1 局 0 金币/8000 micro；5 局结算 4 金币。
3. **额度封闭**：包含「充值 1000 → 提现 1000 → 救助金付台费」⇒ 佣金 0；「充值→台费→赢钱→提现→再充值→台费」⇒ 佣金不被赢钱提现压低；退款/回滚对称；负出账不超过未消耗本金。
4. **幂等/重放**：同一 op 重放、钩子重跑、扫描两遍 ⇒ 恰好 1 revenue event + 1 组佣金行。
5. **归属时点**：fee 在改绑/改率/冻结之前 ⇒ 旧代理/旧比例/按当时状态；反向亦然（**写时钩子，不是事后扫描**）。
6. **结算水位/并发**：真 MySQL 双会话同时申请 ⇒ 恰好 1 张单；水位互斥；驳回不推进水位；打款 hash/金额复核；pending 期间新行不进本单；pending 期同 `client_request_id` 重试 ⇒ 返回原单；「低 id 晚提交」⇒ 409 + 撤回重申请恢复。
7. **鉴权交叉**：代理 token 调玩家/管理端点 ⇒ 401；玩家 token 调代理 ⇒ 401；A 查 B ⇒ 403/空；viewer/operator 查代理 GET ⇒ 403；`must_change_password` 只放行 me/password；重置后旧 token 失效。
8. **故障隔离**：注入语句级失败钩子 ⇒ 台费 apply 成功、无免单、gap + 指标；注入 1213/1205 ⇒ apply 失败（不空提交）；额度行首建并发不死锁。
9. **树/比例不变量**：随机 reparent/改率 ⇒ `parent ≥ self ≥ max(child)` 或拒绝；无环；深度 ≤ 5；重复 agent 硬告警。
10. **开关/生效时点**：`enabled` × `inviteEnabled` 2×2；`effective_from` 之前的 op 不产生任何行；`enabled=1 && effective_from IS NULL` ⇒ 不生效。
11. **配置闸**：`CONFIG_KEYS` 恰 94、`CLIENT_CONFIG_KEYS` 恰 22、`verify:admin` IA 78 / CONTROLS 73 / BOOL 36 / NOTES 66；`errors.test.ts` SPEC_CODES 与 `CLIENT_ACTION` 全量。
12. **财务对账**：模拟一天，`E = ΣT×10000 + C + U`；每笔启用区间内的 entry_fee op 有 revenue event（含 unbound/skipped）或 gap；`fee = base + no-quota`；已付 ≤ 已结金币；关闭期 op 不计缺口。

### 14.2 真 MySQL / conformance

- 新增 `tools/conformance/src/slices/slice-30-agent.ts`：死锁注入（额度首建并发）、保存点回滚后主事务、水位结算双会话、驳回/打款/复核、配置计数。
- 假 DB 只能钉控制流；**不得**用它声称原子性。Docker 未跑时在交付报告里明说。

### 14.3 命令

- `pnpm -C packages/protocol test`
- `pnpm -C packages/currency-service test && pnpm -C packages/currency-service run lint`
- `pnpm -C packages/user-service test && pnpm -C packages/user-service run lint`
- `pnpm -C packages/config-service test`
- `pnpm -C packages/api-gateway test && pnpm -C packages/api-gateway run lint`
- `pnpm -C apps/client test && pnpm -C apps/client run lint`
- `pnpm verify:admin`
- 真栈 slice-30（需 Docker）。

---

## 15. 上线与回滚

1. 迁移（currency `1797000000000-AgentDomain.ts`；config 用另一时间戳）→ 所有服务部署。
2. `agent_settings.enabled=false`、`agent.inviteEnabled=false`（暗上线）。
3. 后台建测试代理 → 设比例 → 发码 → 测试玩家注册 → 打一局 → 看佣金/额度 → 申请/打款/驳回全链。
4. 开 `enabled`（写 `effective_from`）→ 开 `inviteEnabled` → 客户端硬刷新。
5. 观测：`agent_hook_failures_total=0`、`agent_ledger_gaps_total=0`、对账缺口 0、结算队列正常。
6. 回滚：`enabled=false`（停新增；存量可结）；`inviteEnabled=false`（隐藏字段）；不删表、不逆向已计提；错账走人工调账 + 应收台账。
- **不新增容器**；edge 只加静态路由；无新增端口；currency→user 新增内部 RPC 边。

---

## 16. 涉及文件

- `packages/protocol/src/config.ts`、`config.test.ts`、`errors.ts`、`errors.test.ts`、`rpc.ts`、`messages.test.ts`、`index.ts`
- `apps/client/src/net/copy.ts`、`src/stores/game.ts`、`src/composables/useClientConfig.ts`
- `packages/currency-service/src/agent/**`（新模块：ledger/math/accounts/bindings/settlements/portal/admin/auth/settings/metrics）、`apply/apply.service.ts`、`rpc/rpc.module.ts`、`app.module.ts`、`migrations/1797000000000-AgentDomain.ts`、`http/errors.ts`、`config/config-cache.service.ts`（如需）、`package.json`（jsonwebtoken）、测试
- `packages/user-service/src/users/users.dto.ts`、`auth/auth.service.ts`、`auth/auth.module.ts`、`currency/currency.client.ts`、`rpc/user-agent-profile.rpc.controller.ts`（新）、`app.module.ts`、`http/errors.ts`、测试
- `packages/api-gateway/src/auth/agent.middleware.ts`（新）、`auth/jwt.middleware.ts`、`auth/public-paths.ts`、`auth/identity-headers.ts`、`auth/admin-policy.ts`、`http/http-rate-limit.middleware.ts`、`http/rate-limit.ts`、`gateway/gateway.controller.ts`、`gateway/proxy.gateway.ts`、`app.module.ts`、测试
- `packages/config-service/src/config/client-config.controller.ts`、`migrations/<ts>-AgentInviteKey.ts`、`test/migration.test.ts`、`test/client-config.test.ts`、`test/platform-config.service.test.ts`、`admin/app.js`（IA/controls/notes/CFG_NAV）、`admin/index.html`（代理配置叶锚点）、`scripts/verify-admin-static.mjs`
- `admin/app.js`、`admin/index.html`、`admin/style.css`
- `agent/index.html`、`agent/app.js`、`agent/style.css`
- `apps/client/src/pages/login/login.vue`、`src/net/rest.ts`、`src/stores/auth.ts`、config 类型/存储、测试
- `Dockerfile.edge`、`deploy/Caddyfile`、`docker-compose.yml`（env：`AGENT_JWT_SECRET`、`AGENT_PHONE_HMAC_KEY`、`USER_SERVICE_RPC_HOST/PORT`）
- `tools/conformance/src/slices/slice-30-agent.ts`、`tools/conformance/src/run.ts`、`tools/conformance/baselines.json`
- `scripts/verify-agent-static.mjs`、根 `package.json`（`verify:agent` 脚本）
- `docs/design.md`（§11.2 错误码）
- `docs/superpowers/specs/2026-10-26-agent-commission-design.md`、`docs/superpowers/plans/2026-10-26-agent-commission.md`

---

## 17. 审查记录（r1 设计对抗审查）

审查方式：独立 reviewer 子代理，按「写边/额度/级差/归属/结算/财务/鉴权/落地/测试」九线攻击。报告为过程工件（`.superpowers/sdd/`，gitignored）。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 B1 | `Σmicro = base × topBp` 在冻结/顶层自玩下不成立 | 改为逐行 `micro=base×paid_bp` + `0 ≤ Σmicro ≤ base×topBp`；revenue event 存 `top_rate_bp`/`expected_max_micro`/`chain_json` |
| 阻断 B2 | SAVEPOINT 挡不住死锁/锁超时；空提交风险；额度首建 gap-lock | 额度原子 upsert；1213/1205/连接错误重抛；保存点回滚失败重抛；`agent_ledger_gaps` 独立连接；真库死锁测试 |
| 阻断 B3 | `JwtMiddleware` 未跳过 `/api/agent/*` | 新增 `AGENT_PREFIX`/`isAgentPath`，`jwt.middleware.ts` 照 admin 写法跳过玩家验签但剥身份头 |
| 阻断 B4 | 净入金对「赢钱后提现」路径相关，永久压低佣金 | 负出账只抵扣未消耗本金（`min(abs(delta), max(0, inflow−consumed))`） |
| 阻断 B5 | `pay.coinPerYuan` 可被 operator 改，结算放大 | 新增 `agent_settings.coin_per_yuan`（super_admin 专用、审计、结算快照） |
| 阻断 B6 | `admin_adjust` 无上限造币→佣金 | 正数单玩家单日额度上限（默认 50,000 币）+ 审计 + 指标；残余内部人风险登记 |
| 阻断 B7 | `x-agent-id` 转发管道缺失 | `DownstreamHeaders.agentId` + `headersOf` 路径限定 + `forward()` 映射 + 剥离/注入测试 |
| 阻断 B8 | `ApplyService` 在 `RpcModule`，AgentLedger 不在其可见面 | 新建 `AgentModule` 导出 `AgentLedgerService`，`RpcModule` imports 它；容器装配测试 |
| 高 H1 | 负级差兜底会降低 `lastPaidBp` 导致倒贴 | 负级差 payout 0 且 `lastPaidBp=max(...)`；改率/重挂双向校验 + 锁 |
| 高 H2 | 冻结代理无法登录结算 | 冻结允许登录/只读/结算 |
| 高 H3 | 两个开关无矩阵 | 绑定要求两个都开；2×2 测试 |
| 高 H4 | 注册强依赖 + bind 失败系统性未归属 | 改为一次 `agent.bind`（含开关/码/状态重校验），fail-closed；孤儿绑定登记 |
| 高 H5 | 管理员补绑无手机号来源 | 新增 `user.agentProfile.get`；`phone_hash NOT NULL` |
| 高 H6 | HMAC key 缺失/轮换 | 生产缺失启动 fail-closed；v1 不轮换（文档） |
| 高 H7 | `client_request_id` 全局唯一/跨代理泄露 | `UNIQUE(agent_id, client_request_id)`；查询强制 agent 作用域 |
| 高 H8 | `items_hash` 无算法/不复核 | 定义规范串；打款重算比对；佣金行只增不改 |
| 高 H9 | 退款/负调账无回收、负单无法结清 | 负出账上限避免负额度；外部拒付/退出坏账走应收台账 + 合同授权 |
| 高 H10 | `effective_from` 口径矛盾 | 统一 `op.created_at`；`enabled=1 && effective_from IS NULL` 不生效 |
| 高 H11 | 未绑定与失败不可区分 | 每笔 entry_fee 写 revenue event（含 unbound/skipped）；缺行=gap |
| 高 H12 | settings 缓存多副本失效 | 不缓存，每笔同事务读 settings 行 |
| 高 H13 | `quota_hold_days` 语义未定义 | 持有期内 base=0、不递延；到期循环 `SKIP LOCKED` |
| 高 H14 | 新错误码未进 HTTP 映射/测试 | 两份 `http/errors.ts` + `SPEC_CODES` + `CLIENT_ACTION` + design.md |
| 高 H15 | `parseConfigValue` 无新键分支 | 加 strict boolean 分支 + 测试 |
| 高 H16 | `verify:admin` 计数不止 IA | 93/94、77/78、77/78、72/73、35/36、65/66 全部更新 |
| 高 H17 | `agent.inviteEnabled` 可被 operator 写 | 网关字面路由 `PUT …/agent.inviteEnabled` → super_admin（先于 P4） |
| 高 H18 | 管理路由顺序/P8 默认放行/PII | 字面路由先于 `:id`；显式 P 条目先于 P8；收款/审计仅 super_admin/finance |
| 高 H19 | 环/断链/重复 agent | 写侧拒绝；读侧 visited + 深度；重复 agent 硬告警 |
| 高 H20 | 并发轮换出两个 active 码 | 锁 agent 行 + 双会话测试 |
| 高 H21 | pending 期间调账/已付错账 | 本单冻结、调账进下一单；已付错账走应收台账 |
| 高 H22 | 财务单位混用 | 内部统一 micro；恒等式 `E=ΣT×10000+C+U`；RMB 用专用汇率 |
| 高 H23 | 昵称 RPC 边/搜索/局数口径 | 新增 currency→user 边 + compose env；v1 去搜索；局数=revenue event 数 |
| 高 H24 | 假 DB 无法证明并发 | 新增 slice-30 真 MySQL；改写 #1/#5/#12 |
| 高 H25 | 登录仅 IP 桶/重置后旧 token 仍可用/首登可绕过 | 按手机号锁定 + `token_version` + `AgentGuard` 服务端强制改密 |
| 高 H26 | 结算范围锁阻塞台费插入 | 改为 ID 水位，不锁佣金行；结算事务最短 |
| 高 H27 | 批量改绑单事务 5000 | 500/批、keyset、独立事务、目标 active、索引 |
| 低 13 条 | DDL/索引/bigint/迁移时间戳/settings 审计/gauge/公开路径语义/Caddy/依赖/手机号归一/管理端闸/单号/空收款 | 已并入 §3/§8/§9/§11/§15/§16 |

**结论**：阻断项全部处置；高风险项全部处置或登记；设计进入实现计划阶段。

### 17.1 计划对抗审查记录（r2）

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 Z1 | 任务 1 加 RPC pattern 会让 J21 门禁红 | RPC pattern 随各自接收侧任务同笔；`messages.test.ts` 同笔改 |
| 阻断 Z2 | 任务 4 `AgentModule` 导出尚不存在的 `AgentLedgerService` | 任务 4 先落 no-op 骨架，任务 5 填实现 |
| 阻断 Z3 | `ApplyService` 构造注入打爆 11 处 `new` 与精确 SQL 序列 | 构造参数必填 + 测试替身；按 source 闸门跳过无关源；FakeCurrencyDb 增补；SAVEPOINT 在 caller effect 之后 |
| 阻断 Z4 | 任务 6 改绑依赖任务 8 的 user client | user client + ClientsModule + env 提到任务 6 |
| 阻断 Z5 | `agent%2EinviteEnabled` 绕过 super_admin 闸 | P4 前加「字面/含 %/解码后 agent. 前缀」三路 super_admin + 变体负例 |
| 阻断 Z6 | 表数 14 vs 实际 16 | 统一为 17（含 `agent_settings_history`）并逐名断言 |
| 阻断 Z7 | `ClientConfig` 接口缺字段 | 任务 1 加 `agentInviteEnabled`；客户端 state/normalizer 同步 |
| 高 H1 | 结算幂等查重顺序 | 锁 agent → 同 request id 返回原单 → pending 校验 |
| 高 H2 | 低 id 晚提交卡 pending | 打款 SUM/hash 复核 + 409 恢复路径（撤回重申请）+ slice 用例 |
| 高 H3 | 列默认值缺失 | `NOT NULL DEFAULT 0/1`；迁移测试逐列断言 |
| 高 H4 | bigint 读回字符串 | 全部经 `toSafeInt` + 假 DB 字符串用例 |
| 高 H5 | 关闭期对账假缺口 | `agent_settings_history` 启用区间；只统计区间内 |
| 高 H6 | currency `http/errors.ts` 漏映射 | 任务 8/9 补 6 码 + 逐码测试 |
| 高 H7 | AgentModule 缺 ConfigModule/新 RPC 装配 | `imports [ConfigModule]` + ClientsModule + 装配测试 |
| 高 H8 | JWT 依赖/lockfile | 用 `@nestjs/jwt`；`pnpm install` 同笔更新 lockfile |
| 高 H9 | 密钥链两侧不同形 | 逐字常量 + 跨服务源码闸 + production fail-closed |
| 高 H10 | compose env 无任务 | 新增依赖/env 任务（gateway/currency 两处） |
| 高 H11 | 客户端 6 码文案 | 任务 1 补 `net/copy.ts` + 逐码断言 |
| 高 H12 | 登录页无配置来源 | 注册态懒拉**公开** `GET /api/config/boot`（r3 审订正：原 `/api/config` 需令牌，新用户永远拉不到），失败不渲染不阻塞 + 用例 |
| 高 H13 | config 测试/CFG_NAV 漏改 | 任务 2 补 `platform-config.service.test.ts`、`admin/index.html`、`CFG_NAV` + verifier 自证 |
| 高 H14 | conformance 无 run/baseline | 任务 15 补 `run.ts` + `baselines.json`（CI 回填） |
| 高 H15 | 「零查询」矛盾/无 opCreatedAt | 改为「一次 settings 读」；钩子读 `currency_ops.created_at` |
| 高 H16 | 应收台账无表 | v1 明确不做（线下应收，后台显示负余额） |
| 高 H17 | 手机号归一/HMAC fail-closed | `normalizePhone=trim+数字归一`（r3 代码审订正：trim-only 可被 `+86`/分隔符变体绕过自玩特判）唯一实现；`main.ts` production fail-closed + 源码闸 |
| 低 10 条 | 登录页 4 框锚点、PUBLIC_PATHS 5 条、重试丢码、单号生成、bind 状态、VIEW_ORDER/锚点、文档/脚本、N+1、gap 假 DB、maturity 注册 | 已并入计划任务与测试判据 |

**结论**：计划修订后开工；每一任务独立 commit，先红后绿。

### 17.2 代码对抗审查记录（r3，2026-10-26）

审查方式：两个**独立** reviewer 子代理（后端/数据面、前端/edge 面），审 `12f29c9d..HEAD`（任务 0–15 全部提交），对照 spec/plan 逐条攻击；Critical/Important 必须修。

| 级别 | 发现 | 处置 |
|---|---|---|
| Critical C1 | 注册页懒拉 `GET /api/config` 需玩家令牌 ⇒ **新用户永远看不到邀请码输入框**（任务 12 对目标人群失效；测试直接 patch store 造成假绿） | 新增**公开**启动面 `GET /api/config/boot`（只回 `{version, agentInviteEnabled}`）：config-service `@Get('boot')`、网关精确路由、`PUBLIC_PATHS` 第 6 条、`CLIENT_CONFIG_PATHS` 同步；客户端 `refreshInviteBootConfig()` 只落开关（不冒充全量配置）；单测 + slice-30 无令牌断言 |
| Critical C2 | 管理页详情响应乱序：先点 A 再点 B，A 后到会覆盖 B 的面板，而「保存资料」只认点击序 ⇒ **把 A 的资料/收款写进 B** | `openAgentDetail` await 后复核 `detailId`；`saveAgentDetail` 以**当前渲染的** `detail.account.id` 为准 |
| Important B1 | `buildEnabledPeriods` 用全局 `effective_from` 开新启用段 ⇒ 关→开后区间回卷覆盖关闭窗口（幻影缺口/重复计数）；单测编码了错行为 | 每段从该行 `changed_at` 起；单测改为 `{T0,T1},{T2,T3}` |
| Important B2 | `normalizePhone` 仅 trim ⇒ `+86`/分隔符/全角变体绕过「自玩不拿佣金」 | 扩为数字归一（全角→半角、去非数字、去 `86`/`0086` 前缀；须 `^1\d{10}$` 否则保留 trim 原值）；新增 `agent-phone.test.ts` 六例（含 HMAC 变体相等） |
| Important I1 | 结算队列/调账列表写死 `page=0&pageSize=50` 无翻页 ⇒ pending >50 时财务不可达 | 两侧补上一页/下一页 + 页码；结算默认筛选 `pending`；状态切换回第 1 页 |
| Minor（已修） | 设置项无逐键上下界；`rateBp` 把 null/`''`/`[]` 静默转 0；昵称 RPC 截断 50 vs 门户一页 100；负 carry 使 `unsettledCoins` 显示 -1；批量改绑只在开始时校验目标 active；门户改密长度 10–72 与服务端 6–64 不一致；`verify:agent` 的「首次登录」可被注释满足；`verify:agent` 未接 CI；详情上级下拉含冻结代理；比例 `step=1` 导致非整百分比预填无法提交；树旧快照可能误摘上级 | 全部修复：逐键 bounds（`defaultRateBp≤10000`/`coinPerYuan≥1`/`quotaHoldDays≤365`）；`rateBpOf()` 仅收整数/非空数字串；昵称按 50 分批；`Math.max(0,…)`；每批复核目标 active；门户改 6–64；verifier 改函数体断言 + `showScreen('change')`；`ci.sh` 第 7 阶段加 `verify:agent`；下拉只列 active（保留当前上级回显）；比例 step 0.01；当前上级不在下拉则不提交 `parentId` |
| Minor（登记） | 详情绑定玩家只取前 50 无翻页（批量改绑兜底）；门户 token 存 localStorage（本页零 HTML 注入，作为可接受加固项） | 登记入交付报告已知边界；后续可补 |
| slice-30 观察 | 并发组无 barrier（可能串行通过）；低 id 构造用「删行+显式插回」等价最终态 | 注释已写明构造；并发组保留（两连接同时发起，服务端调度即真实并发）；低 id 行改为与删除行**同额**，不再留 +1 micro 偏差 |

**结论**：Critical/Important 全部修复并补测；Minor 修复 10 项、登记 2 项。

---

## 18. 待用户过目

- 本 v1.1 是否认可（尤其 D4 的「负出账只抵扣未消耗本金」与 D17 的专用结算汇率）。
- 认可后进入实现计划（`docs/superpowers/plans/2026-10-26-agent-commission.md`）与计划对抗审查。
