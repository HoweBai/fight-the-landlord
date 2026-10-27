/**
 * 玩法的**单一真源**（片③ spec §3/§4）。
 *
 * ⚠️ 为什么独立成模块：拆页之后**两个页面都要读它**（大厅列出全部、玩法页查选中的那个），
 * 而「同一个数组抄两份」正是本仓反复清掉的形态 —— 加第二个玩法时会只改一处、另一处悄悄过期。
 *
 * ⚠️ 现在**只有**斗地主一个条目，且**不得**为第二个玩法写任何实现/规则：
 * 「第二个玩法开工前才决定路径 A/B」是 roadmap §2.2 的逐字要求。
 * 结构上它是**列表容器**，加第二个玩法时只加数据、不改结构。
 *
 * ⚠️ **图标位是「按玩法查表」而不是一个 `$ftl-art-*` 令牌**（R747）：令牌是**单值**，
 * 装不下第二个玩法。`icon` 给了文件名就渲染 `<image>`、没给就走 CSS 兜底
 * —— 与 `Card.vue` 的 `manifest.json` 同一形态（查得到用图，查不到不白屏）。
 */
export interface GameMode {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  /** `static/ui/` 下的文件名；缺省 ⇒ 走 CSS 兜底（片③ 没有图标素材）。 */
  readonly icon?: string;
  /** 玩法规则介绍：info 图标点击后弹出的弹层正文；缺省 ⇒ 不渲染 info 图标。 */
  readonly description?: string;
}

/**
 * 玩法表（**字面量元组**）。
 *
 * ⚠️ **不得**给它加 `: readonly GameMode[]` 之类的**类型标注**（片③ Task 3 Step 0 的缺陷修复）：
 * 标注会把数组**拓宽**成 `readonly GameMode[]`、`as const` 随之被擦掉 ⇒
 * `(typeof GAME_MODES)[number]['id']` 退化成 `string` ⇒ **id 的联合类型全丢**：
 * `findMode` / `store.setActiveMode` 从此接受任意字符串，写错玩法 id 也照样过 `vue-tsc`
 * （`GameModeId` 与 `DEFAULT_MODE_ID` 都失去意义）。只留 `as const` 时它是字面量元组，
 * `GameModeId` = `'doudizhu'` 这个联合。
 * （`GameMode` 接口仍然保留：它是 `findMode` 的返回类型。）
 *
 * ⚠️ **`icon` 这个键必须显式写出来**（即使值是 `undefined`）：`as const` 的条目类型
 * **只含实际写出的键** ⇒ 省掉它之后 `lobby.vue` 的图标位（`m.icon`，R747）直接编译失败
 * （TS2339 `Property 'icon' does not exist`）。实测 `as const satisfies readonly GameMode[]`
 * **救不了** —— `satisfies` 不会把目标类型的可选键加进条目类型。
 * 显式写 `undefined` 正是「这一条没有图标素材」的如实声明。
 */
import { GAME_META, type GameType } from '@fight-the-landlord/protocol';

