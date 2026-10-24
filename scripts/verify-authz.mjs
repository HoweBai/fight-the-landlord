/** 越权与并发控制的定向验证（§5.3 / §6.5）。 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 从仓库根直接跑时，`socket.io-client` 不在根的 node_modules 里（只有
// api-gateway 依赖它）。用 createRequire 锚定到该包解析，脚本就不必换目录。
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../packages/api-gateway/package.json'));
const { io } = require('socket.io-client');
import { readFileSync } from 'fs';

const users = [1, 2, 3].map((i) => JSON.parse(readFileSync(`/tmp/user${i}.json`, 'utf8')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(user) {
  const received = [];
  const socket = io('http://localhost:3000/ws/ddz', {
    path: '/socket.io/', transports: ['websocket'], auth: { token: user.token }, reconnection: false,
  });
  socket.onAny((type, message) => received.push({ type, message }));
  return { user, socket, received };
}
const send = (c, type, payload, baseVersion = 0) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 'TIMEOUT' }), 6000);
    c.socket.emit(type, { reqId: crypto.randomUUID(), baseVersion, timestamp: Date.now(), payload }, (r) => {
      clearTimeout(t); resolve(r);
    });
  });

const clients = users.map(connect);
await Promise.all(clients.map((c) => new Promise((res) => c.socket.on('connect', res))));
// 协议②（片规格 §2.4）：room.match 的 baseScore 必填 —— 15 = 当前档位表最低档（种子 15/80/480/1200）。
for (const c of clients) await send(c, 'room.match', { mode: 'random', baseScore: 15 });

const deadline = Date.now() + 20000;
while (Date.now() < deadline && !clients.every((c) => c.received.some((m) => m.type === 'game.deal'))) await wait(300);
const deals = clients.map((c) => c.received.find((m) => m.type === 'game.deal').message.payload);
const roomCode = deals[0].roomCode;
for (const c of clients) await send(c, 'room.join', { roomCode });
console.log('room', roomCode, 'ok');

// 走完叫抢（顺带在叫抢阶段验证「不在你的回合」）
let version = clients[0].received.find((m) => m.type === 'game.deal').message.version;
let views = deals;
{
  const bidder = views[0].bidPhase.currentBidder;
  const notBidder = [0, 1, 2].find((s) => s !== bidder);
  const a = await send(clients[notBidder], 'game.bid', { grab: true }, version);
  console.log(
    `①0 bidding-phase: seat ${notBidder} bids while bidder is ${bidder} -> code=${a.code} ${a.code === 12003 ? 'OK' : 'FAIL expected 12003'}`,
  );
}
for (let i = 0; i < 4; i++) {
  if (views[0].state === 'playing') break;
  const bidder = views[0].bidPhase.currentBidder;
  const ack = await send(clients[bidder], 'game.bid', { grab: bidder === 0 }, version);
  version = ack.data.version;
  await wait(400);
  views = clients.map((c) => c.received.filter((m) => m.type === 'game.state_update').at(-1)?.message.payload ?? views[0]);
}
console.log('state', views[0].state, 'currentPlayer', views[0].currentPlayer, 'version', version);

const current = views[0].currentPlayer;
const others = [0, 1, 2].filter((s) => s !== current);
const rogue = others[0];
const rogueView = clients[rogue].received.filter((m) => m.type === 'game.state_update').at(-1)?.message.payload ?? deals[rogue];

// ① 非行动者出牌 → 12003
const a1 = await send(clients[rogue], 'game.play', { cards: [rogueView.hand[0]] }, version);
console.log(`① out-of-turn play (seat ${rogue}, currentPlayer ${current}) -> code=${a1.code} ${a1.code === 12003 ? 'OK' : 'FAIL expected 12003'}`);

// ② 非行动者叫抢 → 12003
const a2 = await send(clients[rogue], 'game.bid', { grab: true }, version);
console.log(`② bid while playing (seat ${rogue}) -> code=${a2.code} ${a2.code === 13001 ? 'OK (非法状态)' : 'CHECK'}`);

// ③ 行动者用过期 baseVersion → 13004
const a3 = await send(clients[current], 'game.play', { cards: [views[current].hand[0]] }, version + 99);
console.log(`③ stale baseVersion -> code=${a3.code} ${a3.code === 13004 ? 'OK' : 'FAIL expected 13004'}`);

// ④ game.resync 恢复
const a4 = await send(clients[current], 'game.resync', {});
console.log(`④ resync -> code=${a4.code} version=${a4.data?.version} hand=${a4.data?.hand?.length} ${a4.code === 0 && a4.data?.version === version ? 'OK' : 'CHECK'}`);

// ⑤ 相同 baseVersion 提交两次：第二次 13004
const a5 = await send(clients[current], 'game.play', { cards: [views[current].hand[0]] }, version);
const a6 = await send(clients[current], 'game.play', { cards: [views[current].hand[0]] }, version);
console.log(`⑤ same baseVersion twice -> first=${a5.code} second=${a6.code} ${a6.code === 13004 ? 'OK' : 'CHECK'}`);

for (const c of clients) c.socket.close();
process.exit(0);
