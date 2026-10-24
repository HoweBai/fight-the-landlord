import { describe, expect, it } from 'vitest';
import { Gauge, register } from 'prom-client';
import { createCounter, createGauge, createHistogram, initMetrics, metricsRegistry } from './registry';

/**
 * C9 单测半边之「registry 同一性」：`createXxx()` 再导出构造器**强制**
 * `registers: [metricsRegistry()]` —— 业务指标不可能静默落到别处（globalRegistry）。
 *
 * ⚠️ 本文件与实现共享同一个模块级单例（vitest 默认按文件隔离模块图）⇒ 各用例可
 * 放心读 `metricsRegistry().metrics()` 的**全量**输出；指标名都带 test_ 前缀防撞。
 */
describe('metricsRegistry / initMetrics / 构造器再导出（C9③④）', () => {
  it('同一性：任何时刻调用都是同一个注册表实例（模块级单例）', () => {
    expect(metricsRegistry()).toBe(metricsRegistry());
  });

  it('C9④：createGauge() 造的指标出现在 metricsRegistry().metrics() 输出里', async () => {
    const gauge = createGauge('test_forced_gauge', '构造器强制 registers 的证明', ['who']);
    gauge.set({ who: 'me' }, 3);
    const text = await metricsRegistry().metrics();
    expect(text).toMatch(/^test_forced_gauge\{who="me"\} 3$/m);
  });

  it('C9④：createCounter()/createHistogram() 同样落本 registry（三个构造器同一份强制）', async () => {
    const counter = createCounter('test_forced_counter', 'h', ['k']);
    counter.inc({ k: 'v' });
    const histogram = createHistogram('test_forced_histogram', 'h', ['k'], [0.1, 1]);
    histogram.observe({ k: 'v' }, 0.5);
    const text = await metricsRegistry().metrics();
    expect(text).toContain('test_forced_counter{k="v"} 1');
    // 0.5 落在 (0.1, 1] ⇒ le="0.1" 桶 0、le="1" 桶 1（桶边界语义顺带钉住）
    expect(text).toMatch(/^test_forced_histogram_bucket\{[^}]*le="0\.1"[^}]*\} 0$/m);
    expect(text).toMatch(/^test_forced_histogram_bucket\{[^}]*le="1"[^}]*\} 1$/m);
    expect(text).toContain('test_forced_histogram_count{k="v"} 1');
  });

  it('C9④ 反例：直连 new Gauge() 落**别处**（globalRegistry），不落本 registry —— 证明强制是必要的', async () => {
    const rogue = new Gauge({ name: 'test_rogue_gauge', help: '不落本注册表' });
    rogue.set(7);
    const text = await metricsRegistry().metrics();
    expect(text).not.toContain('test_rogue_gauge');
    // 反向自证：它不是「没注册」，而是落进了 globalRegistry —— 负例针对的是**落错地方**
    expect(await register.metrics()).toContain('test_rogue_gauge');
  });

  it('C9③：initMetrics() 幂等 —— 两次调用默认指标条数不翻倍（且确实注册了默认集）', async () => {
    const helpLines = async () => (await metricsRegistry().metrics()).split('\n').filter((l) => l.startsWith('# HELP ')).length;
    initMetrics();
    const once = await helpLines();
    expect(once).toBeGreaterThan(0);
    initMetrics();
    expect(await helpLines()).toBe(once);
  });

  it('initMetrics() 覆盖默认集：process_* 至少一条（体量最小的事实断言）', async () => {
    initMetrics();
    const text = await metricsRegistry().metrics();
    expect(text).toContain('# HELP process_cpu_seconds_total');
  });

  // ── R1 回归（T1 审查🔴：可选参数显式 undefined 覆盖 prom-client 默认值 ⇒ 加载即崩）──
  // 这两例模拟的是**下一任务最可能写的调用形态**（§2.2 九个无标签指标）——旧实现下模块加载即抛。
  it('R1 回归：三构造器仅传 (name, help) ⇒ 可构造、可写、可读（无标签指标）', async () => {
    const counter = createCounter('test_bare_counter', 'h');
    counter.inc();
    const gauge = createGauge('test_bare_gauge', 'h');
    gauge.set(2);
    const histogram = createHistogram('test_bare_histogram', 'h');
    histogram.observe(0.05);
    const text = await metricsRegistry().metrics();
    expect(text).toMatch(/^test_bare_counter 1$/m);
    expect(text).toMatch(/^test_bare_gauge 2$/m);
    expect(text).toMatch(/^test_bare_histogram_count [\d.]+$/m);
  });

  it('R1 回归：createHistogram(name, help, ["k"])（省略 buckets）⇒ 走 prom-client 默认 11 桶（含 le="10"）', async () => {
    const histogram = createHistogram('test_default_buckets_histogram', 'h', ['k']);
    histogram.observe({ k: 'v' }, 0.05);
    const text = await metricsRegistry().metrics();
    // ⚠️ 反例方向：若把省略写成 `buckets ?? []`，桶只剩 +Inf —— 这条断言会把它逮住
    expect(text).toMatch(/le="10"/);
  });
});
