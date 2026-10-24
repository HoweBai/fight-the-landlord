# 广告小片（App 端激励视频 → 金币场「每日救助」）**规格 v1.4（T0 回填勘误）· 契约唯一真源**

> 日期：2026-10-11 · 状态：v1.0 起草 → spec-r1「有条件通过」收口（v1.1）→ spec-r2 残项收口（v1.2）→ spec-r3 残项收口（v1.3）→ **spec-r4 复核：可通过 → 已冻结**（报告 `.superpowers/sdd/2026-10-11-ads/review-spec-r4.md`；2 nano 非阻断，见修订记录冻结行）→ **v1.4 T0 回填勘误（2026-10-13）**：T0-1/2/3/4/5 的**契约面按官方文档实文落死**（抓档 `.superpowers/sdd/2026-10-11-ads/docs-fetch/`，2026-10-12 直连抓取；变更逐条见 §9 修订记录——核心 = 回调**方法 POST→GET**、响应改 **JSON `{"isValid": true}`**、字段 `transId→trans_id`、**删时间窗**、防护链删内容类型/体积两闸）
> 上游：设计 **v1.5**（2026-10-13 T0 回填勘误随批；原 v1.4 冻结本 `2637e18`；五轮评审 r1–r5——**r3–r5 报告在 `.superpowers/sdd/2026-10-11-ads/`，r1/r2 见设计文件修订记录**）——本文件是其**契约唯一真源**，实现与判据以本文件为准
> 行号一律取证于 T0 勘误时点 HEAD（本机实读；实施时复核）
> T0 五项回填面已在本版落死（§2.4/§8 原「边界清单」转为**已答 + 回填对象**两列）——边界外的一切在本规格内定死

---

## 0. 承接与订正

### 0.1 上游与版本

- 设计 v1.5（2026-10-13 T0 回填勘误；原 v1.4 冻结本 `2637e18`）：K1–K4 裁决 · claim 机制（账本先行/落序/计数规约）· 第四键空间 · §11 二十行闸族表全数承接。
- 本规格**不改任何已裁面**；对设计文的**引用面订正**（实读证据）见 §0.4。
- 用户侧并行（不在本规格的改动面）：uni-ad 后台实名/财务/广告位申请 · 安卓真机（验收前置）。
- **T0 五项（原「用户侧并行核查」）已由官方文档实文回答**（2026-10-12 抓档；本机直连抓取存档见文件头）⇒ 本 v1.4 把 T0-1/2/3/4/5 的契约面**落死**；其后只剩**实现回填**（对象见 §8 表右列）与**用户侧表单/打包**。

### 0.2 设计条款 → 本规格落点

| 设计（v1.4）                        | 本规格                                     |
| ----------------------------------- | ------------------------------------------ |
| §1 玩家可见行为                     | §2.9（客户端契约）+ §2.5（reason 文案面）  |
| §2 发奖闭环/窗口时点/硬性质         | §2.5/§2.6/§2.7（三处全量落定）             |
| §3 数据与状态（claim 记录/口径）    | §2.6（含原子算法——设计留白「规格定」处）   |
| §4.1 公开面（回调 + GET 细则）      | §2.4/§2.5                                  |
| §4.2 验签器/claim 解析              | §2.4 + §8（T0-2 已答；回填对象见 §8 右列） |
| §4.3 裁决序/落序/账本先行           | §2.7 计数表 + §2.4                         |
| §4.4 密钥与配置（41 键/第四键空间） | §2.1/§2.2/§2.3                             |
| §4.5 观测（枚举/告警）              | §2.7                                       |
| §5 客户端                           | §2.9                                       |
| §6 合规                             | 不动（引用设计）                           |
| §7 测试与判据                       | §5                                         |
| §8 上线顺序                         | §7                                         |
| §9 风险                             | 不重开；R7 瞬断口径入 §2.6                 |
| §11 闸族同步（20 行）               | §5.3 核销表逐行对位 + §6 文档面            |

### 0.3 ⚙️ 规格级裁定（起草期就地定死；来源 = 设计留白 + 起飞实读）

| #   | 裁定                                                                                                                                                                                                                                               | 依据                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A   | `ad.reliefAdpid` 校验字形：**trim 后** `''`（合法=未配置）或 `^[0-9A-Za-z]{1,32}$`（base62）；非 string 一律拒                                                                                                                                     | 设计 §4.4 给定界；严格形态照 `parseIntervalMs` 家族口径（`config.ts:213-233`）                                             |
| B   | claim nonce = **22 字符 base64url**（`crypto.randomBytes(16)`，128bit 熵）；T0-5 若限字符集 ⇒ 一处换 base62（熵 ≥131bit 仍足）                                                                                                                     | 设计 §2「~22 字符随机串」                                                                                                  |
| C   | 窗 = 常量 `RELIEF_CLAIM_TTL_SECONDS = 900`（15min，eligible GET 续期）；done 记录 TTL `RELIEF_CLAIM_DONE_TTL_SECONDS = 172800`（48h）；**不设配置键**                                                                                              | 设计 §2 窗口时点（钉死常量）                                                                                               |
| D   | claim「找到或创建」原子算法 = **NX + 补偿**（§2.6 伪代码）；索引键 `relief:claim:u:{userId}`                                                                                                                                                       | 设计 §3 双键 + 键数 O(用户数)                                                                                              |
| E   | done 落定时 **删除索引键**（无自致悬垂）；读路径容忍悬垂（索引指向不存在/非 issued ⇒ 按无凭证新签）                                                                                                                                                | 设计 §3（r3 🟡-7 收口）                                                                                                    |
| F   | 回调路径常量 `AD_NOTIFY_PATH = '/ad/notify/uniad'`（渠道段 = 首发平台 literal；中间件豁免**单常量精确对钉**照 pay 形态）——T0-2/T0-3 若改字面 ⇒ 一处常量 + 测试                                                                                     | 设计 §4.1（provider 段预留）+ 支付先例 `notify.controller.ts:39`                                                           |
| G   | 回调限流 = currency-service **进程内** `NotifyRateLimiter` 克隆（Redis 键 `ad:notify:rate`、60s、>600 拒、fail-open + 响亮 WARN）                                                                                                                  | 起飞实读：支付「边缘单桶限流」实为 service 内实现（`notify.controller.ts:92-143`），不在 Caddy                             |
| H   | 回调防护链**次序**（pay 形态的可移植子集；v1.4 T0 勘误后）：方法闸 405（**仅 GET**）→ 限流 429 → 验签/业务（应答体封闭 = JSON，见 §2.4）                                                                                                           | `notify.controller.ts:159-187` 的**子集**——原 pay 克隆的②内容类型闸/③16KB 体积闸随 GET 化**删除**（无 body 载体，见 §2.4） |
| I   | 第四键空间域命名：`ad-channel` / 表 `ad_channel_config` / 迁移 `1795000000000-AdChannelConfig.ts` / RPC `config.adChannel.get` / env **`AD_CHANNEL_PULL_TOKEN`** / 网关 P-a1/P-a2 / 视图第 12 个；键 1 枚 `ad.callbackSecret`（工作名，T0-2 回填） | 克隆清单侦察（pay/notify 差异对照）                                                                                        |
| J   | 消费侧拉取 = **现拉 + lastGood 回落**（pay 形态；回调低频，不引入轮询设施）；无 lastGood ⇒ 回调 5xx（可重投）                                                                                                                                      | 设计 §4.4「专用拉取 RPC」；`pay-channel.config.service.ts:43-54`                                                           |
| K   | 客户端归一：`reliefAdpid: raw?.reliefAdpid ?? ''`（string，缺 ⇒ 空串 ⇒ 入口不渲染）                                                                                                                                                                | 设计 §5.2 + 既有缺键纪律（`lobby.vue:99-127`）                                                                             |
| L   | 轮询 2s × 3、终态即止；确认时查询失败 toast「网络异常，请重试」                                                                                                                                                                                    | 设计 §1/§5.1                                                                                                               |
| M   | 回调应答体封闭（v1.4 T0 勘误落定字面）：**终态 = HTTP 200 + `{"isValid": true}`**（唯一确认信号 ⇒ 平台不重投；**含全体确定性拒绝**——坏签名/畸形亦然，重投不可改变结局）；**瞬态 = `{"isValid": false}`**（平台重投）。见 §2.4 响应表               | 官方实文（`docs-fetch/ad-rewarded.txt:811/860/899/922`）                                                                   |
| N   | 第 41 键种子值 = **空串**（`'""'` JSON 字面量——string 种子首例）；暗上线即「未配置」                                                                                                                                                               | 设计 §8-1                                                                                                                  |

### 0.4 起飞纠偏（对设计文引用面的订正；以实读为准）

