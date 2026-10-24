# 广告救助（激励视频 → 每日救助）对接现状与验证记录

- 日期：2026-10-17（**2026-10-18 续记：uni-ad 广告位已配置；测试服已部署 `dev-a9800e3`；管理页三项核对通过；线上回调链真栈 e2e 全绿**）
- 结论：代码链路已接通，dev 真栈 conformance 两跑全绿；**uni-ad 侧已配置、测试服已部署含 v1.4 闭环的 `dev-a9800e3`**；管理页三项已核对、救助开关已开、服务端回调链（签发→验签→发放→重投幂等→拒发）已在测试服真栈逐态验证；**剩余仅 App 真机走查**（真机上的完整观看/中途关闭/重复领取三态）。
- 关联：设计 v1.5 / 规格 v1.4 `2026-10-11-ads-relief-{design,spec}.md`；原交接 `2026-10-11-post-ads-handoff.md`

## 0. 新会话续做入口（2026-10-18）

> 新会话先读 `CLAUDE.md` → `docs/dev-process.md` → 本文件。
> 确认在 `dev` 分支并 `git pull origin dev`；不同 clone / 工作目录也以 `dev` 为准。

**当前状态（2026-10-18 收尾）**：
- 用户确认 **uni-ad 广告位已配置**（激励视频 + 服务器回调 + 业务在传统服务器 +
  回调 URL `https://<域名>/ad/notify/uniad`）。
- **测试服已部署 `dev-a9800e3`**（19 容器健康；`platform_config` 50 键；含 2026-10-18 的
  `fix(config): reliefAdpid 出站归一回字符串`）。APK 为 `0.1.0-2eed0fd`
  （`/download/优比棋牌.apk`，200 / 18,091,383 B / sha256 `477ac33e…`；⚠️ 该 APK 不入库，
  构建机必须先把**它**放进 `deploy/download/` **再开始构建** edge，否则 404 —— 2026-10-18 已遇过一次，
  最终 tag `dev-a9800e3` 已恢复）。
- **真机三态账号已备好**（测试服，密码均 `Relief!2345`；可直接在 App 登录）：
  - `13800000102` —— 完整观看用例（未领、余额 0）；
  - `13800000103` —— 中途关闭用例（未领、余额 0）；
  - `13800000101` —— 当天重复用例（**今日已领**、余额已调回 0 ⇒ 入口会亮，点后应显示「今天已经领过了」）。
- **管理页三项已核对通过**（经管理 API，与页面同源）：`ad.reliefAdpid = "1948867796"`
  （非空）、广告回调 Secret **已配置**（指纹 `ef1c4a33ed19`）、`currency.reliefEnabled = true`、
  `currency.reliefAmount = 200`。
- **服务端回调链已在测试服真栈逐态验证**（详见 §2.1）：签发 → 验签 → +200 → 重投幂等 →
  坏签名不发放 → 无回调不发放；客户端 `/api/config` 下发 `reliefAdpid` 为**字符串**（18 键）。
- **App 真机走查已完成（2026-10-18 晚，测试服 `dev-76c6ed5`）**：三态在真机通过
  （102 完整观看 → 余额 0→200 且服务端 `relief_grant` 落账；103 中途关闭 → 无发放；
  101 当天重复 →「今天已经领过了」）。详见 §2.2-c。
  2026-10-18 晚诊断包还验证了 **appid 修复后广告可填充**（原「暂时没有可播放的广告」不再出现）；
  期间抓出并修复真实回调 `user_id=` 空串被误判 malformed 的缺陷（`57b213b5`）。
- 生产/其他环境若尚未部署同一版本，仍需先发布（含 edge 重建），并**补 `.env` 的
  `AD_CHANNEL_PULL_TOKEN`**（2026-10-18 测试服在此踩坑，见 §2.1）。

**可直接粘贴给新会话的续做提示**：

