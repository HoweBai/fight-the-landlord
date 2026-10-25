#!/usr/bin/env node
/**
 * agent/ 静态三件套机械闸（零依赖；2026-10-26 代理分润任务 14）。
 *
 * 断言面：
 *  1. 文件存在；手机优先（viewport）且零外链（无外部 src/href/@import/url()）。
 *  2. 结构 id 就位（登录/改密/五页签/列表/结算/我的）。
 *  3. 只走 `/api/agent/*`；身份只从 token（代码里不得出现 agentId —— IDOR 纪律）。
 *  4. 401 清 token 回登录；403「首次登录」进改密；六个错误码文案与 apps/client copy 一致。
 *  5. 零 HTML 串赋值 / 无 eval / 无 document.write。
 *  6. edge 接线：Dockerfile.edge COPY agent、Caddyfile 两条 handle 在 catch-all 之前、
 *     根 package.json 有 verify:agent。
 *
 * 退出码：0 全过；1 有失败（逐条打印）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');
const safeRead = (p) => (existsSync(resolve(REPO_ROOT, p)) ? read(p) : '');

const failures = [];
let checks = 0;
const ok = (cond, label) => {
  checks += 1;
  if (!cond) failures.push(label);
};

/* ── 0. 文件存在 ─────────────────────────────────────────────── */
for (const f of ['agent/index.html', 'agent/app.js', 'agent/style.css']) {
  ok(existsSync(resolve(REPO_ROOT, f)), `文件存在：${f}`);
}
const html = safeRead('agent/index.html');
const app = safeRead('agent/app.js');
const css = safeRead('agent/style.css');

/* ── 1. 手机优先 + 零外链 ───────────────────────────────────── */
ok(/<meta\s+name="viewport"[^>]*width=device-width/.test(html), 'viewport 手机优先');
ok(html.includes('/agent/style.css'), 'index.html 引用 /agent/style.css');
ok(html.includes('/agent/app.js'), 'index.html 引用 /agent/app.js');
ok(!/(?:src|href)\s*=\s*["']https?:\/\//.test(html), 'index.html 无外部 src/href');
ok(!/@import/.test(css), 'style.css 无 @import');
ok(!/url\(\s*["']?https?:/.test(css), 'style.css 无外部 url()');
ok(/@media\s*\(/.test(css), 'style.css 含响应式断点');

/* ── 2. 结构 id ─────────────────────────────────────────────── */
for (const id of [
  'login-view',
  'login-form',
  'login-phone',
  'login-password',
  'login-btn',
  'login-error',
  'change-password-view',
  'change-password-form',
  'cp-old',
  'cp-new',
  'cp-confirm',
  'cp-submit',
  'cp-logout',
  'cp-error',
  'app-view',
  'who-name',
  'who-rate',
  'logout-btn',
  'tab-nav',
  'tab-overview',
  'tab-players',
  'tab-commissions',
  'tab-settlements',
  'tab-me',
  'tab-btn-overview',
  'tab-btn-players',
  'tab-btn-commissions',
  'tab-btn-settlements',
  'tab-btn-me',
  'overview-info',
  'overview-cards',
  'overview-subtree',
  'players-list',
  'players-empty',
  'players-prev',
  'players-next',
  'players-page-info',
  'commissions-list',
  'commissions-empty',
  'commissions-prev',
  'commissions-next',
  'commissions-page-info',
  'settlements-list',
  'settlements-empty',
  'settle-apply-btn',
  'settle-hint',
  'settlement-detail',
  'settlement-detail-body',
  'settle-cancel-btn',
  'settle-detail-close',
  'settlements-prev',
  'settlements-next',
  'settlements-page-info',
  'me-body',
  'me-password-form',
  'me-old',
  'me-new',
  'me-confirm',
  'me-submit',
  'me-error',
  'toast',
]) {
  ok(html.includes(`id="${id}"`), `index.html 含代理门户 id #${id}`);
}

/* ── 3. API 面 + 身份只从 token ─────────────────────────────── */
for (const needle of [
  '/api/agent/login',
  '/api/agent/password',
  '/api/agent/me',
  '/api/agent/overview',
  '/api/agent/players',
  '/api/agent/commissions',
  '/api/agent/settlements',
]) {
  ok(app.includes(needle), `app.js 含 API 路径 ${JSON.stringify(needle)}`);
}
ok(app.includes('ftl-agent-token'), 'token 存储键 ftl-agent-token');
ok(app.includes('`Bearer ${token}`'), 'Bearer 头由本地 token 组装');
ok(!/\bagentId\b/.test(app), '代码不出现 agentId（身份只从 token 取；IDOR 纪律）');
ok(!app.includes('?agentId=') && !app.includes('&agentId='), '查询串不带 agentId');
ok(!/JSON\.stringify\([^)]*agentId/.test(app), '请求体不带 agentId');

/* ── 4. 会话/改密/错误文案 ─────────────────────────────────── */
ok(app.includes('status === 401'), '401 有统一处置');
ok(app.includes('clearSession()'), '401 清会话');
ok(app.includes('mustChangePassword'), '登录响应 mustChangePassword 驱动改密页');
ok(app.includes('首次登录'), '403「首次登录」文案进改密页');
ok(app.includes('relogin') || app.includes('密码已修改'), '改密后强制重新登录');
for (const text of [
  '邀请码无效，请确认后重试',
  '当前账号已被暂停，请联系管理员',
  '暂未达到结算条件',
  '已有待处理的结算单，请稍后再试',
  '结算状态已变化，请刷新后重试',
  '分成比例或层级设置不合法',
]) {
  ok(app.includes(text), `错误文案与客户端一致：${text}`);
}

/* ── 5. 注入纪律 ───────────────────────────────────────────── */
ok(!app.includes('innerHTML'), 'app.js 零 HTML 串赋值');
ok(!app.includes('document.write'), 'app.js 无 document.write');
ok(!/\beval\s*\(/.test(app), 'app.js 无 eval');

/* ── 6. edge 接线 + 根脚本 ─────────────────────────────────── */
const edge = read('Dockerfile.edge');
ok(edge.includes('COPY agent /srv/agent'), 'Dockerfile.edge COPY agent /srv/agent');
const caddy = read('deploy/Caddyfile');
ok(caddy.includes('handle /agent {'), 'Caddyfile 含 handle /agent');
ok(caddy.includes('redir * /agent/ 301'), 'Caddyfile 裸 /agent 301（显式 matcher）');
ok(caddy.includes('handle /agent/*'), 'Caddyfile 含 handle /agent/*');
const agentBlock = /handle \/agent\/\* \{([\s\S]*?)\}/.exec(caddy)?.[1] ?? '';
ok(agentBlock.includes('root * /srv') && agentBlock.includes('file_server'), 'agent 静态块自带 root + file_server');
const agentCatchallIdx = caddy.search(/\n\thandle \{/);
ok(
  caddy.indexOf('handle /agent/*') !== -1 &&
    agentCatchallIdx !== -1 &&
    caddy.indexOf('handle /agent/*') < agentCatchallIdx,
  '/agent/* 在 catch-all handle 之前',
);
const pkg = JSON.parse(read('package.json'));
ok(
  pkg.scripts?.['verify:agent'] === 'node scripts/verify-agent-static.mjs',
  '根 package.json 有 verify:agent 脚本',
);

/* ── 汇总 ──────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`agent static verify: ${failures.length} FAILED / ${checks} checks`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`agent static verify: ${checks} checks passed`);
