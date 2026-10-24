/**
 * 完整 `bidPhase` 夹具的**唯一定义**（R617/R623 同族：本仓忌第二真源。
 * 先例：`helpers/scoring-traces.ts` 的 B1 合流 —— 同一道规则不再有第二种形态）。
 *
 * ## 为什么需要它
 *
 * `playerViewFixture(over)` 对 `bidPhase` 是**整体替换、不合并**（见 `helpers/fake-socket.ts`）
 * ⇒ 任何覆盖都要求调用点给全 7 个键。本 helper 提供完整默认值。
 *
 * **`kind` 的默认值按（可能被覆盖的）`landlordCandidate` 推导**（Task B3 显式化）：
 * 协议③ 的 `kind` 在服务端的**唯一派生依据**就是「本轮有没有人声称」
 * （`packages/shared/src/ddz/bid.ts` 的 `bidKindOf`：`landlordCandidate === -1 ? 'call' : 'rob'`）。
 * 此前 helper 写死 `kind: 'call'`，而若干调用点把 `landlordCandidate` 覆盖成 `≥ 0`
 * ⇒ 夹具里躺着一批**自相矛盾**的值（阶段 kind 说「叫」、计数说「抢」）。界面读 `kind` 之前它无害；
 * B3 起界面**真的读 `kind`** ⇒ 那种矛盾会让正例踩到不一致的夹具。现在：不写 `kind` 就按
 * candidate 推导；显式传来的 `kind` 优先。
 *
 * ## 合流史（B3 评审 Minor 1：消掉分叉）
 *
 * 这份派生规则此前在 **10 个测试文件里逐字复刻了 10 份**（`action-feedback` ·
 * `card-hand-interaction` · `audio` · `table-bid-bottom` · `table-bid-ui` · `table-bid-stage`
 * （那里的副本叫 `fullBidPhase`）· `table-hud` · `table-play-area-window` · `table-play-ui` ·
 * `table-seat-geometry`）。合流时**逐文件核对过默认值差异 = 无**（10 份的六个默认键
 * 逐字相同）⇒ 收拢为这一份；将来某文件若要不同默认值，在**调用点**覆盖，**不得**再分叉第二份副本。
 *
 * ## 两条硬约束（改这个函数前先读）
 *
 * 1. **`kind` 的推导必须写在 `...over` 之后**：推导读的是**被覆盖后的** `landlordCandidate`
 *   （写在前面会把 `landlordCandidate: 1` 这类覆盖推导成 `'call'`）。
 * 2. **显式传 `kind` 优先**：要刻意构造「计数与 `kind` 不一致」的判别力夹具时就这么写，
 *    并在调用点注明（`table-bid-bottom.test.ts` 的 R657 正例/反例就是这么用的）。
 *
 * ## 唯一会分叉的输入（仅理论，全仓 0 处）
 *
 * **显式传 `landlordCandidate: undefined`**（`over` 里带这个键、值是 `undefined`）：
 * 服务端 `bidKindOf` 读到的是 `undefined`，`undefined === -1` 为 **false** ⇒ 会说 `'rob'`；
 * 本 helper 的 `?? -1` 把 `undefined` 当缺失 ⇒ 说 `'call'`。
 * 实测全仓 **0 处**这样写（`Partial<...>` 之下这也不是一个有意义的调用形态）⇒ 仅理论；
 * 真要写时请**显式传 `kind`**，别依赖推导。
 */
import type { PlayerView } from '@fight-the-landlord/protocol';

export function bidPhase(over: Partial<PlayerView['bidPhase']> = {}): PlayerView['bidPhase'] {
  return {
    currentBidder: 0,
    bidMultiplier: 1,
    landlordCandidate: -1,
    grabActions: 0,
    redealCount: 0,
    decisions: [],
    ...over,
    // ⚠️ 必须在 `...over` **之后**：推导读的是被覆盖后的 landlordCandidate。
    kind: over.kind ?? ((over.landlordCandidate ?? -1) === -1 ? 'call' : 'rob'),
  };
}
