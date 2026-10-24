/**
 * am-renderer —— 通知图 ⇒ 完整 `alertmanager.yml` 渲染 + 原子落盘 + 原地重载
 * （T13；规格 §3.4「状态机 + 渲染规则」逐字、设计 D4′）。
 *
 * ## 角色与形态
 *
 *  与 alert-relay 同包的第二入口（同一镜像；T15 的 compose 以 `command: node
 *  packages/alert-relay/dist/am-renderer.js` 起独立服务，无 HTTP 面/无 healthcheck）。
 *  它是**唯一**接触含口令完整 yml 的组件 —— 日志纪律因此最严（§2.9）：只允许键名/状态/
 *  错误类别，**不得**打印渲染产物、拉取响应或任何值。
 *
 * ## 渲染规则（§3.4 逐字；= 旧 entrypoint.sh 两态分支的 TS 化）
 *
 *  - 静态段（route + inhibit_rules）唯一真源 = 本文件 `STATIC_SEGMENT`
 *    （逐字 = 原 `deploy/monitoring/alertmanager/alertmanager.yml.tmpl:14-29`；T15 删 tmpl）；
 *  - webhook 接收器段恒在（url + `http_config.authorization` Bearer —— O2：`authorization`
 *    嵌在 `http_config` 之下，平铺是未知字段、AM 载入报错）；
 *  - 邮件五键**全在场** ⇒ `global:` 五行（键序照旧 entrypoint）+ `all`/`heartbeat` 附
 *    `email_configs` + 加 `email` 接收器（**照旧全形态逐字，含未引用的 `email`**）；
 *    否则（全空**含半配**）⇒ 邮件段整段省略、`heartbeat` = 已定义空接收器（路由照旧引用它
 *    —— AM 对「路由引用未定义 receiver」是载入失败，r2-🟡6；半配另有 WARN，见 §2.9）；
 *  - **值一律 JSON 双引号标量**（`JSON.stringify`；JSON 是 YAML 子集 ⇒ 引号/反斜杠/换行全量
 *    安全）—— 旧 entrypoint「拒含引号值」fail-closed 纪律的**上位替代**：fail-closed 从
 *    「拒绝」升级为「不可能生成坏 YAML」；
 *  - 两条 yml 形态的逐字对照 = `test/fixtures/am-config-{baseline,full}.yml`（从旧
 *    entrypoint/tmpl **一次性生成、静态固化** —— 评审 G8：不得活依赖旧文件；T15 删 tmpl/
 *    重写 entrypoint 后本测试仍须可复跑）。
 *
 * ## B1 启动序（评审 B1）：重启/重建**绝不降级**卷上配置
 *
 *  `AM_CONFIG_PATH` 不在场（全新卷）⇒ 渲染 baseline（**无值依赖**）⇒ 走 4–6 步（含首次
 *  reload；AM 未就绪 ⇒ 容忍失败、下轮重试）。**在场 ⇒ 直接进入拉取循环**；拉取失败一律
 *  **不动文件**（共享卷上的 yml 本身就是 renderer 的 last-good）。
 *
 * ## 状态机（§3.4 逐字）
 *
 *  `lastWrittenHash` / `lastReloadOk`：仅「同 hash **且**上轮 reload 成功」才跳过；
 *  reload 非 200/异常 ⇒ 文件已新、AM 内存旧 ⇒ 下轮以 `h===lastWrittenHash && !lastReloadOk`
 *  重走 4–6（**写同名内容幂等**）。amtool 预检（`/bin/amtool`，镜像多阶段 COPY）失败 ⇒
 *  ERROR + 删 tmp + **不落盘**。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { NotifyChannelKey } from '@fight-the-landlord/protocol';
import { NOTIFY_PULL_INTERVAL_MS, pullNotifyConfig } from './notify-config';
import type { NotifyValues } from './config';

/** 共享卷上的目标配置（AM 只读挂载同一卷；production compose 两服务共挂 `alertmanager-live`）。 */
export const AM_CONFIG_PATH = '/alertmanager-live/alertmanager.yml';
/** AM 原地重载端点（探针实测默认可用、200）。 */
export const AM_RELOAD_URL = 'http://alertmanager:9093/-/reload';
/** 单次 reload 超时（§3.4 钉死 3000ms）。 */
export const AM_RELOAD_TIMEOUT_MS = 3000;
/** amtool 路径（T15 的 Dockerfile.alert-relay 多阶段 COPY 进镜像；评审 S-Y3）。 */
export const AMTOOL_PATH = '/bin/amtool';

