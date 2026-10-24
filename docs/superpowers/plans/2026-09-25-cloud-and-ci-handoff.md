# 交接：片② spec 已批准 —— 下一步 = `writing-plans`；片① 已收口

> **日期**：2026-09-25 · **状态**：**片① 已收口**（无半成品 · 工作树干净 · 门禁全绿 · 已在 `master`）· **片② spec 已获用户批准，实施计划尚未写**
> **片① 设计真源**：`docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md`（§7.6 最终评审 · §10 判据终值）
> **片② 设计真源**：`docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md`（R1301–R1314 · §7 记两轮复核）
> **进度台账**（git-ignored，**在磁盘上**）：`.superpowers/sdd/progress.md` 的「上线运营层（一）」段
> **落盘提交**：片① `6db6ed5` → `7ea8556`（含各任务的实现/修复提交）；片② 规格 `96b22f1` → `d3b7902`（HEAD）

---

## 0. 一句话

**片① 全部做完并合入 `master`；片② 的规格刚刚（2026-09-25）获你批准** —— 新会话的第一件事是**为片② 出实施计划**（`superpowers:writing-plans`），然后按 A → B → C 执行。

## 1. 现在的事实（新会话可直接复现）

**片①（门口容器与上线形态）已收口**：

- 7/7 任务完成（每个都过"实现者 → 独立评审 → 修复轮 → 复评"）；**最终全分支评审** verdict = With fixes ⇒ 12 项全修（`f031d48`）。
- 判据终值：`slice-07.2-deploy` **134** · `slice-07.3-edge` **33** · `packages/api-gateway` **172**；conformance **15/15**；探针 `gate 18/18` · `full 33/33`；`scripts/browser-e2e.mjs` blob `052b98b7ab779ae280d6673729053145e9829604`；客户端零改动。
- **`pnpm run ci` 六阶段在最终修复轮之后整跑通过**（`=== [ci] 六阶段全部通过 ===`）。
- 新增/改动的关键事实：第 9 个容器 **`ftl-edge`**（Caddy：TLS + 静态站 + 反代）· 生产形态**只发 80/443**、`api-gateway` 退 `expose: 3000` · compose 网络**钉死 `172.28.0.0/16`**、门口固定地址 **`172.28.0.250`** · 网关**唯一一处**可信客户端 IP（只采信 `X-Forwarded-For`、只信门口一跳）· `JWT_SECRET` 已补传给网关（此前生产会**每个登录令牌都验不过**）· 手册 `docs/ops/first-deploy.md`（八节）。
- docker 栈：8 容器 healthy ✓（其中 `api-gateway` 等已重建到当前 `:latest`）；本机另有 `ftl-edge:latest`（93.9MB，片② 的 Task A 会把它统一改名成 `pokergame-edge`）。

**片②（上云与自动化）**：

- 规格 `docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md` 已完成**两轮复核**并全部折进：
  - 控制者实审（4 处：竞态/冒烟无目标/交付物缺项/判据不可机械判）；
  - **独立复核**（最强模型）：**7 处硬错**（错镜像名 · 回滚会静默部署错版本 · 幽灵 `deploy.yml` · 触发分级自相矛盾 · 体积算错 · "无需 daemon"过度声称 · `prune -af` 会毁回滚）+ 4 未证声称 + 6 判断分歧 + 5 遗漏 + 5 歧义，**全部折进**；另有 13 项"已核无错"。
  - 控制者随后**实测**了 B1 依赖的解析器事实（树里 `js-yaml@4.3.2` 与 `yaml@1.10.3` 都把 `on` 解析为字符串键 ✓；"YAML 1.1 陷阱"半句**未证**，spec 里标为警告）。
- 用户七条裁决（spec 头部逐条记）：私有仓库 `Howebai/fight-the-landlord` · 密钥登录/端口 22 · **打 tag 才部署** · 装 `gh` 并登录 · **连真栈一起进 CI** · 收尾**真上线** · 镜像走 **CI→GHCR→拉取**、门口名统一。

## 2. 新会话的第一件事

**调用 `superpowers:writing-plans`**，按片② 的 spec 出实施计划（`docs/superpowers/plans/2026-09-25-cloud-and-ci.md`），然后走 `subagent-driven-development`（与片① 同形：每任务 = 实现者 → 评审者 → 修复轮 → 复评 → 记台账）。

计划应按 spec §9 的 **A → B → C** 组织：

