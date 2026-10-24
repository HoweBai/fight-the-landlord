# 切片 P17 实施计划：小程序端 REST 与端点（N42）

**Goal:** 让 `apps/client` 的 **REST 层在三端都可用**（现在只在小程序端必挂），并让**端点配置**在小程序端
**响亮地**要求绝对地址；产出一个跨平台的构建入口与 N39 回填清单，使「小程序端能不能跑」这件事**真的可验**。

**为什么现在做（实测证据，不是推测）**：

```bash
# 小程序产物里 REST 是**裸 fetch**，而整个产物**没有** fetch 的 polyfill
apps/client/dist/build/mp-weixin/net/rest.js: async function r(e,o){const r=await fetch(`${n.clientConfig.apiBase}${e}`, …)}
grep -c "globalThis.fetch\s*=\|window.fetch\s*=\|function fetch" …/common/vendor.js   # ⇒ 0
```

微信小程序运行时**没有全局 `fetch`**（只有 `wx.request` / uni 的 `uni.request`）⇒ **注册/登录/房间列表第一步
就 `fetch is not defined`**。P10 的 Task 3 只适配了**传输层**（socket.io → `wx.connectSocket`，已登记未验证），
**REST 层被漏掉**（计划里的硬约束 (e) 只写了 socket）。⇒ 若不补，**N39 的用户回填必然在第一步失败**。

另两处同族问题（实测）：
- `clientConfig.apiBase` 默认 **`/api`** —— 相对路径，小程序**没有「同源」概念**；
- `resolveEndpoint('')` 在无 `window.location` 时回退到**硬编码 `http://localhost:3000`**
  （开发者工具同机能凑合，**真机必挂**）。

**Spec:** `docs/design.md` §5.1（认证走 REST、WS 不承载登录）· §11.1（统一信封）· §12（哑终端）
· `2026-09-17-slice-p10-uniapp-migration.md`（硬约束 (e) 的正确外延）· `deviation-ledger.md` **N39**。

## 绑定数值（实测）

| 项 | 数值 |
|---|---|
| REST 的 fetch 调用点 | `src/net/rest.ts` 两处（`post()` 与 `send()`） |
| 直接 stub 全局 `fetch` 的测试 | **5** 个文件：`auth-flow` / `auth-ui-wiring` / `lobby-ux` / `rest-auth`（+ 其余经它们间接覆盖） |
| 可复用的平台判定 | `src/net/mp-transport.ts` 的 `classifyPlatform` / `detectPlatform` / `readUniSystemInfo` / `PlatformKind` |
| 现有 uni 测试替身 | `test/helpers/uni-stub.ts`（storage/页面栈/toast/平台），**缺 `request`** |
| 已用最大裁决号 | **R548**（本片区间 **R549–R560**） |

## 裁决（本片新增，执行时不得再自行解释）

- **R549 REST 走一个适配器、按平台分两条传输**：新增 `src/net/http.ts` 的 `requestJson()`，
  `platform === 'mp-weixin'` 用 **`uni.request`**，其余（`web`/`app*`/读不到平台）**保持 `fetch`**。
  **理由**：① 不产生「第二份 REST 实现」（信封解析、refresh 轮换、串行都仍在 `rest.ts` 一处）；
  ② **不动已验证的 H5 路径**（P9 真浏览器探针 + 发行产物级探针都压在这条路上）；③ 与 socket 传输**同构**
  （H5 浏览器路径 / 小程序适配路径，R441 补② 的同一逻辑）。
  代价若判错：多一条分支要维护（用「平台判定负对照」与「两条分支各有用例」兜住）。
- **R550 小程序端「配错就响亮报错」，不猜、不派生**：小程序端若 `VITE_API_BASE` 仍是相对路径、
  或 `VITE_WS_ENDPOINT` 为空 ⇒ **抛错**，错误信息必须**点名变量名**并给出构建入口命令。
  **不来**「从另一个变量猜 host」（REST 与 WS 是两条边，混为一谈会制造第二真源）。
  代价若判错：用户第一次跑会看到一条错误而不是一个能跑的页面 —— 那正是我们要的（比 `fetch is not defined` 好得多）。
- **R551 复用既有平台判定**：不得新建第二份平台探测；一律用 `mp-transport` 的
  `classifyPlatform` / `detectPlatform`（`web`/`app*` ⇒ 浏览器路径；`mp-weixin` ⇒ 适配路径；
  **其它平台明确报错**，不静默退化）。
