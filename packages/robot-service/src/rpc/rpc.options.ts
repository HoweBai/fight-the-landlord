// packages/robot-service/src/rpc/rpc.options.ts

/**
 * §4.2 末段 + §2.3：`robot-service` 的 TCP RPC **监听**端口。
 *
 * 默认 **3105**（§2.3 的 `RPC_PORT`）；必须是**数字**（`Transport.TCP` 的 `options.port`）。
 */
export const ROBOT_RPC_PORT = Number(process.env.RPC_PORT ?? 3105);

/**
 * §4.2 末段逐字：`robot-service` 的 TCP 微服务**监听参数** —— 即
 * `connectMicroservice({transport: Transport.TCP, options: <本函数的返回值>})` 里的
 * **那一层 `options`**（Nest 的 `TcpServerOptions`）。
 *
 * ⚠️⚠️ **只返回一层 `{host, port}`，绝不能再包一层**（R239，门禁期实测的缺陷，
 * 与 game-service 同名文件同一根因）：嵌成 `options.options.port` 会让 `ServerTCP`
 * 取不到 port ⇒ 静默回落到 `TCP_DEFAULT_PORT`(3000) ⇒ 撞 HTTP 端口 ⇒ `EADDRINUSE`
 * 被 `server-tcp.js` 的分支吞掉 ⇒ **日志打「successfully started」但 3105 上没人听**。
 * 单测全绿也照样发生；只有「在真端口上连一次」能抓。
 *
 * ⚠️ `host: '0.0.0.0'` 不能省：默认只绑 `localhost` ⇒ 同 compose 网络的其它容器连不上。
 */
export const robotRpcServerOptions = (): { host: string; port: number } => ({
  host: '0.0.0.0',
  port: ROBOT_RPC_PORT,
});
