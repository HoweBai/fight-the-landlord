/**
 * slice-30 —— 代理分润真库组（2026-10-26，任务 15）。
 *
 * 为什么必须有这一片：假 DB 只能钉控制流；`SAVEPOINT` / 额度首建原子 upsert / 水位结算的
 * SUM+hash 复核 / 并发 pending 闸 / 关闭期对账**只有真 MySQL**能证明。
 *
 * 分组：
 *  ⓪ 准入（快照 settings/invite → 开启两开关 → 配置计数）
 *  ① 树/比例/邀请码（建 P 80% ← A 60%，B 独立；非法树负例）
 *  ② 注册绑定（邀请码；2×2 开关矩阵；无效码 fail-closed）
 *  ③ 代理登录/守卫（首登改密、旧 token 失效、冻结仍可登录）
 *  ④ 计佣链（recharge 额度 → entry_fee −10 → A 60% / P 20% / 平台 20%）
 *  ⑤ 自玩/冻结（份额 0 且档位推进规则）
 *  ⑥ 并发首建额度 + SAVEPOINT 语句级失败（主事务照常提交 + gap）
 *  ⑦ 结算（幂等 / pending 闸 / 低 id 晚提交 409 / 驳回重申请 / 打款 / 撤回）
 *  ⑧ 人工调账（双人复核、同人 403、驳回）
 *  ⑨ 对账（真库合计 = 接口合计；关闭期不计缺口）
 *  ⑩ 鉴权交叉（agent↔player/admin；viewer/operator/finance 矩阵；config 写闸）
 *  收尾（恢复 settings/invite/表名/代理状态；读数自证）
 *
 * ⚠️ 低 id 晚提交的**构造**：真栈里「低 id 事务晚提交」需要一个跨 HTTP 的长驻事务
 *    （`spawnSync` 会冻结事件循环，做不到真正的双会话）。本片用**等价的最终状态**构造：
 *    在结算申请快照后，把一行**已被删除的低 id**佣金行重新插回（显式 id）⇒ 申请后的
 *    `(watermark, to]` 区间内出现申请时不可见的行 ⇒ 打款 SUM/hash 复核必然不一致。
 *    恢复路径（驳回 → 重新申请 → 打款）与真实并发序完全相同。
 *
 * ⚠️ 清理纪律：共享脏栈容忍（不删代理/玩家/佣金行）；只恢复**开关、表名、冻结状态**。
 *    正常/异常路径都走 `finally`；表名临时改名若未恢复，后续切片会红 —— 所以就地恢复。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  patchJson,
  postJson,
  putJson,
  type HarnessUser,
} from '../lib/http';
import { mysqlExec, mysqlNum, mysqlRows, mysqlText } from '../lib/mysql';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** `currency.apply` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

/** 本 run 的唯一后缀（同栈连跑两轮不互撞）。 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-5);
const AID = (s: string): string => `s30-${RUN_TAG}-${s}`;
const ROOM = (s: string): string => `s30-${RUN_TAG}-${s}`;

const INVITE_KEY = 'agent.inviteEnabled';

/** 随机 11 位手机号（用户/代理各自唯一；运行期生成，不固定）。 */
function phoneOf(prefix = '137'): string {
  return `${prefix}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

function tail(text: string, lines = 3): string {
  return text.trim().split('\n').slice(-lines).join(' / ');
}

/* ── RPC 直投 ─────────────────────────────────────────────────── */

const rpcApply = (
  req: CurrencyApplyRequest,
  timeoutMs = 12_000,
): Promise<RpcResult<CurrencyApplyData>> =>
  rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, req, timeoutMs);

async function recharge(user: HarnessUser, coins: number, tag: string): Promise<void> {
  const res = await rpcApply({
    actionId: AID(`rc-${tag}-${user.id}`),
    source: 'recharge',
    entries: [{ ownerId: user.id, delta: coins }],
  });
  if (res.ok !== true) {
    throw new ConformanceError(`recharge 失败（tag=${tag}）：${JSON.stringify(res)}`);
  }
}

async function entryFee(
  user: HarnessUser,
  fee: number,
  room: string,
  tag: string,
  timeoutMs = 12_000,
): Promise<RpcResult<CurrencyApplyData>> {
  return rpcApply(
    {
      actionId: `entryfee:${room}-${tag}:${user.id}`,
      source: 'entry_fee',
      entries: [{ ownerId: user.id, delta: -fee }],
      refId: room,
    },
    timeoutMs,
  );
}

/* ── 管理面 / 门户 helpers ─────────────────────────────────────── */

interface AgentCreated {
  account: {
    id: string;
    name: string;
    phone: string;
    parentId: string | null;
    rateBp: number;
    status: string;
    mustChangePassword: boolean;
  };
  initialPassword: string;
  inviteCode: string;
}

async function createAgent(
  admin: string,
  input: { name: string; phone: string; parentId?: string | null; rateBp?: number },
): Promise<AgentCreated> {
  const res = await postJson<AgentCreated>('/api/admin/agents', input, admin);
  if (res.status !== 200 || res.body?.code !== ErrCode.OK || !res.body.data) {
    throw new ConformanceError(`建代理失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

interface AgentLoginData {
  token: string;
  agent: { id: string; mustChangePassword: boolean; status: string };
}

async function agentLogin(
  phone: string,
  password: string,
): Promise<{ status: number; body: { code?: number; data?: AgentLoginData; message?: string } | null }> {
  return postJson<AgentLoginData>('/api/agent/login', { phone, password });
}

/** 首登改密后重新登录（token_version 已变 ⇒ 旧 token 作废）。 */
async function agentReady(created: AgentCreated, newPassword: string): Promise<string> {
  const first = await agentLogin(created.account.phone, created.initialPassword);
  const token0 = first.body?.data?.token;
  if (first.status !== 200 || token0 === undefined) {
    throw new ConformanceError(`代理首登失败：HTTP ${first.status} ${JSON.stringify(first.body)}`);
  }
  const changed = await postJson(
    '/api/agent/password',
    { oldPassword: created.initialPassword, newPassword },
    token0,
  );
  if (changed.status !== 200 || changed.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`代理改密失败：HTTP ${changed.status} ${JSON.stringify(changed.body)}`);
  }
  const second = await agentLogin(created.account.phone, newPassword);
  const token = second.body?.data?.token;
  if (second.status !== 200 || token === undefined) {
    throw new ConformanceError(`代理改密后登录失败：HTTP ${second.status} ${JSON.stringify(second.body)}`);
  }
  return token;
}

/** 注册（可带邀请码 / 可指定手机号）。 */
async function register(params: {
  phone?: string;
  inviteCode?: string;
  nickname: string;
}): Promise<{ status: number; body: any }> {
  const phone = params.phone ?? phoneOf();
  const body: Record<string, unknown> = { phone, password: 'passw0rd', nickname: params.nickname };
  if (params.inviteCode !== undefined) body.inviteCode = params.inviteCode;
  const res = await postJson('/api/auth/register', body);
  return { status: res.status, body: res.body };
}

