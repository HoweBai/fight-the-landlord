/**
 * ② 金币场 T6：**机器人水位派生**（规格 §6 逐字）的单测 —— C6 的单元级载体。
 *
 * ─── 测的是什么 ────────────────────────────────────────────────────────
 * `robotWaterLevels(botId, top)`：`sha256(botId)` 前 16 字节**大端四段** + `nudge`
 * （非整百修正）派生的三条水位（补给线 / 目标 / 回收线）。本文件四组判据：
 *  ① **已知向量**（用 `node:crypto` 独立复算 + 手写常量钉死）：抓字节序（大端）/ 偏移 /
 *     公式转写错误 —— `sha256('')` 与 `sha256('abc')` 是公开已知的摘要，逐段钉住；
 *  ② **nudge 触发用例**（raw ≡ 0 mod 100 ⇒ +1）：三条水位各挑一个真实 botId 钉死
 *     （**变异自证**：把 `nudge` 去掉 / 改成恒等 ⇒ 本组必红）；
 *  ③ **不变量**（200 个确定性伪随机 botId × 7 档 top，含小 top 边界 15/16）：
 *     `refillLine < target < recallLine`、三值整数且 `%100 ≠ 0`；
 *  ④ **默认 top=12000 区间** + 确定性（同 id 恒同值）。
 *
 * ─── 🔴 与规格 §6 的一处**数值勘误登记**（实施时实测）────────────────────
 * 规格 §6 写「默认 top=12000 时 refillLine∈[12300,12900]、target∈[13800,16296]、
 * recallLine∈[38640,52147]」——那是**理想实数**读数的记法。逐字公式在 IEEE754 下：
 *
 *   - `Math.floor(12000 * 1.025)` = **12299**（12000×1.025 = 12299.999999999998，向下取整差 1）
 *   - `Math.floor(12000 * 1.15)`  = **13799**（同理）
 *
 * ⇒ 真实可达区间（本文件用**穷举抽象域**独立求得，不是抽样）：
 *   refillLine ∈ [**12299**, 12899]、target ∈ [**13799**, 16295]、recallLine ∈ [38637, **52144**]。
 * 公式是**逐字**权威（设计 D6/用户 J10 已确认），本测试钉**公式的真实可达区间**；
 * 规格文本的标称数字偏差（-1/-3 级）已登记进 task-6-report（其精神 = 只钉性质、
 * 不把理想算术写进判据）。
 */

import { describe, expect, it } from 'vitest';
import {
  ROBOT_WATER_MIN_TOP,
  robotWaterLevels,
  sha256Uint32x4,
} from '../../src/currency/robot-funding';

/** 确定性伪随机 botId 语料（xorshift32；**不用 Math.random** —— 语料必须每次一致）。 */
function pseudoRandomBotIds(n: number): string[] {
  let s = 0x2545f491;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`bot-${next().toString(16).padStart(8, '0')}${next().toString(16).padStart(8, '0')}`);
  }
  return out;
}

const CORPUS = pseudoRandomBotIds(200);
/** 含小 top 边界 15/16 与主档位 12000 的扫描面。 */
const TOPS = [15, 16, 100, 150, 4800, 12000, 120000] as const;

describe('robotWaterLevels：sha256 大端切分（公开已知向量钉死）', () => {
  it("sha256('') 前 16 字节 = e3b0c442 98fc1c14 9afbf4c8 996fb924（大端四段）", () => {
    expect(sha256Uint32x4('')).toEqual([0xe3b0c442, 0x98fc1c14, 0x9afbf4c8, 0x996fb924]);
  });

  it("sha256('abc') 前 16 字节 = ba7816bf 8f01cfea 414140de 5dae2223", () => {
    expect(sha256Uint32x4('abc')).toEqual([0xba7816bf, 0x8f01cfea, 0x414140de, 0x5dae2223]);
  });
});

describe('robotWaterLevels：已知向量（独立复算后钉死 —— 公式/字节序/偏移的诊断锚）', () => {
  /**
   * 期望值由一份**独立转写**的脚本（`node:crypto` + 规格公式逐字）算出 ——
   * 与实现是两条转写路径，任何一处转录偏差都会在这里现形。
   */
  const vectors: Array<{
    botId: string;
    top: number;
    refillLine: number;
    target: number;
    recallLine: number;
  }> = [
    { botId: 'bot-00000000', top: 12000, refillLine: 12391, target: 15933, recallLine: 50689 },
    { botId: 'bot-t14check', top: 12000, refillLine: 12650, target: 15831, recallLine: 48498 },
    { botId: 'bot-deadbeef', top: 12000, refillLine: 12539, target: 16247, recallLine: 48644 },
    { botId: 'bot-abcdef01', top: 12000, refillLine: 12451, target: 15275, recallLine: 45192 },
    { botId: 'bot-00000000', top: 150, refillLine: 157, target: 227, recallLine: 684 },
    { botId: 'bot-t14check', top: 150, refillLine: 159, target: 207, recallLine: 590 },
    { botId: 'bot-00000000', top: 15, refillLine: 15, target: 52, recallLine: 159 },
    { botId: 'bot-t14check', top: 15, refillLine: 15, target: 55, recallLine: 172 },
  ];

  for (const { botId, top, refillLine, target, recallLine } of vectors) {
    it(`${botId} @ top=${top} ⇒ (${refillLine}, ${target}, ${recallLine})`, () => {
      expect(robotWaterLevels(botId, top)).toEqual({ refillLine, target, recallLine });
    });
  }
});

