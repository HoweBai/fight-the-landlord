/**
 * 切片 7 conformance：匹配 → 进房（§8.1/§8.2/§8.4/§9.8）。
 *
 * 判别力说明（为什么这些断言不是「复述实现」）：
 *  - 3 人成局这条路径切片 5 已经在跑，因此本用例的判别力来自**其余六组**：
 *    12009 重复入队、取消后可重排、席位一致性、成员裁剪与机器人 id 掩码、
 *    非成员 join 的 12004、以及**30 秒窗口后的冷启动补机器人**；
 *  - 最后一条直接判别 R44：旧实现在这里**根本不处理单人**
 *    （`if (members.length < 3) return;` 早退），玩家永久留在无 TTL 的 ZSet 里，
 *    永远不会下发 `room.matched`（R55 按负对照实测校正）。
 *
 * ⚠️ `assertNoLeak()` 的黑名单含 `players`，而 `room.join` 的 ack **合法地**带
 * `data.players: RoomPlayer[]`（§6.3），因此这里**不**对它调用 `assertNoLeak()` ——
 * 它是给 `PlayerView` 类载荷（`game.*`）用的。房间成员改为**手写**断言。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, info, step } from '../lib/assert';
import { registerUser, type HarnessUser } from '../lib/http';
import { HarnessClient } from '../lib/client';

interface RoomPlayerWire {
  id: string;
  seat: number;
  cardCount?: number;
}

export async function runSlice07(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  let lone: HarnessClient | undefined;

  try {
    step('准备 5 个真实账号（3 人成局 + 1 个非成员 + 1 个单人等补机器人）');
    const users: HarnessUser[] = [];
    for (let i = 0; i < 5; i += 1) users.push(await registerUser(i));
    for (let i = 0; i < 3; i += 1) clients.push(await HarnessClient.connect(`P${i}`, users[i]!));
    checks.ok('3 个客户端完成握手');

    // ── 1) 入队与幂等（§6.3：12009） ────────────────────────────────
    step('room.match ×3 → code 0；重复 room.match → 12009');
    for (const client of clients) {
      // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
      const ack = await client.send('room.match', { mode: 'random', baseScore: 15 });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.match code`);
    }
    const dup = await clients[0]!.send('room.match', { mode: 'random', baseScore: 15 });
    checks.eq(dup.code, ErrCode.ALREADY_IN_QUEUE, 'P0 重复 room.match code');

    // ── 2) 取消与重排（§6.3 room.unmatch） ──────────────────────────
    step('P2 room.unmatch → 0；再 room.match → 0（取消后可重排）');
    checks.eq((await clients[2]!.send('room.unmatch', {})).code, ErrCode.OK, 'P2 room.unmatch code');
    checks.eq((await clients[2]!.send('room.match', { mode: 'random', baseScore: 15 })).code, ErrCode.OK, 'P2 重排 code');

    // ── 3) 成局与 room.matched（§8.2） ──────────────────────────────
    step('3 人入队 → 成局 → 三方都收到 room.matched');
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', 25_000)));
    const roomCode = matched[0]!.payload.roomCode as string;
    checks.that(typeof roomCode === 'string' && roomCode.length > 0, `roomCode = ${roomCode}`);
    checks.eq(matched[1]!.payload.roomCode, roomCode, 'P1 的 roomCode 与 P0 一致');
    checks.eq(matched[2]!.payload.roomCode, roomCode, 'P2 的 roomCode 与 P0 一致');

    const seats = matched.map((m) => m.payload.seat as number);
    checks.eq(new Set(seats).size, 3, '三个座位号互不相同');
    checks.eq([...seats].sort().join(','), '0,1,2', '三座位恰好是 0/1/2');

    // ── 4) room.join：席位一致 + 载荷裁剪 + §9.8 掩码 ────────────────
    step('room.join ×3：ack 席位与 room.matched 一致，成员载荷恰好 3 项且无 bot 前缀 id');
    for (const [i, client] of clients.entries()) {
      const ack = await client.send('room.join', { roomCode });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.join code`);
      checks.eq(ack.data?.roomCode, roomCode, `${client.label} ack.roomCode`);
      checks.eq(ack.data?.seat, seats[i], `${client.label} ack.seat 与 room.matched 一致`);

      const players = (ack.data?.players ?? []) as RoomPlayerWire[];
      checks.eq(players.length, 3, `${client.label} ack.players 数量`);
      for (const p of players) {
        // §6.4 规则 3：RoomPlayer 元素允许 `id`/`seat`/`cardCount?`/`nickname?`
        //（昵称片起 `nickname` 可选加入——人类有昵称才带，机器人/缺失省略）。
        const fields = Object.keys(p);
        const allowed = new Set(['id', 'seat', 'cardCount', 'nickname']);
        const illegal = fields.filter((f) => !allowed.has(f)).sort();
        if (!fields.includes('id') || !fields.includes('seat') || illegal.length > 0) {
          throw new Error(`${client.label} ack.players 元素字段非法：${Object.keys(p).sort().join(',')}`);
        }
        if (p.id.startsWith('bot')) throw new Error(`${client.label} 泄漏了 bot 前缀 id：${p.id}`);
      }
      checks.ok(`${client.label} ack.players 裁剪正确（无 isRobot / 无 bot 前缀 id）`);
      if (JSON.stringify(ack.data).includes('isRobot')) {
        throw new Error(`${client.label} ack 出现 isRobot（§6.4 规则 3 / §9.8）`);
      }
    }

    // ── 5) 进房后能收到 game.deal（§8.2：「并开始接收 game.* 推送」） ──
    step('room.join 后三方都收到 game.deal（无 §6.4 泄漏）');
    const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
    for (const [i, deal] of deals.entries()) {
      assertNoLeak(deal.payload, `game.deal(P${i})`);
      checks.eq(deal.payload.seat, seats[i], `P${i} game.deal.seat 与 ack.seat 一致`);
    }

    // ── 6) 反例：非成员 join（§5.3 越权防护 / 12004） ────────────────
    step('反例：第 4 个账号 room.join 同一房间 → 12004（**不是** 12001）');
    const stranger = await HarnessClient.connect('stranger', users[3]!);
    try {
      const ack = await stranger.send('room.join', { roomCode });
      checks.eq(ack.code, ErrCode.NOT_IN_ROOM, '非成员 room.join code（房间存在，故不是 12001）');
    } finally {
      stranger.close();
    }
    const ghost = await clients[0]!.send('room.join', { roomCode: 'NOPE99' });
    checks.eq(ghost.code, ErrCode.ROOM_NOT_FOUND, '不存在的房间 → 12001');

    // ── 7) 30 秒窗口 → 冷启动补机器人（§8.4②/R44）──────────────────
    step('单人在队列里等 30 秒 → 必须收到 room.matched（补机器人），而不是被静默丢弃');
    lone = await HarnessClient.connect('lone', users[4]!);
    const loneMatch = await lone.send('room.match', { mode: 'random', baseScore: 15 });
    checks.eq(loneMatch.code, ErrCode.OK, '单人 room.match code');

    const loneMatchedAt = Date.now();
    const loneMatched = await lone.waitFor('room.matched', 50_000);
    info(`单人等待 ${((Date.now() - loneMatchedAt) / 1000).toFixed(1)}s 后成局（窗口 30s + 扫描 ≤5s）`);
    const loneRoom = loneMatched.payload.roomCode as string;
    checks.that(typeof loneRoom === 'string' && loneRoom.length > 0, `补位房间 roomCode = ${loneRoom}`);

    const loneAck = await lone.send('room.join', { roomCode: loneRoom });
    checks.eq(loneAck.code, ErrCode.OK, '单人 room.join code');
    const lonePlayers = (loneAck.data?.players ?? []) as RoomPlayerWire[];
    checks.eq(lonePlayers.length, 3, '补位后房间恰好 3 席');
    if (lonePlayers.some((p) => p.id.startsWith('bot'))) {
      throw new Error(`补位房间泄漏 bot 前缀 id：${JSON.stringify(lonePlayers)}`);
    }
    checks.ok('补位房间成员 id 全部不可区分（§9.8）');

    // 补位对局必须**真的开局**：机器人只入座（`room.players`）却没送进 game-service
    // 这类断层，只有「补位后仍收得到 game.deal」才抓得到。
    // 它同时覆盖 R48 的另一半：`game.deal` 的投递路由必须用 `room.players` 里的**真实**
    // id（出站掩码不得进入 `seatOwners`），否则机器人座位永远收不到牌。
    //
    // ⚠️ **不要**在这里加「对局能打完 / 机器人会行动」的断言：回合驱动（§9.4）与 AI 策略
    // （§9.3）属 `slice-11`（§9 机器人系统）。本步只负责「机器人入座 + 开局」。
    //
    // ⚠️ **本注释在切片 11 之后已更新（R213）**：本片之前「机器人不会行动、只能靠 30s 回合
    // 超时兜底（容器日志 `Turn timeout … seat 1 (bot-…)`）」是当时的**预期证据**；切片 11
    // 落地 §9.4 的服务端驱动后，机器人会在 `thinkingSpeed` 量级（基础手速 1–3s，每回合 ±300ms）
    // 内**自己行动**，因此「补位房间的机器人静止不动」不再是预期事实，`slice-11` 才对它下判据。
    // 本步骤的断言与它无关（只有 `game.deal` 那一条），因此不受影响。
    const loneDeal = await lone.waitFor('game.deal', 25_000);
    assertNoLeak(loneDeal.payload, 'game.deal(lone)');
    checks.eq(loneDeal.payload.seat, loneAck.data?.seat, '补位后单人 game.deal.seat 与 ack.seat 一致');

    // 30 秒窗口本身：不超过 30s 就成局说明窗口被绕过（bots 过早补），也属违规
    const waitedMs = Date.now() - loneMatchedAt;
    checks.that(waitedMs >= 25_000, `单人等满等待窗口才补位（实测 ${(waitedMs / 1000).toFixed(1)}s ≥ 25s）`);

    return checks;
  } finally {
    lone?.close();
    for (const client of clients) client.close();
  }
}
