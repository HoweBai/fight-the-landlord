import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { EntityManager, Repository, type QueryDeepPartialEntity } from 'typeorm';
import { parseConfigValue, ProtocolError, isLegacyConfigKey, type ConfigKey, type ConfigSnapshot } from '@fight-the-landlord/protocol';
import { PlatformConfig } from './platform-config.entity';
import { REDIS } from '../redis/redis.module';
import { CONFIG_CHANGES_INSERT_SQL, CONFIG_LOCK_SQL } from '../admin/admin-changes.service';

/** 广播频道（T6/T7 的消费侧订阅**同名**字符串；本片没有共享常量包，两侧各写一次并由 conformance 钉住）。 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/** 首建版本（规格 §2.1：`key` 不存在 ⇒ INSERT 自 1）。 */
const FIRST_VERSION = 1;

/**
 * 写 patch 的形状别名 + 为什么有 `as ConfigPatch['value']`：
 * `parseConfigValue` 的返回是 `unknown`（protocol 契约），而 TypeORM 的
 * `_QueryDeepPartialEntity<T[P]>` 对非数组属性会折叠成 `{} | (() => string)` —— `unknown`
 * 过不了这道 type-level 的关（null 也过不了，而 null 恰是 json 值域的合法成员）。
 * 这是**类型形状**问题、不是运行时校验问题：值的合法性由 `parseConfigValue` 在落库前保证。
 */
type ConfigPatch = QueryDeepPartialEntity<PlatformConfig>;

/** 普通写的 patch（UPDATE 与并发首建重试共用 —— 两处**必须**是同一条相对自增语句）。 */
function relativeWritePatch(normalized: unknown, updatedBy: string): ConfigPatch {
  return {
    value: normalized as ConfigPatch['value'],
    version: () => 'version + 1',
    updatedAt: () => 'NOW(3)',
    updatedBy,
  };
}

/** `list()` / 管理读返回的行形状。 */
export interface PlatformConfigRow {
  key: ConfigKey;
  value: unknown;
  version: number;
}

/**
 * 派生**全局版本**（规格 §2.1/§2.3："全局 = MAX(每键)"）—— 快照与管理读共用。
 *
 * 空行集 ⇒ 0（中性值；一百零一键齐全由迁移种子保证，空表只可能出现在建库事故里，
 * 此时给 0 比给 `-Infinity` 诚实，也不让响应形状随行数变化）。
 */
export function maxVersion(rows: PlatformConfigRow[]): number {
  return Math.max(0, ...rows.map((r) => r.version));
}

/**
 * 行集 → 快照载荷（规格 §2.3/§2.5 的**同一形状**：每键 `{value, version}` + 全局 MAX）。
 * 管理读（`GET /api/admin/config`）与 RPC（`config.snapshot`）都经它组装 —— 两处若各写一份，
 * 就是「同一事实两处实现」。
 *
 * ⚠️ `ConfigSnapshot` 类型上是 `Record<ConfigKey, …>`（一百零一键齐全）——这是**数据不变量**
 * （迁移种子），不是本函数的运行时承诺：行缺了就少那个键，消费侧（T6 的 getter）按 D2
 * 逐键兜底默认值。这里**不伪造**缺行（伪造会把「配置中心数据不完整」这条事故伪装成正常）。
 */
export function configSnapshotPayload(rows: PlatformConfigRow[]): {
  config: ConfigSnapshot;
  version: number;
} {
  const config = {} as ConfigSnapshot;
  for (const r of rows) config[r.key] = { value: r.value, version: r.version };
  return { config, version: maxVersion(rows) };
}

/**
 * `platform_config` 的读写（规格 §2.1 / A6）。
 *
 * 🔴 **持久真源是 MySQL**（纪律）：读**每次查库、刻意不缓存**（与 user-service 档位表同一条
 * 理由 —— 进程内缓存会把「后台改了要生效」变成「改了要重启」）；Redis 只承担 `config:changed`
 * 广播（消费侧的 60s 安全网会兜 publish 丢失）。
 */
@Injectable()
export class PlatformConfigService {
  private readonly logger = new Logger(PlatformConfigService.name);

