# DouZero Service

DouZero 强化学习模型的 ONNX 推理服务，供 Go 游戏服务端通过 HTTP 调用。

服务同时加载 **3 档策略 × 3 个位置 = 9 个 ONNX**（sl / douzero_WP / douzero_ADP），
按请求体的 `model` 字段选档（缺省 `douzero_WP`）。

## 模型目录布局

```
douzero/models/
├── sl/            landlord.onnx  landlord_down.onnx  landlord_up.onnx
├── douzero_WP/    landlord.onnx  landlord_down.onnx  landlord_up.onnx
└── douzero_ADP/   landlord.onnx  landlord_down.onnx  landlord_up.onnx
```

即 `models/<model>/<position>.onnx`，`model ∈ {sl, douzero_WP, douzero_ADP}`、
`position ∈ {landlord, landlord_down, landlord_up}`。九个文件已入库，随镜像出货。

## 本地调试

```bash
cd douzero

# 安装依赖
uv sync

# 启动服务（缺失的 ONNX 才会触发下载；下载失败/断网只打印不中断启动）
uv run python server.py
# 监听 :2021
```

环境变量：

| 变量             | 说明     | 默认值     |
| ---------------- | -------- | ---------- |
| `DOUZERO_MODELS` | 模型目录 | `./models` |
| `PORT`           | 监听端口 | `2021`     |

## Docker 构建

```bash
# 构建镜像
docker build -t palemoky/fight-the-landlord-douzero:latest ./douzero

# 也可以通过 docker compose 一起构建
docker compose build douzero
```

## Go 侧启用

`config.yaml`：

```yaml
ai:
  enabled: true
  douzero_enabled: true
  douzero_url: "http://localhost:2021" # 本地调试
  # douzero_url: "http://douzero:2021"  # Docker Compose
```

## API

### `POST /decide_play`

```json
// 请求
{
  "model": "douzero_WP",           // 可选：sl | douzero_WP | douzero_ADP；缺省 douzero_WP
  "position": "landlord",
  "hand": [3, 5, 7, 14, 17],
  "bottom_cards": [17, 20, 30],
  "played_cards_landlord": [],
  "played_cards_landlord_down": [],
  "played_cards_landlord_up": [],
  "card_play_action_seq": [],
  "num_cards_left": {"landlord": 20, "landlord_down": 17, "landlord_up": 17},
  "last_move": [],
  "last_move_position": "",
  "must_play": true
}

// 响应
{"action": [3, 5]}   // 出牌
{"action": []}       // pass
```

`model` 字段语义：

| 情况 | HTTP 状态 | 响应体 |
| ---- | --------- | ------ |
| 缺省 / 三档之一且已加载 | 200 | `{"action": [...]}` |
| 未知档位（不在三档名单内） | **400** | `{"action": [], "error": "unknown model <m>"}` |
| 已知档位但**整档未加载**（三个位置文件全缺/全损坏） | **503** | `{"action": [], "error": "model <m> not loaded"}` |
| 该档**部分位置**未加载（只缺 1-2 个位置文件） | **500** | `{"action": [], "error": "<KeyError…>"}`（该档在 `missing` 里如实报；调用方两类非 200 一律回退规则引擎） |

### `GET /health`

恒 200。`models` 只列**至少加载了一个位置**的档位（值 = 该档已就绪的位置名列表）；
`missing` = 未齐备的档位；`agents` = 三位置全就绪的档位（兼容旧字段）。

```json
{
  "status": "ok",
  "models": {
    "sl":           ["landlord", "landlord_down", "landlord_up"],
    "douzero_WP":   ["landlord", "landlord_down", "landlord_up"],
    "douzero_ADP":  ["landlord", "landlord_down", "landlord_up"]
  },
  "missing": [],
  "agents": ["douzero_ADP", "douzero_WP", "sl"]
}
```

## 并发形态

- `ThreadingHTTPServer` **子类**（每连接一线程，daemon），`request_queue_size = 128`
  走**类属性** —— `ThreadingHTTPServer(...)` 构造里就已 `listen()`（类默认 backlog=5），
  构造之后再赋 `server.request_queue_size = 128` **不生效**；backlog=5 在 20 路并发下
  会造成连接重置与 1s 级尾延迟（本片实测）。
- **SIGTERM 语义**：线程是 daemon ⇒ 进程退出**不等**在途请求；`docker stop`
  时正在推理的请求会被切断，调用方表现为超时 ⇒ 由 game-service 侧回退规则引擎
  （有兜底链，可接受）。

## 卡牌编码

| 牌面 | DouZero int |
| ---- | ----------- |
| 3–A  | 3–14        |
| 2    | 17          |
| 小王 | 20          |
| 大王 | 30          |

## 模型来源

ONNX 模型托管在 [HuggingFace](https://huggingface.co/palemoky/douzero-baselines)。
下载地址模板（`HF_BASE`）：

```
https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx/<model>/<position>.onnx
```

九个文件的完整 URL（展开模板）：

- `…/models_onnx/sl/landlord.onnx` · `…/models_onnx/sl/landlord_down.onnx` · `…/models_onnx/sl/landlord_up.onnx`
- `…/models_onnx/douzero_WP/landlord.onnx` · `…/models_onnx/douzero_WP/landlord_down.onnx` · `…/models_onnx/douzero_WP/landlord_up.onnx`
- `…/models_onnx/douzero_ADP/landlord.onnx` · `…/models_onnx/douzero_ADP/landlord_down.onnx` · `…/models_onnx/douzero_ADP/landlord_up.onnx`

每个文件的 sha256 见 [`models/SOURCES.md`](models/SOURCES.md)。

启动期下载为**兜底**（仅缺文件时触发）：单文件 30s 超时、总量 60s 预算、
先写 `.tmp` 再原子 rename、任何失败只打印不抛（只读挂载/断网都必须能启动）。

如需重新转换（从 PyTorch checkpoint → ONNX），参考 [DouZero](https://github.com/kwai/DouZero) 项目。
