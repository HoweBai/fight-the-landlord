import { spawnSync } from 'node:child_process';

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** 解析 Prometheus 文本格式（只取样本行；HELP/TYPE 行跳过）。 */
export function parseProm(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? ([-+0-9.eE]+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(part);
        if (kv) labels[kv[1]!] = kv[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    const value = Number(m[3]);
    out.push({ name: m[1]!, labels, value: Number.isFinite(value) ? value : NaN });
  }
  return out;
}

/** 标签集**完全相等**才命中；不存在/多条 ⇒ null / 抛错。 */
export function seriesValueExact(
  text: string,
  name: string,
  want: Record<string, string>,
): number | null {
  const hits = parseProm(text).filter(
    (s) =>
      s.name === name &&
      Object.keys(s.labels).sort().join('\u0000') === Object.keys(want).sort().join('\u0000') &&
      Object.entries(want).every(([k, v]) => s.labels[k] === v),
  );
  if (hits.length > 1) throw new Error(`seriesValueExact 命中多条 ${name} ${JSON.stringify(want)}`);
  return hits[0]?.value ?? null;
}

/** 某指标全部序列之和（缺席 = 0）。 */
export function sumMetric(text: string, name: string): number {
  return parseProm(text)
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (Number.isFinite(s.value) ? s.value : 0), 0);
}

/** 容器内 `curl /metrics`（Bearer 守卫；与 slice-16 同法）。 */
export function execCurl(
  container: string,
  port: number,
  token: string,
  path = '/metrics',
): { status: number; body: string } {
  const out = spawnSync(
    'docker',
    [
      'exec', container, 'curl', '-s', '-w', '\n__STATUS__%{http_code}',
      '-H', `Authorization: Bearer ${token}`,
      `http://127.0.0.1:${port}${path}`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const stdout = out.stdout ?? '';
  const m = /__STATUS__(\d+)\s*$/.exec(stdout);
  return { status: m ? Number(m[1]) : 0, body: stdout.replace(/__STATUS__\d+\s*$/, '') };
}
