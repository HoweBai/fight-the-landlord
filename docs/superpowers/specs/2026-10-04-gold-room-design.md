# ②金币场 —— 设计（2026-10-04）

> **作者**：协调者（opus）；**状态**：v1.2（r1 评审 1🔴+11🟡+3🟢 全数处置；差异复核 12/15 真闭合后 3 条订正 + 6 条补强——两轮映射见文末修订记录）。
> **定位**：P2′ 变现链三步走的**第二步**（用户 2026-10-03 裁决 J1）。① 货币核心已暗上线（`a51b5b0`）；本片把货币接到**对局**上并把玩家可见面全部转正。
> **开工必读**（已读）：路线图 P2′ 节 + 附录 §6 #21/#29/#34（#21/#29/#34 复用 ① 结论——幂等机制=actionId+指纹、防重放、服务拓扑均为 ① 已答）；① 设计 §12 接手须知；① 规格 ⚙️14（本片**准入阻碍项**，见 §7）。
> **本片消费的 ① 预埋**（① 设计 §1.3）：`owner_type='robot'` 列 · `source` allowlist 协议单点 · `currency.apply` 批量原子 · `currency.get` 批量读 · `game_record_players.money_delta` 预留列 · 管理面「钱包调整」 · 对账三检查与监控接缝。

---

## §0 用户裁决（本片边界，不得违背）

**继承**（货币设计 §0）：J1 三步走（本片=②）· J2 免费场保留、新增金币场、**两场各有开关** · J3 金币场补机器人、**用虚拟币池**（附录 §3.7 规则，数值设计时复核）· J4 注册赠送=配置键默认 0。

**本片新裁（2026-10-04）**：

| # | 裁决 | 落地处 |
|---|---|---|
| J7 | **要抽水**：比例**可配置、默认 0**；>0 时从赢家入账扣、**系统回收**（销毁口径，非入池） | §5.4、键 `currency.rakePercent` |
| J8 | **入场门槛 = 底分 × 倍率**（倍率可配置） | §4.1、键 `currency.entryMultiplier` |
| J9 | **做每日救助**：开关可配 + 金额可配；**形式 = 看广告**（本片先做机制，见 J11）；余额低于最低档门槛时每天可领一次 | §4.4、键 `currency.reliefEnabled`/`currency.reliefAmount` |
| J10 | **机器人水位不许落在整千整百**（原话「不要给整数，整数容易看出端倪」——金币只能取整数，口径=**非整百/非整千**，每机器人不同） | §5.2（确定性哈希派生） |
| J11 | **广告范围**：② 只做**救助机制 + 客户端占位流程**（点击→发放）；真正的广告 SDK（需用户注册广告平台、提供广告位 ID，H5 与 App 可能两套）**另立小片**，在开启救助前接上 | §7 残余风险 |

补充口径（已向用户确认）：单局输额可能超过余额（大倍数）⇒ **输光截断、不欠账**（§2 D3）；「退出线」语义从附录的「停止参与」**订正为「回收线」**（§2 D6，属 J3 授权的"数值复核"范围，呈用户确认）；机器人水位**三档**（附录「初始」并入「目标」——首次补给即建号入金，呈用户确认）。

---

## §1 范围

### 1.1 交付清单

1. **对局结算接线**：金币场每局一条 `currency.apply`（`settle:<room>:<ver>`），三人 entries；`game_record_players.money_delta` 回写。
2. **机器人虚拟币池**：池账户 + 每机器人非整百水位 + 双事件驱动补给/回收（§2 D6）。
3. **双开关**：`room.freeRoomEnabled`（默认 true）、`room.goldRoomEnabled`（默认 false，暗上线）。
4. **玩家可见面**：大厅余额 + 场次切换（免费/金币）+ 门槛提示 + 救助入口；牌桌货币占位转正（**仅金币场**，§2 D7）；结算页金币列；战绩页金币列。
5. **观测**：结算/池/救助指标 + 3 条告警规则 + 1 块 Grafana 面板。
6. **闸族同步**：配置键 11→17、客户端配置键 3→6、错误码 +3、S→C 消息 +1、协议 mode 联合 +'gold'、模式二值判断点全数三值化（§2 D1，含 🔴 取消排队缺陷面）（§3.7 清单）。
7. **准入阻碍项（硬前置，① 规格 ⚙️14 的 ② 准入条款）**：货币类型闸保持锁定读形态 + **真库双会话负向用例**过（§7.1；先于任何机器人资金写入）。
8. conformance 新片 `slice-18` + 既有片计数同步。

### 1.2 明确不做（留下一片，防歧义）

- **广告 SDK 接入**（J11；客户端只做占位流程）；
- **充值/退款/提现**（支付片）；**RBAC/财务后台/审计视图**（③；本片不动管理页钱包调整块）；
- **玩家流水明细页**（③）；
- **好友房金币化**：金币场仅经匹配进入，`POST /api/rooms`（好友房/practice）不接受金币模式；
- **托管机制**：本仓不存在「托管」（`isOffline` 恒 false、全仓零命中）——本片**不引入**，只声明结算语义（§2 D9）；
- **多实例调度去重**（P5 债务；本片 actionId 设计使重复触发天然幂等，但 14002 收敛路径见 §2 D4，P5 前登记）；
- 排行榜 / ELO / 机器人 AI 变更 / K8s。

### 1.3 对 ① 预埋的消费与扩展

| ① 预埋 | ② 用法 | 是否需扩展 |
|---|---|---|
| `owner_type='robot'` | 机器人账户 = 普通账户 + 该类型 | 否（形态已就绪） |
| `source` allowlist | 扩 `game_settle` / `robot_pool` / `relief_grant` | **是**：`protocol/src/currency.ts:17` 单点 +3 |
| `currency.apply` 批量原子 | 一局一条、三人 entries | 否（上限语义见 D3） |
| `currency.get` 批量读 | 结算前读余额（截断计算）、门槛校验、补给观测 | 否 |
| `money_delta` 预留列 | 结算成功后回写 | **是**：新 RPC `record.moneyDelta`（§2 D5） |
| 14xxx 错误码 | +14003/14004（货币侧）、12010（房间侧） | **是**：`errors.ts` + `design.md §11.2` + `errors.test.ts` 三处同改 |
| 配置快照消费样板 | currency-service 首次接配置（仅救助三键，D10） | **是**：照 user-service `config-cache` 样板 + meta-on-send |

