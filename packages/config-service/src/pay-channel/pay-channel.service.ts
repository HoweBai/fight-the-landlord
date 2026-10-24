import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PAY_CHANNEL_KEYS,
  PAY_CHANNEL_SECRET_KEYS,
  type PayChannelKey,
} from '@fight-the-landlord/protocol';
// ⚠️ **值导入** `DataSource`（DI token；DI 陷阱纪律：类型导入会被擦除 ⇒ 容器启动即崩）。
// 本服务走裸 SQL（锁定读/ODKU/审计三句都要能被单测钉全文）⇒ 注入 DataSource 而非 Repository，
// 同 `AdminChangesService` 形态。
import { DataSource } from 'typeorm';
import { toEpochMs } from '../admin/admin-accounts.service';
import { CONFIG_CHANGES_INSERT_SQL } from '../admin/admin-changes.service';
import { decrypt, encrypt, fingerprintOf, parseMasterKey } from './pay-channel.crypto';
import { validateAndNormalize } from './pay-channel.validators';

/**
 * 渠道凭据第二键空间的服务层（规格 §3.1 写路径 / §3.2 读路径 / §2.2 SQL 逐字；T4）。
 * 消费方：T5 管理三端点（`status`/`set`/`clear`）· T6 RPC 接收侧（`pull`）。
 *
 * ─── 四条对外方法 ────────────────────────────────────────────────────────────
 *  - `status()`：LIST → **逐行解密** → 按 ⚙️1 固定序组装六项（缺行 = `configured:false`）。
 *    非密键给 `value` 明文；**secret 键 `value` 恒 `null`**（只给指纹——掩码写，D4/§2.4）；
 *    `updatedAt` 一律 epoch ms（⚙️1 仓例 `toEpochMs`）。密键行也解密（仅为完整性——
 *    坏行 ⇒ 503 响亮，而非「configured 却静默藏坏」）。
 *  - `set()`：`validateAndNormalize`（失败 ⇒ `PayChannelValidationError`，**先于一切库操作**，
 *    C5 纪律）→ 主钥缺 ⇒ `PayChannelStorageDisabledError`（先于事务）→ `encrypt` → 事务
 *    〔①锁定读 ⇒ ②UPSERT ⇒ ③审计留痕（`CONFIG_CHANGES_INSERT_SQL`）**同事务**〕→
 *    返回 `{fingerprint, updatedAt}`。
 *  - `clear()`：锁定读（**同事务**——`FOR UPDATE` 在事务外无锁语义，见下）→ 无行 ⇒
 *    `{existed:false}`（**不落审计**，幂等）→ 有行 ⇒ DELETE + 审计（old 照 ⚙️17，
 *    new = JSON 字符串 `'null'`）→ `{existed:true}`。
 *  - `pull()`：LIST → 逐行解密 → `Partial<Record<PayChannelKey, string>>`（**缺键不补**；
 *    密钥类值为 canonical = base64(PEM)，= 旧 env 格式，读侧零改，§2.5）。
 *
 * ─── 纪律（Global Constraints）───────────────────────────────────────────────
 *  - **不 publish**：渠道凭据不进任何广播（D1/§5.2⑤——`config:changed` 只广播 49 键面，
 *    本服务连 redis 都不注入）；
 *  - **不复用** `PlatformConfigService.set()`（D4/G3：不同表、不同审计值形状、不同键空间）；
 *  - **失败不静默**：解密任何失败 ⇒ `PayChannelStorageDisabledError`（管理 503 / RPC
 *    `{ok:false,10007}`，§2.3/§2.5②）；校验失败 ⇒ `PayChannelValidationError`（reason
 *    **不含输入值**，§2.9——400 message 会回显到管理页/日志）。
 *  - **主钥缺失 fail-closed（§3.5）**：四方法入口统一 `assertMasterKey()`——「存储不可用」
 *    在三端点（含**空库 GET**）与拉取通道上一致可观测，不给「空库看起来正常、保存才炸」的中间态。
 *    观测序（S-3）：`set()` 的 400（校验）**先于** 503（主钥）——以 503 为判据的探针必须用合法值。
 *
 * ─── 1213 死锁有界重试（§3.1 末段；T-2 真库实证 + U-2 捕获边界钉死）────────────
 *  LOCK + ODKU 形态在两并发下**可达 1213 死锁**（规格评审在真 MySQL 两会话两次复现，
 *  「无死锁面」不成立）⇒ 写事务（`set`/`clear`）捕获 1213 ⇒ **重试 ≤2 次**（20ms 基准 +
 *  0–20ms 随机抖动；共 ≤3 次尝试）；仍失败 ⇒ 抛出（T5 转 500，响亮）。
 *  **捕获边界（U-2）**：try/catch 包住**整个 `dataSource.transaction()` 调用（含提交）**
 *  ——保守边界 = 仅整事务重试（回滚 ⇒ 零副作用；先例 `payment/user-lock.service.ts:70-101`），
 *  **不得**把 catch 放进事务回调内部（那会把「提交阶段失败」漏在重试面之外）。
 *  审计语义：重试成功后恰一「old=前值」行；首写并发下先胜者 old=SQL NULL、后胜者 old=先胜者值
 *  （重试路径**重读**锁定行）；「两行同 NULL」不可达。
 */

