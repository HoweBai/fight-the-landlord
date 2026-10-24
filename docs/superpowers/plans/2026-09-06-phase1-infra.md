# Phase 1: 基础框架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `platform/` 内搭建 NestJS monorepo 脚手架，创建可运行的 API Gateway、User Service、Room Service、Game Service，并移植 shared/card 和 shared/rule 逻辑，同时完成 DouZero Docker 基础设施配置。

**Architecture:** Turborepo monorepo + pnpm workspace，四个 NestJS 服务各自独立进程，通过 NestJS @ClientProxy TCP RPC 通信（Room → Game），共享逻辑放在 shared 包。DouZero 作为独立容器，通过 HTTP/REST 调用。

**Tech Stack:** NestJS v10, TypeScript 5, pnpm, Turborepo, Vitest, Redis (ioredis), MySQL (TypeORM), jsonwebtoken, @nestjs/microservices (TCP transport)

**Spec:** [platform/docs/design.md](../design.md)

## Global Constraints

- 后端框架: NestJS (TypeScript)
- 消息协议: JSON over WebSocket
- DouZero: 移入 `platform/douzero/`，端口 2021
- 新项目位置: `platform/` 子目录
- 服务端口: API Gateway=3000, User Service=3001, Room Service=3002, Game Service=3003, DouZero=2021
- WebSocket 消息格式: `{type, seq?, timestamp, payload}` / `{type, seq?, version, payload}`
- DouZero card int 映射: rank 17=2, 20=小王, 30=大王，在 `shared/protocol/types.ts` 统一维护

---

## Task 1: Turborepo Monorepo 脚手架

**Files:**
- Create: `platform/package.json`
- Create: `platform/pnpm-workspace.yaml`
- Create: `platform/turbo.json`
- Create: `platform/tsconfig.base.json`
- Create: `platform/.gitignore`
- Create: `platform/.npmrc`
- Create: `platform/README.md`

**Interfaces:**
- Consumes: none (foundation task)
- Produces: monorepo root config that all subsequent packages depend on

- [ ] **Step 1: Create root package.json**

```json
// platform/package.json
{
  "name": "fight-the-landlord-platform",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "clean": "turbo run clean"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.7.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
# platform/pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/*'
  - 'douzero'
```

- [ ] **Step 3: Create turbo.json**

```json
// platform/turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "persistent": true,
      "cache": false
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "clean": {
      "cache": false
    }
  }
}
```

- [ ] **Step 4: Create tsconfig.base.json**

```json
// platform/tsconfig.base.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmitOnError": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 5: Create .gitignore**

```
# platform/.gitignore
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
coverage/
.turbo/
```

- [ ] **Step 6: Create README.md**

```markdown
# fight-the-landlord Platform

NestJS microservices + uni-app 棋牌游戏平台。

## 快速开始

```bash
pnpm install
pnpm dev
```

## 服务端口

- API Gateway: 3000
- User Service: 3001
- Room Service: 3002
- Game Service: 3003
- DouZero: 2021
```

- [ ] **Step 7: Verify root workspace**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform
pnpm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore README.md
git commit -m "chore: scaffold Turborepo monorepo root"
```

---

## Task 2: Shared Card 包（移植自 Go）

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/card/card.ts`
- Create: `packages/shared/src/card/hand.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/card/card.test.ts`
- Create: `packages/shared/src/card/hand.test.ts`

**Interfaces:**
- Consumes: none (pure logic, no dependencies)
- Produces: `Card`, `Rank`, `Suit`, `Deck`, `FindCardsInHand`, `RemoveCards` for all services

- [ ] **Step 1: Create shared package.json**

```json
// packages/shared/package.json
{
  "name": "@fight-the-landlord/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create shared tsconfig.json**

```json
// packages/shared/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create card.ts**

```typescript
// packages/shared/src/card/card.ts

export enum Suit {
  Spade = 0,
  Heart,
  Club,
  Diamond,
  Joker,
}

export enum Rank {
  Rank3 = 3,
  Rank4,
  Rank5,
  Rank6,
  Rank7,
  Rank8,
  Rank9,
  Rank10,
  RankJ,
  RankQ,
  RankK,
  RankA,
  Rank2,
  RankBlackJoker, // DouZero int: 20
  RankRedJoker,   // DouZero int: 30
}

export enum CardColor {
  Black,
  Red,
}

export interface Card {
  suit: Suit;
  rank: Rank;
  color: CardColor;
}

const suitSymbols: Record<Suit, string> = {
  [Suit.Spade]: '♠',
  [Suit.Heart]: '♥',
  [Suit.Club]: '♣',
  [Suit.Diamond]: '♦',
  [Suit.Joker]: '',
};

const rankNames: Record<Rank, string> = {
  [Rank.Rank3]: '3',
  [Rank.Rank4]: '4',
  [Rank.Rank5]: '5',
  [Rank.Rank6]: '6',
  [Rank.Rank7]: '7',
  [Rank.Rank8]: '8',
  [Rank.Rank9]: '9',
  [Rank.Rank10]: '10',
  [Rank.RankJ]: 'J',
  [Rank.RankQ]: 'Q',
  [Rank.RankK]: 'K',
  [Rank.RankA]: 'A',
  [Rank.Rank2]: '2',
  [Rank.RankBlackJoker]: 'B',
  [Rank.RankRedJoker]: 'R',
};

const charToRank: Record<string, Rank> = {
  '3': Rank.Rank3,
  '4': Rank.Rank4,
  '5': Rank.Rank5,
  '6': Rank.Rank6,
  '7': Rank.Rank7,
  '8': Rank.Rank8,
  '9': Rank.Rank9,
  'T': Rank.Rank10,
  'J': Rank.RankJ,
  'Q': Rank.RankQ,
  'K': Rank.RankK,
  'A': Rank.RankA,
  '2': Rank.Rank2,
  'B': Rank.RankBlackJoker,
  'R': Rank.RankRedJoker,
};

export function rankFromChar(char: string): Rank {
  const r = charToRank[char];
  if (r === undefined) throw new Error(`无法识别的点数: ${char}`);
  return r;
}

export function rankToString(rank: Rank): string {
  return rankNames[rank] ?? String(rank);
}

export function suitSymbol(suit: Suit): string {
  return suitSymbols[suit] ?? '';
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (let s = Suit.Spade; s <= Suit.Diamond; s++) {
    for (let r = Rank.Rank3; r <= Rank.Rank2; r++) {
      const color = s === Suit.Heart || s === Suit.Diamond ? CardColor.Red : CardColor.Black;
      deck.push({ suit: s as Suit, rank: r as Rank, color });
    }
  }
  deck.push({ suit: Suit.Joker, rank: Rank.RankBlackJoker, color: CardColor.Black });
  deck.push({ suit: Suit.Joker, rank: Rank.RankRedJoker, color: CardColor.Red });
  return deck;
}

export function shuffleDeck(deck: Card[]): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

export type Deck = Card[];
```

- [ ] **Step 4: Create hand.ts**

```typescript
// packages/shared/src/card/hand.ts
import { Card, Rank, rankToString, rankFromChar } from './card';
import { removeCards } from './hand-impl';

export { removeCards as RemoveCards };

export function findCardsInHand(hand: Card[], input: string): Card[] {
  const clean = input.replace(/10/g, 'T').toUpperCase();
  const needed: Map<Rank, number> = new Map();
  for (const ch of clean) {
    const r = rankFromChar(ch);
    needed.set(r, (needed.get(r) ?? 0) + 1);
  }

  const available = new Map<Rank, number>();
  for (const c of hand) {
    available.set(c.rank, (available.get(c.rank) ?? 0) + 1);
  }
  for (const [r, count] of needed) {
    if ((available.get(r) ?? 0) < count) {
      throw new Error(`你的 ${rankToString(r)} 不够`);
    }
  }

  const result: Card[] = [];
  const copy = [...hand];
  for (const [r, count] of needed) {
    let found = 0;
    for (let i = copy.length - 1; i >= 0 && found < count; i--) {
      if (copy[i].rank === r) {
        result.push(copy.splice(i, 1)[0]);
        found++;
      }
    }
  }
  return result;
}
```

- [ ] **Step 5: Create hand-impl.ts (internal helpers)**

```typescript
// packages/shared/src/card/hand-impl.ts
import { Card } from './card';

export function removeCards(hand: Card[], toRemove: Card[]): Card[] {
  const removeSet = new Set(toRemove.map(c => `${c.suit}-${c.rank}`));
  return hand.filter(c => !removeSet.has(`${c.suit}-${c.rank}`));
}
```

- [ ] **Step 6: Create card.test.ts**

```typescript
// packages/shared/src/card/card.test.ts
import { describe, it, expect } from 'vitest';
import {
  Suit, Rank, CardColor,
  createDeck, shuffleDeck,
  rankFromChar, rankToString, suitSymbol,
} from './card';

describe('rankFromChar', () => {
  const validPairs: [string, Rank][] = [
    ['3', Rank.Rank3], ['4', Rank.Rank4], ['5', Rank.Rank5],
    ['6', Rank.Rank6], ['7', Rank.Rank7], ['8', Rank.Rank8],
    ['9', Rank.Rank9], ['T', Rank.Rank10], ['J', Rank.RankJ],
    ['Q', Rank.RankQ], ['K', Rank.RankK], ['A', Rank.RankA],
    ['2', Rank.Rank2], ['B', Rank.RankBlackJoker], ['R', Rank.RankRedJoker],
  ];
  for (const [ch, expected] of validPairs) {
    it(`'${ch}' → ${expected}`, () => {
      expect(rankFromChar(ch)).toBe(expected);
    });
  }
  it('rejects invalid chars', () => {
    expect(() => rankFromChar('1')).toThrow();
    expect(() => rankFromChar('x')).toThrow();
    expect(() => rankFromChar(' ')).toThrow();
  });
});

describe('rankToString', () => {
  it('maps special ranks correctly', () => {
    expect(rankToString(Rank.Rank10)).toBe('10');
    expect(rankToString(Rank.RankBlackJoker)).toBe('B');
    expect(rankToString(Rank.RankRedJoker)).toBe('R');
  });
});

describe('createDeck', () => {
  it('creates 54 cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(54);
  });
  it('no duplicate cards', () => {
    const deck = createDeck();
    const keys = new Set(deck.map(c => `${c.suit}-${c.rank}`));
    expect(keys.size).toBe(54);
  });
  it('contains black and red joker', () => {
    const deck = createDeck();
    const jokers = deck.filter(c => c.suit === Suit.Joker);
    expect(jokers).toHaveLength(2);
    expect(jokers.some(c => c.rank === Rank.RankBlackJoker)).toBe(true);
    expect(jokers.some(c => c.rank === Rank.RankRedJoker)).toBe(true);
  });
});

