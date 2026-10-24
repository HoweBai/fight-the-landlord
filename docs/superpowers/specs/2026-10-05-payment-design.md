# 支付片设计 v1.1（充值 / 退款 / 提现）

> **定位**：P2′ 变现链的支付切片（J4：范围全含）。本片 = **第 8 个 Nest 服务 `payment-service`** + 渠道（支付宝）抽象层 + 玩家钱包页（客户端第 6 页）+ 管理面审核三队列 + 支付监控面。资金唯一写边仍是 `currency.apply`（零第二写边）。
> **作者**：协调者（opus）；**状态**：v1.1（r1 评审 2 阻断 + 11🟡 + 8🟢 + 锚点误 2 全数处置，待 r2 复审）。
> **开工前必读**：交接 `docs/superpowers/plans/2026-10-05-payment-handoff.md` + 路线图 `2026-10-02-post-mvp-roadmap.md` P2′ + 附录 `docs/appendix/platform-roadmap.md` §3.2/§3.3/§6 #21/#28/#29 + 货币设计 `2026-10-03-currency-design.md`（§5 幂等/§12 预留）+ ③ 设计 `2026-10-05-admin-rbac-audit-design.md` §12。评审报告：`.superpowers/sdd/2026-10-05-payment/review-design-r1.md`。

---

## §0 用户裁决记录（本设计不得与之冲突）

| # | 裁决 | 日期 |
|---|---|---|
| J4 | 支付范围 = **充值/退款/提现全含**；提现为资金出站、可按渠道能力收窄 | 2026-10-03 |
| P1 | 渠道 = **先做完整支付宝渠道**（手机网站支付）；微信后做（抽象层预埋） | 2026-10-05 |
| P2 | 提现 = 先「**人工审 + 线下打款台账**」；「人工审 + API 自动出款」推后；全自动更后 | 2026-10-05 |
| P3 | 兑换 **1 元 = 100 金币**；**分池**（充值+对局赢取可提；注册赠送/救助/管理加币不可提） | 2026-10-05 |
| P4 | 退款 = **玩家申请 + 人工审 + 渠道原路退回** | 2026-10-05 |
| P5 | 上线形态：沙箱先行 → 生产**暗上线**（开关默认关）→ 白名单小额 → 放量；密钥走 `.env`、**不进日志/不进出站**；回调 = edge 公开路由 + **验签为唯一信任入口**（交接提案，用户未异议） | 2026-10-05 |

> ⚠️ **用户侧前置（不阻塞开工，阻塞真上线）**：商户号（实名主体）+ 应用签约「手机网站支付」+ 渠道密钥；回调域名核对（`<DEV_HOST>` + Caddy 可承接；备案状态自查）。登记 §14 R1。
> 📌 **P5「白名单小额」落地形态（显式登记）**：**运营软口径，不建用户级白名单机制**——开关开启后仅向小范围用户通告 + 低限额运行，提额 = 改配置键（§9）。若将来要真白名单，另立项（§15）。

---

## §1 范围

### 1.1 本片做

1. **新服务 `payment-service`**（第 8 个 Nest）：HTTP **3007** / metrics **9007** / **零被调 RPC 面**（入口只有网关 HTTP 与 edge 回调直连；出站 = 渠道 HTTPS + 内网 currency/config RPC，§2.1）。共享库 `fight_the_landlord`，迁移表 **`migrations_payment`**，迁移起号 `1791000000000-Payment.ts`（在风控 `1790000001000` 之后）。metrics 面沿既有 **INTERNAL_SERVICE_TOKEN Bearer 守卫（fail-closed）**（`TOKEN_SERVICES` 清单同步，§13.4）。
2. **充值与回调**：下单（档位快照）→ 支付宝手机网站支付 → **回调唯一信任入口**（edge 公开路由 + RSA2 验签）→ `currency.apply(source='recharge', actionId='pay:<orderNo>')` → 到账；含主动查询补单、过期关闭、迟到回调重开。
3. **退款**（P4）：玩家按单申请 ⇒ **申请即冻结** → 人工审 → 渠道原路退 → 完结；驳回/渠道失败 ⇒ 回滚。锚 `refund:<refundNo>` / `refund_rb:<refundNo>`。
4. **提现**（P2）：申请（校验**可离场额度** §5.1，**申请即冻结**）→ 人工审 → **线下打款 + 管理页登记凭证** → 确认；超时自动回滚。锚 `withdraw:<withdrawNo>` / `withdraw_rb:<withdrawNo>`。
5. **渠道抽象层**：`PaymentChannel` 接口 + 支付宝实现（本期唯一）；密钥/网关地址**每次调用读**（缺失 ⇒ 15001，不阻塞容器启动——暗上线期无密钥也可起服务）。
6. **资金动作统一恢复模型**（§2.5）：五个资金动作（入账/提现冻结/提现回滚/退款冻结/退款回滚）共用「停留原位 + 同锚重试扫描 + claim 先行」纪律。
7. **管理面**：支付订单 / 退款审核 / 提现审核三视图 + **审计第六源「支付处置」**；角色矩阵扩条目（照 ③ policy 显式枚举先例）。
8. **对账自检**：日自检 = 入账勾稽（`Σ credited.coins == Σ recharge 流水`）+ **锚勾稽**（ledger 锚 ↔ 本地行，孤儿锚告警）+ 指标（§10）。
9. **监控**：prometheus 第 15 个 job（9007）+ 指标 10 条 + 告警 5 条 + `07-payment` 面板。
10. **客户端**：钱包页（第 6 页；充值/提现/订单与申请记录）+ 大厅钱包区入口 + 支付回跳识别；App 内尽力唤起（§11.4）。
11. **配置**：第 26–34 键（§9）；错误码 **15xxx 段启用**（§8）。
12. **测试**：单测（含**金标验签向量**）+ conformance 新切片 **`slice-21-payment`**（stub 支付宝容器，真栈全链）；§13.4 逐文件核销表。

### 1.2 明确不做（留下一期，§15 登记）

- **微信/其他渠道**（接口预埋，不实现）；**支付宝 APP 支付**产品（App 原生，二期）。
- **渠道账单文件级对账**——v1 用订单级主动查询 + 日自检覆盖；触发条件 = 交易量上量或对账差异出现过一次（§14 R8）。
- **自动审核 / 自动打款**（P2 推后）；**部分退款**（v1 整单退）；提现手续费（0）；**用户级白名单机制**（P5 软口径，§0 注）。
- 优惠/营销/返利、多币种、KYC/实名（渠道不强制则后置）、分期/信用；玩家间转账；对局内货币面任何改动。

---

## §2 架构

### 2.1 服务与端口

| 服务 | HTTP | metrics | 备注 |
|---|---|---|---|
| payment-service | **3007** | **9007**（+6000 惯例，Bearer fail-closed） | 第 8 个 Nest；零被调 RPC 面；非 root 镜像（照 currency 模板） |

- **出站（三条）**：① 渠道 HTTPS（支付宝网关，`ALIPAY_GATEWAY_URL` 可配）② currency-service RPC（`apply` / `get` / 新增只读 `withdrawable.get`，TCP 3104）③ config-service RPC（`config.snapshot` 订阅，ConfigCache 照 room/robot 先例，`docker-compose.yml:301-302`）。
- 依赖：共享 MySQL（五张支付表）+ Redis（回调限流桶；无余额缓存）+ config + currency。
- compose 新容器共 **+1**（17 → 18）；CI images 矩阵 +1（13 → 14）；prometheus job 14 → 15（§10）。

### 2.2 信任边界（三条入口，互不重叠）

