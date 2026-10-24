# conformance 跨平台中立化（设计规格 / spec）

> **日期**：2026-09-18 · **状态**：已实施（Windows 侧 13/13 全绿，commit 见下）→ **待用户在 Linux 云服务器人工验证**
> **实施提交**（`6fa11a1..` 收口提交）：`3941cb8`（runProc shell + timedOut）· `8d58d19`（空 env 文件）· `8bc255c`、`1b5ebb2`（原生超时 + 措辞订正）· `229ad5d`、`4e0f11a`（端点发现 + 注释订正）；收口提交即本文件所在提交。
> **交接清单**：`docs/superpowers/plans/2026-09-18-conformance-windows-neutral-handoff.md`（可复制的命令、三条判据、13 条实测读数与 slice-06 数据依赖说明、孤儿进程观察项、失败归因路径）。
> **上游**：
> - 已完成的前置：`6fa11a1`（机械闸路径分隔符归一化 —— 本片第 1 项）
> - 台账：`docs/superpowers/plans/deviation-ledger.md`
> - 相关裁决：R115（探针判别力自证）/ R229（「连不上」的两种形态）/ R435（不得放宽任何一条闸）
> **归属**：本片（conformance 在 Windows 上跑通）的**设计真源**。实施计划另出。
> **前置状态**：Windows 侧 `docker compose` 已部署 8/8 healthy；`turbo run test --force` 19/19 全绿。

---

## 0. 为什么做

**背景（用户 2026-09-18 裁决）**：**Windows 是长期主力开发环境，服务最终部署到 Linux 云服务器。**
⇒ Windows 侧的门禁必须**真正绿**，不能靠「平台分支跳过」换绿；同时**不得削弱 Linux 侧覆盖**，也不得改生产行为。

**现状**：conformance 13 个用例在 Windows 上 **10 通过 / 3 失败**。
把三个失败用例拆开，共定位到 **5 类**平台假设；其中**第 1 类已随 `6fa11a1` 修掉**，
**余下第 2–5 类是本片的范围**（编号沿用该提交与本规格的既有引用，不再重排）：

| # | 现象 | 位置 | 类别 |
|---|---|---|---|
| 1 | 机械闸把合法文件判成违规 | api-gateway 6 处 + `slice-07.2-hardening` 3 处 | **已修**（`6fa11a1`） |
| 2 | `spawnSync('pnpm', …)` → `ENOENT` | `lib/probe.ts:45` | 进程启动 |
| 3 | `--env-file /dev/null` → `D:\dev\null` | `slice-07.2-deploy.ts:123` · `slice-07.2-rpc.ts:230` | 环境文件 |
| 4 | `timeout N docker …` —— POSIX 专有命令 | `slice-07.2-deploy.ts:160-189` | 超时 |
| 5 | 硬编码 `172.17.0.1`（docker0 网关） | `lib/rpc.ts:276` | 网络地址 |

**Linux 侧的既有基线**（Windows 实测，10 个通过的切片）：`slice-05 29 · 06 49 · 07 39 · 07.1 28 · 08 55 · 09 160 · 10 185 · 11 50 · security 43 · boundary 82`。
台账「切片 P9」记录的历史值为 `rpc 65 · deploy 104 · hardening 103`（⚠️ **历史快照，未必等于当前**）。

---

## 1. 本片裁决与范围

| # | 裁决 | 性质 |
|---|---|---|
| **本片-1** | **全面中立重写**：所有平台假设改写成平台中立形式，**不引入 `process.platform` 分支** | 策略（用户裁决） |
| **本片-2** | 接受「Linux 侧行为随之改变」，由**用户在云服务器上人工验证一次** | 风险接受（用户裁决） |
| **本片-3** | **D（Docker 构建代理永久化 / bcrypt 防复发）本片不做**，用户裁决略过 | 范围 |
| **本片-4** | 不改 CI（conformance 仍不进 `scripts/ci.sh`） | 范围 |
| **本片-5** | `lib/probe.ts` 的 `timedOut` 语义错误**顺手修**（见 §3.2） | 范围 |

**明确不做**：D 的全部内容 · CI 扩展 · conformance 之外的平台问题 · 生产代码的任何改动。

---

## 2. 已完成的第 1 项（前置，`6fa11a1`）

