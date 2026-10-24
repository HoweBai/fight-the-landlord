#!/usr/bin/env bash
# 起 / 收 conformance 用的真栈。**唯一的一份配方**（spec §9 B 段的交付物）——
# 本机与 CI 跑的是同一条命令、同一组注入值，否则「本机绿、CI 红」无从判读。
#
# 用法：conformance-stack.sh up | down
# 环境：
#   IMAGE_TAG_PULL  **非空** = 从 GHCR 拉这个 tag 的镜像（`release.yml` 的复用路径）；
#                   **空**（默认）= 本机构建（master 的 push 路径）。
#   EDGE_HTTP_PORT / EDGE_HTTPS_PORT  宿主发布端口（默认 8080/8443 —— **非特权端口**）
set -euo pipefail
cd "$(dirname "$0")/../.."

export EDGE_HTTP_PORT="${EDGE_HTTP_PORT:-8080}"
export EDGE_HTTPS_PORT="${EDGE_HTTPS_PORT:-8443}"
# ⚠️ 片⑦：管理面测试口令的**供给点**。与 `tools/conformance/src/lib/http.ts` 的
#    `ADMIN_PASSWORD` 常量**两处同源、必须逐字一致**（同族教训：DEFAULT_INTERNAL_TOKEN
#    的「两处不一致 ⇒ 用例全红而原因极难定位」，R96）。
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-conformance-admin-pass}"
IMAGE_TAG_PULL="${IMAGE_TAG_PULL:-}"
LOCAL_PREFIX="pokergame"
GHCR_PREFIX="ghcr.io/howebai/fight-the-landlord"
SERVICES=(api-gateway config-service currency-service douzero edge game-service payment-service robot-service room-service user-service prometheus grafana alertmanager alert-relay)
# ⚠️ 监控片（§2.11③）+ 货币片 + 支付片：14 项 —— retag 环据此把拉回来的镜像落回默认名。新增四项是监控容器里
#    带 `${IMAGE_PREFIX}-` 前缀的那四个（prometheus / grafana / alertmanager / alert-relay；
#    通知通道管理化片的 am-renderer **共享 alert-relay 镜像**、不新增名字 ⇒ 本列表不动）；
#    node-exporter 用官方镜像名（prom/node-exporter）、cadvisor 用官方现址名
#    （**官方 cadvisor 仓**——2026-10-03 订正；完整镜像名见 compose 的 cadvisor 块），两者都不是本仓前缀名、不在此列。

# ⚠️ 模式**只算一次**（终审 M12）：下面「拉取路径」与「up 带不带 --build」两处此前各自求值
#    **同一个谓词**（`IMAGE_TAG_PULL` 是否非空）、仅靠约定耦合 —— 若有一处被改翻，拉取路径会
#    **在刚 pull 回来的镜像上本地重建**：「复用刚推上去的镜像」这个契约就静默退化成
#    「第三次构建、且验证的是没人推过的产物」（R1314⑤）。⇒ 一个变量两处共用，翻不了单边。
PULL_MODE=0
if [ -n "$IMAGE_TAG_PULL" ]; then PULL_MODE=1; fi

