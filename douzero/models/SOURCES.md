# 模型来源与校验

九个 ONNX 文件（3 档 × 3 位置）全部来自 HuggingFace 仓库
[palemoky/douzero-baselines](https://huggingface.co/palemoky/douzero-baselines)，
仓库路径模板：

```
https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx/<model>/<position>.onnx
```

其中 `model ∈ {sl, douzero_WP, douzero_ADP}`、`position ∈ {landlord, landlord_down, landlord_up}`。

**九个 URL 与 sha256**（2026-10-01 从 HF `resolve/main` 下载后实测）：

| 文件（相对 `douzero/models/`） | URL | sha256 |
| --- | --- | --- |
| `sl/landlord.onnx` | `…/models_onnx/sl/landlord.onnx` | `0eb55b86c0da249d9cc5e5ec73717ab6e5011e8ff9f1317890ae9789d5737a0e` |
| `sl/landlord_down.onnx` | `…/models_onnx/sl/landlord_down.onnx` | `d4d0fe019edd4a83ffd6a74efa2f716805faab115d158aaf6ace7d2a46853a35` |
| `sl/landlord_up.onnx` | `…/models_onnx/sl/landlord_up.onnx` | `db2aa12f16d29d7ba3b411664f2da17db2e7447489ad5aaf566dd68fc8f6d482` |
| `douzero_WP/landlord.onnx` | `…/models_onnx/douzero_WP/landlord.onnx` | `5ba2f1bb414483a3ecdf0d000159c1322b02e2d096e6d83be8a18765b56d6d32` |
| `douzero_WP/landlord_down.onnx` | `…/models_onnx/douzero_WP/landlord_down.onnx` | `9b816457615f8007dd3a657dde1f78dac4fec7c3b0041f6f89321a1c6335cbd1` |
| `douzero_WP/landlord_up.onnx` | `…/models_onnx/douzero_WP/landlord_up.onnx` | `244ec62a549a0141c6532dffd02bee7675621d095cb194362b47c8a923c95883` |
| `douzero_ADP/landlord.onnx` | `…/models_onnx/douzero_ADP/landlord.onnx` | `3c3b449c8106829725b95a7551e4d7cc1a88ec89b8f3d8bea09bde6317759d6d` |
| `douzero_ADP/landlord_down.onnx` | `…/models_onnx/douzero_ADP/landlord_down.onnx` | `9037a705736696b818880540a722a039811b01f98b0838f0bd642864052a9f9d` |
| `douzero_ADP/landlord_up.onnx` | `…/models_onnx/douzero_ADP/landlord_up.onnx` | `5a705d0c94211a74417d7355f0766d90cbed6ad14a611442a679f69dee705cc5` |

（URL 列省去公共前缀 `https://huggingface.co/palemoky/douzero-baselines/resolve/main`；完整前缀就是上方的仓库路径模板。）

## 校验方式

```bash
shasum -a 256 douzero/models/*/*.onnx   # macOS
sha256sum douzero/models/*/*.onnx       # Linux / Git Bash
```

与上表逐行比对即可（三档权重不同 ⇒ 九个 sha256 应两两互异）。

## 说明

- 这九个文件**入库在 git 里**（普通 blob，非 LFS）；`server.py` 的启动期下载只是
  「文件缺失时兜底补下」（单文件 30s 超时、总量 60s 预算、先写 `.tmp` 再原子
  `rename`、任何失败都只打印不抛——只读挂载/断网都必须能启动）。
- `sl` 档即 Supervised Learning baseline，`douzero_WP` / `douzero_ADP` 为两种
  DouZero 自对弈配置；三档在同一判别局面下的出牌**已知互不相同**（见
  `douzero/README.md`）。
- 如需重新转换（PyTorch checkpoint → ONNX），参考
  [DouZero](https://github.com/kwai/DouZero) 项目。
