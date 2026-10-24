# 可观测性（一）结构化日志 + traceId 全链 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个服务的每行日志成为一条带 `traceId`/`reqId`/`userId` 的 NDJSON，并让同一个客户端操作在 HTTP / WS / RPC 三条边上都能串起来；同时给日志加体积上限。

**Architecture:** 在 `packages/shared` 里加一个 `AsyncLocalStorage` 上下文 + 一个九字段的记录形状；各服务的日志器在 **`emit()` 时**读上下文并渲染 JSON 行到 stdout。traceId 的载体沿用既有的三套（HTTP `X-Trace-Id`、WS 握手 `auth.traceId`、**本片新增** RPC `payload.meta`），但两处生成点要**上移**（WS → `handleConnection` 开头；HTTP → `main.ts` 中间件链第一件事）。

**Tech Stack:** TypeScript / NestJS 10 / Node `async_hooks`（`AsyncLocalStorage`）/ ioredis / docker compose / vitest / 自建 conformance（`tools/conformance`）

**设计真源:** `docs/superpowers/specs/2026-09-23-observability-logging-design.md`（**先读它**；§5 判据表、§7 自审 9 条 + §7.1 复核 8 条、§9 顺序 A→B）

## Global Constraints

- **R1101**：范围 = 最小可扩展。**不引入**采集器 / Loki / ES / Kibana / 告警 / 看板；**不推翻** `design.md` §1.3 的 YAGNI。
- **R1102**：日志记录 = 一行一条 NDJSON，字段**恰好九个**（`ts/level/service/context/traceId/reqId/userId/source/msg`）。加字段必须先改判据。
- **R1103**：**先脱敏、后序列化**。`msg` 在**未转义**状态下过 `redactText`，然后整条 `JSON.stringify`。反序会让字符串参数里内嵌的 JSON 因引号被转义而**逃过正则**（静默泄敏）。
- **R1104/R1105**：RPC 侧 7 个请求类型统一 `extends RpcMeta`（**一个**共享定义）；`meta` **有值才出现**（省略语义 ⇒ 既有「逐字载荷」断言在无 ALS 的单测里不受影响）。
- **R1106**：网关**总是生成** `X-Trace-Id`（**无条件覆盖**客户端传入值）并把 id 回给客户端；公开路径**也注入**。
- **R1107**：**无来源不编造**。无 traceId 时渲染 `traceId: null` + `source`（取值域 `edge` / `rpc` / `timer` / `bootstrap`；**`rpc` 不能省**）。
- **R1108**：日志上限 `{max-size: "10m", max-file: "5"}`（≈50MB/服务）。**轮转即丢弃**，本片不做留存。
- **R1109**：**零客户端改动**（探针 `gate`/`full` 必须逐字不变）。
- **R1110**：**判据只增不减**；S7 运行态泄敏采样必须继续绿。
- **部署原则**（用户 2026-09-23）：生产只用最终镜像、容器不依赖宿主产物；挂载只用于日志/持久化。判据 `slice-07.2-deploy` ①c/②c 已钉住。
- **本仓纪律**：① 改测试文件**用 Edit 工具，不要用 python 字符串替换**（缩进不匹配会静默不匹配；且 python 重写会把 LF 换成 CRLF）② 改了 `src/` 要 `docker compose build <svc> && docker compose up -d <svc>`，重启后先 `docker compose logs <svc> --since 30s | grep -i error` 查 DI 陷阱 ③ 每步都要有可机械判的判据 + 负对照 ④ 每完成一个任务立刻提交。

**门禁命令（每个任务收尾时按需跑）**：
```bash
pnpm --filter @fight-the-landlord/<pkg> test      # 单包单测
pnpm --filter @fight-the-landlord/<pkg> lint      # tsc --noEmit（含 test 的 tsconfig）
pnpm run ci                                       # 六阶段（收尾时）
CONFORMANCE_DEPLOY_STEPS=prod,dev node tools/conformance/dist/run.js slice-07.2-deploy
node tools/conformance/dist/run.js <slice>        # 真栈；需 docker compose 栈在跑
```

---

## 文件结构（先锁定边界）

| 文件 | 动作 | 责任 |
|---|---|---|
| `packages/shared/src/logging/trace-context.ts` | 新建 | ALS 上下文：`TraceContext` / `Source` 类型、`runWithTrace`、`currentTrace` |
| `packages/shared/src/logging/log-record.ts` | 新建 | 九字段 `LogRecord` + `LOG_FIELDS` + `buildLogRecord()` |
| `packages/shared/src/logging/redacting-logger.ts` | 改 | `LogSink` 收 `LogRecord`；`emit()` 时读 ALS；`msg` 先脱敏后序列化 |
| `packages/shared/src/logging/capturing-sink.ts` | 新建 | 测试用捕获 sink（断言"日志里有没有这条上下文"） |
| `packages/shared/src/logging/trace-middleware.ts` | 新建 | Express 形状的中间件（**不 import `@nestjs/common`**，保持 shared 零依赖）：读/生成 traceId → `runWithTrace` → 回传头 |
| `packages/*/src/main.ts`（5 个） | 改 | 传 `service` 名；sink 打印 JSON 行；装 `traceMiddleware` |
| `packages/api-gateway/src/auth/jwt.middleware.ts` | 改 | 生成点让位给前置中间件（保留兜底）；订正 `:87` 的过期注释 |
| `packages/api-gateway/src/gateway/proxy.gateway.ts` | 改 | WS 生成点上移到 `handleConnection` 开头并要求同一个 id 用于下游 `auth` |
| `packages/room-service/src/gateway/message.router.ts` | 改 | 每条 WS 消息包 `runWithTrace`（连接级 traceId + 消息级 reqId） |
| `packages/room-service/src/rooms/rooms.autostart.ts` · `rooms.reaper.ts` | 改 | 定时器轮次包 `runWithTrace({source:'timer'})` |
| `packages/game-service/src/game/game.service.ts` | 改 | 回合计时器回调包 `runWithTrace({source:'timer'})` |
| `packages/protocol/src/rpc.ts` · `robot.ts` | 改 | 新增 `RpcMeta`；7 个请求类型 `extends` |
| `packages/room-service/src/gateway/{game,robot}.client.ts` · `packages/game-service/src/game/robot.client.ts` | 改 | 发送侧统一附加 `meta`（**只改封装**） |
| `packages/{game,robot}-service/src/rpc/to-result.ts` | 改 | `toResult(fn, meta?)`：接收侧包 `runWithTrace({source:'rpc'})`。⚠️ **只有这两个服务有 `src/rpc/`**（它们才是 RPC **监听**方；room-service 只做 RPC **客户端**、不监听 ⇒ 它没有 `to-result.ts`，也就没有"接收侧"要改） |
| `docker-compose.yml` · `docker-compose.override.yml` | 改 | 8 个服务各加 `logging.options` |
| `tools/conformance/src/slices/slice-07.2-deploy.ts` | 改 | 判据 9（渲染）· 9′（`docker inspect`） |
| `tools/conformance/src/slices/slice-12-manual-join.ts` | 改 | 判据 6 / 6′ / 11（真栈） |
| `packages/api-gateway/test/service-name.gate.test.ts` | 新建 | 判据 4（`service` 名 == `package.json` name 的机械闸） |

