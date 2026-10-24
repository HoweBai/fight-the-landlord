/**
 * ➊ 的机械判据（spec §5-➊「错误码 → 人话映射有单测」+ R651）。
 *
 * 判别力：这里逐条对账「码 → 文案」，并钉住两件事：
 *  ① 未知码兜底**中性化**（不再把内部码带给玩家；排查走 `net/errors.ts` 的未知码上报）；
 *  ② 该模块是**纯查表**：只允许 import `ErrCode`（不得 import store / net / 任何规则面）。
 */
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { authErrorMessage } from '../src/net/copy';
import { collectSourceFiles } from './helpers/source-scan';

describe('➊ 登录/注册错误码 → 人话文案', () => {
  it.each([
    [ErrCode.PHONE_TAKEN, '这个手机号已经注册过了，直接登录吧'],
    [ErrCode.BAD_CREDENTIALS, '手机号或密码不正确'],
    [ErrCode.USER_BANNED, '该账号已被封禁，如有异议请联系客服'],
    [ErrCode.DEVICE_MISMATCH, '账号已绑定其他设备，如需在本机使用请联系管理员解绑'],
    [ErrCode.USER_NOT_FOUND, '该账号不存在，请先注册'],
    [ErrCode.BAD_PARAM, '请检查填写的内容'],
    [ErrCode.RATE_LIMITED, '操作太频繁，请稍后再试'],
    [ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试'],
    // 客户端接入片（C34）：§0 全串（唯一真源）——登录 toast / socket 兜底 / 两死态组件
    // 四面全部复用它；表里这一条就是「怎么说给玩家听」的唯一出处。
    [ErrCode.CLIENT_DISABLED, '当前客户端已暂停服务，请稍后再试或更换客户端'],
    [ErrCode.UNAUTHENTICATED, '登录状态已失效，请重新登录'],
    [ErrCode.TOKEN_EXPIRED, '登录状态已失效，请重新登录'],
    [ErrCode.TOKEN_INVALID, '登录状态已失效，请重新登录'],
  ])('码 %i → %s', (code, copy) => {
    expect(authErrorMessage(code, '登录')).toBe(copy);
  });

  /**
   * 风控 T8 / K1：封禁文案追加申诉指引 —— 「如有异议请联系客服」。
   * 引导句的措辞不判定，但**这根串必须出现**（K1 对玩家的可见承诺）。
   */
  it('封禁文案包含申诉指引「如有异议请联系客服」（风控 T8 / K1）', () => {
    expect(authErrorMessage(ErrCode.USER_BANNED, '登录')).toContain('如有异议请联系客服');
  });

  /**
   * 客户端接入片（C34）：10008 的文案 = §0 全串 —— **跨 label 恒等**
   *（登录面传 '登录'、socket 兜底传 '连接'，都不许出现在结果里：它在表里 ⇒ label
   * 只参与未知码兜底，不得参与已知码文案）。
   */
  it('客户端接入片 C34：10008 文案 = §0 全串（单一真源，label 不参与）', () => {
    expect(authErrorMessage(ErrCode.CLIENT_DISABLED, '登录')).toBe(
      '当前客户端已暂停服务，请稍后再试或更换客户端',
    );
    expect(authErrorMessage(ErrCode.CLIENT_DISABLED, '连接')).toBe(
      '当前客户端已暂停服务，请稍后再试或更换客户端',
    );
  });

  it('未知码兜底中性化（不再带 code）', () => {
    expect(authErrorMessage(99999, '登录')).toBe('操作未成功，请稍后重试');
    expect(authErrorMessage(99999, '注册')).toBe('操作未成功，请稍后重试');
  });

  it('文案里不得出现规则词汇（§12.1：前端零规则语义）', () => {
    const banned = ['牌型', '倍数', '底分', '炸弹', '顺子', '地主'];
    const offenders = banned.filter((w) => authErrorMessage(ErrCode.BAD_CREDENTIALS, '登录').includes(w));
    expect(offenders).toEqual([]);
  });

  it('纯查表：模块只 import protocol 的 ErrCode', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/net/copy.ts');
    expect(file, 'copy.ts 必须在源码扫描集合里').toBeDefined();
    const targets = [...file!.content.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(
      (m) => m[1]!,
    );
    expect(targets.sort()).toEqual(['@fight-the-landlord/protocol']);
    // 正对照：扫描器对合成样本确实能读出 import 目标
    const synthetic = `import { ErrCode } from '@fight-the-landlord/protocol';import { x } from '../stores/game';`;
    expect(
      [...synthetic.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!).sort(),
    ).toEqual(['../stores/game', '@fight-the-landlord/protocol']);
  });
});
