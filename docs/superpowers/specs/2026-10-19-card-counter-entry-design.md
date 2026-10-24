# 记牌器购买入口改为「小入口 + 弹层」— 设计

- 日期：2026-10-19
- 范围：纯客户端（`apps/client/src/pages/game/game.vue`）
- 用户裁决：采用「小入口 + 弹层」（2026-10-19，三选一）

## 1. 背景 / 问题

选完底分进入「开始游戏」页后，中央区域在「开始游戏」大按钮**正下方无条件**挂一块
记牌器购买面板（标题 + 单局卡/包时卡两行价格 + 两个「购买」按钮）。
这一屏本来只有「场次 + 开始游戏」两件正经事，购买框直接压在主按钮下面，用户反馈**很违和**；
且没有购买意愿的玩家每次都要看到它。

目标：主界面恢复干净；记牌器仍然可见、可买；**购买逻辑零改动**（幂等 / 待确认订单 /
14003 预检 / 价格门控 / 服务端开局消费时机全部不动）。

## 2. 范围

**做**

- `game.vue`：顶栏入口按钮 + 购买弹层（现面板内容整体迁入）。
- `test/card-counter-purchase.test.ts`：条件矩阵改锚入口；新增开合/标记用例；购买类用例先开弹层。

**不做**

- 服务端 / 协议 / 配置键 / 价格 / 消费时机；
- 牌桌内的记牌器入口与横条（`table.vue`）；
- 「本局开关」式自动购买、菜单化收纳（用户已在三选一中否决）。

## 3. 决策表

| # | 决策 | 依据 |
|---|------|------|
| D1 | 入口 = 小按钮 + 弹层 | 用户 2026-10-19 裁决（三选一） |
| D2 | 位置 = 顶栏「返回大厅」右侧；文案逐字「记牌器」；专用锚点 `.game__cardcounter-entry`；`:aria-expanded="ccShopOpen"` | 与牌桌顶栏入口同形同文案（`table.vue` 的 `.table__counter`）；专用 class 防测试按 `.game__bar .btn` 索引取错（审查 L3） |
| D3 | 入口可见条件 = `ccPanelVisible && !matching`（沿用现面板条件） | 总开关开 + 金币场 + 两价格均为数值 + 未在匹配；匹配中不可购买（`buyCardCounter` 本就早退），隐藏优于「可点但静默无效」（审查 L2，接受标题位移） |
| D4 | 弹层渲染门控 = `ccShopOpen && !matching`；`watch(matching)` 为 true 时置 `ccShopOpen=false` | 防「匹配开始后留下挡住取消匹配/等待提示的死按钮弹层」；同 `table.vue` 对 `cardCounterGate` 的 watcher 范式（审查 H2） |
| D5 | 14009 价格刷新 ⇒ 弹层保持打开，错误行「价格已更新，请重新确认后购买」可见；价格行因 null 自然消失，用户手动关闭 | 错误行只能落在弹层内；关闭会丢提示（审查 H2） |
| D6 | 待确认/未知结局可见性：`ccError !== ''` 或存在**同用户、未过期**待确认记录 ⇒ 入口显示小圆点 `.game__cardcounter-dot`；错误文案仍在弹层内 | 面板收进弹层后，重挂载对账失败的提示会落在关着的弹层里、没人看见；钱路径要求未知结局可重试（审查 H1） |
| D7 | 打开弹层时复拉一次权益状态（`void loadCardCounterStatus()`） | 弹层是天然刷新点；`ccPassText` 的「约剩 N 分钟」随时间变化（审查 L4） |
| D8 | 遮罩关闭 = 裸 `@click` + 面板根 `@click.stop`；面板内另有「关闭」按钮；遮罩 z-index 10（与好友房弹层同档） | `.self` 在 uni-app H5 恒被吞（仓内环境事实）；z-index 同档有先例（`.game__friends`） |
| D9 | 页面级 `error` 行在弹层打开时让位：`v-if="error && !friendsOpen && !ccShopOpen"`，并更新该处不变量注释 | 「弹层打开时 error 必须盖在弹层里」的既有不变量随第二个弹层扩展（审查 L1）；记牌器弹层不承载页面级 error |
| D10 | 购买成功/失败 = 弹层保持打开、就地刷新；`purchasing/confirming` 禁用逻辑不变 | 与现面板行为一致，用户可继续买另一种或直接关层 |
| D11 | 弹层内容沿用现有结构与文案锚点：面板根 `.game__cardcounter`、购买按钮 `.game__cardcounter-buy`、「金币场免费」「单局卡」「包时卡」「权益信息加载失败」等文案逐字保留 | 少改既有断言锚点，避免测试重写扩散 |

