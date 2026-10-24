/**
 * §4.2 的 **TCP RPC 探针**（N20 / P4 Task 6）。**零新依赖** —— 只用 `node:net`。
 *
 * 契约由 `@fight-the-landlord/protocol` 的 `RPC_PATTERNS` 钉住：本文件**不得**出现
 * `'game.start'` 这样的字面量（否则 pattern 名一改，探针会**静默**打到一个不存在的路由上，
 * 而 Nest 对不存在的 handler 回的是 `{err}` 而不是连接错误 —— 症状是「业务错误码不对」，
 * 会被误读成服务端 bug）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠️ 实测线格式**不是**计划里假设的「JSON + `\n` 分帧」（**执行期裁决 R228**）。
 *
 * 读 `@nestjs/microservices@11.2.6` 的 `helpers/json-socket.js` 得到的**真**线格式是
 * **长度前缀 + `#` 分隔符**（默认 `JsonSocket`，`ServerTCP`/`ClientTCP` 都用它）：
 * （T13 订正：R228 当时的实装是 10.4.22，仓库现装 `@nestjs/microservices@11.2.6`
 *  —— 该文件逐行核对，delimiter 与 `formatMessageData` 形态未变，本文件结论照旧成立。）
 *
 *   发送：`<JSON.stringify(packet).length>` + `'#'` + `<JSON>`          （**无换行**）
 *   接收：buffer 里先找 `#` ⇒ `parseInt(前缀)` = 内容长度 ⇒ 再凑够那么多**字符** ⇒ 一条完整报文
 *
 * 响应包（`server-tcp.js` 的 `handleMessage` / 无 handler 分支）：
 *   有 handler：`{ id, response: <handler 返回值>, isDisposed: true }`
 *   无 handler：`{ id, status: 'error', err: 'There is no matching message handler defined in the remote service.' }`
 * 而 `response` 就是 handler 返回的 `RpcResult` 信封（R220）——**Nest 不会再包一层**。
 *
 * 所以：
 *   - 业务错误（`{ok:false, code, message}`）**可以**从 `response` 里原样读出；
 *   - 「没有这个 pattern」是**协议层**故障（`err` 字段），不是业务错误 —— 探针要能区分
 *     这两者（切片第 5 组就靠它做探针自证）；
 *   - `data` 取 `response`（不是整包）；`id` 由本探针自己生成并回验。
 *
 * 若将来 Nest 换了 `socketClass`（自定义 serializer），本文件必须同步改 —— 改**探针**，
 * **不得**为了让探针好写而改产品代码（R226）。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 为什么 `rpcCall` 在**传输层失败时 reject**（而不是 resolve 一个 `{ok:false, code:10007}`）：
 * R220 把「传输层故障」留给**调用方**映射成 `UPSTREAM_UNAVAILABLE`，而 conformance 是那个
 * 「调用方」的**探针**：把 `ECONNREFUSED` / 超时表示成同一个 `10007` 会让
 * 「旧栈上 3103 根本没监听」与「新栈上服务返回了一个业务错误」在断言层**长得一模一样**，
 * 而这两件事正是本片要分开的（切片 11 教训第 7 条：判别力必须来自能区分形态的判据）。
 * 因此：
 *   - 连不上 / 超时 ⇔ **Promise reject**（`RpcTransportError`，带 `kind`，原文在 `message` 里）。
 *     注意「连不上」在本机的**两种**形态（`ECONNREFUSED` 与 `ETIMEDOUT`，见 `probeClosedPort`）。
 *   - 服务端回了信封 ⇔ resolve `{ok:true,data}` 或 `{ok:false,code,message}`（**原样**，不翻译）。
 */