1. **玩家 REST**：`/api/pay/*` → 网关（用户 JWT）→ payment-service。只读本人数据；写面限流 = 下单 10/分/用户（§4.1）· 提现/退款申请各 5/分/用户（用户维；数值规格期定稿）。
2. **管理 REST**：`/api/admin/pay/*` → 网关（admin JWT + `admin.middleware` + `admin-policy.ts` 显式枚举）→ payment-service；actor 由网关注入 `x-admin-actor`（③ 已泛化）。
3. **渠道回调**：`/pay/notify/alipay` → **edge 直连 payment-service:3007**（`deploy/Caddyfile` 新 handler，**不经网关、无 JWT**；「验签 = 唯一信任入口」）。Caddyfile 写法规矩照既有实测注记（必须位于 catch-all `handle {` 之前；`deploy/Caddyfile:29-70`）。

### 2.3 组件分解（每单元一职）

- `channel/`：`PaymentChannel` 接口（`createPayUrl / query / refund / close`）+ `alipay/`（签名/验签 `sign.ts`、HTTP 客户端 `client.ts`、参数规范化）。**零新运行时依赖**：RSA2 用 `node:crypto` 自实现（评审可推翻改 SDK，§14 R7）。
- `orders/`：下单/查询/sync/过期（订单状态机唯一写点）。
- `notify/`：回调控制器 + 验签 + 状态推进（条件更新）。
- `withdraw/`、`refund/`：申请/审核/状态机/超时（与 orders 共用 §2.4 的资金动作纪律）。
- `wallet/`：`GET /api/pay/wallet/summary`（余额 + 可离场额度，转发 currency 结果）。
- `admin/`：三视图只读列表 + 处置动作 + 审计源。
- `scan/`：**七个循环**——订单过期关闭 / **主动查询补单** / 入账重试 / 提现冻结解析 / 提现回滚恢复 / 退款冻结解析 / 退款回滚恢复（出站渠道重试挂在各循环内，§2.5），全部条件更新、可重复执行（未来多实例安全）。
- `metrics/`：prom-client（照七服务先例）。

### 2.4 资金纪律（钱专项，硬约束）

- 一切余额变更**只经 `currency.apply`**；本片新增 source（allowlist 6 → 11，`packages/protocol/src/currency.ts:17-24` 单点扩容）：`recharge` / `refund_hold` / `refund_rollback` / `withdraw_hold` / `withdraw_rollback`。
- 幂等锚（先于入账/冻结落库）：`pay:<orderNo>` · `refund:<refundNo>` · `refund_rb:<refundNo>` · `withdraw:<withdrawNo>` · `withdraw_rb:<withdrawNo>`（锚名形状与货币设计 §5.1 预留表的偏离登记见附录 A-6）。
- **金额一律整数**：人民币=分（`amount_fen`），金币=整数；到支付宝 `total_amount` 由分**整数格式化**，**禁浮点**。
- **cap 是裁决口径**：每个消费面（提现/退款）在**资金动作发生的那一刻**（锁内）执行同一次 `currency.withdrawable.get`——**禁缓存、禁只查一次**（r1 阻断-1 的纪律化）。
- **资金动作串行化**：跨消费面的「校验 cap → 冻结落账」在同一条 `payment_user_locks` 行锁内完成（`SELECT … FOR UPDATE`，§5.2）——关掉「两消费面同刻争用毫秒窗」；锁内 currency RPC 超时钉 **3000ms**（与 `user-service/src/currency/currency.client.ts:69` 同值；最坏锁持有时长 ≈ 2×3s ≪ `innodb_lock_wait_timeout` 默认 50s）。
- **未落账冻结即占位（r2 🟡-1 收口）**：锁内校验时，本人存在**任何未解析 `holding` 申请**（提现或退款）⇒ 拒新申请（15003/15006「稍后重试」文案）——关掉「apply 结果未知的冻结尚未进 cap、另一消费面孔秒级重复占用同一 cap 头寸」的残余窗；**cap RPC 取数失败 ⇒ fail-closed 拒申请**（不确定不放松）。
- 密钥（应用私钥/支付宝公钥）只在 `channel/alipay/sign.ts` 读取；**不进日志、不进任何响应、不进 flows**；日志层加 **PEM 私钥形态机械脱敏**（§12）。

### 2.5 资金动作统一恢复模型（r1 阻断-2/🟡-4 的纪律化）

**通用四条**：① **停留原位**——apply 结果未知（网络/超时）⇒ 不改终态、不留"假终态"；② **同锚重试扫描**——重放同一 actionId（幂等：成功返回原结果、失败原样再判）；③ **claim 先行**——一切状态迁移用条件 UPDATE 先抢行，再动外部（钱/渠道），最后记完成列；正向动作仅**明确失败**（14001 余额不足、14002 锚冲突、10001 载荷非法）迁失败终态；④ **回滚动作例外**——`withdraw_rb/refund_rb` 明确失败 ⇒ **留停留态（`rolling_back`/`rejecting`）+ 告警转人工**（绝不误置终态、不释槽：误置=币未回而槽已放，破钱）。扫描统一周期 = `PAY_SCAN_INTERVAL_MS`（默认 60s，§4.5/§13.3）。

| 资金动作 | 锚 | 停留态 | 扫描 | 收敛 |
|---|---|---|---|---|
| 充值入账 | `pay:<no>` | `paid` | 60s 重放 | 成功 ⇒ `credited`；停留 > 15m ⇒ 告警 |
| 提现冻结 **解析** | `withdraw:<no>` | `holding` | 60s 重放 | 明确成功 ⇒ `pending`；明确失败 ⇒ `failed`；未知 ⇒ 继续 + >15m 告警 |
| 提现回滚 | `withdraw_rb:<no>` | `rolling_back` | 60s 重放 | 落账 ⇒ 终态（`rejected`/`timeout_rolled_back`）；未知 ⇒ 继续 + >1h 告警 |
| 退款冻结 **解析** | `refund:<no>` | `holding` | 60s 重放 | 成功 ⇒ `pending`；明确失败 ⇒ `failed`；未知 ⇒ 继续 + >15m 告警 |
| 退款回滚 | `refund_rb:<no>` | `rejecting` | 60s 重放 | 落账 ⇒ `rejected`；未知 ⇒ 继续 + >1h 告警 |

**出站渠道重试**（对支付宝 API；`out_request_no`/`out_trade_no` 幂等兜底）：

| API | 退避序 | 上限后 |
|---|---|---|
| `trade.query` / `trade.close` | 1s → 5s → 30s | 停 + 指标（下一轮扫描周期自然再试） |
| `trade.refund` | 1s → 5s → 30s → 2m → 10m | 停 + 告警（留 `approved` + `last_error`，人工面） |
| `trade.wap.pay`（链接生成） | 不重试（同步请求内失败即 15001） | — |

**残余风险（登记 §14 R12）**：apply 远程成功但本地事务提交失败的**孤儿 hold**——由日自检「锚勾稽」兜底告警（ledger 有锚、本地无行）。

---

## §3 数据模型（五表，详细 DDL 归规格）

1. **`payment_orders`**：`order_no` varchar(32) UK（`pay_` + 时间前缀 + 随机，字符集 `[0-9a-z_]`，满足支付宝 out_trade_no 约束）· `user_id` idx · `package_yuan` / `amount_fen` / **`coins` / `coin_per_yuan`（下单时快照——照 J5 口径）** · `status`（`created|paid|credited|closed`）· `trade_no` · `created_at/expires_at/paid_at/credited_at/closed_at/late_reopen_at` · `last_error`。
   索引：`(user_id, created_at)`、`(status, expires_at)`、`(status, paid_at)`。
