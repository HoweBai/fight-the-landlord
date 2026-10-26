# `/download/` —— 安装包下载目录（uni-ad 开通链接的落点）

**机制（2026-10-13 建）**：本目录随 `Dockerfile.edge` 的 `COPY deploy/download /srv/download`
打进 edge 镜像 ⇒ 线上 `https://<域名>/download/<文件名>` 由 Caddy 的 catch-all `file_server`
直接服务（无 SPA 回退 ⇒ 文件不在就是诚实的 **404**，不会回 index.html）。

**`*.apk` 不入库**（仓库根 `.gitignore` 排除）——发布产物不进 git、不进 CI 构建。

## APK 分发流程（2026-10-27 起：Release 资产 → GitHub 构建）

| 步骤 | 命令 / 行为 |
|---|---|
| ① 打包 | HBuilderX **云打包**（云端证书）：见下方命令；产物下载地址用 `cli pack status` 查 |
| ② 上传资产 | `bash scripts/deploy/publish-apk.sh <apk路径>` → 创建/替换 Release **`apk-latest`** 的资产（文件名保持不变） |
| ③ 构建带上 | `images` workflow 在 `build-images.sh` 前自动 `gh release download apk-latest --pattern '*.apk' -D deploy/download`；**拉不到就失败（fail-closed）** ⇒ 线上 `*.apk` 不会静默 404 |
| ④ 只预览 | `bash scripts/deploy/preview.sh download`（秒传进运行中的 `ftl-edge`，不重建镜像） |
| ⑤ 正式上线 | `bash scripts/deploy/deploy-dev.sh`（GitHub 构建 → 部署） |

⚠️ 手动本地构建（`build-images.sh`）仍然按本目录内容烘镜像 —— 若目录为空，线上 `*.apk` 就是 404。
⚠️ Release tag `apk-latest` 不是版本 tag（不匹配 `v*` / `dev-*`）⇒ 不触发任何 workflow。

## HBuilderX 云打包命令（Windows，本机已装 HBuilderX）

```bash
"E:/Softwares/HBuilder X/cli.exe" pack \
  --project "D:/Code/fight-the-landlord/apps/client" \
  --platform android \
  --android.packagename com.yobeeo.pokergame \
  --android.androidpacktype 3 \
  --unimpads true --ad.domestic sigmob
# 查下载地址：
"E:/Softwares/HBuilder X/cli.exe" pack status --project "D:/Code/fight-the-landlord/apps/client"
```

- `androidpacktype 3` = **Android 云端证书**（与历史包同一签名，可直接覆盖升级）。
- `--unimpads true --ad.domestic sigmob` = 集成 uni-ad 激励视频（Sigmob）。
- 版本号在 `apps/client/src/manifest.json`（`versionName` / `versionCode`）；每次发新包**必须递增 `versionCode`**。
- ⚠️ HBuilderX 的项目列表按路径注册：换目录后需在 HBuilderX 里打开一次新目录（或用
  `HBuilderX.exe <目录>` 打开），否则 `cli pack` 报 `Project not found`。

## 文件名约定

**当前约定**：uni-ad/Sigmob 开通表单已填 `https://<DEV_HOST>/download/优比棋牌.apk`
⇒ 打包产物须命名 **`优比棋牌.apk`**（Release 资产同名；换名须同步改 uni-ad 表单里的 URL）。
⚠️ 中文文件名要穿过 Windows 构建上下文 → Docker → registry → 服务器四道 UTF-8 关（已在本机
真镜像端到端实测通过，见 `.superpowers/sdd/2026-10-13-ads-t0-backfill/progress.md`）。
