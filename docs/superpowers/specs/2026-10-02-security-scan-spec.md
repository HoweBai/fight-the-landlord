# 安全扫描进 CI（M0.1）（**规格层 v3 · 定稿**）

> **状态**：v3 —— **定稿本**。已过**两轮**独立审查：R4（规格审查：1🔴/6🟠/8🟡）→ **R5 修复验证（18/18 处置落地；发现并订正 3 处「按字面实现 ⇒ 恒红」文本级硬伤 + 5 处一致性，全部按 R5 建议形态落文）**。设计层 = `docs/superpowers/specs/2026-10-02-security-scan-design.md` **v1.2.2（定稿）**（五轮审查，处置见其附录 A）。
> **来源标注**：每行/每条判据的 `来源` 列回指设计条款（D1–D9 与 §编号）。
> **口径**：数字与既有闸行为的事实依据见设计 §2（全部实测）；本文只写「改什么、改成什么、怎么判」。

---

## 0. 修订对账

### v3.6（2026-10-12 —— **gitleaks 允许项扩至 8 条**：广告片 T20 conformance 广告回调测试密钥夹具目录）

| # | 动作 | 依据 |
|---|---|---|
| 1 | **按 §2.3 机制登记允许项 #8**：`.gitleaks.toml` 加第八条（description 带复查触发 + **目录锚定** path 条目）；**同提交改闸**（`slice-07.4-pipeline.ts` 的 C6③ `[[allowlists]]` 计数 7→8 + **新增第八条 path 字面量的逐字 pin**——「恰好集合」断言正是为逼出这种显式登记而设）；§2.3 写死内容与断言行同步 | 广告片规格 §5.4 明示（生成器照 `alipay-test/generate-fixtures.mjs` 形态）。`tools/conformance/fixtures/ad-callback/` 的 `callback-private.pem` = `private-key` 扫描命中源——均为**测试密钥对**（自造、仅供本地签名夹具与 conformance 样本；真凭据永不入仓、只存服务器 `.env`；**不建 stub 容器**——ads 无出站调用）。类型 = 「保留字面量」型（§2.3 头注许可的两类之一） |
| 2 | 复查触发（写进 description）：该目录引入测试密钥对以外的任何高熵字面量、或夹具形态变化（如改为运行时生成/额外文件）⇒ 重审本条 | 与既有各条允许项同口径 |
| 3 | **允许项 #7（支付配置管理化片同族字面量）邻接扩面**：path 由 `pay-channel` 族扩为 `(pay\|ad)-channel` 族；**同提交改闸**（`slice-07.4-pipeline.ts` C6③ 该条 path 字面量 pin 同步——计数仍 8，条目数不变、仅路径覆盖扩面）+ 本表本行 | T20 提交前**本机全历史实跑**（gitleaks v8.30.1，官方 checksums 验证）发现 3 条 `generic-api-key`：`packages/config-service/test/ad-channel.{controller,crypto,service}.test.ts`（commit `430e0db` 引入）——字面量 = 既有登记的 ⚙️13 dev 主钥 `DEV_KEY_B64`（与 pay-channel 测试族**同一字面量**）在同族新文件中的复现；文件名不在该条既有 pattern ⇒ 本片若不扩面，push 后 `security-scan` job 必红。类型 = 「保留字面量」型（测试夹具、非真凭据）。判别力对照：该条移除 ⇒ 3 条复现（并见 §4-7 注记与 T20 报告控制组） |

> **补登记（T17 两条）**：T17 两条（notify/config 族，#6 `notify-channel` 与 #7 `(pay|ad)-channel` 族）随本 v3.6 补登记——基数 5→7 的 +2 在 T17 时未入本序列（代码侧 pin 计数由 T18 修复轮同步；本表首次入文）。

### v3.5（2026-10-06 —— **gitleaks 允许项扩至 5 条**：支付片 T16 conformance 测试密钥夹具目录）

| # | 动作 | 依据 |
|---|---|---|
| 1 | **按 §2.3 机制登记允许项 #5**：`.gitleaks.toml` 加第五条（description 带复查触发 + **目录锚定** path 条目）；**同提交改闸**（`slice-07.4-pipeline.ts` 的 C6③ `[[allowlists]]` 计数 4→5 + **新增第五条 path 字面量的逐字 pin**——「恰好集合」断言正是为逼出这种显式登记而设）；§2.3 写死内容与断言行同步 | 支付片 T16a 首提交（`3a88059`）本机实跑实证：`private-key` 在 `tools/conformance/fixtures/alipay-test/{app-private,alipay-private}.pem` 报 2 条 —— 均为**测试密钥对**（= T6 `keys.json` **同一对**；支付片规格 ⚙️14/§12 明示「仅测试密钥对入仓；生产密钥永不入仓、只存服务器 `.env`」；`conformance-stack.sh` 就此对生成 base64 注入 payment-service、stub 只读挂载 `/keys` 消费）。类型 = 「保留字面量」型（§2.3 头注许可的两类之一） |
| 2 | 复查触发（写进 description）：该目录引入测试密钥对以外的任何高熵字面量、或夹具形态变化（如改为运行时生成/额外文件）⇒ 重审本条 | 与既有四条允许项同口径 |

### v3.4（2026-10-06 —— **gitleaks 允许项扩至 4 条**：支付片 T6 支付宝金标夹具的固定测试密钥对）

| # | 动作 | 依据 |
|---|---|---|
| 1 | **按 §2.3 机制登记允许项 #4**：`.gitleaks.toml` 加第四条（description 带复查触发 + path 条目）；**同提交改闸**（`slice-07.4-pipeline.ts` 的 C6③ `[[allowlists]]` 计数 3→4 + **新增第四条 path 字面量的逐字 pin**——「恰好集合」断言正是为逼出这种显式登记而设）；§2.3 写死内容与断言行同步 | 支付片 T6 首提交（`9b47769`）本机实跑实证：`private-key` 在 `packages/payment-service/test/fixtures/alipay/keys.json` 报 2 条（两个 PEM 块）——均为**测试密钥对**（支付片规格 ⚙️14/§12 明示「仅测试密钥对入仓；生产密钥永不入仓、只存服务器 `.env`」）。类型 = 「保留字面量」型（§2.3 头注许可的两类之一） |
| 2 | 复查触发（写进 description）：该文件引入测试密钥对以外的任何高熵字面量、或夹具形态变化（如改为测试内运行时生成）⇒ 重审本条 | 与既有三条允许项同口径 |

### v3.3（2026-10-03 —— **gitleaks 允许项扩至 3 条**：alert-relay 钉钉签名测试夹具的固定向量假 secret）

| # | 动作 | 依据 |
|---|---|---|
| 1 | **按 §2.3 机制登记允许项 #3**：`.gitleaks.toml` 加第三条（description 带复查触发 + path 条目）；**同提交改闸**（`slice-07.4-pipeline.ts` 的 C6③ `[[allowlists]]` 计数 2→3 + **新增第三条 path 字面量的逐字 pin**——「恰好集合」断言正是为逼出这种显式登记而设）；§2.3 写死内容与断言行同步 | 监控片 CI 首跑实证：`generic-api-key` 在 `packages/alert-relay/test/{sign,sinks,server}.test.ts` 各报 1 条（三处同类，合计 3）——均为钉钉加签**固定向量**测试的显式假 secret（真凭据从未进入仓库；向量须固定值故不改运行时拼接）。类型 = 「保留字面量」型（§2.3 头注许可的两类之一） |
| 2 | 复查触发（写进 description）：三个测试文件若引入**其他**高熵字面量或夹具形态变化 ⇒ 重审本条 | 与既有两条允许项同口径 |

