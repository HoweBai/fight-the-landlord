# 工程债清理（Dockerfile 可复现构建 + patches 残留）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 10 个 node 镜像的依赖安装与已提交 `pnpm-lock.yaml` 完全一致，并删除已无引用的
`patches/` 与 10 处 `COPY patches`，同时用机械闸钉住这两条性质。

**Architecture:** 先提交 spec/plan，再 cherry-pick C3 分支的 test-only TS 修复解除 P0；
然后按「门禁先红 → 改实现 → 门禁绿」的 TDD 顺序做 B（patches 清理 + 双向闸）与
A（`--frozen-lockfile` + 新闸）；最后清理已批准的死物。两个 Dockerfile 闸共用新建的
`packages/shared/test/helpers/dockerfile-scan.ts`（续行拼接 + COPY 解析），避免解析不对称。
最后一次性跑 `scripts/ci.sh`、images workflow 与测试服冒烟。

**Tech Stack:** pnpm 9.15.0 / Docker BuildKit / Vitest 4 / TypeScript 5.9 / turbo 2.x。

## Global Constraints

- **源码/配置零改动**；本次全部是构建期与测试期改动。唯一可见差异是镜像依赖树与已提交
  lockfile 对齐（V8/V9 的 peer 布局），由 images workflow + 部署冒烟验证。
- **不得放宽任何既有断言**；B 的门禁改造是「空集侧新增禁令 + 非空侧原样保留」。
- 每个 commit 都带：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 每个任务结束工作区必须干净；不碰主工作区 `D:/Code/fight-the-landlord`
  （当前在 `feature/pdk-trust-c3`）。
- 所有命令在 worktree `D:/Code/ftl-eng-debt` 下执行；推 tag / 部署前已经用户确认。
- 镜像验证用 `dev-<7 位短 sha>` 临时 tag；**只推 feature 分支与临时 tag，不合 master、不打 release tag**。
- 测试命令一律 `--force` 或单测直跑；`Cached` 不算真跑。
- 不得修改 `feature/pdk-trust-c3` 分支或其工作区。

---

### Task 0: 文档落盘 + 解除 P0（cherry-pick test-only TS 修复）

**Files:**
- Add: `docs/superpowers/specs/2026-10-28-engineering-debt-cleanup-design.md`
- Add: `docs/superpowers/plans/2026-10-28-engineering-debt-cleanup.md`
- Modify: `packages/room-service/test/ws.gateway.test.ts`（经 cherry-pick）

**Interfaces:**
- Consumes: 无
- Produces: `dev` 基线 lint 转绿，后续任务的「全量绿」判据成立。

- [ ] **Step 0: 提交 spec/plan 与审查记录**

```bash
git -C D:/Code/ftl-eng-debt add \
  docs/superpowers/specs/2026-10-28-engineering-debt-cleanup-design.md \
  docs/superpowers/plans/2026-10-28-engineering-debt-cleanup.md
git -C D:/Code/ftl-eng-debt commit -m "docs(eng-debt): 设计 spec、实现计划与对抗审查记录

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: 新增 docs commit（设计/计划审查记录已回填）。

- [ ] **Step 1: 确认补丁可干净应用（不改工作区）**

```bash
git -C D:/Code/ftl-eng-debt show 0e69dea8 --format= | \
  git -C D:/Code/ftl-eng-debt apply --check --3way - && echo "APPLIES_CLEANLY"
```

Expected: exit 0 且打印 `APPLIES_CLEANLY`（不依赖具体补丁措辞）。

- [ ] **Step 2: cherry-pick**

```bash
git -C D:/Code/ftl-eng-debt cherry-pick -x 0e69dea8
```

Expected: 新 commit，提交信息保留原文（`fix(room): 修复既有 ws.gateway 测试 TS2345（订阅修复后遗症）`）。
该提交把调用点改为 `return realOn(event, listener as never)`——参数类型本已是
`(...a: never[]) => void`，运行期零变化。

- [ ] **Step 3: 验证 lint**

```bash
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/room-service lint
```

Expected: exit 0。

- [ ] **Step 4: 验证全量 lint+build**

```bash
pnpm --dir D:/Code/ftl-eng-debt exec turbo run lint build --force
```

Expected: `Tasks: 30 successful, 30 total`、`0 cached`。

---

### Task 1: Debt B — 删除 `patches/` 与 `COPY patches`，门禁改双向闸

**Files:**
- Create: `packages/shared/test/helpers/dockerfile-scan.ts`
- Modify: `packages/shared/test/dockerfile-patches-copy.gate.test.ts`
- Delete: `patches/vitest@2.1.9.patch`（及目录）
- Modify: 10 个 Dockerfile（`alert-relay` / `api-gateway` / `config-service` /
  `currency-service` / `edge` / `game-service` / `payment-service` / `robot-service` /
  `room-service` / `user-service`）
- Modify: `docs/superpowers/plans/2026-10-27-dependabot-fixes.md`
- Modify: `docs/superpowers/specs/2026-10-02-security-scan-design.md`
- Modify: `docs/superpowers/specs/2026-10-03-monitoring-design.md`
- Modify: `docs/superpowers/specs/2026-10-03-monitoring-spec.md`
- Modify: `docs/superpowers/specs/2026-10-03-currency-spec.md`
- Modify: `docs/superpowers/specs/2026-10-02-security-scan-spec.md`

**Interfaces:**
- Produces（helper）：`logicalLines(src): string[]`、`copySources(line): string[] | null`、
  `normalizeCopyPath(p): string`、`copiesPatches(line): boolean`、
  `copiesPackageJson(line): boolean`
- Produces（gate）：`checkDockerfile(src): string[]`、`stalePatchesCopy(src): string[]`

- [ ] **Step 1: 新建共享扫描助手**

Create `packages/shared/test/helpers/dockerfile-scan.ts`：

```ts
/**
 * Dockerfile 扫描的共享纯函数（**测试侧**，不参与运行时）。
 *
 * 两个机械闸（dockerfile-patches-copy / dockerfile-frozen-lockfile）共用：
 *  - `logicalLines`：剥整行 `#` 注释 + 拼接 `\` 续行；
 *  - `copySources`：取 `COPY` 的**构建上下文**源参数（剥 `--flag`；`--from=` 返回 null，
 *    不把跨 stage/镜像复制误判为本地 COPY）；
 *  - `copiesPackageJson` / `copiesPatches`：路径归一后判断。
 *
 * ⚠️ 不是完整 Dockerfile 解析器：不支持引号内空格等复杂形态；已知边界由各闸自证覆盖。
 */
