import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AM_CONFIG_PATH,
  AM_RELOAD_TIMEOUT_MS,
  AM_RELOAD_URL,
  AMTOOL_PATH,
  EMAIL_CONFIG_KEYS,
  emailConfigStatus,
  renderAlertmanagerYml,
  startAmRenderer,
} from '../src/am-renderer';
import type { AmRendererFs, AmRendererLoop } from '../src/am-renderer';
import { NOTIFY_PULL_INTERVAL_MS } from '../src/notify-config';
import type { NotifyValues } from '../src/config';

/**
 * T13 单测（§5.1#11 逐字）：**am-renderer** —— yml golden 两形态逐字 + 引号/反斜杠/换行
 * 值安全用例 + 状态机（content-unchanged 不重载 / pull 失败不动文件 / reload 非 200 ⇒
 * 下轮重试且不重写 / amtool 失败不落盘 / 全新卷无 pull ⇒ 写 baseline）。
 *
 * - **golden 固化为静态 fixture**（评审 G8）：`fixtures/am-config-{baseline,full}.yml` 是从
 *   **现** entrypoint.sh / alertmanager.yml.tmpl 一次性生成的参照文本，**不得**让测试活依赖
 *   旧文件 —— T15 删 tmpl/重写 entrypoint 后本文件仍须可复跑。
 * - 状态机测试全部走注入（fake fs / amtool / reload / 脚本化 pull）——**不真连网络**；
 *   唯二走缺省文件面的是 `mkdtemp` 真实 fs 用例（本地磁盘，无出站）。
 * - fixture 内的 SMTP 五值 = 生成期固定值（与 FULL_VALUES 同源；见 emit 脚本口径注释）。
 */

const FIXTURE_DIR = join(__dirname, 'fixtures');
const BASELINE_YML = readFileSync(join(FIXTURE_DIR, 'am-config-baseline.yml'), 'utf8');
const FULL_YML = readFileSync(join(FIXTURE_DIR, 'am-config-full.yml'), 'utf8');

/** 生成 fixture 时的固定值（逐字同源——golden 比对的就是「这些输入 ⇒ 那份文本」）。 */
const FULL_VALUES: NotifyValues = {
  'notify.smtp.host': 'smtp.example.com',
  'notify.smtp.port': '465',
  'notify.smtp.user': 'alerts@example.com',
  'notify.smtp.pass': 'fixture-app-password',
  'notify.email.to': 'ops@example.com',
};

/** 文案逐字（§2.9；断言按整行相等 —— 不做 contains 弱匹配）。 */
const START_BASELINE = '[am-renderer] 启动；配置=baseline';
const START_EXISTING = '[am-renderer] 启动；配置=既有';
const UPDATED_INFO = '[am-renderer] 配置已更新并重载';
const PULL_FAIL_WARN = '通知配置拉取失败，本轮不更新';
const AMTOOL_FAIL = '渲染产物未通过 amtool 预检，不落盘';
const RELOAD_FAIL = '重载失败（AM 未就绪或拒绝），将在下轮重试';
const halfWarn = (n: number): string => `通知邮件配置不完整（已配 ${n}/5），邮件段已省略`;

// ─────────────────────────────────────────────────────────────────────────────
// 渲染面：golden 逐字 + JSON 标量安全
// ─────────────────────────────────────────────────────────────────────────────

