/**
 * api-gateway 的 WS 连接数 gauge（k3s 扩缩容 spec 2026-10-27 D14）。
 *
 * 与 room-service 同名 `ws_connections`：每个进程只暴露自己的值，
 * Prometheus Adapter 按 pod 聚合并供 HPA 使用。
 *
 * ⚠️ 本文件只定义；写点在 `gateway/proxy.gateway.ts` 的连接建立/断开处。
 */
import { createGauge } from '@fight-the-landlord/shared';

export const gatewayWsConnections: ReturnType<typeof createGauge> = createGauge(
  'gateway_ws_connections',
  'api-gateway 当前客户端 WebSocket 连接数。',
);
