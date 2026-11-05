# 素材溯源与契约（主包 `src/static/` + 分包 `src/pages/<sub>/static/`）

> 本文件是**素材侧的契约**。改动素材前先读这里。
> 规格：`docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md` §6（R688 / R702 / R703 / R704 / R705）
> 机械闸：`apps/client/test/asset-budget.test.ts`
>
> **2026-10-12（项 6 小程序分包）起，素材按使用页面拆两处：**
>
> | 根                                                    | 内容                                                                                                                | 产物落点                                                               |
> | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
> | `src/static/`（**主包**，启动即载）                   | `ui/bg.png`、`ui/logo.png`、面板/按钮/货币/头像/结算带/角标等大厅与通用 UI；`audio/MusicEx_Welcome.mp3`（大厅 BGM） | `dist/<platform>/static/…`                                             |
> | `src/pages/table/static/`（**table 分包**，进桌才载） | `cards/`（56 牌面）、`av/`（地主/农民头像）、`ui/bg_table.png`、`audio/`（63 条牌桌音效/BGM）                       | `dist/<platform>/pages/table/static/…`（H5 与 mp-weixin 同形，已实测） |
>
> 代码侧：主包资源走 `assetUrl('/static/…')`；牌桌资源走 `tableAsset('cards/…')`（见 `src/asset.ts`）。
> 两者生产形态都会带 `?v=<版本>`。微信分包目录 = `pages/table`（见 `pages.json` subPackages）。

---

## 1. 来源与授权

| 项       | 值                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 来源项目 | `CardGame`（Unity 2022.3 + NGO）                                                                     |
| 原始路径 | 仓库根 `resources/`（385 文件 / 16.70 MB）                                                           |
| 许可状态 | 该仓库**无 LICENSE/COPYING/NOTICE**，README 的「许可证」段正文只有「待定」 ⇒ 原始状态 = 保留所有权利 |
| 授权     | **用户 2026-09-18 声明已另行取得全套素材授权**（裁决 **R688**）⇒ 本仓可用                            |
| 授权范围 | 牌面 / 牌背 / 头像 / UI / 音效                                                                       |

**片①（App 界面重做，2026-09-26）新增采用 9 张** —— 它们**本来就在 R688 的授权范围内**
（授权范围逐字含「UI」），此前因「MVP 界面用不到」未入库 ⇒ **不是新的授权**，只是启用：

