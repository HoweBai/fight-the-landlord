# @fight-the-landlord/client

斗地主客户端的**骨架**（Task 3）。目标是跑通一条端到端路径：

```
登录 → 匹配 → 收 game.deal → 出一手/叫抢 → 收 game.state_update
```

## 铁律：前端是哑终端（docs/design.md §12）

- **只依赖 `@fight-the-landlord/protocol`**，绝不 import `@fight-the-landlord/shared`（那会把游戏规则带进前端）；
- 不含任何牌型判定、倍数计算、底分常量、叫抢规则；
- 每个入站消息先过 `validateInbound`；
- 每个错误码走 `CLIENT_ACTION` 表分支。特别注意 **`13004` 的唯一处置是「就地刷新快照」**，不是断线重连（§6.5）。

`test/source-boundary.test.ts` 会**机械地**扫描 `src/**` 来保证上面几条。

## 跑起来

```bash
cd apps/client
pnpm install                 # 在仓库根执行也可以
pnpm test                    # 离线、确定性：51 条契约断言
pnpm build                   # vue-tsc 类型检查 + vite 打包
pnpm dev                     # 开发服务器（默认 5173）
```

### 对 mock 跑端到端

协调者的 mock（`tools/mock-server`，由协调者拥有）监听 `http://localhost:3400`：

```bash
CLIENT_E2E=1 pnpm test       # 额外跑 test/mock-e2e.test.ts 与 test/ui-flow.test.ts
```

这两条用例默认 **skip**——`pnpm test` 必须保持离线确定性。

## 切换服务端（不改业务代码）

| 场景 | 配置 |
|------|------|
| 连 mock（开发默认） | `.env.development` 里 `VITE_WS_ENDPOINT=http://localhost:3400`，握手 `auth: { userId }` |
| 连真实网关 | 注释掉 `VITE_WS_ENDPOINT` → endpoint 回退同源，走 `vite.config.ts` 的 `/socket.io` 代理；登录后 `buildSocketAuth()` 自动改用 `auth: { token }` |

socket.io 参数：namespace `/ws/ddz`、path `/socket.io`、**只使用内置心跳**（§6.1），无应用层 ping/pong。

## 结构

```
src/
├── config.ts                  endpoint / 握手身份的运行时配置
├── router.ts                  页面枚举（uni-app pages.json 的等价物）
├── main.ts                    入口：唯一引入 socket.io-client 的地方
├── net/
│   ├── transport.ts           窄 socket 接口 + 注入点 + URL 解析
│   ├── socket.ts              GameClient：信封 / ack / baseVersion / 串行队列 / 入站校验
│   ├── errors.ts              CLIENT_ACTION 查表执行器
│   ├── session.ts             把 GameClient 与 store 接起来
│   └── rest.ts                登录/注册/刷新/登出（§5.1：认证走 REST）
├── stores/
│   ├── game.ts                只存渲染所需状态 + §6.2 丢弃规则
│   └── auth.ts                会话与导航
├── composables/
│   ├── useCountdown.ts        以服务端 turnDeadlineAt 为基准（F06）
│   └── useGameSession.ts      会话单例装配
├── components/{Card,Hand}.vue 牌面只由 protocol.toDisplay() 渲染
└── pages/{login,lobby,table}.vue
```

## 与计划的偏离（明确记录）

1. **uni-app 未落地**：脚手架依赖离线不可用，改用 **Vite + Vue 3** 等价骨架。
   目录结构刻意保持 uni-app 的形状（`src/pages/*.vue` + 页面枚举 + `components/*.vue`），
   将来把 `vite.config.ts` 的插件换成 uni-app 的 vite 插件、`router.ts` 换成 `pages.json` 即可迁移。
2. **页面是三个**（login / lobby / table）：`room` 页的职责（等发牌）已并入 `table`。
3. **C→S 信封附带兼容字段** `type` / `meta`：协调者的 mock 用 `validateClientMessage` 解包整个 emit 载荷。
   这是纯加性兼容，见 `src/net/socket.ts` 的 `buildRequestPayload` 注释与交付汇报中的裁决请求。
