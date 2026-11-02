# 注册邀请码必填 + 一次性邀请码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 注册时强制填写代理邀请码，邀请码一次性消费，代理可自助批量生成；后台用独立开关控制必填。

**Architecture:** protocol 新增 `agent.inviteRequired` 配置键与 `agentInviteRequired` 客户端裸名；config-service 下发到 `/api/config` 与公开 `/api/config/boot`；user-service 在注册链路按 `enabled && required` 强制空码拒绝，并用手机号级 Redis 短锁防并发烧码；currency-service 把 `agent_invite_codes` 扩展为 `active/used/revoked` 一次性码，消费时按 `agent → code → binding` 锁序原子抢占；代理端新增批量生成/列表，管理端新增 super_admin 专属码列表与单码撤销；客户端注册页增加必填展示/校验与 boot 竞态兜底。

**Tech Stack:** TypeScript, NestJS, TypeORM/MySQL, ioredis, Vue 3/uni-app, Vitest, pnpm workspace.

## Global Constraints

- 只改本计划列出的文件；工作区现有的麻将改动（`apps/client/src/components/table/mahjong/*` 等）**不得** stage/commit。
- 每个任务严格 TDD：先写失败测试 → 运行确认红 → 最小实现 → 运行确认绿 → commit。
- 每个 commit 末尾带：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 不新增错误码；复用 `11006`（邀请码）、`11007`（代理冻结）、`10001`（参数）、`10003`（权限）、`10006`（限流）。
- 配置键计数：protocol `CONFIG_KEYS` 112 → 113；`CLIENT_CONFIG_KEYS` 22 → 23；boot 2 → 3 字段；admin `verify-admin-static` 113/97/97/90/44/44/6。
- `agent.*` 配置写权限仅 `super_admin`（已有 P-ag0 前缀规则）。
- 管理端 active 邀请码列表仅 `super_admin` 可读（bearer credential）。
- 日志不得打印完整邀请码；只允许 `agentId + 码后 2 位 + status`。
- 单测不依赖真 MySQL/Redis（仓库既有纪律）；事务回滚由假 DB 模拟，真实并发由 conformance slice-32 覆盖。
- 不实现：码有效期、非代理通用邀请码、代理自助撤销、客户端版本闸、跨 RPC 注册幂等键。

---

### Task 1: protocol — 新配置键与 bind 忽略原因

**Files:**
- Modify: `packages/protocol/src/config.ts`
- Modify: `packages/protocol/src/rpc.ts`
- Test: `packages/protocol/src/config.test.ts`

**Interfaces:**
- Produces: `ConfigKey` 含 `'agent.inviteRequired'`；`ClientConfig.agentInviteRequired: boolean`；`AgentBindIgnoreReason = 'settings_disabled' | 'invite_disabled' | 'config_unavailable'`；`AgentBindData.reason?: AgentBindIgnoreReason`。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 的 `CONFIG_KEYS` 期望里，`'agent.inviteEnabled'` 后加：

```ts
      'agent.inviteRequired',
```

在 `CLIENT_CONFIG_KEYS` 期望里，`'agentInviteEnabled'` 后加：

```ts
      'agentInviteRequired',
```

在 `parseConfigValue` describe 里加：

```ts
  it('代理第 102 键 agent.inviteRequired：严格 boolean（拒字符串/数字）', () => {
    expect(parseConfigValue('agent.inviteRequired', true)).toBe(true);
    expect(parseConfigValue('agent.inviteRequired', false)).toBe(false);
    expect(() => parseConfigValue('agent.inviteRequired', 'true')).toThrow(/boolean/);
    expect(() => parseConfigValue('agent.inviteRequired', 1)).toThrow(/boolean/);
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/protocol test -- src/config.test.ts
```

Expected: FAIL（`agent.inviteRequired` 不在 `CONFIG_KEYS` / `parseConfigValue` 不认）。

- [ ] **Step 3: 实现**

`packages/protocol/src/config.ts`：

```ts
  /** 代理分润（2026-11-03）：注册邀请码必填开关（严格 boolean、种子 false；客户端可见——裸名 `agentInviteRequired`）。 */
  'agent.inviteRequired',
```

放在 `'agent.inviteEnabled'` 之后。`CLIENT_CONFIG_KEYS` 末尾加：

```ts
  /** 代理分润：注册邀请码必填（缺键/旧服务端 ⇒ false）。 */
  'agentInviteRequired',
```

`ClientConfig` 接口在 `agentInviteEnabled: boolean;` 后加：

```ts
  agentInviteRequired: boolean;
```

`parseConfigValue` 在 `agent.inviteEnabled` 分支旁加：

```ts
  if (key === 'agent.inviteRequired') return parseStrictBoolean(key, value);
```

`packages/protocol/src/rpc.ts`：

```ts
/** 代理绑定被忽略的原因（注册照常；用于指标与告警）。 */
export type AgentBindIgnoreReason =
  | 'settings_disabled'
  | 'invite_disabled'
  | 'config_unavailable';

export interface AgentBindData {
  status: AgentBindStatus;
  reason?: AgentBindIgnoreReason;
}
```

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/protocol test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/rpc.ts packages/protocol/src/config.test.ts
git commit -m "feat(protocol): 新增 agent.inviteRequired 与 bind 忽略原因"
```

---

### Task 2: config-service — 种子、boot 三字段、全量配置

**Files:**
- Create: `packages/config-service/src/migrations/1798700000000-AgentInviteRequiredSeed.ts`
- Modify: `packages/config-service/src/config/client-config.controller.ts`
- Modify: `packages/config-service/test/client-config.test.ts`
- Modify: `packages/config-service/test/migration.test.ts`
- Modify: `packages/config-service/test/helpers/config-probe.ts`

**Interfaces:**
- Consumes: Task 1 的 `'agent.inviteRequired'` / `agentInviteRequired`。
- Produces: `GET /api/config/boot` 返回 `{version, agentInviteEnabled, agentInviteRequired}`；`GET /api/config` 含 `agentInviteRequired`。

- [ ] **Step 1: 写失败测试**

`client-config.test.ts`：

```ts
  it('GET /api/config/boot：只回 version + agentInviteEnabled + agentInviteRequired（公开启动面）', async () => {
    const probe = await startHttpProbe(makeService(seedDb()).svc);
    try {
      const res = await probe.get('/api/config/boot');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(ErrCode.OK);
      expect(Object.keys(res.body.data).sort()).toEqual([
        'agentInviteEnabled',
        'agentInviteRequired',
        'version',
      ]);
      expect(typeof res.body.data.agentInviteRequired).toBe('boolean');
      expect(res.body.data.agentInviteRequired).toBe(false);
    } finally {
      await probe.close();
    }
  }, 20000);
```

把原「二十二键」用例的逐字名单加入 `'agentInviteRequired'`（排序在 `agentInviteEnabled` 后），标题与 `toHaveLength(22)` 改为 23。再补充缺行/坏值：

```ts
  it('agent.inviteRequired 缺行/坏值 ⇒ false', async () => {
    const { svc, db } = makeService(seedDb());
    db.rows.delete('agent.inviteRequired');
    const probe = await startHttpProbe(svc);
    try {
      expect((await probe.get('/api/config')).body.data.agentInviteRequired).toBe(false);
    } finally {
      await probe.close();
    }
  });
```

`migration.test.ts` 增加对新迁移的断言：类名 `AgentInviteRequired1798700000000`、`up()` 恰一条 `INSERT IGNORE`、`down()` 恰一条 `DELETE`、时间戳全仓唯一且大于该服务既有迁移。

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/config-service test -- test/client-config.test.ts test/migration.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

新迁移（照 `1796900000000-AgentInviteKey.ts` 的 version=MAX / INSERT IGNORE 纪律）：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AgentInviteRequired1798700000000 implements MigrationInterface {
  name = 'AgentInviteRequired1798700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | string | null }>;
    const rawMax = Number(maxRows[0]?.maxVersion ?? 0);
    const version = Number.isFinite(rawMax) ? Math.max(1, rawMax) : 1;
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES (?, ?, ?, NOW(3), ?)',
      ['agent.inviteRequired', JSON.stringify(false), version, 'seed'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM `platform_config` WHERE `key` = ?', [
      'agent.inviteRequired',
    ]);
  }
}
```

`client-config.controller.ts`：

- `boot()` 返回类型与 data 增加 `agentInviteRequired: boolean`。
- `get()` 在 `agentInviteEnabled` 旁加：

```ts
        agentInviteRequired: readBoolean(byKey, 'agent.inviteRequired', undefined, false),
```

- 更新注释：客户端子集 23 键、boot 3 字段。

`config-probe.ts` 的 SEED/默认行增加 `agent.inviteRequired: false`（按该文件实际结构补）。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/config-service test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/config-service/src/migrations/1798700000000-AgentInviteRequiredSeed.ts \
  packages/config-service/src/config/client-config.controller.ts \
  packages/config-service/test/client-config.test.ts \
  packages/config-service/test/migration.test.ts \
  packages/config-service/test/helpers/config-probe.ts
