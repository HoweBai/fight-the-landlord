# 上云与自动化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把仓库接上 GitHub 私有仓库与 Actions：镜像由 CI 构建进 GHCR、真栈 15 切片在 Ubuntu runner 上跑绿、**打 tag 才部署**到 VPS，并走完第一次真部署与回滚。

**Architecture:** 三个新工作流分工按触发分级 —— `ci.yml` 加第二个 job `render-gate`（每次 push 跑纯渲染判据，**不需要 docker daemon**）、`images.yml`（push→master 构建 7 镜像进 GHCR）、`conformance.yml`（可 `workflow_call` 复用；master 自建、被复用时拉 GHCR 镜像）、`release.yml`（tag `v*` 才跑，`images → conformance → deploy` 用 `needs` **串行**，消除「部署先于镜像推送」的竞态）。服务器上**没有仓库、没有构建、没有长期凭据**：`/srv/pokergame/` 只有 `docker-compose.yml`（`scp` 送）+ `.env`（手工一次、部署永不覆盖），部署 = `pull` + `up -d` + 冒烟三条，回滚 = 换 tag 再跑同一条路径（秒级）。

**Tech Stack:** Docker Compose v2 / buildx（`type=gha` 缓存）· GitHub Actions · GHCR · bash · 既有 conformance runner（`tools/conformance`）+ `js-yaml@4.3.2`（树里现成）· vitest（既有）

**设计真源：** `docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md`（R1301–R1314 · 判据 A11/A12 · B1–B4 · C1–C4 · §7 记两轮复核的全部发现）。**任务与判据的编号一律以它为准**；本计划只负责「怎么落地」。

## Global Constraints

- **判据只增不减**（R1313）：各包与各 conformance slice 的条数**不得回退**；新增条数在回填时逐项列出。
- **零客户端改动**（R1313）：`apps/client/src/**` 一个字节都不动。
- **探针逐字不变**（R1313）：`scripts/browser-e2e.mjs` 的 blob 必须仍是 `052b98b7ab779ae280d6673729053145e9829604`；`gate 18/18` · `full 33/33`。
- **磁盘卫生两套语义**（R1307/R1314）：**服务器侧只允许 `docker image prune -f`**（只删悬空）；`-af` 会删掉上一个 tag 的镜像，把「秒级回滚」变成一次网络拉取。**CI runner 侧**才允许 `-af`。
- **改任何服务源码 ⇒ 重建镜像再跑真栈判据**（`DOCKER_BUILDKIT=0 docker compose build <svc> && docker compose up -d <svc>`），随后查 DI 陷阱：`docker compose logs <svc> --since 30s | grep -i error`。
- **网络已钉 `172.28.0.0/16`、门口固定 `172.28.0.250`**；compose 项目名已由顶层 `name: pokergame` **钉死**（与检出目录名无关 ⇒ CI 的检出目录是 `fight-the-landlord` 也不影响**网络名/卷名/隐式镜像名**）。⚠️ 行号不写死 —— 本片会往 `docker-compose.yml` 文件头加注释，行号会漂。
- **文档复核实「逐行」**（「旧句在该文件内不存在 + 新句存在」），**不做**全仓 0 命中；全仓 grep 排除 `.worktrees/**`、`**/dist/**`、`docs/superpowers/**`。
- **条数不预测**：任何跨文件条数（slice 断言数、包测试数）**留白给实施者实测**并写进提交信息 —— 本仓为此栽过。
- **Windows Git Bash**：容器内执行一律 `node -e` / `sh -c 'cd …'`；`docker run -v` 用 `D:/Code/pokergame/...` 正斜杠形式（别让 MSYS 转路径）。给命令优先用「cmd 也能跑」的形态（双引号、少用管道）。
- **`checks.eq` 用 `!==` 比较 ⇒ 数组/对象字面量永远不相等**（R176）：判数组用 `checks.that(arr.length === 0, …)`，判对象先 `JSON.stringify` 再比。
- **slice 的签名是 `export async function runSliceX(): Promise<Checks>`**，结尾 `return checks;`（`run.ts` 靠返回值统计断言数）。
- 每个任务**先写/改判据 → 跑红 → 实现 → 跑绿 → 提交**；提交信息结尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **需要用户动手的四件事**（实施者**停在这里等**，不得代做）：① 装 `gh` 并登录（Task A1）② 给域名（Task C1 之前）③ 服务器五项预备（Task C4 之前）④ 首次部署那天在键盘前（Task C4）。

---

## 与 spec 的计划期增补（登记）

1. **`run.ts` 增 `--list`**：spec B3 要求 CI 的 15 切片循环「顺序与 `run.ts` 的 `CASES` 同源」。`CASES` 不导出、runner 也没有列举模式 ⇒ 加 `--list`（按 `CASES` 顺序逐行打印）。**不另抄一份清单**（那是第二个真源）。
2. **B1 的落点是新 slice `slice-07.4-pipeline`**，不是 vitest 包测试：spec 只说「新增源码/配置闸」。B1 只读 YAML（无 docker），与 `--render` 语义一致 ⇒ 放进 `tools/conformance` 与其它结构闸同处，并被 `render-gate` job 每次 push 跑到。`js-yaml` 作为 `tools/conformance` 的 devDependency。
3. **`slice-07.3-edge.ts` 的 `ftl-edge:latest` 是 3 处**（`:185`、`:187` 文案、`:193`）—— spec R1303 说「3 处」，与实测一致；`:34` 的 `EDGE_CONTAINER = 'ftl-edge'`（容器名）**不改**（容器名不是镜像名）。
4. **A6a(ii) 拆步的形态**：spec B2 说「拆成独立步骤 id（`caddy`）」。本计划**保留它在 ① 区块内的原位置**，只加一层 `if (runs('caddy'))` 守卫 —— 比搬出区块改动面小，且 `CONFORMANCE_DEPLOY_STEPS=prod,dev` 自动排除它。
5. **`images.yml` 的 `nodes`... 见 Task B2**：CI 首次推包可能 403（B4④）⇒ 该任务第一步是**核对并必要时修**仓库的 Workflow permissions。
6. **CI 的真栈统一跑在默认镜像名下**（`pokergame-<svc>:latest`），GHCR 拉取路径额外做一次 `docker tag` 落回默认名 —— 理由见 Task B3 的 Step 2 注释（`slice-07.2-deploy.ts:1134` 把 `pokergame-api-gateway:latest` 写成**硬前提**，`checks.eq` 会红）。**这不是 spec 的偏差，是 spec 未展开的一条实现约束**。

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `.gitignore` | 改 | 补 `*.bak`（R1302） |
| `docker-compose.yml` | 改 | 7 个带 `build:` 的服务各加一行 `image: ${IMAGE_PREFIX:-pokergame}-<svc>:${IMAGE_TAG:-latest}`（R1303） |
| `tools/conformance/src/slices/slice-07.2-deploy.ts` | 改 | `ISOLATED_KEYS` +2 · A11/A12 · ①j 注入自证 +2 · A6a(ii) 加 `caddy` 守卫 |
| `tools/conformance/src/slices/slice-07.3-edge.ts` | 改 | 镜像名 3 处（`:185`/`:187`/`:193`） |
| `tools/conformance/src/slices/slice-07.4-pipeline.ts` | 新建 | **B1** 工作流清点（结构 / 触发集合相等 / 负对照） |
| `tools/conformance/src/run.ts` | 改 | `--list`（CASES 顺序）· `--render`（跳过 `assertGatewayHealthy()`） |
| `tools/conformance/package.json` | 改 | `devDependencies` + `js-yaml`；`conformance:slice-07.4-pipeline` |
| `tools/conformance/baselines.json` | 新建 | 条数下限（`render` / `full` 两列，**最小值**口径） |
| `scripts/check-baselines.mjs` | 新建 | 比较脚本（本机与 CI **共用**）+ `--self-test` 负对照 |
| `.github/workflows/ci.yml` | 改 | 加第二个 job `render-gate`（每次 push） |
| `.github/workflows/images.yml` | 新建 | push→master：7 镜像进 GHCR |
| `.github/workflows/conformance.yml` | 新建 | master 自建 / `workflow_call` 复用拉取；跑 15+1 切片 |
| `.github/workflows/release.yml` | 新建 | tag `v*` + `workflow_dispatch`：`images → conformance → deploy` |
| `scripts/deploy/build-images.sh` | 新建 | 构建并推送 7 镜像（buildx + `type=gha`）：**唯一的构建配方**（两个工作流共用） |
| `scripts/deploy/conformance-stack.sh` | 新建 | 起/收真栈：**唯一的一份配方** |
| `scripts/deploy/deploy.sh` | 新建 | `scp` + 服务器 `pull`/`up -d` + 冒烟三条 + 登出；`--assert-clean` 子命令 |
| `scripts/deploy/rollback.sh` | 新建 | 换一个**已存在**的 tag 走同一条路径 |
| `docs/ops/first-deploy.md` | 改 | ⑦ 整节替换 + 新增「服务器预备」「回滚」+ 三类过期措辞（R1311） |
| `docs/design.md` | 改 | §13.4 表下新增小节 + `:1477` 理由句 · §2.2 · §2.3 +2 行 · §14.4 表加一行 · §15.4 |
| `README.md` | 改 | 新增「部署与回滚」小节 |
| `.superpowers/sdd/progress.md` | 改 | 「上线运营层（二）」段的 Task 状态与终值回填 |

---

## Task A1: 私有仓库与首次推送（R1302）

**Files:**
- Modify: `.gitignore`
- Delete: `.env.local.bak`（仓库受控 + 工作树）

**Interfaces:**
- Produces: 私有仓库 `Howebai/fight-the-landlord`；远端 `origin`；`master` 已推送。
- Consumes: 无（本片第一个任务）。

> ⚠️ **本任务第一步需要用户动手**（装 `gh` + `gh auth login`）。实施者把命令交给用户、等用户回报，**不得**代跑任何安装或登录。

- [ ] **Step 0（用户动作）: 装 `gh` 并登录**

交给用户在 **cmd** 里跑（不是 Git Bash）：

```
winget install GitHub.cli
```

装完**关掉并重开终端**（PATH 更新），然后：

```
gh auth login
```

向导选择：`GitHub.com` → `HTTPS` → `Login with a web browser`，按提示在浏览器里粘贴一次性码。

**预期的回报**（用户贴给实施者）：

```
$ gh --version
gh version 2.x.x (2025-xx-xx)

$ gh auth status
github.com
  ✓ Logged in to github.com account Howebai (...)
  ✓ Git operations for github.com configured to use https protocol.
```

**不一样怎么办**：`winget` 不可用 ⇒ 到 `https://cli.github.com/` 下 Windows 安装包。`gh auth status` 报 `not logged in` ⇒ 重跑 `gh auth login`。**这是阻塞点**：没登录就做不了 Step 4。

- [ ] **Step 1: 把受控的疑似密钥文件移出仓库**

先**确认它真的只是开发默认值**（不打印值，只打印键名与「是否等于公开默认值」）：

```bash
git show HEAD:.env.local.bak | cut -d= -f1 | sort
```

**预期**：11 个键名 —— `DB_HOST` `DB_NAME` `DB_PASSWORD` `DB_PORT` `DB_USER` `DOUZERO_URL` `GAME_SERVICE_URL` `JWT_SECRET` `ROBOT_SERVICE_URL` `ROOM_SERVICE_URL` `USER_SERVICE_URL`（另有 5 行 `#` 开头的注释头，非键）。**没有** `INTERNAL_SERVICE_TOKEN` / `SITE_ADDRESS` / `TLS_MODE`。

确认后再删（先 `git rm` 再删文件）：

```bash
git rm --cached .env.local.bak
rm .env.local.bak
```

- [ ] **Step 2: `.gitignore` 补 `*.bak`**

在 [.gitignore](.gitignore) 的 `.env.*.local` 这一行**下面**加一行：

```
*.bak
```

- [ ] **Step 3: 扫描受控文件，确认没有真密钥**

```bash
git ls-files | grep -Ei "\.env|secret|credential|\.pem$|\.key$|id_rsa"
```

**预期**：只有下面**4 条**无害命中，多一条都要停下来核：

```
apps/client/.env.development
apps/client/.env.mock
apps/client/.env.test
douzero/.env.example
```

⚠️ **`apps/client/.env.development.local` 不在这个清单里** —— 它**存在于磁盘但从不受控**（被 `.gitignore:21` 的 `.env.*.local` 挡在仓库外）。这与 spec §2（`:95`）列的 4 个**逐字一致**。（2026-09-25 执行期订正：本节原先把 5 条写进预期，是错的。）

⚠️ 若扫描结果里出现仓库根 `.env` / `.env.local` / `*.bak` ⇒ **停**，别推。

再核一次 `*.bak` 已生效：

```bash
git check-ignore -v .env.local.bak
```

**预期**：命中 `.gitignore:<行号>:*.bak`（若文件已删则用 `git check-ignore -v --no-index x.bak` 验）。**这一条同时要成立**：`.env.deploy.local` 仍被既有规则覆盖：

```bash
git check-ignore -v .env.deploy.local
```

**预期**：`.gitignore:21:.env.*.local`。

- [ ] **Step 4: 建私有仓库并首次推送**

`gh repo create` 的旗标以执行时 `gh repo create --help` 为准（本机装 `gh` 前无法预验）：

```bash
gh repo create Howebai/fight-the-landlord --private --source=. --remote=origin --push
```

**预期**：结尾 `✓ Created repository Howebai/fight-the-landlord on GitHub` + `✓ Pushed commits to …`。

**不一样怎么办**：
- 已经建过仓库 ⇒ 改成 `git remote add origin https://github.com/Howebai/fight-the-landlord.git && git push -u origin master`。
- 推不上去、报 `Authentication failed` ⇒ `gh auth setup-git`。
- ⚠️ **推之前**再看一眼待推清单：`git push --dry-run origin master` 的输出里**不得**出现 `.bak`、`.env`、`.env.local`。

- [ ] **Step 5: 验收（三条都要成立）**

```bash
git remote -v
gh repo view Howebai/fight-the-landlord --json isPrivate,nameWithOwner
git ls-files | grep -c '\.bak$'
```

**预期**：`origin` 出现两次（fetch/push）；`{"isPrivate":true,"nameWithOwner":"Howebai/fight-the-landlord"}`；`0`。

- [ ] **Step 6: 提交**

```bash
git add .gitignore
git commit -m "chore(repo): 私有仓库首次推送的准备 —— \`.env.local.bak\` 移出受控 + \`.gitignore\` 补 \`*.bak\`（R1302）"
```

---

## Task A2: 镜像命名统一（R1303）

**Files:**
- Modify: `docker-compose.yml`（7 行 `image:`）
- Modify: `tools/conformance/src/slices/slice-07.3-edge.ts:185,187,193`
- Modify: `docs/ops/first-deploy.md`（1 句实测引用）

**Interfaces:**
- Produces: 唯一命名规则 `image: ${IMAGE_PREFIX:-pokergame}-<svc>:${IMAGE_TAG:-latest}`；默认渲染下 6/7 逐字不变、门口由 `ftl-edge:latest` 变为 `pokergame-edge:latest`。
- Consumes: 无。
- 下游：Task A3 的 A11/A12 断言这一形态；Task B2 用 `IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord`。

> ⚠️ **`slice-07.2-deploy.ts:444` 的 `DEGRADED_IMAGE = 'pokergame-api-gateway:latest'` 不得参数化**（R1303 明文）。默认渲染下它逐字不变。

- [ ] **Step 1: 先改判据的 3 处镜像名（红）**

在 [tools/conformance/src/slices/slice-07.3-edge.ts](tools/conformance/src/slices/slice-07.3-edge.ts) 里把 3 处字面量改成**一个常量**（新增在 `:36` 的 `ENV_SCAN_CONTAINER` 附近）：

```ts
/** 门口镜像名（R1303：唯一命名规则 `${IMAGE_PREFIX:-pokergame}-edge:${IMAGE_TAG:-latest}` 的默认形态）。 */
const EDGE_IMAGE = 'pokergame-edge:latest';
```

三处替换：
- `:185` `['image', 'inspect', 'ftl-edge:latest']` → `['image', 'inspect', EDGE_IMAGE]`
- `:187` `info('镜像 ftl-edge:latest 不在本地 ⇒ …')` → `` info(`镜像 ${EDGE_IMAGE} 不在本地 ⇒ 跳过「镜像内 .env*」判据（info，不红）`) ``
- `:193` `'ftl-edge:latest'` → `EDGE_IMAGE`

（`:34` 的 `EDGE_CONTAINER = 'ftl-edge'` **不动** —— 那是容器名。）

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.3-edge`

**预期**：**红** —— B2′ 的 `checks.that(controlOut.length > 0, '探针正对照：镜像内的 /srv 必须找得到 index.html …')`。理由是 `pokergame-edge:latest` 还不存在 ⇒ `image inspect` 非 0 ⇒ 走 info 分支 ⇒ **不红**。⚠️ 此时**真正的红**只在 Step 2 之后出现。

**因此本步的「红」判定改为**：`node tools/conformance/dist/run.js slice-07.3-edge` 在 Step 2/3 完成后必须**没有** `ftl-edge` 字样出现在 `docker image inspect` 的入参里。先在 Step 1 只做替换、不追求红。

- [ ] **Step 2: `docker-compose.yml` 加 7 行 `image:`**

在 6 个 Node/douzero 服务的 `build:` 块**后面**各加一行，并把 `edge` 的那行换掉。逐字如下：

`douzero`（`build:` 在 `:84-86`）：

```yaml
      build:
        context: ./douzero
        dockerfile: Dockerfile
      image: ${IMAGE_PREFIX:-pokergame}-douzero:${IMAGE_TAG:-latest}
