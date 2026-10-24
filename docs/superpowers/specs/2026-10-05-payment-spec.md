# 支付片：规格层 v1.1.1（冻结）

> **承接**：设计 v1.1.1（`docs/superpowers/specs/2026-10-05-payment-design.md`，`1e20a3f`；r1 两阻断 + r2 零阻断，**设计冻结**）。本文 = 形式化层（契约/判据/表/文案写死）。
> **作者**：协调者（opus）；**状态**：**v1.1.1 —— 规格冻结**（r1 2 阻断+9🟡+13🟢 全处置；r2 零阻断 + 3🟡+8🟢 照办）。
> **裁决承接口径**：J4 范围全含 · P1 支付宝首期 · P2 人工审+线下打款 · P3 1元=100金币+分池（可离场额度）· P4 人工审原路退 · P5 暗上线（开关默认关）+ 白名单软口径——逐条见设计 §0。

---

## 0. 承接与订正

### 0.1 上游与版本

- **范围真源**：交接 `docs/superpowers/plans/2026-10-05-payment-handoff.md` + 路线图 `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` P2′ + 附录 `docs/appendix/platform-roadmap.md` §3.2/§3.3/§6。
- **设计基线**：设计 v1.1.1 全部章节；§14 为风险与评审重点表。
- **评审链**：`.superpowers/sdd/2026-10-05-payment/review-design-r1.md`（2 阻断+11🟡+8🟢）· `review-design-r2.md`（零阻断+4🟡+6🟢）。
- **本次实读锚点**（起草期核对）：`packages/protocol/src/rpc.ts:42`（`RPC_PATTERNS`，现 **14** pattern）· `packages/protocol/src/errors.ts:81`（`CLIENT_ACTION: Record<ErrCode, ClientAction>` 穷尽表）· `packages/user-service/src/currency/currency.client.ts:69`（`CURRENCY_CLIENT_TIMEOUT_MS = 3000`）· `packages/protocol/src/config.ts`（`CONFIG_KEYS` 二十五 / `CLIENT_CONFIG_KEYS` 七键裸名：`baseScoreLevels, friendRoomEnabled, freeRoomEnabled, goldRoomEnabled, reliefEnabled, entryMultiplier, version`）· `packages/currency-service/src/migrations/1789600000000-Currency.ts:33-39`（账户表 PK=`owner_id`）。

### 0.2 P1–P5 承接（逐条对位）

| 裁决 | 本规格落点 |
|---|---|
| P1 支付宝首期 | §1.1 渠道单实现（`channel/` 文件清单）；§1.3 微信不做 |
| P2 人工审+线下打款 | §3.2 提现状态机 + §5 管理面确认（voucher）；零出站资金 API |
| P3 1：100+分池 | §2.5 键 28 种子 100；§2.2 `currency.withdrawable.get` 契约 + **§2.2.1 cap 公式与演算表** |
| P4 人工审原路退 | §3.3 退款状态机（申请即冻结→审→渠道退） |
| P5 暗上线 | §2.5 键 26/27 种子 false；手册五步 = 设计 §12 + §1.2 docs 行；软白名单（设计 §0 注） |

### 0.3 ⚙️ 规格级裁定（起草期就地定死；来源 = 设计低置信项 + 本次实读）

