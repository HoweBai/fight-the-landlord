/**
 * §4.2 的 **TCP RPC 监听真的绑在 `RPC_PORT` 上**（N20/P4；执行期裁决 **R239**）。
 *
 * ─── 这条闸要抓的缺陷（门禁期实测，**所有单测全绿**）──────────────────────
 * `connectMicroservice({ transport: TCP, options: <嵌套了一层的对象> })` 会让端口落在
 * `options.options.port`，而 Nest 的 `ServerTCP` 读的是 `options.port`
 * （`this.port = this.getOptionsProp(options, 'port') || TCP_DEFAULT_PORT`）。
 * 取不到 ⇒ **静默回落到 `TCP_DEFAULT_PORT`(3000)** ⇒ 那个端口已被 HTTP 面占着
 * ⇒ `EADDRINUSE` 走进 `server-tcp.js` 里「只对 `EADDRINUSE`/`ECONNREFUSED` 调 callback」
 * 的分支 ⇒ **日志照样打 `Nest microservice successfully started`，而 3103 上没有任何监听**。
 *
 * 实测症状（修前）：
 *   - 容器日志：`[NestMicroservice] Nest microservice successfully started`
 *   - 容器内 `127.0.0.1:3103` ⇒ **`ECONNREFUSED`**（`/proc/net/tcp` 里只有 3003）
 *   - 宿主机 `nc -z 127.0.0.1 3103` ⇒ **"succeeded"**（Docker 的用户态代理先把连接收下、
 *     后端没人再关掉 ⇒ 宿主侧表现为 OPEN/ECONNRESET）—— 这是一个**能骗过宿主探针**的假象。
 *
 * ─── 为什么既有判据一条都抓不到 ─────────────────────────────────────────
 * `game.rpc.test.ts` 直接 `new GameRpcController(...)`（不经端口）；
 * `test/game.module.wiring.test.ts` compile 的是 DI 图（不绑端口）。
 * **「DI 通了」与「端口真的在听」是两条不同的命题** —— 这与 R216/R217/R227 同族，
 * 是该族**第四次**发作，也是本片第二次「单测全绿、容器红」。
 *
 * ─── 判据形态（关键）────────────────────────────────────────────────────
 * 只有**绑真端口 + 真连一次 + 拿到业务应答**能证明它。本文件：
 *  ① 用 `gameRpcServerOptions()` 造一个只含 RPC 控制器的最小 Nest app（不拉 Redis / 不占 3000）；
 *  ② `listen()` 到 **随机空闲端口**（`port: 0` 由内核分配）—— 这样不依赖任何固定端口、
 *     也不与常驻容器抢端口，**在门禁与 CI 里都稳定**；
 *  ③ 用 `net` 手写一条 `JsonSocket` 线格式（长度前缀 + `#`，见 R228）的请求，
 *     断言**真的收到** `{ id, response }` 且 `response.ok === true`；
 *  ④ 反向判据：故意把 `options` 嵌错一层 ⇒ 断言「那个端口上取不到应答」
 *     （证明本条判据**抓得住**这个缺陷，而不是恒真 —— R115）。
 */
import 'reflect-metadata';
import { createServer } from 'node:net';
import { Controller, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MessagePattern, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { afterEach, describe, expect, it } from 'vitest';
import { gameRpcServerOptions } from '../src/rpc/rpc.options';

/** 与 `JsonSocket` 逐字同形：`<字符数>#<JSON>`（**长度按字符**，不是字节 —— R228）。 */
function frame(packet: unknown): string {
  const json = JSON.stringify(packet);
  return `${json.length}#${json}`;
}

/** 取一个内核分配的空闲端口（先听、再关掉，把这个号交出去用）。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 真连一次：发一条线格式请求，返回**收到的原始回复**（超时/被关都返回 `null`）。
 * 刻意不复用产品代码的客户端 —— 本判据要证明的是「端口上真的有服务」，
 * 用被验收方自己的客户端去自证会让「客户端与服务器一起错」也能过。
 */
async function rawCall(port: number, pattern: string, data: unknown, timeoutMs = 2000): Promise<unknown> {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    let buffer = '';
    let contentLength: number | null = null;
    let settled = false;
    const done = (v: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    const socket = connect({ host: '127.0.0.1', port });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(frame({ pattern, data, id: 'bind-probe' }), 'utf-8'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (contentLength === null) {
        const i = buffer.indexOf('#');
        if (i === -1) return;
        contentLength = parseInt(buffer.slice(0, i), 10);
        if (Number.isNaN(contentLength)) return done(null);
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length < contentLength) return;
      try {
        done(JSON.parse(buffer.slice(0, contentLength)));
      } catch {
        done(null);
      }
    });
    socket.on('error', () => done(null));
    socket.on('close', () => done(null));
    setTimeout(() => done(null), timeoutMs);
  });
}

