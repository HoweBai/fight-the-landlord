/**
 * T5 的测试夹具：把两个 HTTP 控制器装进**真 Nest 管线**跑（真 guard / 真异常过滤器 /
 * `@HttpCode` / globalPrefix `api` 都是真行为 —— 状态码不是手写的）。
 *
 * 形态照 `config-service/test/helpers/config-probe.ts`（同一个「真 controller + 假服务」的
 * 接线探针先例）；服务依赖由各测试文件自己装配（本包已有 `FakeCurrencyDb`/`FakeRedis`）。
 *
 * ⚠️ 不挂 `createInternalTokenMiddleware()`：那是服务间边界（网关在每一跳注入），有独立的
 * 栈级判据（`internal-token.test.ts`）；本夹具只覆盖 T5 的两个控制器面。
 * ⚠️ `listen(0)` 在 Windows 上偶发撞「Node fetch 封禁端口」——本仓已知假红族 ⑤
 * （判别法：同一次 run 里同一文件在某阶段绿、另一阶段红 ⇒ 环境假红，不必「重跑直到绿」）。
 */
import 'reflect-metadata';
import {
  Module,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
  type Provider,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { ApplyService } from '../../src/apply/apply.service';
import { GetService } from '../../src/apply/get.service';
import { ConfigCacheService } from '../../src/config/config-cache.service';
import { ClaimService } from '../../src/ads/claim.service';
import { WalletController } from '../../src/wallet/wallet.controller';
import { AdminWalletController } from '../../src/admin/admin-wallet.controller';

@Module({})
class HttpProbeModule {}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export interface HttpProbe {
  url: string;
  get: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  postJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  close: () => Promise<void>;
}

async function start(controllers: Type<unknown>[], providers: Provider[]): Promise<HttpProbe> {
  const module: DynamicModule = { module: HttpProbeModule, controllers, providers };
  const app: INestApplication = await NestFactory.create(module, { logger: false });
  // 与 `src/main.ts` 逐字同形（差异面 = internal-token 中间件 + TCP 微服务，见文件头）。
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };

  return {
    url,
    get: (path, headers) => request('GET', path, undefined, headers),
    postJson: (path, body, headers) => request('POST', path, body, headers),
    close: async () => {
      await app.close();
    },
  };
}

/**
 * 装 `WalletController`（`GET /api/wallet/balance` + 广告片 T15 的 `GET /api/wallet/relief`）。
 *
 * 演化登记（照既有惯例）：T8 起构造依赖 = 3 个；**T15 起 = 4 个**（旧 POST 退役后 `ApplyService`
 * 退出本控制器构造面；新增 `ClaimService`（T12 claim 双键：无 claim 路径的签发/复用 +
 * 携 claim 路径的只读读取）与 `DataSource`（账本按 `actionId` 存在性直读））。余额专用例
 * （只打 balance）可不传后三个（占位空对象仅供容器解析；那一面一旦被误触会**响亮**报错而
 * 不是静默）。relief 用例传真 `ClaimService`（配 FakeRedis）+ LedgerDb 包装的 `DataSource` +
 * 可控的 `ConfigCacheService` 替身。
 */
export function startWalletProbe(
  getService: GetService,
  configCache: ConfigCacheService = {} as ConfigCacheService,
  claimService: ClaimService = {} as ClaimService,
  dataSource: DataSource = {} as DataSource,
): Promise<HttpProbe> {
  return start([WalletController], [
    { provide: GetService, useValue: getService },
    { provide: ConfigCacheService, useValue: configCache },
    { provide: ClaimService, useValue: claimService },
    { provide: DataSource, useValue: dataSource },
  ]);
}

/** 只装 `AdminWalletController`（adjust + accounts；`XAdminGuard` 是真件）。 */
export function startAdminProbe(apply: ApplyService, dataSource: DataSource): Promise<HttpProbe> {
  return start([AdminWalletController], [
    { provide: ApplyService, useValue: apply },
    { provide: DataSource, useValue: dataSource },
  ]);
}
