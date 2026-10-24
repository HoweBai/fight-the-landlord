# 切片 P14 Implementation Plan：收口 D 类 —— 台账 §4「无法确认的项」逐条了结

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `deviation-ledger.md` **§4（无法确认的项，8 条）** 逐条了结成两种之一：
**① 已验证**（附实测证据，搬出 §4）或 **② 仍无法验证**（逐字写明**缺什么**）。
现在的 §4 是**审计受限时的历史登记**，其中至少一条已与今天的实测不符（「robot-service/DouZero 未起」——
实测 DouZero 容器 6 小时 healthy，机器人局全程跑通）⇒ **这张表自己会过期**（P6 教训 3）。

**Architecture:** 8 条按「**本机能不能验**」分三组：
**甲组（现在就能验，5 条）**：跑一条命令或跑一局真栈即可；**乙组（要用一次性隔离容器，1 条）**：
A7 的下游超时要停一个下游，**不能**停常驻 8 容器（会让同轮其它切片假红）——照抄 P5 的 503 验收手法
（起一次性容器、跑完即删）；**丙组（本机不可能验，2 条）**：生产网络隔离（需生产环境策略，不是代码问题）与
socket.io 拒绝握手语义（**R152 已实测过** ⇒ 可作为**结案**候选）。

**Tech Stack:** bash + redis-cli + docker compose + 既有 conformance + Vitest。

**Spec:**
- `docs/superpowers/plans/deviation-ledger.md` —— **§4 全表** · §5（维护约定）
- `docs/design.md` —— §5.5（脱敏）· §4.3（超时/重试/降级表）· §6.1（传输层）· §9.3（DouZero 双轨）
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实（新 session 必读）」（8 容器、`build --force`、conformance 独占）

## Global Constraints

1. **§4 的语义是「不要当成已排除」** ⇒ 本片的任务是**消歧**，不是「都标成已验」。
   **无法确认的一律留在 §4**并写明缺什么（§5 第 4 条的纪律）。
2. **不得停常驻 8 容器**（会打断同轮其它判据）⇒ 需要「坏掉的下游」时**只用一次性隔离容器**。
3. **conformance 独占**（网关按 IP 计并发 WS 连接，上限 5）；每条套 `timeout 300`。
4. 证据先于结论：每条都要有**命令 + 原文输出**；**不得**写「应该已经被覆盖了」。
5. commit message 末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## 协调者裁决（本片新增）

> 编号接 P13 声明的区间（R491–R505），本片协调者区间 **R506–R520**。

- **R506 每条只允许两种终态**：**已验证**（搬出 §4，证据写进 §1.x 对应行的「证据」列或本片计划）·
  **仍无法验证**（留在 §4，**逐字写明缺什么**，且**必须**写清「要用什么工具/什么环境才能验」）。
  ⚠️ **不允许第三种**（如「大概率没问题」）。
- **R507 甲组的判据形态**：能用**一条命令**回答的，就把命令与输出原文一起落盘；
  需要**跑一局**的（计时器、DouZero），用 `node scripts/browser-e2e.mjs --scenario full` 驱动真局
  （它已经能真打完一局 —— P9 的产物），**不**另造驱动脚本。
- **R508 乙组（A7 下游超时 → `10007`）**：**不接受**「停一个常驻容器」的做法。
  落地形态照 **P5 的 503 验收先例**：起**一次性**隔离容器（不同端口/env，跑完即删），
  让网关指向一个**不响应的下游**，断言 **503 + `10007`**；跑完 `docker compose ps` 必须仍是 8/8 healthy。
- **R509 丙组的「生产网络隔离」**：**不是代码问题** ⇒ 明确写「需要**部署环境**的网络策略（谁放行 3001–3005）
  才能验；仓库里读不出来」，并把该项从「未验证的偏差」改写为「**部署前提**」。
- **R510 「socket.io 的拒绝握手语义」用 R152 的既有实测结案**：`agent-briefs.md` 逐字记着
  「服务端在**握手之后**拒绝时，客户端先 `connect`、再 `system.error`、再 `disconnect(io server disconnect)`
  ⇒ **「拒绝握手」在客户端不等于 `connect_error`**；要在传输层真拒绝需改用 engine.io 的 `allowRequest`」，
  而 **N15 已按此落地并关闭**。⇒ 该条**结案**（写明依据是 R152 + N15 的关闭者 commit，不是本片实测）。