describe('robotWaterLevels：nudge（非整百修正）触发用例 —— 去掉 nudge 必红', () => {
  /**
   * 三条给的都是**真实 botId**，且 （去掉 nudge 后）raw 恰为 100 的倍数：
   *  - bot-0000000d @12000：raw refill = 12800 ⇒ nudge ⇒ **12801**；
   *  - bot-00000082 @12000：raw target = 15600 ⇒ nudge ⇒ **15601**；
   *  - bot-000000b4 @12000：raw recall = 46500 ⇒ nudge ⇒ **46501**。
   * 期望值 = 独立脚本复算（含 nudge 逐字）。
   */
  it('refillLine：raw=12800（整百）⇒ 12801', () => {
    expect(robotWaterLevels('bot-0000000d', 12000)).toEqual({
      refillLine: 12801,
      target: 14873,
      recallLine: 46285,
    });
  });

  it('target：raw=15600（整百）⇒ 15601', () => {
    expect(robotWaterLevels('bot-00000082', 12000)).toEqual({
      refillLine: 12426,
      target: 15601,
      recallLine: 46478,
    });
  });

  it('recallLine：raw=46500（整百）⇒ 46501', () => {
    expect(robotWaterLevels('bot-000000b4', 12000)).toEqual({
      refillLine: 12780,
      target: 15855,
      recallLine: 46501,
    });
  });

  it('nudge 的**判别力**：这三个 id 的三条水位都不是整百（若 nudge 是恒等函数，上面三条即红）', () => {
    for (const [botId, top] of [
      ['bot-0000000d', 12000],
      ['bot-00000082', 12000],
      ['bot-000000b4', 12000],
    ] as const) {
      const { refillLine, target, recallLine } = robotWaterLevels(botId, top);
      for (const v of [refillLine, target, recallLine]) expect(v % 100).not.toBe(0);
    }
  });
});

describe('robotWaterLevels：不变量（200 个确定性伪随机 botId × 7 档 top）', () => {
  it('任意 top ≥ 15：三值皆为整数、refillLine < target < recallLine、三值 %100 ≠ 0', () => {
    for (const botId of CORPUS) {
      for (const top of TOPS) {
        const { refillLine, target, recallLine } = robotWaterLevels(botId, top);
        const tag = `${botId} @ top=${top}`;
        expect(Number.isInteger(refillLine), `${tag} refillLine 必须是整数`).toBe(true);
        expect(Number.isInteger(target), `${tag} target 必须是整数`).toBe(true);
        expect(Number.isInteger(recallLine), `${tag} recallLine 必须是整数`).toBe(true);
        expect(refillLine, `${tag}：refillLine < target`).toBeLessThan(target);
        expect(target, `${tag}：target < recallLine`).toBeLessThan(recallLine);
        expect(refillLine % 100, `${tag}：refillLine 不得是整百`).not.toBe(0);
        expect(target % 100, `${tag}：target 不得是整百`).not.toBe(0);
        expect(recallLine % 100, `${tag}：recallLine 不得是整百`).not.toBe(0);
      }
    }
  });

  it('top 下界的口径（ROBOT_WATER_MIN_TOP = 15）：top=15 时 refillLine 恒 15（h1 % 1 = 0，只剩底数）', () => {
    expect(ROBOT_WATER_MIN_TOP).toBe(15);
    for (const botId of CORPUS) {
      expect(robotWaterLevels(botId, 15).refillLine, botId).toBe(15);
    }
  });

  /**
   * 默认 top=12000 的可达区间（穷举抽象域求得 —— 见文件头「数值勘误登记」；
   * 规格标称 [12300,12900]/[13800,16296]/[38640,52147] 与逐字公式在 IEEE754 下的
   * 真实区间有 1..3 的漂移）。
   */
  it('默认 top=12000：refillLine∈[12299,12899]、target∈[13799,16295]、recallLine∈[38637,52144]', () => {
    for (const botId of CORPUS) {
      const { refillLine, target, recallLine } = robotWaterLevels(botId, 12000);
      expect(refillLine, botId).toBeGreaterThanOrEqual(12299);
      expect(refillLine, botId).toBeLessThanOrEqual(12899);
      expect(target, botId).toBeGreaterThanOrEqual(13799);
      expect(target, botId).toBeLessThanOrEqual(16295);
      expect(recallLine, botId).toBeGreaterThanOrEqual(38637);
      expect(recallLine, botId).toBeLessThanOrEqual(52144);
    }
  });
});

describe('robotWaterLevels：确定性（重启 / 多实例一致 —— 幂等锚的根基）', () => {
  it('同 botId 同 top 永恒同值（重复调用零漂移）', () => {
    for (const botId of CORPUS.slice(0, 20)) {
      expect(robotWaterLevels(botId, 12000)).toEqual(robotWaterLevels(botId, 12000));
    }
  });

  it('不同 botId 派生不同水位（语料内几乎无碰撞 —— 防「常量函数」假形态）', () => {
    const uniq = new Set(CORPUS.map((id) => JSON.stringify(robotWaterLevels(id, 12000))));
    expect(uniq.size).toBeGreaterThan(150);
  });
});
