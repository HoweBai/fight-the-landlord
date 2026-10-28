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
    const noFrozen = HAS_NO_FROZEN.test(install);
    const frozenFalse = HAS_FROZEN_FALSE.test(install);
    if (noFrozen) {
      violations.push(`${label}forbidden: 使用 --no-frozen-lockfile（会静默改写 lockfile，破坏可复现构建）`);
    }
    if (frozenFalse) {
      violations.push(`${label}forbidden: --frozen-lockfile=false / 0（显式关闭 frozen）`);
    }
    if (!noFrozen && !frozenFalse && !HAS_FROZEN.test(install)) {
      violations.push(`${label}missing: pnpm install 缺 --frozen-lockfile`);
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
    expect(
      frozenViolations(
        'FROM node:20-slim\nCOPY --chown=node package.json ./\nRUN pnpm install --frozen-lockfile\n',
      ),
    ).toEqual([]);
    expect(
      frozenViolations('FROM node:20-slim\nCOPY ["package.json", "./"]\nRUN pnpm install --frozen-lockfile\n'),
    ).toEqual([]);
  });
});
