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
