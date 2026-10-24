/**
 * 通知配置拉取客户端 + 裁剪 + last-good 持久化（relay 与 am-renderer 共用；规格 ⚙️8/⚙️9 + §3.3）。
 *
 * ## 线格式（⚙️8；逐字复刻 Nest `JsonSocket`，解析纪律照 `tools/conformance/src/lib/rpc.ts:131-241`）
 *
 *  `<len>#<json>`（**按字符计长** —— `setEncoding('utf8')` 后比 `string.length`，与对端一致，
 *  否则多字节值（中文）会把帧切坏）；请求 `{pattern, data, id}`、回包 `{id, response}`；
 *  每次调用**一条新连接**；单次超时 **3000ms**、**不重试**（下一轮即重试）、**不携带 meta**
 *  （relay/renderer 非 Nest 服务、无 trace 基建 —— ⚙️8 偏离登记）。
 *
 * ## 失败语义（§3.3 逐字）
 *
 *  **throw**（传输故障/业务错**不分码** —— 调用方统一当「这次拉不到」）。⚠️ 错误消息
 *  **只带错误类别**：回包正文里可能含 URL 凭据（S2③ 日志纪律），原文一律不回显。
 *
 * ## last-good 持久化（⚙️9）
 *
 *  成功拉取的**裁剪后四键图**原子写 `/data/notify-config.json`（600，tmp+rename）；
 *  读失败 ⇒ 不存在静默、损坏 WARN，**均按 `null`（从未成功拉到）**处理。
 */
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { RELAY_IM_KEYS } from './config';
import type { NotifyValues } from './config';

/** 轮询周期（⚙️8：常量钉死，不做 env 旋钮）。 */
export const NOTIFY_PULL_INTERVAL_MS = 30_000;
/** 单次拉取超时（⚙️8）。 */
export const NOTIFY_PULL_TIMEOUT_MS = 3000;
/** last-good 文件路径（⚙️9；compose 将命名卷 `relay-data` 挂到 `/data`）。 */
export const NOTIFY_CONFIG_PATH = '/data/notify-config.json';

/** 拓扑类 env 的缺省值（compose 以字面量显式供给 `config-service:3106`；缺省只兜本机/测试）。 */
const DEFAULT_RPC_HOST = 'config-service';
const DEFAULT_RPC_PORT = 3106;
/** Nest `JsonSocket` 的分帧符。 */
const FRAME_DELIMITER = '#';

export interface PullNotifyOptions {
  /** 超时覆盖（测试用；生产缺省 3000ms = ⚙️8 钉死值）。 */
  timeoutMs?: number;
}

/** 解析 RPC 端点（拓扑类 env；非法端口 ⇒ throw —— 调用方当「这次拉不到」）。 */
function resolveEndpoint(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const host = env.CONFIG_SERVICE_RPC_HOST?.trim() || DEFAULT_RPC_HOST;
  const rawPort = env.CONFIG_SERVICE_RPC_PORT?.trim();
  if (!rawPort) return { host, port: DEFAULT_RPC_PORT };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('通知配置拉取失败（CONFIG_SERVICE_RPC_PORT 不是合法端口）');
  }
  return { host, port };
}

/**
 * 拉取一次通知图（`config.notifyChannel.get`）。任何故障/业务错一律 throw
 * （错误消息**只带类别**，绝不回显任何值/回包原文 —— 回包正文可能含 URL 凭据）。
 */