2. **`payment_refunds`**：`refund_no` UK · `order_no` idx · `user_id` idx · `amount_fen`/`coins` · `status`（`holding|pending|approved|refunded|rejecting|rejected|failed`）· `reason` · `reviewed_by/reviewed_at/review_note` · `channel_out_request_no`（=refund_no，退款幂等键）· `channel_refund_no` · `hold_confirmed_at` · `refunded_at` · `last_error` · **`active_slot` tinyint NULL + `UNIQUE(order_no, active_slot)`**（§3.1）。
3. **`payment_withdrawals`**：`withdraw_no` UK · `user_id` idx · `coins`/`amount_fen` · `status`（`holding|pending|approved|paid|rolling_back|rejected|timeout_rolled_back|failed`）· `created_at` · **`timeout_at = created_at + withdrawTimeoutMinutes`** · `hold_confirmed_at` · `reviewed_by/at/note` · `confirmed_by/at` · `voucher`（≤64）/`confirm_note` · `rolled_back_at/rollback_reason`（`rejected|timeout`）· `last_error` · **`active_slot` tinyint NULL + `UNIQUE(user_id, active_slot)`**。
4. **`payment_notify_log`**：仅存**验签通过**的通知（`order_no` idx · `result` · `trade_status` · `amount_fen` · `raw_payload` text · `received_at` · `client_ip`）——取证/纠纷用；验签失败**只计指标+日志**（防垃圾无限增长）。
5. **`payment_user_locks`**：`user_id` varchar(36) PK · `updated_at`——**跨消费面资金动作串行化**的行锁载体（INSERT IGNORE 建行 + `SELECT … FOR UPDATE`，§5.2）。

### 3.1 幂等槽模式（两处复用，规格逐字）

`active_slot` 在途=1、终态置 NULL；MySQL 唯一键不对 NULL 去重 ⇒ 终态行任意多、在途行至多一。

- 提现：`UNIQUE(user_id, active_slot)` ⇒ 同用户至多一笔在途；`paid/timeout_rolled_back/rejected/failed` 均置 NULL（可再申请）。
- 退款：`UNIQUE(order_no, active_slot)` ⇒ 同订单至多一笔在途；**`refunded` 行保留 `active_slot=1`**（唯一键兼作「已退」结构标记，封死二次退款）；仅 `rejected/failed` 置 NULL（**可再发起**——重报换新 `refund_no` ⇒ 新锚，`refund:<refundNo>` 形状的必要性见附录 A-6）。

---

## §4 充值链路

### 4.1 下单

- `POST /api/pay/orders {packageYuan}`：开关 `pay.rechargeEnabled` 关 ⇒ 拒（**开关只挡新建单**）；档位 ∈ `pay.rechargePackages`；快照 `coins = packageYuan × coinPerYuan`，`expires_at = now + orderExpireMinutes`；调 `alipay.trade.wap.pay`（`product_code=QUICK_WAP_WAY`、`out_trade_no=order_no`、`timeout_express=orderExpireMinutes`、`notify_url=https://<site>/pay/notify/alipay`、`return_url=<site>/?pay=<orderNo>`）⇒ 返回 `{orderNo, payUrl}`。
- **短时幂等**（防连点/防重）：同用户 + 同档位 + **未过期 `created` 单已存在 ⇒ 复用**（返回同一单与链接）；不同档位可并存多张未支付单；已过期单不复用（过期关闭后新单）。
- 支付链接生成对同 `out_trade_no` 幂等（支付宝侧语义）；限流：下单 10 次/分/用户（网关五维先例）。

### 4.2 支付与前端

- 客户端跳转 `payUrl`（支付宝收银台）；支付后回跳 `return_url`（**同步回跳 ≠ 支付完成**——异步通知后到，客户端进钱包页轮询 `GET /api/pay/orders/:no`，3s × 10 直至 `credited`，否则「处理中」+ 可手动刷新触发 `POST /:no/sync`）。
- 回跳识别：应用启动读 `?pay=<orderNo>` → 跳钱包页结果区（H5 与 App 通用路径；App 形态见 §11.4）。

### 4.3 回调（唯一信任入口）

- **验签两口径（r1 🟡-11 拆分，勿混用）**：
  ① **异步通知**：form-urlencoded POST；取除 `sign`/`sign_type` 外全部参数，按参数名 **ASCII 升序**，`k=v` 以 `&` 连接（值取**解码后原文**、不二次编码）⇒ `crypto.verify('RSA-SHA256', canonical, 支付宝公钥)`。
  ② **OpenAPI 同步响应**（query/refund/close 的 JSON）：对响应体中 **`<api>_response` 键对应值的原文子串**做 RSA2 验签（**不是**通知的排序规范化）。
  两口径的边界样例在沙箱联调期采集为**金标向量**（§13.1）；R7 低置信项保留登记。
- **四项业务校验**（验签后逐条）：`app_id` 等于本方 · `seller_id` 等于本方 · `out_trade_no` 存在且 `total_amount` **解析为整数分后与 `order.amount_fen` 相等**（解析失败 ⇒ `amount_mismatch`；整数比较消除格式歧义）· `trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}`。
- **状态推进（条件更新，并发安全）**：`UPDATE payment_orders SET status='paid', trade_no=?, paid_at=NOW() WHERE order_no=? AND status='created'`。
  - affected=1：首达 ⇒ 立即走 §4.4 入账；affected=0 且现状 ≥ paid ⇒ **重复回调**，直接回 `success`（幂等——签名不可伪造 + 状态条件更新 + apply 锚三重兜底；**附录 #21 结案见附录 A-2**）。
  - `closed` 订单收到支付成功通知 ⇒ **重开**（`closed → paid`，记 `late_reopen_at` + 指标 + 告警 §10）——**钱在手必入账**（本地过期与渠道窗口的时钟边缘，不得吞钱）。
- **应答语义**：订单达到 ≥ `paid` ⇒ 回纯文本 `success`；其余（含写库失败）⇒ 回 `failure`/500 让支付宝重试（官方 24h 递进重试梯）。
- 验签失败/校验不过 ⇒ 回 `failure` + `payment_notify_total{result=…}` 计数（密钥错配或攻击的**第一道铃**）。

### 4.4 入账与信用重试

- 入账：`currency.apply{actionId:'pay:<orderNo>', source:'recharge', refId:orderNo, entries:[{ownerId:userId, delta:+coins}]}`。
- 成功 ⇒ `paid → credited`；结果未知 ⇒ **停留 `paid`**（§2.5 通用纪律；锚幂等 ⇒ 重放安全）。
- 信用重试扫描：§2.5 表第一行（60s 重放；停留 > 15m ⇒ `PaymentFundOpStalled` 告警）。
- ⚠️ 顺序硬约束：**先 `paid` 落库、后 apply**——即使 apply 永远失败，钱的事实已在库（可重试可审计），不存在「入账了但订单不知道」。

### 4.5 过期关闭与迟到重开

- **过期关闭**：`created` 且 `now > expires_at` ⇒ 本地 `→ closed`（条件更新），并**尽力**调 `alipay.trade.close`（退避表 §2.5）；close 返回「已支付」类错误 ⇒ 转走 §4.3 的 paid 路径（防「已付被关」）。
- **主动查询补单**：`created` 且创建超 5 分钟未过期 ⇒ `alipay.trade.query`：`TRADE_SUCCESS` ⇒ 走 paid 路径（补回调丢失）；`TRADE_CLOSED/不存在` ⇒ 留待过期。
- 扫描周期统一 60s（env `PAY_SCAN_INTERVAL_MS`；测试注入短值，§13.3）。

