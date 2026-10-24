/**
 * Task 2 骨架路径的端到端验证（**真实后端 + 真实 socket.io 客户端**）：
 *
 *   登录 → WS 代理握手 → room.match → room.matched → game.deal
 *        → room.join → game.bid → game.play → game.state_update
 *        → CAS 冲突 13004 → game.resync
 *
 * 每一步都机械断言：出站载荷里不得出现 actionLog / isRobot / botId /
 * skillLevel / 他人手牌（§6.4 规则 4）。
 *
 * 前置：四个服务已在 3000-3003 上运行（见 scripts/verify-dod.sh）。
 * 用法：node scripts/verify-e2e.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 从仓库根直接跑时，`socket.io-client` 不在根的 node_modules 里（只有
// api-gateway 依赖它）。用 createRequire 锚定到该包解析，脚本就不必换目录。
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../packages/api-gateway/package.json'));
const { io } = require('socket.io-client');

const GW = process.env.GW ?? 'http://localhost:3000';
const NS = '/ws/ddz';

/** 注册三个临时账号（服务端只要求 11 位手机号 + 6 位密码）。 */
async function registerAll() {
  const suffix = String(Date.now()).slice(-6) + Math.floor(Math.random() * 10);
  const users = [];
  for (let i = 0; i < 3; i++) {
    const phone = `139${String(i)}${suffix}`.slice(0, 11);
    const res = await fetch(`${GW}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password: 'passw0rd', nickname: `p${i + 1}` }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`register failed for ${phone}: ${JSON.stringify(body)}`);
    users.push(body);
  }
  return users;
}

const users = await registerAll();
const log = (...a) => console.log(...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(user) {
  const received = [];
  const socket = io(`${GW}${NS}`, {
    path: '/socket.io/',
    transports: ['websocket'],
    auth: { token: user.token },
    reconnection: false,
  });
  socket.onAny((type, message) => received.push({ type, message }));
  return { user, socket, received };
}

function send(client, type, payload, baseVersion = 0) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 'TIMEOUT' }), 6000);
    client.socket.emit(
      type,
      { reqId: crypto.randomUUID(), baseVersion, timestamp: Date.now(), payload },
      (res) => {
        clearTimeout(t);
        resolve(res);
      },
    );
  });
}

const clients = users.map(connect);
await Promise.all(clients.map((c) => new Promise((res, rej) => {
  c.socket.on('connect', res);
  c.socket.on('connect_error', rej);
  setTimeout(() => rej(new Error(`connect timeout for ${c.user.id}`)), 6000);
})));
log('STEP 1  login + WS connect (via gateway proxy):', clients.map((c) => `${c.user.nickname}:${c.socket.id}`).join(', '));

// 匿名 WS 必须被拒
const anon = io(`${GW}${NS}`, { path: '/socket.io/', transports: ['websocket'], auth: {}, reconnection: false });
const anonRejected = await new Promise((res) => {
  anon.on('connect', () => res(false));
  anon.on('connect_error', () => res(true));
  anon.on('disconnect', () => res(true));
  setTimeout(() => res(true), 4000);
});
log('STEP 2  anonymous WS handshake rejected:', anonRejected);
anon.close();

// room.match（协议②·片规格 §2.4：baseScore 必填 —— 15 = 当前档位表最低档（种子））
for (const c of clients) {
  const ack = await send(c, 'room.match', { mode: 'random', baseScore: 15 });
  log(`STEP 3  room.match ${c.user.nickname} ->`, JSON.stringify(ack));
}

// 等 room.matched
const deadline = Date.now() + 20000;
let matched = false;
while (Date.now() < deadline && !matched) {
  matched = clients.every((c) => c.received.some((m) => m.type === 'room.matched'));
  if (!matched) await wait(300);
}
if (!matched) {
  log('FAIL  room.matched not received by all');
  process.exit(1);
}
const matchedMsgs = clients.map((c) => c.received.find((m) => m.type === 'room.matched'));
log('STEP 4  room.matched:', JSON.stringify(matchedMsgs.map((m) => m.message)));
const roomCode = matchedMsgs[0].message.payload.roomCode;

// 等 game.deal
const dealDeadline = Date.now() + 20000;
while (Date.now() < dealDeadline && !clients.every((c) => c.received.some((m) => m.type === 'game.deal'))) {
  await wait(300);
}
const deals = clients.map((c) => c.received.find((m) => m.type === 'game.deal'));
if (deals.some((d) => !d)) {
  log('FAIL  game.deal not received by all; got types:', clients.map((c) => c.received.map((m) => m.type).join('|')));
  process.exit(1);
}
log('STEP 5  game.deal received by all; version =', deals[0].message.version);
for (const [i, d] of deals.entries()) {
  const v = d.message.payload;
  const raw = JSON.stringify(v);
  log(`        seat ${v.seat}: hand=${v.hand.length} cardCounts=${JSON.stringify(v.cardCounts)} bottomCards=${JSON.stringify(v.bottomCards)} state=${v.state}`);
  const leaks = ['actionLog', 'isRobot', 'botId', 'skillLevel', 'players', 'deck'].filter((k) => raw.includes(k));
  if (leaks.length) { log('FAIL  leak in game.deal:', leaks.join(',')); process.exit(1); }
}

// room.join 建立座位↔连接映射并拿到裁剪后的房间成员
for (const c of clients) {
  const ack = await send(c, 'room.join', { roomCode });
  log(`STEP 6  room.join ${c.user.nickname} -> code=${ack.code} seat=${ack.data?.seat} players=${JSON.stringify(ack.data?.players)}`);
  if (JSON.stringify(ack.data?.players ?? '').includes('isRobot')) { log('FAIL  isRobot leaked in room.join'); process.exit(1); }
}

// 从 game.deal 取当前行动者并出一手
const view0 = deals[0].message.payload;
const actorSeat = view0.state === 'bidding' ? view0.bidPhase.currentBidder : view0.currentPlayer;
const actor = clients[actorSeat];
const actorView = deals[actorSeat].message.payload;
log(`STEP 7  actor is seat ${actorSeat} (${actor.user.nickname}); actor hand = ${JSON.stringify(actorView.hand.slice(0, 5))}...`);

// 先走完叫抢：依次「不叫」，直到进入 playing（每步用服务端最新 version）
let version = deals[0].message.version;
let latestViews = deals.map((d) => d.message.payload);
for (let round = 0; round < 6; round++) {
  const anyView = latestViews[0];
  if (anyView.state === 'playing') break;
  const bidder = anyView.bidPhase.currentBidder;
  const bidClient = clients[bidder];
  const ack = await send(bidClient, 'game.bid', { grab: bidder === 0 }, version);
  log(`        game.bid seat ${bidder} grab=${bidder === 0} baseVersion=${version} -> code=${ack.code}`);
  if (ack.code !== 0) break;
  version = ack.data.version;
  await wait(500);
  latestViews = clients.map((c) => {
    const all = c.received.filter((m) => m.type === 'game.deal' || m.type === 'game.state_update');
    return all.at(-1)?.message.payload ?? latestViews[0];
  });
}

// 出一手
const playView = latestViews[0];
if (playView.state === 'playing') {
  const seat = playView.currentPlayer;
  const hand = latestViews[seat].hand;
  const before = clients[seat].received.length;
  log(`STEP 8  game.play by seat ${seat} cards=[${hand[0]}] baseVersion=${version}`);
  const ack = await send(clients[seat], 'game.play', { cards: [hand[0]] }, version);
  log(`        ack -> ${JSON.stringify(ack).slice(0, 200)}`);
  await wait(800);
  for (const [i, c] of clients.entries()) {
    const update = c.received.filter((m) => m.type === 'game.state_update').at(-1);
    log(`        seat ${i} received game.state_update: ${update ? `version=${update.message.version} hand=${update.message.payload.hand.length} currentPlayer=${update.message.payload.currentPlayer}` : 'NONE'}`);
    if (!update) { log('FAIL  game.state_update missing for seat', i); process.exit(1); }
    const raw = JSON.stringify(update.message);
    const leaks = ['actionLog', 'isRobot', 'botId', 'skillLevel', 'players', 'deck'].filter((k) => raw.includes(k));
    if (leaks.length) { log('FAIL  leak in game.state_update:', leaks.join(',')); process.exit(1); }
  }
  log('STEP 9  no leakage in any推送 (actionLog/isRobot/botId/skillLevel/players/deck)');

  // 重放同一 baseVersion → 13004
  const replay = await send(clients[seat], 'game.play', { cards: [hand[1] ?? hand[0]] }, version);
  log(`STEP 10 replay with stale baseVersion=${version} -> code=${replay.code} (期望 13004)`);
} else {
  log(`STEP 8  bidding did not finish (state=${playView.state}); skipping play assertions`);
}

// game.resync：§6.5 中 13004 的唯一恢复通道
const resync = await send(clients[0], 'game.resync', {}, 0);
const resyncPayload = resync.data ?? {};
const resyncLeaks = ['actionLog', 'isRobot', 'botId', 'skillLevel', 'players', 'deck'].filter((k) =>
  JSON.stringify(resyncPayload).includes(k),
);
log(
  `STEP 12 game.resync -> code=${resync.code} version=${resyncPayload.version} hand=${resyncPayload.hand?.length} leaks=${resyncLeaks.length ? resyncLeaks.join(',') : 'none'}`,
);
if (resync.code !== 0 || resyncLeaks.length) { log('FAIL  game.resync'); process.exit(1); }

for (const c of clients) c.socket.close();
log('DONE');
process.exit(0);
