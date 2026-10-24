# 玩家提示收敛与浮层化（A+B+C）· v2

- 日期：2026-10-21
- 分支：`dev`
- 状态：设计稿 v2（已按两轮对抗审查修订）
- 上游核对：2026-10-21 客户端提示全量核对（HEAD `bec601e4`）
- v1 提交：`250274e4`

## 1. 背景

2026-10-21 对客户端全部提示通道做了逐处核对，确认：

| 编号 | 问题 | 现状证据 |
|---|---|---|
| P1 | 技术串直接给玩家看 | `resync_ack 快照 version X…按 M08…`、`[13004] refresh_snapshot — …`、`[code] toast — …`、`匹配失败（code=N）`、`§5.4 为 5`、`服务端登出未成功（code=…）` |
| P2 | 同一次失败双呈现 | WS ack 非 0 同时写页面 `error` 与会话 notice |
| P3 | REST 的 `BACK_TO_LOBBY` 静默踢出 | 10002/10004/10005、会话中途 11003/11004；冷启动 `renewHydratedSession()` 的 `invalid/no_session` 也无提示 |
| P4 | 提示没有生命周期 | 会话提示无自动消失；`clearNotice()` 只清 `source:'action'`；`进房失败，请重试`、`连接已恢复` 会一直挂 |
| P5 | 10006 两个口径 | 遮罩/横条说「同一账号」，会话提示说「同一 IP…§5.4 为 5」；服务端实际是单 IP 并发连接 |
| P6 | `system.warning` 无渲染点 | 只进 `store.notices`，全仓没有消费者；协议文档却规定「原样展示」 |
| P7 | 提示挤压页面 | 登录/大厅/玩法/钱包/历史的错误行都在文档流内；大厅版本条、死态横条、缺人提示都推布局 |
| P8 | REST 调用点绕过统一处置 | `game.vue` 的 `joinRoom`/`createRoom`、`wallet.vue` 的 `reauth`、`loadCardCounterStatus` 直接按 code 写文案，不查 `CLIENT_ACTION` |
| P9 | 成功路径上的失败文案 | `room.leave` 的 12001 被页面视为退出成功，但会话层仍会播报「房间不存在」 |

用户裁决（2026-10-21）：**所有事件提示一律用浮动框，不得挤动原有 UI**；范围 A+B+C 一次做完。

## 2. 范围

### 做

- **A 文案收敛**：按上下文分层、未知码中性化 + reporter、技术串清理、连接文案单一真源。
- **B 单次呈现**：服务端错误码只走 session notice；页面不再渲染自己的错误；REST 全部调用点纳入统一处置或显式登记例外。
- **C 生命周期与静默**：自动过期、可关闭、页面卸载清理；REST 静默踢出补原因；冷启动失效补原因；`system.warning` 接线；`进房失败` 可清。
- **浮层化**：六页统一 `NoticeStack`；版本更新、连接死态、缺人等待改为 sticky 浮层项；面板级加载失败保留静态失败态 + sticky 浮层。

### 不做

