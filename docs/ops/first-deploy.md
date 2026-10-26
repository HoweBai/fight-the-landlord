# 首次上线手册（单台 VPS）

> 形态：**17 个服务容器 + 门口（第 18 个）**。对外只开 `80/443`；`3000` 不发布。
> ⚠️ 第 ⑦ 节的「代码怎么上去」片① 是**临时手工路径**（在服务器上克隆仓库 + 构建镜像）；片② 已把它换成**流水线**：
> 镜像在 CI 里构建好、推镜像库，服务器只拉取 —— 服务器上**没有仓库、没有源码、不构建**。

**这份手册给谁看**：把项目第一次放到服务器上的人（不需要运维经验）。每一节都按同一个格式写：
**为什么** → **命令** → **预期输出** → **输出不一样怎么办**。命令都可以整段复制粘贴（都在服务器的 **`/srv/pokergame/`** 执行 —— 那里**不再有仓库**，只有 `docker-compose.yml` + `.env`）。

> ⚠️ **首次上线的实际执行顺序**（**先看这条**）：**〇（服务器预备）→ ① → ② → ③**（手工一次、都在服务器上做；⚠️ 其中 **②2.1「生成三个密钥」要抢在 〇③ 之前做** —— 〇③ 要写的那份 `.env` 用的就是它的输出）→ 然后 **⑦7.1**（`git tag` ⇒ 流水线自动构建镜像并部署）。④ 描述的就是这次「起栈」（那条 `up -d` 由流水线代跑，见 4.1 的注意），⑤/⑥ 是部署之后的自检与排错。
> ①–⑨ 的**编号是分节用的**（按主题组织，方便日后查阅）；**照着做**请按上面这条顺序。两处最容易踩的：**〇 五项要全做完再打 tag**（少任何一项，⑦ 的部署都会失败：ssh 连不上 / 缺 `.env` / 证书签不出来）；**〇② 假定机器上已经有 docker**（没有就先做 ①1.2）。
> ⚡ **第一次部署会花上几分钟，不是卡死**：部署的最后一步「冒烟三条」最多重试 **5 分钟**（每 5 秒试一次、60 次封顶，整段有 5 分钟的硬上限）—— 等的是门口把**证书**签下来（ACME 要回连 80 端口）。**之后的每一次发布都是秒级**。
> 🆘 **去哪一节**：想**改配置**（开关好友房 / 改底分档位 / 机器人比例）⇒ **「怎么改配置」**（不用登服务器）；想**开充值/提现** ⇒ **「支付怎么上线（五步）」**、打款怎么走 ⇒ **「提现打款手顺」**；代码/发布坏了 ⇒ **⑧ 回滚**（片⑦ 起先看它的「回滚注意」）；**数据没了**（玩家数据空了、表不见了）⇒ **「数据没了怎么办」**；想确认备份还活着 ⇒ **「备份还活着吗」**；想**看监控、调告警** ⇒ **「监控（看板与告警）」** —— 这几节都与 ⑧ 并列，都不需要你懂代码。

**权限**：除各节特别标注（如 ⑨ 在**开发机**上跑；**「数据没了怎么办」必须以 `ubuntu` 跑** —— 那是恢复路径，脚本会机械拒绝 root）外，以下命令都以 **root** 登录执行 —— 不是 root 的话，每条命令前加 `sudo`。

---

## 开始之前：你最后会得到什么

```
玩家浏览器 / 手机 App
        │  https://你的域名（443，加密）   ← 证书在这里签发、加密在这里终止
        ▼
  【门口 edge】—— 第 18 个容器（软件叫 Caddy）—— 唯一对外入口
        │   ① 说的是 HTTPS，替你把证书自动申请下来（Let's Encrypt）
        │   ② 把 H5 页面发出去（页面在构建时被打进门口镜像里）
        │   ③ 把 /api 与 /socket.io 明文转发给网关
        ▼
  【api-gateway】:3000 —— 网内可达、**不发布到宿主机**
        ▼
  user / config / currency / room / game / robot / payment / douzero + redis + mysql（加上上方的网关，合起来 11 个业务容器；监控片起另有 6 个监控容器 —— 见「监控」一节）
```

**术语一句话**（第一次出现时都在此表）：

| 术语                     | 一句话解释                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TLS / HTTPS**          | 浏览器和服务器之间把流量加密的协议；证书 = 由公开机构签发的「这个域名归你」的证明，浏览器据此显示「锁」                                                                                                                                                         |
| **Let's Encrypt / ACME** | 一家免费签发证书的机构 + 一套自动签发协议；门口软件（Caddy）会自己跟它对话，你只要提供一个邮箱                                                                                                                                                                  |
| **DNS A 记录**           | 域名 → IP 的映射，在域名商的控制台里配置                                                                                                                                                                                                                        |
| **ufw**                  | Ubuntu/Debian 自带的简易防火墙，决定「外面能连哪些端口」                                                                                                                                                                                                        |
| **镜像 / 容器**          | 镜像 = 打包好的程序 + 依赖；容器 = 它跑起来的实例。`docker compose` 按 `docker-compose.yml` 一次起一组                                                                                                                                                          |
| **门口（edge）**         | 本项目对「唯一对外入口」的称呼：服务器最前面的那台机器（本项目里它是个容器），干三件事 —— ① 把 `https://` 的加密解开/加上（① 的专业叫法：**TLS 终止**）② 把网页文件发给浏览器 ③ 把接口请求转给内部服务；第 ③ 件事的专业叫法就是「**反向代理**」（简称「反代」） |

**为什么只放行 80/443**：所有对外流量都必须经过门口（加密、证书、限流都归它）；`3000` 一旦发布出去，任何人都能绕过门口直连网关 —— 可信 IP 与限流全部失效。第 ③ 节有一条专门验证这件事的**反向自检**。

---

## 〇 服务器预备（**手工一次**）

> 只在**第一次**上线前做一次。做完之后，日常发布完全不碰服务器（见 ⑦）。

**① 部署公钥**（把**部署专用密钥对的公钥** `ftl_deploy.pub` 的内容贴进去 —— 它是为这次部署单独生成、把**公钥**那一半交给你的；**不要**用你自己的登录私钥）：

🔴 **这一步写的是 `ubuntu` 用户的钥匙串、不是 root 的**：流水线以 `ubuntu` 登录。**路径写全，别用 `~`** —— 本手册其余命令多以 root 执行，`~` 会落到 `/root/.ssh/`，那样下面那条验证**必然失败**。

```bash
$ sudo mkdir -p /home/ubuntu/.ssh
$ sudo nano /home/ubuntu/.ssh/authorized_keys     # 把 ftl_deploy.pub 的整行粘进去；保存 = Ctrl+O 回车，退出 = Ctrl+X
$ sudo chown -R ubuntu:ubuntu /home/ubuntu/.ssh
$ sudo chmod 700 /home/ubuntu/.ssh
$ sudo chmod 600 /home/ubuntu/.ssh/authorized_keys
```

**预期**：回到你自己的机器上 `ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器 IP>` **不需要密码**就能进。

**不一样怎么办**：仍要密码 / `Permission denied (publickey)` ⇒ 九成是上面的路径或权限：`sudo ls -l /home/ubuntu/.ssh/`（目录 `drwx------`、文件 `-rw-------`、**属主是 `ubuntu`**），再确认 `authorized_keys` 里那一行**没有被编辑器折成两行**。改完重试。

**② 让 `ubuntu` 能用 docker 而不用 sudo**

```bash
$ sudo usermod -aG docker ubuntu
$ exit          # 退出，然后重新登录一次（组变更要新会话才生效）
```

**预期**：用**换身份**的方式再试一次（`sudo -u` 会开一个**新会话** ⇒ 组变更立即生效）：

```bash
$ sudo -u ubuntu docker ps
```

**不报 `permission denied`** 即通过。
⚠️ **为什么不能只跑 `docker ps`**：本手册的命令多数以 **root** 执行，而 root 本来就能用 docker —— 那样试**什么也证明不了**；流水线是以 **`ubuntu`** 登录的，要证的正是**它**能用。
⚠️ 若上面这条本来就通过 ⇒ `usermod` 是 **no-op**，可以跳过「退出重登」；照做也无害。

**③ 建目录 + 写 `.env`**

```bash
$ sudo mkdir -p /srv/pokergame && sudo chown ubuntu:ubuntu /srv/pokergame
$ nano /srv/pokergame/.env
```

内容 = **②（密钥与 env）**的那**五项**（`JWT_SECRET` / `DB_PASSWORD` / `INTERNAL_SERVICE_TOKEN` / `SITE_ADDRESS` / `TLS_MODE`）。
⚠️ 其中**三个密钥先按 ②2.1 生成**（`openssl rand -hex 32` 跑三次）—— 也就是说 **②2.1 那一小步要抢在本步之前做**（② 剩下的部分讲的是「这五项各是什么」，可以之后再读）。

⚠️ **这个 `.env` 是「手工写一次、部署永不覆盖」的**（流水线只送 `docker-compose.yml`）⇒ 以后再发布**不会**动它。

**④ DNS A 记录**：把域名指向这台机器的公网 IP。

**预期**：在你自己机器上 `nslookup <你的域名>` 出来的地址就是服务器 IP。

**⑤ 放行端口（两层都要）**

- 云厂商控制台的安全组：放行 **22 / 80 / 443**（腾讯云叫「安全组」，在「云服务器 → 安全组」里加**入站规则**）。
- 机器内防火墙：

```bash
$ sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
$ sudo ufw status
```

**预期**：三条 `sudo ufw allow …` 各打印 `Rules updated`（IPv6 默认开着，还会各多一行 `Rules updated (v6)` —— 与 ③3.2 的样例同形态）。

⚠️ **此刻 `sudo ufw status` 多半只显示 `Status: inactive`** —— 规则**已经记下**，但防火墙**还没启用**，所以不显示规则表。**这是正常的，不是失败**：`ufw enable` 在 ③3.2，按本手册的执行顺序排在 〇 之后 —— 那一步做完，规则的**三条 `ALLOW`** 才会出现在规则表里。

**不一样怎么办**：`ufw: command not found` ⇒ `sudo apt-get update && sudo apt-get install -y ufw`。

⚠️ **只开一层是不够的**：安全组拦掉的流量根本到不了机器，机器内的 `ufw` 也就没机会放行 —— 两层是「与」的关系。

---

## ① 服务器准备

**为什么**：这台机器要**跑起整个平台**（18 个容器），并放得下全部镜像与数据。片② 起**服务器不再构建**（镜像由 CI 构建好、推到镜像库，服务器只拉取 —— 见 ⑦）⇒ 吃紧的是**磁盘**：14 个镜像 ≈10.1GB（连 redis/mysql/node-exporter/cadvisor 的基础镜像 ≈11.7GB）要放得下。

**要求**：Linux（Ubuntu 22.04/24.04 或 Debian 12）· **2 核** · 内存 **7.5 GiB**（`free -h` 实测；生产机基准）· 磁盘 **≥ 20GB**（**有约束力的是「≥ 20GB」这条线**：放镜像 ≈10GB + 数据。参考读数：生产机 `VM-0-7-ubuntu` 在 **2026-09-25**（首次部署前）实测 `df -h /` = `118G 5.6G 108G 5%`；⚠️ 本手册早先记的「可用 ≈33G」是**另一台机器**（`VM-0-4-ubuntu`）的数 —— 那台已不再使用）。

### 1.1 先量一下机器

```bash
$ nproc
$ free -h | head -2
$ df -h /
```

**预期**：`nproc` ≥ 2；`free -h` 的 `Mem:` 行 total 在 `7.5Gi` 上下（生产机实测；**服务器不构建** ⇒ 这条只影响跑起来的余量）；`df -h /` 的 `Avail` ≥ 20G（**认的是这条线**，不是某个读数 —— 生产机 `VM-0-7-ubuntu` 2026-09-25 实测 108G，出处见上面「要求」那行；换一台机器读数会不一样）。

**不一样怎么办**：内存明显小于上面的预期 ⇒ 先加一块 swap 再继续（最省事的保险）：

```bash
$ fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
$ free -h        # 再看一眼，Swap 行应该不再是 0
```

磁盘不足 ⇒ 先清理或扩容（镜像 ≈10GB + 数据库数据；**服务器不构建** ⇒ 不需要额外的构建余量）。

### 1.2 安装 Docker

**为什么**：整个平台以容器形式运行，Docker 是唯一的前置依赖。

```bash
$ curl -fsSL https://get.docker.com | sh
```

**预期**：脚本最后会打印类似

```
Docker version 2x.x.x, build ...
Docker Compose version v2.x.x
```

**不一样怎么办**：卡住/报域名解析失败 ⇒ 先确认服务器能上外网（`curl -I https://get.docker.com`）；国内机器可能要配镜像源或走代理。

### 1.3 验证版本（**下限要求**）

```bash
$ docker compose version
```

**预期**：`Docker Compose version v2.x.x`（本手册在开发机实测的样例是 `Docker Compose version v5.5.1` —— 它仍然是 Compose v2 这一支，编号只是随 Docker 一起涨；**关键是 ≥ v2**）。

本手册依赖 v2 的两个能力：`--profile`（按需启动门口）与 `--env-file`。

⚠️ **请一律用带空格的 `docker compose`**（本手册所有命令都按这个形态写）。**老式 v1（连字符 `docker-compose`）不支持**本手册要用的 `--profile` 与 `--env-file`，会直接失败。
注意**判据不是「有没有连字符」**：「连字符」形态不一定就是 v1 —— 有些较新的安装里，连字符命令指向的也是 v2 血统（本机实测：`docker-compose --version` 输出同为 `Docker Compose version v5.5.1`，且 `--profile` 可用）。认准上面第一条命令的输出 **≥ v2** 即可。

### 1.4 git（**不再需要** —— 片② 起服务器上不跑 git）

```bash
$ git --version
```

**预期**：有或没有**都行** —— 片① 的 ⑦ 要在服务器上克隆仓库，那时才需要它；片② 起**服务器上没有仓库**（见 ⑦）：打 tag、送 `docker-compose.yml` 都在你自己的机器与流水线里完成。

**不一样怎么办**：`command not found` ⇒ **不用装**，照常往下走。

---

## ② 密钥与 env（**五项**，一个都不能少）

**为什么是五项**：三样是**密钥**（仓库里写着一段开发用的公开常量，生产必须换成随机值）；两样是**门口变量**，它们**没有默认值** —— 漏配时门口容器会直接退出（`exit 1`），这是**故意**的（fail-closed：宁可起不来，也不要「用仓库里公开的常量」或「自签证书」悄悄跑起来）。

### 2.1 生成三个密钥

```bash
$ openssl rand -hex 32
```

**预期**：每次输出 **64 位十六进制**（本机实测样例：`8f5fc8b61618da38ebd26112fd12b646fe3435003bcf6795da441bf5410d0adc`），跑两次结果不同。

⇒ 跑 **三次**，分别留给 `JWT_SECRET` / `DB_PASSWORD` / `INTERNAL_SERVICE_TOKEN`。

**不一样怎么办**：没有 `openssl` ⇒ `apt-get install -y openssl`。**不要**自己编一个短口令充数（这三样是防猜测用的）。

### 2.2 写 `.env`（在服务器的 **`/srv/pokergame/`**）

**为什么**：这是 Compose 读取变量值的唯一文件（`docker-compose.yml` 里所有 `${...}` 都从这里取）。它已被 `.gitignore` 排除 ⇒ 不会进仓库、也不会随流水线走 ⇒ 要**在服务器上手工写一次**（`/srv/pokergame/.env`，见 〇③）—— 写完之后**部署永不覆盖**它。

```
JWT_SECRET=<第 1 次 openssl 的输出>
DB_PASSWORD=<第 2 次 openssl 的输出>
INTERNAL_SERVICE_TOKEN=<第 3 次 openssl 的输出>
SITE_ADDRESS=game.example.com
TLS_MODE=you@example.com
```

`SITE_ADDRESS` = **你的域名**，不带端口、不带 `https://`；`TLS_MODE` = **你的邮箱**（证书到期通知，同时是 ACME 账号标识）。照抄上面的 `game.example.com` / `you@example.com` 是**错的** —— 换成你自己的。

**逐项对照表**（供你自查写对了没有）：

| 键                       | 谁在用                                                                                                     | 作用                                                                   | 漏了会怎样                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `JWT_SECRET`             | user-service（**签发**令牌）+ api-gateway（**验签**）+ config-service（管理令牌的**回落环**）              | 登录令牌的签名密钥（未设 `ADMIN_JWT_SECRET` 时兼作管理令牌的签名密钥） | ⚠️ 漏配 ⇒ 三处**同时**回退到公开的开发常量（登录仍通，但密钥是公开的、**静默**） |
| `DB_PASSWORD`            | mysql + user-service + config-service                                                                      | 数据库 root 口令                                                       | 回退 `root`，**静默**                                                            |
| `INTERNAL_SERVICE_TOKEN` | 9 个服务（user / config / room / game / robot / gateway + 监控的 prometheus / alertmanager / alert-relay） | 服务间调用的内部口令（监控侧：抓指标 / 投告警的凭据）                  | **服务起不来**（响亮 fail-closed）                                               |
| `SITE_ADDRESS`           | 门口                                                                                                       | 站点地址（同时决定证书对象与容器内监听端口）                           | **门口 `exit 1`**（响亮）                                                        |
| `TLS_MODE`               | 门口                                                                                                       | `邮箱` = 自动申请真证书；`internal` = 自签（**只开发用**）             | **门口 `exit 1`**（响亮）                                                        |

⚠️ **不要直接复用开发机那份根 `.env`**：仓库里现存的那份只有 11 个键、**没有** `INTERNAL_SERVICE_TOKEN`、`SITE_ADDRESS`、`TLS_MODE`，而且 `JWT_SECRET`/`DB_PASSWORD` 是开发值 —— 拿它上线会让服务起不来（缺内部口令）或静默用弱口令。
其余键（`DB_HOST`、`DB_USER`、各 `*_SERVICE_URL`、`DOUZERO_URL`）**不需要**写：这些值都硬编码在 `docker-compose.yml` 里了。

**片⑦ 新增两个运维键**（**管理配置中心用**；③ 起 `ADMIN_PASSWORD` = **首启引导口令**：只在**一个管理员账号都没有**的首次启动用它建引导号 `admin`，账号建好后本键不再参与判定 —— 不在上面那份「必须五项」里，但**想开好友房、想动钱就必须先有管理员账号**）：

| 键                 | 默认值                                                      | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`   | （空 ⇒ **零账号时管理面关闭**；账号在库后本键不再参与判定） | 管理面的**首启引导口令**（③ 起）：部署**第一次启动**时若管理员表为空 ⇒ 用它**自动创建引导账号** `admin`（超级管理员）。之后它就退休了（「只作首启引导」）—— 日常改口令 / 建号在管理页或 hatch 复位里做，**不要再动这个键**。⚠️ **旧版本升级上来**：管理员表从零开始 ⇒ 升级后第一次启动会用 `.env` 里现成的它把 `admin` 号建出来，用你原来的口令登录即可。不写又去打开管理页 ⇒ 会看到「管理面未启用」（登录接口回 404）—— 那是**设计内的关闭态**，用「怎么改配置」一节的 **hatch** 建号即可。**不是**服务启动密钥 ⇒ 不写不影响玩家 |
| `ADMIN_JWT_SECRET` | （空 ⇒ 回落 `JWT_SECRET`）                                  | 管理令牌（登录成功后签发的短期令牌）的**独立签名密钥**。⚠️ **两侧都要**：config-service **签发** + api-gateway **验签** —— compose 里两处都读这个变量（同源），写进 `.env` 一处即可；不写也能用（回落 `JWT_SECRET` —— 回落链的**两侧同钥**由 2.3 自检的「`JWT_SECRET` 恰好 3 行同值」核对与判据 ①k-bis 钉住），生产建议独立配置                                                                                                                                                                                                   |

（这两个键在 `docker-compose.yml` 里都是 `${ADMIN_…:-}` 的**空默认透传**形态 ⇒ 漏配**不会**落回不安全的常量、也不会拦服务启动（「空串 = 未设」是两侧写死过的语义）。⚠️ 写进 `.env` 之后**要再走一次部署**才生效（⑦ 的 `up -d` 会带上新值；只在服务器上改了 `.env` 而不再部署一次，正在跑的容器**看不到**新值）。）

**支付配置管理化片新增两个运维键**（**渠道凭据的根信任锚**；两者都**必填** —— 不写 ⇒ 渠道块整体 fail-closed（**站照常跑、不阻塞启动**，只是渠道调不动）；渠道六项凭据本身不用写 `.env`，改在**管理页**填 —— 见本节末尾「渠道凭据」）：

| 键                       | 谁在用                                           | 说明                                                                                                                                                                                                             | 漏了/空着会怎样                                                                                                             |
| ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PAY_CONFIG_ENC_KEY`     | 仅 config-service                                | 渠道凭据存储的**加密主钥**：**base64** 编码、解码后必须**恰好 32 字节**（生成：`openssl rand -base64 32`）。🔴 **每小时备份会剥掉这一行**（`env-*.gz` 里没有它）⇒ 自己**另存一份**（见「数据没了怎么办」恢复节） | 渠道块**整体关闭**：管理页「支付渠道」打不开（503「渠道密钥存储未启用（缺主钥）」）、拉取被拒 ⇒ 渠道调不动；**不阻塞启动**  |
| `PAY_CHANNEL_PULL_TOKEN` | config-service + payment-service（**两端同值**） | 渠道凭据**专用拉取通道**（`config.payChannel.get`）的令牌（随便一条足够长的随机串，生成：`openssl rand -hex 32`）                                                                                                | config-service 端未设 ⇒ **拒一切拉取**；payment 端未设/不同值 ⇒ 拉取被拒 ⇒ 渠道「未配置」语义（下单 15001）；**不阻塞启动** |

