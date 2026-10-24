# 切片 P20 实施计划：小程序传输的 engine.io 契约面（N44）

**Goal:** 补全 `MpWebSocketTransport` 对 **engine.io 的 `Transport` 基类契约**（用户实测第二轮抓到的第二个阻断级缺陷），
并把判据升级为「**用真消费者（engine.io-client 的 `Socket`）驱动我们的传输**」——旧的 31 条自我接口单测**结构上抓不到**这类缺口。

## 为什么现在做（**用户 N39 回填第二轮的实测原文**）

微信开发者工具（WeChatLib 3.17.2，Windows；PP19 的 `require("url")` 已消失）：

```
TypeError: Cannot set properties of undefined (setting 'sid')
    at fu.onHandshake (engine.io-client 的 Socket.onHandshake …)
    at c.onData (…) at <socketTask.onmessage callback function>
```

**含义**：连接**已经建到服务端**、服务端也回了 handshake 包，但握手在**最后一步**崩掉。

**根因（读 engine.io-client@6.6.6 源码逐条对齐）**：

| 事实 | 出处 |
|---|---|
| 基类公开四个字段：`this.opts` / `this.query = opts.query` / `this.socket = opts.socket` / `this.supportsBinary = !opts.forceBase64` | `build/esm/transport.js:22-27` |
| `Socket.onHandshake` 会 **写** `this.transport.query.sid = data.sid` | `build/esm/socket.js:276` ← **崩溃点** |
| `Socket` 对传输的成员访问集合 | `grep -oE "this\.transport\.[a-zA-Z_]+" socket.js \| sort -u` ⇒ `{close,name,pause,query,removeAllListeners,send,writable}` |
| 基类的 `pause(onPause)` 在 v6 是**空实现** | `transport.js:115` |

我们的类当初是**独立类**（没有继承基类），只实现了收发与事件面 ⇒ **漏了 `query`**（以及 `pause`）⇒
`undefined.sid = …` 抛错。**连接本身没问题**（`connectSocket` 已被调用），是**对象契约**缺了一块。

## 绑定数值（实测）

| 项 | 值 |
|---|---|
| engine.io-client 解析版本 | **6.6.6**（`socket.io-client@4.8.3` 的依赖） |
| 触发点 | `src/net/mp-transport.ts` 的类构造（未公开 `query`） |
| 修复后 | client 单测 **276 → 279 passed**（+3 契约测试）· 三端 build DONE · dev 探针 16/16 · turbo 29/29 · ci 全绿 |
| 已用最大裁决号 | **R573**（P19 计划） |

## 裁决（本片新增）

- **R574 补契约面，而不是继承 engine.io 的基类**：在类里显式公开
  `opts` / `query` / `socket` / `supportsBinary`，并补上 `pause()`（与基类同形的空实现）。
  **理由**：`import { Transport } from 'engine.io-client'` 会往 `src/**` 引入新的**裸依赖**，
  而 §12.4 的 `test/source-boundary.test.ts` 把裸依赖白名单钉死为 `['pinia','socket.io-client','vue']`
  —— **R435 明确「不得以任何理由放宽 §12 的闸」**。补字段的成本极小，且由 R575 的真消费者判据兜住。
  代价若判错：契约面靠测试维持（不靠继承自动同步）—— 但「继承」本身也需要新依赖，不是零成本选项。
- **R575 判据必须是「真消费者」，且必须有负对照**：新增
  `apps/client/test/mp-transport-engine-contract.test.ts`：用 **engine.io-client 自己的 `Socket`** + 假 `wx`，
  构造（v6 的 `Socket` **在构造里 `_open()`**）→ `fireOpen()` → 灌入真实握手包 `0{"sid":…}`
  ⇒ 断言**不抛错**且 `engine.id` / `transport.query.sid` / `engine.readyState` 三项到位；
  另两条：契约面成员逐条存在（对照 `socket.js` 的那份成员清单）· `query` 与 engine **共享同一对象引用**（重连要带 sid）。
  **负对照**：把 `query` 临时打回 `undefined` ⇒ 三条**全红**（含用户那条崩溃原文），随后还原。
  依据：旧的 31 条用例只测**我们自己定义的接口**，而这次崩在**真实消费方**的用法上。
- **R576 `engine.io-client` 只作为 `apps/client` 的 devDependency**（测试用），**不进 `src/**` 的依赖面**：
  这样既拿到「真消费者」判据，又不触碰 §12 的白名单（R574 的同一约束）。

## 交付与门禁

- [x] `src/net/mp-transport.ts`：公开 `opts`/`query`/`socket`/`supportsBinary` + `pause()`；`uri()` 改读 `this.query`
      （**同一个对象引用**，engine 写的 `sid` 才会进重连 URL）
- [x] `test/mp-transport-engine-contract.test.ts`（3 条 + 负对照已取证）
- [x] `apps/client` 加 `engine.io-client@6.6.6` devDependency（lockfile +3 行）
- [x] 门禁：client **279 passed + 2 skipped** · `vue-tsc` 干净 · 三端 build **DONE** ·
      dev 探针 `gate` **16/16** · `turbo run test lint --force` **29/29、0 cached** · `pnpm run ci` 六阶段全绿
- [ ] **用户复跑**：重新构建 + 开发者工具重载，看是否走到「注册 → 大厅 → 牌桌」

## 回填区（执行期裁决，不要删）

（执行期发现与计划不符时在此追加并编号：本片协调者区间 **R574–R585**。）
