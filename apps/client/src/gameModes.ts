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
  },
  {
    id: GAME_META.paodekuai.id,
    name: GAME_META.paodekuai.name,
    tagline: '剩牌越少越赢',
    icon: undefined,
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
