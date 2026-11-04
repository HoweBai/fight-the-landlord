# Dockerfile 迁入 `deploy/docker/` 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把仓库根目录 13 个 `Dockerfile.*` 迁入 `deploy/docker/`，并让所有引用（compose、测试、脚本、注释）同步，构建行为零变化。

**Architecture:** 保持所有 compose `context: .` 不变，只改 `dockerfile:` 路径；机械闸的枚举源从仓库根改为 `deploy/docker/`；新增一个 compose→Dockerfile 路径对账闸，把「引用存在、无孤儿、根目录零 Dockerfile」钉在单测层。

**Tech Stack:** Docker Compose / BuildKit bake、Vitest、TypeScript、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-11-04-dockerfile-relocation-design.md`

## Global Constraints

- **构建上下文永远保持仓库根 `.`**：不得修改任何 `COPY` 行、`.dockerignore` 位置或 `context:` 值。
- **文件名保持 `Dockerfile.<service>`**：不重命名、不合并、不改任何 FROM/COPY/RUN/CMD。
- **不改 `douzero/Dockerfile` 与 `douzero/docker-compose.douzero.yml`。**
- **不改历史 plan/spec 文档**（`docs/superpowers/plans/**`、`docs/superpowers/specs/**` 中的既有记录）。
- **路径比较统一归一为 POSIX 风格**（`split(sep).join('/')`），Windows 开发机与 Linux CI 同判。
- **不得新增 `strip*Comments` 函数**（N46 命名族闸只豁免 `stripDocker*`）；YAML 注释判定内联。
- **机械闸的已知成员哨兵必须保留**，路径写错时要红，不能空集恒绿。
- 每个 commit 消息结尾逐字使用：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 本机无 Docker CLI：不执行 `docker compose build`；真实构建由合 master 的 `images.yml` 权威轮兜底。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/shared/test/helpers/dockerfile-scan.ts` | 现有 Dockerfile 扫描纯函数；新增目录常量、枚举、compose 解析、路径对账纯函数 |
| `packages/shared/test/helpers/dockerfile-scan.test.ts` | 新增：上述纯函数的判别力自证 |
| `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts` | 改为从 `deploy/docker/` 枚举 |
| `packages/shared/test/dockerfile-patches-copy.gate.test.ts` | 改为从 `deploy/docker/` 枚举 |
| `packages/shared/test/dockerfile-workspace-copy.gate.test.ts` | 改为从 `deploy/docker/` 枚举 + 直读路径 |
| `packages/shared/test/dockerfile-compose-refs.gate.test.ts` | 新增：compose 引用存在性 + 目录约定 + 孤儿 + 根目录零 Dockerfile |
| `deploy/docker/Dockerfile.*`（13 个） | 迁移后的 Dockerfile |
| `deploy/docker/README.md` | 新增：上下文/新增镜像/`.dockerignore` 三条约定 |
| `docker-compose.yml` | 13 处 `dockerfile:` 改路径 |
| `scripts/verify-agent-static.mjs` | 读取 `deploy/docker/Dockerfile.edge` |
| `scripts/deploy/build-images.sh` | 仅注释路径同步 |

---

### Task 1: 扫描 helper 增加目录常量、枚举与 compose 路径纯函数

**Files:**
- Modify: `packages/shared/test/helpers/dockerfile-scan.ts`
- Test: `packages/shared/test/helpers/dockerfile-scan.test.ts`（新建）

**Interfaces:**
- Consumes: 无（本任务不依赖其他任务）
- Produces:
  - `DOCKERFILE_DIR: 'deploy/docker'`
  - `listDockerfiles(repo: string): string[]`
  - `interface ComposeBuildRef { service: string; context: string; dockerfile: string }`
  - `composeBuildRefs(src: string): ComposeBuildRef[]`
  - `composePathViolations(refs, dockerfileNames, isFile): string[]`

- [ ] **Step 1: 写失败测试（新建 `packages/shared/test/helpers/dockerfile-scan.test.ts`）**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  composeBuildRefs,
  composePathViolations,
  listDockerfiles,
} from './dockerfile-scan';

const made: string[] = [];

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-dockerfile-scan-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('listDockerfiles', () => {
  it('只列 deploy/docker 下的 Dockerfile.*（README 等不参与）', () => {
    const repo = mkRepo();
    const dir = join(repo, 'deploy', 'docker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Dockerfile.b'), 'FROM scratch\n');
    writeFileSync(join(dir, 'Dockerfile.a'), 'FROM scratch\n');
    writeFileSync(join(dir, 'README.md'), '# 说明\n');
    writeFileSync(join(dir, 'notes.txt'), 'x\n');
    expect(listDockerfiles(repo)).toEqual(['Dockerfile.a', 'Dockerfile.b']);
  });

  it('目录不存在时返回空数组（由消费端哨兵判红）', () => {
    expect(listDockerfiles(mkRepo())).toEqual([]);
  });
});

describe('composeBuildRefs', () => {
  it('block 写法', () => {
    const src = [
      'services:',
      '  user-service:',
      '    build:',
      '      context: .',
      '      dockerfile: deploy/docker/Dockerfile.user-service',
      '    image: x',
      'networks:',
      '  ftl-platform:',
    ].join('\n');
    expect(composeBuildRefs(src)).toEqual([
      {
        service: 'user-service',
        context: '.',
        dockerfile: 'deploy/docker/Dockerfile.user-service',
      },
    ]);
  });

  it('inline 写法（currency 与 payment 两处都要解析）', () => {
    const src = [
      'services:',
      '  currency-service:',
      '    build: { context: ., dockerfile: deploy/docker/Dockerfile.currency-service }',
      '  payment-service:',
      '    build: { context: ., dockerfile: deploy/docker/Dockerfile.payment-service }',
    ].join('\n');
    expect(composeBuildRefs(src)).toEqual([
      {
        service: 'currency-service',
        context: '.',
        dockerfile: 'deploy/docker/Dockerfile.currency-service',
      },
      {
        service: 'payment-service',
        context: '.',
        dockerfile: 'deploy/docker/Dockerfile.payment-service',
      },
    ]);
  });

  it('缺省 context / dockerfile', () => {
    const src = ['services:', '  douzero:', '    build:', '      context: ./douzero'].join('\n');
    expect(composeBuildRefs(src)).toEqual([
      { service: 'douzero', context: './douzero', dockerfile: 'Dockerfile' },
    ]);
  });

  it('注释里的假 dockerfile 不算数；非 services 段不解析', () => {
    const src = [
      'services:',
      '  edge:',
      '    build:',
      '      # dockerfile: deploy/docker/Dockerfile.nope',
      '      context: .',
      '      dockerfile: deploy/docker/Dockerfile.edge',
      'volumes:',
      '  data:',
      '    driver: local',
    ].join('\n');
    expect(composeBuildRefs(src)).toEqual([
      { service: 'edge', context: '.', dockerfile: 'deploy/docker/Dockerfile.edge' },
    ]);
  });

  it('build 块结束后（4 空格子键）不再读取同名键', () => {
    const src = [
      'services:',
      '  a:',
      '    build:',
      '      context: .',
      '      dockerfile: deploy/docker/Dockerfile.a',
      '    environment:',
      '      dockerfile: deploy/docker/Dockerfile.nope',
    ].join('\n');
    expect(composeBuildRefs(src)).toEqual([
      { service: 'a', context: '.', dockerfile: 'deploy/docker/Dockerfile.a' },
    ]);
  });
});

describe('composePathViolations', () => {
  const okRef = { service: 'edge', context: '.', dockerfile: 'deploy/docker/Dockerfile.edge' };

  it('合规：存在、位于 deploy/docker、非孤儿', () => {
    expect(composePathViolations([okRef], ['Dockerfile.edge'], () => true)).toEqual([]);
  });

  it('refs 为空 → 违规（不得 vacuous 通过）', () => {
    expect(composePathViolations([], [], () => true)).toHaveLength(1);
  });

  it('引用不存在 → 违规', () => {
    const v = composePathViolations([okRef], ['Dockerfile.edge'], () => false);
    expect(v.join('\n')).toContain('不存在');
  });

  it('context=. 但路径不在 deploy/docker → 违规', () => {
    const ref = { service: 'x', context: '.', dockerfile: 'Dockerfile.x' };
    const v = composePathViolations([ref], [], () => true);
    expect(v.join('\n')).toContain('必须位于 deploy/docker/');
  });

  it('孤儿 Dockerfile → 违规', () => {
    const v = composePathViolations([okRef], ['Dockerfile.edge', 'Dockerfile.orphan'], () => true);
    expect(v.join('\n')).toContain('孤儿');
    expect(v.join('\n')).toContain('Dockerfile.orphan');
  });

  it('非根 context（douzero）允许 Dockerfile 在 context 内，且路径归一为 POSIX', () => {
    const ref = { service: 'douzero', context: './douzero', dockerfile: 'Dockerfile' };
    const seen: string[] = [];
    const v = composePathViolations([ref], [], (p) => {
      seen.push(p);
      return true;
    });
    expect(v).toEqual([]);
    expect(seen).toEqual(['douzero/Dockerfile']);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C packages/shared test -- dockerfile-scan`
Expected: FAIL —— `composeBuildRefs` / `composePathViolations` / `listDockerfiles` 未导出（TypeScript/ESM 导入错误或 `is not a function`）。

- [ ] **Step 3: 在 helper 中实现（修改 `packages/shared/test/helpers/dockerfile-scan.ts`）**

在文件头注释后新增 import：

```ts
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
```

把文件头注释第一段的「两个机械闸共用」改为「三个机械闸 + compose 路径闸共用」。

在文件末尾追加：

```ts
/** 根目录 Dockerfile 的集中位置（相对仓库根）。 */
export const DOCKERFILE_DIR = 'deploy/docker';