```text
继续广告救助上线收尾（App 真机排障中）。先读 CLAUDE.md、docs/dev-process.md 和
docs/superpowers/plans/2026-10-17-ads-relief-status.md（重点 §2.2）。
当前：
- 测试服已部署 dev-a9800e3；管理页三项核对通过（adpid=1948867796、
  回调 Secret 指纹 ef1c4a33ed19、reliefEnabled=true）；服务端回调链真栈 e2e 全绿
  （+200/重投幂等/坏签名不发放/无回调不发放）。
- App 真机点领取 ⇒「暂时没有可播放的广告」。已确认：出包检出 d:\Code\pokergame
  停在 dev@9cac746，而开发检出 d:\Code\ftl-branch 在 dev@67a10915；
  且工程 appid 曾是 __UNI__C6D611F，uni-ad 广告位所属应用是 __UNI__CE6765E。
  已把工程 appid 切到 CE6765E（67a10915），并加了错误码诊断（b6628be0）。
请：
1) 确认分支 dev 且 git pull；【关键】用**同一个最新检出**出包（不要用旧的 pokergame 检出）；
   出包前核对 apps/client/src/manifest.json 的 appid = __UNI__CE6765E、git log -1 含 67a10915；
2) 在最新 dev 检出构建诊断包：
   VITE_AD_DIAG=1 VITE_WS_ENDPOINT=https://<DEV_HOST> VITE_API_BASE=https://<DEV_HOST>/api \
     pnpm --filter @fight-the-landlord/client build:app
   然后 HBuilderX 打开 apps/client/dist/build/app → 云打包（包名 com.yobeeo.pokergame 不变）；
3) 安装后用 13800000102 / Relief!2345 领取，把提示括号里的错误码带回：
   -5002 = adpid/adid 归属仍不一致；-9002 = uni-ad 业务状态；无填充码 = 等库存；
4) adid 保持 125339040306（不要重新生成/新建应用）；adpid 保持 1948867796；
5) 广告能播后走三态验收：102 完整观看→+200、103 中途关闭→不到账、
   101 当天重复→已领；然后更新 handoff、提交推送。
注意：APK 不入库，重建 edge 前必须先把 APK 放进 deploy/download/；其他环境部署
必须补 .env 的 AD_CHANNEL_PULL_TOKEN。
```

**服务端版本判定**：见 §4 第 1 条。`v1.13.4` 仍是旧回调契约；测试服的
`dev-a9800e3` 才是包含 v1.4 的版本。

## 1. 已验证通过（2026-10-17，当前 dev 栈）

| 切片 | 第一跑 | 第二跑 | 断言 |
|---|---|---|---|
| `slice-24-ads-relief` | ✅ 26.7s | ✅ 27.7s | **224 / 224** |
| `slice-18-gold-room` | ✅ 243.0s | ✅ 233.0s | **150 / 150** |

覆盖：ad-channel 键空间（掩码/指纹/权限矩阵）· 客户端 18 键/管理面 50 键 · claim 签发/复用/悬垂/并发 ·
拒发穷尽（开关/余额/未签发/坏签名/malformed）· 正路发放 +200 · 重投幂等 · 账本先行重放 ·
跨零点 · 轮询四态 · claim_invalid 不建键 · 旧 POST 404 · 收尾零残留。

单元/组件侧同时全绿：currency-service **351**、config-service **436**、客户端
`ads-flow` + `lobby-ux` **57**。

## 2. 代码状态

- **T0-2 对称密钥闭环已落地**（`14203c4d`，合并 `5a0ddf52`）：
  - 回调 = HTTP GET，`sign = sha256(secret:trans_id)`，`timingSafeEqual`；
  - 响应 = `200 {"isValid":true}`（确定性终态）/ `{"isValid":false}`（瞬态，平台重投）；
  - 删 RSA/POST 占位骨架；conformance helper + 夹具 + stack 种子同构改写。
- **conformance 键面已迁移到当前 dev**（`9ef0a788`）：
  - 管理面 49→50、客户端 17→18（补 `cardCounterEnabled`）；
  - 八片精确键集同步；slice-18/24 实跑通过。
- **合并改名种子迁移改为 `INSERT IGNORE`**（`bcf0e38a`）：
  - `BotFillConfigSeed1795400000000` / `RiskDeviceBindingSeed1795600000000` 在合并期改过时间戳；
  - 跑过旧类名的库已有键但迁移记录是旧名 ⇒ 普通 INSERT 会让 config-service 启动即主键冲突；
  - `IGNORE` 保留库里现值、迁移记录照常写入。
- **`reliefAdpid` 出站归一回字符串**（`5c72ae4d`，2026-10-18）：修 TypeORM 对数字形 JSON
  字符串的双解析（详见 §2.1-b）；含回归单测，config-service **437** 测试全绿。

## 2.1 2026-10-18 测试服真栈验证（`dev-5c72ae4`）

**部署**：tag `dev-5c72ae4`（= `5c72ae4d` 的 7 位短 sha）→ 测试服；15 个业务/监控容器镜像
全部同 tag；`/api/health` 200；`/admin/app.js` 与 tag 逐字节一致。

