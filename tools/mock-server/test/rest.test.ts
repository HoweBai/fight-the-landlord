/**
 * mock 的 REST 面（片② 客户端新增）：**两条只读 GET**。
 *
 * 判别力说明：直接对 `installRest` 装在一台**真 `node:http` 服务器**上打真请求 ——
 * 「路由表写对了没有」只有真发一次请求才测得出来（自己 mock 一层 http 等于测替身）。
 */
import { createServer, type Server } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
/**
 * ⚠️ 本文件**故意不 import** `MOCK_BASE_SCORE_LEVELS`（计划里带了它，但全文用不到）：
 * tsconfig 开了 `noUnusedLocals`（`tsconfig.base.json`），未使用的 import 会以 TS6133
 * 卡住 `lint`（`tsc --noEmit -p tsconfig.test.json`）—— 而下面的用例**不该**用它
 * （用它断言长度 = 自指，见第一条用例里的说明）。
 */
import { installRest, type RoomInfoLike } from '../src/rest';

let server: Server;
let base: string;
let rooms: RoomInfoLike[];

beforeEach(async () => {
  rooms = [];
  server = createServer();
  installRest(server, () => rooms);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('拿不到端口');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('mock REST：与真服务端同一套信封（§11.1）', () => {
  it('GET /api/config ⇒ { code: 0, data: 七键（含金币场四键 + entryMultiplier） }，四档且底分唯一、值为种子逐字', async () => {
    const res = await fetch(`${base}/api/config`);
    const body = (await res.json()) as {
      code: number;
      data: {
        baseScoreLevels: { name: string; baseScore: number }[];
        friendRoomEnabled: boolean;
        freeRoomEnabled: boolean;
        goldRoomEnabled: boolean;
        reliefEnabled: boolean;
        entryMultiplier: number;
        version: number;
      };
    };

    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    /**
     * ② 金币场：子集形状**恰好七键**（**金币场口径**；⚠️ 支付片起真 config-service 的
     * `GET /api/config` 已扩到 14 键、mock 未跟——见 `src/index.ts` 头注 / progress T5⑤。
     * `CLIENT_CONFIG_KEYS` 是单一真源；mock 给出真契约没有的键就是泄漏，客户端照着 mock 写就会错）。
     * ⚠️ **钉字面量**（不自指 `CLIENT_CONFIG_KEYS`——那会让 mock 与服务端契约改动一起被遮蔽）。
     */
    expect(Object.keys(body.data).sort()).toEqual([
      'baseScoreLevels',
      'entryMultiplier',
      'freeRoomEnabled',
      'friendRoomEnabled',
      'goldRoomEnabled',
      'reliefEnabled',
      'version',
    ]);
    expect(body.data.baseScoreLevels).toHaveLength(4);
    expect(new Set(body.data.baseScoreLevels.map((l) => l.baseScore)).size, '底分必须唯一（真表的 base_score 有 UNIQUE KEY）').toBe(
      4,
    );
    /**
     * ⚠️ **钉字面量 4，不要写 `MOCK_BASE_SCORE_LEVELS.length`**（复核订正）：写成常量本身 = **自指**
     * （把常量改成 2 档或 6 档，这两条断言跟着一起绿，零判别力）—— 而这条用例的名字声称的就是「**四档**」。
     * ⚠️ 再加一条具体值：`name` 与 `baseScore` 是**两个**字段，只数长度的话写错字段名也发现不了。
     */
    expect(body.data.baseScoreLevels).toContainEqual({ name: '休闲场', baseScore: 15 });
    /** 缺省态 = 关（生产缺省；客户端的好友房入口按它门控 ⇒ 默认隐藏）。 */
    expect(body.data.friendRoomEnabled).toBe(false);
    // 金币场四键 + 门槛倍率：迁移种子逐字（生产缺省 = 金币场入口可见〔2026-10-04 用户裁决
    // 默认开〕、救助口隐藏、倍率 10）
    expect(body.data.freeRoomEnabled).toBe(true);
    expect(body.data.goldRoomEnabled).toBe(true);
    expect(body.data.reliefEnabled).toBe(false);
    expect(body.data.entryMultiplier).toBe(10);
    expect(body.data.version).toBe(0);
  });

  it('GET /api/rooms ⇒ { code: 0, data: RoomInfo[] }；空的时候就是空数组', async () => {
    const res = await fetch(`${base}/api/rooms`);
    const body = (await res.json()) as { code: number; data: RoomInfoLike[] };
    expect(body.code).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('GET /api/rooms 把**传进来的**房间原样交回（mock 不编数据）', async () => {
    rooms = [{ code: 'MOCK01', mode: 'random', status: 'playing', playerCount: 1, maxPlayers: 3, baseScore: 80 }];
    const body = (await (await fetch(`${base}/api/rooms`)).json()) as { data: RoomInfoLike[] };
    expect(body.data).toEqual(rooms);
  });

  it('未知路径 ⇒ 404 且**不是**平台信封（不假装成功）', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.text(), '不得回一个成功的平台信封').not.toMatch(/"code"\s*:\s*0/);
  });

  it('🔴 OPTIONS 预检 ⇒ 204 + 放开 authorization 头（少了它浏览器里一条都到不了）', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status, '预检必须成功（否则浏览器根本不会发那条 GET）').toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('真响应也带 CORS 头（不只是预检那一下）', async () => {
    const res = await fetch(`${base}/api/rooms`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  /**
   * 🔴 **与 socket.io 共用同一台服务器**（2026-09-27 实测新增，不在原计划里）。
   *
   * 判别力：裸服务器（上面那些用例）**测不出**这条接缝 —— 真形态里 `installRest` 的监听者是
   * `io.httpServer` 上**追加**的，而 Node 会把**所有** request 监听者都调一遍
   * ⇒ socket.io 的轮询/预检请求会先被 engine.io 处理（写掉响应），REST 面若再答话，
   * 就是「往已发出的响应写头」（实测：进程当场退出）。
   * 这条用例用**真 socket.io 服务器**复刻那条接缝，钉住「谁的路径谁答话」。
   */
  it('🔴 与 socket.io 同机：轮询/预检归 socket.io、REST 照常，两条链路互不吞（实测过的接缝）', async () => {
    // 端口按仓规在 20000–30000 里随机挑（`listen(0)` 的动态端口会撞 Node fetch 的封禁端口表）。
    const port = 20000 + Math.floor(Math.random() * 10000);
    const httpServer = createServer();
    const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });
    io.of('/ws/ddz');
    // ⚠️ 与 `index.ts` 同形：**追加**监听者（不是替换）—— 这正是要测的接缝。
    installRest(httpServer, () => rooms);
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
    try {
      // ① engine.io 轮询握手：应答必须来自 socket.io（带 sid 的 open 包），REST 面不得插手
      const handshake = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`);
      expect(handshake.status).toBe(200);
      const handshakeBody = await handshake.text();
      expect(handshakeBody, 'engine.io 的 open 包').toContain('"sid"');

      // ② socket.io 路径上的 POST（命名空间 CONNECT）同样不归 REST 面管（跳过是按路径、不分方法）
      const sid = (JSON.parse(handshakeBody.slice(1)) as { sid: string }).sid;
      const connect = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: '40/ws/ddz,',
      });
      expect(connect.status).toBe(200);
      expect(await connect.text()).toBe('ok');

      // ③ socket.io 路径上的 OPTIONS：由 engine.io 的 cors 应答（REST 面碰了就是往已发出的响应写头）
      const sioOptions = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
      });
      expect(sioOptions.status, 'engine.io 的 cors 预检').toBe(204);

      // ④ REST 两条在这台「带 socket.io 的服务器」上照常工作
      const config = await fetch(`http://127.0.0.1:${port}/api/config`);
      expect(((await config.json()) as { code: number }).code).toBe(0);
      const nope = await fetch(`http://127.0.0.1:${port}/api/nope`);
      expect(nope.status, '未知路径仍是 REST 面的 404').toBe(404);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });
});
