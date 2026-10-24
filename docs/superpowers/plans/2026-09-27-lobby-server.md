# 玩法大厅 / 开始游戏 —— 计划 A「服务端」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「档位表」成为一个**服务端权威的、可后台改的**配置：DB 表 + 读接口 + 服务间 RPC + 匹配/建房两条路上真的按底分走。

**Architecture:** 表存 `user-service` 的库（那里已有全套 TypeORM 迁移基础设施）；`room-service` 通过 **`Transport.TCP` RPC** 读它（不动 room-service「纯 Redis」的依赖格局）。本计划**不含任何 App 侧改动** —— 客户端在计划 B。

**Tech Stack:** NestJS 10 + TypeORM + MySQL（user-service）· ioredis（room-service）· `@nestjs/microservices` `Transport.TCP` · vitest。

**规格**：`docs/superpowers/specs/2026-09-27-lobby-start-game-design.md` §2（本计划是它的实施）

---

## Global Constraints

- 🔴 **`room-service` 保持纯 Redis**：本计划**不得**给它加任何 DB 驱动 / TypeORM / `DB_HOST`。
- 🔴 **`mode` 这个词已经指「房间模式」**（`room.match.payload.mode` = `random`/`practice`、`RoomInfo.mode` 同）。
  **不得**引入第二个叫 `mode` 的东西（「玩法」不叫 mode）。
- 🔴 **RPC 契约**：pattern 名**必须**从 `packages/protocol/src/rpc.ts` 的 `RPC_PATTERNS` 取（**不得**手写字面量 —— 有判据钉着）；
  handler **返回 `RpcResult<T>` 信封、不抛业务错误**（R220）；**每处出站调用必须带超时**（`outbound-timeout.gate` 是既有闸）。
- 🔴 **RPC 失败不得静默放行**：拿不到档位表 ⇒ **`10007 UPSTREAM_UNAVAILABLE`，请求失败**。**绝不能**「拿不到就跳过校验」。
- 🔴 **端口**：`docs/design.md` §2.1 约定「3000 段 HTTP / 3100 段 RPC」⇒ `user-service` 的 **HTTP 3001** ⇒ **RPC 3101**。
  RPC 端口**只在 compose 内网可达**（`expose`，**不是** `ports`）。
- 🔴 **依赖变更**：给 `user-service` 加 `@nestjs/microservices` ⇒ **`pnpm-lock.yaml` 必须同 PR 更新**
  （`scripts/ci.sh` 第 1 阶段是 `pnpm install --frozen-lockfile`）。
- **每次改动一个 commit**（CLAUDE.md）。
- ⚠️ **本机没有 `flock` 与 `script(1)`** ⇒ 相关判据在本机显式跳过，**别把「本机绿」当成「全绿」**。

## 范围外（**本计划不做**）

| 项 | 为什么 |
|---|---|
| 任何 App / 客户端改动 | 计划 B |
| 后台设置页面（写接口 + 权限） | 另立一片（规格 §1） |
| 牌桌、协议③④⑥ | 规格 §1 |

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/user-service/src/config/base-score-level.entity.ts` | 新建 | TypeORM 实体 |
| `packages/user-service/src/config/base-score-levels.service.ts` | 新建 | 读表（**每次查库，不缓存**） |
| `packages/user-service/src/config/base-score-levels.controller.ts` | 新建 | REST `GET /api/base-score-levels` |
| `packages/user-service/src/config/config.module.ts` | 新建 | 把上面三个接起来 |
| `packages/user-service/src/migrations/1789100000000-BaseScoreLevels.ts` | 新建 | 建表 + 塞缺省四档 |
| `packages/user-service/src/app.module.ts` | 修改 | 挂 `ConfigModule` |
| `packages/user-service/src/main.ts` | 修改 | 加 TCP 微服务监听（3101） |
| `packages/user-service/src/rpc/base-score-levels.rpc.controller.ts` | 新建 | `@MessagePattern` 供 room-service 读 |
| `packages/protocol/src/rpc.ts` | 修改 | 加 pattern + 请求/响应类型 |
| `packages/room-service/src/gateway/config.client.ts` | 新建 | room → user 的 TCP client |
| `packages/room-service/src/rooms/rooms.service.ts` | 修改 | `create()` 校验 `baseScore` |
| `packages/room-service/src/match/match.service.ts` | 修改 | 队列键多一维 + 穿线 + **兜底改 SCAN** |
| `packages/room-service/src/match/match.module.ts` | 修改 | 注入 config client |
| `packages/room-service/src/gateway/message.router.ts` | 修改 | `room.match` 传 `baseScore` |
| `packages/protocol/src/messages.ts` · `validate.ts` | 修改 | `room.match` 加 `baseScore`（**必填**） |
| `packages/shared/src/ddz/game.ts` | 修改 | `DEFAULT_BASE_SCORE` 100 → 15 |
| `docker-compose.yml` | 修改 | user-service 加 `RPC_PORT` + 暴露 3101 |
| `docs/design.md` | 修改 | §2.1 端口表 + §2.3 env 表 + §7.1 路由表 |

---

## Task 1: 档位表 + 读接口

**Files:**
- Create: `packages/user-service/src/config/base-score-level.entity.ts` · `base-score-levels.service.ts` · `base-score-levels.controller.ts` · `config.module.ts` · `packages/user-service/src/migrations/1789100000000-BaseScoreLevels.ts`
- Modify: `packages/user-service/src/app.module.ts` · `packages/api-gateway/src/gateway/gateway.controller.ts` · `docs/design.md`（§7.1 路由表）
- Test: `packages/user-service/test/base-score-levels.test.ts`

**Interfaces:**
- Consumes: 无（本计划第一个任务）
- Produces: `BaseScoreLevelsService.list(): Promise<{ name: string; baseScore: number }[]>` · REST `GET /api/base-score-levels` → `{ code:0, data:{ levels } }` · 实体 `BaseScoreLevel`

- [ ] **Step 1: 写会红的测试**

新建 `packages/user-service/test/base-score-levels.test.ts`：

```ts
/**
 * 档位表（规格 §2.2/§2.3）。
 *
 * ⚠️ 射程：这是**单测**，桩掉 repository —— 它证明「信封形状 + 过滤 + 排序」，
 * **不证明**「库里真的有那四行」（那是迁移的事，见 `migration.test.ts` 与本文件 ②）。
 */