---

## §2 形状与决策（D1–D13）

### D1｜场形态 = 新 mode `'gold'`，且**模式二值判断点全数三值化**

`MatchMode = 'random' | 'practice'`（`room-service/src/match/match.service.ts:27,37`）**扩为三值** `+ 'gold'`。理由：金币场需要对局记录可区分（战绩页金币列、mode→中文映射）、队列天然按 mode 分键（`match:queue:{mode}:{baseScore}:{region}`）、双开关按 mode 生效、好友房（practice）不复用于金币。**已否方案**：random + 资金标志位——两个维度挤进一个布尔位，在记录/开关/客户端三处都会长出分支。

- 金币场**仅经匹配进入**；REST 建房（`POST /api/rooms`）保持 practice-only（`rooms.dto.ts` 的枚举**不加 gold**）。
- **复用同一张底分档位表**（15/80/480/1200）；**已否**独立档位表（多一键 + 客户端两组卡，收益为零）。

🔴 **r1 抓到的硬缺陷（本片随 D1 必修）——模式二值判断点**（grep 实测全列，改造后必须三值）：

| 位置 | 现状 | 不改会怎样 |
|---|---|---|
| `match.service.ts:197` `readMeta` | `raw.mode==='practice'?'practice':'random'`（**二值归一**） | 金币票读回 'random' ⇒ `cancelQueue`（:282-298）ZREM **错键**、随后删 meta ⇒ **票留在金币队列成孤儿**；玩家可能被拉进已取消的金币局（真实资金面），跨模式查重/`ALREADY_IN_QUEUE` 全部失明 |
| `message.router.ts:313` `otherMode` | `probeMode==='random'?'practice':'random'`（**只探另一支**） | 金币票的「另一模式」探测漏掉其一；重复入队在金币维上探测不到 |
| `match.service.ts:27,37` `MATCH_MODES` | 二值数组 | 新值与校验面不同步 |
| `messages.ts:41` / `validate.ts:332-333` / `views.ts:31` / `rpc.ts:211` / `message.router.ts:293` / `rooms.service.ts:12` | 各处二值联合 | 类型/校验面 |
| user-service `records.service.ts:50` / `rpc/record.rpc.controller.ts:57` | 二值 + 校验字符串 | 金币对局记录被拒 |
| 客户端 `net/rest.ts:345`（MyRecord）/ `socket.ts:1159-1172` 接收表 / `net/session.ts` 分发表 | 二值联合 | 类型面三值化；**`net/rest.ts:288` 与 `game.vue:274-275` 保持二值**（REST 建房 practice-only，勿机械三值化） |

**修法**：`readMeta` 改**保真三值**（非法/缺省仍落 'random'，兼容旧 meta）；`handleMatch` 的探测改为**覆盖其余两种模式**（除本次 mode 外的两个键都探）；其余各处三值扩展。**判据**：取消金币排队后 ⇒ 金币队列无残留、meta 已清、60s 内不会再被撮合（进 C21）。

### D2｜双开关：服务端裁决 + 客户端隐藏

- 新键 `room.freeRoomEnabled`（默认 **true**，保持现状）、`room.goldRoomEnabled`（默认 **false**，暗上线，由用户开）。
- **服务端**：`handleMatch` 前置检查——mode 被关 ⇒ 新错误码 **12010 `ROOM_MODE_DISABLED`**（TOAST）。好友房不变（`room.friendRoomEnabled` 走既有 12006）。
- **客户端**：两开关进 `CLIENT_CONFIG_KEYS`（3→6，§3.5）；大厅按开关渲染场次入口；双关时空态文案。

### D3｜结算语义：金额=分差；输光截断；抽水按赢家逐一 floor；上限 source 化

- **金额 = 分差**：`shared/src/ddz/settle.ts:31-37`——`multiplier = 叫分 × 2^炸弹 × 春天`、`unitScore = baseScore × multiplier`；地主 `±2u`、农民各 `∓u`。金币场里 1 分 = 1 金币，**不加换算系数**（底分即筹码）。
- **原始 delta 映射**：座位分差按 `landlordSeat/winner` 落到三人（与记录片 `record.rpc.controller.ts:193-196` 同一推导口径）。
- **截断（输光不欠账）**：倍数是炸弹指数级 ⇒ 输家应付可能超过余额。
  - 输家实际支付 `p_l = min(应付, 余额)`（余额 = 结算前 `currency.get`）；
  - 赢家应得 `g_w = floor(赢家原应得 × Σp / Σ应付)`；
  - 残差 `Σp − Σg_w ∈ [0, 赢家数)` **销毁**（日志 + `currency_settle_residue_total`；无截断时恒 0）。
    **2026-10-26 起**：零头改分给赢家、residue 恒 0，见 `2026-10-26-settle-remainder-to-winners-design.md`。
- **单条上限（r1 🟡-3；v1.2 依复核订正依据链）**：`currency.ts` 现 `MAX_ABS_DELTA=1e6` 是全 source 硬限——三处必撞：① 池种子 5,000,000（runbook 须**拆 5 笔 ×1,000,000**）；② 高倍局赢家入账可超 1e6（`BID_MULTIPLIER_CAP=8`（`shared/src/ddz/bid.ts:12,74`）× 2^炸弹(≤13) × 春天2 ⇒ 单条上界 = `maxBaseScore × 2^18`，现档位 1200 ⇒ ≈3.15e8）⇒ 照 1e6 会**永久 10001 拒结**，与「输光截断兜底」矛盾；③ 机器人水位随 `max(baseScoreLevels)`（管理面可放大）同样可破。**修法**：`MAX_ABS_DELTA` **source 化**——`game_settle`/`robot_pool` 上限定 **1e12**（对现档位富余 ~3200×；**哨兵语义 = 抓算法 bug，不是经济参数**；只有当档位表被放大到 `maxBaseScore > 3.8e6` 才会触发——那属配置异常，落告警/runbook），其余 source 保持 1e6（保留管理面防手滑语义）。规格落校验函数改动 + 测试。
- **抽水**（`rakePercent = p`，0..50）：每个赢家 `rake_w = floor(g_w × p / 100)`，实收 `g_w − rake_w`；抽水**销毁**（J7）。`p=0` 时与零和完全等价。
- **entries 组装**：只收非零 delta（`delta ≠ 0` 是 ① 校验硬约束）；全零 ⇒ **不调 apply**（无资金移动，但仍广播，D7）。人类 ownerId=userId；机器人 ownerId=botId、`ownerType:'robot'`（与 record 的 robotId 同源：`room:{code}:bots` 座位映射）。
- **零和自明**：无截断且 p=0 ⇒ entries 和恒 0；有截断/抽水 ⇒ 和 = −(残差+抽水)。