git commit -m "feat(config): 下发 agent.inviteRequired 并补种子迁移"
```

---

### Task 3: user-service — 配置读取、DTO 归一、必填拒绝

**Files:**
- Modify: `packages/user-service/src/config/config-cache.service.ts`
- Modify: `packages/user-service/src/users/users.dto.ts`
- Modify: `packages/user-service/src/auth/auth.service.ts`
- Test: `packages/user-service/test/auth.service.test.ts`

**Interfaces:**
- Produces: `ConfigCacheService.agentInviteEnabled(): boolean`、`agentInviteRequired(): boolean`。
- Consumes: Task 1 的键名；Task 1 的 `AgentBindIgnoreReason`（仅日志）。

- [ ] **Step 1: 写失败测试**

`auth.service.test.ts` 的 `configCache` 假件增加：

```ts
    configCache = {
      signupGrant: vi.fn(() => 0),
      deviceBindingEnabled: vi.fn(() => false),
      agentInviteEnabled: vi.fn(() => false),
      agentInviteRequired: vi.fn(() => false),
    };
```

在「代理邀请码绑定」describe 里加：

```ts
    it('必填开 + 缺码 ⇒ 11006 请填写邀请码，且不建用户/不发赠币/不调 agent.bind', async () => {
      configCache.agentInviteEnabled.mockReturnValue(true);
      configCache.agentInviteRequired.mockReturnValue(true);
      configCache.signupGrant.mockReturnValue(100);
      await expect(
        service.register({ phone: '13800000060', password: 'passw0rd', nickname: '阿豆' } as any),
      ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID, message: '请填写邀请码' });
      expect(currency.agentBind).not.toHaveBeenCalled();
      expect(currency.apply).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('必填开 + 空白串 ⇒ 同上', async () => {
      configCache.agentInviteEnabled.mockReturnValue(true);
      configCache.agentInviteRequired.mockReturnValue(true);
      await expect(
        service.register({ phone: '13800000061', password: 'passw0rd', nickname: '阿豆', inviteCode: '   ' } as any),
      ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID, message: '请填写邀请码' });
    });

    it('必填关 / 入口关 / 快照缺失 ⇒ 缺码照常注册', async () => {
      for (const flags of [
        { enabled: true, required: false },
        { enabled: false, required: true },
        { enabled: false, required: false },
      ]) {
        configCache.agentInviteEnabled.mockReturnValue(flags.enabled);
        configCache.agentInviteRequired.mockReturnValue(flags.required);
        const res = await service.register({
          phone: `138000000${62 + Number(flags.enabled)}${Number(flags.required)}` as any,
          password: 'passw0rd',
          nickname: '阿豆',
        } as any);
        expect(res.accessToken).toBeTruthy();
      }
    });
```

再补一条「必填开 + ignored 带 reason ⇒ 注册成功 + warn」：

```ts
    it('必填开 + agent.bind ignored(reason) ⇒ 注册成功且日志带 reason', async () => {
      configCache.agentInviteEnabled.mockReturnValue(true);
      configCache.agentInviteRequired.mockReturnValue(true);
      currency.agentBind.mockResolvedValueOnce({ status: 'ignored', reason: 'settings_disabled' });
      const res = await service.register({
        phone: '13800000070', password: 'passw0rd', nickname: '阿豆', inviteCode: 'ABCD2345',
      } as any);
      expect(res.accessToken).toBeTruthy();
    });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/user-service test -- test/auth.service.test.ts
```

Expected: FAIL（getter 不存在 / 缺码仍注册）。

- [ ] **Step 3: 实现**

`config-cache.service.ts` 在 `deviceBindingEnabled()` 旁加：

```ts
  /** 代理邀请码入口开关（第 101 键，种子 false）。缺失/坏值/快照不可用 ⇒ false。 */
  agentInviteEnabled(): boolean {
    return this.snapshot?.['agent.inviteEnabled']?.value === true;
  }

  /** 代理邀请码必填开关（第 102 键，种子 false）。缺失/坏值/快照不可用 ⇒ false（fail-open）。 */
  agentInviteRequired(): boolean {
    return this.snapshot?.['agent.inviteRequired']?.value === true;
  }
```

`users.dto.ts` 的 `inviteCode` Transform 改为：

```ts
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : undefined,
  )
```

`auth.service.ts` 在 `const userId = randomUUID();` 之后、bind 之前加：

```ts
    const inviteRequired =
      this.configCache.agentInviteEnabled() && this.configCache.agentInviteRequired();
    if (inviteRequired && inviteCode.length === 0) {
      throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '请填写邀请码');
    }
```

注意：`inviteCode` 已在现有代码里归一化；这段要放在 `const inviteCode = ...` 之后。

`agent.bind` 返回 `ignored` 时：

```ts
      const bind = await this.currencyClient.agentBind({ ... });
      if (bind.status === 'ignored' && inviteRequired) {
        this.logger.warn(
          `agent bind ignored while invite required (userId=${userId}, reason=${bind.reason ?? 'unknown'})`,
        );
      }
```

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/user-service test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/user-service/src/config/config-cache.service.ts \
  packages/user-service/src/users/users.dto.ts \
  packages/user-service/src/auth/auth.service.ts \
  packages/user-service/test/auth.service.test.ts
git commit -m "feat(user): 注册按 enabled && required 强制邀请码"
```

---

### Task 4: user-service — 同手机号注册短锁

**Files:**
- Modify: `packages/user-service/src/auth/auth.service.ts`
- Test: `packages/user-service/test/auth.service.test.ts`

**Interfaces:**
- Produces: `register()` 对同手机号并发返回 `10006`；锁 key `register:phone:<sha256>`、TTL 10s、token/Lua 释放。

- [ ] **Step 1: 写失败测试**

把 `fakeRedis` 扩展为可注入 `set` 结果：

```ts
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    eval: vi.fn(async () => 1),
  } as any;
}
```

在 `beforeEach` 里保留 `const redis = fakeRedis();` 并把它挂到测试变量 `redisMock` 上。

新增用例：

```ts
  it('同手机号锁：SET NX 拿不到 ⇒ 429/10006，不建用户', async () => {
    redisMock.set.mockResolvedValueOnce(null);
    await expect(
      service.register({ phone: '13800000080', password: 'passw0rd', nickname: '阿豆' } as any),
    ).rejects.toMatchObject({ code: ErrCode.RATE_LIMITED });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('同手机号锁：成功/失败都释放（Lua 条件删）', async () => {
    await service.register({ phone: '13800000081', password: 'passw0rd', nickname: '阿豆' } as any);
    expect(redisMock.eval).toHaveBeenCalledTimes(1);

    redisMock.eval.mockClear();
    configCache.agentInviteEnabled.mockReturnValue(true);
    configCache.agentInviteRequired.mockReturnValue(true);
    await expect(
      service.register({ phone: '13800000082', password: 'passw0rd', nickname: '阿豆' } as any),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID });
    expect(redisMock.eval).toHaveBeenCalledTimes(1);
  });

  it('Redis 异常 ⇒ fail-open，注册照常', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('redis down'));
    const res = await service.register({
      phone: '13800000083', password: 'passw0rd', nickname: '阿豆',
    } as any);
    expect(res.accessToken).toBeTruthy();
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/user-service test -- test/auth.service.test.ts
```

Expected: FAIL（没有锁；`redisMock.eval` 未被调用）。

- [ ] **Step 3: 实现**

`auth.service.ts` import `createHash`：

```ts
import { createHash, randomUUID } from 'crypto';
```

把现有 `register` 主体改名为 `private async registerLocked(dto: RegisterDto)`，新 `register` 包裹：

```ts
  async register(dto: RegisterDto): Promise<AuthResult> {
    const release = await this.acquirePhoneLock(dto.phone);
    try {
      return await this.registerLocked(dto);
    } finally {
      await release();
    }
  }

  private async acquirePhoneLock(phone: string): Promise<() => Promise<void>> {
    const key = `register:phone:${createHash('sha256').update(phone.trim()).digest('hex')}`;
    const token = randomUUID();
    const noop = async () => undefined;
    try {
      const ok = await this.redis.set(key, token, 'PX', 10_000, 'NX');
      if (ok !== 'OK') {
        throw new DomainError(ErrCode.RATE_LIMITED, '操作太频繁，请稍后再试');
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      this.logger.warn(`registration phone lock unavailable: ${String(err)}`);
      return noop;
    }
    return async () => {
      try {
        await this.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        );
      } catch (err) {
        this.logger.warn(`registration phone lock release failed: ${String(err)}`);
      }
    };
  }
```

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/user-service test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/user-service/src/auth/auth.service.ts packages/user-service/test/auth.service.test.ts
git commit -m "feat(user): 同手机号注册短锁防止并发烧码"
```

---

### Task 5: currency-service — 迁移与一次性码服务

**Files:**
- Create: `packages/currency-service/src/migrations/1798600000000-AgentInviteSingleUse.ts`
- Modify: `packages/currency-service/src/agent/agent-invite.service.ts`
- Create: `packages/currency-service/test/agent-invite-single-use.migration.test.ts`
- Modify: `packages/currency-service/test/agent-invite.test.ts`

**Interfaces:**
- Produces:
  - `ResolvedInvite { agentId: string; agentName: string; agentStatus: string; codeStatus: string }`
  - `resolve(manager, code): Promise<ResolvedInvite | null>`（不过滤 code status）
  - `createMany(manager, agentId, count): Promise<string[]>`
  - `rotate(manager, agentId): Promise<{ code: string; revoked: number }>`
  - `activeCode(agentId): Promise<string | null>`（`created_at DESC, code DESC`）

- [ ] **Step 1: 写失败测试**

`agent-invite.test.ts` 改 resolve 断言：

```ts
  it('resolve：返回 codeStatus + agentStatus（不预先过滤 code status）', async () => {
    const { manager, calls } = fakeManager({
      resolveRow: { agent_id: 'ag_1', name: '代理甲', agent_status: 'active', code_status: 'used' },
    });
    const svc = new AgentInviteService({} as never);
    const r = await svc.resolve(manager, ' abcd2345 ');
    expect(r).toEqual({
      agentId: 'ag_1',
      agentName: '代理甲',
      agentStatus: 'active',
      codeStatus: 'used',
    });
    expect(calls[0]!.sql).not.toContain("c.status = 'active'");
    expect(calls[0]!.params[0]).toBe('ABCD2345');
  });
