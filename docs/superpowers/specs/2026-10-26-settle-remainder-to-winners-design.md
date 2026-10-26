# 结算零头改为分给赢家（最大余数法）· 设计 v1.0

> 日期：2026-10-26 · 状态：待设计对抗审查 · 流程：`docs/dev-process.md`
> 分支：`dev`（基线 `7460a3ce`）。
> 前置阅读：`2026-10-04-gold-room-spec.md` §4（现行结算算法逐字）、
> `2026-10-04-gold-room-design.md` D3、`packages/room-service/src/currency/settle.service.ts`、
> `tools/conformance/src/slices/slice-18-gold-room.ts`（复算函数）、
> `2026-10-14-burn-on-op` 相关记忆（残差/抽水上账口径）。

## 0. 用户裁决

| # | 问题 | 裁决 |
|---|---|---|
| U1 | 结算凑整零头（如 A 输 25、B/C 各得 12、剩 1 销毁）怎么处理 | **分给赢家，不再销毁**；采用方案 A「最大余数法」（2026-10-26） |
| U2 | 抽水是否随之改动 | **不改**：抽水仍销毁（既定 J7）；零头**先分发、再按最终所得抽水**（随 U1 一并批准） |

## 1. 背景与问题

1. **零头销毁是凑整产物，不是经济政策。** 现行 `computeSettlement`
   （`packages/room-service/src/currency/settle.service.ts:183-241`）：
   输家截断后形成池 `P`，赢家按 `g_i = floor(raw_i × P / Σraw)` 分摊，
   `residue = P − Σg_i ∈ [0, 赢家数)` **销毁**（op 列 `burned_residue`、指标
   `currency_settle_residue_total`、Grafana「残差销毁增速」）。
   用户示例：地主应付 60 但余额 25 ⇒ 两农民 `floor(30×25/60)=12` 各得 12，
   剩 1 销毁 —— 玩家可见「输 25、赢 12+12，1 个不见了」。
2. **截断场景的零头同样被销毁。** 截断后的池是**真实付出的钱**，其凑整余数也一并蒸发；
   从守恒口径看，「输家实付 = 赢家实收 + 抽水」这条玩家可理解的恒等式不成立。
3. **算术精度隐患（本片副产物，实测量化）。** 现行公式用 double 乘除：
   `raw_i × P` 可超 `2^53`（`raw ≤ 2^31−1`、ddz 的 `P` 可达 `2×(2^31−1)`）。
   实测 `raw=216,524,538、P=433,049,076`（未截断、整分）时 double 给出
   `216,524,537`，每人少 1、虚增残差 2 —— 甚至突破「residue < 赢家数」的既有不变量。
   新算法要对余数排序，必须用精确整数算术。

## 2. 范围

### 2.1 做

- `computeSettlement` 的赢家分摊改为**最大余数法**（D1），零头不再销毁。
- 抽水顺序改为「先分发零头、后抽水」（D2）。
- 中间乘除改 **BigInt** 精确算术（D4）。
- `residue` 保持字段/列/指标，新结算恒写 0（D3）。
- 单测、conformance 复算函数与断言文本、相关注释/文档同步（D5/D7）。

### 2.2 不做（YAGNI / 边界）

- 不动协议字段与校验：`burn` 仍为 `{residue, rake}`，V3 恒等式
  `Σentries + residue + rake = 0` 不变（`packages/protocol/src/currency.ts:266-286`）。
- 不动数据库：无迁移、不回填历史 op；旧 outbox 条目按原载荷重放。
- 不动管理端/财务视图/客户端：residue 列照常展示（历史行有值，新行恒 0）。
- 不动抽水策略（仍销毁）、**不做**平台/奖池账户、**不做**服务器银行
  （与 2026-10-14 裁决一致）。
- 不加配置开关；回滚 = revert 本片提交并部署。
- 不改 `:r2` 重算/outbox 失败分级/收尾链任何语义。

## 3. 决策表

### D1｜分配算法：最大余数法（零头归赢家）

```
S        = Σ raw[赢家]                                // 原始分差之和（>0）
g_i      = floor(raw_i × P / S)                       // 基础分摊（精确整数）
frac_i   = raw_i × P − g_i × S                        // 精确余数，∈ [0, S)
R        = P − Σ g_i                                  // 精确算术下 ∈ [0, 赢家数)
分配     = 按 (frac 降序, 座位升序) 取前 R 名，各 +1
residue  = P − Σ 最终 g_i ≡ 0
```

