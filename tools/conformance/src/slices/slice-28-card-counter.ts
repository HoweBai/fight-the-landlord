/**
 * slice-28 —— 记牌器「收费 + 服务端闸」真栈组（规格 C10/C11/C14/C15/C16/C18/C40）。
 *
 * 覆盖：
 *  - ⓪ 五容器 healthy + 价格种子（10/100）；
 *  - A 购买单局卡：op/flow/purchase/entitlement 四行 + 余额/status；
 *  - B 同 requestId 重放：不重复扣/发；
 *  - C **改价后同 requestId 重试仍重放成功**（C10 的 TOCTOU 核心）+ 价格还原；
 *  - D 同 requestId 异 kind ⇒ 14010；
 *  - E 金币不足 ⇒ 14001、零行；
 *  - F 并发两笔不同 requestId ⇒ credits +2；
 *  - G 包时卡 ⇒ pass_expires_at 顺延；
 *  - H 网关无 token ⇒ 401；
 *  - I 金币局开局自动消费：credit−1 + consumption 行 kind=credit。
 *
 * 清理纪律：requestId/owner 运行期唯一（RUN_TAG）；价格写回种子 10/100；房间客户端 close。
 * ⚠️ 未知态（consume RPC 超时）**不在真栈构造**（需停服）——由 room-service 单测承载。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyCardCounterConsumeData,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type HarnessUser,
} from '../lib/http';
import { MATCH_BASE_SCORE, startFreshRoom, type FreshRoom } from '../lib/ddz-driver';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);
const PRICE_GAME = 'game.doudizhu.cardCounterPricePerGameCoins';
const PRICE_HOUR = 'game.doudizhu.cardCounterPricePerHourCoins';
const PRICE_GAME_SEED = 10;
const PRICE_HOUR_SEED = 100;

/** `currency.cardCounterConsume` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

const HEALTH_CONTAINERS = [
  'ftl-room-service',
  'ftl-user-service',
  'ftl-currency-service',
  'ftl-api-gateway',
  'ftl-config-service',
] as const;

interface CommandResult {
  code: number;
  out: string;
}

function exec(service: string, ...cmd: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, ...cmd], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

function mysqlText(sql: string): string {
  const r = exec(
    'mysql',
    'sh',
    '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`,
  );
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  const lines = r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('mysql:'));
  const last = lines[lines.length - 1];
  if (last === undefined) throw new ConformanceError(`mysql 文本读数为空（原文尾部：${tailOut(r.out)}）`);
  return last;
}

/** 计数查询（0 行也返回 '0'；用 `COUNT(*)` 保证恒一行）。 */
function countOf(table: string, where: string): string {
  return mysqlText(`SELECT COUNT(*) FROM ${table} WHERE ${where}`);
}

async function waitContainerHealthy(container: string, timeoutMs = 90_000): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const r = spawnSync('docker', ['inspect', container, '--format', '{{.State.Health.Status}}'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20_000,
    });
    last = `${(r.stdout ?? '').trim() || (r.stderr ?? '').trim()}`;
    if (last === 'healthy') return { ok: true, last };
    if (Date.now() > deadline) return { ok: false, last };
    await sleep(1000);
  }
}

/** `POST /api/admin/wallet/adjust`（管理面单笔）。 */
async function adminAdjust(
  admin: string,
  userId: string,
  delta: number,
  actionId: string,
): Promise<{ status: number; code: number | undefined; balanceAfter: number | null }> {
  const res = await postJson<{ balanceBefore: number; balanceAfter: number; opId: number }>(
    '/api/admin/wallet/adjust',
    { userId, delta, reason: `slice28 ${RUN_TAG}`, actionId },
    admin,
  );
  return {
    status: res.status,
    code: res.body?.code,
    balanceAfter: res.body?.data?.balanceAfter ?? null,
  };
}

function pc(prefix: string): string {
  return `cc${RUN_TAG}-${prefix}`;
}

