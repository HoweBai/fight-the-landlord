# 斗地主平台 · 上线运营层（二）：上云与自动化（设计规格）

> **日期**：2026-09-24 · **状态**：设计规格 v1（**待用户复核**）
> **上游**：`docs/design.md` §13.4（CI 阶段表）· §2.2（部署拓扑）· §15（运维）· 片① spec §6 的 **R2**（conformance 未进 CI）
> **前一片的记录**：`docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md` §7.6/§10（判据终值）+ `.superpowers/sdd/progress.md` 的「上线运营层（一）」段
> **归属**：本片的**设计真源**。实施计划另出。
> **触发**：用户 2026-09-24 裁决「开片②（上云与自动化）」，并在本片 brainstorming 的七个问题上逐条裁定。
> **本会话用户裁决**（逐条）：
> 1. GitHub = **私有**仓库，账号 `Howebai`；
> 2. 服务器已就绪：**密钥登录**、端口 22；
> 3. 部署触发 = **打 tag 才部署**（push 只跑 CI 与构建镜像）；
> 4. 凭据 = 装 **`gh` CLI** 并登录（建仓/设密钥/看日志/发 tag 都由命令完成）；
> 5. CI 范围 = **连真栈一起在 CI 跑**（比"只接渲染判据"更强 ⇒ 顺带把 Linux 侧验证自动化）；
> 6. 片② 收尾 = **来真的**（把第一次真部署走完）；
> 7. 镜像来源 = **A · CI 构建 → GHCR → VPS 拉取**；门口镜像名**统一**到同一命名规则。

---

## 0. 现状复核（**逐条实测或查证**）

### 0.1 仓库与远端

| 事实 | 证据（实测） |
|---|---|
| **没有任何远端**（`git remote -v` 为空）⇒ 本片从"建仓"开始 | 本会话实测 |
| 推送体量小：`.git` **27MB**、pack **22.36 MiB** | `du -sh .git` / `git count-objects -vH` |
| 受控的疑似密钥文件**只有一个**：`.env.local.bak`（11 个键，值**全部等于仓库里公开的 dev 默认值**：`DB_PASSWORD=root`、`JWT_SECRET=dev-secret-change-in-production`…） | 逐键核对（只打印键名与"是否等于公开默认值"，不打印值） |
| `.gitignore` 已覆盖 `node_modules/` `dist/` `.env` `.env.local` `.env.*.local` `resources/` `.worktrees/` `.superpowers/` `.tmp_*` **但没有 `*.bak`** | `.gitignore:3-4,11,17,27,30` |
| 本机 git 身份 `Howebai <<USER_EMAIL>>`；**`gh` 未安装** | `git config user.*` / `gh: command not found` |

### 0.2 环境事实（用户在其服务器上实测）

| 项 | 值 |
|---|---|
| 系统 | Ubuntu · 内核 `6.8.0-117-generic` · x86_64（主机名 `VM-0-4-ubuntu`，**疑为腾讯云** —— 待核，见 §5 的 B4） |
| 内存 / swap | **7.5 GiB**（可用 5.2 GiB）/ 1.9 GiB |
| 磁盘 | `/dev/vda2` 59G · 已用 25G · **可用 33G** |
| Docker | **29.5.3 已装**（`docker compose` v2 待核，见 §5 B4） |
| 登录 | 用户 **`ubuntu`**（非 root）· 端口 **22** · **密钥登录** ✓ |
| ⚠️ 未测 | `docker ps` 是否需要 sudo（`ubuntu` 是否已在 docker 组）⇒ 设计**不依赖它**（见 R1310 的预备步骤） |

### 0.3 现有 CI

| 事实 | 证据 |
|---|---|
| `.github/workflows/ci.yml` 是**薄调用**：`on: [push, pull_request]` → `bash scripts/ci.sh`（六阶段，单一真源） | 读文件 |
| **conformance 不在 CI 里**（片① 登记为 R2）⇒ 片① 新增的生产形态保证**没有任何自动闸** | 片① spec §7.6 的 R2 + 本会话复核 |
| ✅ **渲染类判据不需要 docker 守护进程**（这是"接进 CI 很便宜"的全部理由） | **实测**：`DOCKER_HOST=tcp://127.0.0.1:1 docker compose config --services` 仍渲染、`exit=0` |
| ❓ 私有仓库的免费 Actions 额度与 runner 磁盘规格 | **本机核不到**（官方文档被网络策略挡）⇒ §5 的判据只写"以官方计费页为准 + 一次核对动作"，且**所有控制手段与具体数字无关** |

### 0.4 自建镜像（实测体积）

带 `build:` 的服务恰好 **7 个**（douzero + 5 个 Node 服务 + edge）；`redis`/`mysql` 无 `build:`（官方镜像）。

| 镜像 | 实测 | 镜像 | 实测 |
|---|---|---|---|
| `pokergame-user-service` | **1.36GB** | `pokergame-robot-service` | 753MB |
| `pokergame-room-service` | 813MB | `pokergame-douzero` | 363MB |
| `pokergame-api-gateway` | 765MB | `ftl-edge` ← **例外名** | 93.9MB |
| `pokergame-game-service` | 753MB | **合计 ≈ 4.9GB** | （+redis 58MB / mysql 1.1GB ⇒ **≈6.1GB**；`docker system df` 去重后 6.24GB —— ⚠️ 见 §7 的订正：这里的"合计"原先被算成 3.5GB） |

### 0.5 片① 留下的接口（本片要接的）

