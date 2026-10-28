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
