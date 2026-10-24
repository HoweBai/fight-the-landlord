import { describe, expect, it } from 'vitest';
import { buildLogRecord } from './log-record';
import { createCapturingSink } from './capturing-sink';

describe('createCapturingSink', () => {
  it('按到达顺序留下记录（正对照：捕获真的发生）', () => {
    const { sink, records } = createCapturingSink();
    sink(buildLogRecord({ level: 'log', service: 's', context: 'C', msg: 'a' }));
    sink(buildLogRecord({ level: 'warn', service: 's', context: 'C', msg: 'b' }));
    expect(records.map((r) => r.msg)).toEqual(['a', 'b']);
  });
});
