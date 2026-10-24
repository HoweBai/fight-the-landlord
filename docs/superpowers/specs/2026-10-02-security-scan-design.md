# 安全扫描进 CI（M0.1）（**设计层 v1.2.2 · 定稿**）

> **状态**：v1.2.2 —— **定稿本**。已过**五轮**独立审查：R1（事实核验）→ R2（完整性与可执行性）→ **R3 修复验证（0🔴0🟠）** → R4 规格审查连带订正 3 处 → **R5 规格修复验证连带同步 7 处（附录 A #21：数字 12→15 / +22→+25 / path `$` / D7-A6 句）**。两审查者的 `ignoreCves` 支持性冲突经**本席 A/B 实验裁决**（支持），R3 独立复跑吻合。审查报告在 `.superpowers/sdd/2026-10-02-security-scan/`（工作区工件不入库）。**设计层定稿**；规格层 = `docs/superpowers/specs/2026-10-02-security-scan-spec.md` **v3 定稿**。
> **分层**：本文 = 设计层（方案与取舍）；形式化层另起 `docs/superpowers/specs/2026-10-02-security-scan-spec.md`。
> **来源**：路线图 `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` 的 M0.1 + 本会话用户裁决（§1.1）+ 本机实测取证（§2，全部带命令与读数；原始产物在 SDD 工作区）。
> **本片不做**：ZAP 渗透 · trivy 镜像扫描 · 周期触发（schedule）· dependency-review · 存量 moderate/low 与 dev-only ≥high（§7 逐条登记）。

---

## 0. 一句话

把「安全扫描」接进 CI（**不新建工作流**）：`ci.yml` 加第三个 job **`security-scan`**——依赖漏洞（`check-audit.mjs` 门脚本）· 密钥泄露（`gitleaks` 全历史）· 配置误配（`trivy config`）三路**全阻断**；并按用户裁决**先把存量修到 high 全绿再开门**：修复批 = **Nest 10→11 全家族升级（逐包显式 `@^11`）** + **一组 `pnpm.overrides`**（后端运行面 + 客户端 uni 工具链面），全仓唯一一条「修它就会砸掉客户端构建」的 vite high 通告（1123525）**带理由登记豁免 + 复查触发**。全绿即断言——**不用存量基线文件**，只有**单条例外**的机器可读登记。

---

## 1. 输入

### 1.1 用户裁决（逐条，本设计不得与之冲突）

| # | 问题 | 裁决 | 来源 |
|---|---|---|---|
| 1 | 存量 vs 新增策略 | **先全修到 high 再开门**（不用「基线冻结、只拦新增」换即日开门；`--prod` 面 46 high + 1 critical 全部修复清零，**唯一例外** = 裁决 3 的单条豁免） | 本会话 |
| 2 | Trivy 范围 | **只 config 扫描**进 `ci.yml`；**镜像扫描后置**登记（它要 images.yml + 拉 8 镜像 + 自己的存量策略，且路线图指定落点「ci.yml 的 job」里没有 docker） | 本会话 |
| 3 | vite 残余 1 条 high | 升 **5.4.21**（清 **12/15**），残余 1123525 **带理由登记豁免 + 复查触发**（v1.1 按审查 R5/R1-F2F3 换为决定性证据 `vite-plugin-uni` 精确 peer）；不硬闯 6.4.3 | 本会话（设计呈报 ①②③ 已获放行） |

### 1.2 既有约束（本仓纪律，逐条适用）

- **工作流文件集合被钉死为恰好四个**（`tools/conformance/src/slices/slice-07.4-pipeline.ts:32` 的 `EXPECTED_FILES`）⇒ 扫描必须进**现有** `ci.yml`，不得新建 workflow 文件（新建须同提交改闸 + baselines——本片不走这条路）。
- **`run:` 体禁插 `${{ … }}`**（同文件 I1 断言，`:772-801`）⇒ 新步骤一律字面量或经 `env:`。
- **M9 镜像前缀闸**（同文件 `:44-46`、`:723-770`）：四个工作流里**任何** `ghcr.io/…` 字面量都必须指向本仓前缀 ⇒ 扫描器**不得**以 `ghcr.io/…` 字面量出现（R1-D3 合成试打：`ghcr.io/aquasecurity/trivy-action@…`、注释里的 ghcr 路径全部会被判 offender；Docker Hub 名 `aquasec/trivy` 或钉版二进制不触发）。
- **六阶段单真源** = `scripts/ci.sh`（`docs/design.md:1619-1622`）；`ci.yml` 只做薄调用——新 job 与六阶段**并列**，理由与 `render-gate` 同（`docs/design.md:1656`）。
- **判据只增不减**；`baselines.json` 只按 **CI 实测**回填；每次改动一个 commit（CLAUDE.md）。
- **手册的「预期输出」是判据的一部分**（片②血训）：凡改动会让手册里写死的读数失效的必须同改（本片清单见 §5.1，关键一处 = `first-deploy.md:723-724`）。
- **CI 成本控制**（R1314）：新 job 与既有 job **并行**、不拉 docker 镜像（除扫描器自身由 action/二进制自带）、不打 tag 不触发发布。

---

## 2. 现状（本机实测事实，全部带读数与产物）

### 2.1 `pnpm audit`：读数、端点、退出码、故障形态、工作方式

| 事实 | 读数 / 证据 |
|---|---|
| **计数口径（全文统一）** | pnpm 汇总行按**实例**（finding）计数；**去重通告**按 advisory 计。全量：汇总 158（18 low/82 mod/55 high/3 crit）= 去重 **133**（14/64/53/2）；`--prod`：汇总 113（8/58/46/1）= 去重 **112**（8/57/46/1）；`--prod` 的 `findings[].paths` 合计 1839（这才叫路径计数）。**门与门槛一律按去重通告**——产物 `audit-full.json` / `audit-prod.json` |
| dev-only 增量 | 全量 − `--prod` 差集 = 21 条；其中 **≥high 8 条（7 high + 1 critical：vitest id 1139528）**，名单：path-to-regexp ×2、glob、picomatch、tmp、vitest、brace-expansion ×2（6 包）⇒ 不在本片门槛面（§7-5） |
| **镜像站点无 audit 端点** | `.npmrc` 为 `registry=https://registry.npmmirror.com`；`pnpm audit` 直跑报 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`（实测）⇒ 审计步骤**必须显式** `--registry https://registry.npmjs.org` |
| **注册表故障形态（v1.1 关键订正）** | 不禁 `--ignore-registry-errors` 时，注册表故障（拒连/假 500/端点不存在）= **EXIT 1 + stdout 合法 JSON `{"error":{…}}`**——天真解析（`j.advisories ?? {}`）会**静默全绿**；启用该旗标 = EXIT 0 + 非 JSON 纯文本。⇒ **响亮度必须由「输出形状断言」承载**，不是「禁用旗标」（R2-R2 实测三形态；产物 `probe-registry500-*.txt`）。⚠️ exit code 无法区分「有漏洞(1)」与「注册表故障(1)」——**stdout 形状是唯一权威** |
| **`pnpm.auditConfig.ignoreCves` 在本仓 pnpm（9.15.0）实测生效（v1.1 订正）** | 本席裁决性实验（4 变体）：NONE=112 通告/47 high·crit/1123525 在；`ignoreCves:["CVE-2026-53571"]`=**111/46/1123525 消失**；GHSA 串与数字 id 形态**无效果**；顶层 `muted` 恒 `[]`（**静音无痕**）。⇒ 这是一个**一行配置即可废掉整套门**的静默通道，必须被闸拦住（D7-A10） |
| 退出码零端 | 合成空工作区（`tmp-synth/`）⇒ `No known vulnerabilities found` + EXIT 0（R1-E4 自证） |
| **无需 install** | 复制 lockfile + 各清单到**无 node_modules** 的空目录照常出全量读数（R1-E2/R2-C1 双重复现：112 去重/113 实例/662KB JSON）⇒ CI 步骤不需要 `pnpm install` |
| `--ignore-registry-errors` 存在 | `pnpm audit --help`：让注册表故障以 EXIT 0 收场 ⇒ **禁用**（防御纵深；响亮度另由形状断言承载） |