/**
 * 「邮件组」五键（⚙️1 分组；顺序照 ⚙️1）。relay 侧消费面（IM 四键）与本面**不相交**。
 */
export const EMAIL_CONFIG_KEYS = [
  'notify.smtp.host',
  'notify.smtp.port',
  'notify.smtp.user',
  'notify.smtp.pass',
  'notify.email.to',
] as const satisfies readonly NotifyChannelKey[];

/**
 * 静态段（route + inhibit_rules）——**唯一真源**（T15 删 `alertmanager.yml.tmpl` 后它就是
 * 全部；逐字 = 原 tmpl:14-29，含 Watchdog 子路由 24h 与 group_wait 30s/interval 5m/repeat 4h）。
 */
const STATIC_SEGMENT = `route:
  receiver: all
  group_by: [alertname, job]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [alertname="Watchdog"]
      receiver: heartbeat
      repeat_interval: 24h

# critical 抑制同 alertname/job 的 warning（规格 §2.5 钉死）
inhibit_rules:
  - source_matchers: [severity="critical"]
    target_matchers: [severity="warning"]
    equal: [alertname, job]
`;

/** webhook 接收器成员（逐字 = 旧 entrypoint 的 heredoc；`all`/`webhook` 两处共用）。 */
const WEBHOOK_CONFIGS_SEGMENT = `    webhook_configs:
      - url: http://alert-relay:8090/webhook
        http_config:
          authorization:
            type: Bearer
            credentials_file: /alertmanager/secret/internal_token
`;

/** 邮件组成员（值 = JSON 标量；旧 entrypoint 的 `- to: "$ALERT_EMAIL_TO"` 同形）。 */
function emailConfigsSegment(to: string): string {
  return `    email_configs:
      - to: ${JSON.stringify(to)}
`;
}

/** 读一个「空串 = 未设」的拉取值（与 relay `config.ts` 的 `present` 同口径：空白 = 未设；值**逐字**）。 */
function present(values: NotifyValues, key: NotifyChannelKey): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export interface EmailConfigStatus {
  /** 在场计数（0–5）。 */
  count: number;
  /** 0 ⇒ `none`；1–4 ⇒ `partial`（**半配**：邮件段省略 + WARN）；5 ⇒ `full`。 */
  mode: 'none' | 'partial' | 'full';
  /** 五键皆在场时的逐字值（仅 `mode==='full'`；否则 `null`）。 */
  full: { host: string; port: string; user: string; pass: string; to: string } | null;
}

/** 邮件组在场状态（纯函数；渲染与半配 WARN 共用同一口径）。 */
export function emailConfigStatus(values: NotifyValues): EmailConfigStatus {
  const host = present(values, EMAIL_CONFIG_KEYS[0]);
  const port = present(values, EMAIL_CONFIG_KEYS[1]);
  const user = present(values, EMAIL_CONFIG_KEYS[2]);
  const pass = present(values, EMAIL_CONFIG_KEYS[3]);
  const to = present(values, EMAIL_CONFIG_KEYS[4]);
  if (host !== undefined && port !== undefined && user !== undefined && pass !== undefined && to !== undefined) {
    return { count: 5, mode: 'full', full: { host, port, user, pass, to } };
  }
  const count = [host, port, user, pass, to].filter((v) => v !== undefined).length;
  return { count, mode: count === 0 ? 'none' : 'partial', full: null };
}