（两键在 compose 里都是**空默认透传**（`${…:-}`）⇒ 不写不会拦启动、也不会落回任何默认值 —— 空串 = 未设。⚠️ 与上面同理：写进 `.env` 之后**要再走一次部署**才生效。）

**通知通道管理化片新增一个运维键**（**通知凭据的根信任锚**；**必填** —— 不写 ⇒ 通知块整体 fail-closed（**站照常跑、不阻塞启动**，只是通道不生效）；九项通知凭据本身不用写 `.env`，改在**管理页**填 —— 见「通知怎么上线（三步）」）：

| 键                          | 谁在用                                                     | 说明                                                                                                                 | 漏了/空着会怎样                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOTIFY_CHANNEL_PULL_TOKEN` | config-service + alert-relay + am-renderer（**三端同值**） | 通知凭据**专用拉取通道**（`config.notifyChannel.get`）的令牌（随便一条足够长的随机串，生成：`openssl rand -hex 32`） | config-service 端未设 ⇒ **拒一切拉取**；消费端未设/不同值 ⇒ 拉取被拒 ⇒ 通道不生效（relay 全新栈且从未拉到 ⇒ 告警投递回 **500**、由告警器按重投周期再试）；**不阻塞启动** |

（本键在 compose 里是**空默认透传**（`${…:-}`）⇒ 不写不会拦启动、也不会落回任何默认值 —— 空串 = 未设。⚠️ 与上面同理：写进 `.env` 之后**要再走一次部署**才生效。）

**广告片新增一个运维键**（**广告回调密钥的根信任锚**；**必填** —— 不写 ⇒ 广告回调链 fail-closed（**站照常跑、不阻塞启动**，玩家看完广告**永远不到账**）；2026-10-18 测试服真栈实锤）：

| 键                       | 谁在用                                                   | 说明                                                                                                                   | 漏了/空着会怎样                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AD_CHANNEL_PULL_TOKEN`  | config-service + currency-service（**两端同值**）        | 广告回调密钥**专用拉取通道**（`config.adChannel.get`）的令牌（生成：`openssl rand -hex 32`）                          | config-service 端未设 ⇒ **拒一切拉取**（`10002 拉取令牌不匹配`）；currency 端未设/不同值 ⇒ 拉取被拒 ⇒ **每条回调都 503 `{"isValid":false}`**（瞬态、平台会重投但永远验不了签）⇒ 玩家看完广告领不到金币；**不阻塞启动** |

（本键在 compose 里同样是**空默认透传**（`${…:-}`）⇒ 不写不会拦启动、也不会落回任何默认值 —— 空串 = 未设。⚠️ 写进 `.env` 之后**要再走一次部署**（或至少重建 config-service + currency-service）才生效；`deploy` 流水线**不会**替你写 `.env`。主钥复用 `PAY_CONFIG_ENC_KEY`，**没有**新的主钥键。）


**监控片新增变量**（**看板与告警用**；不写 ⇒ 监控的对应部件起不来 / 通道不开，**站本身照常跑** —— 不在上面那份「必须五项」里；各值怎么拿见「监控」一节）：

| 键                       | 谁在用                 | 说明                           | 漏了/空着会怎样                                                                                    |
| ------------------------ | ---------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GRAFANA_ADMIN_PASSWORD` | 监控的 Grafana（看板） | 面板登录口令（用户名 `admin`） | ⚠️ **监控片起必写**：不写 ⇒ Grafana **反复重启起不来**（fail-closed，见 ⑥ 详注 ⑩）；站其余部分照常 |

~~邮件五件套 / 三个 IM webhook（共九行）~~ —— **通知通道管理化片起已退役**：这些告警通道不再写 `.env`，改在**管理页 →「通知通道」**填（加密存储、掩码写；填法见「通知怎么上线（三步）」，各项从哪拿见 `notify-onboarding.md`）。旧写法（写 `.env` 再部署）**已失效** —— 容器不再读这些键（防回流判据钉住）。

⚠️ **这些地址/授权码本身就是凭据**（拿到就能往你的群 / 邮箱发东西）⇒ 别外传、别贴进聊天或工单。**通知通道管理化片起它们不再落 `.env`**（改存数据库：加密 + 掩码写）—— 进的是数据库备份（`users-*.sql.gz`）里，`.env` 备份（`env-*.gz`）里不再有它们；`NOTIFY_CHANNEL_PULL_TOKEN`（通道令牌）照常走 `.env` 与 env 备份。

**渠道凭据**（**管理页填写** —— 不再走 `.env`；支付配置管理化片起）：充值 / 提现渠道的**六项凭据**已从 `.env` 搬进**管理页 →「支付渠道」**（**加密存储**；写面仅超级管理员；私钥**只写不可读** —— 保存后只显示指纹，任何角色都读不回原文）。**不填 ⇒ 暗上线照常跑**（两开关默认关、服务可起），只是渠道调不动；**要开充值/提现之前必须填全**，顺序见「支付怎么上线（五步）」。各项的含义与从哪拿见 `alipay-onboarding.md` §4「交给我方的值」。对照表（字段名 = 管理页上的字面）：

| 管理页字段     | 说明                                                                                                                     | 留空/清空会怎样                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `渠道网关地址` | 支付宝网关地址：**留空 = 生产默认网关**（**生产就留空**）；只有沙箱联调期才填沙箱地址                                    | 不填无碍（走默认生产）；填错 ⇒ 渠道调用全失败（15001）                          |
| `应用 APPID`   | 支付宝开放平台应用的 **APPID**                                                                                           | 渠道调用失败 ⇒ 下单被拒（15001）                                                |
| `应用私钥`     | **应用私钥**：粘贴 PEM 全文、或 base64 一行均可（服务端自动归一、不落明文）。**保存后页面只回指纹**                      | 同上（缺失/解码失败 ⇒ 15001）                                                   |
| `支付宝公钥`   | **支付宝公钥**（同上：PEM 原文或 base64 一行两态均可）                                                                   | 同上（出站验签不可用）                                                          |
| `商户 PID`     | 本方**商户 PID** —— 回调「四条校验」里「seller_id 等于本方」的真源                                                       | ⚠️ **回调全部回 `failure`**（玩家付了钱、订单不推进 —— 钱在支付宝里）；服务照跑 |
| `对外站点基址` | **站点基址**（`https://<你的域名>` —— 与 `SITE_ADDRESS` 同域、**带 `https://` 前缀**）：充值「支付完成后回跳」地址的素材 | 不填 ⇒ 下单被拒（15001）                                                        |

**生效时机**：保存后**下一次渠道调用即生效**（服务每次调用现拉）——**不用重启、不用重新部署**（与 `.env` 系不同）。页面报「渠道密钥存储未启用（缺主钥）」⇒ 是 `PAY_CONFIG_ENC_KEY` 没配（见本节前面「支付配置管理化片新增两个运维键」表，对照补上）。

### 2.3 自检（渲染，不启动任何东西）

> ⚠️ 这条自检要服务器上**有** `docker-compose.yml` 才能跑（它随第一次部署送到，见 ⑦）。**想抢在部署前自查**（推荐）：把仓库里的 `docker-compose.yml` 拷一份上去 —— `scp -i ~/.ssh/ftl_deploy docker-compose.yml ubuntu@<服务器 IP>:/srv/pokergame/`（`-i` 指定 〇① 那把部署私钥；**不写它会去试默认的密钥文件、连不上**）—— 部署时会送同一份、直接覆盖，无害。

```bash
$ cd /srv/pokergame          # 部署目录（服务器上只有这两样：docker-compose.yml + .env）；下面的命令都在这里跑
$ docker compose --env-file .env -f docker-compose.yml config \
    | grep -E "JWT_SECRET|DB_PASSWORD|INTERNAL_SERVICE_TOKEN|SITE_ADDRESS|TLS_MODE"
```

**预期**：**22 行**（**2026-10-06 支付片后本机实测重算**；上一版为 18 行；值已截断）。其中 `INTERNAL_SERVICE_TOKEN` 出现 **11 次**（= 11 个服务各一次：user / config / room / game / robot / gateway / currency / payment，再加监控三服务 prometheus / alertmanager / alert-relay）；**`JWT_SECRET` 恰好 3 次、三行值相同**（玩家令牌的签 / 验两侧 = user-service 与 api-gateway，再加 config-service 那一行 —— 它是**管理令牌回落链**的一环：不写 `ADMIN_JWT_SECRET` 时它据此**签发**管理令牌、网关据同一行**验签**）；`ADMIN_JWT_SECRET` **2 次、两行值相同**（config-service 签发 + api-gateway 验签）；`DB_PASSWORD` **4 次**（user-service / config-service / currency-service / payment-service）；`SITE_ADDRESS` / `TLS_MODE` 各 1 次。实际输出形态：

```
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      ADMIN_JWT_SECRET: ""
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      JWT_SECRET: 8f5fc8b6...
      ADMIN_JWT_SECRET: ""
      DB_PASSWORD: 4aeb521f...
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      JWT_SECRET: 8f5fc8b6...
      SITE_ADDRESS: game.example.com
      TLS_MODE: you@example.com
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      DB_PASSWORD: 4aeb521f...
      INTERNAL_SERVICE_TOKEN: 1c9c3e0a...
      JWT_SECRET: 8f5fc8b6...
```

⚠️ 上面两行 `ADMIN_JWT_SECRET: ""` = **没写这个可选键**（2.2 表里的回落设计：空 ⇒ 两侧一起回落 `JWT_SECRET`，**正常**，不是「没读到」）；若写了它 ⇒ 这两行会显示值，**且两行必须彼此相同**。

**不一样怎么办**：看到 `: ""`（**除 `ADMIN_JWT_SECRET` 外**）⇒ 那一项没读到（键名拼错 / 值为空 / 文件不在当前目录）⇒ 修 `.env` 后重跑。
⚠️ 顺带核对两件**必须**成立的事：**`JWT_SECRET` 必须恰好 3 行，且三行值逐字相同** —— 玩家令牌由 user-service **签**、由 api-gateway **验**；管理令牌由 config-service **签**（未设 `ADMIN_JWT_SECRET` 时）、由同一个 api-gateway **验** —— config-service 那行就是这条**回落链**的落点，三行里任一行不一致 ⇒ **玩家令牌或管理令牌验不过**（登录可能 200，随后接口 401）（`slice-07.2-deploy` 的渲染判据钉住这两半：①k 判 user↔gateway 的玩家令牌同钥；①k-bis 判 config↔gateway 的**回落同钥** + 双侧 `ADMIN_JWT_SECRET` 键在位）；**写了 `ADMIN_JWT_SECRET` 时它的 2 行也必须逐字相同**（同理：管理令牌的签 / 验两侧）。只见 **2** 行 `JWT_SECRET`（或更少）⇒ 服务器上这份 `docker-compose.yml` 不是最新版（旧部署残留或被人改过）⇒ **重跑一次部署**（见 ⑦）会用流水线送来的版本直接覆盖它，再重跑本条。

**再查一条「静默漏配」（输出必须 0）**：

```bash
$ docker compose --env-file .env -f docker-compose.yml config \
    | grep -E "JWT_SECRET|DB_PASSWORD" | grep -c "dev-secret-change-in-production\|: root"
0
```

**为什么必须单独查这一条**：上面「22 行」与那两处值核对只证明**读到了值**，而 `JWT_SECRET`/`DB_PASSWORD` 在 compose 里的写法是 `${JWT_SECRET:-dev-secret-change-in-production}` / `${DB_PASSWORD:-root}` —— 与 `INTERNAL_SERVICE_TOKEN`（`:-` 后面是空 ⇒ 服务**起不来**）**方向相反**：漏配时它们**不报错**，静默落回仓库里**公开**的常量（前者 ⇒ 登录令牌的密钥是公开的、可伪造；后者 ⇒ 数据库 root 口令就是 `root`）。这两项漏配时，上面那条自查**照样显示"正常"**（默认值非空），只有本条会逮住它。

**预期**：`0`（**必须**是 0 —— 打印出非 0 = 至少有一项落回了公开默认值）。
（**2026-10-06 支付片后本机实测两态**：① `.env` 里**漏写** `JWT_SECRET`/`DB_PASSWORD`（只写了其余三项）⇒ 打印 `7` —— 命中行原文是三行 `JWT_SECRET: dev-secret-change-in-production`（api-gateway、config-service、user-service 各一行 —— 玩家令牌签 / 验两侧一起落回，再加管理令牌回落环的签发侧）与四行 `DB_PASSWORD: root`（user-service / config-service / currency-service / payment-service 各一行），这就是"静默落回公开常量"的形态；② 五项都按 2.2 写对 ⇒ 打印 `0`。⚠️ `grep -c` 在命中 0 行时**退出码是 1**（「没有匹配」的约定，不是错误）—— 看**打印的数字**，别被 `$?` 误导。上一版记的 `5` = 2026-10-03（16 服务）的旧形态——当时 `DB_PASSWORD` 只有 2 行。）

**不一样怎么办**：非 0 ⇒ 这两项里有漏配/写空的（最常见：键名拼错、值留空、`.env` 不在 `/srv/pokergame/`）⇒ 对照 2.2 的逐项表补齐后重跑本条与上一条。

---

## ③ DNS 与防火墙

**为什么**：证书签发（Let's Encrypt 要验证「域名真的是你的」）走 **80** 端口；玩家访问走 **443**。其它端口一个都别开。

### 3.1 DNS 指向

在域名商的控制台里加一条 **A 记录**：主机名（如 `game`）→ 你 VPS 的**公网 IP**。然后在服务器上验证：

```bash
$ dig +short game.example.com
203.0.113.10
```

**预期**：只输出你的 VPS 公网 IP。

**不一样怎么办**：没有输出 ⇒ DNS 还没生效（一般几分钟，最长 24 小时；用 `dig +short NS 你的域名` 确认域名本身解析正常）；回了别的 IP ⇒ A 记录填错，或有旧记录/CNAME 冲突/CDN 代理插在中间。没有 `dig` ⇒ `apt-get install -y dnsutils`。

### 3.2 防火墙（服务器上执行）

```bash
$ ufw allow 22,80,443/tcp
Rules updated
Rules updated (v6)
$ ufw enable
Command may disrupt existing ssh connections. Proceed with operation (y|n)? y
Firewall is active and enabled on system startup
```

**预期**：先两条 `Rules updated`（v4/v6 各一条）；`ufw enable` 会**交互提问**（「开防火墙可能掐断现有 SSH 连接，继续吗」）—— 就答 `y` 回车（上一步已先放行 22，所以答 `y` 不会把你关在门外）；最后一行 `Firewall is active and enabled on system startup`。之后 `ufw status` 里 22 / 80 / 443 三条是 `ALLOW`。
**不想交互**（例如写脚本）⇒ 改用 `ufw --force enable`（不问、直接开）。

**不一样怎么办**：⚠️ **22 是 SSH，别把自己关在门外**（先确认 22 在放行列表里再 `enable`；实在锁死了走云厂商的 VNC 控制台救）。
用云厂商安全组的话：**两处都要放** —— 安全组（云控制台）与 `ufw`（主机）都只放行 22/80/443。

### 3.3 反向自检：「3000 不发布」的可观测证据

**为什么**：这是「生产形态正确」的等价观察 —— 形态对了，`3000` 从外面**连不上**。

```bash
$ curl -m3 http://<VPS_IP>:3000/api/health
```

**预期**：**失败**，形如

```
curl: (7) Failed to connect to 203.0.113.10 port 3000 after 0 ms: Connection refused
```

（本机实测的等价输出：`curl: (7) Failed to connect to 127.0.0.1 port 39999 after 2038 ms: Couldn't connect to server`；退出码 7。）

⚠️ **从你自己的电脑上跑**（「从外面连不上」的自然做法）多半看到的是**连接超时**，形如：

```
curl: (28) Failed to connect to 203.0.113.10 port 3000 after 3000 ms: Connection timed out
```

—— 那也是失败、**同样算通过**（ufw 对没放行的端口直接把包丢掉 ⇒ 外面看到的是「超时」而不是「拒绝」）。想分辨「拒绝」还是「超时」，**到服务器上再跑一次**同一条命令。

**不一样怎么办**：如果**看到 JSON**（`{"status":"ok",...}`）⇒ **先别继续**：这说明你连到的不是这台服务器的**生产形态** —— 生产基文件里 `3000` 只有容器内 `expose`、**从不发布到宿主机**（见 ④），外面本不该连得上。两种来源：① curl 的地址其实指向了别处（比如开发机上跑着的开发形态栈 —— 它确实发布 3000）；② 服务器 `/srv/pokergame/` 里那份 `docker-compose.yml` 不是流水线送来的基文件（被人改过）⇒ 用仓库里那份覆盖回去：`scp -i ~/.ssh/ftl_deploy docker-compose.yml ubuntu@<服务器 IP>:/srv/pokergame/`，再 `export` 那两个变量（见 ⑥ 开头 ⚠️）后 `up -d`。
注：这条要在 ④ 之后才有意义（栈没起时 3000 当然连不上）；放在这里是为了让你**先认识「失败长什么样」**。

---

## ④ 起栈

**为什么必须带 `-f`**：**开发机**的仓库里另有一份 `docker-compose.override.yml`（**开发形态**：把 `3000/3306/6379` 等端口发布到宿主机、还带一段开发用的内部口令），Compose 在**不显式给 `-f`** 时会**自动合并**它。服务器上只有流水线送的**基文件**（没有 override），但本手册一律带 `-f docker-compose.yml` = 只读生产形态 —— 两边跑的是同一套命令。

> ⚠️ **正式部署时这一节的「起栈」由流水线代跑**（`deploy.sh` 先 `export IMAGE_PREFIX` / `IMAGE_TAG` 再执行，见 ⑦）。**手动**跑下面这条命令时，**必须先把这两个变量 export 出来** —— 不加的话，compose 找的是默认镜像名 `pokergame-*:latest`，而服务器上拉下来的镜像叫 `ghcr.io/howebai/fight-the-landlord-*`。

### 4.1 启动

```bash
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=v1.0.0   # 要跑的那个 tag（日常由流水线代跑）
$ docker compose --env-file .env -f docker-compose.yml up -d
```

**预期**：一串 `Container ftl-xxx Started`（18 个容器各一行；第一次要先拉取镜像，慢一点；正式部署时这一步由流水线做完，见 ⑦），退出码 0。

⚠️ **返回 0 ≠ 门口在服务**：`up -d` 只保证「容器已启动」，不保证里面的程序活着。三个必须知道的形态：

- `SITE_ADDRESS` / `TLS_MODE` 漏配 ⇒ 门口进程**立刻退出**（exit 1），而 `restart: unless-stopped` 会反复把它拉起来 ⇒ `ps` 里显示 **`Restarting (1)`**（见 ⑥ 第 5 条）。
- 门口的健康检查带 60 秒的 `start_period`（给证书签发留时间）⇒ 刚起来时是 `(health: starting)`，属正常。
- **第一次**还要等门口把**证书**签下来（ACME 要回连 80 端口，几十秒到几分钟）⇒ 流水线的「冒烟三条」为此最多重试 **5 分钟**（每 5 秒试一次、60 次封顶，整段有 5 分钟的硬上限）—— 部署显得慢是正常的（见 ⑦）。

### 4.2 检查

```bash
$ docker compose --env-file .env -f docker-compose.yml ps
```

**预期**：**18 行**容器，且每行的 `STATUS` 最终会稳定在 `(healthy)`（个别容器没有健康检查 ⇒ 稳定显示 `Up …` 也算正常；要杜绝的只有 `Restarting`）。下表是**示意**（**不是**本机逐字实测 —— 本机从未把生产形态的**整栈**起来过；`ps` 的真实输出还有 `IMAGE`/`COMMAND`/`CREATED` 等列，这里只留要看的四列）：

