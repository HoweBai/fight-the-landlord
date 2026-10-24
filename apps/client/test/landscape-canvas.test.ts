/**
 * 横屏舞台的**尺寸模型**（2026-10-11 起全出血自适应：`layoutMetrics`；
 * 前身 spec §2 / R709–R712 的固定 1334×750 + contain 模型）。
 *
 * ⚠️ **判据射程**：这是**纯函数**的判据 —— 它证明「给定视口，算出的 k 与画布设计尺寸是对的」，
 * **不证明**「按这个尺寸排版后页面好看」。后者只能由真浏览器走查证明（spec §1.4-8）。
 *
 * ⚠️ **不要写「k×1334 ≤ 视口宽」这类断言**：`k ≡ min(w/W, h/H)` ⇒ 它**按定义恒真**，
 * 零判别力、会伪装成「已验证」（spec 自审 #1）。要断言的是**全出血等式与极端宽高比下的可用性**。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANVAS_H,
  CANVAS_W,
  isPortrait,
  keepLastGoodViewport,
  landscapeScale,
  layoutMetrics,
  MIN_USABLE_HEIGHT,
  MIN_USABLE_WIDTH,
  sanitizeViewport,
  type Viewport,
} from '../src/composables/useLandscapeCanvas';
import { SRC_ROOT, collectSourceFiles, stripComments } from './helpers/source-scan';

/** 底纹的**唯一**落点（映射表所在文件）。判据里三处用到，抽出来避免「三份字面量各自过期」。 */
const STAGE = 'src/components/LandscapeStage.vue';

/**
 * 「**铺底纹**」写法的形态（三条 —— 同一件事在三种书写通道里的写法）。
 *
 * 🔴 **只认这几种**（Task B7 的实测约束 + B89 补强）：`<image src="/static/ui/…">` 这类
 * **非 CSS 通道**（`MoreMenu.vue` 的关闭键、`PlayerChip.vue` 的头像、`lobby.vue` 的玩法图标
 * 都在 `src/**` 里含 `/static/ui/`）**不得**被认成铺底纹 —— `<image src>` 吃不到 CSS，
 * 铺出来的是**一个盒子的内容**，不是铺满整层的底纹（那一类由下面「图名只允许出现在
 * `LandscapeStage.vue`」的独立断言接管）。
 *
 * ⚠️ 三条都**刻意放宽到「能拦住真实错法」为止**，每条放宽后都实测过「**除
 * `LandscapeStage.vue` 那一处外零新增命中**」（即零误报）：
 *  · ① 收 `background: url(...)` **简写**（`background:` + `background-image:` 两种写法
 *    在真实 CSS 里等价，只认后者时简写形态会**静默溜过**；B7-M2 实证它拦得住）；
 *  · ② 内联形态不要求**模板字符串**（反引号）—— `'url(…)'` / `"url(…)"` 同样是「组件自己在
 *    铺底纹」，只认反引号等于把书写习惯当成性质（本仓今天只有一处内联 ⇒ 零误报）；
 *  · ③ **带引号的 kebab 内联键**（B89 补，评审者点名的盲区）：`:style="{ 'background-image':
 *    'url(…)' }"` —— 前两条报不了它（① 要求 `:` 紧跟在无引号的键后、② 只认 camelCase 键），
 *    而它在真实 Vue 里是合法且常见的书写（本仓今天零处该形态 ⇒ 零误报）。
 */
