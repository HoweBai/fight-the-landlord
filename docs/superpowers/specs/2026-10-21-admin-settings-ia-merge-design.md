# 后台设置页 IA 合并：广告 + 广告回调、客户端接入 + 风控安全 — 设计

- 日期：2026-10-21
- 状态：对抗审查已修订（1 阻断 + 1 高 + 9 低，见 §9），待实现计划
- 范围：`admin/` 静态三件套 + 静态机械闸；**不动**协议 / 服务端 / 数据库 / conformance 切片
- 用户裁决：
  1. 「广告」与「广告回调」合成一页（不再保留独立广告回调叶）；
  2. 「风控安全」与「客户端接入」合并，**叶名保留「风控安全」**，客户端接入作为页内末尾页签。

## 1. 背景与问题

v2.1 设置页把左树分成「通用设置 / 渠道与凭据 / 运营 / 安全与审计」。其中：

- 「广告」（配置域 `dataAds`，1 键 `ad.reliefAdpid`）与「广告回调」（独立视图 `adChannel`，
  独立 API `/api/admin/ad-channel`）概念同属广告，却分散在两个分组、两个页面；
- 「客户端接入」（配置域 `client`，2 键）与「风控安全」（配置域 `risk`，10 键）同为
  super_admin/operator 的配置面，左树却占两个叶。

合并后减少左树叶数与页面跳转，不改变任何配置键、API 或权限真闸。

## 2. 范围

### 做

- 左树「广告」单叶：页内 = 广告位配置分区 + 广告回调凭据面板。
- 左树「风控安全」单叶：页内页签 = 检测规则 / 谓词与处置 / 设备绑定 / 数据与扫描 / **客户端接入**。
- 删除左树叶 `nav-cfg-client-btn` 与可见的 `nav-ad-channel-btn`。
- 更新静态闸 `scripts/verify-admin-static.mjs` 的结构断言。

### 不做（YAGNI）

- 不改任何 `CONFIG_KEYS`、配置校验、API、数据库、角色 policy。
- 不改 conformance 切片（保留 hidden 锚点满足既有 G12 针脚）。
- 不改凭据三页中的支付渠道 / 通知通道。
- 不新增折叠树、二级菜单 UI。
- 不滚动重构（不抽组件、不改 render 架构）。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 广告合并为单一配置叶（域 id 仍为 `dataAds`）：先渲染「广告位」配置分区，再渲染 `#ad-channel-view` 凭据面板 | 用户拍板；复用既有域 id 与渲染路径，改动面最小 |
| D2 | 广告页角色 = `VIEWS.config` 的 `super_admin/operator`；finance 不再能看广告回调 | 用户拍板；合并后页面归属配置视图，避免为单面板维护双角色分流 |
| D3 | 广告回调面板仅在 `activeView === 'config' && cfgUI.domainId === 'dataAds' && 搜索词为空` 时显示 | 搜索只搜配置键（快照面），凭据不属于快照；避免搜索结果页混入无关面板 |
| D4 | 广告回调懒加载挂到「进入广告域」：`renderConfigRows` 末尾 `syncAdSection(q)`；仅当 `!loaded && !loading && !attempted` 时发 GET；`loaded` 时仅在 `#ad-channel-rows` 为空时重放渲染 | 原触发器是 `switchView('adChannel')`；面板 DOM 是 `#settings-rows` 的兄弟节点、重渲染不会清空它，无条件重放会清掉用户未保存的密钥输入；`attempted` 防失败后同域重渲染重试风暴，显式再点「广告」叶可重试 |
| D5 | 删除独立视图 `adChannel`（`VIEWS` / `VIEW_ORDER` / `SETTINGS_VIEWS` / `switchView` 分支 / 点击监听） | 页面已合并；保留死视图会让 `#settings-host` 显隐出现第二个来源 |
| D6 | 保留 `nav-ad-channel-btn` 为 `hidden` 锚点按钮、保留 `#ad-channel-view` 的 id 与「广告回调」字面量 | conformance slice-19 G12 逐字针脚：`nav-ad-channel-btn` / `ad-channel-view` / `广告回调`；照 `nav-config-btn` hidden 锚点先例，conformance 零改动 |
| D7 | 删除配置域 `client` 与叶 `nav-cfg-client-btn`；`risk` 域 tabs 末尾追加 `{ id: 'clientGate', name: '客户端接入', keys: ['client.appEnabled','client.h5Enabled'] }`；叶名保持「风控安全」 | 用户拍板；51 键集合不变，仅归属表调整 |
| D8 | `#ad-channel-view` 去掉 `.page-view` 类，改用内联面板类 `settings-inline-view`（同一滚动流，max-width 1100px） | `.page-view` 的 `flex:1 + overflow-y:auto` 在 `#settings-host`（非 flex 容器）内本不生效，但会带来整页 padding/gap 语义；合并后它是页内第二个面板，不该再按「整页视图」建模 |
| D9 | 未分组桶逻辑不变；两个记牌器价格键在 HEAD 已在「斗地主 → 对局辅助」 | 与本次合并无关，不回退 |
| D10 | 静态闸先红后绿：删除 `nav-cfg-client-btn` 必需项，新增旧叶/旧域消失、hidden 锚点、risk 页签、广告内联面板断言 | 机械闸跟随结构真源，防回潮 |
| D11 | 照 `.notify-channel-*` 同构补 `.ad-channel-*` 行样式 | 既有缺口：`buildAdChannelRow` 的类名在 style.css 中无任何规则，合并到广告页后会与通知通道行视觉不一致 |
| D12 | `applyRoleNav` 保留一行 `$('nav-ad-channel-btn').hidden = true;` | G12 的 **app.js** 针脚（slice-19:1440）与 `verify:admin` APP_NEEDLE 都要求该字面量；删监听后必须另有真实引用，不能用保留死 `VIEWS.adChannel` 的捷径（会被 applyRoleNav 反向显形） |