---

## §5 提现

### 5.1 分池机制 = 可离场额度（P3 的落地形态）

**机制选择**（三案对比后裁决）：
- 案 A 双账户/双池余额列：需动**已冻结的货币写路径**（PK 或 entries 加池维度 + 消耗次序语义）——高评审负担 + 触及 slice-17/18 不变量。
- 案 B flows 归属重放（FIFO 归因）：已被论证不可靠（救助资助的对局赢取无法归因）。
- **案 C（选定）：在账本上派生「可离场额度」，零写路径改动。**

**公式**（唯一实现点 = **currency-service 新增只读 RPC `currency.withdrawable.get`**，协议入 `packages/protocol`——口径贴着账本而不是他服务直读，虽然同库；理由：cap 是资金裁决口径、不是诊断读，不照抄「currency 读 users 仅诊断」先例）：

```
cap_raw(user) = Σ flows.delta  where source ∈ { recharge, game_settle,
                                              refund_hold, refund_rollback,
                                              withdraw_hold, withdraw_rollback }
cap(user)     = max(0, min(cap_raw, balance))
```

即：**充值 + 对局净赢取 + 退款/提现往返**可离场；**signup_grant / relief_grant / admin_adjust 一律不可离场**（§14 R4 登记管理加币不可提）。

**语义演算**（规格将原样收编为用例表）：

| # | 场景 | cap | 说明 |
|---|---|---|---|
| ① | 充值 600，未动 | 600 | 正常 |
| ② | 充值 600 + 救助 200，未动 | 600 | 救助沉淀在余额里，不可离场 |
| ③ | 充值 600 + 救助 200，对局净输 150 | 450 | 输先从白来的钱垫，但额度按净额收缩 |
| ④ | 无充值 + 救助 200，对局净赢 300 | 300 | 赢取可提——**零和对局里赢得的是对家充值**（机器人局=池钱，见 §14 R5；洗白路径见 §14 R6） |
| ⑤ | 充值 600，已退 600 | 0 | 退款冻结/回滚按自然符号计入 |

- **不变量的依据 = `min(…, balance)` 结构本身**：`cap ≤ balance` 恒成立（`cap_raw` 可正于余额的场景——如 `admin_adjust` 负扣减——由 `min` 兜底）；被排除的三源只影响余额不进入 `cap_raw`。
- **纪律（r1 R3 专项 + 阻断-1）**：cap 是**裁决口径**——两个消费面在**资金动作时刻**（锁内）执行同一 RPC，**禁缓存、禁只查一次**。
- 现量级无索引压力（照货币 R5 登记）。

### 5.2 申请（锁内三段：校验 → 插入 → 冻结）

**全程在 `payment_user_locks` 行锁内**（跨消费面串行，关毫秒争用窗）：

1. 锁：`INSERT IGNORE` 建行 → `SELECT … FOR UPDATE`。
2. 校验：`pay.withdrawEnabled`（只挡新建）· `coins ≥ pay.withdrawMinCoins` · `≤ pay.withdrawMaxCoinsPerOrder` · **当日额度**（+08:00 自然日，按 `created_at` 归日；计入 status ∈ {`holding, pending, approved, paid, rolling_back`} 的 coins 合计——`rejected/timeout_rolled_back/failed` 不计）· `coins ≤ cap`（§5.1 RPC，**此刻**；RPC 失败 ⇒ **fail-closed 拒**）· **本人无未解析 `holding` 冻结**（提现/退款任一——§2.4 占位规则；不满足 ⇒ 15003「稍后重试」）。
3. 插入行 `status='holding'`（`active_slot=1`；撞 UK ⇒ 15003「已有在途申请」）。
4. `currency.apply{actionId:'withdraw:<no>', source:'withdraw_hold', delta:−coins}`：明确成功 ⇒ `→ pending`（记 `hold_confirmed_at`）；**明确失败**（14001/14002/10001…）⇒ `→ failed`（终态、槽释放）；**结果未知** ⇒ 留 `holding`（§2.5 解析扫描收敛；**holding 永不回滚**——见 §5.3）。
5. 提交（释放锁）。
- 冻结在前、审核在后——审核期间钱已锁定，无双重占用。

### 5.3 状态机与超时回滚（r1 阻断-2 修正版）

```
holding ─解析成功→ pending ─审通过(claim)→ approved ─确认打款(claim)→ paid（终）
   │                 │  │                      │
   │                 │  └─审驳回(claim)→ rolling_back ─回滚落账→ rejected（终）
   │                 └─(同左)                     └─超时(claim)→ rolling_back ─落账→ timeout_rolled_back（终）
   └─解析明确失败→ failed（终）        rolling_back 回滚未落账 ⇒ 恢复扫描（§2.5）
```

- **holding 只解析、不回滚**：holding 的含义 = hold 的 apply 结果未知；**只有 hold 已确认落账（成功或同锚重放命中）才允许发 `withdraw_rb`**。holding 逾期不走超时回滚——先解析到确定态（成功 ⇒ 转 `pending` 后按常规规则；明确失败 ⇒ `failed`）；解析持续未知 ⇒ 无限重试 + 告警（钱没动，等得起）。
- **claim 先行**（一切迁移条件 UPDATE 抢行）：审驳回与超时扫描 = `UPDATE … SET status='rolling_back', rollback_reason=? WHERE withdraw_no=? AND status IN ('pending','approved')`；**确认打款** = `UPDATE … SET status='paid', … WHERE … AND status='approved'`——两者互斥（谁先 claim 谁生效，后到者 affected=0 重读报状态已变），**双付面（线下已付 + 币回滚）被结构性消除**。回滚落账后才写 `rolled_back_at` 与终态；「已 claim 未落账」由恢复扫描收敛（§2.5）。
- **超时基准**：`timeout_at = created_at + pay.withdrawTimeoutMinutes`（默认 4320 = 72h）；扫描只针对 **`pending|approved`**（钱已冻结且未终态）；`applied_at` 一词废除（统一 `created_at`；冻结确认时刻另记 `hold_confirmed_at`）。
- **开关与在途**：`withdrawEnabled` 中途关闭，在途申请**照常可审可确认、超时照常回滚**（只有新建被挡——与充值同规则，规格钉死）。

### 5.4 人工打款台账（P2 形态）

- 系统**零出站资金 API**：操作者在支付宝 App 手工转账给玩家（收款账号由操作者与玩家线下核对，系统不存玩家收款账号——v1 登记、二期随自动出款再收）；完成后在管理页登记 `voucher`（转账单号/凭证号）+ 备注 ⇒ 确认。
- 打款操作纪律（手册）：先看「提现审核详情」核对金额与用户，转完立刻登记——**未登记=未打款**（超时回滚会退钱，防重复付；§5.3 的 claim 互斥再兜一层）。

### 5.5 限额初值（P2 表；全部为配置键，§9）

| 项 | 初值 |
|---|---|
| 门槛 | 1000 金币（10 元等值） |
| 手续费 | 0 |
| 单笔上限 | 50000 金币（500 元等值） |
| 单用户单日上限 | 100000 金币（1000 元等值） |
| 在途笔数 | 至多 1（幂等槽，非配置） |
| 超时 | 4320 分钟（72h） |

---

## §6 退款

### 6.1 申请即冻结（r1 阻断-1 修正版）