describe('shuffleDeck', () => {
  it('mutates deck in place', () => {
    const deck = createDeck();
    const id = deck;
    shuffleDeck(deck);
    expect(deck).toBe(id);
    expect(deck).toHaveLength(54);
  });
});
```

- [ ] **Step 7: Create hand.test.ts**

```typescript
// packages/shared/src/card/hand.test.ts
import { describe, it, expect } from 'vitest';
import { createDeck, Rank } from './card';
import { findCardsInHand, RemoveCards } from './hand';

describe('findCardsInHand', () => {
  it('extracts a single card', () => {
    const deck = createDeck();
    const card = deck[0];
    const result = findCardsInHand(deck, card.rank.toString().replace('10','T') === card.rank.toString()
      ? (card.rank <= 9 ? String(card.rank) :
         card.rank === Rank.RankJ ? 'J' :
         card.rank === Rank.RankQ ? 'Q' :
         card.rank === Rank.RankK ? 'K' :
         card.rank === Rank.RankA ? 'A' :
         card.rank === Rank.Rank2 ? '2' :
         card.rank === Rank.RankBlackJoker ? 'B' : 'R')
      : '3');
    expect(result.length).toBe(1);
    expect(result[0].rank).toBe(card.rank);
  });
  it('throws when not enough cards', () => {
    expect(() => findCardsInHand([createDeck()[0]], '333')).toThrow(/不够/);
  });
});

describe('RemoveCards', () => {
  it('removes specified cards', () => {
    const deck = createDeck();
    const first = deck[0];
    const remaining = RemoveCards(deck, [first]);
    expect(remaining).toHaveLength(53);
    expect(remaining).not.toContainEqual(first);
  });
});
```

- [ ] **Step 8: Create src/index.ts**

```typescript
// packages/shared/src/index.ts
export * from './card/card';
export * from './card/hand';
```

- [ ] **Step 9: Create vitest config for shared**

```typescript
// packages/shared/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true },
});
```

- [ ] **Step 10: Run tests and verify**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform
pnpm install
cd packages/shared && pnpm test
```
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): port card and hand logic from Go"
```

---

## Task 3: Shared Rule 包（移植自 Go）

**Files:**
- Create: `packages/shared/src/rule/rule.ts`
- Create: `packages/shared/src/rule/beat.ts`
- Create: `packages/shared/src/rule/autoplay.ts`
- Create: `packages/shared/src/rule/rule.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `Card`, `Rank`, `Suit`, `CardColor` from `./card/card`
- Produces: `HandType`, `ParsedHand`, `HandAnalysis`, `ParseHand`, `CanBeat`, `CanBeatWithHand`, `FindSmallestBeatingCards`

- [ ] **Step 1: Create rule.ts**

