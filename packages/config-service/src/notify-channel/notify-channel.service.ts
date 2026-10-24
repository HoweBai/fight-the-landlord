import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  NOTIFY_CHANNEL_KEYS,
  NOTIFY_CHANNEL_SECRET_KEYS,
  type NotifyChannelKey,
} from '@fight-the-landlord/protocol';
// ⚠️ **值导入** `DataSource`（DI token；DI 陷阱纪律：类型导入会被擦除 ⇒ 容器启动即崩）。
// 本服务走裸 SQL（锁定读/ODKU/审计三句都要能被单测钉全文）⇒ 注入 DataSource 而非 Repository，
// 同 `PayChannelService` 形态。
import { DataSource } from 'typeorm';
import { toEpochMs } from '../admin/admin-accounts.service';
import { CONFIG_CHANGES_INSERT_SQL } from '../admin/admin-changes.service';
import { decrypt, encrypt, fingerprintOf, parseMasterKey } from './notify-channel.crypto';
import { refreshNotifyGauges } from './notify-channel.metrics';
import { urlHint, validateAndNormalize } from './notify-channel.validators';

/**
 * 通知通道凭据第三键空间的服务层（规格 §3.1 写路径 / §3.2 读路径 / §2.2 SQL 逐字；T5）。
 * 消费方：T6 管理三端点（`status`/`set`/`clear`）· T7 RPC 接收侧（`pull`）。
 *
 * ─── 四条对外方法 ────────────────────────────────────────────────────────────
 *  - `status()`：LIST → **逐行解密** → 按 ⚙️1 固定序组装九项（缺行 = `configured:false`）。
 *    非密键给 `value` 明文；**五密键 `value` 恒 `null`**（只给指纹——掩码写，设计 D5/§2.4）；
 *    三 URL 键（同为密键）**现算 `hint`**（由解密值经 `urlHint`，§2.4 规则；其余六键 hint 恒 null）；
 *    `updatedAt` 一律 epoch ms（⚙️1 仓例 `toEpochMs`）。所有已配置行都解密（坏行 ⇒ 503 响亮，
 *    而非「configured 却静默藏坏」——URL 键的 hint 也以内层明文为准）。
 *  - `set()`：`validateAndNormalize`（失败 ⇒ `NotifyChannelValidationError`，**先于一切库操作**）
 *    → 主钥缺 ⇒ `NotifyChannelStorageDisabledError`（先于事务；§3.1 序：400 先于 503）→
 *    `encrypt` → 事务〔①锁定读 ⇒ ②覆盖写 ⇒ ③审计留痕**同事务**〕→ **事务成功后**
 *    `refreshNotifyGauges()`（⚙️17；内部自吞，不可能影响本响应）→ 返回 `{fingerprint, updatedAt}`。
 *  - `clear()`：主钥检查 → 锁定读（**同事务**——`FOR UPDATE` 在事务外无锁语义）→ 无行 ⇒
 *    `{existed:false}`（**不落审计**，幂等）→ 有行 ⇒ DELETE + 审计（old/new 照 §3.1，new = JSON
 *    字符串 `'null'`）→ 事务成功后同样刷新 gauges → `{existed:true}`。
 *  - `pull()`：LIST → 逐行解密 → `Partial<Record<NotifyChannelKey, string>>`（**缺键不补**；
 *    值 = 存储 canonical——URL 逐字保真，§2.5）。**仅已配置键**。
 *
 * ─── 纪律（Global Constraints）───────────────────────────────────────────────
 *  - **不 publish**：通知凭据不进任何广播（§2.1：九键不入 49 键面——`config.snapshot` 不得出现
 *    `notify.` 子串；本服务连 redis 都不注入）；
 *  - **不复用** `PlatformConfigService.set()`（设计 D1 实现纪律：不同表、不同审计值形状、不同键空间）；
 *  - **失败不静默**：解密任何失败 ⇒ `NotifyChannelStorageDisabledError`（管理 503 / RPC
 *    `{ok:false,10007}`，§2.3/§2.5②）；校验失败 ⇒ `NotifyChannelValidationError`（reason
 *    **不含输入值**，§2.9——400 message 会回显到管理页/日志）。
 *  - **主钥缺失 fail-closed（设计 D2；照支付片 §3.5 精神）**：四方法入口统一 `assertMasterKey()`——「存储不可用」
 *    在三端点（含**空库 GET**）与拉取通道上一致可观测。
 *
 * ─── 1213 死锁有界重试（§3.1；同支付片 T-2/U-2 逐字同构，仅表名/键空间替换）────────────
 *  LOCK + ODKU 形态在两并发下**可达 1213 死锁**（支付片真库实证）⇒ 写事务（`set`/`clear`）
 *  捕获 1213 ⇒ **重试 ≤2 次**（20ms 基准 + 0–20ms 随机抖动；共 ≤3 次尝试）；仍失败 ⇒ 抛出
 *  （T6 转 500，响亮）。**捕获边界（U-2）**：try/catch 包住**整个 `dataSource.transaction()`
 *  调用（含提交）**——保守边界 = 仅整事务重试（回滚 ⇒ 零副作用），**不得**把 catch 放进
 *  事务回调内部（那会把「提交阶段失败」漏在重试面之外）。
 *  审计语义：重试成功后恰一「old=前值」行；首写并发下先胜者 old=SQL NULL、后胜者 old=先胜者值
 *  （重试路径**重读**锁定行）；「两行同 NULL」不可达。
 */