---

## Task 1：shared 的 ALS 上下文 + 九字段记录形状

**Files:**
- Create: `packages/shared/src/logging/trace-context.ts`
- Create: `packages/shared/src/logging/log-record.ts`
- Modify: `packages/shared/src/index.ts`（加两行 `export *`）
- Test: `packages/shared/src/logging/trace-context.test.ts` · `packages/shared/src/logging/log-record.test.ts`

**Interfaces（后续任务依赖这些名字，逐字）:**
```ts
export type TraceSource = 'edge' | 'rpc' | 'timer' | 'bootstrap';
export interface TraceContext {
  traceId: string | null;
  reqId?: string | null;
  userId?: string | null;
  source: TraceSource;
}
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T;
export function currentTrace(): TraceContext | undefined;
export const LOG_FIELDS: readonly ['ts','level','service','context','traceId','reqId','userId','source','msg'];
export interface LogRecord { /* 九个字段，见下 */ }
export function buildLogRecord(input: {
  level: string; service: string; context: string; msg: string; ctx?: TraceContext;
}): LogRecord;
```

- [ ] **Step 1: 写失败的测试**（`trace-context.test.ts`）

```ts
import { describe, expect, it } from 'vitest';
import { currentTrace, runWithTrace } from './trace-context';

describe('trace-context：ALS 载体（§3）', () => {
  it('无来源 ⇒ currentTrace() 是 undefined（R1107：不得编造）', () => {
    expect(currentTrace()).toBeUndefined();
  });

  it('runWithTrace 里能读到；出了作用域读不到', () => {
    const seen = runWithTrace({ traceId: 'T1', source: 'edge' }, () => currentTrace());
    expect(seen).toEqual({ traceId: 'T1', source: 'edge' });
    expect(currentTrace()).toBeUndefined();
  });

  it('跨 await 仍然有效（这是它能贯穿全链的前提）', async () => {
    const seen = await runWithTrace({ traceId: 'T2', source: 'rpc' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentTrace();
    });
    expect(seen?.traceId).toBe('T2');
  });

  it('嵌套以**内层**为准，且退出后回到外层', () => {
    const out = runWithTrace({ traceId: 'OUT', source: 'edge' }, () => {
      const inner = runWithTrace({ traceId: 'IN', source: 'timer' }, () => currentTrace());
      return [inner?.traceId, currentTrace()?.traceId];
    });
    expect(out).toEqual(['IN', 'OUT']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/shared test -- trace-context`
Expected: FAIL —— `Failed to resolve import "./trace-context"`

- [ ] **Step 3: 实现 `trace-context.ts`**

```ts
// packages/shared/src/logging/trace-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 本行的**来源类别**（R1107 的取值域，四选一，**不得**再少）：
 *  - `edge`：HTTP 边缘请求，或下游从 `X-Trace-Id` 继承
 *  - `rpc`：由一次 RPC 调用带入（**meta 有没有值都算** —— 我在处理一次 RPC，这就是来源）
 *  - `timer`：定时器自己起的一轮（扫描器 / 回合计时器）
 *  - `bootstrap`：进程启动早期，任何来源都还没有
 */
export type TraceSource = 'edge' | 'rpc' | 'timer' | 'bootstrap';

export interface TraceContext {
  /** ⚠️ `null` 是**合法值**（R1107：无来源不编造，绝不拿一个假 id 冒充） */
  traceId: string | null;
  /** 操作级 id（WS 消息自带的 `reqId`；HTTP 无则 null） */
  reqId?: string | null;
  userId?: string | null;
  source: TraceSource;
}

/** 全局唯一实例。⚠️ 只在 `runWithTrace()` 里写，别处一律只读。 */
const storage = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 当前上下文；**不在任何 `runWithTrace` 里 ⇒ `undefined`**（调用方据此渲染 `null` + source）。 */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/shared test -- trace-context`
Expected: PASS（4 条）

- [ ] **Step 5: 写失败的测试**（`log-record.test.ts`）

```ts
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
});
```

- [ ] **Step 6: 跑测试确认失败** → Expected: FAIL（`buildLogRecord` 未定义）

- [ ] **Step 7: 实现 `log-record.ts`**

```ts
// packages/shared/src/logging/log-record.ts
import type { TraceContext } from './trace-context';

/**
 * ⚠️ 字段集**恰好**这九个（R1102）。沿用 `META_FIELDS` 的成例：
 * 加字段**必须先改判据**（`log-record.test.ts` 的第一条）—— 有人想往日志里塞
 * `hand` 之类的字段时会**撞判据**，而不是悄悄绕过脱敏。
 */
export const LOG_FIELDS = [
  'ts', 'level', 'service', 'context', 'traceId', 'reqId', 'userId', 'source', 'msg',
] as const;

export interface LogRecord {
  /** 应用侧生成（docker 的时间是「收取时刻」，脱离 docker 就没了）。 */
  ts: string;
  level: string;
  service: string;
  context: string;
  traceId: string | null;
  reqId: string | null;
  userId: string | null;
  source: 'edge' | 'rpc' | 'timer' | 'bootstrap';
  /** **已脱敏**的正文（R1103：脱敏在序列化**之前**做）。 */
  msg: string;
}

export function buildLogRecord(input: {
  level: string;
  service: string;
  context: string;
  msg: string;
  ctx?: TraceContext;
}): LogRecord {
  const ctx = input.ctx;
  // ⚠️ 逐字段写死（不用 spread）：`LOG_FIELDS` 的「恰好」判据就是靠这里保证的。
  return {
    ts: new Date().toISOString(),
    level: input.level,
    service: input.service,
    context: input.context,
    traceId: ctx?.traceId ?? null,
    reqId: ctx?.reqId ?? null,
    userId: ctx?.userId ?? null,
    source: ctx?.source ?? 'bootstrap',
    msg: input.msg,
  };
}
```

- [ ] **Step 8: 跑测试确认通过** → PASS（5 条）

- [ ] **Step 9: 导出**（`packages/shared/src/index.ts` 末尾加两行）

```ts
export * from './logging/trace-context';
export * from './logging/log-record';
```

- [ ] **Step 10: 提交**

```bash
git add packages/shared/src/logging/trace-context.ts packages/shared/src/logging/log-record.ts \
        packages/shared/src/logging/trace-context.test.ts packages/shared/src/logging/log-record.test.ts \
        packages/shared/src/index.ts
git commit -m "feat(shared): trace 上下文（ALS）+ 九字段日志记录（R1102/R1107）"
```

---

## Task 2：日志器输出 JSON 记录（判据 1 / 2 / 2′ / 3）

