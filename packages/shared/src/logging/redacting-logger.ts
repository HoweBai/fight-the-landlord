import { redactText, redactValue } from './redact';
import { buildLogRecord, type LogRecord } from './log-record';
import { currentTrace } from './trace-context';

/**
 * 日志级别。`fatal` 是 **Nest 的 `LoggerService` 接口的一部分**
 * （`logger.service.d.ts` 的 `fatal?(message: any, ...optionalParams: any[]): any`），
 * 所以我们的自定义 logger 必须能接住它（R148）。
 */
export type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/** ⚠️ 收到的是**记录**（不是一行文本）：`service` 与 id 三件套由它带出去。 */
export interface LogSink {
  (record: LogRecord): void;
}

/**
 * 结构化类型即可满足 Nest 的 `LoggerService`（各服务 `main.ts` 传给
 * `Logger.overrideLogger`）。**刻意不 import `@nestjs/common`**：Nest 的接口是
 * 结构类型，由**服务侧**（那里有 @nestjs/common）做类型检查，shared 侧保持零依赖。
 */
export interface RedactingLogger {
  log(message: unknown, ...rest: unknown[]): void;
  error(message: unknown, ...rest: unknown[]): void;
  warn(message: unknown, ...rest: unknown[]): void;
  debug(message: unknown, ...rest: unknown[]): void;
  verbose(message: unknown, ...rest: unknown[]): void;
  fatal(message: unknown, ...rest: unknown[]): void;
  /**
   * R148（**必须存在，否则网关启动即崩**）：
   *
   * ```js
   * // @nestjs/common/services/logger.service.js（10.4.22）
   * static overrideLogger(logger) {
   *   if (Array.isArray(logger)) { Logger.logLevels = logger; return this.staticInstanceRef?.setLogLevels(logger); }
   *   ...
   * }
   * ```
   *
   * `NestFactory.create(AppModule, { logger: ['error','warn','log'] })` 会调用
   * `Logger.overrideLogger([...])`，而 `staticInstanceRef` 此刻**已经是我们这个
   * 自定义 logger** ⇒ 没有 `setLogLevels` 就是
   * `TypeError: this.staticInstanceRef.setLogLevels is not a function`。
   * 五个服务里**只有 api-gateway** 的 `main.ts` 传了 `logger` 数组，所以只有它会崩。
   */
  setLogLevels(levels: readonly string[]): void;
}

const LEVELS: readonly LogLevel[] = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'];

/** `fatal` 之外的级别都是 Nest 的 `LogLevel` 名；无法识别的一律保留（宁多勿少）。 */
const KNOWN = new Set<string>(LEVELS);

/**
 * §5.5 的 Nest 落地形态（R142）：把 Nest 的 `Logger` 输出接上一个**必然脱敏**的通道。
 *
 * 用法（各服务 `main.ts`，必须在 `NestFactory.create` 之前 —— 否则启动早期的日志
 * 不脱敏；R148 之后这个顺序也是**安全**的）：
 *
 * ```ts
 * Logger.overrideLogger(
 *   createRedactingLogger(
 *     (record) => {
 *       // R1102：一行一条 NDJSON 到 stdout/stderr（级别只影响走哪一路，**字段里也有 level**）
 *       const line = JSON.stringify(record);
 *       if (record.level === 'error' || record.level === 'fatal') console.error(line);
 *       else if (record.level === 'warn') console.warn(line);
 *       else console.log(line);
 *     },
 *     { service: 'room-service' }, // ⚠️ 必须与 package.json 的 name 一致（判据 4 的机械闸）
 *   ),
 * );
 * ```
 */
export function createRedactingLogger(sink: LogSink, options: { service: string }): RedactingLogger {
  /** `setLogLevels` 记录下来的白名单；`null` = 不过滤（Nest 没配 `logger` 数组时的默认）。 */
  let enabled: ReadonlySet<string> | null = null;

  /**
   * 把 Nest 的 `(message, ...optionalParams)` 拼成一条**记录**（R1102 的九字段）。
   *
   * Nest 的约定：**最后一个可选参是 context**（`new Logger('RoomService')`）。
   * 注意 Nest 实例方法 `error(message)` 在有 context、没有其它参数时会传成
   * `[undefined, 'Context']` ⇒ `rest.slice(0, -1)` 是 `[undefined]`，因此
   * **必须**过滤掉 `undefined`/`null`/空串，否则会留下一个尾随空格（R148 的观感 bug）。
   */
  const emit = (level: LogLevel, message: unknown, rest: unknown[]): void => {
    if (enabled && !enabled.has(level)) return;

    const last = rest.at(-1);
    const context = typeof last === 'string' ? last : '';
    const extra = typeof last === 'string' ? rest.slice(0, -1) : rest;

    // ⚠️⚠️ 顺序是判据（R1103）：**先脱敏、后序列化**。
    // 反过来的话，字符串参数里内嵌的 JSON（`{"password":"pw"}`）会被 stringify 转义成
    // `{\"password\":\"pw\"}`，而脱敏正则的 `["']?` 匹配不到转义后的引号 ⇒ **静默泄敏**。
    const msg = [message, ...extra]
      .map((part) =>
        typeof part === 'string' ? redactText(part) : redactText(JSON.stringify(redactValue(part))),
      )
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ');

    // ⚠️ 在 **emit 时**读上下文 —— 绝不能在构造期缓存：缓存会让全部行带同一个 traceId，
    // 是一种「看起来完全正常」的错（判据 2′ 就钉这个）。
    sink(buildLogRecord({ level, service: options.service, context, msg, ctx: currentTrace() }));
  };

  return {
    log: (m, ...rest) => emit('log', m, rest),
    error: (m, ...rest) => emit('error', m, rest),
    warn: (m, ...rest) => emit('warn', m, rest),
    debug: (m, ...rest) => emit('debug', m, rest),
    verbose: (m, ...rest) => emit('verbose', m, rest),
    fatal: (m, ...rest) => emit('fatal', m, rest),
    setLogLevels: (levels) => {
      // 只保留我们认识的级别：Nest 可能传入它自己的联合类型（含我们没实现的级别），
      // 那些级别我们本来就不会 emit，留着它们不影响判定。
      const known = Array.isArray(levels) ? levels.filter((l) => KNOWN.has(l)) : [];
      enabled = new Set(known);
    },
  };
}
