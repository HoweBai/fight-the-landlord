'use strict';

/*
 * 代理门户（2026-10-26 代理分润任务 14）：纯静态、无构建、手机优先。
 * 身份只来自代理令牌（Authorization: Bearer）——查询串与请求体都不携带代理标识（IDOR 纪律）。
 * 401 统一清 token 回登录；403「首次登录」进改密页；改密成功后令牌版本已变 ⇒ 强制重新登录。
 */

const TOKEN_KEY = 'ftl-agent-token';
const PROFILE_KEY = 'ftl-agent-profile';
const PAGE_SIZE = 20;

/** 与服务端错误码对应的文案（逐字照 apps/client/src/net/copy.ts）。 */
const ERROR_TEXT = {
  11006: '邀请码无效，请确认后重试',
  11007: '当前账号已被暂停，请联系管理员',
  14011: '暂未达到结算条件',
  14012: '已有待处理的结算单，请稍后再试',
  14013: '结算状态已变化，请刷新后重试',
  14014: '分成比例或层级设置不合法',
};

const STATUS_TEXT = {
  pending: '待处理',
  paid: '已打款',
  rejected: '已驳回',
  cancelled: '已撤回',
  active: '正常',
  frozen: '已冻结',
};

const state = {
  agent: null,
  tab: 'overview',
  players: { page: 0, rows: [], loading: false, done: false },
  commissions: { page: 0, rows: [], loading: false, done: false },
  settlements: { page: 0, rows: [], loading: false, done: false },
  settlementDetailId: null,
  pendingRequestId: null,
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(text, className) {
  const node = el('button', className ?? 'btn', text);
  node.type = 'button';
  return node;
}

/* ── 会话 ─────────────────────────────────────────────────────── */

function tokenOf() {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

function profileOf() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function saveSession(token, agent) {
  localStorage.setItem(TOKEN_KEY, token);
  if (agent) localStorage.setItem(PROFILE_KEY, JSON.stringify(agent));
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
}

function logout() {
  clearSession();
  state.agent = null;
  showScreen('login');
}

function showScreen(name) {
  $('login-view').hidden = name !== 'login';
  $('change-password-view').hidden = name !== 'change';
  $('app-view').hidden = name !== 'app';
}

/* ── 通用展示 ─────────────────────────────────────────────────── */

function fmtTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** micro（1/10000 金币）→ 金币文本；仅展示，不参与计算。 */
function coinsOf(micro) {
  const n = Number(micro);
  if (!Number.isFinite(n)) return '—';
  const coins = n / 10000;
  return Number.isInteger(coins) ? String(coins) : coins.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function rateText(rateBp) {
  const n = Number(rateBp);
  return Number.isFinite(n) ? `${n / 100}%` : '—';
}

let toastTimer = null;
function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function showLoginError(text) {
  const box = $('login-error');
  box.textContent = text;
  box.hidden = !text;
}

function showPasswordError(elId, text) {
  const box = $(elId);
  box.textContent = text;
  box.hidden = !text;
}

function statCard(label, value) {
  const card = el('div', 'stat');
  card.append(
    el('div', 'stat-value', value === undefined || value === null ? '—' : String(value)),
    el('div', 'stat-label', label),
  );
  return card;
}

/* ── HTTP ─────────────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const token = tokenOf();
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(opts.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    return { status: 0, body: null };
  }
  const body = await res.json().catch(() => null);
  // 登录/改密的 401 是凭据错误，不能当会话过期（否则输错旧密码会被踢回登录）。
  if (res.status === 401 && path !== '/api/agent/login' && path !== '/api/agent/password') {
    clearSession();
    showScreen('login');
    showLoginError('登录状态已失效，请重新登录');
  }
  return { status: res.status, body };
}

function messageOf(res, fallback) {
  const code = res.body?.code;
  if (code !== undefined && code !== null && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (typeof res.body?.message === 'string' && res.body.message !== '') return res.body.message;
  return fallback;
}

function handleError(res, fallback) {
  if (res.status === 401) return; // api() 已统一处置
  showToast(res.status === 0 ? '无法连接服务器' : messageOf(res, fallback));
}

/** 403「首次登录请先修改密码」⇒ 切改密页；返回 true 表示已处置。 */
function maybeMustChange(res) {
  if (res.status === 403 && String(res.body?.message ?? '').includes('首次登录')) {
    showScreen('change');
    return true;
  }
  return false;
}

/* ── 登录 / 改密 ──────────────────────────────────────────────── */

async function login(ev) {
  ev.preventDefault();
  const phone = $('login-phone').value.trim();
  const password = $('login-password').value;
  showLoginError('');
  if (!phone || !password) return showLoginError('请输入手机号和密码');
  const submit = $('login-btn');
  submit.disabled = true;
  const res = await api('/api/agent/login', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  });
  submit.disabled = false;
  if (res.status === 200 && res.body?.data?.token) {
    saveSession(res.body.data.token, res.body.data.agent ?? null);
    if (res.body.data.agent?.mustChangePassword) {
      showScreen('change');
      $('cp-old').focus();
      return;
    }
    enterApp();
    return;
  }
  if (res.status === 429) return showLoginError('尝试过于频繁，请稍后再试');
  if (res.status === 0) return showLoginError('无法连接服务器');
  showLoginError(messageOf(res, '手机号或密码不正确'));
}

function enterApp() {
  state.agent = profileOf();
  $('who-name').textContent = state.agent?.name ?? '代理';
  $('who-rate').textContent = state.agent ? `比例 ${rateText(state.agent.rateBp)}` : '';
  showScreen('app');
  switchTab('overview');
}

async function submitPasswordChange(oldId, newId, confirmId, errorId) {
  const oldPassword = $(oldId).value;
  const newPassword = $(newId).value;
  const confirmValue = $(confirmId).value;
  showPasswordError(errorId, '');
  if (!oldPassword || !newPassword) return showPasswordError(errorId, '请填写完整');
  if (newPassword.length < 6 || newPassword.length > 64) {
    return showPasswordError(errorId, '新密码长度须为 6–64 字符');
  }
  if (newPassword !== confirmValue) return showPasswordError(errorId, '两次输入的新密码不一致');
  const res = await api('/api/agent/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  });
  if (res.status === 200) {
    clearSession();
    showScreen('login');
    showLoginError('密码已修改，请重新登录');
    return;
  }
  showPasswordError(errorId, messageOf(res, '修改密码失败'));
}

/* ── 页签 ─────────────────────────────────────────────────────── */

const TABS = ['overview', 'players', 'commissions', 'settlements', 'me'];

function switchTab(tab) {
  state.tab = tab;
  for (const name of TABS) {
    $(`tab-${name}`).hidden = name !== tab;
    $(`tab-btn-${name}`).classList.toggle('active', name === tab);
  }
  if (tab === 'overview') loadOverview();
  if (tab === 'players') loadPlayers(0);
  if (tab === 'commissions') loadCommissions(0);
  if (tab === 'settlements') loadSettlements(0);
  if (tab === 'me') loadMe();
}

/* ── 概览 ─────────────────────────────────────────────────────── */

async function loadOverview() {
  const res = await api('/api/agent/overview');
  if (maybeMustChange(res)) return;
  if (res.status !== 200 || !res.body?.data) return handleError(res, '加载概览失败');
  const d = res.body.data;
  const agent = d.agent ?? state.agent ?? {};
  state.agent = agent;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(agent));
  $('who-name').textContent = agent.name ?? '代理';
  $('who-rate').textContent = `比例 ${rateText(agent.rateBp)}`;

  const info = $('overview-info');
  info.textContent = '';
  info.append(el('p', 'line', `名称：${agent.name ?? '—'}　手机号：${agent.phoneMasked ?? '—'}`));
  info.append(el('p', 'line', `邀请码：${agent.inviteCode ?? '—'}　比例：${rateText(agent.rateBp)}`));
  info.append(
    el('p', 'line', `状态：${STATUS_TEXT[agent.status] ?? agent.status ?? '—'}　片区：${agent.region ?? '—'}`),
  );

  const cards = $('overview-cards');
  cards.textContent = '';
  for (const [label, value] of [
    ['直接玩家', d.directPlayers],
    ['30 日活跃', d.activePlayers30d],
    ['台费贡献（金币）', d.grossFeeAmount],
    ['计佣基数（金币）', d.baseAmount],
    ['累计佣金（金币）', coinsOf(d.commissionMicro)],
    ['未结佣金（金币）', coinsOf(d.unsettledMicro)],
    ['可申请（金币）', d.unsettledCoins],
    ['已打款（金币）', d.paidCoins],
    ['零头结转（金币）', coinsOf(d.carryMicro)],
  ]) {
    cards.append(statCard(label, value));
  }

  const sub = $('overview-subtree');
  if (d.subtree) {
    sub.hidden = false;
    sub.textContent = '';
    sub.append(el('h2', 'card-title', '下线汇总'));
    sub.append(
      el(
        'p',
        'line',
        `下级代理：${d.subtree.agents}　名下玩家：${d.subtree.players}　台费贡献：${d.subtree.feeAmount} 金币`,
      ),
    );
    sub.append(el('p', 'hint', '上级只看整棵下线汇总，不看下级玩家身份与金额。'));
  } else {
    sub.hidden = true;
  }
}

/* ── 玩家 ─────────────────────────────────────────────────────── */

async function loadPlayers(page) {
  if (state.players.loading) return;
  state.players.loading = true;
  const res = await api(`/api/agent/players?page=${page}&pageSize=${PAGE_SIZE}`);
  state.players.loading = false;
  if (maybeMustChange(res)) return;
  if (res.status !== 200 || !Array.isArray(res.body?.data)) {
    return handleError(res, '加载玩家失败');
  }
  state.players.page = page;
  state.players.rows = res.body.data;
  state.players.done = res.body.data.length < PAGE_SIZE;
  renderPlayers();
}

function renderPlayers() {
  const list = $('players-list');
  list.textContent = '';
  for (const p of state.players.rows) {
    const card = el('div', 'item');
    const head = el('div', 'item-head');
    head.append(
      el('strong', 'item-title', p.nickname ?? '（无昵称）'),
      el('span', 'dim', p.phoneMasked ?? '—'),
    );
    card.append(head);
    card.append(el('p', 'line', `绑定时间：${fmtTime(p.boundAt)}　台费局数：${p.games}`));
    card.append(
      el(
        'p',
        'line',
        `台费贡献：${p.feeAmount} 金币　计佣基数：${p.baseAmount}　剩余额度：${p.remainingQuota}`,
      ),
    );
    card.append(el('p', 'line strong-line', `佣金：${coinsOf(p.commissionMicro)} 金币`));
    list.append(card);
  }
  $('players-empty').textContent = state.players.rows.length === 0 ? '（暂无绑定玩家）' : '';
  renderPager('players', state.players.page, state.players.done);
}

/* ── 佣金 ─────────────────────────────────────────────────────── */

async function loadCommissions(page) {
  if (state.commissions.loading) return;
  state.commissions.loading = true;
  const res = await api(`/api/agent/commissions?page=${page}&pageSize=${PAGE_SIZE}`);
  state.commissions.loading = false;
  if (maybeMustChange(res)) return;
  if (res.status !== 200 || !Array.isArray(res.body?.data)) {
    return handleError(res, '加载佣金失败');
  }
  state.commissions.page = page;
  state.commissions.rows = res.body.data;
  state.commissions.done = res.body.data.length < PAGE_SIZE;
  renderCommissions();
}

function commissionTitle(row) {
  if (row.kind === 'manual') return '人工调账';
  if (row.level === 0) {
    const who = row.nickname ?? '玩家';
    return `${who}${row.phoneMasked ? `（${row.phoneMasked}）` : ''} · 台费佣金`;
  }
  return `下线级差 · 第 ${row.level} 级`;
}

function renderCommissions() {
  const list = $('commissions-list');
  list.textContent = '';
  for (const row of state.commissions.rows) {
    const card = el('div', 'item');
    const head = el('div', 'item-head');
    head.append(
      el('strong', 'item-title', commissionTitle(row)),
      el('span', row.settled ? 'chip done' : 'chip', row.settled ? '已结' : '未结'),
    );
    card.append(head);
    card.append(
      el(
        'p',
        'line',
        `代理比例：${rateText(row.rateBp)}　本次实付：${rateText(row.paidBp)}　佣金：${coinsOf(row.commissionMicro)} 金币`,
      ),
    );
    if (row.reason) card.append(el('p', 'line', `原因：${row.reason}`));
    card.append(el('p', 'dim', fmtTime(row.createdAt)));
    list.append(card);
  }
  $('commissions-empty').textContent =
    state.commissions.rows.length === 0 ? '（暂无佣金记录）' : '';
  renderPager('commissions', state.commissions.page, state.commissions.done);
}

/* ── 结算 ─────────────────────────────────────────────────────── */

async function loadSettlements(page) {
  if (state.settlements.loading) return;
  state.settlements.loading = true;
  const res = await api(`/api/agent/settlements?page=${page}&pageSize=${PAGE_SIZE}`);
  state.settlements.loading = false;
  if (maybeMustChange(res)) return;
  if (res.status !== 200 || !Array.isArray(res.body?.data)) {
    return handleError(res, '加载结算单失败');
  }
  state.settlements.page = page;
  state.settlements.rows = res.body.data;
  state.settlements.done = res.body.data.length < PAGE_SIZE;
  renderSettlements();
}

function renderSettlements() {
  const list = $('settlements-list');
  list.textContent = '';
  let hasPending = false;
  for (const row of state.settlements.rows) {
    if (row.status === 'pending') hasPending = true;
    const card = el('div', 'item');
    const head = el('div', 'item-head');
    head.append(
      el('strong', 'item-title', row.settlementNo),
      el('span', `chip ${row.status}`, STATUS_TEXT[row.status] ?? row.status),
    );
    card.append(head);
    card.append(el('p', 'line', `金额：${row.totalCoins} 金币　条目：${row.itemsCount}`));
    card.append(el('p', 'dim', `申请：${fmtTime(row.requestedAt)}`));
    const detailBtn = btn('详情', 'btn small');
    detailBtn.addEventListener('click', () => openSettlementDetail(row.id));
    card.append(detailBtn);
    list.append(card);
  }
  $('settlements-empty').textContent =
    state.settlements.rows.length === 0 ? '（暂无结算单）' : '';
  $('settle-hint').textContent = hasPending
    ? '已有待处理的结算单：财务打款或驳回后才能再次申请。'
    : '按需结算：一代理同时只能有一张待处理结算单。';
  $('settle-apply-btn').disabled = hasPending;
  renderPager('settlements', state.settlements.page, state.settlements.done);
}

function renderPager(prefix, page, done) {
  $(`${prefix}-page-info`).textContent = `第 ${page + 1} 页`;
  $(`${prefix}-prev`).disabled = page <= 0;
  $(`${prefix}-next`).disabled = done;
}

function newRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `ar_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function applySettlement() {
  // 网络失败时保留同一 clientRequestId 重试（服务端幂等返回原单）。
  if (!state.pendingRequestId) state.pendingRequestId = newRequestId();
  const submit = $('settle-apply-btn');
  submit.disabled = true;
  const res = await api('/api/agent/settlements', {
    method: 'POST',
    body: JSON.stringify({ clientRequestId: state.pendingRequestId }),
  });
  submit.disabled = false;
  if (res.status === 200) {
    state.pendingRequestId = null;
    showToast('结算申请已提交，等待财务审核');
    await loadSettlements(0);
    if (res.body?.data?.id) openSettlementDetail(res.body.data.id);
    return;
  }
  if (res.status === 0) {
    showToast('无法连接服务器，可再次点击用同一笔请求重试');
    return;
  }
  state.pendingRequestId = null;
  if (maybeMustChange(res)) return;
  showToast(messageOf(res, '申请结算失败'));
}

async function openSettlementDetail(id) {
  state.settlementDetailId = id;
  $('settlement-detail').hidden = false;
  $('settlement-detail-body').textContent = '加载中…';
  const res = await api(`/api/agent/settlements/${encodeURIComponent(id)}`);
  if (maybeMustChange(res)) return;
  if (res.status !== 200 || !res.body?.data?.settlement) {
    $('settlement-detail-body').textContent = messageOf(res, `加载失败（HTTP ${res.status}）`);
    return;
  }
  renderSettlementDetail(res.body.data);
}

function renderSettlementDetail(data) {
  const s = data.settlement;
  const box = $('settlement-detail-body');
  box.textContent = '';
  box.append(el('p', 'line', `单号：${s.settlementNo}　状态：${STATUS_TEXT[s.status] ?? s.status}`));
  box.append(el('p', 'line', `金额：${s.totalCoins} 金币（${s.totalMicro} micro）　条目：${s.itemsCount}`));
  box.append(el('p', 'line', `汇率：${s.coinPerYuan} 金币/元　最低：${s.minYuan} 元`));
  box.append(el('p', 'dim', `申请：${fmtTime(s.requestedAt)}`));
  if (s.decidedAt) {
    box.append(
      el(
        'p',
        'line',
        `决定：${fmtTime(s.decidedAt)}　凭证：${s.voucherNo ?? '—'}　驳回原因：${s.rejectReason ?? '—'}`,
      ),
    );
  }
  if (s.payout) {
    box.append(
      el(
        'p',
        'line',
        `收款：${s.payout.name ?? '—'} · ${s.payout.account ?? '—'} · ${s.payout.bank ?? '—'}`,
      ),
    );
  }
  box.append(el('h3', 'card-title', '明细'));
  const lines = Array.isArray(data.lines) ? data.lines : [];
  if (lines.length === 0) box.append(el('p', 'hint', '（无条目）'));
  for (const line of lines) {
    const title =
      line.level === 0
        ? `${line.nickname ?? '玩家'}${line.phoneMasked ? `（${line.phoneMasked}）` : ''}`
        : `第 ${line.level} 级下线级差`;
    box.append(el('p', 'line', `${title} · ${line.count} 条 · ${coinsOf(line.micro)} 金币`));
  }
  $('settle-cancel-btn').hidden = s.status !== 'pending';
}

async function cancelSettlement() {
  const id = state.settlementDetailId;
  if (!id) return;
  if (!confirm('撤回这张结算单？撤回不推进水位，可重新申请。')) return;
  const res = await api(`/api/agent/settlements/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
  if (res.status === 200) {
    showToast('已撤回结算单');
    await loadSettlements(0);
    await openSettlementDetail(id);
    return;
  }
  if (maybeMustChange(res)) return;
  showToast(messageOf(res, '撤回失败'));
}

/* ── 我的 ─────────────────────────────────────────────────────── */

async function loadMe() {
  const res = await api('/api/agent/me');
  if (maybeMustChange(res)) return;
  if (res.status !== 200 || !res.body?.data) return handleError(res, '加载资料失败');
  const a = res.body.data;
  state.agent = a;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(a));
  const box = $('me-body');
  box.textContent = '';
  box.append(el('h2', 'card-title', '我的资料'));
  box.append(el('p', 'line', `名称：${a.name}　手机号：${a.phoneMasked}`));
  box.append(el('p', 'line', `比例：${rateText(a.rateBp)}　状态：${STATUS_TEXT[a.status] ?? a.status}`));
  box.append(el('p', 'line', `邀请码：${a.inviteCode ?? '—'}`));
  box.append(el('p', 'line', `片区：${a.region ?? '—'}　联系人：${a.contactName ?? '—'}`));
  box.append(
    el(
      'p',
      'line',
      `收款信息：${a.payout?.name ?? '—'} · ${a.payout?.accountMasked ?? '—'} · ${a.payout?.bank ?? '—'}`,
    ),
  );
  box.append(el('p', 'hint', '收款信息只能由平台管理员修改；门户仅展示脱敏结果。'));
}

