# 代理分润（台费佣金）—— 设计 v1.0

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-26 起草 |
| 状态 | 草案；待独立对抗审查（dev-process §3） |
| 用户裁决 | ①注册填邀请码绑定 + 管理员审计改绑 ②级差制、平台统一建树 ③只分台费，抽水不分佣 ④计佣口径 = 净入金（运营加减币计入） ⑤每个代理单独约定比例，有默认值 ⑥自玩只保留「同手机号」特判 ⑦按需结算、只结自己 ⑧代理不看抽水，管理后台/Grafana 看 ⑨暗上线默认关 ⑩生效时点不回溯 |
| 上游真源 | `rooms.start.ts` 台费块 · `currency_ops/currency_flows` · `apply.service.ts` 唯一写边 · `withdrawable.service.ts` 6 源 · `auth.service.ts` 注册 · `admin-policy.ts` 管理策略 |

---

## 0. 背景与目标

### 0.1 现状（实现前已核实）

1. **台费**：金币场每局开局成功后，逐真人一条 `currency.apply`：`source='entry_fee'`、`actionId='entryfee:<房号>:<ownerId>'`、`refId=<房号>`、`entries=[{ownerId, delta:-fee}]`。金额 `entryFeeOf = percent>0 ? max(1, floor(baseScore×percent/100)) : 0`；`baseScore ≤ 8191`、`entryFeePercent 0–100` ⇒ 单笔 ≤ 8191。斗地主与跑得快共用；机器人免收；免费场/好友房无台费。
2. **账本**：`currency_ops`（幂等锚 `uk_action_id`）/ `currency_flows`（只增不改）/ `currency_accounts`；`apply.service.ts` 是唯一写边，`applyWithEffect` 在 flows 之后、commit 之前执行可选 effect（抛错整批回滚；**RPC 默认不经过 effect**）。
3. **资金用途**：可提现 6 源 = `recharge/game_settle/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback`；`cap_raw = max(0, min(cap_raw, balance))`。台费、记牌器、赠送、救助、`admin_adjust` 不可提现。
4. **退款/提现**：`refund_hold` / `withdraw_hold` 是实际扣币（负 delta）；驳回走 `refund_rollback` / `withdraw_rollback`（正 delta）；**已成功退款没有反向撤销路径**。
5. **冲正**：`admin_reverse` 只能冲正 `admin_adjust`（`admin-finance.controller.ts` 明确 `source !== 'admin_adjust'` ⇒ 409），不能冲台费/充值。
6. **注册**：手机号 + 密码 + 昵称；先发 `signup_grant` 再落库；没有任何邀请码/归属字段。
7. **管理端**：单页 `admin/app.js`；四角色 `super_admin/finance/operator/viewer`；policy 显式枚举，**未登记的 GET 默认落 P8（任意已认证角色）**，未登记的写端点落 P9 全拒。
8. **玩家 JWT**：只签 `{sub, phone, jti, typ}`，**不校验 `aud`**；管理令牌才钉 `aud:'ftl-admin'`。
9. **配置**：`CONFIG_KEYS` 恰 93 键、`CLIENT_CONFIG_KEYS` 恰 21 键；`config.test.ts` 与 `verify-admin-static.mjs` 有精确计数闸。

### 0.2 目标与成功判据

- 平台可在后台建代理树、发邀请码；玩家注册填码即永久归属；管理员可审计改绑（只影响未来）。
- 代理按其名下玩家**实际支付的台费**拿级差佣金；抽水/残差/记牌器/充值全部归平台。
- 计佣口径为**净入金**：充值 + 运营加减币 + 各类回滚 − 退款 − 提现；赠送/救助/广告/赢钱不计。
- 代理在独立门户查看自己名下玩家、台费贡献、剩余额度、佣金、结算单；上级只看整棵下线汇总。
- 佣金逐笔固化、万分位累计、按需结算、线下打款、全程可审计。
- 代理模块任何故障**不得**阻断台费/充值/退款/提现；`agent.enabled=false` 时对既有链路零影响。

### 0.3 明确不做

- ❌ 抽水分成、按座位抽水持久化（代理不看；管理后台/Grafana 用既有 `burned_rake` 汇总）。
- ❌ 代理自助发展下级、代理钱包、代理自助提现、自动打款。
- ❌ 逐币溯源（FIFO 批次账）；不做按「输给他人/记牌器」扣额度（登记为残余风险）。
- ❌ 代理实名/发票/个税代扣的系统实现；只存收款信息快照与替代凭证。
- ❌ 代理排行榜、代理绩效升降级、代理合同电子签署。

---

## 1. 决策表

