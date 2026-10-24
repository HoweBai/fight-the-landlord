# 广告小片 收口交接（2026-10-11 片 · 2026-10-12 T25 收口）

> **给新会话/未来的你**：本片 = 金币场「每日救助」从占位版接上**真实激励视频广告**（uni-ad 平台）——
> 第 41 键 `ad.reliefAdpid`（客户端第 15 键裸名 `reliefAdpid`）· `GET /api/wallet/relief` 裁决+签发
> claim · 广告回调 `POST /ad/notify/uniad`（验签 → claim 解析 → **账本先行** → 落 done）· 第四键空间
> `ad-channel`（广告回调密钥，恰 1 键）· edge 路由 · 两告警 · 客户端 `net/ads.ts` + lobby 流程重写。
> **当前状态（2026-10-12）**：**T1–T25 全落**（31 笔提交 + 本收口笔）· 六阶段各段读数在场
> （stage 4 唯一红 = **外部面** asset-budget，见 §5）· 全序 29 片读数见 §2 · **处于 T0-2 相位**
> （平台签名算法/密钥形态未到货 ⇒ slice-18/24 签名依赖步**预期相位红**，见 §4.3）· **未 push、未打 tag**
> （`origin/master..master` 现读 **54**，见 §7）。
> **合入状态（2026-10-12）**：`feat/ads-relief` 已 **fast-forward 合入本地 master**（`8344dc4` = 终审验证过的同一提交；分支已删）。合入后全序/相位红分类与上同——**推送/tag 仍待用户**（打 tag 前必须先 push master）。

---

## 0. 交付了什么（一段话）

配置面：第 41 键 `ad.reliefAdpid`（string，trim 后 `''` 或 `^[0-9A-Za-z]{1,32}$`；种子 `'""'`；客户端下发**裸名**第 15 键）·
客户端 `net/ads.ts` 激励视频薄层（四分支 + 平台收口）+ lobby 救助流程重写（点击预检 GET → confirm 续窗 → 广告观看 →
携 claim 轮询终态三出口；本地文案五条逐字）+ 源码闸（`claimRelief`/旧 `POST /api/wallet/relief` 零复现）·
服务端 `GET /api/wallet/relief[?claim=]`（五步次序：快照 503/10007 → 开关 → 账本今日 → 余额 → 签发/复用 claim；
携 claim 五态只读）· 回调端点 `POST /ad/notify/uniad`（防护链 405→415→413→429→验签；16KB `rawBody` 闸；限流键
`ad:notify:rate` 60s/>600 拒/fail-open+WARN；链序不可放宽五条；计数六路径；claim 双键 nonce 22 字符 base64url /
issued TTL 900s 续期 / done TTL 172800s / NX+条件删/悬垂恢复）· 第四键空间 `ad-channel`（表 `ad_channel_config` ·
迁移 `1795000000000` 表 + `1795100000000` 键种子 · RPC `config.adChannel.get` · env `AD_CHANNEL_PULL_TOKEN`
**两持有**（config-service + currency-service）· 网关 P-a1/P-a2（仅 super_admin）· 管理页第 12 视图「广告回调」·
审计两列两形态（首写/清空，照 pay/notify 先例）· 主钥复用 `PAY_CONFIG_ENC_KEY` · 消费侧现拉 + lastGood，无 lastGood ⇒ 回调 5xx）·
edge `handle /ad/notify/*` → currency-service:3004 · 告警 25→27（`ReliefCallbackBroken`/`ReliefGrantZero`）·
conformance 新片 slice-24（十二组）+ slice-18 G 组新链改写 · 文档（design 41 键 / client-protocol 15 键 /
first-deploy「广告怎么开通」节 / 台账 N122–N131）。**T0-2 相位**：验签器与签名 helper 的**算法点**缺省 = 响亮抛
（`VerifierNotConfiguredError` / `AdCallbackSigningNotConfiguredError`），到货后按 §4.1 单点回填。

## 1. 三件套与评审链（唯一上游）

- 设计 **v1.4 冻结**：`docs/superpowers/specs/2026-10-11-ads-relief-design.md`（`7af1642` 冻结登记 @ `2637e18`；r5 放行 0🔴/0🟠/0🟡）。
- 规格 **v1.3 冻结**：`docs/superpowers/specs/2026-10-11-ads-relief-spec.md`（`ae4aa9d`）+ 实施期勘误①（`c6f9bb5`，exclude 参数化形态）——**契约以该文本为准**。
- 计划 **v1.3 冻结**：`docs/superpowers/plans/2026-10-11-ads-relief.md`（`08fd329`；冻结登记 `2904875`，T1–T25 八波）。
- 执行账本与全部任务报告（gitignore）：`.superpowers/sdd/2026-10-11-ads/`（`progress.md` + `task-1..25-report.md` +
  设计/规格/计划评审报告 r1–r5 + T21/T22 预跑日志 + 本收口日志 `t25-*.log`）。
