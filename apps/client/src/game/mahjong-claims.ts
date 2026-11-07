/**
 * 麻将 claimed 过滤 / 牌河窗口 / claim 来源（纯函数，零依赖）。
 *
 * 规则来源：
 *  - `docs/superpowers/specs/2026-11-07-mahjong-table-redgold-design-v12.md` §1（claimed 过滤数组）
 *    与 §2（claim 交互两层）；
 *  - v13 §4 修正：claim 期间可见数组为 `[3万,5万]`（旧 claimed 的 5 隐藏、当前 claim 的 5 保护），
 *    窗口结束后为 `[3万]`。
 *
 * 这些函数只做展示层投影：不读 store、不造计时器、不修改入参。
 */

import {
  tileType,
  type MahjongMeldView,
  type MahjongPhase,
  type MahjongPlayerView,
  type Tile,
} from '@fight-the-landlord/protocol';
import { meldKey } from './mahjong-keys';

export interface VisibleDiscardsOpts {
  phase: MahjongPhase;
  windowId?: string | null;
  /** 正在渲染的河流所属座位；Board 必传；单测省略时按“全量副露”计数。 */
  seat?: number | null;
  /** claim 来源座：仅该座河流的最后一枚弃牌受保护。 */
  sourceSeat?: number | null;
}

/**
 * claimed 过滤的唯一实现：返回应当隐藏的绝对下标集合。
 * `visibleDiscards` 与 `visibleIndexMap` 共用它，禁止各写一份算法。
 */
function hiddenIndices(
  raw: readonly Tile[],
  melds: readonly (readonly MahjongMeldView[])[],
  opts: VisibleDiscardsOpts,
): Set<number> {
  const seat = opts.seat ?? null;

  const counts = new Map<number, number>();
  for (const list of melds) {
    for (const meld of list) {
      if (meld.fromSeat == null) continue;
      // 给了 seat 时只统计该座自己的副露；省略时全量计数。
      if (seat != null && meld.fromSeat !== seat) continue;
      const first = meld.tiles[0];
      if (!first) continue; // 防御：空 tiles 不隐藏任何弃牌
      const type = tileType(first);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }

  const isClaimWindow =
    opts.phase === 'claim' && opts.windowId?.startsWith('claim:') === true;
  const protectedIndex =
    isClaimWindow &&
    opts.sourceSeat != null &&
    (seat == null || seat === opts.sourceSeat)
      ? raw.length - 1
      : -1;

  const hidden = new Set<number>();
  for (const [type, count] of counts) {
    const candidates: number[] = [];
    // 从后往前 = latest-first；受保护的当前 claim 牌不参与隐藏。
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      if (i === protectedIndex) continue;
      if (tileType(raw[i]) === type) candidates.push(i);
    }
    for (const index of candidates.slice(0, count)) hidden.add(index);
  }

  return hidden;
}

/**
 * 返回某条牌河的可见弃牌（claimed 过滤后的数组）。
 *
 * 算法（v12 §1）：
 *  1. `counts[type]` = 该座（`fromSeat === seat`；`seat` 省略时全量）每张副露的计数，
 *     副露以 `tiles[0]` 的 type 归类；
 *  2. claim 窗口（`claim:` 且来源座匹配）保护 `raw.length - 1`（当前 claim 牌）；
 *  3. 对每个 type，从后往前收集候选（排除受保护位），隐藏前 `count` 张；
 *  4. 按原始顺序返回剩余牌，不修改 `raw` / `melds`。
 *
 * 已知边界（v12 §1）：claim 之后同座又打同 type 时，latest-first 可能藏掉后打的真牌；
 * view 无 claim 顺序字段，记录为已知限制。
 */
export function visibleDiscards(
  raw: readonly Tile[],
  melds: readonly (readonly MahjongMeldView[])[],
  opts: VisibleDiscardsOpts,
): Tile[] {
  const hidden = hiddenIndices(raw, melds, opts);
  return raw.filter((_, index) => !hidden.has(index));
}

/**
 * 绝对索引 → 可见索引（`visibleDiscards` 结果里的下标）。
 *
 * 被 claimed 隐藏或越界（含 `-1` 哨兵）一律映射为 `-1`；其余按可见数组顺序
 * 递增编号。与 `visibleDiscards` 共享同一套隐藏判定，保证两者永不失配。
 */