**Files:**
- Modify: `packages/shared/src/logging/redacting-logger.ts`
- Create: `packages/shared/src/logging/capturing-sink.ts`
- Test: `packages/shared/src/logging/redacting-logger.test.ts`（改：sink 形状变了）
- Test: `packages/shared/src/logging/capturing-sink.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `currentTrace` / `buildLogRecord` / `LOG_FIELDS`
- Produces: `LogSink = (record: LogRecord) => void`；`createRedactingLogger(sink: LogSink, options: { service: string }): RedactingLogger`；`createCapturingSink(): { sink: LogSink; records: LogRecord[] }`

- [ ] **Step 1: 写捕获 sink + 其测试**

```ts
// packages/shared/src/logging/capturing-sink.ts
import type { LogRecord } from './log-record';

/**
 * 测试用捕获 sink：把所有记录留在数组里。
 * 判据"这条日志带没带上上下文"就靠它（不需要真的去抓 stdout）。
 */
export function createCapturingSink(): { sink: (record: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (record) => void records.push(record), records };
}
```

```ts
// packages/shared/src/logging/capturing-sink.test.ts
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
```

- [ ] **Step 2: 跑测试** → PASS（1 条）

- [ ] **Step 3: 改 `redacting-logger.ts` 的接口与 emit**（保留 `redactText`/`redactValue` 调用顺序**不变**）

```ts
// 头部：类型与签名换掉（其余文档注释保留）
import { redactText, redactValue } from './redact';
import { buildLogRecord, type LogRecord } from './log-record';
import { currentTrace } from './trace-context';

/** ⚠️ 收到的是**记录**（不是一行文本）：`service` 与 id 三件套由它带出去。 */
export interface LogSink {
  (record: LogRecord): void;
}

export function createRedactingLogger(sink: LogSink, options: { service: string }): RedactingLogger {
  let enabled: ReadonlySet<string> | null = null;

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

  return { /* 六个级别方法逐字不变 */ };
}
```

- [ ] **Step 4: 重写 `redacting-logger.test.ts`**（保留既有脱敏断言，改 sink 形状，加四条判据）

要点（逐条都要有）：
```ts
const install = () => {
  const { sink, records } = createCapturingSink();
  return { logger: createRedactingLogger(sink, { service: 'room-service' }), records };
};

// 判据 1：合法 JSON + 恰好九字段 + level/context/service
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
```

- [ ] **Step 5: 跑 shared 全包**

Run: `pnpm --filter @fight-the-landlord/shared test`
Expected: 全绿（**条数只增不减**；`redacting-logger.test.ts` 原有的脱敏/R148 判据逐条保留）

- [ ] **Step 6: 跑 lint** → `pnpm --filter @fight-the-landlord/shared lint` 干净

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/logging/
git commit -m "feat(shared): 日志器输出九字段 JSON 记录（判据 1/2/2′/3，先脱敏后序列化）"
```

---

## Task 3：五个服务接上新 sink + `service` 名机械闸（判据 4）

**Files:**
- Modify: `packages/{api-gateway,user-service,room-service,game-service,robot-service}/src/main.ts`
- Create: `packages/api-gateway/test/service-name.gate.test.ts`

- [ ] **Step 1: 写机械闸（先写、先失败）**

```ts
// packages/api-gateway/test/service-name.gate.test.ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), '..', '..');
const SERVICES = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service'] as const;

const pkgName = (svc: string): string =>
  (JSON.parse(readFileSync(join(ROOT, 'packages', svc, 'package.json'), 'utf-8')) as { name: string }).name;

describe('§A（判据 4）：每个服务的日志 service 名必须与 package.json 的 name 一致', () => {
  for (const svc of SERVICES) {
    it(`${svc}：main.ts 里传的 service 名 === package.json 的 name`, () => {
      const main = readFileSync(join(ROOT, 'packages', svc, 'src', 'main.ts'), 'utf-8');
      const m = /service:\s*'([^']+)'/.exec(main);
      expect(m, `${svc}/src/main.ts 里找不到 createRedactingLogger(..., { service: '…' })`).not.toBeNull();
      expect(m![1]).toBe(pkgName(svc));
    });
  }
});
```

- [ ] **Step 2: 跑它，确认失败**（5 条都红：找不到 `service: '…'`）

Run: `pnpm --filter @fight-the-landlord/api-gateway test -- service-name`
Expected: FAIL × 5

- [ ] **Step 3: 改五个 `main.ts` 的 sink**（逐字同形，只换服务名）

```ts
  Logger.overrideLogger(
    createRedactingLogger(
      (record) => {
        // R1102：一行一条 NDJSON 到 stdout/stderr（级别只影响走哪一路，**字段里也有 level**）
        const line = JSON.stringify(record);
        if (record.level === 'error' || record.level === 'fatal') console.error(line);
        else if (record.level === 'warn') console.warn(line);
        else console.log(line);
      },
      { service: 'room-service' }, // ⚠️ 必须与 package.json 的 name 一致（判据 4 的机械闸）
    ),
  );
```

- [ ] **Step 4: 跑五个包的单测**（sink 形状变了，逐条修断言）

Run: `pnpm --filter @fight-the-landlord/api-gateway test && pnpm --filter @fight-the-landlord/user-service test && pnpm --filter @fight-the-landlord/room-service test && pnpm --filter @fight-the-landlord/game-service test && pnpm --filter @fight-the-landlord/robot-service test`
Expected: 全绿。⚠️ 若有断言依赖旧 sink 形状（`(level, line)`），**用 Edit 逐条**改成新形状；**不得**用 python 替换。

- [ ] **Step 5: 跑 `no-raw-console` 闸** → `pnpm --filter @fight-the-landlord/api-gateway test -- no-raw-console` 绿（`console.*` 仍只在 `main.ts`）

- [ ] **Step 6: 提交**

```bash
git add packages/*/src/main.ts packages/api-gateway/test/service-name.gate.test.ts
git commit -m "feat(logging): 五个服务输出 NDJSON + service 名机械闸（判据 4）"
```

---

## Task 4：下游 REST 入口接 ALS（判据 6 的下游半边）

**Files:**
- Create: `packages/shared/src/logging/trace-middleware.ts`
- Modify: 五个 `main.ts`（`app.use(createTraceMiddleware(...))`）
- Test: `packages/shared/src/logging/trace-middleware.test.ts`

**Interfaces（后续任务依赖）:**
```ts
export function createTraceMiddleware(options?: { overwriteExisting?: boolean }):
  (req: { headers: Record<string, unknown>; method?: string }, res: { setHeader(k: string, v: string): void }, next: () => void) => void;
```

- [ ] **Step 1: 写失败的测试**（4 条，含两条负对照）

