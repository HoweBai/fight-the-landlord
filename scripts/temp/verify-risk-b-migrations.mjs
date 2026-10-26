#!/usr/bin/env node
/**
 * 临时脚本（B 组真栈轮）：在**真 MySQL 8** 上跑两条迁移的 up/down。
 *
 * 只验证迁移类本身的 SQL 语义，不复用服务启动路径：
 *   - config-service `PdkRiskPlayerCountSeed1797000000006`：7 键、version=全表 MAX、
 *     INSERT IGNORE 重放幂等、down 只删 7 键；
 *   - user-service `RiskReviewGameType1797000000005`：加列 + 默认值回填 + 复合索引、
 *     down 先删索引再删列。
 *
 * 跑完即删（与 workflow 同生命周期），不进入最终分支。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../packages/config-service/package.json', import.meta.url));
const mysql = require('mysql2/promise');

const cfg = {
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'root',
  database: process.env.MYSQL_DATABASE ?? 'ftl',
  multipleStatements: true,
};

const conn = await mysql.createConnection(cfg);
const runner = {
  async query(sql, params = []) {
    const [rows] = await conn.query(sql, params);
    return rows;
  },
};

const load = (rel) => require(resolve(rel));

console.log(`[migrations] MySQL ${cfg.host}:${cfg.port}/${cfg.database}`);

// ── 1) config-service: 1797000000006-PdkRiskPlayerCountSeed ──────────────────
{
  const { PdkRiskPlayerCountSeed1797000000006 } = await load(
    'packages/config-service/dist/migrations/1797000000006-PdkRiskPlayerCountSeed.js',
  );
  await conn.query('DROP TABLE IF EXISTS platform_config');
  await conn.query(`
    CREATE TABLE platform_config (
      \`key\` varchar(191) NOT NULL,
      \`value\` json NOT NULL,
      \`version\` int NOT NULL,
      \`updated_at\` datetime(3) NOT NULL,
      \`updated_by\` varchar(64) NULL,
      PRIMARY KEY (\`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await conn.query(
    "INSERT INTO platform_config (`key`,`value`,`version`,`updated_at`,`updated_by`) VALUES ('seed.existing','{}',7,NOW(3),'test')",
  );

  const m = new PdkRiskPlayerCountSeed1797000000006();
  const countNew = async () => {
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS n FROM platform_config WHERE `key` IN (" +
        "'game.paodekuai.risk.player2.winRateThreshold'," +
        "'game.paodekuai.risk.player2.minGames'," +
        "'game.paodekuai.risk.player3.winRateThreshold'," +
        "'game.paodekuai.risk.player3.minGames'," +
        "'game.paodekuai.risk.player4.winRateThreshold'," +
        "'game.paodekuai.risk.player4.minGames'," +
        "'game.paodekuai.risk.autoThrottleScore')",
    );
    return Number(rows[0].n);
  };

  await m.up(runner);
  assert.equal(await countNew(), 7, 'config up 应插入 7 键');
  const [rows] = await conn.query(
    "SELECT `key`,`value`,`version`,`updated_by` FROM platform_config WHERE `key` LIKE 'game.paodekuai.risk.%' ORDER BY `key`",
  );
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => Number(r.version) === 7 && r.updated_by === 'seed'), 'version=全表 MAX(7)、updated_by=seed');
  const valueOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, valueOf(r.value)]));
  assert.equal(byKey['game.paodekuai.risk.player2.winRateThreshold'], 0.8, 'winRate 种子 0.8');
  assert.equal(byKey['game.paodekuai.risk.autoThrottleScore'], 50, 'autoThrottleScore 种子 50');

  await m.up(runner);
  assert.equal(await countNew(), 7, 'config up 重放应幂等（INSERT IGNORE）');

  await m.down(runner);
  assert.equal(await countNew(), 0, 'config down 应只删 7 键');
  const [left] = await conn.query("SELECT COUNT(*) AS n FROM platform_config WHERE `key`='seed.existing'");
  assert.equal(Number(left[0].n), 1, 'config down 不得删既有键');

  await m.up(runner);
  assert.equal(await countNew(), 7, 'config down 后可再次 up');
  await m.down(runner);
  assert.equal(await countNew(), 0, 'config 第二轮 down');
  console.log('[migrations] ✅ config 1797000000006 up/down/up/down 通过');
}

// ── 2) user-service: 1797000000005-RiskReviewGameType ───────────────────────
{
  const { RiskReviewGameType1797000000005 } = await load(
    'packages/user-service/dist/migrations/1797000000005-RiskReviewGameType.js',
  );
  await conn.query('DROP TABLE IF EXISTS risk_reviews');
  await conn.query(`
    CREATE TABLE risk_reviews (
      id bigint NOT NULL AUTO_INCREMENT,
      user_id bigint NOT NULL,
      status varchar(16) NOT NULL,
      score int NOT NULL DEFAULT 0,
      handled_by bigint NULL,
      handled_at datetime(3) NULL,
      reasons json NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await conn.query("INSERT INTO risk_reviews (user_id,status,score) VALUES (1,'open',25)");

  const column = async () => {
    const [rows] = await conn.query(
      "SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='risk_reviews' AND COLUMN_NAME='game_type'",
    );
    return rows[0];
  };
  const indexCols = async () => {
    const [rows] = await conn.query(
      "SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='risk_reviews' AND INDEX_NAME='idx_game_status_id' ORDER BY SEQ_IN_INDEX",
    );
    return rows;
  };

  const m = new RiskReviewGameType1797000000005();
  await m.up(runner);
  const col = await column();
  assert.ok(col, 'user up 应加 game_type 列');
  assert.equal(col.COLUMN_DEFAULT, 'doudizhu', 'game_type 默认 doudizhu');
  assert.deepEqual((await indexCols()).map((x) => x.COLUMN_NAME), ['game_type', 'status', 'id'], '复合索引列序');
  const [existing] = await conn.query('SELECT game_type FROM risk_reviews WHERE id=1');
  assert.equal(existing[0].game_type, 'doudizhu', '旧行由 DEFAULT 回填');
  await m.down(runner);
  assert.equal(await column(), undefined, 'user down 应删 game_type 列');
  assert.deepEqual(await indexCols(), [], 'user down 应删复合索引');
  const [still] = await conn.query('SELECT COUNT(*) AS n FROM risk_reviews');
  assert.equal(Number(still[0].n), 1, 'user down 不得删数据行');

  await m.up(runner);
  assert.ok(await column(), 'user down 后可再次 up');
  await m.down(runner);
  assert.equal(await column(), undefined, 'user 第二轮 down');
  console.log('[migrations] ✅ user 1797000000005 up/down/up/down 通过');
}

await conn.end();
console.log('[migrations] ✅ 两条迁移真 MySQL up/down 全部通过');
