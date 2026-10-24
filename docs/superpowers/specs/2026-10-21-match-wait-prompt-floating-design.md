# 匹配等待提示：底部悬浮卡片（设计 spec）

- 日期：2026-10-21
- 分支：`dev`
- 范围：纯客户端展示层 + 服务端一句面向玩家的文案常量；**不动协议消息名/载荷/状态机**
- 相关代码：`apps/client/src/pages/game/game.vue`、`packages/room-service/src/match/match.service.ts`、
  `docs/client-protocol.md`

## 1. 背景与问题

服务端在「缺人补机器人」运营开关关闭、真人凑不齐 3 人时，入队约 30 秒后推
`match.wait_prompt`。当前客户端把它渲染在 `.game__stage` 的文档流内、`.game__match` 下方
（`game.vue` 模板 834–854 行、样式 1256–1299 行）：

1. **挤 UI**：提示块参与布局，出现时把中央场次/底分/开始游戏整块往上推；这正是 2026-10-13
   用户对会话提示提过的同一个问题（当时已把 `.game__notice` 改为悬浮胶囊）。
2. **文本拥挤**：卡片固定 320px 宽、内边距 8px，主文案 28px 要折 3 行；两个按钮各约 150px，
   「延长匹配时间」6 个字被迫折成两行（用户截图 `1.png` 的实机形态）。
3. **暴露机器人**：服务端文案常量逐字为「当前在线真人玩家不足，可延长匹配时间继续等待，或重新匹配」，
   直接告诉玩家存在「真人 / 机器人」两套匹配池。用户明确要求不能让玩家知道是匹配机器人。

## 2. 范围

### 做

- 服务端 `MATCH_WAIT_PROMPT_MESSAGE` 改为友好文案，去掉「真人/机器人/玩家不足」表述。
- 客户端等待提示改为**底部居中悬浮卡片**，`position: absolute`，不参与文档流。
- 卡片视觉重做：深蓝玻璃态底、金色描边、顶部内高光、柔和投影；文案 28px、行高 1.5，
  单行不拥挤；两个 56px 高按钮。
- 主按钮文案「延长匹配时间」→「继续等待」（更口语化）；次按钮「重新匹配」保持不变。
- 新增加轻量上浮入场动画，并纳入 `prefers-reduced-motion` 降级。
- 同步 `docs/client-protocol.md` 中对按钮文案的描述。
- 更新/新增测试：文案、按钮、悬浮定位、DOM 不在 `.game__stage` 内、服务端文案不含机器人词。

### 不做（YAGNI）

- 不改 `match.wait_prompt` / `room.match.extend` / `room.unmatch` / `room.match` 的协议形状与语义。
- 不改服务端 30 秒提示窗口、总等待上限、补机器人开关、12007 行为。
- 不加重试/自动延长/关闭按钮；提示仍由服务端推送与匹配生命周期收口。
- 不改记牌器/好友房/会话提示等其它浮层。
- 不引入新的图片资源或第三方组件。

## 3. 方案对比与决策

### 3.1 展示形态（用户已裁决）

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 底部居中两行悬浮卡片 | 第一行图标+文案，第二行两个按钮；不遮挡中央控件、离「取消匹配」最近 | **采用** |

> ⚠️ 采用 A 的前提：匹配中「好友房」入口虽然 `disabled`，但仍在文档流里占 88px
>（`game.vue:870-878`，`friendRoomEnabled=true` 是受支持配置）。悬浮卡片会压住它约 34px
> ⇒ 匹配中给入口加 `visibility: hidden`（保留布局盒，避免中央区跳 52px），见 D9。
| B. 底部单行横向条 | 更小更轻，但按钮与文案挤在一行，长文案时更易拥挤 | 否决 |
| C. 居中带遮罩弹层 | 最有仪式感，但会盖住「正在匹配 / 取消匹配」，且必须先处理 | 否决 |

### 3.2 文案真源

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 改服务端常量，客户端继续原样呈现 | 保持「服务端文案唯一真源」的既有纪律；日志/协议文档/客户端同源 | **采用** |
| B. 客户端忽略服务端文案、本地自编 | 会形成第二真源；服务端改文案时客户端不同步 | 否决 |

