# 广告小片 —— 金币场「每日救助」接入激励视频（App 端）设计

> 版本: **v1.5 · 已勘误**（2026-10-13；原 v1.4 **已冻结** 2026-10-11）· 冻结审级: **r5 放行**（0🔴/0🟠/0🟡，被审 `2637e18`；报告 `.superpowers/sdd/2026-10-11-ads/review-design-r5.md`）· 遗留 1 建议级附带项（§7「跨零点重投」构造手段）登记于交接文档，留规格期一行处置 · **v1.5 = T0 回填勘误（官方文档实文，抓档在案）——只动 §0.2/§4.1/§4.2 的 T0 边界文本，不改任何 K 裁决**
> 上游：`docs/superpowers/specs/2026-10-04-gold-room-design.md` **J9/J11**（救助机制已建 + 「广告小片」接入点预留）· `docs/design.md`（唯一权威）
> 本片定位：落地 J11 的上线顺序约束 —— **开启救助前必须先接广告**（现况占位=点了直接发豆，是真白送）。
>
> **修订记录**
> - v1.0（`e770bfb`）：初版（K1–K4 + 方案 A + 闸族同步初表）。
> - v1.1：设计评审 r1 修订 —— **两阻断**（①幂等锚用时点日期 ⇒ 跨零点重投双发；②`userId` 由客户端自选、服务端无绑定 ⇒ 可滚动造号无限铸币）→ 新增**领取凭证（claim）机制**（§2/§3/§4），一并修复：回调防护对齐支付先例（16KB 体积闸 + 单桶限流）· 观测枚举单一真源 + 两条告警 · 跳过分支语义 · GET 补 `balance` · 领取判定以账本为准 · 回调路径留渠道段 · 密钥承载裁决为**第四键空间** · §11 闸族同步表补全至 18 行清单。
> - v1.2：设计评审 r2 修订（八条）—— ①**落序钉死**（done/result 仅终态后落，瞬态失败保持可重投；claim 不存在不建键）②**窗口起点挪到「确认」步骤**（确认时续窗；15min 常量不设配置键）③`claim_invalid` 补**携 claim 轮询读取路径** + 终态即止 ④§4.5 表收单值（`claim_invalid` 自成一桶）· `currency_relief_total` **沿用既有三桶值域**（面板/slice-18 H 组零改动）⑤凭证按用户**复用单键**（键数 O(用户数)）+ §9 补 Redis 丢失口径（R7）⑥§11 补「新片注册面」行 ⑦`grantedToday` 口径钉死为 **`actionId` 内嵌签发日** ⑧「结果键」术语清剿 + `result` 读取方清单。另：r2 附言（第三键空间复用的密钥面扩张）入 §9 R5。
> - v1.3：设计评审 r3 修订（4 重要 + 7 次要，报告 `.superpowers/sdd/2026-10-11-ads/review-design-r3.md`）—— 🟠-1 回调链补**账本先行**步（apply 已提交而记录未落的重投判 replayed，不再撞余额闸污染指标）+ **逐路径计数规约**（done 短路发放面不计）🟠-3 回调基建补**第三件**（内部 token 中间件精确豁免，支付先例实为三件套）🟠-4 **补 edge 路由行**（Caddyfile `/ad/notify/*` + 经门口判据）🟠-5 §11 行 7 钉「G 原位改写、H 原位可保」（G 迁出必红 slice-18）· 🟡-2 裁决序逐字引既有四步 + GET 已领优先于余额闸 · 🟡-6 resolveClaim 补「读取故障（瞬态）⇒ 5xx」· 🟡-7 轮询三处钉死（身份一致性/当日口径/索引键 TTL）· 🟡-8 删客户端自选 `userId` 形参 · 🟡-9 钉客户端裸名 `reliefAdpid` · 🟡-10 告警断言面补 promtool 计数与名单本体 · 🟡-11 流程图拆两链。
> - v1.4：设计评审 r4 定点复核修订（2 重要 + 2 次要，报告 `.superpowers/sdd/2026-10-11-ads/review-design-r4.md`）—— 🟠-1 G 组 `replayed` 构造**重新锚定**：「扣回余额后再领」在 v1.3 新链不可达（`今日已发` 闸挡第二张凭证）⇒ 改「先 GET 签发、后 **RPC 预置同锚流水**、再投签名回调」（slice-18 自带可自定义 actionId 的 rpcApply，零新设施）；§2/§4.5 的「同日残余凭证窗口」可达性叙述同步删正。🟠-2 §7「账本先行重放」构造**禁写「记录移除」**（那走 claim_invalid，与 R7 相斥）⇒ 改「记录保持 issued + RPC 预置流水」。🟡-1 §4.3 链式枚举与 §2 图补「**读记录（done ⇒ 短路 200）**」步。🟡-2 §1-1 同步裸名 `reliefAdpid`。
> - v1.5（2026-10-13）：**T0 回填勘误**（官方文档实文，抓档 `.superpowers/sdd/2026-10-11-ads/docs-fetch/`，2026-10-12 直连抓取）—— §0.2 五项转「已答 / 部分已答」；§4.1 回调行改 **`GET`**（HTTP(GET)、字段走 query）· 终点响应改 **200 + JSON `{"isValid": true}`**（官方「唯一确认信号」语义；**含确定性拒绝——坏签名/畸形亦归终态**，瞬态回 `{"isValid": false}` 触发平台重投）· **16KB 体积闸条目删除**（GET 无 body）；§4.2 验签器输入改 query、输出去 `ts`（**删时间窗**——字段全集无时间戳）、算法落定 `sha256(secret:trans_id)` + `timingSafeEqual`（大小写归一）。契约细化全文见规格 **v1.4**（唯一真源）。

---

## 0. 裁决与前置

### 0.1 已裁（K1–K4）

