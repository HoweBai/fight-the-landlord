#!/usr/bin/env python3
"""复测：HTTP 往返 vs 进程内推理，定位 265ms 的来源。"""
import json
import statistics
import time
import http.client

import server


def build_payload():
    deck = []
    for r in range(3, 15):
        deck.extend([r] * 4)
    deck.extend([17] * 4)
    deck.extend([20, 30])
    landlord = sorted(deck[0:15])
    landlord_down = sorted(deck[15:32])
    landlord_up = sorted(deck[32:49])
    bottom = sorted(deck[49:52])
    played_landlord_down = sorted(deck[52:53])
    played_landlord_up = sorted(deck[53:54])
    return {
        "position": "landlord",
        "hand": landlord,
        "bottom_cards": bottom,
        "must_play": True,
        "last_move": [],
        "last_move_position": "",
        "num_cards_left": {"landlord": len(landlord), "landlord_down": len(landlord_down), "landlord_up": len(landlord_up)},
        "played_cards_landlord": [],
        "played_cards_landlord_down": played_landlord_down,
        "played_cards_landlord_up": played_landlord_up,
        "card_play_action_seq": [played_landlord_down, played_landlord_up],
    }


PAYLOAD = build_payload()
server.load_sessions()


def timed(fn, n=10):
    xs = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        xs.append((time.perf_counter() - t0) * 1000)
    return xs


body = json.dumps(PAYLOAD).encode()


def fresh_conn():
    c = http.client.HTTPConnection("127.0.0.1", 2021, timeout=30)
    c.request("POST", "/decide_play", body, {"Content-Type": "application/json"})
    r = c.getresponse()
    r.read()
    c.close()


def keepalive_conn():
    c = http.client.HTTPConnection("127.0.0.1", 2021, timeout=30)
    for _ in range(10):
        c.request("POST", "/decide_play", body, {"Content-Type": "application/json"})
        r = c.getresponse()
        r.read()
    c.close()


def inproc():
    server._act("douzero_WP", "landlord", server.build_infoset(PAYLOAD))


print("① 每次新建连接（10 次）:")
xs = timed(fresh_conn)
print("   ", " ".join(f"{x:.0f}" for x in xs), f"| 中位 {statistics.median(xs):.1f} ms")

print("② 复用连接（1 连接 × 10 请求）:")
t0 = time.perf_counter()
keepalive_conn()
el = (time.perf_counter() - t0) * 1000
print(f"    合计 {el:.1f} ms ⇒ 每请求 {el/10:.1f} ms")

print("③ 进程内 _act（10 次）:")
xs = timed(inproc)
print("   ", " ".join(f"{x:.1f}" for x in xs), f"| 中位 {statistics.median(xs):.1f} ms")


def health():
    c = http.client.HTTPConnection("127.0.0.1", 2021, timeout=30)
    c.request("GET", "/health")
    r = c.getresponse()
    r.read()
    c.close()


xs = timed(health)
print("④ /health 新建连接（10 次）:", " ".join(f"{x:.0f}" for x in xs), f"| 中位 {statistics.median(xs):.1f} ms")
