import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { AdminAuthMiddleware } from '../src/auth/admin.middleware';

/**
 * 契约来自片⑦设计 D6② / 规格 §2.6（T9 brief 逐条对应）：
 *  - ① **先剥**客户端伪造的 `X-Admin`（与 `X-User-Id` 同族纪律：身份头只可能来自验证结果）；
 *  - ② 豁免**恰好一条**：`POST /api/admin/login` 是入口本身、按定义没有令牌
 *    （「顺手多豁免」就是那个洞 —— 近邻路径必须 401）；
 *  - ③ 其余 `/api/admin/*`：缺令牌 ⇒ 401 `UNAUTHENTICATED`(10002)；坏令牌 ⇒ 401 `TOKEN_INVALID`(10005)，
 *    且失败**不注入** `X-Admin`；
 *  - ④ 有效管理令牌（`aud='ftl-admin'`）⇒ 注入 `X-Admin: 1` + 挂 `req.adminTokenFp`
 *    （sha256 前 16 位 —— T10 写桶限流的键）；
 *  - ⑤ 玩家令牌验不过 —— `aud` 是管理/玩家两族令牌的隔离线，不是「密钥不同」的副作用；
 *  - ⑥ 验签密钥链与 config-service 的**签发侧逐字同链**：`ADMIN_JWT_SECRET || JWT_SECRET || dev 兜底`
 *    （C4-1：两侧不同钥 ⇒ 登录 200 而此后每个管理请求 401，日志里看不出为什么）。
 *    ⚠️ `||` 非 `??`（裁决 2026-10-01，T9 修复轮）：compose 的 `${ADMIN_JWT_SECRET:-}` 渲染**空串**
 *    （不是「未设」），空串必须**回落** `JWT_SECRET` —— jsonwebtoken 对空密钥硬拒
 *    （`sign`/`verify` 都 throw）⇒ `??` 链在 dev/CI 栈 = 登录 500。空串用例见「密钥链」块。
 *
 * ③ T5 在文件末尾扩了三组（规格 §2.10 处理序 0–7 逐字）：归一射程 = 仅 policy（尾斜杠 N1 负例）·
 * 剥**四枚**伪造头 · claims 校验（⚙️4）· policy P1–P9 命中与 403 不注入。既有用例全部保留
 * （`signAdmin` 默认载荷改为带 `sub/username/role` 的合法身份 —— 旧形态在新规矩下是 401）。
 *
 * ⚠️ `new AdminAuthMiddleware()` 在**构造期**读 env（照 config-service `AdminAuthService` 的
 * 「每次现读」是每次**使用**读；中间件这里是构造期一次 —— 因此切 env 的用例必须**重新构造**）。
 */