- 玩家对**某笔已入账订单**发起 `POST /api/pay/refunds {orderNo, reason}`；条件（**锁内**、cap 在冻结动作时刻取）：`order.status='credited'` · 该单无在途/已退（幂等槽，§3.1）· **`order.coins ≤ cap(user)`**（「未消费部分 + 可提余额」的统一口径）· **本人无未解析 `holding` 冻结**（提现/退款任一——§2.4 占位规则；以上任一不满足 ⇒ 15006）。
- **申请即冻结**（与提现对称）：插入 `holding`（槽）+ `currency.apply{actionId:'refund:<refundNo>', source:'refund_hold', delta:−coins}` ⇒ 成功 `→ pending`；明确失败 `→ failed`；未知留 `holding`（§2.5 解析）。**杜绝「申请时过 cap、审批时已跨口径」的整段人工审窗口**。
- 不做部分退款（v1 整单退）；渠道窗口/权限以支付宝返回为准（§14 R13）。

### 6.2 审核 = 纯渠道动作（钱已冻结）

- **审通过**（claim：`pending → approved`）后同步调 `alipay.trade.refund{out_trade_no, refund_amount, out_request_no=refund_no, refund_reason}`（**`out_request_no` = 重试幂等键 ⇒ 重复退款不可能**）。
  - 渠道明确成功 ⇒ `→ refunded`（**无后续钱动作**——`refund_hold` 那一笔就是本次退款的实际扣减）。
  - 渠道明确失败 ⇒ **留在 `approved`** + `last_error`（人工可再试/驳回；退避表 §2.5 上限后告警）。
  - 结果未知 ⇒ 留 `approved`，扫描按同一 `out_request_no` 重放。
- **审驳回**（claim：`pending|approved → rejecting`）⇒ `currency.apply{actionId:'refund_rb:<refundNo>', source:'refund_rollback', delta:+coins}` ⇒ 落账 `→ rejected`（槽释放；可重新发起=新 `refund_no` 新锚）；回滚未落账 ⇒ 恢复扫描（§2.5）。
- `refunded` 行**保留槽**（§3.1）——结构封死「已退订单再退」。

### 6.3 退款状态机

```
holding ─解析成功→ pending ─审通过(claim)→ approved ─渠道成功→ refunded（终·保留槽）
   │                   │  │                     │
   │                   │  └─审驳回(claim)→ rejecting ─回滚落账→ rejected（终·释放槽）
   └─解析明确失败→ failed（终·释放槽）   approved 渠道失败 ⇒ 停留 + last_error（人工面）
```

---

## §7 管理面与审计

- **三块视图**（`admin/app.js` 新 section，照既有静态页样式）：
  1. 支付订单：列表（状态/用户/时间过滤）+ 详情（含 notify_log）。
  2. 退款审核：待审列表 + 通过/驳回（表单含 note）；状态跟踪。
  3. 提现审核：待审列表 + 详情（余额/可离场额度/历史申请）+ 通过/驳回/登记打款（voucher+note）。
  三列表均带 `.csv` 导出（字节级判据照 ③ 先例）。
- **审计第六源「支付处置」**：读三表的处置字段流（申请/审/驳回/确认/回滚，含 actor+时刻），页签「审计 → 支付处置」+ `GET /api/admin/pay/actions[.csv]`。
- **同步面（r1 🟡-2/🟡-3 收编）**：审计页签「五页签 → 六页签」字面量（`admin/app.js:43/:294/:2245`）· 页签注释/按钮（`admin/index.html:310-320`）· 顶栏三新视图按钮 · **财务视图「来源」下拉 +5 选项**（`admin/index.html:144-150` 现为硬编码 6 值；**后端零改动**——`finance-query.service.ts:53-56` 动态 `GROUP BY o.source`，口径 = 后端零改动 + 下拉扩项，验收抽查**过滤与渲染双面**）· slice-19 G12 静态串针脚追加支付端点（`slice-19-admin-rbac-audit.ts:1399-1438`，风控片 T11 同款先例）。
- **policy 扩条目**（`admin-policy.ts` 显式枚举，照 ③ D3）：读面全角色（照 P8）；退款/提现写面 `super_admin | finance`（照 P6）；未登记端点 fail-closed（既有机制）。

---

## §8 错误码（15xxx 段启用）

`packages/protocol/src/errors.ts:53` 14xxx 块之后新增；客户端可见码全部映射**既有 `ClientAction.TOAST`**（文案走 `message`；不新增枚举值——照货币片 v1.1.1 口径）：

| 码 | 名 | 语义 |
|---|---|---|
| 15001 | PAY_CHANNEL_ERROR | 渠道调用失败（下单/查询不可用；可重试提示） |
| 15002 | PAY_ORDER_NOT_FOUND | 订单不存在或非本人 |
| 15003 | PAY_WITHDRAW_UNAVAILABLE | 提现不可用（开关关/在途已有/低于门槛，message 区分） |
| 15004 | PAY_WITHDRAW_LIMIT | 超单笔/单日限额 |
| 15005 | PAY_WITHDRAWABLE_INSUFFICIENT | 可离场额度不足（P3 分池面） |
| 15006 | PAY_REFUND_UNAVAILABLE | 退款不可退（状态/在途/已退/超可退） |
| 15007 | PAY_NOTIFY_VERIFY_FAILED | 回调验签失败（服务端内部面，不出客户端；日志+指标；`CLIENT_ACTION` 穷尽表补 `IGNORE`） |

- `14006/14007`（附录已有名目）**收编为提现超时回滚的客户端可见状态**（申请记录行内提示，非错误码路径）——规格钉死两文案。

---

## §9 配置键（第 26–34 键）

| # | 键 | 默认 | 说明 |
|---|---|---|---|
| 26 | `pay.rechargeEnabled` | false | 暗上线开关（只挡新建单） |
| 27 | `pay.withdrawEnabled` | false | 同上 |
| 28 | `pay.coinPerYuan` | 100 | P3 比率；**下单时快照** |
| 29 | `pay.rechargePackages` | `[6,30,68,128,328]`（元） | 档位表 |
| 30 | `pay.withdrawMinCoins` | 1000 | 门槛 |
| 31 | `pay.withdrawMaxCoinsPerOrder` | 50000 | 单笔 |
| 32 | `pay.withdrawDailyMaxCoins` | 100000 | 单日/人 |
| 33 | `pay.orderExpireMinutes` | 30 | 订单有效期 |
| 34 | `pay.withdrawTimeoutMinutes` | 4320 | 超时回滚（分钟，便于测试注入） |

- 种子迁移照 SignupGrant/GoldRoom/RiskConfigSeed 三先例追加。
- **客户端子集 +7**（键名映射逐对钉死，防自由发明；组装在 `client-config.controller.ts`，真源 `CLIENT_CONFIG_KEYS`）：

| ClientConfig 字段 | ← 配置键 |
|---|---|
| `rechargeEnabled` | `pay.rechargeEnabled` |
| `withdrawEnabled` | `pay.withdrawEnabled` |
| `coinPerYuan` | `pay.coinPerYuan` |
| `rechargePackages` | `pay.rechargePackages` |
| `withdrawMinCoins` | `pay.withdrawMinCoins` |
| `withdrawMaxCoinsPerOrder` | `pay.withdrawMaxCoinsPerOrder` |
| `withdrawDailyMaxCoins` | `pay.withdrawDailyMaxCoins` |

⇒ `CLIENT_CONFIG_KEYS` 7 → 14（`client-config.controller.ts:8` 的「恰键集」判据同步）。

---

## §10 监控（钱的事故面第一道铃）

