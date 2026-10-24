/**
 * 音效层（R698 + U4）。
 *
 * ⚠️ **判据射程（诚实版）**：jsdom 里没有声音。这里证明的是
 * 「该响的时候，用**正确的 src** 调了 `play()`；不该响的时候一次都没调」
 * ——**不是**「真的听见了」。声音本身由真机走查确认（**不得**造假判据）。
 *
 * ⚠️ 替身的 `play()` **故意返回一个被拒的 Promise**（见 `uni-stub.ts`）：
 * 真实浏览器无手势时就是这样，而未处理的拒绝在真机上就是探针的
 * `Runtime.exceptionThrown`（零容忍）。所以「忘了 catch」在本文件里当场暴露。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { bidPhase } from './helpers/bid-phase';
import { audioContexts, installUniStub } from './helpers/uni-stub';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import {
  playCue,
  playBgm,
  preheatCues,
  stopBgm,
  setMuted,
  isMuted,
  setVolume,
  getVolume,
  setMusicOn,
  isMusicOn,
  setSfxOn,
  isSfxOn,
  loadAudioPrefs,
  cueForBid,
  cueForPass,
  stopCues,
  __resetAudioForTest,
} from '../src/audio';
import { CUES } from '../src/audio/cues';

/** 当前每个上下文最后设过的 src。 */
const srcs = () => audioContexts.map((c) => c.src.at(-1));

beforeEach(() => {
  audioContexts.length = 0;
  stopBgm();
  setMuted(false);
  setVolume(1);
  setMusicOn(true);
  setSfxOn(true);
  __resetAudioForTest();
});

describe('cue 表（纯数据）', () => {
  it('每个值都指向本地 audio 目录（主包 /static/audio 或牌桌分包 /pages/table/static/audio）的 .mp3', () => {
    const entries = Object.entries(CUES);
    expect(entries).toHaveLength(64);
    // 项 6 分包后：牌桌音效在分包，大厅 BGM 留主包。
    const localMp3 = /^\/(?:static|pages\/table\/static)\/audio\/[A-Za-z0-9_]+\.mp3$/;
    for (const [name, src] of entries) {
      expect(src, `${name} 的 src`).toMatch(localMp3);
    }
  });

  it('Order 进表且有真实调用路径（U5：叫地主）', () => {
    // 旧断言曾经是「Order 不得进表」（当时规则只有抢/不抢）。协议⑦ 起
    // `BidDecision.kind` 区分叫/抢，`cueForBid('call', true, …)` 就是它的调用点。
    expect(CUES.Order).toBe('/pages/table/static/audio/Woman_Order.mp3');
  });

  it('项 6：只有大厅 BGM（Welcome）留主包，其余牌桌音效都在分包', () => {
    expect(CUES.BgmLobby).toBe('/static/audio/MusicEx_Welcome.mp3');
    for (const [name, src] of Object.entries(CUES)) {
      if (name === 'BgmLobby') {
        expect(src.startsWith('/static/audio/')).toBe(true);
      } else {
        expect(src.startsWith('/pages/table/static/audio/')).toBe(true);
      }
    }
  });
});