`f.slice(REPO.length)` / `relative(REPO_ROOT, f)` 在 Windows 上产 `\` 分隔，与**按 `/` 写成的**白名单/期望清单比对全部落空 ⇒ 把合法文件报成违规。

修法：新增 `packages/api-gateway/test/helpers/repo-path.ts` 的 `toPosixPath`（`.split('\\').join('/')`，POSIX 上恒等），与既有范例 `apps/client/test/helpers/source-scan.ts:44` 同法。

**判别力已自证**：注入裸 `console.log` 探针 ⇒ `no-raw-console` 由 GREEN 转 RED；移除 ⇒ 恢复 GREEN。

---

## 3. 逐项设计

### 3.1 #2 —— 进程启动（`lib/probe.ts`）

**现状**：`spawnSync(cmd, args, …)` 无 `shell`。Windows 上 `pnpm` 只有 `pnpm.cmd`，Node 自 CVE-2024-27980 修复后禁止无 shell 直启 `.cmd`。

**实测**（三者对照）：

| 形态 | 结果 |
|---|---|
| `spawnSync('pnpm', ['--version'])` | `status=null` `error=ENOENT` |
| `spawnSync('pnpm', ['--version'], {shell:true})` | `status=0` —— **但触发 DEP0190 告警** |
| `spawnSync('pnpm --version', {shell:true})` | `status=0` —— **不触发告警** |

**设计**：改用 **`shell: true` + 整串命令形态**（避免 DEP0190 污染门禁输出）。
`runProc` 内部把 `cmd` 与 `args` 拼成**一条整串命令**，再以 `spawnSync(整串, { shell: true })` 调起。
Windows 走 `cmd.exe`、Linux 走 `/bin/sh`，两侧语义一致。

**约束**：命令与参数**必须是代码内字面量**（现状如此：`'pnpm'` + 过滤名/包名）。`runProc` 的 5 个调用点全部传 `'pnpm'`。
⚠️ **已知代价①**：经 shell 后参数不再逐个转义 ⇒ 若将来参数含空格或 shell 元字符会坏。**本片接受**，并在函数 JSDoc 里写明该前提。

⚠️ **已知代价②（Linux 侧行为变化，本片必须点名）**：`shell: true` 下 spawnSync 的 `timeout` 杀掉的**只是外壳进程**，
其子进程（`pnpm` → `vitest`）在 POSIX 上**不会被连带杀死** ⇒ 超时时可能**留下孤儿进程**。
现状（无 shell）杀的就是 `pnpm` 本身。
**本片接受该退化**（走到 180s 超时已说明该次运行是坏的），但必须在 §5.2 的手工验证清单里作为**观察项**列出 ——
这是本次改动中**唯一已知的、会改变 Linux 既有行为的点**。

### 3.2 #2b —— `ProcResult.timedOut` 语义错误（顺手修）

**现状**：`timedOut: res.status === null`。**实测表明 spawn 失败同样产 `status=null`** ⇒ 该判据无法区分「超时」与「根本没启动起来」。

**设计**：改为 `res.error?.code === 'ETIMEDOUT'`。三态由此可区分（实测）：

| 情形 | status | signal | error.code |
|---|---|---|---|
| 正常结束 | `0` | `null` | — |
| 到点被杀 | `null` | `SIGTERM` | **`ETIMEDOUT`** |
| 起不来 | `null` | `null` | `ENOENT` |

⚠️ **如实标注**：`ProcResult.timedOut` **全仓无人消费**（消费 `.timedOut` 的是 `slice-07.2-deploy` 里 `runOneShot` 自己的 `RunResult`，不是这个）。
⇒ 本项是**卫生性修复，不改变任何现有行为**。之所以仍做：避免将来出现消费者时被误导。

### 3.3 #3 —— 环境文件（`deploy.ts:123`、`rpc.ts:230`）

**现状**：`['compose', '--env-file', '/dev/null', …]`。Windows 上被解析成 `D:\dev\null` ⇒ `couldn't find env file`。

**设计**：运行时创建**空临时文件**，把其**真实路径**传给 `--env-file`。

**生命周期（必须写死，否则会漏临时文件）**：**每次调用**用 `mkdtempSync(join(tmpdir(), …))` 建一个**独立目录**，
在其中放空文件 `.env.empty`；在 `finally` 里 `rmSync(dir, { recursive: true, force: true })`。
不用固定路径（并发/残留会互相污染），不在模块加载期建（进程异常退出会漏）。