- 不改协议代码、错误码、服务端 `message` 语义。
- 不引入原生 `uni.showToast` / `uni.showLoading` / 第三方 toast 库。
- 不把静态状态浮层化（见 D1）。
- 不给钱包/历史新增连接死态恢复入口（保持现状；它们只做本地提示浮层化）。
- 不重做原生 modal、好友房/记牌器/救助弹层本身的形态。
- 不改 `docs/client-protocol.md` 的 10004 行：REST 10004 由 `authedRequest` 先轮换并重放一次，失败才落到 `CLIENT_ACTION` 的 `BACK_TO_LOBBY`；两层语义并存，不是冲突（见 §4.7）。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | **事件提示浮层化；静态状态留原位** | 事件：错误/警告/成功/info/校验/连接/版本/缺人/面板加载失败。静态：`—`、空态、`加载中…`、`查询中…`、`等待其他玩家…`、限额说明、订单状态、行内 14006/14007 备注、按钮文案。**面板级加载失败**额外保留一条静态失败文案（如「档位暂不可用」），否则浮层消失后只剩空白面板。 |
| D2 | **每页一个 `NoticeStack`，挂在 `LandscapeStage` 的 overlay 槽；页面只传 `surface`** | uni-app 的 `App.vue` 不渲染模板，浮层必须进每页。连接状态判断收在 `NoticeStack` 内，页面不读 `connectionState`（R455）。 |
| D3 | **页面提示状态由 `usePageNotices()` 持有，不用全局 Pinia store** | `navigateTo` 会把大厅留在页面栈里；全局 store 会让隐藏页与当前页共享本地提示。每页 composable 天然隔离；卸载后 `show()` 变 no-op。 |
| D4 | **服务端错误码只写 session notice；页面不再渲染自己的错误** | 消除 P2。页面保留控制流所需状态（历史页隐藏空态、钱包列表隐藏「暂无记录」），但文字只由 Stack 呈现。**例外**：`IGNORE_WITH_COPY_CODES`（12003）由请求方就地提示一次（见 §4.4）。 |
| D5 | **REST 失败统一走 `dispatchRestFailure`；例外必须逐点登记** | `joinRoom`/`createRoom`/`reauth`/记牌器状态查询/购买等调用点全部纳入；`signOutLocally(report)` 让 BACK_TO_LOBBY 真正执行。**REST 房间业务码例外**：12001/12002/12004/12008 在占座/建房语境只是业务失败，必须本地提示、不得清会话回登录页；只有 10002/10004/10005/11003/11004 等鉴权码才 `sessionEnded`。 |
| D6 | **生命周期：info/success 3s，warn 6s，error 8s；带动作或面板级加载失败 sticky；`priority:'critical'` 永不淘汰；普通项上限 5** | 解决 P4。本地普通项可点关闭；带动作项默认不可关闭（`dismissible ?? !actions?.length`），只有显式 `dismissible:true` 才给关闭按钮，防止关掉唯一恢复入口。 |
| D7 | **带动作提示做成 sticky Stack 项**：版本更新、连接死态、缺人等待 | 都需要按钮但不推布局。`ConnectionOverlay`（牌桌重连细条 + dead 全屏遮罩）保持独立，因为它是阻断式层。 |
| D8 | **连接所有权矩阵 + 抑制规则** | `server_rejected` 归为 `transport`；大厅/玩法页 dead 时由内置死态项独占，牌桌非 connected 时由 `ConnectionOverlay` 独占；避免「踢线提示 + 死态条」两条同义文案。 |
| D9 | **文案按上下文分层**：auth 以服务端 message 优先（固定码除外，保留 11002 既有测试）；action 以客户端动作文案优先；rest 以固定文案优先、message-first 码次之；warning 强制 message 原样 | 不能一刀切"客户端优先"——11002 的既有 message-first 正对照必须保留；10006/10007 的服务端 message 可能是英文/调试串，必须固定为客户端文案；12004 这类英文 message 同样被固定文案挡住。 |
| D10 | **未知码：UI 中性 + `reportError('notice.unknown_code')` 每码每会话一次；仅 `VITE_PLAYER_DIAG=1` 追加 `（code=N）`** | 保留排查能力，不把内部码给玩家。`VITE_PLAYER_DIAG` 在调用时读取，测试用 `vi.stubEnv` 成对验证。 |
| D11 | **REST BACK_TO_LOBBY 原因只用于「已登录会话被踢」；登录/注册尝试保持既有静默** | 10005 登录负对照（`auth.error === ''`）与 11003 K1 必须保留；不能把"密码错"显示成"登录状态已失效"。冷启动 `renewHydratedSession` 失效补一条原因。 |
| D12 | **`system.warning` 独立订阅：message 原样、永不导航、warn 级 6s** | 协议文档 §208 要求"原样展示"；不能走 `playerMessage` 的固定文案覆盖。删除 `store.notices` 死字段。 |
| D13 | **层叠：页面内容 auto < 自定义弹层 10 < Stack 15 < 牌桌连接遮罩 20** | Stack 在弹层之上，提示不被遮；dead 遮罩最上，链路已死时阻断一切。 |
| D14 | **锚点迁移成表；§4.8 表中的旧类名在 `src/**` 与 `test/**` 命中数为 0（`.lobby__relief-note` 弹层内例外）；新判据用挂载级 `.stage__overlay .notice-stack`** | 防"类消失后旧断言恒真"的假绿；覆盖两个 reviewer 列出的全部测试。 |
| D15 | **机械闸 G1–G7**：文案分区、玩家面禁词、浮层挂载、单次呈现、生命周期、锚点迁移、e2e 断言 | 防同类问题复发。 |
| D16 | **10006 两义分开**：登录/HTTP 限流仍是「操作太频繁，请稍后再试」；只有连接死态的 10006 用「同一网络的连接数已达上限…」 | 同一个码两个语境，不能把 AUTH 表改成连接文案。 |
| D17 | **`room.leave` 的 12001 视为退出成功，并清掉会话层那条「房间不存在」action notice** | 成功路径上不能播报失败文案。 |
| D18 | **`ConnectionDeadError`（blocked 或 catch）都不写「上一个操作还在进行中」/「匹配失败」** | 死态项/遮罩已经说明原因；两条并列会自相矛盾。 |
| D19 | **`reliefNote` 用 `[reliefNote, reliefOpen]` 联合 watcher** | 面板内/面板外两处互斥；面板关闭且 note 非空时浮层显示，打开面板时 dismiss；成功/拒绝/网络三档 level 分开。 |
| D20 | **缺人等待改为 Stack 项，`store.matchWaitPrompt` 仍是唯一状态源** | 保留 busy 逻辑与「匹配区唯一按钮」约束；动作 `disabled` 支持 getter。 |
| D21 | **面板级失败保留静态失败态 + sticky 浮层 + 重试动作** | 解决"浮层消失后空白面板"；档位表「成功但空表」归静态空态，不是错误。 |
| D22 | **读 notice/connectionState 一律经 `currentSession` 响应式路径** | 防 2026-10-13 的换会话旧提示/旧死态残留回归；`stop+start` 后旧死态项必须消失。 |
| D23 | **session notice 用世代号 + 单 timer；`clearNotice()` / `stopGameSession()` 都取消 timer** | 防旧 timer 清掉后来写入的新 notice。 |
| D24 | **`playerMessage(0) === ''`；IGNORED 码永不进 `playerMessage`；`actionErrorMessage(0)` 行为不变** | 保留既有"成功码不得产生文案"判据。 |
| D25 | **仅客户端改动；`docs/client-protocol.md` 的 10004 行不改** | REST 10004 的轮换重放在 `authedRequest` 层；`CLIENT_ACTION` 是轮换失败后的兜底，二者不冲突。 |

## 4. 实现设计

### 4.1 契约

```ts
export type NoticeLevel = "info" | "success" | "warn" | "error";
export type NoticeSurface = "login" | "lobby" | "game" | "table" | "wallet" | "history";

export interface NoticeAction {
  label: string;
  kind?: "primary" | "secondary";
  /** 允许 getter，反映 busy 等实时状态。 */
  disabled?: boolean | (() => boolean);
  onClick: () => void;
}

export interface NoticeItem {
  id: string;                 // 同 id 原地替换
  level: NoticeLevel;
  text: string;
  durationMs?: number;        // 0 = sticky；缺省 3000/3000/6000/8000
  actions?: NoticeAction[];
  priority?: "critical" | "normal"; // critical 永不淘汰
  dismissible?: boolean;      // 缺省 = !actions?.length
}

export interface UsePageNotices {
  items: Ref<NoticeItem[]>;
  show(item: NoticeItem): void;
  dismiss(id: string): void;
  clear(): void;
}
```

- `usePageNotices()`：`src/composables/`；`onUnmounted(clear)`；内部 `disposed` 标志，卸载后 `show()` no-op；计时器只在这里。
- `show` 规则：
  - 同 `id` 替换并重开计时；
  - 同 `level + text` 且都无 actions 视为重复，刷新计时不新增；
  - 新项在前；`priority:'critical'` 永不淘汰；普通项超过 5 条时淘汰最旧普通项；
  - 全是 sticky 且无普通项时允许超过 5 条，不淘汰 critical。
- `NoticeStack` props：
  ```ts
  { items: NoticeItem[]; surface: NoticeSurface }
  ```
  - 内部只读 `currentSession.value?.notice.value` 与 `currentSession.value?.connectionState.value`（响应式，禁止 `getGameSession()` 进 computed）。
  - 不接收 `connectionState` / `suppressTransport` props；页面不判断连接状态。
  - emits：`dismiss(id)`（仅本地项）。
