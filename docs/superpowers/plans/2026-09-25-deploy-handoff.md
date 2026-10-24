# 交接：片② 只剩「首次真部署」—— 新会话从这里继续

> **日期**：2026-09-25 · **状态**：**代码/工作流/脚本/文档全部完成并已推上私有仓库；CI 全绿；只剩 C4（首次真部署）**
> **设计真源**：`docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md`（R1301–R1314）
> **实施计划**：`docs/superpowers/plans/2026-09-25-cloud-and-ci.md`
> **进度台账**（git-ignored，**在磁盘上**）：`.superpowers/sdd/progress.md` 的「上云与自动化（二）」段（含 §「CI 全绿」）
> **剩余清单**：`.superpowers/sdd/remaining-gh-blocked.md` —— ⚠️ **§1–§6 已全部做完**，只剩 **§7（C4 首次真部署）与 §8（收口）**

---

## 0. 一句话

**片② 的实现部分（11 个任务的 10 个 + C1 Step 1）全部完成、已推上 `HoweBai/fight-the-landlord`、三个工作流在同一提交上全绿**（`8794784`）。**唯一剩下的就是 C4：把第一次真部署走完** —— 而它需要用户在服务器上做「〇 服务器预备」五项（**交接邮件已发出，逐条命令+预期输出见下 §4**）。

---

## 1. 现在的事实（新会话可直接复现）

| 项 | 值 |
|---|---|
| 分支 / 提交 | `master` = `8794784` = `origin/master`（**工作树干净**）· 本片共 **39** 个提交 |
| 仓库 | `https://github.com/HoweBai/fight-the-landlord`（**私有**）|
| 工作流 | `ci.yml` · `images.yml` · `conformance.yml` · `release.yml` —— **三者同一提交全绿** |
| GHCR | **7 个包** `fight-the-landlord-<svc>`（`sha-<短7>` + `latest`）|
| 判据终值 | `slice-07.2-deploy` **140**（render 55）· `slice-07.3-edge` **34** · `slice-07.4-pipeline` **36** · conformance 共 **16 切片** |
| `baselines.json` | `render` 与 `full` 两列**都已回填**（`full` 回填自 run 36085944825 的日志；负对照已做）|
| 部署密钥 | `~/.ssh/ftl_deploy`（**专用、无口令**）· 公钥已贴进交接邮件 |
| 仓库配置 | variable `SITE_URL=https://<DEV_HOST>` · secrets `SSH_HOST=<DEV_HOST>` / `SSH_USER=ubuntu` / `SSH_KEY` |
| tag | **一个都还没打**（首次真部署 = 第一个 tag）|
| 本地栈 | 8 个 `ftl-*` 容器 healthy、无 `ftl-edge` 残留、`TRUST_PROXY=` 空 |

### 1.1 本片**未做**的一件事（有意）

**B4 Step 7 的「tag 干跑」被并进 C4 了**。原因：计划写它时假设 B4 先于 C1 完成（那时还没有 `deploy` job），而实际做下来 C1 的 `deploy` job 已经就位 ⇒ 一次 tag push 会**真的尝试部署**（没有服务器 ⇒ 红）。⇒ 与其跑一次注定红的干跑，不如**让 C4 的首次真部署本身成为 tag 路径的第一次验证**（master push 已经把 `images`+`conformance` 验证过了，tag 路径唯一多出来的就是 `release.yml` 的 `workflow_call` 复用 —— 那正是 C4 要跑的）。

---

## 2. 新会话的第一件事

**按 `docs/superpowers/plans/2026-09-25-cloud-and-ci.md` 的 Task C4 执行**（该任务的 brief 提取命令见 §6）。但在开跑前，先确认用户在服务器上把「〇 服务器预备」五项做完了 —— **那五项是唯一的外部依赖**。

**开跑后 C4 的顺序**（计划里的 Steps 0–8）：服务器事实核对（docker compose ≥ v2 / 是否腾讯云 / 内存 / 磁盘）→ GHCR 从服务器可达性 → 用户做完五项 → **打 `v1.0.0`** → 三条链真证书验收（`curl` **不带 `-k`**）→ 幂等（同 tag 重跑不含 `Recreated`）→ 回滚（记录耗时）→ 凭据面（服务器无 ghcr 凭据、`/srv/pokergame/` 只有两个文件）→ 回填 spec §10 与台账。

---

## 3. 本片踩过的坑（新会话**务必先读**，每条都实测过）

### 3.1 环境类

- 🔴 **`gh` 不在 PATH 上**（装在 `C:\Program Files\GitHub CLI\gh.exe`，winget 没加 PATH）。本会话一律用全路径：`"/c/Program Files/GitHub CLI/gh.exe"`。
- 🔴 **`gh api` 的路径别写开头斜杠**：`gh api /repos/...` 会被 Git Bash 改写成本地路径（报 `invalid API endpoint: "E:/Softwares/Git/..."`）。写 `gh api repos/...`。
- 🔴 **`grep -c $'\r'` 在本环境的 Git Bash 里检测不出 CR 字节** —— 它对**纯 LF** 文件返回**行数**。判 CRLF 一律用 `tr -dc '\015' < "$f" | wc -c`。
- **`js-yaml` 从仓库根解析不到**（只是别的包的传递依赖）—— 要 `cd tools/conformance` 再用。
- **`[skip ci]` 有效**（提交信息里带上即可不触发 Actions）⇒ 想反复试而不烧 CI 分钟数时用它。

### 3.2 流程类