| # | 事项 | 裁定 |
|---|---|---|
| ⚙️1 | 迁移号 | payment-service 建表迁移 = **`1791000000000-Payment.ts`**（自有 `migrations_payment` 表，号段独立）；config-service 种子迁移 = **`1791000001000-PayConfigSeed.ts`**（现有最大 `1790000001000`） |
| ⚙️2 | 端口与 RPC | HTTP **3007** / metrics **9007**；**不开 TCP**（零被调 RPC 面）；作为客户端调 currency（TCP 3104：`currency.apply` / `currency.get` / 新 `currency.withdrawable.get`）与 config（`config.snapshot` 订阅）；**RPC 超时一律 3000ms**（`currency.client.ts:69` 同值先例） |
| ⚙️3 | 密钥 env 形态 | `ALIPAY_APP_ID`（明文）· `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` = **base64(PEM)**（运维 `base64 -w0 key.pem`）；`ALIPAY_GATEWAY_URL` 默认 `https://openapi.alipay.com/gateway.do`；**每次调用读**，缺失/解码失败 ⇒ 渠道调用返 15001（**不阻塞容器启动**——暗上线期无密钥可起） |
| ⚙️4 | 单号形状 | `pay_` / `rf_` / `wd_` + base36(毫秒时间戳) + 6 位随机 base36 ⇒ 字符集 `[0-9a-z_]`、长 ≤ 32（满足支付宝 out_trade_no 约束）；UK 兜底 |
| ⚙️5 | 金额算法 | `fen2yuan(fen)` = `` `${Math.floor(fen/100)}.${String(fen%100).padStart(2,'0')}` ``（禁浮点）；`yuan2fen(s)`：`/^[0-9]{1,7}(\.[0-9]{1,2})?$/` ⇒ 整数分；金币兑换 `coins = packageYuan × coinPerYuan`（1:100 ⇒ **1 元 = 100 币 = 100 分（1 币 = 1 分）**）；提现换算 `amount_fen = floor(coins × 100 / coinPerYuan)`（不足 1 分 ⇒ 拒，15003——§3.2） |
| ⚙️6 | 验签两口径（逐字） | **①通知**：取除 `sign`/`sign_type` 外参数 → 按参数名 **ASCII 升序** → `k=v` 以 `&` 连接（值=解码后原文，不二次编码）→ `crypto.verify('RSA-SHA256', Buffer.from(canonical,'utf8'), 支付宝公钥PEM, Buffer.from(sign,'base64'))`。**②OpenAPI 同步响应**：解析 JSON 后取 **`<api>_response` 键对应值的原文子串**字节对 `sign` 验签（不是重排序）。**出站请求签名**：全参数 + `sign_type=RSA2` 按名升序 `k=v&` → 应用私钥 RSA-SHA256 → `sign`（base64，随表单 urlencode）。金标向量 ≥4 组 `packages/payment-service/test/fixtures/alipay/*.json`（来源=官方示例 + 沙箱联调采集，采集前用自造+双向 stub 验证） |
| ⚙️7 | notify 应答 | 纯文本 body；成功 ⇒ `200` + `success`；需重试 ⇒ `200` + `failure`（**不用 5xx**——防反代错误页破坏 body；支付宝只认 body=success） |
| ⚙️8 | HTTP_STATUS（payment 服务端） | 10001→400 · 15001→502 · 15002→404 · 15003/15004/15005/15006/15008/**15009**→409 · 15007→不出站（日志+指标）。**不补则 4xx 静默变 500**（货币片 §8 学费） |
| ⚙️9 | 新错误码 | 设计表 15001–15007 **+15008 PAY_DISABLED**（充值开关关——提现开关关走 15003 既有语义）**+15009 PAY_STATE_CONFLICT**（管理写面源态冲突；HTTP 409；message 含当前态与合法动作）；`CLIENT_ACTION` 穷尽表：15001–15006、15008、15009→`TOAST`；**15007→`IGNORE`**（服务端内部面，且**入 `RESERVED_CODES`**——照 `BOT_DECISION_TIMEOUT` 先例：内部事件码／只日志+指标／不作响应码） |
| ⚙️10 | policy 条目（显式枚举，照 ③ N1） | **P-p1** 订单读（`GET /api/admin/pay/orders` + `.csv` + `/:orderNo`）· **P-p2** 退款读（同族三端点）· **P-p3** 提现读（同族三端点）· **P-p4** 处置流水读（`GET /api/admin/pay/actions` + `.csv`）——四条读面**显式登记**（条目 `return true`，**不落 P8 兜底语义**；单测随形态）；**P-p5** `POST /api/admin/pay/refunds/:refundNo/review` · **P-p6** `POST /api/admin/pay/withdrawals/:withdrawNo/review` · **P-p7** `POST /api/admin/pay/withdrawals/:withdrawNo/confirm`——三条 **`super_admin|finance`**（照 P6） |
| ⚙️11 | 客户端键（裸名） | 新增 7 裸名：`rechargeEnabled` / `withdrawEnabled` / `coinPerYuan` / `rechargePackages` / `withdrawMinCoins` / `withdrawMaxCoinsPerOrder` / `withdrawDailyMaxCoins` ⇒ `CLIENT_CONFIG_KEYS` 7 → **14**（`protocol/src/config.ts` 单点）；组装在 `config-service/src/config/client-config.controller.ts` |
| ⚙️12 | 指标 10 / 告警 5（逐字） | §2.6；表达式按设计 §10 语义钉死（分档阈值 15m/1h） |
| ⚙️13 | Caddyfile 片段 | §2.7.1（`handle /pay/notify/*`，放 catch-all 前） |
| ⚙️14 | stub 支付宝 | 固定名容器 **`ftl-alipay-stub`**（**白吃 `conformance-stack.sh:88` 的 `^/ftl-` 残留检查**；down 段另显式 **`docker rm -f ftl-alipay-stub || true`**——位置=compose down 之后、:88 残留检查之前……双保险），端口 8801，入 compose 网络；起法 = `docker run -d --rm --name ftl-alipay-stub --network <net> -v "$PWD/tools/conformance/stub:/app:ro" node:20-alpine node /app/alipay-stub.mjs`（**宿主绑挂仅限测试容器**，登记；**Windows/Git Bash 照 `scripts/ops/backup.sh:7-11` / `restore-drill.sh:54-56` 纪律：`export MSYS_NO_PATHCONV=1` + 宿主侧路径原生形态——Linux no-op**）；**仅测试密钥对入仓**：`tools/conformance/fixtures/alipay-test/`（四 PEM）——**生产密钥永不入仓、只存服务器 .env**；双向金标（stub 验我们请求签名；我们验 stub 响应/通知签名）；payment-service 测试值经透传 env（⚙️18）+ `ALIPAY_GATEWAY_URL=http://ftl-alipay-stub:8801` |
| ⚙️15 | 幂等槽 | `active_slot tinyint NULL`：在途=1；提现终态（`paid/rejected/timeout_rolled_back/failed`）置 NULL；**退款 `refunded` 保留 1**（已退结构标记），仅 `rejected/failed` 置 NULL；`UNIQUE(user_id,active_slot)` / `UNIQUE(order_no,active_slot)` |
| ⚙️16 | 扫描周期 | 单 env `PAY_SCAN_INTERVAL_MS`（默认 60000，测试 2000）；七循环共用；**loop 内条件更新 ⇒ 可重复执行**；日自检独立 env **`PAY_RECONCILE_INTERVAL_MS`**（默认 86400000；**启动后 30s 首跑**照记录片先例——⑯ 判据由此可执行），测试 2000 |
| ⚙️17 | 日自检 SQL 口径 | 入账勾稽：`Σ payment_orders.coins(status='credited') == SUM(f.delta) FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id WHERE o.source='recharge'`（**`source` 在 ops 不在 flows**——**照 `finance-query.service.ts:55-58` 先例写法**）；锚勾稽：当日 `currency_ops.action_id` 前缀 ∈ {`pay:`,`refund:`,`refund_rb:`,`withdraw:`,`withdraw_rb:`} 的锚集 ↔ 本地三表存在性 diff（有锚无行=孤儿；行无锚=仅 `holding` 合法） |
| ⚙️18 | 测试注入 | **透传行形态**（照 `docker-compose.yml:177/:182` 先例）：payment 段 +6 行 `- VAR=${VAR:-}`（`PAY_SCAN_INTERVAL_MS` / `PAY_RECONCILE_INTERVAL_MS` / `ALIPAY_GATEWAY_URL` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY`）——**空串=未设（消费侧用 `\|\|` 不用 `??`）、生产不设**；测试值（含 PEM→base64 生成）由 `conformance-stack.sh` export 注入；登记进测试 env 清单（风控片先例） |

---

## 1. 改动面一览

### 1.1 新增文件

- **payment-service（新包，第 8 个 Nest；脚手架照 currency-service）**：`src/main.ts` · `src/app.module.ts` · `src/config/{config.module.ts,config-cache.service.ts,config.client.ts}`（照 `packages/currency-service/src/config/` 三件**逐名**拷贝）· `src/channel/payment-channel.interface.ts` · `src/channel/alipay/sign.ts` · `src/channel/alipay/client.ts` · `src/channel/alipay/params.ts` · `src/orders/{orders.service,orders.controller,order-state}.ts` · `src/notify/{notify.controller,notify.service}.ts` · `src/refund/{refund.service,refund.controller}.ts` · `src/withdraw/{withdraw.service,withdraw.controller}.ts` · `src/wallet/wallet.controller.ts` · `src/admin/admin-pay.controller.ts` · `src/scan/scan.service.ts` · `src/locks/user-lock.service.ts` · `src/rpc/currency.client.ts` · `src/metrics/payment.metrics.ts` · `src/http/errors.ts` · `src/migrations/1791000000000-Payment.ts` · `Dockerfile.payment-service` · 单测全家（§6.1）。
- **currency-service**：`src/rpc/withdrawable.rpc.controller.ts` · `src/currency/withdrawable.service.ts` · 单测。
- **config-service**：`src/migrations/1791000001000-PayConfigSeed.ts` · 迁移/客户端判据测试更新。
- **protocol**：`src/payment.ts`（REST DTO 类型 + 单号形状常量）· 三处既有文件增修（§1.2）。
- **conformance**：`tools/conformance/src/slices/slice-21-payment.ts` · `tools/conformance/stub/alipay-stub.mjs` · `tools/conformance/fixtures/alipay-test/`（4 个 PEM）。
- **admin**：无新文件（三处修改，§1.2）。
- **client**：`apps/client/src/pages/wallet/wallet.vue` · `apps/client/src/net/pay.ts` · 测试 `test/wallet*.test.ts`。
- **deploy**：`deploy/monitoring/grafana/dashboards/07-payment.json`。

### 1.2 修改文件（按包）

- **protocol**：`currency.ts`（`CURRENCY_SOURCES` +5：`recharge/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback`）· `rpc.ts`（`RPC_PATTERNS.currencyWithdrawableGet = 'currency.withdrawable.get'` + re-export）· `errors.ts`（+9 码 + `CLIENT_ACTION` 穷尽）· `config.ts`（+9 键 + 客户端 +7 裸名 + 解析分支）· 对应 `*.test.ts`（计数 14→15 / 七→十四 / SPEC_CODES）。
- **config-service**：`client-config.controller.ts`（组装 +7）。
- **api-gateway**：`auth/admin-policy.ts`（+P-p1..P-p7）· `gateway/gateway.controller.ts`（+8 管理路由 + `forwardToPaymentSvc` 族）· `gateway/proxy.gateway.ts`（`/api/pay/*` 玩家转发）· env（`PAYMENT_SERVICE_URL`）· 单测。
- **currency-service**：`app.module.ts`（注册 withdrawable RPC）· ConfigCache 无改。
- **admin**：`index.html`（三视图壳 + 审计第六页签 + 来源下拉 +5）· `app.js`（三视图逻辑 + 第六页签 + 字面量「五页签→六」）· `style.css`（如需）。
- **client**：`pages.json`（+wallet）· `pages/lobby/lobby.vue`（钱包区入口）· `stores/game.ts`（客户端配置 +7 字段）· 测试。
- **deploy**：`prometheus/prometheus.yml`（+job 15）· `prometheus/rules/ftl-alerts.yml`（+5 规则）· `Caddyfile`（+handler）· `docker-compose.yml`（+服务 + test env）· `scripts/deploy/{build-images.sh,conformance-stack.sh}` · CI `images.yml` 等计数。
- **conformance**：`src/run.ts`（注册 slice-21）· `baselines.json`（回填）。
- **shared**：`src/logging/redact.ts`（+PEM 私钥形态规则）+ `redact.test.ts`。
- **docs**：`design.md`（服务表/env/键数/15xxx/客户端第 6 页）· `first-deploy.md`（两新节 + 计数）· `client-protocol.md`（pay REST 面）· `post-mvp-roadmap.md` 回填 · 台账。
- **闸族**：设计 §13.4 逐文件核销表 13 行全部（含 `slice-16-monitoring.ts` / `slice-07.2-deploy.ts` / `slice-14-config-center.ts` / `messages.test.ts` / `no-raw-console` / `outbound-timeout` / `container-assembly` / `service-name` / dockerfile 两个 gate / `slice-07.2-hardening` / `slice-07.4-pipeline`）。

### 1.3 明确不在改动面（有意）

微信/其他渠道实现 · 支付宝 APP 支付 · 账单文件级对账 · 部分退款 · 自动审/自动出款 · 用户级白名单机制 · 优惠营销 · 多币种 · KYC · 玩家间转账 · 对局/结算/门槛/救助任何代码 · 货币写路径（`currency.apply`/账户表/类型闸不动——只加只读 RPC）· 网关五维限流结构 · edge 其它路由 · `16xxx` 错误码段。

---

## 2. 新契约（写死）

### 2.1 protocol：currency 面

- `CURRENCY_SOURCES`（`currency.ts:17`）追加 5 源（`recharge/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback`，见 §1.2），**顺序=追加在尾**（allowlist 判据按集合，顺序无关，照既有测试改法）。
- `MAX_ABS_DELTA_BY_SOURCE`：新 5 源**不设专属上限**（走缺省 1,000,000 ✓ 覆盖 500 元=50,000 币与 1000 元/日）。
- 校验不变：`validateCurrencyApply` 全复用；`ownerType` 恒 `'user'`。
- **锚（actionId）形状**：`pay:<orderNo>` · `refund:<refundNo>` · `refund_rb:<refundNo>` · `withdraw:<withdrawNo>` · `withdraw_rb:<withdrawNo>`（附录 A-6 偏离登记）。

### 2.2 protocol：RPC 与客户端配置

- `rpc.ts`：`currencyWithdrawableGet: 'currency.withdrawable.get'`；
  `CurrencyWithdrawableGetRequest = { ownerId: string }`；
  `CurrencyWithdrawableGetResponse = { cap: number; balance: number }`（cap 已 clamp，`cap ≤ balance`；`balance` 与 `currency.get` 同源读）。
- `config.ts`：`CONFIG_KEYS` 25 → **34**（键名与种子见 §2.5）；`CLIENT_CONFIG_KEYS` 7 → **14**。

#### 2.2.1 `currency.withdrawable.get` 的 cap 语义（分池唯一实现点；照设计 §5.1 收编为用例表）

```
cap_raw(user) = Σ flows.delta  where source ∈ { recharge, game_settle,
                                              refund_hold, refund_rollback,
                                              withdraw_hold, withdraw_rollback }
cap(user)     = max(0, min(cap_raw, balance))
```

- **消费面纪律（硬）**：两个消费面（提现/退款）在**资金动作时刻（锁内，§3.6）**执行本 RPC——**禁缓存、禁只查一次**；**RPC 取数失败 ⇒ fail-closed 拒申请**（15003/15006——不确定不放松）。`cap ≤ balance` 由 `min` 结构恒成立。
- 演算用例表（单测 §6.1#5 与 ⑬ 逐行收编）：

| # | 场景 | cap | 说明 |
|---|---|---|---|
| ① | 充值 600，未动 | 600 | 正常 |
| ② | 充值 600 + 救助 200，未动 | 600 | 救助沉淀，不可离场 |
| ③ | 充值 600 + 救助 200，净输 150 | 450 | 输先垫白来的钱，额度按净额收缩 |
| ④ | 无充值 + 救助 200，净赢 300 | 300 | 赢取可提（机器人局=池钱 → 设计 §14 R5） |
| ⑤ | 充值 600，已退 600 | 0 | 冻结/回滚按自然符号计入 |

### 2.3 数据表 DDL 逐字（迁移 `1791000000000-Payment.ts`）

```sql
CREATE TABLE IF NOT EXISTS `payment_orders` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_no` varchar(32) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `package_yuan` int NOT NULL,
  `amount_fen` int NOT NULL,
  `coins` int NOT NULL,
  `coin_per_yuan` int NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'created',
  `channel` varchar(16) NOT NULL DEFAULT 'alipay',
  `trade_no` varchar(64) NULL,
  `expires_at` datetime(3) NOT NULL,
  `paid_at` datetime(3) NULL,
  `credited_at` datetime(3) NULL,
  `closed_at` datetime(3) NULL,
  `late_reopen_at` datetime(3) NULL,
  `last_error` varchar(255) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `uk_order_no` (`order_no`),
  KEY `idx_orders_user_created` (`user_id`,`created_at`),
  KEY `idx_orders_status_expires` (`status`,`expires_at`),
  KEY `idx_orders_status_paid` (`status`,`paid_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `payment_refunds` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `refund_no` varchar(32) NOT NULL,
  `order_no` varchar(32) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `amount_fen` int NOT NULL,
  `coins` int NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'holding',
  `reason` varchar(255) NOT NULL,
  `reviewed_by` varchar(64) NULL,
  `reviewed_at` datetime(3) NULL,
  `review_note` varchar(255) NULL,
  `channel_out_request_no` varchar(64) NOT NULL,
  `channel_refund_no` varchar(64) NULL,
  `hold_confirmed_at` datetime(3) NULL,
  `refunded_at` datetime(3) NULL,
  `last_error` varchar(255) NULL,
  `active_slot` tinyint NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `uk_refund_no` (`refund_no`),
  UNIQUE KEY `uk_refunds_order_active` (`order_no`,`active_slot`),
  KEY `idx_refunds_user_created` (`user_id`,`created_at`),
  KEY `idx_refunds_status_created` (`status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `payment_withdrawals` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `withdraw_no` varchar(32) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `coins` int NOT NULL,
  `amount_fen` int NOT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'holding',
  `timeout_at` datetime(3) NOT NULL,
  `hold_confirmed_at` datetime(3) NULL,
  `reviewed_by` varchar(64) NULL,
  `reviewed_at` datetime(3) NULL,
  `review_note` varchar(255) NULL,
  `confirmed_by` varchar(64) NULL,
  `confirmed_at` datetime(3) NULL,
  `voucher` varchar(64) NULL,
  `confirm_note` varchar(255) NULL,
  `rolled_back_at` datetime(3) NULL,
  `rollback_reason` varchar(16) NULL,
  `last_error` varchar(255) NULL,
  `active_slot` tinyint NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `uk_withdraw_no` (`withdraw_no`),
  UNIQUE KEY `uk_withdrawals_user_active` (`user_id`,`active_slot`),
  KEY `idx_withdrawals_status_timeout` (`status`,`timeout_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `payment_notify_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_no` varchar(32) NOT NULL,
  `result` varchar(24) NOT NULL,
  `trade_status` varchar(32) NULL,
  `amount_fen` int NULL,
  `raw_payload` text NULL,
  `client_ip` varchar(64) NULL,
  `received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), KEY `idx_notify_log_order` (`order_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `payment_user_locks` (
  `user_id` varchar(36) NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

- 表名/索引名全部带前缀（`idx_orders_*` 等）防共享库撞名。`notify_log` 仅记**验签通过**件（失败只计数+日志）。
- **字段写点**：`last_error`（orders=过期关闭/补单查询失败摘要；refunds=渠道退款失败摘要；withdrawals=解析/回滚失败摘要）· `hold_confirmed_at`（refunds/withdrawals：holding→pending 落账时刻，§3.2/§3.3）。

### 2.4 HTTP 契约（REST；错误体沿用既有 `{code,message}`）

#### 2.4.1 玩家面（`/api/pay/*`，用户 JWT）

| # | 端点 | 请求 | 响应 | 错误 |
|---|---|---|---|---|
| 1 | `POST /api/pay/orders` | `{packageYuan:int}` | `200 {orderNo,payUrl,expiresAt}` | 10001（非法档位）· 15008（开关关）· 15001（渠道） |
| 2 | `GET /api/pay/orders/:orderNo` | — | `200 {orderNo,status,coins,amountYuan,packageYuan,createdAt,paidAt,creditedAt,closedAt}` | 15002 |
| 3 | `POST /api/pay/orders/:orderNo/sync` | — | 同 2（触发主动查询） | 15002 |
| 4 | `GET /api/pay/orders/mine?cursor=&limit=` | keyset（默认 20，≤50） | `200 {items[],nextCursor}` | — |
| 5 | `GET /api/pay/wallet/summary` | — | `200 {balance,withdrawable,dailyWithdrawRemainingCoins}`（末项按 §3.2 日限口径实算——客户端「剩余可申额度」的数据源） | — |
| 6 | `POST /api/pay/refunds` | `{orderNo,reason≤255}` | `200 {refundNo,status}` | 15002 · 15006（任一条件不满足，message 区分） |
| 7 | `GET /api/pay/refunds/mine` | keyset | `200 {items[],nextCursor}` | — |
| 8 | `POST /api/pay/withdrawals` | `{coins:int}` | `200 {withdrawNo,status}` | 15003 · 15004 · 15005 |
| 9 | `GET /api/pay/withdrawals/mine` | keyset | `200 {items[],nextCursor}` | — |

- **路由注册次序**：静态段（`/mine`）**先于**参数段（`/:orderNo`）注册——单测钉住（`GET /api/pay/orders/mine` 不得 15002）。
- 限流（网关）：1=10/分 · 3=30/分 · 6/8=5/分（用户维；规格钉死，作用在网关既有限流中间件——新增桶照五维先例）。

#### 2.4.2 管理面（`/api/admin/pay/*`，admin JWT + policy §0.3-⚙️10）

| # | 端点 | 说明 |
|---|---|---|
| 1 | `GET /api/admin/pay/orders[.csv]?status=&userId=&from=&to=&cursor=` | 列表（CSV 列 §5.3） |
| 2 | `GET /api/admin/pay/orders/:orderNo` | 详情（含 `notify_log` 尾 20 条） |
| 3 | `GET /api/admin/pay/refunds[.csv]?status=&userId=` + `/:refundNo` | 同族 |
| 4 | `POST /api/admin/pay/refunds/:refundNo/review` | `{action:'approve'\|'reject',note?}`；approve：`pending→approved`（claim）后**同步**调渠道退款（成功⇒`refunded`；明确失败⇒留 `approved`+`last_error` 200 返回实际态） |
| 5 | `GET /api/admin/pay/withdrawals[.csv]?status=&userId=` + `/:withdrawNo` | 同族（详情含余额/cap 快照读） |
| 6 | `POST /api/admin/pay/withdrawals/:withdrawNo/review` | `{action:'approve'\|'reject',note?}`；approve：`pending→approved`；reject：claim→`rolling_back(reason=rejected)`→回滚 |
| 7 | `POST /api/admin/pay/withdrawals/:withdrawNo/confirm` | `{voucher≤64,note?}`；claim `WHERE status='approved'`⇒`paid` |
| 8 | `GET /api/admin/pay/actions[.csv]?from=&to=&actor=` | **审计第六源**：三表处置事件流（申请/审/驳回/确认/回滚，含 actor+时刻） |

- 全部写面：actor 取网关注入 `x-admin-actor`；非法源态 ⇒ **HTTP 409 + code 15009**（message 含当前态与合法动作——测试断言 `{code,message}`）；write 面全审计（第六源即其读口）。CSV：BOM + 公式注入消毒（照 ③ R7 判别式）。

### 2.5 配置键与种子（`1791000001000-PayConfigSeed.ts`；26–34）

| # | 键 | 种子 | 说明 |
|---|---|---|---|
| 26 | `pay.rechargeEnabled` | `false` | 暗上线 |
| 27 | `pay.withdrawEnabled` | `false` | 暗上线 |
| 28 | `pay.coinPerYuan` | `100` | 下单快照 |
| 29 | `pay.rechargePackages` | `[6,30,68,128,328]` | 档位（元） |
| 30 | `pay.withdrawMinCoins` | `1000` | 门槛 |
| 31 | `pay.withdrawMaxCoinsPerOrder` | `50000` | 单笔 |
| 32 | `pay.withdrawDailyMaxCoins` | `100000` | 单日/人 |
| 33 | `pay.orderExpireMinutes` | `30` | 有效期 |
| 34 | `pay.withdrawTimeoutMinutes` | `4320` | 超时回滚（分钟） |

- 客户端 14 键 = 既有 7 + 7 裸名（⚙️11）；`version` 语义照既有。

### 2.6 指标（10）与告警（5）逐字

指标（port 9007，`payment_` 前缀）：
`payment_notify_total{result}`（result ∈ ok/bad_sign/amount_mismatch/unknown_order/reopen）· `payment_order_pending{state}`（state ∈ pending_pay/paid_uncredited）· `payment_fundop_pending{op}`（op ∈ pay/withdraw_hold/withdraw_rb/refund_hold/refund_rb）· `payment_fundop_oldest_age_seconds{op}` · `payment_fundop_retry_total{op}` · `payment_refund_total{result}`（result ∈ applied/approved/rejected/channel_fail）· `payment_withdraw_pending{state}`（state ∈ pending/approved）· `payment_withdraw_oldest_age_seconds{state}` · `payment_outbound_fail_total{api}`（api ∈ wap_pay/query/refund/close）· `payment_reconcile_diff`。

告警（`ftl-alerts.yml` 追加；语义与设计 §10/§2.5 逐行一致）：
1. `PaymentFundOpStalled`：`payment_fundop_oldest_age_seconds{op=~"pay|withdraw_hold|refund_hold"} > 900 or payment_fundop_oldest_age_seconds{op=~"withdraw_rb|refund_rb"} > 3600` for 5m，warning。
2. `PaymentNotifyBadSignSpike`：`increase(payment_notify_total{result="bad_sign"}[10m]) > 10`，warning。
3. `WithdrawBacklog`：`payment_withdraw_oldest_age_seconds > 172800` for 10m，warning。
4. `PaymentLateNotifyReopen`：`increase(payment_notify_total{result="reopen"}[15m]) > 0`，warning。
5. `PaymentReconcileDiff`：`payment_reconcile_diff > 0` for 10m，critical。
每条带 `runbook:` 注记（照 `:145-157` 风格）。

### 2.7 部署片段

#### 2.7.1 Caddyfile（放 `/grafana` 块之后、catch-all `handle {` 之前）

```caddyfile
	# 支付片：渠道回调公开面。**唯一信任入口 = 验签**（RSA2），不经网关 JWT（设计 §2.2）。
	# ⚠️ 必须在 catch-all handle { 之前（与 /admin、/grafana 同规矩——2026-10-01 实测注记）。
	handle /pay/notify/* {
		reverse_proxy payment-service:3007
	}
```

#### 2.7.2 网关转发

- `/api/pay/*` → payment-service（用户 JWT 中间件内，照 `/api/wallet/*` 先例）；
- `/api/admin/pay/*` → payment-service（admin 中间件 + policy）；
- env **`PAYMENT_SERVICE_URL`** → `design.md` §2.3 env 表 + `design-md-*.gate.test.ts` NEW_ENVS。

#### 2.7.3 compose（payment-service 段）

服务块照 currency-service 模板（非 root、healthcheck `/health`、logging options、**`depends_on` 仅 `mysql(healthy)/redis(healthy)`**——config/currency 走**运行时软依赖**，照 D8-3 纪律与 `docker-compose.yml:188-192/:304-305` 先例）+ **透传 env 6 行**（⚙️18）。

#### 2.7.4 回调防护（`/pay/notify/*` 公网无鉴权写端点的全部防线；照设计 §12 钉死）

- 仅接受 `POST` + `application/x-www-form-urlencoded`（其余 ⇒ 405/415 拒）；body **≤ 16KB**（超 ⇒ 413）。
- 限流：**边缘单桶 600/分**（按 socket peer 如实记——反代后 peer 恒为 edge 容器；**不复制 XFF 信任口径**）；**超桶 ⇒ 429 拒**；**Redis 故障 = fail-open + 响亮 WARN 日志；不新增指标/告警条目**（§2.6 数字链保持 10/5）。
- 应答：纯文本两词（⚙️7）；验签失败 ⇒ `payment_notify_total{result="bad_sign"}`（哨兵 = 告警 §2.6-2）。
- 对位判据：§6.2 ⑰。

### 2.8 文案（逐字；客户端 `CLIENT_ACTION` 全 `TOAST`）

- 15001「支付渠道暂时不可用，请稍后重试」· 15002「订单不存在或已失效」· 15003「提现暂不可用（{低于门槛/已有在途申请/功能未开放/**有处理中申请，请稍后重试**/**服务暂时不可用，请稍后重试**}）」· 15004「超出限额（{单笔/单日}）」· 15005「可提余额不足」· 15006「该笔充值暂不可退（{未入账/处理中/已退过/超出可退额度/**有处理中申请，请稍后重试**/**服务暂时不可用，请稍后重试**}）」· 15008「充值暂未开放」· 15009「状态已变更（管理面；含当前态与合法动作）」。
- 提现记录行态：14006「申请已超时，金币已退回」· 14007「超时自动退回，金币已到账」（**状态提示，非错误码路径**）。
- App 内降级：「请用浏览器打开完成支付」。