- 门口 `edge`：`container_name: ftl-edge`、`profiles: ["edge"]`（**只在 override**）、固定地址 `172.28.0.250`、命名卷 `caddy-data:/data`；`SITE_ADDRESS`/`TLS_MODE` **无默认值**（漏配 ⇒ `exit 1`）。
- **镜像名例外**：`docker-compose.yml:348` 显式写 `image: ftl-edge:latest`（其余 6 个是 compose 的默认名 `pokergame-<svc>`）。
- 手册 `docs/ops/first-deploy.md`：八节；**⑦ 是临时手工路径**（本片**替换**它）；`/srv/pokergame` 是手册采用的服务器目录。
- 判据 `slice-07.3-edge.ts` 的 I4b（镜像层 `.env*` 检查）**硬编码 `ftl-edge:latest`**（`:185`/`:193`）⇒ 命名统一后必须同步。

---

## 1. 裁决

| # | 裁决 | 性质 |
|---|---|---|
| **R1301** | 本片范围 = ① 私有仓库与首次推送 ② 镜像命名统一 + 四个工作流 ③ 部署/回滚脚本与服务器预备 ④ 首次真部署。**不含**：监控与告警、DB 备份与恢复演练（片③）· 多实例/蓝绿 · 独立 staging 环境 · App 端运行期验证 | 用户裁决 1/6 |
| **R1302** | 仓库 = **私有** `Howebai/fight-the-landlord`，用 `gh` 命令创建。**推送前**：`git rm .env.local.bak` + `.gitignore` 补 `*.bak`；再扫一遍受控文件无真密钥 | 用户裁决 1/4 |
| **R1303** | **镜像命名唯一规则**：带 `build:` 的**每个**服务都写 `image: ${IMAGE_PREFIX:-pokergame}-<svc>:${IMAGE_TAG:-latest}`；门口从 `ftl-edge:latest` **统一过来**（连带更新 `slice-07.3-edge.ts` 的 3 处 + 手册 1 句实测引用）。⚠️ **本地开发影响：6/7 逐字相同，门口是有意例外**（`ftl-edge:latest` → `pokergame-edge:latest`）⇒ 本机需重建一次门口镜像 + `docker rmi ftl-edge:latest`（否则留个幽灵镜像），并同步那 4 处。⚠️ **`slice-07.2-deploy.ts:444` 的 `DEGRADED_IMAGE='pokergame-api-gateway:latest'` 不得参数化**（默认渲染下它逐字不变 —— 独立复核已核） | 用户裁决 7 |
| **R1304** | **触发分级**：feature 分支只跑 `ci.yml`；push 到 **master** 跑 `ci` + `images` + `conformance`；**打 tag（`v*`）** 才跑 `deploy` | 用户裁决 3/5 |
| **R1305** | 镜像库 = **GHCR 私有包**；构建在 CI（buildx + GHA 缓存）；VPS **只拉取** | 用户裁决 7 |
| **R1306** | 部署传输：**只 `scp` 基文件 `docker-compose.yml`** 到 `/srv/pokergame/`（⚠️ **不送 override** —— 开发面不该出现在服务器）；服务器的 `.env`（五项密钥）**手工写一次、部署永不覆盖**；⇒ 服务器上**不放仓库、不放部署密钥**。**镜像库凭据**：**优先用内置 `${{ github.token }}`（`permissions: packages: read`）** —— 镜像由同仓的工作流推送 ⇒ 同一个 token 可拉 ⇒ **长期密钥数 = 0**；`GHCR_PULL_TOKEN` 降为**备选**（细粒度 · 只读包 · 单用途 · 轮换写进手册）。⚠️ **登出是三层**（独立复核）：① `deploy.sh` 在同一 ssh 会话内 `trap 'docker logout ghcr.io' EXIT` ② 工作流 `if: always()` 兜外层 ③ **已知边界**：job 超时/runner 失联时没有步骤会跑 ⇒ 由**部署后的 `if: always()` 收尾步骤 ssh 回去断言** `~/.docker/config.json` 无 ghcr 条目（把 C4 从人工判据升级成机械闸） | 用户裁决 2/7 · 实审 + 独立复核订正 |
| **R1307** | 部署 = `scripts/deploy/deploy.sh <tag>`（**工作流只调用它** ⇒ 本机也能一条命令演练，符合本仓「门禁要能本地跑」）。含：`pull` → `up -d` → **冒烟**（`curl` **不带 `-k`** 打 `/api/health`、`/`、`/socket.io/?EIO=4&transport=polling` 握手）⇒ 任一失败 ⇒ **非零退出 + 打印回滚命令**；**幂等**：对同一 tag 重跑 ⇒ 输出里**不得出现 `Recreated`**。⚠️ **收尾的磁盘卫生只能用 `docker image prune -f`（只删悬空）** —— `-af` 会删掉上一个 tag 的镜像、把"秒级回滚"变成一次网络拉取（独立复核）；⑦7.3 既有的磁盘读数与"盘满会拖死 MySQL"那条**迁移**到手册新的「部署」一节（**不是删除**） | 用户裁决 3/6 · 独立复核订正 |
| **R1308** | 回滚 = `scripts/deploy/rollback.sh <旧 tag>` + `workflow_dispatch`（带 `image_tag` 输入）；手册新增「回滚」一节（含"上一个 tag 怎么找"）。⚠️ 独立复核：**dispatch 路径必须只 pull 已存在的 tag（秒级）** —— `images` job 的 `if` + `deploy` 的 `needs` 都要为此让路；且手册写明「**tag 只打在 master 上**」（否则 tag 可能指向未过真栈 conformance 的提交） | 用户裁决 3 · 独立复核订正 |
| **R1309** | **conformance 进 CI**：① **渲染类判据**在**每次 push** 都跑（落点是 `ci.yml` 的第二 job `render-gate`；**实测 2.8s、无需 daemon、不需要镜像**）② **真栈 15 个切片 + 1 个配置结构切片（`slice-07.4-pipeline`）＝ 16** 在 master/tag 跑（master 自己构建、`release.yml` 里复用拉取）⇒ **这就是「Linux 侧验证」的自动化答案**（用户 2026-09-18 裁决的"后移到实际部署时统一跑"由此**落地且长期生效**） | 用户裁决 5 · 片① R2 |
| **R1310** | **服务器预备**（手工一次，手册给逐条命令 + 预期输出）：① 部署公钥进 `~/.ssh/authorized_keys` ② `sudo usermod -aG docker ubuntu` + 重登（⚠️ 若 `docker ps` 已免 sudo 则此步为 no-op）③ 建 `/srv/pokergame/` 并写 `.env` ④ DNS A 记录 ⑤ **云厂商安全组**（放行 80/443/22）**与机器内 `ufw` 两层都要开** | 用户裁决 2 · 实审 |
| **R1311** | 手册更新：**⑦ 改为"部署由流水线完成"**（删掉手工传代码那条路，片① 预告过）· 新增「服务器预备」与「回滚」· 凭据轮换步骤（部署私钥 / GHCR 令牌——若启用）。⚠️ 独立复核补：还要**全文扫 ①–⑧ 的三类过期措辞**（"命令都在服务器的**仓库根**"、".env 在**仓库根**"、"**4GB 机器**首次 10–20 分钟"）—— 新形态下服务器**不再有仓库、不再构建**，且实测内存 **7.5GiB**；⑦7.2/7.3 的构建与磁盘条目**迁移**到新「部署」一节 | 片① R1212 的约定 · 独立复核 |
| **R1312** | 文档同步（复核沿用**逐行**，不做全仓 0 命中）：`docs/design.md` §13.4 —— ⚠️ **不动六阶段表**（它是 `ci.sh` 的真源；照原稿"补进表里"会造第二真源）而是在其**下新增一小节「另有三个工作流」**；§13.4 的**理由句**（`docs/design.md:1477` 的「本仓没有可验证的远端 CI」）订正为「Actions 的**运行**不可本地验证 ⇒ 六阶段仍以脚本为真源」；§2.2（部署拓扑：镜像库 + `/srv/pokergame`）· **§14.4**（P3 的 DoD 表加一行：部署 = 打 tag · 回滚 = `rollback.sh` · 手工路径已废止）· §15 · `README.md` | 片① 成例 · 独立复核订正 |
| **R1313** | **判据只增不减**；**零客户端改动**；`scripts/browser-e2e.mjs` blob 钉死（沿用片①）；改任何服务源码 ⇒ 重建镜像再跑真栈判据 | 全局约束 |
| **R1314** | **成本控制**（与具体额度数字无关）：① buildx + GHA 缓存 ② 触发分级（R1304）③ **明确降级路径**：额度吃紧 ⇒ 把真栈 conformance 降为只在 tag/PR 跑（一行改动）④ job 开头 `docker image prune -af`（**7 镜像 ≈4.9GB、连基础镜像 ≈6GB** ⇒ runner 磁盘风险低，但仍兜底）。⚠️ **服务器侧只允许 `docker image prune -f`（只删悬空），绝不用 `-af`** —— 那会删掉上一个 tag 的镜像，把"秒级回滚"变成一次网络拉取 ⑤ tag 路径的构建次数 = **2 次**（`images` + `conformance` 复用拉取；不再有第三次全量构建 —— 独立复核的"最多 3 次"由 `needs` + 复用消掉） | 用户裁决 5 · 实审 + 独立复核订正 |