### v3.2（2026-10-03 —— 豁免集扩至 **2 条**：`braces`/1240992，advisory DB 漂移首报）

| # | 订正 | 依据 |
|---|---|---|
| 1 | 门脚本按 **advisory DB 漂移**首报新 high `braces` id=1240992（GHSA-vfj7-8cjw-p6xm，"深嵌套模式栈耗尽 DoS"）——**上游无修补版本**（`patched=<0.0.0`；npm 最新即 3.0.3=vulnerable，无更高可升，与 1123525 同族形态）；命中链 = apps/client 的 uni 构建工具链（`uni-cli-shared > chokidar > braces`），构建期、玩家/生产不可达 | 记录片分支 CI 首跑（run 37099907592）门脚本红；`npm view braces versions` 实证 |
| 2 | **按 D2/D6 机制登记豁免 #2**：`audit-exceptions.json` 加第二条（四字段+ghsa）+ **同提交改闸**（`slice-07.4-pipeline.ts` 的 C4 `wantEx` 集合扩为两条；「恰好集合」断言正是为逼出这种显式登记而设） | §1.1 裁决 3 的机制延伸；登记留痕见设计附录 A #23 |

### v3.1（2026-10-03 收口登记 —— 实现驱动订正 3 处，均有留档）

| # | 订正 | 依据 |
|---|---|---|
| 1 | **C3 的剥注释实现 = N46 唯一真源 `stripComments`**（语义：块+行注释、`:守卫`、**引号不感知为已知边界**——边界钉在 `packages/test-utils/src/strip-comments.ts` 的「已知边界」节）。v3 原文「仅字符串外起剥」作废 | T7 首跑六阶段红：N46 闸（`comment-stripping-single-source.gate.test.ts`）目击 slice 本地定义；本席裁决方案 A（采用真源）；行为差经逐字节无害核证（`task-5-fix2-harmlessness.log`：真实+变异输入下 C3 提取 old/new 全同、唯一字符串内 `//` 是带冒号守卫的 URL、块注释 0 判据敏感 token） |
| 2 | **C6 的禁键四串名单在 C6 行显式枚举**（`disabledRules` / `rules.disabled` / `rules.allowlists` / `disableRuleIDs`）——原文「（禁用键四类）」的名单只在实现里，自指引空链 | 终审 🟡-3；`docs/superpowers` 在 C6⑤ 跳列内，入文不触扫描 |
| 3 | **trivy 本版实际覆盖面 = 8 个 Dockerfile**（CI 两轮 `Detected config files num=8`；3 个 compose 文件与 Caddyfile 不在 target 列表——Caddyfile 不识别已预登记，compose 未覆盖按实现回登） | 终审 🟡-4；设计 D4「以实际覆盖为准」 |
| 4 | **§2.5 骨架的 `setup-node` 去掉 `cache: pnpm`**——本 job 不跑 `pnpm install`（audit 只读锁文件）、无 pnpm store 可缓存；带缓存时 post-step 保存缓存会因路径不存在**把 job 判红**（master 首次 CI 实测：分支侧三轮侥幸绿、master 侧 `security-scan: failure` 的唯一失败步 = Post setup-node 缓存保存） | 本修复轮（ci.yml 同改 + 注释说明） |

### v3 相对 v2（R5 修复验证处置：3🟠 + 5🟡）

| # | R5 的问题 | 处置（按 R5 建议形态） |
|---|---|---|
| 🟠-1 | C6① 旗标白名单「作用域 = 整 run 体」⇒ 骨架自身 curl/sha256sum/tar 的 5 个 token 判红（C25 第一天不可达） | **作用域写死 = 「以 gitleaks 可执行（`/tmp/gitleaks`）起的、含子命令 `detect` 的那条命令行」**（续行拼接后按 shell token 分割）；§2.5 骨架注明「本步其余行（curl/sha256sum/tar）不参与白名单」；`--config`/`--exit-code` 的「恰好一次」也限定在该命令行内 |
| 🟠-2 | C6③ 禁键四串 与 §2.3 骨架第 3 行公示注释自相矛盾 ⇒ 恒红；`allowlists` 子串计数歧义 | **A+B 双管**：A §2.3 骨架注释改写为**不含四串字面量**（「禁用键四类（名单见规格 C6 判据行——本文件不得出现其字面量）」）；B C6③ 定义为「**剥 `#` 行注释后**：`[[allowlists]]` **行首**出现恰好 2；四串不出现」 |
| 🟠-3 | C6⑤ 全仓扫描命中契约自身（两份合同文档 + 未来切片源码/夹具）⇒ 恒红 | **A+B 双管**：A 跳列 += `docs/superpowers`、`tools/conformance`（残面在 §9 登记）；B 约定**切片源码与合成夹具内的该字面量必须运行时拼接**（`'gitleaks'+':'+'allow'`），不落连续字面量 |
| 🟡-1 | 设计层 7 处旧数字/旧句未随 | 设计 v1.2.2 同步（附录 A #21） |
| 🟡-2 | C3① 提取形态与 §2.1 的跨平台三元式不匹配；「注释先剥」需入正文 | C3① 改「`spawnSync(…)` 调用的**数组实参**字面量 token 恰好」；「**先剥 `//` 注释（仅字符串外起剥）**再提取」并入 C3 正文①与③ |
| 🟡-3 | C2「注释不算」的实现注记（成例机制 ≠ 剥注释） | C2 增实现注记：「以『丢弃**行首（trim 后）为 `#`** 的行』实现『注释不参与』」 |
| 🟡-4 | §0 自述口径两处（文案） | 本表头与下表的措辞已按 R5 订正 |
| 🟡-5 | C6⑤ 跳列未含 `.pnpm-store`（本机 479MB 缓存、冷启动 >12 分钟） | 跳列 += `.pnpm-store`（与 `dist`/`test-results` 同口径）；§4-7 注记本地热跑 ≈48s |

### v2 相对 v1（R4 规格审查处置：1🔴 / 6🟠 / 8🟡 + 3 条建议<sup>（5.2-①② · 5.3-①）</sup>）