```ts
// packages/shared/src/logging/trace-middleware.test.ts
import { describe, expect, it } from 'vitest';
import { createTraceMiddleware } from './trace-middleware';
import { currentTrace } from './trace-context';

const run = (mw: any, headers: Record<string, unknown>) => {
  const res = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; } };
  let seen: ReturnType<typeof currentTrace> | undefined;
  mw({ headers, method: 'POST' }, res, () => { seen = currentTrace(); });
  return { seen, res };
};

describe('createTraceMiddleware（R1106 / R1107）', () => {
  it('有 X-Trace-Id ⇒ 继承（source: edge），并回传到响应头', () => {
    const { seen, res } = run(createTraceMiddleware(), { 'x-trace-id': 'UP1', 'x-user-id': 'U1' });
    expect(seen).toMatchObject({ traceId: 'UP1', userId: 'U1', source: 'edge' });
    expect(res.headers['X-Trace-Id']).toBe('UP1');
  });

  it('没有 X-Trace-Id ⇒ **自建**一个（直连下游的路径也要有链，如 conformance 探针）', () => {
    const { seen } = run(createTraceMiddleware(), {});
    expect(typeof seen!.traceId).toBe('string');
    expect(seen!.traceId!.length).toBeGreaterThan(0);
  });

  it('负对照（判据 10 的单测半边）：overwriteExisting ⇒ **不采信**客户端给的值', () => {
    const { seen } = run(createTraceMiddleware({ overwriteExisting: true }), { 'x-trace-id': 'attacker' });
    expect(seen!.traceId).not.toBe('attacker');
  });

  it('负对照：overwriteExisting 下**公开路径**（无 x-user-id）也必须生成并回传', () => {
    const { seen, res } = run(createTraceMiddleware({ overwriteExisting: true }), {});
    expect(seen!.traceId).not.toBeNull();
    expect(res.headers['X-Trace-Id']).toBe(seen!.traceId);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/shared/src/logging/trace-middleware.ts
import { randomUUID } from 'node:crypto';
import { runWithTrace } from './trace-context';

export const TRACE_ID_HEADER = 'x-trace-id';
export const USER_ID_HEADER = 'x-user-id';

/**
 * REST 入口的 trace 中间件。**不 import `@nestjs/common`**（shared 保持零依赖）——
 * 参数形状就是 Express 的 `(req, res, next)`，五个服务在 `main.ts` 里 `app.use()` 即可。
 *
 * ⚠️ `overwriteExisting: true` 只给**网关**用（R1106：总是生成、不采信客户端）。
 * 下游服务用缺省（继承上游的 id；直连时自建一个 —— 那不是"编造"，是"这条路没有上游"）。
 */
export function createTraceMiddleware(options: { overwriteExisting?: boolean } = {}) {
  return (
    req: { headers: Record<string, unknown> },
    res: { setHeader(key: string, value: string): void },
    next: () => void,
  ): void => {
    const incoming = req.headers?.[TRACE_ID_HEADER];
    const inherited = typeof incoming === 'string' && incoming.length > 0 ? incoming : null;
    const traceId = options.overwriteExisting ? randomUUID() : (inherited ?? randomUUID());
    const userId = req.headers?.[USER_ID_HEADER];
    // 回给客户端（R1106）：用户报障时能引用它
    res.setHeader('X-Trace-Id', traceId);
    // 下游服务把 id 写回请求头，`headersOf()` 才能把它转给下一跳
    req.headers[TRACE_ID_HEADER] = traceId;
    runWithTrace(
      { traceId, userId: typeof userId === 'string' ? userId : null, source: 'edge' },
      next,
    );
  };
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS（4 条）

- [ ] **Step 5: 接进五个服务**（`main.ts`：`app.use(createTraceMiddleware())`；**网关**那一行**当场**就用 `createTraceMiddleware({ overwriteExisting: true })` —— R1106 的「总是生成」从本任务起就成立，**不留中间态**）

⚠️ 位置：**必须在其他中间件之前**（`createInternalTokenMiddleware()` 之前），否则更早的中间件日志没有上下文。

- [ ] **Step 6: 导出**（`packages/shared/src/index.ts` 加 `export * from './logging/trace-middleware';`）

- [ ] **Step 7: 跑受影响包的测试 + lint**（shared / 五个服务）

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/logging/trace-middleware* packages/shared/src/index.ts packages/*/src/main.ts
git commit -m "feat(logging): REST 入口 trace 中间件（继承/自建/回传，含两条负对照）"
```

---

## Task 5：WS 链路 —— 网关生成点上移（复核⑦）+ 消息入口包 ALS

**Files:**
- Modify: `packages/api-gateway/src/gateway/proxy.gateway.ts`（`handleConnection`）
- Modify: `packages/room-service/src/gateway/message.router.ts`（消息分发处）
- Test: `packages/api-gateway/test/proxy.gateway.test.ts` · `packages/room-service/test/message.router.test.ts`

- [ ] **Step 1: 写失败的测试**（网关侧：连接级 id 一致）

```ts
// proxy.gateway.test.ts 追加
it('复核⑦：handleConnection 开头生成 traceId，且下游 auth 用的是**同一个**', async () => {
  const { gateway, ioCalls } = makeGateway(); // 复用本文件既有的脚手架
  await gateway.handleConnection(fakeSocket('u1'));
  const connected = logsOf(gateway).find((l) => l.msg.startsWith('Client connected'));
  expect(connected!.traceId).not.toBeNull();
  expect((ioCalls[0]!.auth as { traceId: string }).traceId).toBe(connected!.traceId);
});
```

- [ ] **Step 2: 跑它确认失败**
Run: `pnpm --filter @fight-the-landlord/api-gateway test -- proxy.gateway`
Expected: FAIL —— `Client connected` 行的 `traceId` 是 `null`（生成点在它之后）

- [ ] **Step 3: 改 `proxy.gateway.ts`**（**只搬家，不动逻辑**）

```ts
// ① 把 `handleConnection` 的**原方法体整段**移进一个新的私有方法，签名只多一个参数：
private async handleConnectionInner(client: Socket, traceId: string): Promise<void> {
  /* …原方法体逐字搬过来，只把建下游连接处那行 `traceId: randomUUID()` 换成 `traceId`… */
}

// ② 公开方法变成三行 wrapper（生成点在**最前面** —— 复核⑦：`Client connected` 那行在
//    原方法体里，它必须能拿到同一个 id）：
async handleConnection(client: Socket): Promise<void> {
  const traceId = randomUUID();
  return runWithTrace({ traceId, source: 'edge' }, () => this.handleConnectionInner(client, traceId));
}
```

⚠️ **不得**顺手改任何其它逻辑（顺序、早返回、名额检查都逐字保留）；本步只允许"搬家 + 换掉那一处 `randomUUID()`"。

- [ ] **Step 4: 跑它确认通过** → PASS

- [ ] **Step 5: 改 `message.router.ts`**（每条消息一个 `reqId`、连接级 `traceId`）

```ts
// 分发处（`switch (message.type)` 之外，逐字）：
return runWithTrace(
  {
    traceId: (socket.data.traceId as string | null) ?? null,
    reqId: (message as { reqId?: string }).reqId ?? null,
    userId: (socket.data.userId as string | null) ?? null,
    source: 'edge',
  },
  () => this.dispatch(ctx, socket, message),
);
```

- [ ] **Step 6: 加 room-service 侧判据**（用捕获 sink 断言"处理一条消息期间产生的日志带上连接级 traceId 与消息级 reqId"）

```ts
it('判据 6′：WS 消息处理期间的日志带连接级 traceId + 消息级 reqId', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
  await router.handleMessage(fakeSocket({ traceId: 'CONN1', userId: 'U1' }), { type: 'room.join', reqId: 'REQ1', payload: { roomCode: 'AAA111' }, baseVersion: 0 });
  expect(records.some((r) => r.traceId === 'CONN1' && r.reqId === 'REQ1')).toBe(true);
});
```