### 2.2 修复面：13 个包、47 条 high/critical 的**精确命中路径**（全部来自 `audit-prod.json`，R1-B1 逐条重算相符）

**后端运行面**：

| 包（条数） | 中招拷贝 | 命中链 | 修补下界 |
|---|---|---|---|
| `@nestjs/microservices` (2) | 10.4.22 | **声明面**：6 个服务的 `package.json` 直依赖 `^10.4.0`（api-gateway:17 / config:20 / game:16 / robot:16 / room:19 / user:20）；首条路径 = `api-gateway > @nestjs/core@10.4.22 > @nestjs/microservices@10.4.22` | ≥11.2.4（**只在 11 线**） |
| `multer` (6) | 2.0.2 | platform-express@10.4.22 传递 | ≥2.3.0 |
| `axios` (12) | **1.2.1** | room-service > @nestjs-modules/ioredis@1.2.4 > @nestjs/terminus@10.2.0 > @nestjs/axios@1.0.1 | ≥1.16.0（high 中最高；moderate 到 1.20.0 不在门槛面） |
| `tar` (9，**含唯一 critical 1123940**（GHSA-23hp-3jrh-7fpw），floor ≥7.5.19；high 中最高 floor ≥7.5.21) | 6.2.1 | **两条链都真**：①devDep 漏面 `user-service > @nestjs/typeorm > typeorm@0.3.31 > sqlite3@5.1.7（devDependencies，经 optional peer 漏进 --prod 面）> tar@6.2.1`（另一条路径含 node-gyp@8.4.1）；②**生产链** `user-service > bcrypt@5.1.1 > @mapbox/node-pre-gyp@1.0.11 > tar@6.2.1`（bcrypt 是 `dependencies`）⇒「只在 devDep 漏面」不成立（R2-R8 订正） | ≥7.5.21 |
| `lodash` (1) | 4.17.21 | room-service > **@nestjs/config@1.2.1**（古董版） | ≥4.18.0 |
| `brace-expansion` (4) | 1.1.18 / 2.1.4 | typeorm > glob@7 / glob@10 > minimatch | ≥1.1.20 / ≥2.1.6 |

**客户端工具链面**（`apps/client` 的 uni-app alpha 工具链，声明在 `dependencies` ⇒ 落进 `--prod` 面）：

| 包（条数） | 中招拷贝 | 命中链 | 修补下界 |
|---|---|---|---|
| `adm-zip` (5) | 0.5.16 | @dcloudio/uni-cli-shared（其 deps 为**精确钉**） | ≥0.6.1 |
| `jpeg-js` (1) | 0.3.7 | @dcloudio/uni-mp-weixin > jimp@0.10.3 > @jimp/jpeg | ≥0.4.4 |
| `ws` (1) | 8.18.0 | @dcloudio/uni-mp-weixin（精确钉 8.18.0） | ≥8.21.0 |
| `postcss` (2) | 8.5.6 | @dcloudio/uni-nvue-styler | ≥8.5.18 |
| `@intlify/core-base`·`message-resolver` (2) | 9.1.9 | @dcloudio/uni-cli-shared（精确钉 9.1.9） | ≥9.1.11 |
| `vite` (**2 high**) | 5.2.8 | uni-h5-vite > @vitejs/plugin-basic-ssl@1.2.0 > vite@5.2.8 | ① 1120061：≥5.4.9 ② 1123525：≥6.4.3（见 §2.4） |

**⚠️ 审计面 ≠ 运行面（订正后的完整叙事）**：① `sqlite3` 是 user-service 的 **devDependencies**（`packages/user-service/package.json:44`），经 typeorm 的 optional peer 解析漏进 `--prod` 面；② 客户端整条 uni 工具链是**构建期**依赖（产出的 H5 是自包含静态物），但声明位在 `dependencies`；③ **但 tar 的 critical 同时经 bcrypt 的生产依赖链真实可达**（上面两条链）——「漏面」只解释了它为什么会出现在审计读数里，不构成「无害」理由。⇒ 本片照旧**全修**（用户裁决面），门槛面语义（是否收窄）登记在 §5.2，本片不动。

### 2.3 `gitleaks`：全历史 3 条，全是非真密钥

