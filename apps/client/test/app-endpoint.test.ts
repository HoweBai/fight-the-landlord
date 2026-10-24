/**
 * P26（R552/R636）：`scripts/build-app.mjs` 的**可注入部分**。
 *
 * 脚本本身要 spawn 真实构建（慢、且需要 uni CLI），所以把三件事抽成纯函数复用同一份逻辑：
 *  ① 参数解析（缺参 / 多参 / 未知 flag ⇒ 报错信息，不猜）；② origin 归一；③ 端点派生。
 *  ④ 产物级 P19 扫描 `scanForNodeUrl` 用**合成样本**验证（真构建不在单测里跑）。
 *
 * ⚠️ 脚本的纯函数一律 **throw**（不 `process.exit`）——否则本文件会把 vitest 进程杀掉。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error —— 该脚本是 .mjs（零构建），类型由本测试的用法隐式约束
import { normalizeOrigin, parseArgs, deriveEndpoints, scanForNodeUrl } from '../../../scripts/build-app.mjs';

describe('build-app.mjs：参数与端点（R552 同形）', () => {
  it('缺 <host:port> ⇒ 报错且不猜默认值', () => {
    expect(() => parseArgs([])).toThrow(/缺少 <host:port>/);
  });

  it('多给位置参数 / 未知 flag ⇒ 报错', () => {
    expect(() => parseArgs(['a:1', 'b:2'])).toThrow(/只接受一个/);
    expect(() => parseArgs(['a:1', '--watch'])).toThrow(/未知参数/);
  });

  it('--dev 被识别，且不参与位置参数计数', () => {
    expect(parseArgs(['192.168.1.5:3000', '--dev'])).toEqual({ host: '192.168.1.5:3000', dev: true });
    expect(parseArgs(['api.example.com'])).toEqual({ host: 'api.example.com', dev: false });
  });

  it('origin 归一：补 http:// / 去尾斜杠 / 保留 https', () => {
    expect(normalizeOrigin('192.168.1.5:3000/')).toBe('http://192.168.1.5:3000');
    expect(normalizeOrigin('https://gw.example.com')).toBe('https://gw.example.com');
    expect(normalizeOrigin('api.example.com')).toBe('http://api.example.com');
  });

  it('IPv6 字面量被拒（请用域名或 IPv4）', () => {
    expect(() => normalizeOrigin('[::1]:3000')).toThrow();
  });

  it('<host:port> 形态不合法 ⇒ 报错', () => {
    expect(() => normalizeOrigin('a b:3000')).toThrow(/形态不合法/);
    expect(() => normalizeOrigin('host:999999')).toThrow(/形态不合法/);
  });

  it('一个参数派生两个端点（与 build-mp-weixin.mjs 逐字同形）', () => {
    expect(deriveEndpoints('http://192.168.1.5:3000')).toEqual({
      VITE_API_BASE: 'http://192.168.1.5:3000/api',
      VITE_WS_ENDPOINT: 'http://192.168.1.5:3000',
    });
    // 生产形态（真用例）：https 原样保留
    expect(deriveEndpoints('https://api.example.com')).toEqual({
      VITE_API_BASE: 'https://api.example.com/api',
      VITE_WS_ENDPOINT: 'https://api.example.com',
    });
  });
});

describe('产物级 P19 回归闸（App 的 plus 运行时同样没有 Node 的 url）', () => {
  it('扫到 require("url") 或 pathToFileURL ⇒ 报出该文件', () => {
    const files = {
      'app.js': 'var x = 1;',
      'common/vendor.js': 'const u = require("url").pathToFileURL(__filename).href;',
    };
    expect(scanForNodeUrl(files)).toEqual(['common/vendor.js']);
  });

  it('干净产物 ⇒ 空数组（负对照）', () => {
    expect(scanForNodeUrl({ 'app.js': 'var x = 1; console.log(1);' })).toEqual([]);
  });
});
