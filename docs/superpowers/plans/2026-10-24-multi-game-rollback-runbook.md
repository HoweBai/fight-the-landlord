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
4. 回滚镜像：game-service、room-service、robot-service、user-service、config-service、api-gateway、client。
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