/**
 * 锁定读（§2.2 逐字；`key` 为 MySQL **保留字** ⇒ 反引号）。锁住该键行直到事务结束：
 * 并发同键写被串行化。无行 ⇒ 空集 ⇒ `old = SQL NULL`。**全文被单测钉**。
 */
export const NOTIFY_CHANNEL_LOCK_SQL =
  'SELECT value_enc, fingerprint FROM notify_channel_config WHERE `key`=? FOR UPDATE';

/**
 * 覆盖写（§2.2 逐字）：INSERT … ODKU。无行 ⇒ 插入；有行 ⇒ 覆盖 value_enc/fingerprint/
 * updated_by/updated_at（`updated_at=NOW(3)` 在两侧都写）。`key` 列名同为保留字 ⇒ 反引号。
 */
export const NOTIFY_CHANNEL_UPSERT_SQL =
  'INSERT INTO notify_channel_config (`key`, value_enc, fingerprint, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), fingerprint=VALUES(fingerprint), updated_by=VALUES(updated_by), updated_at=NOW(3)';

/** 全量读（§2.2 逐字；`status`/`pull` 共用）。 */
export const NOTIFY_CHANNEL_LIST_SQL =
  'SELECT `key`, value_enc, fingerprint, updated_at, updated_by FROM notify_channel_config';

/** 删除（§2.2 逐字；`clear` 用）。 */
export const NOTIFY_CHANNEL_DELETE_SQL =
  'DELETE FROM notify_channel_config WHERE `key`=?';

/** §2.9 文案：主钥缺 = **确实是故障态**（存储不可用），503 语义正确（RPC 侧文案另组，T7）。 */
const MASTER_KEY_MISSING_MESSAGE = '通知通道密钥存储未启用（缺主钥）';

/** 1213 重试上限（次）。总尝试 = 1 + 2 = 3（§3.1「重试 ≤2 次」）。 */
const DEADLOCK_RETRY_LIMIT = 2;
/** 重试退避基准（§3.1「20ms 抖动」）：每次延迟 ∈ [20, 40) ms（基准 + 0–20ms 随机）。 */
const DEADLOCK_RETRY_BASE_MS = 20;

/**
 * 校验不过（含运行时未知键——`validateAndNormalize` 的 default 分支）。**T6 转 400**，
 * `reason` 原样作 message（理由文本为常量、**不含输入值**，§2.9）。**类名被 T6 依赖，勿改**。
 */
export class NotifyChannelValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'NotifyChannelValidationError';
  }
}

/**
 * 存储不可用：主钥缺 / 解密失败。**T6 转 503**、**T7 转 `{ok:false, code:10007}`**（§2.5②）。
 * `message` 缺省 = §2.9 逐字文案；包裹解密失败时透传底层原因（crypto 侧文案同样不含任何值）。
 * **类名被 T6/T7 依赖，勿改**。
 */
export class NotifyChannelStorageDisabledError extends Error {
  constructor(message: string = MASTER_KEY_MISSING_MESSAGE) {
    super(message);
    this.name = 'NotifyChannelStorageDisabledError';
  }
}

