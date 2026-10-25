# 台费（入场费）对账手册

> 适用范围：金币场台费（source = `entry_fee`，actionId = `entryfee:<房号>:<玩家ID>`，`ref_id` = 房号）。
> 不变式（规格 §2.8）：`game_records(mode='gold')` 的**每个真人座位** ⇔ 该 `(room_code, owner_id)`
> 的 `entry_fee` **op**（或一条 `currency_entry_fee_skips` 免单行）——二者必居其一。
> 管理端 ops 过滤维度 = `source/gameType/actor/ownerId/from/to/cursor/limit`（**没有** actionId/refId 过滤）
> ⇒ 按本手册的 SQL 口径核对（照结算先例）。`gameType` 用于区分斗地主 / 跑得快。全部命令在部署机上执行：

```bash
docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -e "<SQL>"'
```

## 一、「有局无费」——有金币局记录、但该真人既没有台费 op 也没有免单行

覆盖形态：① `game.start` 成功与逐人收费之间**进程崩**（设计 §6-1/§6-11，含「逐人之间崩 ⇒ 部分收取」）；
② 旧版本窗口开的局（当时还没有收费块）；③ 未来若代码回归导致收费块整体未执行。

```sql
SELECT x.room_code, x.user_id, x.ended_at
FROM (
  SELECT r.room_code, p.user_id, r.ended_at
  FROM game_record_players p JOIN game_records r ON r.id = p.record_id
  WHERE r.mode = 'gold' AND p.is_robot = 0 AND p.user_id IS NOT NULL
  UNION ALL
  SELECT r.room_code, p.user_id, FROM_UNIXTIME(r.ended_at / 1000) AS ended_at
  FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
  WHERE r.mode = 'gold' AND p.is_robot = 0 AND p.user_id IS NOT NULL
) x
LEFT JOIN currency_ops o
  ON o.action_id = CONCAT('entryfee:', x.room_code, ':', x.user_id)
LEFT JOIN currency_entry_fee_skips s
  ON s.room_code = x.room_code AND s.owner_id = x.user_id
WHERE o.id IS NULL AND s.id IS NULL
ORDER BY x.ended_at DESC;
```

- 期望：**空集**。非空 ⇒ 平台白送台费（对玩家无害）；逐行看 `ended_at` 与上线时间对照分类（① 崩溃窗口 / ② 旧版本窗口 / ③ 疑似缺陷 ⇒ 上报）。

## 二、「有费无局」——收了台费、但记录面找不到对应的真人座位

覆盖形态：① 对局记录已过保留期被清（`record.retentionDays`）；② 记录写入失败/缺失；
③ 异常重复扣款（应当不存在——同锚重放由 `uk_action_id` 兜底）。

```sql
SELECT o.ref_id AS room_code, f.owner_id, o.action_id, f.delta, o.created_at
FROM currency_ops o
JOIN currency_flows f ON f.op_id = o.id
LEFT JOIN (
  SELECT r.room_code, p.user_id
  FROM game_record_players p JOIN game_records r ON r.id = p.record_id
  WHERE r.mode = 'gold'
  UNION ALL
  SELECT r.room_code, p.user_id
  FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
  WHERE r.mode = 'gold'
) rec ON rec.room_code = o.ref_id AND rec.user_id = f.owner_id
WHERE o.source = 'entry_fee' AND rec.user_id IS NULL
ORDER BY o.created_at DESC;
```

- 期望：**空集**（或全部落在保留期之外）。非空且窗内 ⇒ 逐条按 `action_id` 查 `currency_ops`/`currency_flows` 与 room-service 日志（`entry_fee.skipped` / `entry fee conflict`）核对手工处置。

## 三、免单明细（分人分房）

```sql
SELECT room_code, owner_id, seat, game_type, base_score, fee_amount, reason, trace_id, created_at
FROM currency_entry_fee_skips
WHERE created_at >= NOW() - INTERVAL 7 DAY
ORDER BY created_at DESC;
```

（走 `idx_skips_room` / `idx_skips_created`；`game_type` = `doudizhu` / `paodekuai`，旧行为
`doudizhu` 默认；`reason` 三值 = `insufficient_funds` / `unknown_outcome` / `internal_error`。
14002 冲突**不在**本表（视为已收）——冲突读 `room-service` 日志的 `entry fee conflict` 行与指标 `entry_fee_conflict_total`。）

## 四、日常观测

- 面板：Grafana「资金面 / Currency」的「台费收/漏」面板（`entry_fee_skipped_total{reason}` / `entry_fee_conflict_total`）；
- 财务汇总页「台费漏收」行（按窗口 笔数/人数/金额）；
- 免单率异常升高（>1%）⇒ 按三值拆分：`insufficient_funds` 高 = 门槛与费率/排队期扣减的运营问题；`unknown_outcome` 高 = currency-service 可用性；`internal_error` 高 = 疑似缺陷，抓 traceId。
