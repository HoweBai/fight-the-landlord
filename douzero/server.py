#!/usr/bin/env python3
"""
DouZero HTTP service — ONNX runtime edition.

Models are downloaded from HuggingFace on first startup.
No torch required.
"""

import os
import json
import time
import shutil
import traceback
import urllib.request
from collections import Counter
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler

import numpy as np
import onnxruntime as ort
from prometheus_client import CONTENT_TYPE_LATEST, Counter as PromCounter, Gauge, Histogram, generate_latest

from src import move_detector as md, move_selector as ms
from src.move_generator import MovesGener
from src.game import InfoSet
from src.env import get_obs

MODEL_DIR = os.environ.get("DOUZERO_MODELS", os.path.join(os.path.dirname(__file__), "models"))
PORT = int(os.environ.get("PORT", 2021))

MODELS = ["sl", "douzero_WP", "douzero_ADP"]
POSITIONS = ["landlord", "landlord_down", "landlord_up"]
DEFAULT_MODEL = "douzero_WP"
HF_BASE = "https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx"
SINGLE_TIMEOUT_S, TOTAL_DOWNLOAD_BUDGET_S = 30, 60

# ---------------------------------------------------------------------------
# 指标（监控片 T7）：由 Prometheus 抓 `douzero:2021/metrics`（**免鉴权**——只在
# compose 内网可达，规格 §2.4 的 job 行无 authorization）。
#
# ⚠️ 用 prometheus_client 的**默认注册表**（不传 registry=），`multiprocess` 模式也不需要：
#    本服务是**单进程** ThreadingHTTPServer —— 默认 REGISTRY 进程内唯一，Counter.inc 与
#    Histogram.observe 线程安全（GIL 下的原子读改写）；multiprocess 目录模式是给
#    gunicorn 多 worker 用的，启用它反而要额外环境变量与进程存活期文件，这里无多进程可合并。
# ---------------------------------------------------------------------------

# `result` 的值域**就是 do_POST 的四个出口**（多一个都不要）：
#   unknown_model（400，model 不在 MODELS）/ not_loaded（503，该档没装齐）/
#   ok（200）/ error（500，except 兜底——坏 JSON、infoset 构造失败、_act 抛错都算）。
# ⚠️ 四个 0 值系列**启动时就先建出来**：带标签的 Counter 在首次 inc 之前**整个 family
#    不会出现在 /metrics 里** —— 探针（切片 C1）与面板若在首个决策前抓取会读成
#    「接线漏了」。0 是合法读数，缺席才是噪音。
# ⚠️ 必须用 `PromCounter` **别名**：本文件已 `from collections import Counter`（`_multiset_subtract`
#    在用）—— 若按名字直接 import 会把 `collections.Counter` **遮蔽**掉，`Counter(base)` 会在
#    每个真实决策请求上抛 `TypeError`（py_compile 抓不到，只有真跑一条请求才现形；本 T7 冒烟已实锤）。
DECIDES_TOTAL = PromCounter(
    "douzero_decides_total",
    "决策请求数（按出口分类：ok/unknown_model/not_loaded/error）。",
    ["result"],
)
for _result in ("ok", "unknown_model", "not_loaded", "error"):
    DECIDES_TOTAL.labels(result=_result)

# 只包 `_act`（模型推理）本身：`build_infoset` 的构造成本与 HTTP 读写都不在内——口径写进 HELP。
# ⚠️ `.time()` 在**异常路径也会 observe**（finally 语义）：炸掉的请求同样在直方图里可见，
#    这正是排障时要的（slow + error 可同时观察）。桶用 prometheus_client 默认集（0.005–10s）：
#    推理实测在几十~几百 ms 量级，默认桶足够分辨。
DECIDE_SECONDS = Histogram(
    "douzero_decide_seconds",
    "模型推理 `_act` 耗时（秒；不含 infoset 构造与 HTTP 读写）。",
)

