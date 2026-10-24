/**
 * pdk × GameService 测试装配（Task 4.2）：registry 同时注册两玩法，便于验证
 * 「GameService 的通用路径真的能把 pdk 会话跑起来」（而不是只测 runtime 单件）。
 */
import type { Redis } from 'ioredis';
import type { PdkRulesConfig } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES, type PdkSession } from '@fight-the-landlord/shared';
import { GameService } from '../src/game/game.service';
import { GameRegistry } from '../src/games/registry';
import { DdzRuntime } from '../src/games/ddz/runtime';
import { PdkRuntime } from '../src/games/pdk/runtime';
import { redisDouble } from './helpers-ioredis';
import { fullGameDeck, pdkPlayers } from './fixtures/pdk-fixtures';

export function pdkRegistry(): GameRegistry {
  const registry = new GameRegistry();
  registry.register(new DdzRuntime());
  registry.register(new PdkRuntime());
  return registry;
}

/** 装配 registry 的 GameService（单测直连构造，不走容器）。 */
export function pdkService(random: () => number = () => 0.5): GameService {
  const service = new GameService(redisDouble as unknown as Redis);
  service.registry = pdkRegistry();
  service.random = random;
  return service;
}

export interface SeedPdkOptions {
  playerCount?: 2 | 3 | 4;
  robotSeats?: readonly number[];
  rules?: Partial<PdkRulesConfig>;
  over?: Partial<PdkSession>;
}

/** 用固定牌堆建一局 pdk 并写入 redis 替身（不经过 startGame 的随机发牌）。 */
export async function seedPdkSession(
  service: GameService,
  roomCode = 'PDK-T',
  opts: SeedPdkOptions = {},
): Promise<PdkSession> {
  const playerCount = opts.playerCount ?? 3;
  const players =
    playerCount === 3
      ? pdkPlayers(opts.robotSeats ?? [])
      : Array.from({ length: playerCount }, (_, seat) => ({
          id: `p${seat}`,
          seat,
          isRobot: (opts.robotSeats ?? []).includes(seat),
        }));
  const base = new PdkRuntime().create({
    roomCode,
    gameType: 'paodekuai',
    playerCount,
    baseScore: 15,
    players,
    rules: { ...DEFAULT_PDK_RULES, ...opts.rules },
    random: () => 0.5,
    // 2/4 人也用同一副 48 张（切份规则不同）；3 人的完整对局序列见夹具注释。
    testDeck: fullGameDeck(),
  });
  const session: PdkSession = {
    ...base,
    turnDeadlineAt: Date.now() + 30_000,
    ...opts.over,
  };
  await service['saveSession'](roomCode, session);
  return session;
}