- 台账：`docs/superpowers/plans/deviation-ledger.md` **N122–N131**。

## 2. 关键数字（T25 实跑，2026-10-12）

**六阶段**（`bash scripts/ci.sh`，日志 `.superpowers/sdd/2026-10-11-ads/t25-ci.log`）：
- 1/6 install 1s ✓ · 2/6 lint 22s ✓（18 tasks）· 3/6 build 30s ✓（15 tasks）·
- 4/6 test：29 tasks 中 **28 successful / 1 failed**——唯一红 = `client` 包 **asset-budget「av/ ≤ 100 KiB」**
  （`av/ 实测 136 KiB > 100`）＝ **外部面**（工作树 3 个未提交 PNG，另一条美术线；本片零涉，见 §5）。其余 13 包全绿：
  test-utils 7 · protocol 185 · mock-server 10 · alert-relay 124 · shared 276 · game-service 130 · api-gateway 425 ·
  payment-service 418 · robot-service 118 · user-service 264 · room-service 599 · currency-service 328 ·
  config-service 418 · client 804 passed + 2 skipped（唯一 1 failed = asset-budget）。**合计 4106 passed + 2 skipped**。
  ⇒ `ci.sh` 在 stage 4 按设计**中止**（exit 1）；**stage 5/6 以同一命令口径单跑补读**（日志 `t25-ci-stages56.log`）：
- 5/6 coverage ✓（shared All files 行 **98.27%** ≥ 80%，exit 0）· 6/6 eslint-forbidden ✓（六闸 26+12+5+6+3+21 passed）。
- 编排自检 `docker compose config -q` ✓；**gitleaks 全仓**（v8.30.1，`.gitleaks.toml`）✓ `1452 commits scanned, no leaks found`
  （日志 `t25-gitleaks.log`）。

**全序 29 片**（`node tools/conformance/dist/run.js`，逐片串行、顺序取自 `--list`；`--fresh`（C11）先过；
日志 `t25-full-conformance.log`；对账 `check-baselines.mjs full` 输出在同日志）：

| 切片 | 读数 | 下限 | 分类 | 切片 | 读数 | 下限 | 分类 |
|---|---|---|---|---|---|---|---|
| slice-05 | 29 | 29 | 绿 | slice-07.5-backup | 184（+14 skip） | 196 | 绿·本机跳过形态（见下） |
| slice-06 | 56 | 44 | 绿 | slice-13-ai-rollout | 35 | 35 | 绿 |
| slice-07 | 39 | 39 | 绿 | slice-14-config-center | 75 | 75 | 绿 |
| slice-07.1 | 28 | 28 | 绿 | slice-15-records | 211 | 211 | 绿 |
| slice-08 | 117 | 55 | 绿 | slice-16-monitoring | 90 | 86 | 绿 |
| slice-09 | 163 | 160 | 绿 | slice-17-currency | 172 | 172 | 绿 |
| slice-10 | 186 | 185 | 绿 | **slice-18-gold-room** | **93（红点=G）** | 149 | **相位红（预期；逐字同 T22 预跑）** |
| slice-11 | 64 | 50 | 绿 | **slice-19-admin-rbac-audit** | **G5 P7 409（红点）** | 458 | **本机栈态红（见下；非本片回归）** |
| slice-07.2-security | 43 | 43 | 绿 | slice-20-risk-control | 181 | 181 | 绿 |
| slice-07.2-boundary | 82 | 82 | 绿 | slice-21-payment | 328 | 328 | 绿 |
| slice-07.2-hardening | 103 | 103 | 绿 | slice-22-pay-channel | 243 | 243 | 绿 |
| slice-07.2-deploy | 154 | 140 | 绿 | slice-23-notify-channel | 380 | 380 | 绿 |
| slice-07.2-rpc | 69 | 65 | 绿 | **slice-24-ads-relief** | **112（红点=④）** | 224 | **相位红（预期；逐字同 T21 预跑）** |
| slice-07.3-edge | 41 | 34 | 绿 | slice-12 | 88 | 77 | 绿 |
| slice-07.4-pipeline | 75 | 75 | 绿 | | | | |