- prometheus **第 15 job**：`payment-service:9007`（Bearer credentials_file 同七服务）；面板 `07-payment`（六 → 七）；告警追加 `ftl-alerts.yml`（含 `runbook:` 注记，照 `:145-157` 风格；`EXPECTED_RULES` 18 → 23）。
- 指标（10）：`payment_notify_total{result}`（ok/bad_sign/amount_mismatch/unknown_order/reopen）· `payment_order_pending{state=pending_pay|paid_uncredited}` · `payment_fundop_pending{op}` · `payment_fundop_oldest_age_seconds{op}` · `payment_fundop_retry_total{op}` · `payment_refund_total{result}` · `payment_withdraw_pending` · `payment_withdraw_oldest_age_seconds` · `payment_outbound_fail_total{api}` · `payment_reconcile_diff`。
- 告警（5）：**PaymentFundOpStalled**（**单规则分档阈值**：`pay`/`withdraw_hold`/`refund_hold` 类最老者 > **15m**、`withdraw_rb`/`refund_rb` 回滚类 > **1h**，warning——与 §2.5 表逐行一致；钱动了没落账的统一哨兵）· **PaymentNotifyBadSignSpike**（bad_sign 突增，warning）· **WithdrawBacklog**（pending/approved 最老 > 48h，warning）· **PaymentLateNotifyReopen**（>0，warning——过期配置/时钟异常的哨兵）· **PaymentReconcileDiff**（>0，critical——日自检差异：入账勾稽 `Σ credited.coins == Σ recharge 流水` + **锚勾稽**（ledger 有锚 ↔ 本地无行 = 孤儿 hold，§2.5 残余风险兜底））。

---

## §11 客户端（钱包页 = 第 6 页）

### 11.1 结构与入口

- 新页 `pages/wallet/wallet.vue`（`pages.json` 注册；现有五页 = game/history/lobby/login/table）：**余额区**（含可离场额度）· **充值区**（档位按钮 → 下单 → 跳收银台）· **提现区**（金额输入 + 门槛/限额提示 + 申请）· **记录区**（订单/退款/提现三列表，含状态与 14006/14007 提示）。
- 入口：大厅钱包区点击进钱包页（`lobby.vue` 现有钱包展示处）；两开关关闭时对应区块隐藏（`rechargeEnabled/withdrawEnabled`）。

### 11.2 交互要点

- 下单后跳外链；回跳识别 `?pay=<orderNo>`（§4.2）；订单状态轮询 + 手动刷新（sync）。
- 提现页实时显示 cap 与剩余可申额度（当日）；金额校验双端一致（服务端权威）。

### 11.3 失败态

- 15001 渠道不可用 ⇒ toast + 保留单（可重试）；15003/15004/15005/15006 ⇒ message 文案（规格定稿）；`holding/failed` 申请可见（不可重复提交）。

### 11.4 App 形态（登记）

- v1 = 手机网站支付。**App 宿主经 `plus.runtime.openURL` 尽力唤起**（HTML5+ 运行时全局 `plus`；把 URL 交给系统打开：系统浏览器 → wap 收银台 → 唤起支付宝；App 页面 JS 跑在 service 上下文，`window`/`location` 不存在 ⇒ 该路径是 App 上唯一出路）；**H5 直跳**（`location.href` = wap 收银台，后续唤起链由收银台自身承接）；**唤不起 ⇒ 降级文案**（页面显示「请用浏览器打开完成支付」引导，H5 URL 可直达）。App 原生支付（APP 支付产品）二期（§15）。

---

## §12 部署与安全

- **Caddyfile**：新增 `handle /pay/notify/*` → `reverse_proxy payment-service:3007`（放 catch-all 前；注释照既有实测规矩）；全局 `request_body max_size 1MB` 已覆盖回调体积。
- **网关**：`/api/pay/*`、`/api/admin/pay/*` 转发 → payment-service；新增 env `PAYMENT_SERVICE_URL`（同步 `design.md` §2.3 env 表 + `design-md-*.gate.test.ts` 的 NEW_ENVS 判据）。
- **回调防护**：仅 POST + form 内容类型 + 16KB 上限 + 限流桶——**口径钉死（r1 🟡-6）**：反代后 socket peer 恒为 edge 容器，**如实按 peer 记「边缘单桶 600/分」**（不复制 XFF 信任口径——回调有查询扫描兜底，丢通知不丢钱）；**Redis 故障 = fail-open + 响亮 WARN 日志**（钱进路径宁可通过再补审计，不因缓存故障拒真回调）；**不新增指标/告警条目**（§10 数字链保持 10 指标 / 5 告警；若规格期判定需哨兵，一次性入链改数）。明文响应体仅 `success`/`failure` 两词。
- **密钥**：`ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` / `ALIPAY_GATEWAY_URL`（默认生产网关；沙箱/stub 同构）→ 服务器 `.env`（沿 `JWT_SECRET` 先例，不进仓）；**每次调用读**（缺失 ⇒ 15001，不阻塞启动——暗上线期无密钥可起服务）；泄露应对 = 渠道后台重签 + 按流水全量核对（手册）。
- **密钥不进日志的机械层（r1 🟢-4）**：`packages/shared/src/logging/redact.ts` 增加 **PEM 私钥形态规则**（`-----BEGIN … PRIVATE KEY-----` 块 ⇒ `[REDACTED_PRIVATE_KEY]`）+ 测试（照 `redact.test.ts:12-26` 先例）。
- **手册**：`docs/ops/first-deploy.md` 增两节——「支付上线五步」（填密钥 → 沙箱验证 → 打 tag → 开开关暗上线 → 小范围通告+低限额 → 提额放量，提额=改配置键）与「提现打款手顺」（§5.4）；告警 runbook 注记（§10）。

---

## §13 测试与验收

### 13.1 单测

- 签名/验签：RSA2 **两口径**金标向量（≥4 组：成功回调/金额不符/查询响应/退款响应；来源 = 支付宝官方示例 + **联调期沙箱实测采集**，采集件入仓作 fixtures）；伪造签名/篡改金额负例。
- 状态机：订单（含并发条件更新、迟到重开）、提现（含幂等槽、holding 只解析、claim 互斥、超时回滚）、退款（含申请即冻结、保留槽、驳回回滚）。
- cap 公式：§5.1 演算表全收编 + 边界（admin 负扣减、min(balance) 兜底）。
- 金额格式化：分→元字符串逐字（`0.01/0.10/1.00/500.00`）。
- **redact PEM 私钥脱敏**测试（§12）。
- 客户端：钱包页渲染/开关隐藏/轮询/回跳识别（vitest，照 client 既有套件）；admin 静态页字符串断言（照 ③）。
- policy 矩阵：新条目逐端点正反 + 未登记 fail-closed。

### 13.2 真栈（conformance `slice-21-payment`，~16 组）

- **stub 支付宝（r1 🟡-7 修正）**：**固定名 stub 容器入 compose 网络**（照 `slice-16-monitoring.ts:21/:453` 与 `slice-07.3-edge.ts:531` 先例；起停登记进 `scripts/deploy/conformance-stack.sh`）——payment 按 `ALIPAY_GATEWAY_URL=http://<stub名>:<port>` DNS 直达；stub 用测试密钥对**双向金标**（验我们出站请求签名、对响应签名）。**不用 `extra_hosts`（全仓零先例，弃）**。
- **notify 投递路径 = 经门口**（`https://<edge>/pay/notify/alipay`）——顺带把 Caddyfile 新 handler 纳入切片验收。
- 组：①配置键种子+客户端键集 14 ②开关关拒单 ③下单+stub 验签 ④回调正例→入账→余额/流水/锚 ⑤伪造签名拒+计数器 ⑥金额不符拒 ⑦重放幂等（重发通知不重复入账）⑧并发双通知恰一次入账 ⑨迟到回调重开（+告警指标）⑩过期关闭（含 trade.close 已付分支）⑪提现全链（门槛/限额/在途/审/确认；hold 流水逐字）⑫超时回滚（`withdrawTimeoutMinutes` 改 1 + 短扫描注入；含 claim 互斥负例：确认打款与超时扫描并发恰一胜）⑬cap 场景组（§5.1 表 + 15005 负例 + **跨消费面串行负例**：退款冻结后同额提现必拒；**未解析 `holding` 存在期间另一面申请拒**——§2.4 占位规则）⑭退款全链（申请即冻结→审→stub 退款→refunded；驳回回滚；15006 负例；渠道失败停留 approved）⑮权限矩阵+审计第六源+CSV 字节 ⑯日自检指标可见（含锚勾稽负例注入=直接 SQL 造孤儿锚）。
- **真栈纪律**：金额类改动 = 本切片全 MySQL 断言（假库不作数）；baseline 回填待 CI 权威轮（照近例）。

