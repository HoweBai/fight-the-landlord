/**
 * 玩家信息条共用件（大厅顶栏 + 开始游戏页左下）+ 座位余额（`Seat.vue`，② 金币场 §14）。
 *
 * 判别力说明（四条）：
 *  ① 三个部分**都在**（头像 / 昵称 / 余额）—— 少一个就是「重做时丢了一件」；
 *  ② **缺省态**恒为占位符 `—`（未知不编数字：免费场/好友房/读失败都落这里）；
 *  ③ **哑**：它**只**渲染 `name` / `balance` 两个 prop —— 换一个值就换一个显示，
 *     组件里**没有** store / 网络调用 / 「这是不是金币场」的判断（源码级断言）；
 *  ④ ② 金币场：传数字 ⇒ 显示那个数（真值的唯一形态）。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PlayerChip from '../src/components/PlayerChip.vue';
import Seat from '../src/components/Seat.vue';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

describe('PlayerChip：头像 + 昵称 + 货币占位（D12）', () => {
  it('① 三个部分都在，且昵称就是传进来的那个值', () => {
    const w = mount(PlayerChip, { props: { name: '阿豆' } });
    expect(w.find('.chip__avatar').exists(), '头像位必须在（R693：不白屏）').toBe(true);
    expect(w.find('.chip__name').text()).toBe('阿豆');
    expect(w.find('.chip__coin').exists(), '货币位必须在').toBe(true);
  });

  it('② 缺省余额恒为占位符 —— 不编数字（未知 = 免费场 / 读失败 / 还没取到）', () => {
    const w = mount(PlayerChip, { props: { name: '阿豆' } });
    expect(w.find('.chip__currency').text()).toBe('—');
    expect(w.text(), '不得出现任何数字（「—」是缺省态的唯一合法内容）').not.toMatch(/\d/);
    // 显式 `null`（= 未知的表达）与缺省同一条处置
    expect(mount(PlayerChip, { props: { name: '阿豆', balance: null } }).find('.chip__currency').text()).toBe('—');
  });

  it('④ 传数字 ⇒ 显示这个数（金币场真值；组件不做任何换算）', () => {
    const w = mount(PlayerChip, { props: { name: '阿豆', balance: 12345 } });
    expect(w.find('.chip__currency').text()).toBe('12345');
  });

  it('③ 哑：换个 prop 就换个显示；组件里没有 store / 网络调用', () => {
    const a = mount(PlayerChip, { props: { name: '甲' } });
    const b = mount(PlayerChip, { props: { name: '乙' } });
    expect(a.find('.chip__name').text()).toBe('甲');
    expect(b.find('.chip__name').text()).toBe('乙');

    const src = collectSourceFiles().find((f) => f.path === 'src/components/PlayerChip.vue');
    expect(src, 'PlayerChip.vue 必须在源码扫描集合里').toBeDefined();
    const code = stripComments(src!.content);
    expect(code, '共用件不得自己取数（那是调用方的事）').not.toMatch(/useAuthStore|useGameStore/);
    expect(code, '共用件不得自己发请求').not.toMatch(/\brest\.|fetch\(/);
    /**
     * ⚠️ 上面那条正则**只抓 `rest.` 这个成员表达式**（复核订正）：写成
     * `import { me } from '../net/rest'` 再直接 `me()` —— 源码里既没有 `rest.` 也没有 `fetch(`，
     * 会溜过去。所以补一条**按导入源**拦的：共用件根本**不该**引 net / stores 这两层。
     * （`uni.request` 同理：本组件也不该直接碰宿主。）
     */
    expect(code, '共用件不得 import net / stores / 直接碰宿主').not.toMatch(
      /from\s+'\.\.\/(net|stores)\/|uni\.request/,
    );
  });

  /**
   * 支付片 T14：`part` 部件拆分（大厅顶栏把「身份 ⇒ 玩家菜单」与「金币视图 ⇒ 钱包页」
   * 拆成**兄弟按钮**——uni-app H5 里把一个可点区域嵌进另一个 `<button>` 不可靠）。
   * 判别力：`part` 只决定**渲染哪几个部件**，拆分后仍从**本组件唯一一处**渲染
   * （没有第二份头像/昵称/金币的模板副本）；缺省 `all` = 既有形态一字不改。
   */
  it('⑤ part：identity = 头像+昵称（无金币）；coin = 只有金币视图；缺省 all = 两者（牌桌等既有调用点不受扰）', () => {
    const identity = mount(PlayerChip, { props: { name: '阿豆', balance: 880, part: 'identity' } });
    expect(identity.find('.chip__avatar').exists()).toBe(true);
    expect(identity.find('.chip__name').text()).toBe('阿豆');
    expect(identity.find('.chip__coin').exists(), 'identity 不得再渲染金币视图').toBe(false);

    const coin = mount(PlayerChip, { props: { name: '阿豆', balance: 880, part: 'coin' } });
    expect(coin.find('.chip__coin').exists(), 'coin = 钱包入口的内容').toBe(true);
    expect(coin.find('.chip__currency').text()).toBe('880');
    expect(coin.find('.chip__avatar').exists(), 'coin 不渲染头像').toBe(false);
    expect(coin.find('.chip__name').exists()).toBe(false);

    const all = mount(PlayerChip, { props: { name: '阿豆', balance: 880 } });
    expect(all.find('.chip__avatar').exists()).toBe(true);
    expect(all.find('.chip__name').exists()).toBe(true);
    expect(all.find('.chip__coin').exists()).toBe(true);
  });

  it('⑤ coin 部件缺 `name` 合法（钱包按钮不传昵称——必填 prop 会逼出一条假数据）', () => {
    const coin = mount(PlayerChip, { props: { part: 'coin', balance: null } });
    expect(coin.find('.chip__currency').text()).toBe('—');
  });
});

