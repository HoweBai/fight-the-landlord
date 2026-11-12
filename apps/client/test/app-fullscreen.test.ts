import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('src/App.vue', 'utf8');

describe('App 全屏（运行时兜底）', () => {
  it('APP-PLUS 下 onLaunch/onShow 调 plus.navigator.setFullscreen(true)', () => {
    expect(app).toContain('#ifdef APP-PLUS');
    expect(app).toContain('setFullscreen?.(true)');
    expect(app).toContain("typeof plus !== 'undefined'");
    // 接线闸（防「定义了 enterFullscreen 但没接」死代码）
    expect(app).toMatch(/onLaunch\(\)\s*\{\s*enterFullscreen\(\)/);
    expect(app).toMatch(/onShow\(\)\s*\{\s*enterFullscreen\(\)/);
  });
});