describe('播放', () => {
  it('playCue 用正确的 src 建上下文，onCanplay 后才 play', () => {
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(1);
    expect(srcs()).toEqual(['/pages/table/static/audio/Woman_NoOrder.mp3']);
    // 媒体就绪前绝不 play（U5-3：否则打断时 stop 会打出 AbortError）
    expect(audioContexts[0]!.play).toBe(0);
    audioContexts[0]!.canplayHandler?.();
    expect(audioContexts[0]!.play).toBe(1);
  });

  it('静音时一次都不 play（但也不抛）', () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(0);
  });

  it('播放失败被静默吞掉（替身的 play 总是拒绝 ⇒ 忘了 catch 会让本文件红）', async () => {
    playCue('NoOrder');
    audioContexts[0]!.canplayHandler?.();
    // 让微任务队列排空：若生产代码没 catch，这里会抛未处理拒绝。
    await new Promise((r) => setTimeout(r, 0));
    expect(audioContexts[0]!.play).toBe(1);
  });

  it('未知 cue 名：静默忽略，不抛（拼错一个名字不该把牌桌打崩）', () => {
    expect(() => playCue('NoSuchCue' as never)).not.toThrow();
    expect(audioContexts).toHaveLength(0);
  });

  it('新 cue 打断已 started 的旧 cue', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.();
    first.playHandler?.();
    playCue('Rob1');
    expect(first.stop, '已 started 的旧 cue 必须被 stop+destroy').toBeGreaterThanOrEqual(1);
  });

  it('旧 cue 已 play 未 started ⇒ 只标 abandoned，不 stop；onPlay 到达后停掉', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.(); // playCalled = true，但 onPlay 未到
    playCue('Rob1');
    expect(first.stop, 'pending play 期间不得 stop（AbortError）').toBe(0);
    first.playHandler?.(); // onPlay 迟到
    expect(first.stop, 'onPlay 一到，abandoned 的 cue 立刻停').toBeGreaterThanOrEqual(1);
  });

  it('旧 cue 的迟到 ended/error 不会清掉新 cue', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.();
    first.playHandler?.();
    playCue('Rob1');
    const second = audioContexts[1]!;
    second.canplayHandler?.();
    second.playHandler?.();

    first.endedHandler?.();
    first.errorHandler?.();
    playCue('Baojing1'); // 应停掉 second
    expect(second.stop, '新 cue 仍必须是当前 cue，被下一次打断停掉').toBeGreaterThanOrEqual(1);
    expect(audioContexts[2]!.stop).toBe(0);
  });

  it('自然结束后再播新 cue，不会重复处置已完成的 ctx', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.();
    first.playHandler?.();
    first.endedHandler?.();
    const stoppedAfterEnd = first.stop;
    playCue('Rob1');
    expect(first.stop, '已完成并销毁的 ctx 不得被再次 stop/destroy').toBe(stoppedAfterEnd);
  });

  it('音效关闭时新 cue 直接返回，不打断已在播的 cue', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.();
    first.playHandler?.();
    setSfxOn(false);
    playCue('Rob1');
    expect(audioContexts).toHaveLength(1);
    expect(first.stop, '关音效不强行打断当前 cue').toBe(0);
  });

  it('cue 打断不影响 BGM', () => {
    playBgm(CUES.BgmTable);
    const bgm = audioContexts[0]!;
    playCue('NoOrder');
    const first = audioContexts[1]!;
    first.canplayHandler?.();
    first.playHandler?.();
    playCue('Rob1');
    expect(bgm.stop, 'BGM 有独立生命周期').toBe(0);
  });

  it('stopCues 停掉 cue 但不碰 BGM', () => {
    playBgm(CUES.BgmTable);
    const bgm = audioContexts[0]!;
    playCue('NoOrder');
    audioContexts[1]!.canplayHandler?.();
    audioContexts[1]!.playHandler?.();
    stopCues();
    expect(audioContexts[1]!.stop).toBeGreaterThanOrEqual(1);
    expect(bgm.stop).toBe(0);
  });

  it('abandoned cue 再次 canplay 不得 destroy（pending play 不能 pause）', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.(); // playCalled
    playCue('Rob1'); // first 被标 abandoned
    first.canplayHandler?.(); // 缓冲抖动可能让 canplay 再次触发
    expect(first.stop, 'abandoned 后 canplay 只能等 onPlay/onError').toBe(0);
  });

  it('stopCues 不 stop abandoned cue；迟到 onPlay 仍会收尾', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.();
    playCue('Rob1');
    stopCues();
    expect(first.stop, 'pending play 不得被 stopCues 打断').toBe(0);
    first.playHandler?.();
    expect(first.stop, '迟到 onPlay 必须停掉 abandoned cue').toBeGreaterThanOrEqual(1);
  });

  it('总静音停止在播的 cue', () => {
    playCue('NoOrder');
    const first = audioContexts[0]!;
    first.canplayHandler?.();
    first.playHandler?.();
    setMuted(true);
    expect(first.stop).toBeGreaterThanOrEqual(1);
  });

  it('音量钳在 0–1 并存回来', () => {
    setVolume(0.5);
    expect(getVolume()).toBe(0.5);
    setVolume(9);
    expect(getVolume()).toBe(1);
    setVolume(-3);
    expect(getVolume()).toBe(0);
  });
});

