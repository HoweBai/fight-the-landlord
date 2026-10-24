# `/download/` —— 安装包下载目录（uni-ad 开通链接的落点）

**机制（2026-10-13 建）**：本目录随 `Dockerfile.edge` 的 `COPY deploy/download /srv/download`
打进 edge 镜像 ⇒ 线上 `https://<域名>/download/<文件名>` 由 Caddy 的 catch-all `file_server`
直接服务（无 SPA 回退 ⇒ 文件不在就是诚实的 **404**，不会回 index.html）。

**`*.apk` 不入库**（仓库根 `.gitignore` 排除）——发布产物不进 git、不进 CI 构建：

| 场景 | 行为 |
|---|---|
| 打包轮（本机手动流程，现行） | 把 APK 放进本目录（文件名与 uni-ad 表单里的 URL **逐字一致**）再跑 `build-images.sh` |
| CI 构建（`images.yml`，额度恢复后） | 本目录为空 ⇒ 构建照常，但线上 `/download/*.apk` = **404** ⇒ ⚠️ 若上线依赖该链接存活，该轮必须走手动构建并把 APK 放回本目录 |
| 换版 | 覆盖同名文件（URL 不变）；换名须同步改 uni-ad 表单里的 URL |

**当前约定**：uni-ad/Sigmob 开通表单已填 `https://<DEV_HOST>/download/优比棋牌.apk`
⇒ 打包产物须命名 **`优比棋牌.apk`** 放入本目录。⚠️ 中文文件名要穿过 Windows 构建上下文 →
Docker → registry → 服务器四道 UTF-8 关（已在本机真镜像端到端实测通过，见
`.superpowers/sdd/2026-10-13-ads-t0-backfill/progress.md`）。
