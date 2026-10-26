# 结算零头改为分给赢家（最大余数法）· 设计 v1.1

> 日期：2026-10-26 · 状态：设计对抗审查已处置（v1.1）· 流程：`docs/dev-process.md`
> 分支：`dev`（基线 `7460a3ce`）。
> 前置阅读：`2026-10-04-gold-room-spec.md` §4（现行结算算法逐字）、
> `2026-10-04-gold-room-design.md` D3、`2026-10-14-burn-on-op-spec.md`、
> `packages/room-service/src/currency/settle.service.ts`、
> `tools/conformance/src/slices/slice-18-gold-room.ts`（复算函数）。

## 0. 用户裁决

| # | 问题 | 裁决 |
|---|---|---|
| U1 | 结算凑整零头（如 A 输 25、B/C 各得 12、剩 1 销毁）怎么处理 | **分给赢家，不再销毁**；采用方案 A「最大余数法」（2026-10-26） |
| U2 | 抽水是否随之改动 | **抽水去向不变（仍销毁，J7）**；**基数改为最终所得**（零头先分发、再按 finalGain 抽水）——随 U1 一并批准 |

### 0.1 方案对比（dev-process §2 要求）

| 方案 | 做法 | 否决/采纳理由 |
|---|---|---|
| **A 最大余数法（采纳）** | 基础 `floor` 分摊后，余数按小数余数降序各 +1（平局座位序） | 每人偏差 <1 且最接近进位者得；确定性、可复算；截断池全部分完 |
| B 零头全给最大赢家 | R 个全给 raw 最大者 | 系统性偏向本来就赢最多的人；4 人场可给同一人 +3，不好解释 |
| C 按座位序补 | 低座位前 R 名各 +1 | 固定偏袒低座位；虽座位随机，仍不如「按余数」可解释 |
| D 输家少付 | 池向下取整到可整除，零头留在输家 | 输家实付低于牌局记分，亏损侧与记分不一致 |
| E 平台/奖池账户 | 零头转入系统账户 | 钱仍离开玩家间流通；需新增 owner 类型/账户/记账路径；且 2026-10-14 已裁决不做服务器银行 |

## 1. 背景与问题

1. **零头销毁是凑整产物，不是经济政策。** 现行 `computeSettlement`
   （`packages/room-service/src/currency/settle.service.ts:183-241`）：
   输家截断后形成池 `P`，赢家按 `g_i = floor(raw_i × P / Σraw)` 分摊，
   `residue = P − Σg_i ∈ [0, 赢家数)` **销毁**（op 列 `burned_residue`、指标
   `currency_settle_residue_total`、Grafana「残差销毁增速」）。
   用户示例：地主应付 60 但余额 25 ⇒ 两农民 `floor(30×25/60)=12` 各得 12，
   剩 1 销毁 —— 玩家可见「输 25、赢 12+12，1 个不见了」。
2. **截断场景的零头同样被销毁。** 截断后的池是**真实付出的钱**，其凑整余数也一并蒸发；
   「输家实付 = 赢家实收 + 抽水」这条玩家可理解的恒等式不成立。
3. **算术精确性（硬化项，非现存生产缺陷）。**
   现行公式用 double 乘除。**当前配置下不可达**：DDZ 分差 = `baseScore × bid(1|2|4|8) ×
   2^bombs × spring(1|2)` ⇒ `raw = b × 2^m`（`b ≤ 8191`，13 bit），`P < 2^33`
   ⇒ 乘积的奇部 `≤ 8191×2^33 < 2^46`，double 可**精确**表示；可达的商也只有两种形态——
   单赢家 `gain = P`（不除）、DDZ 双农民 `gain = floor(P/2)`（半整数精确）。
   **但新算法要求余数 `frac` 精确可比**：一旦出现「多赢家且 raw 不等」的输入
   （PDK 未来玩法、或 `multiplierCap` 被配成非 2 幂），double 会算错——
   合成算例：`raw=216,524,538、P=433,049,076` 时 double 得 `216,524,537`，
   每人少 1、虚增残差 2（甚至突破「residue < 赢家数」的既有不变量）。
   ⇒ 本片用 BigInt 作**输入免疫**，不是修一个正在发生的生产 bug。

## 2. 范围

### 2.1 做