/**
 * 锁定读（§2.2 逐字）。`key` 为 MySQL **保留字** ⇒ 反引号（同族教训 `admin-changes.service.ts:22-24`：
 * 裸写 `WHERE key=?` 在真栈 1064）。锁住该键行直到事务结束：并发同键写被串行化。
 * 无行 ⇒ 空集 ⇒ `old = SQL NULL`。**全文被单测钉**。
 */
export const PAY_CHANNEL_LOCK_SQL =
  'SELECT value_enc, fingerprint FROM pay_channel_config WHERE `key`=? FOR UPDATE';

/**
 * 覆盖写（§2.2 逐字）：INSERT … ODKU。无行 ⇒ 插入；有行 ⇒ 覆盖 value_enc/fingerprint/
 * updated_by/updated_at（`updated_at=NOW(3)` 在两侧都写）。`key` 列名同为保留字 ⇒ 反引号。
 */
export const PAY_CHANNEL_UPSERT_SQL =
  'INSERT INTO pay_channel_config (`key`, value_enc, fingerprint, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), fingerprint=VALUES(fingerprint), updated_by=VALUES(updated_by), updated_at=NOW(3)';

/** 全量读（§2.2 逐字；`status`/`pull` 共用）。 */
export const PAY_CHANNEL_LIST_SQL =
  'SELECT `key`, value_enc, fingerprint, updated_at, updated_by FROM pay_channel_config';

/** 删除（§2.2 逐字；`clear` 用）。 */
export const PAY_CHANNEL_DELETE_SQL = 'DELETE FROM pay_channel_config WHERE `key`=?';

/** ⚙️18 文案：主钥缺 = **确实是故障态**（存储不可用），503 语义正确。 */
const MASTER_KEY_MISSING_MESSAGE = '渠道密钥存储未启用（缺主钥）';

/** 1213 重试上限（次）。总尝试 = 1 + 2 = 3（§3.1「重试 ≤2 次」）。 */
const DEADLOCK_RETRY_LIMIT = 2;
/** 重试退避基准（§3.1「20ms 抖动」）：每次延迟 ∈ [20, 40) ms（基准 + 0–20ms 随机）。 */
const DEADLOCK_RETRY_BASE_MS = 20;

/**
 * 校验不过（含运行时未知键——`validateAndNormalize` 的 default 分支）。**T5 转 400**，
 * `reason` 原样作 message（理由文本为常量、**不含输入值**，§2.9）。**类名被 T5 依赖，勿改**。
 */
export class PayChannelValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PayChannelValidationError';
  }
}

/**
 * 存储不可用：主钥缺 / 解密失败。**T5 转 503**（⚙️18）；**T6 转 `{ok:false, code:10007}`**（§2.5②）。
 * `message` 缺省 = ⚙️18 逐字文案；包裹解密失败时透传底层原因（crypto 侧文案同样不含任何值）。
 * **类名被 T5 依赖，勿改**。
 */