---

## 3. 服务端行为（状态机与扫描，逐字）

### 3.1 订单状态机

- 下单：INSERT `status='created'`（§2.1 幂等复用：同用户+同档位+未过期 `created` 单存在 ⇒ 复用返回）。
- 回调（§4.3 设计）：验签 ⇒ 四校验 ⇒ `UPDATE … SET status='paid', trade_no=?, paid_at=NOW(3) WHERE order_no=? AND status='created'`；`affected=1` ⇒ 入账流程；`affected=0` 且现状 ≥paid ⇒ 幂等 `success`；现状 `closed` 且金额匹配 ⇒ `UPDATE … SET status='paid', late_reopen_at=NOW(3) WHERE order_no=? AND status='closed'` ⇒ paid 路径 + `{result=reopen}`。
- 入账：`currency.apply{actionId:'pay:<orderNo>', source:'recharge', refId:orderNo, entries:[{ownerId:userId,delta:+coins}]}` 成功 ⇒ `UPDATE … SET status='credited', credited_at=NOW(3) WHERE order_no=? AND status='paid'`。
- 过期：`UPDATE … SET status='closed', closed_at=NOW(3) WHERE status='created' AND expires_at < NOW(3)`（逐行收集后尽力 `trade.close`；close 报「已支付」⇒ 转 paid 路径）。
- 补单：`created` 且 `created_at < NOW(3) - INTERVAL 5 MINUTE` ⇒ `trade.query`：SUCCESS ⇒ paid 路径。