---

## 绑定数值（开工前实测）

| 项 | 数值 |
|---|---|
| §4 条数 | **8**（逐条见下表的 Task 编号） |
| 真栈现状 | 8/8 容器 healthy（含 `ftl-douzero`、`ftl-redis`、`ftl-mysql`） |
| 可用的真局驱动 | `node scripts/browser-e2e.mjs --scenario full`（✅ 20/20，真打完一局 ~47s + 匹配 ~32s） |
| 已用最大裁决号 | **R505**（P13 声明的区间） |

---

## File Structure

```
docs/superpowers/plans/deviation-ledger.md   Modify: §4 逐条改写（搬出/保留+缺什么）；§0 重算（若影响计数）
docs/superpowers/plans/agent-briefs.md       Modify: P14 门禁实测 + 教训（§4 自己会过期）
packages/*/test/**                            Modify: 仅当甲组需要**新增**一条可复跑的判据时（优先用既有 conformance/探针）
docs/superpowers/plans/2026-09-17-slice-p14-unverified-items.md   本文件（回填证据）
```

---

### Task 1（甲组，可并行派 2 个 agent）：5 条能不能现在就验

- [ ] **Step 1: S2/S8 的端到端利用**（§4 逐字：「需要 conformance 加一条：用**非本房** token 请求
  `GET /api/games/<code>%3Fseat=1`，断言 403 或只返回本方手牌。**在补上这条断言前，S2/S8 的修复无法证明有效**」）

```bash
grep -n "seat=\|%3F\|encodeURIComponent" tools/conformance/src/slices/slice-07.2-boundary.ts | head -20
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary     # ✅ 期望 82 项
```
**判据**：若该切片**已有**「非本房 token + 编码走私」的断言 ⇒ 该条**已验证**，搬出 §4 并**指名断言所在**；
若没有 ⇒ **新增**这条断言（改 `tools/conformance`，**协调者**动手），再搬出。

- [ ] **Step 2: S7 的运行态泄敏**（需要**运行态日志采样**）

```bash
# 跑完整一轮后采样（不只看源码）：三个层面各取原文
docker compose logs api-gateway  | grep -icE "hand|bot-|isRobot|token|authorization"   # 期望 0
docker compose logs game-service | grep -icE "hand|bot-|isRobot"                        # 期望 0
docker compose logs room-service | grep -icE "isRobot|bot-"                             # 期望 0
```
⚠️ 需**先制造一次真实对局**（用 `--scenario full`），否则日志里没有可采样的路径。
**判据**：给出三个读数 + 采样前提（「跑完一局后的日志」）；读数非 0 时逐条判断是真泄敏还是**测试用的假数据**
（如 `robot.release failed` 这类含 `bot` 的运维日志 **不含身份**）。

- [ ] **Step 3: C22/C28 计时器行为**（§4：「未在真实 Redis/多进程下端到端观测」）

```bash
node scripts/browser-e2e.mjs --scenario full        # 真局；其间读 redis 的 deadline
docker compose exec -T redis redis-cli --scan --pattern 'game:session:*' | head -3
# 取一个 session，观察 turnDeadlineAt 是否被超时路径推进（version 递增）
```
**判据**：给出「一局内 `version` 递增 N 次、其中至少 1 次由**超时自动行为**触发」的原文
（探针的 `--trace` 时间线可直接提供）。

- [ ] **Step 4: C15 补偿对真实 DouZero 的影响**（§4 逐字「robot-service/DouZero 未起」——**已过期**）

```bash
docker compose ps douzero --format '{{.Status}}'     # ✅ healthy ⇒ 前提已不成立
node scripts/browser-e2e.mjs --scenario full        # 一局里机器人真的经 DouZero 出牌
docker compose logs robot-service | grep -c "DouZero"    # 记录实际调用次数
```
**判据**：若机器人局全程经 DouZero 决策且**无 +3 补偿异常**（`cardCounts` 守恒、`hand` 长度吻合），
该条**已验证**（附日志原文）；否则保留并写明观察到的差异。

