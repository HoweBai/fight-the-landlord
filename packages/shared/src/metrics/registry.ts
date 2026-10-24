import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * 监控片的 shared 地基（规格 §2.3）：**模块级单例注册表 + 强制同源的构造器**。
 *
 * ## 为什么所有指标必须经这里的 `createXxx()`
 *
 * prom-client 的构造器**不带 `registers` 时默认注册到 globalRegistry** —— 一旦有人
 * 直连 `new Gauge()`，指标会静默落进**另一个**注册表：`/metrics` 输出里看不到它，
 * 但**不会有任何报错**（单测里有一条反例专门钉这个行为）。因此本模块再导出三个
 * 构造器并**强制** `registers: [metricsRegistry()]`，T3–T6 的业务指标一律从这里走
 * —— 不提供任何直连 prom-client 的路径（C9④ 的 registry 同一性由此保证）。
 *
 * ## 为什么单例放在模块级
 *
 * 八个服务各自 `import '@fight-the-landlord/shared'` 一次（barrel 只求值一次），
 * 模块级单例在进程内天然唯一；指标名重复注册时 prom-client 会抛错（响亮），
 * 这比「两个注册表各持半边」的静默分裂好得多。
 *
 * ⚠️ `prom-client` 是本包**唯一**的外部运行时依赖（此前 logging 零依赖是「不需要」，
 * 指标必须有 client；版本精确钉死 `15.1.3` —— 受控升级，规格 §0 版本表）。
 */

let registry: Registry | undefined;

/** 进程级唯一注册表（八个服务的 `/metrics` 与 `initMetrics()` 都指向它）。 */
export function metricsRegistry(): Registry {
  return (registry ??= new Registry());
}

let defaultMetricsInitialized = false;

/**
 * 注册 prom-client 默认集（`process_*` / `nodejs_*`）。**幂等**：重复调用是空操作。
 *
 * ⚠️ 幂等**不能**指望 prom-client：第二次 `collectDefaultMetrics` 会对同名指标再注册
 * ⇒ 直接抛「A metric with the name … has already been registered」。标志位由我们自记。
 */
export function initMetrics(): void {
  if (defaultMetricsInitialized) return;
  collectDefaultMetrics({ register: metricsRegistry() });
  defaultMetricsInitialized = true;
}

/** 见文件头注释：强制 `registers: [metricsRegistry()]`，业务指标不可能落错注册表。
 *
 * ⚠️ **可选参数必须条件展开、不能写 `labelNames` 裸键**（T1 审查 🔴R1 实跑证据）：
 * prom-client 的 `Object.assign(defaults, config)` 合并语义下，显式 `undefined`
 * 会**覆盖**内部默认 `[]` ⇒ `reset()` 读 `labelNames.length` 即抛 —— 无标签指标
 * （§2.2 九个「—」行）会**模块加载即崩**。histogram 的 `buckets` 同理，且
 * **不能**写成 `buckets ?? []`（那会只剩 `+Inf` 一个桶）。
 */
export function createCounter(name: string, help: string, labelNames?: string[]): Counter {
  return new Counter({ name, help, registers: [metricsRegistry()], ...(labelNames === undefined ? {} : { labelNames }) });
}

/** 见文件头注释：强制 `registers: [metricsRegistry()]`；可选参数条件展开见上（R1）。 */
export function createGauge(name: string, help: string, labelNames?: string[]): Gauge {
  return new Gauge({ name, help, registers: [metricsRegistry()], ...(labelNames === undefined ? {} : { labelNames }) });
}

/** 见文件头注释：强制 `registers: [metricsRegistry()]`；`buckets` 省略时走 prom-client 默认桶（条件展开，R1）。 */
export function createHistogram(name: string, help: string, labelNames?: string[], buckets?: number[]): Histogram {
  return new Histogram({
    name,
    help,
    registers: [metricsRegistry()],
    ...(labelNames === undefined ? {} : { labelNames }),
    ...(buckets === undefined ? {} : { buckets }),
  });
}
