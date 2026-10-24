# 记牌器购买入口改「小入口 + 弹层」— 实现计划

- 日期：2026-10-19
- 设计：[2026-10-19-card-counter-entry-design.md](../specs/2026-10-19-card-counter-entry-design.md)（决策表 D1–D11 / 审查记录 H1–H3、L1–L4）
- 范围：`apps/client/src/pages/game/game.vue` + `apps/client/test/card-counter-purchase.test.ts`
- 交付方式：TDD，一个任务一个 commit（均带 attribution）

## Global Constraints

- **纯客户端**：不动服务端/协议/配置键/价格/开局消费时机；`buyCardCounter` 等购买逻辑不重写。
- **锚点纪律**：`.game` 仍是页面根 class（单根闸）；`.game__match button` 仍是开始/取消匹配的唯一按钮；
  「返回大厅」「记牌器」文案逐字保留。
- **弹层形态**：遮罩 = 裸 `@click`；面板根 = `@click.stop`；**禁止 `@click.self`**（uni-app H5 恒被吞）。
- **不新造时钟 / 不改 store**：本片无定时器、无 store 字段。
- 提交信息末尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1：入口按钮 + 购买弹层骨架（内容迁移 + 开合 + `.self` 源码闸）

**Files**：`src/pages/game/game.vue`、`test/card-counter-purchase.test.ts`

### 1.1 先写失败测试（RED）

改测试文件：

1. 新增 helper：
   ```ts
   async function openShop(wrapper: Awaited<ReturnType<typeof mountGame>>['wrapper']) {
     await wrapper.find('.game__cardcounter-entry').trigger('click');
     await flushPromises();
   }
   ```
2. 「条件」用例改锚入口（**必须带作用域**，防「入口挪出顶栏」照样绿）：
   - 条件齐 ⇒ `.game__bar .game__cardcounter-entry` 存在；
   - **入口不在中央区**：`.game__stage .game__cardcounter-entry` 不存在；
   - **默认弹层关** ⇒ `.game__cardcounter` 不存在、`.game__cardcounter-buy` 数量 0（钉死 `v-if`）；
   - `aria-expanded`：默认 `"false"`；点开 ⇒ `"true"`；关闭 ⇒ `"false"`；
   - 旧服务端（`perGame: null`）/ 免费场（`mode: 'random'`）/ 开关关（`enabled: false`）⇒ `.game__bar .game__cardcounter-entry` 不存在。
3. 「免费态/单键 0」用例：mount 后先 `openShop`，再断言「金币场免费」/购买按钮 0 个 / 单键 1 个 / 无「单局卡」。
4. 「状态加载失败」用例：`openShop` 后再断「权益信息加载失败」+ 2 个购买按钮。
5. 购买类全部用例（154–294 行）：mount 后先 `openShop`，其余断言逐条保留。
6. 「匹配中」用例：断言 `.game__cardcounter-entry` 与 `.game__cardcounter` 均不存在。
7. 新增「开合」用例（结尾 `wrapper.unmount()`，下同）：
   - 点入口（`.game__bar .game__cardcounter-entry`）⇒ `.game__cardcounter` 出现；
   - 点面板内部（`.game__cardcounter.trigger('click')`）⇒ **仍打开**（`@click.stop` 生效）；
   - 点遮罩（`.game__cardcounter-mask.trigger('click')`）⇒ 关闭；
   - 再开 → 点「关闭」按钮（`.game__cardcounter-close`）⇒ 关闭。
8. 新增源码闸（照抄 `more-menu.test.ts:194-212`）：
   - **新增 import**：`import { collectSourceFiles, stripComments } from './helpers/source-scan';`
   - 扫描路径逐字 `src/pages/game/game.vue`（`collectSourceFiles()` 产出集合里找）；
   - `stripComments` 后不含 `@click.self`（带正对照 `@click.self="..."` 必被同一正则命中）；
   - 遮罩是裸 `@click`：`/game__cardcounter-mask"[^>]*@click=/`；
   - 面板根有 `@click.stop`：`/game__cardcounter"[^>]*@click\.stop/`；
   - 已知边界（登记）：`v-on:click.self` 拼写不被该正则覆盖（与 more-menu 闸同一已知边界）。

运行 `npx vitest run test/card-counter-purchase.test.ts` ⇒ **确认红**（入口选择器不存在/旧断言失配）。

### 1.2 最小实现（GREEN）

`game.vue` script：

```ts
/** 记牌器购买弹层（2026-10-19 入口改造）：开合状态。 */
const ccShopOpen = ref(false);

function openCounterShop(): void {
  ccShopOpen.value = true;
}
```

模板：

