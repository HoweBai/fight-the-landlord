import { describe, expect, it } from 'vitest';
import { metricsRegistry } from '@fight-the-landlord/shared';
import { userRegistrationFailuresTotal } from '../src/metrics/player.metrics';

describe('user_registration_failures_total', () => {
  it('注册到 shared registry，且按 reason 可累加', async () => {
    userRegistrationFailuresTotal.inc({ reason: 'invite_missing' });
    const metric = metricsRegistry().getSingleMetric('user_registration_failures_total') as {
      get: () => Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    };
    const snapshot = await metric.get();
    expect(
      snapshot.values.some((v) => v.labels.reason === 'invite_missing' && v.value >= 1),
    ).toBe(true);
  });
});