- `computeSettlement` 的赢家分摊改为**最大余数法**（D1），零头不再销毁。
- 抽水顺序改为「先分发零头、后抽水」（D2）。
- 中间乘除改 **BigInt** 精确算术（D4）。
- `residue` 保持字段/列/指标，正常路径恒写 0（D3）。
- 单测、conformance 复算函数与断言文本、注释/文档指针、Grafana 面板文案同步（D5/D7/D9）。

### 2.2 不做（YAGNI / 边界）

- 不动协议字段与校验：`burn` 仍为 `{residue, rake}`，V3 恒等式
  `Σentries + residue + rake = 0` 不变（`packages/protocol/src/currency.ts:266-286`）。
- 不动数据库：无迁移、不回填历史 op；旧 outbox 条目按原载荷重放。
- 不动管理端/财务视图/客户端：residue 列照常展示（历史行有值，新行恒 0）。
- 不动抽水**去向**（仍销毁）、**不做**平台/奖池账户、**不做**服务器银行
  （与 2026-10-14 裁决一致）。
- 不加配置开关；回滚 = revert 本片提交并部署。
- 不改 `:r2` 重算/outbox 失败分级/收尾链任何语义。
- 不新增真栈造数去**确定性**覆盖「多赢家不等余数」（登记为覆盖限制，见 §7）。

## 3. 决策表

### D1｜分配算法：最大余数法（零头归赢家）

```
S        = Σ raw[赢家]                                // 原始分差之和（>0）
g_i      = floor(raw_i × P / S)                       // 基础分摊（精确整数）
frac_i   = raw_i × P − g_i × S                        // 精确余数，∈ [0, S)
R        = P − Σ g_i                                  // 精确算术下 ∈ [0, 赢家数)
分配     = 按 (frac 降序, 座位升序) 取前 R 名，各 +1
residue  = P − Σ 最终 g_i ≡ 0（防御路径除外，见下）
```

- **公平性**：每个赢家与严格比例值的偏差 < 1 个货币，且 +1 给「最接近进位」的人。
- **确定性**：余数排序平局用座位升序；座位每局随机分配 ⇒ 无跨局系统偏向。
- **截断场景**：先按现规则截断输家支付（不变），池内全部真实付出的钱分完。
- **生产退化事实（如实登记）**：当前玩法里 PDK 恰一赢家（`packages/shared/src/pdk/settle.ts`
  `winnerSeats.length !== 1` 直接抛错）⇒ `R = 0`；DDZ 多赢家只有双农民且 `raw` 相等
  ⇒ `frac` 恒等 ⇒ 实际只剩「P 为奇数时 R=1、座位小者 +1」。LRM 的一般形态是为
  **未来多赢家不等 raw 输入**准备；本片的判别性测试用合成 PDK 向量承担。
- **防御路径**：`赢家为空 或 S ≤ 0`（理论不发生——玩法分差和为 0）⇒ 不分配，
  `residue = P` 仍销毁（保持 V3 可过，行为与今天一致；不新增语义）。

### D2｜抽水顺序：先分发、后抽水

`rake_i = floor(finalGain_i × rakePercent / 100)`；`delta_i = finalGain_i − rake_i`。
规则统一为「每个赢家按**实际所得**被抽水」；该 +1 可能跨过抽水边界
（10% 下 9→10 会多抽 1），属 D2 的预期副作用。抽水**去向**仍销毁（J7 不变）；
默认 `rakePercent=0` 时本项无可观测差异。

### D3｜记账兼容：residue 保留、正常路径恒 0

- `burn` 载荷仍恒带 `{residue: 0, rake: Σrake}`（条件展开的旧条目分支不变），
  V3 校验照过；`burned_residue` 新行写 0（**NULL ≠ 0** 口径不变）。
- **「恒 0」限定为正常分配路径**；D1 防御路径（赢家空/S≤0）仍可能 `residue = P`。
- `currency_settle_residue_total` 指标保留并继续每局 inc（值 0）——
  作为**回归哨兵**：将来若有人改坏算法导致残差复现，面板可见。
- 历史 op 两列不回填、不改写。

### D4｜精确算术：中间乘除用 BigInt

- 参与 BigInt 的量：`raw_i`、`P`、`S`、`g_i`、`frac_i`。
- **前置断言**：`raw_i`/`P`/`S` 均为非负安全整数（这才是能咬人的守卫；
  `Number.isSafeInteger(g)` 在结构上恒真，保留但只作兜底）。
