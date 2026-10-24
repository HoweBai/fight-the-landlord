#!/usr/bin/env python3
"""片② 设计层取证：把单次 decide_play 拆成 Python(GIL) 部分 vs ONNX(释放GIL) 部分，
并测多线程/多进程的扩展性。在 ftl-douzero 容器内运行。

用法：docker exec -i ftl-douzero python - < probe.py
"""
import time
import statistics
import threading

import numpy as np

import server
import src.env as env_mod

# ---------------------------------------------------------------- 构造真实规模局面
def build_payload():
    deck = []
    for r in range(3, 15):
        deck.extend([r] * 4)
    deck.extend([17] * 4)
    deck.extend([20, 30])
    # 固定切分，保证可重复：地主 15 张，两农民各 17，底牌 3，已出 2
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
print("sessions:", list(server.sessions.keys()))

# ---------------------------------------------------------------- 阶段拆分
def split_once():
    t0 = time.perf_counter()
    infoset = server.build_infoset(PAYLOAD)
    t1 = time.perf_counter()
    obs = env_mod.get_obs(infoset)
    t2 = time.perf_counter()
    z = obs["z_batch"].astype(np.float32)
    x = obs["x_batch"].astype(np.float32)
    y = server.sessions["douzero_WP"]["landlord"].run(["values"], {"z": z, "x": x})[0]
    t3 = time.perf_counter()
    best = int(np.argmax(y[:, 0]))
    return (t1 - t0) * 1000, (t2 - t1) * 1000, (t3 - t2) * 1000, len(infoset.legal_actions), best


# 预热
split_once()
build_ms, obs_ms, run_ms, n_legal, best_idx = [], [], [], None, None
for _ in range(12):
    a, b, c, n, bst = split_once()
    build_ms.append(a); obs_ms.append(b); run_ms.append(c)
    n_legal, best_idx = n, bst

print(f"\n合法动作数 = {n_legal} · argmax = {best_idx}")
print(f"build_infoset  中位 {statistics.median(build_ms):7.1f} ms   (min {min(build_ms):.1f} / max {max(build_ms):.1f})")
print(f"get_obs        中位 {statistics.median(obs_ms):7.1f} ms   (min {min(obs_ms):.1f} / max {max(obs_ms):.1f})")
print(f"session.run    中位 {statistics.median(run_ms):7.1f} ms   (min {min(run_ms):.1f} / max {max(run_ms):.1f})")
tot = statistics.median(build_ms) + statistics.median(obs_ms) + statistics.median(run_ms)
print(f"合计           中位 {tot:7.1f} ms   ⇒ 串行天花板 {1000/tot:.2f} 决策/秒")


# ---------------------------------------------------------------- 纯 ONNX 的线程扩展性
def bench_run_only(n_workers, n_each):
    obs = env_mod.get_obs(server.build_infoset(PAYLOAD))
    z = obs["z_batch"].astype(np.float32)
    x = obs["x_batch"].astype(np.float32)
    sess = server.sessions["douzero_WP"]["landlord"]
    barrier = threading.Barrier(n_workers)
    def worker():
        barrier.wait()
        for _ in range(n_each):
            sess.run(["values"], {"z": z, "x": x})
    ts = [threading.Thread(target=worker) for _ in range(n_workers)]
    t0 = time.perf_counter()
    for t in ts: t.start()
    for t in ts: t.join()
    dt = time.perf_counter() - t0
    total = n_workers * n_each
    return dt, total / dt


# ---------------------------------------------------------------- 整链的线程扩展性
def bench_full(n_workers, n_each):
    barrier = threading.Barrier(n_workers)
    def worker():
        barrier.wait()
        for _ in range(n_each):
            infoset = server.build_infoset(PAYLOAD)
            server._act("douzero_WP", "landlord", infoset)
    ts = [threading.Thread(target=worker) for _ in range(n_workers)]
    t0 = time.perf_counter()
    for t in ts: t.start()
    for t in ts: t.join()
    dt = time.perf_counter() - t0
    total = n_workers * n_each
    return dt, total / dt


print("\n== 纯 session.run（线程） ==")
for w in (1, 2, 4, 8):
    n_each = max(1, 24 // w)
    dt, thr = bench_run_only(w, n_each)
    print(f"  {w} 线程 × {n_each} 次：{dt:6.2f}s  ⇒ {thr:6.2f} 推理/秒")

print("\n== 整链 _act（线程） ==")
for w in (1, 2, 4, 8):
    n_each = max(1, 12 // w)
    dt, thr = bench_full(w, n_each)
    print(f"  {w} 线程 × {n_each} 次：{dt:6.2f}s  ⇒ {thr:6.2f} 决策/秒")