### 3.3 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | `MATCH_WAIT_PROMPT_MESSAGE = '正在为你安排牌桌，请稍等片刻。'` | 友好、中性、不提真人/机器人；**15 字**在 640px 卡片内稳定单行；测试钉长度 ≤ 16 |
| D2 | 提示层 `position: absolute` + `bottom: calc($ftl-control-h-sm + $ftl-space-6)`（=72）+ 居中；`pointer-events: none`，卡片自身 `pointer-events: auto` | 不参与文档流；不挡下层点击；底边距玩家信息条顶边约 12px，顶边在「取消匹配」下方约 8px（真实 `uni-button` 盒模型） |
| D3 | `z-index: 5` | 与 `.game__notice` 同档；低于好友房/记牌器弹层（`z-index: 10`），弹层该赢；源码判据钉住 |
| D4 | 卡片宽 640px、内边距 12/20px、主文案 28px/行高 1.5、按钮 56px | 15 字单行；按钮各约 294px，4 字文案不折行；视觉与好友房面板同族 |
| D5 | 按钮沿用页面既有 `.btn` / `.btn--small` / `.btn--primary` 语言 | 与 2026-10 UI 重设计的拟物金主按钮一致，不再维护一套旧按钮样式 |
| D6 | 新增 `ftl-float-up` 关键帧 + `.anim-float-up`，只动 `transform`，起始态可见；加入 reduced-motion 降级 | 符合 `animations.scss` 的「起始态必须可见 / 只动 transform」纪律；降级判据按媒体查询块解析，不做全文 `toContain` |
| D7 | 主按钮「继续等待」仍发 `room.match.extend`；次按钮「重新匹配」仍先 `room.unmatch` 再走唯一 `match()` | 行为零变化，只改文案与视觉 |
| D8 | 协议文档把「延长匹配时间」改为「继续等待」，并注明浮层形态；`docs/design.md` 同步 | 防止文档成为过期的第二真源；用可执行的文档文案判据（C13）钉住 |
| D9 | 匹配中给「好友房」入口加 `visibility: hidden`（保留布局盒） | 卡片不压可见控件；不产生中央区 52px 重排；`visibility:hidden` 同时移出命中与无障碍树 |
| D10 | 定位上下文明确依赖 `.canvas`（`.game` 是 static，不是包含块） | 未来若给 `.game` 加 `position/transform`，锚点会静默变化；写进 spec 防误改 |

## 4. 实现设计

### 4.1 服务端

`packages/room-service/src/match/match.service.ts:78`：

```ts
export const MATCH_WAIT_PROMPT_MESSAGE = '正在为你安排牌桌，请稍等片刻。';
```

注释同步：说明「面向玩家的友好文案，不提真人/机器人；补机器人开关关闭时由
`match.wait_prompt` 下发」。不改任何匹配逻辑。

### 4.2 客户端模板（`game.vue`）

把等待提示从 `.game__stage` 内移出，作为 `.game` 根下的独立浮层（放在 `PlayerChip` 之后、
好友房弹层之前），并保留既有类名锚点（`.game__waitprompt` / `.game__waitprompt-text` /
`.game__waitprompt-btn`），新增 `.game__waitprompt-layer`、`.game__waitprompt-main`、
`.game__waitprompt-icon`：

```html
<!-- 缺人等待提示：底部悬浮卡片，不参与文档流。 -->
<view v-if="waitPrompt && !error && !connectionDead" class="game__waitprompt-layer">
  <view class="game__waitprompt anim-float-up">
    <view class="game__waitprompt-main">
      <text class="game__waitprompt-icon" aria-hidden="true">⏳</text>
      <text class="game__waitprompt-text" role="status">{{ waitPrompt }}</text>
    </view>
    <view class="game__waitprompt-actions">
      <button
        type="button"
        class="btn btn--small game__waitprompt-btn"
        :disabled="busy"
        @click="rematchAfterPrompt"
      >
        重新匹配
      </button>
      <button
        type="button"
        class="btn btn--primary btn--small game__waitprompt-btn"
        :disabled="busy"
        @click="extendMatching"
      >
        继续等待
      </button>
    </view>
  </view>
</view>
```