- `SessionNotice` 扩展：
  ```ts
  interface SessionNotice {
    level: "info" | "warn" | "error";
    text: string;
    code?: number;
    source?: "action" | "transport" | "system"; // undefined 按 transport 处理
    sticky?: boolean; // 断链期间不自动消失
  }
  ```
- `connectionDeadCopy(state)`：`src/net/connection-copy.ts`，返回 `{ title, message, canRetry, canRelogin }`。`ConnectionOverlay.vue` 与 `NoticeStack` 内置死态项共用。

### 4.2 连接所有权矩阵

| surface | `reconnecting` | `dead` | transport session notice |
|---|---|---|---|
| lobby | Stack 显示 sticky `连接不可用，请检查网络后重试` | Stack 内置 `connection-dead` 项；抑制所有 transport notice | 非 dead 时显示 |
| game | 同上 | 同上 | 非 dead 时显示 |
| table | `ConnectionOverlay` 顶部细条；Stack 抑制 transport | `ConnectionOverlay` 全屏遮罩；Stack 抑制 transport | `connected` 时显示（连接恢复/同步类）；非 connected 时抑制 |
| login / wallet / history | 不显示连接 UI（保持现状） | 不显示 | 不显示 |

- `server_rejected` 在 `session.ts` 写 notice 时带 `source:'transport'`。
- `onConnectUnavailable` 写 `sticky:true`（直到 `连接已恢复` 替换）；`onConnectAvailable` 写 info 3s。
- 会话 notice 的 `source` 归属：
  - `action`：WS ack 处置、`REFRESH_SNAPSHOT` 的「正在同步/同步失败」、`joinMatchedRoom` 的 `进房失败，请重试`、`onActionDisposition`；
  - `transport`：`connect_error` 的「连接不可用」、`连接已恢复`、`server_rejected`、`socket_reconnect`/`snapshot_unavailable`/`version_rollback` 等 `onReconnect` 文案；
  - `system`：`system.error` 的 TOAST/未登记码播报、`system.warning`；
  - 缺省 `undefined` 按 `transport` 处理（保守）。
- `NoticeStack` 内置项与合并顺序：`connection-dead`（若有）→ 带动作的本地项 → session notice → 其余本地项。带动作本地项不参与"session 优先"去重；普通本地项与 session 同 `level+text` 时 `dismiss(id)` 移除，防止 session 过期后复活。
- `NoticeStack` 内置 `connection-dead` 维护 `dismissedBuiltins` 集合：无动作项（11003/无码）可关闭，关闭后直到 `connectionState` 相位变化才重新出现；有动作项不显示关闭按钮。
- 大厅/玩法页 dead 时：
  - `NoticeStack` 生成 `connection-dead`：`level:'error'`、`durationMs:0`、`priority:'critical'`；
  - 有可执行动作（retry/relogin）时 `dismissible:false`；11003/无码无动作时 `dismissible:true`；
  - 项内容 = `connectionDeadCopy(state).message`；动作：`重新连接` / `重新登录`。
- 牌桌：`NoticeStack` 不生成死态项；`ConnectionOverlay` 负责，`topOffset` 在非 connected 时由 Stack 内部计算为 48。
- 会话通知与死态项同文时，transport notice 被抑制；**带动作的本地项不参与"session 优先"去重，始终渲染**。
- 登录/钱包/历史 `withSession=false`；不读 session notice（保持现状）。

### 4.3 生命周期

- 本地普通项：info/success 3s，warn 6s，error 8s；点击关闭。
- 本地 sticky：`durationMs:0`；带动作项默认不可关闭，`dismissible:true` 才给关闭。
- 面板级加载失败：sticky + `dismissible:true` + `重试` 动作；重试成功 `dismiss(id)`。
- session notice：
  - 由 `src/composables/sessionNotice.ts` 的 `createSessionNoticeController()` 持有 ref/timer/世代号；`useGameSession` 只消费控制器，不在页面/组件里计时。
  - `sticky:true` 不设 TTL；info 3s / warn 6s / error 8s；
  - `set()` 用世代号：新值递增世代并清旧 timer；旧 timer 触发时世代不符则忽略；
  - `clearAction()` 只清 `source:'action'`，同时取消该 timer；
  - `dispose()` 取消 timer 并置 null；`stopGameSession()` 调用。
- 页面卸载：`usePageNotices` 清本页所有项与 timer；`disposed` 后异步回调 `show()` no-op。
- 同文案 session/local 去重：本地项被 `dismiss(id)` 移除（不是隐藏），防止 session 过期后"复活"。
- 同 id 替换：旧项失效，timer 重置；动作项替换时重新计算 `dismissible`。

### 4.4 数据流

1. **WS ack 非 0**：`client.notifyAction` → `CLIENT_ACTION` 执行器 → `setSessionNotice({ source:'action', ... })`。页面只读 `outcome.code` 做控制流。
   - `IGNORE_WITH_COPY_CODES`（12003）：执行器不播报；请求方（牌桌 `runAction`，必要时玩法页）用 `notices.show({ level:'warn', text: actionCopyFor(12003)! })` 提示一次。
   - `ConnectionDeadError` 的 `blocked`：页面不写本地文案，死态项/遮罩独占。
2. **`system.error` 推送**：沿用现状——只有 TOAST/未登记码播报；导航类码不因推送把用户拽走。`reportErrorCode(code, message, source)` 增加 `source` 参数：ack 路径传 `action`，push 路径传 `system`；session 的 toast 处理据此写入 notice.source。
3. **`system.warning` 推送**：从 `applyEvent` 的事件循环中移除（store 不再消费），新增独立订阅；`message` 原样（空则 `请注意，牌局状态有变化`）；`level:'warn'`、`source:'system'`、6s；永不进 `CLIENT_ACTION`、永不导航。`system.error` 仍保留在 `applyEvent` 里（12007 的 `setMatching(false)` 依赖它）。
4. **REST 失败**：`dispatchRestFailure` 的 `toast` 分支 → `notices.show()`；`BACK_TO_LOBBY` → `signOutLocally(report)`。
5. **本地条件**：页面直接 `notices.show()`；不再渲染内联错误 `<text>`。控制流状态可保留。
6. **未知码**：`dispatchErrorCode` / `dispatchRestFailure` 在 `!known` 时调用 `reportUnknownCode(code, context)`；每码每会话一次；UI 用 `playerMessage` 中性兜底。
7. **page unmount**：清本地项；session notice 跨页保留，TTL 只计一次。
8. **登录页**：`watch(() => auth.error, …, { immediate: true })` → `show({ id:'auth', level:'error', text, durationMs:0 })`；`auth.error` 清空时 `dismiss('auth')`。

