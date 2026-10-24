# 切片 P19 实施计划：小程序端 `require("url")` 阻断级缺陷（N43）

**Goal:** 消除小程序端**求值期就崩**的缺陷，使「注册 → 大厅 → 牌桌」在小程序端**能走到**；
并把这条判据做成**自动的**（源码级闸 + 产物级断言），不再依赖人工跑开发者工具才发现。

## 为什么现在做（**用户 N39 回填的实测原文**，不是推测）

微信开发者工具（WeChatLib 3.17.2）打开 `dist/build/mp-weixin` 后，控制台**编译通过但运行期报错**：

```
Error: module 'url.js' is not defined, require args is 'url'
    at … o (appservice/getmainpackagebundle.js:7422:47)
    at (anonymous) @ http.js:1
    at (anonymous) @ socket.js:1
    at (anonymous) @ session.js:1
    at (anonymous) @ useGameSession.js:1
    at (anonymous) @ app.js:1
Page "pages/login/login" has not been registered yet.
```

**根因（本地静态定位，逐条实证）**：

1. 小程序产物里 `config.js` 与 `net/transport.js` **各含一处 `require("url")`**：
   ```js
   { url: typeof document === 'undefined'
       ? require("url").pathToFileURL(__filename).href
       : document.currentScript?.src ?? new URL(<file>, document.baseURI).href }
   ```
   这是**打包器为 `import.meta` 生成的 helper**（不是我们手写的）。
2. 触发它的是 `src/config.ts` 与 `src/net/transport.ts` 里的
   **`typeof import.meta !== 'undefined'` 守卫** —— 该守卫逼打包器把 `import.meta` **实体化**。
3. 微信小程序的 service 上下文**没有 `document`** ⇒ 只能走 `require("url")` 分支 ⇒
   小程序模块系统里没有 Node 的 `url` ⇒ **抛错**。
4. 抛错发生在 `app.js` 的**模块求值期** ⇒ **整条模块图中断** ⇒
   页面注册代码（在 app.js 求值之后）从未执行 ⇒
   `Page "pages/login/login" has not been registered yet.`（**一条根因、两个症状**）。

⚠️ **这是 P10 就埋下的缺陷**：P10 的三端「结构判据」（产物存在、`usingComponents` 15/15、四件套齐全）
**结构上抓不到它** —— 只有真跑一次开发者工具才会暴露。这正是 N39 回填的价值。

## 绑定数值（实测）

| 项 | 数值 |
|---|---|
| 触发点 | `src/config.ts:23`（`readEnv`）· `src/net/transport.ts:76-78`（`readWsEndpointEnv`） |
| 产物中的位置 | `dist/build/mp-weixin/config.js` · `dist/build/mp-weixin/net/transport.js`（各 1 处 `require("url")`） |
| 修复后 | 全产物 `require("url")` / `pathToFileURL` 计数 **0**（含 `common/vendor.js`） |
| 端点注入仍有效 | `config.js` 内联 `VITE_API_BASE:"http://localhost:3000/api"` / `VITE_WS_ENDPOINT:"http://localhost:3000"` |
| 已用最大裁决号 | **R568**（P18 计划） |

## 裁决（本片新增）

- **R569 正确写法 = 只用直接的属性访问**（`import.meta.env.VITE_X` / `import.meta.env?.[key]`）。
  依据：构建期即被替换成字面量，`import.meta` 本身不再需要实体化（实测：修复后两处产物 helper 全消）。
  ⚠️ **不得**为了「防 `import.meta` 未定义」再加回任何 `typeof import.meta` / `import.meta.url` 守卫
  ——那正是本片要根治的形态；测试环境（vitest）本来就提供 `import.meta.env`。
  代价若判错：在**没有构建步骤**的裸 Node 里 `import.meta.env` 为 `undefined`（本仓无这种消费方；测试走 vitest）。
- **R570 两条防线，缺一不可**：
  ① **源码级闸** `apps/client/test/import-meta-guard.gate.test.ts`：`src/**` 不得出现
  `typeof import.meta` / `import.meta.url` / `import.meta.currentScript|resolve`（剥注释 + 合成样本自证判别力 + 扫描面自证）；
  ② **产物级断言**（自动跑在构建入口里）：`scripts/build-mp-weixin.mjs` 在构建成功后扫
  `dist/{build,dev}/mp-weixin` 的 `.js`，发现 `require("url")` 或 `pathToFileURL` ⇒ **非零退出**并解释后果。
  依据：源码级闸只拦我们自己的代码，**依赖同样可能引入那个 helper**（P17 的实现者早就提醒过「产物判据要对着运行期可达的东西写」）。
  代价若判错：每次 mp 构建多 ~0.2s 扫描。