---

## 2. 仓库形态与首次推送（R1302）

- 建仓：`gh repo create Howebai/fight-the-landlord --private --source=. --remote=origin`（⚠️ 具体旗标在执行时核 —— 本机无 `gh`，未验证）。
- 推送前：`git rm --cached .env.local.bak`（并删文件）+ `.gitignore` 补 `*.bak`；扫描受控文件（`\.env|secret|credential|\.pem$|\.key$|id_rsa`）确认只剩**无害的**（`apps/client/.env.development|.mock|.test` = localhost；`douzero/.env.example` = 示例）。
- 首次推送 `master`；此后每个 tag = `git tag v1.0.0 && git push --tags`。
- 密钥库（`gh secret set`）：`SSH_HOST` / `SSH_USER=ubuntu` / `SSH_KEY`（**新生成的专用部署私钥**）/ **`SITE_URL`**（如 `https://game.example.com` —— ⚠️ 本设计期自审补：**没有它，部署的冒烟三条链就没有目标**）。⚠️ 独立复核订正：**`SITE_URL` 不是秘密，应放 `gh variable set`（`${{ vars.SITE_URL }}`）** —— 放进 secret 会被掩码成 `https://***/api/health`，恰好废掉冒烟失败时的第一手诊断信息。`GHCR_PULL_TOKEN` **降为备选**（首选内置 `${{ github.token }}`，见 R1306）。
- ⚠️ **域名不写死在 spec 里**：`<域名>`（= 门口 `SITE_ADDRESS` 的真值）由用户在执行期提供；DNS 的 A 记录也在那一刻由用户配置（R1310 ⑤）。

---

## 3. 四个工作流（R1304 / R1305 / R1309）

