import { metricsRegistry } from '@fight-the-landlord/shared';

export interface Series {
  labels: Record<string, string>;
  value: number;
}

/** registry 文本输出里的同名序列（`metric{...} value` / 无标签 `metric value`）。 */
export async function series(name: string): Promise<Series[]> {
  const text = await metricsRegistry().metrics();
  const out: Series[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(-?[\d.eE+]+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const kv of m[2].split(',')) {
        const eq = kv.indexOf('=');
        labels[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/^"|"$/g, '');
      }
    }
    out.push({ labels, value: Number(m[3]) });
  }
  return out;
}

/** 一条 labeled 序列的当前值（未出现过 ⇒ 0；game_type 默认 doudizhu）。 */
export async function counterValue(
  name: string,
  labels: Record<string, string>,
  gameType = 'doudizhu',
): Promise<number> {
  const want = { ...labels, game_type: gameType };
  const keys = Object.keys(want);
  const hit = (await series(name)).find(
    (s) => Object.keys(s.labels).length === keys.length && keys.every((k) => s.labels[k] === want[k]),
  );
  return hit?.value ?? 0;
}

/** 一个 counter 全部序列之和（可选按玩法过滤）。 */
export async function counterSum(name: string, gameType?: string): Promise<number> {
  return (await series(name))
    .filter((s) => gameType === undefined || s.labels.game_type === gameType)
    .reduce((acc, s) => acc + s.value, 0);
}