**读数小结 = 26 绿（读数全部 ≥ 下限，除 slice-07.5 本机跳过形态）+ 2 相位红（逐字核对预跑红点）+ 1 本机栈态红（slice-19，见下）**。
`check-baselines` 四条违规行全分类：slice-18/24「缺席」= 相位红（预期）· slice-19「缺席」= 栈态红 · **slice-07.5 = 184 < 196 属本机跳过形态**
（宿主缺 `flock`/`script(1)` ⇒ 14 条**跳过**不计；baselines 原文自注「不得用本机读数回填」——**不下调**；CI 上这 14 条真跑）。

**slice-19 栈态红（两条独立根因，均已确证）**：
- ① **红点**：`G5 P7 超管（放行 ⇒ 真跑一轮 200） ⇒ HTTP 200：期望 200，实际 409`。该路由唯一 409 源 = 对账 `inFlight` 互斥
  （`admin-finance.controller.ts:486-499`）。全序上下文中，slice-18 的 `finally` **无条件** `--force-recreate currency-service`
  （`slice-18-gold-room.ts` finally 兜底），新容器「first run in **10000ms**」首轮自对账（货币日志实证 09:01:08.634→.859，窗口 ≈225ms）
  与 P7 时刻同窗（时序吻合、机制最可能）。**单跑复证：未复现**（`t25-slice19-rerun.log` 的 G5 P7 双 200 全过）——如实记「瞬态、未复现」。
- ② **二次红点（复跑暴露·确定性）**：`G6 互降前提：活跃超管恰两名 —— 实际 ["admin"]`。根因 = `admin_accounts` 行数 **232 > 200 防御上限**
  （`admin-accounts.service.ts:42`：`ORDER BY id ASC LIMIT 201`，⚙️10「超出照出前 200 并日志」）⇒ 新账号（id 248–269）**落在列表窗口外**：
  G1 自愈扫（「停用 s19 前缀残留 active 超管」）与 G6 前提读双双**盲区**（本机 DB 实况：active super=3（admin + 2 个 s19s 残留），列表只见 admin）。
  **非本片回归**（本片零触碰账号面；纯测试账号**只停用不删**经月累积越限）· **CI 权威轮新卷不受影响**（count 从头起）·
  处置建议（留控制者/终审）：dev 栈清旧账号至 ≤200 或切片侧适配——已在 §7 登记。

**baselines 终值核**（`tools/conformance/baselines.json`，JSON 可解析）：`slice-18-gold-room = 149`（T22 静态回填）·
`slice-24-ads-relief = 224`（T21 静态回填）——两条 `_backfill` 注记均在文（「T0-2 到货后按实跑两跑校正；**不得因相位红下调**」）；
其余 27 片零调整。**本收口未改动 baselines**（无偏差需处置；相位红不构成下调理由）。

## 3. 静态终扫（T25 四项 + 顺手）

1. **两口径 grep**（`四十键|40 键` / `十四键|14 键`，排除序号句与 C14 案例号）：live 面（packages/apps/tools/admin/scripts/.github/compose/docs 顶层+ops）
   残余**恰为** T24 收口后的分类集——①「第 40 键/第 35–40 键」序号句（9 处，标签恒正确）· `admin/app.js:147,:302` 与
   `user config.client.ts:15` 的**历史递进句**（每段计数在其时段为真）；②「第 14 键」序号句 + 「支付片 T14 扩到 14 键」历史递进
   （`stores/game.ts:51/:439` + 4 个客户端测试注释）· C14 案例号（`slice-17:1275`「C14 键集」）· mock-server 3 注释（规格 §1.3 有意排除）。
   **零陈旧计数句**。案卷面（`docs/superpowers/**`）不追溯改（既定纪律）。