/**
 * 渲染完整 `alertmanager.yml`（纯函数，§3.4 渲染规则逐字；两形态 = 旧 entrypoint 的条件拼装）。
 * 邮件五键全在场 ⇒ 全量形态（global 五行 + 四接收器）；否则 baseline 形态（含半配——邮件段省略）。
 */
export function renderAlertmanagerYml(values: NotifyValues): string {
  const { full } = emailConfigStatus(values);

  let out = '';
  if (full) {
    // global 五行（键序照旧 entrypoint 逐字；值 = JSON 标量）。
    out += 'global:\n';
    out += `  smtp_smarthost: ${JSON.stringify(`${full.host}:${full.port}`)}\n`;
    out += `  smtp_from: ${JSON.stringify(full.user)}\n`;
    out += `  smtp_auth_username: ${JSON.stringify(full.user)}\n`;
    out += `  smtp_auth_password: ${JSON.stringify(full.pass)}\n`;
    out += '  smtp_require_tls: true\n';
  }
  out += STATIC_SEGMENT;
  // receivers：all/webhook 恒在；email 接收器（未引用，逐字保留）与 email 成员仅在 SMTP 全量时出现。
  out += 'receivers:\n';
  out += '  - name: all\n';
  out += WEBHOOK_CONFIGS_SEGMENT;
  if (full) out += emailConfigsSegment(full.to);
  out += '  - name: webhook\n';
  out += WEBHOOK_CONFIGS_SEGMENT;
  if (full) {
    out += '  - name: email\n';
    out += emailConfigsSegment(full.to);
    out += '  - name: heartbeat\n';
    out += emailConfigsSegment(full.to);
  } else {
    out += '  - name: heartbeat\n';
  }
  return out;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 文件面（最小投影；测试注入 fake fs）。方法名与 `node:fs/promises` 同形——
 * 缺省实现的**方法体**里引用的是模块导入（对象属性名不是作用域绑定，不遮蔽），见下。
 */
export interface AmRendererFs {
  /** 目标配置文件是否在场（启动序分支依据）。仅 ENOENT 判 false；其它错误照抛 —— 不把「读不了」误判成「没有」而 baseline 降级。 */
  exists(path: string): Promise<boolean>;
  /** 写文件（600；对上次崩溃残留的同名 tmp 重新应用权限）。 */
  writeFile(path: string, content: string): Promise<void>;
  /** 原子替换（同目录 rename 语义）。 */
  rename(from: string, to: string): Promise<void>;
  /** 删除（ok-if-missing）。 */
  remove(path: string): Promise<void>;
}

/** 缺省文件面（node:fs/promises 投影）。 */
const defaultFs: AmRendererFs = {
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
  async writeFile(path, content) {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600); // 残留 tmp：writeFile 的 mode 不会对已存在文件重新应用
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

/**
 * amtool 预检缺省实现（宿主 = 镜像内 `/bin/amtool check-config <tmp>`）。
 * stdout/stderr **全丢弃**（`stdio: 'ignore'`）：amtool 的报错可能引用配置行（含口令）——
 * 本组件只保留退出码这一个比特（日志纪律 §2.9）。
 */
function defaultAmtoolCheck(ymlPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(AMTOOL_PATH, ['check-config', ymlPath], { stdio: 'ignore' });
    child.on('error', () => resolve(false)); // ENOENT 等（Linux 上不该发生——COPY 在镜像里）
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * reload 缺省实现：`POST AM_RELOAD_URL`（3000ms 超时）。仅 200 算成功；非 200/异常一律 false
 * （错误对象不回显——URL 类错误可能夹带内容）。
 */
async function defaultReloadAm(): Promise<boolean> {
  try {
    const res = await fetch(AM_RELOAD_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(AM_RELOAD_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 注入面（测试全走这里——fake fs/amtool spawn/reload fetch/脚本化 pull；不真连网络）。 */
export interface AmRendererOptions {
  /** **拉取**（缺省 = T12 `pullNotifyConfig()`：3000ms/不重试/throw）。 */
  pull?: () => Promise<NotifyValues>;
  /** amtool 预检（缺省 = spawn `/bin/amtool check-config <tmp>`；true = 通过）。 */
  amtoolCheck?: (ymlPath: string) => Promise<boolean>;
  /** 触发 AM 重载（缺省 = POST `AM_RELOAD_URL`，3000ms 超时；true = 200）。 */
  reloadAm?: () => Promise<boolean>;
  /** 文件面（缺省 = node:fs/promises 投影）。 */
  fs?: AmRendererFs;
  /** 目标配置路径（缺省 = `AM_CONFIG_PATH`；测试注入 fake/临时路径）。 */
  configPath?: string;
  /** 轮询周期覆盖（测试用；生产缺省 = `NOTIFY_PULL_INTERVAL_MS` = 30_000）。 */
  intervalMs?: number;
}

export interface AmRendererLoop {
  /** 停掉定时器（测试清理用；常驻进程无需）。 */
  stop(): void;
  /** 启动段（存在性检查 + 可能的 baseline 落盘/重载）+ 首次拉取 —— 测试的确定性等待点。 */
  firstTick: Promise<void>;
  /** 手动推进一轮（与定时器共享防重入闸）；测试的确定性推进点。 */
  tick(): Promise<void>;
}

/**
 * 起 renderer（返回句柄，进程生命周期由调用方持有；`main()` 即缺省形态）。
 * 状态机逐字 = §3.4：启动序（B1）+ 循环（步 1–6，tick 0 立即、之后 `intervalMs`）。
 */
export function startAmRenderer(opts: AmRendererOptions = {}): AmRendererLoop {
  const configPath = opts.configPath ?? AM_CONFIG_PATH;
  const pull = opts.pull ?? ((): Promise<NotifyValues> => pullNotifyConfig());
  const amtoolCheck = opts.amtoolCheck ?? defaultAmtoolCheck;
  const reloadAm = opts.reloadAm ?? defaultReloadAm;
  const fs = opts.fs ?? defaultFs;
  const intervalMs = opts.intervalMs ?? NOTIFY_PULL_INTERVAL_MS;
  const tmpPath = `${configPath}.tmp`;

  // ── 状态（§3.4；初值 null/false —— 启动时不读现文件，首轮成功即自愈对齐）──
  let lastWrittenHash: string | null = null;
  let lastReloadOk = false;
  let pullFailLogged = false;
  // 邮件组状态签名（`mode:count`）——半配 WARN「状态变化时一条」（§2.9）。
  let lastEmailSignature: string | null = null;
  // 防重入 + 兜底（D4 精神：任何异常不得打穿常驻进程）。
  let inFlight: Promise<void> | null = null;
  let startupDone = false;
  let loopFailLogged = false;

  /**
   * 步 2–6：渲染产物的 hash 比对 ⇒（需要时）amtool 预检 ⇒ 原子换入 ⇒ reload。
   * baseline 启动路径也走这里（`lastWrittenHash=null` ⇒ 步 3 恒不跳过）。
   */
  const applyRendered = async (desired: string): Promise<void> => {
    const h = sha256(desired);
    // 步 3：同一份内容且上轮 reload 成功 ⇒ 无事可做（reload 失败时文件已新、AM 内存旧 ⇒ 必须重走）。
    if (h === lastWrittenHash && lastReloadOk) return;

    // 步 4：写 tmp（600）→ amtool 预检；失败 ⇒ ERROR + 删 tmp + **不落盘**（return）。
    await fs.writeFile(tmpPath, desired);
    if (!(await amtoolCheck(tmpPath))) {
      console.error('渲染产物未通过 amtool 预检，不落盘');
      try {
        await fs.remove(tmpPath);
      } catch {
        /* tmp 残留无害（下轮覆盖写）；删失败不再刷屏 */
      }
      return;
    }

    // 步 5：原子换入（同目录 rename）。
    await fs.rename(tmpPath, configPath);
    lastWrittenHash = h; // 文件已新（reload 成败都以此为准——失败时下轮据此重走 4–6）

    // 步 6：reload（3000ms）。200 ⇒ 双闸齐；否则 ERROR（含重试语义）+ lastReloadOk=false。
    if (await reloadAm()) {
      lastReloadOk = true;
      console.error('[am-renderer] 配置已更新并重载');
    } else {
      lastReloadOk = false;
      console.error('重载失败（AM 未就绪或拒绝），将在下轮重试');
    }
  };

  /** 启动段（B1）：**仅当**卷上无文件才落 baseline —— 重启/重建绝不降级卷上配置。 */
  const startup = async (): Promise<void> => {
    if (await fs.exists(configPath)) {
      console.error('[am-renderer] 启动；配置=既有');
      return;
    }
    console.error('[am-renderer] 启动；配置=baseline');
    await applyRendered(renderAlertmanagerYml({})); // 无值依赖；含首次 reload（AM 未就绪 ⇒ 容忍失败）
  };

  /** 循环体（步 1–6；失败语义见各步注释）。 */
  const applyOnce = async (): Promise<void> => {
    let values: NotifyValues;
    try {
      values = await pull();
    } catch {
      // 步 1：失败 ⇒ 首次/状态变化 WARN（逐字，不含任何值）；**return（文件不动）**。
      if (!pullFailLogged) {
        console.warn('通知配置拉取失败，本轮不更新');
        pullFailLogged = true;
      }
      return;
    }
    pullFailLogged = false; // 成功 ⇒ 复位（恢复后再坏会再报）

    // 半配 WARN（§2.9 逐字；「状态变化时一条」）。⚠️ 基于**输入**状态计算（3→4 键也会重报）：
    // 半配各形态渲染产物相同（邮件段都省略）⇒ 该步只可能出 WARN、不触发落盘，语义自洽。
    const status = emailConfigStatus(values);
    const signature = `${status.mode}:${status.count}`;
    if (signature !== lastEmailSignature) {
      if (status.mode === 'partial') {
        console.warn(`通知邮件配置不完整（已配 ${status.count}/5），邮件段已省略`);
      }
      lastEmailSignature = signature;
    }

    // 步 2：渲染 + 步 3–6（在 applyRendered 内）。
    await applyRendered(renderAlertmanagerYml(values));
  };

  const tick = (): Promise<void> => {
    if (inFlight !== null) return inFlight; // 防重入（定时器与手动推进共用此闸）
    inFlight = (async () => {
      try {
        if (!startupDone) {
          await startup();
          startupDone = true; // ⚠️ 失败时不置位 ⇒ 下轮整体重试启动（启动日志可能重复一次，可接受）
        }
        await applyOnce();
        loopFailLogged = false;
      } catch {
        // 兜底（未分类异常，如 fs 故障）：不外抛、不刷屏；状态不推进，下轮重试。
        if (!loopFailLogged) {
          console.error('[am-renderer] 内部错误（本轮保持现状）');
          loopFailLogged = true;
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // ⚠️ **不 unref**：renderer 无 HTTP 面，这个定时器是进程的唯一 event-loop 持有者
  //    （unref 会让进程在启动后静默退出）。测试以 stop() 收尾。
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return { stop: () => clearInterval(timer), firstTick: tick(), tick };
}

/** 进程入口：起 renderer（缺省注入面；常驻由定时器持有 event loop）。 */
export async function main(): Promise<void> {
  startAmRenderer();
}

/**
 * 「直接运行才自启」的守卫（照 `server.ts` 末段同款：按 argv 判入口 —— 不用
 * `require.main`（vitest ESM 变换下不存在）也不 `import.meta`（NodeNext/CJS 产物语法错）。
 * `node dist/am-renderer.js`（T15 的 compose command）天然命中。
 */
const entry = process.argv[1] ?? '';
if (/[\\/]am-renderer\.(js|ts)$/.test(entry)) void main();