- [ ] **Step 7: 跑 room-service 全包 + lint** → 全绿

- [ ] **Step 8: 提交**

```bash
git add packages/api-gateway/src/gateway/proxy.gateway.ts packages/api-gateway/test/proxy.gateway.test.ts \
        packages/room-service/src/gateway/message.router.ts packages/room-service/test/message.router.test.ts
git commit -m "feat(logging): WS 生成点上移 + 消息入口包 ALS（复核⑦，判据 6′）"
```

---

## Task 6：网关身份与追踪收口 —— 兜底 + **复核⑩（身份归属不可伪造）** + 判据 10/12

> ⚠️ 本任务**不再**改 `main.ts` —— 中间件的安装与 `overwriteExisting: true` 已在 **Task 4 Step 5** 落地（避免中间态）。
> ⚠️ **本任务的范围在实施期被扩过**：Task 4 的评审者抓出**两条 Important**（见下），经控制者裁决折进这里。

**Files:**
- Modify: `packages/shared/src/logging/trace-middleware.ts`（**网关形态不读 `x-user-id`**）
- Modify: `packages/api-gateway/src/auth/jwt.middleware.ts`（兜底 + **验签后用已验证 `sub` 嵌套重跑 `runWithTrace`** + 订正 `:87` 过期注释）
- Modify: `packages/api-gateway/src/auth/identity-headers.ts`（头名常量改从 `shared` 导入 —— 消掉两份字面量真源，见 Minor）
- Test: `packages/shared/src/logging/trace-middleware.test.ts` · `packages/api-gateway/test/jwt.middleware.test.ts`

**两条 Important（Task 4 评审的发现，原文要点）**
1. 🔴 **身份归属可被客户端操纵**：网关的 trace 中间件是**第一个** `app.use`，而 `JwtMiddleware`（剥/覆盖身份头）是**模块中间件**（Nest init 期才注册、必然更晚）⇒ 中间件从请求头直读 `x-user-id` 会把客户端自带的值写进 ALS；带 `X-User-Id: 受害者` 的请求**每一行日志**都记成受害者（公开路径上更是任意字符串直接进日志）。转发身份本身没错（`headersOf()` 读的是 JwtMiddleware 覆盖后的头）⇒ 这是**归因被操纵**，不是越权，但足以毁掉本片的目的（定位问题）。
   ⇒ 修法：**网关形态（`overwriteExisting: true`）不读 `x-user-id`**（`userId: null`）；`userId` 只由 `JwtMiddleware` **验签成功之后**用**嵌套** `runWithTrace({ …已验证的 sub })` 写入（嵌套 run 覆盖余下处理）。下游服务（**默认**形态）继续读该头 —— 那里的值来自网关注入（N7/R146 的既有契约）。
2. ⚠️ **写回 `req.headers['x-trace-id']` 零断言**：删掉那一行，Task 4 的 4 条测试全绿，而判据 6 的「生成→转发→ALS→记录」会**静默断**。本任务的判据 10 测试（断言写回值与响应头**一致**）把它闭合。

**Minor（一并收掉）**：头名现在有两份字面量真源（`trace-middleware.ts` 与 `auth/identity-headers.ts`，值相同）⇒ `identity-headers.ts` 改成 `export { TRACE_ID_HEADER, USER_ID_HEADER } from '@fight-the-landlord/shared'`（该包的"防循环依赖"注释不阻止它 —— shared 与网关无环）。

- [ ] **Step 1: 写失败的测试**（4 条）

```ts
// packages/shared/src/logging/trace-middleware.test.ts 追加
it('复核⑩：网关形态**不读** x-user-id（客户端自带的身份永不可信）', () => {
  const { seen } = run(createTraceMiddleware({ overwriteExisting: true }), { 'x-user-id': 'victim' });
  expect(seen!.userId).toBeNull();          // ← 今天会红（读到 'victim'）
  expect(seen!.traceId).not.toBeNull();
});

// packages/api-gateway/test/jwt.middleware.test.ts 追加
it('判据 12①：公开路径 + 客户端自带的 X-User-Id ⇒ 处理期间日志的 userId 必须是 null', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));
  const req = makeReq({ headers: { 'x-user-id': 'victim' } });   // 无 authorization ⇒ 公开路径
  await middleware.use(req as never, {} as never, () => { loggerInsideProbe.log('in-handler', 'Probe'); });
  expect(records.find((r) => r.msg === 'in-handler')!.userId).toBeNull();
});

it('判据 12②：验签路径 ⇒ 日志 userId 等于令牌里的 sub（不是头里的值）', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));
  mockJwtService.verify.mockReturnValue(validPayload({ sub: 'real-user' }));
  const req = makeReq({ headers: { authorization: 'Bearer valid-token', 'x-user-id': 'victim' } });
  await middleware.use(req as never, {} as never, () => { loggerInsideProbe.log('in-handler', 'Probe'); });
  expect(records.find((r) => r.msg === 'in-handler')!.userId).toBe('real-user');
});

it('判据 10 + Important-2：客户端带 X-Trace-Id ⇒ 不采信，且 `req.headers` 的写回与响应头**一致**', () => {
  const req = { headers: { 'x-trace-id': 'attacker-chosen' } };
  const res = { setHeader: vi.fn() };
  createTraceMiddleware({ overwriteExisting: true })(req as never, res as never, () => undefined);
  expect(req.headers['x-trace-id']).not.toBe('attacker-chosen');
  expect(res.setHeader).toHaveBeenCalledWith('X-Trace-Id', req.headers['x-trace-id']);  // ← 写回被钉住
});
```

（`loggerInsideProbe` 就是该文件里 `new Logger('Probe')` 的实例；用它证明"**处理期间**产生的日志"带上了上下文。）

- [ ] **Step 2: 跑确认失败** → 第 1、2 条红（公开路径今天会读到 victim；网关形态今天也读）

- [ ] **Step 3: 改三处**

```ts
// ① trace-middleware.ts：网关形态不读身份头
const userId = options.overwriteExisting ? null : readUserId(req.headers);
// ⚠️ 网关是**边缘**：客户端自带的身份永不可信（复核⑩）。`userId` 只由 JwtMiddleware
//    验签成功之后用嵌套 runWithTrace 写入；下游服务（默认形态）读的是**网关注入**的头（N7/R146）。
```

```ts
// ② jwt.middleware.ts：兜底 + 验签后嵌套重跑（写入已验证身份）
if (typeof req.headers[TRACE_ID_HEADER] !== 'string' || !req.headers[TRACE_ID_HEADER]) {
  req.headers[TRACE_ID_HEADER] = randomUUID();   // 兜底：只为单测直接调用 / 有人绕过前置中间件
}
// …验签、白名单、覆盖 X-User-Id 之后：
return runWithTrace(
  { traceId: String(req.headers[TRACE_ID_HEADER]), userId: payload.sub, source: 'edge' },
  next,   // ⚠️ 嵌套 run 覆盖余下处理 —— 这是"日志里的 userId 只能是验证过的身份"的唯一保证
);
```