export function logicalLines(src: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const continues = line.endsWith('\\');
    const piece = continues ? line.slice(0, -1).trimEnd() : line;
    buf = buf === '' ? piece : `${buf} ${piece}`;
    if (!continues) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf !== '') out.push(buf);
  return out;
}

export function copySources(line: string): string[] | null {
  const m = /^COPY\s+(.*)$/i.exec(line);
  if (m === null) return null;
  const tokens = m[1]!.trim().split(/\s+/).filter((t) => t !== '');
  let i = 0;
  let from = false;
  while (i < tokens.length && tokens[i]!.startsWith('--')) {
    if (tokens[i]!.startsWith('--from=')) from = true;
    i += 1;
  }
  if (from) return null; // 跨 stage / 镜像复制，不是构建上下文
  const rest = tokens.slice(i).join(' ');
  if (rest === '') return null;
  if (rest.startsWith('[')) {
    try {
      const arr = JSON.parse(rest) as unknown;
      if (!Array.isArray(arr) || arr.length < 2 || !arr.every((x) => typeof x === 'string')) {
        return null;
      }
      return (arr as string[]).slice(0, -1);
    } catch {
      return null;
    }
  }
  const sources = rest.split(/\s+/).filter((t) => t !== '');
  return sources.length >= 2 ? sources.slice(0, -1) : null;
}

export function normalizeCopyPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

export function copiesPatches(line: string): boolean {
  const sources = copySources(line);
  return sources?.some((s) => normalizeCopyPath(s) === 'patches') ?? false;
}

export function copiesPackageJson(line: string): boolean {
  const sources = copySources(line);
  return sources?.some((s) => normalizeCopyPath(s) === 'package.json') ?? false;
}
```

- [ ] **Step 2: 改写 patches 闸为双向语义（先不删 Dockerfile）**

把 `packages/shared/test/dockerfile-patches-copy.gate.test.ts` **整个文件**替换为：

```ts
/**
 * **机械闸（双向）**：
 *  - `patchedDependencies` **非空** ⇒ 每个参与 Dockerfile 必须在 `pnpm install` 前
 *    `COPY patches ./patches`；
 *  - `patchedDependencies` **为空** ⇒ 任何参与 Dockerfile 都**不得**再 COPY patches
 *    （2026-10-28 清理：目录已删除，死 COPY 必须同时消失）。
 *
 * 「参与」= 逻辑行（已拼续行）同时有 `COPY package.json` 与 `pnpm ... install`。
 * COPY 识别由 `./helpers/dockerfile-scan` 统一提供（覆盖 `./patches`、尾斜杠、JSON 数组、
 * 多源 COPY；`--from=` 不算本地 COPY）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copiesPackageJson, copiesPatches, logicalLines } from './helpers/dockerfile-scan';

/** 从本文件所在目录向上找仓库根（锚 = `packages/shared` + `packages/protocol`；找不到抛错）。 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/shared/package.json 且 name 校验通过 + packages/protocol）');
}

const REPO = findRepoRoot();

const HAS_PNPM_INSTALL = /\bpnpm\b[^\n]*\binstall\b/;
const IS_RUN = /^RUN\b/i;

/**
 * 纯函数：对**单个** Dockerfile 做判据 ②（仅在 `patchedDependencies` 非空时施加）。
 * 返回违规列表（空 = 合规 / 不参与）。
 */
export function checkDockerfile(src: string): string[] {
  const lines = logicalLines(src);
  if (!lines.some((line) => copiesPackageJson(line))) {
    return []; // 不 COPY 根 package.json 的 Dockerfile 不参与（如 douzero 型）
  }
  const installIdx = lines.findIndex((line) => IS_RUN.test(line) && HAS_PNPM_INSTALL.test(line));
  if (installIdx === -1) {
    return []; // 无 install ⇒ 不会读 patches（同样不参与）
  }
  const copyIdx = lines.findIndex((line) => copiesPatches(line));
  if (copyIdx === -1) {
    return ['missing: 缺 `COPY patches ./patches`（容器内 pnpm install 会 ENOENT）'];
  }
  if (copyIdx > installIdx) {
    return [`after-install: \`COPY patches ./patches\` 在 pnpm install（第 ${installIdx + 1} 条有效指令）之后`];
  }
  return [];
}

/** 纯函数：`patchedDependencies` 为空时，任何形式的 patches COPY 都是死 COPY。 */
export function stalePatchesCopy(src: string): string[] {
  const lines = logicalLines(src);
  if (!lines.some((line) => copiesPackageJson(line))) return [];
  if (!lines.some((line) => IS_RUN.test(line) && HAS_PNPM_INSTALL.test(line))) return [];
  return lines.some((line) => copiesPatches(line))
    ? ['stale: patchedDependencies 为空，但 Dockerfile 仍 COPY patches（死 COPY，应删除）']
    : [];
}