import { describe, it, expect, vi } from 'vitest';
import { BaseScoreLevelsService } from '../src/config/base-score-levels.service';

describe('档位表服务（规格 §2.3）', () => {
  it('① 只返 enabled=1、按 sortOrder 升序、形状是 {name, baseScore}', async () => {
    const rows = [
      { name: '豪侠场', baseScore: 1200, sortOrder: 4, enabled: 1 },
      { name: '休闲场', baseScore: 15, sortOrder: 1, enabled: 1 },
      { name: '停用场', baseScore: 999, sortOrder: 2, enabled: 0 },
      { name: '标准场', baseScore: 80, sortOrder: 2, enabled: 1 },
    ];
    const repo = { find: vi.fn().mockResolvedValue(rows) };
    const svc = new BaseScoreLevelsService(repo as never);

    const got = await svc.list();

    expect(got).toEqual([
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
      { name: '豪侠场', baseScore: 1200 },
    ]);
    // 判别力自证：停用的那条**必须不在**（否则上面的 toEqual 也能过 —— 它不会，
    // 但这条把「为什么」写下来：过滤是实测的，不是碰巧）
    expect(got.map((l) => l.name)).not.toContain('停用场');
  });

  it('② 每次调用都真的查库（**不缓存** —— 否则「后台改了要生效」会变成「改了要重启」）', async () => {
    const repo = { find: vi.fn().mockResolvedValue([]) };
    const svc = new BaseScoreLevelsService(repo as never);
    await svc.list();
    await svc.list();
    expect(repo.find).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 跑它 —— 确认红**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/user-service test -- base-score-levels
```
预期：**FAIL**，`Cannot find module '../src/config/base-score-levels.service'`。

- [ ] **Step 3: 建实体**

`packages/user-service/src/config/base-score-level.entity.ts`：

```ts
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 底分档位表（规格 §2.2）。**这是档位表的唯一真源** —— 前端一个数字都不写（M09）。
 *
 * ⚠️ **刻意没有 `mode` 列**：规格 §7 记着理由 —— 服务端现在**没有「玩法 id」这个概念**
 * （`RoomInfo.mode` 是**房间模式**，不是玩法），加一列会凭空造一个跨前后端的约定。
 * 只有 1 个玩法时「该玩法的底分」= 全局。
 */
@Entity('base_score_levels')
export class BaseScoreLevel {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 场次名（中文，如「休闲场」）。 */
  @Column({ type: 'varchar', length: 32 })
  name!: string;

  /** 底分。UNIQUE（同一张表里不重复）。 */
  @Column({ name: 'base_score', type: 'int', unique: true })
  baseScore!: number;

  /** 展示顺序（大厅右侧横滑的顺序）。 */
  @Column({ name: 'sort_order', type: 'int' })
  sortOrder!: number;

  /** 停用而不删。 */
  @Column({ type: 'tinyint', width: 1, default: 1 })
  enabled!: number;
}
```

- [ ] **Step 4: 建服务**

`packages/user-service/src/config/base-score-levels.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BaseScoreLevel } from './base-score-level.entity';

/** 下发给客户端的形状（规格 §2.3）。 */
export interface BaseScoreLevelDto {
  name: string;
  baseScore: number;
}

/**
 * 档位表读取。
 *
 * 🔴 **每次调用都查库，刻意不缓存**（规格 §2.3）—— 进程内缓存会把
 * 「后台改了要生效」变成「**改了要重启**」，而那正是引入 DB 存储要避免的事。
 * 表小（4 行）、调用低频（进大厅才调一次）⇒ 直接查最省心也最正确。
 */
@Injectable()
export class BaseScoreLevelsService {
  constructor(
    @InjectRepository(BaseScoreLevel)
    private readonly repo: Repository<BaseScoreLevel>,
  ) {}

  async list(): Promise<BaseScoreLevelDto[]> {
    const rows = await this.repo.find({
      where: { enabled: 1 },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    return rows.map((r) => ({ name: r.name, baseScore: r.baseScore }));
  }

  /** 供校验用：某个底分是否属于**当前生效的**档位表（规格 §2.4 协议⑤）。 */
  async isKnown(baseScore: number): Promise<boolean> {
    const rows = await this.repo.find({ where: { enabled: 1 } });
    return rows.some((r) => r.baseScore === baseScore);
  }
}
```

- [ ] **Step 5: 建控制器与模块**

`packages/user-service/src/config/base-score-levels.controller.ts`：

```ts
import { Controller, Get } from '@nestjs/common';
import { BaseScoreLevelsService } from './base-score-levels.service';

/**
 * `GET /api/base-score-levels`（规格 §2.3）。
 *
 * ⚠️ **不鉴权由本控制器管**：网关的公开白名单**恰好五条**（`auth/login`、`auth/register`、
 * `auth/refresh`、`health`、`health/live`），这条**不在**里面 ⇒ 网关验签后才转发到这儿。
 * 控制器侧不需要额外装饰器。
 *
 * ⚠️ **响应是平台统一信封**（§11.1）：`{ code: 0, data: { levels } }`，**不是**裸数组。
 */
@Controller('base-score-levels')
export class BaseScoreLevelsController {
  constructor(private readonly levels: BaseScoreLevelsService) {}

  @Get()
  async get(): Promise<{ code: number; data: { levels: { name: string; baseScore: number }[] } }> {
    return { code: 0, data: { levels: await this.levels.list() } };
  }
}
```

`packages/user-service/src/config/config.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BaseScoreLevel } from './base-score-level.entity';
import { BaseScoreLevelsService } from './base-score-levels.service';
import { BaseScoreLevelsController } from './base-score-levels.controller';

@Module({
  imports: [TypeOrmModule.forFeature([BaseScoreLevel])],
  controllers: [BaseScoreLevelsController],
  providers: [BaseScoreLevelsService],
  exports: [BaseScoreLevelsService],
})
export class ConfigModule {}
```

- [ ] **Step 6: 挂进 AppModule**

`packages/user-service/src/app.module.ts` —— 在 `imports` 数组里**照 `UsersModule` 同形**加一项 `ConfigModule`，
并在文件顶部加 `import { ConfigModule } from './config/config.module';`。

⚠️ **不要**叫它 `ConfigModule` 之外的名字：`@nestjs/config` 也叫 `ConfigModule`，
若本项目将来引它，**必须**用别名导入（`import { ConfigModule as AppConfigModule } from './config/config.module';`）。
本步先照现状写，若 `app.module.ts` 里已存在 `ConfigModule` 这个名字就改叫 **`BaseScoreConfigModule`**。

- [ ] **Step 7: 建迁移（建表 + 塞缺省四档）**

`packages/user-service/src/migrations/1789100000000-BaseScoreLevels.ts`：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 底分档位表（规格 §2.2）。
 *
 * ⚠️ **形状逐字照 `InitialUsers1789000000000`**：类名 `<Name><timestamp>`、
 * `name` 属性与类名一致、SQL 用 `CREATE TABLE IF NOT EXISTS`。
 * `charset=utf8mb4` 与排序规则**必须**一致 —— 场次名是中文。
 *
 * ⚠️ **种子写在本迁移里**（规格 §2.2）：迁移只跑一次（TypeORM 记在 `migrations` 表），
 * 所以直接 `INSERT` 即可，不需要幂等写法。
 */
export class BaseScoreLevels1789100000000 implements MigrationInterface {
  name = 'BaseScoreLevels1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `base_score_levels` (' +
        '`id` int NOT NULL AUTO_INCREMENT, ' +
        '`name` varchar(32) NOT NULL, ' +
        '`base_score` int NOT NULL, ' +
        '`sort_order` int NOT NULL, ' +
        '`enabled` tinyint(1) NOT NULL DEFAULT 1, ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `IDX_base_score_levels_base_score` (`base_score`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'INSERT INTO `base_score_levels` (`name`, `base_score`, `sort_order`, `enabled`) VALUES ' +
        "('休闲场', 15, 1, 1), ('标准场', 80, 2, 1), ('竞技场', 480, 3, 1), ('豪侠场', 1200, 4, 1)",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `base_score_levels`');
  }
}
```

- [ ] **Step 8: 迁移真的建出表（进 `migration.test.ts`）**

在**既有**的 `packages/user-service/test/migration.test.ts` 里加一条（照该文件既有用例的形状）：
断言 `src/migrations/` 下存在一个类名匹配 `/^BaseScoreLevels\d+$/` 的迁移，且它的 `up` 里
含 `CREATE TABLE IF NOT EXISTS \`base_score_levels\`` 与四条 `INSERT` 的场次名。

⚠️ **若 `migration.test.ts` 用的是真 DB**（而不是源码扫描），就改成**真跑迁移后 `SELECT` 出四行**——
**先读那个文件再决定**，不要照抄本步的假设。

- [ ] **Step 9: 跑测试 —— 转绿**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/user-service test -- base-score-levels
pnpm --filter @fight-the-landlord/user-service test
```
预期：新用例 2/2 通过；整包绿。

- [ ] **Step 10: 网关加路由**

`packages/api-gateway/src/gateway/gateway.controller.ts` —— 在 **Room routes 之前**（`@Get('rooms')` 那一行**上面**）插入：

```ts
  // 底分档位表（片规格 §2.3）。⚠️ **必须声明在 `@Get('rooms')` 之前** ——
  // 静态路由必须先于同前缀的根路由（同类坑见 `packages/api-gateway/src/health/health.controller.ts:7`）。
  // ⚠️ 它转发到 **user-service**（那里有 DB），**不是** room-service —— 路由名与目标服务不一致是刻意的。
  @Get('base-score-levels')
  async getBaseScoreLevels(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('GET', '/api/base-score-levels', null, res, headersOf(req));
  }
```

⚠️ **先读 `proxy.gateway.ts` 确认 `forwardToUserSvc` 的签名与本步写的一致**（`forwardToRoomSvc` 是同一个形状，
但**不要**照抄假设 —— 逐个参数核）。

- [ ] **Step 11: 补 `docs/design.md` §7.1 的路由表**

在 §7.1 的路由清单里加一条，**加在 user-service 那一组**（不是 rooms 那组）：

```markdown
- `GET /api/base-score-levels` → 转发 **user-service**（底分档位表；片规格 §2.3）。
  ⚠️ 声明顺序**必须**在 `@Get('rooms')` 之前（静态先于根）。
```

- [ ] **Step 12: 跑全门禁**

```bash
cd d:/Code/pokergame
pnpm run ci
```
预期：六阶段全绿。⚠️ 本步动了 `api-gateway`（有 `no-route-outside-api.gate` 与 `container-assembly.gate` 盯着）——
若它们红了，**先读闸的断言再改代码**，不要为迁就实现改闸。

- [ ] **Step 13: Commit**

```bash
cd d:/Code/pokergame
git add packages/user-service packages/api-gateway docs/design.md
git commit -m "feat(server): 底分档位表 + GET /api/base-score-levels（片规格 §2.2/§2.3）"
```

---

## Task 2: 服务间 TCP RPC + 建房校验（协议⑤）

**Files:**
- Modify: `packages/protocol/src/rpc.ts` · `packages/user-service/src/main.ts` · `packages/room-service/src/rooms/rooms.service.ts` · `packages/room-service/src/rooms/rooms.module.ts` · `docker-compose.yml` · `docs/design.md`（§2.1 端口表 + §2.3 env 表）
- Create: `packages/user-service/src/rpc/base-score-levels.rpc.controller.ts` · `packages/room-service/src/gateway/config.client.ts`
- Test: `packages/room-service/test/rooms.base-score.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BaseScoreLevelsService.isKnown(baseScore)`（**注意：RPC 侧只暴露 `levels`，`isKnown` 留在服务内部**）
- Produces: `RPC_PATTERNS.baseScoreLevels` = `'config.baseScoreLevels'` · `BaseScoreLevelsRequest` / `BaseScoreLevelsResponse` · `ConfigClient.levels()`（room-service 侧）

- [ ] **Step 1: 协议加一条 pattern 与两个类型**

`packages/protocol/src/rpc.ts` —— 在 `RPC_PATTERNS` 里加一项（**照现有条目的注释密度**）：

```ts
  /** room → user：底分档位表（片规格 §2.1）。⚠️ 这是**唯一**一条 room→user 的边。 */
  baseScoreLevels: 'config.baseScoreLevels',
```

并在文件末尾加：

```ts
/** room → user：底分档位表请求（无参数 —— 只有 1 个玩法，规格 §7 记着为什么不带 mode）。 */
export interface BaseScoreLevelsRequest {
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**）。 */
  meta?: RpcMeta;
}

/** room → user：底分档位表响应（与 REST 同一形状，规格 §2.3）。 */
export interface BaseScoreLevelsResponse {
  levels: { name: string; baseScore: number }[];
}
```

⚠️ `messages.test.ts` 有一条「pattern 名逐字」的判据 ⇒ 改完**必须**跑 `pnpm --filter @fight-the-landlord/protocol test`。

🔴 **同时要改 `docs/design.md` §4.2 的调用表**（本步的**一半**在这里）：加一条 `room → user` 的边
（`config.baseScoreLevels`），并说明「这是**唯一**一条 room→user 的边」。
**不加的话**：那条「pattern 名逐字」的判据会红，而且规格面（§4.1 的调用表）与代码就不一致了 ——
本仓把「调用表」当**真源**用，`no-internal-http.gate` 就是照它写的。

- [ ] **Step 2: user-service 加 TCP 微服务监听**

`packages/user-service/src/main.ts` —— 在 `await app.listen(port);` **之前**插入：

```ts
  // 片规格 §2.1：room-service 要读底分档位表（它自己没有 DB）。
  // ⚠️ **RPC 端口只在 compose 内网可达**（`expose`，不是 `ports`）—— 照 game/robot 的处理。
  // ⚠️ 端口字面量只作缺省，真值走 `RPC_PORT`（同 §2.3「禁止硬编码端口」的纪律）。
  app.connectMicroservice({
    transport: Transport.TCP,
    options: { host: '0.0.0.0', port: parseInt(process.env.RPC_PORT ?? '3101') },
  });
  await app.startAllMicroservices();
```

并在文件顶部加 `import { Transport } from '@nestjs/microservices';`。

🔴 **同时**：`packages/user-service/package.json` 的 `dependencies` 加 `"@nestjs/microservices": "^10.4.0"`
（**版本照 `game-service` 的写法**），然后 `pnpm install` ⇒ **lockfile 会变，必须一起提交**。

- [ ] **Step 3: user-service 的 RPC 控制器**

`packages/user-service/src/rpc/base-score-levels.rpc.controller.ts`：

```ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { RPC_PATTERNS, type BaseScoreLevelsResponse, type RpcResult } from '@fight-the-landlord/protocol';
import { BaseScoreLevelsService } from '../config/base-score-levels.service';

/**
 * room → user 的 RPC 监听方（片规格 §2.1）。
 *
 * ⚠️ **返回 `RpcResult<T>` 信封、不抛业务错误**（R220）：Nest 的 `RpcException` 到客户端只剩
 * 字符串 `message`，5 位数字码会丢，而调用方要按码分流。
 *
 * ⚠️ **与 REST 面不共用方法**（Global Constraint 4 的同族纪律）：本控制器只被
 * `@MessagePattern` 调用；`BaseScoreLevelsController` 的 HTTP 面走它自己的 `get()`。
 * 两侧唯一共享的是 `BaseScoreLevelsService`。
 */
@Controller()
export class BaseScoreLevelsRpcController {
  constructor(private readonly levels: BaseScoreLevelsService) {}

  @MessagePattern(RPC_PATTERNS.baseScoreLevels)
  async list(@Payload() _req: unknown): Promise<RpcResult<BaseScoreLevelsResponse>> {
    try {
      return { ok: true, data: { levels: await this.levels.list() } };
    } catch (e) {
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
```

⚠️ 顶部补 `import { ErrCode } from '@fight-the-landlord/protocol';`。
把本控制器加进 Task 1 的 `config.module.ts` 的 `controllers`。
⚠️ **真读一遍 `packages/robot-service/src/rpc/robot.rpc.controller.ts` 与 `to-result.ts`** ——
它是 R220 信封的既有实现；**若它用了共享的 `toResult()` 辅助函数，就复用它，不要另写一份**。

- [ ] **Step 4: room-service 的 config client**

`packages/room-service/src/gateway/config.client.ts` —— **照 `game.client.ts` 逐字同形**
（`ClientProxy` + `lastValueFrom` + `timeout` + `RpcResult` 解包 + 传输故障映射成 `10007`），
只把 pattern、超时与错误类型换掉：

```ts
/** 读底分档位表的超时（规格 §2.3 的低频读；比 game 的 2s 宽一点，因为它还可能等 DB）。 */
const CONFIG_CLIENT_TIMEOUT_MS = 3000;
```

方法：

```ts
  /** 读档位表。⚠️ **失败时抛**（不返回空数组）—— 拿不到表**绝不能**被当成「没有档位」。 */
  async levels(): Promise<{ name: string; baseScore: number }[]>
```

- [ ] **Step 5: 建房的 baseScore 校验**

`packages/room-service/src/rooms/rooms.service.ts` 的 `create()`（`:165-185`）——
在 `const code = ...` 之前插入：

```ts
    // 片规格 §2.4 协议⑤：底分**必须属于档位表**。
    // 🔴 **拿不到档位表就失败，绝不静默放行** —— 否则非法值直接绕过校验。
    // 不传 baseScore 时走缺省，不校验（缺省值不来自客户端）。
    if (dto.baseScore !== undefined) {
      const known = (await this.configClient.levels()).some((l) => l.baseScore === dto.baseScore);
      if (!known) throw new DomainError(ErrCode.BAD_PARAM, '底分不属于档位表');
    }
```

⚠️ 构造器加 `private readonly configClient: ConfigClient`，`rooms.module.ts` 里提供它
（**照 `GameClient` 在本模块的接线方式**）。

- [ ] **Step 6: compose 与端口表**

`docker-compose.yml` 的 user-service 块：加 `- RPC_PORT=3101` 到 environment，
并加**内网暴露**（照 game-service 的写法 —— `expose` 那一段）：
```yaml
    expose:
      - "3001"
      - "3101"
```

`docs/design.md` §2.1 的端口表：user-service 行的「内部 RPC 端口」由 `—` 改成 **`3101`**。
§2.3 的 env 表：`RPC_PORT` 那行的服务列加 `user-service`，取值加 `3101`。

- [ ] **Step 7: 写会红的测试（校验拒非法值）**

`packages/room-service/test/rooms.base-score.test.ts`：桩掉 `ConfigClient.levels` 返回
`[{name:'休闲场',baseScore:15}]`，然后：

```ts
  it('非法 baseScore 被拒（BAD_PARAM），非法值不得落库', async () => {
    await expect(svc.create({ mode: 'random', baseScore: 999 })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
  });

  it('合法 baseScore 通过', async () => {
    const room = await svc.create({ mode: 'random', baseScore: 15 });
    expect(room.baseScore).toBe(15);
  });

  it('🔴 拿不到档位表 ⇒ 抛错，**不得**静默放行（否则非法值绕过校验）', async () => {
    configClient.levels.mockRejectedValue(new Error('rpc down'));
    await expect(svc.create({ mode: 'random', baseScore: 999 })).rejects.toThrow();
  });

  it('不传 baseScore 走缺省、不校验', async () => {
    const room = await svc.create({ mode: 'random' });
    expect(configClient.levels).not.toHaveBeenCalled();
  });
```

⚠️ **夹具照 `rooms.service.test.ts` 的既有形状**（它有 `makeMockRoomsService` 那类辅助）——
**先读它再写**，不要另造一套。

- [ ] **Step 8: 跑测试 → 绿 · 跑门禁 · Commit**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/room-service test -- rooms.base-score
pnpm run ci
git add -A
git commit -m "feat(server): user-service TCP RPC + 建房底分校验（片规格 §2.1/§2.4 协议⑤）"
```

---

## Task 3: 匹配带底分（协议②）+ 缺省底分 100→15

**Files:**
- Modify: `packages/protocol/src/messages.ts` · `packages/protocol/src/validate.ts` · `packages/room-service/src/match/match.service.ts` · `packages/room-service/src/gateway/message.router.ts` · `packages/shared/src/ddz/game.ts`
- Test: `packages/room-service/test/match.service.test.ts`（加用例）· 受 `DEFAULT_BASE_SCORE` 影响的既有测试

**Interfaces:**
- Consumes: Task 2 的 `ConfigClient`
- Produces: `matchQueueKey(mode, region, baseScore)` · `MatchTicket.baseScore` · `addToQueue(playerId, mode, baseScore, region?)` · `cancelQueue(playerId)`

- [ ] **Step 1: 协议改 `room.match`（**必填**）**

`packages/protocol/src/messages.ts:41`：

```ts
  | { type: 'room.match'; meta: RequestMeta; payload: { mode: 'random' | 'practice'; baseScore: number } }
```

`packages/protocol/src/validate.ts` 的 `case 'room.match'` 分支 —— 保留 mode 校验，**加**：

```ts
      // 片规格 §2.4 协议②：baseScore **必填**。可选的话撮合键那一维可能是 undefined、
      // 产生两种 key；必填让「不同底分不会同房」在类型上就成立。
      assertNum(p.baseScore, '$.payload.baseScore');
```

- [ ] **Step 2: 撮合队列多一维**

`packages/room-service/src/match/match.service.ts:58`：

```ts
/**
 * 匹配队列键（§8.1 + 片规格 §2.4）。**维度含底分** —— 不同底分的人**不会**被撮进同一个房。
 * 参数顺序 `(mode, baseScore, region)`；键里 baseScore 在 region 之前。
 */
export function matchQueueKey(mode: MatchMode, baseScore: number, region = DEFAULT_REGION): string {
  return `match:queue:${mode}:${baseScore}:${region}`;
}
```

`MatchTicket` 加 `baseScore: number`；`readMeta` 里 `baseScore: Number(raw.baseScore ?? 0)`；
`addToQueue(playerId, mode, baseScore, region = DEFAULT_REGION)` 写进 hash（`baseScore: String(baseScore)`）。

- [ ] **Step 3: 🔴 兜底循环改成 `SCAN`（**规格没覆盖，这里定**）**

`cancelQueue` 现在的兜底是「遍历所有 `(mode, region)`」—— 加了底分维度后，它需要**知道所有底分**，
而 room-service 不查表（那是 RPC，而且 meta 丢失时正是最不该再依赖别的服务的时候）。

⇒ **改用 `SCAN match:queue:*` 穷举**：

```ts
  async cancelQueue(playerId: string): Promise<void> {
    const meta = await this.readMeta(playerId);
    if (meta) {
      await this.redis.zrem(matchQueueKey(meta.mode, meta.baseScore, meta.region), playerId);
    } else {
      // ⚠️ **兜底改 SCAN**（片规格 §2.4）：原来遍历 `(mode, region)`，加了底分维度后
      // 需要「知道所有底分」，而 room-service 不查表（那是 RPC —— meta 丢失时正是不该
      // 再依赖别的服务的时候）。`SCAN` 穷举**不依赖任何外部状态**，且这条路径罕见。
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'match:queue:*', 'COUNT', 100);
        cursor = next;
        for (const k of keys) await this.redis.zrem(k, playerId);
      } while (cursor !== '0');
    }
    await this.redis.del(matchMetaKey(playerId));
  }
```

⚠️ **必须有一条用例证明 SCAN 兜底真的清干净**（meta 不存在时也能出队）。

- [ ] **Step 4: 消息路由把 baseScore 传下去**

`packages/room-service/src/gateway/message.router.ts` 的 `room.match` 分支 ——
把 `payload.baseScore` 传给 `addToQueue`。⚠️ **先 grep `addToQueue(` 的所有调用点**（含测试），逐个改。

- [ ] **Step 5: 缺省底分 100 → 15**

`packages/shared/src/ddz/game.ts:12`：`export const DEFAULT_BASE_SCORE = 15;`

⚠️ **逐个核**下列受影响处（规格 §2.4 已核出的）：
- `packages/room-service/test/rooms.start.test.ts:215` `expect(start.baseScore).toBe(100); // DEFAULT_BASE_SCORE` ⇒ **改成读常量**
- `packages/game-service/test/game.service.test.ts:49,226` ⇒ **读一遍判断是夹具还是缺省**：夹具（显式传 100）不动；依赖缺省则改成读常量
- `packages/room-service/test/rooms.service.test.ts:77,80` 已读常量 ⇒ 自动跟随 ✅

- [ ] **Step 6: 写会红的撮合分组测试**

在 `packages/room-service/test/match.service.test.ts` 加：

```ts
  it('🔴 不同底分**不会**被撮进同一个房（片规格 §2.5）', async () => {
    // 三个人：两个 15、一个 480。若队列键少了底分那一维，三个会被撮到一起 —— 这条就会红。
    await svc.addToQueue('p1', 'random', 15);
    await svc.addToQueue('p2', 'random', 15);
    await svc.addToQueue('p3', 'random', 480);
    await svc.scanOnce();
    // 断言：p1/p2 进了同一个房；p3 **没有**进那个房
    // ⚠️ 具体的断言形状照本文件既有用例（它有 roomStart 的桩），不要另造。
  });
```

⚠️ **判别力自证**：把 `matchQueueKey` 的底分那一维去掉应让本用例红 —— 请**临时**试一次并在报告里写明结果。

- [ ] **Step 7: 跑测试 · 门禁 · Commit**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/protocol test
pnpm --filter @fight-the-landlord/room-service test
pnpm --filter @fight-the-landlord/shared test
pnpm run ci
git add -A
git commit -m "feat(server): room.match 必填 baseScore + 撮合按底分分组 + 缺省底分 15（片规格 §2.4）"
```

---

## Task 4: 验收（**需用户在场**）

- [ ] **Step 1: 起栈**

```bash
cd d:/Code/pokergame
docker compose up -d --build
```
⚠️ 本计划改了 `docker-compose.yml` 与 `package.json` ⇒ **必须 rebuild**，不能只 `restart`。

- [ ] **Step 2: 真栈判据 —— 「改了即生效」（规格 §2.5）**

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"phone":"13800000000","password":"<你的测试账号>"}' | python -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
curl -s localhost:3000/api/base-score-levels -H "Authorization: Bearer $TOKEN"
```
预期：`{"code":0,"data":{"levels":[{"name":"休闲场","baseScore":15},...]}}`

然后**不重启任何服务**，改一行 DB：
```bash
docker compose exec mysql mysql -uroot -p"$DB_PASSWORD" fight_the_landlord \
  -e "UPDATE base_score_levels SET name='休闲场改' WHERE base_score=15;"
```
再调一次同一个接口 ⇒ **必须看到「休闲场改」**。看到旧值 ⇒ **缓存没清干净，红**。

- [ ] **Step 3: 真栈判据 —— 非法底分被拒**

```bash
curl -s -X POST localhost:3000/api/rooms -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"mode":"random","baseScore":999}'
```
预期：`code` 是 `10001`。

- [ ] **Step 4: 把三条读数记进规格 §6 并 commit**

⚠️ 本任务的产出是**读数**，不是代码。记完 commit。

---

## Self-Review（写完计划后的自查）

**1. 规格覆盖**

| 规格节 | 落在哪 |
|---|---|
| §2.1 架构（B 方案 + 依赖 + 端口） | Task 2 Step 2/4/6 |
| §2.2 表结构 + 迁移 + 种子 | Task 1 Step 3/7/8 |
| §2.3 读接口 + 鉴权 + 不缓存 + 路由顺序 + §7.1 | Task 1 Step 4/5/10/11 + Step 1 的用例 ② |
| §2.4 协议②⑤ + RPC 失败不放行 + 常量 | Task 2 Step 5/7 + Task 3 Step 1/5 |
| §2.5 判据要点 | Task 3 Step 6（撮合分组）+ Task 4（真栈判据） |
| §5 判据记账（服务端那几行） | Task 2 Step 6（端口表）+ Task 3 Step 5（常量）|
| §6 验收 | Task 4 |
| §7 未来项 | 已在规格里，本计划不实现（正确） |

⚠️ **规格 §5 表里的客户端与探针那三行不在本计划** —— 它们是**计划 B** 的。这是拆分的结果，不是遗漏。

**2. 占位符扫描**：无 TBD/TODO。Task 3 Step 6 的测试代码给了骨架 + 明确说「断言形状照既有用例」
—— 那是**刻意的**：该文件的夹具（`roomStart` 桩）很长，照抄一份到计划里会与真源漂移。
**这不是占位符，是指向真源。**

**3. 类型一致性**：`matchQueueKey(mode, baseScore, region)` 的**参数顺序**（baseScore 在 region 之前）
在 Task 3 Step 2 定义、Step 3/4 使用，三处一致；`RPC_PATTERNS.baseScoreLevels` 在 Task 2 Step 1 定义、Step 3/4 使用；
`BaseScoreLevelsRequest`/`Response` 同。

**4. 一处**我在写计划时才发现、规格没覆盖的**：
Task 3 Step 3 的 **`cancelQueue` 兜底循环** —— 加了底分维度后它需要「知道所有底分」，
而 room-service 不查表。**改用 `SCAN` 穷举**，不新增 RPC 依赖（meta 丢失时正是最不该再依赖别的服务的时候）。
已写进计划并说明理由。**这是本会话第 N 处「规格没写完、计划补上」—— 记在这里供最终评审核对。**

---

## Task 3b: 匹配路径也要校验档位（**规格 §2.5 要求、计划漏了**）

**为什么有这一段**：规格 §2.5 的判据逐字写着「**非法 `baseScore` 被拒：`room.match` 与
`POST /api/rooms` 两条路都要测**」，而 Task 3 Step 1 只加了「有限数字」校验 ⇒
**匹配路径不校验档位**：传 `999` 会**建出一条只有它自己的毒化队列**，玩家等 60s 拿 `12007`。
Task 3 的实施者发现并如实上报（它按计划逐字做的，没做错）。

**Files:** Modify `packages/room-service/src/match/match.service.ts`（或 `message.router.ts` —— **先读，选单入口点**）· Test 同包

- [ ] **Step 1: 写会红的用例**

在 `packages/room-service/test/match.service.test.ts` 加：

```ts
  it('🔴 非档位底分被拒（规格 §2.5「两条路都要测」的匹配那条）', async () => {
    // 桩 ConfigClient.levels 返回四档之一，然后传一个不在表里的值
    await expect(svc.addToQueue('p1', 'random', 999)).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
  });

  it('🔴 拿不到档位表 ⇒ 抛错，不得静默放行', async () => {
    config.levels.mockRejectedValue(new Error('rpc down'));
    await expect(svc.addToQueue('p1', 'random', 15)).rejects.toThrow();
  });
```

⚠️ **夹具照本文件既有形状**（Task 3 已经在这里加过 ConfigClient 的桩 —— 复用它，别另造）。

- [ ] **Step 2: 跑它 —— 确认红**

- [ ] **Step 3: 在**单一入口点**校验**

选 `addToQueue`（它拥有队列）**或** `message.router.ts`（它拥有消息边界）——
**先读两处再定**，并在报告里说明为什么选那个。校验逻辑：

```
不属于档位表（ConfigClient.levels()）⇒ DomainError(BAD_PARAM)
ConfigClient 抛错 ⇒ 原样上抛（会被 CLIENT_ACTION 表处置；不得吞掉当成「表为空」）
```

⚠️ **不得**为此给 `addToQueue` 加缓存 —— 档位表可能被后台改（规格 §2.3）。

- [ ] **Step 4: 跑绿 · 门禁 · Commit**

```bash
pnpm --filter @fight-the-landlord/room-service test
pnpm run ci
git add -A
git commit -m "fix(server): 匹配路径也校验档位（规格 §2.5 要求、计划漏了）"
```

---

## Task 3c: 评审修复轮（Task 3/3b 评审的四条）

**用户裁决**：WS 面的错误码映射**现在就修**（不改成「接受 13001」）。

- [ ] **Step 1（Important · 用户已裁）**：`packages/room-service/src/gateway/message.router.ts:189-198`
  那段 catch 只翻译 `GameServiceError`，其余一律 `13001 ILLEGAL_ACTION` ⇒ **本片新可达**：
  非法底分、以及**拿不到档位表**时，客户端拿到的是 `13001` + **原样透传的内部消息**
  （`user-service unavailable: <详情>` 会当 toast 弹给玩家）。
  ⇒ 加 `DomainError` 分支，**与 HTTP 面的 `toHttpException` 对称**（`BAD_PARAM→10001`、
  `UPSTREAM_UNAVAILABLE→10007`），并**停止透传内部详情**。
  ⚠️ 本仓在 `message.router.ts:405-407` 已经**局部修过同类**一次 —— 照它的形状。
  ⇒ **要自带一套用例**（它改的是**所有** WS DomainError 的映射）。
- [ ] **Step 2（🔴 静默假绿）**：`tools/conformance/src/slices/slice-12-manual-join.ts:362`
  读 `ZSCORE match:queue:random:global` —— 那个键**现在不存在了** ⇒ 这条 CAS 断言
  **前后都空、恒绿**。改成新键形状（`match:queue:random:<baseScore>:global`）。
- [ ] **Step 3（一行·corr）**：`scanAndMatchInner` 的 `listQueueKeys()` 用 `new Set(keys)` 去重
  —— Redis `SCAN` **可能返回重复键**，重复那一轮会把 `attempts` 多加一次、
  提前耗掉 `MATCH_MAX_ATTEMPTS` 的重试预算。
- [ ] **Step 4（一行·pin）**：room-service 自己那份 `DEFAULT_BASE_SCORE`
  **没有被任何断言钉住**（改成 999 也不会红）⇒ 加一条断言把它钉到「属于档位表」或「=== shared 的常量」。
- [ ] **Step 5（两行·防第二真源）**：两份规格里的 `matchQueueKey` 签名已过期 ——
  `2026-09-27-lobby-start-game-design.md:80` 写 `(mode, region, baseScore)`、
  `2026-09-26-app-ui-rework-design.md:158` 还是两参形式；实现与 brief 都是 `(mode, baseScore, region)`。
- [ ] **Step 6**：跑 `pnpm --filter @fight-the-landlord/room-service test` + `pnpm run ci` + commit。

---

## Task 3d: 补上所有 `room.match` 发送方（**计划漏判的爆炸半径**）

**为什么有这一段**：协议② 把 `room.match` 的 `baseScore` 变成**必填**，而我的计划只写了
「grep 所有 `addToQueue` / `matchQueueKey` 调用点」—— **漏了「谁在发 `room.match`」**。
Task 3c 的实施者发现 **conformance 里还有 5 处**没带 `baseScore` ⇒ **整套真栈切片会全红**
（它们在 CI 的 `conformance` job 里跑，而那个 job 在 master/tag 上跑）。

**Files:** `tools/conformance/src/lib/ddz-driver.ts:119` · `slices/slice-05-reconnect.ts:86` ·
`slices/slice-07-match-join.ts:42/45/51/111` · `slices/slice-07.2-boundary.ts:162`（Task 3c 已修的
`slice-12` 除外）

- [ ] **Step 1: 穷举发送方（不要只看上面那份清单）**

```bash
grep -rn "room\.match" tools/ packages/ --include=*.ts | grep -v node_modules
```
**每一个** `emit('room.match', …)` 都要带 `baseScore`。⚠️ 连**测试夹具**与**探针**一起看。

- [ ] **Step 2: 取值**

用**档位表里的值**（`15` 最省事，且它是缺省档）—— ⚠️ **不要**塞一个不在档位表里的数字，
否则这些切片会在真栈上拿 `10001`（那就成了另一个假红）。

- [ ] **Step 3: 验证**

本机**跑不了真栈切片**（需要完整栈）⇒ 至少：
```bash
pnpm --filter @fight-the-landlord/client test   # 若有客户端发送方
pnpm run ci                                     # 六阶段（conformance 不在其中）
```
⚠️ **并在报告里如实写明：真栈切片本机未跑** —— 它们的验证落到 Task 4 或 CI。

- [ ] **Step 4: Commit**

---

## Task 3e: 修两处读旧值的真栈断言（**必须修，否则 conformance 在 master 上红**）

**为什么有这一段**：Task 3d 穷举时发现 conformance 里还有**两处读旧值**的断言：

- `tools/conformance/src/slices/slice-06-auth-rooms.ts:94` —— 断言 `baseScore === 100`
- `tools/conformance/src/slices/slice-10-settlement.ts:126` —— 断言默认底分 `100`

`DEFAULT_BASE_SCORE` 已改成 **15** ⇒ 这两处**在真栈上必红**，而 conformance 的 job
**在 master/tag 上跑** ⇒ 不修就是「合了就红」。

- [ ] **Step 1**：两处都改成**读缺省值的真实来源**（档位表里最小的那档 / `DEFAULT_BASE_SCORE`
  的等价物），**不要**再写死一个新数字 —— 否则下次改缺省又是同一个坑。
- [ ] **Step 2**：`pnpm run ci` 六阶段。
- [ ] **Step 3**：⚠️ **真栈切片本机跑不了** ⇒ 报告里**如实写明未跑**，验证落到 Task 4 / CI。
- [ ] **Step 4**：Commit。

---

## Task 3f: 最小客户端改动 —— 让 master 不坏（**用户裁决**）

**为什么有这一段**：协议② 把 `room.match` 的 `baseScore` 变必填，而客户端还发 `{mode:'random'}`
⇒ 本片一合，**App 点「随机匹配」会失败**（`10001`），真浏览器探针也跟着断。
⚠️ **不能写死一个底分数**（M09：前端不得含规则常量，`source-boundary.test.ts` 会当场红）
⇒ 最小正确解 = **取档位表的第一档**。这块代码计划 B 会直接复用（到那时它变成「用大厅选中的那档」）。

**Files:** Modify `apps/client/src/net/rest.ts`（加一个读函数）· `apps/client/src/pages/game/game.vue`（`match()`）· 相应测试

- [ ] **Step 1**：`rest.ts` 加一个函数，**照该文件既有函数的形状**（统一信封、`authedGet`）：

```ts
/** §2.3：底分档位表（片规格 §2.3）。⚠️ 它转发到 **user-service**。 */
export function baseScoreLevels(): Promise<RestResponse<{ levels: { name: string; baseScore: number }[] }>> {
  return authedGet<{ levels: { name: string; baseScore: number }[] }>('/base-score-levels');
}
```

⚠️ **先读 `rest.ts` 确认 `authedGet` 的签名**（它接受泛型、返回统一信封）。

- [ ] **Step 2**：`game.vue` 的 `match()` 里，**在 `send('room.match'` 之前**取第一档：

```ts
    // 片规格 §2.4 协议②：baseScore 必填。⚠️ **不得写死数字**（M09）—— 从服务端下发的档位表取。
    // 失败就如实报错、**不猜一个值**（猜就是前端规则常量）。
    const levels = await rest.baseScoreLevels();
    if (levels.code !== 0 || !levels.data?.levels?.length) {
      error.value = `档位表加载失败：${levels.message ?? `code=${levels.code}`}`;
      return;
    }
    const outcome = await getGameSession().client.send('room.match', {
      mode: 'random',
      baseScore: levels.data.levels[0].baseScore,
    });
```

⚠️ **`send('room.match'` 必须仍是一处**（`settlement-rematch.test.ts` ⑤ 数着它）。

- [ ] **Step 3**：跑**全部**客户端测试 + `pnpm run ci`。
  ⚠️ 找一遍**覆盖 `match()` 的测试**（`settlement-rematch` / `ui-flow` / `lobby-ux` …）——
  它们现在会因为多了一次 REST 调用而需要桩；**照各自既有形状补桩，不要弱化断言**。
- [ ] **Step 4**：Commit。

---

## Task 3g: 修复轮评审的四条（**用户裁决：I2 一起修**）

- [ ] **I1（我计划的错·且是 HTTP 面今天就有的泄漏）**：`rooms.service.ts:201` 抛
  `DomainError(UPSTREAM_UNAVAILABLE, '底分档位表不可用：${err.message}')` —— **内部详情嵌在消息里**，
  而 HTTP 面**原样透给客户端**。⇒ 照 `match.service.ts:238` 的做法**去掉内插**（详情只进日志）。
  并修 `message.router.ts:199-203` 那条**不成立的注释**（它说「DomainError 的消息按契约就是面向调用方的」，
  而同码下就有反例）。
- [ ] **I2（用户裁决·同一类泄漏）**：`GameServiceError` 分支仍把 `err.message` 原样透传，而
  `game.client.ts:174` 会构造 `game-service unavailable: <原因>`（传输失败时原因是 `ECONNREFUSED <ip:port>`）。
  ⇒ 🔴 **只改「传输层失败」那一条内插**（原因进日志、消息给固定的通用文案）；
  **业务错误（`RpcResult{ok:false}` 传来的）原样保留** —— 那些是客户端要显示的业务文案。
  ⚠️ **三个 client 一起看**（`game.client.ts` / `config.client.ts` / `robot.client.ts`），
  它们都有同形的内插。要自带用例。
- [ ] **I3（我计划的错·会误红）**：`slice-06-auth-rooms.ts:112-117` 断言的是「=== 最小档」，
  而规格 §2.3 **明确支持运维加一档更便宜的** ⇒ 那断言会**误红**。⇒ 改成**成员断言**
  （`levelValues.includes(mine?.baseScore)`），保住活读、去掉误红面。
- [ ] **I4（我 brief 的错）**：`game.vue` 的档位表 fetch 在 try/**finally** 里没有 catch ——
  而 H5 上 fetch 拒绝会**抛出**（`rest.ts:76-78` 记着）⇒ 静默失败 + unhandled rejection。
  ⇒ 照同文件 `loadRooms`（`game.vue:101-105`）的形状**补 catch**。brief 的意图就是「失败就如实报错」。
- [ ] **跑测 + `pnpm run ci` + commit**
