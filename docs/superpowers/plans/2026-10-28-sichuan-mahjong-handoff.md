# 四川麻将 · 会话交接（2026-10-28）

> 分支：`majiang`。规则真源：`docs/games/mahjong.md`。
> 设计：`docs/superpowers/specs/2026-10-28-sichuan-mahjong-design.md` v0.3。
> 计划：`docs/superpowers/plans/2026-10-28-sichuan-mahjong.md` v0.1（已过两轮对抗审查）。
> 素材：幼麟棋牌（牌面/音效已提取到 `apps/client/src/pages/table/static/{mahjong,audio/Mj_*.mp3}`）。

## 已完成（均有提交）

| 提交 | 内容 |
|---|---|
| `5796a5b2` | 设计 spec v0.2（第 1 轮对抗审查修订） |
| `e4244807` | 实现计划 v0.1 |
| `3f41d433` | protocol 麻将类型/视图/结算/动作 + `game.play.mahjong` + `RequestMeta.windowId` |
| `775a9f6f` | 牌堆/发牌/换三张/定缺/副露 |
| `8f34214d` | 多行动者窗口内核（pendingActors/acceptsAction/windowId/deadline/CAS/机器人/托管） |
| `2adb3f8d` | `startTurnTimer` 只读 deadline（拒绝/超时不续命） |
| `220484f9` | 形状三路守卫 + `game.mahjong.*` 配置键 + `parseMahjongRules` |
| `9a61daa9` | 胡牌/番型/听牌/状态机/事件账结算/autoplay + 真值表 |
| `2e577d80` | MahjongRuntime/view/record + mahjong/windowId 入站全链 |
| `76ce77e2` | 配置种子/读取器/客户端 boot/开局规则快照 |
| `9891558a` | `CurrencyBurn.penalty` + `burned_penalty` 列 + settle 麻将 burn |
| `eda5dd26` | 用户记录双表 + record/moneyDelta + prepareRecord 麻将字段 |
| `0fbc9db7` | 客户端入口/current_turn seats/幼麟牌面与音效（WIP） |
| `2d97b373` | **T11 客户端**：store 麻将视图/activeSeats/windowId、MahjongBoard/MahjongSeatPanel/MahjongTile/MahjongSettlement、audio/BGM、windowId 透传 |
| `417027bc` | **事件级截断**（`computeMahjongSettlement`）、呼叫转移/退税、sbr 金币闸、记录 dealerSeat、SBR 海底口径 |
| `4cf63ea4` | mock-server/robot-service 适配麻将联合类型 |
| `8233d6df` | 客户端自家缺门/庄/番/临时分展示 + 整局自动推进回归 |
| `6e72a89b` | admin 麻将配置域（11 键 + 规则 JSON 编辑器）、麻将历史接口/页面、风控 mahjong 桶、房间 gauge、财务标签 |
| `098569cc` | **第 2 轮对抗审查修复**：抢杠多响/缺门暗杠/杠上炮番/退税顺序/`game.finished` 出站校验等 10 项 |
| `8ca573fc` | 麻将 11 条音频全部接线 |
| `9b5becf9` | conformance `slice-36-mahjong` + 独立 mahjong oracle + 记录查询 |
| `237542de` | 采纳 dev 的 Redis 订阅 ready 门控/重订修复（基线早于该修复，真栈匹配事件无法下发） |
| `f4a06f4e` | 麻将记录时间列 BIGINT（epoch ms）+ 记录 DTO 去掉 isRobot + 泄漏检查精确键 |
| `69a49e40` | slice-36 去掉探针票、固定等待配置广播 |
| `2ae923fd` | 记录测试适配 isRobot 不下发 |

## 最近绿灯（2026-10-28 03:18）

- 全仓 `pnpm exec turbo run test --concurrency=1`：**30/30 tasks successful**（最终 `2ae923fd` 复跑）。
  - protocol 316、shared 439、game 280、room 1014、currency 590、user 412、client 1553、robot 145、config 492。
- 全仓 `pnpm lint`：18/18 tasks 绿。
- `pnpm verify:admin`：633 checks passed。
- `pnpm -C apps/client run build:h5`：构建成功；牌面 28 张 + `Mj_*.mp3` 11 条进产物。

## T12 剩余（未做/环境受限）

1. **conformance slice（麻将）**：`tools/conformance` 尚无 `slice-36`。计划要求 boot/config、4 人匹配、
   完整机器人局、claim 窗口、重连、结算/对账、记录、admin、暗上线矩阵；需真栈。
2. **真栈/镜像/回滚**：本机无 `docker` 命令（Docker Desktop 未安装/未在 PATH）⇒ 无法执行
   `conformance-stack.sh`、镜像重建、健康基线、回滚演练。需在有 Docker 的机器上补。
3. **真浏览器 e2e**：未跑（无真栈；`scripts/browser-e2e.mjs` 依赖 3000/3001 服务）。
4. **暗上线矩阵**：配置种子全关已就绪；真栈开关矩阵未跑。
5. **回放**：draw 动作不落库（`RecordWriteRequest.actions` 不存在），回放留独立片。
6. **game-service 单副本前提**：窗口串行依赖进程内 `runSerialized`；多副本需外部锁（未做）。
7. **协议/共享 dist**：本仓工作区类型检查用 dist，改动后需 `pnpm -C packages/{protocol,shared} build`；
   CI/镜像构建会自然重建。

## 关键命令

```bash
pnpm -C packages/protocol test
pnpm -C packages/shared test
pnpm -C packages/game-service test
pnpm -C packages/room-service test
pnpm -C packages/currency-service test
pnpm -C packages/user-service test
pnpm -C packages/config-service test
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm verify:admin
pnpm exec turbo run test --concurrency=1
pnpm lint
```

## 已知约定

- `Tile { s:0=万,1=筒,2=条, r:1..9 }`；27 位计数串用于记录。
- 发牌：每家 13 → 换三张（可关）→ 定缺 → 庄摸第 14；杠后补牌从牌墙前部。
- 一局一房；不连庄。
- 花猪 burn 走 `CurrencyBurn.penalty`；`currency_ops.burned_penalty`。
- 麻将资金结算：`computeMahjongSettlement` 逐事件按余额截断；`scoreChanges` 是规则分，
  `money_delta` 是实际钱包变动（含抽水/burn）。
- `game-service` 单副本前提；窗口串行依赖进程内 `runSerialized`。