# 启动装载完成后 set = len(loaded_agents)（见 `__main__`）：三个 position 全齐才算一个
# 已装载档。0 是合法值（全部档缺失）——与「指标没上报」的区分靠 Prometheus 侧 target up。
MODELS_LOADED = Gauge(
    "douzero_models_loaded",
    "已完整装载（3 个 position 全齐）的模型档数。",
)

sessions: dict[str, dict[str, ort.InferenceSession]] = {m: {} for m in MODELS}
missing: list[str] = []
loaded_agents: list[str] = []


def download_model(model: str, deadline: float) -> None:
    """缺文件才下；先写同目录 .tmp 再 rename；失败一律吞掉（只读挂载/断网都不许抛）。"""
    for pos in POSITIONS:
        path = os.path.join(MODEL_DIR, model, f"{pos}.onnx")
        if os.path.exists(path):
            continue
        tmp = f"{path}.tmp"
        url = f"{HF_BASE}/{model}/{pos}.onnx"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if time.monotonic() > deadline:
                print(f"  Download budget exhausted, skipping {model}/{pos}")
                return
            with urllib.request.urlopen(url, timeout=SINGLE_TIMEOUT_S) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(tmp, path)
            print(f"  Downloaded {model}/{pos}.onnx")
        except Exception as e:                      # noqa: BLE001 —— 只读挂载/断网都必须继续启动
            print(f"  Download failed for {model}/{pos}: {e}")
            try:
                os.remove(tmp)
            except OSError:
                pass


def load_sessions() -> None:
    for model in MODELS:
        ok = 0
        for pos in POSITIONS:
            path = os.path.join(MODEL_DIR, model, f"{pos}.onnx")
            if not os.path.exists(path):
                print(f"  Missing  {model}/{pos}")
                continue
            try:
                sessions[model][pos] = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
                ok += 1
                print(f"  Loaded   {model}/{pos}")
            except Exception as e:                  # noqa: BLE001 —— 损坏只报告，不删
                print(f"  FAILED   {model}/{pos}: {e}")
        if ok == len(POSITIONS):
            loaded_agents.append(model)
        else:
            missing.append(model)


def _act(model: str, position: str, infoset) -> list:
    if len(infoset.legal_actions) == 1:
        return infoset.legal_actions[0]

    obs = get_obs(infoset)
    z_batch = obs["z_batch"].astype(np.float32)
    x_batch = obs["x_batch"].astype(np.float32)

    y_pred = sessions[model][position].run(["values"], {"z": z_batch, "x": x_batch})[0]
    best_idx = int(np.argmax(y_pred[:, 0]))
    return infoset.legal_actions[best_idx]


# ---------------------------------------------------------------------------
# Legal-action generation
# ---------------------------------------------------------------------------

