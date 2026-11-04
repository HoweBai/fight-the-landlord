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
 *  - 根上下文（`.` / `./`）的引用必须落在 `deploy/docker/` 下；
 *  - 每个引用必须是真实文件（`statSync(...).isFile()`）；
 *  - `deploy/docker/` 下每个 Dockerfile 必须被引用；
 *  - `deploy/docker/` 下不得出现无后缀 `Dockerfile`（`listDockerfiles` 的盲区）；
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

  it('deploy/docker 下不得出现无后缀 Dockerfile（listDockerfiles 盲区）', () => {
    const all = readdirSync(join(REPO, 'deploy', 'docker')).filter((name) =>
      name.startsWith('Dockerfile'),
    );
    expect(all.sort()).toEqual(listDockerfiles(REPO));
  });

  it('每个引用存在、位于 deploy/docker、且无孤儿 Dockerfile', () => {
    expect(composePathViolations(refs, dockerfiles, isFile)).toEqual([]);
  });
});
