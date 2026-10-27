import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ADMIN_ROLES, authorizeAdmin, normalizeAdminPath } from '../src/auth/admin-policy';

/**
 * ③ T5（规格 §2.10 第 0 步 + 第 6 步）：管理面 policy 的**单元面**。
 *
 *  - `normalizeAdminPath`：剥**全部**尾斜杠（⚙️17；射程 = 仅 policy 匹配 —— 豁免与
 *    `isAdminPath` 用原值，那两处由 `admin.middleware.test.ts` 钉）；
 *  - `authorizeAdmin({method, normPath, role})`：P1–P9 **显式枚举、按序首个命中**。
 *
 * 🔴 N1/S1（本片唯一的越权路径）：`GET /api/admin/accounts/`（尾斜杠）若**不**先归一再匹配，
 * 会绕过 P1（精确匹配失败）落进 P8「其余 GET 任意角色放行」—— 非超管即可列全部管理员账号。
 * 本文件用「归一后中 P1」的正例把这条路径钉死。
 */
const FOUR_ROLES = ['super_admin', 'finance', 'operator', 'viewer'] as const;

describe('normalizeAdminPath（⚙️17：剥全部尾斜杠）', () => {
  it('剥掉**全部**尾斜杠（一个 / 多个等价）', () => {
    expect(normalizeAdminPath('/api/admin/accounts/')).toBe('/api/admin/accounts');
    expect(normalizeAdminPath('/api/admin/accounts///')).toBe('/api/admin/accounts');
    expect(normalizeAdminPath('/api/admin/login/')).toBe('/api/admin/login');
    expect(normalizeAdminPath('/api/admin/config/room.x/')).toBe('/api/admin/config/room.x');
  });

  it('无尾斜杠 ⇒ 恒等（归一不是改写）；中间斜杠一律不剥', () => {
    expect(normalizeAdminPath('/api/admin/accounts')).toBe('/api/admin/accounts');
    expect(normalizeAdminPath('/api/admin/config/room.x')).toBe('/api/admin/config/room.x');
    expect(normalizeAdminPath('/api/admin/accounts/42')).toBe('/api/admin/accounts/42');
    expect(normalizeAdminPath('/api/admin/accounts/42/')).toBe('/api/admin/accounts/42');
  });
});