| 工作流 | 触发 | 内容 | 失败语义 |
|---|---|---|---|
| `ci.yml`（**不动**） | push / PR | 六阶段 | job 红 |
| **`images.yml`**（新） | push→**master** | 调 `scripts/deploy/build-images.sh`（buildx `type=gha` 缓存）构建 **7 个镜像** → 推 **`ghcr.io/howebai/fight-the-landlord-<svc>:{sha-<短>, latest}`**（内置 `GITHUB_TOKEN`，`permissions: packages: write`）。⚠️ **每个 svc = GHCR 上独立的私有包**，包名 == `fight-the-landlord-<svc>`；**全片只允许这一种写法**（连字符，不是路径分隔的斜杠）—— 它是 R1303 的 `IMAGE_PREFIX` 直接拼出来的名字，A11 的第二次渲染期望由它派生（实测：`IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord` + `IMAGE_TAG=v9` ⇒ `ghcr.io/howebai/fight-the-landlord-user-service:v9`） | job 红（顺带在 Linux 上每 push 复验"镜像内构建 H5"） |
| **`conformance.yml`**（新） | push→**master**（**feature 分支不跑**）· **tag 不触发**（`tags-ignore: ['**']` —— tag 路径由 `release.yml` 经 `workflow_call` 复用本工作流；若 tag 也直接触发，一次 tag 会跑两遍 conformance、违反 R1314⑤）· **可被 `release.yml` 复用**（`workflow_call`） | ① **真栈**：调 `scripts/deploy/conformance-stack.sh up` 起本栈再跑**全部 17 个切片**（**＝ 16 真栈 + 1 配置结构；第 17 片 = `slice-07.4-pipeline`（流水线清点），它不需要栈**。⚠️ 2026-09-26 订正：片③-B 新增 `slice-07.5-backup`（备份与恢复路径，**需要真栈**）⇒ 由 16 变 17；master 上**自己构建**7 镜像；在 `release.yml` 里被复用时**从 GHCR 拉刚推好的 tag 镜像**，省一次全量构建）→ 跑完 `… down` | 任一红 ⇒ job 红 |
| **`release.yml`**（新） | **tag `v*`** · `workflow_dispatch`（`image_tag` 输入，供回滚） | **三个 job**：`images`（`if: github.event_name == 'push'` ⇒ **dispatch 回滚时不重建**；推 `:{sha, <tag>}`）→ `conformance`（复用上面的 `workflow_call`，`needs: images`）→ `deploy`（`needs: [images, conformance]`；dispatch 路径 `if` 掉 conformance ⇒ 回滚仍秒级） | ⚠️ **必须 `needs` 串行** |

> 🔴 **为什么 `deploy` 不能是独立工作流**（设计期自审 + 独立复核共同认定）：`images.yml` 与 `deploy.yml` 若都挂 `push: tags`，**两个工作流会被同时触发、并行跑** ⇒ 部署可能在镜像推上去**之前**开始 ⇒ 拉不到 tag 镜像而失败（一次竞态型假红）。⇒ 收进同一个工作流用 `needs` 串行；构建抽成 `scripts/deploy/build-images.sh`（两个工作流共用 ⇒ 不产生第二份构建真源，且本机可单独演练）。
> ⚠️ **`workflow_dispatch` 的 `images` job 必须 `if` 掉**（否则：在默认分支 dispatch 并给 `image_tag=v1.0.0`，它会用 **master HEAD** 构建并**覆盖推成 `:v1.0.0`** ⇒ 静默部署错版本——GHCR 的 tag 默认可覆盖）。
> ⚠️ **`ci.yml` 另加一个 job `render-gate`**（R1309① 的落点）：只跑**纯渲染**判据（**2.8s、无需 daemon、不需要镜像**）⇒ feature 分支与 PR 也有 A 类闸，且"每次 push 都跑"逐字成立。

---

## 4. 部署脚本与服务器形态（R1306 / R1307 / R1308）

- `scripts/deploy/deploy.sh <tag>`：`scp docker-compose.yml ubuntu@$SSH_HOST:/srv/pokergame/` → `ssh` 到服务器：`cd /srv/pokergame && docker login ghcr.io -u <user> --password-stdin <<< "$TOKEN"` → `IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<tag> docker compose -f docker-compose.yml pull` → `… up -d` → 冒烟三条 → `docker logout ghcr.io`（**无论成败**）。
- `scripts/deploy/rollback.sh <旧 tag>`：同一条路径换 tag 再跑一次（代码不动）。
- **凭据来源（两个环境同一套变量名）**：本地演练时从 **`.env.deploy.local`**（仓库根）读 —— ⚠️ 它已被既有规则 `.gitignore:21` 的 `.env.*.local` **覆盖**（实测 `git check-ignore -v .env.deploy.local` 命中 ✓），**不需要新规则**；CI 里从密钥库经环境变量注入 ⇒ 脚本不区分环境、也不需要改。
- **幂等判据**：同 tag 重跑 ⇒ `up -d` 输出**不得出现 `Recreated`**。
- 服务器形态：`/srv/pokergame/` 下只有 `docker-compose.yml` + `.env`（手工）+ Caddy 的卷（`caddy-data`）。
- **短 sha 的定义**（避免两侧对不上）：`GITHUB_SHA` 的**前 7 位**；本机演练用 `git rev-parse HEAD` 再截 7 位 ✓。

---

## 5. 判据（只增不减；每条能机械判）

### A · 结构/渲染（进 `slice-07.2-deploy`，沿用片① 的两次渲染成例）