export function visibleIndexMap(
  raw: readonly Tile[],
  melds: readonly (readonly MahjongMeldView[])[],
  opts: VisibleDiscardsOpts,
): number[] {
  const hidden = hiddenIndices(raw, melds, opts);
  let next = 0;
  return raw.map((_, index) => (hidden.has(index) ? -1 : next++));
}

export interface RiverWindow {
  /** 显示格数（cap 内）。 */
  visible: number;
  /** 超出显示格的张数（格数口径）。 */
  overflow: number;
  /** 窗口在绝对（未过滤）数组中的起点。 */
  windowStart: number;
  /** 窗口内的实际牌数（溢出时 `cap - 1` 张 + 1 个 +N 徽标格，且封顶 23）。 */
  windowCount: number;
  /** 徽标上显示的隐藏张数（= raw − windowCount）。 */
  badgeCount: number;
  /** 窗口内最新一张的下标（窗口相对）。 */
  latestIndex: number;
}

/**
 * 牌河窗口字段（v13 §2）。与布局 v1 的 `riverTopSelf` 口径一致：
 * raw ≤ cap 全显示；溢出时窗口收窄到 `cap - 1` 张并让出 1 格给 `+N` 徽标
 * （默认 cap 24 ⇒ 23 张；cap 更大时仍封顶 23；cap 0 ⇒ 空窗口，徽标显示全部 raw）。
 *
 * 注：生产布局 v2（`mahjong-layout-v2.ts`）自带一份重复的窗口数学（侧河按容量
 * `rows×cols` 分支取 24/23），本函数只作**契约参照**，布局并不调用它。
 */
export function riverWindow(rawCount: number, visibleCap = 24): RiverWindow {
  const raw = Math.max(0, Math.floor(Number(rawCount) || 0));
  const cap = Math.max(0, Math.floor(Number(visibleCap) || 0));
  const visible = Math.min(raw, cap);
  const overflow = raw - visible;
  const windowCount = overflow > 0 ? Math.max(0, Math.min(23, cap - 1)) : visible;
  return {
    visible,
    overflow,
    windowStart: raw - windowCount,
    windowCount,
    badgeCount: raw - windowCount,
    latestIndex: windowCount - 1,
  };
}

export interface ClaimSourceInfo {
  /** 待响应弃牌：claimsForMe 中第一个带 tile 的选项；无则 null */
  tile: Tile | null;
  /** claim: 窗口的来源座（= view.currentPlayer）；rob/其他窗口 null */
  sourceSeat: number | null;
  /** 来源河牌可点击：claim: 窗口 + 有 tile + 我在 activeSeats */
  canClick: boolean;
  /** rob 窗口：当前玩家（杠家）同 type 的最新 peng 的 meldKey；否则 null */
  claimSourceMeldKey: string | null;
}

/**
 * 派生 claim/rob 窗口的“来源”信息。
 *
 * - claim：来源座 = `currentPlayer`，其最后一枚弃牌可点（窗口内 index = latestIndex）；
 * - rob：不描边任何河牌（`sourceSeat`/`canClick` 为 false），胡按钮靠
 *   `claimSourceMeldKey` 高亮杠家的那组碰（同 type 的最新 peng）。
 */
export function claimSource(view: MahjongPlayerView, mySeat: number): ClaimSourceInfo {
  const tile = view.claimsForMe.find((option) => option.tile != null)?.tile ?? null;
  const isClaim = view.windowId?.startsWith('claim:') === true;
  const isRob = view.windowId?.startsWith('rob:') === true;

  const sourceSeat = isClaim ? view.currentPlayer : null;
  const canClick = isClaim && tile !== null && view.activeSeats.includes(mySeat);

  let claimSourceMeldKey: string | null = null;
  if (isRob && tile !== null) {
    const list = view.melds[view.currentPlayer] ?? [];
    // 从末尾扫：同 type 的最新一组碰。
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const meld = list[i];
      if (meld.kind !== 'peng') continue;
      const first = meld.tiles[0];
      if (!first || tileType(first) !== tileType(tile)) continue;
      claimSourceMeldKey = meldKey(view.currentPlayer, meld);
      break;
    }
  }

  return { tile, sourceSeat, canClick, claimSourceMeldKey };
}