describe('renderAlertmanagerYml：两形态 golden 逐字（fixture 固化；T15 删 tmpl/重写 entrypoint 后仍可复跑）', () => {
  it('baseline（空图 / 无邮件键）⇒ 与 am-config-baseline.yml 逐字一致（heartbeat 空接收器、无 email 接收器、无 global 段）', () => {
    expect(renderAlertmanagerYml({})).toBe(BASELINE_YML);

    // IM 组四键不参与邮件面（⚙️1：两消费面不相交）——照旧 baseline。
    const imOnly: NotifyValues = {
      'notify.webhook.feishuUrl': 'http://127.0.0.1:9/feishu?token=x',
      'notify.webhook.wecomUrl': 'http://127.0.0.1:9/wecom',
      'notify.webhook.dingtalkUrl': 'http://127.0.0.1:9/dingtalk',
      'notify.webhook.dingtalkSecret': 'sec',
    };
    expect(renderAlertmanagerYml(imOnly)).toBe(BASELINE_YML);
  });

  it('全量（邮件五键全在场）⇒ 与 am-config-full.yml 逐字一致（global 五行键序 + 四接收器，含未引用的 email）', () => {
    expect(renderAlertmanagerYml(FULL_VALUES)).toBe(FULL_YML);
    // 三处「容易少写」的逐字锚点（照旧全形态，评审 r2-🟡6 语义不变）：
    expect(FULL_YML).toContain('  - name: email\n    email_configs:\n      - to: "ops@example.com"\n');
    expect(FULL_YML).toContain('  smtp_smarthost: "smtp.example.com:465"\n');
    expect(FULL_YML).toContain('  smtp_require_tls: true\n');
  });

  it('半配（1–4 项在场）⇒ 仍与 baseline 逐字一致（邮件段整段省略）', () => {
    for (let n = 1; n <= 4; n += 1) {
      const partial: NotifyValues = {};
      for (const key of EMAIL_CONFIG_KEYS.slice(0, n)) partial[key] = FULL_VALUES[key];
      expect(renderAlertmanagerYml(partial)).toBe(BASELINE_YML);
    }
  });

  it('值含引号/反斜杠/换行 ⇒ JSON 双引号标量安全（行数不变、结构不注入、原文不外露）', () => {
    const hostilePass = 'pa\'ss\n新行"尾';
    const hostileUser = 'we"ird\\user';
    const hostile: NotifyValues = {
      ...FULL_VALUES,
      'notify.smtp.user': hostileUser,
      'notify.smtp.pass': hostilePass,
    };
    const out = renderAlertmanagerYml(hostile);

    // 结构不注入：值里的**真实换行**不得长出新行（与普通全量形态行数全等）。
    expect(out.split('\n')).toHaveLength(FULL_YML.split('\n').length);
    // 两条最危险的标量逐字（YAML 双引号风格与 JSON 标量同形 ⇒ 期望值 = JSON.stringify）。
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('  smtp_auth_password: '))).toEqual([
      `  smtp_auth_password: ${JSON.stringify(hostilePass)}`,
    ]);
    expect(lines.filter((l) => l.startsWith('  smtp_from: '))).toEqual([
      `  smtp_from: ${JSON.stringify(hostileUser)}`,
    ]);
    // 原文（真实换行/裸双引号形态）绝不外露——只有转义态允许出现。
    expect(out).not.toContain(hostilePass);
    expect(out).not.toContain(hostileUser);
  });

  it('emailConfigStatus：计数与三态（0=none、1–4=partial、5=full；空白 = 未设）', () => {
    expect(emailConfigStatus({})).toEqual({ count: 0, mode: 'none', full: null });
    expect(emailConfigStatus({ 'notify.smtp.host': '  ' })).toEqual({ count: 0, mode: 'none', full: null });
    expect(
      emailConfigStatus({ 'notify.smtp.host': 'h.example.com', 'notify.smtp.port': '465' }),
    ).toEqual({ count: 2, mode: 'partial', full: null });
    expect(emailConfigStatus(FULL_VALUES)).toEqual({
      count: 5,
      mode: 'full',
      full: {
        host: 'smtp.example.com',
        port: '465',
        user: 'alerts@example.com',
        pass: 'fixture-app-password',
        to: 'ops@example.com',
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 状态机（§3.4）：fake fs / amtool / reload 注入 —— 不真连网络
// ─────────────────────────────────────────────────────────────────────────────

/** 测试内的路径（fake fs 下任意值即可；amtool 断言用它钉「预检对象 = tmp」）。 */
const CONFIG = '/alertmanager-live/alertmanager.yml';
const TMP = `${CONFIG}.tmp`;

interface FakeFs extends AmRendererFs {
  files: Map<string, string>;
  /** 粗粒度事件名（exists/write/rename/remove）——与 pull/amtool/reload 共用一条时序。 */
  events: string[];
  writes: Array<{ path: string; content: string }>;
}

function fakeFs(initial: Record<string, string>, events: string[]): FakeFs {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: Array<{ path: string; content: string }> = [];
  return {
    files,
    events,
    writes,
    exists: async (path) => {
      events.push('exists');
      return files.has(path);
    },
    writeFile: async (path, content) => {
      events.push('write');
      writes.push({ path, content });
      files.set(path, content);
    },
    rename: async (from, to) => {
      events.push('rename');
      const content = files.get(from);
      if (content === undefined) throw new Error(`fake fs: ${from} 不存在`);
      files.delete(from);
      files.set(to, content);
    },
    remove: async (path) => {
      events.push('remove');
      files.delete(path);
    },
  };
}

const loops: AmRendererLoop[] = [];

afterEach(() => {
  for (const loop of loops.splice(0)) loop.stop();
  vi.restoreAllMocks();
});

interface Harness {
  fs: FakeFs;
  events: string[];
  warns: string[];
  errs: string[];
  amtoolChecks: string[];
  reloads: { count: number };
  loop: AmRendererLoop;
  setAmtool(ok: boolean): void;
  setReload(ok: boolean): void;
}

/** 状态机测试装置：脚本化拉取 + fake fs + amtool/reload 存根（手推 tick，不与定时器掺和）。 */
function startHarness(opts: {
  files?: Record<string, string>;
  pulls: Array<NotifyValues | Error>;
  amtoolOk?: boolean;
  reloadOk?: boolean;
}): Harness {
  const events: string[] = [];
  const fs = fakeFs(opts.files ?? {}, events);
  const warns: string[] = [];
  const errs: string[] = [];
  const amtoolChecks: string[] = [];
  const reloads = { count: 0 };
  let amtoolOk = opts.amtoolOk ?? true;
  let reloadOk = opts.reloadOk ?? true;

  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errs.push(args.map((a) => String(a)).join(' '));
  });

  const steps = [...opts.pulls];
  const loop = startAmRenderer({
    configPath: CONFIG,
    fs,
    intervalMs: 60_000, // 手推；不让定时器掺和本用例
    pull: async () => {
      events.push('pull');
      const step = steps.shift();
      if (step === undefined) throw new Error('脚本化拉取已耗尽');
      if (step instanceof Error) throw step;
      return step;
    },
    amtoolCheck: async (ymlPath) => {
      events.push('amtool');
      amtoolChecks.push(ymlPath);
      return amtoolOk;
    },
    reloadAm: async () => {
      events.push('reload');
      reloads.count += 1;
      return reloadOk;
    },
  });
  loops.push(loop);
  return {
    fs,
    events,
    warns,
    errs,
    amtoolChecks,
    reloads,
    loop,
    setAmtool: (ok) => {
      amtoolOk = ok;
    },
    setReload: (ok) => {
      reloadOk = ok;
    },
  };
}

describe('am-renderer 状态机（§3.4 逐字；B1 启动序）', () => {
  it('常量逐字：路径 / 重载 URL / 超时 / amtool / 轮询周期', () => {
    expect(AM_CONFIG_PATH).toBe('/alertmanager-live/alertmanager.yml');
    expect(AM_RELOAD_URL).toBe('http://alertmanager:9093/-/reload');
    expect(AM_RELOAD_TIMEOUT_MS).toBe(3000);
    expect(AMTOOL_PATH).toBe('/bin/amtool');
    expect(NOTIFY_PULL_INTERVAL_MS).toBe(30_000);
  });

  it('全新卷（无文件）⇒ 渲染 baseline 落盘 + 首次 reload；同轮 pull 失败 WARN、文件保持 baseline', async () => {
    const h = startHarness({ pulls: [new Error('config-service down')] });
    await h.loop.firstTick;

    expect(h.errs).toEqual([START_BASELINE, UPDATED_INFO]);
    expect(h.warns).toEqual([PULL_FAIL_WARN]);
    expect(h.fs.files.get(CONFIG)).toBe(BASELINE_YML);
    // 事件时序 = 步骤 4–6 的逐字序（write tmp → amtool 预检 → rename → reload），然后才拉取。
    expect(h.events).toEqual(['exists', 'write', 'amtool', 'rename', 'reload', 'pull']);
    expect(h.amtoolChecks).toEqual([TMP]); // 预检对象 = tmp（不是目标文件）
    expect(h.fs.writes).toEqual([{ path: TMP, content: BASELINE_YML }]);
    expect(h.fs.files.has(TMP)).toBe(false); // rename 后无残留
  });

  it('baseline 落盘后首轮拉到空图 ⇒ 同 hash 跳过（不重写不重载）', async () => {
    const h = startHarness({ pulls: [{}] });
    await h.loop.firstTick;

    expect(h.fs.writes).toHaveLength(1); // 只 baseline 那一次
    expect(h.reloads.count).toBe(1);
    expect(h.errs.filter((l) => l === UPDATED_INFO)).toHaveLength(1);
  });

  it('baseline 首次 reload 时 AM 未就绪（失败）⇒ 容忍；同轮重走 4–6 重试，就绪后双闸齐', async () => {
    const h = startHarness({ pulls: [{}, {}, {}], reloadOk: false });
    await h.loop.firstTick;

    // 启动段 baseline 落盘 + reload 失败；首轮拉取同 hash 但 !lastReloadOk ⇒ 立刻重走 4–6（= 「下轮」）。
    expect(h.errs).toEqual([START_BASELINE, RELOAD_FAIL, RELOAD_FAIL]);
    expect(h.fs.files.get(CONFIG)).toBe(BASELINE_YML);
    expect(h.reloads.count).toBe(2);
    expect(h.fs.writes.every((w) => w.content === BASELINE_YML)).toBe(true); // 同名内容幂等

    h.setReload(true);
    await h.loop.tick(); // AM 就绪 ⇒ 重载成功
    expect(h.reloads.count).toBe(3);
    expect(h.errs.filter((l) => l === UPDATED_INFO)).toHaveLength(1);

    await h.loop.tick(); // 双闸齐 ⇒ 恢复跳过
    expect(h.reloads.count).toBe(3);
  });

  it('文件在场 + pull 失败 ⇒ 不动文件（B1：重启/重建绝不降级卷上配置；WARN 状态变化一条）', async () => {
    const h = startHarness({ files: { [CONFIG]: 'OLD-CONTENT\n' }, pulls: [new Error('x'), new Error('y')] });
    await h.loop.firstTick;
    await h.loop.tick();

    expect(h.errs).toEqual([START_EXISTING]); // 无 baseline、无任何写/reload 日志
    expect(h.warns).toEqual([PULL_FAIL_WARN]); // 两轮都失败：不刷屏
    expect(h.fs.files.get(CONFIG)).toBe('OLD-CONTENT\n');
    expect(h.fs.writes).toHaveLength(0);
    expect(h.events).toEqual(['exists', 'pull', 'pull']);
    expect(h.reloads.count).toBe(0);
  });

  it('pull 失败 WARN 复位语义：失败 → 成功 → 再失败 ⇒ 恰好第二条', async () => {
    const h = startHarness({ files: { [CONFIG]: 'OLD\n' }, pulls: [new Error('x'), {}, new Error('y')] });
    await h.loop.firstTick; // 失败 ⇒ 第一条
    await h.loop.tick(); // 成功（空图 ⇒ 渲成 baseline 形态 ≠ OLD ⇒ 落盘；WARN 复位）
    await h.loop.tick(); // 再失败 ⇒ 第二条
    expect(h.warns).toEqual([PULL_FAIL_WARN, PULL_FAIL_WARN]);
    expect(h.fs.files.get(CONFIG)).toBe(BASELINE_YML);
  });

  it('内容不变 ⇒ 不重写不重载（同 hash 且上轮 reload 成功 ⇒ 步 3 跳过）', async () => {
    const h = startHarness({ files: { [CONFIG]: 'OLD\n' }, pulls: [FULL_VALUES, FULL_VALUES] });
    await h.loop.firstTick; // OLD → 全量：写 + reload
    expect(h.fs.files.get(CONFIG)).toBe(FULL_YML);
    expect(h.reloads.count).toBe(1);

    await h.loop.tick(); // 同值 ⇒ 跳过（无 write/amtool/rename/reload 事件）
    expect(h.fs.writes).toHaveLength(1);
    expect(h.reloads.count).toBe(1);
    expect(h.errs.filter((l) => l === UPDATED_INFO)).toHaveLength(1);
  });

  it('reload 非 200 ⇒ ERROR + 下轮重走 4–6 重试（写同名内容幂等；文件保持新内容）', async () => {
    const h = startHarness({ files: { [CONFIG]: 'OLD\n' }, pulls: [FULL_VALUES, FULL_VALUES], reloadOk: false });
    await h.loop.firstTick;
    expect(h.errs).toEqual([START_EXISTING, RELOAD_FAIL]);
    expect(h.fs.files.get(CONFIG)).toBe(FULL_YML); // 文件已新（不因 reload 失败回退）
    expect(h.reloads.count).toBe(1);

    h.setReload(true);
    await h.loop.tick(); // h===lastWrittenHash 但 lastReloadOk=false ⇒ §3.4：重走 4–6
    expect(h.reloads.count).toBe(2);
    expect(h.errs).toContain(UPDATED_INFO);
    expect(h.fs.files.get(CONFIG)).toBe(FULL_YML);
    // 幂等性：每次写入都是**同一份内容**（重试从未改写目标内容）。
    expect(h.fs.writes).toHaveLength(2);
    expect(h.fs.writes.every((w) => w.content === FULL_YML)).toBe(true);

    await h.loop.tick(); // 已重载成功 ⇒ 恢复跳过
    expect(h.reloads.count).toBe(2);
    expect(h.fs.writes).toHaveLength(2);
  });

  it('amtool 预检失败 ⇒ ERROR + 删 tmp + 不落盘（旧文件保持；修好后下轮照常落盘）', async () => {
    const h = startHarness({ files: { [CONFIG]: 'OLD\n' }, pulls: [FULL_VALUES, FULL_VALUES], amtoolOk: false });
    await h.loop.firstTick;

    expect(h.errs).toEqual([START_EXISTING, AMTOOL_FAIL]);
    expect(h.fs.files.get(CONFIG)).toBe('OLD\n'); // 不落盘
    expect(h.fs.files.has(TMP)).toBe(false); // 删 tmp
    expect(h.fs.writes).toHaveLength(1); // 只写过 tmp
    expect(h.events).toEqual(['exists', 'pull', 'write', 'amtool', 'remove']);
    expect(h.amtoolChecks).toEqual([TMP]);

    h.setAmtool(true);
    await h.loop.tick();
    expect(h.fs.files.get(CONFIG)).toBe(FULL_YML);
    expect(h.reloads.count).toBe(1);
  });

  it('半配 WARN 逐字 + 状态变化时一条（3→4 键变化也重报；渲染产物不变 ⇒ 只出 WARN、不重写）', async () => {
    const partial3: NotifyValues = {
      'notify.smtp.host': 'smtp.example.com',
      'notify.smtp.port': '465',
      'notify.smtp.user': 'alerts@example.com',
    };
    const partial4: NotifyValues = { ...partial3, 'notify.smtp.pass': 'p' };
    const partial2: NotifyValues = { 'notify.smtp.host': 'smtp.example.com', 'notify.smtp.port': '465' };

    const h = startHarness({
      files: { [CONFIG]: 'OLD\n' },
      pulls: [partial3, partial3, partial4, FULL_VALUES, partial2],
    });

    await h.loop.firstTick; // partial(3)：WARN + 邮件段省略（渲成 baseline 形态 ≠ OLD ⇒ 落盘）
    expect(h.warns).toEqual([halfWarn(3)]);
    expect(h.fs.files.get(CONFIG)).toBe(BASELINE_YML);
    expect(h.reloads.count).toBe(1);

    await h.loop.tick(); // 持续半配 ⇒ 不重报、不重写
    expect(h.warns).toHaveLength(1);
    expect(h.fs.writes).toHaveLength(1);

    await h.loop.tick(); // 3→4：输入态变化 ⇒ 第二条 WARN；渲染产物不变 ⇒ 步 3 跳过
    expect(h.warns).toEqual([halfWarn(3), halfWarn(4)]);
    expect(h.fs.writes).toHaveLength(1);
    expect(h.reloads.count).toBe(1);

    await h.loop.tick(); // 全量 ⇒ 无半配 WARN；global + email 成员落盘
    expect(h.warns).toHaveLength(2);
    expect(h.fs.files.get(CONFIG)).toBe(FULL_YML);
    expect(h.reloads.count).toBe(2);

    await h.loop.tick(); // 全量 → partial(2)：WARN；邮件段回省 ⇒ 重写为 baseline 形态
    expect(h.warns).toEqual([halfWarn(3), halfWarn(4), halfWarn(2)]);
    expect(h.fs.files.get(CONFIG)).toBe(BASELINE_YML);
    expect(h.reloads.count).toBe(3);
  });

  it('日志纪律：一切 console 输出不含任何值（哨兵；成功落盘 + reload 失败两侧覆盖）', async () => {
    const SENTINEL = 'SENTINEL-SECRET-77';
    const values: NotifyValues = {
      ...FULL_VALUES,
      'notify.smtp.pass': SENTINEL,
      'notify.email.to': 'sentinel-to@example.com',
    };
    const h = startHarness({ files: { [CONFIG]: 'OLD\n' }, pulls: [values, values], reloadOk: false });
    await h.loop.firstTick; // 成功落盘（含哨兵）+ reload 失败 ERROR
    await h.loop.tick(); // 重试轮

    const all = [...h.warns, ...h.errs].join('\n');
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('sentinel-to@example.com');
    expect(all).not.toContain('smtp.example.com'); // 非密值同样不出日志（只许键名/状态/错误类别）
    // 自证（否则本用例可能空跑）：确实写了含哨兵的文件、也确实走到了 reload 失败 ERROR。
    expect(h.fs.files.get(CONFIG)).toContain(SENTINEL);
    expect(h.errs).toContain(RELOAD_FAIL);
  });

  it('兜底：启动段 fs 异常不外抛（内部错误 ERROR 状态变化一条；下轮重试启动）', async () => {
    const events: string[] = [];
    const fs = fakeFs({}, events);
    const realExists = fs.exists;
    let failNext = true;
    fs.exists = async (path) => {
      if (failNext) {
        failNext = false;
        throw new Error('EACCES');
      }
      return realExists(path);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* 消音 */
    });
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errs.push(args.map((a) => String(a)).join(' '));
    });

    const loop = startAmRenderer({
      configPath: CONFIG,
      fs,
      pull: async () => ({}),
      amtoolCheck: async () => true,
      reloadAm: async () => true,
      intervalMs: 60_000,
    });
    loops.push(loop);

    await loop.firstTick; // 必须 resolve（不外抛）；启动未完成、未写
    expect(fs.files.has(CONFIG)).toBe(false);
    expect(errs.filter((l) => l.includes('内部错误'))).toHaveLength(1);

    await loop.tick(); // 重试启动 ⇒ baseline 照常落盘
    expect(fs.files.get(CONFIG)).toBe(BASELINE_YML);
    expect(errs.filter((l) => l.includes('内部错误'))).toHaveLength(1);
  });

  it('定时器周期推进（intervalMs 短值）：firstTick 立即拉一次、随后按周期再拉', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const loop = startAmRenderer({
      configPath: CONFIG,
      fs: fakeFs({ [CONFIG]: 'OLD\n' }, []),
      pull: async () => {
        calls += 1;
        return {};
      },
      amtoolCheck: async () => true,
      reloadAm: async () => true,
      intervalMs: 25,
    });
    loops.push(loop);

    await loop.firstTick;
    expect(calls).toBe(1); // 启动立即先拉一次（⚙️8）
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 10 });
  });
});

describe('am-renderer 缺省文件面（真实 fs；mkdtemp——无出站）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'am-renderer-test-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('全新「卷」⇒ tmp(600) 写 + rename 原子换入；产物 = baseline fixture、无 tmp 残留', async () => {
    const configPath = join(dir, 'alertmanager.yml');
    const loop = startAmRenderer({
      configPath,
      pull: async () => ({}),
      amtoolCheck: async () => true,
      reloadAm: async () => true,
      intervalMs: 60_000,
    });
    loops.push(loop);

    await loop.firstTick;
    expect(await readFile(configPath, 'utf8')).toBe(BASELINE_YML);
    await expect(readFile(`${configPath}.tmp`, 'utf8')).rejects.toThrow(); // rename 后无残留
  });
});