```

新增：

```ts
  it('createMany：一次生成 N 枚，逐枚 createFor', async () => {
    const { manager } = fakeManager();
    const svc = new AgentInviteService({} as never);
    const spy = vi.spyOn(svc, 'createFor').mockResolvedValueOnce('AAAAAAAA').mockResolvedValueOnce('BBBBBBBB');
    await expect(svc.createMany(manager, 'ag_1', 2)).resolves.toEqual(['AAAAAAAA', 'BBBBBBBB']);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rotate：返回 {code, revoked}，先 UPDATE 全部 active 再插入', async () => {
    const { manager, calls } = fakeManager();
    const svc = new AgentInviteService({} as never);
    const r = await svc.rotate(manager, 'ag_1');
    expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(r.revoked).toBe(1);
    const update = calls.find((c) => c.sql.startsWith('UPDATE `agent_invite_codes`'))!;
    expect(update.sql).toContain("SET `status` = 'revoked'");
    expect(update.sql).toContain("`status` = 'active'");
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO `agent_invite_codes`'))).toBe(true);
  });
```

`fakeManager` 的 `UPDATE` 返回 `{ affectedRows: 1 }`，`resolve` 行按新列名。

新迁移测试：

```ts
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { AgentInviteSingleUse1798600000000 } from '../src/migrations/1798600000000-AgentInviteSingleUse';

function recordingRunner() {
  const statements: string[] = [];
  const runner = { query: async (sql: string) => { statements.push(sql); } } as unknown as QueryRunner;
  return { runner, statements };
}

describe('AgentInviteSingleUse 迁移', () => {
  it('up：加 used_by/used_at 两列；down：先重置 used 再删列', async () => {
    const m = new AgentInviteSingleUse1798600000000();
    const up = recordingRunner();
    await m.up(up.runner);
    expect(up.statements).toHaveLength(1);
    expect(up.statements[0]).toContain('ADD COLUMN `used_by` varchar(36)');
    expect(up.statements[0]).toContain('ADD COLUMN `used_at` datetime(3)');

    const down = recordingRunner();
    await m.down(down.runner);
    expect(down.statements).toHaveLength(2);
    expect(down.statements[0]).toContain("SET `status` = 'active' WHERE `status` = 'used'");
    expect(down.statements[1]).toContain('DROP COLUMN `used_by`');
    expect(down.statements[1]).toContain('DROP COLUMN `used_at`');
  });
});
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/currency-service test -- test/agent-invite.test.ts test/agent-invite-single-use.migration.test.ts
```

Expected: FAIL（迁移文件不存在 / resolve 形状不符）。

- [ ] **Step 3: 实现**

迁移：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AgentInviteSingleUse1798600000000 implements MigrationInterface {
  name = 'AgentInviteSingleUse1798600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `agent_invite_codes` ' +
        'ADD COLUMN `used_by` varchar(36) NULL DEFAULT NULL, ' +
        'ADD COLUMN `used_at` datetime(3) NULL DEFAULT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "UPDATE `agent_invite_codes` SET `status` = 'active' WHERE `status` = 'used'",
    );
    await queryRunner.query(
      'ALTER TABLE `agent_invite_codes` DROP COLUMN `used_by`, DROP COLUMN `used_at`',
    );
  }
}
```

`agent-invite.service.ts`：

```ts
const CODE_RESOLVE_SQL =
  'SELECT c.`agent_id`, a.`name`, a.`status` AS `agent_status`, c.`status` AS `code_status` ' +
  'FROM `agent_invite_codes` c ' +
  'JOIN `agent_accounts` a ON a.`id` = c.`agent_id` ' +
  'WHERE c.`code` = ?';
const CODE_REVOKE_ALL_SQL =
  "UPDATE `agent_invite_codes` SET `status` = 'revoked' WHERE `agent_id` = ? AND `status` = 'active'";
const CODE_ACTIVE_SQL =
  "SELECT `code` FROM `agent_invite_codes` WHERE `agent_id` = ? AND `status` = 'active' " +
  'ORDER BY `created_at` DESC, `code` DESC LIMIT 1';

export interface ResolvedInvite {
  agentId: string;
  agentName: string;
  agentStatus: string;
  codeStatus: string;
}
```

`resolve` 映射 `agentStatus` / `codeStatus`；`createMany`：

```ts
  async createMany(manager: EntityManager, agentId: string, count: number): Promise<string[]> {
    const codes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      codes.push(await this.createFor(manager, agentId));
    }
    return codes;
  }
```

`rotate`：

```ts
  async rotate(manager: EntityManager, agentId: string): Promise<{ code: string; revoked: number }> {
    const result = await manager.query(CODE_REVOKE_ALL_SQL, [agentId]);
    const revoked = affectedRowsOf(result, 'agent_invite_codes revoke all');
    const code = await this.createFor(manager, agentId);
    return { code, revoked };
  }
```

复用文件内已有的 `affectedRowsOf`（若无则按 `agent-bindings.service.ts` 同款实现）。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/currency-service test
```

Expected: PASS（`agent-bindings.test.ts` 可能因 resolve 形状变化红，Task 6 一并修；若红，先只跑本任务两个文件）。

- [ ] **Step 5: Commit**

```bash
git add packages/currency-service/src/migrations/1798600000000-AgentInviteSingleUse.ts \
  packages/currency-service/src/agent/agent-invite.service.ts \
  packages/currency-service/test/agent-invite-single-use.migration.test.ts \
  packages/currency-service/test/agent-invite.test.ts
git commit -m "feat(currency): 邀请码表支持一次性消费"
```

---

### Task 6: currency-service — 绑定消费与三档分类

**Files:**
- Modify: `packages/currency-service/src/agent/agent-bindings.service.ts`
- Modify: `packages/currency-service/test/agent-bindings.test.ts`
- Modify: `packages/currency-service/test/agent-bind.rpc.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `resolve` 新形状；Task 1 的 `AgentBindIgnoreReason`。
- Produces: `BindResult { status: 'bound' | 'already_bound' | 'ignored'; reason?: AgentBindIgnoreReason }`。

- [ ] **Step 1: 写失败测试**

`agent-bindings.test.ts` 的 `makeDb` 扩展：

```ts
function makeDb(
  initial: Record<string, BindRow> = {},
  agentStatus: string | { value: string } = 'active',
  opts: { codeStatus?: string } = {},
) {
  const codeStatus = { value: opts.codeStatus ?? 'active' };
  ...
      if (sql.includes('FROM `agent_invite_codes` WHERE `code` = ?')) {
        return [{ status: codeStatus.value }];
      }
      if (sql.startsWith('UPDATE `agent_invite_codes` SET `status` = \'used\'')) {
        if (codeStatus.value !== 'active') return { affectedRows: 0 };
        codeStatus.value = 'used';
        return { affectedRows: 1 };
      }
```

`makeService` 的 config 假件增加 `hasSnapshot`：

```ts
  const config = {
    agentInviteEnabled: () => opts.inviteEnabled ?? true,
    hasSnapshot: () => opts.hasSnapshot ?? true,
  } as never;
```

- `ignored` 用例改为断言 reason：

```ts
      await expect(
        svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
      ).resolves.toEqual({ status: 'ignored', reason: 'settings_disabled' });
```

并新增 `inviteEnabled=false` → `invite_disabled`、`hasSnapshot=false` → `config_unavailable`。

- 新增分类用例：

```ts
  it('码已使用 ⇒ 11006 邀请码已被使用；revoked ⇒ 邀请码无效', async () => {
    const used = makeDb({}, 'active', { codeStatus: 'used' });
    await expect(
      makeService(used).svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID, message: '邀请码已被使用' });

    const revoked = makeDb({}, 'active', { codeStatus: 'revoked' });
    await expect(
      makeService(revoked).svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID, message: '邀请码无效' });
  });
```

- 新增「消费后 status=used、used_by 写入」：

```ts
  it('成功绑定 ⇒ 码变 used + used_by/used_at；同码第二次 ⇒ 已被使用', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    await expect(
      svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
    ).resolves.toEqual({ status: 'bound' });
    expect(db.bindings.get('u1')!.agent_id).toBe('a');
    expect(db.codeStatus.value).toBe('used');
    await expect(
      svc.bindFromSignup({ ownerId: 'u2', code: 'ABCD2345', phone: '13800000001' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID, message: '邀请码已被使用' });
  });
```

- 新增 `already_bound` 不消费新码：