### 4.5 文案架构

`src/net/copy.ts` 成为唯一文案入口；`action-copy.ts` 保留为 action 语境表并可从 `copy.ts` 派生（允许其 import `./copy`；纯度测试改为"只允许 protocol + copy"，仍禁止 UI/store）。

**三张互斥分类（G1 机械校验）**

- `IGNORED_CODES`：由 `CLIENT_ACTION === IGNORE` **派生**，不硬编码。当前含 0、12003、12009、13008、15007。
- `IGNORE_WITH_COPY_CODES`：`IGNORED_CODES` 的子集，当前 `{12003}`；每项必须有玩家文案，由请求方就地提示。
- `FIXED_CODES` 与 `MESSAGE_FIRST_CODES`：**精确分区**全部非 IGNORED 码，互不相交。
  - `FIXED_CODES`：客户端文案固定，服务端 message 不覆盖。含 10002/10004/10005/10006/10007/10008、11003、12001/12002/12004/12005/12006/12007/12008/12011、13001/13004/13005/13006/13007/13009/13010。
  - `MESSAGE_FIRST_CODES`：message 非空优先，空则 `FALLBACK_COPY` 兜底。含 10001/10003、11001/11002/11004/11005、12010、14001–14004、14008–14010、15001–15006、15008、15009。
  - `RESERVED_CODES` 单独断言：13007 在 FIXED，13008/15007 在 IGNORED（不要求可展示）。
- `FIXED_COPY` = `FIXED_CODES` 的文案映射；`FALLBACK_COPY` = `MESSAGE_FIRST_CODES` 的服务端 message 为空时的兜底映射。
- 10001 允许语境差异：auth/rest 兜底 `请检查填写的内容`，action 兜底 `请检查操作内容`（`fallbackFor` 按 context 选择）；这是同一码的两句语境文案，登记在案，不算第二真源。
- `FIXED_COPY` 必须覆盖：12005 `没有权限进行该操作`、12006 `好友房创建/加入失败，请稍后重试`、12008 `房间已经开始，无法加入`、13004 `牌局状态有更新，正在同步…`，以及 FIXED 其余码的现有文案。
- `FALLBACK_COPY` 必须覆盖 MESSAGE_FIRST 全部码：10003 `没有权限进行该操作`、11001 `这个手机号已经注册过了，直接登录吧`、11002 `手机号或密码不正确`、11004 `该账号不存在，请先注册`、11005 `账号已绑定其他设备，如需在本机使用请联系管理员解绑`、12010 `该场次暂未开放`、14001/14002 `操作未成功，请稍后重试`、14003 `金币不足，无法进入该场次`、14004 `救助暂不可用，请稍后重试`、14008 `记牌器暂未开放`、14009 `价格已更新，请重新确认后购买`、14010 `请求号冲突，请重新购买`、15001–15006/15008/15009 `支付暂时不可用，请稍后重试`。

**`playerMessage(code, { context, label, serverMessage })`**

| context | 优先级 |
|---|---|
| `auth` | FIXED → message-first → `FALLBACK`；11001/11002/11004/11005 保持 message-first（既有测试） |
| `action` | `FIXED_COPY` → MESSAGE_FIRST(messages) → 中性；`actionCopyFor` 从 `FIXED_COPY` 派生动作子集 |
| `rest` | FIXED → MESSAGE_FIRST(messages) → `FALLBACK`；区块前缀由调用方加（`档位表加载失败：…`） |
| `warning` | `serverMessage` 原样 → `请注意，牌局状态有变化`；不走固定表、不导航 |
| `connection` | `connectionDeadCopy` 专用，不进 `playerMessage` |

- `playerMessage(0) === ''`；IGNORED 码返回 `''`（调用方不应展示）。
- 未知码：`操作未成功，请稍后重试`；仅 `isPlayerDiag()` 时追加 `（code=N）`。
- `isPlayerDiag()` 在调用时读 `import.meta.env.VITE_PLAYER_DIAG === '1'`；`env.d.ts` 补声明。
- `authErrorMessage` 委托 `playerMessage({context:'auth'})`；`actionErrorMessage` 委托 `{context:'action'}`，`code 0` 返回 `''`；`actionCopyFor` 保持 `string | null`（查 `FIXED_COPY` + `IGNORE_WITH_COPY`，后者当前只有 12003）。
- `describeAction` 只进 reporter/日志；UI 禁止引用。

**技术串替换（含审查新增）**

- `resync_ack 快照 version X 回退于已应用的 Y；按 M08…` / `reconnect_ack …` → `牌局状态有更新，正在同步…`（与 13004 共用）。
- `检测到状态回退，正在重新同步快照…` → `牌局状态有更新，正在同步…`。
- `快照 version X 回退于已应用的 Y；按 M08…`（`stores/game.ts` 的 runtime 信号）→ `牌局状态有更新，正在同步…`。
- `状态冲突，正在刷新快照：[13004] refresh_snapshot — …` → `牌局状态有更新，正在同步…`。
- `刷新快照失败：${String(error)}` → `同步失败，请重试`（细节进 reporter）。
- `[code] toast — message` / `[code] back_to_lobby — message` / `操作未通过（code=N）` → 中性文案 + reporter。
- `匹配失败（code=N）`、`取消失败（code=N）`、`加入房间失败（code=N）`、`创建房间失败（code=N）` → `playerMessage` + 区块前缀。
- `服务端登出未成功（code=…）` / `服务端登出失败（…）` → `服务端登出未成功，本地会话已清除` / `服务端登出失败，本地会话已清除`；异常进 reporter。
- 各页 `失败：${e.message}` → 中性文案；异常进 reporter。
- `auth.signIn/signUp` 的 catch 原始 `error.message` → `登录失败，请稍后重试` / `注册失败，请稍后重试`；异常进 reporter。
- `同一 IP…§5.4 为 5` / `同一账号…` → `同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。`
- `网络波动，正在重新同步牌局…`（v1）→ 因果中性的 `牌局状态有更新，正在同步…`。