- 读数（探针）：**968 commits / 13.25 MB / 24.9s / 3 leaks**（`zricethezav/gitleaks:latest` 镜像，**未钉版**；产物 `gitleaks.json` + `gitleaks-stdout.txt`）。⚠️ 口径脚注：968 = 工具自报扫描提交数；仓库总提交 1011（扫描时点）——gitleaks 跳过合并提交，另有个位数口径差未深究（R1-C2）；**钉版首跑的全量读数为准**（D8）。
- 三条明细（R1-C3 逐行核过）：① `packages/shared/src/logging/redact.test.ts:53` —— **测试夹具**假 JWT（`token=eyJ…abcdefghijk`，日志脱敏用例样本）；②+③ `docs/superpowers/plans/deviation-ledger.md:171`（现文件里已漂到 :359）与 `docs/superpowers/plans/2026-09-14-slice-07.2-p1-internal-token.md:436` —— 同一枚 **dev 占位 token**（文档里的 curl 示例）。行号漂移实况 = D3 选「路径/regex 允许项」而非「指纹基线」的直接理由。
- dev 占位 token 的暴露面已实证：生产 compose 对它 **无默认值**（`docker-compose.yml:160/:222/:294/:340/:381/:465` 六处 `INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}`，首行注释明写「没有默认值 —— 未配置 ⇒ 容器内为空」）；默认值只活在 dev override（6 处）/工具（conformance、verify-dod.sh）/文档/**测试夹具**（`redact.test.ts:17`）⇒ **无需轮换**，可登记豁免。

### 2.4 `vite` 不可修残余的精确边界（v1.1 订正计数与证据链）

- vite 去重通告 **15 条**（R1-A4/R2-R5 双重复算）：**12 条**修补下界 ≤ `5.4.21`（9 moderate + 2 low + **1 high = 1120061**，floor 5.4.9）；**3 条**下界在 6.4.x：`1116229`(moderate,→6.4.2) · `1120784`(moderate,→6.4.3) · `1123525`(**high**,→6.4.3，GHSA-fx2h-pf6j-xcff)。
- 跨 6 **不可行**的决定性证据（v1.1 更换）：**`@dcloudio/vite-plugin-uni` 的 `peerDependencies = { vite: "5.2.8" }` 精确钉死**——在用版（50206…）与**最新 alpha**（50301…20260930）**双双如此**（R1-F3/R2-R5 实测）。辅证：`apps/client/package.json:42` 也精确钉 `"vite": "5.2.8"`。⚠️ 订正：`@vitejs/plugin-vue@5.2.4` 与 `@vitejs/plugin-basic-ssl@1.2.0` 的 peer 分别为 `^5||^6` 与 `^3||^4||^5||^6`——**不锁 vite6**，v1 里「（v5 系）」的注解作废；最新 alpha 仍带 basic-ssl 1.2.0 只作「上游未动」信号。
- `1123525` 的影响面是 **vite dev server 的 `server.fs.deny` 绕过（Windows 旁路）**——玩家/生产永不可达（R1-F4 逐字核）。

### 2.5 trivy、账户、工具链杂项（v1.1 订正 trivy 叙事）

| 事实 | 证据 |
|---|---|
| trivy 本机取不到初始读数（**订正版叙事**） | 检验束下载**成功**（234.65 KiB / 1.6s，非卡点）；首次 `aquasec/trivy config` 在 dockerfile 分析步挂死，**20m25s 后工具自身内置 `context deadline exceeded` 退出**；二次尝试在 ansible 步 walk 报错（`test-results/gitleaks.json` 不存在）快速失败。⇒ 本机两次均取不到读数，**初始读数改在 CI 首跑取**（GitHub runner 可达检验束源） |
| 候选钉版（实现期取 sha256） | gitleaks latest = **v8.30.1**（2026-03-21）；trivy latest = **v0.75.0**（2026-10-01）（R2 §1.5 api.github.com 探针） |
| 仓库 private + 账户为个人 | `gh api`：`repos/HoweBai/fight-the-landlord` → `private=true`；`users/HoweBai` → `type=User` ⇒ **dependency-review-action 需 GHAS（付费）不可用**；本片改用钉版二进制（D3 理由），不依赖 gitleaks-action 许可 |
| 仓库体量 | 扫描时点 1011 commits（gitleaks 全历史 25s ⇒ CI 里可承受） |
| 六阶段里客户端会被真实构建 | `scripts/ci.sh:89-92` 阶段 3/6 = `turbo run build --force`（无 `--filter`）⇒ 全工作区含 `apps/client` 的 `"build": "vue-tsc --noEmit && uni build"` ⇒ **uni 工具链 overrides 的兼容性在每次门禁里被检验（限 H5 链，见 N3）** |
| 现有 workflow job 面 | `ci.yml` 两个 job（`ci`·`render-gate`）；`slice-07.4-pipeline` 只钉了「`render-gate` 必须存在」（`:492-496`），**未钉 job 集合恰好**（新 job 不会误伤既有闸；但本片要**主动加闸**，见 D7） |
| 陈旧嵌套 lockfile（R2-N5） | `packages/robot-service/pnpm-lock.yaml` 与 `packages/room-service/pnpm-lock.yaml` 是**被跟踪**的独立 lockfile（**119,497 B** / 约 27 KB、mtime 2026-09-20），**无任何消费方**（7 个 Dockerfile 都 `COPY` 根锁；无 `--dir/--prefix` 引用）⇒ 处置见 D5-A9 |

---

## 3. 设计决策

### D1 — 落点：`ci.yml` 第三个 job `security-scan`（并行、无 needs、not 六阶段）

- **job 名** `security-scan`；与 `ci`、`render-gate` **并行**（互不依赖——三个扫描器都不需 docker、不需真栈）。
- **步骤序列**（全部 `ubuntu-latest`）：
  1. `actions/checkout@v4` —— **`with: fetch-depth: 0`**（gitleaks 全历史必需）；
  2. `pnpm/action-setup@v4` + `actions/setup-node@v4`（`node-version: 20`、`cache: pnpm`）——**只是为了让 `pnpm` 可用**（audit 不需要 install，§2.1）；
  3. 依赖漏洞（`node scripts/security/check-audit.mjs`，D2）；
  4. **门脚本行为自证**（`node scripts/security/check-audit.mjs --self-test`，不触网）——成例 = `ci.yml:66` 的 `check-baselines.mjs --self-test`（R2-R4：行为自证必须有自动调用点）；
  5. 密钥泄露（gitleaks，D3）；
  6. 配置误配（trivy config，D4）。
- **权限**：不加 `permissions:` 块（默认只读即可；不上传 SARIF、不写 PR 评论——本仓无 code-scanning 额度诉求，退出码即闸）。
- **为什么不是六阶段之一**：六阶段真源在 `scripts/ci.sh`、按规格 §13.4 逐字六项；塞进去会让「六阶段」不再是规格里那张表（与 `render-gate` 同理由，`docs/design.md:1656` 是既有先例）。
- **为什么不加 `schedule:`**：`on` 集合被钉为恰好 `{push, pull_request}`（`:488-491`）；本仓开发节奏下 push 触发已近似每日覆盖；周期扫描与告警通道属**监控片**（原 M0.2，2026-10-03 裁决不做最小形态、并入真监控系统片）的观察面，本片不预支（§7-3）。

### D2 — 依赖漏洞：`scripts/security/check-audit.mjs`（**小脚本 = 门**，形状抄 `check-baselines.mjs` 成例）

- **为什么不是裸命令**：§D6 有一条**登记豁免**的 high（vite/1123525）⇒ 裸 `pnpm audit --audit-level high` 会**永久红**（与「全绿即断言」和 D8 收口冲突）。⇒ 门的形态 = **约百行的小脚本**：调用 `pnpm audit --prod --json --registry https://registry.npmjs.org`，自己按「critical+high 必须清零（豁免集除外）」判定；`--self-test` 内建合成输入自证（R115）。它与 `scripts/check-baselines.mjs` 同族：解析 → 纯函数给违例清单 → CI 里作独立一步。
- **单一真源五要素**（写死在脚本里、被闸断言，D7-A3）：
  - `--prod`（面 = 各工作区 manifest 的 `dependencies` 可达集）；
  - `--registry https://registry.npmjs.org`（§2.1 实测）；
  - **禁** `--ignore-registry-errors`（**防御纵深**；响亮度由下面这条承载）；
  - **输出形状断言（fail-closed，v1.1 新增——响亮度真正的承载者）**：`JSON.parse` 失败 ⇒ 红；`j.error` 存在 ⇒ 红；`!j.advisories || !j.metadata?.vulnerabilities` ⇒ 红（§2.1 三形态实测）；**exit code 不作判据**（1 无法区分漏洞与故障）；
  - **等级集合逐字 `['critical','high']`**（**含引号与次序**的字面量，被闸以「恰好」形态断言——把 high 从集合里拿掉 = D6 豁免被误用成「整级放行」，这是本设计点名的**最像正确答案的那个错**；v1 的「文本子串」断言可绕，R2-R4 订正）。
- **豁免机制**（唯一的、带审计字段的）：`scripts/security/audit-exceptions.json`，**当前恰好 1 条**（vite/1123525），每条四字段：`id`（**数字**，= audit JSON 的 `id` 字段；⚠️ GHSA 串只作可选展示字段、**不参与匹配**——R1-A6：「GHSA-<数字>」是拼接串，注册表不存在；真实串 = `GHSA-fx2h-pf6j-xcff`）· `module` · `reason` · `reviewTrigger`。匹配语义 = **（id, module）精确对**（R2-C3：防「按 module 泛化、放掉同包其他通告」）。判定 = 「critical+high 通告集 − 豁免集 ⇒ 必须为空」+「豁免集里**失效**的条目（通告已不再被报出）⇒ 必须删掉（陈腐条目 = 红）」——与 `baselines.json` 的「实测回填、只减不增」同族纪律。⚠️ 它不是「存量基线」（存量在禁列、要修），是**单条登记的例外**。
- **静默静音面的封禁**（v1.1 新增，R2-R3 + 本席实验）：`pnpm.auditConfig.ignoreCves` 在 9.15.0 **实测生效**（§2.1），一行配置即可静音且无痕 ⇒ **禁止出现在本仓**：conformance 断言 root `package.json` 不含 `auditConfig`/`ignoreCves`/`ignoreGhsas`（D7-A10）；门脚本自身只读 root 清单、不注入任何 audit 配置。
- **`--self-test` 的负/正对照**（合成通告集过同一谓词，R2-R4 + C3）：负① `{"error":{…}}` 形态 ⇒ 红（注册表故障语义）；负② 多一条未登记 high ⇒ 红；负③ 豁免条目陈腐 ⇒ 红；负④ 等级集合缩水后新 high 未被拦 ⇒ 红（行为面）；负⑤ 豁免按 module 泛化（同 module 另一 id 企图被放）⇒ 红；正① 通告集只剩豁免条目 ⇒ 判齐。
- **`--prod` 的定义与两个语义洞**：含 uni 工具链（构建期）与 sqlite3（devDecl 经 optional peer 漏入）两个非运行面带（§2.2 尾注，含 bcrypt 生产链订正）。本片照旧把该面修绿；**门槛面语义**（是否收窄）登记在 §5.2，本片不动。

### D3 — 密钥泄露：gitleaks 全历史 + 入库允许清单（逐条带理由）

- **取件方式**：**钉版二进制 + sha256 校验**（候选 v8.30.1，§2.5；不用 action 的理由：a) action 的扫描范围语义随事件类型变化，**确定性差**；b) 许可语义是外部状态，二进制钉版消除该面；c) 版本 + 校验和写死在 `ci.yml`，与 M9/I1 闸同风格可静态断言）。
- **运行命令**（实现期钉死版本与校验和）：
  `gitleaks detect --source . --config .gitleaks.toml --redact --no-banner -v`
  （⚠️ 实现期自证：8.19+ 主命令为 `git`、`detect` 为兼容路径——以钉版 `--help` 为准；`--redact` 必须保留=防真 finding 泄入 CI 日志，被闸断言。）
- **`.gitleaks.toml`（新增入库）**：`[extend] useDefault = true` + 两条**逐条带理由**的允许项：
  - ① `paths = ['packages/shared/src/logging/redact\.test\.ts$']`——日志脱敏用例的**测试夹具 JWT**（非真密钥，无泄露面；**`$` 锚定为 R4-🟠2/R5 订正后形态**）；
  - ② `regexTarget = 'match'`，`regexes = ['dev-internal-token-change-in-production']`——dev **占位** token 字面量（生产 compose 无默认值，§2.3）。
  - **内容断言**（D7-A6，防「允许清单写宽」整族）：`useDefault = true`；`[[allowlists]]` **恰好 2 条**；path 条目锚定到具体文件；regex 条目非空且不含 `.*` 通配。
- **为什么不是 gitleaks 基线文件**：基线指纹含 commit+文件+行，**任何行号漂移就让条目失配**（§2.3 实证：deviation-ledger 已漂 188 行）；路径/regex 允许项是声明式的、可 review、写进配置即被闸看着。
- **增量 vs 全历史**：**全历史**——全量扫描使「历史里删除过的 secret」永远可见；允许清单是**白名单式**，不产生随行号漂移的存量。⚠️ 钉版首跑的全量读数**回填豁免与结论**（D8#6；探针读数 = :latest 未钉版，§2.3 脚注）。

### D4 — 配置误配：`trivy config` + `.trivyignore`（带理由）处置规则

- **取件方式**：钉版二进制 + sha256（候选 v0.75.0，§2.5；理由同 D3）。
- **命令**（钉死形态）：
  `trivy config --severity HIGH,CRITICAL --exit-code 1 --ignorefile .trivyignore .`
- **扫描面**：根 `Dockerfile.*`（**7 个**）+ `douzero/Dockerfile` + 全仓 compose（`docker-compose.yml` / `docker-compose.override.yml` / **`douzero/docker-compose.douzero.yml`**）+ `deploy/` 下的 Caddyfile【trivy 不识别 Caddyfile，不产生判据——工具行为待 CI 首跑印证】——以 `trivy config .` 实际覆盖为准（R1-J4 订正：v1 漏了 douzero 两文件）。
- **初始读数 = CI 首跑取**（§2.5 订正版叙事）。
- **处置规则（写死，不给「静默 ignore」留口）**：首跑读数分两桶——**能修则修**（如 DS 系列 root/健康检查类，改 Dockerfile 属本片范围）；**确需豁免 ⇒ `.trivyignore` 逐 ID 一行 + 行内理由注释**（该文件同一提交入库）。若首跑读数全为零 ⇒ `.trivyignore` 仍入库（只含政策头注释），文件即是登记点。
- **形状断言**（D7-A7）：`--severity HIGH,CRITICAL`、`--exit-code 1`、`--ignorefile .trivyignore` 逐字在 run 体内；`.trivyignore` 非注释行匹配 `^[A-Z]+-[0-9]+$`（禁 `*`/空行形态）。

### D5 — 修复批（用户裁决面：47 条 high/critical → 0）

**A. 后端运行面**：

| # | 动作（v1.1 逐包矩阵钉死——`latest` 已指 12 线，**一律显式 `@^11`、禁 `@latest`/裸包名**） | 清掉 | 验证 |
|---|---|---|---|
| A1 | **Nest 11 家族**（**声明位逐一**——R4 订正：`common`/`core`/`platform-express`/`microservices`/`testing`/`cli` = 6 服务·devDeps 含 testing/cli；`platform-socket.io` **仅 room**；`websockets` = **gateway + room**；`jwt` = gateway/user/config；`passport` = gateway/user；`typeorm` = user/config）：版本逐一 `common`/`core`/`platform-express`/`platform-socket.io`/`websockets` `^11.2.7` · `microservices` `^11.2.6` · `testing` `^11.2.6` · `jwt` `^11.0.2` · `passport` `^11.0.5` · `typeorm` `^11.0.3` · `cli` `^11.0.24`（jwt/passport/typeorm/cli **连 legacy tag 都没有**，不带 `@^11` 就吃 12——R2-R1） | `@nestjs/microservices` ×2 | 六阶段阶段 3/4 + **全序 conformance** |
| A2 | `@nestjs/config`（唯一消费者 room-service）`^1.2.1` → **`^12.0.1`**（12.0.1 与 4.0.4 皆清 lodash；取当前线；`12.0.1` 的 deps 已无 lodash） | `lodash` ×1 | 同上 |
| A3 | `@nestjs/axios`（room-service，代码面真 import `HttpModule`，`rooms.module.ts:2`）`^1.0.1` → **`^4.0.1`**（其 peer `^10||^11`；1.0.1 的 peer 只到 Nest 9，Nest 11 下不合法） | axios 链的上游 | 同上 |
| A4 | `@nestjs-modules/ioredis` `^1.2.4` → **`^2.2.2`**（**预演结论：不触发「停下上报」**——R2 实测存在、peer `>=6.7.0`、deps 空；换掉后 `terminus→axios@1.0.1` 旧链整体消失） | —（载体的载体） | room-service 启动 + 健康面 |
| A5 | `@nestjs/terminus`：**幽灵动作删除**（全仓代码面 0 import，仅经 ioredis@1.2.4 传递；A4 落地后自然消失——v1 把它列为「同步升级」是幽灵动作，R2-R6 订正） | — | — |
| A6 | `pnpm.overrides`：`axios@^1.16.0` | ×12 | room-service 健康检查/外部调用面 |
| A7 | `sqlite3` 升 `^6`（user-service devDep，与 root `^6.0.1` 对齐；6.0.1 的 tar 依赖已是 `^7.5.10` 线）+ `pnpm.overrides` `tar@^7.5.22`（**兜底 + bcrypt 生产链的正解**） | `tar` ×9（含 **critical**）、`brace-expansion` 1.x 链、node-gyp8 链 | 六阶段阶段 4 + **门脚本 audit 面 tar 归零**（R2-R8 验证口径） |
| A8 | `pnpm.overrides`：`brace-expansion@^1.1.20`（1.x 线兜底）与 `^2.1.6`（2.x 线，typeorm>glob@10 链） | ×4 | typeorm 启动/迁移测试 |
| A9 | 全部 overrides **写在一个处**（root `package.json` 的 `pnpm.overrides`）+ lockfile 重建；**顺带**：删除陈旧嵌套 lockfile `packages/robot-service/pnpm-lock.yaml`、`packages/room-service/pnpm-lock.yaml`（§2.5 末行：被跟踪、无消费方；前提 = 实现期复核无引用；`git log` 留痕） | — | `pnpm install --frozen-lockfile` 在 CI 通过 |
| A10 | **multer 随动**：iff platform-express ≥ **11.2.6**（今天解析到 11.2.7 带 multer 2.4.0 ⇒ 随动成立、无需 override）；**spec 写死该下限**（R2 §1.3：11.2.0–11.2.5 带 2.2.0 仍中招） | multer ×6 | 同上 |

> ⚠️ 矩阵脚注（R3-🟡4）：`microservices`/`testing` 的 11.2.6 系**镜像口径**读数（npmjs 已 11.2.7）——`^` 范围会解析到该线最新，对下界无影响；实现期以**实际解析**为准。

**B. 客户端工具链面**（overrides；兼容性由六阶段阶段 3 的 `uni build` 自动检验——**限 H5 链**，见 §7 注）：

| # | 动作 | 清掉 |
|---|---|---|
| B1 | `pnpm.overrides`：`adm-zip@^0.6.1` · `jpeg-js@^0.4.4` · `ws@^8.21.3` · `postcss@^8.5.18` · `@intlify/core-base@9.1.11` · `@intlify/message-resolver@9.1.11`（intlify 两包**精确钉 9.1.11** 保持族内一致——R2-N2；`jpeg-js`/`ws` 属 **uni-mp-weixin 链**，mp 不构建 ⇒ 无自动验证面，登记即可——R2-N3） | 11 条（5+1+1+2+2） |
| B2 | **vite**：`apps/client/package.json` 精确钉 `5.2.8` → **`5.4.21`**（不引入 `^`，维持精确钉风格）+ overrides 对齐。⚠️ **预期**：该升版**违反 `vite-plugin-uni` 的精确 peer `{vite:"5.2.8"}`**，pnpm 默认出 **warning 非失败**（§2.4/R2-R5-5）——实现期实测自证该预期，`uni build` 绿 = 行为证据 | vite 1120061（清 **12/15**）；残余见 D6 |

**收口读数**（本片签收的机械口径，v1.1 订正）：`node scripts/security/check-audit.mjs` **EXIT 0**（= critical+high 减豁免集后为空）；**裸** `pnpm audit --prod --audit-level high` **仍 EXIT 1**（= 豁免生效的自证，R2-N4）；`gitleaks`（钉版）**0 findings**；trivy 读数存 SDD 工作区。

### D6 — vite 残余决议：豁免 1123525（一条 high），带复查触发

- **登记形态**：**机器可读**的一条 `scripts/security/audit-exceptions.json` 条目（D2），四字段齐全（`id: 1123525`（数字）· `module: "vite"` · `reason` · `reviewTrigger`）；同时写进本设计 §D6 + §1.1-3 + §5.2-2。⚠️ 豁免**只对 (id, module) 精确对**生效——不许把门槛降级（等级集合被闸逐字断言）。实现期若发现 red 不止这一条 ⇒ **停下按流程上报**，不许就地放宽。
- **理由**（三条，缺一不可；v1.1 换证据链）：修补只在 vite ≥6.4.3；**`vite-plugin-uni` 的 vite peer 精确钉死 `5.2.8`（在用版与最新 alpha 双双如此）** ⇒ uni 构建栈锁在 vite5；影响面是 dev server 的 Windows 旁路（生产不可达，§2.4）。
- **复查触发**（写进路线图与豁免条目的 `reviewTrigger` 字段；v1.1 订正——v1 的「basic-ssl ≥2」条件今天已满足、永不触发）：**`vite-plugin-uni` 的 vite peer 面放宽到含 6**（或 uni 官方声明支持 vite 6）⇒ 重审本豁免并升 6.x。

### D7 — 判据与闸（「判据存在 ≠ 判据有效」的落地；v1.1 全面加固）

**A. `slice-07.4-pipeline` 新增断言（10 条）**：

1. **A1** `ci.yml` 的 `security-scan` job **必须存在**（与 `render-gate` 的既有断言同构，`:492-496` 旁）；
2. **A2** 步骤**逐个存在**且按序：audit 门脚本 → `--self-test` → gitleaks → trivy（按 `run:` 体**调用形态**识别——`node scripts/security/check-audit.mjs` / `--self-test` / `gitleaks detect` / `trivy config`；成例 `backupWiringViolations:236-240`「按调用形态认」）；
3. **A3** 门脚本文本断言：含 `--prod` · `https://registry.npmjs.org` · 等级集合**恰好**字面量 `['critical','high']`（含引号与次序——R2-R4：子串断言可绕，必须「恰好」形态，成例 `sameTermSet`）；**不含** `--ignore-registry-errors`；
4. **A4** 豁免文件存在 + JSON 四字段非空 + **（id,module）集合恰好 = 登记集**（当前 = {（1123525, vite）}；新增条目 ⇒ 必须同提交改闸 = 显式登记，成例 B1 的「集合恰好」）；
5. **A5** security 相关步骤**均无 `continue-on-error: true`**；且其 `run:` 体**不含** `|| true` / `; exit 0` / `set +e`（R2-R4③：门被旁路的形态）；
6. **A6** gitleaks 步骤 run 体含 `--config .gitleaks.toml` 与 `--redact`；`.gitleaks.toml` 存在且内容断言（D3；**以规格 v3 的 C6 封禁组为准**：`useDefault = true`、`[[allowlists]]` 行首恰好 2 条、path 条目 **= 带 `$` 锚定的字面量**、regex 条目 **= 登记字面量（相等）**、**禁用键四类不出现**——剥 `#` 注释后）；
7. **A7** trivy 步骤 run 体含 `--exit-code 1` · `--ignorefile .trivyignore` · `--severity HIGH,CRITICAL`；`.trivyignore` 存在且非注释行匹配 `^[A-Z]+-[0-9]+$`；
8. **A8** `fetch-depth: 0` 出现在 security-scan 的 checkout 里（浅检出 ⇒ gitleaks 静默只扫 1 commit）；
9. **A9** self-test 步骤存在（`--self-test` 调用形态，D1 步骤 4）；
10. **A10** root `package.json` **不含** `auditConfig`/`ignoreCves`/`ignoreGhsas`（静默静音面封禁，D2）。

**A′. 判别力自证（R115 合成对照 12 条 = 负 11 + 正 1；⚠️ 规格层按 R4-🔴1 细化为 **15 条（负 14 + 正 1）**——新增 C22–C24 三条 gitleaks 封禁对照，见附录 A #20）**——喂**被削弱的合成形态**给**同一个谓词组** ⇒ 必须红：
- 负① 裸命令形态（删门脚本调用）；负② 等级集合缩水（只剩 `'critical'`，**最像正确答案的那个错**）；负③ 出现 `--ignore-registry-errors`；负④ `continue-on-error: true`；负⑤ run 体含 `|| true` 旁路；负⑥ gitleaks 步骤缺 `--config`；负⑦ 允许项放宽（path 改整目录 / regex 改 `.*`）；负⑧ 豁免集多一条未登记 id；负⑨ **删 `fetch-depth: 0`（浅检出）⇒ C8 红**（**R4 订正**：原「豁免陈腐」在切片侧无载体——该语义归门脚本自证负③）；负⑩ root package.json 出现 `auditConfig.ignoreCves`；负⑪ trivy `--severity` 缩水；**正① 真文件形态（修毕）喂同一谓词组 ⇒ 判齐（防谓词恒红）**。

（门脚本内部的 `--self-test` 另有 负①–⑤ + 正① 六条，见 D2——跑在 CI 步骤里，不进 conformance 计数。）

**B. baselines 回填**：`slice-07.4-pipeline` 的 `render`/`full` 两列下限按**新实测量**上调（规格预期 +25；**实现形态（A 组聚合为 4 条）实测 +19**——R6 实跑；现基线 51 / 实跑 **56** ⇒ 预计 **~75**；以 CI 实测为准）；按纪律**只按 CI 实测回填**（render 列每 push 跑）。

**C. 本片外但被本片加固的既有闸**：**EXPECTED_FILES 闭集**（R1-J6 订正：v1 误标 M9；新增文件须同提交改闸）· **M9**（扫描器镜像字面量不触前缀闸）· **I1**（新步骤无 `${{ }}`）· `runBodies >= 12` 下限自动被新步骤抬升（只增不减，安全方向）。

### D8 — 验证协议（本片签收口径，全部要**本次产生的日志**）

1. 修复批落地后：`pnpm install`（lockfile 重建）→ 本地**六阶段全绿**（`pnpm run ci`）；
2. 客户端面：六阶段阶段 3 已含 `uni build`（§2.5；限 H5 链）；另跑 `pnpm --filter @fight-the-landlord/client test` 单测；
3. **全序 conformance 全绿**（Nest 11 是本片主风险：Express 5 的通配符路由/中间件语义、RPC 传输行为、platform-socket.io 版本面——全部由真栈 conformance 覆盖）；
4. 扫描器复跑：`node scripts/security/check-audit.mjs` **EXIT 0**（**裸 audit 仍 EXIT 1 = 豁免生效自证**——R2-N4 订正）；`gitleaks` 钉版 **0 findings**；trivy 读数存档（SDD）；
5. push 后 **CI 三 workflow 全绿**（ci / conformance / images）；`baselines` 回填若需第二轮，按既有「以 CI 实测回填」流程；
6. **钉版首跑读数回填**（R2-R7）：gitleaks 与 trivy 的**钉版**在 CI 首跑的读数 = 豁免清单与结论的最终依据（探针读数系 :latest，§2.3）；处置规则同 D4。

### D9 — 回滚形态

改动全在 git（工作流 YAML、overrides、Dockerfile 微调、conformance 切片、两个脚本与两个清单、文档）⇒ 回滚 = revert commit；**本片不打 tag、不发布**（生产不变）。唯一「立即生效」面是 CI 自身（push 即生效）——若 CI 里某扫描器步骤出环境故障，按「环境故障 vs 真红」判别（前者修步骤、后者修依赖），两向都有明确归属，不产生「关掉判据」的诱惑——这也是三步各自独立步骤的原因。

---

## 4. 兼容面与风险（实现期重点核对）

| 面 | 风险 | 缓释 |
|---|---|---|
| Nest 10→11 | Express 5 的破坏性变化（通配符路由语法 `*`→`*splat`、`req.query` getter、可能影响 api-gateway 路由与中间件） | 全序 conformance 覆盖全路由面；实现期先升到 11 后**立刻**跑阶段 3/4，再上真栈 |
| **Nest `latest` 已指 12（R2-R1）** | 任何 `@latest`/裸包名安装会吃到 12 线且「半套 12」无从从 peer 报错辨认 | D5-A1 逐包 `@^11` 矩阵写死进 spec；§4 本行登记 |
| Nest 11 配套版本矩阵 | `@nestjs/config`/`axios`/`typeorm`/`jwt`/`passport` 的 11 兼容版已逐一实测存在（R2 §1.2）；`@nestjs-modules/ioredis` 有 2.2.2（**预演：不触发停下上报**） | 实现期以 install 成功 + conformance 为准；若出现矩阵外冲突 ⇒ **停下上报** |
| uni 工具链 overrides | adm-zip 0.6 / jpeg-js 0.4 的 0.x 跳变可能破 uni-cli-shared 的调用；**vite 5.4.21 违反 vite-plugin-uni 精确 peer（预期 warning）** | H5 链由六阶段阶段 3 的 `uni build` 每次门禁自动检验；mp 链（jpeg-js/ws）无自动面、登记（N3）；破了 ⇒ 回退该条 override 并**报到设计层**（换登记豁免讨论，不静默） |
| vitest 本地补丁 | 假红④的修复补丁钉在 `vitest@2.1.9`（`patches/vitest@2.1.9.patch`） | 本片**不动 vitest**（dev-only ≥high 不在门槛面，§7-5）；任何升级都必须先过补丁兼容评估 |
| CI 时长与网络 | gitleaks 全历史 ~25s；trivy 检验束每次下载；audit 依赖 npmjs 可达性 | 三步独立步骤 ⇒ 故障定位到步；形状断言 + 禁用旗标使 **npmjs 故障响亮**（宁可红不可假绿） |
| 扫描器自身供应链 | 钉版二进制若被替换 | sha256 校验写死在 YAML；版本升级 = 显式 commit（可 review） |

## 5. 对权威文档/代码的修订口径

### 5.1 修订面全表

| 处 | 现状 | 本片如何改 |
|---|---|---|
| `docs/design.md:1656` 一带 | 只记录 `ci.yml` 的第二个 job `render-gate` | 补记第三个 job `security-scan`（三扫描器、门槛、与六阶段的边界理由）；**六阶段表（§13.4）不动** |
| **`docs/ops/first-deploy.md:723-724`（R1-J2 订正：v1 误标「已核=不动」）** | :723「feature 分支上 push ⇒ **只跑** `ci` + `render-gate`」、:724「push 到 `master` ⇒ **额外跑** `images` 与 `conformance`」 | **需同改**：把 job 枚举扩为含 `security-scan`（或改写为不枚举 job 的形态）；顺带复核 :688 的预期输出清单 |
| `tools/conformance/baselines.json` | `slice-07.4-pipeline` 51 / 51 | 按新断言数 **+19 上下（实现形态实测；规格预期 +25）**（现基线 51 / 实跑 56 ⇒ 预计 ~75；按实测回填，CI 读数） |
| `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` | M0.1 = 待开工 | 收口时改状态 + **vite 豁免复查触发**登记 |
| `.gitleaks.toml` · `.trivyignore` | 不存在 | 新增入库（D3/D4） |
| `scripts/security/check-audit.mjs` · `scripts/security/audit-exceptions.json` | 不存在 | 新增入库（D2/D6） |
| root `package.json` 的 `pnpm.overrides` | 不存在 | 新增（D5；单一处，可 review 的依赖钉法） |
| **嵌套 lockfile（R2-N5）** | `packages/robot-service/pnpm-lock.yaml`、`packages/room-service/pnpm-lock.yaml` 被跟踪、无消费方 | **删除**（随 A9 同提交；前提 = 实现期复核无引用） |

### 5.2 明知取舍（写进文档，不留给后人猜）

1. **审计面 ≠ 运行面**（§2.2 尾注三条，含 bcrypt 生产链订正）：本片按用户裁决把 `--prod` 面全修绿；「客户端构建工具链是否该算 prod 面」「optional-peer 漏面是否该在门槛里剔除」是**门槛面语义**的重议题——登记在案，**本片不动**（动了就是在修的同时悄悄缩判据面）。
2. **一条 high 带理由不修**（vite/1123525，§D6）：本片唯一不在「全绿」字面内的条目，机器可读登记 + 复查触发已写死。
3. **gitleaks 允许清单两条**都是「保留字面量」型豁免（夹具/文档），不是「修不了」型；理由行内联在 `.gitleaks.toml`。
4. **静默通道封禁是「外围闸」不是「工具能力」**（D2/D7-A10）：pnpm 的 `ignoreCves` 能力在 9.15 就存在——我们不靠「工具不支持」防守，靠**闸断言其不被使用**（本席实验已证能力存在）。

---

## 6. 判据计划（本片要产出的**新**闸与自证）

1. `slice-07.4-pipeline` 新增断言组 A（D7-A 的 **10 条**）+ 合成对照 **15 条**（负 14 + 正 1；规格细化）——合计预计 **+25**，baselines 按 CI 实测回填；
2. 三个扫描器各自的**行为自证**（R115 式，在 SDD 留日志）：
   - 门脚本 `--self-test`（D2 尾：负①–⑤ + 正①，**CI 有自动调用点** = D1 步骤 4）；
   - gitleaks 允许清单自证（把允许项 ② 拿掉重跑 ⇒ 必须重新报出那 2 条；装回 ⇒ 0；**钉版**跑）；
   - trivy：`--exit-code 1` 的行为自证（首跑读数非空时天然自证；读数全空时用合成 Dockerfile 演示一次）；
3. 审读面自证：`check-audit.mjs` 对 `{"error":{…}}` 形态的 fail-closed（self-test 负①，§2.1 三形态实测为据）；
4. 六阶段与全序 conformance 的本次日志（D8）；钉版首跑读数回填（D8#6）。

## 7. 明确不做（逐条登记，防歧义）

| # | 项 | 登记去处 |
|---|---|---|
| 1 | ZAP 渗透测试 | 路线图（M0.1 之外，原样后置） |
| 2 | trivy **镜像扫描**（8 镜像） | 本设计 §7 + 路线图（触发条件：images.yml 加 post-push 扫描 job + 镜像侧存量策略） |
| 3 | 周期触发（`schedule:`）与告警通道 | **监控片**（原 M0.2 并入；它是该片的观察面） |
| 4 | dependency-review-action / Dependabot | 本设计（private + 无 GHAS，实测排除） |
| 5 | dev-only **≥high 8 条（7 high + 1 critical：vitest）** 与 moderate/low **65 条（57 + 8，去重口径）** | 本设计 §2.1/§7（不在门槛面；vitest 链因本地补丁刻意不动） |
| 6 | SARIF 上传 / PR 评论机器人 | 本设计 D1（退出码即闸，不上传） |
| 7 | **门槛面收窄**（把客户端构建工具链/optional-peer 漏面移出门槛） | §5.2-1（语义重议题，本片不动） |

## 8. 风险（对「本片自己」的）

- **最大风险 = 修复批把运行时改坏**（Nest 11）⇒ 缓释：全序 conformance + 六阶段是硬门；且本片**不发布**（不 tag），坏也坏在 CI 上。
- **次大 = 把闸做空** ⇒ 缓释：D7 的 15 条合成对照（规格细化后） + 门脚本 6 条 self-test + D7-A10 静默通道封禁 + **self-test 有 CI 自动调用点**（v1 的这三条恰是 R2-R4 抓出的盲区）。
- **执行面**：trivy 首跑读数未知（含 douzero 两文件；可能开出「修 Dockerfile」的支线）⇒ 按 D4 规则处置，支线超出一页纸规模 ⇒ 停下上报。
- **审查自身的不确定性**：两审查者在 `ignoreCves` 支持性上冲突（R2 实测支持 / R1 判不支持）⇒ **以本席实验裁决（支持）**，并把「实验裁决」事件留在附录 A（两审查者都不许被当权威，实验为准）。

## 9. 下一步

1. 本文（v1.1）**定稿**（两路审查已过、处置表见附录 A）；
2. **规格层**（`2026-10-02-security-scan-spec.md`）→ 审规格；
3. 计划（task-brief 拆分 + 子 agent 实现）→ 审计划 → 实现 → 自测（D8）→ 收口（§5.1 修订面 + 路线图状态）。

---

## 附录 A — 审查处置表（v1 → v1.1）

> 两路独立审查：R1（事实核验，42 条）· R2（完整性与可执行性，🔴4/🟠4/🟡5）。以下逐条处置；「采纳」= 已落进 v1.1 对应处。

| # | 来源 | 发现 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | R2-🔴R1 | Nest `latest` 已指 12.1.2；jwt/passport/typeorm/cli 无 legacy tag | **采纳** | D5-A1 逐包 `@^11` 矩阵 + §4 风险行 |
| 2 | R2-🔴R2 | 注册表故障 = 合法 JSON `{"error":…}` + EXIT 1；天真解析静默全绿 | **采纳**（因果订正 + 形状断言） | D2 五要素之四；self-test 负① |
| 3 | R2-🔴R3 | pnpm 9.15 支持 `auditConfig.ignoreCves`（静默静音面无闸） | **采纳**；⚠️与 R1-E5 冲突 ⇒ **本席实验裁决**（4 变体：CVE 串生效、GHSA/数字串无效）⇒ 支持 R2、R1-E5 不采纳 | §2.1 事实行 + D2 封禁 + D7-A10 + 负⑩ |
| 4 | R2-🔴R4 | 子串断言可绕 / `--self-test` 无 CI 落点 / `\|\| true` 免检 | **采纳** | D7-A3「恰好」形态、D1 步骤 4、D7-A5、负②④⑤ |
| 5 | R2-🟠R5 | vite：计数 15/12/3；两条「实锤」不锁 vite6；真锁=`vite-plugin-uni` 精确 peer；触发已提前满足 | **采纳** | §2.4 全节重写；D6 证据与触发重写；D5-B2 预期 |
| 6 | R2-🟠R6 | D5 缺 ioredis/axios/config 动作；terminus 幽灵；multer 下限 | **采纳** | D5-A2/A3/A4/A5/A10 |
| 7 | R2-🟠R7 | gitleaks 968≠1012；`:latest` 未钉版 | **采纳** | §2.3 脚注 + D8#6 + D3 `--redact`/`git`·`detect` 自证项 |
| 8 | R2-🟠R8 | tar critical 同经 bcrypt **生产链** | **采纳**（叙事 + 验证口径） | §2.2 tar 行 + D5-A7 |
| 9 | R2-🟡N1..N5 | 口径/计数/引用/悬空/GHSA 形态/intlify 钉法/H5 限面/裸 audit EXIT1/嵌套 lockfile | **采纳** | §2.1 口径脚注 · §7-5 · D6 引点 · §5.2 · A6 脚注 · D5-B1 · §4 · D8#4 · D5-A9+§5.1 |
| 10 | R1-🔴A4 | vite 计数 13/11→15/12（与 R5 同处） | **采纳** | 同上 |
| 11 | R1-🟠J2 | `first-deploy.md:723-724` 枚举 job 集，v1「已核=不动」不实 | **采纳** | §5.1 该行改「需同改」 |
| 12 | R1-🟠A3 | §7-5「59+8」无口径 → 65（57+8，去重） | **采纳** | §7-5 |
| 13 | R1-🟠F2/F3 | 两处「（v5 系）」注解不成立；补 `vite-plugin-uni` 决定性证据 | **采纳** | §2.4 + D6 |
| 14 | R1-🟠J3 | trivy 叙事三处失真（下载成功/内置 deadline/walk 快速失败） | **采纳** | §2.5 订正版叙事 |
| 15 | R1-🟠J4 | 扫描面漏 `douzero/Dockerfile` 与 `douzero/docker-compose.douzero.yml` | **采纳** | D4 扫描面 |
| 16 | R1-🟠J5 | 负/正对照条数 7/8/6 三处不一 | **采纳（超出原议）**：v1.1 把枚举重整为 **负 11 + 正 1 = 12**（并入 R2-R4/C3 的补充闸，显式列出） | D7-A′ + §6-1 |
| 17 | R1-🟡A1/A2/A6/B2/C2/J6 | 口径脚注 / vitest 是 critical / GHSA 拼接串（豁免按数字 id 匹配）/ 列口径 / 968 之差脚注 / D7-C 标签错位 | **采纳** | §2.1 · §2.1 · §2.2 与 D2 · §2.2 · §2.3 · D7-C |
| 18 | R1-E5 | 判「pnpm 9.15 无豁免机制」成立 | **不采纳**（R1 依据 = `--help` + 外部回忆；与本席 A/B 实验直接冲突；**实验为准**——R2-R3 成立） | §2.1（并把本冲突记在此） |
| 19 | R1「无法核验」6 项 | gitleaks 实际版本 / Caddyfile 行为 / trivy 二跑时长 / gitleaks-action 许可（已改用二进制⇒不适用）/ 浅检出行为 / D5-D6 实效 | **登记为实现期自证清单** | D8#6 + §6-2；「许可」项因方案更换**消解**；「浅检出行为」实由 **D7-A8 静态断言**兜底（R3-🟡5 订正措辞） |
| 20 | R4（规格审查 R1） | ① 负⑨「豁免陈腐」在切片侧**无载体**（陈腐 = 豁免集−触网通告集；切片判定面只有静态文件）② gitleaks **四条工具形态静默旁路**未封（`--baseline-path` / `[extend] disabledRules` / `[[rules.allowlists]]` / `.gitleaksignore` + 行内 `# gitleaks:allow`——与 ignoreCves 同族）③ D5-A1 把 `platform-socket.io`/`websockets` 误列「6 服务」、`@nestjs/terminus` 幽灵行被规格半复原 | **采纳 3 项，全部落规格层**（不重开设计轮）：① 负⑨**置换**为「删 `fetch-depth: 0`」（顺带补 C8 专属对照）；② 规格 C6 扩为**封禁组**（旗标恰好化 + 配置禁键 + `.gitleaksignore` 不存在 + 全仓无 `gitleaks:allow`）；③ 本表 A1 行与规格 §2.6 声明位均已精确化 | 负⑨：D7-A′ 已改；②③：规格 v2 §2.5/§3 |
| 21 | R5（规格修复验证） | 设计文内 **7 处旧数字/旧句**未随规格 v2（D7-A′「12 条」/D7-B、§5.1、§6-1、§8 的「+22」/D7-A6 旧 regex 句/D3 path 无 `$`） | **采纳**：逐处同步为「12→15（规格细化）/ +25 / ~81 / regex 相等 / `$` 锚定」（本 v1.2.2）；规格侧另按 R5 订正 3 处「按字面实现 ⇒ 恒红」文本级硬伤（C6 作用域/剥注释/跳列，规格 v3） | D3/D7-A6/D7-A′/D7-B/§5.1/§6-1/§8 已改 |
| 22 | 实现期（T2/T5/T7 三轮修复） | ① T2：Nest 11/Express 5 下 `forRoutes('*')` **静默失效**（裸 `/api` 验签丢失）——既有安全行为闸 A′ 目击（401→404）；② T5：slice 本地注释剥离撞 **N46 唯一真源闸**；③ T7：trivy 首跑 **14 条 HIGH**（DS-0002 ×8 / DS-0029 ×6） | **全部走「停报→裁决→修复→复验」通道、如实留档**：① 矩阵实测选 `forRoutes('{/*splat}')`（判据断言零改动，双机械证；`bc8ea0c`）；② 本席裁决方案 A——收敛到 `packages/test-utils` 的 `stripComments`（行为差逐字节无害核证；`4cb7c53`）；③ 8 Dockerfile 非 root 化 + apt `--no-install-recommends`（≈30 行 < 一页，**不触停报**）+ edge `/data` 卷迁移登记入手册 详注 ⑨（`9bf59ae`） | 教训（两条，写死供后续片引用）：**(a)** 跨切面结构闸（N46 族）**只有全量 test 才照得到**——「既有判据会红」清单/任务的验收链必须含六阶段，不能只跑局部 render；**(b)** 升级大版本（Nest）时，**行为闸是升级正确性的主要目击者**——A′ 就是靠既有判据抓到「静默丢覆盖」，没有它这一退化会直到生产才发现。规格侧连带订正见其 §0 v3.1。 |
| 23 | 收口后 DB 漂移（记录片分支 CI 首报） | 2026-10-03 门脚本按 advisory DB 漂移**首报新 high** `braces` id=1240992（"深嵌套模式栈耗尽 DoS"，`patched=<0.0.0` = **上游无修复**，npm 最新即 3.0.3）；命中链 = 客户端 uni 构建工具链（`uni-cli-shared > chokidar > braces`），构建期、玩家/生产不可达 | **按 D2/D6 机制登记豁免 #2**（`audit-exceptions.json` 四字段+ghsa）+ **同提交改闸**（`slice-07.4-pipeline.ts` C4 `wantEx` 扩为两条——「恰好集合」断言按设计逼出本次**显式登记**）；规格侧见 §0 v3.2。「全绿即断言」语义保持：豁免即登记、非静默放宽 | `scripts/security/audit-exceptions.json` · `slice-07.4-pipeline.ts`（记录片分支同提交） |
