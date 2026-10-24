#!/usr/bin/env python3
"""A/B：单线程 HTTPServer vs ThreadingHTTPServer，同机同载荷，20 路并发。

在 ftl-douzero 容器内跑：python - < probe-thread-ab.py
"""
import json
import statistics
import threading
import time
import http.client
from http.server import ThreadingHTTPServer

import server

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

# ---- 在 2022 端口起一个 ThreadingHTTPServer（同一个 Handler，同一批 session）----
threaded = ThreadingHTTPServer(("127.0.0.1", 2022), server.Handler)
t = threading.Thread(target=threaded.serve_forever, daemon=True)
t.start()
time.sleep(0.3)


def one(port):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    t0 = time.perf_counter()
    c.request("POST", "/decide_play", BODY, {"Content-Type": "application/json"})
    r = c.getresponse()
    r.read()
    c.close()
    return (time.perf_counter() - t0) * 1000


def bench(port, n, label):
    # 预热
    for _ in range(3):
        one(port)
    lat = []
    lock = threading.Lock()
    barrier = threading.Barrier(n)

    def worker():
        barrier.wait()
        ms = one(port)
        with lock:
            lat.append(ms)

    ts = [threading.Thread(target=worker) for _ in range(n)]
    t0 = time.perf_counter()
    for x in ts:
        x.start()
    for x in ts:
        x.join()
    dt = (time.perf_counter() - t0) * 1000
    lat.sort()
    print(f"{label}: 总 {dt:7.0f} ms ⇒ {n/(dt/1000):6.1f} 决策/秒 | 单请求 中位 {statistics.median(lat):6.1f} 最小 {lat[0]:5.1f} 最大 {lat[-1]:6.1f} ms")


print(f"容器 CPU = {len(__import__('os').sched_getaffinity(0))}")
for n in (1, 4, 20):
    bench(2021, n, f"单线程 :2021 并发 {n:2d}")
for n in (1, 4, 20):
    bench(2022, n, f"多线程 :2022 并发 {n:2d}")

threaded.shutdown()