```ts
  it('已有绑定 ⇒ already_bound，且不消费新码', async () => {
    const db = makeDb({ u1: { ... } });
    const { svc } = makeService(db);
    await expect(
      svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
    ).resolves.toEqual({ status: 'already_bound' });
    expect(db.codeStatus.value).toBe('active');
  });
```

- 新增「代理冻结（锁内复核）⇒ 无效」：

```ts
  it('代理冻结 ⇒ 11006 邀请码无效，码不消费', async () => {
    const db = makeDb({}, 'frozen');
    await expect(
      makeService(db).svc.bindFromSignup({ ownerId: 'u1', code: 'ABCD2345', phone: '13800000000' }),
    ).rejects.toMatchObject({ code: ErrCode.AGENT_INVITE_INVALID, message: '邀请码无效' });
    expect(db.codeStatus.value).toBe('active');
  });
```

- 事务回滚：让 binding 插入抛错，断言码仍 active：

```ts
  it('绑定写失败 ⇒ 事务回滚，码仍 active', async () => {
    const db = makeDb();
    db.manager.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT IGNORE INTO `agent_bindings`')) throw new Error('insert failed');
      return originalQuery(sql, params);
    });
    ...
    expect(db.codeStatus.value).toBe('active');
  });
```

（实现时按 `makeDb` 实际结构保存原始 query。）

`agent-bind.rpc.test.ts` 增加 reason 透传：

```ts
  it('ignored + reason 原样透传', async () => {
    const ctl = new AgentBindRpcController({
      bindFromSignup: vi.fn(async () => ({ status: 'ignored', reason: 'settings_disabled' })),
    } as unknown as AgentBindingsService);
    await expect(ctl.bind(dto)).resolves.toEqual({
      ok: true,
      data: { status: 'ignored', reason: 'settings_disabled' },
    });
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/currency-service test -- test/agent-bindings.test.ts test/agent-bind.rpc.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

`agent-bindings.service.ts`：

```ts
import type { AgentBindIgnoreReason } from '@fight-the-landlord/protocol';

export interface BindResult {
  status: 'bound' | 'already_bound' | 'ignored';
  reason?: AgentBindIgnoreReason;
}

const AGENT_STATUS_LOCK_SQL =
  'SELECT `status` FROM `agent_accounts` WHERE `id` = ? FOR UPDATE';
const CODE_STATUS_LOCK_SQL =
  'SELECT `status` FROM `agent_invite_codes` WHERE `code` = ? AND `agent_id` = ? FOR UPDATE';
const CODE_CLAIM_SQL =
  "UPDATE `agent_invite_codes` SET `status` = 'used', `used_by` = ?, `used_at` = NOW(3) " +
  "WHERE `code` = ? AND `status` = 'active'";
const BIND_SELECT_BY_OWNER_SQL =
  'SELECT `agent_id` FROM `agent_bindings` WHERE `owner_id` = ?';
```

`bindFromSignup` 事务体：

```ts
      const settings = await this.settings.getOrDefault(manager);
      if (!settings.enabled) return { status: 'ignored', reason: 'settings_disabled' };
      if (!this.config.hasSnapshot()) return { status: 'ignored', reason: 'config_unavailable' };
      if (!this.config.agentInviteEnabled()) {
        return { status: 'ignored', reason: 'invite_disabled' };
      }

      const resolved = await this.invite.resolve(manager, input.code);
      if (resolved === null) {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }

      const existing = (await manager.query(BIND_SELECT_BY_OWNER_SQL, [input.ownerId])) as Array<
        Record<string, unknown>
      >;
      if (existing.length > 0) {
        if (String(existing[0]!.agent_id) === resolved.agentId) {
          return { status: 'already_bound' };
        }
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }

      const agentRows = (await manager.query(AGENT_STATUS_LOCK_SQL, [resolved.agentId])) as Array<
        Record<string, unknown>
      >;
      if (agentRows.length === 0 || String(agentRows[0]!.status) !== 'active') {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }

      const normalized = normalizeInviteCode(input.code);
      const codeRows = (await manager.query(CODE_STATUS_LOCK_SQL, [
        normalized,
        resolved.agentId,
      ])) as Array<Record<string, unknown>>;
      if (codeRows.length === 0) {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }
      const codeStatus = String(codeRows[0]!.status);
      if (codeStatus === 'used') {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码已被使用');
      }
      if (codeStatus !== 'active') {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }

      const claimed = await manager.query(CODE_CLAIM_SQL, [input.ownerId, normalized]);
      if (affectedRowsOf(claimed, 'agent_invite_codes claim') !== 1) {
        throw new Error('不变量破坏：已锁码行但条件更新 0 行');
      }

      const phoneHash = hmacPhone(normalizePhone(input.phone));
      const phoneMasked = maskPhone(input.phone);
      const inserted = await manager.query(BIND_INSERT_IGNORE_SQL, [
        input.ownerId,
        resolved.agentId,
        phoneHash,
        phoneMasked,
      ]);
      if (affectedRowsOf(inserted, 'agent_bindings INSERT IGNORE') !== 1) {
        throw new Error(`agent_bindings INSERT IGNORE 0 行（ownerId=${input.ownerId}）`);
      }
      await manager.query(HISTORY_INSERT_SQL, [
        input.ownerId,
        resolved.agentId,
        'bind',
        'signup',
        null,
      ]);
      return { status: 'bound' };
```

删除旧的「INSERT IGNORE 后查已有绑定」分支；`already_bound` 由前置预检返回。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/currency-service test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/currency-service/src/agent/agent-bindings.service.ts \
  packages/currency-service/test/agent-bindings.test.ts \
  packages/currency-service/test/agent-bind.rpc.test.ts
git commit -m "feat(currency): 一次性邀请码原子消费与三档分类"
```

---

### Task 7: currency-service — 代理端生成/列表与 /me 状态

**Files:**
- Modify: `packages/currency-service/src/agent/agent.constants.ts`
- Modify: `packages/currency-service/src/agent/agent-portal.service.ts`
- Modify: `packages/currency-service/src/agent/agent-portal.controller.ts`
- Modify: `packages/currency-service/src/agent/agent.module.ts`（如需注入 ConfigCacheService/AgentSettingsService）
- Test: `packages/currency-service/test/agent-portal.test.ts`

**Interfaces:**
- Produces:
  - `AGENT_INVITE_DAILY_MAX = 200`、`AGENT_INVITE_BATCH_MAX = 50`
  - `AgentPortalService.generateInviteCodes(agentId: string, count: number): Promise<{ codes: string[] }>`
  - `AgentPortalService.listInviteCodes(agentId: string, status: string | undefined, cursor: string | undefined, limit: number): Promise<{ rows: InviteCodeRow[]; nextCursor: string | null }>`
  - `AgentProfile` 增加 `inviteCodesActive: number`、`inviteEnabled: boolean`、`settingsEnabled: boolean`、`required: boolean`

- [ ] **Step 1: 写失败测试**

`agent-portal.test.ts` 增加：

```ts
  it('profile：邀请码状态 flags + active 数量', async () => {
    const svc = makeService(makeDb());
    const p = await svc.profile('ag_1');
    expect(p).toMatchObject({
      inviteCode: 'CODE1234',
      inviteCodesActive: 3,
      inviteEnabled: true,
      settingsEnabled: true,
      required: false,
    });
  });

  it('generate：冻结/功能关闭/count 非法/超日限拒绝', async () => {
    const db = makeDb();
    const svc = makeService(db, { agentStatus: 'frozen' });
    await expect(svc.generateInviteCodes('ag_1', 5)).rejects.toMatchObject({ code: ErrCode.AGENT_FROZEN });

    const off = makeService(makeDb(), { inviteEnabled: false });
    await expect(off.generateInviteCodes('ag_1', 5)).rejects.toMatchObject({ code: ErrCode.FORBIDDEN });

    const svc2 = makeService(makeDb());
    await expect(svc2.generateInviteCodes('ag_1', 0)).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    await expect(svc2.generateInviteCodes('ag_1', 51)).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
  });

  it('list：status/cursor/limit；nextCursor 按 (created_at, code)', async () => {
    const db = makeDb({ inviteCodes: [...] });
    const svc = makeService(db);
    const page = await svc.listInviteCodes('ag_1', 'active', undefined, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBe(page.rows[1]!.code);
  });
```

（`makeDb` 增加 `inviteCodes`、`agentStatus`、`inviteEnabled`、`settingsEnabled`、`activeCount`、`dailyCount` 选项；`makeService` 增加 settings/config 假件。）

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/currency-service test -- test/agent-portal.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

`agent.constants.ts`：

```ts
/** 代理自助生成邀请码：单次上限与单代理每日上限。 */
export const AGENT_INVITE_BATCH_MAX = 50;
export const AGENT_INVITE_DAILY_MAX = 200;
```

`AgentPortalService` 构造器增加 `AgentSettingsService`、`ConfigCacheService`。`profile`：

```ts
      inviteCode: await this.invite.activeCode(agentId),
      inviteCodesActive: await this.countActiveCodes(agentId),
      inviteEnabled: this.config.hasSnapshot() && this.config.agentInviteEnabled(),
      settingsEnabled: (await this.settings.getOrDefault()).enabled,
      required:
        this.config.hasSnapshot() &&
        this.config.agentInviteEnabled() &&
        this.config.agentInviteRequired(),
```

