/**
 * `@fight-the-landlord/protocol`
 *
 * 前后端唯一契约源。**零依赖**，且不依赖 `@fight-the-landlord/shared`
 * —— 前端只允许依赖本包，以免把游戏规则带进前端（docs/design.md §12）。
 */

export * from './codec';
export * from './game';
export * from './pdk/rules';
export * from './pdk/types';
export * from './pdk/window';
// 跑得快 S3.2：牌型解析/比较（类型仍归属 pdk/types.ts，不在此重复导出）。
export * from './pdk/rule';
export * from './errors';
export * from './views';
export * from './settlement';
export * from './rule';
export * from './robot';
export * from './rpc';
export * from './messages';
export * from './validate';
export * from './config';
export * from './records';
export * from './currency';
export * from './admin';
export * from './csv';
export * from './payment';
export * from './pay-channel';
export * from './notify-channel';
export * from './ad-channel';
export * from './agent-auth';
