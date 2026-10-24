import { describe, expect, it } from 'vitest';
import { ADMIN_USERNAME_PATTERN, isAdminUsername } from './admin';

/**
 * ③ 财务后台 + RBAC + 审计 T1：`admin.ts`（用户名规则**单一真源**，规格 §0.3 ⚙️8）单测。
 *
 * 规则逐字：`^[a-z0-9][a-z0-9._-]{2,31}$` —— 首字符 `[a-z0-9]`、其后 2..31 位 `[a-z0-9._-]`，
 * 总长 3..32。**不做 trim、不做归一**：归一 = 调用方的 `toLowerCase()`（先归一、再跑本函数）；
 * 空白字符一律由正则直接拒绝；登录路径**不跑**正则（只归一 + 查无此人 ⇒ 401）。
 * 校验三处共用本函数：建号 / CLI（hatch）/ currency 侧 `X-Admin-Actor`。
 */

describe('ADMIN_USERNAME_PATTERN（⚙️8 逐字）', () => {
  it("导出形态 = string，逐字 '^[a-z0-9][a-z0-9._-]{2,31}$'", () => {
    expect(typeof ADMIN_USERNAME_PATTERN).toBe('string');
    expect(ADMIN_USERNAME_PATTERN).toBe('^[a-z0-9][a-z0-9._-]{2,31}$');
  });
});

describe('isAdminUsername（⚙️8：合法/非法矩阵；不做 trim）', () => {
  it('合法：首字符字母数字 + 后续 [a-z0-9._-]，总长 3..32', () => {
    for (const ok of [
      'abc', // 最短：3
      'a23', // 首字符可数字
      '0abc', // 纯数字起头也合法（首字符集含 [0-9]）
      'admin',
      'super_admin',
      'user.name',
      'user-name',
      'a1.2_3-4', // 三个标点都收
      'a'.repeat(32), // 最长：32
    ]) {
      expect(isAdminUsername(ok), ok).toBe(true);
    }
  });

  it('长度边界：2 / 33 拒，3 / 32 收', () => {
    expect(isAdminUsername('ab')).toBe(false);
    expect(isAdminUsername('a'.repeat(33))).toBe(false);
    expect(isAdminUsername('abc')).toBe(true);
    expect(isAdminUsername('a'.repeat(32))).toBe(true);
  });

  it('大写（含混合大小写）拒 —— 归一 = 调用方的 toLowerCase()，函数本体不吃大写', () => {
    for (const bad of ['Admin', 'ADMIN', 'adMin', 'aDmin']) {
      expect(isAdminUsername(bad), bad).toBe(false);
    }
  });

  it('全角拉丁 / 汉字 / 其它 Unicode（含零宽与 NBSP）拒', () => {
    for (const bad of ['ａｄｍｉｎ', '该用户', '😀abc', 'ad\u200bmin', 'ad\u00a0min']) {
      expect(isAdminUsername(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('空白：前导 / 尾随 / 中间（空格、制表、CR、LF）全拒 —— 不做 trim = 不宽容', () => {
    for (const bad of [
      ' admin',
      'admin ',
      'ad min',
      'ad\tmin',
      'ad\nmin',
      'ad\rmin',
      'admin\n', // 尾随 LF：JS 的 `$` 无 m 旗标时只匹配输入末尾 ⇒ 必须拒
      '\nadmin',
    ]) {
      expect(isAdminUsername(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('前导非字母数字（`.` / `-` / `_`）拒', () => {
    for (const bad of ['.abc', '-abc', '_abc', '.admin', '.a' /* 长度也不足 */]) {
      expect(isAdminUsername(bad), bad).toBe(false);
    }
  });

  it('非字符串一律拒（null / undefined / 数字 / 布尔 / 对象 / 数组）', () => {
    for (const bad of [null, undefined, 123, true, {}, [], ['admin']]) {
      expect(isAdminUsername(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('导出的 pattern 就是函数本体用的规则（两条真源互锁：改任一侧另一侧必红）', () => {
    const re = new RegExp(ADMIN_USERNAME_PATTERN);
    const samples = [
      'abc',
      'Admin',
      'ab',
      'a'.repeat(32),
      'a'.repeat(33),
      '.abc',
      ' admin',
      'admin\n',
      'user_name',
      'user-name',
      'user.name',
    ];
    for (const s of samples) {
      expect(re.test(s), JSON.stringify(s)).toBe(isAdminUsername(s));
    }
  });
});