⚠️ 不把浮层放进 `.game__stage`：中央区继续由 `justify-content: center` 排版，提示显隐不再
改变场次/底分/按钮的位置。⚠️ 浮层放在 `.game__match` 外面：既有探针按
`.game__match button` 取唯一按钮（「取消匹配」）。

⚠️ **错误/死态优先（代码审查 I2）**：
- 页面错误行改为 `v-if="error && !friendsOpen && !ccShopOpen && !waitPrompt"`；
  卡片在 `error` 时卸载 —— 否则错误行落在卡片下方被完全盖住。
- 玩法页的死态横条改为**顶部悬浮**：`<ConnectionDeadBar class="game__deadbar" @dead-change="connectionDead = $event" />`；
  `ConnectionDeadBar` 新增 `dead-change` 事件（判断仍收在组件里，R455），页面只消费事件。
  死态时卡片卸载（连接已死，卡片按钮发不出去）。

同时给「好友房」入口加匹配态隐藏类（保留布局盒）：

```html
<button
  v-if="store.friendRoomEnabled"
  type="button"
  class="btn game__friends-open"
  :class="{ 'game__friends-open--matching': matching }"
  :disabled="busy || matching"
  @click="friendsOpen = true"
>
  好友房
</button>
```

```scss
/** 匹配中：入口禁用且被底部悬浮卡片压住 ⇒ 视觉隐藏但保留 88px 布局盒。 */
.game__friends-open--matching {
  visibility: hidden;
}
```

死态横条在玩法页改为**顶部悬浮**（不参与文档流）：

```scss
/**
 * 死态横条：玩法页顶部悬浮（不参与文档流）。
 * 留在文档流会把中央区下移 30px，与底部等待卡片重叠（代码审查 I2）。
 */
.game__deadbar {
  position: absolute;
  top: calc($ftl-bar-h + $ftl-space-6);
  right: $ftl-space-5;
  left: $ftl-space-5;
  z-index: 6;
}
```

### 4.3 客户端样式（`game.vue`）

替换 1256–1299 行的 `.game__waitprompt*` 规则（止于 `.game__waitprompt-btn[disabled]`，不含 `.game__player`）：

```scss
/** 缺人等待提示：底部悬浮层（不参与文档流；与 `.game__notice` 同族的悬浮手法）。 */
.game__waitprompt-layer {
  position: absolute;
  right: 0;
  bottom: calc($ftl-control-h-sm + $ftl-space-6);
  left: 0;
  z-index: 5;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.game__waitprompt {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 640px;
  max-width: calc(100% - 2 * $ftl-space-9);
  padding: $ftl-space-5 $ftl-space-7;
  border: $ftl-hairline solid rgba($ftl-color-gold-light, 0.55);
  border-radius: $ftl-radius-lg;
  background: linear-gradient(
    160deg,
    rgba($ftl-color-night-soft, 0.94),
    rgba($ftl-color-night-deep, 0.96)
  );
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.5),
    inset 0 2px 0 rgba(255, 215, 0, 0.18);
  backdrop-filter: blur(20px);
  pointer-events: auto;
}
.game__waitprompt-main {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-4;
}
.game__waitprompt-icon {
  flex: 0 0 auto;
  font-size: $ftl-font-xl;
  line-height: 1;
}
.game__waitprompt-text {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  line-height: 1.5;
  text-align: center;
}
.game__waitprompt-actions {
  display: flex;
  gap: $ftl-space-5;
}
.game__waitprompt-btn {
  flex: 1;
  margin: 0;
  /* uni-button 基样式 line-height:2.5555；不压回去会把 56px 的按钮撑到 70px。 */
  line-height: 1.2;
}
```

说明：
- `bottom` 用 `$ftl-control-h-sm (56) + $ftl-space-6 (16) = 72`；卡片含边框高约 138。
  真实 H5/微信的 `uni-button` 基样式是 `box-sizing: border-box; line-height: 2.5555` ——
  26px 字号的行盒 66.4px 会顶掉 `min-height: 56`，所以按钮必须显式 `line-height: 1.2`
  （代码审查 I1）。修后 750 高设计画布下顶边约 y=540，底边 y=678；玩家信息条顶边约
  y=690（chip 高 56 + `.game` 底 padding 4）⇒ 净空约 12px；无好友房时「取消匹配」底边
  约 y=531.6，净空约 8.4px；好友房开启时中央区因入口占位整体上移，净空更大。
  **两种配置都不重叠**。