```ts
// ③ identity-headers.ts：头名单一真源
export { TRACE_ID_HEADER, USER_ID_HEADER } from '@fight-the-landlord/shared';
```

⚠️ 同时**订正 `:87` 的过期注释**（它说「X-Trace-Id …保留」；改后语义是"不由身份层处置"，别让下一个人读错）。

- [ ] **Step 4: 跑 api-gateway + shared 全包 + turbo lint** → 全绿（`:322` 那条「injects X-Trace-Id」应仍绿）· 判据只增不减

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/logging/trace-middleware.ts packages/api-gateway/src/auth/ packages/api-gateway/test/ packages/shared/src/logging/trace-middleware.test.ts
git commit -m "fix(gateway): 身份归属不可伪造（复核⑩/判据 12）+ 头名单一真源 + 兜底与注释订正"
```

---

## Task 7：定时器链路 `source: 'timer'`（判据 11 的单测半边）

**Files:**
- Modify: `packages/room-service/src/rooms/rooms.autostart.ts` · `rooms.reaper.ts`
- Modify: `packages/game-service/src/game/game.service.ts`（`startTurnTimer` 的 setTimeout 回调）
- Test: `packages/room-service/test/rooms.reaper.test.ts`（加一条）· `packages/game-service/test/game.timer.test.ts`（加一条）

- [ ] **Step 1: 写失败的测试**（room-service）

```ts
it('判据 11：扫描器一轮的日志带 source=timer 且 traceId 非空（无来源才该是 null）', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
  await seedRoom('REAP11');
  await reaper.reapOnce(Date.now() + 10 * 60_000);
  const line = records.find((r) => r.msg.includes('Reaped'));
  expect(line).toBeDefined();
  expect(line!.source).toBe('timer');
  expect(line!.traceId).not.toBeNull();
});
```

- [ ] **Step 2: 跑确认失败** → FAIL（`source` 是 `bootstrap`、`traceId` 是 null）

- [ ] **Step 3: 实现**（三个入口同形）

```ts
// reapOnce / scanOnce 的第一行（game-service 同理，包住 setTimeout 的回调体）：
async reapOnce(now: number = Date.now()): Promise<string[]> {
  return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.reapOnceInner(now));
}
```

- [ ] **Step 4: 跑两个包的单测** → 全绿（既有判据一条不减）

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/rooms/ packages/room-service/test/rooms.reaper.test.ts \
        packages/game-service/src/game/game.service.ts packages/game-service/test/game.timer.test.ts
git commit -m "feat(logging): 定时器链路 source=timer（R1107，判据 11 的单测半边）"
```

---

## Task 8：日志上限（R1108）+ 判据 9 / 9′

**Files:**
- Modify: `docker-compose.yml` · `docker-compose.override.yml`（8 个服务）
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts`

- [ ] **Step 1: 加 `logging` 块**（每个服务各一份，含 `douzero`）

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

- [ ] **Step 2: 渲染验证（两种形态）**

```bash
: > /tmp/empty.env
docker compose --env-file /tmp/empty.env -f docker-compose.yml config --format json | \
  python -c "import json,sys; c=json.load(sys.stdin); print({k: v.get('logging') for k,v in c['services'].items()})"
```
Expected: 8 个服务的 `logging.options` 都是 `{'max-size': '10m', 'max-file': '5'}`

- [ ] **Step 3: 写 slice 判据 9**（渲染：每个服务都必须有上限）

```ts
function servicesWithoutLogLimit(config: any): string[] {
  return Object.entries(config.services as Record<string, any>)
    .filter(([, s]) => {
      const opts = s.logging?.options ?? {};
      return !opts['max-size'] || !opts['max-file'];
    })
    .map(([name]) => name).sort();
}
// 在 ① 生产形态 与 ② 开发形态 两处各加一条 checks.that(... === 0)
```

- [ ] **Step 4: 写 slice 判据 9′**（真容器：`docker inspect`）

```ts
// 在 runtime 步里：对 8 个常驻容器（若在跑）断言 LogConfig.Config 有 max-size/max-file。
// ⚠️ 渲染 ≠ 生效（复核④）—— 配置文件证不了运行中的容器。
const names = ['ftl-api-gateway','ftl-user-service','ftl-room-service','ftl-game-service','ftl-robot-service','ftl-douzero','ftl-mysql','ftl-redis'];
const missing: string[] = [];
for (const n of names) {
  const raw = composeLogsInspect(n); // `docker inspect --format '{{json .HostConfig.LogConfig}}' <n>`
  if (!raw) continue; // 容器不在跑 ⇒ 跳过（本步的前提判据会先说清）
  if (!raw.includes('max-size')) missing.push(n);
}
checks.that(missing.length === 0, `重建后的容器必须带日志上限 —— 缺：${missing.join(', ') || '（无）'}`);
```

- [ ] **Step 5: 重建并验证真容器**

```bash
docker compose up -d --build
sleep 20
docker inspect --format '{{.Name}} {{json .HostConfig.LogConfig}}' ftl-room-service
```
Expected: `{"Type":"json-file","Config":{"max-file":"5","max-size":"10m"}}`

- [ ] **Step 6: 跑 slice** → `CONFORMANCE_DEPLOY_STEPS=prod,dev node tools/conformance/dist/run.js slice-07.2-deploy` 全绿

- [ ] **Step 7: 提交**

```bash
git add docker-compose.yml docker-compose.override.yml tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "feat(ops): 日志上限 max-size/max-file ×8 服务 + 判据 9/9′（渲染 + 真容器）"
```

---

## Task 9：真栈判据 6 / 6′ / 11（conformance）

**Files:**
- Modify: `tools/conformance/src/slices/slice-12-manual-join.ts`

- [ ] **Step 1: 加判据 6（HTTP 一路到底）**——建房时从**响应头**取 traceId，再在 room-service 日志里找它

```ts
// createRoom 改为返回 headers（`postJson` 已能拿到），然后：
const traceId = roomHeaders['x-trace-id'];
checks.that(typeof traceId === 'string' && traceId.length > 0, `建房响应必须带 X-Trace-Id（R1106 回传）`);
await sleep(1500); // 日志落地
const hit = composeLogs('room-service', 60).split('\n').filter((l) => l.includes(traceId!));
checks.that(hit.length > 0, `room-service 的日志里必须出现该 traceId（一路到底）—— 实际 ${hit.length} 行`);
```

- [ ] **Step 2: 加判据 6′（WS 两侧同一 id）**——连上后取网关 `Client connected` 行的 traceId，断言 room-service 侧同一 id

- [ ] **Step 3: 加判据 11（无来源不编造）**

```ts
const reaped = composeLogs('room-service', 120).split('\n').filter((l) => l.includes('Reaped'));
const parsed = reaped.map((l) => safeJson(l)).filter(Boolean);
checks.that(parsed.length > 0, '至少要有 N 条扫描器日志（否则判据是空测）');
checks.that(parsed.every((r) => r.traceId === null && r.source === 'timer'),
  `扫描器日志必须 traceId=null + source=timer —— 违例：${JSON.stringify(parsed.filter((r) => !(r.traceId === null && r.source === 'timer')).slice(0, 3))}`);
