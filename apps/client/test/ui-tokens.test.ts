/**
 * Task 2（切片 P10）的**机械判据**：design token 单一真源 + `rpx` 单位体系。
 *
 * 三条静态扫描（扫描面 = `src/**`，实现见 `test/helpers/source-scan.ts`）：
 *  ① 每个 `.vue` 的 `<style>` 都声明 `lang="scss"`（否则 `src/uni.scss` 注入不进来），
 *     且除 token 文件 `src/uni.scss` 外**没有任何裸十六进制色值**；
 *  ② **没有 `px` 单位**（发丝线白名单除外），距离量只剩 `rpx`；
 *  ③ `src/uni.scss` 真的定义了 token：色 / 间距阶 / 圆角阶 / 字号阶。
 *  ④ 自证判别力（R179/R193③ 的规矩）：扫描器必须**真的读到**那些文件。
 *
 * ⚠️ 这些闸只判断「字面量与声明」，不判断观感 —— 观感在真浏览器探针（协调者所有）里看。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments as stripSfcComments, type ScannedFile } from './helpers/source-scan';

const sources = collectSourceFiles();
const vueFiles = sources.filter((f) => f.path.endsWith('.vue'));
/** token 的**唯一真源**：uni-app CLI 把它的内容注入每一个 `lang="scss"` 块。 */
const TOKEN_FILE = 'src/uni.scss';
const tokenFile = sources.find((f) => f.path === TOKEN_FILE);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 取出 `<style …>…</style>` 的**内容**（同一文件可能有多个块）。 */
function styleBlocks(vue: ScannedFile): string[] {
  return [...stripSfcComments(vue.content).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
}

/** 取 `<style …>` 的**开标签属性串**（用来读 `lang` 属性）。 */
function styleOpenTags(vue: ScannedFile): string[] {
  return [...stripSfcComments(vue.content).matchAll(/<style\b([^>]*)>/g)].map((m) => m[1]!);
}

/**
 * 去掉注释（scss 的 `//` 与 `/* … *\/`）。
 *
 * **必须有这一步**：否则「注释里解释为什么保留 1px」会把自己送进 px 闸，
 * 于是文档写得越清楚、测试越红 —— 那会逼着后来人删掉解释。
 *
 * ⚠️ **故意不并入** `helpers/source-scan#stripComments`（R619）：那份会额外剥 `<!-- -->`，
 * 而本函数只服务 `<style>` 块的 px 闸 —— 加上那条规则等于**删得更多**（更松），
 * 违反本片的不变量（R618）。两份实现的差异是**有意的**，不是遗漏。
 *
 * ⚠️ **名字要点出主语**（M3 固定轮）：本函数吃的是**SCSS 文本**，不是整份 SFC ——
 * 所以它叫 `stripScssComments`，与上面 `stripComments as stripSfcComments`（canonical，吃整份 SFC）
 * 一眼可分。此前两者名字正好反着，读的人得先查 import 别名才知道谁是谁。
 */
function stripScssComments(scss: string): string {
  return scss.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 去掉注释后的 `src/**` 可扫描文本（用于「这些文件真的被读到了」的判别力断言）。 */
function styleText(): string {
  return vueFiles.flatMap((f) => styleBlocks(f).map(stripScssComments)).join('\n');
}

// ---------------------------------------------------------------------------
// 手写发丝线闸（R714）
// ---------------------------------------------------------------------------

/**
 * 手写发丝线违规（**片① / R714**）：全仓**不得出现裸 `1px`** —— 描边一律走 `$ftl-hairline`（2px）。
 *
 * ⚠️ **为什么 1px 会消失**：画布会被 `transform: scale(k)` 缩放，手机横屏上 `k ≈ 0.52`
 * ⇒ `1px` 实际渲染 **0.52px**。而本仓原本那条白名单的理由**逐字**写着
 * 「多端在 1px 以下渲染不出来」—— 那条白名单因此**被撤**（它保护的写法在新模型下必然失效）。
 *
 * ⚠️ **正则用 `(?:^|[^\d])1px\b` 而不是 `\dpx`**：避免把 `241px` 里的 `1px` 子串误报。
 */
function hairlineOffenders(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /(?:^|[^\d])1px\b/.test(l));
}

/**
 * 显式豁免的**非 px** 单位。名单是空的 —— 见下面 `UNIT_EXEMPTIONS` 的历史说明。
 */
const UNIT_EXEMPTIONS: ReadonlyArray<{ re: RegExp; why: string }> = [];

/**
 * `rpx` 违规（**片① / R711**）：本片起尺寸一律用 `px`（设计像素）。
 *
 * ⚠️ **为什么可以全禁 rpx**：画布是**固定坐标系**（1334×750），适配由 `transform: scale(k)`
 * 承担 —— 而 rpx 存在的全部理由就是「跨屏宽自适应」，那件事已经被画布做掉了，
 * 且做得更确定（rpx 在横屏会跟长边放大 2.3 倍，见 spec §3.1）。
 *
 * ⚠️ **扫描面** = `.vue` 的 `<style>` 块 **+ 全部 `.scss` 文件**（含 `uni.scss` —— 令牌真源）。
 */
function rpxOffenders(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\d+rpx\b/.test(l));
}