- 640px 宽 + 28px 字号：**15 字**文案单行；两按钮各约 294px，4 字不折行。
- `max-width` 兜底窄画布；长文案可折行，卡片向上生长。
- 层的 `pointer-events: none` 保证空白区域不拦截点击；卡片自身恢复 `auto`。
- **定位上下文是 `.canvas`**（`LandscapeStage.vue:223-230`，`position: relative`）：`.game`
  本身是 `static`，不是包含块。今天 `.game` 填满 canvas、几何等价；未来不得给 `.game`
  加 `position/transform`（会静默换锚点）。
- 玻璃态与 `Panel.vue` / 好友房面板同族（深蓝半透明 + 金色描边 + 顶部内高光 + `blur`）。

### 4.4 动效

`apps/client/src/styles/animations.scss` 新增：

```scss
/** 底部浮层入场：轻微上浮（只动 transform，起始态可见）。 */
@keyframes ftl-float-up {
  from {
    transform: translateY(12px);
  }
  to {
    transform: none;
  }
}

.anim-float-up {
  animation: ftl-float-up .24s $ftl-ease both;
}
```

并把 `.anim-float-up` 加入 `@media (prefers-reduced-motion: reduce)` 的禁用清单。

### 4.5 协议文档

`docs/client-protocol.md` §4.3 第 10 条与 §5 第 11 条：
- 「延长匹配时间」→「继续等待」；
- 「弹窗」→「底部悬浮卡片」，并注明主文案由服务端 `message` 原样呈现。

`docs/design.md:980,991` 同步更新动作名与展示形态（该文档自称唯一设计依据，不能留旧文案）。

### 4.6 不做后端逻辑改动

`match.service.ts` 只改常量值；`ws.gateway.ts`、`match` 队列逻辑、`room.match.extend` 处理均不动。

## 5. 测试判据

### 5.1 客户端（行为级）

在 `apps/client/test/auth-ui-wiring.test.ts` 的 waiting-prompt describe 中：

- C1：`match.wait_prompt` 到达后 `.game__waitprompt-layer` 与 `.game__waitprompt` 存在，
  `.game__waitprompt-text` 逐字等于服务端 message。
- C2：`.game__stage .game__waitprompt` **不存在**，且 `.game > .game__waitprompt-layer`
  **存在** —— 浮层是 `.game` 的直接子元素（不参与中央舞台布局的 DOM 结构证据；
  「直接子元素」防止以后有人误放进顶栏/其它浮动区仍绿）。
- C3：按钮文案逐字为 `['重新匹配', '继续等待']`；
  `wrapper.findAll('.game__match button')` **长度恰为 1** 且文本为「取消匹配」
  （用数量断言，不用 `find` 的第一个命中）。
- C4：点「继续等待」发 `room.match.extend`，ack 0 后浮层消失、仍匹配中、不发 unmatch/新 match。
- C5：点「重新匹配」先发 `room.unmatch`（ack 0）再发 `room.match`，浮层消失。
- C6：未匹配时收到推送不显示；12007 终止后浮层消失（保留既有断言）。
- C14：`friendRoomEnabled=true` 时进入匹配，`.game__friends-open` 带
  `game__friends-open--matching` 类（视觉隐藏但保留布局）；匹配结束（取消 / 12007）后类消失。

### 5.2 客户端（源码级）

在 `apps/client/test/notice-presentation.test.ts` 增加 awaiting-prompt 的展示判据
（复用 `ruleBody`）：

- C7：`.game__waitprompt-layer` 的样式必须含 `position: absolute` 与 `z-index: 5`；
  附合成样本正反对照，证明判据有判别力。
- C8：`.game__waitprompt-layer` 必须含 `pointer-events: none`，`.game__waitprompt` 必须含
  `pointer-events: auto`（防止全宽层拦截点击）；同样附「缺 pointer-events」的负样本对照。

