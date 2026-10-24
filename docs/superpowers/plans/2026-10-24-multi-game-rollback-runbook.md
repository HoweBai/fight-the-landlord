# 多玩法平台化 + 跑得快 · 回滚手册（2026-10-24）

> 依据：`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md` §4.11。
> **先读边界，再动手**：不同切片的可回滚性不同；「无脑回滚」只对 S0/S1 成立。

## 0. 判定树

| 想回滚到 | 可行吗 | 前置/动作 |
|---|---|---|
| S0 / S1（协议/内核字段） | **可以**，独立回滚 | 直接回滚镜像；斗地主路径不变（golden 已冻结） |
| S2（队列/房间/机器人横切） | **不能直接回滚** | ① 停新匹配；② 排空在局房间；③ 把 `bot:pool:doudizhu` 的空闲机器人**迁回** `bot:pool:ddz`；④ 再回滚 room/robot 镜像 |
| pdk 开关已打开且产生数据 | **不能无脑回滚** | 按下文 §2 的 pdk runbook |

## 1. 通用准备

1. 关闭入口：`PUT /api/admin/config/game.paodekuai.enabled` = `false`（新匹配/建房被 `12012` 拒；
   已在局与等待中房间允许跑完 —— D13）。
2. 观察排空：`GET /api/rooms?gameType=paodekuai` 直到无 `waiting/playing` 房（或等 `ROOM_TTL` 回收）。
3. 记录证据：保留 `game-records-pdk` 两表（旧服务不读，无需删）；备份 Redis 相关键。

## 2. pdk 回滚 runbook

1. 关开关（§1）。
2. 清队列/机器人池**空闲**部分：
   - `SCAN 0 MATCH match:queue:*:paodekuai:*` → `DEL`（确认无在局票后）；
   - `ZRANGE bot:pool:paodekuai 0 -1` 逐个确认未绑定后 `DEL bot:pool:paodekuai`。
3. **保留** `game_records_pdk` / `game_record_players_pdk`（旧 user-service 只查斗地主两表）。
4. **先执行 §5 配置回填**（旧镜像只读旧平台键），再回滚镜像：game-service、room-service、robot-service、user-service、config-service、api-gateway、client。
5. 验证：
   - 旧 user-service 对 pdk 表**不读不写**（历史页不报错）；
   - 旧 room-service 不认识 pdk 新键 ⇒ 确认 `match:queue:*:paodekuai:*` 已清空；
   - 斗地主队列键仍为旧 3 段（`match:queue:{mode}:{baseScore}:{region}`）；
   - 新池 `bot:pool:doudizhu` 的机器人已迁回 `bot:pool:ddz`（旧 robot-service 只扫旧池）。

## 3. S2 回滚（不涉及 pdk 数据时）

1. 停新匹配；排空在局房间。
2. 机器人池迁移：`ZRANGE bot:pool:doudizhu 0 -1` → 对每个**未绑定**机器人 `ZADD bot:pool:ddz` →
   `DEL bot:pool:doudizhu`。绑定中的机器人等局终 release 后再迁。
3. 回滚 room-service / robot-service 镜像。
4. 验证：旧 room-service 的队列键/名单正常；旧 robot-service 池非空；斗地主可开一局。

## 4. 已知不可回滚残留（必须如实告知）

- pdk 记录两表（保留审计；旧服务不读）。
- pdk 历史数据在**旧客户端**不可见（旧 `/api/records/mine` 只查斗地主表）。
- 旧 game-service 若遇到在局 pdk 会话会 fail closed（会话里 `gameType=paodekuai`），
  因此必须先排空（本手册 §1/§2 的硬前置）。

## 5. 配置平行化回填（2026-10-24）

> 适用：已部署 `1796500000000-SplitGameConfig` 后要回滚到**旧镜像**（旧镜像只读旧平台键）。
> 新镜像正常运行期间，旧键被冻结；回滚前必须把斗地主新键的当前值回填到旧键。
> **斗地主是权威源**：跑得快专有值（跑得快场次/好友房/补位/抽水/门槛）在回滚后**丢弃**，
> 因为旧镜像只有一套共享键，无法同时保留两个玩法 —— 回滚前向运营公告。

### 5.1 回填 SQL（逐键执行；`updated_by='rollback-backfill'`）

```sql
-- 场次/好友房/补位
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.freeRoomEnabled'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='room.freeRoomEnabled';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.goldRoomEnabled'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='room.goldRoomEnabled';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.friendRoomEnabled'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='room.friendRoomEnabled';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.freeBotFillEnabled'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='room.freeBotFillEnabled';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.goldBotFillEnabled'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='room.goldBotFillEnabled';

-- 金币经济
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.rakePercent'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='currency.rakePercent';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.entryMultiplier'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='currency.entryMultiplier';

-- 档位
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.levels.doudizhu'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='game.baseScoreLevels';

-- 记牌器
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.cardCounterEnabled'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='game.cardCounterEnabled';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.cardCounterPricePerGameCoins'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='game.cardCounterPricePerGameCoins';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.cardCounterPricePerHourCoins'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='game.cardCounterPricePerHourCoins';

-- 机器人 AI
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.robot.skillDistribution'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='robot.skillDistribution';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.robot.ruleFallback'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='robot.ruleFallback';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.robot.modelBySkill'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='robot.modelBySkill';

-- 风控胜率
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.risk.winRateThreshold'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='risk.winRateThreshold';
UPDATE platform_config dst JOIN platform_config src ON src.`key`='game.doudizhu.risk.minGames'
 SET dst.value=src.value, dst.version=dst.version+1, dst.updated_at=NOW(3), dst.updated_by='rollback-backfill'
 WHERE dst.`key`='risk.minGames';
```

### 5.2 回填后核对

```sql
SELECT `key`, `value`, `version`, `updated_by` FROM platform_config
 WHERE `key` IN ('room.freeRoomEnabled','room.goldRoomEnabled','room.friendRoomEnabled',
   'room.freeBotFillEnabled','room.goldBotFillEnabled','currency.rakePercent',
   'currency.entryMultiplier','game.baseScoreLevels','game.cardCounterEnabled',
   'game.cardCounterPricePerGameCoins','game.cardCounterPricePerHourCoins',
   'robot.skillDistribution','robot.ruleFallback','robot.modelBySkill',
   'risk.winRateThreshold','risk.minGames')
 ORDER BY `key`;
```

- 16 行全部 `updated_by='rollback-backfill'`；
- `game.baseScoreLevels` 与 `game.levels.doudizhu` 的值逐字相同；
- 跑得快专有值不在旧键里（旧镜像不认）。

### 5.3 升级顺序（正向上线时）

1. 先部署含本迁移的 config-service（迁移自动跑）；
2. 再部署全部消费者（room/currency/user/robot/client/admin）；
3. **全部消费者升级完成前，不修改任何新键**（尤其记牌器价格/抽水/门槛）——
   否则旧消费者读冻结旧键、新消费者读新键，会出现价格/扣费错位。

### 5.4 跑得快风控两键（2026-10-25）

`game.paodekuai.risk.winRateThreshold` / `game.paodekuai.risk.minGames` 是**新增专有键**，
没有旧平台键对应：回滚到旧镜像时**保留即可，无需回填**（旧镜像不读它们，留着无害）。
回滚后跑得快不再参与胜率扫描；重新升级到含本片的镜像后自动恢复。