function action(prefix: string, userId: string): string {
  return `cardcounter:${userId}:${pc(prefix)}`;
}

export async function runSlice28(): Promise<Checks> {
  const checks = new Checks();
  const admin = await adminLogin();
  const users: HarnessUser[] = [];
  const rooms: FreshRoom[] = [];

  try {
    step('⓪ 起手：五容器 healthy + 价格写种子（10/100）并等待快照');
    for (const container of HEALTH_CONTAINERS) {
      const h = await waitContainerHealthy(container);
      checks.that(h.ok, `⓪ ${container} healthy（${h.last}）`);
    }
    const putGame = await adminPutConfig(PRICE_GAME, PRICE_GAME_SEED, admin);
    const putHour = await adminPutConfig(PRICE_HOUR, PRICE_HOUR_SEED, admin);
    checks.eq(putGame.body?.code, ErrCode.OK, '⓪ PUT 单局价 = 10');
    checks.eq(putHour.body?.code, ErrCode.OK, '⓪ PUT 包时价 = 100');
    await sleep(1500); // ≤60s 安全网的常见生效窗

    // ── A 购买单局卡 ───────────────────────────────────────────────────
    step('A：管理调账 500 → 购买单局卡 10 ⇒ op/flow/purchase/entitlement + 余额/status');
    const u1 = await registerUser(0);
    users.push(u1);
    const adjust = await adminAdjust(admin, u1.id, 500, `cc28-${RUN_TAG}-${u1.id}-adjust1`);
    checks.eq(adjust.code, ErrCode.OK, `A 调账 500 ⇒ code 0（balanceAfter=${String(adjust.balanceAfter)}）`);

    const reqA = pc('a');
    const buyA = await postJson<Record<string, unknown>>(
      '/api/card-counter/purchase',
      { kind: 'game', requestId: reqA, expectedPrice: 10 },
      u1.accessToken,
    );
    checks.eq(buyA.status, 200, `A 购买 HTTP 200（实际 ${buyA.status}）`);
    checks.eq(buyA.body?.code, ErrCode.OK, `A 购买 code 0（实际 ${JSON.stringify(buyA.body?.code)}）`);
    const dataA = buyA.body?.data as { credits?: number; priceCharged?: number; balanceAfter?: number } | undefined;
    checks.eq(dataA?.credits, 1, 'A credits=1');
    checks.eq(dataA?.priceCharged, 10, 'A priceCharged=10（玩家确认价）');
    checks.eq(dataA?.balanceAfter, 490, 'A balanceAfter=490');
    checks.eq(
      countOf('currency_ops', `action_id='${action('a', u1.id)}' AND source='card_counter'`),
      '1',
      'A ops：恰一条 card_counter 行',
    );
    checks.eq(
      mysqlText(`SELECT price FROM card_counter_purchases WHERE action_id='${action('a', u1.id)}'`),
      '10',
      'A purchases.price=10',
    );
    checks.eq(
      mysqlText(`SELECT credits FROM card_counter_entitlements WHERE owner_id='${u1.id}'`),
      '1',
      'A entitlements.credits=1',
    );
    const statusA = await getJson<{ credits: number }>('/api/card-counter/status', u1.accessToken);
    checks.eq(statusA.body?.data?.credits, 1, 'A status.credits=1');

    // ── B 同 requestId 重放 ────────────────────────────────────────────
    step('B：同 requestId 重放 ⇒ 不重复扣/发；先制造另一笔流水 ⇒ 重放 balanceAfter=当前余额');
    const adjustB = await adminAdjust(admin, u1.id, 5, `cc28-${RUN_TAG}-${u1.id}-b-adjust`);
    checks.eq(adjustB.code, ErrCode.OK, 'B 额外调账 +5（制造「购买后又有流水」的当前余额）');
    const buyB = await postJson<Record<string, unknown>>(
      '/api/card-counter/purchase',
      { kind: 'game', requestId: reqA, expectedPrice: 10 },
      u1.accessToken,
    );
    checks.eq(buyB.body?.code, ErrCode.OK, 'B 重放 code 0');
    checks.eq(
      (buyB.body?.data as { credits?: number }).credits,
      1,
      'B credits 仍 1',
    );
    checks.eq(
      (buyB.body?.data as { balanceAfter?: number }).balanceAfter,
      495,
      'B 重放 balanceAfter=当前余额 495（不是历史 490）',
    );
    checks.eq(
      countOf('currency_ops', `action_id='${action('a', u1.id)}'`),
      '1',
      'B ops 仍 1 条',
    );
    checks.eq(
      countOf('card_counter_purchases', `action_id='${action('a', u1.id)}'`),
      '1',
      'B purchases 仍 1 行',
    );

    // ── C 改价后同 requestId 重试（C10 核心）─────────────────────────────
    step('C：改价 20 → 同 requestId/同确认价重试 ⇒ 仍重放成功（不做当前态校验）→ 还原 10');
    const putC = await adminPutConfig(PRICE_GAME, 20, admin);
    checks.eq(putC.body?.code, ErrCode.OK, 'C PUT 单局价 = 20');
    await sleep(1500);
    const buyC = await postJson<Record<string, unknown>>(
      '/api/card-counter/purchase',
      { kind: 'game', requestId: reqA, expectedPrice: 10 },
      u1.accessToken,
    );
    checks.eq(buyC.body?.code, ErrCode.OK, `C 重放 code 0（实际 ${JSON.stringify(buyC.body?.code)}）`);
    checks.eq((buyC.body?.data as { priceCharged?: number }).priceCharged, 10, 'C 行内历史价 10（不被新价覆盖）');
    checks.eq(
      countOf('currency_ops', `action_id='${action('a', u1.id)}'`),
      '1',
      'C ops 仍 1 条（未二次扣费）',
    );
    const restore = await adminPutConfig(PRICE_GAME, PRICE_GAME_SEED, admin);
    checks.eq(restore.body?.code, ErrCode.OK, 'C 价格还原 10');
    await sleep(1500);

    step('C2：关总开关 → 同号重放仍成功（effect 不评估当前态）→ 还原');
    const offPut = await adminPutConfig('game.doudizhu.cardCounterEnabled', false, admin);
    checks.eq(offPut.body?.code, ErrCode.OK, 'C2 关总开关');
    await sleep(1500);
    const offReplay = await postJson(
      '/api/card-counter/purchase',
      { kind: 'game', requestId: reqA, expectedPrice: 10 },
      u1.accessToken,
    );
    checks.eq(offReplay.body?.code, ErrCode.OK, 'C2 关闭后同号重放 code 0');
    checks.eq(
      countOf('currency_ops', `action_id='${action('a', u1.id)}'`),
      '1',
      'C2 ops 仍 1 条（未二次扣费）',
    );
    const onPut = await adminPutConfig('game.doudizhu.cardCounterEnabled', true, admin);
    checks.eq(onPut.body?.code, ErrCode.OK, 'C2 还原总开关');
    await sleep(1500);

    // ── D 同 requestId 异 kind ⇒ 14010 ─────────────────────────────────
    step('D：同 requestId 异 kind/hours ⇒ 14010、不重复扣');
    const conflict = await postJson(
      '/api/card-counter/purchase',
      { kind: 'hour', hours: 1, requestId: reqA, expectedPrice: 100 },
      u1.accessToken,
    );
    checks.eq(conflict.status, 409, `D HTTP 409（实际 ${conflict.status}）`);
    checks.eq(conflict.body?.code, 14010, `D code 14010（实际 ${JSON.stringify(conflict.body?.code)}）`);
    checks.eq(
      countOf('currency_ops', `action_id='${action('a', u1.id)}'`),
      '1',
      'D ops 仍 1 条',
    );

    // ── E 金币不足 ⇒ 14001、零行 ───────────────────────────────────────
    step('E：新账号 0 金币 ⇒ 购买 14001、零 op/purchase/entitlement');
    const poor = await registerUser(1);
    users.push(poor);
    const reqE = pc('e');
    const buyE = await postJson(
      '/api/card-counter/purchase',
      { kind: 'game', requestId: reqE, expectedPrice: 10 },
      poor.accessToken,
    );
    checks.eq(buyE.status, 409, `E HTTP 409（实际 ${buyE.status}）`);
    checks.eq(buyE.body?.code, ErrCode.E_INSUFFICIENT_FUNDS, `E code 14001（实际 ${JSON.stringify(buyE.body?.code)}）`);
    checks.eq(
      countOf('currency_ops', `action_id='${action('e', poor.id)}'`),
      '0',
      'E ops 零行',
    );
    checks.eq(
      countOf('card_counter_purchases', `action_id='${action('e', poor.id)}'`),
      '0',
      'E purchases 零行',
    );

    // ── F 并发两笔不同 requestId ⇒ credits +2 ─────────────────────────
    step('F：并发两笔不同 requestId（各 10）⇒ credits 1→3、余额 490→470');
    const [f1, f2] = await Promise.all([
      postJson('/api/card-counter/purchase', { kind: 'game', requestId: pc('f1'), expectedPrice: 10 }, u1.accessToken),
      postJson('/api/card-counter/purchase', { kind: 'game', requestId: pc('f2'), expectedPrice: 10 }, u1.accessToken),
    ]);
    checks.eq(f1.body?.code, ErrCode.OK, `F 第一笔 code 0（实际 ${JSON.stringify(f1.body?.code)}）`);
    checks.eq(f2.body?.code, ErrCode.OK, `F 第二笔 code 0（实际 ${JSON.stringify(f2.body?.code)}）`);
    checks.eq(
      mysqlText(`SELECT credits FROM card_counter_entitlements WHERE owner_id='${u1.id}'`),
      '3',
      'F credits=3（并发两笔各 +1）',
    );
    checks.eq(
      countOf('currency_ops', `action_id LIKE 'cardcounter:${u1.id}:cc${RUN_TAG}-f%' AND source='card_counter'`),
      '2',
      'F 两笔 ops',
    );

    step('F2：**并发同 requestId（同载荷）** ⇒ 一笔成功/一笔重放；ops/purchases 各 1、credits 只 +1');
    const reqConc = pc('conc');
    const concBody = { kind: 'game', requestId: reqConc, expectedPrice: 10 };
    const [c1, c2] = await Promise.all([
      postJson('/api/card-counter/purchase', concBody, u1.accessToken),
      postJson('/api/card-counter/purchase', concBody, u1.accessToken),
    ]);
    checks.that(
      c1.body?.code === ErrCode.OK && c2.body?.code === ErrCode.OK,
      `F2 两发都 code 0（成功 + 重放；实际 ${JSON.stringify([c1.body?.code, c2.body?.code])}）`,
    );
    checks.eq(
      countOf('currency_ops', `action_id='cardcounter:${u1.id}:${reqConc}'`),
      '1',
      'F2 并发同号 ops 恰 1 条',
    );
    checks.eq(
      countOf('card_counter_purchases', `action_id='cardcounter:${u1.id}:${reqConc}'`),
      '1',
      'F2 并发同号 purchases 恰 1 行',
    );
    checks.eq(
      mysqlText(`SELECT credits FROM card_counter_entitlements WHERE owner_id='${u1.id}'`),
      '4',
      'F2 credits 只 +1（1→3→4）',
    );

    // ── G 包时卡 ⇒ pass_expires_at ────────────────────────────────────
    step('G：购买包时 1 小时（100）⇒ pass_expires_at 在未来 + status 非 null');
    const reqG = pc('g');
    const buyG = await postJson<Record<string, unknown>>(
      '/api/card-counter/purchase',
      { kind: 'hour', hours: 1, requestId: reqG, expectedPrice: 100 },
      u1.accessToken,
    );
    checks.eq(buyG.body?.code, ErrCode.OK, `G code 0（实际 ${JSON.stringify(buyG.body?.code)}）`);
    const expires = (buyG.body?.data as { passExpiresAt?: number | null }).passExpiresAt;
    checks.that(typeof expires === 'number' && expires > Date.now(), `G passExpiresAt 在未来（${String(expires)}）`);
    checks.eq(
      mysqlText(
        `SELECT (pass_expires_at IS NOT NULL AND pass_expires_at > NOW(3)) FROM card_counter_entitlements WHERE owner_id='${u1.id}'`,
      ),
      '1',
      'G DB pass_expires_at 有效',
    );

    // ── H 网关无 token ⇒ 401 ──────────────────────────────────────────
    step('H：网关默认验签：无 token 的 status/purchase ⇒ 401/10002');
    const anonStatus = await getJson('/api/card-counter/status');
    checks.eq(anonStatus.status, 401, `H GET status 无 token ⇒ 401（实际 ${anonStatus.status}）`);
    checks.eq(anonStatus.body?.code, ErrCode.UNAUTHENTICATED, 'H GET status code 10002');
    const anonBuy = await postJson('/api/card-counter/purchase', { kind: 'game', requestId: pc('h'), expectedPrice: 10 });
    checks.eq(anonBuy.status, 401, `H POST purchase 无 token ⇒ 401（实际 ${anonBuy.status}）`);

    // ── I 金币局开局自动消费 ───────────────────────────────────────────
    step('I：金币局开局自动消费（credit−1 + consumption kind=credit）');
    const uGold = await registerUser(2);
    users.push(uGold);
    const adjustGold = await adminAdjust(admin, uGold.id, 500, `cc28-${RUN_TAG}-${uGold.id}-adjust2`);
    checks.eq(adjustGold.code, ErrCode.OK, 'I 调账 500');
    const buyGold = await postJson(
      '/api/card-counter/purchase',
      { kind: 'game', requestId: pc('i'), expectedPrice: 10 },
      uGold.accessToken,
    );
    checks.eq(buyGold.body?.code, ErrCode.OK, `I 购买单局卡 code 0（实际 ${JSON.stringify(buyGold.body?.code)}）`);

    const room = await startFreshRoom('S28', {
      mode: 'gold',
      baseScore: MATCH_BASE_SCORE,
      humans: 1,
      users: [uGold],
    });
    rooms.push(room);
    let consumptionKind = '';
    for (let i = 0; i < 20 && consumptionKind === ''; i += 1) {
      try {
        consumptionKind = mysqlText(
          `SELECT kind FROM card_counter_consumptions WHERE room_code='${room.roomCode}' AND owner_id='${uGold.id}'`,
        );
      } catch {
        consumptionKind = '';
      }
      if (consumptionKind === '') await sleep(500);
    }
    checks.eq(consumptionKind, 'credit', `I consumption.kind=credit（实际 ${JSON.stringify(consumptionKind)}）`);
    checks.eq(
      mysqlText(`SELECT credits FROM card_counter_entitlements WHERE owner_id='${uGold.id}'`),
      '0',
      'I credits 扣至 0',
    );

    step('J：consume 幂等直投 + 无 entitlement 行并发（C19/C18 补充）');
    const consumeReq = { roomCode: room.roomCode, ownerId: uGold.id, seat: 0 };
    const sinceConsume = await rpcCall<CurrencyCardCounterConsumeData>(
      CURRENCY_RPC,
      RPC_PATTERNS.currencyCardCounterConsume,
      consumeReq,
    );
    checks.that(
      sinceConsume.ok === true && sinceConsume.data.source === 'credit',
      `J 同房再投 consume ⇒ 回读首笔 credit（实际 ${JSON.stringify(sinceConsume)}）`,
    );
    checks.eq(
      countOf(
        'card_counter_consumptions',
        `room_code='${room.roomCode}' AND owner_id='${uGold.id}'`,
      ),
      '1',
      'J 同房 consume 行仍 1（幂等）',
    );
    checks.eq(
      mysqlText(`SELECT credits FROM card_counter_entitlements WHERE owner_id='${uGold.id}'`),
      '0',
      'J credits 不再扣（仍 0）',
    );

    const uNone = await registerUser(3);
    users.push(uNone);
    const noneRoom = `CC28N-${RUN_TAG}`.slice(0, 16);
    const noneReq = { roomCode: noneRoom, ownerId: uNone.id, seat: 0 };
    const [n1, n2] = await Promise.all([
      rpcCall<CurrencyCardCounterConsumeData>(
        CURRENCY_RPC,
        RPC_PATTERNS.currencyCardCounterConsume,
        noneReq,
      ),
      rpcCall<CurrencyCardCounterConsumeData>(
        CURRENCY_RPC,
        RPC_PATTERNS.currencyCardCounterConsume,
        noneReq,
      ),
    ]);
    checks.that(
      n1.ok === true &&
        n1.data.source === 'none' &&
        n2.ok === true &&
        n2.data.source === 'none',
      `J 无 entitlement 并发两发都 none（实际 ${JSON.stringify([n1, n2])}）`,
    );
    checks.eq(
      countOf('card_counter_consumptions', `room_code='${noneRoom}' AND owner_id='${uNone.id}'`),
      '1',
      'J 无 entitlement 并发只落 1 行（唯一键兜底）',
    );

    step('K：无权益金币局 ⇒ consumption kind=none（服务端闸关闭）');
    const uNo = await registerUser(4);
    users.push(uNo);
    const adjustNo = await adminAdjust(admin, uNo.id, 500, `cc28-${RUN_TAG}-${uNo.id}-adjust3`);
    checks.eq(adjustNo.code, ErrCode.OK, 'K 调账 500（过门槛、无权益）');
    const roomNo = await startFreshRoom('S28N', {
      mode: 'gold',
      baseScore: MATCH_BASE_SCORE,
      humans: 1,
      users: [uNo],
    });
    rooms.push(roomNo);
    let noneKind = '';
    for (let i = 0; i < 20 && noneKind === ''; i += 1) {
      try {
        noneKind = mysqlText(
          `SELECT kind FROM card_counter_consumptions WHERE room_code='${roomNo.roomCode}' AND owner_id='${uNo.id}'`,
        );
      } catch {
        noneKind = '';
      }
      if (noneKind === '') await sleep(500);
    }
    checks.eq(noneKind, 'none', `K 无权益 consumption.kind=none（实际 ${JSON.stringify(noneKind)}）`);

    step('收尾：价格还原种子 10/100 + 房间客户端 close');
    const offGame = await adminPutConfig(PRICE_GAME, PRICE_GAME_SEED, admin);
    const offHour = await adminPutConfig(PRICE_HOUR, PRICE_HOUR_SEED, admin);
    checks.eq(offGame.body?.code, ErrCode.OK, '收尾 单局价回 10');
    checks.eq(offHour.body?.code, ErrCode.OK, '收尾 包时价回 100');
    info(`本 run owner 登记：${users.map((u) => u.id).join(', ')}`);
    for (const r of rooms) for (const c of r.clients) c.close();
    return checks;
  } finally {
    try {
      for (const r of rooms) for (const c of r.clients) c.close();
      await adminPutConfig(PRICE_GAME, PRICE_GAME_SEED, admin);
      await adminPutConfig(PRICE_HOUR, PRICE_HOUR_SEED, admin);
      info('finally 兜底：价格写回种子 10/100');
    } catch (err) {
      info(
        `兜底复原失败（不影响原始结论；手动检查价格是否回 10/100）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
