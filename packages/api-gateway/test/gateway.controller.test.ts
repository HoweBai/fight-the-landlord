import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ProxyGateway } from '../src/gateway/proxy.gateway';
import { GatewayController, isRoomCode } from '../src/gateway/gateway.controller';
import { isLogoutPath } from '../src/auth/identity-headers';
import { isAdminPath, isPublicPath } from '../src/auth/public-paths';
import { JwtMiddleware } from '../src/auth/jwt.middleware';
import { AdminAuthMiddleware } from '../src/auth/admin.middleware';
import { SessionGuard } from '../src/auth/session.guard';

/**
 * §5.1 的 refresh / logout 路由 + R31 的 `X-Token-Jti` 转发边界。
 *
 * 直接实例化控制器（`new GatewayController(proxy)`）—— 这是**选型**，不是绕坑：
 * 本 describe 断言的是路由表与 `headersOf()` 的取值逻辑，不需要容器。
 * 容器侧的真实 DI 由下面「路径参数形状 + 编码」那一段用**真 Nest app** 覆盖。
 * （P18/N41 之前这里的理由是「Vitest 的 esbuild 不发出 `design:paramtypes`，
 * 反射注入在测试里不可用」—— 那条**已不再成立**。）
 */
describe('GatewayController（auth 路由 / R31）', () => {
  const res = {} as never;

  const make = () => {
    const proxy = {
      forwardToUserSvc: vi.fn(async () => undefined),
      forwardToRoomSvc: vi.fn(async () => undefined),
      forwardToGameSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, headers: Record<string, string> = {}) => ({ originalUrl, headers });

  it('POST /api/auth/refresh 转发到 user-service 的 /api/auth/refresh', async () => {
    const { controller, proxy } = make();

    await controller.refresh({ refreshToken: 'r' }, res, req('/api/auth/refresh'));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'POST',
      '/api/auth/refresh',
      { refreshToken: 'r' },
      res,
      {},
    );
  });

  it('POST /api/auth/logout 把中间件注入的 X-Token-Jti 与 X-User-Id 一起传下去', async () => {
    const { controller, proxy } = make();

    await controller.logout(
      { refreshToken: 'r' },
      res,
      req('/api/auth/logout', { 'x-token-jti': 'jti-1', 'x-user-id': 'u1', 'x-trace-id': 't1' }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'POST',
      '/api/auth/logout',
      { refreshToken: 'r' },
      res,
      { userId: 'u1', traceId: 't1', tokenJti: 'jti-1' },
    );
  });

  it('R31：其他路径上客户端自带的 X-Token-Jti 绝不转发', async () => {
    const { controller, proxy } = make();

    await controller.getRooms(res, req('/api/rooms', { 'x-token-jti': 'victim-jti' }));

    expect(proxy.forwardToRoomSvc).toHaveBeenCalledWith('GET', '/api/rooms', null, res, {});
  });

  it('Task 5.0：GET /api/rooms 只透传 gameType（白名单；其余键丢弃、值编码）', async () => {
    const { controller, proxy } = make();

    await controller.getRooms(res, {
      originalUrl: '/api/rooms?gameType=paodekuai&smuggle=1',
      headers: {},
      query: { gameType: ['paodekuai', 'doudizhu'], smuggle: '1', mode: 'gold' },
    });
    expect(proxy.forwardToRoomSvc).toHaveBeenLastCalledWith(
      'GET',
      '/api/rooms?gameType=paodekuai',
      null,
      res,
      {},
    );

    // 缺省（不传）⇒ 原路径；空值同样丢弃（下游按缺省 doudizhu 处理）
    await controller.getRooms(res, { originalUrl: '/api/rooms', headers: {}, query: { gameType: '' } });
    expect(proxy.forwardToRoomSvc).toHaveBeenLastCalledWith('GET', '/api/rooms', null, res, {});
  });

  it('全局前缀被剥掉时（req.url = /auth/logout）仍认得出 logout', async () => {
    const { controller, proxy } = make();

    await controller.logout({}, res, { url: '/auth/logout', headers: { 'x-token-jti': 'jti-9' } });

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'POST',
      '/api/auth/logout',
      {},
      res,
      { tokenJti: 'jti-9' },
    );
  });

  /**
   * R31 的判定只有**一份**（`identity-headers.isLogoutPath`），中间件（注入侧）与
   * `headersOf()`（转发侧）共用。这里直接钉住它的边界，防止两侧再各自复制一份后漂移。
   */
  describe('isLogoutPath（R31 的唯一判定）', () => {
    it('只认 logout 的两个挂载形态', () => {
      expect(isLogoutPath('/api/auth/logout')).toBe(true);
      expect(isLogoutPath('/auth/logout')).toBe(true);
    });

    it('不认近邻路径（精确匹配）', () => {
      for (const path of [
        '/api/auth/logout-as-admin',
        '/api/auth/login',
        '/api/rooms',
        '/api/auth/logout/x',
        '',
      ]) {
        expect(isLogoutPath(path)).toBe(false);
      }
    });
  });
});

/**
 * 片⑦ T10：配置中心路由（`GET /api/config` + 管理面三条）。
 *
 * 旧端点 `GET /api/base-score-levels` **随片⑦退役**（网关侧删除，本 describe 取代它
 * 原有的「转发目标」判据）：配置的唯一 HTTP 出口是 config-service —— 玩家面走
 * `/api/config`（七键子集），管理面走 `/api/admin/*`（`AdminAuthMiddleware` 自证）。
 *
 * ⚠️ 「路由名与目标服务不一致」的旧形态（底分表打到 user-service）随之消失；
 * 现在四条路由的转发目标**全是** `forwardToConfigSvc` —— 将来谁把它改成别的服务，
 * 这里必须红一次。
 */