| # | 决策 | 内容 |
|---|---|---|
| D1 | 归属 | 注册填邀请码即绑定，永久；管理员可审计改绑/解绑，只影响之后产生的佣金；保留绑定历史 |
| D2 | 层级 | 级差制；平台在管理后台建树；默认最多 5 级；强制「上级比例 ≥ 下级比例」，禁止环 |
| D3 | 分成基数 | 只分台费（`entry_fee` 实际收取金额）；抽水/残差/记牌器/充值归平台 |
| D4 | 计佣口径 | **净入金额度** = 充值 + `admin_adjust` + `admin_reverse` + `refund_rollback` + `withdraw_rollback` − `refund_hold` − `withdraw_hold`；赠送/救助/广告/赢钱/记牌器不计；台费逐笔消耗额度 |
| D5 | 比例 | 每代理一个比例（内部 bp，UI 整数百分比，0–100）；新建时取 settings 默认值；改比例只影响之后的台费；每笔按发生时链上比例固化 |
| D6 | 自玩 | 玩家手机号 = 链条中某代理手机号 ⇒ 该代理份额 0 且**不推进档位**（顺延给上一级；无上级归平台）；冻结 ⇒ 份额 0 且**推进档位**（份额归平台）；优先级冻结 > 自玩；第二个手机号/家人号/换号一律正常计佣 |
| D7 | 结算 | 代理在门户发起，只结自己；一代理同时只能有一张 pending 单；按 `max(entry_id)` 水位锁未结行；金额申请时快照；财务审核 → 线下打款 → 回填凭证；驳回/撤回只释放本单条目；已打款不可改单 |
| D8 | 代理账号 | 平台创建（手机号 + 初始密码），独立于玩家/管理员；门户 `/agent`，手机优先；独立 JWT `aud:'ftl-agent'` + `typ:'agent-access'`；首登强制改密；管理员重置；收款信息仅管理员可改 |
| D9 | 可见性 | 代理：自己名下玩家（昵称、脱敏手机号、注册时间、局数、台费贡献、剩余额度、佣金）+ 自己的佣金/结算单；上级：整棵下线汇总（人数、台费、自己的级差），不看下级玩家身份/金额；代理不看抽水 |
| D10 | 状态 | `active/frozen`；冻结停止新增自己的佣金、禁止新绑定，存量佣金仍可结算；份额归平台，上级级差照常；不可删除，可解冻 |
| D11 | 暗上线 | `agent_settings.enabled` 默认 false，super_admin 专用端点开关；客户端邀请码开关 `agent.inviteEnabled` 默认 false；关闭期不绑定、不计额度、不计佣 |
| D12 | 范围 | 金币场台费；斗地主 + 跑得快；机器人/免费场/好友房天然无台费 |
| D13 | 保留 | 佣金/结算/绑定/比例/状态历史永久保留；改绑、改比例、冻结都不追溯改写历史 |
| D14 | 故障隔离 | 代理记账作为 `ApplyService.applyWithEffect` 内置钩子，`SAVEPOINT` 隔离；失败只记日志/指标/对账缺口，主事务照常提交 |
| D15 | 舍入 | 佣金内部以 1/10000 金币（micro）累计；每级 `micro = base × paid_bp`；结算 `floor((carry + Σmicro)/10000)` 转金币，零头结转 |
| D16 | 生效时点 | `agent_settings.effective_from` 设为上线时刻（DB 时钟）；只处理 `created_at >= effective_from` 的 op；永不回溯；老客户端无邀请码正常注册，未归属注册单独统计 |
| D17 | 财务 | 三本账：台费收入（flows）/ 佣金（计提-已结-已付）/ 其他收入（`burned_rake + burned_residue + card_counter`）；佣金是负债，打款是现金；汇率快照只做展示 |
| D18 | 对账 | 每笔 op 的各级 micro 之和 = base × 顶层 bp；日对账「台费流水 vs 佣金基数 vs 佣金行」；缺口 > 0 告警 |
| D19 | 人工调账 | 允许；super_admin 发起 + **另一名** super_admin 复核；单笔/单日限额；写原因；全程审计；调的是代理未结佣金，不动玩家钱包/额度 |
| D20 | 权限 | 代理管理/比例/状态/改绑/收款/调账 = super_admin；结算队列/打款/驳回 = finance 或 super_admin；代理侧全部读口 = super_admin 或 finance；viewer/operator 一律 403 |
| D21 | 隐私 | 手机号脱敏（前 3 后 4）；不返回玩家余额/充值/提现明细；IDOR 负例：`agent_id` 只从 token 取 |
| D22 | 合规 | 代理合同（回冲授权/数据保密/解约清算/税费承担）；收款信息加密或受限访问；禁止代理经手玩家资金；替代凭证（签收单 + 银行流水） |

---

## 2. 资金模型

### 2.1 术语

- **计佣基数（base）**：一笔台费中「有资格计佣」的部分，`base = min(fee, max(0, inflow_total − consumed_total))`。
- **额度（quota）**：玩家终身可计佣上限，按 D4 的净入金累计；`available = max(0, inflow_total − consumed_total)`。
- **micro**：1/10000 金币；`rate_bp = percent × 100`（80% ⇒ 8000）。
- **级差**：从直接代理向上走，`paid_bp = r_i − lastPaidBp`；`lastPaidBp` 初始 0。
- **carry**：代理级零头，per-agent，结算打款时更新。

### 2.2 额度来源矩阵

| source | 对额度 | 说明 |
|---|---|---|
| `recharge` | +delta | 充值到账 |
| `admin_adjust` | +delta | 运营加/减币（需 D19 之外的单笔/日限额与审计） |
| `admin_reverse` | +delta | 只能冲正 `admin_adjust`，delta 即反向 |
| `refund_hold` | +delta（负） | 退款实际扣币 |
| `refund_rollback` | +delta（正） | 退款驳回回滚 |
| `withdraw_hold` | +delta（负） | 提现冻结扣币 |
| `withdraw_rollback` | +delta（正） | 提现驳回回滚 |
| `entry_fee` | 0 | 走 base 消耗，不直接改 inflow |
| `game_settle` / `relief_grant` / `signup_grant` / `robot_pool` / `card_counter` | 0 | 赢钱/赠送/救助/机器人/记牌器不计 |