| #   | 设计文原引                                               | 实况（HEAD `7af1642`）                                                                                                                                                                                                                                                                                        | 处置                                |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | §11 行 14：`admin/app.js:607,623` 为计数注记             | `:607` = `handleAuth` 401 分支行；`:623` = `login()` fetch 行；**计数注记实为** `:110-111` / `:124` / `:134-137` / `:290-292` / `:646` / `:662`；`CONFIG_NOTES` 定义 `:139`、末条 `:384`、收尾 `:385`                                                                                                         | 本规格 §5.3 用实测行号              |
| 2   | §11 行 4：`config-probe.ts:139-185`                      | SEED 实为 `:139`（注释）+ `:140-191`（数组）+ `:192`（收尾）                                                                                                                                                                                                                                                  | 本规格取 `:140-191`                 |
| 3   | §11 行 5：slice-18「40 键名单」落点                      | `:856-861` 是 step 文案 + 14 键断言；**四十键计数真断言在 `:892`**（`adminKeys.length, 40`）+ 文件头 `:8` 计数句                                                                                                                                                                                              | 本规格 §5.3 三处并列                |
| 4   | §7 行 7 脚注「RPC 直投不计端点指标 `slice-21:947` 先例」 | `:947` 只有 `rpcApply(…'relief_grant'…)` 代码先例；**「不计端点指标」注释不存在**（该结论为设计自述；机制上成立——端点指标只在 wallet.controller 递增）。另 slice-21 的 rpcApply **不接受自定义 actionId**（自动 `t21-<TAG>-<slug>`），构造 `relief:<userId>:<D>` 只能走 slice-18 形态（`:411`，用例 `:1006`） | 本规格 §5.2 按此措辞                |
| 5   | §11 行 18「注释散点」清单（3 处 src）                    | 实测 src 级「四十键/40 键」字面量 ≥10 处（§5.3 行 3 全列）                                                                                                                                                                                                                                                    | 本规格 §5.3 行 3 全清单（含两口径） |
| 6   | —（本规格新增的两条澄清）                                | slice-16 告警断言**恰 2 处**（无第三处）；slice-18 G/H 实际范围 `:1186-1256` / `:1258-1324`                                                                                                                                                                                                                   | §5.3 按实测                         |

---

## 1. 改动面一览

### 1.1 新增文件

| #   | 文件                                                                                                                                                                                                                                                                                                   | 作用                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | `packages/protocol/src/ad-channel.ts` + `src/ad-channel.test.ts`                                                                                                                                                                                                                                       | 第四键空间常量（1 键；HEADER 注释照 `pay-channel.ts:1-52`：不入 CONFIG_KEYS/不进广播/纯常量） |
| 2   | `packages/config-service/src/migrations/1795000000000-AdChannelConfig.ts`                                                                                                                                                                                                                              | 表 `ad_channel_config`（DDL 逐字照 `NotifyChannelConfig1793000000000:26-33`，仅表名）         |
| 3   | `packages/config-service/src/migrations/1795100000000-AdReliefAdpidSeed.ts`                                                                                                                                                                                                                            | 第 41 键种子（单 INSERT 一元组，值 `'""'`——**string JSON 字面量首例**，注释写明）             |
| 4   | `packages/config-service/src/ad-channel/` 四件：`ad-channel.controller.ts` / `ad-channel.service.ts` / `ad-channel.crypto.ts` / `ad-channel.validators.ts`                                                                                                                                             | 管理面三端点 / set-get-clear / crypto-core 薄绑定 / 形态校验（键材料规则随 T0-2）             |
| 5   | `packages/config-service/test/ad-channel.{controller,service,crypto,validators}.test.ts`                                                                                                                                                                                                               | 克隆 pay 四件套（514/130/581/247 行先例）+ 错误序 401→400→503 判别性专测                      |
| 6   | `packages/currency-service/src/ads/` 六件：`ads.controller.ts`（回调端点）/ `ads-verifier.ts`（验签器）/ `claim.service.ts`（claim 双键+NX 算法）/ `ad-callback.service.ts`（裁决链/账本先行/落序）/ `ad-rate-limiter.ts`（克隆 `NotifyRateLimiter`）/ `ad-channel.config.service.ts`（现拉+lastGood） | 回调全链（§2.4/§2.6/§2.7）                                                                    |
| 7   | `packages/currency-service/test/ads.*.test.ts` 族（verifier / claim / callback 落序与计数 / rate-limiter / config.service）                                                                                                                                                                            | §5.1                                                                                          |
| 8   | `apps/client/src/net/ads.ts` + `apps/client/test/ads.test.ts`                                                                                                                                                                                                                                          | 激励视频薄层（§2.9）                                                                          |
| 9   | `tools/conformance/fixtures/ad-callback/`（测试密钥对 + `generate-fixtures.mjs`，gitleaks 允许项登记照 `alipay-test/generate-fixtures.mjs:19-20`）                                                                                                                                                     | 本地签名夹具（**不建 stub 容器**——起飞实读结论：ads 无出站调用，stub 先例的成立原因不存在）   |
| 10  | `tools/conformance/src/slices/slice-24-ads-relief.ts`                                                                                                                                                                                                                                                  | §5.2                                                                                          |

### 1.2 修改文件（按包）

**protocol**：`config.ts`（+第 41 键 :85/:86 间、+`reliefAdpid` :103/:104 间、+`ClientConfig` 字段 :122/:123 间、+parse 分支于 :201 兜底前）· `config.test.ts`（两份名单 +1 + 新用例族）· `index.ts:21`（+`export * from './ad-channel'`）· `rpc.ts`（+`configAdChannelGet`）· `messages.test.ts:70-71`（全量 toEqual +1）

**config-service**：`config/client-config.controller.ts`（组装行 :63/:64 间 + 头注计数）· `rpc/config.rpc.controller.ts`（**第四** `@MessagePattern` + `pullTokenMatches` env 联合 :171 + 类头注计数句 **`:26` 与 `:30`** 两处同步）· `config/config.module.ts`（controllers/providers 各 +2）· `test/helpers/config-probe.ts`（SEED `:140-191` +1 键；+**第五套** Fake 库（pay=第三 `:325-437`、notify=第四 `:439-`）头注 `:46-49` 同步）· `test/platform-config.service.test.ts`（SEED `:204-256` +1；计数 `:297/:303/:304`）· `test/admin.controller.test.ts`（`:175-221` 名单）· `test/config.rpc.test.ts`（`:113-159` 名单 + 新 describe 组）· `test/client-config.test.ts`（`:26-41` 排序名单插位 `'rechargePackages'` 与 `'reliefEnabled'` 间；**`:97-108` 泄漏 deny-list 补 `'ad.'`**；`:139/:161` 兜底）· `test/migration.test.ts`（+两段 ⑭″ 式钉，先例 `:796-869`）

**api-gateway**：`gateway/gateway.controller.ts`（删 `@Post('wallet/relief')` `:317-329`；+`@Get('wallet/relief')` 携 `whitelistedQueryOf(req, RELIEF_QUERY_KEYS)`（**唯一实现**在 `:1141-1152`，**不得抄第二份**；`RELIEF_QUERY_KEYS = ['claim']` 照 `RECORDS_QUERY_KEYS:1120` 形态；`:1138`「两个调用方」注释句 2→3 同步）；`auth/admin-policy.ts`（前缀常量 + P-a1/P-a2，置于 P9 前，照 P-n1/P-n2 `:281-289`）· `test/gateway.controller.test.ts`（`:888-966,1132,1147` 改；+query 白名单判别用例（`?claim=x&smuggle=1` ⇒ 下游只见 claim）；+三转发方法用例）· `test/admin-policy.test.ts`（+新组，含钉序断言）

**currency-service**：`main.ts`（**三件套**：`:35` 加 `{ rawBody: true }`、`:40` 豁免 `[...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]`、`:42` `setGlobalPrefix('api', { exclude: [{ path: AD_NOTIFY_ROUTE, method: RequestMethod.ALL }] })`——**RouteInfo 形态**，实现期勘误①；值导入纪律）· `wallet/wallet.controller.ts`（删 `:93-155` 旧 POST；+`@Get('relief')` 新查询端点）· `app.module.ts:65-73`（注册 AdsController —— **未注册=真容器 404**，`:21-23` 注释纪律）· `metrics/currency.metrics.ts`（+`relief_callback_total` 与类型——`currency_relief_total` 本体**零改动**）· `config/` 侧新 `ad-channel.config.service.ts`（入 `:65-73` 模块面）

**client**：`net/rest.ts`（删 `claimRelief` `:327-346`；+`getRelief(claim?)` GET）· `net/ads.ts`（§2.9）· `stores/game.ts`（`ClientConfigState :50-78` +`reliefAdpid: string`、`setClientConfig :436-450` +写行、缺省 `:170` 邻位 +`reliefAdpid: ''`）· `pages/lobby/lobby.vue`（`FAILSAFE_CLIENT_CONFIG :104-119` +`reliefAdpid: ''`、`normalizeClientConfig :136-165` +归一、入口 `v-if :560-562` 复合 `isRewardedAdSupported()` ∧ `reliefAdpid`、流程 `:368-424` 全重写、旧「占位接入点」注释块 `:386-392` 删除替换）· `manifest.json`（`app-plus` 广告配置——T0-4 边界，§8）

