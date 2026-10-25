import type { EntityManager } from 'typeorm';

/** `ApplyService` 传给代理钩子的最小上下文。 */
export interface AgentApplyEntry {
  ownerId: string;
  ownerType: 'user' | 'robot';
  delta: number;
}

export interface AgentApplyContext {
  opId: number;
  actionId: string;
  source: string;
  refId: string | null;
  entries: readonly AgentApplyEntry[];
}

/**
 * 代理记账钩子（spec §4）。任务 4 先落 no-op 骨架，保证
 * `AgentModule` 可导出、`RpcModule` 可 imports；任务 5 填实现。
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class AgentLedgerService {
  async onApply(_manager: EntityManager, _ctx: AgentApplyContext): Promise<void> {
    // 任务 5 实现；当前 no-op（接线骨架）。
  }
}