| # | 裁决 | 依据 |
|---|------|------|
| K1 | **端范围 = 只做 App 端** | uni-ad 平台差异表：激励视频 **H5 = `x`**（H5 只有信息流供给）⇒「看视频发奖」H5 结构性做不到 |
| K2 | **开通路径 = DCloud 快捷广告 + Sigmob** | 两者均无「上架商店/软著」门槛（优量汇/穿山甲/百度/华为要求上架、快手要软著）；渠道 SDK 待 App 上架后再叠 |
| K3 | **发奖闭环 = 方案 A「回调即发放」** | 官方流程原样（「客户端监听不可信赖 ⇒ 服务器回调 → 服务端发奖 → 客户端向服务端查询」）；客户端永不触发发放 |
| K4 | **H5 端救助入口 = 隐藏** | App 有分发渠道前，H5 引导是死路 |

### 0.2 待核查（T0）——**已由官方文档实文回答**（2026-10-12 抓档；结论全文与实文行号见规格 v1.4 §8/§4.4）

| # | 核查项 | 结论（实文） |
|---|--------|------|
| T0-1 | 快捷广告 / Sigmob 是否覆盖「激励视频服务器回调」 | ✅ **覆盖**：两者均在支持渠道内；服务器回调是 uniCloud 层统一能力（实配以广告位「服务器回调」开关为准；Sigmob 无上架要求、无需软著） |
| T0-2 | 回调**签名算法与校验细则** + **密钥形态** | ✅ **已答**：`sign = sha256(secret:trans_id)`（`ad-rewarded.txt:899-905`）；`secret` = **该广告位一枚**（后台可见）——与「第四键空间 1 键」对位，键名 `ad.callbackSecret` **保留** |
| T0-3 | 回调载荷字段全集、重试策略、对响应码语义 | ✅ **已答（改动面 = 规格 v1.4 §2.4 整段）**：方法 = **HTTP GET（query 传参）**（`:811`）；字段 = `adpid/provider/platform/sign/trans_id/user_id/extra/cpm?`（**无时间戳**）；**响应必须为 JSON `{"isValid": true}`** 才是唯一确认信号，未收到（或响应过慢）⇒ 平台重投（`:860/:922`）；重试窗长文档未载（实配观察） |
| T0-4 | 打包生效形态 | ✅ **部分已答**：渠道 SDK「真机运行不生效、**打包后生效**」（`ad-open.txt:138`）；服务器回调需 **App 平台 3.1.15+**（HBuilderX 5.26 满足） |
| T0-5 | `extra` 字段长度上限与字符集（claim 串要塞进它） | ⚠️ **部分**：文档未载上限（「如无需要则为空」，空 extra 属常态）⇒ nonce 保持缺省 base64url 22 字符，实配时验证 |

**设计对 T0 的抗性**：验签器与 claim 串格式都是**边界**（§4.2）——T0 结论只影响边界内的实现，不改链路形状。T0 结论回填后进规格（边界内定稿；T0-1 若判不支持 ⇒ 回 §9 R1）。

---

## 1. 玩家可见行为（App 端）

1. **入口**（既有逻辑 + 两个新条件）：金币场 ∧ `reliefEnabled` ∧ 余额 < 门槛 ∧ **平台=App** ∧ **`ad.reliefAdpid`（客户端下发裸名 `reliefAdpid`，§4.4）非空** ⇒ 救助按钮渲染。（条件不满足 ⇒ 按钮根本不渲染，不存在「不可用」文案分支。）
2. 点击 → **查询**（GET §4.1；eligible 时签发/复用一次性凭证）→ 分派：
   - 可领 ⇒ 确认弹层（文案：看一段广告，领 N 金豆；N = 服务端给）→ 确认 → **再查询（续窗，§2 窗口时点）** → **播放激励视频**（全屏）。
     - 确认时的查询失败 ⇒ toast 网络异常（不播放）；查询发现已不可领 ⇒ 服务端文案（不播放，D10）。
     - **完整观看**（`isEnded=true`）→ 「正在到账…」轮询（携 claim 只读查询，§5.1）。
     - **中途关闭**（`isEnded=false`）→ **不轮询**，弹层文案「完整观看才能领取」（这是激励视频最高频动作，不得把用户留在假等待里）。
   - 今天已领 ⇒ 服务端文案（「今天已经领过了」同族）。
   - 其它不可用（开关关/余额充足）⇒ 服务端文案（客户端不编文案，D10 纪律）。
3. **到账**：轮询命中（记录 `done` 成功面，或账本当日转真）⇒ 关闭弹层 + 余额刷新（balance 随查询响应带回，§4.1）+ toast「已领取救助 +N」。**终态拒绝/凭证失效**（disabled / balance_ok / 记录不存在）⇒ **提前止轮询**，显示对应服务端 reason；纯 pending 满窗才落「稍后到账」（§1-4）——「被拒」不再伪装成「稍后到账」（r2 第 3 条）。
4. **失败面**：广告加载失败/无填充 ⇒「暂时没有可播放的广告，稍后再试」（不发放）。轮询超窗 ⇒「发放可能稍有延迟，稍后回到本页查看」（余额在服务端，最终一致）。
5. **每天一次**不变（账本 `actionId`，锚 = claim 签发日——§2/§3 口径）。
6. **H5 端**：救助入口**不渲染**（K4；实现落法见 §5.1）。

## 2. 发奖闭环（方案 A + 领取凭证）

**为什么有凭证**：`url-callback` 的 `userId` 是客户端自选经平台透传的（评审 r1 阻断②）——若不绑定，攻击者可任选 userId 把 +200 铸给任意（含新注册）账户并滚动造号。⇒ 受益身份必须由**服务端在 JWT 保护下签发的一次性凭证**决定。