注意 `settings.getOrDefault()` 需要 `EntityManager`；查看该服务签名，改用 `this.dataSource.query('SELECT enabled FROM agent_settings WHERE id = 1')` 或 `settings.getOrDefault(this.dataSource.manager)`。实现时按实际签名调整。

`generateInviteCodes`：

```ts
  async generateInviteCodes(agentId: string, count: number): Promise<{ codes: string[] }> {
    if (!Number.isInteger(count) || count < 1 || count > AGENT_INVITE_BATCH_MAX) {
      throw new DomainError(ErrCode.BAD_PARAM, '生成数量须为 1–50');
    }
    if (!this.config.hasSnapshot() || !this.config.agentInviteEnabled()) {
      throw new DomainError(ErrCode.FORBIDDEN, '邀请码功能未开放');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        'SELECT `status` FROM `agent_accounts` WHERE `id` = ? FOR UPDATE',
        [agentId],
      )) as Array<Record<string, unknown>>;
      if (rows.length === 0) throw new DomainError(ErrCode.BAD_PARAM, '代理不存在');
      if (String(rows[0]!.status) !== 'active') {
        throw new DomainError(ErrCode.AGENT_FROZEN, '代理已被冻结');
      }
      const settings = await this.settings.getOrDefault(manager);
      if (!settings.enabled) throw new DomainError(ErrCode.FORBIDDEN, '代理模块未开放');
      const today = (await manager.query(
        'SELECT COUNT(*) AS `cnt` FROM `agent_invite_codes` WHERE `agent_id` = ? AND `created_at` >= CURDATE()',
        [agentId],
      )) as Array<Record<string, unknown>>;
      if (Number(today[0]?.cnt ?? 0) + count > AGENT_INVITE_DAILY_MAX) {
        throw new DomainError(ErrCode.BAD_PARAM, '今日生成数量已达上限');
      }
      const codes = await this.invite.createMany(manager, agentId, count);
      return { codes };
    });
  }
```

`listInviteCodes`：先解析 cursor（若有）：

```ts
      const cursorRow = cursor === undefined ? null : (await this.dataSource.query(
        'SELECT `created_at`, `code` FROM `agent_invite_codes` WHERE `agent_id` = ? AND `code` = ?',
        [agentId, cursor],
      )) as Array<Record<string, unknown>>;
      if (cursor !== undefined && cursorRow.length === 0) {
        throw new DomainError(ErrCode.BAD_PARAM, 'cursor 非法');
      }
```

SQL：

```ts
      const where = ['c.`agent_id` = ?'];
      const params: unknown[] = [agentId];
      if (status !== undefined) { where.push('c.`status` = ?'); params.push(status); }
      if (cursorRow !== null) {
        where.push('(c.`created_at` < ? OR (c.`created_at` = ? AND c.`code` < ?))');
        params.push(cursorRow[0]!.created_at, cursorRow[0]!.created_at, cursorRow[0]!.code);
      }
      params.push(limit + 1);
      const rows = await this.dataSource.query(
        'SELECT c.`code`, c.`status`, c.`created_at`, c.`used_at` ' +
        'FROM `agent_invite_codes` c WHERE ' + where.join(' AND ') +
        ' ORDER BY c.`created_at` DESC, c.`code` DESC LIMIT ?',
        params,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        rows: page.map((r) => ({
          code: String(r.code),
          status: String(r.status),
          createdAt: r.created_at,
          usedAt: r.used_at,
        })),
        nextCursor: hasMore ? String(page[page.length - 1]!.code) : null,
      };
```

`AgentPortalController`：

```ts
  @Post('invite-codes')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  async generateInviteCodes(@Req() req: AgentRequest, @Body() body: { count?: unknown }) {
    try {
      const count = Number(body?.count);
      return { code: ErrCode.OK, data: await this.portal.generateInviteCodes(agentIdOf(req), count) };
    } catch (err) { throw toHttpException(err); }
  }

  @Get('invite-codes')
  @UseGuards(AgentGuard)
  async listInviteCodes(@Req() req: AgentRequest, @Query() query: Record<string, unknown>) {
    try {
      const status = query.status === undefined ? undefined : String(query.status);
      if (status !== undefined && !['active', 'used', 'revoked'].includes(status)) {
        throw new DomainError(ErrCode.BAD_PARAM, 'status 非法');
      }
      const cursor = query.cursor === undefined ? undefined : String(query.cursor);
      const limitRaw = Number(query.limit ?? 50);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 50;
      return { code: ErrCode.OK, data: await this.portal.listInviteCodes(agentIdOf(req), status, cursor, limit) };
    } catch (err) { throw toHttpException(err); }
  }
```

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/currency-service test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/currency-service/src/agent/agent.constants.ts \
  packages/currency-service/src/agent/agent-portal.service.ts \
  packages/currency-service/src/agent/agent-portal.controller.ts \
  packages/currency-service/src/agent/agent.module.ts \
  packages/currency-service/test/agent-portal.test.ts
git commit -m "feat(agent): 自助批量生成与一次性码列表"
```

---

### Task 8: currency-service — 管理端码列表、单码撤销、rotate

**Files:**
- Modify: `packages/currency-service/src/agent/agent-accounts.service.ts`
- Modify: `packages/currency-service/src/agent/agent-admin.controller.ts`
- Test: `packages/currency-service/test/agent-admin.test.ts`

**Interfaces:**
- Produces:
  - `AgentAccountsService.listInviteCodes(id, status, cursor, limit)`
  - `AgentAccountsService.revokeInviteCode(id, code, actor)`
  - `rotateInviteCode` 保持返回 `{ code }`，audit 记录 `{ code, revoked }`

- [ ] **Step 1: 写失败测试**

`agent-admin.test.ts` 的 `makeController` 增加 `listInviteCodes` / `revokeInviteCode` mock，并新增：

```ts
  it('admin 码列表：status/cursor/limit 解析；非法 status ⇒ 400', async () => {
    const { ctl, accounts } = makeController();
    await ctl.listInviteCodes('ag_1', { status: 'active', cursor: 'ABCD2345', limit: '20' });
    expect(accounts.listInviteCodes).toHaveBeenCalledWith('ag_1', 'active', 'ABCD2345', 20);
    expect(await statusOf(() => ctl.listInviteCodes('ag_1', { status: 'bad' }))).toBe(400);
  });

  it('rotate：返回 {code}（契约不变）', async () => {
    const { ctl } = makeController();
    const res = await ctl.rotateInviteCode(req, 'ag_1');
    expect(res.data).toEqual({ code: 'NEWCODE1' });
  });

  it('单码撤销：透传 actor', async () => {
    const { ctl, accounts } = makeController();
    await ctl.revokeInviteCode(req, 'ag_1', 'ABCD2345');
    expect(accounts.revokeInviteCode).toHaveBeenCalledWith('ag_1', 'ABCD2345', 'admin1');
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/currency-service test -- test/agent-admin.test.ts
```

Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现**

`agent-accounts.service.ts`：

```ts
  async listInviteCodes(
    id: string,
    status: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: string | null; counts: Record<string, number> }> {
    // 与 AgentPortalService.listInviteCodes 同款 keyset；额外 LEFT JOIN agent_bindings 取 phone_masked
  }

  async revokeInviteCode(id: string, code: string, actor: string): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager.query(
        "UPDATE `agent_invite_codes` SET `status` = 'revoked' WHERE `code` = ? AND `agent_id` = ? AND `status` = 'active'",
        [code, id],
      );
      if (affectedRowsOf(result, 'agent_invite_codes revoke') !== 1) {
        throw new DomainError(ErrCode.BAD_PARAM, '邀请码不存在或已失效');
      }
      await this.audit(manager, actor, 'agent.invite.revoke', id, null, { code }, null);
    });
  }
```

`rotateInviteCode` 中 `const rotated = await this.invite.rotate(manager, id);`，audit 用 `{ code: rotated.code, revoked: rotated.revoked }`，返回 `{ code: rotated.code }`。

`AgentAdminController`：

```ts
  @Get('admin/agents/:id/invite-codes')
  async listInviteCodes(@Param('id') id: string, @Query() query: Record<string, unknown>) { ... }

  @Post('admin/agents/:id/invite-codes/:code/revoke')
  @HttpCode(200)
  async revokeInviteCode(@Req() req: AdminRequest, @Param('id') id: string, @Param('code') code: string) { ... }
```

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/currency-service test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/currency-service/src/agent/agent-accounts.service.ts \
  packages/currency-service/src/agent/agent-admin.controller.ts \
  packages/currency-service/test/agent-admin.test.ts
git commit -m "feat(agent-admin): 码列表与单码撤销"
```

---

### Task 9: api-gateway — 显式路由与 admin 策略

**Files:**
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`
- Modify: `packages/api-gateway/src/auth/admin-policy.ts`
- Test: `packages/api-gateway/test/gateway.controller.test.ts`
- Test: `packages/api-gateway/test/admin-policy.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/agent/invite-codes`
  - `GET /api/agent/invite-codes?status&cursor&limit`
  - `GET /api/admin/agents/:id/invite-codes?status&cursor&limit`（仅 super_admin）
  - `POST /api/admin/agents/:id/invite-codes/:code/revoke`

- [ ] **Step 1: 写失败测试**

`gateway.controller.test.ts`：

```ts
  it('agent invite-codes：生成/列表显式转发，query 白名单', async () => {
    const { controller, proxy } = make();
    await controller.generateAgentInviteCodes({ count: 5 }, res, req('/api/agent/invite-codes'));
    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'POST', '/api/agent/invite-codes', { count: 5 }, res, {},
    );
    await controller.listAgentInviteCodes(
      res,
      { originalUrl: '/api/agent/invite-codes?status=active&cursor=ABCD&limit=20&x=1', headers: {} },
    );
    expect(proxy.forwardToCurrencySvc).toHaveBeenLastCalledWith(
      'GET', '/api/agent/invite-codes?status=active&cursor=ABCD&limit=20', null, res, {},
    );
  });