/**
 * 全部可扫描的样式文本（`.vue` 的 style 块 **+ 所有 `.scss` 文件**）。
 *
 * ⚠️ `styleText()` 只拼 `vueFiles` —— 而**令牌真源 `uni.scss` 是个 `.scss`**，
 * 不把它算进来的话「rpx 零命中」会是**因为没扫到而恒绿**。
 */
function allStyleText(): string {
  const scss = sources
    .filter((f) => f.path.endsWith('.scss'))
    .map((f) => stripScssComments(f.content));
  return [styleText(), ...scss].join('\n');
}

// ---------------------------------------------------------------------------
// ① token 单一真源
// ---------------------------------------------------------------------------

describe('① design token 单一真源（R442）', () => {
  it('每个 .vue 的 <style> 都声明 lang="scss"（token 才注入得进来）', () => {
    const offenders: string[] = [];
    for (const file of vueFiles) {
      const tags = styleOpenTags(file);
      if (tags.length === 0) {
        offenders.push(`${file.path}: 没有 <style> 块`);
        continue;
      }
      for (const tag of tags) {
        if (!/\blang=("|')scss\1/.test(tag)) offenders.push(`${file.path}: ${tag}`);
      }
    }
    expect(offenders, `未声明 lang="scss" 的样式块：\n${offenders.join('\n')}`).toEqual([]);
  });

  it(`除 ${TOKEN_FILE} 外没有任何裸十六进制色值（#rgb / #rrggbb / #rrggbbaa）`, () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const offenders: string[] = [];
    for (const file of [...vueFiles, ...sources.filter((f) => f.path.endsWith('.scss'))]) {
      if (file.path === TOKEN_FILE) continue;
      const text = styleBlocks(file).map(stripScssComments).join('\n');
      for (const line of text.split('\n')) {
        if (hex.test(line)) offenders.push(`${file.path}: ${line.trim()}`);
      }
    }
    expect(offenders, `裸色值（应改为 $ftl-* 变量）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it(`${TOKEN_FILE} 定义了完整 token 阶（色 / 间距 / 圆角 / 字号）`, () => {
    expect(tokenFile, `${TOKEN_FILE} 必须存在（它是注入源）`).toBeDefined();
    const content = tokenFile!.content;
    /** 注释里写「不得出现底分」是文档，不是常量 —— 判据只看代码。 */
    const code = stripScssComments(content);
    const required: Record<string, RegExp> = {
      '主色': /^\$ftl-color-primary:\s*#[0-9a-fA-F]{6};/m,
      '文字色': /^\$ftl-color-text:\s*#[0-9a-fA-F]{6};/m,
      '背景色': /^\$ftl-color-surface:\s*#[0-9a-fA-F]{6};/m,
      '边框色': /^\$ftl-color-border:\s*#[0-9a-fA-F]{6};/m,
      '危险色': /^\$ftl-color-danger:\s*#[0-9a-fA-F]{6};/m,
      '间距阶': /^\$ftl-space-\d+:\s*\d+px;/m,
      '圆角阶': /^\$ftl-radius-\w+:\s*\d+px;/m,
      '字号阶': /^\$ftl-font-\w+:\s*\d+px;/m,
    };
    const missing = Object.entries(required)
      .filter(([, re]) => !re.test(content))
      .map(([label]) => label);
    expect(missing, `${TOKEN_FILE} 缺少 token：${missing.join('、')}`).toEqual([]);
    // 间距/圆角/字号必须是**阶**而不是单个值（后面画 UI 才有得选）
    for (const [label, re] of [
      ['间距', /^\$ftl-space-\d+:/gm],
      ['圆角', /^\$ftl-radius-\w+:/gm],
      ['字号', /^\$ftl-font-\w+:/gm],
    ] as const) {
      expect([...code.matchAll(re)].length, `${label}阶至少 3 档`).toBeGreaterThanOrEqual(3);
    }
    // token 里**不得**出现游戏规则常量（§12.2 M09）：只允许几何/颜色
    expect(code, 'token 文件不得出现底分/倍数这类规则常量').not.toMatch(/baseScore|multiplier|底分|倍数/);
  });

  /**
   * `ftl-btn` 白边闸（2026-10，真浏览器截图定位）：
   * 按钮贴图 btn2.png 自带深色边缘，而 mixin 旧版的**白色兜底底 + 实色灰描边**会沿贴图边缘
   * 露出一圈厚白框（蓝底牌桌上最扎眼）；uni-button 宿主另挂一层 `::after` 0.67px 细黑边。
   * 结论：底色透明、描边仅留宽度占位且透明、`::after` 去边。主按钮在各页面自行覆盖金边金底。
   */
  it('ftl-btn mixin：底色/描边透明且干掉 uni-button ::after 细边（白边闸）', () => {
    const code = stripScssComments(tokenFile!.content);
    /** 取 SCSS mixin 体（体内有 `&::after {}` 嵌套，非贪婪正则会提前截断，故手算花括号平衡）。 */
    const extractMixin = (name: string): string => {
      const head = new RegExp(`@mixin\\s+${name}\\s*\\{`, 'm');
      const hit = head.exec(code);
      if (!hit) return '';
      let depth = 0;
      for (let j = hit.index; j < code.length; j += 1) {
        if (code[j] === '{') depth += 1;
        if (code[j] === '}') {
          depth -= 1;
          if (depth === 0) return code.slice(hit.index + hit[0].length, j);
        }
      }
      return '';
    };
    const body = extractMixin('ftl-btn');
    expect(body, 'uni.scss 必须存在 @mixin ftl-btn').not.toBe('');
    expect(body, '描边只保留 $ftl-hairline 宽度占位，颜色必须 transparent').toMatch(
      /border:\s*\$ftl-hairline\s+solid\s+transparent\s*;/,
    );
    expect(body, '底色必须 transparent（白底会沿贴图边缘露出白框）').toMatch(
      /background:\s*transparent\s*;/,
    );
    expect(body, '不得再用实色兜底底/实色灰描边').not.toMatch(
      /background:\s*\$ftl-color-surface|border:\s*\$ftl-hairline\s+solid\s+\$ftl-color-border-control/,
    );
    expect(body, '必须干掉 uni-button 宿主 ::after 细边').toMatch(/&::after\s*\{[^}]*border:\s*none\s*;/);
    // 贴图仍在，且 background-image 必须在 background 简写**之后**（简写会重置 image）
    const bgAt = body.search(/background:\s*transparent\s*;/);
    const imgAt = body.search(/background-image:\s*url\(\$ftl-btn-plate\)/);
    expect(imgAt, '贴图 $ftl-btn-plate 不得删除').toBeGreaterThanOrEqual(0);
    expect(bgAt).toBeLessThan(imgAt);
  });

  /**
   * 片①（App 界面重做）的视觉基座：**新增两组色阶**，供片②③ 重写页面时取用。
   *
   * ⚠️ 本片**只加不改**：现有令牌的**值**一个都没动 —— 改值等于全局换肤、会同时改掉四个页面，
   * 而重做是**分页进行**的（规格 §5.2）。
   * ⚠️ 断言的是「阶」而不是「某个具体色号」：色号会在真浏览器截图并排时迭代，
   * 但「有 3 档可挑」这条结构性质不该跟着漂。
   */
  it('片① 视觉基座：金色阶与深蓝底阶各 ≥3 档', () => {
    const code = stripScssComments(tokenFile!.content);
    // ⚠️ `[\w-]*` 而**不是** `\w*`：`-` **不是** `\w` —— 用 `\w*` 会**漏掉** `$ftl-color-gold-light:`
    //    （`gold` 后面紧跟 `-`，`\w*` 只能吃空串，紧接着要求 `:` 就失败）
    //    ⇒ 计数停在 1、这条断言**永远红**。这是 pre-flight 扫描抓出来的，不是执行期踩的。
    expect([...code.matchAll(/^\$ftl-color-gold[\w-]*:/gm)].length, '金色阶至少 3 档').toBeGreaterThanOrEqual(3);
    expect([...code.matchAll(/^\$ftl-color-night[\w-]*:/gm)].length, '深蓝底阶至少 3 档').toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// ② 单位体系
// ---------------------------------------------------------------------------

describe('② 单位体系换 px（R711）', () => {
  it('样式里没有 rpx（尺寸一律 px；扫描面含 .scss 与令牌文件）', () => {
    const offenders = rpxOffenders(allStyleText());
    expect(offenders, `未转换的 rpx：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('组件样式里没有手写发丝线 `1px`（一律走 `$ftl-hairline`）', () => {
    // ⚠️ **本闸的射程被刻意收窄了**：它**只禁 `1px`**，**不禁**「组件里的全部 px 字面量」。
    //
    //    更强的规则（「px 字面量只许出现在 uni.scss」）**曾被考虑并否决**：实测下来
    //    组件里现存 6 处非发丝线的 px 字面量（`max-width: 2240px` / `letter-spacing: 4px` /
    //    logo 的 `width: 640px` 等），它们全是**竖屏遗留**、本该由 Tasks 4–6 的横屏重排删掉。
    //    把那条规则放这里 = 把 Tasks 4–6 的活提前压进 Task 2，且会逼出为一次性用途造的令牌。
    //
    //    ⇒ 本 Task 只做**闸的翻转**与 `1px` 的收口；布局字面量随各自的重排任务消失。
    //      （计划文件的「执行期发现」记了这条取舍。）
    expect(hairlineOffenders(styleText()), '发丝线必须走 $ftl-hairline（2px），不得手写 1px').toEqual(
      [],
    );
  });

  it('判别力正对照：两条闸都能报错，且各自放行合法样本', () => {
    // rpx 违规
    expect(rpxOffenders('.card { width: 144rpx; }')).toHaveLength(1);
    expect(rpxOffenders('.card { height: 96rpx; }')).toHaveLength(1);
    expect(rpxOffenders('.card { width: 144px; }')).toEqual([]);
    // 手写发丝线违规 —— ⚠️ `1px` **不再是白名单**（R714）
    expect(hairlineOffenders('.card { border: 1px solid #c8c8c8; }')).toHaveLength(1);
    expect(hairlineOffenders('.card { border-top: 1px dashed #e0e0e0; }')).toHaveLength(1);
    // 放行：走令牌的、2px 的、以及「数字里含 1px 子串」的都不误报
    expect(hairlineOffenders('.card { border: $ftl-hairline solid red; }')).toEqual([]);
    expect(hairlineOffenders('.card { border: 2px solid red; }')).toEqual([]);
    expect(hairlineOffenders('.card { min-width: 241px; }'), '21px 子串不得误报').toEqual([]);
  });

  it('判别力自证：**px 才是主体**且 rpx 零命中（不是「空集合恒绿」）', () => {
    const text = allStyleText();
    expect(text, '扫描器没读到样式内容').not.toBe('');
    // ⚠️ **正向自证必须落在 `uni.scss`**：组件里用的是 `$ftl-*` 令牌，**字面量 px 只在令牌文件里**。
    //    只断言「rpx 零命中」的话，闸会因为「什么都没扫到」而恒绿 —— 那正是本仓最怕的形态。
    const tokenText = stripScssComments(sources.find((f) => f.path === TOKEN_FILE)!.content);
    const tokenPx = (tokenText.match(/\d+px\b/g) ?? []).length;
    expect(tokenPx, 'uni.scss 里的 px 字面量（令牌真值）').toBeGreaterThanOrEqual(30);
    expect((text.match(/\d+rpx\b/g) ?? []).length, '全仓 rpx 命中数').toBe(0);
  });

  it('`line-height` 用无单位数值（不要 px）', () => {
    const offenders: string[] = [];
    for (const line of styleText().split('\n')) {
      const m = /line-height:\s*([^;]+);/.exec(line);
      if (m && !/^\s*[\d.]+(\s*!important)?\s*$/.test(m[1]!)) offenders.push(line.trim());
    }
    expect(offenders, `line-height 必须是无单位数值：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('尺寸单位只有 px（`em/rem/vw/vh/pt` 一律违规，见 UNIT_EXEMPTIONS）', () => {
    // `em/rem/vw/vh/pt` 这些在多端语义不一致 ⇒ 一律不用。
    // ⚠️ 片① 起 `px` 是**正确**单位（设计像素，R711）：画布固定坐标系 + `transform: scale(k)`
    //    承担适配。窗口尺寸的读取走 JS 纯函数（`useLandscapeCanvas`），**不用 vw/vh**。
    const offenders: string[] = [];
    for (const line of styleText().split('\n')) {
      const unit = /(?:^|[\s:(])\d*\.?\d+(em|rem|vw|pt)\b/.exec(line);
      if (unit && !UNIT_EXEMPTIONS.some(({ re }) => re.test(line.trim()))) offenders.push(line.trim());
      const vh = /(?:^|[\s:(])\d*\.?\d+vh\b/.exec(line);
      if (vh && !UNIT_EXEMPTIONS.some(({ re }) => re.test(line.trim()))) offenders.push(line.trim());
    }
    expect(offenders, `未豁免的非 px 单位：\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ③ 扫描器自证判别力（本仓硬规矩：闸不得「因为读不到文件而恒绿」）
// ---------------------------------------------------------------------------

describe('③ 扫描器自证判别力', () => {
  it('扫描集合里必须有全部 .vue 与 token 文件', () => {
    // Task 3 的清单：9 个业务 .vue（含 App.vue）= 4 个页面（各在自己的目录里）+ 4 个组件
    //（片③ 起含共用件 `SessionNotice.vue`）+ 外壳。
    // 记录片 T8 起：第 5 页 `pages/history/history.vue`（历史战绩子页）⇒ 10 个业务 .vue = 5 个页面。
    // 支付片 T14 起：第 6 页 `pages/wallet/wallet.vue`（钱包子页）⇒ 11 个业务 .vue = 6 个页面。
    // 钱包拆分（2026-10-23）起：第 7/8 页 `pages/wallet/recharge.vue` / `withdraw.vue`。
    // 提示收敛 Task 3 起：新增浮层组件 `components/NoticeStack.vue`；Task 11 起
    // `SessionNotice.vue` 退役删除；Task 11 后半 `ConnectionDeadBar.vue` 也退役
    // （玩法页死态已收敛进 NoticeStack 的 connection-dead 项）。
    expect(vueFiles.length).toBeGreaterThanOrEqual(7);
    const paths = vueFiles.map((f) => f.path);
    for (const required of [
      'src/App.vue',
      'src/components/Card.vue',
      'src/components/Hand.vue',
      'src/components/Settlement.vue',
      'src/components/NoticeStack.vue',
      'src/pages/login/login.vue',
      'src/pages/lobby/lobby.vue',
      'src/pages/game/game.vue',
      'src/pages/table/table.vue',
      'src/pages/history/history.vue',
      'src/pages/wallet/wallet.vue',
      'src/pages/wallet/recharge.vue',
      'src/pages/wallet/withdraw.vue',
    ]) {
      expect(paths, `${required} 必须在扫描集合里`).toContain(required);
    }
    expect(paths, '页壳必须已删除（Task 3 由页面栈取代）').not.toContain('src/pages/index/index.vue');
    expect(sources.map((f) => f.path), `${TOKEN_FILE} 必须在扫描集合里`).toContain(TOKEN_FILE);
  });

  it('token 文件里的变量真的被 .vue 引用了（否则「单一真源」只是摆设）', () => {
    const text = styleText();
    // 抽样：主色、间距、圆角、字号四类各至少被引用一次
    expect(text).toContain('$ftl-color-primary');
    expect(text).toMatch(/\$ftl-space-\d/);
    expect(text).toMatch(/\$ftl-radius-\w/);
    expect(text).toMatch(/\$ftl-font-\w/);
  });
});
