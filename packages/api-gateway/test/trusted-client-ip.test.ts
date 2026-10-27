import { describe, expect, it } from 'vitest';
import {
  clientIpFrom,
  normalizeAddress,
  parseTrustProxy,
  requestClientIp,
} from '../src/http/trusted-client-ip';

const EDGE = '172.28.0.250';

describe('可信客户端 IP（R1204–R1207）', () => {
  it('C1 信任表为空 ⇒ 忽略头（= 现状）', () => {
    expect(clientIpFrom({ 'x-forwarded-for': '9.9.9.9' }, '172.28.0.9', [])).toBe('172.28.0.9');
  });

  it('C2 对端可信 + XFF ⇒ 取最右不可信那节；**客户端伪造的前缀不改变结果**', () => {
    const trust = parseTrustProxy(EDGE);
    expect(clientIpFrom({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, EDGE, trust)).toBe('203.0.113.7');
    // 前缀伪造：多一个更左的假地址，结果**不变**
    expect(clientIpFrom({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, 203.0.113.7' }, EDGE, trust)).toBe('203.0.113.7');
  });

  it('C3 对端**不可信** ⇒ 完全不看头（B5 的单测半边）', () => {
    expect(clientIpFrom({ 'x-forwarded-for': '9.9.9.9' }, '172.28.0.9', parseTrustProxy(EDGE))).toBe('172.28.0.9');
  });

  it('C4 归一化：::ffff:1.2.3.4 与 1.2.3.4 同一个桶', () => {
    expect(normalizeAddress('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientIpFrom({}, '::ffff:1.2.3.4', [])).toBe('1.2.3.4');
    expect(clientIpFrom({ 'x-forwarded-for': '1.2.3.4' }, EDGE, parseTrustProxy(EDGE))).toBe('1.2.3.4');
  });

  it('C4′ 生产真实形态：映射对端 + 纯 IPv4 信任表 ⇒ 采信 XFF（且结果已归一）', () => {
    // 生产里 docker 网桥下 Node 报的对端是 IPv4-mapped（`::ffff:172.28.0.250`），
    // 而信任表是**纯 IPv4** 的字面地址 ⇒ 「对端可信」的判定必须跨这两种形态。
    const trust = parseTrustProxy(EDGE);
    expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.7' }, '::ffff:172.28.0.250', trust)).toBe('203.0.113.7');
    expect(clientIpFrom({ 'x-forwarded-for': '::ffff:203.0.113.7' }, '::ffff:172.28.0.250', trust)).toBe('203.0.113.7');
  });

  it('C5 非空且不可解析的值 ⇒ **响亮失败**（不得静默信任一切）', () => {
    expect(() => parseTrustProxy('9.9.9.9.9')).toThrow();
    expect(() => parseTrustProxy('172.28.0.250/33')).toThrow();
  });

  it('C5′ 空 / 全空白 ⇒ **空信任表**（绝不把空值喂给 compile —— 实测它有三种不同行为）', () => {
    expect(parseTrustProxy(undefined)).toEqual([]);
    expect(parseTrustProxy('')).toEqual([]);
    expect(parseTrustProxy('   ')).toEqual([]);
  });

  it('C6 无 socket / 无 headers 的降级语义（R141：取不到 IP 不等于豁免）', () => {
    expect(clientIpFrom({}, '', [])).toBe('');
    expect(clientIpFrom({}, '', parseTrustProxy(EDGE))).toBe('');
  });

  it('C8 头面契约：`Forwarded` / `X-Real-IP` **读入即不可信**', () => {
    const trust = parseTrustProxy(EDGE);
    const base = clientIpFrom({ 'x-forwarded-for': '203.0.113.7' }, EDGE, trust);
    expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.7', forwarded: 'for=7.7.7.7', 'x-real-ip': '6.6.6.6' }, EDGE, trust)).toBe(base);
  });

  it('C9 k3s 形态：CIDR 信任表命中采信 XFF，未命中忽略', () => {
    const trust = parseTrustProxy('10.0.0.0/8,2001:db8::/32');
    expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.9' }, '10.1.2.3', trust)).toBe('203.0.113.9');
    expect(clientIpFrom({ 'x-forwarded-for': '203.0.113.9' }, '192.0.2.7', trust)).toBe('192.0.2.7');
    // 网段外的伪造头不得改变结果（同 C3 的 k8s 形态）
    expect(clientIpFrom({ 'x-forwarded-for': '1.1.1.1' }, '172.16.0.9', trust)).toBe('172.16.0.9');
  });
});

/**
 * ③ T5（规格 §2.10「登录路径 clientIp 注入」/ S8 订正）：**peer 派生** helper ——
 * 从 `http-rate-limit.middleware.ts:168-173` 的私有实现**平移**到此，限流与登录事件
 * （`headersOf()` 的 `clientIp`）两处共用 —— 防「限流 IP」与「登录事件 IP」两口径漂移。
 *
 * 派生序**逐字**：`socket.remoteAddress → req.ip → 'unknown'`（S8：不存在 `clientIpFrom(req)`
 * 形态；三参 `clientIpFrom(headers, socketAddress, TRUST_TABLE)` 仍是唯一解析实现）。
 */
describe('requestClientIp（③ T5：peer 派生唯一实现）', () => {
  it('socket 对端**优先**于 req.ip（原始来源，不受 Express 设置影响）', () => {
    expect(
      requestClientIp({ headers: {}, socket: { remoteAddress: '198.51.100.7' }, ip: '10.0.0.1' }),
    ).toBe('198.51.100.7');
  });

  it('无 socket ⇒ 用 req.ip；socket 对端为空串 ⇒ 也退回 req.ip（不把空串当对端）', () => {
    expect(requestClientIp({ headers: {}, ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(requestClientIp({ headers: {}, socket: { remoteAddress: '' }, ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('两者都取不到 ⇒ 单一 `unknown` 桶（R141：取不到 IP 不等于豁免）', () => {
    expect(requestClientIp({ headers: {} })).toBe('unknown');
    expect(requestClientIp({ headers: {}, socket: {}, ip: '' })).toBe('unknown');
    expect(requestClientIp({ headers: {}, ip: 123 })).toBe('unknown');
  });

  it('IPv4-mapped 对端归一（R1206）', () => {
    expect(requestClientIp({ headers: {}, socket: { remoteAddress: '::ffff:1.2.3.4' } })).toBe('1.2.3.4');
  });

  it('与 clientIpFrom 同一口径：信任表为空 ⇒ 忽略一切头（客户端伪造不改结果）', () => {
    expect(
      requestClientIp({
        headers: { 'x-forwarded-for': '9.9.9.9' },
        socket: { remoteAddress: '172.28.0.9' },
      }),
    ).toBe('172.28.0.9');
  });
});