```typescript
// packages/shared/src/rule/rule.ts
import { Card, Rank } from '../card/card';

export enum HandType {
  Invalid = 0,
  Single,
  Pair,
  Trio,
  TrioWithSingle,
  TrioWithPair,
  Straight,
  PairStraight,
  Plane,
  PlaneWithSingles,
  PlaneWithPairs,
  Bomb,
  FourWithTwo,
  FourWithTwoPairs,
  Rocket,
}

export const handTypeNames: Record<HandType, string> = {
  [HandType.Single]: '单张',
  [HandType.Pair]: '对子',
  [HandType.Trio]: '三张',
  [HandType.TrioWithSingle]: '三带一',
  [HandType.TrioWithPair]: '三带二',
  [HandType.Straight]: '顺子',
  [HandType.PairStraight]: '连对',
  [HandType.Plane]: '飞机',
  [HandType.PlaneWithSingles]: '飞机带单',
  [HandType.PlaneWithPairs]: '飞机带对',
  [HandType.Bomb]: '炸弹',
  [HandType.FourWithTwo]: '四带二',
  [HandType.FourWithTwoPairs]: '四带两对',
  [HandType.Rocket]: '王炸',
  [HandType.Invalid]: '无效',
};

export interface ParsedHand {
  type: HandType;
  keyRank: Rank;
  length: number;
  cards: Card[];
}

export interface HandAnalysis {
  counts: Map<Rank, number>;
  fours: Rank[];
  trios: Rank[];
  pairs: Rank[];
  ones: Rank[];
}

export function isContinuous(ranks: Rank[]): boolean {
  if (ranks.length === 0) return false;
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] >= Rank.Rank2) return false;
    if (i > 0 && ranks[i - 1] + 1 !== ranks[i]) return false;
  }
  return true;
}

export function analyzeCards(cards: Card[]): HandAnalysis {
  const counts = new Map<Rank, number>();
  for (const c of cards) {
    counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  }
  const fours: Rank[] = [], trios: Rank[] = [], pairs: Rank[] = [], ones: Rank[] = [];
  for (const [r, count] of counts) {
    if (count === 4) fours.push(r);
    else if (count === 3) trios.push(r);
    else if (count === 2) pairs.push(r);
    else ones.push(r);
  }
  fours.sort((a, b) => a - b);
  trios.sort((a, b) => a - b);
  pairs.sort((a, b) => a - b);
  ones.sort((a, b) => a - b);
  return { counts, fours, trios, pairs, ones };
}

export function parseHand(cards: Card[]): ParsedHand {
  if (cards.length === 0) throw new Error('不能出空牌');
  const a = analyzeCards(cards);

  // Rocket
  if (cards.length === 2 && a.counts.get(Rank.RankBlackJoker) === 1 && a.counts.get(Rank.RankRedJoker) === 1) {
    return { type: HandType.Rocket, keyRank: Rank.RankRedJoker, length: 0, cards };
  }
  // Bomb
  if (a.fours.length === 1 && cards.length === 4) {
    return { type: HandType.Bomb, keyRank: a.fours[0], length: 0, cards };
  }
  // FourWithTwo
  if (a.fours.length === 1) {
    if (cards.length === 6 && (a.ones.length === 2 || a.pairs.length === 1)) {
      return { type: HandType.FourWithTwo, keyRank: a.fours[0], length: 0, cards };
    }
    if (cards.length === 8 && a.pairs.length === 2) {
      return { type: HandType.FourWithTwoPairs, keyRank: a.fours[0], length: 0, cards };
    }
  }
  // TrioWithKickers
  if (a.trios.length === 1) {
    if (cards.length === 4 && a.ones.length === 1) {
      return { type: HandType.TrioWithSingle, keyRank: a.trios[0], length: 0, cards };
    }
    if (cards.length === 5 && a.pairs.length === 1) {
      return { type: HandType.TrioWithPair, keyRank: a.trios[0], length: 0, cards };
    }
  }
  // Plane
  if (isContinuous(a.trios) && a.trios.length >= 2) {
    const planeLen = a.trios.length;
    if (planeLen * 3 === cards.length) {
      return { type: HandType.Plane, keyRank: a.trios[0], length: planeLen, cards };
    }
    if (planeLen * 4 === cards.length && a.ones.length === planeLen) {
      return { type: HandType.PlaneWithSingles, keyRank: a.trios[0], length: planeLen, cards };
    }
    if (planeLen * 5 === cards.length && a.pairs.length === planeLen) {
      return { type: HandType.PlaneWithPairs, keyRank: a.trios[0], length: planeLen, cards };
    }
  }
  // Straight
  if (isContinuous(a.ones) && a.ones.length === cards.length && cards.length >= 5) {
    return { type: HandType.Straight, keyRank: a.ones[0], length: cards.length, cards };
  }
  // PairStraight
  if (isContinuous(a.pairs) && a.pairs.length * 2 === cards.length && a.pairs.length >= 3) {
    return { type: HandType.PairStraight, keyRank: a.pairs[0], length: a.pairs.length, cards };
  }
  // Simple
  if (a.counts.size === 1) {
    const r = [...a.counts.keys()][0];
    if (cards.length === 1) return { type: HandType.Single, keyRank: r, length: 0, cards };
    if (cards.length === 2) return { type: HandType.Pair, keyRank: r, length: 0, cards };
    if (cards.length === 3) return { type: HandType.Trio, keyRank: r, length: 0, cards };
  }
  throw new Error(`不支持的牌型: ${cards.map(c => c.rank).join(',')}`);
}

export function canBeat(newHand: ParsedHand, lastHand: ParsedHand): boolean {
  if (newHand.type === HandType.Rocket) return true;
  if (lastHand.type === HandType.Rocket) return false;
  if (newHand.type === HandType.Bomb && lastHand.type !== HandType.Bomb) return true;
  if (newHand.type !== lastHand.type) return false;
  const lenTypes = [HandType.Straight, HandType.PairStraight, HandType.Plane, HandType.PlaneWithSingles, HandType.PlaneWithPairs];
  if (lenTypes.includes(newHand.type) && newHand.length !== lastHand.length) return false;
  return newHand.keyRank > lastHand.keyRank;
}
```

- [ ] **Step 2: Create beat.ts**

```typescript
// packages/shared/src/rule/beat.ts
import { Card, Rank } from '../card/card';
import { HandAnalysis, HandType, ParsedHand, analyzeCards, parseHand } from './rule';

export function canBeatWithHand(playerHand: Card[], opponentHand: ParsedHand): boolean {
  if (opponentHand.type === HandType.Invalid) return true;
  const a = analyzeCards(playerHand);
  if (a.counts.get(Rank.RankBlackJoker) === 1 && a.counts.get(Rank.RankRedJoker) === 1) return true;
  for (const r of a.fours) {
    const bomb = parseHand([{ suit: 0 as any, rank: r, color: 0 as any }, { suit: 0 as any, rank: r, color: 0 as any }, { suit: 0 as any, rank: r, color: 0 as any }, { suit: 0 as any, rank: r, color: 0 as any }]);
    if (canBeat(bomb, opponentHand)) return true;
  }
  if (opponentHand.type === HandType.Bomb || opponentHand.type === HandType.Rocket) return false;
  // delegate to specific type checkers via parseHand
  try {
    const myBest = parseHand(playerHand);
    return canBeat(myBest, opponentHand);
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Create autoplay.ts**

```typescript
// packages/shared/src/rule/autoplay.ts
import { Card, Rank } from '../card/card';
import { HandAnalysis, HandType, ParsedHand, analyzeCards } from './rule';

export function findSmallestBeatingCards(playerHand: Card[], opponentHand: ParsedHand): Card[] | null {
  if (opponentHand.type === HandType.Invalid) {
    if (playerHand.length === 0) return null;
    const sorted = [...playerHand].sort((a, b) => a.rank - b.rank);
    return [sorted[sorted.length - 1]];
  }
  const a = analyzeCards(playerHand);

  // Same type
  const result = findSameTypeBeat(playerHand, a, opponentHand);
  if (result) return result;

  // Bomb
  for (const r of a.fours) {
    if (opponentHand.type !== HandType.Bomb || r > opponentHand.keyRank) {
      return findCardsWithRank(playerHand, r, 4);
    }
  }

  // Rocket
  if (a.counts.get(Rank.RankBlackJoker) === 1 && a.counts.get(Rank.RankRedJoker) === 1
      && opponentHand.type !== HandType.Rocket) {
    return [
      playerHand.find(c => c.rank === Rank.RankBlackJoker)!,
      playerHand.find(c => c.rank === Rank.RankRedJoker)!,
    ];
  }
  return null;
}

function findSameTypeBeat(playerHand: Card[], a: HandAnalysis, opp: ParsedHand): Card[] | null {
  switch (opp.type) {
    case HandType.Single:
      return findFirstBeating(playerHand, [a.ones, a.pairs, a.trios, a.fours], opp.keyRank, 1);
    case HandType.Pair:
      return findFirstBeating(playerHand, [a.pairs, a.trios, a.fours], opp.keyRank, 2);
    case HandType.Trio:
      return findTrioBeat(playerHand, a, opp.keyRank, 0);
    case HandType.TrioWithSingle:
      return findTrioBeat(playerHand, a, opp.keyRank, 1);
    case HandType.TrioWithPair:
      return findTrioBeat(playerHand, a, opp.keyRank, 2);
    default:
      return null;
  }
}