/** `status()` 单项（§2.4 GET 响应项**逐字形状**；T6 包成 `{keys: [...]}`）。 */
export interface NotifyChannelStatusItem {
  key: NotifyChannelKey;
  label: string;
  secret: boolean;
  configured: boolean;
  value: string | null;
  fingerprint: string | null;
  hint: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** `label` 逐字（§2.4 表下注文；键序 = ⚙️1）。 */
const NOTIFY_CHANNEL_LABELS: Readonly<Record<NotifyChannelKey, string>> = {
  'notify.smtp.host': '邮件服务器',
  'notify.smtp.port': '邮件端口',
  'notify.smtp.user': '邮件账号',
  'notify.smtp.pass': '邮件授权码',
  'notify.email.to': '告警收件地址',
  'notify.webhook.feishuUrl': '飞书机器人地址',
  'notify.webhook.wecomUrl': '企业微信机器人地址',
  'notify.webhook.dingtalkUrl': '钉钉机器人地址',
  'notify.webhook.dingtalkSecret': '钉钉加签密钥',
};

/** `hint` 只对三 URL 键现算（§2.4 hint 规则；其余六键恒 null）。 */
const NOTIFY_CHANNEL_URL_KEYS: readonly NotifyChannelKey[] = [
  'notify.webhook.feishuUrl',
  'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl',
];

/** LIST 行（列名逐字 = §2.2 DDL；驱动读出为 `unknown`，消费处收窄）。 */
interface NotifyChannelListRow {
  key: unknown;
  value_enc: unknown;
  fingerprint: unknown;
  updated_at: unknown;
  updated_by: unknown;
}

/** 锁定读行（`NOTIFY_CHANNEL_LOCK_SQL` 只选 `value_enc`/`fingerprint`）。 */
interface NotifyChannelLockedRow {
  value_enc: unknown;
  fingerprint: unknown;
}

function isSecretKey(key: NotifyChannelKey): boolean {
  return (NOTIFY_CHANNEL_SECRET_KEYS as readonly NotifyChannelKey[]).includes(key);
}

function isUrlKey(key: NotifyChannelKey): boolean {
  return NOTIFY_CHANNEL_URL_KEYS.includes(key);
}

/**
 * 审计列形状（§3.1）：密键 = `{"redacted":true,"fingerprint":"<12hex>"}`（键序 redacted 在前，
 * 逐字；值**不含**密文片段/明文片段）。
 */
function redactedAuditJson(fingerprint: string): string {
  return JSON.stringify({ redacted: true, fingerprint });
}

/**
 * 死锁判别（三重口径 + driverError 包装形态；照支付片 `pay-channel.service.ts` 同族先例，
 * 误判代价不对称：漏认 ⇒ 重试面失效、真库间歇红）。
 */
function isDeadlockError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  };
  if (e.code === 'ER_LOCK_DEADLOCK' || e.errno === 1213) return true;
  if (e.driverError?.code === 'ER_LOCK_DEADLOCK' || e.driverError?.errno === 1213) return true;
  return typeof e.message === 'string' && /deadlock found/i.test(e.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class NotifyChannelService implements OnModuleInit {
  private readonly logger = new Logger(NotifyChannelService.name);

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * ⚙️17 刷新点②：**启动时一次重算**（写路径现算见 `set`/`clear`）。
   * `refreshNotifyGauges` 内部自吞（读失败 ⇒ 保持旧值 + WARN）⇒ 本钩子不因 gauge 面失败而拒绝启动。
   */
  async onModuleInit(): Promise<void> {
    await refreshNotifyGauges(this.dataSource);
  }

  /**
   * 管理读（§2.4 GET 的 data.keys；T6 组装信封）。九项**恒返回**（缺行 = 未配置项也在——
   * 管理页要能显示「未配置 + 输入框」）。任何行的解密失败 ⇒ `NotifyChannelStorageDisabledError`
   * （§2.3「不静默丢行」）。
   */
  async status(): Promise<NotifyChannelStatusItem[]> {
    this.assertMasterKey(); // 设计 D2：主钥缺 ⇒ 三端点一律 503（空库亦拒——fail-closed）
    const rows = await this.listRows();
    return NOTIFY_CHANNEL_KEYS.map((key) => {
      const row = rows.get(key);
      const secret = isSecretKey(key);
      if (!row) {
        return {
          key,
          label: NOTIFY_CHANNEL_LABELS[key],
          secret,
          configured: false,
          value: null,
          fingerprint: null,
          hint: null,
          updatedAt: null,
          updatedBy: null,
        };
      }
      const plaintext = this.decryptRow(key, String(row.value_enc)); // 逐行解密（密键也解——坏行响亮）
      return {
        key,
        label: NOTIFY_CHANNEL_LABELS[key],
        secret,
        configured: true,
        value: secret ? null : plaintext, // 掩码写：五密键任何角色读不回原文（设计 D5/§2.4）
        fingerprint: String(row.fingerprint),
        // URL 三键现算 hint（§2.4：全等命中三平台 ⇒ origin；否则「外部地址」）；其余六键恒 null。
        hint: isUrlKey(key) ? urlHint(plaintext) : null,
        updatedAt: toEpochMs(row.updated_at, 'notify_channel_config.updated_at'),
        updatedBy: String(row.updated_by),
      };
    });
  }

  /**
   * 写（§3.1 三段序；T6 的 PUT）。`rawValue` 为管理页原文；`actor` 由调用方保证已过
   * `requireActor`（本层不做身份判定）。
   */
  async set(
    key: NotifyChannelKey,
    rawValue: string,
    actor: string,
  ): Promise<{ fingerprint: string; updatedAt: number }> {
    // ① 校验（失败 ⇒ 400 候选）**先于一切库操作**——「400 了却先落库」不可能发生（§3.1：校验先于一切；连锁定读都不发生）。
    const validation = validateAndNormalize(key, rawValue);
    if (!validation.ok) throw new NotifyChannelValidationError(validation.reason);
    const canonical = validation.canonical;

    // ② 主钥缺 ⇒ 存储不可用（先于事务/加密；§3.1 观测序：本检查在 ① 之后）。
    this.assertMasterKey();
    const valueEnc = encrypt(key, canonical);
    const fingerprint = fingerprintOf(canonical);

    // ③ 事务三段序（锁 → UPSERT → 审计同事务）+ 1213 有界重试（捕获边界包住整个事务，§3.1）。
    const result = await this.withDeadlockRetry(key, () =>
      this.dataSource.transaction(async (em) => {
        // ① 锁定读：拿旧值（无行 ⇒ null）。旧**非密**值的审计明文在此后解密（失败 ⇒ 存储不可用）。
        const locked = (await em.query(NOTIFY_CHANNEL_LOCK_SQL, [key])) as NotifyChannelLockedRow[];
        const oldRow = locked.length > 0 ? locked[0]! : null;

        // ② 覆盖写（ODKU；updated_at=NOW(3) 由 SQL 落）。
        await em.query(NOTIFY_CHANNEL_UPSERT_SQL, [key, valueEnc, fingerprint, actor]);

        // ③ 审计留痕（**同事务**——与写入要么一起提交、要么一起回滚；old/new 照 §3.1 两列两形态）。
        await em.query(CONFIG_CHANGES_INSERT_SQL, [
          key,
          this.auditOldValue(key, oldRow),
          this.auditNewValue(key, canonical, fingerprint),
          actor,
        ]);

        // updatedAt = 提交当刻的本地毫秒（UPSERT 的 NOW(3) 不读回——§2.4 该字段只作管理页显示）。
        return { fingerprint, updatedAt: Date.now() };
      }),
    );

    // ④ ⚙️17 刷新点①（写路径现算）：**事务成功后**调用；内部自吞 ⇒ 不可能转写失败/回滚。
    await refreshNotifyGauges(this.dataSource);
    return result;
  }

  /**
   * 清空（§3.1；T6 的 DELETE——**幂等**：行不存在也成功，只是 `existed:false`、不落审计）。
   *
   * 结构说明：锁定读与 DELETE/审计在**同一个事务**里（`FOR UPDATE` 的事务外无锁语义；
   * 且写事务纪律「锁→写→审计同事务」对清空逐字同规）——事务内的「无行 ⇒ 直接返回」=
   * 本事务无任何写即提交，观测面与「不落审计」逐字一致。
   */
  async clear(key: NotifyChannelKey, actor: string): Promise<{ existed: boolean }> {
    this.assertMasterKey(); // 设计 D2：管理三端点同拒（DELETE 的 503 面）
    const result = await this.withDeadlockRetry(key, () =>
      this.dataSource.transaction(async (em) => {
        const locked = (await em.query(NOTIFY_CHANNEL_LOCK_SQL, [key])) as NotifyChannelLockedRow[];
        if (locked.length === 0) return { existed: false }; // 无行：不 DELETE、不落审计

        await em.query(NOTIFY_CHANNEL_DELETE_SQL, [key]);
        await em.query(CONFIG_CHANGES_INSERT_SQL, [
          key,
          this.auditOldValue(key, locked[0]!),
          // §3.1：清空 `new_value` 传 **JSON 字符串 `'null'`**（SQL NULL 会被 NOT NULL 以 1048 拒；
          // 与「首写 old = SQL NULL」（同 §3.1）是**分开钉的两列两种形态**，不得混用）。
          JSON.stringify(null),
          actor,
        ]);
        return { existed: true };
      }),
    );

    // ⚙️17 刷新点①：clear 同样「事务成功后」刷新（含 `existed:false` 的空事务提交——口径统一）。
    await refreshNotifyGauges(this.dataSource);
    return result;
  }

  /**
   * RPC 拉取（§2.5 响应 data；T7 组装信封）。仅已配置键（缺键不补）；密键值 = 存储 canonical
   * （URL 逐字保真——消费端 relay/renderer 直接用）。任何解密失败 ⇒ `NotifyChannelStorageDisabledError`。
   */
  async pull(): Promise<Partial<Record<NotifyChannelKey, string>>> {
    this.assertMasterKey(); // 设计 D2：主钥缺 ⇒ RPC 一致拒（T7 转 {ok:false,10007}）
    const rows = await this.listRows();
    const values: Partial<Record<NotifyChannelKey, string>> = {};
    for (const key of NOTIFY_CHANNEL_KEYS) {
      const row = rows.get(key);
      if (row) values[key] = this.decryptRow(key, String(row.value_enc));
    }
    return values;
  }

  /** LIST 全表 → 按 `key` 索引（`status`/`pull` 按 ⚙️1 序查表组装）。 */
  private async listRows(): Promise<Map<string, NotifyChannelListRow>> {
    const rows = (await this.dataSource.query(NOTIFY_CHANNEL_LIST_SQL)) as NotifyChannelListRow[];
    const byKey = new Map<string, NotifyChannelListRow>();
    for (const row of rows) byKey.set(String(row.key), row);
    return byKey;
  }

  /**
   * 主钥在场检查（设计 D2 fail-closed）。与 crypto 模块内部的取钥同源
   * （`parseMasterKey` + 进程缓存）——判定的就是 `encrypt`/`decrypt` 将要用的同一把钥。
   */
  private assertMasterKey(): void {
    if (!parseMasterKey(process.env.PAY_CONFIG_ENC_KEY)) {
      throw new NotifyChannelStorageDisabledError();
    }
  }

  /** 解密一行存储值；任何失败（主钥缺/坏密文/错 AAD）⇒ `NotifyChannelStorageDisabledError`（§2.3 响亮）。 */
  private decryptRow(key: NotifyChannelKey, valueEnc: string): string {
    try {
      return decrypt(key, valueEnc);
    } catch (err) {
      throw new NotifyChannelStorageDisabledError(err instanceof Error ? err.message : undefined);
    }
  }

  /**
   * 旧值 → 审计参数（§3.1，**两列 null 形态分开钉**）：无旧行 ⇒ **SQL NULL**（绑定 `null`）；
   * 密键 ⇒ redacted 对象（指纹取**旧行存储列**——旧密文无需解密）；非密键 ⇒ JSON 字符串
   * （旧 canonical 明文，需解密，失败 ⇒ 存储不可用）。
   */
  private auditOldValue(key: NotifyChannelKey, oldRow: NotifyChannelLockedRow | null): string | null {
    if (oldRow === null) return null;
    if (isSecretKey(key)) return redactedAuditJson(String(oldRow.fingerprint));
    return JSON.stringify(this.decryptRow(key, String(oldRow.value_enc)));
  }

  /** 新值 → 审计参数（§3.1）：密键 ⇒ redacted（**新**指纹）；非密键 ⇒ JSON 字符串（新 canonical）。 */
  private auditNewValue(key: NotifyChannelKey, canonical: string, fingerprint: string): string {
    return isSecretKey(key) ? redactedAuditJson(fingerprint) : JSON.stringify(canonical);
  }

  /**
   * 1213 有界重试（§3.1）：`fn` 必须是**整个** `dataSource.transaction()` 调用（支付片 U-2 捕获边界
   * 「含提交」）；仅死锁重试（≤2 次），其余错误原样抛（失败不静默）；第 3 次尝试仍死锁 ⇒ 抛最后错误。
   * 事务已整体回滚（数据库侧无痕）⇒ 重试的幂等依据成立——重试会**重跑整段**（含重读旧值）。
   */
  private async withDeadlockRetry<T>(key: NotifyChannelKey, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (attempt > DEADLOCK_RETRY_LIMIT || !isDeadlockError(err)) throw err;
        const delayMs = DEADLOCK_RETRY_BASE_MS + Math.floor(Math.random() * DEADLOCK_RETRY_BASE_MS);
        this.logger.warn(
          `通知通道写事务死锁（1213）—— key=${key} attempt=${attempt}/${DEADLOCK_RETRY_LIMIT + 1}，` +
            `${delayMs}ms（基准 ${DEADLOCK_RETRY_BASE_MS}ms + 抖动）后重试`,
        );
        await sleep(delayMs);
      }
    }
  }
}
