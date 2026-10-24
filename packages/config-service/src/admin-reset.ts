import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isAdminUsername } from '@fight-the-landlord/protocol';
import { ADMIN_ROLES } from './admin/admin-accounts.service';
import { hashPassword } from './admin/admin-password';
import { AppDataSource } from './data-source';

/**
 * hatch —— 忘记口令的服务器复位 CLI（规格 §2.13；设计 §5.2）。
 *
 * 容器内运行（编译产物 = `dist/admin-reset.js`）：
 *   docker compose exec config-service node packages/config-service/dist/admin-reset.js <username> [--role <role>] [--password <pw>]
 *
 * 行为（逐字）：
 *  - `username` 归一（`toLowerCase()`）+ 正则校验（`isAdminUsername`——protocol 单一真源）；
 *    不合法 / 参数拼法不对 / 角色非法 ⇒ 打印用法 + exit 1（**不碰库**）；
 *  - 不存在 ⇒ 按 `--role`（缺省 `super_admin`）**建**；存在 ⇒ **重置口令 + 强制 `active`**
 *    （`--role` 对已存在的账号**不生效**——规格如此）；
 *  - 口令优先序：`--password` > `ADMIN_RESET_PASSWORD` > 随机（`randomBytes(18).toString('base64url')`
 *    = 24 字符）；空串一律按**未设**（本仓 `(env ?? '') || null` 纪律）。**不套口令策略**
 *    （服务器侧复位是逃生通道，同 bootstrap 的 F10a 口径）；
 *  - **stdout 恰好两行**：`reset <username>: ok` + 口令来源三档之一
 *    （`--password` 档与 env 档**不回显值**；只有随机档打印 `new password: <pw>`）；
 *  - 建/复位都与留痕 `admin_account_changes` **同事务**（新建 ⇒ `create`，复位 ⇒ `password_reset`；
 *    `actor='cli'`）；exit 0/1。
 *
 * 形态：`runAdminReset(argv, deps)` 是**纯编排**（单测直接测它，两行输出用返回值断言）；
 * `main()` 只做「初始化真 DataSource + 接线 deps + 打出两行 + 置 exitCode」。
 *
 * ⚠️ 输出走 `process.stdout.write` / `process.stderr.write`（不是 `console.*`）：
 * ① 本进程**不经 Nest 启动**，脱敏 Logger 链路不存在；② stdout 是 **CLI 契约**（机器可读的
 * 逐字两行），不是服务日志；③ 使 `api-gateway/test/no-raw-console.test.ts` 的机械闸（它把
 * 「服务内裸 console」判为绕过脱敏器）保持原样——一次性 CLI 不该往那份「只增」的豁免名单里加人。
 */

export const ADMIN_RESET_USAGE =
  'usage: node packages/config-service/dist/admin-reset.js <username> [--role <role>] [--password <pw>]';

/** 复位/建号用 SQL（与 T2 的账号写面同形；留痕列 = 迁移 `1789900000000-AdminRbac.ts`）。 */
export const ADMIN_RESET_SELECT_SQL = 'SELECT id, username FROM admin_accounts WHERE username = ?';
export const ADMIN_RESET_INSERT_SQL =
  'INSERT INTO admin_accounts (username, password_hash, role) VALUES (?, ?, ?)';
export const ADMIN_RESET_UPDATE_SQL =
  'UPDATE admin_accounts SET password_hash = ?, status = ? WHERE username = ?';
export const ADMIN_ACCOUNT_CHANGE_INSERT_SQL =
  'INSERT INTO admin_account_changes (target_id, username, action, detail, actor) VALUES (?, ?, ?, ?, ?)';

/** 留痕的操作者（§2.13 逐字：`actor:'cli'`——CLI 不是人，不冒用任何管理员用户名）。 */
export const ADMIN_RESET_ACTOR = 'cli';

/** 事务内的 manager 最小面（单测用假库实现；生产 = TypeORM `EntityManager` 的薄壳）。 */
export interface AdminResetQueryRunner {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

/** 注入点：库事务 / scrypt 哈希 / 随机口令 / 环境口令（单测全部可控，main 接真实现）。 */
export interface AdminResetDeps {
  transaction<T>(cb: (manager: AdminResetQueryRunner) => Promise<T>): Promise<T>;
  hash(plain: string): Promise<string>;
  randomPassword(): string;
  /** `(process.env.ADMIN_RESET_PASSWORD ?? '') || null` 纪律在 main 侧施加；此处 null = 未设。 */
  envPassword(): string | null;
}

export interface AdminResetArgs {
  username: string;
  role?: string;
  password?: string;
}

export interface AdminResetOutcome {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/** 随机口令（⚙️14 逐字：`randomBytes(18).toString('base64url')` = 24 字符）。 */
export function randomAdminPassword(): string {
  return randomBytes(18).toString('base64url');
}

/** 解析 argv（`node:util` parseArgs；未知旗标 / 缺值 / 位置参数个数 ≠1 ⇒ null = 用法错误）。 */
export function parseAdminResetArgv(argv: readonly string[]): AdminResetArgs | null {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        role: { type: 'string' },
        password: { type: 'string' },
      },
      allowPositionals: true,
    });
    if (positionals.length !== 1) return null;
    return { username: positionals[0]!, role: values.role, password: values.password };
  } catch {
    return null; // parseArgs 对未知旗标/缺值抛错 ⇒ 一律翻成「用法」
  }
}