```
App（lobby）                   网关/edge            currency-service                 uni-ad 平台
 点救助 ─GET /api/wallet/relief(JWT)─▶ 裁决(开关/余额/今日) ⇒ 可领时
        ◀─ {eligible, grantedToday, amount, balance, claim?}
        claim = ~22 字符随机串；Redis 绑 {userId, 签发日(Asia/Shanghai), 状态=issued}；同用户复用单键（§3）
 确认 ─GET（续窗：复用同 claim、TTL 重置 15min）─▶ 窗口有效起点=确认（§2 窗口时点）
       ─播放激励视频（url-callback: extra = claim）──────────────────────────▶ 请求广告
 关闭(isEnded)                                                              │ 观看完成
                                                              ┌────────────┘
 轮询（客户端侧）                                              ▼ 回调（平台侧，经 edge，§11 行 20）
 GET?claim=…（只读，§4.1 细则）                    POST /ad/notify/{provider}（仅验签）
 记录 done ⇒ 终态 / issued ⇒ pending /             验签 → claim 解析 → **读记录（done ⇒ 短路 200）**
 不存在 ⇒ 已失效                                   → **账本先行** → 正向裁决 → apply → **终态后落 done/result**（瞬态保持 issued）
 「已领取 +N」/「稍后到账」/终态 reason
```

**窗口时点（r2 第 2 条）**：15min 消费窗的**有效起点 = 确认步骤**——客户端确认时再调一次 GET，已发未耗凭证**复用同 nonce 并续期**（§3）；窗口只承担「确认之后 → 回调到达」，不承担点击/弹层/加载/播放的链路时长。窗长 15min **钉死常量、不设配置键**（避免 41→42 键的闸族连锁）；T0-3 回填若显示平台重试跨度超窗 ⇒ 回设计面复议。

**硬性质**（判据来源）：
- **身份绑定**：发放的 `userId` 只来自 claim（JWT 签发时落 Redis；nonce 为 ~22 字符随机串，不可枚举）；客户端随意改 `extra` ⇒ claim 解析失败 ⇒ 拒发。
- **落序 + 账本先行（r2 第 1 条 + r3 🟠-1）**：回调链 = 读记录（`done` ⇒ 幂等短路 200）→ **账本先行**（该 claim 锚定的 `actionId` 已有流水 ⇒ 终态 replayed，不重跑裁决/apply）→ 正向裁决 → apply → **终态后落 `done/result`**。`done/result` 只在终态之后落——终态 = 账本先行重放、apply 返回（granted/replayed）或正向裁决拒绝（disabled/balance_ok）；apply 抛错/记录写失败/配置不可用/claim 读取故障 ⇒ 保持 `issued`、响应 5xx 让平台重投。⇒ 「首次已成功但响应丢失」的重投在**账本先行**步确定性判 replayed（不会撞余额闸、不污染 `granted` 桶）；任何 `done` 都是终态，短路 200 恒正确（短路口发放面不计，见 §4.5 计数注）。**「claim 不存在」不建键**（仅计回调指标 `claim_invalid`——任意 `extra` 值可诱使造键 = 无界 churn 面）。
- **重投/跨零点双发不可能**：`actionId = relief:<claim.userId>:<claim.签发日>`（日期随 claim 签发时刻固定，**不取回调处理时刻**；复用续窗**不重锚**）⇒ 平台退避重试跨零点 ⇒ 同一 claim ⇒ 同一 actionId ⇒ 账本先行/台账幂等判重放（评审 r1 阻断①的修复）。
- **发放不依赖客户端**：客户端断网/退出 ⇒ 回调照发 ⇒ 下次进入 GET 显示已领。
- **同日多领不可能 + 凭证单张**：`done/result` 保留 48h ⇒ 平台重投照常 200 且不双发；签发按用户**复用单键**（§3）⇒ 同用户同时至多一张未过期凭证、键数 O(用户数)（r2 第 5 条）；**且已发后 `今日已发` 闸不再签发任何凭证**（§4.1 细则②）——同日至多一次发放：此前已签发的任何凭证，其回调或在账本先行判重放、或按正路发放（此时当日尚无流水），两路合计恰一次（r4 🟠-1：原「同日残余凭证窗口 ⇒ 重放」的叙述在新链不可达，已删正——该形态仅存于并发竞窗，重放的**确定性构造**见 §7/§11 行 7）。
- **过期/未签发**：claim 超窗或不存在 ⇒ 拒发（`not_granted:claim_invalid`）；回调面只计指标不建键；GET 携 claim 查询记录不存在时读作「已失效，请重试」（§4.1 细则——r2 第 3 条的读取路径）。

## 3. 数据与状态

- **发放真源 = 账本**（不变）：`currency.apply`，`source='relief_grant'`（既有），**无新表、无 schema 变更**。`actionId` 锚改取 claim 签发日（§2）。
- **claim 记录（新增，Redis）**：`relief:claim:{nonce}` = `{userId, date, state: issued|done, result?}` + 索引 `relief:claim:u:{userId}` → `nonce`（**TTL 与记录同生命周期**；悬垂——索引指向已过期 nonce ⇒ 按「无凭证」新签，r3 🟡-7）。TTL：issued 态 **15min（eligible GET 续期**——签发/确认各一次；落法规格定）；done 态 48h。**同用户已有未过期 issued ⇒ 复用同键同 nonce（续期）、否则新签** ⇒ 键数 O(用户数)（r2 第 5 条）；`date` 在首次签发时刻固定，复用续窗**不重锚**（跨零点样本 §7）。
- **`result` 读取方清单**（全片无独立「结果键」——result 只是该记录内字段，r2 第 8 条）：① **回调入口**——读 `state` 幂等短路（`done` ⇒ 200，不重跑 apply）；② **携 claim 的 GET**（§4.1 细则）——读 `state/result` 出终态 reason；③ **指标 increment 点**——回调链仅在终态处递增。
- **GET 的 `grantedToday` 以账本为准**（唯一真源），口径钉死为 **`actionId` 内嵌签发日**：查询 = 「`actionId = relief:<userId>:<今天(Asia/Shanghai)>` 的流水是否存在」，**不看流水 `created_at` 落账时刻**（跨零点 15min 窗下两口径分歧——r2 第 7 条；样本 §7）。Redis 记录仅作**加速与回调侧载体**，丢失 ⇒ GET 回落到账本仍正确（评审 r1 次要项修复）。