- [ ] **Step 5: C20 的 `length` 错值**（§4：「只 grep 到 3 处消费者，未逐一核对全部前端代码」）

```bash
grep -rn "\.length" apps/client/src --include=*.ts --include=*.vue | grep -i "lastPlayed\|playedHand" 
grep -rn "lastPlayedHand" apps/client/src packages/protocol/src | grep -v test
```
**判据**：给出**全部**消费者的行号 + 每处只读 `.cards` 的结论（**枚举式**，不是抽样）。

---

### Task 2（乙组）：A7「下游超时 → `10007`」的一次性隔离验收（R508）

- [ ] **Step 1: 起一次性容器造「不响应的下游」**（照 P5 的 503 先例：**不碰常驻 8 容器**）

```bash
# 形态与 P5 的 health 验收一致：独立容器/独立端口，跑完即删
docker run -d --rm --name ftl-p14-timeout --network pokergame_default \
  -e PORT=3998 alpine:3 sh -c 'while true; do sleep 60; done'   # 只监听不做响应 → TCP 连上但不回 RPC
docker ps --filter name=ftl-p14-timeout --format '{{.Status}}'
```
⚠️ 网络名以 `docker network ls | grep pokergame` 的**实际值**为准；`PORT` 要指向网关会调用的**下游 RPC 端口**。

- [ ] **Step 2: 让网关指向它并断言 503 + `10007`**

```bash
# 通过环境变量覆盖下游地址（具体变量名从 docker-compose.override.yml 读，不要猜）
docker compose run --rm -e GAME_SERVICE_RPC_HOST=ftl-p14-timeout -e GAME_SERVICE_RPC_PORT=3998 api-gateway \
  ...  # 断言路径：发起一个需要下游的动作，期望 503 + { code: 10007 }
```

- [ ] **Step 3: 清理并验证没伤到常驻栈**

```bash
docker rm -f ftl-p14-timeout
docker compose ps          # ✅ 必须仍 8/8 healthy
docker ps -a --filter name=ftl-p14- | wc -l    # ✅ 0（无残留）
```

- [ ] **Step 4: 结论**：成功 ⇒ 该条**已验证**并搬出 §4；失败（造不出超时）⇒ 留在 §4，
  逐字写明「缺一个可控的不响应下游」并给出本 Task 的实测现象。

---

### Task 3（丙组）：2 条本机不可能验的，改写为可执行的表述

- [ ] **Step 1: 生产网络隔离** —— 按 **R509** 改写为**部署前提**：
  「需要**部署环境的网络策略**（谁放行 3001–3005 / redis / mysql / douzero）才能判定；
  仓库里读不出来。**当前仓库层的事实**：生产形态 compose 只发布 3000，`INTERNAL_SERVICE_TOKEN` 无默认值
  ⇒ 编排层已收口；**网络层**未知。」（附 `slice-07.2-deploy` 104 项作为编排层证据）
- [ ] **Step 2: socket.io 拒绝握手语义** —— 按 **R510 结案**：写明依据 = **R152 的实测** + **N15 的关闭**
  （`allowRequest` + `connect_error`），并给出 `agent-briefs.md` 的对应行引用。
- [ ] **Step 3: 逐条更新 §4**：搬走的删行；留下的**改写为「仍无法验证 + 缺什么 + 怎么才能验」**。

---

### Task 4（协调者）：收口

- [ ] **Step 1: §4 的形态计数**（可机械复核）

```bash
sed -n '/^## 4\. 无法确认的项/,/^## 5\./p' docs/superpowers/plans/deviation-ledger.md | grep -c '^|'
```
给出「编辑前 8 + 表头 ⇒ 编辑后 N」的前后对照（**逐条点名搬走的是哪几条**）。

- [ ] **Step 2: `agent-briefs.md` 追加 P14 门禁实测 + 教训**（至少两条：
  **「§4 这类『未验证』清单自己会过期」**、**「验证『不可控的下游』要用一次性隔离容器，不要停常驻栈」**）。
- [ ] **Step 3: Commit**

```bash
git add docs/ tools/ packages/
git commit -m "docs(ledger): §4 无法确认的 8 项逐条了结（P14/R506–R510）"
```

---

## 门禁