- **R552 跨平台构建入口**：新增 `scripts/build-mp-weixin.mjs <host:port>`（Node，**零新依赖**，Windows/macOS/Linux 通用）：
  由**一个** `--gateway` 参数同时导出 `VITE_API_BASE=http://<host:port>/api` 与 `VITE_WS_ENDPOINT=http://<host:port>`，
  再调用 `pnpm --filter @fight-the-landlord/client build:mp-weixin`；并给 client 补 `dev:mp-weixin` / `dev:app` 脚本。
  依据：`.env.production` 会同时作用于 H5 的生产构建（**污染另一端的配置** = 第二真源），
  而 shell 前缀赋值在 Windows 上不可用（用户机器是 Windows/macOS）。
- **R553 机械闸（防复发）**：① `src/**` **不得出现裸 `fetch(`**（必须经由 `http.ts`）——源码级扫描；
  ② 平台负对照：`mp-alipay` 等平台一律报错（沿用 mp-transport 的既有判据）；
  ③ 小程序分支用**假 `uni.request`** 的用例覆盖 URL/方法/头/体/状态码映射与信封解析。
- **R554 N42 登记 + 同片关闭**：台账新增 **N42**（小程序端 REST 层用裸 `fetch`，REST 未被 P10 覆盖）并**同片关闭**；
  **运行期仍归 N39**（本片只保证「结构上能跑 + 配置错会响亮报错」，真机结论仍待用户回填）。

## Tasks

### Task 1（实现者）：REST 适配器 + 端点 + 脚本 —— ✅ 已完成
- [x] 新增 `src/net/http.ts`：`requestJson({ url, method, headers, body })` → `{ statusCode, text }`
      （`uni.request` 分支用**直接成员调用**，遵守 P10 的摇树注入坑；`fetch` 分支原样搬 `rest.ts` 现有写法）
- [x] `src/net/rest.ts` 的两处 `fetch` 改为经 `requestJson`；`resolveApiBase()` 按 **R550** 校验
- [x] `resolveEndpoint`（或 `socket.ts` 的使用点）按 **R550** 在 mp 端校验空 endpoint
- [x] `scripts/build-mp-weixin.mjs` + client 的 `dev:mp-weixin` / `dev:app` 脚本（R552）
- [x] 测试：`test/http.test.ts`（宿平台分支、假 `uni.request`、相对 base 报错、绝对 base 通过、平台负对照）；
      `test/helpers/uni-stub.ts` 补 `request`（语义贴真实 uni：`{ statusCode, data }`，非 JSON 由调用方兜底）
- [x] 机械闸（R553）：`src/**` 无裸 `fetch(`（新用例，带判别力自证：在合成的样本上必须报错）
- [x] 判据：`pnpm --filter @fight-the-landlord/client test` 全绿且**用例数只增不减**；`pnpm lint` 干净；三端 build DONE

#### Task 1 实测（2026-09-17，实现者交付 + 协调者独立复核；含 1 轮修复）

**交付**：`fc5500d` 适配器 `src/net/http.ts`（R549）· `a6e1d72` 端点校验（R550/R551）·
`df60433` 构建入口 + dev 脚本 + 测试（R552/R553）· **`9fa6fc2` 修复轮 1**（WS 端点相对路径校验，R556）。

| 项 | 读数 |
|---|---|
| client 单测 | **273 passed + 2 skipped**（基线 251+2 ⇒ **+22**，只增不减；`test/http.test.ts` 22 个） |
| `vue-tsc` | 干净（退出 0） |
| 三端构建 | `h5` / `mp-weixin`（568K）/ `app`（1.2M）全 **DONE** |
| **产物级核心判据** | `dist/build/mp-weixin/net/rest.js` 裸 `fetch(` **2 → 0**；`uni.request` 编译成 `common_vendor.index.request`；`vendor.js` 的 fetch polyfill 仍 **0** |
| 真浏览器探针（dev） | `gate` **16/16**（清 `.vite` 冷启动） |
| **发行产物级探针** | `gate` **16/16**（`preview` 4173）—— H5 的 REST 现在也经 `http.ts`，这条必须压 |
| 仓库门禁 | `turbo run test lint --force` **29/29、0 cached** · `pnpm run ci` **六阶段全绿** |