```

- [ ] **Step 4: 重建服务、跑 slice-12**

```bash
docker compose up -d --build room-service api-gateway game-service
pnpm --filter @fight-the-landlord/conformance build
node tools/conformance/dist/run.js slice-12
```
Expected: 全绿（既有 59 项 + 新增 3 项）

- [ ] **Step 5: 提交**

```bash
git add tools/conformance/src/slices/slice-12-manual-join.ts
git commit -m "test(conformance): 判据 6/6′/11 真栈（HTTP 一路到底 · WS 两侧 · 无来源不编造）"
```

---

## Task 10：协议 `RpcMeta` + 7 个请求类型（R1104）

> ⚠️ **口径订正（派单前）**：原稿写「7 个类型 `extends RpcMeta`」—— 那会把三个 id **摊平**到载荷上，
> 而 R1105 的省略语义与判据 5 要的是**一个可选字段** `meta`（有值才出现）。正确形状见下。

**Files:**
- Modify: `packages/protocol/src/rpc.ts`（定义 `RpcMeta`；`StartGame/GameSnapshot/GameView/GameAction` 各带 `meta?: RpcMeta`）
- Modify: `packages/protocol/src/robot.ts`（`RobotAcquire/Release/Decide` 同上）
- Test: `packages/protocol/src/rpc.test.ts`（新建）

- [ ] **Step 1: 写失败的测试**

```ts
// packages/protocol/src/rpc.test.ts
import { describe, expect, it } from 'vitest';
import type { RpcMeta, StartGameRequest } from './rpc';