**纪律**：`CURRENCY_SOURCES` 的 13 个值必须有显式分类；新增 source 时若未分类，单测红（防「新 source 静默计入额度」）。

### 2.3 级差算法（逐字）

```
chain = [direct(level 0), parent(level 1), ..., root]
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
  if payoutBp < 0:                        # 数据损坏兜底
      payoutBp = 0; log.warn()
  lastPaidBp = agent.rateBp
  micro = base * payoutBp
  if micro > 0: insert commission(agent, level, rateBp, paidBp, micro)
平台留存 = base − Σ(micro)/10000
```

- **不变量**：`Σ micro = base × topRateBp`（顶层份额；冻结/自玩只改变分配对象，不改变总额）。
- **示例**：台费 1、直接 60%、上级 80%、再上级 90%。直接 `0.6`、上级 `0.2`、再上级 `0.1`、平台 `0.1`；micro 累计后 5 局分别为 3/1/0.5/0.5 金币。
- **示例（自玩）**：直接代理本人是玩家 ⇒ 直接 0；上级拿 `80%`（不是 `20%`）；再上级拿 `10%`；平台 `10%`。
- **示例（冻结）**：直接代理冻结 ⇒ 直接 0；上级拿 `20%`；再上级拿 `10%`；平台 `70%`。

### 2.4 额度更新时序

- 每笔 qualifying op 在**同一事务**内更新 `agent_player_quota.inflow_total`。
- 台费 op：读绑定 → 读 agent 链 → 读额度行（`FOR UPDATE`）→ 计算 base → `consumed_total += base` → 写 revenue event → 写佣金行。
- 额度可因退款/提现变为「负余额」（`inflow_total < consumed_total`）；`available = 0`，后续入金先抵扣。
- `quota_hold_days > 0` 时，入金先写 `agent_quota_inflows`（`matures_at = now + hold`），到期由后台循环并入 `inflow_total`；默认 0 ⇒ 立即入账。

---

## 3. 数据模型（currency-service 新表）

> 迁移类名 **不得** 以 `Currency` 开头（`migration.test.ts` 按 `/^Currency\d+$/` 取首个匹配，会抢位）。文件名 `<ts>-AgentDomain.ts`。

### 3.1 `agent_settings`（单行 id=1）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | tinyint PK | 恒 1 |
| `enabled` | tinyint(1) | 总开关（默认 0） |
| `effective_from` | datetime(3) NULL | 上线时刻；NULL = 未启用 |
| `default_rate_bp` | int | 新建代理默认比例（0–10000，默认 0） |
| `min_settlement_yuan` | int | 最低结算额（元，默认 100） |
| `quota_hold_days` | int | 额度成熟天数（0–365，默认 0） |
| `adjust_max_yuan_per_op` | int | 单笔人工调账上限（元，默认 10000） |
| `adjust_max_yuan_per_day` | int | 单代理单日调账上限（元，默认 20000） |
| `updated_at` | datetime(3) | |
| `updated_by` | varchar(50) | 管理员用户名 |

### 3.2 `agent_accounts`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | varchar(40) PK | `ag_` + uuid |
| `name` | varchar(50) | 代理名 |
| `phone` | varchar(20) UNIQUE | 登录手机号；与玩家同号触发自玩特判 |
| `password_hash` | varchar(255) | scrypt `s1$N$r$p$salt$hash` |
| `parent_id` | varchar(40) NULL | 上级；自引用 |
| `rate_bp` | int | 当前比例 0–10000 |
| `region` | varchar(50) NULL | 片区（自由文本） |
| `contact_name` | varchar(50) NULL | 联系人 |
| `payout_name` / `payout_account` / `payout_bank` | varchar(100) | 收款信息快照源 |
| `status` | varchar(10) | active/frozen |
| `must_change_password` | tinyint(1) | 首登/重置后强制改密 |
| `micro_carry` | bigint | 零头结转（0–9999 在稳态） |
| `pending_settlement_id` | bigint NULL | 一代理一 pending 的快速闸 |
| `created_at` / `updated_at` | datetime(3) | |

索引：`uk_agent_phone(phone)`、`idx_agent_parent(parent_id)`、`idx_agent_status(status)`。

### 3.3 `agent_invite_codes`

`code varchar(16) PK`、`agent_id varchar(40)`、`status varchar(10)`（active/revoked）、`created_at`。
一代理同时只有一枚 active（服务层事务保证；轮换 = 旧行 revoked + 新行 active）。

### 3.4 `agent_bindings` / `agent_binding_history`

- `agent_bindings`：`owner_id varchar(36) PK`、`agent_id`、`bound_at`、`source`（signup/admin）、`bound_by`、`phone_hash char(64)`（HMAC-SHA256，自玩判定）。
- `agent_binding_history`：`id bigint AI PK`、`owner_id`、`agent_id`、`action`（bind/rebind/unbind）、`actor`、`reason`、`created_at`；只增不改。

### 3.5 `agent_rates` / `agent_status_history`

- `agent_rates`：`id bigint AI PK`、`agent_id`、`rate_bp`、`actor`、`reason`、`created_at`。
- `agent_status_history`：`id bigint AI PK`、`agent_id`、`status`、`actor`、`reason`、`created_at`。

### 3.6 `agent_player_quota`

