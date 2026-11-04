# Dockerfile 迁入 `deploy/docker/`（根目录结构整理）

**日期**：2026-11-04
**状态**：已实现并通过单测/静态验证；真实镜像构建待合 master 权威轮（images.yml）确认
**范围**：构建配置结构整理；不动任何服务代码、镜像内容、构建上下文与 CI 语义
**用户裁决**：在「集中到 deploy/docker/ · 按服务就近放置 · 单文件多 target」中选 **deploy/docker/ 集中**

## 1. 背景与问题

仓库根目录堆了 13 个 `Dockerfile.*`，与源码/配置文件混在一起，视觉噪音大。13 个文件全部以仓库根为构建上下文（`context: .`），`douzero/Dockerfile` 已是就地放置（上下文 `./douzero`）。

本次只做**结构整理**：文件位置变化，构建行为、镜像内容、`COPY` 路径、`.dockerignore`、镜像名、CI 全部不变。

## 2. 范围

**做**

- 13 个根 `Dockerfile.*` 移入 `deploy/docker/`，文件名不变。
- `docker-compose.yml` 13 处 `dockerfile:` 指向新路径，`context` 保持 `.`。
- 3 个 Dockerfile 机械闸测试改为从 `deploy/docker/` 枚举。
- 新增 1 个机械闸：compose 的每个 `build.dockerfile` 必须真实存在，且 `deploy/docker/` 下每个 Dockerfile 都被 compose 引用。
- `scripts/verify-agent-static.mjs` 读取路径同步。
- 13 个 Dockerfile 首行路径注释同步。
- 新增 `deploy/docker/README.md`（防坑：构建上下文是仓库根）。
- 活文档/脚本注释里给出路径的地方同步；历史 plan 文档不改。

**不做**

- 不改任何 Dockerfile 的构建逻辑（FROM / COPY / RUN / CMD），不合并、不重命名。
- 不移动 `douzero/Dockerfile`，不移动 `.dockerignore`（必须留在上下文根）。
- 不动 `docker-compose.override.yml`（无 `dockerfile` / `build` 引用）。
- 不做单文件多 target 合并（另立片）。
- 不改历史 `docs/superpowers/plans/**` 与 `docs/superpowers/specs/**` 中的记录性引用。

## 3. 决策表

| # | 决策 | 选项 | 选定 | 理由 |
|---|---|---|---|---|
| D1 | 目录位置 | A: `deploy/docker/`；B: `docker/`；C: 各服务包内 | **A** | 用户选定；Dockerfile 属部署产物，与 `deploy/Caddyfile`、`deploy/monitoring/` 同域；不侵入 `packages/**` |
| D2 | 文件命名 | A: 保持 `Dockerfile.<svc>`；B: 改 `<svc>.Dockerfile` | **A** | trivy 按文件名识别（`Dockerfile.*`）；既有文档/闸/注释全部按此名引用，改名只增加风险 |
| D3 | 构建上下文 | A: 保持仓库根 `.`；B: 改到 `deploy/docker/` | **A** | 所有 `COPY` 源（`packages/...`、`pnpm-lock.yaml`）都以根为基准；改上下文需要重写全部 COPY 并重做构建缓存，收益为零 |
| D4 | 测试枚举 | A: 三个闸各自写路径；B: 集中到 `helpers/dockerfile-scan.ts` | **B** | 同一事实只留一处；三处重复路径是漂移源 |
| D5 | compose 路径闸 | A: 只靠人工检查；B: 新增机械闸（存在性 + 全集覆盖） | **B** | 本片唯一真实风险是路径漂移，而漂移只会在镜像构建（最贵的门）爆炸；单测层拦截成本极低 |
| D6 | douzero | A: 一并移入；B: 保持原位 | **B** | 其上下文是 `./douzero`，Dockerfile 与模型/依赖同目录，本就合理；移入会要求改上下文，违反 D3 |
| D7 | 历史文档 | A: 全部批量替换；B: 只改活文档/脚本 | **B** | plan/spec 是过程记录，改写历史会失真；`Dockerfile.edge` 等文件名仍唯一可识别 |

## 4. 现状与引用面

### 4.1 迁移清单（13 个）

