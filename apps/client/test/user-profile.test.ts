/**
 * 昵称 / 手机号：**来自登录响应**，与令牌一起持久化（Task 2R · 用户裁决 2026-09-27）。
 *
 * 为什么不再打接口（本条是本文件存在的理由）：Task 2 曾让客户端 `GET /api/users/me` 取昵称，
 * 但那条路由经网关**恒 401** —— 网关的 `forward()` 从不转发 `Authorization`，而 user-service
 * 侧挂的是 passport-jwt 守卫（**必须** Bearer）。它折成 `10007` 后**不产生 `console.error`**
 * ⇒ 探针与单测都看不见，顶栏会**永久**显示一行「昵称加载失败」。
 * 用户裁决：撤销路由，改回登录响应里的 `phone` / `nickname` 并持久化。
 *
 * 判别力说明：
 *  ① `displayName` 三级回落**每一级都测到**（昵称 → 手机号 → userId）：
 *     只测一级的话，「回落」这个词就没有判别力；
 *  ② **持久化往返**（② 组）：`applySession` → `loadSession()` → **新** store `hydrate()` 后
 *     `displayName` 仍是昵称 —— 这是「刷新页面名字不丢」的唯一证据；
 *  ③ `clearLocalSession()` 必须清掉资料（③ 组）—— 否则「登出 → 换个人登录」的瞬间，
 *     顶栏会显示**上一个人**的名字；
 *  ④ **源码级反断言**（④ 组）：新设计里根本不该有网络取数 ⇒ `auth.ts` / `lobby.vue`
 *     都**不得**再出现那条路径的入口名（含注释 —— 本仓不留悬空引用）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth';
import { clientConfig } from '../src/config';
import { clearSession, loadSession } from '../src/net/storage';
import { collectSourceFiles } from './helpers/source-scan';
import { installUniStub } from './helpers/uni-stub';

/** 服务端登录响应里的 `user`（`auth.service.ts` 的 `AuthResult.user` 逐字段抄）。 */
const USER = { id: 'u1', phone: '13800000000', nickname: '阿豆' };

beforeEach(() => {
  setActivePinia(createPinia());
  installUniStub();
  clearSession();
  clientConfig.token = '';
});

afterEach(() => {
  clearSession();
});

describe('① 登录响应里的资料进 store（applySession）', () => {
  it('有昵称 ⇒ displayName 用昵称（手机号也在，但昵称优先）', () => {
    const auth = useAuthStore();

    auth.applySession({ accessToken: 'a1', refreshToken: 'r1', user: USER });

    expect(auth.displayName).toBe('阿豆');
  });

  it('昵称是 null（服务端「没设过昵称」）⇒ 回落到手机号', () => {
    const auth = useAuthStore();

    auth.applySession({ accessToken: 'a1', refreshToken: 'r1', user: { ...USER, nickname: null } });

    expect(auth.displayName).toBe('13800000000');
  });

  it('两级都没有（开发身份 / 服务端没发）⇒ 回落到 userId（**不是空白、也不是编的名字**）', () => {
    const auth = useAuthStore();
    expect(auth.displayName, '开发身份下显示的就是 devUserId').toBe(clientConfig.devUserId);

    auth.applySession({ accessToken: 'a1', refreshToken: 'r1', user: { id: 'u-dev' } });
    expect(auth.displayName).toBe('u-dev');
  });
});

describe('② 持久化往返：刷新页面名字不丢（本条是唯一证据）', () => {
  it('applySession → loadSession() 拿得到两项 → 新 store hydrate() 后 displayName 仍是昵称', () => {
    const auth = useAuthStore();
    auth.applySession({ accessToken: 'a1', refreshToken: 'r1', user: USER });

    expect(loadSession(), '登录后两项必须与令牌**同一次写入**落盘').toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      userId: 'u1',
      phone: '13800000000',
      nickname: '阿豆',
    });

    // 模拟「刷新页面」：**另一个** store 实例从存储恢复（当前实例的状态不参与）
    setActivePinia(createPinia());
    const rehydrated = useAuthStore();
    expect(rehydrated.nickname, '新实例起步是空的（正对照：结论不可能来自共享状态）').toBe('');

    expect(rehydrated.hydrate()).toBe(true);
    expect(rehydrated.displayName, '刷新页面后名字不丢').toBe('阿豆');
  });
});

describe('③ 登出清资料：换个人登录不得看到上一个人的名字', () => {
  it('clearLocalSession 清掉两项，存储里的两项也随之清掉', () => {
    const auth = useAuthStore();
    auth.applySession({ accessToken: 'a1', refreshToken: 'r1', user: USER });
    expect(auth.displayName).toBe('阿豆');

    auth.clearLocalSession();

    expect(auth.nickname).toBe('');
    expect(auth.phone).toBe('');
    /**
     * ⚠️ 断言是 `''` 而**不是** `userId`：`clearLocalSession()` 把 `userId` 也清空了（既有行为）
     * ⇒ 三级回落全空。这条守的是「**不得留下上一个人的名字**」，不是「回落到 userId」
     *（后者由上面开发身份的用例守）。
     */
    expect(auth.displayName, '清干净 —— 不是上一个人的名字').toBe('');
    // 存储侧同样要清：否则下一次 `hydrate()` 会把上一个人的名字带回来
    expect(loadSession()).toBeNull();
  });
});

describe('④ 源码级反断言：不得再有资料取数（经网关恒 401 的那条路）', () => {
  it('auth.ts 与 lobby.vue 都不出现那条路径的入口名（含注释 —— 不留悬空引用）', () => {
    const files = collectSourceFiles();
    const targets = ['src/stores/auth.ts', 'src/pages/lobby/lobby.vue'];
    const banned: Array<[string, RegExp]> = [
      ['rest.me', /rest\.me\b/],
      ['loadProfile', /\bloadProfile\b/],
    ];

    const offenders: string[] = [];
    for (const path of targets) {
      const file = files.find((f) => f.path === path);
      // 存在性：读不到文件不许静默空过（否则本组恒绿）
      expect(file, `扫描器必须真的读到 ${path}`).toBeDefined();
      for (const [name, re] of banned) {
        if (re.test(file!.content)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders, '资料取数已撤销 ⇒ 两个消费点都不得留有它的入口名').toEqual([]);

    // 判别力自证：同一批正则在**本该命中**的合成样本上必须命中 ——
    // 否则上面的「零违规」可能只是正则写错。
    const synthetic = 'const p = await rest.me();\nawait this.loadProfile();';
    for (const [name, re] of banned) {
      expect(re.test(synthetic), `${name} 的正则必须命中合成样本`).toBe(true);
    }
  });
});