### D4｜结算位置与失败补偿（对局不得被卡）

- **位置**：`finalizeRoomEnd`（`ws.gateway.ts:790-825`）——例程在 ① 读 bots 之后（**:809 处**）以 `void this.settleMoney(...)` 启动，**在 `!record||!version` 早返（:812-817）之前**、与 `writeGameRecord` 并行、互不阻塞（沿用「广播已同步发出、收尾 fire-and-forget、失败只记日志」姿态）。金币场之外直接跳过。
- **守卫**：`mode==='gold'` ∧ `result` 存在 ∧ 三座位齐全；缺任 ⇒ WARN + 指标（**金币局异常终局**，人工核；理论不发生）。⚠️ **mode 与「人座 ownerId」的来源 = 房间元数据**（`roomsService.findOne`，同 `writeGameRecord:865` 口径）+ `room:{code}:bots` 映射——`GameEvent`/`RecordEnvelope` 均不带 mode；room 数据缺失（TTL 窗）⇒ WARN 跳过（与记录链同口径）。结算**不依赖 record 信封**；老会话窗口不会出现金币局。
- **时序**（§4.2）：`currency.get` → 截断+抽水 → `currency.apply`。
- **失败分级（r1 🟡-2 补全，四类全覆盖）**：

| 响应 | 语义 | 处置 |
|---|---|---|
| 超时 / 传输故障 / 10007 | **结果不明** | **只准原样重发**同 actionId+同载荷（① §5.5 口径；重放 ⇒ 幂等闭合），短退避至多 2 次 |
| **14001** | 确定性回滚（整批原子、未记账） | 允许**重算轮**：重读余额→重算→`settle:<room>:<ver>:r2` 重发（新 id 安全，因 `:r1` 已证未生效；至多一轮） |
| **10001** | 确定性回滚（校验/类型闸；**修 D3 上限后不应可达**） | **终态不重试**（同参重发无益）：响亮 ERROR + 指标 + runbook |
| **14002** | 同 id 异载荷——**他方已结算**（胜出载荷本侧不可见） | **终态不重试**：响亮 ERROR + 指标 + `money_delta` 留 NULL + runbook（以 `currency_flows` 核对）；P5 登记 fanout 双结算 |

- 重试仍失败 ⇒ 落 **Redis outbox**（`settle:outbox`，TTL 1h）+ 响亮 ERROR + 指标；**sweeper**（room-service 定时，10s）原样重发；**outbox 最老条目 > 300s ⇒ 告警**（早于 TTL；TTL 只做清理）。
- **失败姿态**：结算最终失败也**不卡对局**——广播、归池、记录全不受影响；余额不变、`money_delta` 留 NULL、告警响亮——**宁可账面可见地没结算，不可静默**。

### D5｜`money_delta` 回写 = 新 RPC `record.moneyDelta`（与 record.write 解耦）

- 结算成功（含 replayed）后，room-service 调新 RPC `record.moneyDelta {roomCode, gameVersion, deltas:[{seat, delta}]}`——**deltas = 三人语义向量、含 0**（零变动座写 0，不留 NULL）；user-service 逐座 `UPDATE game_record_players p JOIN game_records r ON p.record_id=r.id SET p.money_delta=? WHERE r.room_code=? AND r.game_version=? AND p.seat=?`（⚠️ 该表只有 `record_id`，无 room_code/game_version 列——`1789400000000-GameRecords.ts:48-66`），**回执 = 命中的座位集合**（⚠️ 不能用 affectedRows：MySQL 同值重写返回 0，幂等重发会被误判「未落库」）。
- **收敛判据** = 三座位齐（缺 ⇒ 留 outbox 重试；record 行可能尚未落库，两写皆幂等、乱序无害；record 链长期失败时重试至 TTL，金币列留 NULL——可见、不静默）。
- **为什么独立而不塞进 record.write**：结算与记录是两条独立 fire-and-forget 链（D4）。独立 RPC 把补写做成**唯一路径**（正常/重试/outbox 同形态）。`record.write` 契约**零改动**。

### D6｜机器人池：确定性水位 + 池账户 + 全事件驱动（无定时 job）

- **池账户**：`owner_type='robot'`、`owner_id='robot-pool'`。**种子** = 上线 runbook 经管理面 `POST /api/admin/wallet/adjust` 注入 **5,000,000（拆 5 笔 ×1,000,000**，单笔 `MAX_ABS_DELTA` 约束，D3）；池余额可观测（§3.6）。
- **每机器人水位：确定性哈希派生**（不落表、无状态、重启不变；J10 非整百）：`h = sha256(botId)` 取四段；`top = max(baseScoreLevels) × entryMultiplier`（默认 1200×10=12000）：
  - **补线** `refillLine = top + 300 + h1 % 601`（默认 12,300..12,900）；
  - **目标** `target = floor(top×1.15) + h2 % (floor(top×0.2)+1) + h3 % 97`（默认 13,800..16,296）——**首次补给即「初始」**（建号入金到目标，三档水位呈用户确认）；
  - **回收线** `recallLine = floor(target×2.8) + h4 % (floor(target×0.4)+1)`（默认 ≈38.6k..52.1k）；
  - **非整百修正（v1.2 复核实测补）**：三式结果 `%100===0` ⇒ `+1`（原式 ~1% 密度会落整百——玩家可见值必须永不整百/整千）。
  - 三档随 `top` 联动 ⇒ 调 `entryMultiplier`/档位表后水位自动盖过最高档门槛。
