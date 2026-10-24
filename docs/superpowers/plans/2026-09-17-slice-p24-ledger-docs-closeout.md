# 切片 P24 实施计划：收口台账 §3「文档待更新」的 9 行 + `design.md` 附录 A.2 本体的活状态断言

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/superpowers/plans/deviation-ledger.md` **§3「文档待更新」**里**所有没有 ✅ 的行**处置完
（机械底数：§3 区块共 **27** 条 `^|` 行，含表头/分隔行 ⇒ **25** 条数据行，其中**不含 ✅ 的 8 行**），
主项是 **`docs/design.md` 附录 A.2 表本体的多行描述与当前代码不符**（P8 只处理了一部分并明确「留给下一片」）。

**Architecture:** **与 P13/P8 完全同形**（照抄它们的成败经验）：本片**零代码改动** ⇒ **轻量门禁**（R491/R395 同族）
+ 一条**防伪**（`git diff --stat` 出现任何非 `docs/` 路径 ⇒ 轻量门禁作废、按标准门禁跑全套）。
执行模型 = **2 个只读审计 agent**（各出一份证据表，**不写文件**）+ **协调者逐处编辑**
（不派写 agent：本片是「逐行判断 → 逐处编辑」，且多处编辑落在**同一批文件**上，派写 agent 只会引入三方同改风险）。

**Tech Stack:** 无（纯 markdown）。验证靠 `grep`/`read`/`git show` + 既有台账脚本。

**Spec:**
- `docs/design.md` —— **附录 A.2**（表本体 + 1683–1690 的头部声明）· **附录 A.3**（处置约定）· §0.2（标记约定）· §13.1/§13.4（测试与 CI 规格）
- `docs/superpowers/plans/deviation-ledger.md` —— **§0**（总数，由 `scripts/ledger-counts.mjs` 校验）· **§1.x**（状态唯一真源）· **§3**（本片作业面）· **§5**（维护约定）
- `docs/superpowers/plans/2026-09-16-slice-p8-docs-review.md` —— **R396/R399/R402**（A.2 钉成历史快照 + 状态单向指向台账）
- `docs/superpowers/plans/2026-09-17-slice-p13-doudizhu-docs-review.md` —— **R491–R505**（轻量门禁 + 四类处置计数 + 成对编辑）
- `docs/superpowers/plans/agent-briefs.md` —— 「交接现状」的「下一步（按序）」行 + 「已知环境事实」

## Global Constraints

1. **本片不得改任何代码**（`packages/**`、`apps/**`、`scripts/**`、`tools/**`、根配置一律不动）；
   发现实现与文档不符 ⇒ **登记**（台账 §1.5 / §3），**不修**。
2. **只允许改**：`docs/design.md`、`docs/superpowers/plans/deviation-ledger.md`，
   外加收口时 `docs/superpowers/plans/agent-briefs.md` 与本文件。
3. **证据先于结论**：每条处置都必须附**当前代码的原文**（`文件:行` + 代码）+ 一条**可复现的复核命令**。
4. **无法确认一律保留**，并**逐字写明缺什么证据**。
5. **计数只按形态**（`grep -c` / 行计数命令），**命令里不得出现写死的行号当判据**
   （P7 教训 7：写死行号曾给出 21/24/22 三个数）。
6. **删一条的判据是「代码证伪了它」，不是「它看起来旧」**（R396）。
7. **派子 agent 时禁止** `git stash` / `git reset` / `git checkout <旧 commit>` / `git switch`
   （本会话有过因这些命令丢 commit 的事故）；只读 agent 允许 `git show <sha>:<path>`。

---

## 绑定数值（开工前实测，**本片判据的底数**）

| 项 | 数值 | 命令 |
|---|---|---|
| 起点 commit | `1d4564a` | `git log --oneline -1` |
| 工作区 | 干净 | `git status --short` |
| 台账 §0 | **98：97 已关闭 / 1 部分关闭 / 0 仍开放** | `node scripts/ledger-counts.mjs` |
| §3 区块 `^\|` 行数（含表头 + 分隔行） | **27** | 见 Task 0 Step 1 |
| §3 数据行 | **25** = 27 − 表头 1 − 分隔 1 | 同上 |
| §3 中**不含 ✅** 的 `^\|` 行 | **10** = 8 条数据行 + 表头 + 分隔行 | `… \| grep '^\|' \| grep -vc '✅'` |
| §3 中含 ✅ 的 `^\|` 行 | **17**（数据行） | `… \| grep '^\|' \| grep -c '✅'` |
| A.2 表**数据行**数（机械口径） | **53** = S1–S8(8) + C1–C28 去 C21(27) + A1–A8(8) + E1–E10(10) | 见 Task 0 Step 2 |
| A.2 表**全部 `^\|` 行**数 | **61** = 53 数据行 + 4 组表头/分隔（4×2） | 同上 |
| A.2 行集合在基准点是否一致 | **一致**（`fafb36a` / `a2e16f4` / `HEAD` 三处逐编号完全相同） | 见 Task 0 Step 2 |
| 审计基准 commit 的真实日期 | `fafb36a` **2026-09-13**（审计**执行**于 2026-09-14 —— 见 `.superpowers/.../audit-correctness-1.md` 首行） | `git log -1 --format='%h %ad' --date=short fafb36a` |
| ⚠️ **A.2 的「表快照基准」≠「审计基准」**（执行期发现，见 R614） | 表快照 = **`3da457f`**（2026-09-13 **10:07**，v4.0 文档合并）；审计基准 = **`fafb36a`**（同日 **19:26**）；**相隔 99 个 commit** | `git log -1 --format='%h %ad %s' 3da457f` |
| A.2 行集合的历史序列 | **37**（`3da457f`）→ **50**（`a4bf89a`）→ **49**（`73c6c9a`）→ **52**（`6d737d5`）→ **53**（`8f15ba8` = `fafb36a` = `HEAD`） | 逐 commit 枚举编号集合 |
| 已用最大裁决号 | **R592**（P23 用了 R591/R592；P23 声明的区间是 R591–R600） | `grep -rhoE "R[0-9]{3}" docs/ --include=*.md \| sort -u \| tail` |

---

## 协调者裁决（本片新增，区间 **R601–R616**）

> 编号接 P23 声明的区间（R591–R600），本片协调者区间 **R601–R616**。**只读审计 agent 不产出裁决编号。**

- **R601 本片门禁是轻量门禁**（**逐字复用 R491/R395**）：只改 `docs/**` ⇒ 不跑 `build --force`、
  不重建镜像、不跑 13 条 conformance、不跑真浏览器探针（它们**不读 `docs/**`**，信息量为零）。
  **门禁** = ① `git diff --stat` 证明改动**只落在 `docs/**`**（**本片唯一真正需要机械证明的事**）；
  ② `pnpm exec turbo run test lint --force`（29/29、0 cached，廉价兜底）；③ `node scripts/ledger-counts.mjs` ✅；
  ④ 逐条 `grep`/行计数自证（见 Task 4）。
  ⚠️ **防伪**：若 `git diff --stat` 出现任何非 `docs/` 路径 ⇒ **本裁决作废**，按标准门禁跑全套。
- **R602 本片只改文档**（Global Constraint 1）：审计若翻出**真缺陷**，**只登记不修**，
  写进台账 §1.5（新 N 系列，编号从 **N46** 起）或 §3，并逐字写明「本片未修」。
- **R603 A.2 的「活状态断言」与「历史快照散文」**必须分开处置**（本片最核心的一条）。
  A.2 自 P8/R402 起被钉成**审计基准 `fafb36a` 的历史快照**，其「偏差」列**预期就是过期的**
  ⇒ **不逐行追改**（那正是 R402 明令放弃的做法，理由是「同一事实的第二份叙述」必然再过期）。
  **但**头部 1683–1690 里那几句**指向当前状态**的话（§0 数字 / 仍开放项的名字 / 表的行数声明 / `#` 列末端）
  **不是快照散文，是活指针** ⇒ **必须订正**，否则读者按它行事会拿错结论。
  ⇒ **处置分界**：**活指针 ⇒ 改成自证形态**；**快照散文 ⇒ 保留**（并在头部把「位置列的行号也一起是快照」补明）。
- **R604 「历史快照」的头部**不得**内嵌可变数字**。原句「…见 `deviation-ledger.md` §0：**80 条 / 79 已关闭 /
  0 部分关闭 / 1 仍开放**；唯一仍开放的是 **N13**」在写下时（`a2e16f4`，P8）**准确**
  （实测该 commit 的 §0 就是 80/79/0/1、N27），但**此后每关一条就过期**（现为 98/97/1/0，N13 已关、N39 部分关闭）。
  ⇒ 改为**自 date 形态 + 单向指向**（「截至 `<commit>`（P8）为 …；**当前一律以 §0 为准**」），
  任何再复述一遍数字的写法都属于 P13 教训 3「同一事实两个真源」的同族。
- **R605 处置只有四种，且四类计数必须相加等于核实条数**（沿用 R493）：
  **删除**（代码证伪）· **改写**（部分成立，写清剩哪半）· **保留**（仍成立，写明理由）· **无法确认**（保留 + 写明缺什么证据）。
  ⇒ 汇报里写「删除 N / 改写 M / 保留 K / 无法确认 J」，且 **N+M+K+J = 核实条数**（逐条可点）。
- **R606 成对处理**（P13 教训 3 的复用）：本片每一处「清理由」必须配一处「补清理」——
  A.2 头部改了数字 ⇒ 台账 §3 对应行的登记也要同步改；台账 §3 某行被证伪 ⇒ `agent-briefs` 的「下一步」行也要同步。
- **R607 未标注 `✅` 的 §3 行**要分三类处置**，不许一律标 ✅：
  ① **内容确实已完成** ⇒ 补 `✅` + 一行证据；② **内容已被同表另一行取代/合并** ⇒ 补 `✅` 并**注明被哪一行取代**（不删，保留可追溯性）；
  ③ **仍成立**（如 A.2 表余量那一行）⇒ **本片实际处置后**才标 ✅，并写「处置分布」。
- ~~**R608 E9 行的定性**~~ ⇒ **已被执行期实测推翻并改写，见下方「执行期裁决 R608′」**。
- ~~**R609 基线准确 vs 随后过期**~~ ⇒ **已被执行期实测**扩展**，见下方「执行期裁决 R609′」。**
- **R610 「位置」列的行号也属于快照**：A.2 头部原句只说「『偏差』列是过期散文」，
  未交代**「位置」列的 `文件:行` 是否可用于定位当前代码**。而实测多行的位置列已失效
  （`ws.gateway.ts:176,180` 现为鉴权注释、`robot.service.ts:25` 现为构造函数区）。
  ⇒ 头部补一句**「位置列的行号同为快照，定位当前代码请自行 `grep` 符号名」**。
- **R611 本片不承诺把 §3 的行数降到某个数**（沿用 P12 的诚实口径）：
  §3 是**变更日志式**的表，保留「曾登记过什么」有独立价值（同 §3 内已有的一行明确写着
  「保留这一行是为了让『§3 表曾经列过什么』可追溯，不是还有活」）。本片承诺的是：
  **每一行都有终态标注（✅ 已处置 / ⚠️ 仍成立 + 理由）**，且**不再有「未核实、未处置」的行**。

---

## File Structure

```
docs/design.md                                        Modify: A.2 头部活指针订正（R603/R604/R610）+ 必要的行内订正
docs/superpowers/plans/deviation-ledger.md            Modify: §3 的 8 行逐行定终态 + §0 重算 + （必要时）§1.5 追加 N 系列
docs/superpowers/plans/agent-briefs.md                Modify: 交接现状加本片行 + 「下一步/剩余」行同步 + 教训
docs/superpowers/plans/2026-09-17-slice-p24-ledger-docs-closeout.md   本文件：执行期裁决 + 门禁实测
```

---

### Task 0: 基线取证（协调者，可复核、可回退）

- [ ] **Step 1: §3 的机械底数**（**不写死行号**，用区块切分）

```bash
cd /home/howe/pokergame
git rev-parse HEAD                                   # 记下 P24 起点（期望 1d4564a）
git diff --stat                                      # 必须为空（起点干净）
# §3 区块切出来再数（行号会漂，故按标题切分）
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md | grep -c '^|'
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md \
  | grep '^|' | grep -vc '✅'                          # 表头/分隔行也不含 ✅ ⇒ 需再减 2 才是数据行里的「无 ✅」数
```

- [ ] **Step 2: A.2 的行数与行集合**（R609：两种口径都报）

```bash
# 数据行口径
sed -n '/^### A.2 现状偏差汇总/,/^### A.3/p' docs/design.md \
  | grep -cE '^\| \*{0,2}[SCAE][0-9]+\*{0,2} \|'      # 期望 53
# 全部 ^| 行口径
sed -n '/^### A.2 现状偏差汇总/,/^### A.3/p' docs/design.md | grep -c '^|'   # 期望 61
# 行集合在基准点是否一致（R609 的关键命令）
for sha in fafb36a a2e16f4 HEAD; do
  git show $sha:docs/design.md | sed -n '/^### A.2 现状偏差汇总/,/^### A.3/p' \
    | grep -oE '^\| \*{0,2}[SCAE][0-9]+\*{0,2}' | tr -d '|* ' | md5sum
done                                                  # 三个 md5 必须全等
```

- [ ] **Step 3: 复核头部活指针的现状**

```bash
sed -n '/^### A.2 现状偏差汇总/,/^#### 安全类/p' docs/design.md
node scripts/ledger-counts.mjs                       # 头部引用的数字应与这里一致（R604）
grep -n '^| N13 ' docs/superpowers/plans/deviation-ledger.md | head -1   # 头部说「唯一仍开放的是 N13」
grep -n '^| N39 ' docs/superpowers/plans/deviation-ledger.md | head -1   # 实测唯一「部分关闭」是 N39
```

---

### Task 1: 两路只读审计（**2 个子 agent**，各出一份证据表）

**DoD**：两份证据表齐备，每条都有「A.2 位置列原文 / 偏差列原文 / 位置列是否仍指向所述代码 / 缺陷当前状态 /
当前代码事实（`文件:行` + 代码）/ 复核命令 / **基线 `fafb36a` 当时是否准确**」；
`无法确认` 显式列出；**没有**用推断填空。

- [ ] **Part A（agent 1）**：A.2 的**安全类 S1–S8 + 正确性类 C1–C28**（去 C21，共 **35** 行）
- [ ] **Part B（agent 2）**：A.2 的**架构类 A1–A8 + 工程类 E1–E10**（**18** 行）
  + A.2 **头部**（1683–1690 的四条活指针） + 台账 **§3 全部无 ✅ 的行**（机械找出）

**派工单必须逐字包含**：
1. **只读**：不得修改任何文件；产物是**证据表**（写进最终回答，不落盘）。
2. **允许** `git show <sha>:<path>`（只读）；**禁止** `git stash`/`reset`/`checkout`/`switch`。
3. **方法**：先找**当前实现**，再判断 A.2 描述的缺陷是否已被推翻；
   **注释/散文里的旧函数名（如 `checkAndSettle`）已改名的，给出新名**。
4. **禁止**：不得用「看起来旧」当作判据；不得跳过「无法确认」的条。
5. **顶回授权**：若发现本计划/派工单的事实断言有误，**先实测、再跳过并汇报**。

---

### Task 2: 协调者按证据逐处编辑（R603/R605/R607）

- [ ] **Step 1: 先改 A.2 头部的活指针**（R603/R604/R610）：§0 数字改自 date 形态 + 「当前一律以 §0 为准」；
  行的完整性声明按 Task 0 Step 2 的**实测数字**改写；补「位置列行号同为快照」。
- [ ] **Step 2: 逐条 `edit` `deviation-ledger.md` §3 的 8 行**（**不用批量脚本**；R607 三类分别处置）。
- [ ] **Step 3: 成对核对**（R606）：改了 A.2 ⇒ 回头核台账 §3；关掉一条 ⇒ 回头核 `agent-briefs` 的「下一步」行。
- [ ] **Step 4: 处置分布记账**：随手记下 删除 N / 改写 M / 保留 K / 无法确认 J（收口汇报要用）。
- [ ] **Step 5: 复审中新发现的真缺陷 → 登记**（R602）：写进台账 §1.5（**N46 起**），写明「本片未修」。

---

### Task 3: 形态口径复核 + 收口（协调者）

- [ ] **Step 1: 复核收口数字**（**不写死行号**）

```bash
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md \
  | grep '^|' | grep -c '✅'          # 处置后的 ✅ 行数
node scripts/ledger-counts.mjs        # ✅ 逐区一致
grep -c '39 行' docs/design.md        # 期望 0（R604/R609：该断言已证伪）
```

- [ ] **Step 2: 台账收口**：§3 各行定终态；§0 用脚本重算（若追加 N 系列则同步 §1.5 与 §0）。
- [ ] **Step 3: `agent-briefs.md`** 追加本片行（「交接现状」表）+ 同步「下一步（按序）」行 + 「剩余」行；
  新增教训（至少两条，见 R603/R604/R609）；环境事实若有新的一条则加一条。
- [ ] **Step 4: 本文件追加「执行期裁决」与「门禁实测」块 + Commit**

```bash
git add docs/
git commit -m "docs: 台账 §3 文档待更新收口 + A.2 活指针订正（P24/R601–R616）"
```

---

## 门禁（R601：本片零代码影响 ⇒ 轻量门禁）

```bash
cd /home/howe/pokergame
git diff --stat                              # ⚠️ 核心判据：必须**只**出现 docs/ 路径
                                             #    否则 R601 作废，按标准门禁跑全套
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached（廉价兜底）
node scripts/ledger-counts.mjs               # ✅ 逐区一致（98：97/1/0）
```
加上 Task 0/3 的**逐条 `grep`/行计数**（本片的自证面）。

**明确不跑**（R601，逐字同 R491/R395）：`build --force` · `docker compose build/up` · 13 条 conformance ·
真浏览器探针 —— 它们**不读 `docs/**`**，信息量为零，代价是 ~10 分钟 + 一次脆弱的镜像重建。

## Self-Review

**Spec coverage**

| 项 | 落在哪个 Task |
|---|---|
| A.2 表 53 行逐条取证 | Task 1（Part A 35 行 / Part B 18 行） |
| A.2 头部活指针订正 | Task 0 Step 3 + Task 2 Step 1 |
| §3 无 ✅ 的 8 行逐行定终态 | Task 1 Part B + Task 2 Step 2 |
| 成对处理（R606） | Task 2 Step 3 |
| 新发现的真缺陷登记 | Task 2 Step 5 |
| 台账 §3/§0 与 briefs 收口 | Task 3 |

**Placeholder scan**：无 TBD。Task 1 的派工单给了逐条格式与禁止事项（已粘进 `subagent` 的 prompt）。

**⚠️ 本片的三个高风险点**
1. **把「快照随后过期」当成「真缺陷」逐行追改** —— 那正是 R402 明令放弃的做法，会让本片变成第二次 P8
   （改完立刻又开始过期）。⇒ R603 的处置分界必须逐条执行。
2. **按行号排除**会给出漂移的数字（P7 教训 7 实测过三次）。⇒ 一切计数按**形态/区块**，并**每次重数**。
3. **顺手改代码**：一改就破坏轻量门禁的成立前提（R601/R602）。

---

## 执行期裁决（回填区，**不要删**）

### R608′ —— 「E9 那行的框架写错」**不成立 / 无法证实**（计划 R608 被实测推翻）

计划 R608 把「E9 那行的框架写错」定性为「把符合 §9.6 的实现误登记为偏差 + 依据列引错节」。**实测否证**：

- `git show fafb36a:packages/robot-service/src/robot/robot.service.ts | sed -n '25p'` ⇒ **逐字**
  ``const id = playerId || `bot-${uuidv4().substring(0, 8)}`;`` —— **路径对、行号精确、形状 `bot-{uuid8}` 对**；
- 基线 `match.service.ts:242` 只 `await this.acquireBot(...)` 后取 `bot.id`，**确实不生成 ID** ⇒
  「生成在 robot-service、`match.service.ts` 只做编排」这条**职责划分也对**；
- 审计自己的判定（`.superpowers/.../audit-engineering.md`）就是「**文档过期**，不是缺陷」—— 计划 R608 的
  「分类/引用错」是我在没读到该文件时的推断。

⇒ **结论**：E9 行在**审计基准上是准确的**，只是切片 11（`ff27af0`/`0b0380c`）把生成点搬到
`robot.pool.ts:441`（`botId` 与对外 `displayId` 同处生成）而**随后过期**。
⚠️ 「框架写错」这四个字**全仓只此一处自述**（`grep -rn "框架写错" .` 只命中登记本身），**无落盘定义**
⇒ **无法确认 P8 的原意**，缺的证据是 P8/R402 的执行记录。**唯一可机械证实的相邻编号错误**是
**表头**的 `S1`…`E9`（实际末项 `E10`，off-by-one），**不是 E9 那一行** —— 已按 R604 订正表头。

### R609′ —— 「基线当时就不准确」与「快照随后过期」之外，还有**第三种**：**判据用错基准**（本片最重要的发现）

计划 R609 只给了两种分类（真缺陷 vs 预期过期）。实测发现**第三种**，而且它吞掉了一整类结论：

- **A.2 的「表快照基准」不是 `fafb36a`**。实测 `git show 3da457f:<path>` 的**该行号**才是 A.2 散文描述的那段代码：
  `A1` `game.service.ts:22` = `private readonly sessions = new Map<…>` · `A3` `ws.gateway.ts:13` = `private readonly io = new Server()` ·
  `A4` `match.service.ts:53` = `startMatchingLoop(): void {` · `A5` `ws.gateway.ts:293` = `async subscribeToGameEvents()` ·
  `A8` `rooms.service.ts:25` = `await this.redis.keys('room:*')` · `E3` `ws.gateway.ts:10` = `pingInterval: 10000, pingTimeout: 20000` ·
  `E6`（`cancelled`/`baseScore`/`timeoutAt` **三字段当时全缺**）· `E8` `game.service.ts:51-52` = 「Check if session already exists in Redis」+ `this.sessions.get(…)` ·
  `S1` `jwt.middleware.ts:13` = `publicPaths = […, '/']` · `S2:25`/`S8:34` = `@Get(':roomCode')`/`@Get(':roomCode/state')` ——
  **11/11 抽样精确命中**；同一批行号在 `fafb36a` 上多数**不命中**。
- ⇒ **本片派出的 Part B agent 把「基线」当成 `fafb36a`**，于是判出「13 行**从来就不准确**」（它自己的列名就叫
  「在 fafb36a 当时是否准确」）。**那个判据本身用错了基准**：这 13 行里至少 8 条（A1/A3/A4/A5/A8/E3/E6/E8）
  在 `3da457f` 上是**逐字准确**的。
- **规矩**：判「某条历史声明是否从来不准」之前，**先确定它写于哪一版**（`git log -S` + 逐 commit 数行集合），
  再拿**那一版**去证。**拿错基准会把「表写得更早」误判成「表写错了」**（与 P14 教训 1「未验证项的前提自己会过期」同族）。
- ⚠️ **还有一个量级更大的坑**：A.2 的行集合**本身长过三次**（37 → 50 → 49 → 52 → 53），
  所以**不同行的行号来自不同版本** —— 后追加的 16 行（`S8`/`C15–C28`/`E9`/`E10`）沿用**更早审计稿**的行号
  （`C13` 的 `:75`、`C25` 的 `:66` 对应 `895f5d8`，比任何基准都早约 25 h）。
  ⇒ **「位置」列连「一个统一的历史快照」都不是**，这直接决定了头部该怎么写（R614）。

### R612 —— `design.md` §14.1 的跨文档引用是 **P13 漏掉的配对清理**

§14.1（P0 交付清单）逐字写「玩法规则偏差修正（`docs/games/doudizhu.md` §11 的 **18 条 `[偏差]` + 1 条 `[部分实现]`
+ 2 条 `[待实现]`**）」。**P13 把 `doudizhu.md` 清到 0/0/0 却没回头改这处引用** —— 正是 P13 教训 3
「一处清理由必须配一处补清理」的**当场发作**（P13 自己就是靠这条翻出 N37 的）。
实测：`grep -c '\[偏差\]' docs/games/doudizhu.md` = **0** · `[待实现]` = **0** · `[部分实现]` = **0** · `[已实现]` = **15**。
⇒ 处置：保留历史数字，加一行 ✅ **已完成** + **现状计数** + 一句「上面三个数字是**本清单写下时的积压量**，不是现状」。

### R613 —— 台账 §1.x 的「证据（当前代码）」列里，**载体表述**已随 N20/P4 过期

- §1.2 `E10`：「`startGame()` 改走注入的 **`HttpService`**（`firstValueFrom` + `timeout: 3000`）」
- §1.4 `A7④`：「`game.client.ts` 统一到**注入的 `HttpService`**（删手写 `AbortController`）」

**实测**：N20/P4（Task 3）把传输**又换了一次** ⇒ `packages/room-service/src/gateway/game.client.ts:2` 现在是
`ClientProxy`（§4.2 的 TCP RPC），`HttpService` 在 room-service **已不存在**（`grep -rn HttpService packages/room-service/src`
只剩 **3 处注释**，内容都是「不再是 `HttpService`」）；`/api` 前缀与内部 HTTP 路径由
`packages/room-service/test/no-internal-http.gate.test.ts` **正向**钉住（R225）。
⚠️ `no-internal-http.gate.test.ts` 的头部注释**逐字记着这次「第二次失效」**（「本片它又变了一次（`HttpService` → `ClientProxy`）」）
—— 即**源码自己已经承认了台账还没改**。
⇒ 处置：两处**就地补**「载体又换了一次、**判据一字未变**」（`fetch` → `HttpService` → `ClientProxy`）。
⚠️ **§2 的同类表述不动**：§2 是**按切片的变更日志**（与 A.2 同性质的历史散文），改它没有信息量（R603 的分界）。

### R614 —— **A.2 头部必须把「表格快照基准」与「审计基准」分开写**（本片的核心裁决）

原头部逐字：「本表是**审计基准 `fafb36a`（2026-09-14）的历史快照** —— 「偏差」列描述的是**当时**的代码」。
**这句话把两件事并成了一件**：`fafb36a` 是**审计读代码的版本**，而表的**散文与行号写于 `3da457f`**（早 99 个 commit）。
⇒ 三种误读都会由此产生：① 以为行号可对照 `fafb36a`；② 发现「基线当时就已修好」而误判 A.2 写错；③ 把审计**执行**日 09-14
当成基准 commit 的日期（`git log -1 fafb36a` 实测是 **09-13 19:26**）。
⇒ 处置：头部换成**三-commit 对照表** + 逐条抽样证据 + 「位置列没有任何单一可信基准」的读法规则。
**这是本片对 `design.md` 的唯一一处结构性改动**（其余仍是 R402 的快照策略）。

### R615 —— 「实测计数」类断言会**被动过期**，不得当状态判据

两个只读 agent 独立翻出同一族：台账 §1.2 `E1` 写「`api-gateway` 实测 **69/69 通过**（**5 files**）」，
本片复跑实测 **151 passed / 15 files**（`cd packages/api-gateway && pnpm exec vitest run`）。
同族第二处：§3 的 P12 行自称「`[待实现]` = **0**」，而它自己引用的口径 `grep -c '\[待实现\]' docs/design.md` 实为 **3**
（**全部非注记**：§0.2 的两条约定 + §14.1 的引用行）—— 实质结论（0 处真注记）成立，但**数字与口径不符**，
正是该台账反复警告的「计数口径」病。
⇒ 处置：`E1` 就地订正为当前读数，并**写明「实测计数会随测试增长而被动过期，状态判据是『有没有失败』」**；
P12 行的数字补上口径（**0 处真注记（`grep -c` = 3，均非注记）**）。

### R616 —— 两个只读 agent 的**分歧本身**是本片的信息（记录在案）

Part A（S/C 区）与 Part B（A–E 区 + 头部 + §3）在**同一批文件**上独立取证，产出**互相矛盾的一列**：
Part B 判「A1/A3/A4/A5/A8/E3/E8 在基线当时就不准确」，Part A 判「**0 行**从来不准」（它发现了真基准是 `3da457f`）。
⇒ **协调者按 R609′ 逐条回测 `3da457f`，采信 Part A**。
⚠️ 这正是「两个独立取证 + 协调者裁决」这个执行模型的价值所在 —— 若只派 Part B，本片会把 **8 条本来准确的历史声明
误改成「从来不准」**，那是一次**反向的错误清理**（比不清理更糟：它会污染台账的判定依据）。

---

## 门禁实测（P24 收口，**零代码 ⇒ 轻量门禁**，R601）

```bash
cd /home/howe/pokergame

# ① 核心判据（本片唯一需要机械证明的事）：改动面必须只落在 docs/
git status --short
#   M  docs/design.md
#   M  docs/superpowers/plans/deviation-ledger.md
#  ?? docs/superpowers/plans/2026-09-17-slice-p24-ledger-docs-closeout.md
#  ✅ 无任何非 docs/ 路径 ⇒ R601 成立（否则按标准门禁跑全套）

# ② 廉价兜底
pnpm exec turbo run test lint --force
#  ✅ 29 successful, 29 total / Cached: 0 cached

# ③ 台账对账
node scripts/ledger-counts.mjs
#  ✅ §0 与 §1.x 逐区一致（98：97 已关闭 / 1 部分关闭 / 0 仍开放）

# ④ §3：所有数据行都有终态（R607/R611）
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md | grep -c '^|'
#  28（= 26 数据行 + 表头 + 分隔行）
sed -n '/^## 3\. 文档待更新/,/^## 4\./p' docs/superpowers/plans/deviation-ledger.md | grep '^|' | grep -vc '✅'
#  2（**恰为表头与分隔行** ⇒ 数据行里「无 ✅」= 0）

# ⑤ A.2：本体行数与「39 行」那句伪断言的终态
sed -n '/^### A.2 现状偏差汇总/,/^### A.3/p' docs/design.md | grep -cE '^\| \*{0,2}[SCAE][0-9]+\*{0,2} \|'   # 53（未变）
grep -c '它是审计当时的 39 行' docs/design.md      # 0（原句已删；仅在我的更正说明里作为**引文**出现一次）
grep -c '\[偏差\]' docs/design.md                   # 3（仍全是非注记提及）
grep -c '\[待实现\]' docs/design.md                 # 3（仍全是非注记提及）
grep -cE '^### .*\[部分实现\]' docs/design.md       # 3（P12 刻意保留）

# ⑥ 本片的定性判据（R614：表快照基准 ≠ 审计基准）
for sha in 3da457f fafb36a; do printf '%s: ' "$sha"; git show $sha:packages/room-service/src/match/match.service.ts | sed -n '53p'; done
#  3da457f:   startMatchingLoop(): void {        ← A.2 的 A4 行号**精确命中**
#  fafb36a:   （常量区，不命中）
for sha in 3da457f fafb36a HEAD; do git show $sha:docs/design.md | sed -n '/^### A.2 现状偏差汇总/,/^### A.3/p' \
  | grep -oE '^\| \*{0,2}[SCAE][0-9]+\*{0,2}' | tr -d '|* ' | md5sum; done
#  fafb36a / a2e16f4 / HEAD 三者 md5 相同（行集合自审计基准起未变）
```

**明确不跑**（R601，逐字同 R491/R395）：`build --force` · `docker compose build/up` · 13 条 conformance ·
真浏览器探针 —— 它们**不读 `docs/**`**，信息量为零，本片 `src/**` 与 `tools/**` **0 行改动**。

**处置分布（R605/R607）**：**§3 的 8 条无 ✅ 数据行** = **补 ✅ 5**（`538`/`546`/`549`/`551`/`554`）
+ **补 ✅ 并注明被取代 2**（`534`/`537`） + **仍成立并已实际处置 1**（`536`，5 个子项结论各异：①②⑤ 成立 / ③ 失效 / ④ 不成立）
= **8**（逐条可点）。
**另有（分开计数，R606/R612–R615）**：A.2 头部**4 处活指针**订正（R604/R614）· A.2 `C28` 行**位置列**订正（R610）·
`design.md` §14.1 的**跨文档引用**补清理（R612）· 台账 §1.2 `E10` + §1.4 `A7④` 的**载体表述**订正（R613）·
台账 §1.2 `E1` 的**实测计数** + P12 行的**口径数字**订正（R615）。
**台账条目数零变动**：**98：97 已关闭 / 1 部分关闭 / 0 仍开放**（本片未新登记 N 系列 —— 翻出的全部是**文档层**问题，已在本片内处置）。
**仍开放的只有 1 条、且不是本片范围**：**N39**（App 半边，需用户机器 —— 见 `2026-09-17-n39-miniprogram-app-backfill.md` 的 B1–B4）。