## 4. 服务端（currency-service）

### 4.1 公开面（两处）

| 端点 | 路径 | 入站信任 | 语义 |
|---|---|---|---|
| 回调 | `GET /ad/notify/{provider}` | **仅验签**（照 `/pay/notify/*` 先例；不经网关 JWT；`provider` 渠道段预留，先例 `/pay/notify/alipay`；**公开可达 = 经 edge**，回调 URL `https://<域名>/ad/notify/{provider}`，路由见 §11 行 20） | 平台 S2S 投递（**HTTP(GET)、字段走 query**——官方实文，v1.5 勘误）。验签过且处理**至终态**（账本先行重放/发放/正向裁决拒绝/claim 无效）⇒ **200 + JSON `{"isValid": true}`**（唯一确认信号 ⇒ 平台不重投；**含确定性拒绝**——**坏签名/畸形亦归终态**：「不重投」只能靠回 isValid 表达）；**瞬态**（**claim 读取故障**/apply 失败/记录写失败/配置不可用/限流）⇒ **5xx + `{"isValid": false}`**（平台重投）。响应字面与逐路径映射全文见规格 v1.4 §2.4 |
| 查询 | `GET /api/wallet/relief[?claim={nonce}]` | 网关 JWT（本人） | 返回 `{eligible, grantedToday, amount, balance, claim?, reason?}`；无 claim 入参 ⇒ 裁决 + eligible 时**签发/复用**凭证（§2/§3，窗口刷新点）；**携 claim 入参 = 轮询只读**（细则见下；`balance` 恒取 JWT 侧）；`reason` 文案**服务端给**（D10 纪律） |

- **GET 语义细则（v1.3 更新）**：
  - 无 claim 入参（入口预检与「确认续窗」同路径），判定次序 = ①快照不可用 ⇒ 503/10007 ②**今日已发**（账本当日 actionId 存在）⇒ 「今天已经领过了」——**先于余额闸**（余额回升后的已领用户不得看到「余额充足」，r3 🟡-2）③开关关 ⇒ reason ④余额 ≥ 门槛 ⇒ reason ⑤eligible ⇒ 签发/复用凭证随响应返回。
  - 携 claim 入参（轮询专用，**只读——不签发、不续期**）：**先校验记录 `userId` == JWT 本人**（不符按「不存在」处理，r3 🟡-7）；再查账本（同样按 **JWT 本人 + 时钟当日** actionId，与 §3 口径同源）——已真 ⇒ 成功面返回（`grantedToday=true` + `balance`）；否则查记录——`done` ⇒ 按 `result` 出终态（granted/replayed ⇒ 成功面；disabled/balance_ok ⇒ 对应 `reason`）；`issued` ⇒ pending（`grantedToday=false`，轮询继续）；**不存在 ⇒ `reason` = 「领取凭证已失效，请重试」**——这是 `claim_invalid` 文案的唯一读取路径。窗内轮询看到的恒为 `issued`（不会误报失效）；记录消失 = 窗真正过期（或 Redis 丢失，§9 R7）。**跨零点轮询**：账本查询因「时钟当日」必 miss，由记录路径兜底（done:granted ⇒ 成功面）——两路合计不漏。

- **路由落地两层**（评审 r1 次要项）：网关 `@Get('wallet/relief')` 新增、旧 `@Post('wallet/relief')` 删除；**404 由网关层产生**（统一信封）。
- **回调端点防护对齐支付先例的「可移植子集」**（评审 r1 重要项；**三件套**，r3 🟠-3 补第三件；v1.5 勘误）：**单桶限流**（Redis，fail-open，600/分）+ `rawBody: true`（保留与 pay 同形；GET 无 body ⇒ 不承载判据）、`setGlobalPrefix('api')` 路径豁免、**内部 token 中间件精确豁免**（单常量 `AD_NOTIFY_PATH` 对钉：`createInternalTokenMiddleware([...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH])`——不豁免 ⇒ 验签器之前即 401；豁免面不得扩大的测试族照 `payment-service` `notify.test.ts` 形态）。⚠️ **原「16KB 专属体积闸（413）」随时间线删除**——GET 回调字段走 query、无 body ⇒ 闸失去载体（规格 v1.4 §2.4）。

### 4.2 验签器与 claim 解析（两个独立可测单元）

```
RewardedCallbackVerifier（接口）
  输入：原始请求（headers + **query 参数原样**）
  输出：{ ok: true, extra, transId } | { ok: false, reason }
```
- 平台签名只证「消息来自平台」；**受益身份在下一步**：`resolveClaim(extra)` → `{userId, date}` | 失败原因（**不存在 / 过期 / 畸形** 三分类 + **读取故障（瞬态）**——Redis 连接瞬断不得与「不存在」同归 `claim_invalid`，属 5xx 等重投，r3 🟡-6）。
- 实现按 **T0-2 已答字面**落：`sign = sha256(secret:trans_id)` + `timingSafeEqual`（大小写归一）；**时间窗面删除**（字段全集无 ts）。样本直喂单测。

### 4.3 裁决序（D10 复用 + claim 两步）

