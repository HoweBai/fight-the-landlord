# 切片 P21 实施计划：小程序传输的 `drain` 时序与 pong 归属（N45）

**Goal:** 修掉小程序端**发送时必然栈溢出**的缺陷（用户 N39 回填第三轮实测），并纠正一处**互相掩护的双 bug**
（传输层代回 pong ＋ 又把 engine 的 pong 过滤掉）。

## 为什么现在做（**用户 N39 回填第三轮的实测原文**）

P19（`require("url")`）与 P20（`transport.query`）都已消失；新报错是：

```
RangeError: Maximum call stack size exceeded
    at fu._onDrain   (engine.io 的 Socket._onDrain)
    at h.emit        (我们传输的 emit)
    at h.write       (我们传输的 write)
    at h.send        (我们传输的 send)
    at fu.flush      (engine.io 的 Socket.flush)   ← 回到上一行 ⇒ 无限递归
```

**根因（读 engine.io-client@6.6.6 源码）**：`Socket.flush()` 是**先 send、后记账**：

```js
this.transport.send(packets);
this._prevBufferLen = packets.length;   // ← send 同步 emit drain 时它还是 0
```

⇒ 传输层**同步** `emit('drain')` ⇒ `_onDrain()` 用**过期的 0** 去 `writeBuffer.splice(0, 0)`（一条都清不掉）
⇒ `writeBuffer.length !== 0` ⇒ `flush()` ⇒ `send()` ⇒ 递归到栈溢出。
浏览器传输的源码注释就是答案（`transports/websocket.js`）：

```js
// fake drain
// defer to next tick to allow Socket to clear writeBuffer
nextTick(() => { this.writable = true; this.emitReserved("drain"); });
```

## 同片发现的第二处（**两个 bug 互相掩护**）

我们当初把 pong 当成**传输层职责**（收到 `2` 就回 `3`），但 engine.io v4 的 pong 是 **engine 的 `Socket`** 回的
（`Socket._onPacket` 的 `case "ping": this._sendPacket("pong")`）。于是：
- 传输层回一帧 ⇒ 服务端每个 ping 收到**两个** pong；
- 旧实现为了「去重」又在 `write()` 里 `continue` 掉 `{type:'pong', data:undefined}` ⇒
  **engine 要发的那个 pong 根本没上线** ⇒ 服务端在 `pingInterval + pingTimeout` 之后会**踢线**。
⇒ 这两个 bug 互相掩护：单看哪一处都「像是对的」，合起来是「多发一帧 + 漏发正主」。

## 裁决（本片新增）

- **R577 `drain` 必须延到下一个 tick**，且写期间 `writable = false`（与浏览器传输同形）。
  依据：`Socket.flush()` 的记账顺序（上面原文）。代价若判错：发送后 `writable` 晚一个 tick 复位
  （与浏览器端行为一致，engine 的 `flush()` 本来就检查 `writable`）。
- **R578 pong 归 engine，传输层只透传**：删除传输层的 pong 回复，**并删除** `write()` 里对 engine pong 的过滤。
  依据：`Socket._onPacket` 的 `case "ping"` 是权威实现。代价若判错：心跳由 engine 负责（这正是它的设计）。
- **R579 当既有用例编码的是**错误行为**时，必须**反转**它们并写清依据**（不是删除、不是放宽）。
  本片反转 3 条（`② 心跳` 组的 3 条）：从「收到 `2` 立刻写 `3`」翻成「传输层一帧都不写 + engine 的 pong 必须上线」。
  依据：这些用例当初把实现者的错误假设**固化**下来了（旧注释甚至写「每次心跳只有一帧 3」）。
- **R580 真消费者判据要覆盖**时序/记账**契约，不只是「字段存在」**：新增两条（发送不递归 + 每个 ping 恰好一帧 pong），
  并各自取负对照。依据：P20 只补了「字段存在」类判据，而本片的缺陷是**时序**类的 —— 字段都在，照样栈溢出。

## 交付与门禁

- [x] `src/net/mp-transport.ts`：`write()` 的 drain 延后到下一个 tick；`onData()` 不再代回 pong；删掉 `writePong()` 与 pong 过滤
- [x] `test/mp-transport.test.ts`：反转 3 条旧用例（心跳组）
- [x] `test/mp-transport-engine-contract.test.ts`：新增 2 条真消费者判据（发送不递归 / 恰好一帧 pong），
      **两条负对照均已取证**：① 打回同步 drain ⇒ `RangeError: Maximum call stack size exceeded`（用户原文）；
      ② 打回传输层回 pong ⇒ `expected [ '3', '3' ] to have a length of 1 but got 2`
- [x] 门禁：client **281 passed + 2 skipped**（279+2 ⇒ +2）· `vue-tsc` 干净 · 三端 build **DONE** ·
      dev 探针 `gate` **16/16** · 发行产物级 `gate` **16/16** · `turbo run test lint --force` **29/29、0 cached** · `pnpm run ci` 六阶段全绿
- [ ] **用户复跑**：重建 + 开发者工具重载 ⇒ 看是否走到「注册 → 大厅 → 牌桌」

## 回填区（执行期裁决，不要删）

（执行期发现与计划不符时在此追加并编号：本片协调者区间 **R577–R590**。）