def get_legal_card_play_actions(hand: list, rival_move: list) -> list:
    mg = MovesGener(hand)
    rival_type = md.get_move_type(rival_move)
    rival_move_type = rival_type["type"]
    rival_move_len = rival_type.get("len", 1)
    moves = []

    if rival_move_type == md.TYPE_0_PASS:
        moves = mg.gen_moves()
    elif rival_move_type == md.TYPE_1_SINGLE:
        moves = ms.filter_type_1_single(mg.gen_type_1_single(), rival_move)
    elif rival_move_type == md.TYPE_2_PAIR:
        moves = ms.filter_type_2_pair(mg.gen_type_2_pair(), rival_move)
    elif rival_move_type == md.TYPE_3_TRIPLE:
        moves = ms.filter_type_3_triple(mg.gen_type_3_triple(), rival_move)
    elif rival_move_type == md.TYPE_4_BOMB:
        moves = ms.filter_type_4_bomb(mg.gen_type_4_bomb() + mg.gen_type_5_king_bomb(), rival_move)
    elif rival_move_type == md.TYPE_5_KING_BOMB:
        moves = []
    elif rival_move_type == md.TYPE_6_3_1:
        moves = ms.filter_type_6_3_1(mg.gen_type_6_3_1(), rival_move)
    elif rival_move_type == md.TYPE_7_3_2:
        moves = ms.filter_type_7_3_2(mg.gen_type_7_3_2(), rival_move)
    elif rival_move_type == md.TYPE_8_SERIAL_SINGLE:
        moves = ms.filter_type_8_serial_single(mg.gen_type_8_serial_single(repeat_num=rival_move_len), rival_move)
    elif rival_move_type == md.TYPE_9_SERIAL_PAIR:
        moves = ms.filter_type_9_serial_pair(mg.gen_type_9_serial_pair(repeat_num=rival_move_len), rival_move)
    elif rival_move_type == md.TYPE_10_SERIAL_TRIPLE:
        moves = ms.filter_type_10_serial_triple(mg.gen_type_10_serial_triple(repeat_num=rival_move_len), rival_move)
    elif rival_move_type == md.TYPE_11_SERIAL_3_1:
        moves = ms.filter_type_11_serial_3_1(mg.gen_type_11_serial_3_1(repeat_num=rival_move_len), rival_move)
    elif rival_move_type == md.TYPE_12_SERIAL_3_2:
        moves = ms.filter_type_12_serial_3_2(mg.gen_type_12_serial_3_2(repeat_num=rival_move_len), rival_move)
    elif rival_move_type == md.TYPE_13_4_2:
        moves = ms.filter_type_13_4_2(mg.gen_type_13_4_2(), rival_move)
    elif rival_move_type == md.TYPE_14_4_22:
        moves = ms.filter_type_14_4_22(mg.gen_type_14_4_22(), rival_move)

    if rival_move_type not in (md.TYPE_0_PASS, md.TYPE_4_BOMB, md.TYPE_5_KING_BOMB):
        moves = moves + mg.gen_type_4_bomb() + mg.gen_type_5_king_bomb()

    if len(rival_move) != 0:
        moves = moves + [[]]

    for m in moves:
        m.sort()
    return moves


# ---------------------------------------------------------------------------
# InfoSet construction
# ---------------------------------------------------------------------------

def _all_54_cards() -> list:
    cards = []
    for rank in range(3, 15):
        cards.extend([rank] * 4)
    cards.extend([17] * 4)
    cards.append(20)
    cards.append(30)
    return cards


def _multiset_subtract(base: list, remove: list) -> list:
    c = Counter(base)
    for v in remove:
        if c[v] > 0:
            c[v] -= 1
    result = []
    for v, count in c.items():
        result.extend([v] * count)
    result.sort()
    return result