### 4.6 页面迁移清单

| 页面 | 迁入 Stack | 保持原位/静态失败态 |
|---|---|---|
| 登录 | `fieldError`（error）、`auth.error`（id `auth`，sticky 到下一次提交） | 表单、按钮、占位 |
| 大厅 | `entryError`（id `entry`）、面板外 `reliefNote`（id `relief`）、版本更新（id `update`，sticky + 立即刷新）、面板加载失败（id `levels`，sticky + 重试）、连接死态（内置） | 余额 `—`、档位卡、门槛说明、面板内 `reliefNote`、`暂无可用档位` |
| 玩法 | `error`（id `game-error`）、`ccError`（id `cc-error`）、缺人等待（id `match-wait`，sticky + 两动作）、面板加载失败（id `rooms`，sticky）、连接死态（内置） | `ccBlockWarning`、`ccStatusFailed`（弹层内持续态）、底分 hint、`暂无房间` |
| 牌桌 | `localError`（id `table-local`）、12003 就地提示、session notice | `已进房，等待服务端发牌…`、`等待其他玩家…`、结算/等待状态 |
| 钱包 | `summaryError`（id `summary`，sticky + 重试）、`rechargeError`、`payHint`（sticky）、`withdrawError`、`withdrawResult`（success 6s）、列表 `error`（每 tab 一个 sticky + 重试）、`returnError` | 余额 `—`、限额说明、订单/退款/提现状态标签、14006/14007 行内备注、`查询中…/自动查询中…/处理中`、`暂无记录`（失败时显示静态失败文案） |
| 历史 | `error`（id `history`，sticky + 重试） | 加载中、`暂无记录`（失败时显示静态失败文案） |

补充：

- `SessionNotice.vue`、`ConnectionDeadBar.vue` 退役；死态由 `NoticeStack` 内置。
- 牌桌删除 `visibleNotice` / `suppressedNoticeText` / `.table__notices`、`.table__notice`。
- 玩法页 `error` 同时服务好友房弹层与主区：统一一条 Stack 项；弹层内不再渲染错误行。`loadRooms` 使用独立 id `rooms`（与行动错误 `game-error` 分开），避免刷新房间列表失败被下一次匹配覆盖。
- `ccStatusFailed`/`ccBlockWarning` 留在记牌器弹层内：它们是弹层内部的持续态，弹层本身已是浮层，不挤压页面；在 spec 登记为 D1 的例外。
- `reliefNote` 面板内保持，面板外走联合 watcher（D19）。level 映射：`已领取救助 +N` → `success`；`网络异常，请重试` → `error`；服务端 `reason`、`完整观看才能领取`、`暂时没有可播放的广告，稍后再试`、`发放可能稍有延迟，稍后回到本页查看` → `warn`。
- `waitPrompt` 的 `matchWaitPrompt` 仍由 store 持有；页面 `watch([waitPrompt, busy], …, { immediate:true })` 以同 id 刷新动作 `disabled`。
- `dismissible` 显式值：`update` = true（可关）；`match-wait`、带动作的 `connection-dead` = false；面板加载失败（`levels`/`summary`/`rooms`/`history`/钱包列表）= true + `重试` 动作。面板失败项关闭后，静态失败文案仍在，不会留下空白面板。

### 4.7 REST 调用点

| 调用点 | 现状 | 目标 |
|---|---|---|
| `auth.signIn/signUp` | `handleAuthFailure` | 保留：11003 K1；10005 静默负对照；11002 message-first |
| `lobby.loadClientConfig` | dispatch | 前缀 + `playerMessage({context:'rest'})`；失败 sticky + 重试；成功空表 → 静态空态 |
| `lobby.loadWalletBalance` | dispatch | 保持静默 `—` |
| `lobby.getRelief/poll` | dispatch | `reliefNote` 通道 |
| `game.loadRooms` | dispatch | sticky `rooms` + 刷新 |
| `game.joinRoom/createRoom` | 直接按 code | 房间业务码 12001/12002/12004/12008 → 本地提示；鉴权码 → `dispatchRestFailure`（清会话；replay 最多一次） |
| `game.loadCardCounterStatus` | 直接 | BACK_TO_LOBBY → 清会话；其余 → `ccStatusFailed` 静态态 |
| `game.sendCardCounterPurchase` | 直接 switch | 保留业务分支；BACK_TO_LOBBY → 清会话；其余 → `cc-error` |
| `game.refreshClientConfig`（14009 后） | 静默忽略 | 失败 → `cc-error`「价格刷新失败，请重试」，保留待确认记录 |
| `wallet.loadSummary` | dispatch | sticky `summary` + 重试 |
| `wallet.onBuyPackage` | dispatch | `rechargeError` |
| `wallet.reauth` | 直接按 code | 改走 `dispatchRestFailure`（BACK_TO_LOBBY 清会话；TOAST → `withdrawError`） |
| `wallet.onSubmitWithdraw` | dispatch | `withdrawError` |
| `wallet.loadTab` | dispatch | 每 tab sticky + 重试 |
| `wallet.refreshReturnOrder` | dispatch | `returnError` |
| `history.load` | dispatch | sticky `history` + 重试 |
| `auth.signOut` | 直接 | 本地清理；文案中性化；异常进 reporter |
| `auth.renewHydratedSession` | 静默 | `invalid/no_session` → `sessionEnded('登录状态已失效，请重新登录')` |

- `dispatchRestFailure` 的 `signOutLocally` 签名改为 `(report) => void`。
- 10004 在 `authedRequest` 层先轮换重放一次；只有轮换失败才到达这里。
- `auth.clearLocalSession(message?)`：`message !== undefined` 时写入 `auth.error`；缺省时**保留**既有 `auth.error`（11003 先写 K1 再调本函数，不能被清掉）。`auth.sessionEnded(message)` = 带原因的 `clearLocalSession`，只给"已登录会话被踢"与冷启动失效使用；登录/注册尝试的 `signOutLocally` 不调用它（10005 负对照）。

### 4.8 测试/锚点迁移表

