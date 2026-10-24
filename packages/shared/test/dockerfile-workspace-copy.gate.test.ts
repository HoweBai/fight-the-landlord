/**
 * **机械闸（镜像侧 workspace 依赖对账）**：Dockerfile 里 `COPY` 的每个工作区包，
 * 其 `package.json` 以 `workspace:` 协议声明的每个依赖（含 **devDependencies**），
 * **必须**也被 `COPY` 进构建上下文（且在该文件的 `pnpm install` **之前**）。
 *
 * ## 它守的是什么（与 `dockerfile-patches-copy.gate.test.ts` 同族）
 *
 * 镜像里 `pnpm install --no-frozen-lockfile` 要解析**每个在盘的包**的 `workspace:*` 引用；
 * 依赖包目录不在构建上下文里 ⇒ install 直接失败（`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 类），
 * 而**本机 ci 六阶段不构建镜像** ⇒ 漏一行 COPY 不会有任何其他闸红 —— 又是
 * 「发布门才红、且红在下游」的最贵形态。本批（台账 N46）新增了 `packages/test-utils`
 * （dev-only）被 6 个包以 `workspace:*` 引用 ⇒ 7 个 Dockerfile 全部需要 `COPY` 它，
 * 于是把这条约束做成对账闸（2026-10-02）。
 *
 * ## 判据（对每个 `Dockerfile.*`）
 *
 *  - 「参与」= 同时有 `COPY package.json` 与 `pnpm install`（douzero 型不参与）；
 *  - 对 `COPY` 到的每个 `packages|apps|tools/<pkg>`（以及根 `package.json`），
 *    其 deps + devDeps 里 `workspace:` 开头的条目：① 指向的包必须在工作区存在；
 *    ② 必须被本 Dockerfile `COPY`；③ 该 `COPY` 必须在 `pnpm install` 之前。
 *
 * ## 判别力自证（R115 / R150）
 *
 * `workspaceCopyViolations` 是纯函数：喂「漏 COPY」必红、喂「COPY 在 install 之后」必红、
 * 喂「注释里的 COPY」不算数、喂「不 COPY 根 package.json」不参与、喂合规样本绿。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 从本文件所在目录向上找仓库根（锚 = `packages/shared` + `packages/protocol`；找不到抛错）。 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
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

interface DepRef {
  name: string;
  spec: string;
}

/**
 * 纯函数：对**单个** Dockerfile 文本做判据 ①②③。
 * `depsOf(dir)`：读某包（`.` = 根）的 deps + devDeps；`dirOf(name)`：包名 → 工作区目录。
 * 返回违规列表（空 = 合规 / 不参与）。
 */
export function workspaceCopyViolations(
  dockerfile: string,
  depsOf: (dir: string) => DepRef[],
  dirOf: (name: string) => string | null,
): string[] {
  const lines = dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  // 不参与：无 install（不会解析任何 workspace 依赖）
  const installIdx = lines.findIndex((line) => /\bpnpm install\b/.test(line));
  if (installIdx === -1) return [];
  // 不参与：不 COPY 根 package.json（如 douzero 型 —— 没有本仓的 install 链路）
  if (!lines.some((line) => /^COPY\s+package\.json\s/.test(line))) return [];

  /** 被 COPY 的工作区目录 → 该 COPY 所在行号（后出现的覆盖先出现的——取最后一次 COPY）。 */
  const copiedAt = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^COPY\s+((?:packages|apps|tools)\/[A-Za-z0-9_-]+)\/?\s/.exec(lines[i]);
    if (m !== null) copiedAt.set(m[1]!, i);
  }

  const violations: string[] = [];
  const check = (dir: string): void => {
    for (const dep of depsOf(dir)) {
      if (!dep.spec.startsWith('workspace:')) continue;
      const target = dirOf(dep.name);
      if (target === null) {
        violations.push(`${dir} 依赖 ${dep.name}（workspace:）但工作区里不存在这个包`);
        continue;
      }
      const at = copiedAt.get(target);
      if (at === undefined) {
        violations.push(
          `${dir} 依赖 ${dep.name}（workspace:）⇒ 必须 COPY ${target}（否则容器内 pnpm install 解析不到）`,
        );
        continue;
      }
      if (at > installIdx) {
        violations.push(
          `COPY ${target} 出现在 pnpm install 之后（第 ${at + 1} 行 vs 第 ${installIdx + 1} 行）`,
        );
      }
    }
  };

  check('.'); // 根 package.json（`COPY package.json` 必在 —— 上面已判）
  for (const dir of copiedAt.keys()) check(dir);
  return violations;
}

/** 工作区包名 → 目录（`packages/*`、`apps/*`、`tools/*` 的 package.json）。 */
function workspacePackages(): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of ['packages', 'apps', 'tools'] as const) {
    let entries: string[];
    try {
      entries = readdirSync(join(REPO, group));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pj = join(REPO, group, entry, 'package.json');
      if (!existsSync(pj)) continue;
      const name = (JSON.parse(readFileSync(pj, 'utf-8')) as { name?: string }).name;
      if (typeof name === 'string') map.set(name, `${group}/${entry}`);
    }
  }
  return map;
}

const DIR_OF = workspacePackages();