## 4. 实现设计（`game.vue`）

**script**

- 新增 `const ccShopOpen = ref(false)`。
- 新增 `const ccPending = ref(false)`：挂载时由 `loadPendingCardCounterPurchase()` 初始化；
  购买保存/清除待确认记录处与 `resumePendingCardCounterPurchase()` 同步维护。
- `ccAttention = computed(() => ccError.value !== '' || ccPending.value)`（D6 圆点）。
- `watch(matching, (m) => { if (m) ccShopOpen.value = false; })`（D4）。
- 打开弹层：`function openCounterShop() { ccShopOpen.value = true; void loadCardCounterStatus(); }`（D7）。
- 购买逻辑（`buyCardCounter` / `sendCardCounterPurchase` / `resumePendingCardCounterPurchase`）**不改**。

**template**

- `.game__bar`：`返回大厅` 之后插入
  `<button v-if="ccPanelVisible && !matching" class="btn btn--small game__cardcounter-entry" :aria-expanded="ccShopOpen" @click="openCounterShop">记牌器<text v-if="ccAttention" class="game__cardcounter-dot" /></button>`。
- 页面末尾（`friends` 弹层同层）：弹层
  `<view v-if="ccShopOpen && !matching" class="game__cardcounter-mask" @click="ccShopOpen = false">` +
  `<view class="game__cardcounter" @click.stop>`（D8）。
- 面板内容 = 现 `.game__cardcounter` 的现有内容整体迁入，另加标题行右侧「关闭」按钮。
- 错误行条件改为 `error && !friendsOpen && !ccShopOpen`（D9）。

**样式**

- `.game__cardcounter-entry`：沿用 `btn btn--small`；`.game__cardcounter-dot`：小圆点（`$ftl-color-danger`）。
- `.game__cardcounter-mask`：`position: absolute; inset: 0; z-index: 10; flex center; background: rgba($ftl-color-night-deep, 0.62)`。
- `.game__cardcounter`：由「紧凑内嵌块」改为弹层面板（加宽到 480px、`$ftl-space-6` 内边距、
  深蓝半透明底 `rgba($ftl-color-night, 0.62)`、`max-height: 100%` + `overflow-y: auto`）。

## 5. 测试判据（`test/card-counter-purchase.test.ts`）

1. **条件矩阵（改锚 `.game__cardcounter-entry`）**
   - 开关开 + 金币场 + 两价数值 ⇒ 入口存在；旧服务端（null）/ 免费场（random）/ 开关关 ⇒ 入口不存在。
   - 默认（弹层关）⇒ 弹层内容选择器**不在 DOM**（钉死 `v-if` 语义，不许用 `v-show` 蒙混）。
2. **开层后内容**（每格都要先打开弹层再断言）
   - 免费态（两价皆 0）⇒ 文案「金币场免费」且 `.game__cardcounter-buy` 数量 = **0**；
   - 单价格 ⇒ 1；双价格 ⇒ 2；
   - 门槛不足 ⇒ 对应购买按钮禁用；
   - 状态加载失败 ⇒ 文案「权益信息加载失败」；
   - 购买错误 / 待确认文案在弹层内可见。
