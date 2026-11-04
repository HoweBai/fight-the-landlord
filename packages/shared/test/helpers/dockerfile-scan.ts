import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Dockerfile 扫描的共享纯函数（**测试侧**，不参与运行时）。
 *
 * 三个机械闸 + compose 路径闸共用：
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
  let sawBuild = false;
  let context = '.';
  let dockerfile = 'Dockerfile';

  const flush = (): void => {
    // ⚠️ 判 push 用 sawBuild，不用 inBuild：build 块后的第一个 4 空格子键
    // （image/restart/environment…）就会把 inBuild 清掉，若用它判 push，
    // block 写法会在 flush 前全部丢失（实测真实 compose ⇒ 0 条）。
    if (service !== null && sawBuild) refs.push({ service, context, dockerfile });
    inBuild = false;
    sawBuild = false;
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
      sawBuild = true;
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
 * 判据：① 根上下文（`.` 或 `./`）的引用必须落在 `deploy/docker/` 下；② 每个引用必须是真实文件；
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
    const ctx = toPosixPath(ref.context);
    const isRootContext = ctx === '' || ctx === '.';
    referenced.add(rel);
    if (isRootContext && !rel.startsWith(`${DOCKERFILE_DIR}/`)) {
      violations.push(
        `${ref.service}: 根上下文的 dockerfile 必须位于 ${DOCKERFILE_DIR}/ 下（实际 ${rel}）`,
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
