import { afterEach, describe, expect, it } from 'vitest';
import { userDatabaseOptions } from '../src/database.config';

describe('DB_MIGRATIONS_RUN', () => {
  afterEach(() => delete process.env.DB_MIGRATIONS_RUN);

  it('默认 true（compose/本地形态行为不变）', () => {
    expect(userDatabaseOptions().migrationsRun).toBe(true);
  });

  it("字面 false 关闭（k8s Deployment 形态）", () => {
    process.env.DB_MIGRATIONS_RUN = 'false';
    expect(userDatabaseOptions().migrationsRun).toBe(false);
  });

  it('其它值不关闭（只认 false）', () => {
    process.env.DB_MIGRATIONS_RUN = '0';
    expect(userDatabaseOptions().migrationsRun).toBe(true);
  });
});
