// 宿主视角的并发探针 —— 用来证明「同一个变异在宿主 vantage 上看不出来」。
// ⚠️ 结论（设计文档 §2.3）：宿主路径要先过 Docker Desktop 的端口代理，代理自己排队
//    ⇒ 容器那 5 个槽位的 backlog 根本没被压到 ⇒ 未修复的服务在宿主视角「0 失败、比值仅 5.1×」。
//    所以性能类判据（J11）**必须在容器内取证**。
// 用法：容器已发布 2021 到宿主时，node probe-host-conc.mjs
const url = 'http://localhost:2021/decide_play';
const body = JSON.stringify({ "position": "landlord", "hand": [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 17], "bottom_cards": [3, 7, 9], "must_play": true, "last_move": [], "last_move_position": "", "num_cards_left": { "landlord": 15, "landlord_down": 17, "landlord_up": 17 }, "played_cards_landlord": [], "played_cards_landlord_down": [12], "played_cards_landlord_up": [13], "card_play_action_seq": [[12], [13]] });
const h = { 'Content-Type': 'application/json' };
async function one() { const t0 = performance.now(); await (await fetch(url, { method: 'POST', headers: h, body })).json(); return performance.now() - t0; }
await one();
const ser = []; for (let i = 0; i < 10; i++) ser.push(await one());
ser.sort((a, b) => a - b);
console.log(`串行基线 p50 = ${ser[5].toFixed(0)} ms (min ${ser[0].toFixed(0)})`);
const N = 20, lat = []; let errs = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: N }, async () => { try { lat.push(await one()); } catch { errs++; } }));
const dt = performance.now() - t0;
lat.sort((a, b) => a - b);
const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : NaN;
console.log(`20 路并发：总 ${dt.toFixed(0)} ms · 成功 ${lat.length} · 失败 ${errs} · p50 ${p50.toFixed(0)} ms · max ${lat.length ? lat[lat.length - 1].toFixed(0) : '-'}`);
console.log(`比值 p50_concurrent / p50_serial = ${(p50 / ser[5]).toFixed(1)}×`);