### 13.3 测试注入（登记）

- `PAY_SCAN_INTERVAL_MS`（默认 60000，测试 2000）· `ALIPAY_GATEWAY_URL`（测试=stub 容器地址）· 测试密钥对——**compose 注入行（+N 行）登记进「测试 env 清单」**（env 注入先例为真：`docker-compose.yml:181-183`；stub 容器为新增先例）。

### 13.4 闸与清单同步面（**逐文件核销表**，实施首日逐行勾；照货币片 §9.1 格式）

| # | 文件（当前行号） | 要改什么 |
|---|---|---|
| 1 | `tools/conformance/src/slices/slice-16-monitoring.ts` | `EXPECTED_JOBS` 14→15（:82-86）· `NEST_TARGETS` +`payment-service:9007`（:100-108 及注释计数）· `EXPECTED_RULES` 18→23（:89-97）· promtool「18 rules」→23（:595）· `/api/v1/rules` 恰 18→23 + 名集（:658-659）· Grafana 面板六→七（07-payment，:719-721）· 降级文案「13 个 up」→14（:76/:380-382/:647）· `EXPECTED_SERVICES` 恰 13→14（:117-121；「恰 13」判据 :1176-1184） |
| 2 | `tools/conformance/src/slices/slice-07.2-deploy.ts` | 带 `build:` 服务恰 13→14（:576）· `TOKEN_SERVICES` 10→11（:132；payment 含 fail-closed token 守卫） |
| 3 | `scripts/deploy/conformance-stack.sh` | `SERVICES` 恰 13→14（**:22**，全文仅 96 行——r2 锚点订正；含 stub 容器起停登记） |
| 4 | `tools/conformance/src/slices/slice-14-config-center.ts` | C7 客户端键集恰七→十四（:498-505） |
| 5 | RPC 三件套 | `packages/protocol/src/rpc.ts` `RPC_PATTERNS` +`currency.withdrawable.get` · `messages.test.ts:53` 十四→十五 · `robot-availability-wiring.gate.test.ts`（currency 接收侧模块注册同提交）· `packages/room-service/test/meta-on-every-rpc-send.gate.test.ts`（payment 新发送边） |
| 6 | 机械闸族 | `packages/api-gateway/test/no-raw-console.test.ts`（:72 名单+ALLOWED）· `outbound-timeout.gate.test.ts`（PKGS :8）· `container-assembly.gate.test.ts`（SERVICES :42）· `service-name.gate.test.ts` · `shared/test/dockerfile-workspace-copy.gate.test.ts` 与 `dockerfile-patches-copy.gate.test.ts`（新 `Dockerfile.payment-service`）· `slice-07.2-hardening`（新端口/守卫面）· `slice-07.4-pipeline`（新文件是否触被钉集合） |
| 7 | 错误码链 | `protocol/src/errors.test.ts` `SPEC_CODES` · `CLIENT_ACTION` 穷尽（15007→`IGNORE`）· payment `http/errors.ts` `HTTP_STATUS` 表（不补则 4xx/409 静默变 500——货币片 §8 已付学费）· `design.md` §11.2 |
| 8 | 计数/文案 | `scripts/deploy/build-images.sh:2`（13→14）· `conformance.yml`（:4 镜像计数 13→14、**:32 切片数改 26**——现注释 22 已漂移）· `images.yml:31`/`release.yml:43` 步骤名内嵌计数 · `docker-compose.yml:3/:8-9/:11/:13-14` 头注释（r2 锚点订正）· `first-deploy.md` 计数 · `scripts/ledger-counts.mjs` |
| 9 | 管理页同步 | `admin/app.js:43/:294/:2245`「五页签」→六 · `admin/index.html:310-320` 页签注释/按钮 · 顶栏三新视图 · 来源下拉 +5（`admin/index.html:144-150`）· `slice-19-admin-rbac-audit.ts:1399-1438` G12 静态串追加支付端点 |
| 10 | `docs/design.md` | 服务表（3007/9007）· env 表 + NEW_ENVS 判据 · 二十五→三十四键 · 15xxx · 客户端第 6 页 |
| 11 | `docker-compose.yml` | 新服务块 + 测试注入 env 行（§13.3） |
| 12 | 手册 | `docs/ops/first-deploy.md` 两新节 + 计数（§12） |
| 13 | 监控/门口/注册面（r2 🟢-6 补收） | `deploy/monitoring/prometheus/prometheus.yml`（第 15 job）· `rules/ftl-alerts.yml`（+5 规则，与 #1 的 18→23 互锁）· `deploy/Caddyfile`（`/pay/notify/*` handler）· `tools/conformance/src/run.ts`（slice-21 注册；缺席会被 `check-baselines.mjs` 红住） |

### 13.5 六阶段与验收闭环

照既定：六阶段 push 前跑一次；全序 conformance = CI 权威轮；上线前**沙箱联调**（真支付宝沙箱走一遍 下单→付→回调→入账→退款）——**唯一无法本地覆盖**的验证，列为打 tag 前置（§14 R2）。

---

## §14 残余风险与评审重点

| # | 风险 | 处置/口径 |
|---|---|---|
| R1 | 商户号未就绪（+ 应用签约「手机网站支付」+ 回调域名核对） | 不阻塞开工（沙箱+stub 全链可测）；阻塞真上线；上线时点由用户给 |
| R2 | **沙箱联调不可本地覆盖**：真实支付宝行为（两口径验签细节、回跳体验）可能与实现有差 | 打 tag 前置 = 沙箱真单走一遍全链；差异入修订；金标向量随之采集入仓 |
| R3 | cap 公式是分池唯一实现点，语义错=资金口径错 | §5.1 演算表全量入测；**评审专项审此公式**（含「为何不选双池列」的论证）；纪律=动作时刻锁内取数禁缓存 |
| R4 | 管理加币不可离场：运营补偿诉求无法通过 cap 出金 | 显式登记；补偿走退款/线下人工；若需加币可提须新裁决 |
| R5 | **机器人池 → 可提出金路径**（r1 🟡-5）：金币场池=机器人净输给人的缓冲（gold-room-design §5.3，池由管理面注入）；玩家赢机器人 ⇒ 池钱经 `game_settle` 计入 cap ⇒ **可提真钱** | 显式登记；哨兵 = `CurrencyRobotPoolLow` 告警**升格理解为资金外流预警**（池快速下降=可能被系统性提款）；若成形态 ⇒ 新裁决（备选：池上限/机器人强度/机器人局口径细分）。v1 不堵 |
| R6 | **对局洗白路径**（r1 🟡-5）：救助/赠送可经「对同伙故意输」洗成赢家的可提余额（零和+零抽水下洗白成本≈0） | 显式登记；缓解 = 风控谓词（`sameDevice/sameIp`，**默认关**，开法见风控片手顺）+ 观测；当前赠送=0、救助关 ⇒ 即期敞口有界 |
| R7 | 自实现 RSA2 规范化算法 vs 引 SDK | 零依赖 + 金标向量（**两口径**）；低置信项 = 值含特殊字符时的规范化细节，沙箱实测钉死；评审可推翻改 SDK |
| R8 | 账单文件级对账不做 | 订单级查询+日自检覆盖 v1；触发条件登记（§1.2） |
| R9 | 线下打款的运营风险（打错/重复付） | 台账纪律（未登记=未打款）+ claim 互斥 + 超时回滚 + 限额；收款账号线下核对显式登记 |
| R10 | 时区/显示口径 | 存储 UTC；按日（+08:00）照 ③ CONVERT_TZ；规格期实测钉死 |
| R11 | 单实例扫描 | 条件更新使扫描可重复执行（多实例安全）；不做分布式锁（现单实例） |
| R12 | **孤儿 hold**（r1 阻断-2 衍生）：apply 远程成功但本地事务提交失败 ⇒ ledger 有锚、本地无行 | 概率极低（提交失败窗口=毫秒级）；哨兵 = 日自检**锚勾稽**告警（§10）；修复判据 = **同单已有行 ⇒ 回滚孤儿；无行 ⇒ 补行（按冻结事实记 `pending`）** |
| R13 | 渠道退款窗口/权限未知面（v1.0 登记项重编号时失收，r2 找回） | 以支付宝返回为准；失败留 `approved` + `last_error` + 退避表（§2.5）+ 人工面（再试/驳回） |