**管理页三项核对**（经 `GET /api/admin/config` 与 `GET /api/admin/ad-channel`，与页面同源）：

| 项 | 值 | 判定 |
|---|---|---|
| `ad.reliefAdpid` | `"1948867796"`（DB 内为 JSON 字符串） | ✅ 非空 |
| `ad.callbackSecret` | `configured:true` · fingerprint `ef1c4a33ed19` | ✅ 已配置 |
| `currency.reliefEnabled` | `true`（version 2，2026-10-17 13:35 由 admin 写入） | ✅ 已开 |
| `currency.reliefAmount` | `200` | ✅ |

**客户端面**：`GET /api/config` = 18 键；`reliefEnabled:true`；`reliefAdpid:"1948867796"`
（**字符串** —— 本轮修掉了 TypeORM 将数字形 JSON 字符串双解析成 number 的缺陷，见 §2.1-b）。

**回调路由契约（经线上 edge）**：`GET /ad/notify/uniad`（无 query）⇒ `200 {"isValid":true}`
（终态 malformed）；`POST` ⇒ `405 failure`；坏签名 ⇒ `200 {"isValid":true}`（终态、不发放）。

**服务端全链 e2e**（用**库里真实配置的回调密钥**在服务器侧解密后构造签名；密钥未出服务器）：

| 场景 | 回调应答 | 钱包/状态 |
|---|---|---|
| 正常领取（签发 claim → 有效签名回调） | `200 {"isValid":true}` | 余额 0 → **200**；`grantedToday=true`；`eligible=false`；`reason=今天已经领过了` |
| 同载荷重投（幂等） | `200 {"isValid":true}` | 余额保持 **200**（不重复发放） |
| 坏签名（claim 有效） | `200 {"isValid":true}`（终态） | `grantedToday=false`；余额 **0**（不发放） |
| 签发 claim 但不回调（= 中途关闭） | — | `grantedToday=false`；余额 **0**（不发放） |

> 结论：**服务端「签发 → 验签 → 发放 → 幂等 → 拒发」五态在测试服真栈全部符合规格**；
> 唯一未覆盖的是「uni-ad 平台 → 我方回调」的真实投递（需 App 真机看一次广告）。

### 2.1-a 阻断项：`AD_CHANNEL_PULL_TOKEN` 缺失（已修）

首轮有效签名回调返回 **503**；`currency-service` 日志逐字：

```
config.adChannel.get 拉取失败且无历史成功值（按瞬态处置）：config.adChannel.get 业务拒绝（code=10002）：拉取令牌不匹配
广告回调验签不可用（瞬态 ⇒ 5xx 等重投）：广告回调密钥拉取失败且从未成功拉到（无回落值）
```

根因：服务器 `/srv/pokergame/.env` **没有 `AD_CHANNEL_PULL_TOKEN`**（compose 两处
`${AD_CHANNEL_PULL_TOKEN:-}` 均为空 ⇒ config-service 拒一切拉取）。表现是「站正常、管理页能存
密钥，但**每条真实回调都 503** ⇒ 玩家看完广告永远不到账」——**只有有效签名回调才会暴露**，
malformed 探针（200）看不出来。

处置：`openssl rand -hex 32` 生成 → 追加到服务器 `.env` → 重建 `config-service` +
`currency-service`（`.env` 改动不会自动进容器）→ 重跑 e2e 全绿。`docs/ops/first-deploy.md`
已补该键的运维表与「广告怎么开通」第 0 步。

### 2.1-b 缺陷：`reliefAdpid` 被 TypeORM 双解析成 number（已修，`5c72ae4d`）

真栈实测：`platform_config.value` 是 JSON **字符串** `"1948867796"`，但 TypeORM 的 json 列
读路径对「形如数字的 JSON 字符串」做了二次 `JSON.parse` ⇒ `/api/config` 下发
`"reliefAdpid":1948867796`（number）。协议与 uni-ad（`adpid: string`）都要求字符串；
数字形态在 App 原生层可能被拒。修复：`client-config.controller.ts` 出站边界
`String(...)` 归一回字符串 + 单测（假库以 number 形态读出 ⇒ 出站仍为字符串）。

**最终部署复核**：`dev-a9800e3`（恢复 APK 的重新构建轮）部署后复跑——新账户
`13800000101` 有效签名回调 ⇒ `200 {"isValid":true}`、余额 0→200、`grantedToday=true`；
`/api/config` 仍下发字符串 adpid；`/download/优比棋牌.apk` 200 / 18,091,383 B /
sha256 `477ac33e…`；两容器内 `AD_CHANNEL_PULL_TOKEN` 均为 set。

