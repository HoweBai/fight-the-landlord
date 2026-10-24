# 托管恢复体验（遮罩 + 自动托管取消清零 + 2s 档）— 实现计划

> **For agentic workers:** 按任务逐条执行；每个任务先测试后实现（TDD），绿后提交。步骤用 `- [ ]` 勾选。

**Goal:** 让被自动托管的玩家能用一块醒目的「取消托管」遮罩恢复操作；手动取消**自动托管**时清零超时计数，并把当前回合重排到加速档（10s）；托管自动出牌默认延时 1.5s→2s。

**Architecture:** 复用现有 `game.trustee` 消息与 `PlayerView.trustees`，不新增协议；服务端在 `applyTrusteeLocked` 里按「是否已达到自动托管阈值」分流两条 off 语义；客户端只在 `.table__me` 内加一个绝对定位遮罩；conformance slice-27 的 C 组随语义迁移。

**Tech Stack:** TypeScript / NestJS / Vitest（fake timers）/ Vue 3 + uni-app / Node 静态测试 / conformance（真栈）。

**上游（契约唯一真源）：** `docs/superpowers/specs/2026-10-22-trustee-recovery-design.md`（两轮对抗审查已通过）。实施中任何与 spec 相抵的发现 ⇒ 停手登记，不擅自改道。

**状态（2026-10-22）：** Tasks 0–7 完成；全量 `turbo run test lint --force` **44/44（0 cached，两轮）**、client 1327 passed / 2 skipped、H5 构建 DONE、`verify:admin` 304 checks；**真栈 `slice-27-idle-trustee` 114/114 通过（≥ baseline 112，37.9s）**；代码审查无 Critical/Important（11 Minor 已处置/登记）。

## Global Constraints

1. **不新增协议消息/字段**；`PlayerView.trustees` 仍是客户端唯一状态来源（哑终端）。
2. **清零只对已达到自动托管阈值（`timeoutCount >= after`）的 manual off**；手动开启的托管取消、reconnect off 均保持 count 不动。
3. 自动托管 manual off 且本人是行动者 ⇒ 计时器重排到 **accel 档**（env 注入态 1000ms），不是 normal。
4. 托管默认档 = `Number(process.env.GAME_TRUSTEE_DELAY_MS) || 2_000`（`||` 非 `??`）。
5. 客户端遮罩只在 `.table__me` 内、`myTrustee && !settlementRevealed && (isBidding || isPlaying)` 时渲染；不新增计时器/组件文件。
6. conformance slice-27 断言条数只增不减：C 组 11→12（+非行动者前置）、D 组 +1 前置、片总 114；baseline floor 112 是下限，不得下调（实际 114 无需回填）。
7. 每个任务：先写失败测试 → 跑红（记录 RED 形态）→ 最小实现 → 跑绿 → **git commit**；提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
8. 只 add 显式路径；不夹带无关重构；不碰 protocol/config-service/admin/compose。
9. 行号以实施时实文复核（本计划行号取证于 2026-10-22 HEAD）。
10. 分支 `dev`；开工前工作树必须干净。

---

## Task 0 — spec + 计划落盘

- [ ] 提交 spec（含 r1/r2 审查记录）与本计划。

**Files:** `docs/superpowers/specs/2026-10-22-trustee-recovery-design.md` · `docs/superpowers/plans/2026-10-22-trustee-recovery.md`

Commit：`docs(spec+plan): 托管恢复体验（遮罩/自动托管取消清零/2s 档）`

---

## Task 1 — shared：`onManualTrusteeOff` 纯函数

**Files**

- Modify: `packages/shared/src/ddz/governance.ts`（头注「四个函数」；`onTrusteeOff` 注释；新增函数）
- Test: `packages/shared/src/ddz/governance.test.ts`

**Interfaces**

- Produces: `onManualTrusteeOff(seat: SeatGovernance): SeatGovernance` ⇒ `{ timeoutCount: 0, trustee: false }`。
- 不变：`onTrusteeOff(seat)` 仍返回 `{ timeoutCount: seat.timeoutCount, trustee: false }`。

**Step 1 — 写失败测试**

先在 `governance.test.ts` 顶部的 import 列表补上 `onManualTrusteeOff`（现有 import 只有 `isLegalTrusteeCombo / onTimeoutOccurred / onTrusteeOff / onTurnConsumed / turnDurationFor`；漏了它 Task 1 永远红）。

在 `onTrusteeOff` 用例附近新增：