| 段 | 内容 | 完成时能看到什么 |
|---|---|---|
| **A · 仓库与命名** | 装 `gh` + `gh auth login`（**用户动作**）· 建私有仓库 · `.gitignore` 补 `*.bak` + `git rm .env.local.bak` · 镜像命名统一（7 个 + 门口改名 + 更新 `slice-07.3-edge.ts` 3 处与手册 1 句）· A11/A12 · B1 | 代码在私有仓库上；本地 6/7 镜像名不变（门口需重建一次）；命名方案有闸 |
| **B · 流水线** | **先渲染闸**（`ci.yml` 加 `render-gate` job：纯渲染 = **减去 A6a(ii)**，**≥49 条**、无需 daemon、2.8s）· `images.yml` · `conformance.yml`（可复用）· `release.yml`（`needs: [images, conformance]`）· `scripts/deploy/{build-images,conformance-stack}.sh` · `baselines.json` + 比较脚本 | feature/PR ⇒ 渲染闸每次 push；master ⇒ 镜像进 GHCR + **真栈 15 切片在 Ubuntu 上跑绿**（Linux 验证落地） |
| **C · 上云** | 服务器五项预备（**用户动作**）· `deploy.sh` / `rollback.sh`（**只许 `prune -f`**）· 手册（⑦ 替换 + 新增「服务器预备」「回滚」）· 文档同步（**§13.4 不动六阶段表**，在表下新增小节）· **首次真部署** | 真域名上线（**真证书**）· 回滚与幂等验过 · 服务器上无长期凭据 |

## 3. 片② 期间**需要你（用户）动手**的地方

1. **装 `gh` 并登录**（A 段第一步）：`winget install GitHub.cli` → `gh auth login`（会开一次浏览器授权）。
2. **告诉我域名**（`SITE_ADDRESS` 的真值 + DNS 的 A 记录指向 VPS）。
3. **服务器五项预备**（C 段，手册会给逐条命令 + 预期输出）：① 部署公钥进 `~/.ssh/authorized_keys` ② `sudo usermod -aG docker ubuntu` + 重登 ③ 建 `/srv/pokergame/` 并写 `.env`（五项）④ DNS A 记录 ⑤ **腾讯云安全组**放行 80/443（与机器内 `ufw` 两层）。
4. **首次部署那天在键盘前**（DNS 生效、证书签发那一刻）。

## 4. 环境纪律（沿用片①，本片新增三条）

1. 🔴 **改任何服务源码 ⇒ 重建镜像再跑真栈判据**（`DOCKER_BUILDKIT=0 docker compose build <svc> && docker compose up -d <svc>`），随后查 DI 陷阱（`logs <svc> --since 30s | grep -i error`）。
2. ⚠️ **真栈判据会重建 `api-gateway`** 并把它复原为空信任；`slice-07.3-edge` 收尾**无残留**（`ftl-edge`）；**被 Ctrl-C 打断时**下次跑会**幂等自愈**。
3. ⚠️ **`--profile` 是全局参数**（写在子命令前）；`down` **删不掉**带 profile 的容器 ⇒ 收尾用 `--profile edge rm -sf edge`。
4. ⚠️ **网络已钉 `172.28.0.0/16`**、门口固定 `172.28.0.250`；改 `ipam` 会让网络重建一次（命名卷数据不丢）。
5. ⚠️ **磁盘卫生只许 `docker image prune -f`**（只删悬空）—— `-af` 会删掉上一个 tag 的镜像，把秒级回滚变成重新下载。
6. ⚠️ **`gh` 尚未安装**（片② A 段要先装）；本机 **Git Bash 与 cmd 的引号/竖线陷阱**：给命令优先用"cmd 也能跑"的形态（双引号、少用管道）。
7. **本片的两个"待核"别忘**（spec §5 B4）：私有仓库的 **Workflow permissions 默认可能只读**（首次推包会 403）· **GHCR 从大陆型 VPS 的可达性**（不通则用 `docker save` → `ssh docker load` 备选）。

## 5. 开场白（可直接粘贴）

> 读 `docs/superpowers/plans/2026-09-25-cloud-and-ci-handoff.md`（片① 已收口 + 片② spec 已批准）。
> 片② 的设计真源是 `docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md`（R1301–R1314；§7 记两轮复核的全部发现）。
> **先别写代码** —— 第一件事是调用 `superpowers:writing-plans` 为片② 出实施计划（按 spec §9 的 A → B → C），
> 然后走 `superpowers:subagent-driven-development` 逐任务执行；台账写在 `.superpowers/sdd/progress.md` 的新段落里。

## 6. 相关材料在哪

| 要看什么 | 去哪看 |
|---|---|
| 片② 的规格（裁决/判据/不做/复核记录） | `docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md` |
| 片① 的规格与终值 | `docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md` §7.6/§10 |
| 片① 的逐任务记录与全片 Minor 清单 | `.superpowers/sdd/progress.md` 的「上线运营层（一）」段 |
| 片① 的实施手册 | `docs/ops/first-deploy.md`（八节；⚠️ ⑦ 待片② 替换） |
| 服务器实测事实 | 本交接 §3 + spec §0.2 |
| 记忆（跨会话） | `MEMORY.md` 的 `slice-edge-and-prod-shape-done` · `windows-dev-env-quirks` |