## 2.2 2026-10-18 真机失败排障（进行中）

**现象**：App 真机点「确认领取」⇒ 立即「暂时没有可播放的广告」（无广告画面）。
服务端回调链此前已全绿（§2.1），所以问题在广告 SDK/打包侧。

**已确认的根因链**：
1. **出包检出不等于开发检出**：开发检出 `d:\Code\ftl-branch` 在 `dev@67a10915`；
   出包检出 `d:\Code\pokergame` 停在 **`dev@9cac746`**（旧提交，manifest appid 仍是
   `__UNI__C6D611F`，也没有诊断代码）。**出包前必须确认检出已 pull 到最新 dev**。
2. **appid 与广告位所属应用不一致**：安装包/旧工程 appid = `__UNI__C6D611F`，
   而 uni-ad 后台广告位所属应用 = **`__UNI__CE6765E`**（应用名 pokergame，2026-10-12 创建）。
   已按用户裁决把工程 appid 切到 `__UNI__CE6765E`（`67a10915`）。
3. **adid 不需要重新生成**：它是 uni-ad 应用ID（旧包 `plus.adid = 125339040306`），
   打包时由 HBuilderX 写入；保持 `125339040306`，不要在后台新建应用。
   adpid 仍是 `1948867796`（已审核通过）。

**已加的诊断能力**（`b6628be0`）：`net/ads.ts` 捕获 `onError` 的 `errCode/errMsg`；
`VITE_AD_DIAG=1` 构建时把详情附在失败文案后（生产构建不显示，冻结文案不变）。
诊断构建命令（在**最新 dev 检出**执行）：

```bash
VITE_AD_DIAG=1 VITE_WS_ENDPOINT=https://<DEV_HOST> VITE_API_BASE=https://<DEV_HOST>/api \
  pnpm --filter @fight-the-landlord/client build:app
```

HBuilderX 打开 `apps/client/dist/build/app` → 云打包（包名 `com.yobeeo.pokergame` 不变）。
装好后用 `13800000102 / Relief!2345` 领取，把提示括号里的错误码发回：
`-5002` = adpid/adid 归属仍不一致；`-9002` = uni-ad 业务状态；无填充码 = 等库存。

**下一步**：在最新 dev 检出重出包 → 拿错误码 → 修复 → 三态验收（见 §4）。

### 2.2-a 2026-10-18 晚实测（诊断包 · appid 修复验证）

**出包（`d:\Code\ftl-branch@533585a1`，与开发同一检出）**：

```bash
VITE_AD_DIAG=1 VITE_WS_ENDPOINT=https://<DEV_HOST> VITE_API_BASE=https://<DEV_HOST>/api \
  pnpm --filter @fight-the-landlord/client build:app
```

→ HBuilderX CLI 云打包（`--android.packagename com.yobeeo.pokergame --android.androidpacktype 3
--ad.domestic sigmob --unimpads true`）→ APK
`apps/client/dist/release/apk/__UNI__CE6765E__diag.apk`（18,091,668 B，不入库）。

包内核对：`app-service.js` 版本串 **`0.1.0-533585a1`**；`www/manifest.json` `id=__UNI__CE6765E`、
`plus.adid=125339040306`；dex 含 Sigmob；端点 `<DEV_HOST>` 命中；诊断文案在包内。

**模拟器（MuMu Android 15 x86_64，ARM 转译）实测**：

| 用例 | 账号 | 结果 |
|---|---|---|
| 完整观看 | 13800000102 | ❌ **未完成**：广告已能拉起并播放（视频创意 `duration=31386` 实播；交互创意 `duration=60996`/试玩类），但创意在**交互结束卡冻结**（倒计时静止、连续截图 md5 相同、返回键无效）⇒ 无 `onClose(isEnded=true)`；服务端无发放（`currency_accounts` 无行） |
| 中途关闭 | 13800000103 | ✅ 「跳过」→「确认关闭」→ 落地页 X ⇒ 客户端提示**「完整观看才能领取」**；服务端无发放（无行） |
| 当天重复 | 13800000101 | ✅ 直接提示**「今天已经领过了」**，未拉起广告；余额 0 |