function findFirstBeating(hand: Card[], rankLists: Rank[][][], keyRank: Rank, count: number): Card[] | null {
  for (const list of rankLists) {
    for (const ranks of list) {
      for (const r of ranks) {
        if (r > keyRank) return findCardsWithRank(hand, r, count);
      }
    }
  }
  return null;
}

function findTrioBeat(hand: Card[], a: HandAnalysis, keyRank: Rank, kickerType: number): Card[] | null {
  for (const r of [...a.trios, ...a.fours]) {
    if (r > keyRank) {
      const result = findCardsWithRank(hand, r, 3);
      if (kickerType === 0) return result;
      const kickers = findSmallestKickers(hand, a, r, kickerType);
      if (kickers) return [...result, ...kickers];
    }
  }
  return null;
}

function findSmallestKickers(hand: Card[], a: HandAnalysis, excludeRank: Rank, kickerType: number): Card[] | null {
  const needed = kickerType === 1 ? 1 : 2;
  const sources = kickerType === 1
    ? ([a.ones, a.pairs] as Rank[][])
    : ([a.pairs, a.trios, a.fours] as Rank[][]);
  const perRank = kickerType === 1 ? 1 : 2;
  const result: Card[] = [];
  for (const list of sources) {
    for (const r of list) {
      if (r !== excludeRank) {
        const cards = findCardsWithRank(hand, r, perRank);
        result.push(...cards);
        if (result.length >= needed) return result.slice(0, needed);
      }
    }
  }
  return result.length > 0 ? result : null;
}

function findCardsWithRank(hand: Card[], rank: Rank, count: number): Card[] {
  const result: Card[] = [];
  for (const c of hand) {
    if (c.rank === rank) {
      result.push(c);
      if (result.length >= count) return result;
    }
  }
  return result;
}
```

- [ ] **Step 4: Create rule.test.ts**

```typescript
// packages/shared/src/rule/rule.test.ts
import { describe, it, expect } from 'vitest';
import { Suit, Rank, CardColor, createDeck } from '../card/card';
import { HandType, parseHand, canBeat, isContinuous, analyzeCards } from './rule';

function makeCard(rank: Rank): any {
  return { suit: Suit.Spade, rank, color: CardColor.Black };
}

function makeCards(...ranks: Rank[]) {
  return ranks.map(r => makeCard(r));
}

describe('isContinuous', () => {
  it('valid 5-card straight', () => {
    expect(isContinuous([Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7])).toBe(true);
  });
  it('rejects ranks >= 2', () => {
    expect(isContinuous([Rank.RankA, Rank.Rank2])).toBe(false);
  });
  it('rejects non-continuous', () => {
    expect(isContinuous([Rank.Rank3, Rank.Rank4, Rank.Rank6])).toBe(false);
  });
  it('empty returns false', () => {
    expect(isContinuous([])).toBe(false);
  });
  it('single rank is continuous', () => {
    expect(isContinuous([Rank.Rank5])).toBe(true);
  });
});

describe('parseHand - simple types', () => {
  it('single', () => {
    const result = parseHand([makeCard(Rank.Rank7)]);
    expect(result.type).toBe(HandType.Single);
    expect(result.keyRank).toBe(Rank.Rank7);
  });
  it('pair', () => {
    const result = parseHand([makeCard(Rank.RankQ), makeCard(Rank.RankQ)]);
    expect(result.type).toBe(HandType.Pair);
    expect(result.keyRank).toBe(Rank.RankQ);
  });
  it('trio', () => {
    const result = parseHand([makeCard(Rank.Rank5), makeCard(Rank.Rank5), makeCard(Rank.Rank5)]);
    expect(result.type).toBe(HandType.Trio);
  });
  it('bomb', () => {
    const result = parseHand([makeCard(Rank.Rank10), makeCard(Rank.Rank10), makeCard(Rank.Rank10), makeCard(Rank.Rank10)]);
    expect(result.type).toBe(HandType.Bomb);
    expect(result.keyRank).toBe(Rank.Rank10);
  });
  it('rocket', () => {
    const result = parseHand([makeCard(Rank.RankBlackJoker), makeCard(Rank.RankRedJoker)]);
    expect(result.type).toBe(HandType.Rocket);
  });
});

describe('parseHand - complex types', () => {
  it('straight 5 cards', () => {
    const cards = makeCards(Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7);
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.Straight);
    expect(result.length).toBe(5);
  });
  it('pair straight 3 pairs', () => {
    const cards = [
      makeCard(Rank.Rank5), makeCard(Rank.Rank5),
      makeCard(Rank.Rank6), makeCard(Rank.Rank6),
      makeCard(Rank.Rank7), makeCard(Rank.Rank7),
    ];
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.PairStraight);
    expect(result.length).toBe(3);
  });
  it('trio with single', () => {
    const cards = [makeCard(Rank.Rank8), makeCard(Rank.Rank8), makeCard(Rank.Rank8), makeCard(Rank.Rank3)];
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.TrioWithSingle);
  });
  it('trio with pair', () => {
    const cards = [makeCard(Rank.Rank9), makeCard(Rank.Rank9), makeCard(Rank.Rank9), makeCard(Rank.Rank4), makeCard(Rank.Rank4)];
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.TrioWithPair);
  });
});

describe('canBeat', () => {
  it('rocket beats everything', () => {
    const rocket = parseHand([makeCard(Rank.RankBlackJoker), makeCard(Rank.RankRedJoker)]);
    const bomb = parseHand([makeCards(Rank.Rank10, Rank.Rank10, Rank.Rank10, Rank.Rank10)]);
    expect(canBeat(rocket, bomb)).toBe(true);
  });
  it('bomb beats non-bomb', () => {
    const bomb = parseHand([makeCards(Rank.RankK, Rank.RankK, Rank.RankK, Rank.RankK)]);
    const trio = parseHand([makeCards(Rank.Rank5, Rank.Rank5, Rank.Rank5)]);
    expect(canBeat(bomb, trio)).toBe(true);
  });
  it('same type higher rank wins', () => {
    const high = parseHand([makeCard(Rank.RankA)]);
    const low = parseHand([makeCard(Rank.Rank7)]);
    expect(canBeat(high, low)).toBe(true);
    expect(canBeat(low, high)).toBe(false);
  });
  it('different types lose (except bomb)', () => {
    const pair = parseHand([makeCard(Rank.Rank5), makeCard(Rank.Rank5)]);
    const single = parseHand([makeCard(Rank.RankA)]);
    expect(canBeat(single, pair)).toBe(false);
  });
});

describe('analyzeCards', () => {
  it('correctly categorizes a mixed hand', () => {
    const cards = [
      makeCard(Rank.Rank3),
      makeCard(Rank.Rank4), makeCard(Rank.Rank4),
      makeCard(Rank.Rank5), makeCard(Rank.Rank5), makeCard(Rank.Rank5),
      makeCard(Rank.Rank6), makeCard(Rank.Rank6), makeCard(Rank.Rank6), makeCard(Rank.Rank6),
      makeCard(Rank.RankJ),
    ];
    const a = analyzeCards(cards);
    expect(a.fours).toEqual([Rank.Rank6]);
    expect(a.trios).toEqual([Rank.Rank5]);
    expect(a.pairs).toEqual([Rank.Rank4]);
    expect(a.ones).toEqual([Rank.Rank3, Rank.RankJ]);
  });
});
```

- [ ] **Step 5: Update index.ts**

```typescript
// packages/shared/src/index.ts
export * from './card/card';
export * from './card/hand';
export * from './rule/rule';
export * from './rule/beat';
export * from './rule/autoplay';
```

- [ ] **Step 6: Run tests**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform/packages/shared && pnpm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/rule/
git commit -m "feat(shared): port rule engine from Go (HandType, ParseHand, CanBeat, Autoplay)"
```