- **双事件驱动（r1 🟡-7/🟡-8 后的形态：**无定时 job、资金算式全在 room-service**）**：
  - **入座前 ensure**（`fillBots` 内，金币场专属）：`currency.get(botIds)` → **账户缺失或余额 < 补线** ⇒ `apply(rr:<botId>:<target>:<观测>)` 补到目标（首建带 `owner_type='robot'`）。**失败 ⇒ 按既有补位失败路径**（`fillBots` 返回 null → 不开局 → 匹配路径 cancel + 重试计数），不允许 0 余额机器人上桌。**ensure 后未上桌**（开局失败/房间取消/N36 路径）：补款留机器人账户（下轮复用、不双补）——长期=僵尸通缩口径（§7.7），明确接受。
  - **结算后检查**（settle 例程内，用 apply 响应的 `balanceAfter`）：被结算打穿到补线以下 ⇒ 补（同 rr 式）；高于回收线 ⇒ 回收 `rc:<botId>:<target>:<观测>`（bot→pool）。
  - **为什么删掉 60s 扫描 job**：job 按 `LIKE 'bot-%'` 扫会把**已死账户**（身份被 robot-service 回收、`robot.pool.ts:202-291`）也补钱进去（纯漏）；ensure/post-settle 永远只作用于「正在玩」的机器人，无漏且少一个定时器。**僵尸余额**（身份回收后账户停在原水位）不清理、不补：它是**通缩**（系统币量净减），无害；上观测指标兜着（§3.6）。
  - **幂等由 actionId 承担**：同观测的重复触发 ⇒ 同 id 同载荷 ⇒ replayed（不双补）；不同观测 ⇒ 第二发时余额已越线 ⇒ 跳过。多实例重复触发**天然幂等**（§7.4 余一条毫秒窗待证）。
- **进场资格**：机器人**不做**门槛校验（与人类不同）；由「补线 > 最高档门槛」+ 入座前 ensure 保证永远够格。**已否** acquire 按余额过滤（需 robot-service→currency 新依赖 + 余额感知池查询，成本远大于收益）。
- **身份**：botId 唯一生成点 `robot.pool.ts:428-439`（`bot-`+8hex，12 字符，满足 ownerId 正则）；货币账户不随身份回收删除（见上，通缩口径）。

### D7｜余额可见性：**仅金币场**显示真值（不可区分性红线）

- **金币场**：三座显示各自钱包余额（真值）。机器人余额非整百（J10）且已 ensure，无区分器。
- **免费场/好友房**：维持「货币恒为 —」（`PlayerChip.vue:14-36`、`Seat.vue:117-123`）。**为什么不能只显示人类余额**：免费场机器人没有资金账户 ⇒ 若人类显真值而机器人显「0/—」，等于发区分器；**整场统一「—」**是唯一安全形态。
- 落地：`RoomPlayer.balance?: number`（仅金币场，开局 `currency.get` 填充）；局终新增 S→C **`game.balances`** `{balances:[{seat, balance}]}`——**三态收敛（r1 🟡-12）**：
  1. 结算成功 ⇒ 广播 apply 响应的 `balanceAfter`（⚠️ **replayed 的 balanceAfter 是历史快照**，apply 自注 `apply.service.ts:452-459`——语义标注「结算时刻余额」，余额 chip 以后续拉取/推送为准）;
  2. 全零局（不调 apply）⇒ 用刚读的 `currency.get` 余额**照常广播**；
  3. 结算终态失败/结果不明 ⇒ 不广播，客户端 5s 超时把金币列定格为「—」（**不永久停在「结算中…」**）。
- 结算页金币列以该消息为准（未到且未超时显示「结算中…」）。

### D8｜入场门槛校验（仅金币场、仅匹配路径）

- **锚点（r1 🟡-5 修正）**：`handleMatch`（`message.router.ts:290-331`）内、**孤儿/重复探测（:309-324）之后、`addToQueue`（:326）之前**——保证任何队列写入前完成资金校验。（`assertKnownBaseScore` 真身在 `addToQueue` 内部 :224，不在 handleMatch，v1.0 文字已订正。）
- 检查：开关（D2）→ `currency.get(userId)` ⇒ `balance ≥ baseScore × entryMultiplier`，否则 **14003 `E_ENTRY_THRESHOLD`**（TOAST，文案含所需金额）；`currency.get` 失败 ⇒ 拒入 10007（**不允许盲入**——门槛是资金安全面）。
- REST 建房（practice）不查；重连/回座不查（已在座）；队列中余额被降（管理调整）不复查（接受窗口，台账登记）。
- **机器人脚注**：fill 路径不查余额（D6）。

### D9｜断线/托管语义：显式声明，无特殊分支

现状：`isOffline` 恒 false（`shared/src/ddz/game.ts:40-41`）、无托管、断线只清连接并开重连窗（`ws.gateway.ts:437-470`）。⇒ **结算按座位、与连接状态无关**：断线玩家照常参与局终结算，重连后从战绩/余额看到结果。本片不引入托管。

### D10｜每日救助

- **端点**：`POST /api/wallet/relief`（currency-service；经网关、`X-User-Id` 头，与 `GET /api/wallet/balance` 同族）。
- **裁决序**：`reliefEnabled` 关 ⇒ **14004 `E_RELIEF_UNAVAILABLE`**；余额 ≥ 最低档门槛（`DEFAULT_BASE_SCORE(15) × entryMultiplier`，默认 150）⇒ 14004（文案不同）；否则 `apply {actionId: relief:<userId>:<YYYY-MM-DD(Asia/Shanghai)>, source:'relief_grant', entries:[{+amount}], refId:userId}`——按天幂等由 actionId 承担：同日重复 ⇒ replayed ⇒ `{granted:false, replayed:true}`（客户端按「今天已领过」处理）。**同日改金额再领** ⇒ 捕获 14002（同 id 异载荷）**翻成同一「已领过」响应**（r1 🟢-13；不暴露冲突细节、不双发）。
- **响应**：`{granted, amount, balance}`。
- **配置依赖（r1 🟡-8）**：currency-service **首次接配置快照**（照 user-service `config-cache.service` 样板：RPC 带 meta、缓存 + 失效），仅读 `currency.reliefEnabled`/`currency.reliefAmount`/`currency.entryMultiplier` 三键；测试族与新 RPC 边入 D12。
- **客户端**：`reliefEnabled` 随客户端配置下发；按钮在余额低于门槛时点亮；流程 = 点击 → 确认弹层（**占位：直接发放**）→ POST → 刷新余额 + toast。**广告小片接入点**：确认与实际 POST 之间插「播放激励视频→回调」（J11）。
- **金额**：`currency.reliefAmount`（范围 **1..1,000,000**——`0` 用开关表达，避免「开了但金额 0 ⇒ 每领必 10001」；默认 200 ≥ 最低档门槛 150）。

### D11｜观测