```
NAME               SERVICE        STATUS                           PORTS
ftl-alert-relay    alert-relay    Up 40 seconds (healthy)          8090/tcp
ftl-alertmanager   alertmanager   Up 40 seconds (healthy)          9093/tcp
ftl-api-gateway    api-gateway    Up 40 seconds (healthy)          3000/tcp
ftl-cadvisor       cadvisor       Up 40 seconds                    8080/tcp
ftl-config-service config-service Up 40 seconds (healthy)          3006/tcp, 3106/tcp
ftl-currency-service currency-service Up 40 seconds (healthy)          3004/tcp, 3104/tcp
ftl-douzero        douzero        Up 40 seconds (healthy)          2021/tcp
ftl-edge           edge           Up 35 seconds (health: starting) 0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp
ftl-game-service   game-service   Up 40 seconds (healthy)          3003/tcp, 3103/tcp
ftl-grafana        grafana        Up 40 seconds (healthy)          3010/tcp
ftl-mysql          mysql          Up 45 seconds (healthy)          3306/tcp, 33060/tcp
ftl-node-exporter  node-exporter  Up 40 seconds (healthy)          9100/tcp
ftl-payment-service payment-service Up 40 seconds (healthy)          3007/tcp
ftl-prometheus     prometheus     Up 40 seconds (healthy)          9090/tcp
ftl-redis          redis          Up 45 seconds (healthy)          6379/tcp
ftl-robot-service  robot-service  Up 40 seconds (healthy)          3005/tcp, 3105/tcp
ftl-room-service   room-service   Up 40 seconds (healthy)          3002/tcp
ftl-user-service   user-service   Up 40 seconds (healthy)          3001/tcp
```

（门口的 `(health: starting)` 是**正常**的：它的健康检查带 60 秒 `start_period`（见上面 4.1 的警示）；起栈后两分钟内看到这个都别慌，超 2 分钟还没转 `(healthy)` 再看 ⑥。）

并且 **`PORTS` 列里只有 `ftl-edge` 有 `0.0.0.0:...` 开头的发布**（`80->80/tcp`、`443->443/tcp`），其余 17 个都没有宿主发布 —— 这就是「只开 80/443」。⚠️ 其余 17 个行里的 `3000/tcp`、`3306/tcp` 这类**不带 `0.0.0.0:` 前缀**的条目是「容器内 `expose`」（只有同一 docker 网内的服务能连），**不是**宿主发布 —— 判据是看有没有 `0.0.0.0:` 前缀。

**不一样怎么办**：

- 只有 17 行、根本没有 `ftl-edge` ⇒ 门口没起来：`docker compose --env-file .env -f docker-compose.yml ps -a` 看它是不是 `Restarting (1)`，再看 `... logs edge | tail -20`（对照 ⑥ 第 5 条）。
- 某个服务 `Restarting` / `unhealthy` ⇒ `docker compose --env-file .env -f docker-compose.yml logs <服务名> | tail -40`（十有八九是 `.env` 少了三项密钥之一；若是监控容器 ⇒ 见 ⑥ 详注 ⑩）。
- 门口超过 2 分钟还是 `(health: starting)` ⇒ 看它的日志（证书还在签？端口没放行？见 ⑥）。

---

## ⑤ 自检（三条链 + 证书判定）

### 5.0 先记住「证书判定」的判据

- `curl` **不加 `-k`** 能通 = 系统**信任**这张证书 ⇒ **是真证书**。
- 加 `-k`（忽略证书错误）能通**只能说明「有加密」**，**不能**说明「证书签上了」——自签证书同样加密、加 `-k` 也通。

⇒ 下面的命令**一律不加 `-k`**。

### 5.1 链一：加密 + `/api` 转发

```bash
$ curl -sS https://game.example.com/api/health
```

**预期**：

```
{"status":"ok","service":"api-gateway","checks":{"redis":"up"}}
```

（本机在真实网关上实测逐字如上。）

**不一样怎么办**：

- `curl: (60) SSL certificate problem: unable to get local issuer certificate`（或 `self-signed certificate`）⇒ **不是真证书** ⇒ 见 ⑥ 第 4 条。
- `curl: (7) Failed to connect ... port 443` ⇒ 门口没起来 / 443 没放行（回 ④、③）。
- `502` / `{"status":"degraded"...}` ⇒ 门口活着、网关没起来 ⇒ `... ps` + `... logs api-gateway | tail -40`。

### 5.2 链二：静态页面（H5 在门口镜像内构建）

```bash
$ curl -sS https://game.example.com/ | head -3
```

**预期**：

```
<!doctype html>
<html lang="zh-CN">
  <head>
```

（本机在构建产物上实测逐字如上。）

**不一样怎么办**：404 / 空白 ⇒ 门口镜像里没有页面（CI 构建门口镜像时 H5 那一步没成功）⇒ 去 GitHub Actions 看 `images` job 里门口那一段（H5 构建会打印 `DONE`），修好后**重打一个 tag 发布**（见 ⑦）。

### 5.3 链三：实时连接（`wss` 升级 + 一次业务往返）

用**浏览器**打开 `https://game.example.com/`，注册一个账号、登录、进房间打一局。

**预期**：地址栏有**锁**、`http://` 会自动跳到 `https://`；注册 → 登录 → 房间列表 → 进房开打，全程没有报错。

**不一样怎么办**：

- 锁带警告 / 「不安全」⇒ 证书问题（见下面 5.4 与 ⑥ 第 4 条）。
- 页面能开、但**登录后一路报错/进不了房** ⇒ 先按 ⑥ 的三条诊断命令看网关与 room-service 的日志（`... logs api-gateway room-service --tail 50`）；`.env` 相关形态对照 ② 的逐项表。

### 5.4 证书判定（把「真证书」和「只是有加密」分开）

```bash
$ docker compose --env-file .env -f docker-compose.yml logs edge | grep -i "certificate obtained"
```

**预期**：至少一行 JSON 日志，`msg` 是 `certificate obtained successfully`，并带 `identifier`（= 你的域名）/ `issuer` 字段，形如：

```
{"level":"info","ts":...,"msg":"certificate obtained successfully","identifier":"game.example.com","issuer":"acme-v02.api.letsencrypt.org-directory"}
```

（⚠️ 这条的**实际签发**只能在服务器上验：本机没有域名，只验过 fail-closed 一侧。）

**不一样怎么办**：没有这一行 ⇒ 证书还没签成 ⇒ 见 ⑥ 第 4 条（按那里的顺序查）。
再对照 5.0 的判据确认一次：5.1 的 `curl` **不带 `-k`** 能通，才是真证书。

---

## ⑥ 排错

**诊断三条命令**（几乎所有问题都从它们开始；都在服务器的 `/srv/pokergame/` 跑，`<服务名>` 取值见 ④ 的表）：

```bash
$ docker compose --env-file .env -f docker-compose.yml ps                    # 谁没起来 / 谁在重启
$ docker compose --env-file .env -f docker-compose.yml logs <服务名> --tail 50
$ docker compose --env-file .env -f docker-compose.yml config | grep -E "SITE_ADDRESS|TLS_MODE|TRUST_PROXY|INTERNAL_SERVICE_TOKEN"
```

> ⚠️ **本手册里每一条服务器侧的 `pull` / `up -d` / `run` 命令，都要先 export 这两个变量** —— 不 export，compose 会去找默认镜像名 `pokergame-*:latest`（服务器上没有这个镜像）⇒ 命令当场死在 `pull access denied` 上：
>
> ```bash
> $ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>
> ```
>
> `IMAGE_TAG` = 栈当前所在的 tag（首次上线是 `v1.0.0`，见 ⑦7.1；回滚之后就是回滚到的那个旧 tag，见 ⑧）。记不清就 `docker image ls | grep fight-the-landlord | head -3` 看一眼 —— **`TAG` 列**就是它。诊断用的 `ps` / `logs` / `config` **不需要**这两个变量。

**速查表**（点击式定位，处置写的编号 ⇒ 看下面的详注；**第 9 行**的处置不是详注，是手册里**另一节**）：

| #   | 症状（你会看到什么）                                              | 根因                                                      | 处置                       |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| 1   | `up` 报 `Pool overlaps with other one on this address space`      | 写死的网段 `172.28.0.0/16` 与宿主上已有的 docker 网络重叠 | ①                          |
| 2   | 容器起不来，报 `Address already in use`                           | 门口固定地址与 Docker **动态分配**撞车                    | ②                          |
| 3   | 报 `Bind for 0.0.0.0:443 failed: port is already allocated`       | 宿主 443（或 80）已被别的程序占了                         | ③                          |
| 4   | `curl` 不加 `-k` 报证书错误 / 没有 `certificate obtained`         | 80 没放行 / DNS 没生效 / **`caddy-data` 卷丢了**          | ④                          |
| 5   | 门口 `Restarting (1)`；或某服务反复重启                           | `.env` 漏配（门口两项无默认值；内部口令无默认值）         | ⑤                          |
| 6   | 域名 https 打不开，而 `https://IP:8443` 也不通                    | 生产给了非默认 `EDGE_HTTPS_PORT` ⇒ 映射是**死的**         | ⑥                          |
| 7   | 服务起不来，日志里只剩两段 native/JS stack、没有「人话」          | Nest 的 `abortOnError` 把 DI 崩溃的消息吞了               | ⑦                          |
| 8   | 构建卡住 / 失败（**开发机 / CI**）· 服务器上换成「`pull` 拉不动」 | base 镜像不在本地 / 网络到不了镜像库                      | ⑧                          |
| 9   | **数据/表不见了**（玩家数据空、`users` 表没了）                   | 误删 / 程序写坏 / 手滑 `DROP`                             | **「数据没了怎么办」那节** |
| 10  | 监控的 `ftl-grafana` 反复重启 / 打开 `/grafana/` 报错             | `.env` 少了 `GRAFANA_ADMIN_PASSWORD`（监控片起）          | ⑩                          |

### 详注 ① 子网冲突

原文（本机实测复现）：`Error response from daemon: invalid pool request: Pool overlaps with other one on this address space`（退出码 1）。

```bash
$ docker network ls
$ docker network inspect <可疑网络名> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'   # 找出谁占着 172.28.x
```

处置：改**你自己机器上仓库根目录**里的 `docker-compose.yml`（**不是**服务器上那份 —— 那只是流水线送来的副本，改它下次部署会被原样覆盖，见 ⑦）：把 `ipam.config.subnet` 换成不重叠的网段（例如 `172.29.0.0/16`），**并同步改三处**：

- `services.edge.networks.ftl-platform.ipv4_address`（换到新网段的高位地址，如 `172.29.0.250`）；
- `services.api-gateway.environment` 里的 `TRUST_PROXY`（**必须与门口那个地址逐字相同**）；
- 自查：`docker compose --env-file .env -f docker-compose.yml config | grep -E "TRUST_PROXY|ipv4_address"` ⇒ 两个值应完全一致。

改完提交，按 ⑦7.1 打**新 tag** 发布。想**先救急**：在服务器上那份里做同样的改动，然后

```bash
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>   # 见本节开头 ⚠️
$ docker compose --env-file .env -f docker-compose.yml up -d
```

—— 但仓库里那份必须同步改掉，否则下次发布覆盖回去、问题重现。

### 详注 ② `Address already in use`

原文（本机实测复现）：`docker: Error response from daemon: failed to set up container networking: Address already in use`（退出码 125）。

根因：门口要一个**固定地址**（`172.28.0.250`）当「唯一可信代理」的锚，而这个地址如果落在 Docker 的**动态分配池**里，就可能被别的容器先占了（动态分配从 `.2` 起、本栈实测用到 `.10`）。

处置：把门口的 `ipv4_address` 换到**更高的位**（比如 `172.28.0.251` 或更高），并把 `api-gateway` 的 `TRUST_PROXY` 同步改成同一个值（同详注 ① 的自查）。
⚠️ 和详注 ① 一样，改的是**仓库里**那份（服务器上那份会被下次部署覆盖）⇒ 改完提交、按 ⑦7.1 打新 tag 发布；要救急就先在服务器上照改，然后 `export` 那两个变量（见本节开头 ⚠️）再 `up -d`。
⚠️ **不要**改用 `ipam.config.aux_addresses` 去「保留」地址：实测那样保留的地址容器也绑不上、报同一个错（死路）。

### 详注 ③ 443（或 80）被占

原文（本机实测复现）：`Bind for 0.0.0.0:39998 failed: port is already allocated`（443 上长得一样，只换端口号；退出码 125）。

```bash
$ ss -lntp | grep -E ':(80|443)\b'
$ docker ps --format '{{.Names}}  {{.Ports}}' | grep -E ':(80|443)'   # 也可能是别的 compose 项目
```

处置：停掉占用者（或让它改用别的端口）。
⚠️ **生产不要**改成「门口换端口」：玩家和证书都默认走 443（自定义端口只属开发形态，见详注 ⑥）。

### 详注 ④ 证书签不出来

按顺序查（**第 1 步最重要，先看卷**）：

```bash
$ docker volume ls | grep caddy-data
```

**预期**：有一行，形如 `local  pokergame_caddy-data`（前缀 = 项目目录名 —— 部署目录就是 `/srv/pokergame`，所以是 `pokergame_`）。

⚠️ **卷丢了** ⇒ 容器每次重建都会**重新申请**证书 ⇒ 撞 Let's Encrypt 的「同一批域名每周最多 5 张」配额 ⇒ **一周内都签不出来**。**补救**：备份里**有这个卷**（每小时一份 `caddy-data-<ts>.tgz`，好坏见「备份还活着吗」）—— 照**「数据没了怎么办」那节**把它恢复回来（那节的命令带 `--restore-caddy`）。**从备份放回 = 不用重新申请**，不碰配额。仍然：**这个卷永远不要删**（`docker compose down -v` 会删卷 —— 上线后别带 `-v`）。卷在，就往下查：

```bash
$ ufw status                                     # 80 必须在放行里（ACME 的校验走 80）
$ ss -lntp | grep ':80\b'                        # 80 不能被别的程序占着
$ dig +short game.example.com                    # 必须回 VPS 的公网 IP
$ docker compose --env-file .env -f docker-compose.yml logs edge | grep -iE "acme|challenge|error" | tail -20
```

### 详注 ⑤ `.env` 漏配（fail-closed）

门口两种情况，`logs edge | tail` 里分别是（**本机实测原文**，退出码均为 1）：

```
# SITE_ADDRESS 为空
Error: adapting config using caddyfile: server block without any key is global configuration, and if used, it must be first

# TLS_MODE 为空（SITE_ADDRESS 给了）
Error: adapting config using caddyfile: parsing caddyfile tokens for 'tls': wrong argument count or unexpected line ending after 'tls', at /etc/caddy/Caddyfile:11
```

处置：补齐 `.env` 后重启门口（**先 export** —— 见本节开头 ⚠️）：

```bash
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>
$ docker compose --env-file .env -f docker-compose.yml up -d edge
```

**同类**（八个 Nest 服务反复重启 —— 监控片起，`prometheus` / `alertmanager` 缺同一变量**也**拒起、文案不同但处置相同）：`logs <服务名> | tail` 出现

```
INTERNAL_SERVICE_TOKEN is required (see docs/design.md §5.2 rule 3)
```

（本机实测原文，退出码 1）⇒ `.env` 少了内部口令 ⇒ 补齐后**先 `export`（同上一块）**，把服务名换成出问题的那个再 `up -d`。

### 详注 ⑥ 死映射边界（生产**不要**动 `EDGE_HTTPS_PORT`）

症状：域名 https 打不开，而「`https://IP:8443`」也不通。

根因（`docker-compose.yml` 的原样）：

```yaml
ports:
  - "${EDGE_HTTP_PORT:-80}:80" # 左侧（宿主）才跟变量走；容器内固定的 :80
  - "${EDGE_HTTPS_PORT:-443}:${EDGE_HTTPS_PORT:-443}" # ⚠️ 两侧同值 —— 只在默认值下才正确
```

而容器**真正监听**的端口由 `SITE_ADDRESS` 决定：生产里它是**域名（不带端口）** ⇒ 监听 443。
⇒ 如果你在生产给了 `EDGE_HTTPS_PORT=8443`，渲染出来是 `8443:8443` —— 宿主 8443 指向容器 8443，**那里没人监听**（映射是死的），而真正在监听的 443 反而没被映射。
（本机实测：生产渲染下设该变量 ⇒ 发布集合变成 `{80, 8443}`，`SITE_ADDRESS` 仍是无端口的域名。）

处置：生产**保持默认**（`.env` 里不要写 `EDGE_HTTPS_PORT`；自定义端口只属开发形态，因为只有开发形态的 `SITE_ADDRESS` 才带 `${EDGE_HTTPS_PORT}` 端口号）。

### 详注 ⑦ 服务起不来，且日志里没有「人话」

症状：`logs <服务名>` 里只有 `native`/`JS` 两段 stack，**没有**本项目自己的 JSON 日志行，也没有任何可读的报错。根因：Nest 的 `abortOnError` 默认会把 DI/元数据类崩溃的错误消息吞掉（只 `abort`）。
（注：`.env` 那一类**不会**这样 —— 上面详注 ⑤ 那种会正常打印，先按 ⑤ 排查。）

处置：用一段小钩子把 `abortOnError` 关掉再跑一次「只创建应用、不监听端口」的启动（以 `api-gateway` 为例；换服务名时把两处 `api-gateway` 与 `--workdir` 里的包目录一起换）：

```bash
$ docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
    --workdir /app/packages/api-gateway --entrypoint node api-gateway -e "
const core = require('@nestjs/core'); const orig = core.NestFactory.create.bind(core.NestFactory);
core.NestFactory.create = (...args) => { const p = orig(args[0], {abortOnError:false});
  p.then(()=>{console.log('CREATE OK');process.exit(0)}).catch(e=>{console.log('DI FAIL:', e && e.message);process.exit(1)}); return p; };
require('./dist/main.js');"
```

**预期**：正常的服务打印 `CREATE OK`（本机实测：前面若干行 NDJSON 模块日志 + `CREATE OK`，退出码 0）；有问题的打印 `DI FAIL: <真正的错误消息>`（退出码 1）。
（`run --rm` 是**一次性前台**运行，不占端口、不覆盖正在跑的容器，可以放心跑。）
⚠️ **在服务器上跑之前先 `export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前 tag>`** —— 不加这两个变量，compose 会去找默认镜像名 `pokergame-*:latest`（服务器上没有这个名字）。

### 详注 ⑧ 构建卡住 / 失败（**开发机 / CI**）· 服务器上对应的是「`pull` 拉不动」

⚠️ **服务器不构建**（见 ⑦）—— 在服务器上会「卡住 / 失败」的是 **`pull`**：在 `/srv/pokergame/` 里跑下面两条，看它卡在哪一步 / 报什么错（**先 export** —— 不 export 会先死在 `pull access denied` 上，反倒看不到真正的网络报错；多半是到镜像库（GHCR）的网络不通）：

```bash
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>   # 见本节开头 ⚠️
$ docker compose --env-file .env -f docker-compose.yml pull
```

下面这条留给**开发机 / CI**（那里才构建）：先看 base 镜像在不在本地（所有服务镜像都从 `node:20-slim` 开始）：

```bash
$ docker images | grep node
```

不在 ⇒ 先 `docker pull node:20-slim` 再构建（实测教训：base 镜像不在本地时，构建会去某个镜像源取 token，症状看起来像「网络故障」，其实一拉就通）。在，再怀疑网络/镜像源（Docker 拉镜像走的是 daemon 的网络，不是你 shell 的代理设置）。

### 详注 ⑨ 升级后门口起不来（`/data` 卷属主迁移 —— **升级前部署过的机器做一次**）

背景：门口从「以 root 运行」改为「以 `caddy` 用户运行」（安全扫描整改，trivy DS-0002；2026-10 起这批发布生效）。机器上**已经存在**的 `pokergame_caddy-data` 卷是历史 root 属主（证书等文件权限是 `0600 root`），新的非 root 门口**读不到**它 ⇒ 门口起不来（`ps` 里 `ftl-edge` `Restarting (1)`，`logs edge` 尾部是 `permission denied` 类错误 —— 本机 internal-TLS 形态实测原文：`… loading pki: provisioning CA 'local': loading root cert: open /data/caddy/pki/authorities/local/root.crt: permission denied`；生产 ACME 形态会是同类的另一个文件路径，处置同此）。

一次性迁移（在服务器的 `/srv/pokergame/` 里跑；**先 export** —— 同 详注 ⑦⑧ 的理由）：

```bash
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>
$ docker run --rm --user root --entrypoint chown \
    -v pokergame_caddy-data:/data "${IMAGE_PREFIX}-edge:${IMAGE_TAG}" -R caddy:caddy /data
$ docker compose --env-file .env -f docker-compose.yml up -d edge
```