| 文件               | 源                                    | 用途                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bg.png`           | `resources/UI/bg.png`                 | **默认底纹（片① 起）**                                                                                                                                                                                                                                                    |
| `bg_table.png`     | 用户提供（2026-10-12，来源/授权待补） | **牌桌专用底纹（2026-10-12 起）**：替换旧 `Common_BG4_2x.png`（片③ 用图，同日退役删除）；当前文件 329 KiB。缓存策略已统一（2026-10-12）：dev 对 static 资源给 `no-cache`、生产 URL 自动带 `?v=<版本>`（见 `src/asset.ts` / `uni.scss` 的 `ftl-asset-url`），不再手工 bump |
| `dou.png`          | 同名                                  | 货币图标（片② 起；**B6 已接槽 `$ftl-art-coin`**）                                                                                                                                                                                                                         |
| `jishianniudi.png` | 同名                                  | 倒计时钟（片③）—— ⚠️ **从未接槽，2026-10-12 已删除**（见下）                                                                                                                                                                                                              |
| `jujsidai.png`     | 同名                                  | 结算面板标题带（片③；**B5 已接槽**，2026-09-29 起走 9-slice）                                                                                                                                                                                                             |
| `setting.png`      | 同名                                  | 设置按钮（片② 起）—— ⚠️ **零引用，2026-10-12 已删除**（见下）                                                                                                                                                                                                             |
| `close_btn.png`    | 同名                                  | 关闭按钮（片② 起）                                                                                                                                                                                                                                                        |
| `default.png`      | 同名                                  | 头像兜底（片② 起）                                                                                                                                                                                                                                                        |
| `nongmin2.png`     | 同名                                  | 农民角色（片③ 备选）—— ⚠️ **零引用，2026-10-12 已删除**（见下）                                                                                                                                                                                                           |

> ⚠️ **2026-10-12 项 6 删除的 10 个零引用孤儿**（分包搬迁时核对引用后清理，删除经用户当面裁决「没有使用的资源，可以先删除掉」）：
> 音频 5 个：`audio/MusicEx_Exciting.mp3`、`MusicEx_Normal2.mp3`、`openinganimation.mp3`、
> `Woman_Order.mp3`、`Woman_buyao4.mp3`；
> UI 5 个：`ui/setting.png`、`ui/jishianniudi.png`、`ui/nongmin2.png`、`ui/btn3.png`、`ui/bottom-bar.png`
> （后者对应的 uni.scss 槽位 `$ftl-art-bottom-bar` 已置 `none`，art-slots 闸同步）。
> 源素材仍可从 `resources/` 重新选取；需要复活时按本文约定重新入库并接线。
>
> ⚠️ **2026-10-22 U5 恢复 `Woman_Order.mp3`**：协议⑦ 的 `BidDecision.kind` 区分叫/抢，
> 「叫地主」有真实调用点（`cueForBid('call', true, …)`），不再属于零引用孤儿。

> ⚠️ **`jishianniudi.png` 的孤儿状况（历史记录，2026-09-29 记 / 2026-10-12 了结）**：用户裁决**不接**该槽后，
> 它在 `src/` 里**不再被任何地方引用**（`uni.scss` 的 `$ftl-art-countdown` 已回 `none`）。
> 它在孤儿状态下保留过一段时间（「形状不匹配」的参考实例），**2026-10-12 项 6 已随孤儿清理删除**。
> 将来若要用它，须同时改容器适配并重新提交用户裁决
> （见 `docs/superpowers/specs/2026-09-21-ui-art-brief.md` §3.1）。

> ⚠️ **`btn1.png`（`ui/`）的孤儿状况（2026-09-29 如实记，同款规定）**：片③ 阶段 B 删掉三个
> 主按钮的贴图后（§5.2.1 逐字「**不带贴图**」），它在 `src/` 里的**唯一引用者**
> `$ftl-btn-plate-primary`（`uni.scss`）**零消费者**（令牌按「只加不改」的纪律保留待复用）
> ⇒ `btn1.png` 在页面上任何地方都不再出现。**没有任何闸会因此变红**（同上：孤儿检查只覆盖
> `static/cards/`）。文件**保留在库**；复用它 = 给 `$ftl-btn-plate-primary` 接回一个消费者
> （或换名交付、按本文 §4 的约定走）。

**字体不在授权范围内**：`Fonts/ice.ttf` 上游是字魂（ZiHun）商业字体，其 name 表逐字含
`Commercial use requires purchase authorization` ⇒ **本轮不采用**（R705），用系统字体。
要用它须先确认授权覆盖到字体，**另立一片**。

**未采用的 UI 素材**（`UI/` 里别的玩法 / 商城 / 设置界面，共 7 个 —— 划掉的 9 张 = 片① 已采用、见上表）：
`kuaisu_choose.png`(625KB) · `hlddz.00045.png`(381KB) · ~~`bg.png`(328KB)~~ · `Common_BG4_2x.png`(236KB，曾片③采用，2026-10-12 退役删除) ·
~~`setting.png`(146KB)~~ · ~~`jujsidai.png`~~ · ~~`jishianniudi.png`~~ · ~~`nongmin2.png`~~ · `huanledou.png` ·
`goods_BG2.png` · ~~`dou.png`~~ · ~~`default.png`~~ · `buy_btn_06.png` · ~~`close_btn.png`~~ ·
`quxiao_loding (2).png` · `public_bg.jpg` —— **MVP 界面用不到**。
其中 4 张另有实测理由（规格 §5.1）：`public_bg.jpg` 太暖太暗 · `huanledou.png` 是**财神插画不是货币图标** ·
`kuaisu_choose.png` **画了字**（违反「素材不画字」）· `hlddz.00045.png` 是草地插画。

> ⚠️ 实测订正（R704 的来由一处算法，仅作记录）：R704 说「`bg.png` 与其余 6 个并存 = 547KB 超 400KB 预算」——
> 该算法是**并存**。若**替换** `new_BJ` 为 `bg`，`ui/` = 369 KiB ≤ 400 KiB，**替换并不超**。
> 本轮按 R704 用 `new_BJ.png`，此条仅防止后人误以为 `bg.png` 因体积出局。

---

## 2. 版本库边界（R703）

| 路径                                                | 入库        | 理由                                           |
| --------------------------------------------------- | ----------- | ---------------------------------------------- |
| `resources/`（385 文件 / 16.70 MB）                 | ❌ **不进** | 源素材库。已在 `.gitignore`                    |
| `apps/client/src/static/`（主包）                   | ✅ **进**   | 启动/大厅即用的精选子集（见 §3）               |
| `apps/client/src/pages/table/static/`（table 分包） | ✅ **进**   | 进桌才用的牌面/头像/牌桌底纹/牌桌音效（见 §3） |

⚠️ **逐张白名单挑，不递归拷目录**：`resources/` 里 **225 个是引擎专有/边车文件**
（`.meta` 201 + `.prefab/.anim/.controller/.asset` 20 + `.xlsx/.txt/.jpg` 3 + `.ttf` 1），
占全量 **58%**。照目录拷贝会把它们一起搬进来。
实际可用的媒体只有 **160** 个（png 79 + ogg 78 + json 3），本片取其中一部分。

---

## 3. 覆盖范围与体积预算

**项 6（2026-10-12 小程序分包）后按归属包分两组**，路径以 `apps/client/src/` 为根：

| 目录（相对 src/）           | 归属           | 内容                                                                                                                                                                                                                                       | 文件数 | 实测                                          | 预算      |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------- | --------- |
| `pages/table/static/cards/` | **table 分包** | 54 张牌面 + `CardBack.png` + `manifest.json`                                                                                                                                                                                               | 55 + 1 | **437 KiB**                                   | ≤ 500 KiB |
| `pages/table/static/av/`    | **table 分包** | `Landlord.png` / `Farmer.png`                                                                                                                                                                                                              | 2      | **136 KiB**（2026-10-12 第二批 128×128 头像） | ≤ 160 KiB |
| `pages/table/static/ui/`    | **table 分包** | 牌桌底纹 `bg_table.png`（329 KiB）                                                                                                                                                                                                         | 1      | **329 KiB**                                   | ≤ 400 KiB |
| `pages/table/static/audio/` | **table 分包** | 63 条牌桌音效 + 牌桌/胜负 BGM（含 50 条牌型播报；见 §5）                                                                                                                                                                                   | 63     | **~829 KiB**                                  | ≤ 1024 KiB |
| `static/ui/`                | **主包**       | 大厅/通用 UI 共 16 张：`bg.png`、`logo.png`、`btn{1,2}.png`、`panel-{blue,orange}.png`、`dou.png`、`close_btn.png`、`default.png`、`jujsidai.png`、`countdown.png`、`count-tile{,-warn}.png`、`{avatar-ring,bid-badge,landlord-badge}.png` | 16     | **~574 KiB**                                  | ≤ 768 KiB |
| `static/audio/`             | **主包**       | **仅** `MusicEx_Welcome.mp3`（大厅 BGM）                                                                                                                                                                                                   | 1      | **~260 KiB**                                  | ≤ 320 KiB |

> 主包组直接关系微信 **2 MB 主包配额**，预算从紧；分包组随牌桌分包按需下载，沿用历史宽限。
> 2026-10-12 mp-weixin 发行构建实测：**主包 1,681 KB（1.64 MB）✅ < 2 MB**；
> 分包体积 table **1,369 KB** / history **25 KB** / wallet **36 KB**。
> 2026-10-22 牌型播报（U5）后 table 分包约 **1,690 KB**（+321 KB），仍 < 2 MB；
> 以 `asset-budget.test.ts` 的 1024 KiB 音频预算为准。

> `audio/` 的预算与 spec §6.2.4 的 800 KiB 不同 —— **用户裁决 U4**（2026-09-21），理由见 §5。

---

## 4. 命名约定（**契约**）

牌面文件名 = **`{Suit}{Rank}.png`**：

- `Suit` ∈ `Spade`(♠) `Heart`(♥) `Club`(♣) `Square`(♦)
- `Rank` ∈ `One`…`Ten` `Jack` `Queen` `King`
- ⚠️ **两个命名坑**（已把图渲染出来核实，不是推断）：
  **`Square` = ♦**（不是方块字面）、**`One` = A**（角标字母就是 `A`）。
  旁证：全部 Square 数字牌**纯红 0 黑**；中心花色 180° 旋转自相似度 Square=0.931 vs Heart=0.440。
- 王与牌背：`BigJoker.png` / `LittleJoker.png` / `CardBack.png`

**尺寸**（逐张解析 IHDR，非抽样）：**54 张面全部 80×104 px**、`CardBack` **66×88 px**。
⇒ 面/背比例 0.769 vs 0.750 **不一致**，差 2.6%。本片**统一用一个牌框**（按面的比例），
牌背 `mode="scaleToFill"` 承受这 2.6% 的纵向拉伸（肉眼不可辨）。

👉 **牌背的渲染方式**（2026-09-21 补）：`manifest.back` → `CardBack.png` 是**主视觉**，
由 `Card.vue` 的 `faceSrc` 在 `faceDown` 时返回；`.card--back` 的 CSS 斜纹是**加载失败时的兜底**
（图缺了自动透出来，不白屏）。⇒ **座位牌背扇 / 底牌位 / 任何 `face-down` 的牌共用这一份实现。**
判据：`card-hand-interaction.test.ts` 的「牌背渲染的是 `manifest.back`」+ 「CSS 纹样不得删除」。

### 换图的最省事路径

| 情形                   | 要做什么                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- |
| 沿用**同名**交付的新图 | **直接覆盖文件即可，`manifest.json` 都不用改**                                |
| **换名**交付           | **只改 `manifest.json`**（R702：表放 `.json` 就是为了这个，改名换图不碰代码） |

生成/重生成 `manifest.json`：`node scripts/gen-card-manifest.mjs`（一次性生成器，产物入库；输出到
**`src/pages/table/static/cards/manifest.json`** —— 项 6 后随牌桌分包，生成器已同步，重跑不会再造旧路径）。

### 静态资源的引用形态

两种绝对路径（**项 6 分包后**）：

- 主包：**`/static/<类>/<文件>`** —— 代码里走 `assetUrl('/static/…')`；
- 牌桌分包：**`/pages/table/static/<类>/<文件>`** —— 代码里走 `tableAsset('<类>/<文件>')`。

**机制**（读过 uni 源码 + 本仓实测）：uni 的 `uniCopyPlugin`
（`@dcloudio/vite-plugin-uni/dist/plugins/copy.js:13`）把 `UNI_INPUT_DIR`（= `apps/client/src`）下的
**`static/**/_`** 原样复制；分包页目录（`src/pages/<root>/`）下的 `static/\*\*/_`同样被复制，
落点保留`pages/<root>/static/…`前缀（即随分包走，mp-weixin 下计入分包体积而非主包）。
而 Vite 的`publicDir`被 uni 显式设成**不存在的**`static`
（`config/index.js:31`）⇒ `static/` **完全不走 Vite 的 asset 管线**（不哈希、不内联、不做路径改写）。

> ⚠️ **mp 跨包引用边界（登记，2026-10-13）**：主包页 `pages/game/game.vue` 的
> `<LandscapeStage backdrop="table">` 引用的是**牌桌分包**的
> `pages/table/static/ui/bg_table.png` —— 微信下分包下载前主包页取不到该图
> （透出兜底底色；进桌即随分包下载）。H5 无此边界（同源同根，直接可取）。
> 现状**接受、不修**（影响面限于「未进桌先看开始游戏页」的底纹观感）。

> ⚠️ **dev server 坑（2026-10-12 实测，曾导致牌桌全白）**：上面的拷贝只在**构建**时发生；
> `pnpm dev` 下 Vite 中间件**只伺服主包 `src/static/**`**，请求 `/pages/<root>/static/…`会被 SPA 回退成 index.html（HTTP 200 但 Content-Type 是 text/html —— **只看状态码会误判为正常**）。
修法是`vite.config.ts`的`ftl-subpackage-static-dev`插件：dev/preview 链上把`/pages/<root>/static/**` 直接映射回源文件出流（含路径穿越防护与 no-cache）。
> 判断资源是否真可用必须看 **Content-Type/字节数\*\*，不能只看 HTTP 200。

### Task 1 Step 4 的 spike 实测结果（2026-09-21；路径于 2026-10-12 项 6 更新）

| 检查                      | 命令                                                                                       | 实测结果                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| H5 发行产物里文件存在     | `ls apps/client/dist/build/h5/pages/table/static/cards/SpadeOne.png`                       | ✅ 存在，且与源**逐字节相同**（5016 B）                                                                                         |
| H5 发行产物里引用是字面量 | `grep -oh "/pages/table/static/cards/[A-Za-z]*\.png" dist/build/h5/assets/*.js`            | ✅ 命中 `/pages/table/static/cards/SpadeOne.png`，**未被哈希**                                                                  |
| 静态资源没被 Vite 接管    | `ls dist/build/h5/assets/ \| grep SpadeOne`                                                | ✅ 零命中（正确）                                                                                                               |
| dev server 伺服该路径     | `curl -o /dev/null -w '%{http_code}' localhost:5173/pages/table/static/cards/SpadeOne.png` | ✅ **HTTP 200 + image/png**，5016 B（与源一致；项 6 初版只看状态码漏判，后由 `ftl-subpackage-static-dev` 插件补齐，见上方告警） |
| App 产物里落地            | `find dist/build/app -name 'SpadeOne.png'`                                                 | ✅ 存在；`dist/build/app/pages/table/static/` 下随分包                                                                          |
| App 产物里的引用形态      | `grep -oh "/pages/table/static/cards/[A-Za-z]*\.png" dist/build/app`                       | ✅ 同一字面量                                                                                                                   |
| mp-weixin 进分包（项 6）  | `ls dist/build/mp-weixin/pages/table/static/cards/SpadeOne.png`                            | ✅ 存在；主包 1.64 MB < 2 MB                                                                                                    |
| 旧主包牌面路径已消失      | `ls dist/build/mp-weixin/static/cards`（H5 同查）                                          | ✅ 不存在（资源全部随 table 分包）                                                                                              |

**⚠️ 一条实测发现（CSS `url()` 会告警，模板字符串不会）**：

```
/static/ui/panel-blue.png referenced in ...Card.vue?...lang.scss didn't resolve at build time,
it will remain unchanged to be resolved at runtime
```

- **模板里**的 `:src="/static/..."`（JS 字符串）⇒ **无告警**；
- **CSS 里**的 `background-image: url('/static/...')` ⇒ **每次构建一条告警**。

两者**产物都正确**（Vite 的文档行为就是「保持原样、运行时解析」），告警**不是错误**、
不影响探针的 `error 级 console 为 0`（那条查的是**浏览器**控制台，不是构建输出）。
**已知代价**：Task 4/5 的 CSS 背景会各带一条构建告警 —— 属噪声，不是缺陷。

---

## 5. 音效（R698 + U4）

源：`resources/Sound/Fight/` 与 `resources/MusicEx/`，**ogg**。产物为 mp3，**项 6 后分两处**：
牌桌 63 条在 `pages/table/static/audio/`（分包），大厅 BGM 1 条在 `static/audio/MusicEx_Welcome.mp3`（主包）。
工具：系统 `ffmpeg`（**不进依赖**），脚本 `scripts/transcode-audio.mjs`（幂等，可反复重跑；
**直接写入上述两个目录**，并做孤儿检查与分目录预算；源根用 `AUDIO_SRC` 指定）。

### 为什么必须转码

**OGG/Vorbis 在 iOS WKWebView 上不能播** ⇒ 转 mp3 是**兼容性必需**，不是体积优化。

### 为什么预算不是 800 KiB（U4）

实测：**源 ogg 本身只有 65–72 kbps**（已经高度压缩）。因此：

| 转码档           | 全 5 条 BGM + 15 条 SFX  |
| ---------------- | ------------------------ |
| 源 ogg 原形      | 1476 KiB                 |
| mp3 **96k mono** | **1749 KiB**（反而变大） |
| mp3 64k mono     | 1360 KiB                 |
| mp3 **48k mono** | 1068 KiB                 |

spec §6.2.4 设的「转 mp3 后 ≤ 800KB」在保留全部 5 条 BGM 时**做不到**。
**用户裁决 U4（2026-09-21）**：能做的全做、预算适当放宽 ⇒ 定为
**BGM 64k mono / SFX 96k mono = 1456 KiB**（≈ 源 1476 KiB，**与源同质**），预算 **1536 KiB**。

**用户裁决 U5（2026-10-22）**：牌型播报 **50 条全量**接入（所有座位）。新增 49 条
（48 条播报 + `Woman_Order`）按 **64k mono** 转码（源本身 65–72 kbps）；牌桌音频预算
**640 → 1024 KiB**（实测约 829 KiB）。49 条总时长 38.4 s ≈ 307 KiB。

### 清单（U5 后：牌桌 63 条 + 主包 1 条）

| 事件            | 文件                           | 归属     | 备注                                                    |
| --------------- | ------------------------------ | -------- | ------------------------------------------------------- |
| 叫地主          | `Woman_Order`                  | 分包     | `kind='call'` + 抢；U5 恢复                             |
| 抢地主          | `Woman_Rob{1,2,3}`             | 分包     | `kind='rob'`；按座位取变体（确定性、可复现）            |
| 不叫 / 不抢     | `Woman_NoOrder`                | 分包     | 素材里没有「不抢」专用音；与参考实现 `notCallLandlord` 同源 |
| 过牌            | `Woman_buyao{1,2,3}`           | 分包     | 3 座位各一条（原储备 `Woman_buyao4` 已删）              |
| 报单（剩 1 张） | `Woman_baojing1`               | 分包     | §6.5-2；参考实现的 `singleReport`                       |
| 报双（剩 2 张） | `Woman_baojing2`               | 分包     | §6.5-2；参考实现的 `pairReport`                         |
| 牌型播报（50）  | 单张 `Woman_{3..15,100,200}` · 对子 `Woman_dui{3..15}` · 三张 `Woman_tuple{3..15}` · 具名 `shunzi/liandui/feiji/sandaiyi/sandaiyidui/sidaier/sidailiangdui/zhadan/wangzha` | 分包 | U5-2；客户端 `parseHand` 选音，只用于播报 |
| 胜利 / 失败     | `MusicEx_Win` / `MusicEx_Lose` | 分包     | 在 `Sound/Fight/` 里                                    |
| BGM 牌桌        | `MusicEx_Normal`               | 分包     |                                                         |
| BGM 大厅        | `MusicEx_Welcome`              | **主包** | 启动/大厅即播，必须随主包                               |

> 已删除的零引用音频（2026-10-12）：`Woman_Order`（**2026-10-22 U5 已恢复**）、
> `Woman_buyao4`（只有 3 个座位）、`MusicEx_Normal2` / `MusicEx_Exciting` / `openinganimation`
> （U4「全做」时期的储备 BGM，始终零引用）。需要时从 `resources/` 重新转码入库即可。

### 明确不做

| 项                                                                                        | 处置                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| 发牌 / 结算 / 春天 / 倒计时紧迫                                                           | 素材里**确实没有**                           |
| `Woman_jiabei`（加倍）· `Woman_bujiabei`（不加倍）· `Woman_Share` · `Sound/Chat/Chat_1–7` | **存在但不用**（我方规则无加倍；本片无聊天） |

> **牌型播报（U5-2，2026-10-22 已全量接入）**：50 条 = 单牌 15 + 对子 13 + 三张 13 +
> 具名牌型 9。触发由客户端 `parseHand` 选音（只做播报，不判合法性 / 胜负）。
> `Woman_100` / `Woman_200`（大小王单张）是这 50 条里最早接入的两条。

### 播放纪律

- **`uni.xxx()` 必须是直接成员调用**（`no.uni-api-access` 闸）；已实测
  `createInnerAudioContext` **确实在 `@dcloudio/uni-h5` 的导出名录里**（`uni-h5.es.js:24677`）
  ⇒ H5 发行构建的注入改写对它有效，不属于「dev 正常、发行版静默失效」那一类。
- **播放失败必须静默**：`InnerAudioContext.play()` 返回 Promise，**无用户手势时会被拒**。
  探针有两条零容忍断言（`Runtime.exceptionThrown 为 0` / `error 级 console 为 0`）
  ⇒ `play()` 的拒绝**必须**被吞掉。
- **cue 等 `onCanplay` 再 play**（U5-3）：新播报会打断上一条；若在媒体就绪前起播，
  `stop()` 内部的 `pause()` 会以 `AbortError` 拒掉尚未 settle 的 `play()`（uni 丢弃该 promise）。
  `playCalled && !started` 的 cue 只标 `abandoned`，由 `onPlay` / `onError` 收尾。
- **单通道、最新优先**：新 cue 停掉当前 cue；BGM 有独立生命周期，不受打断影响。
  离桌时 `stopCues()` 与 `stopBgm()` 都要调。
- **音效不得进入判据路径**：探针不验证声音；单测验证的是「该响时用正确的 src 调了播放」，
  不是「真的听见了」。
