import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

/**
 * 测试共享工具（`*.test.ts` 之外，自身不跑用例）。
 *
 * ⚠️ 客户端一律用 `node:http`（**不用 fetch**）：Node fetch 有「封禁端口表」，会与
 * Windows 动态端口的假红家族撞车（已知假红⑤，本仓四成员）。
 * ⚠️ **被测实现**（sinks.ts）必须走真 `fetch` —— 那是产品的出站线；stub 服务器就是它的
 * 对端，golden 断言的是**真正上线的字节**。端口由 `freePort()` 先占后放，避开
 * `listen(0)` 在 Windows 上的动态端口竞态（照 `packages/shared/src/metrics` 先例）。
 */

/** Node fetch 的「封禁端口表」中落在 1024–15000 动态范围里的成员（已知假红族⑤残型：
 *  stub 若随机落这些端口，**被测实现的 fetch** 会拒连 ⇒ 投递永远失败/超时，本机 ~1–3%/轮；
 *  Linux CI 免疫、本机要可迭）。⚠️ 处置 = freePort **跳过**这些端口（不是「重跑直到绿」）。 */
const FETCH_BLOCKED_DYNAMIC_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** 先占一个 `listen(0)` 端口再释放（避开 Windows 动态端口上的已知竞态，仅此一处）；
 *  并跳过 fetch 封禁表内的端口（见上）。 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    if (!FETCH_BLOCKED_DYNAMIC_PORTS.has(port)) return port;
  }
  throw new Error('freePort: 50 次尝试都落在 fetch 封禁端口表内（不应发生）');
}

export interface RecordedRequest {
  method: string;
  /** 原始 `req.url`（path + query —— 钉钉签名断言读这里）。 */
  url: string;
  headers: IncomingHttpHeaders;
  /** 原始请求体（golden 断言读这里，**不**先 JSON.parse）。 */
  body: string;
}

export interface StubServer {
  port: number;
  /** 槽位 URL 基座（钉钉案例自行拼 `?access_token=…`）。 */
  baseUrl: string;
  requests: RecordedRequest[];
  /** 可改：下一条响应的状态码（C8「单槽 500 隔离」用）。 */
  status: number;
  /** 可改：true = 收下请求但**永不响应**（测 5s 超时的短化替身）。 */
  hang: boolean;
  close(): Promise<void>;
}

/** 容器化 stub 的**进程内替身**（C5 真栈版在 slice-16；这里是 C8 的单测半边）。 */
export async function startStub(): Promise<StubServer> {
  const port = await freePort();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (stub.hang) return; // 不响应：把超时闸的判别力留给被测代码
      res.writeHead(stub.status, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  const stub: StubServer = {
    port,
    baseUrl: `http://127.0.0.1:${port}/hook`,
    requests,
    status: 200,
    hang: false,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // hang=true 的连接会一直挂着 ⇒ 必须强制掐断，否则 close 永远等不到。
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return stub;
}

export interface HttpCallResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** `node:http` 客户端（见文件头：刻意不用 fetch）。 */
export function httpCall(opts: {
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpCallResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: opts.headers,
        agent: false, // 避免 keep-alive 连接把 close() 挂住（照 shared 先例）
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程内 stub 拉取源（JsonSocket over TCP；T12 · 评审 G9 落点）
// ─────────────────────────────────────────────────────────────────────────────

/** Nest `JsonSocket` 线格式的请求包（`<字符数>#<json>` 里的 json）。 */
export interface JsonStubRequest {
  pattern: string;
  data: Record<string, unknown>;
  id: string;
}

export interface JsonStubServer {
  port: number;
  /** 收到的请求（逐字：pattern/data/id —— 供「pattern 逐字」「无 meta」等断言）。 */
  requests: JsonStubRequest[];
  /** 累计 TCP 连接数（「每次调用一条新连接」的观测点）。 */
  connections: number;
  /**
   * 每连接应答器（用例随时覆写）：返回**原始回包字节**（可含多帧）；
   * 返回 `null` = 收下请求但不响应（挂起 ⇒ 测超时闸）。
   */
  responder: (req: JsonStubRequest) => string | null;
  close(): Promise<void>;
}

/**
 * 按 Nest `JsonSocket` 线格式组帧：长度 = `json.length`（**字符数**，不是字节 ——
 * 与 JsonSocket/`rpc.ts` 同一纪律，中文值判据在此）。
 */
export function jsonFrame(payload: unknown): string {
  const json = JSON.stringify(payload);
  return `${json.length}#${json}`;
}

/**
 * 进程内 **stub 拉取源**（`config.notifyChannel.get` 的对端替身）：
 * 解析入站帧（同样按字符计长、`#` 分帧），默认应答合法成功信封 `{ok:true,data:{values:{}}}`；
 * 各用例覆写 `responder` 造业务错/坏帧/挂起等形态。端口走 `freePort()`（Windows 动态端口纪律）。
 */
export async function startJsonStub(): Promise<JsonStubServer> {
  const port = await freePort();
  const requests: JsonStubRequest[] = [];
  let connections = 0;
  const sockets = new Set<Socket>(); // net.Server 没有 closeAllConnections（那是 http.Server 的）——自持连接集

  const server = createTcpServer((socket: Socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let need = -1;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (need < 0) {
          const i = buffer.indexOf('#');
          if (i === -1) return;
          need = parseInt(buffer.slice(0, i), 10);
          buffer = buffer.slice(i + 1);
        }
        if (buffer.length < need) return;
        const raw = buffer.slice(0, need);
        buffer = buffer.slice(need);
        need = -1;
        const req = JSON.parse(raw) as JsonStubRequest;
        requests.push(req);
        const reply = stub.responder(req);
        if (reply !== null) socket.write(reply, 'utf8');
      }
    });
    socket.on('error', () => {
      /* 被测客户端超时后销毁连接属预期；吞掉，别让 stub 自身崩 */
    });
  });

  const stub: JsonStubServer = {
    port,
    requests,
    get connections() {
      return connections;
    },
    responder: (req) => jsonFrame({ id: req.id, response: { ok: true, data: { values: {} } } }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 挂起（responder=null）的连接会一直挂着 ⇒ 必须强制掐断，否则 close 永远等不到。
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return stub;
}
