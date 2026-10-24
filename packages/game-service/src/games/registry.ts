/**
 * 玩法 runtime 注册表（S1）。
 *
 * - `get()` 找不到 ⇒ **响亮失败**，绝不回落到斗地主；
 * - 重复注册同一玩法 ⇒ 启动期错误（配置/装配 bug 不得静默覆盖）；
 * - 存储用 `AnyGameRuntime` 擦除各 runtime 的会话泛型。
 */
import { Injectable } from '@nestjs/common';
import type { GameType } from '@fight-the-landlord/protocol';
import type { AnyGameRuntime } from './runtime';

@Injectable()
export class GameRegistry {
  private readonly runtimes = new Map<GameType, AnyGameRuntime>();

  register(runtime: AnyGameRuntime): void {
    if (this.runtimes.has(runtime.gameType)) {
      throw new Error(`game runtime already registered: ${runtime.gameType}`);
    }
    this.runtimes.set(runtime.gameType, runtime);
  }

  has(gameType: string): boolean {
    return this.runtimes.has(gameType as GameType);
  }

  get(gameType: GameType): AnyGameRuntime {
    const runtime = this.runtimes.get(gameType);
    if (!runtime) {
      throw new Error(`unknown game runtime: ${gameType}`);
    }
    return runtime;
  }

  list(): GameType[] {
    return [...this.runtimes.keys()];
  }
}