`owner_id varchar(36) PK`、`inflow_total bigint`、`consumed_total bigint`、`updated_at datetime(3)`。
`available = max(0, inflow_total − consumed_total)`；行不存在 ⇒ 0。

### 3.7 `agent_quota_inflows`（仅 `quota_hold_days > 0`）

`id bigint AI PK`、`owner_id`、`source_op_id bigint UNIQUE`、`amount int`、`matures_at datetime(3)`、`matured_at datetime(3) NULL`。到期循环把 `amount` 并入 `inflow_total` 并写 `matured_at`。

### 3.8 `agent_revenue_events`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint AI PK | |
| `owner_id` | varchar(36) | 玩家 |
| `agent_id` | varchar(40) | 发生时的直接代理（改绑不追溯） |
| `source_op_id` | bigint | 台费 op |
| `fee_amount` | int | 毛台费 |
| `base_amount` | int | 计佣基数（≤ fee） |
| `quota_consumed` | int | 本次消耗额度 |
| `ref_id` | varchar(128) NULL | 房号 |
| `created_at` | datetime(3) | |

`UNIQUE(source_op_id, owner_id)`；索引 `(agent_id, created_at)`、`(owner_id, created_at)`。

### 3.9 `agent_commission_entries`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint AI PK | |
| `agent_id` | varchar(40) | 收佣代理 |
| `owner_id` | varchar(36) NULL | 玩家（manual 行可空） |
| `revenue_event_id` | bigint NULL | 台费来源行 |
| `source_op_id` | bigint NULL | 幂等：同一 op + agent 只一行 |
| `kind` | varchar(10) | entry/manual |
| `level` | int | 0 = 直接；1.. = 级差 |
| `rate_bp` / `paid_bp` | int | 代理比例 / 本次实付级差 |
| `commission_micro` | bigint | 可负（manual） |
| `settlement_id` | bigint NULL | 锁定/已结 |
| `reason` | varchar(255) NULL | manual 原因 |
| `created_at` | datetime(3) | |

`UNIQUE(source_op_id, agent_id)`；索引 `(agent_id, settlement_id, id)`、`(owner_id, id)`、`(revenue_event_id)`。

### 3.10 `agent_settlements`

`id bigint AI PK`、`settlement_no varchar(32) UNIQUE`、`agent_id`、`client_request_id varchar(64) UNIQUE`、`status`（pending/paid/rejected/cancelled）、`total_micro bigint`、`total_coins int`、`carry_before bigint`、`carry_after bigint`、`coin_per_yuan int`、`payout_json json`、`min_yuan int`、`items_hash char(64)`、`requested_at`、`decided_at`、`decided_by`、`paid_at`、`paid_by`、`voucher_no varchar(64)`、`reject_reason varchar(255)`、`created_at`、`updated_at`。

索引：`(agent_id, status, id)`、`(status, id)`。

### 3.11 `agent_adjustments`

`id bigint AI PK`、`agent_id`、`delta_micro bigint`、`reason varchar(255)`、`status`（pending/approved/rejected）、`requested_by`、`approved_by`、`commission_entry_id bigint NULL`、`created_at`、`decided_at`。

### 3.12 `agent_admin_audit`

`id bigint AI PK`、`actor varchar(50)`、`action varchar(50)`、`target_type varchar(30)`、`target_id varchar(64)`、`before_json json NULL`、`after_json json NULL`、`reason varchar(255) NULL`、`created_at`。

---

## 4. 写边（ApplyService 内置钩子）

### 4.1 位置与隔离

- `ApplyService.applyWithEffect` 在调用方 effect 之后、commit 之前调用 `AgentLedgerService.onApply(manager, ctx)`。
- 若 `agent_settings.enabled=false` ⇒ 立即返回（零查询）。
- 钩子外层：
  ```
  SAVEPOINT agent_ledger
  try { onApply(); RELEASE SAVEPOINT agent_ledger }
  catch { ROLLBACK TO SAVEPOINT agent_ledger; RELEASE SAVEPOINT agent_ledger;
          logger.error(...); agentHookFailures.inc({source}) }
  ```
- **主事务照常提交**；代理故障只影响佣金/额度（平台少付，玩家无损）。
- 重放分支不执行钩子（原事务已提交）；`uk_action_id` + 佣金唯一键双保险。

### 4.2 onApply 逻辑

1. 读 settings（进程内缓存，管理端变更时失效）；`enabled=false` 或 `now < effective_from` ⇒ 返回。
2. 对每个 entry（只 `ownerType='user'`）：
   - `source` 在额度矩阵 ⇒ `upsert agent_player_quota`（`FOR UPDATE` 读当前行；`inflow_total += delta`；hold>0 时先写 inflow 行）。
   - `source='entry_fee'`：
     - 读 `agent_bindings`；无 ⇒ 跳过（不建 revenue event）。
     - `fee = abs(delta)`；`base = min(fee, max(0, inflow − consumed))`。
     - `consumed += base`（仅 base>0）。
     - `INSERT agent_revenue_events ... ON DUPLICATE KEY UPDATE id=id`（幂等）。
     - 走链、算级差、`INSERT agent_commission_entries ... ON DUPLICATE KEY UPDATE id=id`（每条 micro>0）。
3. 所有 SQL 走同一 `manager`；唯一键兜底；失败 ⇒ 保存点回滚 + 指标。

### 4.3 幂等与重放矩阵