**admin**（仓库根 `admin/`）：`app.js`（CONFIG_NOTES 追加点 `:384`/`:385` 间 +邻位；计数注记链 `:110-111/:124/:134-137/:290-292`；「十一视图」→十二 `:48-66` 头注与 `:410-421/:452`；新视图函数照 `:2187-2387` 通知形态；state `:527-536`；懒加载 `:862-863`；nav 监听 `:3318-3319`）· `index.html`（nav + `<section>` 骨架，照 `:40/:119-128`）

**shared**：`src/logging/redact.ts:104`（`SECRET_KEY_NAME` +密钥名（T0-2 回填字面）+`AD_CHANNEL_PULL_TOKEN`；正反用例）· `test/design-md-ai-rollout.gate.test.ts`（`NEW_ENVS` +1 `AD_CHANNEL_PULL_TOKEN` `:131-141`；`RETIRED_ENVS` **零新增**——本片无 env 退役）

**compose / 栈 / 脚本**：`docker-compose.yml`（config-service 段 :276 邻 +`AD_CHANNEL_PULL_TOKEN`；currency-service 段 `:294-325` +同 env）· `docker-compose.override.yml`（config-service `:109-110`、currency `:112-120` 空默认透传）· `scripts/deploy/conformance-stack.sh`（顶部 export 照 `:57-58/:65`；**种子段**：`up)` 内节奏六键块后（`:249-251` 间）加第四键空间段——`seed_put` 兄弟（路径换 `/api/admin/ad-channel/`）+ 回调测试密钥种子 + 登录/重试复用 `:192-208`；顺手订正 `:93`「26 个切片」→ 现数）· `tools/conformance/src/run.ts`（`??=` 供给照 `:134-135/:144`；CASES 追加 `:90/:91` 间）· `tools/conformance/src/lib/http.ts`（+3 helper 照 `:288-298`）· `tools/conformance/baselines.json`（`full` 列 `:40/:41` 间 +两条目）· `.github/workflows/conformance.yml:32`（顺手订正「26 个切片」）

**docs**：§6 全清单。

### 1.3 明确不在改动面（有意）

- `tools/mock-server`（已知 7 键滞后，**不跟**——`src/index.ts:19` 与 `src/rest.ts:127` 注释自述）。
- `currency_relief_total` 值域与 `05-currency.json` 面板（零改动；r2 第 4 条口径）。
- `notify` 九键种子形态（切片内自种）——本片第四键空间取 **pay 形态**（栈种子）。
- `scripts/ops/backup.sh`（拉取令牌按现口径**不剥**——`backup.sh:191` 仅主钥；本片沿用，登记不改）。
- 第四键空间的 gauge/metric（pay 无、notify 有；本片 ops 面由 `relief_callback_total` 承担，**不加**键空间指标）。
- 短信/邮件渠道、其他广告位、H5 变现（设计 §10 YAGNI）。
- 真机验收（用户在场；§7）。

---

## 2. 新契约（写死）

### 2.1 protocol：第 41 键 + string 族 + 第 15 客户端键

**CONFIG_KEYS**（`config.ts:14-86`）追加第 41 键于 `:85`/`:86` 间，JSDoc「第 41 键」：

```
  /** 第 41 键：救助广告位 adpid（客户端下发裸名 `reliefAdpid`；空串=未配置 ⇒ 救助入口不渲染）。 */
  'ad.reliefAdpid',
```

**CLIENT_CONFIG_KEYS**（`:89-105`）第 15 键插于 `:103`/`:104` 间（`version` 恒尾）：

```
  'reliefAdpid',
```

**ClientConfig**（`:108-124`）+字段（`:122`/`:123` 间）：`reliefAdpid: string;`

**parseConfigValue**（`:171-202`）新分支，**必须插在 `:201` 兜底 throw 之前**：

```ts
if (key === "ad.reliefAdpid") return parseReliefAdpid(value);
```

`parseReliefAdpid` 逐字契约（新私有函数，同文件）：

- `typeof value !== 'string'` ⇒ throw `ProtocolError('ad.reliefAdpid 必须是字符串（严格类型：数字 / 布尔不算）')`；
- `trim()` 后 `''` ⇒ 返回 `''`（**合法=未配置**）；
- `^[0-9A-Za-z]{1,32}$` ⇒ 返回 trim 后原值；
- 否则 ⇒ throw `ProtocolError('ad.reliefAdpid 必须是 ≤32 位 base62 字母数字（或空串）；已 trim')`。

判据（§5.1 P1）：合法 `''` / `'abc123'` / 恰 32 位；非法：33 位 / 含 `-`、`_`、中文、内部空格 / 数字 `200` / `true` / `null` / `undefined`。文案断言**用动态 RegExp**（`config.test.ts:265-271` 的 vitest 2.1.9 教训：`toThrow(asymmetric)` 恒 false）。

### 2.2 config-service：种子与打包面

- **迁移 2**（`1795100000000-AdReliefAdpidSeed.ts`）：单条 `INSERT INTO \`platform_config\` (\`key\`, \`value\`, \`version\`, \`updated_at\`, \`updated_by\`) VALUES ('ad.reliefAdpid', '""', 1, NOW(3), 'seed')`；`down`=`DELETE … WHERE \`key\` = 'ad.reliefAdpid'`。注释写明「**string JSON 字面量首例**：`'""'`是空字符串而非空值」（数值先例`'60000'`会误导）。类名`AdReliefAdpidSeed1795100000000`。形状照 `1794000000000-IntervalConfigSeed.ts:37-61`。
- **种子四副本同源**（严格读取纪律）：①迁移本体 ②`config-probe.ts:140-191` SEED ③`platform-config.service.test.ts:204-256` SEED ④两测试的计数断言（`config-probe` 头注 `:29-32` 与 `:46-49` 登记面同步）。
- **组装行**：`client-config.controller.ts:63`/`:64` 间加 `reliefAdpid: (byKey.get('ad.reliefAdpid') ?? '') as string`——**fail 方向 = 空串**（与 K 一致：缺 ⇒ 入口不渲染）；头注 `:8-13/:21-22` 计数句 14→15、40→41。
- **列表/计数逐面**：`admin.controller.test.ts:175-221`、`config.rpc.test.ts:113-159`、`platform-config.service.test.ts:297/:303/:304`、`config.test.ts:10-44`、`client-config.test.ts:26-41`（排序插位：`reliefAdpid` 在 `'rechargePackages'` 与 `'reliefEnabled'` 之间——UTF-16 `'A'<'E'`）+`:97-108` 泄漏 deny-list **补 `'ad.'`**（41 键的 `ad.` 命名空间内部化；下发裸名不受影响）+`:139/:161` 兜底恒 15。

### 2.3 第四键空间 `ad-channel`（克隆先例；键名 T0-2 已复核——保留 `ad.callbackSecret`）

- **键面**：恰 1 键（工作名 `ad.callbackSecret`；T0-2 回填可改名——影响面 = 本键空间常量 + redact 名 + 测试，低）。`AD_CHANNEL_SECRET_KEYS` = 全键。
- **表**：`ad_channel_config` 五列 DDL **逐字**照 `1793000000000-NotifyChannelConfig.ts:26-33`（仅表名）；**无种子**。
- **service**：`status/set/clear/pull` 四方法 + LOCK/UPSERT/LIST/DELETE 四 SQL 常量（照 `pay-channel.service.ts:62-77` 形态，仅表名）+ 1213 有界重试 + `assertMasterKey` fail-closed；审计两列两形态（首写 old=SQL NULL 钉行 = pay `:344` / notify `:376`；清空 new=字符串 `'null'` = pay `:288` / notify `:316`）。
- **crypto**：复用 `sensitive-config/crypto-core.ts`，只写本域文案三枚（照 `notify-channel.crypto.ts:31-33`）；主钥**复用 `PAY_CONFIG_ENC_KEY`**（notify 已裁口径，本片未见推翻）。
- **RPC**：`rpc.ts` +`configAdChannelGet: 'config.adChannel.get'`；接收侧**第四** `@MessagePattern`（文件现三条；照 `:141-162` 形态）+ `pullTokenMatches` env 联合 +`AD_CHANNEL_PULL_TOKEN`（`||` 空串=未设；sha256+timingSafeEqual）；**常量与接收侧同提交**（J21 闸 `robot-availability-wiring.gate.test.ts:205`）+ 类头注计数句 \*\*`:26` 与 `:30`（两处「三条」）同步。
- **env**：`AD_CHANNEL_PULL_TOKEN`——持有方 = config-service + currency-service（**两持有**；≠ 通知的三持有）。注入点见 §1.2 compose/栈。
- **消费侧**（currency-service `ad-channel.config.service.ts`，照 `pay-channel.config.service.ts:43-54`）：每次回调**现拉** + lastGood 缓存；拉取失败用 lastGood；**无 lastGood ⇒ 回调按瞬态 5xx**（保持可重投；键未配置期=平台尚未开通，此形态正确）。
- **网关**：前缀常量 + P-a1（PUT）/ P-a2（DELETE）仅 `super_admin`，置于 P9 前（钉序断言）；三条转发方法（GET/PUT/DELETE）照 `gateway.controller.ts:220/234/254` 形态（`:key` 经 `encodeURIComponent`）。
- **管理页**：第 **12** 个视图（照 `:2187-2387` 通知形态的**单列表**简化）；掩码写规则照抄：secret 行 `已配置 ✓ · 指纹 <12hex>`、`value` 恒 null、输入框不预填、保存/清空控件仅 super_admin；`VIEW_ORDER`、state、懒加载、nav 监听同步。
- **G12 针脚**：取 **pay 形态（两表都加）**——`slice-19` app.js 针 + index.html 针各 +3~4 条（`admin/app.js` 前缀 `/api/admin/ad-channel/`、view/nav id、行前缀）。
- **redact**：`SECRET_KEY_NAME` 枚举 +密钥名 +`AD_CHANNEL_PULL_TOKEN`；正反用例。

