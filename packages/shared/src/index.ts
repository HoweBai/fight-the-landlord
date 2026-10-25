export * from './card/card';
export * from './rule/rule';
export * from './rule/autoplay';
export * from './ddz/types';
export * from './ddz/game';
export * from './core/session';
export * from './core/action';
// 挂机治理（规格 C1/C3/C4/C4′/C7b/C10）：纯函数 —— game-service 消费（必须走 barrel，
// 本包无 `exports` 映射 ⇒ 不能深路径导入，同 rpc-meta 先例）。S1 起实现在 core。
export * from './core/governance';
// R205/C8：`actionLog` 的**唯一**公开投影（RobotFeatures）
export * from './ddz/features';
export * from './ddz/bid';
export * from './ddz/play';
// 协议 ④：`recentActions` 的**唯一**投影实现（窗口 2、旧 → 新、「不出」是 `cards: null`）。
export * from './ddz/recent';
export * from './ddz/settle';
export * from './core/timer';
// S7（R142）：§5.5 的脱敏规则**唯一实现** + Nest 落地形态（各服务 `main.ts` 消费）。
export * from './logging/redact';
export * from './logging/redacting-logger';
export * from './logging/trace-context';
// R1104/R1105（Task 11）：`metaFromTrace()` 供**三个** client（room 的 game/robot + game 的
// robot）共用。⚠️ 必须走 barrel：那三处在**别的包**，而本包没有 `exports` 映射 ⇒ 不能深路径导入。
export * from './logging/rpc-meta';
export * from './logging/log-record';
export * from './logging/trace-middleware';
// Task 4 的跨任务缺口：Task 5/7 的服务级测试要用 `createCapturingSink`，而本包没有
// `exports` 映射、构建产物只有 `dist/index.js` ⇒ **不能深路径导入**，只能从这里导出。
export * from './logging/capturing-sink';
// 监控片（T1）：metrics 地基 —— 单例注册表 + 强制同源构造器 + HTTP 计数中间件 +
// 独立指标监听（Bearer 守卫）。八服务 `main.ts` 各两行接线，**必须**走 barrel
// （本包无 `exports` 映射 ⇒ 不能深路径导入——同 rpc-meta 先例）。
export * from './metrics/registry';
export * from './metrics/http-metrics';
export * from './metrics/metrics-listener';
export * from './metrics/game-label';

// 玩家管理页（2026-10-22）：在线 presence 键/窗口 + 玩家汇总快照键的跨服务单一真源。
export * from './presence/online';

// 跑得快（2026-10-23）：规则配置默认值/校验（类型在 protocol/src/pdk/rules.ts）。
export * from './pdk/rules';
// 跑得快 S3.1：会话类型 / 48 张牌堆 / 2-3-4 人发牌与首出。
export * from './pdk/types';
export * from './pdk/deck';
export * from './pdk/deal';
// 跑得快 S3.3：回合流转/过牌/胜负。
export * from './pdk/play';
// 跑得快 S3.4：结算（倍数/关牌/春天/封顶/保本/零和）。
export * from './pdk/settle';
// 跑得快 S3.5：autoplay（超时/托管/bot 共用）与机器人公开特征。
export * from './pdk/autoplay';
export * from './pdk/features';