⚠️ 三点说明：① 用**裸 `docker run`**、**不要**换成 `docker compose run` —— 门口在 compose 里钉了固定 IP `172.28.0.250`，只要常驻的 `ftl-edge` 还在（哪怕正在重启循环里），`compose run` 起的临时容器会撞同一个 IP、**连创建都失败**（`failed to set up container networking: Address already in use`，本机实测复现）。② `pokergame_caddy-data` 是卷的**固定全名**（compose 项目名已钉死为 `pokergame`，与检出目录无关）。③ 只对**升级前就部署过门口**的机器需要（`docker volume ls` 里有 `pokergame_caddy-data` 才需要；全新机器不用 —— 新卷按镜像里的新属主初始化）。迁移只改属主、**不动证书内容** ⇒ 不用重新申请证书、不碰 Let's Encrypt 配额。⚠️ **未迁移窗口内的后果**（知道就好、别慌）：门口起不来（Caddy 非 root 后写不了旧属主的 `/data`）；每小时的自动备份会在 caddy 证书打包（caddy-tar）那一步失败 —— **迁移一做完两者即恢复**，期间业务数据不受影响。

### 详注 ⑩ 监控的 Grafana 起不来（`.env` 少 `GRAFANA_ADMIN_PASSWORD` —— **升级到带监控的版本前做一次**）

背景：监控片（2026-10-03 起）给栈加了 6 个监控容器，其中 **Grafana 看板是 fail-closed 的**：`.env` 里没有 `GRAFANA_ADMIN_PASSWORD` 它就**拒绝启动**（宁可起不来，也不要一个「无口令的看板」挂在公网面 `/grafana/` 后面）。

**升级前要做的一次动作**：在**第一次部署带监控的版本之前**，先在服务器 `/srv/pokergame/.env` 里加上一行：

```bash
$ nano /srv/pokergame/.env
# 加这一行（口令自己定一个强的 —— 示例值只是占位）：
GRAFANA_ADMIN_PASSWORD=<你的强口令>
```

（这一步与 ⑨ 的 `/data` 属主迁移同类：**升级前部署过的机器做一次**。写不写它**不影响玩家**：不写 ⇒ 监控的看板起不来、容器反复重启；站其余部分照常。忘了做就发布了也不会出大事 —— 补上这行、再走一次部署即可恢复。）

症状（忘了写就发布了）：`... ps` 里 `ftl-grafana` 是 `Restarting (2)`，`... logs grafana | tail` 出现：

```
/etc/grafana/entrypoint.sh: line 13: GF_SECURITY_ADMIN_PASSWORD: GRAFANA_ADMIN_PASSWORD required（compose 经 GF_SECURITY_ADMIN_PASSWORD 传入，空串也算未设）
```

（本机实测原文，退出码 2 —— 与门口 `.env` 漏配同族的 fail-closed。）

处置（补上那行之后 —— **先 export**，见本节开头 ⚠️）：

```bash
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>
$ docker compose --env-file .env -f docker-compose.yml up -d grafana
```

---

## ⑦ 代码怎么上去（**部署由流水线完成**）

> 片① 这里原是一条**临时手工路径**（在服务器上 clone 仓库、构建镜像）。片② 已把它替换：
> **服务器上没有仓库、没有源码、不构建**。上面 ①–⑥ 的「起栈」在第一次上线时仍然照跑（那是预备），
> 之后**每一次发布都不再登录服务器**。

### 7.0 发版之前：两项前置（**第一次尤其要看**）

**为什么**：`deploy` 这一步要连上你的服务器、还要访问真域名 —— 这两样信息都不在代码里。
再有一个容易误会的地方：`conformance` 要拿「每个测试切片该跑够多少条」的清单去比 —— 那份清单（`tools/conformance/baselines.json`）**已经在仓库里**（2026-09-25 按首次全绿运行回填）⇒ **正常情况下这一步直接就是绿的、什么也不用填**；它**只在切片被增删**（或某片条数掉到下限以下）时才会红 —— 那是它在**等你把新数字填回来**（详见 ②），不是故障。

**① 仓库侧四样设置**（在 GitHub 的仓库里配一次：「Settings → Secrets and variables → Actions」）：三个 **Secret** —— `SSH_HOST`（服务器 IP）、`SSH_USER`（填 `ubuntu`）、`SSH_KEY`（〇① 那把部署私钥的**内容**，整段贴进去）；一个 **Variable** —— `SITE_URL`（`https://你的域名`）。**漏配的后果四样各不相同**（⚠️ 只有 `SSH_HOST` 与 `SITE_URL` 会在日志里明写「缺 …」）：

| 键         | 类型         | 漏了会怎样（`deploy` 的日志里会看到什么）                                                                                                                                                                                                                                          |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSH_HOST` | Secret       | `deploy` 那一步**当场失败**，明写「缺 `SSH_HOST`」                                                                                                                                                                                                                                 |
| `SSH_USER` | Secret       | **没有影响 —— 这一样可缺**：脚本自带默认值 `ubuntu`（〇① 备好的正是它的钥匙）；只有「要用别的账号登录服务器」时才必须填                                                                                                                                                            |
| `SSH_KEY`  | Secret       | 一样**连不上**服务器，但日志里**不会**出现「缺 `SSH_KEY`」这句话（脚本只检查密钥的**路径**，而那个路径永远都在）：流水线拿到一把**空密钥**就去登录 ⇒ 看到的是 ssh 报「这把钥匙读不出来」（`Load key …: invalid format` 或 `error in libcrypto`）＋ `Permission denied (publickey)` |
| `SITE_URL` | **Variable** | **还没碰到服务器**就失败（在送文件之前），明写「缺 `SITE_URL`」                                                                                                                                                                                                                    |

**② 第一次的顺序：先 push 一次 `master` 看结果、需要时把数字填回来，然后才打 tag**（**别**跳过这一次 push 直接打 tag）。⚠️ **基线已随仓库带来 ⇒ 这一步通常直接绿**（结尾一行 `=== [baseline] full 全部 ≥ 下限（22 个切片）===`）：什么也不用填。**只有你增删过切片**（或某片条数掉到下限以下）时它才会红 —— 红行的**上文**就逐片打印着实际条数（形如 `[baseline] full <切片名> = 数字`），把新数字按下面三行填回来即可。

```bash
$ git push origin master     # 先推一次（**不要**打 tag）；看那一次 conformance 的结果
# ⚠️ 通常到此为止：绿了就直接打 tag。只有红行上文需要回填时，才走下面三行：
# 把每个 [baseline] full <切片名> = N 填进仓库文件 tools/conformance/baselines.json 的 "full" 段，然后：
$ git add tools/conformance/baselines.json && git commit -m "回填 conformance full 基线" && git push origin master
$ git tag v1.0.0 && git push origin v1.0.0     # 这一回才会真的部署（见 7.1）
```

**预期**：push `master` 那一次 ⇒ `ci`、`render-gate`、`security-scan`、`images` 绿，**`conformance` 绿**（基线已回填，正常无需任何填写；结尾一行 `=== [baseline] full 全部 ≥ 下限（22 个切片）===`）。**若你这次增删过切片（或某片条数掉到下限以下）**，`conformance` 会红并明写原因（红行的形态：新加的切片 ⇒ `切片 <切片名> 的基线**未回填**（full 列）`；删掉的切片 ⇒ `切片 <切片名> 在日志里**缺席**（基线列了它）`；条数掉了 ⇒ `切片 <切片名>：实测 N < 基线 M（判据只增不减）` —— 这三句都是 `scripts/check-baselines.mjs` 逐字打印的）—— 那是**等你填数字**，照上文回填、再 push 一次 ⇒ 全绿。⚠️ 「绿」的前提是那一次**每个切片都通过**了：数字行只属于**通过**的切片 —— 哪一片自己**失败**了，它就不留数字、只留一行 `❌ <切片名> 失败` ⇒ **没有数字可填**：那是**真故障**（不是「等你回填」），照它上面第一条报错先把它修到通过；**已经拿到数字的切片照常填**，这一片修好后拿到数字再补进去。**若你动过切片**却跳过回填直接打 tag：`release` 里 `images` 绿、`conformance` 红、`deploy` **被跳过**（上游红了就不部署 —— **故意的**）⇒ 那一次**看不到** `✅ [deploy] … 部署完成`。这不是流水线坏了，是那份清单缺了新数字。

**不一样怎么办**：`deploy` 报「缺 `SSH_HOST`」或「缺 `SITE_URL`」⇒ ① 没配全（注意 `SITE_URL` 是 **Variable**，别塞进 Secret）；报 `Load key …: invalid format`（或 `error in libcrypto`）＋ `Permission denied (publickey)` ⇒ 那是 `SSH_KEY`（**内容**）没贴或贴错 —— 日志里**不会**写「缺 `SSH_KEY`」；也可能是 〇① 那半边的公钥没装对。两处各对照一遍（重贴**私钥**整段、别被编辑器折行）。这两种情况补上后都**换一个新版本号**重新打 tag。`conformance` 红了、但日志里**一行** `[baseline] full …` 都**没有** ⇒ 那不是「未回填」而是真故障 —— 看它第一个 ❌（多半是构建或起栈）。

### 7.1 平时怎么发版（一条命令）

在**你自己机器**的**项目根目录**（日常开发用的那个 Git 仓库 —— **不是**服务器）里跑：

```bash
$ git tag v1.0.0        # 版本号；再次发版时换一个没用过的（如 v1.0.1）
$ git push origin v1.0.0
```

⚠️ 报 `fatal: tag 'v1.0.0' already exists` ⇒ 这个版本号用过了（tag 是「这次发布指向哪次提交」的书签、不能重名）⇒ 换个新号（`v1.0.1`）重跑这两条。

**然后什么都不用做** —— GitHub Actions 会自动按顺序做三件事（`release` 工作流）：

| 顺序 | job           | 做什么                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `images`      | 把 14 个镜像构建好、推到镜像库（GHCR），打上 `v1.0.0` 与 `sha-<短>` 两个标签                                                                                                                                                                                                                                                                          |
| 2    | `conformance` | 拉起一台一次性 Linux 机器，用**刚推上去的那套镜像**跑全部端到端切片                                                                                                                                                                                                                                                                                   |
| 3    | `deploy`      | 核对 tag 指向的提交在 `master` 上（R1308）→ **装备份**（投递 3 个 ops 脚本 + 核对/安装定时任务）→ 把 `docker-compose.yml` 送到服务器 → `pull` 新镜像 → `up -d` → 冒烟三条 → **首次备份**（仅当还没有 `ok:true` 的 manifest；排在部署**之后**，否则首次发布会死锁）→ **收尾断言**（服务器上没留下镜像库凭据）→ **备份新鲜度**（本 job 的**最后一步**） |

**顺序是串行的**（job 2 等 job 1、job 3 等 job 2）—— 这是**故意**的：并行的话部署可能抢在镜像推上去之前开始，会拉不到镜像。

**要盯着什么**：`https://github.com/Howebai/fight-the-landlord/actions` 上那个 `release` 运行，三个 job 全绿就算发布成功。⚠️ 这个「绿」比「部署这一步绿」**更强** —— `deploy` job 里除部署本身外还有 5 步（见上表第 3 行）：**装备份 / 首次备份 / 备份新鲜度**这三步管的是「ops 脚本与定时任务在不在位、备份链还活着吗」，与本次发布的站**无关** ⇒ 它们红了**站也是好的、别回滚**（后两步的文案自己就写着这句；「装备份」那一步红出来的是原始的 `scp`/`ssh` 报错，含义同上：脚本没送到 / 定时任务没装上）；另两步是「tag 必须指向 master」的核对与「服务器上没留下镜像库凭据」的收尾断言。`deploy` 那一步的输出里应当能看到：

```
✅ [deploy] tag=v1.0.0 部署完成
```

**停机多久**：`pull` + `up -d` 只重建**变化的**容器 ⇒ **秒级**。这一个可接受的代价换来了「不需要蓝绿/双机」。

### 7.2 只跑流水线、不部署（改完想看结果）

feature 分支上 push ⇒ 只跑 `ci`（六阶段）+ `render-gate`（纯渲染判据）+ `security-scan`（三路安全扫描）。
push 到 `master` ⇒ 额外跑 `images` 与 `conformance`（**22 个切片**跑在一台一次性 Ubuntu 上：21 个跑真栈 + 1 个「流水线清点」，后者不需要栈）。
⇒ **想验证一个改动，推 master 就够，不用打 tag。**

### 7.3 磁盘卫生（服务器侧 —— **流水线每次发布自动做**）

**这一节只解释、不用你动手**：每次发布的最后（`up -d` 与冒烟之后），流水线会在服务器上自动跑一次 `docker image prune -f`（见 ⑦7.1 的 `deploy` job）。它长这样：

```bash
$ docker image prune -f        # 流水线代跑；下面是输出形态（本机实测样例）
Deleted Images:
untagged: sha256:13aaabe062ce…
deleted: sha256:13aaabe062ce…
…
Total reclaimed space: 1.734GB
```

**为什么**：每次发布都要把 14 个新镜像拉到服务器（≈10.1GB 一版），旧的层不会自动消失。盘一满，**MySQL 会先被拖死**（写不进去即崩，症状看起来像「数据库莫名挂了」）。`docker image prune -f` 删的是**悬空镜像**（没有 tag、也没有容器在用它们的那些层）—— 管的是「能自动回收的那部分」（手动跑一次的话：结尾一行 `Total reclaimed space: …`，是 `0B` 也正常）。

🔴 **红线：只许 `-f`，绝不用 `-af`**：`-f` 只删悬空镜像，正在跑的容器与带 tag 的镜像**都不受影响**；而 `-af` 会把**上一个 tag 的镜像**一并删掉 —— 那会把「秒级回滚」变成一次几 GB 的网络拉取。

⚠️ **已知设计点（不是待办）**：`-f` **不会**动**带 tag 的旧版本镜像**（每版 14 个 ≈10.1GB）—— 它们是被**有意留下**的：⑧ 的「秒级回滚」就靠它们还在服务器上（这也正是 `-af` 是红线的原因）。所以磁盘占用会随发布次数增长；真到盘吃紧，那是「该扩盘了」的信号，**不是**去清这些镜像。

### 7.4 凭据轮换（**部署私钥** —— 出事时才做）

**什么时候**：`SSH_KEY` 可能泄露时（误贴进聊天、误提交、经手人变更）。**没有固定周期** —— 这是一条「出事时能用」的规程，不是日历任务。
⚠️ **只有这半边要轮换**：R1311 还提到「GHCR 令牌」—— **本形态不适用**：流水线拉镜像用的是 GitHub 内建的 `GITHUB_TOKEN`（每次运行临时签发、跑完即废）⇒ 镜像库里**没有**长期令牌可轮换。

**顺序**（先**加**新钥匙、后**删**旧钥匙 —— 中间任何一步失败都还有旧钥匙可用）：

```bash
$ ssh-keygen -t ed25519 -f ~/.ssh/ftl_deploy_new -C ftl-deploy -N ''   # ① 生成新的一对（公钥 = .pub）
$ ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器 IP> "cat >> /home/ubuntu/.ssh/authorized_keys" < ~/.ssh/ftl_deploy_new.pub   # ② 追加新公钥（**追加**、不是替换）
$ gh secret set SSH_KEY < ~/.ssh/ftl_deploy_new                        # ③ 仓库 Secret 换成新私钥
$ git tag v1.0.2 && git push origin v1.0.2                             # ④ 验证：这一次 deploy 绿 ⇒ 新钥匙在流水线里可用
$ sudo nano /home/ubuntu/.ssh/authorized_keys                          # ⑤ 服务器上删掉**旧的**那一行
```

**预期**：④ 的 `deploy` 绿（版本号换一个没用过的）；⑤ 之后**旧私钥立即失效**（用旧钥匙 ssh ⇒ `Permission denied (publickey)`）。
**不一样怎么办**：④ 红且报 `Load key …` / `Permission denied (publickey)` ⇒ 是 ② 没追加成功或 ③ 贴错了（对照 7.0 ① 的 `SSH_KEY` 行）；**旧钥匙此刻仍然有效**，修好重做 ③④ 即可（tag 再换一个新号）。⑤ 之前务必确认 ④ 已经绿 —— 顺序反过来会把自己锁在门外。

### 7.5 兼容窗口（**叫抢规则这一版起，发版前后各看一眼**）

**为什么**：这一版改了「一局对局的叫抢数据长什么样」（会话里新增两个字段；下发给客户端的叫抢决策序列上限从 3 条变 4 条）。
它会从三个方向出问题：**服务器上的在途对局**（旧数据）、**浏览器的旧标签页 / 手机上的旧 App 包**（旧客户端）、
**跨版本混跑的网关**。① 要你在**发版前**动一次手（只这一版要）；② ③ 知道就行。

**① 发版前（在服务器上）：清掉在途对局会话**

```bash
$ cd /srv/pokergame      # 前置①：必须在 compose 工程目录下跑（下面这行本身没有 cd）
$ docker compose exec -T redis redis-cli --scan --pattern 'game:session:*' \
    | xargs -r docker compose exec -T redis redis-cli del
```

前置（缺一不可）：① 就是上面这行 `cd`（compose 工程目录）；② `redis` 容器在跑（`docker compose ps` 里是 `Up`）；③ `xargs -r` 是 **GNU 扩展** —— 本手册的目标机是 Ubuntu，满足；若在 BSD/macOS 一类环境跑会报 `illegal option`，那时把管道后半段换成
`| while read -r k; do docker compose exec -T redis redis-cli del "$k"; done`。

**什么时候清、会打断什么**：**尽量贴近发版时刻**（清完就去打 tag）。⚠️ 这会**中断**当时正在进行的对局（那些房里的人会掉线、需要重新开局）。而且清键是**主路径**、不是「绝对清空」：清完还没结束的房，下一次动作会把会话**重新写回去**（旧版进程自己的内存缓存）—— 这些漏网的会由新版上线后的一次性自愈迁移接住，所以**不用**反复清。

**预期**：输出是一行或多行**数字**（每行 = 该批删掉的键数）；若一个在途对局都没有 ⇒ **完全没有输出**。两者都算成功。

**不一样怎么办**：报 `no such service: redis` ⇒ 不在 compose 工程目录（回前置①）；报 `illegal option` ⇒ 见前置③。

🔴 **如实声明**：这条管道在设计规格里**未实跑**（当时只做了三项只读核对：键名 `game:session:*`、compose 服务名 `redis`、`docker compose exec -T redis redis-cli` 的既有用法）。第一次真跑的那天请把实际输出回报；若与「预期」不符，以实际为准。

**② 十四个镜像必须同 tag —— 流水线已结构性保证，别手工破坏它**

**事实**：每次打 tag，流水线**一次**构建 14 个自建镜像（user / config / currency / payment / room / game / robot / douzero / api-gateway / edge / prometheus / grafana / alertmanager / alert-relay），全部打上**同一个版本号**；部署时服务器一次拉齐 ⇒ 14 个自建服务天然同版本。**你什么都不用做。**

**别做的三件「手工活」**：不要单独 `docker compose pull` 某一个服务；不要把两个 tag 的镜像混着 `up -d`；更不要只换网关或只换 game-service。**为什么**：新版的服务端会下发「一条叫抢序列最多 4 条」的数据，而**旧版网关**对每一条下发给客户端的消息都做检查、不认识就**静默丢掉**（只在服务器日志留痕）⇒ 房间表现与 ③ 的旧客户端**一模一样：卡在上一屏、不报错**。流水线的原子切换里这个窗口**不存在**，手工操作可以把它造出来。

**③ 发版后：旧标签页 / 旧 App 的窗口期（发一句告示就好）**

**谁受影响**：发版那一刻**已经开着**的浏览器标签页（网页是构建时打进门口镜像的，**刷新一次**就得到新版），以及手机上装着**旧 App 包**的人（需装新包）。他们在**有反抢的对局**里会：收到的快照检验不过 ⇒ **卡在上一屏、不报错**，连「重连」也一并被拒（没有反抢的局照常玩）。

**为什么消不掉**：本仓的网页与后端是**同一个 tag 一起切换**的（网页在构建时打进门口镜像）—— 流水线里没有「先发网页、后发后端」这个档位 ⇒ 这个窗口不可能靠顺序消除，只能靠**知会玩家**缩小。

**要你做的**：发版前后在能通知到玩家的地方（群公告等）发一句 —— **「游戏更新：浏览器请刷新页面、手机端请更新 App」**。刷新 / 更新后即刻恢复正常。

---

## ⑧ 回滚（**秒级**）

**什么时候用**：刚发布完发现坏了（页面打不开、登录不上、对局起不来）。

**第一步：找到上一个 tag**（在**你自己机器**的项目根目录跑；用过别的机器打 tag 的话先 `git fetch --tags` 拉齐）

```bash
$ git tag --sort=-creatordate | head -5
v1.0.2
v1.0.1
v1.0.0
```

从上往下是**从新到旧** ⇒ 上一个就是**第二个**（`v1.0.1`）。

**第二步：在 GitHub 上点**（**回滚就这一步** —— 不用登录服务器，也不用在你机器上装或配任何东西）

`https://github.com/Howebai/fight-the-landlord/actions/workflows/release.yml` → 右上角 **Run workflow** → 分支选 `master`，`image_tag` 填 `v1.0.1` → **Run workflow**。

**预期**：只跑 `deploy` 一个 job（`images` 与 `conformance` 会被跳过 —— 那正是「秒级」的来源），结尾 `✅ [deploy] tag=v1.0.1 部署完成`。

