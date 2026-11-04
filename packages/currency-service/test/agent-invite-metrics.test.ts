import { describe, expect, it } from 'vitest';
import { metricsRegistry } from '@fight-the-landlord/shared';
import { agentBindIgnoredTotal } from '../src/agent/agent.metrics';

describe('agent_bind_ignored_total', () => {
  it('注册到 shared registry，且按 reason 可累加', async () => {
    agentBindIgnoredTotal.inc({ reason: 'config_unavailable' });
    const metric = metricsRegistry().getSingleMetric('agent_bind_ignored_total') as {
      get: () => Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    };
    const snapshot = await metric.get();
    expect(
      snapshot.values.some((v) => v.labels.reason === 'config_unavailable' && v.value >= 1),
    ).toBe(true);
  });
});
