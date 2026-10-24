# 切片 P23 实施计划：删除 N38 的前端死状态（R591）

**Goal:** 把 `apps/client` 里一簇**零消费者**的状态删干净，使台账**不再有任何「仍开放」的项**。

**背景**（`deviation-ledger.md` **N38**，P15 登记）：`src/stores/game.ts` 的
`roomPlayers`（**只被写、从不被读**）· getter `seatedOthers`（**零消费者**）· `RoomPlayerView` 接口（含 `cardCount`）
· `applyRoomState()` 里对它的写入与 reset 路径的清空。牌桌真正用的张数来源是 **`PlayerView.cardCounts`**
（`store.cardCounts` → `table/table.vue`）⇒ 这簇状态没有任何职责。

## 裁决

- **R591 删除（N23 同手法），不给它新职责**。依据：唯一能赋予的职责是「大厅显示对局中张数」，
  那要求 `RoomInfo` 带张数 ⇒ **动 `packages/protocol`**；而当前没有任何消费方，将来真要用重新加回来
  比长期背着一份无人读的状态便宜。代价若判错：将来需要塞回一处状态（成本很低）。
- **R592 不为它加「防复活」源码闸**。依据：形如「`src/**` 不得出现 `roomPlayers`」的**按名字**闸
  会**禁止将来合法的使用**，且背后没有不变量（对比 P7 的第二契约闸：那里的不变量是「契约只有一个真源」）。
  ⇒ 该不该有这簇状态由**判据**（用例）决定，不由名字闸决定。代价若判错：有人再引入同名死状态时无闸拦截
  （但那次引入必然无消费者，评审/契约测试仍会看见）。

## 交付与门禁（实测）

- [x] `RoomPlayerView` / `roomPlayers` / `seatedOthers` / `reset()` 清空 —— **四个符号全删**；
      `applyRoomState()` **保留**（删掉那行后仍有两条实职责：R61 的「只有服务端给了 `status` 才写 `roomStatus`」＋
      用 `payload.players` 校正 `mySeat`），三个调用点一行未动；载荷类型**去重**到 protocol 的 `RoomPlayer`（契约唯一真源）
- [x] 终态自证：`grep -rn "roomPlayers\|seatedOthers\|RoomPlayerView" apps/client/src apps/client/test` = **0 命中**
- [x] 测试同步：删掉的 5 条全是**寄生在有真实判据的用例里的纯死状态 `expect` 行**，**一个用例都没删**
      （机械证据：4 个受影响文件的 `it()` 数量前后全等 10/13/16/1；逐条对照见报告与 commit message）
- [x] 门禁（协调者独立复核）：client **281 passed + 2 skipped**（未减少）· `vue-tsc` 干净 · 三端 build **DONE** ·
      dev 探针 `gate` **16/16** · **发行产物级** `gate` **16/16** · `turbo run test lint --force` **29/29、0 cached** ·
      `pnpm run ci` 六阶段全绿
- [x] 台账：**N38 → 已关闭** ⇒ **98：97/1/0**（部分关闭的 1 条 = N39 的 App 半边）

## 回填区（执行期裁决，不要删）

（执行期发现与计划不符时在此追加并编号：本片协调者区间 **R591–R600**。）