3. **开合**
   - 点入口 ⇒ 打开；点遮罩 ⇒ 关闭；点面板内部 ⇒ **不**关闭；点「关闭」⇒ 关闭；
   - `store.setMatching(true)` ⇒ 弹层消失；再置 false ⇒ **不自动重开**。
4. **入口标记（D6）**
   - 注入同用户、未过期待确认记录 ⇒ 挂载后入口有 `.game__cardcounter-dot`；
   - `ccError` 非空（如状态/购买失败路径）⇒ 同样有标记。
5. **`.self` 源码闸**（照抄 `more-menu.test.ts` 194-212 的形态）
   - `game.vue` 不含 `@click.self`（含正对照）；遮罩是裸 `@click`；面板根有 `@click.stop`。
6. **购买路径**：全部现有用例改为「先打开弹层再点 `.game__cardcounter-buy`」；
   requestId / 幂等 / expectedPrice / 余额回写 / 14003 预检断言**逐条保留**。

## 6. 错误处理与边界

| 情形 | 行为 |
|------|------|
| 两价格 null（旧服务端） | 入口不渲染（`ccPanelVisible` 为假） |
| 免费态（0/0） | 入口渲染；弹层只有「金币场免费」+「关闭」 |
| 状态加载失败 | 入口渲染；弹层内「权益信息加载失败（不影响购买）」 |
| 未知结局（网络/10007） | 待确认记录保留；入口圆点；弹层内可重试文案；同 requestId 重试 |
| 14009 价格已变 | 弹层保持打开、错误可见；价格行消失；用户关闭后从入口重进 |
| 匹配中 | 入口隐藏、弹层强制关闭（不可购买，避免死按钮） |
| 弹层打开时外部触发匹配成功 | `watch(matching)` 关闭弹层 |
| 弹层打开时页面级 error | 页面 error 行让位（D9），关层恢复 |

## 7. 风险

- **曝光下降**：购买入口从主界面正中收进顶栏小按钮，曝光降低（用户已裁决接受）。
- **顶栏位移**：匹配中入口隐藏会让「斗地主」标题左移（与现面板隐藏等价，接受）。
- **遮罩层级**：弹层遮罩会盖住 `SessionNotice` / `ConnectionDeadBar`（与好友房弹层行为一致，关闭即恢复）。

## 8. 涉及文件

- `apps/client/src/pages/game/game.vue`
- `apps/client/test/card-counter-purchase.test.ts`

## 9. 审查记录

2026-10-19 独立对抗审查（reviewer 子代理，只审不改）。结论：**需修订**。处置如下：

| 编号 | 级别 | 发现 | 处置 |
|------|------|------|------|
| H1 | 高 | 待确认/未知结局错误在弹层关闭态不可见（`ccError` 唯一渲染点在面板内） | **修**：D6 入口小圆点（`ccError` 或待确认记录）+ 测试判据 4 |
| H2 | 高 | 弹层若只按 `ccShopOpen` 渲染，匹配开始后留下死按钮弹层并挡住取消匹配/等待提示；14009 刷新语义未定义 | **修**：D4 门控 `&& !matching` + watcher；D5 14009 保持打开；测试判据 3 |
| H3 | 高 | 内容搬进 `v-if` 弹层后，`toHaveLength(0)` 与「匹配中不存在」两处断言变成真空断言 | **修**：测试判据 1/2/3 逐格改写（开层后断言、关态不在 DOM、开合与自动关闭） |
| L1 | 低 | 页面级 `error` 在弹层打开时落到遮罩后，既有「error 必须在弹层内」不变量失真 | **修**：D9 |
| L2 | 低 | 匹配中入口隐藏导致顶栏位移、期间看不到权益状态 | **登记接受**（与现面板等价；改禁用态需产品裁决） |
| L3 | 低 | 入口缺稳定测试锚点与 `aria-expanded` | **修**：D2 |
| L4 | 低 | 打开弹层不刷新权益状态；`.self` 源码闸未纳入 | **修**：D7；测试判据 5 |
