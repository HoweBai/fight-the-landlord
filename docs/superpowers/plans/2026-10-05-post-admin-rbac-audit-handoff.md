# ③ 财务后台 + RBAC + 审计 收口后的交接（2026-10-05）

> **给新会话**：本文 + 自动加载的 `MEMORY.md`（重点 `p3-admin-rbac-audit-slice` / `p2-gold-room-slice` / `ci-flake-known` / `post-mvp-roadmap`）即可续跑。
> **状态**：✅ **全链完成**——三件套冻结 → 实现 T1–T13 → 六评审波全关 → **opus 整支终审 F1 闭环** → 本机六阶段整轮绿（两度）· e2e 40/40 · 真栈演练全链 · `slice-19`=**458 断言**两跑绿。**CI 权威轮（push 后）为最后一环**（读数回填见文末）。

---

## 1. 现在的状态

| 事项 | 状态 | 关键入口 |
|---|---|---|
| 设计/规格/计划 | ✅ 冻结（设计 v1.1.1 `83f0581` · 规格 **v1.1.8**（实现期六处就地订正 ⚙️19/⚙️20 等）· 计划 v1.1.1 `bbe2a88`） | `docs/superpowers/{specs/2026-10-05-admin-rbac-audit-{design,spec}.md, plans/2026-10-05-admin-rbac-audit.md}` |
| 实现 | ✅ T1–T13 + **5 轮修复**（`332287c..d9b6d8a`，38 提交）；台账含 C1–C29 核销表 + Minor 池分诊 | `.superpowers/sdd/2026-10-05-admin-rbac-audit/progress.md` |
| 六评审波 | ✅ 波1–波6 + F1 定向复核全关（任务/波级零 Critical 遗留） | 同目录 `review-*.md` |
| 整支终审（opus） | ✅ **F1 Closed**（唯一 Critical 已修 + 复核）；其余全过 | `review-final-opus.md` · `review-final-f1-verify.md` |
| 本机验收 | ✅ 六阶段整轮 **exit 0**（T13 + F1 修复后两度）· e2e:browser **40/40** · 真栈演练（bootstrap 首启 + hatch 建/复位）全链 · 五面 CSV 真栈字节证据 | progress「特殊项」 |
| CI 权威轮 | ⏳ push 后三 workflow（本机不再跑全序——交接文档口径延续） | 文末回填 |

## 2. 交付速览（防走失）

**RBAC**：四表（`admin_accounts`/`admin_login_events`/`config_changes`/`admin_account_changes`，迁移 `1789900000000`）· scrypt（`N=2^17`，**不引 bcrypt**）· 登录七步处理序 + claims 令牌 · **授权单点 = 网关 `admin-policy.ts`**（P1–P9 显式枚举、非 GET 未登记 fail-closed、**路径归一双射程**：尾斜杠剥除只喂 policy（⚙️17）、大小写不敏感识别（⚙️20）、豁免/限流桶恒用原值）· 写方法端点统一强制 `x-admin-actor`（fail-closed）· 自锁三闸（含最后超管锁定读）· 首启 bootstrap + hatch 复位 CLI。
**财务后台**：ops 列表（六过滤/keyset/reversed 旗）/ 详情 / summary（按来源/按日 +08:00 切天）/ 冲正（`admin_reverse`，uk 锚 + 指纹含 actor：同操作者同原因重放 200、否则 14002）/ 对账面板（四字段 + 手动互斥）/ 五面 CSV（BOM + CRLF + 公式注入消毒 + 网关字节级透传）。
**审计（四源直读不建第二账）**：`currency_ops`（actor=操作者用户名）· `config_changes`（旧值→新值 + 锁定读）· `admin_login_events`（成败 + IP）· `admin_account_changes`（账号写面四动作）——管理页「审计」四页签 + CSV。
**管理页**：登录加用户名 · 五视图角色导航（配置/钱包/财务/审计/账号）· **零 innerHTML** · 只按 status 分流 · 北京时间。
**文档**：design.md ×4 / first-deploy.md 管理面章节重写 + env 表 + 种子节 / roadmap M0.4 完成 / currency-design §12 回填 + G11 口径偏离登记 / deviation-ledger N53–N57 / compose 注释行。

## 3. 上线与用户动作

- **push**：协调者已推 `origin/master`（38 提交快进；**CI 三 green 后本片才算完成态**）。
- **打 tag = 你**（`v*` 才触发 release；**打 tag 前必须先 push**——R1308 已两度拒过）。
- **部署后管理面（重要）**：① 升级即**全员重新登录**（旧令牌无身份字段 ⇒ 401）；② 首启 bootstrap 以 `.env` 的 `ADMIN_PASSWORD` 建超管 `admin` ⇒ **登录后立刻改口令 + 建号**（手册 `docs/ops/first-deploy.md` 管理面章节已重写）；③ 忘记口令 = 服务器 hatch：`docker compose exec config-service node packages/config-service/dist/admin-reset.js <username>`。
- 玩家面**零感知**（本片纯管理面）。

## 4. 下一片候选

- **广告小片**（金币场「每日救助」的前置；需你注册平台 + 广告位 ID）；
- **风控片**（数据链先行：IP 透传 + deviceId 采集）；
- **支付片**（J4：充值/退款/提现全含；前置 = 商户号（实名主体），actor/source/角色矩阵已预埋）；
- 移植 Minor 池跟片小修（见 §5.8）。