在 `apps/client/test/animations.test.ts` 增加（**不要全文 `toContain`**）：

- C9：
  1. 用花括号配对截出 `@media (prefers-reduced-motion: reduce) { … }` **块内文本**，
     断言其中含 `.anim-float-up`；
  2. 合成正反对照：类在媒体查询外 ⇒ 判据 false；在块内 ⇒ true；
  3. `@keyframes ftl-float-up` 存在，且块体内无 `opacity: 0`（起始态可见）；
  4. `game.vue` 源码实际出现 `anim-float-up`（防「定义了但没用上」的死动画）。

### 5.3 服务端

- C10：`MATCH_WAIT_PROMPT_MESSAGE` 逐字等于 `'正在为你安排牌桌，请稍等片刻。'`，
  且 `length <= 16`（长度是布局安全的一部分：2 行会压住取消按钮）。
- C11：该常量**不包含**「真人」「机器人」「玩家不足」任一子串（面向玩家文案的红线，
  防回归到旧文案）；把旧文案作为负样本喂给同一谓词，必须命中（证明判据有判别力）。
- C12（实现纪律，无独立判据）：`ws.gateway.test.ts` 的 fixture **import 常量**
  （不再写第二份字面量）。网关信封形状由既有 `toEqual` 钉住，不在本片重复造判据。

### 5.4 文档

在 `apps/client/test/protocol-doc-sync.test.ts`（或新增 `docs-copy-sync.test.ts`）增加：

- C13：
  1. **按消息名列**（表格第二列）抓取 `docs/client-protocol.md` §4.3 的
     `room.match.extend` 行与 §5 的
     `match.wait_prompt` 行，断言含「继续等待」「悬浮卡片」，且**不含**「延长匹配时间」
     作为动作名、不含「弹窗」作为展示形态；
  2. 对 `docs/design.md` 的两行做同样断言；
  3. 正反对照：把旧行文本喂给同一谓词 ⇒ 必须 false（模式照抄
     `protocol-doc-sync.test.ts` 的判别力自证段）。

### 5.5 代码审查补充判据（I1/I2）

- C15：`.game__waitprompt-btn` 必须含 `line-height: 1.2`（真实 `uni-button` 基样式
  `line-height: 2.5555` 会把 56px 按钮撑到 70px，卡片压住取消按钮）。
- C16：`.game__deadbar` 必须 `position: absolute`，且模板把宿主类挂到
  `<ConnectionDeadBar class="game__deadbar" />`（死态横条不再把中央区下移）。
- C17：页面错误行的 `v-if` 必须含 `!waitPrompt`，卡片的 `v-if` 必须含 `!error`
  （错误行不被卡片盖住）。
- C18：死态时等待卡片卸载（`connection-dead.test.ts` 行为级；`ConnectionDeadBar`
  通过 `dead-change` 事件上报，页面不直接读连接状态 —— R455）。

## 6. 错误处理与边界

| 边界 | 处理 |
|---|---|
| 服务端文案变长 | 卡片 `max-width` 限制宽度、文字折行、卡片向上生长；不横向溢出。超过 16 字会压到取消按钮 ⇒ C10 钉长度 |
| 匹配终止 / 成局 / 取消 | store 清 `matchWaitPrompt`，`v-if` 卸载浮层（既有行为） |
| 好友房入口 | 匹配中 `visibility: hidden`（D9/C14）：不压可见控件，保留 88px 布局盒避免中央区跳动 |
| 记牌器入口 / 两个全屏弹层 | 记牌器入口匹配中本就不渲染；弹层 `z-index: 10` 盖过浮层，无同屏冲突 |
| 全宽浮层挡点击 | 层 `pointer-events: none` + 卡片 `auto`（判据 C8） |
| 玩家信息条 / 取消匹配 | 浮层底边在信息条上方约 12px；顶边在取消按钮下方约 8px（无好友房时） |
| `busy` 中重复点按 | 两个按钮沿用 `:disabled="busy"`，与既有实现一致 |
| 降级动画 | `prefers-reduced-motion` 关闭动画，元素仍在原位可见 |
| 多端 | 只用 uni-app 的 `view`/`text`/`button` 与既有 CSS 能力；定位上下文是 `.canvas`（D10） |