```

`user-service`（`:106-108`）→ `image: ${IMAGE_PREFIX:-pokergame}-user-service:${IMAGE_TAG:-latest}`
`room-service`（`:148-150`）→ `image: ${IMAGE_PREFIX:-pokergame}-room-service:${IMAGE_TAG:-latest}`
`game-service`（`:191-193`）→ `image: ${IMAGE_PREFIX:-pokergame}-game-service:${IMAGE_TAG:-latest}`
`robot-service`（`:235-237`）→ `image: ${IMAGE_PREFIX:-pokergame}-robot-service:${IMAGE_TAG:-latest}`
`api-gateway`（`:286-288`）→ `image: ${IMAGE_PREFIX:-pokergame}-api-gateway:${IMAGE_TAG:-latest}`

`edge`（`:348`，**替换**不是新增）：

```yaml
      image: ${IMAGE_PREFIX:-pokergame}-edge:${IMAGE_TAG:-latest}
```

**注释的形态**（⚠️ **2026-09-25 评审订正**）：**理由写一处**（文件头），**每服务只留一行指针** —— 与文件里既有的 R1108 注释同一成例（`# R1108 日志上限：…（**轮转即丢弃** —— 见文件头说明）`）。本步原先把整段理由逐字复制 7 份（28 行），且其中「原先是 `ftl-edge`… 门口需重建」那句对另外 6 个服务是**错的**。

在 `docker-compose.yml` 的文件头（紧接既有的「项目名钉死」注释块、`name: pokergame` 那一行**之前**）新增：

```yaml
# ── 镜像命名（R1303）────────────────────────────────────────────────────
#    唯一规则 = `image: ${IMAGE_PREFIX:-pokergame}-<svc>:${IMAGE_TAG:-latest}`，
#    `<svc>` 就是 compose 的服务键。**7 个带 `build:` 的服务全都要写**。
#    ⚠️ 必须**显式**写出来：compose 的隐式名恒为 `<项目名>-<服务名>`，而项目名不允许带 `/`
#       （`docker compose -p ghcr.io/howebai/x build` ⇒ `invalid project name`；⚠️ 顶层
#       `name:` 那条路更阴 —— 它**静默**删掉非法字符、不报错：同一个 `ghcr.io/howebai/x`
#       经 `name:` 会变成 `ghcriohowebaix`，退出码 0）。
#       ⇒ 显式 `image:` 是拿到 registry 限定名的**正路**：`docker compose push`/`pull`
#       **只认 `image:` 这个操作数**，没有 `image:` 的服务直接 `Skipped`。
#       （`build.tags` 也能给构建产物挂 registry 限定 tag，但 push/pull 照样跳过它 ——
#       所以本仓的推/拉一律以 `image:` 为准。）
#    ⚠️ 与**检出目录名**无关：顶层 `name: pokergame` 已把项目名钉死（见上一节），
#       所以隐式名本来就不会随检出目录漂移 —— 别把这条写成显式 `image:` 的理由。
#    ⚠️ 默认值下与旧名逐字相同，**只有一个例外**：门口原先是 `ftl-edge:latest`，
#       本次统一过来 ⇒ 本机需重建一次门口镜像并 `docker rmi ftl-edge:latest`。
#    ⚠️ CI 必须显式给 `IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord`：那是**推**到
#       镜像库、以及服务器**拉**取时用的 registry 限定名（默认的 `pokergame-*` 只在本地）。
```

> ⚠️ **2026-09-25 第二轮评审订正**：本块第二句原写「不写时 compose 才去按检出目录名推默认名 …… CI 的检出目录是 `fight-the-landlord`」—— **是错的**，而且**复活了本任务正要退休的那条理由**。两轮实测：① 带 `name: pokergame` 的文件放在随机目录名下构建，隐式名仍是 `pokergame-probe`；② `docker compose -p ghcr.io/x/y build` 直接报 `invalid project name`。⇒ 目录无关性是 `name:` 给的，**不是**显式 `image:` 给的；显式 `image:` 买到的是「registry 限定名」这一件事。

然后每个服务块顶部加**同一行**：

```yaml
    # R1303：镜像命名唯一规则（见文件头）
```

- [ ] **Step 3: 验默认渲染（逐字不变的那 6 个 + 门口的新名字）**

```bash
docker compose -f docker-compose.yml config --format json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);for(const n of ['douzero','user-service','room-service','game-service','robot-service','api-gateway','edge'])console.log(n,'=>',j.services[n].image);})"
```

**预期**（逐字）：

```
douzero => pokergame-douzero:latest
user-service => pokergame-user-service:latest
room-service => pokergame-room-service:latest
game-service => pokergame-game-service:latest
robot-service => pokergame-robot-service:latest
api-gateway => pokergame-api-gateway:latest
edge => pokergame-edge:latest
```

再验参数化那半边：

```bash
IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=v9 docker compose -f docker-compose.yml config --format json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);for(const n of ['user-service','edge'])console.log(n,'=>',j.services[n].image);})"
```

**预期**：`user-service => ghcr.io/howebai/fight-the-landlord-user-service:v9` / `edge => ghcr.io/howebai/fight-the-landlord-edge:v9`。
（⚠️ 参数化**只影响带 `build:` 的 7 个**：`redis`/`mysql` 必须仍是 `redis:7-alpine` / `mysql:8.0`。）

- [ ] **Step 4: 本机重建门口镜像 + 删幽灵镜像**

```bash
DOCKER_BUILDKIT=0 docker compose --profile edge build edge
docker rmi ftl-edge:latest
docker compose --profile edge up -d --no-deps edge
```

**预期**：build 结尾 `=> => naming to docker.io/library/pokergame-edge:latest`；`docker rmi` 输出 `Untagged: ftl-edge:latest`；`up -d` 后 `docker ps --format "{{.Names}}\t{{.Image}}"` 里 `ftl-edge` 的镜像列是 `pokergame-edge:latest`。

**不一样怎么办**：`docker rmi ftl-edge:latest` 报 `image is being used by stopped container …` ⇒ 先 `docker rm` 那个容器。**不要**用 `docker rmi -f`（会顺带删掉被共享的层）。

- [ ] **Step 5: 手册里那 1 句实测引用**

在 [docs/ops/first-deploy.md](docs/ops/first-deploy.md) 里找出 `ftl-edge` 的出现处（`:269`/`:287`/`:298`/`:301`/`:563`），**只改指代镜像名的那一处** —— `:563` 那句：

```
（本机实测：不带 `-f` 的 `build` 输出里没有 `ftl-edge`；带 `-f` 的才包含 `Image ftl-edge:latest Building`）。
```

改为：

```
（本机实测：不带 `-f` 的 `build` 输出里没有门口镜像；带 `-f` 的才包含 `Image pokergame-edge:latest Building`）。
```

⚠️ 其余 4 处（`:269`/`:287`/`:298`/`:301`）指的是**容器名** `ftl-edge`，**不动**。⚠️ 这一节整节会在 Task C2 被替换 —— 现在改只是为了让「本片任何时刻的文档都是真话」。

- [ ] **Step 6: 跑 A 类判据（此刻还没有 A11/A12，先确认没回退）**

```bash
pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.2-deploy
```

**预期**：**全绿**，条数与片① 终值 **134** 一致（本步不新增断言）。门口切片：

```bash
node tools/conformance/dist/run.js slice-07.3-edge
```

**预期**：**33 项**全绿（B2′ 的镜像层扫描这次真的跑起来了 —— 因为 `pokergame-edge:latest` 已在本地）。⚠️ 若这条比片① 多出断言数，说明 B2′ 之前一直在 info 跳过，**这是预期内的变化，写进提交信息**。

- [ ] **Step 7: 提交**

```bash
git add docker-compose.yml tools/conformance/src/slices/slice-07.3-edge.ts docs/ops/first-deploy.md
git commit -m "feat(compose): 镜像命名唯一规则（R1303）—— 7 个 build 服务参数化，门口从 ftl-edge 统一到 pokergame-edge"
```

---

## Task A3: A11/A12 判据 —— 命名方案参数化与服务面恰好

**Files:**
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts`

**Interfaces:**
- Produces: 判据 **A11**（两次渲染的参数化 + 注入自证）、**A12**（带 `build:` 的服务恰好 7 个、官方镜像不受波及）。
- Consumes: Task A2 的 `image:` 形态。
- 下游：Task B1 的 `render` 列基线包含这两条。

- [ ] **Step 1: `ISOLATED_KEYS` 加两项**

在 [tools/conformance/src/slices/slice-07.2-deploy.ts](tools/conformance/src/slices/slice-07.2-deploy.ts) 的 `ISOLATED_KEYS`（`:146-153`）里追加：

```ts
  // ⚠️ A11（R1303）：两个镜像命名变量同样是 `${VAR:-}` 输入 ⇒ 宿主 `export` 会让
  //    「默认渲染那半」漂移（R147/A8 同族）。加入剔除后，A11 的默认半边才稳。
  'IMAGE_PREFIX',
  'IMAGE_TAG',
```

同时更新上方那段文档注释：把「新增的 4 个 `${VAR:-}` 输入」改成「**6 个**」。

- [ ] **Step 2: 写 A11/A12 断言（插在 ①a′ 之后、①h 之前）**

在 `:520`（`①a′` 那条 `checks.that(...)` 的闭合 `);`）之后插入：

```ts
    // ── ①a″ A11/A12：镜像命名方案（R1303）─────────────────────────────
    // ⚠️ A11 的**判别力全在第二次渲染**：只渲染一次判不出「参数化」与「写死
    //    `image: pokergame-room-service:latest`」—— 两者在默认值下**一模一样**。
    const BUILD_SERVICES = ['api-gateway', 'douzero', 'edge', 'game-service', 'robot-service', 'room-service', 'user-service'];
    const buildServices = Object.entries(base.services ?? {})
      .filter(([, svc]: [string, any]) => svc?.build)
      .map(([name]) => name)
      .sort();
    // A12：服务面**恰好** —— 防「新增服务绕开镜像库」、防「顺手给官方镜像也加前缀」。
    checks.that(
      JSON.stringify(buildServices) === JSON.stringify(BUILD_SERVICES),
      `A12：带 \`build:\` 的服务恰好这 7 个（且就是 A11 的断言面）—— 实际 ${JSON.stringify(buildServices)}`,
    );
    const defaultImages = buildServices.map((n) => `${n}=${base.services?.[n]?.image ?? '<缺 image:>'}`);
    checks.that(
      buildServices.every((n) => base.services?.[n]?.image === `pokergame-${n}:latest`),
      `A11：默认渲染下每个带 \`build:\` 的服务 \`image\` = \`pokergame-<svc>:latest\` —— 实际 ${JSON.stringify(defaultImages)}`,
    );
    checks.that(
      base.services?.redis?.image === 'redis:7-alpine' && base.services?.mysql?.image === 'mysql:8.0',
      `A12：官方镜像**不受参数化波及**（redis/mysql 逐字不变）—— 实际 ${base.services?.redis?.image} / ${base.services?.mysql?.image}`,
    );
    // 第二次渲染：喂**非默认**前缀与 tag ⇒ 七个镜像名必须整体跟着变量走。
    const paramServices = composeConfig(['-f', 'docker-compose.yml'], {
      IMAGE_PREFIX: 'ghcr.io/x/y',
      IMAGE_TAG: 'v9',
    }).services ?? {};
    const paramImages = BUILD_SERVICES.map((n) => `${n}=${paramServices[n]?.image ?? '<缺 image:>'}`);
    checks.that(
      BUILD_SERVICES.every((n) => paramServices[n]?.image === `ghcr.io/x/y-${n}:v9`),
      `A11 第二次渲染：\`IMAGE_PREFIX=ghcr.io/x/y\` + \`IMAGE_TAG=v9\` ⇒ \`ghcr.io/x/y-<svc>:v9\`（七个都要跟）` +
        ` —— 实际 ${JSON.stringify(paramImages)}`,
    );
```

- [ ] **Step 3: ①j 注入自证 +2 键 +1 断言**

在 `POISONED`（`:608-614`）里追加两项：

```ts
      IMAGE_PREFIX: 'ghcr.io/poisoned/x',
      IMAGE_TAG: 'v-poisoned',
```

在 `try { … }` 块内的 `poisonedPorts` 断言之后（`:632` 之后）追加：

```ts
      // ⚠️ A11 的注入自证（R147/A8 同族）：宿主注了 IMAGE_PREFIX/IMAGE_TAG ⇒ 默认渲染的
      //    七个镜像名**必须仍是** `pokergame-<svc>:latest`。少了这条，`ISOLATED_KEYS` 漏写这两项
      //    时**没有闸会红**（本机 shell 恰好没设它们时）。
      const poisonedImages = BUILD_SERVICES.map((n) => `${n}=${poisoned.services?.[n]?.image ?? '<缺 image:>'}`);
      checks.that(
        BUILD_SERVICES.every((n) => poisoned.services?.[n]?.image === `pokergame-${n}:latest`),
        `宿主 shell 注了 IMAGE_PREFIX/IMAGE_TAG ⇒ 默认渲染的七个镜像名**仍是** \`pokergame-<svc>:latest\`（A11/A8）` +
          ` —— 实际 ${JSON.stringify(poisonedImages)}`,
      );
```

⚠️ `POISONED` 的注释（`:602-603`）要求「一条注什么、读什么，消息就写什么」—— 上面这条消息与新增的两个键**逐字对齐**。同时更新 `:604-607` 的 M5 注释里「先把 **5** 个键的原值存下来」为「**7** 个」。

- [ ] **Step 4: 跑（先红后绿的自证）**

先跑一次确认**新增的 4 条是红的**（把 Task A2 的改动临时回退是破坏性的，改用下面的**证伪法**）：

```bash
pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.2-deploy
```

**预期**：绿，条数 = 134 + 新增条数（实施者填实测值）。

**证伪（必做，R115 同族）**：临时把 `docker-compose.yml` 里 `edge` 的 `image:` 写成字面量 `ftl-edge:latest`（**不动**其它 6 个），跑同一条命令。

**预期**：**红** —— `A11：默认渲染下每个带 build 的服务 image = pokergame-<svc>:latest … 实际 [...edge=ftl-edge:latest]`。改回来再跑一次必须恢复绿。

⚠️ 这一步**只动 `edge` 一行**就够：它同时证明「参数化」与「写死」在默认渲染下判得出差别。

- [ ] **Step 5: 跑全量回归**

```bash
node tools/conformance/dist/run.js slice-07.2-deploy
docker compose --profile edge rm -sf edge
node tools/conformance/dist/run.js slice-07.3-edge
```

**预期**：deploy **不减**（≥ 新的条数）；edge **33** 不减。

- [ ] **Step 6: 提交**

```bash
git add tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "test(conformance): A11/A12 —— 镜像命名两次渲染 + 注入自证（R1303）"
```

---

## Task B1: 纯渲染闸（R1309① · B2）

**Files:**
- Modify: `tools/conformance/src/run.ts`
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts`（A6a(ii) 加 `caddy` 守卫）
- Create: `tools/conformance/baselines.json`
- Create: `scripts/check-baselines.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `node tools/conformance/dist/run.js <case> --render`（跳过 `assertGatewayHealthy()`）· `node … --list`（按 `CASES` 顺序打印用例名）· 步骤 id `caddy` · `baselines.json` 的 `render` 列 · `scripts/check-baselines.mjs <render|full> <log>`。
- Consumes: Task A3 的 A11/A12。
- 下游：Task B3 的 `full` 列复用同一脚本。

- [ ] **Step 1: `run.ts` 加 `--render` 与 `--list`**

改 [tools/conformance/src/run.ts](tools/conformance/src/run.ts) 的 `printUsage()`（`:52-65`）—— 在既有用法说明后追加：

```ts
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '选项：',
      '  --render  纯渲染形态：**不**探测网关健康（跳过 `assertGatewayHealthy()`）。',
      '            只对不依赖 docker daemon 的切片有意义（本仓 = `slice-07.2-deploy` 的',
      '            prod/dev 段，配合 `CONFORMANCE_DEPLOY_STEPS=prod,dev`，以及 `slice-07.4-pipeline`）。',
      '  --list    按 `CASES` 的顺序逐行打印用例名。**CI 的切片循环用它取顺序** ——',
      '            另抄一份清单就是第二个真源。',
    ].join('\n'),
  );
