import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { HealthService, type HealthBody, type LivenessBody } from './health.service';

/**
 * §2.4 / R267 的两个端点（照 currency-service 同文件逐字同形）。
 *
 * ⚠️ `@Get('live')` **在** `@Get()` **之前**声明：静态路由先于根路由匹配，
 * 顺序写反会让 `/api/health/live` 落进就绪面。
 *
 * ⚠️ 就绪面**必须按 `status` 设码**（`ok`→200 / `degraded`→503，§2.4 逐字）：
 * `compose` 的 healthcheck 用 `curl -f`，非 2xx 即 `unhealthy` —— 这条写错会让
 * **容器 unhealthy**（payment 的 healthcheck 直连本路径，见 compose 块）。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 存活：不查任何依赖，恒 **200**。 */
  @Get('live')
  @HttpCode(200)
  live(): LivenessBody {
    return this.health.live();
  }

  /** 就绪：真查依赖；`degraded` ⇒ **503**。 */
  @Get()
  async check(
    @Res({ passthrough: true }) res: { status: (code: number) => void },
  ): Promise<HealthBody> {
    const body = await this.health.check();
    res.status(body.status === 'ok' ? 200 : 503);
    return body;
  }
}