### 3.2 提现状态机（设计 §5.3 逐字）

```
holding →(解析成功)→ pending →(claim: pending→approved)→ approved →(claim: approved→paid)→ paid
holding →(解析明确失败)→ failed
pending|approved →(claim with reason=rejected)→ rolling_back →(rb 落账)→ rejected
pending|approved →(claim like timeout; scanned pending|approved AND timeout_at<NOW)→ rolling_back →(rb 落账)→ timeout_rolled_back
```

- 申请（锁内 §5.2 设计序）：**校验清单逐字**——开关（15003）· `coins ≥ pay.withdrawMinCoins`（15003）· `coins ≤ pay.withdrawMaxCoinsPerOrder`（15004）· **日限**（15004；**归日口径**：按 `created_at` 落入 **+08:00 自然日**；计入 status ∈ {`holding,pending,approved,paid,rolling_back`} 的 coins 合计——`rejected/timeout_rolled_back/failed` **不计**）· `coins ≤ cap`（§2.2.1；**不足 ⇒ 15005**；**RPC 失败 ⇒ fail-closed 拒，15003「服务暂时不可用」变体**）· **无未解析 `holding`**（提现/退款任一；15003「稍后重试」文案）⇒ INSERT `holding`+`active_slot=1` ⇒ `apply(withdraw:<no>, withdraw_hold, −coins)` ⇒ 成功 UPDATE `status='pending', hold_confirmed_at=NOW(3) WHERE withdraw_no=? AND status='holding'`；明确失败 ⇒ `status='failed'`（槽 NULL）；未知 ⇒ 留 holding。
- **金额快照**：`amount_fen = floor(coins × 100 / coinPerYuan)`（申请时刻配置值）——**行内 `amount_fen` 即出款快照**，后续改配置不影响在途单；换算得 0 分 ⇒ 拒（15003）。
- **时区口径**：存储 UTC；按日与显示一律 +08:00（含管理面 from/to 日界）——照 ③ CONVERT_TZ 先例。
- 解析扫描：`status='holding'` ⇒ 重放同锚（**永不回滚**）；明确成功/失败按上；未知继续+告警（§2.6-1）。
- 驳回/超时 claim 与 confirm 互斥（条件 UPDATE，§5.3 设计）；回滚 `apply(withdraw_rb:<no>, −Δ=+coins)` 落账 ⇒ UPDATE 终态 + `rolled_back_at`；**回滚明确失败 ⇒ 留 `rolling_back` + 告警转人工**（设计 §2.5-④）。
- `timeout_at = created_at + pay.withdrawTimeoutMinutes`。