describe('RpcMeta（R1104/R1105）', () => {
  it('形状：traceId 必填、reqId/userId 可选', () => {
    const meta: RpcMeta = { traceId: 'T' };
    expect(meta.traceId).toBe('T');
    expect('reqId' in meta).toBe(false); // 省略语义：没值就**不出现**
  });

  it('省略语义的**类型层**证明：不传 meta 的请求仍然合法（本文件能被 tsc 编译即证明）', () => {
    // ⚠️ 这条的判别力来自 `packages/protocol` 的 `tsc --noEmit`（lint 阶段）：
    //    若把 `meta` 写成必填，这一行**编译不过** ⇒ lint 红。
    const request: StartGameRequest = { roomCode: 'R', baseScore: 100, players: [] };
    expect(request.roomCode).toBe('R');
    expect('meta' in request).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败** → FAIL（`RpcMeta` 不存在）

- [ ] **Step 3: 定义 `RpcMeta` 并给 7 个请求类型各加一个**可选** `meta` 字段**

```ts
// packages/protocol/src/rpc.ts
/**
 * **RPC 的元数据**（§15.3 的 traceId/reqId/userId 过 RPC 那一跳的载体）。
 *
 * ⚠️ **是一个可选字段**（`meta?: RpcMeta`），**不是** `extends RpcMeta`：后者会把三个 id
 * 摊平到载荷顶层，而 R1105 的省略语义要的是「**有值才出现**」的一个字段 ——
 * 既有「逐字载荷」断言也正是靠它不受影响。
 * ⚠️ 为什么带 `userId`：不带的话 `game.start`/`game.action` 在 game-service 侧的
 * 日志里 `userId` 只能是 null，而 §15.3 要求「`userId`（**若有**）」——这两条链上"有"。
 */
export interface RpcMeta {
  traceId: string;
  reqId?: string;
  userId?: string;
}
```

然后 7 个请求类型各加一行（**其余字段一字不动**）：

```ts
export interface StartGameRequest { /* …既有字段… */ meta?: RpcMeta; }
```

- [ ] **Step 4: 跑 protocol 全包 + 全仓 lint**

Run: `pnpm --filter @fight-the-landlord/protocol test && pnpm run lint`
Expected: 全绿（加性变更；`tsc` 同时证明「不传 `meta` 合法」）

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/
git commit -m "feat(protocol): RpcMeta 可选字段 + 7 个请求类型（R1104/R1105）"
```

---

## Task 11：RPC 发送侧统一附加 `meta`（判据 5）

**Files:**
- Modify: `packages/room-service/src/gateway/game.client.ts`（`call()` 一处）· `robot.client.ts`（两处 `send`）
- Modify: `packages/game-service/src/game/robot.client.ts`（一处）
- Test: `packages/room-service/test/match.service.test.ts`（加两条：无 ALS 无 meta / 有 ALS 有 meta）

- [ ] **Step 1: 写失败的测试**

```ts
it('判据 5 正：ALS 有上下文 ⇒ 载荷带 meta{traceId,reqId,userId}', async () => {
  await runWithTrace({ traceId: 'T9', reqId: 'R9', userId: 'U9', source: 'edge' }, async () => {
    await service.startRoom('ABC123', { strict: true });
  });
  const payload = rpc.payloadsOf(RPC_PATTERNS.gameStart)[0] as { meta?: unknown };
  expect(payload.meta).toEqual({ traceId: 'T9', reqId: 'R9', userId: 'U9' });
});

it('判据 5 负：无 ALS ⇒ 载荷里**没有** meta 键（既有逐字断言因此不受影响）', async () => {
  await service.startRoom('ABC123', { strict: true });
  const payload = rpc.payloadsOf(RPC_PATTERNS.gameStart)[0] as Record<string, unknown>;
  expect('meta' in payload).toBe(false);
});
```

- [ ] **Step 2: 跑确认失败**（正对照红：没有 meta）

- [ ] **Step 3: 实现**（**只改封装**，调用点一行不动）

```ts
// packages/shared/src/logging/rpc-meta.ts（新，供三个 client 共用）
import { currentTrace } from './trace-context';
// ✅ 依赖方向已核：`packages/shared` 本来就依赖 `@fight-the-landlord/protocol`
// （package.json:14，且 shared/src/ddz/features.ts 已在用它的类型）⇒ 直接引真类型，不用结构化替代品。
import type { RpcMeta } from '@fight-the-landlord/protocol';

/** 省略语义（R1105）：没有上下文 ⇒ 返回 `{}`，调用方据此**不加** `meta` 键。 */
export function metaFromTrace(): { meta?: RpcMeta } {
  const ctx = currentTrace();
  if (!ctx?.traceId) return {};
  return {
    meta: {
      traceId: ctx.traceId,
      ...(ctx.reqId ? { reqId: ctx.reqId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    },
  };
}
```

- [ ] **Step 4: 三个 client 各改一处**

```ts
// game.client.ts 的 call()：payload 组装处
this.proxy.send<RpcResult<T>>(pattern, { ...(payload as object), ...metaFromTrace() })
// robot.client.ts 的 acquire/release：同上（两处）
```

- [ ] **Step 5: 跑 room-service + game-service 全包** → 全绿（**既有逐字载荷断言必须仍然绿** —— 它们都在无 ALS 的单测里）

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/logging/ packages/room-service/src/gateway/ packages/game-service/src/game/robot.client.ts packages/room-service/test/
git commit -m "feat(rpc): 发送侧统一附加 meta（R1105 省略语义，判据 5 正负对照）"
```

---

## Task 12：RPC 接收侧包 ALS（判据 7 的一半）

**Files:**
- Modify: `packages/{room,game,robot}-service/src/rpc/to-result.ts`
- Modify: 各 `*.rpc.controller.ts`（把 `dto.meta` 传进去）

- [ ] **Step 1: 写失败的测试**（robot-service 的 `robot.rpc.test.ts` 加一条）

```ts
it('判据 7 的一半：handler 处理期间的日志带调用方传的 traceId 与 source=rpc', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'robot-service' }));
  await controller.acquire({ roomCode: 'R1', seats: [1], meta: { traceId: 'T7', reqId: 'R7' } } as never);
  expect(records.some((r) => r.traceId === 'T7' && r.reqId === 'R7' && r.source === 'rpc')).toBe(true);
});

it('判据 7 负对照：无 meta ⇒ traceId 为 null 且 source 仍是 rpc（不编造）', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'robot-service' }));
  await controller.acquire({ roomCode: 'R1', seats: [1] } as never);
  const line = records.at(-1)!;
  expect(line.traceId).toBeNull();
  expect(line.source).toBe('rpc');
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 改 `to-result.ts`（三份同形）**

```ts
export async function toResult<T>(
  fn: () => Promise<T>,
  meta?: { traceId?: string; reqId?: string; userId?: string },
): Promise<RpcResult<T>> {
  // ⚠️ 处理期间的一切日志都挂在这条链上；**没有 meta 也不编造**（R1107）——
  //    这时 traceId 是 null，但 source 仍是 `rpc`（"我在处理一次 RPC"，这就是来源）。
  return runWithTrace(
    { traceId: meta?.traceId ?? null, reqId: meta?.reqId ?? null, userId: meta?.userId ?? null, source: 'rpc' },
    async () => {
      try {
        return { ok: true as const, data: await fn() };
      } catch (err: unknown) {
        const code = (err as { code?: number } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, code: (code ?? ErrCode.ILLEGAL_ACTION) as ErrCode, message };
      }
    },
  );
}
```

- [ ] **Step 4: controller 传 `dto.meta`**（7 个 handler：`return toResult(() => …, dto?.meta);`）

- [ ] **Step 5: 跑三个包全包 + lint** → 全绿

- [ ] **Step 6: 提交**

```bash
git add packages/*/src/rpc/
git commit -m "feat(rpc): 接收侧包 ALS（source=rpc，含无 meta 的负对照）"
```

---

## Task 13：真栈判据 7（跨 RPC）+ 判据 8（S7 泄敏复检）

**Files:**
- Modify: `tools/conformance/src/slices/slice-12-manual-join.ts`（判据 7）

- [ ] **Step 1: 加判据 7**（单人房补位 ⇒ `game.start` 的 meta 与 game-service 侧日志同一 traceId）

```ts
const startLog = composeLogs('game-service', 120).split('\n').map(safeJson).filter(Boolean)
  .find((r) => r.msg?.includes('Game created'));
checks.that(startLog?.traceId != null, 'game-service 侧开局日志必须带 traceId（source=rpc）');
checks.that(roomSideTraceIds.has(startLog!.traceId), `room-service 侧必须出现同一个 traceId ${startLog!.traceId}`);
```

- [ ] **Step 2: 重建并跑**

```bash
docker compose up -d --build room-service game-service robot-service api-gateway
pnpm --filter @fight-the-landlord/conformance build
node tools/conformance/dist/run.js slice-12
```
Expected: 全绿。⚠️ **判据 8（S7 泄敏采样）必须在这一步之后单独跑一遍** —— 不重建容器它测的是**旧形态**（复核③）：
```bash
node tools/conformance/dist/run.js slice-07.2-hardening   # 含 S7 运行态泄敏采样
```
Expected: 全绿（10 类危险模式 0 命中）

- [ ] **Step 3: 提交**

```bash
git add tools/conformance/src/slices/slice-12-manual-join.ts
git commit -m "test(conformance): 判据 7（跨 RPC 串链）+ S7 泄敏在重建后复检"
```

---

## Task 14：门禁与文档回填

- [ ] **Step 1: 全量门禁**

```bash
pnpm run ci                                        # 六阶段
cd apps/client && pnpm run build:app && cd -       # DONE
node tools/conformance/dist/run.js slice-12        # 真栈
CHROME_BIN="C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe" \
  node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate   # 18/18
# full 同形（~4min）
```
Expected: `ci` 六阶段全过（⚠️ 若红在 `game-service#test` 的 `game.controller`「fetch failed」⇒ 那是**已知偶发红**，**整包单跑**确认后再复跑）· 探针 `gate` 18/18 且 `full` 33/33（⚠️ `full` 的判据 30 有已知偶发，见片⑥ 规格 §8-⑤）

- [ ] **Step 2: 判据只增不减核对**（各包条数不减少；`slice-12` 59 → 62+）

- [ ] **Step 3: 回填文档**

1. `docs/design.md` §15.3 加 **`[已实现]`**（与 §13.5 的 `[已修复]` 同形），并写明本片 `R1101–R1110`
2. `docs/superpowers/specs/2026-09-23-observability-logging-design.md` 加 **§10 完成状态**（逐条判据结果 + 实测数字 + 执行期发现）
3. `packages/*/src/main.ts` 的 sink 处保留 `R1102` 注释；`trace-context.ts` 保留 R1107 注释

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 可观测性（一）完成状态回填 —— 判据结果 + §15.3 标记（R1101-R1110）"
```

---

## Self-Review（写完计划后自查，已执行）

| 检查 | 结果 |
|---|---|
| **spec 覆盖** | §2 形状 → Task 1；§3 三套载体 → Task 4/5/6/11/12；§4 上限 → Task 8；§5 判据 1/2/2′/3 → Task 2 · 4 → Task 3 · 5 → Task 11 · 6 → Task 9 · 6′ → Task 5+9 · 7 → Task 12+13 · 8 → Task 13 · 9/9′ → Task 8 · 10 → Task 6 · 11 → Task 7+9 ✓ 全有归属 |
| **占位符扫描** | 无 TBD/TODO；每个代码步骤都有真实代码；两处"依赖方向要当场核"给了**默认做法**（`RpcMetaLike` 结构化类型），不是待定 |
| **类型一致性** | `TraceContext`/`runWithTrace`/`currentTrace`（Task 1）→ Task 2/4/5/7/12 逐字一致；`LogSink`（Task 2）→ Task 3；`createTraceMiddleware(options)`（Task 4）→ Task 6；`RpcMeta`（Task 10）→ Task 11/12 |
| **已知风险** | ① Task 3 会让既有断言变红 ⇒ 步骤写明"逐条 Edit，不得用 python" ② Task 8/9/13 需要重建容器 ③ `shared → protocol` 依赖方向**已核**（shared 本来就依赖它）⇒ Task 11 无退路分支 |
