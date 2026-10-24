# T9 交接：片③-B 首次真部署之后的三步（**需你本人在场**）

> **日期**：2026-09-26 · **状态**：首次真部署 **✅ 已完成并复核**；剩下三步要你做
> **设计真源**：`docs/superpowers/specs/2026-09-25-backup-and-restore-design.md`（§6.2 即本文件第 ① 步的**过时原文**，见下文订正）
> **手册**：`docs/ops/first-deploy.md`（「数据没了怎么办」与「备份还活着吗」两节）

---

## 0. 已完成（你可自行复核）

| 项 | 值 |
|---|---|
| tag | **`v1.1.0`** → `8d863f7`（在 master 上 ✓） |
| 运行 | release **36224849967**：`images` ✅ · `conformance` ✅ · `deploy` ✅ |
| 线上版本 | `v1.1.0`（7 个容器） |
| **第一份真备份** | `manifest-2026092607.json` · `users-2026092607.sql.gz`(1029B) · `caddy-data-2026092607.tgz`(4308B) · `env-2026092607.gz`(252B) |
| 那次备份自述 | `caddy_entries=7 image_tag=v1.1.0 usable=true` |
| 权限 | `/home/ubuntu/ftl-backups` 与 `ftl-ops` 均 `0700` |
| 定时 | `17 * * * * /bin/bash /home/ubuntu/ftl-ops/backup.sh … # ftl-backup` |
| 站点 | `/api/health` 200 · `/` 200 · socket.io 握手 · 证书有效至 2026-12-24 |
| 约束 | `/srv/pokergame` 恰好两文件 · 服务器上无 ghcr 凭据 · `ftl-ops` 恰好三个脚本 |

---

## ① 验证「备份停了，发版时会知道」——**这条闸真的会红吗**

### 为什么这一步不能省

这是用户裁决 5 的**整个机制**：没有监控，所以「备份停了」唯一能被发现的地方就是发布流水线里那一步。**没亲手看它红过一次，就不算验过。**

### 🔴 设计 §6.2 原文已失效 —— 用下面这个方法

设计要求「**把 ok manifest 移出目录**」。但 C1 修复把「首次备份」挪到了部署之后，于是移走所有 manifest 会让那一步**当场造一份新的**，闸读到新的 ⇒ **永远绿**。

**但还有一个更隐蔽的抵消**（2026-09-26 实测踩到）：**每小时的 cron 自己会造新备份**。第一次做旧之后一小时，cron 产出了 `manifest-2026092608.json` ⇒ 最新的一份又变回「1 小时前」⇒ **闸照样绿**。

⚠️ **这不是闸坏了，是它判断对了** —— 备份确实活着。**要测「备份停了」，得先让备份真的停下来。**

⇒ 正确做法三步：**停 cron → 把最新的一套挪开 → 打 tag**。

### 命令（在服务器上，`ubuntu` 身份）

```bash
ssh -i ~/.ssh/ftl_deploy ubuntu@<DEV_HOST_IP>

# ① 停掉每小时的定时（测试期间）—— 不停它，它每小时都会造一份新鲜的
crontab -l | sed 's|^\(17 .*# ftl-backup\)|# \1|' | crontab -
crontab -l | grep ftl-backup          # 应显示被 # 注释掉的那行

# ② 把「最新那一套」搬到旁边（**搬，不是删**）
cd /home/ubuntu/ftl-backups
mkdir -p /home/ubuntu/ftl-hold
mv manifest-*.json users-*.sql.gz caddy-data-*.tgz env-*.gz /home/ubuntu/ftl-hold/ 2>/dev/null
# 再把其中一套改回一周前的名字放来（让「有 ok manifest」成立，但很老）
cd /home/ubuntu/ftl-hold
set -- $(ls manifest-*.json | head -1); f=$1; ts=${f#manifest-}; ts=${ts%.json}
mv "$f"                        "/home/ubuntu/ftl-backups/manifest-2026091910.json"
mv "users-$ts.sql.gz"          "/home/ubuntu/ftl-backups/users-2026091910.sql.gz"
mv "caddy-data-$ts.tgz"        "/home/ubuntu/ftl-backups/caddy-data-2026091910.tgz"
mv "env-$ts.gz"                "/home/ubuntu/ftl-backups/env-2026091910.gz"
ls -A /home/ubuntu/ftl-backups        # 应只剩 2026091910 那一套 + backup.log + .lock
```

### 然后发布一次（在你机器上）

⚠️ **必须先确认 tag 指向的提交已经推到 `master`** —— 2026-09-26 第一次尝试就栽在这上面：
tag 打在了一个**没推上去的本地提交**上，被 R1308 的闸正确拒绝（`拒绝部署：这个 tag 指向的提交不在 origin/master 上`）。

```bash
git status                          # 应干净
git log --oneline -1                # 记住这个提交
git push origin master              # 确保 master 是最新的
git tag v1.1.2 && git push origin v1.1.2
```

### 预期

- `images` ✅ · `conformance` ✅
- `deploy` 里的**「首次备份」那一步应该被跳过**（提示形如「备份目录里已有 ok:true 的 manifest ⇒ **不**跑首跑」）
- **「备份新鲜度」那一步必须红**，红行形如：
  ```
  ❌ 备份新鲜度：最近一次成功备份在 <N> 小时前（阈值 3h）—— **备份停了**。
      站是好的，**别回滚**：这一条与本次发布无关；去看手册「备份还活着吗」那节与 …/backup.log。
  ```
