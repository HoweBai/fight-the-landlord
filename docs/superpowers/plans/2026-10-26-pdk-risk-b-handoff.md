# B 组交接（跑得快风控 / 金币门槛 / 2–4 人）

> 2026-10-26 续接会话 · 分支 `feature/pdk-risk-b` · worktree `D:\Code\ftl-pdk-risk-b`
> 最新代码提交：`085a6ba5`（临时触发还原 + 全绿证据）；之后仅文档回填，最终 HEAD 以
> `git log -1` 为准。
> 基线：`origin/dev@ccc4efd6`（已含代理分润 39 提交、A1/A2/A3、2/4 人并行工作）
> 合并：`930936a3`（origin/dev 并入 B 组）
> 设计/计划：`docs/superpowers/specs/2026-10-26-pdk-risk-b-design.md`、
> `docs/superpowers/plans/2026-10-26-pdk-risk-b.md`

## 已完成（不要重做）

- T1–T16 全部完成：protocol 100→**101** 键（含代理 +1）、config 迁移/SEED、
  user-service 按人数扫描 + 机器人整局剔除 + `risk_reviews.game_type` + PDK 独立自动限流 +
  单玩法 SQL 失败隔离/冻结续旗 + 新指标/告警、gateway/admin 玩法筛选与分人数详情、
  room-service 2–4 人门槛/谓词/截断/机器人资金单测、conformance B 片与 D31 夹具、文档销账。
- 独立代码审查：**0 Critical / 0 Important / 6 Minor**（1–4 已修，5–6 登记）。
- 合并后本地全量：`turbo test+lint --force` **44/44（0 cached）**；
  `verify-admin-static` **520**、`verify-monitoring` **226**、`verify-agent-static` **104**、
  conformance tsc/lint、`check-baselines --self-test` 全绿。

## 合并撞号处置（2026-10-26）

| 冲突 | 处置 |
|---|---|
| dev 已占 `slice-32-agent` | B 片顺延 **`slice-33-pdk-risk-gold`**（`run.ts`/`baselines.json`/`check-baselines.mjs` 同步） |
| dev `1796900000000-AgentInviteKey` 占号 | B config 迁移改号 **`1797000000006-PdkRiskPlayerCountSeed`**（类名/测试/夹具注释同步） |
| 配置计数 94/78 vs B 100/84 | 并集 **101/85**；admin 简单控件 80（36 布尔 + 42 数字 + 2 文本）、CONFIG_NOTES 85 |

> spec/plan 的历史文本仍写 slice-32 / 1796900000000；以代码与基线键为准，合并后记已写入
> spec 顶部与 plan「续接轮」。

## 迁移

- `packages/config-service/src/migrations/1797000000006-PdkRiskPlayerCountSeed.ts`
  （原 1796900000000；7 键、version=全表 MAX、INSERT IGNORE、down 只删 7 键）。
- `packages/user-service/src/migrations/1797000000005-RiskReviewGameType.ts`
  （`game_type` + 默认 ddz + `idx_game_status_id`；down 先删索引再删列）。
- 真 MySQL up/down：临时 workflow `risk-b-migrations-temp`（MySQL 8 service）run
  `40260576734` **成功** —— config `1797000000006` 与 user `1797000000005` 均
  up/down/up/down 通过（日志逐字见 plan「续接轮」）。临时 workflow 与
  `scripts/temp/verify-risk-b-migrations.mjs` 已删除（`59dc9490`）。

## GitHub 真栈（用户裁决：不用本地 Docker Desktop）

- 临时触发提交 `203ccc97`（conformance.yml push.branches 加 feature 分支 + slice-07.4 期望同步）。
- 首轮 run `40259979512`：起栈阶段发现 slice-33 管理写桶可预见红（`ADMIN_WRITE` 30/5min
  按令牌指纹；20 次配置写 + 14 次钱包调整写），主动取消；修复 `b23f7a95`
  （写段重登换令牌 + 起手 61s 清 IP 桶；断言仍 60）。
- 次轮 run `40260432256`（47m58s）：**唯一红点 = dev 的 `slice-32-agent`** 硬编码
  94 键（合并后 101）；其余 37 片全绿。B 相关实测：slice-16 **91**、18 **151**、
  20 **181**、24 **225**、29 **117**、31 **59**、33 **60/60（129.5s）**。
  修复 `69d9c74b`（代理片改用 `CONFIG_KEYS.length` / `CLIENT_CONFIG_KEYS.length`；
  slice-16 基线 87→91）。重跑 run `40264759914`：**成功**（51m5s，38/38 切片
  exit 0，`baseline 全部 ≥ 下限`；B 相关实测 slice-16 91 / 18 151 / 20 181 /
  24 225 / 29 117 / 31 59 / 32-agent 137 / 33 60）。临时触发已还原，最终
  4 个工作流。
- `03dccc10` 曾还原 conformance 触发并加入临时迁移 workflow；`59dc9490` 已删除
  临时 workflow/脚本。
- **最终清理已完成**：最终 4 个工作流；`node tools/conformance/dist/run.js
  slice-07.4-pipeline --render` 80 项、静态闸全绿。

## 剩余动作

1. 推送/合并前**先问用户**。建议顺序：B 合 `dev`（已含代理分润）→ 按需合 `master` 跑权威轮。
2. **不要部署**、不要打 `v*` tag；`game.paodekuai.twoPlayerEnabled` /
   `nonThreePlayerEnabled` 保持种子值（生产 2/4 开关不打开）。
3. 交付报告给用户（分支/SHA、迁移与回滚、行为、验证证据、合并顺序）。

## 已知限制

- 旧 `risk_reviews` 行 `game_type` 默认 ddz（U5 显式选择），旧行筛选可能漏，冻结保护用 reasons 兜底。
- A3 玩家列表是行级 `is_robot=0`，风控详情是整局剔除机器人局（D34 口径）。
- 机器人低档房按全局最高档水位充值（D29，仍开放）。
- `throttled(auto)` 长期无对局且对侧 SQL 持续失败 >7d 时旗可能自然过期（观察项）。
- `autoThrottleScore` 26–49 与 50 同效（PDK 线只认 25）。