/** 列出 DOCKERFILE_DIR 下的 Dockerfile 文件名（排序；只认 `Dockerfile.*`，README 等不参与）。 */
export function listDockerfiles(repo: string): string[] {
  try {
    return readdirSync(join(repo, DOCKERFILE_DIR))
      .filter((name) => name.startsWith('Dockerfile.'))
      .sort();
  } catch {
    return [];
  }
}

/** compose 中一个 build 引用（dockerfile 相对 context；context 相对 compose 文件目录）。 */
export interface ComposeBuildRef {
  service: string;
  context: string;
  dockerfile: string;
}

const COMPOSE_SERVICE_RE = /^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/;
const COMPOSE_BUILD_RE = /^ {4,}build:\s*(.*)$/;
const COMPOSE_INLINE_CONTEXT_RE = /\bcontext:\s*([^,}\s]+)/;
const COMPOSE_INLINE_DOCKERFILE_RE = /\bdockerfile:\s*([^,}\s]+)/;
const COMPOSE_BLOCK_CONTEXT_RE = /^ {6,}context:\s*([^\s#]+)/;
const COMPOSE_BLOCK_DOCKERFILE_RE = /^ {6,}dockerfile:\s*([^\s#]+)/;

function toPosixPath(p: string): string {
  return p.split(sep).join('/').replace(/^\.\//, '');
}

/**
 * 纯函数：从 compose YAML 文本提取所有 `build:` 引用。
 *
 * ⚠️ 不是完整 YAML 解析器：只覆盖本仓的 block / inline 两种写法；注释判定内联
 * （不新增 `strip*Comments` 函数 —— N46 命名族闸只豁免 `stripDocker*`）。
 */
export function composeBuildRefs(src: string): ComposeBuildRef[] {
  const refs: ComposeBuildRef[] = [];
  let inServices = false;
  let service: string | null = null;
  let inBuild = false;
  let context = '.';
  let dockerfile = 'Dockerfile';

  const flush = (): void => {
    if (service !== null && inBuild) refs.push({ service, context, dockerfile });
    inBuild = false;
    context = '.';
    dockerfile = 'Dockerfile';
  };

  for (const raw of src.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    if (/^\S/.test(raw)) {
      // 顶层键：services / networks / volumes / name …
      flush();
      service = null;
      inServices = raw.startsWith('services:');
      continue;
    }
    if (!inServices) continue;

    const svc = COMPOSE_SERVICE_RE.exec(raw);
    if (svc !== null) {
      flush();
      service = svc[1]!;
      continue;
    }
    if (service === null) continue;

    // 4 空格缩进的键 = 服务的直接子键 ⇒ build 块到此结束（build 自身也是 4 空格，
    // 紧接着的 build 行会在下方重新置 true）。
    if (inBuild && /^ {4}\S/.test(raw)) inBuild = false;

    const build = COMPOSE_BUILD_RE.exec(raw);
    if (build !== null) {
      inBuild = true;
      const inline = build[1]!.trim();
      if (inline.startsWith('{')) {
        const c = COMPOSE_INLINE_CONTEXT_RE.exec(inline);
        const d = COMPOSE_INLINE_DOCKERFILE_RE.exec(inline);
        if (c !== null) context = c[1]!;
        if (d !== null) dockerfile = d[1]!;
      }
      continue;
    }
    if (!inBuild) continue;

    const ctx = COMPOSE_BLOCK_CONTEXT_RE.exec(raw);
    if (ctx !== null) {
      context = ctx[1]!;
      continue;
    }
    const df = COMPOSE_BLOCK_DOCKERFILE_RE.exec(raw);
    if (df !== null) dockerfile = df[1]!;
  }

  flush();
  return refs;
}

/**
 * 纯函数：拿 refs + Dockerfile 文件名清单 + 可注入 isFile，返回违规列表。
 *
 * 判据：① `context === '.'` 的引用必须落在 `deploy/docker/` 下；② 每个引用必须是真实文件；
 * ③ `deploy/docker/` 下每个 Dockerfile 都必须被引用（防孤儿）。
 */
export function composePathViolations(
  refs: ComposeBuildRef[],
  dockerfileNames: string[],
  isFile: (repoRelPath: string) => boolean,
): string[] {
  if (refs.length === 0) {
    return ['compose 中未解析到任何 build.dockerfile —— 解析器失效或 compose 结构变了'];
  }

  const violations: string[] = [];
  const referenced = new Set<string>();

  for (const ref of refs) {
    const rel = toPosixPath(join(ref.context, ref.dockerfile));
    referenced.add(rel);
    if (ref.context === '.' && !rel.startsWith(`${DOCKERFILE_DIR}/`)) {
      violations.push(
        `${ref.service}: context='.' 的 dockerfile 必须位于 ${DOCKERFILE_DIR}/ 下（实际 ${rel}）`,
      );
    }
    if (!isFile(rel)) {
      violations.push(`${ref.service}: dockerfile 不存在或不是文件（${rel}）`);
    }
  }

  for (const name of dockerfileNames) {
    const expected = `${DOCKERFILE_DIR}/${name}`;
    if (!referenced.has(expected)) {
      violations.push(`${expected} 未被任何 compose build 引用（孤儿 Dockerfile）`);
    }
  }

  return violations;
}
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C packages/shared test -- dockerfile-scan`
Expected: PASS（3 个 describe + 13 个 it 全绿）。

- [ ] **Step 5: 类型检查**

Run: `pnpm -C packages/shared lint`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/test/helpers/dockerfile-scan.ts packages/shared/test/helpers/dockerfile-scan.test.ts
git commit -m "test: Dockerfile 扫描 helper 增加目录枚举与 compose 路径对账纯函数

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 原子迁移 13 个 Dockerfile 并同步全部引用

**Files:**
- Move: `Dockerfile.{alert-relay,alertmanager,api-gateway,config-service,currency-service,edge,game-service,grafana,payment-service,prometheus,robot-service,room-service,user-service}` → `deploy/docker/`
- Modify: `docker-compose.yml`（13 处）
- Modify: `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`
- Modify: `packages/shared/test/dockerfile-patches-copy.gate.test.ts`
- Modify: `packages/shared/test/dockerfile-workspace-copy.gate.test.ts`
- Modify: `scripts/verify-agent-static.mjs`
- Modify: `scripts/deploy/build-images.sh`（仅注释）
- Create: `deploy/docker/README.md`

**Interfaces:**
- Consumes: Task 1 的 `DOCKERFILE_DIR` / `listDockerfiles`
- Produces: `deploy/docker/Dockerfile.*` 13 个文件；供 Task 3 的对账闸枚举

- [ ] **Step 1: 先改三个闸的枚举源（此时跑红）**

`packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`：

```diff
-import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
+import { existsSync, readFileSync, statSync } from 'node:fs';
```

```diff
-import { copiesPackageJson, logicalLines } from './helpers/dockerfile-scan';
+import {
+  copiesPackageJson,
+  DOCKERFILE_DIR,
+  listDockerfiles,
+  logicalLines,
+} from './helpers/dockerfile-scan';
```

```diff
-  const dockerfiles = readdirSync(REPO)
-    .filter((name) => name.startsWith('Dockerfile'))
-    .sort();
+  const dockerfiles = listDockerfiles(REPO);
   const participating = dockerfiles.filter((name) =>
-    isParticipating(readFileSync(join(REPO, name), 'utf-8')),
+    isParticipating(readFileSync(join(REPO, DOCKERFILE_DIR, name), 'utf-8')),
   );
```

```diff
     for (const name of dockerfiles) {
-      for (const v of frozenViolations(readFileSync(join(REPO, name), 'utf-8'))) {
+      for (const v of frozenViolations(
+        readFileSync(join(REPO, DOCKERFILE_DIR, name), 'utf-8'),
+      )) {
         violations.push(`${name}: ${v}`);
       }
```

`packages/shared/test/dockerfile-patches-copy.gate.test.ts`：

```diff
-import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
+import { existsSync, readFileSync, statSync } from 'node:fs';
```

```diff
-import { copiesPackageJson, copiesPatches, logicalLines } from './helpers/dockerfile-scan';
+import {
+  copiesPackageJson,
+  copiesPatches,
+  DOCKERFILE_DIR,
+  listDockerfiles,
+  logicalLines,
+} from './helpers/dockerfile-scan';
```

```diff
-  const dockerfiles = readdirSync(REPO)
-    .filter((name) => name.startsWith('Dockerfile'))
-    .sort();
+  const dockerfiles = listDockerfiles(REPO);
```

```diff
     for (const name of dockerfiles) {
-      const src = readFileSync(join(REPO, name), 'utf-8');
+      const src = readFileSync(join(REPO, DOCKERFILE_DIR, name), 'utf-8');
```

`packages/shared/test/dockerfile-workspace-copy.gate.test.ts`：

```diff
 import { describe, expect, it } from 'vitest';
+import { DOCKERFILE_DIR, listDockerfiles } from './helpers/dockerfile-scan';
```

```diff
-  const dockerfiles = readdirSync(REPO)
-    .filter((name) => name.startsWith('Dockerfile.'))
-    .sort();
+  const dockerfiles = listDockerfiles(REPO);
```

```diff
-    const us = readFileSync(join(REPO, 'Dockerfile.user-service'), 'utf-8');
+    const us = readFileSync(
+      join(REPO, DOCKERFILE_DIR, 'Dockerfile.user-service'),
+      'utf-8',
+    );
```

```diff
       for (const v of workspaceCopyViolations(
-        readFileSync(join(REPO, name), 'utf-8'),
+        readFileSync(join(REPO, DOCKERFILE_DIR, name), 'utf-8'),
         depsOfDir,
         dirOfName,
       )) {
```

（`dockerfile-workspace-copy.gate.test.ts` 的 `readdirSync` 仍被 `workspacePackages()` 使用，保留其 import。）

- [ ] **Step 2: 跑红（证明闸真的看新目录）**

Run: `pnpm -C packages/shared test -- dockerfile-`
Expected: 3 个 Dockerfile 闸失败（`expected [] to have a length of at least 7` 等）；helper 单测通过。

- [ ] **Step 3: 执行迁移**

```bash
mkdir -p deploy/docker
git mv Dockerfile.* deploy/docker/
```

- [ ] **Step 4: 更新 compose 13 处路径**

```bash
perl -pi -e 's/dockerfile: Dockerfile\./dockerfile: deploy\/docker\/Dockerfile./g' docker-compose.yml
grep -n 'dockerfile:' docker-compose.yml
```

Expected output（14 行）：13 行 `deploy/docker/Dockerfile.*`，1 行 `dockerfile: Dockerfile`（douzero，保持原样）。

```text
107:      dockerfile: Dockerfile
136:      dockerfile: deploy/docker/Dockerfile.user-service
213:      dockerfile: deploy/docker/Dockerfile.config-service
300:    build: { context: ., dockerfile: deploy/docker/Dockerfile.currency-service }
354:    build: { context: ., dockerfile: deploy/docker/Dockerfile.payment-service }
402:      dockerfile: deploy/docker/Dockerfile.room-service
461:      dockerfile: deploy/docker/Dockerfile.game-service
515:      dockerfile: deploy/docker/Dockerfile.robot-service
580:      dockerfile: deploy/docker/Dockerfile.api-gateway
670:      dockerfile: deploy/docker/Dockerfile.edge
716:      dockerfile: deploy/docker/Dockerfile.prometheus
749:      dockerfile: deploy/docker/Dockerfile.grafana
793:      dockerfile: deploy/docker/Dockerfile.alertmanager
896:      dockerfile: deploy/docker/Dockerfile.alert-relay
```

- [ ] **Step 5: 更新 13 个 Dockerfile 首行注释**

```bash
perl -pi -e 's{^# platform/Dockerfile\.}{# platform/deploy/docker/Dockerfile.}' deploy/docker/Dockerfile.*
head -1 deploy/docker/Dockerfile.*
```

Expected: 每行形如 `# platform/deploy/docker/Dockerfile.user-service ...`。

- [ ] **Step 6: 更新 `scripts/verify-agent-static.mjs`**

```diff
-const edge = read('Dockerfile.edge');
-ok(edge.includes('COPY agent /srv/agent'), 'Dockerfile.edge COPY agent /srv/agent');
+const edge = read('deploy/docker/Dockerfile.edge');
+ok(
+  edge.includes('COPY agent /srv/agent'),
+  'deploy/docker/Dockerfile.edge COPY agent /srv/agent',
+);
```

同时把文件头注释第 6 条里的 `Dockerfile.edge` 改为 `deploy/docker/Dockerfile.edge`。

- [ ] **Step 7: 更新 `scripts/deploy/build-images.sh` 注释**

```diff
-    # ⚠️ `mode=max` 才能让被多阶段复用的层（`Dockerfile.edge` 的 web 阶段）也进缓存。
+    # ⚠️ `mode=max` 才能让被多阶段复用的层（`deploy/docker/Dockerfile.edge` 的 web 阶段）也进缓存。
```

- [ ] **Step 8: 新建 `deploy/docker/README.md`**

```markdown
# Dockerfile 目录

- **构建上下文是仓库根**：所有 compose `build.context` 都是 `.`，`COPY packages/...`、
  `COPY pnpm-lock.yaml` 等路径以仓库根为基准，**不要**写成相对本目录。
- 新增镜像：本目录建 `Dockerfile.<service>` → `docker-compose.yml` 加
  `dockerfile: deploy/docker/Dockerfile.<service>` → 同步
  `packages/shared/test/dockerfile-compose-refs.gate.test.ts` 的哨兵计数。
- `.dockerignore` 必须留在仓库根（BuildKit 从上下文根读取），不能移进本目录。
```

- [ ] **Step 9: 跑绿 + 验证脚本**

Run:

```bash
pnpm -C packages/shared test -- dockerfile-
pnpm verify:agent
pnpm -C packages/shared lint
```

Expected: 全绿；`verify:agent` 输出全部 `✅`。

- [ ] **Step 10: 提交**

```bash
git add deploy/docker docker-compose.yml scripts/verify-agent-static.mjs scripts/deploy/build-images.sh \
  packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts \
  packages/shared/test/dockerfile-patches-copy.gate.test.ts \
  packages/shared/test/dockerfile-workspace-copy.gate.test.ts
git commit -m "refactor: Dockerfile 迁入 deploy/docker（context 保持仓库根）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 新增 compose → Dockerfile 路径对账闸

**Files:**
- Create: `packages/shared/test/dockerfile-compose-refs.gate.test.ts`
- Consumes: Task 1 的 `composeBuildRefs` / `composePathViolations` / `DOCKERFILE_DIR` / `listDockerfiles`

**Interfaces:**
- Produces: 机械闸——14 个 build 引用全部存在、13 个 Dockerfile 全部被引用、根目录零 Dockerfile

- [ ] **Step 1: 写测试文件**

```ts
/**
 * **机械闸（compose → Dockerfile 路径对账）**：`docker-compose.yml` 的每个
 * `build.dockerfile` 都必须指向真实文件；`deploy/docker/` 下每个 Dockerfile
 * 都必须被 compose 引用；根目录不得再出现 Dockerfile。
 *
 * ## 它守的是什么（2026-11-04 迁移）
 *
 * Dockerfile 从仓库根迁入 `deploy/docker/` 后，`COPY` 路径不变（上下文仍是根），
 * 唯一真实风险是 compose 路径漂移。`docker compose config` **不** stat Dockerfile，
 * 直接 `docker build -f` 又绕过 compose ⇒ 漂移只会在镜像构建（最贵的门）爆炸。
 * 本闸把路径存在性、目录约定、孤儿文件都钉在单测层。
 *
 * ## 判据
 *
 *  - `context: .` 的引用必须落在 `deploy/docker/` 下；
 *  - 每个引用必须是真实文件（`statSync(...).isFile()`）；
 *  - `deploy/docker/` 下每个 Dockerfile 必须被引用；
 *  - 根目录 `Dockerfile*` 必须为空；
 *  - 哨兵：14 个引用、13 个 Dockerfile、含已知成员。
 *
 * ## 判别力自证
 *
 * 纯函数 `composePathViolations` 的假样本在 `helpers/dockerfile-scan.test.ts`；
 * 本文件在实施期用「临时改坏 compose / 临时放回根目录」两次变异验证过必红。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  composeBuildRefs,
  composePathViolations,
  listDockerfiles,
} from './helpers/dockerfile-scan';

/** 从本文件所在目录向上找仓库根（锚 = packages/shared + packages/protocol + pnpm-workspace.yaml）。 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"') &&
      existsSync(join(dir, 'pnpm-workspace.yaml'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '找不到仓库根（锚 = packages/shared + packages/protocol + pnpm-workspace.yaml）',
  );
}

const REPO = findRepoRoot();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

describe('compose → Dockerfile 路径对账闸', () => {
  const refs = composeBuildRefs(read('docker-compose.yml'));
  const dockerfiles = listDockerfiles(REPO);

  const isFile = (rel: string): boolean => {
    try {
      return statSync(join(REPO, rel)).isFile();
    } catch {
      return false;
    }
  };

  it('哨兵：14 个 build 引用、13 个 Dockerfile、含已知成员', () => {
    expect(refs).toHaveLength(14);
    expect(dockerfiles).toHaveLength(13);
    expect(refs.map((r) => r.service)).toEqual(
      expect.arrayContaining(['douzero', 'edge', 'api-gateway']),
    );
  });

  it('根目录不得出现 Dockerfile*', () => {
    expect(readdirSync(REPO).filter((name) => name.startsWith('Dockerfile'))).toEqual([]);
  });

  it('每个引用存在、位于 deploy/docker、且无孤儿 Dockerfile', () => {
    expect(composePathViolations(refs, dockerfiles, isFile)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑绿（当前状态应已合规）**

Run: `pnpm -C packages/shared test -- dockerfile-compose-refs`
Expected: PASS（3 个 it）。

- [ ] **Step 3: 变异验证 A —— 根目录放回 Dockerfile 必红**

```bash
printf 'FROM scratch\n' > Dockerfile.__mutation
pnpm -C packages/shared test -- dockerfile-compose-refs
```

Expected: FAIL —— `根目录不得出现 Dockerfile*`，diff 含 `Dockerfile.__mutation`。

```bash
rm Dockerfile.__mutation
```

- [ ] **Step 4: 变异验证 B —— compose 路径改坏必红**

```bash
perl -pi -e 's{deploy/docker/Dockerfile\.grafana}{deploy/docker/Dockerfile.__missing}' docker-compose.yml
pnpm -C packages/shared test -- dockerfile-compose-refs
```

Expected: FAIL —— 违规列表含 `dockerfile 不存在或不是文件（deploy/docker/Dockerfile.__missing）` 与 `Dockerfile.grafana 未被任何 compose build 引用`。

```bash
git checkout -- docker-compose.yml
```

- [ ] **Step 5: 恢复后跑绿**

Run: `pnpm -C packages/shared test -- dockerfile-compose-refs`
Expected: PASS。

- [ ] **Step 6: 类型检查**

Run: `pnpm -C packages/shared lint`
Expected: exit 0。

- [ ] **Step 7: 提交**

```bash
git add packages/shared/test/dockerfile-compose-refs.gate.test.ts
git commit -m "test: 新增 compose→Dockerfile 路径对账闸

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量验证与文档收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-11-04-dockerfile-relocation-design.md`（状态行）
- Modify: `docs/superpowers/plans/2026-11-04-dockerfile-relocation.md`（勾选完成项）

- [ ] **Step 1: 全量验证**

```bash
pnpm -C packages/shared test
pnpm -C packages/shared lint
pnpm verify:agent
```

Expected: 全绿。

- [ ] **Step 2: 检查工作区与引用完整性**

```bash
git status --porcelain
grep -rn 'Dockerfile\.' --include='*.yml' --include='*.yaml' --include='*.sh' --include='*.mjs' \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.turbo | grep -v 'deploy/docker/Dockerfile'
```

Expected:
- `git status` 只有本任务要提交的文档改动；
- 第二条只应命中 `douzero/Dockerfile` 相关与历史/注释性裸文件名（无活路径引用指向根目录）。

- [ ] **Step 3: 更新 spec 状态行**

把 `**状态**：已对抗审查（阻断 0 / 高 4 已修）；待用户确认后进入计划` 改为
`**状态**：已实现并验证（2026-11-04）`。

- [ ] **Step 4: 提交文档收尾**

```bash
git add docs/superpowers/specs/2026-11-04-dockerfile-relocation-design.md \
  docs/superpowers/plans/2026-11-04-dockerfile-relocation.md
git commit -m "docs: Dockerfile 迁移实现与验证记录

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 回归命令汇总

```bash
pnpm -C packages/shared test -- dockerfile-
pnpm -C packages/shared test
pnpm -C packages/shared lint
pnpm verify:agent
```

## 验证边界

- 本机**无 Docker CLI**：`docker compose build` / `buildx bake` 无法执行。
- 真实构建通路由合 master 后的 `.github/workflows/images.yml`（`scripts/deploy/build-images.sh`）权威验证。
- 若执行者机器有 Docker，补跑：仓库根 `docker compose -f docker-compose.yml build api-gateway`。