| 测试文件 | 旧断言 | 处置 | 新判据 |
|---|---|---|---|
| `notice-presentation.test.ts` | `.lobby__notice`/`.game__notice`/`.table__notices` absolute | 重写 | `.stage__overlay .notice-stack` absolute；零术语 |
| `connection-dead.test.ts` | `.connection-dead-bar` ~30 处 | 迁移 | `connection-dead` Stack 项；换会话不残留 |
| `connection-overlay.test.ts` | 重连/死态文案 | 更新 | 共用 `connectionDeadCopy`；10006 新文案 |
| `connection-rejected.test.ts` | 踢线文案负对照 | 更新 | 10006/11003/10008 文案与 source |
| `error-disposition.test.ts` | `signOutLocally` 签名 | 更新 | `(report) => void`；10005 登录静默保留 |
| `auth-error-copy.test.ts` | 10001/11002 文案 | 保留 + 补充 | 10001 语境差异；11002 message-first 不变 |
| `room-matched-join.test.ts` | `进房失败，请重试` | 更新 | source 为 action，可被 clear |
| `action-feedback.test.ts` | `.table__notice`、未知码 `操作未通过（code=…）`、`action-copy` 纯度 | 迁移 + 反转 | `.notice` 单条；未知码中性 + reporter；纯度允许 import `copy` |
| `table-play-ui.test.ts` | `.table__notice` 去重 | 迁移 | 单条 `.notice`；无 `suppressedNoticeText` |
| `auth-ui-wiring.test.ts` | `.game__notice`/`.game__error`/`.game__waitprompt`；10005 负对照 | 迁移 + 保留 | Stack 项；10005 登录仍静默；11003 K1 保留；`.game__match button` 唯一 |
| `auth-flow.test.ts` | 服务端 message 优先（11002） | 保留 | 仍为 `密码错误` |
| `login-screen.test.ts` | `.login__error`/`.login__field-error` | 迁移 | `auth`/`field` Stack 项 |
| `lobby-ux.test.ts` | `.lobby__notice`/`.lobby__levels-error`/`.lobby__entry-error`；R455 源码闸 | 迁移 + 保留 | Stack；页面仍不读 connectionState |
| `base-score-selection.test.ts` | `.lobby__levels-error`；空表错误；10004 | 迁移 + 裁决 | 静态失败/空态分离；10004 回登录有原因 |
| `ads-flow.test.ts` | `.lobby__relief-note` 两处 | 迁移 | 内/外互斥联合 watcher |
| `wallet-page.test.ts` | `.wallet__error`/`.wallet__hint`/`.wallet__withdraw-result` | 迁移 | Stack；状态标签保留 |
| `wallet-entry.test.ts` | 入口/导航 | 保留 | 不受影响 |
| `history-records.test.ts` | `.history__error` | 迁移 | Stack；静态失败态 |
| `card-counter-purchase.test.ts` | `.game__error` 让位 | 反转 | Stack 浮在弹层上；弹层高度不变 |
| `match-state.test.ts` | `store.notices` | 删除/迁移 | 字段移除；`matchWaitPrompt` 保留 |
| `reconnect-flow.test.ts` | 10002 诊断串负对照 | 反转 | 中性文案 + reporter；13010 人话保留 |
| `animations.test.ts` | 组件无时钟 | 保留 | `NoticeStack` 零 timer |
| `ui-tokens.test.ts` | 必列 `SessionNotice.vue` | 迁移 | 必列 `NoticeStack.vue`（含 `<style lang="scss">`） |
| `table-bid-ui.test.ts` | `TABLE_AREA` 10 件 | 登记 | 加入 `NoticeStack.vue` 为第 11 件，仍零 timer |
| `browser-e2e.mjs` | `.table__notice` 仅打印 | 增强 | 真实拒绝后断言 `.notice` 存在与文案 |

## 5. 边界与错误处理

- **原生 modal**：平台最上层；购买/提现密码失败在 modal 关闭后显示。自定义浮层 z=10，Stack z=15，提示在弹层之上且不改变弹层高度。
- **子页压栈**：大厅/钱包/历史各自 `usePageNotices` 隔离；隐藏页 timer 继续，返回时可能已过期。
- **transport 去重**：按 §4.2 矩阵；`server_rejected` 也算 transport。
- **带动作项**：默认不可关闭；`connection-dead`/`match-wait` 不可关闭；`update` 可关闭。`priority:'critical'` 不参与淘汰。
- **12003**：`IGNORE_WITH_COPY` 就地提示一次，不进 session notice。
- **room.leave 12001**：页面视为成功；`doLeave` 在收口后 `clearNotice()`。
- **ConnectionDeadError**：blocked 分支与 catch 分支都不写本地文案（含「匹配失败」），死态项/遮罩独占。
- **登录页**：10005 登录尝试仍静默；已登录 REST 踢出才显示原因；11003 始终 K1。
- **刷新快照**：13004/13007/13009 的 notice 使用中性文案；resync 成功提示 `已同步到最新状态，请重新操作。`；失败 `同步失败，请重试`。
- **失败兜底**：`NoticeStack` 未知 level 按 info；空 `items` 时保留零尺寸根容器（便于 G3 挂载判据），不渲染子项；动作 `onClick` 抛错不阻塞关闭。
- **计时器**：只在 `usePageNotices` / `useGameSession`；`src/components/**` 零 `setTimeout`/`setInterval`。
- **有意静默**：`room.matched`、余额拉取失败、12009 幂等成功、版本更新只在 H5 大厅提示；登记在案。

## 6. 机械闸

### G1 文案分区闸

- `IGNORED_CODES` 由 `CLIENT_ACTION === IGNORE` 派生。
- `IGNORE_WITH_COPY_CODES ⊆ IGNORED_CODES`，且每项有文案。
- `FIXED_CODES ∩ MESSAGE_FIRST_CODES = ∅`；二者并集 = 全部非 IGNORED 码。
- `MESSAGE_FIRST_CODES` 每项在 `FALLBACK_COPY` 有条目。
- `RESERVED_CODES` 断言：13007 ∈ FIXED，13008/15007 ∈ IGNORED。
- 判别力自证：漏 12008、漏 13004、两表重叠三种样本必须红。

### G2 玩家面禁词闸

