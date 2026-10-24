# 客户端加载慢（试玩卡顿）问题 —— 开工交接（2026-10-10）

> **给新会话**：本文件 = 问题首报 + 已测事实 + 假说排序 + 建议方案骨架。动手前先补测（§4 测量清单），**先测后改**。
> 背景：`v1.10.0` 刚上线（含牌桌 UI 批次），用户试玩 `https://<DEV_HOST>` 反馈「比较卡：手牌、玩家头像加载都很慢」。

## 1. 问题陈述（用户原话，2026-10-10）

- 访问 `<DEV_HOST>` **试玩**时体感卡——**手牌、玩家头像加载都很慢**。
- **待澄清（开场先问）**：① 设备 = 手机浏览器 H5 / 桌面浏览器 / App 壳？② 网络 = 家里 WiFi / 4G/5G？③ 「慢」发生在**首局进桌时**还是**每局发牌时**？④ 首访慢还是**回访也慢**？

## 2. 已测事实（2026-10-10 本机探针，命令可复跑）

| # | 事实 | 数据 |
|---|---|---|
| 1 | 服务器到**本机**的时延/带宽正常 | TTFB 0.20–0.24s；主包 352KB 下载 0.43s（≈1.5MB/s 级） |
| 2 | **gzip 工作正常**（探针初判"未压缩"系 curl 未带 `Accept-Encoding` 的假象） | `curl --compressed` ⇒ `Content-Encoding: gzip` + `Vary` |
| 3 | **无 `Cache-Control`**（仅 ETag/Last-Modified） | 所有响应头均无 Cache-Control；回访走**再验证**、弱网/运营商缓存不友好 |
| 4 | 台账缓存头配置面 = `deploy/Caddyfile`（`encode gzip` :12、`header` 块 :14 仅 HSTS/nosniff） | 加缓存头是一处小改（hash 命名产物安全） |
| 5 | **游戏内素材按需加载、且个别文件巨大** | `Card.vue`/`Seat.vue` 消费；**`av/Farmer.png` 单件 83KB**（头像！）、`av/Landlord.png` 17KB、**cards 56 件/588K**（约 10KB/件） |
| 6 | 大底图 PNG 未换代格式 | `ui/bg.png` 336KB、`ui/Common_BG4_2x.png` 242KB、`ui/setting.png` 150KB；UI 目录 1.2MB |
| 7 | 音频 1.5MB（4 首 mp3 ~250KB + 开场 170KB） | 需核**是否启动即加载**（应为按需/懒加载） |
| 8 | 静态树合计 3.3MB / 100 件 | audio 1.5M · ui 1.2M · cards 588K · av 104K |
| 9 | 服务器 `<DEV_HOST_IP>`（腾讯云），edge=Caddy 反代+静态 | **出口带宽档位未核**（腾讯轻量/按量小水管是常见坑） |

## 3. 假说排序（按嫌疑，先验先测）

1. **H1 服务器出口带宽/线路**（全局性最可能）：小带宽 ⇒ 所有请求都慢（不只头像/手牌）。验证 = 从**两个异网视角**（用户设备 + 本机）拉同一大文件比吞吐；查腾讯云控制台带宽档位；server 侧 `speedtest`。
2. **H2 游戏内素材按需拉取 + 单件过大**（与「手牌、头像」症状精确对应）：`Farmer.png` 83KB、卡面 ~10–20KB×N——发牌/入座瞬间 N 个请求，弱网下 RTT×N + 弱缓存（事实 #3）叠加。验证 = 浏览器 DevTools Network 看进桌瞬间瀑布；看是否首局多张卡逐张请求。
3. **H3 无 Cache-Control**（回访与中途重进桌重复拉取）：低—中影响，但**改动最便宜**。
4. **H4 音频/大底图启动即加载**：看启动瀑布里 mp3/`bg.png` 是否进入首屏关键路径。
5. **H5 转化率问题**：大 PNG → webp/avif（底图、卡面、头像）可降 70–90%，属**结构性收益**（即便带宽正常也值得做）。

## 4. 测量清单（先跑再定方案；本机与真机各一遍）

- [ ] 真机/浏览器 DevTools（或 `scripts/browser-e2e.mjs` 链路——注意记忆里的三处 Windows 坑）→ **完整瀑布**：首页→大厅→进桌→发牌，标注 Top 10 慢请求与总下载量。
- [ ] `curl -w` 逐资源计时（本机已有基线：见 §2）；在**用户网络**下复跑同条命令（或让用户贴 DevTools 截图）。
- [ ] Server 出口带宽：腾讯云控制台查档位；或 server 上跑 speedtest；或从异网两端并行拉 5–10MB 文件比对。
- [ ] 启动瀑布中 mp3/png 是否关键路径（`index` 引用面 + 运行时加载时机）。
- [ ] 回访测试：第二次访问各资源是 304 还是 200（验 H3 影响面）。