| 现路径 | 新路径 | compose 服务 |
|---|---|---|
| `Dockerfile.user-service` | `deploy/docker/Dockerfile.user-service` | `user-service` |
| `Dockerfile.config-service` | `deploy/docker/Dockerfile.config-service` | `config-service` |
| `Dockerfile.currency-service` | `deploy/docker/Dockerfile.currency-service` | `currency-service` |
| `Dockerfile.payment-service` | `deploy/docker/Dockerfile.payment-service` | `payment-service` |
| `Dockerfile.room-service` | `deploy/docker/Dockerfile.room-service` | `room-service` |
| `Dockerfile.game-service` | `deploy/docker/Dockerfile.game-service` | `game-service` |
| `Dockerfile.robot-service` | `deploy/docker/Dockerfile.robot-service` | `robot-service` |
| `Dockerfile.api-gateway` | `deploy/docker/Dockerfile.api-gateway` | `api-gateway` |
| `Dockerfile.edge` | `deploy/docker/Dockerfile.edge` | `edge` |
| `Dockerfile.alert-relay` | `deploy/docker/Dockerfile.alert-relay` | `alert-relay` |
| `Dockerfile.prometheus` | `deploy/docker/Dockerfile.prometheus` | `prometheus` |
| `Dockerfile.grafana` | `deploy/docker/Dockerfile.grafana` | `grafana` |
| `Dockerfile.alertmanager` | `deploy/docker/Dockerfile.alertmanager` | `alertmanager` |

`douzero/Dockerfile` 与 `douzero/.dockerignore` 不动。

### 4.2 引用面盘点

| 引用方 | 形式 | 处置 |
|---|---|---|
| `docker-compose.yml` | 13 处 `dockerfile:`（11 处 block + 2 处 inline：`currency-service`、`payment-service`；另有 douzero 1 处 block 不在迁移清单） | 改路径 |
| `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts` | 根目录 glob + 已知 10 成员 | 改枚举源 |
| `packages/shared/test/dockerfile-patches-copy.gate.test.ts` | 根目录 glob | 改枚举源 |
| `packages/shared/test/dockerfile-workspace-copy.gate.test.ts` | 根目录 glob + 直读 `Dockerfile.user-service` | 改枚举源 + 直读路径 |
| `packages/shared/test/douzero-dockerfile.gate.test.ts` | 读 `douzero/Dockerfile` | 不动 |
| `packages/shared/test/helpers/dockerfile-scan.ts` | 共享纯函数 | 新增目录常量 / 枚举 / compose 解析纯函数 |
| `scripts/verify-agent-static.mjs` | `read('Dockerfile.edge')` | 改路径 |
| `scripts/deploy/build-images.sh` | 注释提到 `Dockerfile.edge` | 同步注释 |
| `.github/workflows/*` | 只调 `build-images.sh`；无直接路径 | 不动 |
| trivy（`ci.yml`） | 递归扫全仓，按文件名识别 | 不动（命名保持 `Dockerfile.*`） |
| `scripts/deploy/preview.sh` | `deploy/docker/*` 落入「需重建镜像」分类 | 不动（行为正确） |
| `deploy/monitoring/**` 注释、`deploy/download/README.md`、`packages/config-service/src/admin/admin-password.ts`、`packages/alert-relay/src/am-renderer.ts`、`docker-compose.yml:946`、`docs/2026-08-31-game-platform-architecture-design.md`、`tools/conformance/src/slices/slice-07.3-edge.ts`、`.github/workflows/conformance.yml` | 裸文件名/文案 | 不改（文件名仍唯一可识别） |
| `douzero/docker-compose.douzero.yml` | 第二个 compose，含 `build.dockerfile` | 不改；新 compose 闸只针对根 compose |
| `docs/design.md`、`docs/ops/first-deploy.md` | 裸文件名引用 | 不动（文件名仍唯一） |
| 历史 `docs/superpowers/plans/**` | 裸文件名/旧命令 | 不动 |

## 5. 实现设计

### 5.1 目录与命名

```text
deploy/
├─ Caddyfile
├─ download/
├─ monitoring/
├─ docker/
│  ├─ README.md
│  ├─ Dockerfile.user-service
│  ├─ Dockerfile.config-service
│  ├─ Dockerfile.currency-service
│  ├─ Dockerfile.payment-service
│  ├─ Dockerfile.room-service
│  ├─ Dockerfile.game-service
│  ├─ Dockerfile.robot-service
│  ├─ Dockerfile.api-gateway
│  ├─ Dockerfile.edge
│  ├─ Dockerfile.alert-relay
│  ├─ Dockerfile.prometheus
│  ├─ Dockerfile.grafana
│  └─ Dockerfile.alertmanager
└─ ...
```

用 `git mv` 保留 history。

### 5.2 compose

13 处改为 `deploy/docker/Dockerfile.<svc>`，其中：