| # | R4 的问题 | 处置 |
|---|---|---|
| 🔴-1 | gitleaks **四条工具形态静默旁路**（`--baseline-path`/`--exit-code 0`；`[extend] disabledRules`；`[[rules.allowlists]]`；`.gitleaksignore` + 行内 `# gitleaks:allow`）无任何判据——与 ignoreCves 同族 | **C6 扩为「封禁组」**：run 体旗标**白名单+恰好化**（含 `--exit-code 1` 入骨架）；`.gitleaks.toml` 禁键四串；`.gitleaksignore` 不存在；全仓无 `gitleaks:allow`（有界遍历）；新增对照 C22–C24 |
| 🟠-1 | §2.6 声明位失真（`platform-socket.io` 仅 room、`websockets` 仅 gateway+room 被写成「6 服务」）；terminus 幽灵行动作半复原 | 行 1 拆写声明位；行 10 改「全仓无声明，无动作（出现声明 = 意外项，停下报）」；§1 C2 行删 terminus 句 |
| 🟠-2 | §2.3 `paths`（无 `$`）与 C6 锚定（有 `$`）自相矛盾 ⇒ C25 正对照必红 | **§2.3 加 `$`**（`…redact\.test\.ts$`）；C17 复核路径改写仍红 |
| 🟠-3 | C7 正则 `^[A-Z]+-[0-9]+$` 挡死全部真实 trivy ID（AVD-DS-0002/CVE-/GHSA-） | 改**族白名单**（CVE/GHSA/AVD-DS 三族）；禁 `exp:` 形态；ID 行的**前一行为 `#` 理由行**入断言 |
| 🟠-4 | C19「豁免陈腐」切片侧**无载体**（需触网读数；与 B 组负③重复） | **置换**为「删 `fetch-depth: 0`」⇒ C8 红（补 C8 专属对照）；陈腐语义归 B 组负③ |
| 🟠-5 | 三处「停下上报/不许放宽」未随行 | §9 增**停报清单**（四行） |
| 🟠-6 | Dockerfile 条件支线未入改动面；「本片无容器变更」与设计 D9 相抵 | §1 增**条件行**；§1 尾注改口径；§6 回滚句带上「若发生」 |
| 🟡-1 | C2 识别语义未写死（首个命中/严格递增/注释不算） | C2 写死（四模式各取**首个命中步骤下标**、两两不同且**严格递增**、仅认执行形态） |
| 🟡-2 | C3 提取语义未写死（注释喂词双向可乘） | C3 升级为**执行语句提取**：`spawnSync('pnpm', […])` 数组字面量 token 恰好相等；`const LEVELS` 字面量值比较；注释不参与；另加去注释后的 `--ignore-registry-errors` 禁令 |
| 🟡-3 | C6 regex 半边可「写宽非通配」（如 `dev`） | C6 的 regex 条目判据 = **等于**字面量 `dev-internal-token-change-in-production` |
| 🟡-4 | C5 未封 **job 级** `continue-on-error` | C5 增 job 节点断言；C14 对照含 job 级 |
| 🟡-5 | E2 数字用下限当基数 | E2 改「基线 51 / **实测 56**（R4 本机 `--render`）；＋25 上下 ⇒ 预计 ~81（以 CI 实测为准）」 |
| 🟡-6 | Windows 上 `spawnSync('pnpm')` ENOENT / `.cmd` EINVAL（本地自证路径断） | §2.1 写死跨平台选形（win32 ⇒ `pnpm.cmd` + `shell:true`；posix ⇒ `pnpm` + `shell:false`）+ `maxBuffer` 显式；Windows/CI 各跑一次留证 |
| 🟡-7 | (a) `metadata.vulnerabilities` 的 null 守卫弱于设计；(b) 负④无机制 | (a) 补 `=== null`；(b) 写死纯函数 `violations(advisories, exemptions, levels = LEVELS)` 及对偶用例机制（见 C29） |
| 🟡-8 | 交叉引用五款 | (a)(b) **删除**指代不明的引用（等效于所述修复——R5-🟡4 订正自述口径）；(c) E1 判定面列表（JSON 只有豁免文件一个）更正；(d) §2.4 统一「ID 行 + 前一行为 `#` 理由行」；(e) §4.3 补 EXPECTED_FILES「不动作」一句 |
| 5.2-① | C4 不钉 `id` 类型（字符串 id 会失配、虽响亮） | C4 增「`id` 为 number」 |
| 5.2-② | 无判据钉「脚本读的正是 audit-exceptions.json」 | C3 脚本文本断言增该文件名字面量 |
| 5.2-③ | pnpm 是否有 `.npmrc`/env 等价静音通道未验证 | §4 自证清单增 `pnpm config` 探针（找到 ⇒ 停下上报；找不到 ⇒ 登记「已核」） |

> 连带：设计层已同步微订正（附录 A #20：负⑨置换 / gitleaks 扩封 / D5-A1 声明位）；A′ 组对照由 12 条**细化**为 **15 条**（负 14 + 正 1，新增 C22–C24）——「＋25（10+15）上下」为新的回填预期基数。

---

## 1. 改动面一览（**19 行**：脚本与清单 4 · workflow 1 · 依赖 6 · conformance 2 · 文档 3 · 删除 2 · 条件 1）

> 标注：**新** = 新文件；**改** = 修改；**删** = 删除；**（条件）** = 依 trivy 首跑读数触发。

