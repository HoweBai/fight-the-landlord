import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

/**
 * socket.io 的 Redis 适配器（spec 2026-10-27 D12）。
 *
 * - 房间广播 `server.to(room).emit()` 跨 Pod 扇出；
 * - `io.in('user:<id>').fetchSockets()` 能看到所有 Pod 上的连接（跨 Pod 顶替依赖它）。
 *
 * ⚠️ 事件驱动推送仍保持「每个副本订阅、只投本地 socket」的模型；不要把这些事件
 * 改成适配器广播，否则每个副本都会 emit 一次 ⇒ N 倍重复。
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pubClient: ReturnType<typeof createClient> | null = null;
  private subClient: ReturnType<typeof createClient> | null = null;

  async connect(redisUrl: string): Promise<void> {
    const pub = createClient({ url: redisUrl });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    this.pubClient = pub;
    this.subClient = sub;
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: any): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async close(server?: any): Promise<void> {
    await super.close(server);
    await Promise.allSettled([
      this.pubClient?.quit() ?? Promise.resolve(),
      this.subClient?.quit() ?? Promise.resolve(),
    ]);
  }
}
