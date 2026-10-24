# 交接：配置 IA 归位 + dev 工作流/部署现状（2026-10-15）

> 新会话入口。上一会话上下文用尽前的完整状态快照。配套记忆：`ci-trigger-and-push-policy` ·
> `docker-cleanup-after-build` · `windows-dev-env-quirks`（24/25/26）· `entry-fee-slice-kickoff`。

## 一句话现状

台费片已完成并**已部署开发测试服**（暗上线）；本会话新建成 **dev 分支工作流**（推送零 CI）、完成
**配置 IA 归位**，并**已把 dev 全量部署到测试服**（两轮：`dev-f51ace8` → **`dev-8f59573`**〔合并
`feature/recharge-withdraw` 的收银台手机端直跳〕）；`scripts/deploy/deploy-dev.sh` 一条命令封装落地
（带钉 IP 逐字节复核）。

## 分支与流程（本会话用户拍板）

- **开发都在 `dev` 分支**（`origin/dev` 已建）；**dev 推送零 CI**（`ci.yml` 触发面已收窄 =
  `push: branches:[master]` + PR + 手动，提交 `20645a4`）。
- **合入 master = 吃权威轮**（ci + conformance + images ≈ 49 分钟额度）；**打 `v*` tag = 出包/部署**
  （≈41 分钟）。日常攒批不推 master；纯文档批可用 `[skip ci]`。
- 部署机制：制品走 **GHCR**（非推代码）——服务器只 `docker compose pull`。测试服 = 开发测试环境
  （用户 2026-10-15 明确：**不是生产**）。

## 已部署 vs 未部署

- **测试服现行** = `dev-8f59573`（2026-10-15 晚第二轮：合并 `feature/recharge-withdraw` 分支新提交
  `cc99519`「手机端桥接改服务端代发，302 直跳手机收银台」；**回滚面 = `dev-f51ace8`**）。
- **第一轮 `dev-f51ace8`**（当晚早些，= 含下列两批 + 收尾批）：
- **部署时点（2026-10-15 晨）的背景**：当时测试服 = `v1.13.6`（台费片同码），dev 上两批未部署：
  1. `6d1118e` + `809231c` —— 合并 `origin/feature/admin-optimization`（带来 `54e8387`
     H5 横屏旋转瞬态修复 + 26 条判据；冲突手工解 2 处 + 共享尾括号坑 1 处；client 1000/1000 绿、lint 0）；
  2. `34a8091` —— **配置 IA 归位**：红 3（currency.entryMultiplier / rakePercent / entryFeePercents）
     + 灰 4（risk.winRateThreshold / minGames；record.retentionDays / cleanupIntervalMs）共 **7 键**
     从「通用设置」挪入「玩法/斗地主」域（新增页签：金币场经济 / 风控检测 / 对局记录；
     「数据与广告」域更名「广告」仅剩 `ad.reliefAdpid`）。纯展示层（`CONFIG_IA` 表 + 左树文案）；
     验证：`node --check` OK、静态闸 **210 passed**、IA 键 42/42 唯一无重复。审查全文 =
     `.superpowers/sdd/2026-10-15-config-ia-audit.md`。

## 下一步

### ① 把 dev 部署到测试服 —— ✅ 已完成（2026-10-15 晚，本会话，两轮）

**现行测试服 = `dev-8f59573`**。**第二轮**（当晚）：合并收银台手机端直跳 `cc99519` —— 合并态
**454/454 + tsc 双配置零错误**（本机实跑）；部署后实证：容器 `ftl-payment-service` 实读
`:dev-8f59573` 且 `resolveMobileCashier` 在**新编译产物**里（quirk 9 防空测）· `/pay/cashier/FAKE…`
钉 IP 404（路由健在）· 其余同第一轮全套（health 200 + admin 逐字节 + 冒烟三条）。

**第一轮 = `dev-f51ace8`**（含横屏修复 + IA 归位 + 交接/收尾文档）。实证：
- 19 容器全跑 `:dev-f51ace8`（ssh 实读 `docker ps`）；14 镜像推 GHCR 全成、无 403/WSAEINVAL
- 钉 IP 复核：`/api/health` 200 · `/admin/app.js` 与 `/admin/index.html` 与 **tag blob 逐字节一致**
- 页签针脚（钉 IP）：`金币场经济`×2 / `风控检测`×1 / `对局记录`×9（= 源码读数）；index.html「数据与广告→广告」更名生效
- tag `dev-f51ace8` 已推 origin（`dev-` 前缀 ⇒ 零 CI）
- **回滚面（现行）= `dev-f51ace8`**（服务器本地与 GHCR 都有）；更早的 `v1.13.6`/`v1.13.7` 同在各库

