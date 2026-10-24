import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { AuthService } from '../src/auth/auth.service';
import { TokenService } from '../src/auth/token.service';
import { ErrCode } from '@fight-the-landlord/protocol';
import * as bcrypt from 'bcrypt';
import { DomainError, toHttpException } from '../src/http/errors';
import type { ConfigCacheService } from '../src/config/config-cache.service';
import {
  CurrencyServiceError,
  TRANSPORT_FAILURE_MESSAGE,
  type CurrencyClient,
} from '../src/currency/currency.client';

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
  /** 配置缓存假件（货币片 T6：`signupGrant()`；设备绑定片：`deviceBindingEnabled()` 的读点）。 */
  let configCache: {
    signupGrant: ReturnType<typeof vi.fn>;
    deviceBindingEnabled: ReturnType<typeof vi.fn>;
  };
  /** 货币客户端假件（货币片 T6：`currency.apply` 的发送点）。 */
  let currency: { apply: ReturnType<typeof vi.fn> };
  /** 设备绑定服务假件（设备绑定片：`checkOrBind` 的调用点；11005 由它抛）。 */
  let deviceBindings: { checkOrBind: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      findByPhone: vi.fn(async () => null),
      findById: vi.fn(async () => null),
      create: vi.fn(async (data: any) => ({ ...data, nickname: data.nickname ?? null })),
      update: vi.fn(async () => undefined),
    };
    const redis = fakeRedis();
    tokens = new TokenService(new JwtService({ secret: 'test-secret' }), redis);
    // 缺省即「生产默认」：`currency.signupGrant` 种子 0（规格 §2.8）⇒ 注册不碰货币服务；
    // 设备绑定开关种子 false ⇒ 绑定闸短路（既有用例零变化）。
    configCache = {
      signupGrant: vi.fn(() => 0),
      deviceBindingEnabled: vi.fn(() => false),
    };
    currency = {
      apply: vi.fn(async () => ({ opId: 1, actionId: 'x', entries: [], replayed: false })),
    };
    deviceBindings = { checkOrBind: vi.fn(async () => undefined) };
    service = new AuthService(
      repo,
      tokens,
      configCache as unknown as ConfigCacheService,
      currency as unknown as CurrencyClient,
      // 提现再认证片：`reauth()` 用 REDIS 存一次性票据（构造器第 5 参）。
      redis,
      // 设备绑定片：构造器第 6 参（登录/注册/refresh 的绑定闸委托它）。
      deviceBindings as any,
    );
  });

  it('register 返回双令牌 + user，并把密码哈希（不是明文）落库', async () => {
    const res = await service.register({ phone: '13800000001', password: 'passw0rd', nickname: '阿豆' } as any);
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(res.user.phone).toBe('13800000001');
    const created = repo.create.mock.calls[0][0];
    expect(created.nickname).toBe('阿豆');
    expect(created.passwordHash).not.toBe('passw0rd');
    expect(await bcrypt.compare('passw0rd', created.passwordHash)).toBe(true);
  });

  it('手机号已注册 → 11001', async () => {
    repo.findByPhone.mockResolvedValueOnce({ id: 'u1' });
    await expect(service.register({ phone: '13800000001', password: 'passw0rd', nickname: '阿豆' } as any)).rejects.toMatchObject({
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
    const res = await service.register({ phone: '13800000002', password: 'passw0rd', nickname: '阿豆' } as any);
    const access = tokens.verify(res.accessToken, 'access');
    const refresh = tokens.verify(res.refreshToken, 'refresh');
    await service.logout(access.jti, res.refreshToken);
    expect(await tokens.isActive(access.jti)).toBe(false);
    expect(await tokens.isActive(refresh.jti)).toBe(false);
  });

  // ─── 注册赠送链路（货币片 T6 / 规格 §2.7 + ⚙️8；§6.1 user-service 行全列）─────────

  /** `apply` 成功的下游回执样本（形状 = `CurrencyApplyData`）。 */
  const APPLY_DATA = {
    opId: 7,
    actionId: 'signup:x',
    entries: [{ ownerId: 'x', balanceAfter: 100 }],
    replayed: false,
  };

  it('grant=0（默认）⇒ 货币客户端**未被调用** + 用户照常落库（D4：一步都不进货币服务）', async () => {
    const res = await service.register({ phone: '13800000003', password: 'passw0rd', nickname: '阿豆' } as any);

    expect(res.user.phone).toBe('13800000003');
    expect(res.accessToken).toBeTruthy();
    expect(configCache.signupGrant).toHaveBeenCalled(); // 步骤 2 的读发生（无论值是多少）
    expect(currency.apply).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('grant>0 ⇒ **先货币后落库**：apply 载荷逐字（`signup:<userId>` / `signup_grant` / refId=userId），随后以同一 id 落库', async () => {
    configCache.signupGrant.mockReturnValue(100);
    currency.apply.mockResolvedValue(APPLY_DATA);

    const res = await service.register({ phone: '13800000004', password: 'passw0rd', nickname: '阿豆' } as any);

    expect(currency.apply).toHaveBeenCalledTimes(1);
    const applyReq = currency.apply.mock.calls[0]![0];
    const createdId = repo.create.mock.calls[0]![0].id as string;

    // actionId 形状 = `signup:<userId>`（设计 §5.1 的调用方约定）；userId = 落库那个 id。
    expect(applyReq).toEqual({
      actionId: `signup:${createdId}`,
      source: 'signup_grant',
      entries: [{ ownerId: createdId, delta: 100 }],
      refId: createdId,
    });
    expect(applyReq.actionId).toMatch(/^signup:[0-9a-f-]{36}$/);
    expect(res.user.id).toBe(createdId);
    // 时序：apply **先于**落库（invocationCallOrder）。
    expect(currency.apply.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.create.mock.invocationCallOrder[0]!,
    );
  });

  it('grant>0 且 apply 业务失败（14002）⇒ 503+10007 信封、**本地零行**；原因只进日志', async () => {
    configCache.signupGrant.mockReturnValue(100);
    currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.E_ACTION_CONFLICT, 'actionId 冲突（同 id 不同载荷）'),
    );
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'user-service' }));
    try {
      const err = (await service
        .register({ phone: '13800000005', password: 'passw0rd', nickname: '阿豆' } as any)
        .catch((e: unknown) => e)) as DomainError;

      // 🔴 必须是 DomainError（裸 CurrencyServiceError 会被 toHttpException 翻成 400 ——
      // 「最像正确答案的错」；HTTP_STATUS[10007] = 503）。
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
      expect(err.code).toBe(10007);
      expect(err.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案（不内插下游原因）

      // HTTP 边界用**真映射函数**走一遍：同一个错误对象 ⇒ 503 + 10007 信封（⚙️8）。
      const httpErr = toHttpException(err);
      expect(httpErr.getStatus()).toBe(503);
      expect(httpErr.getResponse()).toMatchObject({ code: 10007, data: null });

      // 零本地行：users 落库**没有发生**（重试干净的前提）。
      expect(repo.create).not.toHaveBeenCalled();

      // 不透传 ≠ 不留痕：下游码进日志。
      const warns = records.filter((r) => r.level === 'warn').map((r) => r.msg).join('\n');
      expect(warns).toContain('code=14002');
    } finally {
      Logger.overrideLogger(new Logger());
    }
  });

  it('grant>0 且 apply 传输失败 ⇒ 同上（10007 固定文案）、零本地行；重试干净（第二次恰落一行）', async () => {
    configCache.signupGrant.mockReturnValue(100);
    currency.apply.mockRejectedValueOnce(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE),
    );

    await expect(
      service.register({ phone: '13800000006', password: 'passw0rd', nickname: '阿豆' } as any),
    ).rejects.toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE, message: TRANSPORT_FAILURE_MESSAGE });
    expect(repo.create).not.toHaveBeenCalled(); // 第一次：零本地行

    // 客户端重试（一次全新的注册）：apply 成功 ⇒ 正常落库 —— 本地没有任何半程残留。
    currency.apply.mockResolvedValueOnce(APPLY_DATA);
    const res = await service.register({ phone: '13800000006', password: 'passw0rd', nickname: '阿豆' } as any);
    expect(res.user.phone).toBe('13800000006');
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(currency.apply).toHaveBeenCalledTimes(2); // 失败 1 + 重试 1（无从「看到」第一次的失败）
  });

  it('手机号预检**先于**赠送读取/发币：已注册 ⇒ 11001，且 signupGrant/apply 都未被碰', async () => {
    repo.findByPhone.mockResolvedValueOnce({ id: 'u1' });

    await expect(
      service.register({ phone: '13800000001', password: 'passw0rd', nickname: '阿豆' } as any),
    ).rejects.toMatchObject({ code: ErrCode.PHONE_TAKEN });

    expect(configCache.signupGrant).not.toHaveBeenCalled();
    expect(currency.apply).not.toHaveBeenCalled();
  });

  // ─── 设备绑定闸（设备绑定片；开关 risk.deviceBindingEnabled 默认关）──────────────────

  it('设备开关关（默认）⇒ register/login/refresh 都**不碰**绑定服务（零行为变化）', async () => {
    const hash = await bcrypt.hash('passw0rd', 10);
    repo.findByPhone.mockResolvedValueOnce({
      id: 'u1', phone: '13800000001', passwordHash: hash, status: 'active', nickname: null,
    });
    await service.login({ phone: '13800000001', password: 'passw0rd', deviceId: 'dev-device-1234' } as any);
    await service.register({ phone: '13800000010', password: 'passw0rd', nickname: '阿豆', deviceId: 'dev-device-1234' } as any);
    const pair = await service.register({ phone: '13800000011', password: 'passw0rd', nickname: '阿豆' } as any);
    await service.refresh(pair.refreshToken, 'dev-device-1234');

    expect(deviceBindings.checkOrBind).not.toHaveBeenCalled();
  });

  it('设备开关开 ⇒ register/login 以 (userId, deviceId) 过闸；无 deviceId 透传 undefined（fail-open 在服务侧）', async () => {
    configCache.deviceBindingEnabled.mockReturnValue(true);

    const registered = await service.register({
      phone: '13800000020', password: 'passw0rd', nickname: '阿豆', deviceId: 'dev-device-1234',
    } as any);
    expect(deviceBindings.checkOrBind).toHaveBeenLastCalledWith(registered.user.id, 'dev-device-1234');

    const hash = await bcrypt.hash('passw0rd', 10);
    repo.findByPhone.mockResolvedValueOnce({
      id: 'u9', phone: '13800000009', passwordHash: hash, status: 'active', nickname: null,
    });
    await service.login({ phone: '13800000009', password: 'passw0rd' } as any);
    expect(deviceBindings.checkOrBind).toHaveBeenLastCalledWith('u9', undefined);
  });

  it('设备开关开 + 绑定不一致 ⇒ login 抛 11005（密码已验证之后；不发令牌）', async () => {
    configCache.deviceBindingEnabled.mockReturnValue(true);
    const hash = await bcrypt.hash('passw0rd', 10);
    repo.findByPhone.mockResolvedValueOnce({
      id: 'u1', phone: '13800000001', passwordHash: hash, status: 'active', nickname: null,
    });
    deviceBindings.checkOrBind.mockRejectedValueOnce(
      new DomainError(ErrCode.DEVICE_MISMATCH, '账号已绑定其他设备'),
    );

    await expect(
      service.login({ phone: '13800000001', password: 'passw0rd', deviceId: 'dev-device-1234' } as any),
    ).rejects.toMatchObject({ code: ErrCode.DEVICE_MISMATCH });
  });

  it('设备开关开 + refresh：闸在轮换成功之后——闸抛 11005 时旧 refresh jti 已被消费', async () => {
    // 先在开关关时建一个真会话拿到 refresh token。
    const pair = await service.register({ phone: '13800000030', password: 'passw0rd', nickname: '阿豆' } as any);
    const refreshClaims = tokens.verify(pair.refreshToken, 'refresh');
    expect(await tokens.isActive(refreshClaims.jti)).toBe(true);

    configCache.deviceBindingEnabled.mockReturnValue(true);
    deviceBindings.checkOrBind.mockRejectedValueOnce(
      new DomainError(ErrCode.DEVICE_MISMATCH, '账号已绑定其他设备'),
    );
    await expect(service.refresh(pair.refreshToken, 'dev-device-1234')).rejects.toMatchObject({
      code: ErrCode.DEVICE_MISMATCH,
    });
    // rotate 的原子 DEL 已发生：偷走会话的一方烧掉了落手 token，绑定设备的其他会话不受影响。
    expect(await tokens.isActive(refreshClaims.jti)).toBe(false);
    expect(deviceBindings.checkOrBind).toHaveBeenLastCalledWith(refreshClaims.sub, 'dev-device-1234');
  });
});