| # | 仓/包 | 文件 | 改动 | 来源 |
|---|---|---|---|---|
| A1 | scripts | `scripts/security/check-audit.mjs`（**新**） | 审计门脚本（CLI 契约见 §2.1）：`pnpm audit --prod --json --registry https://registry.npmjs.org`（**spawn 数组、不拼 shell**）→ 严格解析 + **形状断言**（fail-closed）→ 违例纯函数 `violations(advisories, exemptions, levels = LEVELS)` → 退出码。等级集合**逐字** `const LEVELS = ['critical','high'];`；`--self-test` = 负①–⑤ + 正①（§3 C26–C31） | D2 |
| A2 | scripts | `scripts/security/audit-exceptions.json`（**新**） | 豁免登记（schema 见 §2.2）：**当前恰好 2 条**（v3.2 扩：vite/1123525 + braces/1240992 —— 后者见 §0 v3.2） —— `{id, module, reason, reviewTrigger, ghsa（展示用）}` | D2/D6 |
| A3 | 规则 | `.gitleaks.toml` | 内容见 §2.3（`useDefault = true` + **恰好 8 条**带理由允许项〔v3.3/v3.4/v3.5/v3.6 四次扩；v3.6 含 #7 路径邻接扩面〕；**不得含**禁用/按规则放宽键——C6 封禁组） | D3 |
| A4 | 规则 | `.trivyignore`（**新**） | 政策头注释 + 首跑读数处置后的逐 ID 行（每条 ID 行的**前一行为 `#` 理由行**；格式见 §2.4；读数全空 ⇒ 只有注释） | D4 |
| B1 | workflow | `.github/workflows/ci.yml` | 新增 job `security-scan`（步骤骨架见 §2.5）：checkout（`fetch-depth: 0`）→ pnpm/node → 门脚本 → `--self-test` → gitleaks（钉版 v8.30.1 + sha256 校验 + `--exit-code 1`）→ trivy config（钉版 v0.75.0 + sha256 校验）；**不加** `permissions:`、不加 `schedule` | D1/D3/D4 |
| C1 | 编排 | root `package.json` | + `pnpm.overrides`（§2.6 表；**不新增** `pnpm.auditConfig`——被 C10 禁）；`patchedDependencies`（vitest 补丁）**不动** | D5/D2 |
| C2 | 6 服务 | `packages/{api-gateway,user-service,config-service,game-service,robot-service,room-service}/package.json` | `@nestjs/*` 逐包按 §2.6 矩阵升 `@^11`（**显式带主版本**；声明位逐一见 §2.6）。⚠️ `@nestjs/terminus` **全仓无声明 = 无动作**（设计 D5-A5 幽灵动作；实现期若出现声明 = 意外项，停下报） | D5-A1..A5 |
| C3 | room-service | `packages/room-service/package.json` | `@nestjs/config ^1.2.1 → ^12.0.1`；`@nestjs/axios ^1.0.1 → ^4.0.1`；`@nestjs-modules/ioredis ^1.2.4 → ^2.2.2` | D5-A2..A4 |
| C4 | user-service | `packages/user-service/package.json` | `sqlite3 ^5.1.7 → ^6.0.1`（devDependencies，与 root 对齐） | D5-A7 |
| C5 | client | `apps/client/package.json` | `"vite": "5.2.8" → "5.4.21"`（**精确钉，不加 `^`**；peer 违反预期 = warning 非失败，§7） | D5-B2 |
| C6 | 编排 | `pnpm-lock.yaml` | 全量重建；`pnpm why` 自证解析到 §2.6 的**全部下界**（multer 2.4.0 随 platform-express 11.2.7；tar 7.5.22；axios 1.20.0；brace-expansion 1.1.21/2.1.7；adm-zip 0.6.1；jpeg-js 0.4.4；ws 8.22.0；postcss 8.5.28；intlify 9.1.11；vite 5.4.21；lodash 随 @nestjs/config 12.0.1 **出树**） | D5-A9 收口 |
| D1 | 删 | `packages/robot-service/pnpm-lock.yaml`（**删**） | 陈旧嵌套 lockfile（被跟踪、无消费方——7 个 Dockerfile 均 `COPY` 根锁；无 `--dir/--prefix` 引用；实现期复核后随 C6 同提交删） | D5-A9/§5.1 |
| D2 | 删 | `packages/room-service/pnpm-lock.yaml`（**删**） | 同上 | 同上 |
| E1 | conformance | `tools/conformance/src/slices/slice-07.4-pipeline.ts` | + 谓词 `securityJobViolations(...)` 族（真断言与合成对照**共用**，R115）+ C1–C25（§3）；判定面 = `ci.yml` 文本、脚本文本、`.gitleaks.toml`、`.trivyignore`、`audit-exceptions.json`（JSON）、root `package.json`（JSON）、`.gitleaksignore` 的存在性、全仓文本（`gitleaks:allow` 有界遍历） | D7 |
| E2 | conformance | `tools/conformance/baselines.json` | `slice-07.4-pipeline` 的 `render`/`full` 两列下限按 **CI 实测**回填——**现基线 51 / 本机实跑 56**（R4 读数）＋ **19 条上下（实现形态：A 组聚合为 4 条 + 合成对照 15 条——R6 实跑口径）** ⇒ 预计 **~75**（以 CI 实测为准，render 列每 push 跑） | D7-B |
| F1 | 文档 | `docs/design.md:1656` 一带 | 补记第三个 job `security-scan`（三扫描器 · 门槛 · 与六阶段边界理由）；**§13.4 六阶段表不动** | §5.1 |
| F2 | 文档 | `docs/ops/first-deploy.md:723-724`（+复核 `:688`） | job 枚举改为含 `security-scan`（或改写为不枚举 job 的形态） | §5.1 |
| F3 | 文档 | `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md` | 收口时：M0.1 状态 + vite 豁免**复查触发**登记（`vite-plugin-uni` peer 放宽到含 6 / uni 官方支持 vite 6） | D6/§5.1 |
| G1 | （条件） | 根 `Dockerfile.*` ×7 + `douzero/Dockerfile` | **若 trivy 首跑命中「能修」桶** ⇒ 微调（D4 规则）；超一页规模 ⇒ **停下上报** | D4/§8 |

**不在改动面（有意）**：`scripts/ci.sh`（六阶段单真源，安全扫描不是六阶段之一）；其余三个 workflow；`docker-compose*.yml`——**本片默认无容器变更**（trivy 支线除外，见 G1）；`patches/vitest@2.1.9.patch`；`admin/`（无依赖）。

---

## 2. 新契约（写死）

### 2.1 `scripts/security/check-audit.mjs`（门脚本 CLI 契约）

- **调用形态**（被闸按**调用形态**识别，成例 `backupWiringViolations`）：
  - 判定模式：`node scripts/security/check-audit.mjs`（CI 的判定步）
  - 自证模式：`node scripts/security/check-audit.mjs --self-test`（**不触网**；CI 的独立步）
- **判定管线（顺序写死）**：
  1. **spawn（跨平台选形写死）**：`spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['audit','--prod','--json','--registry','https://registry.npmjs.org'], { cwd: repoRoot, shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })`——**数组传参、不拼 shell 字符串**（`shell:true` 仅 win32 且 args 全为静态字面量）；`--ignore-registry-errors` **不得出现**（任何形态，含注释剥离后文本）；
  2. **严格解析 + 形状断言（fail-closed，缺一即红，消息含原始 stdout 截断）**：
     `JSON.parse(stdout)` 失败 ⇒ 红；`parsed.error` 存在 ⇒ 红（注册表故障形态，设计 §2.1 三形态实测）；`typeof parsed.advisories !== 'object' || parsed.advisories === null` ⇒ 红；`typeof parsed.metadata?.vulnerabilities !== 'object' || parsed.metadata?.vulnerabilities === null` ⇒ 红；
  3. 收集 `{id, module_name, severity}`（去重通告口径）；**等级集合逐字** `const LEVELS = ['critical','high'];`（引号与次序为判据的一部分，C3）；
  4. **纯函数** `violations(advisories, exemptions, levels = LEVELS)`：违例 = `levels` 级通告集 − 豁免集（匹配语义 = `(id, module)` **精确对**，`id` 为**数字**；`ghsa` 字段**不参与匹配**）⇒ 非空 ⇒ 逐条打印 + EXIT 1；
  5. **纯函数** `staleExemptions(advisories, exemptions)`：豁免集 − 当前通告集（按 (id,module) 对）⇒ 非空 ⇒ 打印「已不再被报出，请从 audit-exceptions.json 删除」+ EXIT 1；
  6. 全过 ⇒ 打印一行汇总（覆盖的通告数 / 豁免数）+ EXIT 0。
  - ⚠️ **exit code 不作判据**（pnpm 的 1 无法区分「有漏洞」与「注册表故障」）——stdout 形状是唯一权威。
- **`--self-test` 的合成输入**（喂**同一**纯函数/形状断言谓词，R115；六条见 §3 C26–C31）。
- **输出分寸**：打印违例的 `id/module/severity/title 截断`；**不打印** `findings[].paths` 全文（噪声）。

### 2.2 `scripts/security/audit-exceptions.json`（schema 写死）

```json
[
  {
    "id": 1123525,
    "module": "vite",
    "reason": "修补只在 vite≥6.4.3；uni 构建栈整体锁在 vite5（@dcloudio/vite-plugin-uni 精确 peer vite=5.2.8，在用版与最新 alpha 双双如此）；影响面 = vite dev server 的 server.fs.deny Windows 旁路（玩家/生产不可达）。",
    "reviewTrigger": "vite-plugin-uni 的 vite peer 放宽到含 6（或 uni 官方声明支持 vite 6）⇒ 重审本豁免并升 6.x。",
    "ghsa": "GHSA-fx2h-pf6j-xcff"
  }
]
```
- 四字段 `id`/`module`/`reason`/`reviewTrigger` **必填非空**；`id` 为 **number**（C4）；`ghsa` 可选（仅展示）。
- **当前恰好 1 条**（C4 按「(id,module) 集合恰好 = 登记集」断言——新增条目必须同提交改闸 = 显式登记）。