### 2.4 回调端点 HTTP 契约（`GET {AD_NOTIFY_PATH}` = `/ad/notify/uniad`）

> **v1.4 T0 勘误（官方实文，`docs-fetch/ad-rewarded.txt`）**：uni-ad 服务器回调对【业务在传统服务器】的形态逐字为「以 HTTP(**GET**) 方式请求开发者配置的回调URL」（`:811`）；字段全集 = `adpid · provider(china/global) · platform(iOS/Android/weixin-mp) · sign · trans_id · user_id · extra · cpm?`——**无 ts**（⇒ 原「时间窗」面整体退役）；`sign = sha256(secret:trans_id)`（`:899-905`）；**响应必须为 JSON `{"isValid": true}`** 才是唯一确认信号，未收到（或响应过慢）⇒ 广告商重投（`:860/:922`）。方法/响应/字段三面自 v1.3 的 POST + form-urlencoded 缺省**整体改写**；本节其余结构（次序即判据/链序不可放宽）不变。

- **挂载三件套**（照 `payment-service/main.ts:43,53,57` 逐件）：`rawBody: true`（**保留**——与 pay 同形；GET 无 body ⇒ 本件不承载判据）、`setGlobalPrefix('api', { exclude: [...] })`（RouteInfo 形态见实现期勘误①）、`createInternalTokenMiddleware([...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH])`；豁免面**不得扩大**（测试族钉近邻：`/ad/notify/uniadx`、`/api/ad/...` 不豁免）。
- **路由**：`@All('ad/notify/:provider')` + 处理内自检（方法闸 405 需 `@All`——Nest 对方法不符的缺省行为是 404 不是 405，`notify.controller.ts:14-16` 教训）。

**防护链（次序即判据；= pay 形态的「无 body 子集」）**：

| 步  | 闸                                                                               | 失败码  | 备注                                                                                         |
| --- | -------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| ①   | 方法闸（**仅 GET**；其余 405）                                                   | **405** | `@All` + 自检；面向**非平台流量**（平台恒 GET），无 isValid 语义                             |
| ②   | 限流（`NotifyRateLimiter` 克隆：键 `ad:notify:rate`、60s、>600、fail-open+WARN） | **429** | 单桶语义 = 回调 peer 恒为 edge（不读 XFF）；应答按瞬态形态（`{"isValid": false}`）⇒ 平台重投 |
| ③   | 验签（算法已落，见下）→ claim 解析 → 账本先行 → 裁决 → apply → 落 done           | 见下表  | 应答体封闭（JSON）                                                                           |

- **原② 内容类型闸（415）与③ 体积闸（413 / `AD_NOTIFY_MAX_BODY_BYTES`）删除**：两者载体都是 body；GET 回调字段走 query、无 body（URL 长度由 edge/Caddy 层自然约束，不设应用闸）⇒ 两闸失去判据意义，常量随之退役。

**query 字段与验签（T0-2 已落，唯一算法点）**：

- 字段全集（**逐字**）：`adpid · provider · platform · sign · trans_id · user_id · extra · cpm?`。**身份只来自 `extra` 里的 claim（§2.6/§2.9）**——`user_id` 仅信息性、**不**作受益依据（五条不可放宽之一不变）。
- **`sign = sha256(secret:trans_id)`**：对字符串 `"<secret>:<trans_id>"` 做一次 sha256 摘要（官方示例逐字）；`secret` = 该广告位密钥（第四键空间唯一键 `ad.callbackSecret` 的值，现拉 + lastGood）。
- 比较 = **常数时间**（`timingSafeEqual`）且**大小写归一**（双方 hex 统一 lowercase 后比较——防平台大小写变体）。
- **缺 `sign` / 验签失败 ⇒ 确定性拒绝**（`bad_sign` 桶）。**原「时间窗」面删除**（字段全集无 ts、签名亦不覆盖时间 ⇒ 无载体；重放防护由 claim + `trans_id` 幂等承担）。
- **畸形**（缺必填字段 / 无法解析）= `malformed` 桶，同属确定性拒绝。
- **`trans_id` 不独立落库去重**（2026-10-15 实现期注记，无语义变更）：`trans_id` 仅作**签名输入**与日志关联项，**不新增存储、不做独立去重**；回调幂等承重墙 = claim 记录状态（`done` 短路）+ 账本 `actionId=relief:<userId>:<date>`。上文「重放防护由 claim + `trans_id` 幂等承担」一句以此注记为准。

**业务结果 → 响应（v1.4 落定字面；官方「唯一确认信号」语义）**：

| 业务结果                                                                                                  | HTTP                      | 应答体                               | 平台行为                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------ | ------------------------------------------------------ |
| **终态**：发放 granted / 重放 replayed（账本先行或 apply）/ 正向裁决拒绝 / claim 无效 / **坏签名 / 畸形** | **200**                   | **`{"isValid": true}`**（逐字 JSON） | **不重投**（重投不可改变确定性结局——含全体确定性拒绝） |
| **瞬态**：claim 读取故障 / apply 失败 / 记录写失败 / 配置或密钥拉取不可用 / 限流 429                      | **5xx**（限流 = **429**） | **`{"isValid": false}`**             | 重投（平台重试窗内自愈）                               |

- ⚠️ **坏签名归「终态」是有意口径**（官方语义下「不重投」只能靠回 `isValid: true` 表达）：运营后果 = 密钥错配窗口内的回调**不会**被平台重投，玩家侧靠「未到账 → 凭证失效 → 重试」自愈；**密钥错配的第一现场由告警 `ReliefCallbackBroken` 兜底**（§2.7）。

- **计数与落序规约** = §2.7（逐路径表）；设计 §2/§4.3 的「读记录 done 短路 → 账本先行 → 裁决 → apply → 终态后落 done」为**不可放宽链序**。

### 2.5 `GET /api/wallet/relief` 契约

- **网关层**：`@Get('wallet/relief')` 新增、旧 `@Post('wallet/relief')` 删除（404 由网关层产生——统一信封）；query 经 `whitelistedQueryOf(req, ['claim'])`（**唯一实现复用**——本体 `:1141-1152`，白名单外键丢弃——查询走私纪律）。
- **响应信封**：`{ code: 0, data: ReliefQueryData }`；`ReliefQueryData = { eligible: boolean; grantedToday: boolean; amount: number; balance: number; claim?: string; reason?: string }`——`amount`/`balance` **恒在场**；`claim` 仅「签发/复用（无 claim 路径 · eligible）」时在场；`reason` 仅不可领/终态拒绝/失效时在场。
- **配置不可用** ⇒ `503 / 10007`（既有语义，无变化）。

**判定次序（无 claim 路径，逐字）**：①快照不可用 ⇒ 503 · ②**今日已发**（账本当日 `actionId` 存在）⇒ `{grantedToday:true, eligible:false, reason:'今天已经领过了'}`（**先于开关与余额闸**）· ③开关关 ⇒ `reason:'救助暂未开放'` · ④余额 ≥ 门槛 ⇒ `reason:'余额充足，无需救助'` · ⑤eligible ⇒ 签发/复用 claim 随响应返回。

**携 claim 路径（轮询只读——不签发、不续期）**：

| 序  | 状态                                                | 响应                                                                    |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | 记录 `userId` ≠ JWT 本人                            | 按「不存在」处理（下第 5 行）                                           |
| 2   | 账本当日已真（按 JWT 本人 + **时钟当日** actionId） | `{grantedToday:true, eligible:false, amount, balance}`（成功面）        |
| 3   | 记录 `done`                                         | granted/replayed ⇒ 成功面；disabled/balance_ok ⇒ 对应 `reason`          |
| 4   | 记录 `issued`                                       | `{eligible:true, grantedToday:false, amount, balance}`（pending）       |
| 5   | 记录不存在                                          | `{eligible:false, grantedToday:false, reason:'领取凭证已失效，请重试'}` |

**reason 文案表（逐字；服务端唯一给）**：`今天已经领过了` · `救助暂未开放` · `余额充足，无需救助` · `领取凭证已失效，请重试`。

### 2.6 claim 机制（Redis；设计「规格定」全落）

**键形**：`relief:claim:{nonce}`（记录）+ `relief:claim:u:{userId}`（索引 → nonce）。记录值 = JSON `{"userId":"…","date":"YYYY-MM-DD","state":"issued"|"done","result"?: "granted"|"replayed"|"disabled"|"balance_ok"}`；`date` = Asia/Shanghai 签发日（首发时刻固定，**复用续窗不重锚**）。

