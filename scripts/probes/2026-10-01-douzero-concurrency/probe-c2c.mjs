const url = 'http://douzero:2021/decide_play';
const body = JSON.stringify({ "position": "landlord", "hand": [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 17], "bottom_cards": [3, 7, 9], "must_play": true, "last_move": [], "last_move_position": "", "num_cards_left": { "landlord": 15, "landlord_down": 17, "landlord_up": 17 }, "played_cards_landlord": [], "played_cards_landlord_down": [12], "played_cards_landlord_up": [13], "card_play_action_seq": [[12], [13]] });
const h = { 'Content-Type': 'application/json' };
await (await fetch(url, { method: 'POST', headers: h, body })).json();   // 预热
const one = [];
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  await (await fetch(url, { method: 'POST', headers: h, body })).json();
  one.push(performance.now() - t0);
}
one.sort((a, b) => a - b);
console.log('串行 15 次 (ms):', one.map(x => x.toFixed(1)).join(' '));
console.log(`中位 ${one[7].toFixed(1)} ms · 最小 ${one[0].toFixed(1)} · 最大 ${one[14].toFixed(1)}`);

const N = 20;
const t0 = performance.now();
await Promise.all(Array.from({ length: N }, async () => {
  await (await fetch(url, { method: 'POST', headers: h, body })).json();
}));
const dt = performance.now() - t0;
console.log(`并发 ${N} 路：${dt.toFixed(0)} ms ⇒ ${(N / (dt / 1000)).toFixed(1)} 决策/秒`);