| 场景 | 结果 |
|---|---|
| 台费 op 首次成功 | 1 revenue event + N 佣金行 |
| 台费 op 重试/重放（`replayed`） | 事务未重跑 ⇒ 0 新行 |
| 同一 op 钩子重跑（理论） | 唯一键 ⇒ 0 新行 |
| 12002/14002 冲突 | 原 op 已成功 ⇒ 钩子只在首次执行 |
| 免单（apply 失败） | 无 op ⇒ 无钩子 |
| 钩子抛错 | 保存点回滚；op 照常提交；缺口指标 +1；对账可查 |

---

## 5. 归属生命周期

### 5.1 邀请码

- 格式：8 字符 `[A-HJ-NP-Z2-9]`（去掉 I/O/0/1），大写；输入 trim + uppercase；唯一 PK。
- 一代理一 active 码；轮换 = 旧码 revoked + 新码 active（事务）。既有绑定不受影响。

### 5.2 注册绑定

1. `RegisterDto` 增加可选 `inviteCode`（trim/uppercase/长度 8/字符域）。
2. 若 `agent.inviteEnabled=false` ⇒ 忽略 code（不绑定，注册照常；日志 + `agent_bind_ignored_total`）。
3. 若 code 存在且开关开 ⇒ 调 `agent.validateCode` RPC：
   - 无效/停用/代理冻结 ⇒ `AGENT_INVITE_INVALID`（400），**不建用户、不发赠币**。
4. 发 `signup_grant`（既有）。
5. 落 `users` 行（既有）。
6. 调 `agent.bind` RPC（`ownerId, agentId, phone`）；失败 ⇒ 注册**不失败**，warn + `agent_bind_failed_total`，管理员可补绑。
   - 理由：归属不是钱；失败可恢复，阻断注册不可恢复。
7. 绑定写 `agent_bindings` + history；`phone_hash = HMAC-SHA256(phone, AGENT_PHONE_HMAC_KEY)`。

### 5.3 改绑/解绑/批量

- 管理员单玩家改绑/解绑：更新 `agent_bindings` + history + audit；只影响之后。
- 批量改绑：按源代理 → 目标代理，`dryRun` 返回将影响人数；上限 5000；事务内逐条更新 + history；audit。
- 代理冻结：禁止新绑定；既有绑定保留；不自动迁移。

### 5.4 effectiveFrom

- 首次启用时写 `effective_from = NOW(3)`（super_admin 端点，审计）；之后不再改。
- 钩子只处理 `op.created_at >= effective_from`；历史充值/台费一律不回溯。
- 关闭再开不重置。

---

## 6. 结算

### 6.1 状态机

```
(agent 申请) pending ──财务打款──> paid
                  ├──财务驳回──> rejected（释放条目）
                  └──代理撤回──> cancelled（释放条目）
```

- 一代理同时只能有一张 pending（`agent_accounts.pending_settlement_id` + 行锁）。
- 已 paid 不可改；错误走人工调账。

### 6.2 申请（事务）

1. Lock `agent_accounts` 行 `FOR UPDATE`；校验 `pending_settlement_id IS NULL`。
2. `client_request_id` 幂等：已存在 ⇒ 返回该单。
3. 读 `max_entry_id = MAX(id) WHERE agent_id=? AND settlement_id IS NULL`。
4. `INSERT agent_settlements`（status pending, carry_before=agent.micro_carry）。
5. `UPDATE agent_commission_entries SET settlement_id=? WHERE agent_id=? AND settlement_id IS NULL AND id<=max_entry_id`。
6. `SELECT SUM(commission_micro), COUNT(*), MIN(id), MAX(id) WHERE settlement_id=?`。
7. `total_coins = floor((carry_before + sum_micro)/10000)`；`total_coins <= 0` 或 `total_coins < min_yuan × coin_per_yuan` ⇒ 抛 `AGENT_SETTLEMENT_MIN`（事务回滚，条目解锁）。
8. `carry_after = carry_before + sum_micro − total_coins×10000`。
9. 快照 `coin_per_yuan = config.pay.coinPerYuan`、`payout_json`、`min_yuan`、`settlement_no`、`items_hash`。
10. `agent.pending_settlement_id = id`；commit。

### 6.3 打款（事务）

1. Lock settlement + agent 行；require status pending。
2. 校验 `agent.pending_settlement_id = id`、`agent.micro_carry = carry_before`（防并发/人工改 carry）。
3. `agent.micro_carry = carry_after`；`pending_settlement_id = NULL`。
4. status paid、paid_at/by、voucher_no；审计。
5. 条目保持 `settlement_id`（已结）。

### 6.4 驳回/撤回（事务）

- status rejected/cancelled；`UPDATE entries SET settlement_id=NULL WHERE settlement_id=?`；`pending_settlement_id=NULL`；不改进 carry；审计。

### 6.5 展示

- 结算单：total_coins、RMB 展示 = `floor(total_coins / coin_per_yuan × 100)/100`? 实际展示 `total_coins / coin_per_yuan` 保留 2 位（向下取整到分）；打款以合同/线下为准。
- 明细：level 0 按玩家聚合（昵称、脱敏手机号、局数、base、佣金）；level > 0 聚合为「下线级差」一行；manual 行单独列出。
- `items_hash` 用于事后证明未篡改。

---

## 7. 人工调账（D19）