**TTL**：issued 态 = `RELIEF_CLAIM_TTL_SECONDS(900)`，**eligible GET 续期**（签发/确认各一次；续期 = 两键 EXPIRE 同置）；done 态 = `RELIEF_CLAIM_DONE_TTL_SECONDS(172800)`；**done 落定时删除索引键**（E 裁定）。索引悬垂容忍：读路径遇「索引→无记录 / 记录非 issued」⇒ 按「无凭证」新签。

**nonce**：`crypto.randomBytes(16).toString('base64url')`（22 字符；B 裁定）。

**「找到或创建」原子算法（伪代码契约；D 裁定）**：

```
find-or-create(userId):
  1. idx = GET relief:claim:u:{userId}
     if idx 存在:
        rec = GET relief:claim:{idx}
        if rec 存在 且 rec.state==='issued':
           EXPIRE 两键 = TTL           // 复用 + 续期（同 nonce）
           return rec
        else:
           **条件删索引**（仅当当前值 == 本次观察到的 idx 才 DEL）
           // 悬垂：索引在而记录不在/非 issued ⇒ 视为无凭证（E 裁定）
           // ⚠️ 非条件 DEL 会误删并发胜者刚写入的新索引 ⇒ 同用户瞬时双凭证（违**设计 §2/§3 的单凭证不变量**）——
           //    两处 DEL 一律条件化（WATCH/MULTI 或 Lua 等价物）
  2. nonce = randomBytes(16).toString('base64url')
     SET relief:claim:{nonce} = {userId, date: today(Asia/Shanghai), state:'issued'} EX TTL NX
  3. SET relief:claim:u:{userId} = nonce EX TTL NX
     if 失败:                          // 并发竞窗
        DEL relief:claim:{nonce}       // 补偿：不留下无人引用的记录
        idx2 = GET 索引
        if idx2 存在 且其记录 issued: return 胜者记录
        else:
           **条件删悬垂索引**（仅当值 == 本次观察到的陈旧值）
           重试至多 1 次（回到 2）
           仍败 ⇒ DEL 自家记录后按瞬态失败（GET 503 面，不裸抛）
```

- **并发双投（回调侧）规格落定（设计 §4.3 留题）**：done 落定用**条件写**——仅当 `state==='issued'` 时置 done（WATCH/MULTI 或单命令等价形态，实现自选）；竞败一方**不覆盖**胜者 `result`、按其读回的 result 返回 200。金钱正确性由台账 `actionId` 幂等独占不变。

**读取故障分类**（r3 🟡-6）：Redis 连接故障 ⇒ 归类「**读取故障（瞬态）**」⇒ 回调 5xx 可重投 / GET 503 级失败；**不得**与「不存在/过期」同归 `claim_invalid`。**丢失/重启**（数据面）⇒ R7 口径（fail-closed，用户重试可恢复）。

**落序**（不可放宽）：回调链 `读记录（done ⇒ 短路 200，发放面不计）→ 账本先行 → 正向裁决 → apply → 终态后落 done/result`；账本先行命中 ⇒ 落 `done:replayed`；瞬态 ⇒ 不落任何东西、保持 issued。

### 2.7 观测契约

- **新指标**：`relief_callback_total{result}`——枚举逐字 `{accepted, claim_invalid, bad_sign, malformed, error}`；一回调一计（每次回调恰入一桶）。
- **发放面逐路径计数（§4.5 计数注落定）**：

| 路径                              | 回调面     | 发放面 `currency_relief_total`         |
| --------------------------------- | ---------- | -------------------------------------- |
| ① `done` 短路（顺序重投）         | `accepted` | **不计**（原处置已计）                 |
| ② 账本先行判重放                  | `accepted` | `replayed`                             |
| ③ 正向裁决拒绝（中途切开关/充值） | `accepted` | `rejected`                             |
| ④ apply granted                   | `accepted` | `granted`（**与 apply 返回同点计入**） |
| ⑤ apply replay / 14002            | `accepted` | `replayed`                             |
| ⑥ 瞬态（含 claim 读取故障）       | `error`    | 不计                                   |

- **`currency_relief_total` 本体零改动**（名/值域/描述）：旧写点从 `wallet.controller.ts:107/121/136/145/153` 迁到回调链同义五处；**不加新值**。
- **告警 2 条**（`ftl-alerts.yml`；25→27）：
  - `ReliefCallbackBroken`：`expr: increase(relief_callback_total{result=~"bad_sign|error"}[10m]) > 10`（照 `PaymentNotifyBadSignSpike` 形状：无 `for`）；annotations 含 runbook（查验签失败日志 → 管理页「广告回调」键与平台后台对钉 → 疑似攻击查 edge 日志）。
  - `ReliefGrantZero`：`expr: increase(relief_callback_total[10m]) > 0 and increase(currency_relief_total{result="granted"}[10m]) == 0` `for: 30m`；summary =「回调有流量但 30m 零发放（看了广告永不发）」。
- **计数同核四处**：`ftl-alerts.yml` + `slice-16:94-107`（名单体）· `:701-704`（promtool）· `:764-768`（rules 名单）+ `slice-18:1322`。

### 2.8 edge 路由

`deploy/Caddyfile` 在 catch-all `handle {`（`:73`）**之前**加（照 `/pay/notify/*` `:70-72` 逐字形态）：

```
handle /ad/notify/* {
    reverse_proxy currency-service:3004
}
```

Caddyfile **烤进边缘镜像**（`Dockerfile.edge:40`）⇒ 重建手顺（全仓唯一先例 `2026-10-06-pay-channel-admin.md:153`，逐字）：

```
docker compose build edge
EDGE_HTTP_PORT=8080 EDGE_HTTPS_PORT=8443 docker compose --profile edge up -d --no-deps --wait edge
```

（⚠️ 裸 `up -d` 会掉回 80/443——环境纪律第 18 条。）

### 2.9 客户端契约

**`net/ads.ts` 接口（逐字）**：

```ts
playRewardedAd(adpid: string, opts: { extra: string }): Promise<'completed' | 'closed' | 'unavailable' | 'error'>
isRewardedAdSupported(): boolean   // detectPlatform()==='app' 的异常收口版（非 App / 未知平台 ⇒ false）
```

- 实现：`uni.createRewardedVideoAd({ adpid, urlCallback: { extra: opts.extra } })`；`onClose(res.isEnded)` 仅作 UX 判据（`completed`/`closed`）；加载失败/无填充 ⇒ `unavailable`；异常 ⇒ `error`。**绝不触发发放**。
- **身份字段零传**：无 `userId` 形参（r3 🟡-8）；平台若有同名透传字段，服务端一律不读。

**lobby 流程（逐字）**：点击 ⇒ `getRelief()`（签发/复用）→ 可领 ⇒ 弹层 → 确认 ⇒ `getRelief()`（**续窗**；失败 ⇒ toast「网络异常，请重试」不播放；此时不可领 ⇒ 服务端 reason 不播放）→ `playRewardedAd(adpid, {extra: claim})` → `completed` ⇒ 轮询 `getRelief(claim)`（2s×3，终态即止）→ 成功面 ⇒ 关弹层 + `setWalletBalance(balance)` + 「已领取救助 +N」；终态拒绝/失效 ⇒ 显示服务端 reason；纯 pending 满窗 ⇒「发放可能稍有延迟，稍后回到本页查看」；`closed` ⇒ 不轮询、「完整观看才能领取」；`unavailable` ⇒「暂时没有可播放的广告，稍后再试」（不发放）。

**入口条件**：`store.reliefAvailable`（既有 `reliefEnabled ∧ balance < 15×entryMultiplier`）∧ `isRewardedAdSupported()` ∧ `store.reliefAdpid !== ''`（H5 隐藏 = 平台否 + 服务端不下发 adpid 双保险）。

**配置面**：`ClientConfigState` +`reliefAdpid: string`（`:50-78`）；`setClientConfig` +写行；`FAILSAFE_CLIENT_CONFIG` +`reliefAdpid: ''`；`normalizeClientConfig` ⇒ `raw?.reliefAdpid ?? ''`（K）。**源码闸**：客户端不再出现 `'POST /api/wallet/relief'`/`claimRelief(`。

**构建**：`manifest.json` `app-plus` 广告配置（T0-4 边界——标准基座/自定义基座/云打包形态随其回填，§8）。

---

## 3. 权限与网关

- `GET /api/wallet/relief`：网关 JWT（本人）——不进公开白名单（默认验签），照 `wallet/balance` 同族（`gateway.controller.ts:286-306`）。
- 旧 `POST` 删除后：网关路由、其测试面（`:888-966,1132,1147`）、下游 `wallet.controller` 旧实现与其测试族（`test/relief.test.ts` 整族重写去向）同步。
- 管理面 `ad-channel`：P-a1/P-a2 仅 `super_admin`（PUT/DELETE）；GET 落 P8；置于 P9 前（钉序）。
- 回调面：**不经网关**（edge 直连 currency-service:3004，照 `/pay/notify/*` 形态）；信任 = 验签唯一。