/** 读某包（`.` = 根）的 deps + devDeps（真源 = 磁盘上的 package.json）。 */
function depsOfDir(dir: string): DepRef[] {
  const pj = dir === '.' ? join(REPO, 'package.json') : join(REPO, ...dir.split('/'), 'package.json');
  const json = JSON.parse(readFileSync(pj, 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.entries({ ...json.dependencies, ...json.devDependencies }).map(([name, spec]) => ({
    name,
    spec,
  }));
}

const dirOfName = (name: string): string | null => DIR_OF.get(name) ?? null;

describe('镜像侧 workspace 依赖对账闸：COPY 到的包，其 workspace 依赖必须也被 COPY', () => {
  const dockerfiles = readdirSync(REPO)
    .filter((name) => name.startsWith('Dockerfile.'))
    .sort();

  it('哨兵（R179）：Dockerfile 集合非空且含已知成员（防 glob 失效恒绿）', () => {
    expect(dockerfiles.length).toBeGreaterThanOrEqual(7);
    expect(dockerfiles).toContain('Dockerfile.edge');
    expect(dockerfiles).toContain('Dockerfile.user-service');
    // 工作区包表也必须有已知成员（防 DIR_OF 静默变空 ⇒ 判据全变「不参与」）
    expect([...DIR_OF.keys()]).toEqual(
      expect.arrayContaining([
        '@fight-the-landlord/test-utils',
        '@fight-the-landlord/protocol',
        '@fight-the-landlord/shared',
      ]),
    );
    // 台账 N46 的已知约束成员：user-service 的 Dockerfile 必须给 test-utils 一行 COPY
    const us = readFileSync(join(REPO, 'Dockerfile.user-service'), 'utf-8');
    expect(us).toContain('COPY packages/test-utils');
  });

  it('消费端：每个 Dockerfile 的 workspace 依赖都在 install 之前被 COPY', () => {
    const violations: string[] = [];
    for (const name of dockerfiles) {
      for (const v of workspaceCopyViolations(
        readFileSync(join(REPO, name), 'utf-8'),
        depsOfDir,
        dirOfName,
      )) {
        violations.push(`${name}: ${v}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('判别力自证：漏 COPY 必红 / COPY 在 install 之后必红 / 注释不算数 / 不参与者绿 / 合规绿', () => {
    const depsOf = (dir: string): DepRef[] =>
      dir === 'packages/user-service'
        ? [
            { name: '@fight-the-landlord/test-utils', spec: 'workspace:*' },
            { name: 'express', spec: '^4.21.0' },
          ]
        : [];
    const dirOf = (name: string): string | null =>
      name === '@fight-the-landlord/test-utils' ? 'packages/test-utils' : null;

    // 合规（正对照）
    expect(
      workspaceCopyViolations(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY packages/test-utils ./packages/test-utils\nCOPY packages/user-service ./packages/user-service\nRUN pnpm install --no-frozen-lockfile\n',
        depsOf,
        dirOf,
      ),
    ).toEqual([]);
    // 漏 COPY test-utils ⇒ 红，且报出缺的是哪个包
    const missing = workspaceCopyViolations(
      'FROM node:20-slim\nCOPY package.json ./\nCOPY packages/user-service ./packages/user-service\nRUN pnpm install --no-frozen-lockfile\n',
      depsOf,
      dirOf,
    );
    expect(missing.length).toBe(1);
    expect(missing[0]).toContain('packages/test-utils');
    // COPY 在 install 之后 ⇒ 红（顺序也是判据）
    const late = workspaceCopyViolations(
      'FROM node:20-slim\nCOPY package.json ./\nCOPY packages/user-service ./packages/user-service\nRUN pnpm install --no-frozen-lockfile\nCOPY packages/test-utils ./packages/test-utils\n',
      depsOf,
      dirOf,
    );
    expect(late[0]).toContain('pnpm install 之后');
    // 注释里的 COPY 不算数
    const commented = workspaceCopyViolations(
      'FROM node:20-slim\nCOPY package.json ./\n# COPY packages/test-utils ./packages/test-utils\nCOPY packages/user-service ./packages/user-service\nRUN pnpm install\n',
      depsOf,
      dirOf,
    );
    expect(commented.length).toBe(1);
    // 不 COPY 根 package.json ⇒ 不参与（douzero 型：没有本仓 install 链路；
    // ⚠️ 样本里**特意**给了 pnpm install，确保命中的是「不参与」这一支、而不是「无 install」那一支）
    expect(
      workspaceCopyViolations(
        'FROM node:20-slim\nRUN pnpm install --no-frozen-lockfile\n',
        () => [{ name: '@fight-the-landlord/test-utils', spec: 'workspace:*' }],
        dirOf,
      ),
    ).toEqual([]);
    // workspace 依赖在工作区里根本不存在 ⇒ 红（不是「跳过」）
    const unknown = workspaceCopyViolations(
      'FROM node:20-slim\nCOPY package.json ./\nRUN pnpm install\n',
      () => [{ name: '@fight-the-landlord/ghost', spec: 'workspace:*' }],
      dirOf,
    );
    expect(unknown[0]).toContain('工作区里不存在');
  });
});