- **room-service 侧**（既有 `/metrics` + prom-client）：`currency_settle_total{result: ok|replayed|insufficient|timeout|failed|conflict|invalid}`、`currency_settle_residue_total`（**截断**残差销毁额；上限拒结走终态告警、不计入；**2026-10-26 起**改为回归哨兵：正常路径恒 0，见 `2026-10-26-settle-remainder-to-winners-design.md`）、`currency_settle_outbox_size`、`currency_settle_outbox_oldest_seconds`、`currency_robot_topup_total{action: refill|recall}`、`currency_robot_ensure_failed_total`。
- **currency-service 侧**（既有 `currency.metrics.ts` 同族）：`currency_robot_pool_balance`（对账循环刷新）、`currency_robot_accounts_balance_sum`（僵尸余额通缩观测）、`currency_relief_total{result}`、既有 `currency_apply_total{source}` 自动覆盖三个新 source。
- **新告警规则 3 条**（`deploy/monitoring/prometheus/rules/ftl-alerts.yml`，13→16）：`CurrencySettleOutboxStuck`（oldest > 300s for 2m）· `CurrencyReconcileDrift`（`currency_reconcile_drift_accounts > 0` for 10m，① 已有指标无规则）· `CurrencyRobotPoolLow`（pool < 1,000,000 for 10m）。
- **Grafana**：+1 资金面板（余额总量、池余额、settle 结果、救助/补给速率）——面板计数断言 4→5 同核（slice-16）。
- 结算失败日志 = 既有九字段 NDJSON + traceId，含 roomCode/version/round。
- **回填注记（实施期，2026-10-04）**：指标名与标签集**以规格 §11.1 为准** —— 结算结果标签按处置分流为 `ok|replayed|retried|r2|outboxed|dropped`（取代本条第一行设计的 `insufficient|timeout|failed|conflict|invalid`）；登记处 = 规格 §11.1「偏差登记（命名）」。另：经 outbox 收敛的局 `currency_settle_residue_total` 少计（少计额 = 该局 residue；规格 §11.1 附注）。

### D12｜闸族同步总表（设计级；规格逐条定位）

| 面 | 位置 | 改什么 |
|---|---|---|
| 配置键 | `protocol/src/config.ts:13-27,57-67` | 数组 11→17 + 6 个 parse 分支（§3.5） |
| 客户端配置 | `config.ts:30` + `client-config.controller.ts:25-38` | 3→6 键 |
| 种子 | `config-service/src/migrations/`（照 `1789700000000-SignupGrant.ts` 样板） | 新迁移 1 个、6 行 |
| 测试族 | `config.test.ts`、`platform-config.service.test.ts`、`helpers/config-probe.ts`、`admin.controller.test.ts`、`config.rpc.test.ts`、`client-config.test.ts`、`migration.test.ts`、user-service `config-cache.test.ts`、**room-service `test/config-cache.test.ts`（新 getter 用例）**、mock-server `rest.test.ts`、**currency-service 新配置族** | 键数 11→17 / 3→6 及新键用例 |
| 管理页 | `admin/app.js` `CONFIG_NOTES`（:50-117）+ 散点（:29,37,47-48,186,206）+ `style.css:275` | 11→17 条 + 清扫 |
| 手册 | `docs/ops/first-deploy.md:933-944` + 改配置流程 | 键表 17 + 池种子/结算 runbook 两节 |
| 主设计 | `docs/design.md §7.5`（:1091-1117）+ 散点（:142,403,487,494,1279,1428,1887） | 17 键表 + 散文清扫 |
| 错误码 | `protocol/src/errors.ts:30-56` + `CLIENT_ACTION` + `design.md §11.2` + `errors.test.ts SPEC_CODES` | +12010/+14003/+14004（全 TOAST） |
| 协议消息 | `messages.ts:40-95`（9+9 常量表）、`validate.ts`、`messages.test.ts:38`（`toHaveLength(9)`） | C→S mode +'gold'；S→C +`game.balances`（9→10，注释与常量表同改） |
| 协议文档闸 | `apps/client/test/protocol-doc-sync.test.ts:86-98` + `docs/client-protocol.md`（:54；:155 为「S→C：九条」标题） | 消息表 + 错误码表成行、'S→C：九条'→十条 |
| 视图 | `views.ts:31`（RoomInfo.mode）、`:39-43`（RoomPlayer.balance?） | +'gold' / 可选字段 |
| 货币协议 | `currency.ts:17`（sources）、`:70,122-126`（上限 source 化） | +3 source；`MAX_ABS_DELTA` 分档 + 测试 |
| RPC | `rpc.ts` `RPC_PATTERNS` + `RecordWriteRequest.mode:211` | +`record.moneyDelta`；mode +'gold' |
| user-service | `rpc/record.rpc.controller.ts`（mode 校验 :57）、`records.service.ts:50,219` | 新 handler + mode 三值 + **MyRecord DTO 11→12 键（moneyDelta）** |
| room-service | router/match（三值化 + 门槛 + 探测）/gateway（settle 例程、game.balances 广播）/新 `currency/` 模块（两个 client + outbox + 水位派生）/`config/config-cache.service.ts`（新 getter：entryMultiplier 等） | §4 时序；**无定时 job** |
| 客户端 | `lobby.vue`、`game.vue`、`PlayerChip.vue`、`Seat.vue`、`Settlement.vue`、`history.vue`、`net/rest.ts:288,345`、`net/session.ts:145-155`（分发表）、`net/socket.ts:1159-1172`、`stores/game.ts` | §3.4 |
| conformance | `run.ts:34,69`、`baselines.json`、`slice-16`（规则 13→16、面板 4→5、:88-94/:592/:655/:717-721）、`slice-14`（C7 三键→六键 :490-497）、`slice-17`（C14 :1221-1233）、**`slice-15`（MyRecord 11→12 键 :381,411）** | 新片 `slice-18` + 计数同步 |
| 注释/杂项 | `api-gateway` :118,131、`conformance/lib/http.ts:225`、`docs/client-protocol.md:54`、`docker-compose.yml:332,438`、user-service 迁移注释:7、user-service `config.client.ts:15` | 「十一键」类字面量清扫（并入 C17 的文件扫描断言） |

### D13｜⚙️14 准入阻碍项（硬前置）

