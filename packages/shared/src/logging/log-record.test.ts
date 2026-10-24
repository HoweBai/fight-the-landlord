import { describe, expect, it } from 'vitest';
import { buildLogRecord, LOG_FIELDS } from './log-record';

describe('buildLogRecord：恰好九字段（R1102）', () => {
  it('字段集**恰好**是 LOG_FIELDS（多一个都不行）', () => {
    const record = buildLogRecord({ level: 'log', service: 'room-service', context: 'X', msg: 'hi' });
    expect(Object.keys(record).sort()).toEqual([...LOG_FIELDS].sort());
    expect(LOG_FIELDS).toHaveLength(9);
  });

  it('无上下文 ⇒ 三个 id 都是 null 且 source 是 bootstrap', () => {
    const record = buildLogRecord({ level: 'warn', service: 's', context: 'C', msg: 'm' });
    expect(record.traceId).toBeNull();
    expect(record.reqId).toBeNull();
    expect(record.userId).toBeNull();
    expect(record.source).toBe('bootstrap');
  });

  it('有上下文 ⇒ 逐字填上（缺的字段填 null，不是 undefined）', () => {
    const record = buildLogRecord({
      level: 'error', service: 's', context: 'C', msg: 'm',
      ctx: { traceId: 'T', reqId: 'R', source: 'edge' },
    });
    expect(record.traceId).toBe('T');
    expect(record.reqId).toBe('R');
    expect(record.userId).toBeNull();
    expect(record.source).toBe('edge');
  });

  it('ts 是合法 ISO 字符串（不断言具体值 —— R914 的注入纪律）', () => {
    const record = buildLogRecord({ level: 'log', service: 's', context: 'C', msg: 'm' });
    expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
  });

  it('序列化后是一条合法 JSON（下游采集器据此解析）', () => {
    const line = JSON.stringify(buildLogRecord({ level: 'log', service: 's', context: 'C', msg: 'm' }));
    expect(JSON.parse(line)).toMatchObject({ level: 'log', msg: 'm' });
  });

  /**
   * **判据 13②**（最终评审 I1）：`reqId` 是**客户端可控**的一格（WS 消息自带）
   * ⇒ 记录里必须过 `redactText`。为什么必须有：
   *  - 客户端发 `reqId:"13912345678"` 就能让**判据 8**（S7 运行态泄敏采样，
   *    五个服务的真实 NDJSON 行逐行扫 10 类模式）报违例 —— 那是本片最关键的回归判据，
   *    而它偏偏有一条「只要客户端愿意就能打红」的路径；
   *  - JWT 形状同理（`reqId` 塞一张令牌）。
   * 脱敏后的形态取自 `redact.ts` 的既有规则（**不是**新规则）：手机号 ⇒ `139****5678`
   * （保留位数可读性）、JWT ⇒ `[REDACTED_JWT]`。
   */
  it('判据 13②：`reqId` 里的手机号 / JWT 形状串必须被脱敏（客户端可控的一格不得原样落盘）', () => {
    const phone = buildLogRecord({
      level: 'log', service: 's', context: 'C', msg: 'm',
      ctx: { traceId: null, reqId: '13912345678', source: 'edge' },
    });
    expect(phone.reqId).toBe('139****5678');

    const jwt = buildLogRecord({
      level: 'log', service: 's', context: 'C', msg: 'm',
      ctx: { traceId: null, reqId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abcdefgh', source: 'edge' },
    });
    expect(jwt.reqId).toBe('[REDACTED_JWT]');

    // 判据 8 的两个模式（原文见 `tools/conformance/src/slices/slice-12-manual-join.ts`）
    // 对**整行**都不得命中 —— 这才真正排除「采样被打红」这条路。
    for (const record of [phone, jwt]) {
      const line = JSON.stringify(record);
      expect(line).not.toMatch(/\b1[3-9]\d{9}\b/);
      expect(line).not.toMatch(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/);
    }
  });

  /**
   * 判据 13② 的**负对照**（同一纪律：脱敏不得误伤正常 reqId）。
   *
   * 客户端生成的 `reqId` 常态是 uuid / 短随机串 —— 它们必须**逐字**保留，
   * 否则「这条 reqId 为什么被拒」这条排障线会当场断掉（`Rejected malformed client
   * message` 那一行正是靠它定位）。
   */
  it('判据 13② 负对照：正常 `reqId`（uuid 形状）逐字不变', () => {
    const id = '3f2b9c1e-77aa-4d0f-9b1c-2e5a8d0c4f11';
    const record = buildLogRecord({
      level: 'log', service: 's', context: 'C', msg: 'm',
      ctx: { traceId: null, reqId: id, source: 'edge' },
    });
    expect(record.reqId).toBe(id);
  });
});