```bash
cd /home/howe/pokergame
git diff --stat                              # 若**只**动了 docs/ ⇒ 按 R491 同族跑轻量门禁
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached
# 若改了 tools/conformance 或 packages/** ⇒ 标准门禁全套：
pnpm exec turbo run build --force            # ✅ 10/10（conformance 前必跑）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                            # ✅ 8/8 healthy
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
node scripts/browser-e2e.mjs --scenario full   # ✅ 20/20（甲组多条的驱动）
docker ps -a --filter name=ftl-p14- | wc -l    # ✅ 0（一次性容器已清理）
node scripts/ledger-counts.mjs                 # ✅ 逐区一致
```

## Self-Review

**Spec coverage**

| §4 的条目 | 组 | Task |
|---|---|---|
| S2/S8 的端到端利用 | 甲 | Task 1 Step 1 |
| S7 的运行态泄敏 | 甲 | Task 1 Step 2 |
| C22/C28 计时器行为 | 甲 | Task 1 Step 3 |
| C15 补偿对 DouZero 的实际影响 | 甲 | Task 1 Step 4 |
| C20 的 `length` 错值 | 甲 | Task 1 Step 5 |
| A7 下游超时 → `10007` | 乙 | Task 2 |
| 生产网络隔离 | 丙 | Task 3 Step 1 |
| socket.io 拒绝握手语义 | 丙 | Task 3 Step 2 |

**Placeholder scan**：无 TBD。Task 2 Step 1/2 标注了「网络名与变量名**从 compose 读，不要猜**」——
那是取证指令（本仓已有「靠名字推断踩坑」的前科）。

**⚠️ 本片的三个高风险点**
1. **把「已覆盖」当「已验证」** —— §4 的口径是「不要当成已排除」，必须给**命令 + 原文**。
2. **停常驻容器** ⇒ 用一次性容器（R508），跑完必须验证 8/8 仍 healthy 且无残留。
3. **§4 自己会过期** —— 逐条**先看现状再写**，不要照抄（P6 教训 3 的同族）。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：本片**协调者区间 R506–R520**。）

### R511 —— S2/S8：计划 Step 1 的**命令指错了切片**，且该断言确实**缺失**（已补）

- 计划 Step 1 让 `grep ... slice-07.2-boundary.ts`。**实测该文件里没有 `%3F`** ——
  走私断言在 **`slice-07.2-security.ts:228-241`**（第 4 步 N3）。**先按实测找，再动手**（否则会误判「缺失」而重复新增）。
- 但**该条仍然缺**，且缺的正是 §4 逐字要求的那半：第 4 步用的是 **A 自己的 token**、
  第 6 步（非成员）走的是**普通路径** ⇒ 「**非本房 token + `%3F` 走私**」这个**组合**从未被直接断言。
  ⚠️ 两半各自被覆盖**不能**推出组合成立（§4 的纪律：不许用「应该已经被覆盖了」结案）。
- **处置**：新增第 6b 步（`stranger` + `%3Fseat=`），判据与第 4 步同形（10001 或 403+12004），
  另加两条「响应里不含 hand 字段 / 不含 A 或 B 的手牌」。**实测**：
  `HTTP 400` · `{"code":10001,"message":"Invalid room code"}` + 两条硬断言通过
  ⇒ `slice-07.2-security` **40 → 43 项**。
- ⚠️ 这使本片从「纯文档」变成「**改了 `tools/conformance`**」⇒ 门禁按**标准全套**跑（不是轻量）。

### R512 —— C15 的判据形态写错了（`grep -c "DouZero"` 恒 0）

计划 Step 4 的 `docker compose logs robot-service | grep -c "DouZero"` **实测返回 0** ——
但机器人**真的**在用 DouZero：日志是小写 `[RobotService] Bot … decided play (source=douzero, cards=N)`。
⇒ **判据改为** `grep -ci "douzero"` / `grep -c "source=douzero"`。
**教训**：**判据形态写错会让「已验证」变成空测** —— 0 会被读成「没调用」，进而把一条**已经成立**的项
误判为「仍无法验证」。（与 P5 教训 4「门槛类判据必须自证会失败」同族：**先证明读数能看到「有」**。）

### R513 —— 乙组的两个配方都被实测推翻（网络名 + 「黑洞」的造法），并补了**正对照**