（部署失败的日志里另有一条 `bash scripts/deploy/rollback.sh …` 的提示 —— 那是给**已在本机配好凭据文件**（仓库根的 `.env.deploy.local`，含 `SSH_HOST` / `SSH_KEY` / `SITE_URL` / `GHCR_PULL_TOKEN` / `GHCR_USER`）的维护者用的；本手册不涉及那份配置 ⇒ **照上面的「在 GitHub 上点」做**。）

**回滚做了什么**：和发布**完全一样**的路径，只是把 tag 换成旧的那个 —— 代码不动、不构建，只 `pull` 旧 tag 的镜像再 `up -d`。

⚠️ **前提**：那个 tag 的镜像**还在**镜像库上。这就是服务器侧**只许 `docker image prune -f`** 的原因（`-af` 会把它删掉）。

⚠️ **另一个前提**：**tag 只打在 `master` 上**。打在 feature 分支上的 tag 会指向一个没跑过真栈 conformance 的提交 —— 回滚到一个同样坏（或者更坏）的版本上。

**回滚也失败怎么办**：说明问题不在这一版代码（网络、DNS、证书、磁盘满）。按 ⑥ 排错表逐项查。

### 回滚注意（**片⑦「配置中心」起**）

- **回滚 = 全量换 tag**：`image_tag` 一填，**全部镜像 + 编排文件**一起换成那个版本的 —— 本手册的「秒级回滚」入口**没有**「按服务单独回退」这种用法。🔴 **不要手工混部**（把两个 tag 的镜像混着 `up -d`、或只换网关）—— 那会造出「新旧混跑」的坏形态（旧服务 + 新编排）。
- **跨配置中心边界也能回**（v1.3.0 ⇄ v1.2.x 都行）：部署工具（`deploy.sh`）现在从**目标 tag 自己**取出 `docker-compose.yml` 送机（取不到 ⇒ **响亮失败**、不会悄悄用别的版本）⇒ 回滚到还没有配置中心的旧版本时，服务器自动用旧版编排。
- **孤儿容器 = 无害**：从带配置中心的版本（v1.3.0 起）回滚到更早的版本（如 v1.2.0）时，旧编排里**没有** config-service ⇒ 那个容器**不被触碰、留作孤儿继续跑**（没有任何流量接给它，无害）。再次前进到新版时它会被**自动复用** ⇒ **别手工删它**。
- **ops 脚本仍从本检出送**（**刻意偏离**：早于片③-B 的旧 tag v1.0.0 / v1.0.1 里根本没有 `scripts/ops/` 文件）：脚本是版本无关的运维工具，随最新代码送机是正确选择。「全量换 tag」的口径限定为「**镜像 + 编排文件**」。
- **第一次跨边界回滚**（验收项）：v1.3.0 → v1.2.0 → v1.3.0 各做一次，两次 `deploy` 日志 + 线上 `/api/health` 即为证据。

---

## 怎么改配置（后台管理页）

> 片⑦ 起，**运行期可调**的参数（好友房开关 / 底分档位 / 机器人比例与开关 / 四个周期常量）在**配置中心**里改 —— **不用**登服务器、**不用**重新发版。

**打开**：浏览器访问 `https://<你的域名>/admin`（管理页由门口托管，和玩家 H5 完全分开）。

**登录（③ 起 = 账号 + 角色）**：输**用户名 + 口令**（不再是一个口令）。

- **口令从哪来**：**②2.2 表里的 `ADMIN_PASSWORD`** —— 部署**首启**时服务端用它**自动创建引导账号** `admin`（超级管理员）。这个键**只作首启引导**：账号建好后它就不管登录了，日常**不要动它**（要改的是账号口令，见下）。
- ⚠️ **从旧版本升级上来的机器**（以及从**早于本版的备份**恢复出来的库）：管理员表从零开始 ⇒ 升级/恢复后**第一次启动**会用 `.env` 里现成的 `ADMIN_PASSWORD` 把 `admin` 号建出来（日志会打印 `admin bootstrap: created super_admin 'admin' from ADMIN_PASSWORD`）⇒ **用你原来那个口令**登录即可。
- ⚠️ **一个管理员账号都没有 ⇒ 管理面是「整体关闭」的**（页面提示「管理面未启用」、登录接口回 404 —— 那是**设计内的关闭态**，不是故障）⇒ 用下面的 **hatch** 建号（**不用**改 `.env`、**不用**重新部署）。
- 同一来源连续输错 5 次 ⇒ **锁 5 分钟**（防猜测）。

**四个角色**（建号时选；超管可改）：

| 角色                     | 能看到 / 能做                                                               |
| ------------------------ | --------------------------------------------------------------------------- |
| 超级管理员 `super_admin` | 全部：账号 + 配置 + 钱包 + 财务 + **风控** + 审计                           |
| 财务 `finance`           | 钱包调整 / 冲正 / 对账 + 财务 + 审计（**不含风控** —— 风控是超管/运营的活） |
| 运营 `operator`          | 改配置 + **风控** + 财务 + 审计                                             |
| 只读 `viewer`            | 财务 + 审计（**只能看**；**不含风控**）                                     |

⚠️ 左侧导航按角色显隐**只是界面效果**；真正的门在服务端（角色不够 ⇒ 403）。

**建号 / 改角色 / 停用 / 重置口令**：用**超级管理员**登录 → 左侧「账号」页 → 建号表单（用户名 + 口令 + 角色）；已有账号那一行可改角色、停用/启用、重置口令。两条服务端硬规则：**不能停用或改自己的角色**、**不能停用/降级最后一名超级管理员**（防把自己锁在门外）。用户名规则：3–32 位，小写字母 / 数字 / `._-`。

**忘记口令 / 想新建管理员 ⇒ hatch 复位**（在服务器上跑一条命令；`<账号名>` 换成要复位/新建的名字，常用 `admin`）：

```bash
$ cd /srv/pokergame
$ docker compose --env-file .env -f docker-compose.yml exec config-service \
    node packages/config-service/dist/admin-reset.js <账号名>
```

- **预期输出恰好两行**：`reset <账号名>: ok` + `new password: <一串新口令>`（**只有这一档会把口令打出来**；记下它、登录后立刻在「账号」页改掉）。
- 账号**不存在** ⇒ 直接**新建**（默认角色超级管理员；加 `--role finance` 等换角色）；想自己定口令加 `--password '<口令>'`（**不会回显**）。
- 复位会把账号**强制改回启用**（忘了口令又碰上被停用，这一步一并解决）。
- ⚠️ **本机开发 / 联调同理**：栈的 MySQL 卷是长期复用的，`ADMIN_PASSWORD` 只在该卷**第一次**起栈时生效；卷里已有账号而口令对不上 ⇒ **用同一条 hatch 命令复位**（容器名照你本机的栈），**不要**为了换口令去删卷。

**怎么改**：登录 → 左侧点一条配置 → 改值 → 保存。保存成功后页面显示：

```
已保存（版本 N）；各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效）
```

- 「**≤60s 内读到新值**」是**上界**：正常情况下各服务在**几秒内**就用上新值（写库后会发一条推送）；推送万一丢失还有**每 60 秒**一次的兜底重拉 ⇒ 最晚不超过 60 秒。
- 若显示「**推送失败，安全网将在 ≤60s 内拉到新值（节奏类键自下一轮排期起生效）**」：值**已经存下**、也会生效，只是走了兜底那条慢路 —— **不用**重试、不用管它。
- **节奏/清理旋钮（下表末六行）怎么调**：在管理页改，**下一轮排期即生效**（已排定的一轮不撤 —— 秒级节奏最坏等一个旧间隔）；**无需重启**任何服务。
- 玩家端在进大厅时拿到新值（H5 刷新一次页面最快拿到）；**已在途的好友房不受影响**（切换前的房间可以正常打完）。

**上线第一个动作（重要）**：**好友房默认是关闭的**（玩家端不显示「好友房」入口，服务端也拒绝创建/加入）。
**要开放好友房 ⇒ 上线后第一件事就是来这里把它打开**：找到 `game.doudizhu.friendRoomEnabled`，把值改成 `true` 保存；想再关掉同理。

**101 键配置（85 active + 16 只读旧键）一览**（键名 → 玩家会看到什么）：

> 2026-10-24 配置平行化：斗地主与跑得快各有一套场次/好友房/补位/金币经济键。下表列斗地主与平台级键；跑得快对应键见 `docs/games/paodekuai.md` §7.1。旧平台键（`room.*` / `currency.entryMultiplier` / `currency.rakePercent` 等）只读保留，回滚前按 runbook 回填。

| 键 | 做什么 | 默认 |
|---|---|---|
| `game.doudizhu.friendRoomEnabled` | **好友房开关**：关 ⇒ 玩家端不显示入口、创建/加入被拒（提示「好友房暂未开放」）、房间列表返回空 | **关** |
| `game.levels.doudizhu` | 底分档位表（大厅的底分卡；单档 baseScore ≤ 8191；**第三列 `entryFeePercent` = 台费 0–100%（100 = 入场费等于底分）**；省略底分时取表内最低档）。⚠️ 机器人资金水位要求 `max(档位) × entryMultiplier ≥ 15` | 15 / 80 / 480 / 1200（台费全 0） |
| `game.doudizhu.robot.skillDistribution` | 三档机器人（弱 / 中 / 高）的出现比例 | 0.15 / 0.35 / 0.5 |
| `game.doudizhu.robot.ruleFallback` | DouZero 不可用时**匹配还补不补机器人**（关 ⇒ 玩家等满 30s 收到「当前无匹配的玩家」） | 开 |
| `game.doudizhu.robot.modelBySkill` | 三档难度各用哪个 DouZero 模型 | sl / douzero_WP / douzero_ADP |
| `robot.reclaimIntervalMs` · `room.matchScanIntervalMs` · `room.autostartIntervalMs` · `room.reapIntervalMs` | 四个后台周期常量（机器人回收 / 匹配扫描 / 自动开局 / 房间回收），单位毫秒 | 60000 / 5000 / 5000 / 60000 |
| `record.retentionDays` | **对局记录保留天数**（1–3650）：超过这么多天的对局会从玩家的「历史战绩」里清掉（**库里也删**；备份里仍有） | 365 |
| `currency.signupGrant` | **注册赠送金币**：新玩家注册时自动到账的金币数（0 = 不赠送；到账后玩家可在大厅顶栏余额与钱包页看到；改动只影响之后注册的新用户） | 0 |
| `game.doudizhu.freeRoomEnabled` | **免费场开关**：关 ⇒ 玩家端不显示免费场入口、匹配被拒（提示「该场次暂未开放」） | **开**（保持现状） |
| `game.doudizhu.goldRoomEnabled` | **金币场开关**：关 ⇒ 玩家端不显示金币场入口、匹配被拒（同提示）。**开放金币场前，先把机器人虚拟池种上**（见「虚拟池：种子与充值」一节） | **开**（2026-10-04 用户裁决由默认关翻为默认开） |
| `game.doudizhu.freeBotFillEnabled` | **免费场缺人补机器人开关**：**开** ⇒ 匹配缺人时等 30s 后补机器人开局（现状）；**关** ⇒ 绝不补机器人，缺人时弹「重新匹配 / 继续等待」提示，凑齐 3 真人才开局。好友房不受本键影响（缺人仍补机器人） | **开**（保持现状） |
| `game.doudizhu.goldBotFillEnabled` | **金币场缺人补机器人开关**：同上，管金币场。关 ⇒ 真人不足时金币局开不起来（玩家持续等待或到上限超时），请结合在线高峰评估 | **开**（保持现状） |
| `room.matchNoBotMaxWaitMs` | **无机器人匹配等待上限**（毫秒，30000–1800000）：仅在上面两个补位开关**关闭**时有效 —— 真人间匹配到点仍未凑齐 3 人 ⇒ 判超时（`12007`），玩家出队并提示「匹配超时」。玩家点「继续等待」只平移提示窗口、**不重置**本上限 | 300000（5 分钟） |
| `game.doudizhu.entryMultiplier` | **斗地主金币场门槛倍率**：入队要求余额 ≥ 所选底分 × 本值（大厅的门槛提示随它变）；也影响机器人携带额度的水位。救助门槛已改为 `currency.reliefThresholdCoins` | 10 |
| `game.doudizhu.rakePercent` | **抽水百分比**：每局从赢家所得里按此比例扣一笔销毁（>0 ⇒ 玩家赢面变小） | 0 |
| `currency.reliefEnabled` | **每日救助开关**：关 ⇒ 玩家端不显示「领取救助」入口、领取被拒（提示「救助暂未开放」） | **关** |
| `currency.reliefAmount` | **每日救助金额**：可领玩家每次领到的金币数（建议 ≥ `currency.reliefThresholdCoins`，否则领完回不了桌） | 200 |
| `currency.reliefThresholdCoins` | **每日救助门槛**（平台级绝对金币数）：余额低于它才能领取；不随玩法档位/倍率变化。缺失/坏值 ⇒ 救助端点 fail-closed | 150 |
| `risk.predicate.sameDevice` | **同设备谓词**：开启后同一台设备上的两个账号**不会被配进同一桌**（防一人多号串通；拒绝的对回队重试，玩家侧无感知）。**默认关**；开启手顺见本节末「风控谓词怎么开启」 | **关** |
| `risk.predicate.sameIp` | **同 IP 谓词**：同上，按公网 IP 判 —— ⚠️ 公司 / 学校 / 网吧共用出口 IP 会互相拒配（**误伤面大**），评估过再开 | **关** |
| `game.doudizhu.risk.winRateThreshold` | **胜率检测阈值**（0.5–1.0）：对局数超过下面那个门槛后，胜率**高于**此值的账号进风控审核队列 | 0.8 |
| `game.doudizhu.risk.minGames` | **胜率检测的最少局数**：对局数**超过**这个数才参与胜率判定（防小样本误报） | 100 |
| `game.paodekuai.risk.winRateThreshold` | **跑得快胜率检测阈值（回退键）**：仅当对应人数键缺失时生效；与斗地主阈值独立；两个玩法同时命中只记一项胜率分 | 0.8 |
| `game.paodekuai.risk.minGames` | **跑得快胜率检测的最少局数（回退键）**：仅当对应人数键缺失时生效 | 100 |
| `game.paodekuai.risk.player2.winRateThreshold` | **2 人跑得快胜率阈值**（2 人基准约 50%；样本按人数独立；含机器人座整局剔除） | 0.8 |
| `game.paodekuai.risk.player2.minGames` | **2 人桶最少局数**（严格 `games >` 本值） | 100 |
| `game.paodekuai.risk.player3.winRateThreshold` | **3 人跑得快胜率阈值**（3 人基准约 33%） | 0.8 |
| `game.paodekuai.risk.player3.minGames` | **3 人桶最少局数** | 100 |
| `game.paodekuai.risk.player4.winRateThreshold` | **4 人跑得快胜率阈值**（4 人基准约 25%；建议按实际下调） | 0.8 |
| `game.paodekuai.risk.player4.minGames` | **4 人桶最少局数** | 100 |
| `game.paodekuai.risk.autoThrottleScore` | **PDK 单玩法自动限流阈值**：25=PDK 单命中即自动限流；26–49 与 50 同效（PDK 单命中不自动限流；PDK+设备 50 仍限流） | 50 |
| `risk.deviceLimit` | **多设备阈值**：统计窗口内同一账号用过的设备数**超过**此值 ⇒ 进审核队列 | 3 |
| `risk.deviceWindowDays` | **设备统计窗口（天）**：设备数只数最近这些天出现过的 | 30 |
| `risk.autoThrottle` | **自动限流总开关**：命中两项（评分 ≥50）时自动给账号上「3 次/秒」限流档；关 ⇒ 只进队列、等人工处置（**封禁永远是人工动作**，没有自动封禁） | 开 |
| `risk.deviceRetentionDays` | **设备记录保留天数**：超过这么多天的设备记录会被清理（玩家看不到，只影响管理页风控详情里能查到的设备） | 365 |
| `pay.rechargeEnabled` | **充值开关**：关 ⇒ 玩家端钱包页隐藏充值区、下单被拒（提示「充值暂未开放」）。⚠️ 只挡**新单**（已支付/已关闭的旧单不受影响）；开启手顺见「支付怎么上线（五步）」 | **关** |
| `pay.withdrawEnabled` | **提现开关**：关 ⇒ 钱包页隐藏提现区、申请被拒（提示「提现暂不可用」）。⚠️ 只挡**新申请**（在途/已审核单照走完）；开启前先想好打款人力（见「提现打款手顺」） | **关** |
| `pay.coinPerYuan` | **充值比率**：1 元钱换多少金币（100 ⇒ 6 元档 = 600 金币）。⚠️ **下单时快照**——只影响之后的新单，不动在途单 | 100 |
| `pay.rechargePackages` | **充值档位表**（元）：钱包页显示哪些按钮（下拉一张表，防自由输入）；非法档位下单会被拒 | 6 / 30 / 68 / 128 / 328 |
| `pay.withdrawMinCoins` | **提现门槛**（金币）：低于它不给提（提示走 message） | 1000 |
| `pay.withdrawMaxCoinsPerOrder` | **单笔提现上限**（金币） | 50000 |
| `pay.withdrawDailyMaxCoins` | **单日提现上限**（金币/人；按 **+08:00 自然日**算——在途/打款中的都计入） | 100000 |
| `pay.orderExpireMinutes` | **充值单有效期**（分钟）：超时未付的订单自动关闭（之后若又收到付款回调，会自动重开并入账——钱不会丢） | 30 |
| `pay.withdrawTimeoutMinutes` | **提现超时回滚**（分钟）：申请后这么久没审、没打款，金币自动退回玩家（默认 72 小时；超时回滚与「驳回」都走同一条退款路） | 4320 |
| `pay.scanIntervalMs` | **支付扫描周期**（毫秒）：八条补偿循环（过期关闭 / 主动补单 / 入账重试 / 提现解冻与超时回滚 / 退款解冻回滚与未知结果重放）的统一节奏——改小 ⇒ 卡住的单收敛更及时 | 60000 |
| `pay.reconcileIntervalMs` | **支付日自检周期**（毫秒）：入账勾稽 + 锚勾稽的反差自检（钱的事故面第一道铃） | 86400000 |
| `currency.reconcileIntervalMs` | **货币对账周期**（毫秒）：账实相符 / 缓存漂移自愈 / 孤儿诊断 | 3600000 |
| `risk.scanIntervalMs` | **风控扫描周期**（毫秒）：两玩法胜率 / 设备判定与自动限流的轮询节奏 | 3600000 |
| `risk.devicesCleanupIntervalMs` | **风控设备记录清理周期**（毫秒）：按 `risk.deviceRetentionDays` 保留期批删（玩家看不到，只影响管理页风控详情里能查到的设备） | 3600000 |
| `record.cleanupIntervalMs` | **对局记录清理周期**（毫秒）：按 `record.retentionDays` 保留期清理玩家「历史战绩」（**库里也删**；备份里仍有） | 3600000 |
| `ad.reliefAdpid` | **救助广告位 id**（uni-ad 激励视频）：在 uni-ad 后台申请广告位拿到的 **adpid**。**空 = 未配置** ⇒ 玩家端不显示「看广告领救助」入口（救助开关开着也一样）。⚠️ 是**字符串**（照原文粘贴，别当数字）；开通 / 回调 / 换位 / 轮换手顺见本节「广告怎么开通」 | 空（未配置） |
| `client.appEnabled` | **App 端准入开关**：关 ⇒ App 端**新请求 / 新连接**一律被拒（玩家看到「当前客户端已暂停服务」）；**不会**踢断已经连上的连接。⚠️ 是运营应急用的软开关（某端出问题时先停那端），不是安全边界 | **开** |
| `client.h5Enabled` | **H5 端准入开关**：同上，作用于 H5 网页端。**两键相互独立**，可以只停一端 | **开** |

**填错了会怎样**：非法值**会被拒绝**（页面显示原因）、**不会**写进库，也不会把服务弄坏。例如档位表为空、档位重复或单档超过 8191 会被拒（省略底分时取表内最低档）。

**台费并入档位表（2026-10-21）——阶段 2 迁移与回滚手顺**：

- **升级**：阶段 2 迁移 `1796000000000-RemoveEntryFeePercents` 删除旧键
  `currency.entryFeePercents` 行；无需手工动作。历史种子迁移保留（可追溯），最终态无该行。
- **回滚到阶段 1/旧代码**：旧代码会读旧键 ⇒ 先执行新迁移 `down`（恢复历史四档×0）或等价 SQL；
  **若档位表任一档 `entryFeePercent > 0`，必须把当前费率回填到旧键**（>50 的档先降到 ≤50），
  否则旧代码读旧键 = 静默不收费。回填示例（**四个 `percent` 必须逐个替换为档位表当前值**；
  下面 10/0 只是占位，照抄会把台费清成 0）：
  ```sql
  UPDATE platform_config
     SET value = JSON_ARRAY(
       JSON_OBJECT('baseScore',15,'percent',10),
       JSON_OBJECT('baseScore',80,'percent',0),
       JSON_OBJECT('baseScore',480,'percent',0),
       JSON_OBJECT('baseScore',1200,'percent',0)),
         version = version + 1, updated_at = NOW(3), updated_by = 'rollback'
   WHERE `key` = 'currency.entryFeePercents';
  ```
  行不存在时先 INSERT（或跑新迁移 `down`）。旧键值域 0–50，不能承载 >50 的费率。