回调：验签 → claim 解析 → **读记录（`done` ⇒ 幂等短路 200，短路口发放面不计，§4.5 计数注①）** → **账本先行**（claim 锚定的 `actionId` 已有流水 ⇒ 终态 replayed，落 done:replayed，200）→ 复用既有裁决（逐字四步：①快照不可用 ⇒ 503/10007 ②`reliefEnabled` ③余额 ≥ 门槛 ④`apply`）→ **终态后落 done/result**。规则增补与出处：
- **落序 + 计数规约（r2 第 1 条 + r3 🟠-1）**：`done/result` 只在**终态之后**落——账本先行重放、正向裁决拒绝（disabled/balance_ok）与 apply 返回（granted/replayed）都是终态；**配置不可用/claim 读取故障/apply 抛错/记录写失败属瞬态** ⇒ 不落、5xx 可重投。`granted` **与 apply 返回同点计入**（金钱事实已发生）；此后记录写失败 ⇒ 重投走账本先行 ⇒ `replayed`+1——两笔各计一次（一回调一计在回调面恒成立，发放面逐路径归属见 §4.5 计数注）。并发双投 ⇒ apply 一侧 granted 一侧 replayed，`result` 以先落为准（规格定），金钱正确性由 `actionId` 幂等独占保证。
- **账本先行（r3 🟠-1）**：仅凭记录不足以安全短路——「apply 已提交但 done 未落」的重投若直进裁决，会先撞余额闸（发放后余额 ≥ 门槛）被拒为 `balance_ok`，永久错过真实终态。故回调在**裁决之前**先查账本：actionId 已有流水 ⇒ 不重跑裁决/apply，直接 replayed 终态。既有代码事实（`slice-18:1187` 注释逐字「同日立即再领 = 14004『余额充足』，不是 replayed」）印证的正是「余额闸先于 apply」这一必须绕开的形态。
- claim 无效 ⇒ 拒发（`not_granted:claim_invalid`）：**不建键**，只计回调指标；GET 携 claim 读作「已失效」（§4.1）——**新增规则，显式登记**（评审 r1 阻断②的载体 + r2 第 1/3 条）。
- 同日金额被改后旧载荷重投命中 **14002** ⇒ 照 D10 翻成「今天已领过」（`not_granted:replayed`），**不**把 409 抛给平台（评审 r1 次要项；D10 `gold-room-design.md:170`）。
- `extra` 非本 adpid 用途 ⇒ 无法解析为 claim ⇒ 同上拒发（无需单独 extra 常量——claim 本身就是用途标识，评审 r1 次要项简化）。

### 4.4 密钥与配置

- **回调密钥承载 = 新增第四键空间**（裁决）：照支付（第二）/通知（第三）键空间的同构四件套——表 + 迁移、专用拉取 RPC + **专属拉取令牌 env**、管理页掩码写、网关 policy、审计挂载、测试族；先落 1 键（键名随 T0-2）。⇒ **「无新 env」撤回**：新增 1 个拉取令牌 env（评审 r1 重要项）。
- **adpid**：配置中心**第 41 键** `ad.reliefAdpid`（**首个 string 型键**：trim、字符集 base62、长度 ≤32；空串合法=未配置）。parse 分支照 `parseIntervalMs` 严格形态；管理页编辑器为 JSON textarea ⇒ **`CONFIG_NOTES` 写明「以带引号字符串输入」**（评审 r1 次要项）。**种子迁移**逐键一支（先例 `1794000000000-IntervalConfigSeed`）。**客户端下发键名 = 裸名 `reliefAdpid`**（同族惯例 `reliefEnabled`/`entryMultiplier`…，r3 🟡-9）——§1-1/§5.2 的入口条件读的就是它。
- **客户端下发**：`client-config.controller.ts` 十四→十五键组装表加行（不加 ⇒ adpid 到不了客户端，整片不可达——评审 r1 重要项）。

### 4.5 观测（单一枚举表收口）

| 业务结果 | `currency_relief_total{result}`（发放面，**沿用既有指标名与值域**） | `relief_callback_total{result}`（回调面，新） | GET reason（文案面，读取路径见注） |
|---|---|---|---|
| `granted`（发放） | `granted` | `accepted` | —（`grantedToday=true` + `balance`） |
| `not_granted:replayed` | `replayed` | `accepted` | 今天已经领过了 |
| `not_granted:disabled` | `rejected` | `accepted` | 救助暂未开放 |
| `not_granted:balance_ok` | `rejected` | `accepted` | 余额充足，无需救助 |
| `not_granted:claim_invalid` | —（未触发放面） | `claim_invalid` | 领取凭证已失效，请重试 |
| —（验签失败/畸形/内部错误） | — | `bad_sign` / `malformed` / `error` | — |

- **一回调一计**：回调列每行**单值**——`claim_invalid` 自成一桶，不再写「`accepted` + 直接计…」双值（r2 第 4 条）；回调面枚举 = `{accepted, claim_invalid, bad_sign, malformed, error}`。
- **回调逐路径计数注（r3 🟠-1）**：一回调一计在**回调面**恒成立（每次回调恰入一桶）；**发放面只记真实裁决**——① 读记录 `done` 短路（顺序重投）：回调面 `accepted`，**发放面不计**（原处置已计；重投的 `replayed` 只来自真实到达账本先行/apply 的重放）② 账本先行判重放（apply 已提交而记录未落的窄窗；确定性构造见 §7）：`replayed`/`accepted` ③ 正向裁决拒绝：`rejected`/`accepted` ④ apply granted：`granted`/`accepted`（**与 apply 返回同点计入**）⑤ apply replay：`replayed`/`accepted` ⑥ 瞬态（含 claim 读取故障）：`error`，发放面不计。
- **值域沿用（r2 第 4 条）**：`currency_relief_total` 保持既有三桶 `{granted, replayed, rejected}`（disabled/balance_ok 并入 `rejected`——与 `currency.metrics.ts` 现注释逐字一致）⇒ 面板题注（`05-currency.json:139`）与 slice-18 H 组（`:1308-1313`）**值域零改动**（H 组的断言语境与数据源另见 §11 行 7）。
- **reason 面读取路径**（与 §4.1 细则一一对应，r2 第 3/8 条）：`granted/replayed/disabled/balance_ok` **两路可达**（无 claim 裁决路径 + 携 claim 记录路径，同一文案面）；`claim_invalid` **仅携 claim 路径可达**（记录不存在；不落键）。「稍后到账」不在此表——它是客户端纯 pending 满窗的本地文案（§1-4），不是服务端 reason。
- **`currency_relief_total` 由回调发放路径继续 increment**（旧 POST 生产者退役但指标不熄火）⇒ `05-currency` 面板**不换源**（评审 r1 重要项）。枚举在规格里定稿为逐字表。
- **告警 2 条**（既有 25 → **27**，评审 r1 计数订正）：
  - `ReliefCallbackBroken`：`bad_sign` 或 `error` 10m 内 > N（密钥错/对端换协议/被打）。
  - `ReliefGrantZero`：回调流量（`relief_callback_total` 任意 result）> 0 且 `currency_relief_total{result="granted"}` == 0 持续 N 分钟（**「看了广告永不发」必须响亮**，D4 纪律，评审 r1 重要项；值名随 §4.5 值域沿用订正——r2 第 4 条）。