  constructor(
    @InjectRepository(PlatformConfig)
    private readonly repo: Repository<PlatformConfig>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 全量读：每次查库、不缓存、不排序（调用方按需组装）。 */
  async list(): Promise<PlatformConfigRow[]> {
    const rows = await this.repo.find();
    return rows.map((r) => ({ key: r.key as ConfigKey, value: r.value, version: r.version }));
  }

  /** 单键读：缺失 ⇒ `null`（调用方决定兜底默认值 —— 本服务不替消费侧猜）。 */
  async get(key: ConfigKey): Promise<{ value: unknown; version: number } | null> {
    const row = await this.repo.findOne({ where: { key } });
    if (!row) return null;
    return { value: row.value, version: row.version };
  }

  /**
   * 写：校验（protocol）→ 事务内〔①锁定读 → ②更新/插入 version+1 → ③留痕行〕→ publish
   * （失败不拦写、announced 如实）。事务内三段逐字序 = 规格 §2.6；`updated_by = actor`。
   *
   * `actor` 由调用方保证是合法管理身份（`admin.controller.ts` 的 PUT 先过 `requireActor`
   * fail-closed——本方法不做身份判定）。
   */
  async set(
    key: ConfigKey,
    value: unknown,
    actor: string,
  ): Promise<{ version: number; announced: boolean }> {
    // 配置平行化（2026-10-24）：旧平台键只读。写入一律 400（在任何库操作之前）。
    if (isLegacyConfigKey(key)) {
      throw new ProtocolError(
        `配置键 ${key} 已废弃（只读回退），请改用 game.doudizhu.* / game.paodekuai.* 对应键`,
      );
    }

    // 2026-10-21（台费并入档位表）：
    // D13 旧形态档位表（全部条目缺 entryFeePercent）拒绝；守卫在 parseConfigValue **之前**：
    // 收到的是「请硬刷新」而非泛化校验错。旧费率键已在阶段 2 从 CONFIG_KEYS 删除（未知键自然 400）。
    const isLegacyLevelsShape =
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (item) => item !== null && typeof item === 'object' && !('entryFeePercent' in item),
      );
    if (key === 'game.levels.doudizhu' && isLegacyLevelsShape) {
      throw new ProtocolError(
        '档位表写入缺少 entryFeePercent（管理页面已更新，请硬刷新后重试；API 写入请显式给 0–100）',
      );
    }

    // C5：非法/未知键 ⇒ ProtocolError（T3 翻 400）—— 在**任何**库操作**之前**，
    // 保证「400 了却先落库」不可能发生（连锁定读都不发生）。
    const normalized = parseConfigValue(key, value);

    const version = await this.repo.manager.transaction(async (em) => {
      // ① 锁定读（§2.6 序①；SQL 全文 = `CONFIG_LOCK_SQL`，被单测钉）：锁住该键行直到事务结束，
      //    并发同键写被串行化（RR 下普通快照读看不见并发已提交行——同族教训 = 货币 ⚙️14）。
      //    无行 ⇒ 空集 ⇒ `oldValue = null`，照旧走 ② 的无行插入分支。
      const locked = (await em.query(CONFIG_LOCK_SQL, [key])) as Array<{ value: unknown }>;
      const oldValue = locked.length > 0 ? locked[0]!.value : null;

      // ② 更新/插入与 version+1 逻辑**照旧**：
      //    ⚠️ `version + 1` 是**相对自增**（`() => 'version + 1'`）—— InnoDB 的行锁把它串行化，
      //    并发写不会丢版本。若写成「先读后写绝对版本」，两个并发事务会互相覆盖（读-改-写竞态）。
      let nextVersion: number;
      const updated = await em.update(
        PlatformConfig,
        { key },
        relativeWritePatch(normalized, actor),
      );
      if (updated.affected === 1) {
        nextVersion = await readVersion(em, key);
      } else {
        // affected=0 ⇒ 键不存在 ⇒ 首建（version 1）。
        try {
          await em.insert(PlatformConfig, {
            key,
            value: normalized as ConfigPatch['value'],
            version: FIRST_VERSION,
            updatedAt: () => 'NOW(3)',
            updatedBy: actor,
          });
          nextVersion = FIRST_VERSION;
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          // 并发首建：另一个事务已抢先 INSERT（唯一键冲突是它的信号）⇒ 重试一次 UPDATE。
          // 此时行必然存在（对手已提交）⇒ 退化为普通自增。
          const retry = await em.update(
            PlatformConfig,
            { key },
            relativeWritePatch(normalized, actor),
          );
          if (retry.affected !== 1) {
            throw new Error(
              `platform_config 写入（${key}）：并发首建重试后仍未命中行（不应发生）`,
            );
          }
          nextVersion = await readVersion(em, key);
        }
      }

      // ③ 留痕行（§2.6 序③；**同事务**——与写入要么一起提交、要么一起回滚）。
      //    json 列显式序列化（绑定对象会走驱动转义的歧义面）；首建 `old_value = NULL`。
      await em.query(CONFIG_CHANGES_INSERT_SQL, [
        key,
        oldValue === null ? null : JSON.stringify(oldValue),
        JSON.stringify(normalized),
        actor,
      ]);

      return nextVersion;
    });

    // C12：publish 失败**不拦写**（值已落库）——`announced:false` + WARN，让「改了没生效」可查。
    let announced = true;
    try {
      await this.redis.publish(CONFIG_CHANGED_CHANNEL, JSON.stringify({ keys: [key] }));
    } catch (err) {
      announced = false;
      this.logger.warn(
        `config publish failed (${key}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { version, announced };
  }
}

/**
 * 事务内读回版本：写完同事务、行锁在手 ⇒ 读到的是**自己刚写的值**
 * （并发读只会被行锁串行化到本事务之后，不会读到中间态）。
 */
async function readVersion(em: EntityManager, key: string): Promise<number> {
  const row = await em.findOne(PlatformConfig, { where: { key } });
  if (!row) {
    throw new Error(`platform_config 读回失败：${key} 不存在（写后同事务读，不应发生）`);
  }
  return row.version;
}

/**
 * 唯一键冲突判别。TypeORM 把驱动错误包成 `QueryFailedError`，mysql2 的原错误在
 * `driverError` 上（`code: 'ER_DUP_ENTRY'` / `errno: 1062`）；两个位置都查，防御包法差异。
 *
 * （③ T2 起同时被 `admin/admin-accounts.service.ts` 消费——账号唯一键冲突 ⇒ 409；
 * 单一真源，勿在调用方复制。）
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    errno?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  } | null;
  return (
    e?.driverError?.code === 'ER_DUP_ENTRY' ||
    e?.driverError?.errno === 1062 ||
    e?.code === 'ER_DUP_ENTRY' ||
    e?.errno === 1062
  );
}
