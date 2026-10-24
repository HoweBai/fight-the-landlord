/**
 * ➌ 座位几何（spec §5-➌ + R660 + §9.6）。
 *
 * 判据四条：
 *  ① 两家对手各有 `.seat`，各自渲染 `cardCount` 张牌背；
 *  ② 轮次指示随 `actorSeat` 转移（**正反两面都断言**：转移前在 A 不在 B，转移后在 B 不在 A）；
 *  ③ 自己座位**不画牌背扇**（R660：`.table__me .card` 必须仍然只数得到手牌）；
 *  ④ 终局没有任何 `.turn-timer`（**既有判据的延续**：actorSeat 为 null ⇒ 不渲染倒计时；
 *     2026-10-11 第三轮起对手迷你钟抽到 `TurnTimer.vue`、挂在出牌/状态列）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TablePage from '../src/pages/table/table.vue';
import { useGameStore } from '../src/stores/game';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
/**
 * `src/uni.scss` 的剥注释文本 —— 字号档位的**真值**从这里现读。
 * ⚠️ 不在测试里抄一份字号表：抄一份就是第二个真源，字号阶一改判据就开始说谎。
 */
const uniScssCode = stripComments(sources.find((f) => f.path === 'src/uni.scss')!.content);

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  // ⚠️ `useCountdown` 在页面挂载时就起了 250ms 的 setInterval；不卸载会让本文件留下若干常驻定时器。
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

function mountTable(opts: { mySeat: number }) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', opts.mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