---

## §15 下一期交接预埋

- **微信渠道**：`PaymentChannel` 接口已抽出（第二个实现）；需要：JSAPI 生态（公众号+认证）或 H5 产品决策。
- **API 自动出款**（P2 推后）：提现状态机的 `approved → paid` 换执行者（渠道转账 API + 回调/查询），核心数据面不变；届时收编玩家收款账号形态。
- **APP 支付**产品（App 原生唤起）；**账单文件级对账**（§1.2 触发条件）；**部分退款**；**提现手续费**；**用户级白名单机制**（若 P5 软口径不够）。

---

## 附录 A 与参考文档差异 / #21 · #28 · #29 结案

1. **§3.2 HMAC-SHA256 + ±5min + Nonce 方案不适用**（口径偏离，显式登记）：该方案面向参考文档自构思的「统一 webhook 网关」（渠道与本方共享密钥）。真实支付宝回调 = **RSA2 私钥签名，本方公钥验签**——不存在共享密钥，HMAC 无对象。防重放等价物（更强）：**签名不可伪造 + 订单状态条件更新 + `currency.apply` 锚**三重；不设时间窗（窗口只会误杀重试通知）。
2. **#21 结案**：Nonce 方案不采用（上条）。若未来接**共享密钥型** webhook 渠道，钉死：Redis key **`pay:nonce:<channel>:<nonce>`**、**TTL 600s（=2×5min 窗）**、`SET NX` 命中即重放拒——此为 #21 的最终答案。
3. **#28 结案**：本片零被调 RPC 暴露面；跨服务调用只有既有的 `currency.apply` / `currency.get` 与新增只读 `currency.withdrawable.get`——三者 DTO 全部定义在 `packages/protocol`（单点真源，禁双份实现）；新 pattern 进 `RPC_PATTERNS` + 三件套闸（§13.4 #5）。
4. **#29 结案（重试表）**：`currency.apply` = 同载荷原样重发、锚不变（重放返回原结果；**重复扣费在机制上不可能**）· `trade.query`/`trade.close` 可重试（退避表 §2.5）· `trade.refund` 带 `out_request_no` 幂等（**重复退款不可能**）· `trade.wap.pay` 对同 `out_trade_no` 幂等 · 出站上限后转人工/告警（数值见 §2.5）。
5. 参考文档「提现超时自动回滚」（`timeout_at` + 扫描）**采纳**（§5.3 修正版：claim 先行 + holding 只解析不回滚）；其 14006/14007 名目收编（§8）。
6. **锚名形状偏离登记（r1 🟡-9）**：货币设计 §5.1 冻结表预留写 `refund:<orderId>`——本片细化为 **`refund:<refundNo>`**（per-申请锚）。理由：驳回/失败后重报必须换锚，否则同锚重放会命中上一次冻结（同 id 同载荷 ⇒ 返回原结果、冻结不生效）；冻结表的原行是**形状指针**而非冻结语义。`pay:<orderNo>` 与原表一致。

## 修订记录

- **v1.0**（2026-10-05，`e0e2ce2`）：首稿（含用户四裁 P1–P4 + 上线形态提案 P5）。
- **v1.1**（2026-10-05）：r1 评审（**2 阻断 + 11🟡 + 8🟢 + 锚点核验 21 处误 2**）全数处置——**阻断-1** 退款改「申请即冻结」+ cap 动作时刻纪律（§2.4/§6.1）· **阻断-2** 提现 holding 只解析不回滚 + claim 先行 + 恢复扫描 + `applied_at` 废除（§2.5/§3/§5.3）· 新增 `payment_user_locks` 行锁串行化（§2.4/§3/§5.2）· §13.4 改逐文件核销表（🟡-1）· 财务视图口径改「后端零改动+下拉扩项」（🟡-2）· 管理页同步面细化（🟡-3）· 资金动作统一恢复模型（🟡-4）· cap 论证改写+机器人池/洗白两路径登记（🟡-5→§14 R5/R6）· 回调桶口径与 Redis fail-open 钉死（🟡-6）· stub 改固定名容器+notify 经门口（🟡-7）· 四处一致性收口（🟡-8）· 已退保留槽+锚名偏离登记（🟡-9→附录 A-6）· P5 白名单软口径（🟡-10）· 验签两口径拆分（🟡-11）· 🟢 八条全收（客户端映射表/下单复用限定/出站表述/redact PEM/退避数值/金额整数解析/日限边界/手册订正）。评审报告：`.superpowers/sdd/2026-10-05-payment/review-design-r1.md`。
- **v1.1.1**（2026-10-05）：r2 复审**零阻断（可通过进规格）**、r1 全部 21 项核销；**4🟡 + 6🟢 + 锚点误 2 照办**——未落账 hold 占位拒新申请 + cap fail-closed（🟡-1）· §2.5 周期统一 60s、告警阈值分档对齐 §10（🟡-2）· R13 找回 + §6.1 指针订正（🟡-3）· Redis 承诺降措辞不破数字链（🟡-4）· 锁内 RPC 超时 3s 钉死（🟢-1）· 回滚明确失败留停留态（🟢-2）· R12 修复判据（🟢-3）· 限流指针 / 七循环 / 核销表补四项 + 行号订正（🟢-4/5/6 + 锚点误 2）。**设计到此冻结。** 评审报告：`.superpowers/sdd/2026-10-05-payment/review-design-r2.md`。
- **v1.1.2**（2026-10-06）：**波 5 实现评审 🟡-1 处置**（小补实现，评审报告：`.superpowers/sdd/2026-10-05-payment/review-wave5.md`）——§11.4 措辞订正（「uni-app webview」前提与实现现实不符：App 页面 JS 跑在 service 上下文 ⇒ 改「App 宿主经 `plus.runtime.openURL` 尽力唤起；H5 直跳；唤不起 ⇒ 降级文案」）；§1.1 #10 同前提一行同步；`apps/client/src/net/pay.ts#jumpToCashier` 落实 App 分支 + 三例测试。
