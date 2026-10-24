# 托管恢复体验（遮罩 + 自动托管取消清零 + 2s 档）— 设计

- 日期：2026-10-22
- 状态：两轮对抗审查已通过（r1：2 阻断 + 4 高 + 7 低全处置；r2：无阻断，1 高 + 8 低已并入），待实现计划
- 范围：`apps/client`（牌桌遮罩）· `packages/shared`（治理纯函数）· `packages/game-service`（托管默认档 + 取消语义）· `tools/conformance`（slice-27 C 组）· 文档；**不动** protocol / 配置中心 / 数据库 / 部署
- 用户裁决：
  1. 托管中在自己手牌区加**遮罩 + 「取消托管」按钮**；
  2. **手动取消托管时超时计数清零**；
  3. 托管自动出牌默认延时 **1.5s → 2s**。

## 1. 背景与问题

托管（挂机治理）当前有三处恢复体验问题：

1. **恢复窗口太小**：托管档每回合只等 1.5s 就自动出牌。玩家回来时往往来不及在当前回合手动出牌，只能等下一回合——而下一回合仍是 1.5s。
2. **取消后仍处于高压档**：现有 C4 规定「解除托管只清 `trustee`、`timeoutCount` 不动」。因此玩家手动取消后，下一回合仍是加速档 10s；由于计数已 ≥ 阈值 3，**再超时一次立即又回到托管**——主观感受就是「点了取消也没用」。
3. **取消入口不醒目**：目前只有顶栏右侧一个小「托管/托管中」toggle（[table.vue](../../../apps/client/src/pages/table/table.vue) 的 `.table__trustee`）。托管中该按钮只变金色描边，没有「我该点哪里恢复」的明确引导。

参考欢乐斗地主（腾讯客服口径）：连续超时 **2 次**自动托管；取消走「菜单里的取消托管 / 9 键 / 界面上的取消托管按钮」——**恢复靠的是一个随时可点的入口，不是抢在自动出牌前操作**。本次对齐这个交互本质，不照搬其阈值与视觉。

## 2. 范围

### 做

- 客户端：自己处于托管且对局进行中时，在自己的手牌区（`.table__me`）覆盖一层半透明遮罩，含「托管中」标题、「轮到你时将自动出牌」说明与「取消托管」按钮；点击复用现有 `game.trustee{on:false}` 消息。
- 服务端：**手动取消「自动托管」**（`via='manual'` 且 `timeoutCount >= after`）时把 `timeoutCount` 清零；若本人是当前行动者，把当前回合计时器**重排到加速档**（10s），给回来的玩家一个可操作窗口。
- 服务端：**手动取消「手动开启的托管」**（`count < after`）保持 C4/R8② 原语义：只清 trustee、计数不动、不重排。
- 服务端：**重连解除托管**保持原语义：只清 trustee、计数保留（封断线重连洗惩罚）、按 count 基线重排。
- 服务端：托管自动出牌默认延时从 1500ms 调为 2000ms（env `GAME_TRUSTEE_DELAY_MS` 覆盖语义不变）。
- conformance：迁移 `slice-27` 的 C 组到新语义（自动托管取消 ⇒ count=0 ⇒ 下一回合 normal）。
- 文档：`docs/design.md`、`docs/games/doudizhu.md`、`types.ts`、`governance.ts` 头注同步；历史 spec 注明被本设计取代。

### 不做（YAGNI）

- 不改自动托管的触发阈值（仍为连续 3 次超时；欢乐斗地主的 2 次不照搬）。
- 不改 `via='reconnect'` 的计数语义（防「断线重连洗惩罚」）。
- 不把托管档做成配置中心热键（另立片）。
- 不做全屏遮罩（会挡住看牌与对手出牌；遮罩只盖自己的手牌区）。
- 不改协议、不改 compose、不改管理页。
- 不处理「重连先到、manual off 后到」的竞态（见 D13，接受并加测试）。