## 7. 风险

1. **观感只能靠截图证明**：jsdom 不注入 CSS。实现后用真浏览器/静态复现截图复核
   卡片位置、文字折行、按钮不折行、好友房入口隐藏；不以单测代替观感结论。
2. **高度窗口很窄**：真实 `uni-button` 盒模型下，750 设计高时取消按钮与玩家信息条之间约 158px；本方案卡片约 138px。
   若未来把文案改长到 2 行，卡片会与取消按钮重叠 ⇒ 文案长度是本设计的一部分（C10 钉住）。
3. **`pointer-events` 在 uni-app 多端的行为**：H5/微信小程序均支持；真机走查确认空白区
   不拦截「取消匹配」。若某端不支持，命中带是**整条全宽层**（不是卡片宽度），但它位于
   底部、下方只有已隐藏的好友房占位，不产生功能性死按钮；仍会在走查中记录。
4. **BOM**：`game.vue` 本身带 UTF-8 BOM（8bdddbdc 统一的是另外 6 个 .vue）；编辑后
   必须核对字节未丢失（仓库无机器闸，人工核对）。
5. **低优先级登记（不阻塞本片）**：
   - `rematchAfterPrompt` 在 blocked 分支前清提示（既有行为），浮层会更醒目地消失；
   - unmatch 在途时迟到的 `match.wait_prompt` 可能让浮层短暂重现；
   - `.btn--small` 56 设计 px 在 k≈0.52 时约 29 CSS px，触控目标偏小（顶栏既有按钮同款，
     非本片引入）；
   - 服务端/客户端若干内部注释仍写「延长匹配时间 / 弹窗」，按需顺手清理，不影响行为。

## 8. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/room-service/src/match/match.service.ts` | 改常量值与注释 |
| `packages/room-service/test/ws.gateway.test.ts` | fixture import 常量 |
| `packages/room-service/test/match.service.test.ts` | 新增文案红线/长度用例 |
| `apps/client/src/pages/game/game.vue` | 模板移出 + 样式重做 + 好友房匹配态隐藏类 + 死态横条悬浮/错误让位 |
| `apps/client/src/components/ConnectionDeadBar.vue` | 新增 `dead-change` 上报（R455：判断仍收在组件） |
| `apps/client/test/connection-dead.test.ts` | C18：死态时等待卡片让位 |
| `apps/client/src/styles/animations.scss` | 新关键帧 + 降级清单 |
| `apps/client/test/auth-ui-wiring.test.ts` | 行为断言更新（C1–C6、C14、C14b） |
| `apps/client/test/notice-presentation.test.ts` | 悬浮/z-index/pointer-events/line-height/死态/错误让位（C7/C8/C14b–C17） |
| `apps/client/test/match-state.test.ts` | 样例文案更新 |
| `apps/client/test/animations.test.ts` | reduced-motion 块内成员 + keyframe + backwards + 使用点（C9） |
| `apps/client/test/protocol-doc-sync.test.ts` | 文档文案/形态判据（C13） |
| `apps/client/src/composables/useGameSession.ts`、`src/net/session.ts`、`src/stores/game.ts` | 内部注释同步 |
| `admin/app.js`、`tools/mock-server/src/index.ts` | 运营/mock 文案同步 |
| `docs/client-protocol.md` | 按钮文案 + 浮层说明 |
| `docs/design.md` | 同步动作名与展示形态 |
| `docs/ops/first-deploy.md` | 运维文档动作名同步（1030/1032 行） |

## 9. 对抗审查记录

### 9.1 第一轮（独立 reviewer，2026-10-21）

结论：**需修订**（无阻断）。发现与处置：