- 规则**恰好 27 条**的逐名单断言面（r3 🟡-10 补全）：`slice-16-monitoring.ts:94-106`（`EXPECTED_RULES` 名单本体）· `:702`（promtool「25 rules found」计数——只改两处名单此处必红）· `:766`（/api/v1/rules 名单同核）· `slice-18-gold-room.ts:1322`（§11 行 6 同核）。

## 5. 客户端

### 5.1 `net/ads.ts`（新薄层）

```
playRewardedAd(adpid, { extra: claim }) → Promise<'completed' | 'closed' | 'unavailable' | 'error'>
isRewardedAdSupported() → boolean        // 显式出口：内部收口平台判断与异常语义
```
> `userId` 形参已删（r3 🟡-8）——受益身份只来自 claim（§2「为什么有凭证」），客户端不传任何身份字段；平台侧若有同名透传字段，服务端一律不读。
- 平台判断复用 `detectPlatform()`（`net/mp-transport.ts`）；`detectPlatform` 对未知平台**抛错**——`isRewardedAdSupported()` 在其上包异常语义（非 App ⇒ false），渲染条件与流程分支都从它读，**单测注桩**（jsdom 下 `readUniSystemInfo()` 返回 `{}` ⇒ 不会静默走错分支；评审 r1 次要项）。
- `uni.createRewardedVideoAd({ adpid, urlCallback: { extra: claim } })`（API 形态，由确认弹层触发）。`onClose(res.isEnded)` 仅作 UX 判据（§1-2 两分支），**绝不触发发放**。
- 单测四分支：可领-完整观看（轮询命中）/ 可领-中途关闭（不轮询，专用文案）/ 已领 / 无填充；+ **轮询终态三出口**（成功面 / 终态拒绝 reason / 「凭证已失效，请重试」）。
- **轮询**：`isEnded=true` 后**携 claim 的 GET（只读）**，2s × 3；**终态即止**；纯 pending 满窗 ⇒「稍后到账」。

### 5.2 lobby 改造

- 占位流程（确认 → **POST 发放** → toast）改为：查询（签发/复用 claim）→ 确认 → **再查询（续窗，§2 窗口时点）** → 播放 → 轮询 → toast；占位 POST 调用删除。
- 入口渲染条件追加 `isRewardedAdSupported()` ∧ **裸名 `reliefAdpid`** 非空（源 = 配置中心 `ad.reliefAdpid`，§4.4；H5 隐藏，K4）。

### 5.3 构建

- `manifest.json` app-plus 广告配置；**云打包/自定义基座勾选 Sigmob 渠道**（真机联调方式按 T0-4）。
- **验收前置**：安卓真机一台（用户侧，§9 R4）。

## 6. 合规（引用而非断言）

- 官方「激励不得直接发钱」：金豆为游戏内虚拟币。**救助来源不入可离场额度**——真源 = 支付设计的 cap 公式排除 `relief_grant`（`2026-10-05-payment-design.md` §5.1 / `currency.withdrawable.get`）；「铸币经对局洗为可提余额」是支付片**已登记**的既有口径（同文件 R5），本片以 claim 绑定把铸币口收到「真实观看的每账户每日 1 次」。
- 救助每日 1 次（官方建议 ≤15 次/日/人，宽裕）。

## 7. 测试与判据