**关键结论**：appid 切到 `__UNI__CE6765E` 后，**原「暂时没有可播放的广告」已消失，广告可填充**
（102/103 均拉起 Sigmob 创意）⇒ `-5002` 类归属问题已解决。剩余阻塞 = 模拟器无法完成交互型创意
（ARM 转译下的渲染/播放冻结），不是应用代码问题。**完整观看 → +200 需在真实 ARM 设备上验**
（或换可正常渲染的模拟器）。

**服务端独立证据**（测试服 DB）：`currency_accounts` 中 102/103 均无行；`currency_ops` 最新
`relief_grant` 仍是 2026-10-18 07:52 / 08:01 的两条（非本轮）⇒ 三态实测期间**零误发放**。

### 2.2-b 2026-10-18 晚 · 真实 ARM 真机（SP200 / Android 10）实测与修复

同一诊断包装到真机（先卸载旧签名包再装）。102 完整观看一次：广告正常播放（22.2s 视频创意）
→ 结束卡 → 关闭；客户端进入「发放可能稍有延迟」轮询终态，但 **10 分钟后仍未到账**。

**服务端证据**（关键）：
- edge 访问日志显示 uni-ad 平台**真实回调已到达**（13:19 UTC，连续 4 次重投）：
  `GET /ad/notify/uniad?adpid=1948867796&platform=android&provider=china&trans_id=498d5261-…&user_id=&extra=FBCG7UqVNv1YuCdYkJc6FQ&sign=974e8257…`
- currency-service 日志：每次均 `广告回调确定性拒绝 reason=malformed`；
- 用**库里真实密钥**在服务器侧复算 `sha256(secret:trans_id)` ⇒ **与平台 sign 逐字匹配**
  （只输出布尔 `sign_match=true`，密钥未出服务器）。
- ⇒ 根因 = **`user_id=` 空串**：验签器把它列入「五枚非空必填」，而平台未绑定用户时就是空串
  （规格 §2.4 明写 `user_id` 仅信息性、身份只来自 `extra` claim）。单测夹具一直送非空
  `user_id: user.id` ⇒ **测试全绿、真机全拒**（夹具与真实 wire 形态背离的假绿）。

**修复（`57b213b5`）**：
- `extractCallbackFields` 必填收窄为 `adpid/provider/platform/trans_id`；`user_id` 缺省/空串收 `''`；
- 单测新增「空/缺 user_id ⇒ 形状合格」正例（19 项），两处必填清单同步；
- conformance slice-18/24 夹具改 `user_id: ''`（与真机形态一致，避免再假绿）；
- 验证：currency-service **352 passed**、双配置 `tsc` 0、conformance `tsc` 0。

### 2.2-c 2026-10-18 晚 · 修复后真机复验（测试服 `dev-76c6ed5`）

部署 `dev-76c6ed5` 后，真机（SP200 / Android 10，arm64-v8a）重跑三态：

| 用例 | 账号 | 结果 |
|---|---|---|
| 完整观看 | 13800000102 | ✅ **余额 0 → 200**。uni-ad 真实回调（`trans_id=d93d0ba6-…`、`user_id=` 空、`sign=6e005ab0…`）于 13:45:07 UTC 到达；currency-service 日志 `广告回调发放 granted …`；`currency_ops` id 57；客户端大厅余额 **200**、领取按钮消失。⚠️ 「已领取救助 +200」这一句提示未捕获：该创意完成态是微信任务落地页，`跳过` 点击无效，最终以 force-stop 收尾（发放本身已由服务端与客户端余额双重证明）。 |
| 中途关闭 | 13800000103 | ✅ 多次「跳过/放弃」后客户端提示「完整观看才能领取」；服务端无发放（`currency_accounts` 无行）。 |
| 当天重复 | 13800000101 | ✅ 真机直接提示「今天已经领过了」，未拉起广告；余额 0。 |

**结论**：广告救助完整链路（App → uni-ad 平台 → 服务端回调 → 发放 → 客户端余额）在**真实设备**上闭环通过；
`user_id` 兼容修复被**真实平台回调**验证（修复前同一形态被判 malformed、零发放）。

## 3. 当前环境实测（dev）

- `get /api/config`（经真栈）：客户端 **18 键**；管理面 **50 键**。
- `ad.reliefAdpid` = **空串**（入口不渲染）
- `currency.reliefEnabled` = **false**（暗上线）
- `currency.reliefAmount` = **200**
- `ad_channel_config` 有 1 行；指纹 `e9ebfd1a3ce5` 与
  `tools/conformance/fixtures/ad-callback/callback-secret.txt` **逐字一致**