| 级别 | 发现 | 处置 |
|---|---|---|
| 高 | 匹配中「好友房」入口只是 disabled、仍占 88px；卡片会压住它约 34px（`game.vue:870-878`） | **已修**：D9/C14，匹配中 `visibility: hidden` 保留布局盒；§6/§7 按两种配置重算 |
| 高 | C9 原写法（全文 `toContain('.anim-float-up')`）恒真，且不验 keyframe/使用点 | **已修**：C9 改为截取媒体查询块 + 正反对照 + keyframe + game.vue 使用点 |
| 高 | C13 无可执行落点；`docs/design.md:980,991` 仍为旧文案 | **已修**：C13 落到 `protocol-doc-sync.test.ts`；§8 增加 `docs/design.md` |
| 高 | C3 的「`.game__match button` 唯一」用 `find` 只取首个，非数量断言 | **已修**：C3 改为 `findAll` 长度恰为 1 |
| 低 | pointer-events 降级措辞不准确（命中带是全宽层） | **已修**：§7 风险 3 改写 |
| 低 | 文案实为 15 字；2 行会压取消按钮且无长度判据 | **已修**：D1/§4.3 改为 15 字，C10 增加 `length <= 16` |
| 低 | 卡片底边与玩家信息条仅约 4px 净空 | **已修**：bottom 68→76（净空约 12px），§4.3 重算 |
| 低 | 定位上下文实际是 `.canvas`，spec 未写明 | **已修**：D10/§4.3 写明 |
| 低 | BOM 括注不准确（game.vue 本来就带 BOM） | **已修**：§7 风险 4 |
| 低 | 其它注释旧文案、unmatch 竞态、触控目标等 | **登记**：§7 风险 5，不阻塞 |
| 低 | C8/C11/C12 判据可补强 | **已修**：C8 负样本、C11 旧文案负样本、C12 fixture import 常量 |

未发现阻断项：协议消息名/载荷/状态机、匹配生命周期、唯一 `room.match` 发送点均未受影响。

## 10. 代码审查记录（实现后，独立 reviewer）

结论：**需修订**（无 Critical；2 项 Important 已修，9 项 Minor 已处置/登记）。

| 编号 | 级别 | 发现 | 处置 |
|---|---|---|---|
| I1 | Important | 真实 `uni-button` 基样式 `line-height:2.5555` 使 56px 按钮实高 70.4px，卡片 top 521.6，压住默认配置的取消按钮 10px；静态截图未复现该盒模型，观感假绿 | **已修**：按钮加 `line-height:1.2`；`bottom` 72；真实盒模型重算 + 重截图；C15 钉住 |
| I2 | Important | 死态横条在文档流里把中央区下移 30.2px，卡片压取消按钮 40.2px；页面级 error 行被卡片完全盖住 | **已修**：死态横条改顶部悬浮 + `ConnectionDeadBar` 上报 `dead-change`；错误/死态时卡片卸载；C16–C18 钉住 |
| M1 | Minor | `role="status"` 放在含按钮的整卡上 | 已修：移到 `.game__waitprompt-text` |
| M2 | Minor | `.anim-float-up` 用 `both`，forwards 填充会压住未来 hover transform | 已修：改 `backwards`，C9 钉住 |
| M3 | Minor | C9 关键帧判据未验 `to { transform:none }`/`scale(0)`/`visibility` | 已修：补断言与负样本 |
| M4 | Minor | C14 只测 12007，没测取消分支 | 已修：新增 C14b（取消 ack 0） |
| M5 | Minor | 运营端 admin 文案仍写「延长匹配时间」 | 已修：三处改「继续等待」 |
| M6 | Minor | 内部注释/计划收口清单仍含旧动作名 | 已修：客户端注释、测试注释、mock-server、计划预期同步 |
| M7 | Minor | design.md「继续等待匹配提示窗口」有歧义 | 已修：改为「『继续等待』动作：平移提示窗口」 |
| M8 | Minor | `d3530130` commit message 与 diff 不符 | 已修：amend 为「spec 的 calc 写法与实现同步」 |
| M9 | Minor | 计划收口未勾选/观感项假绿 | 已修：执行期回填 + 真实盒模型截图后勾选 |

观感证据（gitignored）：`.superpowers/sdd/2026-10-21-match-wait-prompt-floating/`
`preview-final.png`（好友房开启）/ `preview-final-nofriends.png`（默认配置），
均按真实 `uni-button` 行高渲染。