```yaml
user-service:
  build:
    context: .
    dockerfile: deploy/docker/Dockerfile.user-service
```

```yaml
currency-service:
  build: { context: ., dockerfile: deploy/docker/Dockerfile.currency-service }
payment-service:
  build: { context: ., dockerfile: deploy/docker/Dockerfile.payment-service }
```

（两处 inline 写法都必须被 `composeBuildRefs` 解析；自证样本逐条点名。）

`douzero` 保持 `context: ./douzero` + `dockerfile: Dockerfile`。

### 5.3 测试侧集中化

在 `packages/shared/test/helpers/dockerfile-scan.ts` 新增：

```ts
/** 根目录 Dockerfile 的集中位置（相对仓库根）。 */
export const DOCKERFILE_DIR = 'deploy/docker';

/** 列出 `DOCKERFILE_DIR` 下的 Dockerfile 文件名（排好序；排除 README 等非 Dockerfile）。 */
export function listDockerfiles(repo: string): string[];

/** compose 中一个 build 引用（dockerfile 已按 compose 语义相对 context 解析后返回）。 */
export interface ComposeBuildRef {
  service: string;
  context: string;    // 相对 compose 文件目录（本仓 compose 在根 ⇒ 即仓库根）
  dockerfile: string; // 相对 context
}

/** 纯函数：从 compose YAML 文本提取所有 `build:` 引用（支持 block 与 inline 两种写法）。 */
export function composeBuildRefs(src: string): ComposeBuildRef[];

/**
 * 纯函数：拿 refs + deploy/docker 文件名清单 + 可注入的 isFile，返回违规列表。
 * 判据：① context='.' 的引用必须落在 deploy/docker/ 下；② 每个引用必须是真实文件；
 *      ③ deploy/docker/ 下每个 Dockerfile 都必须被引用（防孤儿）。
 */
export function composePathViolations(
  refs: ComposeBuildRef[],
  dockerfileNames: string[],
  isFile: (repoRelPath: string) => boolean,
): string[];
```

`composeBuildRefs` 不是完整 YAML 解析器，只覆盖本仓 compose 的两种写法；边界由判别力自证钉住：

- 顶层服务键 = 2 空格缩进的 `name:`
- `build:` 块内取 `context:` / `dockerfile:`；缺省 `context=.`、`dockerfile=Dockerfile`
- inline `build: { context: ., dockerfile: X }` 用字段正则提取
- 注释判定**内联** `line.trimStart().startsWith('#')`；**不**新增 `strip*Comments` 函数——`comment-stripping-single-source.gate.test.ts` 的 N46 命名族闸会把它判成私有副本（`stripDocker*` 是唯一豁免）

三个既有闸改为：

```ts
const dockerfiles = listDockerfiles(REPO);
...
readFileSync(join(REPO, DOCKERFILE_DIR, name), 'utf-8')
```

哨兵断言**原样保留**（已知成员、参与集合恰好 10 个），只改读取位置——路径写错时集合为空或成员缺失，闸必红而不是恒绿。同步更新 `dockerfile-scan.ts` 头注释（「两个机械闸共用」→「三个机械闸 + compose 路径闸共用」）。

### 5.4 新增 compose 路径闸

新增 `packages/shared/test/dockerfile-compose-refs.gate.test.ts`，**只针对根 `docker-compose.yml`**（`douzero/docker-compose.douzero.yml` 是第二个含 `build.dockerfile` 的 compose，不在本闸范围）：

1. **解析**：`composeBuildRefs(docker-compose.yml)` 得到全部引用。
2. **存在性 + 约定 + 覆盖性**：`composePathViolations(refs, listDockerfiles(REPO), isFile)` 必须返回 `[]`：
   - `context === '.'` 的引用路径归一后必须落在 `deploy/docker/` 下；
   - 每个引用解析后必须是**真实文件**（`statSync(...).isFile()`，不接受目录）；
   - `deploy/docker/` 下每个 Dockerfile 都必须被引用（防孤儿）。
3. **根目录无 Dockerfile**：`readdirSync(REPO).filter(n => n.startsWith('Dockerfile'))` 必须为空（把「新镜像放回根目录」从 review 纪律升级成机械闸）。
4. **哨兵**：引用总数恰好 14（13 个自建 + douzero）、`deploy/docker/` 下 Dockerfile 恰好 13 个、含 `edge` / `api-gateway` / `douzero`。
5. **判别力自证**（对纯函数喂假样本，逐条必红）：
   - ① ref 指向不存在文件 → 红；
   - ② `deploy/docker/` 存在孤儿文件 → 红；
   - ③ refs 为空 → 红（不能 vacuous 通过）；
   - ④ `context: .` 的 ref 指向 `deploy/docker/` 之外 → 红；
   - ⑤ 两条 inline（currency + payment）各自被解析；
   - ⑥ block / 默认 context / 注释里的假 `dockerfile:` 不误判；
   - ⑦ 目录含 `README.md` 时文件数仍为 13（`listDockerfiles` 只认 `Dockerfile.*`）。