---

## Task 4: User Service

**Files:**
- Create: `packages/user-service/package.json`
- Create: `packages/user-service/tsconfig.json`
- Create: `packages/user-service/src/main.ts`
- Create: `packages/user-service/src/app.module.ts`
- Create: `packages/user-service/src/users/users.module.ts`
- Create: `packages/user-service/src/users/users.controller.ts`
- Create: `packages/user-service/src/users/users.service.ts`
- Create: `packages/user-service/src/auth/auth.module.ts`
- Create: `packages/user-service/src/auth/auth.service.ts`
- Create: `packages/user-service/src/auth/jwt.strategy.ts`
- Create: `packages/user-service/src/users/users.entity.ts`
- Create: `packages/user-service/src/users/users.repository.ts`
- Create: `packages/user-service/src/users/users.dto.ts`
- Create: `packages/user-service/test/app.e2e.ts`
- Create: `packages/user-service/vitest.config.ts`

**Interfaces:**
- Consumes: `@fight-the-landlord/shared` (not used directly, but available)
- Produces: `POST /auth/login`, `POST /auth/register`, `GET /users/me`, JWT tokens

- [ ] **Step 1: Create package.json**

```json
// packages/user-service/package.json
{
  "name": "@fight-the-landlord/user-service",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@fight-the-landlord/shared": "workspace:*",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/passport": "^10.0.0",
    "@nestjs/typeorm": "^10.0.0",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.1",
    "typeorm": "^0.3.20",
    "bcrypt": "^5.1.1",
    "class-validator": "^0.14.1",
    "class-transformer": "^0.5.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/testing": "^10.4.0",
    "vitest": "^2.1.0",
    "supertest": "^7.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
// packages/user-service/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "CommonJS",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"],
  "nest": {
    "buildOptions": {
      "outDir": "dist"
    }
  }
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
// packages/user-service/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, environment: 'node' },
});
```

- [ ] **Step 4: Create src/main.ts**

```typescript
// packages/user-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(3001);
  console.log('User Service running on port 3001');
}
bootstrap();
```

- [ ] **Step 5: Create src/app.module.ts**

```typescript
// packages/user-service/src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '3306'),
      username: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? 'root',
      database: process.env.DB_NAME ?? 'fight_the_landlord',
      autoLoadEntities: true,
      synchronize: true,
    }),
    UsersModule,
    AuthModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 6: Create src/users/users.entity.ts**

```typescript
// packages/user-service/src/users/users.entity.ts
import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity('users')
export class UserEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ unique: true, length: 20 })
  phone: string;

  @Column({ length: 255 })
  passwordHash: string;

  @Column({ length: 50, nullable: true })
  nickname: string | null;

  @Column({ length: 255, nullable: true })
  avatar: string | null;

  @Column({ type: 'enum', enum: ['active', 'banned'], default: 'active' })
  status: 'active' | 'banned';

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 7: Create src/users/users.dto.ts**

```typescript
// packages/user-service/src/users/users.dto.ts
import { IsString, IsOptional, IsEnum, MinLength, IsUUID } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(11)
  phone: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString()
  nickname?: string;
}

export class LoginDto {
  @IsString()
  phone: string;

  @IsString()
  password: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  nickname?: string;

  @IsOptional()
  @IsString()
  avatar?: string;
}
```

- [ ] **Step 8: Create src/users/users.repository.ts**

```typescript
// packages/user-service/src/users/users.repository.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from './users.entity';

@Injectable()
export class UsersRepository {
  constructor(
    @InjectRepository(UserEntity)
    private readonly repo: Repository<UserEntity>,
  ) {}

  async findByPhone(phone: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ phone });
  }

  async findById(id: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ id });
  }

  async create(data: Partial<UserEntity>): Promise<UserEntity> {
    const user = this.repo.create(data);
    return this.repo.save(user);
  }

  async update(id: string, data: Partial<UserEntity>): Promise<void> {
    await this.repo.update(id, data);
  }
}
```

- [ ] **Step 9: Create src/users/users.service.ts**

```typescript
// packages/user-service/src/users/users.service.ts
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { UsersRepository } from './users.repository';
import { RegisterDto, LoginDto, UpdateProfileDto } from './users.dto';

@Injectable()
export class UsersService {
  private readonly saltRounds = 10;

  constructor(private readonly repo: UsersRepository) {}

  async register(dto: RegisterDto): Promise<{ id: string; phone: string; nickname: string | null }> {
    const existing = await this.repo.findByPhone(dto.phone);
    if (existing) throw new ConflictException('手机号已注册');
    const hash = await bcrypt.hash(dto.password, this.saltRounds);
    const user = await this.repo.create({
      id: uuidv4(),
      phone: dto.phone,
      passwordHash: hash,
      nickname: dto.nickname ?? null,
      status: 'active' as const,
    });
    return { id: user.id, phone: user.phone, nickname: user.nickname };
  }

  async login(dto: LoginDto): Promise<{ id: string; phone: string; nickname: string | null; token: string }> {
    const user = await this.repo.findByPhone(dto.phone);
    if (!user) throw new NotFoundException('用户不存在');
    if (user.status === 'banned') throw new NotFoundException('用户已被封禁');
    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new NotFoundException('密码错误');
    const token = this.generateToken(user);
    return { id: user.id, phone: user.phone, nickname: user.nickname, token };
  }

  async getMe(userId: string): Promise<{ id: string; phone: string; nickname: string | null; status: string }> {
    const user = await this.repo.findById(userId);
    if (!user) throw new NotFoundException('用户不存在');
    return { id: user.id, phone: user.phone, nickname: user.nickname, status: user.status };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<void> {
    await this.repo.update(userId, {
      ...(dto.nickname !== undefined && { nickname: dto.nickname }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
    });
  }

  private generateToken(user: { id: string; phone: string }): string {
    // In real app, use @nestjs/jwt. Here use a simple approach for scaffolding.
    const payload = { sub: user.id, phone: user.phone };
    // Placeholder: will be replaced with proper JWT in Task 9
    return JSON.stringify(payload);
  }
}
```

- [ ] **Step 10: Create src/users/users.controller.ts**

```typescript
// packages/user-service/src/users/users.controller.ts
import { Controller, Get, Post, Put, Body, Req, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { RegisterDto, LoginDto, UpdateProfileDto } from './users.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.usersService.register(dto);
  }

  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.usersService.login(dto);
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@Req() req: { user: { sub: string } }) {
    return this.usersService.getMe(req.user.sub);
  }

  @Put('me')
  async updateProfile(@Req() req: { user: { sub: string } }, @Body() dto: UpdateProfileDto) {
    await this.usersService.updateProfile(req.user.sub, dto);
    return { ok: true };
  }
}
```

- [ ] **Step 11: Create user module files**

```typescript
// packages/user-service/src/users/users.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './users.entity';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { AuthController, UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  controllers: [AuthController, UsersController],
  providers: [UsersRepository, UsersService],
  exports: [UsersRepository, UsersService],
})
export class UsersModule {}
```

```typescript
// packages/user-service/src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [],
  exports: [],
})
export class AuthModule {}
```

- [ ] **Step 12: Create e2e test**

```typescript
// packages/user-service/test/app.e2e.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../src/users/users.module';
import { UserEntity } from '../src/users/users.entity';

describe('User Service E2E', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          synchronize: true,
          entities: [UserEntity],
        }),
        UsersModule,
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/register', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ phone: '13800000001', password: 'password123', nickname: 'TestUser' })
      .expect(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.phone).toBe('13800000001');
  });

  it('POST /auth/login', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: '13800000001', password: 'password123' })
      .expect(201);
    expect(res.body).toHaveProperty('token');
  });

  it('POST /auth/register duplicate phone fails', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ phone: '13800000001', password: 'password123' })
      .expect(409);
  });
});
```