```ts
describe('onManualTrusteeOff（C4′：手动取消自动托管）', () => {
  it('清零 count 并解除 trustee', () => {
    expect(onManualTrusteeOff({ timeoutCount: 3, trustee: true })).toEqual({
      timeoutCount: 0,
      trustee: false,
    });
  });

  it('纯函数：未托管输入也返回 0/false', () => {
    expect(onManualTrusteeOff({ timeoutCount: 0, trustee: false })).toEqual({
      timeoutCount: 0,
      trustee: false,
    });
  });

  it('onTrusteeOff 保持只清 trustee（reconnect / 手动开启的托管）', () => {
    expect(onTrusteeOff({ timeoutCount: 3, trustee: true })).toEqual({
      timeoutCount: 3,
      trustee: false,
    });
  });
});
```

- [ ] **Step 2: 跑红** `pnpm exec turbo run test --filter=./packages/shared --force -- governance`
  - 预期：`onManualTrusteeOff is not a function` / import 错误。

**Step 3 — 最小实现**

```ts
/**
 * C4′（手动取消**自动托管**）：解除托管并清零超时计数——「我回来了」的明确信号。
 * ⚠️ 只用于 count ≥ after 的自动托管；手动开启的托管取消仍走 `onTrusteeOff`。
 */
export function onManualTrusteeOff(_seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: 0, trustee: false };
}
```

同步头注：「四个函数」→「五个函数」，函数清单加 C4′；`onTrusteeOff` 注释改为「仅 reconnect / 手动开启的托管」。

- [ ] **Step 4: 跑绿** `pnpm exec turbo run test --filter=./packages/shared --force -- governance`
- [ ] **Step 5: 提交** `feat(shared): 新增 onManualTrusteeOff（C4′）`

---

## Task 2 — game-service：off 分流 + 行动者重排 accel

**Files**

- Modify: `packages/game-service/src/game/game.service.ts`（`applyTrusteeLocked`；注释）
- Test: `packages/game-service/test/trustee.test.ts`

**Interfaces**

- Consumes: `onManualTrusteeOff`（值导入）。
- 行为：
  - `via='manual' && on=false && before.timeoutCount >= d.after` ⇒ `onManualTrusteeOff`；若本人是行动者 ⇒ `rescheduleTurn(room, updated, d.accel)`。
  - `via='manual' && on=false && count < after` ⇒ `onTrusteeOff`；R8②：行动者也不重排。
  - `via='reconnect'` ⇒ 不变（`onTrusteeOff` + count 基线重排）。
  - 其余（`on=true` / `abandon`）不变。

**Step 1 — 改/写失败测试**

1. **改判 C4**（`describe('C4：…')`）：
   - `via='manual'`：**夹具改为非行动者**（`currentPlayer: 0` 或 2，`userId='player-1'`）；count=3、trustee=true ⇒ 期望 `{ timeoutCount: 0, trustee: false }`；deadline 不变；`redisDouble.publish` 恰一次（防误走 no-op——no-op 也回 code 0）。
   - `via='reconnect'`：**保持行动者**（`currentPlayer: 1`）；仍 `{ timeoutCount: 3, trustee: false }`，按 count 基线重排（1000ms）。
2. **改判 C12**：
   - 夹具 count 由 2 改为 3（自动托管态）；manual off 前捕获 `handleBefore = service['timers'].get(room)`；off 后 count=0、trustee=false，本人是行动者 ⇒ deadline = now+1000、`expect(service['timers'].get(room)).not.toBe(handleBefore)`；**从新计时器安装时刻起算**推进 999ms 无自动动作、再 1ms 触发；触发后 count=1、trustee=false。
   - 新增强化用例（手动开启的托管）：count=2、trustee=true、currentPlayer=本人 ⇒ manual off 后 `{2,false}`，deadline/timer 不动；推进 400ms 触发后 count=3、trustee=true。
3. **新增反旁路**：count=2、trustee=false → manual on → manual off ⇒ count 仍 2。
4. **新增阈值序列**：count=2、trustee=false、currentPlayer=本人、deadline now+400 → manual on（收缩到 400）→ 推进 400（超时自动动作，count=3、trustee=true）→ manual off ⇒ `{0,false}`。
5. **新增重连竞态**：count=3、trustee=false ⇒ manual off 为 no-op（version 不变、count 仍 3）。

- [ ] **Step 2: 跑红** `pnpm exec turbo run test --filter=./packages/game-service --force -- trustee`
  - 预期：C4/C12 旧断言与新期望不符；新增用例因无分流/重排而失败。

**Step 3 — 最小实现**

`applyTrusteeLocked`：