**旁证（实现者给的两条，协调者采信）**：① H5 **发行产物**里同一处被改写成 `@dcloudio/uni-h5` 的具名 import
（不是 `window.uni.request`）⇒ P10 第 7 条的摇树注入坑在**发行构建级**被复核；
② `node scripts/build-mp-weixin.mjs 192.168.1.5:3000` 真跑通，该次 `dist/build/mp-weixin/config.js` 里
确有 `VITE_API_BASE:"http://192.168.1.5:3000/api"`。

### Task 2（协调者）：门禁 + N39 清单 + 收口
- [ ] 全套门禁（见下，**含发行产物级探针**——REST 路径在 H5 上仍是 `fetch`，但代码动过）
- [ ] 产出 **N39 回填清单**：`docs/superpowers/plans/2026-09-17-n39-miniprogram-app-backfill.md`
      （命令用 `scripts/build-mp-weixin.mjs <你的局域网IP:3000>`；开发者工具「不校验合法域名」；要回的原文四项）
- [ ] 台账 N42（同片关闭）· §0 重算 · `agent-briefs.md` 记环境事实 + 教训

## 门禁

```bash
cd /home/howe/pokergame
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached
pnpm run ci                                  # ✅ 六阶段全绿
cd apps/client && pnpm build:h5 && pnpm build:mp-weixin && pnpm build:app   # ✅ 三端 DONE
# 产物级判据（本片新增的关键一条）：
node -e "const s=require('fs').readFileSync('apps/client/dist/build/mp-weixin/net/rest.js','utf8'); console.log('裸 fetch 计数 =', (s.match(/\bfetch\(/g)||[]).length)"
                                             # ✅ 必须为 0（改前是 2）
node scripts/browser-e2e.mjs                 # ✅ gate 16/16（H5 路径不许回归）
pnpm --filter @fight-the-landlord/client preview & node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server
                                             # ✅ 发行产物级 16/16（R449 补④）
node scripts/ledger-counts.mjs               # ✅ 逐区一致
```

**不跑**：conformance / `docker compose build`（本片不改后端任何一行，也不改协议）。

## 回填区（执行期裁决，不要删）

（执行期发现与计划不符时在此追加并编号：本片协调者区间 **R549–R560**。）

- **R555**（协调者，执行期）**构建入口的用户可见契约 = 位置参数**：`node scripts/build-mp-weixin.mjs <host:port> [--dev]`
  （R552 里写的「一个 `--gateway` 参数」是措辞，实现按**位置参数**；已兼容 `http(s)://` 前缀与结尾 `/`）。
  代价若判错：改回旗标解析是一行改动，但会动用户可见命令。
- **R556**（协调者，执行期，**修复轮 1**）**R550 的校验补成对称的两条**：小程序端
  `VITE_API_BASE` 是相对路径 ⇒ 报错（原有）；**`VITE_WS_ENDPOINT` 是「空 或 相对路径」⇒ 也报错**（新补）。
  依据：实现者发现 `/ws` 这类相对 endpoint 在小程序上**同样必挂**（无「同源」可言），
  而 R550 初稿只列了「空」。两条共用同一个 `ABSOLUTE_URL`，且**只在 mp 分支内**校验（浏览器路径逐字未动，有正对照用例）。
  代价若判错：用户多看到一条明确报错 —— 比 `fetch is not defined`/连不上好。
- **R557**（协调者，执行期）**`uni.request` 的 `fail` 在小程序端落成既有信封 `10007`，而 H5 的 `fetch` 拒绝保持原样抛出**
  —— 这处**不对称是刻意的**。实现方式：`http.ts` 抛 `TransportFailureError`（消息含 `statusCode: 0`），
  `rest.ts` **只** catch 这一个类交给既有 `parse` 兜底（§11.1 的「拿到的不是平台信封」⇒ `10007`）；
  H5 的 `TypeError: Failed to fetch` 继续上抛（P9 探针与 5 个既有测试文件压着这条行为）。
  代价若判错：两端错误呈现略有差异（两端都被上层正常处理）；**不这样做**的代价是动 H5 的既有语义（更贵）。
- **R558**（协调者，执行期）**产物级判据只扫 `net/rest.js`**，**不得**改用「全产物 `grep fetch(` = 0」当判据：
  `net/http.js` 里**仍保留** fetch 分支的代码（**运行期的平台分支**，在 mp 上不可达）。
  真正的防线是**源码级机械闸**（R553：`src/**` 只有 `net/http.ts` 一处豁免，带正反样本 + 剥注释）。
  依据：实现者点出了这个「判据会误判」的形态；本仓对「恒绿/恒红的判据」付过多次代价。
  代价若判错：换判据时容易把一个**正确**的实现判成红。