## 5. 环境事实（会再咬人）

1. **Express/Nest 路由匹配大小写不敏感，而路径判定天然容易写成大小写敏感**——终审 F1：`POST /API/admin/login` 曾直通登录处理器旁路失败桶。**纪律：近邻形态探针要打在每一条承重路径上，尤其是下游无第二层守卫的那一条**（历史评审只在有双层守卫的 `GET /api/admin/config` 上探过变体就盖章「关死」，登录端点从未被探）。
2. **MySQL 保留字**：裸 SQL 里 `key` 必须反引号（真栈 ER_PARSE_ERROR；假库单测按文本识别不真执行 ⇒ 全绿）。
3. **mysql2 的 EXISTS 回值随查询计划路径漂移**（semi-join 路径回字符串 `"0"`、普通路径回数字）——布尔转换必须**双形态**兼容且对其余形态响亮抛。
4. **网关 CSV 透传必须字节级**（`resp.text()` 的 WHATWG UTF-8 decode 会**剥掉 BOM**——`ef bb bf` 用 arrayBuffer+send(Buffer)）。
5. **假库单测遮蔽真 SQL 是本片最大缺陷源**（3 处全在真栈联测才现形）——设计/评审新片时，SQL 类改动**默认要求一条真栈回归**。
6. **写限流桶预算**：管理写 30 笔/5 分钟/令牌（T5 扩边后覆盖全部非 GET）——conformance 新用例写量注意；跨 30 笔要换令牌（slice-18 先例）。
7. **本机六阶段 1/6 install 段空转**（R285 `--store-dir` 措置的本地副作用；真 CI 无 `.pnpm-store` 不带该参）——本机读数看 2–6 段 + 独立 `--frozen-lockfile --lockfile-only` 核销。
8. **Minor 池**（终审已分诊；push 无必修项）：可延 9 条（含网关值级静默丢弃缝、财务查询与在途加载竞争）· 接受登记 5 条 · **入交接 1 条 = `user-service`/`currency-service` 的 `src/data-source.ts` 双导出**（typeorm CLI 手工迁移恒拒；容器自动迁移不受影响；config-service 已修 `5ac491e`；建议随某片一行小修 + 各自包验证）。
9. **dev 卷残留**（T13/终审探针与联测产物，登记不碍事）：探针玩家/`admin_login_events` 若干 ip=NULL 行/停用账号 `hatchtest` 与 `tempdis`/已冲正 op #733；`admin_accounts` 终态 = `admin`(active) + `hatchtest`(disabled)。

## 6. 新会话怎么开局（一句话配方）

> **按交接文档续跑：`docs/superpowers/plans/2026-10-05-post-admin-rbac-audit-handoff.md`，做 X。**

**报告落** `.superpowers/sdd/<日期>-<主题>/`；设计/规格/计划落 `docs/superpowers/{specs,plans}/`；每任务一提交；六阶段只在 push 前跑一次；全序只在验收（CI 权威轮）。

---

## 7. CI 权威轮回填（push 后）

- **push 已完成**：`64744a6..d6c8c44`（39 提交快进）+ 文档回填 `de0e612`。
- **触发条件（本地核实）**：推 master 触发 `ci`（`on: [push, pull_request]`）· `conformance`（`on: push branches [master]`）· `images`（同）。`release` 仅 `v*` tag。
- ✅ **权威轮三绿（`d6c8c44`，覆盖 T1–T13 全部实现与修复）**：
  - `ci` **success** 8m02s（run 37250607593）
  - `images` **success** 6m11s（run 37250607576）
  - `conformance` **success** 28m59s（run 37250607547，全序 24 片）
- 文档回填 `de0e612` 的三个 run 随推触发（纯文档改动；如红按下方 triage 口径处理，不影响 `d6c8c44` 三绿这一权威结论）。
- **若 CI 有红**：先**单跑**该片确认（`ci-flake-known` ②⑤ 族 + ⑧ conformance 间歇；失败诊断步常备）；确系真红 ⇒ 修复 + 重推。

## 8. v1.6.0 上线与线上验证（2026-10-05）

- **tag `v1.6.0`**（于 `b4cd428`）→ **release run 37268373569 三 job 全绿**：`images` · `conformance`（**在发布镜像上跑全序**——最强验收证据）· `deploy` ✅
- **线上免密探针**（`--resolve` 钉 `<DEV_HOST_IP>`，防路由器 DNS 缓存指错机）：
  - `/api/health` ⇒ `{"status":"ok",...,"redis":"up"}` · 玩家 H5 `/` ⇒ 200 · **管理页 `/admin/` ⇒ 200**
  - 新形状 `{username,password}` 错口令 ⇒ **401「用户名或口令错误」**（账号表非空＝bootstrap 已跑）
  - 旧形状 `{password}` ⇒ **400「参数非法」**（新 API 生效）
  - 尾斜杠变体无令牌 ⇒ **401「Missing admin token」**（N1 语义线上生效）
  - 大小写变体无令牌 ⇒ **401 中间件级**（**F1 修复线上生效**）
- **用户动作**：用服务器 `.env` 的 `ADMIN_PASSWORD` 登录 `admin` → **先改口令** → 按需建号。
- 附记（非代码）：`b4cd428` 的 master-push conformance 曾一次间歇红（slice-13 douzero HuggingFace 模型下载慢；同日前后轮全绿；已登记假红台账第十条）；release 轮同代码全绿。