```

`admin-policy.test.ts`：

```ts
  it('P-ag0b：admin 邀请码列表仅 super_admin；finance 403', () => {
    expect(authorizeAdmin({ method: 'GET', normPath: '/api/admin/agents/ag_1/invite-codes', role: 'finance' })).toBe(false);
    expect(authorizeAdmin({ method: 'GET', normPath: '/api/admin/agents/ag_1/invite-codes', role: 'super_admin' })).toBe(true);
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/api-gateway test -- test/gateway.controller.test.ts test/admin-policy.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

`gateway.controller.ts` 在 agent 路由区加：

```ts
  @Post('agent/invite-codes')
  @HttpCode(200)
  async generateAgentInviteCodes(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST', '/api/agent/invite-codes', body, res, headersOf(req),
    );
  }

  @Get('agent/invite-codes')
  async listAgentInviteCodes(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/agent/invite-codes${strictQueryOf(req, ['status', 'cursor', 'limit'])}`,
      null, res, headersOf(req),
    );
  }
```

admin 区加：

```ts
  @Get('admin/agents/:id/invite-codes')
  async listAgentInviteCodesAdmin(@Param('id') id: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/agents/${encodeURIComponent(id)}/invite-codes${strictQueryOf(req, ['status', 'cursor', 'limit'])}`,
      null, res, headersOf(req),
    );
  }

  @Post('admin/agents/:id/invite-codes/:code/revoke')
  @HttpCode(200)
  async revokeAgentInviteCode(@Param('id') id: string, @Param('code') code: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST',
      `/api/admin/agents/${encodeURIComponent(id)}/invite-codes/${encodeURIComponent(code)}/revoke`,
      null, res, headersOf(req),
    );
  }
```

`admin-policy.ts` 在 P-ag1 之前加：

```ts
  // P-ag0b（2026-11-03）：admin 邀请码列表含 active bearer credential ⇒ 仅 super_admin。
  if (method === 'GET' && /^\/api\/admin\/agents\/[^/]+\/invite-codes$/.test(p)) {
    return allows('super_admin');
  }
```

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/api-gateway test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/api-gateway/src/gateway/gateway.controller.ts \
  packages/api-gateway/src/auth/admin-policy.ts \
  packages/api-gateway/test/gateway.controller.test.ts \
  packages/api-gateway/test/admin-policy.test.ts
git commit -m "feat(gateway): 代理邀请码路由与 admin 读权限"
```

---

### Task 10: 客户端 — store/composable/net 接线

**Files:**
- Modify: `apps/client/src/stores/game.ts`
- Modify: `apps/client/src/composables/useClientConfig.ts`
- Modify: `apps/client/src/net/rest.ts`
- Test: `apps/client/test/client-config-shared.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ClientConfig.agentInviteRequired`；Task 2 的 boot 3 字段。
- Produces: `game.agentInviteRequired`、`setAgentInviteRequired`、`refreshInviteBootConfig` 同时落两个标志。

- [ ] **Step 1: 写失败测试**

`client-config-shared.test.ts`：

```ts
  it('FAILSAFE：agentInviteRequired=false', () => {
    expect(FAILSAFE_CLIENT_CONFIG.agentInviteRequired).toBe(false);
  });

  it('normalize：agentInviteRequired === true 才为 true', () => {
    expect(normalizeClientConfig({ agentInviteRequired: true } as never).agentInviteRequired).toBe(true);
    expect(normalizeClientConfig({ agentInviteRequired: 'true' } as never).agentInviteRequired).toBe(false);
    expect(normalizeClientConfig({} as never).agentInviteRequired).toBe(false);
  });

  it('refreshInviteBootConfig：同时落 enabled/required，不写 clientConfigVersion', async () => {
    const store = useGameStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: { version: 7, agentInviteEnabled: true, agentInviteRequired: true },
      }),
    })));
    expect(await refreshInviteBootConfig()).toBe(true);
    expect(store.agentInviteEnabled).toBe(true);
    expect(store.agentInviteRequired).toBe(true);
    expect(store.clientConfigVersion).toBe(0);
    vi.unstubAllGlobals();
  });

  it('setClientConfig：复制 agentInviteRequired', () => {
    const store = useGameStore();
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, agentInviteRequired: true });
    expect(store.agentInviteRequired).toBe(true);
    store.setClientConfig({ ...FAILSAFE_CLIENT_CONFIG, agentInviteRequired: false });
    expect(store.agentInviteRequired).toBe(false);
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C apps/client test -- test/client-config-shared.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

`game.ts`：

- `ClientConfigState` 的 `Omit` 列表加 `'agentInviteRequired'`。
- 可选属性 `agentInviteRequired?: boolean;`（注释：缺省/旧服务端 ⇒ false）。
- state 初值 `agentInviteRequired: false,`。
- `setAgentInviteRequired(value: boolean) { this.agentInviteRequired = value === true; }`。
- `setClientConfig` 加 `this.agentInviteRequired = cfg.agentInviteRequired === true;`。

`useClientConfig.ts`：

- `FAILSAFE_CLIENT_CONFIG` 加 `agentInviteRequired: false,`。
- `normalizeClientConfig` 加 `agentInviteRequired: raw?.agentInviteRequired === true,`。
- `refreshInviteBootConfig`：

```ts
    useGameStore().setAgentInviteEnabled(res.data.agentInviteEnabled === true);
    useGameStore().setAgentInviteRequired(res.data.agentInviteRequired === true);
```

- 更新注释：boot 三字段。

`rest.ts`：`BootConfig` / boot 返回类型加 `agentInviteRequired: boolean`。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C apps/client test -- test/client-config-shared.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/stores/game.ts \
  apps/client/src/composables/useClientConfig.ts \
  apps/client/src/net/rest.ts \
  apps/client/test/client-config-shared.test.ts
git commit -m "feat(client): 接线 agentInviteRequired"
```

---

### Task 11: 客户端 — 注册页必填与 boot 竞态

**Files:**
- Modify: `apps/client/src/pages/login/login.vue`
- Test: `apps/client/test/login-screen.test.ts`

**Interfaces:**
- Consumes: Task 10 的 `store.agentInviteRequired`。
- Produces: 必填标签、空值拦截、提交 await boot、boot 失败兜底展示。

- [ ] **Step 1: 写失败测试**

`login-screen.test.ts` 新增：

```ts
  it('必填开：标签「邀请码（必填）」；空码拦截不发请求', async () => {
    const { wrapper, auth } = mountLogin();
    useGameStore().$patch({
      agentInviteEnabled: true,
      agentInviteRequired: true,
      clientConfigVersion: 1,
    });
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.find('.login__field--phone input').setValue('13800000020');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__field--nickname input').setValue('阿豆');
    expect(wrapper.find('.login__field--invite text').text()).toContain('必填');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toBe('请填写邀请码');
    expect(signUp).not.toHaveBeenCalled();
  });

  it('boot 返回 required：刷新后标签变必填', async () => {
    const { wrapper } = mountLogin();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        code: 0, data: { version: 1, agentInviteEnabled: true, agentInviteRequired: true },
      }),
    })));
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.login__field--invite text').text()).toContain('必填');
  });

  it('boot 失败：注册态仍展示邀请码输入框（兜底）', async () => {
    const { wrapper } = mountLogin();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.login__field--invite').exists()).toBe(true);
  });

  it('boot 未返回时点提交会等待，不抢跑', async () => {
    const { wrapper, auth } = mountLogin();
    let resolveFetch!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolveFetch = r; })));
    const signUp = vi.spyOn(auth, 'signUp').mockResolvedValue(true);
    await wrapper.find('.login__field--phone input').setValue('13800000021');
    await wrapper.find('.login__field--password input').setValue('secret123');
    await wrapper.findAll('.login__seg-item')[1]!.trigger('click');
    await wrapper.find('.login__field--confirm input').setValue('secret123');
    await wrapper.find('.login__field--nickname input').setValue('阿豆');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    expect(signUp).not.toHaveBeenCalled();
    resolveFetch({
      ok: true, status: 200,
      text: async () => JSON.stringify({ code: 0, data: { version: 1, agentInviteEnabled: false, agentInviteRequired: false } }),
    });
    await flushPromises();
    expect(signUp).toHaveBeenCalled();
  });
```

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C apps/client test -- test/login-screen.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

`login.vue`：

```ts
const inviteConfigLoading = ref(false);
const inviteBootFailed = ref(false);
let inviteLoadPromise: Promise<void> | null = null;

const showInviteCode = computed(
  () => isRegister.value && (game.agentInviteEnabled === true || inviteBootFailed.value),
);
const inviteRequired = computed(
  () => showInviteCode.value && game.agentInviteRequired === true,
);