- 发起：super_admin；`POST /api/admin/agents/:id/adjustments` `{deltaCoins, reason}`；校验非零、单笔 ≤ `adjust_max_yuan_per_op`、当日 pending+approved 合计 ≤ `adjust_max_yuan_per_day`；写 `agent_adjustments` pending + audit。
- 复核：另一名 super_admin；`POST /api/admin/agent-adjustments/:id/approve`；事务内插入 `agent_commission_entries(kind='manual', commission_micro=delta×10000)`，写 `commission_entry_id`；audit。请求人 == 复核人 ⇒ 403。
- 驳回：super_admin；写 reason；audit。
- 调账只影响代理未结佣金；不触碰玩家钱包/额度。

---

## 8. 代理门户

### 8.1 鉴权

- `POST /api/agent/login` `{phone, password}` → scrypt 校验、status active；JWT：
  - `secret = AGENT_JWT_SECRET || JWT_SECRET || dev 兜底`（与网关逐字同形）；
  - `{ sub: agentId, phone, typ: 'agent-access', aud: 'ftl-agent', jti }`；TTL 12h；无 refresh。
- 网关 `AgentAuthMiddleware`：
  - 所有路径先剥 `x-agent-id`；
  - `/api/agent/*` 除 login 外要求 Bearer；验签 `aud:'ftl-agent'`；claims 校验 `sub` 以 `ag_` 开头、`typ='agent-access'`；注入 `x-agent-id`。
  - 密码错误/锁定统一 401 `AGENT_LOGIN_FAILED`?（复用 BAD_CREDENTIALS 11002 也可；新增 11006 用于邀请码，登录失败复用 11002）。
- 登录桶：IP 5 次失败/5 分钟；成功清零；达界 429（检查先于口令比较）。
- 首登 `must_change_password=true` ⇒ 除 `GET /api/agent/me` 与 `POST /api/agent/password` 外一律 403。
- 管理员重置：`POST /api/admin/agents/:id/reset-password`（super_admin）→ 生成一次性初始密码，返回明文一次，置 `must_change_password`，audit。
- 收款信息：仅 super_admin 可改（`PATCH /api/admin/agents/:id/payout`），audit；门户只读脱敏。

### 8.2 页面/API

| 页面 | API | 内容 |
|---|---|---|
| 登录 | `POST /api/agent/login` | 手机号 + 密码 |
| 概览 | `GET /api/agent/overview` | 比例、邀请码、直接玩家数、活跃玩家数（30d）、台费贡献、计佣基数、累计/未结/已结/已付、carry、下线汇总（若有） |
| 玩家 | `GET /api/agent/players?page&pageSize&q` | 直接玩家：昵称、脱敏手机号、注册（绑定）时间、局数、台费贡献、剩余额度、佣金 |
| 佣金 | `GET /api/agent/commissions?page&pageSize` | 未结/已结明细；level 0 含玩家；level>0 聚合「下线级差」 |
| 结算 | `GET/POST /api/agent/settlements`、`GET /api/agent/settlements/:id`、`POST .../:id/cancel` | 申请、列表、详情、撤回 |
| 我的 | `GET /api/agent/me`、`POST /api/agent/password` | 资料、改密、邀请码、收款信息（脱敏） |

- 所有查询 `WHERE agent_id = token.agent_id`；**不接受** query/body 里的 agentId（IDOR 负例）。
- 昵称通过 `user.nicknames.get` RPC 批量取；失败降级显示 `—`，不 500。
- 手机号脱敏 `138****1234`；不返回玩家余额/充值/提现。

### 8.3 静态站

- `agent/index.html` / `agent/app.js` / `agent/style.css`；手机优先；`/agent/` 由 edge 静态服务。
- `Dockerfile.edge` 增加 `COPY agent /srv/agent`；`deploy/Caddyfile` 增加 `/agent` → `/agent/` 301 + `/agent/*` root `/srv`（照 `/admin` 的 handle 写法，必须在 catch-all 之前）。

---

## 9. 管理后台

### 9.1 页面

新增「代理」导航区，页签：

1. **代理树**：列表/树（名称、手机号、上级、比例、片区、状态、直接玩家数、未结合计）；新建/编辑（名称、手机号、上级、比例、片区、联系人、收款信息）；冻结/解冻；重置密码；轮换邀请码。
2. **玩家归属**：按代理看直接玩家；单玩家改绑/解绑；批量改绑（dry-run + 上限 + 审计）。
3. **结算队列**：pending 列表；详情（总额、金币、RMB、carry、收款快照、items_hash、明细）；打款（凭证号 + 备注）；驳回（原因）。
4. **调账**：发起（金额、原因）、待复核、复核/驳回；仅 super_admin。
5. **对账**：按日/区间显示台费毛利、计佣基数、佣金计提、已结、已付、平台净额、缺口；CSV（可选）。
6. **审计**：代理管理/比例/状态/改绑/调账/结算动作的 before/after。

### 9.2 网关 policy（显式、置于 P8 之前）

| 面 | 角色 |
|---|---|
| `GET /api/admin/agents*`、`GET /api/admin/agent-settlements*`、`GET /api/admin/agent-adjustments*` | super_admin \| finance |
| `POST/PATCH/DELETE /api/admin/agents*` | super_admin |
| `POST /api/admin/agent-settlements/:id/pay|reject` | finance \| super_admin |
| `POST /api/admin/agents/:id/adjustments` | super_admin |
| `POST /api/admin/agent-adjustments/:id/approve|reject` | super_admin（复核人 ≠ 请求人，服务层判） |
| 其余 viewer/operator | 403（显式负例） |