## 5. 建议方案骨架（按 ROI；等测量收口后择组合，形成小片走一条龙）

- **S1（便宜，先做）**：Caddyfile 加缓存头——`/assets/*`（hash 产物）`Cache-Control: public, max-age=31536000, immutable`；`/static/*`（无 hash）`max-age=86400`（自带 ETag 再验证兜底）。一处小改 + slice-07.3 判据补两条。
- **S2（对症）**：**预加载**——大厅/进桌时 `uni.getImageInfo`/`<image>` 预热 `cards/` + `av/`（总量 ~700KB，一次性）；或发牌前用「一张合成 sprite」替 56 件。
- **S3（结构性）**：素材换 webp/avif（`bg.png`、`Common_BG4_2x`、卡面、`Farmer.png`）——走既有资产管线（`scripts/gen-card-manifest.mjs`/`transcode-audio.mjs` 先例）；**槽位名与登记尺寸不变**（用户口径：素材重建不用问）。
- **S4（大头兜底）**：若 H1 坐实（带宽档小）⇒ 升带宽 或 **上 CDN/对象存储**（静态站搬迁，工程量中等；`deploy/Caddyfile` 静态段改反代即可）。**此条涉及花钱/服务选型 ⇒ 必须用户拍板。**
- **S5（确认项）**：音频懒加载核验；如启动即载 ⇒ 移出关键路径。

## 6. 工作流提示

- 若定位到需要改代码/配置：按本仓一条龙小片流程（设计→规格→计划→实现；小改动可走缩减版但**判据不省**：Caddyfile 改动必须 `build edge && up -d edge` + 显式 `EDGE_HTTPS_PORT=8443`——记忆第 18 条）。
- 线上验证纪律：先 push → tag `v*`（本机手动等价流程，Actions 额度未恢复）；探针要**双视角**（本机 + 用户网络）。
- 相关记忆：`windows-dev-env-quirks`（edge 重建两条）、`art-asset-registry-not-aesthetics`（素材重建直接做+登记）、`user-ops-background`（讲结论先讲玩家会看到什么）。

## 7. 关键文件

- `deploy/Caddyfile`（缓存头/压缩的唯一真源）· `apps/client/src/static/**`（素材树）· `apps/client/src/components/Card.vue` / `Seat.vue`（消费点）· `scripts/browser-e2e.mjs`（走查链路）· `scripts/verify-asset-paths.mjs`。

## 8. 补测结果（2026-10-10 晚，本会话）—— 先测后改，结论先行

### 8.0 一句话

用户体感「很慢」的主因 = **用户机的 Windows 系统代理在路**（qv2ray → 美国出口 → 首尔服务器），同资源慢 **≈9–15×**（首页 TTFB 21×）；直连路径各项正常（出口带宽 28.5Mbps、发牌爆发 <0.5s 级）。存量毛病（无缓存头 / 大 PNG / 音频 eager）属实，属「对慢路敏感」一类，值得做，但不解释这次的「很慢」。

### 8.1 §1 四问答案（2026-10-10）

桌面浏览器 · 家里 WiFi（与开发机同一出口）· 首局进桌/发牌时 · 回访没注意。

### 8.2 🔴 关键发现：系统代理在路（新假说 H0，已实证）

- 本机 = 用户坐席：`ProxyEnable=1 · ProxyServer=127.0.0.1:8889`（qv2ray.exe + trojan-go.exe + v2ray.exe；代理出口 `<PROXY_EXIT_IP>` = 美国）。**桌面浏览器默认吃系统代理** ⇒ 试玩流量 = PC → 美国 → 首尔 → 美 → PC。
- 两路对比（本机 → 生产，均可复跑）：

| 资源 | 直连（`--noproxy '*'`） | 走代理（`-x http://127.0.0.1:8889`） |
|---|---|---|
| 首页 TTFB | 0.19s | **3.97s** |
| `bg.png` 336KB | 0.42s · 794KB/s | **4.06s · 83KB/s** |
| 8 大件 967KB 并发 | 494ms | **4414ms** |
| 单件最差（jujsidai 39KB） | 131KB/s | **9KB/s（≈14×）** |

