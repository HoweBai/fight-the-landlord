import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `platform_config`（规格 §2.1）—— 配置的**持久真源**（Redis 只做广播，C-纪律）。
 *
 * 五列：`key`（PK）/ `value`(json) / `version`(bigint 单调计数器) / `updated_at` / `updated_by`。
 */
@Entity('platform_config')
export class PlatformConfig {
  /** 配置键（protocol `CONFIG_KEYS` 一百零一键之一；写入口的合法性由 `parseConfigValue` 拦）。 */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key!: string;

  /** JSON 值（**归一化后**的形态 —— `parseConfigValue` 的返回值）。 */
  @Column({ type: 'json' })
  value!: unknown;

  /**
   * 每键单调计数器（规格 §2.1：事务内 `version=version+1`，持久化 ⇒ 重启不倒退）。
   *
   * ⚠️ MySQL 的 BIGINT 经 TypeORM 回来是**字符串**（驱动默认 `bigNumberStrings`）
   * ⇒ 用 transformer 归一成 `number`。不加它，`version + 1` 会变成 `'11'` 这类字符串拼接事故，
   * 且**单测的假库看不到**（假库存 number）—— 这正是 transformer 要写死在这里的理由。
   */
  @Column({
    type: 'bigint',
    transformer: { from: (v: string | number) => Number(v), to: (v: number) => v },
  })
  version!: number;

  /** 最后写入时刻（写路径用服务端 `NOW(3)`，避免应用机时钟漂移）。 */
  @Column({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;

  /** 最后写入者（T3 落 'admin'；种子与直接改库演练落 'seed'/'drill'）。 */
  @Column({ name: 'updated_by', type: 'varchar', length: 64 })
  updatedBy!: string;
}