- 所有写端点走 `XAdminGuard`（`X-Admin:1` + `X-Admin-Actor`）；audit。
- **不得**依赖 P8 默认放行；每个前缀显式登记，且加 viewer/operator 403 负例。

### 9.3 抽水可见性

- 代理门户不展示抽水。
- 管理后台沿用既有 `GET /api/admin/wallet/summary` 的 burn 块（`burned_rake`/`burned_residue`）。
- Grafana 沿用现有营收面板；如缺 rake 面板，补一个只读面板（不改账本）。

---

## 10. 客户端

- 注册页（`apps/client/src/pages/login/login.vue`）注册态增加**可选**「邀请码」输入：
  - 仅当 `config.agentInviteEnabled === true` 时渲染；
  - trim + uppercase；空 ⇒ 不发字段；
  - 服务端 `AGENT_INVITE_INVALID` ⇒ 展示「邀请码无效，请确认后重试」；其它错误沿用既有文案。
- `net/rest.ts` `register(phone, password, nickname, inviteCode?)`；`stores/auth.ts` `signUp` 透传。
- 客户端配置类型/存储增加 `agentInviteEnabled`。
- 老客户端不带该字段 ⇒ 服务端正常注册（未归属），不影响登录/对局。

---

## 11. 配置与契约

### 11.1 新增配置键（1 个）

| 键 | 类型 | 种子 | 客户端 |
|---|---|---|---|
| `agent.inviteEnabled` | 严格 boolean | false | 可见（裸名 `agentInviteEnabled`） |

- `CONFIG_KEYS` 93 → 94；active 77 → 78；`CLIENT_CONFIG_KEYS` 21 → 22；`verify:admin` IA 77 → 78。
- 迁移种子：`('agent.inviteEnabled','false',1,NOW(3),'seed')`。
- 其余代理运行参数放 `agent_settings`（不走通用 config，避免 operator 改钱面）。

### 11.2 新增错误码

| 码 | 名称 | HTTP | 用途 |
|---|---|---|---|
| 11006 | `AGENT_INVITE_INVALID` | 400 | 邀请码无效/停用/代理冻结 |
| 11007 | `AGENT_FROZEN` | 403 | 代理端操作被冻结禁止（保留） |
| 14011 | `AGENT_SETTLEMENT_MIN` | 409 | 未达最低结算额 / 可结 ≤ 0 |
| 14012 | `AGENT_SETTLEMENT_PENDING` | 409 | 已有待处理结算单 |
| 14013 | `AGENT_SETTLEMENT_STATE` | 409 | 状态机非法转移 |
| 14014 | `AGENT_RATE_INVALID` | 400 | 比例/树不变量违反 |

### 11.3 RPC

| pattern | 方向 | 载荷 |
|---|---|---|
| `agent.validateCode` | user → currency | `{code}` → `{agentId, agentName}` / `AGENT_INVITE_INVALID` |
| `agent.bind` | user → currency | `{ownerId, agentId, phone, source:'signup'}` → `{bound:true}` |

- 均走既有 RPC 信封（`RpcResult`）；业务错误不抛；传输故障 10007。
- 用户昵称读边复用既有 `user.nicknames.get`（currency → user），失败降级。

---

## 12. 观测、对账、告警

### 12.1 指标

- `agent_commission_entries_total{level}`、`agent_commission_micro_total`
- `agent_hook_failures_total{source}`
- `agent_bind_failed_total`、`agent_bind_ignored_total`
- `agent_settlements_pending`、`agent_settlements_paid_total`
- `agent_login_failures_total`、`agent_login_blocked_total`
- `agent_quota_negative_total`、`agent_reconciliation_gap_total{kind}`

### 12.2 对账

- 每笔 revenue event：`Σ微 = base × 顶层 bp`（单测 + 日校验）。
- 日对账：绑定玩家的台费流水合计 vs revenue event `fee_amount` 合计；base 合计 vs 佣金微合计；缺口 > 0 ⇒ 指标 + error 日志。
- 管理端 `GET /api/admin/agents/reconciliation?from&to` 返回上述数字与差额。
- `agent_settings.enabled=false` 期间不产生新行，对账只看区间内。

### 12.3 财务三本账

1. 台费收入：`−Σ flows(source='entry_fee')`（按 op/日）。
2. 佣金：计提（`Σ commission_micro`/10000）、已结（settlement `total_coins`）、已付（paid）。
3. 其他：`burned_rake + burned_residue`（ops 列）+ `card_counter`。
- 平台净台费 = 台费收入 − 佣金计提；报表同时展示，不混金币/人民币。

---

## 13. 安全、隐私、合规

- **身份**：代理 JWT 独立 `aud/typ`；网关验签后才注入 `x-agent-id`；所有路径先剥客户端伪造的同名头。
- **IDOR**：`agent_id` 只从 token 取；所有查询强制 `WHERE agent_id = token`；负例测试 A 查 B ⇒ 403/空。
- **管理端**：显式 P 条目（D20）；写端点 actor fail-closed；审计 before/after；viewer/operator 403 负例。
- **PII**：代理只看脱敏手机号；不返回余额/充值/提现；收款信息仅 super_admin 可改、门户脱敏；导出需权限。
- **密码**：scrypt + 随机盐；首登改密；登录限流/锁定；管理员重置一次性密码。
- **合规**：代理合同含回冲授权、数据保密、解约清算、税费承担；禁止代理经手玩家资金；替代凭证（签收单 + 银行流水）；留存期与删除请求的冲突按财务留存优先并登记。

