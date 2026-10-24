/**
 * **R565 正对照**：测试环境**真的**发出了产品侧的 DI 元数据吗？
 *
 * 为什么必须有这一条（而不是「拆完垫片全绿」就够）：
 * `emitDecoratorMetadata` 编译出的 `__metadata` 助手是
 * `if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v)`
 * —— **`reflect-metadata` 未先加载时它静默 no-op**。那种状态下：
 *   - 元数据又是 `undefined` ⇒ 本片目标未达成；
 *   - 但**其余用例可能仍然绿**（Nest 只在真需要注入时报错，很多用例直接 `new`）。
 * ⇒ 没有这条「直接读产品侧真实元数据」的判据，整片可能是一场**空测**（P14 教训 2 的同族）。
 *
 * ⚠️ 本文件**不得**出现 `Reflect.defineMetadata`：一旦写了，就变成「断言自己刚写进去的那份」，
 * 判别力归零（这正是 N41 要拆掉的形态）。机械闸（`no-di-metadata-shim.gate.test.ts`）也钉着这一点。
 *
 * 判据取值都是**产品真实契约**（不是测试为了方便写下的期望）：
 * `GameController` / `GameRpcController` 的构造参数是 `GameService`；
 * `GameService` 的构造参数是 `Redis`（`@Inject(Redis)`，见 `game.service.ts` 的 R284 注释）。
 */
import 'reflect-metadata';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { GameController } from '../src/game/game.controller';
import { GameRpcController } from '../src/rpc/game.rpc.controller';
import { GameService } from '../src/game/game.service';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';

const paramTypesOf = (target: object): unknown[] =>
  (Reflect.getMetadata('design:paramtypes', target) ?? []) as unknown[];

describe('R565 正对照：测试环境真的发出 DI 元数据（N41 / P18）', () => {
  it('`GameController` / `GameRpcController` 的 `design:paramtypes` 是**真实**的 `[GameService]`（非 undefined）', () => {
    // 判别力的根基：先是**非 undefined** —— 只断言长度会掩盖 `undefined ⇒ []` 的形态。
    expect(Reflect.getMetadata('design:paramtypes', GameController)).not.toBeUndefined();
    expect(Reflect.getMetadata('design:paramtypes', GameRpcController)).not.toBeUndefined();

    expect(paramTypesOf(GameController)).toEqual([GameService]);
    expect(paramTypesOf(GameRpcController)).toEqual([GameService]);
  });

  it('`HealthController` 的 `design:paramtypes` 是 `[HealthService]`（与 `health.test.ts` 的容器门禁同源）', () => {
    expect(paramTypesOf(HealthController)).toEqual([HealthService]);
  });

  it('`GameService` 的构造参数元数据是 `[Redis]`，且 `@Inject(Redis)` 的显式 token 也真的落下（R284）', () => {
    // 构造参数的类型元数据（`emitDecoratorMetadata` 的产物）
    expect(Reflect.getMetadata('design:paramtypes', GameService)).not.toBeUndefined();
    expect(paramTypesOf(GameService)).toEqual([Redis]);

    // `@Inject(...)` 落的是**参数装饰器元数据**（Nest 的 `SELF_DECLARED_DEPS_METADATA`）：
    // 本仓是「显式 `@Inject` 优先」的写法（见 `game.service.ts` 的注释）——
    // 这条与上一条并列，证明**两条通道都真的发出了**，而不只是 paramtypes。
    const selfDeps = Reflect.getMetadata('self:paramtypes', GameService) as
      | Array<{ index: number; param: unknown }>
      | undefined;
    expect(selfDeps).toBeDefined();
    expect(selfDeps).toContainEqual({ index: 0, param: Redis });
  });
});