### ② 封装 `scripts/deploy/deploy-dev.sh` —— ✅ 已完成（同批提交 `f51ace8`）

`bash scripts/deploy/deploy-dev.sh` 一条命令：tag → build+push → deploy → **钉 IP 复核**（health 200 +
`/admin/app.js` 与 tag blob 逐字节）。硬闸两条：分支必须 `dev`、工作树必须干净（镜像从工作树烘、compose 从
tag 取 ⇒ 脏树会让 tag 说谎）。附带：FROM 全集预拉（Dockerfile 派生 + 重试，防 DNS 污染）/ ghcr 登出态自愈
（quirk 27）/ tag 推送代理直连回退 / 建 tag 幂等与错位拒绝。守卫路径本机实测 3 条（脏树 / detached HEAD /
tag 指向别处 ⇒ 各 rc=1 且消息正确）；**首跑即 ① 的真部署**（端到端验证，日志
`.superpowers/sdd/2026-10-15-devflow/deploy-dev-run1.log`）。

### ③ 台费真机走查（用户侧）

管理端把 15 档 `percent` 改 10 ⇒ 打一局看余额扣 1 + 财务「台费」源行 + 「台费漏收」块。

### ④ 用户侧待办（别代拍）

CI 计费拦截（GitHub Billing）；**tag 事实订正**（2026-10-15 晚实测 `ls-remote`）：`v1.13.0`–`v1.13.7`
**全部只在本地**（origin 无任何 `v1.13.*`；注意推 `v*` 会触发 release 链 ≈41 分钟额度）；
slice-18/24 相位红=预登记 T0-2（不得下调）。

## 2026-10-15 晚补记（本会话）

- **抓到并修掉一条 dev 上的既有红**：`slice-07.4-pipeline` 的 B1 仍断言「ci.yml 触发恰为 {push,
  pull_request}」，而 `20645a4` 收窄触发面时加了 `workflow_dispatch` + `push→master` —— 那次只跑了
  admin 静态闸、没跑本片，且 **dev 推送零 CI 恰是该策略的效果** ⇒ 这条红在 dev 上过夜、无自动面能看见，
  本次单跑才撞上（fail-fast 还遮住了后续断言）。已改写为新口径三性质（事件集合 / **push 只认 master**
  〔新加，负载性质〕/ 手动入口在场〔新加〕）；`slice-07.4` baselines 75→80（render/full 同抬，回填注记已写）。
  **教训：dev 分支上的 conformance 红没有自动发现面 —— 动过 ci.yml/工作流/部署脚本的提交，dev 上也应单跑
  `slice-07.4-pipeline`（静态、≈2 分钟）。**
- 本机镜像清理（约定内）：`rmi` 逐项删了 `sha-9a8afff`/`sha-ca3bd76`/`v1.13.7` 三套（42 tag）；
  **保留** `dev-f51ace8` + `v1.13.6`（回滚面）+ 基础镜像 + builder 缓存（C: 尚有 48G，不动）。

## 环境坑（2026-10-15 新增，全部已入记忆）

- **Docker Hub DNS 污染**（假 IPv6 `2a03:2880:…`）：基础镜像缓存被清后构建撞污染 ⇒ **预拉 FROM 全集**（清单在 quirks 26）；
- **`docker system prune -f` 在本机也会删「无容器在用」的带 tag 镜像**（连基础镜像）⇒ 清理用 `docker rmi` 逐项列举（白名单保护基础镜像/回滚面）；
- 非交互旗标是 `-f` **不是 `-y`**；git 代理 `127.0.0.1:8889` 未开时用 `git -c http.proxy= -c https.proxy=` 直连；
- C 盘已处理（用户），构建后记得清理。

## 关联

- 台费片：`docs/superpowers/specs/2026-10-14-entry-fee-{design,spec}.md` · `docs/superpowers/plans/2026-10-14-entry-fee.md` · 账本 `.superpowers/sdd/2026-10-14-entry-fee/progress.md`
- IA 审查：`.superpowers/sdd/2026-10-15-config-ia-audit.md`