- **`deploy` 的其余步骤（部署、冒烟）应该都是绿的** —— 站是好的，只有备份那条红

### 复原（**两步都要做**）

```bash
# 把搬走的那几套放回来
mv /home/ubuntu/ftl-hold/* /home/ubuntu/ftl-backups/ 2>/dev/null
rmdir /home/ubuntu/ftl-hold
# 把做旧的那一套的名字改回去（否则它会一直躺在那里当「最老的一份」）
cd /home/ubuntu/ftl-backups
for t in manifest users caddy-data env; do
  case $t in
    manifest)   mv manifest-2026091910.json  manifest-2026091901.json ;;
    users)      mv users-2026091910.sql.gz   users-2026091901.sql.gz ;;
    caddy-data) mv caddy-data-2026091910.tgz caddy-data-2026091901.tgz ;;
    env)        mv env-2026091910.gz         env-2026091901.gz ;;
  esac
done

# 🔴 别忘了把每小时的定时放回来 —— 否则备份就真的停了
crontab -l | sed 's|^# \(17 .*# ftl-backup\)|\1|' | crontab -
crontab -l | grep ftl-backup          # 应显示没有 # 的那行
ls -A /home/ubuntu/ftl-backups
```

再打一个 tag（`v1.1.3`）⇒ 新鲜度那一步应该**绿**。

### 不一样怎么办

- **新鲜度那一步没红**（服务照旧绿）⇒ **这条闸是坏的**，把它当成本片的**未通过项**报回来（这正是本仓最忌的「判据存在 ≠ 判据有效」）。
- **首次备份那一步跑了**（而不该跑）⇒ 「仅当还没有 ok manifest」那个限定词坏了，同样报回来。
- **部署/冒烟也红了** ⇒ 与备份无关的故障，照手册 ⑥ 排错。

---

## ② 真人做一次恢复演练

### 为什么必须你本人

设计里写死了「**恢复永远是人决定的事**」。这一步验的不是代码，是**那条路你走得通吗**。

### 先造点数据（否则恢复出来是空的，演练没有意义）

```bash
# 在浏览器/客户端注册两个测试账号，或：
curl -sS -X POST https://<DEV_HOST>/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"phone":"13800000001","password":"Drill!2345","nickname":"drill-a"}'
curl -sS -X POST https://<DEV_HOST>/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"phone":"13800000002","password":"Drill!2345","nickname":"drill-b"}'
```

### 然后**照手册那节逐条敲**（不要照本文件敲 —— 本文件只是给你预告）

手册 `docs/ops/first-deploy.md` 的 **「数据没了怎么办」** 那节。核心就一条逐字命令（带默认参数 = 最近一份 ok 备份）：

```bash
ssh -i ~/.ssh/ftl_deploy ubuntu@<DEV_HOST_IP>
bash /home/ubuntu/ftl-ops/restore.sh
```

（它会先问你确认；不在终端里跑会被**拒绝** —— 这是设计。）

### 记录什么

每一步的**命令 + 实得输出**，特别是：

- 它有没有**先做一份现场备份**（`manifest-restore-<ts>.json`），且那份的戳是 **14 位**（秒粒度）
- 第 ② 步停容器、第 ④ 步灌库、第 ⑥ 步**先校验镜像再起栈**、第 ⑦ 步冒烟
- 结尾那行的耗时，以及**恢复了几个账号**
- 总墙上时间

### 预期

- 结尾 `✅ 恢复完成：…`，冒烟三条过
- 恢复后的账号数 = 你建的账号数

---

## ③ 把结果发回来

把上面两步的记录（命令 + 实得输出，逐字）发回来即可。我会：

1. 把实测值填进设计 §10 与台账
2. 把这一轮**我发现的那些设计文档订正**一并改掉（见下）
3. 收口

---

## 附：本轮控制者发现的、待订正的设计文档清单

（与片② 那份类似 —— 都是「下游抓到了设计文本里的错」）

| # | 设计文档位置 | 问题 |
|---|---|---|
| 1 | §3.1 时序 | 「首备」已从**部署之前**改到**部署之后**（C1 修复，用户裁决） |
| 2 | §3.1 dispatch 行 | ① 投递现在有**两个家**（`release.yml` 与 `deploy.sh`），且 `deploy.sh` 那个**在回滚路径上也跑**（用户裁决：保留代码、改设计）；并要写**准确**的边界：那里的失败是把回滚**中止**，不只是「没给误导性建议」 |
| 3 | §7 / §4.4 | `manifest-*.json` ⇒ `manifest-[0-9]*.json`（否则「一次恢复」就能把自查喂成绿） |
| 4 | §7 / §4.4 | `"ok": true` ⇒ `"ok":true`（真实是紧凑写法） |
| 5 | §4.1 | 补 `flock` 缺席时的**降级路径**（用户裁决） |
| 6 | §4.1 参数表 | 列了 `--caddy-volume` 但代码里没有（硬编码 `-C /data`，生产确实挂 `/data`）；另缺 `--image-prefix` / `--edge-container` / `--env-file` |
| 7 | §4.2 ③ | 截断检测的实现换成了 mysqldump 的结束标记（manifest 不记每表行数）—— 代码里已披露，设计没记 |
| 8 | **§6.2 第 2 步** | **本条**：C1 修复后「移走 manifest」的测法失效 ⇒ 应改为「**做旧**」（见本文件 ①） |