### 3.3 退款状态机（设计 §6.3 逐字）

```
holding →(解析成功)→ pending →(claim: pending→approved)→ approved →(渠道成功)→ refunded（保留槽）
pending|approved →(claim)→ rejecting →(rb 落账)→ rejected（释放槽）
holding →(解析明确失败)→ failed（释放槽）
approved 渠道明确失败 ⇒ 留 approved + last_error（退避表 §2.5 设计；上限告警）
```

- 申请（锁内）：校验（`order.status='credited'` / 槽 / `coins ≤ cap`（§2.2.1；**RPC 失败 ⇒ fail-closed 拒，15006**）/ 无未解析 `holding`（15006「稍后重试」文案））⇒ INSERT `holding`+`active_slot=1` ⇒ `apply(refund:<no>, refund_hold, −coins)`；成功 ⇒ `UPDATE … SET status='pending', hold_confirmed_at=NOW(3) WHERE refund_no=? AND status='holding'`。`channel_out_request_no = refund_no`。
- 渠道调用（审核通过时同步 + 扫描重放）：`trade.refund{out_trade_no, refund_amount=fen2yuan(amount_fen), out_request_no, refund_reason=reason}`；成功 ⇒ `refunded` + `channel_refund_no` + `refunded_at`；**成功后无后续钱动作**（`refund_hold` 即实际扣减）。
- **未知结果收敛（v1.1.4 调和 §2.5 表与本节）**：审核时就地退避 6 发（§2.5 表）；对**渠道结果未知**（传输级失败——`last_error` 以 **`unknown:`** 前缀标记）的行，**扫描继续按同一 `out_request_no` 低频重放**（每扫描周期 1 发，幂等）直至明确结果；**72h 上限**后停自动、留 `approved`+标记转**纯人工**（手册纪律：驳回前先核渠道后台）。**渠道有业务响应（含业务拒）或本地配置缺失（密钥未配）= 明确失败 ⇒ 不标记、不重放**，留人工面。