- [ ] **Step 13: Add uuid dependency**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform/packages/user-service
pnpm add uuid
pnpm add -D @types/uuid
```

- [ ] **Step 14: Run tests**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform/packages/user-service && pnpm test
```
Expected: 3 tests pass.

- [ ] **Step 15: Commit**

```bash
git add packages/user-service/
git commit -m "feat(user-service): add user registration, login, and profile endpoints"
```

---

## Task 5: Game Service（空框架）

**Files:**
- Create: `packages/game-service/package.json`
- Create: `packages/game-service/tsconfig.json`
- Create: `packages/game-service/src/main.ts`
- Create: `packages/game-service/src/app.module.ts`
- Create: `packages/game-service/src/health/health.controller.ts`

**Interfaces:**
- Consumes: none
- Produces: `GET /health` endpoint, TCP RPC ports for Room Service communication

- [ ] **Step 1: Create package.json**

```json
// packages/game-service/package.json
{
  "name": "@fight-the-landlord/game-service",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@fight-the-landlord/shared": "workspace:*",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/microservices": "^10.4.0",
    "class-validator": "^0.14.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/testing": "^10.4.0",
    "vitest": "^2.1.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
// packages/game-service/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "CommonJS",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
// packages/game-service/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, environment: 'node' } });
```

- [ ] **Step 4: Create src/main.ts**

```typescript
// packages/game-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = parseInt(process.env.PORT ?? '3003');
  await app.listen(port);
  console.log(`Game Service running on port ${port}`);
}
bootstrap();
```

- [ ] **Step 5: Create src/app.module.ts**

```typescript
// packages/game-service/src/app.module.ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  imports: [],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 6: Create src/health/health.controller.ts**

```typescript
// packages/game-service/src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'game-service' };
  }
}
```

- [ ] **Step 7: Run dev server test**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform
pnpm --filter @fight-the-landlord/game-service build
```
Expected: no build errors.

- [ ] **Step 8: Commit**

```bash
git add packages/game-service/
git commit -m "feat(game-service): scaffold empty game service with health check"
```

---

## Task 6: Room Service（基础框架）

**Files:**
- Create: `packages/room-service/package.json`
- Create: `packages/room-service/tsconfig.json`
- Create: `packages/room-service/src/main.ts`
- Create: `packages/room-service/src/app.module.ts`
- Create: `packages/room-service/src/rooms/rooms.module.ts`
- Create: `packages/room-service/src/rooms/rooms.controller.ts`
- Create: `packages/room-service/src/rooms/rooms.service.ts`
- Create: `packages/room-service/src/rooms/rooms.dto.ts`
- Create: `packages/room-service/src/gateway/ws.gateway.ts`
- Create: `packages/room-service/src/gateway/ws.module.ts`
- Create: `packages/room-service/test/rooms.e2e.ts`
- Create: `packages/room-service/vitest.config.ts`

**Interfaces:**
- Consumes: `@fight-the-landlord/shared` (for card/rule types used in room state)
- Produces: `GET /rooms`, `POST /rooms`, `POST /rooms/:code/join`, `GET /health`

- [ ] **Step 1: Create package.json**

```json
// packages/room-service/package.json
{
  "name": "@fight-the-landlord/room-service",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@fight-the-landlord/shared": "workspace:*",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/websockets": "^10.4.0",
    "@nestjs/microservices": "^10.4.0",
    "ioredis": "^5.4.0",
    "class-validator": "^0.14.1",
    "socket.io": "^4.7.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/testing": "^10.4.0",
    "vitest": "^2.1.0",
    "supertest": "^7.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
// packages/room-service/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "CommonJS",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
// packages/room-service/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, environment: 'node' } });
```

- [ ] **Step 4: Create src/main.ts**

```typescript
// packages/room-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = parseInt(process.env.PORT ?? '3002');
  await app.listen(port);
  console.log(`Room Service running on port ${port}`);
}
bootstrap();
```

- [ ] **Step 5: Create src/app.module.ts**

```typescript
// packages/room-service/src/app.module.ts
import { Module } from '@nestjs/common';
import { RoomsModule } from './rooms/rooms.module';
import { WsModule } from './gateway/ws.module';

@Module({
  imports: [RoomsModule, WsModule],
})
export class AppModule {}
```

- [ ] **Step 6: Create src/rooms/rooms.dto.ts**

```typescript
// packages/room-service/src/rooms/rooms.dto.ts
import { IsOptional, IsString, IsEnum } from 'class-validator';

export enum RoomMode {
  FRIEND = 'friend',
  RANDOM = 'random',
  SCORE = 'score',
}

export class CreateRoomDto {
  @IsEnum(RoomMode)
  mode: RoomMode;

  @IsOptional()
  @IsString()
  roomCode?: string;
}

export class JoinRoomDto {
  @IsString()
  code: string;

  @IsOptional()
  @IsString()
  userId?: string;
}
```

- [ ] **Step 7: Create src/rooms/rooms.service.ts**

```typescript
// packages/room-service/src/rooms/rooms.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';

export interface Room {
  code: string;
  mode: string;
  players: string[];
  maxPlayers: number;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: Date;
}

const rooms = new Map<string, Room>();

@Injectable()
export class RoomsService {
  async findAll(): Promise<Room[]> {
    return Array.from(rooms.values());
  }

  async create(dto: { mode: string; roomCode?: string }): Promise<Room> {
    const code = dto.roomCode ?? this.generateCode();
    const room: Room = {
      code,
      mode: dto.mode,
      players: [],
      maxPlayers: 3,
      status: 'waiting',
      createdAt: new Date(),
    };
    rooms.set(code, room);
    return room;
  }

  async join(code: string, userId: string): Promise<Room> {
    const room = rooms.get(code);
    if (!room) throw new NotFoundException('房间不存在');
    if (room.players.length >= room.maxPlayers) throw new Error('ROOM_FULL');
    if (room.status !== 'waiting') throw new Error('GAME_ALREADY_STARTING');
    room.players.push(userId);
    return room;
  }

  async findOne(code: string): Promise<Room | null> {
    return rooms.get(code) ?? null;
  }

  private generateCode(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }
}
```

- [ ] **Step 8: Create src/rooms/rooms.controller.ts**

```typescript
// packages/room-service/src/rooms/rooms.controller.ts
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { CreateRoomDto, JoinRoomDto } from './rooms.dto';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Get()
  async findAll() {
    return { rooms: await this.roomsService.findAll() };
  }

  @Post()
  async create(@Body() dto: CreateRoomDto) {
    return this.roomsService.create(dto);
  }

  @Post(':code/join')
  async join(@Param('code') code: string, @Body() dto: JoinRoomDto) {
    return this.roomsService.join(code, dto.userId ?? 'anon');
  }
}
```

- [ ] **Step 9: Create src/rooms/rooms.module.ts**

```typescript
// packages/room-service/src/rooms/rooms.module.ts
import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  controllers: [RoomsController],
  providers: [RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
```

- [ ] **Step 10: Create src/gateway/ws.gateway.ts**

```typescript
// packages/room-service/src/gateway/ws.gateway.ts
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({ cors: true, namespace: '/ws' })
export class WsGateway {
  @WebSocketServer()
  server: Server;

  handleConnection(client: any) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: any) {
    console.log(`Client disconnected: ${client.id}`);
  }
}
```

- [ ] **Step 11: Create src/gateway/ws.module.ts**

```typescript
// packages/room-service/src/gateway/ws.module.ts
import { Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';

@Module({
  providers: [WsGateway],
  exports: [WsGateway],
})
export class WsModule {}
```