**路径归一**：比较前统一转 POSIX 风格（`split(sep).join('/')` 并去掉 `./`），避免 Windows 开发机把 `deploy/docker\x` 与 `deploy/docker/x` 判成不等。

### 5.5 脚本与注释

- `verify-agent-static.mjs`：`read('Dockerfile.edge')` → `read('deploy/docker/Dockerfile.edge')`；提示文案同步。
- 13 个 Dockerfile 首行：`# platform/Dockerfile.x` → `# platform/deploy/docker/Dockerfile.x`。
- `build-images.sh` 注释里的 `Dockerfile.edge` → `deploy/docker/Dockerfile.edge`。
- `deploy/monitoring/**` 注释中的裸文件名：本轮不动（仍唯一可识别），避免无意义 churn。

### 5.6 `deploy/docker/README.md`

内容固定三条：

1. **构建上下文是仓库根**（compose `context: .`）：`COPY packages/...` 等路径以根为基准，不要写成相对本目录。
2. 新增镜像 = 本目录建 `Dockerfile.<svc>` + `docker-compose.yml` 加 `dockerfile:` + 同步机械闸哨兵。
3. `.dockerignore` 必须在仓库根，不能搬进来。

## 6. 测试判据

| 判据 | 命令 | 预期 |
|---|---|---|
| 三个既有闸（新路径） | `pnpm -C packages/shared test -- dockerfile-` | 全绿；哨兵成员与原集合一致 |
| 新 compose 路径闸 | 同上 | 14 个引用全部存在；13 个文件全部被引用；根目录零 Dockerfile |
| 判别力自证 | 同上 | 每个闸的假样本必红 |
| edge 静态接线 | `pnpm verify:agent` | 全绿 |
| 类型检查 | `pnpm -C packages/shared lint` | 全绿（`tsconfig.test.json` 覆盖 `test/**/*`） |
| 回归 | `pnpm -C packages/shared test` | 全绿 |
| YAML 语法 | `docker compose -f docker-compose.yml config --quiet`（Docker 可用时） | exit 0；**只证明 YAML 可渲染，不证明 Dockerfile 存在** |
| 真实构建（必须走 compose） | 仓库根执行 `docker compose -f docker-compose.yml build api-gateway`，或 `docker buildx bake -f docker-compose.yml --print` 核对 14 个 target 后构建其一 | 构建成功；这是唯一能证明 compose→dockerfile 路径解析正确的本机判据 |
| CI 兜底 | 合 master 后 `images.yml`（同一 `build-images.sh` / bake 配方） | 14 镜像全部构建成功 |

> ⚠️ 本机当前**无 Docker CLI**（`docker: command not found`），`compose build` / bake 无法本地执行 ⇒ 计划阶段以「新 compose 路径闸 + 静态路径归一」为主判据，真实构建由合 master 的权威轮兜底；若用户机器后续有 Docker，再补一次 `compose build api-gateway`。

## 7. 错误处理与边界

- **compose 路径解析**：`dockerfile` 相对 `context`，`context` 相对 compose 文件目录。新路径按此语义解析；`docker compose config` **只**做 YAML 语法检查（不 stat Dockerfile），存在性由单测闸 + `compose build` / CI 保证。
- **`.dockerignore`**：BuildKit 始终取上下文根的 `.dockerignore`，Dockerfile 位置不影响；不移动。
- **缓存**：仅 13 个 Dockerfile 的**首行注释**变化（解析期丢弃，不进入指令/LLB 摘要）；文件路径不参与缓存键 ⇒ 预期命中缓存，以 `compose build` 实测确认。
- **trivy**：按文件名 `Dockerfile` / `Dockerfile.*` / `*.Dockerfile` 递归识别，子目录不影响；命名保持不变。
- **闸失效**：`listDockerfiles` 路径写错 → 返回空 → 各闸哨兵红（非恒绿）；`composePathViolations` 对空 refs 必须显式判红（自证 ③）。
- **compose 解析器边界**：只覆盖本仓现有写法；新增写法（锚点、多行 flow、`extends`）会解析不到，由「引用总数恰好 14」哨兵暴露，需显式更新解析器与哨兵。
- **preview.sh**：`deploy/docker/Dockerfile.*` 改动归入「需重建镜像」；`deploy/docker/README.md` 命中 `*.md` 归 NOOP。与迁移前根目录行为一致。

