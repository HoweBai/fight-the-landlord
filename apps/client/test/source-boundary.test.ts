/**
 * 契约行为断言 ④⑤：依赖边界与「不得含规则」。
 *
 * 这两条不是风格偏好，是 docs/design.md §12 的 FORBIDDEN 清单：
 *  - F01/F02/F10：客户端不得有任何牌型判定/强度比较/倍数计算
 *  - M09：前端**禁止包含任何游戏规则常量**（如底分、倍数），配置由服务端下发
 *
 * 实现方式：对 `src/**` 做静态扫描。扫描是「机械的」——
 * 它不判断语义，只判断「这些标识符/字面量是否出现」，因此不会误报成风格检查。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, readAllSources, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
/**
 * R572/R622：**违规类**断言一律读这个视图（剥注释）；**存在性**断言（「扫描器确实读到了文件」）
 * 仍读 `sources`（原始文本）—— 那个断言问的是「文件读到没有」，不是「有没有违规」。
 */
const codeSources = sources.map((f) => ({ path: f.path, content: stripComments(f.content) }));

describe('④ 依赖边界：只允许 protocol', () => {
  it('源码中没有任何 @fight-the-landlord/shared 的引用', () => {
    const offenders: string[] = [];
    for (const file of codeSources) {
      if (/@fight-the-landlord\/shared/.test(file.content)) offenders.push(file.path);
    }
    expect(offenders, `不得 import shared（会把游戏规则带进前端）：${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('源码引用的 @fight-the-landlord/* 只有 protocol', () => {
    const referenced = new Set<string>();
    for (const file of codeSources) {
      for (const m of file.content.matchAll(/@fight-the-landlord\/[a-z-]+/g)) referenced.add(m[0]);
    }
    expect([...referenced].sort()).toEqual(['@fight-the-landlord/protocol']);
  });

  it('源码的 import/require 目标只能是 protocol 或包内相对路径', () => {
    // 只检查**真正的依赖语句**：注释里提到别的包名是允许的（那是文档，不是依赖）
    const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const forbidden = [
      'game-service',
      'room-service',
      'user-service',
      'api-gateway',
      'robot-service',
      'tools/mock-server',
      'packages/shared',
      '@fight-the-landlord/shared',
    ];
    const offenders: string[] = [];
    const bareImports = new Set<string>();

    for (const file of codeSources) {
      for (const m of file.content.matchAll(importRe)) {
        const target = m[1]!;
        for (const token of forbidden) {
          if (target.includes(token)) offenders.push(`${file.path} → ${target}`);
        }
        if (!target.startsWith('.') && !target.startsWith('@fight-the-landlord/protocol')) {
          bareImports.add(target);
        }
      }
    }

    expect(offenders, `源码引用了禁止的模块：\n${offenders.join('\n')}`).toEqual([]);
    expect([...bareImports].sort()).toEqual(['pinia', 'socket.io-client', 'vue']);
  });
});

describe('⑤ 不得含游戏规则（§12.2 F01/F02/F10 + M09）', () => {
  it('没有牌型判定 / 强度比较 / 倍数计算相关的标识符', () => {
    // 这些名字是「规则引擎」的典型入口。前端出现任何一个都说明规则被搬进来了。
    // ⚠️ 2026-10-12 裁决（项 ⑤ 出牌提示）：`parseHand` / `canBeat` / `HandType`
    //    **不再是禁词**——客户端可从 `@fight-the-landlord/protocol` 导入它们做提示；
    //    2026-10-22 U5-4 起同一组函数也可用于**音效选择**（牌型播报），仍只做选择；
    //    但**禁本地同名实现**（见下方「禁本地定义」用例）。
    const bannedIdentifiers = [
      'isValidHand',
      'isValidPlay',
      'checkRule',
      'checkHand',
      'findBeating',
      'findBeatingHand',
      'compareHand',
      'calculateWin',
      'calculateMultiplier',
      'computeMultiplier',
      'computeSpring',
      'isBomb',
      'isRocket',
      'isStraight',
      'isPair',
      'isTriple',
    ];
    const offenders: string[] = [];
    for (const file of codeSources) {
      for (const id of bannedIdentifiers) {
        if (new RegExp(`\\b${id}\\b`).test(file.content)) offenders.push(`${file.path}: ${id}`);
      }
    }
    expect(offenders, `源码中出现规则标识符：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('parseHand / canBeat / HandType 只能从 @fight-the-landlord/protocol 导入，不得本地实现', () => {
    // 允许形态：`import { parseHand } from '@fight-the-landlord/protocol'` / `type { HandType }`。
    // 禁止形态：`function parseHand` / `const parseHand =` / `class HandType` / `enum HandType`
    // （即任何把这三个名字**定义**出来的写法）。
    const ruleNames = ['parseHand', 'canBeat', 'HandType'];
    const defRegex = new RegExp(
      `\\b(?:function|const|let|var|class|enum|type|interface)\\s+(${ruleNames.join('|')})\\b`,
    );
    const offenders: string[] = [];
    for (const file of codeSources) {
      // 导入 protocol 的放行：整行是 import 语句且来源是 protocol
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (defRegex.test(line)) {
          offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `本地定义了规则函数（必须从 protocol 导入）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('没有底分常量（baseScore 只能作为服务端下发的字段名出现，不得是字面量）', () => {
    const offenders: string[] = [];
    for (const file of codeSources) {
      // `const baseScore = 15` / `baseScore: 15` / `BASE_SCORE = 15` 这类赋值即违规
      for (const m of file.content.matchAll(/\b(?:const|let|var)\s+\w*(?:base|unit)?score\w*\s*=\s*[\d_]+/gi)) {
        offenders.push(`${file.path}: ${m[0]}`);
      }
      for (const m of file.content.matchAll(/\b(?:BASE_?SCORE|BASE_SCORE|DEFAULT_SCORE)\b\s*[:=]\s*[\d_]+/g)) {
        offenders.push(`${file.path}: ${m[0]}`);
      }
    }
    expect(offenders, `出现底分字面量（M09 禁止）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('没有人写点数映射（必须用 protocol 的 toDisplay）', () => {
    const offenders: string[] = [];
    for (const file of codeSources) {
      // R572：不再需要「这行是不是注释」的行内猜测 —— 剥注释已经把注释移出视野
      for (const m of file.content.matchAll(/['"](?:大王|小王)['"]/g)) {
        // 固定轮 M5：诊断信息回到**行级**细节（剥注释后这行就是代码行，不再需要「猜注释」）
        const idx = m.index ?? 0;
        const lineStart = file.content.lastIndexOf('\n', idx) + 1;
        const lineEnd = file.content.indexOf('\n', idx);
        offenders.push(
          `${file.path}: ${file.content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()}`,
        );
      }
    }
    expect(offenders, `自制牌面映射（应使用 protocol.toDisplay）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('不得使用 socket 之外的应用层心跳（§6.1 只用 socket.io 内置心跳）', () => {
    const offenders: string[] = [];
    for (const file of codeSources) {
      if (/emit\(\s*['"](?:ping|pong)['"]/.test(file.content)) offenders.push(file.path);
    }
    expect(offenders, `出现应用层 ping/pong：${offenders.join(', ')}`).toEqual([]);
  });

  it('扫描器本身确实读到了文件（防止「因为读不到文件而永远通过」）', () => {
    // R622：**存在性**断言故意读 `sources`（原始文本）—— 它问的是「文件读到没有」，
    // 不是「有没有违规」；剥注释视图在这里没有意义（反而会让「文件被读到」这件事失真）。
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.map((f) => f.path)).toContain('src/net/socket.ts');
    /**
     * R179/R193③：闸必须**自带探针判别力** —— 新增的源码文件若没被扫到，
     * 前面两条断言会「恒绿」。切片 10 新增的结算组件必须在扫描集合里。
     */
    expect(sources.map((f) => f.path)).toContain('src/components/Settlement.vue');
    expect(readAllSources()).toContain('toDisplay');
  });
});

describe('R572 正对照：剥注释不得把真违规一起剥掉', () => {
  /** 合成样本：真违规 + 解释它的注释（本仓注释习惯的真实形态）。 */
  const synthetic = [
    {
      path: 'src/fake-shared.ts',
      content: `// 反例：不得 import '@fight-the-landlord/shared'\nimport { x } from '@fight-the-landlord/shared';`,
    },
    {
      path: 'src/fake-svc.ts',
      content: `// 反例：require('room-service')\nconst h = require('room-service');`,
    },
    {
      path: 'src/fake-rule.ts',
      content: `// 反例：前端不得出现 HandType\nconst t = HandType.Single;`,
    },
    {
      path: 'src/fake-score.ts',
      content: `// 反例：M09 禁止底分字面量\nconst baseScore = 15;`,
    },
    {
      path: 'src/fake-ping.ts',
      content: `// 反例：§6.1 不得有应用层心跳\nsocket.emit('ping');`,
    },
    {
      path: 'src/fake-import.ts',
      content: `// 说明：这里解释为什么不能引用别的包\nimport { y } from 'room-service';`,
    },
  ];

  it('① 注释里提到 shared ⇒ 放行；真 import ⇒ 报出', () => {
    const offenders = synthetic
      .map((f) => ({ ...f, code: stripComments(f.content) }))
      .filter((f) => /@fight-the-landlord\/shared/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual(['src/fake-shared.ts']); // ⚠️ 注释那行不算，真 import 那行算
  });

  it('② 只能引用 protocol：注释里提别的包名 ⇒ 不计入裸依赖集合', () => {
    const referenced = new Set<string>();
    for (const f of synthetic) {
      for (const m of stripComments(f.content).matchAll(/@fight-the-landlord\/[a-z-]+/g)) {
        referenced.add(m[0]);
      }
    }
    expect([...referenced].sort()).toEqual(['@fight-the-landlord/shared']);
  });

  it('③ import/require 目标扫描：真 require(\'room-service\') 必须报出', () => {
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const hit = synthetic
      .flatMap((f) => [...stripComments(f.content).matchAll(re)].map((m) => m[1]!))
      .filter((t) => t.includes('room-service'));
    // ⚠️ 合成样本里有**两条**真实依赖语句，分别走正则的 require( 与 from 两个分支：
    // `src/fake-svc.ts` 的 require('room-service') 与 `src/fake-import.ts` 的 from 'room-service'。
    // 两条都必须留下 —— 断言两个值（不要 Set 去重）：少一条就等于「剥注释把真依赖也剥掉了」。
    expect(hit).toEqual(['room-service', 'room-service']);
  });

  it('④ 规则标识符：注释里的 HandType 放行，代码里的报出', () => {
    const hit = synthetic
      .filter((f) => /\bHandType\b/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-rule.ts']);
  });

  it('⑤ 底分字面量：注释里的 `baseScore = 15` 放行，代码里的报出', () => {
    const hit = synthetic
      .filter((f) => /\b(?:const|let|var)\s+\w*(?:base|unit)?score\w*\s*=\s*[\d_]+/i.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-score.ts']);
  });

  it('⑦ 应用层心跳：注释里的 emit(\'ping\') 放行，代码里的报出', () => {
    const hit = synthetic
      .filter((f) => /emit\(\s*['"](?:ping|pong)['"]/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-ping.ts']);
  });

  it('⑥ 自制点数映射：注释里的 `大王` 放行，代码里的报出', () => {
    // ⑥ 现在的实现是「按行猜这行是不是注释」——剥注释后不再需要那个补丁（R620 的 ⑥）
    const withTpl = [
      { path: 'src/fake-face.ts', content: `// 反例：不得自制牌面映射，如 '大王'\nconst f = (n: number) => (n === 17 ? '小王' : '');` },
      { path: 'src/fake-face-ok.ts', content: `// 这里只解释：'大王'/'小王' 必须走 toDisplay\nconst f = (n: number) => toDisplay(n);` },
    ];
    const hit = withTpl
      .filter((f) => /['"](?:大王|小王)['"]/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-face.ts']); // ⚠️ 注释里那行不算，代码里那行算
  });
});

describe('R572 负对照（R626）：纯注释样本对 7 条判据必须零违规', () => {
  /** 只有注释、没有任何真代码的样本 —— 抄的是本仓注释的真实习惯。 */
  const commentOnly = [
    { path: 'src/c1.ts', content: `// 不得 import '@fight-the-landlord/shared'（会把规则带进前端）` },
    { path: 'src/c2.ts', content: `// 反例：const h = require('room-service');` },
    { path: 'src/c3.ts', content: `// 反例：前端不得出现 HandType.Single` },
    { path: 'src/c4.ts', content: `// 反例：M09 禁止 const baseScore = 15;` },
    { path: 'src/c5.ts', content: `// 反例：§6.1 不得有 socket.emit('ping')` },
    { path: 'src/c6.ts', content: `/* 块注释里也不能被误判：'大王' / '小王' 必须走 toDisplay */` },
    { path: 'src/c7.ts', content: `<!-- 模板注释：HandType 与 baseScore = 15 -->` },
  ];
  const code = commentOnly.map((f) => ({ path: f.path, content: stripComments(f.content) }));

  it('① 没有任何 shared 引用', () => {
    expect(code.filter((f) => /@fight-the-landlord\/shared/.test(f.content)).map((f) => f.path)).toEqual([]);
  });
  it('② shared 命名空间集合为空', () => {
    const referenced = new Set<string>();
    for (const f of code) for (const m of f.content.matchAll(/@fight-the-landlord\/[a-z-]+/g)) referenced.add(m[0]);
    expect([...referenced].sort()).toEqual([]);
  });
  it('③ 没有禁止的 import/require 目标，也没有裸依赖', () => {
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const targets = code.flatMap((f) => [...f.content.matchAll(re)].map((m) => m[1]!));
    expect(targets.filter((t) => t.includes('room-service'))).toEqual([]);
    expect(targets.filter((t) => !t.startsWith('.') && !t.startsWith('@fight-the-landlord/protocol'))).toEqual([]);
  });
  it('④ 没有规则标识符', () => {
    const banned = ['HandType', 'parseHand', 'canBeat', 'isBomb'];
    expect(code.flatMap((f) => banned.filter((id) => new RegExp(`\\b${id}\\b`).test(f.content)))).toEqual([]);
  });
  it('⑤ 没有底分字面量', () => {
    expect(
      code.flatMap((f) => [
        ...f.content.matchAll(/\b(?:const|let|var)\s+\w*(?:base|unit)?score\w*\s*=\s*[\d_]+/gi),
        ...f.content.matchAll(/\b(?:BASE_?SCORE|BASE_SCORE|DEFAULT_SCORE)\b\s*[:=]\s*[\d_]+/g),
      ]),
    ).toEqual([]);
  });
  it('⑥ 没有自制点数映射字面量', () => {
    expect(code.flatMap((f) => [...f.content.matchAll(/['"](?:大王|小王)['"]/g)])).toEqual([]);
  });
  it('⑦ 没有应用层心跳', () => {
    expect(code.filter((f) => /emit\(\s*['"](?:ping|pong)['"]/.test(f.content)).map((f) => f.path)).toEqual([]);
  });

  /**
   * ⚠️ **R628（执行期订正）**：上面 7 条负对照**钉不住生产侧的那一步**。
   *
   * 它们自己造视图（`code = commentOnly.map(…stripComments…)`），语料与 `codeSources`（真实 `src/**`）
   * **不相交**，因此两块是**并行**的、不是串联的 —— 把 7 条生产断言里的 `codeSources` 改回 `sources`
   * （即整条改动被撤掉）**本组一条都不会红**（implementer 实测：M3a ⇒ 全绿）。
   * 这与本文件另一处守卫（`扫描器确实读到了文件`，防止「因为读不到文件而永远通过」）是同一类：
   * **守卫必须观察被守卫的那份输入本身**。
   */
  it('生产视图 codeSources 确实剥掉了注释（把 `codeSources = sources` 或把 stripComments 改成恒等 ⇒ 本断言红）', () => {
    const changed = codeSources.filter((f, i) => f.content !== sources[i]!.content).length;
    // `src/**` 的文件普遍带注释 ⇒ 正常态一定 > 0；`codeSources` 被指向原始文本时恒为 0 ⇒ 当场红。
    expect(
      changed,
      'codeSources 与 sources 完全相同 ⇒ 生产侧的 7 条断言读的其实是原始文本（注释盲缺陷回来了）',
    ).toBeGreaterThan(0);
    /**
     * ⚠️ **本守卫的射程（R629 实测，别把标题读成更强的承诺）**：
     *   ✅ **能**抓：`const codeSources = sources`（把常量指向原始文本）· 删掉 `codeSources` 声明（`ReferenceError`）·
     *      `stripComments` 改成恒等（本片 M2 复跑实测 10 failed）。
     *   ❌ **抓不到**：把 7 条循环**逐条**改回 `for (const file of sources)` 而**留下**一个已无人读的 `codeSources` 常量。
     *      要抓那一态只能**自引用静态扫描本文件**（数 `for (const file of codeSources)` 的出现次数），
     *      而那会让本文件在**重命名/重排**时产生**假红** —— 假红是本仓更贵的一类病（P13 教训 2：按形态计数会漏/会误）。
     *      ⇒ **故意不加**那第 9 条；这一态由**人评审**兜（本注释就是那份提示）。
     */
  });
});

/**
 * ② 金币场（§14）：门槛与救助阈值的算式 —— **两个乘数都来自服务端**，机械扫描抓「硬编码」。
 *
 * 金语境的数字只有两个合法来源：
 *  · 底分 ⇒ 服务端下发的档位表（`baseScore` / 档位表最低档，用户选中的那一档）；
 *  · 倍率 ⇒ 服务端配置（`entryMultiplier`）。
 * ⇒ 凡「这些符号 × 数字字面量」（两个方向）都是把服务端的值换成了前端常量，一律违规。
 *
 * ⚠️ 上面 `⑤` 组的底分扫描只抓**赋值**形态（`const baseScore = 15`）；本组抓的是
 * **算式**形态（`baseScore * 150` / `15 * entryMultiplier` 这类——正是「不得硬编码
 * 150/800/…」那句要消灭的写法）。合成样本双向自证在第二条。
 */
const THRESHOLD_LITERALS: RegExp[] = [
  /\bentryMultiplier\s*[*×]\s*\d/,
  /\d\s*[*×]\s*\bentryMultiplier\b/,
  /\bbaseScore\s*[*×]\s*\d/,
  /\d\s*[*×]\s*\bbaseScore\b/,
];

describe('② 金币场：门槛/救助阈值的算式不得含字面量（两个乘数都来自服务端）', () => {
  it('src/** 的门槛算式里没有「服务端符号 × 字面量」', () => {
    const offenders: string[] = [];
    for (const file of codeSources) {
      for (const re of THRESHOLD_LITERALS) {
        const m = re.exec(file.content);
        if (m) offenders.push(`${file.path}: ${m[0]}`);
      }
    }
    expect(
      offenders,
      `门槛算式出现字面量（应取 baseScore × entryMultiplier，倍率来自配置）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('判别力自证：反例必须被同一组正则报出；本仓的合法形态必须放行', () => {
    const hit = (src: string): boolean => THRESHOLD_LITERALS.some((re) => re.test(src));
    // 红：150/800 这类硬编码（「不得硬编码 150/800/…」直接对应的形态）
    expect(hit('const need = baseScore * 150;')).toBe(true);
    expect(hit('const need = 800 - lv.baseScore * 10;')).toBe(true);
    expect(hit('const need = 15 * entryMultiplier;')).toBe(true);
    // 绿：两个乘数都是服务端符号（store 的门槛 getter 与救助条件就是这种形态）
    expect(hit('const needed = baseScore * s.entryMultiplier;')).toBe(false);
    expect(hit('s.walletBalance < lowest * s.entryMultiplier')).toBe(false);
  });

  it('14003 的同形消息必须是**插值**（前端不得把门槛数字写进文案字面量）', () => {
    const lobby = codeSources.find((f) => f.path === 'src/pages/lobby/lobby.vue');
    expect(lobby, 'lobby.vue 必须在扫描集合里').toBeDefined();
    expect(lobby!.content, '门槛消息必须以插值取服务端算式的结果').toMatch(
      /金币不足：该场次需要 ≥ \$\{/,
    );
  });
});
