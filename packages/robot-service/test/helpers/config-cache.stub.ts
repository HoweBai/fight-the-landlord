import { vi } from 'vitest';
import type { ConfigCacheService } from '../../src/config/config-cache.service';
import { parseSkillDistribution } from '../../src/robot/config';
import { MODEL_BY_SKILL } from '../../src/robot/models';

/**
 * **配置缓存**的测试桩（片⑦ T8 —— 与 room-service 的 `config-cache.stub.ts` 同构）。
 *
 * 为什么要抽出来：`RobotPool` / `DouZeroHealth` / `BotPlayer` / `RobotService` /
 * `RobotReclaimTask` 五个消费方的构造函数都多了同一个依赖（`ConfigCacheService`），
 * 而 `new …` 在六个测试文件里出现 —— 每个文件各写一份 stub 就是「同一件替身、六套语义」
 * （本仓为「第二真源」付过多次代价）。
 *
 * ⚠️ 缺省值**镜像生产**（与 room 桩同一纪律：夹具随手编值会掩盖「用的是不是真值」）：
 *  - `skillDistribution` = 真默认串的解析结果（0.15/0.35/0.5 有序对）；
 *  - `ruleFallback` = 种子 `true`（要「关」的用例**显式** `mockReturnValue(false)`）；
 *  - `modelBySkill` = `models.ts` 的真映射（`sl`/`douzero_WP`/`douzero_ADP`）；
 *  - `reclaimIntervalMs` = 60000。
 */
export interface ConfigCacheStub {
  skillDistribution: ReturnType<typeof vi.fn>;
  ruleFallback: ReturnType<typeof vi.fn>;
  modelBySkill: ReturnType<typeof vi.fn>;
  reclaimIntervalMs: ReturnType<typeof vi.fn>;
}

/** 建一个配置缓存桩；四个 getter 都是 `vi.fn`，用例可以 `mockReturnValue` / `toHaveBeenCalled`。 */
export function makeConfigCache(): ConfigCacheStub {
  return {
    skillDistribution: vi.fn(() => parseSkillDistribution()),
    ruleFallback: vi.fn(() => true),
    modelBySkill: vi.fn(() => MODEL_BY_SKILL),
    reclaimIntervalMs: vi.fn(() => 60_000),
  };
}

/** 照 `asRedis()` 的成例：桩**不参与** `ConfigCacheService` 的结构校验，断言转换。 */
export function asConfigCache(stub: ConfigCacheStub): ConfigCacheService {
  return stub as unknown as ConfigCacheService;
}