| # | 判据 | 判别力 |
|---|---|---|
| A11 | **命名方案参数化**：默认渲染 ⇒ 每个带 `build:` 的服务 `image` = `pokergame-<svc>:latest`；**第二次渲染**（`IMAGE_PREFIX=ghcr.io/x/y`、`IMAGE_TAG=v9`）⇒ 必须变成 `ghcr.io/x/y-<svc>:v9`。⚠️ 三条实现纪律（独立复核）：① 两变量走 `composeConfig(args, {IMAGE_PREFIX, IMAGE_TAG})`（成例 `slice-07.2-deploy.ts:508` 的 A1′）② **加入 `ISOLATED_KEYS`**（宿主 `export` 会让"默认渲染那半"漂移 —— R147/A8 同族，实测会漂）③ 附**注入自证**（宿主故意 export ⇒ 默认渲染仍必须 `pokergame-<svc>:latest`） | ⚠️ 只渲染一次**判不出** —— 写死 `image: pokergame-room-service:latest` 在默认值下**一模一样**；两次渲染才是判别力来源 |
| A12 | **服务面恰好**：带 `build:` 的服务**恰好 7 个**且就是 A11 的断言面；`redis`/`mysql` 的 `image` **逐字等于** `redis:7-alpine` / `mysql:8.0`（参数化不得波及） | 防"顺手给官方镜像也加前缀"、防"新增服务绕开镜像库" |

### B · 流水线与服务器预备（新增源码/配置闸；真栈部分在 CI）

| # | 判据 | 判别力 |
|---|---|---|
| B1 | **工作流清点**：`.github/workflows/` 恰好 `{ci.yml, images.yml, conformance.yml, release.yml}`（**不得**有 `deploy.yml`）；触发条件逐项**集合相等**（`on` / `on.push.branches` / `on.push.tags` / `on.workflow_dispatch`）；`release.yml` 的 `deploy` 必须 `needs: [images, conformance]`，`images` 必须带 `if: github.event_name == 'push'`。⚠️ **解析器钉树里现成的 `js-yaml@4.3.2`** —— **控制者实测**：它把 `on` 解析为**字符串键**、`on.push.branches` 与 `jobs.deploy.needs` 都可断言（`yaml@1.10.3` 同 ✓）；⚠️ 另半句**只是警告、未证**（本机无 v3）：YAML 1.1 语义的实现会把 `on` 读成布尔 `true` ⇒ 否定式断言恒绿、肯定式断言响亮假红 —— **不得**换成那类解析器。断言写成**集合相等** + **负对照**（合成的 `on: push` 喂同一谓词 ⇒ 必须红） | 防 feature 分支被接上、deploy 被改成 push 触发、竞态被改回来、以及解析器陷阱的失真 |
| B2 | **纯渲染判据在 CI 里跑**：进 `ci.yml` 的第二个 job `render-gate`（**每次 push**）⇒ 片① 的 A 类判据从此**每个分支都有自动闸**。⚠️ **两个可机械的前提**（独立复核实测）：① **`prod,dev` 段的唯一非 compose docker 调用是 A6a(ii) 的 `caddy validate`**（`slice-07.2-deploy.ts:568-598`）⇒ 纯渲染跑 = **减去 A6a(ii)**，实测 **≥49 项断言 / 2.8s / 无需 daemon**（`DOCKER_HOST=<死地址>` 下只有它红）② **A6a(ii) 拆成独立步骤 id（`caddy`）**，在真栈 job 里跑。③ **条数下限**写进 `baselines.json` 第二列（`slice-07.2-deploy: {render: 49, full: 134}`）——否则"跑到了但只跑 1 条"仍绿。⚠️ 还要让 conformance 具备**纯渲染运行形态**（`run.ts:86` 的 `assertGatewayHealthy()` 现在是无条件调用 ⇒ 纯渲染时须可跳过） | 片① R2 的关闭证据 |
| B3 | **真栈 15 切片在 CI 里跑**（连同不依赖栈的配置结构第 16 片 `slice-07.4-pipeline`，CI 上共 **17** 个切片（⚠️ 2026-09-26 由 16 订正：片③-B 新增 `slice-07.5-backup`）；job 绿 + **各切片条数 ≥ 基线**）。⚠️ 三个可机械前提：① CI 用**单一栈、串行、固定顺序**（顺序与 `run.ts` 的 `CASES` 同源）；② `tools/conformance/baselines.json` 的数值**在首次 CI 绿跑之后回填**（⚠️ 片① §10 的 15 个读数（片① 当时 15 片）是**本机累积栈**的产物，不能直接当 CI 基线；`slice-06` 用**最小值**口径 —— 它的条数 = 8 + 2×房间数）；③ 比较脚本**本机与 CI 共用**，CI 里作为独立一步 | **Linux 侧验证**的落地证据 + 条数机械闸 |
| B4 | **执行时核对**（本机核不到 ⇒ 不作事实声称）：① `docker compose version` ≥ v2 ② 云厂商 = 腾讯云？ ③ 私有仓库额度与 runner 规格以官方计费页为准 ④ **私有仓库的 Workflow permissions 默认可能是只读** ⇒ 首次推包 403（`gh api /repos/<owner>/<repo>/actions/permissions/workflow` 核，必要时 PUT 为 write） ⑤ **GHCR 从中国大陆型 VPS 的可达性**（部署前在服务器 `docker login ghcr.io` + 拉一个小镜像；不通则 C1/C3 全卡 ⇒ **备选写进手册**：`docker save` → `ssh docker load`）⚠️ **实施订正（2026-09-25 · 最终评审 M11）**：原文此处还写「脚本留开关」—— **不实**：`deploy.sh` 硬编码 `docker compose … pull`，该备选路径**未实现**；⑤ 的可达性已由**首次真部署实证**（服务器成功拉取 7 镜像 + 2 基础镜像 ≈6GB）⇒ 备选路径**不再需要** | 五项登记；⑤ 是"疑为腾讯云"的直接后果 |

### C · 部署/回滚（真栈，在服务器上）