describe('假红④镜像侧对账闸：patchedDependencies ⇒ 镜像 Dockerfile 必须 COPY patches（双向）', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as {
    pnpm?: { patchedDependencies?: Record<string, string> };
  };
  const patched = Object.entries(pkg.pnpm?.patchedDependencies ?? {});

  const dockerfiles = readdirSync(REPO)
    .filter((name) => name.startsWith('Dockerfile'))
    .sort();

  it('哨兵（R179）：Dockerfile 集合非空且含已知成员（防 glob 失效恒绿）', () => {
    expect(dockerfiles.length).toBeGreaterThanOrEqual(7);
    expect(dockerfiles).toContain('Dockerfile.edge');
    expect(dockerfiles).toContain('Dockerfile.config-service');
  });

  it('① 前提端：patchedDependencies 非空时，每个 patch 文件必须真实存在', () => {
    for (const [name, path] of patched) {
      expect(existsSync(join(REPO, path)), `${name} → ${path} 不存在`).toBe(true);
    }
  });

  it('② 消费端：按 patchedDependencies 双向对账（非空 ⇒ 必须 COPY；空 ⇒ 禁止 COPY）', () => {
    const requirePatches = patched.length > 0;
    const violations: string[] = [];
    for (const name of dockerfiles) {
      const src = readFileSync(join(REPO, name), 'utf-8');
      const found = requirePatches ? checkDockerfile(src) : stalePatchesCopy(src);
      for (const v of found) violations.push(`${name}: ${v}`);
    }
    expect(
      violations,
      requirePatches
        ? 'patchedDependencies 非空：必须在 install 前 COPY patches'
        : 'patchedDependencies 为空：不得再 COPY patches',
    ).toEqual([]);
  });

  it('判别力自证：漏 COPY / 晚于 install / 注释 / 路径变体 / 续行 install', () => {
    // 非空侧（checkDockerfile）
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY patches ./patches\nRUN pnpm install --frozen-lockfile\n',
      ),
    ).toEqual([]);
    expect(
      checkDockerfile('FROM node:20-slim\nCOPY package.json ./\nRUN pnpm install --frozen-lockfile\n').length,
    ).toBe(1);
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nRUN pnpm install --frozen-lockfile\nCOPY patches ./patches\n',
      )[0],
    ).toContain('after-install');
    expect(
      checkDockerfile('FROM node:20-slim\nRUN pip install -r requirements.txt\nCOPY patches ./patches\n'),
    ).toEqual([]);
    expect(
      checkDockerfile('FROM node:20-slim\nCOPY package.json ./\n# COPY patches ./patches\nRUN pnpm install\n').length,
    ).toBe(1);
    // 路径 / 数组 / 多源 / --chown 变体必须被识别为「已 COPY」
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY ./patches/ ./patches/\nRUN pnpm install --frozen-lockfile\n',
      ),
    ).toEqual([]);
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY ["package.json", "./"]\nCOPY ["patches", "./patches"]\nRUN pnpm install --frozen-lockfile\n',
      ),
    ).toEqual([]);
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY --chown=node package.json ./\nCOPY package.json patches ./\nRUN pnpm install --frozen-lockfile\n',
      ),
    ).toEqual([]);
    // 续行式 install（`pnpm install` 在第二行）也必须参与；缺 COPY ⇒ 红
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nRUN npm install -g pnpm@9.15.0 && \\\n pnpm install --frozen-lockfile\n',
      )[0],
    ).toContain('missing');
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY patches ./patches\nRUN npm install -g pnpm@9.15.0 && \\\n pnpm install --frozen-lockfile\n',
      ),
    ).toEqual([]);
    // 空侧（stalePatchesCopy）
    expect(
      stalePatchesCopy(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY patches ./patches\nRUN pnpm install --frozen-lockfile\n',
      ).length,
    ).toBe(1);
    expect(
      stalePatchesCopy(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY ./patches/ ./patches/\nRUN pnpm install --frozen-lockfile\n',
      ).length,
    ).toBe(1);
    expect(
      stalePatchesCopy(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY ["patches", "./patches"]\nRUN pnpm install --frozen-lockfile\n',
      ).length,
    ).toBe(1);
    expect(
      stalePatchesCopy(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY patches ./patches\nRUN npm install -g pnpm@9.15.0 && \\\n pnpm install --frozen-lockfile\n',
      ).length,
    ).toBe(1);
    expect(
      stalePatchesCopy('FROM node:20-slim\nCOPY package.json ./\nRUN pnpm install --frozen-lockfile\n'),
    ).toEqual([]);
    expect(
      stalePatchesCopy('FROM node:20-slim\nRUN pip install -r requirements.txt\nCOPY patches ./patches\n'),
    ).toEqual([]);
    expect(
      stalePatchesCopy('FROM node:20-slim\nCOPY package.json ./\n# COPY patches ./patches\nRUN pnpm install\n'),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑门禁确认红**

```bash
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/shared test -- dockerfile-patches
```

Expected: FAIL，10 个 Dockerfile 各报一条 `stale: patchedDependencies 为空…`。

- [ ] **Step 4: 删除 `patches/` 与 10 个 Dockerfile 的固定三行块**

```bash
git -C D:/Code/ftl-eng-debt rm -r patches
```

用 Node 对 10 个 Dockerfile 做**逐字节固定串删除**（不匹配就抛错）：

```bash
node -e '
const fs=require("fs");
const files=["Dockerfile.alert-relay","Dockerfile.api-gateway","Dockerfile.config-service","Dockerfile.currency-service","Dockerfile.edge","Dockerfile.game-service","Dockerfile.payment-service","Dockerfile.robot-service","Dockerfile.room-service","Dockerfile.user-service"];
const block="# ⚠️ 2026-10-27 起 pnpm.patchedDependencies 为空（vitest 4 已不需要补丁）；\n# COPY patches 暂留（目录仍有历史补丁文件；删除需同步改全部 Dockerfile，另立清理片）\nCOPY patches ./patches\n";
for (const f of files){const p="D:/Code/ftl-eng-debt/"+f;const s=fs.readFileSync(p,"utf8");if(!s.includes(block))throw new Error("block missing: "+f);fs.writeFileSync(p,s.replace(block,""));}
console.log("patched 10 Dockerfiles");
'
```

Expected: `patched 10 Dockerfiles`。

- [ ] **Step 5: 更新 alert-relay 头部注释**

把：

```text
# COPY 次序**照 `Dockerfile.user-service` 的模板**（工作区文件 + `patches/` + `tsconfig.base`
```

改为：

```text
# COPY 次序**照 `Dockerfile.user-service` 的模板**（工作区文件 + `tsconfig.base`
```

- [ ] **Step 6: 跑门禁确认绿**

```bash
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/shared test -- dockerfile-patches
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/shared test -- dockerfile-workspace
```

Expected: 两个命令都通过；workspace 闸无回归。

- [ ] **Step 7: 全仓确认无残留引用**

```bash
rg --hidden -n "COPY patches|patches/" D:/Code/ftl-eng-debt \
  --glob '!node_modules/**' --glob '!.git/**' --glob '!docs/superpowers/**' \
  --glob '!packages/shared/test/**'
```

Expected: 零命中（`docs/superpowers/**` 的历史记录另由 Step 8 订正；
`packages/shared/test/**` 的门禁自证样本是唯一允许出现 `COPY patches` 字样的地方）。

- [ ] **Step 8: 回填文档**

- `docs/superpowers/plans/2026-10-27-dependabot-fixes.md` 的 patches 注与风险表第 70 行：
  改为「**2026-10-28 已清理**：`patches/` 与 10 个 Dockerfile 的 `COPY patches ./patches`
  已删除；`dockerfile-patches-copy.gate.test.ts` 改为双向闸（有 patch ⇒ 必须 COPY；无 patch ⇒ 禁止 COPY）。」
- `docs/superpowers/specs/2026-10-02-security-scan-design.md` 的 vitest 补丁行加：
  「**2026-10-28 订正**：vitest 已升 4.x，`patchedDependencies` 与补丁文件均已移除。」
- 以下 4 份历史文档各加一行 2026-10-28 订正注（现行语义以
  `dockerfile-patches-copy.gate.test.ts` 为准，`patches/` 已删除）：
  `docs/superpowers/specs/2026-10-03-monitoring-design.md`（`:114`）、
  `docs/superpowers/specs/2026-10-03-monitoring-spec.md`（`:367`）、
  `docs/superpowers/specs/2026-10-03-currency-spec.md`（`:61`）、
  `docs/superpowers/specs/2026-10-02-security-scan-spec.md`（`:124` / `:374`）。

- [ ] **Step 9: 提交**

```bash
git -C D:/Code/ftl-eng-debt add -A
git -C D:/Code/ftl-eng-debt commit -m "chore(docker): 删除 patches/ 与 10 个 Dockerfile 的 COPY patches

- patches/vitest@2.1.9.patch 自 vitest 4 起无引用，锁文件零 patches/ 引用
- dockerfile-patches-copy 闸改为双向：有 patchedDependencies ⇒ 必须 COPY；为空 ⇒ 禁止 COPY
- 新增共享 dockerfile-scan 助手：拼续行、路径变体 / JSON 数组 / 多源 COPY / --from 排除
- 回填 6 份仍声称必须 COPY patches / 补丁不动的历史文档

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Debt A — 10 个 Dockerfile 改 `--frozen-lockfile` + 新闸

**Files:**
- Create: `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`
- Reuse: `packages/shared/test/helpers/dockerfile-scan.ts`（Task 1 新建）
- Modify: 同 Task 1 的 10 个 Dockerfile（只改 install flag 与注释）
- Modify: `docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md`

**Interfaces:**
- Consumes: `logicalLines`、`copiesPackageJson`（来自 helper）
- Produces: `export function frozenViolations(src: string): string[]`

- [ ] **Step 1: 新建门禁测试**

完整文件：

```ts
/**
 * **机械闸（镜像依赖可复现）**：每个参与 Dockerfile 的**每一条** `pnpm ... install`
 * 都必须带 `--frozen-lockfile`，且不得带 `--no-frozen-lockfile` /
 * `--frozen-lockfile=false`。
 *
 * ## 它守的是什么（2026-10-28）
 *
 * 10 个 node 镜像此前用 `--no-frozen-lockfile`，理由是「只 COPY 部分 workspace」。
 * 实测（复刻 Dockerfile COPY 清单、pnpm 9.15.0）：当前子集直接 `--frozen-lockfile`
 * 即可通过；而 no-frozen 在 manifest 与 lockfile 漂移时会**静默改写 lockfile**
 * （V7：exit 0 + lockfile 变），同一 commit 会装出不同依赖图（.pnpm 的 peer 布局差异）。
 * ⇒ 把「镜像构建必须与已提交 lockfile 完全一致」钉成单测层机械闸。
 *
 * ## 判据
 *
 *  - 参与 = 逻辑行（已拼续行）有 `COPY package.json` 且有 `pnpm ... install`
 *    （douzero 型不参与）；
 *  - **每一条** install 逻辑行都必须带 `--frozen-lockfile`，且不得带
 *    `--no-frozen-lockfile` / `--(config.)?frozen-lockfile=(false|0)`；
 *  - install 识别用 `\bpnpm\b[^\n]*\binstall\b`，覆盖 `pnpm --filter <pkg> install` 变体；
 *  - COPY 解析由共享 `./helpers/dockerfile-scan` 提供（`--chown`、`./package.json`、
 *    JSON 数组均可识别；`--from=` 不算构建上下文）；
 *  - 哨兵：参与集合**恰好等于已知 10 个 node 镜像**（加新镜像需显式更新——有意的强制确认）。
 *
 * ## 判别力自证（R115 / R150）
 *
 * no-frozen / 无 flag / 第二条 install 违规 / `pnpm --filter ... install` 变体 /
 * `--config.frozen-lockfile=false` / 注释里的 flag 不算数 / 多行续行 / 不参与者。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copiesPackageJson, logicalLines } from './helpers/dockerfile-scan';

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
  throw new Error('找不到仓库根（锚 = packages/shared + packages/protocol + pnpm-workspace.yaml）');
}

const REPO = findRepoRoot();

const HAS_PNPM_INSTALL = /\bpnpm\b[^\n]*\binstall\b/;
const IS_RUN = /^RUN\b/i;
const HAS_NO_FROZEN = /--no-frozen-lockfile\b/;
const HAS_FROZEN_FALSE = /--(?:config\.)?frozen-lockfile=(?:false|0)\b/;
const HAS_FROZEN = /--frozen-lockfile\b/;

/** 纯函数：返回违规列表（空 = 合规 / 不参与）。 */
export function frozenViolations(src: string): string[] {
  const lines = logicalLines(src);
  if (!lines.some((line) => copiesPackageJson(line))) return [];
  const installs = lines.filter((line) => IS_RUN.test(line) && HAS_PNPM_INSTALL.test(line));
  if (installs.length === 0) return [];
  const violations: string[] = [];
  installs.forEach((install, idx) => {
    const label = installs.length > 1 ? `install#${idx + 1}: ` : '';
    if (HAS_NO_FROZEN.test(install)) {
      violations.push(`${label}forbidden: 使用 --no-frozen-lockfile（会静默改写 lockfile，破坏可复现构建）`);
    } else if (!HAS_FROZEN.test(install)) {
      violations.push(`${label}missing: pnpm install 缺 --frozen-lockfile`);
    }
    if (HAS_FROZEN_FALSE.test(install)) {
      violations.push(`${label}forbidden: --frozen-lockfile=false / 0（显式关闭 frozen）`);
    }
  });
  return violations;
}

const KNOWN_PARTICIPANTS = [
  'Dockerfile.alert-relay',
  'Dockerfile.api-gateway',
  'Dockerfile.config-service',
  'Dockerfile.currency-service',
  'Dockerfile.edge',
  'Dockerfile.game-service',
  'Dockerfile.payment-service',
  'Dockerfile.robot-service',
  'Dockerfile.room-service',
  'Dockerfile.user-service',
] as const;

function isParticipating(src: string): boolean {
  const lines = logicalLines(src);
  return (
    lines.some((line) => copiesPackageJson(line)) &&
    lines.some((line) => IS_RUN.test(line) && HAS_PNPM_INSTALL.test(line))
  );
}

describe('镜像依赖可复现闸：pnpm install 必须 --frozen-lockfile', () => {
  const dockerfiles = readdirSync(REPO)
    .filter((name) => name.startsWith('Dockerfile'))
    .sort();
  const participating = dockerfiles.filter((name) =>
    isParticipating(readFileSync(join(REPO, name), 'utf-8')),
  );

  it('哨兵（R179）：集合非空、参与集合恰好等于已知 10 个 node 镜像', () => {
    expect(dockerfiles.length).toBeGreaterThanOrEqual(7);
    expect(dockerfiles).toContain('Dockerfile.edge');
    expect(participating).toEqual([...KNOWN_PARTICIPANTS]);
  });

  it('消费端：所有参与 Dockerfile 的每一条 install 都是 --frozen-lockfile', () => {
    const violations: string[] = [];
    for (const name of dockerfiles) {
      for (const v of frozenViolations(readFileSync(join(REPO, name), 'utf-8'))) {
        violations.push(`${name}: ${v}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('判别力自证：no-frozen / 无 flag / 第二条 install / 变体 / 注释 / 续行 / 不参与者', () => {
    const base = 'FROM node:20-slim\nCOPY package.json ./\n';
    expect(frozenViolations(`${base}RUN pnpm install --frozen-lockfile\n`)).toEqual([]);
    expect(frozenViolations(`${base}run pnpm install --frozen-lockfile\n`)).toEqual([]);
    expect(frozenViolations(`${base}RUN pnpm install --no-frozen-lockfile\n`).length).toBe(1);
    expect(frozenViolations(`${base}RUN pnpm install --frozen-lockfile --no-frozen-lockfile\n`).length).toBe(1);
    expect(frozenViolations(`${base}RUN pnpm install --ignore-scripts\n`)[0]).toContain('missing');
    expect(frozenViolations(`${base}RUN pnpm install --frozen-lockfile=false\n`)[0]).toContain('forbidden');
    expect(frozenViolations(`${base}RUN pnpm install --config.frozen-lockfile=false\n`)[0]).toContain('forbidden');
    // 变体语法：pnpm --filter <pkg> install
    expect(
      frozenViolations(`${base}RUN pnpm --filter @fight-the-landlord/room-service install --no-frozen-lockfile\n`)
        .length,
    ).toBe(1);
    expect(
      frozenViolations(`${base}RUN pnpm --filter @fight-the-landlord/room-service install --frozen-lockfile\n`),
    ).toEqual([]);
    // 注释 / 续行 / 不参与
    expect(
      frozenViolations(`${base}# RUN pnpm install --frozen-lockfile\nRUN pnpm install --ignore-scripts\n`)[0],
    ).toContain('missing');
    expect(
      frozenViolations(
        `${base}RUN npm install -g pnpm@9.15.0 && pnpm install --ignore-scripts \\\n && cd node_modules/.pnpm/bcrypt@*/node_modules/bcrypt \\\n && ./node_modules/.bin/node-pre-gyp install\n`,
      )[0],
    ).toContain('missing');
    expect(
      frozenViolations(
        `${base}RUN npm install -g pnpm@9.15.0 && pnpm install --frozen-lockfile --ignore-scripts \\\n && cd node_modules/.pnpm/bcrypt@*/node_modules/bcrypt \\\n && ./node_modules/.bin/node-pre-gyp install\n`,
      ),
    ).toEqual([]);
    expect(frozenViolations('FROM node:20-alpine\nRUN echo hi\n')).toEqual([]);
    // H1：第二条 install 违规必须被抓住
    const secondNoFrozen = `${base}RUN pnpm install --frozen-lockfile\nRUN pnpm install --no-frozen-lockfile\n`;
    const v2 = frozenViolations(secondNoFrozen);
    expect(v2.length).toBe(1);
    expect(v2[0]).toContain('install#2');
    expect(
      frozenViolations(`${base}RUN pnpm install --frozen-lockfile\nRUN pnpm install --ignore-scripts\n`)[0],
    ).toContain('install#2');
    expect(
      frozenViolations(`${base}RUN pnpm install --frozen-lockfile\nRUN pnpm install --frozen-lockfile\n`),
    ).toEqual([]);
    // COPY 变体（--chown / JSON 数组）仍参与
    expect(frozenViolations('FROM node:20-slim\nCOPY --chown=node package.json ./\nRUN pnpm install --frozen-lockfile\n')).toEqual([]);
    expect(
      frozenViolations('FROM node:20-slim\nCOPY ["package.json", "./"]\nRUN pnpm install --frozen-lockfile\n'),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑门禁确认红**

```bash
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/shared test -- dockerfile-frozen
```

Expected: FAIL，10 个参与 Dockerfile 各报 `forbidden: 使用 --no-frozen-lockfile`。

- [ ] **Step 3: 改 10 个 Dockerfile 的 install flag 与注释**

用 Node 做**逐字节固定串替换**（不匹配就抛错）：

```bash
node -e '
const fs=require("fs");
const files=["Dockerfile.alert-relay","Dockerfile.api-gateway","Dockerfile.config-service","Dockerfile.currency-service","Dockerfile.edge","Dockerfile.game-service","Dockerfile.payment-service","Dockerfile.robot-service","Dockerfile.room-service","Dockerfile.user-service"];
const oldRun="RUN npm install -g pnpm@9.15.0 && pnpm install --no-frozen-lockfile --ignore-scripts";
const newComment="# --frozen-lockfile：容器只 COPY 所需 workspace 子集，pnpm 按盘上实际存在的包对账；\n# 同一 commit 的依赖解析必须与已提交 pnpm-lock.yaml 完全一致（no-frozen 会静默改写 lockfile，\n# 实测会装出不同的 peer 布局）。2026-10-28 复刻容器上下文实验通过。\n";
const newRun="RUN npm install -g pnpm@9.15.0 && pnpm install --frozen-lockfile --ignore-scripts";
for (const f of files){const p="D:/Code/ftl-eng-debt/"+f;let s=fs.readFileSync(p,"utf8");if(!s.includes(oldRun))throw new Error("run line missing: "+f);s=s.replace(oldRun,newRun);const idx=s.indexOf(newRun);s=s.slice(0,idx)+newComment+s.slice(idx);fs.writeFileSync(p,s);}
console.log("patched 10 Dockerfiles");
'
```

Expected: `patched 10 Dockerfiles`；每个 Dockerfile 的 RUN 上方出现 3 行注释。

- [ ] **Step 4: 跑门禁与全量 lint**

```bash
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/shared test -- dockerfile-frozen
pnpm --dir D:/Code/ftl-eng-debt exec turbo run lint --force
```

Expected: 门禁通过；`turbo lint` 30/30（Task 0 已修 TS2345）。

- [ ] **Step 5: 复跑安装上下文实验（room-service + edge 两个子集）与负对照**

```bash
mkdir -p D:/Code/ftl-exp
ROOT=D:/Code/ftl-eng-debt
# room-service 子集
EXP1=$(mktemp -d D:/Code/ftl-exp/v-final-room-XXXXXX)
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$ROOT/tsconfig.base.json" "$EXP1/"
for pkg in packages/test-utils packages/protocol packages/shared packages/room-service; do mkdir -p "$EXP1/$pkg" && cp "$ROOT/$pkg/package.json" "$EXP1/$pkg/"; done
( cd "$EXP1" && CI=true pnpm install --offline --ignore-scripts --frozen-lockfile ); echo "ROOM_FROZEN_EXIT=$?"
# 漂移负对照（同一 EXP1）
node -e "const f='$EXP1/packages/room-service/package.json';const j=require(f);j.dependencies['js-yaml']='4.3.2';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
( cd "$EXP1" && CI=true pnpm install --offline --ignore-scripts --frozen-lockfile ); echo "ROOM_DRIFT_EXIT=$?"
# edge 子集（apps/client 是最大 importer）
EXP2=$(mktemp -d D:/Code/ftl-exp/v-final-edge-XXXXXX)
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$ROOT/tsconfig.base.json" "$EXP2/"
for pkg in packages/test-utils packages/protocol packages/shared apps/client; do mkdir -p "$EXP2/$pkg" && cp "$ROOT/$pkg/package.json" "$EXP2/$pkg/"; done
( cd "$EXP2" && CI=true pnpm install --offline --ignore-scripts --frozen-lockfile ); echo "EDGE_FROZEN_EXIT=$?"
```

Expected: `ROOM_FROZEN_EXIT=0`；`ROOM_DRIFT_EXIT=1` 且输出含
`ERR_PNPM_OUTDATED_LOCKFILE`；`EDGE_FROZEN_EXIT=0`。
⚠️ `--offline` 依赖本机既有 pnpm store（本机已暖）。

- [ ] **Step 6: 回填 M7**

`docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md` 的 M7 条目追加：
「**2026-10-28 订正**：`--frozen-lockfile` 已在 10 个镜像 Dockerfile 落地（新闸
`dockerfile-frozen-lockfile.gate.test.ts`）；`node:20-slim` EOL 仍未处理。」

- [ ] **Step 7: 提交**

```bash
git -C D:/Code/ftl-eng-debt add -A
git -C D:/Code/ftl-eng-debt commit -m "chore(docker): 镜像安装改用 --frozen-lockfile

- 10 个 node 镜像 Dockerfile：no-frozen → frozen；实测当前 COPY 子集可直接通过
- 新增 dockerfile-frozen-lockfile 机械闸：遍历每一条 install 行（含 pnpm --filter 变体）
- 共享 dockerfile-scan 助手拼接续行、识别 --chown / JSON 数组 / --from 排除
- 复刻 room-service / edge 两个 COPY 子集验证 frozen；漂移负对照 ERR_PNPM_OUTDATED_LOCKFILE
- 回填 2026-09-24 edge 设计 M7：frozen 关闭，Node 20 EOL 仍开

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 死物清理（已批准范围）

**Files:**
- Delete: `test-game.ts`、`test-results/.last-run.json`、`scripts/dev-local.sh`、
  `scripts/integration-test.sh`
- Modify: `.gitignore`

- [ ] **Step 1: 删除前复核零引用**

```bash
rg --hidden -n "test-game|test-results|dev-local\.sh|integration-test\.sh" D:/Code/ftl-eng-debt \
  --glob '!node_modules/**' --glob '!.git/**' --glob '!docs/superpowers/**'
```

Expected: 只允许 `.dockerignore`、`tools/conformance/src/slices/slice-07.4-pipeline.ts`
的两处跳过清单、`docs/design.md` 的历史叙事、`scripts/integration-test.sh` 自身的头注释、
本计划与 spec 自述；不得有 package.json / workflow / 脚本调用。

- [ ] **Step 2: 删除并加 gitignore**

```bash
git -C D:/Code/ftl-eng-debt rm test-game.ts test-results/.last-run.json scripts/dev-local.sh scripts/integration-test.sh
```

`.gitignore` 在「工具产物」段追加：

```text
# Playwright/test-results 产物（test-results/.last-run.json 曾入库；失败状态不得跟仓库走）
test-results/
```

- [ ] **Step 3: 全量验证**

```bash
pnpm --dir D:/Code/ftl-eng-debt exec turbo run test lint --force
node D:/Code/ftl-eng-debt/scripts/verify-k8s-manifests.mjs
```

Expected: 测试 30/30、lint 30/30；k8s 闸通过。

- [ ] **Step 4: 提交**

```bash
git -C D:/Code/ftl-eng-debt add -A
git -C D:/Code/ftl-eng-debt commit -m "chore(repo): 清理死物（test-game / test-results / dev-local / integration-test）

- test-game.ts：playwright 非依赖、硬编码 /home/howe、被 browser-e2e 取代
- test-results/.last-run.json：Playwright 产物，入库只有陈旧 failed 状态
- dev-local.sh / integration-test.sh：零引用，已被 dev.sh / conformance 取代

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量验证 + 镜像 + 部署冒烟

- [ ] **Step 1: 本地全量（含 canonical CI 入口）**

```bash
pnpm --dir D:/Code/ftl-eng-debt exec turbo run lint build --force
pnpm --dir D:/Code/ftl-eng-debt exec turbo run test --force
pnpm --dir D:/Code/ftl-eng-debt --filter @fight-the-landlord/shared test:coverage
node D:/Code/ftl-eng-debt/scripts/verify-k8s-manifests.mjs
node D:/Code/ftl-eng-debt/scripts/verify-shutdown-hooks.mjs
node D:/Code/ftl-eng-debt/scripts/security/check-audit.mjs
# canonical 单一真源：六阶段 + 7/8 静态段（脚本末尾打印「八阶段全部通过」）
bash D:/Code/ftl-eng-debt/scripts/ci.sh
```

Expected: 全绿；coverage 行 ≥80%；audit gate exit 0；`ci.sh` 全部阶段通过。
⚠️ 本机 pnpm 安装会忽略 build scripts；若 `ci.sh` 的 install 段导致 user-service 的
bcrypt 二进制丢失，从主 worktree 复制同版本 N-API 二进制（仅 node_modules，不入库）。
⚠️ 若 stage 1 因默认 store 权限失败（worktree 无 `.pnpm-store`），用
`pnpm --dir D:/Code/ftl-eng-debt install --frozen-lockfile --store-dir D:/Code/fight-the-landlord/.pnpm-store`
预先填充；本机实测默认 store 可用。

- [ ] **Step 2: 工作区干净与提交清单**

```bash
git -C D:/Code/ftl-eng-debt status --porcelain
git -C D:/Code/ftl-eng-debt log --oneline dev..HEAD
```

Expected: 干净；5 个 commit（docs / Task 0 / B / A / 死物）。

- [ ] **Step 3: 推分支并打临时 tag（用户已批准）**

```bash
git -C D:/Code/ftl-eng-debt push origin chore/eng-debt
SHA=$(git -C D:/Code/ftl-eng-debt rev-parse --short=7 HEAD)
TAG="dev-$SHA"
git -C D:/Code/ftl-eng-debt tag "$TAG"
git -C D:/Code/ftl-eng-debt push origin "$TAG"
```

Expected: `dev-` 前缀只触发 images workflow。

- [ ] **Step 4: 等 images workflow 14/14**

```bash
TAG="dev-$(git -C D:/Code/ftl-eng-debt rev-parse --short=7 HEAD)"
SHA="$(git -C D:/Code/ftl-eng-debt rev-parse HEAD)"
RUN_ID=""
for _try in $(seq 1 20); do
  RUN_ID="$(gh run list --workflow=images.yml --limit 200 \
    --json databaseId,headBranch,headSha \
    --jq "[.[] | select(.headBranch == \"$TAG\" or .headSha == \"$SHA\")] | sort_by(.databaseId) | last | .databaseId // empty")"
  [ -n "$RUN_ID" ] && break
  sleep 6
done
test -n "$RUN_ID" || { echo "找不到 $TAG 的 images run"; exit 1; }
gh run watch "$RUN_ID" --exit-status
```

Expected: 成功；构建 14 个镜像。

- [ ] **Step 5: 部署测试服 + 冒烟**

```bash
# ⚠️ 从主工作区执行：`.env.deploy.local` 是 gitignored 的，只存在于主工作区。
# deploy.sh 从 tag 自身取 docker-compose.yml，不要求当前检出等于 tag。
TAG="dev-$(git -C D:/Code/ftl-eng-debt rev-parse --short=7 HEAD)"
bash D:/Code/fight-the-landlord/scripts/deploy/deploy.sh "$TAG"
```

Expected: `✅ [deploy] tag=... 部署完成`；随后钉 IP 复核：`/api/health` 200、
`/download/优比棋牌.apk` sha256 = Release 产物、`/admin/app.js` 与 tag 一致、
room-service 两条订阅在、`PUBSUB NUMSUB match:events game:events` = 1/1、
3 人实时探针（room.match → room.matched → game.deal）全收到（测试服 sameIp/sameDevice
开着，等待 ≥75s）。

- [ ] **Step 6: 交付报告**

报告：5 个 commit SHA、验证证据、镜像 run ID、部署 tag、冒烟结果、回滚目标
`dev-d064da1`、未做事项（Node20/digest/qs 等）。

---

## Self-Review

- [x] Spec §4.1–§4.5 全部映射到 Task 0–3。
- [x] 每个任务都有失败测试 → 实现 → 通过 → 提交。
- [x] 无 TBD / 占位符；门禁代码完整给出。
- [x] 类型/名称一致：`stalePatchesCopy`、`copiesPatches`、`copiesPackageJson`、
  `logicalLines`、`frozenViolations` 各只定义一次（共享 helper 除外）。
- [x] 设计审查 H1/L1–L7 与计划审查高-1/高-2/低-1–低-10 全部落进计划。
- [x] 不做清单与 Global Constraints 一致。

## 计划审查记录

### 2026-10-28 计划对抗审查（独立 reviewer）

结论：**无阻断；2 高 + 10 低**，全部处置。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 高-1 | 高 | frozen 闸只认字面 `pnpm install`，`pnpm --filter x install` 变体可绕过 | install 判定改为 `\bpnpm\b[^\n]*\binstall\b`；自证加变体样本 |
| 高-2 | 高 | patches 闸参与判定只认同一物理行；续行式 install 两侧静默跳过 | 抽共享 `logicalLines`（拼续行），两闸共用；自证加续行样本 |
| 低-1 | 低 | `git apply --check` 成功措辞不固定 | 判据改为退出码 0 |
| 低-2 | 低 | 实验父目录可能不存在 | 先 `mkdir -p D:/Code/ftl-exp`；注明依赖暖 store |
| 低-3 | 低 | worktree 无 `.pnpm-store`，`ci.sh` 可能 EACCES | 失败时用 `--store-dir` 指向主 worktree store；本机实测默认 store 可用 |
| 低-4 | 低 | 死物 `rg` 允许清单漏被删脚本自头注释 | 加入允许集 |
| 低-5 | 低 | `ci.sh` 阶段数说法 | 改为「六阶段 + 7/8 静态段」 |
| 低-6 | 低 | B 提交信息「5 份」与 6 份文档不符 | 改为 6 份 |
| 低-7 | 低 | 计划审查记录未填 | 本节即回填 |
| 低-8 | 低 | `--config.frozen-lockfile=false`、`--chown` 样本缺失 | 补自证样本；共享解析覆盖 `--chown` |
| 低-9 | 低 | 两闸解析器不对称 | 共享 `dockerfile-scan.ts`；`--from` 返回 null |
| 低-10 | 低 | `gh run list --limit 100` 可能截断 | 改 `--limit 200` 并按 headSha 匹配 |