- **台费上限 0–100 的回滚硬步骤**：**上线顺序**——先确认 14 个镜像全部以新版本起好
  （config-service 与 room-service 都新）再在后台调 >50；部分旧实例仍在跑时不要调。
  若档位表里有 >50 的 `entryFeePercent`，旧镜像（≤50 parser）
  会解析失败 ⇒ `/api/config` 档位表下发空表（大厅无档位可打）、room-service 台费静默 0、
  救助不可用。回滚前必须在新栈把各档调回 ≤50（或 0）并 `GET /api/config` 自证；旧键值域也是
  0–50，不能承载 >50 的费率。conformance 镜像需随本提交重建（protocol 变更的部署副作用）；
  本片未改 slice-25。

**安全**：管理员账号 = 「能改平台配置、能动钱」的凭据 ⇒ 别外传，给每个同事建**自己的号**（每个人的操作都会记进审计）。**改口令**在「账号」页做（自己改自己，或超管给他人重置）—— **不用**再改 `.env`；忘了口令用上面的 hatch。

**审计**：账号操作（建号/改角色/停用/重置口令）、登录事件（成败 + 来源 IP）、配置修改（旧值→新值）、钱包流水、**风控处置**、**支付处置**这六类都有记录、可导出 CSV —— 左侧「审计」页看（风控处置是第五个页签，**支付处置是第六个**）；这是「谁改了什么」的答案。

**风控谓词怎么开启（上线后手顺）**：风控的两条匹配谓词 `risk.predicate.sameDevice`（同设备）与 `risk.predicate.sameIp`（同 IP）**默认都是关**的（防误伤）—— 尤其同 IP 谓词，在公司 / 学校 / 网吧这类「很多人共用一个出口 IP」的环境会把大量玩家互相拒配。要武装它们，**按这个顺序、一次只开一条**：

1. **先开「同设备」**：把 `risk.predicate.sameDevice` 改成 `true` 保存，然后**观察一周** —— 去 Grafana「风控 / Risk」面板看「谓词拒绝速率」块（按 `sameDevice` 过滤）；正常条件下它应当低而平稳。
2. **一周后再评估「同 IP」**：只有在同设备那条平稳运行、无误伤迹象时，才考虑开 `risk.predicate.sameIp`；开完继续盯同一个面板。
3. **随时可回关**：把键改回 `false` 即恢复（≤60s 生效）；两条互不影响。

**开过头了怎么看**：谓词开启后，告警 **`MatchPredicateRejectionHigh`** 就是安全绳 —— 10 分钟窗内「谓词拒绝数 ÷ 抽选轮数」**超过 50%**（且样本足够）时会发通知（邮件 / IM 群）。先到「风控 / Risk」面板把 `sameIp` / `sameDevice` **拆开看**：若是 `sameIp` 大面积奏响，多半是同出口 IP 的误伤（CGNAT）⇒ 把 `risk.predicate.sameIp` **回关**即可。

---

## 数据没了怎么办（**事故处置**）

> 与 **⑧ 回滚**并列的一节：⑧ 管「**代码**坏了」，本节管「**数据**没了」。这一节就是 `restore.sh` 的手册版。

**什么时候用**：

- 数据库里的东西没了 / 不对（玩家数据空了、表不见了）—— 误删、程序写坏、手滑 `DROP`；
- **证书卷丢了**（⑥ 详注 ④ 那种：https 打不开、日志里没有 `certificate obtained`）；
- `/srv/pokergame/.env` 丢了（罕见，但它是全机**唯一没有第二份**的东西 —— 备份里有；⚠️ 备份里那份副本**不含渠道主钥** `PAY_CONFIG_ENC_KEY` —— 见「恢复之后」最后一条）。

⚠️ **先读两条前提**：

1. **这会覆盖掉比备份新的数据** —— 数据库被换成**备份那一刻**的样子：备份之后注册的账号、打完的局，都回到当时的进度。备份**每小时**一份 ⇒ 最坏丢 1 小时；而且备份照的是**当前**状态，**坏掉的状态也会被备下来** ⇒ **别拖延**（要更早那一份，见下面「恢复错了」那段的 `--backup-ts`）。
2. **必须用 `ubuntu` 跑**（本节是全手册「一律 root」的**唯一例外** —— **别加 `sudo`**）。这是**机械闸**：身份错了会**当场被拒**、一行都不往下走 —— 不会「悄悄做错」。

### 命令

⚠️ **先确认两个容器在跑**（恢复脚本要 `docker exec` 进它们：`ftl-mysql` 管现场备份与灌库，`ftl-edge` 管证书卷）：先 `cd /srv/pokergame && docker compose --env-file .env -f docker-compose.yml ps`（这条只读，身份随意），两个名字都在列表里才往下走；缺一个（栈没起全 / 压根没起）⇒ 先照 **④4.1** 起栈，再回来做本节。

**第一步：以 `ubuntu` 登录服务器**（在你自己的机器上跑；`<服务器 IP>` 见 〇①）：

```bash
$ ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器 IP>
```

**第二步：跑这一条**（登录之后的 `ubuntu` 提示符下 —— **整行逐字复制**，没有要你填的东西）：

```bash
$ bash /home/ubuntu/ftl-ops/restore.sh --restore-caddy --restore-env
```

- 这一条 = 「恢复**最新的一份成功备份**」+「把证书卷和 `.env` 也一起放回去」。**恢复哪一份由脚本自己挑**（最新的那一份 `ok:true`），你不用查、不用填。
- 只丢了数据库、证书卷与 `.env` 都好好的 ⇒ 把尾巴上那两个旗标去掉再跑（`bash /home/ubuntu/ftl-ops/restore.sh` —— 那**也是一条完整的整行命令**）。
- ⚠️ **别**写成 `ssh ubuntu@… "bash /home/ubuntu/ftl-ops/restore.sh …"` 那种一把梭：那条路**没有交互式终端**，脚本会**拒绝**（「恢复永远是人决定的事」）。**登录进去、在终端里敲。**
- 恢复期间**站点会停几分钟**（先把业务面容器停掉、灌完库再起回来）—— 这是预期，不是故障。

**预期输出**：下面每一行的**文字**都是 `restore.sh` 会打印的**原文**（`<…>` 是每次不同的值、行首的 `<时间>` 是 UTC 时间戳）。

⚠️ **诚实边界**：这条**生产形态**的命令到写这份手册时**还没有在真服务器上跑过**（首次真人恢复排在验收任务里）；逐字取自真跑的是**演练**（2026-09-25，只走数据库那一段）。所以下面把「哪几行一定出现」标清楚 —— 生产形态多出来的只有 **②⑤⑥⑦ 四段**（②⑥⑦ 要动真容器；⑤ 要动证书卷与 `.env` —— 演练那条命令没带 `--restore-caddy` / `--restore-env`）。另：演练的收尾 ✅ 那一行末尾还会多一句「（演练形态：②⑥⑦ 已跳过 —— 站未起、未冒烟）」，生产形态**没有**这句。

```
<时间> 要恢复的是：<备份 ts>（--backup-dir /home/ubuntu/ftl-backups；业务面清单：「ftl-api-gateway ftl-user-service ftl-room-service ftl-game-service ftl-robot-service ftl-douzero ftl-edge」）
<时间> ① 现场备份（restore- 前缀；在停任何容器之前 —— 证书卷那一步要 exec 门口容器）
<时间>    现场备份：manifest-restore-<ts>.json（恢复错了它就是第二次机会）
<时间> ② 停 ftl-api-gateway
<时间> ③ 校验通过：sha256 对得上、gzip 完整、收尾标记在、库名对得上
<时间> ④ DROP DATABASE fight_the_landlord + 灌入（重建靠 dump 自带的 CREATE DATABASE）
<时间>    灌入完成
<时间> ⑤ 还原证书卷（容器 ftl-edge 的 /data）
<时间>    证书卷已还原：<N> 个文件
<时间> ⑤ 还原 .env（/srv/pokergame/.env）
<时间> ⑥ 起栈（与手册 ④4.1 逐字同形）：docker compose --env-file /srv/pokergame/.env -f /srv/pokergame/docker-compose.yml up -d（IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<版本>）
<时间> ⑦ 冒烟三条通过（第 <N> 次尝试）
<时间> ✅ 恢复完成：恢复的是 <备份 ts> 那一份（--backup-dir /home/ubuntu/ftl-backups），耗时 <N>s，属于镜像版本 <版本>；兜底现场备份在 manifest-restore-<ts>.json
```

- `①` **先做一份「现场备份」**（名字带 `restore-` 前缀）—— 那是**恢复错了时的第二次机会**，别跳过它；
- ⚠️ `①` 跑到一半时，终端上会**夹着 `backup.sh` 自己的几行**（同一行首时间戳，结尾一行形如 `<时间> OK restore-<ts>: caddy_entries=2 image_tag=v1.0.0 usable=true`）—— 那是它把日志**同时**写给终端与 `backup.log`（`tee >&2`）⇒ 上面那份清单只列 `restore.sh` **自己**说的那几句，夹进来的那几行**不是**「多跑了一步」或「出故障了」。（本机那种没有 `flock` 的机器上还会多两条 `WARNING …未上锁…`；生产上恒有 `flock`，不会有它们。）
- 如果数据库**整个没了**（最坏的那种），`①` **之前**（紧跟在 `要恢复的是：…` 那行之后）还会多一行 `⓪ 库 fight_the_landlord 现在**不存在**（最坏的事故形态）⇒ 先建一个空库：现场备份要如实记下「此刻是空的」` —— 那是脚本在**如实记录现状**（演练里真出现过这一行），照常往下走（`④` 反正会重建）。
- `②` 会打印 **7 行**（api-gateway / user-service / room-service / game-service / robot-service / douzero / edge 各一行）；`mysql` 与 `redis` **不动**（所以数据库本身一直在）；
- `⑤` 的那几行**只在你带了对应旗标时**才出现（`--restore-caddy` 两行、`--restore-env` 一行）；⚠️ 还原的 `.env` **不含渠道主钥行**（备份剥离，见下面「恢复之后」最后一条）；
- `⑦` 冒烟三条（`/api/health`、首页、实时握手）最多重试 **90 秒** —— 站要重新起来 + 证书就位，**这段时间慢是正常的**。
- **最后一行 `✅ 恢复完成` 才是「好了」** —— 它同时告诉你：恢复了哪一份、耗时、**恢复到哪一版代码**、以及现场备份的名字。

**不一样怎么办**：

- `/home/ubuntu/ftl-ops/restore.sh: No such file or directory` ⇒ 这台服务器上**还没有**恢复脚本（它和定时任务一样由**发布流水线**在每次发布时投递，见 ⑦）⇒ 照 **⑦7.1** 再发布一次，脚本会被送上去；顺手核一眼路径没敲错（`ls /home/ubuntu/ftl-ops/` 应当恰好三个脚本：`backup.sh` / `restore.sh` / `install-cron.sh`）。
- `拒绝以 root 运行：备份目录是 0700 ubuntu，root 写出的产物 ubuntu 读不到 ⇒ 新鲜度假红。`（紧跟着一行 `请以 ubuntu 身份运行：ssh -i ~/.ssh/ftl_deploy ubuntu@<服务器>`）⇒ 你在 root 身份下跑了（八成加了 `sudo`）⇒ **去掉 `sudo`**、用 `ubuntu` 账号登录后重跑。它退在**任何动作之前**，什么都没被碰过。
- `拒绝非交互执行（恢复永远是人决定的事）。…`⇒ 你不是在一个真人终端里跑的（比如 `ssh 服务器 "…"` 一把梭 —— 那样**没有交互式终端**）⇒ 先 `ssh` 登录进去，在提示符下敲。（「…」省略的那半句是**演练**用的开关提示 —— 真人恢复用不到、也**不要**传。）
- `拒绝：/home/ubuntu/ftl-backups 里没有 ok:true 的 manifest ⇒ 没有可恢复的集合（去看手册「备份还活着吗」那节）`⇒ **一份能用的备份都没有** ⇒ 先照**「备份还活着吗」**那节查备份为什么全失败（磁盘满？定时任务没了？）。
- `拒绝：…不是 ok:true（拿一份失败的备份去覆盖生产 = 第二次事故）`⇒ 只有你自己用 `--backup-ts` 指名时才会碰到：你指的那一份是**失败的**备份 ⇒ 换成最近那份成功的（见「备份还活着吗」）。
- ``拒绝起栈：本地没有 <镜像名> …别慌：先用 `docker image ls` 看本机到底有哪个版本，再显式传 --image-tag <本机确实有的版本> 重跑…``⇒ 按它说的做：`docker image ls | grep fight-the-landlord` 看一眼 `TAG` 列，再把整条命令加上 `--image-tag <那个版本>` **重跑**（重跑是安全的 —— 脚本自己写了理由）。⚠️ 这条卡住时**数据其实已经灌好了**，卡的是「起站」。
- `❌ 冒烟在 90s 预算内（第 N 次尝试）没过 ⇒ 站可能没起来。**数据已经恢复好了**…`⇒ **数据回来了**，只是站没起回来 ⇒ 按 **⑥ 排错**把站弄起来。**这句话不是「恢复失败」。**
- **恢复错了**（灌错了一份 / 灌完发现不对）⇒ **第 ① 步那份现场备份就是第二次机会**：把它再恢复回去（`<ts>` 换成它名字里的那串 —— 现场备份的名字形如 `restore-20260926031405`：`restore-` + **14 位到秒**的 UTC 时间戳。⚠️ 它比每小时那 10 位戳**长**，就是为了让「同一个小时里再来一次」时，新的现场备份**不会覆盖**上一份 —— 覆盖掉的话，你此刻要用的这份「第二次机会」正好会被它自己抹掉）：

```bash
$ bash /home/ubuntu/ftl-ops/restore.sh --backup-ts restore-20260926031405 --restore-caddy --restore-env
```

（`--backup-ts` 是**唯一**要你自己填旗标的时刻；平时不填 = 最新那份成功备份。）

**恢复之后**：

- 打开 `https://<你的域名>/` 自己看一眼；命令最后一步已经替你验过三条（接口、首页、实时握手）。
- **当时进行中的对局会丢**（实时状态存在 Redis 里、**有意不备份**）—— 玩家重新进房即可。这是设计，不是故障。
- 第 ① 步的现场备份**不用手动删**：它同样按 **14 天**自动清理。
- 🔴 **渠道/通知主钥不在备份里，要自己补（支付配置管理化片起；通知通道管理化片起同钥也管通知九键）**：备份每小时打 `env-*.gz` 时会**剥掉 `PAY_CONFIG_ENC_KEY` 那一行**（锚定「**行首裸 `KEY=`**」的形态；写成带前导空白 / `export ` 前缀的行**不剥**——那种写法会被备进来）⇒ 恢复出来的 `.env` **缺这一行**：站照常起（渠道块 / 通知块 fail-closed 关闭，**不影响其它面**），要恢复须把**你自己另存的那份主钥副本**补进 `/srv/pokergame/.env`（补完照 ⑦ 再走一次部署）。
  - 🔴 **必须用原钥匙的副本 —— 不要拿新生成的钥顶替**：旧值都是用原钥加密的，换了新钥**全部解不开** ⇒「支付渠道」与「通知通道」两个视图都报 503。更麻烦的是**已知缺陷在案**：**非密键**（渠道的 APPID / 支付宝公钥 / 商户 PID / 网关地址 / 站点基址；通知的服务器 / 端口 / 账号 / 收件地址）的**改与清都会被「旧值解密失败」挡回 503**（写入这条修复路径被坏数据门住）——只能上服务器**手工清行**兜底（进 MySQL 清表，见下），之后到管理页重填全部值。**主钥副本 = 唯一顺路径。**
  - **主钥副本也丢了**（最坏情形）⇒ 生成一把**新**钥顶上，先**手工清行**再重填全部值：`docker exec -it ftl-mysql mysql -uroot -p fight_the_landlord -e "DELETE FROM notify_channel_config;"`（渠道则是 `DELETE FROM pay_channel_config;`；`-p` 的密码 = `.env` 里 `DB_PASSWORD` 的值）。⚠️ 清行 = 该键空间全部回「未配置」；随即到管理页把值**重填一遍**（通知见「通知怎么上线（三步）」第 2 步、渠道见「支付怎么上线（五步）」第 2 步）；其中渠道的**应用私钥**还要去**支付宝后台换一把新钥**（旧钥随上传即废 —— 手顺见「密钥轮换」）。

---

## 备份还活着吗

**为什么**：备份是服务器上**每小时**自己做一份的，坏了**没有人会通知你** —— 目前唯一自动发现它的地方是发布流水线里那一步「备份新鲜度」（**一份 manifest 都没有** / 最近几次**全是** `"ok":false`（只失败、没成功过）/ 最近一次**成功**备份已经 **3 小时**或更久（闸是 `≥3` ⇒ **正好 3 小时就已经红**） / 最近一次**失败** / 三件产物不齐 / **ssh 探不到服务器** / 判不出年龄 ⇒ 那次发布会**在最后一步红**，并打印「去看手册『备份还活着吗』那节」；⚠️ 末尾那两类**不是「备份坏了」** —— **探不到**是「看不到」、**判不出年龄**是闸**不敢下结论**，各自给的是各自那句话）。⚠️ 但枚举里的**头两条**（**一份 manifest 都没有** / 最近几次**全是** `"ok":false`）现在**不会再红在**这一步上：流水线在部署**之后**、这一步**之前**还有一步「**首次备份**」，它**只在**这两种情形下立刻跑一次备份 —— 跑成了就当场把备份补上（那份新鲜的 manifest 是**真备份**产出的），跑不成**那一步自己红**（文案同样是「备份没有起来 ⋯ **站是好的，别回滚**」）。（「备份停了」那类**不**在这两条里 —— 那时有**旧的** `ok:true` manifest，首跑不跑 ⇒ 这一步照旧按**年龄**红。）⚠️ 那两步红**都不代表这次发布有问题** —— **站是好的，别回滚**。平时想自己确认一眼，就用下面这条。

**命令**（在服务器上跑；本节**只读**，root 或 `ubuntu` 身份都行）：

```bash
$ ls -t /home/ubuntu/ftl-backups/manifest-[0-9]*.json | head -1
/home/ubuntu/ftl-backups/manifest-2026092603.json
$ cat /home/ubuntu/ftl-backups/manifest-2026092603.json
{"ts":"2026-09-26T03:00:11Z","ok":true,"failed_at":null,"artifacts":{"users":{"sha256":"…","bytes":…},"caddy":{"sha256":"…","bytes":…},"env":{"sha256":"…","bytes":…}},"caddy_entries":2,"image_tag":"v1.0.0","image_tag_usable":true}
```

（上面的 `<ts>` 与数字是**形态示意** —— 每次备份都不一样；字段名与顺序是固定的。）

⚠️ **命令里 `manifest-[0-9]*.json` 的 `[0-9]` 是故意的**：名字带 `restore-` 的 manifest（形如 `manifest-restore-….json`）是**恢复脚本动手之前给自己留的现场备份**（就是上一节第 ① 步那份 —— 恢复错了时的第二次机会），**不算**「每小时的备份」⇒ 本节的命令都把它排除在外（`restore.sh` 自己挑「恢复哪一份」时同样跳过它）。不排除的话，**一次恢复就能把这节检查显示成「备份还活着」** —— 而每小时那条链可能早就断了。

**预期**（两件事都要看）：

1. **文件名里的 `<ts>`** —— 形如 `2026092603` = **UTC** 2026-09-26 **03 点**那一份 ⇒ 说明「最近一次备份是什么时候跑的」；
2. **内容里 `"ok":true`** —— 说明「**它成功了**」。

每份备份是**四件**（同名同 `<ts>`）：`manifest-<ts>.json`（清单）· `users-<ts>.sql.gz`（数据库）· `caddy-data-<ts>.tgz`（证书卷）· `env-<ts>.gz`（配置）。**三件产物缺一件，那份备份就是残的**（流水线那条新鲜度检查也按这个判；恢复时缺到它**要用**的那一件会直接拒绝）。

⚠️ **`"ok":true` 的冒号后面没有空格** —— 想用 `grep` 就照抄这个形态：`grep '"ok":true' …`。写成 `"ok": true`（带空格）**什么都匹配不到** —— 别把「我 grep 不到」读成「备份没成功」。

🔴 **为什么不让你 `ls -lt` 看一眼列表**：**失败也留 manifest**（`"ok":false`，还用 `failed_at` 写明失败在哪一步），而备份是**每小时**一份 ⇒ 全都失败的时候，目录里的文件**每小时多一个** —— `ls -lt` 的列表**越坏越新、越坏越长**，读起来反而更「健康」。**只认最新那一份的内容**，不认列表的长相。

