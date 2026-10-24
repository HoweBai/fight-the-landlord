# 支付片 收口交接（2026-10-06）

> **给新会话/未来的你**：本片 = P2′ 变现链的支付切片（充值/退款/提现全含，用户 J4+P1–P5 四裁）。**当前状态：实现全完成 + opus 整支终审「可通过 push（Critical=0）」；未 push、未打 tag（皆用户裁决面）。**
>
> ⚠️ **部分失效（2026-10-06，支付配置管理化片）**：§3 第 1 步「`.env` 填 `ALIPAY_*`」已被**取代**——渠道六值改在管理页「支付渠道」填写（见 `docs/ops/first-deploy.md`「支付怎么上线（五步）」）；slice-21 基线已抬至 321（原记 312）。本片续篇以 `docs/superpowers/plans/2026-10-06-post-pay-channel-handoff.md` 为准。

---

## 1. 三件套与评审链（唯一上游）

- **设计**：`docs/superpowers/specs/2026-10-05-payment-design.md` **v1.1.1**（`1e20a3f` 冻结；r1 两阻断→v1.1→r2 零阻断）
- **规格**：`docs/superpowers/specs/2026-10-05-payment-spec.md` **v1.1.6 冻结**（r1 两阻断→v1.1→r2 零阻断；后随实现期收口 v1.1.2–v1.1.6）
- **计划**：`docs/superpowers/plans/2026-10-05-payment.md` **v1.1.7**（r1 两阻断→v1.1→r2 零阻断）
- **评审报告**：`.superpowers/sdd/2026-10-05-payment/`——`review-design-r1/r2` · `review-spec-r1/r2` · `review-plan-r1/r2` · **`review-wave1..5`**（全零阻断，波 4 曾 2 阻断已修）· **`review-final.md`（终审：可通过 push，Critical=0）**
- **台账**：同目录 `progress.md`（T1–T16 全行核销 + 五波处置 + 全部证据日志名）

## 2. 已建成（一句话 + 关键数字）

第 8 个 Nest **`payment-service`**（HTTP 3007 / metrics 9007 / 零被调 RPC）：五表 + `currency.withdrawable.get`（**cap=可离场额度**，分池唯一实现点、零写路径改动）+ 支付宝渠道层（RSA2 两口径，`node:crypto` 零依赖）+ 订单/回调（**回调=唯一信任入口**，六项防护）/资金底座（行锁+入账重试）/提现（申请即冻结+claim 先行+超时回滚）/退款（申请即冻结+退避+`unknown:` 72h 收敛）/管理面（八端点+三视图+审计第六源）/钱包页（客户端第 6 页）/监控（**15 job · 5 告警 · 07 面板 · 日自检双勾稽**）/conformance **`slice-21-payment`（312 断言，两跑绿）** + `ftl-alipay-stub`（双向金标）。

关键数字：六阶段 **3500 passed + 2 skipped，覆盖率 98.27%**（≈1m52s）· promtool 恰 23 rules · targets 15/15 up · Grafana 7 面板 · 容器 18 / 镜像 14 · 配置键 34 / 客户端 14 · 错误码 15001–15009。

## 3. 上线两步（**打 tag 前置，皆用户侧**）

1. **商户号（实名主体）** + 应用签约「手机网站支付」+ 生产密钥：`.env` 填 `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY`（base64(PEM)）/ `ALIPAY_SELLER_ID` / `PAY_PUBLIC_BASE_URL`（+ 渠道网关默认生产地址）。
2. **沙箱真实联调**：下单 → 付 → 回调（经门口）→ 入账 → 退款，全链走一遍；差异入修订。**这是唯一无法本地覆盖的验证。**

之后：**先 push master**（先例教训：`v1.1.1` 曾被 R1308 正确拒）→ 打 tag `v*` → release 三 job（conformance 在发布镜像上全序：核 **slice-21=312** 与 **26 片**总表）→ 线上免密探针。

## 4. 运营手顺（上线即用，详见 `docs/ops/first-deploy.md`）

- **暗上线**：开关键 26/27 默认 false → 开开关 → 小范围通告 + 低限额（门槛 10 元/单笔 500/单日 1000）→ 提额 = 改配置键。
- **提现打款**：先核详情 → 手工转账 → **立即登记 voucher（未登记=未打款）**。
- **退款审批已知形态**：approve 就地退避最长 **~12.6 分钟**（网关 5s 会 503/10007，页面刷新；重审被 15009 兜底）；`unknown:` 标记 → 扫描低频重放至 72h → 转纯人工；**驳回前先核渠道后台**（含 CAS 失手带渠道单号形态）。
- **告警 runbook** 5 条在 `ftl-alerts.yml`（含池告警的**资金外流视角**注记）。

## 5. 遗留与裁决清单

- 终审 F 项**全部裁决接受**（审计单值戳/R5 池出金/R6 洗白/R12 孤儿 hold/R13 退避窗/退款残余窗/baselines）；M-1/M-2/M-3 已措辞闭环（`aac8b81`）；**M-4（日志承载流程提示）不修**。
- 待 CI 权威轮：**baselines slice-21=312 校正**（不得静默松绑）。
- 未来期（设计 §15）：微信渠道（接口已抽）· API 自动出款 · APP 支付 · 账单文件级对账 · 部分退款 · 用户级白名单机制。

## 6. 环境事实（跑本片真栈必读）

- **Caddyfile 改动必须重建 edge** 且显式 `EDGE_HTTPS_PORT=8443`；down/up 循环后 **8443 映射可静默失效**（`--force-recreate edge` 修）——memory `windows-dev-env-quirks` 第 18/18b 条。
- `docker compose exec -w` 要 `MSYS_NO_PATHCONV=1`；本地 protocol dist 陈旧会造假红（重建 dist）。
- **stub**：`ftl-alipay-stub`（conformance-stack.sh 起停；测试密钥仅在 `tools/conformance/fixtures/alipay-test/` **与** `packages/payment-service/test/fixtures/alipay/`，生产密钥永不入仓；gitleaks 允许项 #4/#5 带复查触发）。
- dev 库探针数据留存（`t9-probe-user` 余额 4200、各探针单）——真栈复跑注意基线。

## 7. 交接核对（本文件写作时）

HEAD `aac8b81`（M 修后）· 工作树干净 · `origin/master` **未推**（落后 41+）· 六阶段绿 · slice-21 两跑绿 · 本片未上线（无 tag）。

## 8. 下一片候选

**广告小片**（金币场「每日救助」的前置）——或按用户指定。