---

## 4. （保留给评审增补；v1.0 无独立章）

---

## 5. 测试与判据

### 5.1 单测清单（P1–P6）

- **P1 protocol**：§2.1 判据族 + 41/15 两份名单 + `ClientConfig` 形状。
- **P2 config-service**：两迁移计数/名单/`down` 反向 · 四份种子副本同源 · 管理面 41 键 GET · `ad-channel` 四件套（错误序 401→400→503 判别性专测照 pay）· redact 正反 · `NEW_ENVS` · `client-config` 15 键 + deny-list `'ad.'`。
- **P3 currency-service 单测**：验签器样本（好/坏/缺 `sign`/**大小写变体（归一后同判）**——T0-2 已答字面，样本直喂；**原「超时间窗」样随时间窗面退役删除**）· claim 族（§2.6：不存在/过期/已用短路/畸形/改串/**读取故障 ⇒ 5xx 不改口径**）· **落序两注入**：(a) apply 抛错 ⇒ 重投发放且落 done:granted；(b) **apply 已提交但记录写失败** ⇒ 重投账本先行判 replayed、落 done:replayed、金额不再增 · **claim 窗尾（900s TTL；与平台无 ts 无关，保留）**：确认+14:59 回调 ⇒ 发放；+15:01 ⇒ 拒发且**不建键** · **携 claim 五态**（§2.5 表逐行）+ 跨主体按不存在 · **复用**：两连 GET 同 nonce + 续期；连发 GET 键数不增 · **悬垂恢复**：索引在、记录不在/非 issued ⇒ 新签可达且悬垂被**条件删**（**不得裸 DEL**——防误删并发胜者新索引；E 裁定样本）· find-or-create 竞败补偿（DEL 自家记录）· **并发双投条件写**（竞败不覆盖、按胜者 result 200）· 计数六路径逐行 · 限流（INCR/窗口/fail-open WARN）· 防护链**三步**各一（405 非 GET / 429 / 验签）· `actionId` 锚签发日 + `grantedToday` 同口径（**跨零点样本——直取口径函数断言；e2e 不得照搬**：现行种子金额 200 ≥ 门槛 150，回调后余额闸先接走，r4 附注）· 旧 POST 删除后 `test/relief.test.ts` 整族重写去向（查询语义族）。
- **P4 gateway**：`@Get` 转发 + query 白名单判别（`?claim=x&smuggle=1` ⇒ 下游只见 claim）· 旧 POST ⇒ 404 · P-a1/P-a2 矩阵 + 钉序 · 三转发方法。
- **P5 client**：`ads.ts` 四分支 + `isRewardedAdSupported` 注桩（jsdom `readUniSystemInfo()→{}` ⇒ browser ⇒ false）· lobby 流程四分支 + **轮询终态三出口** · 归一/failsafe 15 键 · 源码闸。
- **P6**：六阶段（`bash scripts/ci.sh`）+ 全序（29 片）+ baselines 回填。

### 5.2 conformance

**`slice-24-ads-relief`（新；组设计，断言数实现后按实跑回填）**：

| 组  | 内容                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⓪   | 起手：前置态自证（开关/adpid 种子态/无残留）+ 第四键空间种子在场                                                                                                                                                                                                                                                                         |
| ①   | 键空间面：管理面掩码（值 null + 指纹）· super_admin 写读回 · 非 SA 403 矩阵 · 种子密钥生效                                                                                                                                                                                                                                               |
| ②   | 键面：`/api/config` 恰 15 键（排序字面）· 内部键零泄漏 · 管理面 41 键 · adpid 空串种子方向 + 非空后客户端面生效                                                                                                                                                                                                                          |
| ③   | 签发面：eligible GET ⇒ claim（形态/双键在场）· 复用同 nonce + 续期 · 键数不增 · **悬垂样本**（`redisRaw` 删记录留索引 ⇒ 新签且索引更新）                                                                                                                                                                                                 |
| ④   | 拒发穷尽（回调）：坏签名 / 畸形 / 未签发 / 过期 / 改串 / 中途切开关 / 中途充值 / provider 非豁免段（中间件 401）——各码面与词面                                                                                                                                                                                                           |
| ⑤   | **正路一次（经门口 `https://localhost:8443/ad/notify/*` 一条**——顺带验收 Caddy 路由，照 `slice-21:101-102`）：GET ⇒ 回调 ⇒ granted + 余额 +200 + GET 已发 + 两指标 +1                                                                                                                                                                    |
| ⑥   | 重投幂等：同载荷二次 ⇒ 200 + 余额不变（短路；发放面不重复计 `granted`）                                                                                                                                                                                                                                                                  |
| ⑦   | **账本先行重放**：GET 签发 → **RPC 预置同锚流水**（`relief:<userId>:<D>`；slice-18 rpcApply `:411/:1006`；RPC 直投不触端点指标——机制自明，无先例注释）→ 回调 ⇒ replayed + 余额不变 + Redis 读证 done:replayed。⚠️ **不得以「记录移除」构造**——记录移除 ⇒ resolveClaim 失败 ⇒ 走 `claim_invalid`，到不了账本先行（R7 口径，r4 🟠-2 禁令） |
| ⑧   | **跨零点重投**：`lib/redis.ts redisRaw :31-38` 回写记录 `date` 为昨日 ⇒ 回调按昨日锚 ⇒ 断言 apply 成功且**今日** `grantedToday` 未翻转（B-1 落点）                                                                                                                                                                                       |
| ⑨   | 轮询四态（携 claim）：pending / 成功 / 终态拒绝 / 失效 + **只读自证**（不签发不续期）+ 跨主体按不存在                                                                                                                                                                                                                                    |
| ⑩   | `claim_invalid` 不建键：回调前后 Redis 键计数对照（`redisRaw keys`）                                                                                                                                                                                                                                                                     |
| ⑪   | 旧 POST ⇒ 404（经网关）；`fetchRelief` 新面语义                                                                                                                                                                                                                                                                                          |
| ⑫   | 收尾：状态还原（开关关 / adpid 还原）· 零残留                                                                                                                                                                                                                                                                                            |

**slice-18 G 组原位改写契约**（H 组**逐字不动**，其数据源仍由 G 提供）：

- 驱动换新链（GET 裁决 + 签名回调样本，夹具与 slice-24 同源）；四态确定性构造：`granted`=正路；`replayed`=**先 GET 签发、后 RPC 预置同锚流水、再投回调**（⚠️ 旧注释「扣回后再领 ⇒ replayed」在新链不可达——`今日已发` 闸挡第二张凭证，r4 🟠-1 删正）；`rejected×2`=中途切开关·中途充值后回调。
- 追加覆盖：GET「已领优先于余额闸」（余额回升后 ⇒ 「今天已经领过了」）。
- 断言数**目标 ≥ 现值 11**（floor 132 不降；合计读数按实跑回填——本片改动面较广，回填须写理由）。
- 旧 `reliefG()`/POST 调用链（`:1195-1198`）删除。

### 5.3 既有闸改造核销表（逐行 = 验收清单）

| #   | 面                  | 实测落点（HEAD `7af1642`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 动作                                              |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | protocol 名单       | `config.test.ts:12-36`（40 键）· `:37-44`（14 键）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | +1/+1 逐字插位                                    |
| 2   | config-service 计数 | `platform-config.service.test.ts:297/:303/:304` · `admin.controller.test.ts:175-221` · `config.rpc.test.ts:113-159` · `client-config.test.ts:26-41/:97-108/:139/:161` · `config-probe.ts:140-191` + 头注 `:29-32`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 40→41 / 14→15 / deny+`'ad.'`                      |
| 3   | 注释散点            | **两口径扫**：①「四十键\|40 键」——`protocol/src/config.ts:3` · `platform-config.entity.ts:10` · `platform-config.service.ts:45/:57` · `admin.controller.ts:101` · `gateway.controller.ts:127` · room `gateway/config.client.ts:21` · room `gateway/rpc.options.ts:35` · robot `config/config.client.ts:14` · user `config/config.client.ts:15` · user `1789100000000-BaseScoreLevels.ts:7` · protocol `pay-channel.ts:4` · `notify-channel.ts:4` · `pay-channel.service.ts:36` · `notify-channel.service.ts:38`。②「十四键\|14 键」——`client-config.controller.ts:8/:21/:22/:32` 系。⚠️ **口径排除项**：「第 35–40 键」序号引用（约 8 处）**不得改**；改毕以真红/真绿自证 | 「四十键」→四十一（41）· 「十四键」→十五（15）    |
| 4   | conformance 计数组  | **操作数/常量（🟠-1 补全）**：`slice-20:142`（`TOTAL_CONFIG_KEYS = 40` 计数权威本体；`:141` 为 JSDoc 不属操作数）· `slice-14:504` · `slice-17:1272` · `slice-21:687`（三处 sorted 键串字面）。**消息/文案面**：`slice-14:501/:505/:498` · `slice-17:1265/:1269/:1273/:50`（头注 7→14 句） · `slice-18:8` + `:100-102`（排序字面插位 `'rechargePackages'`/`'reliefEnabled'` 间）+ `:856` 文案 + `:861` 文案 + **`:892`**（40→41）· `slice-20:717/:723` · `slice-21:688` · `slice-22:854/:1097` · `slice-23:735/:741/:1283`                                                                                                                                                 | 40/41 · 14/15                                     |
| 5   | 告警计数            | `ftl-alerts.yml` + `slice-16:94-107` · `:701-704` · `:764-768` + `slice-18:1322`（**恰此四处**）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 25→27 逐名单同核                                  |
| 6   | 救助既有切片        | `slice-18:1186-1256`（G 11 条）· `:1258-1324`（H 17 条）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | G 原位改写（§5.2）；H 零改动（值域 + 数据源均留） |
| 7   | 网关                | `gateway.controller.ts:317-329`（旧 POST）+ `:286-306`（balance 先例）· `gateway.controller.test.ts:888-966,1132,1147`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 删 POST / 加 GET + query 白名单                   |
| 8   | currency-service    | `wallet.controller.ts:93-155` 旧 POST 移除 · `test/relief.test.ts` 整族重写去向 · `main.ts:35/:40/:42` 三件套 · `app.module.ts:65-73` 注册                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §2.4/§2.5                                         |
| 9   | 客户端测试族        | `wallet-entry.test.ts:219-300`（14 键族：`:222/:269` 邻域）· 新 `ads` 测试 · 源码闸                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 15 键 + 流程                                      |
| 10  | client-protocol     | `docs/client-protocol.md:52`（data 形状）· `:54`（四十键句中键数）· `:88`（14 键句）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 形状 + 41/15                                      |
| 11  | design.md 散点      | `:142`/`:408`/`:492`/`:499`/`:1092`（恰十四键句）· `:1185`（键面横幅句）· `:1213`/`:1224`/`:1415`/`:1564`/`:2039`（消费者段——补 `ad.` 句）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 计数 + 键面                                       |
| 12  | first-deploy        | `:993-1033`（四十键一览表）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 41 键 + `ad.reliefAdpid` 行 + §7 手册节           |
| 13  | 管理页              | 见 §1.2 admin 行（含 CONFIG_NOTES 追加 + 计数注记链 + 第 12 视图）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 全同步                                            |
| 14  | 第四键空间          | §2.3 克隆清单逐件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 四件套                                            |
| 15  | G12 针脚            | `slice-19` pay 形态两表（先例 app.js `:1430-1433` / index.html `:1461-1464`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | +3~4 条                                           |
| 16  | 注册面              | `run.ts` CASES `:90/:91` 间 + `baselines.json` full `:40/:41` 间                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | slice-24 注册；slice-18 读数回填                  |
| 17  | 陈旧文案            | `conformance-stack.sh:93`「26 个切片」· `conformance.yml:32`「26 个切片」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 顺手订正为现数（29）                              |
| 18  | slice-18 内部陈旧   | `:22`/`:1261`「23 条」文案（早于现状 25）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **不在本片范围**（登记；下一自然修订顺手）        |

### 5.4 夹具与栈脚本

- **`tools/conformance/fixtures/ad-callback/`**：测试密钥对（生成器照 `alipay-test/generate-fixtures.mjs` 形态）；**连带闸（🟡-9 收口）**：`.gitleaks.toml` 新增**第 8 条** `[[allowlists]]`（目录锚定照第 5 条形态）+ `slice-07.4-pipeline.ts:**633**` 计数 pin **7→8** + **新增一条对应 literal pin**（照 `:636-638` 逐条形态）+ **M0.1 安全扫描规格同步**（机制注记见 `generate-fixtures.mjs:19-20`，照 `190a6cc`（#4）先例）。**`baselines.json` 零调整**（slice-07.4 保持 75/75——全部 gitleaks pin 折叠进既有 C1–C10 谓词，**不改变执行条数**；先例：`190a6cc`（#4）与安全扫描 v3.4/v3.5 两次加条均未动读数）。**签名格式随 T0-2**（canonical + 算法一处 helper）。
- **回调样本 helper**（slice-18 改写组与 slice-24 共用）：本地签名（`createSign`，照 `alipay-stub.mjs:76-85` 的 canonical 近亲代码形态）——**不用 stub 容器**（起飞实读：ads 无出站调用）。
- **`conformance-stack.sh`**：顶部 export +第四键空间令牌（照 `:57-58/:65`）；种子段：`up)` 内节奏块后（`:249-251` 间）——密钥种子（`seed_body_value`/`seed_body_pem` 复用）+ `seed_put` 兄弟（路径 `/api/admin/ad-channel/`）+ 登录/重试复用 `:192-208`；**幂等可重跑**。
- **`run.ts`**：`??=` 供给两处同源（照 `:134-135/:144`）。
- **`lib/http.ts`**：+`adminAdChannelGet/Put/Delete` 三 helper（照 `:288-298`）。

### 5.5 baseline

- `slice-24`：新条目，**按本机真栈两跑实况回填 + CI 权威轮校正**（含真实时序——轮询窗/限流窗口，同 slice-21/22/23 口径）。
- `slice-18`：改写后实跑回填（**floor 只升不降**；若降，须提交理由）。
- `check-baselines.mjs` 零改动。

---

## 6. 闸与核销（文档面）

- §5.3 行 10–13 全列；`deviation-ledger.md` 新条目（旧 POST 退役 · 四态驱动语义退役 · 第四键空间 · edge 新行 · slice-18 重写——本片偏离集中登记）。
- `first-deploy.md` 新增「广告怎么开通」节（回调 URL 配置点 = `https://<域名>/ad/notify/uniad`、换广告位手顺、密钥轮换、edge 重建提醒）。
- 交接文档（收口时）：`docs/superpowers/plans/2026-10-11-…-post-ads-handoff.md`。

---

## 7. 上线 / 回滚 / 手册

1. 代码 push/tag（**暗**：adpid 空 + 键空间未种 ⇒ 零行为变化）。
2. 操作前快照：管理面确读 `reliefEnabled=false`（「从未开启」当场证据）。
3. 用户侧：uni-ad 实名/财务 → 绑定应用 → 快捷广告 + Sigmob → 激励视频广告位（开服务器回调）→ adpid + 密钥 → 后台配回调 URL。
4. 配置：管理页填 `ad.reliefAdpid`（**带引号字符串**，CONFIG_NOTES 已写明）；回调密钥入「广告回调」视图（掩码写）。
5. 开 `reliefEnabled` → 真机验收（设计 §7 判据面：完整观看 → 到账；中途关闭 → 不到账 + 专用文案；文案分支）。
6. **回滚**：行为面回滚 = `ad.reliefAdpid` 置空（秒级，入口即暗）或 `reliefEnabled=false`；代码面回滚 = 镜像 tag 回退（第四键空间表留库无害）。edge 回滚含 `build edge` 重建（§2.8 手顺）。

---

## 8. T0 五项：已答结论（v1.4 · 官方实文）+ 回填对象

> 原「待 T0 回填边界清单（开发前须有结论）」——**结论已到**（2026-10-12 抓档实文，存档见文件头）；本表右列 = 实现回填批的对象面。

| T0   | 官方实文结论（抓档行号）                                                                                                                                                                                                                     | 回填对象                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T0-1 | ✅ **文档层成立**：快捷广告 / Sigmob 均在支持渠道内；服务器回调是 uniCloud 层统一能力（实配以广告位「服务器回调」开关为准）                                                                                                                  | —（无代码面）                                                                                                                                                                                                                                                                                                                                                            |
| T0-2 | ✅ **已答**：`sign = sha256(secret:trans_id)`（`ad-rewarded.txt:899-905`）；`secret` = 广告位一枚（与本规格第四键空间 1 键命名对位）                                                                                                         | `ads-verifier.ts` 的 `verifySignedFields` **函数体**（算法 + 大小写归一 + `timingSafeEqual`；**原 canonical/时间窗面作废**）· fixtures 换真形态（`--regenerate`，两 PEM 一起去删防半替）· stack 种子换同源真形态 · 密钥来源接线（T14 既有拉取通道）· 键名 `ad.callbackSecret` **保留**（实文未给异名）· 测试「好形状样本」换真签样本直喂                                 |
| T0-3 | ✅ **已答（改动面 = §2.4 整段）**：方法 = **HTTP GET**（`:811`）· 响应 = **JSON `{"isValid": true}`**（`:922`；未收到 ⇒ 重投）· 字段 = `adpid/provider/platform/sign/trans_id/user_id/extra/cpm?`（**无 ts**）· 重试窗长文档未载（实配观察） | `ads.controller.ts`（方法闸改 **GET**、**删 415/413 两闸**与 `AD_NOTIFY_MAX_BODY_BYTES`、响应体改 JSON）· `extractCallbackFields`（取 query、字段名 `trans_id`）· `tools/conformance` 的 `AD_CALLBACK_SIGNED_FIELD_NAMES` 同形 · `slice-24` ④⑤⑩ 码/词断言改形（原 415 探针 ⇒ **GET 缺参 ⇒ 200 + `{"isValid": true}`** 的「豁免通 + 路由在场」同义证据；POST ⇒ 405 保留） |
| T0-4 | ✅ **部分已答**：渠道 SDK「**真机运行不生效、打包后生效**」（`ad-open.txt:138`；HBuilderX ≥2.5.11，实装 5.26 满足）；服务器回调需 App 平台 3.1.15+（满足）                                                                                   | `manifest.json`：打包界面勾「广告(uni-ad)」+ 渠道 **Sigmob**（**不手工发明节点形态**——以打包界面回写为准，注释已在位）；真机联调方式 = 打包产物                                                                                                                                                                                                                          |
| T0-5 | ⚠️ **部分**：文档未载 `extra` 长度/字符集上限（「如无需要则为空」，空 extra 属常态）                                                                                                                                                         | `claim.service.ts` nonce 编码**保持缺省** `randomBytes(16).toString('base64url')`（22 字符）；实配时验证，若平台有限制 ⇒ 一处生成函数                                                                                                                                                                                                                                    |

---

## 9. 修订记录

| 版本                                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.0（2026-10-11）                           | 起草：⚙️A–N 裁定 · 0.4 起飞纠偏六条 · 全契约与判据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| v1.1（2026-10-11）                           | **spec-r1「有条件通过」全收口**（报告 `.superpowers/sdd/2026-10-11-ads/review-spec-r1.md`）：🟠-1 §5.3 行 4 补四处**操作数**（`slice-20:141` `TOTAL_CONFIG_KEYS`、`slice-14:504`、`slice-17:1272`、`slice-21:687`）· 🟠-2 §2.6 补**悬垂恢复分支**（DEL 悬垂索引）+ 悬垂样本（P3/§5.2③）· 🟡-3 行 3 补 `config.ts:3` + 两口径与排除项 · 🟡-4 审计钉行订正 `:344/:376` · 🟡-5 第五套 Fake 库 · 🟡-6 mock-server 注释行订正 · 🟡-7 `whitelistedQueryOf` 本体 `:1141-1152` · 🟡-8 并发双投**条件写**落定 + r4「记录移除」禁令复述入 §5.2⑦ · 🟡-9 fixture 连带闸三件 · 🟡-10「第四 @MessagePattern」+ 类头注 `:26` · 🟡-11 报告存续面（r3–r5 有文件）                                                                                                                                                                                                                                                                     |
| v1.2（2026-10-11）                           | **spec-r2 残项收口**（报告 `review-spec-r2.md`，判定「修毕再核」）：🟠-1 残 `slice-20:141→:142`（:141 为 JSDoc——v1.1 引入的 off-by-one，已订正）· 🟠-2 要害裁决落定：**两处 DEL 一律条件化**（非条件删会误删并发胜者新索引 ⇒ 瞬时双凭证）+ 二败路径自家记录补偿明说 · 🟡-9 残：pin 行 `:633`（非 :634）+ 新增对应 literal pin · 🟡-10 残：§2.3 同步第四 + 头注 `:26` **与 `:30`** 两处 · 🟡-11 残：自检句订正 · nano：`slice-14:498`/`slice-17:50` 文案 + 网关 `:1138`「两个调用方」注释同步                                                                                                                                                                                                                                                                                                                                                                                                                         |
| v1.3（2026-10-11）                           | **spec-r3 残项收口**（报告 `review-spec-r3.md`，判定「修毕再核」）：🟠 §5.4 **baselines 零调整**（v1.2 写的「两列同轮抬 +1」与实机制相抵——gitleaks pin 折叠进 C1–C10 谓词、执行数恒 75，抬 76 必红；先例 `190a6cc` 与 v3.4/v3.5 两次加条零提数）· 🟡 连带面补 **M0.1 安全扫描规格同步**（第五件，注记 `generate-fixtures.mjs:19-20`）· nano 悬垂注释 `§3`→「设计 §2/§3」（本规格 §3 是权限章）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **冻结（2026-10-11）**                       | **spec-r4 复核：可通过（规格可冻结）—— 0🔴 / 0🟠 / 0🟡**（报告 `review-spec-r4.md`；三处残项全闭合，含 baselines 75 的**实跑复证**：`dist/run.js slice-07.4-pipeline --render` 逐字「75 项断言」exit 0）。**本文件（`ac7ff27`）即冻结本、契约唯一真源**。随注两 nano（非阻断、未动冻结本）：① 先例句 `190a6cc`（#4）与 v3.4 双名冗余，顺手处置即可 ② M0.1 安全扫描规格本体（`:96/:183/:271`）仍写「恰好 5 条」陈旧句——实施连带闸时顺手订正                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 实现期勘误 ①（2026-10-12，T11 停手实跑发现） | **§2.4 挂载三件套第二件的 exclude 形态订正**：literal `setGlobalPrefix('api', { exclude: [AD_NOTIFY_PATH] })` 与参数化路由 `@All('ad/notify/:provider')` **组合不可工作**（真 Nest 管线实测：exclude 拿整条路由模式串做 regex exec，literal 排除不掉 `:provider` 模式 ⇒ 公开路径 404；且简报探针判据「不得 401」会被 404 **假通过**）。订正为 RouteInfo 形态：`setGlobalPrefix('api', { exclude: [{ path: AD_NOTIFY_ROUTE, method: RequestMethod.ALL }] })`，`AD_NOTIFY_ROUTE = 'ad/notify/:provider'`（新增常量）；**第三件豁免不变**（`[...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]` 单常量 literal 对钉）。渠道段预留（§2.4 路由行）不受影响；匿名面与 pay 完全同形（非 uniad 段匿名 ⇒ 401）。证据：T11 报告 §1 双候选实跑输出。契约面零变更（仅 exclude 语法）；判据面**增补**「公开路径不得 404」反例钉                                                                                                            |
| **v1.4（2026-10-13）**                       | **T0 回填勘误（官方文档实文；抓档 `.superpowers/sdd/2026-10-11-ads/docs-fetch/`，2026-10-12 直连抓取）**：§2.4 **整段改写**——方法 `POST`→**`GET`**；防护链删「内容类型 415 / 体积 413」两闸与 `AD_NOTIFY_MAX_BODY_BYTES`（无 body 载体，链 = 405→429→验签）；字段 `transId`→**`trans_id`** 且**删时间窗**（字段全集无 ts）；验签**落算法** = `sha256(secret:trans_id)` + 大小写归一 + `timingSafeEqual`；响应表落定字面（**终态 200 + `{"isValid": true}`**——含坏签名/畸形等全体确定性拒绝；**瞬态 `{"isValid": false}`** 触发平台重投）。同步面：§0.1（T0 五项已答）/§0.3 F-H-M 三行/§8 转「已答结论 + 回填对象」/§5 判据面改动随回填批（见 §8 T0-3 行）。**无已裁面被改**——全部改动都在 T0 边界之内（原规格自注「边界外的一切在本规格内定死」；T0 边界内自带「回填 = 一处常量/函数/样本」的授权）。**本条之后的实现任务** = 按 §8 右列回填 + `slice-18` G 组/`slice-24` 转真绿 + 基线两跑校正（149/224，只升不降） |
| 实现期注记（2026-10-15，**无语义变更**）     | T0 回填收口期三处注记：① §2.4 补「**`trans_id` 不独立落库去重**」（仅签名输入+日志；幂等承重墙 = claim `done` 短路 + 账本 `actionId`）；② 明示「缺/空 `sign` ⇒ `bad_sign`」以 §2.4 原句为准（实现一度误归 `malformed`，已按规格修正并补「先于密钥读面」单测）；③ config 校验器注释定稿——「trim 后非空、≤512」即**最终规则**（不透明密钥无字符集契约，不收窄）。契约面零变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## 自检（防审出低级项）

- 41/15 两份名单的**全部落点**已在 §5.3 行 1–4 列齐（含四处**操作数**、slice-18 `:892` 与 `:100-102` 排序字面、两口径与排除项）；`reliefAdpid` 排序位（`'A'<'E'`）三处（protocol/服务端/切片）口径一致。
- 四份种子副本（迁移 + config-probe + platform-config.test + 其计数块）同源；string 种子 `'""'` 写法在 §2.2 显式警示。
- 告警 25→27 的断言面 = **恰四处**（§2.7），slice-16 无第三处（已实读核实）。
- `currency_relief_total` 名/值域零改动；面板 `05-currency.json:139` 零改动。
- slice-18 H 组逐字不动**且数据源不断**（G 原位改写为本片显式契约）。
- 回调链五条「不可放宽」：次序（§2.4）· 落序/账本先行（§2.4/§2.6）· 计数六路径（§2.7）· 身份只来自 claim（§2.9）· 应答词面封闭（§2.4）。
- 键空间两持有（config + currency）与 R3/R5 登记不冲突；拉取令牌不进备份剥离（沿现口径，§1.3）。
- mock-server / notify 种子形态 / backup.sh **明确不为所动**（§1.3）。
- 设计五轮评审轨迹：**r3–r5 报告在 `.superpowers/sdd/2026-10-11-ads/`**，r1/r2 见设计文件修订记录；本规格的每个 ⚙️ 裁定均可被评审单独挑战。