describe('GatewayController（片⑦ T10：配置中心路由）', () => {
  const res = {} as never;

  const make = () => {
    const proxy = {
      forwardToConfigSvc: vi.fn(async () => undefined),
      forwardToUserSvc: vi.fn(async () => undefined),
      forwardToRoomSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, headers: Record<string, string> = {}) => ({ originalUrl, headers });

  it('GET /api/config 转发到 config-service 的同名路径（玩家面七键子集）', async () => {
    const { controller, proxy } = make();

    await controller.getConfig(res, req('/api/config'));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/config', null, res, {});
    expect(proxy.forwardToUserSvc).not.toHaveBeenCalled();
  });

  it('POST /api/admin/login 转发到 config-service（登录入口**不带** X-Admin —— 它是「豁免恰好一条」）', async () => {
    const { controller, proxy } = make();

    // ③ T5：登录路径**唯一**产出 `clientIp`（服务端登录事件用它落 `ip` 列）——
    // 值由 `requestClientIp` 从 socket/req.ip + 可信表**派生**，不读客户端头。
    await controller.adminLogin({ password: 'p' }, res, {
      originalUrl: '/api/admin/login',
      headers: {},
      ip: '203.0.113.5',
    });

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('POST', '/api/admin/login', { password: 'p' }, res, {
      clientIp: '203.0.113.5',
    });
  });

  it('③ T5：登录路径的 clientIp 是**派生值** —— 客户端自带的 x-client-ip 一概不采信', async () => {
    const { controller, proxy } = make();

    await controller.adminLogin({ password: 'p' }, res, {
      originalUrl: '/api/admin/login',
      headers: { 'x-client-ip': 'evil' },
      ip: '203.0.113.5',
    });

    // 精确相等即蕴含「不是 evil」：转发参数深度比较通过 = 下游头里没有伪造值。
    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('POST', '/api/admin/login', { password: 'p' }, res, {
      clientIp: '203.0.113.5',
    });
  });

  it('③ T5：clientIp **仅**登录路径有值（其它 admin 路径与玩家路径都不得携带）', async () => {
    const { controller, proxy } = make();

    await controller.getAdminConfig(res, {
      originalUrl: '/api/admin/config',
      headers: { 'x-admin': '1' },
      ip: '203.0.113.5',
    });
    await controller.getRooms(res, { originalUrl: '/api/rooms', headers: {}, ip: '203.0.113.5' });

    // 精确相等（toHaveBeenCalledWith 是深度比较）：多一枚 clientIp 都会红。
    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/config', null, res, {
      admin: true,
    });
    expect(proxy.forwardToRoomSvc).toHaveBeenCalledWith('GET', '/api/rooms', null, res, {});
  });

  it('GET /api/admin/config：中间件注入的 X-Admin 转成 `headers.admin`（验真产物才可能为 1）', async () => {
    const { controller, proxy } = make();

    await controller.getAdminConfig(res, req('/api/admin/config', { 'x-admin': '1' }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/config', null, res, {
      admin: true,
    });
  });

  it('PUT /api/admin/config/:key：转发 PUT + 键 + `headers.admin`（写路径）', async () => {
    const { controller, proxy } = make();

    await controller.putAdminConfig(
      'room.friendRoomEnabled',
      { value: true },
      res,
      req('/api/admin/config/room.friendRoomEnabled', { 'x-admin': '1' }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PUT',
      '/api/admin/config/room.friendRoomEnabled',
      { value: true },
      res,
      { admin: true },
    );
  });

  it('X-Admin 只认**恰好 `1`**：其它值（伪造的 last-write 形态）不带 admin 字段', async () => {
    // AdminAuthMiddleware 会先剥掉客户端伪造值；这里独立钉住 headersOf 自己的取值口径
    // （与下游 XAdminGuard 的「存在且恰好 '1'」逐字同形 —— 两处放宽一处就是洞）。
    const { controller, proxy } = make();

    await controller.getAdminConfig(res, req('/api/admin/config', { 'x-admin': 'evil' }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/config', null, res, {});
  });

  it('R75 一族：`:key` 参数**编码后**再拼下游 URL（`%3F` 不得走私成查询串）', async () => {
    const { controller, proxy } = make();

    // Express 会把 `%3F` 解码成 `?` 再交给控制器 —— 只编码不校验之外的形态钉在这里：
    // 拼进下游 URL 的必须是**编码后**的值（键的合法性由 config-service 判，单一真源）。
    await controller.putAdminConfig('a?b=1', { value: 1 }, res, req('/api/admin/config/a%3Fb%3D1'));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PUT',
      '/api/admin/config/a%3Fb%3D1',
      { value: 1 },
      res,
      {},
    );
  });
});

/**
 * 支付配置管理化 T7（规格 §2.4 / §4）：管理面渠道三路由 —— 三条**全部**转发
 * `forwardToConfigSvc`（config-service；谁把它改到别的服务，这里红一次）。
 * 授权在网关 policy **P-c1/P-c2**（写面仅 super_admin）+ GET 落 P8；本组只钉「转发形状」
 *（目标/方法/路径拼装/body/头）——「路由真的注册」由下方真 Nest app 组钉。
 */
describe('GatewayController（支付配置管理化 T7：pay-channel 管理三路由）', () => {
  const res = {} as never;

  const make = () => {
    // ⚠️ 显式标注（照支付 T12/R75 describe 的先例）：`vi.fn(async () => undefined)` 的推断
    // 调用元是 `[]`，读 `mock.calls` 会 TS2493/TS2352；标注后参数面是 any[][]。
    const proxy: { forwardToConfigSvc: ReturnType<typeof vi.fn> } = {
      forwardToConfigSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    ...over,
  });

  /** 中间件验真后注入的三枚（③ T5 第 7 步产物）。 */
  const INJECTED = { 'x-admin': '1', 'x-admin-actor': 'admin', 'x-admin-roles': 'super_admin' };

  it('GET /api/admin/pay-channel 转发 config-service 同路径（body=null；管理三枚头随行）', async () => {
    const { controller, proxy } = make();

    await controller.getAdminPayChannel(res, req('/api/admin/pay-channel', { headers: { ...INJECTED } }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/pay-channel', null, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'super_admin',
    });
  });

  it('PUT /api/admin/pay-channel/:key：转发 PUT + 键 + body 逐字透传（校验单一真源在下游）', async () => {
    const { controller, proxy } = make();
    const body = { value: 'https://openapi.alipay.com/gateway.do' };

    await controller.putAdminPayChannel(
      'pay.channel.gatewayUrl',
      body,
      res,
      req('/api/admin/pay-channel/pay.channel.gatewayUrl', { headers: { ...INJECTED } }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PUT',
      '/api/admin/pay-channel/pay.channel.gatewayUrl',
      body,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('DELETE /api/admin/pay-channel/:key：转发 DELETE + 键；无 body（契约 §2.4 第三行「—」）', async () => {
    const { controller, proxy } = make();

    await controller.deleteAdminPayChannel(
      'pay.channel.privateKey',
      res,
      req('/api/admin/pay-channel/pay.channel.privateKey', { headers: { ...INJECTED }, method: 'DELETE' }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'DELETE',
      '/api/admin/pay-channel/pay.channel.privateKey',
      null,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('R75 一族：`:key` 参数**编码后**再拼下游 URL（`%3F` 不得走私成查询串）—— PUT/DELETE 两处同规', async () => {
    const { controller, proxy } = make();

    // Express 会把 `%3F` 解码成 `?` 再交给控制器 —— 拼进下游 URL 的必须是**编码后**的值；
    // 键的合法性不在网关判（config-service 对**解码后**的键做注册表校验，单一真源在 protocol）。
    await controller.putAdminPayChannel('a?b=1', { value: 'v' }, res, req('/api/admin/pay-channel/a%3Fb%3D1'));
    await controller.deleteAdminPayChannel('a?b=1', res, req('/api/admin/pay-channel/a%3Fb%3D1'));

    const calls = proxy.forwardToConfigSvc.mock.calls as Array<[string, string]>;
    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      'PUT /api/admin/pay-channel/a%3Fb%3D1',
      'DELETE /api/admin/pay-channel/a%3Fb%3D1',
    ]);
  });

  it('守卫面：三路由都在 `isAdminPath` 前缀语义内（AdminAuthMiddleware 免改即覆盖；授权在 P-c/P8）', () => {
    for (const path of ['/api/admin/pay-channel', '/api/admin/pay-channel/pay.channel.privateKey']) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });
});

/**
 * 通知通道管理化 T8（规格 §2.4 / §4）：通知通道三路由 —— 三条**全部**转发
 * `forwardToConfigSvc`（config-service；谁把它改到别的服务，这里红一次）。
 * 授权在网关 policy **P-n1/P-n2**（写面仅 super_admin）+ GET 落 P8；本组只钉「转发形状」
 *（目标/方法/路径拼装/body/头）——「路由真的注册」由下方真 Nest app 组钉。
 */
describe('GatewayController（通知通道管理化 T8：notify-channel 管理三路由）', () => {
  const res = {} as never;

  const make = () => {
    // ⚠️ 显式标注（照 pay-channel 组先例）：`vi.fn(async () => undefined)` 的推断调用元是 `[]`；
    // 标注后参数面是 any[][]，读 `mock.calls` 不 TS2493/TS2352。
    const proxy: { forwardToConfigSvc: ReturnType<typeof vi.fn> } = {
      forwardToConfigSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    ...over,
  });

  /** 中间件验真后注入的三枚（③ T5 第 7 步产物）。 */
  const INJECTED = { 'x-admin': '1', 'x-admin-actor': 'admin', 'x-admin-roles': 'super_admin' };

  it('GET /api/admin/notify-channel 转发 config-service 同路径（body=null；管理三枚头随行）', async () => {
    const { controller, proxy } = make();

    await controller.getAdminNotifyChannel(res, req('/api/admin/notify-channel', { headers: { ...INJECTED } }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/notify-channel', null, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'super_admin',
    });
  });

  it('PUT /api/admin/notify-channel/:key：转发 PUT + 键 + body 逐字透传（校验单一真源在下游）', async () => {
    const { controller, proxy } = make();
    const body = { value: 'new-smtp-auth-code' };

    await controller.putAdminNotifyChannel(
      'notify.smtp.pass',
      body,
      res,
      req('/api/admin/notify-channel/notify.smtp.pass', { headers: { ...INJECTED } }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PUT',
      '/api/admin/notify-channel/notify.smtp.pass',
      body,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('DELETE /api/admin/notify-channel/:key：转发 DELETE + 键；无 body（契约 §2.4 第三行「—」）', async () => {
    const { controller, proxy } = make();

    await controller.deleteAdminNotifyChannel(
      'notify.webhook.wecomUrl',
      res,
      req('/api/admin/notify-channel/notify.webhook.wecomUrl', { headers: { ...INJECTED }, method: 'DELETE' }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'DELETE',
      '/api/admin/notify-channel/notify.webhook.wecomUrl',
      null,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('R75 一族：`:key` 参数**编码后**再拼下游 URL（`%3F` 不得走私成查询串）—— PUT/DELETE 两处同规', async () => {
    const { controller, proxy } = make();

    // Express 会把 `%3F` 解码成 `?` 再交给控制器 —— 拼进下游 URL 的必须是**编码后**的值；
    // 键的合法性不在网关判（config-service 对**解码后**的键做注册表校验，单一真源在 protocol）。
    await controller.putAdminNotifyChannel('a?b=1', { value: 'v' }, res, req('/api/admin/notify-channel/a%3Fb%3D1'));
    await controller.deleteAdminNotifyChannel('a?b=1', res, req('/api/admin/notify-channel/a%3Fb%3D1'));

    const calls = proxy.forwardToConfigSvc.mock.calls as Array<[string, string]>;
    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      'PUT /api/admin/notify-channel/a%3Fb%3D1',
      'DELETE /api/admin/notify-channel/a%3Fb%3D1',
    ]);
  });

  it('近邻（规格 §4 末行）：PUT /api/admin/config/notify.smtp.pass **原样转发**（网关不加排除面）—— 下游 parseConfigValue 未知键 ⇒ 400', async () => {
    // 网关侧的唯一职责 = 转发（键合法性单一真源在 config-service：九键不在 CONFIG_KEYS ⇒
    // parseConfigValue 判未知键 400；conformance slice-23 ⑤ 钉真栈 400）。policy 侧对应
    // 断言在 `admin-policy.test.ts` 的「近邻」用例（走 P4：SA|operator 放行）。
    const { controller, proxy } = make();
    const body = { value: 'x' };

    await controller.putAdminConfig('notify.smtp.pass', body, res, req('/api/admin/config/notify.smtp.pass'));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('PUT', '/api/admin/config/notify.smtp.pass', body, res, {});
  });

  it('守卫面：三路由都在 `isAdminPath` 前缀语义内（AdminAuthMiddleware 免改即覆盖；授权在 P-n/P8）', () => {
    for (const path of ['/api/admin/notify-channel', '/api/admin/notify-channel/notify.smtp.pass']) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });
});

/**
 * 广告片 T8（规格 §2.3）：广告回调密钥管理三路由 —— 三条**全部**转发 `forwardToConfigSvc`
 *（config-service；谁把它改到别的服务，这里红一次）。授权在网关 policy **P-a1/P-a2**
 *（写面仅 super_admin）+ GET 落 P8；本组只钉「转发形状」（目标/方法/路径拼装/body/头）
 * ——「路由真的注册」由下方真 Nest app 组钉。
 */
describe('GatewayController（广告片 T8：ad-channel 管理三路由）', () => {
  const res = {} as never;

  const make = () => {
    // ⚠️ 显式标注（照 pay/notify-channel 组先例）：`vi.fn(async () => undefined)` 的推断
    // 调用元是 `[]`；标注后参数面是 any[][]，读 `mock.calls` 不 TS2493/TS2352。
    const proxy: { forwardToConfigSvc: ReturnType<typeof vi.fn> } = {
      forwardToConfigSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    ...over,
  });

  /** 中间件验真后注入的三枚（③ T5 第 7 步产物）。 */
  const INJECTED = { 'x-admin': '1', 'x-admin-actor': 'admin', 'x-admin-roles': 'super_admin' };

  it('GET /api/admin/ad-channel 转发 config-service 同路径（**无 /status 后缀**；body=null；管理三枚头随行）', async () => {
    const { controller, proxy } = make();

    await controller.getAdminAdChannel(res, req('/api/admin/ad-channel', { headers: { ...INJECTED } }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/ad-channel', null, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'super_admin',
    });
  });

  it('PUT /api/admin/ad-channel/:key：转发 PUT + 键 + body 逐字透传（校验单一真源在下游）', async () => {
    const { controller, proxy } = make();
    const body = { value: 'new-callback-secret' };

    await controller.putAdminAdChannel(
      'ad.callbackSecret',
      body,
      res,
      req('/api/admin/ad-channel/ad.callbackSecret', { headers: { ...INJECTED } }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PUT',
      '/api/admin/ad-channel/ad.callbackSecret',
      body,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('DELETE /api/admin/ad-channel/:key：转发 DELETE + 键；无 body（null —— T6 端点幂等语义）', async () => {
    const { controller, proxy } = make();

    await controller.deleteAdminAdChannel(
      'ad.callbackSecret',
      res,
      req('/api/admin/ad-channel/ad.callbackSecret', { headers: { ...INJECTED }, method: 'DELETE' }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'DELETE',
      '/api/admin/ad-channel/ad.callbackSecret',
      null,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('R75 一族：`:key` 参数**编码后**再拼下游 URL（`%3F` 不得走私成查询串）—— PUT/DELETE 两处同规', async () => {
    const { controller, proxy } = make();

    // Express 会把 `%3F` 解码成 `?` 再交给控制器 —— 拼进下游 URL 的必须是**编码后**的值；
    // 键的合法性不在网关判（config-service 对**解码后**的键做注册表校验，单一真源在 protocol）。
    await controller.putAdminAdChannel('a?b=1', { value: 'v' }, res, req('/api/admin/ad-channel/a%3Fb%3D1'));
    await controller.deleteAdminAdChannel('a?b=1', res, req('/api/admin/ad-channel/a%3Fb%3D1'));

    const calls = proxy.forwardToConfigSvc.mock.calls as Array<[string, string]>;
    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      'PUT /api/admin/ad-channel/a%3Fb%3D1',
      'DELETE /api/admin/ad-channel/a%3Fb%3D1',
    ]);
  });

  it('近邻（规格 §2.3）：PUT /api/admin/config/ad.callbackSecret **原样转发**（网关不加排除面）—— 下游 parseConfigValue 未知键 ⇒ 400', async () => {
    // 网关侧的唯一职责 = 转发（键合法性单一真源在 config-service：`ad.callbackSecret` **不在**
    // CONFIG_KEYS（第四键空间）⇒ parseConfigValue 判未知键 400）。policy 侧对应断言在
    // `admin-policy.test.ts` 的「近邻」用例（走 P4：SA|operator 放行）。
    const { controller, proxy } = make();
    const body = { value: 'x' };

    await controller.putAdminConfig('ad.callbackSecret', body, res, req('/api/admin/config/ad.callbackSecret'));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PUT',
      '/api/admin/config/ad.callbackSecret',
      body,
      res,
      {},
    );
  });

  it('守卫面：三路由都在 `isAdminPath` 前缀语义内（AdminAuthMiddleware 免改即覆盖；授权在 P-a/P8）', () => {
    for (const path of ['/api/admin/ad-channel', '/api/admin/ad-channel/ad.callbackSecret']) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });
});

/**
 * R75 / N3：网关路径参数的**两道闸** —— 先判形状（`10001`，不打下游），再编码。
 *
 * ⚠️ 为什么必须用**真实 Nest 路由**而不是直接调控制器方法：漏洞的一半在
 * **Express 的参数解码**上。实测（本文件用真实 HTTP 复现）：
 *
 * ```
 * GET /api/games/ABC%3Fseat=1  →  req.params.roomCode = 'ABC?seat=1'
 *                              →  修前下游收到 `/api/games/ABC?seat=1`   ← 查询走私成功
 * GET /api/games/ABC%2F123     →  'ABC/123'      → 下游收到 `/api/games/ABC/123`
 * GET /api/games/..%2F..%2Fetc →  '../../etc'    → 下游收到 `/api/games/../../etc`
 * ```
 *
 * 直接调控制器只能把「已解码的值」当成入参，测不到这一环。
 *
 * P18/N41（**测试侧定性**）：本段此前用
 * `Reflect.defineMetadata('design:paramtypes', [ProxyGatewayToken], GatewayController)`
 * 把依赖绑到一个**自造的测试令牌**上 —— 那是「Vitest/esbuild 当时不发出该元数据」下的权宜之计。
 * 测试环境现在**真的**发出产品元数据，而那行元数据说的是 `[ProxyGateway]`
 * （`GatewayController` 的构造参数类型名，见 `src/gateway/gateway.controller.ts`）
 * ⇒ 用 `ProxyGatewayToken` 提供替身自然解析不到（`Nest can't resolve dependencies … ProxyGateway`）。
 *
 * 定性：**② 测试自己的期望写错**（不是产品缺陷）—— 产品的 `GatewayController` 只声明了
 * 一个依赖 `ProxyGateway`，元数据与构造签名**逐字一致**。修法是把替身挂到**产品真实使用的
 * 那个 token**（`ProxyGateway` 类本身）上；本用例的判据、行为、断言**一字未改**：
 * 控制器拿到的仍只是 `forwardToUserSvc/forwardToRoomSvc/forwardToGameSvc` 三个替身，
 * `ProxyGateway` 类**不会**被实例化（`useValue` provider 不需要容器构造它）。
 */
describe('GatewayController（R75/N3 —— 路径参数形状 + 编码）', () => {
  let app: INestApplication;
  let baseUrl: string;
  /** 下游替身收到的 path（顺序记录）；同时把 path 回显进响应体，便于断言「下游到底收到了什么」 */
  let gamePaths: string[];
  let roomPaths: string[];
  let proxy: {
    forwardToUserSvc: ReturnType<typeof vi.fn>;
    forwardToRoomSvc: ReturnType<typeof vi.fn>;
    forwardToGameSvc: ReturnType<typeof vi.fn>;
  };

  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'X-User-Id': 'alice', ...(init.headers ?? {}) },
    });
  const post = (): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  beforeAll(async () => {
    gamePaths = [];
    roomPaths = [];
    proxy = {
      forwardToUserSvc: vi.fn(async () => undefined),
      forwardToRoomSvc: vi.fn(async (_m: string, path: string, _b: unknown, res: any) => {
        roomPaths.push(path);
        res.status(200).json({ code: 0, data: { path } });
      }),
      forwardToGameSvc: vi.fn(async (_m: string, path: string, _b: unknown, res: any) => {
        gamePaths.push(path);
        res.status(200).json({ code: 0, data: { path } });
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [{ provide: ProxyGateway, useValue: proxy }],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 src/main.ts 一致：全局前缀是 /api。
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    gamePaths.length = 0;
    roomPaths.length = 0;
    proxy.forwardToGameSvc.mockClear();
    proxy.forwardToRoomSvc.mockClear();
  });

  it('N3: `%3F` 不得把查询走私进下游 URL —— 非法形状就地 10001，且**不发起**下游请求', async () => {
    const res = await authed('/api/games/ABC%3Fseat=1');
    const body = (await res.json()) as { code: number; data: { path?: string } | null };

    // 修前（RED）：200 + 下游收到 `/api/games/ABC?seat=1` —— 即 `?seat=1` 走私成功
    expect({ status: res.status, code: body.code, downstream: gamePaths }).toEqual({
      status: 400,
      code: 10001,
      downstream: [],
    });
  });

  it('R75: `%2F` / `..` / 超长串 / 非 6 位 / 小写 一律 10001，且不发起下游请求', async () => {
    const bad = [
      'ABC%2F123',
      '..%2F..%2Fetc',
      'A'.repeat(200),
      'abc123',
      'ABC12',
      'ABC1234',
      'ABC-12',
      'ABC 12',
    ];

    for (const raw of bad) {
      const res = await authed(`/api/games/${encodeURI(raw)}`);
      const body = (await res.json()) as { code: number };
      expect({ raw, status: res.status, code: body.code }).toEqual({
        raw,
        status: 400,
        code: 10001,
      });
    }

    // 关键：一条都没打到下游（Redis 键名 / 下游 URL 都不会被污染）
    expect(gamePaths).toEqual([]);
  });

  it('A6/S4/N5: §7.1 之外的三条客户端可达路由 + `/` 全部消失（404，且不返回任何 HTML）', async () => {
    const cases: Array<[string, RequestInit]> = [
      ['/', {}],
      ['/index.html', {}],
      ['/api/games', post()],           // N5：开局入口（§7.1 无此路由）
      ['/api/robots/create', post()],   // S5：bot- id 出站（§9.6 只许 room-service 调）
      ['/api/robots/move', post()],     // S4：吃整份 session（§9.5）
    ];

    for (const [path, init] of cases) {
      const res = await authed(path, init);
      const text = await res.text();
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(text).not.toContain('findBeatingHand');   // web/index.html 的规则引擎
      expect(text).not.toContain('<html');
    }
  });

  it('R75: 合法房间号放行 —— 5 处插值全部「先判形状、再编码」', async () => {
    await authed('/api/games/ABC123');
    await authed('/api/games/ABC123/bid', post());
    await authed('/api/games/ABC123/play', post());
    await authed('/api/games/ABC123/pass', post());
    await authed('/api/rooms/ABC123/join', post());

    expect(gamePaths).toEqual([
      '/api/games/ABC123',
      '/api/games/ABC123/bid',
      '/api/games/ABC123/play',
      '/api/games/ABC123/pass',
    ]);
    expect(roomPaths).toEqual(['/api/rooms/ABC123/join']);

    // 形状白名单之后的路径里不可能残留 `?` / `%` / 相对路径
    for (const path of [...gamePaths, ...roomPaths]) {
      expect(path).toMatch(/^\/api\/(games|rooms)\/[0-9A-Z]{6}(\/(bid|play|pass|join))?$/);
    }
  });

  it('R75: 非法房间号在 bid/play/pass 与 rooms/:code/join 上同样被拒（不留同一个模式的一半）', async () => {
    for (const raw of ['ABC%3Fseat=1', 'abc123']) {
      for (const suffix of ['/bid', '/play', '/pass']) {
        const path = `/api/games/${raw}${suffix}`;
        const res = await authed(path, post());
        expect({ path, status: res.status, code: ((await res.json()) as { code: number }).code }).toEqual({
          path,
          status: 400,
          code: 10001,
        });
      }
      const joinPath = `/api/rooms/${raw}/join`;
      const res = await authed(joinPath, post());
      expect({
        path: joinPath,
        status: res.status,
        code: ((await res.json()) as { code: number }).code,
      }).toEqual({ path: joinPath, status: 400, code: 10001 });
    }

    expect(gamePaths).toEqual([]);
    expect(roomPaths).toEqual([]);
  });

  it('R76（被本片取代）: 客户端路径只需 X-User-Id —— 网关自己**不**校验内部 token，但会把它注入下游', async () => {
    // ⚠️ R76 在 P0 片写的是「客户端路径不得要求 X-Internal-Token，因为网关不转发它」。
    // 本片（N7）让网关**每一跳**都注入它 ⇒ 下游 game-service 可以（也确实）要求它。
    // 这里钉住取代后的契约：网关**不**自己校验（它是边缘，客户端必须能到达），
    // 但**必须**把内部 token 交给下游。
    const original = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    try {
      const res = await authed('/api/games/ABC123');
      expect(res.status).toBe(200);

      const headers = proxy.forwardToGameSvc.mock.calls.at(-1)?.[4];
      expect(headers).toEqual({ userId: 'alice', internalToken: 'internal-secret' });
    } finally {
      if (original === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = original;
    }
  });

  it('N7: **每一跳**下游都注入 internalToken（user/room/game 三条转发全都要；robot 跳随 R136 删除）', async () => {
    const original = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    // ⚠️ 必须让替身也写回响应：否则请求悬挂，测不到断言就先超时。
    proxy.forwardToUserSvc.mockImplementation(async (_m: string, path: string, _b: unknown, res: any) => {
      res.status(200).json({ code: 0, data: { path } });
    });
    try {
      await authed('/api/auth/login', post());
      await authed('/api/rooms');
      await authed('/api/games/ABC123');

      for (const spy of [
        proxy.forwardToUserSvc,
        proxy.forwardToRoomSvc,
        proxy.forwardToGameSvc,
      ]) {
        expect(spy.mock.calls.at(-1)?.[4]).toMatchObject({ internalToken: 'internal-secret' });
      }
    } finally {
      if (original === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = original;
    }
  }, 15_000);

  it('N7: 网关没配内部 token 时不伪造一个空头（下游会 401，而不是收到空值）', async () => {
    const original = process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    try {
      const res = await authed('/api/games/ABC123');
      expect(res.status).toBe(200);
      expect(proxy.forwardToGameSvc.mock.calls.at(-1)?.[4]).toEqual({ userId: 'alice' });
    } finally {
      if (original !== undefined) process.env.INTERNAL_SERVICE_TOKEN = original;
    }
  });

  /**
   * R75 的第二道闸（`encodeURIComponent`）**必须**单独钉住：
   * 形状白名单通过之后，输入恒为 `[0-9A-Z]{6}`，编码在**行为上**是恒等的 ——
   * 也就是说：只断言响应，删掉 `encodeURIComponent` 也不会有任何用例变红。
   * 这里直接监视全局函数，让「第二道闸」也有判别力。
   */
  it('R75: 形状合法时仍显式编码（第二道闸不是摆设）', async () => {
    const spy = vi.spyOn(globalThis, 'encodeURIComponent');
    try {
      await authed('/api/games/ABC123');
      expect(spy).toHaveBeenCalledWith('ABC123');
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * 记录片 T6（I1 / 设计 D4）：`GET /api/records/mine` —— **首次 GET query 透传**。
 *
 * 两层：
 *  - 直接实例化：白名单（`cursor`/`limit`/`gameType` + P1-6 的 `mode`/`from`/`to`，其余丢弃）
 *    + 每值 `encodeURIComponent`
 *    （R75 查询走私纪律：Express 已解码的 `,`/`&`/`#` 不得以裸形态拼进下游 URL）；
 *  - 真 Nest app：**真实 Express 解码环**——`%2C` 等经 Express 解码后又必须被我们编码回去，
 *    直接调控制器测不到这一环（与上面「路径参数形状 + 编码」同一条理由）。
 */
describe('GatewayController（记录片 T6：records/mine 转发与 query 白名单）', () => {
  const res = {} as never;

  const make = () => {
    const proxy = {
      forwardToUserSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (over: Record<string, unknown> = {}) => ({
    originalUrl: '/api/records/mine',
    headers: {},
    query: {},
    ...over,
  });

  it('GET /api/records/mine 转发 user-service（body=null；身份/追踪头随行）', async () => {
    const { controller, proxy } = make();

    await controller.getMyRecords(res, req({ headers: { 'x-user-id': 'u1', 'x-trace-id': 't1' } }));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/records/mine',
      null,
      res,
      { userId: 'u1', traceId: 't1' },
    );
  });

  it('query 白名单：只透传 cursor/limit；其余键（走私面）一律丢弃', async () => {
    const { controller, proxy } = make();

    await controller.getMyRecords(res, req({ query: { cursor: 't0,42', limit: '30', smuggle: '1', cursor2: 'x' } }));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/records/mine?cursor=t0%2C42&limit=30',
      null,
      res,
      {},
    );
  });

  it('Task 5.0：records/mine 白名单加入 gameType（缺省不传 = 斗地主）', async () => {
    const { controller, proxy } = make();

    await controller.getMyRecords(
      res,
      req({ query: { gameType: 'paodekuai', cursor: 'c1', limit: '7', smuggle: '1' } }),
    );
    expect(proxy.forwardToUserSvc).toHaveBeenLastCalledWith(
      'GET',
      '/api/records/mine?cursor=c1&limit=7&gameType=paodekuai',
      null,
      res,
      {},
    );
  });

  it('P1-6：筛选参数 mode/from/to 到达下游；未知键仍被丢弃', async () => {
    const { controller, proxy } = make();

    await controller.getMyRecords(
      res,
      req({
        query: {
          cursor: 't0,42',
          limit: '30',
          mode: 'gold',
          from: '1700000000000',
          to: '1700086400000',
          smuggle: '1',
        },
      }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/records/mine?cursor=t0%2C42&limit=30&mode=gold&from=1700000000000&to=1700086400000',
      null,
      res,
      {},
    );
  });

  it('每个值 encodeURIComponent（R75）：`,`/`&`/`=`/`#` 不得以裸形态进下游 URL', async () => {
    const { controller, proxy } = make();

    await controller.getMyRecords(res, req({ query: { cursor: 'a&b=c#d%e' } }));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/records/mine?cursor=a%26b%3Dc%23d%25e',
      null,
      res,
      {},
    );
  });

  it('数组形态取首元素；非字符串（嵌套对象）丢弃；空值丢弃（缺省 = 第一页）', async () => {
    const { controller, proxy } = make();

    await controller.getMyRecords(res, req({ query: { limit: ['7', '9'] } }));
    expect(proxy.forwardToUserSvc).toHaveBeenLastCalledWith(
      'GET',
      '/api/records/mine?limit=7',
      null,
      res,
      {},
    );

    await controller.getMyRecords(res, req({ query: { cursor: { x: '1' }, limit: '' } }));
    expect(proxy.forwardToUserSvc).toHaveBeenLastCalledWith('GET', '/api/records/mine', null, res, {});
  });

  it('records/mine 不进公开白名单（默认验签 —— 网关是唯一验签点）', () => {
    expect(isPublicPath('/api/records/mine')).toBe(false);
  });
});

describe('GatewayController（记录片 T6：真实 Express 解码环下的 query 透传）', () => {
  let app: INestApplication;
  let baseUrl: string;
  let userPaths: string[];
  let proxy: { forwardToUserSvc: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    userPaths = [];
    proxy = {
      forwardToUserSvc: vi.fn(async (_m: string, path: string, _b: unknown, res: any) => {
        userPaths.push(path);
        res.status(200).json({ code: 0, data: { path } });
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [{ provide: ProxyGateway, useValue: proxy }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    userPaths.length = 0;
    proxy.forwardToUserSvc.mockClear();
  });

  it('cursor 经 Express 解码后又以编码形态进下游 URL（含 `,`/`&`/`#`/空格/`%`）；走私键不可达', async () => {
    // 设计明文点名的字符是 `,`（`base64(epochMs:id)` 一族的近似）；其余为查询走私敏感字符。
    const cursor = 'a,b=c&d#e f%g';
    const res = await fetch(
      `${baseUrl}/api/records/mine?cursor=${encodeURIComponent(cursor)}&limit=7&smuggle=1`,
      { headers: { 'X-User-Id': 'alice' } },
    );

    expect(res.status).toBe(200);
    expect(userPaths).toEqual([`/api/records/mine?cursor=${encodeURIComponent(cursor)}&limit=7`]);
    // 机械负对照：下游 URL 只有一个 `?`、恰好一个 `&`（分隔 limit）——没有走私键漏进来
    expect(userPaths[0]!.split('?')).toHaveLength(2);
    expect(userPaths[0]!.split('&')).toHaveLength(2);
  });

  it('无 query ⇒ 下游路径不带 `?`（不给下游伪造空参数）', async () => {
    await fetch(`${baseUrl}/api/records/mine`, { headers: { 'X-User-Id': 'alice' } });

    expect(userPaths).toEqual(['/api/records/mine']);
  });

  it('空 cursor（`?cursor=`）⇒ 视同未传（下游收到无 query 的路径）', async () => {
    await fetch(`${baseUrl}/api/records/mine?cursor=`, { headers: { 'X-User-Id': 'alice' } });

    expect(userPaths).toEqual(['/api/records/mine']);
  });
});

/**
 * 货币片 T7（规格 §2.13 表四条路径；设计 §4.5）：
 *  - `GET /api/wallet/balance` → currency（**默认验签** = 不进公开白名单）；
 *  - `POST /api/admin/wallet/adjust` → currency（body 透传，照 admin config PUT 先例）；
 *  - `GET /api/admin/wallet/accounts/:userId` → currency（路径参数先编码）；
 *  - `GET /api/admin/users/lookup` → **user-service**（T7 四条里唯一一条；query 白名单恰好 `phone`）。
 * ② 金币场 T9 增第五条（规格 §9）：`POST /api/wallet/relief` → currency（**默认验签**；body=null，形态照 balance 同族）。
 * 广告片 T15 改写第五条（规格 §2.5）：旧 `POST /api/wallet/relief` **退役**（不再注册 ⇒ 404，真 app 用例钉住）；
 * 新 `GET /api/wallet/relief[?claim=]` → currency（**默认验签**；body=null；query 白名单恰 `claim` 一键）。
 *
 * 守卫面结论（T7 brief 要求逐条确认）：`admin/wallet/*` 与 `admin/users/lookup` 都落在
 * `isAdminPath()` 的**前缀**语义里（`/api/admin/` 子树）⇒ `AdminAuthMiddleware` **免改即覆盖**；
 * 这里把结论钉成断言 —— 若哪天前缀被收窄成枚举而漏加，本文件与 admin.middleware.test 必红。
 */
describe('GatewayController（货币片 T7 + 金币场 T9 + 广告片 T15：钱包路由）', () => {
  const res = {} as never;

  const make = () => {
    const proxy = {
      forwardToCurrencySvc: vi.fn(async () => undefined),
      forwardToUserSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    query: {},
    ...over,
  });

  it('GET /api/wallet/balance 转发 currency（body=null；身份/追踪头随行）', async () => {
    const { controller, proxy } = make();

    await controller.getWalletBalance(
      res,
      req('/api/wallet/balance', { headers: { 'x-user-id': 'u1', 'x-trace-id': 't1' } }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith('GET', '/api/wallet/balance', null, res, {
      userId: 'u1',
      traceId: 't1',
    });
  });

  it('wallet/balance 不进公开白名单（默认验签 —— 网关是唯一验签点）', () => {
    expect(isPublicPath('/api/wallet/balance')).toBe(false);
  });

  it('GET /api/wallet/relief 转发 currency（不带 query ⇒ 路径不带 `?`；body=null；身份/追踪头随行）—— 广告片 T15', async () => {
    const { controller, proxy } = make();

    await controller.getWalletRelief(
      res,
      req('/api/wallet/relief', { headers: { 'x-user-id': 'u1', 'x-trace-id': 't1' } }),
    );

    // 转发三元组与 balance 行同族：GET + 同 path + body=null（查询/签发/轮询口径都在下游）
    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith('GET', '/api/wallet/relief', null, res, {
      userId: 'u1',
      traceId: 't1',
    });
    expect(proxy.forwardToUserSvc).not.toHaveBeenCalled();
  });

  it('relief 的 query 白名单：恰好 `claim` 一键；其余键（走私面）丢弃 + 值编码（R75）', async () => {
    const { controller, proxy } = make();

    await controller.getWalletRelief(
      res,
      req('/api/wallet/relief', {
        query: { claim: 'ab&cd=x#y', smuggle: '1', cursor: 'x' },
      }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'GET',
      '/api/wallet/relief?claim=ab%26cd%3Dx%23y',
      null,
      res,
      {},
    );
  });

  it('relief 的 query 白名单边界：数组取首元素、空串/非字符串丢弃（缺省 = 无凭证查询）', async () => {
    const { controller, proxy } = make();

    await controller.getWalletRelief(res, req('/api/wallet/relief', { query: { claim: ['n1', 'n2'] } }));
    expect(proxy.forwardToCurrencySvc).toHaveBeenLastCalledWith(
      'GET',
      '/api/wallet/relief?claim=n1',
      null,
      res,
      {},
    );

    await controller.getWalletRelief(res, req('/api/wallet/relief', { query: { claim: '' } }));
    expect(proxy.forwardToCurrencySvc).toHaveBeenLastCalledWith('GET', '/api/wallet/relief', null, res, {});
  });

  it('wallet/relief 与 balance 同族守卫面：不进公开白名单（默认验签）、不落 admin 前缀面', () => {
    expect(isPublicPath('/api/wallet/relief')).toBe(false);
    expect(isAdminPath('/api/wallet/relief')).toBe(false);
  });

  it('wallet/relief 随每一跳注入 internalToken（N7 判据在 currency 跳上也有判别力）', async () => {
    const original = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    try {
      const { controller, proxy } = make();

      await controller.getWalletRelief(
        res,
        req('/api/wallet/relief', { headers: { 'x-user-id': 'u1' } }),
      );

      // 第 5 参（下游头）恰好 {userId, internalToken}：若哪天 relief 绕过 headersOf() 自己拼头
      // （或把 token 注入挪出共用路径），本用例必红
      expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
        'GET',
        '/api/wallet/relief',
        null,
        res,
        { userId: 'u1', internalToken: 'internal-secret' },
      );
    } finally {
      if (original === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = original;
    }
  });

  it('POST /api/admin/wallet/adjust 转发 currency：body **原样**透传 + X-Admin 转成 headers.admin', async () => {
    const { controller, proxy } = make();
    const body = { userId: '42', delta: 100, reason: '补偿' };

    await controller.adminAdjustWallet(
      body,
      res,
      req('/api/admin/wallet/adjust', { headers: { 'x-admin': '1' } }),
    );

    // body 透传**逐字**：网关不解析、不改写 —— 契约校验的单一真源在下游
    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'POST',
      '/api/admin/wallet/adjust',
      body,
      res,
      { admin: true },
    );
  });

  it('X-Admin 只认**恰好 `1`**：伪造的其它值不得转成 admin 字段（与 config 路由同一口径）', async () => {
    const { controller, proxy } = make();

    await controller.adminAdjustWallet(
      { delta: 1 },
      res,
      req('/api/admin/wallet/adjust', { headers: { 'x-admin': 'evil' } }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'POST',
      '/api/admin/wallet/adjust',
      { delta: 1 },
      res,
      {},
    );
  });

  it('GET /api/admin/wallet/accounts/:userId：路径参数**编码后**再拼下游 URL（`%3F` 不得走私成查询串）', async () => {
    const { controller, proxy } = make();

    // Express 会把 `%3F` 解码成 `?` 再交给控制器 —— 拼进下游 URL 的必须是**编码后**的值；
    // userId 的合法性不在网关判（§2.6 明确下游不做字符集预检，任何字符串只是「查这个 ownerId」）。
    await controller.adminWalletAccounts(
      'a?b=1',
      res,
      req('/api/admin/wallet/accounts/a%3Fb%3D1', { headers: { 'x-admin': '1' } }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/wallet/accounts/a%3Fb%3D1',
      null,
      res,
      { admin: true },
    );
  });

  it('GET /api/admin/users/lookup 打到 **user-service**（T7 四条里唯一一条）；无 query 时不带 `?`', async () => {
    const { controller, proxy } = make();

    await controller.adminUsersLookup(res, req('/api/admin/users/lookup', { headers: { 'x-admin': '1' } }));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith('GET', '/api/admin/users/lookup', null, res, {
      admin: true,
    });
    expect(proxy.forwardToCurrencySvc).not.toHaveBeenCalled();
  });

  it('lookup 的 query 白名单：恰好 `phone` 一键；其余键（走私面）丢弃 + 值编码（R75）', async () => {
    const { controller, proxy } = make();

    await controller.adminUsersLookup(
      res,
      req('/api/admin/users/lookup', {
        query: { phone: '138+0013 8000', smuggle: '1', cursor: 'x' },
      }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/users/lookup?phone=138%2B0013%208000',
      null,
      res,
      {},
    );
  });

  it('守卫面：两条 admin 路由都在 `isAdminPath` 前缀语义内（免改即覆盖）', () => {
    for (const path of [
      '/api/admin/wallet/adjust',
      '/api/admin/wallet/accounts/42',
      '/api/admin/users/lookup',
    ]) {
      expect(isAdminPath(path), `${path} 必须归 AdminAuthMiddleware 管辖（前缀面）`).toBe(true);
    }
  });
});

/**
 * 货币片 T7 + 金币场 T9 + 广告片 T15：钱包路由的**真 Nest 路由表**（与记录片同一条理由 ——
 * 直接调控制器测不到「路由真的挂在全局前缀 `api` 下」与「Express 解码环」）。
 * 下游替身把收到的 method+path 回显进响应体，断言「下游到底收到了什么」。
 * T15 增补：旧 `POST /api/wallet/relief` 退役 ⇒ **404**（路由表缺条的正确形态）；
 * `getWalletRelief` 的 `claim` query 在 Express 解码环下仍以编码形态进下游。
 */
describe('GatewayController（货币片 T7 + 金币场 T9 + 广告片 T15：真 Nest app 下的路由注册 + query 解码环）', () => {
  let app: INestApplication;
  let baseUrl: string;
  let currencyCalls: Array<[string, string]>;
  let userPaths: string[];
  let proxy: {
    forwardToCurrencySvc: ReturnType<typeof vi.fn>;
    forwardToUserSvc: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    currencyCalls = [];
    userPaths = [];
    proxy = {
      forwardToCurrencySvc: vi.fn(async (m: string, path: string, _b: unknown, res: any) => {
        currencyCalls.push([m, path]);
        res.status(200).json({ code: 0, data: { path } });
      }),
      forwardToUserSvc: vi.fn(async (_m: string, path: string, _b: unknown, res: any) => {
        userPaths.push(path);
        res.status(200).json({ code: 0, data: { path } });
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [{ provide: ProxyGateway, useValue: proxy }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api'); // 与 src/main.ts 一致
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    currencyCalls.length = 0;
    userPaths.length = 0;
  });

  it('五条路由全部挂在 `/api` 下（404 即路由表缺条 —— 本用例是「存在性」判据）；旧 POST relief 退役 ⇒ 404', async () => {
    const authed = (path: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${path}`, { ...init, headers: { 'X-User-Id': 'alice', ...(init.headers ?? {}) } });

    expect((await authed('/api/wallet/balance')).status).toBe(200);
    // 广告片 T15（§2.5）：GET 查询 —— 存在性 + 方法与路径逐字进下游
    expect((await authed('/api/wallet/relief')).status).toBe(200);
    // 旧 POST（② 金币场 T9）不再注册：发放唯一入口 = 广告回调
    expect((await authed('/api/wallet/relief', { method: 'POST' })).status).toBe(404);
    expect(
      (
        await authed('/api/admin/wallet/adjust', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: '42', delta: 5, reason: 'r' }),
        })
      ).status,
    ).toBe(200);
    expect((await authed('/api/admin/wallet/accounts/42')).status).toBe(200);
    expect((await authed('/api/admin/users/lookup?phone=13800138000')).status).toBe(200);

    expect(currencyCalls).toEqual([
      ['GET', '/api/wallet/balance'],
      ['GET', '/api/wallet/relief'],
      ['POST', '/api/admin/wallet/adjust'],
      ['GET', '/api/admin/wallet/accounts/42'],
    ]);
    expect(userPaths).toEqual(['/api/admin/users/lookup?phone=13800138000']);
  });

  it('claim 经 Express 解码后又以编码形态进下游 URL（`&`/`=`/`#`）；走私键不可达；空 claim 视同未携', async () => {
    const claim = 'ab&c=d#e';
    const res = await fetch(
      `${baseUrl}/api/wallet/relief?claim=${encodeURIComponent(claim)}&smuggle=1`,
      { headers: { 'X-User-Id': 'alice' } },
    );

    expect(res.status).toBe(200);
    expect(currencyCalls).toEqual([['GET', `/api/wallet/relief?claim=${encodeURIComponent(claim)}`]]);
    // 机械负对照：下游 URL 只有一个 `?`、零个裸 `&` —— 没有走私键漏进来
    expect(currencyCalls[0]![1].split('?')).toHaveLength(2);
    expect(currencyCalls[0]![1].split('&')).toHaveLength(1);

    // 空 claim（`?claim=`）⇒ 视同未传（下游收到无 query 的路径 —— 与空 cursor 同口径）
    await fetch(`${baseUrl}/api/wallet/relief?claim=`, { headers: { 'X-User-Id': 'alice' } });
    expect(currencyCalls.at(-1)).toEqual(['GET', '/api/wallet/relief']);
  });

  it('phone 经 Express 解码后又以编码形态进下游 URL（`+`/空格/`&`）；走私键不可达', async () => {
    const phone = '+86 138&0013#8000';
    const res = await fetch(
      `${baseUrl}/api/admin/users/lookup?phone=${encodeURIComponent(phone)}&smuggle=1`,
      { headers: { 'X-User-Id': 'alice' } },
    );

    expect(res.status).toBe(200);
    expect(userPaths).toEqual([`/api/admin/users/lookup?phone=${encodeURIComponent(phone)}`]);
    // 机械负对照：下游 URL 只有一个 `?`、零个裸 `&` —— 没有走私键漏进来
    expect(userPaths[0]!.split('?')).toHaveLength(2);
    expect(userPaths[0]!.split('&')).toHaveLength(1);
  });

  it('无 query ⇒ 下游路径不带 `?`（不给下游伪造空参数）', async () => {
    await fetch(`${baseUrl}/api/admin/users/lookup`, { headers: { 'X-User-Id': 'alice' } });

    expect(userPaths).toEqual(['/api/admin/users/lookup']);
  });
});

/**
 * ③ T5（规格 §2.10）：管理面**路由登记**（≈14 条）+ **query 白名单**（⚙️9 修订版）。
 *
 *  - 列表/过滤类端点（ops、三读口、summary、accounts 列表）**未知 query 键 ⇒ 400 借 10001**
 *    「未知查询参数：<key>」——静默丢弃会把「筛过的」与「全量」混同（误导性读数）；
 *  - `.csv` 变体白名单 = JSON 版**去掉 `cursor/limit`**（带上即 400）；
 *  - 非列表新端点（ops/:opId、reconcile、users/:userId）与既有端点**维持静默丢弃**；
 *  - 路径参数编码照 `:key`/`:userId` 先例（`encodeURIComponent`，R75）；
 *  - 下游 handler 尚未落地（T6/T9 之后）—— 本组断言**转发形状**（服务/方法/路径/头）。
 */
describe('GatewayController（③ T5：管理面路由登记 + query 白名单）', () => {
  const res = {} as never;

  const make = () => {
    // ⚠️ 显式标注（照 R75 describe 的先例）：`vi.fn(async () => undefined)` 的推断调用元
    // 是 `[]`，读 `mock.calls.at(-1)?.[1]` 会 TS2493；标注后参数面是 any[][]。
    const proxy: {
      forwardToConfigSvc: ReturnType<typeof vi.fn>;
      forwardToCurrencySvc: ReturnType<typeof vi.fn>;
      forwardToUserSvc: ReturnType<typeof vi.fn>;
    } = {
      forwardToConfigSvc: vi.fn(async () => undefined),
      forwardToCurrencySvc: vi.fn(async () => undefined),
      forwardToUserSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    query: {},
    ...over,
  });

  /** 中间件验真后注入的三枚（T5 第 7 步产物）。 */
  const INJECTED = { 'x-admin': '1', 'x-admin-actor': 'admin', 'x-admin-roles': 'super_admin' };

  const catchErr = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (err) {
      return err as { getStatus: () => number; getResponse: () => unknown };
    }
  };

  it('GET /api/admin/accounts：增补后三枚身份头转出（admin/adminActor/adminRole）', async () => {
    const { controller, proxy } = make();

    await controller.adminListAccounts(res, req('/api/admin/accounts', { headers: { ...INJECTED } }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('GET', '/api/admin/accounts', null, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'super_admin',
    });
  });

  it('POST /api/admin/accounts：body **逐字**透传（校验单一真源在下游）', async () => {
    const { controller, proxy } = make();
    const body = { username: 'ops1', password: 'longenough1', role: 'operator' };

    await controller.adminCreateAccount(body, res, req('/api/admin/accounts', { headers: { ...INJECTED } }));

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith('POST', '/api/admin/accounts', body, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'super_admin',
    });
  });

  it('PATCH /api/admin/accounts/:id：方法 PATCH + `:id` 编码后再拼下游 URL（R75）', async () => {
    const { controller, proxy } = make();
    const body = { status: 'disabled' };

    await controller.adminPatchAccount(
      'a?b=1',
      body,
      res,
      req('/api/admin/accounts/a%3Fb%3D1', { headers: { ...INJECTED } }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'PATCH',
      '/api/admin/accounts/a%3Fb%3D1',
      body,
      res,
      { admin: true, adminActor: 'admin', adminRole: 'super_admin' },
    );
  });

  it('GET /api/admin/accounts/changes：过滤键透传（JSON 版含 cursor/limit）+ 每值编码', async () => {
    const { controller, proxy } = make();

    await controller.adminAccountChanges(
      res,
      req('/api/admin/accounts/changes', {
        query: { targetId: '42', actor: 'a&b', action: 'role', from: '1', to: '2', cursor: '9', limit: '50' },
      }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/accounts/changes?targetId=42&actor=a%26b&action=role&from=1&to=2&cursor=9&limit=50',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/config/changes：白名单 = key/actor/from/to/cursor/limit', async () => {
    const { controller, proxy } = make();

    await controller.adminConfigChanges(
      res,
      req('/api/admin/config/changes', { query: { key: 'room.friendRoomEnabled', cursor: '7', limit: '10' } }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/config/changes?key=room.friendRoomEnabled&cursor=7&limit=10',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/login-events：白名单 = username/success/from/to/cursor/limit', async () => {
    const { controller, proxy } = make();

    await controller.adminLoginEvents(
      res,
      req('/api/admin/login-events', { query: { username: 'admin', success: '1', cursor: '3', limit: '20' } }),
    );

    expect(proxy.forwardToConfigSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/login-events?username=admin&success=1&cursor=3&limit=20',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/wallet/ops：白名单 = source/actor/ownerId/from/to/cursor/limit', async () => {
    const { controller, proxy } = make();

    await controller.adminWalletOps(
      res,
      req('/api/admin/wallet/ops', {
        query: { source: 'admin_adjust', actor: 'admin', ownerId: '42', from: '1', to: '2', cursor: '8', limit: '100' },
      }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/wallet/ops?source=admin_adjust&actor=admin&ownerId=42&from=1&to=2&cursor=8&limit=100',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/wallet/summary：白名单 = from/to/groupBy（无 cursor/limit 概念）', async () => {
    const { controller, proxy } = make();

    await controller.adminWalletSummary(
      res,
      req('/api/admin/wallet/summary', { query: { groupBy: 'day', from: '1', to: '2' } }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/wallet/summary?from=1&to=2&groupBy=day',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/wallet/ops/:opId：路径参数编码（R75）、query 静默丢弃（非列表端点）', async () => {
    const { controller, proxy } = make();

    await controller.adminWalletOpDetail(
      'a?b=1',
      res,
      req('/api/admin/wallet/ops/a%3Fb%3D1', { query: { smuggle: '1' } }),
    );

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/wallet/ops/a%3Fb%3D1',
      null,
      res,
      {},
    );
  });

  it('POST /api/admin/wallet/reverse：body 透传（冲正契约的单一真源在下游）', async () => {
    const { controller, proxy } = make();
    const body = { opId: 7, reason: '误操作' };

    await controller.adminWalletReverse(body, res, req('/api/admin/wallet/reverse', { headers: { ...INJECTED } }));

    expect(proxy.forwardToCurrencySvc).toHaveBeenCalledWith('POST', '/api/admin/wallet/reverse', body, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'super_admin',
    });
  });

  it('GET/POST admin/wallet/reconcile[/run]：query 静默丢弃、run 无 body（null）', async () => {
    const { controller, proxy } = make();

    await controller.adminWalletReconcile(res, req('/api/admin/wallet/reconcile', { query: { x: '1' } }));
    expect(proxy.forwardToCurrencySvc).toHaveBeenLastCalledWith(
      'GET',
      '/api/admin/wallet/reconcile',
      null,
      res,
      {},
    );

    await controller.adminWalletReconcileRun(res, req('/api/admin/wallet/reconcile/run', { query: { x: '1' } }));
    expect(proxy.forwardToCurrencySvc).toHaveBeenLastCalledWith(
      'POST',
      '/api/admin/wallet/reconcile/run',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/users/:userId：打到 **user-service**；路径参数编码（R75）', async () => {
    const { controller, proxy } = make();

    await controller.adminUserDetail(
      'a?b=1',
      res,
      req('/api/admin/users/a%3Fb%3D1', { query: { smuggle: '1' } }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith('GET', '/api/admin/users/a%3Fb%3D1', null, res, {});
    expect(proxy.forwardToConfigSvc).not.toHaveBeenCalled();
  });

  it('.csv 变体：路径带 .csv 转发；白名单 = JSON 版去 cursor/limit（带上 ⇒ 400 未知查询参数）', async () => {
    const csvCases: Array<[string, (c: GatewayController, r: unknown) => Promise<unknown>, string, string]> = [
      ['/api/admin/accounts/changes.csv', (c, r) => c.adminAccountChangesCsv(res, r), 'targetId', 'targetId=7'],
      ['/api/admin/config/changes.csv', (c, r) => c.adminConfigChangesCsv(res, r), 'key', 'key=k1'],
      ['/api/admin/login-events.csv', (c, r) => c.adminLoginEventsCsv(res, r), 'username', 'username=a'],
      ['/api/admin/wallet/ops.csv', (c, r) => c.adminWalletOpsCsv(res, r), 'source', 'source=admin_adjust'],
    ];

    for (const [path, invoke, allowedKey, expectedQuery] of csvCases) {
      // 正例：过滤键透传（一个非 cursor/limit 键）
      const { controller, proxy } = make();
      await invoke(controller, req(path, { query: { [allowedKey]: expectedQuery.split('=')[1] } }));
      const calls = [
        ...proxy.forwardToConfigSvc.mock.calls,
        ...proxy.forwardToCurrencySvc.mock.calls,
        ...proxy.forwardToUserSvc.mock.calls,
      ];
      expect(calls.at(-1)?.[1], path).toBe(`${path}?${expectedQuery}`);

      // 负例：cursor ⇒ 未知键 400（CSV 白名单明确去掉 cursor/limit）
      for (const bad of ['cursor', 'limit']) {
        const { controller: c2 } = make();
        const err = await catchErr(invoke(c2, req(path, { query: { [bad]: '1' } })));
        expect(err, `${path}?${bad}`).not.toBeNull();
        expect(err!.getStatus(), `${path}?${bad}`).toBe(400);
        expect(err!.getResponse(), `${path}?${bad}`).toMatchObject({
          code: 10001,
          message: `未知查询参数：${bad}`,
          data: null,
        });
      }
    }
  });

  it('🔴 未知 query 键 ⇒ 400 借 10001「未知查询参数：<key>」，且**不发起**下游请求', async () => {
    const listCases: Array<[string, (c: GatewayController, r: unknown) => Promise<unknown>]> = [
      ['/api/admin/config/changes', (c, r) => c.adminConfigChanges(res, r)],
      ['/api/admin/login-events', (c, r) => c.adminLoginEvents(res, r)],
      ['/api/admin/accounts/changes', (c, r) => c.adminAccountChanges(res, r)],
      ['/api/admin/wallet/ops', (c, r) => c.adminWalletOps(res, r)],
      ['/api/admin/wallet/summary', (c, r) => c.adminWalletSummary(res, r)],
    ];

    for (const [path, invoke] of listCases) {
      const { controller, proxy } = make();
      const err = await catchErr(invoke(controller, req(path, { query: { smuggled: 'x' } })));

      expect(err, path).not.toBeNull();
      expect(err!.getStatus(), path).toBe(400);
      expect(err!.getResponse(), path).toMatchObject({
        code: 10001,
        message: '未知查询参数：smuggled',
        data: null,
      });
      expect(proxy.forwardToConfigSvc, path).not.toHaveBeenCalled();
      expect(proxy.forwardToCurrencySvc, path).not.toHaveBeenCalled();
      expect(proxy.forwardToUserSvc, path).not.toHaveBeenCalled();
    }

    // accounts 列表白名单为**空**：连 cursor/limit 都是未知键（列表不分页，⚙️10/⚙️18）
    const { controller: c2 } = make();
    const err = await catchErr(c2.adminListAccounts(res, req('/api/admin/accounts', { query: { cursor: '1' } })));
    expect(err).not.toBeNull();
    expect(err!.getStatus()).toBe(400);
    expect(err!.getResponse()).toMatchObject({ code: 10001, message: '未知查询参数：cursor', data: null });
  });

  it('既有端点维持静默丢弃：lookup 的白名单外键照旧被丢（不是 400）', async () => {
    const { controller, proxy } = make();

    await controller.adminUsersLookup(
      res,
      req('/api/admin/users/lookup', { query: { phone: '13800138000', smuggle: '1' } }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/users/lookup?phone=13800138000',
      null,
      res,
      {},
    );
  });
});

/**
 * 风控 T7（规格 §2.9-4）：管理面**风控四端点**的网关侧路由登记 + query 白名单
 *（下游 = user-service 的 T6 控制器；授权在 policy P-r1..P-r4）。
 *
 * 形态照 ③ T5 家族：列表/过滤端点**严格白名单**（未知键 ⇒ 400 借 10001
 * 「未知查询参数：<key>」—— 与下游 T6 同句文案）；非列表端点（users/:userId）
 * 维持静默丢弃；`.csv` 变体 = JSON 版**去掉 cursor/limit**（带上即 400）。
 */
describe('GatewayController（风控 T7：管理面风控路由登记 + query 白名单）', () => {
  const res = {} as never;

  const make = () => {
    const proxy: { forwardToUserSvc: ReturnType<typeof vi.fn> } = {
      forwardToUserSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    query: {},
    ...over,
  });

  /** 中间件验真后注入的三枚（T5 第 7 步产物）。 */
  const INJECTED = { 'x-admin': '1', 'x-admin-actor': 'admin', 'x-admin-roles': 'operator' };

  const catchErr = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (err) {
      return err as { getStatus: () => number; getResponse: () => unknown };
    }
  };

  it('GET /api/admin/risk/reviews：白名单 = status/cursor/limit（顺序即拼装顺序）+ 每值编码', async () => {
    const { controller, proxy } = make();

    await controller.adminRiskReviews(
      res,
      req('/api/admin/risk/reviews', { query: { status: 'open', cursor: '9', limit: '50' } }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/risk/reviews?status=open&cursor=9&limit=50',
      null,
      res,
      {},
    );
  });

  it('R75 一族：query 值以编码形态进下游 URL（`,`/`&`/`=` 不得走私）', async () => {
    const { controller, proxy } = make();

    await controller.adminRiskReviews(res, req('/api/admin/risk/reviews', { query: { status: 'a&b=c' } }));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/risk/reviews?status=a%26b%3Dc',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/risk/users/:userId：打到 user-service；路径参数编码（R75）、query 静默丢弃（非列表端点）', async () => {
    const { controller, proxy } = make();

    await controller.adminRiskUserDetail(
      'a?b=1',
      res,
      req('/api/admin/risk/users/a%3Fb%3D1', { query: { smuggle: '1' } }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/risk/users/a%3Fb%3D1',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/risk/actions：白名单 = userId/action/actor/from/to/cursor/limit', async () => {
    const { controller, proxy } = make();

    await controller.adminRiskActions(
      res,
      req('/api/admin/risk/actions', {
        query: { userId: 'u1', action: 'ban', actor: 'admin', from: '1', to: '2', cursor: '8', limit: '100' },
      }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/risk/actions?userId=u1&action=ban&actor=admin&from=1&to=2&cursor=8&limit=100',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/risk/actions.csv：白名单 = JSON 版**去 cursor/limit**（带上 ⇒ 400 未知键）', async () => {
    // 正例：过滤键透传（路径保留 .csv —— 网关透传的是下游给出的 CSV 响应）
    const { controller, proxy } = make();
    await controller.adminRiskActionsCsv(
      res,
      req('/api/admin/risk/actions.csv', { query: { userId: 'u1', action: 'ban' } }),
    );
    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/risk/actions.csv?userId=u1&action=ban',
      null,
      res,
      {},
    );

    // 负例：cursor/limit ⇒ 400（CSV 白名单明确去掉两键）
    for (const bad of ['cursor', 'limit']) {
      const { controller: c2, proxy: p2 } = make();
      const err = await catchErr(
        c2.adminRiskActionsCsv(res, req('/api/admin/risk/actions.csv', { query: { [bad]: '1' } })),
      );
      expect(err, bad).not.toBeNull();
      expect(err!.getStatus(), bad).toBe(400);
      expect(err!.getResponse(), bad).toMatchObject({
        code: 10001,
        message: `未知查询参数：${bad}`,
        data: null,
      });
      expect(p2.forwardToUserSvc, bad).not.toHaveBeenCalled();
    }
  });

  it('POST /api/admin/risk/actions：body 逐字透传（校验单一真源在下游 T6）+ 三枚身份头转出', async () => {
    const { controller, proxy } = make();
    const body = { userId: 'u1', action: 'ban', reason: '多账号同设备' };

    await controller.adminRiskApplyAction(body, res, req('/api/admin/risk/actions', { headers: { ...INJECTED } }));

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith('POST', '/api/admin/risk/actions', body, res, {
      admin: true,
      adminActor: 'admin',
      adminRole: 'operator',
    });
  });

  it('DELETE /api/admin/risk/users/:userId/device-binding：打到 user-service；参数编码（R75）、无 body、身份头转出', async () => {
    const { controller, proxy } = make();

    await controller.adminRiskUnbindDevice(
      'a/b',
      res,
      req('/api/admin/risk/users/a%2Fb/device-binding', { headers: { ...INJECTED } }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'DELETE',
      '/api/admin/risk/users/a%2Fb/device-binding',
      null,
      res,
      {
        admin: true,
        adminActor: 'admin',
        adminRole: 'operator',
      },
    );
  });

  it('🔴 未知 query 键 ⇒ 400 借 10001「未知查询参数：<key>」，且**不发起**下游请求', async () => {
    const listCases: Array<[string, (c: GatewayController, r: unknown) => Promise<unknown>]> = [
      ['/api/admin/risk/reviews', (c, r) => c.adminRiskReviews(res, r)],
      ['/api/admin/risk/actions', (c, r) => c.adminRiskActions(res, r)],
    ];

    for (const [path, invoke] of listCases) {
      const { controller, proxy } = make();
      const err = await catchErr(invoke(controller, req(path, { query: { smuggled: 'x' } })));

      expect(err, path).not.toBeNull();
      expect(err!.getStatus(), path).toBe(400);
      expect(err!.getResponse(), path).toMatchObject({
        code: 10001,
        message: '未知查询参数：smuggled',
        data: null,
      });
      expect(proxy.forwardToUserSvc, path).not.toHaveBeenCalled();
    }
  });
});

/**
 * ③ T5：管理面路由的**真 Nest 路由表**（与记录片/货币片同一条理由 —— 直接调控制器
 * 测不到「路由真的挂在全局前缀 `api` 下」「PATCH/CSV 真的被 Express 路由 recognize」
 * 以及「`admin/users/lookup` 不得被 `admin/users/:userId` 抢先吞掉 query」）。
 */
describe('GatewayController（③ T5：真 Nest app —— 管理面路由登记 + PATCH/CSV + query 400）', () => {
  let app: INestApplication;
  let baseUrl: string;
  let calls: Array<[string, string, string]>;
  /** 最近一次转发的下游头（login 的 clientIp 端到端接线用）。 */
  let lastHeaders: Record<string, unknown> | undefined;
  let proxy: {
    forwardToConfigSvc: ReturnType<typeof vi.fn>;
    forwardToCurrencySvc: ReturnType<typeof vi.fn>;
    forwardToUserSvc: ReturnType<typeof vi.fn>;
  };

  const ADMINISH = { 'X-Admin': '1', 'X-Admin-Actor': 'admin', 'X-Admin-Roles': 'super_admin' };

  beforeAll(async () => {
    calls = [];
    const record = (svc: string) =>
      vi.fn(async (m: string, path: string, _b: unknown, res: any, headers?: Record<string, unknown>) => {
        calls.push([svc, m, path]);
        lastHeaders = headers;
        res.status(200).json({ code: 0, data: path });
      });
    proxy = {
      forwardToConfigSvc: record('config'),
      forwardToCurrencySvc: record('currency'),
      forwardToUserSvc: record('user'),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [{ provide: ProxyGateway, useValue: proxy }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api'); // 与 src/main.ts 一致
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, { ...init, headers: { ...ADMINISH, ...(init.headers ?? {}) } });

  it('新路由全部注册：方法/路径逐字进下游（PATCH 与 .csv 都真的被 recognize）', async () => {
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const expected: Array<[string, RequestInit, string, string, string]> = [
      ['/api/admin/accounts', {}, 'config', 'GET', '/api/admin/accounts'],
      ['/api/admin/accounts', json('POST', { username: 'u1' }), 'config', 'POST', '/api/admin/accounts'],
      ['/api/admin/accounts/42', json('PATCH', { status: 'disabled' }), 'config', 'PATCH', '/api/admin/accounts/42'],
      ['/api/admin/accounts/changes?actor=a', {}, 'config', 'GET', '/api/admin/accounts/changes?actor=a'],
      ['/api/admin/accounts/changes.csv?actor=a', {}, 'config', 'GET', '/api/admin/accounts/changes.csv?actor=a'],
      ['/api/admin/config/changes?key=k1', {}, 'config', 'GET', '/api/admin/config/changes?key=k1'],
      ['/api/admin/config/changes.csv?key=k1', {}, 'config', 'GET', '/api/admin/config/changes.csv?key=k1'],
      ['/api/admin/login-events?username=a', {}, 'config', 'GET', '/api/admin/login-events?username=a'],
      ['/api/admin/login-events.csv?username=a', {}, 'config', 'GET', '/api/admin/login-events.csv?username=a'],
      ['/api/admin/wallet/ops?source=admin_adjust', {}, 'currency', 'GET', '/api/admin/wallet/ops?source=admin_adjust'],
      ['/api/admin/wallet/ops.csv?source=admin_adjust', {}, 'currency', 'GET', '/api/admin/wallet/ops.csv?source=admin_adjust'],
      ['/api/admin/wallet/ops/77', {}, 'currency', 'GET', '/api/admin/wallet/ops/77'],
      ['/api/admin/wallet/summary?groupBy=day', {}, 'currency', 'GET', '/api/admin/wallet/summary?groupBy=day'],
      ['/api/admin/wallet/summary.csv?groupBy=source', {}, 'currency', 'GET', '/api/admin/wallet/summary.csv?groupBy=source'],
      ['/api/admin/wallet/reverse', json('POST', { opId: 7, reason: 'r' }), 'currency', 'POST', '/api/admin/wallet/reverse'],
      ['/api/admin/wallet/reconcile', {}, 'currency', 'GET', '/api/admin/wallet/reconcile'],
      ['/api/admin/wallet/reconcile/run', { method: 'POST' }, 'currency', 'POST', '/api/admin/wallet/reconcile/run'],
      ['/api/admin/users/abc-123', {}, 'user', 'GET', '/api/admin/users/abc-123'],
      ['/api/admin/users/lookup?phone=13800138000', {}, 'user', 'GET', '/api/admin/users/lookup?phone=13800138000'],
      // 风控 T7：四端点（含 .csv 变体）逐条登记 —— 真路由 recognize 判据
      ['/api/admin/risk/reviews?status=open', {}, 'user', 'GET', '/api/admin/risk/reviews?status=open'],
      ['/api/admin/risk/users/abc-123', {}, 'user', 'GET', '/api/admin/risk/users/abc-123'],
      ['/api/admin/risk/actions?action=ban', {}, 'user', 'GET', '/api/admin/risk/actions?action=ban'],
      ['/api/admin/risk/actions.csv?action=ban', {}, 'user', 'GET', '/api/admin/risk/actions.csv?action=ban'],
      [
        '/api/admin/risk/actions',
        json('POST', { userId: 'u1', action: 'ban', reason: 'r' }),
        'user',
        'POST',
        '/api/admin/risk/actions',
      ],
      // 设备绑定片：人工解绑（DELETE 路由必须真的被 recognize —— policy P-r5 才有意义）
      [
        '/api/admin/risk/users/u-abc-123/device-binding',
        { method: 'DELETE' },
        'user',
        'DELETE',
        '/api/admin/risk/users/u-abc-123/device-binding',
      ],
      // 支付配置管理化 T7：pay-channel 三路由（下游 = config-service；写面授权在 policy P-c1/P-c2）
      ['/api/admin/pay-channel', {}, 'config', 'GET', '/api/admin/pay-channel'],
      [
        '/api/admin/pay-channel/pay.channel.privateKey',
        json('PUT', { value: 'v' }),
        'config',
        'PUT',
        '/api/admin/pay-channel/pay.channel.privateKey',
      ],
      // 键段 `%2E` 经 Express 解码 ⇒ 参数 = `pay.channel.privateKey`，再编码进下游 URL
      //（与 policy「看未解码原值路径」对照 —— B1 面的真实解码环）
      [
        '/api/admin/pay-channel/pay%2Echannel%2EprivateKey',
        json('PUT', { value: 'v' }),
        'config',
        'PUT',
        '/api/admin/pay-channel/pay.channel.privateKey',
      ],
      [
        '/api/admin/pay-channel/pay.channel.privateKey',
        { method: 'DELETE' },
        'config',
        'DELETE',
        '/api/admin/pay-channel/pay.channel.privateKey',
      ],
      // 通知通道管理化 T8：notify-channel 三路由（下游 = config-service；写面授权在 policy P-n1/P-n2）
      ['/api/admin/notify-channel', {}, 'config', 'GET', '/api/admin/notify-channel'],
      [
        '/api/admin/notify-channel/notify.smtp.pass',
        json('PUT', { value: 'v' }),
        'config',
        'PUT',
        '/api/admin/notify-channel/notify.smtp.pass',
      ],
      // 键段 `%2E` 经 Express 解码 ⇒ 参数 = `notify.smtp.pass`，再编码进下游 URL
      //（与 policy「看未解码原值路径」对照 —— B1 面的真实解码环）
      [
        '/api/admin/notify-channel/notify%2Esmtp%2Epass',
        json('PUT', { value: 'v' }),
        'config',
        'PUT',
        '/api/admin/notify-channel/notify.smtp.pass',
      ],
      [
        '/api/admin/notify-channel/notify.webhook.wecomUrl',
        { method: 'DELETE' },
        'config',
        'DELETE',
        '/api/admin/notify-channel/notify.webhook.wecomUrl',
      ],
      // 广告片 T8：ad-channel 三路由（下游 = config-service；写面授权在 policy P-a1/P-a2）
      ['/api/admin/ad-channel', {}, 'config', 'GET', '/api/admin/ad-channel'],
      [
        '/api/admin/ad-channel/ad.callbackSecret',
        json('PUT', { value: 'v' }),
        'config',
        'PUT',
        '/api/admin/ad-channel/ad.callbackSecret',
      ],
      // 键段 `%2E` 经 Express 解码 ⇒ 参数 = `ad.callbackSecret`，再编码进下游 URL
      //（与 policy「看未解码原值路径」对照 —— B1 面的真实解码环）
      [
        '/api/admin/ad-channel/ad%2EcallbackSecret',
        json('PUT', { value: 'v' }),
        'config',
        'PUT',
        '/api/admin/ad-channel/ad.callbackSecret',
      ],
      [
        '/api/admin/ad-channel/ad.callbackSecret',
        { method: 'DELETE' },
        'config',
        'DELETE',
        '/api/admin/ad-channel/ad.callbackSecret',
      ],
    ];

    for (const [path, init, svc, method, downstream] of expected) {
      calls.length = 0;
      const res = await call(path, init);
      expect({ path, status: res.status }, path).toEqual({ path, status: 200 });
      expect(calls, path).toEqual([[svc, method, downstream]]);
    }
  });

  it('登录路径 clientIp 端到端：真 HTTP 上派生并转发；非登录路径不带', async () => {
    /** 读 `lastHeaders`（经显式类型 — 变量在闭包里被赋值，直接读会被 TS 控制流收窄成 never）。 */
    const lastClientIp = () =>
      (lastHeaders as Record<string, unknown> | undefined)?.clientIp;

    calls.length = 0;
    lastHeaders = undefined;
    const res1 = await call('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'p' }),
    });
    expect(res1.status).toBe(200);
    expect(calls).toEqual([['config', 'POST', '/api/admin/login']]);
    // 派生值来自 socket/req.ip（真 HTTP 上恒有对端）—— 非空字符串即接线成立。
    expect(typeof lastClientIp(), JSON.stringify(lastHeaders)).toBe('string');
    expect((lastClientIp() as string).length).toBeGreaterThan(0);

    // 客户端伪造 X-Client-Ip：headersOf **不读**它（真链上还会被 AdminAuthMiddleware 先剥）——
    // 转发值仍是派生值而不是伪造值。
    calls.length = 0;
    lastHeaders = undefined;
    await call('/api/admin/login', { method: 'POST', headers: { 'X-Client-Ip': 'evil' } });
    expect(lastClientIp()).toBeTruthy();
    expect(lastClientIp()).not.toBe('evil');

    // 非登录路径（哪怕客户端自带该头）不产出
    calls.length = 0;
    lastHeaders = undefined;
    await call('/api/admin/accounts', { headers: { 'X-Client-Ip': 'evil' } });
    expect(lastClientIp()).toBeUndefined();
  });

  it('🔴 lookup 不得被 users/:userId 抢先：带 query 的 lookup 保 query、:userId 变体丢 query', async () => {
    // 若 :userId 注册在前，`?phone=` 会被静默丢弃 —— 本用例是注册顺序的判别性判据。
    calls.length = 0;
    await call('/api/admin/users/lookup?phone=13800138000');
    expect(calls).toEqual([['user', 'GET', '/api/admin/users/lookup?phone=13800138000']]);

    calls.length = 0;
    await call('/api/admin/users/u-1?smuggle=1');
    expect(calls).toEqual([['user', 'GET', '/api/admin/users/u-1']]);
  });

  it('未知 query 键在真 HTTP 上 ⇒ 400 + 借码 10001 + 逐字文案（不经下游）', async () => {
    const res = await call('/api/admin/wallet/ops?smuggle=1');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 10001, message: '未知查询参数：smuggle', data: null });
    expect(calls).toEqual([]);
  });

  it('.csv 变体带 cursor/limit ⇒ 400；过滤键则 200 且路径保留 .csv', async () => {
    const bad = await call('/api/admin/config/changes.csv?cursor=1');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: 10001, message: '未知查询参数：cursor', data: null });
    expect(calls).toEqual([]);

    const ok = await call('/api/admin/config/changes.csv?from=1&to=2');
    expect(ok.status).toBe(200);
    expect(calls).toEqual([['config', 'GET', '/api/admin/config/changes.csv?from=1&to=2']]);
  });
});

/**
 * 支付片 T12（规格 §2.4.2 / §2.7.2）：管理面支付路由登记 + query 白名单。
 *
 * 形状 = ③/风控 T7 同族：直接实例化控制器（路由表 + `strictQueryOf` 的取值逻辑）；
 * 转发目标**必须**是 `forwardToPaymentSvc`（谁把它改回别的服务，这里红一次）。
 * 白名单逐条 = 规格点名键集；`.csv` 变体不带 `cursor`（带上 ⇒ 400 未知键）。
 */
describe('GatewayController（支付 T12：管理面支付路由登记 + query 白名单）', () => {
  const res = {} as never;

  const make = () => {
    const proxy: { forwardToPaymentSvc: ReturnType<typeof vi.fn> } = {
      forwardToPaymentSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    query: {},
    ...over,
  });

  /** 中间件验真后注入的三枚（T5 第 7 步产物）。 */
  const INJECTED = { 'x-admin': '1', 'x-admin-actor': 'finance-01', 'x-admin-roles': 'finance' };

  const catchErr = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (err) {
      return err as { getStatus: () => number; getResponse: () => unknown };
    }
  };

  it('GET /api/admin/pay/orders：白名单 = status/userId/from/to/cursor（顺序即拼装顺序）+ 每值编码', async () => {
    const { controller, proxy } = make();
    await controller.adminPayOrders(
      res,
      req('/api/admin/pay/orders', { query: { status: 'paid', userId: 'u1', from: '1', to: '2', cursor: 'c' } }),
    );
    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/pay/orders?status=paid&userId=u1&from=1&to=2&cursor=c',
      null,
      res,
      {},
    );
  });

  it('GET /api/admin/pay/orders/:orderNo：路径参数**编码后**再拼下游 URL（R75）；query 静默丢弃（非列表端点）', async () => {
    const { controller, proxy } = make();
    await controller.adminPayOrderDetail('pay_1?seat=1', res, req('/api/admin/pay/orders/pay_1%3Fseat%3D1', { query: { smuggle: '1' } }));
    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/pay/orders/pay_1%3Fseat%3D1',
      null,
      res,
      {},
    );
  });

  it('.csv 变体：路径保留 .csv；orders.csv 白名单去 cursor（带上 ⇒ 400 未知键，且不发起下游请求）', async () => {
    const { controller, proxy } = make();
    await controller.adminPayOrdersCsv(res, req('/api/admin/pay/orders.csv', { query: { status: 'paid' } }));
    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/pay/orders.csv?status=paid',
      null,
      res,
      {},
    );

    for (const bad of ['cursor', 'limit']) {
      const { controller: c2, proxy: p2 } = make();
      const err = await catchErr(c2.adminPayOrdersCsv(res, req('/api/admin/pay/orders.csv', { query: { [bad]: '1' } })));
      expect(err, bad).not.toBeNull();
      expect(err!.getStatus(), bad).toBe(400);
      expect(err!.getResponse(), bad).toMatchObject({ code: 10001, message: `未知查询参数：${bad}`, data: null });
      expect(p2.forwardToPaymentSvc, bad).not.toHaveBeenCalled();
    }
  });

  it('refunds / withdrawals / actions：白名单与转发目标（全部 = payment-service）', async () => {
    const { controller, proxy } = make();
    await controller.adminPayRefunds(res, req('/api/admin/pay/refunds', { query: { status: 'pending', userId: 'u1' } }));
    await controller.adminPayRefundsCsv(res, req('/api/admin/pay/refunds.csv', { query: { status: 'pending' } }));
    await controller.adminPayRefundDetail('rf_1', res, req('/api/admin/pay/refunds/rf_1'));
    await controller.adminPayWithdrawals(res, req('/api/admin/pay/withdrawals', { query: { status: 'approved', userId: 'u1' } }));
    await controller.adminPayWithdrawalsCsv(res, req('/api/admin/pay/withdrawals.csv'));
    await controller.adminPayWithdrawDetail('wd_1', res, req('/api/admin/pay/withdrawals/wd_1'));
    await controller.adminPayActions(res, req('/api/admin/pay/actions', { query: { from: '1', to: '2', actor: 'admin' } }));
    await controller.adminPayActionsCsv(res, req('/api/admin/pay/actions.csv', { query: { actor: 'admin' } }));

    const paths = (proxy.forwardToPaymentSvc.mock.calls as Array<[string, string, unknown]>).map(
      ([method, path]) => `${method} ${path}`,
    );
    expect(paths).toEqual([
      'GET /api/admin/pay/refunds?status=pending&userId=u1',
      'GET /api/admin/pay/refunds.csv?status=pending',
      'GET /api/admin/pay/refunds/rf_1',
      'GET /api/admin/pay/withdrawals?status=approved&userId=u1',
      'GET /api/admin/pay/withdrawals.csv',
      'GET /api/admin/pay/withdrawals/wd_1',
      'GET /api/admin/pay/actions?from=1&to=2&actor=admin',
      'GET /api/admin/pay/actions.csv?actor=admin',
    ]);
  });

  it('R75 一族：query 值以编码形态进下游 URL（`,`/`&`/`=` 不得走私）', async () => {
    const { controller, proxy } = make();
    await controller.adminPayActions(res, req('/api/admin/pay/actions', { query: { actor: 'a&b=c' } }));
    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'GET',
      '/api/admin/pay/actions?actor=a%26b%3Dc',
      null,
      res,
      {},
    );
  });

  it('POST 三条：body 逐字透传 + 三枚身份头转出 + 路径参数编码', async () => {
    const { controller, proxy } = make();
    const review = { action: 'approve', note: 'ok' };
    await controller.adminPayRefundReview('rf_1', review, res, req('/api/admin/pay/refunds/rf_1/review', { headers: { ...INJECTED } }));
    await controller.adminPayWithdrawReview('wd_1', review, res, req('/api/admin/pay/withdrawals/wd_1/review', { headers: { ...INJECTED } }));
    const confirm = { voucher: 'V-1', note: '已打款' };
    await controller.adminPayWithdrawConfirm('wd_2', confirm, res, req('/api/admin/pay/withdrawals/wd_2/confirm', { headers: { ...INJECTED } }));

    const calls = proxy.forwardToPaymentSvc.mock.calls as Array<[string, string, unknown, unknown, unknown]>;
    expect(calls[0]).toEqual([
      'POST',
      '/api/admin/pay/refunds/rf_1/review',
      review,
      res,
      { admin: true, adminActor: 'finance-01', adminRole: 'finance' },
    ]);
    expect(calls[1]![1]).toBe('/api/admin/pay/withdrawals/wd_1/review');
    expect(calls[1]![2]).toEqual(review);
    expect(calls[2]![1]).toBe('/api/admin/pay/withdrawals/wd_2/confirm');
    expect(calls[2]![2]).toEqual(confirm);
  });

  it('🔴 未知 query 键 ⇒ 400 借 10001「未知查询参数：<key>」，且**不发起**下游请求', async () => {
    const listCases: Array<[string, (c: GatewayController, r: unknown) => Promise<unknown>]> = [
      ['/api/admin/pay/orders', (c, r) => c.adminPayOrders(res, r)],
      ['/api/admin/pay/refunds', (c, r) => c.adminPayRefunds(res, r)],
      ['/api/admin/pay/withdrawals', (c, r) => c.adminPayWithdrawals(res, r)],
      ['/api/admin/pay/actions', (c, r) => c.adminPayActions(res, r)],
    ];
    for (const [path, invoke] of listCases) {
      const { controller, proxy } = make();
      const err = await catchErr(invoke(controller, req(path, { query: { smuggled: 'x' } })));
      expect(err, path).not.toBeNull();
      expect(err!.getStatus(), path).toBe(400);
      expect(err!.getResponse(), path).toMatchObject({ code: 10001, message: '未知查询参数：smuggled', data: null });
      expect(proxy.forwardToPaymentSvc, path).not.toHaveBeenCalled();
    }
  });
});

/**
 * `isRoomCode` 是「房间号形状」在全仓的唯一定义处（与 `RoomsService.generateCode` 一致）。
 * 边界直接钉在这里，防止有人把白名单放宽成「非空字符串」。
 */
describe('isRoomCode（R75：恰好 6 位 [0-9A-Z]）', () => {
  it('接受合法房间号', () => {
    for (const ok of ['ABC123', '000000', 'ZZZZZZ', 'A1B2C3', '999999']) {
      expect(isRoomCode(ok)).toBe(true);
    }
  });

  it('拒绝一切其它形状 —— 含 Express 解码后的走私值', () => {
    for (const bad of [
      'abc123', // 小写不在 generateCode 的字母表里
      'ABC12',
      'ABC1234',
      'ABC 123',
      'ABC-123',
      'ABC?seat=1', // ← N3：`ABC%3Fseat=1` 经 Express 解码后的**真实**入参
      'ABC/123', // ← `ABC%2F123`
      '../../etc', // ← `..%2F..%2Fetc`
      'A'.repeat(200),
      '',
      null,
      undefined,
      123456,
      {},
      ['ABC123'],
    ]) {
      expect(isRoomCode(bad)).toBe(false);
    }
  });
});

/**
 * 支付片 T13（规格 §2.4.1 / §2.7.2）：**玩家面**支付路由（九端点）——转发目标**必须**是
 * `forwardToPaymentSvc`（谁把它改回别的服务，这里红一次）；身份头 = `headersOf()` 的
 * 用户 JWT 产物（`X-User-Id` 注入；**无管理头**——真实链路里 `AdminAuthMiddleware` 先剥
 * 客户端伪造值，见下方真 app 认证组）。
 */
describe('GatewayController（支付 T13：玩家面钱包路由登记 + 转发形状）', () => {
  const res = {} as never;

  const make = () => {
    const proxy: { forwardToPaymentSvc: ReturnType<typeof vi.fn> } = {
      forwardToPaymentSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };

  const req = (originalUrl: string, over: Record<string, unknown> = {}) => ({
    originalUrl,
    headers: {},
    query: {},
    ...over,
  });

  const USER = { 'x-user-id': 'u1', 'x-trace-id': 't1' };

  it('九端点全转发 payment-service；目标 method/path/body 逐字', async () => {
    const { controller, proxy } = make();
    const body1 = { packageYuan: 6 };
    const body6 = { orderNo: 'pay_1', reason: '误购' };
    const body8 = { coins: 1000 };

    await controller.payOrdersMine(res, req('/api/pay/orders/mine', { query: { cursor: 'c', limit: '5' }, headers: { ...USER } }));
    await controller.payOrderDetail('pay_1', res, req('/api/pay/orders/pay_1', { headers: { ...USER } }));
    await controller.payCreateOrder(body1, res, req('/api/pay/orders', { headers: { ...USER } }));
    await controller.paySyncOrder('pay_1', res, req('/api/pay/orders/pay_1/sync', { headers: { ...USER } }));
    await controller.payWalletSummary(res, req('/api/pay/wallet/summary', { headers: { ...USER } }));
    await controller.payRefundApply(body6, res, req('/api/pay/refunds', { headers: { ...USER } }));
    await controller.payRefundsMine(res, req('/api/pay/refunds/mine', { query: { cursor: 'c' }, headers: { ...USER } }));
    await controller.payWithdrawApply(body8, res, req('/api/pay/withdrawals', { headers: { ...USER } }));
    await controller.payWithdrawalsMine(res, req('/api/pay/withdrawals/mine', { headers: { ...USER } }));

    const calls = proxy.forwardToPaymentSvc.mock.calls as Array<[string, string, unknown, unknown, unknown]>;
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /api/pay/orders/mine?cursor=c&limit=5',
      'GET /api/pay/orders/pay_1',
      'POST /api/pay/orders',
      'POST /api/pay/orders/pay_1/sync',
      'GET /api/pay/wallet/summary',
      'POST /api/pay/refunds',
      'GET /api/pay/refunds/mine?cursor=c',
      'POST /api/pay/withdrawals',
      'GET /api/pay/withdrawals/mine',
    ]);
    // body 逐字透传（1/6/8 三条 POST）
    expect(calls[2]![2]).toEqual(body1);
    expect(calls[5]![2]).toEqual(body6);
    expect(calls[7]![2]).toEqual(body8);
    // 身份头（验签产物转出）逐条在场；无管理头（深度相等 ⇒ 多一枚都会红）
    for (const call of calls) {
      expect(call[4]).toEqual({ userId: 'u1', traceId: 't1' });
    }
  });

  it('R75：`:orderNo` 编码后再拼下游 URL（详情与 sync 两处）', async () => {
    const { controller, proxy } = make();
    await controller.payOrderDetail('pay_1?seat=1', res, req('/api/pay/orders/pay_1%3Fseat%3D1'));
    await controller.paySyncOrder('pay_1/x', res, req('/api/pay/orders/pay_1%2Fx/sync'));

    const calls = proxy.forwardToPaymentSvc.mock.calls as Array<[string, string]>;
    expect(calls[0]![1]).toBe('/api/pay/orders/pay_1%3Fseat%3D1');
    expect(calls[1]![1]).toBe('/api/pay/orders/pay_1%2Fx/sync');
  });

  it('mine query 白名单 = 恰 cursor/limit（值编码；未知键**静默丢弃**——玩家面先例，不 400）', async () => {
    const { controller, proxy } = make();
    await controller.payOrdersMine(
      res,
      req('/api/pay/orders/mine', { query: { cursor: 'a&b=c', limit: '10', smuggle: '1' } }),
    );
    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'GET',
      '/api/pay/orders/mine?cursor=a%26b%3Dc&limit=10',
      null,
      res,
      {},
    );
  });

  it('无 query ⇒ 下游路径不带 `?`（不给下游伪造空参数）', async () => {
    const { controller, proxy } = make();
    await controller.payWithdrawalsMine(res, req('/api/pay/withdrawals/mine'));
    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'GET',
      '/api/pay/withdrawals/mine',
      null,
      res,
      {},
    );
  });
});

/**
 * 支付片 T13：玩家 pay 路由的**真 Nest 路由表**（与记录片/货币片/管理面同一条理由 ——
 * 直接调控制器测不到「路由真的挂在全局前缀 `api` 下」与「静态段先于参数段的注册次序」）；
 * 外加**认证链真 app**（真 `JwtMiddleware` + 真 `AdminAuthMiddleware`，照生产
 * `app.module.ts` 的顺序）：匿名 401 / 验签产物身份注入 / 伪造管理头被剥。
 *
 * ⚠️ 静态段次序的判别力：`/api/pay/orders/mine?cursor=…` 若被 `:orderNo` 抢走，转发路径
 * 会变成 `/api/pay/orders/mine`（详情端点静默丢弃 query）——**带 query 转发**这条断言
 * 因此能区分两种注册序（单一真源 = `gateway.controller.ts` 的声明顺序）。
 */
describe('GatewayController（支付 T13：真 Nest app —— 路由登记/静态段次序/404 + 认证链身份面）', () => {
  let app: INestApplication;
  let baseUrl: string;
  let authApp: INestApplication;
  let authBaseUrl: string;
  let calls: Array<[string, string]>;
  let authCalls: Array<[string, string, unknown, unknown, unknown]>;
  /** P0-3：reauth 的 user-service 转发记录（真中间件链）。 */
  let authUserCalls: Array<[string, string, unknown, unknown, unknown]>;
  let mockJwt: { verify: ReturnType<typeof vi.fn> };
  let mockSession: { isActive: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    // ① 路由表 app（无中间件——只判登记/次序/404）
    calls = [];
    const proxy = {
      forwardToPaymentSvc: vi.fn(async (m: string, path: string, _b: unknown, res: any) => {
        calls.push([m, path]);
        res.status(200).json({ code: 0, data: { path } });
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [{ provide: ProxyGateway, useValue: proxy }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api'); // 与 src/main.ts 一致
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // ② 认证链 app（真 JwtMiddleware + 真 AdminAuthMiddleware，顺序照 app.module.ts；
    //    限流中间件不在此组——它的三档桶在 http-rate-limit.test.ts 单独钉）
    authCalls = [];
    authUserCalls = [];
    const authProxy = {
      forwardToPaymentSvc: vi.fn(async (m: string, path: string, body: unknown, res: any, headers: unknown) => {
        authCalls.push([m, path, body, res, headers]);
        res.status(200).json({ code: 0, data: { path } });
      }),
      // P0-3：reauth 这一跳（真中间件链 ⇒ 证明 JwtMiddleware 不吞 Authorization）。
      forwardToUserSvc: vi.fn(async (m: string, path: string, body: unknown, res: any, headers: unknown) => {
        authUserCalls.push([m, path, body, res, headers]);
        res.status(200).json({ code: 0, data: { path } });
      }),
    };
    mockJwt = { verify: vi.fn() };
    mockSession = { isActive: vi.fn(async () => true) };

    @Module({
      controllers: [GatewayController],
      providers: [
        { provide: ProxyGateway, useValue: authProxy },
        { provide: JwtService, useValue: mockJwt },
        { provide: SessionGuard, useValue: mockSession },
      ],
    })
    class PlayerAuthProbeModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(JwtMiddleware, AdminAuthMiddleware).forRoutes('{/*splat}');
      }
    }

    const authModuleRef = await Test.createTestingModule({ imports: [PlayerAuthProbeModule] }).compile();
    authApp = authModuleRef.createNestApplication();
    authApp.setGlobalPrefix('api');
    await authApp.init();
    await authApp.listen(0, '127.0.0.1');
    authBaseUrl = `http://127.0.0.1:${(authApp.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await authApp?.close();
  });

  beforeEach(() => {
    calls.length = 0;
    authCalls.length = 0;
    vi.clearAllMocks();
    mockSession.isActive.mockResolvedValue(true);
  });

  it('九条玩家 pay 路由挂在 /api 下且方法/路径逐字进下游（404 即路由表缺条）', async () => {
    const authed = (path: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${path}`, { ...init, headers: { 'X-User-Id': 'alice', ...(init.headers ?? {}) } });
    const json = { 'Content-Type': 'application/json' };

    expect((await authed('/api/pay/orders/mine')).status).toBe(200);
    expect((await authed('/api/pay/orders/pay_1')).status).toBe(200);
    expect((await authed('/api/pay/orders', { method: 'POST', headers: json, body: '{}' })).status).toBe(200);
    expect((await authed('/api/pay/orders/pay_1/sync', { method: 'POST' })).status).toBe(200);
    expect((await authed('/api/pay/wallet/summary')).status).toBe(200);
    expect((await authed('/api/pay/refunds', { method: 'POST', headers: json, body: '{}' })).status).toBe(200);
    expect((await authed('/api/pay/refunds/mine')).status).toBe(200);
    expect((await authed('/api/pay/withdrawals', { method: 'POST', headers: json, body: '{}' })).status).toBe(200);
    expect((await authed('/api/pay/withdrawals/mine')).status).toBe(200);

    expect(calls).toEqual([
      ['GET', '/api/pay/orders/mine'],
      ['GET', '/api/pay/orders/pay_1'],
      ['POST', '/api/pay/orders'],
      ['POST', '/api/pay/orders/pay_1/sync'],
      ['GET', '/api/pay/wallet/summary'],
      ['POST', '/api/pay/refunds'],
      ['GET', '/api/pay/refunds/mine'],
      ['POST', '/api/pay/withdrawals'],
      ['GET', '/api/pay/withdrawals/mine'],
    ]);
  });

  it('🔴 静态段次序：`/orders/mine?cursor=…` 由 mine 处理器接走（query 保全转发；被 :orderNo 抢则静默丢弃）', async () => {
    await fetch(`${baseUrl}/api/pay/orders/mine?cursor=CUR1&limit=7`, {
      headers: { 'X-User-Id': 'alice' },
    });
    expect(calls.at(-1)).toEqual(['GET', '/api/pay/orders/mine?cursor=CUR1&limit=7']);

    // 正对照：参数段照常可命中（两类路由都活着）
    await fetch(`${baseUrl}/api/pay/orders/pay_9`, { headers: { 'X-User-Id': 'alice' } });
    expect(calls.at(-1)).toEqual(['GET', '/api/pay/orders/pay_9']);
  });

  it('未知 pay 子路径 ⇒ 404（不误落任何处理器；proxy 一次都不调）', async () => {
    const before = calls.length;
    for (const path of ['/api/pay/nope', '/api/pay/orders/pay_1/unknown', '/api/pay/wallet/summaryx']) {
      const res = await fetch(`${baseUrl}${path}`, { headers: { 'X-User-Id': 'alice' } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(calls.length).toBe(before);
  });

  it('认证链：匿名打玩家 pay 路由 ⇒ 401 + 10002（默认验签——不在公开白名单），零转发', async () => {
    for (const [path, init] of [
      ['/api/pay/wallet/summary', {}],
      ['/api/pay/orders/mine', {}],
      ['/api/pay/orders', { method: 'POST' }],
    ] as Array<[string, RequestInit]>) {
      const res = await fetch(`${authBaseUrl}${path}`, init);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
      expect(await res.json(), path).toMatchObject({ code: 10002, data: null });
    }
    expect(authCalls).toEqual([]);
  });

  it('认证链：有效令牌 ⇒ 身份注入（userId=sub）；客户端伪造 X-Admin 三枚被剥（转发头无管理枚）', async () => {
    mockJwt.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'j1' });

    const res = await fetch(`${authBaseUrl}/api/pay/orders/mine?cursor=c`, {
      headers: {
        Authorization: 'Bearer valid-token',
        'X-Admin': '1',
        'X-Admin-Actor': 'evil',
        'X-Admin-Roles': 'super_admin',
      },
    });
    expect(res.status).toBe(200);
    const call = authCalls.at(-1)!;
    expect(call[0]).toBe('GET');
    expect(call[1]).toBe('/api/pay/orders/mine?cursor=c');
    // 深度相等 ⇒ 「无管理头」是不变量：三枚（admin/adminActor/adminRole）多一枚都会红。
    // traceId 由 JwtMiddleware 兜底生成（本探测 app 没有全局 trace 中间件）。
    expect(call[4]).toEqual({ userId: 'u1', traceId: expect.any(String) });
  });

  it('P0-3 真中间件链：reauth 的 Bearer 与 withdrawals 的票据头都进入下游头（路径限定）', async () => {
    mockJwt.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'j1' });

    const reauthRes = await fetch(`${authBaseUrl}/api/auth/reauth`, {
      method: 'POST',
      headers: { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    expect(reauthRes.status).toBe(200);
    const reauthCall = authUserCalls.at(-1)!;
    expect(reauthCall[1]).toBe('/api/auth/reauth');
    expect(reauthCall[4]).toMatchObject({ authorization: 'Bearer access-1', userId: 'u1' });

    const withdrawRes = await fetch(`${authBaseUrl}/api/pay/withdrawals`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-1',
        'X-Reauth-Ticket': 't-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ coins: 100 }),
    });
    expect(withdrawRes.status).toBe(200);
    const withdrawCall = authCalls.at(-1)!;
    expect(withdrawCall[4]).toMatchObject({ reauthTicket: 't-1', userId: 'u1' });
    // 路径限定：提现这一跳不得顺带透传 Authorization。
    expect(withdrawCall[4]).not.toHaveProperty('authorization');
  });
});

/**
 * P0-3：提现再认证链的**网关转发边界**。
 *
 * 断点：`/api/auth/reauth` 用 `headersOf(req)` 转发但从不带 `Authorization` ⇒
 * user-service 的 `JwtAuthGuard` 拿不到 Bearer（401）；`POST /api/pay/withdrawals`
 * 的 `X-Reauth-Ticket` 也不在 `forward()` 的出站白名单里 ⇒ payment-service 永远
 * 看不到票据。两条开口都必须是**路径限定**的：不得把 Authorization 变成全局透传，
 * 也不得让票据头扩散到其它支付路径。
 */
describe('P0-3：再认证链的头转发（路径限定）', () => {
  const res = {} as never;
  const make = () => {
    const proxy = {
      forwardToUserSvc: vi.fn(async () => undefined),
      forwardToPaymentSvc: vi.fn(async () => undefined),
    };
    return { controller: new GatewayController(proxy as unknown as ProxyGateway), proxy };
  };
  const req = (originalUrl: string, headers: Record<string, string> = {}) => ({ originalUrl, headers });

  it('POST /api/auth/reauth 把客户端 Bearer 传给 user-service', async () => {
    const { controller, proxy } = make();

    await controller.reauth(
      { password: 'pw' },
      res,
      req('/api/auth/reauth', { authorization: 'Bearer access-1', 'x-user-id': 'u1' }),
    );

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'POST',
      '/api/auth/reauth',
      { password: 'pw' },
      res,
      expect.objectContaining({ authorization: 'Bearer access-1', userId: 'u1' }),
    );
  });

  it('其他已验签路径不转发 Authorization（即便客户端带了）', async () => {
    const { controller, proxy } = make();

    await controller.logout(
      { refreshToken: 'r' },
      res,
      req('/api/auth/logout', { authorization: 'Bearer access-1', 'x-token-jti': 'jti-1' }),
    );

    const headers = (
      proxy.forwardToUserSvc.mock.calls as unknown as Array<
        [string, string, unknown, unknown, Record<string, unknown>]
      >
    )[0]![4];
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).toMatchObject({ tokenJti: 'jti-1' });
  });

  it('POST /api/pay/withdrawals 把 x-reauth-ticket 传给 payment-service', async () => {
    const { controller, proxy } = make();

    await controller.payWithdrawApply(
      { coins: 100 },
      res,
      req('/api/pay/withdrawals', { 'x-reauth-ticket': 't-1', 'x-user-id': 'u1' }),
    );

    expect(proxy.forwardToPaymentSvc).toHaveBeenCalledWith(
      'POST',
      '/api/pay/withdrawals',
      { coins: 100 },
      res,
      expect.objectContaining({ reauthTicket: 't-1', userId: 'u1' }),
    );
  });

  it('其他支付路径不转发 x-reauth-ticket', async () => {
    const { controller, proxy } = make();

    await controller.payWithdrawalsMine(
      res,
      req('/api/pay/withdrawals/mine', { 'x-reauth-ticket': 't-1', 'x-user-id': 'u1' }),
    );

    const headers = (
      proxy.forwardToPaymentSvc.mock.calls as unknown as Array<
        [string, string, unknown, unknown, Record<string, unknown>]
      >
    )[0]![4];
    expect(headers).not.toHaveProperty('reauthTicket');
    expect(headers).toMatchObject({ userId: 'u1' });
  });
});
