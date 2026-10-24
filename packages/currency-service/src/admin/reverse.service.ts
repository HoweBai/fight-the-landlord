import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * 冲正的**数据读口**（③ T7；规格 §2.8 步骤 1–2）——两条 SQL 全文作为常量收口于此
 * （照 `finance-query.service.ts` 先例：单测按全文相等识别，实现侧漂移一个字符就当场红）。
 *
 *  - ①查 op：不存在 ⇒ `findOp` 返回 null（controller 翻 404）；`source !== 'admin_adjust'`
 *    的判定在 controller（翻 409「该操作不可冲正」）。
 *  - ②entries：原 op 全部 flows **逐条取负**（`ownerId`/`ownerType` 从 flow 取——ownerType
 *    必须显式带回：robot 池类 `admin_adjust` 的流水 ownerType='robot'，缺了会以 'user' 撞
 *    类型闸 10001 并整批回滚）。
 *
 * ⚠️ 读面**不走事务、不加锁**：原 op/flows 一经提交即不可变（唯一写边只增不改），读后到
 * apply 之间的并发窗口不产生错误语义——「已冲正 / 重放」的裁决全在 apply 内
 * （`uk_action_id` + 载荷指纹），本服务**不做**任何「已存在冲正行」的预检短路（⚙️6）。
 * ⚠️ DI 纪律：`DataSource` 值导入 + 显式 `@Inject(...)`（`import type` 会让容器解析不到
 * token —— 单测与 tsc 都看不见，真容器启动即崩，本仓既有陷阱）。
 */

/** §2.8 步骤 1：查原 op（`action_id` 供 refId、`source` 供可冲性判定）。 */
export const REVERSE_OP_SELECT_SQL =
  'SELECT `action_id`, `source` FROM `currency_ops` WHERE `id` = ?';

/** §2.8 步骤 2：原 op 全部 flows（读面即 entries 的原料；取负在 `loadReverseEntries` 里做）。 */
export const REVERSE_FLOWS_SELECT_SQL =
  'SELECT `owner_id`, `owner_type`, `delta` FROM `currency_flows` WHERE `op_id` = ?';

export interface ReverseOpBrief {
  actionId: string;
  source: string;
}

/** 冲正 entry（apply 入参形态；`delta` 已取负、`ownerType` 已从原 flow 带回）。 */
export interface ReverseEntry {
  ownerId: string;
  ownerType: string;
  delta: number;
}

/** 从库里读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默转 NaN）。 */
function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

@Injectable()
export class ReverseService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /** §2.8 步骤 1：op 不存在 ⇒ null（每 op 至少一行 flow 与 ops 同事务写入，行在即有效）。 */
  async findOp(opId: number): Promise<ReverseOpBrief | null> {
    const rows = (await this.dataSource.query(REVERSE_OP_SELECT_SQL, [opId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return null;
    return {
      actionId: String(rows[0]!['action_id']),
      source: String(rows[0]!['source']),
    };
  }

  /** §2.8 步骤 2：`entries = 原 op 全部 flows 取负`（`delta = -delta`；读序无关——apply 内部按 ownerId 重排）。 */
  async loadReverseEntries(opId: number): Promise<ReverseEntry[]> {
    const rows = (await this.dataSource.query(REVERSE_FLOWS_SELECT_SQL, [opId])) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      ownerId: String(row['owner_id']),
      ownerType: String(row['owner_type']),
      delta: -toSafeInt(row['delta'], 'currency_flows.delta'),
    }));
  }
}