describe('authorizeAdmin（P1–P9 显式枚举，按序首个命中；输入为归一后路径）', () => {
  const check = (method: string, path: string, role: string) =>
    authorizeAdmin({ method, normPath: path, role });

  it('ADMIN_ROLES 恰好四值（claims 校验与 P 表共用同一份白名单）', () => {
    expect(ADMIN_ROLES).toEqual(['super_admin', 'finance', 'operator', 'viewer']);
  });

  it('P1：GET /api/admin/accounts（精确）⇒ 仅 super_admin', () => {
    expect(check('GET', '/api/admin/accounts', 'super_admin')).toBe(true);
    for (const role of ['finance', 'operator', 'viewer']) {
      expect(check('GET', '/api/admin/accounts', role), role).toBe(false);
    }
  });

  it('P2：POST /api/admin/accounts（精确）⇒ 仅 super_admin', () => {
    expect(check('POST', '/api/admin/accounts', 'super_admin')).toBe(true);
    for (const role of ['finance', 'operator', 'viewer']) {
      expect(check('POST', '/api/admin/accounts', role), role).toBe(false);
    }
  });

  it('P3：PATCH /api/admin/accounts/:id（前缀）⇒ 仅 super_admin', () => {
    expect(check('PATCH', '/api/admin/accounts/42', 'super_admin')).toBe(true);
    for (const role of ['finance', 'operator', 'viewer']) {
      expect(check('PATCH', '/api/admin/accounts/42', role), role).toBe(false);
    }
    // 前缀面：更深的路径也在 P3 覆盖内（仍只有超管）
    expect(check('PATCH', '/api/admin/accounts/42/anything', 'super_admin')).toBe(true);
  });

  it('P3 负例①：PATCH /api/admin/accounts（无 `:id`）不落 P3 ⇒ P9 403（四角色全拒）', () => {
    for (const role of FOUR_ROLES) {
      expect(check('PATCH', '/api/admin/accounts', role), role).toBe(false);
    }
  });

  it('P3 负例②：`.csv` 被显式排除 ⇒ P9 403（连 super_admin 也拒 —— 排除面按规格逐字）', () => {
    for (const role of FOUR_ROLES) {
      expect(check('PATCH', '/api/admin/accounts/export.csv', role), role).toBe(false);
    }
  });

  it('P4：PUT /api/admin/config/:key（前缀且非 `…/changes`）⇒ super_admin | operator', () => {
    for (const role of ['super_admin', 'operator']) {
      expect(check('PUT', '/api/admin/config/room.friendRoomEnabled', role), role).toBe(true);
    }
    for (const role of ['finance', 'viewer']) {
      expect(check('PUT', '/api/admin/config/room.friendRoomEnabled', role), role).toBe(false);
    }
  });

  it('P4 负例①：`…/changes` 显式排除 ⇒ 四角色全拒（不落 P4 ⇒ P9；审计读口不得被当成键写）', () => {
    for (const role of FOUR_ROLES) {
      expect(check('PUT', '/api/admin/config/changes', role), role).toBe(false);
    }
  });

  it('P4 负例②：裸 /api/admin/config（无 `:key`）不中前缀 ⇒ 四角色全拒', () => {
    for (const role of FOUR_ROLES) {
      expect(check('PUT', '/api/admin/config', role), role).toBe(false);
    }
  });

  it('P5/P6/P7：wallet 三条 POST（adjust / reverse / reconcile/run）⇒ super_admin | finance', () => {
    const paths = [
      '/api/admin/wallet/adjust',
      '/api/admin/wallet/reverse',
      '/api/admin/wallet/reconcile/run',
    ];
    for (const path of paths) {
      for (const role of ['super_admin', 'finance']) {
        expect(check('POST', path, role), `${path} ${role}`).toBe(true);
      }
      for (const role of ['operator', 'viewer']) {
        expect(check('POST', path, role), `${path} ${role}`).toBe(false);
      }
    }
  });

  it('P8：其余 GET（含 .csv 与审计读口）⇒ 任意已认证角色（四角色全放行）', () => {
    const paths = [
      '/api/admin/config',
      '/api/admin/accounts/changes',
      '/api/admin/accounts/changes.csv',
      '/api/admin/config/changes',
      '/api/admin/config/changes.csv',
      '/api/admin/login-events',
      '/api/admin/login-events.csv',
      '/api/admin/wallet/ops',
      '/api/admin/wallet/ops.csv',
      '/api/admin/wallet/ops/77',
      '/api/admin/wallet/summary',
      '/api/admin/wallet/summary.csv',
      '/api/admin/wallet/reconcile',
      '/api/admin/wallet/accounts/u1',
      '/api/admin/users/lookup',
      '/api/admin/users/abc-123',
    ];
    for (const path of paths) {
      for (const role of FOUR_ROLES) {
        expect(check('GET', path, role), `${path} ${role}`).toBe(true);
      }
    }
  });

  /**
   * 风控 T7（规格 §2.9-3 / C11）+ 设备绑定片：**P-r1..P-r5** —— 读三条（P-r1: reviews 精确 /
   * P-r2: `/api/admin/risk/users/` 前缀 / P-r3: actions 与 actions.csv 两条精确）
   * **必须在 P8 之前**（顺序敏感，F9：P8 是「其余 GET ⇒ 任意角色」的首个命中即终局，
   * 落 P8 之后的三条读规则永远不会被求值）；写两条（P-r4: POST actions 精确 /
   * P-r5: DELETE users/:userId/device-binding）在 P9 之前。
   */
  describe('风控 T7 + 设备绑定片：P-r1..P-r5（读三条在 P8 之前 —— 顺序敏感 F9；写两条在 P9 之前）', () => {
    const READ_PATHS = [
      '/api/admin/risk/reviews',
      '/api/admin/risk/users/abc-123',
      '/api/admin/risk/actions',
      '/api/admin/risk/actions.csv',
    ];

    it('正例：四读端点 + POST actions ⇒ super_admin | operator', () => {
      for (const path of READ_PATHS) {
        for (const role of ['super_admin', 'operator']) {
          expect(check('GET', path, role), `${path} ${role}`).toBe(true);
        }
      }
      for (const role of ['super_admin', 'operator']) {
        expect(check('POST', '/api/admin/risk/actions', role), role).toBe(true);
      }
    });

    it('🔴 F9 反证：viewer/finance 对四读端点 403 —— 证**未落 P8**（否则 GET 会被任意角色放行）', () => {
      for (const path of READ_PATHS) {
        for (const role of ['viewer', 'finance']) {
          expect(check('GET', path, role), `${path} ${role}`).toBe(false);
        }
      }
      // 写一条同理：viewer/finance 403（P-r4 命中但角色不足，不得落到任何放行面）
      for (const role of ['viewer', 'finance']) {
        expect(check('POST', '/api/admin/risk/actions', role), role).toBe(false);
      }
    });

    it('P9 不变：风控前缀下的**未登记**写路径仍 403 fail-closed（含 super_admin）', () => {
      const cases: Array<[string, string]> = [
        ['POST', '/api/admin/risk/reviews'],
        ['DELETE', '/api/admin/risk/actions'],
        ['PUT', '/api/admin/risk/users/abc-123'],
        ['PATCH', '/api/admin/risk/actions.csv'],
      ];
      for (const [method, path] of cases) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('P-r2 前缀面：更深的子路径仍在 `super_admin | operator` 闸内（viewer 仍拒）', () => {
      expect(check('GET', '/api/admin/risk/users/abc-123/extra', 'operator')).toBe(true);
      expect(check('GET', '/api/admin/risk/users/abc-123/extra', 'viewer')).toBe(false);
    });

    it('P-r3 精确两条：actions 的**其它**变体不中 P-r3（GET 落 P8 —— 未登记读路径语义不变）', () => {
      // 判别性：P-r3 是「两条精确」而不是前缀 —— `/actions/x` 不是登记读口，
      // 落 P8（任意角色）= 现状语义（与 P1/P3 的「不做通配」纪律同族）。
      expect(check('GET', '/api/admin/risk/actions/extra', 'viewer')).toBe(true);
      expect(check('GET', '/api/admin/risk/actions.csvx', 'viewer')).toBe(true);
    });

    // ─── 设备绑定片 P-r5：DELETE /api/admin/risk/users/:userId/device-binding ──────

    it('P-r5 正例：解绑端点 ⇒ super_admin | operator（两角色 true，两角色 false）', () => {
      for (const role of ['super_admin', 'operator']) {
        expect(
          check('DELETE', '/api/admin/risk/users/u-abc-123/device-binding', role),
          role,
        ).toBe(true);
      }
      for (const role of ['viewer', 'finance']) {
        expect(
          check('DELETE', '/api/admin/risk/users/u-abc-123/device-binding', role),
          role,
        ).toBe(false);
      }
    });

    it('P-r5 形状闸：前缀 + 固定后缀 + 非空 userId 段三者齐才中；变体全落 P9（含 super_admin）', () => {
      const negatives = [
        // 无 userId 段（裸 users/device-binding）⇒ 非空段校验挡下
        '/api/admin/risk/users/device-binding',
        // 后缀错：同前缀下的其它 DELETE 子资源不得被通配放行
        '/api/admin/risk/users/u-abc-123/device-unbind',
        '/api/admin/risk/users/u-abc-123/device-binding/extra',
        // 尾斜杠归一后等价正例 —— 这里钉的是**归一前** helper 不自行处理（中间件先归一）
      ];
      for (const path of negatives) {
        for (const role of FOUR_ROLES) {
          expect(check('DELETE', path, role), `DELETE ${path} ${role}`).toBe(false);
        }
      }
      // policy 吃的是**归一后**路径：尾斜杠原始形态不中（与 N1 同族，归一在中间件做），
      // 经 normalizeAdminPath 剥除后中 P-r5。
      const slashed = '/api/admin/risk/users/u-abc-123/device-binding/';
      expect(check('DELETE', slashed, 'super_admin')).toBe(false);
      expect(check('DELETE', normalizeAdminPath(slashed), 'operator')).toBe(true);
      // GET 同路径不属 P-r5（P-r2 是 GET 前缀面，恰好吞掉它 ⇒ super_admin|operator）
      expect(check('GET', '/api/admin/risk/users/u-abc-123/device-binding', 'viewer')).toBe(false);
      expect(check('GET', '/api/admin/risk/users/u-abc-123/device-binding', 'operator')).toBe(true);
    });

    it('P-r5 大小写折叠：DELETE /API/ADMIN/RISK/USERS/u-1/DEVICE-BINDING ⇒ operator true / viewer false', () => {
      expect(check('DELETE', '/API/ADMIN/RISK/USERS/u-1/DEVICE-BINDING', 'operator')).toBe(true);
      expect(check('DELETE', '/API/ADMIN/RISK/USERS/u-1/DEVICE-BINDING', 'viewer')).toBe(false);
    });
  });

  it('P9：其余非 GET（未登记写路径）⇒ 403 fail-closed（四角色全拒）', () => {
    const cases: Array<[string, string]> = [
      ['DELETE', '/api/admin/config/room.friendRoomEnabled'],
      ['POST', '/api/admin/config/room.friendRoomEnabled'],
      ['PUT', '/api/admin/accounts/42'],
      ['PATCH', '/api/admin/config/room.friendRoomEnabled'],
      ['POST', '/api/admin/accounts/42'],
      ['DELETE', '/api/admin/wallet/ops/1'],
      ['POST', '/api/admin/wallet/ops'],
      ['PUT', '/api/admin/wallet/reconcile/run'],
    ];
    for (const [method, path] of cases) {
      for (const role of FOUR_ROLES) {
        expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
      }
    }
  });

  /**
   * 支付 T12（规格 §0.3-⚙️10）：**P-p1..P-p7** —— 读四条（orders/refunds/withdrawals/actions
   * 三态族）**必须在 P8 之前**（⚙️10 逐字：显式登记、**不落 P8 兜底语义**；顺序敏感的
   * F9 家族——落 P8 之后 = 死条目）；写三条（refunds review / withdrawals review+confirm）
   * 在前缀 + 固定后缀面上 `super_admin | finance`（照 P6）。
   *
   * ⚠️ **读条目的判别性问题**：P-p* 读条目返回 `true`，与 P8「其余 GET ⇒ true」**行为同形**
   * ⇒ 单测**不能**用角色反证（这是与 P-r1..r3 的差异；那三条有角色面可判别）。因此这里
   * 用**源码序结构断言**钉位置（本文件下方「钉序」用例）：八个读条目字面量必须出现在
   * P8 那行**之前**。
   */
  describe('支付 T12：P-p1..P-p7（读四条在 P8 之前——钉序；写三条在 P9 之前）', () => {
    const READ_PATHS = [
      '/api/admin/pay/orders',
      '/api/admin/pay/orders.csv',
      '/api/admin/pay/orders/pay_abc123',
      '/api/admin/pay/refunds',
      '/api/admin/pay/refunds.csv',
      '/api/admin/pay/refunds/rf_abc123',
      '/api/admin/pay/withdrawals',
      '/api/admin/pay/withdrawals.csv',
      '/api/admin/pay/withdrawals/wd_abc123',
      '/api/admin/pay/actions',
      '/api/admin/pay/actions.csv',
    ] as const;

    it('正例：读面 11 条路径 × 四角色 ⇒ 全放行（显式登记 return true）', () => {
      for (const path of READ_PATHS) {
        for (const role of FOUR_ROLES) {
          expect(check('GET', path, role), `${path} ${role}`).toBe(true);
        }
      }
    });

    it('正例：写三条 ⇒ super_admin | finance（operator/viewer 拒——命中 P-p5..p7 但角色不足）', () => {
      const writePaths = [
        '/api/admin/pay/refunds/rf_abc123/review',
        '/api/admin/pay/withdrawals/wd_abc123/review',
        '/api/admin/pay/withdrawals/wd_abc123/confirm',
      ];
      for (const path of writePaths) {
        for (const role of ['super_admin', 'finance']) {
          expect(check('POST', path, role), `${path} ${role}`).toBe(true);
        }
        for (const role of ['operator', 'viewer']) {
          expect(check('POST', path, role), `${path} ${role}`).toBe(false);
        }
      }
    });

    it('写面后缀判别：其它后缀 / 裸单号 / 多余段 不中 P-p5..p7 ⇒ P9 全拒', () => {
      const cases: Array<[string, string]> = [
        ['POST', '/api/admin/pay/refunds/rf_1/approve'],
        ['POST', '/api/admin/pay/refunds/rf_1'],
        ['POST', '/api/admin/pay/refunds/rf_1/review/extra'],
        ['POST', '/api/admin/pay/withdrawals/wd_1/confirm/extra'],
        ['POST', '/api/admin/pay/withdrawals/confirm'],
        ['POST', '/api/admin/pay/orders'],
        ['POST', '/api/admin/pay/actions'],
        ['DELETE', '/api/admin/pay/orders'],
        ['PATCH', '/api/admin/pay/withdrawals/wd_1/confirm'],
        ['PUT', '/api/admin/pay/refunds/rf_1/review'],
      ];
      for (const [method, path] of cases) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('折叠面：混大小写路径同样中 P-p（写面 finance 放行 / viewer 拒）', () => {
      expect(check('POST', '/API/ADMIN/PAY/REFUNDS/rf_1/REVIEW', 'finance')).toBe(true);
      expect(check('POST', '/API/ADMIN/PAY/REFUNDS/rf_1/REVIEW', 'viewer')).toBe(false);
      expect(check('GET', '/API/admin/PAY/Orders', 'viewer')).toBe(true);
    });

    it('🔴 钉序（源码序结构断言）：八个读条目字面量在 P8 那行**之前**；三条写条目在 P8 之后、P9 之前', () => {
      // 行为不可判别（读条目与 P8 都返回 true）⇒ 以**源码位置**钉「显式登记、不落 P8 兜底」。
      const src = readFileSync(new URL('../src/auth/admin-policy.ts', import.meta.url), 'utf8');
      const p8 = src.indexOf("if (method === 'GET') return true;");
      expect(p8, 'P8 行必须在场').toBeGreaterThan(-1);

      const readAnchors = [
        "'/api/admin/pay/orders'",
        "'/api/admin/pay/orders.csv'",
        "'/api/admin/pay/refunds'",
        "'/api/admin/pay/refunds.csv'",
        "'/api/admin/pay/withdrawals'",
        "'/api/admin/pay/withdrawals.csv'",
        "'/api/admin/pay/actions'",
        "'/api/admin/pay/actions.csv'",
      ] as const;
      for (const anchor of readAnchors) {
        const at = src.indexOf(anchor);
        expect(at, `${anchor} 必须在场`).toBeGreaterThan(-1);
        expect(at, `${anchor} 必须在 P8 之前（落 P8 之后 = 死条目）`).toBeLessThan(p8);
      }

      const p9 = src.lastIndexOf('return false;');
      const writeAnchors = [
        "isPayActionPath(p, PAY_REFUNDS_SUBPATH_PREFIX, '/review')",
        "isPayActionPath(p, PAY_WITHDRAWALS_SUBPATH_PREFIX, '/review')",
        "isPayActionPath(p, PAY_WITHDRAWALS_SUBPATH_PREFIX, '/confirm')",
      ] as const;
      for (const anchor of writeAnchors) {
        const at = src.indexOf(anchor);
        expect(at, `${anchor} 必须在场`).toBeGreaterThan(p8);
        expect(at, `${anchor} 必须在 P9 之前`).toBeLessThan(p9);
      }
    });
  });

  /**
   * 支付配置管理化 T7（规格 §4 / ⚙️10「E′」）：**P-c1/P-c2** —— 渠道写面两条
   *（`PUT`/`DELETE` `/api/admin/pay-channel/` 前缀）仅 `super_admin`；GET **不设条目** ⇒ 落 P8。
   *
   * 变体矩阵逐格（规格 §4；设计 r2 的 Express 探针实测）：
   *  - 字面 / 键段 `%2E`/`%4B` / 大小写折叠 ⇒ 规则命中（非 SA 拒、SA 放行）—— policy 看的是
   *    **未解码原值路径**，前缀段未编码 ⇒ 键段怎么编码都不影响前缀命中（B1 面）；
   *  - 前缀段 `%2F` / 尾斜杠 / 裸路径 ⇒ 不中任何登记面 ⇒ 403（含 SA，fail-closed）。
   *
   * 🔴 B1 教训（评审阻断消解）：本条目**单角色** ⇒「按键分权 + %-编码变体绕过」的攻击前提
   * 不存在；将来若对渠道写面**再引入按键分权**，**不得**在 policy 里匹配「解码后的键名」
   *（policy 永远看不到解码后的键）—— 必须改用按键字面路由 + 变体负例（注释在
   * `admin-policy.ts` 的 P-c 条目）。
   */
  describe('支付配置管理化 T7：P-c1/P-c2（写面仅 super_admin；GET 落 P8）', () => {
    const WRITE_METHODS = ['PUT', 'DELETE'] as const;
    const NON_SA = ['operator', 'finance', 'viewer'] as const;

    it('正例：PUT/DELETE 字面路径（六键代表两条）⇒ 仅 super_admin 放行', () => {
      for (const method of WRITE_METHODS) {
        for (const key of ['pay.channel.gatewayUrl', 'pay.channel.privateKey']) {
          const path = `/api/admin/pay-channel/${key}`;
          expect(check(method, path, 'super_admin'), `${method} ${path} super_admin`).toBe(true);
          for (const role of NON_SA) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体①（B1 面）：键段 %2E/%4B 编码 —— 前缀段未编码 ⇒ 仍命中规则（SA 放行 / 非 SA 拒）', () => {
      // `%2E`=`.`、`%4B`=`K`：对 policy（未解码原值视图）只是普通字符 —— 命中与否只看前缀段。
      const variants = [
        '/api/admin/pay-channel/pay%2Echannel%2EprivateKey',
        '/api/admin/pay-channel/pay.channel.private%4Bey',
      ];
      for (const method of WRITE_METHODS) {
        for (const path of variants) {
          expect(check(method, path, 'super_admin'), `${method} ${path}`).toBe(true);
          for (const role of NON_SA) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体②：前缀段混合大小写折叠 ⇒ 仍命中规则（非 SA 403 —— 不得落 P8 兜底）', () => {
      for (const method of WRITE_METHODS) {
        expect(check(method, '/API/ADMIN/PAY-CHANNEL/pay.channel.privateKey', 'super_admin')).toBe(true);
        expect(check(method, '/Api/Admin/Pay-Channel/pay.channel.privateKey', 'super_admin')).toBe(true);
        for (const role of NON_SA) {
          expect(check(method, '/Api/Admin/Pay-Channel/pay.channel.privateKey', role), role).toBe(false);
        }
      }
    });

    it('变体③：前缀段 %2F ⇒ 不中任何登记面 ⇒ P9 全拒（含 super_admin）—— fail-closed', () => {
      // ① 规则前缀的**尾斜杠**被编码（真链路会到 policy）；② 更靠前的斜杠被编码（真链路上还会
      // 先被 isAdminPath 拦下 ⇒ 401 —— 两条独立防线谁都不放行；此处钉 policy 自身同样不放行）。
      const variants = [
        '/api/admin/pay-channel%2Fpay.channel.privateKey',
        '/api/admin%2Fpay-channel/pay.channel.privateKey',
      ];
      for (const method of WRITE_METHODS) {
        for (const path of variants) {
          for (const role of FOUR_ROLES) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体④：尾斜杠 / 裸路径 ⇒ P9 全拒（含 super_admin）—— 「不做通配」纪律', () => {
      const bareCases: Array<[string, string]> = [
        ['PUT', '/api/admin/pay-channel'],
        ['DELETE', '/api/admin/pay-channel'],
        // 尾斜杠形态：归一（剥尾斜杠）后 = 裸路径 ⇒ 不中「带尾斜杠」的前缀面
        ['PUT', normalizeAdminPath('/api/admin/pay-channel/')],
        ['DELETE', normalizeAdminPath('/api/admin/pay-channel/')],
      ];
      for (const [method, path] of bareCases) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('近邻段不回退（「不做通配」判别负例）：pay-channelx / pay-channels 等近邻前缀 ⇒ P9 全拒', () => {
      const nearMiss: Array<[string, string]> = [
        ['PUT', '/api/admin/pay-channelx/pay.channel.privateKey'],
        ['PUT', '/api/admin/pay-channels/pay.channel.privateKey'],
        ['DELETE', '/api/admin/pay-channel-extra/x'],
      ];
      for (const [method, path] of nearMiss) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('未登记方法不回退：POST/PATCH 打 pay-channel 前后 ⇒ P9 全拒（含 super_admin）', () => {
      const unregistered: Array<[string, string]> = [
        ['POST', '/api/admin/pay-channel/pay.channel.privateKey'],
        ['PATCH', '/api/admin/pay-channel/pay.channel.privateKey'],
        ['POST', '/api/admin/pay-channel'],
      ];
      for (const [method, path] of unregistered) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('GET /api/admin/pay-channel ⇒ 任意已认证角色放行（**无显式条目**，落 P8；含尾斜杠归一形态）', () => {
      for (const role of FOUR_ROLES) {
        expect(check('GET', '/api/admin/pay-channel', role), role).toBe(true);
        expect(check('GET', normalizeAdminPath('/api/admin/pay-channel/'), role), `${role} 尾斜杠`).toBe(true);
      }
    });

    it('近邻（规格 §4 末行）：PUT /api/admin/config/pay.channel.privateKey ⇒ 走 P4（SA|operator 放行）—— **刻意的**', () => {
      const path = '/api/admin/config/pay.channel.privateKey';
      expect(check('PUT', path, 'super_admin')).toBe(true);
      expect(check('PUT', path, 'operator')).toBe(true);
      expect(check('PUT', path, 'finance')).toBe(false);
      expect(check('PUT', path, 'viewer')).toBe(false);
      // ⚠️ 防误读：网关放行 ≠ 生效。`pay.channel.*` **不在** CONFIG_KEYS（六键刻意不进 50 键面，
      // 规格 §2.1）；config-service 的 parseConfigValue 判「未知键 400」⇒ 写不进 platform_config
      //（conformance slice-22 ⑧ 断言此近邻 ⇒ 400，非 200/非 500）。**不得**在网关侧加排除面来
      // 「修」它：键集单一真源在 protocol，网关复刻一份 = 又一处漂移面（同「不做通配」纪律）。
    });

    it('钉序（源码序结构断言）：P-c1/P-c2 两写条目都在 P8 之后、P9 之前（落 P9 之后 = 死代码 ⇒ SA 恒 403）', () => {
      const src = readFileSync(new URL('../src/auth/admin-policy.ts', import.meta.url), 'utf8');
      const p8 = src.indexOf("if (method === 'GET') return true;");
      const p9 = src.lastIndexOf('return false;');
      expect(p8, 'P8 行必须在场').toBeGreaterThan(-1);
      expect(p9, 'P9 行必须在场').toBeGreaterThan(-1);

      // 用法锚 = `PAY_CHANNEL_SUBPATH_PREFIX)`（带右括号；常量声明行是 `NAME = …`，不含它）。
      const first = src.indexOf('PAY_CHANNEL_SUBPATH_PREFIX)');
      expect(first, 'P-c 第一条必须在场').toBeGreaterThan(-1);
      expect(first, 'P-c 第一条必须在 P8 之后').toBeGreaterThan(p8);
      expect(first, 'P-c 第一条必须在 P9 之前').toBeLessThan(p9);

      const second = src.indexOf('PAY_CHANNEL_SUBPATH_PREFIX)', first + 1);
      expect(second, 'P-c 第二条必须在场').toBeGreaterThan(first);
      expect(second, 'P-c 第二条必须在 P9 之前').toBeLessThan(p9);
    });
  });

  /**
   * 通知通道管理化 T8（规格 §4 / §5.2⑤）：**P-n1/P-n2** —— 通知通道写面两条
   *（`PUT`/`DELETE` `/api/admin/notify-channel/` 前缀）仅 `super_admin`；GET **不设条目** ⇒ 落 P8。
   *
   * 变体矩阵逐格（规格 §5.2⑤ 四段式；语义 = slice-22 ⑧ 实测，设计 B1 同族承接）：
   *  - 非 SA 三角色（operator/finance/viewer）×（字面 + 键段 `%2E`/`%4B` + 混合大小写）
   *    ⇒ 403（false）；SA × 同集 ⇒ 200（true）—— policy 匹配的是**未解码原值路径**
   *    （`requestPath` 原值、只剥尾斜杠、**不解码** %XX），键段编码变体只是普通字符，
   *    前缀段未编码 ⇒ 照样命中（B1 面）；
   *  - 前缀段 `%2F` / 尾斜杠（归一后 = 裸）/ 裸路径 ⇒ 不中任何登记面 ⇒ 403（含 SA，
   *    fail-closed ——「不做通配」纪律）。
   *
   * 🔴 B1 教训（支付 T7 同族）：本条目**单角色** ⇒「按键分权 + %-编码变体绕过」的攻击前提
   * 不存在；将来若对通知写面**再引入按键分权**，**不得**在 policy 里匹配「解码后的键名」
   *（policy 永远看不到解码后的键）—— 注释在 `admin-policy.ts` 的 P-n 条目。
   */
  describe('通知通道管理化 T8：P-n1/P-n2（写面仅 super_admin；GET 落 P8）', () => {
    const WRITE_METHODS = ['PUT', 'DELETE'] as const;
    const NON_SA = ['operator', 'finance', 'viewer'] as const;

    it('正例：PUT/DELETE 字面路径（九键代表两条）⇒ 仅 super_admin 放行', () => {
      for (const method of WRITE_METHODS) {
        for (const key of ['notify.smtp.pass', 'notify.webhook.wecomUrl']) {
          const path = `/api/admin/notify-channel/${key}`;
          expect(check(method, path, 'super_admin'), `${method} ${path} super_admin`).toBe(true);
          for (const role of NON_SA) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体①（B1 面）：键段 %2E/%4B 编码 —— 前缀段未编码 ⇒ 仍命中规则（SA 放行 / 非 SA 拒）', () => {
      // `%2E`=`.`、`%4B`=`K`：对 policy（未解码原值视图）只是普通字符。
      // ⚠️ 九键不含 'K' ⇒ `%4B` 变体**解码后**不是注册键（真栈上到下游 ⇒ 400）；policy 层
      // 只判「前缀命中」——键段解码后的合法性是 config-service 注册表校验的职责（B1 面）。
      const variants = [
        '/api/admin/notify-channel/notify%2Esmtp%2Epass',
        '/api/admin/notify-channel/notify.smtp.pa%4Bss',
      ];
      for (const method of WRITE_METHODS) {
        for (const path of variants) {
          expect(check(method, path, 'super_admin'), `${method} ${path}`).toBe(true);
          for (const role of NON_SA) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体②：前缀段混合大小写折叠 ⇒ 仍命中规则（SA 放行；非 SA 拒 —— 不得落 P8 兜底）', () => {
      for (const method of WRITE_METHODS) {
        expect(check(method, '/API/ADMIN/NOTIFY-CHANNEL/notify.smtp.pass', 'super_admin')).toBe(true);
        expect(check(method, '/Api/Admin/Notify-Channel/notify.smtp.pass', 'super_admin')).toBe(true);
        for (const role of NON_SA) {
          expect(check(method, '/Api/Admin/Notify-Channel/notify.smtp.pass', role), role).toBe(false);
        }
      }
    });

    it('变体③：前缀段 %2F ⇒ 不中任何登记面 ⇒ P9 全拒（含 super_admin）—— fail-closed', () => {
      // ① 规则前缀的**尾斜杠**被编码（真链路会到 policy）；② 更靠前的斜杠被编码（真链路上还会
      // 先被 isAdminPath 拦下 ⇒ 401 —— 两条独立防线谁都不放行；此处钉 policy 自身同样不放行）。
      const variants = [
        '/api/admin/notify-channel%2Fnotify.smtp.pass',
        '/api/admin%2Fnotify-channel/notify.smtp.pass',
      ];
      for (const method of WRITE_METHODS) {
        for (const path of variants) {
          for (const role of FOUR_ROLES) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体④：尾斜杠 / 裸路径 ⇒ P9 全拒（含 super_admin）—— 「不做通配」纪律', () => {
      const bareCases: Array<[string, string]> = [
        ['PUT', '/api/admin/notify-channel'],
        ['DELETE', '/api/admin/notify-channel'],
        // 尾斜杠形态：归一（剥尾斜杠）后 = 裸路径 ⇒ 不中「带尾斜杠」的前缀面
        ['PUT', normalizeAdminPath('/api/admin/notify-channel/')],
        ['DELETE', normalizeAdminPath('/api/admin/notify-channel/')],
      ];
      for (const [method, path] of bareCases) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('近邻段不回退（「不做通配」判别负例）：notify-channelx / notify-channels 等近邻前缀 ⇒ P9 全拒', () => {
      const nearMiss: Array<[string, string]> = [
        ['PUT', '/api/admin/notify-channelx/notify.smtp.pass'],
        ['PUT', '/api/admin/notify-channels/notify.smtp.pass'],
        ['DELETE', '/api/admin/notify-channel-extra/x'],
      ];
      for (const [method, path] of nearMiss) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('未登记方法不回退：POST/PATCH 打 notify-channel 前后 ⇒ P9 全拒（含 super_admin）', () => {
      const unregistered: Array<[string, string]> = [
        ['POST', '/api/admin/notify-channel/notify.smtp.pass'],
        ['PATCH', '/api/admin/notify-channel/notify.smtp.pass'],
        ['POST', '/api/admin/notify-channel'],
      ];
      for (const [method, path] of unregistered) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('GET /api/admin/notify-channel ⇒ 任意已认证角色放行（**无显式条目**，落 P8；含尾斜杠归一形态）', () => {
      for (const role of FOUR_ROLES) {
        expect(check('GET', '/api/admin/notify-channel', role), role).toBe(true);
        expect(check('GET', normalizeAdminPath('/api/admin/notify-channel/'), role), `${role} 尾斜杠`).toBe(true);
      }
    });

    it('近邻（规格 §4 末行）：PUT /api/admin/config/notify.smtp.pass ⇒ 走 P4（SA|operator 放行）—— **刻意的**', () => {
      const path = '/api/admin/config/notify.smtp.pass';
      expect(check('PUT', path, 'super_admin')).toBe(true);
      expect(check('PUT', path, 'operator')).toBe(true);
      expect(check('PUT', path, 'finance')).toBe(false);
      expect(check('PUT', path, 'viewer')).toBe(false);
      // ⚠️ 防误读：网关放行 ≠ 生效。`notify.*` 九键**不在** CONFIG_KEYS（结构性——不得污染
      // 50 键面，规格 §2.1）；config-service 的 parseConfigValue 判「未知键 400」⇒ 写不进
      // platform_config（conformance slice-23 ⑤ 断言此近邻 ⇒ **400**，非 200/非 500）。
      // **不得**在网关侧加排除面来「修」它：键集单一真源在 protocol，网关复刻一份 = 又一处
      // 漂移面（同「不做通配」纪律）。
    });

    it('钉序（源码序结构断言）：P-n1/P-n2 两写条目都在 P8 之后、P9 之前（落 P9 之后 = 死代码 ⇒ SA 恒 403）', () => {
      const src = readFileSync(new URL('../src/auth/admin-policy.ts', import.meta.url), 'utf8');
      const p8 = src.indexOf("if (method === 'GET') return true;");
      const p9 = src.lastIndexOf('return false;');
      expect(p8, 'P8 行必须在场').toBeGreaterThan(-1);
      expect(p9, 'P9 行必须在场').toBeGreaterThan(-1);

      // 用法锚 = `NOTIFY_CHANNEL_SUBPATH_PREFIX)`（带右括号；常量声明行是 `NAME = …`，不含它）。
      const first = src.indexOf('NOTIFY_CHANNEL_SUBPATH_PREFIX)');
      expect(first, 'P-n 第一条必须在场').toBeGreaterThan(-1);
      expect(first, 'P-n 第一条必须在 P8 之后').toBeGreaterThan(p8);
      expect(first, 'P-n 第一条必须在 P9 之前').toBeLessThan(p9);

      const second = src.indexOf('NOTIFY_CHANNEL_SUBPATH_PREFIX)', first + 1);
      expect(second, 'P-n 第二条必须在场').toBeGreaterThan(first);
      expect(second, 'P-n 第二条必须在 P9 之前').toBeLessThan(p9);
    });
  });

  /**
   * 广告片 T8（规格 §2.3 / 第四键空间）：**P-a1/P-a2** —— 广告回调密钥写面两条
   *（`PUT`/`DELETE` `/api/admin/ad-channel/` 前缀）仅 `super_admin`；GET **不设条目** ⇒ 落 P8。
   * 键空间唯一键 `ad.callbackSecret`（`AD_CHANNEL_KEYS`）是回调验签的信任锚 ⇒ 与 P-c/P-n
   * 同族（「E′」精神）—— 写面仅超管；读面（GET）掩码读（本空间全密键 ⇒ value 恒 null）。
   *
   * 变体矩阵逐格（同 P-c/P-n 四段式）：
   *  - 非 SA 三角色（operator/finance/viewer）×（字面 + 键段 `%2E`/`%72` + 混合大小写）
   *    ⇒ 403（false）；SA × 同集 ⇒ true —— policy 匹配的是**未解码原值路径**（只剥尾斜杠、
   *    **不解码** %XX）：键段编码变体只是普通字符，前缀段未编码 ⇒ 照样命中（B1 面）；
   *  - 前缀段 `%2F` / 尾斜杠（归一后 = 裸）/ 裸路径 ⇒ 不中任何登记面 ⇒ 403（含 SA，
   *    fail-closed ——「不做通配」纪律）。
   *
   * 🔴 B1 教训（P-c/P-n 同族）：本条目**单角色** ⇒「按键分权 + %-编码变体绕过」的攻击前提
   * 不存在；将来若对广告写面**再引入按键分权**，**不得**在 policy 里匹配「解码后的键名」
   *（policy 永远看不到解码后的键）—— 注释在 `admin-policy.ts` 的 P-a 条目。
   */
  describe('广告片 T8：P-a1/P-a2（写面仅 super_admin；GET 落 P8）', () => {
    const WRITE_METHODS = ['PUT', 'DELETE'] as const;
    const NON_SA = ['operator', 'finance', 'viewer'] as const;
    const KEY = 'ad.callbackSecret';

    it('正例：PUT/DELETE 字面路径（唯一键）⇒ 仅 super_admin 放行', () => {
      for (const method of WRITE_METHODS) {
        const path = `/api/admin/ad-channel/${KEY}`;
        expect(check(method, path, 'super_admin'), `${method} ${path} super_admin`).toBe(true);
        for (const role of NON_SA) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('变体①（B1 面）：键段 %2E/%72 编码 —— 前缀段未编码 ⇒ 仍命中规则（SA 放行 / 非 SA 拒）', () => {
      // `%2E`=`.`、`%72`=`r`：对 policy（未解码原值视图）只是普通字符 —— 命中与否只看前缀段。
      // ⚠️ 键段解码后的合法性是 config-service 注册表校验的职责（B1 面），本表只判「前缀命中」。
      const variants = [
        '/api/admin/ad-channel/ad%2EcallbackSecret',
        '/api/admin/ad-channel/ad.callbackSec%72et',
      ];
      for (const method of WRITE_METHODS) {
        for (const path of variants) {
          expect(check(method, path, 'super_admin'), `${method} ${path}`).toBe(true);
          for (const role of NON_SA) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体②：前缀段混合大小写折叠 ⇒ 仍命中规则（SA 放行；非 SA 拒 —— 不得落 P8 兜底）', () => {
      for (const method of WRITE_METHODS) {
        expect(check(method, '/API/ADMIN/AD-CHANNEL/ad.callbackSecret', 'super_admin')).toBe(true);
        expect(check(method, '/Api/Admin/Ad-Channel/ad.callbackSecret', 'super_admin')).toBe(true);
        for (const role of NON_SA) {
          expect(check(method, '/Api/Admin/Ad-Channel/ad.callbackSecret', role), role).toBe(false);
        }
      }
    });

    it('变体③：前缀段 %2F ⇒ 不中任何登记面 ⇒ P9 全拒（含 super_admin）—— fail-closed', () => {
      // ① 规则前缀的**尾斜杠**被编码（真链路会到 policy）；② 更靠前的斜杠被编码（真链路上还会
      // 先被 isAdminPath 拦下 ⇒ 401 —— 两条独立防线谁都不放行；此处钉 policy 自身同样不放行）。
      const variants = [
        '/api/admin/ad-channel%2Fad.callbackSecret',
        '/api/admin%2Fad-channel/ad.callbackSecret',
      ];
      for (const method of WRITE_METHODS) {
        for (const path of variants) {
          for (const role of FOUR_ROLES) {
            expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
          }
        }
      }
    });

    it('变体④：尾斜杠 / 裸路径 ⇒ P9 全拒（含 super_admin）—— 「不做通配」纪律', () => {
      const bareCases: Array<[string, string]> = [
        ['PUT', '/api/admin/ad-channel'],
        ['DELETE', '/api/admin/ad-channel'],
        // 尾斜杠形态：归一（剥尾斜杠）后 = 裸路径 ⇒ 不中「带尾斜杠」的前缀面
        ['PUT', normalizeAdminPath('/api/admin/ad-channel/')],
        ['DELETE', normalizeAdminPath('/api/admin/ad-channel/')],
      ];
      for (const [method, path] of bareCases) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('近邻段不回退（「不做通配」判别负例）：ad-channelx / ad-channels 等近邻前缀 ⇒ P9 全拒', () => {
      const nearMiss: Array<[string, string]> = [
        ['PUT', '/api/admin/ad-channelx/ad.callbackSecret'],
        ['PUT', '/api/admin/ad-channels/ad.callbackSecret'],
        ['DELETE', '/api/admin/ad-channel-extra/x'],
      ];
      for (const [method, path] of nearMiss) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('未登记方法不回退：POST/PATCH 打 ad-channel 前后 ⇒ P9 全拒（含 super_admin）', () => {
      const unregistered: Array<[string, string]> = [
        ['POST', '/api/admin/ad-channel/ad.callbackSecret'],
        ['PATCH', '/api/admin/ad-channel/ad.callbackSecret'],
        ['POST', '/api/admin/ad-channel'],
      ];
      for (const [method, path] of unregistered) {
        for (const role of FOUR_ROLES) {
          expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
        }
      }
    });

    it('GET /api/admin/ad-channel ⇒ 任意已认证角色放行（**无显式条目**，落 P8；含尾斜杠归一形态）', () => {
      for (const role of FOUR_ROLES) {
        expect(check('GET', '/api/admin/ad-channel', role), role).toBe(true);
        expect(check('GET', normalizeAdminPath('/api/admin/ad-channel/'), role), `${role} 尾斜杠`).toBe(true);
      }
    });

    it('近邻（规格 §2.3）：PUT /api/admin/config/ad.callbackSecret ⇒ 走 P4（SA|operator 放行）—— **刻意的**', () => {
      const path = '/api/admin/config/ad.callbackSecret';
      expect(check('PUT', path, 'super_admin')).toBe(true);
      expect(check('PUT', path, 'operator')).toBe(true);
      expect(check('PUT', path, 'finance')).toBe(false);
      expect(check('PUT', path, 'viewer')).toBe(false);
      // ⚠️ 防误读：网关放行 ≠ 生效。`ad.callbackSecret` **不在** CONFIG_KEYS（第四键空间刻意
      // 不进 50 键面，规格 §2.3）；config-service 的 parseConfigValue 判「未知键 400」⇒ 写不进
      // platform_config。**不得**在网关侧加排除面来「修」它：键集单一真源在 protocol，网关
      // 复刻一份 = 又一处漂移面（同「不做通配」纪律）。
    });

    it('钉序（源码序结构断言）：P-a1/P-a2 两写条目都在 P8 之后、P9 之前（落 P9 之后 = 死代码 ⇒ SA 恒 403）', () => {
      const src = readFileSync(new URL('../src/auth/admin-policy.ts', import.meta.url), 'utf8');
      const p8 = src.indexOf("if (method === 'GET') return true;");
      const p9 = src.lastIndexOf('return false;');
      expect(p8, 'P8 行必须在场').toBeGreaterThan(-1);
      expect(p9, 'P9 行必须在场').toBeGreaterThan(-1);

      // 用法锚 = `AD_CHANNEL_SUBPATH_PREFIX)`（带右括号；常量声明行是 `NAME = …`，不含它）。
      const first = src.indexOf('AD_CHANNEL_SUBPATH_PREFIX)');
      expect(first, 'P-a 第一条必须在场').toBeGreaterThan(-1);
      expect(first, 'P-a 第一条必须在 P8 之后').toBeGreaterThan(p8);
      expect(first, 'P-a 第一条必须在 P9 之前').toBeLessThan(p9);

      const second = src.indexOf('AD_CHANNEL_SUBPATH_PREFIX)', first + 1);
      expect(second, 'P-a 第二条必须在场').toBeGreaterThan(first);
      expect(second, 'P-a 第二条必须在 P9 之前').toBeLessThan(p9);
    });
  });

  it('方法必须是大写规范形（非 GET 的办法一律 fail-closed —— 小写 get 不落 P8）', () => {
    for (const role of FOUR_ROLES) {
      expect(check('get', '/api/admin/config', role), role).toBe(false);
    }
  });

  /**
   * 波 3 评审修复 F1（🔴）：**匹配面大小写折叠** —— Express/Nest 路由**大小写不敏感**
   *（`/API/admin/…` 与 `/api/admin/…` 同一处理器），而规则字面量全小写；不折叠 ⇒
   * 混大小写路径精确/前缀匹配失败 ⇒ **落 P8「任意 GET」放行**（viewer 越权；下游无
   * 第二层角色守卫）。同族覆盖既存 P1–P7（`GET /API/admin/Accounts` viewer ⇒ true 是
   * **③ 片遗留洞**，本修复一并堵）。
   */
  describe('波 3 F1：policy 匹配大小写折叠（Express 路由大小写不敏感）', () => {
    it('① viewer/finance 对混大小写风控读端点 ⇒ 403（false，不得落 P8）', () => {
      for (const path of ['/API/admin/risk/reviews', '/api/admin/RISK/reviews']) {
        for (const role of ['viewer', 'finance']) {
          expect(check('GET', path, role), `${path} ${role}`).toBe(false);
        }
      }
    });

    it('② 回归针（③ 遗留同族洞）：GET /API/admin/Accounts ⇒ 非超管 false、超管 true（命中 P1）', () => {
      for (const role of ['finance', 'operator', 'viewer']) {
        expect(check('GET', '/API/admin/Accounts', role), role).toBe(false);
      }
      expect(check('GET', '/API/admin/Accounts', 'super_admin')).toBe(true);
    });

    it('③ POST /API/ADMIN/risK/ACTIONS ⇒ viewer/finance false（命中 P-r4 但角色不足）、operator true', () => {
      for (const role of ['viewer', 'finance']) {
        expect(check('POST', '/API/ADMIN/risK/ACTIONS', role), role).toBe(false);
      }
      expect(check('POST', '/API/ADMIN/risK/ACTIONS', 'operator')).toBe(true);
    });

    it('④ 正对照：operator 对 GET /api/admin/RISK/reviews ⇒ true（折叠后命中 P-r1 而非 P8）', () => {
      // 判别性由①保：同一拼写 viewer ⇒ false（若落 P8 会 true）。本条的「命中 P-r1」
      // 与「命中 P8」在返回值上同形，配对①才构成完整反证。
      expect(check('GET', '/api/admin/RISK/reviews', 'operator')).toBe(true);
    });

    it('⑤ 折叠**不得过度拒**：P8 面（任意角色 GET）在混大小写下照旧放行', () => {
      expect(check('GET', '/API/admin/Config', 'viewer')).toBe(true);
      expect(check('GET', '/API/admin/accounts/changes'.toUpperCase(), 'viewer')).toBe(true);
    });

    it('⑥ 引号纪律不变：折叠只影响匹配 —— 小写方法仍不落 P8（方法面不做折叠）', () => {
      for (const role of FOUR_ROLES) {
        expect(check('get', '/API/admin/Config', role), role).toBe(false);
      }
    });
  });

  it('🔴 S1 回归（本片唯一越权路径）：GET /api/admin/accounts/ 归一后**中 P1** ⇒ 非超管 403、不落 P8', () => {
    // 判别性：若归一缺失，这条路径将精确匹配失败 ⇒ 落 P8 ⇒ 返回 true（越权）。
    const normPath = normalizeAdminPath('/api/admin/accounts/');
    expect(normPath).toBe('/api/admin/accounts');
    expect(check('GET', normPath, 'super_admin')).toBe(true);
    for (const role of ['finance', 'operator', 'viewer']) {
      expect(check('GET', normPath, role), role).toBe(false);
    }
  });

  it('🔴 S1 变体：多尾斜杠 /accounts//// 归一后同样中 P1（非超管 403）', () => {
    const normPath = normalizeAdminPath('/api/admin/accounts////');
    for (const role of ['finance', 'operator', 'viewer']) {
      expect(check('GET', normPath, role), role).toBe(false);
    }
  });
});

describe('玩家管理页（2026-10-22）：P10–P13', () => {
  const check = (method: string, path: string, role: string) =>
    authorizeAdmin({ method, normPath: path, role });

  it('P10：GET /api/admin/players 精确 ⇒ super_admin | operator', () => {
    expect(check('GET', '/api/admin/players', 'super_admin')).toBe(true);
    expect(check('GET', '/api/admin/players', 'operator')).toBe(true);
    expect(check('GET', '/api/admin/players', 'finance')).toBe(false);
    expect(check('GET', '/api/admin/players', 'viewer')).toBe(false);
  });

  it('P11：GET /api/admin/players/:id/games ⇒ super_admin | operator；尾斜杠归一', () => {
    for (const role of ['super_admin', 'operator']) {
      expect(check('GET', '/api/admin/players/u-1/games', role)).toBe(true);
      expect(check('GET', '/api/admin/players/u-1/games/', role)).toBe(true);
    }
    expect(check('GET', '/api/admin/players/u-1/games', 'finance')).toBe(false);
    expect(check('GET', '/api/admin/players/u-1/games', 'viewer')).toBe(false);
  });

  it('P12/P13：两个批量 POST 精确 ⇒ super_admin | operator', () => {
    for (const path of ['/api/admin/wallet/accounts/batch', '/api/admin/pay/players/summary']) {
      expect(check('POST', path, 'super_admin')).toBe(true);
      expect(check('POST', path, 'operator')).toBe(true);
      expect(check('POST', path, 'finance')).toBe(false);
      expect(check('POST', path, 'viewer')).toBe(false);
      expect(check('POST', normalizeAdminPath(`${path}/`), 'operator')).toBe(true);
    }
  });
});

describe('代理分润（2026-10-26）：P-ag0..P-ag4', () => {
  const check = (method: string, path: string, role: string) =>
    authorizeAdmin({ method, normPath: path, role });

  it('读面：agents* / agent-audit / agent-reconciliation / agent-settlements* / agent-adjustments* ⇒ super_admin | finance', () => {
    const paths = [
      '/api/admin/agents',
      '/api/admin/agents/tree',
      '/api/admin/agents/settings',
      '/api/admin/agents/ag_1',
      '/api/admin/agents/ag_1/bindings',
      '/api/admin/agent-audit',
      '/api/admin/agent-reconciliation',
      '/api/admin/agent-settlements',
      '/api/admin/agent-settlements/1',
      '/api/admin/agent-adjustments',
    ];
    for (const path of paths) {
      expect(check('GET', path, 'super_admin'), path).toBe(true);
      expect(check('GET', path, 'finance'), path).toBe(true);
      expect(check('GET', path, 'operator'), path).toBe(false);
      expect(check('GET', path, 'viewer'), path).toBe(false);
    }
  });

  it('写面：POST/PATCH/DELETE /api/admin/agents* ⇒ 仅 super_admin', () => {
    const cases: Array<[string, string]> = [
      ['POST', '/api/admin/agents'],
      ['PATCH', '/api/admin/agents/settings'],
      ['PATCH', '/api/admin/agents/ag_1'],
      ['PATCH', '/api/admin/agents/ag_1/payout'],
      ['POST', '/api/admin/agents/ag_1/status'],
      ['POST', '/api/admin/agents/ag_1/reset-password'],
      ['POST', '/api/admin/agents/ag_1/invite-code/rotate'],
      ['POST', '/api/admin/agents/bind'],
      ['POST', '/api/admin/agents/unbind'],
      ['POST', '/api/admin/agents/ag_1/bindings/bulk'],
      ['POST', '/api/admin/agents/ag_1/adjustments'],
      ['DELETE', '/api/admin/agents/ag_1'],
    ];
    for (const [method, path] of cases) {
      expect(check(method, path, 'super_admin'), `${method} ${path}`).toBe(true);
      for (const role of ['finance', 'operator', 'viewer']) {
        expect(check(method, path, role), `${method} ${path} ${role}`).toBe(false);
      }
    }
  });

  it('结算打款/驳回 ⇒ finance | super_admin；调账复核/驳回 ⇒ 仅 super_admin', () => {
    for (const path of [
      '/api/admin/agent-settlements/1/pay',
      '/api/admin/agent-settlements/1/reject',
    ]) {
      expect(check('POST', path, 'finance'), path).toBe(true);
      expect(check('POST', path, 'super_admin'), path).toBe(true);
      expect(check('POST', path, 'operator'), path).toBe(false);
      expect(check('POST', path, 'viewer'), path).toBe(false);
    }
    for (const path of [
      '/api/admin/agent-adjustments/1/approve',
      '/api/admin/agent-adjustments/1/reject',
    ]) {
      expect(check('POST', path, 'super_admin'), path).toBe(true);
      for (const role of ['finance', 'operator', 'viewer']) {
        expect(check('POST', path, role), `${path} ${role}`).toBe(false);
      }
    }
  });

  it('P-ag0：agent.inviteEnabled 及 % 编码变体 ⇒ 仅 super_admin（先于 P4）', () => {
    for (const key of [
      'agent.inviteEnabled',
      'agent%2EinviteEnabled',
      'agent%252EinviteEnabled',
      'AGENT.inviteEnabled',
    ]) {
      const path = `/api/admin/config/${key}`;
      expect(check('PUT', path, 'super_admin'), key).toBe(true);
      expect(check('PUT', path, 'operator'), key).toBe(false);
      expect(check('PUT', path, 'finance'), key).toBe(false);
    }
    // 普通 config 键仍走 P4（operator 可写）—— 判别力：不是把所有 config 都收紧。
    expect(check('PUT', '/api/admin/config/room.friendRoomEnabled', 'operator')).toBe(true);
  });
});
