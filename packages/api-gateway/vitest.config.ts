import { defineConfig } from 'vitest/config';
// R561：全仓**唯一一份** DI 元数据插件（`scripts/vitest-plugins/emit-decorator-metadata.ts`）。
// R562：`reflect-metadata` 必须**先于**被装饰的类求值 —— 否则 `emitDecoratorMetadata`
// 发出的 `__metadata` 助手会因 `Reflect.metadata` 不存在而**静默 no-op**（元数据又变 undefined）。
import { emitDecoratorMetadata } from '../../scripts/vitest-plugins/emit-decorator-metadata';

export default defineConfig({
  plugins: [emitDecoratorMetadata()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['reflect-metadata'],
  },
});
