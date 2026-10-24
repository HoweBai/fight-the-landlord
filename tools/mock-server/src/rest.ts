/**
 * mock 的 **REST 面**（片② 客户端新增；片⑦ 起端点收编为 `GET /api/config`）。
 *
 * ## 为什么现在才加
 *
 * mock 一直是**纯 socket.io** 的（连 express 都没有）—— 因为「没有 REST 也能开发」。
 * 片② 客户端起，**大厅挂载就要读 `GET /api/config`**（底分只能来自服务端，
 * M09）⇒ 对着一个没有 REST 的 mock 跑，大厅的档位区永远是空的、**没有卡可点**。
 * （旧端点 `GET /api/base-score-levels` 已随片⑦ user-service 的底分 RPC 退役。）
 *
 * ## 设计原则（与 `index.ts` 同源）
 *
 *  - **与契约同源**：响应一律是平台信封 `{ code, data }`（§11.1），`code: 0` 才是成功；
 *  - **不编数据**：`rooms` 由调用方以**闭包**注入（mock 的真实房间表在 `index.ts` 里），
 *    本模块只负责「把 HTTP 说成信封」这一件事；
 *  - **只读**：本片只补两条 GET。**写接口（建房 / 占座）不在范围内** ——
 *    对着纯 mock 走「好友房」的两条动作仍然跑不通（见计划的已知缺口）。
 *
 * ## 鉴权说明（`GET /api/config`）
 *
 * 真实契约里 `GET /api/config` 在**玩家验签之后**（网关 `JwtMiddleware`；它不在 §7.1 的
 * 公开白名单里，匿名请求得 401）—— mock **刻意不校验** `Authorization`：它没有 JWT 密钥、
 * 也没有用户体系（WS 面同款做法：只认握手 `auth.userId` 这个「形状对、内容假」的身份）。
 * ⇒ 「匿名必须 401」这类**越权面**由 conformance 在真栈上钉住（`slice-06` 等），
 * mock 只负责让**已带令牌**的客户端把这条路径走通（客户端每个 REST 请求都带 Bearer）。
 *
 * ⚠️ 用**裸 `node:http`**、不引 express：mock 的 `package.json` 只有 `socket.io` 一个运行时依赖，
 * 为两条 GET 引一整个框架会让它与真服务端的依赖差距变大（而 mock 的价值恰恰是「轻」）。
 *
 * ## 🔴 与 socket.io / engine.io 共用同一台 `http.Server`：**实测出来的两条纪律**
 *
 * 计划里原来写的是「`host.on('request', …)` **追加**一个监听者即可，谁先注册都不会互相吞」
 * —— 2026-09-27 用真 socket.io 实测，这句**是错的**，两条都要改：
 *
 *  1. **这台服务器不能再用 `new Server(PORT, …)` 的端口形态建**（改在 `index.ts`）：
 *     socket.io@4.8.3 的 `attach()` 在收到**端口号**时会 `createServer((req, res) => { res.writeHead(404); res.end(); })`
 *     ——默认装一个**恒 404 的 request 监听者**，且它**先于**本模块的监听者把响应写完
 *     ⇒ 本模块的 `writeHead` 抛 `Cannot write headers after they are sent`（实测：进程当场退出）。
 *     `index.ts` 因此改成「裸 `createServer()` + `new Server(httpServer, …)`」——裸 server 上没有那个监听者。
 *  2. **`/socket.io/…` 的请求必须跳过**：Node 对一次请求会把**所有** request 监听者挨个调一遍，
 *     所以「追加」出来的本模块，也会看到 socket.io 自己的请求；而 engine.io 已经写了响应
 *     （轮询）或正在**握着**响应（长轮询）⇒ 本模块再答一句 404 同样是「往已发出的响应写头」
 *     （实测同样崩）。跳过按**路径**判断、**不看方法**：GET / POST / OPTIONS 都会出现
 *     （握手是 GET、命名空间 CONNECT 是 POST、预检是 OPTIONS）。
 *
 *  ⚠️ 跳过的**只是** socket.io 自己那条路径（engine.io 的默认值，与 `new Server(…)` 的情形一致）；
 *  其余未知路径一律 `404` + 一句人话（「不假装成功」的纪律不变）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 档位表的 mock 值 —— **与 `user-service` 迁移脚本里的缺省数据同值**（休闲场 15 / 标准场 80 / 竞技场 480 / 豪侠场 1200）。 */
