# 切片 6 实施计划：登录 + 房间列表

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「注册 → 登录 → 房间列表 → 刷新令牌 → 登出」这条全真实链路，并把令牌从「7 天一次性发放」改成 §5.1 规定的 **access 2h + refresh 7d + `session:{jti}` 可吊销白名单**。

**Architecture:** 认证仍走 REST，`api-gateway` 是**唯一验签点**；它在验签后额外查一次 Redis 白名单（`session:{jti}`），使登出/轮换真正生效。`user-service` 拥有令牌签发与白名单写入；`room-service` 把 `GET /api/rooms` 从「裸 `KEYS` + 内部 `Room` 直出」改成「`SCAN` + 裁剪成 `RoomInfo[]` + 契约信封」。前端把令牌持久化到本地存储，并在收到 `10004` 时**用 refresh token 轮换一次后重试原请求**。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / MySQL 8 + TypeORM / Vitest / pnpm workspace + Turborepo / Vue 3 + Pinia + Vite（`apps/client`）

**Spec:**
- `docs/design.md` v4.2 —— 权威依据。本切片主要落在 **§5.1（认证）、§5.2（身份透传）、§7.1（网关白名单）、§7.2（user-service）、§7.3（room-service）、§3.1（Room / RoomInfo）、§11.1–11.2（错误码与统一响应形态）、§12（前端约束）**
- `docs/superpowers/plans/2026-09-13-parallel-dev.md` —— 切片表第 6 行 + Global Constraints
- `docs/superpowers/plans/agent-briefs.md` —— 角色与工作区
- `docs/superpowers/plans/slice-05-briefs.md` —— 上一片的分工与评审方式（本片沿用）

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`，每个任务都隐含本节：

| # | 约束 |
|---|------|
| 1 | **端口**：HTTP `3000/3001/3002/3003/3005`，内部 RPC `3103/3105`，douzero `2021`，redis `6379`，mysql `3306` |
| 2 | **测试框架 Vitest**（不是 Jest）。`packages/shared` 行覆盖率 ≥ 80% |
| 3 | **服务间通信必须用 `Transport.TCP`** + `@MessagePattern`，pattern 名与 DTO 见 §4.2 |
| 4 | **对外 REST 与内部 RPC 严禁共用同一个方法**：对外走 `game.view`（裁剪），对内走 `game.snapshot`（完整） |
| 5 | **WebSocket**：socket.io 4，namespace `/ws/ddz`，dot 命名；**ack 承载响应**；**没有 `seq` 字段** |
| 6 | **幂等**：动作请求必须带 `baseVersion`，CAS 失败返回 `13004`。`13002`/`13003` 已废弃、不得使用 |
| 7 | **错误码必须是 5 位数字**（§11.2）。禁止新增字符串错误码；旧字符串码只能出现在 §11.4 的别名表里 |
| 8 | **身份只从网关注入的 `X-User-Id`（HTTP）或 socket 握手 `auth.userId`（WS）取**。**严禁**信任请求体里的 `userId`/`playerId` |
| 9 | **裁剪**：`PlayerView` 是唯一的出站对局类型。`actionLog`、他人 `hand`、`isRobot`、`botId`、`skillLevel` **永不出站** |
| 10 | **牌值编码**：接口/存储层用 DouZero 编码（`2` = 17）；**进入牌型判定前必须还原为内部 Rank**（`2` = 15） |
| 11 | **前端哑终端**：禁止任何游戏规则、牌型判定、游戏常量、货币计算（§12 的 F01–F10） |
| 12 | **契约包 `packages/protocol` 由协调者拥有**。两端**只读**；任何改动（尤其破坏性）必须两端同一个 PR |

### 本切片的绑定数值（来自 §5.1 / §3.1 / §11.1，**逐字**）

| 项 | 值 |
|---|---|
| access token 有效期 | **2 小时**（`7200s`） |
| refresh token 有效期 | **7 天**（`604800s`） |
| 白名单键 | `session:{jti}`，String，**TTL = 该 token 的剩余有效期** |
| 令牌载荷 | `{ sub, phone, jti, exp, iat }` + **本片新增 `typ: 'access' \| 'refresh'`**（见 R24） |
| `POST /api/auth/refresh` | 入参 `{ refreshToken }`，出参 `{ accessToken, refreshToken }`，**轮换：旧 refresh token 立即失效** |
| `POST /api/auth/logout` | **删除两个 jti**（access 来自 `Authorization` 头，refresh 来自请求体） |
| 网关公开路径白名单 | **仅** `/api/auth/login`、`/api/auth/register`、`/api/auth/refresh`、`/api/health`（`/` 与 `/index.html` 是 §1.4 的临时工具页，保留） |
| 统一响应形态（HTTP） | `{ "code": 13004, "message": "...", "data": null }` + 对应 HTTP 状态码；`code: 0` 表示成功 |
| 认证相关错误码 | `11001` 手机号已注册(409)、`11002` 密码错误(401)、`11003` 账号已封禁(403)、`11004` 用户不存在(404)、`10004` Token 已过期(401)、`10005` Token 签名无效(401)、`10002` 未登录(401)、`10007` 下游不可用(503) |
| `GET /api/rooms` 出参 | `{ code: 0, message?, data: RoomInfo[] }`（见 R22） |
| `RoomInfo` 字段 | `{ code, mode, status, playerCount, maxPlayers, baseScore }`，`status ∈ waiting\|playing\|finished\|cancelled`（§3.1） |

### 协调者裁决（本片新增，执行时不得再自行解释）

- **R22 `GET /api/rooms` 的响应形状 = 平台统一信封 `{ code, message, data: RoomInfo[] }`。**
  依据 §11.1「统一响应形态」。`apps/client/src/pages/lobby.vue:9-11` 那条「⚠️ 待协调者裁决」的兼容读取（同时兼容裸数组与 `{data}`）**必须删掉**，只按信封解析。
- **R23 信封按服务本地实现，不引入新抽象层。** 沿用 `game-service/src/game/game.controller.ts:24-42` 的既有模式（局部 `HTTP_STATUS` 表 + `httpException(code, message)` 返回 `{code,message,data:null}`，成功返回 `{code:0,data}`）。**不要**把 Nest 相关代码塞进 `packages/shared`（它是游戏规则包），也不要为此新建 workspace 包。
- **R24 令牌新增 `typ` 声明。** §5.1 列的载荷 `{sub, phone, jti, exp, iat}` 是下限；不区分 access/refresh 的话，一张 7 天的 refresh token 可以当 access token 用，2 小时的有效期就形同虚设。网关**必须**拒绝 `typ !== 'access'` 的令牌（`10005`）。
- **R25 认证成功响应体 = `{ accessToken, refreshToken, user: { id, phone, nickname } }`。**
  这是 `apps/client/src/net/rest.ts:26-28` 的 `LoginResult` 已经在期待的形状，取它可让前端零类型改动；同时 `expiresIn` 字段不返回（客户端不解析有效期）。
- **R26 登出后网关必须拒绝该 access token（`10004`）。**
  §5.1 的白名单若无人查询就等于没实现。查询点是网关（唯一验签点）。Redis 不可用 → `10007`（503），**不得**静默放行。
- **R27 本片不迁移 `Room.players` 为 `Seat[]`、不加 `timeoutAt`。**
  §3.1 要求 `players: Seat[]`，但 `RoomInfo` 只需要人数；原子入座（C11）与 `Seat[]` 一体，归切片 7（进房）。本片只加 `RoomInfo` 真正需要的 `baseScore` 与 `cancelled`。
- **R28 本片不处理「socket 已连接时令牌轮换/登出」。** 网关只在**握手**与**HTTP 请求**上校验；已建立的 WS 连接不会因登出而断开。前端在登出时主动销毁本地会话。**记为已知边界**，写进 `agent-briefs.md`。

---

## 执行模型（与切片 5 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | Task 0（依赖预置）、Task 6（conformance）、评审、合并、门禁 |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | Task 1、2、3 |
| **前端 agent** | `.worktrees/frontend`（`feat/frontend`） | Task 4、5 |

**开工前固定动作**（两端都要）：

```bash
cd /home/howe/pokergame/.worktrees/<你的角色>
git merge master --no-edit        # master 已含切片 5 与 Task 0
pnpm install && pnpm build        # master 新增了依赖与工作区包
docker compose up -d              # 后端角色；且镜像必须已重建（见 agent-briefs.md）
```

---

## File Structure

```
packages/user-service/
├── package.json                                    Modify: 加 ioredis（Task 0 由协调者做）
└── src/
    ├── app.module.ts                               Modify: 注册 RedisModule / TokenModule
    ├── redis/redis.module.ts                       Create: REDIS provider（ioredis）
    ├── http/errors.ts                              Create: DomainError + HTTP_STATUS + httpException
    ├── auth/
    │   ├── auth.module.ts                          Modify: 注册 TokenService
    │   ├── auth.service.ts                         Modify: 发双令牌 + 错误码 + 轮换 + 登出
    │   ├── token.service.ts                        Create: 签发/校验/轮换/吊销 + 白名单读写
    │   └── token.service.test.ts                   （放 test/，见各任务）
    ├── users/users.controller.ts                   Modify: AuthController 返回信封 + refresh/logout
    └── users/users.dto.ts                          Modify: 加 RefreshTokenDto / 手机号格式