- `.game__bar` 里「返回大厅」之后插入：
  ```html
  <button
    v-if="ccPanelVisible && !matching"
    type="button"
    class="btn btn--small game__cardcounter-entry"
    :aria-expanded="ccShopOpen"
    @click="openCounterShop"
  >
    记牌器
  </button>
  ```
- 删掉 `.game__stage` 内的旧面板块，把其内容整体迁到页面末尾的弹层（与 `game__friends` 同层）：
  ```html
  <view
    v-if="ccShopOpen && !matching"
    class="game__cardcounter-mask"
    @click="ccShopOpen = false"
  >
    <view class="game__cardcounter" @click.stop>
      <view class="game__cardcounter-head">
        <text class="game__cardcounter-title">记牌器</text>
        <button type="button" class="btn btn--small game__cardcounter-close" @click="ccShopOpen = false">
          关闭
        </button>
      </view>
      <!-- 原面板内容原样迁入：金币场免费 / 单局卡 / 包时卡 / 门槛警告 / 加载失败 / ccError -->
    </view>
  </view>
  ```

样式（替换旧 `.game__cardcounter` 紧凑块）：

```scss
.game__cardcounter-mask {
  position: absolute;
  top: 0; right: 0; bottom: 0; left: 0;
  z-index: 10;                       /* 与 .game__friends 同档 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($ftl-color-night-deep, 0.62);
}
.game__cardcounter {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-3;
  width: 480px;
  max-height: 100%;
  padding: $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.game__cardcounter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
/**
 * 弹层里的「关闭」：**次按钮语言**（照抄 `.game__friends-close`）。
 * ⚠️ `margin: 0` 必需：`uni-button` 基样式带 `margin-left/right:auto`，
 *    在 `space-between` 的 flex 行里会吞掉富余宽度、按钮不贴右（本文件 :974-988 已登记同坑）。
 */
.game__cardcounter-close {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
```

运行测试 ⇒ **确认绿**。

### 1.3 提交

`feat(client): 记牌器购买面板改为顶栏入口 + 弹层（内容与购买逻辑不变）`

---

## Task 2：匹配门控（D4）

**Files**：`game.vue`、`card-counter-purchase.test.ts`

### 2.1 RED

新增用例「弹层打开后匹配开始 ⇒ 弹层强制关闭，且结束后不自动重开」：

```ts
const { wrapper, store } = await mountGame();
await openShop(wrapper);
expect(wrapper.find('.game__cardcounter').exists()).toBe(true);
store.setMatching(true);
await flushPromises();
expect(wrapper.find('.game__cardcounter').exists()).toBe(false);
store.setMatching(false);
await flushPromises();
expect(wrapper.find('.game__cardcounter').exists()).toBe(false);
wrapper.unmount();
```

运行 ⇒ 红（当前弹层只按 `ccShopOpen` 渲染，`setMatching` 不会关它）。

### 2.2 GREEN

```ts
/** 匹配开始 ⇒ 强制关闭购买弹层（匹配中不可购买，避免死按钮挡住取消匹配）。 */
watch(matching, (isMatching) => {
  if (isMatching) ccShopOpen.value = false;
});
```

弹层 `v-if` 保持 `ccShopOpen && !matching`（Task 1 已写）。运行 ⇒ 绿。

### 2.3 提交

`fix(client): 记牌器弹层在匹配开始时强制关闭`

---

## Task 3：入口提示圆点（D6 / 审查 H1）

**Files**：`game.vue`、`card-counter-purchase.test.ts`

### 3.1 RED

先扩展 `stubFetch`：`purchase` 支持 `'hang'`（永不 resolve 的 Promise），并新增可选的
`roomsThrows?: boolean`（Task 4 用）。新增三条用例（结尾都要 `wrapper.unmount()`）：

1. **待确认分支单独判红**（不依赖 `ccError`）：预存同用户、未过期待确认记录 + `purchase: 'hang'`
   ⇒ 挂载后 `.game__bar .game__cardcounter-entry .game__cardcounter-dot` 存在，且页面文本
   **不含**「结果确认中」（证明圆点来自 `ccPending` 而不是 `ccError`）。
2. **错误分支**：购买桩返回 10007 ⇒ 走完确认 ⇒ 入口有圆点（`ccError` 路径）。
3. **转移判据**：先 10007（失败 ⇒ 圆点在）→ 再用**成功桩**替换 `global.fetch` → 同 requestId 重试
   （不再弹确认框）→ 成功后圆点**消失**，且 `loadPendingCardCounterPurchase()` 为 null。
   （`stubFetch` 每次调用都会重新 `vi.stubGlobal('fetch', …)`，同一挂载内可换桩。）