function ensureInviteConfig(): Promise<void> {
  if (inviteLoadPromise !== null) return inviteLoadPromise;
  inviteLoadPromise = (async () => {
    inviteConfigLoading.value = true;
    try {
      const ok = await refreshInviteBootConfig();
      inviteBootFailed.value = !ok;
    } finally {
      inviteConfigLoading.value = false;
      inviteLoadPromise = null;
    }
  })();
  return inviteLoadPromise;
}
```

`setMode('register')` 保持 `void ensureInviteConfig()`。

`validate()` 最后加：

```ts
  if (inviteRequired.value && !inviteCode.value.trim()) return '请填写邀请码';
```

`submit()` 开头（`if (busy.value) return;` 之后）加：

```ts
  if (isRegister.value) await ensureInviteConfig();
```

模板标签：

```vue
            <text>{{ inviteRequired ? '邀请码（必填）' : (inviteBootFailed && !game.agentInviteEnabled ? '邀请码' : '邀请码（选填）') }}</text>
```

注释更新为「必填/选填 + boot 竞态兜底」。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C apps/client test -- test/login-screen.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/pages/login/login.vue apps/client/test/login-screen.test.ts
git commit -m "feat(client): 注册页邀请码必填与 boot 竞态兜底"
```

---

### Task 12: 管理后台 — 配置行、三态控件、门禁

**Files:**
- Modify: `admin/app.js`
- Modify: `admin/index.html`
- Modify: `scripts/verify-admin-static.mjs`

**Interfaces:**
- Consumes: Task 1 的键名；Task 9 的 admin 路由。
- Produces: `CONFIG_IA` / `CONFIG_CONTROLS` / `CONFIG_NOTES` / `BOOL_KEYS` 覆盖新键；`#ag-invite-row` 三态控件；计数 113/97/97/90/44/44/6。

- [ ] **Step 1: 改门禁脚本先红**

`verify-admin-static.mjs`：

- protocol 计数 112 → 113
- active/ia/note 96 → 97
- entries 89 → 90
- `BOOL_KEYS.length` 43 → 44
- 在 `BOOL_KEYS` 数组加 `'agent.inviteRequired'`
- 在精确键清单（若有）加 `'agent.inviteRequired'`

```bash
pnpm verify:admin
```

Expected: FAIL（app.js 未覆盖新键）。

- [ ] **Step 2: 实现 admin/app.js**

`CONFIG_IA` 的 `agent` → `switches` keys 加 `'agent.inviteRequired'`。

`CONFIG_CONTROLS` 加：

```js
  'agent.inviteRequired': { label: '注册邀请码必填', type: 'bool' },
```

`CONFIG_NOTES` 加：

```js
  'agent.inviteRequired': ['仅在「注册邀请码入口」开启时生效；开启后新用户必须填写有效代理邀请码。'],
```

`BOOL_KEYS` 加 `'agent.inviteRequired'`。

`renderAgentInviteRow()` 改为三态：

```js
function renderAgentInviteRow() {
  const host = $('ag-invite-row');
  if (!host) return;
  host.textContent = '';
  const enabled = currentConfig['agent.inviteEnabled']?.value === true;
  const required = currentConfig['agent.inviteRequired']?.value === true;
  const mode = !enabled ? 'off' : required ? 'required' : 'optional';
  const select = el('select', 'input');
  for (const [value, label] of [['off', '关闭'], ['optional', '选填'], ['required', '必填']]) {
    const opt = el('option', '', label);
    opt.value = value;
    opt.selected = value === mode;
    select.append(opt);
  }
  select.disabled = !canWriteConfigKey('agent.inviteRequired');
  select.addEventListener('change', async () => {
    const next = select.value;
    if (next === 'required') {
      await putConfigKey('agent.inviteRequired', true);
      await putConfigKey('agent.inviteEnabled', true);
    } else if (next === 'optional') {
      await putConfigKey('agent.inviteRequired', false);
      await putConfigKey('agent.inviteEnabled', true);
    } else {
      await putConfigKey('agent.inviteEnabled', false);
      await putConfigKey('agent.inviteRequired', false);
    }
    await loadConfigSnapshot();
    renderAgentInviteRow();
  });
  host.append(el('label', 'field-label', '注册邀请码'), select);
  host.append(el('p', 'hint', '必填仅在代理模块启用时生效。'));
}
```

（`putConfigKey` / `loadConfigSnapshot` 按 admin/app.js 现有函数名调整；若不存在，复用现有 `putConfigKey` / `fetchConfig` 的实际名字。）

`applyAgentRole` 增加对 `#ag-invite-row select` 的禁用。

`admin/index.html` 确保 `#ag-invite-row` 位于 `#ag-settings-form` 之外（现有结构保持）。

- [ ] **Step 3: 运行确认绿**

```bash
pnpm verify:admin
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add admin/app.js admin/index.html scripts/verify-admin-static.mjs
git commit -m "feat(admin): 注册邀请码必填三态控件"
```

---

### Task 13: 代理端 — 生成/列表/状态 UI

**Files:**
- Modify: `agent/app.js`
- Modify: `agent/index.html`
- Modify: `scripts/verify-agent-static.mjs`

**Interfaces:**
- Consumes: Task 7 的 `/api/agent/invite-codes` 与 `/api/agent/me` flags。

- [ ] **Step 1: 改门禁脚本先红**

`verify-agent-static.mjs` 的 API 白名单加 `/api/agent/invite-codes`；结构 id 白名单加 `invite-gen-count`、`invite-gen-btn`、`invite-list`、`invite-status`。

```bash
node scripts/verify-agent-static.mjs
```

Expected: FAIL。

- [ ] **Step 2: 实现**

`agent/app.js`「我的」页：

- 若 `a.inviteEnabled === false || a.settingsEnabled === false`，显示 banner「邀请码功能当前未开放」并禁用生成。
- 若 `a.required === true`，显示「必填中」。
- 列表区 `#invite-list`：调用 `GET /api/agent/invite-codes?status=...`，行显示码、状态、创建/使用时间；`active` 行提供「复制」。
- 生成区：`<select id="invite-gen-count">`（1/5/10/20/50）+ `#invite-gen-btn`；点击 `POST /api/agent/invite-codes {count}`，成功后刷新列表与 `/me`。
- 「复制全部未使用」：把 active 码按行拼接复制。
- 空态：`inviteCode === null` 显示「暂无可用邀请码，请生成或联系管理员」。

`agent/index.html` 增加上述 id 的容器。

- [ ] **Step 3: 运行确认绿**

```bash
node scripts/verify-agent-static.mjs
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add agent/app.js agent/index.html scripts/verify-agent-static.mjs
git commit -m "feat(agent): 一次码生成与列表"
```

---

### Task 14: shared — 邀请码日志脱敏

**Files:**
- Modify: `packages/shared/src/logging/redact.ts`
- Test: `packages/shared/test/redact.test.ts`

**Interfaces:**
- Produces: `inviteCode` / `invite_code` 键值被替换为 `[REDACTED_INVITE_CODE]`；通用 `code` 不误伤。

- [ ] **Step 1: 写失败测试**

```ts
  it('邀请码键脱敏：inviteCode / invite_code；通用 code 不误伤', () => {
    expect(redactLogLine('{"inviteCode":"ABCD2345"}')).toContain('[REDACTED_INVITE_CODE]');
    expect(redactLogLine('{"invite_code":"ABCD2345"}')).toContain('[REDACTED_INVITE_CODE]');
    expect(redactLogLine('{"code":0}')).toContain('"code":0');
  });
```

（按该测试文件实际导出名调整。）

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/shared test -- test/redact.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

在 `redact.ts` 的密钥键正则里增加 `inviteCode|invite_code`（不要加裸 `code`）：

```ts
const SECRET_KEY = /...|(^|[._])(inviteCode|invite_code)$|.../i;
```