### 2.3 `.gitleaks.toml`（内容写死）

```toml
# 本仓的 gitleaks 配置（全历史扫描；见 docs/superpowers/specs/2026-10-02-security-scan-*）。
# 允许项只许是「保留字面量」型豁免（测试夹具 / 文档示例），不许是「修不了」型；每条必须带理由。
# ⛔ 禁用键四类（名单见规格 C6 判据行——本文件不得出现其字面量）。
[extend]
useDefault = true

[[allowlists]]
description = "日志脱敏用例的测试夹具 JWT（redact.test.ts:53 构造的样本，非真密钥、无泄露面）"
paths = ['''packages/shared/src/logging/redact\.test\.ts$''']

[[allowlists]]
description = "dev 内部占位 token 字面量（生产 compose 无默认值 ${INTERNAL_SERVICE_TOKEN:-}；文档 curl 示例必须保留该字面量）"
regexTarget = "match"
regexes = ['''dev-internal-token-change-in-production''']

[[allowlists]]
description = "alert-relay 钉钉签名测试夹具的固定向量假 secret（sign/sinks/server 三个测试文件；钉钉加签向量需固定值、不可改运行时拼接；显式假值、非真凭据、无泄露面。复查触发：三文件引入其他高熵字面量或夹具形态变化 ⇒ 重审本条）"
paths = ['''packages/alert-relay/test/(sign|sinks|server)\.test\.ts$''']

[[allowlists]]
description = "支付片 T6 支付宝金标夹具的固定测试密钥对（规格 ⚙️14/§12 明示「仅测试密钥对入仓；生产密钥永不入仓、只存服务器 .env」——自造密钥对，仅用于验签/签名金标回放与造假负例，真凭据从未进入仓库。复查触发：该文件引入测试密钥对以外的任何高熵字面量、或夹具形态变化【如改为测试内运行时生成】⇒ 重审本条）"
paths = ['''packages/payment-service/test/fixtures/alipay/keys\.json$''']

[[allowlists]]
description = "支付片 T16 conformance 支付宝测试密钥夹具目录（规格 ⚙️14：仅测试密钥对入仓、= T6 keys.json 同一对；stub 只读挂载 /keys 消费 + conformance-stack.sh 就此 base64 注入 payment-service。复查触发：该目录引入测试密钥对以外的任何高熵字面量、或夹具形态变化【如改为运行时生成/额外文件】⇒ 重审本条）"
paths = ['''tools/conformance/fixtures/alipay-test/''']

[[allowlists]]
description = "通知通道管理化片 config-service 测试夹具的固定测试主钥与假凭据字面量（⚙️13 dev 主钥字面量、假钉钉加签密钥/假 webhook 值；自造测试值、非真凭据、无泄露面；gitleaks default generic-api-key 误伤。复查触发：四文件引入上述夹具以外的任何高熵字面量、或夹具改为运行期生成 ⇒ 重审本条）"
paths = ['''packages/config-service/test/notify-channel\.(controller|metrics|service|crypto)\.test\.ts$''']

[[allowlists]]
description = "支付配置管理化片 config-service 测试夹具同族字面量（固定测试主钥 DEV_KEY_B64/DEV_ENC_KEY_B64 与假 PEM 负例；自造测试值、非真凭据。该片提交时 gitleaks 未随 CI 执行【Actions 额度耗尽】，全历史复核在通知片 T17 补做、就地补列。复查触发：五文件引入测试主钥/假凭据以外的任何高熵字面量、或夹具改为运行期生成 ⇒ 重审本条。⚠️ 广告片 T20（v3.6）邻接扩面：pay/ad-channel 测试族同为该主钥字面量消费面，path 一并覆盖——扩面窗口 = T20 提交前本机全历史实跑 3 条 `generic-api-key`（commit `430e0db` 引入）现身；若无此扩面，本分支 push 后 security-scan job 必红）"
paths = ['''packages/config-service/test/(config\.rpc|(pay|ad)-channel\.(controller|crypto|service|validators))\.test\.ts$''']

[[allowlists]]
description = "广告片 T20 conformance 广告回调测试密钥夹具目录（规格 §5.4：测试密钥对入仓、生成器照 alipay-test 形态；helper 只读装载 callback-private.pem 签回调样本 + 产品侧验签核心消费同对公钥。自造测试密钥、非真凭据、无泄露面。复查触发：该目录引入测试密钥对以外的任何高熵字面量、或夹具形态变化【如改为运行时生成/额外文件】⇒ 重审本条）"
paths = ['''tools/conformance/fixtures/ad-callback/''']
```
- 断言（C6）：`useDefault = true` 存在；`[[allowlists]]` **恰好 8**（v3.3/v3.4/v3.5/v3.6 四次扩；v3.6 另做 #7 路径邻接扩面、条目数不变）；path 条目 = 上述字面量（**含 `$` 锚定**；redact 一条 + alert-relay 一条 + 支付 T6 密钥夹具一条 + notify-channel 一条 + `(pay|ad)-channel` 族一条；**支付 T16 / 广告 T20 各为目录锚定一条**〔fixtures 目录内文件集合会随夹具增删变化，锚目录即够——新增非密钥文件仍受 description 复查触发约束〕）；regex 条目 = 上述字面量**相等**（非仅「非空非 `.*`」）；禁用键四串**不出现**。

### 2.4 `.trivyignore`（格式写死）

- 头注释固定（用途 / 依据 / 复查规则：条目 = 逐 ID 一行 + **其上一行**为 `#` 理由行）。
- 条目结构：**ID 行**（单独一行）+ **紧邻上一行为 `#` 理由行**（断言 C7）。
- ID 形态（族白名单）：`CVE-<4位年份>-<≥4位数字>` · `GHSA-<4>-<4>-<4>`（小写字母与数字）· `AVD-DS-<4位数字>`。
- **禁止**：`*`/通配、`exp:` 过期形态、ID 行行尾内联注释（理由一律在上一行）、按路径/前缀的宽豁免。
- 首跑读数全空 ⇒ 文件只含头注释（**仍入库**：它是登记点）。

### 2.5 `.github/workflows/ci.yml` · `security-scan` job（步骤骨架写死）