### 3.1 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| A. 页内面板（本设计）：广告回调作为广告域页内第二个面板 | 左树减一叶、复用既有渲染与 API；finance 失去访问（用户已拍板） |
| B. 页内页签：广告位 / 广告回调变成两个页签 | 需新增页签状态与渲染分支，收益仅是视觉切换，YAGNI |
| C. 仅归同组：两个叶都放「渠道与凭据」 | 不满足「收纳到一起」，用户已否决 |

## 4. 实现设计

### 4.1 `admin/index.html`

- 删除 `<button id="nav-cfg-client-btn">客户端接入…</button>`。
- 「渠道与凭据」组内删除可见的 `nav-ad-channel-btn`；在 `nav-config-btn` 旁保留
  hidden 锚点：`<button id="nav-ad-channel-btn" type="button" class="nav-leaf" hidden>广告回调</button>`。
- `#ad-channel-view` 由 `class="page-view"` 改为 `class="settings-inline-view"`，位置仍留在
  `#settings-host` 内（`#settings-rows` 之后），初始 `hidden`。
- 同步头注：配置域 6 叶 → 5 叶；凭据三页 → 凭据两页 + 广告回调并入广告页；
  「广告回调视图」改为「广告页内面板」、「读面有意含 finance」删除（与本设计 D2 矛盾）。

### 4.2 `admin/app.js`

- 注释同步：`activeView` 类型注释、`VIEWS` 「十二视图」注、`adChannelState` 注、
  `renderSettings` / `SETTINGS_VIEWS` / `switchView` / `showLoginView` / `CFG_NAV` 的
  「四视图 / 十二视图 / 6+1」等计数与「读面照通知通道（有意含 finance）」注。
- `CONFIG_IA`：
  - 删除 `client` 域；
  - `risk.tabs` 末尾追加 `clientGate` 页签；
  - `dataAds` 域保持 1 页签「广告位」。
- `CFG_NAV`：删除 `nav-cfg-client-btn` / `nav-count-client` 映射。
- `VIEWS` / `VIEW_ORDER` / `SETTINGS_VIEWS`：删除 `adChannel`。
- `switchView`：
  - 删除 `adChannel` 的 `renderSettings` 分支、懒加载分支、`SETTINGS_VIEWS` 成员；
  - `applyRoleNav` 保留一行 `$('nav-ad-channel-btn').hidden = true;`（G12 app.js 针脚 + 防误显），
    不保留 `VIEWS.adChannel`（否则 `applyRoleNav` 会按角色反向显形）。
- `renderSettings(view)`：
  - 只分流 config / payChannel / notifyChannel；
  - `config` ⇒ `renderConfigRows()`；非 config ⇒ `#ad-channel-view` 隐藏。
- `renderConfigRows` 末尾调用 `syncAdSection(q)`：
  ```js
  function syncAdSection(q) {
    const show = activeView === 'config' && cfgUI.domainId === 'dataAds' && !q;
    $('ad-channel-view').hidden = !show;
    if (!show) return;
    // 面板是 #settings-rows 的兄弟节点，重渲染不清空它；仅在确实为空时重放，
    // 避免把用户未保存的密钥输入静默重建掉。
    if (adChannelState.loaded) {
      if (!$('ad-channel-rows').firstChild) renderAdChannel();
      return;
    }
    if (!adChannelState.loading && !adChannelState.attempted) loadAdChannel();
  }
  ```
  - `adChannelState` 增 `attempted: false`；`loadAdChannel()` 起始置 `true`；成功置 `loaded=true`；
    `resetAdChannel()` 清零。
  - `openCfgDomain('dataAds')` 把 `attempted` 置回 `false`（显式再点叶 = 允许失败重试）。
  - `loadAdChannel()` 完成后照旧 `renderAdChannel()`；异步回调写隐藏节点无副作用。
