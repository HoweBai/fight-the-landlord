/**
 * Vitest 用插件：让**测试环境**发出 `design:paramtypes` 等 DI 元数据（N41 / 切片 P18）。
 *
 * ─── ① 为什么不能用 esbuild 的选项 ─────────────────────────────────
 * Vitest 默认用 esbuild 转译 `.ts`，而 esbuild **不支持** `emitDecoratorMetadata`：
 * 它的公开选项类型（`node_modules/esbuild/lib/main.d.ts` 的 `TransformOptions`）里
 * **没有**这个字段 —— 不是「没打开」，是**根本不存在**。
 * 于是 `Reflect.getMetadata('design:paramtypes', X)` 在本仓测试环境**恒为 `undefined`**，
 * Nest 的反射式构造注入拿不到依赖 ⇒ 5 个测试文件曾用 7 处
 * `Reflect.defineMetadata('design:paramtypes', …)` 手工补回**期望的依赖清单**：
 * 产品侧一旦漏 `@Inject` 或改了构造参数顺序，测试**照样绿**（测的是刚写进去的那份元数据）。
 *
 * ─── ② 为什么零新依赖 ────────────────────────────────────────────
 * `typescript` 是**每个** Nest 包已有的 devDependency（本仓用 `tsc` 构建），
 * 它的编译器 API `transpileModule` 支持 `experimentalDecorators` +
 * `emitDecoratorMetadata`。⇒ 无需引入 `@swc/core` / `unplugin-swc`，
 * 也无需动 `pnpm-lock.yaml`（本片按 R561 裁决：不值得为此动 lockfile）。
 *
 * ─── ③ 与 esbuild 的语义差异风险，以及它由什么兜住 ─────────────────
 * 走 `transpileModule` 的文件不再由 esbuild 转译 ⇒ 两者在**降级/降级产物**上可能有细微差异
 * （最典型的是 `useDefineForClassFields` 的默认值）。这里显式对齐 esbuild 的默认
 * （`useDefineForClassFields: false`；`target: ES2022` 下 ts 的默认是 `true`），
 * 把差异面压到最小；其余由 **R566 的验证兜住**：5 个包「用例数只增不减 + 全绿」。
 *
 * ─── ④ 只处理该处理的文件 ────────────────────────────────────────
 * 只对「工作区内、`.ts` 结尾、不含 `node_modules`、且源码里真的出现
 * `@Injectable|@Controller|@Module|@Inject`（本仓的 de-metadata-able 装饰器集合）」
 * 的文件生效；其余一律返回 `null`（不干预），避免无谓的整仓转译开销。
 *
 * 全仓**只有这一份**（R561）：5 个包的 `vitest.config.ts` 各自 import 它 ——
 * 在包里各抄一份就是第二个真源（本仓已为此付过多次代价）。
 */
import ts from 'typescript';
import type { Plugin } from 'vite';

/** 与「本项目需要 DI 元数据」等价的源码标记（本仓真实用法见各 `*.module.ts` / `*.controller.ts`）。 */
const DECORATOR_MARKER = /@(Injectable|Controller|Module|Inject)\b/;

/** 编译选项：对齐 esbuild 的默认，把语义差异压到最小。 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  // ⚠️ esbuild 的默认是 **false**（用赋值语义而非 `Object.defineProperty`），
  // 而 ts 在 `target: ES2022` 下的默认是 **true**。不显式对齐就会让本插件转译过的
  // 类与其余文件在「字段初始化时机」上行为不一致 —— 那正是 R566 要求量化的那类差异。
  useDefineForClassFields: false,
  sourceMap: true,
};

/**
 * 纯函数形态的「要不要/怎么转译」判据，便于独立复核与（将来的）单测调用。
 *
 * @returns 转译后的 JS；`null` 表示「不该由本插件处理，交给下游（esbuild）原样处理」。
 */
export function transpileWithMetadata(id: string, code: string): string | null {
  const cleanId = id.replace(/\?.*$/, '');
  // 只处理本工作区自己的 TS：`node_modules` 里的库早已是编译好的 JS，
  // 转译它们既无必要（没有我们要的源码装饰器）又极其昂贵。
  if (!cleanId.endsWith('.ts') || cleanId.includes('node_modules')) return null;
  if (!DECORATOR_MARKER.test(code)) return null;

  return ts.transpileModule(code, {
    compilerOptions: COMPILER_OPTIONS,
    fileName: cleanId,
  }).outputText;
}

/**
 * 造一个插件实例。
 *
 * ⚠️ 必须 `enforce: 'pre'`：要赶在 Vite 内置的 esbuild 转译**之前**把
 * `__decorate` / `__metadata` 助手发出；esbuild 随后只做类型剥离（它不产生这些助手，
 * 也不会删掉它们）。
 *
 * ⚠️ 每个包**调用**本工厂得到自己的实例（插件对象有状态），但**实现只有这一份**。
 */
export function emitDecoratorMetadata(): Plugin {
  /** 逐文件缓存：同一进程里同一份源码只转译一次（`transpileModule` 不便宜）。 */
  const cache = new Map<string, { source: string; output: string }>();

  return {
    name: 'p18-emit-decorator-metadata',
    enforce: 'pre',
    transform(code, id) {
      const hit = cache.get(id);
      if (hit && hit.source === code) return { code: hit.output, map: null };

      const output = transpileWithMetadata(id, code);
      if (output === null) return null;

      cache.set(id, { source: code, output });
      return { code: output, map: null };
    },
  };
}

export default emitDecoratorMetadata;