- [ ] **Step 12: Create e2e test**

```typescript
// packages/room-service/test/rooms.e2e.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { RoomsModule } from '../src/rooms/rooms.module';
import { RoomsService } from '../src/rooms/rooms.service';

describe('Rooms E2E', () => {
  let app: INestApplication;
  let roomsService: RoomsService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [RoomsModule],
    }).compile();
    app = module.createNestApplication();
    roomsService = module.get<RoomsService>(RoomsService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /rooms creates a room', async () => {
    const res = await request(app.getHttpServer())
      .post('/rooms')
      .send({ mode: 'random' })
      .expect(201);
    expect(res.body).toHaveProperty('code');
    expect(res.body.mode).toBe('random');
    expect(res.body.status).toBe('waiting');
  });

  it('GET /rooms returns list', async () => {
    const res = await request(app.getHttpServer())
      .get('/rooms')
      .expect(200);
    expect(res.body.rooms).toBeDefined();
    expect(Array.isArray(res.body.rooms)).toBe(true);
  });

  it('POST /rooms/:code/join adds player', async () => {
    const room = await roomsService.create({ mode: 'random' });
    const res = await request(app.getHttpServer())
      .post(`/rooms/${room.code}/join`)
      .send({ userId: 'user-1' })
      .expect(201);
    expect(res.body.players).toContain('user-1');
  });

  it('join to non-existent room returns 404', async () => {
    await request(app.getHttpServer())
      .post('/rooms/NONEXIST/join')
      .send({ userId: 'user-1' })
      .expect(404);
  });
});
```