const BACKDROP_WRITINGS = [
  /background(-image)?\s*:[^;{}]*url\(\s*['"]?\/static\/ui\//,
  /backgroundImage\s*:\s*['"`]?url\(/,
  /['"]background-image['"]\s*:\s*['"`]?url\(/,
] as const;

/** 命中「铺底纹写法」的文件（读**剥注释**视图：注释里解释这条判据不算命中）。 */
function backdropWriters(): string[] {
  return collectSourceFiles()
    .filter((f) => {
      const src = stripComments(f.content);
      return BACKDROP_WRITINGS.some((re) => re.test(src));
    })
    .map((f) => f.path);
}

describe('① landscapeScale：典型设备上的缩放比', () => {
  it.each([
    // [视口宽, 视口高, 期望 k, 说明]
    [866, 390, 0.52, '手机 19.5:9 —— 高度受限'],
    [812, 375, 0.5, '手机 16:9（812×375）—— k 恰好 0.5'],
    [1024, 768, 0.768, '平板 4:3 —— 宽度受限'],
    [1440, 800, 1.067, '桌面 —— 缩放 > 1'],
  ])('%i×%i ⇒ k ≈ %f（%s）', (w, h, expected) => {
    expect(landscapeScale(w as number, h as number)).toBeCloseTo(expected as number, 3);
  });

  it('恒定性质：画布**等比**且高度受限时由高度决定（用具体数值验，不用恒真式）', () => {
    const w = 866;
    const h = 390;
    const k = landscapeScale(w, h);
    // 比例严格保持（这是 k 的定义要保证的观感属性）
    expect((k * CANVAS_W) / (k * CANVAS_H)).toBeCloseTo(CANVAS_W / CANVAS_H, 6);
    // 与手算的比较：0.52 = 390/750 ⇒ 高度受限那一支
    expect(k).toBeCloseTo(h / CANVAS_H, 6);
  });
});

describe('⓪ layoutMetrics：全出血画布（设计区 = 安全区 ÷ k）', () => {
  /**
   * 设备矩阵（2026-10-11 全出血模型；[视口宽, 视口高, 期望 k, 期望设计宽, 期望设计高, 说明]）。
   * 判据三件事：
   *  ① `scale` 与 `landscapeScale` 同值（视觉尺寸零变化的契约）；
   *  ② `宽×scale = 可用宽 ∧ 高×scale = 可用高`（缩放后恰好铺满安全框 ⇒ 零留边）；
   *  ③ 设计宽恒 ≥ 1334、设计高恒 ≥ 750（最小设计尺寸，既有令牌/账目不失效）。
   */
  /**
   * `bound` 标明该视口下 k 受哪一维约束：
   *  · `height`（宽高比 > 16:9）⇒ 设计高恰为 750，设计宽放大铺满；
   *  · `width`（宽高比 < 16:9）⇒ 设计宽恰为 1334，设计高放大铺满；
   *  · `both`（恰 16:9）⇒ 设计尺寸恰为 1334×750（与旧固定画布逐值相同）。
   */
  it.each([
    [667, 375, 'both', 'iPhone SE 16:9 —— 与旧固定画布完全一致'],
    [844, 390, 'height', 'iPhone 14 19.5:9 —— 设计宽放大铺满，高仍 750'],
    [800, 360, 'height', '安卓 20:9 —— 同上'],
    [1024, 768, 'width', 'iPad 4:3 —— 宽顶死 1334，设计高放大铺满'],
    [1309, 598, 'height', '用户宽窗 2.19:1 —— 两侧留边消失'],
    [1334, 750, 'both', '视口恰为最小设计尺寸 —— k=1，画布 1334×750'],
  ])('%i×%i ⇒ %s', (w, h, bound) => {
    const m = layoutMetrics(w as number, h as number);
    // ① scale 与旧纯函数同值（视觉尺寸零变化的契约）。
    expect(m.scale).toBeCloseTo(landscapeScale(w as number, h as number), 10);
    // ② 全出血等式：缩放后的画布就是安全框（容差 1e-6，防浮点伪装）。
    expect(m.width * m.scale, '缩放后画布宽 = 可用宽').toBeCloseTo(w as number, 6);
    expect(m.height * m.scale, '缩放后画布高 = 可用高').toBeCloseTo(h as number, 6);
    // ③ 最小设计尺寸 + 受约束那一维恰好顶在最小值上。
    expect(m.width).toBeGreaterThanOrEqual(CANVAS_W);
    expect(m.height).toBeGreaterThanOrEqual(CANVAS_H);
    if (bound === 'height' || bound === 'both') expect(m.height, '高度受约束 ⇒ 设计高恰 750').toBe(CANVAS_H);
    if (bound === 'width' || bound === 'both') expect(m.width, '宽度受约束 ⇒ 设计宽恰 1334').toBe(CANVAS_W);
  });

  it('安全区收窄：metrics 以安全框为输入，缩放后仍铺满**安全框**（不是物理屏）', () => {
    const m = layoutMetrics(1024, 768, { left: 44 });
    const usableW = 1024 - 44;
    expect(m.scale).toBeCloseTo(usableW / CANVAS_W, 6);
    expect(m.width * m.scale).toBeCloseTo(usableW, 6);
    expect(m.height * m.scale).toBeCloseTo(768, 6);
  });

  it('病态输入（安全区比视口大）⇒ 不出 0/负/NaN，且守住最小设计尺寸', () => {
    const m = layoutMetrics(100, 100, { left: 200, right: 200, top: 200, bottom: 200 });
    expect(Number.isFinite(m.scale) && Number.isFinite(m.width) && Number.isFinite(m.height)).toBe(true);
    expect(m.scale).toBeGreaterThan(0);
    expect(m.width).toBeGreaterThanOrEqual(CANVAS_W);
    expect(m.height).toBeGreaterThanOrEqual(CANVAS_H);
  });
});

describe('② 极端宽高比下 k 的可用性（**有判别力**的那条）', () => {
  /**
   * 超宽视口（带鱼屏 / 浏览器拉得很宽）时 k 由**高度**决定。旧 contain 模型下画布恒为
   * 1334 设计宽、实占宽可能远小于视口宽（两侧留边）；新模型由 `layoutMetrics` 把设计宽
   * 放大到铺满（见 ⓪）。k 本身只负责「元素统一缩放、不溢出」，这里守它的下界可用性。
   */
  it('超宽视口 3000×400：k 仍由高度决定且 > 0（不产生 0 或负数）', () => {
    const w = 3000;
    const h = 400;
    const k = landscapeScale(w, h);
    expect(k).toBeCloseTo(h / CANVAS_H, 6);
    expect(k).toBeGreaterThan(0);
  });

  it('极端窄高视口 400×900（竖屏）：k 仍 > 0（不产生 0 或负数）', () => {
    expect(landscapeScale(400, 900)).toBeGreaterThan(0);
  });

  it('判别力自证：把 k 的定义改错（不取 min 而取 max）⇒ 它会**垂直溢出**', () => {
    // 合成一个错误实现，证明「可用性」这条判据真的能抓错。
    // ⚠️ 第一版这里断言的是「画布实占宽比 > 1」—— **那是错的**：
    //    `max` 取到 w 支时 (k×W)/w 恒等于 1（w/W×W/w = 1），抓不到任何东西。
    //    真正该断言的是「取 max 会让画布**纵向超出视口**」。
    const wrong = (w: number, h: number) => Math.max(w / CANVAS_W, h / CANVAS_H);
    const w = 3000;
    const h = 400;
    const wrongK = wrong(w, h);
    expect(wrongK * CANVAS_H, '错误实现应当纵向溢出').toBeGreaterThan(h);
    // 而正确实现不会溢出
    expect(landscapeScale(w, h) * CANVAS_H).toBeLessThanOrEqual(h);
  });
});

describe('③ 安全区参与计算', () => {
  /**
   * ⚠️ 夹具必须选**宽度受限**的视口 —— 第一版用的是 866×390（**高度受限**），
   * 那里 k 由高度决定，削掉左侧宽度**根本不改变 k**，断言 `withInset < noInset` 必假。
   * 1024×768 是宽度受限（0.768 vs 1.024）⇒ 削宽才真的让 k 变小。
   */
  it('左侧有刘海（left=44）⇒ 可用宽减少，k 变小（用**宽度受限**的视口）', () => {
    const noInset = landscapeScale(1024, 768);
    const withInset = landscapeScale(1024, 768, { left: 44 });
    expect(withInset).toBeLessThan(noInset);
    expect(withInset).toBeCloseTo((1024 - 44) / CANVAS_W, 6);
  });

  it('安全区大到超过视口 ⇒ 不产生 0 / 负数 / NaN（用 max(1, …) 兜住）', () => {
    const k = landscapeScale(100, 100, { left: 200, right: 200, top: 200, bottom: 200 });
    expect(Number.isFinite(k)).toBe(true);
    expect(k).toBeGreaterThan(0);
  });
});

describe('④ isPortrait：竖屏识别（正反两面）', () => {
  it.each([
    [375, 812, true, '手机竖屏'],
    [812, 375, false, '手机横屏'],
    [768, 1024, true, '平板竖屏'],
    [1024, 768, false, '平板横屏'],
    [812, 812, false, '正方形 ⇒ 不算竖屏'],
  ])('%i×%i ⇒ %s（%s）', (w, h, expected) => {
    expect(isPortrait(w as number, h as number)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// ④-b 读数消毒（2026-10-15 真机缺陷：iOS 旋转瞬态垃圾 resize 把画布缩成 1px）
// ---------------------------------------------------------------------------

/** 造视口（insets 默认全 0）。 */
function vp(w: number, h: number, insets: Partial<Viewport['insets']> = {}): Viewport {
  return { w, h, insets: { top: 0, right: 0, bottom: 0, left: 0, ...insets } };
}

describe('④-b sanitizeViewport：旋转瞬态读数消毒', () => {
  it('真机现场①：844×80 + 竖屏残留 env（T47/B34，usableH=1）⇒ 判不可用', () => {
    // CDP Apple 旋转序列实测：画布 736×1、scale(0.0013)、内容消失，只剩底纹。
    expect(sanitizeViewport(vp(844, 80, { top: 47, bottom: 34 }))).toBeNull();
  });

  it('真机现场②：736×1（无刘海机 Safari 工具栏动画帧）⇒ 判不可用', () => {
    expect(sanitizeViewport(vp(736, 1))).toBeNull();
  });

  it.each([
    vp(0, 0),
    vp(-10, 400),
    vp(844, 0),
    vp(NaN, 390),
    vp(844, NaN),
    null,
    undefined,
  ])('非正/非有限/空读数 ⇒ null（%s）', (bad) => {
    expect(sanitizeViewport(bad as Viewport)).toBeNull();
  });

  it('单侧 inset 超过轴向 1/3（视口已转向、env 还投影旧方向）⇒ 该侧丢弃，其余保留', () => {
    // 844 宽下 600 是垃圾；同读数里的正常 inset（这里没有）保留。
    const out = sanitizeViewport(vp(844, 390, { right: 600 }));
    expect(out).not.toBeNull();
    expect(out!.insets.right).toBe(0);
  });

  it('真实刘海 47/390≈12% 不受 1/3 规则误伤，原样保留', () => {
    const out = sanitizeViewport(vp(844, 390, { left: 47, right: 47 }));
    expect(out!.insets).toEqual({ top: 0, right: 47, bottom: 0, left: 47 });
  });

  it.each([
    [568, 320, '最小真机横屏 iPhone SE 一代'],
    [736, 414, 'iPhone Plus 横屏'],
    [844, 390, '刘海 iPhone 横屏'],
    [390, 844, '手机竖屏'],
    [390, 360, '竖屏弹键盘（h 收缩到 360）'],
  ])('合法视口放行：%i×%i（%s）', (w, h) => {
    const out = sanitizeViewport(vp(w, h));
    expect(out).not.toBeNull();
    expect(out!.w).toBe(w);
    expect(out!.h).toBe(h);
  });

  it('阈值边界自证：可用高恰为 200 放行、199 拒绝（防阈值被随手改坏）', () => {
    expect(sanitizeViewport(vp(844, MIN_USABLE_HEIGHT))).not.toBeNull();
    expect(sanitizeViewport(vp(844, MIN_USABLE_HEIGHT - 1))).toBeNull();
    expect(sanitizeViewport(vp(MIN_USABLE_WIDTH, 400))).not.toBeNull();
    expect(sanitizeViewport(vp(MIN_USABLE_WIDTH - 1, 400))).toBeNull();
  });
});

describe('④-b keepLastGoodViewport：last-good 语义', () => {
  const good = vp(844, 390);

  it('新读数可用 ⇒ 替换；不可用 ⇒ 原封保留（画布不塌缩）', () => {
    const next = vp(736, 414);
    // 注：消毒会返回新对象，这里断言**值**被替换；引用保留只发生在「新旧相等」那一例。
    expect(keepLastGoodViewport(good, next)).toEqual(next);
    const garbage = vp(844, 80, { top: 47, bottom: 34 });
    expect(keepLastGoodViewport(good, garbage)).toBe(good);
    expect(keepLastGoodViewport(good, null)).toBe(good);
  });

  it('新读数与旧读数相等 ⇒ 返回旧引用（避免无效响应式触发）', () => {
    const same = vp(844, 390);
    expect(keepLastGoodViewport(good, same)).toBe(good);
  });

  it('冷启动首帧就是垃圾 ⇒ 保留零视口（组件走 FALLBACK，不白屏）', () => {
    const zero = vp(0, 0);
    expect(keepLastGoodViewport(zero, vp(736, 1))).toEqual(zero);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 六页接入与全局配置（源码级 / 片① Task 3；记录片 T8 加第 5 页；支付片 T14 加第 6 页）
// ---------------------------------------------------------------------------

describe('⑤ 八页接入与全局配置（源码级）', () => {
  const sources = collectSourceFiles();

  it('八页都用 <LandscapeStage> 包住根内容', () => {
    /**
     * ⚠️ **成对变更**（R757 的同一形态）：记录片 T8 新增第 5 页（历史战绩）、
     * 支付片 T14 新增第 6 页（钱包）、2026-10-23 钱包拆分新增第 7/8 页（充值/提现）。
     * 这条**不只是补判据** —— 新页不套画布会渲染到画布**外面**，它是功能要求。
     */
    for (const p of [
      'src/pages/login/login.vue',
      'src/pages/lobby/lobby.vue',
      'src/pages/game/game.vue',
      'src/pages/table/table.vue',
      'src/pages/history/history.vue',
      'src/pages/wallet/wallet.vue',
      'src/pages/wallet/recharge.vue',
      'src/pages/wallet/withdraw.vue',
    ]) {
      const f = sources.find((s) => s.path === p);
      expect(f, `${p} 必须在扫描集合里`).toBeDefined();
      const code = stripComments(f!.content);
      expect(code, `${p} 必须 import LandscapeStage`).toMatch(/LandscapeStage/);
      expect(code, `${p} 必须把内容放进 <LandscapeStage>`).toMatch(/<LandscapeStage/);
    }
  });

  it('pages.json：globalStyle.navigationStyle === "custom"，且八页标题仍在（R720；项 6 分包后分主包/分包两处声明）', () => {
    const pages = JSON.parse(sources.find((f) => f.path === 'src/pages.json')!.content) as {
      globalStyle?: { navigationStyle?: string };
      pages: { path: string; style?: { navigationBarTitleText?: string } }[];
      subPackages?: { root: string; pages: { path: string; style?: { navigationBarTitleText?: string } }[] }[];
    };
    expect(pages.globalStyle?.navigationStyle, 'R720：关掉原生导航栏').toBe('custom');
    // ⚠️ `page-stack.test.ts:190` 一带断言第一个页面的标题 —— 设 custom 后该字段被忽略但**不报错**，
    //    删了它那些判据就会红。别顺手删。
    // R720：标题文案八页都还在（主包 3 + 分包 5）。
    const mainTitles = pages.pages.map((p) => p.style?.navigationBarTitleText);
    const subTitles = (pages.subPackages ?? []).flatMap((sp) =>
      sp.pages.map((p) => p.style?.navigationBarTitleText),
    );
    expect([...mainTitles, ...subTitles], 'R720：八页标题仍在（主包 3 + 分包 5）').toEqual([
      '登录',
      '大厅',
      '玩法',
      '牌桌',
      '历史战绩',
      '钱包',
      '充值',
      '提现',
    ]);
    // 项 6：牌桌必须是独立分包（root 精确，防手滑写成别的）。
    expect(pages.subPackages?.map((sp) => sp.root)).toEqual([
      'pages/table',
      'pages/history',
      'pages/wallet',
    ]);
  });

  it('manifest.json：App 锁横屏（R709）', () => {
    // ⚠️ manifest.json 是 **JSONC**：uni-cli 用 jsonc-parser 解析（`json/json.js`），
    //    块注释是 HBuilderX 生成文件的既有惯例；广告片 T19 在 `sdkConfigs` 里落了
    //    【T0-4 到货后定形态】的注释标记 ⇒ 先剥注释（唯一实现 `stripComments`）再 JSON.parse。
    const m = JSON.parse(
      stripComments(sources.find((f) => f.path === 'src/manifest.json')!.content),
    ) as {
      'app-plus'?: { screenOrientation?: string[] };
    };
    expect(m['app-plus']?.screenOrientation, 'App 锁横屏').toEqual([
      'landscape-primary',
      'landscape-secondary',
    ]);
  });

  /**
   * R713 的**新形态**（片③ 阶段 B · Task B7）。
   *
   * ## 为什么改形态（⚠️ **实测订正**：旧形态不会红，它只是**瞎了**）
   *
   * 派工 brief 的原话是「映射表里必然同时出现两个文件名 ⇒ 旧形态**必红**」。**这句是错的**，
   * 落地时实测过（两处读数都留了，`logs/b7-old-form-replay.log`）：
   *  · 旧断言数的是「**哪些文件**含 `bg.png`」，不是「`bg.png` 出现几次」——
   *    两张图名都在**同一个文件**（映射表）里 ⇒ 旧形态对当前工作树**仍然绿**
   *    （实测 `hits = ["src/components/LandscapeStage.vue"]`，与期望逐字相同）；
   *  · 但它**守不住第二张图**：`/bg\.png/` 只认这一个文件名，而
   *    `/static/ui/Common_BG4_2x.png` **不含** `bg.png` ⇒ 某个页面拿**第二张图**铺一层底纹时，
   *    旧形态**一个字都不会说**（实测：同一份 `.x { background-image: … }` 样本，
   *    写 `bg.png` 命中、写 `Common_BG4_2x.png` 不命中）。
   *
   * ⇒ 所以改形态的理由不是「它坏了」，而是**它会在性质已经漂移时继续绿着** ——
   * 本仓明文记着这个失败模式：「判据存在 ≠ 判据有效」（片② 的收口教训）。
   *
   * ## 新形态守的是**同一个性质**：舞台只有一层底纹
   *
   * 两层底纹会因**缩放比不同而错位**（片① §2.2 的原话）—— 这条性质一个字没变，变的是「哪张图」
   * 与「谁在铺」。新形态拆成两条**独立**断言：
   *  · ① **铺底纹的写法只允许出现在 `LandscapeStage.vue`** —— 页面自己铺一层 = 错位的根源
   *    （`.stage` 是 `cover` 铺满全视口的那层，页面里再铺一层就是**第二个缩放比**）；
   *    它比旧形态**严**：旧形态只盯 `bg.png` 一个名字，新形态盯的是「**写法**」——
   *    映射表里今后加到第八张图，这条判据的射程**自动跟上**。
   *  · ② **映射表里的每张图都在盘上** —— 防「改了名字但没拷图」这类**静默**失效
   *    （图不在盘上时页面只是**没有底纹**，不报错、单测与探针都看不见）。
   *
   * ⚠️ 旧正则 `/bg\.png/` 太宽（片① 的 Minor 已预警）：它会命中 `table-bg.png` 之类
   * ⇒ 新形态锚 `/\/static\/ui\//` 这一整段路径，而不是某个具体文件名。
   *
   * ⚠️ **扫描面是 `src/**` 里 source-scan 认得的那几种**（`.ts/.vue/.js/.json/.scss`），
   * **不含 `.md` / `.png`** ⇒ `ASSETS.md` 里描述素材**不算**命中。
   *
   * 🔴 **形态变迁（2026-10-13，发布包素材修复）**：底纹从「`.stage` 内联 `background-image`」
   * 改成「`<image class="stage__backdrop">` 垫底层」——发布包实证 App 发布态 `file://` 下
   * 内联样式里的**绝对** url('/static/…'、'/pages/…') 解析到文件系统根 ⇒ 底纹 404（登录/玩法/
   * 牌桌全白底）；`<image>` 组件按绝对本地路径加载是发布包实测可用形态（卡面/头像同族）。
   * ⇒ 本闸的期望值从 `[STAGE]` 翻转为 **`[]`（全仓零 CSS 铺底纹写法）**，
   * 三条写法正则**原样保留**（它们是「有人把 CSS 铺法加回任何页面」的绊线），
   * 并新增**新形态正对照**：舞台必须真的以 `stage__backdrop` 的 `<image>` + 映射表值铺底纹
   * —— 否则「零命中」可能只是舞台把底纹整个丢了（形态变迁时那条「零命中=判据写坏」的
   * 老判别不退场，只是换了个锚点）。
   */
  it('R713：全仓零 CSS 铺底纹写法（唯一落点 = 舞台的底纹层）；映射表图都在盘上', () => {
    const hits = backdropWriters();
    expect(
      hits,
      `铺底纹的 CSS 写法出现在：${hits.join(', ') || '(无)'} —— 舞台**只有一层**底纹（现在是 ` +
        '`stage__backdrop` 的 <image> 垫底层），页面自己写 CSS 底纹 = 第二个缩放比 = 错位；' +
        '且发布包 file:// 下内联绝对 url() 本就不加载（2026-10-13 实测）',
    ).toEqual([]);

    const stage = collectSourceFiles().find((f) => f.path === STAGE);
    expect(stage, `${STAGE} 必须在扫描集合里`).toBeDefined();
    const stageCode = stripComments(stage!.content);

    // ① 新形态正对照：底纹层必须真的存在、且绑到映射表值（防「零命中」的空转形态）。
    expect(stageCode, '舞台必须以 .stage__backdrop 的 <image> 铺底纹').toMatch(
      /<image[^>]*class="stage__backdrop"[^>]*:src="backdropImage"/,
    );

    // ② 映射表里的每张图都必须在盘上（防「改了名字但没拷图」的静默失效）。
    // 项 6 分包后有两个根：主包 `static/ui/`、牌桌分包 `pages/table/static/ui/`。
    // 主包底纹：assetUrl("/static/ui/<name>")（或等价字面量）。
    const mainRefs = [...stageCode.matchAll(/\/static\/ui\/([A-Za-z0-9_.-]+)/g)].map(
      (m) => m[1]!,
    );
    // 分包底纹：tableAsset("ui/<name>")（完整前缀在 asset.ts 里拼，这里认调用形态）。
    const tableRefs = [
      ...stageCode.matchAll(/tableAsset\(\s*['"]ui\/([A-Za-z0-9_.-]+)['"]/g),
    ].map((m) => m[1]!);
    expect(mainRefs.length + tableRefs.length, '映射表至少要有一项（空了这条判据就变成恒真）').toBeGreaterThan(0);
    for (const name of mainRefs) {
      expect(existsSync(join(SRC_ROOT, 'static', 'ui', name)), `${name} 不在主包盘上`).toBe(true);
    }
    for (const name of tableRefs) {
      expect(
        existsSync(join(SRC_ROOT, 'pages', 'table', 'static', 'ui', name)),
        `${name} 不在牌桌分包盘上`,
      ).toBe(true);
    }
  });

  /**
   * 🔴 **舞台对齐禁止 `safe center`（2026-10-15 安卓 Chrome / DevTools 实测事故）**。
   *
   * `.canvas` 的 flex 布局盒是 transform **之前**的设计尺寸（典型 1626×750），
   * 舞台内容盒是安全区（典型 852×393）—— 布局盒在构造上**必然溢出**，
   * 靠 `transform: scale(k)` 后的视觉盒铺满。`safe center`（Chromium 115+）按布局盒
   * 检测溢出 ⇒ 退化为 start ⇒ 布局盒锚 (0,0)，围绕中心 scale 后视觉画布偏到右下角、
   * 左上只剩底纹（实测视觉原点 (387,179)）。Safari/Firefox 不识别 safe 会丢弃该声明，
   * 所以 iPhone 上永远复现不了 —— 这是一条**内核分叉**的静默事故，必须机械钉死。
   *
   * 扫描走 `stripComments` 之后的源码：注释里允许讨论 `safe`（本判据自证不误报），
   * 只有**真实样式声明**里出现才红。
   */
  it('R-new：.stage 只能用 center 对齐（safe center 会把 scale 画布锚到右下角）', () => {
    const stageSrc = stripComments(sources.find((f) => f.path === STAGE)!.content);
    expect(
      stageSrc.match(/align-items\s*:\s*safe\s+center|justify-content\s*:\s*safe\s+center/g),
      '舞台禁止 safe center：布局盒（设计尺寸）构造上必然溢出，Chromium 会退化为 start ' +
        '导致 scale 后视觉画布偏右下（2026-10-15 事故，详见 LandscapeStage.vue 注释）',
    ).toBeNull();
    // 正对照：普通 center 必须在 —— 负偏移居中是 scale 后视觉盒严丝合缝铺满的前提。
    expect(stageSrc, 'align-items: center 是画布视觉居中的前提').toMatch(/align-items\s*:\s*center/);
    expect(stageSrc, 'justify-content: center 是画布视觉居中的前提').toMatch(
      /justify-content\s*:\s*center/,
    );
  });

  /**
   * R713 的**非 CSS 通道**补强（B89 · 评审者点名的盲区 (a)）。
   *
   * 上面 `backdropWriters()` 认的是「**铺底纹**」的 CSS/JS 写法 ⇒ 它对
   * `<image src="/static/ui/bg.png">` 这种**非 CSS 通道一点都看不见**。
   * 但「图名只在映射表里」这条性质**对所有通道都成立** ⇒ 换个角度扫**名字本身**：
   * 映射表里每个 `/static/ui/<name>` **字面量路径**，只允许出现在 `LandscapeStage.vue`。
   *
   *  · 它**独立于写法形态**：今后新增通道（`poster` / 新的内联键……）它自动跟上；
   *  · `:src="'/static/ui/' + name"` 这类**拼接**不命中 —— 制的是字面量路径
   *    （`lobby.vue` 的玩法图标正是拼接形态；今天零处字面量 ⇒ 零误报）。
   */
  it('R713 补强：映射表里的图名（含 `/static/ui/` 前缀）只允许出现在 LandscapeStage.vue', () => {
    const stageSrc = stripComments(sources.find((f) => f.path === STAGE)!.content);
    const names = [...stageSrc.matchAll(/\/static\/ui\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!);
    expect(names.length, '映射表至少要有一项（空了这条判据就变成恒真）').toBeGreaterThan(0);
    for (const name of names) {
      const needle = `/static/ui/${name}`;
      const owners = sources
        .filter((f) => stripComments(f.content).includes(needle))
        .map((f) => f.path);
      expect(owners, `${needle} 只允许出现在 ${STAGE}`).toEqual([STAGE]);
    }
  });

  /**
   * ⚠️ **判据射程自证**（R435 同族：判据要能说出自己**拦得住什么**）。
   *
   * 上一条断言的两个方向都**有判别力**，这里把「会红」这件事**钉死**：
   *  · **多命中**：任何页面（或舞台自己）重新写 CSS 铺底纹 ⇒ 红（下面用 8 个合成样本**逐族**各证）；
   *  · **形态失效**：新形态正对照（`stage__backdrop` 的 `<image>`）—— 舞台把底纹整个丢掉 ⇒ 红。
   *
   * 合成样本刻意用**与真源同形**的写法：`<image src>` 形态必须**不**命中本组正则，
   * 否则这条判据会把合法写法打红（那才是真正要命的**误报**）——2026-10-13 起
   * `<image src>` 恰是**舞台自己的合法形态**，这一条的分量比以往更重。
   */
  it('R713 射程自证：3 族 8 个铺底纹写法样本都命中，`<image src>` 这类**不**命中', () => {
    const cssLiteral = '.x {\n  background-image: url(\'/static/ui/bg.png\');\n}';
    const cssShorthand = '.x {\n  background: rgba(0, 0, 0, 0.5) url(/static/ui/x.png);\n}';
    const cssUnquoted = '.x { background-image: url(/static/ui/grad.jpg); }';
    const inlineTpl = '<view :style="{ backgroundImage: `url(\'/static/ui/bg.png\')` }" />';
    const inlineStr = "{ backgroundImage: 'url(/static/ui/x.png)' }";
    const inlineDoubleStr = '{ backgroundImage: "url(\'/static/ui/bg.png\')" }';
    const inlineKebab = "{ 'background-image': 'url(/static/ui/x.png)' }";
    const inlineKebabDouble = '{ "background-image": url(/static/ui/x.png) }';
    const imageTag = '<image class="chip__avatar" src="/static/ui/default.png" mode="aspectFit" />';
    const tokenOnly = '.x { background-image: $ftl-art-coin; }';

    for (const [label, sample] of [
      ['CSS 字面路径', cssLiteral],
      ['CSS background 简写', cssShorthand],
      ['CSS 无引号 url', cssUnquoted],
      ['内联模板字符串', inlineTpl],
      ['内联普通字符串', inlineStr],
      ['内联双引号字符串', inlineDoubleStr],
      ['内联 kebab 键（单引号）', inlineKebab],
      ['内联 kebab 键（双引号）', inlineKebabDouble],
    ] as const) {
      expect(BACKDROP_WRITINGS.some((re) => re.test(sample)), `${label}必须命中`).toBe(true);
    }
    for (const [label, sample] of [
      ['<image src>', imageTag],
      ['槽位令牌', tokenOnly],
    ] as const) {
      expect(BACKDROP_WRITINGS.some((re) => re.test(sample)), `${label}**不得**命中（误报）`).toBe(
        false,
      );
    }
  });

});