import { connect, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { RpcResult } from '@fight-the-landlord/protocol';

/** `connect()` 的选项（探针只用到 `host` / `port`）。 */
export interface RpcEndpoint {
  host: string;
  port: number;
}

/** 传输层故障的分类（**不**翻译成业务错误码，见文件头）。 */
export type RpcTransportKind = 'ECONNREFUSED' | 'timeout' | 'socket-error' | 'protocol' | 'closed';

export interface RpcTransportDetail {
  kind: RpcTransportKind;
  /** 原始错误码（`ECONNREFUSED` / `ETIMEDOUT` / …），拿不到时为 `undefined`。 */
  code?: string;
  host: string;
  port: number;
  pattern: string;
  elapsedMs: number;
}

/** 传输层故障（连不上 / 超时 / 分帧坏 / 未回包就断开）。 */
export class RpcTransportError extends Error {
  constructor(
    readonly detail: RpcTransportDetail,
    message: string,
  ) {
    super(message);
    this.name = 'RpcTransportError';
  }
}

/** RPC 监听方的 `{host, port}`（§2.1 / §2.3：`3103` / `3105`）。 */
function endpoint(envHost: string, envPort: string, defaultPort: number): RpcEndpoint {
  const port = Number(process.env[envPort] ?? defaultPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${envPort} 不是合法端口：${process.env[envPort]}`);
  }
  return { host: process.env[envHost] ?? 'localhost', port };
}

/**
 * `game-service` 的 TCP RPC 监听（§2.1：**3103**；§2.3：`GAME_SERVICE_RPC_HOST` / `_PORT`）。
 *
 * ⚠️ 宿主直连依赖 `docker-compose.override.yml` 的 `3103:3103`（R226）——
 * 生产形态只 `expose`，**不**发布宿主端口（切片第 6 组 / `slice-07.2-deploy` 钉它）。
 */
export const GAME_RPC: RpcEndpoint = endpoint('GAME_RPC_HOST', 'GAME_SERVICE_RPC_PORT', 3103);

/** `robot-service` 的 TCP RPC 监听（§2.1：**3105**；§2.3：`ROBOT_SERVICE_RPC_HOST` / `_PORT`）。 */
export const ROBOT_RPC: RpcEndpoint = endpoint('ROBOT_RPC_HOST', 'ROBOT_SERVICE_RPC_PORT', 3105);

/**
 * `config-service` 的 TCP RPC 监听（§2.1：**3106**；消费方 env = `CONFIG_SERVICE_RPC_HOST` /
 * `CONFIG_SERVICE_RPC_PORT`，T13 首用方 = 支付配置管理化片 `config.payChannel.get` 探针）。
 *
 * ⚠️ 宿主直连依赖 `docker-compose.override.yml` 的 `3106:3106`（片⑦ §2.1 起发布；R226 同规
 * —— 基文件只 `expose`）。与 game/robot 两条同规：宿主映射只在开发形态，生产不发布。
 */
export const CONFIG_RPC: RpcEndpoint = endpoint('CONFIG_SERVICE_RPC_HOST', 'CONFIG_SERVICE_RPC_PORT', 3106);

/** 无 handler 时 Nest 回的原文（`constants.js` 的 `NO_MESSAGE_HANDLER`），用于归因。 */
export const NO_MESSAGE_HANDLER =
  'There is no matching message handler defined in the remote service.';

/** `JsonSocket` 的分帧分隔符（**不是**换行，见文件头）。 */
const DELIMITER = '#';

interface RawResponse {
  id?: unknown;
  /** handler 的返回值（R220 的 `RpcResult` 信封）。 */
  response?: unknown;
  /** 无 handler / handler 抛出时 Nest 放的错误（字符串或对象）。 */
  err?: unknown;
  isDisposed?: boolean;
}

/**
 * 一次 RPC 调用。**每次调用一条新连接**（探针求「可归因」，不求吞吐）：
 * 复用连接会让一个切片的失败污染下一个切片的观测值，而这正是本片要避免的。
 *
 * @throws RpcTransportError 连不上 / 超时 / 回包没解成信封（**不**返回 `{ok:false}`，
 *         理由见文件头：那种混淆会让「端口没监听」与「业务错误」不可区分）。
 */
export function rpcCall<T = unknown>(
  ep: RpcEndpoint,
  pattern: string,
  data: unknown,
  timeoutMs = 3000,
): Promise<RpcResult<T>> {
  return new Promise<RpcResult<T>>((resolve, reject) => {
    const startedAt = Date.now();
    const id = randomUUID();
    const socket: Socket = connect({ host: ep.host, port: ep.port });
    // 与 `JsonSocket` 逐字一致的实现：它按**字符**（不是字节）计长度，所以这里同样
    // `setEncoding('utf8')` 后按 `string.length` 比较 —— 两边一致才不会对多字节内容
    // （中文 message、昵称）误判。这是**复刻被测实现**，不是「更好的做法」。
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

    const fail = (kind: RpcTransportKind, code: string | undefined, why: string): void => {
      const elapsedMs = Date.now() - startedAt;
      finish(() =>
        reject(
          new RpcTransportError(
            { kind, ...(code === undefined ? {} : { code }), host: ep.host, port: ep.port, pattern, elapsedMs },
            `RPC 传输层故障（${kind}${code ? ` ${code}` : ''}）：${ep.host}:${ep.port} pattern=${pattern} ` +
              `耗时 ${elapsedMs}ms —— ${why}`,
          ),
        ),
      );
    };

    const timer = setTimeout(
      () => fail('timeout', undefined, `超过 ${timeoutMs}ms 没有回包（服务在听但没响应，或 pattern 不存在而服务端没回 err）`),
      timeoutMs,
    );

    socket.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED 是**期望**的观测值之一（端口没监听）—— 原样带上 code，别吞掉。
      fail(err.code === 'ECONNREFUSED' ? 'ECONNREFUSED' : 'socket-error', err.code, err.message);
    });
    socket.on('close', () => {
      // 正常路径下 `finish()` 已经 settled；走到这里说明**对端先关了**且我们没解出信封。
      fail('closed', undefined, '对端在回包之前关闭了连接');
    });

    const handleMessage = (raw: string): void => {
      let packet: RawResponse;
      try {
        packet = JSON.parse(raw) as RawResponse;
      } catch (err) {
        return fail('protocol', undefined, `回包不是合法 JSON（${raw.slice(0, 120)}）：${String(err)}`);
      }
      if (packet.id !== id) {
        return fail('protocol', undefined, `回包 id 不匹配（期望 ${id}，实际 ${String(packet.id)}）`);
      }
      if (packet.err !== undefined && packet.err !== null) {
        // 协议层错误（**没有 handler** 走这条）：交给调用方按 `err` 原文归因。
        // 刻意**不**把它当成 `{ok:false}` —— 那会把「探针打错 pattern」伪装成业务错误。
        return fail('protocol', undefined, `服务端返回 err=${JSON.stringify(packet.err)}`);
      }
      const response = packet.response as RpcResult<T> | undefined;
      if (response === undefined || response === null || typeof response !== 'object' || !('ok' in response)) {
        return fail(
          'protocol',
          undefined,
          `回包 response 不是 RpcResult 信封（R220）：${JSON.stringify(response)?.slice(0, 200)}`,
        );
      }
      finish(() => resolve(response));
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // 循环而不是 if：一个 TCP 段里可能有**多条**报文（Nest 的 `handleData` 用递归做同一件事）。
      for (;;) {
        if (contentLength === null) {
          const i = buffer.indexOf(DELIMITER);
          if (i === -1) return;
          const rawLength = buffer.slice(0, i);
          contentLength = parseInt(rawLength, 10);
          if (Number.isNaN(contentLength)) {
            return fail('protocol', undefined, `分帧长度前缀不是数字：${JSON.stringify(rawLength)}`);
          }
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
      // 与 `JsonSocket.formatMessageData` 逐字同形：长度 + `#` + JSON。
      const json = JSON.stringify({ pattern, data, id });
      socket.write(`${json.length}${DELIMITER}${json}`, 'utf-8');
    });
  });
}