- 语义等价：`/dev/null` 读作空，空文件同样读作空 ✅
- 该调用**不经 shell**（`execFileSync('docker', […])`）⇒ 临时路径含空格也安全 ✅
- 两侧都成立 ⇒ 真中立 ✅
- 两处调用点（`deploy.ts:123`、`rpc.ts:230`）**共用同一个 helper**，不各写一份

**helper 落点与形态**：新建 `tools/conformance/src/lib/env-file.ts`，导出**带生命周期保证**的高阶函数：

```ts
export function withEmptyEnvFile<T>(use: (envFilePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-env-'));
  try {
    const p = join(dir, '.env.empty');
    writeFileSync(p, '');
    return use(p);              // 调用方在此回调里发起 execFileSync，避免路径逃逸出 finally
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

用回调而非「返回路径 + 要求调用方自己清理」，是为了**让泄漏在形态上不可能发生**（本仓对「靠自觉」的约定一贯不信任）。

### 3.4 #4 —— 超时（`deploy.ts:160-189`）

**现状**：`spawnSync('timeout', [String(seconds), 'docker', …], { …, timeout: (seconds+60)*1000 })`
—— POSIX `timeout` 作**主约束**，靠 `status === 124` 判超时；Node 原生超时作**兜底**。

**设计**：去掉命令包装，`spawnSync('docker', […], { …, timeout: seconds * 1000 })`，
`RunResult` 增加 `signal: string | null`，判据改为 `res.error?.code === 'ETIMEDOUT'`（§3.2 的实测支撑）。

**语义等价性论证**：两层里外层从未生效（主约束 N 秒先到）⇒ 单层 `N` 秒等价。

**⚠️ 这是本片唯一"承重"的三态区分点，且它牵动 `checks.*` 的判据参数。**

`:443-462` 有**两条**互相配套的断言（初稿只看到后一条，**漏了前一条**）：

```ts
checks.eq(withValue.status, 124, '给了 token 时进程必须**留在 listen**（8 秒内不退出 ⇒ `timeout` 杀掉 ⇒ 124）…');
checks.that(withValue.timedOut, '正对照确认：退出码 124 就是 `timeout` 的超时语义（进程仍在运行）');
```

`124` 是 **POSIX `timeout` 的退出码**。改用 Node 原生超时后进程被 **SIGTERM** 杀掉
⇒ `status` 是 **`null` 而非 124** ⇒ **前一条会直接红**。

**⇒ 必改的 `checks.*` 判据参数（本片唯一一处）：**

| 行 | 现在 | 改为 | 语义是否保持 |
|---|---|---|---|
| `:459` | `checks.eq(withValue.status, 124, …)` | `checks.eq(withValue.signal, 'SIGTERM', …)` | ✅ 判据意图是「**不是自己退出的，是被我们的超时杀掉的**」；`status===124` 与 `signal==='SIGTERM'` 是同一意图在两种机制下的表达。新形态反而**更直接**（不再依赖某个外部命令的退出码约定） |

`checks.that(withValue.timedOut, …)`（`:462`）判据不变，只更新消息文案（去掉「退出码 124」的说法）。

**⚠️ 待实测假设（如实标注）**：`ETIMEDOUT` 判据本身**只在 `node` 上验过**（附录 A5），
**没有在 `docker compose run` 这个真实场景上验过**；`signal === 'SIGTERM'` 同理。
而 `:462` 那条正对照恰恰要求该场景下判为超时。
⇒ 由 §5.1 第 1 步覆盖；**若该场景产不出 `ETIMEDOUT` / `SIGTERM`**（例如 docker 客户端被终止后
自行清理并正常退出），本条设计不成立，须换判据（备选：断言「进程未在 8s 内自行退出」+ 容器侧旁证）。

**已知风险**：Windows 上容器冷启动更慢，`runOneShot('', 60)` 的 `!empty.timedOut` 有**偶发假红**风险（60s 不够）。**本片按等价性实施，若实测假红则单独裁决**。

### 3.5 #5 —— 网络地址（`lib/rpc.ts:276`）

**现状**：`export const REFUSING_HOST: RpcEndpoint = { host: '172.17.0.1', port: 3999 }`
—— 注释称其为「**唯一**能证明对端真的回了 RST 的地址」。

**实测推翻了两条既有假设，并印证了 R229 的洞见（共三条结论）**：

| 端点 | 本机（Windows + Docker Desktop）观察 |
|---|---|
| `172.18.0.1:3999`（**实际** compose 网关） | **TIMEOUT 3009ms** —— 不回 RST |
| `127.0.0.1:3999` | **ECONNREFUSED 2ms** —— 回 RST |

⇒ ① 硬编码的 `172.17.0.1` **连地址都不对**（实际网关是 `172.18.0.1`）；
② 即便「运行时解析网关」**也修不了**（该地址在本机同样只给超时）；
③ R229 的洞见成立：**哪种地址回 RST 是「环境属性」，不是「缺陷」**，且本机与 R229 的机器**恰好相反**。

**设计 —— 运行时发现「回 RST 的端点」（不问「哪个地址」，改为「发现这个条件」）**：

⚠️ **不能只靠构造**（本节初稿在此处是错的，见下方「为什么」）：R229 那台机器上 `127.0.0.1` 是**被黑洞**的，
构造出来的 loopback 端口**同样会超时** ⇒ 只做构造会在那类环境上**把绿变红**，正好违反本片「不降低强度」的目标。

```
候选① = 构造的 loopback 端点：bind 127.0.0.1:0 → 取端口 → close → 即成「有主机、无监听」
候选② = 运行时解析出的 compose 网关（`docker network ls` 按 driver/名字过滤后 inspect，
        不硬编码 `pokergame_ftl-platform`）+ 一个确定没人听的端口