**任何机器人资金写入之前**：① 复核 `apply.service.ts` 类型闸仍为 ⚙️14 形态（快照步 `SELECT … FOR UPDATE` + `owner_type` 断言 + `affectedRows===1`；假遮蔽点 `test/helpers/fake-currency-db.ts:216-218` 在案）；② **真库双会话负向用例**过（dev MySQL 8.0.46，按 T3 审查同规程：并发异型首写交错必须被 10001 拦下、整批回滚）；③ 新增机器人语料变体（botId 作为异型首写一方）。**规格落字规程全文**（命令、交错时序、期望回滚证据、**判别力负对照=旧普通 SELECT 形态必红**）；证据入台账。未过不进 D4/D6 的施工。

---

## §3 接口与数据面

### 3.1 货币侧

- 无 schema 变更（`owner_type` 列 ① 已建）。**只**加：source allowlist +3、错误码 +14003/+14004、`MAX_ABS_DELTA` source 化（D3）、池账户（数据行）、池余额与机器人余额总和技术指标（对账循环刷新）、**config client（仅救助三键，D10）**。
- `currency.apply` / `currency.get` 契约形状零改动。**结算/补给/回收的算式全部住在 room-service**（它有配置面与资金链路上下文）；currency-service 保持「纯账本 + 救助端点」。

### 3.2 协议面

- `room.match.payload.mode: 'random' | 'practice' | 'gold'`（D1 清单全处）。
- S→C 新消息 `game.balances`：`{type, version, payload:{balances:[{seat, balance}]}}`（金币场限定；常量表 9→10；`socket.ts` 接收表同步）。
- `RoomPlayer.balance?: number`（仅金币场下发）。
- RPC：`record.moneyDelta`（唯一新 RPC；ensure/补给/回收 = room-service 用既有 `currency.get`+`currency.apply` 组合，无新 RPC）。

### 3.3 user-service

- 新 RPC handler `record.moneyDelta`（逐座幂等 UPDATE、回执=命中座位集合，D5）；无迁移、无表变更。
- records 读取面：`moneyDelta` 进 `GET /api/records/mine` 白名单 DTO（**MyRecord 11→12 键**；战绩页金币列数据源）。

### 3.4 客户端面

- **大厅**：顶部余额 chip（`GET /api/wallet/balance`，登录后拉、回厅刷新）；右栏上方「免费场 / 金币场」切换（按开关渲染，双关空态）；金币档位卡显示门槛提示（「需 ≥ {baseScore×N} 金币」）；余额不足时卡置灰 + toast；`reliefEnabled` 且余额 < 最低门槛 ⇒ 「领取救助」入口。
- **开始游戏**：`room.match` 的 mode 随所选场次（替换 `game.vue:139` 硬编码 `'random'`）。
- **牌桌**：金币场 `PlayerChip`/`Seat` 占位转真值（数据源 D7）；免费场保持「—」。
- **结算页**：金币场加「金币」列（`game.balances` 到达前「结算中…」，5s 超时定格「—」，D7 三态）。
- **战绩页**：`mode='gold'` 显示金币列（`moneyDelta`，NULL ⇒「—」）；mode 中文映射 +「金币场」。
- 客户端闸同步：`source-boundary` 扫描、`protocol-doc-sync`、`base-score-selection`/`lobby-modes`/`player-chip`/`table-settlement-ui`/`history-records` 各测试族按新面补用例。

### 3.5 配置面（11→17，客户端 3→6）

| # | 键 | 类型/范围 | 种子 | 客户端可见 |
|---|---|---|---|---|
| 12 | `room.freeRoomEnabled` | strict boolean | `true` | ✅ `freeRoomEnabled` |
| 13 | `room.goldRoomEnabled` | strict boolean | `false` | ✅ `goldRoomEnabled` |
| 14 | `currency.entryMultiplier` | int `1..100` | `10` | ❌ |
| 15 | `currency.rakePercent` | int `0..50` | `0` | ❌ |
| 16 | `currency.reliefEnabled` | strict boolean | `false` | ✅ `reliefEnabled` |
| 17 | `currency.reliefAmount` | int `1..1000000` | `200` | ❌ |

`CLIENT_CONFIG_KEYS = ['baseScoreLevels','friendRoomEnabled','freeRoomEnabled','goldRoomEnabled','reliefEnabled','version']`（恰 6；泄漏名单前缀 `currency.`/`record.`/`robot.` 语义不变——新客户端键来自 `room.`，与 `friendRoomEnabled` 同路径裁剪）。

### 3.6 观测面

见 D11（指标分两侧、规则 3 条、面板 1 块；`slice-16` 三处计数 + 面板名单同核）。

### 3.7 规格阶段待展开的机械定位（调研已备，勿重查）

配置测试族：`protocol/src/config.test.ts:9-19`、`config-service/test/platform-config.service.test.ts:156-178,219-240`、`test/helpers/config-probe.ts:95-116`、`test/admin.controller.test.ts:172-199`、`test/config.rpc.test.ts:44-72`、`test/client-config.test.ts:19-31,65-86`、`test/migration.test.ts:41-58,141-211`、`user-service/test/config-cache.test.ts:174-195`、`tools/mock-server/test/rest.test.ts:37-64`。conformance：`slice-14-config-center.ts:490-497`、`slice-17-currency.ts:1221-1233,1136-1151`、`slice-16-monitoring.ts:82-118,586-594,648-658,662-668,717-721,1173-1181`、`slice-15-records.ts:381,411`。协议文档闸：`apps/client/test/protocol-doc-sync.test.ts:86-98,155`。

---

## §4 关键时序

### 4.1 金币场匹配（含门槛与 ensure）

```
client --room.match{mode:'gold', baseScore}--> gateway
  ├ goldRoomEnabled? 否 ⇒ 12010
  ├ 孤儿/重复探测（:309-324，三值化后覆盖其余两模式）
  ├ currency.get([userId]) —— 失败 ⇒ 10007（不允许盲入）
  │    balance ≥ baseScore × entryMultiplier? 否 ⇒ 14003
  └ addToQueue（既有校验在内）→ 撮合 → fillBots（既有）
       └ [gold] ensure: currency.get(botIds) → 缺失或 < 补线 ⇒ apply(rr)
            └ 失败 ⇒ 按补位失败路径（fillBots=null ⇒ 不开局 ⇒ 匹配侧 cancel+重试计数）
            成功 → startRoom（game.start）→ room.matched / room.state_update（含 balance）
```

### 4.2 局终结算（gold only）