# ── 支付配置管理化片 T14（规格 §5.4）：渠道值**不再经 env**（六项已退役 —— T11 compose 差异）──
# 渠道六键改为**管理面种子**：值逐字见规格 §5.4，落点 = 下面 up 末尾的种子块（经网关登录 +
# PUT → `pay_channel_config` 表）。本机与 CI 跑的是同一条命令、同一组值（同一条「唯一供给点」
# 纪律）。
# ── 节奏管理化片 T10（本片 ⚙️8.2）：六键**间隔基线**同样改为**管理面种子** —— 供给点 =
#    渠道种子段后的 `config_seed_put` 段（PUT `/api/admin/config/<key>`）；两 export
#    （`PAY_SCAN_INTERVAL_MS` / `PAY_RECONCILE_INTERVAL_MS`）随本片**退役**（compose 六行
#    同删 —— 六循环已读配置面，T1–T9）。
# 本段仍留：
#   · 两枚 env（⚙️13 dev 常量）——`PAY_CONFIG_ENC_KEY`（config-service 渠道加密主钥，
#     base64 32B）与 `PAY_CHANNEL_PULL_TOKEN`（config-service + payment-service 两端同值）。
#     两者都经 compose 的 `${VAR:-}` **空默认透传行**落进容器 ⇒ 必须在**任何 up 之前**
#     export（PULL_MODE 0/1 两条路径共用这一处）。
# ⚠️ 空默认的配套：不在这里 export ⇒ 容器内为空 ⇒「渠道块整体 503」—— 那是**裸
#    `docker compose up`** 的默认态（fail-closed）；conformance 起栈必须显式供给。
# ⚠️ 两枚 dev 常量与 `tools/conformance/src/run.ts` 启动处的 `??=` 供给**两处同源、必须
#    逐字一致**（R96 教训同族：两处不一致 ⇒ 用例全红而原因极难定位 —— 那边管 runner 触发的
#    重建点，这边管整栈首起）。
# ⚠️ `ALIPAY_TEST_FIXTURES` 保留：种子块仍要用它（base64(app-private.pem) /
#    base64(alipay-public.pem)）；仓内只有**测试**密钥夹具（生产密钥永不入仓、只存服务器
#    .env）。夹具缺失 ⇒ node 读文件时响亮失败（set + 失败分支），不留「空密钥起栈」的半态。
export PAY_CONFIG_ENC_KEY="${PAY_CONFIG_ENC_KEY:-ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=}"
export PAY_CHANNEL_PULL_TOKEN="${PAY_CHANNEL_PULL_TOKEN:-dev-pay-channel-pull-token-change-in-production}"
# ── 通知通道管理化片 T15（规格 ⚙️13/§5.4）：通知拉取令牌**三持有**（config-service + alert-relay
#    + am-renderer）的**初起整栈供给点**。缺它 ⇒ 三容器 token 空串 ⇒ 拉取全拒（empty = 未设 的
#    fail-closed）——那是**裸 `docker compose up`** 的默认态；conformance 起栈必须显式供给。
# ⚠️ dev 常量与 `tools/conformance/src/run.ts` 启动处的 `??=` 供给**两处同源、必须逐字一致**
#    （R96 教训同族：两处不一致 ⇒ 用例全红而原因极难定位 —— 那边管 runner 触发的重建点，
#    这边管整栈首起；与上方两枚支付键同一纪律）。
export NOTIFY_CHANNEL_PULL_TOKEN="${NOTIFY_CHANNEL_PULL_TOKEN:-dev-notify-channel-pull-token-change-in-production}"
# ── 广告片 T10（规格 §2.3/§5.4）：第四键空间（广告回调密钥）拉取令牌的**初起整栈供给点**
#    —— **两持有** = config-service + currency-service（≠ 通知的三持有）。缺它 ⇒ 两容器 token
#    空串 ⇒ `config.adChannel.get` 全拒（empty = 未设 的 fail-closed）；消费侧无 lastGood
#    ⇒ 回调按瞬态 5xx —— 那是**裸 `docker compose up`** 的默认态；conformance 起栈必须显式供给。
# ⚠️ dev 常量与 `tools/conformance/src/run.ts` 启动处的 `??=` 供给**两处同源、必须逐字一致**
#    （R96 教训同族：两处不一致 ⇒ 用例全红而原因极难定位；与上方支付/通知三键同一纪律）。
# ⚠️ 字面与 T7 测内 `DEV_AD_PULL_TOKEN`（`config.rpc.test.ts`）**逐字一致**（T7 交 T10 台账项）。
export AD_CHANNEL_PULL_TOKEN="${AD_CHANNEL_PULL_TOKEN:-dev-ad-channel-pull-token-change-in-production}"
ALIPAY_TEST_FIXTURES="$PWD/tools/conformance/fixtures/alipay-test"