- 删除 `$('nav-ad-channel-btn').addEventListener(...)`（字面量由 D12 的 applyRoleNav 行保留）。
- `showLoginView` 的 `resetAdChannel()` 保留（清 rows 状态与容器）。
- 点击「广告」叶仍走 `openCfgDomain('dataAds')`（无需新事件）。

### 4.3 `admin/style.css`

```css
/* 广告回调并入「广告」配置页：同一滚动流内的第二个面板，不再整页滚动。 */
.settings-inline-view {
  max-width: 1100px;
  padding: 10px 20px 0;
}

/* 广告回调行：照 .notify-channel-* 同构（既有缺口补齐）。 */
.ad-channel-rows { display: flex; flex-direction: column; gap: 10px; }
.ad-channel-row { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.ad-channel-label { min-width: 96px; padding-top: 6px; }
.ad-channel-state { min-width: 168px; padding-top: 6px; font-size: 12px; opacity: 0.85; }
.ad-channel-value code { font-size: 12px; word-break: break-all; }
.ad-channel-input {
  flex: 1;
  min-width: 220px;
  font-family: inherit;
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
```

（行布局照 `.notify-channel-*` 同构；输入框按**单行 `<input>`** 适配 —— `.notify-channel-input`
是 textarea 多行样式（width/box-sizing/monospace/resize），不逐字复用。）

### 4.4 `scripts/verify-admin-static.mjs`

- 必需 id 清单删除 `nav-cfg-client-btn`。
- 新增块级/标签级断言（避免全文 `includes` 假绿）：
  - `index.html` / `app.js` 不再含 `nav-cfg-client-btn` / `nav-count-client`；
  - `nav-ad-channel-btn` 在 index.html **恰一处**且为 hidden 锚点（同一 `<button>` 开标签断言）；
  - `app.js` 仍含 `nav-ad-channel-btn` 字面量（G12 app.js 针脚）；
  - `#ad-channel-view` 开标签含 `settings-inline-view`、含 `hidden`、不含 `page-view`；
    且位于 `id="settings-rows"` 之后、`<!-- /settings-host -->` 之前；
  - `style.css` 含 `.settings-inline-view {` 与 `.ad-channel-rows {` 规则；
  - `CONFIG_IA` 块用 `balancedBlock` 断言：无 `id: 'client'`、含 `id: 'clientGate'`；
    `risk` 域块（正则截取 `id: 'risk'` → tabs 收尾）含 `clientGate` 与两个 `client.*` 键；
  - `VIEW_ORDER` 数组块不含 `'adChannel'`；`SETTINGS_VIEWS` 行不含 `adChannel`；
    `VIEWS` 块不含 `adChannel:`；`switchView` / `renderSettings` 函数块不含 `adChannel`；
    `app.js` 不含 `switchView('adChannel')`；
  - `renderConfigRows` 函数块含 `syncAdSection(`；`app.js` 含 `function syncAdSection`。

## 5. 测试判据

1. 先改 `verify-admin-static.mjs`，在实现前跑红（新断言失败）。
2. 实现后 `npm run verify:admin` 全绿（基线 251 checks，新增断言后数量增加）。
3. `node --check admin/app.js` 语法通过。
4. 键面不变量：`CONFIG_IA` 仍覆盖 protocol 51 键、无表外键（既有断言）。
5. 人工/真浏览器（本地栈可用时）：
   - 登录后台 → 「广告」叶：广告位一行 + 广告回调面板；搜索时面板消失；
   - 「风控安全」叶：末尾出现「客户端接入」页签、两行开关；
   - finance 账号：左树无「广告」叶（与配置页一致）。
   - ⚠️ 本地 `.tmp-gen/admin-ia-v2-probe.mjs` 是旧 IA 探针（仍按 finance/operator 可见
     `nav-ad-channel-btn`、旧 risk 计数），不可作为本片判据；如需脚本验证须同步更新或绕开。

## 6. 错误处理与边界

- `GET /api/admin/ad-channel` 401 ⇒ `handleAuth` 回登录；503 ⇒ 状态条显示服务端 message；
  网络失败 ⇒「无法连接服务端」；面板仍在但 rows 为空（与合并前整页行为一致）。
- 搜索态、切换到其它域、切到支付渠道/通知通道：广告回调面板隐藏，已加载状态保留（缓存不丢）。
- 快照缺 `ad.reliefAdpid` ⇒ 广告叶计数 0 隐藏，「广告回调」随叶不可达（51 键齐全为数据不变量）。
- 登出：`resetAdChannel()` 清缓存与容器；**在途请求不取消**（既有行为，payment/notify 同构，
  本片不引入视图代次守卫）。