```
game.ended（广播已同步发出）
└ finalizeRoomEnd（fire-and-forget）
   ├ readBotSeatMap → releaseRobots（既有）
   ├ void settleMoney(...)   ← :809，早于 !record||!version 早返
   │   ├ 守卫：mode==='gold' ∧ result ∧ 三座位齐（缺 ⇒ WARN+指标，终）
   │   ├ currency.get（3s）→ 截断+抽水+上限计算（D3）
   │   ├ allZero ⇒ 不调 apply → 广播 game.balances(get 余额) → 收尾
   │   ├ currency.apply(settle:<room>:<ver>)（3s）
   │   │    ├ ok/replayed ⇒ ok；replayed 的 balanceAfter=历史快照（D7 标注）
   │   │    ├ 14001 ⇒ 重读重算 → apply(:r2)（至多一轮）
   │   │    ├ 超时/传输/10007 ⇒ 原样同 id 重发（至多 2 次，短退避）
   │   │    ├ 10001/14002 ⇒ 终态不重试 + 响亮 ERROR + 指标 + runbook
   │   │    └ 仍未决 ⇒ settle:outbox（TTL 1h）+ 指标；sweeper 10s 原样重发；
   │   │        outbox 最老 >300s ⇒ 告警
   │   ├ [成功] 机器人触线 ⇒ 补给/回收（rr/rc，事件驱动，D6）
   │   ├ [成功] record.moneyDelta（3s；命中座位不足三 ⇒ 留 outbox 重试）
   │   └ [成功/全零] 广播 game.balances（D7 三态）
   ├ writeGameRecord（既有，零改动）
   └ outbox sweeper（10s）：settle 原样重发 / record.moneyDelta 补投；TTL 清理 + 告警
```

### 4.3 机器人循环（D6：全事件驱动）

```
入座前（金币场 fillBots）：ensure —— 缺失或 < 补线 ⇒ 补到目标（pool→bot）
结算后（settle 例程）：< 补线 ⇒ 补到目标；> 回收线 ⇒ 回收至目标（bot→pool）
水位派生：sha256(botId) → {补线, 目标, 回收线}（随 max底分×entryMultiplier 联动，非整百）
池告警：pool < 1,000,000（10m）⇒ CurrencyRobotPoolLow ⇒ runbook 拆笔充值
僵尸余额：身份回收后账户留存（不补、不删）——通缩口径，观测 currency_robot_accounts_balance_sum
```

### 4.4 救助（D10）

```
client POST /api/wallet/relief（X-User-Id）
  ├ reliefEnabled? 否 ⇒ 14004
  ├ balance < 15×entryMultiplier? 否 ⇒ 14004（文案不同）
  └ apply(relief:<userId>:<date>, relief_grant, +amount)
       ├ 首次 ⇒ {granted:true, balance}
       ├ replayed ⇒ {granted:false, replayed:true}
       └ 14002（同日改金额再领）⇒ 翻成 {granted:false}（「今天已领过」）
```

---

## §5 数值设计

### 5.1 门槛（默认 entryMultiplier=10）

| 档位 | 底分 | 门槛（≥） |
|---|---|---|
| 休闲场 | 15 | 150 |
| 标准场 | 80 | 800 |
| 竞技场 | 480 | 4,800 |
| 豪侠场 | 1,200 | 12,000 |

理由：倍率无上界（炸弹指数）⇒ 门槛**不承诺**覆盖最坏局，职责是「平时够输、少触截断」；极端局由截断兜底。倍率配置化 ⇒ 线上可调，不动代码。

### 5.2 机器人水位（J10：非整百、每机器人不同）

`top = max底分 × entryMultiplier`（默认 12,000）、`sha256(botId)` 派生三档（公式见 D6，含 `%100===0 ⇒ +1` 非整百修正）。示例特征：补线 ≈12.3k–12.9k、目标 ≈13.8k–16.3k、回收线 ≈38.6k–52.1k，**全部非整百**（`bot-…` 各异）。附录 §3.7 的 10000/1000/5000/50000 是被替换的锚点（本仓四档位的量级与附录示例经济不同，J3 授权复核）。调 `entryMultiplier`/档位表 ⇒ 水位随 `top` 联动。

### 5.3 池与告警

池种子 **5,000,000（拆 5 笔注入**，单笔上限 1e6）；告警水位 1,000,000（10m）。回收线以上盈余回池 ⇒ 池是「机器人净输给人类的缓冲」。

### 5.4 默认值

`rakePercent=0`（零和起点；>0 按 D3 销毁）· `reliefAmount=200`（默认于最低档门槛 150 之上；**与门槛是两条独立可调值**——若上调 `entryMultiplier` 使 15×N>200，CONFIG_NOTES 提示同步调救助额）· 开关默认见 §3.5（金币场默认关 = 暗上线）。

---

## §6 判据清单（设计级；规格阶段编号化）