describe('事件 → cue 名（按座位取变体，确定性可复现）', () => {
  it('抢地主（kind=rob）：seat 0/2 分别取 Rob1 / Rob3', () => {
    cueForBid('rob', true, 0);
    cueForBid('rob', true, 2);
    expect(srcs()).toEqual(['/pages/table/static/audio/Woman_Rob1.mp3', '/pages/table/static/audio/Woman_Rob3.mp3']);
  });

  it('叫地主（kind=call）→ Woman_Order（U5 修复的现存错配）', () => {
    cueForBid('call', true, 1);
    expect(srcs()).toEqual(['/pages/table/static/audio/Woman_Order.mp3']);
  });

  it('不叫 / 不抢都走 NoOrder（素材里没有「不抢」专用音）', () => {
    cueForBid('call', false, 1);
    cueForBid('rob', false, 2);
    expect(srcs()).toEqual([
      '/pages/table/static/audio/Woman_NoOrder.mp3',
      '/pages/table/static/audio/Woman_NoOrder.mp3',
    ]);
  });

  it('过牌：按座位取 Buyao 变体', () => {
    cueForPass(0);
    cueForPass(1);
    expect(srcs()).toEqual(['/pages/table/static/audio/Woman_buyao1.mp3', '/pages/table/static/audio/Woman_buyao2.mp3']);
  });

  it('座位越界时回落第一条（宁可能听见一声不对的音，也不要静默全哑）', () => {
    cueForBid('rob', true, 9);
    cueForPass(9);
    expect(srcs()).toEqual(['/pages/table/static/audio/Woman_Rob1.mp3', '/pages/table/static/audio/Woman_buyao1.mp3']);
  });
});

describe('BGM', () => {
  it('起 BGM：loop=true 且用正确的 src', () => {
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(1);
    expect(srcs()).toEqual(['/pages/table/static/audio/MusicEx_Normal.mp3']);
    expect(audioContexts[0]!.loop).toBe(true);
  });

  it('同一首重复调不会叠加（幂等）', () => {
    playBgm(CUES.BgmTable);
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(1);
  });

  it('换曲：停掉前一首再起新的', () => {
    playBgm(CUES.BgmLobby);
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(2);
    expect(audioContexts[0]!.stop, '前一首必须被 stop+destroy').toBeGreaterThanOrEqual(1);
    expect(srcs().at(-1)).toBe('/pages/table/static/audio/MusicEx_Normal.mp3');
  });

  it('stopBgm 幂等：没在放时调用不抛', () => {
    expect(() => stopBgm()).not.toThrow();
    playBgm(CUES.BgmTable);
    stopBgm();
    expect(() => stopBgm()).not.toThrow();
  });
});

/**
 * 项 4：音效预热 `preheatCues`。
 *
 * ⚠️ **替身默认不触发 `onCanplay`**（uni-stub 注释里写得很清楚，BGM 判据依赖这一点）。
 * 所以这里的判据只证明：
 *  ① 建了 ctx、赋了正确 src；
 *  ② **不 play**、**不进 live**（预热 ≠ 播放）；
 *  ③ `onCanplay` / `onError` 一到就 `destroy()`（手动派发回调断言）；
 *  ④ 同名重复调用幂等（不重复建 ctx）。
 */