- 表驱动：全部码 × 上下文（auth/action/rest/warning）调用 `playerMessage`，**serverMessage 传空**，输出不得含 `code=`、`[`+数字、`refresh_snapshot`、`back_to_lobby`、`§`、`version`、`socket.io`、`lastVersion`；另用固定样本验证 MESSAGE_FIRST 的非空 message 原样透传（动态 message 不纳入禁词扫描，服务端负责其可读性）。
- sink 扫描：`setSessionNotice`、`notice(`、`notices.show(`、`setNotice(`、`auth.error =`、`connectionDeadCopy` 的文本参数，以及 `socket.ts`/`useGameSession.ts` 传入 notice 的 `reason.message`；使用引号感知扫描（不依赖 `stripComments`）。
- `describeAction` 只允许出现在 reporter/日志调用；源码闸白名单逐处登记。
- `VITE_PLAYER_DIAG` 成对测试：关闭 → 无后缀；开启 → 有 `（code=N）`。
- 未知码：UI 中性 + reporter 每码一次。
- 判别力自证：旧串 `匹配失败（code=12010）`、`[13004] refresh_snapshot`、`服务端登出未成功（code=3）` 必须命中。

### G3 浮层挂载闸

- 六页挂载 `LandscapeStage` 后，`wrapper.find('.stage__overlay .notice-stack').exists()` 为真。
- 禁类按前缀：`.login__error`、`.login__field-error`、`.lobby__levels-error`、`.lobby__entry-error`、`.lobby__notice`、`.lobby__update-bar`、`.game__error`、`.game__notice`、`.game__waitprompt`、`.table__notice`、`.table__notices`、`.wallet__error`、`.wallet__hint`、`.wallet__withdraw-result`、`.history__error`、`.connection-dead-bar`。
- `.lobby__relief-note` 例外：仅允许保留在救助弹层**内部**；页面外的渲染点必须删除（挂载断言：弹层关闭时 `.lobby__relief-note` 不存在于弹层之外）。
- `.notice-stack`/`.stage__overlay` 的**全部** CSS 规则均不得出现冲突的 `position`/`pointer-events`；容器 `none`、项 `auto`。
- `ui-tokens` 必列 `NoticeStack.vue`；`TABLE_AREA` 登记第 11 件。

### G4 单次呈现闸

- 渲染层（`notice-single-presentation.test.ts`）：session 与本地普通项同文只渲染一条；带动作本地项不被吞；10008 死态 + 同文 transport 只渲染死态项。
- 页面层：各页迁移用例断言旧内联错误类不存在（`.game__error`/`.table__notice`/`.login__error` 等）；ack 的具体文案由 `action-copy`/`playerMessage` 表驱动单测覆盖。
- push 组：`system.error{12007}`、`{10007}` → 恰好一条 `.notice`，不导航。
- REST：`BACK_TO_LOBBY` 已登录 → 登录页一条原因；登录尝试 10005 → 零提示（负对照）。
- 死态矩阵：reconnecting / give_up / 10006 / 10008 / 11003 / session_expired × 大厅/玩法/牌桌；断言一条连接文案、动作按钮在场性、不可关闭性。
- `room.leave` 12001 → 无「房间不存在」文案。
- 12003 → 一条就地提示。
- session/local 同文 → 只一条，且 session 过期后本地项不复活。
- 未知码 → 一条中性文案 + reporter 一次。

### G5 生命周期闸

- composable 级 harness：只挂 `usePageNotices`，fake timers 测 3/6/8s、sticky、同 id、同文、critical 淘汰、disposed、卸载清理。
- session 级 harness：`createGameSession` + fake timers 测 transport sticky、action TTL、世代号、`clearNotice` 取消 timer、`stopGameSession` 清理。
- 页面级只留集成用例，避免与 `useCountdown` 250ms、匹配秒表、`useVersionCheck` 5min 相互干扰。
- 首帧 `immediate`：update/levels/dead/auth 在挂载即对齐。
- 换会话：`stop+start` 后旧死态项消失。

### G6 锚点迁移闸

- §4.8 表逐项机械检查：旧类名在 `src/**` 与 `test/**` 命中数为 0；新断言存在。
- `browser-e2e.mjs` 增加真实拒绝后的 `.notice` 断言（不只打印）。

### G7 回归命令

```bash
pnpm -C apps/client test
pnpm -C apps/client run lint
node scripts/browser-e2e.mjs
```

另需 H5 + App 模拟器逐页走查截图：登录校验、大厅档位失败、玩法匹配失败、牌桌动作拒绝、钱包下单失败、历史加载失败、版本条、死态条、缺人等待、12003、12001。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| uni-app H5/App 的 absolute + transform 层叠差异 | 浮层挂在 `.canvas`（`position: relative`）内；真浏览器 + App 模拟器双端走查；不用 `position: fixed` |
| `pointer-events` 挡点击 | 容器 `none`、项 `auto`；带动作项点击后关闭 |
| 原生 modal 层级不可控 | 不在 modal 打开期间依赖 Stack；modal 内部提示保留 |
| 计时器导致测试抖动/牌桌时钟闸 | 计时器只在 composable/session；fake timers；组件零 timer |
| 锚点迁移漏改 | §4.8 全表 + 旧类名命中数 0 |
| 提示自动消失太快 | info 3s / warn 6s / error 8s；sticky 项不自动消失 |
| 页面隐藏时本地提示泄漏 | 每页 composable 隔离 + disposed 标记 |
| 文案表漏项 | G1 分区闸 + G2 禁词闸 + reporter |
| 死态项被关掉/被淘汰 | 带动作项默认不可关闭；critical 不淘汰 |
| 换会话旧死态残留 | `currentSession` 响应式 + G5 stop/start 用例 |

## 8. 涉及文件

**新增**

- `apps/client/src/composables/usePageNotices.ts`
- `apps/client/src/composables/sessionNotice.ts`
- `apps/client/src/components/NoticeStack.vue`
- `apps/client/src/net/connection-copy.ts`
- 测试：`copy-coverage`、`player-copy`、`notice-lifecycle`、`notice-single-presentation`、`notice-connection-matrix`

**修改**

- `apps/client/src/components/LandscapeStage.vue`（overlay 槽）
- `apps/client/src/pages/{login,lobby,game,table,wallet,history}/*.vue`
- `apps/client/src/net/{copy,action-copy,errors,session,socket,rest}.ts`
- `apps/client/src/composables/useGameSession.ts`
- `apps/client/src/stores/{auth,game}.ts`
- `apps/client/src/components/ConnectionOverlay.vue`
- `apps/client/src/env.d.ts`
- `apps/client/test/`：§4.8 表列出的全部文件；`ui-tokens.test.ts`、`table-bid-ui.test.ts`
- `scripts/browser-e2e.mjs`

