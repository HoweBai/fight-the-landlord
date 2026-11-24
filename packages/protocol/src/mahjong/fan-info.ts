export type MahjongFanKind =
  | 'namedMain'
  | 'namedAddon'
  | 'additive'
  | 'optionalMain'
  | 'optionalAddon';

export interface MahjongFanInfo {
  label: string;
  kind: MahjongFanKind;
  desc: string;
  example?: string;
  playerCaveat?: string;
  adminOnly?: string;
  wired: boolean;
}

const FAN_INFO: Record<string, MahjongFanInfo> = {
  // 命名番表：主番候选
  pingHu: {
    label: '平胡', kind: 'namedMain', wired: true,
    desc: '任意合法胡牌型；不是其他主番时的兜底。',
    example: '1-2-3万 4-5-6万 7-8-9筒 3-4-5条 9-9条',
    playerCaveat: '即使番值配成 0，引擎仍按兜底 1 番处理。',
  },
  duiDuiHu: {
    label: '对对胡', kind: 'namedMain', wired: true,
    desc: '4 副刻子/杠 + 将，没有顺子。',
    example: '1-1-1万 5-5-5筒 8-8-8条 2-2-2-2万(杠) 9-9条',
    playerCaveat: '与七对互斥（七对不按对对胡算）。',
  },
  qingYiSe: {
    label: '清一色', kind: 'namedMain', wired: true,
    desc: '全部牌为同一花色（万/筒/条），含副露。',
    example: '1-2-3万 4-5-6万 7-8-9万 2-3-4万 5-5万',
    playerCaveat: '与对对胡/七对等组合时，按更高的组合主番结算，不叠加。',
  },
  daiYaoJiu: {
    label: '带幺九', kind: 'namedMain', wired: true,
    desc: '每副面子都含 1 或 9，且将牌为 1/9；七对形态则每张都是 1/9。',
    example: '1-2-3万 7-8-9万 1-1-1筒 9-9-9筒 9-9万',
    playerCaveat: '七对形态按“全部牌为 1/9”判定。',
  },
  qiDui: {
    label: '七对', kind: 'namedMain', wired: true,
    desc: '14 张手牌组成 7 个对子，四张相同算两对。',
    example: '1-1万 2-2万 3-3万 5-5筒 7-7筒 9-9条 4-4条',
    playerCaveat: '七对要求无副露（不能有碰/杠）。',
  },
  qingDui: {
    label: '清对', kind: 'namedMain', wired: true,
    desc: '清一色 + 对对胡。',
    example: '1-1-1万 3-3-3万 5-5-5万 7-7-7万 9-9万',
    playerCaveat: '取代清一色/对对胡，不叠加。',
  },
  jiangDui: {
    label: '将对', kind: 'namedMain', wired: true,
    desc: '对对胡且全部牌点数为 2/5/8。',
    example: '2-2-2万 5-5-5筒 8-8-8条 2-2-2-2筒(杠) 5-5条',
    playerCaveat: '全部牌（含副露）都须是 2/5/8，将牌也是。',
  },
  longQiDui: {
    label: '龙七对', kind: 'namedMain', wired: true,
    desc: '七对中含至少 1 组未杠的四张（四张算两对）。',
    example: '1-1万 2-2万 3-3万 5-5-5-5筒 7-7条 9-9条',
    playerCaveat: '该定义四张不再计“根”。',
  },
  qingQiDui: {
    label: '清七对', kind: 'namedMain', wired: true,
    desc: '清一色 + 七对。',
    example: '1-1万 2-2万 3-3万 5-5万 7-7万 8-8万 9-9万',
    playerCaveat: '取代清一色/七对，不叠加。',
  },
  qingYaoJiu: {
    label: '清幺九', kind: 'namedMain', wired: true,
    desc: '清一色 + 带幺九。',
    example: '1-2-3万 1-2-3万 7-8-9万 7-8-9万 1-1万',
    playerCaveat: '取代清一色/带幺九，不叠加。',
  },
  qingLongQiDui: {
    label: '清龙七对', kind: 'namedMain', wired: true,
    desc: '清一色 + 龙七对（含至少 1 组未杠四张）。',
    example: '1-1万 2-2万 3-3万 5-5-5-5万 7-7万 9-9万',
    playerCaveat: '取代清一色/七对/龙七对；定义四张不计根。',
  },

  // 命名番表：另加番
  gangShangHua: {
    label: '杠上花', kind: 'namedAddon', wired: true,
    desc: '杠后补牌自摸胡。',
    example: '任意杠 → 补牌成胡（如暗杠 5-5-5-5筒 后补到 9条 自摸）',
    playerCaveat: '按自摸收付；加番后仍受封顶限制。',
  },
  gangShangPao: {
    label: '杠上炮', kind: 'namedAddon', wired: true,
    desc: '杠后打出的牌被别人点炮胡。',
    example: 'A 杠后打出 3万，B 用 3万 胡',
    playerCaveat: '胡家加番；杠分按“杠分转移”配置处理。',
  },
  qiangGangHu: {
    label: '抢杠胡', kind: 'namedAddon', wired: true,
    desc: '抢别人补杠（弯杠）的牌胡。',
    example: 'A 碰 5筒 后补杠第 4 张 5筒，B 用 5筒 胡',
    playerCaveat: '只能抢补杠，暗杠不可抢；被抢则杠无效、杠分退回。',
  },
  jinGouDiao: {
    label: '金钩钓', kind: 'namedAddon', wired: true,
    desc: '对对胡形态且单吊：胡牌张作将。',
    example: '1-1-1万 5-5-5筒 8-8-8条 9-9-9万 + 单吊 3条',
    playerCaveat: '加在已成立的主番上（通常为对对胡），不是独立主番。',
  },
  gen: {
    label: '根', kind: 'namedAddon', wired: true,
    desc: '四张相同且未杠，每组计一份。',
    example: '手里 5-5-5-5筒 未杠 ⇒ 计 1 组根',
    playerCaveat: '龙七对/清龙七对的定义四张不计根；“根包含杠”开启时副露杠也计根。',
  },
  ziMo: {
    label: '自摸', kind: 'namedAddon', wired: true,
    desc: '自摸时按本值加番。',
    example: '自摸胡牌 ⇒ 按本值加番',
    playerCaveat: '仅“自摸加成 = 番+1”时读取本值；每家多付 1×底/无加成两种模式不读。',
  },

  // 加法番表（SBR）
  root: {
    label: '根（每组）', kind: 'additive', wired: true,
    desc: '每组未杠四张加一份；“根包含杠”开启时副露杠也计。',
    example: '2 组未杠四张 ⇒ 计 2 份',
    playerCaveat: '仅加法番表口径生效。',
  },
  allPungs: {
    label: '碰碰胡', kind: 'additive', wired: true,
    desc: '碰碰胡（4 副刻子/杠 + 将）时加一份。',
    example: '1-1-1万 5-5-5筒 8-8-8条 2-2-2-2万(杠) 9-9条',
    playerCaveat: '仅加法番表口径生效。',
  },
  goldenWait: {
    label: '金钩钓', kind: 'additive', wired: true,
    desc: '金钩钓（对对胡且单吊）时加一份。',
    example: '四副刻子/杠已成型，单吊将牌胡出',
    playerCaveat: '仅加法番表口径生效。',
  },
  fullFlush: {
    label: '清一色', kind: 'additive', wired: true,
    desc: '清一色时加一份。',
    example: '1-2-3万 4-5-6万 7-8-9万 2-3-4万 5-5万',
    playerCaveat: '仅加法番表口径生效。',
  },
  sevenPairs: {
    label: '七对', kind: 'additive', wired: true,
    desc: '七对时加一份。',
    example: '1-1万 2-2万 3-3万 5-5筒 7-7筒 9-9条 4-4条',
    playerCaveat: '仅加法番表口径生效。',
  },
  winAfterKong: {
    label: '杠上花', kind: 'additive', wired: true,
    desc: '杠上花（杠后补牌自摸）时加一份。',
    example: '杠后补牌自摸',
    playerCaveat: '仅加法番表口径生效。',
  },
  shootAfterKong: {
    label: '杠上炮', kind: 'additive', wired: true,
    desc: '杠上炮（杠后打出的牌被胡）时加一份。',
    example: '杠后打出的牌被点炮胡',
    playerCaveat: '仅加法番表口径生效。',
  },
  robbingKong: {
    label: '抢杠胡', kind: 'additive', wired: true,
    desc: '抢杠胡时加一份。',
    example: '抢补杠胡',
    playerCaveat: '仅加法番表口径生效。',
  },
  underTheSea: {
    label: '海底', kind: 'additive', wired: true,
    desc: '海底（牌墙摸空后的最后一张牌成胡）时加一份。',
    example: '牌墙余 0 时胡最后一张',
    playerCaveat: '仅加法番表口径生效；与可选番“海底”同一判定，按当前计分方式只读其中一张表。',
  },

  // 可选番
  duanYaoJiu: {
    label: '断幺九', kind: 'optionalAddon', wired: true,
    desc: '胡牌时全部牌（含副露）没有 1/9，加一份。',
    example: '2-3-4万 5-6-7万 3-4-5筒 6-7-8筒 5-5筒',
    playerCaveat: '仅命名番表口径生效；含任意 1/9 即不成立。',
  },
  haiDi: {
    label: '海底', kind: 'optionalAddon', wired: true,
    desc: '海底：牌墙摸空后的最后一张牌成胡（自摸或点炮）时加一份。',
    example: '牌墙余 0 时胡最后一张',
    playerCaveat: '仅命名番表口径生效；与加法表 underTheSea 同一判定，按当前计分方式只读其中一张表。',
  },
  perGang: {
    label: '每杠', kind: 'optionalAddon', wired: true,
    desc: '每个副露杠加一份（明杠/补杠/暗杠都算）。',
    example: '2 个杠 ⇒ 计 2 份',
    playerCaveat: '仅命名番表口径生效；杠分（刮风下雨）另算，与本番叠加。',
  },
  shuangLong: {
    label: '双龙七对', kind: 'optionalMain', wired: true,
    desc: '主番候选：七对且含至少 2 组未杠四张。',
    example: '1-1万 2-2万 3-3-3-3筒 5-5-5-5条 7-7万',
    playerCaveat: '与其他主番取最高，不是另加番；这些四张仍计入根。',
  },
  sanLong: {
    label: '三龙七对', kind: 'optionalMain', wired: true,
    desc: '主番候选：七对且含至少 3 组未杠四张。',
    example: '1-1万 2-2-2-2万 3-3-3-3筒 5-5-5-5条',
    playerCaveat: '与其他主番取最高，不是另加番；这些四张仍计入根。',
  },
  shiBaLuoHan: {
    label: '十八罗汉', kind: 'optionalMain', wired: true,
    desc: '主番候选：对对胡且至少 4 个副露杠。',
    example: '4 个杠 + 将牌',
    playerCaveat: '按副露杠数判定；手牌未杠四张不算。',
  },
  tianHu: {
    label: '天胡', kind: 'optionalMain', wired: false,
    desc: '主番候选：天胡（庄家开局即胡）。',
    example: '庄家发牌后未出牌即成胡',
    playerCaveat: '当前版本预留未启用。',
    adminOnly: '计分侧已有分支（scoring.ts），但 huContext() 从未置位；配置开启也不会触发。',
  },
  diHu: {
    label: '地胡', kind: 'optionalMain', wired: false,
    desc: '主番候选：地胡（闲家首巡即胡）。',
    example: '闲家首巡成胡',
    playerCaveat: '当前版本预留未启用。',
    adminOnly: '计分侧已有分支（scoring.ts），但 huContext() 从未置位；地胡定义（首摸/首打被胡）尚未裁决。',
  },
};

export const MAHJONG_FAN_INFO: Readonly<Record<string, MahjongFanInfo>> =
  Object.freeze(FAN_INFO);