运行 ⇒ 红（圆点元素不存在）。

### 3.2 GREEN

```ts
/** 是否存在「同用户、未过期」的待确认购买记录（入口提示点数据源）。 */
const ccPending = ref(false);
/** 购买错误 / 待确认订单 ⇒ 入口小圆点。 */
const ccAttention = computed(() => ccError.value !== "" || ccPending.value);

function refreshCardCounterPending(): void {
  const pending = loadPendingCardCounterPurchase();
  ccPending.value =
    pending !== null &&
    pending.userId === auth.userId &&
    Date.now() - pending.createdAt <= PENDING_CARD_COUNTER_TTL_MS;
}
```

接线：
- `onMounted`：`refreshCardCounterPending();`，并把 resume 改成
  `void resumePendingCardCounterPurchase().finally(refreshCardCounterPending);`
- `sendCardCounterPurchase` 的 `finally`：`purchasing.value = false; refreshCardCounterPending();`

模板入口按钮内：

```html
记牌器
<text v-if="ccAttention" class="game__cardcounter-dot" />
```

样式：

```scss
.game__cardcounter-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: $ftl-space-2;
  border-radius: 50%;
  background: $ftl-color-danger;
}
```

运行 ⇒ 绿。提交：`feat(client): 记牌器待确认/错误在入口显示提示圆点`

---

## Task 4：打开弹层刷新权益 + 页面级 error 让位（D7 / D9）

**Files**：`game.vue`、`card-counter-purchase.test.ts`

### 4.1 RED

1. 「打开弹层复拉权益」：统计 `/card-counter/status` 调用次数，`openShop` 后 +1；
2. 「页面级 error 让位」：用**可达**的错误源 —— `stubFetch({ roomsThrows: true })` 让 `/rooms`
   请求抛错，挂载后 `loadRooms()` 的 catch 写入 `.game__error`（「房间列表加载失败：…」）；
   `openShop` ⇒ 页面级 `.game__error` 不存在；关闭弹层 ⇒ 重新出现。
   ⚠️ **不得**用「`selectedBaseScore=null` ⇒ 点开始游戏」驱动：该按钮 `:disabled`，
   `@vue/test-utils` 2.5.1 的 `trigger` 对 disabled 元素是 no-op；且 `match()` 先取会话，
   本测试文件未 `startGameSession`，会在 error 之前先抛。

运行 ⇒ 红。

### 4.2 GREEN

```ts
function openCounterShop(): void {
  ccShopOpen.value = true;
  void loadCardCounterStatus(); // 弹层是天然刷新点（包时余量随时间变化）
}
```

错误行条件：`v-if="error && !friendsOpen && !ccShopOpen"`，并把该处注释的不变量扩成
「好友房 / 记牌器两个弹层打开时，页面级 error 都让位（弹层是全屏遮罩）；两弹层靠遮罩互相遮挡，
实际互斥；程序化同开时以最后渲染者为准」。

运行 ⇒ 绿。提交：`fix(client): 打开记牌器弹层刷新权益，页面错误行随弹层让位`

---

## 回归命令与预期

```bash
# 单文件（每个任务结束时；退出码即判据，不得吞错）
pnpm -C apps/client exec vitest run test/card-counter-purchase.test.ts   # 全绿

# 受影响面：所有挂载 GamePage 的测试文件
pnpm -C apps/client exec vitest run \
  test/card-counter-purchase.test.ts \
  test/card-counter.test.ts \
  test/card-counter-gate.test.ts \
  test/card-counter-charge-gate.test.ts \
  test/auth-ui-wiring.test.ts \
  test/friend-room-gate.test.ts \
  test/lobby-ux.test.ts \
  test/connection-dead.test.ts \
  test/page-stack.test.ts \
  test/ui-flow.test.ts \
  test/table-hud.test.ts                                            # 全绿

# 全量（推荐直接跑这条做受影响面的兜底）
pnpm -C apps/client test        # 期望 0 failed（跳过数维持 2）
pnpm -C apps/client run lint    # vue-tsc 退出 0
```

真机/真浏览器（交付前）：H5 构建 + SP200 走查 —— 开始游戏页主界面只剩「场次 + 开始游戏」；
顶栏「记牌器」可点开弹层；购买路径与牌桌入口行为不变。

## 验收清单（对照 spec）

