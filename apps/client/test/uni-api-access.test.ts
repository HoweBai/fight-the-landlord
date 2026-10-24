/**
 * 机械判据：**`uni.xxx(...)` 必须是直接的成员表达式，不得把 `uni` 读进变量再调用**。
 *
 * ## 为什么这条闸存在（实测坑，Task 3）
 *
 * H5 的**发行构建默认开启摇树**，`@dcloudio/uni-h5-vite` 在这种模式下只往页面注入一个
 * **空的占位对象**：`window.uni = {}`（`uni-h5-vite/dist/plugins/pagesJson.js` 的
 * `registerGlobalCode`；实测产物里就是 `window.uni={}`，且整个 H5 bundle 里没有任何
 * uni API 的实现）。真正让 `uni.*` 可用的是它**同时启用**的 `uni:h5-inject` ——
 * 把源码里 `uni.xxx(...)` 的**直接调用**改写成 `import { xxx } from '@dcloudio/uni-h5'`。
 *
 * 于是有一个极难发现的失效形态：写成 `const api = uni; api.getStorageSync(...)` 时，
 *   - **dev（探针）**：`window.uni` 是真对象 ⇒ 一切正常；
 *   - **发行版**：改写扫不到 ⇒ `api.getStorageSync` 是 `undefined` ⇒ **静默失效**
 *     （存储不落地、`reLaunch` 不跳页）。
 *
 * 本闸把「直接成员表达式」钉死；`typeof uni` 这类**存在性判定**是允许的（它本来
 * 就不该被改写）。判别力自证（正反样本）是本仓硬规矩：闸不得因为写法变化而恒绿。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

/** 找出「把 uni 全局读进变量 / 用可选链调用」的写法。返回违规描述。 */
function uniAliasOffenders(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const patterns: { re: RegExp; why: string }[] = [
    // `const api = uni` / `x = uni;`（`uni.xxx()` 是**直接调用**，放行；比较也不命中）
    { re: /[\w$]+\s*=\s*uni\b(?!\s*\.)/g, why: '把 uni 赋给变量（改写扫不到）' },
    // `return uni;` —— 但 `return uni.xxx()` 是**直接调用**，放行
    { re: /\breturn\s+uni\b(?!\s*\.)/g, why: '把 uni 作为值返回（改写扫不到）' },
    { re: /uni\?\./g, why: '可选链调用 uni?.xxx（不在直接调用的改写范围）' },
  ];
  const offenders: string[] = [];
  for (const line of source.split('\n')) {
    for (const { re, why } of patterns) {
      re.lastIndex = 0;
      if (re.test(line)) offenders.push(`${why}: ${line.trim()}`);
    }
  }
  return offenders;
}

describe('uni 全局的访问方式（H5 发行构建摇树的前提）', () => {
  const sources = collectSourceFiles();

  it('判别力正对照：合成的别名写法必须被判违规，直接调用/存在性判定必须放行', () => {
    // 违规样本
    expect(uniAliasOffenders('const api = uni;')).toHaveLength(1);
    expect(uniAliasOffenders('const api = uni as unknown as Uni;')).toHaveLength(1);
    expect(uniAliasOffenders('function getUni() { return uni; }')).toHaveLength(1);
    expect(uniAliasOffenders('uni?.reLaunch({ url });')).toHaveLength(1);
    // 合法样本
    expect(uniAliasOffenders('if (typeof uni === "undefined") return;')).toEqual([]);
    expect(uniAliasOffenders('uni.reLaunch({ url });')).toEqual([]);
    expect(uniAliasOffenders('uni.setStorageSync(key, value);')).toEqual([]);
    expect(uniAliasOffenders('const platform = uni.getSystemInfoSync().uniPlatform;')).toEqual([]);
  });

  it('src/** 里没有把 uni 读进变量再调用的写法', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const offender of uniAliasOffenders(file.content)) {
        offenders.push(`${file.path}: ${offender}`);
      }
    }
    expect(
      offenders,
      `这些写法会让 H5 发行构建的 uni API 注入失效（dev 正常、发行版静默失效）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('扫描器自证：src/** 里确实有直接调用（否则上一条恒绿）', () => {
    const text = sources.map((f) => f.content).join('\n');
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(text.match(/\buni\.[A-Za-z]/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    // 四处关键 API 都得是直接调用（存储 / 页面栈 / 平台判定 / 网络请求）
    expect(text).toContain('uni.setStorageSync(');
    expect(text).toContain('uni.reLaunch(');
    expect(text).toContain('uni.getSystemInfoSync(');
    // P17：REST 适配器（net/http.ts）—— 小程序端唯一的网络出口
    expect(text).toContain('uni.request(');
  });
});