**不一样怎么办**：

- 最新那份是 `"ok":false` ⇒ **最近一次备份失败了**（`failed_at` 写在哪一步：`mysqldump` / `caddy-tar` / `env`）⇒ 去看 **`/home/ubuntu/ftl-backups/backup.log`** —— 每次运行的最后一行要么 `OK …`、要么 `FAILED …`：`FAILED` 那行**只点名失败的步骤**（那一步的具体报错不在日志里 —— 定时任务把输出丢进了 `/dev/null`，谁也看不到）；连原因一起写的只有两类**没开跑**的失败 —— 磁盘空间预检没过 / 拿不到锁。⚠️ 那两类还**连 manifest 都不写** ⇒ 只看 manifest 会漏掉它们，`backup.log` 要一起看。找**最近一份成功的**（= 恢复时会用的那份）：

  ```bash
  $ grep -l '"ok":true' /home/ubuntu/ftl-backups/manifest-[0-9]*.json | sort | tail -1
  ```

- 最新那份是 `"ok":true`，但**时间戳老**（比如已经 3 小时或更久 —— 闸的口径是 `≥3`）⇒ 定时任务可能停了：`crontab -l | grep ftl-backup` 应当**恰好一行**。⚠️ **这条要用 `ubuntu` 身份跑** —— 定时任务装在**它**名下，以 root 跑看到的是**另一份**（永远没有那一行）。机器关过机 / 重启过也会让时间戳变老；定时任务由发布流水线在每次发布时核对安装 ⇒ 实在没了就**再发布一次**。
- **一个 `manifest-[0-9]*.json` 都没有**（或整个目录都不见了）⇒ 备份从来没成功过，或目录被清空 / 搬走了 ⇒ 看 `backup.log`；连 `backup.log` 都没有，就是**一次都没跑起来**（同样：再发布一次会让流水线重装定时任务）。
- 目录里最老的一份大约在 **14 天前** ⇒ 正常（保留 14 天，更早的自动清理）—— 反过来说：**14 天以外的恢复点不存在**。

### ⚠️ 别动 `/home/ubuntu/ftl-backups`

`rm -rf` 掉这个目录**也是「误删」** —— 而**没有任何补救**：备份救不了它自己（备份与生产在**同一台机器、同一块盘**上；机器整体没了、磁盘坏了同样救不了 —— 这是**已知做不到的事**，不是疏忽）。凭据也一样：那里面的 `.env` 归档含全部密钥，dump 里是账号哈希 ⇒ 目录权限是 `0700 ubuntu`，**别改**。平时**只读**它：所有写入都发生在它自己（每小时那份备份、以及恢复脚本），你手工**不要**往里删、改、移。

---

## 监控（看板与告警）

> 监控片（2026-10-03 起）给栈加了 **6 个监控容器**：Prometheus 收数据、Grafana 画面板、Alertmanager 管告警、node-exporter / cadvisor 采主机与容器、alert-relay 把告警转发进 IM 群。它们**不参与玩家请求** —— 站坏了它们负责报信；它们自己坏了**不影响玩**（唯一的损失是「没人报信」）。本节讲三件事：**去哪看**、**告警发去哪**、**怎么改**。

### ① 监控在哪看（Grafana 看板）

浏览器访问（注意结尾的斜杠）：

```
https://<你的域名>/grafana/
```

登录：用户名 **`admin`**，口令 = 服务器 `/srv/pokergame/.env` 里 **`GRAFANA_ADMIN_PASSWORD`** 的值。

**预期**：先看到一个**登录页**（不是白屏、不是 404）；登录后有**八块**面板：**FTL 总览 / FTL 业务与队列 / FTL 主机与容器 / FTL 记录与备份 / 资金面 / Currency / 风控 / Risk / 支付 / Payment / FTL 玩家与营收**。

> **FTL 玩家与营收**（2026-10-22）：当前在线（presence）、WS 连接数、玩家总数、近 24h 新增、活跃 1/7/30 天、流失 14/30 天、近 24h 充值金额与笔数。口径说明：管理页「今日」= 北京时间自然日，看板「近 24h」= 滚动窗口，两者会有差异。

**不一样怎么办**：打不开 ⇒ 看本节 ⑥ 的自查三条。

### ② 告警都会发到哪里

**两条互相独立的通道**（一条坏了、另一条照达）：

- **邮箱**：服务下线、5xx 错误率、磁盘、内存、连接数、容器反复重启、记录清理停滞 —— 发到**管理页「通知通道」里填的 `告警收件地址`**（通知通道管理化片起 —— 不再是 `.env` 的键；见「通知怎么上线（三步）」）。
- **IM 群**（飞书 / 钉钉 / 企业微信）：**配了哪个发哪个**（没配的通道不存在、也不报错）。

**多玩法（2026-10-25）**：新增 4 条按玩法（`game_type`）分维的告警 —— `GameStartFailuresHigh`（开局失败/取消）、`GameSettleFailures`（局终失败）、`SettleDroppedByGame`（金币结算 dropped）、`RecordWriteFailuresHigh`（记录写失败/丢失）。`currency_settle_outbox_size` / `_oldest_seconds` 现按玩法多条序列：查询/面板用 `sum by (game_type)` 或 `sum()`，不要再假设单序列。
**B 组（2026-10-26）**：新增 `RiskScanSqlFailures`（`scope=doudizhu|paodekuai|device`，10m 任意失败即 warning）。单玩法 SQL 失败时该玩法本轮冻结、其他玩法继续；device SQL 失败会整轮失败。先查 scope 对应表/权限，再看 user-service 扫描 ERROR 日志与 `risk_scan_last_success_timestamp_seconds`。

⚠️ **心跳邮件（「监控活着」）**：邮箱配好之后，大约**每 24 小时**你会收到一封「监控活着」的邮件（内容里带 `Watchdog` 字样）—— 它证明**整条告警链**（收数据 → 判规则 → 发通知）活着。判读口径 = **「多久没收到」**：

| 多久没收到        | 说明什么                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不到 ~24 小时     | 正常（心跳就是每 24 小时一封）                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **超过 ~25 小时** | 四种可能之一：① **监控自己坏了**（Prometheus / Alertmanager 进程死了，或整台机器挂了 —— 这封邮件本来就是为这种情况准备的）；② **邮箱通道没配**（没配就从来不会有心跳 —— 去管理页「通知通道」看邮件组的组尾提示：`邮件通道：已就绪` 还是 `未就绪（缺 N 项）`）；③ 邮件被**垃圾箱 / 拦截**了（先翻垃圾箱，尤其第一封）；④ **SMTP 配了但错**（授权码过期/打错、端口不对、或被网络拦截）—— 用本节 ③ 的验证配方（停 Grafana 2 分钟看有没有告警进来）当场定位 |

⚠️ 心跳**只走邮件、不发 IM** —— 只配了飞书/钉钉/企微的话，不会有心跳邮件（这是设计：心跳要能暴露「发通知的部件自己挂了」，所以只走最独立的那条通道）。

### ③ 怎么加 / 换告警通道（**管理页操作** —— 不用再部署）

各通道的「地址/密钥」改在**管理页 →「通知通道」**里填 / 改（通知通道管理化片起：**不再写 `.env`、不用再打 tag 部署**；各平台「去哪拿」见 `docs/ops/notify-onboarding.md`）。页面上分两组共九行：**邮件（SMTP）** 5 行 + **IM 通道** 4 行：

| 通道         | 管理页上的行                                                           | 去哪拿（速览）                                                                                              |
| ------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **邮箱**     | `邮件服务器` · `邮件端口` · `邮件账号` · `邮件授权码` · `告警收件地址` | 邮箱服务商后台开 **SMTP**，拿**授权码**（不是登录密码；各家叫法可能不同）——逐项见 `notify-onboarding.md` §1 |
| **飞书**     | `飞书机器人地址`                                                       | 目标群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人** → 复制 webhook 地址                                |
| **钉钉**     | `钉钉机器人地址` + `钉钉加签密钥`                                      | 目标群 → 智能群助手 → 添加机器人 → **自定义** → 安全设置勾**「加签」** → 复制 Webhook 与**加签密钥**        |
| **企业微信** | `企业微信机器人地址`                                                   | 目标群 → 群机器人 → 添加 → 复制 Webhook 地址                                                                |

保存后**最多 30 秒**生效（不用重启、不用发版；与旧 `.env` 系不同）。「这两组要么全齐、要么别动一半」的规则**仍然成立，但报错方式变了**（旧版本的「写一半 ⇒ 容器拒起」已退役 —— 告警链要照常跑、不能因为一个通道没配好整个不工作）：

- **邮件五件套只配一半** ⇒ 邮件段整体不启用（发不出邮件，心跳也会断）+ 管理页显示 `邮件通道：未就绪（缺 N 项）` + 10 分钟后触发 `NotifyEmailIncomplete` 告警（**走 IM 腿来报信**）；
- **钉钉两项只配一个** ⇒ 钉钉槽停用 + 管理页显示 `钉钉通道：未就绪（缺 N 项）` + `NotifyDingtalkIncomplete` 告警。

（等价地说：旧形态是「**响亮地起不来**」，现在换成了「**自己报信说没配好**」。配完顺手看一眼管理页两组的组尾提示，就是最快的自查。）

**配完想验证**：制造一条真告警 —— 最省事是停掉**看板自己**（不影响玩家、不影响告警链）：

```bash
$ docker stop ftl-grafana     # 等 2 分钟（规则口径：断 2 分钟才算数）
$ docker start ftl-grafana    # 恢复
```

⇒ **2 分钟**后（再加几十秒的汇集等待），邮箱与**已配**的群里应各收到一条 `ServiceDown`（「grafana 抓不到了」）。没有 ⇒ 先看管理页两组组尾提示是否「已就绪」、确认保存成功（保存后 ≤30s 才生效）；再在服务器上 `docker compose --env-file .env -f docker-compose.yml logs alertmanager alert-relay am-renderer --tail 40` 看告警链自己的日志。

### ④ 怎么临时静默告警（维护窗口用）

⚠️ 静默**只挡通知**（邮件 / IM 不发），监控照常记录、规则照常判 —— 静默一结束，还在响的告警会再发。

Alertmanager 的网页界面**不在公网**（生产只发布门口），所以静默要用 `ssh` 上服务器、跑下面这条命令（**整行可复制**，把 `<你的名字>` 与最后的告警名按需换掉）：

```bash
$ docker exec ftl-alertmanager amtool silence add \
    --alertmanager.url=http://localhost:9093 \
    --comment="手动维护（<你的名字>）" --duration=2h \
    alertname=ServiceDown
```

- `--duration=2h` = 静默 2 小时（到期自动撤销；写 `30m` / `8h` 都行）；最后一段 =「静默**哪一类**告警」（用告警名匹配；可加空格续更多条件，如 `alertname=ServiceDown job=grafana`）。
- **常用告警名**（大小写照抄）：`ServiceDown`（抓不到某个服务）· `Http5xxRatioHigh`（5xx 过多）· `HostDiskSpaceLow`（磁盘）· `HostMemoryAvailableLow`（内存）· `WsConnectionsHigh`（连接数）· `ContainerRestartFlapping`（容器反复重启）· `RecordsCleanupStalled`（记录清理停滞）。⚠️ 带档位的规则（5xx / 磁盘 / 连接数）有 **High / Critical 两个告警名** —— 静默一个不会捎带另一个。
- **预期**：打印一行**静默 ID**（形如 `860de88b-34e5-4b85-afe7-4a32a5b60336`）。看当前静默 / 提前解除：

```bash
$ docker exec ftl-alertmanager amtool silence query  --alertmanager.url=http://localhost:9093          # 列出（含 ID）
$ docker exec ftl-alertmanager amtool silence expire --alertmanager.url=http://localhost:9093 <ID>     # 立刻解除
```

（不想用 amtool 的话，等价的原生 API 形态 —— **JSON 样板**照抄，只需按需改 `startsAt` / `endsAt` 两个 UTC 时间）：

```bash
$ docker exec ftl-alertmanager wget -qO- --header='Content-Type: application/json' \
    --post-data='{"matchers":[{"name":"alertname","value":"ServiceDown","isEqual":true,"isRegex":false}],"startsAt":"2026-10-04T10:00:00Z","endsAt":"2026-10-04T12:00:00Z","createdBy":"manual","comment":"手动维护"}' \
    http://localhost:9093/api/v2/silences
```

**预期**：`{"silenceID":"…"}`。

### ⑤ 怎么换 Grafana 口令

**为什么不能只改 `.env`**：`GRAFANA_ADMIN_PASSWORD` 只在**第一次**启动（初始化看板数据）时生效 —— 看板建好之后，改 `.env` 里的值**不会**改已存在的口令（Grafana 官方的「首启生效」语义）。以后换口令用这条命令（**不用**重部署、也**不用**旧口令）：

```bash
$ docker exec -it ftl-grafana grafana cli admin reset-admin-password <新口令>
```

**预期**：结尾一行 `Admin password changed successfully ✔`（它前面会先打印十几行 `logger=…` 的启动信息 —— 正常，不是报错）；之后用新口令登录 `/grafana/`。⚠️ 换完**顺手把 `.env` 里那行也改成同一个新口令** —— 免得将来整机重装（新数据卷）时用旧值初始化。

### ⑥ 打不开 Grafana？自查三条（按顺序）

1. **地址对不对**：`https://<你的域名>/grafana/`（结尾斜杠；不带也会自动跳过去）。⚠️ 整站都打不开 ⇒ 那是另一个问题（见「⑥ 排错」一节），与监控无关；能开首页、只有 `/grafana/` 不行 ⇒ 往下一条。
2. **口令对不对**：用户名 `admin` + `.env` 里 `GRAFANA_ADMIN_PASSWORD` 的值。不对 / 忘了 ⇒ 用上面 ⑤ 的命令重置（不需要旧口令）。
3. **容器在不在**：

```bash
$ cd /srv/pokergame
$ docker compose --env-file .env -f docker-compose.yml ps grafana
$ docker compose --env-file .env -f docker-compose.yml logs grafana | tail -20
```

`(healthy)` 且日志无报错 = 正常；`Restarting` ⇒ 多半是 `.env` 少了 `GRAFANA_ADMIN_PASSWORD`（fail-closed，见「⑥ 排错」的详注 ⑩）。

---

## 虚拟池：种子与充值（金币场机器人）

> 金币场的机器人上桌要带钱（每场开局前会自动把它「补」到目标水位）；这些钱从一个**虚拟池**里拨。
> 虚拟池就是一个特殊账户（名字固定 `robot-pool`），**钱不会凭空长出来** —— 池空了，机器人补不到钱就上不了桌
> （表现 = 金币场匹配不到人）。本节 = 怎么给池放钱。**首次开放金币场之前**做一次种子；之后收到
> `CurrencyRobotPoolLow` 告警（池余额 < 100 万）时再来充值。

**第一步：取管理令牌**（用户名 = 引导账号 `admin`；口令 = ②2.2 表里的 `ADMIN_PASSWORD` 的值 —— 若你后来改过口令，用改后的）：

```bash
$ curl -sS -X POST https://<你的域名>/api/admin/login \
    -H 'content-type: application/json' \
    -d '{"username":"admin","password":"<ADMIN_PASSWORD 的值>"}'
```

**预期**：返回一行 JSON，形如 `{"code":0,"data":{"token":"…一长串…","expiresIn":7200,"username":"admin","role":"super_admin"}}`。`token` 的值就是下面命令里的 `<管理令牌>`（有效期 2 小时，够跑完这 5 笔）。

**第二步：放 5 笔 × 100 万**（管理面单笔上限正好 100 万 ⇒ 必须拆 5 笔；逐字复制、只把 `<管理令牌>` 换成上一步那个值）：

```bash
$ curl -sS -X POST https://<你的域名>/api/admin/wallet/adjust \
    -H 'authorization: Bearer <管理令牌>' -H 'content-type: application/json' \
    -d '{"userId":"robot-pool","ownerType":"robot","delta":1000000,"reason":"金币场机器人池种子 1/5","actionId":"pool-seed-1"}'

$ curl -sS -X POST https://<你的域名>/api/admin/wallet/adjust \
    -H 'authorization: Bearer <管理令牌>' -H 'content-type: application/json' \
    -d '{"userId":"robot-pool","ownerType":"robot","delta":1000000,"reason":"金币场机器人池种子 2/5","actionId":"pool-seed-2"}'

$ curl -sS -X POST https://<你的域名>/api/admin/wallet/adjust \
    -H 'authorization: Bearer <管理令牌>' -H 'content-type: application/json' \
    -d '{"userId":"robot-pool","ownerType":"robot","delta":1000000,"reason":"金币场机器人池种子 3/5","actionId":"pool-seed-3"}'

$ curl -sS -X POST https://<你的域名>/api/admin/wallet/adjust \
    -H 'authorization: Bearer <管理令牌>' -H 'content-type: application/json' \
    -d '{"userId":"robot-pool","ownerType":"robot","delta":1000000,"reason":"金币场机器人池种子 4/5","actionId":"pool-seed-4"}'

$ curl -sS -X POST https://<你的域名>/api/admin/wallet/adjust \
    -H 'authorization: Bearer <管理令牌>' -H 'content-type: application/json' \
    -d '{"userId":"robot-pool","ownerType":"robot","delta":1000000,"reason":"金币场机器人池种子 5/5","actionId":"pool-seed-5"}'
```

**预期**：每笔返回 `{"code":0,"data":{"balanceBefore":…,"balanceAfter":…,"opId":…}}`，`balanceAfter` 逐笔递增到 5000000。

**每个字段怎么填**：

| 字段        | 怎么填                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `userId`    | 恒为 `robot-pool`（逐字，别改 —— 服务端按这个名字找池）                                                                                                      |
| `ownerType` | **恒为 `"robot"`** —— 漏写会按**玩家**账户开户，之后机器人补给会因账户类型不符**全部失败**（这是本节最容易漏的一格）                                         |
| `delta`     | 正数 = 加钱（负数是扣）；单笔绝对值 ≤ 1000000                                                                                                                |
| `reason`    | 必填（1..200 字符），会写进流水（对账凭据）；操作者（actor）**不用填** —— 服务端从你的登录令牌取，记为你登录的管理员用户名（本示例 = `admin`），审计里查得到 |
| `actionId`  | 每笔各不相同；⚠️ **同一笔重试时原样复用原来的 `actionId`** ⇒ 不会重复加钱（幂等；换新 id 重跑 = 又加一笔）                                                   |

**核对**（可选，一眼看池余额）：

```bash
$ curl -sS https://<你的域名>/api/admin/wallet/accounts/robot-pool \
    -H 'authorization: Bearer <管理令牌>'
```

**充值（不是首次）**：同一种命令，笔数按需要（每笔仍是 ≤ 100 万）；`reason` 写「金币场机器人池充值 N/M」。

---

## 金币结算失败怎么处置（金币场）

> 金币场一局打完，服务端要把输赢从输家账上扣、加给赢家。少数情况下这一步会失败（货币服务重启/超时、
> 余额不足、或撞上「算法 bug 哨兵」）。**失败不影响打完的局本身**，但**钱会停在半路**。服务端有一个
> **补偿队列**会每 10 秒自动重试多数失败，绝大多数几分钟内自愈；本条 = 自愈不了时你怎么接手。

**两个补偿队列**（都住在 Redis，各是一个 Hash；重发成功 ⇒ 自动清除）：

| 队列                 | 放什么                 | 含义                                                        |
| -------------------- | ---------------------- | ----------------------------------------------------------- |
| `settle:outbox`      | 待重发的**结算**       | 该局金币**尚未入账**（钱还没动）——最要紧的一类              |
| `recordmoney:outbox` | 待回写的**战绩金币列** | 钱**已入账**，只是该局记录的金币列（`money_delta`）还没标上 |

**`dropped` 是什么**：监控指标 `currency_settle_result_total{result="dropped"}` —— 结算的**终态放弃**计数：这一局服务端不会再自己动了。共六类：① 结算金额撞上 int 上限哨兵（算法 bug 信号，**永不重试**）；② 极罕见的重放冲突（`14002`，他方已结、本局不再动钱）；③ 守卫不齐（金币局缺 result/version、三座位或机器人座映射不全 —— 理论不发生，发生即人工核）；④ 余额读最终失败（重试阶梯走完仍读不到）；⑤ 写箱失败（补偿队列也进不去 —— 条目不存在，钱没动）；⑥ outbox 超龄放弃（`settle:outbox` 或 `recordmoney:outbox` 条目满 1 小时被清）。⚠️ 六类里**只有 ⑥ 的 `recordmoney` 是「钱已动」**（那局钱已入账，只是战绩的金币列永久留空、显示「—」——不需要补钱）；其余五类钱都没动。看到它不是「现在就要动手」，而是「这一局服务端不会再自己动了，走下面的核对」——核对手势不变：按 actionId 查 `currency_flows`。