export const MOCK_BASE_SCORE_LEVELS: ReadonlyArray<{ name: string; baseScore: number }> = [
  { name: '休闲场', baseScore: 15 },
  { name: '标准场', baseScore: 80 },
  { name: '竞技场', baseScore: 480 },
  { name: '豪侠场', baseScore: 1200 },
];

/** `RoomInfo` 里 mock 真正知道的字段（**不多给** —— 与客户端的「不造字段」同一条纪律）。 */
export interface RoomInfoLike {
  code: string;
  mode: 'random';
  status: string;
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
}

/** 只要求「能挂一个 request 监听」——不把整台 `Server` 引进来，便于单测直接 `createServer()`。 */
export interface RequestHost {
  on(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): unknown;
}

/**
 * socket.io / engine.io 自己占用的路径（engine.io 的默认值，`new Server(…)` 未改 `path` 时即此值）。
 * ⚠️ 这几个字符是**改动点**：`index.ts` 若给 socket.io 换了 `path`，这里也要跟着换。
 */
const SOCKET_IO_PATH = '/socket.io';

/**
 * CORS 响应头（mock 只服务本机开发，放开 origin 是**刻意的**）。
 * ⚠️ `allow-headers` 必须含 `authorization`：客户端的每个 REST 请求都带 Bearer。
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
} as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * 装上 REST 面。`rooms()` 每次请求**现取**（返回当前真实房间），不是一个快照。
 *
 * ⚠️ 只处理**本模块认识的**两条路径，其余一律 `404` + 一句人话 ——
 * **不假装成功**（回 `{code:0}` 会让「对着 mock 跑不通」变成更难查的形态）。
 *
 * 🔴 **必须自带 CORS**（复核订正 2026-09-27）：mock 模式的客户端是**直连** `http://localhost:3400`
 * 的（`apps/client/.env.mock` 的 `VITE_API_BASE`），与页面 origin（5173）**跨源**；而
 * `rest.ts` 的每个请求都带 `Authorization` ⇒ 浏览器会**先发 OPTIONS 预检**。
 * ⇒ 少了这段，两条 GET 在真浏览器里**一条都到不了**（curl 能通、页面全红 —— 最难查的那种形态）。
 * ⚠️ socket.io 的 `cors: { origin: '*' }` **不覆盖**裸 `host.on('request')` 这条链路，别指望它。
 *
 * 🔴 **与 socket.io / engine.io 共用同一台 `http.Server` —— 见文件头的两条实测纪律**
 * （路径跳过在读方法之前：socket.io 的请求一律不归本模块管）。
 */
export function installRest(host: RequestHost, rooms: () => RoomInfoLike[]): void {
  host.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    // 🔴 socket.io 自己的路径先让开（含它自己的 OPTIONS 预检）—— 碰了就是往已发出的响应写头
    if (path === SOCKET_IO_PATH || path.startsWith(`${SOCKET_IO_PATH}/`)) return;
    // 预检：浏览器对「跨源 + 带 Authorization」的请求会先问一句能不能发
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/api/config') {
      // ② 金币场起七键子集（金币场口径；⚠️ 支付片起真 config-service 已扩到 14 键、mock 未跟
      // ——见文件头注 / progress T5⑤）——
      // `friendRoomEnabled: false` / `goldRoomEnabled: true`（= 生产缺省，2026-10-04 用户裁决
      // 「金币场默认开」）⇒ 客户端好友房入口按门控**隐藏**、金币场入口按门控**可见**，
      // 这正是真栈默认态；要对着 mock 走「好友房」得先把真开关打开（那是真后端的事，
      // mock 不假装能建房）。四个新值 = 迁移种子逐字
      // （`1789800000000-GoldRoom.ts`：free=true、gold=true、multiplier=10、relief=false）。
      // ⚠️ 鉴权见文件头「鉴权说明」：本端点**不校验** Authorization。
      json(res, 200, {
        code: 0,
        data: {
          baseScoreLevels: MOCK_BASE_SCORE_LEVELS,
          friendRoomEnabled: false,
          freeRoomEnabled: true,
          goldRoomEnabled: true,
          reliefEnabled: false,
          entryMultiplier: 10,
          version: 0,
        },
      });
      return;
    }
    if (req.method === 'GET' && path === '/api/rooms') {
      json(res, 200, { code: 0, data: rooms() });
      return;
    }
    json(res, 404, { error: `mock 没有这条路由：${req.method} ${path}` });
  });
}