describe('预热 preheatCues（项 4）', () => {
  it('建上下文并赋正确 src，但**不 play**、**不进 live**', () => {
    preheatCues(['NoOrder', 'Rob1']);
    expect(audioContexts).toHaveLength(2);
    const gotSrcs = new Set(srcs());
    expect(gotSrcs).toContain('/pages/table/static/audio/Woman_NoOrder.mp3');
    expect(gotSrcs).toContain('/pages/table/static/audio/Woman_Rob1.mp3');
    // 核心纪律：预热不允许出声
    for (const ctx of audioContexts) {
      expect(ctx.play, '预热绝不 play').toBe(0);
    }
  });

  it('就绪 / 出错后立即 destroy', () => {
    preheatCues(['NoOrder']);
    expect(audioContexts).toHaveLength(1);
    const ctx = audioContexts[0]!;
    expect(ctx.canplayHandler, 'onCanplay 必须注册了回调').not.toBeNull();
    expect(ctx.errorHandler, 'onError 必须注册了回调').not.toBeNull();

    // 手动派发 canplay ⇒ 销毁
    ctx.canplayHandler?.();
    expect(ctx.stop, 'canplay 到 ⇒ destroy（stop 计数 +1）').toBeGreaterThanOrEqual(1);
  });

  it('出错路径也销毁', () => {
    preheatCues(['Rob1']);
    const ctx = audioContexts[0]!;
    ctx.errorHandler?.();
    expect(ctx.stop, 'error 到 ⇒ 也必须销毁').toBeGreaterThanOrEqual(1);
  });

  it('同名 cue 重复调用幂等：不重复建 ctx', () => {
    preheatCues(['NoOrder', 'Rob1']);
    preheatCues(['NoOrder', 'Rob1']); // 再调一遍同样的
    preheatCues(['NoOrder']); // 子集再调一遍
    expect(audioContexts, '每个 cue 只预热一次').toHaveLength(2);
  });

  it('音效通道关掉时不预热', () => {
    setSfxOn(false);
    preheatCues(['NoOrder']);
    expect(audioContexts).toHaveLength(0);
  });

  it('静音时不预热', () => {
    setMuted(true);
    preheatCues(['NoOrder']);
    expect(audioContexts).toHaveLength(0);
  });

  it('未知 cue 名静默忽略，不建 ctx、不抛', () => {
    expect(() => preheatCues(['DoesNotExist' as never])).not.toThrow();
    expect(audioContexts).toHaveLength(0);
  });
});

describe('音乐 / 音效独立通道', () => {
  it('音效通道关掉：cue 一次都不建上下文；重开后恢复', () => {
    setSfxOn(false);
    expect(isSfxOn()).toBe(false);
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(0);

    setSfxOn(true);
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(1);
  });

  it('音乐通道关掉：不起 BGM；已经在放的立刻被停掉', () => {
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(1);

    setMusicOn(false);
    expect(isMusicOn()).toBe(false);
    expect(audioContexts[0]!.stop).toBeGreaterThanOrEqual(1);

    // 关着的时候再请求起播：不新建上下文
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(1);

    // 重开后由调用方重新点歌（本层不自动起播）
    setMusicOn(true);
    expect(audioContexts).toHaveLength(1);
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(2);
  });

  it('两通道互不影响：关音乐不影响 cue，关音效不影响 BGM', () => {
    setMusicOn(false);
    playCue('NoOrder');
    expect(audioContexts).toHaveLength(1);

    setSfxOn(false);
    playBgm(CUES.BgmTable);
    expect(audioContexts).toHaveLength(1); // 没有新增 BGM 上下文
  });

  it('通道状态持久化（off 标记，未命中按开）', () => {
    const stub = installUniStub();
    setSfxOn(false);
    setMusicOn(false);
    expect(stub.getStorageSync('ftl.audio.sfxOff')).toBe('1');
    expect(stub.getStorageSync('ftl.audio.musicOff')).toBe('1');

    // 模拟重新挂载：模块内状态由 loadAudioPrefs 从存储恢复
    setSfxOn(true);
    setMusicOn(true);
    stub.setStorageSync('ftl.audio.sfxOff', '1');
    loadAudioPrefs();
    expect(isSfxOn()).toBe(false);
    expect(isMusicOn()).toBe(true);
  });
});

/**
 * **接线**级判据：牌桌页真的会在对的时刻播对的音效。
 *
 * ⚠️ 为什么单独测这个：`useTableSound` 是「视图 diff → 音效」的**接线**，
 * 它最容易**静默失效**（字段名写错、watch 源选错 —— `tsc` 与既有闸都不报），
 * 而单独测 `playCue` 是**测不到接线**的。这里挂真页面、推真服务端消息。
 *
 * ⚠️ 两条夹具约束（抄自 `table-settlement-ui`）：
 * · `mount` 用的 pinia 必须与 `useGameStore()` 取到的是**同一个实例**，否则页面拿不到
 *   你喂的 store（表现为 `no handler registered for push type: …`）；
 * · `game.settlement` 的载荷必须**分数守恒**（`landlordScoreChange + farmerScoreChange × 农民数 === 0`），
 *   否则 `validateInbound` 先抛，消息根本到不了页面。
 */