> **与用户原话的差异（有意收窄，防旁路）**：用户裁决是「手动取消托管时计数清零」。若字面实现为**一律清零**，玩家可在非自己回合先点「托管」再点「取消」，用两次 UI 操作把 `timeoutCount` 清零，从而无限绕过加速档与自动托管（B1 阻断）。本设计收窄为：**只有已达到自动托管阈值（`count >= after`，即系统自动接管）的取消才清零**；玩家手动开启的托管取消仍按原 C4 保留计数。这保持了用户「托管后能恢复」的目标，同时不重开刷计数旁路。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 遮罩挂在 `.table__me` 内，`position:absolute; inset:0`，只盖手牌 + 底部信息条，不盖牌桌中段与动作行 | `.table__me` 已有 `position:relative` 预留基准；不挡观战、不挡动作行；改动面最小 |
| D2 | 显示条件 = `myTrustee && !settlementRevealed && (store.isBidding \|\| store.isPlaying)` | 与顶栏托管按钮同一门控；结算揭示后必须让位；等待房/终局不显示 |
| D3 | 遮罩内容是「托管中」+「轮到你时将自动出牌」+「取消托管」按钮；按钮 `:disabled="busy"` | 文案常量、无新动效；`busy` 是既有 send() 闸，防连点；说明文案对「我的回合/别人回合」都成立 |
| D4 | 点击按钮调用既有 `onTrustee(false)`（发 `game.trustee{on:false}`），**不做本地翻转**；遮罩消失只认服务端视图 | 哑终端纪律：状态唯一来源 `PlayerView.trustees[mySeat]`；失败时遮罩保留，错误由 session notice 统一呈现 |
| D5 | 服务端新增纯函数 `onManualTrusteeOff(seat)`：`{timeoutCount:0, trustee:false}`；`onTrusteeOff` 保持原语义（只清 trustee），仅用于 reconnect / 手动开启的托管 | 两条路径语义不同，用两个函数把差异写在名字上 |
| D6 | **已达到自动托管阈值的判定 = `before.timeoutCount >= durations().after`**；只有 manual off 且满足该条件才走 `onManualTrusteeOff`，否则走 `onTrusteeOff` | 只对「已到阈值（系统已/应接管）」清零；手动的 on→off 在阈值未到时不得洗计数（堵 B1 旁路）。判定与 `onTimeoutOccurred` 的置位条件同源，不是字面「来源」字段。⚠️ 已知边界：reconnect 保留的 count（≥after）可被随后的 manual on→off 清零——玩家在主动操作，视为已返回；测试钉住该序列 |
| D7 | 自动托管 manual off 且本人是当前行动者 ⇒ `rescheduleTurn` 到 **accel 档（10s）**；不重排到 normal | 给回来的玩家真实操作窗口（解 H3）；一次自动托管只能换一次 10s 窗口，且随后 count=0，无法靠反复 on/off 续命（比旧 R8② 更严） |
| D8 | 非行动者的自动托管 manual off ⇒ 只清 count/trustee，timer 与 deadline 均不动 | 与 C13 同族；下一回合按 count=0 走 normal |
| D9 | 手动开启的托管 manual off ⇒ 保持 R8②：只清 trustee、count 不动、不重排（当前回合短延时照常走完一次） | 防续命；与自动托管路径按 D6 分流 |
| D10 | 托管档默认值 `Number(process.env.GAME_TRUSTEE_DELAY_MS) \|\| 2_000` | 只改默认值；env 覆盖与 `\|\|` 空串语义不动 |
| D11 | 遮罩不新增计时器、不新增消息、不新增组件文件（模板 + scoped CSS 直接放 table.vue） | 避开「牌桌区不新造时钟」与单根组件闸；文件最少 |
| D12 | 遮罩根元素 `@click.stop`，按钮点击不冒泡 | 防误触手牌/外层点击；与既有弹层 `@click.stop` 同款 |
| D13 | 接受「`via='reconnect'` off 先落库 ⇒ 后续 manual off 命中 no-op（count 不清）」的竞态；加测试钉住，不引入特例写路径 | 该场景下玩家已经回到牌桌、遮罩已消失；其下一次成功行动会按 C3 清零。为竞态增加第三套写语义得不偿失 |
| D14 | conformance slice-27 C 组随新语义迁移；baseline 断言数保持 112（只改判据，不减条数） | 权威轮必跑；旧断言「manual off 后 count ≥ 3」与新语义直接冲突（B2） |

