import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isDuplicateKeyError } from '../config/platform-config.service';
import { ADMIN_SCRYPT_PARAMS } from './admin-accounts.service';
import { hashPassword, type ScryptParams } from './admin-password';

/**
 * 首启引导（规格 §2.13 bootstrap；设计 §5.1；判据 C3）。
 *
 * 三态（表空才看 env；非空表一律无动作——幂等）：
 *  - 空表 + `ADMIN_PASSWORD` 非空（`(env ?? '') || null` 纪律：**空串 = 未设**）⇒ 建引导行
 *    `admin` / `super_admin` / `active`（scrypt 哈希）并日志逐字；
 *  - 空表 + env 空 ⇒ 只 warn 逐字（管理面关闭态 = 零账号；建号入口 = hatch，§2.13）;
 *  - 非空表 ⇒ 无动作。
 *
 * 🔴 **不套口令策略**（设计 F10a，防升级自锁）：存量 `ADMIN_PASSWORD` 可能 <10 字符 ⇒ **照建**，
 * 仅多一行 warn。口令长度策略只在**设置口令**的路径（建号/重置）强制。
 *
 * 并发首启（多实例同时起）：唯一键冲突 = 对手已建 ⇒ **捕获忽略**（⚙️13，同 `platform-config`
 * 的并发首建形态）。
 */

export const BOOTSTRAP_USERNAME = 'admin';
export const BOOTSTRAP_ROLE = 'super_admin';

export const ADMIN_BOOTSTRAP_COUNT_SQL = 'SELECT COUNT(*) AS count FROM admin_accounts';
export const ADMIN_BOOTSTRAP_INSERT_SQL =
  'INSERT INTO admin_accounts (username, password_hash, role) VALUES (?, ?, ?)';

/** 日志逐字（§2.13；改一个字符 `admin-bootstrap.test.ts` 当场红）。 */
const CREATED_MESSAGE = `admin bootstrap: created super_admin '${BOOTSTRAP_USERNAME}' from ADMIN_PASSWORD`;
const DISABLED_MESSAGE = 'admin bootstrap: no accounts and no ADMIN_PASSWORD — admin surface disabled';
const SHORT_PASSWORD_MESSAGE =
  'admin bootstrap: bootstrap password is shorter than the policy minimum (10)';

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ADMIN_SCRYPT_PARAMS) private readonly scryptParams: ScryptParams,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows = (await this.dataSource.query(ADMIN_BOOTSTRAP_COUNT_SQL)) as Array<{
      count: unknown;
    }>;
    if (Number(rows[0]?.count ?? 0) > 0) return; // 非空表 ⇒ 无动作（幂等——重启不重放）

    // 读 env 在**表空判定之后**（与 §2.13 语序一致：表空才轮到 env）
    const password = (process.env.ADMIN_PASSWORD ?? '') || null;
    if (password === null) {
      this.logger.warn(DISABLED_MESSAGE);
      return;
    }
    if (password.length < 10) this.logger.warn(SHORT_PASSWORD_MESSAGE); // 照建仅 warn（不套策略）

    const passwordHash = await hashPassword(password, this.scryptParams);
    try {
      await this.dataSource.query(ADMIN_BOOTSTRAP_INSERT_SQL, [
        BOOTSTRAP_USERNAME,
        passwordHash,
        BOOTSTRAP_ROLE,
      ]);
    } catch (err) {
      if (isDuplicateKeyError(err)) return; // 并发首启：对手已建 ⇒ 捕获忽略（不报「created」）
      throw err;
    }
    this.logger.log(CREATED_MESSAGE);
  }
}