```yaml
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # gitleaks 全历史的地基
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20      # ⚠️ 不加 cache: pnpm——本 job 不跑 install、无 store 可缓（v3.1 订正；带缓存会让 post-step 保存失败把 job 判红，master 首跑实测）
      - name: 依赖漏洞（门脚本）
        run: node scripts/security/check-audit.mjs
      - name: 门脚本行为自证
        run: node scripts/security/check-audit.mjs --self-test
      - name: 密钥泄露（gitleaks 全历史）
        run: |
          curl -fsSLo /tmp/gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
          echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  /tmp/gitleaks.tar.gz" | sha256sum -c -
          tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
          /tmp/gitleaks detect --source . --config .gitleaks.toml --redact --no-banner -v --exit-code 1
      - name: 配置误配（trivy config）
        run: |
          curl -fsSLo /tmp/trivy.tar.gz https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz
          echo "c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f  /tmp/trivy.tar.gz" | sha256sum -c -
          tar -xzf /tmp/trivy.tar.gz -C /tmp trivy
          /tmp/trivy config --severity HIGH,CRITICAL --exit-code 1 --ignorefile .trivyignore .
```
- **两个 sha256 = 官方 release checksums 实值**（2026-10-02 经 `gh release download` 取回；原件在 SDD `gitleaks-checksums.txt`/`trivy-checksums.txt`）；升级版本 = 同改 URL+sha 两个字面量。
- **旗标白名单（C6）**：**作用域 = 本步「以 `/tmp/gitleaks` 起的、含 `detect` 的那条命令行」**（续行拼接后按 shell token 分割；本步其余行——curl/sha256sum/tar——**不参与**）；该命令行内允许出现的旗标**恰好** `--source`（值 `.`）· `--config`（恰好一次，值 `.gitleaks.toml`）· `--redact`（恰好一次）· `--no-banner` · `-v` · `--exit-code`（恰好一次，值 `1`）+ 子命令 `detect`；**该命令行内其余任何 `-` 开头 token = 红**（`--baseline-path` 等抑制类旗标由此封死）。
- `run:` 体**无** `${{ … }}`（I1）；**无** `|| true` / `; exit 0` / `set +e`（C5）；**无** `continue-on-error`（步骤级与 **job 级**，C5）。
- ⚠️ 实现期自证三项（记报告）：① 钉版 gitleaks 子命令（8.19+ 主命令为 `git`、`detect` 为兼容路径）与 `--exit-code` 旗标名的存在性（以钉版 `--help` 为准；若形态有变 ⇒ 按钉版实际改本骨架**并同改 C2/C6 的识别与白名单**）；② 钉版 trivy 的 `--ignorefile` 旗标名；③ tar 成员名（`gitleaks`/`trivy`）。

### 2.6 依赖版本矩阵（修复批写死；lockfile 由 `pnpm install` 重建，`pnpm why` 自证下界）

| 声明位（逐一，R4 订正后） | 包 | 现值 | **目标** | 清掉（设计 §2.2） |
|---|---|---|---|---|
| 6 服务 `dependencies` | `@nestjs/common` · `core` · `platform-express` | ^10.4.0 | **^11.2.7** | microservices 通告随家族 |
| 6 服务 `dependencies` | `@nestjs/microservices` | ^10.4.0 | **^11.2.6** | ×2 |
| **仅 room** `dependencies` | `@nestjs/platform-socket.io` | ^10.4.0 | **^11.2.7** | — |
| **gateway + room** `dependencies` | `@nestjs/websockets` | ^10.4.0 | **^11.2.7** | — |
| 6 服务 `devDependencies` | `@nestjs/testing` · `cli` | ^10.4.0 | **^11.2.6** · **^11.0.24** | — |
| gateway/user/config `dependencies` | `@nestjs/jwt` | ^10.2.0 | **^11.0.2** | — |
| gateway/user `dependencies` | `@nestjs/passport` | ^10.0.0 | **^11.0.5** | — |
| user/config `dependencies` | `@nestjs/typeorm` | ^10.0.0 | **^11.0.3** | — |
| room `dependencies` | `@nestjs/config` | ^1.2.1 | **^12.0.1** | lodash ×1 |
| room `dependencies` | `@nestjs/axios` | ^1.0.1 | **^4.0.1** | axios 链上游 |
| room `dependencies` | `@nestjs-modules/ioredis` | ^1.2.4 | **^2.2.2** | terminus→axios@1.0.1 旧链整体消失 |
| （全仓） | `@nestjs/terminus` | **无声明** | **无动作**（出现声明 = 意外项，停下报） | — |
| user `devDependencies` | `sqlite3` | ^5.1.7 | **^6.0.1** | node-gyp8/tar6 链 |
| client `devDependencies` | `vite` | `5.2.8`（精确） | **`5.4.21`**（精确） | 1120061（清 12/15） |
| root `pnpm.overrides` | `axios` | — | **^1.16.0** | ×12 |
| root `pnpm.overrides` | `tar` | — | **^7.5.22** | ×9（含 critical；含 bcrypt 生产链） |
| root `pnpm.overrides` | `brace-expansion@1` / `@2` | — | **^1.1.20** / **^2.1.6** | ×4 |
| root `pnpm.overrides` | `adm-zip` · `jpeg-js` · `ws` · `postcss` | — | **^0.6.1** · **^0.4.4** · **^8.21.3** · **^8.5.18** | 11 条（客户端工具链） |
| root `pnpm.overrides` | `@intlify/core-base` · `@intlify/message-resolver` | — | **`9.1.11`**（精确） | ×2（族内一致） |
| root `pnpm.overrides` | `vite` | — | **`5.4.21`**（与 C5 对齐） | 兜底（防嵌套拷贝） |

- **规则**：一律**显式 `@^11`**；禁 `@latest`/裸包名（`latest` 已指 12 线）。overrides 的 **键选择子**（如 `brace-expansion@1`）与**目标书写**以实现期 `pnpm install` + `pnpm why` 实测为准（硬约束 = **解析结果下界**）。矩阵内 `microservices`/`testing` 的 **11.2.6 系镜像口径**读数（`^` 解析到该线最新）——以实际解析为准。
- **multer 随动下限**：`@nestjs/platform-express ≥ 11.2.6`（携 multer ≥2.4.0）；今天解析 11.2.7 ⇒ 无需 override。若解析 <11.2.6 ⇒ **停下上报**。

---

## 3. 判据（C1–C33 形式化）

> 载体：C1–C25 进 `slice-07.4-pipeline`（新谓词族 `securityJobViolations(...)`——**真断言与合成对照共用同一谓词**，成例 `backupWiringViolations`/`tagComposeFetchViolations`）；C26–C31 在门脚本 `--self-test`（CI 独立步）；C32–C33 为行为自证（报告留档）。**全部可 `--render` 跑**（纯文本/JSON/有界遍历，不碰 docker）。

**A 组（接线断言，对真文件）**：