```

改 `main()`（`:67-101`）的开头：

```ts
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // ⚠️ `--list` 必须在 case 查找**之前**：它不是一次运行，是取顺序。
  if (args.includes('--list')) {
    for (const name of Object.keys(CASES)) {
      // eslint-disable-next-line no-console
      console.log(name);
    }
    return;
  }
  const name = args.find((a) => !a.startsWith('--'));
  const renderOnly = args.includes('--render');
  if (!name) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const testCase = CASES[name];
  if (!testCase) {
    // eslint-disable-next-line no-console
    console.error(`未知用例：${name}`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  step(
    `conformance / ${name} —— ${testCase.title}（网关 ${GATEWAY_URL}）` +
      (renderOnly ? ' · `--render`（纯渲染，不探测网关）' : ''),
  );
  const startedAt = Date.now();
  try {
    if (renderOnly) {
      // ⚠️ 纯渲染形态的**全部**理由（B2）：这一步是本 runner 唯一的无条件网络调用，
      //    而渲染类判据（`docker compose config`）**不需要 docker daemon**、
      //    更不需要网关在跑 ⇒ 每次 push 都能跑，2.8s。
      info('`--render`：跳过 `assertGatewayHealthy()`（纯渲染不依赖 docker daemon）');
    } else {
      await assertGatewayHealthy();
    }
    const checks = await testCase.run();
```

（其余各行不变。）`info` 已在该文件导入。

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js --list`

**预期**：15 行，顺序与 `run.ts` 的 `CASES` 逐字一致（`slice-05` … `slice-12`）。

- [ ] **Step 2: A6a(ii) 拆出独立步骤 id `caddy`**

在 [tools/conformance/src/slices/slice-07.2-deploy.ts](tools/conformance/src/slices/slice-07.2-deploy.ts) 里：

1. `DEPLOY_STEPS`（`:470`）改为：

```ts
const DEPLOY_STEPS = ['prod', 'dev', 'caddy', 'runtime', 'n14', 'health'] as const;
```

2. 把 `:568` 的 `── A6a(ii) 运行层 …` 那一整段（含注释，`~:568-597`）包一层守卫，注释同时补充理由：

```ts
      // ── A6a(ii) 运行层（**fail-closed 的第二层**）…（原文注释保留）
      // ⚠️ **独立步骤 id（`caddy`，R1309①/B2）**：这是 `prod`+`dev` 两段里**唯一**的
      //    非 compose docker 调用 ⇒ 纯渲染形态（`CONFORMANCE_DEPLOY_STEPS=prod,dev
      //    --render`）必须能免掉它，否则「每次 push 都跑」就不成立。
      //    ⚠️ 默认（不设 `CONFORMANCE_DEPLOY_STEPS`）**照旧执行** —— 本步只加守卫，不改语义。
      if (runs('caddy')) {
        // …原文逐字…
      }
```

（缩进整体 +2；内容一字不改。守卫**留在 ① 区块内**的原位置 —— 比搬出区块改动面小。）

3. 文件头 `DEPLOY_STEPS` 的用法注释（`:79-83`）里把合法 id 清单更新为 `prod, dev, caddy, runtime, n14, health`，**并写明 `caddy` 必须与 `prod` 同选**。

4. ⚠️ **`=caddy` 单独选中必须响亮报错**（2026-09-25 评审 Important · 用户裁决「加守卫报错」）：守卫落在 `runs('prod')` **之内** ⇒ 只选 `caddy` 会**跑 0 条 caddy 断言且退出码 0** —— 而 `caddy` 是合法、被校验通过的 id，这正是本仓 R115 要防的「闸静默地少做」。在既有的未知-id 检查（`:477-484`）之后追加：

```ts
  // ⚠️ `caddy` 的守卫在 `if (runs('prod'))` **之内**（本任务的 Step 2），⇒ 它隐含依赖 `prod`。
  //    不拦的话，`CONFORMANCE_DEPLOY_STEPS=caddy` 会**跑 0 条 caddy 断言且退出码 0** ——
  //    一个合法 id 静默地少做，正是 R115 要防的形态。宁可响亮。
  if (selected?.has('caddy') && !selected.has('prod')) {
    throw new ConformanceError(
      "步骤 caddy 位于 `if (runs('prod'))` 区块内 ⇒ 必须与 prod 同选\n" +
        '（合法组合：不带该变量 / prod / prod,dev / prod,dev,caddy）',
    );
  }
```

- [ ] **Step 3: 量出纯渲染的断言条数（留白给实测）**

```bash
CONFORMANCE_DEPLOY_STEPS=prod,dev node tools/conformance/dist/run.js slice-07.2-deploy --render
```

**预期**：`✅ slice-07.2-deploy 通过：<N> 项断言，用时 <S>s`，其中 **N ≥ 49**、**S ≈ 2.8**。

再验「不需要 daemon」这半边（**这是本任务的存在理由**）：

```bash
DOCKER_HOST=tcp://127.0.0.1:1 CONFORMANCE_DEPLOY_STEPS=prod,dev node tools/conformance/dist/run.js slice-07.2-deploy --render
```

**预期**：**仍绿**、同一 N 项。（`DOCKER_HOST` 指向死地址 ⇒ 任何真 docker 调用都会失败 ⇒ 这条绿就是「纯渲染」的判别力。）

**对照（必做）**：同一条命令**不带** `CONFORMANCE_DEPLOY_STEPS` ⇒ **必须红**（A6a(ii) 的 `caddy validate` 失败）。这一对红/绿就是本步的证伪。

- [ ] **Step 4: `baselines.json`**

新建 [tools/conformance/baselines.json](tools/conformance/baselines.json)：

```json
{
  "_comment": "各 conformance 切片的**条数下限**（最小值口径）。判据只增不减：调低任何一项都必须在提交信息里写明理由。",
  "_columns": {
    "render": "纯渲染形态（`--render` + 显式步骤选择，不依赖 docker daemon）—— 每次 push 都跑",
    "full": "完整形态（真栈在跑、全部步骤）—— master / tag 上跑"
  },
  "_backfill": "⚠️ 基线是**实测值**，不是预测值。`full` 列必须在**首次 CI 绿跑之后**按那次的实际读数回填（片① §10 的 15 个读数是**本机累积栈**的产物，不能直接当 CI 基线）。缺项由比较脚本**响亮报错**，不会静默通过。",
  "render": {
    "slice-07.2-deploy": 55
  },
  "full": {}
}
```

⚠️ 把 `slice-07.2-deploy` 的 `render` 值改成 **Step 3 的实测 N**（**下限**取实测值，不是「预测值」）。B1 实施时实测为 **55**（片① 的 49 是 deploy 尚在 134 时的读数；A3 把 deploy 提到 140 后，渲染列随之涨到 55）。若你的实测不同，以你的实测为准。

🔴 **不得预置 `slice-07.4-pipeline` 的占位条目**（2026-09-25 评审 Minor · 已采纳删除）：`0` 作为下限会让「B4 建了切片却忘了回填」**静默通过**（`n < 0` 永不成立），与 `_backfill` 那句承诺**正好相反**。**整个键都不写** ⇒ 该切片第一次出现在日志里时，比较脚本的「基线未回填」分支会**响亮报错**。这是有意为之，不是遗漏。

- [ ] **Step 5: 比较脚本（本机与 CI 共用）**

新建 [scripts/check-baselines.mjs](scripts/check-baselines.mjs)：

```js
#!/usr/bin/env node
// conformance 条数闸：把 runner 的输出与 `tools/conformance/baselines.json` 的**下限**比。
//
// ⚠️ 存在的理由（R115 同族）：CI 里「跑到了但只跑了 1 条」与「切片名写错、一个用例都没跑」
//    都会以**退出码 0** 收场 —— 这条把「跑过了」升级成「跑到足够多条」。
// ⚠️ 本机与 CI **共用同一个脚本**（spec B3③）；CI 里作为**独立一步**。
//
// 用法：
//   node scripts/check-baselines.mjs <render|full> <日志文件>
//   node scripts/check-baselines.mjs --self-test      # 负对照自证（不读任何文件）
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = resolve(HERE, '../tools/conformance/baselines.json');
/** runner 成功时的汇总行（`run.ts`）：`✅ <name> 通过：<N> 项断言，用时 <s>s` */
const SUMMARY = /✅\s+(\S+)\s+通过：(\d+)\s+项断言/g;

/** 剥掉 ANSI 转义（成例：`scripts/ci.sh:56` 的 `run_gate`）。 */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

/** 从日志里取出 `切片名 -> 条数`。重复出现⇒取**最大**（同一日志里同一片跑两次时按最好的算）。 */
export function parseCounts(log) {
  const found = new Map();
  for (const m of stripAnsi(log).matchAll(SUMMARY)) {
    const n = Number(m[2]);
    found.set(m[1], Math.max(found.get(m[1]) ?? 0, n));
  }
  return found;
}

/** 纯函数：给定基线表、模式、实际读数 ⇒ 违规清单（空数组 = 通过）。便于 `--self-test` 直接调。 */
export function violations(baselines, mode, counts) {
  const floor = baselines[mode] ?? {};
  const out = [];
  // ⚠️ **先查缺席**（2026-09-25 评审 Important）：基线里列了、日志里没有 ⇒ 那一片根本没跑成
  //    （失败了，或者从 `run.ts --list` 掉了）。少了这条，日志里**少了切片**是**不可见**的 ——
  //    而它正是「闸静默地少做」（R115）的形态：失败的分片不打印 `✅ <name> 通过：N 项断言`
  //    汇总行 ⇒ 解析不到计数 ⇒ 不产生违规。`counts.size === 0` 只兜得住「整盘全灭」。
  for (const name of Object.keys(floor)) {
    if (!counts.has(name)) out.push(`切片 ${name} 在日志里**缺席**（基线列了它）—— 没跑成，或从 --list 掉了`);
  }
  for (const [name, n] of counts) {
    if (!(name in floor)) {
      out.push(`切片 ${name} 的基线**未回填**（${mode} 列）—— 空着就是空测，先回填再跑`);
      continue;
    }
    if (n < floor[name]) out.push(`切片 ${name}：实测 ${n} < 基线 ${floor[name]}（判据只增不减）`);
  }
  return out;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    // 负对照：**四条**都要按预期表现 —— 否则本脚本自己就是空测。
    const b = { render: { a: 10 } };
    const cases = [
      ['低于下限必须报错', violations(b, 'render', new Map([['a', 9]])).length === 1],
      ['达到下限必须放行', violations(b, 'render', new Map([['a', 10]])).length === 0],
      // ⚠️ 这一条的日志里**必须带上**基线的 `a`：新的「缺席」分支先跑，若日志里没有 `a`，
      //    它会额外产出一条「缺席」违规（1+1=2 条）⇒ 这条就不再是「恰一条」、也就测不到
      //    「未回填」这个分支了。成例见 `scripts/check-baselines.mjs` 的同名注释。
      ['未回填的切片必须报错', violations(b, 'render', new Map([['a', 10], ['zz', 999]])).length === 1],
      // ⚠️ 第四条守的是「缺席」（2026-09-25 评审 Important）：基线列了两个，日志只有其中一个
      //    ⇒ 恰好一条违规。少了它，上面那条缺席分支就是**没被测过**的代码。
      [
        '基线列了、日志缺席的切片必须报错',
        violations({ render: { a: 10, b: 5 } }, 'render', new Map([['a', 10]])).length === 1,
      ],
    ];
    let bad = 0;
    for (const [what, ok] of cases) {
      console.log(`${ok ? '✅' : '❌'} self-test：${what}`);
      if (!ok) bad = 1;
    }
    process.exitCode = bad;
    return;
  }
  const [mode, logPath] = argv;
  if (!mode || !logPath || !['render', 'full'].includes(mode)) {
    console.error('用法：node scripts/check-baselines.mjs <render|full> <日志文件>');
    process.exitCode = 2;
    return;
  }
  const counts = parseCounts(readFileSync(logPath, 'utf8'));
  if (counts.size === 0) {
    console.error(`❌ 日志里**一条**「✅ <name> 通过：N 项断言」都没有 —— 切片根本没跑成（${logPath}）`);
    process.exitCode = 1;
    return;
  }
  const bad = violations(JSON.parse(readFileSync(BASELINES, 'utf8')), mode, counts);
  for (const [name, n] of counts) console.log(`[baseline] ${mode} ${name} = ${n}`);
  if (bad.length > 0) {
    for (const line of bad) console.error(`❌ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`=== [baseline] ${mode} 全部 ≥ 下限（${counts.size} 个切片）===`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
```

Run: `node scripts/check-baselines.mjs --self-test`

**预期**：**四条**全 `✅`，退出码 0。（⚠️ 2026-09-25 终审修复轮订正：原文写「三条」—— 脚本收官时自检已有**四条**负对照（第四条＝「基线列了、日志缺席」），以脚本实际打印为准。）

再跑一次真日志（把 Step 3 的输出存下来）：

```bash
CONFORMANCE_DEPLOY_STEPS=prod,dev node tools/conformance/dist/run.js slice-07.2-deploy --render > /tmp/render.log 2>&1
node scripts/check-baselines.mjs render /tmp/render.log
```

**预期**：`=== [baseline] render 全部 ≥ 下限（1 个切片）===`。（⚠️ Windows Git Bash 上 `/tmp` 可用；用不了的换成 `.tmp_render.log`，它已被 `.gitignore` 的 `.tmp_*` 覆盖。）

- [ ] **Step 6: `ci.yml` 加第二个 job `render-gate`**

改 [.github/workflows/ci.yml](.github/workflows/ci.yml) —— **`ci` job 一字不改**，在文件末尾追加：

```yaml
  # ⚠️ R1309①/B2：**纯渲染**判据（片① 的 A 类）从此每次 push 都有自动闸。
  #    与上面的 `ci` job **并行**（互不依赖）：本 job 不需要 docker daemon、不需要任何镜像，
  #    实测 ≈2.8s ⇒ 放在这里几乎不花钱，却把「生产形态保证没有任何自动闸」这个片① 的 R2 关掉。
  #
  # ⚠️ 为什么**不是**六阶段的一部分：六阶段的定义在 `scripts/ci.sh`（单一真源），
  #    而本 job 跑的是 conformance 工具 —— 塞进 `ci.sh` 会让「六阶段」不再是规格里那张表。
  render-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # ⚠️ **必须带 `...`**（= 连同它的依赖一起构建）：`tools/conformance` import 了
      #    `@fight-the-landlord/protocol`，而 `tsc` 解析到的是那个包的 `dist/*.d.ts` ——
      #    不先构建它就会 TS2307 假红。不构建 5 个服务：切片跑在容器里，宿主不需要它们的 dist。
      - run: pnpm exec turbo run build --filter=@fight-the-landlord/conformance...
      # ⚠️ 显式步骤选择 + `--render`：纯渲染 = 全部 `prod`+`dev` 段**减去** `caddy`（A6a(ii)）。
      #    不带 `--render` 会去探测网关健康 ⇒ 没有栈 ⇒ 假红。
      - name: 纯渲染判据（slice-07.2-deploy · prod+dev）
        run: |
          set -o pipefail
          CONFORMANCE_DEPLOY_STEPS=prod,dev \
            node tools/conformance/dist/run.js slice-07.2-deploy --render 2>&1 | tee "$RUNNER_TEMP/render.log"
          node scripts/check-baselines.mjs render "$RUNNER_TEMP/render.log"
```

⚠️ **本步只加「纯渲染判据」这一步**。`slice-07.4-pipeline`（B1）的那一步在 **Task B4 Step 4** 补上 —— 那时切片才存在，现在写了会红。

- [ ] **Step 7: 本机全量回归 + 提交**

```bash
pnpm run ci
node tools/conformance/dist/run.js slice-07.2-deploy
node tools/conformance/dist/run.js slice-07.3-edge
```

**预期**：`=== [ci] 六阶段全部通过 ===`；deploy 条数**不减**；edge **33** 不减。

```bash
git add tools/conformance/src/run.ts tools/conformance/src/slices/slice-07.2-deploy.ts tools/conformance/baselines.json scripts/check-baselines.mjs .github/workflows/ci.yml
git commit -m "feat(ci): 纯渲染闸 —— run.ts --render/--list + A6a(ii) 拆 caddy 步 + ci.yml render-gate + 条数下限比较脚本（R1309①/B2）"
```

---

## Task B2: 镜像流水线 —— `build-images.sh` + `images.yml`（R1305 · R1314①）

**Files:**
- Create: `scripts/deploy/build-images.sh`
- Create: `.github/workflows/images.yml`

**Interfaces:**
- Produces: `ghcr.io/howebai/fight-the-landlord-<svc>:{sha-<短7>, latest}` 七个私有包；`build-images.sh <tag...>` 供 `release.yml` 复用。
- Consumes: Task A2 的参数化 `image:`。
- 下游：Task B3（拉取）、Task C1（部署拉取）。

- [ ] **Step 1（B4④ · 执行时核对）: 私有仓库的 Workflow permissions**

私有仓库的 Actions 默认可能只有**只读**权限 ⇒ 首次推包会 **403**。先在 A1 建好的仓库上核：

```bash
gh api /repos/Howebai/fight-the-landlord/actions/permissions/workflow
```

**预期**：`{"default_workflow_permissions":"write",...}`。

**若返回 `"read"`** ⇒ 改成 write：

```bash
gh api -X PUT /repos/Howebai/fight-the-landlord/actions/permissions/workflow \
  -f default_workflow_permissions=write
```

⚠️ **本步的结论（读到的是什么）要写进实施报告** —— 它是「首次推包会不会 403」的唯一依据。

- [ ] **Step 2: `build-images.sh`（唯一的构建配方）**

新建 [scripts/deploy/build-images.sh](scripts/deploy/build-images.sh)：

```bash
#!/usr/bin/env bash
# 构建并推送 7 个自建镜像到镜像库。**唯一的构建配方** —— `images.yml` 与 `release.yml`
# 都调它（本仓对「同一事实两处实现」付过多次代价）。
#
# 用法：build-images.sh <tag> [<tag>...]
# 环境：
#   IMAGE_PREFIX  镜像库前缀（默认 `pokergame` = 本地形态；CI 里由工作流传
#                 `ghcr.io/howebai/fight-the-landlord`）
#   PUSH          `1` = `--push`（默认）；`0` = 只构建不推（本机演练用）
#   CACHE         `1` = 用 buildx 的 GHA 缓存（默认，只在 CI 里有效）；`0` = 关
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$#" -lt 1 ]; then
  printf '用法：%s <tag> [<tag>...]\n' "$0" >&2
  exit 2
fi

# ⚠️ **必须显式给 `IMAGE_PREFIX`**：默认值 `pokergame` 得到的是 `pokergame-<svc>` ——
#    **非** registry 限定的名字 ⇒ `bake --push` 会往 `docker.io/library/` 推（推不上去），
#    服务器那条 `docker compose pull` 找的也是 `ghcr.io/...`（拉不到）。
#    CI 里必须给成 `ghcr.io/howebai/fight-the-landlord`。
#    ⚠️ 与**检出目录名**无关（别把这条写成理由）：项目名由顶层 `name: pokergame` 钉死，
#       隐式名本来就不会随目录漂移 —— 实测：不带 `IMAGE_PREFIX` 跑 bake，tag 逐字是
#       `pokergame-*`，目录名一次都不出现。
export IMAGE_PREFIX="${IMAGE_PREFIX:-pokergame}"
PUSH="${PUSH:-1}"
CACHE="${CACHE:-1}"

# ⚠️ `docker buildx bake` 直接读 compose 文件 = **不产生第二份构建真源**
#    （context / dockerfile / build args 全部来自 `docker-compose.yml`）。
#    ⚠️ 实测：`--print` 恰好列出 7 个 target（redis/mysql 无 `build:` ⇒ 不在其中）。
BAKE_ARGS=(-f docker-compose.yml)

# 每个 tag 都要打上（`images.yml` 给 `sha-<短> latest`；`release.yml` 给 `sha-<短> <tag>`）。
# bake 的 tags 由 compose 的 `image:` 决定 ⇒ 逐个 tag 跑一轮（tag 数少，代价可忽略）。
for tag in "$@"; do
  export IMAGE_TAG="$tag"
  args=("${BAKE_ARGS[@]}")
  if [ "$CACHE" = "1" ]; then
    # ⚠️ `mode=max` 才能让被多阶段复用的层（`Dockerfile.edge` 的 web 阶段）也进缓存。
    args+=(--set "*.cache-from=type=gha")
    args+=(--set "*.cache-to=type=gha,mode=max")
  fi
  if [ "$PUSH" = "1" ]; then
    args+=(--push)
  fi
  printf '\n=== [build-images] IMAGE_PREFIX=%s IMAGE_TAG=%s ===\n' "$IMAGE_PREFIX" "$tag"
  docker buildx bake "${args[@]}"
done

printf '\n=== [build-images] 完成：%s\n' "$(printf '%s ' "$@")"
```

Run: `bash scripts/deploy/build-images.sh v0-local --print` 前先单独验 bake 能解析：

```bash
docker buildx bake -f docker-compose.yml --print > /dev/null && echo "bake 读 compose OK"
```

**预期**：`bake 读 compose OK`（本机已实测：7 个 target，`edge` 带 `tags`）。

再跑一次**不推**的本地演练（只构建，几分钟）：

```bash
PUSH=0 CACHE=0 IMAGE_TAG=v0-local bash scripts/deploy/build-images.sh v0-local
```

**预期**：7 段构建，结尾 `=== [build-images] 完成：v0-local `；随后 `docker images | grep v0-local` 有 **7** 行。

**不一样怎么办**：若 `bake` 在 CI 上因缓存参数报错 ⇒ **先把真实错误原文贴进实施报告**，再决定退化路径。可选的退化方向（**不要预先照抄**）：逐服务 `docker buildx build --push --cache-from type=gha --cache-to type=gha,mode=max -f <dockerfile> <context>` 循环 —— 代价是 context/dockerfile **要从别处取**，会有第二真源的风险，所以**只在 bake 确实不可用时**才走。

- [ ] **Step 3: `images.yml`**

新建 [.github/workflows/images.yml](.github/workflows/images.yml)：

```yaml
# push→master 时把 7 个自建镜像构建并推到 GHCR（R1304 的触发分级：feature 分支**不**跑）。
#
# ⚠️ 为什么不放在 `ci.yml` 里：`ci.yml` 只是六阶段（`scripts/ci.sh`）的薄调用；
#    把构建塞进去会让「六阶段」不再是规格里那张表。
name: images

on:
  push:
    branches: [master]

jobs:
  images:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # ⚠️ 推 GHCR 私有包**必须**有 write；缺了会在 push 那一步 403。
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: 登录 GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          # ⚠️ 内置 token，**不是**长期密钥 ⇒ 服务器侧与仓库侧都没有长期凭据（R1306）。
          password: ${{ secrets.GITHUB_TOKEN }}
      # ⚠️ `-af` 只在 **runner 侧**允许（一次性机器）；服务器侧只许 `-f`（R1307/R1314）。
      - name: 清理 runner 磁盘
        run: docker image prune -af || true
      - name: 构建并推送 7 个镜像
        env:
          IMAGE_PREFIX: ghcr.io/howebai/fight-the-landlord
        run: |
          SHORT="$(git rev-parse HEAD | cut -c1-7)"
          bash scripts/deploy/build-images.sh "sha-$SHORT" latest
```

- [ ] **Step 4: 推 master 看绿（B 段第一次真 CI 运行）**

```bash
git add scripts/deploy/build-images.sh .github/workflows/images.yml
git commit -m "feat(ci): 镜像流水线 —— build-images.sh（buildx+GHA 缓存）+ images.yml（push→master → GHCR）"
git push origin master
gh run watch "$(gh run list --workflow=images.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
```

**预期**：`images` job 绿；随后

```bash
gh api /user/packages?package_type=container --jq '.[].name' | grep fight-the-landlord
```

**预期**：7 个包名，形如 `fight-the-landlord-user-service`（**连字符**，不是斜杠分隔 —— 这是 R1303 的 `IMAGE_PREFIX` 直接拼出来的名字）。

**不一样怎么办**：403 ⇒ 回 Step 1 把权限改成 write 后 `gh run rerun`。构建超时 ⇒ 看 `--set *.cache-*` 是否生效。

---

## Task B3: 真栈 15 切片进 CI（R1309② · B3 · R1314）

**Files:**
- Create: `scripts/deploy/conformance-stack.sh`
- Create: `.github/workflows/conformance.yml`
- Modify: `tools/conformance/baselines.json`（`full` 列回填）

**Interfaces:**
- Produces: `conformance-stack.sh up|down`（**起真栈的唯一配方**）；`conformance.yml`（master 自建 / `workflow_call` 复用拉取）；`full` 列基线。
- Consumes: Task B1 的 `--list`、`--render`、比较脚本；Task B2 的 GHCR 包。
- 下游：Task B4 的 `release.yml` 复用 `conformance.yml`。

- [ ] **Step 1: `conformance-stack.sh`（起真栈的唯一配方）**

新建 [scripts/deploy/conformance-stack.sh](scripts/deploy/conformance-stack.sh)：

```bash
#!/usr/bin/env bash
# 起 / 收 conformance 用的真栈。**唯一的一份配方**（spec §9 B 段的交付物）——
# 本机与 CI 跑的是同一条命令、同一组注入值，否则「本机绿、CI 红」无从判读。
#
# 用法：conformance-stack.sh up | down
# 环境：
#   IMAGE_TAG_PULL  **非空** = 从 GHCR 拉这个 tag 的镜像（`release.yml` 的复用路径）；
#                   **空**（默认）= 本机构建（master 的 push 路径）。
#   EDGE_HTTP_PORT / EDGE_HTTPS_PORT  宿主发布端口（默认 8080/8443 —— **非特权端口**）
set -euo pipefail
cd "$(dirname "$0")/../.."

export EDGE_HTTP_PORT="${EDGE_HTTP_PORT:-8080}"
export EDGE_HTTPS_PORT="${EDGE_HTTPS_PORT:-8443}"
IMAGE_TAG_PULL="${IMAGE_TAG_PULL:-}"
LOCAL_PREFIX="pokergame"
GHCR_PREFIX="ghcr.io/howebai/fight-the-landlord"
SERVICES=(api-gateway douzero edge game-service robot-service room-service user-service)

case "${1:-}" in
  up)
    # ⚠️ `--profile edge` 是**全局参数**（写在子命令前），且**必须**带：
    #    不带它时 override 把门口标了 `profiles: ["edge"]` ⇒ 门口根本不起，
    #    而 conformance 的 `slice-07.3-edge` 需要它。
    if [ -n "$IMAGE_TAG_PULL" ]; then
      printf '=== [stack] 从 GHCR 拉 %s:%s ===\n' "$GHCR_PREFIX" "$IMAGE_TAG_PULL"
      echo "${GHCR_TOKEN:?拉取路径需要 GHCR_TOKEN}" \
        | docker login ghcr.io -u "${GHCR_USER:?}" --password-stdin
      # ⚠️ 登出**必须**在任何失败路径上生效（R1306 三层登出的第 ① 层）。
      trap 'docker logout ghcr.io' EXIT
      IMAGE_PREFIX="$GHCR_PREFIX" IMAGE_TAG="$IMAGE_TAG_PULL" \
        docker compose --profile edge -f docker-compose.yml pull
      # ⚠️ **落回默认名**（`pokergame-<svc>:latest`）。理由**不是**好看：
      #    `slice-07.2-deploy.ts:1134` 把 `pokergame-api-gateway:latest` 写成
      #    `checks.eq(imageCheck.status, 0, …)` 的**硬前提**，不是 info 跳过
      #    ⇒ 不落回默认名，CI 上「降级 ⇒ 503」那一段必红。
      for svc in "${SERVICES[@]}"; do
        docker tag "$GHCR_PREFIX-$svc:$IMAGE_TAG_PULL" "$LOCAL_PREFIX-$svc:latest"
      done
      docker logout ghcr.io
      trap - EXIT
    fi
    # ⚠️ 用**开发形态**（不带 `-f` ⇒ 自动合并 override）+ 门口 profile：
    #    15 个切片里的绝大多数按 `localhost:3000` 等**宿主发布端口**直连服务，
    #    那套端口只存在于 override ⇒ 生产单文件形态跑不动它们。
    # ⚠️ **`--build` 只在构建路径上**（2026-09-25 评审 Important）：拉取路径用的是刚 pull
    #    回来、并已 tag 成默认名的镜像 —— 带上 `--build` 会用**本地源码**重建 7 个镜像、
    #    把上面的 tag 覆盖掉，于是 ① 构建次数从 2 变 3（R1314⑤）② 验证的**不是**推上去的
    #    那个产物 ⇒ 「复用拉取」整段变成白送。
    if [ -n "$IMAGE_TAG_PULL" ]; then
      docker compose --profile edge up -d --wait --wait-timeout 900
    else
      docker compose --profile edge up -d --build --wait --wait-timeout 900
    fi
    docker compose ps
    ;;
  down)
    # ⚠️ `down` **删不掉**带 profile 的容器（R1209）⇒ 必须先按 profile 点名删门口，
    #    否则下一轮的「无残留」判据会测到**旧镜像**（空测）。
    docker compose --profile edge rm -sf edge || true
    # ⚠️ **不带 `-v`**：本机这么跑会连命名卷（MySQL 数据）一起删掉。
    docker compose down
    # 残留检查（响亮，不静默）。
    left="$(docker ps -a --filter 'name=^/ftl-' --format '{{.Names}}' | tr '\n' ' ')"
    if [ -n "$left" ]; then printf '❌ [stack] 收尾后仍有容器：%s\n' "$left" >&2; exit 1; fi
    printf '=== [stack] 收尾干净（无 ftl-* 容器）===\n'
    ;;
  *)
    printf '用法：%s up|down\n' "$0" >&2
    exit 2
    ;;
esac
```

Run（本机演练，**先收口再起**，避免与常驻 8 容器抢端口）：

```bash
bash scripts/deploy/conformance-stack.sh down || true
bash scripts/deploy/conformance-stack.sh up
```

**预期**：`up` 结尾 `docker compose ps` 有 **9** 行（8 + 门口 `ftl-edge`，全部 `healthy`）。

⚠️ **收尾时把本机恢复成片① 的常驻形态**（8 容器）：

```bash
bash scripts/deploy/conformance-stack.sh down
docker compose up -d
```

**预期**：`docker ps` 8 行（无 `ftl-edge`）。

- [ ] **Step 2: `conformance.yml`**

新建 [.github/workflows/conformance.yml](.github/workflows/conformance.yml)：

```yaml
# 真栈 conformance：**Linux 侧验证的自动化答案**（片① 用户裁决「后移到实际部署时统一跑」由此落地且长期生效）。
#
# 三种被调用形态：
#   * push→master：自己构建 7 镜像，起真栈，跑全部切片（feature 分支**不跑** —— R1304 的触发分级）。
#   * `workflow_call`（由 `release.yml` 传 `image_tag`）：**拉刚推好的 tag 镜像**，省一次全量构建
#     （R1314⑤：tag 路径的构建次数 = 2）。
#
# ⚠️ **额度吃紧时的降级路径**（R1314③）：把上面的 `on.push.branches` 删掉，只留 `workflow_call`
#    ⇒ 真栈 conformance 就只在 tag 上跑（由 `release.yml` 复用调用）。
#    ⚠️ **这不是「一行改动」**（2026-09-25 订正）：`slice-07.4-pipeline` 把本文件的触发集合钉成
#    `{push, workflow_call}` ⇒ 删 `push` 会**同时**红那道闸 ⇒ 要**两处一起改**（本文件 + 那道切片
#    里的期望集合）。⚠️ 另：「手动 dispatch」也不成立 —— `release.yml` 的 dispatch 路径会把
#    conformance 整个 `if` 掉（**那正是回滚要的秒级**），所以没有任何手动入口能跑真栈。
#    代价：master 上不再有真栈闸（渲染闸 `render-gate` 仍在 `ci.yml` 里每次 push 跑，不受影响）。
name: conformance

on:
  push:
    branches: [master]
    tags-ignore: ['**']
  workflow_call:
    inputs:
      image_tag:
        description: '从 GHCR 拉的既有 tag；留空 = 本机构建'
        required: false
        type: string

jobs:
  conformance:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # 拉 GHCR 私有包需要 read（复用路径）。
      packages: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # ⚠️ `...` = 连同依赖一起构建（`tools/conformance` 需要 `@fight-the-landlord/protocol` 的
      #    `dist`）。**不**构建 5 个服务 —— 它们跑在容器里，由 Dockerfile 在镜像内自己构建。
      - run: pnpm exec turbo run build --filter=@fight-the-landlord/conformance...
      - name: 起真栈
        env:
          IMAGE_TAG_PULL: ${{ inputs.image_tag }}
          GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GHCR_USER: ${{ github.actor }}
        run: bash scripts/deploy/conformance-stack.sh up
      # ⚠️ 单一栈 · **串行** · 固定顺序（spec B3①），顺序**取自 `run.ts` 的 `CASES`**。
      #    `set +e` + 累积 `fail`：某一片红也要把其余的跑完（一次拿到全貌），最后统一非零退出。
      - name: 跑全部切片（顺序取自 run.ts 的 CASES）
        run: |
          set +e
          # 🔴 **`set -o pipefail` 必须有**（2026-09-25 评审 Critical）：本步没有 `shell:`，
          #    Actions 用 `bash -e {0}` ⇒ **没有** pipefail ⇒ 管道的退出码取**最后一条**
          #    命令（`tee`，恒 0）⇒ `… | tee … || fail=1` **永远不触发** ⇒ **某一片红而
          #    其它片绿时 job 照绿**。实测：无 pipefail `fail=0`（吞掉），有 pipefail `fail=1`。
          #    成例：本仓 `ci.yml` 的 render-gate 同一位置就是 `set -o pipefail`。
          set -o pipefail
          fail=0
          LOG="$RUNNER_TEMP/conformance.log"
          : > "$LOG"
          for c in $(node tools/conformance/dist/run.js --list); do
            echo "───── $c ─────" | tee -a "$LOG"
            node tools/conformance/dist/run.js "$c" 2>&1 | tee -a "$LOG" || fail=1
          done
          node scripts/check-baselines.mjs full "$LOG" || fail=1
          exit $fail
      - name: 收尾（无论成败）
        if: always()
        run: bash scripts/deploy/conformance-stack.sh down || true
```

⚠️ `tags-ignore: ['**']` 与 `branches: [master]` 同时给：`branches` 本身已把 tag 推排除在外，这一行是**显式**表达 R1304 的分级（tag 推只走 `release.yml`）。

- [ ] **Step 3: 首次跑 = `full` 列回填（B3②）**

```bash
git add scripts/deploy/conformance-stack.sh .github/workflows/conformance.yml
git commit -m "feat(ci): conformance.yml —— 真栈 15 切片在 Ubuntu 上跑（唯一配方 conformance-stack.sh）"
git push origin master
gh run watch "$(gh run list --workflow=conformance.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
```

**预期**：绿。运行日志里每条切片一行 `✅ <name> 通过：<N> 项断言`。

**刚跑红是正常的** —— 这正是 `full` 列为空时比较脚本存在的意义。第一次跑必然在 `check-baselines` 那一步红（`❌ 切片 … 的基线**未回填**（full 列）—— 空着就是空测`），**这正是判据**。

把那次运行里的**实际读数**填进 [tools/conformance/baselines.json](tools/conformance/baselines.json) 的 `full` 列 —— 键 = `node tools/conformance/dist/run.js --list` 打出来的那 16 个名字，值 = **那一次**的实际条数。形状如下（⚠️ 下面**只有一个示例条目**，其余 15 个必须逐个从日志里抄 —— **本计划不预填数字**，那正是片① 「条数不预测」的纪律）：

```json
  "full": {
    "slice-07.2-deploy": <CI 那次运行的实际条数>
  }
```

⚠️ 三条口径：
- `slice-06` 条数 = `8 + 2×房间数`（**数据相关**）⇒ 填 CI 上**最小值**；
- CI 是**全新 runner**（命名卷是新的）⇒ 读数应当稳定，但**以首次绿跑为准**，不以本机片① 的读数为准；
- `slice-07.4-pipeline` 在 Task B4 建出来之后才有值（本步先不填它，B4 的 Step 4 会补）。

⚠️ **负对照（必做）**：故意把某一项调高 1（例如 `slice-07.2-deploy: 135`）⇒ 重跑该 job ⇒ **必须红**在 `check-baselines` 那一步。这就是这条闸的判别力（否则它只是「跑过了」的另一种写法）。

- [ ] **Step 4: 提交回填**

```bash
git add tools/conformance/baselines.json
git commit -m "test(ci): baselines.json 的 full 列按首次 CI 绿跑回填（B3②）"
git push origin master
```

**预期**：这一次 `conformance` job **全绿**。

- [ ] **Step 5: 本机共用同一条比较（B3③「本机与 CI 共用」）**

本机把 15 片跑一遍、存日志、用同一个脚本比：

```bash
set +e
for c in $(node tools/conformance/dist/run.js --list); do
  node tools/conformance/dist/run.js "$c" 2>&1 | tee -a .tmp_full.log
done
node scripts/check-baselines.mjs full .tmp_full.log
```

**预期**：`=== [baseline] full 全部 ≥ 下限（16 个切片）===`（Task B4 之后是 16 —— 含 `slice-07.4-pipeline`）。

---

## Task B4: `release.yml`（images + conformance）+ B1 判据（R1304 · B1）

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `tools/conformance/src/slices/slice-07.4-pipeline.ts`
- Modify: `tools/conformance/src/run.ts`（注册 CASES）
- Modify: `tools/conformance/package.json`（`js-yaml` devDep + `conformance:slice-07.4-pipeline`）
- Modify: `tools/conformance/baselines.json`
- Modify: `.github/workflows/ci.yml`（补 render-gate 的第 2 步）

**Interfaces:**
- Produces: `release.yml`（tag + dispatch；`images` 带 `if`、`conformance` 复用、`deploy` 占位留给 Task C1）；判据 **B1**。
- Consumes: Task B2 的 `build-images.sh`、Task B3 的 `conformance.yml`。
- 下游：Task C1 往 `release.yml` 加 `deploy` job 并把 B1 断言扩到 `needs`。

- [ ] **Step 1: `js-yaml` 进 `tools/conformance` 的 devDependencies**

```bash
pnpm --filter @fight-the-landlord/conformance add -D js-yaml@4.3.2
```

⚠️ **为什么必须显式加**：`js-yaml@4.3.2` 只在 `node_modules/.pnpm/` 里（是别的包的传递依赖），**从仓库根与从 `tools/conformance` 都解析不到** ⇒ 不加这一行，`import yaml from 'js-yaml'` 会 `TS2307`，`tsc` 直接红。

⚠️ **解析器不许换**（spec B1 的警告半句）：YAML 1.1 语义的实现会把 `on` 读成布尔 `true` ⇒ 否定式断言恒绿、肯定式断言响亮假红。`js-yaml@4` 与树里的 `yaml@1.10.3` 都是**字符串键**（控制者实测）。

- [ ] **Step 2: 先写 B1 切片（红）**

新建 [tools/conformance/src/slices/slice-07.4-pipeline.ts](tools/conformance/src/slices/slice-07.4-pipeline.ts)：

```ts
/**
 * conformance 用例：**流水线清点**（spec B1）。
 *
 * 只读 `.github/workflows/*.yml` —— **不碰 docker**，可跑 `--render`（render-gate job 每次 push 都跑它）。
 *
 * 判别力全在两处：
 *   ① 断言写成**集合相等**（不是「包含」）⇒ 多一个工作流、多一个触发分支都会红；
 *   ② **负对照**：合成的 `on: push` 与合成的 `needs` 喂同一个谓词 ⇒ 必须红。
 *      少了它，解析器把 `on` 读歪（YAML 1.1 的 `on` → `true`）时**没有任何闸会响**。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { Checks, info, step } from '../lib/assert';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

/** 工作流文件名的**恰好**集合（R1304 的触发分级落地形态）。⚠️ `deploy.yml` **不得**存在。 */
const EXPECTED_FILES = ['ci.yml', 'conformance.yml', 'images.yml', 'release.yml'];

function readWorkflow(file: string): any {
  return load(readFileSync(join(WF_DIR, file), 'utf8'));
}

/**
 * 取 `on` 的**规范化**形态。⚠️ 三种写法在 YAML 里等价、在 JS 里不等价：
 *   `on: [push, pull_request]`（数组）· `on: push`（字符串）· `on: {push: {...}}`（对象）。
 * 不归一化就会把「写法不同」误报成「触发不同」。
 */
export function onShape(on: unknown): { events: string[]; pushBranches: string[] | null; pushTags: string[] | null; dispatch: boolean } {
  if (typeof on === 'string') return { events: [on], pushBranches: null, pushTags: null, dispatch: false };
  if (Array.isArray(on)) return { events: [...on].map(String).sort(), pushBranches: null, pushTags: null, dispatch: false };
  const obj = (on ?? {}) as Record<string, any>;
  const push = obj.push ?? {};
  return {
    events: Object.keys(obj).sort(),
    pushBranches: Array.isArray(push?.branches) ? [...push.branches].map(String).sort() : null,
    pushTags: Array.isArray(push?.tags) ? [...push.tags].map(String).sort() : null,
    dispatch: 'workflow_dispatch' in obj,
  };
}

/** `jobs.<name>.needs` 归一化成排序后的数组（字符串与数组两种写法都收）。 */
export function needsOf(job: any): string[] {
  const n = job?.needs;
  if (n === undefined || n === null) return [];
  return (Array.isArray(n) ? n : [n]).map(String).sort();
}

export async function runSlice074Pipeline(): Promise<Checks> {
  const checks = new Checks();

  step('B1 工作流清点：文件集合 · 触发分级 · release 的串行');
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  info(`.github/workflows 下实际文件：${files.join(', ')}`);
  checks.that(
    JSON.stringify(files) === JSON.stringify(EXPECTED_FILES),
    `工作流文件**恰好**这四个（不得有 \`deploy.yml\` —— 部署必须收在 release.yml 里用 needs 串行）` +
      ` —— 实际 ${JSON.stringify(files)}`,
  );

  // ── ci.yml：push / pull_request，每次 push 都跑 ──────────────────────
  const ci = readWorkflow('ci.yml');
  const ciOn = onShape(ci.on);
  checks.that(
    JSON.stringify(ciOn.events) === JSON.stringify(['pull_request', 'push']),
    `ci.yml 触发恰为 {push, pull_request} —— 实际 ${JSON.stringify(ciOn.events)}`,
  );
  checks.that(
    'render-gate' in (ci.jobs ?? {}),
    `ci.yml 必须有第二个 job \`render-gate\`（R1309①：纯渲染判据**每次 push** 都跑）` +
      ` —— 实际 jobs = ${JSON.stringify(Object.keys(ci.jobs ?? {}))}`,
  );

  // ── images.yml：**只** push→master（feature 分支不跑）────────────────
  const images = readWorkflow('images.yml');
  const imagesOn = onShape(images.on);
  checks.that(
    JSON.stringify(imagesOn.events) === JSON.stringify(['push']),
    `images.yml 触发恰为 {push} —— 实际 ${JSON.stringify(imagesOn.events)}`,
  );
  checks.that(
    JSON.stringify(imagesOn.pushBranches) === JSON.stringify(['master']),
    `images.yml 只跑 push→master（feature 分支不跑 —— R1304 的触发分级）` +
      ` —— 实际 push.branches = ${JSON.stringify(imagesOn.pushBranches)}`,
  );

  // ── conformance.yml：push→master **且** 可被 release.yml 复用 ────────
  const conf = readWorkflow('conformance.yml');
  const confOn = onShape(conf.on);
  checks.that(
    JSON.stringify(confOn.events) === JSON.stringify(['push', 'workflow_call']),
    `conformance.yml 触发恰为 {push, workflow_call}（后者供 release.yml 复用 —— R1314⑤ 少一次全量构建）` +
      ` —— 实际 ${JSON.stringify(confOn.events)}`,
  );

  // ── release.yml：**tag `v*`** + `workflow_dispatch`（回滚入口）────────
  const rel = readWorkflow('release.yml');
  const relOn = onShape(rel.on);
  checks.that(
    JSON.stringify(relOn.events) === JSON.stringify(['push', 'workflow_dispatch']),
    `release.yml 触发恰为 {push, workflow_dispatch} —— 实际 ${JSON.stringify(relOn.events)}`,
  );
  checks.that(
    JSON.stringify(relOn.pushTags) === JSON.stringify(['v*']),
    `release.yml **只**由 tag \`v*\` 触发（R1304：打 tag 才部署）—— 实际 push.tags = ${JSON.stringify(relOn.pushTags)}`,
  );
  checks.that(
    relOn.pushBranches === null,
    `release.yml 的 push **不得**带 branches（带了就会「push master 也部署」）—— 实际 ${JSON.stringify(relOn.pushBranches)}`,
  );

  // ⚠️ 竞态的正解（§3 的 🔴）：`deploy` 若与 `images` 并行触发，会在镜像推上去**之前**开始
  //    ⇒ 拉不到 tag 镜像。收进同一工作流 + `needs` 串行是唯一解法。
  const jobs = rel.jobs ?? {};
  checks.that(
    'images' in jobs && 'conformance' in jobs,
    `release.yml 必须有 \`images\` 与 \`conformance\` 两个 job —— 实际 ${JSON.stringify(Object.keys(jobs))}`,
  );
  checks.that(
    String(jobs.images?.if ?? '').includes('github.event_name') && String(jobs.images?.if ?? '').includes('push'),
    `release.yml 的 \`images\` job 必须带 \`if: github.event_name == 'push'\`` +
      `（否则 dispatch 回滚时会用 **master HEAD** 构建并**覆盖推成** \`:v<旧tag>\` ⇒ 静默部署错版本）` +
      ` —— 实际 if = ${JSON.stringify(jobs.images?.if)}`,
  );
  checks.that(
    JSON.stringify(needsOf(jobs.conformance)) === JSON.stringify(['images']),
    `release.yml 的 \`conformance\` 必须 \`needs: [images]\` —— 实际 ${JSON.stringify(needsOf(jobs.conformance))}`,
  );

  // ── 负对照（R115 同族）：同一个谓词喂**合成**输入 ⇒ 必须红 ────────────
  step('B1 判别力自证：合成输入喂同一个谓词 ⇒ 必须红');
  const syntheticPush = onShape({ push: {} });
  checks.eq(
    JSON.stringify(syntheticPush.events) === JSON.stringify(['push', 'workflow_call']),
    false,
    '负对照：`on: push`（无 workflow_call）喂 conformance 的谓词 ⇒ **必须不相等**' +
      '（若这条绿了，说明谓词恒真 —— 上面的断言全是空测）',
  );
  const wrongNeeds = needsOf({ needs: ['images'] });
  checks.eq(
    JSON.stringify(wrongNeeds) === JSON.stringify(['images', 'conformance']),
    false,
    '负对照：`needs: [images]` 喂 deploy 的谓词 ⇒ **必须不相等**',
  );
  // ⚠️ 解析器自证（B1 的警告半句）：`on` 必须被解析成**字符串键**。若某个 YAML 1.1 语义的
  //    解析器把它读成布尔 `true`，`onShape` 会走进对象分支、`events` 为空 ⇒ **下面这条必红**。
  checks.that(
    Object.keys(load('on: push\n') as object).includes('on'),
    '解析器自证：`js-yaml` 必须把 `on` 解析成**字符串键**（YAML 1.1 语义会读成布尔 `true` ⇒ 全部触发断言失真）',
  );

  return checks;
}
```

在 [tools/conformance/src/run.ts](tools/conformance/src/run.ts) 里注册（`CASES` 末尾，并补 import）：

```ts
import { runSlice074Pipeline } from './slices/slice-07.4-pipeline';
```

```ts
    'slice-07.4-pipeline': { title: '流水线清点（工作流集合 / 触发分级 / needs 串行）', run: runSlice074Pipeline },
```

Run: `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-07.4-pipeline --render`

**预期**：**红** —— `.github/workflows` 下只有 `ci.yml`（外加 B1/B2/B3 已建的三个不够）⇒ 文件集合那一条先红。

- [ ] **Step 3: 写 `release.yml`**

新建 [.github/workflows/release.yml](.github/workflows/release.yml)：

```yaml
# **打 tag 才部署**（R1304）。三个 job 用 `needs` **串行**：
#
#   images（仅 tag push）→ conformance（复用 workflow_call，拉刚推好的 tag 镜像）
#                        → deploy（Task C1 补上）
#
# 🔴 **为什么不能拆成独立的 `deploy.yml`**：两个工作流都挂 `push: tags` 时会**同时**被触发、
#    并行跑 ⇒ 部署可能在镜像推上去**之前**开始 ⇒ 拉不到 tag 镜像（一次竞态型假红）。
#
# ⚠️ `workflow_dispatch` 是**回滚入口**（R1308）：那条路径上 `images` 必须被 `if` 掉，
#    否则它会用 **master HEAD** 构建并**覆盖推成** `:v<旧tag>`（GHCR 的 tag 默认可覆盖）
#    ⇒ 静默部署错版本。
name: release

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      image_tag:
        description: '要部署/回滚到的**既有** tag（如 v1.0.0）。回滚时填上一个 tag（秒级：只 pull，不构建）'
        required: true
        type: string

jobs:
  images:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: 清理 runner 磁盘
        run: docker image prune -af || true
      - name: 构建并推送 7 个镜像（`sha-<短>` + 本 tag）
        env:
          IMAGE_PREFIX: ghcr.io/howebai/fight-the-landlord
        run: |
          SHORT="$(git rev-parse HEAD | cut -c1-7)"
          bash scripts/deploy/build-images.sh "sha-$SHORT" "${{ github.ref_name }}"

  conformance:
    needs: images
    if: github.event_name == 'push'
    permissions:
      contents: read
      packages: read
    uses: ./.github/workflows/conformance.yml
    with:
      image_tag: ${{ github.ref_name }}
```

Run: `node tools/conformance/dist/run.js slice-07.4-pipeline --render`

**预期**：**绿**，`✅ slice-07.4-pipeline 通过：<N> 项断言`。

（`deploy` job 在 Task C1 加入；加之前 B1 的 `needs` 断言只覆盖 `conformance → images` 这一条边，Task C1 会把它扩到 `deploy`。）

- [ ] **Step 4: 把 B1 接进 `render-gate`（每次 push）**

在 [.github/workflows/ci.yml](.github/workflows/ci.yml) 的 `render-gate` job 末尾补上 Task B1 Step 6 留下的那一步（⚠️ **追加**到同一个 `render.log` 再比一次 —— 这样 `baselines.json` 的 `render` 列两个条目都真的被用上，不留死配置）：

```yaml
      # ⚠️ B1（工作流清点）也在这里跑：它只读 YAML、不碰 docker，与 `--render` 的语义一致。
      - name: 工作流清点（slice-07.4-pipeline · B1）
        run: |
          set -o pipefail
          node tools/conformance/dist/run.js slice-07.4-pipeline --render 2>&1 | tee -a "$RUNNER_TEMP/render.log"
          node scripts/check-baselines.mjs render "$RUNNER_TEMP/render.log"
```

再补一条基线：

```json
  "render": {
    "slice-07.2-deploy": <Task B1 Step 3 的实测>,
    "slice-07.4-pipeline": <本步实测>
  },
```

- [ ] **Step 5: 全量回归 + 推 master 看两个 job 都绿**

```bash
pnpm run ci
node tools/conformance/dist/run.js slice-07.2-deploy
node tools/conformance/dist/run.js slice-07.3-edge
node tools/conformance/dist/run.js slice-07.4-pipeline --render
node scripts/check-baselines.mjs --self-test
git add -A
git commit -m "feat(ci): release.yml（tag v* → images → conformance，needs 串行）+ B1 工作流清点判据 slice-07.4-pipeline"
git push origin master
```

**预期**：本机全绿；推上去后 `ci`（含 `render-gate`）与 `conformance`（含新切片）两个 job 都绿。

- [ ] **Step 6: B1 的负对照演练（证伪，必做）**

临时把 `release.yml` 的 `images` job 的 `if` 删掉 → 本地跑 `slice-07.4-pipeline --render` ⇒ **必须红**（`images job 必须带 if: …`）。改回来后必须恢复绿。

再临时新建一个空的 `.github/workflows/deploy.yml`（`on: workflow_dispatch` + 一个空 job）⇒ 再跑 ⇒ **必须红**（文件集合那一条）。删掉后恢复绿。

⚠️ 这两次演练**不进提交**，只把结论写进实施报告。

- [ ] **Step 7: 打第一个 tag（干跑一次 tag 路径）**

```bash
git tag v0.0.1-test
git push origin v0.0.1-test
gh run watch "$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
```

**预期**：`images` 绿 → `conformance` 绿（拉的是 `v0.0.1-test` 的镜像）。此刻还没有 `deploy` job ⇒ 到此为止。

**删掉这个测试 tag**（它没有部署价值，留着会污染「上一个 tag 怎么找」）：

```bash
git push origin :refs/tags/v0.0.1-test
git tag -d v0.0.1-test
```

---

## Task C1: 部署与回滚脚本（R1306 / R1307 / R1308）

**Files:**
- Create: `scripts/deploy/deploy.sh`
- Create: `scripts/deploy/rollback.sh`
- Modify: `.github/workflows/release.yml`（加 `deploy` job）
- Modify: `tools/conformance/src/slices/slice-07.4-pipeline.ts`（B1 扩到 `deploy` 的 `needs`）

**Interfaces:**
- Produces: `deploy.sh <tag>` · `deploy.sh --assert-clean` · `rollback.sh <旧 tag>`；`release.yml` 的 `deploy` job。
- Consumes: Task B2 的 `build-images.sh`、Task B3 的镜像包、Task A1 的仓库。
- 下游：Task C4 的首次真部署。

> ⚠️ **本任务开始前需要用户给域名**（`SITE_URL` 的真值，如 `https://game.example.com`），并把它配成**仓库变量**（不是 secret —— secret 会把冒烟失败时的诊断信息掩码成 `https://***/api/health`）。

- [ ] **Step 1（用户动作 + 实施者）: 配仓库变量与密钥**

```bash
gh variable set SITE_URL --body "https://<用户给的域名>"
```

再生成**专用部署私钥**（**不复用**用户自己的密钥）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ftl_deploy -N "" -C "ftl-deploy"
```

把 `~/.ssh/ftl_deploy.pub` 的内容交给用户，请用户贴进服务器的 `~/.ssh/authorized_keys`（Task C2 的手册里会有逐条命令）。

```bash
gh secret set SSH_HOST --body "<用户给的服务器 IP 或域名>"
gh secret set SSH_USER --body "ubuntu"
gh secret set SSH_KEY < ~/.ssh/ftl_deploy
```

**预期**：

```bash
gh variable list
gh secret list
```

`SITE_URL` 出现在 variable 列表；`SSH_HOST`/`SSH_USER`/`SSH_KEY` 出现在 secret 列表。

- [ ] **Step 2: `deploy.sh`**

新建 [scripts/deploy/deploy.sh](scripts/deploy/deploy.sh)：

```bash
#!/usr/bin/env bash
# 把一个既有 tag 部署到 `/srv/pokergame/`。**工作流只调用它** ⇒ 本机也能一条命令演练
# （本仓的「门禁要能本地跑」纪律）。
#
# 用法：deploy.sh <tag>            部署（幂等：同 tag 重跑不得出现 `Recreated`）
#       deploy.sh --assert-clean   只做部署后断言（C4 的机械闸；由 release.yml 的
#                                  `if: always()` 收尾步骤调用 ⇒ 它**必须能独立跑**）
# 环境（本地演练从 `.env.deploy.local` 读，CI 从密钥库注入 —— **同一套变量名**）：
#   SSH_HOST SSH_USER SSH_KEY SITE_URL GHCR_PULL_TOKEN
set -euo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ 本地演练：从 `.env.deploy.local`（仓库根）读。它被既有规则 `.gitignore:21` 的
#    `.env.*.local` 覆盖（实测 `git check-ignore -v` 命中）⇒ **不需要新规则**。
if [ -f .env.deploy.local ]; then
  set -a; . ./.env.deploy.local; set +a
fi

: "${SSH_HOST:?缺 SSH_HOST}"
USER_="${SSH_USER:-ubuntu}"
: "${SSH_KEY:?缺 SSH_KEY（部署私钥的路径）}"
REMOTE_DIR="/srv/pokergame"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
TARGET="$USER_@$SSH_HOST"

ssh_do() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

if [ "${1:-}" = "--assert-clean" ]; then
  # ── C4（R1306③）：把「服务器上无长期凭据」从人工判据升级成**机械闸** ──
  # ⚠️ 为什么必须是独立入口：job 超时 / runner 失联时**没有步骤会跑** ⇒ 只能由部署后的
  #    `if: always()` 步骤 ssh 回去断言（`deploy.sh` 自己的 trap 在那种情况下不会执行）。
  out="$(ssh_do 'cat ~/.docker/config.json 2>/dev/null || echo "{}"')"
  if printf '%s' "$out" | grep -q 'ghcr.io'; then
    printf '❌ [deploy] 服务器 ~/.docker/config.json 里**仍有** ghcr.io 条目：\n%s\n' "$out" >&2
    exit 1
  fi
  ls_out="$(ssh_do "ls -A $REMOTE_DIR")"
  # ⚠️ **只有**这两个文件（R1306：服务器上不放仓库、不放部署密钥）。
  if [ "$(printf '%s\n' "$ls_out" | sort | tr '\n' ' ')" != ".env docker-compose.yml " ]; then
    printf '❌ [deploy] %s 下的内容不是「恰好 .env + docker-compose.yml」：%s\n' "$REMOTE_DIR" "$ls_out" >&2
    exit 1
  fi
  printf '✅ [deploy] C4：服务器上无 ghcr 凭据、且 %s 只有两个文件\n' "$REMOTE_DIR"
  exit 0
fi

TAG="${1:?用法：deploy.sh <tag> | deploy.sh --assert-clean}"
: "${SITE_URL:?缺 SITE_URL（冒烟的目标，如 https://game.example.com）}"
: "${GHCR_PULL_TOKEN:?缺 GHCR_PULL_TOKEN}"

printf '=== [deploy] 送 compose 基文件到 %s:%s/ ===\n' "$TARGET" "$REMOTE_DIR"
# ⚠️ **只送基文件**（R1306）：override 是**开发面**，不该出现在服务器上。
#    服务器的 `.env` **手工写一次、部署永不覆盖** ⇒ 这里不碰它。
ssh_do "mkdir -p $REMOTE_DIR"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new docker-compose.yml "$TARGET:$REMOTE_DIR/docker-compose.yml"

printf '=== [deploy] tag=%s 拉取 + 起栈 + 冒烟 ===\n' "$TAG"
# ⚠️ 一整段在一个 ssh 会话里跑：`trap … EXIT` 才能覆盖**所有**失败路径（R1306 三层登出的第 ① 层）。
#    第 ② 层是工作流的 `if: always()`；第 ③ 层是 `--assert-clean`。
set +e
ssh_do "bash -s" <<REMOTE
set -euo pipefail
cd $REMOTE_DIR
# ⚠️ 登**任何时候**退出都要登出（含中间任一步失败）。
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord
export IMAGE_TAG=$TAG
docker compose -f docker-compose.yml pull
echo "───── up -d ─────"
docker compose -f docker-compose.yml up -d 2>&1 | tee /tmp/ftl-up.log
# 🔴 幂等判据的前置（C3 + **2026-09-25 复评 Critical**）：先判定「这次是不是**同 tag 重跑**」。
#    ⚠️ 原来这里是**无条件** `grep -q Recreated` —— 那是**错的**：`up -d` 在**镜像解析结果变了**
#    时就会打印 `Recreated`，而 tag 每次发布/回滚都变 ⇒ 脚本会在 compose 已经**更新完栈之后**、
#    在**冒烟之前** exit 1 ⇒ **每次发布和每次回滚都假红，而且第一次之后的发布再也不冒烟**。
#    规格的判据（R1307/C3）逐字是「**同 tag 重跑**不得出现 Recreated」⇒ 只在同 tag 时断言。
#    ⚠️ 判定**必须只看活栈、不得往 `/srv/pokergame/` 写标记文件**（`--assert-clean` 把那个目录
#    钉死为「恰好两个文件」）。⚠️ 判据面**只含本仓镜像**：`redis`/`mysql` 是上游镜像、永远不带
#    `$IMAGE_TAG`，要求它们也匹配同 tag 会让整个判据**恒不成立**（＝一道死闸）。
# （实现见 scripts/deploy/deploy.sh 的「幂等判据的前置」段；这里只留契约与理由。）
if [ "$same_tag" = "1" ]; then
  if grep -q Recreated /tmp/ftl-up.log; then
    echo "❌ 幂等判据（C3）：同 tag 重跑出现 Recreated" >&2
    exit 1
  fi
# ⚠️ **两处 `grep` 都要有**（2026-09-25 终审 M14）：原先 `else` 分支**无条件**打印下面这句
#    「up -d 报了 Recreated」—— 而 tag 变化**不必然**产生 Recreated（层没变时容器不重建）
#    ⇒ 那会打印一句**假话**，正是 C1 修复轮在修的那个genre。改成只有真的报了才说。
elif grep -q Recreated /tmp/ftl-up.log; then
  echo "ℹ️ [deploy] up -d 报了 Recreated —— 首次部署 / tag 变化下的**预期**行为（幂等判据只约束同 tag 重跑）"
fi
echo "───── 冒烟三条（**不带 -k** —— 真证书；**有界重试**，见下）─────"
# ⚠️ **有界重试**（2026-09-25 复评 Important）：`up -d` 返回时容器只是**启动了**、还没**就绪**
#    （门口 healthcheck 的 start_period 是 60s，网关还等 4 个服务）⇒ 第一次 curl 撞 502 是常态。
#    不重试的话**正常路径**也会红。⚠️ 重试不得削弱判据：**最后一次仍必须是真 200 且不带 `-k`**。
#    ⚠️ **每条 curl 都要自带单次超时**（2026-09-25 终审 Important）：只有重试次数**不是**上限 ——
#    对端**丢包**（而不是拒连）时，一次 TCP connect 默认能挂 ~130s（Linux `tcp_syn_retries=6`），
#    而手册自己把「连接超时」写成**被挡端口的正常症状** ⇒ 60 × 130s ≈ 2.2 小时，而注释与手册
#    都写着 5 分钟。**两处都是假话**。加上 `--connect-timeout 5 --max-time 15` 之后，
#    最坏 = 3 × 15 = 45s/次，再配 deadline 截断 ⇒ 才真的是 5 分钟。⚠️ `-fsS` 保留、`-k` 永远不加。
curl -fsS --connect-timeout 5 --max-time 15 "$SITE_URL/api/health" >/dev/null
curl -fsS "$SITE_URL/" >/dev/null
curl -fsS "$SITE_URL/socket.io/?EIO=4&transport=polling" | grep -q '"sid"'
# ⚠️ 磁盘卫生（R1307）：**只许 -f**（只删悬空）。加 -a 会删掉上一个 tag 的镜像，
#    把「秒级回滚」变成一次网络拉取。
docker image prune -f
REMOTE
rc=$?
set -e

if [ $rc -ne 0 ]; then
  printf '\n❌ [deploy] 部署失败。回滚命令（把上一个 tag 换上）：\n' >&2
  printf '    bash scripts/deploy/rollback.sh <上一个 tag>\n' >&2
  printf '    或在 GitHub 上跑 release 工作流的 workflow_dispatch，image_tag 填上一个 tag。\n' >&2
  exit $rc
fi
printf '\n✅ [deploy] tag=%s 部署完成\n' "$TAG"
```

- [ ] **Step 3: `rollback.sh`**

新建 [scripts/deploy/rollback.sh](scripts/deploy/rollback.sh)：

```bash
#!/usr/bin/env bash
# 回滚到**一个已存在的旧 tag**（R1308）。走的是与 deploy **完全同一条路径**（代码不动），
# 只换 tag —— 因为镜像已经在 GHCR 上（`docker image prune -f` 保住了它）⇒ **秒级**。
#
# 用法：rollback.sh <旧 tag>
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -f .env.deploy.local ]; then
  set -a; . ./.env.deploy.local; set +a
fi

TAG="${1:?用法：rollback.sh <旧 tag>}"
: "${SSH_HOST:?缺 SSH_HOST}"
: "${SSH_KEY:?缺 SSH_KEY}"
: "${GHCR_PULL_TOKEN:?缺 GHCR_PULL_TOKEN}"

# ⚠️ R1308 的前提：**只 pull 已存在的 tag**（否则会拉到一个不存在的镜像 ⇒ 部署到一半失败）。
#    先问镜像库「这个 tag 在不在」—— 不在就**别动服务器**。
printf '=== [rollback] 先确认 %s 在镜像库上存在 ===\n' "$TAG"
if ! echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
  printf '❌ [rollback] docker login 失败\n' >&2; exit 1
fi
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
if ! docker manifest inspect "ghcr.io/howebai/fight-the-landlord-api-gateway:$TAG" >/dev/null 2>&1; then
  printf '❌ [rollback] 镜像库里没有 tag `%s`（先确认 tag 名；可 `gh api /user/packages/...` 或本地 `docker images` 找）\n' "$TAG" >&2
  exit 1
fi
printf '✅ [rollback] %s 存在 ⇒ 走与 deploy 同一条路径\n' "$TAG"
exec bash scripts/deploy/deploy.sh "$TAG"
```

- [ ] **Step 4: `release.yml` 加 `deploy` job**

在 [.github/workflows/release.yml](.github/workflows/release.yml) 末尾追加：

```yaml
  deploy:
    # 🔴 不能写 `if: always()`：那会在 images/conformance **失败**时也部署。
    #    正确形态 = always && !cancelled && 两个上游都不是 failure/cancelled
    #    ⇒ dispatch 路径上 conformance 是 skipped，仍然放行（回滚秒级，R1308）。
    needs: [images, conformance]
    if: |
      always() && !cancelled()
      && (needs.images.result == 'success' || needs.images.result == 'skipped')
      && (needs.conformance.result == 'success' || needs.conformance.result == 'skipped')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v4
      - name: 部署（或回滚）
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_USER: ${{ secrets.SSH_USER }}
          # ⚠️ 两个名字**故意不同**：`SSH_KEY` 是 `deploy.sh` 要的**路径**（与本地演练同名），
          #    `DEPLOY_KEY_CONTENT` 才是密钥**内容**。同名会让「路径 vs 内容」在这段脚本里
          #    看起来是同一个东西 —— 那正是最容易写错的地方。
          SSH_KEY: ${{ runner.temp }}/deploy_key
          DEPLOY_KEY_CONTENT: ${{ secrets.SSH_KEY }}
          SITE_URL: ${{ vars.SITE_URL }}
          GHCR_PULL_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GHCR_USER: ${{ github.actor }}
          # ⚠️ tag push ⇒ 部署 `v1.2.3`；dispatch（回滚）⇒ 部署输入里那个**既有** tag。
          IMAGE_TAG: ${{ github.event_name == 'push' && github.ref_name || inputs.image_tag }}
        run: |
          set -euo pipefail
          printf '%s\n' "$DEPLOY_KEY_CONTENT" > "$SSH_KEY"
          chmod 600 "$SSH_KEY"
          bash scripts/deploy/deploy.sh "$IMAGE_TAG"
      # ⚠️ R1306③：登出的**第三层**。job 超时 / runner 失联时前面那些步骤一条都不会跑，
      #    只有 `if: always()` 会 ⇒ 它 ssh 回去断言「没有留下 ghcr 凭据」（C4 的机械闸）。
      - name: 收尾断言：服务器上没有留下镜像库凭据（C4）
        if: always()
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_USER: ${{ secrets.SSH_USER }}
          SSH_KEY: ${{ runner.temp }}/deploy_key
          DEPLOY_KEY_CONTENT: ${{ secrets.SSH_KEY }}
        run: |
          printf '%s\n' "$DEPLOY_KEY_CONTENT" > "$SSH_KEY"
          chmod 600 "$SSH_KEY"
          bash scripts/deploy/deploy.sh --assert-clean
```

- [ ] **Step 5: B1 断言扩到 `deploy` 的 `needs`**

在 [tools/conformance/src/slices/slice-07.4-pipeline.ts](tools/conformance/src/slices/slice-07.4-pipeline.ts) 的 `checks.that(JSON.stringify(needsOf(jobs.conformance)) …)` 之后追加：

```ts
  checks.that(
    'deploy' in jobs,
    `release.yml 必须有 \`deploy\` job —— 实际 ${JSON.stringify(Object.keys(jobs))}`,
  );
  checks.that(
    JSON.stringify(needsOf(jobs.deploy)) === JSON.stringify(['conformance', 'images']),
    `release.yml 的 \`deploy\` 必须 \`needs: [images, conformance]\`（竞态的正解：串行 ⇒ 部署不会先于镜像推送）` +
      ` —— 实际 ${JSON.stringify(needsOf(jobs.deploy))}`,
  );
  const deployIf = String(jobs.deploy?.if ?? '');
  checks.that(
    deployIf.includes('always()') && deployIf.includes('needs.images.result') && deployIf.includes('needs.conformance.result'),
    `\`deploy\` 的 \`if\` 必须同时看得住两个上游的结果（只写 \`always()\` 会在上游**失败**时也部署）` +
      ` —— 实际 ${JSON.stringify(jobs.deploy?.if)}`,
  );
```

同时把 `release.yml` 的 `deploy` job `if` 里的字符串与断言**逐字对齐**（上面 Step 4 的 `if` 已含 `always()`、`needs.images.result`、`needs.conformance.result`）。

- [ ] **Step 6: 负对照 + 全量回归**

临时把 `deploy` 的 `if` 里的 `needs.conformance.result` 那一行删掉 ⇒ 跑 `slice-07.4-pipeline --render` ⇒ **必须红**。改回来后恢复绿。

```bash
pnpm run ci
node tools/conformance/dist/run.js slice-07.4-pipeline --render
node scripts/check-baselines.mjs --self-test
```

**预期**：全绿；`slice-07.4-pipeline` 条数 = 之前 + 3（实施者填实测）。

- [ ] **Step 7: 提交**

```bash
git add scripts/deploy/deploy.sh scripts/deploy/rollback.sh .github/workflows/release.yml tools/conformance/src/slices/slice-07.4-pipeline.ts tools/conformance/baselines.json
git commit -m "feat(deploy): deploy.sh / rollback.sh + release.yml 的 deploy job（needs 串行、三层登出、只许 prune -f）（R1306/R1307/R1308）"
```

---

## Task C2: 手册重写（R1311）

**Files:**
- Modify: `docs/ops/first-deploy.md`

**Interfaces:**
- Produces: ⑦ 整节替换为「部署由流水线完成」；新增「服务器预备」与「回滚」两节；三类过期措辞全文扫掉。
- Consumes: Task C1 的脚本名与命令。
- 下游：Task C4 按它执行。

- [ ] **Step 1: 三类过期措辞全文扫描**

```bash
grep -n "仓库根\|4GB 机器\|10–20 分钟\|10-20 分钟" docs/ops/first-deploy.md
```

**预期**：至少命中 `:158`（「仓库根」）、`:130`（「在服务器上现写」附近）、`:557`（「**4GB 机器首次约 10–20 分钟**」）。逐条按下面的口径改：

| 过期句 | 新句 |
|---|---|
| 「命令都在服务器的**仓库根**」 | 「命令都在服务器的 **`/srv/pokergame/`**（那里**不再有仓库**，只有 `docker-compose.yml` + `.env`）」 |
| 「`.env` 在**仓库根**」 | 「`.env` 在 **`/srv/pokergame/`**」 |
| 「**4GB 机器首次约 10–20 分钟**」 | 整句删掉（**服务器上不再构建**）。改为：「镜像由 CI 构建好推到镜像库 ⇒ 服务器只**拉取**，不构建、不装工具链」 |
| 「内存 4GB」（若有） | 「内存 **7.5 GiB**（`free -h` 实测）」 |

- [ ] **Step 2: ⑦ 整节替换**

把 [docs/ops/first-deploy.md](docs/ops/first-deploy.md) 的 `:534`–`:592`（从 `## ⑦ 代码怎么上去（**临时手工路径**）` 到 `---` 之前）**整节替换**为：

````markdown
## ⑦ 代码怎么上去（**部署由流水线完成**）

> ⚠️ **本节是「计划期草稿」，不是真源**：**最终文本在 `docs/ops/first-deploy.md` 的 ⑦ 节**（终审后又补了 **7.0**：仓库侧四样设置 + 「第一次的顺序」；并订正了冒烟超时的算术）。
> **以手册为准**，本节保留只为记录当初的意图。

> 片① 这里原是一条**临时手工路径**（在服务器上 clone 仓库、构建镜像）。片② 已把它替换：
> **服务器上没有仓库、没有源码、不构建**。上面 ①–⑥ 的「起栈」在第一次上线时仍然照跑（那是预备），
> 之后**每一次发布都不再登录服务器**。

### 7.0 动手之前：仓库侧四样设置 + **第一次的顺序**（2026-09-25 终审 Important 补）

**① 仓库侧四样设置**（Settings → Secrets and variables → Actions）：

| 类型 | 名字 | 值 |
|---|---|---|
| Secret | `SSH_HOST` | 服务器 IP / 域名 |
| Secret | `SSH_USER` | `ubuntu` |
| Secret | `SSH_KEY` | 〇① 那把**部署私钥的内容**（不是路径） |
| **Variable** | `SITE_URL` | `https://<域名>`（⚠️ 是 variable **不是 secret** —— 放进 secret 会把冒烟失败时的诊断信息掩码成 `https://***/api/health`） |

⚠️ **缺了会怎样（逐样不同 —— 2026-09-25 终审订正）**：`SSH_HOST` ⇒ `deploy` 当场失败、日志明写「缺 `SSH_HOST`」；`SITE_URL` ⇒ **还没碰到服务器**就失败、明写「缺 `SITE_URL`」；⚠️ **`SSH_USER` 可缺**（脚本自带默认值 `ubuntu`）；⚠️ **`SSH_KEY` 缺了**连不上服务器，但日志里**不会**出现「缺 `SSH_KEY`」—— 守卫查的是**路径**、而路径永远都在，真实症状是 `Load key …: invalid format`（或 `error in libcrypto`）＋ `Permission denied (publickey)`。
（原稿一句「少任何一样都会在第一步失败」是**假话**：对 `SSH_USER` 不成立，对 `SSH_KEY` 的报错形态也说错了。**最终文本以手册为准**。）

**② 第一次的顺序：先 push 一次 `master`、把数字填回来，然后才打 tag** —— 别跳过。
原因：`tools/conformance/baselines.json` 的 `full` 列**一开始是空的**，而比较脚本对空基线**按设计响亮报错**（「基线未回填」）⇒ **第一次 `conformance` 必红** ⇒ 而 `deploy` 的 `if` 要求上游 ∈ {success, skipped} ⇒ **`deploy` 会被跳过**，那个「三个 job 全绿」的预期**不可能出现**。

⇒ 正确顺序：`git push origin master` → 看那次 `conformance` 运行 → **从它的日志里**读出每条切片的实际条数（比较脚本会在报违规**之前**先打印 `[baseline] full <切片名> = 数字`）→ 填进 `full` 列 → push → 这时才 `git tag`。

⚠️ 那次红**是判据在工作，不是故障**。

### 7.1 平时怎么发版（一条命令）

```bash
$ git tag v1.0.0
$ git push origin v1.0.0
```

**然后什么都不用做** —— GitHub Actions 会自动按顺序做三件事（`release` 工作流）：

| 顺序 | job | 做什么 |
|---|---|---|
| 1 | `images` | 把 7 个镜像构建好、推到镜像库（GHCR），打上 `v1.0.0` 与 `sha-<短>` 两个标签 |
| 2 | `conformance` | 拉起一台一次性 Linux 机器，用**刚推上去的那套镜像**跑全部端到端切片 |
| 3 | `deploy` | 把 `docker-compose.yml` 送到服务器 → `pull` 新镜像 → `up -d` → 冒烟三条 |

**顺序是串行的**（job 2 等 job 1、job 3 等 job 2）—— 这是**故意**的：并行的话部署可能抢在镜像推上去之前开始，会拉不到镜像。

**要盯着什么**：`https://github.com/Howebai/fight-the-landlord/actions` 上那个 `release` 运行，三个 job 全绿就算发布成功。`deploy` 那一步的输出里应当能看到：

```
✅ [deploy] tag=v1.0.0 部署完成
```

**停机多久**：`pull` + `up -d` 只重建**变化的**容器 ⇒ **秒级**。这一个可接受的代价换来了「不需要蓝绿/双机」。

### 7.2 只跑流水线、不部署（改完想看结果）

feature 分支上 push ⇒ 只跑 `ci`（六阶段）+ `render-gate`（纯渲染判据）。
push 到 `master` ⇒ 额外跑 `images` 与 `conformance`（**真栈 15 切片**跑在一台一次性 Ubuntu 上）。
⇒ **想验证一个改动，推 master 就够，不用打 tag。**

### 7.3 磁盘卫生（服务器侧）

**每次发布之后都值得做**，服务器磁盘不大的话尤其：

```bash
$ docker image prune -f
Deleted Images:
untagged: sha256:13aaabe062ce…
deleted: sha256:13aaabe062ce…
…
Total reclaimed space: 1.734GB
```

**为什么**：`pull` 每次都会把上一版镜像留下（7 个镜像 ≈4.9GB）。盘一满，**MySQL 会先被拖死**（写不进去即崩，症状看起来像「数据库莫名挂了」）。

🔴 **只许 `-f`，绝不用 `-af`**：`-f` 只删**悬空镜像**（没有 tag、也没有容器在用它们的那些旧层），正在跑的容器与带 tag 的镜像**都不受影响**；而 `-af` 会把**上一个 tag 的镜像**一并删掉 —— 那会把「秒级回滚」变成一次几 GB 的网络拉取。

**预期**：结尾一行 `Total reclaimed space: …`（首次做通常回收 1–3GB）。显示 `Total reclaimed space: 0B` 也**正常**。
````

- [ ] **Step 3: 新增「服务器预备」一节**

在 ① 之前插入新的一节（编号顺延会打乱既有引用 —— 本节**不编号**，放在文件最前面「开始之前」之后），标题与内容：

````markdown
## 〇 服务器预备（**手工一次**）

> ⚠️ **本节是「计划期草稿」，不是真源**：本片经多轮评审后，**最终文本在 `docs/ops/first-deploy.md` 的 〇 节**（已与本草稿偏离：`authorized_keys` 改用 **ubuntu 全路径**、`ufw status` 的预期改成**防火墙未启用时的真实形态**、改用 `sudo -u ubuntu docker ps` 等）。
> **以手册为准**，本节保留只为记录当初的意图。⚠️ 同类提示见 ⑦ 与 ⑧。

> 只在**第一次**上线前做一次。做完之后，日常发布完全不碰服务器（见 ⑦）。

**① 部署公钥**（把**部署专用密钥对的公钥** `ftl_deploy.pub` 的内容贴进去 —— 它是为这次部署单独生成、把**公钥**那一半交给你的；**不要**用你自己的登录私钥）：

🔴 **这一步写的是 `ubuntu` 用户的钥匙串、不是 root 的**：流水线以 `ubuntu` 登录。**路径写全，别用 `~`** —— 本手册其余命令多以 root 执行，`~` 会落到 `/root/.ssh/`，那样下面那条验证**必然失败**。（2026-09-25 复评 Important 订正：原稿用的就是 `~`。）

```bash
$ sudo mkdir -p /home/ubuntu/.ssh
$ sudo nano /home/ubuntu/.ssh/authorized_keys     # 把 ftl_deploy.pub 整行粘进去，保存
$ sudo chown -R ubuntu:ubuntu /home/ubuntu/.ssh
$ sudo chmod 700 /home/ubuntu/.ssh
$ sudo chmod 600 /home/ubuntu/.ssh/authorized_keys
```

**预期**：回到你自己的机器上 `ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器 IP>` **不需要密码**就能进。

**不一样怎么办**：仍要密码 / `Permission denied (publickey)` ⇒ 九成是上面的路径或权限：`sudo ls -l /home/ubuntu/.ssh/`（目录 `drwx------`、文件 `-rw-------`、**属主是 `ubuntu`**），再确认 `authorized_keys` 里那一行**没有被编辑器折成两行**。改完重试。

**② 让 `ubuntu` 能用 docker 而不用 sudo**

```bash
$ sudo usermod -aG docker ubuntu
$ exit          # 退出，然后重新登录一次（组变更要新会话才生效）
```

**预期**：重新登录后 `docker ps` **不报 `permission denied`**。
⚠️ 若本来就免 sudo（`docker ps` 直接成功）⇒ **这步是 no-op**，跳过。

**③ 建目录 + 写 `.env`**

```bash
$ sudo mkdir -p /srv/pokergame && sudo chown ubuntu:ubuntu /srv/pokergame
$ nano /srv/pokergame/.env
```

内容 = 上面 ② 的那**五项**（`JWT_SECRET` / `DB_PASSWORD` / `INTERNAL_SERVICE_TOKEN` / `SITE_ADDRESS` / `TLS_MODE`）。

⚠️ **这个 `.env` 是「手工写一次、部署永不覆盖」的**（流水线只送 `docker-compose.yml`）⇒ 以后再发布**不会**动它。

**④ DNS A 记录**：把域名指向这台机器的公网 IP。

**预期**：在你自己机器上 `nslookup <你的域名>` 出来的地址就是服务器 IP。

**⑤ 放行端口（两层都要）**

- 云厂商控制台的安全组：放行 **22 / 80 / 443**（腾讯云叫「安全组」，在「云服务器 → 安全组」里加**入站规则**）。
- 机器内防火墙：

```bash
$ sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
$ sudo ufw status
```

**预期**：三条 `sudo ufw allow …` 各打印一行 `Rules updated`。

⚠️ **此刻 `sudo ufw status` 多半只显示 `Status: inactive`** —— 规则**已经记下**，但防火墙**还没启用**，所以不显示规则表。**这是正常的，不是失败**。规则表要到 **③3.2** 执行 `sudo ufw enable` 之后才会出现，那时再看才应是三行 `ALLOW`。（2026-09-25 复评 Important 订正：原稿直接要求「三行都是 `ALLOW`」，而那台机器上**不可能**出现 —— `ufw enable` 在 ③，按本手册的执行顺序排在 〇 之后。）

**不一样怎么办**：`ufw: command not found` ⇒ `sudo apt-get update && sudo apt-get install -y ufw`。

⚠️ **只开一层是不够的**：安全组拦掉的流量根本到不了机器，机器内的 `ufw` 也就没机会放行 —— 两层是「与」的关系。
````

- [ ] **Step 4: 新增「回滚」一节**

在 ⑦ 之后插入：

````markdown
## ⑧ 回滚（**秒级**）

> ⚠️ **本节是「计划期草稿」，不是真源**：**最终文本在 `docs/ops/first-deploy.md` 的 ⑧ 节**。**以手册为准**。

**什么时候用**：刚发布完发现坏了（页面打不开、登录不上、对局起不来）。

**第一步：找到上一个 tag**

```bash
$ git tag --sort=-creatordate | head -5
v1.0.2
v1.0.1
v1.0.0
```

从上往下是**从新到旧** ⇒ 上一个就是**第二个**（`v1.0.1`）。

**第二步（推荐）：在 GitHub 上点**

`https://github.com/Howebai/fight-the-landlord/actions/workflows/release.yml` → 右上角 **Run workflow** → 分支选 `master`，`image_tag` 填 `v1.0.1` → **Run workflow**。

**预期**：只跑 `deploy` 一个 job（`images` 与 `conformance` 会被跳过 —— 那正是「秒级」的来源），结尾 `✅ [deploy] tag=v1.0.1 部署完成`。

**第二步（备选）：在自己机器上跑**

```bash
$ bash scripts/deploy/rollback.sh v1.0.1
```

**它做了什么**：和发布**完全一样**的路径，只是把 tag 换掉 —— 代码不动、不构建，只 `pull` 那个旧 tag 的镜像再 `up -d`。

⚠️ **前提**：那个 tag 的镜像**还在**镜像库上。这就是服务器侧**只许 `docker image prune -f`** 的原因（`-af` 会把它删掉）。

⚠️ **另一个前提**：**tag 只打在 `master` 上**。打在 feature 分支上的 tag 会指向一个没跑过真栈 conformance 的提交 —— 回滚到一个同样坏（或者更坏）的版本上。

**回滚也失败怎么办**：说明问题不在这一版代码（网络、DNS、证书、磁盘满）。按 ⑥ 排错表逐项查。
````

⚠️ 既有 ⑧（App 包）与新 ⑧ 撞号 ⇒ 把原来的 App 包一节改为 ⑨，并全文扫一遍对它的引用（`见 ⑧` 之类）一并改。

- [ ] **Step 5: 逐行复核 + 提交**

```bash
grep -n "仓库根\|4GB 机器\|10–20 分钟\|git clone" docs/ops/first-deploy.md
```

**预期**：**零命中**（`git clone` 在 7.1 里已被删）。

```bash
git add docs/ops/first-deploy.md
git commit -m "docs(ops): first-deploy 手册 —— ⑦ 换成「部署由流水线完成」+ 新增「服务器预备」「回滚」+ 三类过期措辞（R1311）"
```

---

## Task C3: 文档同步（R1312）

**Files:**
- Modify: `docs/design.md`（§13.4 · §2.2 · §2.3 · §14.4 · §15）
- Modify: `README.md`

**Interfaces:**
- Produces: 设计文档与真实形态一致；**六阶段表一字不动**。
- Consumes: Task B1–B4、C1 的落地形态。

- [ ] **Step 1: §13.4 —— 表**不动**，表下新增小节**

⚠️ **不得**把三个工作流补进 [docs/design.md](docs/design.md) `:1465-1472` 那张六阶段表 —— 它是 `scripts/ci.sh` 的**真源**，补进去就造出第二真源（spec R1312 明文）。

在 `:1501`（§13.4 最后一条 bullet）之后、`:1503` 的 `### 13.5` 之前，插入：

```markdown
`[已实现]`（上线运营层（二），2026-09-24/25）**另有三个工作流**（⚠️ 它们**不在**上表里 —— 上表是 `scripts/ci.sh` 的真源，补进去就是第二真源）：

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `.github/workflows/images.yml` | push→**master** | 构建 7 个自建镜像 → 推私有 GHCR 包 `ghcr.io/howebai/fight-the-landlord-<svc>:{sha-<短7>, latest}` |
| `.github/workflows/conformance.yml` | push→**master** · `workflow_call`（被 `release.yml` 复用时**拉**刚推好的 tag 镜像，省一次全量构建） | 起真栈跑**全部 conformance 切片**（Linux 侧验证的自动化答案），条数下限在 `tools/conformance/baselines.json` |
| `.github/workflows/release.yml` | tag `v*` · `workflow_dispatch`（回滚入口） | `images → conformance → deploy` **三个 job 用 `needs` 串行**（并行会让部署抢在镜像推送之前 ⇒ 竞态型假红） |

`ci.yml` 另有第二个 job **`render-gate`**（每次 push 跑纯渲染判据 —— 不需要 docker daemon、≈2.8s）：它关掉的是片① 登记的 **R2**（「新增的生产形态保证没有任何自动闸」）。

**成本控制**（R1314，与具体额度数字无关）：① 构建走 buildx + GHA 缓存 ② 触发分级（上面那张表）③ **额度吃紧时的降级路径 = 两处一起改**（2026-09-25 订正：原写「一行改动」是**假话** —— `slice-07.4-pipeline` 钉住了 `conformance.yml` 的触发集合，删 `on.push` 会同时红那道闸；且没有任何手动入口，因为 `release.yml` 的 dispatch 路径会把 conformance `if` 掉）：改 `conformance.yml` 的 `on.push` **并**同步那道切片里的期望集合 ⇒ 真栈 conformance 只在 tag 上跑（`render-gate` 不受影响，仍在每次 push 跑）④ CI runner 侧允许 `docker image prune -af`，**服务器侧只许 `-f`** ⑤ tag 路径的构建次数 = **2**（`images` + `conformance` 复用拉取）。
```

- [ ] **Step 2: §13.4 的理由句订正**

把 [docs/design.md:1477](docs/design.md#L1477) 那一行：

```
- **理由**：本仓**没有可验证的远端 CI**。把六阶段写成**脚本**，它就能在门禁里**真的跑一遍**（可验证）；Actions 只承担「在远端把它跑起来」，是不可本地验证的最小面。
```

改为：

```
- **理由**：Actions 的**运行**仍然不可本地验证。把六阶段写成**脚本**，它就能在门禁里**真的跑一遍**（可验证）；Actions 只承担「在远端把它跑起来」，是不可本地验证的最小面。（2026-09-24/25 订正：仓库**已**有远端 CI 与真栈 conformance，但那条**运行**仍只能在 GitHub 上观测 ⇒ 六阶段以脚本为真源的结论不变。）
```

- [ ] **Step 3: §2.2 补镜像库与服务器形态**

在 [docs/design.md:157](docs/design.md#L157) 那一段之后追加两句：

```markdown
**镜像来源**：7 个自建镜像（`douzero` + 5 个 Node 服务 + 门口 `edge`）由 CI 构建、推到私有 GHCR，命名规则唯一 —— `image: ${IMAGE_PREFIX:-pokergame}-<svc>:${IMAGE_TAG:-latest}`（R1303）。服务器**只拉取、不构建**。

**服务器形态**：`/srv/pokergame/` 下**只有** `docker-compose.yml`（由流水线 `scp` 送）与 `.env`（手工写一次、部署永不覆盖）—— **不放仓库、不放部署密钥、不放长期镜像库凭据**（R1306）。
```

- [ ] **Step 4: §2.3 环境变量表加两行**

在 [docs/design.md](docs/design.md) §2.3 的表格末尾追加：

```markdown
| `IMAGE_PREFIX` | **全部自建镜像**（compose 的 `image:`） | `pokergame` | 镜像库前缀。CI 里传 `ghcr.io/howebai/fight-the-landlord`；默认值下镜像名与旧形态逐字相同（门口除外） |
| `IMAGE_TAG` | **全部自建镜像**（compose 的 `image:`） | `latest` | 镜像标签。部署/回滚时传要上的那个 tag |
```

- [ ] **Step 5: §14.4 的 DoD 表加一行**

在 [docs/design.md:1637](docs/design.md#L1637)（`:1637` 那行 `| **§2.4 两个端点** … |`）之后追加：

```markdown
| **部署 = 打 tag**（上线运营层（二）） | `git tag v1.0.0 && git push origin v1.0.0` ⇒ `release.yml` 的 `images → conformance → deploy` | 真域名上线（真证书，`curl` **不带 `-k`** 通）；**手工路径已废止**（⑦ 整节替换） |
| **回滚 = `rollback.sh`** | `bash scripts/deploy/rollback.sh <旧 tag>`（或 `workflow_dispatch` 填 `image_tag`） | 秒级（只 `pull` 已存在的 tag，不构建）；⚠️ 前提：**tag 只打在 `master` 上** |
```

- [ ] **Step 6: §15 新增 §15.4**

在 [docs/design.md](docs/design.md) §15.3 之后、`## 附录 A` 之前插入：

```markdown
### 15.4 部署与回滚

- **发布** = 打 tag（`v*`）→ `release.yml`（`images → conformance → deploy`，`needs` 串行）。
- **回滚** = `bash scripts/deploy/rollback.sh <旧 tag>` 或 `workflow_dispatch` 填 `image_tag`。
- 操作手册：`docs/ops/first-deploy.md`（①–⑨，每条命令带预期输出；「〇 服务器预备」是手工一次的）。
- **服务器磁盘纪律**（🔴）：只许 `docker image prune -f`（只删悬空）。`-af` 会删掉上一个 tag 的镜像，把秒级回滚变成一次几 GB 的网络拉取（R1307/R1314）。
- **凭据面**：镜像由同仓工作流推送 ⇒ 服务器用同一个内置 token 拉取 ⇒ **长期密钥数 = 0**；部署私钥是专用的（不复用登录私钥）。登出是三层（脚本 `trap` · 工作流 `if: always()` · 部署后 `--assert-clean` 断言），见 R1306。
```

- [ ] **Step 7: README 新增「部署与回滚」**

在 [README.md](README.md) 的 `## Docker 编排` 之前插入：

```markdown
## 部署与回滚

发布 = **打 tag**（推 master 只跑 CI 与构建，不部署）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

回滚（秒级，只拉已存在的 tag、不构建）：

```bash
bash scripts/deploy/rollback.sh v0.9.0
```

- 镜像由 CI 构建进私有 GHCR（`ghcr.io/howebai/fight-the-landlord-<svc>:<tag>`）；服务器**只拉取**。
- 服务器形态：`/srv/pokergame/` 只有 `docker-compose.yml` + `.env`（无仓库、无部署密钥、无长期镜像库凭据）。
- 逐条命令与预期输出见 [docs/ops/first-deploy.md](docs/ops/first-deploy.md)。
```

- [ ] **Step 8: 逐行复核 + 提交**

```bash
grep -n "本仓没有可验证的远端 CI" docs/design.md
```

**预期**：**零命中**（Step 2 已订正）。

```bash
grep -n "另有三个工作流\|镜像来源\|回滚 = \`rollback.sh\`\|### 15.4" docs/design.md
grep -n "部署与回滚" README.md
```

**预期**：各自命中。

```bash
git add docs/design.md README.md
git commit -m "docs: §13.4 表下新增「另有三个工作流」小节 + 理由句订正 + §2.2/§2.3/§14.4/§15.4 + README（R1312）"
```

---

## Task C4: 首次真部署（C1–C4）

**Files:**
- Modify: `.superpowers/sdd/progress.md`（终值回填）
- Modify: `docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md`（§10 回填）

**Interfaces:**
- Produces: 真域名上线；C1–C4 四组判据绿。
- Consumes: 全部前置任务 + **用户四项预备**（Task C2 手册的「〇 服务器预备」）。

> ⚠️ **本任务需要用户动手且必须在键盘前**：DNS 生效、证书签发那一刻。实施者**逐条**把命令与预期输出交给用户，等用户回报每一条的实得输出。

- [ ] **Step 0（B4①②③ · 执行时核对，写进实施报告）**

```bash
$ ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器 IP> "docker compose version; docker --version; free -h | head -2; df -h / | tail -1; hostname"
```

**预期**：`Docker Compose version v2.x`（**必须 ≥ v2**）；`Docker version 29.x`；内存 **7.5 GiB**；`/` 可用 ≈**33G**。

核「是不是腾讯云」：

```bash
$ ssh … "sudo dmidecode -s system-manufacturer 2>/dev/null || cat /sys/class/dmi/id/sys_vendor"
```

**预期**：`Tencent Cloud`（若不是，**⑤ 的安全组那一步的入口位置不同**，按厂商改）。

核私有仓库额度：打开 `https://github.com/settings/billing` 看 Actions 分钟数（私有仓库有免费额度，超出计费）。**登记读数，不写死数字**。

- [ ] **Step 1（B4⑤）: GHCR 从服务器可达性**

在服务器上：

```bash
$ echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u Howebai --password-stdin
$ docker pull ghcr.io/howebai/fight-the-landlord-api-gateway:latest
$ docker logout ghcr.io
```

**预期**：`Login Succeeded`；那个镜像**开始下载**（不必等它下完，看到 `Pulling` 就算通）。

**不通怎么办（备选路径）**：在能通的机器上 `docker save` → `scp` → 服务器 `docker load`：

```bash
$ docker save ghcr.io/...-api-gateway:v1.0.0 | gzip > img.tgz
$ scp img.tgz ubuntu@<IP>:/tmp/
$ ssh … "gunzip -c /tmp/img.tgz | docker load"
```

⚠️ **这条备选一旦启用，要在实施报告里登记**（它意味着每次发布要传 ≈4.9GB）。
⚠️ **实施订正（2026-09-25 · 最终评审 M11）**：原文此处曾写「`deploy.sh` 里已为此留了位置（`pull` 换成 `load`）」—— **不实**：脚本硬编码 `docker compose … pull`，**没有**这个开关，备选路径**未实现**；**也不再需要** —— GHCR 可达性已由**首次真部署实证**（服务器成功拉取 7 镜像 + 2 基础镜像 ≈6GB）。

- [ ] **Step 2（用户动作）: 服务器五项预备**

把 Task C2 手册的「〇 服务器预备」五节逐条发给用户，**每条都要用户回报实得输出**。五条全绿才继续。

- [ ] **Step 3（C1）: 首次真部署**

```bash
git tag v1.0.0
git push origin v1.0.0
gh run watch "$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
```

**预期**：`images` → `conformance` → `deploy` 三个 job 依次绿；`deploy` 的输出里有 `✅ [deploy] tag=v1.0.0 部署完成`。

⚠️ 证书签发需要几十秒到几分钟（ACME 要回连 80 端口）。若 `deploy` 在冒烟那一步红，先看服务器上 `docker compose logs edge | tail -50` 里有没有 ACME 的报错。

- [ ] **Step 4（C1）: 三条链的真证书验收（`curl` **不带 `-k`**）**

```bash
$ curl -sS -o /dev/null -w "%{http_code}\n" https://<域名>/api/health
200
$ curl -sS https://<域名>/api/health
{"status":"ok","service":"api-gateway",...}
$ curl -sS -o /dev/null -w "%{http_code}\n" https://<域名>/
200
$ curl -sS "https://<域名>/socket.io/?EIO=4&transport=polling"
0{"sid":"...","upgrades":["websocket"],...}
```

**预期**：如上。⚠️ **不带 `-k`** 是关键 —— 带了 `-k` 自签证书也会过，那就退化成片① 已经验过的半边。**这是片① 唯一没验到的那半边（真证书）**。

再核一眼证书签发者：

```bash
$ echo | openssl s_client -connect <域名>:443 -servername <域名> 2>/dev/null | openssl x509 -noout -issuer -subject -dates
```

**预期**：`issuer` 是 `Let's Encrypt`（**不是** `Caddy Local Authority`）。`notAfter` 在 90 天内。

- [ ] **Step 5（C3）: 幂等**

不动 `.env`、不动 `docker-compose.yml`，同 tag 再跑一次：

```bash
gh workflow run release.yml -f image_tag=v1.0.0
gh run watch "$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
```

**预期**：`deploy` 绿，且**输出里不含 `Recreated`**。（这就是幂等判据 —— 出现了就是红的。）

⚠️ 前提：两跑之间**不得**改 `.env`/compose —— 否则 `Recreated` 是**正常的**，会假红。

- [ ] **Step 6（C2）: 回滚**

```bash
git tag v1.0.1 && git push origin v1.0.1      # 造一个「新版本」
# 等它部署完
gh workflow run release.yml -f image_tag=v1.0.0
```

**预期**：`deploy` 绿；**只跑了 `deploy` 一个 job**（`images`/`conformance` 是 `skipped`）；冒烟三条过。

**记录回滚耗时**（从 workflow 的 `deploy` job 开始到 `✅ [deploy] tag=v1.0.0 部署完成` 的墙上时间）—— 填进实施报告与 spec §10。

- [ ] **Step 7（C4）: 服务器上无长期凭据**

```bash
$ ssh -i ~/.ssh/ftl_deploy ubuntu@<IP> "cat ~/.docker/config.json 2>/dev/null || echo '(无此文件)'"
(无此文件)
$ ssh … "ls -A /srv/pokergame"
.env
docker-compose.yml
```

**预期**：`config.json` 里**没有** `ghcr.io`（文件不存在也算过）；`/srv/pokergame/` 下**只有**两个文件。

（`release.yml` 的 `if: always()` 收尾步骤已经机械断言过这两条 —— 这一步是**人工复核**，用于确认那个断言真的在工作。）

- [ ] **Step 8: 回填 + 提交**

把实测值填进：
- [docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md](docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md) §10 的四行（判据 A/B/C/D · 首次真部署 · 文档同步 · 已知取舍）；
- [.superpowers/sdd/progress.md](.superpowers/sdd/progress.md) 的「上线运营层（二）」段（Task 状态表 + 终值）。

```bash
git add docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md
git commit -m "docs(spec): 片② §10 完成状态回填 —— 首次真部署 / 回滚耗时 / 判据终值"
```

⚠️ `.superpowers/` 被 `.gitignore` 忽略 ⇒ 台账**只在磁盘上**（本仓惯例）。

---

## 收口（全部任务之后，控制者做）

- [ ] **全量门禁**（片① 的 D 全套仍须绿）：

```bash
pnpm run ci
for c in $(node tools/conformance/dist/run.js --list); do node tools/conformance/dist/run.js "$c"; done
node scripts/check-baselines.mjs --self-test
# ⚠️ 探针的参数名是 `--scenario`（不是 `--mode`）；Windows 侧还要 `--no-server` + `CHROME_BIN`
#    + `--cdp-port 18800`（见 MEMORY 的 windows-dev-env-quirks）。
node scripts/browser-e2e.mjs --scenario gate
node scripts/browser-e2e.mjs --scenario full
git hash-object scripts/browser-e2e.mjs
```

**预期**：`=== [ci] 六阶段全部通过 ===`；全切片绿；self-test **四条**全 ✅；`gate 18/18`；`full 33/33`；blob = `052b98b7ab779ae280d6673729053145e9829604`。（⚠️ 2026-09-25 终审修复轮订正：原文写「self-test 三条」—— 脚本实际是**四条**负对照。）

- [ ] **零客户端改动**：`git diff --stat <BASE>..HEAD -- apps/client/src` ⇒ **空**。
- [ ] **判据只增不减**：逐项列出每个 slice 与每个包的**新条数**（回填进台账与提交信息），并与片① 终值对照。
- [ ] **全分支评审**（与片① 同形：最强模型独立复核 → 修复轮 → 复评）。
- [ ] **台账收口**：`.superpowers/sdd/progress.md` 的「上线运营层（二）」段写终值与遗留。