```ts
import { onManualTrusteeOff, onTrusteeOff, ... } from '@fight-the-landlord/shared';

const before = this.governanceOf(session.players[idx]);
if (before.trustee === dto.on) return { version: session.version };

const d = this.durations();
/** 已达到自动托管阈值（与 onTimeoutOccurred 的置位条件同源） */
const autoTrusted = before.timeoutCount >= d.after;
```

⚠️ 把 `const d = this.durations()` 提到 `applyTrusteeLocked` **方法作用域**；现行动者分支内还有一处 `const d`（`game.service.ts:414`），删除内层、复用外层——避免块级 shadow 与重复读取。

const updated: GameSession = {
  ...session,
  players: session.players.map((p, i) =>
    i === idx
      ? {
          ...p,
          ...(dto.on
            ? { trustee: true }
            : dto.via === 'manual' && autoTrusted
              ? onManualTrusteeOff(this.governanceOf(p))
              : onTrusteeOff(this.governanceOf(p))),
        }
      : p,
  ),
  version: session.version + 1,
};
```

行动者分支：

```ts
if (actorSeat === idx) {
  if (dto.on) {
    const remaining = Math.max(0, session.turnDeadlineAt - Date.now());
    this.rescheduleTurn(dto.roomCode, updated, Math.min(remaining, d.trustee));
  } else if (dto.via === 'reconnect' && before.trustee) {
    const count = this.governanceOf(updated.players[idx]).timeoutCount;
    this.rescheduleTurn(dto.roomCode, updated, count > 0 ? d.accel : d.normal);
  } else if (dto.via === 'manual' && autoTrusted) {
    // 自动托管取消：给回来的玩家一个可操作的加速档窗口；
    // rescheduleTurn 内部先 clearTimer ⇒ 旧短计时器不会在 2s 后抢先自动出牌。
    this.rescheduleTurn(dto.roomCode, updated, d.accel);
  }
  // manual off（手动开启的托管）⇒ R8②：不重排不重算
}
```

同步注释：
- `:402` 的 off 分支注释改为「autoTrusted ⇒ 清零；否则只清 trustee」。
- `:362-366` 的 R8 说明补第四条（auto manual off ⇒ accel）。
- `:424` 的 R8② 注释标明「仅手动开启的托管」。

- [ ] **Step 4: 跑绿** `pnpm exec turbo run test --filter=./packages/game-service --force -- trustee`
- [ ] **Step 5: 提交** `feat(game-service): 自动托管取消清零并重排 accel（C4′）`

---

## Task 3 — game-service：托管默认档 2000ms

**Files**

- Modify: `packages/game-service/src/game/game.service.ts:742`
- Test: `packages/game-service/test/trustee.test.ts`

**Step 1 — 写失败测试**

```ts
it('默认托管档 = 2000ms（GAME_TRUSTEE_DELAY_MS 未注入）', () => {
  delete process.env.GAME_TRUSTEE_DELAY_MS;
  expect(service['durations']().trustee).toBe(2_000);
});
```

- [ ] **Step 2: 跑红**（当前为 1500）
- [ ] **Step 3: 改默认值** `trustee: Number(process.env.GAME_TRUSTEE_DELAY_MS) || 2_000,`
- [ ] **Step 4: 跑绿** + 跑整个 game-service
- [ ] **Step 5: 提交** `feat(game-service): 托管自动出牌默认延时 1.5s→2s`

---

## Task 4 — 客户端：`.table__me` 托管遮罩

**Files**

- Modify: `apps/client/src/pages/table/table.vue`（模板 + scoped CSS + `.table__me` 注释）
- Test: `apps/client/test/table-trustee.test.ts`

**Step 1 — 写失败测试**

在 `table-trustee.test.ts` 新增 describe「托管遮罩（C4′ 恢复入口）」：

```ts
function mask(wrapper: VueWrapper) {
  return wrapper.find('.table__me .table__trustee-mask');
}

it('playing + trustees[me]=true ⇒ 遮罩在 .table__me 内，含文案与按钮', async () => {
  const { wrapper, socket } = mountTable({ mySeat: 0 });
  socket.push(serverMessage('game.deal', dealingView({ trustees: [true, false, false] }), 1));
  await wrapper.vm.$nextTick();
  expect(mask(wrapper).exists()).toBe(true);
  expect(mask(wrapper).text()).toContain('托管中');
  expect(mask(wrapper).text()).toContain('轮到你时将自动出牌');
  expect(mask(wrapper).find('.table__trustee-cancel').text()).toBe('取消托管');
  expect(wrapper.find('.table__action-bar .table__trustee-mask').exists()).toBe(false);
  expect(wrapper.findAll('.seat')).toHaveLength(4); // 正对照
});