| # | 断言 | 判别力来源 |
|---|---|---|
| C1 | `ci.yml` 含 job `security-scan` | 成员式（成例 :492-496） |
| C2 | 四步**识别语义写死**：四模式（`node scripts/security/check-audit.mjs` / 同命令 + `--self-test` / `gitleaks detect` / `trivy config`）各取**首个命中的步骤下标**，须**两两不同且严格递增**；仅认 `run:` 体的执行形态（注释不算——成例 :236-240 的「提到 ≠ 执行」纪律；**实现注记：以「丢弃行首（trim 后）为 `#` 的行」实现「注释不参与」**——R5 探针证明不剥注释时注释诱饵可假绿） | 严格递增使 C11 必红；注释喂词两侧均不参与 |
| C3 | 门脚本文本**执行语句提取**（**先剥注释——用 N46 唯一真源 `stripComments`（块+行注释、`:守卫`、引号不感知为其已知边界）；注释不参与**；v3.1 订正）：① `spawnSync(…)` 调用的**数组实参字面量**（跨平台三元式的第二实参）token **恰好** = `['audit','--prod','--json','--registry','https://registry.npmjs.org']`；② `const LEVELS = <字面量>` 的值为**恰好** `['critical','high']`（含引号与次序）；③ 剥注释后的全文**不含** `--ignore-registry-errors`；④ 全文含字面量 `scripts/security/audit-exceptions.json`（防把豁免实现挪走而切片看着旧文件） | 注释不参与提取；token 恰好（成例 `sameTermSet`） |
| C4 | 豁免文件存在 + JSON 四字段非空（**`id` 为 number**）+ **（id,module）集合恰好 = 登记集**（当前 `{（1123525,'vite'）,（1240992,'braces'）}`——v3.2 扩，见 §0） | 集合恰好（成例 B1） |
| C5 | security-scan 的**步骤**与 **job 节点**均**无** `continue-on-error: true`；其 `run:` 体**无** `\|\| true` / `; exit 0` / `set +e` | 旁路形态三连 + job 级（R4-🟡4） |
| C6 | **gitleaks 封禁组**：① **gitleaks 命令行**（作用域见 §2.5）旗标白名单——允许集之外的 `-` token = 红；`--config`/`--exit-code` 恰好一次且值钉死；② 该命令行含 `--redact`；③ `.gitleaks.toml` 存在且**剥 `#` 行注释后**：`useDefault = true`；`[[allowlists]]` **行首**恰好 8（v3.3/v3.4/v3.5/v3.6 四次扩；v3.6 另做 #7 路径邻接扩面、条目数不变）；path 条目 **= 带 `$` 锚定的登记字面量**（redact 一条 + alert-relay 一条 + 支付 T6 密钥夹具一条 + 支付 T16 / 广告 T20 目录锚各一条 + config-service `(pay\|ad)-channel` 族一条，逐字 pin）；regex 条目 **= `dev-internal-token-change-in-production`**；四串禁用键（**`disabledRules` / `rules.disabled` / `rules.allowlists` / `disableRuleIDs`**——v3.1 枚举）**不出现**；④ 仓库根 `.gitleaksignore` **不存在**；⑤ 全仓（有界遍历，跳过 `node_modules`/`.git`/`.superpowers`/`.worktrees`/`test-results`/`dist`/`.pnpm-store`/**`docs/superpowers`**/**`tools/conformance`**）无字面量 `gitleaks:allow`——**切片源码与合成夹具内的该字面量必须运行时拼接（不落连续字面量）**；两面残面登记于 §9 | 封禁组（R4-🔴1 + R5-🟠1/2/3 收紧；与 C10 同族立法；v3.3 计数 2→3、v3.4 计数 3→4、v3.5 计数 4→5、v3.6 计数 7→8） |
| C7 | trivy 步骤 run 体含 `--exit-code 1` · `--ignorefile .trivyignore` · `--severity HIGH,CRITICAL`；`.trivyignore` 存在且：每条非注释行匹配**族白名单** `^(CVE-[0-9]{4}-[0-9]{4,}\|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}\|AVD-DS-[0-9]{4})$`；每条 ID 行的**前一行为 `#` 理由行**；无 `*`/`exp:` 形态。**实现注记：行级断言对 `\r` 敏感——须 `trimEnd`**（防 Windows CRLF 下「本地红 / CI 绿」；本机 `core.autocrlf=input`） | 族白名单（R4-🟠3；R5 边界复核通过） |
| C8 | security-scan 的 checkout 含 `fetch-depth: 0` | 浅检出 = 静默扫 1 commit |
| C9 | self-test 步骤存在（`--self-test` 调用形态） | 行为自证有自动调用点（成例 ci.yml:66） |
| C10 | root `package.json` **不含** `auditConfig`/`ignoreCves`/`ignoreGhsas` 任意嵌套键 | 静默静音面封禁（设计 §2.1 实测能力存在） |

**A′ 组（合成对照，喂同一谓词组；负 14 + 正 1 = 15）**：

| # | 合成输入（每种 = 一条**具体**改写） | 必须 |
|---|---|---|
| C11 | 负①：audit 步 `run:` 体删门脚本调用（裸命令形态） | 红 |
| C12 | 负②：C3 的等级集合缩水（只剩 `'critical'`） | 红 |
| C13 | 负③：门脚本文本出现 `--ignore-registry-errors` | 红 |
| C14 | 负④：security 步骤**或 job 节点**加 `continue-on-error: true` | 红 |
| C15 | 负⑤：run 体加 `\|\| true` 旁路 | 红 |
| C16 | 负⑥：gitleaks 步骤缺 `--config .gitleaks.toml` | 红 |
| C17 | 负⑦：允许项放宽（path 改整目录 / regex 改 `.*` 或 `dev`） | 红 |
| C18 | 负⑧：豁免集多一条未登记 id | 红 |
| C19 | 负⑨：删 `fetch-depth: 0`（浅检出）——**C8 的专属对照**（R4-🟠4 置换） | 红 |
| C20 | 负⑩：root package.json 出现 `auditConfig.ignoreCves` | 红 |
| C21 | 负⑪：trivy `--severity` 缩水（`HIGH,CRITICAL` → `LOW`） | 红 |
| C22 | 负⑫：gitleaks 步追加 `--baseline-path xxx`（旗标白名单外） | 红 |
| C23 | 负⑬：`.gitleaks.toml` 加 `disabledRules`（或 `[[rules.allowlists]]`） | 红 |
| C24 | 负⑭：合成输入置「`.gitleaksignore` 存在」/「某文件含 `gitleaks:allow`」 | 红 |
| C25 | 正①：真文件形态（修毕）喂同一谓词组 | 判齐（防谓词恒红） |

**B 组（门脚本 `--self-test`，C26–C31 = 负①–⑤ + 正①；纯函数喂合成输入）**：

| # | 用例 | 必须 |
|---|---|---|
| C26 | 负①：形状断言喂四种坏形态（非 JSON / `{"error":{…}}` / advisories 缺失 / `metadata.vulnerabilities` 为 null） | 四种都判「形状错」 |
| C27 | 负②：未登记 high（默认 LEVELS） | `violations` 非空 |
| C28 | 负③：豁免条目陈腐（不在通告集） | `staleExemptions` 非空 |
| C29 | 负④（机制对偶）：`violations(…, levels=['critical'])` + 未登记 high ⇒ **空**（证明 levels 参数生效）；**同输入喂默认 LEVELS ⇒ 非空**（这对用例即 **LEVELS 完整性守卫**：有人把 `'high'` 从默认集合摘掉 ⇒ 第二条用例自身红） | 如上 |
| C30 | 负⑤：豁免按 `module` 泛化（同 module 另一 id 企图被放） | 该 id 仍进违例 |
| C31 | 正①：通告集只剩豁免条目 | `violations` 空 + `staleExemptions` 空 |

**C 组（行为自证，报告留档）**：C32 gitleaks 允许清单 A/B（拿掉允许项 ② ⇒ 重新报出那 2 条；装回 ⇒ 0）；C33 trivy `--exit-code 1` 行为（首跑读数非空天然自证；全空则合成 Dockerfile 演示）。