### 3.1 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| A. `.table__me` 内遮罩 + 自动托管取消清零 + 10s 重排（本设计） | 改动集中在治理语义与客户端一块遮罩；堵住刷计数旁路；真栈 conformance 同步迁移 |
| B. 无条件清零（用户原话的字面实现） | 简单，但重新打开「手动 on→off 刷计数」旁路（B1），挂机治理失效；不可接受 |
| C. 引入 `trusteeSource` 显式来源字段 | 语义最精确，但要动 `GamePlayer`/Redis 会话迁移/夹具，改动面显著变大；`count >= after` 与置位条件同源，已足够判别 |
| D. 不变更当前回合计时器（保留 R8②） | 改动更小，但玩家点取消后当前回合仍会被自动出牌、下一回合是 accel——H3/H1 的体验问题仍在 |
| E. 取消后重排到 normal 30s | 恢复窗口最大，但等于给自动托管者一次完整续命，防滥用弱于 10s 档 |

## 4. 实现设计

### 4.1 `packages/shared/src/ddz/governance.ts`

新增：

```ts
/**
 * C4′（手动取消**自动托管**）：解除托管并清零超时计数——「我回来了」的明确信号。
 * ⚠️ 只用于 count ≥ after 的自动托管来源；手动开启的托管取消仍走 `onTrusteeOff`。
 */
export function onManualTrusteeOff(_seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: 0, trustee: false };
}
```

`onTrusteeOff` 的注释改为「仅 reconnect / 手动开启的托管：只清 trustee，count 不动」。

### 4.2 `packages/game-service/src/game/game.service.ts`

`applyTrusteeLocked` 的 off 分支（示意，保持既有守卫顺序）：

```ts
const before = this.governanceOf(session.players[idx]);
if (before.trustee === dto.on) return { version: session.version };

const d = this.durations();
const autoTrusted = before.timeoutCount >= d.after;

const updated = /* players[idx] 按以下分流：
  dto.on ? { trustee: true }
  : dto.via === 'manual' && autoTrusted ? onManualTrusteeOff(...)
  : onTrusteeOff(...) */
```