it('bidding + trustees[me]=true ⇒ 遮罩同样显示', async () => {
  const { wrapper, socket } = mountTable({ mySeat: 0 });
  socket.push(
    serverMessage('game.deal', dealingView({ state: 'bidding', trustees: [true, false, false] }), 1),
  );
  await wrapper.vm.$nextTick();
  expect(mask(wrapper).exists()).toBe(true);
  expect(wrapper.find('.table__action-bar .table__trustee-mask').exists()).toBe(false);
});

it('trustees[me]=false / 只在别人座位 ⇒ 无遮罩', async () => {
  // 正对照：.seat 已渲染
});

it('点击取消 ⇒ 发一条 game.trustee{on:false}；ack 后不本地翻转；服务端回 false 才消失', async () => {
  // click → emittedOf length 1 → ack(null,{code:0}) → mask 仍在
  // push state_update trustees[0]=false → mask 消失
});

it('第一下未 ack 时按钮 disabled（busy 闸），绕过 disabled 再派发也不重复发送', async () => {
  // click → expect(btn.attributes('disabled')).toBeDefined()
  // VTU 的 trigger 对 disabled 会跳过 ⇒ 再 dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // 走原生派发直达 handler，验证 send() 的 busy 闸：emittedOf('game.trustee') 仍为 1
});

it('state=ended + trustees[me]=true ⇒ 遮罩不显示', async () => { /* ... */ });

it('playing 视图缺 trustees 字段 ⇒ 无遮罩、不抛错、牌桌已渲染', async () => {
  // store.$patch({ view: { ...playing 必备字段, 无 trustees } as unknown as PlayerView })
});
```

- [ ] **Step 2: 跑红** `pnpm -C apps/client test -- table-trustee`
  - 预期：`.table__trustee-mask` 不存在。

**Step 3 — 实现**

在 `.table__me` 内、`<Hand>` 与 `.table__me-foot` 之间插入：

```html
<view
  v-if="myTrustee && !settlementRevealed && (store.isBidding || store.isPlaying)"
  class="table__trustee-mask"
  @click.stop
>
  <text class="table__trustee-title">托管中</text>
  <text class="table__trustee-desc">轮到你时将自动出牌</text>
  <button
    type="button"
    class="btn btn--primary table__trustee-cancel"
    :disabled="busy"
    @click="onTrustee(false)"
  >
    取消托管
  </button>