/**
 * 探针的**判别力自证**（R115 / 切片 11 教训第 7 条）：对同一个 pattern／同一份 data，
 * 打到一个**确定没有监听**的地址上必须**失败**。
 *
 * 只断言「`rpcCall` 返回了」是没有判别力的 —— 一个永远 resolve `{ok:false}` 的假探针也能过。
 * 返回**原始观测值**（失败类型 + 错误码 + 耗时），让切片把它写进输出原文。
 *
 * ⚠️ **本机实测的地址依赖（执行期发现，写进 R229）**：同一台机器上「连不上的地址」
 * 有两种**截然不同**的失败形态，**哪一种出现在哪个地址取决于环境**（不是缺陷）：
 *   - `ECONNREFUSED`：对端真的回了 RST（1–2ms）；
 *   - `timeout`：SYN 被**丢弃**，不回 RST（挂到超时窗口）。
 *
 * ⚠️ R229 曾把「`172.17.0.1` 回 RST、`127.0.0.1` 被黑洞」记为事实，但那**只适用于那一台机器**：
 * 本片在 Windows + Docker Desktop 上实测，两者**恰好相反**（`127.0.0.1` 回 RST、
 * compose 网关只给超时）。⇒ **不要把地址与形态绑死**；需要 RST 时用
 * `constructRefusingEndpoint()` 构造，或用 `slice-07.2-rpc` 的 `discoverRefusingEndpoint()` 发现。
 */