- 🔴 **派单期间不要提交**：控制者曾在子代理提交前落提交，虽然事后核实历史线性、无内容丢失，但那是运气。
- 🔴 **先验证判据本身，再拿它下结论**。本会话控制者有一次重大误判：`release.yml` 没出现在 `gh api …/actions/workflows` 里 ⇒ 判成「GitHub 静默丢弃非法工作流」并开始二分（往 master 推了 4 个提交）。**对照组**（故意放 schema 非法的文件）证明该判据是坏的：**GitHub 只往列表里加、从不移除**，早期「缺席」只说明**索引慢**。那次误判的提交已强推清掉。
- **计划里的行号会漂**：本片往 `docker-compose.yml` 与两个 slice 里加过注释 ⇒ 别信计划里的行号，**按内容定位**。

---

## 4. 用户待办（唯一的外部依赖）—— 已发出，逐条命令与预期输出见交接邮件

**〇 服务器预备五项**（手册 `docs/ops/first-deploy.md` 的 〇 节，本会话已订正两处）：
① 部署公钥 → **`/home/ubuntu/.ssh/authorized_keys`**（⚠️ **不是** `~`，root 下会写错门）② `sudo usermod -aG docker ubuntu` + 重登（用 `sudo -u ubuntu docker ps` 验）③ 建 `/srv/pokergame/` + 写五项 `.env`（`SITE_ADDRESS=<DEV_HOST>`、`TLS_MODE=<用户邮箱>`）④ DNS A 记录 ⑤ **两层**放行 22/80/443（云安全组 + `ufw`；⚠️ `ufw status` 此刻显示 `Status: inactive` **是正常的**，`enable` 在 ③3.2）。

**用户另外要给的**：**`TLS_MODE` 用的邮箱**；以及**确认 `<DEV_HOST>` 就是给玩家/证书用的域名**（控制者问过，用户回「用可配置的域名、别写死」—— 域名可换，换法 = `gh variable set SITE_URL` + 服务器 `.env` 里改 `SITE_ADDRESS` 两处）。

---

## 5. 这一片最值得带走的三条教训

1. **判据测的必须是「性质」，不是「平台相关的现象」**。CI 首跑抓到三条 Linux 独有失败，全是这个：断言 `signal === 'SIGTERM'`（linux 上 compose 客户端**捕获 SIGTERM 后自己退 255**）· 从 `IPAM.Config[].Gateway` 取网桥地址（**linux 上该字段根本不存在**）· Node 20 的 `fetch` 在建连窗口**不持有 ref 句柄** ⇒ 事件循环空转 ⇒ **进程静默 exit 0、整片输出消失**（这是 R156 的**反面**，R156 只管「循环被吊住」）。
2. **「有界重试」若没有单次上限，那个界是假的** —— `fetch`/`curl` 都没有默认超时。控制者在修「顺序+就绪」时自己犯过这个错，与终审在冒烟 curl 上抓到的是同一类。
3. **六处缺陷出在控制者自己写的计划文本里**（实现者没错）—— 而它们**全都会以「看起来是对的」形态上线**。⇒ 逐任务评审 + 终审不是仪式。

---

## 6. 相关材料在哪

| 要看什么 | 去哪看 |
|---|---|
| 剩余清单（§7/§8）| `.superpowers/sdd/remaining-gh-blocked.md` |
| 逐任务状态与全部证据 | `.superpowers/sdd/progress.md` 的「上云与自动化（二）」段（含 §「CI 全屏」与 §「这一轮 CI 调试的净收获」）|
| 本会话全部 brief/report | `.superpowers/sdd/task-{A1..C4}-{brief,report}.md` · `final-fix-report.md` |
| 首次上线手册 | `docs/ops/first-deploy.md`（〇①–⑨，每条带逐字命令与预期输出）|
| 跨会话记忆 | `MEMORY.md` 的 `slice-2-cloud-ci-implemented-awaiting-gh`（**本片状态**）· `windows-dev-env-quirks`（第 11 条 = CRLF 那条）· `ci-flake-known` |

**提取某个任务的 brief**（技能的 `task-brief` 只认 `Task <数字>`，本片是 `Task A1` 这种带字母的编号 ⇒ 用等价的 awk）：

```bash
awk -v n=C4 '/^```/ { infence = !infence } !infence && /^#+[ \t]+Task[ \t]+/ { intask = ($0 ~ ("^#+[ \t]+Task[ \t]+" n ":")) } intask { print }' \
  docs/superpowers/plans/2026-09-25-cloud-and-ci.md > .superpowers/sdd/task-C4-brief.md
```

---

## 7. 开场白（可直接粘贴）

> 读 `docs/superpowers/plans/2026-09-25-deploy-handoff.md`（片② 只剩首次真部署）。
> 设计真源 = `docs/superpowers/specs/2026-09-24-cloud-and-ci-design.md`；实施计划 = `docs/superpowers/plans/2026-09-25-cloud-and-ci.md`；
> 台账 = `.superpowers/sdd/progress.md` 的「上云与自动化（二）」段。
> 先确认用户已做完「〇 服务器预备」五项（命令见交接邮件），然后**按 Task C4 走完首次真部署**（含真证书验收、幂等、回滚、凭据面），
> 走 `superpowers:subagent-driven-development`（每任务 = 实现者 → 评审者 → 修复轮 → 复评 → 记台账）。
> ⚠️ 注意 §3 的环境坑（`gh` 全路径、`gh api` 别带开头斜杠、CRLF 用 `tr`、先验证判据本身）。
