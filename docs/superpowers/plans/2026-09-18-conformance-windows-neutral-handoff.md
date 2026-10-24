# conformance 跨平台中立化 —— Linux 人工验证交接清单

> **日期**：2026-09-18 · **面向**：用户在 Linux 云服务器上的人工复核（规格 §5.2 的落地清单）
> **设计真源**：`docs/superpowers/specs/2026-09-18-conformance-windows-neutral-design.md`
> **实施计划**：`docs/superpowers/plans/2026-09-18-conformance-windows-neutral.md`
> **实施提交**（判据面所在范围 `6fa11a1..` 收口提交）：`3941cb8`（runProc shell + timedOut）· `8d58d19`（空 env 文件）· `8bc255c`、`1b5ebb2`（原生超时 + 措辞订正）· `229ad5d`、`4e0f11a`（端点发现 + 注释订正）；收口提交即本文件所在提交（`docs(conformance): Windows 侧收口 + Linux 人工验证交接清单`）。

Windows 侧已 13/13 全绿（读数见 §3）。Linux 侧人工跑一次，核对**缺一不可**的三条判据（§2）。

---

## 1. 要执行的命令（可直接复制）

> 先设一次仓库根目录（只改这一处）：`REPO=<换成实际的仓库根目录>`；下文命令里的 `$REPO` 即指它。

### 1.1 起栈（若 8 容器未就绪）

```bash
cd "$REPO"
docker compose up -d --wait
docker compose ps   # 期望：8 个服务全部 healthy（--wait 会等到就绪再返回）
```

### 1.2 构建 conformance

```bash
cd "$REPO"
# 若尚未安装依赖（无 node_modules），先跑：pnpm install
pnpm --filter @fight-the-landlord/conformance build
```

### 1.3 按序跑 13 个用例（空日志开跑；Windows 侧全量约 5.4 分钟）

```bash
cd "$REPO/tools/conformance"
: > /tmp/conf-linux.log
for c in slice-05 slice-06 slice-07 slice-07.1 slice-08 slice-09 slice-10 slice-11 slice-07.2-security slice-07.2-boundary slice-07.2-hardening slice-07.2-deploy slice-07.2-rpc; do
  out=$(node dist/run.js "$c" 2>&1); rc=$?
  echo "$out" | sed -e 's/\x1b\[[0-9;]*m//g' >> /tmp/conf-linux.log
  printf "%-22s rc=%-2s %s\n" "$c" "$rc" "$(echo "$out" | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE '通过|失败' | tail -1 | cut -c1-80)"
done
```

### 1.4 汇总读数

```bash
grep -a "通过：" /tmp/conf-linux.log
```

---

## 2. 三条判据（缺一不可）

### 判据 A：13 个用例全绿

每个用例 `rc=0`，且最后一行是 `✅ <用例名> 通过：<N> 项断言，用时 <T>s`。
任何一条 `❌ <用例名> 失败：…` 都算红，按 §5 归因。

### 判据 B：断言条数逐切片对照表

| 切片 | 基线 | Windows 实测（2026-09-18） | 判定 |
|---|---|---|---|
| slice-05 | 29 | 29 | 一致 |
| slice-06 | 49 | **64** | ⚠️ **数据依赖**：对照公式 `34 + 5×N`，不对照绝对数 —— 见 §3.1 |
| slice-07 | 39 | 39 | 一致 |
| slice-07.1 | 28 | 28 | 一致 |
| slice-08 | 55 | 55 | 一致 |
| slice-09 | 160 | 160 | 一致 |
| slice-10 | 185 | 185 | 一致 |
| slice-11 | 50 | 50 | 一致 |
| slice-07.2-security | 43 | 43 | 一致 |
| slice-07.2-boundary | 82 | 82 | 一致 |
| slice-07.2-hardening | 103 | 103 | 一致 |
| slice-07.2-deploy | 104 | 104 | 一致 |
| slice-07.2-rpc | 65 | 65 | 一致 |

**slice-06 的正确核对方式**：`实测条数 == 34 + 5×(同一次运行日志里「列表非空（N 个房间）」的 N)`。
满足即通过；与 49（或 64）的绝对差**不构成**回归判定依据（原因见 §3.1）。
其余 12 个切片在已观察到的两种数据状态下条数均不变 —— Windows 侧本次是在与基线不同的数据状态下逐字复现的。

### 判据 C：判据面改动恰好 5 处调用点（只有 1 处判据参数变化）

核对方法（两选一，或都做）：