| # | 判据 |
|---|---|
| C1 | 首次真部署后：`curl` **不带 `-k`** 打 `https://<域名>/api/health` ⇒ 200（**真证书** = 片① 唯一没验到的那半边）· `/` ⇒ 200 · `/socket.io/?EIO=4&transport=polling` ⇒ 握手体 |
| C2 | **回滚**：`workflow_dispatch` 用上一个 tag 重跑 ⇒ 冒烟必须过（并记录回滚耗时；⚠️ 前提：**tag 只打在 master 上**） |
| C3 | **幂等**：同 tag 再部署 ⇒ `up -d` 输出**不含 `Recreated`**（⚠️ 前提：两跑之间**不得**改 `.env`/compose —— 否则 `Recreated` 是正常的、会假红） |
| C4 | **服务器上无长期凭据**：部署后 `~/.docker/config.json` 里**没有** ghcr 条目（⚠️ 若实现改用临时 `DOCKER_CONFIG` 目录 ⇒ 还要断言 `$TMPDIR`/`/tmp` 无残留 —— 该断言由 `release.yml` 的 `if: always()` 收尾步骤执行 ⇒ **机械闸**，不是人工判据）；`/srv/pokergame/` 下**只有** `docker-compose.yml` 与 `.env` |

### D · 门禁

片① 的 D 全套仍须绿（`ci` 六阶段 · conformance 全量 · 探针 `gate`/`full` · 双 build · blob 钉死），外加本片新增的 A11/A12/B1–B3。

---

## 6. 明确不做（**不是遗漏**）

| 项 | 为什么 |
|---|---|
| 监控 / 告警 | 片③（用户裁决） |
| DB 备份与恢复演练 | 片③ |
| 多实例 / 蓝绿 / 零停机 | 单实例；部署的停机是**秒级**（`pull` + `up -d` 只重建变化的容器）⇒ 可接受；登记 |
| 独立 staging 环境 | 需要第二台机器 |
| 把 `redis`/`mysql` 钉到 digest | YAGNI（浮动 tag 的行为与今天"重建镜像时也会拉到最新 7.x/8.0"一致）；登记 |
| feature 分支的构建/部署 | R1304 的触发分级（省钱且避免半成品上线） |
| App 端运行期验证 | 仍被 HBuilderX 版本（N39）与 DCloud 凭据阻塞 |
| 镜像库的保留策略/清理 | YAGNI（GHCR 免费额度足够；且只推 tag/sha，不推分支快照） |

---

## 7. 设计期自审（**本会话对 1–5 节各做了一轮实审**）

| 轮 | 查出 | 处置 |
|---|---|---|
| 审 §1–2 | ⚠️ "本地镜像名逐字相同"**6/7 对、1/7 错**（门口是 `ftl-edge:latest` 例外） | 用户裁决**统一命名**（R1303）；改动面 = compose 1 行 + 判据 3 处 + 手册 1 句 |
| 审 §1–2 | ✅ 渲染判据**不需要 daemon**（`DOCKER_HOST=<死地址>` 实测仍渲染）· ✅ `.gitignore` 覆盖四个大目录但**无 `*.bak`** | 前者成为 R1309/R2 的依据；后者并入 R1302 |
| 审 §3–4 | ❌ **只需送 1 个文件**（原写"两个 compose"）—— 生产形态是单文件，override 是开发面，不该上服务器 | R1306 订正 |
| 审 §3–4 | ⚠️ `docker login` 的凭据会在失败路径上残留 ⇒ 登出必须 `if: always()` | R1306 订正 |
| 审 §5 | ⚠️ 新源码闸**只渲染一次判不出参数化**（写死在默认值下一样） | A11 改成**两次渲染** |
| 审 §5 | ⚠️ 镜像体积写"≈5–7GB"是估算，**实测 ≈3.5GB**（7 个明细见 §0.4） | R1314 与 §0.4 改用实测值 |
| 审 §5 | ❓ 私有仓库额度与 runner 磁盘**官方文档在本机取不到** ⇒ 不写数字 | B4 登记为"执行时核对"；R1314 的控制手段与数字无关 |
| 自审（写作期） | 本会话我自己还犯过一例：用 `/dev/null` 做 `--env-file` —— **本仓 `slice-07.2-deploy.ts:35` 早有此坑的注释**（Windows 上被解析成 `D:\dev\null`） | 逐字登记；后续所有临时 env-file 一律用真实临时文件 |
| **审 spec（落盘后，控制者过一遍）** | 🔴 **同一 tag 会并行触发两个工作流 ⇒ 部署可能先于镜像推送**（竞态型假红） | 收进 `release.yml`：`deploy` 用 **`needs: images`** 串行；构建抽成 `build-images.sh` 共用（§3 + B1） |
| 审 spec | 🔴 **冒烟没有目标**：密钥库清单里**没有域名/SITE_URL** ⇒ 部署的冒烟三条链无处可打 | §2 加 **`SITE_URL`** |
| 审 spec | ⚠️ "纯渲染运行形态"（跳过无条件调用的 `assertGatewayHealthy()`）**没被列为交付物** —— 而它是 B2 能否成立的前提 | 并入 B2 与 §9 的 B 段 |
| 审 spec | ⚠️ B3 的"条数不减"**当时不可机械判**（各切片没有基线，且 `slice-06` 是数据相关的） | 新增 `baselines.json`（**最小值**口径）+ 比较脚本（本机与 CI 共用） |
| 审 spec（独立复核，最强模型） | **7 处硬错**：① 镜像名两套写法（§3 斜杠 vs §4/A11 连字符 ⇒ 推上去拉不下来）② `workflow_dispatch` 回滚两条分支都坏（无 `if` 会用 master 覆盖推 `:v<旧tag>` ⇒ **静默部署错版本**）③ §9 仍写 `deploy.yml`（与 §3 的收编矛盾 ⇒ 幽灵工作流）④ R1309① 与 §3 的分级自相矛盾（"每次 push" vs "feature 不跑"）⑤ §0.4 的"3.5GB"算错（实测 **4.9GB**）⑥ B2 的"无需 daemon"在 `prod` 段不成立（A6a(ii) 要 daemon）⑦ ⑦7.3 的磁盘卫生随 ⑦ 被删 + `prune -af` 搬到服务器会毁掉秒级回滚 | 全部折进（R1303/R1306/R1307/R1308/R1309/R1312 · §3/§0.4/§5/§9） |
| 审 spec（独立复核） | **4 条未证声称**：登出只覆盖一半失败路径 · `GHCR_PULL_TOKEN` 可用内置 token 取代（长期密钥 = 0）· `SITE_URL` 该用 variable（secret 会把诊断信息掩码）· A11 缺 `ISOLATED_KEYS` 与注入自证 | 折进 R1306 三层登出 / §2 / A11 |
| 审 spec（独立复核） | **判断分歧 1–3**：B2 缺条数下限 · B3 的基线不能用本机读数（且 CI 必须单一栈串行）· deploy 未被真栈 conformance 门控（tag 与它并行） | B2 加下限 · B3 写"首次 CI 绿跑后回填" · `conformance` 改成可复用 + `needs: [images, conformance]`（dispatch 路径 `if` 掉 ⇒ 回滚仍秒级） |
| 审 spec（独立复核） | **遗漏 1–5**：起真栈的配方无交付物（会生第二真源）· 两条机器级默认值待核（Workflow permissions 只读风险 · **GHCR 在中国大陆型 VPS 的可达性** + save/load 备选）· 手册的三类过期措辞 · §13.4 的六阶段是 `ci.sh` 真源（"补进表里"会造第二真源）· `gh` 的安装/登录不在实施步骤里 | `conformance-stack.sh` · B4 ④⑤ · R1311 · R1312 · §9 A 段 |
| 审 spec（独立复核） | **歧义 1–5**：§13.4 的补法 · B1 的 YAML 解析器（`on` → `true` 陷阱，两向失真）· C3/C4 的前提与实现形态 · 短 sha 的定义 · R1303 的"本地零影响"对门口自相矛盾 | 全部折进 |
| 审 spec（独立复核） | 复核者**另有 13 项已核无错**（含：`.env.local.bak` 的 11 值全等于公开默认值 · 渲染不需要 daemon 复现 · 7 个 build 服务 · 命名爆炸半径恰 3 文件/3+1 处 · `assertGatewayHealthy` 确实无条件 · `.env.deploy.local` 被既有规则覆盖 · 仓库无私钥材料）—— 并订正我一处行号引用（`slice-07.2-deploy.ts` 的 `/dev/null` 注释在 **`:35`**，spec 原写 `:29`） | 行号已订正 |

