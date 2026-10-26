import { describe, expect, it } from 'vitest';
import { AgentModule } from '../src/agent/agent.module';
import { AgentLedgerService } from '../src/agent/agent-ledger.service';
import { AgentSettingsService } from '../src/agent/agent-settings.service';
import { AgentQuotaService } from '../src/agent/agent-quota.service';
import { AgentQuotaMaturityService } from '../src/agent/agent-quota-maturity.service';
import { RpcModule } from '../src/rpc/rpc.module';
import { AppModule } from '../src/app.module';
import { ConfigModule } from '../src/config/config.module';

const meta = (key: string, target: unknown): unknown[] => {
  const value = Reflect.getMetadata(key, target as object) as unknown[] | undefined;
  return value ?? [];
};

describe('AgentModule 装配面（DI 陷阱：单测 new 看不见容器）', () => {
  it('providers 含四个服务；exports 含 settings/quota/ledger（ApplyService 可见面）', () => {
    const providers = meta('providers', AgentModule);
    expect(providers).toEqual(
      expect.arrayContaining([
        AgentSettingsService,
        AgentQuotaService,
        AgentQuotaMaturityService,
        AgentLedgerService,
      ]),
    );
    const exports = meta('exports', AgentModule);
    expect(exports).toEqual(
      expect.arrayContaining([AgentSettingsService, AgentQuotaService, AgentLedgerService]),
    );
  });

  it('AgentModule imports ConfigModule（agent.inviteEnabled 读侧）', () => {
    expect(meta('imports', AgentModule)).toContain(ConfigModule);
  });

  it('RpcModule imports AgentModule（ApplyService 能注入 AgentLedgerService）', () => {
    expect(meta('imports', RpcModule)).toContain(AgentModule);
  });

  it('AppModule imports AgentModule（未来控制器/自调度在容器图内）', () => {
    expect(meta('imports', AppModule)).toContain(AgentModule);
  });

  it('AgentLedgerService.onApply 是函数（任务 5 实现的挂点）', () => {
    expect(typeof AgentLedgerService.prototype.onApply).toBe('function');
  });
});
