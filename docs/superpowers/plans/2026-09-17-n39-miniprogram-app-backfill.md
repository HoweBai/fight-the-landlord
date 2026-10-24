# N39 回填清单：微信小程序 / App 的运行期验证（需要你的 Windows / macOS）

> **这是什么**：切片 P10 把前端迁到 uni-app 后，**H5 端已用真浏览器探针验证**（dev `gate` 16/16 · `full` 20/20；
> **发行产物** `gate` 16/16 · `minimal` 8/8）；而**微信小程序 / App 的运行期本机无法验证**
> （Linux 上没有微信开发者工具；App 需 HBuilderX + DCloud 凭据，iOS 还要 macOS）。
> 台账 **N39** 就是这件事的登记项。**这一页的任务是把那两端的结论补回来**，然后我把 N39 关闭。
>
> **R440 口径**：在回填之前，仓库里任何地方**都不会**写「已支持小程序 / 已支持 App」。

---

## 0. 前置（只做一次）

1. 仓库在**包含 P10/P16/P17 的 master** 上（`git log --oneline -1` 应能看到 P17 的 commit）。
2. `pnpm install`（本仓要求：`CI=true pnpm install --store-dir .pnpm-store`），再 `pnpm build`。
3. **8 个容器在跑**（`docker compose up -d`；`docker ps` 里应有 `ftl-api-gateway` 等 8 个 healthy）——
   它们提供服务端。**网关在 3000**。
4. 想清楚「谁是 host」：
   - **只用微信开发者工具**（Windows/macOS，与容器同一台机器）：用 `localhost:3000` 即可；
   - **要真机预览**（手机跑小程序）：必须用**容器所在机器的局域网 IP**（如 `192.168.1.5:3000`），
     且手机与电脑同一 Wi-Fi。

---

## A. 微信小程序端 —— ✅ **已完成（2026-09-17）**

> **回填结果**：用户在 Windows + 微信开发者工具 3.17.2 上跑通 **注册 → 大厅 → 随机匹配 → 牌桌 17 张牌 →
> 完成对局**（连续三局，无阻塞）。协同旁证（语网本机日志）：`[ProxyGateway] Client connected (user: …)`
> ＋ `[WsGateway] Released 2/2 bot(s) for QZTYNX / 8VRZJU / RT6XSR`（机器人释放只在对局收束时发生）。
> ⚠️ **本轮共抓到四处阻断级缺陷并修掉**（P17 REST 裸 `fetch` / P19 `require("url")` / P20 传输契约 `query` /
> P21 同步 `drain` + pong 归属）—— 下面是当时的操作步骤，留作复现记录。

## A（原始步骤，留档）. 微信小程序端（四项回填）

### A1. 构建（带端点）

```bash
# 在仓库根：<host:port> 换成上面第 4 步定下的那个
node scripts/build-mp-weixin.mjs localhost:3000        # 只用开发者工具
node scripts/build-mp-weixin.mjs 192.168.1.5:3000      # 要真机（换成你的 IP）
```

它会用**同一个参数**同时配置 REST（`VITE_API_BASE=http://<host:port>/api`）与 WebSocket
（`VITE_WS_ENDPOINT=http://<host:port>`），然后构建到 **`apps/client/dist/build/mp-weixin`**。
（脚本开头会把这两个变量打印出来，请顺手核对一眼。）

⚠️ **两个输出目录别弄错**（协调者已实测脚本行为）：
- **不加 `--dev`**（一次性构建）⇒ 产物在 **`dist/build/mp-weixin`**，开发者工具导入**这个**目录；
- **加 `--dev`**（监听模式、可热更新）⇒ 产物在 **`dist/dev/mp-weixin`**，开发者工具导入**那个**目录。

脚本的错误路径也实测过：参数写错/少给 ⇒ 打印用法并以 `1` 退出，**不会**启动半个构建；
`IPv6` 字面量（`[::1]:3000`）会被拒（请用域名或 IPv4）。