1. **网络名**：计划写 `--network pokergame_default`。**实测**（`docker network ls | grep -i poker`）
   是 **`pokergame_ftl-platform`** ⇒ 按实际值执行。（这正是计划自己强调的「不要猜」。）
2. **「黑洞下游」的造法**：计划给的是 `alpine:3 sh -c 'while true; do sleep 60; done'` ——
   它**不监听任何端口** ⇒ TCP 连接会被 **RST/拒绝**（`ECONNREFUSED`），**造不出超时**，
   而 A7 要验的恰恰是**超时**路径。改用 **`node:20-slim`** 起一个
   **accept 连接但永不响应**的 TCP 服务（`net.createServer(function(s){}).listen(3998)`）。
3. **补了正对照（R115）**：同一一次性网关、下游指向**真实** `user-service` ⇒
   `HTTP=404 code=11004`、**0.039s**。**没有这一对，「503 + 5.03s」就可能只是「一次性网关自己坏了」的产物。**
4. **R508 的隔离纪律实证**：跑完 `docker ps -a --filter name=ftl-p14-` = **0**，常驻栈仍 **8/8 healthy**。

### R514 —— 计划 Step 3 说「探针的 `--trace` 时间线可直接提供超时证据」——**不成立**

`autoPlayUntilEnded()`（`scripts/browser-e2e.mjs:472`）**每 500ms 轮询，轮到人类就立刻动作**
⇒ 人类回合**永远不会**走到 30s 超时；机器人回合由 §9.4 驱动、也不靠超时。
⇒ **真局的探针不产生任何超时驱动的状态转移。**
**处置（更强的形态）**：改从**存量真会话**取证 —— 真 Redis + 多进程下**不投任何客户端动作**，
观察两个会话的 `version`/`currentPlayer`/`bidPhase.currentBidder`/`turnDeadlineAt`：
① playing 会话 `v60→61→62→63`（行动者 `0→1→2→0`，`turnDeadlineAt` **每次重挂**到 ~30s）；
② bidding 会话 `v1→2→3`（**`currentPlayer` 恒 0**，而 `bidPhase.currentBidder` `0→1→2`、`bidPasses`/`grabActions` 递增）。
⇒ 这比「跑一局顺便看」**更强**：它**排除**了「客户端动作造成 version 递增」这一竞争解释，
并且**同时**给出了 C22（重挂 + 落盘）与 **C28**（叫抢期用 `currentBidder`）的判别性证据。

### R515 —— §4 的终态分布：**8 → 1**（7 条搬出，1 条改写为部署前提）

`已验证` 6 条（S2/S8 · S7 · C22/C28 · C15 · A7 · C20）+ `结案` 1 条（socket.io，R510）
+ `仍无法验证` 1 条（生产网络隔离 ⇒ 按 R509 改写为**部署前提**）。
**每条的终态与「命令 + 原文输出」都写进了台账 §4 的「已搬出」表**（可机械复核）。

---

## 门禁实测（P14，**改了 `tools/conformance` ⇒ 标准门禁全套**）

```bash
cd /home/howe/pokergame

# 格式判据（R506）：§4 的数据行 8 → 1
sed -n '/^## 4\./,/^## 5\./p' docs/superpowers/plans/deviation-ledger.md | grep -c '^| \*\*生产网络隔离\*\*'   # = 1

# 标准门禁（因为改了 tools/conformance）
pnpm exec turbo run build --force                  # ✅ 10/10
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                                  # ✅ 8/8 healthy
# 13 条 conformance（独占；每条 timeout 300）：
#   slice-07.2-security ✅ **43**（40 → +3：§4 要求的那条组合断言）
#   其余 12 条 ✅ 不回归
node scripts/browser-e2e.mjs --scenario full       # ✅ 20/20
docker ps -a --filter name=ftl-p14- | wc -l        # ✅ 0（一次性容器已清理）
pnpm exec turbo run test lint --force              # ✅ 29/29、0 cached
node scripts/ledger-counts.mjs                     # ✅ §0 与 §1.x 逐区一致（90：84/1/5/0）
```

**明确不改**：`packages/**`（本片零生产代码改动）；新断言只加在 `tools/conformance`。