- **公平性**：每个赢家与严格比例值的偏差 < 1 个货币，且拿到 +1 的是「最接近进位」的人。
- **确定性**：余数排序平局用座位升序；座位每局随机分配 ⇒ 无跨局系统偏向。
- **截断场景**：先按现规则截断输家支付（不变），池内全部真实付出的钱分完。
- **防御路径**：`赢家为空 或 S ≤ 0`（理论不发生——玩法分差和为 0）⇒ 不分配，
  `residue = P` 仍销毁（保持 V3 可过，行为与今天一致；不新增语义）。

### D2｜抽水顺序：先分发、后抽水

`rake_i = floor(finalGain_i × rakePercent / 100)`；`delta_i = finalGain_i − rake_i`。
规则统一为「每个赢家按**实际所得**被抽水」；抽水仍销毁（J7 不变）。
默认 `rakePercent=0` 时本项无任何可观测差异。

### D3｜记账兼容：residue 保留、新结算恒 0

- `burn` 载荷仍恒带 `{residue: 0, rake: Σrake}`（条件展开的旧条目分支不变），
  V3 校验照过；`burned_residue` 新行写 0（**NULL ≠ 0** 口径不变）。
- `currency_settle_residue_total` 指标保留并继续每局 inc（值 0）——
  作为**回归哨兵**：将来若有人改坏算法导致残差复现，面板可见。
- Grafana/admin 文案不动（「残差销毁」对历史行仍成立）。
- 历史 op 两列不回填、不改写。

### D4｜精确算术：中间乘除用 BigInt

- 参与 BigInt 的量：`raw_i`、`P`、`S`、`g_i`、`frac_i`。
- `g_i` 最终转回 `number` 并断言安全整数；`rake` 继续用 number
  （`gain × pct ≤ ~3e11 < 2^53`，安全）。
- 依据：§1 第 3 条的实测反例；且最大余数法要求余数**精确可比**。
- `R` 由精确值相减得到；若出现 `R < 0 || R ≥ 赢家数`（编程错误）⇒ 抛错，
  由 `settle()` 顶层兜底记 `dropped`（钱未动、账面可见地响一声——沿用现有失败姿态）。

### D5｜conformance 复算同步

- `tools/conformance/src/slices/slice-18-gold-room.ts` 的 `recountSettlement`
  必须改为**同一算法**（否则真栈 E/F 的复算与实际差 1 会假红）；
  断言文本「残差 ∈ [0, 赢家数)」改为「残留恒 0」。
- `slice-31-pdk-gold.ts` ④ 不截断 ⇒ `scoreChanges` 精确、逐座不变，**零改动**。
- `slice-17-currency.ts` ⑧b 是 burn 协议测例（手工构造 `residue:1` 载荷），
  验证的是 currency-service 的两列与 V3，与结算算法无关 ⇒ **不改**，仅注释澄清来源。

### D6｜历史数据与补偿链

- 旧 `settle:outbox` 条目按原载荷原样重放（`residue/rakeTotal` 取自条目），
  其 `burn.residue` 非 0 仍合法（V3 逐条自洽）。
- 无迁移、无回填、无 admin 改动。

### D7｜文档与注释

- 本 spec 覆盖 `2026-10-04-gold-room-spec.md` §4 与 design D3 的残差规则；
  在旧 spec §4 标题下加一行「**2026-10-26 起**：零头改分给赢家，见 …」指针（最小改动）。
- 同步措辞：`settle.service.ts` 文件头/`computeSettlement` 注释、
  `packages/protocol/src/currency.ts:69-75`、`packages/room-service/src/metrics/room.metrics.ts:145-150`。

### D8｜无配置开关

改动只在纯函数与复算面；回滚 = revert。加开关会让两条算法长期并存，收益不抵复杂度。

## 4. 实现设计

### 4.1 `computeSettlement` 的赢家段（替换现 215-228 行）

```
winners = 座位升序过滤 raw > 0
S = Σ raw（number，≤ 3×2^31 安全）
if winners 非空 且 S > 0:
  for each winner:
    num   = BigInt(raw) × BigInt(P)
    g     = num / BigInt(S)            // BigInt 整除 = floor（非负）
    frac  = num % BigInt(S)
  R = P − Σ Number(g)                  // number
  if (R < 0 || R >= winners.length) throw new Error(...)   // D4 防御
  排序（frac 降序、座位升序）→ 前 R 名 g += 1
  逐赢家：finalGain = Number(g)；rake = floor(finalGain × rakePercent / 100)
          delta = finalGain − rake；rakeTotal += rake
residue = P − Σ finalGain (= 0)
```