function usageFailure(): AdminResetOutcome {
  return { stdout: [], stderr: [ADMIN_RESET_USAGE], exitCode: 1 };
}

/**
 * 被测本体：解析 → 校验 → 定口令 → 单事务（建或复位 + 留痕）→ 两行 stdout。
 * 任何失败（用法 / 库 / 驱动）⇒ `exitCode 1`，绝不半途打印成功行。
 */
export async function runAdminReset(
  argv: readonly string[],
  deps: AdminResetDeps,
): Promise<AdminResetOutcome> {
  const parsed = parseAdminResetArgv(argv);
  if (!parsed) return usageFailure();

  const username = parsed.username.toLowerCase(); // 归一先于正则（⚙️8 纪律：正则吃小写）
  if (!isAdminUsername(username)) return usageFailure();

  const role = parsed.role ?? 'super_admin';
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) return usageFailure();

  // 口令三档（`--password` > env > 随机）；空串 = 未设（`(env ?? '') || null` 纪律，参数同理）
  const argumentPassword = (parsed.password ?? '') || null;
  const envPassword = deps.envPassword() || null;
  const password = argumentPassword ?? envPassword ?? deps.randomPassword();
  const secondLine =
    argumentPassword !== null
      ? 'password: (from argument)'
      : envPassword !== null
        ? 'password: (from ADMIN_RESET_PASSWORD)'
        : `new password: ${password}`;

  // 哈希在事务**之外**（生产档 scrypt ~1s：别让它占着数据库事务；校验已全部通过才会走到这）
  let passwordHash: string;
  try {
    passwordHash = await deps.hash(password);
    await deps.transaction(async (manager) => {
      const rows = (await manager.query(ADMIN_RESET_SELECT_SQL, [username])) as Array<{
        id: unknown;
      }>;
      if (rows.length === 0) {
        const result = (await manager.query(ADMIN_RESET_INSERT_SQL, [
          username,
          passwordHash,
          role,
        ])) as { insertId?: unknown };
        const id = Number(result?.insertId);
        if (!Number.isSafeInteger(id)) {
          throw new Error(`admin-reset：insertId 非安全整数（收到 ${JSON.stringify(result)}）`);
        }
        await manager.query(ADMIN_ACCOUNT_CHANGE_INSERT_SQL, [
          id,
          username,
          'create',
          null,
          ADMIN_RESET_ACTOR,
        ]);
      } else {
        const id = Number(rows[0]!.id);
        await manager.query(ADMIN_RESET_UPDATE_SQL, [passwordHash, 'active', username]);
        await manager.query(ADMIN_ACCOUNT_CHANGE_INSERT_SQL, [
          id,
          username,
          'password_reset',
          null,
          ADMIN_RESET_ACTOR,
        ]);
      }
    });
  } catch (err) {
    return {
      stdout: [],
      stderr: [err instanceof Error ? err.message : String(err)],
      exitCode: 1,
    };
  }

  return { stdout: [`reset ${username}: ok`, secondLine], stderr: [], exitCode: 0 };
}

/** 生产接线（真 DataSource / 生产 scrypt 参数 / crypto 随机 / env 口令）。 */
async function main(): Promise<void> {
  let outcome: AdminResetOutcome;
  try {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    outcome = await runAdminReset(process.argv.slice(2), {
      transaction: (cb) =>
        AppDataSource.transaction((manager) =>
          cb({ query: (sql, params = []) => manager.query(sql, [...params]) }),
        ),
      hash: (plain) => hashPassword(plain), // 默认 = 生产参数（与 bootstrap 同口径）
      randomPassword: randomAdminPassword,
      envPassword: () => (process.env.ADMIN_RESET_PASSWORD ?? '') || null,
    });
  } catch (err) {
    outcome = {
      stdout: [],
      stderr: [err instanceof Error ? err.message : String(err)],
      exitCode: 1,
    };
  }
  for (const line of outcome.stdout) process.stdout.write(line + '\n');
  for (const line of outcome.stderr) process.stderr.write(line + '\n');
  process.exitCode = outcome.exitCode;
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
}

/**
 * 「直接运行才自启」的守卫（照 `alert-relay/src/server.ts:233-243` 的既有形态）：
 * 刻意**不**用 `require.main === module`（vitest 走 ESM 变换，`require` 不存在）——
 * 按 argv[1] 判入口在 CJS 产物与 vitest 两个世界都成立，`node dist/admin-reset.js` 天然命中。
 */
const entry = process.argv[1] ?? '';
if (/[\\/]admin-reset\.(js|ts)$/.test(entry)) void main();