export class PayChannelStorageDisabledError extends Error {
  constructor(message: string = MASTER_KEY_MISSING_MESSAGE) {
    super(message);
    this.name = 'PayChannelStorageDisabledError';
  }
}

/** `status()` 单项（§2.4 GET 响应项**逐字形状**；T5 包成 `{keys: [...]}`）。 */
export interface PayChannelStatusItem {
  key: PayChannelKey;
  label: string;
  secret: boolean;
  configured: boolean;
  value: string | null;
  fingerprint: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** `label` 逐字（§2.4 表下注文；键序 = ⚙️1）。 */
const PAY_CHANNEL_LABELS: Readonly<Record<PayChannelKey, string>> = {
  'pay.channel.gatewayUrl': '渠道网关地址',
  'pay.channel.appId': '应用 APPID',
  'pay.channel.privateKey': '应用私钥',
  'pay.channel.publicKey': '支付宝公钥',
  'pay.channel.sellerId': '商户 PID',
  'pay.channel.publicBaseUrl': '对外站点基址',
};

/** LIST 行（列名逐字 = §2.2 DDL；驱动读出为 `unknown`，消费处收窄）。 */
interface PayChannelListRow {
  key: unknown;
  value_enc: unknown;
  fingerprint: unknown;
  updated_at: unknown;
  updated_by: unknown;
}

/** 锁定读行（`PAY_CHANNEL_LOCK_SQL` 只选 `value_enc`/`fingerprint`）。 */
interface PayChannelLockedRow {
  value_enc: unknown;
  fingerprint: unknown;
}

function isSecretKey(key: PayChannelKey): boolean {
  return (PAY_CHANNEL_SECRET_KEYS as readonly PayChannelKey[]).includes(key);
}

/**
 * 审计列形状（⚙️17）：密键 = `{"redacted":true,"fingerprint":"<12hex>"}`（键序 redacted 在前，
 * 逐字；值**不含**密文片段/明文片段）。
 */
function redactedAuditJson(fingerprint: string): string {
  return JSON.stringify({ redacted: true, fingerprint });
}

/**
 * 死锁判别（三重口径 + driverError 包装形态；照 payment `user-lock.service.ts:47-52` 先例，
 * 并比照本包 `isDuplicateKeyError`「驱动包装两位置都查」的防御形态——TypeORM 的
 * `QueryFailedError` 构造时会摊平驱动属性，两种位置都可能命中）。误判代价不对称：
 * 漏认 ⇒ 重试面失效、真库间歇红。
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
export class PayChannelService {
  private readonly logger = new Logger(PayChannelService.name);

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 管理读（§2.4 GET 的 data.keys；T5 组装信封）。六项**恒返回**（缺行 = 未配置项也在——
   * 管理页要能显示「未配置 + 输入框」）。任何行的解密失败 ⇒ `PayChannelStorageDisabledError`
   * （§2.3「不静默丢行」）。
   */
  async status(): Promise<PayChannelStatusItem[]> {
    this.assertMasterKey(); // §3.5：主钥缺 ⇒ 三端点一律 503（空库亦拒——见类头注「fail-closed」）
    const rows = await this.listRows();
    return PAY_CHANNEL_KEYS.map((key) => {
      const row = rows.get(key);
      const secret = isSecretKey(key);
      if (!row) {
        return {
          key,
          label: PAY_CHANNEL_LABELS[key],
          secret,
          configured: false,
          value: null,
          fingerprint: null,
          updatedAt: null,
          updatedBy: null,
        };
      }
      const plaintext = this.decryptRow(key, String(row.value_enc)); // 逐行解密（密键也解——坏行响亮）
      return {
        key,
        label: PAY_CHANNEL_LABELS[key],
        secret,
        configured: true,
        value: secret ? null : plaintext, // 掩码写：私钥任何角色读不回原文（D4/§2.4）
        fingerprint: String(row.fingerprint),
        updatedAt: toEpochMs(row.updated_at, 'pay_channel_config.updated_at'),
        updatedBy: String(row.updated_by),
      };
    });
  }

