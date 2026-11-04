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

  it('名为 Dockerfile.* 的目录不算（只认真实文件）', () => {
    const repo = mkRepo();
    const dir = join(repo, 'deploy', 'docker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Dockerfile.a'), 'FROM scratch\n');
    mkdirSync(join(dir, 'Dockerfile.dir'));
    expect(listDockerfiles(repo)).toEqual(['Dockerfile.a']);
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

  it('相邻两个 block 服务各自成 ref（sawBuild 必须复位）', () => {
    const src = [
      'services:',
      '  a:',
      '    build:',
      '      context: .',
      '      dockerfile: deploy/docker/Dockerfile.a',
      '    image: a',
      '  b:',
      '    build:',
      '      context: .',
      '      dockerfile: deploy/docker/Dockerfile.b',
      '    image: b',
    ].join('\n');
    expect(composeBuildRefs(src)).toEqual([
      { service: 'a', context: '.', dockerfile: 'deploy/docker/Dockerfile.a' },
      { service: 'b', context: '.', dockerfile: 'deploy/docker/Dockerfile.b' },
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

  it('context=./ 与 . 同判（不得绕过目录约定）', () => {
    const ref = { service: 'x', context: './', dockerfile: 'Dockerfile.x' };
    const v = composePathViolations([ref], [], () => true);
    expect(v.join('\n')).toContain('必须位于 deploy/docker/');
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