packages/api-gateway/
├── package.json                                    Modify: 加 ioredis（Task 0 由协调者做）
└── src/
    ├── auth/jwt.middleware.ts                      Modify: typ 校验 + 白名单查询 + 带码异常
    ├── auth/session.guard.ts                       Create: Redis 白名单查询（可注入、可测）
    └── gateway/gateway.controller.ts               Modify: 加 auth/refresh、auth/logout 路由

packages/room-service/
└── src/rooms/
    ├── rooms.dto.ts                                Modify: mode 枚举改 'random' | 'practice'
    ├── rooms.service.ts                            Modify: Room 形状 + toRoomInfo + SCAN
    └── rooms.controller.ts                         Modify: 信封 + RoomInfo[] 出参

apps/client/src/
├── net/storage.ts                                  Create: 令牌持久化（localStorage / uni 等价物）
├── net/rest.ts                                     Modify: Authorization 头 + 401/10004 轮换重试 + rooms()
├── stores/auth.ts                                  Modify: hydrate/persist/登出调服务端
├── pages/lobby.vue                                 Modify: 用 rest.rooms() + RoomInfo 渲染，删兼容 shim
├── pages/login.vue                                 Modify: 登录/注册错误按信封展示
└── main.ts                                         Modify: 先 hydrate 再 startGameSession