## 8. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 漏改某处路径，镜像构建期才红 | 中 | 新 compose 路径闸在单测层拦截（存在性 + 约定 + 覆盖性）；`docker compose config` 只作 YAML 语法检查；真实构建由 `compose build` / 合 master 权威轮兜底 |
| 测试枚举路径写错导致恒绿 | 低 | 所有闸保留已知成员哨兵；`listDockerfiles` 集中在 helper |
| 未来新增镜像仍放回根目录 | 低 | `deploy/docker/README.md` 约定 + **机械闸**：根目录出现 `Dockerfile*` 即红；`context: .` 的引用必须落在 `deploy/docker/` 下 |
| 构建缓存失效导致 CI 变慢 | 低 | 仅首行注释变化、路径不参与缓存键；`compose build` 实测确认命中 |

## 9. 涉及文件

**移动（13）**：根 `Dockerfile.*` → `deploy/docker/Dockerfile.*`

**修改**

- `docker-compose.yml`
- `packages/shared/test/helpers/dockerfile-scan.ts`
- `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`
- `packages/shared/test/dockerfile-patches-copy.gate.test.ts`
- `packages/shared/test/dockerfile-workspace-copy.gate.test.ts`
- `scripts/verify-agent-static.mjs`
- `scripts/deploy/build-images.sh`（仅注释）
- 13 个 Dockerfile 首行注释

**新增**

- `packages/shared/test/dockerfile-compose-refs.gate.test.ts`
- `deploy/docker/README.md`
- 本 spec

## 10. 对抗审查记录

**审查方式**：独立 reviewer 子代理（只读），2026-11-04。**阻断：0；高：4；低：8。**

| # | 等级 | 问题 | 处置 |
|---|---|---|---|
| H1 | 高 | §4.2 写法盘点错误：inline 实为 2 处（currency + payment），待迁移 13 = 11 block + 2 inline | 已修正 §4.2 / §5.2，自证逐条点名两处 inline |
| H2 | 高 | `docker compose config` 不 stat Dockerfile；`docker build -f` 绕过 compose ⇒ 原「双证」不覆盖唯一风险 | 已改：真实构建必须走 `compose build` / bake；config 仅作 YAML 语法检查；新增 CI 权威轮兜底 |
| H3 | 高 | 新闸自证只覆盖解析器，未证存在性/覆盖性；实现写歪可全绿 | 已改：抽 `composePathViolations` 纯函数；自证覆盖不存在文件、孤儿、空 refs、越界路径、README 边界 |
| H4 | 高 | 枚举收窄后根目录 Dockerfile 失去机械覆盖，仅靠 review 纪律 | 已改：新增机械闸——根目录 `Dockerfile*` 必须为空 + `context: .` 引用必须落在 `deploy/docker/` |
| L1 | 低 | README 使「目录每个文件」与「恰好 13」自相矛盾 | 已改：所有断言基于 `listDockerfiles`（只认 `Dockerfile.*`），自证加 README 样本 |
| L2 | 低 | `existsSync` 会接受目录 | 已改：`statSync(...).isFile()` |
| L3 | 低 | Windows 路径分隔符导致覆盖性比较假红 | 已改：比较前统一归一为 POSIX 风格 |
| L4 | 低 | 「Dockerfile 内容不变」与首行注释修改矛盾 | 已改：仅注释变化、不进入 LLB 摘要；以实构建确认 |
| L5 | 低 | 引用面盘点未穷尽「仅文案」站点；未限定根 compose | 已补全清单；新闸明确只针对根 `docker-compose.yml` |
| L6 | 低 | preview.sh 分类描述不精确 | 已改：Dockerfile → 重建；README → NOOP |
| L7 | 低 | 若实现 `strip*Comments` 函数会撞 N46 命名族闸 | 已改：注释判定内联，不新增剥离函数 |
| L8 | 低 | 缺 lint/类型检查；helper 头注释过时；`context` 注释失准；构建命令未注明 CWD | 已补 `pnpm -C packages/shared lint`；头注释同步；`context` 改为「相对 compose 文件目录」；命令注明仓库根执行 |

**结论**：设计方向与不变量成立，所有高优先级项已修订入 spec，进入计划阶段。