- **R571 `src/**` 的注释里也不得出现 `require("url")` 字面量**。
  依据（本片实测）：§12 的 `test/source-boundary.test.ts` 的 import 扫描**不剥注释**，
  而本仓注释习惯逐字引用真实写法 ⇒ 我在 `config.ts` 的解释里写了 `require("url")`，
  那条闸当场把 `url` 当成第 4 个裸依赖（`expected [ 'pinia', 'socket.io-client', …(2) ] to deeply equal [...]`）。
  ⇒ 注释改用 `require(<Node 的 url 模块>)` 这种**不含引号**的写法；**不动 §12 的闸**（R435：不得放宽）。
  代价若判错：注释的逐字保真度略降（用文字补足）。
  ⚠️ **副产品发现**：§12 的 import 扫描对注释**盲**，这是本会话第三次撞上「解释得越清楚、闸越红」
  （见 `ui-tokens.test.ts` / `uni-api-access.test.ts` 的同款处置）——**登记为待办**（见回填区）。

## Tasks

### Task 1（协调者，本片即实现者）：修 + 两道防线
- [x] `src/config.ts` / `src/net/transport.ts`：去掉 `typeof import.meta` 守卫，改直接属性访问（R569）
- [x] 新增源码级闸 `apps/client/test/import-meta-guard.gate.test.ts`（R570①）
- [x] `scripts/build-mp-weixin.mjs`：构建成功后自动跑产物级断言（R570②）
- [x] 注释去字面量（R571）
- [x] 判据：mp 产物 `require("url")` = 0；client 单测全绿且用例数只增不减；三端 build DONE

### Task 2（协调者）：门禁 + 收口
- [x] 全量门禁（含 dev 探针与**发行产物级**探针：`config`/`transport` 都动了）
- [x] 台账 **N43 新登记并同片关闭**；`design.md` §1.4 的「小程序端验证状态」同步；
      `agent-briefs.md` 记环境事实 + 教训；N39 回填清单补「重新构建 + 重开/重载项目」一
- [ ] **用户复跑**：按清单重新 `node scripts/build-mp-weixin.mjs <host:port>` 并在开发者工具里重载

## 门禁

```bash
cd /home/howe/pokergame
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached
pnpm run ci                                  # ✅ 六阶段全绿
cd apps/client && pnpm test && pnpm lint && pnpm build:h5 && pnpm build:app   # ✅
node ../../scripts/build-mp-weixin.mjs localhost:3000   # ✅ 内含产物级判据（无 require("url")）
node scripts/browser-e2e.mjs                 # ✅ dev gate 16/16
pnpm --filter @fight-the-landlord/client preview & node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server  # ✅ 发行产物 16/16
node scripts/ledger-counts.mjs               # ✅ 逐区一致
```

## 回填区（执行期裁决，不要删）

- **R572**（协调者，执行期）**「§12 的 import 扫描对注释盲」登记为待办，不在本片顺手改**。
  依据：本片是阻断级缺陷修复，动 §12 的闸会让「修 bug」与「改规格闸」混在一次提交里，
  而 R435 明确「§12.4 的闸一条都不能少、不得以任何理由放宽」。**修法方向**（留给下一片）：
  给 `test/source-boundary.test.ts` 的 import/require 扫描加**剥注释**（与 `ui-tokens.test.ts` /
  `uni-api-access.test.ts` 同款处置），并配合成样本自证「真代码里的违规仍会被抓到」。
  代价若判错：注释里引用 import 的写法继续会绊闸（本会话已第三次）。
- **R573**（协调者，执行期）**产物级判据放在「构建入口脚本」里，而不是放进 vitest**。
  依据：mp 构建 ~10-20s，放进单测会显著拖慢；而「谁构建谁被检查」把判据放在了**唯一的必经路径**上
  （P17 的教训：判据要对准运行期可达的东西，且不能依赖人记得跑）。
  代价若判错：绕过脚本直接 `pnpm --filter client build:mp-weixin` 的人不会被这条闸拦
  —— 但他仍会撞上源码级闸（若自己写了触发形态），且清单里只推荐脚本入口。