逐个探  →  取第一个 kind === 'ECONNREFUSED' 的作为 REFUSING 端点
一个都没有  ⇒  **响亮失败**，打印每个候选的实测形态（kind / code / 耗时）—— 不跳过、不假绿
```

这不是「平台分支」（本片-1 禁止的那种），而是**环境自适应发现**：两侧跑同一份代码，由实测结果决定用哪个端点。

实测（本机）：候选① `127.0.0.1:3741`（曾 bind 后 close）→ **ECONNREFUSED 2ms** ✅；
候选② `172.18.0.1:3999` → TIMEOUT（本机用不上它，但 R229 那类机器上它是唯一可用的）。

**改动形态**：`REFUSING_HOST` 静态常量 → **async 发现函数**（如 `discoverRefusingEndpoint(): Promise<RpcEndpoint>`）。
第 ① 组的三条断言（`kind` / `code` / 耗时窗口 `REFUSED_WINDOW_MS = 1000`）**一字不改**。

**失败形态（重要，且我最初的方案在此处是错的）**：
`RpcTransportKind = 'ECONNREFUSED' | 'timeout' | 'socket-error' | 'protocol' | 'closed'` —— **没有 `'connected'`**。
close 与 probe 之间端口若被抢占，探针会连上、发包、等不到回包 ⇒ 落 `kind: 'timeout'`。
⇒ **不需要新增断言**：现有 `checks.eq(refused.kind, 'ECONNREFUSED', …)` **本来就会响亮失败**。
只需把该断言的**消息文案**改成能提示「端口可能被抢占」这一可能。

**连带（必须做）**：`lib/rpc.ts:240-249` 与 `slice-07.2-rpc.ts:400-404` 的注释把
「① 网关回 RST、② 回环黑洞」写成了**事实陈述**，而本机**恰好相反** ⇒ 必须改写为
「形态由地址与环境决定」——**这不是文档润色，原注释在别的平台上会误导人**。

---

## 4. 错误处理原则

> **任何「本环境提供不了该条件」的情况，一律响亮失败并打印诊断，绝不跳过。**

（依据 R115：*一条从未在违规输入上红过的闸，与不存在没有区别*。）

| # | 失败形态 | 处理 |
|---|---|---|
| 2 | 命令仍起不来 | 调用方读 `.status !== 0` ⇒ 已响亮失败（与 `timedOut` 无关） |
| 2b | `ProcResult.timedOut` 语义 | 顺手修；如实标注无人消费 |
| 3 | 临时文件创建失败 | 抛错并带路径，**无兜底** |
| 4 | `runOneShot` 三态 | `status=0` / `ETIMEDOUT` / 其它（含 `ENOENT`）**必须可区分**；起不来绝不可读成超时 |
| 4b | 探针容器残留 | 沿用既有 `removeProbeContainer()`，断言零残留 |
| 5 | ① 构造端口被抢占 ② 所有候选都不回 RST | **不新增断言**：现有 `checks.eq(kind,'ECONNREFUSED')` 本就会红。① 改消息文案提示该可能；② 发现函数本身**响亮失败并打印每个候选的实测形态**（kind/code/耗时），不得跳过 |

---

## 5. 验证与交接

### 5.1 Windows 侧（实施者跑，出证据）

1. 逐跑改动涉及的 4 个用例：`slice-07.2-hardening` · `slice-07.2-deploy` · `slice-07.2-rpc` · 回归 `slice-05`
2. 全量 13 个用例
3. 全仓 `turbo run test --force`（确认未碰 lint / 单测面）

**迭代允许**：第 1 步会暴露此前「早早中止、后续步骤没跑到」的部分。**新暴露的问题自动纳入本轮范围**，迭代至三步全绿，或撞上需裁决的设计问题为止。

### 5.2 Linux 侧（用户跑一次）

判据（三条，缺一不可）：

| 判据 | 为什么是它 |
|---|---|
| **13 个用例全绿** | 中立重写不该降低任何一处的强度 |
| **断言条数逐切片不变** | 本片四项改动**都不增删断言** ⇒ 条数应与基线逐字一致（基线见下） |
| **被改动的 `checks.*` 逐条对照表** | 「条数不变」挡不住**原地削弱**断言（把 `checks.eq(x, 124, …)` 改成 `checks.that(true, …)` 条数不变、判据全毁）。本片**已预先枚举**（见下表），实施中若新增须补入 |

**预先枚举的 `checks.*` 改动（本片全部的判据面改动，就这 5 处调用点）**：

> **执行期扩表（2026-09-18）**：原为 4 处。Task 3 评审的 Important 发现指出两处注释
> 把「`timeout` 在 Windows 上 ENOENT」写成事实（**错误** —— 实测是 PATH 依赖的同名解析：
> 本机命中 Git 自带的 coreutils，没有它的机器命中 `C:\Windows\System32\timeout.exe`，
> 后者存在故也不是 ENOENT）。订正该措辞时，连带清掉一条 `checks.that` 消息里的同类残留提及
> ⇒ 变 5 处。**业务上仍只有 1 处判据参数变化**。用户已裁决。

| # | 位置 | 改动 | 性质 |
|---|---|---|---|
| 1 | `slice-07.2-deploy.ts` | `checks.eq(empty.status, 1, …)` 消息文案（去「124」） | 仅消息文案 |
| 2 | `slice-07.2-deploy.ts` | `checks.eq(withValue.status, 124, …)` → `checks.eq(withValue.signal, 'SIGTERM', …)` | ⚠️ **判据参数变**（本片唯一一处）——理由与语义保持见 §3.4 |
| 3 | `slice-07.2-deploy.ts` | `checks.that(withValue.timedOut, …)` 消息文案（去「退出码 124」） | 仅消息文案 |
| 4 | `slice-07.2-deploy.ts` | `checks.that(!empty.timedOut, …)` 消息文案（去残留的 `` `timeout` `` 命令名） | 仅消息文案 |
| 5 | `slice-07.2-rpc.ts` | `checks.eq(refused.kind, 'ECONNREFUSED', …)` 消息文案（§3.5 的「端口可能被抢占」提示） | 仅消息文案 |

⇒ Linux 侧复核时，**对着这 5 处逐条看**：只有第 2 处允许判据参数变化，其余 4 处只许动文案。

**条数基线分两组**（⚠️ 这两组**来源不同**，但收口时已同权，别混读）：

| 组 | 切片 | 基线来源 | 说明 |
|---|---|---|---|
| **甲** | `05 29 · 06 49* · 07 39 · 07.1 28 · 08 55 · 09 160 · 10 185 · 11 50 · security 43 · boundary 82` | 本片 §0 的 Windows 实测 | 权威、当前 |
| **乙** | `rpc 65 · deploy 104 · hardening 103` | **台账切片 P9 的历史快照** | 计划期 Windows 侧没跑到这几例 ⇒ 当时权威性低于甲组。**收口时 13/13 全量跑后三条被逐字印证**（见交接清单 §3）⇒ 现已同权，但**来源仍是历史快照**，不是本次实测 |

`*` **`slice-06` 的条数非常量**（`34 + 5×N`，`N` = 持久化房间列表长度）—— 详见交接清单 §3.1。
它是**本片之前就存在**的属性，不是回归；核对时应核**公式**而非绝对数。

⇒ 乙组若与台账不符，**先归因再下结论**（大概率是台账过期，而非本次改动）——**不得直接当成回归**。

**观察项（与判据无关，但必须记录）**：§3.1 的「孤儿进程」退化。
本次运行中若出现 180s 超时，**留意是否留下 `pnpm`/`vitest` 孤儿进程**并把观察结果贴回 ——
这是本次改动中**唯一已知会改变 Linux 既有行为**的点。

### 5.3 回滚粒度

**两个提交**，对应原 B/C 划分，可定点 revert：

| 提交 | 内容 |
|---|---|
| ① | #2 + #2b + #3 —— 进程启动与环境文件 |
| ② | #4 + #5 —— 超时与网络地址 |

若 Linux 跑红 ⇒ 按提交粒度定点 `git revert`，并附原始输出归因。

---

## 6. 风险与未验证项

| 项 | 说明 |
|---|---|
| **Linux 侧行为无自动化验证** | conformance **不在 CI 里**（`scripts/ci.sh` 零命中）。本片**不改 CI**（本片-4）⇒ Linux 验证是**一次性人工**的，不防将来回归 |
| **#4 的 Windows 冷启动假红** | `runOneShot('', 60)` 的 60s 在 Docker Desktop 上可能不够 ⇒ 偶发假红。按等价性实施，实测假红再裁决 |
| **#5 的构造端口被抢占** | 概率极低，且失败形态是**响亮失败**（非假绿） |
| **#5 的「找不到回 RST 的端点」** | 若某环境下两个候选都给超时，发现函数会**响亮失败** ⇒ **Linux 上表现为跑红**。这是**设计意图**（不假绿），但它是本次改动在 Linux 上最可能的失败点。§5.2 的失败归因流程要能识别它：报错文案会打印两个候选各自的 kind/code/耗时 |
| **#5 的网关名不得硬编码** | 候选②依赖 `docker network ls` 的运行时解析（compose 项目名会变，本机是 `pokergame_ftl-platform`，换机器就是别的） |
| **#2 的 shell 转义面** | 参数含空格/元字符会坏。当前全是字面量，已在 JSDoc 写明前提 |
| **#2 的孤儿进程退化（Linux 侧）** | `shell: true` 下超时只杀外壳 ⇒ 可能留下 `pnpm`/`vitest` 孤儿。**本片唯一已知会改变 Linux 既有行为的点**，已列入 §5.2 观察项 |
| **设计完整性未证明** | 3 个失败用例都是**早早中止**，后续步骤未跑到 ⇒ 「修完这 4 项即全绿」**无依据**，必须靠 §5.1 的迭代允许 |

---

## 附录 A. 本片的实测证据（可复跑）

| # | 命令（要点） | 结果 |
|---|---|---|
| A1 | `spawnSync('pnpm', ['--version'])` | `status=null` `error=ENOENT` |
| A2 | `spawnSync('pnpm', ['--version'], {shell:true})` | `status=0` + **DEP0190** |
| A3 | `spawnSync('pnpm --version', {shell:true})` | `status=0`，**无告警** |
| A4 | `spawnSync('pnpm.cmd', ['--version'])` | `status=null` `error=EINVAL` |
| A5 | `spawnSync('node', [睡5s], {timeout:1500})` | `status=null` `signal=SIGTERM` `error=ETIMEDOUT` |
| A6 | `spawnSync('不存在的命令')` | `status=null` `signal=null` `error=ENOENT` |
| A7 | `net.connect` → `172.18.0.1:3999`（compose 实际网关） | **TIMEOUT 3009ms** |
| A8 | `net.connect` → `127.0.0.1:3999` | **ECONNREFUSED 2ms** |
| A9 | bind `127.0.0.1:0` → close → connect 该端口 | **ECONNREFUSED 2ms** |
| A10 | `docker network inspect pokergame_ftl-platform` | `gateway=172.18.0.1 subnet=172.18.0.0/16` |

参照：`apps/client/test/helpers/source-scan.ts:44`（本仓既有的归一化范例）· R229 · R115 · R435。