case "${1:-}" in
  up)
    # ⚠️ `--profile edge` 是**全局参数**（写在子命令前），且**必须**带：
    #    不带它时 override 把门口标了 `profiles: ["edge"]` ⇒ 门口根本不起，
    #    而 conformance 的 `slice-07.3-edge` 需要它。
    if [ "$PULL_MODE" = 1 ]; then
      printf '=== [stack] 从 GHCR 拉 %s:%s ===\n' "$GHCR_PREFIX" "$IMAGE_TAG_PULL"
      echo "${GHCR_TOKEN:?拉取路径需要 GHCR_TOKEN}" \
        | docker login ghcr.io -u "${GHCR_USER:?}" --password-stdin
      # ⚠️ 登出**必须**在任何失败路径上生效（R1306 三层登出的第 ① 层）。
      trap 'docker logout ghcr.io' EXIT
      IMAGE_PREFIX="$GHCR_PREFIX" IMAGE_TAG="$IMAGE_TAG_PULL" \
        docker compose --profile edge -f docker-compose.yml pull
      # ⚠️ **落回默认名**（`pokergame-<svc>:latest`）。理由**不是**好看：`slice-07.2-deploy` 的
      #    `DEGRADED_IMAGE` 常量把 `pokergame-api-gateway:latest` 写成
      #    `checks.eq(imageCheck.status, 0, …)` 的**硬前提**（不是 info 跳过）
      #    ⇒ 不落回默认名，CI 上「降级 ⇒ 503」那一段必红。
      #    （终审 M1：这里原先引的是**行号** —— 它会随文件漂移；改引**符号**。）
      for svc in "${SERVICES[@]}"; do
        docker tag "$GHCR_PREFIX-$svc:$IMAGE_TAG_PULL" "$LOCAL_PREFIX-$svc:latest"
      done
      docker logout ghcr.io
      trap - EXIT
    fi
    # ⚠️ 用**开发形态**（不带 `-f` ⇒ 自动合并 override）+ 门口 profile：
    #    29 个切片里的绝大多数按 `localhost:3000` 等**宿主发布端口**直连服务，
    #    那套端口只存在于 override ⇒ 生产单文件形态跑不动它们。
    # ⚠️ 监控片（§2.11①）：`--profile monitoring` 与 `--profile edge` **并写**（override 里六块标了
    #    该 profile，不带它监控六容器根本不起）；本片真栈判据（C1/C2/C5/C7/C10–C12）要它们在场。
    #    **两处 up（PULL_MODE 0/1）都带**——同一个谓词只靠一处带会退化成「跑了一半的栈」。
    if [ "$PULL_MODE" = 1 ]; then
      # ⚠️ **不带 `--build`**：这一条路径用的是刚 pull 回来、并已 tag 成默认名的镜像 ——
      #    带上它会用**本地源码**重建 14 个镜像、把上面的 tag 覆盖掉，于是
      #    ① 构建次数从 2 变 3（R1314⑤）② 验证的**不是**推上去的那个产物。
      docker compose --profile edge --profile monitoring up -d --wait --wait-timeout 900
    else
      # ⚠️ cadvisor 无需供给（2026-10-03 订正）：官方 cadvisor 仓的 `v0.60.6` 字面名（完整名见 compose），
      #    `up --build` 对无 `build:` 的服务会自动 pull（双端实测可达）；旧的「GHCR→gcr 兜底 + retag」
      #    供给段已删除（gcr 路径的版本 tag 已不存在）。
      docker compose --profile edge --profile monitoring up -d --build --wait --wait-timeout 900
    fi
    docker compose ps

    # ── 支付片 T16（规格 ⚙️14）：stub 支付宝容器（conformance 专用；双向金标）─────────────
    # 固定名 `ftl-alipay-stub`（**白吃 down 段的 `^/ftl-` 残留检查**；down 段另显式
    # `docker rm -f` —— 双保险）、`--rm` 防意外残留、端口 8801、入 compose 网络
    # （payment-service 经网内 DNS `ftl-alipay-stub:8801` 访问；**不发布宿主端口**——
    # 切片驱动控制面走 `docker exec … wget http://127.0.0.1:8801/_control/…`）。
    # 起法 = ⚙️14 逐字 + **第二只读挂载**（`fixtures/alipay-test` → `/keys:ro`；偏离登记随
    # T16 收口）：双向金标要求 stub 同时持「应用公钥（验我们请求签名）」与「渠道私钥
    # （签响应/通知）」——四 PEM 是本仓唯一入仓的测试密钥夹具（T6 同一对）。
    # ⚠️ MSYS 纪律（照 `scripts/ops/backup.sh:7-11` / `restore-drill.sh:54-56`）：关掉 MSYS
    #    的路径转换（容器侧 `/app`、`/keys`、`8801` 必须原样过去），宿主侧 `-v` 源**手工转**
    #    原生形态（Linux/CI 无 cygpath ⇒ no-op）。
    export MSYS_NO_PATHCONV=1
    STUB_MOUNT="$PWD/tools/conformance/stub"
    KEYS_MOUNT="$PWD/tools/conformance/fixtures/alipay-test"
    if command -v cygpath >/dev/null 2>&1; then
      STUB_MOUNT="$(cygpath -w "$STUB_MOUNT")"
      KEYS_MOUNT="$(cygpath -w "$KEYS_MOUNT")"
    fi
    # 幂等：上一轮没跑 down 就重跑 up 时，先收掉旧实例（固定名决定它是**可确定清理**的）。
    docker rm -f ftl-alipay-stub >/dev/null 2>&1 || true
    docker run -d --rm --name ftl-alipay-stub --network "${LOCAL_PREFIX}_ftl-platform" \
      -v "$STUB_MOUNT:/app:ro" -v "$KEYS_MOUNT:/keys:ro" \
      node:20-alpine node /app/alipay-stub.mjs
    # 就绪自证（有界 20s）：起不来 ⇒ **响亮失败**（不让栈挂在半态留给切片当环境假红）。
    STUB_READY=0
    for _ in $(seq 1 40); do
      if docker exec ftl-alipay-stub wget -q -O /dev/null http://127.0.0.1:8801/health 2>/dev/null; then
        STUB_READY=1
        break
      fi
      sleep 0.5
    done
    if [ "$STUB_READY" != 1 ]; then
      printf '❌ [stack] ftl-alipay-stub 20s 内未就绪；日志尾部：\n' >&2
      docker logs ftl-alipay-stub 2>&1 | tail -20 >&2 || true
      exit 1
    fi
    printf '=== [stack] ftl-alipay-stub 就绪（网内 http://ftl-alipay-stub:8801）===\n'

    # ── 支付配置管理化片 T14（规格 §5.4）：渠道六键种子化（管理面 PUT ×6）──────────────────
    # 栈就绪后把渠道六键经**管理面**写进 `pay_channel_config`（本片起渠道凭据的唯一落点；
    # 六项 env 已退役，T11）。种子值逐字 = 规格 §5.4：gatewayUrl=`http://ftl-alipay-stub:8801` ·
    # appId=`9021000000000000` · privateKey=base64(app-private.pem) · publicKey=base64(alipay-public.pem) ·
    # sellerId=`2088721087500000` · **publicBaseUrl=`https://localhost:8443` 字面**（slice-21 三处
    # 断言是字面 8443；动态 ${EDGE_HTTPS_PORT} 在自定义口下必红，S-2 订正）。
    # ⚠️ appId/sellerId 必须与 `tools/conformance/stub/alipay-stub.mjs` 的两个常量**逐字一致**
    #    （两处同源；不一致 ⇒ 回调四项校验不过 ⇒ slice-21 组④ 当场红）。
    # ⚠️ 就绪条件现成：上面两条 up 均 `--wait --wait-timeout 900` + 全服务 healthcheck（F7 已实测）；
    #    登录仍加**有界重试 3 次**（config-service 刚 healthy 的边界保险，F7）。
    # ⚠️ `down` 无需清理：种子只落 DB 行（MySQL 命名卷），PUT 幂等（F7 实测）。
    # ⚠️ 任一环节失败 ⇒ **响亮 exit 1** 并打印响应尾部（照上面 stub 就绪自证同款纪律 ——
    #    不留给切片当「环境假红」）。body 构造/响应解析一律 `node -e`（jq 不保证存在）；
    #    PEM 两键由 node 读夹具文件拼 JSON（长 base64 不经 bash 拼接，绕开引号地狱）。
    SEED_GATEWAY="http://localhost:3000"   # 网关（override 发布 3000；CI 与本机同 —— §5.4）
    # ⚠️ 夹具目录给 node 前先转**原生形态**：Git Bash 的 `/d/...` 是 MSYS 形态、node.exe 读不了
    #    （cygpath 在 Linux/CI 不存在 ⇒ no-op；照上面 stub/keys 挂载点的同款处置）。
    SEED_PEM_DIR="$ALIPAY_TEST_FIXTURES"
    if command -v cygpath >/dev/null 2>&1; then
      SEED_PEM_DIR="$(cygpath -w "$SEED_PEM_DIR")"
    fi
    seed_body_value() {  # $1 = 明文值 ⇒ `{"value":…}`（值走 env 给 node：无 MSYS 转换面）
      SEED_VAL="$1" node -e 'process.stdout.write(JSON.stringify({ value: process.env.SEED_VAL }))'
    }
    seed_body_pem() {  # $1 = PEM 文件名（在 $ALIPAY_TEST_FIXTURES 下）⇒ base64 后的 `{"value":…}`
      SEED_PEM_FILE="$SEED_PEM_DIR/$1" node -e 'process.stdout.write(JSON.stringify({ value: require("fs").readFileSync(process.env.SEED_PEM_FILE).toString("base64") }))'
    }
    seed_put() {  # $1 = 键；$2 = 构造好的 body；非 `saved:true` ⇒ 响亮 exit 1（响应尾部入 stderr）
      local key="$1" encoded res
      if [ -z "$2" ]; then
        printf '❌ [stack] 渠道种子：%s 的 body 构造为空（node 读夹具失败？）；中止\n' "$key" >&2
        exit 1
      fi
      encoded="$(SEED_KEY="$key" node -e 'process.stdout.write(encodeURIComponent(process.env.SEED_KEY))')"
      res="$(curl -sS --max-time 30 -X PUT "$SEED_GATEWAY/api/admin/pay-channel/$encoded" \
        -H "Authorization: Bearer $SEED_TOKEN" -H 'Content-Type: application/json' -d "$2" 2>&1 || true)"
      if ! printf '%s' "$res" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>{let ok=false;try{ok=(JSON.parse(s).data||{}).saved===true}catch{}process.exit(ok?0:1)})'; then
        printf '❌ [stack] 渠道种子：PUT %s 失败（未返回 saved:true）；响应尾部：\n' "$key" >&2
        printf '%s\n' "$res" | tail -c 400 >&2
        exit 1
      fi
    }
    SEED_TOKEN=""
    SEED_LOGIN_RES=""
    for seed_attempt in 1 2 3; do
      SEED_LOGIN_RES="$(curl -sS --max-time 30 -X POST "$SEED_GATEWAY/api/admin/login" \
        -H 'Content-Type: application/json' \
        -d "$(node -e 'process.stdout.write(JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "" }))')" \
        2>&1 || true)"
      SEED_TOKEN="$(printf '%s' "$SEED_LOGIN_RES" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>{try{process.stdout.write(String((JSON.parse(s).data||{}).token||""))}catch{process.stdout.write("")}})')"
      if [ -n "$SEED_TOKEN" ]; then break; fi
      printf '⚠️ [stack] 渠道种子：管理登录第 %s/3 次未成功（config-service 刚 healthy 的边界保险），2s 后重试\n' "$seed_attempt"
      sleep 2
    done
    if [ -z "$SEED_TOKEN" ]; then
      printf '❌ [stack] 渠道种子：管理登录 3 次均失败（ADMIN_PASSWORD 与 config-service 引导口令是否一致？）；响应尾部：\n' >&2
      printf '%s\n' "$SEED_LOGIN_RES" | tail -c 400 >&2
      exit 1
    fi
    seed_put 'pay.channel.gatewayUrl' "$(seed_body_value 'http://ftl-alipay-stub:8801')"
    seed_put 'pay.channel.appId' "$(seed_body_value '9021000000000000')"
    seed_put 'pay.channel.privateKey' "$(seed_body_pem 'app-private.pem')"
    seed_put 'pay.channel.publicKey' "$(seed_body_pem 'alipay-public.pem')"
    seed_put 'pay.channel.sellerId' "$(seed_body_value '2088721087500000')"
    seed_put 'pay.channel.publicBaseUrl' "$(seed_body_value 'https://localhost:8443')"
    printf '=== [stack] 渠道六键种子完成（pay-channel 已配置 ×6）===\n'

    # ── 节奏管理化片 T10（本片 ⚙️8.2）：六键间隔基线种子化（管理面 PUT ×6）───────────────────
    # 六键 env 已退役（本片 compose 删行 + 上面两 export 删；T1–T9 六循环改读配置面）——
    # 间隔一律经**管理面**写 `platform_config`（本片起 conformance 的基线供给点）。基线逐字：
    #   · `pay.scanIntervalMs` / `pay.reconcileIntervalMs` = **2000**（= 原 export 值 ⇒ 行为
    #     等价；**观测基线**、非出厂种子 60000 / 86400000——切片判据依赖 2000ms 快节奏）；
    #   · `currency.reconcileIntervalMs` / `risk.scanIntervalMs` / `risk.devicesCleanupIntervalMs`
    #     / `record.cleanupIntervalMs` = **3600000**（= 出厂种子 = 代码缺省 ⇒ 行为等价）。
    # ⚠️ **跨 run 残留收拢点**：每次 up 都把六键归一到基线 —— 上一 run 切片 PUT 注入后崩掉的
    #    残值不会渗进下一 run（T12–T15 的还原基线引用点即此）。
    # ⚠️ 与 `tools/conformance/src/run.ts` 启动处的 `??=` 供给**无关**：六键不在该面（声明性
    #    核销，⚙️8.4）——那边仍只供 ADMIN_PASSWORD 等 dev 常量。
    # ⚠️ body 必须 = `{"value": <JSON 数字>}` —— `parseIntervalMs` 拒字符串 ⇒ **不得**照抄
    #    上面渠道 `seed_put` 的 SEED_VAL 字符串形态（故另写数值版助手 `config_seed_put`）。
    # ⚠️ 失败纪律同渠道种子：非 `saved:true` ⇒ **响亮 exit 1** + 响应尾部入 stderr；网关/登录/
    #    重试设施复用上面渠道种子段（SEED_GATEWAY / SEED_TOKEN）。
    config_seed_put() {  # $1 = 键；$2 = 数值（JSON 数字，非字符串——parseIntervalMs 拒字符串）
      local key="$1" num="$2" encoded res
      encoded="$(SEED_KEY="$key" node -e 'process.stdout.write(encodeURIComponent(process.env.SEED_KEY))')"
      res="$(curl -sS --max-time 30 -X PUT "$SEED_GATEWAY/api/admin/config/$encoded" \
        -H "Authorization: Bearer $SEED_TOKEN" -H 'Content-Type: application/json' \
        -d "$(SEED_NUM="$num" node -e 'const n=Number(process.env.SEED_NUM);process.stdout.write(JSON.stringify({value:n}))')" 2>&1 || true)"
      if ! printf '%s' "$res" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>{let ok=false;try{ok=(JSON.parse(s).data||{}).saved===true}catch{}process.exit(ok?0:1)})'; then
        printf '❌ [stack] 节奏种子：PUT %s 失败（未返回 saved:true）；响应尾部：\n' "$key" >&2
        printf '%s\n' "$res" | tail -c 400 >&2
        exit 1
      fi
    }
    config_seed_put 'pay.scanIntervalMs' 2000
    config_seed_put 'pay.reconcileIntervalMs' 2000
    config_seed_put 'currency.reconcileIntervalMs' 3600000
    config_seed_put 'risk.scanIntervalMs' 3600000
    config_seed_put 'risk.devicesCleanupIntervalMs' 3600000
    config_seed_put 'record.cleanupIntervalMs' 3600000
    printf '=== [stack] 节奏六键种子完成（基线 2000/2000/3600000×4）===\n'

    # ── 广告片 T10 / T0 回填（规格 v1.4 §2.3/§2.4/§8）：第四键空间密钥种子化（管理面 PUT ×1）──
    # 单键 `ad.callbackSecret` 经**管理面**写 `ad_channel_config`（本片回调密钥的唯一落点）——
    # 取 **pay 形态**（栈种子；notify 九键取「切片内自种」，本键空间按规格 §1.3 不计入该形态）。
    # 种子值：conformance 测试夹具单枚**共享密钥**（T0 回填：sign = sha256(secret:trans_id)
    # 的对称形态）——与切片签名面（`tools/conformance/src/lib/ad-callback.ts` 装载同一文件）
    # **同源**：验签现拉的入库值必须与签名值 byte-exact 一致，否则全量 bad_sign 假红。
    # 生成：`node tools/conformance/fixtures/ad-callback/generate-fixtures.mjs`。
    # ⚠️ 失败纪律/登录/重试设施复用上面渠道种子段（SEED_GATEWAY / SEED_TOKEN / node -e body）。
    # ⚠️ 幂等：种子只落 DB 行（MySQL 命名卷），PUT 幂等；重跑 up 即覆盖回夹具现值；
    #    --regenerate 换密钥后必须重跑 up（否则入库旧值与签名新值错配）。
    AD_CALLBACK_SECRET_FILE="$PWD/tools/conformance/fixtures/ad-callback/callback-secret.txt"
    if [ ! -s "$AD_CALLBACK_SECRET_FILE" ]; then
      printf '❌ [stack] 广告回调共享密钥夹具缺失或为空：%s\n' "$AD_CALLBACK_SECRET_FILE" >&2
      printf '    先跑：node tools/conformance/fixtures/ad-callback/generate-fixtures.mjs\n' >&2
      exit 1
    fi
    AD_CALLBACK_SECRET="$(cat "$AD_CALLBACK_SECRET_FILE")"
    ad_seed_put() {  # $1 = 键；$2 = 构造好的 body；非 `saved:true` ⇒ 响亮 exit 1（响应尾部入 stderr）
      local key="$1" encoded res
      if [ -z "$2" ]; then
        printf '❌ [stack] 广告种子：%s 的 body 构造为空；中止\n' "$key" >&2
        exit 1
      fi
      encoded="$(SEED_KEY="$key" node -e 'process.stdout.write(encodeURIComponent(process.env.SEED_KEY))')"
      res="$(curl -sS --max-time 30 -X PUT "$SEED_GATEWAY/api/admin/ad-channel/$encoded" \
        -H "Authorization: Bearer $SEED_TOKEN" -H 'Content-Type: application/json' -d "$2" 2>&1 || true)"
      if ! printf '%s' "$res" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>{let ok=false;try{ok=(JSON.parse(s).data||{}).saved===true}catch{}process.exit(ok?0:1)})'; then
        printf '❌ [stack] 广告种子：PUT %s 失败（未返回 saved:true）；响应尾部：\n' "$key" >&2
        printf '%s\n' "$res" | tail -c 400 >&2
        exit 1
      fi
    }
    ad_seed_put 'ad.callbackSecret' "$(seed_body_value "$AD_CALLBACK_SECRET")"
    printf '=== [stack] 广告回调密钥种子完成（ad-channel 已配置 ×1；共享密钥夹具同源）===\n'
    ;;
  down)
    # ⚠️ `down` **删不掉**带 profile 的容器（R1209）⇒ 必须先按 profile 点名删门口，
    #    否则下一轮的「无残留」判据会测到**旧镜像**（空测）。
    docker compose --profile edge rm -sf edge || true
    # 监控片（§2.11②）：同 R1209 —— 七监控容器（六 + 通知通道管理化片的 am-renderer）也必须
    #    **点名**删（`down` 对带 profile 的服务整块交白卷）；漏删 ⇒ 下一轮的「无残留」判据同样
    #    会测到旧镜像（空测）。
    docker compose --profile monitoring rm -sf prometheus grafana alertmanager node-exporter cadvisor alert-relay am-renderer || true
    # ⚠️ **不带 `-v`**：本机这么跑会连命名卷（MySQL 数据）一起删掉。
    docker compose down
    # 支付片 T16（⚙️14）：stub 是 `docker run` 起的（**不在 compose 管理面**）⇒ compose down
    # 删不到它；固定名会被下面的 `^/ftl-` 残留检查命中 ⇒ **必须在 down 之后、残留检查之前**
    # 显式删（`|| true` 吞「本来就不存在」——上一轮 up 失败/手工清过都不算收尾失败）。
    docker rm -f ftl-alipay-stub || true
    # 残留检查（响亮，不静默）。
    left="$(docker ps -a --filter 'name=^/ftl-' --format '{{.Names}}' | tr '\n' ' ')"
    if [ -n "$left" ]; then printf '❌ [stack] 收尾后仍有容器：%s\n' "$left" >&2; exit 1; fi
    printf '=== [stack] 收尾干净（无 ftl-* 容器）===\n'
    ;;
  *)
    printf '用法：%s up|down\n' "$0" >&2
    exit 2
    ;;
esac