- `Number(g)` 回转后断言安全整数；`rake` 继续用 number
  （`finalGain × pct ≤ ~1.1e11 < 2^53`，安全）。
- 依据：§1.3 —— 精确余数比较要求 + 对非守恒/未来输入免疫的硬化（非现存缺陷修复）。
- `R` 由精确值相减得到；若出现 `R < 0 || R ≥ 赢家数`（编程错误）⇒ 抛错，
  由 `settle()` 顶层兜底记 `dropped`（钱未动、账面可见地响一声——沿用现有失败姿态）。

### D5｜conformance 复算同步（两处，不是一处）

- `tools/conformance/src/slices/slice-18-gold-room.ts` 的 `recountSettlement` 必须改：
  1. **分配**改为同款最大余数法；
  2. **抽水基数**改为 `finalGain`（现在按 `gain` 抽，`:657-661`）——
     只要出现 `R>0` 且跨 10% 边界，F 组的 `rakeTotal` 与 entries 和会与实际差 1。
- 断言文本「残差 ∈ [0, 赢家数)」改为「残留恒 0」；**但要写明**：这条是复算函数
  自证（恒真），判别力来自逐座比对（`:800-808`）与 op 两列比对（`:1287-1293`）。
- `slice-31-pdk-gold.ts` ④ 不截断 ⇒ `scoreChanges` 精确、逐座不变，**零改动**。
- `slice-17-currency.ts` ⑧b 是 burn 协议测例（手工构造 `residue:1` 载荷），
  验证 currency-service 的两列与 V3，与结算算法无关 ⇒ **不改**，仅注释澄清来源。
- **复算不得 import 生产实现**（既有纪律），照抄算法；由本 spec §5 的手算矩阵交叉钉住。

### D6｜历史数据与补偿链

- 旧 `settle:outbox` 条目按原载荷原样重放（`residue/rakeTotal` 取自条目），
  其 `burn.residue` 非 0 仍合法（V3 逐条自洽）。
- 反向也安全：新代码写入 `residue=0` 的条目若在回滚后被旧代码重放，V3 同样成立。
- 无迁移、无回填、无 admin 改动。

### D7｜文档与注释指针

- 本 spec 覆盖 `2026-10-04-gold-room-spec.md` §4 与 design D3 的残差规则。
- 在以下**历史口径**处各加一行「2026-10-26 起：零头改分给赢家，见本 spec」指针：
  1. `2026-10-04-gold-room-spec.md` §4（公式）；
  2. `2026-10-04-gold-room-spec.md` §12.1 E（「炸弹局会因机器人侧截断产生残差」）；
  3. `2026-10-04-gold-room-design.md` D3（残差销毁段）；
  4. `2026-10-14-burn-on-op-spec.md`「截断残差（floor 分摊零头）」段。
- 同步代码注释：`settle.service.ts` 文件头/`computeSettlement`、
  `packages/protocol/src/currency.ts:69-77`、`packages/room-service/src/metrics/room.metrics.ts:145-150`。

### D8｜无配置开关

改动只在纯函数与复算面；回滚 = revert。加开关会让两条算法长期并存，收益不抵复杂度。

### D9｜Grafana 面板文案改为回归哨兵