行动者分支（D7/D9）：

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
    // 旧短计时器被 clearTimer 替换 ⇒ 不会在 2s 后抢先自动出牌。
    this.rescheduleTurn(dto.roomCode, updated, d.accel);
  }
  // manual off（手动开启的托管）⇒ R8②：不重排不重算
}
```

`durations().trustee` 默认值改 `2_000`（D10）。

### 4.3 `apps/client/src/pages/table/table.vue`

模板（放在 `.table__me` 内、`<Hand>` 与 `.table__me-foot` 之间，作为绝对定位层）：

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

样式（scoped，复用既有 token）：

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

说明：

- 顶栏 toggle 原样保留；遮罩是第二入口。
- 遮罩只在 `myTrustee` 为真时渲染；`trustees` 缺字段的防御读由 `myTrustee` 的 `?. ?? false` 承接。
- 层叠清单：`.table__scrim` 1 < Settlement 2 < 阶段遮罩 3 < **本遮罩 4** < MoreMenu 10 < NoticeStack 15 < ConnectionOverlay 20；结算揭示时 `v-if` 直接不渲染，避免与结算层竞争。
- 手牌选择在遮罩下不可点；动作行的按钮仍可见，预选牌仍可出——这是 C3 的另一条恢复路径，不额外封堵（真机走查确认不会误出）。
- `.table__me` 的 `position:relative` 注释同步为「遮罩基准」。

### 4.4 文档与注释

| 文件 | 改动 |
|---|---|
| `docs/design.md:309` | `turnDeadlineAt` 注释：托管 1500→2000；例外表补「自动托管 manual-off ⇒ 行动者重排到 accel」 |
| `docs/design.md:348` | 例外摘要补 manual-off（auto）一条 |
| `docs/design.md:486-490` | `GameTrusteeRequest` 注释：`manual`+`on:false` 的「timer 不重排」只对**阈值未到**的托管成立；自动托管行动者取消 ⇒ 重排 accel |
| `docs/design.md:1574` | 托管 1500→2000 |
| `docs/games/doudizhu.md:77,405,442,453,460,468` | 1.5s/1500→2s/2000 |
| `docs/games/doudizhu.md:444` | §9.2 第 6 条：「手动关托管等不重挂 timer」改为「非行动者治理态变更不重挂；自动托管行动者的 manual off 例外见 §9.3」 |
| `docs/games/doudizhu.md:455,463-473` | 重写复位/例外语义：自动托管取消清零 + 行动者重排 accel；手动开启的托管/重连保持不清零 |
| `packages/shared/src/ddz/types.ts:39,41,70` | trustee/timeoutCount 注释区分来源与 C4′；1500→2000 |
| `packages/shared/src/ddz/governance.ts:2` | 「四个函数」→「五个函数」，C1/C3/C4/C4′/C7b/C10 |
| `packages/shared/src/index.ts:6` | 头注补 C4′ |
| `packages/game-service/src/game/game.service.ts:362-366,402,424` | R8② 与 off 分支注释改为按 `via` + 阈值分流；D7 例外说明 |
| `packages/game-service/test/trustee.test.ts:16` | 头注 C4 改为「自动托管清零 / 手动托管与重连保留」 |
| 本 spec §9 | 注明 2026-10-17 的 idle-trustee spec/design/plan 中 C4 旧口径已被本设计取代 |

## 5. 测试判据

### 5.1 `packages/shared/src/ddz/governance.test.ts`

- `onManualTrusteeOff({timeoutCount:3,trustee:true})` ⇒ `{0,false}`。
- `onManualTrusteeOff({timeoutCount:0,trustee:false})` 也返回 `{0,false}`（纯函数）。
- `onTrusteeOff({3,true})` 仍返回 `{3,false}`（reconnect / 手动开启语义不变）。

### 5.2 `packages/game-service/test/trustee.test.ts`

- **自动托管 manual off（非行动者）**：count=3、trustee=true、currentPlayer≠本人 ⇒ `{0,false}`，version+1，publish 一次，deadline/timer 不动。
- **自动托管 manual off（行动者）**：count=3、trustee=true、currentPlayer=本人 ⇒ `{0,false}`；deadline ≈ now+accel（注入态 1000ms）；**重排后 `service['timers'].get(room)` 已更换**（证明旧句柄被 `clearTimer`）；推进 999ms 无自动动作、再推进 1ms 才触发；之后 count=1、trustee=false。
- **手动托管 manual off（行动者）**：count=2、trustee=true、currentPlayer=本人 ⇒ `{2,false}`，deadline/timer 不动（R8②）；推进 400ms 自动动作后 count=3、trustee=true（达到阈值）。
- **反旁路（阈值未到）**：count=2、trustee=false 时 manual on ⇒ off ⇒ count 仍为 2（不清零、不洗计数）。
- **阈值已到的序列（接受清零）**：count=2、trustee=false → manual on → 一次超时使 count=3、trustee=true → manual off ⇒ count=0、trustee=false（该玩家确已连续 3 次超时，清零不构成旁路）。
- **reconnect off**：count=3、trustee=true ⇒ `{3,false}`，行动者按 count 基线重排（1000ms）——既有 C4/C14 保留。
- **重连后 manual off**：count=3、trustee=false ⇒ no-op（version 不变、count 仍 3）——钉住 D13 竞态。
- **重连保留 count 后的 on→off**：count=3、trustee=false → manual on → manual off ⇒ count=0（D6 阈值语义；已知边界，测试钉住）。
- **no-op 守卫**：非 trustee 的 manual off 仍是零落盘/零 bump/零 publish（C8 既有用例 + 显式断言 count 不变）。
- **默认档（D10）**：删除四个 env 后，trustee 座位 `deadlineFor` ≈ now+2000（`vi.setSystemTime` 固定时钟）。

### 5.3 `apps/client/test/table-trustee.test.ts`

- `trustees[mySeat]=true` + `state=playing` ⇒ `.table__me .table__trustee-mask` 存在，含「托管中」「轮到你时将自动出牌」「取消托管」；正对照：`.seat` 仍渲染 4 个。
- `trustees[mySeat]=true` + `state=bidding` ⇒ 遮罩存在（覆盖叫抢期）。
- `trustees[mySeat]=false` ⇒ 遮罩不存在（正对照：牌桌已渲染）。
- 遮罩只认自己：`trustees[other]=true` ⇒ 遮罩不存在。
- 点击「取消托管」⇒ 恰发一条 `game.trustee{on:false}`；ack code=0 后**遮罩仍在**（不本地翻转）；服务端推 `trustees[mySeat]=false` ⇒ 遮罩消失。
- 点第一下后（未 ack）按钮 `disabled` 且 `.emittedOf('game.trustee')` 长度仍为 1（`busy` 闸；VN 下 disabled 元素 trigger 会被跳过，故断言 disabled + 发送次数）。
- `state=ended` ⇒ 即使 `trustees[mySeat]=true` 遮罩也不显示（该态的判据不依赖揭示延迟）。
- 用 `store.$patch` 注入 `state:'playing'` 且**没有** `trustees` 字段的视图 ⇒ 无遮罩、不抛错、牌桌已渲染（避免用 `state:'ended'` 造成空洞断言）。
- 遮罩不盖动作行：`.table__trustee-mask` 的宿主必须是 `.table__me`（用 find 作用域钉住），且 `.table__action-bar` 不在遮罩内。

### 5.4 conformance `slice-27-idle-trustee`（B2）

- C 组头注/step 文案改为「manual off 自动托管 ⇒ count 清零 ⇒ 下一回合 normal」。
- C 组在 off 前显式断言「挂机者不是当前行动者」（C13 前置）。
- `cGovAfterOff.timeoutCount` 由 `>= 3` 改为 `=== 0`。
- 挂机者下一回合读数由 accel（700–1150）改为 normal（1200–1700）。
- 窗口内手动动作后 count 仍为 0；再下一回合仍为 normal（1200–1700）。
- D 组标题/头注更新：R8② 的「不重排」只对**手动开启的托管**成立；D2 前显式断言 f1 的 `count=1`（<after），防止驱动变化后静默走进 auto 分支。
- 断言条数只增不减：C 组 **11→12**（+1 条非行动者前置）、D 组 **+1** 前置、片总 **114**；baseline floor 112 是下限，无需回填。
- 本片合 master 前必须跑一次 slice-27（真栈，需重建 game-service）。

### 5.5 回归

- `pnpm -C packages/shared test`
- `pnpm -C packages/game-service test`
- `pnpm -C apps/client test`
- `pnpm -C apps/client run lint`（vue-tsc）
- `pnpm -C tools/conformance build`（或该包既有命令）+ 真栈 slice-27（合 master 前）
- 全仓：`pnpm exec turbo run test lint --force`
- 部署侧确认：服务器 `/srv/pokergame/.env` 若把 `GAME_TRUSTEE_DELAY_MS` 钉成 1500，需删除或改 2000（否则默认值改动线上无效；本机 `.env*` 已确认无语键）。

## 6. 错误处理与边界

| 情形 | 行为 |
|---|---|
| 点击取消但服务端拒绝（如对局已结束） | ack 非 0 ⇒ session notice 呈现；遮罩在服务端视图到达前保留（若随后收到 ended 视图，遮罩按 D2 关闭） |
| 连点取消 | `busy` 闸：按钮 disabled，第二次不发送 |
| 自动托管取消时本人是当前行动者 | 计时器重排到 accel（10s）；旧短计时器被清除，不会抢先自动出牌；若 10s 内仍不动作 ⇒ count=1，下次轮到你 accel |
| 自动托管取消时不是行动者 | 下一回合 count=0 ⇒ normal |
| 手动开启的托管取消 | 只清 trustee，count 不动；当前回合短延时照常走完一次（R8②） |
| 重连解除托管 | 只清 trustee、count 保留；行动者按 count 基线重排（R6） |
| 重连先到、manual off 后到 | 后者命中 no-op，count 不清（D13 接受；下一次成功行动按 C3 清零；若回来仍不动作 ⇒ 下一次超时 count=4 ⇒ 立即再托管） |
| 旧会话缺 `timeoutCount` | `loadSession` 既有迁移补 0 |
| 结算揭示 | 遮罩 `v-if` 关闭；不与结算层竞争 |
| 遮罩遮挡探针点击 | 探针走 DOM `.click()`，不受视觉遮挡影响；不改探针锚点 |

## 7. 风险

- **行为变更面较大**：manual off 从「一律保留计数」改为「自动托管清零 + 手动托管保留」，必须同步改 unit/conformance/文档，避免后续实现者按旧 C4 改回去。
- **计时器重排**：自动托管取消时重排到 accel，是本片唯一新增的 timer 写入点；必须用 fake timer 钉住「旧计时器被清除、不会双触发」。
- **反旁路判据**：`count >= after` 与 `onTimeoutOccurred` 的置位条件同源；若将来把阈值改成动态/按座位，需同步此处。
- **客户端布局**：遮罩是绝对定位、不参与 flex；仍需跑 `card-hand-interaction` / `table-seat-geometry` 等既有测试。
- **层叠**：依赖 `settlementRevealed` 门控避免与结算层竞争；NoticeStack/MoreMenu/ConnectionOverlay 均在遮罩之上。
- **真机误触**：遮罩覆盖手牌但动作行仍可点；真机走查确认不会「看不见手牌却出牌」。

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `packages/shared/src/ddz/governance.ts` | 新增 `onManualTrusteeOff`；`onTrusteeOff` 注释收窄；头注函数计数 |
| `packages/shared/src/ddz/governance.test.ts` | 新增纯函数用例 |
| `packages/game-service/src/game/game.service.ts` | off 分流 + 行动者重排 accel；trustee 默认 2000；注释 |
| `packages/game-service/test/trustee.test.ts` | C4/C12 改判 + 反旁路/重排/默认档/竞态用例 |
| `apps/client/src/pages/table/table.vue` | 遮罩模板 + scoped CSS + `.table__me` 注释 |
| `apps/client/test/table-trustee.test.ts` | 遮罩显示/点击/消失/边界用例 |
| `tools/conformance/src/slices/slice-27-idle-trustee.ts` | C 组迁移（count=0 / normal 档） |
| `docs/design.md` | `turnDeadlineAt` 注释、1574 行档位、例外语义 |
| `docs/games/doudizhu.md` | 档位 1.5s→2s；复位/例外语义重写 |
| `packages/shared/src/ddz/types.ts` | trustee 注释、1500→2000 |
| `packages/shared/src/index.ts` | 头注补 C4′ |

## 9. 审查记录

### r1 对抗审查（2026-10-22，独立 reviewer）

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 B1 | 无条件清零 ⇒ 手动 on→off 可无限洗计数，挂机治理失效 | **已采纳**：D6 以 `count >= after` 判定自动托管来源，只对自动托管清零；新增反旁路测试 |
| 阻断 B2 | slice-27 C 组断言旧 C4（manual off 后 count ≥ 3、下一回合 accel），权威轮必红 | **已采纳**：D14 / §5.4 纳入迁移，baseline 条数不变 |
| 高 H1 | 原 spec 承诺「下一回合 normal」与旧短计时器 +1 计数矛盾 | **已采纳**：D7 重排到 accel；若仍未行动则 count=1、下次 accel；§5.2 钉住 |
| 高 H2 | 文档范围低估（design.md/doudizhu 多处/types.ts/index.ts） | **已采纳**：§4.4 文件表补全 |
| 高 H3 | 取消后当前回合仍被自动出牌（体验割裂） | **已采纳**：D7 重排 accel，旧短计时器清除 |
| 高 H4 | 重连先到 ⇒ manual off no-op，count 不清 | **已采纳为已知边界**：D13 接受 + 测试钉住；不做第三套写路径 |
| 低 L1 | 客户端测试假绿风险（ended 态、disabled trigger、作用域） | **已采纳**：§5.3 用 playing/bidding、作用域钉 `.table__me`、断言 disabled + 发送次数 |
| 低 L2 | z-index 清单写反/漏 NoticeStack | **已采纳**：§4.3 层叠清单订正 |
| 低 L3 | 「系统正在自动出牌」在别人回合不准确 | **已采纳**：改为「轮到你时将自动出牌」 |
| 低 L4 | 注释过期/CSS 占位符 | **已采纳**：§4.3 注明更新 `.table__me` 注释 |
| 低 L5 | 服务器 `.env` 可能钉 1500 | **已登记**：§5.5 部署侧确认 |
| 低 L6 | 历史 spec 旧 C4 口径 | **已登记**：§4.4 注明历史文档被本设计取代 |
| 低 L7 | 遮罩下手牌不可见但动作行可出牌 | **已接受**：C3 恢复路径；真机走查确认 |

> 历史口径：`docs/superpowers/specs/2026-10-17-idle-trustee-spec.md`、`-design.md` 与对应 plan 中的 C4「解除托管只清 trustee」是**本设计之前的规则**；自本片起，**已达到自动托管阈值**的 manual off 清零，手动开启的托管/重连保持不清零。

### r2 复审（2026-10-22，同一 reviewer）

结论：**无阻断，可进入计划**；B1 门控、D7 重排（旧句柄被 `clearTimer`、回合身份复核防双触发）、B2 的 C 组迁移、D13 接受均成立。

| 级别 | 发现 | 处置 |
|---|---|---|
| 高 | D7 新增的「自动托管行动者取消 ⇒ 重排 accel」漏了三处权威文档：`design.md:348/486-490`、`doudizhu.md:444` | **已采纳**：§4.4 文件表显式点名这三处并写明改写口径 |
| 低 L1 | D6 措辞应改为「已达到自动托管阈值」；补 `count=2 → manual on → 超时 → count=3 → off` 序列测试 | **已采纳**：D6 措辞 + §5.2 新增该用例 |
| 低 L2 | 对用户原话的收窄未记录 | **已采纳**：§2 增「与用户原话的差异（有意收窄，防旁路）」块 |
| 低 L3 | D13 缺「仍不动作 ⇒ count=4 ⇒ 立即再托管」后果 | **已采纳**：§6 该行补全 |
| 低 L4 | D7 计时器测试精度不足 | **已采纳**：§5.2 改为断言句柄更换 + 999ms/1ms 边界 |
| 低 L5 | slice-27 C/D 组前置断言与 D 组标题 | **已采纳**：§5.4 显式前置断言 + 标题/头注更新 |
| 低 L6 | 客户端缺 `trustees` 用例用 `ended` 态是空洞断言 | **已采纳**：§5.3 改为 `$patch` 注入 `playing` 且无 `trustees` |
| 低 L7 | 「遮罩保留」措辞不准 | **已采纳**：§6 改为「服务端视图到达前保留」 |
| 低 L8 | 手动开启的托管取消后计数不降，遮罩可能再次出现 | **已登记**：有意反旁路语义；真机走查确认「取消两次」错觉不构成阻断 |
| 低 L9 | 注释同步清单不全 | **已采纳**：§4.4 补 `types.ts:39`、`game.service.ts:362-366/424`、`trustee.test.ts:16` |

### r3 代码审查（2026-10-22，独立 reviewer）

结论：**无 Critical / Important**；11 条 Minor。处置：

- 已修（本片内）：spec 599→999 笔误；`doudizhu.md` 复位规则补 C4′；`docker-compose.yml` 注释 1500→2000；slice-27 «1000ms 档» 注释；客户端测试注释与 ended/他人托管正对照；非行动者 auto off 补 timer 句柄断言；`design.md` R8 编号；`governance.test.ts` 夹具改 2000。
- 已登记：D6 已知边界（reconnect 保留的 `count>=after` 可被随后的 manual on→off 清零）+ 单测钉住（§5.2）。
- 遗留：真栈 `slice-27-idle-trustee` 合 master 前必须跑（本机串行构建镜像后执行）。
