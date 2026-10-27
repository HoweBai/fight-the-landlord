/**
 * 代理 JWT 鉴权常量（currency-service 签发、api-gateway 验签）。
 *
 * 两侧逐字同值由编译时 import 保证（消除人工同步风险）；secret 解析函数
 * 仍在各自服务内（依赖 process.env，协议包零环境依赖纪律）。
 */
export const AGENT_JWT_AUDIENCE = 'ftl-agent';
export const AGENT_JWT_TYP = 'agent-access';
/** 两侧逐字同值；生产环境必须设 AGENT_JWT_SECRET 环境变量覆盖。 */
export const AGENT_JWT_SECRET_FALLBACK = 'dev-secret-change-in-production';
