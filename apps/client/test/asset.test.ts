/**
 * 静态资源版本化入口（项 7）。
 *
 * vitest 以 dev 形态运行（`import.meta.env.PROD === false`）⇒ `assetUrl()` 原样返回；
 * 生产形态（带版本 query）由纯函数 `appendVersionQuery` 直接锁定，两条路径合起来
 * 保证「dev 不带、prod 带」且不带第二遍。
 */
import { describe, expect, it } from 'vitest';
import { appendVersionQuery, assetUrl, tableAsset } from '../src/asset';

describe('appendVersionQuery（生产形态拼接）', () => {
  it('给 /static/ 资源追加 ?v=<version>', () => {
    expect(appendVersionQuery('/static/ui/bg.png', '0.1.0-abc1234')).toBe(
      '/static/ui/bg.png?v=0.1.0-abc1234',
    );
  });

  it('非 /static 前缀原样返回（远程 URL 等不由本机制管）', () => {
    expect(appendVersionQuery('https://cdn.example.com/a.png', '1')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(appendVersionQuery('/api/avatar', '1')).toBe('/api/avatar');
  });

  it('已带 query 的路径不重复追加', () => {
    expect(appendVersionQuery('/static/a.png?existing=1', '1')).toBe('/static/a.png?existing=1');
  });

  it('版本串为空（dev 注入值）时原样返回', () => {
    expect(appendVersionQuery('/static/a.png', '')).toBe('/static/a.png');
  });

  it('项 6：分包资源 /pages/<root>/static/ 同样追加版本 query', () => {
    expect(appendVersionQuery('/pages/table/static/cards/SpadeOne.png', '0.1.0-abc')).toBe(
      '/pages/table/static/cards/SpadeOne.png?v=0.1.0-abc',
    );
  });
});

describe('tableAsset（牌桌分包资源）', () => {
  it('dev 形态：拼出分包绝对路径且不带 query', () => {
    expect(import.meta.env.PROD).toBe(false);
    expect(tableAsset('cards/SpadeOne.png')).toBe('/pages/table/static/cards/SpadeOne.png');
    expect(tableAsset('audio/MusicEx_Normal.mp3')).toBe(
      '/pages/table/static/audio/MusicEx_Normal.mp3',
    );
  });
});

describe('assetUrl（环境分发）', () => {
  it('测试环境 = dev 形态：任何资源都不带版本 query', () => {
    expect(import.meta.env.PROD).toBe(false);
    // 样例必须是主包真实资源（项 6 后 av/ 已随 table 分包迁走）
    expect(assetUrl('/static/audio/MusicEx_Welcome.mp3')).toBe(
      '/static/audio/MusicEx_Welcome.mp3',
    );
    expect(assetUrl('/static/ui/count-tile.png')).toBe('/static/ui/count-tile.png');
  });
});
