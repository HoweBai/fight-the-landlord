import { describe, it, expect } from 'vitest';
import { createRedactingLogger } from './redacting-logger';
import { LOG_FIELDS } from './log-record';
import { createCapturingSink } from './capturing-sink';
import { runWithTrace } from './trace-context';

describe('createRedactingLogger（R142：Nest 适配层在 shared，但不依赖 Nest）', () => {
  /**
   * R1102：sink 收到的是一条**九字段记录**（不再是 `(level, line)` 两参）。
   * 判据"这条日志带没带上上下文"因此可以直接断言字段，不必抓 stdout。
   */
  const install = () => {
    const { sink, records } = createCapturingSink();
    return { logger: createRedactingLogger(sink, { service: 'room-service' }), records };
  };

  it('五个级别都脱敏，并把 context（Nest 的最后一个可选参）放进记录的 context 字段', () => {
    const { logger, records } = install();

    logger.log('login phone=13812341234', 'AuthService');
    logger.error('hand=[3,4,5]', 'GameService');

    expect(records).toMatchObject([
      { level: 'log', context: 'AuthService', msg: 'login phone=138****1234' },
      { level: 'error', context: 'GameService', msg: 'hand="[REDACTED 3 cards]"' },
    ]);
  });

  it('非字符串参数（对象/数组）先经过 redactValue 再序列化', () => {
    const { logger, records } = install();
    logger.warn({ password: 'pw', hand: [1, 2] }, 'X');
    const { context, msg } = records[0]!;
    expect(context).toBe('X');
    expect(msg).not.toContain('pw');
    expect(msg).toContain('[REDACTED');
  });

  /**
   * R148（协调者在 Nest 10.4.22 源码里核对出的真 bug）：
   *
   * ```js
   * // @nestjs/common/services/logger.service.js
   * static overrideLogger(logger) {
   *   if (Array.isArray(logger)) { Logger.logLevels = logger; return this.staticInstanceRef?.setLogLevels(logger); }
   *   ...
   * }
   * ```
   *
   * `NestFactory.create(AppModule, { logger: ['error','warn','log'] })` 会走到
   * `registerLoggerConfiguration()` → `Logger.overrideLogger([...])`，而
   * `staticInstanceRef` 此刻**已经是我们这个自定义 logger** ⇒ 没有
   * `setLogLevels` 就是 `TypeError: this.staticInstanceRef.setLogLevels is not a function`
   * ⇒ **网关启动即崩**（五个服务里只有 api-gateway 传了 `logger` 数组）。
   */
  it('R148: 缺 setLogLevels 会让 Nest 启动崩（NestFactory.create 传 logger 数组时无条件调用它）', () => {
    const { logger, records } = install();

    // 不抛 = 可以安全地先 overrideLogger 再 create({ logger: [...] })
    expect(() => logger.setLogLevels(['error'])).not.toThrow();

    logger.log('should be filtered out');
    logger.error('kept phone=13812341234');
    expect(records.map((r) => r.msg)).toEqual(['kept phone=138****1234']);
  });

  it('R148: error(message) 只有 context 时不留尾随空格（Nest 会补一个 undefined 占位）', () => {
    const { logger, records } = install();
    logger.error('boom', undefined, 'Svc');
    expect(records).toHaveLength(1);
    expect(records[0]!.context).toBe('Svc');
    expect(records[0]!.msg).toBe('boom');
  });

  it('R148: fatal 也是合法级别，并映射到 sink（Nest 的日志器会调它）', () => {
    const { logger, records } = install();

    logger.fatal('x-internal-token: secret-value', 'Bootstrap');

    expect(records).toMatchObject([
      { level: 'fatal', context: 'Bootstrap', msg: 'x-internal-token: [REDACTED]' },
    ]);
  });

  it('R148: setLogLevels 之后按级别过滤（含 fatal；不传级别时全部放行）', () => {
    const { logger, records } = install();

    logger.setLogLevels(['fatal', 'warn']);
    logger.verbose('no');
    logger.debug('no');
    logger.log('no');
    logger.warn('yes');
    logger.error('no');
    logger.fatal('yes');

    expect(records.map((r) => r.msg)).toEqual(['yes', 'yes']);
  });

  it('多参拼接：message + 额外参数都在同一个 msg 里（且每个字符串各自脱敏）', () => {
    const { logger, records } = install();
    logger.log('a', 'x-internal-token: s3cret', 42);

    expect(records[0]!.msg).toBe('a x-internal-token: [REDACTED] 42');
  });

  // 判据 1：合法 JSON + 恰好九字段 + level/context/service
  // （同一条断言里的 `traceId: null` / `source: 'bootstrap'` 就是判据 2 的**负对照**：
  //   无 ALS 时不编造 id —— R1107）
  it('输出是一条合法 JSON 且字段恰好九个（R1102）', () => {
    const { logger, records } = install();
    logger.log('hello', 'MyCtx');
    expect(Object.keys(records[0]!).sort()).toEqual([...LOG_FIELDS].sort());
    expect(JSON.parse(JSON.stringify(records[0]!))).toMatchObject({
      level: 'log', service: 'room-service', context: 'MyCtx', msg: 'hello', traceId: null, source: 'bootstrap',
    });
  });

  // 判据 2：ALS 有值 ⇒ 填上；无值 ⇒ null + bootstrap（上面那条已是负对照）
  it('ALS 有值 ⇒ 三个 id 与 source 逐字填上', () => {
    const { logger, records } = install();
    runWithTrace({ traceId: 'T', reqId: 'R', userId: 'U', source: 'edge' }, () => logger.warn('w', 'C'));
    expect(records[0]).toMatchObject({ traceId: 'T', reqId: 'R', userId: 'U', source: 'edge' });
  });

  // 判据 2′：读取时机 —— 同一 logger 连发两条、中间换上下文 ⇒ 必须不同
  it('同一 logger 实例连发两条、中间换 ALS ⇒ 两行的 traceId 必须不同（构造期缓存即红）', () => {
    const { logger, records } = install();
    runWithTrace({ traceId: 'A', source: 'edge' }, () => logger.log('one', 'C'));
    runWithTrace({ traceId: 'B', source: 'edge' }, () => logger.log('two', 'C'));
    expect([records[0]!.traceId, records[1]!.traceId]).toEqual(['A', 'B']);
  });

  // 判据 3：顺序闸 —— 字符串参数里内嵌 JSON 的 password 也必须被脱敏
  it('字符串参数里内嵌的 JSON 里的 password 必须脱敏（钉住「先脱敏后序列化」）', () => {
    const { logger, records } = install();
    logger.log('body={"password":"pw","hand":[{"r":3,"s":0}]}', 'C');
    const line = JSON.stringify(records[0]);
    expect(line).not.toContain('pw');
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('"s":0'); // 手牌类键整体换占位
  });
});