export function pullNotifyConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: PullNotifyOptions = {},
): Promise<NotifyValues> {
  return new Promise<NotifyValues>((resolve, reject) => {
    const { host, port } = resolveEndpoint(env); // 抛出由 Promise 执行器收敛成 reject
    const timeoutMs = opts.timeoutMs ?? NOTIFY_PULL_TIMEOUT_MS;
    // ⚠️ 令牌**逐字**（不 trim）：config-service 侧读同一份 env 供给链（`.env`/栈脚本），
    //    单侧裁剪会造成「两边看着配了同值、却比对失败」的幽灵故障。
    const pullToken = env.NOTIFY_CHANNEL_PULL_TOKEN ?? '';
    const id = randomUUID();

    const socket: Socket = connect({ host, port });
    // 与 `JsonSocket` 逐字一致的实现：按**字符**（不是字节）计长度 —— 中文字形值必须同样处理。
    socket.setEncoding('utf8');

    let buffer = '';
    let contentLength: number | null = null;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    const fail = (category: string): void => {
      finish(() => reject(new Error(`通知配置拉取失败（${category}）`)));
    };

    const timer = setTimeout(() => fail(`超时 ${timeoutMs}ms`), timeoutMs);

    socket.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED 等 code 是**类别**（不是值）—— 原样带上便于排障。
      fail(err.code ? `连接失败 ${err.code}` : '连接失败');
    });
    socket.on('close', () => fail('对端在回包前关闭连接'));

    const handleMessage = (raw: string): void => {
      let packet: { id?: unknown; err?: unknown; response?: unknown };
      try {
        packet = JSON.parse(raw) as typeof packet;
      } catch {
        return fail('回包不是合法 JSON'); // ⚠️ 不回声 raw（可能含值）
      }
      if (packet.id !== id) return fail('回包 id 不匹配');
      if (packet.err !== undefined && packet.err !== null) {
        // 协议层错误（服务端无 handler 走这条）——与传输故障同列：一律当「这次拉不到」。
        return fail('服务端返回 err（无 handler）');
      }
      const response = packet.response as { ok?: unknown; code?: unknown; data?: unknown } | undefined;
      if (response === undefined || response === null || typeof response !== 'object' || !('ok' in response)) {
        return fail('回包 response 不是 RpcResult 信封');
      }
      if (response.ok !== true) {
        return fail(`服务端业务拒绝（code=${String(response.code ?? '?')}）`); // 不回显服务端 message
      }
      const data = response.data as { values?: unknown } | undefined;
      const values = data?.values;
      if (values === undefined || values === null || typeof values !== 'object' || Array.isArray(values)) {
        return fail('回包 data.values 不是对象');
      }
      finish(() => resolve(values as NotifyValues));
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // 循环而不是 if：一个 TCP 段里可能有**多条**报文（Nest 的 `handleData` 用递归做同一件事）。
      for (;;) {
        if (contentLength === null) {
          const i = buffer.indexOf(FRAME_DELIMITER);
          if (i === -1) return;
          contentLength = parseInt(buffer.slice(0, i), 10);
          if (Number.isNaN(contentLength)) return fail('分帧长度前缀不是数字');
          buffer = buffer.slice(i + 1);
        }
        if (buffer.length < contentLength) return;
        const message = buffer.slice(0, contentLength);
        buffer = buffer.slice(contentLength);
        contentLength = null;
        handleMessage(message);
        if (settled) return;
      }
    });

    socket.on('connect', () => {
      // 与 `JsonSocket.formatMessageData` 逐字同形：长度（**字符数**）+ `#` + JSON；
      // data 只有 pullToken、**不带 meta**（⚙️8）。
      const json = JSON.stringify({ pattern: RPC_PATTERNS.configNotifyChannelGet, data: { pullToken }, id });
      socket.write(`${json.length}${FRAME_DELIMITER}${json}`, 'utf-8');
    });
  });
}

/**
 * 拉后即裁（⚙️9）：relay 只保留四 IM 键（SMTP 五键**进程内即弃、不落盘** —— 收窄凭据持有面）。
 * 在场判定 = 非空字符串（「空串 = 未设」全仓口径）；值**逐字**（不裁剪空白）。
 * ⚠️ 返回**新对象**（不修改入参）；`{}` 亦为有效图（成功空图 ⇒ 零槽 no-op，≠ 从未拉到）。
 */
export function trimForRelay(values: NotifyValues): NotifyValues {
  const trimmed: NotifyValues = {};
  for (const key of RELAY_IM_KEYS) {
    const value = values[key];
    if (typeof value === 'string' && value.trim() !== '') trimmed[key] = value;
  }
  return trimmed;
}

/**
 * 读 last-good（⚙️9）：不存在 ⇒ **静默** `null`（首启的正常形态）；读取失败/内容损坏 ⇒
 * WARN（不含任何文件内容）+ `null`。命中 ⇒ 返回**裁剪后**四键图（文件若被外力塞入其它键，
 * 裁剪是安全的归一化）。`null` 的语义只有一个：**从未成功拉到**（`/webhook` ⇒ 500）。
 */
export async function readLastGood(path: string = NOTIFY_CONFIG_PATH): Promise<NotifyValues | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn('通知配置持久化文件不可读（按从未拉到处理）');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    console.warn('通知配置持久化文件损坏（按从未拉到处理）');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('通知配置持久化文件损坏（按从未拉到处理）');
    return null;
  }
  return trimForRelay(parsed as NotifyValues);
}

/**
 * 原子写 last-good（⚙️9）：`<path>.tmp`（600）写入后 rename 覆盖（同目录 ⇒ 原子替换），
 * 再 chmod 一次兜底（tmp 若曾存在，`writeFile` 的 mode 不会重新应用；Windows 上近 no-op）。
 * 写**总是**先裁剪 —— 文件的不变量（只含四 IM 键）不依赖调用方纪律（⑧d「/data 内容断言」）。
 */
export async function writeLastGood(values: NotifyValues, path: string = NOTIFY_CONFIG_PATH): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(trimForRelay(values)), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}