def build_infoset(data: dict) -> InfoSet:
    position = data["position"]
    hand = sorted(data["hand"])
    bottom_cards = sorted(data.get("bottom_cards") or [])
    must_play: bool = data.get("must_play", True)
    last_move: list = sorted(data.get("last_move") or [])
    last_move_pos: str = data.get("last_move_position") or ""
    num_cards_left: dict = data.get("num_cards_left") or {}

    played = {
        "landlord":      sorted(data.get("played_cards_landlord") or []),
        "landlord_down": sorted(data.get("played_cards_landlord_down") or []),
        "landlord_up":   sorted(data.get("played_cards_landlord_up") or []),
    }

    raw_seq = data.get("card_play_action_seq") or []
    action_seq = [sorted(m) if m else [] for m in raw_seq]

    all_played = played["landlord"] + played["landlord_down"] + played["landlord_up"]
    other_hand_cards = _multiset_subtract(
        _multiset_subtract(_all_54_cards(), hand),
        all_played,
    )

    non_empty = [m for m in action_seq if m]
    last_two = [non_empty[-1] if len(non_empty) >= 1 else [],
                non_empty[-2] if len(non_empty) >= 2 else []]

    rival_move = [] if must_play else last_move
    legal = get_legal_card_play_actions(hand, rival_move)
    if not must_play and [] not in legal:
        legal.append([])

    infoset = InfoSet(position)
    infoset.player_hand_cards = hand
    infoset.num_cards_left_dict = num_cards_left
    infoset.three_landlord_cards = bottom_cards
    infoset.card_play_action_seq = action_seq
    infoset.other_hand_cards = other_hand_cards
    infoset.legal_actions = legal
    infoset.played_cards = played
    infoset.last_move = last_move
    infoset.last_two_moves = last_two
    infoset.num_cards_left = num_cards_left
    infoset.bomb_num = 0
    infoset.last_pid = last_move_pos
    infoset.last_move_dict = {p: [] for p in POSITIONS}
    infoset.all_handcards = {position: hand}

    if last_move_pos and last_move:
        infoset.last_move_dict[last_move_pos] = last_move

    return infoset


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "status": "ok",
                "models": {m: sorted(sessions[m].keys()) for m in MODELS if sessions[m]},
                "missing": missing,
                "agents": sorted(loaded_agents),
            })
        elif self.path == "/metrics":
            # prometheus_client 的默认集（process_*/python_gc_*）在 import 时已注册到默认
            # REGISTRY，随 generate_latest() 一并输出——这三条业务指标之外不必再写采集代码。
            body = generate_latest()
            self.send_response(200)
            self.send_header("Content-Type", CONTENT_TYPE_LATEST)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/decide_play":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))

            model = body.get("model", DEFAULT_MODEL)
            if model not in MODELS:
                DECIDES_TOTAL.labels(result="unknown_model").inc()
                self._json(400, {"action": [], "error": f"unknown model {model}"})
                return
            if not sessions[model]:
                DECIDES_TOTAL.labels(result="not_loaded").inc()
                self._json(503, {"action": [], "error": f"model {model} not loaded"})
                return

            infoset = build_infoset(body)
            position = body["position"]

            if not infoset.legal_actions:
                action = []
            else:
                with DECIDE_SECONDS.time():
                    action = _act(model, position, infoset)
                action = list(action) if action is not None else []

            self._json(200, {"action": action})
            # ⚠️ ok 计数必须在**写完 200 之后**：写响应自身若炸（客户端半途断开），会落进
            #    except 记成 error —— 「四路恰好一条」的划分靠这个次序成立。
            DECIDES_TOTAL.labels(result="ok").inc()
        except Exception:
            # error 计数放**最前**：后面的 traceback / 500 写响应若再抛，这一条也不能丢。
            DECIDES_TOTAL.labels(result="error").inc()
            traceback.print_exc()
            err = traceback.format_exc().splitlines()[-1]
            self._json(500, {"action": [], "error": err})

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class DouZeroServer(ThreadingHTTPServer):
    """backlog 128 必须在 listen() 之前生效。

    `ThreadingHTTPServer(...)` 构造里就已执行 `server_activate()`（= `listen(5)`，
    类默认 request_queue_size=5）——构造之后再赋 `server.request_queue_size = 128`
    不会改已 listen 的 socket（实测 20 并发仍出连接重置与 1s 级尾延迟）。
    唯一可靠写法：子类 + 类属性，让 listen() 时读到 128。
    """
    request_queue_size = 128


if __name__ == "__main__":
    print("Downloading ONNX models from HuggingFace (if needed) ...")
    deadline = time.monotonic() + TOTAL_DOWNLOAD_BUDGET_S
    for m in MODELS:
        download_model(m, deadline)
    print(f"\nLoading ONNX sessions ...")
    load_sessions()
    # 装载完成后上报已装载档数（3 个 position 全齐才算一档；0 是合法读数）。
    MODELS_LOADED.set(len(loaded_agents))
    print(f"\nDouZero service listening on port {PORT} (models: {loaded_agents}, missing: {missing})")
    server = DouZeroServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()