按现有正则拼接方式并入。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/shared test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/logging/redact.ts packages/shared/test/redact.test.ts
git commit -m "feat(shared): 邀请码日志脱敏"
```

---

### Task 15: 指标与监控

**Files:**
- Modify: `packages/user-service/src/metrics/player.metrics.ts`
- Modify: `packages/user-service/src/auth/auth.service.ts`
- Modify: `packages/currency-service/src/agent/agent.metrics.ts`
- Modify: `packages/currency-service/src/agent/agent-bindings.service.ts`
- Modify: `packages/currency-service/src/agent/agent-portal.service.ts`
- Modify: `deploy/monitoring/grafana/dashboards/05-currency.json`
- Modify: `deploy/monitoring/prometheus/rules/ftl-alerts.yml`

**Interfaces:**
- Produces metrics:
  - `user_registration_failures_total{reason}`
  - `agent_invite_generated_total`
  - `agent_invite_rejected_total{reason}`
  - `agent_invite_consumed_total{result}`
  - `agent_bind_ignored_total{reason}`

- [ ] **Step 1: 写失败测试（指标记录点）**

在 `auth.service.test.ts` / `agent-bindings.test.ts` 用 fake sink 或 spy 断言写入（按现有 metrics 测试方式；若无现成模式，至少断言服务调用不抛且指标模块导出存在）。优先补「invite_missing 时 `user_registration_failures_total` 增加」与「ignored 时 `agent_bind_ignored_total` 增加」。

- [ ] **Step 2: 运行确认红**

```bash
pnpm -C packages/user-service test -- test/auth.service.test.ts
pnpm -C packages/currency-service test -- test/agent-bindings.test.ts
```

- [ ] **Step 3: 实现**

`player.metrics.ts`：

```ts
export const userRegistrationFailuresTotal: ReturnType<typeof createCounter> = createCounter(
  'user_registration_failures_total',
  '注册失败计数（按原因）。',
  ['reason'],
);
```

`auth.service.ts` 在必填缺码、限流、上游失败、落库失败处 `.inc({ reason: '...' })`。

`agent.metrics.ts`：

```ts
export const agentInviteGeneratedTotal = createCounter('agent_invite_generated_total', '代理自助生成的邀请码枚数。');
export const agentInviteRejectedTotal = createCounter('agent_invite_rejected_total', '邀请码生成被拒次数（按原因）。', ['reason']);
export const agentInviteConsumedTotal = createCounter('agent_invite_consumed_total', '邀请码消费次数（按结果）。', ['result']);
export const agentBindIgnoredTotal = createCounter('agent_bind_ignored_total', '注册绑定被忽略次数（按原因）。', ['reason']);
```

在 `bindFromSignup` 的三个 ignored 分支和 `bound` 分支打点；在 `generateInviteCodes` 成功/拒绝处打点。

`05-currency.json` 增加代理邀请码面板（生成量、消费量、ignored、rejected）；`ftl-alerts.yml` 增加三条告警（`config_unavailable` > 0、`invite_missing` 突增、生成量异常）。

- [ ] **Step 4: 运行确认绿**

```bash
pnpm -C packages/user-service test
pnpm -C packages/currency-service test
```

- [ ] **Step 5: Commit**

```bash
git add packages/user-service/src/metrics/player.metrics.ts \
  packages/user-service/src/auth/auth.service.ts \
  packages/currency-service/src/agent/agent.metrics.ts \
  packages/currency-service/src/agent/agent-bindings.service.ts \
  packages/currency-service/src/agent/agent-portal.service.ts \
  deploy/monitoring/grafana/dashboards/05-currency.json \
  deploy/monitoring/prometheus/rules/ftl-alerts.yml
git commit -m "feat(observability): 邀请码生成/消费/忽略指标"
```

---

### Task 16: conformance 重写与键表同步

**Files:**
- Modify: `tools/conformance/src/slices/slice-32-agent.ts`
- Modify: `tools/conformance/src/slices/slice-14-config-center.ts`
- Modify: `tools/conformance/src/slices/slice-17-currency.ts`
- Modify: `tools/conformance/src/slices/slice-18-gold-room.ts`
- Modify: `tools/conformance/src/slices/slice-21-payment.ts`
- Modify: `tools/conformance/src/slices/slice-23-notify-channel.ts`
- Modify: `tools/conformance/src/slices/slice-24-ads-relief.ts`

**Interfaces:**
- Consumes: Task 7/8/9 的生成/列表/撤销 API；Task 2 的 boot 三字段。

- [ ] **Step 1: 更新键表（其余 slice）**

在 slice-14 / 17 / 18 / 21 / 24 的逐字 22 键字符串里，`agentInviteEnabled` 后插入 `agentInviteRequired`；slice-23 的「恰 21 键」文案改为 23。

- [ ] **Step 2: 重写 slice-32 注册辅助**

- 新增 `registerWithFreshCode(agentToken, phone, nickname)`：先 `POST /api/agent/invite-codes {count:1}`，再用返回码注册。
- 所有原复用 `agentA.inviteCode` 的成功注册改用新码；`agentB` 同理。
- `enabled=false` 的重复 bind 用例保留，断言 `ignored` 且码仍 active（通过后续 `invite-codes` 列表确认）。
- boot 断言改为三键 `agentInviteEnabled,agentInviteRequired,version`。
- `/me` 断言 `inviteCode` 属于 active 集合，不断言固定码。
- 新增：同码第二次 ⇒ `400/11006 邀请码已被使用`；并发同码（barrier）⇒ 恰一人成功；rotate 后旧码 ⇒ `邀请码无效`；冻结代理生成 ⇒ `11007`；冻结代理码注册 ⇒ `11006`。
- `putConfigAndWait` 扩展为同时等待 currency-service 与 user-service 的 `config snapshot applied version=…`；新增 `putConfigAndWaitBoth`。
- finally 同时恢复 `agent.inviteEnabled`、`agent.inviteRequired`、`agent_settings.enabled`；preflight 断言 required=false。
- operator `PUT agent.inviteRequired` ⇒ 403。

- [ ] **Step 3: 类型检查/构建**

```bash
pnpm -C tools/conformance run build
```

（若 package.json 无 build，运行 `pnpm -C tools/conformance exec tsc --noEmit`。）

- [ ] **Step 4: Commit**

```bash
git add tools/conformance/src/slices/slice-14-config-center.ts \
  tools/conformance/src/slices/slice-17-currency.ts \
  tools/conformance/src/slices/slice-18-gold-room.ts \
  tools/conformance/src/slices/slice-21-payment.ts \
  tools/conformance/src/slices/slice-23-notify-channel.ts \
  tools/conformance/src/slices/slice-24-ads-relief.ts \
  tools/conformance/src/slices/slice-32-agent.ts
git commit -m "test(conformance): 一次性邀请码与必填矩阵"
```

---

### Task 17: 文档与陈旧计数

**Files:**
- Modify: `docs/client-protocol.md`
- Modify: `docs/design.md`
- Modify: `docs/ops/first-deploy.md`
- Modify: `packages/protocol/src/config.ts`（头注释）
- Modify: `packages/protocol/src/config.test.ts`（第 101 键注释）
- Modify: `packages/config-service/src/config/client-config.controller.ts`（二十一键注释）
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`（boot 两字段注释）
- Modify: `packages/api-gateway/src/auth/public-paths.ts`（第 6 条注释）
- Modify: `apps/client/src/net/rest.ts`（boot 两字段注释）
- Modify: `admin/app.js`（一百零一键注释）

- [ ] **Step 1: 更新计数与字段**

- 协议总键 101/112 → 113
- 客户端子集 22 → 23
- boot 两字段 → 三字段
- 11006 文案：三档 message
- `docs/client-protocol.md` 的口径同步

- [ ] **Step 2: 机械检查**

```bash
rg -n "一百零一|101 键|二十一键|二十二键|只回两个字段|\{version, agentInviteEnabled\}" docs packages admin apps/client/src tools/conformance | head -50
```

Expected: 剩余命中要么是历史记录/注释明确标注旧值，要么已更新。

- [ ] **Step 3: Commit**

```bash
git add docs/client-protocol.md docs/design.md docs/ops/first-deploy.md \
  packages/protocol/src/config.ts packages/protocol/src/config.test.ts \
  packages/config-service/src/config/client-config.controller.ts \
  packages/api-gateway/src/gateway/gateway.controller.ts \
  packages/api-gateway/src/auth/public-paths.ts \
  apps/client/src/net/rest.ts admin/app.js
git commit -m "docs: 同步邀请码必填与一次性码口径"
```

---

### Task 18: 全量验证

- [ ] **Step 1: 定向包测试**

```bash
pnpm -C packages/protocol test
pnpm -C packages/config-service test
pnpm -C packages/user-service test
pnpm -C packages/currency-service test
pnpm -C packages/api-gateway test
pnpm -C packages/shared test
pnpm -C apps/client test
```

Expected: 全部 PASS。

- [ ] **Step 2: 类型检查 / lint**

```bash
pnpm -C apps/client run lint
pnpm -C packages/currency-service run lint
pnpm -C packages/user-service run lint
pnpm -C packages/config-service run lint
pnpm -C packages/api-gateway run lint
```

Expected: PASS（无 `noUnusedLocals` / 类型错）。

- [ ] **Step 3: 门禁**

```bash
pnpm verify:admin
node scripts/verify-agent-static.mjs
```

Expected: PASS。

- [ ] **Step 4: 全仓（按需）**

```bash
pnpm exec turbo run test lint --force
```

Expected: PASS（`Cached` 不算真跑；耗时长，时间允许时执行）。

- [ ] **Step 5: 工作区检查**

```bash
git status --short
```

Expected: 只剩会话前已有的麻将改动（`apps/client/src/components/table/mahjong/*`、`apps/client/test/mahjong-*`、`apps/client/src/game/mahjong-layout.ts`、`docs/superpowers/*mahjong*`、`tmp-layout-out.txt`），本计划文件均已提交。

- [ ] **Step 6: 交付报告**

向用户报告：变更内容、测试结果、commit SHA、是否推送/部署、已知残余（bind RPC 超时烧码、老客户端 boot 失败、码状态 oracle）。

---

## Self-Review

- **Spec coverage:** 配置键/boot/客户端/服务端强制/一次性消费/代理生成/管理后台/网关/conformance/指标/文档均有任务对应。
- **Placeholder scan:** 任务中的「按实际函数名调整」仅出现在 admin/app.js 与 AgentPortalService 构造器两处（需实现时读现有符号）；其余步骤有具体代码或命令。
- **Type consistency:** `ResolvedInvite` 的 `agentStatus/codeStatus`、`BindResult.reason`、`AgentProfile` 新字段、`AGENT_INVITE_DAILY_MAX/BATCH_MAX` 在各任务间一致。