describe('➌ 座位几何', () => {
  it('两个对手座位各挂一张**数字徽章**（数字 = 服务端 cardCounts）；自己座位不挂（R727 成对迁移 / R660）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, cardCounts: [17, 5, 3] }), 1),
    );
    await wrapper.vm.$nextTick();

    // 2 对手 + 我的**两个分件**（part="avatar" 头像件 / part="meta" 昵称金币件，
    // 第六轮起头像独立在左、信息与 HUD 成右簇）⇒ 4 个 Seat 实例 = 3 个逻辑座位。
    expect(wrapper.findAll('.seat')).toHaveLength(4);

    // ① 徽章只挂在两个对手身上，且数字**就是服务端给的 cardCounts**
    //    （片② R727：数字取代牌背扇 —— 参考图里对手的剩余牌就是卡片形状的数字徽章）
    const tiles = [...wrapper.findAll('.seat__count-tile')];
    expect(tiles.map((t) => t.text()).sort()).toEqual(['3', '5']);

    // ② 反面对照：**座位里**不再有牌背扇（R727：数字取代了它）。
    //    ⚠️ 必须限定在 `.seat` 内 —— `.card--back` 在别处**仍然合法存在**（底牌位叫抢期就是 3 张牌背）。
    expect(wrapper.findAll('.seat .card--back'), '对手座位不再画牌背扇').toHaveLength(0);
    // ③ 正对照：`.card--back` 这个形态**没有从全仓消失**（否则 ② 的「0 张」没有判别力）
    expect(
      wrapper.findAll('.card--back').length,
      '底牌位仍应有牌背（证明 ② 不是「页面上根本没牌」）',
    ).toBeGreaterThan(0);

    // ④ R660 的语义**未变**：`.table__me .card` 仍然只数得到手牌
    //    （牌背混进去会让两张既有测试静默失配）
    expect(wrapper.find('.table__me').findAll('.card')).toHaveLength(17);
  });

  it('轮次指示随服务端行动者转移（正反两面）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, currentPlayer: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.seat--active')).toHaveLength(1);
    expect(wrapper.find('.seat--active').text()).toContain('玩家1');

    socket.push(
      serverMessage('game.state_update', playerViewFixture({ state: 'playing', seat: 0, version: 2, currentPlayer: 2 }), 2),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.seat--active')).toHaveLength(1);
    expect(wrapper.find('.seat--active').text()).toContain('玩家2');
  });

  it('对手昵称来自 room.join / room.state_update；缺省回落「玩家N」', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0 },
        { id: 'p1', seat: 1, nickname: '阿豆' },
        { id: 'p2', seat: 2 },
      ],
    });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1 }), 1),
    );
    await wrapper.vm.$nextTick();

    const text = wrapper.text();
    expect(text).toContain('阿豆');
    expect(text).toContain('玩家2');
    expect(text).not.toContain('玩家1');
  });

  it('地主标记只出现在 `landlordSeat` 那个座位（服务端字段，不做推断）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, landlordSeat: 2 }), 1),
    );
    await wrapper.vm.$nextTick();
    const badged = wrapper.findAll('.seat').filter((s) => s.find('.seat__badge').exists());
    expect(badged).toHaveLength(1);
    expect(badged[0]!.text()).toContain('玩家2');
  });

  it('对手钟只显示秒数、不画进度条（2026-10-11 用户裁决删除，防复活）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', playerViewFixture({ state: 'playing', seat: 0, version: 1, currentPlayer: 1 }), 1),
    );
    await wrapper.vm.$nextTick();
    // 钟与秒数在：mySeat=0 逆时针座序，行动者座位 1 是下家 ⇒ 挂在右出牌/状态列
    const timer = wrapper.find('.table__play-col--right .turn-timer');
    expect(timer.exists()).toBe(true);
    expect(timer.find('.turn-timer__value').exists()).toBe(true);
    // 进度条轨道/填充已删除：即使服务端随后给了 timeoutMs 也不得出现
    expect(wrapper.find('.turn-timer__track').exists()).toBe(false);
    expect(wrapper.find('.turn-timer__fill').exists()).toBe(false);

    socket.push(serverMessage('game.current_turn', { seat: 1, timeoutMs: 30_000 }, 1));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.turn-timer__track').exists()).toBe(false);
    expect(wrapper.find('.turn-timer__fill').exists()).toBe(false);
  });

  it('终局不渲染任何倒计时（既有判据延续）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    /**
     * ⚠️ 显式给**完整**的 `bidPhase`：夹具对这个字段是**整体替换、不合并**（见文件头注释），
     * 只写一个键会得到残缺对象 ⇒ 这条脚手架（`bidPhase()`）必须留在本文件里并被真的用上
     * （`noUnusedLocals` 会把「只为照抄而存在的未用 helper」判成编译错误）。
     */
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'ended', seat: 0, version: 3, bidPhase: bidPhase() }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.turn-timer')).toHaveLength(0);
    expect(wrapper.find('.table__ended').exists()).toBe(true);
  });

  /**
   * §6.5-1（2026-10-11 用户裁决**再次改规格**）：张数牌走**独立角标档**
   * `$ftl-font-count-tile` = **28px**（历档：旧规格 > 昵称档 → 第五轮 24px → 同日 28px，
   * 牌体同步放大到 36×49 并下移与昵称水平）。本用例钉死：① 必须用令牌不许就地写字号；
   * ② 令牌真值就是 28（防有人顺手挪去共用档位导致再次漂移）。
   *
   * ⚠️ **判据射程（诚实版）**：jsdom 不注入 CSS ⇒ 这里读的是**源码里的令牌真值**，
   * **不证明**「看起来显眼」（那是观感，见走查）。
   */
  it('§6.5-1（新规格）：张数数字走独立角标档 $ftl-font-count-tile = 28px', () => {
    const fontPx = (tier: string): number => {
      const m = new RegExp(`^\\$ftl-font-${tier}:\\s*(\\d+)px;`, 'm').exec(uniScssCode);
      expect(m, `未找到令牌 $ftl-font-${tier}`).not.toBeNull();
      return Number(m![1]);
    };
    const seat = sources.find((f) => f.path === 'src/components/Seat.vue');
    expect(seat, 'Seat.vue 必须在扫描集合里').toBeDefined();
    const code = stripComments(seat!.content);

    const block = new RegExp('\\.seat__count-tile-num\\s*\\{([^}]*)\\}').exec(code);
    expect(block, '未找到 .seat__count-tile-num 规则').not.toBeNull();
    const tier = /\$ftl-font-(\w[\w-]*)/.exec(block![1]!);
    expect(tier, '数字牌数字必须用 $ftl-font-* 令牌（不得就地写字号）').not.toBeNull();
    expect(tier![1], '必须走独立角标档，不得挪去共用档位').toBe('count-tile');
    expect(fontPx('count-tile'), '角标档真值钉死 28px').toBe(28);
  });

  /** §6.4：座位头像走素材图（项 6 起在分包 `pages/table/static/av/`），地主与农民取**不同**文件。 */
  it('§6.4：座位头像走素材图，地主的那个座位取 Landlord.png', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({ state: 'playing', seat: 0, version: 1, landlordSeat: 2 }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    const seats = [...wrapper.findAll('.seat')];
    const landlord = seats.find((s) => s.find('.seat__badge').exists());
    expect(landlord, '必须有一个带地主标的座位').toBeDefined();
    // 版本 query 由 tableAsset() 按环境统一处理：测试（dev 形态）下 URL 不带 query
    expect(landlord!.find('.seat__avatar-img').attributes('src')).toBe(
      '/pages/table/static/av/Landlord.png',
    );

    // 正对照：农民取**另一张** —— 证明真的是按 `isLandlord` 分支，不是写死一张
    const farmer = seats.find((s) => !s.find('.seat__badge').exists());
    expect(farmer, '必须有农民座位').toBeDefined();
    expect(farmer!.find('.seat__avatar-img').attributes('src')).toBe(
      '/pages/table/static/av/Farmer.png',
    );
  });

  /**
   * §6.5-2：**报单 / 报双预警** —— 剩 1–2 张时数字牌带警示档。
   * 数据现成（服务端 `cardCounts`），零协议改动。
   * 2026-10-10 后预警类从旧的 `.seat__count--warn` 迁到 `.seat__count-tile--warn`
   * （旧「剩 N 张」文字已删，只剩昵称行的蓝色数字牌）。
   */
  it('§6.5-2：剩 1–2 张的座位数字牌带预警档，剩 ≥3 张不带（正反两面）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    // 座位 0 = 我（17 张，手牌夹具就是 17）；座位 1 剩 2 张（报双）；座位 2 剩 1 张（报单）。
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({ state: 'playing', seat: 0, version: 1, cardCounts: [17, 2, 1] }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    const warned = wrapper.findAll('.seat__count-tile--warn');
    expect(warned, '两个对手剩 ≤2 张 ⇒ 两个预警').toHaveLength(2);
    // 正对照：对手里**没有**预警的那个不存在（本布局我不渲染数字牌，所以改从张数侧验：
    // 预警牌里的数字只能是 1 和 2，3 张以上的数字牌不带预警）。
    expect(warned.map((t) => t.text()).sort()).toEqual(['1', '2']);
    // 我这一行不渲染数字牌 ⇒ 自然也不可能带预警档
    expect(wrapper.find('.table__me').findAll('.seat__count-tile'), '我的座位不挂剩余数字牌').toHaveLength(0);

    // 源码闸（2026-10-12 冷蓝/暖橙双素材方案）：预警牌身必须接通暖橙专用槽，
    // 且 hue-rotate 滤镜方案已废止 —— 常态冷蓝、预警才暖橙，语义靠两张素材而不是改色。
    const seatCode = stripComments(sources.find((f) => f.path === 'src/components/Seat.vue')!.content);
    const warnBlock = /\.seat__count-tile--warn\s*\{([^}]*)\}/.exec(seatCode);
    expect(warnBlock, '未找到 .seat__count-tile--warn 规则块').not.toBeNull();
    expect(warnBlock![1], '预警态必须切暖橙专用素材槽').toMatch(/\$ftl-art-count-tile-warn/);
    expect(seatCode, 'hue-rotate 滤镜方案已废止（预警有自己的素材，不得复活）').not.toMatch(/hue-rotate/);
  });
});