- [ ] **Step 13: Run tests**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform/packages/room-service && pnpm test
```
Expected: 4 tests pass.

- [ ] **Step 14: Commit**

```bash
git add packages/room-service/
git commit -m "feat(room-service): add room CRUD with in-memory storage and WebSocket gateway"
```

---

## Task 7: API Gateway

**Files:**
- Create: `packages/api-gateway/package.json`
- Create: `packages/api-gateway/tsconfig.json`
- Create: `packages/api-gateway/src/main.ts`
- Create: `packages/api-gateway/src/app.module.ts`
- Create: `packages/api-gateway/src/gateway/gateway.controller.ts`
- Create: `packages/api-gateway/src/gateway/proxy.gateway.ts`
- Create: `packages/api-gateway/src/auth/jwt.middleware.ts`

**Interfaces:**
- Consumes: User Service (HTTP), Room Service (HTTP + WebSocket)
- Produces: unified entry point at port 3000, `/ws` proxy, `/api/*` routing

- [ ] **Step 1: Create package.json**

```json
// packages/api-gateway/package.json
{
  "name": "@fight-the-landlord/api-gateway",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@fight-the-landlord/shared": "workspace:*",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/websockets": "^10.4.0",
    "@nestjs/microservices": "^10.4.0",
    "socket.io": "^4.7.0",
    "express": "^4.21.0",
    "http-proxy-middleware": "^3.0.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "vitest": "^2.1.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
// packages/api-gateway/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "CommonJS",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
// packages/api-gateway/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, environment: 'node' } });
```

- [ ] **Step 4: Create src/main.ts**

```typescript
// packages/api-gateway/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  const port = parseInt(process.env.PORT ?? '3000');
  await app.listen(port);
  console.log(`API Gateway running on port ${port}`);
}
bootstrap();
```

- [ ] **Step 5: Create src/app.module.ts**

```typescript
// packages/api-gateway/src/app.module.ts
import { Module } from '@nestjs/common';
import { GatewayController } from './gateway/gateway.controller';
import { ProxyGateway } from './gateway/proxy.gateway';

@Module({
  imports: [],
  controllers: [GatewayController],
  providers: [ProxyGateway],
})
export class AppModule {}
```

- [ ] **Step 6: Create src/gateway/gateway.controller.ts**

```typescript
// packages/api-gateway/src/gateway/gateway.controller.ts
import { Controller, Get, Post, Body, Req, Res } from '@nestjs/common';
import { ProxyGateway } from './proxy.gateway';

@Controller()
export class GatewayController {
  constructor(private readonly proxyGateway: ProxyGateway) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'api-gateway' };
  }

  @Post('auth/login')
  async login(@Body() body: any, @Res() res: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/auth/login', body, res);
  }

  @Post('auth/register')
  async register(@Body() body: any, @Res() res: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/auth/register', body, res);
  }

  @Get('rooms')
  async getRooms(@Res() res: any) {
    return this.proxyGateway.forwardToRoomSvc('GET', '/rooms', null, res);
  }

  @Post('rooms')
  async createRoom(@Body() body: any, @Res() res: any) {
    return this.proxyGateway.forwardToRoomSvc('POST', '/rooms', body, res);
  }

  @Post('rooms/:code/join')
  async joinRoom(@Body() body: any, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToRoomSvc('POST', `/rooms/${req.params.code}/join`, body, res);
  }
}
```

- [ ] **Step 7: Create src/gateway/proxy.gateway.ts**

```typescript
// packages/api-gateway/src/gateway/proxy.gateway.ts
import { Injectable } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as http from 'http';
import * as https from 'https';

@Injectable()
export class ProxyGateway {
  @WebSocketServer()
  server: Server;

  private readonly userSvcUrl = process.env.USER_SERVICE_URL ?? 'http://localhost:3001';
  private readonly roomSvcUrl = process.env.ROOM_SERVICE_URL ?? 'http://localhost:3002';
  private readonly gameSvcUrl = process.env.GAME_SERVICE_URL ?? 'http://localhost:3003';

  handleConnection(client: Socket) {
    console.log(`WebSocket connected: ${client.id}`);
    client.on('message', (raw: any) => {
      let msg: any;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        client.emit('error', { code: 'INVALID_JSON', message: '消息格式错误' });
        return;
      }
      this.routeMessage(client, msg);
    });
  }

  handleDisconnect(client: Socket) {
    console.log(`WebSocket disconnected: ${client.id}`);
  }

  private routeMessage(client: Socket, msg: any) {
    const { type } = msg;
    if (!type) {
      client.emit('error', { code: 'INVALID_TYPE', message: '缺少 type 字段' });
      return;
    }
    const [category] = type.split('.');
    if (category === 'room') {
      this.forwardWsToSvc(client, msg, this.roomSvcUrl);
    } else if (category === 'game') {
      this.forwardWsToSvc(client, msg, this.gameSvcUrl);
    } else if (category === 'auth') {
      this.forwardWsToSvc(client, msg, this.userSvcUrl);
    } else {
      client.emit('error', { code: 'UNKNOWN_TYPE', message: `未知消息类型: ${type}` });
    }
  }

  private forwardWsToSvc(client: Socket, msg: any, svcUrl: string) {
    // Phase 1: echo back with service tag (placeholder for Phase 2 real proxy)
    client.emit('ws_response', {
      type: msg.type,
      seq: msg.seq,
      version: 0,
      payload: { echo: msg.payload, from: new URL(svcUrl).hostname },
    });
  }

  async forwardToUserSvc(method: string, path: string, body: any, res: any) {
    return this.proxyRequest(this.userSvcUrl, method, path, body, res);
  }

  async forwardToRoomSvc(method: string, path: string, body: any, res: any) {
    return this.proxyRequest(this.roomSvcUrl, method, path, body, res);
  }

  private proxyRequest(base: string, method: string, path: string, body: any, res: any) {
    const url = `${base}${path}`;
    const opts: any = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== null && body !== undefined) opts.body = JSON.stringify(body);
    return new Promise((resolve) => {
      const req = (method === 'GET' ? https : http).request(url, opts, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          res.status(response.statusCode ?? 200).type('application/json').send(data);
          resolve(undefined);
        });
      });
      req.on('error', (err) => {
        res.status(503).json({ error: err.message });
        resolve(undefined);
      });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }
}
```

- [ ] **Step 8: Create e2e test**

```typescript
// packages/api-gateway/test/gateway.e2e.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { GatewayController } from '../src/gateway/gateway.controller';
import { ProxyGateway } from '../src/gateway/proxy.gateway';

describe('API Gateway E2E', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [ProxyGateway],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('api-gateway');
  });
});
```

- [ ] **Step 9: Run tests**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform/packages/api-gateway && pnpm test
```
Expected: 1 test passes.

- [ ] **Step 10: Commit**

```bash
git add packages/api-gateway/
git commit -m "feat(api-gateway): add unified gateway with HTTP proxy and WebSocket router"
```

---

## Task 8: DouZero Docker 基础设施

**Files:**
- Create: `douzero/Dockerfile`
- Create: `douzero/docker-compose.douzero.yml`
- Create: `douzero/.env.example`
- Modify: `docker-compose.yml` (add douzero service)

**Interfaces:**
- Consumes: DouZero source code (already at `../douzero/`)
- Produces: `palemoky/fight-the-landlord-douzero` Docker image, exposed on port 2021

- [ ] **Step 1: Create douzero/Dockerfile**

```dockerfile
# platform/douzero/Dockerfile
FROM python:3.11-slim AS builder

WORKDIR /app

RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev

COPY src/ ./src/
COPY server.py .

ARG HF_BASE=https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx/douzero_WP
RUN mkdir -p models && \
    python -c "import urllib.request; base='${HF_BASE}'; [urllib.request.urlretrieve(f'{base}/{p}.onnx', f'models/{p}.onnx') for p in ('landlord','landlord_down','landlord_up')]"

FROM python:3.11-slim

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src
COPY --from=builder /app/server.py /app/server.py
COPY --from=builder /app/models /app/models

ENV DOUZERO_MODELS=/app/models
ENV PORT=2021

EXPOSE 2021

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:2021/health')"

CMD ["/app/.venv/bin/python", "server.py"]
```

- [ ] **Step 2: Copy douzero source files**

```bash
cp -r /mnt/d/Repos/fight-the-landlord/douzero/src /mnt/d/Repos/fight-the-landlord/platform/douzero/
cp /mnt/d/Repos/fight-the-landlord/douzero/server.py /mnt/d/Repos/fight-the-landlord/platform/douzero/
cp /mnt/d/Repos/fight-the-landlord/douzero/pyproject.toml /mnt/d/Repos/fight-the-landlord/platform/douzero/
cp /mnt/d/Repos/fight-the-landlord/douzero/uv.lock /mnt/d/Repos/fight-the-landlord/platform/douzero/
```

- [ ] **Step 3: Create douzero/docker-compose.douzero.yml**

```yaml
# platform/douzero/docker-compose.douzero.yml
services:
  douzero:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: fight-the-landlord-douzero
    restart: unless-stopped
    ports:
      - "2021:2021"
    environment:
      - PORT=2021
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:2021/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

- [ ] **Step 4: Create root docker-compose.yml**

```yaml
# platform/docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    container_name: ftl-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  mysql:
    image: mysql:8.0
    container_name: ftl-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: fight_the_landlord
    ports:
      - "3306:3306"
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-proot"]
      interval: 10s
      timeout: 5s
      retries: 5

  douzero:
    build:
      context: ./douzero
      dockerfile: Dockerfile
    container_name: ftl-douzero
    restart: unless-stopped
    ports:
      - "2021:2021"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:2021/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  mysql-data:
```

- [ ] **Step 5: Verify DouZero Dockerfile**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform/douzero
docker build -t fight-the-landlord-douzero:test . 2>&1 | tail -20
```
Expected: build succeeds (may take several minutes to download models).

- [ ] **Step 6: Commit**

```bash
git add douzero/ docker-compose.yml
git commit -m "feat(douzero): add DouZero Docker infrastructure to platform/"
```

---

## Task 9: 整合测试 — 全服务启动验证

**Files:**
- Modify: `platform/docker-compose.yml` (add service definitions)
- Create: `platform/scripts/dev.sh`

**Interfaces:**
- Consumes: all services from Tasks 2-8
- Produces: end-to-end verification that all services start and respond

- [ ] **Step 1: Update docker-compose.yml with all services**

```yaml
# platform/docker-compose.yml (full)
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    container_name: ftl-redis
    restart: unless-stopped
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  mysql:
    image: mysql:8.0
    container_name: ftl-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: fight_the_landlord
    ports: ["3306:3306"]
    volumes: [mysql-data:/var/lib/mysql]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-proot"]
      interval: 10s
      timeout: 5s
      retries: 5

  douzero:
    build:
      context: ./douzero
      dockerfile: Dockerfile
    container_name: ftl-douzero
    restart: unless-stopped
    ports: ["2021:2021"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:2021/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  user-service:
    build:
      context: .
      dockerfile: Dockerfile.user-service
    container_name: ftl-user-service
    restart: unless-stopped
    ports: ["3001:3001"]
    environment:
      - DB_HOST=mysql
      - DB_PORT=3306
      - DB_USER=root
      - DB_PASSWORD=root
      - DB_NAME=fight_the_landlord
    depends_on:
      mysql:
        condition: service_healthy

  api-gateway:
    build:
      context: .
      dockerfile: Dockerfile.api-gateway
    container_name: ftl-api-gateway
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      - USER_SERVICE_URL=http://user-service:3001
      - ROOM_SERVICE_URL=http://room-service:3002
      - GAME_SERVICE_URL=http://game-service:3003
    depends_on:
      - user-service
      - room-service
      - game-service

volumes:
  mysql-data:
```

- [ ] **Step 2: Create dev.sh script**

```bash
#!/bin/bash
# platform/scripts/dev.sh
set -e
cd "$(dirname "$0")/.."
echo "=== 启动基础设施 ==="
docker compose up -d redis mysql douzero
echo "=== 等待健康检查 ==="
docker compose ps
echo ""
echo "=== 本地开发模式（各服务独立运行）==="
echo "  pnpm --filter @fight-the-landlord/user-service dev"
echo "  pnpm --filter @fight-the-landlord/room-service dev"
echo "  pnpm --filter @fight-the-landlord/game-service dev"
echo "  pnpm --filter @fight-the-landlord/api-gateway dev"
```

- [ ] **Step 3: Make script executable**

```bash
chmod +x /mnt/d/Repos/fight-the-landlord/platform/scripts/dev.sh
```

- [ ] **Step 4: Run all tests across all packages**

```bash
cd /mnt/d/Repos/fight-the-landlord/platform
pnpm test
```
Expected: all tests across shared, user-service, room-service, api-gateway pass.

- [ ] **Step 5: Final commit**

```bash
git add docker-compose.yml scripts/
git commit -m "chore: add docker-compose with all Phase 1 services and dev script"
```

---

## Summary

| Task | Package | Deliverable | Status |
|------|---------|-------------|--------|
| 1 | 根目录 | Turborepo monorepo 脚手架 | pending |
| 2 | shared/card | 扑克牌数据结构与操作（移植 Go） | pending |
| 3 | shared/rule | 出牌规则引擎（移植 Go） | pending |
| 4 | user-service | 注册/登录/用户信息 API | pending |
| 5 | game-service | 空框架 + 健康检查 | pending |
| 6 | room-service | 房间 CRUD + WebSocket 网关 | pending |
| 7 | api-gateway | 统一入口 + HTTP/WS 路由代理 | pending |
| 8 | douzero/ | DouZero Docker 镜像与编排 | pending |
| 9 | 根目录 | 全服务整合测试脚本 | pending |