2. **`claimRelief` 零残余**：live **代码面零**（`lobby-ux.test.ts` 源码闸逐字盯着：src/** 剥注释后零命中，含判别力自证）；
   残余 = `rest.ts:356` 退役注记注释 + 闸自身正则 + conformance 注释 + 案卷。
3. **旧 `POST /api/wallet/relief` 零残余**：**路由零注册**（网关仅 `@Get`、currency 控制器仅 GET；真 app 用例钉 POST ⇒ 404/10001）；
   残余 = 负例测试（期望 404）与退役注记注释 + 案卷。
4. **落点清单**：`AD_CHANNEL_PULL_TOKEN`——compose base `:281/:330` + override `:113/:127` · `design.md:201` §2.3 ·
   `conformance-stack.sh:73` 与 `run.ts:159`（两处同源逐字 `dev-ad-channel-pull-token-change-in-production`）· 接收侧
   `config.rpc.controller.ts:200/:226` · 消费侧 `ad-channel.config.service.ts:91` · redact 段界规则兜底 + 测试面。
   `ad.callbackSecret`（工作名，T0-2 可改名）——protocol `ad-channel.ts` 常量 · config-service 四件套+校验+RPC 专用通道 ·
   `1795100000000` 键种子（值 `'""'`）· 网关 policy/三转发 · 管理页第 12 视图 · redact 枚举（`:109-110`）· conformance
   `slice-24:141` + `lib/http.ts` · `conformance-stack.sh:283` 种子（**占位值 `conformance-ad-callback-secret`，T0-2 换真形态**）· 测试族。
5. **顺手（T24 审查 M2 指派）**：`packages/protocol/src/robot-availability-wiring.gate.test.ts`——J21① 标题「十七键」→
   **「十八键：… + 广告片 configAdChannelGet」**（实际 `RPC_PATTERNS` 18 键，实文核）+ J21② 门槛 `17→18` 与「12+6 键」注释同步
   （照 notify 先例 `ff48a3d`/`79fcfdb` 两半同形）。复证：该文件 8/8 绿 + protocol 全包 **185/185** 绿。

## 4. T0 相位与到货后回填清单（**聚合四源，逐项 file 面 + 步骤**）

### 4.1 T0-2（签名算法/密钥形态）到货后回填 —— 唯一算法点两处 + 连带

| # | file 面 | 届时动作 |
|---|---|---|
| 1 | `packages/currency-service/src/ads/ads-verifier.ts` · `verifySignedFields` **函数体**（唯一算法点，签名保持稳定） | 落算法 + canonical + 密钥字段取用 + 时间窗；缺 sign/验签败/超期 ⇒ `{ok:false, reason:'bad_sign'}`（T13 §5.2#1） |
| 2 | `tools/conformance/src/lib/ad-callback.ts` · `signAdCallbackSource` 函数体（唯一算法点） | 落平台签名算法；canonical 若与真形态相抵 ⇒ 同笔改 `canonicalAdCallbackSource`（T20 §5.3#2） |
| 3 | `tools/conformance/fixtures/ad-callback/` 两 PEM | `node generate-fixtures.mjs --regenerate` 按真密钥形态重生成（**必须显式 `--regenerate`**——默认幂等 skip；两文件一起去删防半替）（T20 §5.3#1/#5） |
| 4 | `scripts/deploy/conformance-stack.sh:283` 种子 | 占位 `conformance-ad-callback-secret` 换**与 fixture 同源的真形态**（T10/T22 §6①） |
| 5 | `packages/currency-service/src/ads/ads-verifier.ts` 密钥来源接线 | 按 T0-2「密钥形态」结论：经 T14 `AdChannelConfigService` 注入本类（ctor 扩展——**值导入**纪律）或由 T14 传参（T13 §5.2#3） |
| 6 | `packages/currency-service/test/ads-verifier.test.ts` | 「好形状样本」换真签样本直喂 + 补钉 `resolveClaim('')` 一支（其余分类面用例不漂移）（T13 §5.2#4 / §6.3） |
| 7 | 键名复核 | `ad.callbackSecret` 为**工作名**——若 T0-2 改名 ⇒ 同一笔：`protocol/ad-channel.ts` 常量 + redact 枚举名 + 测试族 + stack 种子（T10/T13 登记） |
| 8 | 回填批附带 | slice-18 ⓪ 健康名单 +`ftl-edge`（一行 + 计数同步；M1 裁定「留 T0-2 回填批」）· 回填**单独一笔**提交（T13 §5.2#6） |

### 4.2 T0-3 / T0-4 / T0-5 复核点（到货后按实文核，单点集中）

- **T0-3**：内容类型闸（缺省 form-urlencoded）· 响应码与应答词面（T14 实取值 4xx=400 / 5xx=503 / `success`/`failure`）·
  载荷字段（`extra/transId/ts`——T13 `extractCallbackFields` 与 T20 `AD_CALLBACK_SIGNED_FIELD_NAMES` 两文件同形，改名同笔）· 重试窗长。
  切片侧复核点 = slice-24 ④⑤⑩ 的码/词断言（各一处常量面集中）。
- **T0-4**：`apps/client/src/manifest.json` 的 app-plus 广告配置形态 + 真机联调方式（T19 标注【T0-4 到货后定形态】）。
- **T0-5**：`extra` 长度/字符集 ⇒ nonce 编码（缺省已在用 `randomBytes(16).toString('base64url')` 22 字符；若平台不同 ⇒ `claim.service.ts` 一处生成函数）。

### 4.3 相位红清单（**预期，非缺陷**；全序红点须与下列逐字同型）

- **slice-24**（红点 = ④ 首个签名依赖步，坏签名样本）：两跑**前 112 断言全过**（⓪15+①40+②15+③32+④免签名 10），逐字：
  `❌ slice-24-ads-relief 失败：【T0-2 到货后真绿】④ 首个签名依赖步（坏签名样本）：签名样本构造不可用 —— 广告回调签名未配置（T0-2 算法/密钥形态未定稿）——helper 不发明平台签名算法；到货后按单点回填（T20 helper 现抛 AdCallbackSigningNotConfiguredError；到货后按单点回填 helper 即续跑）`
  证据：`.superpowers/sdd/2026-10-11-ads/t21-slice24-prerun-run1.log` / `…run2.log`（两跑一致；`finally` 复原实证在日志末两行）。
- **slice-18**（红点 = G 首个签名依赖步，granted 正路样本）：前 **93 断言全过**（⓪7+A12+B9+C6+D16+E24+F14+G 免签名前缀 5），逐字：
  `❌ slice-18-gold-room 失败：【T0-2 到货后真绿】G granted 正路样本：签名样本构造不可用 —— 广告回调签名未配置（T0-2 算法/密钥形态未定稿）——helper 不发明平台签名算法；到货后按单点回填（T20 helper 现抛 AdCallbackSigningNotConfiguredError；到货后按单点回填 helper 即续跑）`
  证据：`.superpowers/sdd/2026-10-11-ads/t22-slice18-prerun.log`（G 免签名前缀实测：off-face GET reason「救助暂未开放」/ eligible GET 签发 22 位 claim）。
- **到货后转绿路径**：按 §4.1 单点回填 helper + fixtures + 种子 ⇒ **切片断言零改动**即转全绿；随后**两跑校正**
  （预期 slice-18 = 149 / slice-24 = 224；含时序的个别边界按实况记，**只升不降**）+ CI 权威轮复核。待真绿清单
  （T21 §5.2 / T22 §6）：slice-24 ④–⑫ 全量 + 224 两跑 · slice-18 G 四态 + H 承接 · 相位期**⑪⑫ 等免签名断言从未执行过**
  （在红点之后），首跑即覆盖。

### 4.4 T0 文档预答（2026-10-12 抓官方文档实文 —— **回填批的重要输入**）

> 来源（本机直连抓取，存档 `.superpowers/sdd/2026-10-11-ads/docs-fetch/`）：开通指南 `uni-ad/ad-open.html` · 激励视频（含服务器回调全文）`uni-ad/ad-rewarded-video.html`（页面「上次更新 2026/10/10」）。

- **T0-1 ✅ 文档层成立**：快捷广告 / Sigmob 均在支持渠道内；服务器回调是 uniCloud 层统一能力（「各家广告厂商的服务器回调被统一集中在 uniCloud 中」）⇒ 方案 A 前提满足（实配以广告位可选「服务器回调」开关为准）。
- **T0-2 ✅ 文档已答（无需等客服）**：**算法 = `sign = sha256(secret:trans_id)`**（冒号拼接，逐字）；`secret` = **该广告位**的 secret（后台开启回调后、广告位左侧下拉可见；一广告位一枚）——与第四键空间 1 键（`ad.callbackSecret`）命名对位。回填 `verifySignedFields` = `timingSafeEqual(sha256(secret:trans_id), sign)`，secret 走现有拉取通道（现拉+lastGood）。
  ⚠️ **sign 只覆盖 (secret, trans_id)**、不覆盖 user_id/extra ⇒ 与设计 §4.2「平台签名只证消息来自平台、受益身份在 claim 步骤」逐字一致——**claim 机制为承重墙不变**。
- **T0-3 ✅ 文档已答（**改动面比原估大，回填批须一并排期**）**：**方法 = HTTP GET（query 传参）**（文档逐字「以 HTTP(GET) 方式请求开发者配置的回调URL」）——非 POST ⇒ 骨架缺省（POST + form-urlencoded）需改：方法闸改 GET（其余 405）· 内容类型闸删或改「无 body 期望」· 16KB 闸成永真（可留可删）+ 规格 §2.4 表同步勘误。**字段全集**：`adpid · provider(china/global) · platform(iOS/Android/weixin-mp) · sign · trans_id · user_id · extra · cpm?`。**响应 = JSON `{"isValid": true}` 为唯一确认信号**：未收到 ⇒ 广告商服务器重试（「看一次广告收到 2 次回调、trans_id 相同」的两大原因 = 没正确响应该 JSON / 响应过慢触发重试）⇒ 映射：**全体终态（含确定性拒绝）= 回 `{"isValid": true}`**（不触发重试）；瞬态 = 非-valid（触发重试）。`AD_NOTIFY_MAP` 接受词字面 = 该 JSON。**幂等**：`trans_id` = 完成观看的唯一交易 ID。重试退避跨度文档未载 ⇒ 保留「窗长复核」项（实配观察）。
- **T0-5 ⚠️ 部分**：文档未载 `extra` 长度/字符集上限（「如无需要则为空」——空 extra 属常态，T13 修复方向印证）；实配时验证 22 字符 claim。
- **T0-4 ✅ 部分**：渠道 SDK 真机不生效、**打包后生效**；服务器回调需 **App 平台 3.1.15+**（HBuilderX 5.26 满足）。
- **运营注意（开通时）**：开启回调选【业务在传统服务器】+ 配置回调 url = `https://<DEV_HOST>/ad/notify/uniad`（**须先部署**——本片 push+tag 之后）；**服务空间选择后不可变更**（更新需重建广告位）。

## 5. 外部面（**T25 前未处置，记录在案**）

- **3 个未提交 PNG**（`apps/client/src/static/av/Farmer.png` / `av/Landlord.png` / `ui/count-tile.png`，另一条美术线）把
  `apps/client/test/asset-budget.test.ts` 顶红（`av/` 实测 **136 KiB** > 预算 100 KiB）。本片**零涉**、所有提交只 add 显式路径、
  PNG 未 touch/未 stage。**后果**：全序外的 `client` 包测试与 ci.sh stage 4 会红（本收口按「外部红」分类，**不修改**）。
  处置选项（用户裁决）：美术线交付/回退 PNG，或按预算收编（transcode/压缩），或调整预算（须显式理由）。

## 6. 上线脉络（**用户侧动作**；设计 §8 + 规格 §7 的手顺引用）

1. **push master → 打 tag `v*` → `deploy.sh <tag>`**（照既有流程；⚠️ **打 tag 前必须先 push master**——片③-B `v1.1.1` 被拒教训）。
   上线形态 = **暗**：`ad.reliefAdpid` 空 + `reliefEnabled=false` ⇒ 入口不渲染、零行为变化。
2. **操作前快照**：管理面确读 `reliefEnabled=false`（「从未开启」的当场证据）。
3. **uni-ad 后台**（用户侧）：实名/财务审核 → 绑定应用 → 开通快捷广告 + Sigmob → 申请**激励视频广告位**（开启服务器回调）
   → 得 adpid + 回调密钥 → 后台配回调 URL **`https://<域名>/ad/notify/uniad`**（生产只发 80/443，经 edge；见
   `first-deploy.md`「广告怎么开通」节，含换广告位手顺/密钥轮换/回滚/edge 重建提醒）。
4. **配置**：管理页填 `ad.reliefAdpid`（**带引号字符串**）· 回调密钥入「广告回调」视图（掩码写、加密落库、审计脱敏）。
5. **开 `reliefEnabled` → 真机验收**（判据面见下）· 回滚 = `ad.reliefAdpid` 置空（秒级入口即暗）或 `reliefEnabled=false`；
   代码面回滚 = 镜像 tag 回退（表留库无害）；edge 回滚含 `build edge` 重建（手顺在 first-deploy 广告节）。

**真机验收清单**（设计 §7 判据面，用户在场）：① 测试广告位**完整观看 → 到账**（余额 +N 与 toast 文案）；② **中途关闭 →
不到账** + 专用文案「完整观看才能领取」；③ 文案分支（「暂时没有可播放的广告，稍后再试」/「发放可能稍有延迟，稍后回到本页查看」/
「领取凭证已失效，请重试」/「今天已经领过了」等五条本地+服务端逐字文案）。前置：T0-4 manifest 形态 + 本片代码上线。

## 7. 残余 / 未闭项

**Minor 池汇总**（progress.md 全量；供最终全支审查分诊；【已收】= 已被后续任务顺手闭环）：

- [T1] `config.test.ts:88-94` 非法用例判别面偏窄（33 位/`a_b`/`中`/`a b` 只断言类型未钉文案；全空白 `'   '` 无独立用例）· [T1] 跨文件「40 键面」过期枚举两处——**【已收（T24）】**
- [T2] `1795100000000-AdReliefAdpidSeed.ts:1` 值导入 vs 先例 `import type`（judged brief-mandated，不要求修）· [T2] 全包回归只捕 tail 12 行 ⇒ ⑤ 族假红与真红无法区分（下次留全量）
- [T3] 报告行号 nit（`:545`→`:548`，报告面）· [T3] 残留枚举两处——**【已收（T24）】**
- [T4] `ad-channel.test.ts` 缺「与 `CONFIG_KEYS` 交集为空」守卫（两姊妹先例均有——**T25 实文核：仍未加**，开放项）· [T4] 头注「规格 §2.3 逐字」措辞（规格自注「克隆先例」）
- [T6] `ad-channel.controller.test.ts` 组 5 缺「缺 actor + 主钥缺 ⇒ 401（非 503）」成对项（nit）· [T6] service 测试用例名「解密失败」语义（T7 并轨重写后现名内含「不触发解密」自澄清——弱）
- [T7] **J21 闸标题「十七键」陈旧——【已收（T25 本笔）】**
- [T8] 两处测试标题「近邻（规格 §2.3）」出处不精确（`gateway.controller.test.ts:556`、`admin-policy.test.ts:764`；纯标题文案）
- [T12] catch 不 `unwatch`（fail-safe 方向）· `read` 裸 catch 分类偏宽 · FakeRedis 保真小账三则 · 首签用例真实时钟午夜闪红理论面 · 报告组③计数笔误 · **单连接 WATCH 交错退化（已裁「接纳+注册」；slice-24 ⑨ 已设并发判定项；后续换 Lua 改动点集中 `conditionalDelIdx`/`markDone`）**
- [T13] 报告 §5.2#4 一处过时（空串 extra 钉随 T0-2 换真签样本——回填者按 §6.3 执行）
- [T14] **订正①/②已入台账 N127/N128**；helpers 取舍（YAGNI，审查默认）· 注释陈旧三处——**【已收（T24）】** · 「六路径计数单 `it` 后续可拆六例」· 400/503 码 = T0-3 复核点（见 §4.2）
- [T16] `Dockerfile.prometheus` 25→27——**【已收（T22 `eb0bace`）】** · `slice-18:22/:1261`「23 条」——**【已收（T22）】** · 旧 ruleset 运行容器——**【已收（T21 整栈重建后 27 条实证）】**
- [T18] ① asset-budget 外部红（**开放，见 §5**）· ② vue-tsc 15 个 `reliefAdpid` 过渡态——**【已消（T19 归一后）】**
- [T19] M1 `openRelief` busy 守卫不覆盖预检在途窗（双击两发只读 GET，无害）· **M2 `closeRelief` 不复位 `reliefPollInFlight`**（轮询环唯一不自愈状态；一行加固——留终审分诊）· M3 登记性（关层残余提示/在途成功落定，有意口径）
- [T21] M1 ④–⑫ 全量终态断言待 T0-2 后首跑覆盖 · M2 ③ 并发首条消息略弱 · M3 finally 账号停用循环单 try · M4 ⓪ rules=27 硬编码
- [T22] **M1 ⓪ 健康名单未含 `ftl-edge`——裁「留 T0-2 回填批顺带」** · M2 `getRelief` claim? 死参数 · M3 跨零点窄窗同族取舍 · M4 报告 evidence 缺口一处（finally 在场）
- [T20] §5.1 邻接扩面（gitleaks #7 `(pay|ad)-channel`）已入 commit 与 M0.1 规格 v3.6；台账登记建议（T24 已覆盖 N122–N131 面）
- [T24] 报告 §5：A.4「三个」裁定与机械面一致（已闭合）· design.md `:1141/:1185` 两处增补超 §5.3 字面清单（**有意**，理由在 T24 报告；终审可复核）· §7.5/§4.2/§4.3/§10.3「notify 全镜像」子节**刻意不做**（台账 N123 承载——终审若期望属一次性可加项）· mock-server 3 注释留 14（规格 §1.3 有意排除）· `docker-compose.yml:169` 核真未动 · N131 范围判定
- 报告/文档面小账：`conformance-stack.sh:93` 与 `conformance.yml:32`「26→29 切片」——**【已收（T24）】**
- 构建产物面：`.turbo`/`dist` 陈旧类（T3 环境事实：改 protocol 先 build 再跑下游——已全场遵守）
- **本机栈态/环境类（T25 全序读数分类项，非本片回归）**：
  - **slice-19 栈态红**（详见 §2）：① P7 409 瞬态（`slice-18` finally 无条件重建 currency-service ⇒ +10s 首轮自对账窗口同窗；
    单跑 P7 复绿未复现）② G6 前提红（`admin_accounts` 232 行 > 接口 200 防御上限 ⇒ G1 自愈/G6 读双双盲区——**确定性**）。
    处置候选（终审分诊）：dev 栈清旧测试账号至 ≤200，或切片侧改分页/自愈半径。**确证命令**：
    `node tools/conformance/dist/run.js slice-19-admin-rbac-audit`（复现 G6）·
    `docker exec ftl-mysql mysql -uroot -proot fight_the_landlord -e "SELECT COUNT(*) FROM admin_accounts;"`（>200 即命中）。
  - slice-07.5 本机 184 < 196 = 既有跳过形态（14 条 skip，宿主缺 flock/script(1)），**不下调**（baselines 自注）。
  - 交接增补（供下片顺手）：`slice-18-gold-room.ts` finally 的 `--force-recreate currency-service` 在相位红路径也会执行——
    它是本片全序里 currency 重建的最后一跳；后续切片若对「重建后 +10s 自对账」敏感，注意该窗口。

**未推提交数与推送注意**：`git rev-list --count origin/master..master` = **19**（现读；= 设计/规格/计划三件套评审轮等准备期提交）
· 本分支 `feat/ads-relief`：`git rev-list --count 2904875..HEAD` = **34**（自计划冻结 `2904875` 起 = T1–T24 + T25 收口 + 终审补丁）· `git rev-list --count origin/master..HEAD` = **53**（= 19 + 34）。
**计数口径**：两数均 **2026-10-12 当日现读**，随文档笔数自增——复读时以现跑 `git rev-list --count` 为准。
**推送注意**：① 打 tag 前必须**先 push master**（片③-B 教训）；② 合入顺序 = `feat/ads-relief` → master → push → tag；
③ 上线后按 §6 走用户侧五步；④ 首次开启前先读 `first-deploy.md`「广告怎么开通」节。

## 8. 各任务提交区间表（T1–T25，均在 2026-10-12）

| 任务 | 提交 | 任务 | 提交 |
|---|---|---|---|
| T1 protocol 第 41 键 | `8003d88` | T14 回调业务链 | `b7b9c72` |
| T2 种子迁移 | `587efb1` | T15 GET 端点两侧 | `bfd7ffe` |
| T3 config-service 同步面 | `8f94641` | T16 观测（告警 25→27） | `d36de7b` |
| T4 protocol ad-channel 常量 | `ee7f35c` | T17 edge 路由 | `f6a32e4` |
| T5 表迁移 | `4e46b79` | T18 `net/ads.ts` | `cfe8e2c` |
| T6 四件套 | `430e0db` | T19 lobby 流程 | `597d585` |
| T7 RPC 接收侧 | `bf664fa` | T20 夹具 + gitleaks 连带 | `76e700d`+`e3a4089` |
| T8 网关 policy + 转发 | `a73d586` | T21 slice-24 | `c047d70` |
| T9 管理页第 12 视图 | `6d56ee0` | T22 slice-18 G 改写 | `95154cd`+`eb0bace` |
| T10 shared/编排/栈 | `72b4a53`+`2db01b5` | T23 计数面迁移（七片） | `6922a3a` |
| T11 回调挂载 + 限流 | `8efc3f8`（+勘误 `c6f9bb5`） | T24 文档面 + 注释扫 | `49f6326`+`0bf63de`+`3d51e1d` |
| T12 claim 服务 | `29fd97a` | T25 收口（本笔） | 收口提交（含 J21 订正 + 本文档） |
| T13 验签器（T0-2 边界） | `0fdeafe`+`51a1035` | | |

准备期（master 上 19 笔未推内）：设计冻结 `7af1642` · 规格冻结 `ae4aa9d` · 计划冻结 `2904875`（`08fd329` 为冻结本）。

## 9. 新会话入口（读什么）

1. 本文件 → 2. 规格 **v1.3**（契约唯一真源）→ 3. 台账 `progress.md` + T21/T22 报告（相位红与预跑证据全档）→
4. `docs/ops/first-deploy.md`「广告怎么开通」节 + `docs/design.md` §7.5 键表（41 键）。
**恢复口令**：「继续广告片收尾：读 `docs/superpowers/plans/2026-10-11-post-ads-handoff.md`。」