- 服务器 `<DEV_HOST_IP>` 元数据 `placement/region` = **ap-seoul**（ipinfo：KR/Seoul · AS132203 Tencent）⇒ 常见「CN 直连」分流规则**不覆盖**它，规则模式代理多半会把本域名送进隧道（§2 事实 #9 的「档位未核」就此翻篇：不是档位，是路径）。

### 8.3 服务器出口带宽（H1 否定）

- Ookla（服务器 → 首尔本地测点 1.25ms；二进制放 /tmp 用后即删）：**下行 150.7 Mbps / 上行 28.5 Mbps**。
- 本机直连持续压测（40×336KB）：**单流 0.65MB/s**（57ms RTT 下的 TCP 动力学）· **8 并发聚合 3.15MB/s ≈ 25Mbps**（与 28.5 上限吻合）。
- 服务器 4 核 / load 0.6 / 入口 22–40MB/s；ping 57ms。⇒ **不是小水管**。

### 8.4 浏览器瀑布（本机 edge = 生产同构建 `index-CGTgzJvJ.js`；探针 = 新增 `scripts/perf-waterfall.mjs`；**两跑一致**：66–67 请求 / 1487 / 1475 KB）

- 阶段（两跑）：① 导航→大厅 **776KB**（`bg.png` 330KB **登录页即拉** + 大厅 BGM 260KB + JS 122KB(gzip) + 小 UI）· ② 进桌→发牌 **~700KB**（牌桌 BGM 240KB + Farmer 82KB + 17 卡面 ~158KB + bottom-bar/countdown/avatar-ring/bid-badge/count-tile ≈ 191KB）· ③ 8.5KB。
  - ⚠️ ② 的墙上时长 ~30s = **机器人补位等待（设计如此）**，不是加载慢。
- h2 64/66；卡面**无预加载**：发牌瞬间 17 连发（本机每件 3–13ms；生产直连 17 件 384ms；走代理 ~4.4s+）。
- **两条 BGM 共 500KB 进场即拉**（`audio/index.ts` `playBgm()` 设 `ctx.src` 即触发下载）——慢路上与可见素材抢带宽。
- 外部小件（完整 URL 已落证据 JSON）：`tongji-collector.dcloud.net.cn/WebTrack.gif`（**uni统计 2.0** 埋点；0 字节、不完成；载入 + 发牌各一次）· `cdn.dcloud.net.cn/img/shadow-grey.png`（0.4KB；CSS `@keyframes shadow-preload` 预加载 hack；两跑 6.3s / 0.27s，CDN 抖动）。
- 缓存：无 `Cache-Control`；ETag/Last-Modified 在，**304 再验证可用**（bg.png 复验 TTFB 0.20s）——回访/F5 走再验证；S1 的收益点。
- 主 JS 压缩后 121.9KB、CSS 3.8KB —— 首屏包体不是问题。
- 复跑：`CHROME_BIN=<chrome.exe> node scripts/perf-waterfall.mjs --base-url <url> [--proxy none|system] [--login phone:pass]`（与 browser-e2e 同属独占探针）。

### 8.5 假说收口

**H0 代理在路 = 主因（已实证）**；H2/H5（素材体积）与 H4（音频 eager）属实、属「慢路放大项」；H3（缓存头）属实（回访/F5）；**H1（带宽）否定**。

### 8.6 建议方案（待裁决；§5 骨架按实测收口）

- **A 先做（用户侧零代码）**：代理分流加直连规则（`<DEV_HOST>` / `<BRAND_DOMAIN>`；或试玩时关代理）。复测协议：关代理 → `Ctrl+Shift+R` → 试玩一局；预期进桌爆发回到 <0.5s 级。
- **B 工程小片「客户端加载提速」**：S1 缓存头（Caddyfile `/assets/*` immutable 1y + `/static/*` max-age=86400；edge 重建纪律）· S3 素材 webp（bg/Farmer/UI/卡面；槽位名与登记尺寸不变；预计首访 1.49MB → ~0.7MB、发牌爆发 ~700KB → ~350KB）· S5 音频（BGM 懒启动 + 降码率 500KB → ~160KB）· S2 预加载（可选：大厅预热 `cards/`）。
- **C 登记（非本片）**：uni统计 2.0 埋点 / DCloud CDN 小件——外部依赖登记；要关在 manifest 配置。
- **D 不做**：上 CDN 或迁区——出口 28.5Mbps 够用；RTT 57ms 是首尔地理事实，国内玩家规模化再议。
