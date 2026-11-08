# 川麻红金「皮肤 + 动效 + 功能」收口 —— 交接（2026-11-08）

分支：`dev`　基线：`c880c37c`（皮肤计划 rev2）　实现区间：`c880c37c..0f63eeec`（8 个代码提交；交接文档提交另计）
计划：`docs/superpowers/plans/2026-11-08-mahjong-redgold-skin.md`
视觉基线：`.superpowers/mahjong-redgold/mockup/index.html`（已批准）
前序：几何/交互片已部署测试服 `dev-6e4d634`（`docs/superpowers/plans/2026-11-07-mahjong-table-redgold-handoff.md`）

## 1. 交付内容

| Task | 提交 | 交付 |
|---|---|---|
| 1 | `9f3f7a4d` `a175ffbf` | 17 个红金 tokens；牌桌 stage/felt/12u+14u 双框/内金线（按 offset/u 锚定）；顶栏渐变+金线+40×40 金框返回+场次/底分 22/房间 16；座位牌漆底金棕边 12px 圆角、两行信息、千分位分数、牌面相对角标（左上 1 字/左下 2 字）、头像内金环 |
| 2 | `785a0b20` `981fbce9` | Hub 重构图：6px 金环（border-box）+ 径向底 + 百分比锚点（牌墙 48/40、标签 38%、秒 48%、状态 64%）、四角 12px 漆底金边徽标、compact 显示标签、移除听 N；听牌行「听 N 张」标签；胡牌盘金光（flashKey + matchMedia 兜底）；urgent 仅我方 play 末 5 秒 |
| 3 | `0bae6473` `d7499a60` | 牌面 drop-shadow（dim 合并）；最新牌内联金光 outline；claim 来源金描边；+N 金底深字药丸；已胡标签移河底；移除副露文字标签；亮牌翻转（revealNonce 门控，不回放）；ActionBar 严格 2×2（出牌右下/胡左上/杠右上/过左下/claim 过右下）、漆底金边 12px/24px/3D、主按钮 status→gold+ink、胡按钮 20×30 待响应牌、滑入 0.16s；胡 banner 红金 |
| 4 | `0d8e29b4` `0f63eeec` | rob 杠家副露高亮（claimSourceMeldKey→River→Meld outline）；topMeld k 只对家应用（tileH 不缩放）；结算主按钮红金（含 hover/active）+ 四行 35ms 错峰；发牌轻震；摸牌位抬 8+金边（选中 10 优先）；对手背 20ms 错峰；旧色扫描（麻将组件零残留）；跨局 hu/reveal/meld 水位重置 |
| 后续 | `4d09d334` | mockup 对照修正：座位牌角标槽位（缺优先左上 / 状态第二左下；仅状态时左上）、血战盘徽标单字（缺/听/胡/托）+ 四角映射（left TL / right TR / top BR / self BL）、Microsoft YaHei 字体栈 |

## 2. 验证（本机，2026-11-08）

```text
pnpm -C apps/client test   → 132 files（130 passed | 2 skipped）；1960 passed | 2 skipped
pnpm -C apps/client lint   → vue-tsc --noEmit exit 0
pnpm -C apps/client build  → DONE Build complete（exit 0）
```

- 每个 Task 均经独立子 agent 审查（spec 合规 + 代码质量）；Critical/Important 已修复并复审。
- 整片终审（opus）：**Ready to merge/deploy: Yes**，无 Critical/Important。
- 旧 `mahjong-layout.ts` / `mahjong-layout-v2.ts` 与其测试未改；未动协议/服务端/数据库/admin。

## 3. 决策（mockup 优先；冲突登记）

| 项 | 采用 |
|---|---|
| 牌墙字号 | 48/40（覆盖 v5/v6 的 40/32） |
| 金环 | 6px + 外 2px（覆盖 v5 的「内缩 3px」） |
| 盘徽标 | 12px、四角、单字（缺/听/胡/托）；left TL / right TR / top BR / self BL（覆盖 v6 的 16/14、盘缘） |
| compact 标签 | 显示（覆盖 v6 的隐藏） |
| 座位牌角标 | 缺优先左上、状态第二左下；仅状态时左上（mockup 实际槽位，覆盖 v6 的右上） |
| 字体 | Microsoft YaHei / PingFang SC（mockup 栈；全局栈会先命中 Segoe UI） |
| 分数 | 千分位 + 省略（覆盖 v4/v5 的万压缩） |
| 动作区 | 严格 2×2、出牌右下（覆盖 v4 的 176 宽出牌） |
| 听 N | 只放听牌行上方标签（Hub 不再显示） |
| 托管/更多 | 16px muted 纯文字（非按钮） |
| 倒计时 | 静态金环（v4 的比例环不做，登记） |
| 过收起 | 不做（v4 FLIP 已否决，Vue Transition 未验证） |

