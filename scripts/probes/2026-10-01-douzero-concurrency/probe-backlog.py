#!/usr/bin/env python3
"""探针③：backlog 假说 + intra_op 配比。

A     ：ThreadingHTTPServer + request_queue_size=128 + intra_op=4（现默认）
B     ：ThreadingHTTPServer + request_queue_size=128 + intra_op=1
对照  ：现役 :2021（单线程 + 默认 backlog=5 + intra_op=4）
"""
import json
import os
import statistics
import threading
import time
import http.client
from http.server import ThreadingHTTPServer, HTTPServer

import onnxruntime as ort

import server

print("socketserver 默认 request_queue_size =", HTTPServer.request_queue_size)
server.load_sessions()

PAYLOAD = {
    "position": "landlord",
    "hand": [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 17],
    "bottom_cards": [3, 7, 9],
    "must_play": True,
    "last_move": [],
    "last_move_position": "",
    "num_cards_left": {"landlord": 15, "landlord_down": 17, "landlord_up": 17},
    "played_cards_landlord": [],
    "played_cards_landlord_down": [12],
    "played_cards_landlord_up": [13],
    "card_play_action_seq": [[12], [13]],
}
BODY = json.dumps(PAYLOAD).encode()

so = ort.SessionOptions()
so.intra_op_num_threads = 1
sess_intra1 = {"douzero_WP": {pos: ort.InferenceSession(os.path.join("/app/models", "douzero_WP", f"{pos}.onnx"),
                                         sess_options=so,
                                         providers=["CPUExecutionProvider"])
               for pos in server.POSITIONS}}


class ThreadingQ(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


class HandlerIntra1(server.Handler):
    """用 intra_op=1 的会话（临时替换模块级 sessions）。"""

    def do_POST(self):
        saved = server.sessions
        server.sessions = sess_intra1
        try:
            super().do_POST()
        finally:
            server.sessions = saved


def serve(port, handler_cls):
    srv = ThreadingQ(("127.0.0.1", port), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


srvA = serve(2023, server.Handler)     # A：默认会话（intra_op=4）
srvB = serve(2024, HandlerIntra1)      # B：intra_op=1
time.sleep(0.3)


def one(port):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    t0 = time.perf_counter()
    c.request("POST", "/decide_play", BODY, {"Content-Type": "application/json"})
    r = c.getresponse()
    r.read()
    c.close()
    return (time.perf_counter() - t0) * 1000


def bench(port, n, label):
    try:
        for _ in range(3):
            one(port)
    except Exception as e:  # noqa: BLE001
        print(f"{label}: 预热失败 {e}")
        return
    lat, lock = [], threading.Lock()
    barrier = threading.Barrier(n)
    errs = []

    def worker():
        barrier.wait()
        try:
            ms = one(port)
            with lock:
                lat.append(ms)
        except Exception as e:  # noqa: BLE001
            with lock:
                errs.append(type(e).__name__)

    ts = [threading.Thread(target=worker) for _ in range(n)]
    t0 = time.perf_counter()
    for x in ts:
        x.start()
    for x in ts:
        x.join()
    dt = (time.perf_counter() - t0) * 1000
    ok = len(lat)
    lat.sort()
    med = statistics.median(lat) if lat else float("nan")
    lo = lat[0] if lat else -1
    hi = lat[-1] if lat else -1
    print(f"{label}: 总 {dt:7.0f} ms ⇒ {ok/(dt/1000):6.1f} 成功/秒 | 中位 {med:7.1f} 最小 {lo:6.1f} 最大 {hi:7.1f} ms | 失败 {len(errs)} {set(errs)}")


for n in (1, 4, 20):
    bench(2021, n, f"对照 单线程 backlog=5   intra_op=4 并发{n:2d}")
for n in (1, 4, 20):
    bench(2023, n, f"A    多线程 backlog=128 intra_op=4 并发{n:2d}")
for n in (1, 4, 20):
    bench(2024, n, f"B    多线程 backlog=128 intra_op=1 并发{n:2d}")

srvA.shutdown()
srvB.shutdown()