### 3.4 扫描循环（`PAY_SCAN_INTERVAL_MS`；条件更新幂等；**八步**——⑧ 为 v1.1.5 依 §3.3「未知结果收敛」补收）

① 过期关闭（§3.1）· ② 主动查询补单（§3.1）· ③ 入账重试（`status='paid'` ⇒ 重放 apply）· ④ 提现冻结解析 · ⑤ 提现回滚恢复（`status='rolling_back' AND rolled_back_at IS NULL` ⇒ 重放 rb 锚）· ⑥ 退款冻结解析 · ⑦ 退款回滚恢复（`status='rejecting'`——**该表无 `rolled_back_at` 列（§2.3 DDL 冻结），以 DDL 为准**〔v1.1.3 订正〕；回滚落账即迁 `rejected`）· ⑧ **退款未知结果重放**（`status='approved' AND last_error LIKE 'unknown:%'` 且 `reviewed_at` 72h 窗内 ⇒ 同 `out_request_no` 1 发/周期；三类结果照 §3.3 末段）——各循环更新 §2.6 的 gauge/age 指标。

### 3.5 日自检（⚙️17；`PAY_RECONCILE_INTERVAL_MS` 周期 + **启动后 30s 首跑**）

- 入账勾稽 diff = |`Σ payment_orders.coins(status='credited')` − `SUM(f.delta)`（`currency_flows f JOIN currency_ops o ON o.id=f.op_id WHERE o.source='recharge'`）| ⇒ `payment_reconcile_diff`（任一勾稽非零即置>0；告警 §2.6-5）。
- 锚勾稽：孤儿锚（ops 有锚、本地无行）⇒ 计入 diff + 响亮日志（修复判据=设计 §14 R12）。