发丝线一律 `$ftl-hairline`（2px）；mockup 的 1px 值在实现中取 2px（R714 闸）。徽标/听牌标签 padding 1px→2px 同理。

## 4. 已知残留

1. **七档 × 6 态截图与真机走查未执行**（需真实浏览器/App）：重点看 `1623/1778×750` 留边 felt 锚定、`top29` 盘四角徽标/状态拥挤、rob 胡按钮 20×30 小牌、低端 Android 每牌 drop-shadow 帧率。
2. **共享 revealNonce**：某侧家亮牌时，另一侧已亮的牌会重新翻转一次（单 nonce 设计的副作用；per-seat nonce 可解）。
3. **对家亮牌无翻转**：HandBacks 的 revealed 分支没有 `anim-reveal-in`（仅侧河有）；观感不一致。
4. **自家 delta 与长分数**：64px 宽下 `15,500 + 12` 会横向省略；协议当前不填 `pendingScoreChanges`，线上暂不触发。
5. **同实例第二局**：`seenMeldKeys` 未清（同座同型碰的 pop 不再播）；Board 生产上每局重挂，影响有限。
6. **死/重复 token**：`$ftl-color-mj-gold-soft` 无消费者；felt 颜色以内联 rgb 镜像（inline JS 读不到 SCSS），两处注释已标明。
7. **计划文本漂移**（已登记）：徽标/听牌标签 padding 取 2px；听牌标签边用 `mj-gold`（mockup 用 `mj-border`）；bar 标题 letter-spacing 0.4px（mockup 1px）。
8. **提交署名**：已 reword 为 `Co-Authored-By: Claude Opus 4.8 (1M context)`（`d7499a60`/`0f63eeec`）；重写前后代码树逐字节一致（`fbf05ba…`）。
9. 结算 detail/events 橙色按钮不在本片范围（v4 §3 只要求主按钮 + 行错峰），旧色扫描已豁免。

### 4.1 再次 mockup 对照后的剩余差异（`4d09d334` 已修结构差异）

已修：
- **座位牌角标槽位**：mockup 的规则是「第一个徽标左上、第二个左下」；缺门优先（`['缺万','庄']` → 缺万左上/庄左下；仅「听」/仅「缺」都在左上）。此前是「状态左上/缺左下」，所有缺门徽标位置都反了。
- **血战盘徽标**：mockup 是单字（缺/听/胡/托），此前是「缺万/胡 3/托管」；四角映射改为 left TL / right TR / top BR / self BL（与 mockup top29 截图一致）。
- **字体**：`.mj` 改用 mockup 栈 `Microsoft YaHei / PingFang SC`（全局栈在 Windows 先命中 Segoe UI，数字形状不同）。

仍未改（spec 取舍/数据真实，非 bug）：
- **手牌间距**：实现 `gap 2px`（设计 v1）；mockup 无 gap（手牌行窄约 28px）。
- **对手牌背数量**：实现按 `cardCounts`（开局 13）；mockup 固定 14。
- **最新牌**：实现 `outline-offset 0` + 2px 牌影；mockup `offset 1` + 1px 牌影（网格 2px 间隙会吃掉 1px offset）。
- **`.mj` 基础文字色**：仍 `#212121`，但麻将区文字基本都有显式 cream/gold；mockup 全局 cream。
- **结算**：面板仍蓝、次要「返回大厅」按钮仍灰蓝；v4 §3 只要求主按钮红金 + 行错峰。
- **听牌行**：实现 flex-wrap（4/行），mockup 4 列 grid；视觉一致。

## 5. 回滚

- 整片：`git revert --no-commit c880c37c..0f63eeec && git commit`（或按单个 Task 提交 revert）。
- 皮肤只改客户端展示层；前序几何/交互片仍在，回滚皮肤会回到旧绿桌但功能不丢。
- **已部署测试服 `dev-362b9f9`**（2026-11-08；健康检查 200、admin/app.js 与 tag 逐字节一致）；上一版回滚面 = `dev-6e4d634`。
- APK **0.1.11 / versionCode 111**（20,398,169 B，sha256 `83f655a3fa56…`）已发布 Release `apk-latest`，edge `/download/ubigame.apk` 与资产 digest 一致。

## 6. 下一步（需要用户）

1. 真浏览器七档截图 + 真机走查（§4.1）。
2. 决定 per-seat reveal nonce / 对家亮牌翻转是否补。
3. 观察线上新皮肤后再决定是否合 master / 打 tag。