export async function probeClosedPort(
  pattern: string,
  data: unknown,
  timeoutMs = 3000,
  ep: RpcEndpoint = { host: '127.0.0.1', port: 1 },
): Promise<{ kind: RpcTransportKind; code?: string; elapsedMs: number; message: string }> {
  try {
    await rpcCall(ep, pattern, data, timeoutMs);
  } catch (err) {
    if (err instanceof RpcTransportError) {
      return {
        kind: err.detail.kind,
        ...(err.detail.code === undefined ? {} : { code: err.detail.code }),
        elapsedMs: err.detail.elapsedMs,
        message: err.message,
      };
    }
    throw err;
  }
  throw new Error(
    `探针自证失败：对 ${ep.host}:${ep.port} 的 RPC 调用**竟然成功了** —— 探针没有真的在等网络`,
  );
}

/**
 * 构造一个回环端点：`bind 127.0.0.1:0` 拿到内核分配的临时端口，随即 `close` ——
 * 此刻该端口「有主机、无监听」，**在回环未被防火墙黑洞的环境下**，任何连接都会被回 RST。
 *
 * ⚠️ **为什么用构造而不是写死一个地址**：哪种地址回 RST 是**环境属性**，不是缺陷。
 * 本仓实测过两台机器的观察**恰好相反**：
 *   - R229 那台：`172.17.0.1`（docker0 网关）回 RST；`127.0.0.1` 被黑洞 ⇒ 超时；
 *   - Windows + Docker Desktop：`127.0.0.1` 回 RST；compose 网关**只给超时**。
 * ⇒ 写死地址在任一台机器上都是赌。
 *
 * ⚠️ **构造本身也不是万能的**：它的前提是「回环不被黑洞」—— 上面 R229 那台就**不满足**，
 * 本函数在那里会超时而不是回 RST。**这个前提不由本函数兜底**：需要「确定回 RST」的调用方
 * 应当走 `slice-07.2-rpc` 的 `discoverRefusingEndpoint()` —— 它以本端点为**候选①**、
 * 另备候选②（compose 网关），一个都不回 RST 时**响亮失败**并打印各候选实测形态。
 * ⚠️ 另有极小的「close 与 probe 之间端口被抢占」窗口 —— 那会表现为 RST 消失，
 * 调用方的 `kind === 'ECONNREFUSED'` 断言会**响亮失败**（不会被读成绿）。
 */
export async function constructRefusingEndpoint(): Promise<RpcEndpoint> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('构造 RST 端点失败：listen(0) 没有返回 AddressInfo');
  }
  const port = addr.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { host: '127.0.0.1', port };
}
