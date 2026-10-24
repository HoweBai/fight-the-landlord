import { describe, expect, it } from 'vitest';
import { stripComments } from '../src/strip-comments';

/**
 * 注释剥离器的**行为钉**（台账 N46 收敛后的唯一真源）。
 *
 * ⚠️ 前两条用例是这个文件存在的理由 —— 它们是 N46 登记的两处**实测可复现假阴性**
 * 的镜像：收敛前，room-service / user-service 的无守卫副本会把**真违规吃掉**；
 * 收敛后（守卫语义）必须看得见。其余各条钉住常规剥离行为与**已知边界**。
 */
describe('stripComments：守卫语义（N46 两处假阴性的镜像）', () => {
  it('URL 在同一行也不得吃掉后半段 —— room-service 假阴性的镜像', () => {
    const src = 'const url = "http://evil/api/games";';
    // 收敛前（无守卫副本）：剥成 `const url = "http:` ⇒ 内部 HTTP 判据看不见 ⇒ 假阴性。
    expect(stripComments(src)).toContain('/api/games');
  });

  it('URL 后面的真违规不得被吃掉 —— user-service E7 假阴性的镜像', () => {
    const src = 'const u = "http://x"; synchronize: true';
    expect(stripComments(src)).toMatch(/synchronize\s*:\s*true/);
  });
});

describe('stripComments：常规剥离', () => {
  it('行注释（行尾）消失、代码保留（含 `(^|[^:])` 的 `^` 分支：行首注释）', () => {
    expect(stripComments('const a = 1; // 行注释')).not.toContain('行注释');
    expect(stripComments('const a = 1; // 行注释')).toContain('const a = 1;');
    expect(stripComments('// 行首注释\nconst b = 2;')).not.toContain('行首注释');
    expect(stripComments('// 行首注释\nconst b = 2;')).toContain('const b = 2;');
  });

  it('块注释 / JSDoc 消失、同行代码保留', () => {
    expect(stripComments('/* 块注释 */const a = 1;')).not.toContain('块注释');
    expect(stripComments('/* 块注释 */const a = 1;')).toContain('const a = 1;');
    expect(stripComments('/**\n * 文档注释\n */\nconst b = 2;')).not.toContain('文档注释');
    expect(stripComments('/**\n * 文档注释\n */\nconst b = 2;')).toContain('const b = 2;');
  });

  it('URL 照常保留、它后面的真行注释照常剥（`:` 守卫的判别力正/负两侧）', () => {
    const out = stripComments('const base = "https://x.example/a"; // 真注释');
    expect(out).toContain('https://x.example/a');
    expect(out).not.toContain('真注释');
  });

  it('顺序：先块后行 —— 行注释里的块注释开标记不得吃掉后面的真代码', () => {
    const out = stripComments('const a = 1; // 说明里提了块注释开标记\nconst b = 2;');
    expect(out).toContain('const b = 2;');
    expect(out).not.toContain('块注释开标记');
  });
});

describe('stripComments：已知边界（如实钉住当前行为 —— 改动它会红，逼一次评审）', () => {
  it('引号不感知：字符串里非 `:` 前缀的 `//` 会被误剥（本仓被服务扫描面无此形态）', () => {
    expect(stripComments("const p = 'a//b';")).not.toContain('a//b');
  });
});