**退役**

- `apps/client/src/components/SessionNotice.vue`
- `apps/client/src/components/ConnectionDeadBar.vue`

## 9. 交付判据

- 六个页面无页面级内联错误行；所有事件提示出现在 `.stage__overlay .notice-stack`；弹层内部持续提示保持原样。
- 同一失败只有一条可见提示；没有 `code=`、`refresh_snapshot`、`back_to_lobby`、`§5.4`、`服务端登出未成功（code=…）` 等内部串。
- 连接三态（reconnecting/dead/session_expired）在大厅/玩法/牌桌都有唯一、可操作、不可误关的呈现。
- info/warn/error 按 3/6/8s 消失；带动作与面板失败项保持 sticky；页面切换与卸载不残留本页提示。
- REST 会话失效回登录页有原因；登录尝试 10005 仍静默；11003 仍 K1。
- `system.warning` 原样展示且永不导航。
- `pnpm -C apps/client test`、`pnpm -C apps/client run lint`、H5 真浏览器 e2e 全绿；H5 + App 截图走查通过。

## 10. 对抗审查记录（2026-10-21）

两份独立审查均判 **需修订**；本 v2 已逐条处置。

| 审查项 | 级别 | 处置 | 落点 |
|---|---|---|---|
| 架构 R1：server_rejected 未标 transport；同文去重可能藏掉死态按钮 | 阻断 | 采纳：加 `source:'transport'`；带动作项不参与去重；G4 断言按钮 | D8、§4.2、G4 |
| 架构 R2：死态项默认可关闭 | 高 | 采纳：带动作项默认不可关闭 | D6、§4.3 |
| 架构 R3：页面读 connectionState 违反 R455 | 高 | 采纳：状态判断收进 NoticeStack | D2、§4.1、§4.2 |
| 架构 R4：6 分钟重连窗口无持续指示 | 高 | 采纳：transport sticky 到恢复 | D8、§4.2、§4.3 |
| 架构 R5：REST 一律补原因踩 10005 负对照/11003 | 高 | 采纳：只对已登录会话补原因 | D11、§4.5、§4.7 |
| 架构 R6：漏 12008/13004 | 高 | 采纳：补入 FIXED；G1 判别力样本 | D9、§4.5、G1 |
| 架构 R7：12003 IGNORE 反馈被丢 | 高 | 采纳：`IGNORE_WITH_COPY_CODES` 就地提示 | D4、§4.4、G4 |
| 架构 R8：system.warning 被中性兜底 | 中 | 采纳：warning context 强制 message 原样 | D12、§4.5 |
| 架构 R9：reliefNote 双呈现/丢失 | 中 | 采纳：联合 watcher | D19、§4.6 |
| 架构 R10：action disabled 静态 | 中 | 采纳：支持 getter；同 id 刷新 | D20、§4.1 |
| 架构 R11：G2 扫不到 net/stores 源头 | 中 | 采纳：sink 扫描 + 文件面扩展 | G2 |
| 架构 R12：四条 REST 绕过统一处置 | 中 | 采纳：列入 §4.7 | D5、§4.7 |
| 架构 R13/R14/R15/R16/R17/R18/R19/R20/R21/R22/R23/R24/R25 | 中/低 | 全部采纳或登记：测试表、面板失败态、上下文文案、死态 blocked、10006 两义、TTL 世代、disposed、critical 淘汰、中性 rollback、payHint sticky、currentSession、immediate、锚点补齐 | 见 D/§ 对应行 |
| 测试 R1：G1 三表不完整/不互斥 | 阻断 | 采纳：派生 IGNORED、精确分区、RESERVED 断言 | G1 |
| 测试 R2：G2 扫描面绕开真实源头 | 阻断 | 采纳：sink 扫描 + 引号感知 + 文件面 | G2 |
| 测试 R3：未知码 reporter 无落点 | 高 | 采纳：`reportUnknownCode` + 反转负对照 | D10、§4.4、G2/G4 |
| 测试 R4：D9 与 message-first 冲突 | 高 | 采纳：按 context 分层，保留 11002/10007 | D9、§4.5 |
| 测试 R5：system.warning 契约 | 高 | 采纳：message 原样、独立订阅 | D12 |
| 测试 R6：10004 文档冲突 | 中 | 部分采纳：确认为 `authedRequest` 轮换+重放，失败才 BACK_TO_LOBBY；不改文档 | D25、§4.7 |
| 测试 R7：transport TTL | 高 | 采纳：sticky 到恢复 | D8、§4.3 |
| 测试 R8：currentSession 响应式 | 高 | 采纳：G5 stop/start | D22、G5 |
| 测试 R9：锚点迁移不完整 | 高 | 采纳：§4.8 全表 | §4.8、G6 |
| 测试 R10：G3 假绿 | 高 | 采纳：挂载级 + 全规则 CSS | G3 |
| 测试 R11：waitPrompt 迁移 | 高 | 采纳：迁移表 + 唯一按钮约束 | D20、§4.6、§4.8 |
| 测试 R12：REST 绕过 | 中 | 采纳：§4.7 | D5、§4.7 |
| 测试 R13：G4 12007 是 push | 中 | 采纳：push/ack 分组 | G4 |
| 测试 R14：fake timers 叠加 | 中 | 采纳：composable/session/page 三级 | G5 |
| 测试 R15：playerMessage(0) 与纯度 | 中 | 采纳：`code 0` 空串；纯度测试允许 copy | D24、§4.5 |
| 测试 R16：10001 两份文案 | 中 | 采纳：语境差异登记 | §4.5 |
| 测试 R17：VITE_PLAYER_DIAG 可测性 | 中 | 采纳：调用时读 + 成对测试 + env.d.ts | D10、G2 |
| 测试 R18：stripComments 引号盲 | 低 | 采纳：sink 用引号感知扫描 | G2 |
| 测试 R19：ui-tokens/TABLE_AREA | 低 | 采纳：成对修改 | §4.8、G3 |
| 测试 R20：探针/去重复活 | 低 | 采纳：e2e 断言 + dismiss 去重 | G4、G6 |

**未采纳/部分采纳**：测试 R6（10004 文档）不改文档，理由见 D25；其余全部采纳。