describe('牌桌接线（useTableSound）', () => {
  let pinia: ReturnType<typeof createPinia>;
  const mounted: VueWrapper[] = [];

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    stopGameSession();
  });

  function mountTable(mySeat = 0) {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const store = useGameStore();
    store.setRoom('ROOM1', mySeat);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    mounted.push(wrapper);
    return { wrapper, socket, store };
  }

  it('进入牌桌即起牌桌 BGM', () => {
    mountTable();
    expect(srcs(), '牌桌 BGM 必须是 MusicEx_Normal').toContain('/pages/table/static/audio/MusicEx_Normal.mp3');
  });

  it('结算出现时按「我赢没赢」选 Win/Lose（我是地主 + 农民赢 ⇒ Lose）', async () => {
    const { wrapper, socket, store } = mountTable(0);
    // 先让 store.view 就位（结算块在 `waitingForDeal === false` 的分支里）
    socket.push(
      serverMessage('game.state_update', playerViewFixture({ state: 'playing', seat: 0, version: 2 }), 2),
    );
    await wrapper.vm.$nextTick();
    const before = audioContexts.length;

    // 分数守恒：-777 + 388.5 × 2 === 0
    socket.push(
      serverMessage(
        'game.settlement',
        {
          roomCode: 'ROOM1',
          baseScore: 100,
          winner: 'farmer',
          landlordSeat: 0, // 我是地主（mySeat === 0）
          farmerSeats: [1, 2],
          multiplier: 4,
          spring: 'none',
          landlordScoreChange: -777,
          farmerScoreChange: 388.5,
        },
        3,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(store.settlement, '结算载荷必须真的到了 store（否则下面测的是空气）').not.toBeNull();
    expect(srcs().slice(before), '地主输了 ⇒ Lose').toContain('/pages/table/static/audio/MusicEx_Lose.mp3');
  });

  it('某人剩 1 张 / 2 张时报单报双（§6.5-2），首版快照只登记不播', async () => {
    const { wrapper, socket } = mountTable(0);
    const before = audioContexts.length;

    // 首版快照 = 正常开局计数 ⇒ bootstrap 只登记（即使带 1/2 张也不补播）
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '首版快照不得播报单').toEqual([]);

    // 下一版：座位 1 剩 2 张、座位 2 剩 1 张
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'playing', seat: 0, version: 2, cardCounts: [17, 2, 1] }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const played = srcs().slice(before);
    expect(played, '剩 1 张 ⇒ 报单').toContain('/pages/table/static/audio/Woman_baojing1.mp3');
    expect(played, '剩 2 张 ⇒ 报双').toContain('/pages/table/static/audio/Woman_baojing2.mp3');
    // 正对照：我自己剩 17 张，不得触发报单报双
    expect(played.filter((s) => s === '/pages/table/static/audio/Woman_baojing1.mp3')).toHaveLength(1);
  });

  /**
   * 出牌 / 过牌播报（U5-1：所有座位）。
   *
   * ① 最新一条 = 单张大王 ⇒ 播对应牌型音效；
   * ② 最新一条 = 过牌 ⇒ 播该座位的「不出」变体（不再静音）。
   *
   * ⚠️ 首版快照必须为空：bootstrap 会把第一版视图的历史动作只登记、不播。
   */
  it('所有座位的出牌与过牌都播报（单张大王 → 200；过牌 → buyao{seat+1}）', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    const before = audioContexts.length;

    // 座位 1 打出一张**大王**（DouZero 30）
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          recentActions: [{ seat: 1, cards: makeCards(30) }],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '窗口最新一条 = 单张大王 ⇒ 大王音效').toEqual([
      '/pages/table/static/audio/Woman_200.mp3',
    ]);

    // 下一版：座位 2 过牌 ⇒ 播该座位的「不出」
    const afterJoker = audioContexts.length;
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 3,
          recentActions: [
            { seat: 1, cards: makeCards(30) },
            { seat: 2, cards: null },
          ],
        }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(afterJoker), '座位 2 过牌 ⇒ Woman_buyao3').toEqual([
      '/pages/table/static/audio/Woman_buyao3.mp3',
    ]);
  });

  /** 结算载荷（分数守恒：-777 + 388.5 × 2 === 0）。 */
  const settlementMsg = (version: number) =>
    serverMessage(
      'game.settlement',
      {
        roomCode: 'ROOM1',
        baseScore: 100,
        winner: 'farmer',
        landlordSeat: 0,
        farmerSeats: [1, 2],
        multiplier: 4,
        spring: 'none',
        landlordScoreChange: -777,
        farmerScoreChange: 388.5,
      },
      version,
    );

  it('重连：挂载后首版快照只登记不播；下一手照常播', async () => {
    const { wrapper, socket } = mountTable(0);
    const before = audioContexts.length;

    // 挂载时 view === null；这一版带历史动作 + 1/2 张计数（中途重连的真实形态）
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 1,
          cardCounts: [17, 1, 2],
          recentActions: [{ seat: 1, cards: makeCards(30) }],
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '首版快照（带历史窗口 / 报单计数）不得补播').toEqual([]);

    // 下一版：座位 0 出单张 3 ⇒ 照常播
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          recentActions: [
            { seat: 1, cards: makeCards(30) },
            { seat: 0, cards: makeCards(3) },
          ],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '新动作照常播').toEqual([
      '/pages/table/static/audio/Woman_3.mp3',
    ]);
  });

  it('结算锁：终局后不再播牌型；新局恢复', async () => {
    const { wrapper, socket, store } = mountTable(0);
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    socket.push(settlementMsg(2));
    await wrapper.vm.$nextTick();
    expect(store.settlement).not.toBeNull();
    const afterSettlement = audioContexts.length;

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 3,
          recentActions: [{ seat: 1, cards: makeCards(30) }],
        }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(afterSettlement), '结算后不得再播牌型 / 过牌').toEqual([]);

    // 新局：store.reset() 清掉 settlement 与视图 ⇒ 恢复播报
    store.reset();
    await wrapper.vm.$nextTick();
    const afterReset = audioContexts.length;
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 1,
          recentActions: [{ seat: 1, cards: makeCards(30) }],
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(afterReset), '新局恢复播报').toEqual([
      '/pages/table/static/audio/Woman_200.mp3',
    ]);
  });

  it('同一次更新：报单/报双压过牌型播报（后者被 stop）', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    const before = audioContexts.length;

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          cardCounts: [17, 1, 17],
          recentActions: [{ seat: 1, cards: makeCards(3) }],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(srcs().slice(before), '先牌型、后报单').toEqual([
      '/pages/table/static/audio/Woman_3.mp3',
      '/pages/table/static/audio/Woman_baojing1.mp3',
    ]);
    expect(audioContexts[before]!.stop, '牌型 cue 必须被报单打断').toBeGreaterThanOrEqual(1);
  });

  it('出牌与结算同一刷新：结算锁让牌型不播，只播胜负', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    const before = audioContexts.length;

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          recentActions: [{ seat: 1, cards: makeCards(30) }],
        }),
        2,
      ),
    );
    socket.push(settlementMsg(3));
    await wrapper.vm.$nextTick();

    expect(srcs().slice(before), '结算锁：只播 Lose，不播牌型').toEqual([
      '/pages/table/static/audio/MusicEx_Lose.mp3',
    ]);
  });

  /**
   * 叫抢音效**改走 `decisions` 的视图 diff**（协议⑦ / Task B3）。
   *
   * 旧入口是「点按钮 ⇒ ack `code=0` ⇒ 本地回声播」（服务端那时没有 per-seat 的决策记录）；
   * 现在 `decisions` 就是服务端的原话 ⇒ 与「王单张」同一手法读**视图 diff**。
   * ⚠️ 变体选择仍走 `cueForBid`（`audio/` 里的唯一实现）——本用例证明的是**接线**
   *（哪位座位、哪一刻、播几条），不是变体表本身（那几条纯函数判据在上面的 describe 里，一字未动）。
   *
   * 🔵 **副产品**：别人的决策也会响（参考实现本就按座位播 `Rob1/2/3`）——
   * 这正是本用例第 2 段断言的性质（座位 1 的「抢」不是我的动作，仍然要响）。
   */
  it('叫抢音效走 decisions 的视图 diff（按座位取变体；只播新出现的；别人也响）', async () => {
    const { wrapper, socket } = mountTable(0);
    const before = audioContexts.length;
    const biddingView = (version: number, over: Partial<PlayerView['bidPhase']>) =>
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'bidding', seat: 0, version, bidPhase: bidPhase(over) }),
        version,
      );

    // v2：还没有任何决策 ⇒ 一条都不许响（否则「响了」与「视图到达」混为一谈）
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'bidding', seat: 0, version: 1, bidPhase: bidPhase() }), 1),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '叫抢期刚进入、还没有决策 ⇒ 不得出声').toEqual([]);

    // v3：**座位 1**（对手）抢 ⇒ 按座位取变体 Rob2
    socket.push(
      biddingView(2, {
        currentBidder: 2,
        grabActions: 1,
        landlordCandidate: 1,
        decisions: [{ seat: 1, kind: 'call', grab: true }],
      }),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '对手（座位 1）的「叫地主」也必须响，声音是 Order').toEqual([
      '/pages/table/static/audio/Woman_Order.mp3',
    ]);

    // v4：座位 2 不抢 ⇒ **只补播新出现的那一条**（不得重播历史）
    socket.push(
      biddingView(3, {
        currentBidder: 0,
        grabActions: 2,
        landlordCandidate: 1,
        decisions: [
          { seat: 1, kind: 'call', grab: true },
          { seat: 2, kind: 'rob', grab: false },
        ],
      }),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '只播新出现的那一条（不重播历史）').toEqual([
      '/pages/table/static/audio/Woman_Order.mp3',
      '/pages/table/static/audio/Woman_NoOrder.mp3',
    ]);
  });

  /**
   * 流局重发 ⇒ `decisions` 清空（协议⑦）⇒ 游标必须跟着归零。
   *
   * 反推：删掉 `useTableSound` 里那句「长度回落 ⇒ 游标归零」会怎样？游标停在 1，
   * 新的一轮第一条决策让长度**回到 1**（`1 === playedDecisions`）⇒ watch 的源**没变**、
   * 回调根本不跑 ⇒ **新的一轮静默无声**（本用例最后一段当场红）。
   */
  it('流局重发（decisions 清空）后，新的一轮**重新出声**', async () => {
    const { wrapper, socket } = mountTable(0);
    const before = audioContexts.length;
    const biddingView = (version: number, over: Partial<PlayerView['bidPhase']>) =>
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'bidding', seat: 0, version, bidPhase: bidPhase(over) }),
        version,
      );

    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'bidding', seat: 0, version: 1, bidPhase: bidPhase() }), 1),
    );
    await wrapper.vm.$nextTick();
    // 我（座位 0）叫 ⇒ Order
    socket.push(biddingView(2, { grabActions: 1, landlordCandidate: 0, decisions: [{ seat: 0, kind: 'call', grab: true }] }));
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '第一轮：座位 0 叫地主').toEqual(['/pages/table/static/audio/Woman_Order.mp3']);

    // 流局重发：decisions 清空（`resetBidding`）——长度回落是本用例的**前件**
    socket.push(biddingView(3, { currentBidder: 0, grabActions: 0, landlordCandidate: -1, redealCount: 1, decisions: [] }));
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '重发本身不出声').toEqual(['/pages/table/static/audio/Woman_Order.mp3']);

    // 新的一轮：座位 0 又不叫 ⇒ 必须再次出声（游标没归零的话这里静默）
    socket.push(biddingView(4, { currentBidder: 1, grabActions: 1, landlordCandidate: -1, redealCount: 1, decisions: [{ seat: 0, kind: 'call', grab: false }] }));
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '新的一轮必须重新出声（游标归零）').toEqual([
      '/pages/table/static/audio/Woman_Order.mp3',
      '/pages/table/static/audio/Woman_NoOrder.mp3',
    ]);
  });

  /**
   * **最后一处叫抢本地回声已删**（Task B3）：点按钮 + ack `code=0` **不再**本地补响 ——
   * 声音的唯一来源是 `decisions` 的视图 diff。
   *
   * 反推：旧实现（`send('game.bid', …, () => cueForBid(...))`）在这一步会播 `Woman_Rob1` ⇒ 红；
   * 若有人把本地回声**与**视图 diff 一起留着 ⇒ **双响**，本用例同样红。
   */
  it('点叫抢按钮 + ack 0 ⇒ 不得本地补响（叫抢的最后一处本地回声已删）', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({ state: 'bidding', seat: 0, version: 1, bidPhase: bidPhase({ currentBidder: 0 }) }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    const before = audioContexts.length;

    await wrapper.find('.table__bid-grab').trigger('click');
    expect(socket.emittedOf('game.bid'), '先证明按钮真的发出去了（否则本用例恒真）').toHaveLength(1);
    socket.emittedOf('game.bid')[0]!.ack(null, { code: 0 });
    await flushPromises();

    expect(srcs().slice(before), 'ack 成功也不得本地补响（旧实现会在这里播 Woman_Rob1）').toEqual([]);
  });

  it('点过牌 + ack 0 + 自己的 pass 视图 ⇒ 只响一次（ack 本地回声已删）', async () => {
    const { wrapper, socket } = mountTable(1); // 我是座位 1
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'playing',
          seat: 1,
          version: 1,
          currentPlayer: 1,
          // 对手先出了一手 ⇒ 跟牌，过牌按钮可用
          recentActions: [{ seat: 0, cards: makeCards(3) }],
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    const before = audioContexts.length;

    await wrapper.find('.table__pass').trigger('click');
    expect(socket.emittedOf('game.pass'), '先证明按钮真的发出去了').toHaveLength(1);
    socket.emittedOf('game.pass')[0]!.ack(null, { code: 0 });
    await flushPromises();

    // 服务端视图：窗口最新一条 = 我（座位 1）过牌
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 1,
          version: 2,
          currentPlayer: 2,
          recentActions: [
            { seat: 0, cards: makeCards(3) },
            { seat: 1, cards: null },
          ],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(srcs().slice(before), 'ack 回声 + 视图 diff 双响是旧实现的缺陷').toEqual([
      '/pages/table/static/audio/Woman_buyao2.mp3',
    ]);
  });

  it('离桌 unmount 停掉在播 cue（stopCues 接线）', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          recentActions: [{ seat: 1, cards: makeCards(30) }],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const cue = audioContexts[audioContexts.length - 1]!;
    cue.canplayHandler?.();
    cue.playHandler?.();
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);

    expect(cue.stop, '离桌后不得继续响进大厅').toBeGreaterThanOrEqual(1);
  });

  /**
   * **重连 / 重挂载不补播历史**（B3 评审 Minor 4 收口）：游标初值 = 挂载那一刻视图里
   * **已有的决策条数**（`useTableSound` 的 `playedDecisions`）。
   *
   * 反推：初值写死 0（旧形态）时，若挂载时 store 里已有一版带 1 条决策的视图
   *（＝中途重连/重挂载的真实形态），下一版视图（2 条）到达会从 0 播起 ⇒
   * 历史那条被**补播一遍** ⇒ 本用例第一段当场红。
   * ⚠️ 正常进房路径（先 `game.deal`、后决策）不受影响：其余接线用例就是那一路径的回归网。
   */
  it('挂载时视图已带决策（重连/重挂载）⇒ 不补播历史；新出现的照常出声', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const store = useGameStore();
    store.setRoom('ROOM1', 0);
    // 挂载**之前**就有一版带 1 条决策的视图（重连/重挂载时 store 里已经有的形态）
    store.applySnapshot(
      playerViewFixture({
        state: 'bidding',
        seat: 0,
        version: 1,
        bidPhase: bidPhase({
          grabActions: 1,
          landlordCandidate: 0,
          decisions: [{ seat: 0, kind: 'call', grab: true }],
        }),
      }),
    );
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    mounted.push(wrapper);
    await wrapper.vm.$nextTick();
    const before = audioContexts.length; // 基准在**挂载之后**取（BGM 已计入 before）

    // 下一版：对手（座位 1）抢 ⇒ 只该播**新出现的那一条**
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          version: 2,
          bidPhase: bidPhase({
            currentBidder: 2,
            grabActions: 2,
            landlordCandidate: 1,
            decisions: [
              { seat: 0, kind: 'call', grab: true },
              { seat: 1, kind: 'rob', grab: true },
            ],
          }),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(srcs().slice(before), '不得补播挂载前已有的那条（游标写 0 的旧形态会先播 Woman_Rob1）').toEqual([
      '/pages/table/static/audio/Woman_Rob2.mp3',
    ]);
  });
});

