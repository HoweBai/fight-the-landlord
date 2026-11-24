/**
 * 客户端玩法介绍：配置中立段落 + 默认 fallback。
 * `buildMahjongRuleSummary`（Task 5）在有配置时用动态段替换默认计分段。
 */

export const MAHJONG_BASE_SUMMARY =
  '【基本规则】\n' +
  '· 4 人，108 张（万/筒/条 1–9 各 4 张），不能吃，只能碰/杠\n' +
  '· 每家 13 张；换三张（可配）→ 定缺 → 庄家摸第 14 张\n' +
  '· 定缺后必须先打完缺门牌；手里有缺门牌不能胡\n\n' +
  '【血战到底】\n' +
  '· 一家胡牌后不离场，剩余玩家继续，直到 3 家胡或牌墙摸空\n' +
  '· 已胡者不再参与后续任何支付/收取；已胡手牌公开\n' +
  '· 点炮者付；自摸其余未胡每家付；一炮多响每个赢家分别收\n' +
  '· 胡 > 杠 > 碰 > 摸牌；最后 4 张与过水规则按房间设置\n\n' +
  '【刮风下雨】\n' +
  '· 直杠/补杠/暗杠的杠分按房间设置结算\n' +
  '· 杠上炮：本次杠分按房间设置处理；抢杠只抢补杠\n' +
  '· 荒庄：花猪 / 查大叫 / 退税按规则配置结算';

export const MAHJONG_DEFAULT_SCORING =
  '【计分】\n' +
  '· 默认口径，实际以房间设置为准\n' +
  '· 默认成都口径：平胡 1 番（×1），每 +1 番翻倍，默认封顶 6 番（32×）\n' +
  '· 主番：平胡/对对胡/清一色/带幺九/七对/清对/将对/龙七对/清七对/清幺九/清龙七对\n' +
  '· 另加：杠上花/杠上炮/抢杠胡/金钩钓/根/自摸；具体番值全部可配置\n' +
  '· 默认流程：最后 4 张能胡必胡；过水同张或加番可胡；换三张开启；直杠仅点杠者付 2×底；补杠其余未胡每家 1×底；暗杠其余未胡每家 2×底';

export const MAHJONG_TIMEOUT_SECTION =
  '【超时与托管】\n' +
  '· 换三张/定缺超时自动选；响应窗口超时=过；最后 4 张的处理按房间设置\n' +
  '· 超时、托管、机器人共用同一套自动决策';

export const MAHJONG_RULE_SUMMARY = [
  MAHJONG_BASE_SUMMARY,
  MAHJONG_DEFAULT_SCORING,
  MAHJONG_TIMEOUT_SECTION,
].join('\n\n');

import {
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
} from './rules';
import { MAHJONG_FAN_INFO, type MahjongFanInfo } from './fan-info';
import type { MahjongRulesClientView } from './client-view';

function labelOf(key: string): string {
  return MAHJONG_FAN_INFO[key]?.label ?? key;
}

function multiplierOf(fan: number, rules: MahjongRulesClientView): number {
  return 2 ** Math.max(0, Math.min(fan, rules.fanCap) - rules.fanBase);
}

function noteText(info: MahjongFanInfo): string {
  const parts = [info.desc];
  if (info.example) parts.push(`例：${info.example}`);
  if (info.playerCaveat) parts.push(`⚠ ${info.playerCaveat}`);
  return parts.join(' ');
}

function mainLine(key: string, info: MahjongFanInfo, value: number, rules: MahjongRulesClientView): string {
  const mult = multiplierOf(value, rules);
  const head = value > rules.fanCap
    ? `${labelOf(key)} 表值 ${value} 番 / 封顶后 ×${mult}`
    : `${labelOf(key)} ${value} 番（×${mult}）`;
  return `· ${head}：${noteText(info)}`;
}

function addonLine(key: string, info: MahjongFanInfo, value: number): string {
  return `· ${labelOf(key)} +${value} 番：${noteText(info)}`;
}

function selfDrawText(rules: MahjongRulesClientView): string {
  switch (rules.selfDrawMode) {
    case 'addFan': {
      const v = rules.fanTable.ziMo ?? 0;
      return v > 0 ? `番 +${v}` : '番 +0（命名番表“自摸”项未配置）';
    }
    case 'none':
      return '无加成';
    default:
      return '每家多付 1×底';
  }
}

function directionText(dir: MahjongRulesClientView['exchangeDirection']): string {
  switch (dir) {
    case 'clockwise': return '顺时针';
    case 'counterclockwise': return '逆时针';
    case 'opposite': return '对家';
    default: return '随机';
  }
}

function passHuText(mode: MahjongRulesClientView['passHuMode']): string {
  switch (mode) {
    case 'sameTile': return '同张不可再胡';
    case 'sameTileOrHigherFan': return '同张或加番可胡';
    default: return '不限制';
  }
}

function transferText(mode: MahjongRulesClientView['gangTransfer']): string {
  switch (mode) {
    case 'toEachWinner': return '转给每个赢家';
    case 'split': return '均分（余数按座位升序）';
    default: return '退回原付款人';
  }
}