- operator 在广告面板只读（`canWrite = roleOf() === 'super_admin'` 不变）。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 删除 `adChannel` 视图导致 conformance G12 针脚失配 | index.html 保留 hidden 锚点与 section id、字面量；**app.js 由 `applyRoleNav` 的 `hidden` 行保留 `nav-ad-channel-btn` 字面量**；conformance 零改动 |
| 漏删 `VIEW_ORDER` / `SETTINGS_VIEWS` / `switchView` 分支导致登录即 TypeError | D10 的块级负断言（见 §4.4）在实现前先红 |
| 无条件重放渲染清掉未保存的密钥输入 | `syncAdSection` 仅在 rows 为空时重放；失败加 `attempted` 防重试风暴 |
| `#ad-channel-view` 移出 `.page-view` 后样式漂移 | 新增 `.settings-inline-view` + `.ad-channel-*` 行样式（照 notify 同构） |
| finance 访问权回退 | 用户已拍板；网关 policy 未改，服务端仍按原矩阵鉴权。**收面仅限 UI 可见性**：finance 用 curl 仍可读 `GET /api/admin/ad-channel`（该路由落 P8「任意已认证角色」），本次不改 RBAC |
| 旧叶 id 被外部脚本/文档引用 | `nav-cfg-client-btn` 仅 `verify-admin-static.mjs` 与历史 spec/plan 引用（本片更新前者、后者登记为被取代）；conformance 不引用 |
| 旧决策冲突 | 本设计**取代** `2026-10-15-client-access-gate-spec.md:34` 的「客户端接入独立叶 + 必需 id」要求，以及 `2026-10-11-ads-relief-spec.md` 的「广告回调读面有意含 finance」UI 决策；服务端 policy 不变 |

## 8. 涉及文件

- `admin/index.html`
- `admin/app.js`
- `admin/style.css`
- `scripts/verify-admin-static.mjs`
- `docs/superpowers/plans/2026-10-21-admin-settings-ia-merge.md`（计划，另行落盘）

## 9. 审查记录

2026-10-21 独立 reviewer 对抗审查（基线 `npm run verify:admin` 251 checks 全绿）。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 B1 | 按原 spec 删除 `nav-ad-channel-btn` 监听后，app.js 不再含该字面量 ⇒ conformance slice-19:1440 与 `verify:admin` APP_NEEDLE 双红；「conformance 零改动」不成立 | 已修订：D12 在 `applyRoleNav` 保留 `$('nav-ad-channel-btn').hidden = true;`，并在静态闸新增 app.js 字面量断言 |
| 高 H1 | 测试计划缺少 `VIEW_ORDER` / `SETTINGS_VIEWS` / `switchView` 的 `adChannel` 负断言；漏删会让登录/登出循环对 `undefined` 取属性直接崩，而静态闸可能全绿 | 已修订 §4.4：块级负断言（`balancedBlock`）覆盖 `VIEWS` / `VIEW_ORDER` / `SETTINGS_VIEWS` / `switchView` / `renderSettings` |
| 低 L1 | `syncAdSection` 无条件 `renderAdChannel()` 会清掉用户未保存的密钥输入；失败后同域重渲染会重试风暴 | 已修订 D4/§4.2：仅 rows 为空时重放；`attempted` 标志 + 显式点叶重置 |
| 低 L2 | `.ad-channel-*` 行样式在 style.css 中完全缺失 | 已修订 D11/§4.3：照 `.notify-channel-*` 同构补齐 |
| 低 L3 | 新断言若用全文 `includes` 存在假绿面（类名混挂、可见叶+隐藏锚点并存、键集去重掩盖双域） | 已修订 §4.4：标签级 / 块级断言 |
| 低 L4 | app.js / index.html 多处注释仍写「广告回调视图」「读面有意含 finance」「十二视图」 | 已修订 §4.1/§4.2：列明注释同步点 |
| 低 L5 | 历史 spec（client-access C5、ads-relief 读面含 finance）与本地旧探针与新 IA 冲突 | 已登记 §5 / §7：旧决策被取代；旧探针不可作判据 |
| 低 L6 | finance 只是 UI 收面，服务端 P8 仍放行读 | 已补 §7：curl 仍可读，本次不改 RBAC |
| 低 L7 | 登出时在途请求仍可能写回隐藏 DOM（既有行为） | 已修 §6 表述：明确不取消在途请求 |
| 低 L8 | D8 的「嵌套滚动与高度竞争」论据不准确（`#settings-host` 非 flex） | 已改写为 padding/gap 语义与建模理由 |
| 低 L9 | dev-process 要求 2–3 方案对比 | 已补 §3.1 备选方案与取舍 |

结论：阻断/高已处置，低项已修订或登记，可进入实现计划。