---

## 8. 完成判据

| 项 | 判据 |
|---|---|
| 仓库 | 私有仓库存在、`master` 已推送、`.env.local.bak` 已移出且 `.gitignore` 有 `*.bak` |
| 命名 | A11/A12 绿（两次渲染） |
| 流水线 | B1/B2/B3 绿（三个工作流存在 + 触发分级正确 + 渲染判据与真栈 15 切片（+不依赖栈的配置结构第 16 片，共 16；⚠️ 2026-09-26 订正：现为共 **17**）在 CI 绿；各切片条数不减） |
| 部署 | C1/C3 在**真域名的真栈**上绿（含**真证书**） |
| 回滚 | C2 绿（记录耗时） |
| 凭据面 | C4 绿（服务器上无长期镜像库凭据、无仓库、无部署密钥） |
| 手册 | 「服务器预备」+「回滚」+ ⑦ 改写完成 + **凭据轮换（⑦7.4 —— 部署私钥；R1311 的 GHCR 令牌半边不适用，见该节）**，逐条命令带预期输出 |
| 文档同步 | §13.4/§2.2/§15/README 逐行复核通过 |
| 不受影响 | 片① 的 A1–A10/B/C 全绿 · `ci` 六阶段 · 探针 `gate`/`full` · blob 钉死 · 客户端零改动 |

---

## 9. 范围与顺序（**一片做完**，实施按 A → B → C）

| 顺序 | 内容 | 完成时能看到什么 |
|---|---|---|
| **A · 仓库与镜像命名** | **装 `gh` + `gh auth login`**（裁决 ④ 的前置；`gh --version` / `gh auth status` 的预期输出进实施报告）· R1302/R1303 · A11/A12 · B1（工作流骨架） | 代码在私有仓库上；命名方案有闸（⚠️ 本地 6/7 名字不变，**门口需重建一次**并 `docker rmi ftl-edge:latest`） |
| **B · 流水线** | **先渲染闸、后真栈**（渲染 2.8s / 无 daemon ⇒ 越早进 master 越早开始挡 A 类回归）· R1304/R1305/R1309/R1314 · `ci.yml` 的第二 job `render-gate` · `images.yml`/`conformance.yml`/`release.yml` · `scripts/deploy/{build-images,conformance-stack}.sh`（**起真栈的唯一一份配方** —— 含片① 的 B0 协议、注入值、收尾与残留检查）· `baselines.json` + 比较脚本 · B2/B3 | feature/PR ⇒ 渲染闸每次 push 都跑；push→master ⇒ 镜像进 GHCR + 真栈 15 切片（+不依赖栈的配置结构第 16 片，共 16；⚠️ 2026-09-26 订正：片③-B 交付后为 16 真栈 + 1 配置结构 = **17**）在 Ubuntu 上跑绿且条数 ≥ 基线（**Linux 验证落地**） |
| **C · 上云** | R1306–R1308/R1310–R1312 · `release.yml`（含 `deploy` job）+ `scripts/deploy/{build-images,conformance-stack,deploy,rollback}.sh` · 手册 · C1–C4 | **真域名上线**（真证书）· 回滚与幂等验过 · 服务器上无长期凭据 |

