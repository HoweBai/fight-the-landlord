# 交接：麻将牌桌「天月麻雀」风格重制

日期：2026-11-02
分支：`dev`
Spec：`docs/superpowers/specs/2026-11-02-mahjong-tianyue-style-design.md`
Plan：`docs/superpowers/plans/2026-11-02-mahjong-tianyue-style.md`

## 状态

- 设计对抗审查：阻断 3 / 高 9 / 低 14，全部处置（见 spec §10）。
- 计划对抗审查：阻断 3 / 高 6 / 低 14，全部处置（见 plan「计划审查记录」）。
- 实现：Task 0–6 完成；Task 7 全量验证完成。
- 已合并远端 `origin/dev`（2026-10-31 的牌桌视觉/1px/测试/protocol/settlement 批），冲突已解决。
- 已推 `dev`（`aabbfdb2..1171770c`）；未部署；未合并 master；未打 tag。

## 提交

| SHA | 内容 |
|---|---|
| `c50a4e16` | 设计 spec |
| `f7ce31ad` | spec v2（对抗审查修订） |
| `99f54f57` | 实现计划 |
| `a6797816` | 计划 v2（计划审查修订） |
| `f4e64d35` | Task 0 基线修复（死 prop + 陈旧断言） |
| `4890f4c7` | ClaimTile 1px 收口（ui-tokens 基线绿） |
| `0877ad8c` | Task 1 素材（FluffyStuff CC0 + 64 色量化 + 预算闸） |
| `ec51faf1` | Task 2 布局（3:4 / 中央卡 / 动作区） |
| `83b57e05` | Task 3 牌面/牌背/牌河/副露 |
| `98d6cff3` | Task 4 中央圆盘 |
| `68003079` | Task 5 座位卡/ClaimTile/HuBanner/结算主按钮 |
| `b1359fe2` | Task 6 桌面/木框/顶栏/按钮/对比度 |
| `25c3a872` | Task 7 视觉走查修复 + 交接 |
| `1171770c` | 合并 origin/dev（冲突取本片新版；保留对端 settlement/protocol/版本） |

## 变更摘要

- 牌面换 **FluffyStuff CC0**（`scripts/assets/mahjong/fluffystuff/`，pin
  `26e127ba2117f45cdce5ea0225748cc0cfad3169`），由
  `scripts/build-mahjong-tile-set.py` 生成四方向 180×240 / 240×180、64 色量化；
  运行时素材约 588KiB（旧 836KiB），预算 `table/mahjong ≤768KiB`。
- 布局：`TILE_RATIO=3/4`；手牌 104 高；牌河 56；中央卡 340×170；动作区 maxWidth
  收到自家牌河右侧。
- 中央：蓝金圆盘 110，倒计时大数字；`ended` prop 区分终局；听牌最多 12 张 + `+N`。
- 视觉：亮青桌面 + 同心圆压纹 + 木框；海军蓝玻璃 + 金边；白牌/蓝背；圆形金框头像；
  金底文字统一海军蓝（对比度 8.5:1）。
- 基线修复：`MahjongTile`/`MahjongMeld` 死 prop；`mahjong-board.test` 两条陈旧断言；
  `dirSizeKiB` 递归 KiB/字节 bug；ClaimTile 旧 `1px`。

## 验证

- `pnpm -C apps/client test`：**1762 passed / 2 skipped**。
- `pnpm -C apps/client run lint`：**0 错**（合并后先 `pnpm -C packages/protocol build`）。
- `pnpm -C packages/protocol test`：**325 passed**。
- `pnpm -C packages/shared test`：**446 passed**。
- `asset-budget` / `mahjong-assets` / `ui-tokens` / `mahjong-theme`：全绿。
- 视觉 harness（真实组件 + Chrome headless，未入库）截图：
  `.superpowers/mahjong-visual/tianyue-1334x750.png`、
  `tianyue-1334x1000.png`、`tianyue-1623x750.png`、`tianyue-claim-1334x750.png`。
- **未跑真栈**：本机无 Docker；`scripts/browser-e2e.mjs` 需要 9 容器。真栈截图待补。

## 已知边界/后续

1. **真栈视觉/交互未验**：需在有 Docker 的环境跑 `browser-e2e` 或手动进麻将局；
   重点看 claim 面板、胡牌 banner、结算浮层。
2. **App 端未走查**：PNG 透明边缘/圆头像裁切/中央圆盘在 App webview 的表现需模拟器确认。
3. **claim 面板为竖排**：actions maxWidth 172 下 4 个按钮一行放不下，面板向上长；
   不压自家牌河，但比天月的横排更高。若用户不接受，可考虑把 actions 移到牌河上方。
4. **侧家牌背仍是叠压长条**：pitch 26 / 槽高 34（8px 叠压），接缝较淡；若要更像天月，
   可把 sidePitch 提到 30（4px 叠压），但会改变侧区高度锚点。
5. **中央卡无 claim/ting 时右侧留白**：已用 `hasSide` 隐藏右列并居中圆盘；卡仍 340 宽，
   若想更紧凑可把卡宽降到 260。
6. **结算页未重做**：只把主按钮文字改海军蓝；整页仍是旧色系，另立片可做。
7. **素材脚本依赖 Pillow/numpy**：`scripts/assets/mahjong/requirements.txt`；
   生成结果已入库，正常构建不需要这些依赖。

## 回滚

- 代码/素材：`git revert b1359fe2..f4e64d35`（按需）；旧素材在历史里。
- 基线修复（`f4e64d35`、`4890f4c7`）可单独保留。
- 无协议/服务端/数据库改动。