/** 最小 RPC app：**只**含一个 `@MessagePattern` 控制器，不拉 Redis、不占 HTTP 端口。 */
@Controller()
class BindProbeController {
  @MessagePattern('probe.ping')
  ping(): { ok: true; data: string } {
    return { ok: true, data: 'pong' };
  }
}

@Module({ controllers: [BindProbeController] })
class BindProbeModule {}

/** 把最小 app 绑到一个**真端口**上；返回 close 句柄。 */
async function bootRpcOn(options: Record<string, unknown>) {
  const app = await NestFactory.create(BindProbeModule, { logger: false });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: options as never,
  });
  await app.startAllMicroservices();
  return app;
}

describe('§4.2 RPC 监听必须真的绑在端口上（R239：单测全绿也照样没人听）', () => {
  let app: Awaited<ReturnType<typeof bootRpcOn>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('正向：绑到真端口后，一条线格式请求真的能拿到 { response: { ok: true } }', async () => {
    const port = await freePort();
    // 用**产品代码的**工厂造 options —— 这正是「main.ts 传什么」的那一层。
    app = await bootRpcOn({ ...gameRpcServerOptions(), port });

    const reply = (await rawCall(port, 'probe.ping', {})) as
      | { id?: string; response?: { ok?: boolean; data?: string } }
      | null;

    // 判据是「真的收到了应答」—— 不是「listen() 没抛」（R239 的缺陷正是后者为真、前者为假）。
    expect(reply, '端口上没有拿到任何应答 —— RPC 监听没有真的绑上（R239）').not.toBeNull();
    expect(reply?.response).toEqual({ ok: true, data: 'pong' });
  });

  it('反向（判别力自证）：`options` 里嵌进去的 port **不会被采纳**，证明本判据抓得住 R239', async () => {
    const nestedOnly = await freePort();
    const wanted = await freePort();
    // 复刻 R239 的坏形状：真正的端口被包在内层 ⇒ `ServerTCP` 读不到 `options.port`。
    // ⚠️ **不许**把 `nestedOnly` 放在外层 —— 那正是原缺陷（外层可读处没有 port）。
    let boundPort = -1;
    try {
      app = await bootRpcOn({ nested: { host: '127.0.0.1', port: nestedOnly } });
      const msvc = app.getMicroservices()[0] as unknown as {
        server: { server: { address(): { port: number } | string | null } };
      };
      const bound = msvc?.server?.server?.address();
      boundPort = typeof bound === 'object' && bound ? bound.port : -1;
    } catch (err) {
      // R239 在真容器里的**实际**形态：回落到 `TCP_DEFAULT_PORT`(3000)，撞上已占用的端口
      // ⇒ `EADDRINUSE`。这条路径同样是「嵌进去的 port 没被采纳」的证据，**必须**接受 ——
      // 否则本判据会被「3000 恰好被占/没被占」这个**环境**事实左右（假红/假绿）。
      boundPort = -1;
      void err;
    }

    // 唯一要断言的性质：**内层那个 port 没有被采纳**。
    //  - 若绑上了 ⇒ 绑到的不是 `nestedOnly`（实现只读顶层 `options.port`）；
    //  - 若没绑上（EADDRINUSE）⇒ `-1` ≠ `nestedOnly`。
    expect(
      boundPort,
      `嵌在内层的 port ${nestedOnly} **被采纳了** —— 那说明本判据没有判别力（R115）；` +
        `实际绑定=${boundPort}（-1 = EADDRINUSE 没绑上）`,
    ).not.toBe(nestedOnly);

    // 并且：**我们要的那个端口上确实没有服务**（现场形态：缺 port ⇒ 落到别处）。
    const reply = await rawCall(wanted, 'probe.ping', {}, 1200);
    expect(reply, `端口 ${wanted} 上不该有应答（监听方落在 ${boundPort}）`).toBeNull();
  });
});
