/**
 * 监控片 T3：指标读数的测试助手（room 包内多个测试文件共用 —— 避免「同一读数三套写法」）。
 *
 * ⚠️ **不 import `prom-client`**：它不是 room-service 的依赖（指标在 shared 里构造）。
 * 这里只按**结构类型**读值（`get()` 的拍平形状），与 `trace-middleware` 的结构类型先例同族。
 */
export async function metricValue(metric: { get(): Promise<unknown> }): Promise<number> {
  const { values } = (await metric.get()) as { values: Array<{ value: number }> };
  return values[0]?.value ?? 0;
}

/** 带标签指标的读数：labels **全匹配**的那条序列；不存在 ⇒ `undefined`（区分「0」与「没有」）。 */
export async function labeledValue(
  metric: { get(): Promise<unknown> },
  labels: Record<string, string>,
): Promise<number | undefined> {
  const { values } = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return values.find((v) =>
    Object.entries(labels).every(([name, expected]) => String(v.labels[name]) === expected),
  )?.value;
}
