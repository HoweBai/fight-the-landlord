/**
 * **机械闸（假红④ 修复的镜像侧对账）**：根 `package.json` 的 `pnpm.patchedDependencies`
 * 一旦非空，则**每个 COPY 了根 `package.json` 的镜像 Dockerfile 必须 `COPY patches ./patches`**，
 * 且落点在它的 `pnpm install` RUN **之前**。
 *
 * ## 它守的是什么（2026-10-02 审查 Critical-1，发布阻断级）
 *
 * `pnpm.patchedDependencies`（假红④ 修复 = vitest 2.1.9 补丁）使**容器内** `pnpm install`
 * 必读 `patches/vitest@2.1.9.patch`（patch hash 计算即读文件）。而 7 个镜像 Dockerfile
 * 原先只 COPY `package.json` + `pnpm-lock.yaml` ⇒ install 直接 `ENOENT … patches/`
 * （复审沙箱实证）⇒ **下次 tag 的 images/release 与本机 `compose build` 全红**。
 * 漏一行 `COPY` 时**没有任何其他闸会红**（本机 ci 六阶段不构建镜像）—— 正是
 * 「发布门才红、且红在下游」的最贵形态 ⇒ 用这行机械闸把它提前到单测层。
 *
 * ## 判据（两端对账）
 *
 * ① 前提端：读根 `package.json` —— 每个 `patchedDependencies` 条目的 patch 文件**必须真实存在**；
 * ② 消费端：root `Dockerfile.*` 中**每个**出现 `COPY package.json` 的文件，必须在
 *    它的 `pnpm install` 之前出现 `COPY patches ./patches`；
 * ③ 哨兵（R179 型）：Dockerfile 集合必须非空且含已知成员（`Dockerfile.edge`），防 glob 失效恒绿；
 * ④ 前提为空（未配 patchedDependencies）时**不施加** COPY 要求（不把闸钉死在一次性修复上）。
 *
 * ## 判别力自证（R115 / R150）
 *
 * `checkDockerfile` 是纯函数：喂「漏 COPY」样本必红、喂「COPY 在 install 之后」样本必红、
 * 喂「不 COPY package.json 的 Dockerfile」（如 douzero 型）不参与、喂合规样本绿。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** 剥 Dockerfile 的整行注释（`#` 起头，含缩进）——注释里的 COPY/RUN 不得参与判据。 */
function stripDockerComments(src: string): string[] {
  return src
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const HAS_PACKAGE_JSON = /^COPY\s+package\.json\s/;
const HAS_PATCHES_COPY = /^COPY\s+patches\s+\.\/patches$/;
const HAS_PNPM_INSTALL = /\bpnpm install\b/;

/**
 * 纯函数：对**单个** Dockerfile 文本做判据 ②。
 * 返回违规列表（空 = 合规 / 不参与）。
 */
export function checkDockerfile(src: string): string[] {
  const lines = stripDockerComments(src);
  if (!lines.some((line) => HAS_PACKAGE_JSON.test(line))) {
    return []; // 不 COPY 根 package.json 的 Dockerfile 不参与（如 douzero 型，无 pnpm install 链路）
  }
  const installIdx = lines.findIndex((line) => HAS_PNPM_INSTALL.test(line));
  if (installIdx === -1) {
    return []; // 无 install ⇒ 不会读 patches（同样不参与）
  }
  const copyIdx = lines.findIndex((line) => HAS_PATCHES_COPY.test(line));
  if (copyIdx === -1) {
    return ['missing: 缺 `COPY patches ./patches`（容器内 pnpm install 会 ENOENT）'];
  }
  if (copyIdx > installIdx) {
    return [`after-install: \`COPY patches ./patches\` 在 pnpm install（第 ${installIdx + 1} 条有效指令）之后`];
  }
  return [];
}

describe('假红④镜像侧对账闸：patchedDependencies ⇒ 镜像 Dockerfile 必须 COPY patches', () => {
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
    expect(patched.length).toBeGreaterThan(0); // 假红④ 修复在位（若整条修复被回滚，这行会提醒复议本闸）
    for (const [name, path] of patched) {
      expect(existsSync(join(REPO, path)), `${name} → ${path} 不存在`).toBe(true);
    }
  });

  it('② 消费端：每个 COPY package.json 的镜像 Dockerfile 都在 install 前 COPY patches', () => {
    const violations: string[] = [];
    for (const name of dockerfiles) {
      for (const v of checkDockerfile(readFileSync(join(REPO, name), 'utf-8'))) {
        violations.push(`${name}: ${v}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('判别力自证：漏 COPY 必红 / COPY 在 install 之后必红 / 不参与者绿 / 合规样本绿', () => {
    // 正对照（合规）
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nCOPY patches ./patches\nRUN pnpm install --no-frozen-lockfile\n',
      ),
    ).toEqual([]);
    // 漏 COPY ⇒ 红
    expect(
      checkDockerfile('FROM node:20-slim\nCOPY package.json ./\nRUN pnpm install --no-frozen-lockfile\n').length,
    ).toBe(1);
    // COPY 在 install 之后 ⇒ 红
    expect(
      checkDockerfile(
        'FROM node:20-slim\nCOPY package.json ./\nRUN pnpm install --no-frozen-lockfile\nCOPY patches ./patches\n',
      )[0],
    ).toContain('after-install');
    // 不 COPY package.json（douzero 型）⇒ 不参与
    expect(
      checkDockerfile('FROM node:20-slim\nRUN pip install -r requirements.txt\nCOPY patches ./patches\n'),
    ).toEqual([]);
    // 注释行不算数（`# COPY patches ./patches` 不得冒充合规）
    expect(
      checkDockerfile('FROM node:20-slim\nCOPY package.json ./\n# COPY patches ./patches\nRUN pnpm install\n').length,
    ).toBe(1);
  });
});