  /**
   * 写（§3.1 三段序；T5 的 PUT）。`rawValue` 为管理页原文（PEM 或 base64 皆可——校验器归一）；
   * `actor` 由调用方保证已过 `requireActor`（本层不做身份判定）。
   */
  async set(
    key: PayChannelKey,
    rawValue: string,
    actor: string,
  ): Promise<{ fingerprint: string; updatedAt: number }> {
    // ① 校验（失败 ⇒ 400 候选）**先于一切库操作**——「400 了却先落库」不可能发生（C5；连锁定读都不发生）。
    const validation = validateAndNormalize(key, rawValue);
    if (!validation.ok) throw new PayChannelValidationError(validation.reason);
    const canonical = validation.canonical;

    // ② 主钥缺 ⇒ 存储不可用（先于事务/加密；§3.5 观测序：本检查在 ① 之后）。
    this.assertMasterKey();
    const valueEnc = encrypt(key, canonical);
    const fingerprint = fingerprintOf(canonical);

    // ③ 事务三段序（锁 → UPSERT → 审计同事务）+ 1213 有界重试（捕获边界包住整个事务，U-2）。
    return this.withDeadlockRetry(key, () =>
      this.dataSource.transaction(async (em) => {
        // ① 锁定读：拿旧值（无行 ⇒ null）。旧**非密**值的审计明文在此后解密（失败 ⇒ 存储不可用）。
        const locked = (await em.query(PAY_CHANNEL_LOCK_SQL, [key])) as PayChannelLockedRow[];
        const oldRow = locked.length > 0 ? locked[0]! : null;

        // ② 覆盖写（ODKU；updated_at=NOW(3) 由 SQL 落）。
        await em.query(PAY_CHANNEL_UPSERT_SQL, [key, valueEnc, fingerprint, actor]);

        // ③ 审计留痕（**同事务**——与写入要么一起提交、要么一起回滚；old/new 照 ⚙️17）。
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
  }

  /**
   * 清空（§3.1；T5 的 DELETE——**幂等**：行不存在也成功，只是 `existed:false`、不落审计）。
   *
   * 结构说明：锁定读与 DELETE/审计在**同一个事务**里（`FOR UPDATE` 的事务外无锁语义；
   * 且 §5.1-3 的写事务纪律「锁→写→审计同事务」对清空逐字同规）——事务描述里的
   * 「无行 ⇒ 直接 200」= 本事务无任何写即返回，观测面与「不落审计」逐字一致。
   */
  async clear(key: PayChannelKey, actor: string): Promise<{ existed: boolean }> {
    this.assertMasterKey(); // §3.5：管理三端点同拒（DELETE 的 503 面）
    return this.withDeadlockRetry(key, () =>
      this.dataSource.transaction(async (em) => {
        const locked = (await em.query(PAY_CHANNEL_LOCK_SQL, [key])) as PayChannelLockedRow[];
        if (locked.length === 0) return { existed: false }; // 无行：不 DELETE、不落审计

        await em.query(PAY_CHANNEL_DELETE_SQL, [key]);
        await em.query(CONFIG_CHANGES_INSERT_SQL, [
          key,
          this.auditOldValue(key, locked[0]!),
          // ⚙️17②：清空 `new_value` 传 **JSON 字符串 `'null'`**（SQL NULL 会被 NOT NULL 以 1048 拒；
          // 与 ⚙️17① 的「首写 old = SQL NULL」是**分开钉的两列两种形态**，不得混用）。
          JSON.stringify(null),
          actor,
        ]);
        return { existed: true };
      }),
    );
  }

  /**
   * RPC 拉取（§2.5 响应 data；T6 组装信封）。仅已配置键（缺键不补）；密钥类值 = canonical
   * （base64(PEM)，旧 env 格式）。任何解密失败 ⇒ `PayChannelStorageDisabledError`（T6 转 ok:false）。
   */
  async pull(): Promise<Partial<Record<PayChannelKey, string>>> {
    this.assertMasterKey(); // §3.5：主钥缺 ⇒ RPC 一致拒（T6 转 {ok:false,10007}）
    const rows = await this.listRows();
    const values: Partial<Record<PayChannelKey, string>> = {};
    for (const key of PAY_CHANNEL_KEYS) {
      const row = rows.get(key);
      if (row) values[key] = this.decryptRow(key, String(row.value_enc));
    }
    return values;
  }

  /** LIST 全表 → 按 `key` 索引（`status`/`pull` 按 ⚙️1 序查表组装）。 */
  private async listRows(): Promise<Map<string, PayChannelListRow>> {
    const rows = (await this.dataSource.query(PAY_CHANNEL_LIST_SQL)) as PayChannelListRow[];
    const byKey = new Map<string, PayChannelListRow>();
    for (const row of rows) byKey.set(String(row.key), row);
    return byKey;
  }

  /**
   * 主钥在场检查（§3.5 fail-closed）。与 crypto 模块内部的取钥同源
   * （`parseMasterKey` + 进程缓存）——判定的就是 `encrypt`/`decrypt` 将要用的同一把钥。
   */
  private assertMasterKey(): void {
    if (!parseMasterKey(process.env.PAY_CONFIG_ENC_KEY)) {
      throw new PayChannelStorageDisabledError();
    }
  }

  /** 解密一行存储值；任何失败（主钥缺/坏密文/错 AAD）⇒ `PayChannelStorageDisabledError`（§2.3 响亮）。 */
  private decryptRow(key: PayChannelKey, valueEnc: string): string {
    try {
      return decrypt(key, valueEnc);
    } catch (err) {
      throw new PayChannelStorageDisabledError(err instanceof Error ? err.message : undefined);
    }
  }

  /**
   * 旧值 → 审计参数（⚙️17，**两列 null 形态分开钉**）：无旧行 ⇒ **SQL NULL**（⚙️17①，绑定 `null`）；
   * 密键 ⇒ redacted 对象（指纹取**旧行存储列**——旧密文无需解密）；非密键 ⇒ JSON 字符串
   * （旧 canonical 明文，需解密，失败 ⇒ 存储不可用）。
   */
  private auditOldValue(key: PayChannelKey, oldRow: PayChannelLockedRow | null): string | null {
    if (oldRow === null) return null;
    if (isSecretKey(key)) return redactedAuditJson(String(oldRow.fingerprint));
    return JSON.stringify(this.decryptRow(key, String(oldRow.value_enc)));
  }

  /** 新值 → 审计参数（⚙️17）：密键 ⇒ redacted（**新**指纹）；非密键 ⇒ JSON 字符串（新 canonical）。 */
  private auditNewValue(key: PayChannelKey, canonical: string, fingerprint: string): string {
    return isSecretKey(key) ? redactedAuditJson(fingerprint) : JSON.stringify(canonical);
  }

  /**
   * 1213 有界重试（§3.1）：`fn` 必须是**整个** `dataSource.transaction()` 调用（U-2 捕获边界
   * 「含提交」）；仅死锁重试（≤2 次），其余错误原样抛（失败不静默）；第 3 次尝试仍死锁 ⇒ 抛最后错误。
   * 事务已整体回滚（数据库侧无痕）⇒ 重试的幂等依据成立——重试会**重跑整段**（含重读旧值）。
   */
  private async withDeadlockRetry<T>(key: PayChannelKey, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (attempt > DEADLOCK_RETRY_LIMIT || !isDeadlockError(err)) throw err;
        const delayMs = DEADLOCK_RETRY_BASE_MS + Math.floor(Math.random() * DEADLOCK_RETRY_BASE_MS);
        this.logger.warn(
          `支付渠道写事务死锁（1213）—— key=${key} attempt=${attempt}/${DEADLOCK_RETRY_LIMIT + 1}，` +
            `${delayMs}ms（基准 ${DEADLOCK_RETRY_BASE_MS}ms + 抖动）后重试`,
        );
        await sleep(delayMs);
      }
    }
  }
}