**门槛与收口读数（签收用，非 conformance 断言）**：门脚本 EXIT 0；**裸** `pnpm audit --prod --audit-level high` 仍 EXIT 1（豁免生效自证）；钉版 gitleaks 0 findings；trivy 读数归档。

---

## 4. 测试与自证（含「会红的既有判据」）

1. **门脚本自测**：`node scripts/security/check-audit.mjs --self-test`（本地 + CI 步）——C26–C31；⚠️ 本地 Windows 亦须跑通（§2.1 的跨平台选形即为此）；
2. **conformance 扩展**：`node tools/conformance/dist/run.js slice-07.4-pipeline --render`（本地 + render-gate）——C1–C25；构建前提：`pnpm exec turbo run build --filter=@fight-the-landlord/conformance...`；
3. **会红的既有判据 / 需同改项（实现期先全仓 grep）**：
   - `baselines.json`：E2（按 CI 实测回填）；
   - `first-deploy.md:688/:723-724`（F2）；
   - `docs/design.md` 的 render-gate 段（F1）与**任何**引用「ci.yml 两个 job」的文档句（`grep -rn "render-gate" docs/`）；
   - I1 的 `runBodies >= 12`（实测 23 ⇒ 本片 +4 = 27，只增不减，无动作）；
   - M9 前缀闸：本片**不新增**任何 `ghcr.io/…` 字面量（下载 URL 在 `github.com/.../releases/download/...`）；
   - **EXPECTED_FILES 闭集：本片不新增 workflow 文件 = 不动作**（对账闭环）；
4. **依赖批验证**：`pnpm install --frozen-lockfile` → `pnpm why` 逐包核对 §2.6 下界 → 六阶段 `pnpm run ci` 全绿 → client 单测 → **全序 conformance**；
5. **钉版首跑读数回填**（gitleaks 全量、trivy config 读数）——豁免/`.trivyignore` 的最终依据（设计 D8#6）；trivy 读数处置：能修 ⇒ G1 条件行；超一页 ⇒ 停下上报；
6. **静默通道探针**（R4-5.2③）：`pnpm config` 探查 `.npmrc`/env 是否存在等价 `ignoreCves` 类静音通道——找到 ⇒ **停下上报**；找不到 ⇒ 登记「已核」（残余面收口）；
7. **C6⑤ 的性能注记**：全仓 `gitleaks:allow` 有界遍历只在 slice-07.4 跑一次；CI 检出树干净；`.pnpm-store` 已在跳列（本机 479MB 缓存；**热身实测全树 ≈48s**——R5 读数；冷启动首次可能更慢）；耗时记报告。（v3.6 备注：`tools/conformance/fixtures/ad-callback/` 落在既有 `tools/conformance` 跳列内——其 gitleaks 面由允许项 #8 目录锚 + C6③ pin 双钉覆盖，**不新增全仓遍历面**。）

## 5. conformance 与回填流程

1. 本地：`--render` 跑新断言 → 记条数（预期 ~75 = 56 + 19 上下；R6 实跑口径——以 CI 实测为准）；
2. push 后 CI：render-gate 跑 `slice-07.4-pipeline --render`，`check-baselines render` 因**基线未回填**而红 ⇒ 按既有流程**只按 CI 实测回填**（`render` 与 `full` 两列同抬）；
3. 全序 conformance（真栈）在验收轮跑一次，full 列读数以其为准。

## 6. 部署与回滚

- **无部署动作**（不打 tag、不发版；生产形态零变化）。
- CI 改动 **push 即生效**；「环境故障 vs 真红」判别后分别处置。
- 回滚 = revert 对应 commit（建议提交切分：依赖批 / 脚本与清单 / workflow / conformance / 文档 / 删除 / Dockerfile 微调（**若发生**，G1））。

## 7. 兼容面（可测的部分）

| 面 | 预期 | 证据方式 |
|---|---|---|
| Nest 11 / Express 5 | 通配符路由（`*` → `*splat`）等破坏性变化由全序 conformance 覆盖 | conformance 全绿 |
| **Nest 11 配套矩阵外冲突** | 若出现（含 @nestjs-modules/ioredis 无 11 兼容版的替代情形） | **停下上报**（设计 §4） |
| client vite 5.4.21 | **违反** `vite-plugin-uni` 精确 peer `{vite:"5.2.8"}` ⇒ pnpm **warning 非失败** | `pnpm install` 输出 + `uni build`（阶段 3）全绿 |
| uni 工具链 overrides | H5 链由 `uni build` 每次门禁检验；**mp 链（jpeg-js/ws）无自动面**（mp 冻结）——登记；**若破 ⇒ 回退该条 override 并报到设计层**（换登记豁免讨论，不静默） | 阶段 3 全绿 / 否则停报 |
| 扫描器钉版升级 | = 显式改 URL+sha256（可 review）；识别形态（C2/C6）**同提交**同步 | 静态断言 |
| npmjs 可达性 | 故障 = 形状断言红（响亮） | 首跑读数 |
| vitest 补丁 | `patches/vitest@2.1.9.patch` **不动** | 六阶段阶段 4 全绿 |

## 8. 明确不做（同设计 §7）

ZAP 渗透 · trivy 镜像扫描 · schedule/告警通道（**监控片**——原 M0.2 并入）· dependency-review/Dependabot · dev-only ≥high 8 条与 moderate/low 65 条（门槛面外）· SARIF/PR 评论 · 门槛面收窄（语义重议题）。

## 9. 风险与**停报清单**

同设计 §8（最大 = Nest 11 改坏运行时 ⇒ 全序 conformance 硬门 + 不发布；次大 = 闸做空 ⇒ C11–C25 + B 组 + C6/C10 封禁组）。

**停报清单（实现期遇到即停下按流程上报，不许就地放宽——设计 D6/§4 三处口径随行，R4-🟠5）**：
1. 修复后 red 不止 vite/1123525 这一条豁免 ⇒ 停报（不许把门槛降级、不许加第二条豁免）；
2. Nest 11 配套矩阵出现冲突（含 ioredis 无 11 兼容版的替代情形）⇒ 停报；
3. uni 工具链 override 破 `uni build` ⇒ 回退该条 override 并报到设计层（换登记豁免讨论，不静默）；
4. trivy 首跑读数「能修」桶超一页规模 ⇒ 停报；**另**：`pnpm config` 探到等价静音通道 ⇒ 停报。

**C6⑤ 残面登记**：`docs/superpowers/**` 与 `tools/conformance/**` 两面不在全仓字面量扫描范围内（前者是合同文档必须公示该字面量；后者因实现与夹具一律运行时拼接而不落字面量）——这两面内出现注释放行将不被该 meta 扫覆盖，由 review 纪律兜底（**残余面登记，不静默**）。

## 10. 下一步

1. 本文（v2）**过修复验证**（R5：R4 各项处置落地 + 新计数一致性 + C6/C7 谓词可实现性）；
2. 定稿 ⇒ **计划层**（`writing-plans`：依赖批 / 脚本与清单 / workflow / conformance / 文档收口 五组任务，各独立提交）→ 审计划 → 实现 → 自测（§4）→ 收口（§5 + F3）。