- [ ] 主界面无购买框，入口在**顶栏**（`.game__bar` 作用域断言 + 不在 `.game__stage`），条件与旧面板一致（含旧服务端/免费场/开关关不渲染）
- [ ] 弹层内容 = 原面板内容；免费态/单价格/加载失败/门槛禁用文案不变
- [ ] 开合：入口开 / 遮罩关 / 面板内点不关 / 关闭按钮关；`aria-expanded` 翻转
- [ ] 匹配开始 ⇒ 弹层关闭且不自动重开
- [ ] 待确认（`ccPending` 单独判红）/ 错误 ⇒ 入口圆点；重试成功后圆点消失
- [ ] 打开弹层复拉权益；页面级 error 在弹层期间让位（用 `/rooms` 失败驱动）
- [ ] `.self` 源码闸 + 正对照通过
- [ ] 现有购买断言（requestId/幂等/expectedPrice/余额/14003）逐条保留且绿

## 计划审查记录

2026-10-19 独立对抗审查（reviewer 子代理）。结论：**需修订**。处置：

| 编号 | 级别 | 发现 | 处置 |
|------|------|------|------|
| B1 | 阻断 | 「页面级 error 让位」用例的驱动方式不可执行：`开始游戏` 在 `selectedBaseScore=null` 时 `:disabled`，`@vue/test-utils` 2.5.1 的 `trigger` 对 disabled 是 no-op；且 `match()` 先取 WS 会话（本文件未起会话）会先抛 | **修**：改用 `/rooms` 请求抛错驱动 `.game__error`（`stubFetch({ roomsThrows: true })`），Task 4.1 已重写 |
| H1 | 高 | 「受影响面」回归命令含不存在的 `test/game-session.test.ts`，且 `2>/dev/null || true` 会把真实红吞掉；漏掉挂载 GamePage 的多个文件 | **修**：删除恒绿写法；列出挂载面（auth-ui-wiring / friend-room-gate / lobby-ux / connection-dead / page-stack / ui-flow / table-hud），并以全量 `pnpm -C apps/client test` 兜底 |
| H2 | 高 | 入口/圆点断言用裸选择器 ⇒ 「入口挪出顶栏」也全绿 | **修**：断言 `.game__bar .game__cardcounter-entry`、`.game__stage` 内不存在、圆点带入口前缀；补 `aria-expanded` 翻转 |
| L1 | 低 | 「待确认」分支与 `ccError` 绑在同一场景 ⇒ 删掉 `ccPending` 仍绿 | **修**：用 `purchase: 'hang'` 让 `ccError` 保持空，单独钉 `ccPending` |
| L2 | 低 | 「成功后圆点消失」不在同一挂载内转移 ⇒ 判别力弱 | **修**：同一挂载内先 10007 失败、再换成功桩同号重试，断言圆点消失 |
| L3 | 低 | 新用例骨架未 `unmount` | **修**：所有新用例结尾 `wrapper.unmount()` |
| L4 | 低 | 「关闭」按钮缺 `margin: 0`/次按钮样式（uni-button auto 外边距坑） | **修**：补 `.game__cardcounter-close`（照抄 `.game__friends-close`） |
| L5 | 低 | 两弹层同开时 D9 注释不变量不成立 | **修**：注释写明「遮罩互相遮挡、实际互斥」 |
| L6 | 低 | 源码闸未写 import/扫描路径；`v-on:click.self` 是已知边界 | **修**：写明 import 与路径；已知边界登记 |

## 代码审查记录

2026-10-19 独立代码审查（reviewer 子代理，审 `51f905e..f983089`）。结论：**需修订**（无 Critical）。
处置：

| 编号 | 级别 | 发现 | 处置 |
|------|------|------|------|
| I1 | Important | `ccPending` 只在挂载/resume/finally 刷新；本页 `savePendingCardCounterPurchase()` 之后请求挂起时入口无圆点（D6/H1 缺口） | **修**：保存记录后立即 `refreshCardCounterPending()`；新增「请求挂起 + 关层 ⇒ 圆点在」用例 |
| M1 | Minor | 打开弹层复拉权益无请求序号，连续开合/与购买回写并发时旧响应可能覆盖新值（纯展示） | **登记接受**（不涉钱路径；挂载时本就有同类并发面） |
| M2 | Minor | 条件用例中「不含金币场免费」在默认价格下恒真 | **修**：删除该恒真断言；移到免费态用例的**开层前**断言（v-show 会立刻被抓） |
| M3 | Minor | `ccPending` 的「同用户/未过期」谓词无用例 | **修**：新增异用户、过期两条用例（无圆点 + resume 清记录） |
| M4 | Minor | 两处注释与实际行为不一致（error 落点、`ccPanelVisible` 条件） | **修**：注释改正 |
| M5 | Minor | 新弹层无 `role="dialog"`/`aria-modal`/Esc（与好友房弹层同族） | **登记接受**（本片不扩大 a11y 改造面） |
