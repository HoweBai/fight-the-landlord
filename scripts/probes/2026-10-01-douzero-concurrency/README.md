# DouZero 并发取证探针（2026-10-01 · 片② 设计层）

**为什么入库**：片② 的设计层（`docs/superpowers/specs/2026-10-01-ai-rollout-design.md` §2）用这些读数**推翻了交接文档 §3.1 的两条「实测事实」**（265ms / 3.8 决策每秒），并据此改判了用户裁决 4 的落地形态（只多线程，不引入多进程）。判据 J11 的阈值 K=60 也锚在这里 ⇒ 必须可复现、可审计。

**怎么跑**（都需要一个在跑的 `ftl-douzero` 容器；脚本按容器内 `/app` 布局写）：

```bash
# ① 进程内/线程扩展性：把单次决策拆成 Python(GIL) 与 ONNX(释放 GIL) 两段
docker exec -i -w /app ftl-douzero python - < probe-concurrency.py

# ② 容器内 HTTP vs 进程内（HTTP 只多 ~1ms）
docker exec -i -w /app ftl-douzero python - < probe-http.py

# ③ backlog 假说 + intra_op 配比（A/B：单线程 backlog=5 vs 多线程 backlog=128）
docker exec -i -w /app ftl-douzero python - < probe-backlog.py

# ④ 线程 vs 单线程 A/B（同容器同载荷）
docker exec -i -w /app ftl-douzero python - < probe-thread-ab.py

# ⑤ 容器↔容器（生产路径：robot-service → douzero:2021）
docker cp probe-c2c.mjs ftl-robot-service:/tmp/ && docker exec -w /tmp ftl-robot-service node probe-c2c.mjs

# ⑥ 宿主视角（证明宿主 vantage 看不出 backlog 缺陷 —— 判据必须容器内取证的依据）
node probe-host-conc.mjs
```

**关键读数**（逐条誊写在设计文档 §2）：

> ⚠️ **下表是「设计期」的读数**（那时服务只载 **3** 个模型）。片② 之后它同时载 **9** 个（3 档 × 3 位置），
> 单次决策实测升到约 **6–8ms**（本机 2026-10-01 复跑：HTTP 中位 6.0ms / 进程内 8.0ms）——**结论不变**
> （数量级仍在 ms 级；真正的瓶颈是监听队列，见下表最后两行）。

| 测点 | 读数 |
|---|---|
| 进程内 `_act()` | 4.2 ms（build 0.2 + obs 1.1 + run 2.9） |
| 容器内 HTTP | 5.0 ms（`/health` 0.5 ms） |
| **容器↔容器（生产路径）** | **5.8 ms**（max 21.5） |
| 宿主 → 容器（发布端口） | **264 ms**（常量惩罚；交接那 265ms 的来源） |
| 20 路并发 · 现役（单线程 + backlog=5） | 中位 1022 ms · 14.4/s · **5/20 连接重置** |
| 20 路并发 · 修复后（线程 + backlog=128） | 中位 58 ms · 244/s · **0 失败** |
| 宿主视角的同一变异 | 比值仅 5.1×、**0 失败** ⇒ **看不出缺陷** |

⚠️ 这些是**一次性人工程序**（不是 CI 常跑判据）：改动 douzero 的并发形态后若要复验，重跑上面的命令即可。
🔴 **片② 后本目录已同步到新的 `server.py`**（`sessions` 变成 `{model: {position}}`、`_act(model, position, infoset)`、模型路径带 `<model>/`）—— 2026-10-01 复跑 `probe-http.py` 通过。若你再改 `server.py` 的形状，**这批脚本要跟着改**（它们直接 import 服务模块，不做兼容层）。