其余不动：输家截断与 `-0` 归一、entries 过滤非零、`actionId`/round、deltas 向量含 0。

### 4.2 接口零变化

`SettleComputation` 字段不变（`residue` 仍存在、恒 0）；`burn` 载荷形状不变；
outbox 条目结构不变；`finalize` 链不变。

## 5. 测试判据（期望值全部手算，不重引入被测公式）

| # | 场景 | 手算期望 |
|---|---|---|
| C1 | 用户示例（ddz 截断）：地主 raw −60、余额 25；农民 raw 各 +30 | gain 各 `floor(30×25/60)=12`，frac 各 750−720=30 ⇒ R=1、平局座位序 ⇒ **seat1=13、seat2=12**；residue=0；Σentries=0 |
| C2 | 无截断地主赢：+30/−15/−15 | 不变：30/−15/−15，residue=0 |
| C3 | pdk 2 赢家截断：赢家 8/8，输家应付 16 但余额 15 | gain 各 7、frac 各 `8×15−7×16=8` ⇒ R=1 ⇒ 座位小者 8、另一 7 |
| C4 | 不等余数：赢家 raw 5/11、P=15 | gain `4`（frac `75−64=11`）/`10`（frac `165−160=5`）⇒ R=1 给 raw 5 ⇒ **5/10** |
| C5 | R=2：赢家 1/1/1、P=5 | gain 各 1、frac 各 2 ⇒ 前两座 +1 ⇒ **2/2/1** |
| C6 | 抽水叠加：C1 场景 + rake 10% | gain 13/12 ⇒ rake 1/1 ⇒ delta **12/11**；residue=0；Σentries=−2 |
| C7 | 抽水边界（10%）：finalGain 9 ⇒ rake 0；10 ⇒ rake 1 | 逐字断言 |
| C8 | 精度回归：ddz 两农民 raw 各 **216,524,538**、P=**433,049,076**（不截断） | 各得 216,524,538、residue=0（旧 double 实现各少 1、虚增残差 2） |
| C9 | 恒等式全族 | 所有用例 `Σentries = −(residue + rakeTotal)` 且 `residue = 0` |
| C10 | pdk 全零局 | 不变：不调 apply、仍广播、moneyDelta 全 0 |
| C11 | 防御：赢家空/`S≤0` | 不分配、`residue=P`、不抛错（理论不发生） |
| C12 | conformance（真栈）：slice-18 E/F | 复算（新算法）与实际逐座一致；E 的 settle op `burned_residue:burned_rake` 与复算一致（residue 恒 0） |

## 6. 错误处理与边界

- **14001 → `:r2`**：重算走同一算法；结果经 outbox/重放均幂等（actionId 不变）。
- **大数值**：BigInt 无溢出；`Number(g)` 断言 `Number.isSafeInteger`。
  单条 delta 超 `2^31−1` 仍由协议 cap 拒绝（现状，非本片范围）。
- **平局**：全同余数时按座位序；座位随机 ⇒ 长期无系统偏向。
- **并发**：纯函数，无共享状态；无新时序。

## 7. 风险

| 风险 | 处置 |
|---|---|
| 结算页/历史记录出现个别玩家 ±1（13/12 而非 12/12） | 预期行为；属本片目标 |
| conformance 复算未同步 ⇒ 真栈假红 | D5 强制同改，计划中列为独立任务 |
| 指标恒 0 使「残差销毁」面板失去信号 | 面板保留为回归哨兵；本片不新增断链告警（现有告警规则无 residue） |
| 旧 outbox 条目携带旧 residue 值 | 语义合法，逐条 V3 自洽；不回填 |
| 抽水额可能因零头 ±1（rake>0 时） | 规则统一为「按最终所得抽水」，文档写明 |

## 8. 涉及文件

- `packages/room-service/src/currency/settle.service.ts`（算法 + 注释）
- `packages/room-service/test/currency/settle-algorithm.test.ts`（C1–C9、C11）
- `packages/room-service/test/currency/settle-pdk.test.ts`（C3/C10 相关；如有断言需同步）
- `packages/room-service/src/metrics/room.metrics.ts`（注释）
- `packages/protocol/src/currency.ts`（注释）
- `tools/conformance/src/slices/slice-18-gold-room.ts`（`recountSettlement` + 断言文本）
- `docs/superpowers/specs/2026-10-04-gold-room-spec.md`（§4 指针一行）
- 本 spec

## 9. 审查记录

（待设计对抗审查后回填）