| 面 | 判据 |
|---|---|
| 单测·服务端 | 验签器样本（好/坏/缺字段/超时间窗）· **claim 族**：不存在/过期/已用（短路同结果 200）/畸形/改串/**读取故障（注入 ⇒ 5xx 且记录保持 issued，不与 claim_invalid 同归）** · **落序两注入**（r2 第 1 条 + r3 🟠-1）：(a) apply 抛错 ⇒ 重投 ⇒ 发放且落 done:granted；(b) **apply 已提交但记录写失败** ⇒ 重投 ⇒ **账本先行判 replayed**、落 done:replayed、金额不再增 · **窗尾**（r2 第 2 条）：确认+14:59 回调 ⇒ 发放；+15:01 ⇒ 拒发且**不建键** · **携 claim 轮询五态**（r2 第 3 条）：issued / done-granted / done-replayed / done-disabled / 记录不存在；**跨主体（他人 claim）⇒ 按不存在** · **复用**（r2 第 5 条）：同用户两连 GET ⇒ 同 nonce（续期）；连发 GET 后 Redis 键数不增 · 裁决序回归 · 14002 翻码 · `actionId` 锚签发日 **+ `grantedToday` 同口径**（**跨零点样本**，r2 第 7 条：23:58 签、00:07 回调 ⇒ 锚 D 日；D 日 GET ⇒ 已领；D+1 配额口径 ⇒ 未领——**直取口径函数断言；e2e 不得照搬**：现行种子金额 200 ≥ 门槛 150，回调后余额闸会先接走，r3 附注） |
| 单测·客户端 | `ads.ts` 四分支 + 轮询终态三出口 + `isRewardedAdSupported` 桩 · **源码闸：客户端不再出现 `POST /api/wallet/relief`** |
| conformance **slice-24（新）** | 拒发路径穷尽：坏签名/畸形/未签发 claim/过期 claim/改串 claim/开关关/门槛足/用户不存在（以 claim 不存在覆盖）⇒ 全拒；正路只发一次（**经门口 `https://localhost:8443/ad/notify/*` 一条**，照 slice-21 顺带验收 Caddy 路由）；**重投幂等**：同载荷第二次 ⇒ 200 且余额不变（done 短路，发放面不重复计 granted）；**账本先行重放**（**记录保持 issued** + **RPC 预置同锚流水**（actionId 逐字 `relief:<userId>:<D>`）⇒ replayed 且金额不变；⚠️ **不得用「记录移除」构造**——记录移除 ⇒ resolveClaim 不存在 ⇒ claim_invalid，到不了账本先行（R7 口径，r4 🟠-2））；**跨零点重投**（样本构造）；GET 查询与 claim 签发语义（含**已领优先于余额闸**）；**携 claim 轮询四态**（pending / 成功 / 终态拒绝 / 失效）；**`claim_invalid` 不建键**（Redis 键数前后对照）；旧 POST ⇒ 404 |
| 真机走查（安卓真机，用户在场） | 测试广告位：完整观看 → 到账；**中途关闭 → 不到账 + 专用文案**；文案分支 |
| 静态/计数闸 | §11 全表同步 |

## 8. 上线顺序与运维

1. 代码 push/tag 上线（**暗**：`ad.reliefAdpid` 空 ⇒ 入口不可用、零行为变化）。
2. **操作前快照**：管理面确读 `reliefEnabled=false`（「从未开启」的当场证据，评审 r1 次要项）。
3. 用户侧：uni-ad 实名 + 财务审核 → 绑定应用 → 开通快捷广告 + Sigmob → 申请**激励视频广告位**（开启服务器回调）→ 得 adpid + 密钥 → 后台配回调 URL **`https://<域名>/ad/notify/{provider}`**（公网经 edge；生产只发 80/443——路由 §11 行 20）。
4. 配置：管理页填 `ad.reliefAdpid`（带引号）；回调密钥入库（第四键空间加密面）。
5. 开 `reliefEnabled` → 真机验收（§7）。
6. `first-deploy.md` 新增「广告怎么开通」节（回调 URL 配置点、换广告位手顺、密钥轮换）。

## 9. 风险与登记

| # | 风险 | 处置 |
|---|------|------|
| R1 | T0-1 核查若不支持回调 ⇒ 方案 A 不成立 | 回裁决面：B（claim+两段式——本片 claim 机制已铺好一半）或 C（客户端回执+登记风险）——**不在本设计内自决** |
| R2 | 快捷广告填充率低 ⇒「暂无广告」频发 | 登记：起步档常态；叠渠道 SDK（上架后）改善 |
| R3 | 回调端点=新公开面 | 防护对齐支付先例（16KB 闸 + 单桶限流 + 验签先于一切）；安全评审在规格轮复核 |
| R4 | 真机验收依赖用户设备与账号进度 | 登记进交接文档（「谁能产生证据」纪律） |
| R5 | 第四键空间 = 切片内整套机制（表/RPC/令牌/policy/审计/测试族） | 规模已入 §11；如规格期判定过重，回落裁决面（复用第三键空间 vs env，均需显式登记）。⚠️ **r2 附言**：该空间拉取令牌持有方 = config-service + relay + renderer 三方 ⇒ 复用会把回调密钥可读面从「一方（currency-service）」扩到**四方**，规格期若真走此路须显式评估；R1 兜底 B 的复用面应读作「签发/绑定/日锚半段」——消费半段是另一套信任面 |
| R6 | claim 被「观看前泄漏」无后果（claim 只是授权看，不是发奖凭证；消耗需平台回调） | 登记：威胁模型已覆盖（§2 身份绑定） |
| R7 | Redis **丢失/重启**（数据面丢失）⇒ 在途 issued 凭证全失效 ⇒ 回调拒发 | **fail-closed 口径**（宁少发不滥发）：影响面 = 丢失瞬间在途窗（≤15min）内的观看 ⇒ 用户重试可恢复（「凭证已失效」文案可达）；**已发放记录丢失** ⇒ 后续重投计 `claim_invalid` 而非 `replayed`——无金钱后果（`actionId` 幂等独占）；GET 侧不受影响（`grantedToday` 以账本为准）。**瞬断（连接故障、数据未丢）另属**：resolveClaim 读取故障 ⇒ 5xx 可重投（r3 🟡-6，不归本条）。r2 第 5 条 |

## 10. 明确不做（YAGNI）

- 其他广告位（开屏/插屏/信息流）· H5 任何广告变现 · 广告频次系统（救助日 1 次）· 多渠道 SDK 同时开通 · 广告位 A/B · 客户端本地「已领」缓存（服务端为准）· claim 签发频率限制——**不需要**：签发已按用户复用单键（键数 O(用户数)，连发 GET 不再造键，r2 第 5 条）；15min 窗长亦**不设配置键**（常量钉死，避免闸族 41→42 连锁）。

## 11. 闸族同步（v1.2：补新片注册面；规格逐条定位）

| # | 面 | 位置 | 改什么 |
|---|---|---|---|
| 1 | 配置键 | `protocol/src/config.ts` + `config.test.ts:10-45` | 40→41 + 「恰好四十键」与「客户端子集恰十四键」两份逐字名单 → 41/15 |
| 2 | **种子迁移** | `config-service/src/migrations/` | 新迁移一支（先例 `1794000000000-IntervalConfigSeed`）——无它管理页列表不出新键，§8-4 不可执行 |
| 3 | 客户端下发 | `config-service/src/config/client-config.controller.ts:6-24,43-66` | 十四→十五键组装表 + 兜底 |
| 4 | config-service 测试族 | `test/helpers/config-probe.ts:139-185`（SEED 第二副本）· `platform-config.service.test.ts` · `admin.controller.test.ts` · `client-config.test.ts` · `config.rpc.test.ts` · `migration.test.ts` | 计数块与名单 |
| 5 | conformance 计数组 | `slice-14:498-505` · `slice-17:1265-1273` · `slice-18:100-107,856-861`（14 键/四十键名单） · `slice-20:717-723` · `slice-21:688` · `slice-22:847-854,1097` · `slice-23:731-741,1283` | 40→41 / 14→15 |
| 6 | 告警计数 | `ftl-alerts.yml` + `slice-16:94-106`（名单本体）· `:702`（promtool 计数）· `:766`（rules 名单同核）+ `slice-18:1322` | 25→27 逐名单同核（**四处**，r3 🟡-10） |
| 7 | 救助既有切片 | `slice-18:1187-1255`（G 组救助四态，全走 POST）· `:1297-1313`（H 组三桶 ≥1/≥1/≥2） | **G 组原位改写为新链驱动**（GET 裁决 + 签名回调样本）：四态确定性构造——`granted`=正路 / `replayed`=**先 GET 签发、后 RPC 预置同锚流水（actionId 逐字 `relief:<userId>:<D>`；slice-18 自带 rpcApply 可自定义 actionId `:411/:1006`，RPC 直投不计端点指标 `slice-21:947` 先例）、再投签名回调 ⇒ 账本先行判重放**（⚠️ 旧注释「扣回后再领 ⇒ replayed」在新链**不可达**——`今日已发` 闸挡第二张凭证，r4 🟠-1 删正）/ `rejected×2`=中途切开关·中途充值后回调 ⇒ **H 组断言语境与数据源原位可保**（H 读进程生命周期计数，唯一数据源=同切片 G；G 迁出必红——r3 🟠-5）。断言数变化按实跑回填（本机全序实况 + CI 权威轮）；回调签名样本夹具落 `tools/conformance/fixtures/` 共用（slice-24 同源） |
| 8 | 网关 | `api-gateway/src/gateway/gateway.controller.ts:286-328` + `test/gateway.controller.test.ts:888-966,1132,1147` | 删 `@Post('wallet/relief')`、加 `@Get` |
| 9 | currency-service | `wallet.controller.ts` 旧 POST 移除 · `test/relief.test.ts` 整族重写去向 · 新 ads 模块 · `main.ts:42` 路径豁免 + `rawBody` | §4 |
| 10 | 客户端测试族 | `test/wallet-entry.test.ts:222,269`（十四键枚举）· `lobby-ux.test.ts` 等 · 新 `ads` 测试 · 源码闸 | §5 |
| 11 | client-protocol | `docs/client-protocol.md:52,54,88` | data 形状 + 41 键 + 15 键 |
| 12 | design.md 散点 | `:142,:408,:492,:499,:1092`（GET /api/config 恰十四键名单）· `:1185` · `:1213,:1224,:1415,:1564,:2039` | 计数与 `ad.` 消费者段 |
| 13 | first-deploy | `:993-1033` | 四十键一览 → 41 + 广告键运营提示 |
| 14 | 管理页 | `admin/app.js:110,124,134-137,290,607,623,646,662` | 计数注记 + `CONFIG_NOTES` +1（含 string 输入说明） |
| 15 | **第四键空间** | config-service/网关/审计/管理页/测试族 | §4.4 四件套（1 键）；**+ `conformance-stack.sh` 种子段注入回调测试密钥**（slice-18 改写组与 slice-24 共同前置） |
| 16 | 回调基建 | `currency-service/src/main.ts` | **三件套**（r3 🟠-3）：`setGlobalPrefix('api')` 豁免 + `rawBody: true` + **内部 token 中间件精确豁免**（`AD_NOTIFY_PATH` 单常量对钉，`[...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]`；照 `payment-service` `main.ts:53`） |
| 17 | 面板/指标 | `grafana/dashboards/05-currency.json:139`（题注 `granted|replayed|rejected`） + `slice-18:1308-1310` + slice-16 面板名单 | `currency_relief_total` **不换源、不换值域**（沿用三桶；disabled/balance_ok 并入 `rejected`；回调路径继续 increment）⇒ 面板题注与 slice-18 H 组断言**零改动**（r2 第 4 条） |
| 18 | 注释散点 | `platform-config.entity.ts:10` · `platform-config.service.ts:45,57` · user/room/robot `config.client.ts` 注释 | 「四十键」字面量扫全（照节奏片手法） |
| 19 | **新片注册面** | `tools/conformance/src/run.ts` CASES（表尾「追加在末尾」注释纪律）· `tools/conformance/baselines.json` | 注册 `slice-24`：CASES 追加末尾（顺序即 CI 切片循环与 full 回填顺序）；`baselines.full` 现 28 片 ⇒ 新增一条（先例 gold-room `slice-18-gold-room = 132`）；⚠️ `full` 列**不得以本机读数回填**（CI 权威轮） |
| 20 | **edge 路由** | `deploy/Caddyfile`（现 `/pay/notify/*` 在 `:70-71`，模式照抄） | 加 `handle /ad/notify/*` → `currency-service:3004`（**必须在 catch-all `handle {` 之前**——同 `/pay`、`/grafana` 的 2026-10-01 实测规矩）；重建手顺：`build edge && up -d edge` + **显式 `EDGE_HTTPS_PORT=8443`**（环境纪律第 18 条）；slice-24 判据经门口（§7）——无此行 ⇒ 回调 404、永无发放（r3 🟠-4） |

---

**引用**：uni-ad [业务介绍](https://uniapp.dcloud.net.cn/uni-ad/uni-ad.html) · [开通指南](https://uniapp.dcloud.net.cn/uni-ad/ad-open.html) · [激励视频（平台差异/url-callback/官方发奖流程）](https://uniapp.dcloud.net.cn/uni-ad/ad-rewarded-video.html)
