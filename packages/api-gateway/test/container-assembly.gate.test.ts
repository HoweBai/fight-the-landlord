import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// R462：产品**实际消费**的那份白名单（下面用它把「源码字面量」与「运行期真值」钉在一起）。
import { AUTH_PATHS, HEALTH_PATHS, PUBLIC_PATHS, isHealthPath, isPublicPath } from '../src/auth/public-paths';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';
import { toPosixPath } from './helpers/repo-path';

/**
 * **源码级机械闸**：三条**容器装配不变式**（都来自本片容器验收实测撞到的缺陷，见 R293/R294）。
 *
 *  1. `HealthController` 注册的每一条路由都必须免鉴权（否则 `/api/health/live` 恒 401）；
 *  2. 一个控制器类只能被一个模块注册（否则新加的构造依赖会让容器启动即崩）；
 *  3. **同一个服务内不得有两条同路径同动词的路由**（否则后注册的那条永远不生效）。
 *
 * ⚠️ 三条的共同点：**单测全绿、只有真容器（或从源码算出来的不变式）能看见**。
 *
 * ─── 这条闸要抓的具体缺陷（本片实测撞到，见 R293）───────────────────────
 * R267 给每个服务新增了 `GET /api/health/live`（存活面）。它**必须**能被编排层
 * 无凭证探到，而「哪些路径免鉴权」在两个地方各写了一份：
 *  - 网关：`auth/public-paths.ts` 的 `PUBLIC_PATHS`（= `AUTH_PATHS` + `HEALTH_PATHS`，§7.1 的白名单；
 *    R462 之前它是 `auth/jwt.middleware.ts` 的私有 `publicPaths`）；
 *  - 七个下游服务：`http/internal-token.middleware.ts` 的 `DEFAULT_EXEMPT_PATHS`。
 * 本片第一次容器验收实测：五个服务的 `/api/health` 都是 **200**，而 `/api/health/live`
 * **全是 401** —— 因为两处清单都**只**列了 `/api/health`。单测**一条都没红**
 * （它们测的是中间件对**给定**清单的行为，而没有人测「清单是否覆盖了控制器注册的路由」）。
 *
 * 这正是本仓反复出现的形态：**同一事实两个真源**，而漂移没有任何东西守着。
 * 本闸把它变成可观测的失败。
 *
 * ─── 为什么不是「断言 `/api/health/live` 在清单里」──────────────────────
 * 那种写法把**当前的路由表**钉进了判据：下次给健康检查加第三个端点（比如
 * `/api/health/ready`）时，它会照样绿 —— 而那正是本条要防的事。因此本闸的判据是
 * **不变式**：`控制器注册的路由集合 ⊆ 免鉴权清单`，两侧都**从源码里提取**。
 */

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** 每个服务：控制器在哪、清单在哪、清单里的**标识符**叫什么。 */
const SERVICES = [
  {
    name: 'api-gateway',
    controller: 'packages/api-gateway/src/health/health.controller.ts',
    /**
     * ⚠️ R462：网关的白名单已提到**单一真源** `auth/public-paths.ts`，并按语义拆成
     * `AUTH_PATHS` + `HEALTH_PATHS`（`PUBLIC_PATHS` 是两者的组合）。因此这里提取
     * **两组字面量**再拼接 —— 不再指向 `jwt.middleware.ts` 的私有 `publicPaths`
     * （那已经不存在了；`listOf` 找不到会**抛错**，不会静默变绿）。
     */
    listFile: 'packages/api-gateway/src/auth/public-paths.ts',
    listIdents: ['AUTH_PATHS', 'HEALTH_PATHS'],
  },
  {
    name: 'user-service',
    controller: 'packages/user-service/src/health/health.controller.ts',
    listFile: 'packages/user-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
  {
    name: 'room-service',
    controller: 'packages/room-service/src/health/health.controller.ts',
    listFile: 'packages/room-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
  {
    name: 'game-service',
    controller: 'packages/game-service/src/health/health.controller.ts',
    listFile: 'packages/game-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
  {
    name: 'robot-service',
    controller: 'packages/robot-service/src/health/health.controller.ts',
    listFile: 'packages/robot-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
  // ⚠️ 货币片 T1 补登（顺带补 config-service —— 片⑦ 起它就有健康面与豁免清单，
  //    缺席 = 闸对两个服务失明）。
  {
    name: 'config-service',
    controller: 'packages/config-service/src/health/health.controller.ts',
    listFile: 'packages/config-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
  {
    name: 'currency-service',
    controller: 'packages/currency-service/src/health/health.controller.ts',
    listFile: 'packages/currency-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
  // ⚠️ 支付片 T2 补登（第 8 个 Nest：payment-service —— 同上缺席即闸失明）。
  {
    name: 'payment-service',
    controller: 'packages/payment-service/src/health/health.controller.ts',
    listFile: 'packages/payment-service/src/http/internal-token.middleware.ts',
    listIdents: ['DEFAULT_EXEMPT_PATHS'],
  },
] as const;

/**
 * 剥注释：**唯一真源** = `@fight-the-landlord/test-utils`（台账 N46 收敛；守卫语义见其 JSDoc）。
 *
 * ⚠️ **这一步是必需的，不是宽容**：本仓控制器的文档注释里**就会**出现装饰器文本
 * （例如「`@Get('live')` 在 `@Get()` 之前声明」这条告诫本身）。按原始文本提取会造出
 * **幽灵路由** ⇒ 闸在正确实现上假红 ⇒ 而假红最诱人的修法恰好是把闸改弱（R150 的教训）。
 */

/**
 * 从控制器源码里提取 `@Get(...)` 声明的**完整路径**。
 *
 * `@Get()` ⇒ `/api/health`（控制器前缀 `health`）；`@Get('live')` ⇒ `/api/health/live`。
 * 控制器前缀从 `@Controller('…')` 读，而不是写死 `health`（写死就又是一个真源）。
 */
export function healthRoutesOf(source: string): string[] {
  const code = stripComments(source);
  const prefixMatch = /@Controller\(\s*['"]([^'"]+)['"]\s*\)/.exec(code);
  const prefix = prefixMatch?.[1];
  if (!prefix) throw new Error("控制器里找不到 @Controller('…') —— 提取器失效");

  const routes: string[] = [];
  // `@Get()` | `@Get('live')` | `@Get("live")` —— 三种写法都要认（否则是静默漏扫）。
  const re = /@Get\(\s*(?:['"]([^'"]*)['"])?\s*\)/g;
  for (const m of code.matchAll(re)) {
    const suffix = m[1] ?? '';
    routes.push(suffix ? `/api/${prefix}/${suffix}` : `/api/${prefix}`);
  }
  return routes;
}

/** 从「清单」源码里提取字符串字面量数组（`IDENT = [ 'a', 'b' ] as const`）。 */
export function listOf(source: string, ident: string): string[] {
  // ⚠️ 前缀边界 `(?:^|[^A-Za-z0-9_])` 是**必需**的：`AUTH_PATHS` 是 `HEALTH_PATHS` 的
  //    **后缀**，没有边界时若 `HEALTH_PATHS` 定义在前，解析 `AUTH_PATHS` 会命中
  //    `HEALTH_PATHS = [...]` 那一段 ⇒ 拿到**另一个数组**的字面量而**照样绿**（静默假绿）。
  //    判别力自证见本文件「R462」那条的 ④。
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${ident}\\s*=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(stripComments(source));
  if (!m) throw new Error(`清单源码里找不到 ${ident} = [...] —— 提取器失效`);
  return [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!);
}

/**
 * 某个服务的免鉴权清单。
 *
 * ⚠️ R462：网关的清单是**按语义组合**出来的（`PUBLIC_PATHS = [...AUTH_PATHS, ...HEALTH_PATHS]`），
 * 所以这里要把**各组**字面量分别提取后拼接 —— `PUBLIC_PATHS` 自身没有字符串字面量，
 * 直接对它调 `listOf` 会得到空数组（本闸的「清单不是空集」正对照会当场红，不会静默变绿）。
 */
export function exemptPathsOf(source: string, idents: readonly string[]): string[] {
  return idents.flatMap((ident) => listOf(source, ident));
}

/** 不变式本体：返回**未被豁免**的路由（空数组 = 通过）。 */
export function unexemptRoutes(routes: string[], exempt: string[]): string[] {
  return routes.filter((r) => !exempt.includes(r));
}

/** 递归列出某个目录下的 `*.module.ts`（模块文件）。 */
function moduleFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) moduleFiles(p, out);
    else if (p.endsWith('.module.ts')) out.push(p);
  }
  return out;
}

/** 从模块源码里提取 `controllers: [A, B]` 里的**类名**。 */
export function controllerRegistrations(source: string): string[] {
  const m = /controllers\s*:\s*\[([^\]]*)\]/.exec(stripComments(source));
  if (!m) return [];
  return m[1]!
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 不变式本体：返回「被**多个**模块各自注册」的控制器（空数组 = 通过）。 */
export function multiplyRegistered(perModule: Array<{ file: string; controllers: string[] }>) {
  const seen = new Map<string, string[]>();
  for (const { file, controllers } of perModule) {
    for (const c of controllers) seen.set(c, [...(seen.get(c) ?? []), file]);
  }
  return [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([cls, files]) => `${cls} 被 ${files.length} 个模块注册：${files.join(' + ')}`);
}

describe('§2.4/R267：健康检查的每条路由都必须免鉴权（R293 的机械闸）', () => {
  it('八个服务的 `HealthController` 路由**全部**在各自的免鉴权清单里', () => {
    const report: string[] = [];

    for (const svc of SERVICES) {
      const controller = readFileSync(join(REPO, svc.controller), 'utf-8');
      const listSource = readFileSync(join(REPO, svc.listFile), 'utf-8');

      const routes = healthRoutesOf(controller);
      const exempt = exemptPathsOf(listSource, svc.listIdents);
      const listLabel = svc.listIdents.join(' + ');

      // 正对照①（R179）：扫到的必须是**本检出**的源码 —— 控制器里必须已经有 R267 的
      // `HealthService` 依赖（否则说明相对路径写错了一层、静默扫到了别的树或旧文件）。
      expect(controller, `${svc.name}: 控制器里没有 HealthService（扫错树了？）`).toMatch(
        /HealthService/,
      );
      // 正对照②：路由不是空集（否则本闸恒绿）。
      expect(routes.length, `${svc.name}: 一个 @Get 都没提取到`).toBeGreaterThan(0);
      // 正对照③：清单不是空集。
      expect(exempt.length, `${svc.name}: ${listLabel} 是空的`).toBeGreaterThan(0);

      const missing = unexemptRoutes(routes, exempt);
      if (missing.length > 0) {
        report.push(
          `${svc.name}: 控制器注册了 ${missing.join(', ')}，但 ${listLabel} 里没有 ⇒ ` +
            `无凭证访问会得到 401（存活面必须恒 200 / 就绪面被 compose healthcheck 直连）`,
        );
      }
    }

    expect(report).toEqual([]);
  });

  it('探针判别力自证：提取器真的读装饰器，且「未豁免」真的会被判出来', () => {
    // ① 提取器不是常量：注入第三种写法（`@Get('ready')`）⇒ 必须多出一条 `/api/health/ready`。
    const injected = `
      @Controller('health')
      export class HealthController {
        @Get('ready') ready() {}
        @Get() check() {}
        @Get('live') live() {}
      }
    `;
    const routes = healthRoutesOf(injected);
    expect(routes).toEqual(['/api/health/ready', '/api/health', '/api/health/live']);

    // ② 比较器真的能抓「未豁免」：拿注入出来的 `/api/health/ready` 去比对**真实**清单，
    //    必须判出违规（若比较器恒返回空数组，这条会红）。
    const realList = listOf(
      readFileSync(join(REPO, 'packages/room-service/src/http/internal-token.middleware.ts'), 'utf-8'),
      'DEFAULT_EXEMPT_PATHS',
    );
    expect(unexemptRoutes(['/api/health/ready'], realList)).toEqual(['/api/health/ready']);
    // ③ 反向：已豁免的路由**不得**被判违规（否则闸会在正确实现上红，最诱人的修法
    //    是把正对照删掉 —— 本仓 R150 的教训）。
    expect(unexemptRoutes(['/api/health', '/api/health/live'], realList)).toEqual([]);

    // ④ **注释里的装饰器不得产生幽灵路由**（本片实测：控制器注释里就写着
    //    「`@Get('live')` 在 `@Get()` 之前声明」，不剥注释会多出两条重复路由 ⇒ 假红）。
    const commentOnly = [
      "/** 讲一个不存在的端点 @Get('ghost') */",
      "@Controller('health')",
      'class C {',
      '  @Get() check() {}',
      '  // @Get("also-ghost")',
      '}',
    ].join('\n');
    expect(healthRoutesOf(commentOnly)).toEqual(['/api/health']);
  });

  it('不变式在**八个服务**上都成立，且清单里除健康检查外没有别的例外（豁免面不得扩大）', () => {
    /**
     * 清单里**允许**出现的非健康检查路径。
     *
     * 网关的 `PUBLIC_PATHS` 就是 §7.1 的白名单本身，那三条 auth 路由是规格要求的公开面
     * （本闸不重新裁决它们）；七个下游服务的 `DEFAULT_EXEMPT_PATHS` **只**为健康检查存在
     * （中间件的注释逐字写着「不得为业务路由开任何例外」）⇒ 它们的允许集是**空**。
     */
    const allowedExtra: Record<string, string[]> = {
      'api-gateway': ['/api/auth/login', '/api/auth/register', '/api/auth/refresh'],
      'user-service': [],
      'room-service': [],
      'game-service': [],
      'robot-service': [],
      'config-service': [],
      'currency-service': [],
      'payment-service': [],
    };

    for (const svc of SERVICES) {
      const listSource = readFileSync(join(REPO, svc.listFile), 'utf-8');
      const exempt = exemptPathsOf(listSource, svc.listIdents);
      const extra = allowedExtra[svc.name]!;

      const offenders = exempt.filter(
        (path) => !/^\/api\/health(\/|$)/.test(path) && !extra.includes(path),
      );
      expect(offenders, `${svc.name}: 豁免了一个既非健康检查、也不在允许集里的路径`).toEqual([]);
    }
  });

  /**
   * R462：把「源码里的字面量」与「产品**实际消费**的那份清单」钉在一起。
   *
   * 上面两条判据都从**源码文本**里解析清单 —— 如果有人新增一个字面量数组、却让
   * `PUBLIC_PATHS` 指向别的东西（或忘了组合进去），源码级判据会照样绿。这条用
   * **运行期导入**的 `PUBLIC_PATHS` 做交叉验证，并钉住「恰好五条」（§7.1 + R267）。
   */
  it('R462：产品消费的 `PUBLIC_PATHS` 恰好是 `AUTH_PATHS + HEALTH_PATHS`（且恰好五条）', () => {
    const source = readFileSync(join(REPO, 'packages/api-gateway/src/auth/public-paths.ts'), 'utf-8');
    const composed = exemptPathsOf(source, ['AUTH_PATHS', 'HEALTH_PATHS']);

    // ① 运行期真值 = 源码字面量的组合（防「改了字面量、产品却用另一个数组」）
    expect([...PUBLIC_PATHS]).toEqual(composed);
    // ② 组合关系本身（防「PUBLIC_PATHS 里偷偷多一条」）
    expect([...PUBLIC_PATHS]).toEqual([...AUTH_PATHS, ...HEALTH_PATHS]);
    // ③ 「恰好五条」（§7.1 + R267 的第 5 条 `…/live`）—— 之前只有注释在守它
    expect(PUBLIC_PATHS).toHaveLength(5);
    expect(AUTH_PATHS).toHaveLength(3);
    expect(HEALTH_PATHS).toHaveLength(2);

    // ④ **提取器的判别力自证**（R115）：`AUTH_PATHS` 是 `HEALTH_PATHS` 的**后缀** ——
    //    把 `HEALTH_PATHS` 写在前面时，两者仍必须各自解析出**自己**那个数组
    //    （没有前缀边界时 `listOf('AUTH_PATHS')` 会解析到 HEALTH 的字面量，而闸全绿）。
    const swapped = [
      "export const HEALTH_PATHS = ['/api/health', '/api/health/live'] as const;",
      "export const AUTH_PATHS = ['/api/auth/login'] as const;",
    ].join('\n');
    expect(exemptPathsOf(swapped, ['AUTH_PATHS', 'HEALTH_PATHS'])).toEqual([
      '/api/auth/login',
      '/api/health',
      '/api/health/live',
    ]);

    // ⑤ **精确匹配，不是前缀**（R293 的负对照形态，两处消费方共用这一份判定）：
    //    近邻路径必须**既不**免鉴权、**也不**被健康豁免 —— 一旦哪天改成 `startsWith`，
    //    这里会当场红（conformance 也在钉 `/api/healthz` 必须 401，但那只覆盖鉴权侧）。
    for (const nearMiss of ['/api/healthz', '/api/health/livex', '/api/auth/login-as-admin']) {
      expect(isPublicPath(nearMiss), `${nearMiss} 不得是公开路径`).toBe(false);
    }
    expect(isHealthPath('/api/healthz'), '/api/healthz 不得被限流豁免').toBe(false);
    expect(isHealthPath('/api/health/livex'), '/api/health/livex 不得被限流豁免').toBe(false);
    // 正对照：清单内的路径必须**真的**被判为豁免/公开（否则上面三条「不得」可能只是谓词恒假）
    expect(isPublicPath('/api/health/live')).toBe(true);
    expect(isHealthPath('/api/health/live')).toBe(true);
    expect(isPublicPath('/api/auth/register')).toBe(true);
    expect(isHealthPath('/api/auth/register')).toBe(false);
  });
});

/**
 * **同一类缺陷的第二个不变式**：一个控制器类**只能**被一个模块注册。
 *
 * 本片实测（R293）：`robot-service` 的 `HealthController` **同时**被 `AppModule` 与
 * `RobotModule` 注册。没有构造参数时无害（Nest 建两个实例、注册两次路由）；
 * 一旦它有了 `HealthService` 依赖，`RobotModule` 上下文解析不到那个 provider
 * ⇒ **容器启动即崩、crash-loop**：
 * `Nest can't resolve dependencies of the HealthController (?) … available in the RobotModule context`。
 * ⚠️ **所有单测都是绿的** —— 它们直接 `new HealthController(service)`，根本不经容器
 * （R216/R217/R239 同族：「DI 通了」与「容器真的起得来」是两条不同的命题）。
 */
describe('容器装配不变式：控制器类不得被多个模块注册（R293）', () => {
  it('八个服务里没有任何控制器被两个模块注册', () => {
    const services = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service'];
    const perModule: Array<{ file: string; controllers: string[] }> = [];
    /** ⚠️ 不变式必须**按服务**判定：八个服务各有一个同名的 `HealthController`（是八个不同的类）。 */
    const byService = new Map<string, Array<{ file: string; controllers: string[] }>>();

    for (const svc of services) {
      for (const file of moduleFiles(join(REPO, 'packages', svc, 'src'))) {
        const entry = {
          file: toPosixPath(file.slice(REPO.length)),
          controllers: controllerRegistrations(readFileSync(file, 'utf-8')),
        };
        perModule.push(entry);
        byService.set(svc, [...(byService.get(svc) ?? []), entry]);
      }
    }

    // 正对照①（R179）：真的扫到了本检出的模块文件与控制器（否则本闸恒绿）。
    expect(perModule.length, '一个 module 文件都没扫到').toBeGreaterThanOrEqual(5);
    const total = perModule.reduce((n, m) => n + m.controllers.length, 0);
    expect(total, '一个控制器注册都没提取到').toBeGreaterThanOrEqual(5);
    // 正对照②：`HealthController` 在**每个服务**里恰好被一个模块注册（= 该服务的 AppModule）。
    const healthRegs = perModule.filter((m) => m.controllers.includes('HealthController'));
    expect(healthRegs.map((m) => m.file).sort()).toEqual([
      'packages/api-gateway/src/app.module.ts',
      'packages/config-service/src/app.module.ts',
      'packages/currency-service/src/app.module.ts',
      'packages/game-service/src/app.module.ts',
      'packages/payment-service/src/app.module.ts',
      'packages/robot-service/src/app.module.ts',
      'packages/room-service/src/app.module.ts',
      'packages/user-service/src/app.module.ts',
    ]);

    const report = [...byService.entries()].flatMap(([svc, mods]) =>
      multiplyRegistered(mods).map((line) => `${svc}: ${line}`),
    );
    expect(report).toEqual([]);
  });

  it('探针判别力自证：重复注册真的会被判出来，且正常装配不会被误判', () => {
    const dup = multiplyRegistered([
      { file: 'a.module.ts', controllers: ['HealthController', 'AController'] },
      { file: 'b.module.ts', controllers: ['HealthController'] },
    ]);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toContain('HealthController');
    expect(dup[0]).toContain('a.module.ts');
    expect(dup[0]).toContain('b.module.ts');

    // 反向：每个类各注册一次 ⇒ **不得**判违规（否则闸在正确实现上假红）。
    expect(
      multiplyRegistered([
        { file: 'a.module.ts', controllers: ['HealthController'] },
        { file: 'b.module.ts', controllers: ['AController'] },
      ]),
    ).toEqual([]);
  });
});

/** 列出某个目录下的 `*.controller.ts`。 */
function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) controllerFiles(p, out);
    else if (p.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

/**
 * 从控制器源码里提取**全部 HTTP 路由**（动词 + 完整路径）。
 *
 * 前缀来自 `@Controller('…')`（`@Controller()` ⇒ 空前缀），全局前缀固定为 `/api`
 * （八个服务的 `main.ts` 都 `setGlobalPrefix('api')`）。
 */
export function httpRoutesOf(source: string): string[] {
  const code = stripComments(source);
  const ctrl = /@Controller\(\s*(?:['"]([^'"]*)['"])?\s*\)/.exec(code);
  if (!ctrl) throw new Error("找不到 @Controller(...) —— 提取器失效");
  const prefix = ctrl[1] ?? '';

  const routes: string[] = [];
  const re = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"]([^'"]*)['"])?\s*\)/g;
  for (const m of code.matchAll(re)) {
    const verb = m[1]!.toUpperCase();
    const suffix = m[2] ?? '';
    const path = `/api${prefix ? `/${prefix}` : ''}${suffix ? `/${suffix}` : ''}`;
    routes.push(`${verb} ${path}`);
  }
  return routes;
}

/** 不变式本体：返回「被注册了不止一次」的路由（空数组 = 通过）。 */
export function duplicateRoutes(
  perController: Array<{ file: string; routes: string[] }>,
): string[] {
  const seen = new Map<string, string[]>();
  for (const { file, routes } of perController) {
    for (const r of routes) seen.set(r, [...(seen.get(r) ?? []), file]);
  }
  return [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([route, files]) => `${route} 被 ${files.length} 个控制器注册：${files.join(' + ')}`);
}

/**
 * **不变式 3**：同一服务内不得有两条同路径同动词的路由。
 *
 * 本片实测（R294）：`api-gateway` 的 `GatewayController` 声明了 `@Get('health')`
 * （`@Controller()` ⇒ `/api/health`），而 `HealthController` 也声明 `@Get()`；
 * 两者在 `AppModule` 里**声明顺序**决定谁生效（Express 取先注册的）
 * ⇒ 对外返回的是那个**不含 `checks`** 的旧形状，§2.4/R267 在网关上静默失效。
 * ⚠️ 当时所有单测都是绿的（`health.test.ts` 只装配 `HealthController`）。
 */
describe('容器装配不变式：同一服务内不得有重复注册的路由（R294）', () => {
  it('八个服务里没有同路径同动词的重复路由', () => {
    const services = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service'];
    const report: string[] = [];
    let totalRoutes = 0;
    let totalControllers = 0;

    for (const svc of services) {
      const perController = controllerFiles(join(REPO, 'packages', svc, 'src')).map((file) => ({
        file: toPosixPath(file.slice(REPO.length)),
        routes: httpRoutesOf(readFileSync(file, 'utf-8')),
      }));
      totalControllers += perController.length;
      totalRoutes += perController.reduce((n, c) => n + c.routes.length, 0);
      report.push(...duplicateRoutes(perController).map((line) => `${svc}: ${line}`));
    }

    // 正对照（R179）：真的扫到了本检出的控制器与路由（否则本闸恒绿）。
    expect(totalControllers, '一个 *.controller.ts 都没扫到').toBeGreaterThanOrEqual(10);
    expect(totalRoutes, '一条 HTTP 路由都没提取到').toBeGreaterThanOrEqual(30);
    expect(report).toEqual([]);
  });

  it('探针判别力自证：重复路由真的会被判出来，且正常路由表不会被误判', () => {
    const dup = duplicateRoutes([
      { file: 'gateway.controller.ts', routes: ['GET /api/health'] },
      { file: 'health.controller.ts', routes: ['GET /api/health', 'GET /api/health/live'] },
    ]);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toContain('GET /api/health');
    expect(dup[0]).toContain('gateway.controller.ts');
    expect(dup[0]).toContain('health.controller.ts');

    // 反向：路径不同 ⇒ **不得**判违规（否则闸在正确实现上假红）。
    expect(
      duplicateRoutes([
        { file: 'a.ts', routes: ['GET /api/health'] },
        { file: 'b.ts', routes: ['GET /api/health/live'] },
      ]),
    ).toEqual([]);

    // 提取器真的读装饰器且真的算前缀：`@Controller()` ⇒ `/api/...`，
    // `@Controller('health')` ⇒ `/api/health/...`。
    expect(
      httpRoutesOf(`
        /** @Get('ghost') 注释里的不算 */
        @Controller()
        class G {
          @Get('rooms') rooms() {}
        }
      `),
    ).toEqual(['GET /api/rooms']);
    expect(
      httpRoutesOf(`
        @Controller('health')
        class H {
          @Get() check() {}
          @Get('live') live() {}
        }
      `),
    ).toEqual(['GET /api/health', 'GET /api/health/live']);
  });
});
