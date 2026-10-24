import { Injectable } from '@nestjs/common';
import { ConfigCacheService } from '../config/config-cache.service';

/** 端标识值（§0 钉子：头值/字段恰 `app`/`h5` 小写；其余一律未识别）。 */
export function classifyClientPlatform(raw: unknown): 'app' | 'h5' | null {
  return raw === 'app' || raw === 'h5' ? raw : null;
}

/** 端 → 配置键（第 43/44 键逐字；两键独立 —— 不由任何单一开关塌缩代管）。 */
const KEY_BY_PLATFORM = { app: 'client.appEnabled', h5: 'client.h5Enabled' } as const;

/**
 * 端闸判定（客户端接入片 T5；socket 侧 T6 复用同一服务与同一分类器）。
 *
 * ⚠️ **软开关定位**（设计 §三/§七）：端标识是客户端**自报**值、不做验真、可伪造 ——
 * 本服务是 ops 控制手段，**不是**安全边界（安全面归鉴权/风控既有机制）。
 *
 * 消费形态：`ClientGateMiddleware`（HTTP 第 0 步）与 T6 的 socket 握手闸。
 */
@Injectable()
export class ClientGateService {
  constructor(private readonly cache: ConfigCacheService) {}

  /** 闸判定：仅「拉到过快照且值恰为 false」才关；未拉到/键缺失/坏值一律放行（fail-open）。 */
  allows(platform: 'app' | 'h5'): boolean {
    const snap = this.cache.snapshotOrNull();
    if (snap === null) return true;
    return snap[KEY_BY_PLATFORM[platform]]?.value !== false;
  }
}