---

## 14. 测试判据

### 14.1 性质测试（必须）

1. **级差望远镜**：随机 `fee∈[1,8191]`、5 级内非增比例、随机冻结/自玩集合 ⇒ `Σmicro = fee × topBp`；每条 `≥0`；冻结/自玩只改分配对象。
2. **小额累计**：`fee=1、rate=80%`，1 局 0 金币/8000 micro；5 局结算 4 金币。
3. **额度封闭**：包含「充值 1000 → 提现 1000 → 救助金付台费」⇒ 佣金 0；退款/回滚对称。
4. **幂等/重放**：同一 op 重放、钩子重跑、扫描两遍 ⇒ 恰好 1 revenue event + 1 组佣金行。
5. **归属时点**：fee 在改绑/改率/冻结之前，扫描在后 ⇒ 旧代理/旧比例/按当时状态；反向亦然。
6. **结算并发**：真 MySQL 双会话同时申请 ⇒ 恰好 1 张单、条目互斥、`SUM(claimed)=单头`；驳回只释放本单。
7. **鉴权交叉**：代理 token 调玩家/管理端点 ⇒ 401；玩家 token 调代理 ⇒ 401；A 查 B ⇒ 403/空；viewer 查代理 GET ⇒ 403。
8. **故障隔离**：注入必失败钩子 ⇒ 台费 apply 成功、无免单、`agent_hook_failures_total` +1、op 有行。
9. **树/比例不变量**：随机 reparent/改率 ⇒ `parent ≥ child` 或拒绝；无环；深度 ≤ 5。
10. **开关/生效时点**：`enabled=false` 五面（注册/绑定/额度/佣金/门户）行为逐格断言；`effective_from` 之前的 op 不产生任何行。
11. **配置闸**：`CONFIG_KEYS` 恰 94、`CLIENT_CONFIG_KEYS` 恰 22、`verify:admin` IA 78。
12. **财务对账**：模拟一天，`Σ fee = base + 无额度部分`；`paid ≤ settled ≤ accrued`；每个 entry_fee op 有且仅有一条 revenue event 或登记的 skip。

### 14.2 命令

- `pnpm -C packages/protocol test`
- `pnpm -C packages/currency-service test && pnpm -C packages/currency-service run lint`
- `pnpm -C packages/user-service test && pnpm -C packages/user-service run lint`
- `pnpm -C packages/config-service test`
- `pnpm -C packages/api-gateway test && pnpm -C packages/api-gateway run lint`
- `pnpm -C apps/client test && pnpm -C apps/client run lint`
- `pnpm verify:admin`
- 真栈并发（claim/quota/幂等）按 conformance slice 跑（需 Docker；未跑要在交付报告里明说）。

---

## 15. 上线与回滚

1. 迁移（`1797000000000-AgentDomain.ts`）→ 所有服务部署。
2. `agent_settings.enabled=false`、`agent.inviteEnabled=false`（暗上线）。
3. 后台建测试代理 → 设比例 → 发码 → 测试玩家注册 → 打一局 → 看佣金/额度 → 申请/打款/驳回全链。
4. 开 `enabled`（写 `effective_from`）→ 开 `inviteEnabled` → 客户端硬刷新。
5. 观测：`agent_hook_failures_total=0`、对账缺口 0、结算队列正常。
6. 回滚：`enabled=false`（停新增；存量可结）；`inviteEnabled=false`（隐藏字段）；不删表、不逆向已计提；错账走人工调账。
- **不新增容器**；edge 只加静态路由；无新增端口。

---

## 16. 涉及文件（初稿）

- `packages/protocol/src/config.ts`、`config.test.ts`、`errors.ts`、`rpc.ts`、`index.ts`
- `packages/currency-service/src/agent/**`（新模块）、`apply/apply.service.ts`、`app.module.ts`、`migrations/1797000000000-AgentDomain.ts`、`config/config-cache.service.ts`、`metrics/agent.metrics.ts`、`package.json`（jsonwebtoken）
- `packages/user-service/src/users/users.dto.ts`、`auth/auth.service.ts`、`auth/auth.module.ts`、`currency/currency.client.ts`、测试
- `packages/api-gateway/src/auth/agent.middleware.ts`、`public-paths.ts`、`identity-headers.ts`、`http/http-rate-limit.middleware.ts`、`http/rate-limit.ts`、`gateway/gateway.controller.ts`、`app.module.ts`、`auth/admin-policy.ts`、测试
- `packages/config-service/src/config/client-config.controller.ts`、`migrations/<ts>-AgentInviteKey.ts`、`admin/app.js`（IA）、`scripts/verify-admin-static.mjs`
- `admin/app.js`、`admin/index.html`、`admin/style.css`
- `agent/index.html`、`agent/app.js`、`agent/style.css`
- `apps/client/src/pages/login/login.vue`、`src/net/rest.ts`、`src/stores/auth.ts`、config 类型/存储、测试
- `Dockerfile.edge`、`deploy/Caddyfile`
- `docs/superpowers/specs/2026-10-26-agent-commission-design.md`、`docs/superpowers/plans/2026-10-26-agent-commission.md`

---

## 17. 审查记录

（待独立对抗审查后填写：设计审查 r1 发现与处置、计划审查记录、代码审查记录。）
