# J11（douzero 并发）复现命令与读数留档 —— 片② Task 9

**为什么有这份文档**：J11 的阈值 `K=60` 与「20/20 成功、0 连接重置」两个断言锚在**实测**上
（设计层：修后 ≈14.5×、把 backlog 改回 5 的变异 ≈409×），而 Task 9 的 conformance 判据必须
可复现、可审计。⚠️ 留档放**这里**（git 入库），**不放** `.superpowers/`（那里被 gitignore）。

- 判据载体（唯一真源）：`tools/conformance/src/slices/slice-13-ai-rollout.ts` 组①（`J11_SCRIPT`）
- 设计层探针（更早的基准读数）：`scripts/probes/2026-10-01-douzero-concurrency/`
- 规格：`docs/superpowers/specs/2026-10-01-ai-rollout-spec.md` §3 J11；设计层 §8 J11

**vantage 事实（J11 的红线）**：必须**容器内**取证。宿主 → 发布端口（2021）那条路有 ~264ms
的常量惩罚，会把 backlog=5 的排队时间淹没 —— 设计层实测：宿主视角对未修复代码也**几乎全绿**
（比值仅 5.1×、0 失败）。所以官方跑法是 `docker exec` 进**在跑的** `ftl-douzero` 发请求。

## 官方复现（整片，含组①读数）

```bash
pnpm --filter @fight-the-landlord/conformance build
node tools/conformance/dist/run.js slice-13-ai-rollout      # 组① 打印 J11 读数行
```

## 手工复现（只跑 J11，Git Bash / Windows）

⚠️ `MSYS_NO_PATHCONV=1` 是**必需**的（否则 Git Bash 的路径转写会咬人；本命令没有 `-w`，但保持同一纪律）。
脚本与切片里的 `J11_SCRIPT` **可执行逻辑一致**（经逐行 `diff` 对照，差异仅两处非语义项：
预热注释的措辞/位置、`out` 字面量的折行 —— 不是逐字一致；本处是一份便于手工执行的副本，
判据以切片为准，改判据请改切片）。

```bash
MSYS_NO_PATHCONV=1 docker exec -i ftl-douzero python - \
  '{"position":"landlord_up","hand":[3,4,5],"bottom_cards":[],"last_move":[5],"last_move_position":"landlord","num_cards_left":{"landlord":5,"landlord_down":5,"landlord_up":3},"played_cards_landlord":[],"played_cards_landlord_down":[],"played_cards_landlord_up":[],"card_play_action_seq":[],"must_play":true}' <<'PY'
import http.client, json, statistics, sys, threading, time

FIXTURE = sys.argv[1]
N = 20

def one():
    c = http.client.HTTPConnection("localhost", 2021, timeout=30)
    try:
        c.request("POST", "/decide_play", FIXTURE, {"Content-Type": "application/json"})
        r = c.getresponse()
        r.read()
        return r.status
    finally:
        c.close()

try:
    one()                     # 预热 1 次（不计入基线）
except Exception:
    pass

serial = []
for _ in range(10):
    t0 = time.perf_counter()
    try:
        one()
    except Exception:
        pass
    serial.append((time.perf_counter() - t0) * 1000.0)

results = [None] * N

def worker(i):
    t0 = time.perf_counter()
    try:
        st = one()
        results[i] = ("ok" if st == 200 else "HTTP " + str(st), (time.perf_counter() - t0) * 1000.0)
    except Exception as e:
        results[i] = (type(e).__name__, (time.perf_counter() - t0) * 1000.0)

threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
t0 = time.perf_counter()
for t in threads:
    t.start()
for t in threads:
    t.join()
total_ms = (time.perf_counter() - t0) * 1000.0

ok = sum(1 for r in results if r and r[0] == "ok")
resets = sum(1 for r in results if r and r[0] == "ConnectionResetError")
errors = ["#" + str(i) + ":" + str(r[0]) for i, r in enumerate(results) if r and r[0] != "ok"]
conc = [r[1] for r in results if r]
out = {
    "ok": ok, "resets": resets, "errors": errors,
    "p50_serial_ms": round(statistics.median(serial), 3),
    "p50_conc_ms": round(statistics.median(conc), 3),
    "total_ms": round(total_ms, 1),
    "serial_ms": [round(x, 3) for x in serial],
    "conc_ms": [round(x, 3) for x in conc],
}
print("J11_RESULT " + json.dumps(out))
PY
```

## 本次留档读数（2026-10-01，Windows 开发机，容器内 vantage）

环境：`ftl-douzero` @ `sha256:8ea8362d215b…`（片② Task 5 的构建）；载荷 = 判别局面（同上 JSON）。
断言口径：`ok === 20 && resets === 0` 且 `p50_conc ≤ K × p50_serial`（**K=60**，同变体自比）。

| 执行（按时间序） | ok | resets | p50_serial | p50_conc | 比值 | 20 路总耗时 |
|---|---|---|---|---|---|---|
| 组① 第 1 跑（slice-13 首跑，重建 robot-service 之前） | 20/20 | 0 | 2.196 ms | 7.406 ms | **3.4×** | 22.8 ms |
| 组① 第 2 跑（重建 robot-service 之后） | 20/20 | 0 | 2.202 ms | 10.330 ms | **4.7×** | 22.3 ms |
| 组① 第 3 跑（最终留档跑，日志 `.superpowers/sdd/2026-09-30-ai-rollout/logs/task-9-slice-13-green.log`） | 20/20 | 0 | 2.173 ms | 7.816 ms | **3.6×** | 23.0 ms |

对照锚（设计层，同一台机器、更早的一天）：**修后 ≈14.5×**（58ms/4.0ms）、**变异（backlog=5）≈409×**
（1022ms/2.5ms）⇒ 本机现读数 3.4–4.7× 落在「健康」侧，距 K=60 有 12× 以上裕度；
变异侧 409× 高过阈值近 7×（阈值两端都有余量）。

## 换环境后怎么重新校准

1. 重跑上面的手工命令 3 次；若「修后」比值系统性上移，先查是不是又有人在宿主侧看（vantage 错）。
2. 若要验证 K 的上界仍有判别力：把 `ThreadingHTTPServer` 子类的 `request_queue_size` 临时改回
   `5`（并单线程化）复跑 —— 期望 ConnectionResetError + 1s 级尾延迟（T5 报告 §④ 有 6/6 红的 A/B 记录）。