`deploy/monitoring/grafana/dashboards/05-currency.json`：标题「残差销毁增速」→
**「残差（应恒 0，非 0 即回归）」**、图例 `{{game_type}} 残差销毁` → `{{game_type}} 残差`、
描述注明新口径；同步 `scripts/verify-monitoring.mjs:149` 的期望标题。
（否则面板永远贴地、运维会当坏面板。）

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
residue = P − Σ finalGain (= 0；防御路径除外)
```

其余不动：输家截断与 `-0` 归一、entries 过滤非零、`actionId`/round、deltas 向量含 0。

### 4.2 接口零变化

`SettleComputation` 字段不变（`residue` 仍存在）；`burn` 载荷形状不变；
outbox 条目结构不变；`finalize` 链不变。

## 5. 测试判据（期望值全部手算，不重引入被测公式）

| # | 场景 | 手算期望 |
|---|---|---|
| C1 | 用户示例（ddz 截断）：地主 raw −60、余额 25；农民 raw 各 +30 | gain 各 `floor(30×25/60)=12`，frac 各 750−720=30 ⇒ R=1、平局座位序 ⇒ **seat1=13、seat2=12**；residue=0；Σentries=0 |
| C2 | 无截断地主赢：+30/−15/−15 | 不变：30/−15/−15，residue=0 |
| C3 | pdk 2 赢家截断（合成向量）：赢家 8/8，输家应付 16 但余额 15 | gain 各 7、frac 各 `8×15−7×16=8` ⇒ R=1 ⇒ 座位小者 8、另一 7 |
| C4 | 不等余数（合成 pdk）：赢家 raw 5/11、P=15 | gain `4`（frac `75−64=11`）/`10`（frac `165−160=5`）⇒ R=1 给 raw 5 ⇒ **5/10** |
| C5 | R=2（pdk 4 人截断）：赢家 2/2/2、输家 −6 余额 5 ⇒ P=5 | gain 各 `floor(2×5/6)=1`、frac 各 `10−6=4` ⇒ R=2 ⇒ 前两座 +1 ⇒ **2/2/1**，输家 −5 |
| C6 | 抽水叠加：C1 场景 + rake 10% | gain 13/12 ⇒ rake 1/1 ⇒ delta **12/11**；residue=0；Σentries=−2 |
| **C6b** | **抽水基数判别（ddz 可达）**：地主 raw −20、余额 19；农民 raw 各 +10 | gain 各 `floor(10×19/20)=9`、frac 各 10 ⇒ R=1 ⇒ **10/9**；rake 10% ⇒ **1/0** ⇒ delta **9/9**。若按旧基数（9/9）抽 ⇒ 0/0 ⇒ delta 10/9（**必须不通过**） |
| C7 | 抽水边界（10%）：finalGain 9 ⇒ rake 0；10 ⇒ rake 1 | 逐字断言 |
| C8 | 精度回归（**合成算例，当前配置不可达**，见 §1.3）：ddz 两农民 raw 各 216,524,538、P=433,049,076 | 各得 216,524,538、residue=0（旧 double 实现各少 1、虚增残差 2） |
| C9 | 恒等式全族 | **除 C11 防御路径外**：`residue = 0` 且 `Σentries = −(residue + rakeTotal)`；防御路径仍满足该恒等式 |
| C10 | pdk 全零局 | 不变：不调 apply、仍广播、moneyDelta 全 0 |
| C11 | 防御：赢家空/`S≤0` | 不分配、`residue=P`、不抛错（理论不发生） |
| C12 | conformance（真栈）：slice-18 E/F | 复算（新分配 + 新抽水基数）与实际逐座一致；E 的 settle op `burned_residue:burned_rake` 与复算一致（新代码 residue 恒 0） |
| **C13** | **r2 路径（settle-failure.test.ts:263-273）**：首轮无截断付满、14001 后重读余额 25 | 首轮 `{0,0}` 不变；r2 entries **−25/+13/+12**、burn **`{residue:0, rake:0}`**、残差指标 **+0** |

## 6. 错误处理与边界

- **14001 → `:r2`**：重算走同一算法；结果经 outbox/重放均幂等（actionId 不变）。
- **大数值**：BigInt 无溢出；`Number(g)` 断言安全整数。单条 delta 超 `2^31−1`
  仍由协议 cap 拒绝（现状，非本片范围）。
- **非整数输入**：`BigInt(non-integer)` 抛 `RangeError` ⇒ `settle()` 顶层 catch 记
  `dropped`（钱未动、不 crash-loop）。
- **平局**：全同余数时按座位序；座位随机 ⇒ 长期无系统偏向。
- **并发**：纯函数，无共享状态；无新时序。

## 7. 风险与覆盖限制

| 风险 | 处置 |
|---|---|
| 结算页/历史记录出现个别玩家 ±1（13/12 而非 12/12） | 预期行为；属本片目标 |
| conformance 复算未同步（分配或抽水基数）⇒ 真栈假红 | D5 强制两处同改，计划中列为独立任务 |
| 真栈 E/F **不保证**覆盖 R>0 分支（机器人截断是随机局面；E 组预充 ≥12000） | 登记为覆盖限制；判别性由单测合成矩阵承担；不新增造数 |
| C8 只钉「旧 double 截断实现」；「LRM + double」在协议可达输入下不可观测（P≤S、DDZ 双农民等 raw / PDK 单赢家） | 登记为覆盖限制；BigInt 属硬化项（§1.3），不补非守恒向量 |
| 指标恒 0 使「残差销毁」面板失去信号 | D9 改为回归哨兵文案；现有告警规则无 residue |
| 旧 outbox 条目携带旧 residue 值 | 语义合法，逐条 V3 自洽；不回填 |
| 抽水额可能因零头 ±1（rake>0 时） | D2 规则统一为「按最终所得抽水」 |
| **跨部署瞬时 14002（推测，低）**：旧进程已算出旧载荷但未提交，新进程对同 `(room,version)` 重算得不同 entries | 单实例部署 + settle 无持久重算路径（outbox 只重发**已算好**载荷）⇒ 窗口≈0；登记 |
| **防御路径 residue 可能超 burn 字段上限**（pdk 4 人全输、P>2^31−1） | 协议 V2 拒绝 ⇒ 10001 终态 dropped（fail-closed）；纯理论路径，登记 |

## 8. 涉及文件

- `packages/room-service/src/currency/settle.service.ts`（算法 + 注释）
- `packages/room-service/test/currency/settle-algorithm.test.ts`（C1–C9、C11）
- `packages/room-service/test/currency/settle-failure.test.ts`（**C13：r2 断言三处**）
- `packages/room-service/test/currency/settle-pdk.test.ts`（C3/C10 相关；现有断言预计不变）
- `packages/room-service/src/metrics/room.metrics.ts`（注释）
- `packages/protocol/src/currency.ts`（注释）
- `tools/conformance/src/slices/slice-18-gold-room.ts`（`recountSettlement` 两处 + 断言文本）
- `deploy/monitoring/grafana/dashboards/05-currency.json`、`scripts/verify-monitoring.mjs`（D9）
- 历史文档指针（D7 四处）
- 本 spec

## 9. 审查记录

**设计对抗审查（2026-10-26，独立 reviewer，sonnet）**：结论「可进入计划 Yes，无阻断」，
H1–H5 处置如下（均已回填本 v1.1）：

| # | 发现 | 处置 |
|---|---|---|
| H1 | D2 抽水基数改动无判别用例（C6/C7 两种基数同值） | 新增 **C6b**（ddz 可达：raw 10/10、P=19 ⇒ 10/9，旧基数给出 10/9 而非 9/9） |
| H2 | 漏列 `settle-failure.test.ts` 的 r2 断言（会必红） | §8 增列 + 新增 **C13**（−25/+13/+12、burn 0/0、指标 +0） |
| H3 | §1.3 精度反例在当前配置不可达，D4 理由失实 | §1.3 改写为「硬化项 + 可达性分析 + 合成算例」；D4 依据同步；C8 标注合成 |
| H4 | C9「所有用例 residue=0」与 C11 防御路径矛盾 | C9/D3 限定「正常路径」，防御路径按恒等式单独表述 |
| H5 | D5 复算同步漏了抽水基数（F 组会差 1） | D5 明确两处同改；§7 风险表登记 |
| 低1 | D3「恒写 0」与防御路径措辞冲突 | 同 H4 限定 |
| 低2 | `Number.isSafeInteger(g)` 恒真 | D4 改为断言**输入**前置条件 |
| 低3 | slice-18「残留恒 0」是复算自证 | D5 写明判别力来自逐座/op 两列比对 |
| 低4 | E/F 不保证覆盖 R>0 | §7 登记为覆盖限制 |
| 低5 | 生产多赢家只有 DDZ 等 raw（LRM 退化为 R≤1+座位序） | D1 登记「生产退化事实」 |
| 低6 | 文档指针只落旧 spec §4 | D7 扩到四处 |
| 低7 | Grafana 面板恒 0 会被当坏面板 | 新增 **D9**（改标题/图例 + verify 脚本同步） |
| 低8 | dev-process 要求 2–3 方案对比 | 新增 §0.1 |
| 低9 | U2「抽水不改」易误读 | §0 U2 明确「去向不变、基数改」 |
| 低10 | 跨部署瞬时 14002（推测） | §7 登记（窗口≈0） |
| 低11 | 防御路径 residue 超 cap ⇒ 10001 dropped | §7 登记（fail-closed） |

**已核实的无问题面（reviewer 结论，抽查复核）**：守恒恒等式在截断/全零/单多赢家/非守恒输入下成立；
burn 形状与 V3 不变；旧/新 outbox 双向重放安全；BigInt 在 ES2022/Node20 可用；
rake 剩余 double 运算在安全整数域；客户端/admin 零改动；slice-17 ⑧b 与 slice-31 ④ 确不需改。