> ⚠️ **本片的三轮实测各抓到一个阻断级缺陷，均已修掉**（重建后应依次消失）：
> - 第一轮 `Error: module 'url.js' is not defined, require args is 'url'` ＋ `Page "…" has not been registered yet.` ⇒ **P19**
> - 第二轮 `TypeError: Cannot set properties of undefined (setting 'sid')`（engine.io 传输契约缺 `query`）⇒ **P20**
> - 第三轮 `RangeError: Maximum call stack size exceeded`（同步 `drain` 递归）＋ 心跳 pong 归属 ⇒ **P21**
>
> 下面这段是**第一轮**那条的说明，留作记录：
>
> ⚠️ **若你在第一轮里撞到过 `Error: module 'url.js' is not defined, require args is 'url'` ＋
> `Page "pages/login/login" has not been registered yet.`** —— 那是切片 **P19 已修掉的阻断级缺陷**
> （产物里因 `typeof import.meta` 守卫生成了 `require("url")` 分支，而小程序 service 没有 `document`）。
> **请先重新拉到含 P19 的 master，再重新构建**（下面的 A1 会顺带跑产物级判据，输出里应看到
> `✅ 产物级判据：无 require("url") / pathToFileURL`），然后在开发者工具里
> **重新编译 / 清缓存后重载项目**（旧的 `dist/build/mp-weixin` 是崩的那一版）。

### A2. 打开开发者工具

1. 微信开发者工具 → **导入项目** → 目录选 **`apps/client/dist/build/mp-weixin`** → AppID 选「**测试号**」。
2. **详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**
   （我们连的是 `http://` 的本地网关，不勾会直接被拦）。

### A3. 走最小路径

**注册（随机手机号 + 任意密码）→ 大厅 → 点「随机匹配」→ 进牌桌**（牌桌上应有 17 张手牌）。

### A4. 把下面四项原文回填给我

| # | 要回填什么 | 怎么取 |
|---|---|---|
| ① | **能否编译通过** | 开发者工具的 Console 面板：**有红字就整段复制**（含堆栈） |
| ② | **最小路径是否走通**（走到牌桌、17 张牌） | 走一遍，告诉我卡在哪一步 + 截图/文案 |
| ③ | **控制台 / Network 面板的报错原文** | Console 全量；Network 里失败请求的 **URL + 状态码 + 响应体前 200 字** |
| ④ | **socket.io 在小程序端是否连得上**（硬约束 (e) 的唯一答案） | 两个证据一起给：**(a)** 开发者工具里有没有连接相关报错；**(b)** 在跑网关的机器上执行<br>`docker compose logs --since 5m api-gateway \| tail -20`，把里面的行贴回来 —— 连上的话会有<br>`[ProxyGateway] Client connected: … (user: …)` |

### A5. 判定（我按这个收口）

- ✅ **通过**：①编译无错 ②走到牌桌且 17 张牌 ④网关日志出现 `Client connected` ⇒ 我把 N39 的小程序半边改成「已验证（用户实测，附原文）」。
- ⚠️ **部分通过**：能编译、能登录，但 socket 连不上 ⇒ 记成「REST 已通、传输层未通」，并把 ④ 的原文当作**新缺口**登记。
- ❌ **失败**：贴回原文即可 —— 那也是**有价值的结论**（比「未验证」强），我据此定位。

---

## B. App 端（可选，能做到哪步算哪步）

| 步骤 | 需要什么 | 回填什么 |
|---|---|---|
| B1. `pnpm --filter @fight-the-landlord/client build:app` | 无（Linux 也能跑，本机已验证） | 产物 `dist/build/app` 是否存在 |
| B2. HBuilderX **运行调试** | Windows/macOS + HBuilderX（拖入**仓库里的 `apps/client`**，它是 CLI 工程） | 能不能起来 + 控制台原文 |
| B3. **云打包** APK | **DCloud 账号**（登录 HBuilderX）+ Android 包名/证书 | 成功/失败的原文 |
| B4. iOS | **macOS + Xcode** + `profile`/`p12` | 同 B3 |

⚠️ B3/B4 需要**你的 DCloud 凭据**，我这边做不了；B2 也做不了（本机 `java`/`gradle`/`adb` 全缺）。

---

## C. 回填之后我会做什么

1. 把台账 **N39** 按实际结论改写（已关闭 / 部分关闭 + **附你回的原文**）；
2. `design.md` §1.4 的「各端验证状态」同步（现在写的是「小程序/App 仅产物与结构已验证」）；
3. `agent-briefs.md` 的交接现状同步；
4. 若发现真缺陷 ⇒ 另立切片（附你的原文作为**负对照**）。

---

## D. 已知的两处「非阻塞」差异（不必当缺陷报）

1. `src/net/mp-transport.ts` 的 pong 去重与同步 `drain` 与标准 engine.io 客户端略有差异（P17 计划里有登记）；
2. 小程序产物 `common/vendor.js` 里**仍留有** socket.io 的浏览器传输代码（运行时不会走到，但摇不掉）。