**处置顺序（收到 `CurrencySettleOutboxStuck` 告警时，按序做）**：

1. **看 room-service 日志找那局**（日志是九字段 NDJSON，失败条目带房间号/版本号；告警 summary 里的滞留时长先行）：
   ```bash
   $ cd /srv/pokergame
   $ docker compose --env-file .env -f docker-compose.yml logs room-service | grep '<告警里的房间号>'
   ```
   日志的 `msg` 会写明失败类别（下游超时 / 下游不可用 / 余额不足 / 哨兵）。
2. **把路修通**：`docker compose ... ps` 看 `ftl-currency-service` 是否 Up：若是「超时 / 连不上」（货币服务重启、过载）⇒ 等它起来 / 重启它，队列每 10 秒自愈；若日志写「余额不足」（罕见 —— 该局重算后仍未过）、或反复看到「哨兵」类终态 ⇒ 把这行日志发给开发核对（**先别手工动钱**）。
3. **按账核对**（钱到底动没动）——每局的账目 id 恒为 `settle:<房间号>:<版本号>`：
   ```bash
   $ docker exec -it ftl-mysql mysql -uroot -p fight_the_landlord -e \
     "SELECT o.action_id, f.owner_id, f.delta, f.balance_after FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id WHERE o.action_id = 'settle:<房间号>:<版本号>';"
   ```
   （`-p` 的密码 = `.env` 里 `DB_PASSWORD` 的值。）**查得到行** ⇒ 钱已经入账（队列很快自愈清掉，无需动手）；**查不到行** ⇒ 钱没动 —— 队列还在就等重试；条目已超 1 小时被清掉（终态）⇒ 人工定夺（见下）。
4. **条目满 1 小时**：服务端**放弃**该条目（ERROR 日志 + `dropped` 计数）并删除 —— 此后没人再重试。钱的裁决只能人工做：以上一步的核账为准，用管理面 `POST /api/admin/wallet/adjust`（同上一节命令形态，`userId`/`ownerType` 按座位是真人还是机器人填）逐座补/扣，`reason` 里写明房间号与版本号。（若是 `recordmoney:outbox` 超龄被清 ⇒ 该局记录的金币列永久留空、玩家战绩里显示「—」；钱已入账，不影响余额。）
5. ⚠️ **别手动删 Redis 里的队列条目** —— 删掉 = 服务端永远不再重试（要看可以：`docker exec -it ftl-redis redis-cli HGETALL settle:outbox`）。

---

## 支付怎么上线（五步）

支付片（充值 / 退款 / 提现）出厂时是**暗上线**：两个开关默认关（玩家端钱包页的充值/提现区块隐藏、下单与申请被拒），渠道凭据默认空。要放开，按这个顺序走 —— **版本先上、凭据后填、验证再过、开关最后**：

**第 1 步：版本先上（打 tag 部署）**——先确认 `.env` 里两枚根信任锚已就位（`PAY_CONFIG_ENC_KEY` / `PAY_CHANNEL_PULL_TOKEN`；见 ②「支付配置管理化片新增两个运维键」表）；再照 ⑦ 正常发布（`git tag` + 流水线）。此时**功能仍是关的**（两个开关默认关、渠道未配置）——这一步只是让带支付代码的版本先上去、渠道存储就位；玩家侧看不到任何变化。

**第 2 步：管理页填沙箱六值**——登录管理页 →「支付渠道」，逐项填**沙箱**那套：沙箱网关地址 / 沙箱 APPID / 沙箱应用私钥 / 沙箱支付宝公钥 / 沙箱卖家 PID / 对外站点基址 = `https://<你的域名>`。各项从哪拿见 `alipay-onboarding.md`「交给我方的值」；填完六项都应显示「已配置」（私钥行显示「已配置 ✓ · 指纹 …」）。

**第 3 步：验证渠道（沙箱联调 + 轮换演练）**——用**支付宝沙箱**把「下单 → 付款 → 回调 → 入账 → 退款」全链走一遍（回调要公网可达 ⇒ 必须在服务器上、部署之后做）。⚠️ **两个开关默认关会拒单**（充值下单回 15008）⇒ 先在管理页「配置」**临时**把 `pay.rechargeEnabled` 改成 `true`；**联调完立刻改回 `false`**（只挡新单 —— 联调期的单都是你自己的，改回后玩家侧又完全不可见）。差异记入修订、按开发侧交接文档执行（`docs/superpowers/plans/2026-10-05-payment-handoff.md`）。

**轮换演练（真人验收项；打 tag 后、开开关前，需你在场）**：在沙箱把「密钥轮换」完整走一遍 —— ① 支付宝后台给沙箱应用**生成新密钥对**；② **上传新应用公钥**；③ 回管理页把「应用私钥」**覆盖写入**新私钥（页面上指纹**肉眼变化** = 写进去了）；④ **旧钥随上传即废**（旧私钥已不能再下单）。随后再下一笔沙箱单走到「回调入账」＝新钥全链生效。演练完把凭据覆盖回第 2 步那套（或直接进第 4 步换生产值）。

就地还能做的一发健康核查：

```bash
$ cd /srv/pokergame
$ docker compose --env-file .env -f docker-compose.yml exec payment-service \
    node -e "fetch('http://localhost:3007/api/health').then(r=>r.text()).then(console.log)"
```

**预期**：`{"status":"ok","service":"payment-service","checks":{"mysql":"up"}}`。

**第 4 步：管理页换生产值**——「支付渠道」逐项**覆盖**成生产那套（生产 APPID / 生产应用私钥 / 生产支付宝公钥 / 生产商户 PID；对外站点基址照旧）；**`渠道网关地址` 清空**（留空 = 生产默认网关 —— **生产就留空**）。可选：真 1 元小额自测一笔（同样要**临时**开一下 `pay.rechargeEnabled`、测完关回 —— 见第 3 步的手法）。

**第 5 步：开开关（暗上线 = 低限额 + 小范围）**——去管理页「配置」：**先把三项提现限额调小**（`pay.withdrawMaxCoinsPerOrder` / `pay.withdrawDailyMaxCoins` **调低**到你能盯得过来的量级），再开 `pay.rechargeEnabled`（充值是**钱进来**，先开它）；`pay.withdrawEnabled`（钱出去）**晚一步**、确认打款人力就位后再开（手顺见下一节）。开完自己去钱包页下一个小额单，把「付 → 回跳 → 到账」亲眼走一遍。

**开完之后的提额放量**——盯 Grafana「**支付 / Payment**」面板与支付告警（至少过完一两个观察周期）：没有异常再把限额键**改回正常值**（提额放量 = 改配置键，≤60s 生效，不用发版）。

**开过头了 / 出事想收**：把 `pay.rechargeEnabled` / `pay.withdrawEnabled` 改回 `false` 即可 —— **只挡新建单/新申请**；已支付、已申请、在途的单子照旧走完（不会把玩家正在进行的支付卡死）。真涉及钱不对（入账差额、孤儿锚）⇒ 告警 `PaymentReconcileDiff`（critical）与「数据没了怎么办」的账目核对手势。

---

## 密钥轮换（**应用私钥**）

轮换 = 换一把新的「应用私钥 + 应用公钥」，**旧钥随上传即废**。三种时刻：例行轮换 / 怀疑泄露 / 支付宝侧要求重签。四步（每步都能当场核对）：

1. **支付宝后台生成新密钥对**：开放平台「密钥工具」→ 算法 **RSA2** → 得到新的「应用私钥」+「应用公钥」（两件都先留在你手里）。
2. **上传新应用公钥**：应用 → 设置 → 接口加签方式 → **公钥模式** → 粘贴新「应用公钥」保存。🔴 **上传这一刻旧钥即废** —— 新私钥若还没填进管理页，渠道调用会立刻开始失败（15001）⇒ 挑低峰做，两步连着做完。
3. **管理页覆盖私钥**：登录管理页 →「支付渠道」→ `应用私钥` 行**覆盖写入**新私钥 → 保存。页面上**指纹肉眼变化** = 写进去了；**下一次渠道调用即生效**（不用重启、不用发版）。
4. **核对生效**：下一笔沙箱单（或生产小额单）走到「回调入账」＝ 新钥全链通了。

**泄露应对**：先登录支付宝商户后台**重签/停用**可疑密钥（改安全设置），再按上面四步换到我方；随后用管理页订单/流水视图核一遍近期账目（异常按「数据没了怎么办」的账目核对手势处置；日自检已在跑）。

---

## 提现打款手顺（**未登记 = 未打款**）

玩家的提现是**人工打款**：系统只做三件事 —— 申请那一刻**冻结金币**、排队待审、记账。**打钱这个动作由你在线下完成**（转账给对方），转完**回管理页登记**。三条纪律，缺一条就会分错钱：

1. **先核详情**：管理页 →「提现审核」→ 点开那一笔：核对玩家的**余额快照 / 可提额度快照 / 出款金额（元）/ 申请时间**。⚠️ 收款账号**系统不存**（收款信息线下核对）；出款金额是**申请时刻的换算快照**——之后改比率不影响它。
2. **手工转账**：按详情里的元数线下转钱。
3. **立即登记**：转完**立刻**回管理页点「**确认打款**」，把**打款凭证号（voucher）**填上。🔴 **未登记 = 未打款** —— 系统只看登记：没登记的申请，超时计时**照走**（`pay.withdrawTimeoutMinutes`，默认 72 小时），到点**自动把金币退回玩家** —— 你钱转得再对，也变成「给了两份」。登记本身**不动钱**（钱在申请时已冻结），它只是记账 + 放行。

**不打款怎么办**：点「驳回」（理由必填）⇒ 冻结的金币**自动退回**玩家余额。**人联系不上/来不及**：什么都不用做 —— 到期自动超时回滚。

**退款审批的几个已知形态**（「支付处置」审计页可查到**当前状态与最近一次处置**——单值处置戳视角）：

- **审批会等渠道，最长能转 ~12.6 分钟**：通过一笔退款时，服务端在按退避表打渠道（1s→5s→30s→2m→10m）；而**网关 5 秒**就掐断前端连接 ⇒ 管理页可能先收到 **503/10007**（页面写着提示）——**服务端仍在继续**，别重复操作；**刷新页面看最新状态**。已经变过状态的单再操作会被 **15009** 拒（消息里写明当前态与合法动作——刷新看它即可）。
- **渠道结果未知（`unknown:` 标记）**：连续失败到最后仍是「说不清渠道到底退没退」的退款单会带 `unknown:` 前缀 —— 服务端 72 小时内**低频自动重放**（支付宝侧幂等，重复退不会双付），超 72 小时转**纯人工**。
- 🔴 **驳回前先核渠道后台**：对带 `unknown:` 标记**、或 `last_error` 留有关联渠道退款单号（渠道成功但回写失手的转人工形态）**的退款单，先登录支付宝商户后台核这笔**到底退没退**再决定驳回 —— 渠道已退而你驳回 = 金币也回滚 = 双付。

---

## 通知怎么上线（**三步**）

> 通知通道管理化片（2026-10-07）起：邮件告警（SMTP 五项）与三个 IM 告警通道（飞书 / 钉钉 / 企微，webhook 四项）从服务器 `.env` 搬进**管理页 →「通知通道」**（加密存储、掩码写、审计留痕）。**九项凭据各项怎么拿**见 `docs/ops/notify-onboarding.md`。与支付不同：通知通道是**现役设施**（服务器上邮件 + 企微已在用）⇒ 上线时**要把现役值搬过去**，别当成新功能空配。

**第 1 步：版本先上（打 tag 部署）** —— 先确认 `.env` 里根信任锚 `NOTIFY_CHANNEL_PULL_TOKEN` 已就位（见 ②「通知通道管理化片新增一个运维键」表；三端同值），再照 ⑦ 正常发布。⚠️ **部署会有一个空窗**：新版本上线到第 2 步填完之间的**几分钟里，通道处于「未配置」= 这期间真出告警会丢**（已登记、可接受）⇒ **部署后立即做第 2 步**。服务器上原来写在 `.env` 的九行**暂时都留着** —— 它是**回滚窗**（回滚到旧 tag 时旧容器照读 env）。

**第 2 步：管理页把九项填上** —— 登录管理页 →「通知通道」：**邮件（SMTP）** 5 行 + **IM 通道** 4 行逐项填。现役值照服务器 `.env` 里那九行旧键抄：`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `ALERT_EMAIL_TO` / `FEISHU_WEBHOOK_URL` / `WECOM_WEBHOOK_URL` / `DINGTALK_WEBHOOK_URL` / `DINGTALK_SECRET`（`邮件授权码` 已配置过 ⇒ 页面只显示指纹，照原值重填即可）。保存后**最多 30 秒生效**（不用重启、不用发版）；两组组尾会显示 `已就绪` / `未就绪（缺 N 项）` —— **两组都显示「已就绪」**才算填完。

**第 3 步：触发测试告警验收（真人项）** —— 照「监控」③ 的配方：停 `ftl-grafana` 2 分钟 ⇒ **邮箱收到真邮件 + 已配的 IM 群收到真消息**。再做一次**轮换演练**：企微后台重发 webhook ⇒ 管理页「企业微信机器人地址」覆盖 ⇒ 指纹**肉眼变化** ⇒ 再触发 ⇒ **新群收到**（全程不重启、不用发版 —— 手顺见 `notify-onboarding.md` §6）。全部通过 ⇒ 随时可删服务器 / 本机 `.env` 的九行（**不删也无害**：没有任何容器再读它们）。

**回滚**：验收未过要退回旧版 ⇒ 走 `deploy.sh` / `rollback.sh` **全量换 tag**（照 ⑧ 回滚）—— 送机 compose 取自**目标 tag**，九行 env 随旧 compose 一并回位。⚠️ **不要**手工 `IMAGE_TAG=… docker compose up -d` —— 那会拿**新** compose（九行已删）**静默裸奔**（通道全空还不报错）。

---

## 广告怎么开通（**激励视频 → 金币场每日救助**）

> 广告片（2026-10-12）起：金币场「每日救助」的激励视频走 **uni-ad 平台**（App 端）。出厂是**未配置**（`ad.reliefAdpid` 空 + 回调密钥未填 + `currency.reliefEnabled` 默认关）—— 玩家侧零变化。要开通，**平台侧先备好、管理页后填、开关最后**：

**第 0 步：确认 `.env` 里有 `AD_CHANNEL_PULL_TOKEN`（两端同值）** —— 广告回调密钥的拉取令牌（见 ②「广告片新增一个运维键」表）。⚠️ **漏了它，站看起来一切正常、管理页也能保存密钥，但每条真实回调都会 503、玩家看完广告永远不到账**（2026-10-18 测试服实锤）⇒ 补上后重建 `config-service` 与 `currency-service`：

```bash
$ cd /srv/pokergame
$ export IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord IMAGE_TAG=<当前的 tag>
$ docker compose --env-file .env -f docker-compose.yml up -d config-service currency-service
```

**第 1 步：uni-ad 后台备料** —— 实名 / 财务信息就绪 → 绑定应用 → 快捷广告 + Sigmob → 新建**激励视频广告位**（**必须开「服务器回调」**）→ 拿到两样东西：**广告位 id（adpid）** 与 **回调密钥**。

**第 2 步：平台后台配回调 URL** —— 在 uni-ad 广告位设置里把服务器回调地址填成（`<你的域名>` 换成真实域名）：

```
https://<你的域名>/ad/notify/uniad
```

**第 3 步：管理页填两项** —— 登录管理页：①「配置 → 广告」里把 `ad.reliefAdpid` 填成 adpid（**字符串**，照原文粘、别当数字）；②同页下方「广告回调」面板填**回调密钥**（掩码写：已配置后只显示指纹）。保存后 ≤60s 生效（不用重启、不用发版）。

**第 4 步：开救助开关 + 真机验收** —— 把 `currency.reliefEnabled` 改成 `true`，然后在 **App 真机**走完整链：完整观看 → 金币到账（「已领取救助 +N」）；**中途关闭**视频 → 不到账（专用文案）；当天再点 → 「今天已经领过了」。

**⚠️ 开启前确保 App 端已更新到带广告入口的版本**（旧版 App 仍会显示旧入口并**吃 404**）；**硬停 = `currency.reliefEnabled=false`**（`ad.reliefAdpid` 置空对已在大厅持旧配置的客户端**非即时下达**——别把置空当硬停）。

**第 5 步（可选）：换广告位** —— 新建广告位（同样开服务器回调）→ 管理页把 `ad.reliefAdpid` **覆盖**成新 adpid → 保存即生效。**新观看走新位**；旧凭证 / 在途观看不受影响。

**密钥轮换** —— 平台后台**重发回调密钥** → 管理页「配置 → 广告」页内的广告回调面板**覆盖写入** → 页面上**指纹肉眼变化** = 写进去了 → **下一次回调即生效**（全程不重启、不发版）。⚠️ 两步**连着做、挑低峰**：重发那一刻旧密钥即废，新钥没填上之前的回调会验签失败（玩家看完领不到）。

**回滚** —— 行为面：把 `ad.reliefAdpid` 置**空**（秒级，入口即暗）或 `currency.reliefEnabled` 改回 `false`；代码面：镜像 tag 回退（第四键空间表留库无害）。

**⚠️ edge 重建提醒（本片给门口加了 `/ad/notify/*` 路由）** —— `deploy/Caddyfile` **烤进边缘镜像**（`Dockerfile.edge`）⇒ 凡是**手工维护**的机器（本机开发栈）改过 Caddyfile，必须**重建门口**，否则回调进不来（404 ⇒ 玩家看完领不到钱）。两条命令（**逐字**）：

```bash
docker compose build edge
EDGE_HTTP_PORT=8080 EDGE_HTTPS_PORT=8443 docker compose --profile edge up -d --no-deps --wait edge
```

⚠️ **裸 `up -d` 会掉回 80/443**（丢了那两个端口键 = 用默认映射 —— 开发形态的门口地址就变了，环境纪律第 18 条）；**生产**由流水线构建镜像，打 tag 发布即包含本路由，无需手工重建。

---

## ⑨ App 包（⚠️ App **不能**依赖同源）

**为什么**（最容易踩的一条）：H5 跑在浏览器里，「`/api` 用同源」是天然成立的（页面本身就是门口发的）；但 **App 版没有「同源」这个概念** —— 代码里只对微信小程序做了特判，App 会被归到「浏览器类」⇒ 端点回退到「同源」⇒ 真机上那个「同源」是**手机自己** ⇒ **连不上**。所以 App 包必须在**构建时**把绝对地址写进去。

### 9.1 构建（在**开发机**的**项目根目录**跑）

```bash
$ VITE_WS_ENDPOINT=https://game.example.com VITE_API_BASE=https://game.example.com/api \
    pnpm --filter @fight-the-landlord/client build:app
```

**预期**：结尾

```
DONE  Build complete.
运行方式：打开 HBuilderX, 导入 dist\build\app 运行。
```

（本机实测逐字如上。）

**不一样怎么办**：上面这种「变量前缀」写法是 bash / Git Bash / Linux / macOS 的语法；**PowerShell** 要分行写：

```powershell
$env:VITE_WS_ENDPOINT="https://game.example.com"
$env:VITE_API_BASE="https://game.example.com/api"
pnpm --filter @fight-the-landlord/client build:app
```

**cmd**：`set "VITE_WS_ENDPOINT=https://game.example.com" && set "VITE_API_BASE=https://game.example.com/api" && pnpm --filter @fight-the-landlord/client build:app`
⚠️ **cmd 里变量要写成带引号的 `set "名=值"` 形态**（引号把「名字=值」整个括住，再跟 `&&`）—— 老式 `set 名=值` 会把 `&&` 前的**空格读进值里**，实测两个地址都带**尾空格**（而 9.2 的 grep 仍会通过，抓不到）。
⚠️ 命令必须在**项目根目录**跑（`pnpm --filter` 依赖 workspace 根）。

### 9.2 判别（**必做** —— 上面那条「不注入」也会 DONE）

```bash
$ grep -rl "https://game.example.com" apps/client/dist/build/app | wc -l
1
```

**预期**：**≥ 1**（本机实测：注入 ⇒ `1`，文件是 `app-service.js`；**不注入 ⇒ `0`** ⇒ 真机连不上）。

**不一样怎么办**：`0` ⇒ 地址没进产物 ⇒ 检查域名是否敲错、是否在**项目根目录**跑的、有没有把两个变量名写反（`VITE_API_BASE` 结尾要带 `/api`）。

### 9.3 出包与注意

- 用 HBuilderX 打开 `apps/client/dist/build/app` → 发行 → 原生App-云打包（包名/证书按界面填）。⚠️ HBuilderX 版本必须 ≥ 项目的编译器版本，否则真机上白屏且**无任何报错**。
- **H5 不受本节影响**：H5 走同源（默认值），不需要注入任何东西。
- 微信小程序是**另一套**构建入口（`scripts/build-mp-weixin.mjs`），本手册不涉及。