</view>
```

CSS（放在 `.table__me` 样式附近）：

```scss
.table__trustee-mask {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
  background: rgb(0 0 0 / 45%);
  border-radius: $ftl-radius-md;
}
.table__trustee-title {
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
}
.table__trustee-desc {
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
}
.table__trustee-cancel {
  min-width: 180px;
}
```

同步 `.table__me` 的 `position:relative` 注释：「本条目前无消费者」→「托管遮罩的定位基准」。

- [ ] **Step 4: 跑绿** `pnpm -C apps/client test` + `pnpm -C apps/client run lint`
- [ ] **Step 5: 提交** `feat(client): 托管中遮罩 + 取消托管按钮`

---

## Task 5 — conformance slice-27 C 组迁移

**Files**

- Modify: `tools/conformance/src/slices/slice-27-idle-trustee.ts`（C 组 + D 组标题/前置）

**Step 1 — 改断言**

C 组：

- 在 manual off 前显式断言挂机者不是当前行动者（C13 前置）。
- `cGovAfterOff.timeoutCount`：`>= 3` → `=== 0`。
- 挂机者下一回合读数：accel（700–1150）→ normal（1200–1700）。
- 窗口内手动动作后 count 仍 0；再下一回合 normal（1200–1700）。
- step/头注文案改为「manual off 自动托管 ⇒ count 清零 ⇒ 下一回合 normal」。
- 断言条数：C 组 **11→12**（+1 条非行动者前置）；D 组 **+1** 前置；片总 **114**（baseline floor 112 是下限，无需回填）。

D 组：

- 标题/头注：「R8② manual off 不重排」→「R8② **手动开启的托管** manual off 不重排」。
- D2 前显式断言 `f1` 的 `timeoutCount === 1`（< after=3），钉住走的是非 auto 分支。

- [ ] **Step 2: 类型检查** `pnpm --filter @fight-the-landlord/conformance build`
- [ ] **Step 3: 真栈跑片**

环境前置：Docker 可用；`conformance-stack.sh` 默认 `ADMIN_PASSWORD=conformance-admin-pass`；端口 8080/8443 未被占用（本机常见坑）。**起栈失败是环境问题，不得记成 slice 红。**

```bash
bash scripts/deploy/conformance-stack.sh up
node tools/conformance/dist/run.js slice-27-idle-trustee
bash scripts/deploy/conformance-stack.sh down
```

  - 预期：C 组 12 条全绿；片总 114 ≥ 112；片内其他组不回归。
  - 若本机无法起真栈：登记为「合 master 前必须跑」，不得以单测替代。

- [ ] **Step 4: 提交** `test(conformance): slice-27 C 组迁移到自动托管取消清零`

---

## Task 6 — 文档与注释同步

**Files**

- `docs/design.md:309`（1500→2000；例外表补 auto manual-off ⇒ accel）
- `docs/design.md:348`（例外摘要补 manual-off auto）
- `docs/design.md:486-490`（`GameTrusteeRequest` 注释：manual off 不重排只对阈值未到成立）
- `docs/design.md:1574`（1500→2000）
- `docs/games/doudizhu.md:77,405,442,453,460,468`（1.5s/1500→2s/2000）
- `docs/games/doudizhu.md:444`（§9.2 第 6 条区分 auto 例外）
- `docs/games/doudizhu.md:455,463-473`（复位/例外语义重写）
- `packages/shared/src/ddz/types.ts:39,41,70`（注释与 1500→2000）
- `packages/shared/src/ddz/governance.ts:2`（已在 Task 1 改，复核）
- `packages/shared/src/index.ts:6`（头注补 C4′）
- `packages/game-service/src/game/game.service.ts:362-366,402,424`（Task 2 已改，复核）
- `packages/game-service/test/trustee.test.ts:16`（头注 C4 改口径）

**Step 1 — 逐文件改文案**（无测试；改完跑一次相关包的 tsc/lint 防注释里的反引号破坏）
- [ ] **Step 2: 提交** `docs: 托管恢复语义（2s 档 / 自动托管取消清零 / accel 重排）`

---

## Task 7 — 全量验证与代码审查

- [ ] `pnpm exec turbo run test lint --force`（全仓；Cached 不算）
- [ ] `pnpm -C apps/client build`（H5 构建）
- [ ] `pnpm verify:admin`（未改 admin，但属全量门禁）
- [ ] 真栈 slice-27（Task 5，若尚未跑）
- [ ] 独立 reviewer 审 `BASE..HEAD` diff；Critical/Important 必须修；Minor 登记或顺手修
- [ ] 修完补测试 → 重跑定向 + 全量
- [ ] 工作区干净；最终提交（如有审查修复）

**最终交付报告**：变更、验证证据（测试数/结果、类型检查、真栈）、提交范围、是否推送/部署、已知边界（D13 重连竞态、手动托管的计数保留、服务器 `.env` 若钉了 1500 需清理）。

---

## 计划审查记录

### r1 计划对抗审查（2026-10-22，独立 reviewer）

结论：**需修订**（1 阻断 + 3 高 + 8 低）；修订后无架构级问题，可开工。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 B1 | Task 1 的 `governance.test.ts` 未把 `onManualTrusteeOff` 加进 import ⇒ 永远红 | **已采纳**：Task 1 Step 1 显式要求先补 import |
| 高 H1 | C4 的 manual 行夹具是行动者，与新 D7 重排冲突 | **已采纳**：manual 行改 `currentPlayer: 0`（非行动者）；reconnect 行保持行动者 |
| 高 H2 | Task 2 item 6 默认档测试与 Task 3 重复，且会让 Task 2 提交红树 | **已采纳**：删除 Task 2 item 6，默认档只在 Task 3 |
| 高 H3 | conformance 条数口径错误（11→13 不成立） | **已采纳**：统一为 C 组 11→12、D 组 +1、片总 114 ≥ baseline 112 |
| 低 L1 | 客户端 busy 用例只证明 disabled，未证明重复发送被拦 | **已采纳**：加 `dispatchEvent` 绕过 disabled，断言发送次数仍 1 |
| 低 L2 | bidding 用例是占位 | **已采纳**：补具体夹具与断言 |
| 低 L3 | Task 0 写 r1/r2 但 spec 当时只有 r1 | **已核对**：spec 现已补 r2 复审记录 |
| 低 L4 | C12 未写实句柄更换断言 | **已采纳**：补 `handleBefore` / `not.toBe` |
| 低 L5 | C4 未列 publish 次数 | **已采纳**：补 `redisDouble.publish` 恰一次 |
| 低 L6 | 方法作用域与内层 `const d` shadow | **已采纳**：明确删除内层、复用外层 |
| 低 L7 | 真栈环境前置未写 | **已采纳**：Task 5 补 Docker/端口/口令前置 |
| 低 L8 | 999/1 的起算点含糊 | **已采纳**：明确「从新计时器安装时刻起算」 |