tools/conformance/src/
├── lib/http.ts                                     Modify: login/refresh/logout/authedGet 助手
├── slices/slice-06-auth-rooms.ts                   Create: 本片 conformance 用例
└── run.ts                                          Modify: 注册 slice-06
```

---

## Task 0: 预置依赖（协调者）

**为什么单独成任务**：`ioredis` 要加进两个包的 `package.json`，而 `pnpm-lock.yaml` 是**根配置**（Global Constraint 12 由协调者独占）。两个 agent 各自 `pnpm install` 会互相踩锁文件。

**Files:**
- Modify: `packages/user-service/package.json`
- Modify: `packages/api-gateway/package.json`
- Modify: `pnpm-lock.yaml`（由 `pnpm install` 生成）

**Interfaces:**
- Produces:
  - `ioredis@^5.11.1` 在 `user-service` 与 `api-gateway` 中可 import（与 `room-service` 同版本）
  - **`@fight-the-landlord/protocol` 在 `user-service` 中可 import**（R32：`user-service` 原本没声明它，只靠 `shared` 传递；pnpm 的隔离 `node_modules` 下必须有显式声明才能 `import { ErrCode }`）

- [ ] **Step 1: 加依赖**

- `packages/user-service/package.json` 的 `dependencies` 加两行：`"ioredis": "^5.11.1"`、`"@fight-the-landlord/protocol": "workspace:*"`；
- `packages/api-gateway/package.json` 的 `dependencies` 加一行：`"ioredis": "^5.11.1"`。

- [ ] **Step 2: 安装并确认三处可见**

```bash
pnpm install
git diff --stat pnpm-lock.yaml
ls packages/user-service/node_modules/@fight-the-landlord/   # 期望看到 protocol 与 shared
ls -d packages/user-service/node_modules/ioredis packages/api-gateway/node_modules/ioredis
```

- [ ] **Step 3: 确认全绿基线**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: 19/19 / 19/19 / 19/19（切片 5 后的基线）

- [ ] **Step 4: Commit**

```bash
git add packages/user-service/package.json packages/api-gateway/package.json pnpm-lock.yaml
git commit -m "chore(slice6): 为 user-service 与 api-gateway 补 ioredis（§5.1 白名单 / §5.4 限流的依赖）"
```

---

## Task 1: user-service —— 双令牌 + `session:{jti}` 白名单（后端 agent）

**Files:**
- Create: `packages/user-service/src/redis/redis.module.ts`
- Create: `packages/user-service/src/http/errors.ts`
- Create: `packages/user-service/src/auth/token.service.ts`
- Modify: `packages/user-service/src/auth/auth.module.ts`
- Modify: `packages/user-service/src/auth/auth.service.ts`
- Modify: `packages/user-service/src/users/users.controller.ts`
- Modify: `packages/user-service/src/users/users.dto.ts`
- Modify: `packages/user-service/src/app.module.ts`
- Test: `packages/user-service/test/token.service.test.ts`（新建）、`packages/user-service/test/auth.service.test.ts`（新建）、`packages/user-service/test/auth.controller.test.ts`（新建）

**Interfaces:**
- Produces（后续任务与前端依赖的**精确形状**）：
  - `TokenService.issuePair(user: { id: string; phone: string }): Promise<{ accessToken: string; refreshToken: string }>`
  - `TokenService.rotate(refreshToken: string): Promise<{ ok: true; userId: string; pair: { accessToken: string; refreshToken: string } } | { ok: false; code: ErrCode }>`
  - `TokenService.revoke(jti: string): Promise<void>`
  - `TokenService.verify(token: string, typ: 'access' | 'refresh'): { sub: string; phone: string; jti: string; typ: 'access' | 'refresh' }`（失败抛 `DomainError`）
  - `sessionKey(jti: string): string` → `"session:" + jti`
  - 常量 `ACCESS_TOKEN_TTL_SECONDS = 7200`、`REFRESH_TOKEN_TTL_SECONDS = 604800`
  - `AuthService.register(dto) / login(dto) / refresh(refreshToken) / logout(accessJti, refreshToken)`
  - 认证响应体 `{ accessToken, refreshToken, user: { id, phone, nickname } }`

- [ ] **Step 1: 写失败测试（令牌与白名单）**

Create `packages/user-service/test/token.service.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import {
  TokenService,
  sessionKey,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../src/auth/token.service';

/** 只用得到 set/del/exists 的 Redis 替身；TTL 靠记录 EX 秒数断言。 */
function fakeRedis() {
  const store = new Map<string, number>(); // key -> 过期时刻（未用，仅记录存在性）
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    set: vi.fn(async (key: string, _v: string, _ex: string, seconds: number) => {
      store.set(key, 1);
      ttl.set(key, seconds);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  } as any;
}

describe('TokenService（§5.1）', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let service: TokenService;

  beforeEach(() => {
    redis = fakeRedis();
    service = new TokenService(new JwtService({ secret: 'test-secret' }), redis);
  });

  it('access 2h / refresh 7d，且两张令牌各写一个 session:{jti}（TTL = 剩余有效期）', async () => {
    const pair = await service.issuePair({ id: 'u1', phone: '13800000000' });
    expect(redis.set).toHaveBeenCalledTimes(2);

    const access = service.verify(pair.accessToken, 'access');
    const refresh = service.verify(pair.refreshToken, 'refresh');
    expect(access.exp - access.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(refresh.exp - refresh.iat).toBe(REFRESH_TOKEN_TTL_SECONDS);
    expect(redis.ttl.get(sessionKey(access.jti))).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(redis.ttl.get(sessionKey(refresh.jti))).toBe(REFRESH_TOKEN_TTL_SECONDS);
  });

  it('refresh token 不能当 access token 用（R24）', async () => {
    const pair = await service.issuePair({ id: 'u1', phone: '13800000000' });
    expect(() => service.verify(pair.refreshToken, 'access')).toThrow(/typ/);
  });

  it('轮换：旧 refresh token 立即失效，新的一张可用', async () => {
    const first = await service.issuePair({ id: 'u1', phone: '13800000000' });
    const rotated = await service.rotate(first.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const again = await service.rotate(first.refreshToken); // 旧的重放
    expect(again.ok).toBe(false);
    expect((await service.rotate(rotated.pair.refreshToken)).ok).toBe(true);
  });

  it('被吊销的 jti 不再活跃（登出语义）', async () => {
    const pair = await service.issuePair({ id: 'u1', phone: '13800000000' });
    const claims = service.verify(pair.accessToken, 'access');
    expect(await service.isActive(claims.jti)).toBe(true);
    await service.revoke(claims.jti);
    expect(await service.isActive(claims.jti)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/user-service test -- token.service`
Expected: FAIL —— `Cannot find module '../src/auth/token.service'`

- [ ] **Step 3: 实现 `token.service.ts`**

Create `packages/user-service/src/auth/token.service.ts`：

```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';

/** §5.1：access 2 小时 / refresh 7 天。 */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export type TokenType = 'access' | 'refresh';

/** §5.1 的 `session:{jti}` 白名单键（唯一拼法，勿在别处拼字符串）。 */
export function sessionKey(jti: string): string {
  return `session:${jti}`;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenClaims {
  sub: string;
  phone: string;
  jti: string;
  typ: TokenType;
  iat: number;
  exp: number;
}

export const REDIS = 'REDIS';

/**
 * 令牌的签发、校验、轮换与吊销（§5.1）。
 *
 * 两张令牌**都**写入 `session:{jti}`（TTL = 该令牌的剩余有效期），因此都可被吊销。
 * refresh token 会被轮换：`rotate()` 先删旧 jti，再发新的一对。
 */
@Injectable()
export class TokenService {
  // ⚠️ R38（执行中发现并修正）：本计划原先还注入了一个 `@Optional() @Inject('CLOCK') clock`，
  // 但实现里从未使用它 —— 在 `noUnusedLocals` 下直接报 TS6138，让 `pnpm lint` 失败。
  // 令牌有效期靠 JWT 自身的 `exp`/`iat` 断言（测试里用 `exp - iat`），不需要假时钟。故**删掉该参数**。
  constructor(
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async issuePair(user: { id: string; phone: string }): Promise<TokenPair> {
    const access = this.sign(user, 'access', ACCESS_TOKEN_TTL_SECONDS);
    const refresh = this.sign(user, 'refresh', REFRESH_TOKEN_TTL_SECONDS);
    await Promise.all([
      this.redis.set(sessionKey(access.jti), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS),
      this.redis.set(sessionKey(refresh.jti), '1', 'EX', REFRESH_TOKEN_TTL_SECONDS),
    ]);
    return { accessToken: access.token, refreshToken: refresh.token };
  }

  /** 校验签名与 `typ`。失败一律 `DomainError`（调用方翻成契约错误码）。 */
  verify(token: string, typ: TokenType): TokenClaims {
    let claims: TokenClaims;
    try {
      claims = this.jwt.verify(token) as TokenClaims;
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      throw new DomainError(
        name === 'TokenExpiredError' ? ErrCode.TOKEN_EXPIRED : ErrCode.TOKEN_INVALID,
        'Invalid or expired token',
      );
    }
    if (claims?.typ !== typ) {
      throw new DomainError(ErrCode.TOKEN_INVALID, `token typ must be "${typ}"`);
    }
    if (!claims.sub || !claims.jti) {
      throw new DomainError(ErrCode.TOKEN_INVALID, 'token is missing sub or jti');
    }
    return claims;
  }

  /**
   * 轮换（§5.1）：旧 refresh token 立即失效，返回新的一对。
   * 旧 jti 不在白名单 / 已过期 / typ 不对 → `ok: false`。
   */
  async rotate(
    refreshToken: string,
  ): Promise<{ ok: true; userId: string; pair: TokenPair } | { ok: false; code: ErrCode }> {
    let claims: TokenClaims;
    try {
      claims = this.verify(refreshToken, 'refresh');
    } catch (err) {
      return { ok: false, code: err instanceof DomainError ? err.code : ErrCode.TOKEN_INVALID };
    }
    if (!(await this.isActive(claims.jti))) return { ok: false, code: ErrCode.TOKEN_EXPIRED };

    await this.revoke(claims.jti); // 轮换：旧的一张立刻作废
    const pair = await this.issuePair({ id: claims.sub, phone: claims.phone });
    return { ok: true, userId: claims.sub, pair };
  }

  async revoke(jti: string): Promise<void> {
    await this.redis.del(sessionKey(jti));
  }

  async isActive(jti: string): Promise<boolean> {
    return (await this.redis.exists(sessionKey(jti))) === 1;
  }

  private sign(user: { id: string; phone: string }, typ: TokenType, ttl: number) {
    const jti = randomUUID();
    const token = this.jwt.sign({ sub: user.id, phone: user.phone, jti, typ }, { expiresIn: ttl });
    return { token, jti };
  }
}
```

- [ ] **Step 4: 实现 `http/errors.ts` 与 `redis/redis.module.ts`**

Create `packages/user-service/src/http/errors.ts`（沿用 `game-service/src/game/game.controller.ts:24-42` 的模式，R23）：

```ts
import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/** 契约错误码 → HTTP 状态码（§11.2）。 */
export const HTTP_STATUS: Partial<Record<ErrCode, number>> = {
  [ErrCode.BAD_PARAM]: 400,
  [ErrCode.UNAUTHENTICATED]: 401,
  [ErrCode.FORBIDDEN]: 403,
  [ErrCode.TOKEN_EXPIRED]: 401,
  [ErrCode.TOKEN_INVALID]: 401,
  [ErrCode.PHONE_TAKEN]: 409,
  [ErrCode.BAD_CREDENTIALS]: 401,
  [ErrCode.USER_BANNED]: 403,
  [ErrCode.USER_NOT_FOUND]: 404,
  [ErrCode.UPSTREAM_UNAVAILABLE]: 503,
};

/** 统一响应形态（§11.1）：`{ code, message, data }`。 */
export function httpException(code: ErrCode, message: string): HttpException {
  return new HttpException({ code, message, data: null }, HTTP_STATUS[code] ?? 500);
}

/** 领域错误：service 层用它携带契约错误码，controller 层翻成 HTTP。 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** service 抛出的任何异常 → 带契约码的 HttpException（照 game.controller.ts:44-48）。 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof DomainError) return httpException(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  return httpException(ErrCode.BAD_PARAM, message);
}
```

Create `packages/user-service/src/redis/redis.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../auth/token.service';

/** §2.1：user-service 是 Redis 使用者（§5.1 的 session 白名单）。 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/user-service test -- token.service`
Expected: PASS（4 个用例）

- [ ] **Step 6: 写 AuthService 的失败测试**

Create `packages/user-service/test/auth.service.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { ErrCode } from '@fight-the-landlord/protocol';
import * as bcrypt from 'bcrypt';

function fakeRedis() {
  const store = new Set<string>();
  return {
    set: vi.fn(async (k: string) => { store.add(k); return 'OK'; }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
  } as any;
}

describe('AuthService（§5.1 / §7.2）', () => {
  let repo: any;
  let service: AuthService;
  let tokens: TokenService;

  beforeEach(async () => {
    repo = {
      findByPhone: vi.fn(async () => null),
      findById: vi.fn(async () => null),
      create: vi.fn(async (data: any) => ({ ...data, nickname: data.nickname ?? null })),
      update: vi.fn(async () => undefined),
    };
    tokens = new TokenService(new JwtService({ secret: 'test-secret' }), fakeRedis());
    service = new AuthService(repo, tokens);
  });

  it('register 返回双令牌 + user，并把密码哈希（不是明文）落库', async () => {
    const res = await service.register({ phone: '13800000001', password: 'passw0rd' } as any);
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(res.user.phone).toBe('13800000001');
    const created = repo.create.mock.calls[0][0];
    expect(created.passwordHash).not.toBe('passw0rd');
    expect(await bcrypt.compare('passw0rd', created.passwordHash)).toBe(true);
  });

  it('手机号已注册 → 11001', async () => {
    repo.findByPhone.mockResolvedValueOnce({ id: 'u1' });
    await expect(service.register({ phone: '13800000001', password: 'passw0rd' } as any)).rejects.toMatchObject({
      code: ErrCode.PHONE_TAKEN,
    });
  });

  it('用户不存在 → 11004；密码错 → 11002；封禁 → 11003', async () => {
    await expect(service.login({ phone: '13800000009', password: 'x' } as any)).rejects.toMatchObject({
      code: ErrCode.USER_NOT_FOUND,
    });

    const hash = await bcrypt.hash('right', 10);
    repo.findByPhone.mockResolvedValueOnce({ id: 'u1', phone: '13800000001', passwordHash: hash, status: 'active', nickname: null });
    await expect(service.login({ phone: '13800000001', password: 'wrong' } as any)).rejects.toMatchObject({
      code: ErrCode.BAD_CREDENTIALS,
    });

    repo.findByPhone.mockResolvedValueOnce({ id: 'u1', phone: '13800000001', passwordHash: hash, status: 'banned', nickname: null });
    await expect(service.login({ phone: '13800000001', password: 'right' } as any)).rejects.toMatchObject({
      code: ErrCode.USER_BANNED,
    });
  });

  it('logout 删掉两个 jti', async () => {
    const res = await service.register({ phone: '13800000002', password: 'passw0rd' } as any);
    const access = tokens.verify(res.accessToken, 'access');
    const refresh = tokens.verify(res.refreshToken, 'refresh');
    await service.logout(access.jti, res.refreshToken);
    expect(await tokens.isActive(access.jti)).toBe(false);
    expect(await tokens.isActive(refresh.jti)).toBe(false);
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/user-service test -- auth.service`
Expected: FAIL —— 构造函数签名不符 / `res.accessToken` 未定义

- [ ] **Step 8: 改写 `auth.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { ErrCode } from '@fight-the-landlord/protocol';
import { UsersRepository } from '../users/users.repository';
import { RegisterDto, LoginDto } from '../users/users.dto';
import { TokenService, type TokenPair } from './token.service';
import { DomainError } from '../http/errors';

export interface AuthResult extends TokenPair {
  user: { id: string; phone: string; nickname: string | null };
}

@Injectable()
export class AuthService {
  private readonly saltRounds = 10;

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.usersRepo.findByPhone(dto.phone);
    if (existing) throw new DomainError(ErrCode.PHONE_TAKEN, '手机号已注册');

    const user = await this.usersRepo.create({
      id: randomUUID(),
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, this.saltRounds),
      nickname: dto.nickname ?? null,
      status: 'active' as const,
    });
    return this.issue(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.usersRepo.findByPhone(dto.phone);
    if (!user) throw new DomainError(ErrCode.USER_NOT_FOUND, '用户不存在');
    if (user.status === 'banned') throw new DomainError(ErrCode.USER_BANNED, '用户已被封禁');
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new DomainError(ErrCode.BAD_CREDENTIALS, '密码错误');
    }
    return this.issue(user);
  }

  /** §5.1：refresh 轮换。失败一律 `10004`（调用方只暴露「令牌不可用」这一事实）。 */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const result = await this.tokens.rotate(refreshToken);
    if (!result.ok) throw new DomainError(ErrCode.TOKEN_EXPIRED, 'refresh token is not usable');
    return result.pair;
  }

  /** §5.1：登出删除两个 jti。refresh 与 access 不同属一次会话时只删能解析的那些。 */
  async logout(accessJti: string, refreshToken?: string): Promise<void> {
    await this.tokens.revoke(accessJti);
    if (refreshToken) {
      try {
        await this.tokens.revoke(this.tokens.verify(refreshToken, 'refresh').jti);
      } catch {
        // refresh token 已经不可用 → 目标状态已达成，不算失败
      }
    }
  }

  async getMe(userId: string) {
    return this.usersRepo.findById(userId);
  }

  private async issue(user: { id: string; phone: string; nickname: string | null }): Promise<AuthResult> {
    const pair = await this.tokens.issuePair({ id: user.id, phone: user.phone });
    return { ...pair, user: { id: user.id, phone: user.phone, nickname: user.nickname } };
  }
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/user-service test -- auth.service`
Expected: PASS（4 个用例）

- [ ] **Step 10: 接线 module 与 controller**

`packages/user-service/src/auth/auth.module.ts`：`JwtModule.register` 的 `signOptions` **删掉**（有效期改由 `TokenService.sign` 逐次指定，access/refresh 不同）；`providers` 加 `TokenService`，`exports` 导出 `TokenService`。

`packages/user-service/src/app.module.ts`：`imports` 加 `RedisModule`。

`packages/user-service/src/users/users.dto.ts`：加

```ts
export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
```

`packages/user-service/src/users/users.controller.ts` 整体替换为：

```ts
import { Body, Controller, Get, Headers, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';
import { RegisterDto, LoginDto, UpdateProfileDto, RefreshTokenDto } from './users.dto';
import { httpException, toHttpException } from '../http/errors';

/** 仅 `/api/auth/logout` 使用：网关把验签得到的 access token `jti` 传下来（Task 2 定义并注入）。 */
const TOKEN_JTI_HEADER = 'x-token-jti';
```

```ts
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('auth/register')
  async register(@Body() dto: RegisterDto) {
    try {
      return { code: ErrCode.OK, data: await this.authService.register(dto) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    try {
      return { code: ErrCode.OK, data: await this.authService.login(dto) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** §5.1：公开路径，凭 refresh token 换新的一对（轮换）。 */
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto) {
    try {
      return { code: ErrCode.OK, data: await this.authService.refresh(dto.refreshToken) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /**
   * §5.1：登出删除**两个** jti。
   *
   * access 的 jti 由网关照常注入（`X-Token-Jti`，**仅这条路径**，见 Task 2 —— 它不进 §5.2
   * 的通用身份契约，也不下发客户端）；refresh 的 jti 从请求体里的 refreshToken 解出。
   */
  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Headers('x-token-jti') accessJti: string | undefined,
    @Body() dto: Partial<RefreshTokenDto>,
  ) {
    if (!accessJti) throw httpException(ErrCode.UNAUTHENTICATED, 'missing access token');
    await this.authService.logout(accessJti, dto?.refreshToken);
    return { code: ErrCode.OK, data: null };
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@Req() req: { user: { sub: string } }) {
    return { code: ErrCode.OK, data: await this.usersService.getMe(req.user.sub) };
  }

  @Put('me')
  async updateProfile(@Req() req: { user: { sub: string } }, @Body() dto: UpdateProfileDto) {
    await this.usersService.updateProfile(req.user.sub, dto);
    return { code: ErrCode.OK, data: null };
  }
}
```

- [ ] **Step 11: 给 AuthController 补一条 HTTP 层测试**

Create `packages/user-service/test/auth.controller.test.ts`：用 `@nestjs/testing` 建一个只挂 `AuthController` 的模块（`AuthService` 用替身），断言：
- `POST /auth/login` 成功体是 `{ code: 0, data: { accessToken, refreshToken, user } }`；
- `AuthService` 抛 `DomainError(PHONE_TAKEN)` 时响应 `{ code: 11001, message, data: null }` 且 HTTP 409。

（`DomainError → httpException` 的翻译放在 controller 的 `try/catch` 里，写法照 `game.controller.ts:44-48` 的 `toHttpException`。把该函数加到 `src/http/errors.ts`。）

- [ ] **Step 12: 全量验证并提交**

Run:
```bash
pnpm --filter @fight-the-landlord/user-service test
pnpm --filter @fight-the-landlord/user-service lint
pnpm test && pnpm lint
```
Expected: 全绿（`user-service` 用例数由 8 增至 ≥ 18）

```bash
git add packages/user-service
git commit -m "feat(user-service): access 2h + refresh 7d 双令牌与 session:{jti} 白名单（§5.1）"
```

---

## Task 2: api-gateway —— 验签后查白名单、放行 refresh/logout（后端 agent）

**Files:**
- Modify: `packages/api-gateway/src/auth/identity-headers.ts`
- Create: `packages/api-gateway/src/auth/session.guard.ts`
- Modify: `packages/api-gateway/src/auth/jwt.middleware.ts`
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`
- Modify: `packages/api-gateway/src/app.module.ts`（提供 Redis）
- Test: `packages/api-gateway/test/jwt.middleware.test.ts`（改）、`packages/api-gateway/test/session-guard.test.ts`（新建）

**Interfaces:**
- Consumes: `sessionKey(jti)` 的**键形状** `session:{jti}`（Task 1 定义；网关只用键名，不 import user-service 的代码）
- Produces: `SessionGuard.isActive(jti): Promise<boolean>`；网关在非公开路径上要求「签名有效 + `typ==='access'` + jti 在白名单」

- [ ] **Step 1: 写失败测试（白名单查询与 typ）**

Create `packages/api-gateway/test/session-guard.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionGuard, sessionKey } from '../src/auth/session.guard';

describe('SessionGuard（§5.1 白名单）', () => {
  it('jti 在白名单 → true', async () => {
    const redis = { exists: vi.fn(async () => 1) } as any;
    const guard = new SessionGuard(redis);
    expect(await guard.isActive('jti-1')).toBe(true);
    expect(redis.exists).toHaveBeenCalledWith(sessionKey('jti-1'));
  });

  it('jti 不在白名单 → false', async () => {
    const guard = new SessionGuard({ exists: vi.fn(async () => 0) } as any);
    expect(await guard.isActive('jti-x')).toBe(false);
  });

  it('Redis 故障 → 抛错（调用方翻成 10007，不得静默放行）', async () => {
    const guard = new SessionGuard({ exists: vi.fn(async () => { throw new Error('down'); }) } as any);
    await expect(guard.isActive('jti-1')).rejects.toThrow('down');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/api-gateway test -- session-guard`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `session.guard.ts` 与头常量**

Create `packages/api-gateway/src/auth/session.guard.ts`：

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** §5.1 的白名单键形状。user-service 是写入方；网关只读。 */
export function sessionKey(jti: string): string {
  return `session:${jti}`;
}

export const REDIS = 'REDIS';

/** 令牌吊销的唯一查询点（R26）。Redis 故障必须上抛：宁可 503 也不放行已吊销的令牌。 */
@Injectable()
export class SessionGuard {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async isActive(jti: string): Promise<boolean> {
    return (await this.redis.exists(sessionKey(jti))) === 1;
  }
}
```

`packages/api-gateway/src/auth/identity-headers.ts` 加：

```ts
/** 仅 `/api/auth/logout` 使用：网关把验签得到的 access token `jti` 传给 user-service（R26/R23）。不下发客户端。 */
export const TOKEN_JTI_HEADER = 'x-token-jti';
```

- [ ] **Step 4: 改 `jwt.middleware.ts`**

改动点（保留既有 `UnauthorizedException` 类型，测试与响应体同时正确）：
1. 构造函数加 `@Inject(REDIS) private readonly session: SessionGuard`；
2. 验签后要求 `payload.typ === 'access'` 且 `payload.jti` 存在，否则 `10005`；
3. `await this.session.isActive(payload.jti)` 为假 → `new CodedUnauthorized(ErrCode.TOKEN_EXPIRED, 'Token has been revoked or expired')`；
4. Redis 抛错 → `new ServiceUnavailableException({ code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'session store unavailable', data: null })`；
5. 给 `/api/auth/logout` 注入 `TOKEN_JTI_HEADER = payload.jti`。

新增的带码异常（放在 `jwt.middleware.ts` 内，或 `src/auth/coded-http.ts`）：

```ts
import { UnauthorizedException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/** 401 + 契约信封：`UnauthorizedException` 传对象时，响应体就是该对象（§11.1）。 */
export class CodedUnauthorized extends UnauthorizedException {
  constructor(code: ErrCode, message: string) {
    super({ code, message, data: null });
  }
}
```

`use()` 变成 `async`（Nest 支持返回 Promise 的中间件）。

> **⚠️ R41（评审发现的 Critical，计划遗漏）**：本步骤只点名了 **HTTP** 中间件，但网关还有**第二个验签点** ——
> `gateway/proxy.gateway.ts` 的 `verifyClient()`（WS 握手）。它当时只做 `jwtService.verify` + 查 `sub`，
> 于是 **一张 7 天的 refresh token 可以直接开 `/ws/ddz`**，**刚被登出（jti 已从白名单删除）的 access token
> 也能新开一条 WS 连接** —— R24/R26 在玩法通道上被完全绕过（R28 记的边界只覆盖「**已建立**的连接不断开」）。
>
> **两处必须一起改**：`verifyClient` 改 `async`，要求 `typ === 'access'`（`10005`）、`jti` 存在，
> 并 `await SessionGuard.isActive(jti)`（不在白名单 → `10004`；Redis 故障 → `10007`），失败拒绝握手。
> 补测试：refresh token 握手被拒、已登出的 access token 握手被拒、合法 access token 仍能连上。
>
> **教训（写给后续切片）**：本项目的「网关是唯一验签点」实际有**两条**入口（HTTP 中间件 + WS 握手）。
> 任何「验签后要额外做的事」（白名单、`typ`、限流、脱敏）都必须**在两处都做**；计划里只写一处就等于只做一半。

- [ ] **Step 5: 补 `jwt.middleware.test.ts` 的用例**

在既有文件里补三条（并修好因构造函数新增参数而失败的既有用例）：
- `typ: 'refresh'` 的令牌 → 401 且响应体 `code === 10005`；
- 签名有效但 `session:{jti}` 不存在 → 401 且 `code === 10004`；
- 已吊销后再次请求同一令牌 → 仍然 401（幂等）。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/api-gateway test`
Expected: PASS

- [ ] **Step 7: 加 refresh/logout 路由并在 app.module 提供 Redis**

`packages/api-gateway/src/gateway/gateway.controller.ts` 加：

```ts
@Post('auth/refresh')
@HttpCode(200)
async refresh(@Body() body: unknown, @Res() res: any, @Req() req: any) {
  return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/refresh', body, res, headersOf(req));
}

@Post('auth/logout')
@HttpCode(200)
async logout(@Body() body: unknown, @Res() res: any, @Req() req: any) {
  return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/logout', body, res, headersOf(req));
}
```

`headersOf()` 增加：当路径是 logout 时把 `req.headers[TOKEN_JTI_HEADER]` 传下去（`DownstreamHeaders` 加可选 `tokenJti?: string`，`ProxyGateway.forward()` 写出该头）。

`packages/api-gateway/src/app.module.ts` 提供 `REDIS`（与 Task 1 的 `RedisModule` 同形，但 api-gateway 自己一份；R23 不跨服务共享 Nest 代码）。

- [ ] **Step 8: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/api-gateway test && pnpm test && pnpm lint
git add packages/api-gateway
git commit -m "feat(api-gateway): 验签后查 session:{jti} 白名单，放行 refresh/logout（§5.1/§7.1）"
```

---

## Task 3: room-service —— `GET /api/rooms` 返回裁剪后的 `RoomInfo[]`（后端 agent）

**Files:**
- Modify: `packages/room-service/src/rooms/rooms.dto.ts`
- Modify: `packages/room-service/src/rooms/rooms.service.ts`
- Modify: `packages/room-service/src/rooms/rooms.controller.ts`
- Test: `packages/room-service/test/rooms.service.test.ts`（改）、`packages/room-service/test/rooms.controller.test.ts`（新建）

**Interfaces:**
- Produces:
  - `type RoomStatus = 'waiting' | 'playing' | 'finished' | 'cancelled'`
  - `interface Room { code: string; mode: 'random' | 'practice'; baseScore: number; players: string[]; maxPlayers: number; status: RoomStatus; createdAt: number }`
  - `interface RoomInfo { code: string; mode: 'random' | 'practice'; status: RoomStatus; playerCount: number; maxPlayers: number; baseScore: number }`
  - `toRoomInfo(room: Room): RoomInfo`（**唯一**的出站映射；绝不带 `players`）
  - `RoomsService.findAll(): Promise<Room[]>`（内部形状；controller 负责映射）

- [ ] **Step 1: 写失败测试**

在 `packages/room-service/test/rooms.service.test.ts` 里加（并修好因 `Room` 形状变化而失败的既有用例）：

```ts
it('findAll 用 SCAN 而不是 KEYS，且不把 room:{code}:seats 之类当成房间', async () => {
  const redis = makeRedis({
    scan: vi.fn(async () => ['0', ['room:AAA111', 'room:AAA111:cardcount', 'room:BBB222']]),
    get: vi.fn(async (key: string) =>
      key === 'room:AAA111'
        ? JSON.stringify(room({ code: 'AAA111', status: 'waiting' }))
        : JSON.stringify(room({ code: 'BBB222', status: 'cancelled' })),
    ),
    keys: vi.fn(async () => { throw new Error('KEYS 在生产环境被禁止'); }),
  });
  const service = new RoomsService(redis);

  const all = await service.findAll();
  expect(redis.keys).not.toHaveBeenCalled();
  expect(all.map((r) => r.code)).toEqual(['AAA111']); // cancelled 不进列表
});

it('toRoomInfo 只含 RoomInfo 的六个字段（不泄漏 players）', () => {
  const info = toRoomInfo(room({ code: 'AAA111', players: ['u1', 'u2'] }));
  expect(Object.keys(info).sort()).toEqual(
    ['baseScore', 'code', 'maxPlayers', 'mode', 'playerCount', 'status'].sort(),
  );
  expect(JSON.stringify(info)).not.toContain('u1');
});
```

（`makeRedis`/`room` 是该测试文件已有的替身工厂，按现有风格扩展；`room()` 需支持 `players` 覆盖。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- rooms.service`
Expected: FAIL —— `toRoomInfo` 未导出

- [ ] **Step 3: 改 `rooms.service.ts`**

```ts
export type RoomStatus = 'waiting' | 'playing' | 'finished' | 'cancelled';
export type RoomMode = 'random' | 'practice';

/** §3.1 的服务端内部形状。`players` 仍是 userId 数组；迁移为 `Seat[]` 归切片 7（R27）。 */
export interface Room {
  code: string;
  mode: RoomMode;
  baseScore: number;
  players: string[];
  maxPlayers: number;
  status: RoomStatus;
  createdAt: number;
}

/** §3.1：`GET /api/rooms` 的列表项。**唯一**的对外房间形状。 */
export interface RoomInfo {
  code: string;
  mode: RoomMode;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
}

export const DEFAULT_BASE_SCORE = 100;

/** 内部 Room → 对外 RoomInfo（§6.4 的同类裁剪思路：只出该出的字段）。 */
export function toRoomInfo(room: Room): RoomInfo {
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    baseScore: room.baseScore,
  };
}
```

`findAll()` 改为（**禁止 `KEYS`**，§7.3 偏差 A8）：

```ts
async findAll(): Promise<Room[]> {
  const rooms: Room[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      // 排除 room:{code}:cardcount / room:{code}:seats 这类派生键
      if (key.slice('room:'.length).includes(':')) continue;
      const data = await this.redis.get(key);
      if (!data) continue;
      const room = JSON.parse(data) as Room;
      if (room.status === 'cancelled') continue; // 终态房间不进列表
      rooms.push(room);
    }
  } while (cursor !== '0');
  return rooms;
}
```

`create` / `createGameRoom` / `addBot` 等构造 `Room` 的地方补 `baseScore: DEFAULT_BASE_SCORE`，`createdAt` 改为 `Date.now()`，`mode` 收窄为 `RoomMode`。`updateStatus` 的联合类型改用 `RoomStatus`。

`rooms.dto.ts` 的 `RoomMode` 枚举改为：

```ts
export enum RoomMode {
  RANDOM = 'random',
  PRACTICE = 'practice',
}
```

- [ ] **Step 4: 改 `rooms.controller.ts`**

```ts
@Get()
async findAll() {
  const rooms = await this.roomsService.findAll();
  return { code: ErrCode.OK, data: rooms.map(toRoomInfo) };
}
```

`POST /rooms` 与 `POST /rooms/:code/join` 也改成信封（`{ code: ErrCode.OK, data: ... }`），错误用 `httpException(...)`（把 Task 1 的 `http/errors.ts` 复制一份到 `packages/room-service/src/http/errors.ts`，R23）。

> **⚠️ R39（执行中发现并修正）**：原实现的 `join` 读 `dto.userId ?? 'anon'`，**直接违反 Global Constraint 8 / §5.2**
> （严禁信任请求体里的 `userId`）。本片顺手按硬约束改正：
>
> ```ts
> @Post(':code/join')
> async join(@Param('code') code: string, @Headers('x-user-id') userId: string | undefined) {
>   if (!userId) throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
>   return { code: ErrCode.OK, data: await this.roomsService.join(code, userId) };
> }
> ```
>
> `JoinRoomDto` 的 `userId` 字段**删掉**（body 里的身份一律不可信）。这与切片 7 的原子入座（C11）不冲突 ——
> 切片 7 改的是**存储层的原子性**，不是身份来源。
>
> **⚠️ R40（明确记录，本片不做）**：`ValidationPipe` 抛出的 400（例如 `mode: 'friend'`、密码太短）
> 仍是 Nest 默认响应体 `{ message: [...], statusCode: 400 }`，**不走 §11.1 信封**。修它需要在**每个服务**
> 加全局 `ExceptionFilter`，是**跨服务**的一致性工作（user/room/game/robot/gateway 五处），
> 只做其中两个服务比不做更糟。**不在本片 DoD 内**（切片表第 6 行只要求 refresh/logout 端点、白名单、`GET /api/rooms`），
> 记为后续独立小任务；本片的 conformance 不构造 DTO 非法请求。

- [ ] **Step 5: 新建 controller 测试**

`packages/room-service/test/rooms.controller.test.ts`：断言 `GET /api/rooms` 返回 `{ code: 0, data: RoomInfo[] }`，每个元素**恰好**六个字段，且响应文本不含 `players` / `isRobot`。

- [ ] **Step 6: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/room-service test && pnpm test && pnpm lint
git add packages/room-service
git commit -m "feat(room-service): GET /api/rooms 改为 SCAN + 裁剪 RoomInfo[] + 契约信封（§3.1/§7.3/R22）"
```

---

## Task 4: 前端 —— 令牌持久化与带轮换的 REST 客户端（前端 agent）

**Files:**
- Create: `apps/client/src/net/storage.ts`
- Modify: `apps/client/src/net/rest.ts`
- Test: `apps/client/test/rest-auth.test.ts`（新建）、`apps/client/test/storage.test.ts`（新建）

**Interfaces:**
- Produces:
  - `loadSession(): StoredSession | null` / `saveSession(s)` / `clearSession()`，`StoredSession = { accessToken: string; refreshToken: string; userId: string }`
  - `rest.rooms(): Promise<RestResponse<RoomInfo[]>>`
  - `rest.authedGet/post`：自动带 `Authorization: Bearer`；遇 `10004`/HTTP 401 **轮换一次后重试一次**
  - `rest.LoginResult = { accessToken: string; refreshToken: string; user: { id: string; phone?: string; nickname?: string } }`（R25）

- [ ] **Step 1: 写 storage 的失败测试**

Create `apps/client/test/storage.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** node 环境下没有 localStorage：storage.ts 必须自己兜住（否则测试全红）。 */
describe('net/storage（令牌持久化）', () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
  });

  it('save → load 往返一致；clear 之后为 null', async () => {
    const { saveSession, loadSession, clearSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a', refreshToken: 'r', userId: 'u1' });
    expect(loadSession()).toEqual({ accessToken: 'a', refreshToken: 'r', userId: 'u1' });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('没有 localStorage（node/受限宿主）时不抛异常', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { saveSession, loadSession } = await import('../src/net/storage');
    expect(() => saveSession({ accessToken: 'a', refreshToken: 'r', userId: 'u1' })).not.toThrow();
    expect(loadSession()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- storage`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `storage.ts`**

```ts
/**
 * 令牌持久化。
 *
 * 只在**本地**保存渲染/连接所需的三项；不存任何对局状态（F03）。
 * uni-app 迁移时把 localStorage 换成 `uni.getStorageSync` / `uni.setStorageSync` 即可。
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

const KEYS = {
  access: 'ftl.accessToken',
  refresh: 'ftl.refreshToken',
  userId: 'ftl.userId',
} as const;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 隐私模式等宿主会直接抛错
  }
}

export function saveSession(session: StoredSession): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(KEYS.access, session.accessToken);
    s.setItem(KEYS.refresh, session.refreshToken);
    s.setItem(KEYS.userId, session.userId);
  } catch {
    // 配额/隐私模式：持久化失败不应让登录失败
  }
}

export function loadSession(): StoredSession | null {
  const s = store();
  if (!s) return null;
  try {
    const accessToken = s.getItem(KEYS.access) ?? '';
    const refreshToken = s.getItem(KEYS.refresh) ?? '';
    const userId = s.getItem(KEYS.userId) ?? '';
    if (!accessToken || !userId) return null;
    return { accessToken, refreshToken, userId };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(KEYS.access);
    s.removeItem(KEYS.refresh);
    s.removeItem(KEYS.userId);
  } catch {
    // 忽略
  }
}

export const STORAGE_KEYS = KEYS;
```

- [ ] **Step 4: 写 rest 轮换重试的失败测试**

Create `apps/client/test/rest-auth.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('net/rest 的鉴权与轮换（§5.1）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function jsonOnce(body: unknown, status = 200) {
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
  }

  it('authedGet 带 Authorization 头', async () => {
    const fetchMock = vi.fn(async () => jsonOnce({ code: 0, data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const rest = await import('../src/net/rest');

    await rest.authedGet('/rooms');
    // ⚠️ `vi.fn(async () => …)` 的 calls 是 `[][]`，写 `as [string, RequestInit]` 过不了 `vue-tsc --noEmit`
    // （TS2352/TS2493）。把 mock 的形参类型化后直接解构：
    //   const fetchMock = vi.fn(async (url: string, init: RequestInit) => jsonOnce({ code: 0, data: [] }));
    //   const [url, init] = fetchMock.mock.calls[0]!;
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/rooms');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('收到 10004 时用 refresh token 换一次新令牌并重放原请求', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)?.Authorization });
      if (url.endsWith('/rooms')) {
        return calls.filter((c) => c.url.endsWith('/rooms')).length === 1
          ? jsonOnce({ code: 10004, message: 'expired', data: null }, 401)
          : jsonOnce({ code: 0, data: [] });
      }
      return jsonOnce({ code: 0, data: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'u1' });

    const rest = await import('../src/net/rest');
    const res = await rest.authedGet('/rooms');

    expect(res.code).toBe(0);
    expect(calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/rooms'))[1]?.auth).toBe('Bearer access-2');
    expect(clientConfig.token).toBe('access-2');
  });

  it('refresh 也失败时不无限重试，把 10004 原样返回', async () => {
    let roomsCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/rooms')) { roomsCalls += 1; return jsonOnce({ code: 10004, data: null }, 401); }
      return jsonOnce({ code: 10004, data: null }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { clientConfig } = await import('../src/config');
    clientConfig.token = 'access-1';
    (await import('../src/net/storage')).saveSession({ accessToken: 'access-1', refreshToken: 'r', userId: 'u1' });

    const rest = await import('../src/net/rest');
    expect((await rest.authedGet('/rooms')).code).toBe(10004);
    expect(roomsCalls).toBe(1); // 只重放一次
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- rest-auth`
Expected: FAIL —— `rest.authedGet` 未定义

- [ ] **Step 6: 实现 `rest.ts` 的鉴权与轮换**

在既有 `rest.ts` 上追加（保留 `post` / `login` / `register` / `refreshToken`）：

> **⚠️ R33（执行中发现并修正）**：`logout` **必须带 `Authorization`**。
> `/api/auth/logout` 不在 §7.1 的公开路径白名单里（只有 login/register/refresh/health），
> 而 §5.1 要求登出删除**两个** jti —— access 的 jti 只能来自网关验签（`X-Token-Jti`）。
> 因此 `logout` 从「不带鉴权的 `post` 组」移到鉴权组：
>
> ```ts
> /** §5.1：登出删除两个 jti；必须带 access token，网关才会注入其 jti。 */
> export function logout(accessToken: string, refreshToken?: string): Promise<RestResponse<null>> {
>   return authedRequest<null>('POST', '/auth/logout', refreshToken ? { refreshToken } : {});
> }
> ```
>
> 并注意 `authedRequest` 的轮换兜底：access 已过期时它会先轮换再重放 —— 这正是 R35 需要的闭环
> （轮换已吊销旧 refresh jti，登出再删掉新的一对）。
>
> **⚠️ R35（执行中发现并修正）**：若轮换后登出仍未成功（refresh 也失效），只做本地清理 + 提示，
> **不得循环**。`signOut()` 的实现顺序：`logout` → 若 `10004` 则 `refresh` 一次 → 用新的一对再 `logout` → 都失败就本地清理。
> 补一条降级用例。

```ts
import type { RoomInfo } from '@fight-the-landlord/protocol';
import { loadSession, saveSession } from './storage';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (clientConfig.token) headers.Authorization = `Bearer ${clientConfig.token}`;
  return headers;
}

async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RestResponse<unknown>> {
  const res = await fetch(`${clientConfig.apiBase}${path}`, {
    method,
    headers: authHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { code: res.status, message: text };
  }
  return parsed as RestResponse<unknown>;
}

/** 单飞：并发 401 只轮换一次。 */
let refreshInFlight: Promise<boolean> | null = null;

async function rotateOnce(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const stored = loadSession();
  if (!stored?.refreshToken) return false;
  refreshInFlight = (async () => {
    const res = await post<AuthTokens>('/auth/refresh', { refreshToken: stored.refreshToken });
    if (res.code !== 0 || !res.data?.accessToken) return false;
    clientConfig.token = res.data.accessToken;
    saveSession({
      accessToken: res.data.accessToken,
      refreshToken: res.data.refreshToken ?? stored.refreshToken,
      userId: stored.userId,
    });
    return true;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** 带鉴权的请求：遇 `10004` 轮换一次后**重放一次**；再失败就原样返回（不循环）。 */
export async function authedRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RestResponse<T>> {
  const first = (await send(method, path, body)) as RestResponse<T>;
  if (first.code !== 10004) return first;
  if (!(await rotateOnce())) return first;
  return (await send(method, path, body)) as RestResponse<T>;
}

export function authedGet<T>(path: string): Promise<RestResponse<T>> {
  return authedRequest<T>('GET', path);
}

/** §3.1 / R22：`GET /api/rooms` → `{ code, data: RoomInfo[] }`。 */
export function rooms(): Promise<RestResponse<RoomInfo[]>> {
  return authedGet<RoomInfo[]>('/rooms');
}
```

`LoginResult` 的 `refreshToken` 由可选改为必填（R25）：

```ts
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd apps/client && pnpm test -- rest-auth storage`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add apps/client/src/net apps/client/test
git commit -m "feat(client): 令牌持久化 + 鉴权请求在 10004 时轮换一次并重放（§5.1/R25）"
```

---

## Task 5: 前端 —— 登录/大厅接线真实认证（前端 agent）

**Files:**
- Modify: `apps/client/src/stores/auth.ts`
- Modify: `apps/client/src/pages/lobby.vue`
- Modify: `apps/client/src/pages/login.vue`
- Modify: `apps/client/src/main.ts`
- Test: `apps/client/test/auth-flow.test.ts`（新建）

**Interfaces:**
- Consumes: `rest.rooms()`、`rest.logout()`、`storage.saveSession/loadSession/clearSession`
- Produces: `useAuthStore().hydrate()`、`signOut()` 调用服务端登出；`lobby.vue` 渲染 `RoomInfo`（含 `baseScore`）

- [ ] **Step 1: 写失败测试**

Create `apps/client/test/auth-flow.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

describe('auth store 的持久化与登出（§5.1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    vi.resetModules();
  });

  it('hydrate 把存储中的令牌写回 store 与 clientConfig', async () => {
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1' });
    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');

    const auth = useAuthStore();
    auth.hydrate();

    expect(auth.loggedIn).toBe(true);
    expect(auth.userId).toBe('u1');
    expect(auth.page).toBe('lobby');
    expect(clientConfig.token).toBe('a1');
  });

  it('signOut 调服务端登出并清空本地存储与状态', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { saveSession } = await import('../src/net/storage');
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1' });

    const { useAuthStore } = await import('../src/stores/auth');
    const { clientConfig } = await import('../src/config');
    const { loadSession } = await import('../src/net/storage');
    const auth = useAuthStore();
    auth.hydrate();

    await auth.signOut();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'), expect.anything());
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');
    expect(auth.loggedIn).toBe(false);
    expect(auth.page).toBe('login');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- auth-flow`
Expected: FAIL —— `auth.hydrate` 未定义

- [ ] **Step 3: 改 `stores/auth.ts`**

在 `actions` 里加/改：

```ts
/** 从本地存储恢复会话（入口在 startGameSession 之前调用）。 */
hydrate(): boolean {
  const stored = loadSession();
  if (!stored) return false;
  this.accessToken = stored.accessToken;
  this.refreshToken = stored.refreshToken;
  this.userId = stored.userId;
  clientConfig.token = stored.accessToken;
  this.loggedIn = true;
  this.page = 'lobby';
  return true;
},

applySession(result: rest.LoginResult) {
  this.accessToken = result.accessToken;
  this.refreshToken = result.refreshToken;
  this.userId = result.user.id;
  clientConfig.token = result.accessToken;
  saveSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, userId: result.user.id });
  this.loggedIn = true;
  this.error = '';
  this.page = 'lobby';
},

/** §5.1：登出要让服务端吊销令牌；网络失败也必须清干净本地。 */
async signOut(): Promise<void> {
  const refreshToken = this.refreshToken;
  try {
    if (refreshToken) await rest.logout(refreshToken);
  } catch {
    // 服务端不可达不阻塞本地登出
  }
  clearSession();
  this.accessToken = '';
  this.refreshToken = '';
  this.userId = '';
  clientConfig.token = '';
  this.loggedIn = false;
  this.page = 'login';
},
```

`enterAsDevUser()` 保持（连 mock 用），但加注释说明它**不带 token**、只对 mock 有效。

- [ ] **Step 4: 改 `lobby.vue` 的房间列表**

- 删掉 `extractRooms()` 兼容 shim 与文件头「⚠️ 待协调者裁决」注释（R22）；
- `loadRooms()` 改为 `const res = await rest.rooms(); rooms.value = res.code === 0 ? (res.data ?? []) : [];`，`res.code !== 0` 时把 `message` 显示出来；
- `RoomListItem` 直接用 `RoomInfo`（`import type { RoomInfo } from '@fight-the-landlord/protocol'`），列表项展示 `code / status / playerCount / maxPlayers / baseScore`；
- 「退出」按钮改为 `@click="onSignOut"`，`onSignOut()` 里 `await auth.signOut()` 并 `stopGameSession()`。

- [ ] **Step 5: 改 `main.ts` 与 `login.vue`**

`main.ts`：在 `startGameSession(socketFactory)` **之前** hydrate：

```ts
const pinia = createPinia();
app.use(pinia);
setActivePinia(pinia);

const auth = useAuthStore();
auth.hydrate(); // 先恢复令牌，socket 握手才会用上它（config.buildSocketAuth 读 clientConfig.token）

const socketFactory = createSocketIoFactory(io);
startGameSession(socketFactory);
```

`login.vue`：登录成功后必须用**新**令牌重建连接，但当前会话是应用启动时就建好的（那时可能还是匿名/开发身份）。

⚠️ **不要**从 `main.ts` 导出 `socketFactory`（`main.ts → App.vue → login.vue → main.ts` 会形成入口模块循环依赖）。正确做法是让 `useGameSession.ts` 记住工厂：

`apps/client/src/composables/useGameSession.ts` 增加（工厂仍是外部注入，`net` 层依旧不 import socket.io-client）：

```ts
let storedFactory: SocketFactory | null = null;

/** 记录入口注入的工厂，供登录/登出后重建会话使用。 */
export function startGameSession(socketFactory: SocketFactory): GameSessionHandle {
  storedFactory = socketFactory;
  // …既有实现不变
}

/** 用**当前**的令牌重建会话（登录成功、登出之后调用）。 */
export function restartGameSession(): GameSessionHandle {
  if (!storedFactory) throw new Error('会话尚未初始化：请先调用 startGameSession()');
  stopGameSession();
  return startGameSession(storedFactory);
}
```

`login.vue` 在 `signIn`/`signUp` 成功后调用 `restartGameSession()`（登录前若已有匿名会话，`restartGameSession` 会先 `stopGameSession`）。`lobby.vue` 的登出在 `auth.signOut()` 之后调用 `stopGameSession()`。

- [ ] **Step 6: 跑测试与构建**

```bash
cd apps/client
pnpm test          # 期望全绿（既有 86 + 新增）
pnpm lint
pnpm build
```

- [ ] **Step 7: 提交**

```bash
git add apps/client
git commit -m "feat(client): 登录/大厅接真实认证（持久化、登出、RoomInfo 列表）（§5.1/§3.1/R22）"
```

---

## Task 6: conformance —— 切片 6 用例（协调者）

**Files:**
- Modify: `tools/conformance/src/lib/http.ts`
- Create: `tools/conformance/src/slices/slice-06-auth-rooms.ts`
- Modify: `tools/conformance/src/run.ts`
- Modify: `tools/conformance/src/lib/assert.ts`（加 `assertNoKeys`）

**Interfaces:**
- Consumes: `HarnessClient`（切片 5 已有）、真实后端 3000–3003
- Produces: `runSlice06(): Promise<Checks>`

- [ ] **Step 1: 给 `lib/http.ts` 补认证助手**

```ts
export interface TokenPair { accessToken: string; refreshToken: string }

export async function postJson<T>(path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function getJson(path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export function login(phone: string, password: string) {
  return postJson<{ code: number; data: { accessToken: string; refreshToken: string; user: { id: string } } }>(
    '/api/auth/login', { phone, password });
}
```

（`postJson` 返回 `{status, body}`；`api/health` 之外的所有用例都走网关。）

- [ ] **Step 2: 写用例**

Create `tools/conformance/src/slices/slice-06-auth-rooms.ts`，断言序列：

1. `POST /api/auth/register` → HTTP 201，`body.code === 0`，`data.accessToken` / `data.refreshToken` / `data.user.id` 齐全；
2. 同一手机号再注册 → `body.code === 11001` 且 HTTP 409；
3. `POST /api/auth/login` 密码错 → `code === 11002`；不存在的手机号 → `code === 11004`；
4. `POST /api/auth/login` 正确 → `code === 0`；
5. **匿名** `GET /api/rooms` → HTTP 401（§7.1 白名单只放行 4 条）；
6. 带 token `POST /api/rooms {mode:'random'}` → `code === 0`，拿到 `code`；
7. 带 token `GET /api/rooms` → `body.code === 0`，`Array.isArray(body.data)`；每个元素的键**恰好**是 `['baseScore','code','maxPlayers','mode','playerCount','status']`；刚建的房间在列表里且 `playerCount === 0`；序列化文本不含 `players` / `isRobot`；
8. `POST /api/auth/refresh {refreshToken}` → `code === 0`，新的一对 != 旧的；**旧 refresh token 再 refresh → `code !== 0`**（轮换生效）；
9. 用**旧 access token** 访问 `GET /api/rooms` → 仍然可用（access 未被轮换吊销）——这一条是**故意**的：§5.1 只规定 refresh 轮换；
10. `POST /api/auth/logout`（带新 access token + 新 refresh token）→ `code === 0`；
11. 登出后**同一 access token** 访问 `GET /api/rooms` → `code === 10004`（R26 白名单真正生效）；
12. 登出后**同一 refresh token** 再 refresh → `code !== 0`；
13. `GET /api/rooms` 的 `mode` 只能是 `'random' | 'practice'`，`status` 只能是四个合法值之一。

- [ ] **Step 3: 注册进 `run.ts`**

```ts
const CASES: Record<string, Case> = {
  'slice-05': { title: '断线重连', run: runSlice05 },
  'slice-06': { title: '登录 + 房间列表', run: runSlice06 },
};
```

- [ ] **Step 4: 构建并跑**

```bash
pnpm --filter @fight-the-landlord/conformance build
docker compose build && docker compose up -d     # 必须先重建镜像，否则测的是旧代码
node tools/conformance/dist/run.js slice-06
```

Expected: `✅ slice-06 通过：N 项断言`

- [ ] **Step 5: 提交**

```bash
git add tools/conformance
git commit -m "test(conformance): 切片 6 用例 —— 注册/登录/房间列表/令牌轮换/登出吊销"
```

---

## 切片 6 门禁（三者同时通过才算完成）

```bash
# 后端 DoD
pnpm --filter @fight-the-landlord/user-service test
pnpm --filter @fight-the-landlord/api-gateway test
pnpm --filter @fight-the-landlord/room-service test
pnpm test && pnpm lint                       # 期望 19/19 三项

# 前端 DoD
cd apps/client && pnpm test && pnpm lint && pnpm build

# conformance（先重建镜像）
docker compose build && docker compose up -d
node tools/conformance/dist/run.js slice-06
node tools/conformance/dist/run.js slice-05   # 回归：上一片不得被打回
```

**硬性回归断言**：`slice-05` 必须仍然全绿（切片 6 改了网关的验签路径，而 WS 代理与 HTTP 中间件共用 `JwtService`）。

---

## Self-Review

**1. Spec coverage**

| §5.1 / §3.1 / §7.1 / §7.3 要求 | 落在哪个任务 |
|---|---|
| access 2h + refresh 7d | Task 1（`ACCESS/REFRESH_TOKEN_TTL_SECONDS`） |
| `POST /api/auth/refresh` 入参/出参/轮换 | Task 1 Step 10 + Task 2 Step 7 + Task 6 断言 8 |
| `session:{jti}` 白名单 + TTL = 剩余有效期 | Task 1（`issuePair` 写两张） |
| 登出删除两个 jti | Task 1 Step 8/10 + Task 2 Step 7 + Task 6 断言 10–12 |
| 载荷 `{sub, phone, jti, exp, iat}` + `typ` | Task 1（R24） |
| 网关公开路径白名单仅 4 条 | Task 2（`publicPaths` 不动）+ Task 6 断言 5 |
| `GET /api/rooms → RoomInfo[]` | Task 3 + Task 6 断言 7 |
| `RoomInfo` 六字段、`cancelled` 在状态联合里 | Task 3 |
| `KEYS` → `SCAN`（A8） | Task 3 Step 3 |
| 统一响应形态 `{code,message,data}` | Task 1（user-service）、Task 2（网关 401/503）、Task 3（room-service） |
| 认证错误码 11001/11002/11003/11004 | Task 1 Step 8 + Task 6 断言 2–3 |
| 前端令牌持久化与刷新 | Task 4、Task 5 |
| 端口从 `PORT` 读取（偏差 E2） | **未覆盖 —— 见下** |
| 限流（§5.4）、日志脱敏（§5.5） | **本片不做**（不在切片表第 6 行） |

**已知未覆盖并记录**：`user-service` 硬编码 `listen(3001)`（A.2 E2）不在本片 DoD 内，且改动它需要同步 `docker-compose.yml` 的端口映射 —— **留给切片 7**（匹配链路会碰 compose）。

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤都给了可直接粘贴的代码或精确的改动点。写计划过程中当场收敛掉的三处歧义，都已在正文定稿、不留悬空：
- 登出如何拿到 access token 的 `jti` → 网关**仅对 `/api/auth/logout`** 注入内部头 `X-Token-Jti`（不进 §5.2 通用身份契约、不下发客户端）；
- 登录成功后如何用新令牌重建 WS 会话 → `useGameSession.restartGameSession()`（**不从 `main.ts` 导出工厂**，避免入口模块循环依赖）；
- `GET /api/rooms` 的响应形状 → R22 定为平台统一信封 `{ code, message, data: RoomInfo[] }`。

**3. Type consistency**

- `TokenPair` / `TokenClaims` / `sessionKey` 在 Task 1 定义；Task 2 的 `session.guard.ts` **只复制键形状**（不 import user-service），Task 6 断言基于 HTTP 契约，三处一致。
- `LoginResult = { accessToken, refreshToken, user }` 在 Task 1 产出、Task 4 声明、Task 5 消费，字段名一致。
- `RoomInfo` 六个字段在 Task 3 定义、Task 5 渲染、Task 6 断言（用 `Object.keys().sort()` 精确比对），三处一致。
- `rest.rooms()` 在 Task 4 定义、Task 5 调用，签名一致。

---

## 执行方式

**Subagent-Driven（推荐）** —— 我按 Task 顺序派实现者 subagent，每个 Task 后派 task reviewer（spec 合规 + 质量），frontend/backend 两条线并行（文件集不相交），全部完成后我做合并与门禁。

**Inline Execution** —— 在本会话内按 Task 批量执行，带检查点。