### 3.6 锁纪律

- `user-lock.service.ts`：`INSERT IGNORE INTO payment_user_locks(user_id) VALUES(?)` ⇒ `SELECT user_id FROM payment_user_locks WHERE user_id=? FOR UPDATE`（事务内）；RPC 超时 3s（⚙️2）；锁内最多 `withdrawable.get + apply` 两次 RPC。**cap 取数只在此处（资金动作时刻）；禁缓存、禁只查一次**（§2.2.1）。
- **锁序死锁与有界重试（T9 真库实证补记，v1.1.2）**：稳态行（行已存在）下两会话 `INSERT IGNORE`（S 锁相容）→ `FOR UPDATE` 各求 X 升级 ⇒ **确定性 1213**。`withUserLock` 对**获取阶段**死锁（判据 = fn 尚未执行——`fnStarted` 先于 fn 调用置位）做**有界重试 ≤3 次**（每次新事务）；**fn 内死锁不重试**（保守边界，防止双执行）；上限耗尽 ⇒ 原错上抛（获取阶段失败无副作用）。

---

## 4. 客户端（第 6 页 `pages/wallet/wallet`）

- **入口**：大厅钱包区（`lobby.vue` 金币显示处）点击 ⇒ 跳钱包页；`rechargeEnabled/withdrawEnabled` 为 false 时页内对应区块**隐藏**（入口保留；两开关全关且页面无内容 ⇒ 入口隐藏）。
- **充值区**：档位按钮（`rechargePackages` 渲染「{N} 元 = {N×coinPerYuan} 金币」）⇒ 下单 ⇒ `window.location.href = payUrl`；期间按钮禁用。
- **提现区**：显示 `balance/withdrawable`；金额输入（占位=门槛）；提交前校验（整数、≥min、≤max、≤当日可申、≤可提）；提交 ⇒ 状态条（审核中/已通过/已打款/已驳回/已超时退回）。
- **记录区**：三 tab（订单/退款/提现），各自 `mine` 端点 keyset 加载；订单状态 `created→待支付`、`paid→处理中`、`credited→已到账`；退款/提现按状态机枚举映射中文；14006/14007 行内提示。
- **回跳**：应用启动读 URL `?pay=<orderNo>` ⇒ 进钱包页订单详情并轮询（3s × 10；超时「处理中」+「刷新」按钮 ⇒ sync）。
- **App 形态**：尽力唤起；失败降级文案（§2.8）。
- 测试钩子（供 client 单测/浏览器 e2e 选择器）：`wallet-entry`（入口）· `pay-package-{yuan}` · `withdraw-input/-submit` · `order-row-{orderNo}`。

---

## 5. 管理页

- **三视图**（顶栏按钮）：`支付订单`（筛状态/用户/时间；详情含 notify 尾）· `退款审核`（待审列表 + 通过/驳回 + note）· `提现审核`（待审列表 + 详情[余额/cap/历史] + 通过/驳回/登记打款[voucher+note]）。
- **审计第六页签**：「审计 → 支付处置」（`actions` 读口 + CSV）；`admin/app.js` 字面量「五页签」→「六页签」（:43/:294/:2245——其中 :294 实文为「五个页签」）与 `index.html:310-320` 注释/按钮同步。⚠️ `admin/app.js` 另有 7 处「第**五**页签」为**位置引用**（风控处置仍是第 5 页签；:3/:14/:22/:302/:1603/:1610/:1874，**全量恰七处**）——**不得**随之改「第六」；只改计数/枚举语境 3 处。
- **来源下拉 +5**（`admin/index.html:144-150`：`recharge/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback`）。
- **CSV 列**：orders=`order_no,user_id,package_yuan,amount_fen,coins,status,channel,trade_no,paid_at,credited_at,closed_at,created_at`；refunds=`refund_no,order_no,user_id,coins,status,reason,reviewed_by,reviewed_at,refunded_at,created_at`；withdrawals=`withdraw_no,user_id,coins,status,timeout_at,reviewed_by,confirmed_by,voucher,rolled_back_at,created_at`；actions=`at,actor,kind,ref_no,detail`。
- **审计第六源视角（v1.1.4 登记，波 4 评审发现）**：为**单值处置戳**（读三表当前字段流），「先审后驳」只显示终态事件——approve 事件不留存（留存需加列=破 §2.3 冻结 DDL）。显式登记，终审裁决是否接受。

---

## 6. 测试与判据

### 6.1 单测（payment-service 为主）

1. `sign.test.ts`：两口径金标向量 4 组正反 + 篡改负例（金额/签名/参数序）；出站签名稳定向量。
2. `orders-state.test.ts`：状态机转移全对 + 并发条件更新（两回调恰一）+ 迟到重开 + 过期关闭。
3. `withdraw-state.test.ts`：holding 只解析、claim 互斥（confirm vs 超时各胜场景）、槽语义、日限口径（+08:00 归日/状态集）、holding 占位拒新申请、**cap fail-closed 专测**（mock RPC 超时 ⇒ 拒，15003）、`amount_fen` 换算（`floor` 与 0 分拒）。
4. `refund-state.test.ts`：申请即冻结、保留槽、驳回回滚、渠道失败停 approved、**cap fail-closed 专测**（15006）。
5. `cap`（currency-service 侧）：公式全演算表 + clamp + 边界。
6. `locks.test.ts`：同用户并发两申请串行/一成一拒（撞槽）。
7. `redact`：PEM 规则（shared）。
8. protocol：`currency.test.ts`（+5 源）/ `errors.test.ts`（SPEC_CODES）/ `config.test.ts`（34 键+14 客户端）/ `messages.test.ts`（15 pattern）/ `rpc` 相关。
9. gateway：policy 新 7 条逐端点正反 + 未登记 fail-closed；pay 转发路径测试。
10. client：wallet 页渲染/开关隐藏/金额校验/轮询/回跳识别；admin 静态串（含六页签；来源下拉 **12 项** =「全部」+6 既有源+5 新源）；**路由次序**（`orders/mine` 不得 15002）。
11. config-service：种子迁移（34 键值逐字）+ client-config 恰 14 键。