/**
 * ② 金币场（§14 / D7）：`Seat.vue` 的货币位——金币场显服务端下发的该座余额，
 * 缺省/`null` ⇒ **整个货币位不渲染**（**免费场恒缺省**：服务端从不下发 ⇒ 组件层看到的
 * 就是「没有值」）。
 *
 * 判别力两半：传 12345 ⇒ 必须显 12345（拦「永远不渲染」）；不传 ⇒ 货币位必须**不存在**，
 * 也不是 0（拦「顺手补 0」——那会把「没有值」变成一条假数据；走查前是显「—」占位，
 * 三座一排破折号是噪音，已改为整块退场）。
 * ⚠️ 「免费场恒没有货币位」**不在这里判**：那是**调用方/服务端**的形态（不下发），
 * 组件层只回答「给了值就显示、没给就不画」。
 */
describe('Seat.vue：② 座位余额（金币场真值 / 缺省整块不渲染）', () => {
  function mountSeat(over: Record<string, unknown> = {}) {
    return mount(Seat, {
      props: { seat: 1, name: '玩家1', cardCount: 5, isLandlord: false, isActive: false, ...over },
    });
  }

  it('balance 传数字 ⇒ 显这个数（服务端真值，原样）', () => {
    const w = mountSeat({ balance: 12345 });
    expect(w.find('.seat__coin').exists(), '有真值 ⇒ 货币位在').toBe(true);
    expect(w.find('.seat__coin-value').text()).toBe('12345');
  });

  it('缺省 / null ⇒ 整个货币位不渲染（不是「—」占位，更**不得**补 0）', () => {
    const absent = mountSeat();
    expect(absent.find('.seat__coin').exists(), '缺字段 ⇒ 整块退场（不画一排破折号）').toBe(false);
    expect(absent.find('.seat__coin-value').exists(), '节点都没有，自然不可能补 0').toBe(false);

    const explicitNull = mountSeat({ balance: null });
    expect(explicitNull.find('.seat__coin').exists(), '显式 null 与缺省同一条处置').toBe(false);
  });
});