```bash
# ① 看 diff（相对本片基线 6fa11a1；收口提交 fae69a4，即页首「实施提交」的「Windows 侧收口」那条）
git diff 6fa11a1 fae69a4 -- tools/conformance/src/slices/slice-07.2-deploy.ts tools/conformance/src/slices/slice-07.2-rpc.ts

# ② 跨行感知的机械核对（按调用点对账，不按行）：
#    预期：deploy 51→51、rpc 52→52 条调用，改动调用点合计 = 5
#    收口提交 = fae69a4；若你的检出里该哈希不同，把下面的 HEAD 换成对应的收口提交
BASE=6fa11a1 HEAD=fae69a4 node -e '
const {execSync}=require("node:child_process");
const G=(rev,p)=>execSync(`git show ${rev}:${p}`,{encoding:"utf-8"});
const files=["tools/conformance/src/slices/slice-07.2-deploy.ts","tools/conformance/src/slices/slice-07.2-rpc.ts"];
const extract=(src)=>{const out=[];const re=/checks\.(eq|that)\(/g;let m;
  while((m=re.exec(src))){let i=m.index+m[0].length-1,depth=0,j=i;
    for(;j<src.length;j++){if(src[j]==="(")depth++;else if(src[j]===")"){depth--;if(!depth)break;}}
    out.push(m[1]+"("+src.slice(i+1,j).replace(/\s+/g," ").trim()+")");}
  return out;};
let total=0;
for(const f of files){
  const b=extract(G(process.env.BASE,f)), a=extract(G(process.env.HEAD,f));
  console.log(`\n--- ${f}: ${b.length} → ${a.length} 条调用 ---`);
  const n=Math.max(b.length,a.length); let c=0;
  for(let k=0;k<n;k++) if(b[k]!==a[k]){c++;
    console.log(` [改动 ${c}] #${k}\n   − ${b[k]??"(缺失)"}\n   + ${a[k]??"(缺失)"}`);}
  total+=c; console.log(` 改动条数: ${c}`);
}
console.log(`\n两文件改动调用点合计: ${total}`);
'
```

| # | 调用点 | 允许的改动形态 | Windows 侧机械核对实测（2026-09-18） |
|---|---|---|---|
| 1 | deploy `checks.eq(empty.status, 1, …)` | 仅消息文案（去「124」） | ✅ 命中（deploy 第 1 处改动） |
| 2 | deploy `checks.eq(withValue.signal, 'SIGTERM', …)` | ⚠️ **判据参数变**（原 `withValue.status, 124`）—— 全片唯一一处 | ✅ 命中（deploy 第 3 处改动，#12） |
| 3 | deploy `checks.that(withValue.timedOut, …)` | 仅消息文案（去「退出码 124」） | ✅ 命中（deploy 第 4 处改动，#13） |
| 4 | deploy `checks.that(!empty.timedOut, …)` | 仅消息文案（去残留的 `` `timeout` `` 命令名） | ✅ 命中（deploy 第 2 处改动，#10） |
| 5 | rpc `checks.eq(refused.kind, 'ECONNREFUSED', …)` | 仅消息文案（§3.5 的「端口可能被抢占」提示） | ✅ 命中（rpc 第 1 处改动，#8） |

只有第 2 处允许判据参数变化，其余 4 处只许动文案。任何第 6 处改动 ⇒ 报回来，不得放行。

> 注：调用点 #2 旁边有一条改动说明注释（`slice-07.2-deploy.ts:477`，原文含 `status === 124` 字样）——
> 那是**旧形态的引用**（计划 Task 3 处方原样规定写入、有意保留），不是判据残留；`checks.*` 参数形态的
> `, 124,` 在整个 `tools/conformance/src` 中 0 命中。

---

## 3. 甲组基线：Windows 实测 13 条读数（2026-09-18 全量跑，13/13 绿、rc=0）

| 切片 | 断言数 | 用时 |
|---|---|---|
| slice-05 | 29 | 56.3s |
| slice-06 | 64 | 0.8s |
| slice-07 | 39 | 38.0s |
| slice-07.1 | 28 | 3.5s |
| slice-08 | 55 | 11.3s |
| slice-09 | 160 | 25.8s |
| slice-10 | 185 | 19.3s |
| slice-11 | 50 | 74.4s |
| slice-07.2-security | 43 | 5.5s |
| slice-07.2-boundary | 82 | 5.8s |
| slice-07.2-hardening | 103 | 50.4s |
| slice-07.2-deploy | 104 | 19.0s |
| slice-07.2-rpc | 65 | 10.3s |

与计划基线（甲组 `05 29 · 06 49 · 07 39 · 07.1 28 · 08 55 · 09 160 · 10 185 · 11 50 · security 43 · boundary 82`；
乙组 `rpc 65 · deploy 104 · hardening 103`）逐条对照：**12 条逐字一致；`slice-06` 为 64 —— 不是本片改动所致，见下**。

> ⚠️ **13 条基线分两个来源组，别混读**：甲组十条 = 本片改动前在 Windows 侧的实测；乙组三条（`rpc 65 · deploy 104 · hardening 103`）
> = **台账切片 P9 的历史快照** —— 本次 13/13 全量跑后三条已被**逐字印证**（现已同权），但**来源仍是历史快照**、不是本次实测：**印证 ≠ 同来源**。

### 3.1 ⚠️ `slice-06` 的条数为什么是 64 而不是 49（数据依赖，不是回归）

- `tools/conformance/src/slices/slice-06-auth-rooms.ts:82` 对 `GET /api/rooms` 返回的**全部房间**逐房断言，
  每房 5 条（字段集 / mode / status / playerCount / baseScore）。该文件共 39 处 `checks.*` 静态调用，
  其中 5 处在 `for (const room of rooms)` 循环内 ⇒ **执行条数 = 34 + 5×N**（N = 运行时刻房间列表长度）。
- 房间是 **Redis 支撑**（`room:*` 键 + TTL）；`findAll()` 只过滤 `cancelled`（`packages/room-service` 源码） ⇒ N 随历史运行累积，**不是**固定值。
- 实测核对（2026-09-18 Windows）：

| 运行 | 日志里的 N | 实测条数 | 公式核对 |
|---|---|---|---|
| §0 记录基线（当时那次） | （由 49 反推为 3） | 49 | 34 + 5×3 = 49 ✅ |
| 本次 13 用例全量 | 6 | 64 | 34 + 5×6 = 64 ✅ |
| 同日晚间单用例复跑 | 15 | 109 | 34 + 5×15 = 109 ✅ |

- 本片对 `slice-06-auth-rooms.ts` **零改动**（`git diff 6fa11a1 HEAD -- tools/conformance/src/slices/slice-06-auth-rooms.ts` 为空）。
- ⇒ Linux 侧核对 slice-06 按公式，不按绝对数；只要 `实测 == 34 + 5×N`（N 取自同一次日志）即为通过。

---

## 4. 观察项：`shell: true` 的孤儿进程退化（规格 §3.1 / §5.2）

- 本片把子进程启动改成 `shell: true`（Windows 上 `pnpm` 只有 `.cmd`，必须经 shell；见规格 §3.1）。
  **已知代价**：spawnSync 的 `timeout` 到点时杀掉的只是**外壳进程**；在 POSIX 上其子进程
  （`pnpm` → `vitest`）**不会**被连带杀死 ⇒ 超时场景可能留下孤儿进程。这是本次改动中
  **唯一已知会改变 Linux 既有行为的点**，属**已接受**的退化（能走到 180s 超时已说明该次运行是坏的）。
- **观察方法**：若某个用例出现 180s 超时（单例用时异常大 / 超时错误信息），跑
  `ps aux | grep -E "pnpm|vitest"` 看是否有残留，把观察结果（有/无 + 进程命令行）贴回。
  未出现超时则无需操作。
- Windows 侧本次观察：**未出现任何 180s 超时**（13 例合计约 5.4 分钟）；门禁结束后 `tasklist` 未见 `pnpm`/`vitest` 残留。

---

## 5. 失败归因路径（若有红，按此逐行走；**不要就地改判据**）

1. **红在 §2 判据 C 的 5 处调用点之一**：先判断「是不是本片预期内的行为变化」。预期内只有第 2 处
   （`withValue.status,124 → withValue.signal,'SIGTERM'`）：若 Linux 上该条红，说明规格 §3.4 标注的
   **待实测假设**不成立（`docker compose run` 客户端被原生超时终止后未产出 `ETIMEDOUT`/`SIGTERM`，
   例如客户端被终止后自行清理并正常退出）。→ 附**原始输出**回报（不得就地放宽/替换判据；备选换法：
   断言「进程未在 8s 内自行退出」+ 容器侧旁证）。
2. **红在 5 处之外**：对着 §2 判据 B 的表逐行判断「是本次改动引入的，还是环境差异」。环境差异候选：
   端口被占（rpc 的 `ECONNREFUSED` 探针依赖「构造后立即探测」窗口）、容器冷启动慢（deploy 的 60s/8s 窗口）、
   残留容器/网络（deploy 收尾断言「不得留下探针容器」）。
3. **条数不一致**：先看是不是 slice-06（对照 §3.1 公式）；其余 12 个若不一致，按「改动引入」归因，带回原始读数。
4. **已知偶发（先复跑再归因）**：`slice-07.2-deploy` 步骤 ⑤ 在冷启动下曾观察到偶发一次红、复跑即绿
   （Windows 侧观察）。出现时**先复跑该用例**，把两次的原始输出一并带回。
5. 单用例复跑命令：`cd tools/conformance && node dist/run.js <用例名>`。
   注意：复跑会新建房间（追加数据、推大 slice-06 的 N）—— 正常现象，不是异常。