describe('AdminAuthMiddleware', () => {
  const ADMIN_SECRET = 'test-admin-secret-do-not-use-in-prod';
  const PLAYER_SECRET = 'test-player-secret-do-not-use-in-prod';

  const ORIGINAL_ADMIN = process.env.ADMIN_JWT_SECRET;
  const ORIGINAL_JWT = process.env.JWT_SECRET;

  let middleware: AdminAuthMiddleware;

  const makeReq = (over: Record<string, unknown> = {}) => ({
    originalUrl: '/api/admin/config',
    url: '/api/admin/config',
    method: 'GET',
    headers: {} as Record<string, unknown>,
    ...over,
  });

  /** ③ T5 起 claims 必填（⚙️4）：默认带一组合法身份（`sub`/`username`/`role`）—— 照
   * config-service `AdminAuthService.signToken()` 的形态（`{sub:String(id), username, role}`）。 */
  const IDENTITY = { sub: '1', username: 'admin', role: 'super_admin' } as const;
  const signAdmin = (secret: string, payload: Record<string, unknown> = { ...IDENTITY }) =>
    new JwtService({ secret }).sign(payload, { audience: 'ftl-admin', expiresIn: 7200 });

  /** 玩家令牌的**真实形态**：payload 有身份字段、**不带 `aud`**（user-service 签发时不设 audience）。 */
  const signPlayer = (secret: string) =>
    new JwtService({ secret }).sign(
      { sub: 'user-123', phone: '13800138000', typ: 'access', jti: 'jti-1' },
      { expiresIn: '2h' },
    );

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** 把 `use()` 的 rejection 收成异常对象，便于断言状态码与信封体。默认用 beforeEach 的实例。 */
  const useAndCatch = async (req: unknown, mw: AdminAuthMiddleware = middleware) => {
    try {
      await mw.use(req as never, {} as never, vi.fn());
      return null;
    } catch (err) {
      return err as { getStatus: () => number; getResponse: () => unknown };
    }
  };

  beforeEach(() => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    process.env.JWT_SECRET = PLAYER_SECRET;
    middleware = new AdminAuthMiddleware();
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.ADMIN_JWT_SECRET;
    else process.env.ADMIN_JWT_SECRET = ORIGINAL_ADMIN;
    if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT;
  });

  describe('剥与注（顺序即契约：先剥后注、失败不注）', () => {
    it('🔴 先剥伪造 X-Admin：无令牌 + X-Admin:1 ⇒ 401 且该头已不在（剥发生在任何失败路径之前）', async () => {
      const req = makeReq({ headers: { 'x-admin': '1' } });
      const next = vi.fn();

      const err = await useAndCatch(req);

      expect(err).not.toBeNull();
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10002, data: null });
      expect(next).not.toHaveBeenCalled();
      // 若「剥」发生在验真之后，失败路径上这个伪造头会原样留在 req 上（下游就能据此骗过 XAdminGuard）
      expect(req.headers['x-admin']).toBeUndefined();
    });

    it('🔴 坏令牌 + 伪造 X-Admin:1 ⇒ 401 TOKEN_INVALID 且不注入', async () => {
      const req = makeReq({ headers: { 'x-admin': '1', ...bearer('garbage') } });

      const err = await useAndCatch(req);

      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005, data: null });
      expect(req.headers['x-admin']).toBeUndefined();
    });

    it('非 admin 路径也剥（伪造头不得借道本中间件管辖之外的路径漏到下游）', async () => {
      const req = makeReq({
        originalUrl: '/api/rooms',
        url: '/api/rooms',
        headers: { 'x-admin': '1' },
      });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);

      expect(next).toHaveBeenCalled();
      expect(req.headers['x-admin']).toBeUndefined();
    });

    it('成功注入 X-Admin 恰好 "1"，且覆盖客户端自带值（下游只可能看到注入的那份）', async () => {
      const req = makeReq({ headers: { 'x-admin': 'evil', ...bearer(signAdmin(ADMIN_SECRET)) } });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);

      expect(next).toHaveBeenCalled();
      expect(req.headers['x-admin']).toBe('1');
    });

    it('成功挂出 adminTokenFp = sha256(token) 前 16 位（T10 写桶限流的键）', async () => {
      const token = signAdmin(ADMIN_SECRET);
      const req = makeReq({ headers: bearer(token) });

      await middleware.use(req as never, {} as never, vi.fn());

      const fp = (req as { adminTokenFp?: string }).adminTokenFp;
      expect(fp).toBe(createHash('sha256').update(token).digest('hex').slice(0, 16));
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });

    it('失败路径不挂 adminTokenFp（限流键不得凭空产生）', async () => {
      const req = makeReq({ headers: bearer('garbage') });
      await useAndCatch(req);
      expect((req as { adminTokenFp?: string }).adminTokenFp).toBeUndefined();
    });
  });

  describe('豁免恰好一条：POST /api/admin/login（D6②）', () => {
    it('POST /api/admin/login 无令牌放行（入口本身），且不注入任何东西', async () => {
      const req = makeReq({
        originalUrl: '/api/admin/login',
        url: '/api/admin/login',
        method: 'POST',
        headers: {},
      });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);

      expect(next).toHaveBeenCalled();
      expect(req.headers['x-admin']).toBeUndefined();
      expect((req as { adminTokenFp?: string }).adminTokenFp).toBeUndefined();
    });

    it('带查询串的 login 也认（requestPath 是真源）', async () => {
      const req = makeReq({
        originalUrl: '/api/admin/login?next=/admin/',
        url: '/api/admin/login?next=/admin/',
        method: 'POST',
      });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);

      expect(next).toHaveBeenCalled();
    });

    it('近邻路径**不得**被顺手豁免：/api/admin/loginx 与 /api/admin/login/step ⇒ 401', async () => {
      for (const path of ['/api/admin/loginx', '/api/admin/login/step']) {
        const err = await useAndCatch(makeReq({ originalUrl: path, url: path, method: 'POST' }));
        expect(err, `${path} 不应被豁免`).not.toBeNull();
        expect(err!.getStatus()).toBe(401);
        expect(err!.getResponse()).toMatchObject({ code: 10002 });
      }
    });

    it('前缀根本身（/api/admin）也是受管路径：无令牌 ⇒ 401', async () => {
      const err = await useAndCatch(makeReq({ originalUrl: '/api/admin', url: '/api/admin' }));
      expect(err).not.toBeNull();
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10002 });
    });
  });

  describe('令牌校验：缺 / 坏 / 过期', () => {
    it('admin 路径无 Authorization ⇒ 401 UNAUTHENTICATED（缺）', async () => {
      const err = await useAndCatch(makeReq());
      expect(err).not.toBeNull();
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({
        code: 10002,
        message: 'Missing admin token',
        data: null,
      });
    });

    it('非 Bearer 形态的 Authorization ⇒ 401 UNAUTHENTICATED（缺）', async () => {
      const err = await useAndCatch(makeReq({ headers: { authorization: 'Token xyz' } }));
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10002 });
    });

    it('坏令牌 ⇒ 401 TOKEN_INVALID', async () => {
      const err = await useAndCatch(makeReq({ headers: bearer('not-a-jwt') }));
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005, data: null });
    });

    it('过期管理令牌 ⇒ 401 TOKEN_INVALID（单一边界：过期与伪造对管理员是同一种「请重新登录」）', async () => {
      const expired = new JwtService({ secret: ADMIN_SECRET }).sign(
        {},
        { audience: 'ftl-admin', expiresIn: -10 },
      );
      const err = await useAndCatch(makeReq({ headers: bearer(expired) }));
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005 });
    });
  });

  describe('aud 是隔离线（玩家令牌一律不认）', () => {
    it('同钥但无 aud 的玩家形态令牌 ⇒ 401（不是「密钥不同」的副作用）', async () => {
      const err = await useAndCatch(makeReq({ headers: bearer(signPlayer(ADMIN_SECRET)) }));
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005 });
    });

    it('aud=ftl-player ⇒ 401（错的 aud 也验不过）', async () => {
      const wrongAud = new JwtService({ secret: ADMIN_SECRET }).sign(
        {},
        { audience: 'ftl-player', expiresIn: 7200 },
      );
      const err = await useAndCatch(makeReq({ headers: bearer(wrongAud) }));
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005 });
    });

    it('玩家密钥签的「管理令牌」（aud 对、钥不对）⇒ 401（密钥链隔离）', async () => {
      const err = await useAndCatch(makeReq({ headers: bearer(signAdmin(PLAYER_SECRET)) }));
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005 });
    });
  });

  describe('密钥链与签发侧逐字同链（C4-1）', () => {
    it('ADMIN_JWT_SECRET 设了 ⇒ 用它验签（JWT_SECRET 管不着）', async () => {
      // beforeEach 里两个都设了 —— 正对照 + 负对照成对出现才算钉住优先级
      const ok = makeReq({ headers: bearer(signAdmin(ADMIN_SECRET)) });
      const next = vi.fn();
      await middleware.use(ok as never, {} as never, next);
      expect(next).toHaveBeenCalled();

      const err = await useAndCatch(makeReq({ headers: bearer(signAdmin(PLAYER_SECRET)) }));
      expect(err!.getStatus()).toBe(401);
    });

    it('未设 ADMIN_JWT_SECRET ⇒ 回落 JWT_SECRET（与 config-service 的 || 链同形；空串=未设）', async () => {
      delete process.env.ADMIN_JWT_SECRET;
      const fallbackMw = new AdminAuthMiddleware();

      const req = makeReq({ headers: bearer(signAdmin(PLAYER_SECRET)) });
      const next = vi.fn();
      await fallbackMw.use(req as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    });

    it('空串 = 未设 ⇒ 回落 JWT_SECRET（compose 的 `${ADMIN_JWT_SECRET:-}` 渲染成 ""；裁决 2026-10-01：与 ADMIN_PASSWORD、CONFIG_SYNC_* 同一纪律）', async () => {
      // 背景（T9 修复轮，两处实拍证据见 task-9-report.md §6/修复轮）：`??` 链把 '' 按**值**消费
      // ⇒ 密钥 = '' ⇒ jsonwebtoken **硬拒**（verify 抛 "secret or public key must be provided"、
      // 签发侧 sign 抛 "secretOrPrivateKey must have a value" = dev/CI 登录 500）。
      // 判别性断言（旧 `??` 形态下这条必红）：空串 ⇒ 回落 JWT_SECRET ⇒ 用它签的令牌被验过。
      process.env.ADMIN_JWT_SECRET = '';
      const emptyMw = new AdminAuthMiddleware();

      // sign→verify 端到端：签发侧同链（空串 ⇒ 回落 `JWT_SECRET`=PLAYER_SECRET）签出的令牌
      const req = makeReq({ headers: bearer(signAdmin(PLAYER_SECRET)) });
      const next = vi.fn();
      await emptyMw.use(req as never, {} as never, next);

      expect(next).toHaveBeenCalled();
      expect(req.headers['x-admin']).toBe('1');
    });
  });

  describe('管辖范围（前缀语义的边界）', () => {
    it('非 admin 路径 ⇒ 直接放行（本中间件不管，哪怕 Authorization 是垃圾）', async () => {
      const req = makeReq({
        originalUrl: '/api/rooms',
        url: '/api/rooms',
        headers: bearer('garbage'),
      });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);

      expect(next).toHaveBeenCalled();
    });

    it('前缀边界之外：/api/adminx 与 /api/administrator 不归本中间件管（放行到下一层去拒）', async () => {
      for (const path of ['/api/adminx', '/api/administrator']) {
        const req = makeReq({ originalUrl: path, url: path });
        const next = vi.fn();
        await middleware.use(req as never, {} as never, next);
        expect(next, `${path} 不应被前缀误伤`).toHaveBeenCalled();
      }
    });

    /**
     * 货币片 T7（§2.13 表后两行）：新增的两族 admin 路径**必须**在本中间件管辖面内 ——
     * 前缀语义下免改即覆盖；这里钉住覆盖关系本身（若哪天 `isAdminPath` 被收窄成枚举
     * 而漏加这两族，网关会把它们当玩家路径 ⇒ 本用例先红，而不是线上「新管理端点 401
     * 而登录一切正常」）。
     */
    it('货币片 T7：admin/wallet/* 与 admin/users/lookup 都在管辖面内（无令牌 ⇒ 401，不放行）', async () => {
      const cases: Array<[string, string]> = [
        ['GET', '/api/admin/wallet/accounts/42'],
        ['POST', '/api/admin/wallet/adjust'],
        ['GET', '/api/admin/users/lookup'],
      ];
      for (const [method, path] of cases) {
        const req = makeReq({ originalUrl: path, url: path, method });
        const next = vi.fn();

        const err = await useAndCatch(req);

        expect(err, `${path} 必须被本中间件管辖（前缀语义）`).not.toBeNull();
        expect(err!.getStatus(), path).toBe(401);
        expect(next, path).not.toHaveBeenCalled();
      }
    });
  });

  /**
   * ③ T5（规格 §2.10 处理序 0–7）：本片安全承重面。
   *
   *  - **第 0 步归一**：射程 = 仅第 6 步 policy 匹配。豁免（第 3 步）与 `isAdminPath`（第 2 步）
   *    一律用**原值** ⇒ `POST /api/admin/login/`（尾斜杠）**不落豁免** ⇒ 401 fail-closed（N1）。
   *    （N1 的机制：若归一射程含豁免，尾斜杠登录变体将直达登录处理器而失败桶不计数 ——
   *    scrypt 的唯一防爆破控制被旁路。）
   *  - **第 1 步剥四枚**：`x-admin`/`x-admin-actor`/`x-admin-roles`/`x-client-ip`，所有路径、
   *    任何判断**之前**（失败路径上伪造头也不得残留）。
   *  - **第 5 步 claims**：`sub`/`username` 非空 string、`role ∈` 四值；坏 ⇒ 401 `10005`。
   *  - **第 6 步 policy**：P1–P9 按序首中（表在 `admin-policy.ts` / `admin-policy.test.ts`）；
   *    命中但角色不足 ⇒ 403 `10003` 且**不注入任何下游头**。
   *  - **第 7 步注入三枚**：`X-Admin:'1'` + `X-Admin-Actor:<username>` + `X-Admin-Roles:<role>`。
   */
  describe('③ T5：处理序 0–7（归一射程 / 剥四 / claims / policy / 注入三）', () => {
    /**
     * 合法令牌请求。⚠️ 第二参 `identity` 是**整体载荷**（给了就用它，不与默认值合并）——
     * 「缺 sub / 缺 username」这类负例必须能真的缺字段（合并语义会让缺字段被默认值补回来，
     * 负例静默变正例）。
     */
    const validReq = (over: Record<string, unknown> = {}, identity: Record<string, unknown> | null = null) =>
      makeReq({
        originalUrl: '/api/admin/config',
        url: '/api/admin/config',
        method: 'GET',
        headers: bearer(signAdmin(ADMIN_SECRET, identity ?? { ...IDENTITY })),
        ...over,
      });

    describe('第 0 步：归一射程 = 仅 policy（豁免与管辖判定用原值）', () => {
      it('🔴 POST /api/admin/login/（尾斜杠）**不落豁免** ⇒ 401 且不达处理器（豁免用原值）', async () => {
        const req = makeReq({
          originalUrl: '/api/admin/login/',
          url: '/api/admin/login/',
          method: 'POST',
          headers: {},
        });
        const next = vi.fn();

        const err = await useAndCatch(req);

        expect(err).not.toBeNull();
        expect(err!.getStatus()).toBe(401);
        expect(err!.getResponse()).toMatchObject({ code: 10002, message: 'Missing admin token' });
        expect(next).not.toHaveBeenCalled();
      });

      it('带令牌的 POST /api/admin/login/ ⇒ 归一后命中 login 路径但非注册写路由 ⇒ P9 403（两态都 fail-closed）', async () => {
        const req = validReq({ originalUrl: '/api/admin/login/', url: '/api/admin/login/', method: 'POST' });
        const next = vi.fn();

        const err = await useAndCatch(req);

        expect(err).not.toBeNull();
        expect(err!.getStatus()).toBe(403);
        expect(err!.getResponse()).toMatchObject({ code: 10003, data: null });
        expect(next).not.toHaveBeenCalled();
        expect(req.headers['x-admin']).toBeUndefined();
      });

      it('尾斜杠 GET /api/admin/accounts/ + 非超管 ⇒ 403（归一后中 P1，**不落 P8 越权**）', async () => {
        for (const role of ['finance', 'operator', 'viewer']) {
          const req = validReq(
            { originalUrl: '/api/admin/accounts/', url: '/api/admin/accounts/' },
            { ...IDENTITY, role },
          );
          const next = vi.fn();

          const err = await useAndCatch(req);

          expect(err, role).not.toBeNull();
          expect(err!.getStatus(), role).toBe(403);
          expect(err!.getResponse(), role).toMatchObject({ code: 10003 });
          expect(next, role).not.toHaveBeenCalled();
        }
        // 正对照：超管在同一条路径上放行（归一命中 P1 而不是被 404/拒绝吞掉）
        const ok = validReq({ originalUrl: '/api/admin/accounts/', url: '/api/admin/accounts/' });
        const next = vi.fn();
        await middleware.use(ok as never, {} as never, next);
        expect(next).toHaveBeenCalled();
      });
    });

    describe('第 1 步：剥四枚（所有路径、任何判断之前）', () => {
      const FORGED = {
        'x-admin': '1',
        'x-admin-actor': 'evil',
        'x-admin-roles': 'super_admin',
        'x-client-ip': '6.6.6.6',
      };

      it('🔴 无令牌 + 四枚伪造头 ⇒ 401 且四枚已全部剥掉（失败路径不残留）', async () => {
        const req = makeReq({ headers: { ...FORGED } });

        const err = await useAndCatch(req);

        expect(err).not.toBeNull();
        expect(err!.getStatus()).toBe(401);
        for (const name of Object.keys(FORGED)) {
          expect(req.headers[name], name).toBeUndefined();
        }
        expect((req as { adminTokenFp?: string }).adminTokenFp).toBeUndefined();
      });

      it('非 admin 路径也剥四枚（不得借道管辖之外的路径漏到下游）', async () => {
        const req = makeReq({ originalUrl: '/api/rooms', url: '/api/rooms', headers: { ...FORGED } });
        const next = vi.fn();

        await middleware.use(req as never, {} as never, next);

        expect(next).toHaveBeenCalled();
        for (const name of Object.keys(FORGED)) {
          expect(req.headers[name], name).toBeUndefined();
        }
      });

      it('policy 拒绝（403）时四枚伪造头同样已剥、且**不注入任何下游头**', async () => {
        const req = validReq({
          originalUrl: '/api/admin/accounts',
          url: '/api/admin/accounts',
          headers: { ...FORGED, ...bearer(signAdmin(ADMIN_SECRET, { ...IDENTITY, role: 'viewer' })) },
        });

        const err = await useAndCatch(req);

        expect(err).not.toBeNull();
        expect(err!.getStatus()).toBe(403);
        expect(req.headers['x-admin']).toBeUndefined();
        expect(req.headers['x-admin-actor']).toBeUndefined();
        expect(req.headers['x-admin-roles']).toBeUndefined();
        expect(req.headers['x-client-ip']).toBeUndefined();
        expect((req as { adminTokenFp?: string }).adminTokenFp).toBeUndefined();
      });

      it('验真通过 ⇒ 覆盖伪造的三枚：注入 x-admin=1 + actor=username + roles=role', async () => {
        const req = validReq({
          headers: {
            'x-admin': 'evil',
            'x-admin-actor': 'evil',
            'x-admin-roles': 'evil',
            ...bearer(signAdmin(ADMIN_SECRET, { sub: '7', username: 'ops1', role: 'operator' })),
          },
        });
        const next = vi.fn();

        await middleware.use(req as never, {} as never, next);

        expect(next).toHaveBeenCalled();
        expect(req.headers['x-admin']).toBe('1');
        expect(req.headers['x-admin-actor']).toBe('ops1'); // username 原样（claims 值）
        expect(req.headers['x-admin-roles']).toBe('operator');
        // x-client-ip 不由本中间件注入（只有登录路径的 headersOf 产出）—— 伪造值保持**缺席**
        expect(req.headers['x-client-ip']).toBeUndefined();
      });
    });

    describe('第 5 步：claims 校验（⚙️4：sub/username 非空 string、role ∈ 四值）', () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['缺 sub', { username: 'admin', role: 'super_admin' }],
        ['sub 为空串', { sub: '', username: 'admin', role: 'super_admin' }],
        ['sub 非字符串', { sub: 1, username: 'admin', role: 'super_admin' }],
        ['缺 username', { sub: '1', role: 'super_admin' }],
        ['username 为空串', { sub: '1', username: '', role: 'super_admin' }],
        ['缺 role', { sub: '1', username: 'admin' }],
        ['role 不在四值内（root）', { sub: '1', username: 'admin', role: 'root' }],
        ['role 大小写不符（Super_Admin）', { sub: '1', username: 'admin', role: 'Super_Admin' }],
      ];

      it('缺/坏 claims ⇒ 401 10005（与验签失败同一句话；旧令牌全员重登是预期）', async () => {
        for (const [label, identity] of cases) {
          const req = validReq({}, identity);
          const next = vi.fn();

          const err = await useAndCatch(req);

          expect(err, label).not.toBeNull();
          expect(err!.getStatus(), label).toBe(401);
          expect(err!.getResponse(), label).toMatchObject({
            code: 10005,
            message: 'Invalid or expired admin token',
            data: null,
          });
          expect(next, label).not.toHaveBeenCalled();
          expect(req.headers['x-admin'], label).toBeUndefined();
        }
      });

      it('正对照：四值 role 各放行一条 GET（claims 校验不误伤任一合法角色）', async () => {
        for (const role of ['super_admin', 'finance', 'operator', 'viewer']) {
          const req = validReq({}, { ...IDENTITY, role });
          const next = vi.fn();
          await middleware.use(req as never, {} as never, next);
          expect(next, role).toHaveBeenCalled();
          expect(req.headers['x-admin-roles'], role).toBe(role);
        }
      });
    });

    /**
     * ⚙️20（终审 F1，Critical 真栈实证）：**admin 路径识别 = 大小写不敏感**。
     *
     * 机制（修复前）：Express/Nest 路由匹配**大小写不敏感**（`/API/admin/*` 命中同一路由），
     * 而网关的 `isAdminPath` 是大小写敏感 ⇒ 持**任意玩家令牌**打 `POST /API/admin/login`：
     * 玩家验签过（被当玩家路径）、本中间件跳过、登录失败桶不命中 ⇒ 请求直通 config-service
     * 的**豁免登录路由**（下游唯一无 `XAdminGuard` 处）⇒ 口令比较真实执行而失败桶不计数
     * —— 本片唯一防爆破/内存控制（scrypt）被旁路。
     *
     * 修复语义（⚙️20 逐字）：`isAdminPath` 判定大小写不敏感（归一上收于该层）；
     * **豁免判定与尾斜杠语义不变（原值精确，N1 不回归）** ⇒ 变体落「admin 路径但非豁免」
     * ⇒ 无有效管理令牌一律 401 fail-closed。
     */
    describe('⚙️20（终审 F1）：admin 路径识别大小写不敏感', () => {
      const VARIANTS_LOGIN = ['/API/admin/login', '/Api/Admin/Login', '/API/ADMIN/LOGIN', '/API/admin/login/'];

      it('🔴 登录大小写变体（无令牌）⇒ 401 且为**中间件级**文案（修复前：变体被当非 admin 路径直接放行 next）', async () => {
        for (const path of VARIANTS_LOGIN) {
          const req = makeReq({ originalUrl: path, url: path, method: 'POST', headers: {} });
          const next = vi.fn();

          const err = await useAndCatch(req);

          expect(err, path).not.toBeNull();
          expect(err!.getStatus(), path).toBe(401);
          // 「Missing admin token」= 中间件级，与处理器级「用户名或口令错误」可区分 ——
          // 后者意味着请求真的到了登录处理器（F1 的读数形态）。
          expect(err!.getResponse(), path).toMatchObject({
            code: 10002,
            message: 'Missing admin token',
            data: null,
          });
          expect(next, path).not.toHaveBeenCalled();
        }
      });

      it('🔴 玩家令牌 + 变体 ⇒ 401 10005（修复前：作为玩家路径直通 —— JwtMiddleware 放行玩家令牌、本中间件跳过）', async () => {
        const cases: Array<[string, string]> = [
          ['POST', '/API/admin/login'],
          ['GET', '/Api/Admin/Config'],
          ['GET', '/api/ADMIN/ACCOUNTS'],
        ];
        for (const [method, path] of cases) {
          const req = makeReq({
            originalUrl: path,
            url: path,
            method,
            headers: bearer(signPlayer(PLAYER_SECRET)),
          });
          const next = vi.fn();

          const err = await useAndCatch(req);

          expect(err, `${method} ${path}`).not.toBeNull();
          expect(err!.getStatus(), `${method} ${path}`).toBe(401);
          expect(err!.getResponse(), `${method} ${path}`).toMatchObject({ code: 10005, data: null });
          expect(next, `${method} ${path}`).not.toHaveBeenCalled();
        }
      });

      it('豁免判定仍**原值精确**：带有效管理令牌的 POST 变体 ⇒ P9 403（不落豁免、不达处理器、不注入）', async () => {
        for (const path of ['/API/admin/login', '/Api/Admin/Login']) {
          const req = makeReq({
            originalUrl: path,
            url: path,
            method: 'POST',
            headers: bearer(signAdmin(ADMIN_SECRET)),
          });
          const next = vi.fn();

          const err = await useAndCatch(req);

          expect(err, path).not.toBeNull();
          expect(err!.getStatus(), path).toBe(403);
          expect(err!.getResponse(), path).toMatchObject({ code: 10003, data: null });
          expect(next, path).not.toHaveBeenCalled();
          expect(req.headers['x-admin'], path).toBeUndefined();
        }
      });

      it('正对照：混大小写 GET + 有效管理令牌 ⇒ 按管理鉴权放行（识别归一只改「谁是 admin 路径」，鉴权矩阵本身不变）', async () => {
        const req = makeReq({
          originalUrl: '/Api/Admin/Config',
          url: '/Api/Admin/Config',
          method: 'GET',
          headers: bearer(signAdmin(ADMIN_SECRET)),
        });
        const next = vi.fn();

        await middleware.use(req as never, {} as never, next);

        expect(next).toHaveBeenCalled();
        expect(req.headers['x-admin']).toBe('1');
        expect(req.headers['x-admin-roles']).toBe('super_admin');
      });

      it('边界不回归：/api/adminx 与 /api/administrator 的**大小写变体**同样不归本中间件管', async () => {
        for (const path of ['/API/adminx', '/Api/Administrator']) {
          const req = makeReq({ originalUrl: path, url: path });
          const next = vi.fn();
          await middleware.use(req as never, {} as never, next);
          expect(next, path).toHaveBeenCalled();
        }
      });
    });

    describe('第 6 步：policy（P 表命中 ⇒ 角色不足 403 10003；不注入任何下游头）', () => {
      const denyCases: Array<[string, string, string]> = [
        ['GET', '/api/admin/accounts', 'viewer'], // P1
        ['GET', '/api/admin/accounts', 'finance'], // P1
        ['POST', '/api/admin/accounts', 'viewer'], // P2
        ['PATCH', '/api/admin/accounts/42', 'operator'], // P3
        ['PUT', '/api/admin/config/room.friendRoomEnabled', 'finance'], // P4
        ['PUT', '/api/admin/config/room.friendRoomEnabled', 'viewer'], // P4
        ['POST', '/api/admin/wallet/adjust', 'viewer'], // P5
        ['POST', '/api/admin/wallet/reverse', 'operator'], // P6
        ['POST', '/api/admin/wallet/reconcile/run', 'viewer'], // P7
        ['POST', '/api/admin/anything-unregistered', 'super_admin'], // P9（未登记写路径，超管也拒）
        ['DELETE', '/api/admin/config/x', 'super_admin'], // P9
      ];

      it('命中规则但角色不足 / 未登记非 GET ⇒ 403 10003，且不注入 x-admin/actor/roles、不挂 fp', async () => {
        for (const [method, path, role] of denyCases) {
          const req = validReq({ originalUrl: path, url: path, method }, { ...IDENTITY, role });
          const next = vi.fn();

          const err = await useAndCatch(req);

          expect(err, `${method} ${path} ${role}`).not.toBeNull();
          expect(err!.getStatus(), `${method} ${path} ${role}`).toBe(403);
          expect(err!.getResponse(), `${method} ${path} ${role}`).toMatchObject({ code: 10003, data: null });
          expect(next, `${method} ${path} ${role}`).not.toHaveBeenCalled();
          expect(req.headers['x-admin'], `${method} ${path} ${role}`).toBeUndefined();
          expect(req.headers['x-admin-actor'], `${method} ${path} ${role}`).toBeUndefined();
          expect((req as { adminTokenFp?: string }).adminTokenFp, `${method} ${path} ${role}`).toBeUndefined();
        }
      });

      const allowCases: Array<[string, string, string]> = [
        ['GET', '/api/admin/accounts', 'super_admin'], // P1
        ['POST', '/api/admin/accounts', 'super_admin'], // P2
        ['PATCH', '/api/admin/accounts/42', 'super_admin'], // P3
        ['PUT', '/api/admin/config/room.friendRoomEnabled', 'operator'], // P4
        ['POST', '/api/admin/wallet/adjust', 'finance'], // P5
        ['POST', '/api/admin/wallet/reverse', 'super_admin'], // P6
        ['POST', '/api/admin/wallet/reconcile/run', 'finance'], // P7
        ['GET', '/api/admin/config', 'viewer'], // P8（任意已认证角色）
        ['GET', '/api/admin/accounts/changes.csv', 'viewer'], // P8（含 .csv）
        ['GET', '/api/admin/wallet/ops', 'operator'], // P8
        ['GET', '/api/admin/users/abc-123', 'finance'], // P8
      ];

      it('正对照（四角色 × 代表端点）：命中且角色足够 ⇒ 放行 + 注入三枚', async () => {
        for (const [method, path, role] of allowCases) {
          const req = validReq({ originalUrl: path, url: path, method }, { sub: '9', username: 'u9', role });
          const next = vi.fn();

          await middleware.use(req as never, {} as never, next);

          expect(next, `${method} ${path} ${role}`).toHaveBeenCalled();
          expect(req.headers['x-admin'], `${method} ${path} ${role}`).toBe('1');
          expect(req.headers['x-admin-actor'], `${method} ${path} ${role}`).toBe('u9');
          expect(req.headers['x-admin-roles'], `${method} ${path} ${role}`).toBe(role);
        }
      });
    });
  });
});