/* ── 接线 / 启动 ──────────────────────────────────────────────── */

function wire() {
  $('login-form').addEventListener('submit', login);
  $('change-password-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitPasswordChange('cp-old', 'cp-new', 'cp-confirm', 'cp-error');
  });
  $('cp-logout').addEventListener('click', () => logout());
  $('logout-btn').addEventListener('click', () => logout());

  for (const name of TABS) {
    $(`tab-btn-${name}`).addEventListener('click', () => switchTab(name));
  }

  $('players-prev').addEventListener('click', () => {
    if (state.players.page > 0) loadPlayers(state.players.page - 1);
  });
  $('players-next').addEventListener('click', () => {
    if (!state.players.done) loadPlayers(state.players.page + 1);
  });
  $('commissions-prev').addEventListener('click', () => {
    if (state.commissions.page > 0) loadCommissions(state.commissions.page - 1);
  });
  $('commissions-next').addEventListener('click', () => {
    if (!state.commissions.done) loadCommissions(state.commissions.page + 1);
  });
  $('settlements-prev').addEventListener('click', () => {
    if (state.settlements.page > 0) loadSettlements(state.settlements.page - 1);
  });
  $('settlements-next').addEventListener('click', () => {
    if (!state.settlements.done) loadSettlements(state.settlements.page + 1);
  });

  $('settle-apply-btn').addEventListener('click', applySettlement);
  $('settle-cancel-btn').addEventListener('click', cancelSettlement);
  $('settle-detail-close').addEventListener('click', () => {
    $('settlement-detail').hidden = true;
  });

  $('me-password-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitPasswordChange('me-old', 'me-new', 'me-confirm', 'me-error');
  });
}

function boot() {
  wire();
  if (tokenOf() && profileOf()) enterApp();
  else showScreen('login');
}

boot();