---

## 10. 完成状态（**实施后回填**）

| 项 | 结果 |
|---|---|
| 判据 A / B / C / D | **A ✅**（A11/A12 两次渲染；由 `render-gate` job 承担 —— 本会话观察到该 job 绿，未逐条打印条数）· **B ✅**（B1 工作流清点 · B2 纯渲染闸每次 push 跑 · B3 共 **16 个切片（15 真栈 + 1 配置结构 `slice-07.4-pipeline`）**在 CI 绿（⚠️ **此为片② 当时的记录，保留原样**；2026-09-26 片③-B 交付后为 **17**）且 `=== [baseline] full 全部 ≥ 下限（16 个切片）===`）· **B4 ✅** 五项登记（⑤ GHCR 可达性由**真部署实证**：服务器成功拉取 7 镜像+2 基础镜像 ≈6GB）· **C1 ✅ · C2 ✅ · C3 ✅ · C4 ✅**（见下一行）· **D ⏳**：本任务未跑本机全套（属控制者收口清单）；CI 侧等价物（`ci` 六阶段 + `conformance` 16 切片 + `render-gate`）在 `8794784` 与 `884f6e0` 上全绿 |
| 首次真部署 | **达成**（2026-09-25）：tag `v1.0.0` 的 tag-push 运行 `images ✅ / conformance ✅ / **deploy ❌**`（自家脚本 `deploy.sh` 缺陷：不加引号 heredoc 里**注释**的裸反引号被本地命令替换执行、输出按远端脚本行插入 ⇒ `set -e` 撞上 `pokergame-game-service:v1.0.0: command not found`（127））⇒ 修复 `884f6e0` 后用 `workflow_dispatch` 重跑 ⇒ **`✅ [deploy] tag=v1.0.0 部署完成`**（08:44:39Z · deploy job 59s；6GB 拉取发生在红那次）。**真证书**：Let's Encrypt（`issuer=C = US, O = Let's Encrypt, CN = YE2`，`subject=CN = <DEV_HOST>`，`notAfter=Dec 24 2026`），签发在本部署现场（`certificate obtained successfully` · http-01 挑战 5 源 IP 全 200）· 三条链**不带 `-k`** 全过（`/api/health` 200 · `/` 200 · socket.io 握手含 `sid`）· **幂等**：同 tag 重跑 9 容器全 `Running`、`Recreated`=0 · **回滚 v1.0.0**：只跑 `deploy` 一个 job（`images`/`conformance` skipped），**62s**（job 起 09:19:51Z → `✅ 部署完成` 09:20:53Z），回滚后 7 容器全 `:v1.0.0` healthy · **修复后的完整 tag 路径**由 `v1.0.1` 的全链绿背书。当前线上版本：**v1.0.0** —— 这是 **C2 回滚验收的预期终态**（回滚用例按设计把线上切回上一个 tag、跑完不回切；**不是**漂移或事故），v1.0.1 镜像仍在本机与 GHCR ⇒ 秒级可切回 |
| 文档同步 | 本片各处（`docs/design.md` §13.4/§2.2/§14.4/§15 · `README.md`）在 **C3** 完成（台账记 ✅ complete；本任务**未复核逐行内容** —— 未验）。本次新增：本 §10 回填 + `docs/ops/first-deploy.md` 的 ⑦ 前置在早前轮次已补 |
| 已知取舍与遗留 | ① `deploy.sh` 的缺陷**只在"真的部署"时才会现形**（此前所有验证都没走到主路径）—— 教训与片② 台账一致：*判据存在 ≠ 判据有效*；已补写作纪律注释，**建议后续加机械闸**（不加引号的 heredoc 体内禁未转义反引号/`$(`）。② 未验：手册 §5.3 的浏览器人工链路（注册/进房/锁）本任务未跑；D 门禁本机全套留给控制者收口。③ 服务器遗留：用户预备期的 `hello-world` 容器与镜像仍在（与本栈无关，未删）。④ 片③ 范围不变：监控/告警 · DB 备份恢复演练 · 多实例前的三件。⑤ **凭据轮换的覆盖缺口（全分支终审评审查出，本修复轮已补）** —— R1311 明确要求「凭据轮换步骤」，但此前手册全文无「轮换」字样、§8 完成判据也没登记它（缺口因此躲过收口）⇒ 已补为手册 **⑦7.4**（部署私钥；GHCR 令牌半边不适用 —— 用的是内建 `GITHUB_TOKEN`），§8 的手册行同步登记。⑥ **提交归属行遗留（不重写历史）** —— `884f6e0` 与 `a5341bf` 的 `Co-Authored-By` 写的是 `Claude Sonnet 4.6 <noreply@anthropic.com>`，与 `CLAUDE.md` 要求的 `Claude Opus 4.8 (1M) <noreply@anthropic.com>` 不一致；`884f6e0` 已推送且 tag `v1.0.1` 指向它 ⇒ 改写会作废该 tag ⇒ **保留、记为遗留**，从下一笔提交起按仓规写。⑦ **文档面订正（终审修复轮）** —— 手册 7.0② 的「首次 `conformance` 必红」与已回填（`8794784`）的真实运行不符 ⇒ 已改为「正常绿、增删切片时才红」；本文档的切片口径统一为 **16 = 15 真栈 + 1 配置结构**（§1/§3/§5/§8/§9/§10）；B4⑤ 与计划里「脚本留开关」的过度声称已订正（备选未实现、可达性由真部署实证）；台账与实施报告中的过期行**按追加订正的惯例标记**（不重写历史） |