- **C1** `room.freeRoomEnabled=false` ⇒ random 匹配被 12010 拒；true 恢复。
- **C2** `room.goldRoomEnabled` 种子=false；false 时 gold 匹配被 12010 拒。
- **C3** `/api/config` 恰 6 键、含三新布尔；响应零泄漏内部键（含 `currency.*` 全部新键）。
- **C4** 金币门槛：余额 < baseScore×N ⇒ 14003 且**未入队**；补足后入队成功；免费场不受此检。
- **C5** 一局金币场（rake=0、无截断）：三人金额变动 = 分差；entries 和 = 0；人类/机器人账目 owner_type 正确。
- **C6** 机器人首入局：ensure 已入金、余额 ∈ 目标区间且**非整百**。
- **C7** `money_delta`：三人列 = 三人语义向量（含 0）；`record.moneyDelta` 重复投递幂等（回执=命中座位集合，同值重写不误判）。
- **C8** rake>0：赢家实收 = `g − floor(g×p/100)`（逐字 D3 操作序）；entries 和 = −Σ抽水；无截断时残差=0；对账干净。
- **C9** 截断（单测/假层）：输家 −余额；赢家按比例 floor；残差销毁并计指标；**不产生 14001、不欠账**。
- **C10** settle 重试分级：超时/10007 ⇒ 同 id 原样重发 ⇒ replayed 恰一次记账；14001 ⇒ `:r2` 重算轮正确；10001/14002 ⇒ 终态不重试 + 告警（构造用例）。
- **C11** outbox：settle 失败入箱、sweeper 重发成功、`money_delta` 补写收敛；最老 >300s 告警规则存在。
- **C12** refill/recall：越线动作正确；同观测重复触发 replayed 不双补；回收后池余额上升；**无定时 job**（不存在给死账户补钱的路径）。
- **C13** 池告警：`CurrencyRobotPoolLow` 规则存在且表达式正确（slice-16/18 断存在性+名字集）。
- **C14** 救助：开+余额低 ⇒ +amount；同日再领 replayed 不双发；**同日改金额再领 ⇒ 已领过语义**；余额≥门槛 ⇒ 14004；关 ⇒ 14004。
- **C15** 断线玩家局终照常结算（座位口径，无连接依赖）。
- **C16** 客户端：场次切换（双开关联动）、余额、门槛提示、金币场占位转真值/免费场保持「—」、结算金币列三态（含 5s 超时定格「—」）、战绩金币列与 mode 文案。
- **C17** 机械面同步（规格展开逐条）：17 键/6 客户端键/16 规则/5 面板/10 S→C 消息/错误码三表/两模式联合/protocol-doc-sync 表——**并含一条「仓库文件扫描」断言**（照 client source-boundary 扫描形态，防「十一键/九条」类字面量残留）。
- **C18** ⚙️14：锁定读形态回归 + 真库双会话负向用例证据（D13 规程全文在规格）。
- **C19** 对账：金币场连跑后三检查（账实/缓存/孤儿）干净；`currency_settle_residue_total`、池余额、补给速率出数。
- **C20** record 写链零回归：free/practice 路径逐字节兼容（既有测试全绿）、非金币局无任何新 RPC 调用。
- **C21**（r1 🔴）**取消金币排队正确性**：入队 gold ⇒ unmatch ⇒ 金币队列键无该成员、meta 已清、窗口内不会被撮合；`readMeta` 三值保真；跨模式重复入队检测在 gold 维生效（12009）。
- **C22** ensure 失败 ⇒ 金币房不开局（按补位失败路径），无 0 余额机器人上桌。
- **C23** 上限 source 化：`game_settle`/`robot_pool` 合法大额（>1e6 且 ≤1e12）可结；其余 source 仍 1e6 拒；>1e12 拒（哨兵终态）。

---

## §7 风险与未决

1. **⚙️14 准入阻碍项（硬）**：D13 未过不进机器人资金施工。规格落规程全文（含判别力负对照）。
2. **广告片依赖（J11）**：救助开关默认关；**开启救助前必须有广告小片**（否则占位流程是真发放）。上线顺序约束写进交接文档。
3. **截断/上限的可见性**：输光截断对玩家表现为「-余额（小于应输）」——结算页按实际变动展示；被截断的赢家实收摊薄。**是否给在场玩家一条 system.warning**：倾向否（靠结算列自明），评审/用户可翻案。
4. **多实例（P5 债务）**：① outbox sweeper / 补给双触发多为进程内 —— actionId 含观测值 ⇒ 天然幂等；② **fanout 双结算**（两实例各算各载荷 ⇒ 一胜一 14002）⇒ 终态告警路径（D4）+ P5 登记双结算收敛；③ 毫秒窗内不同观测双补可能略超目标（不触回收线、不自纠）——待证，P5 前置清单登记。
5. **机器人余额窗口**：结算打穿 → ensure/结算后补给之间，理论上可被拉进高一档场次。接受 + 指标可见。
6. **record.moneyDelta 行序竞态**：0 命中重试上限靠 outbox TTL 兜底；record 链长期失败 ⇒ 金币列留 NULL——可见、不静默。
7. **池长期失衡**：两方向都有指标（池余额 + 补给/回收速率），runbook 含「池低于水位 ⇒ 管理面拆笔注入」。僵尸余额是通缩（观测项，不清理）。
8. **`relief:<date>` 时区**：Asia/Shanghai 固定口径（服务端计算）；中国无夏令时，无 DST 边界。

---

## 修订记录

- **v1.0**（2026-10-04）：首稿。来源 = 用户裁决 J7–J11 + 三路接缝调研 + 路线图 P2′/附录 §6。
- **v1.1**（2026-10-04）：r1 评审 1🔴+11🟡+3🟢 全数处置。映射：🔴1→D1（readMeta 二值归一/otherMode 探针/取消排队缺陷，新增 C21）· 🟡2→D4 失败分级表（10001/14002/10007 补全）· 🟡3→D3 上限 source 化（拆笔种子/上限 1e9/新增 C23）· 🟡4→D5（三人含 0 向量、命中座位集合、C7 重写）· 🟡5→D4/D8 锚点修正（:809/:290-331 精确化+守卫）· 🟡6→D6 ensure 语义（缺失或低于补线）+失败路径（C22）· 🟡7→D6 删定时 job（全事件驱动，消死账户补钱）· 🟡8→D6 算式移至 room-service（currency-service 仅救助三键接配置，D12 补）· 🟡9→D12 清单补全（protocol-doc-sync/messages.test/slice-15/客户端分发表/散点）· 🟡10→C8 逐字对齐 D3 · 🟡11→§0 J10 口径（非整百）+三档水位说明 · 🟡12→D7 三态收敛 · 🟢13→D10（范围 1..、14002 翻已领过）· 🟢14→§7.4/§7.7/D13 规程/§4.2 告警口径 · 🟢15→C17 仓库扫描断言。
- **v1.2**（2026-10-04）：差异复核（12/15 真闭合，3 条订正 + 6 条 🟢 补强）全数处置。映射：🟡A→D3/C23 上限依据链订正（BID 上限=8、单条上界=maxBaseScore×2^18≈3.15e8、哨兵取 1e12）· 🟡B→D5 SQL 经 `record_id` JOIN（该表无 room_code 列）· 🟡C→D6 非整百修正（%100===0 ⇒ +1）· 🟢D→D4 守卫来源（房间元数据 findOne）· 🟢E→D1 客户端行拆分（REST 面保持二值）· 🟢F→D6 ensure 后未上桌口径 · 🟢G→D11 residue 措辞 · 🟢H/I→D12 补 room-service getter 测试与引用修正。
- **v1.3**（2026-10-04）：**2026-10-04 用户裁决：金币场默认开（原默认关），免费场开关维持默认开** —— 种子迁移/服务端 getter 缺省/管理面缺行兜底/客户端缺键语义与 fail-safe/测试族/slice-18 收尾态全链同步翻转为「默认开」（救助开关维持默认关不动）。