function asUser(status: number, body: any, context: string): HarnessUser {
  const data = body?.data;
  if (status !== 201 || body?.code !== 0 || !data?.accessToken) {
    throw new ConformanceError(`${context}：HTTP ${status} ${JSON.stringify(body)}`);
  }
  return {
    id: String(data.user.id),
    phone: String(data.user.phone ?? ''),
    nickname: String(data.user.nickname ?? ''),
    accessToken: String(data.accessToken),
    refreshToken: String(data.refreshToken ?? ''),
  };
}

/* ── 配置同步（currency-service 缓存生效）──────────────────────── */

function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

function appliedVersionCount(version: number): number {
  return composeLogs('currency-service', 1800)
    .split('\n')
    .filter((line) => {
      const at = line.indexOf('{');
      if (at < 0) return false;
      try {
        const rec = JSON.parse(line.slice(at)) as { msg?: unknown };
        return (
          String(rec.msg ?? '').includes('config snapshot applied') &&
          new RegExp(`version=${version}\\b`).test(String(rec.msg))
        );
      } catch {
        return false;
      }
    }).length;
}

/** PUT 配置键并轮询 currency-service 的「config snapshot applied version=…」。 */
async function putConfigAndWait(
  admin: string,
  key: string,
  value: unknown,
): Promise<void> {
  interface AdminConfigData {
    config: Record<string, { value: unknown; version: number }>;
    version: number;
  }
  const before = await adminGetConfig<AdminConfigData>(admin);
  const gv0 = before.body?.data?.version ?? 0;
  const kv0 = before.body?.data?.config?.[key]?.version ?? 0;
  const expected = Math.max(gv0, kv0 + 1);
  const baseline = appliedVersionCount(expected);
  const put = await adminPutConfig(key, value, admin);
  if (put.status !== 200 || put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`PUT ${key} 失败：HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (appliedVersionCount(expected) > baseline) return;
    await sleep(500);
  }
  throw new ConformanceError(
    `currency-service 未在 30s 内应用配置 version=${expected}（key=${key}）——` +
      `最近日志：${tail(composeLogs('currency-service', 120), 6)}`,
  );
}

/* ── 主流程 ───────────────────────────────────────────────────── */

export async function runSlice30(): Promise<{ passed: string[] }> {
  const checks = new Checks();
  const admin = await adminLogin();

  let settings0: { enabled: boolean; minSettlementYuan: number } | null = null;
  let invite0: unknown = false;
  let agentA: AgentCreated | null = null;
  let agentB: AgentCreated | null = null;
  let u1: HarnessUser | null = null;
  let tokenA = '';
  let tokenB = '';
  let tableRenamed = false;
  const runBase = mysqlNum('SELECT COALESCE(SUM(`commission_micro`), 0) FROM `agent_commission_entries`');
  const expectedBase = mysqlNum(
    'SELECT COALESCE(SUM(`base_amount` * `top_rate_bp`), 0) FROM `agent_revenue_events`',
  );
  const gapBase = mysqlNum('SELECT COUNT(*) FROM `agent_ledger_gaps`');

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ⓪ 准入：快照 → 开启两开关 → 配置计数
    // ══════════════════════════════════════════════════════════════════════
    step('⓪ 准入：快照 settings/agent.inviteEnabled → 开启 → 配置计数（94/22）');
    const settingsRes = await getJson<{ enabled: boolean; minSettlementYuan: number }>(
      '/api/admin/agents/settings',
      admin,
    );
    if (settingsRes.body?.code !== ErrCode.OK || settingsRes.body.data === undefined) {
      throw new ConformanceError(`读取代理设置失败：HTTP ${settingsRes.status} ${JSON.stringify(settingsRes.body)}`);
    }
    settings0 = settingsRes.body.data;
    const inviteRes = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(admin);
    invite0 = inviteRes.body?.data?.config?.[INVITE_KEY]?.value ?? false;

    // 总是「先关再开」：在 settings_history 里切出一个**从本次运行开始**的启用区间
    // （共享脏栈上也能把旧区间的台费流水排除在 missingEvent 统计之外；fresh 栈的
    //  disable 是 no-op）。
    const offOld = await patchJson('/api/admin/agents/settings', { enabled: false }, admin);
    checks.that(
      offOld.status === 200 && offOld.body?.data?.enabled === false,
      '准入：先关闭旧启用区间（fresh 栈为 no-op）',
    );
    const enabledAt = new Date();
    const on = await patchJson(
      '/api/admin/agents/settings',
      { enabled: true, minSettlementYuan: 0 },
      admin,
    );
    checks.that(
      on.status === 200 && on.body?.code === ErrCode.OK && on.body.data?.enabled === true,
      `PATCH /api/admin/agents/settings {enabled:true} ⇒ 200/true —— 实际 HTTP ${on.status} ${JSON.stringify(on.body)}`,
    );
    checks.eq(on.body?.data?.minSettlementYuan, 0, '准入：最低结算额临时置 0（小额用例）');
    // 总是写一次 true（同值也写）：既保证 currency 缓存生效，也让断言条数与环境无关。
    await putConfigAndWait(admin, INVITE_KEY, true);
    checks.ok(`PUT ${INVITE_KEY}=true → currency-service 缓存生效`);

    const adminCfg = await adminGetConfig<{ config: Record<string, unknown> }>(admin);
    const cfgKeys = Object.keys(adminCfg.body?.data?.config ?? {});
    checks.eq(cfgKeys.length, 94, '管理端配置键数恰 94（protocol CONFIG_KEYS）');
    checks.that(cfgKeys.includes(INVITE_KEY), `管理端配置含 ${INVITE_KEY}`);

    const probeReg = await register({ nickname: `s30-probe-${RUN_TAG}` });
    const probe = asUser(probeReg.status, probeReg.body, '探针注册');
    const clientCfg = await getJson<Record<string, unknown>>('/api/config', probe.accessToken);
    const clientKeys = Object.keys(clientCfg.body?.data ?? {});
    checks.eq(clientKeys.length, 22, '客户端配置子集恰 22 键（CLIENT_CONFIG_KEYS）');
    checks.eq(
      clientCfg.body?.data?.agentInviteEnabled,
      true,
      'GET /api/config agentInviteEnabled=true（客户端可见裸名）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ① 树/比例/邀请码
    // ══════════════════════════════════════════════════════════════════════
    step('① 建树：P 80% ← A 60%，B 60% 独立；非法树/重号负例');
    const P = await createAgent(admin, {
      name: `S30-P-${RUN_TAG}`,
      phone: phoneOf('136'),
      rateBp: 8000,
    });
    agentA = await createAgent(admin, {
      name: `S30-A-${RUN_TAG}`,
      phone: phoneOf('136'),
      parentId: P.account.id,
      rateBp: 6000,
    });
    agentB = await createAgent(admin, {
      name: `S30-B-${RUN_TAG}`,
      phone: phoneOf('136'),
      rateBp: 6000,
    });
    checks.eq(agentA.account.parentId, P.account.id, 'A 的上级 = P');
    checks.eq(agentA.account.rateBp, 6000, 'A 比例 = 6000bp（60%）');
    checks.eq(P.account.rateBp, 8000, 'P 比例 = 8000bp（80%）');
    for (const [label, created] of [
      ['P', P],
      ['A', agentA],
      ['B', agentB],
    ] as const) {
      checks.that(
        /^[A-HJ-NP-Z2-9]{8}$/.test(created.inviteCode),
        `${label} 邀请码形状 = 8 字符 [A-HJ-NP-Z2-9] —— 实际 ${created.inviteCode}`,
      );
      checks.that(
        typeof created.initialPassword === 'string' && created.initialPassword.length >= 10,
        `${label} 返回一次性初始密码（≥10 字符）`,
      );
    }

    // 收款信息（结算申请要求三字段齐全；updatePayout 的 PATCH 省略即置 NULL ⇒ 三字段同笔）。
    for (const created of [agentA, agentB]) {
      const payout = await patchJson(
        `/api/admin/agents/${created.account.id}/payout`,
        {
          payoutName: created.account.name,
          payoutAccount: '6222020202020202',
          payoutBank: 'S30 Bank',
        },
        admin,
      );
      checks.that(payout.status === 200, `${created.account.name} 收款信息写入 ⇒ 200`);
    }

    const rateViolation = await postJson(
      '/api/admin/agents',
      { name: `S30-bad-${RUN_TAG}`, phone: phoneOf('136'), parentId: agentA.account.id, rateBp: 7000 },
      admin,
    );
    checks.eq(rateViolation.body?.code, ErrCode.AGENT_RATE_INVALID, '子比例 > 父比例 ⇒ 14014');
    const dupPhone = await postJson(
      '/api/admin/agents',
      { name: `S30-dup-${RUN_TAG}`, phone: P.account.phone, rateBp: 1000 },
      admin,
    );
    checks.eq(dupPhone.body?.code, ErrCode.BAD_PARAM, '代理手机号重复 ⇒ 10001（400）');
    const cycle = await patchJson(
      `/api/admin/agents/${agentA.account.id}`,
      { parentId: agentA.account.id },
      admin,
    );
    checks.eq(cycle.body?.code, ErrCode.AGENT_RATE_INVALID, '上级设为自己（成环）⇒ 14014');

    // ══════════════════════════════════════════════════════════════════════
    // ② 注册绑定（邀请码 / 2×2 开关矩阵 / 无效码）
    // ══════════════════════════════════════════════════════════════════════
    step('② 邀请码绑定：U1→A；invite 关 ⇒ ignored；settings 关 ⇒ ignored；无效码 400/11006 且不建用户');
    const u1Reg = await register({ inviteCode: agentA.inviteCode, nickname: `s30-u1-${RUN_TAG}` });
    u1 = asUser(u1Reg.status, u1Reg.body, 'U1 注册');
    checks.eq(
      mysqlText(`SELECT \`agent_id\` FROM \`agent_bindings\` WHERE \`owner_id\` = '${u1.id}'`),
      agentA.account.id,
      'U1 绑定行 agent_id = A',
    );
    checks.eq(
      mysqlNum(`SELECT CHAR_LENGTH(\`phone_hash\`) FROM \`agent_bindings\` WHERE \`owner_id\` = '${u1.id}'`),
      64,
      '绑定 phone_hash 长度 = 64（HMAC-SHA256 hex）',
    );

    await putConfigAndWait(admin, INVITE_KEY, false);
    const ignoredByInvitePhone = phoneOf();
    const ignoredByInvite = await register({
      phone: ignoredByInvitePhone,
      inviteCode: agentA.inviteCode,
      nickname: `s30-ign-${RUN_TAG}`,
    });
    checks.eq(ignoredByInvite.status, 201, 'invite 关：带有效码仍可注册（fail-open 到未归属）');
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_bindings\` WHERE \`owner_id\` = '${ignoredByInvite.body?.data?.user?.id}'`),
      0,
      'invite 关：不产生绑定行',
    );
    await putConfigAndWait(admin, INVITE_KEY, true);

    const badPhone = phoneOf();
    const bad = await register({
      phone: badPhone,
      inviteCode: 'ZZZZZZZZ',
      nickname: `s30-badcode-${RUN_TAG}`,
    });
    checks.that(
      bad.status === 400 && bad.body?.code === ErrCode.AGENT_INVITE_INVALID,
      `无效邀请码 ⇒ 400/11006 —— 实际 HTTP ${bad.status} ${JSON.stringify(bad.body)}`,
    );
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`users\` WHERE \`phone\` = '${badPhone}'`),
      0,
      '无效邀请码 fail-closed：不建用户',
    );

    const u4Reg = await register({ inviteCode: agentA.inviteCode, nickname: `s30-u4-${RUN_TAG}` });
    const u4 = asUser(u4Reg.status, u4Reg.body, 'U4 注册');

    // settings 关 ⇒ ignored（2×2 的另一半）
    const off = await patchJson('/api/admin/agents/settings', { enabled: false }, admin);
    checks.that(off.status === 200 && off.body?.data?.enabled === false, 'PATCH settings {enabled:false} ⇒ 200/false');
    const offPhone = phoneOf();
    const ignoredBySettings = await register({
      phone: offPhone,
      inviteCode: agentA.inviteCode,
      nickname: `s30-off-${RUN_TAG}`,
    });
    checks.eq(ignoredBySettings.status, 201, 'settings 关：带有效码仍可注册');
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_bindings\` WHERE \`owner_id\` = '${ignoredBySettings.body?.data?.user?.id}'`),
      0,
      'settings 关：不产生绑定行',
    );
    const backOn = await patchJson('/api/admin/agents/settings', { enabled: true }, admin);
    checks.that(backOn.status === 200 && backOn.body?.data?.enabled === true, 'PATCH settings {enabled:true} 复原');

    // ══════════════════════════════════════════════════════════════════════
    // ③ 代理登录/守卫
    // ══════════════════════════════════════════════════════════════════════
    step('③ 代理登录：首登改密（旧 token 失效）、冻结仍可登录、错误口令 401');
    const firstLogin = await agentLogin(agentA.account.phone, agentA.initialPassword);
    const token0 = firstLogin.body?.data?.token;
    checks.that(
      firstLogin.status === 200 && token0 !== undefined && firstLogin.body?.data?.agent?.mustChangePassword === true,
      `首登 ⇒ 200 + mustChangePassword=true —— 实际 HTTP ${firstLogin.status} ${JSON.stringify(firstLogin.body)}`,
    );
    const mustChangeBlocked = await getJson('/api/agent/overview', token0!);
    checks.that(
      mustChangeBlocked.status === 403 && String(mustChangeBlocked.body?.message ?? '').includes('首次登录'),
      `must_change_password 未改密 ⇒ 403「首次登录」—— 实际 HTTP ${mustChangeBlocked.status} ${JSON.stringify(mustChangeBlocked.body)}`,
    );
    const changed = await postJson(
      '/api/agent/password',
      { oldPassword: agentA.initialPassword, newPassword: 'agent-pass-1' },
      token0,
    );
    checks.that(
      changed.status === 200 && changed.body?.data?.relogin === true,
      `代理改密 ⇒ 200/relogin:true —— 实际 HTTP ${changed.status} ${JSON.stringify(changed.body)}`,
    );
    const stale = await getJson('/api/agent/me', token0);
    checks.eq(stale.status, 401, '改密后旧 token ⇒ 401（token_version 已变）');
    const wrong = await agentLogin(agentA.account.phone, 'wrong-password');
    checks.eq(wrong.status, 401, '错误口令 ⇒ 401（不泄露用户是否存在）');
    const secondLogin = await agentLogin(agentA.account.phone, 'agent-pass-1');
    tokenA = String(secondLogin.body?.data?.token ?? '');
    checks.that(tokenA !== '', '改密后新密码登录 ⇒ token');
    const me = await getJson<{ inviteCode: string }>('/api/agent/me', tokenA);
    checks.eq(me.body?.data?.inviteCode, agentA.inviteCode, 'GET /api/agent/me inviteCode = A 的 active 码');
    tokenB = await agentReady(agentB, 'agent-pass-2');

    // 冻结仍可登录 + 只读（spec D10）
    const freeze = await postJson(
      `/api/admin/agents/${agentA.account.id}/status`,
      { status: 'frozen', reason: 's30' },
      admin,
    );
    checks.that(freeze.status === 200 && freeze.body?.data?.status === 'frozen', '冻结 A ⇒ 200/frozen');
    const frozenLogin = await agentLogin(agentA.account.phone, 'agent-pass-1');
    checks.eq(frozenLogin.status, 200, '冻结代理仍可登录（只读+结算）');
    tokenA = String(frozenLogin.body?.data?.token ?? tokenA);
    const frozenRead = await getJson('/api/agent/overview', tokenA);
    checks.eq(frozenRead.status, 200, '冻结代理 GET /api/agent/overview ⇒ 200');
    const unfreeze = await postJson(
      `/api/admin/agents/${agentA.account.id}/status`,
      { status: 'active', reason: 's30' },
      admin,
    );
    checks.that(unfreeze.status === 200 && unfreeze.body?.data?.status === 'active', '解冻 A ⇒ 200/active');

    // ══════════════════════════════════════════════════════════════════════
    // ④ 计佣链
    // ══════════════════════════════════════════════════════════════════════
    step('④ 计佣链：U1 recharge +1000 → entry_fee −10 → A 60000 / P 20000 micro（Σ=80000=上限）');
    await recharge(u1, 1000, 'u1');
    checks.eq(
      mysqlNum(`SELECT \`inflow_total\` FROM \`agent_player_quota\` WHERE \`owner_id\` = '${u1.id}'`),
      1000,
      'U1 额度 inflow_total = 1000',
    );
    const fee1 = await entryFee(u1, 10, ROOM('r1'), 'r1');
    checks.that(fee1.ok === true, `entry_fee 直投 ⇒ ok —— 实际 ${JSON.stringify(fee1)}`);
    const opId1 = fee1.ok ? fee1.data.opId : 0;
    const ev = mysqlText(
      `SELECT CONCAT(\`fee_amount\`, ':', \`base_amount\`, ':', \`top_rate_bp\`, ':', \`expected_max_micro\`, ':', COALESCE(\`skipped_reason\`, 'NULL')) ` +
        `FROM \`agent_revenue_events\` WHERE \`source_op_id\` = ${opId1}`,
    );
    checks.eq(ev, '10:10:8000:80000:NULL', 'revenue event = fee10/base10/top8000/expected80000/已计佣');
    const chain = mysqlRows(
      `SELECT CONCAT(\`agent_id\`, ':', \`level\`, ':', \`rate_bp\`, ':', \`paid_bp\`, ':', \`commission_micro\`) ` +
        `FROM \`agent_commission_entries\` WHERE \`source_op_id\` = ${opId1} ORDER BY \`level\``,
    ).map((r) => r[0]);
    checks.eq(chain.length, 2, '本笔佣金行数 = 2（A level0 + P level1）');
    checks.eq(chain[0], `${agentA.account.id}:0:6000:6000:60000`, 'A：level0 / rate6000 / paid6000 / micro60000');
    checks.eq(chain[1], `${P.account.id}:1:8000:2000:20000`, 'P：level1 / rate8000 / paid2000 / micro20000');
    checks.eq(
      mysqlNum(
        `SELECT COALESCE(SUM(\`commission_micro\`), 0) FROM \`agent_commission_entries\` WHERE \`source_op_id\` = ${opId1}`,
      ),
      80000,
      'Σmicro = 80000（= base × topBp，平台留存 0 的这一例）',
    );
    checks.eq(
      mysqlText(
        `SELECT CONCAT(\`inflow_total\`, ':', \`consumed_total\`) FROM \`agent_player_quota\` WHERE \`owner_id\` = '${u1.id}'`,
      ),
      '1000:10',
      '额度 inflow:consumed = 1000:10',
    );
    const replay = await entryFee(u1, 10, ROOM('r1'), 'r1');
    checks.that(
      replay.ok === true && replay.data.replayed === true,
      `同锚同载荷重放 ⇒ replayed:true —— 实际 ${JSON.stringify(replay)}`,
    );
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_commission_entries\` WHERE \`source_op_id\` = ${opId1}`),
      2,
      '重放不多写佣金行',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑤ 自玩 / 冻结
    // ══════════════════════════════════════════════════════════════════════
    step('⑤ 自玩（同手机号）份额 0 顺延；冻结份额 0 且推进档位');
    const selfReg = await register({
      phone: agentA.account.phone,
      inviteCode: agentA.inviteCode,
      nickname: `s30-self-${RUN_TAG}`,
    });
    const selfUser = asUser(selfReg.status, selfReg.body, '自玩玩家注册（与 A 同号）');
    await recharge(selfUser, 100, 'self');
    const selfFee = await entryFee(selfUser, 10, ROOM('self'), 'self');
    checks.that(selfFee.ok === true, `自玩 entry_fee ⇒ ok —— 实际 ${JSON.stringify(selfFee)}`);
    const selfOpId = selfFee.ok ? selfFee.data.opId : 0;
    checks.eq(
      mysqlNum(
        `SELECT COUNT(*) FROM \`agent_commission_entries\` WHERE \`source_op_id\` = ${selfOpId} AND \`agent_id\` = '${agentA.account.id}'`,
      ),
      0,
      '自玩：直接代理 A 份额 0（无佣金行）',
    );
    checks.eq(
      mysqlText(
        `SELECT CONCAT(\`paid_bp\`, ':', \`commission_micro\`) FROM \`agent_commission_entries\` ` +
          `WHERE \`source_op_id\` = ${selfOpId} AND \`agent_id\` = '${P.account.id}'`,
      ),
      '8000:80000',
      '自玩：档位不推进 ⇒ P 拿 8000bp / 80000 micro',
    );

    await postJson(
      `/api/admin/agents/${agentA.account.id}/status`,
      { status: 'frozen', reason: 's30-frozen-share' },
      admin,
    );
    const frozenFee = await entryFee(u1, 10, ROOM('frozen'), 'frozen');
    checks.that(frozenFee.ok === true, `冻结期 entry_fee ⇒ ok —— 实际 ${JSON.stringify(frozenFee)}`);
    const frozenOpId = frozenFee.ok ? frozenFee.data.opId : 0;
    checks.eq(
      mysqlNum(
        `SELECT COUNT(*) FROM \`agent_commission_entries\` WHERE \`source_op_id\` = ${frozenOpId} AND \`agent_id\` = '${agentA.account.id}'`,
      ),
      0,
      '冻结：A 份额 0（无佣金行）',
    );
    checks.eq(
      mysqlText(
        `SELECT CONCAT(\`paid_bp\`, ':', \`commission_micro\`) FROM \`agent_commission_entries\` ` +
          `WHERE \`source_op_id\` = ${frozenOpId} AND \`agent_id\` = '${P.account.id}'`,
      ),
      '2000:20000',
      '冻结：档位推进 ⇒ P 只拿级差 2000bp / 20000 micro',
    );
    await postJson(
      `/api/admin/agents/${agentA.account.id}/status`,
      { status: 'active', reason: 's30-unfreeze' },
      admin,
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑥ 并发首建额度 + SAVEPOINT
    // ══════════════════════════════════════════════════════════════════════
    step('⑥ 并发：同 owner 两条 entry_fee 并发（额度行首建原子 upsert，无 1213/gap）；SAVEPOINT 语句级失败');
    const freshReg = await register({ inviteCode: agentA.inviteCode, nickname: `s30-fresh-${RUN_TAG}` });
    const fresh = asUser(freshReg.status, freshReg.body, '并发首建玩家注册');
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_player_quota\` WHERE \`owner_id\` = '${fresh.id}'`),
      0,
      '并发前：该玩家无额度行（首建路径）',
    );
    const gapBefore = mysqlNum('SELECT COUNT(*) FROM `agent_ledger_gaps`');
    const [c1, c2] = await Promise.all([
      entryFee(fresh, 5, ROOM('c1'), 'c1', 20_000),
      entryFee(fresh, 5, ROOM('c2'), 'c2', 20_000),
    ]);
    checks.that(
      c1.ok === true && c2.ok === true,
      `并发两条 entry_fee 均成功（无死锁/锁超时）—— 实际 ${JSON.stringify([c1, c2])}`,
    );
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_player_quota\` WHERE \`owner_id\` = '${fresh.id}'`),
      1,
      '并发首建后额度行恰 1 行',
    );
    checks.eq(
      mysqlNum('SELECT COUNT(*) FROM `agent_ledger_gaps`'),
      gapBefore,
      '并发首建零 gap',
    );

    await recharge(u4, 100, 'u4');
    const u4Before = mysqlNum(
      `SELECT \`consumed_total\` FROM \`agent_player_quota\` WHERE \`owner_id\` = '${u4.id}'`,
    );
    const [d1, d2] = await Promise.all([
      entryFee(u4, 5, ROOM('d1'), 'd1', 20_000),
      entryFee(u4, 5, ROOM('d2'), 'd2', 20_000),
    ]);
    checks.that(
      d1.ok === true && d2.ok === true,
      `已有额度行的同 owner 双并发 ⇒ 均成功 —— 实际 ${JSON.stringify([d1, d2])}`,
    );
    checks.eq(
      mysqlNum(`SELECT \`consumed_total\` FROM \`agent_player_quota\` WHERE \`owner_id\` = '${u4.id}'`),
      u4Before + 10,
      '双并发各消耗 5 ⇒ consumed 增量恰 10（无丢失更新）',
    );

    // SAVEPOINT：把佣金表临时改名 ⇒ 钩子在写佣金行时语句级失败。
    const spReg = await register({ inviteCode: agentA.inviteCode, nickname: `s30-sp-${RUN_TAG}` });
    const spUser = asUser(spReg.status, spReg.body, 'SAVEPOINT 玩家注册');
    await recharge(spUser, 100, 'sp');
    const spConsumedBefore = mysqlNum(
      `SELECT \`consumed_total\` FROM \`agent_player_quota\` WHERE \`owner_id\` = '${spUser.id}'`,
    );
    mysqlExec('RENAME TABLE `agent_commission_entries` TO `agent_commission_entries_s30_bak`');
    tableRenamed = true;
    let spFee: RpcResult<CurrencyApplyData>;
    try {
      spFee = await entryFee(spUser, 7, ROOM('sp'), 'sp');
    } finally {
      mysqlExec('RENAME TABLE `agent_commission_entries_s30_bak` TO `agent_commission_entries`');
      tableRenamed = false;
    }
    checks.that(
      spFee.ok === true,
      `钩子语句级失败 ⇒ 台费 apply 仍成功（主事务提交、无免单）—— 实际 ${JSON.stringify(spFee)}`,
    );
    const spOpId = spFee.ok ? spFee.data.opId : 0;
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`currency_ops\` WHERE \`id\` = ${spOpId} AND \`source\` = 'entry_fee'`),
      1,
      'SAVEPOINT：主事务的 entry_fee op 已提交',
    );
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_revenue_events\` WHERE \`source_op_id\` = ${spOpId}`),
      0,
      'SAVEPOINT：钩子写入整段回滚（无 revenue event）',
    );
    checks.eq(
      mysqlNum(`SELECT COUNT(*) FROM \`agent_ledger_gaps\` WHERE \`source_op_id\` = ${spOpId}`),
      1,
      'SAVEPOINT：独立连接写 1 条 agent_ledger_gaps',
    );
    checks.eq(
      mysqlNum(`SELECT \`consumed_total\` FROM \`agent_player_quota\` WHERE \`owner_id\` = '${spUser.id}'`),
      spConsumedBefore,
      'SAVEPOINT：额度消耗也回滚（consumed 不变）',
    );
    const afterSp = await entryFee(spUser, 7, ROOM('sp2'), 'sp2');
    checks.that(afterSp.ok === true, 'SAVEPOINT 回滚后同一连接/表恢复，下一笔正常计佣');
    checks.eq(
      mysqlNum(
        `SELECT COUNT(*) FROM \`agent_commission_entries\` WHERE \`source_op_id\` = ${afterSp.ok ? afterSp.data.opId : 0}`,
      ),
      2,
      '恢复后下一笔佣金行 = 2（A + P）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑦ 结算
    // ══════════════════════════════════════════════════════════════════════
    step('⑦ 结算：幂等 / pending 闸 / 低 id 晚提交 409 / 驳回重申请 / 打款 / 撤回');
    const ubReg = await register({ inviteCode: agentB.inviteCode, nickname: `s30-ub-${RUN_TAG}` });
    const ub = asUser(ubReg.status, ubReg.body, 'B 名下玩家注册');
    await recharge(ub, 100, 'ub');
    const ubFee1 = await entryFee(ub, 10, ROOM('b1'), 'b1');
    const ubFee2 = await entryFee(ub, 10, ROOM('b2'), 'b2');
    checks.that(ubFee1.ok === true && ubFee2.ok === true, 'B 名下两笔 entry_fee 均成功');
    const bRows = mysqlRows(
      `SELECT \`id\`, \`commission_micro\` FROM \`agent_commission_entries\` WHERE \`agent_id\` = '${agentB.account.id}' ORDER BY \`id\``,
    );
    checks.eq(bRows.length, 2, 'B 有 2 条佣金行（用于低 id 构造）');
    const [lowId, lowMicro] = [Number(bRows[0]![0]), Number(bRows[0]![1])];
    const [, highMicro] = [Number(bRows[1]![0]), Number(bRows[1]![1])];
    checks.eq(lowMicro, 60000, 'B 低 id 行 micro = 60000（60% × 10 金币）');
    checks.eq(highMicro, 60000, 'B 高 id 行 micro = 60000');
    // 删掉低 id 行 ⇒ 制造 id 空洞；申请快照 to = 高 id（低 id 行「晚提交」后可见）。
    mysqlExec(`DELETE FROM \`agent_commission_entries\` WHERE \`id\` = ${lowId}`);

    const s1Res = await postJson<{ id: number; status: string; totalMicro: number; itemsCount: number }>(
      '/api/agent/settlements',
      { clientRequestId: `s30-cr1-${RUN_TAG}` },
      tokenB,
    );
    const s1 = s1Res.body?.data;
    checks.that(
      s1Res.status === 200 && s1?.status === 'pending',
      `B 申请结算 ⇒ pending —— 实际 HTTP ${s1Res.status} ${JSON.stringify(s1Res.body)}`,
    );
    if (s1?.id === undefined) throw new ConformanceError('S1 未返回 id');
    const s1Id = s1.id;
    checks.eq(s1?.totalMicro, 60000, 'S1 快照 totalMicro = 60000（只含高 id 行）');
    checks.eq(s1?.itemsCount, 1, 'S1 itemsCount = 1');
    const s1Retry = await postJson<{ id: number }>(
      '/api/agent/settlements',
      { clientRequestId: `s30-cr1-${RUN_TAG}` },
      tokenB,
    );
    checks.eq(s1Retry.body?.data?.id, s1Id, '同 clientRequestId 重试 ⇒ 返回原单（幂等）');
    const s1Again = await postJson(
      '/api/agent/settlements',
      { clientRequestId: `s30-cr2-${RUN_TAG}` },
      tokenB,
    );
    checks.that(
      s1Again.status === 409 && s1Again.body?.code === ErrCode.AGENT_SETTLEMENT_PENDING,
      `已有 pending ⇒ 14012 —— 实际 HTTP ${s1Again.status} ${JSON.stringify(s1Again.body)}`,
    );

    // 低 id 晚提交：显式插回低 id 佣金行（micro 多 1 ⇒ SUM/hash 必不一致）。
    mysqlExec(
      'INSERT INTO `agent_commission_entries` ' +
        '(`id`, `agent_id`, `owner_id`, `revenue_event_id`, `source_op_id`, `kind`, `level`, `rate_bp`, `paid_bp`, `commission_micro`, `reason`) ' +
        `VALUES (${lowId}, '${agentB.account.id}', NULL, NULL, NULL, 'manual', 0, 0, 0, ${lowMicro + 1}, 's30 low-id late commit')`,
    );
    const payStale = await postJson(
      `/api/admin/agent-settlements/${s1Id}/pay`,
      { voucherNo: `S30-V-${RUN_TAG}-1` },
      admin,
    );
    checks.that(
      payStale.status === 409 && payStale.body?.code === ErrCode.AGENT_SETTLEMENT_STATE,
      `低 id 晚提交 ⇒ 打款 409/14013（SUM/hash 复核失败）—— 实际 HTTP ${payStale.status} ${JSON.stringify(payStale.body)}`,
    );
    checks.eq(
      mysqlText(`SELECT \`status\` FROM \`agent_settlements\` WHERE \`id\` = ${s1Id}`),
      'pending',
      '409 后结算单仍 pending（可驳回/撤回恢复）',
    );
    const reject1 = await postJson(
      `/api/admin/agent-settlements/${s1Id}/reject`,
      { reason: 's30 low-id recovery' },
      admin,
    );
    checks.eq(reject1.status, 200, '驳回 S1 ⇒ 200');
    checks.eq(
      mysqlText(`SELECT COALESCE(\`pending_settlement_id\`, 'NULL') FROM \`agent_accounts\` WHERE \`id\` = '${agentB.account.id}'`),
      'NULL',
      '驳回后 pending_settlement_id = NULL',
    );

    const s2Res = await postJson<{
      id: number;
      totalMicro: number;
      totalCoins: number;
      itemsCount: number;
      toEntryId: number;
    }>('/api/agent/settlements', { clientRequestId: `s30-cr3-${RUN_TAG}` }, tokenB);
    const s2 = s2Res.body?.data;
    checks.that(s2Res.status === 200, `重新申请 S2 ⇒ 200 —— 实际 ${JSON.stringify(s2Res.body)}`);
    if (s2?.id === undefined) throw new ConformanceError('S2 未返回 id');
    const s2Id = s2.id;
    checks.eq(s2?.totalMicro, 120001, 'S2 totalMicro = 120001（高 id 60000 + 低 id 60001）');
    checks.eq(s2?.itemsCount, 2, 'S2 itemsCount = 2');
    checks.eq(s2?.totalCoins, 12, 'S2 totalCoins = floor(120001/10000) = 12');
    const pay2 = await postJson(
      `/api/admin/agent-settlements/${s2Id}/pay`,
      { voucherNo: `S30-V-${RUN_TAG}-2` },
      admin,
    );
    checks.that(pay2.status === 200, `打款 S2 ⇒ 200 —— 实际 HTTP ${pay2.status} ${JSON.stringify(pay2.body)}`);
    checks.eq(
      mysqlText(
        `SELECT CONCAT(\`status\`, ':', \`settled_watermark\`, ':', \`micro_carry\`, ':', COALESCE(\`pending_settlement_id\`, 'NULL')) ` +
          `FROM \`agent_accounts\` WHERE \`id\` = '${agentB.account.id}'`,
      ),
      `active:${s2?.toEntryId}:1:NULL`,
      '打款后：watermark=to / carry=1 / pending=NULL',
    );

    // 撤回：A 新增一笔佣金 → 申请 → 撤回（水位不推进）
    const wmBefore = mysqlNum(
      `SELECT \`settled_watermark\` FROM \`agent_accounts\` WHERE \`id\` = '${agentA.account.id}'`,
    );
    await entryFee(u1, 10, ROOM('cancel'), 'cancel');
    const s3Res = await postJson<{ id: number }>(
      '/api/agent/settlements',
      { clientRequestId: `s30-cr4-${RUN_TAG}` },
      tokenA,
    );
    const s3 = s3Res.body?.data;
    checks.that(s3Res.status === 200 && s3?.id !== undefined, 'A 申请 S3 ⇒ pending');
    const cancel = await postJson(`/api/agent/settlements/${s3?.id}/cancel`, {}, tokenA);
    checks.eq(cancel.status, 200, 'A 撤回 S3 ⇒ 200');
    checks.eq(
      mysqlText(`SELECT \`status\` FROM \`agent_settlements\` WHERE \`id\` = ${s3?.id}`),
      'cancelled',
      'S3 状态 = cancelled',
    );
    checks.eq(
      mysqlNum(`SELECT \`settled_watermark\` FROM \`agent_accounts\` WHERE \`id\` = '${agentA.account.id}'`),
      wmBefore,
      '撤回不推进水位',
    );

    // 并发申请：两条不同 clientRequestId 同时打 ⇒ 恰好一张 pending，另一条 14012
    const [race1, race2] = await Promise.all([
      postJson<{ id: number }>('/api/agent/settlements', { clientRequestId: `s30-race1-${RUN_TAG}` }, tokenA),
      postJson<{ id: number }>('/api/agent/settlements', { clientRequestId: `s30-race2-${RUN_TAG}` }, tokenA),
    ]);
    const raceOk = [race1, race2].filter((r) => r.status === 200);
    const raceConflict = [race1, race2].filter(
      (r) => r.status === 409 && r.body?.code === ErrCode.AGENT_SETTLEMENT_PENDING,
    );
    checks.eq(raceOk.length, 1, '并发申请：恰 1 张成功');
    checks.eq(raceConflict.length, 1, '并发申请：另 1 张 409/14012（agent 行锁）');
    const raceWinner = raceOk[0]?.body?.data?.id;
    if (raceWinner !== undefined) {
      await postJson(`/api/agent/settlements/${raceWinner}/cancel`, {}, tokenA);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ⑧ 人工调账（双人复核）
    // ══════════════════════════════════════════════════════════════════════
    step('⑧ 人工调账：另一名超管复核通过；请求人自审 403；驳回');
    const admin2Name = `s30adm${RUN_TAG.toLowerCase()}`;
    const admin2Pass = 'conformance-admin-2';
    const createAdmin2 = await postJson(
      '/api/admin/accounts',
      { username: admin2Name, password: admin2Pass, role: 'super_admin' },
      admin,
    );
    checks.that(
      createAdmin2.status === 200 || createAdmin2.status === 409,
      `第二名超管创建/已存在 —— 实际 HTTP ${createAdmin2.status} ${JSON.stringify(createAdmin2.body)}`,
    );
    const login2 = await postJson<{ token: string }>('/api/admin/login', {
      username: admin2Name,
      password: admin2Pass,
    });
    const admin2 = login2.body?.data?.token;
    checks.that(typeof admin2 === 'string', `第二名超管登录 ⇒ token —— 实际 ${JSON.stringify(login2.body)}`);
    const adjust1 = await postJson<{ id: number }>(
      `/api/admin/agents/${agentB.account.id}/adjustments`,
      { deltaCoins: 5, reason: 's30 manual +5' },
      admin,
    );
    const adj1 = adjust1.body?.data?.id;
    checks.that(adjust1.status === 200 && typeof adj1 === 'number', '发起调账 +5 ⇒ pending');
    const approve1 = await postJson(`/api/admin/agent-adjustments/${adj1}/approve`, {}, admin2);
    checks.eq(approve1.status, 200, '另一名超管复核通过 ⇒ 200');
    checks.eq(
      mysqlText(
        `SELECT CONCAT(\`kind\`, ':', \`commission_micro\`, ':', COALESCE(\`source_op_id\`, 'NULL')) ` +
          `FROM \`agent_commission_entries\` WHERE \`agent_id\` = '${agentB.account.id}' AND \`kind\` = 'manual' ORDER BY \`id\` DESC LIMIT 1`,
      ),
      'manual:50000:NULL',
      '复核通过写 manual 佣金行 50000 micro',
    );
    const adjust2 = await postJson<{ id: number }>(
      `/api/admin/agents/${agentB.account.id}/adjustments`,
      { deltaCoins: 3, reason: 's30 self-approve negative' },
      admin,
    );
    const selfApprove = await postJson(
      `/api/admin/agent-adjustments/${adjust2.body?.data?.id}/approve`,
      {},
      admin,
    );
    checks.eq(selfApprove.status, 403, '请求人自审 ⇒ 403');
    const reject2 = await postJson(
      `/api/admin/agent-adjustments/${adjust2.body?.data?.id}/reject`,
      { reason: 's30 reject' },
      admin2,
    );
    checks.eq(reject2.status, 200, '第二名超管驳回调账 ⇒ 200');

    // ══════════════════════════════════════════════════════════════════════
    // ⑨ 对账 / 关闭期
    // ══════════════════════════════════════════════════════════════════════
    step('⑨ 对账：接口合计 = 真库增量；0 ≤ Σmicro ≤ 上限；关闭期 op 不计缺口');
    const recon = await getJson<{
      entryFeeTotal: number;
      commissionMicroTotal: number;
      expectedMaxMicroTotal: number;
      gapCount: number;
      missingEventCount: number;
    }>(
      `/api/admin/agent-reconciliation?from=${encodeURIComponent(
        new Date(enabledAt.getTime() - 60_000).toISOString(),
      )}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      admin,
    );
    const r = recon.body?.data;
    checks.that(recon.status === 200 && r !== undefined, `对账接口 ⇒ 200 —— 实际 ${JSON.stringify(recon.body)}`);
    if (r === undefined) throw new ConformanceError('对账返回空 data');
    const commissionNow = mysqlNum(
      'SELECT COALESCE(SUM(`commission_micro`), 0) FROM `agent_commission_entries`',
    );
    const expectedNow = mysqlNum(
      'SELECT COALESCE(SUM(`expected_max_micro`), 0) FROM `agent_revenue_events`',
    );
    const gapNow = mysqlNum('SELECT COUNT(*) FROM `agent_ledger_gaps`');
    checks.eq(r.commissionMicroTotal, commissionNow - runBase, '对账佣金合计 = 真库佣金增量');
    checks.eq(r.expectedMaxMicroTotal, expectedNow - expectedBase, '对账理论上限 = 真库 expected_max_micro 增量');
    checks.eq(r.gapCount, gapNow - gapBase, '对账 gap 数 = 真库 gap 增量');
    checks.eq(
      r.missingEventCount,
      r.gapCount,
      '缺 revenue event 数 = gap 数（每个语句级失败的 op 都有 gap 兜底；二者之差 = 真缺口）',
    );
    checks.that(
      r.commissionMicroTotal >= 0 && r.commissionMicroTotal <= r.expectedMaxMicroTotal,
      `佣金不变量 0 ≤ ${r.commissionMicroTotal} ≤ ${r.expectedMaxMicroTotal}`,
    );

    const offForRecon = await patchJson('/api/admin/agents/settings', { enabled: false }, admin);
    checks.eq(offForRecon.status, 200, '关闭总开关（对账负例）');
    const closedFee = await entryFee(u1, 1, ROOM('closed'), 'closed');
    checks.that(closedFee.ok === true, '关闭期 entry_fee 仍可正常收（平台不受影响）');
    checks.eq(
      mysqlNum(
        `SELECT COUNT(*) FROM \`agent_revenue_events\` WHERE \`source_op_id\` = ${closedFee.ok ? closedFee.data.opId : 0}`,
      ),
      0,
      '关闭期：不写 revenue event',
    );
    const reconClosed = await getJson<{
      missingEventCount: number;
      gapCount: number;
      commissionMicroTotal: number;
    }>(
      `/api/admin/agent-reconciliation?from=${encodeURIComponent(
        new Date(enabledAt.getTime() - 60_000).toISOString(),
      )}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      admin,
    );
    checks.eq(
      reconClosed.body?.data?.missingEventCount,
      r.missingEventCount,
      '关闭期 op 不计缺口（missingEventCount 不增）',
    );
    checks.eq(
      (reconClosed.body?.data?.missingEventCount ?? -1) - (reconClosed.body?.data?.gapCount ?? -2),
      0,
      '关闭期对账：missingEventCount − gapCount 仍为 0（无真缺口）',
    );
    checks.eq(
      reconClosed.body?.data?.commissionMicroTotal,
      r.commissionMicroTotal,
      '关闭期 op 不产生佣金（合计不变）',
    );
    const backOnForRecon = await patchJson('/api/admin/agents/settings', { enabled: true }, admin);
    checks.eq(backOnForRecon.status, 200, '重新开启总开关');

    // ══════════════════════════════════════════════════════════════════════
    // ⑩ 鉴权交叉 / policy 矩阵
    // ══════════════════════════════════════════════════════════════════════
    step('⑩ 鉴权交叉：agent↔player/admin；viewer/operator/finance；agent.inviteEnabled 写闸');
    const playerOnAgent = await getJson('/api/agent/me', u1.accessToken);
    checks.eq(playerOnAgent.status, 401, '玩家 token 调 /api/agent/me ⇒ 401');
    const agentOnAdmin = await getJson('/api/admin/agents', tokenA);
    checks.eq(agentOnAdmin.status, 401, '代理 token 调 /api/admin/agents ⇒ 401');
    const crossSettlement = await getJson(`/api/agent/settlements/${s2Id}`, tokenA);
    checks.that(
      crossSettlement.status !== 200 && crossSettlement.body?.code !== undefined,
      `A 查 B 的结算单 ⇒ 非 200（IDOR）—— 实际 HTTP ${crossSettlement.status} ${JSON.stringify(crossSettlement.body)}`,
    );

    const roleAccounts: Array<{ role: string; username: string; password: string }> = [
      { role: 'viewer', username: `s30view${RUN_TAG.toLowerCase()}`, password: 'conformance-viewer-1' },
      { role: 'operator', username: `s30oper${RUN_TAG.toLowerCase()}`, password: 'conformance-oper-1' },
      { role: 'finance', username: `s30fin${RUN_TAG.toLowerCase()}`, password: 'conformance-fin-1' },
    ];
    const roleTokens: Record<string, string> = {};
    for (const account of roleAccounts) {
      const created = await postJson(
        '/api/admin/accounts',
        { username: account.username, password: account.password, role: account.role },
        admin,
      );
      checks.that(
        created.status === 200 || created.status === 409,
        `${account.role} 账号创建/已存在 —— HTTP ${created.status}`,
      );
      const loginRes = await postJson<{ token: string }>('/api/admin/login', {
        username: account.username,
        password: account.password,
      });
      const token = loginRes.body?.data?.token;
      checks.that(typeof token === 'string', `${account.role} 登录 ⇒ token`);
      roleTokens[account.role] = token!;
    }
    checks.eq(
      (await getJson('/api/admin/agents', roleTokens.viewer)).status,
      403,
      'viewer GET /api/admin/agents ⇒ 403',
    );
    checks.eq(
      (await getJson('/api/admin/agents', roleTokens.operator)).status,
      403,
      'operator GET /api/admin/agents ⇒ 403',
    );
    checks.eq(
      (await getJson('/api/admin/agents', roleTokens.finance)).status,
      200,
      'finance GET /api/admin/agents ⇒ 200（读面）',
    );
    checks.eq(
      (await getJson('/api/admin/agent-settlements', roleTokens.viewer)).status,
      403,
      'viewer GET /api/admin/agent-settlements ⇒ 403',
    );
    checks.eq(
      (
        await postJson(
          '/api/admin/agents',
          { name: `S30-fin-${RUN_TAG}`, phone: phoneOf('135'), rateBp: 1000 },
          roleTokens.finance,
        )
      ).status,
      403,
      'finance POST /api/admin/agents ⇒ 403（写面仅超管）',
    );
    const operatorConfigWrite = await putJson(
      `/api/admin/config/${INVITE_KEY}`,
      { value: false },
      roleTokens.operator,
    );
    checks.eq(operatorConfigWrite.status, 403, 'operator PUT agent.inviteEnabled ⇒ 403（P-ag0）');

    // ══════════════════════════════════════════════════════════════════════
    // 收尾
    // ══════════════════════════════════════════════════════════════════════
    step('收尾：恢复 settings/invite/表名/冻结状态（正常与异常路径同口径）');
  } finally {
    // 表名（SAVEPOINT 测试若在改名窗口内抛错）
    if (tableRenamed) {
      try {
        mysqlExec('RENAME TABLE `agent_commission_entries_s30_bak` TO `agent_commission_entries`');
      } catch (err) {
        info(`收尾：恢复佣金表名失败（需人工检查）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 代理状态
    for (const created of [agentA, agentB]) {
      if (created === null) continue;
      try {
        const row = mysqlText(
          `SELECT \`status\` FROM \`agent_accounts\` WHERE \`id\` = '${created.account.id}'`,
        );
        if (row !== 'active') {
          await postJson(
            `/api/admin/agents/${created.account.id}/status`,
            { status: 'active', reason: 's30 cleanup' },
            admin,
          );
        }
      } catch (err) {
        info(`收尾：恢复代理 ${created.account.id} 状态失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // settings（enabled + 本片临时改小的 minSettlementYuan）
    if (settings0 !== null) {
      try {
        const now = await getJson<{ enabled: boolean; minSettlementYuan: number }>(
          '/api/admin/agents/settings',
          admin,
        );
        const patch: Record<string, unknown> = {};
        if (now.body?.data?.enabled !== settings0.enabled) patch.enabled = settings0.enabled;
        if (now.body?.data?.minSettlementYuan !== settings0.minSettlementYuan) {
          patch.minSettlementYuan = settings0.minSettlementYuan;
        }
        if (Object.keys(patch).length > 0) {
          await patchJson('/api/admin/agents/settings', patch, admin);
          info(`收尾：settings 恢复 ${JSON.stringify(patch)}`);
        }
      } catch (err) {
        info(`收尾：恢复 settings 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // invite 开关
    if (invite0 !== true) {
      try {
        await putConfigAndWait(admin, INVITE_KEY, invite0);
        info(`收尾：${INVITE_KEY} 恢复为 ${JSON.stringify(invite0)}`);
      } catch (err) {
        info(`收尾：恢复 ${INVITE_KEY} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 正常路径才走到这里：临时表名必须已还原（异常路径的解药在上面的 finally）。
  checks.eq(
    mysqlNum(
      "SELECT COUNT(*) FROM `information_schema`.`tables` WHERE `table_schema` = DATABASE() AND `table_name` = 'agent_commission_entries_s30_bak'",
    ),
    0,
    '收尾读数：临时佣金表不存在（改名已还原）',
  );
  info(
    `本片登记：A=${agentA?.account.id ?? '—'} B=${agentB?.account.id ?? '—'} ` +
      `U1=${u1?.id ?? '—'}（共享脏栈保留，按 RUN_TAG=${RUN_TAG} 区分）`,
  );

  return { passed: checks.passed };
}
