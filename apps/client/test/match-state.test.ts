/**
 * R49：匹配中状态归 store，并由「成局」与「12007 超时」两条路径复位。
 *
 * 这条断言钉住的是**没发生的事**：12007 到达后按钮不能再停在「正在匹配…」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';

describe('匹配中状态（R49）', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('12007（匹配超时）到达 → matching 复位', () => {
    const store = useGameStore();
    store.setMatching(true);

    store.applyEvent({
      type: 'system.error',
      version: 0,
      payload: { code: 12007, message: 'Match timed out' },
    });

    expect(store.matching).toBe(false);
  });

  it('其它 system.error 不复位 matching（只有 12007 是匹配的终止信号）', () => {
    const store = useGameStore();
    store.setMatching(true);

    store.applyEvent({
      type: 'system.error',
      version: 0,
      payload: { code: 10007, message: 'upstream down' },
    });

    expect(store.matching).toBe(true);
  });

  it('reset() 也清 matching（回大厅不留下永久「匹配中」）', () => {
    const store = useGameStore();
    store.setMatching(true);
    store.reset();
    expect(store.matching).toBe(false);
  });
});

/**
 * 机器人补位开关片：`match.wait_prompt` 的弹窗态（非终止；从属于 matching）。
 */
describe('缺人等待提示（match.wait_prompt）', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('匹配中收到提示 ⇒ 文案入库供页面弹窗', () => {
    const store = useGameStore();
    store.setMatching(true);

    store.showMatchWaitPrompt('正在为你安排牌桌，请稍等片刻。');

    expect(store.matchWaitPrompt).toBe('正在为你安排牌桌，请稍等片刻。');
  });

  it('🔴 未在匹配中收到提示 ⇒ 不弹窗（迟到推送不得在匹配已结束后凭空弹框）', () => {
    const store = useGameStore();
    expect(store.matching).toBe(false);

    store.showMatchWaitPrompt('迟到的提示');

    expect(store.matchWaitPrompt).toBe(null);
  });

  it('clearMatchWaitPrompt 关弹窗（玩家点了重新匹配/延长）', () => {
    const store = useGameStore();
    store.setMatching(true);
    store.showMatchWaitPrompt('提示文案');

    store.clearMatchWaitPrompt();

    expect(store.matchWaitPrompt).toBe(null);
    expect(store.matching).toBe(true); // 关弹窗不终止匹配（延长语义：票还在队列）
  });

  it('setMatching 的两个方向都清提示（重新入队 / 成局·取消经由 setter 的收口）', () => {
    const store = useGameStore();
    store.setMatching(true);
    store.showMatchWaitPrompt('提示文案');

    store.setMatching(true); // 重新入队（幂等/换队路径）⇒ 旧弹窗不得带进新一轮
    expect(store.matchWaitPrompt).toBe(null);

    store.showMatchWaitPrompt('提示文案 2');
    store.setMatching(false); // 成局/取消
    expect(store.matchWaitPrompt).toBe(null);
  });

  it('12007 超时推送 ⇒ matching 与提示同时清（终止信号一并关掉未应答弹窗）', () => {
    const store = useGameStore();
    store.setMatching(true);
    store.showMatchWaitPrompt('提示文案');

    store.applyEvent({
      type: 'system.error',
      version: 0,
      payload: { code: 12007, message: 'Match timed out' },
    });

    expect(store.matching).toBe(false);
    expect(store.matchWaitPrompt).toBe(null);
  });

  it('reset() 清提示（换局/销毁会话边界不得带过上一轮弹窗）', () => {
    const store = useGameStore();
    store.setMatching(true);
    store.showMatchWaitPrompt('提示文案');

    store.reset();

    expect(store.matchWaitPrompt).toBe(null);
  });
});

/**
 * 匹配计时起点跨页保留（2026-10-18 实机走查）。
 *
 * 事实：`matching` 归 store ⇒ 匹配中点「返回大厅」（纯导航，不撤票）后再回开始游戏页，
 * `matching` 仍是 true。此前秒表起点是**页面局部**变量：页面重挂载后 `watch(matching)`
 * 不触发（值没有沿变）⇒ 秒表停在初始值 0s（实机形态：「正在匹配…0s」）。
 * 修法：起点存 store（`matchingStartedAt`），跨页重挂载仍按真实等待时长续算。
 */
describe('匹配计时起点（matchingStartedAt）', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('setMatching(true) 写入起点；重复置 true（页面重挂载 / 换底分再匹配）不重置', () => {
    vi.useFakeTimers();
    try {
      const store = useGameStore();
      vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
      store.setMatching(true);
      const started = store.matchingStartedAt;
      expect(started, 'true 沿变必须写入起点').not.toBeNull();

      vi.setSystemTime(new Date('2026-10-18T00:00:05Z'));
      store.setMatching(true); // 已匹配中再次置 true（重挂载 / 换底分再匹配）
      expect(store.matchingStartedAt, '已在匹配中 ⇒ 起点不得被重置').toBe(started);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setMatching(false) / 12007 / reset() 都清起点', () => {
    const store = useGameStore();
    store.setMatching(true);
    expect(store.matchingStartedAt).not.toBeNull();
    store.setMatching(false);
    expect(store.matchingStartedAt).toBeNull();

    store.setMatching(true);
    store.applyEvent({
      type: 'system.error',
      version: 0,
      payload: { code: 12007, message: 'Match timed out' },
    });
    expect(store.matchingStartedAt).toBeNull();

    store.setMatching(true);
    store.reset();
    expect(store.matchingStartedAt).toBeNull();
  });
});