export const GAME_MODES = [
  {
    id: GAME_META.doudizhu.id,
    name: GAME_META.doudizhu.name,
    tagline: '三人一局，比谁先出完手牌',
    icon: undefined,
    description:
      '【基本规则】\n' +
      '三人一局，一人当地主（20 张），两人为农民（各 17 张）。地主先出牌，按逆时针依次轮流出牌，先出完牌的一方获胜。\n\n' +
      '【叫抢地主】\n' +
      '每局发 54 张牌：每人 17 张，剩余 3 张为底牌。\n' +
      '叫抢流程（一轮制）：\n' +
      '· 三家轮流「叫」或「不叫」，本轮首次声称者 = 首个声称者\n' +
      '· 若三家走完 3 次决策后 ≥2 人声称，则派发一次「反抢权」给首个声称者\n' +
      '· 反抢者可再次声称（地主易主），否则首个声称者当选\n' +
      '· 叫抢倍数每次声称无条件 ×2，上限 8（1 → 2 → 4 → 8）\n' +
      '· 三家全不抢 ⇒ 流局重发（最多 3 次）；第 3 次仍流局则随机指定一名地主\n\n' +
      '【牌型大小】\n' +
      '王炸（火箭）> 炸弹 > 2 > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3\n\n' +
      '【可出牌型】\n' +
      '· 单张：任意一张牌\n' +
      '· 对子：两张相同点数的牌\n' +
      '· 三张：三张相同点数的牌\n' +
      '· 三带一 / 三带二：三张 + 一张单 / 三张 + 一对\n' +
      '· 顺子：5 张及以上连续点数的单张（3→A，不含 2 和王）\n' +
      '· 连对：3 对及以上连续点数的对子\n' +
      '· 飞机：2 组及以上连续点数的三条\n' +
      '· 飞机带单 / 飞机带对：飞机 + 等数量单牌 / 等数量对子\n' +
      '· 四带二 / 四带两对：四张相同点数 + 2 张单 / 2 对\n' +
      '· 炸弹：四张相同点数的牌（可压除王炸外的任何牌型，自身之间比点数）\n' +
      '· 王炸（火箭）：大小王（唯一能压炸弹的牌型）\n\n' +
      '【胜负与结算】\n' +
      '· 地主先出完牌 ⇒ 地主胜，农民各输 unitScore\n' +
      '· 任一农民先出完 ⇒ 农民胜，地主输 2×unitScore\n' +
      '· unitScore = 底分 × 综合倍数\n' +
      '· 综合倍数 = 叫抢倍数 × 2^(局内炸弹数) × 春天倍数\n' +
      '· 春天：地主胜且两农民一手未出（×2）；反春：农民胜且地主恰好出过一手（×2）',
  },
  {
    id: GAME_META.paodekuai.id,
    name: GAME_META.paodekuai.name,
    tagline: '剩牌越少越赢',
    icon: undefined,
    description:
      '【基本规则】\n' +
      '两到四人一局（默认 3 人），每人 16 张牌。地主先出（地主由叫抢决定，流程同斗地主的一轮制叫抢）。\n' +
      '轮流出牌，先出完手牌者获胜。\n\n' +
      '【牌型大小】\n' +
      '大王 > 小王 > 2 > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3\n\n' +
      '【可出牌型】\n' +
      '跑得快的牌型由房间配置决定，常见牌型包括：\n' +
      '· 单张 / 对子 / 三张 / 三带一 / 三带二（后者部分房间禁用）\n' +
      '· 顺子：5 张及以上连续点数的单张（3→A，不含 2 和王）\n' +
      '· 连对：3 对及以上连续点数的对子\n' +
      '· 飞机（裸飞机）：部分房间禁用\n' +
      '· 飞机带翅膀：翅膀可带单或带对（由房间配置）\n' +
      '· 四带二 / 四带两对（后者部分房间禁用）\n' +
      '· 炸弹：四张相同点数的牌；王炸（火箭）：大小王\n\n' +
      '【胜负判定】\n' +
      '先出完手牌的玩家为本局第一名。有剩余牌的玩家按剩牌张数从小到大排出名次，剩牌越少名次越高。',
  },
] as const;

export type GameModeId = (typeof GAME_MODES)[number]['id'];

/** 缺省玩法（`GAME_MODES` 的第一条）—— 冷启动/换页后没写过 store 时用它。 */
export const DEFAULT_MODE_ID: GameModeId = GAME_MODES[0]!.id;

/**
 * **客户端 UI 已实现的牌桌人数**（不是规则能力 —— 规则能力在 protocol `GAME_META`）。
 * 与服务端 `games[id].supportedPlayerCounts` 取交集后才展示：服务端未开的 2/4 人
 * 不会出现在人数切换里。
 */
export const CLIENT_TABLE_PLAYER_COUNTS: Readonly<Record<GameType, readonly number[]>> = {
  doudizhu: [3],
  paodekuai: [2, 3, 4],
};

/** 按 id 查玩法；查不到返回 `undefined`（**不**编一个默认对象）。 */
export function findMode(id: string): GameMode | undefined {
  return GAME_MODES.find((m) => m.id === id);
}