### 6.2 conformance `slice-21-payment`（18 组；真栈 + stub；📌 断言数待 CI 回填 baseline）

①配置键种子+客户端键集 14 ②开关关拒单（15008）③下单（stub 验我们签名；幂等复用）④回调正例（stub 私钥签名通知）⇒入账⇒余额/流水/锚 ⑤伪造签名拒 + `bad_sign` 计数 ⑥金额不符拒（`amount_mismatch`）⑦重放幂等 ⑧并发双通知恰一次 ⑨迟到回调重开（`reopen` 计数；**过期单构造 = SQL 回填 `expires_at`**，records 片先例）⑩过期关闭（含 trade.close 已付分支；同构造）⑪提现全链（门槛/限额/在途/审/确认；hold 流水逐字）⑫超时回滚（短超时注入；claim 互斥负例）⑬cap 场景组（**§2.2.1 演算表** + 15005 + 跨面串行负例 + holding 占位拒 + **fail-closed 负例**〔切片末组停 currency-service ⇒ 申请必拒 ⇒ 恢复；若执行受阻改单测专测+登记〕）⑭退款全链（冻结→审→stub 退款→refunded；驳回回滚；15006；渠道失败停 approved）⑮权限矩阵 + 第六源 + CSV 字节 ⑯日自检指标（SQL 造孤儿锚负例；**观测路径 = 注入 `PAY_RECONCILE_INTERVAL_MS=2000` 后数秒内见指标变化**）⑰回调防护（非 POST 拒 · 非 form 拒 · >16KB 拒〔413〕· 连发 bad-sign 触发边缘单桶 ⇒ 429）⑱**两族 `mine` 真栈翻页（>20 行；cursor 严格读/SQL 形态——v1.1.6 收编，波 5 🟢-2）**。

### 6.3 闸与核销

设计 §13.4 逐文件核销表 **13 行**为验收清单（实施首日逐行勾）；六阶段 push 前一次；全序 = CI 权威轮；baseline 回填照近例。

### 6.4 上线验收（打 tag 前置）

沙箱联调（真支付宝沙箱：下单→付→回调→入账→退款全链）+ 差异入修订；密钥填入 `.env`；两开关仍默认关。

---

## 7. 明确不做（同步设计 §1.2 + 规格补充）

设计 §1.2 全部 + 规格补充：网关对 pay 路由不新增五维以外限流机制 · 管理页不做分页（照 ③ 现状 ⚙️10 先例）· 玩家退款申请不做撤单（驳回可重报）· 不做提现收款账号存储（打款线下核对）。

---

## 8. 修订记录

- **v1.0**（2026-10-05，`7782108`）：首稿（承接设计 v1.1.1 `1e20a3f`）。
- **v1.1**（2026-10-05）：规格 r1（**2 阻断 + 9🟡 + 13🟢 + 内部指针误 5 处**）全数处置——**阻断-1** cap fail-closed 与「动作时刻禁缓存」补回（§2.2.1/§3.2/§3.3/§3.6 + 单测/⑬ 负例）· **阻断-2** 回调防护整节补回（§2.7.4 + ⑰）· §0.2 指针订正（🟡-1）· ⚙️17 勾稽 SQL 改 JOIN（🟡-2）· cap 公式与演算表收编 §2.2.1（🟡-3）· depends_on 改正（🟡-4）· amount_fen 换算与恒等式订正（🟡-5）· 测试注入改透传形态（🟡-6）· stub 改名 `ftl-alipay-stub`+起法钉死（🟡-7）· 日自检注入面 `PAY_RECONCILE_INTERVAL_MS`+30s 首跑（🟡-8）· 日限/时区逐字（🟡-9）· 🟢 十三全收（字段写点/summary 加字段/15009/路由次序/P-p 显式全角色/15007 入 RESERVED/页签位置引用勿改/下拉 12 项/引号/过期构造/测试密钥禁令/config.client.ts 清单）。评审报告：`.superpowers/sdd/2026-10-05-payment/review-spec-r1.md`。
- **v1.1.1**（2026-10-05）：r2 复审**零阻断（可通过进计划）**、r1 全部 25 项核销；**3🟡 + 8🟢 照办**——15009 进 ⚙️8 HTTP_STATUS 表（🟡-1）· ⚙️14 起法行 MSYS 纪律（`MSYS_NO_PATHCONV=1`，照 ops 脚本先例）（🟡-2）· down 行 `|| true` + 位置钉死（🟡-3）· 「+9 码」「17 组」计数（🟢-1/2）· §2.7.4 落 429（🟢-3）· §3.2 点名 15005 + fail-closed 文案变体入 §2.8（🟢-4）· H1 标题（🟢-5）· 「上表」/config 清单命名/页签行文措辞（🟢-6/7/8）。**规格到此冻结。** 评审报告：`.superpowers/sdd/2026-10-05-payment/review-spec-r2.md`。
- **v1.1.2**（2026-10-05）：实现期收口补记（波 3 评审裁可）——§3.6 增「锁序死锁与有界重试」（T9 真库实证：稳态行 S→X 升级确定性 1213；获取阶段 ≤3 次新事务重试，fn 内不重试）。评审报告：`.superpowers/sdd/2026-10-05-payment/review-wave3.md`。
- **v1.1.3**（2026-10-05）：§3.4 ⑦ 订正（T11 发现：`payment_refunds` 无 `rolled_back_at` 列——以 §2.3 冻结 DDL 为准，谓词取 `status='rejecting'` 单条件；加列会破 DDL）。
- **v1.1.4**（2026-10-06）：波 4 评审处置——§3.3 增「未知结果收敛」调和 §2.5 表（就地退避 6 发 → 未知行扫描低频重放 → 72h 转纯人工；`unknown:` 标记语义）· §5 增审计第六源「单值处置戳」视角登记（先审后驳丢 approve 事件，加列会破 DDL ⇒ 终审裁决）。报告：`.superpowers/sdd/2026-10-05-payment/review-wave4.md`。
- **v1.1.5**（2026-10-06）：§3.4 标题「七循环」→「**八步**」并补收 ⑧（退款未知结果重放——修复批 `97712a5` 已实现，此处收敛计数与行为面）。
- **v1.1.6**（2026-10-06）：§6.2 「17 组」→「**18 组**」并补收 ⑱（两族 `mine` 真栈翻页/严格读——波 5 🟢-2）。
