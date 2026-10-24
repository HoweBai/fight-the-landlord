/**
 * 配置解析的契约断言。
 *
 * 这几个函数决定了「客户端连到哪里」，而连错地址是最难查的一类问题：
 * 端到端测试里 `resolveEndpoint` 一度回退到 `window.location.origin`
 * （jsdom 下是 `http://localhost:3000`），于是请求发给了不存在的服务，ack 永远不来。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAMESPACE,
  SOCKET_PATH,
  buildSocketUrl,
  resolveEndpoint,
} from '../src/net/transport';
import { buildSocketAuth, clientConfig } from '../src/config';
import { installUniStub } from './helpers/uni-stub';

describe('传输配置', () => {
  it('显式 endpoint 优先于环境变量', () => {
    expect(resolveEndpoint('http://example.test:9999')).toBe('http://example.test:9999');
  });

  it('未显式给出时使用环境变量（开发/测试期指向 mock）', () => {
    // .env.development / .env.test 里设置了 VITE_WS_ENDPOINT=http://localhost:3400
    expect(resolveEndpoint()).toBe('http://localhost:3400');
  });

  it('URL = origin + namespace，重复拼接是幂等的', () => {
    expect(buildSocketUrl('http://localhost:3400', DEFAULT_NAMESPACE)).toBe(
      'http://localhost:3400/ws/ddz',
    );
    expect(buildSocketUrl('http://localhost:3400/', DEFAULT_NAMESPACE)).toBe(
      'http://localhost:3400/ws/ddz',
    );
    expect(buildSocketUrl('http://localhost:3400/ws/ddz', DEFAULT_NAMESPACE)).toBe(
      'http://localhost:3400/ws/ddz',
    );
  });

  it('namespace 与 path 符合 §6.1（/ws/ddz、/socket.io）', () => {
    expect(DEFAULT_NAMESPACE).toBe('/ws/ddz');
    expect(SOCKET_PATH).toBe('/socket.io');
  });

  it('无 token 时用开发身份，有 token 时用真实网关注入的 token（§5.1/§6.1）；两者恒带端标识', () => {
    /**
     * 客户端接入片（C31）：`clientPlatform` 是握手身份的一部分（网关端闸在验签前读它）。
     * 期望值 'h5' 的机理：vitest setup 装了全局 `uni` 替身、默认 `uniPlatform = 'web'`
     * （`test/helpers/uni-stub.ts:243-245` 的 `UniStubOptions.platform` 缺省值）
     * ⇒ `detectPlatform() === 'browser'` ⇒ 映射 'h5'
     *（注意：**不是**「测试环境没有 uni」——替身在场且就是 H5 的真实取值 'web'）。
     */
    expect(buildSocketAuth('')).toEqual({ userId: clientConfig.devUserId, clientPlatform: 'h5' });
    // 设备绑定片：真实网关路径恒随一枚域内 deviceId（8..64、[A-Za-z0-9._-]），供 verifyClient 的 risk:binding 闸比对
    const authedH5 = buildSocketAuth('jwt-abc') as Record<string, unknown>;
    expect(authedH5.token).toBe('jwt-abc');
    expect(authedH5.clientPlatform).toBe('h5');
    expect(authedH5.deviceId as string).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('客户端接入片 C31：clientPlatform 随平台（app ⇒ app；mp-weixin ⇒ 不含该键）', () => {
    installUniStub({ platform: 'app' });
    expect(buildSocketAuth('')).toEqual({ userId: clientConfig.devUserId, clientPlatform: 'app' });
    const authedApp = buildSocketAuth('jwt-abc') as Record<string, unknown>;
    expect(authedApp.token).toBe('jwt-abc');
    expect(authedApp.clientPlatform).toBe('app');
    expect(authedApp.deviceId as string).toMatch(/^[A-Za-z0-9._-]{8,64}$/);

    installUniStub({ platform: 'mp-weixin' });
    expect(buildSocketAuth('')).toEqual({ userId: clientConfig.devUserId });
    const authedMp = buildSocketAuth('jwt-abc') as Record<string, unknown>;
    expect(authedMp.token).toBe('jwt-abc');
    expect(authedMp.clientPlatform).toBeUndefined(); // mp-weixin：未识别端不臆造标识
    expect(authedMp.deviceId as string).toMatch(/^[A-Za-z0-9._-]{8,64}$/);

    /**
     * ⚠️ 登记（不测）：「重连重发」auth 是 socket.io-client 的**内部行为**
     *（重连时直接复用建连时的 auth 对象，不经工厂）——单测不可达。
     * 本节只钉「建连」那一次：工厂只在 GameClient 构造时被调一次（`socket.ts:414-421`）。
     */
    installUniStub(); // 复原默认 'web'（本文件其余断言按浏览器平台理解）
  });
});
