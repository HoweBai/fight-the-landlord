/**
 * 通用计时器句柄（多玩法片 S1；从 `ddz/timer.ts` 迁入 core）。
 * 旧路径保留 re-export，行为不变。
 */
export interface TimerHandle {
  clear: () => void;
}

export function createBidTimer(callback: () => void, timeoutMs: number = 30000): TimerHandle {
  const id = setTimeout(callback, timeoutMs);
  return {
    clear: () => clearTimeout(id),
  };
}

export function createPlayTimer(callback: () => void, timeoutMs: number = 30000): TimerHandle {
  const id = setTimeout(callback, timeoutMs);
  return {
    clear: () => clearTimeout(id),
  };
}

export function randomDelay(minMs: number = 500, maxMs: number = 2000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}