- config-service 已按当前源码重建；迁移 45→50 键执行成功。

### 3.1 dev 库迁移历史修复（环境侧，非代码）

dev 库的 `migrations_config` 原先记的是旧类名 `RiskDeviceBindingSeed1795300000000`，
而 `platform_config` 已有 `risk.deviceBindingEnabled`。修复方式：

```sql
UPDATE migrations_config
SET timestamp = 1795600000000, name = 'RiskDeviceBindingSeed1795600000000'
WHERE id = 16 AND name = 'RiskDeviceBindingSeed1795300000000';
```

随后 config-service 正常执行 `179540 / 179550 / 179570` 三条迁移，键数 45→50。
`INSERT IGNORE` 修复后，未来跑过旧类名的库无需手工改历史即可安全升级。

## 4. 仍未完成（按顺序）

- [x] **uni-ad 平台侧开通 / 广告位**（用户 2026-10-18 确认）：激励视频 + 服务器回调 +
  业务在传统服务器 + 回调 URL `https://<域名>/ad/notify/uniad`；已拿到 adpid 与 Secret。
- [x] **测试服部署**（2026-10-18）：`dev-a9800e3` 已部署（19 容器健康、platform_config 50 键、
  含 edge 重建）。APK `/download/优比棋牌.apk`（`0.1.0-2eed0fd`，sha256 `477ac33e…`）。
  ⚠️ **构建机必须先把 APK 放进 `deploy/download/` 再构建 edge**（不入库；2026-10-18 已遇 404 一次）。
- [ ] **生产/其他环境部署（如有）**：`v1.13.4` 仍是旧回调契约（POST-only + 验签占位），
  真实 uni-ad 的 GET/sha256 回调会被 405/5xx 拒。其他环境部署必须含 **edge 重建**，
  并补 `.env` 的 **`AD_CHANNEL_PULL_TOKEN`**（两端同值；见 §2.1-a）。
- [x] **管理页核对/填写**（2026-10-18）：`ad.reliefAdpid = "1948867796"`、广告回调 Secret
  已配置（指纹 `ef1c4a33ed19`）、`currency.reliefEnabled = true`。位置见 §5 与
  `docs/ops/first-deploy.md`「广告怎么开通」。
- [x] **App 真机验收**（2026-10-18 晚完成于真机 SP200 / Android 10，测试服 `dev-76c6ed5`）：
  完整观看 → 余额 0→200（服务端 `relief_grant` + 真实平台回调）；中途关闭 → 「完整观看才能领取」、
  无发放；当天重复 → 「今天已经领过了」。详见 §2.2-c（「+200」提示句未捕获，发放已双重证明）。
- [ ] **旧版 App 与硬停**：开启前确保 App 已更新到带广告入口版本；硬停用
  `reliefEnabled=false`（`adpid` 置空对已在大厅持旧配置的客户端非即时）。
- [ ] **T0-5 实配验证**：`extra` 中 22 字符 claim 的长度/字符集（平台文档未载上限）——
  服务端侧已收 22 字符 claim（§2.1）；**uni-ad 透传**仍需真机看一次回调。
- [ ] **baselines 注记**：`tools/conformance/baselines.json` 的 slice-18/24 读数仍为
  150/224（本次两跑未改读数），但 `_backfill` 里「T0-2 相位红」是历史注记；
  本次实跑已绿，后续回填时可按本文件更新注记。

## 5. 上线顺序（推荐）

1. [x] 测试服已发布/部署（`dev-a9800e3`；**含 edge 重建**）。其他环境按需重复此步。
2. [x] conformance `slice-24` + `slice-18` 两跑（2026-10-17 dev 栈通过）。
3. [x] 管理页填/核对 adpid + 回调密钥（uni-ad 侧已在 2026-10-18 完成）。
4. [x] 开 `reliefEnabled`（2026-10-17 13:35 已开，值 `true`）。
5. [x] 用测试服新 APK 做真机验收（2026-10-18 晚三态通过，见 §2.2-c）；回滚 = `reliefEnabled=false`。
6. [ ] 生产/其他环境：补 `AD_CHANNEL_PULL_TOKEN` → 部署（edge 重建）→ 重复 3–5。

## 6. 边界

- H5 结构性不支持激励视频（入口隐藏）；小程序端排除。
- 发放唯一入口 = 服务端回调；客户端永不发放。
- 签名只覆盖 `(secret, trans_id)`；受益身份只来自 claim。
- 对手/其他业务的广告能力不在本片。