function huazhuText(mode: MahjongRulesClientView['huazhuMode']): string {
  switch (mode) {
    case 'burn48': return '销毁 48×底';
    case 'off': return '不罚';
    default: return '按当前配置赔给未胡玩家（封顶分）';
  }
}

function buildScoringSection(rules: MahjongRulesClientView): string {
  const lines: string[] = [];
  lines.push(
    `计分方式：${rules.scoringPolicy === 'named' ? '命名番表' : '加法番表'}；` +
    `底番 ${rules.fanBase}；封顶 ${rules.fanCap} 番（×${multiplierOf(rules.fanCap, rules)}）；` +
    `自摸：${selfDrawText(rules)}`,
  );
  if (rules.minFanToHu > rules.fanCap) {
    lines.push('⚠ 起胡番高于封顶番：当前配置无法胡牌。');
  }

  if (rules.scoringPolicy === 'named') {
    const reserved: string[] = [];
    let enabledCount = 0;
    const consider = (key: string, info: MahjongFanInfo, value: number): void => {
      if (value <= 0) return;
      if (!info.wired) {
        reserved.push(labelOf(key));
        return;
      }
      enabledCount += 1;
      lines.push(
        info.kind === 'namedAddon' || info.kind === 'optionalAddon'
          ? addonLine(key, info, value)
          : mainLine(key, info, value, rules),
      );
    };

    for (const key of MAHJONG_NAMED_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      if (info.kind === 'namedMain') consider(key, info, rules.fanTable[key] ?? 0);
    }
    for (const key of MAHJONG_NAMED_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      if (info.kind === 'namedAddon' && key !== 'ziMo') {
        consider(key, info, rules.fanTable[key] ?? 0);
      }
    }
    for (const key of MAHJONG_OPTIONAL_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      if (info.kind === 'optionalMain' || info.kind === 'optionalAddon') {
        consider(key, info, rules.optionalFans[key] ?? 0);
      }
    }

    if ((rules.fanTable.pingHu ?? 0) === 0) {
      lines.push('· 平胡：表值为 0，但引擎仍按兜底 1 番处理。');
    }

    const disabled: string[] = [];
    for (const key of MAHJONG_NAMED_FAN_KEYS) {
      if (key === 'ziMo' || key === 'pingHu') continue;
      if ((rules.fanTable[key] ?? 0) === 0) disabled.push(labelOf(key));
    }
    for (const key of MAHJONG_OPTIONAL_FAN_KEYS) {
      if ((rules.optionalFans[key] ?? 0) === 0) disabled.push(labelOf(key));
    }
    if (disabled.length > 0) lines.push(`· 未启用：${disabled.join('、')}`);
    if (enabledCount === 0) {
      lines.push('· 当前未配置任何番型；平胡按兜底 1 番结算。');
    }
    if (reserved.length > 0) {
      lines.push(`· 预留未启用：${reserved.join('、')}（当前版本不会触发）`);
    }
  } else {
    let enabledCount = 0;
    for (const key of MAHJONG_ADDITIVE_FAN_KEYS) {
      const info = MAHJONG_FAN_INFO[key]!;
      const value = rules.additiveFanTable[key] ?? 0;
      if (value > 0) {
        enabledCount += 1;
        lines.push(addonLine(key, info, value));
      }
    }
    if (enabledCount === 0) {
      lines.push('· 当前未配置任何加法番型，只按底分结算。');
    }
    lines.push(
      `· 各项相加后按封顶 ${rules.fanCap} 番（×${multiplierOf(rules.fanCap, rules)}）结算。`,
    );
    lines.push('· 加法口径不使用可选番。');
  }

  return ['【番型与倍率】', ...lines].join('\n');
}

function buildFlowSection(rules: MahjongRulesClientView): string {
  const lines = [
    `· 换三张：${rules.exchangeThreeEnabled ? `开（方向：${directionText(rules.exchangeDirection)}）` : '关'}`,
    '· 定缺：必选',
    `· 最后 4 张：${rules.lastFourForcedHu ? '能胡必胡' : '可过'}`,
    `· 过水：${passHuText(rules.passHuMode)}`,
    `· 直杠：${rules.directGangMode === 'contract' ? '仅点杠者付 2×底' : '家家有（点杠者 2×底 + 其余未胡每家 1×底）'}`,
    `· 杠分转移：${transferText(rules.gangTransfer)}`,
    `· 花猪：${huazhuText(rules.huazhuMode)}`,
    `· 查叫：${rules.chajiaoEnabled ? '开' : '关'}`,
    `· 自摸：${selfDrawText(rules)}`,
  ];
  return ['【当前流程设置】', ...lines].join('\n');
}

export function buildMahjongRuleSummary(rules?: MahjongRulesClientView): string {
  if (!rules) return MAHJONG_RULE_SUMMARY;
  return [
    MAHJONG_BASE_SUMMARY,
    buildScoringSection(rules),
    buildFlowSection(rules),
    MAHJONG_TIMEOUT_SECTION,
  ].join('\n\n');
}
